// One family of Workbench decisions, moved out of `AhdeWorkbench.decide()`
// unchanged: the gate, the stale check and the receipts are still the
// workbench's own; these functions only hold the branch bodies.
import { t } from "../../i18n.js";
import { candidateStatus } from "../../domain/candidate.js";
import { hashValue } from "../../provenance.js";
import { clearWorkbenchFocus, loadWorkbenchFocus, saveWorkbenchFocus } from "../focus.js";
import { WorkbenchStaleDecisionError } from "../errors.js";
import { candidateSummary, requireCandidate } from "../resolution.js";
import { requireOpenTerminalCandidate, actorId, exactSame } from "../workbench.js";
import type { DecisionContext, DecisionHost, DecisionInputOf } from "./shared.js";
import type { WorkbenchDecisionResult } from "../types.js";

export async function decideReviewCandidate(
	host: DecisionHost,
	input: DecisionInputOf<"review-candidate">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, gate, options } = ctx;
	const candidate = requireCandidate(inventory, ["evaluated"], input.candidateId);
	const proposal = input.recommendation === "promote" ? host.candidateProposal(candidate) : null;
	const before = { operation: "review-candidate", candidateHash: hashValue(candidate), candidate: host.candidateView(candidate, inventory.developmentEvals), proposal, recommendation: input.recommendation };
	const actor = await host.confirm(input, gate, t("confirm.title.review-candidate"), before, options.signal);
	const current = host.decisionInventory(input.kind);
	const after = requireCandidate(current, ["evaluated"], candidate.candidateId);
	if (hashValue(after) !== hashValue(candidate)) throw new WorkbenchStaleDecisionError(input.kind);
	const reviewed = host.dependencies.reviewCandidate({ runsRoot: host.runsRoot, candidateId: candidate.candidateId, expectedCandidateHash: before.candidateHash, ...(proposal ? { expectedProposalHash: proposal.proposalHash } : {}), recommendation: input.recommendation, reason: input.reason, actorId: actor, now: host.dependencies.now });
	const settled = host.select("candidate", reviewed.candidateId);
	return { kind: input.kind, message: t("message.review-recorded"), result: candidateSummary(reviewed), view: await host.viewOf(settled) };
}

export async function decidePromoteCandidate(
	host: DecisionHost,
	input: DecisionInputOf<"promote-candidate">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, gate, options } = ctx;
	const candidate = requireCandidate(inventory, ["reviewed"], input.candidateId);
	const before = { operation: "promote-candidate", candidateHash: hashValue(candidate), candidate: host.candidateView(candidate, inventory.developmentEvals), version: input.version, tag: `v${input.version}` };
	const actor = await host.confirm(input, gate, t("confirm.title.promote-candidate"), before, options.signal);
	const current = host.decisionInventory(input.kind);
	if (hashValue(requireCandidate(current, ["reviewed"], candidate.candidateId)) !== hashValue(candidate)) throw new WorkbenchStaleDecisionError(input.kind);
	const promoted = host.dependencies.promoteCandidate({ repositoryDir: host.projectDir, runsRoot: host.runsRoot, stateRoot: host.stateRoot, candidateId: candidate.candidateId, expectedCandidateHash: before.candidateHash, version: input.version, reason: input.reason, actorId: actor, now: host.dependencies.now });
	// The promotion is written. Pinning what it fixed comes after, and its
	// failure is a warning: a bookkeeping step never un-ships a release.
	const guards = host.promotionGuards(promoted.record, promoted.tag);
	const settled = host.select("candidate", promoted.record.candidateId);
	return {
		kind: input.kind,
		message: [
			`Candidate promoted as ${promoted.tag}. Adopt it to make it the active Target.`,
			...(guards.cases > 0
				? [`${guards.cases} case(s) that flipped fail→pass are drafted as regression guards in ${guards.draftId}; publish that draft to pin them.`]
				: []),
			...(guards.warning ? [guards.warning] : []),
		].join(" "),
		result: { candidate: candidateSummary(promoted.record), tag: promoted.tag, candidateSha: promoted.candidateSha, guards },
		view: await host.viewOf(settled),
	};
}

export async function decideRejectCandidate(
	host: DecisionHost,
	input: DecisionInputOf<"reject-candidate">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, stage, gate, options } = ctx;
	// Rejecting is legal where the operator reads the evidence, not only one
	// step later: at `candidate-review` the review is recorded first, after
	// the same single question, so "reject" never bounces off a stage rule.
	const candidate = requireCandidate(inventory, ["evaluated", "reviewed"], input.candidateId);
	const needsReview = candidateStatus(candidate) === "evaluated";
	const before = { operation: "reject-candidate", candidateHash: hashValue(candidate), candidate: host.candidateView(candidate, inventory.developmentEvals) };
	const actor = await host.confirm(input, gate, t("confirm.title.reject-candidate"), before, options.signal, {
		question: t("confirm.reject-candidate"),
	});
	const current = host.decisionInventory(input.kind);
	if (hashValue(requireCandidate(current, ["evaluated", "reviewed"], candidate.candidateId)) !== hashValue(candidate)) throw new WorkbenchStaleDecisionError(input.kind);
	const reviewedRecord = needsReview
		? host.dependencies.reviewCandidate({ runsRoot: host.runsRoot, candidateId: candidate.candidateId, expectedCandidateHash: before.candidateHash, recommendation: "reject", reason: input.reason, actorId: actor, now: host.dependencies.now })
		: candidate;
	const rejected = host.dependencies.rejectCandidate({ runsRoot: host.runsRoot, candidateId: candidate.candidateId, expectedCandidateHash: hashValue(reviewedRecord), reason: input.reason, actorId: actor, now: host.dependencies.now });
	const settled = host.select("candidate", rejected.candidateId);
	return { kind: input.kind, message: t("message.candidate-rejected"), result: candidateSummary(rejected), view: await host.viewOf(settled) };
}

export async function decideAdoptCandidate(
	host: DecisionHost,
	input: DecisionInputOf<"adopt-candidate">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, gate, options } = ctx;
	const candidate = requireOpenTerminalCandidate(inventory, input.candidateId);
	if (candidateStatus(candidate) !== "promoted") throw new Error("only a promoted candidate can be adopted");
	if (inventory.adoptedCandidates.has(candidate.candidateId)) throw new WorkbenchStaleDecisionError(input.kind);
	const describe = () => host.dependencies.describeTargetAdoption({
		repositoryDir: host.projectDir,
		runsRoot: host.runsRoot,
		candidateId: candidate.candidateId,
	});
	const before = describe();
	const actor = await host.confirm(
		input,
		gate,
		"Adopt promoted candidate as the active Target",
		{ operation: "adopt-candidate", candidateHash: hashValue(candidate), candidate: candidateSummary(candidate), adoption: before },
		options.signal,
	);
	const current = host.decisionInventory(input.kind);
	if (current.adoptedCandidates.has(candidate.candidateId)) throw new WorkbenchStaleDecisionError(input.kind);
	if (hashValue(requireOpenTerminalCandidate(current, candidate.candidateId)) !== hashValue(candidate)) throw new WorkbenchStaleDecisionError(input.kind);
	const after = describe();
	if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
	const result = host.dependencies.adoptTargetCandidate({
		repositoryDir: host.projectDir,
		runsRoot: host.runsRoot,
		stateRoot: host.stateRoot,
		candidateId: candidate.candidateId,
		expectedSubjectHash: after.subjectHash,
		actor: { kind: "human", id: actor },
		reason: input.reason,
	}, { now: host.dependencies.now });
	const settled = host.select("candidate", candidate.candidateId);
	return {
		kind: input.kind,
		message: `Branch ${result.subject.branch.name} now points at the promoted candidate ${result.subject.promotion.tag}. Start the next cycle when ready.`,
		result: {
			candidate: candidateSummary(candidate),
			disposition: result.disposition,
			branch: result.subject.branch.name,
			fromSha: result.receipt.previousHead,
			toSha: result.receipt.adoptedHead,
			tag: result.subject.promotion.tag,
			receiptId: result.receipt.receiptId,
		},
		view: await host.viewOf(settled),
	};
}

export async function decideContinueCycle(
	host: DecisionHost,
	input: DecisionInputOf<"continue-cycle">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, stage, gate, options } = ctx;
	const candidate = requireOpenTerminalCandidate(inventory, input.candidateId);
	if (inventory.continuedCandidates.has(candidate.candidateId)) throw new WorkbenchStaleDecisionError(input.kind);
	if (!inventory.target) throw new Error("continuing the improvement cycle requires one exact Target");
	const continuationOptions = {
		repositoryDir: host.projectDir,
		runsRoot: host.runsRoot,
		stateRoot: host.stateRoot,
		projectId: host.projectId,
		targetId: inventory.target.manifest.id,
		candidateId: candidate.candidateId,
	};
	const before = host.dependencies.describeCycleContinuation(continuationOptions);
	const actor = await host.confirm(
		input,
		gate,
		"Close this improvement cycle and continue",
		{ operation: "continue-cycle", candidateHash: hashValue(candidate), candidate: candidateSummary(candidate), continuation: before },
		options.signal,
	);
	const current = host.decisionInventory(input.kind);
	if (current.continuedCandidates.has(candidate.candidateId)) throw new WorkbenchStaleDecisionError(input.kind);
	if (hashValue(requireOpenTerminalCandidate(current, candidate.candidateId)) !== hashValue(candidate)) throw new WorkbenchStaleDecisionError(input.kind);
	const after = host.dependencies.describeCycleContinuation(continuationOptions);
	if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
	const result = host.dependencies.recordCycleContinuation({
		...continuationOptions,
		expectedSubjectHash: after.subjectHash,
		actor: { kind: "human", id: actor },
		reason: input.reason,
	}, { now: host.dependencies.now });
	// Release the closed candidate from focus so the next stage derives from artifacts alone.
	saveWorkbenchFocus(
		host.stateRoot,
		clearWorkbenchFocus(
			loadWorkbenchFocus(host.stateRoot, host.projectId, host.dependencies.now),
			"candidate",
			host.dependencies.now,
		),
	);
	const view = await host.view();
	return {
		kind: input.kind,
		message: `Improvement cycle closed. The Workbench continues at ${view.stage}: ${view.headline}`,
		result: {
			candidate: candidateSummary(candidate),
			disposition: result.disposition,
			activeTargetSha: result.subject.activeTargetSha,
			receiptId: result.receipt.receiptId,
			nextStage: view.stage,
		},
		view,
	};
}
