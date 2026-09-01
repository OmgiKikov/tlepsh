import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../trace.js";
import { MARKER_CLOSE, MARKER_CODES, MARKER_OPEN, stripMarkers } from "./render/markers.js";
import { themePaint, type Paint } from "./render/paint.js";

export { stripMarkers };

/**
 * Human-facing AHDE output lives in the Pi transcript as custom session
 * entries: persisted, rendered with the live theme on every redraw, and never
 * sent to the Builder model. Rendering happens at append time with a marker
 * paint so the persisted entry stays plain JSON; the entry renderer swaps the
 * markers for theme colors.
 */
export const AHDE_TRANSCRIPT_ENTRY_TYPE = "ahde-panel";
/** Hidden custom message that tells the model what the operator did through a slash command. */
export const AHDE_MODEL_NOTE_TYPE = "ahde-operator-note";

export type TranscriptTone = "info" | "success" | "warning" | "error";

export interface TranscriptEntry {
	schemaVersion: 1;
	title: string;
	tone: TranscriptTone;
	/** Marker-painted, sanitized lines. */
	lines: string[];
}

const OPEN = MARKER_OPEN;
const CLOSE = MARKER_CLOSE;
const MAX_ENTRY_LINES = 2_000;
const MAX_LINE_CHARS = 4_000;

type MarkerCode = "a" | "h" | "b" | "d" | "m" | "s" | "w" | "e" | "+" | "-" | "l";

function mark(code: MarkerCode): (text: string) => string {
	return (text) => (text.length === 0 ? "" : `${OPEN}${code}${text}${CLOSE}`);
}

/** Paint that records intent as private-use markers instead of ANSI. */
export const markerPaint: Paint = {
	accent: mark("a"),
	heading: mark("h"),
	bold: mark("b"),
	dim: mark("d"),
	muted: mark("m"),
	success: mark("s"),
	warning: mark("w"),
	error: mark("e"),
	added: mark("+"),
	removed: mark("-"),
	link: mark("l"),
};

const MARKER_PATTERN = new RegExp(`${OPEN}([${MARKER_CODES}])((?:(?!${OPEN}|${CLOSE}).)*)${CLOSE}`, "gsu");

/** Replace innermost markers first so nested paints compose. */
export function applyPaint(line: string, paint: Paint): string {
	let current = line;
	for (let round = 0; round < 8 && current.includes(OPEN); round += 1) {
		current = current.replace(MARKER_PATTERN, (_match, code: MarkerCode, text: string) => {
			switch (code) {
				case "a": return paint.accent(text);
				case "h": return paint.heading(text);
				case "b": return paint.bold(text);
				case "d": return paint.dim(text);
				case "m": return paint.muted(text);
				case "s": return paint.success(text);
				case "w": return paint.warning(text);
				case "e": return paint.error(text);
				case "+": return paint.added(text);
				case "-": return paint.removed(text);
				case "l": return paint.link(text);
			}
		});
	}
	return stripMarkers(current);
}

/** Cutting a line may split a marker pair; close what was opened so styling never leaks. */
function balanceMarkers(line: string): string {
	const opens = (line.match(//g) ?? []).length;
	const closes = (line.match(//g) ?? []).length;
	if (opens <= closes) return line;
	return `${line}${CLOSE.repeat(opens - closes)}`;
}

function boundedLines(lines: readonly string[]): string[] {
	const bounded = lines.slice(0, MAX_ENTRY_LINES).map((line) => {
		const safe = sanitizeTerminalText(line);
		const cut = [...safe].length > MAX_LINE_CHARS ? `${[...safe].slice(0, MAX_LINE_CHARS - 1).join("")}…` : safe;
		return balanceMarkers(cut);
	});
	if (lines.length > MAX_ENTRY_LINES) bounded.push(`… ${lines.length - MAX_ENTRY_LINES} more lines omitted`);
	return bounded;
}

function toneFor(paint: Paint, tone: TranscriptTone): (text: string) => string {
	switch (tone) {
		case "success": return paint.success;
		case "warning": return paint.warning;
		case "error": return paint.error;
		default: return paint.accent;
	}
}

/** Theme-aware component for one persisted AHDE transcript entry. */
export function renderTranscriptEntry(entry: TranscriptEntry, theme: Pick<Theme, "fg" | "bold">): Text {
	const paint = themePaint(theme);
	const title = paint.bold(toneFor(paint, entry.tone)(`◆ ${entry.title}`));
	const body = entry.lines.map((line) => `  ${applyPaint(line, paint)}`);
	return new Text([title, ...body].join("\n"), 0, 0);
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Partial<TranscriptEntry>;
	return entry.schemaVersion === 1 &&
		typeof entry.title === "string" &&
		typeof entry.tone === "string" &&
		Array.isArray(entry.lines) &&
		entry.lines.every((line) => typeof line === "string");
}

/** Register once per extension; hosts without entry renderers simply ignore it. */
export function registerAhdeTranscriptRenderer(pi: Pick<ExtensionAPI, "registerEntryRenderer">): void {
	if (typeof pi.registerEntryRenderer !== "function") return;
	pi.registerEntryRenderer<unknown>(AHDE_TRANSCRIPT_ENTRY_TYPE, (entry, _options, theme) => {
		if (!isTranscriptEntry(entry.data)) return undefined;
		return renderTranscriptEntry(entry.data, theme);
	});
}

export interface TranscriptHost {
	appendEntry?: ExtensionAPI["appendEntry"];
	sendMessage?: ExtensionAPI["sendMessage"];
}

export interface TranscriptPresenter {
	/** Show a human block. Falls back to a notification when the host has no transcript entries. */
	show(ctx: Pick<ExtensionContext, "ui">, block: { title: string; tone?: TranscriptTone; lines: string[] }): void;
	/** Tell the Builder model, without showing anything, what the operator did outside the conversation. */
	note(text: string, options?: { triggerTurn?: boolean }): void;
}

/**
 * One presenter per Builder Pi. `pi` may be a partial host in tests or RPC
 * mode; every capability is feature-detected and falls back to notifications.
 */
export function createTranscriptPresenter(pi: TranscriptHost): TranscriptPresenter {
	return {
		show(ctx, block) {
			const tone = block.tone ?? "info";
			const lines = boundedLines(block.lines);
			const title = stripMarkers(sanitizeTerminalText(block.title)).slice(0, 200);
			if (typeof pi.appendEntry === "function") {
				try {
					const entry: TranscriptEntry = { schemaVersion: 1, title, tone, lines };
					pi.appendEntry(AHDE_TRANSCRIPT_ENTRY_TYPE, entry);
					return;
				} catch {
					// Fall through to the plain notification.
				}
			}
			ctx.ui.notify(
				[title, ...lines.map(stripMarkers)].join("\n"),
				tone === "error" ? "error" : tone === "warning" ? "warning" : "info",
			);
		},
		note(text, options) {
			if (typeof pi.sendMessage !== "function") return;
			try {
				pi.sendMessage(
					{ customType: AHDE_MODEL_NOTE_TYPE, content: sanitizeTerminalText(text).slice(0, 4_000), display: false },
					{ triggerTurn: options?.triggerTurn ?? false },
				);
			} catch {
				// The note is a courtesy for conversational continuity, never a requirement.
			}
		},
	};
}
