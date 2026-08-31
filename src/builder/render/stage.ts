import type { WorkbenchStage, WorkbenchView } from "../../workbench/types.js";

export const STAGE_LABELS: Record<WorkbenchStage, string> = {
	"target-setup": "Target setup",
	"spec-design": "Spec design",
	"spec-review": "Spec review",
	"corpus-design": "Eval design",
	"corpus-review": "Eval review",
	"ready-to-evaluate": "Ready to run",
	"improvement-authoring": "Diagnosis",
	"proposal-review": "Proposal review",
	"candidate-verification": "Candidate verification",
	"candidate-review": "Candidate review",
	"release-decision": "Release decision",
	"candidate-adoption": "Adopt candidate",
	complete: "Cycle complete",
	"selection-required": "Selection needed",
};

const NEXT_HINTS: Record<WorkbenchStage, string> = {
	"target-setup": "Describe the agent you want to build",
	"spec-design": "Describe the agent you want",
	"spec-review": "Say “ok” to approve it, or what to change",
	"corpus-design": "Say “tests” and the Builder writes the cases",
	"corpus-review": "Say “tests” to publish them and run",
	"ready-to-evaluate": "Say “tests” to run them",
	"improvement-authoring": "Say “fix the first problem”",
	"proposal-review": "Say “apply” after reading the diff, or “discard”",
	"candidate-verification": "Say “check” to verify the change",
	"candidate-review": "Say “ship it” — or “reject”",
	"release-decision": "Say “ship it 0.2.0” — or “reject”",
	"candidate-adoption": "Say “ship it” to make it the active agent",
	complete: "Say “next” to start the next cycle",
	"selection-required": "Select the artifact to continue with",
};

export function stageLabel(stage: WorkbenchStage): string {
	return STAGE_LABELS[stage] ?? stage;
}

/** One actionable sentence for the header and status; blockers win over hints. */
export function nextStep(view: Pick<WorkbenchView, "stage" | "headline" | "blockers" | "detail">): string {
	if (view.stage === "selection-required") return view.headline;
	if (view.stage === "candidate-verification" && view.detail?.aspect === "review" && view.detail.content.kind === "interrupted-candidate") {
		return "Read the interrupted attempt, then say “discard” to abandon it before retrying";
	}
	if (view.stage === "target-setup" && view.blockers.some((blocker) => /placeholder/i.test(blocker))) {
		return "Tell the Builder which model the agent should use";
	}
	return NEXT_HINTS[view.stage] ?? view.headline;
}
