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
	"spec-design": "Describe the agent; the Builder drafts a Spec",
	"spec-review": "Review the Spec (/review), then /approve or ask for changes",
	"corpus-design": "Ask the Builder to draft evaluation cases",
	"corpus-review": "Review the cases (/review), then /publish",
	"ready-to-evaluate": "/run to evaluate the Target",
	"improvement-authoring": "/traces, then say “fix the first problem”",
	"proposal-review": "/review the diff, then /apply <branch> or /discard",
	"candidate-verification": "/run to verify the candidate against the baseline",
	"candidate-review": "/review the evidence, then say “promote” or “reject”",
	"release-decision": "/promote <version> or /reject",
	"candidate-adoption": "/adopt to make the promoted candidate the active Target",
	complete: "/next to start the next improvement cycle",
	"selection-required": "Select the artifact to continue with",
};

export function stageLabel(stage: WorkbenchStage): string {
	return STAGE_LABELS[stage] ?? stage;
}

/** One actionable sentence for the header and status; blockers win over hints. */
export function nextStep(view: Pick<WorkbenchView, "stage" | "headline" | "blockers" | "detail">): string {
	if (view.stage === "selection-required") return view.headline;
	if (view.stage === "candidate-verification" && view.detail?.aspect === "review" && view.detail.content.kind === "interrupted-candidate") {
		return "/review the interrupted attempt, then /discard to abandon it before retrying";
	}
	if (view.stage === "target-setup" && view.blockers.some((blocker) => /placeholder/i.test(blocker))) {
		return "Tell the Builder which model the agent should use";
	}
	return NEXT_HINTS[view.stage] ?? view.headline;
}
