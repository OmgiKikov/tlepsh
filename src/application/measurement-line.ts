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

/** `31%`. Scores and pass rates are percentages of 1.0 on every screen. */
export function percent(fraction: number): string {
	if (!Number.isFinite(fraction)) return "—";
	return `${Math.round(fraction * 100)}%`;
}

/** A `[0,1]` delta as signed percentage points with its unit: `+31 pts`. */
export function points(delta: number): string {
	if (!Number.isFinite(delta)) return "—";
	const value = Math.round(delta * 1000) / 10;
	return `${value > 0 ? "+" : ""}${value} ${t("unit.points")}`;
}

/** The same number without its unit, for the two ends of one interval. */
export function bareDelta(delta: number): string {
	if (!Number.isFinite(delta)) return "—";
	const value = Math.round(delta * 1000) / 10;
	return `${value > 0 ? "+" : ""}${value}`;
}

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
	} | null | undefined,
): MeasurementSurface | null {
	if (!input) return null;
	const number = (value: number | null | undefined): number | null =>
		typeof value === "number" && Number.isFinite(value) ? value : null;
	return {
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
	scoreDelta: number | null;
	confidence95: { low: number; high: number } | null;
	tasks: number;
	repetitions: number;
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
	/** The sentence without the caveat, for a panel that prints it muted below. */
	numbers: string;
	/** The whole sentence, which is what the Builder is given to quote. */
	text: string;
}

function intervalOf(confidence95: { low: number; high: number } | null): string {
	if (!confidence95) return "";
	return `, ${t("unit.ci")} ${bareDelta(confidence95.low)} … ${bareDelta(confidence95.high)}`;
}

/** `(+31 pts, 95% CI +9 … +41)` — the delta and the interval that brackets it. */
function deltaOf(delta: number | null, confidence95: { low: number; high: number } | null): string {
	return delta === null ? "" : `(${points(delta)}${intervalOf(confidence95)})`;
}

function designOf(tasks: number, repetitions: number): string {
	return t("measurement.on-cases", { cases: plural(tasks, "case measured on"), repetitions });
}

/** The sealed guardrail's own parts, so a panel can paint its verdict. */
export interface ExamLine {
	verdict: string;
	delta: string;
	design: string;
	/** `pass (+30 pts, 95% CI +12 … +48) on 20 cases × 3`. */
	text: string;
}

/**
 * The sealed guardrail as a verdict, a delta and a size. Never a case of it,
 * and never a corpus identity: this is everything the exam may say out loud.
 */
export function examLine(exam: ExamSurface | null | undefined): ExamLine | null {
	if (!exam) return null;
	const verdict = verdictLabel(exam.verdict);
	const delta = deltaOf(exam.scoreDelta, exam.confidence95);
	const design = designOf(exam.tasks, exam.repetitions);
	return { verdict, delta, design, text: [verdict, delta, design].filter((part) => part.length > 0).join(" ") };
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
	const design = designOf(development.tasks, development.repetitions);
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
		parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ");
	const numbers = join([verdict, head, passRate, exam]);
	return { verdict, metric, delta, design, passRate, exam, smallBasket, numbers, text: join([numbers, smallBasket]) };
}
