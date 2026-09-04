// One family of Workbench decisions, moved out of `AhdeWorkbench.decide()`
// unchanged: the gate, the stale check and the receipts are still the
// workbench's own; these functions only hold the branch bodies.
import { candidateStatus } from "../../domain/candidate.js";
import { loadBuilderApplyReceipt } from "../../application/builder-proposal.js";
import { isAutomatedDevelopmentCandidate } from "../inventory.js";
import { resolveOne } from "../resolution.js";
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
	const partialCandidate = inventory.candidates.find((candidate) =>
		candidate.projectId === host.projectId &&
		["proposed", "built", "validated"].includes(candidateStatus(candidate)) &&
		!inventory.abandonedCandidates.has(candidate.candidateId),
	);
	if (partialCandidate) {
		throw new Error(
			`candidate ${partialCandidate.candidateId} stopped at ${candidateStatus(partialCandidate)}; ` +
			"review and explicitly abandon or recover it before starting another run",
		);
	}
	const forwarded = { repetitions: input.repetitions, reason: input.reason };
	if (stage === "ready-to-evaluate" || stage === "improvement-authoring") {
		return asRunCurrent(await host.decide({ kind: "run-eval", ...forwarded }, gate, options));
	}
	if (stage === "spec-review" || stage === "corpus-review") {
		// “Run the tests” with a review still pending is not an error: the
		// composite does the pending reviews and the run behind one dialog.
		return asRunCurrent(await host.decide({ kind: "start-testing", ...forwarded }, gate, options));
	}
	if (stage === "candidate-verification") {
		const automated = inventory.candidates.filter((candidate) =>
			candidate.projectId === host.projectId && isAutomatedDevelopmentCandidate(candidate)
		);
		if (automated.length > 0) {
			const candidate = resolveOne({
				items: automated,
				focusId: inventory.validFocus.candidate?.id,
				id: (item) => item.candidateId,
				label: "automated hypothesis",
			});
			if (candidate.origin.kind !== "applied-builder") {
				throw new Error("automated hypothesis lost Builder provenance");
			}
			return asRunCurrent(await host.decide({
				kind: "verify-candidate",
				builderRunId: candidate.origin.builderRunId,
				...forwarded,
			}, gate, options));
		}
		const appliedWithoutCandidate = inventory.proposals.filter((proposal) =>
			proposal.status === "applied" &&
			loadBuilderApplyReceipt(host.runsRoot, proposal.record.runId).via !== "proposal-search" &&
			!inventory.candidates.some((candidate) =>
				candidate.origin.kind === "applied-builder" &&
				candidate.origin.builderRunId === proposal.record.runId &&
				!inventory.abandonedCandidates.has(candidate.candidateId),
			),
		);
		const proposal = resolveOne({
			items: appliedWithoutCandidate,
			focusId: inventory.validFocus.proposal?.id,
			id: (item) => item.record.runId,
			label: "applied proposal",
		});
		return asRunCurrent(
			await host.decide({ kind: "verify-candidate", builderRunId: proposal.record.runId, ...forwarded }, gate, options),
		);
	}
	// Nowhere left to resolve to. The refusal is the one the operator would have
	// got from the run itself, named after the resolution this stage was closest
	// to having, and it always throws.
	assertWorkbenchDecisionStage("run-eval", stage);
	throw new Error(`running is not possible during ${stage}`);
}
