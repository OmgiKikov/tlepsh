import { pathToFileURL } from "node:url";
import { hyperlink as nativeHyperlink } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Minimal styling seam shared by every human-facing AHDE renderer. Renderers
 * never touch ANSI directly: the TUI passes a Pi theme, tests pass plain text.
 */
export interface Paint {
	accent(text: string): string;
	heading(text: string): string;
	bold(text: string): string;
	dim(text: string): string;
	muted(text: string): string;
	success(text: string): string;
	warning(text: string): string;
	error(text: string): string;
	added(text: string): string;
	removed(text: string): string;
	link(text: string): string;
}

const identity = (text: string): string => text;

/** No styling at all; used for notifications, tests, and non-TTY hosts. */
export const plainPaint: Paint = {
	accent: identity,
	heading: identity,
	bold: identity,
	dim: identity,
	muted: identity,
	success: identity,
	warning: identity,
	error: identity,
	added: identity,
	removed: identity,
	link: identity,
};

const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * The address a link text can be opened at, or null: an http(s) URL
 * as itself, an absolute path to a file the host wrote as `file://`. Anything
 * else is a word painted like a link and left alone.
 */
export function linkTarget(text: string): string | null {
	if (CONTROLS.test(text)) return null;
	const trimmed = text.trim();
	if (/^\/.*\.(?:html|md|jsonl|json|txt)$/u.test(trimmed)) return pathToFileURL(trimmed).href;
	if (!/^(?:https?|file):\/\/\S+$/u.test(trimmed)) return null;
	try {
		const url = new URL(trimmed);
		if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname) return trimmed;
		if (url.protocol === "file:" && !url.host && !url.search && !url.hash) return trimmed;
	} catch {
		// A label is not necessarily an address.
	}
	return null;
}

/**
 * An OSC 8 hyperlink around already-styled text, so a terminal that follows
 * links (iTerm2, Terminal.app, VS Code, kitty, WezTerm) opens the Explorer on
 * a click instead of asking the operator to copy an address out of a panel.
 * pi-tui measures, wraps and re-opens OSC 8 correctly; a terminal that does
 * not know it shows the text and ignores the sequence.
 */
export function hyperlink(styled: string, target: string): string {
	const safe = linkTarget(target);
	return safe ? nativeHyperlink(styled, safe) : styled;
}

/** Bind renderers to the live Pi theme (header, widgets, tool cards, panels). */
export function themePaint(theme: Pick<Theme, "fg" | "bold">): Paint {
	return {
		accent: (text) => theme.fg("accent", text),
		heading: (text) => theme.bold(theme.fg("mdHeading", text)),
		bold: (text) => theme.bold(text),
		dim: (text) => theme.fg("dim", text),
		muted: (text) => theme.fg("muted", text),
		success: (text) => theme.fg("success", text),
		warning: (text) => theme.fg("warning", text),
		error: (text) => theme.fg("error", text),
		added: (text) => theme.fg("toolDiffAdded", text),
		removed: (text) => theme.fg("toolDiffRemoved", text),
		link: (text) => {
			const styled = theme.fg("mdLinkUrl", text);
			const target = linkTarget(text);
			return target ? hyperlink(styled, target) : styled;
		},
	};
}
