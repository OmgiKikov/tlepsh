import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { DialogueMessage } from "../manifest.js";
import {
	boundTargetFeedbackDialogue,
	boundTargetFeedbackNote,
	MAX_TARGET_FEEDBACK_NOTE_CHARS,
	type TargetFeedbackDraft,
	type TargetFeedbackVerdict,
} from "../application/target-feedback.js";

/**
 * Pi's own defaults claim `ctrl+g` (external editor) and `ctrl+b` (cursor
 * left), so the marks take two keys `keybindings.md` leaves free.
 */
export const TARGET_FEEDBACK_SHORTCUTS = { good: "alt+g", bad: "alt+x" } as const;
export const TARGET_FEEDBACK_COMMAND_NAMES = ["good", "bad"] as const;
export const TARGET_FEEDBACK_EXTENSION_NAME = "ahde-target-feedback";

/** What the parent does with one mark. The child never touches the project checkout. */
export interface TargetFeedbackChannel {
	mark(draft: TargetFeedbackDraft): Promise<{ path: string; total: number }>;
}

interface DialogueEntry {
	type?: unknown;
	message?: { role?: unknown; content?: unknown } | undefined;
}

function entryText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("");
}

/**
 * The dialogue up to and including the most recent assistant reply.
 *
 * Tool calls and their results are dropped: a dialogue case seeds user and
 * assistant turns and grades the next reply, so a mark carries exactly what
 * such a case can replay. The compiler later pops the trailing assistant turn
 * and re-asks the user turn that produced it.
 */
export function targetFeedbackDialogue(entries: readonly SessionEntry[]): DialogueMessage[] {
	const turns: DialogueMessage[] = [];
	for (const entry of entries as readonly DialogueEntry[]) {
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const content = entryText(entry.message.content).trim();
		if (content.length === 0) continue;
		turns.push({ role, content });
	}
	let last = turns.length;
	while (last > 0 && turns[last - 1]?.role !== "assistant") last -= 1;
	if (last === 0) throw new Error("there is no assistant reply in this conversation to mark yet");
	const bounded = boundTargetFeedbackDialogue(turns.slice(0, last));
	if (bounded.length === 0 || bounded[bounded.length - 1]?.role !== "assistant") {
		throw new Error("there is no assistant reply in this conversation to mark yet");
	}
	return bounded;
}

function failureText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, 400);
}

async function submit(
	channel: TargetFeedbackChannel,
	ctx: ExtensionContext,
	verdict: TargetFeedbackVerdict,
	note: string | undefined,
): Promise<void> {
	try {
		const bounded = boundTargetFeedbackNote(note);
		const draft: TargetFeedbackDraft = {
			verdict,
			messages: targetFeedbackDialogue(ctx.sessionManager.buildContextEntries()),
			...(bounded !== undefined ? { note: bounded } : {}),
		};
		const saved = await channel.mark(draft);
		ctx.ui.notify(
			`Marked as ${verdict} · saved to ${saved.path} (${saved.total} so far)`,
			"info",
		);
	} catch (error) {
		// Fail closed and loud: nothing was written, and the operator is told why
		// instead of a mark quietly disappearing.
		ctx.ui.notify(`Could not mark this reply as ${verdict}: ${failureText(error)}`, "error");
	}
}

/**
 * The interactive Target's only host-owned extension surface besides the guard.
 * `/good` and `/bad [note]` mark the most recent assistant reply; each mark
 * travels to the parent over IPC and lands in the project's `imports/` inbox.
 */
export function createTargetFeedbackExtension(options: {
	channel: TargetFeedbackChannel;
}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.registerCommand("good", {
			description: "Mark the last reply as good; saves a case candidate to imports/feedback.jsonl",
			handler: async (_args, ctx) => submit(options.channel, ctx, "good", undefined),
		});
		pi.registerCommand("bad", {
			description: `Mark the last reply as bad, with an optional note (≤ ${MAX_TARGET_FEEDBACK_NOTE_CHARS} chars)`,
			handler: async (args, ctx) => submit(options.channel, ctx, "bad", args),
		});
		pi.registerShortcut(TARGET_FEEDBACK_SHORTCUTS.good, {
			description: "Mark the last reply as good",
			handler: async (ctx) => submit(options.channel, ctx, "good", undefined),
		});
		pi.registerShortcut(TARGET_FEEDBACK_SHORTCUTS.bad, {
			description: "Mark the last reply as bad",
			handler: async (ctx) => submit(options.channel, ctx, "bad", undefined),
		});
	};
}
