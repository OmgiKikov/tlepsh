import { plural, t } from "../../i18n.js";
import { trimSeparator } from "../../application/measurement-line.js";
import { sanitizeTerminalText } from "../../trace.js";
import { stripMarkers } from "./markers.js";
import type { Paint } from "./paint.js";

export const DEFAULT_LIST_LIMIT = 12;

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
