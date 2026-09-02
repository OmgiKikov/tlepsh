import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../src/provenance.js";
import {
	emitExecutionFinished,
	emitRunEvent,
	emitRunGraded,
	emitRunStarted,
	observeRunSessionEvent,
	projectRunEventIdentity,
	projectRunEventText,
	RUN_EVENT_MAX_ERROR_CHARS,
	RUN_EVENT_MAX_IDENTIFIER_CHARS,
	RUN_EVENT_MAX_TEXT_CHARS,
	type RunEvent,
	type RunEventIdentity,
} from "../src/run-events.js";

const run: RunEventIdentity = {
	evalRunId: "erun_events",
	runId: "run_events",
	taskId: "task-events",
	repetitionIndex: 1,
	ordinal: 4,
	total: 6,
};

function sessionEvent(value: unknown): AgentSessionEvent {
	return value as AgentSessionEvent;
}

describe("run event projection", () => {
	it("serializes deterministically, redacts credentials, and hard-bounds text", () => {
		const projected = projectRunEventText({ z: "sk-abcdefghijk", a: "visible" });
		expect(projected).toEqual({
			text: '{"a":"visible","z":"[REDACTED_API_KEY]"}',
			truncated: false,
		});

		const bounded = projectRunEventText("x".repeat(RUN_EVENT_MAX_TEXT_CHARS + 7));
		expect(bounded.text).toHaveLength(RUN_EVENT_MAX_TEXT_CHARS);
		expect(bounded.truncated).toBe(true);

		const ansiSplitSecret = projectRunEventText("sk-abcde\u001b[31mfghijklmno");
		expect(ansiSplitSecret).toEqual({ text: "[REDACTED_API_KEY]", truncated: false });
		expect(() => projectRunEventText("x", -1)).toThrow(/non-negative integer/);
	});

	it("projects credential-shaped and oversized event identities deterministically", () => {
		const sensitive = {
			...run,
			evalRunId: "sk-evalidentitysecret1234567890",
			runId: "sk-runidentitysecret1234567890",
			taskId: `sk-taskidentitysecret1234567890-${"x".repeat(250)}`,
		};
		const first = projectRunEventIdentity(sensitive);
		const second = projectRunEventIdentity(sensitive);
		expect(first).toEqual(second);
		expect(JSON.stringify(first)).not.toContain("identitysecret");
		expect(first.taskId).toContain("[REDACTED_API_KEY]");
		expect(first.taskId.length).toBeLessThanOrEqual(RUN_EVENT_MAX_IDENTIFIER_CHARS);

		const emitted: RunEvent[] = [];
		emitRunEvent((event) => emitted.push(event), {
			type: "run_started",
			at: new Date().toISOString(),
			run: sensitive,
		});
		expect(emitted[0]?.run).toEqual(first);
	});

	it("emits only assistant text deltas and bounded tool projections", () => {
		const events: RunEvent[] = [];
		const listener = (event: RunEvent): void => {
			events.push(event);
		};

		observeRunSessionEvent(listener, run, sessionEvent({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "thinking", thinking: "THINKING_CANARY" }] },
			assistantMessageEvent: {
				type: "thinking_delta",
				delta: "THINKING_DELTA_CANARY",
				partial: { provider: "PROVIDER_CANARY" },
			},
		}));
		observeRunSessionEvent(listener, run, sessionEvent({
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "USER_CANARY" }] },
		}));
		observeRunSessionEvent(listener, run, sessionEvent({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "sk-abcde" }] },
			assistantMessageEvent: {
				type: "text_delta",
				delta: "sk-abcde",
				partial: { provider: "PROVIDER_CANARY" },
			},
		}));
		observeRunSessionEvent(listener, run, sessionEvent({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "sk-abcdefghijklmno" }] },
			assistantMessageEvent: {
				type: "text_delta",
				delta: "fghijklmno",
				partial: { provider: "PROVIDER_CANARY" },
			},
		}));
		observeRunSessionEvent(listener, run, sessionEvent({
			type: "message_end",
			message: {
				role: "assistant",
				provider: "PROVIDER_CANARY",
				content: [
					{ type: "text", text: "safe sk-abcde" },
					{ type: "thinking", thinking: "THINKING_CANARY" },
					{
						type: "toolCall",
						id: "HIDDEN_TOOL_CALL",
						name: "HIDDEN_TOOL_NAME",
						arguments: { value: "HIDDEN_TOOL_ARGUMENTS" },
					},
					{ type: "text", text: "fghijklmno" },
				],
			},
		}));
		observeRunSessionEvent(listener, run, sessionEvent({
			type: "tool_execution_start",
			toolCallId: `call-${"i".repeat(RUN_EVENT_MAX_IDENTIFIER_CHARS)}`,
			toolName: "lookup",
			args: { token: "Bearer abcdefghijklmno", query: "safe" },
			provider: "PROVIDER_CANARY",
		}));
		observeRunSessionEvent(listener, run, sessionEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "lookup",
			result: {
				content: [
					{ type: "text", text: "y".repeat(RUN_EVENT_MAX_TEXT_CHARS + 1) },
					{ type: "image", data: "IMAGE_CANARY", mimeType: "image/png" },
				],
				details: { secret: "DETAIL_CANARY" },
				usage: { providerPayload: "USAGE_CANARY" },
			},
			isError: false,
		}));

		expect(events.map((event) => event.type)).toEqual([
			"assistant_delta",
			"tool_started",
			"tool_finished",
		]);
		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain("THINKING_CANARY");
		expect(serialized).not.toContain("THINKING_DELTA_CANARY");
		expect(serialized).not.toContain("USER_CANARY");
		expect(serialized).not.toContain("PROVIDER_CANARY");
		expect(serialized).not.toContain("sk-abcde");
		expect(serialized).not.toContain("fghijklmno");
		expect(serialized).not.toContain("HIDDEN_TOOL_CALL");
		expect(serialized).not.toContain("HIDDEN_TOOL_NAME");
		expect(serialized).not.toContain("HIDDEN_TOOL_ARGUMENTS");
		expect(serialized).not.toContain("IMAGE_CANARY");
		expect(serialized).not.toContain("DETAIL_CANARY");
		expect(serialized).not.toContain("USAGE_CANARY");
		expect(serialized).not.toContain("abcdefghijklmno");
		expect(events[0]).toMatchObject({
			type: "assistant_delta",
			delta: "safe [REDACTED_API_KEY]",
			truncated: false,
		});

		const started = events[1];
		expect(started?.type).toBe("tool_started");
		if (started?.type === "tool_started") {
			expect(started.toolCallId).toHaveLength(RUN_EVENT_MAX_IDENTIFIER_CHARS);
			expect(started.arguments).toContain('"token":"[REDACTED]"');
			expect(started.truncated).toBe(true);
		}
		const finished = events[2];
		expect(finished?.type).toBe("tool_finished");
		if (finished?.type === "tool_finished") {
			expect(finished.output).toHaveLength(RUN_EVENT_MAX_TEXT_CHARS);
			expect(finished.truncated).toBe(true);
		}
	});

	it("keeps listeners observational and copies mutable execution metrics", () => {
		const thrown = vi.fn(() => {
			throw new Error("listener failed");
		});
		expect(() => emitRunStarted(thrown, run)).not.toThrow();
		expect(thrown).toHaveBeenCalledOnce();

		const record = {
			status: "error",
			error: `password="super-secret" ${"e".repeat(RUN_EVENT_MAX_ERROR_CHARS + 20)}`,
			metrics: {
				tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				costUsd: 0,
				latencyMs: 5,
				toolCalls: 0,
				toolErrors: 0,
				recoveryAttempts: 0,
			},
		} as RunRecord;
		const events: RunEvent[] = [];
		emitExecutionFinished((event) => {
			events.push(event);
			if (event.type === "execution_finished" && event.metrics.tokens) event.metrics.tokens.input = 999;
		}, run, record);
		emitRunGraded((event) => events.push(event), run, "error", [], 2);

		expect(record.metrics.tokens?.input).toBe(1);
		const execution = events[0];
		expect(execution?.type).toBe("execution_finished");
		if (execution?.type === "execution_finished") {
			expect(execution.error).not.toContain("super-secret");
			expect(execution.error?.length).toBeLessThanOrEqual(RUN_EVENT_MAX_ERROR_CHARS);
		}
		expect(events[1]).toMatchObject({
			type: "run_graded",
			outcome: "error",
			passedGraders: 0,
			totalGraders: 2,
		});
	});

	it("swallows a rejected return from an accidentally async listener", async () => {
		emitRunEvent((() => Promise.reject(new Error("async listener failed"))) as never, {
			type: "run_started",
			at: new Date().toISOString(),
			run,
		});
		await Promise.resolve();
	});
});
