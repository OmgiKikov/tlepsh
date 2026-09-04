import { afterEach, describe, expect, it } from "vitest";
import { stableTasks, type TaskRun } from "../src/compare.js";
import { renderEvaluationSummary } from "../src/builder/render/view.js";
import { renderRunsTable } from "../src/builder/render/trace.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { messageKeys, setLanguage, t } from "../src/i18n.js";
import type { RunRow } from "../src/application/run-explanation.js";
import type { WorkbenchTracesDetail } from "../src/workbench/types.js";

/**
 * Honest repetitions.
 *
 * `5/12 passed` is one number over two very different runs: twelve cases that
 * each come back right about half the time, and five cases that come back
 * right every single time beside seven that never do. Only the second is
 * something to build a change on. Nothing on any screen separated them, and
 * the word this product refuses to print — «стабильно» — is exactly the claim
 * an operator makes for themselves when the screen will not.
 *
 * So the aggregate the comparison already builds gets read one more way, at
 * display time, with no EvalRun field behind it: how many cases passed in
 * EVERY repetition. An errored repetition is never a pass, and one repetition
 * measures no repetition at all.
 */

const PASSED: TaskRun["evalResults"] = { graders: [], outcome: "pass" };
const FAILED: TaskRun["evalResults"] = { graders: [], outcome: "fail" };

function run(taskId: string, outcome: "pass" | "fail" | "error"): TaskRun {
	return outcome === "error"
		? { taskId, status: "error", evalResults: null }
		: { taskId, status: "completed", evalResults: outcome === "pass" ? PASSED : FAILED };
}

afterEach(() => {
	setLanguage(null);
});

describe("cases that passed in every repetition", () => {
	it("counts a case only when every one of its repetitions passed", () => {
		const records = [
			// 3/3 — right every time.
			run("task_a", "pass"), run("task_a", "pass"), run("task_a", "pass"),
			// 2/3 — the answer moves, so it is not one of them.
			run("task_b", "pass"), run("task_b", "fail"), run("task_b", "pass"),
			// 0/3.
			run("task_c", "fail"), run("task_c", "fail"), run("task_c", "fail"),
		];
		const stable = stableTasks(records);
		expect(stable).toEqual({
			stable: 1,
			measured: 3,
			perTask: [
				{ taskId: "task_a", pass: 3, total: 3 },
				{ taskId: "task_b", pass: 2, total: 3 },
				{ taskId: "task_c", pass: 0, total: 3 },
			],
		});
	});

	it("never counts an errored repetition as a pass", () => {
		// The run stopped before grading. Whatever the record says the outcome
		// was, it is the engine's answer and not the agent's, and a case the
		// engine lost must never print as a case the agent aced.
		const errored = [run("task_a", "pass"), run("task_a", "pass"), run("task_a", "error")];
		expect(stableTasks(errored)).toMatchObject({
			stable: 0,
			perTask: [{ taskId: "task_a", pass: 2, total: 3 }],
		});
		// Even an errored record that somehow carries a passing outcome.
		const lying: TaskRun[] = [{ taskId: "task_a", status: "error", evalResults: PASSED }];
		expect(stableTasks(lying)).toMatchObject({ stable: 0, perTask: [{ taskId: "task_a", pass: 0, total: 1 }] });
	});

	it("says nothing at all about a basket nobody measured", () => {
		expect(stableTasks([])).toEqual({ stable: 0, measured: 0, perTask: [] });
	});
});

function evaluation(
	overrides: Partial<WorkbenchTracesDetail["evaluation"]> = {},
): WorkbenchTracesDetail["evaluation"] {
	return {
		evalRunId: "erun-1",
		summary: { total: 36, pass: 15, fail: 21, error: 0, allPassRate: 15 / 36 },
		repetitions: 3,
		stableTasks: { stable: 3, measured: 12 },
		finishedAt: "2026-09-04T09:00:00.000Z",
		targetGitSha: "a".repeat(40),
		corpus: { name: "basket", taskCount: 12 },
		...overrides,
	};
}

describe("the post-run summary", () => {
	it("says how many cases came back right in every repetition", () => {
		setLanguage("ru");
		expect(renderEvaluationSummary(evaluation(), plainPaint)).toContain("во всех повторах 3");
		setLanguage("en");
		expect(renderEvaluationSummary(evaluation(), plainPaint)).toContain("3 in every repetition");
	});

	it("refuses the claim on one repetition and says what would measure it", () => {
		// k = 1 cannot separate the agent from its own noise, so the line says
		// so instead of printing a number that would read as one.
		setLanguage("ru");
		const single = renderEvaluationSummary(
			evaluation({ repetitions: 1, summary: { total: 12, pass: 5, fail: 7, error: 0, allPassRate: 5 / 12 }, stableTasks: { stable: 5, measured: 12 } }),
			plainPaint,
		);
		expect(single).toContain("повторов 1 — шум не измерен");
		expect(single).not.toContain("во всех повторах");
		// And the calibrated design that would: five repetitions keep the noise
		// band of a twelve-case basket at this pass rate inside ten points.
		expect(single).toContain("нужно 5 повторов — прогони A/A");
	});

	it("leaves the advice off when the repetitions already are what noise asks for", () => {
		setLanguage("ru");
		// One case that always passes: the paired standard error is zero and a
		// single repetition is the whole design there is to recommend.
		const line = renderEvaluationSummary(
			evaluation({ repetitions: 1, summary: { total: 1, pass: 1, fail: 0, error: 0, allPassRate: 1 }, stableTasks: { stable: 1, measured: 1 } }),
			plainPaint,
		);
		expect(line).toContain("повторов 1 — шум не измерен");
		expect(line).not.toContain("прогони A/A");
	});
});

function row(taskId: string, repetitionIndex: number, outcome: RunRow["outcome"]): RunRow {
	return {
		runId: `run-${taskId}-${repetitionIndex}`,
		taskId,
		repetitionIndex,
		outcome,
		score: outcome === "pass" ? 1 : 0,
		inputPreview: null,
		graders: [],
		failureModeIds: [],
		error: null,
		metrics: { latencyMs: 1_000, toolCalls: 0, toolErrors: 0, tokens: null, costUsd: null },
		traceAvailable: false,
	};
}

describe("the runs table", () => {
	it("prints the case's repetitions as a literal fraction beside every one of its rows", () => {
		setLanguage("en");
		const rows = [
			row("task_a", 0, "pass"), row("task_a", 1, "pass"), row("task_a", 2, "pass"),
			row("task_b", 0, "pass"), row("task_b", 1, "fail"), row("task_b", 2, "pass"),
			row("task_c", 0, "error"), row("task_c", 1, "pass"), row("task_c", 2, "pass"),
		];
		const lines = renderRunsTable(rows, [], plainPaint);
		expect(lines[0]).toContain("passed");
		const of = (taskId: string): string[] =>
			lines.filter((line) => line.includes(taskId)).map((line) => line.split(/\s+/)[3] ?? "");
		expect(of("task_a")).toEqual(["3/3", "3/3", "3/3"]);
		expect(of("task_b")).toEqual(["2/3", "2/3", "2/3"]);
		// The errored repetition is in the denominator and not in the numerator.
		expect(of("task_c")).toEqual(["2/3", "2/3", "2/3"]);
		// The fraction is counted over every row handed in, never over the page.
		const shown = renderRunsTable(rows, [], plainPaint, { limit: 1 });
		expect(shown[1]?.split(/\s+/)[3]).toBe("3/3");
		for (const line of lines) expect([...line].length).toBeLessThanOrEqual(110);
	});
});

/**
 * The word itself. «Стабильно» is a verdict about run-to-run behaviour that
 * this engine measures and never asserts, so it appears nowhere an operator
 * can read it — except in the two places that name an ACTION rather than a
 * finding: run it again to measure the noise, and the failure mode whose
 * decision is to do exactly that.
 */
describe("the word this product does not print", () => {
	it("keeps «стабильн» out of every Russian string but the two that describe an action", () => {
		setLanguage("ru");
		const ACTIONS = new Set(["diagnosis.next.harder", "mode.decision.stabilize"]);
		const offenders = messageKeys().filter((key) => /стабильн/i.test(t(key)) && !ACTIONS.has(key));
		expect(offenders).toEqual([]);
		// The allowlist stays honest: both entries really do still say it.
		for (const key of ACTIONS) expect(t(key as never)).toMatch(/стабильн/i);
	});
});
