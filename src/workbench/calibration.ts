import type { CandidateRecord } from "../domain/candidate.js";
import { examCasesForMeasuredBand } from "../domain/power.js";
import { readEvalRunIndex } from "../eval.js";
import { canonicalJson } from "../provenance.js";
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

/** How a user model is named to a human: one string, provider and id. */
function modelName(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Whether the two development arms played the user with different models, and
 * which model the second one used.
 *
 * The answer comes from the evidence rather than from the caller's intent: the
 * eval-run indexes carry the model that actually played the user, so a record
 * that says "simulator noise" and two arms that ran the same simulator cannot
 * disagree here. An unreadable index says nothing — a projection is a reading
 * of a receipt, and losing the receipt must not invent a fact.
 */
function alternateSimulator(
	runsRoot: string,
	baselineEvalRunId: string,
	candidateEvalRunId: string,
	alternate: { provider: string; id: string } | null | undefined,
): { kind: "alternate"; model: string } | null {
	let baseline;
	let candidate;
	try {
		baseline = readEvalRunIndex(runsRoot, baselineEvalRunId).provenance.simulatedUser;
		candidate = readEvalRunIndex(runsRoot, candidateEvalRunId).provenance.simulatedUser;
	} catch {
		return null;
	}
	if (canonicalJson(baseline ?? null) === canonicalJson(candidate ?? null)) return null;
	// The recorded identity first, because that is the model that ran; the
	// manifest's alternate block only fills in for evidence too old to carry one.
	const model = candidate ?? alternate;
	return model ? { kind: "alternate", model: modelName(model) } : null;
}

/**
 * Pure projection of one calibration record. Returns null unless the record
 * is an A/A experiment that reached `evaluated` with development gate evidence
 * carrying a verdict (v3 or v4) — legacy v1/v2 or unfinished records have none
 * to show. Calibration measures noise and never promotes, so it reads any
 * verdict-bearing evidence rather than promotion-grade evidence only.
 *
 * With `runsRoot` it also reads what each arm measured with, which is how a
 * band that is simulator noise rather than harness noise says so. Without it
 * the projection is exactly what it always was.
 */
export function calibrationProjection(
	record: CandidateRecord,
	runsRoot?: string,
	/** The manifest's alternate user block, for naming a model the evidence does not. */
	alternate?: { provider: string; id: string } | null,
): WorkbenchCalibrationProjection | null {
	if (record.mode !== "aa-calibration") return null;
	const evaluated = record.events.find((event) => event.type === "evaluated");
	if (evaluated?.type !== "evaluated") return null;
	const development = evaluated.evaluation.development;
	const evidence = development.comparison;
	if (!evidence || !("verdict" in evidence)) return null;
	const summary = evidence.summary;
	const taskCount = summary.taskCount;
	const simulator = runsRoot
		? alternateSimulator(runsRoot, development.baseline.evalRunId, development.candidate.evalRunId, alternate)
		: null;
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
		// The same noise answers a second question the operator has no other way
		// to ask: how big an exam has to be before it can see a real difference.
		recommendedExamCases: examCasesForMeasuredBand(
			(summary.confidence95.high - summary.confidence95.low) / 2,
			taskCount,
		),
		verdict: evidence.verdict,
		// Absent rather than null when the arms shared one simulator, so a
		// projection of an ordinary A/A stays exactly the object it was.
		...(simulator ? { simulator } : {}),
		at: evaluated.at,
	};
}
