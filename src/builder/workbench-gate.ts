import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	WorkbenchConfirmation,
	WorkbenchHumanGate,
} from "../workbench/types.js";
import { renderConfirmation } from "./render/confirmation.js";
import { plainPaint } from "./render/paint.js";

export type WorkbenchInteractiveGuard = (operation: string) => void;

/** Human-readable confirmation body: what happens, the exact subject, the reason, and its hash. */
export function formatWorkbenchConfirmation(confirmation: WorkbenchConfirmation): string {
	return renderConfirmation(confirmation, plainPaint).join("\n");
}

/**
 * Bridges the host-owned Pi UI to the Workbench gate without exposing actor or
 * sealed-corpus identity through tool or command input.
 */
export function createWorkbenchHumanGate(
	ctx: ExtensionContext,
	actorId: () => string,
	requireInteractive: WorkbenchInteractiveGuard,
	sealedSelectionOperation = "Candidate verification",
): WorkbenchHumanGate {
	let cachedActor: string | undefined;
	const approvedActor = (): string => {
		cachedActor ??= actorId();
		return cachedActor;
	};

	return {
		async confirm(confirmation, signal) {
			requireInteractive(confirmation.kind);
			const approved = await ctx.ui.confirm(
				confirmation.title,
				formatWorkbenchConfirmation(confirmation),
				{ signal },
			);
			return approved ? { approved: true, actorId: approvedActor() } : { approved: false };
		},
		async selectSealed(request, signal) {
			requireInteractive(sealedSelectionOperation);
			// One evaluator-owned holdout needs no picker; the following confirmation
			// still shows its size before anything runs.
			if (request.options.length === 1) return { approved: true, actorId: approvedActor(), selectedIndex: 0 };
			const choices = request.options.map(
				(option, index) => `${index + 1}. ${option.label} · ${option.taskCount} tasks`,
			);
			const selected = await ctx.ui.select(request.title, choices, { signal });
			if (!selected) return { approved: false };
			const selectedIndex = choices.indexOf(selected);
			if (selectedIndex < 0) throw new Error("sealed holdout selector returned an unknown choice");
			return { approved: true, actorId: approvedActor(), selectedIndex };
		},
	};
}
