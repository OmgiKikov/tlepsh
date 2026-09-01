import { basename, dirname } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import { loadVerifiedEvalRun } from "./eval.js";
import { HashSchema, hashValue } from "./provenance.js";
import { openTrace, traceToolCalls } from "./trace.js";
import { readJsonArtifact, writeJsonArtifact } from "./storage/artifacts.js";
import { resolveContainedArtifactPath } from "./storage/paths.js";

export const DiagnosisCategorySchema = z.enum([
	"infrastructure",
	"flaky-behavior",
	"tool-selection",
	"output-contract",
	"answer-quality",
]);
export type DiagnosisCategory = z.infer<typeof DiagnosisCategorySchema>;

const EvidenceRefSchema = z.strictObject({
	runId: z.string().min(1),
	tracePath: z.string().min(1).nullable(),
	graderNames: z.array(z.string()),
	toolNames: z.array(z.string()),
});

export const DiagnosisIssueSchema = z.strictObject({
	issueId: z.string().min(1),
	taskId: z.string().min(1),
	category: DiagnosisCategorySchema,
	severity: z.enum(["blocking", "major", "minor"]),
	confidence: z.enum(["high", "medium", "low"]),
	summary: z.string().min(1),
	rootCause: z.string().min(1),
	suggestions: z.array(z.string().min(1)).min(1),
	occurrences: z.strictObject({ pass: z.number().int().nonnegative(), fail: z.number().int().nonnegative(), error: z.number().int().nonnegative(), total: z.number().int().positive() }),
	evidence: z.array(EvidenceRefSchema).min(1),
});
export type DiagnosisIssue = z.infer<typeof DiagnosisIssueSchema>;

export const DiagnosisRecordSchema = z.strictObject({
	schemaVersion: z.literal(1),
	diagnosisId: z.string().min(1),
	evalRunId: z.string().min(1),
	targetId: z.string().min(1),
	targetRevision: z.string().min(1),
	status: z.enum(["healthy", "actionable", "inconclusive"]),
	createdAt: z.string().min(1),
	inputHash: HashSchema,
	summary: z.strictObject({
		tasks: z.number().int().nonnegative(),
		healthyTasks: z.number().int().nonnegative(),
		failedTasks: z.number().int().nonnegative(),
		infrastructureErrors: z.number().int().nonnegative(),
		issueCount: z.number().int().nonnegative(),
	}),
	issues: z.array(DiagnosisIssueSchema),
});
export type DiagnosisRecord = z.infer<typeof DiagnosisRecordSchema>;

interface TaskAggregate {
	taskId: string;
	pass: number;
	fail: number;
	error: number;
	evidence: z.infer<typeof EvidenceRefSchema>[];
	failedGraderTypes: Set<string>;
	failedReasons: string[];
}

function categoryFor(aggregate: TaskAggregate): DiagnosisCategory[] {
	const categories: DiagnosisCategory[] = [];
	if (aggregate.error > 0) categories.push("infrastructure");
	if (aggregate.pass > 0 && aggregate.fail + aggregate.error > 0) categories.push("flaky-behavior");
	if (aggregate.failedGraderTypes.has("tool_called")) categories.push("tool-selection");
	if (
		aggregate.failedGraderTypes.has("output_contains") ||
		aggregate.failedGraderTypes.has("output_matches") ||
		aggregate.failedGraderTypes.has("exact") ||
		aggregate.failedGraderTypes.has("no_secret")
	) categories.push("output-contract");
	if (
		aggregate.failedGraderTypes.has("judge") ||
		aggregate.failedGraderTypes.has("similarity")
	) categories.push("answer-quality");
	return categories;
}

function guidance(category: DiagnosisCategory): { rootCause: string; suggestions: string[] } {
	switch (category) {
		case "infrastructure":
			return {
				rootCause: "The run or grader failed before producing valid comparable evidence.",
				suggestions: [
					"Fix the recorded runtime, sandbox, trace, timeout, or grader error before changing the harness.",
					"Re-run the same revision to confirm the evidence path is healthy.",
				],
			};
		case "flaky-behavior":
			return {
				rootCause: "The same task changes outcome across matched repetitions.",
				suggestions: [
					"Replace soft prose with an explicit decision procedure or output checklist.",
					"Run A/A calibration and increase repetitions before claiming an improvement.",
				],
			};
		case "tool-selection":
			return {
				rootCause: "The agent did not select the required tool under the task wording.",
				suggestions: [
					"Broaden the relevant skill description with observable activation conditions.",
					"Add a short tool-selection rule to AGENTS.md; keep command details inside the skill.",
				],
			};
		case "output-contract":
			return {
				rootCause: "The final answer omitted or misformatted a deterministic required element.",
				suggestions: [
					"Define the final answer fields and ordering explicitly in the harness.",
					"Add a pre-answer checklist without embedding the benchmark wording verbatim.",
				],
			};
		case "answer-quality":
			return {
				rootCause: "The answer completed technically but did not satisfy the semantic rubric.",
				suggestions: [
					"Add domain reasoning steps or a focused reference skill for the missing concept.",
					"Inspect the judge reason and verify that the rubric itself is unambiguous.",
				],
			};
	}
}

function issueFrom(aggregate: TaskAggregate, category: DiagnosisCategory): DiagnosisIssue {
	const total = aggregate.pass + aggregate.fail + aggregate.error;
	const guidanceValue = guidance(category);
	const consistentFailure = aggregate.pass === 0;
	return {
		issueId: `${aggregate.taskId}:${category}`,
		taskId: aggregate.taskId,
		category,
		severity: category === "infrastructure" ? "blocking" : consistentFailure ? "major" : "minor",
		confidence: consistentFailure && total > 1 ? "high" : total > 1 ? "medium" : "low",
		summary:
			`${aggregate.taskId}: ${aggregate.pass}/${total} passed; ` +
			`${aggregate.fail} failed and ${aggregate.error} ended with infrastructure errors.`,
		rootCause:
			guidanceValue.rootCause +
			(aggregate.failedReasons.length > 0 ? ` Evidence: ${aggregate.failedReasons.slice(0, 2).join("; ")}` : ""),
		suggestions: guidanceValue.suggestions,
		occurrences: {
			pass: aggregate.pass,
			fail: aggregate.fail,
			error: aggregate.error,
			total,
		},
		evidence: aggregate.evidence,
	};
}

export function diagnosisPath(runsRoot: string, evalRunId: string): string {
	return resolveContainedArtifactPath(runsRoot, evalRunId, "diagnosis.json");
}

/** Build and persist a deterministic diagnosis from immutable run evidence. */
export function diagnoseEvalRun(runsRoot: string, evalRunId: string, now = () => new Date().toISOString()): DiagnosisRecord {
	resolveContainedArtifactPath(runsRoot, evalRunId, "eval_run.json");
	const verified = loadVerifiedEvalRun(runsRoot, evalRunId);
	const evalRun = verified.record;
	const aggregates = new Map<string, TaskAggregate>();
	const sourceRuns = verified.runs;
	for (const run of sourceRuns) {
		const aggregate = aggregates.get(run.taskId) ?? {
			taskId: run.taskId,
			pass: 0,
			fail: 0,
			error: 0,
			evidence: [],
			failedGraderTypes: new Set<string>(),
			failedReasons: [],
		};
		let toolNames: string[] = [];
		if (run.trace.sha256) {
			const traceArtifact = resolveContainedArtifactPath(runsRoot, run.runId, run.trace.path);
			const trace = openTrace(dirname(traceArtifact), basename(traceArtifact), run.trace.sha256);
			toolNames = [...new Set(traceToolCalls(trace).map((call) => call.name))].sort();
		}
		const failedGraders = run.evalResults?.graders.filter((grader) => !grader.passed) ?? [];
		if (run.status === "error") aggregate.error += 1;
		else if (run.evalResults?.outcome === "pass") aggregate.pass += 1;
		else aggregate.fail += 1;
		for (const grader of failedGraders) {
			aggregate.failedGraderTypes.add(grader.type);
			aggregate.failedReasons.push(grader.reason);
		}
		aggregate.evidence.push({
			runId: run.runId,
			tracePath: run.trace.sha256 ? run.trace.path : null,
			graderNames: failedGraders.map((grader) => grader.name),
			toolNames,
		});
		aggregates.set(run.taskId, aggregate);
	}

	const issues = [...aggregates.values()]
		.flatMap((aggregate) => categoryFor(aggregate).map((category) => issueFrom(aggregate, category)))
		.sort((a, b) => a.issueId.localeCompare(b.issueId));
	const infrastructureErrors = evalRun.summary.error;
	const healthyTasks = [...aggregates.values()].filter((aggregate) => aggregate.fail === 0 && aggregate.error === 0).length;
	const inputHash = hashValue({ evalRun, runs: sourceRuns });
	const outputPath = diagnosisPath(runsRoot, evalRunId);
	if (existsSync(outputPath)) {
		const existing = readJsonArtifact(outputPath, DiagnosisRecordSchema);
		if (existing.inputHash !== inputHash) {
			throw new Error(
				`diagnosis evidence changed for ${evalRunId}: stored ${existing.inputHash}, current ${inputHash}`,
			);
		}
		return existing;
	}
	const record: DiagnosisRecord = {
		schemaVersion: 1,
		diagnosisId: `diagnosis-${inputHash.slice("sha256:".length, "sha256:".length + 20)}`,
		evalRunId,
		targetId: evalRun.target.id,
		targetRevision: evalRun.target.gitSha,
		status: infrastructureErrors > 0 ? "inconclusive" : issues.length > 0 ? "actionable" : "healthy",
		createdAt: now(),
		inputHash,
		summary: {
			tasks: aggregates.size,
			healthyTasks,
			failedTasks: aggregates.size - healthyTasks,
			infrastructureErrors,
			issueCount: issues.length,
		},
		issues,
	};
	writeJsonArtifact(outputPath, DiagnosisRecordSchema, record, { immutable: true });
	return record;
}

export function loadDiagnosis(runsRoot: string, evalRunId: string): DiagnosisRecord {
	return readJsonArtifact(diagnosisPath(runsRoot, evalRunId), DiagnosisRecordSchema);
}
