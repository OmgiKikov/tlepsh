import { sha256Hex } from "../provenance.js";

/**
 * The Comparison Gate: the only place AHDE decides whether a paired
 * baseline/candidate comparison counts as an improvement or a regression.
 *
 * Inputs are the per-task paired rows produced by `compare.ts` (pass counts
 * over repetitions plus arm statuses). Everything here is pure and
 * deterministic so the same rows always yield the same verdict and hash.
 *
 * Rule `exact-comparison-gate-v3` (see docs/V1_8_EVIDENCE_GATE.md):
 *   d_i      = candidateRate_i − baselineRate_i over tasks without errors
 *   [lo, hi] = seeded paired bootstrap 95% interval over the task deltas
 *   development: improved iff lo > 0 · regressed iff hi < 0 · else inconclusive
 *   sealed:      underpowered iff tasks < 15 or repetitions < 2
 *                fail iff hi < 0 · else pass
 * Per-task drops are flags for humans; they never gate.
 */

export const EXACT_COMPARISON_GATE_ALGORITHM_ID_V3 = "exact-comparison-gate-v3" as const;

export type GateSurface = "development" | "sealed";

/**
 * Share of runs or tasks an evaluation may lose to infrastructure errors
 * (judge outages, provider 5xx, timeouts) and still count as evidence. Errored
 * tasks are excluded from the statistics; above this share the surface is
 * inconclusive/underpowered and a candidate experiment stops.
 */
export const INFRASTRUCTURE_ERROR_BUDGET = 0.1;

export function withinInfrastructureBudget(errors: number, total: number): boolean {
	return total <= 0 ? errors === 0 : errors / total <= INFRASTRUCTURE_ERROR_BUDGET;
}

export interface GatePolicy {
	readonly id: "development-ci-v3" | "sealed-guardrail-v3";
	readonly surface: GateSurface;
	/** Fewer included tasks than this makes a sealed verdict `underpowered`. */
	readonly minTasks: number;
	/** Fewer repetitions than this makes a sealed verdict `underpowered`. */
	readonly minRepetitions: number;
	/** Share of tasks that may be excluded for infrastructure errors. */
	readonly maxExcludedShare: number;
}

export const DEVELOPMENT_GATE_POLICY: GatePolicy = {
	id: "development-ci-v3",
	surface: "development",
	minTasks: 1,
	minRepetitions: 1,
	maxExcludedShare: INFRASTRUCTURE_ERROR_BUDGET,
};

export const SEALED_GATE_POLICY: GatePolicy = {
	id: "sealed-guardrail-v3",
	surface: "sealed",
	minTasks: 15,
	minRepetitions: 2,
	maxExcludedShare: INFRASTRUCTURE_ERROR_BUDGET,
};

export function gatePolicyFor(surface: GateSurface): GatePolicy {
	return surface === "sealed" ? SEALED_GATE_POLICY : DEVELOPMENT_GATE_POLICY;
}

export const DEVELOPMENT_VERDICTS = ["improved", "inconclusive", "regressed"] as const;
export const SEALED_VERDICTS = ["pass", "fail", "underpowered"] as const;
export type DevelopmentVerdict = (typeof DEVELOPMENT_VERDICTS)[number];
export type SealedVerdict = (typeof SEALED_VERDICTS)[number];
export type GateVerdict = DevelopmentVerdict | SealedVerdict;

/** Bootstrap resamples used for durable evidence. Tests may lower it. */
export const DEFAULT_BOOTSTRAP_RESAMPLES = 5_000;

export interface CompareRow {
	taskId: string;
	aPassRate: number;
	bPassRate: number;
	delta: number;
	aStatus: string;
	bStatus: string;
	aPass: number;
	aTotal: number;
	bPass: number;
	bTotal: number;
}

export interface CompareSummary {
	taskCount: number;
	baselinePassRate: number;
	candidatePassRate: number;
	delta: number;
	confidence95: { low: number; high: number };
	improved: number;
	regressed: number;
	unchanged: number;
}

export interface ComparisonDesign {
	/** Tasks that entered the statistics (no error in either arm). */
	tasks: number;
	repetitions: number;
	/** Tasks left out because one arm has an infrastructure error. */
	excludedTasks: number;
}

export interface ComparisonFlags {
	regressedTasks: number;
	improvedTasks: number;
	/** Tasks that always passed on the baseline and never on the candidate (k ≥ 3). */
	collapsedTasks: number;
}

export interface GateDecision {
	policyId: GatePolicy["id"];
	surface: GateSurface;
	verdict: GateVerdict;
	/** Human sentences without task identifiers; safe for sealed rendering. */
	reasons: string[];
}

export interface ComparisonStatistics {
	summary: CompareSummary;
	design: ComparisonDesign;
	flags: ComparisonFlags;
	gate: GateDecision;
}

export interface JudgeComparisonOptions {
	surface: GateSurface;
	repetitions: number;
	/** Deterministic seed text, normally `${baselineEvalRunId}:${candidateEvalRunId}`. */
	seed: string;
	resamples?: number;
}

/** Locale-independent UTF-8 ordering for every persisted/public projection. */
export function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function mean(values: readonly number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Deterministic paired bootstrap over tasks; repetitions stay inside each task aggregate. */
export function bootstrap95(
	deltas: readonly number[],
	seedText: string,
	resamples = DEFAULT_BOOTSTRAP_RESAMPLES,
): { low: number; high: number } {
	if (deltas.length === 0) return { low: 0, high: 0 };
	if (deltas.length === 1) return { low: deltas[0] ?? 0, high: deltas[0] ?? 0 };
	let state = Number.parseInt(sha256Hex(seedText).slice(0, 8), 16) >>> 0;
	const random = (): number => {
		state += 0x6d2b79f5;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
	const samples: number[] = [];
	for (let sample = 0; sample < resamples; sample += 1) {
		let total = 0;
		for (let index = 0; index < deltas.length; index += 1) {
			total += deltas[Math.floor(random() * deltas.length)] ?? 0;
		}
		samples.push(total / deltas.length);
	}
	samples.sort((a, b) => a - b);
	return {
		low: samples[Math.floor(samples.length * 0.025)] ?? 0,
		high: samples[Math.floor(samples.length * 0.975)] ?? 0,
	};
}

export function formatPoints(value: number): string {
	const points = value * 100;
	const rounded = Math.round(points * 10) / 10;
	return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}pp`;
}

function includedRow(row: CompareRow): boolean {
	return row.aStatus !== "error" && row.bStatus !== "error" && row.aTotal > 0 && row.bTotal > 0;
}

/** Pure. Computes the paired statistics and the one gate decision for a surface. */
export function judgeComparison(rows: readonly CompareRow[], options: JudgeComparisonOptions): ComparisonStatistics {
	const policy = gatePolicyFor(options.surface);
	const included = rows.filter(includedRow);
	const deltas = included.map((row) => row.delta);
	const point = mean(deltas);
	const confidence95 = bootstrap95(deltas, options.seed, options.resamples);
	const improved = deltas.filter((delta) => delta > 0).length;
	const regressed = deltas.filter((delta) => delta < 0).length;
	const collapsed = included.filter((row) =>
		row.aTotal >= 3 && row.bTotal >= 3 && row.aPass === row.aTotal && row.bPass === 0).length;
	const summary: CompareSummary = {
		taskCount: included.length,
		baselinePassRate: mean(included.map((row) => row.aPassRate)),
		candidatePassRate: mean(included.map((row) => row.bPassRate)),
		delta: point,
		confidence95,
		improved,
		regressed,
		unchanged: included.length - improved - regressed,
	};
	const design: ComparisonDesign = {
		tasks: included.length,
		repetitions: options.repetitions,
		excludedTasks: rows.length - included.length,
	};
	const flags: ComparisonFlags = { regressedTasks: regressed, improvedTasks: improved, collapsedTasks: collapsed };
	return { summary, design, flags, gate: decide(policy, summary, design) };
}

function decide(policy: GatePolicy, summary: CompareSummary, design: ComparisonDesign): GateDecision {
	const { low, high } = summary.confidence95;
	const interval = `95% CI ${formatPoints(low)} … ${formatPoints(high)}`;
	const size = `${design.tasks} task${design.tasks === 1 ? "" : "s"} × ${design.repetitions} repetition${design.repetitions === 1 ? "" : "s"}`;
	const excluded = design.excludedTasks > 0
		? [`${design.excludedTasks} task${design.excludedTasks === 1 ? "" : "s"} excluded for infrastructure errors`]
		: [];
	const base = { policyId: policy.id, surface: policy.surface };
	const total = design.tasks + design.excludedTasks;
	if (total > 0 && design.excludedTasks / total > policy.maxExcludedShare) {
		const overBudget = `${design.excludedTasks} of ${total} tasks excluded for infrastructure errors exceeds the ${Math.round(policy.maxExcludedShare * 100)}% budget`;
		return policy.surface === "sealed"
			? { ...base, verdict: "underpowered", reasons: [overBudget] }
			: { ...base, verdict: "inconclusive", reasons: [overBudget] };
	}
	if (policy.surface === "sealed") {
		if (design.tasks < policy.minTasks || design.repetitions < policy.minRepetitions) {
			return {
				...base,
				verdict: "underpowered",
				reasons: [
					`${size}; the sealed guardrail needs at least ${policy.minTasks} tasks × ${policy.minRepetitions} repetitions`,
					...excluded,
				],
			};
		}
		if (high < 0) {
			return { ...base, verdict: "fail", reasons: [`regressed: ${interval} lies entirely below zero on ${size}`, ...excluded] };
		}
		return { ...base, verdict: "pass", reasons: [`no regression: ${interval} is not entirely below zero on ${size}`, ...excluded] };
	}
	if (design.tasks < 1) {
		return { ...base, verdict: "inconclusive", reasons: ["no comparable tasks", ...excluded] };
	}
	if (low > 0) return { ...base, verdict: "improved", reasons: [`${interval} lies entirely above zero on ${size}`, ...excluded] };
	if (high < 0) return { ...base, verdict: "regressed", reasons: [`${interval} lies entirely below zero on ${size}`, ...excluded] };
	return { ...base, verdict: "inconclusive", reasons: [`${interval} spans zero on ${size}`, ...excluded] };
}

/** A candidate is promotable only when both surfaces carry a favourable verdict. */
export function promotableVerdicts(development: GateVerdict | null, sealed: GateVerdict | null): boolean {
	return sealed === "pass" && development !== null && development !== "regressed";
}

export function isDevelopmentVerdict(value: string): value is DevelopmentVerdict {
	return (DEVELOPMENT_VERDICTS as readonly string[]).includes(value);
}

export function isSealedVerdict(value: string): value is SealedVerdict {
	return (SEALED_VERDICTS as readonly string[]).includes(value);
}
