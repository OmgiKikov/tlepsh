import type { WorkbenchCalibrationProjection } from "../../workbench/types.js";
import { plural, t, verdictLabel } from "../../i18n.js";
import { percent, points, section } from "./format.js";
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
	const label = verdictLabel(calibration.verdict);
	const verdict = healthy ? paint.success(label) : paint.warning(label);
	return [
		`${section(t("calibration.title"), paint)} ${paint.dim("A/A")} ${verdict} ${paint.dim(t("calibration.revision", { sha: calibration.targetSha.slice(0, 10) }))}`,
		`${paint.dim(t("calibration.design"))} ${plural(calibration.taskCount, "case")} × ${plural(calibration.repetitions, "repetition")} ${paint.dim(t("calibration.same-revision"))} ${percent(calibration.aaPassRate)}`,
		`${paint.dim(t("calibration.spread"))} ${formatNoiseBand(calibration)} ${paint.dim(`(${t("unit.ci")} ${points(calibration.confidence95.low)} … ${points(calibration.confidence95.high)})`)} ${paint.dim(`· ${t("noise.flip")}`)} ${formatFlipRate(calibration)}`,
		`${paint.dim(t("calibration.recommended"))} ${paint.bold(plural(calibration.recommendedRepetitions, "repetition"))} ${paint.dim(t("calibration.per-run"))}`,
		healthy
			? paint.muted(t("calibration.healthy"))
			: paint.warning(t("calibration.unhealthy")),
	];
}
