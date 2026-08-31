import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
	builderCorpusDraftTaskId,
	BuilderCorpusDraftRevisionOperationSchema,
	BuilderCorpusDraftTaskInputSchema,
	type BuilderCorpusDraftRevisionOperation,
	type BuilderCorpusDraftVerifiedProvenanceBinding,
} from "./builder-corpus-draft.js";
import { targetWithDevelopmentCorpus } from "./corpus-target.js";
import { screenExclusion, type ScreenExclusion } from "./cheap-check.js";
import type { LoadedCorpus } from "../corpus.js";
import { loadVerifiedEvalRun, type EvalRunRecord } from "../eval.js";
import type { ResolvedTarget } from "../manifest.js";
import { canonicalJson, hashValue } from "../provenance.js";
import { computeTargetWorkspaceHash } from "../runner.js";
import type { ApprovedSpecReference } from "../spec.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";
import { openTrace } from "../trace.js";

const MAX_REVISION_OPERATIONS = 200;
const MAX_REVISION_OPERATIONS_BYTES = 2 * 1024 * 1024;
const MAX_DEVELOPMENT_FAILURE_TRACE_BYTES = 8 * 1024 * 1024;
const ArtifactIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);

export const BuilderRegressionCaseOperationSchema = z.strictObject({
	type: z.literal("add-case-from-run"),
	evalRunId: ArtifactIdSchema,
	runId: ArtifactIdSchema,
	task: BuilderCorpusDraftTaskInputSchema,
});
export type BuilderRegressionCaseOperation = z.infer<typeof BuilderRegressionCaseOperationSchema>;

export const BuilderWorkbenchCorpusRevisionOperationSchema = z.union([
	BuilderCorpusDraftRevisionOperationSchema,
	BuilderRegressionCaseOperationSchema,
]);
export type BuilderWorkbenchCorpusRevisionOperation = z.infer<typeof BuilderWorkbenchCorpusRevisionOperationSchema>;

export const BuilderWorkbenchCorpusRevisionOperationsSchema = z
	.array(BuilderWorkbenchCorpusRevisionOperationSchema)
	.min(1)
	.max(MAX_REVISION_OPERATIONS)
	.superRefine((operations, context) => {
		if (Buffer.byteLength(canonicalJson(operations), "utf8") > MAX_REVISION_OPERATIONS_BYTES) {
			context.addIssue({
				code: "custom",
				message: `revision operations exceed ${MAX_REVISION_OPERATIONS_BYTES} bytes`,
			});
		}
	});

export interface ResolveDevelopmentFailureOperationsOptions {
	runsRoot: string;
	approvedSpec: ApprovedSpecReference;
	target: ResolvedTarget;
	developmentCorpus: LoadedCorpus;
	compatibleEvalRuns: readonly EvalRunRecord[];
	operations: readonly unknown[];
}

export interface ResolvedDevelopmentFailureOperations {
	operations: BuilderCorpusDraftRevisionOperation[];
	verifiedTaskProvenance: BuilderCorpusDraftVerifiedProvenanceBinding[];
}

function evidenceError(message: string): never {
	throw new Error(`add-case-from-run rejected: ${message}`);
}

function exactSourceSurface(
	options: ResolveDevelopmentFailureOperationsOptions,
	record: EvalRunRecord,
	workspaceHash: string,
): boolean {
	if (
		options.developmentCorpus.metadata.projectId !== options.approvedSpec.projectId ||
		options.developmentCorpus.metadata.visibility !== "development"
	) return false;
	const expected = targetWithDevelopmentCorpus(options.target, options.developmentCorpus);
	return (
		(record.label === "solo" || record.label === "baseline") &&
		record.baselineEvalRunId === null &&
		record.target.id === expected.manifest.id &&
		record.target.gitSha === expected.gitSha &&
		record.target.toolsetHash === expected.toolsetHash &&
		record.target.workspaceHash === workspaceHash &&
		record.dataset === expected.manifest.evalSuite.dataset.replace(/\.jsonl$/, "").split("/").pop() &&
		record.datasetHash === expected.datasetHash &&
		record.suiteHash === expected.suiteHash &&
		record.summary.error === 0
	);
}

/**
 * Resolve model-authored regression tasks against host-selected development
 * authority. Only hashes and artifact ids survive; trace answers never leave
 * this boundary.
 */
export function resolveDevelopmentFailureOperations(
	options: ResolveDevelopmentFailureOperationsOptions,
): ResolvedDevelopmentFailureOperations {
	const requested = BuilderWorkbenchCorpusRevisionOperationsSchema.parse(options.operations);
	const operations: BuilderCorpusDraftRevisionOperation[] = [];
	const verifiedTaskProvenance: BuilderCorpusDraftVerifiedProvenanceBinding[] = [];
	let currentWorkspaceHash: string | undefined;
	// A cheap-check screen is a one-repetition, candidate-revision run of the
	// cases that already failed. It is a screen, not evidence, so it can never
	// be the hash-indexed development failure a regression case cites.
	let screens: ScreenExclusion | undefined;

	for (const operation of requested) {
		if (operation.type !== "add-case-from-run") {
			operations.push(operation);
			continue;
		}

		currentWorkspaceHash ??= computeTargetWorkspaceHash(options.target, options.runsRoot);
		screens ??= screenExclusion(options.runsRoot);
		if (screens.blocksEverything || screens.ids.has(operation.evalRunId)) {
			evidenceError("source is a cheap-check screen, which is never evidence");
		}
		const allowedRecord = options.compatibleEvalRuns.find((record) => record.evalRunId === operation.evalRunId);
		// The record says what it is: a screen written by a process that died
		// before its marker is still a screen, and still refused here.
		if (allowedRecord?.purpose === "screen") {
			evidenceError("source is a cheap-check screen, which is never evidence");
		}
		if (!allowedRecord || !exactSourceSurface(options, allowedRecord, currentWorkspaceHash)) {
			evidenceError("source is not compatible verified development evidence for this Workbench lineage");
		}
		const verified = loadVerifiedEvalRun(resolve(options.runsRoot), operation.evalRunId);
		if (!verified.hasRunHashes || hashValue(verified.record) !== hashValue(allowedRecord)) {
			evidenceError("source EvalRun is not backed by exact final RunRecord hashes");
		}
		const run = verified.runs.find((candidate) => candidate.runId === operation.runId);
		if (!run) evidenceError("source Run is not an exact member of the verified EvalRun");
		if (run.status !== "completed" || run.evalResults?.outcome !== "fail") {
			evidenceError("source Run must be a completed behavioral failure");
		}
		if (!run.trace.sha256) evidenceError("source failure has no hash-verified trace");

		const sourceTask = options.developmentCorpus.tasks.find((task) => task.id === run.taskId);
		if (!sourceTask) evidenceError("source Run task is absent from the canonical development corpus");
		const runDirectory = resolveContainedArtifactPath(options.runsRoot, run.runId);
		const traceFile = resolveContainedArtifactPath(runDirectory, run.trace.path);
		const traceEntry = lstatSync(traceFile);
		if (!traceEntry.isFile() || traceEntry.isSymbolicLink() || traceEntry.size > MAX_DEVELOPMENT_FAILURE_TRACE_BYTES) {
			evidenceError(`source trace must be a regular file no larger than ${MAX_DEVELOPMENT_FAILURE_TRACE_BYTES} bytes`);
		}
		const trace = openTrace(
			runDirectory,
			run.trace.path,
			run.trace.sha256,
		);
		const sourceUserInput = trace.find((message) => message.role === "user")?.text;
		if (sourceUserInput === undefined || sourceUserInput !== sourceTask.input) {
			evidenceError("source trace input does not match its canonical development case");
		}

		const task = BuilderCorpusDraftTaskInputSchema.parse(operation.task);
		const duplicate = options.developmentCorpus.tasks.find(({ id: _id, ...existing }) =>
			canonicalJson(task) === canonicalJson(existing));
		if (duplicate) {
			evidenceError(`regression task must be a derived case, not an exact duplicate of development task ${duplicate.id}`);
		}
		const taskId = builderCorpusDraftTaskId(options.approvedSpec, task);
		const operationIndex = operations.length;
		operations.push({ type: "add", task });
		verifiedTaskProvenance.push({
			operationIndex,
			provenance: {
				kind: "development-failure",
				taskId,
				source: {
					corpusId: options.developmentCorpus.metadata.id,
					corpusHash: options.developmentCorpus.metadata.hash,
					evalRunId: verified.record.evalRunId,
					evalRunHash: hashValue(verified.record),
					runId: run.runId,
					runHash: hashValue(run),
					tracePath: run.trace.path,
					traceSha256: run.trace.sha256,
					sourceTaskId: sourceTask.id,
					sourceTaskHash: hashValue(sourceTask),
				},
			},
		});
	}

	return { operations, verifiedTaskProvenance };
}
