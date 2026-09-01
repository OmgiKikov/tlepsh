import type { ProposalPrediction } from "../builders/adapters.js";
import type { CandidateRecord } from "../domain/candidate.js";
import { loadBuilderProposalRunEnvelope } from "./builder-proposal.js";

/**
 * Predicted impact: the number a change is judged against.
 *
 * A proposal already carries evidence, an inferred cause, a targeted fix,
 * risks and a validation plan. What it never carried is the promise —
 * "mode X fails 26 of 26 tasks; after this it should fail at most 3, and the
 * basket should move about +40 points". This module is the read side of that
 * promise: how one prediction scores against the evidence that came back, and
 * how a Builder's whole track record scores across the candidates a human
 * already decided.
 *
 * Three rules keep it honest:
 *
 *  - The prediction is authored once, at submission, and hashed into the
 *    proposal the operator approves. Nothing here writes one, and nothing may
 *    invent one for a proposal that stated none.
 *  - A miss is a row. Calibration drawn only from the attempts that landed is
 *    a sales deck, exactly as a growth curve drawn only from promotions is.
 *  - Comparison happens on the quantity that was promised. A score prediction
 *    is read against the mean paired score delta and its bootstrap interval —
 *    the number the gate decides on; a pass-rate prediction, which has no
 *    interval anywhere in this system, is read as a point.
 */

/** Verdict on one promise: kept, missed, or never made. */
export type PredictionVerdict = "hit" | "miss" | "unpredicted";

/** Glyphs the strip and every rendered row share. */
export const PREDICTION_GLYPH: Record<PredictionVerdict, string> = {
	hit: "✓",
	miss: "✗",
	unpredicted: "~",
};

/** Scored attempts one calibration strip shows; older ones are counted only. */
export const MAX_CALIBRATION_STRIP = 5;

/**
 * What actually came back, in percentage points. Callers convert from whatever
 * carries it — the gate projection, an agent-log surface, a passport — so this
 * module never re-reads an artifact to answer a display question.
 */
export interface PredictionMeasurement {
	/** Mean paired grader-score delta, in pp. Null for pre-v4 evidence. */
	scoreDeltaPp: number | null;
	/** The bootstrap 95% interval around that delta, in pp. */
	confidence95Pp: { low: number; high: number } | null;
	/** Pass-rate delta, in pp. */
	passRateDeltaPp: number | null;
}

/** A `[0,1]` fraction as percentage points, rounded to a tenth. */
export function toPoints(fraction: number): number {
	return Math.round(fraction * 1000) / 10;
}

/**
 * The measured side of a comparison surface, whatever carries it: every gate
 * projection, agent-log surface and passport row spells the same three fields
 * as `[0,1]` fractions.
 */
export function measurementOf(
	surface: {
		scoreDelta?: number | null;
		confidence95?: { low: number; high: number } | null;
		/** Pass-rate delta, where the surface distinguishes it from the score. */
		delta?: number | null;
		baselinePassRate?: number | null;
		candidatePassRate?: number | null;
		// Accepted and deliberately ignored: a surface that knows only mean grader
		// scores knows no pass rate, and a score difference must never be printed
		// as one.
		baselineScore?: number | null;
		candidateScore?: number | null;
	} | null | undefined,
): PredictionMeasurement | null {
	if (!surface) return null;
	const passRate = typeof surface.delta === "number"
		? surface.delta
		: typeof surface.baselinePassRate === "number" && typeof surface.candidatePassRate === "number"
			? surface.candidatePassRate - surface.baselinePassRate
			: null;
	return {
		scoreDeltaPp: typeof surface.scoreDelta === "number" ? toPoints(surface.scoreDelta) : null,
		confidence95Pp: surface.confidence95
			? { low: toPoints(surface.confidence95.low), high: toPoints(surface.confidence95.high) }
			: null,
		passRateDeltaPp: passRate === null ? null : toPoints(passRate),
	};
}

// ---------------------------------------------------------------------------
// Authoring-time validation.

export interface PredictionScopeInput {
	/** The failure modes this proposal targets, already verified against the brief. */
	failureModeIds: readonly string[];
	/** A construction proposal cites no evaluation, so it can name no mode. */
	basis: "construction" | "improvement";
}

/**
 * Refuse a prediction that promises something the proposal is not aiming at.
 *
 * The submitted `failureModeIds` are the ones the host already resolved
 * against the source improvement brief, so requiring the predicted ids to be a
 * subset of them is exactly "every predicted mode is in the source brief", and
 * additionally that it is one this proposal actually targets.
 */
export function assertPredictionScope(
	prediction: { modes: readonly { failureModeId: string }[] } | null | undefined,
	input: PredictionScopeInput,
): void {
	if (!prediction) return;
	if (input.basis === "construction") {
		if (prediction.modes.length > 0) {
			throw new Error(
				"a construction proposal has no measured failure mode to predict; state only the expected delta",
			);
		}
		return;
	}
	const targeted = new Set(input.failureModeIds);
	for (const mode of prediction.modes) {
		if (!targeted.has(mode.failureModeId)) {
			throw new Error(
				`prediction names ${mode.failureModeId}, which is not among the failure modes this proposal targets`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Scoring one prediction against what came back.

export interface PredictedModeOutcome {
	failureModeId: string;
	/** Null when the mode was targeted but nothing was promised for it. */
	expectedFailingTasks: number | null;
	ofTasks: number;
	actualFailingTasks: number;
	verdict: PredictionVerdict;
}

export interface PredictedOverallOutcome {
	/** Which quantity was promised, and therefore which one is compared. */
	kind: "score" | "pass-rate";
	predictedPp: number;
	/** Null when no comparable evidence exists yet. */
	actualPp: number | null;
	confidence95Pp: { low: number; high: number } | null;
	verdict: PredictionVerdict;
	/** `|actual − predicted|` in pp; null when nothing was measured. */
	errorPp: number | null;
}

export interface PredictionOutcome {
	modes: PredictedModeOutcome[];
	overall: PredictedOverallOutcome | null;
}

/** One targeted mode as the impact projection measured it. */
export interface MeasuredMode {
	failureModeId: string;
	candidateAffectedTasks: number;
	sourceAffectedTasks: number;
}

/**
 * Per targeted mode: kept when the candidate still fails at most the promised
 * number of tasks, missed when it fails more, and `unpredicted` when this mode
 * carried no promise at all — silence is not a win.
 */
export function scorePredictedModes(
	prediction: ProposalPrediction | null | undefined,
	measured: readonly MeasuredMode[],
): PredictedModeOutcome[] {
	const promised = new Map((prediction?.modes ?? []).map((mode) => [mode.failureModeId, mode]));
	return measured.map((mode) => {
		const expected = promised.get(mode.failureModeId) ?? null;
		return {
			failureModeId: mode.failureModeId,
			expectedFailingTasks: expected ? expected.expectedFailingTasks : null,
			ofTasks: mode.sourceAffectedTasks,
			actualFailingTasks: mode.candidateAffectedTasks,
			verdict: expected === null
				? "unpredicted"
				: mode.candidateAffectedTasks <= expected.expectedFailingTasks ? "hit" : "miss",
		};
	});
}

/**
 * The whole-basket promise against the whole-basket result.
 *
 * With an interval the rule is one comparison: the prediction is kept while it
 * sits at or below the top of the interval — either it lies inside, or the
 * candidate beat it outright — and missed when the interval lies entirely
 * below it. Without an interval the two points are compared directly.
 */
export function scorePredictedOverall(
	prediction: ProposalPrediction | null | undefined,
	measurement: PredictionMeasurement | null | undefined,
): PredictedOverallOutcome | null {
	if (!prediction) return null;
	const kind: "score" | "pass-rate" | null = prediction.expectedScoreDeltaPp !== null
		? "score"
		: prediction.expectedPassRateDeltaPp !== null ? "pass-rate" : null;
	if (kind === null) return null;
	const predictedPp = (kind === "score" ? prediction.expectedScoreDeltaPp : prediction.expectedPassRateDeltaPp)!;
	const actualPp = !measurement
		? null
		: kind === "score" ? measurement.scoreDeltaPp : measurement.passRateDeltaPp;
	const confidence95Pp = kind === "score" ? measurement?.confidence95Pp ?? null : null;
	const verdict: PredictionVerdict = actualPp === null
		? "unpredicted"
		: confidence95Pp
			? (predictedPp <= confidence95Pp.high ? "hit" : "miss")
			: (actualPp >= predictedPp ? "hit" : "miss");
	return {
		kind,
		predictedPp,
		actualPp,
		confidence95Pp,
		verdict,
		errorPp: actualPp === null ? null : Math.round(Math.abs(actualPp - predictedPp) * 10) / 10,
	};
}

/** Both halves at once, for a screen that shows the modes and the total. */
export function scorePrediction(
	prediction: ProposalPrediction | null | undefined,
	input: { measured?: readonly MeasuredMode[]; measurement?: PredictionMeasurement | null },
): PredictionOutcome {
	return {
		modes: scorePredictedModes(prediction, input.measured ?? []),
		overall: scorePredictedOverall(prediction, input.measurement ?? null),
	};
}

// ---------------------------------------------------------------------------
// Calibration: how well this Builder predicts, over decided candidates.

/** One decided candidate, with whatever its proposal promised. */
export interface PredictionCalibrationEntry {
	candidateId: string;
	/** When the human decided. Ordering is derived from this, never from the caller. */
	at: string;
	prediction: ProposalPrediction | null;
	measurement: PredictionMeasurement | null;
}

export interface PredictionCalibration {
	/** Decided attempts whose promise could be scored against real evidence. */
	scored: number;
	hits: number;
	/** Mean `|actual − predicted|` over the scored attempts, in pp. */
	meanAbsoluteErrorPp: number | null;
	/** The newest {@link MAX_CALIBRATION_STRIP} scored verdicts, oldest first. */
	strip: PredictionVerdict[];
	/** Decided attempts that promised nothing, or whose promise has no evidence yet. */
	unpredicted: number;
}

/**
 * How often this Builder's promise survived contact with the evidence.
 *
 * Only decided candidates count — a promise nobody has measured yet is not a
 * miss — and the entries are ordered here, by the decision timestamp, so the
 * strip reads left to right in time no matter how the caller collected them.
 */
export function compilePredictionCalibration(
	entries: readonly PredictionCalibrationEntry[],
): PredictionCalibration {
	const ordered = [...entries].sort((left, right) =>
		left.at < right.at ? -1 : left.at > right.at ? 1 : left.candidateId < right.candidateId ? -1 : 1
	);
	const verdicts: PredictionVerdict[] = [];
	const errors: number[] = [];
	let unpredicted = 0;
	for (const entry of ordered) {
		const overall = scorePredictedOverall(entry.prediction, entry.measurement);
		if (!overall || overall.verdict === "unpredicted") {
			unpredicted += 1;
			continue;
		}
		verdicts.push(overall.verdict);
		if (overall.errorPp !== null) errors.push(overall.errorPp);
	}
	const meanAbsoluteErrorPp = errors.length === 0
		? null
		: Math.round((errors.reduce((total, value) => total + value, 0) / errors.length) * 10) / 10;
	return {
		scored: verdicts.length,
		hits: verdicts.filter((verdict) => verdict === "hit").length,
		meanAbsoluteErrorPp,
		strip: verdicts.slice(Math.max(0, verdicts.length - MAX_CALIBRATION_STRIP)),
		unpredicted,
	};
}

/** `✓✓✗✓✓`, oldest on the left. Empty when nothing has been scored. */
export function calibrationStrip(calibration: PredictionCalibration): string {
	return calibration.strip.map((verdict) => PREDICTION_GLYPH[verdict]).join("");
}

/**
 * `aimed +40.0pp, got +50.0pp` — the fragment the proposer reads back in its
 * own history, so cycle five knows how cycle two's promise actually landed.
 */
export function predictedVersusActual(outcome: PredictedOverallOutcome | null): string | null {
	if (!outcome) return null;
	const aimed = `aimed ${formatPoints(outcome.predictedPp)}`;
	return outcome.actualPp === null ? aimed : `${aimed}, got ${formatPoints(outcome.actualPp)}`;
}

/** `+40.0pp` / `-2.0pp`. Digits never bend; this is the machine-readable form. */
export function formatPoints(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}pp`;
}

/**
 * The promise the proposal this candidate was applied from carried.
 *
 * Read leniently, exactly as experiment history reads its own siblings: a
 * pruned or unreadable Builder run narrows one row of the record instead of
 * failing the page. A manual candidate promised nothing and reads as null.
 */
export function readCandidatePrediction(
	runsRoot: string,
	record: CandidateRecord,
): ProposalPrediction | null {
	if (record.origin.kind !== "applied-builder") return null;
	try {
		const run = loadBuilderProposalRunEnvelope(runsRoot, record.origin.builderRunId);
		return run.result.proposal?.prediction ?? null;
	} catch {
		return null;
	}
}
