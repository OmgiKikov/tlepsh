import { basename, dirname } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import { loadVerifiedEvalRun } from "./eval.js";
import { HashSchema, hashValue } from "./provenance.js";
import { lastAssistantText, openTrace, redactTraceText, traceToolCalls, type TraceMessage } from "./trace.js";
import { readJsonArtifact, writeJsonArtifact } from "./storage/artifacts.js";
import { resolveContainedArtifactPath } from "./storage/paths.js";
import { categoryForGrader } from "./application/diagnosis-category.js";

/** Written on every new diagnosis; version 1 predates the trace excerpts. */
export const DIAGNOSIS_SCHEMA_VERSION = 2;

const MAX_REPLY_CHARS = 240;
const MAX_TOOL_NAMES = 8;
const MAX_TOOL_NAME_CHARS = 100;
const MAX_RUN_EXCERPTS = 2_000;

/**
 * What a trace shows without anyone interpreting it.
 *
 * These are the observations a machine can make about one Target turn and
 * defend afterwards: it called nothing, it typed a tool call instead of making
 * one, it handed the question back, it answered in a mix of scripts, it said
 * nothing at all. None of them is a cause; together they are the difference
 * between "a grader predicate was unsatisfied" and knowing what happened.
 */
export const TraceObservationSchema = z.enum([
	"no-tool-call",
	"tool-call-as-text",
	"asks-a-question",
	"mixed-script",
	"empty-reply",
]);
export type TraceObservation = z.infer<typeof TraceObservationSchema>;

export const RunExcerptSchema = z.strictObject({
	toolNames: z.array(z.string().min(1).max(MAX_TOOL_NAME_CHARS)).max(MAX_TOOL_NAMES),
	/** The last thing the Target said, redacted and bounded. Null when it said nothing. */
	reply: z.string().min(1).max(MAX_REPLY_CHARS).nullable(),
	observations: z.array(TraceObservationSchema).max(5),
});
export type RunExcerpt = z.infer<typeof RunExcerptSchema>;

const RunEvidenceSchema = RunExcerptSchema.extend({
	runId: z.string().min(1),
	taskId: z.string().min(1),
});

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
	schemaVersion: z.union([z.literal(1), z.literal(DIAGNOSIS_SCHEMA_VERSION)]),
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
	/**
	 * What every trace of this run shows, read once, here, where the traces are
	 * already opened and the result is persisted immutably. Every later reader —
	 * the brief, the panel, the Evidence Explorer — quotes this instead of
	 * re-opening protected evidence. Absent on version 1 records.
	 */
	runEvidence: z.array(RunEvidenceSchema).max(MAX_RUN_EXCERPTS).optional(),
});
export type DiagnosisRecord = z.infer<typeof DiagnosisRecordSchema>;

interface TaskAggregate {
	taskId: string;
	pass: number;
	fail: number;
	error: number;
	evidence: z.infer<typeof EvidenceRefSchema>[];
	failedGraderCategories: Set<DiagnosisCategory>;
	failedReasons: string[];
}

function categoryFor(aggregate: TaskAggregate): DiagnosisCategory[] {
	const categories: DiagnosisCategory[] = [];
	if (aggregate.error > 0) categories.push("infrastructure");
	if (aggregate.pass > 0 && aggregate.fail + aggregate.error > 0) categories.push("flaky-behavior");
	for (const category of ["tool-selection", "output-contract", "answer-quality"] as const) {
		if (aggregate.failedGraderCategories.has(category)) categories.push(category);
	}
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

/** An XML- or JSON-shaped tool call that was typed into the answer instead of made. */
const TOOL_CALL_TEXT = /<\/?(?:function|tool_call|invoke|parameter)\b|"(?:name|tool)"\s*:[^]{0,200}?"(?:arguments|parameters|args)"\s*:/i;
/** A line that hands the turn back to the user. */
const QUESTION_LINE = /[?？]\s*$/;
/** Scripts that never share a sentence with the Cyrillic or Latin the answer is in. */
const FOREIGN_SCRIPT = /[぀-ヿ㐀-䶿一-鿿가-힯֐-׿؀-ۿ]/;
const CYRILLIC_OR_LATIN = /[A-Za-zЀ-ӿ]/;

/**
 * Read one trace the way a person skims it: what was called, what was finally
 * said, and the handful of things that are visibly wrong with it. Nothing here
 * interprets — every observation is a predicate over the bytes.
 */
function excerptOf(messages: TraceMessage[]): z.infer<typeof RunExcerptSchema> {
	const toolNames = [...new Set(traceToolCalls(messages).map((call) => call.name))]
		.sort()
		.slice(0, MAX_TOOL_NAMES)
		.map((name) => redactTraceText(name).slice(0, MAX_TOOL_NAME_CHARS))
		.filter((name) => name.length > 0);
	const answer = lastAssistantText(messages) ?? "";
	const reply = redactTraceText(answer).trim();
	const observations: TraceObservation[] = [];
	if (toolNames.length === 0) observations.push("no-tool-call");
	if (TOOL_CALL_TEXT.test(reply)) observations.push("tool-call-as-text");
	if (reply.split("\n").some((line) => QUESTION_LINE.test(line))) observations.push("asks-a-question");
	if (FOREIGN_SCRIPT.test(reply) && CYRILLIC_OR_LATIN.test(reply)) observations.push("mixed-script");
	if (reply.length === 0) observations.push("empty-reply");
	return {
		toolNames,
		reply: reply.length === 0 ? null : reply.slice(0, MAX_REPLY_CHARS),
		observations: observations.sort(),
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
	const runEvidence: z.infer<typeof RunEvidenceSchema>[] = [];
	const sourceRuns = verified.runs;
	for (const run of sourceRuns) {
		const aggregate = aggregates.get(run.taskId) ?? {
			taskId: run.taskId,
			pass: 0,
			fail: 0,
			error: 0,
			evidence: [],
			failedGraderCategories: new Set<DiagnosisCategory>(),
			failedReasons: [],
		};
		let toolNames: string[] = [];
		if (run.trace.sha256) {
			const traceArtifact = resolveContainedArtifactPath(runsRoot, run.runId, run.trace.path);
			const trace = openTrace(dirname(traceArtifact), basename(traceArtifact), run.trace.sha256);
			const excerpt = excerptOf(trace);
			toolNames = excerpt.toolNames;
			if (runEvidence.length < MAX_RUN_EXCERPTS) {
				runEvidence.push({ runId: run.runId, taskId: run.taskId, ...excerpt });
			}
		}
		const failedGraders = run.evalResults?.graders.filter((grader) => !grader.passed) ?? [];
		if (run.status === "error") aggregate.error += 1;
		else if (run.evalResults?.outcome === "pass") aggregate.pass += 1;
		else aggregate.fail += 1;
		for (const grader of failedGraders) {
			aggregate.failedGraderCategories.add(categoryForGrader(grader));
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
		schemaVersion: DIAGNOSIS_SCHEMA_VERSION,
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
		runEvidence,
	};
	writeJsonArtifact(outputPath, DiagnosisRecordSchema, record, { immutable: true });
	return record;
}

export function loadDiagnosis(runsRoot: string, evalRunId: string): DiagnosisRecord {
	return readJsonArtifact(diagnosisPath(runsRoot, evalRunId), DiagnosisRecordSchema);
}
