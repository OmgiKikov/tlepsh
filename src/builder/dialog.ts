/**
 * A host dialog choice has an id.
 *
 * Pi's `ui.select` speaks strings: it takes rendered labels and hands one back.
 * Every caller used to close that loop by comparing the answer with the label
 * it drew — `choices.indexOf(selected)` in the `/fix` chooser, `choice ===
 * LOGIN_CHOICE()` in the product shell. That makes the rendered sentence the
 * discriminant, so two failure modes whose titles collide after `oneLine(…,
 * 60)` send `/fix` to the wrong one, and a label that changes wording in one
 * place and not the other silently stops matching.
 *
 * Here the id is the discriminant and the label is presentation, evaluated at
 * call time so it is always in the operator's current language. If two labels
 * render identically {@link choose} still resolves distinct ids: it
 * disambiguates what the operator reads, never what the code compares.
 */

import { t, type MessageKey } from "../i18n.js";

/** What `choose` needs from a host: Pi's selector, and nothing else. */
export interface DialogContext {
	readonly ui: {
		select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	};
}

/** One offer: what the code decides on, and what the operator reads. */
export interface DialogChoice<T extends string> {
	readonly id: T;
	/** Rendered when the dialog opens, so a language change is never stale. */
	readonly label: () => string;
}

/**
 * Ask the host to pick one of `options` and answer with its id. `null` means
 * the operator dismissed the dialog — or the host has no selector at all, which
 * is the same thing to a caller that must not act without an answer.
 */
export async function choose<T extends string>(
	ctx: DialogContext,
	prompt: string,
	options: readonly DialogChoice<T>[],
	opts?: { signal?: AbortSignal },
): Promise<T | null> {
	if (options.length === 0 || typeof ctx.ui.select !== "function") return null;
	const byLabel = new Map<string, T>();
	const labels: string[] = [];
	for (const [index, option] of options.entries()) {
		const label = distinct(option.label(), index, byLabel);
		byLabel.set(label, option.id);
		labels.push(label);
	}
	// A caller with nothing to say passes nothing: the host sees the same two
	// arguments it always did.
	const selected = opts === undefined
		? await ctx.ui.select(prompt, labels)
		: await ctx.ui.select(prompt, labels, opts);
	if (selected === undefined) return null;
	return byLabel.get(selected) ?? null;
}

/**
 * A two-way question through the same selector, answered `true` only when the
 * operator picked the affirmative. A dismissed dialog is a no.
 */
export async function confirmChoice(
	ctx: DialogContext,
	prompt: string,
	yes: MessageKey,
	no: MessageKey,
	opts?: { signal?: AbortSignal },
): Promise<boolean> {
	const choice = await choose(ctx, prompt, [
		{ id: "yes", label: () => t(yes) },
		{ id: "no", label: () => t(no) },
	] as const, opts);
	return choice === "yes";
}

/**
 * The rendered label, made unique among the ones already offered. Two options
 * that read the same are a presentation problem — the operator cannot tell them
 * apart either — so the answer is a visible ordinal, never a silent tie broken
 * by position.
 */
function distinct(label: string, index: number, taken: ReadonlyMap<string, string>): string {
	if (!taken.has(label)) return label;
	let ordinal = index + 1;
	let candidate = t("dialog.choice-ordinal", { label, ordinal });
	while (taken.has(candidate)) {
		ordinal += 1;
		candidate = t("dialog.choice-ordinal", { label, ordinal });
	}
	return candidate;
}
