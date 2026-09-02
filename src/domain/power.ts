import { SEALED_GATE_POLICY } from "./comparison-gate.js";

/**
 * How big an exam has to be before it can answer, derived from measured noise.
 *
 * The sealed guardrail is a paired 95% interval over per-task score deltas. On
 * a small exam that interval is wide, so `pass` costs almost nothing to earn —
 * the exam cannot see a real difference, not that there is none. An A/A
 * calibration already measures exactly the quantity that sets the width, so it
 * can answer the question nobody could answer before: how many cases would it
 * take to see a ten-point difference on this Target?
 *
 * n = ceil((1.96 · sd / 0.10)²), sd the sample standard deviation of the
 * per-task mean deltas. Clamped to the range an exam may actually have: below
 * the guardrail's own minimum the answer is that minimum, and above the cap a
 * bigger number is advice nobody can act on.
 */

/** The difference an exam of this size could see, in score points. */
export const EXAM_TARGET_HALF_WIDTH = 0.1;
const Z_95 = 1.96;
/** Largest exam the engine will size for; `generate-holdout` stops here too. */
export const MAX_EXAM_CASES = 200;
/** Fewer than this and a standard deviation describes the draw, not the noise. */
const MIN_TASKS_FOR_SPREAD = 3;

function clampCases(cases: number): number {
	return Math.min(MAX_EXAM_CASES, Math.max(SEALED_GATE_POLICY.minTasks, cases));
}

/** Sample (n−1) standard deviation. Pure. */
function standardDeviation(values: readonly number[]): number {
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
	return Math.sqrt(Math.max(0, variance));
}

/**
 * Pure. Cases at which a paired 95% interval over this noise would be ±10 pp.
 * Null when fewer than three tasks measured it.
 */
export function examCasesForTenPoints(deltas: readonly number[]): number | null {
	if (deltas.length < MIN_TASKS_FOR_SPREAD || deltas.some((delta) => !Number.isFinite(delta))) return null;
	return clampCases(Math.ceil(((Z_95 * standardDeviation(deltas)) / EXAM_TARGET_HALF_WIDTH) ** 2));
}

/**
 * Pure. The same number from a measured interval instead of the deltas
 * themselves. A recorded A/A run keeps its bootstrap half-width and its task
 * count and never its rows, and `halfWidth = 1.96·sd/√tasks` inverts to the
 * identical n — so both entry points always name the same exam size.
 */
export function examCasesForMeasuredBand(halfWidth: number, tasks: number): number | null {
	if (tasks < MIN_TASKS_FOR_SPREAD || !Number.isFinite(halfWidth) || halfWidth <= 0) return null;
	return clampCases(Math.ceil(tasks * (halfWidth / EXAM_TARGET_HALF_WIDTH) ** 2));
}
