import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveTraceHub, type LiveTraceFrame } from "../src/evidence/live.js";
import type { RunEvent } from "../src/run-events.js";

function runEvent(index: number, delta = `event-${index}`): RunEvent {
	return {
		type: "assistant_delta",
		at: "2026-08-28T12:00:00.000Z",
		run: {
			evalRunId: "erun_live",
			runId: "run_live",
			taskId: "task-live",
			repetitionIndex: 0,
			ordinal: 1,
			total: 1,
		},
		delta,
		truncated: false,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("bounded live trace hub", () => {
	it("keeps ordered replay, marks retention gaps, and isolates sessions", () => {
		const hub = createLiveTraceHub();
		const first = hub.start();
		const second = hub.start();
		for (let index = 0; index < 300; index += 1) {
			first.onRunEvent(runEvent(index, `${index}:${"x".repeat(4_000)}`));
		}
		second.onRunEvent(runEvent(1, "SECOND_SESSION_CANARY"));

		const firstReplay = hub.subscribe(first.id, 0, () => true);
		const secondReplay = hub.subscribe(second.id, 0, () => true);
		expect(firstReplay.kind).toBe("subscribed");
		expect(secondReplay.kind).toBe("subscribed");
		if (firstReplay.kind === "subscribed" && secondReplay.kind === "subscribed") {
			expect(firstReplay.frames.length).toBeLessThanOrEqual(256);
			expect(firstReplay.droppedBeforeSequence).toBeGreaterThan(0);
			expect(firstReplay.frames.map((frame) => frame.sequence)).toEqual(
				[...firstReplay.frames].map((frame) => frame.sequence).sort((a, b) => a - b),
			);
			expect(JSON.stringify(firstReplay.frames)).not.toContain("SECOND_SESSION_CANARY");
			expect(JSON.stringify(secondReplay.frames)).toContain("SECOND_SESSION_CANARY");
			firstReplay.unsubscribe();
			secondReplay.unsubscribe();
		}
		hub.close();
	});

	it("finishes once, ignores later events, and expires retained views", () => {
		vi.useFakeTimers();
		const hub = createLiveTraceHub();
		const live = hub.start();
		live.onRunEvent(runEvent(1, "BEFORE_FINISH"));
		live.finish("completed");
		live.finish("error");
		live.onRunEvent(runEvent(2, "AFTER_FINISH_CANARY"));

		const replay = hub.subscribe(live.id, 0, () => true);
		expect(replay.kind).toBe("subscribed");
		if (replay.kind === "subscribed") {
			expect(replay.active).toBe(false);
			expect(JSON.stringify(replay.frames)).toContain("BEFORE_FINISH");
			const session = replay.frames.find((frame) => frame.event === "session");
			expect(session ? JSON.parse(session.data) : null).toEqual({ status: "completed" });
			expect(JSON.stringify(replay.frames)).not.toContain("AFTER_FINISH_CANARY");
		}
		vi.advanceTimersByTime(15 * 60 * 1_000);
		expect(hub.has(live.id)).toBe(false);
		hub.close();
	});

	it("bounds active capacity and subscriber fan-out without affecting producers", () => {
		const hub = createLiveTraceHub();
		const active = Array.from({ length: 4 }, () => hub.start());
		expect(() => hub.start()).toThrow(/capacity is full/);

		const received: string[] = [];
		const subscriptions = Array.from({ length: 4 }, () => hub.subscribe(
			active[0]!.id,
			0,
			(frame) => {
				received.push(frame.data);
				return true;
			},
		));
		expect(hub.subscribe(active[0]!.id, 0, () => true)).toEqual({ kind: "full" });
		expect(() => active[0]!.onRunEvent(runEvent(1, "FANOUT_CANARY"))).not.toThrow();
		expect(received.filter((value) => value.includes("FANOUT_CANARY"))).toHaveLength(4);
		for (const subscription of subscriptions) {
			if (subscription.kind === "subscribed") subscription.unsubscribe();
		}

		active[0]!.finish("aborted");
		expect(() => hub.start()).not.toThrow();
		hub.close();
	});

	it("drops malformed oversized frames and removes throwing subscribers", () => {
		const hub = createLiveTraceHub();
		const live = hub.start();
		const throwing = vi.fn((_frame: LiveTraceFrame) => {
			throw new Error("viewer failed");
		});
		const stable = vi.fn((_frame: LiveTraceFrame) => true);
		hub.subscribe(live.id, 0, throwing);
		hub.subscribe(live.id, 0, stable);
		expect(() => live.onRunEvent(runEvent(1, "x".repeat(30 * 1024)))).not.toThrow();
		live.onRunEvent(runEvent(2, "SAFE_FRAME"));

		expect(throwing).toHaveBeenCalledOnce();
		expect(stable).toHaveBeenCalledOnce();
		expect(stable.mock.calls[0]?.[0].data).toContain("SAFE_FRAME");
		hub.close();
	});
});
