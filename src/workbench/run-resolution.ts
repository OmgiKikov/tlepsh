import { candidateStatus } from "../domain/candidate.js";
import { isAutomatedDevelopmentCandidate, type WorkbenchInventory } from "./inventory.js";
import { requireApprovedSpec, requireDevelopmentCorpus, resolveOne } from "./resolution.js";
import { WorkbenchSelectionRequiredError } from "./errors.js";
import { workbenchDecisionStages } from "./transition-policy.js";
import type { WorkbenchStage } from "./types.js";

export type RunCurrentRoute =
	| { kind: "start-testing" }
	| { kind: "run-eval"; developmentCorpusId: string }
	| { kind: "verify-candidate"; builderRunId: string };

export type RunCurrentResolution =
	| { status: "ready"; route: RunCurrentRoute }
	| { status: "blocked"; code: "interrupted-candidate"; candidateId: string; message: string }
	| { status: "blocked"; code: "selection-required"; entity: string; choices: readonly string[]; message: string }
	| { status: "blocked"; code: "stage" | "integrity"; message: string };

/** Stage routing is shared by execution and legacy view compatibility. */
export function runCurrentKind(stage: WorkbenchStage): RunCurrentRoute["kind"] | null {
	return (["start-testing", "run-eval", "verify-candidate"] as const)
		.find((kind) => workbenchDecisionStages(kind).includes(stage)) ?? null;
}

/** Resolve once from verified inventory, before either suggesting or executing a run. */
export function resolveRunCurrent(inventory: WorkbenchInventory, stage: WorkbenchStage): RunCurrentResolution {
	if (inventory.integrityBlockers.length > 0) {
		return { status: "blocked", code: "integrity", message: "Restore artifact integrity before running." };
	}
	const partial = inventory.candidates.find((candidate) =>
		candidate.projectId === inventory.projectId &&
		["proposed", "built", "validated"].includes(candidateStatus(candidate)) &&
		!inventory.abandonedCandidates.has(candidate.candidateId));
	if (partial) {
		return {
			status: "blocked", code: "interrupted-candidate", candidateId: partial.candidateId,
			message: `candidate ${partial.candidateId} stopped at ${candidateStatus(partial)}; ` +
				"review and explicitly abandon or recover it before starting another run",
		};
	}
	try {
		switch (runCurrentKind(stage)) {
			case "start-testing": return { status: "ready", route: { kind: "start-testing" } };
			case "run-eval": {
				const approved = requireApprovedSpec(inventory);
				const corpus = requireDevelopmentCorpus(inventory, undefined, approved.id);
				return { status: "ready", route: { kind: "run-eval", developmentCorpusId: corpus.id } };
			}
			case "verify-candidate": {
				const automated = inventory.candidates.filter((candidate) =>
					candidate.projectId === inventory.projectId && isAutomatedDevelopmentCandidate(candidate) &&
					!inventory.abandonedCandidates.has(candidate.candidateId));
				if (automated.length > 0) {
					const candidate = resolveOne({ items: automated, focusId: inventory.validFocus.candidate?.id,
						id: (item) => item.candidateId, label: "automated hypothesis" });
					if (candidate.origin.kind !== "applied-builder") throw new Error("automated hypothesis lost Builder provenance");
					return { status: "ready", route: { kind: "verify-candidate", builderRunId: candidate.origin.builderRunId } };
				}
				const proposals = inventory.proposals.filter((proposal) =>
					proposal.status === "applied" && proposal.appliedVia !== "proposal-search" &&
					!inventory.candidates.some((candidate) => candidate.origin.kind === "applied-builder" &&
						candidate.origin.builderRunId === proposal.record.runId &&
						!inventory.abandonedCandidates.has(candidate.candidateId)));
				const proposal = resolveOne({ items: proposals, focusId: inventory.validFocus.proposal?.id,
					id: (item) => item.record.runId, label: "applied proposal" });
				return { status: "ready", route: { kind: "verify-candidate", builderRunId: proposal.record.runId } };
			}
			case null: return { status: "blocked", code: "stage", message: `running is not possible during ${stage}` };
		}
	} catch (error) {
		if (!(error instanceof WorkbenchSelectionRequiredError)) throw error;
		return { status: "blocked", code: "selection-required", entity: error.kind, choices: error.choices, message: error.message };
	}
}
