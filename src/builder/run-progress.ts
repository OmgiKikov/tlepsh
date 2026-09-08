import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { t, verdictLabel } from "../i18n.js";
import { projectRunEventIdentity, type RunEventListener } from "../run-events.js";
import { bar, clean, coarseElapsed, oneLine, percent, shortTaskId, visibleLength } from "./render/format.js";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { runProgressCopy } from "./run-progress-copy.js";

const UI_KEY = "ahde-run-progress";
// Pi renders at most ten entries from a string-array widget.
const MAX_WIDGET_LINES = 10;
const MAX_WIDGET_BYTES = 32 * 1024;
/** Executions the grid draws one cell each; past this it is a bar. */
const MAX_GRID_CELLS = 64;
/** Characters of one running run's line: the case, then what it is doing. */
const MAX_ACTIVITY_CHARS = 100;
const MAX_CASE_CHARS = 28;
const MAX_TRACKED_RUNS = 4_096;
const MAX_ANSWER_CHARS = 512;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type RunProgressUi = Pick<ExtensionUIContext, "setStatus" | "setWidget">;

export interface RunProgressPresenter {
	onRunEvent: RunEventListener;
	/**
	 * Planned Target executions for the whole job, as the estimate the human
	 * gate priced states them: both arms over the development basket and the
	 * sealed exam, plus the cheap-check screen when one runs. This approved
	 * budget is shown separately: sealed executions emit no public events and
	 * cannot be counted as visible grades or used to estimate time remaining.
	 */
	plan(executions: number | null): void;
	dispose(): void;
}

export interface RunProgressPresenterOptions {
	liveTraceUrl?: string;
	/** The clock for elapsed time; tests pass their own. */
	now?: () => number;
}

type Outcome = "pass" | "fail" | "error";

/** What one execution is doing right now, in the words of its last event. */
interface Activity {
	taskId: string;
	/** Latest one-line description: a tool call, the tail of an answer, a verdict. */
	line: string;
	/** Answer text accumulates across deltas; anything else replaces it. */
	answer: string;
	control: "" | "escape" | "intermediate" | "csi" | "osc" | "string" | "osc-escape" | "string-escape";
	at: number;
	finished: boolean;
}

const CELL: Record<Outcome | "running" | "pending", string> = {
	pass: "✓",
	fail: "✗",
	error: "!",
	running: "▸",
	pending: "·",
};

/** The tail of a sentence, because the newest words are the ones that say where it is. */
function tail(value: string, max: number): string {
	if (max <= 0) return "";
	if (visibleWidth(value) <= max) return value;
	const segments = [...graphemes.segment(value)];
	let result = "";
	let width = 1;
	for (let i = segments.length - 1; i >= 0; i--) {
		const segment = segments[i]!.segment;
		width += visibleWidth(segment);
		if (width > max) break;
		result = segment + result;
	}
	return `…${result}`;
}

/** Discard control payloads as they arrive; retain state, never an open OSC/DCS body. */
function appendAnswer(activity: Activity, delta: string): void {
	let text = "";
	for (const char of delta) {
		const state = activity.control;
		if (state === "osc" || state === "string" || state === "osc-escape" || state === "string-escape") {
			const osc = state.startsWith("osc");
			if (char === "\u009c" || (osc && char === "\u0007") || (state.endsWith("escape") && char === "\\")) activity.control = "";
			else activity.control = char === "\u001b" ? (osc ? "osc-escape" : "string-escape") : (osc ? "osc" : "string");
			continue;
		}
		if (char === "\u001b") { activity.control = "escape"; continue; }
		if (char === "\u009b") { activity.control = "csi"; continue; }
		if (char === "\u009d") { activity.control = "osc"; continue; }
		if (/[\u0090\u0098\u009e\u009f]/u.test(char)) { activity.control = "string"; continue; }
		if (state === "escape") {
			activity.control = char === "[" ? "csi" : char === "]" ? "osc" : /[PX^_]/.test(char) ? "string" : /[ -/]/.test(char) ? "intermediate" : "";
			continue;
		}
		if (state === "csi" || state === "intermediate") {
			if (state === "csi" ? /[@-~]/.test(char) : /[0-~]/.test(char)) activity.control = "";
			continue;
		}
		text += char;
		// Bound even a single oversized event before it can become retained state.
		if (text.length > MAX_ANSWER_CHARS * 2) text = text.slice(-MAX_ANSWER_CHARS);
	}
	activity.answer = `${activity.answer}${clean(text)}`.slice(-MAX_ANSWER_CHARS).replace(/^[\uDC00-\uDFFF]/u, "");
}

function safely(action: () => void): void {
	try {
		action();
	} catch {
		// Live presentation is observational and must never change the run result.
	}
}

/**
 * The live picture of a measurement, above the editor: a cell per execution
 * turning ✓ or ✗ as it is graded, the running ones named with what they are
 * doing this second, and the last verdict. Ten lines at most, redrawn on
 * every event, never a log to scroll.
 */
export function createRunProgressPresenter(
	ui: RunProgressUi,
	options: RunProgressPresenterOptions = {},
): RunProgressPresenter {
	const now = options.now ?? (() => Date.now());
	const copy = runProgressCopy();
	const startedAt = now();
	const frameHeader = [
		t("trace.header"),
		...(options.liveTraceUrl ? [oneLine(t("trace.open-live", { url: options.liveTraceUrl }), 2_048)] : []),
	];
	let currentStatus: string | undefined;
	let disposed = false;

	// Executions in the order they were first seen; the grid is drawn in this
	// order so a cell never moves once it has appeared.
	const outcomes = new Map<string, Outcome | null>();
	const phases = new Map<string, { total: number; seen: number }>();
	const running = new Map<string, Activity>();
	const counts = { pass: 0, fail: 0, error: 0, graded: 0 };
	let progress: { taskId: string } | null = null;
	let publicTotal = 0;
	let limited = false;
	// The job's own planned total, once the gate that priced it approved.
	let planned: number | null = null;
	let last: string | null = null;

	const total = (): number => Math.max(publicTotal, counts.graded, outcomes.size);
	const tally = (): string => `✓${counts.pass} ✗${counts.fail}${counts.error > 0 ? ` !${counts.error}` : ""}`;

	const gridLine = (): string => {
		const size = total();
		let cells: string;
		if (size <= MAX_GRID_CELLS) {
			const drawn = [...outcomes].map(([runId, outcome]) => CELL[outcome ?? (running.has(runId) ? "running" : "pending")]);
			cells = `${drawn.join("")}${CELL.pending.repeat(Math.max(0, size - drawn.length))}`;
		} else {
			cells = `${bar(size > 0 ? counts.graded / size : 0, 24)} ${percent(size > 0 ? counts.graded / size : 0)}`;
		}
		const spent = now() - startedAt;
		return t("trace.grid", { cells, graded: counts.graded, total: size, tally: tally(), elapsed: coarseElapsed(spent) });
	};

	const activityLines = (budget: number): string[] => {
		const active = [...running.values()];
		if (active.length === 0 || budget <= 0) return [];
		const shown = active.slice(0, active.length > budget ? Math.max(0, budget - 1) : budget);
		const lines = shown.map((activity) => {
			const prefix = `${CELL.running} ${clean(truncateToWidth(oneLine(shortTaskId(activity.taskId)), MAX_CASE_CHARS, "…"))} ${t("trace.sep")} `;
			const assistant = t("trace.prefix.assistant");
			const line = activity.answer ? assistant + tail(oneLine(activity.answer, MAX_ANSWER_CHARS), MAX_ACTIVITY_CHARS - visibleLength(prefix + assistant)) : activity.line;
			return clean(truncateToWidth(prefix + line, MAX_ACTIVITY_CHARS, "…"));
		});
		if (active.length > shown.length) lines.push(t("trace.running-more", { count: active.length - shown.length }));
		return lines;
	};

	const render = (): void => {
		const notes = [copy.publicProgress, ...(planned === null ? [] : [copy.plannedBudget(planned)]), ...(limited ? [copy.limited] : [])];
		const fixed = frameHeader.length + 1 + notes.length + (last ? 1 : 0);
		const frame = [...frameHeader, gridLine(), ...notes, ...activityLines(MAX_WIDGET_LINES - fixed), ...(last ? [last] : [])];
		// Nothing here is unbounded, but the budget is Pi's and is held explicitly.
		while (frame.length > 1 && Buffer.byteLength(frame.join("\n"), "utf8") > MAX_WIDGET_BYTES) frame.pop();
		safely(() => ui.setWidget(UI_KEY, frame.slice(0, MAX_WIDGET_LINES), { placement: "aboveEditor" }));
	};

	const setStatus = (status: string): void => {
		const safeStatus = oneLine(status, 512);
		if (safeStatus === currentStatus) return;
		currentStatus = safeStatus;
		safely(() => ui.setStatus(UI_KEY, safeStatus));
	};

	const progressLine = (): string => {
		if (!progress) return t("status.run-starting");
		const size = total();
		const share = size > 0 ? counts.graded / size : 0;
		return t("status.run-progress", {
			graded: counts.graded,
			total: size,
			running: running.size,
			bar: `${bar(share, 12)} ${percent(share)}`,
			tally: tally(),
			task: shortTaskId(progress.taskId),
		});
	};
	const status = (activity: string): void => {
		setStatus(t("status.activity", { line: progressLine(), activity: `${activity} · ${copy.publicProgress}${limited ? ` · ${copy.limited}` : ""}` }));
	};

	const onRunEvent: RunEventListener = (event) => {
		if (disposed) return;
		const run = projectRunEventIdentity(event.run);
		const key = JSON.stringify([run.evalRunId, run.runId]);
		const existing = running.get(key);
		if (outcomes.get(key)) return; // First grade is terminal, even if replayed differently.
		if (!outcomes.has(key)) {
			// Never evict deduplication identities: a late duplicate must not become a new grade.
			if (outcomes.size >= MAX_TRACKED_RUNS) {
				if (!limited) {
					limited = true;
					setStatus(`${progressLine()} · ${copy.publicProgress} · ${copy.limited}`);
					render();
				}
				return;
			}
			outcomes.set(key, null);
		}
		const at = Date.parse(event.at);
		if (existing && event.type !== "run_graded" && (existing.finished || event.type === "run_started" || at < existing.at)) return;
		const phaseKey = run.evalRunId ?? key;
		const phase = phases.get(phaseKey) ?? { total: 0, seen: 0 };
		if (!existing) phase.seen += 1;
		const size = Math.max(phase.total, Number.isSafeInteger(run.total) && run.total > 0 ? run.total : 0, phase.seen);
		publicTotal = Math.min(Number.MAX_SAFE_INTEGER, publicTotal + (size - phase.total));
		phase.total = size;
		phases.set(phaseKey, phase);
		progress = { taskId: run.taskId };
		const activity: Activity = existing ?? { taskId: run.taskId, line: t("trace.activity.started"), answer: "", control: "", at: 0, finished: false };
		activity.at = Number.isFinite(at) ? at : activity.at;
		running.set(key, activity);
		switch (event.type) {
			case "run_started":
				status(t("status.started"));
				break;
			case "assistant_delta":
				status(t("status.assistant"));
				appendAnswer(activity, event.delta);
				if (event.truncated) activity.answer = `${activity.answer}${t("trace.truncated")}`.slice(-MAX_ANSWER_CHARS);
				activity.line = t("trace.prefix.assistant");
				break;
			case "tool_started":
				status(t("status.tool", { tool: oneLine(event.toolName, MAX_CASE_CHARS) }));
				activity.answer = "";
				activity.control = "";
				activity.line = oneLine(`${t("trace.prefix.tool-call", { tool: oneLine(event.toolName, MAX_CASE_CHARS) })}${event.arguments}${event.truncated ? t("trace.truncated") : ""}`, MAX_ACTIVITY_CHARS);
				break;
			case "tool_finished":
				status(t(event.isError ? "status.tool-failed" : "status.tool-done", { tool: oneLine(event.toolName, MAX_CASE_CHARS) }));
				activity.answer = "";
				activity.control = "";
				activity.line = oneLine(`${t(event.isError ? "trace.prefix.tool-failed" : "trace.prefix.tool-done", { tool: oneLine(event.toolName, MAX_CASE_CHARS) })}${event.output}${event.truncated ? t("trace.truncated") : ""}`, MAX_ACTIVITY_CHARS);
				break;
			case "execution_finished": {
				const outcome = t(event.status === "error" ? "trace.errored" : "trace.completed");
				status(outcome);
				activity.answer = "";
				activity.control = "";
				activity.finished = true;
				activity.line = oneLine(`${outcome}${event.error ? ` · ${event.error}` : ""}`, MAX_ACTIVITY_CHARS);
				break;
			}
			case "run_graded":
				running.delete(key);
				outcomes.set(key, event.outcome);
				counts.graded += 1;
				counts[event.outcome] += 1;
				status(t("status.graded", { outcome: verdictLabel(event.outcome) }));
				last = oneLine(t("trace.last", {
					mark: CELL[event.outcome],
					task: shortTaskId(run.taskId),
					outcome: verdictLabel(event.outcome),
					passed: event.passedGraders,
					total: event.totalGraders,
				}), MAX_ACTIVITY_CHARS);
				break;
		}
		render();
	};

	setStatus(t("status.run-starting"));
	render();

	return {
		onRunEvent,
		plan(executions) {
			if (disposed) return;
			if (typeof executions === "number" && Number.isSafeInteger(executions) && executions > 0) planned = Math.max(planned ?? 0, executions);
			render();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			running.clear();
			outcomes.clear();
			phases.clear();
			safely(() => ui.setStatus(UI_KEY, undefined));
			safely(() => ui.setWidget(UI_KEY, undefined));
		},
	};
}
