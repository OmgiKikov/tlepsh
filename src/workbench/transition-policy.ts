import { isSealedEvalRun, listEvalRunIndexesLenient, loadRun } from "../eval.js";
import type { WorkbenchDecisionInput, WorkbenchStage } from "./types.js";

type DirectDecisionKind = Exclude<WorkbenchDecisionInput["kind"], "run-current">;

const LEGAL_DECISION_STAGES = {
	"scaffold-target": ["target-setup"],
	"configure-target": ["target-setup"],
	"approve-spec": ["spec-review"],
	"publish-corpus": ["corpus-review"],
	// A dataset may become the first basket or replace one already drafted.
	"import-dataset": ["corpus-design", "corpus-review"],
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
	// The autoloop is measurement too: many runs, one estimate covering the
	// whole planned loop, and not one decision that creates release authority.
	improve: "routine",
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
			costUsd += run.metrics.costUsd + (run.metrics.judge?.costUsd ?? 0);
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

/** Why a routine decision still asks once, or null when it runs silently. */
export function routineCostGuard(
	estimate: WorkbenchRunEstimate,
	environment: Record<string, string | undefined> = process.env,
): string | null {
	const bounds = routineCostBounds(environment);
	if (estimate.executions === 0) return null;
	if (estimate.sampledRuns === 0 || estimate.costUsd === null || estimate.minutes === null) {
		return `no comparable run has finished yet, so ${estimate.executions} Target execution` +
			`${estimate.executions === 1 ? "" : "s"} cost an unknown amount`;
	}
	if (estimate.costUsd > bounds.costUsd) {
		return `about $${estimate.costUsd.toFixed(2)} — over the $${bounds.costUsd} routine bound (AHDE_ROUTINE_COST_USD)`;
	}
	if (estimate.minutes > bounds.minutes) {
		return `about ${Math.ceil(estimate.minutes)} minutes — over the ${bounds.minutes}-minute routine bound (AHDE_ROUTINE_MINUTES)`;
	}
	return null;
}
