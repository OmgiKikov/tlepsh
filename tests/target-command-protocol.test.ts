import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CommandProtocolError,
	COMMAND_PROTOCOL_VERSION,
	encodeHostMessage,
	MAX_PROTOCOL_LINE_BYTES,
	parseAgentLine,
} from "../src/target/command-protocol.js";
import { SessionJsonlWriter } from "../src/target/session-jsonl-writer.js";
import { parseSessionJsonl } from "../src/trace.js";

/**
 * The wire, and the trace it produces.
 *
 * Two promises are under test. The codecs admit exactly one dialect — an
 * unknown type, another version or an oversized line is a violation that names
 * a line NUMBER and never the line body. And the writer's output is a strict
 * subset of what `trace.ts` already parses, so a command run's evidence needs
 * no second parser anywhere downstream.
 */

const roots: string[] = [];

function writer(maxBytes = 1024 * 1024): { writer: SessionJsonlWriter; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "ahde-jsonl-"));
	roots.push(dir);
	const path = join(dir, "session.jsonl");
	return { writer: new SessionJsonlWriter(path, maxBytes), path };
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("protocol v1 codecs", () => {
	it("round-trips every host message the adapter can send", () => {
		const messages = [
			{
				v: 1 as const,
				type: "hello" as const,
				tools: [{ name: "get_account", description: "Данные абонента.", parameters: { type: "object" } }],
				model: { provider: "openai-compatible", id: "m", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "K" },
				workspace: "/tmp/workspace",
				world: null,
			},
			{ v: 1 as const, type: "user" as const, turn: 1, text: "Сколько стоит тариф?" },
			{ v: 1 as const, type: "user" as const, turn: 1, text: "…", recovery: true as const },
			{ v: 1 as const, type: "tool_result" as const, id: "c1", name: "get_account", text: "ok", isError: false },
			{ v: 1 as const, type: "cancel" as const },
		];
		for (const message of messages) {
			const line = encodeHostMessage(message);
			expect(line.endsWith("\n")).toBe(true);
			expect(JSON.parse(line)).toEqual(message);
		}
	});

	it("accepts every agent message the adapter can read", () => {
		expect(parseAgentLine(JSON.stringify({ v: 1, type: "assistant", turn: 2, text: "да" }), 1)).toEqual({
			v: 1, type: "assistant", turn: 2, text: "да",
		});
		expect(parseAgentLine(JSON.stringify({ v: 1, type: "tool_call", id: "c1", name: "t", arguments: { a: 1 } }), 1).type)
			.toBe("tool_call");
		expect(parseAgentLine(JSON.stringify({ v: 1, type: "tool_note", name: "t", arguments: {}, result: "r" }), 1).type)
			.toBe("tool_note");
		expect(parseAgentLine(
			JSON.stringify({ v: 1, type: "usage", turn: 1, tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } }),
			1,
		).type).toBe("usage");
		expect(parseAgentLine(JSON.stringify({ v: 1, type: "error", message: "нет" }), 1).type).toBe("error");
	});

	it("refuses everything else, naming the line and never quoting it", () => {
		const refusals: [string, number][] = [
			["not json at all", 3],
			[JSON.stringify({ v: 2, type: "assistant", turn: 1, text: "x" }), 4],
			[JSON.stringify({ v: 1, type: "sing", turn: 1 }), 5],
			[JSON.stringify({ v: 1, type: "assistant", turn: 0, text: "x" }), 6],
			[JSON.stringify({ v: 1, type: "assistant", turn: 1, text: "x", extra: true }), 7],
			[JSON.stringify({ v: 1, type: "tool_call", id: "c", name: "t", arguments: "not an object" }), 8],
		];
		for (const [raw, line] of refusals) {
			let thrown: unknown;
			try {
				parseAgentLine(raw, line);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(CommandProtocolError);
			expect((thrown as CommandProtocolError).message).toBe(`command Target protocol violation at line ${line}`);
			// The body of a malformed line is model-controlled text. It never
			// reaches a message a human or a log will read.
			expect((thrown as CommandProtocolError).message).not.toContain(raw.slice(0, 12));
		}
	});

	it("bounds a line in both directions", () => {
		const huge = "x".repeat(MAX_PROTOCOL_LINE_BYTES + 1);
		expect(() => parseAgentLine(huge, 9)).toThrow(/protocol violation at line 9/);
		expect(() => encodeHostMessage({ v: COMMAND_PROTOCOL_VERSION, type: "user", turn: 1, text: huge }))
			.toThrow(/exceeds 1048576 bytes/);
	});
});

describe("the canonical trace a command Target writes", () => {
	it("re-parses through the one canonical parser, in the shape a Pi run has", () => {
		const { writer: sink, path } = writer();
		sink.user("Договор 42?");
		sink.assistant({ toolCalls: [{ id: "c1", name: "check", arguments: { id: "42" } }] });
		sink.toolResult({ toolCallId: "c1", toolName: "check", text: "limits: none", isError: false });
		sink.assistant({ text: "Ограничений нет.", thinking: "смотрю в инструмент" });
		sink.finalize();

		const messages = parseSessionJsonl(readFileSync(path, "utf8"));
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(messages[1]?.toolCalls).toEqual([{ id: "c1", name: "check", arguments: { id: "42" } }]);
		expect(messages[2]?.toolResult).toEqual({
			toolCallId: "c1",
			toolName: "check",
			text: "limits: none",
			isError: false,
		});
		expect(messages[3]?.text).toBe("Ограничений нет.");
		expect(messages[3]?.thinking).toBe("смотрю в инструмент");
		// Protected evidence from the moment the file exists.
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("bounds total output and refuses to be written after it is finalized", () => {
		const { writer: sink } = writer(200);
		expect(() => sink.assistant({ text: "x".repeat(500) })).toThrow(/exceeded 200 trace bytes/);
		const { writer: closed } = writer();
		closed.user("да");
		closed.finalize();
		expect(() => closed.user("ещё")).toThrow(/already finalized/);
	});

	it("keeps an error toolResult visible as one, so a grader counts it", () => {
		const { writer: sink, path } = writer();
		sink.assistant({ toolCalls: [{ id: "c1", name: "nope", arguments: {} }] });
		sink.toolResult({ toolCallId: "c1", toolName: "nope", text: "blocked", isError: true });
		sink.finalize();
		const messages = parseSessionJsonl(readFileSync(path, "utf8"));
		expect(messages[1]?.toolResult?.isError).toBe(true);
	});
});
