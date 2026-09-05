// One family of Workbench decisions, moved out of `AhdeWorkbench.decide()`
// unchanged: the gate, the stale check and the receipts are still the
// workbench's own; these functions only hold the branch bodies.
import { resolveRunCurrent } from "../run-resolution.js";
import { WorkbenchSelectionRequiredError } from "../errors.js";
import { assertWorkbenchDecisionStage } from "../transition-policy.js";
import type { DecisionContext, DecisionHost, DecisionInputOf } from "./shared.js";
import type { WorkbenchDecisionResult } from "../types.js";

/**
 * The three decisions “run it” can mean. `run-current` has no row in
 * `LEGAL_DECISION_STAGES` by construction — `DirectDecisionKind` excludes it —
 * because it owns no stages of its own: it is legal exactly where one of these
 * three is, and each of them is checked by the common guard when `decide`
 * re-enters with the resolved kind. The stage lists are disjoint, so the first
 * match is the resolution.
 */
type RunCurrentResolution = Extract<
	WorkbenchDecisionResult,
	{ kind: "start-testing" | "run-eval" | "verify-candidate" }
>;

/**
 * The resolved decision, said as the one the operator asked for. `resolvedAs`
 * is the only thing added: the message, the result and the view are the
 * resolution's own, so nothing downstream can read two different stories about
 * the same run.
 */
function asRunCurrent(resolved: RunCurrentResolution): Extract<WorkbenchDecisionResult, { kind: "run-current" }> {
	const framed = { kind: "run-current" as const, message: resolved.message, view: resolved.view };
	switch (resolved.kind) {
		case "start-testing":
			return { ...framed, result: { resolvedAs: "start-testing", ...resolved.result } };
		case "run-eval":
			return { ...framed, result: { resolvedAs: "run-eval", ...resolved.result } };
		case "verify-candidate":
			return { ...framed, result: { resolvedAs: "verify-candidate", ...resolved.result } };
	}
}

/**
 * Whatever “run it” means where the operator is standing.
 *
 * A pending review is not an error here: the `start-testing` composite does the
 * review and the run behind one dialog. An interrupted candidate is, because
 * every resolution below would measure the wrong thing while one is half-built.
 */
export async function decideRunCurrent(
	host: DecisionHost,
	input: DecisionInputOf<"run-current">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, stage, gate, options } = ctx;
	const resolution = resolveRunCurrent(inventory, stage);
	if (resolution.status === "blocked") {
		if (resolution.code === "selection-required") throw new WorkbenchSelectionRequiredError(resolution.entity, resolution.choices);
		if (resolution.code === "stage") assertWorkbenchDecisionStage("run-eval", stage);
		throw new Error(resolution.message);
	}
	const forwarded = { repetitions: input.repetitions, reason: input.reason };
	const route = resolution.route;
	switch (route.kind) {
		case "start-testing": return asRunCurrent(await host.decide({ ...route, ...forwarded }, gate, options));
		case "run-eval": return asRunCurrent(await host.decide({ ...route, ...forwarded }, gate, options));
		case "verify-candidate": return asRunCurrent(await host.decide({ ...route, ...forwarded }, gate, options));
	}
}
