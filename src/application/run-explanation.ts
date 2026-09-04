import { noun, plural, t, tokenLabel, type MessageKey, type MessageParams } from "../i18n.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { z } from "zod";
import type { TraceObservation } from "../diagnosis.js";
import { runCost, runTokens, runGraderScore } from "../compare.js";
import type { GraderResult, RunRecord } from "../provenance.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";
import type { VerifiedRunArtifacts } from "../run-evidence.js";
import {
	lastAssistantText,
	openTrace,
	redactTraceText,
	traceToolCalls,
	type TraceMessage,
} from "../trace.js";
import { publicTaskId, type FailureMode, type ImprovementBrief } from "./improvement-brief.js";
import {
	infrastructureClassOf,
	runErrorCause,
	runErrorReading,
	type RunErrorReading,
} from "./run-error.js";

export {
	classifyRunError,
	infrastructureClassOf,
	runErrorCause,
	runErrorReading,
	type RunErrorClass,
	type RunErrorReading,
} from "./run-error.js";

/**
 * The host's own words about one run, and the table projection of an eval.
 *
 * This module is pure projection: artifacts in, structured findings and plain
 * lines out, no HTML and no I/O beyond reading artifacts that already exist.
 * The web Evidence Explorer renders it, the static report embeds it, and the
 * Builder TUI prints the same lines — three surfaces that cannot word the same
 * evidence differently because there is only one wording.
 *
 * Everything is derived deterministically from the verified RunRecord, the
 * bounded/redacted trace projection produced by `trace.ts`, the Improvement
 * Brief compiled from the stored diagnosis, and — only when it corroborates the
 * record — the judge's verdict sidecar. Nothing is asked of a model. A grader
 * phrasing this module does not recognize yields no expectation at all and its
 * reason is quoted verbatim: guessing is the one thing this surface may not do.
 */

/** Characters of a case input shown in a table cell. */
export const MAX_INPUT_PREVIEW_CHARS = 80;
/** Characters of a case input shown on a run detail page. */
export const MAX_INPUT_CHARS = 2_000;
/** Characters of the agent's final answer shown on a run detail page. */
export const MAX_ANSWER_CHARS = 8_000;
/** Distinct tasks whose input is resolved from a trace for one page. */
export const MAX_INPUT_PREVIEW_TASKS = 500;
/** Characters of a quoted reply shown beside a failure mode. */
const MAX_EXCERPT_REPLY_CHARS = 240;
/** Characters of a tool name shown inside a failure mode's title. */
const MAX_NAMED_SUBJECT_CHARS = 100;
/** Tool names named in one explanation. */
const MAX_NAMED_TOOLS = 6;
/** Characters of any single quoted fragment inside an explanation. */
const MAX_QUOTE_CHARS = 200;
/** Judge assertions projected from a verdict sidecar. */
const MAX_ASSERTIONS = 64;

export type RunOutcome = "pass" | "fail" | "error";

/**
 * Partial credit for one run: the mean of its grader scores, clamped to [0,1].
 * Deliberately the same rule `compare.ts` scores a task with, so the table and
 * the comparison gate cannot disagree about what a run was worth.
 */
export function runScore(record: Pick<RunRecord, "evalResults">): number {
	return runGraderScore(record);
}

export function runOutcome(record: Pick<RunRecord, "status" | "evalResults">): RunOutcome {
	if (record.status !== "completed") return "error";
	return record.evalResults?.outcome === "pass" ? "pass" : "fail";
}

function quote(value: string, maxChars = MAX_QUOTE_CHARS): string {
	const redacted = redactTraceText(value).replace(/\s+/gu, " ").trim();
	return redacted.length <= maxChars ? redacted : `${redacted.slice(0, maxChars - 1)}…`;
}

// ---------- Judge verdict sidecar ----------

const AssertionAnswerSchema = z.enum(["yes", "no", "unknown"]);
export type AssertionAnswer = z.infer<typeof AssertionAnswerSchema>;

const JudgeVerdictSidecarSchema = z.object({
	choice: z.string().min(1).max(8).optional(),
	passed: z.boolean(),
	score: z.number().finite(),
	assertions: z
		.array(z.object({
			index: z.number().int().positive().max(MAX_ASSERTIONS),
			answer: AssertionAnswerSchema,
			evidence: z.string(),
		}))
		.max(MAX_ASSERTIONS)
		.optional(),
	jury: z
		.array(z.object({
			juror: z.number().int().positive().max(MAX_ASSERTIONS),
			passed: z.boolean(),
			choice: z.string().min(1).max(8).optional(),
			answers: z.array(AssertionAnswerSchema).max(MAX_ASSERTIONS).optional(),
		}))
		.max(MAX_ASSERTIONS)
		.optional(),
});

export interface AssertionVerdict {
	index: number;
	answer: AssertionAnswer;
	/** The judge's own quoted justification for this assertion. */
	evidence: string;
}

export interface JuryVote {
	juror: number;
	passed: boolean;
	choice: string | null;
	answers: AssertionAnswer[] | null;
}

export interface JudgeVerdict {
	choice: string | null;
	assertions: AssertionVerdict[];
	jury: JuryVote[];
}

/**
 * The judge's own per-assertion answers, read only when they corroborate the
 * verified RunRecord.
 *
 * The sidecar is display evidence written beside the exchange that produced it;
 * `run.json` is the record that decided the grade. Where the two disagree about
 * which assertions failed, the sidecar is dropped entirely rather than shown —
 * a screen that contradicts the graded record is worse than one that says
 * nothing.
 */
export function readJudgeVerdict(
	artifact: Record<string, unknown> | undefined,
	grader: Pick<GraderResult, "assertions" | "passed">,
): JudgeVerdict | null {
	if (!artifact) return null;
	let parsed: z.infer<typeof JudgeVerdictSidecarSchema>;
	try {
		parsed = JudgeVerdictSidecarSchema.parse(artifact);
	} catch {
		return null;
	}
	if (parsed.passed !== grader.passed) return null;
	const assertions = parsed.assertions ?? [];
	if (grader.assertions) {
		if (assertions.length !== grader.assertions.total) return null;
		const failed = assertions.filter((assertion) => assertion.answer !== "yes").map((assertion) => assertion.index);
		if (JSON.stringify(failed) !== JSON.stringify(grader.assertions.failed)) return null;
	} else if (assertions.length > 0) {
		return null;
	}
	return {
		choice: parsed.choice ?? null,
		assertions: assertions.map((assertion) => ({
			index: assertion.index,
			answer: assertion.answer,
			evidence: quote(assertion.evidence),
		})),
		jury: (parsed.jury ?? []).map((vote) => ({
			juror: vote.juror,
			passed: vote.passed,
			choice: vote.choice ?? null,
			answers: vote.answers ?? null,
		})),
	};
}

/**
 * Grader results in these runs whose judge declined to decide. Counted apart
 * from the pass/fail tally they are already inside: an abstention fails the
 * check, and reading it as the agent's failure is the mistake it exists to
 * prevent.
 */
export function judgeAbstentions(runs: readonly Pick<RunRecord, "evalResults">[]): number {
	return runs.reduce(
		(total, run) => total + (run.evalResults?.graders ?? []).filter((grader) => grader.abstained === true).length,
		0,
	);
}

// ---------- Verdict: one row per grader ----------

export interface GraderFinding {
	name: string;
	type: string;
	checkCode: string | null;
	passed: boolean;
	score: number;
	/** The grader's own recorded reason. */
	reason: string;
	/** The judge said it could not tell. Always paired with `passed: false`. */
	abstained: boolean;
	/** Assertion tally recorded in the RunRecord, when the rubric had assertions. */
	assertions: { total: number; passed: number; failed: number[] } | null;
	/** Per-assertion answers with the judge's evidence, when the sidecar agrees. */
	assertionVerdicts: AssertionVerdict[] | null;
	/** A–E factuality choice, when the reference protocol decided this grader. */
	choice: string | null;
	/** Independent juror votes, when a jury decided this grader. */
	jury: JuryVote[] | null;
	/** `3/4` for an assertion rubric, `✓`/`✗` otherwise. Text, never colour alone. */
	chip: string;
}

function assertionChip(assertions: { total: number; passed: number }): string {
	return `${assertions.passed}/${assertions.total}`;
}

/** Every grader of one run, with the judge detail its evidence supports. */
export function graderFindings(
	run: Pick<RunRecord, "runId" | "evalResults">,
	options: {
		includeJudgeVerdicts?: boolean;
		/** Values previously verified by the Run evidence module. */
		judgeArtifacts?: Readonly<Record<string, Record<string, unknown>>>;
	} = {},
): GraderFinding[] {
	const graders = run.evalResults?.graders ?? [];
	return graders.map((grader, index): GraderFinding => {
		const assertions = grader.assertions
			? {
				total: grader.assertions.total,
				passed: grader.assertions.total - grader.assertions.failed.length,
				failed: [...grader.assertions.failed],
			}
			: null;
		const verdict = options.includeJudgeVerdicts === true && grader.type === "judge"
			? readJudgeVerdict(options.judgeArtifacts?.[String(index)], grader)
			: null;
		return {
			name: quote(grader.name, 200),
			type: quote(grader.type, 100),
			checkCode: grader.checkCode ?? null,
			passed: grader.passed,
			score: grader.score,
			reason: quote(grader.reason, 1_000),
			abstained: grader.abstained === true,
			assertions,
			assertionVerdicts: verdict && verdict.assertions.length > 0 ? verdict.assertions : null,
			choice: verdict?.choice ?? null,
			jury: verdict && verdict.jury.length > 1 ? verdict.jury : null,
			chip: assertions ? assertionChip(assertions) : grader.passed ? "✓" : "✗",
		};
	});
}

// ---------- Case input, answer, tools ----------

export interface RunTraceFacts {
	/** The case input: the trace's first user message, bounded and redacted. */
	input: string | null;
	/** The agent's final answer: the last assistant message that carried text. */
	answer: string | null;
	/** Distinct tool names the agent called, in first-call order. */
	toolNames: string[];
	/** Total tool calls recorded in the trace. */
	toolCalls: number;
}

export function traceFacts(messages: readonly TraceMessage[]): RunTraceFacts {
	const firstUser = messages.find((message) => message.role === "user" && message.text.trim().length > 0);
	const calls = traceToolCalls([...messages]);
	const names: string[] = [];
	for (const call of calls) {
		const name = quote(call.name, 100);
		if (name && !names.includes(name)) names.push(name);
	}
	const answer = lastAssistantText([...messages]);
	return {
		input: firstUser ? quote(firstUser.text, MAX_INPUT_CHARS) : null,
		answer: answer === undefined ? null : quote(answer, MAX_ANSWER_CHARS),
		toolNames: names,
		toolCalls: calls.length,
	};
}

// ---------- The run's receipt ----------

/**
 * What this run was actually given and what it actually spent.
 *
 * Session 7 read `world: null · judge: null · simulatedUser: null` and no
 * `usage` key at all off a run.json whose case HAD a world the tool answered
 * from — three absent keys read as three absent things. They are four
 * different statements and the receipt makes each of them: a world that was
 * there, an instrument that never ran because the run died before grading, and
 * a spend nobody reported (which is not the same as a spend of zero).
 */
export interface RunReceipt {
	/** Top-level keys of the world file this run kept; null when it had none. */
	worldKeys: number | null;
	judge: { calls: number; costUsd: number } | null;
	simulatedUser: { calls: number; costUsd: number } | null;
	/** Target tokens, when the backend reported any. */
	tokens: number | null;
	costUsd: number | null;
	/** The run ended before grading, so an absent instrument never got to run. */
	incomplete: boolean;
}

/**
 * The receipt of one run. The world is read from the run's own state file —
 * the same bounded, validated reader grading uses — and its KEYS are counted,
 * never its values: a receipt says a world was there, not what was in it.
 */
export function runReceipt(
	run: Pick<RunRecord, "runId" | "status" | "metrics">,
	artifacts: Pick<VerifiedRunArtifacts, "world"> | undefined,
): RunReceipt {
	const worldKeys = artifacts?.world === null || artifacts?.world === undefined
		? null
		: Object.keys(artifacts.world).length;
	const judge = run.metrics.judge;
	const user = run.metrics.simulatedUser;
	return {
		worldKeys,
		judge: judge ? { calls: judge.calls, costUsd: judge.costUsd } : null,
		simulatedUser: user ? { calls: user.calls, costUsd: user.costUsd } : null,
		tokens: runTokens(run)?.total ?? null,
		costUsd: runCost(run),
		incomplete: run.status !== "completed",
	};
}

/** Open one run's protected trace through the single canonical parser. */
export function openRunTrace(runsRoot: string, run: RunRecord): TraceMessage[] | null {
	if (!run.trace.sha256) return null;
	try {
		const artifact = resolveContainedArtifactPath(runsRoot, run.runId, run.trace.path);
		return openTrace(dirname(artifact), basename(artifact), run.trace.sha256);
	} catch {
		return null;
	}
}

/**
 * One input preview per task, resolved from the first readable trace of that
 * task. Repetitions of a case share one input by construction, so the number of
 * traces opened is the number of tasks, not the number of runs — and that count
 * is bounded too.
 */
export function taskInputPreviews(
	runsRoot: string,
	runs: readonly RunRecord[],
	limit = MAX_INPUT_PREVIEW_TASKS,
): Map<string, string> {
	const previews = new Map<string, string>();
	for (const run of runs) {
		if (previews.size >= limit) break;
		if (previews.has(run.taskId)) continue;
		const messages = openRunTrace(runsRoot, run);
		if (!messages) continue;
		const input = traceFacts(messages).input;
		if (input !== null) previews.set(run.taskId, input);
	}
	return previews;
}

// ---------- Transcript ----------

/** Entries kept in one rendered transcript. */
export const MAX_TRANSCRIPT_ENTRIES = 400;
/** Characters kept per spoken turn. */
export const MAX_TRANSCRIPT_TEXT_CHARS = 20_000;
/** Characters kept per tool-call argument blob. */
export const MAX_TOOL_ARGUMENT_CHARS = 4_000;
/** Characters kept per tool result excerpt. */
export const MAX_TOOL_RESULT_CHARS = 4_000;
/** Characters kept across one whole transcript. */
export const MAX_TRANSCRIPT_BUDGET_CHARS = 200_000;

export type TranscriptEntry =
	| { kind: "user"; text: string; at: number | null }
	| { kind: "assistant"; text: string; thinking: string | null; at: number | null; final: boolean }
	| {
		kind: "tool";
		evidence?: "reported";
		name: string;
		args: string;
		result: string | null;
		isError: boolean;
		durationMs: number | null;
		at: number | null;
		resultTruncated: boolean;
	};

export interface Transcript {
	entries: TranscriptEntry[];
	/** True when any bound clipped text or dropped an entry. */
	truncated: boolean;
	omittedCount: number;
}

function bounded(value: string, maxChars: number, budget: { remaining: number }): { text: string; clipped: boolean } {
	const redacted = redactTraceText(value);
	const limit = Math.max(0, Math.min(maxChars, budget.remaining));
	const text = redacted.slice(0, limit);
	budget.remaining -= text.length;
	return { text, clipped: text.length < redacted.length };
}

/**
 * The conversation as it happened: spoken turns, and one card per tool call
 * carrying the result that answered it. Bounded and credential-redacted like
 * every other projection of a protected trace.
 */
export function runTranscript(messages: readonly TraceMessage[]): Transcript {
	const budget = { remaining: MAX_TRANSCRIPT_BUDGET_CHARS };
	const resultsByCallId = new Map<string, { text: string; isError: boolean; at: number | null }>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolResult) {
			resultsByCallId.set(message.toolResult.toolCallId, {
				text: message.toolResult.text,
				isError: message.toolResult.isError,
				at: message.timestamp ?? null,
			});
		}
	}
	const lastAssistantWithText = (() => {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role === "assistant" && message.text.trim().length > 0) return index;
		}
		return -1;
	})();

	const entries: TranscriptEntry[] = [];
	let truncated = false;
	let consumed = 0;
	for (const [index, message] of messages.entries()) {
		if (entries.length >= MAX_TRANSCRIPT_ENTRIES || budget.remaining <= 0) {
			truncated = true;
			break;
		}
		consumed = index + 1;
		if (message.role === "toolResult") continue;
		if (message.role === "user") {
			if (message.text.trim().length === 0) continue;
			const text = bounded(message.text, MAX_TRANSCRIPT_TEXT_CHARS, budget);
			truncated ||= text.clipped;
			entries.push({ kind: "user", text: text.text, at: message.timestamp ?? null });
			continue;
		}
		if (message.text.trim().length > 0 || message.thinking) {
			const text = bounded(message.text, MAX_TRANSCRIPT_TEXT_CHARS, budget);
			const thinking = message.thinking
				? bounded(message.thinking, MAX_TRANSCRIPT_TEXT_CHARS, budget)
				: null;
			truncated ||= text.clipped || (thinking?.clipped ?? false);
			entries.push({
				kind: "assistant",
				text: text.text,
				thinking: thinking && thinking.text.trim().length > 0 ? thinking.text : null,
				at: message.timestamp ?? null,
				final: index === lastAssistantWithText,
			});
		}
		for (const call of message.toolCalls ?? []) {
			if (entries.length >= MAX_TRANSCRIPT_ENTRIES || budget.remaining <= 0) {
				truncated = true;
				break;
			}
			const name = bounded(call.name, 200, budget);
			const args = bounded(JSON.stringify(call.arguments, null, "\t") ?? "", MAX_TOOL_ARGUMENT_CHARS, budget);
			const answered = resultsByCallId.get(call.id);
			const result = answered ? bounded(answered.text, MAX_TOOL_RESULT_CHARS, budget) : null;
			truncated ||= name.clipped || args.clipped || (result?.clipped ?? false);
			entries.push({
				kind: "tool",
				...(call.evidence ? { evidence: call.evidence } : {}),
				name: name.text,
				args: args.text,
				result: result ? result.text : null,
				isError: answered?.isError ?? false,
				durationMs: answered && answered.at !== null && message.timestamp !== undefined
					? Math.max(0, answered.at - message.timestamp)
					: null,
				at: message.timestamp ?? null,
				resultTruncated: result?.clipped ?? false,
			});
		}
	}
	return { entries, truncated, omittedCount: Math.max(0, messages.length - consumed) };
}

// ---------- Runs table ----------

export interface RunRow {
	runId: string;
	taskId: string;
	repetitionIndex: number;
	outcome: RunOutcome;
	/** Mean grader score in [0,1]; the same number the comparison gate scores with. */
	score: number;
	/** First characters of the case input, or null when no trace could be read. */
	inputPreview: string | null;
	graders: Array<{ type: string; passed: boolean; chip: string; name: string }>;
	/** Failure modes of this eval's brief whose evidence names this run. */
	failureModeIds: string[];
	error: string | null;
	metrics: {
		latencyMs: number;
		toolCalls: number;
		reportedToolCalls: number;
		toolErrors: number;
		tokens: number | null;
		costUsd: number | null;
	};
	traceAvailable: boolean;
}

/** Failure-mode ids by run id, from the brief's evidence lists. */
export function failureModesByRun(brief: ImprovementBrief): Map<string, string[]> {
	const byRun = new Map<string, string[]>();
	for (const mode of brief.modes) {
		for (const evidence of mode.evidence) {
			const bucket = byRun.get(evidence.runId) ?? [];
			if (!bucket.includes(mode.failureModeId)) bucket.push(mode.failureModeId);
			byRun.set(evidence.runId, bucket);
		}
	}
	return byRun;
}

/** Errors first, then failures, then passes; inside each group by task and repetition. */
export function compareRunRows(left: RunRow, right: RunRow): number {
	const rank = (row: RunRow): number => (row.outcome === "error" ? 0 : row.outcome === "fail" ? 1 : 2);
	if (rank(left) !== rank(right)) return rank(left) - rank(right);
	if (left.taskId !== right.taskId) return left.taskId < right.taskId ? -1 : 1;
	if (left.repetitionIndex !== right.repetitionIndex) return left.repetitionIndex - right.repetitionIndex;
	return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0;
}

/**
 * One row per case × repetition, failures first. The HTML table and a terminal
 * table both consume exactly this; neither may compute a cell of its own.
 */
export function runsTable(
	runsRoot: string,
	runs: readonly RunRecord[],
	brief: ImprovementBrief | null,
	options: { inputPreviews?: Map<string, string> } = {},
): RunRow[] {
	const previews = options.inputPreviews ?? taskInputPreviews(runsRoot, runs);
	const modes = brief ? failureModesByRun(brief) : new Map<string, string[]>();
	const rows = runs.map((run): RunRow => {
		const preview = previews.get(run.taskId);
		return {
			runId: run.runId,
			taskId: publicTaskId(run.taskId),
			repetitionIndex: run.repetitionIndex,
			outcome: runOutcome(run),
			score: runScore(run),
			inputPreview: preview === undefined
				? null
				: preview.length <= MAX_INPUT_PREVIEW_CHARS
					? preview
					: `${preview.slice(0, MAX_INPUT_PREVIEW_CHARS - 1)}…`,
			graders: (run.evalResults?.graders ?? []).map((grader) => ({
				type: quote(grader.type, 100),
				passed: grader.passed,
				chip: grader.assertions
					? assertionChip({
						total: grader.assertions.total,
						passed: grader.assertions.total - grader.assertions.failed.length,
					})
					: grader.passed ? "✓" : "✗",
				name: quote(grader.name, 200),
			})),
			failureModeIds: modes.get(run.runId) ?? [],
			error: run.error === null ? null : quote(run.error, 500),
			metrics: {
				latencyMs: run.metrics.latencyMs,
				toolCalls: run.metrics.toolCalls,
				reportedToolCalls: run.metrics.reportedToolCalls ?? 0,
				toolErrors: run.metrics.toolErrors,
				tokens: runTokens(run)?.total ?? null,
				costUsd: runCost(run),
			},
			traceAvailable: run.trace.sha256 !== null,
		};
	});
	return rows.sort(compareRunRows);
}

// ---------- The "Why" ----------

/**
 * What one grader wanted and what the record shows instead.
 *
 * The expectation is recovered from the exact reason strings this repository's
 * graders emit, keyed by the typed `checkCode` that named the check, and said
 * in the operator's language. An unrecognized phrasing yields a null
 * expectation and the reason is quoted as-is.
 */
export interface GraderExplanation {
	graderName: string;
	graderType: string;
	/** «ожидался вызов bash с аргументами, содержащими «check_dbo»» */
	expected: string | null;
	/** «агент не вызвал ни одного инструмента и ответил сразу» */
	actual: string;
	/** The grader's own recorded reason, always shown. */
	reason: string;
	/** The judge declined to decide this check rather than deciding it wrongly. */
	abstained: boolean;
	/** Judge assertions that did not hold, with the judge's evidence. */
	assertions: AssertionVerdict[];
	/** Juror votes, when a jury decided this grader. */
	jury: JuryVote[] | null;
}

/**
 * One clause of an explanation before it is said: the key that words it, and
 * the machine values it interpolates.
 *
 * The clause is built as a key rather than as a sentence because the same
 * evidence is read by an operator in Russian and by a script in English, and a
 * literal here would have made the first of those impossible. Everything
 * inside `params` — a tool name, a path, a rounded score, a bent noun — is
 * either machine text or already localized.
 */
interface Phrase {
	key: MessageKey;
	params?: MessageParams;
}

function say(phrase: Phrase): string {
	return t(phrase.key, phrase.params);
}

function toolActual(facts: RunTraceFacts | null, recordedToolCalls: number): Phrase {
	const total = facts ? facts.toolCalls : recordedToolCalls;
	if (total === 0) return { key: "why.actual.required-tool-none" };
	const calls = plural(total, "tool call");
	const names = facts?.toolNames.slice(0, MAX_NAMED_TOOLS) ?? [];
	if (names.length === 0) return { key: "why.actual.required-tool-calls", params: { calls } };
	const listed = names.join(", ");
	const hidden = facts ? facts.toolNames.length - MAX_NAMED_TOOLS : 0;
	const tools = hidden > 0 ? t("why.actual.tool-more", { tools: listed, count: hidden }) : listed;
	return { key: "why.actual.required-tool-named", params: { calls, tools } };
}

type AnswerVerbKey = "why.actual.answer-lacks" | "why.actual.answer-unmatched" | "why.actual.answer-differs";

function answerActual(facts: RunTraceFacts | null, key: AnswerVerbKey): Phrase {
	const answer = !facts || facts.answer === null
		? t("why.answer.recorded")
		: t("why.answer.recorded-sized", { size: plural(facts.answer.length, "character") });
	return { key, params: { answer } };
}

/**
 * What one grader wanted and what the record shows instead, as keys.
 *
 * The grader's own `reason` is the record — canonical English, hashed into
 * proposals, quoted verbatim beside this — and these are the host's rebuilt
 * sentences about it, one pair per check code and per recognized phrasing of
 * that check's reason. A phrasing nothing here matches yields no expectation
 * at all and the reason stands alone: guessing is the one thing this surface
 * may not do.
 */
function graderExpectation(
	grader: GraderFinding,
	run: Pick<RunRecord, "status" | "error" | "metrics">,
	facts: RunTraceFacts | null,
): { expected: Phrase | null; actual: Phrase } {
	if (run.status !== "completed") {
		// Read from the recorded error, never from the trace: this grader saw
		// nothing at all, and the run's own stem is the only thing that knows why.
		const reading = runErrorReading(run.error);
		return {
			expected: null,
			actual: reading
				? { key: "why.actual.run-incomplete-cause", params: { cause: reading.sentence, detail: reading.detail } }
				: { key: "why.actual.run-incomplete" },
		};
	}
	const reason = grader.reason;
	const tool = /^never called (\S+)(?: with args containing "([\s\S]*)")?$/.exec(reason);
	if (grader.checkCode === "required-tool" && tool) {
		const argument = tool[2];
		return {
			expected: argument === undefined
				? { key: "why.expected.required-tool", params: { tool: tool[1] ?? "" } }
				: { key: "why.expected.required-tool-args", params: { tool: tool[1] ?? "", arguments: argument } },
			actual: toolActual(facts, run.metrics.toolCalls),
		};
	}
	if (grader.checkCode === "no-secret" && reason === "the answer contains a string shaped like a credential") {
		return { expected: { key: "why.expected.no-secret" }, actual: { key: "why.actual.no-secret" } };
	}
	const contains = /^output does not contain "([\s\S]*)"$/.exec(reason);
	if (grader.checkCode === "output-contains" && contains) {
		return {
			expected: { key: "why.expected.output-contains", params: { text: contains[1] ?? "" } },
			actual: answerActual(facts, "why.actual.answer-lacks"),
		};
	}
	const matches = /^output does not match \/([\s\S]*)\/$/.exec(reason);
	if (grader.checkCode === "output-matches" && matches) {
		return {
			expected: { key: "why.expected.output-matches", params: { pattern: matches[1] ?? "" } },
			actual: answerActual(facts, "why.actual.answer-unmatched"),
		};
	}
	if (grader.checkCode === "reference-exact" && reason.startsWith("output differs from the expected answer")) {
		return {
			expected: { key: "why.expected.reference-exact" },
			actual: answerActual(facts, "why.actual.answer-differs"),
		};
	}
	const similarity = /^(\S+) [=≤] ([0-9.]+).*below threshold ([0-9.]+)/.exec(reason);
	if (grader.checkCode === "reference-similarity" && similarity) {
		return {
			expected: {
				key: "why.expected.reference-similarity",
				params: { metric: similarity[1] ?? "", threshold: similarity[3] ?? "" },
			},
			actual: { key: "why.actual.reference-similarity", params: { value: similarity[2] ?? "" } },
		};
	}
	const turns = /^agent took (\d+) turn\(s\), over the budget of (\d+)$/.exec(reason);
	if (grader.checkCode === "turn-budget" && turns) {
		return {
			expected: { key: "why.expected.turn-budget", params: { turns: plural(Number(turns[2]), "agent turn") } },
			actual: { key: "why.actual.turn-budget", params: { turns: plural(Number(turns[1]), "agent turn") } },
		};
	}
	if (grader.checkCode === "world-state") {
		// A world check is about the state the conversation left behind, not about
		// what the agent said, so its `actual` never quotes the answer. The world's
		// own reason is neutral by construction — a path, an operator and a
		// canonical-JSON value — so the sentence is rebuilt around those three and
		// nothing of the English wording survives into the render.
		const unset = /^world at (\S+) is not set(?:, expected (equals|contains) ([\s\S]*))?$/.exec(reason);
		if (unset) {
			const operator = unset[2];
			return {
				expected: operator === undefined
					? { key: "why.expected.world-state", params: { path: unset[1] ?? "" } }
					: {
						key: operator === "equals" ? "why.expected.world-state-equals" : "why.expected.world-state-contains",
						params: { path: unset[1] ?? "", value: unset[3] ?? "" },
					},
				actual: { key: "why.actual.world-state-unset" },
			};
		}
		const unusable = /^world at (\S+) is ([\s\S]*), which cannot contain ([\s\S]*)$/.exec(reason);
		if (unusable) {
			return {
				expected: {
					key: "why.expected.world-state-contains",
					params: { path: unusable[1] ?? "", value: unusable[3] ?? "" },
				},
				actual: { key: "why.actual.world-state-uncontainable", params: { value: unusable[2] ?? "" } },
			};
		}
		const differs = /^world at (\S+) is ([\s\S]*), expected ([\s\S]*)$/.exec(reason);
		if (differs) {
			return {
				expected: {
					key: "why.expected.world-state-equals",
					params: { path: differs[1] ?? "", value: differs[3] ?? "" },
				},
				actual: { key: "why.actual.world-state-value", params: { value: differs[2] ?? "" } },
			};
		}
		const lacks = /^world at (\S+) does not contain ([\s\S]*)$/.exec(reason);
		if (lacks) {
			return {
				expected: {
					key: "why.expected.world-state-contains",
					params: { path: lacks[1] ?? "", value: lacks[2] ?? "" },
				},
				actual: { key: "why.actual.world-state-lacks" },
			};
		}
		if (reason === "case declares no world") {
			return {
				expected: { key: "why.expected.world-state-declared" },
				actual: { key: "why.actual.world-state-undeclared" },
			};
		}
	}
	const citation = /^the answer neither cites (\S+) nor overlaps it: token-f1 = ([0-9.]+), below threshold ([0-9.]+)$/
		.exec(reason);
	if (grader.checkCode === "cites-source" && citation) {
		return {
			expected: {
				key: "why.expected.cites-source",
				params: { source: citation[1] ?? "", threshold: citation[3] ?? "" },
			},
			actual: { key: "why.actual.cites-source", params: { overlap: citation[2] ?? "" } },
		};
	}
	if (reason === "case has no expected answer") {
		return {
			expected: { key: "why.expected.reference-missing" },
			actual: { key: "why.actual.reference-missing" },
		};
	}
	if (grader.checkCode === "semantic-rubric") {
		if (grader.assertions) {
			return {
				expected: {
					key: "why.expected.semantic-rubric-assertions",
					params: { total: grader.assertions.total },
				},
				actual: {
					key: "why.actual.semantic-rubric-assertions",
					params: {
						passed: grader.assertions.passed,
						total: grader.assertions.total,
						failed: grader.assertions.failed.join(", "),
					},
				},
			};
		}
		return {
			expected: { key: "why.expected.semantic-rubric" },
			actual: grader.choice
				? { key: "why.actual.semantic-rubric-choice", params: { choice: grader.choice } }
				: { key: "why.actual.semantic-rubric" },
		};
	}
	return { expected: null, actual: { key: "why.actual.reason", params: { reason } } };
}

function explainGrader(
	grader: GraderFinding,
	run: Pick<RunRecord, "status" | "error" | "metrics">,
	facts: RunTraceFacts | null,
): GraderExplanation {
	const { expected, actual } = graderExpectation(grader, run, facts);
	return {
		graderName: grader.name,
		graderType: grader.type,
		reason: grader.reason,
		abstained: grader.abstained,
		assertions: (grader.assertionVerdicts ?? []).filter((assertion) => assertion.answer !== "yes"),
		jury: grader.jury,
		expected: expected === null ? null : say(expected),
		actual: say(actual),
	};
}

/** The English canonical title of a check, said in the operator's language. */
const CHECK_TITLE_KEY: Record<NonNullable<FailureMode["signature"]["checkCode"]>, MessageKey> = {
	"required-tool": "mode.title.required-tool",
	"output-contains": "mode.title.output-contract",
	"output-matches": "mode.title.output-contract",
	"reference-exact": "mode.title.reference-exact",
	"no-secret": "mode.title.no-secret",
	"semantic-rubric": "mode.title.semantic-rubric",
	"reference-similarity": "mode.title.reference-similarity",
	"turn-budget": "mode.title.turn-budget",
	"world-state": "mode.title.world-state",
	"final-answer": "mode.title.final-answer",
	"cites-source": "mode.title.cites-source",
};

const OBSERVATION_KEY: Record<TraceObservation, MessageKey> = {
	"no-tool-call": "mode.fact.no-tool-call",
	"tool-call-as-text": "mode.fact.tool-call-as-text",
	"asks-a-question": "mode.fact.asks-a-question",
	"mixed-script": "mode.fact.mixed-script",
	"empty-reply": "mode.fact.empty-reply",
};

/** What the host says about a mode: the same structure, in either language. */
export interface FailureModeReading {
	title: string;
	facts: string;
}

/**
 * The screen-facing reading of one failure mode.
 *
 * The artifact carries canonical English — it is hashed into proposals — so
 * the title and the fact sentence are rebuilt here from the mode's structure:
 * the check, its subject, and the counted trace observations behind it. Both
 * languages therefore say the same countable thing, and neither invents a
 * cause the evidence did not show.
 */
export function failureModeReading(
	mode: Pick<FailureMode, "signature" | "scope" | "observations" | "observedRuns" | "impact" | "abstained">,
): FailureModeReading {
	const signature = mode.signature;
	// An unsure judge is its own reading: the family, the counts and the mode id
	// are unchanged, but nothing here is a thing the agent did.
	if (mode.abstained === true) {
		return {
			title: t("mode.title.judge-abstained"),
			facts: t("mode.fact.judge-abstained", { failed: mode.impact.failedOccurrences }),
		};
	}
	// An infrastructure mode is one CAUSE, and its cause is the typed class of
	// the error its runs recorded — carried on the signature, never re-derived
	// from a trace. A mode with no class is evidence written before this lane.
	if (signature.kind === "infrastructure-error") {
		const code = infrastructureClassOf(signature.subject);
		return {
			title: code === null
				? t("mode.title.infrastructure")
				: t("mode.title.infrastructure-named", { cause: runErrorCause(code) }),
			facts: code === null
				? t("mode.fact.infrastructure")
				: t("mode.fact.infrastructure-named", {
					failed: mode.impact.failedOccurrences,
					total: mode.impact.failedOccurrences + mode.impact.passedOccurrences,
					cause: runErrorCause(code),
				}),
		};
	}
	const base = signature.kind === "outcome-instability"
		? t("mode.title.instability")
		: signature.checkCode === null
				? t("mode.title.legacy")
				: signature.checkCode === "required-tool" && signature.subject
					? t("mode.title.required-tool-named", { tool: quote(signature.subject, MAX_NAMED_SUBJECT_CHARS) })
					: t(CHECK_TITLE_KEY[signature.checkCode]);
	const clauses = mode.observations.map((item) => t(OBSERVATION_KEY[item.code], {
		runs: item.runs,
		observed: mode.observedRuns,
		runNoun: noun(mode.observedRuns, "failing run"),
		replies: plural(item.runs, "reply"),
	}));
	const facts = clauses.length === 0
		? t(mode.observedRuns === 0 ? "mode.fact.unread" : "mode.fact.nothing-visible", {
			failed: mode.impact.failedOccurrences,
		})
		: `${sentenceCase(clauses.join("; "))}.`;
	// The scope is said once, by the surface that shows it as a chip or a pill.
	// Saying it in the title too was the same two words twice in two lines.
	return { title: base, facts };
}

function sentenceCase(value: string): string {
	return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/**
 * One cited run, quoted: what the Target called and what it finally said. The
 * caller adds the identity it wants in front — a task id on a page, a run id in
 * the terminal — because the excerpt itself is the same evidence either way.
 */
export function failureModeExcerpt(evidence: FailureMode["evidence"][number]): string | null {
	const excerpt = evidence.excerpt;
	if (!excerpt) return null;
	const tools = excerpt.toolNames.length === 0
		? t("mode.excerpt.no-tool")
		: t("mode.excerpt.tools", { tools: excerpt.toolNames.join(", ") });
	return `${tools} · ${excerpt.reply === null ? t("mode.excerpt.no-reply") : `“${quote(excerpt.reply, MAX_EXCERPT_REPLY_CHARS)}”`}`;
}

/**
 * A failure mode this run is evidence for. `title` and `facts` are the host's
 * reading of the mode in the operator's language, never the canonical English
 * the artifact carries.
 */
export interface FailureModeExplanation {
	id: string;
	title: string;
	facts: string;
	scope: FailureMode["scope"];
	severity: FailureMode["severity"];
	decision: FailureMode["decision"];
	affectedTasks: number;
	totalTasks: number;
	reproductionBps: number;
}

export interface CandidateFlip {
	candidateId: string;
	/**
	 * The experiment this pair was: `candidate` re-tests a changed harness,
	 * `aa-calibration` re-runs the same revision against itself. Naming it keeps
	 * a noise measurement from reading as an improvement.
	 */
	mode: "candidate" | "aa-calibration";
	baselineEvalRunId: string;
	candidateEvalRunId: string;
	/** `failed` / `passed` / `1/2 passed` — this task's baseline standing. */
	before: string;
	/** The same for the candidate arm. */
	after: string;
	baselinePass: number;
	baselineTotal: number;
	candidatePass: number;
	candidateTotal: number;
	direction: "improved" | "regressed" | "unchanged";
	/** `↑` / `↓` / `=`, always paired with `direction` in text. */
	badge: string;
}

export interface RunExplanation {
	runId: string;
	taskId: string;
	repetitionIndex: number;
	outcome: RunOutcome;
	/** One sentence naming the outcome and the grader tally. */
	headline: string;
	/**
	 * What the record says ended this run, typed. Present exactly when the run
	 * recorded an error, and it — never the trace — is what every surface says
	 * about a run that never reached grading.
	 */
	error: RunErrorReading | null;
	/** One entry per failed grader, in recorded order. */
	graders: GraderExplanation[];
	/** Failure modes this run is evidence for. */
	failureModes: FailureModeExplanation[];
	/**
	 * Graders of this run whose judge said it could not tell. They are failures
	 * like any other — but failures of the instrument's certainty, not of the
	 * agent, and a screen that hides the difference is reading a guess.
	 */
	judgeAbstained: number;
	/** Baseline → candidate movement for this task, when a candidate covers it. */
	flip: CandidateFlip | null;
	/** The whole explanation as plain language, one sentence per line. */
	sentences: string[];
}

export function failureModeExplanation(mode: FailureMode): FailureModeExplanation {
	const reading = failureModeReading(mode);
	return {
		id: mode.failureModeId,
		title: reading.title,
		facts: reading.facts,
		scope: mode.scope,
		severity: mode.severity,
		decision: mode.decision,
		affectedTasks: mode.impact.affectedTasks,
		totalTasks: mode.impact.totalTasks,
		reproductionBps: mode.impact.reproductionBps,
	};
}

/** What re-ran the task: a real candidate, or a same-revision noise measurement. */
export function flipSubject(flip: Pick<CandidateFlip, "mode">): string {
	return t(flip.mode === "aa-calibration" ? "why.flip-subject-aa" : "why.flip-subject-candidate");
}

/** How one task stood in one arm, from its pass count over its repetitions. */
export function flipStanding(pass: number, total: number): string {
	if (total === 0) return t("why.standing-not-run");
	if (pass === 0) return t("why.standing-failed");
	if (pass === total) return t("why.standing-passed");
	return t("why.standing-partial", { pass, total });
}

export function candidateFlip(input: {
	candidateId: string;
	mode: "candidate" | "aa-calibration";
	baselineEvalRunId: string;
	candidateEvalRunId: string;
	baselinePass: number;
	baselineTotal: number;
	candidatePass: number;
	candidateTotal: number;
}): CandidateFlip {
	const baselineRate = input.baselineTotal === 0 ? 0 : input.baselinePass / input.baselineTotal;
	const candidateRate = input.candidateTotal === 0 ? 0 : input.candidatePass / input.candidateTotal;
	const direction = candidateRate > baselineRate
		? "improved"
		: candidateRate < baselineRate
			? "regressed"
			: "unchanged";
	return {
		...input,
		before: flipStanding(input.baselinePass, input.baselineTotal),
		after: flipStanding(input.candidatePass, input.candidateTotal),
		direction,
		badge: direction === "improved" ? "↑" : direction === "regressed" ? "↓" : "=",
	};
}

/**
 * Assemble the plain-language account of one run.
 *
 * Every clause traces to a field: the grader tally to `evalResults.graders`,
 * the expectation to that grader's recorded reason, the actual to the bounded
 * trace projection and `metrics`, the mode to the brief compiled from the
 * stored diagnosis, and the flip to a Candidate record's own evaluated
 * comparison.
 */
export function explainRun(input: {
	run: RunRecord;
	graders: GraderFinding[];
	facts: RunTraceFacts | null;
	modes: readonly FailureMode[];
	flip: CandidateFlip | null;
}): RunExplanation {
	const { run, graders, facts } = input;
	const outcome = runOutcome(run);
	const taskId = publicTaskId(run.taskId);
	const failed = graders.filter((grader) => !grader.passed);
	const headline = outcome === "error"
		? t("why.error", { task: taskId, rep: run.repetitionIndex })
		: outcome === "pass"
			? t("why.pass", { task: taskId, rep: run.repetitionIndex, graders: graders.length })
			: t("why.fail", { task: taskId, rep: run.repetitionIndex, failed: failed.length, graders: graders.length });
	const explanation: Omit<RunExplanation, "sentences"> = {
		runId: run.runId,
		taskId,
		repetitionIndex: run.repetitionIndex,
		outcome,
		headline,
		error: runErrorReading(run.error),
		graders: failed.map((grader) => explainGrader(grader, run, facts)),
		failureModes: input.modes.map(failureModeExplanation),
		judgeAbstained: graders.filter((grader) => grader.abstained).length,
		flip: input.flip,
	};
	return { ...explanation, sentences: explanationSentences(explanation) };
}

function explanationSentences(explanation: Omit<RunExplanation, "sentences">): string[] {
	const lines: string[] = [explanation.headline];
	// Said second, before anything read off a trace: what the record says ended
	// this run. The trace stops where the run stopped, so its last record is a
	// timestamp, not a cause — reading one off it is how session 7 announced
	// `called get_account · no reply` about a tool that answered in 930 ms.
	if (explanation.error) {
		lines.push(`${explanation.error.sentence} (${explanation.error.detail})`);
	}
	// Said once, before the graders: how much of this verdict is the judge
	// declining to decide rather than the agent failing a check.
	if (explanation.judgeAbstained > 0) {
		lines.push(t("judge.abstained", { count: explanation.judgeAbstained }));
	}
	for (const grader of explanation.graders) {
		lines.push(grader.expected
			? t("why.grader-expected", { name: grader.graderName, type: grader.graderType, expected: grader.expected, actual: grader.actual })
			: t("why.grader-plain", { name: grader.graderName, type: grader.graderType, actual: grader.actual }));
		lines.push(t("why.grader-reason", { reason: grader.reason }));
		for (const assertion of grader.assertions) {
			lines.push(t("why.assertion", {
				index: assertion.index,
				// The stored answer is a protocol token; the sentence quoting it is read.
				answer: tokenLabel("assertion.answer", assertion.answer),
				evidence: assertion.evidence,
			}));
		}
		if (grader.jury) {
			const passed = grader.jury.filter((vote) => vote.passed).length;
			lines.push(t("why.jury", { size: grader.jury.length, passed }));
		}
	}
	for (const mode of explanation.failureModes) {
		// `scope` and `severity` are typed tokens, and the two of them were the
		// only Latin left inside this Russian sentence: «(task-local, blocking,
		// задач: 1 из 8…)». They are read here, never matched on, so they bend.
		lines.push(t("why.failure-mode", {
			title: mode.title,
			scope: t(`mode.scope.${mode.scope}`),
			severity: t(`mode.severity.${mode.severity}`),
			affected: mode.affectedTasks,
			total: mode.totalTasks,
			reproduction: Math.round(mode.reproductionBps / 100),
		}));
		lines.push(t("why.facts", { facts: mode.facts }));
	}
	if (explanation.flip) {
		const flip = explanation.flip;
		lines.push(t("why.flip", {
			subject: flipSubject(flip),
			candidate: flip.candidateId,
			before: flip.before,
			after: flip.after,
			direction: flip.direction,
			baselinePass: flip.baselinePass,
			baselineTotal: flip.baselineTotal,
			candidatePass: flip.candidatePass,
			candidateTotal: flip.candidateTotal,
		}));
	}
	return lines;
}

/** The explanation as plain lines. The TUI prints these; the page renders them. */
export function renderRunExplanationText(explanation: RunExplanation): string[] {
	return [...explanation.sentences];
}
