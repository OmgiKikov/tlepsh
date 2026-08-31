import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeArtifactSegment } from "./storage/paths.js";

/** Hard input bounds applied before a trace is accepted as canonical evidence. */
export const MAX_TRACE_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_TRACE_RECORDS = 25_000;

/**
 * The ONLY module allowed to parse Pi session JSONL. Every consumer of trace
 * content (graders, bundle renderer, compare) goes through here.
 */

export interface TraceToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface TraceToolResult {
	toolCallId: string;
	toolName: string;
	text: string;
	isError: boolean;
}

export interface TraceMessage {
	role: "user" | "assistant" | "toolResult";
	text: string;
	thinking?: string;
	toolCalls?: TraceToolCall[];
	toolResult?: TraceToolResult;
	timestamp?: number;
}

/**
 * Strip terminal control channels before text reaches either credential
 * redaction or a human-facing terminal renderer. Keeping this canonical avoids
 * a presentation layer rejoining a credential that was split with ANSI bytes
 * only after the redactor had already inspected it.
 */
export function sanitizeTerminalText(value: string): string {
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

/**
 * Remove common credential shapes before trace content crosses into a
 * human-facing projection. Raw protected evidence remains unchanged on disk.
 */
export function redactTraceText(text: string): string {
	return sanitizeTerminalText(text)
		.replace(
			/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g,
			"[REDACTED_PRIVATE_KEY]",
		)
		.replace(
			/((?:api[_-]?key|access[_-]?token|auth[_-]?token|github[_-]?token|aws[_-]?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key)|private[_-]?key|secret|password|token|[a-z0-9]+(?:[_-][a-z0-9]+)*[_-](?:key|token|secret|password))["']?\s*[:=]\s*["'])[^\r\n"']+(["'])/gi,
			"$1[REDACTED]$2",
		)
		.replace(
			/((?:api[_-]?key|access[_-]?token|auth[_-]?token|github[_-]?token|aws[_-]?(?:access[_-]?key[_-]?id|secret[_-]?access[_-]?key)|private[_-]?key|secret|password|token|[a-z0-9]+(?:[_-][a-z0-9]+)*[_-](?:key|token|secret|password))["']?\s*[:=]\s*)(?!["'])[^,\s;}\]]+/gi,
			"$1[REDACTED]",
		)
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
		.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
		.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]")
		.replace(/\b(sk-[A-Za-z0-9_-]{10,})\b/g, "[REDACTED_API_KEY]")
		.replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{10,}/gi, "$1[REDACTED_TOKEN]");
}

interface SessionEntry {
	type: string;
	message?: {
		role: string;
		content?: unknown;
		timestamp?: number;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
	};
}

export class TraceParseError extends Error {
	readonly line: number;

	constructor(line: number, message: string) {
		super(`trace line ${line}: ${message}`);
		this.name = "TraceParseError";
		this.line = line;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOptionalType(
	value: unknown,
	type: "string" | "number" | "boolean",
	field: string,
): void {
	if (value !== undefined && typeof value !== type) {
		throw new Error(`${field} must be ${type}`);
	}
}

function assertContent(content: unknown): void {
	if (typeof content === "string") return;
	if (!Array.isArray(content)) throw new Error("message.content must be a string or array");

	for (const [index, part] of content.entries()) {
		if (!isRecord(part) || typeof part.type !== "string") {
			throw new Error(`message.content[${index}] must be an object with a string type`);
		}
		if (part.type === "text" && typeof part.text !== "string") {
			throw new Error(`message.content[${index}].text must be string`);
		}
		if (part.type === "thinking" && typeof part.thinking !== "string") {
			throw new Error(`message.content[${index}].thinking must be string`);
		}
		if (part.type === "toolCall") {
			if (typeof part.id !== "string" || typeof part.name !== "string" || !isRecord(part.arguments)) {
				throw new Error(`message.content[${index}] toolCall requires string id/name and object arguments`);
			}
		}
	}
}

function validateEntry(value: unknown): SessionEntry {
	if (!isRecord(value) || typeof value.type !== "string") {
		throw new Error("entry must be an object with a string type");
	}
	if (value.type !== "message") return value as unknown as SessionEntry;
	if (!isRecord(value.message)) throw new Error("message entry requires a message object");

	const message = value.message;
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") {
		throw new Error(`unsupported message.role ${JSON.stringify(message.role)}`);
	}
	assertContent(message.content);
	assertOptionalType(message.timestamp, "number", "message.timestamp");

	if (message.role === "toolResult") {
		if (typeof message.toolCallId !== "string" || typeof message.toolName !== "string") {
			throw new Error("toolResult requires string toolCallId and toolName");
		}
		assertOptionalType(message.isError, "boolean", "message.isError");
	}

	return value as unknown as SessionEntry;
}

function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as { type?: string }).type === "text")
		.map((part) => part.text)
		.join("");
}

function blockThinking(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const thinking = content
		.filter((part): part is { type: "thinking"; thinking: string } => typeof part === "object" && part !== null && (part as { type?: string }).type === "thinking")
		.map((part) => part.thinking)
		.join("");
	return thinking || undefined;
}

function blockToolCalls(content: unknown): TraceToolCall[] | undefined {
	if (!Array.isArray(content)) return undefined;
	const calls = content.filter(
		(part): part is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } =>
			typeof part === "object" && part !== null && (part as { type?: string }).type === "toolCall",
	);
	if (calls.length === 0) return undefined;
	return calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments }));
}

function assertTraceContentBounds(content: string): void {
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_TRACE_ARTIFACT_BYTES) {
		throw new Error(`trace exceeds the ${MAX_TRACE_ARTIFACT_BYTES}-byte artifact limit`);
	}
	let physicalLines = content.length === 0 || content.endsWith("\n") ? 0 : 1;
	for (let index = 0; index < content.length; index += 1) {
		if (content.charCodeAt(index) === 10) physicalLines += 1;
		if (physicalLines > MAX_TRACE_RECORDS) {
			throw new Error(`trace exceeds the ${MAX_TRACE_RECORDS}-record artifact limit`);
		}
	}
}

function parseSessionJsonlInternal(content: string, strict: boolean): TraceMessage[] {
	assertTraceContentBounds(content);
	const messages: TraceMessage[] = [];
	for (const [lineIndex, line] of content.split("\n").entries()) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed) as unknown;
		} catch (error) {
			if (strict) {
				throw new TraceParseError(
					lineIndex + 1,
					`invalid JSON (${error instanceof Error ? error.message : String(error)})`,
				);
			}
			continue;
		}

		let entry: SessionEntry;
		try {
			entry = validateEntry(parsed);
		} catch (error) {
			if (strict) {
				throw new TraceParseError(lineIndex + 1, error instanceof Error ? error.message : String(error));
			}
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		if (message.role === "user") {
			messages.push({ role: "user", text: blockText(message.content), timestamp: message.timestamp });
		} else if (message.role === "assistant") {
			messages.push({
				role: "assistant",
				text: blockText(message.content),
				thinking: blockThinking(message.content),
				toolCalls: blockToolCalls(message.content),
				timestamp: message.timestamp,
			});
		} else if (message.role === "toolResult") {
			messages.push({
				role: "toolResult",
				text: blockText(message.content),
				toolResult: {
					toolCallId: message.toolCallId ?? "",
					toolName: message.toolName ?? "",
					text: blockText(message.content),
					isError: message.isError ?? false,
				},
				timestamp: message.timestamp,
			});
		}
	}
	return messages;
}

/** Strict evidence parser: malformed lines invalidate the whole trace. */
export function parseSessionJsonl(content: string): TraceMessage[] {
	return parseSessionJsonlInternal(content, true);
}

/** Best-effort parser for recovery/display only. Never use it for grading. */
export function parseSessionJsonlLenient(content: string): TraceMessage[] {
	return parseSessionJsonlInternal(content, false);
}

export function readTraceArtifact(
	runDir: string,
	tracePath = "session.jsonl",
	expectedSha256?: string,
): string {
	const safeTracePath = safeArtifactSegment(tracePath, "trace path");
	if (safeTracePath !== "session.jsonl") {
		throw new Error(`unsupported trace path ${JSON.stringify(tracePath)}; expected \"session.jsonl\"`);
	}
	const traceFile = join(runDir, safeTracePath);
	const entry = lstatSync(traceFile);
	if (!entry.isFile() || entry.isSymbolicLink()) {
		throw new Error(`trace must be a regular non-symlink file: ${traceFile}`);
	}
	if (entry.size > MAX_TRACE_ARTIFACT_BYTES) {
		throw new Error(`trace exceeds the ${MAX_TRACE_ARTIFACT_BYTES}-byte artifact limit`);
	}
	const content = readFileSync(traceFile, "utf8");
	assertTraceContentBounds(content);
	if (expectedSha256 !== undefined) {
		const actualSha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
		if (actualSha256 !== expectedSha256) {
			throw new Error(`trace SHA mismatch: expected ${expectedSha256}, got ${actualSha256}`);
		}
	}
	return content;
}

export function openTrace(
	runDir: string,
	tracePath = "session.jsonl",
	expectedSha256?: string,
): TraceMessage[] {
	return parseSessionJsonl(readTraceArtifact(runDir, tracePath, expectedSha256));
}

export function traceToolCalls(messages: TraceMessage[]): TraceToolCall[] {
	const calls: TraceToolCall[] = [];
	for (const message of messages) {
		if (message.toolCalls) calls.push(...message.toolCalls);
	}
	return calls;
}

export function traceToolErrors(messages: TraceMessage[]): number {
	return messages.filter((m) => m.role === "toolResult" && m.toolResult?.isError).length;
}

/** Text of the final assistant message. Earlier partial text is never an answer. */
export function lastAssistantText(messages: TraceMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role === "assistant") return message.text.trim().length > 0 ? message.text : undefined;
	}
	return undefined;
}

// ---------- Dialogue transcript ----------
// One bounded, credential-redacted rendering of a conversation, shared by the
// two models that are allowed to read one: the simulated user, which needs the
// turns so far to write the next one, and a judge grading a whole conversation
// instead of a single reply. Tool calls and tool results are deliberately not
// part of it — what a user sees is what the agent said.

/** Turns kept in a rendered transcript; older ones are dropped, not truncated. */
export const MAX_TRANSCRIPT_TURNS = 40;
/** Characters kept per turn. */
export const MAX_TRANSCRIPT_TURN_CHARS = 2_000;
/** Characters kept in the whole rendering. */
export const MAX_TRANSCRIPT_CHARS = 24_000;

const TRANSCRIPT_ELISION = "…(ранние реплики опущены)";

export interface TranscriptTurn {
	role: "user" | "assistant";
	text: string;
}

/**
 * The spoken turns of a trace: user messages and the assistant replies that
 * carry text. An assistant message that only emitted tool calls said nothing to
 * the user, so it is not a turn.
 */
export function dialogueTurns(messages: readonly TraceMessage[]): TranscriptTurn[] {
	const turns: TranscriptTurn[] = [];
	for (const message of messages) {
		if (message.role === "toolResult") continue;
		const text = message.text.trim();
		if (text.length === 0) continue;
		turns.push({ role: message.role, text });
	}
	return turns;
}

/** How many turns the agent itself took. What `turn_budget` counts. */
export function agentTurnCount(messages: readonly TraceMessage[]): number {
	return dialogueTurns(messages).filter((turn) => turn.role === "assistant").length;
}

function transcriptLine(turn: TranscriptTurn): string {
	const speaker = turn.role === "user" ? "Пользователь" : "Агент";
	const text = redactTraceText(turn.text).trim();
	const bounded = text.length <= MAX_TRANSCRIPT_TURN_CHARS
		? text
		: `${text.slice(0, MAX_TRANSCRIPT_TURN_CHARS - 1)}…`;
	return `${speaker}: ${bounded}`;
}

/**
 * Render a conversation for a model to read. Bounded from the front: the most
 * recent turns are the ones that decide the next reply and the ones a grader
 * reasons about, and an elision marker says plainly that something was dropped.
 */
export function renderDialogueTranscript(turns: readonly TranscriptTurn[]): string {
	const kept = turns.slice(-MAX_TRANSCRIPT_TURNS);
	let elided = kept.length < turns.length;
	const lines = kept.map(transcriptLine);
	let total = lines.reduce((sum, line) => sum + line.length + 1, 0);
	while (lines.length > 1 && total > MAX_TRANSCRIPT_CHARS) {
		total -= (lines.shift() ?? "").length + 1;
		elided = true;
	}
	if (elided) lines.unshift(TRANSCRIPT_ELISION);
	return lines.join("\n");
}

/**
 * Human/agent-readable render: message entries only (user text, assistant
 * text, toolCall name+args, toolResult text). Compaction, model changes and
 * other bookkeeping entries are intentionally omitted.
 */
export function renderTraceMarkdown(messages: TraceMessage[], maxResultChars = 600): string {
	const lines: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			lines.push(`### 👤 User`, "", message.text, "");
		} else if (message.role === "assistant") {
			if (message.text.trim()) {
				lines.push(`### 🤖 Assistant`, "", message.text, "");
			}
			if (message.toolCalls) {
				for (const call of message.toolCalls) {
					lines.push(`**tool_call:** \`${call.name}\`(${JSON.stringify(call.arguments)})`, "");
				}
			}
		} else if (message.role === "toolResult" && message.toolResult) {
			const flag = message.toolResult.isError ? " ⚠️ ERROR" : "";
			const text = message.toolResult.text.slice(0, maxResultChars);
			const ellipsis = message.toolResult.text.length > maxResultChars ? " …(truncated)" : "";
			lines.push(`**tool_result** \`${message.toolResult.toolName}\`${flag}:`, "", "```", text + ellipsis, "```", "");
		}
	}
	return lines.join("\n");
}
