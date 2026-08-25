import { describe, expect, it } from "vitest";
import { lastAssistantText, parseSessionJsonl, renderTraceMarkdown, traceToolCalls, traceToolErrors } from "../src/trace.js";

const SESSION = [
	'{"type":"session","version":3,"id":"uuid-1","timestamp":"2026-08-25T10:00:00.000Z","cwd":"/tmp/t"}',
	'{"type":"message","id":"a1","parentId":null,"timestamp":"...","message":{"role":"user","content":"Проверь договор 42","timestamp":1}}',
	'{"type":"message","id":"a2","parentId":"a1","timestamp":"...","message":{"role":"assistant","content":[{"type":"thinking","thinking":"надо проверить"},{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"bin/check_dbo"}}],"stopReason":"toolUse","timestamp":2}}',
	'{"type":"message","id":"a3","parentId":"a2","timestamp":"...","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"dbo_limits: none"}],"isError":false,"timestamp":3}}',
	'{"type":"message","id":"a4","parentId":"a3","timestamp":"...","message":{"role":"toolResult","toolCallId":"c2","toolName":"bash","content":[{"type":"text","text":"boom"}],"isError":true,"timestamp":4}}',
	'{"type":"message","id":"a5","parentId":"a4","timestamp":"...","message":{"role":"assistant","content":[{"type":"text","text":"Договор действующий. Ограничений нет."}],"stopReason":"stop","timestamp":5}}',
	'{"type":"compaction","id":"a6","parentId":"a5","timestamp":"...","summary":"...","tokensBefore":100}',
	'{"type":"model_change","id":"a7","parentId":"a6","timestamp":"...","provider":"p","modelId":"m"}',
].join("\n");

describe("trace parser", () => {
	const messages = parseSessionJsonl(SESSION);

	it("extracts message entries only (skips session/compaction/model_change)", () => {
		expect(messages).toHaveLength(5);
		expect(messages[0]?.role).toBe("user");
	});

	it("extracts tool calls from assistant content blocks", () => {
		const calls = traceToolCalls(messages);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ id: "c1", name: "bash", arguments: { command: "bin/check_dbo" } });
	});

	it("counts tool errors", () => {
		expect(traceToolErrors(messages)).toBe(1);
	});

	it("finds the last assistant text", () => {
		expect(lastAssistantText(messages)).toContain("Ограничений нет");
	});

	it("renders message-only markdown", () => {
		const markdown = renderTraceMarkdown(messages);
		expect(markdown).toContain("Проверь договор 42");
		expect(markdown).toContain("`bash`(");
		expect(markdown).toContain("dbo_limits: none");
		expect(markdown).toContain("⚠️ ERROR");
		expect(markdown).toContain("Договор действующий");
		// thinking is intentionally not rendered
		expect(markdown).not.toContain("надо проверить");
		// bookkeeping entries are not rendered
		expect(markdown).not.toContain("compaction");
	});
});
