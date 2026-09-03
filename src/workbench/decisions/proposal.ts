// One family of Workbench decisions, moved out of `AhdeWorkbench.decide()`
// unchanged: the gate, the stale check and the receipts are still the
// workbench's own; these functions only hold the branch bodies.
import { t } from "../../i18n.js";
import { redactTraceText } from "../../trace.js";
import { hashValue } from "../../provenance.js";
import { blockedReasonText, typedRefusalReason, WorkbenchStaleDecisionError } from "../errors.js";
import { requireProposal, proposalReview } from "../resolution.js";
import { type WorkbenchVerificationBlocked, type WorkbenchVerifyCandidateResult, type WorkbenchDecisionResult } from "../types.js";
import { exactSame } from "../workbench.js";
import type { DecisionContext, DecisionHost, DecisionInputOf } from "./shared.js";

export async function decideApplyProposal(
	host: DecisionHost,
	input: DecisionInputOf<"apply-proposal">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, gate, options } = ctx;
	const proposal = requireProposal(inventory, ["open", "apply-pending"], input.runId);
	const before = { operation: "apply-proposal", branch: input.branch, builderRunHash: hashValue(proposal.record), ...proposalReview(proposal.record) };
	// The price of the check rides on the confirmation, not in the hashed
	// subject: it is read from finished runs and would otherwise turn a
	// concurrent run into a stale-decision refusal.
	const verification = host.verificationEstimate(proposal.record, inventory);
	const actor = await host.confirm(input, gate, t("confirm.apply-proposal.title"), before, options.signal, {
		estimate: verification,
	});
	const current = host.decisionInventory(input.kind);
	const afterProposal = requireProposal(current, ["open", "apply-pending"], proposal.record.runId);
	const after = { operation: "apply-proposal", branch: input.branch, builderRunHash: hashValue(afterProposal.record), ...proposalReview(afterProposal.record) };
	if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
	const result = host.dependencies.applyProposal({ repoDir: host.projectDir, runsRoot: host.runsRoot, runId: proposal.record.runId, expectedBuilderRunHash: after.builderRunHash, requestedBranch: input.branch, actor: { kind: "human", id: actor }, verificationAuthorization: verification, reason: input.reason });
	// A tool that was just applied has an executable contract nobody has
	// measured: whether the agent calls it, with what, and what it says when
	// it fails. Draft those cases now, while the diff is still the subject.
	const contractCases = host.draftToolContractCases(after.exactDiff);
	const settled = host.select("proposal", proposal.record.runId);
	let view = await host.viewOf(settled);
	let verified: WorkbenchVerifyCandidateResult | WorkbenchVerificationBlocked | undefined;
	if (input.verify) {
		try {
			const check = await host.decide({
				kind: "verify-candidate",
				builderRunId: proposal.record.runId,
				repetitions: input.verify.repetitions,
				...(input.verify.force !== undefined ? { force: input.verify.force } : {}),
				reason: `${input.reason} — automatic post-Apply verification`,
			}, gate, options);
			verified = check.result;
			view = check.view;
		} catch (error) {
			// Apply is already durable. A missing/declined exam or runtime failure is
			// an explicit verification blocker, never a lie that Apply rolled back.
			const reasonCode = typedRefusalReason(error);
			verified = {
				outcome: "blocked",
				reason: redactTraceText(error instanceof Error ? error.message : String(error)).slice(0, 500),
				...(reasonCode ? { reasonCode } : {}),
			};
			view = await host.viewOf(host.select("proposal", proposal.record.runId));
		}
	}
	return {
		kind: input.kind,
		message: verified === undefined
			? t("message.proposal-applied")
			: verified.outcome === "blocked"
				? t("message.proposal-applied-blocked", { reason: blockedReasonText(verified) })
				: t("message.proposal-applied-verified"),
		result: {
			runId: result.receipt.runId,
			branch: result.receipt.branch,
			candidateSha: result.receipt.candidateSha,
			proposalHash: result.receipt.proposalSha256,
			...(verified === undefined ? {} : { verification: verified }),
			...(contractCases.length > 0 ? { contractCases } : {}),
		},
		view,
	};
}

export async function decideDiscardProposal(
	host: DecisionHost,
	input: DecisionInputOf<"discard-proposal">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, gate, options } = ctx;
	const proposal = requireProposal(inventory, ["open", "discard-pending"], input.runId);
	const before = host.dependencies.describeProposalDiscard(host.runsRoot, proposal.record.runId);
	const actor = await host.confirm(input, gate, t("confirm.title.discard-proposal"), before, options.signal, {
		question: t("confirm.discard-proposal"),
	});
	const current = host.decisionInventory(input.kind);
	requireProposal(current, ["open", "discard-pending"], proposal.record.runId);
	const after = host.dependencies.describeProposalDiscard(host.runsRoot, proposal.record.runId);
	if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
	const result = host.dependencies.discardProposal({ runsRoot: host.runsRoot, runId: proposal.record.runId, actor: { kind: "human", id: actor }, reason: input.reason, expectedSubjectHash: before.subjectHash }, { now: host.dependencies.now });
	return { kind: input.kind, message: t("message.proposal-discarded"), result: { runId: result.receipt.runId, receiptHash: hashValue(result.receipt) }, view: await host.view() };
}
