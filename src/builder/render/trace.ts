import type { GraderFinding, RunRow, TranscriptEntry } from "../../application/run-explanation.js";
import type { EvalPageMode, RunDetailPageModel } from "../../evidence/pages.js";
import { oneLine } from "./format.js";
import type { Paint } from "./paint.js";
import { t } from "../../i18n.js";

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
	const columns = { index: 3, task: 18, rep: 3, outcome: 7, score: 5, graders: 24, mode: 24, tools: 5 };
	const header = [
		pad("#", columns.index),
		pad(t("table.col.task"), columns.task),
		pad(t("table.col.rep"), columns.rep),
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
		lines.push([
			pad(String(position + 1), columns.index),
			pad(oneLine(row.taskId, columns.task), columns.task),
			pad(String(row.repetitionIndex), columns.rep),
			paintOutcome(row.outcome, outcome, paint),
			pad(pct(row.score), columns.score),
			pad(oneLine(graderChips(row.graders), columns.graders), columns.graders),
			pad(oneLine(mode, columns.mode), columns.mode),
			pad(String(row.metrics.toolCalls), columns.tools),
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
			const status = entry.isError ? paint.error(t("trace.errored")) : paint.success(t("trace.tool-ok"));
			const lines = [`  ${paint.accent("→")} ${paint.bold(entry.name)} · ${oneLine(entry.args, MAX_TOOL_ARGS_CHARS)} · ${duration(entry.durationMs)} · ${status}`];
			if (entry.result !== null) {
				lines.push(`    ${paint.dim(oneLine(entry.result, MAX_TOOL_RESULT_CHARS))}${entry.resultTruncated ? paint.dim(" …") : ""}`);
			}
			return lines;
		}
	}
}

/**
 * One run, whole: why it failed in the host's words, every grader's verdict,
 * then the conversation. Bounded to `MAX_TRACE_PANEL_LINES`.
 */
export function renderTracePanel(model: RunDetailPageModel, paint: Paint): string[] {
	const run = model.run;
	const score = meanGraderScore(model.graders);
	const lines: string[] = [
		`${paint.heading(t("trace.run"))} ${run.taskId}#${run.repetitionIndex} · ${paintOutcome(run.outcome, outcomeWord(run.outcome), paint)}` +
			`${score === null ? "" : ` · ${t("table.col.score")} ${pct(score)}`} · ${duration(run.metrics.latencyMs)} · ${t("trace.toolCalls", { n: run.metrics.toolCalls })} · ${paint.dim(run.runId)}`,
	];
	if (run.error) lines.push(`${paint.heading(t("trace.error"))} ${oneLine(run.error, 200)}`);
	lines.push("", paint.heading(t("trace.why")));
	for (const sentence of model.explanation.sentences) {
		for (const line of wrapSentence(sentence)) lines.push(`  ${line}`);
	}
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
	const tools = entries.filter((entry) => entry.kind === "tool").map((entry) => (entry.kind === "tool" ? `${entry.name}${entry.isError ? " (error)" : ""}` : ""));
	const parts = [
		`Operator opened /trace for run ${run.runId} — ${run.taskId}#${run.repetitionIndex}, ${outcomeWord(run.outcome)} — of eval ${model.evalRunId}.`,
		`Host facts (assembled from recorded fields, not by a model): ${model.explanation.sentences.join(" ")}`,
		graders ? `Graders: ${graders}.` : "Graders: none recorded.",
		firstUser && firstUser.kind === "user" ? `Case input: ${oneLine(firstUser.text, 300)}` : "Case input: not in the recorded trace.",
		finalAnswer && finalAnswer.kind === "assistant" ? `Agent's answer: ${oneLine(finalAnswer.text, 400)}` : "Agent's answer: not in the recorded trace.",
		tools.length > 0 ? `Tool calls, in order: ${tools.join(", ")}.` : "Tool calls: none.",
		"Now tell the operator, in their language and in at most four sentences, why the harness let this happen and what you would change in the instructions, a skill or a tool. Call it your hypothesis. Use only the facts above; never quote or infer sealed content; do not invent numbers or ids.",
	];
	return parts.join("\n").slice(0, MAX_NOTE_CHARS);
}
