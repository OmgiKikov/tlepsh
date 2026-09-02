import { t } from "../i18n.js";
import { sha256Hex } from "../provenance.js";

/**
 * The Comparison Gate: the only place AHDE decides whether a paired
 * baseline/candidate comparison counts as an improvement or a regression.
 *
 * Inputs are the per-task paired rows produced by `compare.ts` (pass counts
 * over repetitions plus arm statuses). Everything here is pure and
 * deterministic so the same rows always yield the same verdict and hash.
 *
 * Rule `exact-comparison-gate-v4` (invariant 34 in docs/INVARIANTS_V1.md):
 *   score_run = mean of the run's grader scores, clamped to [0,1]; a run with
 *               no graders keeps the binary handling (1 when it passed, else 0)
 *   score_i   = mean of a task's run scores over its repetitions
 *   d_i       = candidateScore_i − baselineScore_i over tasks without errors
 *   [lo, hi]  = seeded paired bootstrap 95% interval over the task deltas
 *   development: improved iff lo > 0 · regressed iff hi < 0 · else inconclusive
 *   sealed:      underpowered iff tasks < 15 or repetitions < 2
 *                fail iff hi < 0 · else pass
 * Pass rates stay computed and rendered next to the scores; with binary
 * graders the two coincide, so v3 verdicts are reproduced exactly.
 * Per-task drops are flags for humans; they never gate. Cost, latency, and
 * token ratios are carried alongside the verdict and never gate either.
 */

/** Superseded by v4; kept so historical evidence still names its algorithm. */
export const EXACT_COMPARISON_GATE_ALGORITHM_ID_V3 = "exact-comparison-gate-v3" as const;
export const EXACT_COMPARISON_GATE_ALGORITHM_ID_V4 = "exact-comparison-gate-v4" as const;

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
	readonly id: "development-ci-v4" | "sealed-guardrail-v4";
	readonly surface: GateSurface;
	/** Fewer included tasks than this makes a sealed verdict `underpowered`. */
	readonly minTasks: number;
	/** Fewer repetitions than this makes a sealed verdict `underpowered`. */
	readonly minRepetitions: number;
	/** Share of tasks that may be excluded for infrastructure errors. */
	readonly maxExcludedShare: number;
}

export const DEVELOPMENT_GATE_POLICY: GatePolicy = {
	id: "development-ci-v4",
	surface: "development",
	minTasks: 1,
	minRepetitions: 1,
	maxExcludedShare: INFRASTRUCTURE_ERROR_BUDGET,
};

export const SEALED_GATE_POLICY: GatePolicy = {
	id: "sealed-guardrail-v4",
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
	/** Pass-rate delta. Display only — the gate reads `scoreDelta`. */
	delta: number;
	/** Mean grader score over the baseline arm's repetitions, in [0,1]. */
	aScore: number;
	/** Mean grader score over the candidate arm's repetitions, in [0,1]. */
	bScore: number;
	/** `bScore − aScore`: the paired quantity the gate bootstraps. */
	scoreDelta: number;
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
	/** Pass-rate delta, for display beside the score the gate decided on. */
	delta: number;
	baselineScore: number;
	candidateScore: number;
	/** Mean paired score delta — the point estimate the interval brackets. */
	scoreDelta: number;
	confidence95: { low: number; high: number };
	improved: number;
	regressed: number;
	unchanged: number;
}

/**
 * What one arm of a comparison spent. `costUsd` is the arm total; latency and
 * tokens are per-run means so the two arms stay comparable when a task is
 * excluded. Rounded on construction so recomputed evidence hashes identically.
 */
export interface ResourceTotals {
	runs: number;
	costUsd: number;
	meanLatencyMs: number;
	meanTokens: number;
}

/**
 * Cost, latency, and token ratios of candidate over baseline. Flags for a
 * human: they are recorded and rendered beside every verdict and never gate.
 * A ratio is null when its baseline denominator is zero.
 */
export interface ComparisonResources {
	baseline: ResourceTotals;
	candidate: ResourceTotals;
	costRatio: number | null;
	latencyRatio: number | null;
	tokenRatio: number | null;
}

export const EMPTY_RESOURCE_TOTALS: ResourceTotals = { runs: 0, costUsd: 0, meanLatencyMs: 0, meanTokens: 0 };

export const EMPTY_COMPARISON_RESOURCES: ComparisonResources = {
	baseline: EMPTY_RESOURCE_TOTALS,
	candidate: EMPTY_RESOURCE_TOTALS,
	costRatio: null,
	latencyRatio: null,
	tokenRatio: null,
};

function round(value: number, digits: number): number {
	if (!Number.isFinite(value)) return 0;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

/** Sum cost, mean latency and tokens per run. Pure; rounded for stable hashes. */
export function resourceTotals(
	runs: readonly { costUsd: number; latencyMs: number; tokens: number }[],
): ResourceTotals {
	if (runs.length === 0) return EMPTY_RESOURCE_TOTALS;
	return {
		runs: runs.length,
		costUsd: round(runs.reduce((sum, run) => sum + run.costUsd, 0), 6),
		meanLatencyMs: round(mean(runs.map((run) => run.latencyMs)), 1),
		meanTokens: round(mean(runs.map((run) => run.tokens)), 1),
	};
}

function ratio(candidate: number, baseline: number): number | null {
	return baseline > 0 ? round(candidate / baseline, 4) : null;
}

/** Pure. Candidate-over-baseline resource ratios; null where the baseline is zero. */
export function resourceRatios(baseline: ResourceTotals, candidate: ResourceTotals): ComparisonResources {
	return {
		baseline,
		candidate,
		costRatio: ratio(candidate.costUsd, baseline.costUsd),
		latencyRatio: ratio(candidate.meanLatencyMs, baseline.meanLatencyMs),
		tokenRatio: ratio(candidate.meanTokens, baseline.meanTokens),
	};
}

function formatRatio(value: number): string {
	return `×${value >= 10 ? value.toFixed(0) : value.toFixed(1)}`;
}

/**
 * The compact `cost ×1.4 · latency ×0.9` fragment shown beside every verdict.
 * Empty when nothing was measured, so callers can join it unconditionally.
 */
export function formatResourceFragment(
	resources: Pick<ComparisonResources, "costRatio" | "latencyRatio" | "tokenRatio"> | null | undefined,
	options: { tokens?: boolean } = {},
): string {
	if (!resources) return "";
	const parts = [
		resources.costRatio === null ? null : `${t("unit.cost-ratio")} ${formatRatio(resources.costRatio)}`,
		resources.latencyRatio === null ? null : `${t("unit.latency-ratio")} ${formatRatio(resources.latencyRatio)}`,
		options.tokens && resources.tokenRatio !== null ? `${t("unit.token-ratio")} ${formatRatio(resources.tokenRatio)}` : null,
	].filter((part): part is string => part !== null);
	return parts.join(" · ");
}

export interface ComparisonDesign {
	/** Tasks that entered the statistics (no error in either arm). */
	tasks: number;
	repetitions: number;
	/** Tasks left out because one arm has an infrastructure error. */
	excludedTasks: number;
}

export interface ComparisonFlags {
	/** Tasks whose mean score dropped. */
	regressedTasks: number;
	/** Tasks whose mean score rose. */
	improvedTasks: number;
	/** Tasks that scored a full 1 on the baseline and 0 on the candidate (k ≥ 3). */
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
	resources: ComparisonResources;
	gate: GateDecision;
}

export interface JudgeComparisonOptions {
	surface: GateSurface;
	repetitions: number;
	/** Deterministic seed text, normally `${baselineEvalRunId}:${candidateEvalRunId}`. */
	seed: string;
	resamples?: number;
	/** Per-arm cost/latency/token aggregates; omitted when no metrics are available. */
	resources?: { baseline: ResourceTotals; candidate: ResourceTotals };
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
	// Partial credit: the paired quantity is the mean grader score, not the
	// pass rate. Binary graders make the two identical, so v3 verdicts survive.
	const deltas = included.map((row) => row.scoreDelta);
	const point = mean(deltas);
	const confidence95 = bootstrap95(deltas, options.seed, options.resamples);
	const improved = deltas.filter((delta) => delta > 0).length;
	const regressed = deltas.filter((delta) => delta < 0).length;
	const collapsed = included.filter((row) =>
		row.aTotal >= 3 && row.bTotal >= 3 && row.aScore === 1 && row.bScore === 0).length;
	const summary: CompareSummary = {
		taskCount: included.length,
		baselinePassRate: mean(included.map((row) => row.aPassRate)),
		candidatePassRate: mean(included.map((row) => row.bPassRate)),
		delta: mean(included.map((row) => row.delta)),
		baselineScore: mean(included.map((row) => row.aScore)),
		candidateScore: mean(included.map((row) => row.bScore)),
		scoreDelta: point,
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
	const resources = options.resources
		? resourceRatios(options.resources.baseline, options.resources.candidate)
		: EMPTY_COMPARISON_RESOURCES;
	return { summary, design, flags, resources, gate: decide(policy, summary, design) };
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
		// The minimum applies to the designed holdout; the error budget above
		// already bounds how many of its tasks may drop out of the statistics.
		if (total < policy.minTasks || design.repetitions < policy.minRepetitions) {
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
