import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { GraderResult, RunMetrics, RunRecord } from "./provenance.js";
import { canonicalJson } from "./provenance.js";
import { redactTraceText } from "./trace.js";

/** Maximum projected assistant/tool payload carried by one observational event. */
export const RUN_EVENT_MAX_TEXT_CHARS = 4_096;
/** Maximum projected execution error carried by one observational event. */
export const RUN_EVENT_MAX_ERROR_CHARS = 2_000;
/** Maximum tool identifier length carried by one observational event. */
export const RUN_EVENT_MAX_IDENTIFIER_CHARS = 200;

export interface RunEventIdentity {
	evalRunId: string | null;
	runId: string;
	taskId: string;
	repetitionIndex: number;
	/** One-based position within tasks × repetitions. */
	ordinal: number;
	/** Total executions in tasks × repetitions. */
	total: number;
}

interface RunEventBase {
	at: string;
	run: RunEventIdentity;
}

export interface RunStartedEvent extends RunEventBase {
	type: "run_started";
}

export interface AssistantDeltaEvent extends RunEventBase {
	type: "assistant_delta";
	delta: string;
	truncated: boolean;
}

export interface ToolStartedEvent extends RunEventBase {
	type: "tool_started";
	toolCallId: string;
	toolName: string;
	arguments: string;
	truncated: boolean;
}

export interface ToolFinishedEvent extends RunEventBase {
	type: "tool_finished";
	toolCallId: string;
	toolName: string;
	isError: boolean;
	output: string;
	truncated: boolean;
}

export interface ExecutionFinishedEvent extends RunEventBase {
	type: "execution_finished";
	status: "completed" | "error";
	error: string | null;
	metrics: RunMetrics;
}

export interface RunGradedEvent extends RunEventBase {
	type: "run_graded";
	outcome: "pass" | "fail" | "error";
	passedGraders: number;
	totalGraders: number;
}

export type RunEvent =
	| RunStartedEvent
	| AssistantDeltaEvent
	| ToolStartedEvent
	| ToolFinishedEvent
	| ExecutionFinishedEvent
	| RunGradedEvent;

/**
 * Synchronous, observational callback. Listener failures never affect a run
 * or the evidence written for it.
 */
export type RunEventListener = (event: RunEvent) => void;

export interface ProjectedRunEventText {
	text: string;
	truncated: boolean;
}

function serializeEventValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		const serialized = canonicalJson(value);
		if (typeof serialized === "string") return serialized;
	} catch {
		// Fall through to a representation which cannot retain object fields.
	}
	try {
		return String(value);
	} catch {
		return "[unserializable]";
	}
}

/**
 * Tool results may carry arbitrary host-only `details`, usage, images, and
 * future provider fields. Only text content explicitly intended for the model
 * is eligible for the live human projection.
 */
function toolResultText(result: unknown): string {
	if (typeof result !== "object" || result === null || !("content" in result)) return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => (
			typeof part === "object" &&
			part !== null &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string"
		))
		.map((part) => part.text)
		.join("\n");
}

/** Deterministic best-effort serialization, shared redaction, then a hard bound. */
export function projectRunEventText(
	value: unknown,
	maxChars = RUN_EVENT_MAX_TEXT_CHARS,
): ProjectedRunEventText {
	if (!Number.isInteger(maxChars) || maxChars < 0) {
		throw new Error(`run event text bound must be a non-negative integer, got ${maxChars}`);
	}
	const redacted = redactTraceText(serializeEventValue(value));
	return {
		text: redacted.slice(0, maxChars),
		truncated: redacted.length > maxChars,
	};
}

function eventIdentity(run: RunEventIdentity): RunEventIdentity {
	return { ...run };
}

function eventAt(): string {
	return new Date().toISOString();
}

/** Invoke a listener immediately, swallowing throws and rejected async returns. */
export function emitRunEvent(listener: RunEventListener | undefined, event: RunEvent): void {
	if (!listener) return;
	try {
		const returned = listener(event) as unknown;
		if (
			typeof returned === "object" && returned !== null &&
			"then" in returned && typeof (returned as { then?: unknown }).then === "function"
		) {
			void Promise.resolve(returned).catch(() => undefined);
		}
	} catch {
		// Observability is deliberately best-effort.
	}
}

export function emitRunStarted(listener: RunEventListener | undefined, run: RunEventIdentity): void {
	emitRunEvent(listener, { type: "run_started", at: eventAt(), run: eventIdentity(run) });
}

/**
 * Forward only explicitly allowed Pi session observations. Assistant text is
 * projected at message_end so redaction sees the whole text even when a secret
 * crossed provider token boundaries. User/system messages, thinking/tool-call
 * blocks, and provider fields are never copied into the public event.
 */
export function observeRunSessionEvent(
	listener: RunEventListener | undefined,
	run: RunEventIdentity,
	event: AgentSessionEvent,
): void {
	if (event.type === "message_end" && event.message.role === "assistant") {
		const completeText = event.message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("");
		if (!completeText) return;
		const delta = projectRunEventText(completeText);
		emitRunEvent(listener, {
			type: "assistant_delta",
			at: eventAt(),
			run: eventIdentity(run),
			delta: delta.text,
			truncated: delta.truncated,
		});
		return;
	}
	if (event.type === "tool_execution_start") {
		const toolCallId = projectRunEventText(event.toolCallId, RUN_EVENT_MAX_IDENTIFIER_CHARS);
		const toolName = projectRunEventText(event.toolName, RUN_EVENT_MAX_IDENTIFIER_CHARS);
		const args = projectRunEventText(event.args);
		emitRunEvent(listener, {
			type: "tool_started",
			at: eventAt(),
			run: eventIdentity(run),
			toolCallId: toolCallId.text,
			toolName: toolName.text,
			arguments: args.text,
			truncated: toolCallId.truncated || toolName.truncated || args.truncated,
		});
		return;
	}
	if (event.type === "tool_execution_end") {
		const toolCallId = projectRunEventText(event.toolCallId, RUN_EVENT_MAX_IDENTIFIER_CHARS);
		const toolName = projectRunEventText(event.toolName, RUN_EVENT_MAX_IDENTIFIER_CHARS);
		const output = projectRunEventText(toolResultText(event.result));
		emitRunEvent(listener, {
			type: "tool_finished",
			at: eventAt(),
			run: eventIdentity(run),
			toolCallId: toolCallId.text,
			toolName: toolName.text,
			isError: event.isError,
			output: output.text,
			truncated: toolCallId.truncated || toolName.truncated || output.truncated,
		});
	}
}

export function emitExecutionFinished(
	listener: RunEventListener | undefined,
	run: RunEventIdentity,
	record: RunRecord,
): void {
	if (record.status === "running") {
		throw new Error("cannot emit execution_finished for a running record");
	}
	const projectedError = record.error === null
		? null
		: projectRunEventText(record.error, RUN_EVENT_MAX_ERROR_CHARS).text;
	emitRunEvent(listener, {
		type: "execution_finished",
		at: eventAt(),
		run: eventIdentity(run),
		status: record.status,
		error: projectedError,
		metrics: {
			...record.metrics,
			tokens: { ...record.metrics.tokens },
		},
	});
}

export function emitRunGraded(
	listener: RunEventListener | undefined,
	run: RunEventIdentity,
	outcome: "pass" | "fail" | "error",
	graders: readonly GraderResult[],
	totalGraders = graders.length,
): void {
	emitRunEvent(listener, {
		type: "run_graded",
		at: eventAt(),
		run: eventIdentity(run),
		outcome,
		passedGraders: graders.filter((grader) => grader.passed).length,
		totalGraders,
	});
}
