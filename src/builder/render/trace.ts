import type { GraderFinding, RunReceipt, RunRow, TranscriptEntry } from "../../application/run-explanation.js";
import type { RagRunXray } from "../../application/rag-xray.js";
import type { EvalPageMode, RunDetailPageModel } from "../../evidence/pages.js";
import { oneLine, shortTaskId } from "./format.js";
import type { Paint } from "./paint.js";
import { plural, t, tokenLabel } from "../../i18n.js";

/**
 * Traces inside the TUI. The same pure projections the Evidence Explorer
 * renders as HTML — `runsTable` rows and the host-written run explanation —
 * printed as bounded, width-safe panel lines. Nothing here reads a trace
 * itself: every fact arrives already bounded, redacted and visibility-checked
 * by `src/evidence/model.ts`.
 */

export const DEFAULT_TRACE_TABLE_ROWS = 12;
export const MAX_TRACE_TABLE_ROWS = 60;
/** A trace panel never grows past this; the Explorer has the rest. */
export const MAX_TRACE_PANEL_LINES = 200;
const WRAP_WIDTH = 100;
const MAX_TURN_CHARS = 1_200;
const MAX_TOOL_ARGS_CHARS = 160;
const MAX_TOOL_RESULT_CHARS = 300;
const MAX_NOTE_CHARS = 3_800;
const MAX_RAG_PANEL_SEARCHES = 4;
const MAX_RAG_PANEL_HITS = 5;
const MAX_RAG_PANEL_SOURCE_IDS = 6;

function pct(score: number): string {
	return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
}

function duration(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms)) return "—";
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function pad(text: string, width: number): string {
	const chars = [...text];
	return chars.length >= width ? chars.join("") : text + " ".repeat(width - chars.length);
}

function outcomeWord(outcome: RunRow["outcome"]): string {
	return outcome === "pass" ? "pass" : outcome === "fail" ? "fail" : "error";
}

function paintOutcome(outcome: RunRow["outcome"], text: string, paint: Paint): string {
	return outcome === "pass" ? paint.success(text) : outcome === "fail" ? paint.error(text) : paint.warning(text);
}

/** Break one sentence into lines of at most `width` characters, at spaces. */
export function wrapSentence(text: string, width = WRAP_WIDTH): string[] {
	const words = oneLine(text, 2_000).split(" ");
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const next = current ? `${current} ${word}` : word;
		if ([...next].length > width && current) {
			lines.push(current);
			current = word;
		} else {
			current = next;
		}
	}
	if (current) lines.push(current);
	return lines;
}

function graderChips(graders: RunRow["graders"]): string {
	return graders.map((grader) => `${grader.passed ? "✓" : "✗"}${oneLine(grader.name, 14)}`).join(" ");
}

/**
 * How often each case came back right, over the rows given.
 *
 * A row is one repetition; the fraction beside it is the whole case: `3/3`
 * says the agent got this one right every time it was asked, `2/3` says the
 * answer moves. An errored repetition is counted in the denominator and never
 * in the numerator — the run stopped before grading, and calling that a pass
 * would turn a case the engine lost into a case the agent aced.
 */
function repetitionsPassed(rows: readonly RunRow[]): Map<string, { pass: number; total: number }> {
	const byTask = new Map<string, { pass: number; total: number }>();
	for (const row of rows) {
		const entry = byTask.get(row.taskId) ?? { pass: 0, total: 0 };
		entry.total += 1;
		if (row.outcome === "pass") entry.pass += 1;
		byTask.set(row.taskId, entry);
	}
	return byTask;
}

/**
 * The compact runs table under the diagnosis: failures first (the rows come
 * already ordered by `runsTable`), one line per case × repetition.
 */
export function renderRunsTable(
	rows: readonly RunRow[],
	modes: readonly EvalPageMode[],
	paint: Paint,
	options: { limit?: number } = {},
): string[] {
	const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_TRACE_TABLE_ROWS, MAX_TRACE_TABLE_ROWS));
	if (rows.length === 0) return [paint.dim(t("table.none"))];
	const titles = new Map(modes.map((mode) => [mode.id, mode.title]));
	const shown = rows.slice(0, limit);
	// Counted over every row handed in, not the page's own slice: a fraction
	// whose denominator is however many rows happened to fit is not a fraction.
	const passed = repetitionsPassed(rows);
	// The `passed` column is paid for out of the two widest neighbours: the
	// panel's 110 columns are the budget, and a fraction that says whether a
	// case is reliable outweighs five more characters of grader chip.
	const columns = { index: 3, task: 18, rep: 3, passed: 6, outcome: 7, score: 5, graders: 18, mode: 23, tools: 5 };
	const header = [
		pad("#", columns.index),
		pad(t("table.col.task"), columns.task),
		pad(t("table.col.rep"), columns.rep),
		pad(t("table.col.every-repetition"), columns.passed),
		pad(t("table.col.outcome"), columns.outcome),
		pad(t("table.col.score"), columns.score),
		pad(t("table.col.graders"), columns.graders),
		pad(t("table.col.mode"), columns.mode),
		pad(t("table.col.tools"), columns.tools),
		t("table.col.latency"),
	].join(" ");
	const lines = [paint.dim(header)];
	shown.forEach((row, position) => {
		const modeId = row.failureModeIds[0];
		const mode = modeId ? titles.get(modeId) ?? modeId : "—";
		const outcome = pad(outcomeWord(row.outcome), columns.outcome);
		const task = passed.get(row.taskId) ?? { pass: 0, total: 0 };
		lines.push([
			pad(String(position + 1), columns.index),
			pad(oneLine(shortTaskId(row.taskId), columns.task), columns.task),
			pad(String(row.repetitionIndex), columns.rep),
			pad(`${task.pass}/${task.total}`, columns.passed),
			paintOutcome(row.outcome, outcome, paint),
			pad(pct(row.score), columns.score),
			pad(oneLine(graderChips(row.graders), columns.graders), columns.graders),
			pad(oneLine(mode, columns.mode), columns.mode),
			pad(row.metrics.reportedToolCalls > 0
				? `${row.metrics.toolCalls}+${row.metrics.reportedToolCalls}r`
				: String(row.metrics.toolCalls), columns.tools),
			duration(row.metrics.latencyMs),
		].join(" "));
	});
	if (rows.length > shown.length) {
		lines.push(paint.dim(t("table.more", { n: rows.length - shown.length, m: Math.min(rows.length, MAX_TRACE_TABLE_ROWS) })));
	}
	lines.push(paint.dim(t("table.hint")));
	return lines;
}

function meanGraderScore(graders: readonly GraderFinding[]): number | null {
	if (graders.length === 0) return null;
	return graders.reduce((sum, grader) => sum + grader.score, 0) / graders.length;
}

function renderGrader(grader: GraderFinding, paint: Paint): string[] {
	const mark = grader.passed ? paint.success("✓") : paint.error("✗");
	const lines = [`  ${mark} ${oneLine(grader.name, 40)} ${paint.dim(`(${grader.type})`)}${grader.reason ? ` — ${oneLine(grader.reason, 80)}` : ""}`];
	if (grader.assertions && grader.assertions.total > 0) {
		lines.push(`      ${paint.dim(`assertions ${grader.assertions.passed}/${grader.assertions.total}`)}`);
	}
	for (const verdict of grader.assertionVerdicts ?? []) {
		const answer = verdict.answer === "yes" ? paint.success(verdict.answer) : verdict.answer === "no" ? paint.error(verdict.answer) : paint.warning(String(verdict.answer));
		lines.push(`      · assertion ${verdict.index}: ${answer}${verdict.evidence ? ` — ${oneLine(verdict.evidence, 78)}` : ""}`);
	}
	if (grader.jury && grader.jury.length > 0) lines.push(`      ${paint.dim(`jury of ${grader.jury.length}`)}`);
	if (grader.choice) lines.push(`      ${paint.dim(`choice ${grader.choice}`)}`);
	return lines;
}

function renderEntry(entry: TranscriptEntry, paint: Paint): string[] {
	switch (entry.kind) {
		case "user":
			return [`  ${paint.accent("›")} ${paint.bold(t("trace.user"))}`, ...wrapSentence(entry.text.slice(0, MAX_TURN_CHARS)).map((line) => `    ${line}`)];
		case "assistant": {
			const head = entry.final ? paint.bold(t("trace.finalAnswer")) : paint.bold(t("trace.agent"));
			const body = wrapSentence(entry.text.slice(0, MAX_TURN_CHARS)).map((line) => `    ${entry.final ? paint.accent(line) : line}`);
			return [`  ${paint.accent("‹")} ${head}`, ...body];
		}
		case "tool": {
			const status = entry.evidence === "reported" ? paint.warning(t("trace.tool-reported"))
				: entry.result === null ? paint.warning(t("trace.no-result"))
					: entry.isError ? paint.error(t("trace.errored")) : paint.success(t("trace.tool-ok"));
			const lines = [`  ${paint.accent("→")} ${paint.bold(entry.name)} · ${oneLine(entry.args, MAX_TOOL_ARGS_CHARS)} · ${duration(entry.durationMs)} · ${status}`];
			if (entry.result !== null) {
				lines.push(`    ${paint.dim(oneLine(entry.result, MAX_TOOL_RESULT_CHARS))}${entry.resultTruncated ? paint.dim(" …") : ""}`);
			}
			return lines;
		}
	}
}

/**
 * The world this run happened in, if it had one.
 *
 * `before` is the case's own starting state; `after` is what the conversation
 * left behind, or `null` when the run wrote no world file. `unreadable` is the
 * third answer, and the honest one: a world file that will not parse says
 * nothing about the agent, so the panel reports that rather than inventing an
 * empty state.
 */
export interface TraceWorld {
	before: unknown;
	after: unknown;
	unreadable?: boolean;
}

/** `{"accounts":{"33333":{"balance":-500}}}`, bounded to one line. */
function worldLine(state: unknown): string {
	if (state === undefined || state === null) return "—";
	// A case preview hands the state over as bounded, redacted canonical JSON
	// already — a string, deliberately, because that is what a human is shown.
	if (typeof state === "string") return oneLine(state, MAX_WORLD_LINE_CHARS);
	try {
		return oneLine(JSON.stringify(state) ?? "—", MAX_WORLD_LINE_CHARS);
	} catch {
		return "—";
	}
}

const MAX_WORLD_LINE_CHARS = 160;

/**
 * What this run was handed and what it spent, one fact per clause.
 *
 * Four absent JSON keys are not four absent things: a world can be there, an
 * instrument can have never run BECAUSE the run died before grading, and a
 * spend can simply not have been reported. Each of those gets its own words,
 * so a reader never has to guess which `null` they are looking at.
 */
export function receiptLines(receipt: RunReceipt, paint: Paint): string[] {
	const money = (costUsd: number): string => `$${costUsd.toFixed(2)}`;
	const instrument = (
		spend: { calls: number; costUsd: number } | null,
		keys: { spent: "receipt.judge-spent" | "receipt.user-spent"; none: "receipt.judge-none" | "receipt.user-none"; failed: "receipt.judge-none-error" | "receipt.user-none-error" },
	): string =>
		spend && spend.calls > 0
			? t(keys.spent, { calls: plural(spend.calls, "call"), cost: money(spend.costUsd) })
			: t(receipt.incomplete ? keys.failed : keys.none);
	return [
		`${paint.dim(t("receipt.section"))} ${
			[
				receipt.worldKeys === null
					? t("receipt.world-absent")
					: t("receipt.world-present", { keys: plural(receipt.worldKeys, "key") }),
				instrument(receipt.judge, { spent: "receipt.judge-spent", none: "receipt.judge-none", failed: "receipt.judge-none-error" }),
				instrument(receipt.simulatedUser, { spent: "receipt.user-spent", none: "receipt.user-none", failed: "receipt.user-none-error" }),
				receipt.tokens === null
					? t("receipt.tokens-unreported")
					: `${t("receipt.tokens", { tokens: receipt.tokens })}${receipt.costUsd === null ? "" : `, ${money(receipt.costUsd)}`}`,
			].join(paint.dim(" · "))
		}`,
	];
}

function optionalRate(value: number | null): string {
	return value === null ? "—" : pct(value);
}

function sourceIds(ids: readonly string[]): string {
	if (ids.length === 0) return t("rag.none");
	const shown = ids.slice(0, MAX_RAG_PANEL_SOURCE_IDS).map((id) => oneLine(id, 28));
	return `${shown.join(", ")}${ids.length > shown.length ? `, ${t("rag.more", { count: ids.length - shown.length })}` : ""}`;
}

/** Bounded retrieval evidence for Builder `/trace`; chunk bodies never enter this DTO. */
export function renderRagXrayLines(rag: RagRunXray, paint: Paint): string[] {
	const lines = [
		paint.heading(t("rag.title")),
		`  ${oneLine(t("rag.diagnosis-line", { diagnosis: tokenLabel("rag.diagnosis", rag.diagnosis) }), 112)}`,
		`  ${oneLine(t("rag.summary", {
			searches: plural(rag.searchCount, "search"),
			hitAtK: optionalRate(rag.hitAtK),
			mrr: rag.mrr === null ? t("metrics.not-reported") : rag.mrr.toFixed(3),
			citation: optionalRate(rag.citationRate),
			grounding: optionalRate(rag.groundingPassRate),
		}), 112)}`,
		`  ${paint.dim(oneLine(`${t("rag.resources", {
			latency: rag.retrievalLatencyMs === null ? t("metrics.not-reported") : `${Math.round(rag.retrievalLatencyMs)}ms`,
			cost: rag.retrievalCostUsd === null ? t("metrics.not-reported") : "$0.00",
			coverage: optionalRate(rag.scoreCoverage),
		})} · ${t("rag.faithfulness-note")}`, 112))}`,
		`  ${paint.dim(t("rag.source.expected"))} ${oneLine(sourceIds(rag.expectedChunkIds), 98)}`,
		`  ${paint.dim(t("rag.source.retrieved"))} ${oneLine(sourceIds(rag.retrievedChunkIds), 97)}`,
		`  ${paint.dim(t("rag.source.cited"))} ${oneLine(sourceIds(rag.citedChunkIds), 100)}`,
	];
	const shownSearches = rag.searches.slice(0, MAX_RAG_PANEL_SEARCHES);
	for (const [index, search] of shownSearches.entries()) {
		lines.push(`  ${paint.accent(`#${index + 1}`)} ${oneLine(t("rag.search-summary", {
			index: index + 1,
			status: tokenLabel("rag.search-status", search.status),
			k: search.requestedK ?? t("metrics.not-reported"),
			duration: duration(search.durationMs),
		}), 112)}`);
		lines.push(`    ${paint.dim(t("rag.query"))}: ${oneLine(search.query ?? t("rag.query-not-recorded"), 98)}`);
		for (const hit of search.hits.slice(0, MAX_RAG_PANEL_HITS)) {
			const flags = [
				hit.expected ? tokenLabel("rag.flag", "expected") : "",
				hit.cited ? tokenLabel("rag.flag", "cited") : "",
			].filter(Boolean).join(",") || t("rag.flags.other");
			const score = hit.score === null ? t("metrics.not-reported") : hit.score.toFixed(3);
			lines.push(`    ${oneLine(`${hit.rank}. ${oneLine(hit.chunkId, 28)} · ${oneLine(hit.path ?? t("rag.path-missing"), 28)} · ${t("rag.score-inline", { score })} · ${flags} · ${t("rag.overlap-inline", { overlap: optionalRate(hit.answerOverlap) })}`, 112)}`);
		}
		if (search.hits.length > MAX_RAG_PANEL_HITS) {
			lines.push(`    ${paint.dim(t("rag.hits-omitted", { count: search.hits.length - MAX_RAG_PANEL_HITS }))}`);
		}
	}
	const omitted = Math.max(0, rag.searchCount - shownSearches.length);
	if (omitted > 0) lines.push(`  ${paint.dim(t("rag.searches-omitted", { searches: plural(omitted, "search") }))}`);
	lines.push(`  ${paint.dim(t("rag.overlap-note"))}`);
	return lines;
}

/**
 * One run, whole: why it failed in the host's words, every grader's verdict,
 * then the conversation. Bounded to `MAX_TRACE_PANEL_LINES`.
 */
export function renderTracePanel(
	model: RunDetailPageModel,
	paint: Paint,
	options: { world?: TraceWorld | null } = {},
): string[] {
	const run = model.run;
	const score = meanGraderScore(model.graders);
	const lines: string[] = [
		`${paint.heading(t("trace.run"))} ${run.taskId}#${run.repetitionIndex} · ${paintOutcome(run.outcome, outcomeWord(run.outcome), paint)}` +
			`${score === null ? "" : ` · ${t("table.col.score")} ${pct(score)}`} · ${duration(run.metrics.latencyMs)} · ${t("trace.toolCalls", { n: run.metrics.toolCalls })}` +
			`${run.metrics.reportedToolCalls > 0 ? ` · ${t("trace.reportedToolCalls", { n: run.metrics.reportedToolCalls })}` : ""} · ${paint.dim(run.runId)}`,
	];
	// The recorded stem, read as the host's own sentence rather than left as a
	// raw string a reader has to decode — and never re-derived from the trace.
	if (model.explanation.error) {
		lines.push(
			`${paint.heading(t("trace.error"))} ${model.explanation.error.sentence} ${
				paint.muted(oneLine(model.explanation.error.detail, 200))
			}`,
		);
	} else if (run.error) {
		lines.push(`${paint.heading(t("trace.error"))} ${oneLine(run.error, 200)}`);
	}
	// A worlded case is graded on what the world holds afterwards, so a trace
	// that shows only the conversation shows half the evidence. Session 7 opened
	// the trace of a worlded case and found neither state on the screen.
	if (options.world) {
		lines.push(`${paint.dim(t("trace.world-before"))} ${worldLine(options.world.before)}`);
		lines.push(`${paint.dim(t("trace.world-after"))} ${
			options.world.unreadable ? paint.warning(t("trace.world-unread")) : worldLine(options.world.after)
		}`);
	}
	if (model.receipt) lines.push(...receiptLines(model.receipt, paint));
	lines.push("", paint.heading(t("trace.why")));
	for (const sentence of model.explanation.sentences) {
		for (const line of wrapSentence(sentence)) lines.push(`  ${line}`);
	}
	if (model.explanation.rag) lines.push("", ...renderRagXrayLines(model.explanation.rag, paint));
	lines.push("", paint.heading(t("trace.verdict")));
	if (model.graders.length === 0) lines.push(`  ${paint.dim(t("trace.noGraders"))}`);
	for (const grader of model.graders) lines.push(...renderGrader(grader, paint));
	lines.push("", paint.heading(t("trace.conversation")));
	if (!model.transcript) {
		lines.push(`  ${paint.dim(oneLine(model.traceNotice, 160))}`);
	} else {
		for (const entry of model.transcript.entries) lines.push(...renderEntry(entry, paint));
		if (model.transcript.truncated) {
			lines.push(`  ${paint.dim(t("trace.moreEntries", { n: model.transcript.omittedCount }))}`);
		}
	}
	lines.push("");
	const walk: string[] = [];
	if (model.prev) walk.push(`/trace prev → ${model.prev.taskId}#${model.prev.repetitionIndex}`);
	if (model.next) walk.push(`/trace next → ${model.next.taskId}#${model.next.repetitionIndex}`);
	lines.push(paint.dim([...walk, `explorer /runs/${run.runId}`].join(" · ")));
	if (lines.length > MAX_TRACE_PANEL_LINES) {
		const kept = lines.slice(0, MAX_TRACE_PANEL_LINES - 1);
		kept.push(paint.dim(t("trace.omitted", { n: lines.length - kept.length, run: run.runId })));
		return kept;
	}
	return lines;
}

/**
 * What the Builder is told when the operator opens a trace: the host's facts
 * and a bounded excerpt, followed by the one thing only a model can add — a
 * hypothesis, in the operator's language, about why the harness let it happen.
 */
export function traceNoteForModel(model: RunDetailPageModel): string {
	const run = model.run;
	const graders = model.graders
		.map((grader) => `${grader.name}=${grader.passed ? "pass" : "fail"}${grader.reason ? ` (${oneLine(grader.reason, 120)})` : ""}`)
		.join("; ");
	const entries = model.transcript?.entries ?? [];
	const firstUser = entries.find((entry) => entry.kind === "user");
	const finalAnswer = [...entries].reverse().find((entry) => entry.kind === "assistant" && entry.final) ??
		[...entries].reverse().find((entry) => entry.kind === "assistant");
	const tools = entries.filter((entry) => entry.kind === "tool").map((entry) => (entry.kind === "tool" ? `${entry.name}${entry.evidence === "reported" ? " (agent-reported, not host-verified)" : ""}${entry.isError ? " (error)" : ""}` : ""));
	const failure = model.explanation.error;
	const parts = [
		`Operator opened /trace for run ${run.runId} — ${run.taskId}#${run.repetitionIndex}, ${outcomeWord(run.outcome)} — of eval ${model.evalRunId}.`,
		`Host facts (assembled from recorded fields, not by a model): ${model.explanation.sentences.join(" ")}`,
		// Said before anything read off the trace, because the trace stops where
		// the run stopped: its last record is a timestamp, never a cause. Session 7
		// let the Builder infer "the tool did not answer" from a trace whose tool
		// answered in 930 ms, and send the operator to export a variable that was
		// already exported.
		...(failure
			? [
				`The run recorded this error, and it is the ONLY statement about why it ended: ${failure.detail} (typed cause: ${failure.code}).`,
				"The trace below stops where the run stopped, so nothing in it — a last tool call, a missing reply — says why. Never infer a cause from its shape, and never claim a tool failed when its recorded result says ok.",
			]
			: []),
		graders ? `Graders: ${graders}.` : "Graders: none recorded.",
		firstUser && firstUser.kind === "user" ? `Case input: ${oneLine(firstUser.text, 300)}` : "Case input: not in the recorded trace.",
		finalAnswer && finalAnswer.kind === "assistant" ? `Agent's answer: ${oneLine(finalAnswer.text, 400)}` : "Agent's answer: not in the recorded trace.",
		tools.length > 0 ? `Tool calls, in order: ${tools.join(", ")}.` : "Tool calls: none.",
		failure
			? "Now tell the operator, in their language and in at most four sentences, what ended this run — quote the typed cause above — and that it is infrastructure, so the honest next step is to stabilize the path and run again, never a harness change. Do not send the operator to a shell; do not invent a missing credential; use only the facts above."
			: "Now tell the operator, in their language and in at most four sentences, why the harness let this happen and what you would change in the instructions, a skill or a tool. Call it your hypothesis. Use only the facts above; never quote or infer sealed content; do not invent numbers or ids.",
	];
	return parts.join("\n").slice(0, MAX_NOTE_CHARS);
}
