import type { WorkbenchCalibrationProjection } from "../../workbench/types.js";
import { plural, t, verdictLabel } from "../../i18n.js";
import { band, interval, percent, section } from "./format.js";
import type { Paint } from "./paint.js";

/** Half-width of the 95% interval in pass-rate points: the noise band. */
export function noiseBand(calibration: Pick<WorkbenchCalibrationProjection, "confidence95">): number {
	return (calibration.confidence95.high - calibration.confidence95.low) / 2;
}

export function formatNoiseBand(calibration: Pick<WorkbenchCalibrationProjection, "confidence95">): string {
	return band(noiseBand(calibration));
}

export function formatFlipRate(calibration: Pick<WorkbenchCalibrationProjection, "flipRate">): string {
	return percent(calibration.flipRate);
}

/**
 * The calibration panel. An A/A run compares one revision with itself, so
 * `inconclusive` is the healthy verdict: anything else means the harness
 * disagrees with itself more than the interval allows.
 */
export function renderCalibration(calibration: WorkbenchCalibrationProjection, paint: Paint): string[] {
	const healthy = calibration.verdict === "inconclusive";
	const label = verdictLabel(calibration.verdict);
	const verdict = healthy ? paint.success(label) : paint.warning(label);
	return [
		`${section(t("calibration.title"), paint)} ${paint.dim("A/A")} ${verdict} ${paint.dim(t("calibration.revision", { sha: calibration.targetSha.slice(0, 10) }))}`,
		`${paint.dim(t("calibration.design"))} ${plural(calibration.taskCount, "case")} × ${plural(calibration.repetitions, "repetition")} ${paint.dim(t("calibration.same-revision"))} ${percent(calibration.aaPassRate)}`,
		`${paint.dim(t("calibration.spread"))} ${formatNoiseBand(calibration)} ${paint.dim(`(${interval(calibration.confidence95.low, calibration.confidence95.high)})`)} ${paint.dim(`· ${t("noise.flip")}`)} ${formatFlipRate(calibration)}`,
		`${paint.dim(t("calibration.recommended"))} ${paint.bold(plural(calibration.recommendedRepetitions, "repetition"))} ${paint.dim(t("calibration.per-run"))}`,
		// The same measurement sizes the exam: an exam smaller than this cannot
		// separate a ten-point gain from this Target's own noise.
		...(calibration.recommendedExamCases === null
			? []
			: [`${paint.dim(t("calibration.exam-size"))} ${t("exam.size-for-noise", {
				cases: paint.bold(plural(calibration.recommendedExamCases, "case")),
			})}`]),
		healthy
			? paint.muted(t("calibration.healthy"))
			: paint.warning(t("calibration.unhealthy")),
	];
}
