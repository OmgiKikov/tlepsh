import { t } from "../../i18n.js";
import type { WorkbenchStage, WorkbenchView } from "../../workbench/types.js";

const STAGES: readonly WorkbenchStage[] = [
	"target-setup",
	"spec-design",
	"spec-review",
	"corpus-design",
	"corpus-review",
	"ready-to-evaluate",
	"improvement-authoring",
	"proposal-review",
	"candidate-verification",
	"candidate-review",
	"release-decision",
	"candidate-adoption",
	"complete",
	"selection-required",
];

/**
 * Stage names in the operator's language. Kept as a live getter rather than a
 * frozen table: the language is resolved once per process, but a table built at
 * import time would freeze it before the CLI has read its settings.
 */
export const STAGE_LABELS: Record<WorkbenchStage, string> = Object.defineProperties(
	{} as Record<WorkbenchStage, string>,
	Object.fromEntries(STAGES.map((stage) => [stage, {
		enumerable: true,
		get: () => t(`stage.${stage}`),
	}])),
);

export function stageLabel(stage: WorkbenchStage): string {
	return STAGE_LABELS[stage] ?? stage;
}

/**
 * What to say next at one stage, without a whole view to read it from. The
 * Workbench headline is the model's English sentence about the same stage; it
 * is only the fallback for a stage this host does not know.
 */
export function stageNextStep(stage: WorkbenchStage, fallback: string): string {
	return STAGES.includes(stage) ? t(`next.${stage}`) : fallback;
}

/** One actionable sentence for the header and status; blockers win over hints. */
export function nextStep(view: Pick<WorkbenchView, "stage" | "headline" | "blockers" | "detail">): string {
	if (view.stage === "selection-required") return t("next.selection-required");
	if (view.stage === "candidate-verification" && view.detail?.aspect === "review" && view.detail.content.kind === "interrupted-candidate") {
		return t("next.interrupted");
	}
	if (view.stage === "target-setup" && view.blockers.some((blocker) => /placeholder/i.test(blocker))) {
		return t("next.model-required");
	}
	return STAGES.includes(view.stage) ? t(`next.${view.stage}`) : view.headline;
}
