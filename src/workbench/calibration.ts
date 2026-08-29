import type { CandidateRecord } from "../domain/candidate.js";
import type { WorkbenchCalibrationProjection } from "./types.js";

/**
 * Calibration projection: what an A/A run of one exact Target revision says
 * about run-to-run noise.
 *
 * The A/A `CandidateRecord` is the calibration receipt; this module only
 * reads it. Nothing here gates anything — a calibration answers "how big does
 * a difference have to be before it means something", and the honest A/A
 * verdict is `inconclusive`.
 */

/**
 * Repetitions every human-initiated run defaults to. One sample cannot
 * separate a real change from the agent's own noise, and a sealed verdict
 * needs at least `SEALED_GATE_POLICY.minRepetitions`.
 */
export const DEFAULT_REPETITIONS = 3;

/** Two-sided 95% band we are willing to call noise, in pass-rate points. */
const NOISE_BUDGET = 0.1;
const MAX_RECOMMENDED_REPETITIONS = 5;
const Z_95 = 1.96;

/**
 * Smallest k ∈ 1..5 with `1.96·√(2·p·(1−p)/(k·n)) ≤ 0.10`, i.e. the cheapest
 * design whose paired standard error keeps the noise band inside ten points.
 * Returns the cap when even five repetitions are not enough.
 */
export function recommendedRepetitions(passRate: number, taskCount: number): number {
	for (let k = 1; k <= MAX_RECOMMENDED_REPETITIONS; k += 1) {
		const variance = (2 * passRate * (1 - passRate)) / (k * taskCount);
		if (Number.isFinite(variance) && Z_95 * Math.sqrt(Math.max(0, variance)) <= NOISE_BUDGET) return k;
	}
	return MAX_RECOMMENDED_REPETITIONS;
}

/**
 * Pure projection of one calibration record. Returns null unless the record
 * is an A/A experiment that reached `evaluated` with v3 development gate
 * evidence — legacy or unfinished records carry no verdict to show.
 */
export function calibrationProjection(record: CandidateRecord): WorkbenchCalibrationProjection | null {
	if (record.mode !== "aa-calibration") return null;
	const evaluated = record.events.find((event) => event.type === "evaluated");
	if (evaluated?.type !== "evaluated") return null;
	const evidence = evaluated.evaluation.development.comparison;
	if (!evidence || !("verdict" in evidence)) return null;
	const summary = evidence.summary;
	const taskCount = summary.taskCount;
	return {
		candidateId: record.candidateId,
		targetSha: record.baseline.sha,
		taskCount,
		repetitions: evidence.design.repetitions,
		aaPassRate: summary.baselinePassRate,
		delta: summary.delta,
		confidence95: { ...summary.confidence95 },
		flipRate: taskCount > 0 ? (summary.improved + summary.regressed) / taskCount : 0,
		recommendedRepetitions: recommendedRepetitions(summary.baselinePassRate, taskCount),
		verdict: evidence.verdict,
		at: evaluated.at,
	};
}
