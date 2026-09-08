import { beforeEach, describe, expect, it } from "vitest";
import { setLanguage } from "../src/i18n.js";
import { createRunProgressPresenter } from "../src/builder/run-progress.js";
import type { RunEvent, RunEventIdentity } from "../src/run-events.js";

beforeEach(() => setLanguage("en"));

function fixture() {
	let frame: string[] = [];
	let status = "";
	const presenter = createRunProgressPresenter({
		setWidget: (_key, lines) => { frame = Array.isArray(lines) ? lines : []; },
		setStatus: (_key, text) => { status = text ?? ""; },
	}, { now: () => 30_000 });
	const run = (runId = "run-a", evalRunId: string | null = "eval-a", total = 2): RunEventIdentity => ({ runId, evalRunId, total, ordinal: 1, repetitionIndex: 0, taskId: "case-a" });
	const emit = (event: RunEvent) => presenter.onRunEvent(event);
	const grade = (identity = run(), outcome: "pass" | "fail" = "pass") => emit({ type: "run_graded", at: "2026-09-07T00:00:02Z", run: identity, outcome, passedGraders: outcome === "pass" ? 1 : 0, totalGraders: 1 });
	const delta = (text: string, identity = run()) => emit({ type: "assistant_delta", at: "2026-09-07T00:00:01Z", run: identity, delta: text, truncated: false });
	return { presenter, run, emit, grade, delta, frame: () => frame, status: () => status };
}

describe("bounded public run progress", () => {
	it("separates the sealed multi-eval budget from observed public phase totals", () => {
		const f = fixture();
		f.presenter.plan(12);
		f.grade(f.run("a", "cheap", 2));
		f.grade(f.run("b", "cheap", 2));
		f.grade(f.run("c", "baseline", 3));
		f.grade(f.run("d", "candidate", 3));
		expect(f.status()).toContain("4/8");
		expect(f.frame().join("\n")).toContain("Planned budget: 12");
		expect(f.frame().join("\n")).toContain("Observed public phases");
		expect(f.frame().join("\n")).not.toMatch(/4\/12|left|ETA/);
	});

	it("makes grades terminal and idempotent, including late starts and conflicting duplicates", () => {
		const f = fixture();
		f.grade();
		f.grade();
		f.grade(f.run(), "fail");
		f.delta("late answer");
		f.emit({ type: "run_started", run: f.run(), at: "2026-09-07T00:00:00Z" });
		expect(f.status()).toContain("graded 1/2 · running 0");
		expect(f.status()).toContain("✓1 ✗0");
		expect(f.frame().join("\n")).not.toContain("late answer");
	});

	it("ignores older activity and does not revive an execution waiting for its grade", () => {
		const f = fixture();
		f.emit({ type: "tool_finished", at: "2026-09-07T00:00:03Z", run: f.run(), toolCallId: "call-a", toolName: "search", output: "found", isError: false, truncated: false });
		f.delta("older answer");
		expect(f.frame().join("\n")).toContain("found");
		f.emit({ type: "execution_finished", at: "2026-09-07T00:00:04Z", run: f.run(), status: "completed", error: null, metrics: { latencyMs: 1, toolCalls: 1, toolErrors: 0, recoveryAttempts: 0 } });
		f.emit({ type: "assistant_delta", at: "2026-09-07T00:00:05Z", run: f.run(), delta: "late answer", truncated: false });
		expect(f.frame().join("\n")).not.toContain("late answer");
		f.grade();
		expect(f.status()).toContain("graded 1/2 · running 0");
	});

	it("sanitizes controls across delta boundaries without losing word spaces", () => {
		const f = fixture();
		for (const delta of ["hello", " ", "world\u001b", "]52;c;", "CLIPBOARD_CANARY", "\u001b", "\\ after", "\u009d", "C1_CANARY", "\u009c end", "\u001b[", "31", "m safe"]) f.delta(delta);
		const output = f.frame().join("\n");
		expect(output).toContain("hello world after end safe");
		expect(output).not.toMatch(/CANARY|31m|[\u001b\u009d\u009c]/);
	});

	it("retains only a tail of long answers and never resurrects capped runs", () => {
		const f = fixture();
		for (let i = 0; i < 1_000; i++) f.delta("x".repeat(4_096));
		f.delta(" latest words");
		expect(f.frame().join("\n")).toContain("latest words");
		for (let i = 0; i < 5_000; i++) f.grade(f.run(`run-${i}`, `eval-${i}`, 1));
		const before = f.status();
		f.grade(f.run("run-0", "eval-0", 1));
		expect(f.status()).toBe(before);
		expect(f.frame().join("\n")).toContain("Live progress limit reached");
		expect(f.frame().length).toBeLessThanOrEqual(10);
		expect(Buffer.byteLength(f.frame().join("\n"))).toBeLessThanOrEqual(32 * 1024);
	});

	it("bounds open control payloads and sanitizes long Unicode widget lines", () => {
		const f = fixture();
		f.delta("before\u001bP");
		for (let i = 0; i < 1_000; i++) f.delta("DCS_CANARY".repeat(100));
		f.delta("\u001b\\ after");
		expect(f.frame().join("\n")).toContain("before after");
		expect(f.frame().join("\n")).not.toContain("CANARY");
		f.delta("界👩‍💻e\u0301".repeat(1_000));
		f.delta(" latest words");
		expect(f.frame().join("\n")).toContain("latest words");
		expect(f.frame().join("\n")).not.toContain("\u001b");
	});

	it("localizes the separate budget and public-count labels", () => {
		setLanguage("ru");
		const f = fixture();
		f.presenter.plan(12);
		f.grade();
		expect(f.frame()).toContain("Плановый бюджет: 12 запусков, включая закрытые прогоны");
		expect(f.frame()).toContain("Наблюдаемые открытые этапы");
		expect(f.status()).toContain("оценено 1/2");
	});
});
