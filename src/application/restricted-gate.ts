/**
 * One restricted gate.
 *
 * Two front doors run the Target without a human watching each step — the
 * improvement loop and the proposal search — and both stand on the same
 * promise from invariant 6: a machine may measure, may apply a change on a
 * throwaway branch, and may compare; it may never take a decision that creates
 * release authority. That promise used to be written twice, once per module,
 * with the same fifteen decision kinds and the same eighteen-line decorator —
 * and the two copies had already drifted: only the search branded its gate and
 * refused an unbranded one, so `ahde improve` ran with no gate at all.
 *
 * Here it is written once. A restriction is an id plus the one sentence the
 * operator is owed when the refusal reaches them; the id picks the brand, and
 * the brand is what {@link assertRestrictedGate} demands before anything
 * spends money. `improvementLoopGate`, `proposalSearchGate` and their
 * forbidden-decision lists are thin aliases over this module, so every caller
 * keeps the name it already used.
 */

import { t, type MessageKey } from "../i18n.js";
import type { WorkbenchDecisionInput, WorkbenchHumanGate } from "../workbench/types.js";

/** Which unattended operation a gate is restricted for. */
export type GateRestrictionId = "improvement-loop" | "proposal-search";

export interface GateRestriction {
	readonly id: GateRestrictionId;
	/** What the operator should do instead, in their language. */
	readonly advice: MessageKey;
}

/**
 * Every decision that creates release authority or asks for human judgement.
 * Both restricted operations refuse all of them. `apply-proposal` is
 * deliberately absent: applying on a throwaway `candidate/…` branch is the work
 * the operator asked for, and it touches no branch they stand on.
 */
export const RESTRICTED_DECISIONS: readonly WorkbenchDecisionInput["kind"][] = [
	"scaffold-target",
	"wrap-target",
	"configure-target",
	"approve-spec",
	"publish-corpus",
	"import-dataset",
	"start-testing",
	"review-candidate",
	"promote-candidate",
	"reject-candidate",
	"adopt-candidate",
	"continue-cycle",
	"abandon-candidate",
	"discard-proposal",
	"ship",
];

/**
 * One brand per restriction, in the global symbol registry: a gate wrapped in
 * another realm still proves it went through this module.
 */
const BRANDS: Readonly<Record<GateRestrictionId, symbol>> = {
	"improvement-loop": Symbol.for("ahde.improvement-loop.gate"),
	"proposal-search": Symbol.for("ahde.proposal-search.gate"),
};

/** The operation's name as the operator reads it. */
const OPERATIONS: Readonly<Record<GateRestrictionId, MessageKey>> = {
	"improvement-loop": "gate.restricted.improvement-loop",
	"proposal-search": "gate.restricted.proposal-search",
};

/** The wrapper a caller has to reach for. A function name, never language. */
const WRAPPERS: Readonly<Record<GateRestrictionId, string>> = {
	"improvement-loop": "improvementLoopGate",
	"proposal-search": "proposalSearchGate",
};

/**
 * A restricted operation reached a decision that is the human's. This is not a
 * declined request: an operation that asks is a bug, so it throws, and the
 * sentence the operator reads says which decision and what to do instead.
 */
export class RestrictedGateDecisionError extends Error {
	readonly restriction: GateRestrictionId;
	constructor(restriction: GateRestriction, readonly decision: string) {
		super(t("gate.restricted.refusal", {
			operation: t(OPERATIONS[restriction.id]),
			decision,
			advice: t(restriction.advice),
		}));
		this.name = "RestrictedGateDecisionError";
		this.restriction = restriction.id;
	}
}

/** A restricted operation was handed a gate that never went through here. */
export class UnrestrictedGateError extends Error {
	constructor(readonly restriction: GateRestrictionId) {
		super(t("gate.restricted.unwrapped", {
			operation: t(OPERATIONS[restriction]),
			wrapper: WRAPPERS[restriction],
		}));
		this.name = "UnrestrictedGateError";
	}
}

/**
 * The gate a restricted operation hands to anything it calls. A forbidden
 * decision is not declined, it throws; the sealed holdout answers one question
 * — may this ship — and neither operation ever asks it.
 */
export function restrictedGate(gate: WorkbenchHumanGate, restriction: GateRestriction): WorkbenchHumanGate {
	const forbidden = new Set<string>(RESTRICTED_DECISIONS);
	const guarded: WorkbenchHumanGate = {
		async confirm(confirmation, signal) {
			if (forbidden.has(confirmation.kind)) {
				throw new RestrictedGateDecisionError(restriction, confirmation.kind);
			}
			return gate.confirm(confirmation, signal);
		},
		async selectSealed() {
			throw new RestrictedGateDecisionError(restriction, t("gate.restricted.sealed-selection"));
		},
	};
	// The brand is proof, not payload: non-enumerable, so nothing serializes it
	// and no spread of this gate carries it into an unguarded copy.
	return Object.defineProperty(guarded, BRANDS[restriction.id], { value: true, enumerable: false });
}

/**
 * A caller that hands a restricted operation a gate which could still approve a
 * promotion is a bug, and the operation refuses before it spends anything.
 * `undefined` is not a hole: it means nothing nested may ask a human at all.
 */
export function assertRestrictedGate(gate: WorkbenchHumanGate | undefined, restriction: GateRestrictionId): void {
	if (gate && !(BRANDS[restriction] in gate)) throw new UnrestrictedGateError(restriction);
}

/**
 * The base gate for a run nobody is sitting at — `ahde improve` and `ahde
 * search` on a terminal that has already authorized the whole operation on the
 * command line. Invariant 16: a non-interactive call fails closed, so anything
 * that still asks a question gets a no rather than a silent yes.
 */
export function unattendedGate(): WorkbenchHumanGate {
	return {
		async confirm() {
			return { approved: false };
		},
		async selectSealed() {
			return { approved: false };
		},
	};
}
