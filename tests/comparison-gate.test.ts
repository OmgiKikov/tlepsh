import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEVELOPMENT_GATE_POLICY,
	EXACT_COMPARISON_GATE_ALGORITHM_ID_V3,
	EXACT_COMPARISON_GATE_ALGORITHM_ID_V4,
	SEALED_GATE_POLICY,
	formatResourceFragment,
	judgeComparison,
	promotableVerdicts,
	resourceRatios,
	resourceTotals,
	type CompareRow,
} from "../src/domain/comparison-gate.js";
import {
	ComparisonGateEvidenceSchema,
	isPromotionGradeGateEvidence,
	gateVerdictOf,
	promotionGradeVerdictOf,
} from "../src/domain/candidate.js";

type Outcome = "pass" | "fail" | "error";

interface PairFixture {
	note: string;
	baseline: { evalRunId: string; repetitions: number };
	candidate: { evalRunId: string; repetitions: number };
	tasks: { taskId: string; baseline: Outcome[]; candidate: Outcome[] }[];
}

function loadFixture(name: string): PairFixture {
	return JSON.parse(readFileSync(join(__dirname, "fixtures", "comparison-gate", `${name}.json`), "utf8")) as PairFixture;
}

function rowsFromOutcomes(tasks: PairFixture["tasks"]): CompareRow[] {
	return tasks.map((task) => {
		const aPass = task.baseline.filter((outcome) => outcome === "pass").length;
		const bPass = task.candidate.filter((outcome) => outcome === "pass").length;
		const aRate = task.baseline.length === 0 ? 0 : aPass / task.baseline.length;
		const bRate = task.candidate.length === 0 ? 0 : bPass / task.candidate.length;
		return {
			taskId: task.taskId,
			aPassRate: aRate,
			bPassRate: bRate,
			delta: bRate - aRate,
			// The real fixtures are binary-graded: score and pass rate coincide.
			aScore: aRate,
			bScore: bRate,
			scoreDelta: bRate - aRate,
			aStatus: task.baseline.includes("error") ? "error" : "completed",
			bStatus: task.candidate.includes("error") ? "error" : "completed",
			aPass,
			aTotal: task.baseline.length,
			bPass,
			bTotal: task.candidate.length,
		};
	});
}

/**
 * A row whose grader scores are given directly. `aPass`/`bPass` still describe
 * the binary outcome, so a test can hold the pass rate fixed and move the score.
 */
function scoredRow(input: {
	taskId: string;
	k: number;
	aPass: number;
	bPass: number;
	aScore: number;
	bScore: number;
}): CompareRow {
	const aPassRate = input.aPass / input.k;
	const bPassRate = input.bPass / input.k;
	return {
		taskId: input.taskId,
		aPassRate,
		bPassRate,
		delta: bPassRate - aPassRate,
		aScore: input.aScore,
		bScore: input.bScore,
		scoreDelta: input.bScore - input.aScore,
		aStatus: "completed",
		bStatus: "completed",
		aPass: input.aPass,
		aTotal: input.k,
		bPass: input.bPass,
		bTotal: input.k,
	};
}

/** The same rows judged as v3 would have judged them: pass rate as the score. */
function asPassRateRows(rows: readonly CompareRow[]): CompareRow[] {
	return rows.map((row) => ({
		...row,
		aScore: row.aPassRate,
		bScore: row.bPassRate,
		scoreDelta: row.bPassRate - row.aPassRate,
	}));
}

/** Small deterministic PRNG so the simulation is reproducible. */
function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state += 0x6d2b79f5;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function binomial(random: () => number, k: number, p: number): number {
	let passes = 0;
	for (let index = 0; index < k; index += 1) if (random() < p) passes += 1;
	return passes;
}

function simulatedRows(random: () => number, tasks: number, k: number, baselineP: number, candidateP: number): CompareRow[] {
	return Array.from({ length: tasks }, (_, index) => {
		const aPass = binomial(random, k, baselineP);
		const bPass = binomial(random, k, candidateP);
		return {
			taskId: `task-${index + 1}`,
			aPassRate: aPass / k,
			bPassRate: bPass / k,
			delta: bPass / k - aPass / k,
			aScore: aPass / k,
			bScore: bPass / k,
			scoreDelta: bPass / k - aPass / k,
			aStatus: "completed",
			bStatus: "completed",
			aPass,
			aTotal: k,
			bPass,
			bTotal: k,
		};
	});
}

function verdictRates(options: {
	surface: "development" | "sealed";
	tasks: number;
	k: number;
	baselineP: number;
	candidateP: number;
	trials: number;
	seed: number;
}): Record<string, number> {
	const random = prng(options.seed);
	const counts: Record<string, number> = {};
	for (let trial = 0; trial < options.trials; trial += 1) {
		const rows = simulatedRows(random, options.tasks, options.k, options.baselineP, options.candidateP);
		const { gate } = judgeComparison(rows, {
			surface: options.surface,
			repetitions: options.k,
			seed: `simulation:${options.seed}:${trial}`,
			resamples: 600,
		});
		counts[gate.verdict] = (counts[gate.verdict] ?? 0) + 1;
	}
	for (const key of Object.keys(counts)) counts[key] = (counts[key] ?? 0) / options.trials;
	return counts;
}

describe("comparison gate — exact-comparison-gate-v4", () => {
	it("keeps the sealed false-fail rate under 10% for every Bernoulli null cell with k ≥ 2", () => {
		const trials = 120;
		let seed = 11;
		for (const p of [0.5, 0.8, 0.95]) {
			for (const k of [2, 3]) {
				const rates = verdictRates({ surface: "sealed", tasks: 30, k, baselineP: p, candidateP: p, trials, seed: seed += 1 });
				expect(rates.fail ?? 0, `p=${p} k=${k}`).toBeLessThan(0.1);
				expect(rates.underpowered ?? 0, `p=${p} k=${k}`).toBe(0);
			}
			const single = verdictRates({ surface: "sealed", tasks: 30, k: 1, baselineP: p, candidateP: p, trials: 20, seed: seed += 1 });
			expect(single.underpowered, `p=${p} k=1`).toBe(1);
		}
	});

	it("catches a 30-point sealed regression in at least 95% of trials at 30 tasks × 3", () => {
		const rates = verdictRates({ surface: "sealed", tasks: 30, k: 3, baselineP: 0.8, candidateP: 0.5, trials: 120, seed: 101 });
		expect(rates.fail ?? 0).toBeGreaterThanOrEqual(0.95);
	});

	it("declares a 20-point development improvement in at least 70% of trials at 30 tasks × 3", () => {
		const rates = verdictRates({ surface: "development", tasks: 30, k: 3, baselineP: 0.6, candidateP: 0.8, trials: 120, seed: 202 });
		expect(rates.improved ?? 0).toBeGreaterThanOrEqual(0.7);
		expect(rates.regressed ?? 0).toBe(0);
	});

	it("marks a sealed comparison underpowered below 15 tasks or 2 repetitions", () => {
		const random = prng(7);
		const small = judgeComparison(simulatedRows(random, 14, 3, 0.5, 1), { surface: "sealed", repetitions: 3, seed: "small" });
		expect(small.gate.verdict).toBe("underpowered");
		// The shortfall is arithmetic, not "fewer than 15": what is there, what is
		// needed, and the difference.
		expect(small.gate.reasons[0]).toBe(
			`the exam has 14 cases; the sealed guardrail needs ${SEALED_GATE_POLICY.minTasks} — 1 more`,
		);
		const shallow = judgeComparison(simulatedRows(random, 30, 1, 0.5, 1), { surface: "sealed", repetitions: 1, seed: "shallow" });
		expect(shallow.gate.verdict).toBe("underpowered");
		expect(shallow.gate.reasons[0]).toBe(
			`${SEALED_GATE_POLICY.minRepetitions} repetitions needed, 1 ran — 1 more`,
		);
		// Both short at once says both, and never leaves the operator subtracting.
		const bothShort = judgeComparison(simulatedRows(random, 10, 1, 0.5, 1), { surface: "sealed", repetitions: 1, seed: "both" });
		expect(bothShort.gate.reasons[0]).toBe(
			"the exam has 10 cases; the sealed guardrail needs 15 — 5 more · 2 repetitions needed, 1 ran — 1 more",
		);
		const enough = judgeComparison(simulatedRows(random, 15, 2, 0.5, 1), { surface: "sealed", repetitions: 2, seed: "enough" });
		expect(enough.gate.verdict).toBe("pass");
		expect(DEVELOPMENT_GATE_POLICY.minTasks).toBe(1);
	});

	it("flags collapsed tasks only from three repetitions and never lets flags gate", () => {
		const collapsedRows: CompareRow[] = Array.from({ length: 15 }, (_, index) => ({
			taskId: `task-${index + 1}`,
			aPassRate: index === 0 ? 1 : 0.5,
			bPassRate: index === 0 ? 0 : 0.5,
			delta: index === 0 ? -1 : 0,
			aScore: index === 0 ? 1 : 0.5,
			bScore: index === 0 ? 0 : 0.5,
			scoreDelta: index === 0 ? -1 : 0,
			aStatus: "completed",
			bStatus: "completed",
			aPass: index === 0 ? 3 : 1.5,
			aTotal: 3,
			bPass: index === 0 ? 0 : 1.5,
			bTotal: 3,
		}));
		const three = judgeComparison(collapsedRows, { surface: "sealed", repetitions: 3, seed: "collapsed" });
		expect(three.flags.collapsedTasks).toBe(1);
		expect(three.flags.regressedTasks).toBe(1);
		// One collapsed task among fifteen is a flag, not a verdict: the interval still spans zero.
		expect(three.gate.verdict).toBe("pass");
		const two = judgeComparison(collapsedRows.map((row) => ({ ...row, aTotal: 2, bTotal: 2, aPass: row.aPass / 1.5, bPass: row.bPass / 1.5 })), { surface: "sealed", repetitions: 2, seed: "collapsed-2" });
		expect(two.flags.collapsedTasks).toBe(0);
		// Collapse is a score claim: partial credit on the candidate is not a collapse.
		const partial = judgeComparison(
			collapsedRows.map((row, index) => (index === 0 ? { ...row, bScore: 0.2, scoreDelta: -0.8 } : row)),
			{ surface: "sealed", repetitions: 3, seed: "collapsed-partial" },
		);
		expect(partial.flags.collapsedTasks).toBe(0);
		expect(partial.flags.regressedTasks).toBe(1);
	});

	it("keeps a sealed verdict when one task of a 15-task holdout is excluded within the error budget", () => {
		const rows = simulatedRows(prng(5), 15, 3, 0.4, 1);
		rows[3] = { ...rows[3]!, aStatus: "error" };
		const judged = judgeComparison(rows, { surface: "sealed", repetitions: 3, seed: "one-excluded" });
		expect(judged.design).toEqual({ tasks: 14, repetitions: 3, excludedTasks: 1 });
		expect(judged.gate.verdict).toBe("pass");
		// Two exclusions out of 15 (13%) exceed the budget and make the surface underpowered.
		rows[7] = { ...rows[7]!, bStatus: "error" };
		expect(judgeComparison(rows, { surface: "sealed", repetitions: 3, seed: "two-excluded" }).gate.verdict).toBe("underpowered");
	});

	it("excludes tasks with infrastructure errors from the statistics and reports them", () => {
		const rows = simulatedRows(prng(3), 16, 2, 0.5, 0.5);
		rows[0] = { ...rows[0]!, bStatus: "error" };
		const judged = judgeComparison(rows, { surface: "sealed", repetitions: 2, seed: "excluded" });
		expect(judged.design).toEqual({ tasks: 15, repetitions: 2, excludedTasks: 1 });
		expect(judged.summary.taskCount).toBe(15);
		expect(judged.gate.reasons.some((reason) => reason.includes("1 task excluded"))).toBe(true);
	});

	it("judges the real dd68f00 A/A pair (30 × 2) as inconclusive development and a sealed pass", () => {
		const fixture = loadFixture("aa-dd68f00-30x2");
		const rows = rowsFromOutcomes(fixture.tasks);
		const development = judgeComparison(rows, { surface: "development", repetitions: 2, seed: "aa-dev" });
		expect(development.gate.verdict).toBe("inconclusive");
		expect(development.flags.regressedTasks).toBeGreaterThan(0);
		const sealed = judgeComparison(rows, { surface: "sealed", repetitions: 2, seed: "aa-sealed" });
		expect(sealed.gate.verdict).toBe("pass");
		expect(promotableVerdicts(development.gate.verdict, sealed.gate.verdict)).toBe(true);
	});

	it("judges the real f1f7265 → dd68f00 pair (30 × 2) as an improvement despite one errored baseline run", () => {
		const fixture = loadFixture("improvement-f1f7265-dd68f00-30x2");
		const rows = rowsFromOutcomes(fixture.tasks);
		const development = judgeComparison(rows, { surface: "development", repetitions: 2, seed: "improvement" });
		expect(development.design.excludedTasks).toBe(1);
		expect(development.gate.verdict).toBe("improved");
		expect(development.summary.confidence95.low).toBeGreaterThan(0.3);
		expect(development.summary.delta).toBeGreaterThan(0.4);
	});

	it("never promotes without a sealed pass or with a regressed development verdict", () => {
		expect(promotableVerdicts("improved", "pass")).toBe(true);
		expect(promotableVerdicts("inconclusive", "pass")).toBe(true);
		expect(promotableVerdicts("regressed", "pass")).toBe(false);
		expect(promotableVerdicts("improved", "fail")).toBe(false);
		expect(promotableVerdicts("improved", "underpowered")).toBe(false);
		expect(promotableVerdicts(null, "pass")).toBe(false);
	});

	it("reproduces the pass-rate verdict on every binary-graded row", () => {
		// The v3 rule is the v4 rule restricted to scores in {0,1}: judging the
		// same rows twice, once with the score forced to the pass rate, agrees.
		const random = prng(4242);
		for (const [tasks, k, p, q] of [[30, 3, 0.6, 0.8], [30, 2, 0.9, 0.9], [16, 3, 0.8, 0.5]] as const) {
			const rows = simulatedRows(random, tasks, k, p, q);
			for (const surface of ["development", "sealed"] as const) {
				const scored = judgeComparison(rows, { surface, repetitions: k, seed: "parity", resamples: 400 });
				const passRates = judgeComparison(asPassRateRows(rows), { surface, repetitions: k, seed: "parity", resamples: 400 });
				expect(scored.gate.verdict).toBe(passRates.gate.verdict);
				expect(scored.summary.scoreDelta).toBeCloseTo(scored.summary.delta, 12);
				expect(scored.summary.baselineScore).toBeCloseTo(scored.summary.baselinePassRate, 12);
			}
		}
	});

	it("lets fractional scores decide a verdict the pass rates could not see", () => {
		// Every run still fails its threshold, so the pass rate never moves; the
		// grader scores climb 20% → 80% and the interval clears zero.
		const rows = Array.from({ length: 20 }, (_, index) =>
			scoredRow({ taskId: `task-${index + 1}`, k: 3, aPass: 0, bPass: 0, aScore: 0.2, bScore: 0.8 }));
		const scored = judgeComparison(rows, { surface: "development", repetitions: 3, seed: "fractional" });
		expect(scored.gate.verdict).toBe("improved");
		expect(scored.summary.scoreDelta).toBeCloseTo(0.6, 12);
		expect(scored.summary.delta).toBe(0);
		expect(scored.flags.improvedTasks).toBe(20);
		const blind = judgeComparison(asPassRateRows(rows), { surface: "development", repetitions: 3, seed: "fractional" });
		expect(blind.gate.verdict).toBe("inconclusive");
	});

	it("lets fractional scores overturn a verdict the pass rates would call regressed", () => {
		// Baseline scrapes past the threshold twice (0.60, 0.60); the candidate
		// nails one repetition and just misses the other (1.00, 0.59). Half the
		// passes are gone, yet the answer is measurably better.
		const rows = Array.from({ length: 20 }, (_, index) =>
			scoredRow({ taskId: `task-${index + 1}`, k: 2, aPass: 2, bPass: 1, aScore: 0.6, bScore: 0.795 }));
		const scored = judgeComparison(rows, { surface: "development", repetitions: 2, seed: "overturn" });
		expect(scored.gate.verdict).toBe("improved");
		expect(scored.summary.delta).toBeCloseTo(-0.5, 12);
		expect(scored.summary.scoreDelta).toBeCloseTo(0.195, 12);
		expect(scored.flags.regressedTasks).toBe(0);
		const blind = judgeComparison(asPassRateRows(rows), { surface: "development", repetitions: 2, seed: "overturn" });
		expect(blind.gate.verdict).toBe("regressed");
		// The sealed guardrail follows the score too: no fail on a real gain.
		expect(judgeComparison(rows, { surface: "sealed", repetitions: 2, seed: "overturn" }).gate.verdict).toBe("pass");
		expect(judgeComparison(asPassRateRows(rows), { surface: "sealed", repetitions: 2, seed: "overturn" }).gate.verdict).toBe("fail");
	});

	it("aggregates cost, latency and tokens into flags that never touch the verdict", () => {
		const baseline = resourceTotals([
			{ costUsd: 0.01, latencyMs: 1_000, tokens: 500 },
			{ costUsd: 0.03, latencyMs: 3_000, tokens: 1_500 },
		]);
		const candidate = resourceTotals([
			{ costUsd: 0.028, latencyMs: 900, tokens: 2_000 },
			{ costUsd: 0.028, latencyMs: 900, tokens: 2_000 },
		]);
		expect(baseline).toEqual({ runs: 2, costUsd: 0.04, meanLatencyMs: 2_000, meanTokens: 1_000 });
		const resources = resourceRatios(baseline, candidate);
		expect(resources.costRatio).toBe(1.4);
		expect(resources.latencyRatio).toBe(0.45);
		expect(resources.tokenRatio).toBe(2);
		expect(formatResourceFragment(resources)).toBe("cost ×1.4 · latency ×0.5");
		expect(formatResourceFragment(resources, { tokens: true })).toBe("cost ×1.4 · latency ×0.5 · tokens ×2.0");
		// A free baseline leaves no ratio to report rather than an infinity.
		const free = resourceRatios(resourceTotals([{ costUsd: 0, latencyMs: 0, tokens: 0 }]), candidate);
		expect(free).toMatchObject({ costRatio: null, latencyRatio: null, tokenRatio: null });
		expect(formatResourceFragment(free)).toBe("");

		const rows = simulatedRows(prng(9), 20, 3, 0.5, 0.9);
		const withResources = judgeComparison(rows, { surface: "sealed", repetitions: 3, seed: "res", resources: { baseline, candidate } });
		const without = judgeComparison(rows, { surface: "sealed", repetitions: 3, seed: "res" });
		expect(withResources.gate).toEqual(without.gate);
		expect(withResources.resources.costRatio).toBe(1.4);
		expect(without.resources.costRatio).toBeNull();
	});
});

describe("gate evidence versions", () => {
	const v4 = {
		schemaVersion: 4,
		algorithmId: EXACT_COMPARISON_GATE_ALGORITHM_ID_V4,
		policyId: "sealed-guardrail-v4",
		surface: "sealed",
		comparisonHash: `sha256:${"a".repeat(64)}`,
		evidenceHash: `sha256:${"b".repeat(64)}`,
		gateHash: `sha256:${"c".repeat(64)}`,
		summary: {
			taskCount: 15,
			baselinePassRate: 0.4,
			candidatePassRate: 0.9,
			delta: 0.5,
			baselineScore: 0.45,
			candidateScore: 0.92,
			scoreDelta: 0.47,
			confidence95: { low: 0.3, high: 0.6 },
			improved: 13,
			regressed: 0,
			unchanged: 2,
		},
		design: { tasks: 15, repetitions: 3, excludedTasks: 0 },
		verdict: "pass",
		flags: { regressedTasks: 0, improvedTasks: 13, collapsedTasks: 0 },
		resources: {
			baseline: { runs: 45, costUsd: 0.4, meanLatencyMs: 2_000, meanTokens: 900 },
			candidate: { runs: 45, costUsd: 0.56, meanLatencyMs: 1_800, meanTokens: 1_100 },
			costRatio: 1.4,
			latencyRatio: 0.9,
			tokenRatio: 1.2222,
		},
		reasons: ["no regression on 15 tasks × 3 repetitions"],
	};

	it("round-trips v4 evidence and reports it as promotion-grade", () => {
		const parsed = ComparisonGateEvidenceSchema.parse(v4);
		expect(parsed).toEqual(v4);
		expect(isPromotionGradeGateEvidence(parsed)).toBe(true);
		expect(promotionGradeVerdictOf(parsed)).toBe("pass");
		expect(gateVerdictOf(parsed)).toBe("pass");
	});

	it("still parses v3 evidence but refuses it at promotion", () => {
		const { baselineScore, candidateScore, scoreDelta, ...summary } = v4.summary;
		const { resources, ...rest } = v4;
		const v3 = {
			...rest,
			schemaVersion: 3,
			algorithmId: EXACT_COMPARISON_GATE_ALGORITHM_ID_V3,
			policyId: "sealed-guardrail-v3",
			summary,
		};
		const parsed = ComparisonGateEvidenceSchema.parse(v3);
		expect(parsed).toEqual(v3);
		// Readable, renderable, and never promotion-grade.
		expect(gateVerdictOf(parsed)).toBe("pass");
		expect(isPromotionGradeGateEvidence(parsed)).toBe(false);
		expect(promotionGradeVerdictOf(parsed)).toBeNull();
		expect(baselineScore + candidateScore + scoreDelta).toBeGreaterThan(0);
		expect(resources.costRatio).toBe(1.4);
	});

	it("refuses v4 evidence whose policy or scores do not belong to its surface", () => {
		expect(() => ComparisonGateEvidenceSchema.parse({ ...v4, policyId: "development-ci-v4" })).toThrow();
		expect(() => ComparisonGateEvidenceSchema.parse({ ...v4, verdict: "improved" })).toThrow();
		expect(() => ComparisonGateEvidenceSchema.parse({
			...v4,
			summary: { ...v4.summary, scoreDelta: 2 },
		})).toThrow();
	});
});
