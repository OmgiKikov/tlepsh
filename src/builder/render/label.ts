/**
 * The judge calibration exercise, on screen.
 *
 * Three panels and nothing else: the subject the judge was given, the reveal
 * after the operator has committed, and the arithmetic at the end. The subject
 * panel is a projection of `judgeSubjectFor` and of nothing else — no verdict,
 * no reason, no score — because a human who has seen what the judge said is no
 * longer an independent second opinion, and the number the exercise produces
 * would be about agreement with a hint.
 */

import { language, t } from "../../i18n.js";
import type { JudgeAgreementStats } from "../../domain/judge-agreement.js";
import type {
	JudgeLabelSubject,
	LabelAssertionAnswer,
} from "../../application/judge-labels.js";
import { oneLine, percent, section, wrap } from "./format.js";
import type { Paint } from "./paint.js";

/** One field of the judge's own subject: its name, then its text, indented. */
function field(title: string, body: string, paint: Paint): string[] {
	return ["", paint.dim(title), ...wrap(body, 92, "  ")];
}

/** `AHDE · Судья 7/20` — the same title on the subject and on its reveal. */
export function labelPanelTitle(ordinal: number, total: number): string {
	return t("panel.title", { detail: t("label.panel", { ordinal, total }) });
}

export function labelDonePanelTitle(): string {
	return t("panel.title", { detail: t("label.done") });
}

/**
 * Exactly what the judge was shown, in the judge's own order. A legacy subject
 * says so in one line instead of quietly rendering a smaller object.
 */
export function renderLabelSubject(subject: JudgeLabelSubject, paint: Paint): string[] {
	// A row keyed by `task_007` tells the operator nothing about which of twenty
	// questions they are looking at. The case's own first line does, so it leads
	// and the ids stay behind it, dimmed.
	const headline = subject.input
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	const identity = paint.dim(`${oneLine(subject.taskId, 40)} · ${oneLine(subject.graderName, 40)}`);
	const lines = [headline
		? `${paint.bold(oneLine(headline, 72))} ${paint.dim("·")} ${identity}`
		: identity];
	if (subject.subject === "legacy") lines.push(paint.warning(t("label.legacy")));
	lines.push(...field(
		t(subject.kind === "dialogue" ? "label.field.goal" : "label.field.request"),
		subject.input || "—",
		paint,
	));
	lines.push(...field(
		t(subject.kind === "dialogue" ? "label.field.conversation" : "label.field.answer"),
		subject.answer || "—",
		paint,
	));
	if (subject.reference !== null) lines.push(...field(t("label.field.reference"), subject.reference, paint));
	if (subject.rubric !== null) lines.push(...field(t("label.field.rubric"), subject.rubric, paint));
	if (subject.assertions) {
		lines.push("", paint.dim(t("label.field.assertions")));
		for (const [index, assertion] of subject.assertions.entries()) {
			lines.push(`  ${index + 1}. ${oneLine(assertion, 160)}`);
		}
	}
	return lines;
}

const ANSWER_KEY = {
	yes: "label.choice.yes",
	no: "label.choice.no",
	unknown: "label.choice.unknown",
} as const;

/**
 * What the judge decided, after the operator has already decided. Dim, because
 * it is the answer to a question that is now closed.
 */
export function renderLabelReveal(
	subject: JudgeLabelSubject,
	human: "pass" | "fail" | "skip",
	assertions: readonly LabelAssertionAnswer[] | undefined,
	paint: Paint,
): string[] {
	const verdict = t(subject.judge === "pass" ? "label.choice.good" : "label.choice.bad");
	const agreement = human === "skip"
		? t("label.choice.skip")
		: t(human === subject.judge ? "label.reveal-agrees" : "label.reveal-disagrees");
	const headline = t("label.reveal", { verdict, agreement });
	const lines = [human === subject.judge || human === "skip" ? paint.dim(headline) : paint.warning(headline)];
	// A checklist disagreement is about one assertion, not about the whole
	// answer; saying which one is the difference between a number and a lesson.
	if (assertions && subject.judgeAssertions) {
		for (const [index, mine] of assertions.entries()) {
			const theirs = subject.judgeAssertions[index];
			if (theirs === undefined || theirs === mine) continue;
			lines.push(paint.dim(`  ${t("label.reveal-assertion", {
				index: index + 1,
				human: t(ANSWER_KEY[mine]),
				judge: t(ANSWER_KEY[theirs]),
			})}`));
		}
	}
	if (subject.judgeReason) lines.push(...wrap(subject.judgeReason, 92, "  ").map(paint.muted));
	return lines;
}

/** `2` → `двух`: the sentence says “one answer in six”, not “in 6”. */
const RU_DENOMINATOR = ["", "", "двух", "трёх", "четырёх", "пяти", "шести", "семи", "восьми", "девяти", "десяти"] as const;

function denominator(value: number): string {
	if (language() !== "ru") return String(value);
	return RU_DENOMINATOR[value] ?? String(value);
}

/**
 * The one sentence the numbers are for. Derived from the 2×2 table alone: how
 * often the judge is wrong, and which way it leans. A judge that waves failures
 * through and a judge that invents them are different problems with the same
 * agreement rate.
 */
export function judgeMeaning(stats: JudgeAgreementStats): string {
	const errors = stats.falsePass + stats.falseFail;
	if (errors === 0 || stats.nChecks === 0) return t("label.perfect");
	const direction = stats.falsePass > stats.falseFail
		? t("label.meaning-misses-failures")
		: stats.falseFail > stats.falsePass
			? t("label.meaning-invents-failures")
			: t("label.meaning-both");
	return t("label.meaning", { ratio: denominator(Math.max(2, Math.round(stats.nChecks / errors))), direction });
}

/**
 * What the exercise's own next step is. This is guidance on a screen, never a
 * gate: a Target that demands calibration before a promotion says so in its own
 * manifest, and that policy is enforced somewhere else entirely.
 */
export const LABEL_CALIBRATION_FLOOR = { minLabels: 20, minAgreement: 0.8 } as const;

export function judgeNextStep(stats: JudgeAgreementStats): string {
	if (stats.n >= LABEL_CALIBRATION_FLOOR.minLabels && stats.agreement >= LABEL_CALIBRATION_FLOOR.minAgreement) {
		return t("label.next-enough");
	}
	return t("label.next-more", { count: Math.max(10, LABEL_CALIBRATION_FLOOR.minLabels - stats.n) });
}

/** `согласие 84% · κ 0.62 · n=20`, from the one function that computes it. */
export function judgeAgreementSummary(stats: JudgeAgreementStats): string {
	return t("label.summary", {
		rate: percent(stats.agreement),
		kappa: stats.kappa === null ? "n/a" : stats.kappa.toFixed(2),
		n: stats.n,
	});
}

export interface LabelSummary {
	pooled: JudgeAgreementStats;
	/** Per grader spec, sorted by hash; rendered only when there is more than one. */
	byGrader: readonly { graderSpecHash: string; graderNames: readonly string[]; stats: JudgeAgreementStats }[];
}

/** The end panel: the number, what it means, the split, and the next step. */
export function renderLabelSummary(summary: LabelSummary, paint: Paint): string[] {
	const lines = [
		`${section(judgeAgreementSummary(summary.pooled), paint)}`,
		...wrap(judgeMeaning(summary.pooled), 92),
	];
	if (summary.byGrader.length > 1) {
		lines.push("", paint.dim(t("label.by-grader")));
		for (const entry of summary.byGrader) {
			const name = entry.graderNames.length > 0 ? entry.graderNames.join(", ") : entry.graderSpecHash;
			lines.push(`  ${oneLine(name, 48).padEnd(48)} ${judgeAgreementSummary(entry.stats)}`);
		}
	}
	// The next step is a whole sentence in the operator's own voice, so it gets
	// its own line rather than a `Next:` label it would read badly after.
	lines.push("", paint.dim(judgeNextStep(summary.pooled)));
	return lines;
}
