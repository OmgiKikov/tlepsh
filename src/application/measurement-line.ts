import { sealedOutcomeLabel, type ExclusionReason, type SealedOutcome } from "../domain/comparison-gate.js";
import type { SealedExamOrigin } from "./sealed-synth.js";
import { interval, percent, points } from "../measurement.js";
import { plural, t, verdictLabel } from "../i18n.js";

/**
 * The one sentence every surface prints about a verification.
 *
 * The panel used to lead with the pass-rate delta while the interval printed
 * beside it was over the mean grader score; `/log` showed the score delta; the
 * passport printed both with a single pair of brackets between them. Three
 * screens, two metrics, and a Builder left to work out which number it had
 * been shown — which it did, wrongly, twice in live sessions.
 *
 * So the sentence is composed once, here, and the renderers print what this
 * returns. The primary metric is the mean grader score, because that is the
 * paired quantity `judgeComparison` bootstraps and the quantity its interval
 * brackets (invariant 34). The pass rate stays on the line, named, behind it.
 * Legacy (v1–v3) evidence recorded no score at all; there the line names the
 * pass rate as the metric instead of printing a score it does not have.
 *
 * Pure: it reads no artifact and paints nothing. A caller that wants colour
 * paints the parts, never a second sentence.
 */

/** Below this many included cases an interval is indicative, not decisive. */
export const SMALL_BASKET_CASES = 10;

/**
 * A separator with nothing left to put after it. The sentence is a ` · `-joined
 * list, so an empty part — or a cut made downstream by a renderer with a width
 * to respect — used to leave the dot hanging at the end of the line.
 */
const DANGLING_SEPARATOR = /[\s·,;:—–-]+$/u;

/** Drop a separator left dangling at the end of a joined sentence. */
export function trimSeparator(text: string): string {
	return text.replace(DANGLING_SEPARATOR, "");
}

// The numbers themselves live in `measurement.ts`: one percent, one point, one
// interval, one κ, one dollar, for the twenty-odd surfaces that print them.
// This file composes the sentence they go into, and re-exports them so the
// composer and its renderers cannot read two different modules.
export { bareDelta, interval, percent, points } from "../measurement.js";

/** One comparison surface, normalized. Every field is a `[0,1]` fraction. */
export interface MeasurementSurface {
	/** Gate verdict token, or null for evidence that recorded none. */
	verdict: string | null;
	baselineScore: number | null;
	candidateScore: number | null;
	/** Mean paired score delta — the quantity the interval brackets. */
	scoreDelta: number | null;
	confidence95: { low: number; high: number } | null;
	baselinePassRate: number | null;
	candidatePassRate: number | null;
	tasks: number;
	repetitions: number;
	/** Cases the paired statistics left out. `0` for a whole basket. */
	excludedTasks: number;
	/** Why they were left out, when the projection knows; infrastructure otherwise. */
	excludedReason: ExclusionSummaryReason;
}

/**
 * Why cases are missing from a measurement, as one word for the operator.
 *
 * `infrastructure` is the default because it is what the error budget spends:
 * a repetition that never produced a record is the engine's failure, not the
 * agent's. `incomplete` is the narrower word for a task that ran but did not
 * deliver every repetition it was designed for.
 */
export type ExclusionSummaryReason = ExclusionReason | "mixed";

/** Collapse per-task exclusion reasons into the one word the line prints. */
export function exclusionReasonOf(
	excluded: readonly { reason: ExclusionReason }[],
): ExclusionSummaryReason {
	const reasons = new Set(excluded.map((task) => task.reason));
	if (reasons.size > 1) return "mixed";
	return reasons.has("incomplete") ? "incomplete" : "infrastructure";
}

function exclusionReasonLabel(reason: ExclusionSummaryReason): string {
	return t(
		reason === "incomplete"
			? "measurement.excluded-incomplete"
			: reason === "mixed" ? "measurement.excluded-mixed" : "measurement.excluded-infrastructure",
	);
}

/**
 * Whatever a caller holds — a gate projection, a stored comparison summary, a
 * passport row, an agent-log surface — spelled as the surface above. Callers
 * spread the two objects they have (`{ ...comparison, ...gate }`): the v4 gate
 * wins where both carry a field, which is what makes the interval the score's.
 */
export function measurementSurface(
	input: {
		verdict?: string | null;
		baselineScore?: number | null;
		candidateScore?: number | null;
		scoreDelta?: number | null;
		confidence95?: { low: number; high: number } | null;
		baselinePassRate?: number | null;
		candidatePassRate?: number | null;
		tasks?: number | null;
		taskCount?: number | null;
		repetitions?: number | null;
		excludedTasks?: number | null;
		excludedReason?: ExclusionSummaryReason | null;
	} | null | undefined,
): MeasurementSurface | null {
	if (!input) return null;
	const number = (value: number | null | undefined): number | null =>
		typeof value === "number" && Number.isFinite(value) ? value : null;
	return {
		excludedTasks: Math.max(0, number(input.excludedTasks) ?? 0),
		excludedReason: input.excludedReason ?? "infrastructure",
		verdict: typeof input.verdict === "string" ? input.verdict : null,
		baselineScore: number(input.baselineScore),
		candidateScore: number(input.candidateScore),
		scoreDelta: number(input.scoreDelta),
		confidence95: input.confidence95 ?? null,
		baselinePassRate: number(input.baselinePassRate),
		candidatePassRate: number(input.candidatePassRate),
		tasks: number(input.tasks) ?? number(input.taskCount) ?? 0,
		repetitions: number(input.repetitions) ?? 0,
	};
}

/** The sealed exam as the sentence may carry it: a verdict and a size. */
export interface ExamSurface {
	verdict: string;
	/** What a sealed `pass` showed, when the projection knows; folded into the verdict word. */
	outcome?: SealedOutcome | null;
	scoreDelta: number | null;
	confidence95: { low: number; high: number } | null;
	tasks: number;
	repetitions: number;
	/** Cases the exam lost to the error budget, and why. */
	excludedTasks?: number;
	excludedReason?: ExclusionSummaryReason;
	/**
	 * What the judge was asked for and what survived, for an exam generated
	 * here. Read off the sealed-synthesis receipt; absent for an exam the
	 * operator brought, and for evidence recorded before receipts existed.
	 */
	generation?: { requested: number; accepted: number; droppedDuplicate: number; droppedMalformed: number } | null;
	/**
	 * Who wrote the questions, off the sealed-synthesis receipt. `null` and
	 * `undefined` both mean the receipt says nothing, which is the ordinary
	 * shape of an exam the operator brought.
	 */
	origin?: SealedExamOrigin | null;
}

/**
 * Where the exam's questions came from, in the operator's words.
 *
 * `null` is a finding: the sealed-synthesis receipts were read and none of
 * them claims this corpus, so the exam is the operator's own. `undefined` is
 * the absence of a finding — a caller that never looked — and there the line
 * says nothing rather than crediting the operator with an exam the judge may
 * well have written.
 */
export function examOriginLabel(origin: SealedExamOrigin | null | undefined): string {
	if (origin === undefined) return "";
	if (origin === "judge-generated-kb" || origin === "judge-generated-kb-reviewed") return t("exam.origin-kb");
	if (origin === "judge-generated" || origin === "judge-generated-reviewed") return t("exam.origin-spec");
	return t("exam.origin-operator");
}

/**
 * The sentence, and the pieces it was built from. A renderer that paints picks
 * the pieces; every other surface prints {@link MeasurementLine.text}.
 */
export interface MeasurementLine {
	/** Localized verdict label, or null when the evidence recorded no verdict. */
	verdict: string | null;
	/** `score 31% → 62%`, or the pass rate when no score was recorded. */
	metric: string;
	/** `(+31 pts, 95% CI +9 … +41)`; the interval is dropped when absent. */
	delta: string;
	/** `on 7 cases × 3`. */
	design: string;
	/** `pass rate 17% → 58%`, or null when the metric already is the pass rate. */
	passRate: string | null;
	/** `exam: pass +30 pts (95% CI +12 … +48) on 20 × 3`, when the exam ran. */
	exam: string | null;
	/** The small-basket caveat, or null when the basket is big enough. */
	smallBasket: string | null;
	/**
	 * The development surface alone, for a screen that labels the exam on its
	 * own line — the ship dialog does, and printing the exam twice there reads
	 * as two measurements rather than one.
	 */
	development: string;
	/** The sentence without the caveat, for a panel that prints it muted below. */
	numbers: string;
	/** The whole sentence, which is what the Builder is given to quote. */
	text: string;
}

function intervalOf(confidence95: { low: number; high: number } | null): string {
	if (!confidence95) return "";
	return `, ${interval(confidence95.low, confidence95.high)}`;
}

/** `(+31 pts, 95% CI +9 … +41)` — the delta and the interval that brackets it. */
function deltaOf(delta: number | null, confidence95: { low: number; high: number } | null): string {
	return delta === null ? "" : `(${points(delta)}${intervalOf(confidence95)})`;
}

/**
 * `on 7 cases × 3`, and — when the basket lost cases — what it was designed as
 * and what became of the difference: `on 14 of 15 cases × 5 · 1 excluded for
 * infrastructure`.
 *
 * Session 8 read `на 14 кейсах × 5` for an exam of fifteen and no line said
 * where the fifteenth went, which is the whole difference between a number
 * with a provenance and a number to be taken on faith. Exported because every
 * surface that prints a measured size prints this one — the panel and the
 * headline through {@link measurementLine}, the exam through
 * {@link examLine}, and the passport by calling it directly.
 */
export function designPhrase(input: {
	tasks: number;
	repetitions: number;
	excludedTasks?: number;
	excludedReason?: ExclusionSummaryReason;
}): string {
	const excluded = Math.max(0, input.excludedTasks ?? 0);
	const designed = input.tasks + excluded;
	const cases = plural(excluded > 0 ? designed : input.tasks, excluded > 0 ? "case of" : "case measured on");
	// Legacy evidence recorded a task count and no repetition count. "× 0" is a
	// worse answer than saying only what was recorded.
	const size = excluded > 0
		? input.repetitions > 0
			? t("measurement.on-cases-of", { measured: input.tasks, cases, repetitions: input.repetitions })
			: t("measurement.on-cases-of-only", { measured: input.tasks, cases })
		: input.repetitions > 0
			? t("measurement.on-cases", { cases, repetitions: input.repetitions })
			: t("measurement.on-cases-only", { cases });
	if (excluded === 0) return size;
	return `${size} · ${t("measurement.excluded", {
		excluded: plural(excluded, "excluded case"),
		reason: exclusionReasonLabel(input.excludedReason ?? "infrastructure"),
	})}`;
}

/**
 * Why an exam is smaller than the one that was ordered.
 *
 * A generated exam is a request and a yield: 20 cases were asked for, one
 * repeated a development case and was dropped, and the exam ran on 19. Silent
 * whenever the yield was the whole request, so the ordinary exam says nothing.
 */
export function examShortfallNote(generation: ExamSurface["generation"]): string {
	if (!generation || generation.accepted >= generation.requested) return "";
	const dropped = [
		generation.droppedDuplicate > 0 ? plural(generation.droppedDuplicate, "duplicate") : null,
		generation.droppedMalformed > 0 ? plural(generation.droppedMalformed, "malformed case") : null,
	].filter((part): part is string => part !== null);
	if (dropped.length === 0) return t("exam.short-of-requested", { requested: generation.requested });
	return t("exam.dropped-at-generation", { dropped: dropped.join(", ") });
}

/** The sealed guardrail's own parts, so a panel can paint its verdict. */
export interface ExamLine {
	verdict: string;
	delta: string;
	design: string;
	/** `(1 duplicate dropped when it was generated)`, or "" for a whole exam. */
	shortfall: string;
	/** `written by the judge from the knowledge base`, or "" when unread. */
	origin: string;
	/** `pass (+30 pts, 95% CI +12 … +48) on 20 cases × 3`. */
	text: string;
}

/**
 * The sealed guardrail as a verdict, a delta and a size. Never a case of it,
 * and never a corpus identity: this is everything the exam may say out loud.
 */
export function examLine(exam: ExamSurface | null | undefined): ExamLine | null {
	if (!exam) return null;
	// `pass` alone reads the same for a change that improved the exam and for
	// one the exam merely could not convict; the outcome word says which.
	const verdict = exam.outcome ? `${verdictLabel(exam.verdict)} · ${sealedOutcomeLabel(exam.outcome)}` : verdictLabel(exam.verdict);
	const delta = deltaOf(exam.scoreDelta, exam.confidence95);
	const design = designPhrase({
		tasks: exam.tasks,
		repetitions: exam.repetitions,
		...(exam.excludedTasks !== undefined ? { excludedTasks: exam.excludedTasks } : {}),
		...(exam.excludedReason !== undefined ? { excludedReason: exam.excludedReason } : {}),
	});
	// The exam ran on 19 cases because one of the 20 was a duplicate. The size
	// is where that belongs: right behind the number it explains.
	const shortfall = examShortfallNote(exam.generation);
	// Who wrote the questions. A verdict on an exam is worth what the exam is
	// worth, and "the judge wrote it from the documents" and "the operator
	// brought it" are different claims about the same word `pass`.
	const origin = examOriginLabel(exam.origin);
	return {
		verdict,
		delta,
		design,
		shortfall,
		origin,
		text: trimSeparator([
			[verdict, delta, design, shortfall].filter((part) => part.length > 0).join(" "),
			origin,
		].filter((part) => part.length > 0).join(" · ")),
	};
}

/**
 * What one run showed, in the sentence the operator reads: how many executions
 * passed, and how many distinct failure modes were diagnosed behind the ones
 * that did not.
 *
 * A candidate's verdict has been quotable since the panel and the Builder were
 * made to say the same digits; a run's was not. The host drew
 * `прошли 0/24 · 3 типа сбоя` and the Builder, given only the brief's English
 * headline, wrote `0/24 passed. Три системные проблемы:` — the same numbers,
 * its own words, in the wrong language. Composed here so the panel, the status
 * bar and the sentence the Builder quotes are one string.
 */
export function runResultLine(input: { pass: number; total: number; failureModes: number }): string {
	return t("headline.run", {
		passed: t("run.passed", { pass: input.pass, total: input.total }),
		modes: plural(input.failureModes, "failure mode"),
	});
}

/** The caveat a basket under {@link SMALL_BASKET_CASES} cases has earned. */
export function smallBasketNote(tasks: number): string | null {
	if (tasks <= 0 || tasks >= SMALL_BASKET_CASES) return null;
	return t("measurement.small-basket", { cases: plural(tasks, "case") });
}

/**
 * Compose the sentence. `development` is the surface the gate decided on;
 * `exam` is appended only when the sealed guardrail actually ran.
 */
export function measurementLine(input: {
	development: MeasurementSurface | null;
	exam?: ExamSurface | null;
}): MeasurementLine {
	const development = input.development;
	const sealed = examLine(input.exam);
	const exam = sealed === null ? null : t("measurement.exam", { body: sealed.text });
	if (!development) {
		const text = [t("measurement.none"), exam].filter((part) => part !== null).join(" · ");
		return {
			verdict: null,
			metric: t("measurement.none"),
			delta: "",
			design: "",
			passRate: null,
			exam,
			smallBasket: null,
			development: t("measurement.none"),
			numbers: text,
			text,
		};
	}
	// A score is the primary metric wherever one was recorded; pre-v4 evidence
	// recorded none, and there the pass rate is the only thing measured at all.
	const scored = development.baselineScore !== null && development.candidateScore !== null;
	const passRateKnown = development.baselinePassRate !== null && development.candidatePassRate !== null;
	const metric = scored
		? t("measurement.score", {
			before: percent(development.baselineScore!),
			after: percent(development.candidateScore!),
		})
		: passRateKnown
			? t("measurement.pass-rate", {
				before: percent(development.baselinePassRate!),
				after: percent(development.candidatePassRate!),
			})
			: t("measurement.metric-unrecorded");
	// The delta printed always belongs to the metric named beside it. Pre-v4
	// evidence brackets its pass-rate delta, and that is the delta shown there.
	const shown = scored
		? development.scoreDelta
		: passRateKnown ? development.candidatePassRate! - development.baselinePassRate! : null;
	const delta = deltaOf(shown, development.confidence95);
	const design = designPhrase({
		tasks: development.tasks,
		repetitions: development.repetitions,
		excludedTasks: development.excludedTasks,
		excludedReason: development.excludedReason,
	});
	const passRate = scored && passRateKnown
		? t("measurement.pass-rate", {
			before: percent(development.baselinePassRate!),
			after: percent(development.candidatePassRate!),
		})
		: null;
	const verdict = development.verdict === null ? null : verdictLabel(development.verdict);
	const smallBasket = smallBasketNote(development.tasks);
	const head = [metric, delta, design].filter((part) => part.length > 0).join(" ");
	const join = (parts: readonly (string | null)[]): string =>
		trimSeparator(parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" · "));
	const numbers = join([verdict, head, passRate, exam]);
	return {
		verdict,
		metric,
		delta,
		design,
		passRate,
		exam,
		smallBasket,
		development: join([verdict, head, passRate]),
		numbers,
		text: join([numbers, smallBasket]),
	};
}
