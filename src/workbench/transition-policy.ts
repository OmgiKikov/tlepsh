import type { WorkbenchDecisionInput, WorkbenchStage } from "./types.js";

type DirectDecisionKind = Exclude<WorkbenchDecisionInput["kind"], "run-current">;

const LEGAL_DECISION_STAGES = {
	"scaffold-target": ["target-setup"],
	"configure-target": ["target-setup"],
	"approve-spec": ["spec-review"],
	"publish-corpus": ["corpus-review"],
	"run-eval": ["ready-to-evaluate", "improvement-authoring"],
	calibrate: ["ready-to-evaluate", "improvement-authoring"],
	"apply-proposal": ["proposal-review"],
	"discard-proposal": ["proposal-review"],
	"verify-candidate": ["candidate-verification"],
	"abandon-candidate": ["candidate-verification"],
	"review-candidate": ["candidate-review"],
	"promote-candidate": ["release-decision"],
	"reject-candidate": ["release-decision"],
	"adopt-candidate": ["candidate-adoption"],
	"continue-cycle": ["complete"],
} as const satisfies Record<DirectDecisionKind, readonly WorkbenchStage[]>;

/** One exhaustive transition boundary for every consequential Workbench decision. */
export function assertWorkbenchDecisionStage(
	kind: DirectDecisionKind,
	stage: WorkbenchStage,
): void {
	const legal = LEGAL_DECISION_STAGES[kind] as readonly WorkbenchStage[];
	if (!legal.includes(stage)) {
		throw new Error(`${kind} is not legal during ${stage}; expected ${legal.join(" or ")}`);
	}
}
