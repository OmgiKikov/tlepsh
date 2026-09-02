import { plural, t } from "../../i18n.js";
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

export function shortSha(sha: string | null | undefined, length = 10): string {
	if (!sha) return "—";
	return sha.slice(0, length);
}

export function shortHash(hash: string | null | undefined, length = 12): string {
	if (!hash) return "—";
	const body = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
	return body.length > length ? `${body.slice(0, length)}${ELLIPSIS}` : body;
}

export function percent(rate: number): string {
	if (!Number.isFinite(rate)) return "—";
	return `${Math.round(rate * 100)}%`;
}

export function points(delta: number): string {
	if (!Number.isFinite(delta)) return "—";
	const value = Math.round(delta * 1000) / 10;
	return `${value > 0 ? "+" : ""}${value} ${t("unit.points")}`;
}

export function bar(ratio: number, width = 20): string {
	const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
	const filled = Math.round(clamped * width);
	return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

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
