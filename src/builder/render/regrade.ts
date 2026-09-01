import { formatEvaluatorSpend } from "../../evaluator-model.js";
import { plural, t } from "../../i18n.js";
import type {
	CandidateRegradeProjection,
	RegradeCaseFlip,
	RegradeDiff,
} from "../../application/regrade-decision.js";
import { joinNonEmpty, oneLine, percent, section } from "./format.js";
import type { Paint } from "./paint.js";

/**
 * The re-score on screen.
 *
 * An operator asked one question — “the judge is too strict” — and this panel
 * answers exactly it: what the pass rate was, what it is under the rubric they
 * just changed, which answers moved, and which grader moved them. Two facts
 * are load-bearing and appear whatever else is true:
 *
 *  - the Target was not called, and only the judge was paid, so the number is
 *    cheap on purpose rather than cheap by accident;
 *  - this is not a new baseline. A regrade is comparable only to evidence
 *    scored the same way, so measuring a candidate on the new rubric means
 *    re-scoring the baseline with the same set. That sentence is the last
 *    line, every time.
 */

/** Flipped answers named on screen; the result carries more. */
export const MAX_RENDERED_FLIPS = 8;

function outcomeMark(outcome: RegradeCaseFlip["from"], paint: Paint): string {
	if (outcome === "pass") return paint.success("✓");
	if (outcome === "fail") return paint.warning("✗");
	return paint.error("!");
}

/** `judge: assertion 2 now yes`, or the grader's own verdict when it has no assertions. */
function decidedBy(flip: RegradeCaseFlip, paint: Paint): string {
	if (!flip.grader) return "";
	const detail = flip.assertions.length > 0
		? flip.assertions
			.map((assertion) => t("regrade.assertion", {
				index: assertion.index,
				answer: t(assertion.to === "yes" ? "regrade.yes" : "regrade.no"),
			}))
			.join(", ")
		: t(flip.to === "pass" ? "regrade.grader-passes" : "regrade.grader-fails");
	return paint.dim(`${oneLine(flip.grader.type, 40)}: ${oneLine(detail, 120)}`);
}

export function renderRegradeFlip(flip: RegradeCaseFlip, paint: Paint): string {
	return joinNonEmpty([
		`${oneLine(flip.taskId, 60)}#${flip.repetitionIndex} ` +
			`${outcomeMark(flip.from, paint)}→${outcomeMark(flip.to, paint)}`,
		decidedBy(flip, paint),
	]);
}

/**
 * A candidate's whole comparison under the rubric the operator just rewrote,
 * on one line beside the recorded verdict.
 *
 * It never replaces that verdict: the candidate was decided by the graders in
 * force when its answers were scored, and this says what the same two arms
 * would look like now. The exam is named because it is the one thing a reader
 * might assume moved with them — it cannot: its graders are the judge's own.
 */
export function regradedDevelopmentLine(
	recorded: { baselinePassRate: number; candidatePassRate: number },
	revised: Pick<
		CandidateRegradeProjection,
		"baselinePassRate" | "candidatePassRate" | "nowPassing" | "nowFailing" | "unchanged"
	>,
	paint: Paint,
): string {
	const moved = `${paint.success("↑")}${revised.nowPassing} ${paint.warning("↓")}${revised.nowFailing} =${revised.unchanged}`;
	return `${paint.dim(t("label.regraded"))} ${t("candidate.regraded", {
		recorded: `${percent(recorded.baselinePassRate)} → ${percent(recorded.candidatePassRate)}`,
		revised: `${percent(revised.baselinePassRate)} → ${percent(revised.candidatePassRate)}`,
		moved,
	})} ${paint.dim(`· ${t("regrade.exam-untouched")}`)}`;
}

export function renderRegrade(diff: RegradeDiff, paint: Paint): string[] {
	const headline = joinNonEmpty([
		t("regrade.was-now", { before: percent(diff.passRateBefore), after: percent(diff.passRateAfter) }),
		plural(diff.cases, "case"),
		t("regrade.no-target"),
		t("receipt.judge", { cost: formatEvaluatorSpend(diff.judge.costUsd) }),
	]);
	const lines = [`${section(t("result.regraded"), paint)} ${headline}`];

	lines.push(joinNonEmpty([
		`${paint.success("↑")} ${paint.dim(t("regrade.now-passing"))}: ${paint.bold(String(diff.nowPassing))}`,
		`${paint.warning("↓")} ${paint.dim(t("regrade.now-failing"))}: ${paint.bold(String(diff.nowFailing))}`,
		`${paint.dim(`= ${t("regrade.unchanged")}`)}: ${diff.unchanged}`,
		paint.dim(`${t("regrade.score")} ${diff.meanScoreBefore.toFixed(2)} → ${diff.meanScoreAfter.toFixed(2)}`),
	]));

	// A candidate's arms were re-scored together, so the thing the operator
	// actually asked — what the comparison says now — is spelled out before the
	// per-answer detail of the arm they were arguing about.
	const baseline = diff.pairedBaseline;
	if (baseline) {
		lines.push(regradedDevelopmentLine(
			{ baselinePassRate: baseline.passRateBefore, candidatePassRate: diff.passRateBefore },
			{
				baselinePassRate: baseline.passRateAfter,
				candidatePassRate: diff.passRateAfter,
				nowPassing: baseline.nowPassing + diff.nowPassing,
				nowFailing: baseline.nowFailing + diff.nowFailing,
				unchanged: baseline.unchanged + diff.unchanged,
			},
			paint,
		));
	}

	if (diff.changedGraderCount > 0) {
		lines.push(paint.dim(t("regrade.rubrics", { count: diff.changedGraderCount })));
	}

	if (diff.sealed) {
		lines.push(paint.muted(t("regrade.sealed")));
	} else if (diff.flips.length === 0) {
		lines.push(paint.muted(t("regrade.no-change")));
	} else {
		for (const flip of diff.flips.slice(0, MAX_RENDERED_FLIPS)) {
			lines.push(`  ${renderRegradeFlip(flip, paint)}`);
		}
		const hidden = diff.nowPassing + diff.nowFailing - Math.min(diff.flips.length, MAX_RENDERED_FLIPS);
		if (hidden > 0) lines.push(`  ${paint.dim(t("regrade.more", { count: hidden }))}`);
	}

	// The comparability rule, in the operator's words, on its own line. It is
	// the one thing a re-score can be misread as, so it is never abbreviated.
	lines.push(paint.muted(t("regrade.not-a-baseline")));
	return lines;
}

/** One-line headline for status bars and collapsed tool cards. */
export function regradeHeadline(diff: RegradeDiff): string {
	return `${percent(diff.passRateBefore)} → ${percent(diff.passRateAfter)} · ` +
		`↑${diff.nowPassing} ↓${diff.nowFailing} · ` +
		`no Target call · judge ${formatEvaluatorSpend(diff.judge.costUsd)}`;
}
