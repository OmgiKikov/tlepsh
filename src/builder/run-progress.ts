import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { t, verdictLabel } from "../i18n.js";
import type { RunEvent, RunEventListener } from "../run-events.js";
import { bar, percent, shortTaskId } from "./render/format.js";
import { sanitizeTerminalText } from "../trace.js";

const UI_KEY = "ahde-run-progress";
// Pi renders at most ten entries from a string-array widget.
const MAX_WIDGET_LINES = 10;
const MAX_WIDGET_BYTES = 32 * 1024;
const MAX_LINE_BYTES = 8 * 1024;

type RunProgressUi = Pick<ExtensionUIContext, "setStatus" | "setWidget">;

export interface RunProgressPresenter {
	onRunEvent: RunEventListener;
	/**
	 * Planned Target executions for the whole job, as the estimate the human
	 * gate priced states them: both arms over the development basket and the
	 * sealed exam, plus the cheap-check screen when one runs. Without it the
	 * denominator is one eval run's own total, which a two-arm verification
	 * blows past — `graded 180/90`.
	 */
	plan(executions: number | null): void;
	dispose(): void;
}

export interface RunProgressPresenterOptions {
	liveTraceUrl?: string;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function truncateEnd(value: string, maxBytes: number): string {
	if (byteLength(value) <= maxBytes) return value;
	const suffix = "…";
	const budget = Math.max(0, maxBytes - byteLength(suffix));
	const kept: string[] = [];
	let used = 0;
	for (const character of value) {
		const size = byteLength(character);
		if (used + size > budget) break;
		kept.push(character);
		used += size;
	}
	return `${kept.join("")}${budget < maxBytes ? suffix : ""}`;
}

function truncateStart(value: string, maxBytes: number): string {
	if (byteLength(value) <= maxBytes) return value;
	const prefix = "…";
	const budget = Math.max(0, maxBytes - byteLength(prefix));
	const kept: string[] = [];
	let used = 0;
	for (const character of Array.from(value).reverse()) {
		const size = byteLength(character);
		if (used + size > budget) break;
		kept.push(character);
		used += size;
	}
	return `${budget < maxBytes ? prefix : ""}${kept.reverse().join("")}`;
}

function splitLines(value: string): string[] {
	return sanitizeTerminalText(value).split("\n");
}

function fitLine(prefix: string, body: string, fromStart = false): string {
	const safePrefix = sanitizeTerminalText(prefix).replace(/\n/g, " ");
	const safeBody = sanitizeTerminalText(body).replace(/\n/g, " ");
	const bodyBudget = Math.max(0, MAX_LINE_BYTES - byteLength(safePrefix));
	return `${safePrefix}${fromStart ? truncateStart(safeBody, bodyBudget) : truncateEnd(safeBody, bodyBudget)}`;
}

function widgetBytes(lines: readonly string[]): number {
	return byteLength(lines.join("\n"));
}

function safely(action: () => void): void {
	try {
		action();
	} catch {
		// Live presentation is observational and must never change the run result.
	}
}

export function createRunProgressPresenter(
	ui: RunProgressUi,
	options: RunProgressPresenterOptions = {},
): RunProgressPresenter {
	const assistantPrefix = t("trace.prefix.assistant");
	const frameHeader = [
		t("trace.header"),
		...(options.liveTraceUrl ? [t("trace.open-live", { url: sanitizeTerminalText(options.liveTraceUrl) })] : []),
	];
	const maxTraceLines = MAX_WIDGET_LINES - frameHeader.length;
	const traceLines: string[] = [];
	let assistantOpen: string | null = null;
	let currentStatus: string | undefined;
	let disposed = false;

	const trim = (): void => {
		while (traceLines.length > maxTraceLines) traceLines.shift();
		while (traceLines.length > 1 && widgetBytes([...frameHeader, ...traceLines]) > MAX_WIDGET_BYTES) {
			traceLines.shift();
		}
	};

	const render = (): void => {
		trim();
		safely(() => ui.setWidget(UI_KEY, [...frameHeader, ...traceLines], { placement: "aboveEditor" }));
	};

	const setStatus = (status: string): void => {
		const safeStatus = sanitizeTerminalText(status).replace(/\n/g, " ");
		if (safeStatus === currentStatus) return;
		currentStatus = safeStatus;
		safely(() => ui.setStatus(UI_KEY, safeStatus));
	};

	const appendBlock = (prefix: string, value: string): void => {
		assistantOpen = null;
		for (const line of splitLines(value)) traceLines.push(fitLine(prefix, line));
		render();
	};

	// Concurrent runs interleave, so an open assistant line may only be
	// continued by the run that opened it; anything else starts its own line.
	const appendAssistant = (runId: string, delta: string, truncated: boolean): void => {
		const chunks = splitLines(`${delta}${truncated ? t("trace.truncated") : ""}`);
		const first = chunks.shift() ?? "";
		if (assistantOpen === runId && traceLines.length > 0) {
			const previous = traceLines.at(-1) ?? assistantPrefix;
			const previousBody = previous.startsWith(assistantPrefix)
				? previous.slice(assistantPrefix.length)
				: previous;
			traceLines[traceLines.length - 1] = fitLine(assistantPrefix, `${previousBody}${first}`, true);
		} else {
			traceLines.push(fitLine(assistantPrefix, first, true));
		}
		for (const chunk of chunks) traceLines.push(fitLine(assistantPrefix, chunk, true));
		assistantOpen = runId;
		render();
	};

	const counts = { pass: 0, fail: 0, error: 0, graded: 0 };
	// Executions overlap, so "where we are" is how many are graded and how many
	// are still in flight — the ordinal of whichever run reported last is noise.
	const running = new Set<string>();
	let progress: { total: number; taskId: string } | null = null;
	// The job's own planned total, once the gate that priced it approved.
	let planned: number | null = null;
	const progressBar = (done: number, total: number, width = 12): string => {
		const share = total > 0 ? done / total : 0;
		return `${bar(share, width)} ${percent(share)}`;
	};
	const tally = (): string => `✓${counts.pass} ✗${counts.fail}${counts.error > 0 ? ` !${counts.error}` : ""}`;
	const progressLine = (): string => {
		if (!progress) return t("status.run-starting");
		// Never claim fewer planned executions than have already been graded: an
		// estimate that undercounts shrinks the bar, it does not lie about it.
		const total = Math.max(planned ?? progress.total, counts.graded);
		return t("status.run-progress", {
			graded: counts.graded,
			total,
			running: running.size,
			bar: progressBar(counts.graded, total),
			tally: tally(),
			task: shortTaskId(progress.taskId),
		});
	};
	const status = (activity: string): void => {
		setStatus(t("status.activity", { line: progressLine(), activity }));
	};
	const position = (event: RunEvent): string => `${event.run.ordinal}/${event.run.total}`;
	const onRunEvent: RunEventListener = (event) => {
		if (disposed) return;
		const run = position(event);
		progress = { total: event.run.total, taskId: event.run.taskId };
		switch (event.type) {
			case "run_started":
				running.add(event.run.runId);
				status(t("status.started"));
				appendBlock(t("trace.prefix.run"), t("trace.started", { position: run, task: shortTaskId(event.run.taskId) }));
				break;
			case "assistant_delta":
				status(t("status.assistant"));
				appendAssistant(event.run.runId, event.delta, event.truncated);
				break;
			case "tool_started":
				status(t("status.tool", { tool: event.toolName }));
				appendBlock(
					t("trace.prefix.tool-call", { tool: event.toolName }),
					`${event.arguments}${event.truncated ? t("trace.truncated") : ""}`,
				);
				break;
			case "tool_finished":
				status(t(event.isError ? "status.tool-failed" : "status.tool-done", { tool: event.toolName }));
				appendBlock(
					t(event.isError ? "trace.prefix.tool-failed" : "trace.prefix.tool-done", { tool: event.toolName }),
					`${event.output}${event.truncated ? t("trace.truncated") : ""}`,
				);
				break;
			case "execution_finished": {
				const outcome = t(event.status === "error" ? "trace.errored" : "trace.completed");
				status(outcome);
				appendBlock(t("trace.prefix.run"), `${outcome}${event.error ? ` · ${event.error}` : ""}`);
				break;
			}
			case "run_graded":
				running.delete(event.run.runId);
				counts.graded += 1;
				counts[event.outcome] += 1;
				status(t("status.graded", { outcome: verdictLabel(event.outcome) }));
				appendBlock(
					t("trace.prefix.grade", { mark: event.outcome === "pass" ? "✓" : event.outcome === "fail" ? "✗" : "!" }),
					t("trace.graded", {
						outcome: verdictLabel(event.outcome),
						passed: event.passedGraders,
						total: event.totalGraders,
						tally: tally(),
					}),
				);
				break;
		}
	};

	setStatus(t("status.run-starting"));
	render();

	return {
		onRunEvent,
		plan(executions) {
			if (typeof executions === "number" && executions > 0) planned = Math.max(planned ?? 0, executions);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			safely(() => ui.setStatus(UI_KEY, undefined));
			safely(() => ui.setWidget(UI_KEY, undefined));
		},
	};
}
