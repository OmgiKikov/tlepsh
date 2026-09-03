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
	/** True when the host puts a question to the operator before it runs. */
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
	decide: WorkbenchNextDecision[];
	submit: WorkbenchNextSubmission[];
	/** Present only where a workshop is legal; `basis` says what it is bound to. */
	workshop?: { basis: WorkshopBasis; open: boolean };
}

/**
 * `talk-to-agent` and `label` are host handoffs rather than Workbench
 * decisions, so they are absent from every stage table. `talk-to-agent` needs a
 * configured Target; `label` appears only while the host's one-time offer to
 * check the judge still stands.
 */
type NextDecisionKind = WorkbenchDecisionInput["kind"] | "talk-to-agent" | "label";

/**
 * What `run-current` resolves to, mirroring the branch in `Workbench.decide`.
 * Their stage lists are disjoint, so the first match is the resolution and its
 * gate class is the honest answer to "will the operator be asked?".
 */
const RUN_CURRENT_RESOLUTIONS = ["start-testing", "run-eval", "verify-candidate"] as const;

/** One short sentence per decision: the operator moment it belongs to. */
const DECIDE_WHEN = {
	"run-current": "the operator says test / run / проверь; publishes what is pending on the way",
	"apply-proposal": "the operator says apply; send branch candidate/<proposal run id> and verify: { repetitions: 3 }",
	ship: "the operator says ship / выкати; review, tag, fast-forward and next cycle in one question",
	"talk-to-agent": "the operator wants to open, try, or talk to the built agent",
	label: "not a call — something to SAY: a judge has graded a run and nobody has checked it, " +
		"so offer it once in one sentence («10 минут: разметь 10 ответов, чтобы знать, можно ли верить судье») " +
		"and the operator answers with /label",
	regrade: "the operator disputes a verdict or you revised graders; re-scores recorded answers, no agent call",
	"generate-holdout": "no exam yet and the operator has no data to hold out; seal or draft",
	"publish-corpus": "the operator approved the cases; at candidate-verification it is the forward exit",
	"configure-evaluators": "a basket needs a simulated user, or the operator wants a different judge; " +
		"start-testing pre-fills the judge on its own",
	calibrate: "the operator wants to know how noisy the numbers are; the same revision against itself",
	"discard-proposal": "the operator throws the prepared change away",
	"reject-candidate": "the operator rejects the checked change; the agent stays as it was",
	"abandon-candidate": "an interrupted attempt blocks the stage and the operator says drop it",
	improve: "the operator asks for the automatic loop; it stops at the first verified candidate",
	"import-dataset": "the operator confirmed the sample cases a dataset-recipe compiled",
	"scaffold-target": "there is no agent directory yet",
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
	"structured-proposal": "a one-file semantic edit, or the only way to change execution policy",
	"workshop-open": "build or repair files: your only writable surface",
	"workshop-close": "the diff is finished; carry summary, validationPlan and prediction",
	"workshop-discard": "throw the open workshop away; nothing it wrote ever existed",
	select: "several artifacts match; read include: [\"selections\"] and name one",
} as const satisfies Record<WorkbenchSubmitInput["kind"], string>;

type NextView = Pick<WorkbenchView, "stage" | "counts"> &
	Partial<Pick<WorkbenchView, "target" | "shippingReadiness" | "workshopOpen" | "judgeCalibration">>;

function decisionLegal(kind: NextDecisionKind, view: NextView): boolean {
	// The one decision with no stage table: the host refuses it until the
	// Target is created and configured.
	if (kind === "talk-to-agent") return view.target?.status === "ready";
	// Offered while the host's one-time offer stands and the labels it asked for
	// are not written yet. Ten is a prompt threshold, never a gate.
	if (kind === "label") return view.judgeCalibration?.offered === true;
	if (kind === "run-current") {
		return RUN_CURRENT_RESOLUTIONS.some((resolved) => workbenchDecisionStages(resolved).includes(view.stage));
	}
	if (!workbenchDecisionStages(kind).includes(view.stage)) return false;
	// Legal at six stages, worth offering at none of them but the one where the
	// ship gate has no exam at all. An underpowered or unavailable exam is
	// repaired, never replaced by a guess.
	if (kind === "generate-holdout") return view.shippingReadiness?.sealedHoldout === "missing";
	return true;
}

function decisionAsks(kind: NextDecisionKind, stage: WorkbenchStage): boolean {
	if (kind === "talk-to-agent") return false;
	// The whole point of the exercise is that a human answers it.
	if (kind === "label") return true;
	if (kind === "run-current") {
		const resolved = RUN_CURRENT_RESOLUTIONS.find((candidate) => workbenchDecisionStages(candidate).includes(stage));
		return resolved !== undefined && workbenchGateClass(resolved) !== "routine";
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

/** The legal moves at this exact moment, for the model-facing projection. */
export function workbenchNext(view: NextView): WorkbenchNext {
	const basis = workshopBasisForStage(view.stage);
	return {
		unblock: UNBLOCKING_ACTION[view.stage],
		decide: (Object.keys(DECIDE_WHEN) as NextDecisionKind[])
			.filter((kind) => decisionLegal(kind, view))
			.map((kind) => ({ kind, asks: decisionAsks(kind, view.stage), when: DECIDE_WHEN[kind] })),
		submit: (Object.keys(SUBMIT_WHEN) as WorkbenchSubmitInput["kind"][])
			.filter((kind) => submitLegal(kind, view))
			.map((kind) => ({ kind, when: SUBMIT_WHEN[kind] })),
		...(basis ? { workshop: { basis, open: view.workshopOpen === true } } : {}),
	};
}
