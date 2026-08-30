import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEVELOPMENT_GATE_POLICY,
	SEALED_GATE_POLICY,
	judgeComparison,
	promotableVerdicts,
	type CompareRow,
} from "../src/domain/comparison-gate.js";

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
			aStatus: task.baseline.includes("error") ? "error" : "completed",
			bStatus: task.candidate.includes("error") ? "error" : "completed",
			aPass,
			aTotal: task.baseline.length,
			bPass,
			bTotal: task.candidate.length,
		};
	});
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

describe("comparison gate — exact-comparison-gate-v3", () => {
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
		expect(small.gate.reasons[0]).toContain(`at least ${SEALED_GATE_POLICY.minTasks} tasks`);
		const shallow = judgeComparison(simulatedRows(random, 30, 1, 0.5, 1), { surface: "sealed", repetitions: 1, seed: "shallow" });
		expect(shallow.gate.verdict).toBe("underpowered");
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
});
