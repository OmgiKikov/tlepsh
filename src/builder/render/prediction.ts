import type { ProposalPrediction } from "../../builders/adapters.js";
import {
	PREDICTION_GLYPH,
	calibrationStrip,
	type PredictedModeOutcome,
	type PredictedOverallOutcome,
	type PredictionCalibration,
	type PredictionVerdict,
} from "../../application/prediction.js";
import { t } from "../../i18n.js";
import { oneLine } from "./format.js";
import type { Paint } from "./paint.js";

/**
 * The promise, and later the promise beside the result.
 *
 * The proposal screens show what the operator is approving — "mode X fails 26
 * of 26; after this at most 3, overall +40 points" — and every screen that
 * carries a verified candidate shows the same numbers against what actually
 * came back. A ✓ is not decoration: it is the one place this system admits
 * that a change did or did not do what it said it would.
 */

/** Percentage points, already in pp. `+40 п.п.` / `+40 pts`. */
export function pointsOf(value: number): string {
	if (!Number.isFinite(value)) return "—";
	const rounded = Math.round(value * 10) / 10;
	const digits = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
	return `${rounded > 0 ? "+" : ""}${digits} ${t("unit.points")}`;
}

/** The bare signed number an interval is drawn from, without its unit. */
function bare(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	const digits = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
	return `${rounded > 0 ? "+" : ""}${digits}`;
}

/** `failure-mode-1a2b…` shortened to something a human can match by eye. */
export function shortModeId(failureModeId: string): string {
	const body = failureModeId.startsWith("failure-mode-") ? failureModeId.slice("failure-mode-".length) : failureModeId;
	return body.length > 8 ? body.slice(0, 8) : body;
}

/**
 * Which quantity the promise was about. A pass-rate promise is compared to the
 * pass rate and a score promise to the score the gate decided on, so the line
 * that shows the two numbers has to say which one it is comparing.
 */
function metricOf(outcome: PredictedOverallOutcome): string {
	return t(outcome.kind === "score" ? "measurement.metric-score" : "measurement.metric-pass-rate");
}

function toneOf(verdict: PredictionVerdict, paint: Paint): (value: string) => string {
	return verdict === "hit" ? paint.success : verdict === "miss" ? paint.error : paint.muted;
}

/**
 * What the Builder promised, in one line, for the review panel and the apply
 * dialog: `Ожидаю mode «a1b2c3d4» 26/26 → ≤3/26 · итог +40 п.п.`
 *
 * `labels` lets a screen that knows a readable name for a mode use it; the
 * exact id is the fallback, never an invented title.
 */
export function predictionPromiseLine(
	prediction: ProposalPrediction | null | undefined,
	paint: Paint,
	labels: ReadonlyMap<string, string> = new Map(),
): string | null {
	if (!prediction) return null;
	const parts = prediction.modes.map((mode) => {
		// The words first, the id after them and muted: the operator matches the
		// forecast to the diagnosis by reading it, not by comparing hashes.
		const named = labels.get(mode.failureModeId);
		return t(named ? "prediction.mode-named" : "prediction.mode", {
			mode: oneLine(named ?? shortModeId(mode.failureModeId), 60),
			hash: paint.muted(shortModeId(mode.failureModeId)),
			from: mode.ofTasks,
			of: mode.ofTasks,
			to: mode.expectedFailingTasks,
		});
	});
	const delta = prediction.expectedScoreDeltaPp ?? prediction.expectedPassRateDeltaPp;
	if (delta !== null && delta !== undefined) parts.push(t("prediction.overall", { delta: pointsOf(delta) }));
	if (parts.length === 0) return null;
	return `${paint.dim(t("label.prediction"))} ${t("prediction.expect")} ${paint.bold(parts.join(paint.dim(" · ")))}`;
}

/** The Builder's own sentence for why a number was possible, or why it was not. */
export function predictionNoteLine(
	prediction: ProposalPrediction | null | undefined,
	paint: Paint,
): string | null {
	if (!prediction?.note) return null;
	return `  ${paint.muted(oneLine(prediction.note, 160))}`;
}

/** `Prediction  no prediction stated` — silence is stated, never implied. */
export function predictionAbsentLine(paint: Paint): string {
	return `${paint.dim(t("label.prediction"))} ${paint.muted(t("prediction.none"))}`;
}

/** `предсказано ≤3/26 · получено 1/26 ✓`, per targeted mode. */
export function predictedModeFragment(outcome: PredictedModeOutcome, paint: Paint): string {
	const tone = toneOf(outcome.verdict, paint);
	const body = outcome.expectedFailingTasks === null
		? t("prediction.mode-unpredicted", { actual: outcome.actualFailingTasks, of: outcome.ofTasks })
		: t("prediction.mode-outcome", {
			expected: outcome.expectedFailingTasks,
			actual: outcome.actualFailingTasks,
			of: outcome.ofTasks,
		});
	return `${body} ${tone(PREDICTION_GLYPH[outcome.verdict])}`;
}

/** `предсказано +40 п.п. · получено +50 п.п. (ДИ +35 … +64) ✓`. */
export function predictedOverallLine(
	outcome: PredictedOverallOutcome | null | undefined,
	paint: Paint,
): string | null {
	if (!outcome) return null;
	const tone = toneOf(outcome.verdict, paint);
	if (outcome.actualPp === null) {
		return `${paint.dim(t("label.prediction"))} ${
			t("prediction.overall-unmeasured", { predicted: pointsOf(outcome.predictedPp), metric: metricOf(outcome) })
		}`;
	}
	const interval = outcome.confidence95Pp
		? ` ${paint.dim(t("prediction.interval", {
			low: bare(outcome.confidence95Pp.low),
			high: bare(outcome.confidence95Pp.high),
		}))}`
		: "";
	return `${paint.dim(t("label.prediction"))} ${
		t("prediction.overall-outcome", {
			predicted: pointsOf(outcome.predictedPp),
			metric: metricOf(outcome),
			actual: pointsOf(outcome.actualPp),
		})
	}${interval} ${tone(PREDICTION_GLYPH[outcome.verdict])}`;
}

/**
 * `Builder предсказывает: попаданий 4/5 · ошибка ±8 п.п. · ✓✓✗✓✓` — the
 * footer under `/log` and the passport's provenance. A Builder that has never
 * promised anything says so instead of showing a perfect record of nothing.
 */
export function predictionCalibrationLine(calibration: PredictionCalibration, paint: Paint): string {
	if (calibration.scored === 0) return paint.muted(t("prediction.calibration-none"));
	const strip = calibrationStrip(calibration)
		.split("")
		.map((glyph) => glyph === PREDICTION_GLYPH.hit ? paint.success(glyph) : paint.error(glyph))
		.join("");
	return t("prediction.calibration", {
		hits: calibration.hits,
		total: calibration.scored,
		error: calibration.meanAbsoluteErrorPp === null ? "—" : `${calibration.meanAbsoluteErrorPp} ${t("unit.points")}`,
		strip,
	});
}

/** `Обещано +40 п.п. · получено +50 п.п.` — one line under the passport's Measured. */
export function passportPredictionLine(
	outcome: PredictedOverallOutcome | null | undefined,
	paint: Paint,
): string | null {
	if (!outcome) return null;
	const tone = toneOf(outcome.verdict, paint);
	if (outcome.actualPp === null) {
		return paint.muted(
			t("prediction.passport-unmeasured", { predicted: pointsOf(outcome.predictedPp), metric: metricOf(outcome) }),
		);
	}
	return `${t("prediction.passport", {
		predicted: pointsOf(outcome.predictedPp),
		metric: metricOf(outcome),
		actual: pointsOf(outcome.actualPp),
	})} ${tone(PREDICTION_GLYPH[outcome.verdict])}`;
}
