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

/** The stage name in the operator's language, read at call time so it follows the resolved language. */
export function stageLabel(stage: WorkbenchStage): string {
	return t(`stage.${stage}`);
}

/**
 * The stage as the operator lives it. The artifacts say “eval design” the
 * moment a Spec is approved, but while the agent is still the packaged
 * template the work of that moment is building it, and the header says so.
 */
export function buildRequired(view: Pick<WorkbenchView, "stage"> & Partial<Pick<WorkbenchView, "target">>): boolean {
	return view.target?.built === false && (view.stage === "corpus-design" || view.stage === "ready-to-evaluate");
}

export function stageLabelOf(view: Pick<WorkbenchView, "stage"> & Partial<Pick<WorkbenchView, "target">>): string {
	return buildRequired(view) ? t("stage.build") : stageLabel(view.stage);
}

/**
 * What to say next at one stage, without a whole view to read it from. The
 * Workbench headline is the model's English sentence about the same stage; it
 * is only the fallback for a stage this host does not know.
 */
export function stageNextStep(stage: WorkbenchStage, fallback: string): string {
	return STAGES.includes(stage) ? t(`next.${stage}`) : fallback;
}

/**
 * Whether the Target is still on somebody else's name and model.
 *
 * Read from the blocker CODES, never from the sentences: those bend with the
 * language now, and an English regex over a Russian blocker matched nothing.
 * The regex stays for a view minted before the codes existed, and for one
 * built by hand in a test.
 */
function standInBlocker(view: Partial<Pick<WorkbenchView, "blockers" | "blockerReasons">>): boolean {
	const reasons = view.blockerReasons;
	if (reasons) {
		return reasons.some((reason) =>
			reason.code === "blocker.target-placeholder" || reason.code === "blocker.target-stand-ins");
	}
	return (view.blockers ?? []).some((blocker) => /placeholder|stand-in/i.test(blocker));
}

/** One actionable sentence for the header and status; blockers win over hints. */
export function nextStep(
	view: Pick<WorkbenchView, "stage" | "headline" | "blockers" | "detail"> & Partial<Pick<WorkbenchView, "blockerReasons" | "guidance" | "target" | "checkedChange">>,
): string {
	if (view.guidance?.operatorNext) return t(view.guidance.operatorNext.code);
	if (view.stage === "selection-required") return t("next.selection-required");
	// The change is measured on the basket; what is left is the exam, and ship runs it.
	if (view.stage === "candidate-verification" && view.checkedChange) return t("next.candidate-checked");
	if (view.stage === "candidate-verification" && view.detail?.aspect === "review" && view.detail.content.kind === "interrupted-candidate") {
		return t("next.interrupted");
	}
	// Both shapes of "nobody has chosen a model yet": the built-in scaffold's
	// placeholders, and a template that still says REPLACE-ME. Either way the
	// next sentence is about the model, not about describing the agent.
	if (view.stage === "target-setup" && standInBlocker(view)) {
		return t("next.model-required");
	}
	if (buildRequired(view)) return t("next.build-required");
	return STAGES.includes(view.stage) ? t(`next.${view.stage}`) : view.headline;
}
