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
export interface TypedRefusalReason {
	code: string;
	params?: Record<string, string | number>;
	/** Machine text the code cannot carry, appended after the localized sentence. */
	detail?: string;
}

export class WorkbenchTypedRefusalError extends Error {
	readonly reason: TypedRefusalReason;

	constructor(message: string, reason: TypedRefusalReason) {
		super(message);
		this.name = "WorkbenchTypedRefusalError";
		this.reason = reason;
	}
}

function isRefusalParams(value: unknown): value is Record<string, string | number> {
	if (typeof value !== "object" || value === null) return false;
	return Object.values(value).every((item) => typeof item === "string" || typeof item === "number");
}

/**
 * The typed reason of a refusal that carries one, or null for every other
 * error.
 *
 * The test is the shape, not the class: a refusal a person is meant to act on
 * is minted wherever the rule it breaks lives — the Workbench, the suite that
 * refuses before it spends anything, the brief that knows what a harness
 * change can answer — and every one of those carries the same pair. An error
 * whose `reason` is free text (a stopped experiment quotes one) carries no
 * code and is not one of these.
 */
export function typedRefusalReason(error: unknown): TypedRefusalReason | null {
	if (!(error instanceof Error) || !("reason" in error)) return null;
	const reason: unknown = error.reason;
	if (typeof reason !== "object" || reason === null || !("code" in reason)) return null;
	const code: unknown = reason.code;
	if (typeof code !== "string" || code.length === 0) return null;
	const params: unknown = "params" in reason ? reason.params : undefined;
	const detail: unknown = "detail" in reason ? reason.detail : undefined;
	return {
		code,
		...(isRefusalParams(params) ? { params } : {}),
		...(typeof detail === "string" && detail.length > 0 ? { detail } : {}),
	};
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
