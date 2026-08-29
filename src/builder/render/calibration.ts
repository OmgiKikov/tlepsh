import type { WorkbenchCalibrationProjection } from "../../workbench/types.js";
import { percent, pluralize, points, section } from "./format.js";
import type { Paint } from "./paint.js";

/** Half-width of the 95% interval in pass-rate points: the noise band. */
export function noiseBand(calibration: Pick<WorkbenchCalibrationProjection, "confidence95">): number {
	return (calibration.confidence95.high - calibration.confidence95.low) / 2;
}

export function formatNoiseBand(calibration: Pick<WorkbenchCalibrationProjection, "confidence95">): string {
	const band = noiseBand(calibration);
	return `±${(Number.isFinite(band) ? Math.abs(band) * 100 : 0).toFixed(1)}pp`;
}

export function formatFlipRate(calibration: Pick<WorkbenchCalibrationProjection, "flipRate">): string {
	return `${Math.round((Number.isFinite(calibration.flipRate) ? calibration.flipRate : 0) * 100)}%`;
}

/**
 * The calibration panel. An A/A run compares one revision with itself, so
 * `inconclusive` is the healthy verdict: anything else means the harness
 * disagrees with itself more than the interval allows.
 */
export function renderCalibration(calibration: WorkbenchCalibrationProjection, paint: Paint): string[] {
	const healthy = calibration.verdict === "inconclusive";
	const verdict = healthy ? paint.success("inconclusive") : paint.warning(calibration.verdict);
	return [
		`${section("Noise calibration", paint)} ${paint.dim("A/A")} ${verdict} ${paint.dim(`· revision ${calibration.targetSha.slice(0, 10)}`)}`,
		`${paint.dim("Design")} ${pluralize(calibration.taskCount, "case")} × ${pluralize(calibration.repetitions, "repetition")} ${paint.dim("· same revision on both arms · baseline")} ${percent(calibration.aaPassRate)}`,
		`${paint.dim("Spread")} ${formatNoiseBand(calibration)} ${paint.dim(`(95% CI ${points(calibration.confidence95.low)} … ${points(calibration.confidence95.high)})`)} ${paint.dim("· flip")} ${formatFlipRate(calibration)}`,
		`${paint.dim("Recommended")} ${paint.bold(pluralize(calibration.recommendedRepetitions, "repetition"))} ${paint.dim("per run to keep noise under 10 points")}`,
		healthy
			? paint.muted("A/A is measurement, never evidence: nothing is promoted by calibrating.")
			: paint.warning("The harness disagrees with itself; treat smaller deltas as noise until this settles."),
	];
}
