import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { plural, t } from "../../i18n.js";
import { trimSeparator } from "../../application/measurement-line.js";
import { sanitizeTerminalText } from "../../trace.js";
import { stripMarkers } from "./markers.js";
import type { Paint } from "./paint.js";

const DEFAULT_LIST_LIMIT = 12;

/**
 * What the exam has, what the gate needs, and the difference — the three
 * numbers every shortfall message states, so nobody has to subtract. Typed by
 * shape so the header, the plan and /doctor all pass their own readiness.
 */
export function examShortfall(
	readiness: { minimumTasks: number; sealedCases: number | null },
): { cases: string; minimum: number; missing: number } {
	const cases = readiness.sealedCases ?? 0;
	return {
		cases: plural(cases, "case"),
		minimum: readiness.minimumTasks,
		missing: Math.max(0, readiness.minimumTasks - cases),
	};
}
const ELLIPSIS = "…";

/**
 * Strip terminal control sequences, tabs, and the private-use characters the
 * transcript uses as style markers, so artifact-authored text can neither
 * drive the terminal nor spoof AHDE styling.
 */
export function clean(text: string): string {
	return stripMarkers(sanitizeTerminalText(String(text)))
		.replace(/\r/g, "")
		.replace(/\t/g, "  ");
}

/** Collapse to one line and cut to `max` visible characters. */
export function oneLine(text: string, max = 100): string {
	const collapsed = clean(text).replace(/\s+/g, " ").trim();
	if (max < 1) return "";
	if ([...collapsed].length <= max) return collapsed;
	return `${[...collapsed].slice(0, Math.max(0, max - 1)).join("")}${ELLIPSIS}`;
}

/**
 * The one-line form of a sentence a person reads: collapsed, cut at a word
 * boundary rather than inside a word, and never ending on the separator the
 * cut orphaned.
 *
 * `oneLine` stays as it is for ids, paths and labels, where there is no word
 * to respect and the extra characters are worth more than the boundary. This
 * is for prose — the `◆` headline above all, where `sealed hol…` was both
 * unreadable and, being the operator's only account of a blocker, wrong.
 */
export function headline(text: string, max = 120): string {
	const collapsed = clean(text).replace(/\s+/g, " ").trim();
	if (max < 1) return "";
	const chars = [...collapsed];
	if (chars.length <= max) return trimSeparator(collapsed);
	const budget = Math.max(0, max - 1);
	const cut = chars.slice(0, budget).join("");
	const boundary = cut.lastIndexOf(" ");
	// A boundary in the last half of the budget is a word break worth taking; an
	// unbroken run that long is an id or a hash, and it still has to end.
	const body = boundary > Math.floor(budget / 2) ? cut.slice(0, boundary) : cut;
	return `${trimSeparator(body)}${ELLIPSIS}`;
}

/** How much of a case's own words is enough to recognise it by. */
const MAX_CASE_TITLE_CHARS = 40;

/**
 * `task-3f2a1b9c…` — enough of a case id to match two screens by eye.
 *
 * A Builder-published case is identified by the content hash of the whole
 * task, so its id is 69 characters and a column of them is a wall nobody
 * reads: sessions 6 and 7 both ended up counting characters to tell two cases
 * apart. Only that hash is folded — an id somebody wrote, like `task-routing`,
 * is already a name and is printed whole.
 */
export function shortTaskId(taskId: string, length = 8): string {
	const hashed = /^task-([0-9a-f]{32,})$/.exec(taskId);
	const body = hashed?.[1];
	return body === undefined ? taskId : `task-${body.slice(0, length)}${ELLIPSIS}`;
}

/** The fields a case is named from. Never its id: an id is not a name. */
export interface TitledCase {
	input: string;
	metadata?: Readonly<Record<string, string>> | null | undefined;
}

/**
 * The name a person would give this case: the title it carries, or its own
 * opening words in quotes — `«где мой платёж…»`.
 *
 * The quotes are the whole point of the second form: they say these are the
 * case's words, not a name somebody wrote for it. Nothing is invented, and a
 * case that carries a real title is printed bare, because it already has one.
 */
export function caseTitle(task: TitledCase, max = MAX_CASE_TITLE_CHARS): string {
	const named = task.metadata?.title ?? task.metadata?.name ?? "";
	if (named.trim().length > 0) return oneLine(named, max);
	const collapsed = clean(task.input).replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return t("view.case-unnamed");
	// The first clause, when the input has one: a case that opens with a
	// sentence is named by that sentence, not by the paragraph behind it.
	const clause = /^[\s\S]*?[.!?…](?=\s|$)/.exec(collapsed)?.[0] ?? collapsed;
	return t("view.case-quoted", { text: headline(clause.replace(/\.$/, ""), max) });
}

/**
 * The name a row of a table calls a case by. An id somebody wrote (`task_006`,
 * `tariff-lookup`) is already a name; a content-hash id is not, so the case's
 * own opening words stand in for it, quoted, the way `caseTitle` names it.
 */
export function caseLabel(taskId: string, input: string | null | undefined, max = MAX_CASE_TITLE_CHARS): string {
	if (!/^task-[0-9a-f]{32,}$/.test(taskId)) return oneLine(taskId, max);
	if (input && input.trim().length > 0) return caseTitle({ input }, max);
	return shortTaskId(taskId);
}

/** Collapse whitespace and cut to `max` characters, marking the cut. */
export function clip(value: string, max: number): string {
	const flat = value.replace(/\s+/gu, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}${ELLIPSIS}`;
}

export function shortSha(sha: string | null | undefined, length = 10): string {
	if (!sha) return "—";
	return sha.slice(0, length);
}

export function shortHash(hash: string | null | undefined, length = 12): string {
	if (!hash) return "—";
	const body = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
	return body.length > length ? `${body.slice(0, length)}${ELLIPSIS}` : body;
}

// Every number this system argues about, from the one module that formats
// them. The panel, the growth log, the passport, the progress bar and the
// sentence the Builder quotes all read them from here, so a rate can never be
// a percentage on one screen and a fraction on the next, and `pp` can never be
// spelled twice with two precisions.
export {
	band,
	bar,
	bareDelta,
	coarseElapsed,
	duration,
	elapsed,
	fromPoints,
	interval,
	isSubCent,
	kappa,
	kappaValue,
	money,
	percent,
	points,
	ratio,
} from "../../measurement.js";
export { trimSeparator } from "../../application/measurement-line.js";

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

export function bytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function when(timestamp: string | null | undefined): string {
	if (!timestamp) return "—";
	return clean(timestamp).replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/** Left-aligned label column followed by a value. */
export function labeled(label: string, value: string, width = 12): string {
	return `${label.padEnd(width)} ${value}`;
}

export function bullets(
	items: readonly string[],
	paint: Paint,
	options: { limit?: number; indent?: string; max?: number } = {},
): string[] {
	const limit = options.limit ?? DEFAULT_LIST_LIMIT;
	const indent = options.indent ?? "  ";
	const shown = items.slice(0, limit).map((item) => `${indent}${paint.dim("•")} ${oneLine(item, options.max ?? 160)}`);
	if (items.length > limit) shown.push(`${indent}${paint.dim(`… +${items.length - limit} more`)}`);
	return shown;
}

export function numbered(
	items: readonly string[],
	paint: Paint,
	options: { limit?: number; indent?: string; max?: number } = {},
): string[] {
	const limit = options.limit ?? DEFAULT_LIST_LIMIT;
	const indent = options.indent ?? "  ";
	const shown = items.slice(0, limit).map((item, index) =>
		`${indent}${paint.dim(`${String(index + 1).padStart(2)}.`)} ${oneLine(item, options.max ?? 160)}`
	);
	if (items.length > limit) shown.push(`${indent}${paint.dim(`… +${items.length - limit} more`)}`);
	return shown;
}

export function section(title: string, paint: Paint): string {
	return paint.heading(title);
}

/** Word-wrap sanitized prose; keeps explicit paragraph breaks. */
export function wrap(text: string, width = 96, indent = ""): string[] {
	const lines: string[] = [];
	for (const paragraph of clean(text).split(/\n+/)) {
		const words = paragraph.trim().split(/\s+/).filter(Boolean);
		if (words.length === 0) continue;
		let current = "";
		for (const word of words) {
			if (current && [...current].length + 1 + [...word].length > width) {
				lines.push(`${indent}${current}`);
				current = word;
			} else {
				current = current ? `${current} ${word}` : word;
			}
		}
		if (current) lines.push(`${indent}${current}`);
	}
	return lines;
}

export function joinNonEmpty(parts: readonly (string | null | undefined | false)[], separator = " · "): string {
	return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(separator);
}

// ---------- Tables ----------

/** A tone is a `Paint` method name; a cell asks for one and never paints itself. */
export type Tone = keyof Paint;

export interface TableCell {
	text: string;
	tone?: Tone;
	align?: "left" | "right";
}

export interface TableColumn {
	header: string;
	align?: "left" | "right";
	/** Shrink floor; smaller budgets use a stacked representation. */
	min?: number;
	/** Never wider than this, however long its cells are. */
	max?: number;
	/**
	 * A column that gives up width first when the table is too wide. Without
	 * any flagged, the widest column shrinks.
	 */
	flex?: boolean;
}

export interface TableOptions {
	/** Visible columns the whole table may take. */
	width?: number;
	/** Spaces between columns. */
	gap?: number;
	/** A dim rule under the header. */
	rule?: boolean;
}

/** Columns a panel line may take before Pi wraps it on an ordinary terminal. */
export const TABLE_WIDTH = 104;
const TABLE_GAP = 2;
const MIN_COLUMN = 4;

/** Terminal cells of a line: no ANSI, hyperlinks or markers. */
export function visibleLength(text: string): number {
	return visibleWidth(stripMarkers(text));
}

function cellOf(cell: string | TableCell): TableCell {
	return typeof cell === "string" ? { text: cell } : cell;
}

function padCell(text: string, width: number, align: "left" | "right"): string {
	const length = visibleLength(text);
	if (length >= width) return text;
	const fill = " ".repeat(width - length);
	return align === "right" ? `${fill}${text}` : `${text}${fill}`;
}

/**
 * Column widths that fit the budget: every column as wide as its widest cell,
 * bounded by `max`; when the sum overflows, the flex columns give width back
 * in proportion to what they have above their `min`.
 */
function fitColumns(columns: readonly TableColumn[], rows: readonly TableCell[][], budget: number, gap: number): number[] {
	const natural = columns.map((column, index) => {
		const widest = rows.reduce((width, row) => Math.max(width, visibleLength(clean(row[index]?.text ?? "").replace(/\s+/g, " ").trim())), Math.max(visibleLength(clean(column.header)), 1));
		return Math.max(1, Math.min(widest, Math.floor(column.max ?? Number.MAX_SAFE_INTEGER)));
	});
	const total = natural.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, columns.length - 1);
	if (total <= budget) return natural;
	let flexible = columns.map((column, index) => (column.flex ? index : -1)).filter((index) => index >= 0);
	if (flexible.length === 0) flexible = [natural.indexOf(Math.max(...natural))];
	const widths = [...natural];
	let overflow = total - budget;
	// Shrink the flex columns towards their floors, widest first, until the
	// overflow is paid or nothing flexible is left to give.
	while (overflow > 0) {
		const givers = flexible.filter((index) => widths[index]! > Math.max(columns[index]!.min ?? MIN_COLUMN, MIN_COLUMN));
		if (givers.length === 0) {
			if (flexible.length === columns.length) break;
			flexible = columns.map((_column, index) => index);
			continue;
		}
		const spare = givers.reduce((sum, index) => sum + (widths[index]! - Math.max(columns[index]!.min ?? MIN_COLUMN, MIN_COLUMN)), 0);
		for (const index of givers) {
			const floor = Math.max(columns[index]!.min ?? MIN_COLUMN, MIN_COLUMN);
			const share = Math.max(1, Math.round((overflow * (widths[index]! - floor)) / Math.max(1, spare)));
			const cut = Math.min(share, widths[index]! - floor, overflow);
			widths[index] = widths[index]! - cut;
			overflow -= cut;
			if (overflow <= 0) break;
		}
	}
	return widths;
}

/**
 * A columnar table as panel lines: a dim header, an optional rule, then the
 * rows, every cell cut to its column and painted after it is cut so a tone
 * never hides characters the width counted.
 *
 * Cells arrive as text; painting is the table's job. That is what lets one
 * helper serve the runs table, the candidate comparison and the model grid
 * without any of them padding a painted string by its byte length again.
 */
export function table(
	columns: readonly TableColumn[],
	rows: readonly (readonly (string | TableCell)[])[],
	paint: Paint,
	options: TableOptions = {},
): string[] {
	if (columns.length === 0) return [];
	const budget = Math.max(0, Math.floor(options.width ?? TABLE_WIDTH));
	if (budget === 0) return [];
	const gapWidth = Math.max(0, Math.floor(options.gap ?? TABLE_GAP));
	const gap = " ".repeat(gapWidth);
	const cut = (text: string, width: number): string => clean(truncateToWidth(clean(text).replace(/\s+/g, " ").trim(), width, ELLIPSIS));
	const cells = rows.map((row) => columns.map((_column, index) => cellOf(row[index] ?? "")));
	const widths = fitColumns(columns, cells, budget, gapWidth);
	if (widths.reduce((sum, width) => sum + width, 0) + gapWidth * (columns.length - 1) > budget) {
		if (cells.length === 0) return columns.map((column) => paint.dim(cut(column.header, budget)));
		return cells.flatMap((row, rowIndex) => [
			...(rowIndex > 0 ? [""] : []),
			...row.flatMap((cell, index) => {
				const text = cut(cell.text, budget);
				return [paint.dim(cut(columns[index]!.header, budget)), cell.tone ? paint[cell.tone](text) : text];
			}),
		]);
	}
	const last = columns.length - 1;
	const line = (parts: readonly string[]): string => parts.join(gap).replace(/\s+$/u, "");
	const header = line(columns.map((column, index) =>
		padCell(cut(column.header, widths[index]!), widths[index]!, column.align ?? "left")));
	const lines = [paint.dim(header)];
	if (options.rule !== false) lines.push(paint.dim(line(widths.map((width) => "─".repeat(width)))));
	for (const row of cells) {
		lines.push(line(row.map((cell, index) => {
			const width = widths[index]!;
			const align = cell.align ?? columns[index]!.align ?? "left";
			const text = cut(cell.text, width);
			// The last column is never padded on the right: a trailing run of
			// spaces is invisible and still counts against the wrap width.
			const padded = index === last && align === "left" ? text : padCell(text, width, align);
			return cell.tone ? paint[cell.tone](padded) : padded;
		})));
	}
	return lines;
}
