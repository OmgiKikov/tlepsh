import { t } from "../i18n.js";
import { runCurrentKind, type RunCurrentResolution } from "./run-resolution.js";
import {
	UNBLOCKING_ACTION,
	workbenchDecisionStages,
	workbenchGateClass,
	workshopBasisForStage,
	type WorkshopBasis,
} from "./transition-policy.js";
import type {
	WorkbenchDecisionInput,
	WorkbenchStage,
	WorkbenchSubmitInput,
	WorkbenchView,
} from "./types.js";

/**
 * What the model may do here, computed at the moment it reads a result instead
 * of memorised from a prompt. Every entry is derived from the tables the host
 * already enforces — `LEGAL_DECISION_STAGES`, `LEGAL_WORKSHOP_STAGES`, the
 * gate policy — so a stage rule can never drift from the persona that repeats
 * it, because the persona no longer repeats it.
 *
 * The `when` sentences below are the only new knowledge here: one line per
 * kind saying which operator moment it belongs to. They are model-facing and
 * stay English; the Builder reads English and answers in the operator's
 * language.
 */
export interface WorkbenchNextDecision {
	kind: NextDecisionKind;
	/** The default human-attention policy; a routine run may still trigger the cost guard. */
	asks: boolean;
	when: string;
}

export interface WorkbenchNextSubmission {
	kind: WorkbenchSubmitInput["kind"];
	when: string;
}

export interface WorkbenchNext {
	/** The single thing that moves this stage forward, in the operator's words. */
	unblock: string;
	/** Canonical operator wording; renderers translate this without deriving workflow again. */
	operatorNext?: { code: Parameters<typeof t>[0] };
	/** Host-derived recovery; never authority or a replacement for fresh decide. */
	recovery?:
		| { kind: "inspect-candidate"; candidateId: string }
		| { kind: "reattach-workshop"; workshopId: string }
		| { kind: "repair-integrity" }
		| { kind: "select" };
	decide: WorkbenchNextDecision[];
	submit: WorkbenchNextSubmission[];
	/** Present only where a workshop is legal; `basis` says what it is bound to. */
	workshop?: {
		basis: WorkshopBasis;
		open: boolean;
		/**
		 * A workshop a previous Builder process left on disk, when this one holds
		 * none. `{ kind: "workshop-open", workshopId }` re-attaches to exactly
		 * this one; opening a fresh workshop abandons it and everything it holds.
		 */
		recorded?: { workshopId: string; openedAt: string };
	};
}

/**
 * `talk-to-agent` and `label` are host handoffs rather than Workbench
 * decisions, so they are absent from every stage table. `talk-to-agent` needs a
 * configured Target; `label` appears only while the host's one-time offer to
 * check the judge still stands.
 */
type NextDecisionKind = WorkbenchDecisionInput["kind"] | "talk-to-agent" | "label";

/** One short sentence per decision: the operator moment it belongs to. */
const DECIDE_WHEN = {
	"run-current": "the operator says test / run / проверь; publishes what is pending on the way",
	"apply-proposal": "the operator says apply; send branch candidate/<proposal run id> and verify: { repetitions: 3 }",
	ship: "the operator says ship / выкати; review, tag, fast-forward and next cycle in one question",
	"talk-to-agent": "the operator wants to open, try, or talk to the built agent",
	label: "not a call — something to SAY: a judge has graded a run and nobody has checked it, " +
		"so offer it once in one sentence («10 минут: разметь 10 ответов, чтобы знать, можно ли верить судье») " +
		"and use the host labeling action when the operator accepts",
	regrade: "the operator disputes a verdict or you revised graders; re-scores recorded answers, no agent call",
	"generate-holdout": "no exam yet and the operator has no data to hold out; seal or draft",
	"publish-corpus": "the operator approved the cases; at candidate-verification it is the forward exit",
	"configure-evaluators": "a basket needs a simulated user, or the operator wants a different judge; " +
		"start-testing pre-fills the judge on its own",
	calibrate: "the operator wants to know how noisy the numbers are; the same revision against itself",
	"model-experiment": "the operator wants a cheaper or faster agent; compare 1–2 host-catalog alternatives against the current model on the reviewed cases, with a declared execution budget and quality tolerance",
	"accept-model": "the operator chooses a completed model experiment arm; review the exact model diff, then establish a new baseline — exploratory results do not authorize release",
	"discard-proposal": "the operator throws the prepared change away",
	"reject-candidate": "the operator rejects the checked change; the agent stays as it was",
	"abandon-candidate": "an interrupted attempt blocks the stage and the operator says drop it",
	improve: "the operator asks for automatic improvement; compare independent changes within a budget and retain the best measured candidate for final human review",
	"import-dataset": "the operator confirmed the sample cases a dataset-recipe compiled",
	"scaffold-target": "there is no agent directory yet",
	"wrap-target": "the folder already holds an agent and no manifest",
	"configure-target": "the agent still carries its placeholder id or model",
	"approve-spec": "explicit approval of the description; run-current covers it here",
	"start-testing": "explicit approve + publish + run; run-current resolves to this here",
	"run-eval": "explicit basket run; run-current resolves to this here",
	"verify-candidate": "explicit candidate check; run-current resolves to this here",
	"review-candidate": "explicit promote/reject recommendation; ship records it for you",
	"promote-candidate": "explicit tag of the checked revision; ship does this and the rest",
	"adopt-candidate": "explicit fast-forward onto the promoted revision; ship does this too",
	"continue-cycle": "explicit close of the finished cycle; ship does this too",
} as const satisfies Record<NextDecisionKind, string>;

/** One short sentence per authoring shape. Submitting never grants authority. */
const SUBMIT_WHEN = {
	"spec-draft": "the operator described the agent; structure it into an editable draft",
	"corpus-draft": "write the first Spec-bound cases, each with at least one grader",
	"corpus-revision": "change an existing draft: a case, a grader, the name, the notes",
	"corpus-import": "the operator points at imports/<file>.jsonl",
	"dataset-recipe": "any other file in imports/; read it with aspect: dataset first, import after",
	"production-failure": "the operator points at one .json/.jsonl production trace; classify it and define strict graders, then /test reviews and runs it",
	"structured-proposal": "a one-file semantic edit, or the only way to change execution policy",
	"workshop-open": "build or repair files: your only writable surface",
	"workshop-close": "the diff is finished; carry summary, validationPlan and prediction",
	"workshop-discard": "throw the open workshop away; nothing it wrote ever existed",
	select: "several artifacts match; read include: [\"selections\"] and name one",
} as const satisfies Record<WorkbenchSubmitInput["kind"], string>;

type NextView = Pick<WorkbenchView, "stage" | "counts"> &
	Partial<Pick<WorkbenchView, "target" | "shippingReadiness" | "workshopOpen" | "workshop" | "judgeCalibration" | "blockerReasons" | "guidance">>;

/**
 * The workshop a dead Builder process left open, when this one holds none.
 *
 * Only a `recorded` note qualifies: it is the one state `workshop-open` can
 * re-attach to. Without this the model saw `workshopOpen` absent, read it as
 * “no workshop”, and wrote from scratch what was already in the worktree.
 */
function reattachableWorkshop(view: NextView): { workshopId: string; openedAt: string } | null {
	if (view.workshopOpen === true) return null;
	const workshop = view.workshop;
	if (!workshop || workshop.state !== "recorded") return null;
	return { workshopId: workshop.workshopId, openedAt: workshop.openedAt };
}

function decisionLegal(kind: NextDecisionKind, view: NextView, resolution?: RunCurrentResolution): boolean {
	if (resolution?.status === "blocked" && resolution.code === "integrity") return false;
	if (resolution?.status === "blocked" && (kind === "run-current" ||
		(resolution.code === "interrupted-candidate" && ["verify-candidate", "ship"].includes(kind)))) return false;
	// The one decision with no stage table: the host refuses it until the
	// Target is created and configured.
	if (kind === "talk-to-agent") return view.target?.status === "ready";
	// Offered while the host's one-time offer stands and the labels it asked for
	// are not written yet. Ten is a prompt threshold, never a gate.
	if (kind === "label") return view.judgeCalibration?.offered === true;
	if (kind === "run-current") {
		return resolution ? resolution.status === "ready" : runCurrentKind(view.stage) !== null;
	}
	if (!workbenchDecisionStages(kind).includes(view.stage)) return false;
	// Legal at six stages, worth offering at none of them but the one where the
	// ship gate has no exam at all. An underpowered or unavailable exam is
	// repaired, never replaced by a guess.
	if (kind === "generate-holdout") return view.shippingReadiness?.sealedHoldout === "missing";
	return true;
}

function decisionAsks(kind: NextDecisionKind, stage: WorkbenchStage, resolution?: RunCurrentResolution): boolean {
	if (kind === "talk-to-agent") return false;
	// The whole point of the exercise is that a human answers it.
	if (kind === "label") return true;
	if (kind === "run-current") {
		const resolved = resolution?.status === "ready" ? resolution.route.kind : runCurrentKind(stage);
		return resolved !== null && workbenchGateClass(resolved) !== "routine";
	}
	return workbenchGateClass(kind) !== "routine";
}

/**
 * Only two submissions carry a stage check of their own (`assertWorkshopStage`
 * guards `workshop-open` and `structured-proposal`). The rest are guarded by
 * preconditions — an approved Spec, a parent draft, an open workshop — and
 * those are exactly what is read here. `spec-draft` has no check at all.
 */
function submitLegal(kind: WorkbenchSubmitInput["kind"], view: NextView): boolean {
	switch (kind) {
		case "spec-draft":
			return true;
		case "corpus-draft":
		case "corpus-import":
		case "dataset-recipe":
			return view.counts.approvedSpecs > 0;
		case "production-failure":
			return view.counts.approvedSpecs > 0 && view.target?.status === "ready";
		case "corpus-revision":
			return view.counts.approvedSpecs > 0 && view.counts.corpusDrafts > 0;
		case "structured-proposal":
			return workshopBasisForStage(view.stage) !== null;
		case "workshop-open":
			return workshopBasisForStage(view.stage) !== null && view.workshopOpen !== true;
		case "workshop-close":
		case "workshop-discard":
			return view.workshopOpen === true;
		// The host accepts a selection at any stage; it is the whole job at
		// exactly one, and advertising it anywhere else is noise.
		case "select":
			return view.stage === "selection-required";
	}
}

/**
 * The one sentence that is not fixed: after a restart `workshop-open` is not a
 * blank surface but the exact workshop still on disk, and it carries the id
 * that re-attaches to it.
 */
function submitWhen(kind: WorkbenchSubmitInput["kind"], view: NextView): string {
	if (kind === "workshop-open") {
		const recorded = reattachableWorkshop(view);
		if (recorded) {
			return "a workshop you opened before is still on disk with everything you wrote in it — " +
				`continue there with workshopId: "${recorded.workshopId}" instead of writing it again; ` +
				"opening a new one abandons it";
		}
	}
	return SUBMIT_WHEN[kind];
}

/** The legal moves at this exact moment, for the model-facing projection. */
export function workbenchNext(view: NextView, resolution?: RunCurrentResolution): WorkbenchNext {
	if (view.guidance && !resolution) return view.guidance;
	const basis = workshopBasisForStage(view.stage);
	const recorded = reattachableWorkshop(view);
	const integrity = view.blockerReasons?.some((reason) => reason.code === "blocker.integrity") ||
		(resolution?.status === "blocked" && resolution.code === "integrity");
	const interrupted = resolution?.status === "blocked" && resolution.code === "interrupted-candidate" ? resolution : null;
	const modelRequired = view.stage === "target-setup" && view.blockerReasons?.some((reason) =>
		reason.code === "blocker.target-placeholder" || reason.code === "blocker.target-stand-ins");
	let code: Parameters<typeof t>[0] = `next.${view.stage}`;
	let unblock = UNBLOCKING_ACTION[view.stage];
	let recovery: WorkbenchNext["recovery"];
	if (integrity) {
		code = "blocker.integrity";
		unblock = "inspect and restore artifact integrity before making a decision";
		recovery = { kind: "repair-integrity" };
	} else if (view.stage === "selection-required") {
		recovery = { kind: "select" };
	} else if (interrupted) {
		code = "next.interrupted";
		unblock = `inspect candidate ${interrupted.candidateId}, then explicitly abandon the interrupted attempt before retrying`;
		recovery = { kind: "inspect-candidate", candidateId: interrupted.candidateId };
	} else if (modelRequired) {
		code = "next.model-required";
		unblock = "choose the agent's model before authoring evidence";
	} else if (recorded) {
		code = "workshop.recorded";
		unblock = `continue the recorded workshop with workshopId: "${recorded.workshopId}"`;
		recovery = { kind: "reattach-workshop", workshopId: recorded.workshopId };
	}
	return {
		unblock,
		operatorNext: { code },
		...(recovery ? { recovery } : {}),
		decide: (Object.keys(DECIDE_WHEN) as NextDecisionKind[])
			.filter((kind) => decisionLegal(kind, view, resolution))
			.map((kind) => ({ kind, asks: decisionAsks(kind, view.stage, resolution), when: DECIDE_WHEN[kind] })),
		submit: (Object.keys(SUBMIT_WHEN) as WorkbenchSubmitInput["kind"][])
			.filter((kind) => !integrity && submitLegal(kind, view))
			.map((kind) => ({ kind, when: submitWhen(kind, view) })),
		...(basis
			? { workshop: { basis, open: view.workshopOpen === true, ...(recorded ? { recorded } : {}) } }
			: {}),
	};
}

/** Compact, credential-free current context for a host-injected Builder turn. */
export function workbenchGuidanceContext(view: WorkbenchView): string {
	return JSON.stringify({ stage: view.stage, focus: view.focus, next: workbenchNext(view), warnings: view.warnings.slice(0, 3) });
}
