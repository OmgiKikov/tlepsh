import { appendFileSync, chmodSync, closeSync, openSync, readFileSync } from "node:fs";
import { parseSessionJsonl } from "../trace.js";

/**
 * A command Target's transcript, written as canonical session JSONL.
 *
 * `trace.ts` is the ONLY module allowed to parse Pi session JSONL, and that
 * stays true here: rather than teach it a second format, the command backend
 * writes a strict SUBSET of the one it already accepts. Nothing downstream —
 * graders, the bundle renderer, compare — learns that this run had a different
 * agent behind it.
 *
 * The guarantee is not "we intended to write valid JSONL". At `finalize` the
 * file is read back and re-parsed through `parseSessionJsonl`, and a run whose
 * own trace the canonical parser rejects fails rather than completing with
 * evidence nobody can read (invariant 43).
 */

export interface WrittenToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

type ContentPart =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export class SessionJsonlWriter {
	private readonly path: string;
	private bytes = 0;
	private closed = false;

	constructor(path: string, private readonly maxBytes: number) {
		this.path = path;
		// Created empty and private before a single byte of agent output reaches
		// it: a trace is protected evidence from the moment the file exists.
		closeSync(openSync(path, "w", 0o600));
		chmodSync(path, 0o600);
	}

	private append(entry: unknown): void {
		if (this.closed) throw new Error("command Target trace is already finalized");
		const line = `${JSON.stringify(entry)}\n`;
		const size = Buffer.byteLength(line, "utf8");
		if (this.bytes + size > this.maxBytes) {
			throw new Error(`command Target output exceeded ${this.maxBytes} trace bytes`);
		}
		appendFileSync(this.path, line, { encoding: "utf8", mode: 0o600 });
		this.bytes += size;
	}

	private message(message: Record<string, unknown>): void {
		this.append({ type: "message", message });
	}

	user(text: string): void {
		this.message({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	}

	/**
	 * One assistant message. Thinking and tool calls travel as content parts in
	 * exactly the shape `blockThinking`/`blockToolCalls` read, so a `tool_called`
	 * grader over a command run reads the same structure as over a Pi run.
	 */
	assistant(options: { text?: string; thinking?: string; toolCalls?: readonly WrittenToolCall[] }): void {
		const content: ContentPart[] = [];
		if (options.thinking) content.push({ type: "thinking", thinking: options.thinking });
		if (options.text) content.push({ type: "text", text: options.text });
		for (const call of options.toolCalls ?? []) {
			content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
		}
		this.message({ role: "assistant", content, timestamp: Date.now() });
	}

	toolResult(options: { toolCallId: string; toolName: string; text: string; isError: boolean }): void {
		this.message({
			role: "toolResult",
			toolCallId: options.toolCallId,
			toolName: options.toolName,
			content: [{ type: "text", text: options.text }],
			isError: options.isError,
			timestamp: Date.now(),
		});
	}

	/** Bytes written so far. The session uses it to bound total agent output. */
	get byteLength(): number {
		return this.bytes;
	}

	/**
	 * Re-read the file through the canonical parser. A trace this build wrote
	 * that `trace.ts` refuses is an infrastructure failure of AHDE itself, and
	 * saying so here is cheaper than discovering it in a grader three commands
	 * later.
	 */
	finalize(): void {
		this.closed = true;
		chmodSync(this.path, 0o600);
		try {
			parseSessionJsonl(readFileSync(this.path, "utf8"));
		} catch (error) {
			throw new Error(
				`command Target trace is not canonical session JSONL: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
