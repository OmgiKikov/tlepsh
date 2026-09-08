/**
 * The basket after a run, as the run panel and `/traces` draw it. Lives on its
 * own so the two panels share one drawing without the run panel importing the
 * view or the view importing the run panel.
 */
import type { WorkbenchBasketReading } from "../../workbench/types.js";
import { coverageCellLabel } from "../../domain/case-coverage.js";
import { plural, t } from "../../i18n.js";
import { joinNonEmpty, oneLine, percent, section, wrap } from "./format.js";
import type { Paint } from "./paint.js";

/** At most this many comparable cells on the panel; the reading carries every one. */
const ORIGIN_CELLS_SHOWN = 6;
/** How much of the next wave one reading names before it stops being readable. */
const NEXT_WAVE_CELLS_SHOWN = 5;
const NEXT_WAVE_MODES_SHOWN = 3;
const NEXT_WAVE_JOBS_SHOWN = 3;
/** The basket panel's line budget, inside the width the transcript wraps at. */
const BASKET_LINE_WIDTH = 118;
/** A cell label, a mode title and a job are labels: long ones are cut, not wrapped. */
const CELL_LABEL_CHARS = 56;
const MODE_TITLE_CHARS = 60;
const JOB_LABEL_CHARS = 40;

/**
 * `+12 pp` / `−8 pp`. The sign is the whole message, and the character in front
 * of a negative gap is a real minus rather than the hyphen a font draws half as
 * wide. Already counted in points by the reading, so this is not `points()`,
 * which bends a `[0,1]` delta into tenths.
 */
function gapPoints(points: number): string {
	// The unit comes from the dictionary: `pts` on an English screen, `п.п.` on a Russian one.
	if (points === 0) return `0 ${t("unit.points")}`;
	return `${points > 0 ? "+" : "−"}${Math.abs(points)} ${t("unit.points")}`;
}

/**
 * The basket after a run: what stands, what is work, what the wave added, and
 * where the next wave goes.
 *
 * One tone here is deliberately plain. A case that fails every repetition with a
 * test the critic found sound is work on the agent — not an alarm — and painting
 * it red is the first step towards a basket that has quietly lost its hardest
 * cases. The warning belongs to the doubt the critic raised about the TEST, and
 * the dim line under everything is the rule none of this may break.
 */
export function renderBasket(reading: WorkbenchBasketReading, paint: Paint): string[] {
	const { counts, origins, nextWave } = reading;
	const lines = [section(t("basket.title"), paint)];
	const plainTone = (text: string): string => text;
	// Prose is wrapped at a word, never cut: the tail of “never drop it for
	// failing” is the one sentence this panel exists to say. A continuation is
	// indented, so a reading that took two lines still reads as one.
	const say = (text: string, tone: (value: string) => string = plainTone): void => {
		wrap(text, BASKET_LINE_WIDTH).forEach((line, index) => lines.push(tone(index === 0 ? line : `  ${line}`)));
	};
	if (counts.saturated > 0) say(t("basket.saturated", { cases: plural(counts.saturated, "case") }), paint.success);
	if (counts.failingValid > 0) say(t("basket.failing-valid", { cases: plural(counts.failingValid, "case") }));
	if (counts.failingDoubtful > 0) say(t("basket.failing-doubtful", { cases: plural(counts.failingDoubtful, "case") }), paint.warning);
	if (counts.failingUnreviewed > 0) say(t("basket.failing-unreviewed", { cases: plural(counts.failingUnreviewed, "case") }), paint.muted);
	if (counts.unstable > 0) say(t("basket.unstable", { cases: plural(counts.unstable, "case") }), paint.muted);
	// A wave that added nothing is a re-run of the same basket, and “added 0
	// cases” is a line about an event that never happened.
	if (reading.wave && reading.wave.newCases > 0) {
		const wave = reading.wave;
		say(
			wave.saturated
				? t("basket.wave-saturated", { cases: plural(wave.newCases, "case") })
				: t("basket.wave", { cases: plural(wave.newCases, "case"), failing: wave.newFailing }),
			// Saturation is not good news: the wave stopped separating anything.
			wave.saturated ? paint.warning : plainTone,
		);
	}
	say(t("basket.origins", {
		real: origins.real,
		synthetic: origins.synthetic,
		unknown: origins.unknown,
		realism: origins.realism === "compared"
			? t("basket.realism.compared", { cells: origins.comparable.length })
			: t("basket.realism.unverified"),
	}));
	for (const cell of origins.comparable.slice(0, ORIGIN_CELLS_SHOWN)) {
		// How many cases each side of a gap rests on travels with the gap: a
		// twenty-point difference over one real case is not the same reading as
		// the same difference over six.
		lines.push(`  ${oneLine(t("basket.origin-cell", {
			cell: oneLine(`${coverageCellLabel(cell)}${cell.state ? ` · ${cell.state}` : ""}`, CELL_LABEL_CHARS),
			real: `${percent(cell.real.passRate)} · ${plural(cell.real.cases, "case")}`,
			synthetic: `${percent(cell.synthetic.passRate)} · ${plural(cell.synthetic.cases, "case")}`,
			gap: gapPoints(cell.gapPoints),
		}), BASKET_LINE_WIDTH - 2)}`);
	}
	const targets = joinNonEmpty([
		nextWave.emptyCells.length > 0
			? t("basket.next-wave.cells", {
				cells: nextWave.emptyCells.slice(0, NEXT_WAVE_CELLS_SHOWN).map((cell) => oneLine(coverageCellLabel(cell), CELL_LABEL_CHARS)).join(", "),
			})
			: "",
		nextWave.targetModes.length > 0
			? t("basket.next-wave.modes", { modes: nextWave.targetModes.slice(0, NEXT_WAVE_MODES_SHOWN).map((mode) => oneLine(mode, MODE_TITLE_CHARS)).join(", ") })
			: "",
		nextWave.harderJobs.length > 0
			? t("basket.next-wave.harder", { jobs: nextWave.harderJobs.slice(0, NEXT_WAVE_JOBS_SHOWN).map((job) => oneLine(job, JOB_LABEL_CHARS)).join(", ") })
			: "",
	]);
	// The one actionable line of the panel: wrapped like the readings above it,
	// because a next wave cut off after its second empty cell is not an
	// instruction anybody can follow.
	if (targets) say(t("basket.next-wave", { targets }));
	lines.push(paint.dim(oneLine(t("basket.rule"), BASKET_LINE_WIDTH)));
	return lines;
}
