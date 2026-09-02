import {
	formatCostUsd,
	formatPercent,
	formatResolvedModes,
	sparkline,
	type AgentLog,
	type AgentLogRow,
	MAX_SPARKLINE_WIDTH,
} from "../../application/agent-log.js";
import { measurementLine, measurementSurface, smallBasketNote } from "../../application/measurement-line.js";
import { candidateStatusLabel, noun, plural, t, verdictLabel } from "../../i18n.js";
import { joinNonEmpty, oneLine, section } from "./format.js";
import { predictionCalibrationLine } from "./prediction.js";
import type { Paint } from "./paint.js";

/** One-line renderings share the 110-column budget every AHDE panel uses. */
const LINE_WIDTH = 110;
/**
 * The row headline carries the whole measurement sentence, and that sentence
 * is one string on every surface. A cut through the middle of an interval is
 * the exact defect this budget exists to prevent, so the headline gets its own.
 */
const HEADLINE_WIDTH = 160;
const INDENT = "        ";

/**
 * `improved · score 40% → 90% (+50 pts, 95% CI +35 … +64) on 30 cases × 3 ·
 * pass rate 33% → 83%` — the same sentence the verification panel, the
 * passport and the Builder's own copy carry, composed once.
 */
function developmentFragment(row: AgentLogRow): string {
	if (!row.development) return t("growth.not-evaluated");
	return measurementLine({ development: measurementSurface(row.development) }).numbers;
}

/** The sealed surface: its verdict and its size, and not one case of it. */
function sealedFragment(row: AgentLogRow): string | null {
	if (!row.sealed) return null;
	return t("growth.sealed", {
		verdict: verdictLabel(row.sealed.verdict),
		tasks: row.sealed.tasks,
		repetitions: row.sealed.repetitions,
	});
}

function headline(row: AgentLogRow): string {
	return oneLine(
		joinNonEmpty([
			row.outcome === "promoted" ? (row.tag ?? candidateStatusLabel("promoted")) : candidateStatusLabel("rejected"),
			row.at.slice(0, 10),
			developmentFragment(row),
			sealedFragment(row),
			row.costRatio === null ? null : `×${row.costRatio.toFixed(2)}`,
			formatCostUsd(row.costUsd),
		]),
		HEADLINE_WIDTH,
	);
}

function detailLines(row: AgentLogRow): string[] {
	const width = LINE_WIDTH - INDENT.length;
	const lines: string[] = [];
	// The interval and the design size moved up into the sentence; what is left
	// down here is what the sentence cannot say — which revisions, and why.
	lines.push(oneLine(`${row.baseline} → ${row.candidate ?? "—"}`, width));
	const smallBasket = row.development ? smallBasketNote(row.development.tasks) : null;
	if (smallBasket) lines.push(oneLine(smallBasket, width));
	if (row.resolvedModes.count > 0) {
		lines.push(oneLine(t("growth.resolved", { modes: formatResolvedModes(row.resolvedModes) }), width));
	}
	const tail = joinNonEmpty([
		row.reason ? `“${row.reason}”` : null,
		row.appliedByImprovementLoop ? t("candidate.applied-by-loop") : null,
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
	const cost = `${paint.dim(`${t("growth.cost")} `)} ${formatCostUsd(log.cumulativeCostUsd)} ${paint.dim(
		t("growth.cumulative", { attempts: plural(attempts, "attempt") }),
	)}`;
	if (scores.length === 0) return [cost];
	const shown = Math.min(scores.length, MAX_SPARKLINE_WIDTH);
	const first = scores[scores.length - shown] ?? 0;
	const last = scores[scores.length - 1] ?? 0;
	const dropped = scores.length - shown;
	return [
		`${paint.dim(t("growth.score"))} ${paint.bold(sparkline(scores))} ${paint.dim(
			t("growth.over-versions", {
				first: formatPercent(first),
				last: formatPercent(last),
				versions: plural(shown, "version"),
			}) + (dropped > 0 ? t("growth.earlier", { count: dropped }) : ""),
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
	const title = `${section(t("panel.growth"), paint)} ${paint.dim(
		joinNonEmpty([
			log.targetId,
			plural(promotions, "version"),
			plural(log.rows.length, "decided attempt"),
		]),
	)}`;
	if (log.rows.length === 0) {
		return [title, paint.muted(t("growth.empty"))];
	}
	const lines = [title, ""];
	for (const row of log.rows) {
		const style = row.outcome === "promoted" ? paint.bold : paint.dim;
		lines.push(style(headline(row)));
		for (const detail of detailLines(row)) lines.push(paint.dim(`${INDENT}${detail}`));
	}
	if (log.omitted > 0) {
		lines.push(paint.dim(t("growth.omitted", { count: log.omitted, attempts: noun(log.omitted, "decided attempt") })));
	}
	if (log.unreadable > 0) {
		lines.push(paint.dim(`${log.unreadable} candidate record(s) could not be read and are not shown`));
	}
	lines.push("", ...renderAgentLogChart(log, paint));
	// Under the growth curve: how well this Builder predicted its own results.
	lines.push(predictionCalibrationLine(log.calibration, paint));
	return lines;
}
