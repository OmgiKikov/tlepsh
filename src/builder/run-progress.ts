import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { RunEvent, RunEventListener } from "../run-events.js";

const UI_KEY = "ahde-run-progress";
const HEADER = "AHDE · provisional development trace";
const MAX_WIDGET_LINES = 40;
const MAX_WIDGET_BYTES = 32 * 1024;
const MAX_TRACE_LINES = MAX_WIDGET_LINES - 1;
const MAX_LINE_BYTES = 8 * 1024;
const ASSISTANT_PREFIX = "assistant · ";

type RunProgressUi = Pick<ExtensionUIContext, "setStatus" | "setWidget">;

export interface RunProgressPresenter {
	onRunEvent: RunEventListener;
	dispose(): void;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

/**
 * Run text is untrusted. Strip terminal control strings before they reach Pi's
 * renderer so a Target cannot spoof the TUI or write through OSC/APC channels.
 */
function sanitizeTerminalText(value: string): string {
	return value
		.replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, "")
		.replace(/[\u009D][\s\S]*?(?:\u0007|\u009C)/g, "")
		.replace(/\u001B[PX^_][\s\S]*?\u001B\\/g, "")
		.replace(/[\u0090\u0098\u009E\u009F][\s\S]*?\u009C/g, "")
		.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u009B[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001B[ -/]*[0-~]/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
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

export function createRunProgressPresenter(ui: RunProgressUi): RunProgressPresenter {
	const traceLines: string[] = [];
	let assistantOpen = false;
	let currentStatus: string | undefined;
	let disposed = false;

	const trim = (): void => {
		while (traceLines.length > MAX_TRACE_LINES) traceLines.shift();
		while (traceLines.length > 1 && widgetBytes([HEADER, ...traceLines]) > MAX_WIDGET_BYTES) {
			traceLines.shift();
		}
	};

	const render = (): void => {
		trim();
		safely(() => ui.setWidget(UI_KEY, [HEADER, ...traceLines], { placement: "aboveEditor" }));
	};

	const setStatus = (status: string): void => {
		const safeStatus = sanitizeTerminalText(status).replace(/\n/g, " ");
		if (safeStatus === currentStatus) return;
		currentStatus = safeStatus;
		safely(() => ui.setStatus(UI_KEY, safeStatus));
	};

	const appendBlock = (prefix: string, value: string): void => {
		assistantOpen = false;
		for (const line of splitLines(value)) traceLines.push(fitLine(prefix, line));
		render();
	};

	const appendAssistant = (delta: string, truncated: boolean): void => {
		const chunks = splitLines(`${delta}${truncated ? " …[truncated]" : ""}`);
		const first = chunks.shift() ?? "";
		if (assistantOpen && traceLines.length > 0) {
			const previous = traceLines.at(-1) ?? ASSISTANT_PREFIX;
			const previousBody = previous.startsWith(ASSISTANT_PREFIX)
				? previous.slice(ASSISTANT_PREFIX.length)
				: previous;
			traceLines[traceLines.length - 1] = fitLine(ASSISTANT_PREFIX, `${previousBody}${first}`, true);
		} else {
			traceLines.push(fitLine(ASSISTANT_PREFIX, first, true));
		}
		for (const chunk of chunks) traceLines.push(fitLine(ASSISTANT_PREFIX, chunk, true));
		assistantOpen = true;
		render();
	};

	const position = (event: RunEvent): string => `${event.run.ordinal}/${event.run.total}`;
	const onRunEvent: RunEventListener = (event) => {
		if (disposed) return;
		const run = position(event);
		switch (event.type) {
			case "run_started":
				setStatus(`AHDE run ${run} · started`);
				appendBlock("run · ", `started ${run}`);
				break;
			case "assistant_delta":
				setStatus(`AHDE run ${run} · assistant`);
				appendAssistant(event.delta, event.truncated);
				break;
			case "tool_started":
				setStatus(`AHDE run ${run} · tool ${event.toolName}`);
				appendBlock(
					`tool → ${event.toolName} · `,
					`${event.arguments}${event.truncated ? " …[truncated]" : ""}`,
				);
				break;
			case "tool_finished":
				setStatus(`AHDE run ${run} · tool ${event.toolName} ${event.isError ? "failed" : "done"}`);
				appendBlock(
					`tool ${event.isError ? "✗" : "✓"} ${event.toolName} · `,
					`${event.output}${event.truncated ? " …[truncated]" : ""}`,
				);
				break;
			case "execution_finished":
				setStatus(`AHDE run ${run} · ${event.status}`);
				appendBlock(
					"run · ",
					`${event.status}${event.error ? ` · ${event.error}` : ""}`,
				);
				break;
			case "run_graded":
				setStatus(`AHDE run ${run} · graded ${event.outcome}`);
				appendBlock(
					"grade · ",
					`${event.outcome} · ${event.passedGraders}/${event.totalGraders} graders`,
				);
				break;
		}
	};

	setStatus("AHDE run · starting");
	render();

	return {
		onRunEvent,
		dispose() {
			if (disposed) return;
			disposed = true;
			safely(() => ui.setStatus(UI_KEY, undefined));
			safely(() => ui.setWidget(UI_KEY, undefined));
		},
	};
}
