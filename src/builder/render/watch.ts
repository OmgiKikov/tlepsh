import type { WatchTick } from "../../application/watch.js";
import { joinNonEmpty, oneLine } from "./format.js";
import type { Paint } from "./paint.js";

/** One-line renderings share the 110-column budget every AHDE panel uses. */
const LINE_WIDTH = 110;

function percent(value: number | null): string {
	return value === null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`;
}

/** `88.9% vs 90.0%` — this tick first, the tick it was compared with second. */
function scoreFragment(tick: WatchTick): string {
	return tick.previousScore === null
		? percent(tick.score)
		: `${percent(tick.score)} vs ${percent(tick.previousScore)}`;
}

function verdictFragment(tick: WatchTick): string {
	switch (tick.status) {
		case "healthy":
			return tick.verdict ?? "inconclusive";
		case "drift":
			return `${tick.verdict ?? "changed"} · drift`;
		case "no-baseline":
			return "no baseline";
		case "not-comparable":
			return "no comparable baseline";
	}
}

/**
 * How much of today's difference this revision produces against itself. With
 * no calibration the line says so and never implies the difference means
 * something.
 */
export function calibrationFragment(tick: WatchTick): string {
	if (!tick.calibration) return "noise not calibrated";
	return `flip ${Math.round(Math.max(0, tick.calibration.flipRate) * 100)}% (calibrated)`;
}

/** The one line a tick prints. */
export function renderWatchTick(tick: WatchTick, paint: Paint): string {
	const style = tick.status === "drift"
		? paint.warning
		: tick.status === "healthy"
			? paint.success
			: paint.dim;
	return oneLine(
		joinNonEmpty([
			`watch ${tick.at.slice(0, 16)}`,
			scoreFragment(tick),
			style(verdictFragment(tick)),
			calibrationFragment(tick),
			`$${tick.costUsd.toFixed(2)}`,
		]),
		LINE_WIDTH,
	);
}

/**
 * What a tick means, on the lines under it. An unchanged harness rules out an
 * AHDE code change; it does not pretend to distinguish provider, runtime,
 * external-tool and stochastic causes without further evidence.
 */
export function renderWatchTickDetail(tick: WatchTick, paint: Paint): string[] {
	const lines: string[] = [];
	if (tick.status === "drift") {
		lines.push(paint.warning(oneLine(
			`drift on unchanged revision ${tick.revision.slice(0, 10)}: ` +
				"behaviour changed below the harness boundary",
			LINE_WIDTH,
		)));
		lines.push(paint.dim(oneLine(
			"possible causes: provider/model rollout, stochastic variance, runtime, tool, or external-data change",
			LINE_WIDTH,
		)));
		if (tick.verdict === "improved") {
			lines.push(paint.warning("a gain here is drift, not a win: the harness that earned it did not change"));
		}
		lines.push(paint.dim(oneLine(
			`nothing was promoted, adopted, or written as a receipt; eval run ${tick.evalRunId} is the only new artifact`,
			LINE_WIDTH,
		)));
	}
	if (tick.note && tick.status !== "drift") {
		lines.push(paint.dim(oneLine(tick.note, LINE_WIDTH)));
	}
	if (!tick.calibration) {
		lines.push(paint.dim(oneLine(
			"run `ahde calibrate --target <dir>` once on this revision to know how big a difference has to be",
			LINE_WIDTH,
		)));
	}
	return lines;
}
