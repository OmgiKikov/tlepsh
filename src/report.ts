import { language, t } from "./i18n.js";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import {
	compileImprovementBrief,
	publicTaskId,
	type ImprovementBrief,
} from "./application/improvement-brief.js";
import { compareEvalRuns, renderGateLine, runCost, runTokens, type CompareResult } from "./compare.js";
import { diagnoseEvalRun, loadDiagnosis, type DiagnosisRecord } from "./diagnosis.js";
import {
	isSealedEvalRun,
	loadVerifiedEvalRun,
	readEvalRunIndex,
	type EvalRunRecord,
} from "./eval.js";
import { judgeEvidenceCalibration, type JudgeCalibration } from "./application/judge-labels.js";
import { formatJudgeAgreement } from "./domain/judge-agreement.js";
import { canonicalJson, hashValue, type RunRecord } from "./provenance.js";
import { openTrace, redactTraceText, type TraceMessage } from "./trace.js";
import {
	explainRun,
	graderFindings,
	judgeAbstentions,
	runsTable,
	taskInputPreviews,
	traceFacts,
	type RunExplanation,
	type RunRow,
} from "./application/run-explanation.js";
import {
	EVIDENCE_TABLE_CSS,
	EVIDENCE_TOKENS_DARK,
	RUNS_TABLE_FILTER_SCRIPT,
	renderRunsTable,
} from "./evidence/pages.js";
import { writeTextArtifact } from "./storage/artifacts.js";
import { resolveContainedArtifactPath } from "./storage/paths.js";
// The optional growth section: the same projection `ahde log` prints.
import { compileAgentLog, formatResolvedModes, sparkline, type AgentLog } from "./application/agent-log.js";
import { interval, money, percent, points, ratio } from "./measurement.js";

const MAX_MESSAGE_CHARS = 20_000;
const MAX_TRACE_MESSAGES = 500;
const MAX_TOOL_CALLS_PER_MESSAGE = 50;
const MAX_RUN_ERROR_CHARS = 4_000;
const MAX_RUN_GRADERS = 20;
const MAX_GRADER_NAME_CHARS = 200;
const MAX_GRADER_TYPE_CHARS = 100;
const MAX_GRADER_REASON_CHARS = 1_000;
const MAX_DIAGNOSIS_SUMMARY_CHARS = 1_000;
const MAX_DIAGNOSIS_CAUSE_CHARS = 2_000;
const MAX_DIAGNOSIS_SUGGESTION_CHARS = 500;
const MAX_DIAGNOSIS_EVIDENCE_NAME_CHARS = 200;
const MAX_DIAGNOSIS_ISSUES = 30;
const MAX_DIAGNOSIS_EVIDENCE = 5;
const MAX_DIAGNOSIS_NAMES = 5;
const MAX_DIAGNOSIS_SUGGESTIONS = 4;
const MAX_REPORT_EVAL_IDS = 50;
const MAX_REPORT_COMPARISON_ROWS = 200;
const MAX_REPORT_COMPARISON_ISSUES = 100;
const MAX_REPRESENTATIVE_TRACE_CHARS = 8_000;
const MAX_COUNTER_REPRESENTATIVES = 5;
const MAX_COUNTER_TRACE_CHARS = 4_000;
const MAX_REPORT_DATA_BYTES = 3 * 1024 * 1024;
/** Table rows embedded in a static report. One row per case × repetition. */
export const MAX_REPORT_TABLE_ROWS = 1_000;
export const MAX_REPORT_HTML_BYTES = 20 * 1024 * 1024;
export const MAX_DETAIL_RUNS = 50;
export const MAX_NORMALIZED_TRACE_CHARS = 250_000;
export const MAX_NORMALIZED_TRACE_MESSAGES = 2_000;
export const MAX_NORMALIZED_TOOL_CALLS = 5_000;

const ProjectionCountSchema = z.strictObject({
	sourceCount: z.number().int().nonnegative(),
	includedCount: z.number().int().nonnegative(),
	omittedCount: z.number().int().nonnegative(),
}).superRefine((projection, context) => {
	if (projection.sourceCount !== projection.includedCount + projection.omittedCount) {
		context.addIssue({
			code: "custom",
			path: ["sourceCount"],
			message: "must equal includedCount + omittedCount",
		});
	}
});

const EvalIndexProjectionSchema = z.strictObject({
	runIds: ProjectionCountSchema,
	runArtifacts: ProjectionCountSchema.nullable(),
	taskIds: ProjectionCountSchema.nullable(),
});

export const EvalReportProjectionSchema = z.strictObject({
	selection: z.literal("mode-evidence-then-failures-errors-then-passes-source-order"),
	sourceRunCount: z.number().int().nonnegative(),
	includedRunCount: z.number().int().nonnegative().max(MAX_DETAIL_RUNS),
	includedRunIds: z.array(z.string().min(1)).max(MAX_DETAIL_RUNS),
	omittedRunCount: z.number().int().nonnegative(),
	traceCharactersIncluded: z.number().int().nonnegative().max(MAX_NORMALIZED_TRACE_CHARS),
	traceMessagesIncluded: z.number().int().nonnegative().max(MAX_NORMALIZED_TRACE_MESSAGES),
	toolCallsIncluded: z.number().int().nonnegative().max(MAX_NORMALIZED_TOOL_CALLS),
	traceTruncated: z.boolean(),
	truncatedTraceRunIds: z.array(z.string().min(1)).max(MAX_DETAIL_RUNS),
	limits: z.strictObject({
		detailRuns: z.literal(MAX_DETAIL_RUNS),
		traceCharacters: z.literal(MAX_NORMALIZED_TRACE_CHARS),
		representativeTraceCharacters: z.literal(MAX_REPRESENTATIVE_TRACE_CHARS),
		counterTraceCharacters: z.literal(MAX_COUNTER_TRACE_CHARS),
		toolCallsPerMessage: z.literal(MAX_TOOL_CALLS_PER_MESSAGE),
		traceMessages: z.literal(MAX_NORMALIZED_TRACE_MESSAGES),
		toolCalls: z.literal(MAX_NORMALIZED_TOOL_CALLS),
	}),
	evalRun: EvalIndexProjectionSchema,
	diagnosis: z.strictObject({
		issues: ProjectionCountSchema,
		suggestions: ProjectionCountSchema,
		evidence: ProjectionCountSchema,
		graderNames: ProjectionCountSchema,
		toolNames: ProjectionCountSchema,
	}),
	comparison: z.strictObject({
		rows: ProjectionCountSchema,
		issues: ProjectionCountSchema,
		a: EvalIndexProjectionSchema,
		b: EvalIndexProjectionSchema,
	}).nullable(),
}).superRefine((projection, context) => {
	if (projection.includedRunCount !== projection.includedRunIds.length) {
		context.addIssue({
			code: "custom",
			path: ["includedRunCount"],
			message: "must equal includedRunIds.length",
		});
	}
	if (projection.sourceRunCount !== projection.includedRunCount + projection.omittedRunCount) {
		context.addIssue({
			code: "custom",
			path: ["sourceRunCount"],
			message: "must equal includedRunCount + omittedRunCount",
		});
	}
	if (new Set(projection.includedRunIds).size !== projection.includedRunIds.length) {
		context.addIssue({ code: "custom", path: ["includedRunIds"], message: "must be unique" });
	}
	if (new Set(projection.truncatedTraceRunIds).size !== projection.truncatedTraceRunIds.length) {
		context.addIssue({ code: "custom", path: ["truncatedTraceRunIds"], message: "must be unique" });
	}
	const included = new Set(projection.includedRunIds);
	if (projection.truncatedTraceRunIds.some((runId) => !included.has(runId))) {
		context.addIssue({
			code: "custom",
			path: ["truncatedTraceRunIds"],
			message: "must be a subset of includedRunIds",
		});
	}
	if (projection.traceTruncated !== (projection.truncatedTraceRunIds.length > 0)) {
		context.addIssue({
			code: "custom",
			path: ["traceTruncated"],
			message: "must reflect truncatedTraceRunIds",
		});
	}
});
export type EvalReportProjection = z.infer<typeof EvalReportProjectionSchema>;

export interface ReportTraceMessage {
	role: TraceMessage["role"];
	text: string;
	toolCalls: Array<{ name: string; arguments: string }>;
	omittedToolCallCount: number;
	toolResult: { name: string; text: string; isError: boolean } | null;
}

export interface ReportRun {
	runId: string;
	taskId: string;
	repetitionIndex: number;
	status: string;
	outcome: string;
	error: string | null;
	graders: Array<{ name: string; type: string; passed: boolean; reason: string }>;
	graderProjection: z.infer<typeof ProjectionCountSchema>;
	metrics: { latencyMs: number; toolCalls: number; reportedToolCalls: number; toolErrors: number; tokens: number | null; costUsd: number | null };
	trace: ReportTraceMessage[];
	traceProjection: z.infer<typeof ProjectionCountSchema> | null;
}

/** Deliberately small display DTO. Canonical provenance stays in eval_run.json. */
export interface ReportEvalRun {
	schemaVersion: EvalRunRecord["schemaVersion"];
	evalRunId: string;
	target: { id: string; gitSha: string };
	label: EvalRunRecord["label"];
	baselineEvalRunId: string | null;
	suiteId: string;
	dataset: string;
	evidenceVisibility?: EvalRunRecord["evidenceVisibility"];
	repetitions: number;
	runIds: string[];
	runArtifacts?: NonNullable<EvalRunRecord["runArtifacts"]>;
	taskIds?: string[];
	startedAt: string;
	finishedAt: string;
	summary: EvalRunRecord["summary"];
}

export type ReportDiagnosis = Omit<DiagnosisRecord, "issues"> & {
	issues: DiagnosisRecord["issues"];
};

export type ReportComparison = Omit<CompareResult, "a" | "b" | "rows" | "issues"> & {
	a: ReportEvalRun;
	b: ReportEvalRun;
	rows: CompareResult["rows"];
	issues: string[];
};

/**
 * How far the judge behind one grader spec has been checked against a human.
 * One row per judge grader spec that actually graded this run; `line` is the
 * exact text every screen shows, so the report, the CLI and the Builder cannot
 * word the same fact differently.
 */
export interface ReportJudgeCalibration {
	graderSpecHash: string;
	graderNames: string[];
	calibrated: boolean;
	agreement: number;
	kappa: number | null;
	labels: number;
	line: string;
}

export interface EvalReportData {
	generatedAt: string;
	evalRun: ReportEvalRun;
	diagnosis: ReportDiagnosis;
	improvementBrief: ImprovementBrief;
	comparison: ReportComparison | null;
	/** The one-line verdict with its cost/latency fragment; empty without a pair. */
	comparisonGateLine: string;
	runs: ReportRun[];
	/** Empty when no judge grader ran; one row per judge grader spec otherwise. */
	judgeCalibration: ReportJudgeCalibration[];
	/**
	 * Grader results this eval lost to a judge that said it could not tell.
	 * Counted separately from the pass/fail tally it is already inside: an
	 * abstention fails the check, and reading it as the agent's failure is the
	 * one mistake this number exists to prevent.
	 */
	judgeAbstained: number;
	/**
	 * The agent's growth for this Target — the same bounded projection
	 * `ahde log` prints. Null when no project is known, because a log is asked
	 * for by project, and null when the candidate evidence cannot be read: a
	 * missing growth section never costs a report its run evidence.
	 */
	agentLog: AgentLog | null;
	/**
	 * One row per case × repetition — the same projection the live Evidence
	 * Explorer tabulates, so the offline artifact and the served page cannot show
	 * different numbers for the same eval.
	 */
	rows: RunRow[];
	/** Host-written explanation of every run that did not pass, in table order. */
	explanations: RunExplanation[];
	omittedTableRowCount: number;
	projection: EvalReportProjection;
	redactionNotice: string;
}

interface TraceCharacterBudget {
	remaining: number;
	included: number;
}

interface TraceItemBudget {
	messagesRemaining: number;
	toolCallsRemaining: number;
	includedMessages: number;
	includedToolCalls: number;
}

interface ProjectedTraceText {
	text: string;
	truncated: boolean;
	budgetTruncated: boolean;
}

function projectTraceText(text: string, budget: TraceCharacterBudget): ProjectedTraceText {
	const redacted = redactTraceText(text);
	const messageBounded = redacted.slice(0, MAX_MESSAGE_CHARS);
	const includedLength = Math.min(messageBounded.length, budget.remaining);
	const projected = messageBounded.slice(0, includedLength);
	budget.remaining -= includedLength;
	budget.included += includedLength;
	return {
		text: projected,
		truncated: projected.length < redacted.length,
		budgetTruncated: projected.length < messageBounded.length,
	};
}

function reportTrace(
	messages: TraceMessage[],
	budget: TraceCharacterBudget,
	items: TraceItemBudget,
): { trace: ReportTraceMessage[]; truncated: boolean; messageProjection: z.infer<typeof ProjectionCountSchema> } {
	const trace: ReportTraceMessage[] = [];
	const messageLimit = Math.min(MAX_TRACE_MESSAGES, items.messagesRemaining);
	let truncated = messages.length > messageLimit;
	const boundedMessages = messages.slice(0, messageLimit);

	for (const message of boundedMessages) {
		if (budget.remaining === 0) {
			truncated = true;
			break;
		}
		items.messagesRemaining -= 1;
		items.includedMessages += 1;

		const text = projectTraceText(message.text, budget);
		truncated ||= text.truncated;
		const sourceToolCalls = message.toolCalls ?? [];
		const projected: ReportTraceMessage = {
			role: message.role,
			text: text.text,
			toolCalls: [],
			omittedToolCallCount: Math.max(0, sourceToolCalls.length - MAX_TOOL_CALLS_PER_MESSAGE),
			toolResult: null,
		};
		if (projected.omittedToolCallCount > 0) truncated = true;
		if (text.budgetTruncated) {
			trace.push(projected);
			break;
		}

		const toolCallLimit = Math.min(MAX_TOOL_CALLS_PER_MESSAGE, items.toolCallsRemaining);
		for (const call of sourceToolCalls.slice(0, toolCallLimit)) {
			if (budget.remaining === 0) {
				truncated = true;
				break;
			}
			const name = projectTraceText(call.name, budget);
			const argumentsText = name.budgetTruncated
				? { text: "", truncated: true, budgetTruncated: true }
				: projectTraceText(JSON.stringify(call.arguments, null, 2), budget);
			truncated ||= name.truncated || argumentsText.truncated;
			projected.toolCalls.push({ name: name.text, arguments: argumentsText.text });
			items.toolCallsRemaining -= 1;
			items.includedToolCalls += 1;
			if (name.budgetTruncated || argumentsText.budgetTruncated) break;
		}
		projected.omittedToolCallCount = sourceToolCalls.length - projected.toolCalls.length;
		if (projected.omittedToolCallCount > 0) {
			truncated = true;
		}

		if (message.toolResult) {
			if (budget.remaining === 0) {
				truncated = true;
			} else {
				const name = projectTraceText(message.toolResult.toolName, budget);
				const resultText = name.budgetTruncated
					? { text: "", truncated: true, budgetTruncated: true }
					: projectTraceText(message.toolResult.text, budget);
				truncated ||= name.truncated || resultText.truncated;
				projected.toolResult = {
					name: name.text,
					text: resultText.text,
					isError: message.toolResult.isError,
				};
			}
		}

		trace.push(projected);
	}
	return {
		trace,
		truncated,
		messageProjection: projectionCount(messages.length, trace.length),
	};
}

function reportOutcome(run: RunRecord): string {
	return run.status === "completed" ? (run.evalResults?.outcome ?? "error") : "error";
}

function reportMetadataText(value: string, maxChars: number): string {
	return redactTraceText(value).slice(0, maxChars);
}

function projectionCount(sourceCount: number, includedCount: number): z.infer<typeof ProjectionCountSchema> {
	return ProjectionCountSchema.parse({
		sourceCount,
		includedCount,
		omittedCount: sourceCount - includedCount,
	});
}

function evalIndexProjection(source: EvalRunRecord, projected: ReportEvalRun): z.infer<typeof EvalIndexProjectionSchema> {
	return EvalIndexProjectionSchema.parse({
		runIds: projectionCount(source.runIds.length, projected.runIds.length),
		runArtifacts: source.runArtifacts
			? projectionCount(source.runArtifacts.length, projected.runArtifacts?.length ?? 0)
			: null,
		taskIds: source.taskIds
			? projectionCount(source.taskIds.length, projected.taskIds?.length ?? 0)
			: null,
	});
}

function projectDiagnosis(record: DiagnosisRecord): ReportDiagnosis {
	return {
		schemaVersion: record.schemaVersion,
		diagnosisId: reportMetadataText(record.diagnosisId, 500),
		evalRunId: reportMetadataText(record.evalRunId, 500),
		targetId: reportMetadataText(record.targetId, 500),
		targetRevision: reportMetadataText(record.targetRevision, 500),
		status: record.status,
		createdAt: reportMetadataText(record.createdAt, 100),
		inputHash: record.inputHash,
		summary: record.summary,
		issues: record.issues.slice(0, MAX_DIAGNOSIS_ISSUES).map((issue) => ({
			...issue,
			issueId: reportMetadataText(issue.issueId, 500),
			taskId: publicTaskId(issue.taskId),
			summary: reportMetadataText(issue.summary, MAX_DIAGNOSIS_SUMMARY_CHARS),
			rootCause: reportMetadataText(issue.rootCause, MAX_DIAGNOSIS_CAUSE_CHARS),
			suggestions: issue.suggestions.slice(0, MAX_DIAGNOSIS_SUGGESTIONS).map((suggestion) =>
				reportMetadataText(suggestion, MAX_DIAGNOSIS_SUGGESTION_CHARS)
			),
			evidence: issue.evidence.slice(0, MAX_DIAGNOSIS_EVIDENCE).map((evidence) => ({
				runId: reportMetadataText(evidence.runId, 500),
				tracePath: evidence.tracePath === null ? null : reportMetadataText(evidence.tracePath, 500),
				graderNames: evidence.graderNames.slice(0, MAX_DIAGNOSIS_NAMES).map((name) =>
					reportMetadataText(name, MAX_DIAGNOSIS_EVIDENCE_NAME_CHARS)
				),
				toolNames: evidence.toolNames.slice(0, MAX_DIAGNOSIS_NAMES).map((name) =>
					reportMetadataText(name, MAX_DIAGNOSIS_EVIDENCE_NAME_CHARS)
				),
			})),
		})),
	};
}

function diagnosisProjection(
	source: DiagnosisRecord,
	projected: ReportDiagnosis,
): EvalReportProjection["diagnosis"] {
	const totals = (issues: DiagnosisRecord["issues"]) => ({
		suggestions: issues.reduce((total, issue) => total + issue.suggestions.length, 0),
		evidence: issues.reduce((total, issue) => total + issue.evidence.length, 0),
		graderNames: issues.reduce((total, issue) =>
			total + issue.evidence.reduce((names, evidence) => names + evidence.graderNames.length, 0), 0),
		toolNames: issues.reduce((total, issue) =>
			total + issue.evidence.reduce((names, evidence) => names + evidence.toolNames.length, 0), 0),
	});
	const sourceTotals = totals(source.issues);
	const projectedTotals = totals(projected.issues);
	return {
		issues: projectionCount(source.issues.length, projected.issues.length),
		suggestions: projectionCount(sourceTotals.suggestions, projectedTotals.suggestions),
		evidence: projectionCount(sourceTotals.evidence, projectedTotals.evidence),
		graderNames: projectionCount(sourceTotals.graderNames, projectedTotals.graderNames),
		toolNames: projectionCount(sourceTotals.toolNames, projectedTotals.toolNames),
	};
}

function projectEvalRun(record: EvalRunRecord): ReportEvalRun {
	return {
		schemaVersion: record.schemaVersion,
		evalRunId: record.evalRunId,
		target: {
			id: reportMetadataText(record.target.id, 500),
			gitSha: reportMetadataText(record.target.gitSha, 500),
		},
		label: record.label,
		baselineEvalRunId: record.baselineEvalRunId,
		suiteId: reportMetadataText(record.suiteId, 500),
		dataset: reportMetadataText(record.dataset, 500),
		...(record.evidenceVisibility ? { evidenceVisibility: record.evidenceVisibility } : {}),
		repetitions: record.repetitions,
		runIds: record.runIds.slice(0, MAX_REPORT_EVAL_IDS),
		...(record.runArtifacts
			? { runArtifacts: record.runArtifacts.slice(0, MAX_REPORT_EVAL_IDS) }
			: {}),
		...(record.taskIds
			? { taskIds: record.taskIds.slice(0, MAX_REPORT_EVAL_IDS).map(publicTaskId) }
			: {}),
		startedAt: reportMetadataText(record.startedAt, 100),
		finishedAt: reportMetadataText(record.finishedAt, 100),
		summary: record.summary,
	};
}

function projectComparison(
	result: CompareResult,
): ReportComparison {
	return {
		...result,
		a: projectEvalRun(result.a),
		b: projectEvalRun(result.b),
		rows: result.rows.slice(0, MAX_REPORT_COMPARISON_ROWS).map((row) => ({
			...row,
			taskId: publicTaskId(row.taskId),
		})),
		// Excluded tasks carry ids like every other row and are redacted like
		// every other row: a task the engine lost is still a task of the corpus.
		excluded: result.excluded.slice(0, MAX_REPORT_COMPARISON_ROWS).map((task) => ({
			...task,
			taskId: publicTaskId(task.taskId),
		})),
		issues: result.issues.slice(0, MAX_REPORT_COMPARISON_ISSUES).map((issue) =>
			reportMetadataText(issue, 2_000)
		),
		error: result.error === null ? null : reportMetadataText(result.error, 4_000),
	};
}

/**
 * Judge graders that graded these runs, each with the agreement its project's
 * human labels support. Without a label store the rows still appear, saying
 * plainly that nobody has checked the judge yet.
 */
export function judgeCalibrationRows(
	runs: readonly RunRecord[],
	calibration: JudgeCalibration | null,
	/**
	 * Whether a label store was consulted at all. "Not calibrated" is a claim
	 * about the judge; a surface that never opened the labels has no business
	 * making it, and would otherwise contradict `ahde report` on the same run.
	 */
	consulted = true,
): ReportJudgeCalibration[] {
	const names = new Map<string, Set<string>>();
	for (const run of runs) {
		for (const grader of run.evalResults?.graders ?? []) {
			if (grader.checkCode !== "semantic-rubric" || !grader.specHash) continue;
			const bucket = names.get(grader.specHash) ?? new Set<string>();
			bucket.add(reportMetadataText(grader.name, MAX_GRADER_NAME_CHARS));
			names.set(grader.specHash, bucket);
		}
	}
	return [...names.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([graderSpecHash, graderNames]) => {
			const stats = calibration?.byGraderSpecHash.get(graderSpecHash);
			return {
				graderSpecHash,
				graderNames: [...graderNames].sort().slice(0, MAX_DIAGNOSIS_NAMES),
				calibrated: stats !== undefined && stats.n > 0,
				agreement: stats?.agreement ?? 0,
				kappa: stats?.kappa ?? null,
				labels: stats?.n ?? 0,
				line: stats && (stats.n > 0 || stats.duplicateLabels > 0 || stats.conflictedSubjects > 0)
					? `${stats.n > 0 ? "judge agreement" : "judge not calibrated"} ${formatJudgeAgreement(stats)}`
					: consulted
						? "judge not calibrated"
						: "judge calibration not available here",
			};
		});
}

export function collectEvalReportData(
	runsRoot: string,
	evalRunId: string,
	now = () => new Date().toISOString(),
	options: {
		allowDiagnosisCreation?: boolean;
		/** Where this project's human judge labels live, when there are any. */
		labels?: { stateRoot: string; projectId: string };
	} = {},
): EvalReportData {
	resolveContainedArtifactPath(runsRoot, evalRunId, "eval_run.json");
	const requestedIndex = readEvalRunIndex(runsRoot, evalRunId);
	if (isSealedEvalRun(requestedIndex)) {
		throw new Error("sealed holdout evidence is unavailable");
	}
	const canonicalDiagnosis = options.allowDiagnosisCreation === false
		? loadDiagnosis(runsRoot, evalRunId)
		: diagnoseEvalRun(runsRoot, evalRunId, now);
	const improvementBrief = compileImprovementBrief(runsRoot, canonicalDiagnosis);
	let canonicalComparison: CompareResult | null = null;
	if (requestedIndex.baselineEvalRunId) {
		resolveContainedArtifactPath(runsRoot, requestedIndex.baselineEvalRunId, "eval_run.json");
		let baselineIndex: EvalRunRecord;
		try {
			baselineIndex = readEvalRunIndex(runsRoot, requestedIndex.baselineEvalRunId);
		} catch {
			throw new Error("baseline evidence failed integrity checks");
		}
		if (isSealedEvalRun(baselineIndex)) {
			throw new Error("cross-visibility baseline evidence is unavailable");
		}
		try {
			canonicalComparison = compareEvalRuns(runsRoot, baselineIndex.evalRunId, requestedIndex.evalRunId, { mode: "exploratory" });
		} catch {
			throw new Error("comparison evidence failed integrity checks");
		}
		if (isSealedEvalRun(canonicalComparison.a) || isSealedEvalRun(canonicalComparison.b)) {
			throw new Error("cross-visibility comparison evidence is unavailable");
		}
	}
	// This final verified snapshot is the only source for report Run projections.
	// Report rendering never re-opens raw RunRecords after integrity verification.
	const verified = loadVerifiedEvalRun(runsRoot, evalRunId);
	const evalRun = verified.record;
	if (
		isSealedEvalRun(evalRun) ||
		evalRun.baselineEvalRunId !== requestedIndex.baselineEvalRunId
	) {
		throw new Error("evaluation visibility or lineage changed during report collection");
	}
	const finalInputHash = hashValue({ evalRun, runs: verified.runs });
	if (
		canonicalDiagnosis.inputHash !== finalInputHash ||
		improvementBrief.evalRunId !== evalRun.evalRunId ||
		improvementBrief.diagnosisId !== canonicalDiagnosis.diagnosisId
	) {
		throw new Error("diagnosis changed relative to the final verified evidence snapshot");
	}
	const sourceRuns = verified.runs.map((run) => ({ runId: run.runId, run }));
	const sourceRunsById = new Map(sourceRuns.map((entry) => [entry.runId, entry]));
	const failureRepresentativeRunIds = improvementBrief.modes.flatMap((mode) => {
		const representative = mode.evidence.find((evidence) => {
			const source = sourceRunsById.get(evidence.runId);
			return evidence.traceAvailable && source?.run.trace.sha256;
		});
		return representative ? [representative.runId] : [];
	});
	const failureRepresentativeIdSet = new Set(failureRepresentativeRunIds);
	const counterCapacityByBudget = Math.floor(Math.max(
		0,
		MAX_NORMALIZED_TRACE_CHARS - failureRepresentativeIdSet.size * MAX_REPRESENTATIVE_TRACE_CHARS,
	) / MAX_COUNTER_TRACE_CHARS);
	const counterRepresentativeRunIds = improvementBrief.modes.flatMap((mode) => {
		const representative = mode.decision === "stabilize-and-rerun"
			? mode.counterEvidence.find((evidence) => {
				const source = sourceRunsById.get(evidence.runId);
				return evidence.traceAvailable && source?.run.trace.sha256;
			})
			: undefined;
		return representative && !failureRepresentativeIdSet.has(representative.runId)
			? [representative.runId]
			: [];
	});
	const reservedCounterRunIds = [...new Set(counterRepresentativeRunIds)]
		.slice(0, Math.min(MAX_COUNTER_REPRESENTATIVES, counterCapacityByBudget));
	const counterRepresentativeIdSet = new Set(reservedCounterRunIds);
	const reservedRunIds = [...failureRepresentativeIdSet, ...reservedCounterRunIds];
	const reservedRunIdSet = new Set(reservedRunIds);
	const prioritizedRuns = [
		...reservedRunIds.map((runId) => sourceRunsById.get(runId)!),
		...sourceRuns.filter(({ runId, run }) => !reservedRunIdSet.has(runId) && reportOutcome(run) !== "pass"),
		...sourceRuns.filter(({ runId, run }) => !reservedRunIdSet.has(runId) && reportOutcome(run) === "pass"),
	];
	const includedRuns = prioritizedRuns.slice(0, MAX_DETAIL_RUNS);
	const traceBudget: TraceCharacterBudget = {
		remaining: MAX_NORMALIZED_TRACE_CHARS,
		included: 0,
	};
	const traceItemBudget: TraceItemBudget = {
		messagesRemaining: MAX_NORMALIZED_TRACE_MESSAGES,
		toolCallsRemaining: MAX_NORMALIZED_TOOL_CALLS,
		includedMessages: 0,
		includedToolCalls: 0,
	};
	const truncatedTraceRunIds: string[] = [];
	const runs = includedRuns.map(({ runId, run }): ReportRun => {
		let trace: ReportTraceMessage[] = [];
		let traceProjection: z.infer<typeof ProjectionCountSchema> | null = null;
		const sourceGraders = run.evalResults?.graders ?? [];
		const graders = sourceGraders.slice(0, MAX_RUN_GRADERS).map((grader) => ({
			name: reportMetadataText(grader.name, MAX_GRADER_NAME_CHARS),
			type: reportMetadataText(grader.type, MAX_GRADER_TYPE_CHARS),
			passed: grader.passed,
			reason: reportMetadataText(grader.reason, MAX_GRADER_REASON_CHARS),
		}));
		if (run.trace.sha256) {
			if (traceBudget.remaining === 0 || traceItemBudget.messagesRemaining === 0) {
				truncatedTraceRunIds.push(runId);
			} else {
				const traceArtifact = resolveContainedArtifactPath(runsRoot, runId, run.trace.path);
				const representative = reservedRunIdSet.has(runId);
				const representativeLimit = counterRepresentativeIdSet.has(runId)
					? MAX_COUNTER_TRACE_CHARS
					: MAX_REPRESENTATIVE_TRACE_CHARS;
				const activeBudget = representative
					? {
						remaining: Math.min(representativeLimit, traceBudget.remaining),
						included: 0,
					}
					: traceBudget;
				const projected = reportTrace(
					openTrace(dirname(traceArtifact), basename(traceArtifact), run.trace.sha256),
					activeBudget,
					traceItemBudget,
				);
				if (representative) {
					traceBudget.remaining -= activeBudget.included;
					traceBudget.included += activeBudget.included;
				}
				trace = projected.trace;
				traceProjection = projected.messageProjection;
				if (projected.truncated) truncatedTraceRunIds.push(runId);
			}
		}
		return {
			runId,
			taskId: publicTaskId(run.taskId),
			repetitionIndex: run.repetitionIndex,
			status: run.status,
			outcome: reportOutcome(run),
			error: run.error === null ? null : reportMetadataText(run.error, MAX_RUN_ERROR_CHARS),
			graders,
			graderProjection: projectionCount(sourceGraders.length, graders.length),
			metrics: {
				latencyMs: run.metrics.latencyMs,
				toolCalls: run.metrics.toolCalls,
				reportedToolCalls: run.metrics.reportedToolCalls ?? 0,
				toolErrors: run.metrics.toolErrors,
				tokens: runTokens(run)?.total ?? null,
				costUsd: runCost(run),
			},
			trace,
			traceProjection,
		};
	});
	const projectedEvalRun = projectEvalRun(evalRun);
	const diagnosis = projectDiagnosis(canonicalDiagnosis);
	const comparison = canonicalComparison === null ? null : projectComparison(canonicalComparison);
	const projection = EvalReportProjectionSchema.parse({
		selection: "mode-evidence-then-failures-errors-then-passes-source-order",
		sourceRunCount: sourceRuns.length,
		includedRunCount: runs.length,
		includedRunIds: runs.map((run) => run.runId),
		omittedRunCount: sourceRuns.length - runs.length,
		traceCharactersIncluded: traceBudget.included,
		traceMessagesIncluded: traceItemBudget.includedMessages,
		toolCallsIncluded: traceItemBudget.includedToolCalls,
		traceTruncated: truncatedTraceRunIds.length > 0,
		truncatedTraceRunIds,
		limits: {
			detailRuns: MAX_DETAIL_RUNS,
			traceCharacters: MAX_NORMALIZED_TRACE_CHARS,
			representativeTraceCharacters: MAX_REPRESENTATIVE_TRACE_CHARS,
			counterTraceCharacters: MAX_COUNTER_TRACE_CHARS,
			toolCallsPerMessage: MAX_TOOL_CALLS_PER_MESSAGE,
			traceMessages: MAX_NORMALIZED_TRACE_MESSAGES,
			toolCalls: MAX_NORMALIZED_TOOL_CALLS,
		},
		evalRun: evalIndexProjection(evalRun, projectedEvalRun),
		diagnosis: diagnosisProjection(canonicalDiagnosis, diagnosis),
		comparison: canonicalComparison && comparison
			? {
				rows: projectionCount(canonicalComparison.rows.length, comparison.rows.length),
				issues: projectionCount(canonicalComparison.issues.length, comparison.issues.length),
				a: evalIndexProjection(canonicalComparison.a, comparison.a),
				b: evalIndexProjection(canonicalComparison.b, comparison.b),
			}
			: null,
	});
	// A missing or unreadable label store is not a report failure: the screen
	// then says the judge is not calibrated, which is exactly true.
	let calibration: JudgeCalibration | null = null;
	if (options.labels) {
		try {
			const exact = judgeEvidenceCalibration({
				runsRoot,
				stateRoot: options.labels.stateRoot,
				projectId: options.labels.projectId,
				evalRunIds: [evalRunId],
			});
			calibration = {
				byGraderSpecHash: exact.byGraderSpecHash,
				pooled: exact.stats ?? {
					n: 0,
					nChecks: 0,
					duplicateLabels: 0,
					conflictedSubjects: 0,
					agreement: 0,
					kappa: null,
					falsePass: 0,
					falseFail: 0,
					truePass: 0,
					trueFail: 0,
				},
				totalLabels: exact.stats?.n ?? 0,
			};
		} catch {
			calibration = null;
		}
	}
	// The growth section is optional and additive: a project is what a log is
	// asked for by, and an unreadable candidate directory must never cost a
	// report the run evidence it exists for.
	let agentLog: AgentLog | null = null;
	if (options.labels) {
		try {
			agentLog = compileAgentLog({
				runsRoot,
				targetId: evalRun.target.id,
				projectId: options.labels.projectId,
			});
		} catch {
			agentLog = null;
		}
	}
	// The table and the host-written explanations use exactly the projection the
	// live explorer serves, so an operator reading `report.html` offline and an
	// operator reading `/evals/<id>` see the same rows and the same sentences.
	const inputPreviews = taskInputPreviews(runsRoot, verified.runs);
	const allTableRows = runsTable(runsRoot, verified.runs, improvementBrief, { inputPreviews });
	const tableRows = allTableRows.slice(0, MAX_REPORT_TABLE_ROWS);
	const verifiedById = new Map(verified.runs.map((run) => [run.runId, run]));
	const explanations = tableRows
		.filter((row) => row.outcome !== "pass")
		.map((row) => {
			const sourceRun = verifiedById.get(row.runId)!;
			const messages = sourceRun.trace.sha256
				? (() => {
					try {
						const artifact = resolveContainedArtifactPath(runsRoot, sourceRun.runId, sourceRun.trace.path);
						return openTrace(dirname(artifact), basename(artifact), sourceRun.trace.sha256);
					} catch {
						return null;
					}
				})()
				: null;
			return explainRun({
				run: sourceRun,
				graders: graderFindings(sourceRun, {
					includeJudgeVerdicts: true,
					judgeArtifacts: verified.artifacts.get(sourceRun.runId)?.judge,
				}),
				facts: messages ? traceFacts(messages) : null,
				messages,
				modes: improvementBrief.modes.filter((mode) =>
					mode.evidence.some((evidence) => evidence.runId === row.runId)),
				flip: null,
			});
		});
	const data: EvalReportData = {
		generatedAt: now(),
		evalRun: projectedEvalRun,
		diagnosis,
		improvementBrief,
		comparison,
		comparisonGateLine: comparison ? renderGateLine(comparison) : "",
		runs,
		judgeCalibration: judgeCalibrationRows(verified.runs, calibration, options.labels !== undefined),
		judgeAbstained: judgeAbstentions(verified.runs),
		agentLog,
		rows: tableRows,
		explanations,
		omittedTableRowCount: allTableRows.length - tableRows.length,
		projection,
		redactionNotice:
			"This report contains normalized, size-bounded, credential-redacted traces, run errors, grader metadata, and diagnosis text. Protected canonical artifacts remain unchanged on disk.",
	};
	if (Buffer.byteLength(canonicalJson(data), "utf8") > MAX_REPORT_DATA_BYTES) {
		throw new Error(`report projection exceeds the ${MAX_REPORT_DATA_BYTES}-byte safety limit`);
	}
	return data;
}

function embeddedJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * The two tables the report draws from projections rather than from run rows —
 * the comparison and the growth log — rendered here rather than in the page's
 * own script.
 *
 * The script cannot import `measurement.ts`, so every number it formatted was
 * a copy: a percent with no decimal beside a percent with one, a delta spelled
 * `pp` where every other surface says `п.п.`, and a cost that rounded a real
 * bill down to `$0.00`. Formatting them on this side of the wire is what makes
 * the offline report and the served Explorer print the same digits.
 */
function comparisonRowsHtml(comparison: ReportComparison | null): string {
	if (!comparison || comparison.status !== "comparable") return "";
	return comparison.rows
		.map((row) =>
			`<tr><td>${htmlText(row.taskId)}</td><td>${row.aPass}/${row.aTotal}</td><td>${row.bPass}/${row.bTotal}</td>` +
			`<td>${htmlText(percent(row.aScore))} → ${htmlText(percent(row.bScore))}</td>` +
			`<td class="${row.scoreDelta > 0 ? "delta" : ""}">${htmlText(points(row.scoreDelta))}</td></tr>`
		)
		.join("");
}

function growthRowsHtml(log: AgentLog | null): string {
	if (!log) return "";
	return log.rows
		.map((row) => {
			const development = row.development
				? `${htmlText(row.development.verdict)} · ${htmlText(percent(row.development.baselineScore, { digits: 1 }))} → ` +
					`${htmlText(percent(row.development.candidateScore, { digits: 1 }))} (${htmlText(points(row.development.scoreDelta))}` +
					`${row.development.confidence95 ? `, ${htmlText(interval(row.development.confidence95.low, row.development.confidence95.high))}` : ""})`
				: htmlText(t("growth.not-evaluated"));
			const sealed = row.sealed
				? `${htmlText(row.sealed.verdict)} on ${row.sealed.tasks}×${row.sealed.repetitions}`
				: "—";
			const modes = htmlText(formatResolvedModes(row.resolvedModes));
			const loop = row.appliedByImprovementLoop ? ' <span class="pill">improvement loop</span>' : "";
			const cost = `${htmlText(money(row.costUsd))}${row.costRatio === null ? "" : ` · ${htmlText(ratio(row.costRatio))}`}`;
			return `<tr class="${row.outcome === "promoted" ? "version" : "attempt"}"><td>${htmlText(row.tag ?? "rejected")}</td>` +
				`<td>${htmlText(row.at.slice(0, 10))}</td><td>${htmlText(row.baseline)} → ${htmlText(row.candidate ?? "—")}</td>` +
				`<td>${development}</td><td>${sealed}</td><td>${cost}</td><td>${modes}</td>` +
				`<td>${htmlText(row.reason ?? "")}${loop}</td></tr>`;
		})
		.join("");
}

function htmlText(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	})[character] ?? character);
}

function projectionNotice(projection: EvalReportProjection): string {
	const runNotice = projection.omittedRunCount > 0
		? `Detail projection includes ${projection.includedRunCount} of ${projection.sourceRunCount} runs; ${projection.omittedRunCount} runs omitted.`
		: `Detail projection includes all ${projection.includedRunCount} runs.`;
	const traceNotice = projection.traceTruncated
		? ` Normalized traces were truncated for ${projection.truncatedTraceRunIds.length} included runs under the ${projection.limits.traceCharacters.toLocaleString("en-US")}-character global budget, ${projection.limits.representativeTraceCharacters.toLocaleString("en-US")}/${projection.limits.counterTraceCharacters.toLocaleString("en-US")}-character representative caps, and structural caps of ${projection.limits.traceMessages.toLocaleString("en-US")} messages and ${projection.limits.toolCalls.toLocaleString("en-US")} tool calls.`
		: ` Normalized traces fit within the global, per-representative, and structural budgets.`;
	const countNotices: Array<[number, string]> = [
		[projection.evalRun.runIds.omittedCount, "EvalRun run id(s)"],
		[projection.evalRun.runArtifacts?.omittedCount ?? 0, "EvalRun run hash(es)"],
		[projection.evalRun.taskIds?.omittedCount ?? 0, "EvalRun task id(s)"],
		[projection.diagnosis.issues.omittedCount, "diagnosis issue(s)"],
		[projection.diagnosis.suggestions.omittedCount, "diagnosis suggestion(s)"],
		[projection.diagnosis.evidence.omittedCount, "diagnosis evidence row(s)"],
		[projection.diagnosis.graderNames.omittedCount, "diagnosis grader name(s)"],
		[projection.diagnosis.toolNames.omittedCount, "diagnosis tool name(s)"],
	];
	if (projection.comparison) {
		countNotices.push(
			[projection.comparison.rows.omittedCount, "comparison row(s)"],
			[projection.comparison.issues.omittedCount, "comparison issue(s)"],
			[projection.comparison.a.runIds.omittedCount, "baseline run id(s)"],
			[projection.comparison.a.runArtifacts?.omittedCount ?? 0, "baseline run hash(es)"],
			[projection.comparison.a.taskIds?.omittedCount ?? 0, "baseline task id(s)"],
			[projection.comparison.b.runIds.omittedCount, "candidate run id(s)"],
			[projection.comparison.b.runArtifacts?.omittedCount ?? 0, "candidate run hash(es)"],
			[projection.comparison.b.taskIds?.omittedCount ?? 0, "candidate task id(s)"],
		);
	}
	const metadataOmissions = countNotices
		.filter(([count]) => count > 0)
		.map(([count, label]) => `${count} ${label}`);
	const metadataNotice = metadataOmissions.length > 0
		? ` Metadata projection also omitted ${metadataOmissions.join(", ")}; canonical evidence remains on disk.`
		: "";
	return `${runNotice}${traceNotice}${metadataNotice}`;
}

export function renderEvalReportHtml(data: EvalReportData): string {
	const html = `<!doctype html>
<html lang="${language()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AHDE Evidence Report</title>
<style>
${EVIDENCE_TOKENS_DARK}
${EVIDENCE_TABLE_CSS}
:root{color-scheme:dark;--bg:#090b10;--panel:#10131b;--panel2:#151a24;--line:#252b38;--text:#edf0f7;--muted:#929bae;--blue:#6d7cff;--green:#43d17b;--red:#ff667a;--amber:#f2b84b;--radius:14px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
	*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% -10%,#1b2140 0,transparent 35%),var(--bg);color:var(--text)}button{font:inherit}.shell{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:100vh}.side{position:sticky;top:0;height:100vh;border-right:1px solid var(--line);padding:22px 16px;background:rgba(9,11,16,.88);backdrop-filter:blur(16px);overflow:auto}.brand{display:flex;gap:10px;align-items:center;font-weight:750;letter-spacing:.02em;margin:0 8px 24px}.mark{width:28px;height:28px;border-radius:9px;background:linear-gradient(135deg,#8590ff,#4b57e8);box-shadow:0 0 24px #6070ff77}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:11px;color:var(--muted);margin:20px 8px 8px}.run-link{display:block;width:100%;border:0;background:transparent;color:var(--muted);padding:9px 10px;border-radius:9px;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.run-link:hover,.run-link.active{background:var(--panel2);color:var(--text)}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:8px;background:var(--red)}.dot.pass{background:var(--green)}main{padding:36px clamp(24px,4vw,64px);max-width:1500px;width:100%}.top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:30px}.top h1{font-size:clamp(28px,4vw,48px);line-height:1.05;margin:7px 0 10px;letter-spacing:-.04em}.sub{color:var(--muted);font-size:14px}.badge{display:inline-flex;align-items:center;padding:7px 10px;border:1px solid var(--line);border-radius:999px;background:var(--panel);font-size:12px;color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:22px 0 30px}.stat{background:linear-gradient(145deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:var(--radius);padding:18px}.stat strong{font-size:30px;letter-spacing:-.04em;display:block}.stat span{font-size:12px;color:var(--muted)}section{margin:30px 0}.section-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.section-title h2{font-size:18px;margin:0}.issues{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.issue{border:1px solid var(--line);background:var(--panel);border-radius:var(--radius);padding:18px}.issue-head{display:flex;justify-content:space-between;gap:10px}.issue h3{font-size:15px;margin:0 0 8px}.pill{font-size:10px;text-transform:uppercase;letter-spacing:.09em;border-radius:999px;padding:5px 8px;background:#252b3b;color:#c9d0e1}.pill.blocking{background:#481d29;color:#ff9aaa}.issue p{color:var(--muted);font-size:13px;line-height:1.55}.issue ul{padding-left:18px;color:#cbd1df;font-size:13px;line-height:1.55}.brief-headline{font-size:14px;color:#cbd1df;line-height:1.55}.mode-meta,.mode-impact,.mode-evidence{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.hypothesis{border-left:2px solid var(--amber);padding-left:10px}.evidence-list{margin:8px 0;padding-left:18px;color:#cbd1df;font-size:12px}.evidence-list li{margin:7px 0}.trace-link{border:1px solid #39425a;background:#171d2a;color:#cbd3ff;border-radius:8px;padding:7px 9px;cursor:pointer;font-size:12px}.trace-link:hover,.trace-link.active{border-color:var(--blue);color:#fff}.table-wrap{border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;background:var(--panel)}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:13px 14px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--muted);font-weight:550;background:#121620}tr:last-child td{border-bottom:0}tr[data-run]{cursor:pointer}tr[data-run]:hover{background:var(--panel2)}.outcome{font-weight:700}.outcome.pass{color:var(--green)}.outcome.fail,.outcome.error{color:var(--red)}.trace{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);min-height:220px}.trace-empty{padding:44px;text-align:center;color:var(--muted)}.trace-head{padding:16px 18px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between}.message{padding:18px;border-bottom:1px solid var(--line)}.message:last-child{border-bottom:0}.message-label{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--blue);margin-bottom:9px}.message pre{white-space:pre-wrap;word-break:break-word;margin:0;color:#dce1ec;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.tool{margin-top:10px;background:#0b0e14;border:1px solid #262d3c;border-radius:10px;padding:12px}.tool.error{border-color:#632a36}.notice{font-size:12px;color:var(--muted);border-left:2px solid var(--blue);padding:8px 12px}.delta{color:var(--green)}@media(max-width:900px){.shell{grid-template-columns:1fr}.side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}.grid{grid-template-columns:repeat(2,1fr)}.issues{grid-template-columns:1fr}}@media(max-width:520px){.grid{grid-template-columns:1fr}.top{display:block}}
tr.attempt td{color:var(--muted)}tr.version td:first-child{font-weight:700}
</style>
</head>
<body>
<div class="shell"><aside class="side"><div class="brand"><span class="mark"></span> AHDE Evidence</div><div class="eyebrow">${htmlText(t("report.nav.runs"))}</div><div id="run-nav"></div></aside><main>
<header class="top"><div><span class="badge" id="status-badge"></span><h1 id="title"></h1><div class="sub" id="subtitle"></div></div><span class="badge" id="revision"></span></header>
<div class="grid" id="stats"></div>
	<section><div class="section-title"><h2>${htmlText(t("report.h2.failure-modes"))}</h2><span class="badge" id="failure-mode-status"></span></div><p class="brief-headline" id="brief-headline"></p><p class="notice" id="proposal-gate"></p><div class="issues" id="failure-modes"></div></section>
<section><div class="section-title"><h2>${htmlText(t("report.h2.drill-down"))}</h2><span class="badge" id="diagnosis-status"></span></div><div class="issues" id="issues"></div></section>
<section id="comparison-section" hidden><div class="section-title"><h2>${htmlText(t("report.h2.comparison"))}</h2><span class="badge" id="comparison-verdict"></span></div><p class="notice" id="comparison-gate"></p><div class="table-wrap"><table><thead><tr><th>${htmlText(t("report.th.task"))}</th><th>${htmlText(t("report.th.baseline"))}</th><th>${htmlText(t("report.th.candidate"))}</th><th>${htmlText(t("report.th.score"))}</th><th>${htmlText(t("report.th.delta"))}</th></tr></thead><tbody id="comparison"></tbody></table></div></section>
<section><div class="section-title"><h2>${htmlText(t("report.h2.run-evidence"))}</h2><span class="badge">${data.rows.length} run(s)</span></div><p class="notice" id="judge-calibration" hidden></p><p class="notice" id="projection-notice">${htmlText(projectionNotice(data.projection))}</p><div class="filters"><input id="filter" type="search" placeholder="${htmlText(t("report.filter-placeholder"))}" aria-label="${htmlText(t("report.filter-label"))}"><span class="count" id="filter-count"></span></div>${renderRunsTable(data.rows, {
	hrefForRun: (runId) => `#run=${encodeURIComponent(runId)}`,
	modeLabels: new Map(data.improvementBrief.modes.map((mode) => [mode.failureModeId, mode.title])),
	dataRun: true,
})}${data.omittedTableRowCount > 0 ? `<p class="notice">${data.omittedTableRowCount} further run row(s) omitted by the bounded table.</p>` : ""}</section>
<section><div class="section-title"><h2>${htmlText(t("report.h2.trace-inspector"))}</h2><span class="badge" id="trace-id">${htmlText(t("report.select-run"))}</span></div><div class="trace" id="trace"><div class="trace-empty">${htmlText(t("report.choose-run"))}</div></div></section>
<section id="growth-section" hidden><div class="section-title"><h2>${htmlText(t("report.h2.growth"))}</h2><span class="badge" id="growth-status"></span></div><p class="notice" id="growth-chart"></p><div class="table-wrap"><table><thead><tr><th>${htmlText(t("report.th.version"))}</th><th>${htmlText(t("report.th.date"))}</th><th>${htmlText(t("report.th.revision"))}</th><th>${htmlText(t("report.th.development"))}</th><th>${htmlText(t("report.th.sealed"))}</th><th>${htmlText(t("report.th.cost"))}</th><th>${htmlText(t("report.th.resolved-modes"))}</th><th>${htmlText(t("report.th.reason"))}</th></tr></thead><tbody id="growth"></tbody></table></div></section>
<p class="notice" id="notice"></p>
</main></div>
<script>const DATA=${embeddedJson(data)};
const COMPARISON_ROWS=${embeddedJson(comparisonRowsHtml(data.comparison))};
const q=(s)=>document.querySelector(s), esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const e=DATA.evalRun,d=DATA.diagnosis,b=DATA.improvementBrief;q('#title').textContent=e.target.id;q('#subtitle').textContent=e.evalRunId+' · '+e.label+' · '+e.startedAt;q('#revision').textContent=e.target.gitSha.slice(0,12);q('#status-badge').textContent=b.status;q('#failure-mode-status').textContent=b.summary.failureModeCount+' modes'+(b.summary.omittedFailureModeCount?' · '+b.summary.omittedFailureModeCount+' omitted':'');q('#diagnosis-status').textContent=d.summary.issueCount+' issues'+(DATA.projection.diagnosis.issues.omittedCount?' · '+DATA.projection.diagnosis.issues.omittedCount+' omitted':'');q('#brief-headline').textContent=b.headline;q('#proposal-gate').textContent=b.proposalEligible?'Proposal gate: eligible for an exact human-reviewed harness proposal.':'Proposal gate: blocked. Mode-level suggestions are diagnostic guidance only until the global evidence gate is satisfied.';q('#notice').textContent=DATA.redactionNotice;
q('#stats').innerHTML=[[${embeddedJson(t("report.stat.pass-rate"))},${embeddedJson(percent(data.evalRun.summary.allPassRate))}],[${embeddedJson(t("report.stat.passed"))},e.summary.pass+'/'+e.summary.total],[${embeddedJson(t("report.stat.errors"))},e.summary.error],[${embeddedJson(t("report.stat.failure-modes"))},b.summary.failureModeCount]].map(([l,v])=>'<div class="stat"><strong>'+esc(v)+'</strong><span>'+esc(l)+'</span></div>').join('');
const includedRunIds=new Set(DATA.runs.map(r=>r.runId));
const evidenceRow=(item,label)=>'<li><strong>'+esc(label)+'</strong> · '+esc(item.taskId)+(item.graderNames.length?' · graders: '+item.graderNames.map(esc).join(', '):'')+(item.traceAvailable&&includedRunIds.has(item.runId)?' <button class="trace-link" data-run="'+esc(item.runId)+'">Open trace</button>':'')+'</li>';
const modeCards=b.modes.map(m=>{
	const impact=esc(m.impact.affectedTasks)+'/'+esc(m.impact.totalTasks)+' tasks · '+esc(m.impact.failedOccurrences)+' failed occurrences · '+esc(Math.round(m.impact.reproductionBps)/100)+'% reproduction';
	const notes=m.evidenceNotes.length?'<p><strong>Evidence notes.</strong> '+m.evidenceNotes.map(esc).join(' · ')+'</p>':'';
	const decision=!b.proposalEligible&&m.decision==='propose-harness-change'?m.decision+' · blocked by global gate':m.decision;
	const evidenceRows=m.evidence.map(item=>evidenceRow(item,'failure')).join('');
	const counterRows=m.counterEvidence.map(item=>evidenceRow(item,'counter')).join('');
	const omitted=m.omittedEvidenceCount?'<p class="sub">'+esc(m.omittedEvidenceCount)+' additional evidence row(s) omitted by the bounded brief.</p>':'';
	return '<article class="issue"><div class="issue-head"><div><h3>'+esc(m.title)+'</h3><div class="mode-meta"><span class="pill">'+esc(m.scope)+'</span><span class="pill '+(m.severity==='blocking'?'blocking':'')+'">'+esc(m.severity)+'</span><span class="pill">'+esc(m.evidenceStrength)+' evidence</span></div></div><span class="pill">'+esc(decision)+'</span></div><p>'+esc(m.summary)+'</p><p class="hypothesis"><strong>Evidence-backed hypothesis, not proof.</strong> '+esc(m.hypothesis)+'</p><div class="mode-impact"><span class="pill">'+impact+'</span><span class="pill">'+esc(m.counterEvidence.length)+' counter-evidence runs</span></div><ul>'+m.suggestions.map(s=>'<li>'+esc(s)+'</li>').join('')+'</ul>'+notes+'<div class="mode-evidence"><div><strong>Projected evidence</strong><ul class="evidence-list">'+evidenceRows+counterRows+'</ul>'+omitted+'</div></div></article>';
});
q('#failure-modes').innerHTML=modeCards.length?modeCards.join(''):'<article class="issue"><h3>No actionable failure modes</h3><p>The verified diagnosis does not support a harness change.</p></article>';
q('#issues').innerHTML=d.issues.length?d.issues.map(i=>'<article class="issue"><div class="issue-head"><div><h3>'+esc(i.taskId)+' · '+esc(i.category)+'</h3><span class="pill '+esc(i.severity)+'">'+esc(i.confidence)+' confidence</span></div><span class="pill '+esc(i.severity)+'">'+esc(i.severity)+'</span></div><p>'+esc(i.rootCause)+'</p><ul>'+i.suggestions.map(s=>'<li>'+esc(s)+'</li>').join('')+'</ul></article>').join(''):'<article class="issue"><h3>No actionable failures</h3><p>All recorded tasks completed and passed.</p></article>';
const judgeUnsure=DATA.judgeAbstained?${embeddedJson(t("judge.abstained", { count: "{count}" }))}.replace('{count}',String(DATA.judgeAbstained)):'';
if(DATA.judgeCalibration.length||judgeUnsure){q('#judge-calibration').hidden=false;q('#judge-calibration').textContent=[DATA.judgeCalibration.map(c=>c.line+' — '+c.graderNames.join(', ')).join(' · '),judgeUnsure].filter(Boolean).join(' · ')}
q('#run-nav').innerHTML=DATA.runs.map(r=>'<button class="run-link" data-run="'+esc(r.runId)+'"><span class="dot '+(r.outcome==='pass'?'pass':'')+'"></span>'+esc(r.taskId)+' · '+r.repetitionIndex+'</button>').join('');
if(DATA.comparison&&DATA.comparison.status==='comparable'){const c=DATA.comparison;q('#comparison-section').hidden=false;q('#comparison-verdict').textContent=c.gate.surface+' '+c.gate.verdict;q('#comparison-gate').textContent=DATA.comparisonGateLine;q('#comparison').innerHTML=COMPARISON_ROWS}
	function runIdFromHash(){try{return new URLSearchParams(window.location.hash.slice(1)).get('run')}catch{return null}}
	function showRun(id,scroll=true,syncHash=true){if(typeof id!=='string')return false;const r=DATA.runs.find(x=>x.runId===id);if(!r)return false;document.querySelectorAll('[data-run]').forEach(n=>n.classList.toggle('active',n instanceof HTMLElement&&n.dataset.run===id));q('#trace-id').textContent=r.runId;const traceOmission=r.traceProjection&&r.traceProjection.omittedCount?'<div class="message"><div class="message-label">Projection</div><p class="sub">'+esc(r.traceProjection.omittedCount)+' trace message(s) omitted.</p></div>':(!r.traceProjection&&DATA.projection.truncatedTraceRunIds.includes(id)?'<div class="message"><div class="message-label">Projection</div><p class="sub">Trace omitted after a global projection budget was exhausted.</p></div>':'');const grader='<div class="message"><div class="message-label">Graders</div>'+r.graders.map(g=>'<div class="tool '+(g.passed?'':'error')+'"><strong>'+esc(g.passed?'PASS':'FAIL')+' · '+esc(g.name)+'</strong><pre>'+esc(g.reason)+'</pre></div>').join('')+(r.graderProjection.omittedCount?'<p class="sub">'+esc(r.graderProjection.omittedCount)+' grader(s) omitted.</p>':'')+'</div>';const ex=DATA.explanations.find(x=>x.runId===id);const why=ex?'<div class="message"><div class="message-label">Why</div>'+ex.sentences.map(s=>'<p class="sub">'+esc(s)+'</p>').join('')+'</div>':'';q('#trace').innerHTML=why+(r.error?'<div class="message"><div class="message-label">Run error</div><pre>'+esc(r.error)+'</pre></div>':'')+r.trace.map(m=>'<div class="message"><div class="message-label">'+esc(m.role)+'</div>'+(m.text?'<pre>'+esc(m.text)+'</pre>':'')+m.toolCalls.map(t=>'<div class="tool"><strong>call · '+esc(t.name)+'</strong><pre>'+esc(t.arguments)+'</pre></div>').join('')+(m.omittedToolCallCount?'<p class="sub">'+esc(m.omittedToolCallCount)+' tool call(s) omitted.</p>':'')+(m.toolResult?'<div class="tool '+(m.toolResult.isError?'error':'')+'"><strong>result · '+esc(m.toolResult.name)+'</strong><pre>'+esc(m.toolResult.text)+'</pre></div>':'')+'</div>').join('')+traceOmission+grader;if(syncHash){const params=new URLSearchParams(window.location.hash.slice(1));params.set('run',id);const next='#'+params.toString();if(window.location.hash!==next)window.location.hash=next}if(scroll)q('#trace').scrollIntoView({behavior:'smooth',block:'start'});return true}
document.addEventListener('click',ev=>{const target=ev.target;const node=target instanceof Element?target.closest('[data-run]'):null;if(node instanceof HTMLElement)showRun(node.dataset.run)});
window.addEventListener('hashchange',()=>{const id=runIdFromHash();if(id)showRun(id,false,false)});
	const requestedRunId=runIdFromHash();if(!(requestedRunId&&showRun(requestedRunId,false,false))&&DATA.runs.length)showRun(DATA.runs[0].runId,false,false);
${RUNS_TABLE_FILTER_SCRIPT}
// Growth: the same bounded projection \`ahde log\` prints. Promotions in full,
// rejections dimmed between them, and a sealed cell that is a verdict and a
// size and nothing else.
const GROWTH_SPARKLINE=${embeddedJson(data.agentLog ? sparkline(data.agentLog.versions.map((version) => version.score)) : "")};
const GROWTH_ROWS=${embeddedJson(growthRowsHtml(data.agentLog))};
if(DATA.agentLog&&DATA.agentLog.rows.length){const g=DATA.agentLog;const versions=g.rows.filter(r=>r.outcome==='promoted').length;
	q('#growth-section').hidden=false;
	q('#growth-status').textContent=versions+' version'+(versions===1?'':'s')+' · '+g.rows.length+' decided attempt'+(g.rows.length===1?'':'s')+(g.omitted?' · '+g.omitted+' earlier omitted':'');
	q('#growth-chart').textContent='score '+GROWTH_SPARKLINE+' · '+(g.cumulativeCostUsd===null?'—':'$'+g.cumulativeCostUsd.toFixed(2))+' cumulative over '+g.rows.length+' attempt'+(g.rows.length===1?'':'s');
	q('#growth').innerHTML=GROWTH_ROWS}
</script></body></html>`;
	if (Buffer.byteLength(html, "utf8") > MAX_REPORT_HTML_BYTES) {
		throw new Error(`rendered report exceeds the ${MAX_REPORT_HTML_BYTES}-byte safety limit`);
	}
	return html;
}

export function reportPath(runsRoot: string, evalRunId: string): string {
	return resolveContainedArtifactPath(runsRoot, evalRunId, "report.html");
}

export function buildEvalReport(
	runsRoot: string,
	evalRunId: string,
	outPath?: string,
	labels?: { stateRoot: string; projectId: string },
): { path: string; judgeCalibration: ReportJudgeCalibration[] } {
	const data = collectEvalReportData(runsRoot, evalRunId, undefined, labels ? { labels } : {});
	const outputPath = outPath === undefined ? reportPath(runsRoot, evalRunId) : resolve(outPath);
	writeTextArtifact(outputPath, renderEvalReportHtml(data));
	return { path: outputPath, judgeCalibration: data.judgeCalibration };
}
