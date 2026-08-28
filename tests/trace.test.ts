import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	lastAssistantText,
	openTrace,
	parseSessionJsonl,
	parseSessionJsonlLenient,
	redactTraceText,
	renderTraceMarkdown,
	traceToolCalls,
	traceToolErrors,
} from "../src/trace.js";

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

	it("redacts common credential shapes without changing protected trace artifacts", () => {
		expect(redactTraceText(
			'api_key="secret-value-123" password=plain-secret Bearer token-value-123456 sk-live-secret123',
		)).toBe('api_key="[REDACTED]" password=[REDACTED] Bearer [REDACTED_TOKEN] [REDACTED_API_KEY]');
	});

	it("redacts named tokens, provider prefixes, AWS keys, and private-key blocks", () => {
		const projected = redactTraceText([
			"GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890",
			"AUTH_TOKEN=auth-secret-value",
			"standalone ghp_abcdefghijklmnopqrstuvwxyz1234567890",
			"AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF",
			"-----BEGIN RSA PRIVATE KEY-----",
			"PRIVATE_KEY_CANARY",
			"-----END RSA PRIVATE KEY-----",
		].join("\n"));

		expect(projected).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
		expect(projected).not.toContain("auth-secret-value");
		expect(projected).not.toContain("AKIA1234567890ABCDEF");
		expect(projected).not.toContain("PRIVATE_KEY_CANARY");
		expect(projected).toContain("GITHUB_TOKEN=[REDACTED]");
		expect(projected).toContain("AUTH_TOKEN=[REDACTED]");
		expect(projected).toContain("AWS_ACCESS_KEY_ID=[REDACTED]");
		expect(projected).toContain("[REDACTED_PRIVATE_KEY]");
	});

	it("does not reuse earlier assistant text when the final assistant message is empty", () => {
		const parsed = parseSessionJsonl(
			[
				'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"partial"}]}}',
				'{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"no final answer"}]}}',
			].join("\n"),
		);
		expect(lastAssistantText(parsed)).toBeUndefined();
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

	it("rejects malformed JSON with its exact line instead of returning partial evidence", () => {
		const content = [
			'{"type":"message","message":{"role":"user","content":"valid","timestamp":1}}',
			'{"type":"message","message":',
		].join("\n");

		expect(() => parseSessionJsonl(content)).toThrow(/trace line 2: invalid JSON/);
		expect(parseSessionJsonlLenient(content)).toHaveLength(1);
	});

	it("rejects invalid message shapes with line-specific errors", () => {
		const content = [
			'{"type":"session","version":3}',
			'{"type":"message","message":{"role":"toolResult","content":"result"}}',
		].join("\n");

		expect(() => parseSessionJsonl(content)).toThrow(
			/trace line 2: toolResult requires string toolCallId and toolName/,
		);
	});

	it("openTrace accepts a valid trace when its expected SHA matches", () => {
		const runDir = mkdtempSync(join(tmpdir(), "ahde-trace-"));
		try {
			writeFileSync(join(runDir, "session.jsonl"), SESSION);
			const expectedSha = `sha256:${createHash("sha256").update(SESSION).digest("hex")}`;

			expect(openTrace(runDir, "session.jsonl", expectedSha)).toHaveLength(5);
		} finally {
			rmSync(runDir, { recursive: true, force: true });
		}
	});

	it("openTrace rejects a trace whose SHA does not match", () => {
		const runDir = mkdtempSync(join(tmpdir(), "ahde-trace-"));
		try {
			writeFileSync(join(runDir, "session.jsonl"), SESSION);

			expect(() => openTrace(runDir, "session.jsonl", `sha256:${"0".repeat(64)}`)).toThrow(
				/trace SHA mismatch/,
			);
		} finally {
			rmSync(runDir, { recursive: true, force: true });
		}
	});

	it("openTrace rejects traversal and symlinked evidence", () => {
		const runDir = mkdtempSync(join(tmpdir(), "ahde-trace-"));
		const outsideDir = mkdtempSync(join(tmpdir(), "ahde-trace-outside-"));
		try {
			writeFileSync(join(outsideDir, "session.jsonl"), SESSION);
			expect(() => openTrace(runDir, "../session.jsonl")).toThrow(/path separators and traversal are forbidden/);
			symlinkSync(join(outsideDir, "session.jsonl"), join(runDir, "session.jsonl"));
			expect(() => openTrace(runDir)).toThrow(/regular non-symlink file/);
		} finally {
			rmSync(runDir, { recursive: true, force: true });
			rmSync(outsideDir, { recursive: true, force: true });
		}
	});

	it("openTrace never exposes a valid prefix when a later line is corrupt", () => {
		const runDir = mkdtempSync(join(tmpdir(), "ahde-trace-"));
		try {
			writeFileSync(
				join(runDir, "session.jsonl"),
				[
					'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"would pass"}],"timestamp":1}}',
					'{"type":"message","message":{"role":"assistant","content":[{"type":"text"}]}}',
				].join("\n"),
			);

			expect(() => openTrace(runDir)).toThrow(/trace line 2: message\.content\[0\]\.text must be string/);
		} finally {
			rmSync(runDir, { recursive: true, force: true });
		}
	});
});
