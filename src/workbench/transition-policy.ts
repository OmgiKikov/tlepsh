import { plural, t } from "../i18n.js";
import { isSealedEvalRun, listEvalRunIndexesLenient, loadRun } from "../eval.js";
import type { WorkbenchDecisionInput, WorkbenchStage } from "./types.js";

type DirectDecisionKind = Exclude<WorkbenchDecisionInput["kind"], "run-current">;

const LEGAL_DECISION_STAGES = {
	"scaffold-target": ["target-setup"],
	"configure-target": ["target-setup"],
	// The judge and the user model are needed the moment a basket wants a
	// judge grader or a simulated-user case — which is while the cases are
	// being written, not at first-run setup — and they can be replaced later.
	"configure-evaluators": [
		"target-setup",
		"spec-design",
		"spec-review",
		"corpus-design",
		"corpus-review",
		"ready-to-evaluate",
		"improvement-authoring",
	],
	"approve-spec": ["spec-review"],
	"publish-corpus": ["corpus-review"],
	// A dataset may become the first basket or replace one already drafted.
	"import-dataset": ["corpus-design", "corpus-review"],
	// An exam is missing until the moment it is needed, and the moment it is
	// needed is the one where the operator finds out — anywhere from writing the
	// first basket to standing in front of a candidate that cannot be checked.
	// It needs an approved Spec, which is why it starts no earlier.
	"generate-holdout": [
		"corpus-design",
		"corpus-review",
		"ready-to-evaluate",
		"improvement-authoring",
		"proposal-review",
		"candidate-verification",
	],
	// The composite that carries the operator from a reviewed draft to a running
	// evaluation. It is legal exactly where a pending review still blocks the run.
	"start-testing": ["spec-review", "corpus-review"],
	"run-eval": ["ready-to-evaluate", "improvement-authoring"],
	calibrate: ["ready-to-evaluate", "improvement-authoring"],
	// The autoloop starts wherever a measurement can start, and hands back the
	// moment a release decision is the only way forward.
	improve: ["ready-to-evaluate", "improvement-authoring"],
	"apply-proposal": ["proposal-review"],
	"discard-proposal": ["proposal-review"],
	"verify-candidate": ["candidate-verification"],
	"abandon-candidate": ["candidate-verification"],
	"review-candidate": ["candidate-review"],
	"promote-candidate": ["release-decision"],
	// The persona tells the model to reject right where the evidence is read, and
	// `/reject` already works there; `decide` records the review first.
	"reject-candidate": ["candidate-review", "release-decision"],
	"adopt-candidate": ["candidate-adoption"],
	"continue-cycle": ["complete"],
	// The composite that closes a verified candidate: review, promote, adopt,
	// continue. Legal from wherever that sequence still has a step left.
	ship: ["candidate-review", "release-decision", "candidate-adoption", "complete"],
} as const satisfies Record<DirectDecisionKind, readonly WorkbenchStage[]>;

/**
 * The single thing the operator can do right now, in their words. An illegal
 * transition names it instead of explaining the rule that blocked it.
 */
const UNBLOCKING_ACTION: Record<WorkbenchStage, string> = {
	"target-setup": "create the agent and choose its model",
	"spec-design": "describe the agent so the Builder can draft its Spec",
	"spec-review": "review the Spec draft, then say “tests”",
	"corpus-design": "ask the Builder for test cases",
	"corpus-review": "review the cases, then say “tests”",
	"ready-to-evaluate": "say “tests” to run the basket",
	"improvement-authoring": "look at the failures, then say “fix it”",
	"proposal-review": "review the diff, then say “apply” or “discard”",
	"candidate-verification": "say “check” to verify the candidate",
	"candidate-review": "read the evidence, then say “ship it”",
	"release-decision": "say “ship it” or “reject”",
	"candidate-adoption": "say “ship it” to make the promoted candidate active",
	complete: "say “next” to start the next cycle",
	"selection-required": "select the artifact to continue with",
};

/** One exhaustive transition boundary for every consequential Workbench decision. */
export function assertWorkbenchDecisionStage(
	kind: DirectDecisionKind,
	stage: WorkbenchStage,
): void {
	const legal = LEGAL_DECISION_STAGES[kind] as readonly WorkbenchStage[];
	if (!legal.includes(stage)) {
		throw new Error(
			`${kind} is not legal during ${stage}; expected ${legal.join(" or ")}. ` +
			`Do this first: ${UNBLOCKING_ACTION[stage]}.`,
		);
	}
}

export function workbenchDecisionStages(kind: DirectDecisionKind): readonly WorkbenchStage[] {
	return LEGAL_DECISION_STAGES[kind];
}

// ---------------------------------------------------------------------------
// Where a workshop is legal, and what it is bound to there.

/**
 * A workshop is opened for one of two reasons, and the stage says which:
 *
 * - **construction** — the Spec is approved and the agent has not been built
 *   yet. The operator should not have to run a knowingly-unbuilt agent to
 *   failure before they are allowed to build its tools, so a Spec-backed
 *   workshop is legal the moment there is a Spec to build against.
 * - **improvement** — a conclusive development evaluation exists and the
 *   proposal is bound to its diagnosis, exactly as before.
 */
export const LEGAL_WORKSHOP_STAGES = {
	construction: ["corpus-design", "ready-to-evaluate"],
	improvement: ["improvement-authoring"],
} as const satisfies Record<"construction" | "improvement", readonly WorkbenchStage[]>;

export type WorkshopBasis = keyof typeof LEGAL_WORKSHOP_STAGES;

/** Which kind of workshop this stage opens, or null when none is legal here. */
export function workshopBasisForStage(stage: WorkbenchStage): WorkshopBasis | null {
	for (const [basis, stages] of Object.entries(LEGAL_WORKSHOP_STAGES)) {
		if ((stages as readonly WorkbenchStage[]).includes(stage)) return basis as WorkshopBasis;
	}
	return null;
}

/** The refusal a workshop gives where it is not legal, in the operator's words. */
export function assertWorkshopStage(stage: WorkbenchStage): WorkshopBasis {
	const basis = workshopBasisForStage(stage);
	if (!basis) {
		throw new Error(
			`a workshop opens at ${[...LEGAL_WORKSHOP_STAGES.construction, ...LEGAL_WORKSHOP_STAGES.improvement].join(", ")}, not during ${stage}. ` +
			`Do this first: ${UNBLOCKING_ACTION[stage]}.`,
		);
	}
	return basis;
}

// ---------------------------------------------------------------------------
// Gate policy: which decisions are worth interrupting a human for.

/**
 * - `consequential` — the host shows the exact subject and asks. These are the
 *   decisions that create durable authority: setup, the composite that starts
 *   testing, the exact diff, and each fine-grained release decision the CLI and
 *   scripts still call one at a time.
 * - `one-question` — durable and terminal, but there is nothing to study: one
 *   short y/n.
 * - `routine` — executes immediately. The operator asking for it is the
 *   permission; a cost guard still asks before an unusually expensive run.
 */
export type WorkbenchGateClass = "consequential" | "one-question" | "routine";

export const WORKBENCH_GATE_POLICY = {
	// Consequential: one-time bootstrap of a real repository.
	"scaffold-target": "consequential",
	"configure-target": "consequential",
	// The same class as the Target's own model, for the same reason: it commits
	// a reviewed change to manifest.yaml and it decides what the evidence is
	// measured with.
	"configure-evaluators": "consequential",
	// Consequential composites and the exact diff — the three product gates.
	"start-testing": "consequential",
	"apply-proposal": "consequential",
	ship: "consequential",
	// Consequential fine-grained authority. The conversation reaches these only
	// through a composite; the CLI, scripts and tests still call them directly,
	// and each keeps its own dialog and its own receipt.
	"approve-spec": "consequential",
	"publish-corpus": "consequential",
	"import-dataset": "consequential",
	// It spends the judge's tokens and it creates the one artifact promotion is
	// measured against. Always a full dialog: the operator has to see which model
	// is about to write their exam, and that they will never read it.
	"generate-holdout": "consequential",
	"review-candidate": "consequential",
	"promote-candidate": "consequential",
	"adopt-candidate": "consequential",
	"continue-cycle": "consequential",
	// Terminal, irreversible, nothing to study: one short question.
	"discard-proposal": "one-question",
	"reject-candidate": "one-question",
	"abandon-candidate": "one-question",
	// Routine: measurement. It spends money and time, so a cost guard applies.
	"run-current": "routine",
	"run-eval": "routine",
	calibrate: "routine",
	"verify-candidate": "routine",
	// The loop measures, but it also applies exact proposals to throwaway refs.
	// Its one up-front disclosure is therefore always a real full confirmation,
	// never a routine auto-approval hidden behind the cost threshold.
	improve: "consequential",
} as const satisfies Record<WorkbenchDecisionInput["kind"], WorkbenchGateClass>;

export function workbenchGateClass(kind: WorkbenchDecisionInput["kind"]): WorkbenchGateClass {
	return WORKBENCH_GATE_POLICY[kind];
}

// ---------------------------------------------------------------------------
// Cost guard: a routine run still asks once when history says it is expensive.

/** USD above which a routine run asks once. */
export const DEFAULT_ROUTINE_COST_USD = 2;
/** Wall-clock minutes above which a routine run asks once. */
export const DEFAULT_ROUTINE_MINUTES = 10;
/** Eval runs sampled for the estimate, newest first. */
const ESTIMATE_EVAL_RUNS = 3;
/** Member runs opened in total; the estimate is a mean, not an audit. */
const ESTIMATE_RUNS = 60;

/** What one routine run is expected to cost, derived only from existing evidence. */
export interface WorkbenchRunEstimate {
	/** Planned Target executions: tasks × repetitions × arms. */
	executions: number;
	/** Completed runs the mean came from; 0 means the estimate is unknown. */
	sampledRuns: number;
	costUsd: number | null;
	minutes: number | null;
}

export interface EstimateRunCostInput {
	runsRoot: string;
	targetId: string;
	executions: number;
	/** Concurrent executions the evaluator will use; wall-clock divides by it. */
	jobs: number;
}

/**
 * Mean cost and wall-clock per Target execution over the most recent comparable
 * development evidence. Nothing is written and nothing is cached: an estimate
 * is a reading of artifacts that already exist, so it can never become evidence.
 */
export function estimateRunCost(input: EstimateRunCostInput): WorkbenchRunEstimate {
	const executions = Math.max(0, Math.trunc(input.executions));
	// Lenient, like the baseline reuse scan: one pre-V1.8 index on disk is a
	// "legacy · not comparable" row, not a reason to stop estimating and ask the
	// operator to confirm every routine measurement forever.
	let indexes: ReturnType<typeof listEvalRunIndexesLenient>["records"];
	try {
		indexes = listEvalRunIndexesLenient(input.runsRoot).records;
	} catch {
		return { executions, sampledRuns: 0, costUsd: null, minutes: null };
	}
	const comparable = indexes
		.filter((record) => record.target.id === input.targetId && !isSealedEvalRun(record))
		.slice(0, ESTIMATE_EVAL_RUNS);
	let sampled = 0;
	let costUsd = 0;
	let milliseconds = 0;
	for (const record of comparable) {
		for (const runId of record.runIds) {
			if (sampled >= ESTIMATE_RUNS) break;
			let run: ReturnType<typeof loadRun>;
			try {
				run = loadRun(input.runsRoot, runId);
			} catch {
				continue;
			}
			if (run.status !== "completed" || run.finishedAt === null) continue;
			const started = Date.parse(run.startedAt);
			const finished = Date.parse(run.finishedAt);
			const elapsed = Number.isFinite(started) && Number.isFinite(finished) && finished >= started
				? finished - started
				: run.metrics.latencyMs;
			sampled += 1;
			// Every model an evaluation pays for: the Target, the judge that graded
			// it, and the user model that talked to it. Missing one makes the guard
			// wave through a run that costs several times its estimate.
			costUsd += run.metrics.costUsd
				+ (run.metrics.judge?.costUsd ?? 0)
				+ (run.metrics.simulatedUser?.costUsd ?? 0);
			milliseconds += elapsed;
		}
	}
	if (sampled === 0) return { executions, sampledRuns: 0, costUsd: null, minutes: null };
	const jobs = Math.max(1, Math.trunc(input.jobs));
	return {
		executions,
		sampledRuns: sampled,
		costUsd: (costUsd / sampled) * executions,
		minutes: ((milliseconds / sampled) * executions) / jobs / 60_000,
	};
}

export interface RoutineCostGuardBounds {
	costUsd: number;
	minutes: number;
}

/**
 * How far a measurement may drift past the amount an earlier dialog put on
 * screen before the money question is worth asking again. An estimate is a
 * mean over past runs, so it moves a little between the apply and the check;
 * half as much again is drift, and more than that is a different decision.
 */
export const AUTHORIZED_RUN_HEADROOM = 1.5;

/** The amount one confirmation authorized, as the operator read it. */
export interface AuthorizedRunEstimate {
	costUsd: number | null;
	minutes: number | null;
}

/**
 * Whether a measurement the operator already paid the question for stays
 * inside what they approved. An authorization that was unknown when it was
 * given covers nothing: no amount was on screen, so no amount was approved.
 */
export function authorizedRunCovers(
	estimate: WorkbenchRunEstimate,
	authorization: AuthorizedRunEstimate | null | undefined,
): boolean {
	if (!authorization || authorization.costUsd === null || authorization.minutes === null) return false;
	if (estimate.costUsd === null || estimate.minutes === null) return false;
	return estimate.costUsd <= authorization.costUsd * AUTHORIZED_RUN_HEADROOM &&
		estimate.minutes <= authorization.minutes * AUTHORIZED_RUN_HEADROOM;
}

/** `AHDE_ROUTINE_COST_USD` / `AHDE_ROUTINE_MINUTES`, or the defaults. */
export function routineCostBounds(
	environment: Record<string, string | undefined> = process.env,
): RoutineCostGuardBounds {
	const bound = (raw: string | undefined, fallback: number): number => {
		const text = (raw ?? "").trim();
		if (text === "") return fallback;
		const value = Number(text);
		return Number.isFinite(value) && value >= 0 ? value : fallback;
	};
	return {
		costUsd: bound(environment.AHDE_ROUTINE_COST_USD, DEFAULT_ROUTINE_COST_USD),
		minutes: bound(environment.AHDE_ROUTINE_MINUTES, DEFAULT_ROUTINE_MINUTES),
	};
}

/**
 * Why a routine decision still asks once, or null when it runs silently.
 *
 * `authorization` is what an earlier consequential dialog already showed and
 * the operator already approved for this exact measurement — the money
 * question is asked once per cycle, not once per run.
 */
export function routineCostGuard(
	estimate: WorkbenchRunEstimate,
	environment: Record<string, string | undefined> = process.env,
	authorization?: AuthorizedRunEstimate | null,
): string | null {
	const bounds = routineCostBounds(environment);
	if (estimate.executions === 0) return null;
	if (authorizedRunCovers(estimate, authorization)) return null;
	if (estimate.sampledRuns === 0 || estimate.costUsd === null || estimate.minutes === null) {
		return t("guard.unknown-cost", { runs: plural(estimate.executions, "execution") });
	}
	if (estimate.costUsd > bounds.costUsd) {
		return t("guard.over-cost", { cost: estimate.costUsd.toFixed(2), bound: bounds.costUsd });
	}
	if (estimate.minutes > bounds.minutes) {
		return t("guard.over-minutes", { minutes: Math.ceil(estimate.minutes), bound: bounds.minutes });
	}
	return null;
}
