import { hasMessage, t } from "../i18n.js";
import type { WorkbenchVerificationBlocked } from "./types.js";

export class WorkbenchSelectionRequiredError extends Error {
	readonly kind: string;
	readonly choices: readonly string[];

	constructor(kind: string, choices: readonly string[]) {
		super(
			choices.length === 0
				? `No compatible ${kind} is available`
				: `Several compatible ${kind} artifacts exist; select one before continuing`,
		);
		this.name = "WorkbenchSelectionRequiredError";
		this.kind = kind;
		this.choices = choices;
	}
}

export class WorkbenchDecisionDeclinedError extends Error {
	constructor(kind: string) {
		super(`${kind} was declined by the human operator`);
		this.name = "WorkbenchDecisionDeclinedError";
	}
}

export class WorkbenchStaleDecisionError extends Error {
	constructor(kind: string) {
		super(`${kind} subject changed after confirmation; the decision is stale`);
		this.name = "WorkbenchStaleDecisionError";
	}
}

/**
 * A refusal that carries its own localizable form.
 *
 * The Workbench mints every refusal as one English sentence — the model reads
 * it, scripts match on it, tests pin it. A refusal a person is meant to act on
 * needs a second form: a code the host renders in the operator's language, the
 * same pairing `WorkbenchView.blockers` / `blockerReasons` already uses. The
 * English sentence stays the `message`; `reason` is what the host draws.
 */
export class WorkbenchTypedRefusalError extends Error {
	readonly reason: { code: string; params?: Record<string, string | number> };

	constructor(message: string, reason: { code: string; params?: Record<string, string | number> }) {
		super(message);
		this.name = "WorkbenchTypedRefusalError";
		this.reason = reason;
	}
}

/** The typed reason of a refusal that carries one, or null for every other error. */
export function typedRefusalReason(error: unknown): { code: string; params?: Record<string, string | number> } | null {
	return error instanceof WorkbenchTypedRefusalError ? error.reason : null;
}

/**
 * The blocked verification as a sentence. The typed code wins where the
 * refusal has one — that sentence is written for a person and fits a line;
 * the English message is the fallback for a refusal that carries no code.
 */
export function blockedReasonText(blocked: WorkbenchVerificationBlocked): string {
	const code = blocked.reasonCode?.code;
	if (code && hasMessage(code)) return t(code, blocked.reasonCode?.params);
	return blocked.reason;
}
