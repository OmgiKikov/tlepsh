import {
	formatCostUsd,
	formatPercent,
	formatScoreDelta,
	formatResolvedModes,
	sparkline,
	type AgentLog,
	type AgentLogRow,
	MAX_SPARKLINE_WIDTH,
} from "../../application/agent-log.js";
import { joinNonEmpty, oneLine, section } from "./format.js";
import { predictionCalibrationLine } from "./prediction.js";
import type { Paint } from "./paint.js";

/** One-line renderings share the 110-column budget every AHDE panel uses. */
const LINE_WIDTH = 110;
const INDENT = "        ";

/** `improved · 40.0% → 90.0% (+50.0pp)`. The interval goes on its own line. */
function developmentFragment(row: AgentLogRow): string {
	const development = row.development;
	if (!development) return "not evaluated";
	const scores = development.baselineScore === null || development.candidateScore === null
		? null
		: `${formatPercent(development.baselineScore)} → ${formatPercent(development.candidateScore)}`;
	return joinNonEmpty([
		development.verdict,
		joinNonEmpty([
			scores,
			development.scoreDelta === null ? null : `(${formatScoreDelta(development.scoreDelta)})`,
		], " "),
	]);
}

/** The sealed surface: its verdict and its size, and not one case of it. */
function sealedFragment(row: AgentLogRow): string | null {
	if (!row.sealed) return null;
	return `sealed ${row.sealed.verdict} on ${row.sealed.tasks}×${row.sealed.repetitions}`;
}

function headline(row: AgentLogRow): string {
	return oneLine(
		joinNonEmpty([
			row.outcome === "promoted" ? (row.tag ?? "promoted") : "rejected",
			row.at.slice(0, 10),
			developmentFragment(row),
			sealedFragment(row),
			row.costRatio === null ? null : `×${row.costRatio.toFixed(2)}`,
			formatCostUsd(row.costUsd),
		]),
		LINE_WIDTH,
	);
}

function detailLines(row: AgentLogRow): string[] {
	const width = LINE_WIDTH - INDENT.length;
	const lines: string[] = [];
	const interval = row.development?.confidence95;
	lines.push(oneLine(
		joinNonEmpty([
			`${row.baseline} → ${row.candidate ?? "—"}`,
			interval ? `95% CI ${formatScoreDelta(interval.low)} … ${formatScoreDelta(interval.high)}` : null,
			row.development && row.development.tasks > 0
				? `${row.development.tasks}×${row.development.repetitions}`
				: null,
		]),
		width,
	));
	if (row.resolvedModes.count > 0) {
		lines.push(oneLine(`resolved ${formatResolvedModes(row.resolvedModes)}`, width));
	}
	const tail = joinNonEmpty([
		row.reason ? `“${row.reason}”` : null,
		row.appliedByImprovementLoop ? "applied by the improvement loop" : null,
	]);
	if (tail) lines.push(oneLine(tail, width));
	return lines;
}

/**
 * The growth chart under the rows: development score per version, oldest on
 * the left, and what the whole projection cost. Bounded to
 * {@link MAX_SPARKLINE_WIDTH} columns; older versions fall off the left edge
 * and are counted, never silently dropped.
 */
export function renderAgentLogChart(log: AgentLog, paint: Paint): string[] {
	const scores = log.versions.map((version) => version.score);
	const attempts = log.rows.length;
	const cost = `${paint.dim("cost ")} ${formatCostUsd(log.cumulativeCostUsd)} ${paint.dim(
		`cumulative over ${attempts} attempt${attempts === 1 ? "" : "s"}`,
	)}`;
	if (scores.length === 0) return [cost];
	const shown = Math.min(scores.length, MAX_SPARKLINE_WIDTH);
	const first = scores[scores.length - shown] ?? 0;
	const last = scores[scores.length - 1] ?? 0;
	const dropped = scores.length - shown;
	return [
		`${paint.dim("score")} ${paint.bold(sparkline(scores))} ${paint.dim(
			`${formatPercent(first)} → ${formatPercent(last)} over ${shown} version${shown === 1 ? "" : "s"}` +
				(dropped > 0 ? ` (+${dropped} earlier)` : ""),
		)}`,
		cost,
	];
}

/**
 * The whole log for a terminal: one block per decided attempt, newest first,
 * with rejections dimmed so the growth curve is read against what was tried
 * and did not land.
 */
export function renderAgentLog(log: AgentLog, paint: Paint): string[] {
	const promotions = log.rows.filter((row) => row.outcome === "promoted").length;
	const title = `${section("Growth", paint)} ${paint.dim(
		joinNonEmpty([
			log.targetId,
			`${promotions} version${promotions === 1 ? "" : "s"}`,
			`${log.rows.length} decided attempt${log.rows.length === 1 ? "" : "s"}`,
		]),
	)}`;
	if (log.rows.length === 0) {
		return [title, paint.muted("Nothing has been promoted or rejected on this Target yet.")];
	}
	const lines = [title, ""];
	for (const row of log.rows) {
		const style = row.outcome === "promoted" ? paint.bold : paint.dim;
		lines.push(style(headline(row)));
		for (const detail of detailLines(row)) lines.push(paint.dim(`${INDENT}${detail}`));
	}
	if (log.omitted > 0) {
		lines.push(paint.dim(`… and ${log.omitted} earlier decided attempt${log.omitted === 1 ? "" : "s"}`));
	}
	if (log.unreadable > 0) {
		lines.push(paint.dim(`${log.unreadable} candidate record(s) could not be read and are not shown`));
	}
	lines.push("", ...renderAgentLogChart(log, paint));
	// Under the growth curve: how well this Builder predicted its own results.
	lines.push(predictionCalibrationLine(log.calibration, paint));
	return lines;
}
