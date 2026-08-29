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
		link: (text) => theme.fg("mdLinkUrl", text),
	};
}
