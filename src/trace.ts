import { readFileSync } from "node:fs";
import { join } from "node:path";

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

export function parseSessionJsonl(content: string): TraceMessage[] {
	const messages: TraceMessage[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: SessionEntry;
		try {
			entry = JSON.parse(trimmed) as SessionEntry;
		} catch {
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

export function openTrace(runDir: string, tracePath = "session.jsonl"): TraceMessage[] {
	return parseSessionJsonl(readFileSync(join(runDir, tracePath), "utf8"));
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

/** Final assistant text of the conversation (the agent's answer). */
export function lastAssistantText(messages: TraceMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message?.role === "assistant" && message.text.trim().length > 0) return message.text;
	}
	return undefined;
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
