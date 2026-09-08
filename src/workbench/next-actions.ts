import { t } from "../i18n.js";
import { runCurrentKind, type RunCurrentResolution } from "./run-resolution.js";
import {
	UNBLOCKING_ACTION,
	workbenchDecisionStages,
	workbenchGateClass,
	workshopBasisForStage,
	type WorkshopBasis,
} from "./transition-policy.js";
import type { ImprovementBrief } from "../application/improvement-brief.js";
import type {
	WorkbenchDecisionInput,
	WorkbenchDiagnosisReading,
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
	"apply-proposal": "the operator says apply; send branch candidate/<proposal run id> and verify: { repetitions: 3 }; " +
		"while target.built is false a construction diff is the agent's first build and lands as the working version — no candidate, no verification, tests next",
	ship: "the operator says ship / выкати; for a checked change the sealed exam first, then review, tag, fast-forward and next cycle in one question",
	"talk-to-agent": "the operator wants to open, try, or talk to the built agent",
	label: "not a call — something to SAY: a judge has graded a run and nobody has checked it, " +
		"so offer it once in one sentence («10 минут: разметь 10 ответов, чтобы знать, можно ли верить судье») " +
		"and use the host labeling action when the operator accepts",
	regrade: "the operator disputes a verdict or you revised graders; re-scores recorded answers, no agent call",
	"critique-corpus": "the judge reads every case for validity — solvable from its source, world and tools, unambiguous criteria, checks that match the source — " +
		"never for how the agent scored; run it on a new draft before publishing, and on the published basket when a case fails every time",
	"generate-holdout": "no exam yet and the operator has no data to hold out; seal or draft",
	"publish-corpus": "the operator approved the cases; at candidate-verification it is the forward exit",
	"configure-evaluators": "a basket needs a simulated user, or the operator wants a different judge; " +
		"start-testing pre-fills the judge on its own",
	calibrate: "the operator wants to know how noisy the numbers are; the same revision against itself",
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
	"verify-candidate": "explicit check of the applied change on the development basket; run-current resolves to this here; the exam waits for ship",
	"review-candidate": "explicit promote/reject recommendation; ship records it for you",
	"promote-candidate": "explicit tag of the checked revision; ship does this and the rest",
	"adopt-candidate": "explicit fast-forward onto the promoted revision; ship does this too",
	"continue-cycle": "explicit close of the finished cycle; ship does this too",
} as const satisfies Record<NextDecisionKind, string>;

/** One short sentence per authoring shape. Submitting never grants authority. */
const SUBMIT_WHEN = {
	"spec-draft": "the operator described the agent; structure it into an editable draft",
	"corpus-draft": "write the first Spec-bound cases; decide the checks and the reference BEFORE the request text, " +
		"label every case with coverage (a Spec job verbatim × difficulty: direct, clarify, tool, policy-trap, out-of-scope, no-answer), " +
		"cite source on every case (kb with path+sha256, spec, import with path+sha256+row, feedback with at), " +
		"pair every must-happen with a must-not (output_excludes is the must-not, and the whole check for a trap), " +
		"and score a simulatedUser case by an outcome (world.expect or a deterministic grader)",
	"corpus-revision": "change an existing draft: a case, a grader, the name, the notes; " +
		"fill the empty coverage cells next names, keep coverage and source on every case you add or replace, " +
		"and remove only with a reason that says why the TEST is invalid — a case the agent fails is capability work, never an exclusion",
	"corpus-import": "the operator points at imports/<file>.jsonl",
	"dataset-recipe": "any other file in imports/; read it with aspect: dataset first, import after",
	"production-failure": "the operator points at one .json/.jsonl production trace; classify it and define strict graders, then /test reviews and runs it",
	"structured-proposal": "a one-file semantic edit, or the only way to change execution policy",
	"workshop-open": "build or repair files: your only writable surface; while target.built is false, open it FIRST and write the agent from the approved Spec before any test is written",
	"workshop-close": "the diff is finished; carry summary, validationPlan and prediction",
	"workshop-discard": "throw the open workshop away; nothing it wrote ever existed",
	select: "several artifacts match; read include: [\"selections\"] and name one",
} as const satisfies Record<WorkbenchSubmitInput["kind"], string>;

type NextView = Pick<WorkbenchView, "stage" | "counts"> &
	Partial<Pick<WorkbenchView, "target" | "shippingReadiness" | "workshop" | "judgeCalibration" | "blockerReasons" | "guidance" | "diagnosis" | "checkedChange">>;

/**
 * The view's reading of one improvement brief: proposable, or the one thing
 * in the way. Pure, so the host and a test read the same brief the same way.
 *
 * The order matters. Nothing failed and infrastructure errors are facts about
 * the run; after those, a judge that declined to decide is the instrument the
 * operator has to repair before noise can even be measured (live session 10:
 * six abstentions, and the mode they dragged below the reproduction floor read
 * as "instability").
 */
export function diagnosisReadingOf(
	brief: Pick<ImprovementBrief, "evalRunId" | "status" | "proposalEligible">,
	judgeAbstained: number,
): WorkbenchDiagnosisReading {
	const obstacle: WorkbenchDiagnosisReading["obstacle"] = brief.proposalEligible
		? null
		: brief.status === "healthy"
			? "nothing-failed"
			: brief.status === "inconclusive"
				? "errored"
				: judgeAbstained > 0
					? "judge-abstained"
					: "unstable";
	return { evalRunId: brief.evalRunId, proposable: brief.proposalEligible, obstacle, judgeAbstained };
}

/** An improvement stage whose diagnosis names nothing a harness change can answer. */
function evidenceBlocked(view: NextView): boolean {
	return workshopBasisForStage(view.stage) === "improvement" && view.diagnosis?.proposable === false;
}

/** The move that replaces the workshop, one sentence per obstacle, for the model. */
const OBSTACLE_UNBLOCK: Record<NonNullable<WorkbenchDiagnosisReading["obstacle"]>, (judgeAbstained: number) => string> = {
	"judge-abstained": (judgeAbstained) =>
		`the judge could not decide ${judgeAbstained} verdict(s): it was asked about rules it cannot see. ` +
		"Revise those judge assertions in a corpus-revision (grader.update or set-graders) so each is answerable from the reply text alone, " +
		"then decide { kind: \"regrade\", graders: \"draft\" } — the recorded answers are re-scored, no agent call. " +
		"Not a workshop: no harness change answers a verdict the judge never gave",
	unstable: () =>
		"no failure reproduces often enough to blame the harness: decide { kind: \"calibrate\" } to measure the noise, " +
		"or run again with more repetitions; a workshop is refused until a mode is selectableForProposal",
	errored: () =>
		"the run ended in infrastructure errors, which are not evidence: repair the model, sandbox or timeout path, then run again",
	"nothing-failed": () =>
		"every case passed, so there is nothing to fix: add harder cases with a corpus-revision, or supply the exam so a later change can be checked",
};

/**
 * The workshop a dead Builder process left open, when this one holds none.
 *
 * Only a `recorded` note qualifies: it is the one state `workshop-open` can
 * re-attach to. Without this the model saw no live workshop, read it as
 * “no workshop”, and wrote from scratch what was already in the worktree.
 */
function reattachableWorkshop(view: NextView): { workshopId: string; openedAt: string } | null {
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
	// Shipping and rejecting at `candidate-verification` are about a check that
	// has run; before one exists there is nothing to ship or to reject.
	if (view.stage === "candidate-verification" && (kind === "ship" || kind === "reject-candidate")) {
		return view.checkedChange !== undefined;
	}
	// Legal at six stages, worth offering at none of them but the one where the
	// ship gate has no exam at all. An underpowered or unavailable exam is
	// repaired, never replaced by a guess.
	if (kind === "generate-holdout") return view.shippingReadiness?.sealedHoldout === "missing";
	// The critic reads cases, so there have to be cases: a draft to read before
	// publishing, or a published basket to doubt after a case keeps failing.
	if (kind === "critique-corpus") return view.counts.corpusDrafts > 0 || view.counts.developmentCorpora > 0;
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
			return workshopBasisForStage(view.stage) !== null && !evidenceBlocked(view);
		// A recorded workshop stays re-attachable over blocked evidence: that is
		// how it gets closed or discarded, and its close refuses on its own.
		case "workshop-open":
			return workshopBasisForStage(view.stage) !== null && view.workshop?.state !== "live" &&
				(!evidenceBlocked(view) || reattachableWorkshop(view) !== null);
		case "workshop-close":
		case "workshop-discard":
			return view.workshop?.state === "live";
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
	// The agent is still the packaged template and a Spec to build it from is
	// approved: the next useful thing is the agent, not its tests. Its first
	// build lands as the working version, and the tests measure that.
	const buildRequired = basis === "construction" && view.target?.built === false;
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
	} else if (evidenceBlocked(view)) {
		// The stage still says "diagnosis"; the door it used to open led to a
		// workshop whose close was refused. Point at the instrument instead.
		const obstacle = view.diagnosis?.obstacle ?? "unstable";
		code = `next.${obstacle}`;
		unblock = OBSTACLE_UNBLOCK[obstacle](view.diagnosis?.judgeAbstained ?? 0);
	} else if (buildRequired) {
		code = "next.build-required";
		unblock = view.workshop?.state === "live"
			? "the agent is still the template: finish writing its instructions, skills and tools in the open workshop, then close it into a proposal for the operator to accept"
			: "the agent is still the template: open the construction workshop and write its instructions, skills and tools from the approved Spec; " +
				"the operator accepts that first build as the working agent, and only then write the tests";
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
			? { workshop: { basis, open: view.workshop?.state === "live", ...(recorded ? { recorded } : {}) } }
			: {}),
	};
}

/** Compact, credential-free current context for a host-injected Builder turn. */
export function workbenchGuidanceContext(view: WorkbenchView): string {
	return JSON.stringify({ stage: view.stage, focus: view.focus, next: workbenchNext(view), warnings: view.warnings.slice(0, 3) });
}
