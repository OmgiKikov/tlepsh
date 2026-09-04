import { t } from "./i18n.js";

/**
 * Every number this product argues about, written in one place.
 *
 * `application/measurement-line.ts` composes the *sentence* a verification
 * prints; this module owns the *numbers* inside it — and inside every other surface that
 * shows one. It was written because the opposite had happened: the score was a
 * percentage with no decimal in the composer, one decimal on the passport
 * panel and clamped again in the trace; the same delta was `+3.1 pts` in the
 * sentence and `+3.1pp` in the four files that formatted it themselves, so a
 * Russian screen printed an English unit; a spend under a cent was `<$0.01` in
 * one renderer, `$0.00` in two others and `under $0.01` at a third threshold;
 * and κ with nothing behind it was `κ n/a`, `κ —` and bare `n/a` on three
 * screens of the same panel.
 *
 * The rules, one per quantity, and the reason each one is the rule:
 *
 *  - **Percent** is a whole percent. A pass rate is a count over a count, and
 *    the decimal in `31.5%` is smaller than the noise every A/A run in this
 *    product measures. `{ digits: 1 }` is the one exception, and it is for a
 *    *series*: the growth chart, the passport's before → after and the watch
 *    tick each put two measurements beside each other, where rounding both to
 *    the same whole number would claim they are equal. Out-of-range input is
 *    clamped: a rate is a rate, and `140%` on a screen is worth less than the
 *    bug it hides.
 *  - **Points** are tenths of a point — the resolution the bootstrap interval
 *    is reported at, and one more digit than any basket this product runs can
 *    support. The unit is the dictionary's (`п.п.` / `pts`).
 *  - **The interval** never repeats the unit. It brackets a delta that has
 *    just been printed with its unit; `+31 pts (95% CI +9 pts … +41 pts)` says
 *    "points" three times about one measurement. Where an interval stands
 *    alone in a sentence — a gate reason — `unit: "after"` names it once, at
 *    the end.
 *  - **Money** is two decimals, except below half a cent, where two decimals
 *    would round a real bill down to `$0.00` and say "free" about something
 *    that was not. One threshold, here.
 *  - **κ** with nothing behind it is `κ —`. `n/a` is an English abbreviation
 *    on a Russian screen, and `—` is already this product's word for "not
 *    measured" in every table it draws.
 *  - **Ratios** are one decimal below ten and none above it: `×1.4`, `×12`.
 *    The second decimal of a cost ratio is noise, and `×1.40` reads like a
 *    precision nobody measured.
 *
 * **Forms.** `screen` is the default and the operator's: the unit comes from
 * the dictionary, and a trailing `.0` is dropped because `+3 п.п.` is what a
 * person says. `machine` is for the surfaces that are English by design — the
 * markdown comparison report, the Pareto and cycle tables, the stderr progress
 * lines, the compact history the Builder reads back before it authors — where
 * the digit count never bends, so a column lines up and two runs differ in the
 * number rather than in its width. Same rounding, same unit rule, one module:
 * a caller picks an audience, never a private copy.
 *
 * It sits beside `i18n.ts` rather than under `application/` because the gate
 * in `domain/` prints numbers too, and `domain/` imports nothing from
 * `application/`. Its only dependency is the dictionary.
 */

/** Who reads this number: the operator, or a machine-readable English surface. */
export type MeasurementForm = "screen" | "machine";

/** The one thing every formatter here prints when it was handed nothing. */
export const NOT_MEASURED = "—";

/** Below this many dollars, two decimals would print a real bill as free. */
export const SUB_CENT_USD = 0.005;

/** A ratio at or above this prints no decimal: `×12`, not `×12.0`. */
const RATIO_INTEGER_AT = 10;

function finite(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Tenths of a point, from a `[0,1]` fraction. */
function tenths(delta: number): number {
	return Math.round(delta * 1000) / 10;
}

function signedDigits(value: number, form: MeasurementForm): string {
	const digits = form === "machine" ? value.toFixed(1) : String(value);
	return `${value > 0 ? "+" : ""}${digits}`;
}

/** The unit a point carries: the dictionary's on screen, `pp` in machine text. */
function pointsUnit(form: MeasurementForm): string {
	return form === "machine" ? "pp" : ` ${t("unit.points")}`;
}

/**
 * A value already counted in percentage points — a prediction, a noise band —
 * as this module's `[0,1]` input. The explicit conversion is the point: two
 * scales for one quantity is how `render/prediction.ts` came to hold a fifth
 * copy of `points()` that agreed with none of the other four.
 */
export function fromPoints(value: number): number {
	return value / 100;
}

/** `31%`. Scores, pass rates and shares are percentages of 1.0 on every screen. */
export function percent(fraction: number | null | undefined, options: { digits?: 0 | 1 } = {}): string {
	if (!finite(fraction)) return NOT_MEASURED;
	const clamped = Math.min(1, Math.max(0, fraction));
	return `${(clamped * 100).toFixed(options.digits ?? 0)}%`;
}

/** A `[0,1]` delta as signed percentage points with its unit: `+3.1 п.п.`. */
export function points(delta: number | null | undefined, form: MeasurementForm = "screen"): string {
	if (!finite(delta)) return NOT_MEASURED;
	return `${signedDigits(tenths(delta), form)}${pointsUnit(form)}`;
}

/** The same number without its unit, for the two ends of one interval. */
export function bareDelta(delta: number | null | undefined, form: MeasurementForm = "screen"): string {
	if (!finite(delta)) return NOT_MEASURED;
	return signedDigits(tenths(delta), form);
}

/**
 * `±6 п.п.` — a half-width. A spread has no direction, so it has no sign to
 * print, and a `+` in front of a noise band reads as an improvement.
 */
export function band(halfWidth: number | null | undefined, form: MeasurementForm = "screen"): string {
	const value = finite(halfWidth) ? Math.abs(tenths(halfWidth)) : 0;
	return `±${form === "machine" ? value.toFixed(1) : String(value)}${pointsUnit(form)}`;
}

/**
 * `95% CI +9 … +41` — the one bracket this product prints.
 *
 * The unit is on the delta the interval brackets, never on its ends. Pass
 * `unit: "after"` for the one place the interval stands on its own — a gate
 * reason, where nothing before it has named the quantity — and it is printed
 * once, behind the high end.
 */
export function interval(
	low: number,
	high: number,
	options: { form?: MeasurementForm; unit?: "none" | "after" } = {},
): string {
	const form = options.form ?? "screen";
	const tail = options.unit === "after" ? pointsUnit(form) : "";
	return `${t("unit.ci")} ${bareDelta(low, form)} … ${bareDelta(high, form)}${tail}`;
}

/** `×1.4` / `×12` / `—`. Candidate over baseline, one decimal below ten. */
export function ratio(value: number | null | undefined): string {
	if (!finite(value)) return NOT_MEASURED;
	return `×${value >= RATIO_INTEGER_AT ? value.toFixed(0) : value.toFixed(1)}`;
}

/** `0.62` / `—` — Cohen's κ as a bare number, for a sentence that names it. */
export function kappaValue(value: number | null | undefined): string {
	return finite(value) ? value.toFixed(2) : NOT_MEASURED;
}

/** `κ 0.62` / `κ —`. Never `n/a`: the dash is this product's "not measured". */
export function kappa(value: number | null | undefined): string {
	return `κ ${kappaValue(value)}`;
}

/** Whether two decimals would round this spend down to `$0.00`. */
export function isSubCent(usd: number): boolean {
	return finite(usd) && usd > 0 && usd < SUB_CENT_USD;
}

/**
 * `$1.40` — money as money is read, and `<$0.01` for a bill two decimals
 * would print as free. One threshold for the whole product.
 */
export function money(usd: number | null | undefined): string {
	if (!finite(usd)) return "$0.00";
	if (isSubCent(usd)) return t("unit.under-cent");
	return `$${Math.max(0, usd).toFixed(2)}`;
}

/** `1.4s` / `340ms` / `—` — one measured stretch of machine time. */
export function duration(milliseconds: number | null | undefined): string {
	if (!finite(milliseconds)) return NOT_MEASURED;
	return milliseconds >= 1_000 ? `${(milliseconds / 1_000).toFixed(1)}s` : `${Math.round(milliseconds)}ms`;
}

/** `4м12с` / `4m12s`; never rounded up to a unit that did not elapse. */
export function elapsed(milliseconds: number): string {
	const total = Math.max(0, Math.round((finite(milliseconds) ? milliseconds : 0) / 1_000));
	const hours = Math.floor(total / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}${t("unit.hour-short")}${String(minutes).padStart(2, "0")}${t("unit.minute-short")}`;
	if (minutes > 0) return `${minutes}${t("unit.minute-short")}${String(seconds).padStart(2, "0")}${t("unit.second-short")}`;
	return `${seconds}${t("unit.second-short")}`;
}

/**
 * `12m` / `1h04m` / `47s` — the same clock without the seconds, for the two
 * places that are re-read constantly and only need the magnitude.
 */
export function coarseElapsed(milliseconds: number): string {
	const total = Math.max(0, Math.round((finite(milliseconds) ? milliseconds : 0) / 1_000));
	const hours = Math.floor(total / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	if (hours > 0) return `${hours}${t("unit.hour-short")}${String(minutes).padStart(2, "0")}${t("unit.minute-short")}`;
	if (minutes > 0) return `${minutes}${t("unit.minute-short")}`;
	return `${total}${t("unit.second-short")}`;
}

/** `████████░░░░` — a `[0,1]` ratio as a bar, and nothing else on the line. */
export function bar(value: number, width = 20): string {
	const clamped = finite(value) ? Math.min(1, Math.max(0, value)) : 0;
	const filled = Math.round(clamped * width);
	return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}
