import { afterEach, describe, expect, it } from "vitest";
import { readBasket, type ReadBasketInput } from "../src/application/basket-reading.js";
import type { CriticFinding, CriticReceipt } from "../src/application/case-critic.js";
import { renderBasket } from "../src/builder/render/basket.js";
import { plainPaint } from "../src/builder/render/paint.js";
import type { TaskRun } from "../src/compare.js";
import type { CorpusTask } from "../src/corpus.js";
import { setLanguage, t } from "../src/i18n.js";
import type { CaseCoverage, CaseSource } from "../src/manifest.js";
import type { WorkbenchBasketReading } from "../src/workbench/types.js";

/**
 * Reading the basket, under the one rule that outranks every number here: a
 * case is never removed, ranked down or recommended for removal because the
 * agent failed it. A zero pass rate over a sound case is capability work; a
 * zero pass rate over a case the critic doubts is a question about the TEST.
 * Nothing this module returns may be read as “drop these”.
 */

const PASSED: TaskRun["evalResults"] = { graders: [], outcome: "pass" };
const FAILED: TaskRun["evalResults"] = { graders: [], outcome: "fail" };

function run(taskId: string, outcome: "pass" | "fail" | "error"): TaskRun {
	return outcome === "error"
		? { taskId, status: "error", evalResults: null }
		: { taskId, status: "completed", evalResults: outcome === "pass" ? PASSED : FAILED };
}

/** `pass pass fail` for one case, in one string. */
function runs(taskId: string, outcomes: string): TaskRun[] {
	return outcomes.split(" ").map((outcome) => run(taskId, outcome as "pass" | "fail" | "error"));
}

function task(id: string, parts: { coverage?: CaseCoverage; source?: CaseSource } = {}): CorpusTask {
	return {
		id,
		input: `ask ${id}`,
		graders: [{ type: "output_contains", text: "ok", caseSensitive: false }],
		...(parts.coverage ? { coverage: parts.coverage } : {}),
		...(parts.source ? { source: parts.source } : {}),
	};
}

const IMPORTED: CaseSource = { kind: "import", path: "imports/tickets.csv", sha256: `sha256:${"a".repeat(64)}`, row: 3 };
const FROM_SPEC: CaseSource = { kind: "spec" };

function receipt(findings: readonly CriticFinding[]): CriticReceipt {
	return {
		schemaVersion: 1,
		kind: "case-critic",
		id: `critic-${"b".repeat(64)}`,
		projectId: "proj",
		subject: { kind: "development-corpus", id: "corpus-1", hash: `sha256:${"c".repeat(64)}` },
		judge: { provider: "anthropic", id: "judge-1" },
		findings: [...findings],
		counts: {
			valid: findings.filter((finding) => finding.verdict === "valid").length,
			repair: findings.filter((finding) => finding.verdict === "repair").length,
			invalid: findings.filter((finding) => finding.verdict === "invalid").length,
			unreviewed: findings.filter((finding) => finding.verdict === "unreviewed").length,
		},
		spend: { calls: 1, tokens: 100, costUsd: 0.01 },
		createdAt: "2026-09-08T10:00:00.000Z",
	};
}

function input(overrides: Partial<ReadBasketInput> = {}): ReadBasketInput {
	return {
		evalRunId: "erun-1",
		repetitions: 3,
		runs: [],
		tasks: [],
		jobs: [],
		previousTaskIds: null,
		critic: null,
		unresolvedModes: [],
		...overrides,
	};
}

describe("how each case stood", () => {
	it("reads saturated, failing and unstable off the repetitions", () => {
		const reading = readBasket(input({
			tasks: [task("t_all_pass"), task("t_all_fail"), task("t_mixed")],
			runs: [...runs("t_all_pass", "pass pass pass"), ...runs("t_all_fail", "fail fail fail"), ...runs("t_mixed", "pass fail pass")],
		}));
		expect(reading.cases).toEqual([
			{ taskId: "t_all_pass", standing: "saturated", pass: 3, total: 3, validity: "unreviewed", origin: "unknown", coverage: null, newInWave: false },
			{ taskId: "t_all_fail", standing: "failing", pass: 0, total: 3, validity: "unreviewed", origin: "unknown", coverage: null, newInWave: false },
			{ taskId: "t_mixed", standing: "unstable", pass: 2, total: 3, validity: "unreviewed", origin: "unknown", coverage: null, newInWave: false },
		]);
		expect(reading.counts).toMatchObject({ saturated: 1, failing: 1, unstable: 1 });
	});

	it("decides on the repetitions that decided something, never on the ones the engine lost", () => {
		// Every repetition errored: the harness measured nothing, so the case has
		// no standing at all rather than a standing of zero — a lost run is not a
		// failing agent, and it must never be counted as capability work.
		const lost = readBasket(input({ tasks: [task("t_lost")], runs: runs("t_lost", "error error error") }));
		expect(lost.cases[0]).toMatchObject({ standing: "unstable", pass: 0, total: 0 });
		expect(lost.counts).toMatchObject({ failing: 0, unstable: 1 });
		// One repetition survived and it passed: the case is saturated over what
		// was actually measured, and the denominator says how little that was.
		const survived = readBasket(input({ tasks: [task("t_half")], runs: runs("t_half", "error pass") }));
		expect(survived.cases[0]).toMatchObject({ standing: "saturated", pass: 1, total: 1 });
		// The same for a case that only ever failed where it ran.
		const failed = readBasket(input({ tasks: [task("t_fail")], runs: runs("t_fail", "error fail fail") }));
		expect(failed.cases[0]).toMatchObject({ standing: "failing", pass: 0, total: 2 });
	});

	it("keeps a case the run never reached, with nothing claimed about it", () => {
		const reading = readBasket(input({ tasks: [task("t_unrun")], runs: [] }));
		expect(reading.cases).toEqual([{
			taskId: "t_unrun", standing: "unstable", pass: 0, total: 0,
			validity: "unreviewed", origin: "unknown", coverage: null, newInWave: false,
		}]);
	});

	it("still reports a measured case the corpus list no longer holds", () => {
		// Leaving it out would be the one thing this module may not do: a failing
		// case disappearing from the reading because a list moved under it.
		const reading = readBasket(input({
			tasks: [task("t_listed")],
			runs: [...runs("t_listed", "pass pass"), ...runs("t_gone", "fail fail")],
		}));
		expect(reading.cases.map((item) => item.taskId)).toEqual(["t_listed", "t_gone"]);
		expect(reading.cases[1]).toMatchObject({ standing: "failing", pass: 0, total: 2, coverage: null, origin: "unknown" });
		expect(reading.counts).toMatchObject({ failing: 1, failingUnreviewed: 1 });
	});
});

describe("what the critic said about the case itself", () => {
	const basket = (findings: readonly CriticFinding[]): WorkbenchBasketReading =>
		readBasket(input({
			tasks: [task("t_sound"), task("t_repair"), task("t_invalid"), task("t_unread")],
			runs: [
				...runs("t_sound", "fail fail fail"),
				...runs("t_repair", "fail fail fail"),
				...runs("t_invalid", "fail fail fail"),
				...runs("t_unread", "fail fail fail"),
			],
			critic: receipt(findings),
		}));

	it("splits the four failing cases by what the critic found in the test", () => {
		const reading = basket([
			{ taskId: "t_sound", verdict: "valid", reasons: [] },
			{ taskId: "t_repair", verdict: "repair", reasons: ["the check names a value the source does not state"] },
			{ taskId: "t_invalid", verdict: "invalid", reasons: ["no declared tool could fetch this"] },
		]);
		expect(reading.counts).toEqual({
			saturated: 0,
			failing: 4,
			unstable: 0,
			// Sound and failing every time: work on the agent.
			failingValid: 1,
			// Repair and invalid are both doubt about the test, never about the case being hard.
			failingDoubtful: 2,
			// Nobody read it, so nothing is decided about it either way.
			failingUnreviewed: 1,
		});
		expect(reading.cases.map((item) => item.validity)).toEqual(["valid", "repair", "invalid", "unreviewed"]);
	});

	it("says unreviewed for every case when nobody has run the critic", () => {
		const reading = readBasket(input({ tasks: [task("t_a")], runs: runs("t_a", "fail fail") }));
		expect(reading.counts).toMatchObject({ failing: 1, failingValid: 0, failingDoubtful: 0, failingUnreviewed: 1 });
	});
});

describe("the wave", () => {
	const tasks = [task("t_old"), task("t_new_a"), task("t_new_b")];

	it("has no wave at all until the lineage has a previous publication", () => {
		const reading = readBasket(input({
			tasks,
			runs: [...runs("t_old", "pass pass"), ...runs("t_new_a", "pass pass"), ...runs("t_new_b", "fail fail")],
		}));
		expect(reading.wave).toBeNull();
		expect(reading.cases.every((item) => !item.newInWave)).toBe(true);
	});

	it("counts the cases this wave added and the ones it caught", () => {
		const reading = readBasket(input({
			tasks,
			previousTaskIds: ["t_old"],
			runs: [...runs("t_old", "pass pass"), ...runs("t_new_a", "pass pass"), ...runs("t_new_b", "fail fail")],
		}));
		expect(reading.wave).toEqual({ newCases: 2, newFailing: 1, saturated: false });
		expect(reading.cases.map((item) => item.newInWave)).toEqual([false, true, true]);
	});

	it("calls a wave the agent passed whole saturation, and an unchanged basket no wave at all", () => {
		// Every new case passed every repetition: the wave was too easy, and the
		// answer is a harder next wave — never an easier basket.
		const saturated = readBasket(input({
			tasks,
			previousTaskIds: ["t_old"],
			runs: [...runs("t_old", "fail fail"), ...runs("t_new_a", "pass pass"), ...runs("t_new_b", "pass pass")],
		}));
		expect(saturated.wave).toEqual({ newCases: 2, newFailing: 0, saturated: true });
		// Nothing was added, so nothing saturated: a re-run of the same basket is
		// not a wave that passed.
		const unchanged = readBasket(input({
			tasks,
			previousTaskIds: ["t_old", "t_new_a", "t_new_b"],
			runs: [...runs("t_old", "pass pass"), ...runs("t_new_a", "pass pass"), ...runs("t_new_b", "pass pass")],
		}));
		expect(unchanged.wave).toEqual({ newCases: 0, newFailing: 0, saturated: false });
	});
});

describe("synthetic against real", () => {
	const billing = { job: "answer billing questions", difficulty: "direct" } as const;

	it("compares only cells that hold both origins, and reports the gap as points", () => {
		const reading = readBasket(input({
			jobs: [billing.job],
			tasks: [
				task("t_real_pass", { coverage: billing, source: IMPORTED }),
				task("t_real_fail", { coverage: billing, source: IMPORTED }),
				task("t_syn_pass", { coverage: billing, source: FROM_SPEC }),
				// A synthetic-only cell: nothing real to compare it with, so it is
				// not a cell at all, and its pass rate is nobody's evidence.
				task("t_syn_trap", { coverage: { job: billing.job, difficulty: "policy-trap" }, source: FROM_SPEC }),
			],
			runs: [
				...runs("t_real_pass", "pass pass pass"),
				...runs("t_real_fail", "fail fail fail"),
				...runs("t_syn_pass", "pass pass pass"),
				...runs("t_syn_trap", "fail fail fail"),
			],
		}));
		expect(reading.origins).toMatchObject({ real: 2, synthetic: 2, unknown: 0, realism: "compared" });
		expect(reading.origins.comparable).toEqual([{
			job: billing.job,
			difficulty: "direct",
			state: null,
			real: { cases: 2, passRate: 0.5 },
			synthetic: { cases: 1, passRate: 1 },
			gapPoints: 50,
		}]);
	});

	it("keeps the sign of the gap and separates the world states", () => {
		const blocked = { ...billing, state: "account blocked" } as const;
		const reading = readBasket(input({
			jobs: [billing.job],
			tasks: [
				task("t_real_open", { coverage: billing, source: IMPORTED }),
				task("t_syn_open", { coverage: billing, source: FROM_SPEC }),
				task("t_real_blocked", { coverage: blocked, source: IMPORTED }),
				task("t_syn_blocked", { coverage: blocked, source: FROM_SPEC }),
			],
			runs: [
				...runs("t_real_open", "pass pass pass"),
				...runs("t_syn_open", "fail fail fail"),
				...runs("t_real_blocked", "fail fail fail"),
				...runs("t_syn_blocked", "pass pass pass"),
			],
		}));
		// The same job and difficulty in two world states are two cells — the
		// stateless one first — and the synthetic side is behind in one and ahead
		// in the other.
		expect(reading.origins.comparable.map((cell) => [cell.state, cell.gapPoints])).toEqual([
			[null, -100],
			["account blocked", 100],
		]);
	});

	it("calls realism unverified while no real case shares a cell with a synthetic one", () => {
		const reading = readBasket(input({
			jobs: [billing.job],
			tasks: [task("t_syn_a", { coverage: billing, source: FROM_SPEC }), task("t_syn_b", { coverage: billing, source: FROM_SPEC })],
			runs: [...runs("t_syn_a", "pass pass"), ...runs("t_syn_b", "fail fail")],
		}));
		expect(reading.origins).toMatchObject({ real: 0, synthetic: 2, realism: "unverified" });
		expect(reading.origins.comparable).toEqual([]);
	});

	it("leaves a case the engine lost out of the cell instead of scoring it zero", () => {
		const reading = readBasket(input({
			jobs: [billing.job],
			tasks: [
				task("t_real", { coverage: billing, source: IMPORTED }),
				task("t_syn", { coverage: billing, source: FROM_SPEC }),
				task("t_syn_lost", { coverage: billing, source: FROM_SPEC }),
			],
			runs: [
				...runs("t_real", "pass pass"),
				...runs("t_syn", "pass pass"),
				...runs("t_syn_lost", "error error"),
			],
		}));
		expect(reading.origins.comparable).toEqual([{
			job: billing.job,
			difficulty: "direct",
			state: null,
			real: { cases: 1, passRate: 1 },
			// One synthetic case, not two: the lost one has no pass rate to average.
			synthetic: { cases: 1, passRate: 1 },
			gapPoints: 0,
		}]);
	});
});

describe("where the next wave goes", () => {
	it("names the empty cells of the Spec's jobs, the modes still failing, and the jobs that got easy", () => {
		const jobs = ["answer billing questions", "cancel a subscription"];
		const reading = readBasket(input({
			jobs,
			tasks: [
				task("t_billing_direct", { coverage: { job: jobs[0]!, difficulty: "direct" }, source: FROM_SPEC }),
				task("t_billing_trap", { coverage: { job: jobs[0]!, difficulty: "policy-trap" }, source: FROM_SPEC }),
				task("t_cancel_direct", { coverage: { job: jobs[1]!, difficulty: "direct" }, source: FROM_SPEC }),
			],
			runs: [
				...runs("t_billing_direct", "pass pass"),
				// One failing case in the job, so it is not a job to make harder.
				...runs("t_billing_trap", "fail fail"),
				...runs("t_cancel_direct", "pass pass"),
			],
			unresolvedModes: ["check_dbo was never called", "the agent invented a tariff"],
		}));
		// Six difficulties per job; the two jobs together hold three of the twelve cells.
		expect(reading.nextWave.emptyCells).toHaveLength(9);
		expect(reading.nextWave.emptyCells).toContainEqual({ job: jobs[0], difficulty: "clarify" });
		expect(reading.nextWave.emptyCells).not.toContainEqual({ job: jobs[0], difficulty: "direct" });
		expect(reading.nextWave.targetModes).toEqual(["check_dbo was never called", "the agent invented a tariff"]);
		// Every labelled case of the second job passed every repetition, so that
		// is where the next wave is written harder.
		expect(reading.nextWave.harderJobs).toEqual([jobs[1]]);
	});

	it("never calls a job with no case of its own an easy one", () => {
		const reading = readBasket(input({ jobs: ["unwritten job"], tasks: [], runs: [] }));
		expect(reading.nextWave.harderJobs).toEqual([]);
		expect(reading.nextWave.emptyCells).toHaveLength(6);
	});
});

/**
 * The rule, as a test. A case that fails every repetition with a test the
 * critic found sound is capability work on the agent: it stays in the basket,
 * it is counted as work, and no field of the reading proposes getting rid of
 * it. Selection must not improve the metrics by deleting hard tasks.
 */
describe("the rule", () => {
	it("keeps a sound case that never passes, as work and never as a candidate for removal", () => {
		const reading = readBasket(input({
			jobs: ["answer billing questions"],
			tasks: [task("t_hard", { coverage: { job: "answer billing questions", difficulty: "no-answer" }, source: FROM_SPEC })],
			runs: runs("t_hard", "fail fail fail"),
			critic: receipt([{ taskId: "t_hard", verdict: "valid", reasons: [] }]),
		}));
		expect(reading.cases.map((item) => item.taskId)).toContain("t_hard");
		expect(reading.counts).toMatchObject({ failing: 1, failingValid: 1, failingDoubtful: 0 });
		// Nothing in the reading is a list of cases to remove, drop or exclude.
		expect(JSON.stringify(reading)).not.toMatch(/drop|remove|exclude|prune|worst/i);
	});
});

describe("the basket panel", () => {
	afterEach(() => {
		setLanguage(null);
	});

	const reading: WorkbenchBasketReading = {
		evalRunId: "erun-1",
		cases: [],
		counts: { saturated: 4, failing: 3, unstable: 1, failingValid: 1, failingDoubtful: 1, failingUnreviewed: 1 },
		wave: { newCases: 5, newFailing: 2, saturated: false },
		origins: {
			real: 3,
			synthetic: 7,
			unknown: 0,
			comparable: [{
				job: "answer billing questions",
				difficulty: "direct",
				state: "account blocked",
				real: { cases: 2, passRate: 0.5 },
				synthetic: { cases: 4, passRate: 0.75 },
				gapPoints: 25,
			}],
			realism: "compared",
		},
		nextWave: {
			emptyCells: [{ job: "cancel a subscription", difficulty: "clarify" }, { job: "cancel a subscription", difficulty: "no-answer" }],
			targetModes: ["check_dbo was never called"],
			harderJobs: ["answer billing questions"],
		},
	};

	it("names the work plainly, warns about the doubted test, and closes with the rule", () => {
		setLanguage("en");
		const lines = renderBasket(reading, plainPaint);
		expect(lines[0]).toBe(t("basket.title"));
		const text = lines.join("\n");
		// A reading too long for one line is wrapped at a word and continues,
		// indented, on the next — so the sentence is read whole off the two.
		const flat = lines.join(" ").replace(/\s+/g, " ");
		expect(text).toContain("4 cases passed every time");
		expect(text).toContain("1 case failed every time and the critic found the case sound");
		// The doubt is about the test's own criteria, and the tail of the sentence
		// that says so is exactly the part that must not be cut.
		expect(flat).toContain("never drop it for failing");
		expect(text).toContain("1 case failed every time and nobody has read the case");
		expect(text).toContain("this wave added 5 cases, 2 of them fail");
		expect(text).toContain("origins: 3 real · 7 synthetic · 0 unlabelled; realism compared on 1 comparable cell(s)");
		// The cell, the two pass rates, how many cases each rests on, and the gap.
		expect(text).toContain("answer billing questions × direct · account blocked: real 50% · 2 cases vs synthetic 75% · 4 cases (+25 pts)");
		expect(flat).toContain(
			"next wave: empty cells cancel a subscription × clarify, cancel a subscription × no-answer · " +
				"unresolved modes check_dbo was never called · harder cases for answer billing questions",
		);
		// Nothing on the panel ends in an ellipsis: every reading is wrapped whole.
		for (const line of lines) expect(line).not.toContain("…");
		expect(lines[lines.length - 1]).toBe(t("basket.rule"));
		for (const line of lines) expect([...line].length).toBeLessThanOrEqual(120);
	});

	it("says nothing about counts that are zero, and calls a whole wave passed saturation", () => {
		setLanguage("en");
		const quiet = renderBasket({
			...reading,
			counts: { saturated: 2, failing: 0, unstable: 0, failingValid: 0, failingDoubtful: 0, failingUnreviewed: 0 },
			wave: { newCases: 2, newFailing: 0, saturated: true },
			origins: { real: 0, synthetic: 2, unknown: 0, comparable: [], realism: "unverified" },
			nextWave: { emptyCells: [], targetModes: [], harderJobs: [] },
		}, plainPaint);
		const text = quiet.join("\n");
		expect(text).not.toContain("failed every time");
		expect(text).not.toContain("moved between repetitions");
		expect(text).toContain("saturation — the next wave must be harder");
		expect(text).toContain("realism unverified — no comparable real cases yet");
		// Nothing to aim the next wave at, so the line is absent rather than empty.
		expect(text).not.toContain("next wave:");
		expect(quiet[quiet.length - 1]).toBe(t("basket.rule"));
	});

	it("leaves the wave line off a re-run that added nothing", () => {
		setLanguage("en");
		const text = renderBasket({ ...reading, wave: { newCases: 0, newFailing: 0, saturated: false } }, plainPaint).join("\n");
		expect(text).not.toContain("this wave added");
	});

	it("reads in Russian, with the rule under it", () => {
		setLanguage("ru");
		const lines = renderBasket(reading, plainPaint);
		expect(lines[0]).toBe(t("basket.title"));
		expect(lines.join("\n")).toContain("за провал не удалять");
		expect(lines[lines.length - 1]).toBe(t("basket.rule"));
		for (const line of lines) expect([...line].length).toBeLessThanOrEqual(120);
	});
});
