import { basename, resolve } from "node:path";
import { inspectTargetAuthoringContext, type TargetAuthoringResource } from "../application/target-authoring-context.js";
import { listCorpora, sealedDatasetHashesFor } from "../corpus.js";
import {
	isSealedEvalRun,
	listEvalRunIndexesLenient,
	loadEvalRun,
	type EvalRunRecord,
} from "../eval.js";
import { loadTarget } from "../manifest.js";
import { listSpecSnapshots } from "../spec.js";
import { targetBootstrapRequired } from "../target/readiness.js";
import { standInFilesLine } from "../target/placeholders.js";
import { errorMessage } from "../util.js";

const MAX_STATUS_ITEMS = 30;

export interface BuilderProjectContext {
	projectDir: string;
	stateRoot: string;
	runsRoot: string;
	projectId?: string;
}

export function resolveBuilderProjectId(context: BuilderProjectContext): string {
	if (context.projectId) return context.projectId;
	try {
		return loadTarget(context.projectDir).manifest.id;
	} catch {
		return basename(resolve(context.projectDir)).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128) || "target";
	}
}

export interface EvalSummary {
	evalRunId: string;
	target: EvalRunRecord["target"];
	label: EvalRunRecord["label"];
	dataset: string;
	repetitions: number;
	startedAt: string;
	finishedAt: string;
	summary: EvalRunRecord["summary"];
}

export function summarizeEvalRun(record: EvalRunRecord): EvalSummary {
	return {
		evalRunId: record.evalRunId,
		target: record.target,
		label: record.label,
		dataset: record.dataset,
		repetitions: record.repetitions,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		summary: record.summary,
	};
}

/** A bounded, metadata-only view. Sealed corpus task content is never returned. */
export function buildProjectStatus(context: BuilderProjectContext): Record<string, unknown> {
	const projectId = resolveBuilderProjectId(context);
	const warnings: string[] = [];
	let target: Record<string, unknown>;
	let targetId: string | null = null;
	let publicTargetFiles: TargetAuthoringResource[] = [];
	try {
		const resolved = loadTarget(context.projectDir);
		targetId = resolved.manifest.id;
		const bootstrapRequired = targetBootstrapRequired(resolved.manifest);
		target = {
			status: bootstrapRequired ? "bootstrap-required" : "ready",
			id: resolved.manifest.id,
			gitSha: resolved.gitSha,
			model: { provider: resolved.manifest.model.provider, id: resolved.manifest.model.id },
			skills: resolved.manifest.skills,
			execution: resolved.manifest.execution,
			developmentTaskCount: resolved.tasks.length,
			...(bootstrapRequired ? { nextAction: "ahde_target_configure_model" } : {}),
		};
		try {
			publicTargetFiles = inspectTargetAuthoringContext({
				repositoryDir: context.projectDir,
				expectedTarget: { id: resolved.manifest.id, gitSha: resolved.gitSha },
			}).resources;
		} catch (error) {
			warnings.push(`target authoring context: ${errorMessage(error, 500)}`);
		}
		// The same one line the view and /doctor carry: what the Builder is
		// looking at is a template's placeholder prose, not a described agent.
		const standIns = standInFilesLine(resolved.dir);
		if (standIns) warnings.push(standIns);
	} catch (error) {
		target = { status: "not-ready", error: errorMessage(error, 500) };
	}

	let specs: ReturnType<typeof listSpecSnapshots> = [];
	try {
		specs = listSpecSnapshots(context.stateRoot, projectId).slice(0, MAX_STATUS_ITEMS);
	} catch (error) {
		warnings.push(`specs: ${errorMessage(error, 500)}`);
	}
	let corpora: ReturnType<typeof listCorpora> = [];
	try {
		corpora = listCorpora({ stateRoot: context.stateRoot, projectId });
	} catch {
		warnings.push("corpora: metadata unavailable; sealed identities remain hidden");
	}
	let evals: EvalSummary[] = [];
	try {
		const sealedHashes = sealedDatasetHashesFor({ stateRoot: context.stateRoot, projectId });
		const listed = listEvalRunIndexesLenient(context.runsRoot);
		if (listed.invalid.length > 0) {
			warnings.push(`evals: ${listed.invalid.length} legacy eval run index(es) ignored; not comparable with the current evidence schema`);
		}
		evals = listed.records
			.filter((record) => targetId === null || record.target.id === targetId)
			.filter((record) => !isSealedEvalRun(record, sealedHashes))
			.map((record) => loadEvalRun(context.runsRoot, record.evalRunId))
			.slice(0, MAX_STATUS_ITEMS)
			.map(summarizeEvalRun);
	} catch {
		warnings.push("evals: evidence metadata unavailable; sealed identities remain hidden");
	}

	return {
		project: { id: projectId, directory: basename(resolve(context.projectDir)) },
		target,
		publicTargetFiles,
		specs: specs.map(({ id, status, createdAt, sourceHash }) => ({ id, status, createdAt, sourceHash })),
		corpora: {
			development: corpora
				.filter((corpus) => corpus.visibility === "development")
				.slice(0, MAX_STATUS_ITEMS)
				.map(({ id, name, visibility, taskCount, hash, createdAt }) => ({
					id,
					name,
					visibility,
					taskCount,
					hash,
					createdAt,
				})),
			sealed: { visibility: "sealed", count: corpora.filter((corpus) => corpus.visibility === "sealed").length },
		},
		evalRuns: evals,
		warnings,
	};
}
