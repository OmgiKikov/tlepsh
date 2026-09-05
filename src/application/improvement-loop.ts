/**
 * The autoloop, inside the gates.
 *
 * One cycle is: run → diagnose → pick the top proposable failure mode →
 * author a proposal through the existing application chain → apply it on
 * `candidate/auto-<loopId>-<n>` → cheap check → full development verification if the
 * screen is promising.
 *
 * What the loop may do is exactly what the operator asked for when they said
 * "improve": measurement, and the applies it iterates on, on throwaway
 * branches that never touch the checkout (invariant 7). What it may never do
 * is create release authority. Promotion, adoption, corpus publication, Spec
 * approval, candidate review, cycle continuation and the sealed holdout are
 * the human's, and {@link improvementLoopGate} makes that structural rather
 * than a promise: the gate the loop hands to anything nested throws instead of
 * asking.
 *
 * The loop therefore never runs the sealed guardrail. A verified, improved
 * candidate is where it stops and hands back.
 */

import { randomBytes } from "node:crypto";
import type { ImprovementAuthorUsage } from "./improvement-author.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { compileFailureBundle } from "../bundle.js";
import type { CandidateProposal } from "../builders/adapters.js";
import type { CorpusRef } from "../corpus.js";
import { loadCorpus } from "../corpus.js";
import { diagnoseEvalRun } from "../diagnosis.js";
import type { GateVerdict } from "../domain/comparison-gate.js";
import { withinInfrastructureBudget } from "../domain/comparison-gate.js";
import { percent, points } from "../measurement.js";
import {
	findReusableBaseline,
	runSuite,
	type EvalRunRecord,
	type ReusableBaselineQuery,
} from "../eval.js";
import { loadTarget, type ResolvedTarget } from "../manifest.js";
import { computeTargetSnapshotHashes } from "../runner.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";
import type { RunEventListener } from "../run-events.js";
import type { WorkbenchHumanGate } from "../workbench/types.js";
import { recordBuilderAuthoredProposal } from "./builder-authoring.js";
import { runAppliedBuilderCandidate } from "./builder-candidate.js";
import {
	applyBuilderProposal,
	listBuilderProposalAdmissions,
	loadBuilderApplyReceipt,
	loadBuilderProposalRun,
} from "./builder-proposal.js";
import { assertBuilderProposalNotDiscarded } from "./builder-discard.js";
import { assertCleanTargetTree } from "./store-hygiene.js";
import { candidateScopeFor, effectiveProvenance } from "./candidate-experiment.js";
import { runCheapCheck, type CheapCheckResult } from "./cheap-check.js";
import { targetWithDevelopmentCorpus } from "./corpus-target.js";
import {
	compileExperimentHistory,
	experimentSignature,
	losingExperimentSignatures,
} from "./experiment-history.js";
import {
	MAX_SEARCH_CANDIDATES,
	MIN_SEARCH_CANDIDATES,
	proposalSearchGate,
	renderProposalSearchTable,
	runProposalSearch,
	type ProposalSearchResult,
} from "./proposal-search.js";
import {
	assertRestrictedGate,
	restrictedGate,
	RESTRICTED_DECISIONS,
	RestrictedGateDecisionError,
	type GateRestriction,
} from "./restricted-gate.js";
import {
	compileImprovementBrief,
	deriveEvidenceLinkedProposalSelection,
	type EvidenceLinkedProposalSelection,
	type FailureMode,
	type ImprovementBrief,
} from "./improvement-brief.js";
import {
	improvementDesignCorpusRefs,
	improvementExperimentDesignPath,
	materializeImprovementExperimentDesign,
	planImprovementExperiment,
	type ImprovementExperimentDesign,
} from "./improvement-experiment-design.js";

/** Bounds a single `ahde improve` invocation. */
export const MAX_IMPROVEMENT_CYCLES = 10;

/**
 * Fallback disclosure for hosts without an attached model author.
 */
export const IMPROVEMENT_LOOP_AUTHOR_DISCLOSURE =
	"The loop applies proposals the Builder has already prepared in `ahde`; it does not write them. " +
	"Open Builder Pi to generate new hypotheses automatically.";

// ---------------------------------------------------------------------------
// One invocation's ledger: unique branches, and a second `improve` that knows.
// ---------------------------------------------------------------------------

const LoopIdSchema = z.string().regex(/^loop_[a-z0-9]{6,32}$/);
const ArtifactIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);

export const IMPROVEMENT_LOOP_RUN_SCHEMA_VERSION = 2;

const ImprovementLoopConfigurationSchema = z.strictObject({
	approvedSpecId: ArtifactIdSchema,
	targetGitSha: z.string().regex(/^[0-9a-f]{40}$/),
	developmentCorpusId: ArtifactIdSchema.nullable(),
	developmentCorpusHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
	experimentDesignId: z.string().regex(/^idesign_[0-9a-f]{24}$/).nullable().default(null),
	experimentDesignHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable().default(null),
	until: z.number().min(0).max(1),
	maxCycles: z.number().int().min(1).max(MAX_IMPROVEMENT_CYCLES),
	repetitions: z.number().int().positive(),
	candidates: z.number().int().min(1).max(MAX_SEARCH_CANDIDATES),
	branchPrefix: z.string().min(1).max(200),
	searchBranchPrefix: z.string().min(1).max(200),
});
type ImprovementLoopConfiguration = z.infer<typeof ImprovementLoopConfigurationSchema>;

/**
 * The durable record of one `ahde improve` invocation. It exists so a second
 * invocation can see an unfinished first one instead of racing it onto the same
 * branch names, and so `--resume` can pick the same loop up where it stopped.
 */
export const ImprovementLoopRunRecordSchema = z.strictObject({
	schemaVersion: z.literal(IMPROVEMENT_LOOP_RUN_SCHEMA_VERSION),
	loopId: LoopIdSchema,
	projectId: ArtifactIdSchema,
	status: z.enum(["running", "finished", "abandoned"]),
	startedAt: z.string().min(1).max(64),
	updatedAt: z.string().min(1).max(64),
	configuration: ImprovementLoopConfigurationSchema,
	/** Highest cycle ordinal already claimed. A partial applied cycle still counts. */
	lastCycle: z.number().int().nonnegative().max(MAX_IMPROVEMENT_CYCLES),
	/** Branches this loop created, in order. Never deleted by the loop. */
	branches: z.array(z.string().min(1).max(200)).max(4 * MAX_IMPROVEMENT_CYCLES),
	/** Verified candidates this loop produced. Today the loop stops at the first. */
	candidateIds: z.array(ArtifactIdSchema).max(1),
	/** Target executions actually spent, including work before a process restart. */
	executions: z.number().int().nonnegative(),
	finalPassRate: z.number().min(0).max(1),
	/** One flat screen survives a restart, so the two-flat stop remains true. */
	consecutiveFlat: z.number().int().min(0).max(2),
	/** Set when the loop finished; a running record has none. */
	stopReason: z.string().min(1).max(64).nullable(),
});
export type ImprovementLoopRunRecord = z.infer<typeof ImprovementLoopRunRecordSchema>;

function loopsRoot(runsRoot: string): string {
	return join(resolve(runsRoot), "loops");
}

export function improvementLoopRecordPath(runsRoot: string, loopId: string): string {
	return join(loopsRoot(runsRoot), `${LoopIdSchema.parse(loopId)}.json`);
}

export function newImprovementLoopId(): string {
	return `loop_${randomBytes(12).toString("hex")}`;
}

function writeImprovementLoopRun(runsRoot: string, record: ImprovementLoopRunRecord): void {
	mkdirSync(loopsRoot(runsRoot), { recursive: true, mode: 0o700 });
	writeJsonArtifact(
		improvementLoopRecordPath(runsRoot, record.loopId),
		ImprovementLoopRunRecordSchema,
		ImprovementLoopRunRecordSchema.parse(record),
	);
}

export function loadImprovementLoopRun(runsRoot: string, loopId: string): ImprovementLoopRunRecord {
	return readJsonArtifact(improvementLoopRecordPath(runsRoot, loopId), ImprovementLoopRunRecordSchema);
}

/**
 * Loops this project started and never finished. Read leniently in the sense
 * that a file that will not parse is reported rather than hidden — an
 * unreadable ledger entry is exactly the case where refusing to start a second
 * loop is the safe answer.
 */
export function listUnfinishedImprovementLoops(
	runsRoot: string,
	projectId: string,
): { running: ImprovementLoopRunRecord[]; unreadable: string[] } {
	const running: ImprovementLoopRunRecord[] = [];
	const unreadable: string[] = [];
	const root = loopsRoot(runsRoot);
	if (!existsSync(root)) return { running, unreadable };
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return { running, unreadable: [root] };
	}
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".json")) continue;
		try {
			const record = readJsonArtifact(join(root, entry), ImprovementLoopRunRecordSchema);
			if (record.projectId === projectId && record.status === "running") running.push(record);
		} catch {
			unreadable.push(entry);
		}
	}
	return { running, unreadable };
}

/** A second `improve` found a first one still open. It reports and refuses. */
export class UnfinishedImprovementLoopError extends Error {
	constructor(
		readonly loops: readonly ImprovementLoopRunRecord[],
		readonly unreadable: readonly string[],
	) {
		super(
			`this project has ${loops.length + unreadable.length} unfinished improvement loop(s): ` +
			[
			...loops.map((loop) =>
					`${loop.loopId} (started ${loop.startedAt}, ${loop.lastCycle} cycle slot(s) claimed, ` +
					`branches ${loop.branches.join(", ") || "none"})`),
				...unreadable.map((entry) => `${entry} (unreadable)`),
			].join("; ") +
			". Continue it with `--resume <loopId>`, or drop it with `--abandon <loopId>`. " +
			"The branches it made are left exactly where they are either way.",
		);
		this.name = "UnfinishedImprovementLoopError";
	}
}

/** Mark one loop abandoned. Its branches survive; only the claim on them ends. */
export function abandonImprovementLoop(
	runsRoot: string,
	projectId: string,
	loopId: string,
	now: () => string = () => new Date().toISOString(),
): ImprovementLoopRunRecord {
	const record = loadImprovementLoopRun(runsRoot, loopId);
	if (record.projectId !== projectId) {
		throw new Error(`improvement loop ${loopId} belongs to project ${record.projectId}`);
	}
	if (record.status !== "running") {
		throw new Error(`improvement loop ${loopId} is ${record.status}; only a running loop can be abandoned`);
	}
	const abandoned: ImprovementLoopRunRecord = {
		...record,
		status: "abandoned",
		updatedAt: now(),
		stopReason: "abandoned",
	};
	writeImprovementLoopRun(runsRoot, abandoned);
	return abandoned;
}

/**
 * Every decision that creates release authority or asks for human judgement.
 * The loop refuses all of them; `apply-proposal` is deliberately absent
 * because applying on `candidate/auto-<loopId>-<n>` is the work the operator asked for.
 *
 * One list, shared with the proposal search: two copies of the same fifteen
 * kinds is how the two front doors drifted apart in the first place.
 */
export const IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS = RESTRICTED_DECISIONS;

export { RestrictedGateDecisionError as ImprovementLoopForbiddenDecisionError };

/** What the loop is, and what the operator does instead when it refuses. */
const IMPROVEMENT_LOOP_RESTRICTION: GateRestriction = {
	id: "improvement-loop",
	advice: "gate.restricted.advice.stop-loop",
};

/**
 * The gate the loop hands to anything it calls. A forbidden decision is not
 * declined, it throws: a loop that reaches one is a bug, not a request. The
 * sealed holdout answers one question — may this ship — and the loop never
 * asks it.
 */
export function improvementLoopGate(gate: WorkbenchHumanGate): WorkbenchHumanGate {
	return restrictedGate(gate, IMPROVEMENT_LOOP_RESTRICTION);
}

/**
 * A caller that hands the loop a gate which could still approve a promotion is
 * a bug, and the loop refuses before it spends anything — the same refusal the
 * search has always made.
 */
export function assertImprovementLoopGate(gate: WorkbenchHumanGate | undefined): void {
	assertRestrictedGate(gate, "improvement-loop");
}

export type ImprovementLoopStopReason =
	/** The development pass rate reached `--until`. */
	| "target-reached"
	/** `--max-cycles` is spent. */
	| "max-cycles"
	/** A verification came back with a verdict other than `improved`. */
	| "development-verdict"
	/** Two consecutive cheap checks found nothing. */
	| "flat-screen-twice"
	/** Infrastructure errors above the budget: inconclusive, never a failure. */
	| "infrastructure-errors"
	/** A verified candidate is ready; only the sealed gate and the human are left. */
	| "sealed-gate-required"
	/** The diagnosis has nothing a harness change can address. */
	| "no-proposable-failure-mode"
	/** The author produced no change. */
	| "no-change-proposed"
	/**
	 * Every proposable failure mode was already tried with exactly this change,
	 * and lost. Repeating it would spend the budget on a question that already
	 * has an answer.
	 */
	| "experiments-exhausted"
	/** A multi-candidate search finished; which hypothesis wins is the human's. */
	| "search-decision-required";

export const IMPROVEMENT_LOOP_STOP_MESSAGES: Readonly<Record<ImprovementLoopStopReason, string>> = {
	"target-reached": "the target pass rate is reached",
	"max-cycles": "the cycle budget is spent",
	"development-verdict": "the development verdict is not `improved`",
	"flat-screen-twice": "two cheap checks in a row found nothing",
	"infrastructure-errors": "infrastructure errors are over the budget, so the evidence is inconclusive",
	"sealed-gate-required": "a verified candidate is ready — the sealed guardrail and the promotion are yours",
	"no-proposable-failure-mode": "no failure mode is eligible for a harness change",
	"no-change-proposed": "the proposal author produced no change",
	"experiments-exhausted":
		"every proposable failure mode has already been tried with exactly this change, and it lost",
	"search-decision-required":
		"the search compared several hypotheses — picking the winner is yours, and so is the sealed guardrail",
};

/** Why one cycle refused to spend anything on the change it was handed. */
export type ImprovementCycleSkipReason =
	/** This exact changed-path set was already tried for this failure mode, and lost. */
	| "repeat-of-a-losing-experiment"
	/** Fewer hypotheses came back than a search needs. */
	| "too-few-hypotheses";

export const IMPROVEMENT_CYCLE_SKIP_MESSAGES: Readonly<Record<ImprovementCycleSkipReason, string>> = {
	"repeat-of-a-losing-experiment":
		"this exact change was already tried for this failure mode and did not improve anything",
	"too-few-hypotheses": `a search needs at least ${MIN_SEARCH_CANDIDATES} hypotheses for one failure mode`,
};

/** What one cycle refused, and which failure mode it refused it for. */
export interface ImprovementCycleSkip {
	reason: ImprovementCycleSkipReason;
	failureModeId: string;
	changedPaths: string[];
	proposalRunId: string;
}

/**
 * The exact development surface one cycle is asking about. A proposal is bound
 * to a cycle by THIS — dataset label, dataset hash, suite hash, Target
 * revision — and by the failure mode it attests to, never by the id of an eval
 * run that a fresh invocation has by definition just minted.
 */
export interface ImprovementDevelopmentSurface {
	targetId: string;
	/** The revision the cycle measured, and the revision a proposal must be based on. */
	targetGitSha: string;
	dataset: string;
	datasetHash: string;
	suiteHash: string;
}

/** Why a recorded proposal is not this cycle's, in one word plus what moved. */
export type RecordedProposalStaleReason =
	/** Nothing is recorded for this project at all. */
	| "no-recorded-proposal"
	/** Everything recorded has already been applied or discarded. */
	| "already-used"
	/** The proposal is based on a different Target revision. */
	| "target-revision-moved"
	/** The development basket changed under it. */
	| "dataset-changed"
	/** The suite (graders, judge, execution surface) changed under it. */
	| "suite-changed"
	/** It is bound to a different failure mode than the one this cycle chose. */
	| "failure-mode-differs"
	/** The approved product contract changed while the measured surface stayed alike. */
	| "spec-changed"
	/** It carries no attested basis, so nothing can bind it to a surface. */
	| "no-attested-basis";

export const RECORDED_PROPOSAL_STALE_MESSAGES:
	Readonly<Record<RecordedProposalStaleReason, string>> = {
	"no-recorded-proposal":
		"no Builder proposal is recorded for this project. Author one in `ahde` (say “fix it”), then run the loop.",
	"already-used": "every recorded Builder proposal has already been applied or discarded",
	"target-revision-moved": "the Target revision moved since the proposal was written",
	"dataset-changed": "the development basket changed since the proposal was written",
	"suite-changed": "the eval suite changed since the proposal was written",
	"failure-mode-differs": "no recorded proposal targets the failure mode this cycle chose",
	"spec-changed": "the recorded proposal belongs to a different approved Spec",
	"no-attested-basis": "the recorded proposal carries no attested evidence basis, so nothing binds it to this surface",
};

export interface ImprovementProposalRequest {
	cycle: number;
	/**
	 * Which hypothesis of this cycle is being asked for, 1-based. With
	 * `candidates: 1` it is always 1; a search asks for the same failure mode
	 * `variants` times and expects a different hypothesis each time.
	 */
	variant: number;
	/** How many hypotheses this cycle wants for the mode. */
	variants: number;
	repositoryDir: string;
	runsRoot: string;
	stateRoot: string;
	projectId: string;
	approvedSpecId: string;
	baseTargetSha: string;
	evalRunId: string;
	/**
	 * What a proposal has to match to be this cycle's. Deliberately not
	 * `evalRunId`: every invocation mints a new EvalRun, so binding by run id
	 * makes every proposal prepared before the command unusable and every
	 * proposal prepared after it stale.
	 */
	surface: ImprovementDevelopmentSurface;
	diagnosisId: string;
	brief: ImprovementBrief;
	failureMode: FailureMode;
	selection: EvidenceLinkedProposalSelection;
	/** Bounded, redacted failure bundle for this cycle's eval. */
	failureBundlePath: string;
	/**
	 * The gate anything nested may use, already wrapped by
	 * {@link improvementLoopGate}: consequential decisions throw instead of
	 * asking. The loop itself asks for nothing.
	 */
	gate?: WorkbenchHumanGate;
	signal?: AbortSignal;
}

export type ImprovementProposalDecision = (
	/** A proposal to record through the canonical Builder chain. */
	| { kind: "propose"; proposal: CandidateProposal }
	/** An already-recorded, still-open Builder proposal to apply. */
	| { kind: "recorded"; builderRunId: string }
	/** Nothing to try this cycle, and — where it is one — the typed reason. */
	| { kind: "no-change"; reason: string; staleness?: RecordedProposalStaleReason }
) & { authoring?: ImprovementAuthorUsage };

export type ImprovementProposalAuthor = (
	request: ImprovementProposalRequest,
) => Promise<ImprovementProposalDecision> | ImprovementProposalDecision;

export interface ImprovementLoopScreen {
	verdict: CheapCheckResult["verdict"];
	tasks: number;
	improved: number;
	unchanged: number;
	regressed: number;
	inconclusive: number;
	withinErrorBudget: boolean;
	screenEvalRunId: string;
}

export interface ImprovementLoopVerification {
	candidateId: string;
	verdict: GateVerdict;
	scoreDelta: number;
	passRateDelta: number;
	candidatePassRate: number;
}

export interface ImprovementLoopCycle {
	cycle: number;
	/** Model-author attempts, including attempts that produced no proposal. */
	authoring?: ImprovementAuthorUsage[];
	evalRunId: string;
	/**
	 * True when this cycle did not pay for its own measurement: either an earlier
	 * cycle of this loop already measured the same revision, or a fresh,
	 * comparable, conclusive development EvalRun was already on disk.
	 */
	evalReused: boolean;
	/** The revision this cycle measured and proposed against. */
	baseTargetSha: string;
	/** The changed paths of the applied proposal, so the table shows the diff. */
	changedPaths: string[];
	pass: number;
	total: number;
	passRate: number;
	failureModeId: string | null;
	proposalRunId: string | null;
	branch: string | null;
	candidateSha: string | null;
	screen: ImprovementLoopScreen | null;
	verification: ImprovementLoopVerification | null;
	/** The Pareto table, when this cycle compared several hypotheses. */
	search: ProposalSearchResult | null;
	/** What this cycle refused to spend anything on, and why. */
	skipped: ImprovementCycleSkip | null;
	/** Target executions this cycle actually spent. */
	executions: number;
	note: string;
}

export interface ImprovementLoopResult {
	cycles: ImprovementLoopCycle[];
	stopReason: ImprovementLoopStopReason;
	stopMessage: string;
	/** The verified candidate the human can ship, when the loop produced one. */
	candidateId: string | null;
	/** This invocation's id: the branch names carry it, `--resume` names it. */
	loopId: string;
	finalPassRate: number;
	executions: number;
	/** Persisted blind authoring/validation split used by a hypothesis search. */
	experimentDesign: ImprovementExperimentDesign | null;
}

export interface ImprovementLoopOptions {
	repositoryDir: string;
	runsRoot: string;
	stateRoot: string;
	projectId: string;
	approvedSpecId: string;
	/** The published development corpus the cycles measure on. */
	developmentCorpus?: CorpusRef;
	/** Stop as soon as the development pass rate reaches this (0..1). */
	until: number;
	maxCycles: number;
	repetitions: number;
	/**
	 * Hypotheses per cycle. `1` (the default) is one proposal, one screen, one
	 * verification. `2`..`4` asks the author for that many hypotheses for the
	 * top failure mode and compares them in one search, so the cycle ends with a
	 * Pareto table instead of a single verdict.
	 */
	candidates?: number;
	jobs?: number;
	branchPrefix?: string;
	/** Branch prefix for a multi-candidate search; the ordinal is appended. */
	searchBranchPrefix?: string;
	/**
	 * This invocation's id. Minted when absent; supplied by `--resume` to
	 * continue an unfinished loop on the same `candidate/auto-<loopId>-<n>`
	 * series instead of colliding with it.
	 */
	loopId?: string;
	/**
	 * How old a development EvalRun may be and still be reused instead of
	 * measured again. Undefined keeps `findReusableBaseline`'s seven days; 0
	 * disables reuse.
	 */
	baselineMaxAgeMs?: number;
	author: ImprovementProposalAuthor;
	/**
	 * Handed to the proposal author, wrapped so that every decision creating
	 * release authority throws. The loop never calls it itself.
	 */
	gate?: WorkbenchHumanGate;
	actorId?: string;
	/** One line per cycle, host-rendered. */
	onCycle?: (line: string, cycle: ImprovementLoopCycle) => void;
	onRunEvent?: RunEventListener;
	signal?: AbortSignal;
	now?: () => string;
}

export interface ImprovementLoopDependencies {
	runSuite: typeof runSuite;
	loadTarget: typeof loadTarget;
	loadCorpus: typeof loadCorpus;
	diagnoseEval: typeof diagnoseEvalRun;
	compileImprovementBrief: typeof compileImprovementBrief;
	recordProposal: typeof recordBuilderAuthoredProposal;
	applyProposal: typeof applyBuilderProposal;
	runCheapCheck: typeof runCheapCheck;
	runAppliedCandidate: typeof runAppliedBuilderCandidate;
	compileFailureBundle: typeof compileFailureBundle;
	/** What was already tried, so the loop can refuse to try it again. */
	compileExperimentHistory: typeof compileExperimentHistory;
	/** Several hypotheses for one failure mode, compared in one table. */
	runProposalSearch: typeof runProposalSearch;
	/** Evidence already on disk that a cycle can read instead of pay for. */
	findReusableBaseline: typeof findReusableBaseline;
	/** Exact model-visible source and prepared-home identity, for the reuse query. */
	computeTargetSnapshotHashes: typeof computeTargetSnapshotHashes;
	/** The provenance a run of this Target would carry, probed without running. */
	effectiveProvenance: typeof effectiveProvenance;
	/** Persist the immutable authoring/validation split before any model sees it. */
	materializeExperimentDesign: typeof materializeImprovementExperimentDesign;
}

const DEFAULT_DEPENDENCIES: ImprovementLoopDependencies = {
	runSuite,
	loadTarget,
	loadCorpus,
	diagnoseEval: diagnoseEvalRun,
	compileImprovementBrief,
	recordProposal: recordBuilderAuthoredProposal,
	applyProposal: applyBuilderProposal,
	runCheapCheck,
	runAppliedCandidate: runAppliedBuilderCandidate,
	compileFailureBundle,
	compileExperimentHistory,
	runProposalSearch,
	findReusableBaseline,
	computeTargetSnapshotHashes,
	effectiveProvenance,
	materializeExperimentDesign: materializeImprovementExperimentDesign,
};

function abortIfRequested(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("improvement loop aborted");
}

/**
 * The mode worth spending a cycle on: proposable, then widest blast radius,
 * then most reproducible, then the stable id so the choice never depends on
 * map order.
 */
export function topProposableFailureMode(
	brief: ImprovementBrief,
	/** Modes this loop has already exhausted; skipped whatever their impact. */
	exclude: ReadonlySet<string> = new Set(),
): FailureMode | null {
	const proposable = brief.modes.filter((mode) =>
		mode.decision === "propose-harness-change" && !exclude.has(mode.failureModeId));
	if (proposable.length === 0) return null;
	return [...proposable].sort((left, right) =>
		right.impact.taskCoverageBps - left.impact.taskCoverageBps ||
		right.impact.reproductionBps - left.impact.reproductionBps ||
		right.impact.failedOccurrences - left.impact.failedOccurrences ||
		(left.failureModeId < right.failureModeId ? -1 : left.failureModeId > right.failureModeId ? 1 : 0),
	)[0]!;
}

/** One progress line per cycle, in the shape `run-progress.ts` uses on stderr. */
export function improvementCycleLine(cycle: ImprovementLoopCycle, maxCycles: number): string {
	const parts = [
		`AHDE improve cycle ${cycle.cycle}/${maxCycles}`,
		`run ${cycle.pass}/${cycle.total} ${percent(cycle.passRate)}${cycle.evalReused ? " (reused)" : ""}`,
	];
	if (cycle.failureModeId) parts.push(`mode ${cycle.failureModeId}`);
	if (cycle.branch) parts.push(`branch ${cycle.branch}`);
	if (cycle.changedPaths.length > 0) parts.push(`changed paths ${cycle.changedPaths.join(", ")}`);
	if (cycle.screen) {
		parts.push(
			`screen ${cycle.screen.verdict} ${cycle.screen.improved}/${cycle.screen.tasks}` +
			(cycle.screen.withinErrorBudget ? "" : " (inconclusive)"),
		);
	}
	if (cycle.verification) {
		const delta = cycle.verification.scoreDelta;
		parts.push(`verify ${cycle.verification.verdict} ${points(delta, "machine")}`);
	}
	if (cycle.search) {
		parts.push(`search ${cycle.search.rows.filter((row) => row.status === "verified").length}/${cycle.search.rows.length} verified`);
	}
	if (cycle.skipped) parts.push(`refused — ${IMPROVEMENT_CYCLE_SKIP_MESSAGES[cycle.skipped.reason]}`);
	parts.push(cycle.note);
	return parts.join(" · ");
}

/** The same separate author bill in the terminal and the machine-readable table. */
export function improvementAuthorSpendLine(cycles: readonly ImprovementLoopCycle[]): string | null {
	const attempts = cycles.flatMap((cycle) => cycle.authoring ?? []);
	if (attempts.length === 0) return null;
	const cost = attempts.every((attempt) => attempt.costUsd !== null)
		? `$${attempts.reduce((sum, attempt) => sum + attempt.costUsd!, 0).toFixed(4)}`
		: "unknown (one or more interrupted/failed requests)";
	const requests = attempts.reduce((sum, attempt) => sum + attempt.requests, 0);
	const tokens = attempts.reduce((sum, attempt) => sum + attempt.tokens, 0);
	return `Builder author: ${attempts.length} attempts, ${requests} requests, ${tokens} reported tokens, ${cost}. Receipts: improvement-authors/.`;
}

/** The compact per-cycle table the loop hands back. */
export function renderImprovementLoopTable(result: ImprovementLoopResult, authoringDisclosure = IMPROVEMENT_LOOP_AUTHOR_DISCLOSURE): string {
	const header = "| cycle | pass rate | failure mode | branch | changed paths | screen | verification |";
	const divider = "|---|---|---|---|---|---|---|";
	const rows = result.cycles.map((cycle) => {
		const screen = cycle.screen
			? `${cycle.screen.verdict} ${cycle.screen.improved}/${cycle.screen.tasks}` +
				(cycle.screen.withinErrorBudget ? "" : " · inconclusive")
			: "—";
		const verification = cycle.verification
			? `${cycle.verification.verdict} ${points(cycle.verification.scoreDelta, "machine")}`
			: cycle.search
				? `search of ${cycle.search.rows.length}`
				: cycle.skipped
					? `refused (${cycle.skipped.reason})`
					: "skipped";
		return `| ${cycle.cycle} | ${percent(cycle.passRate)}${cycle.evalReused ? " (reused)" : ""} | ` +
			`${cycle.failureModeId ?? "—"} | ${cycle.branch ?? "—"} | ` +
			`${cycle.changedPaths.length > 0 ? cycle.changedPaths.join(", ") : "—"} | ${screen} | ${verification} |`;
	});
	const searches = result.cycles.flatMap((cycle) =>
		cycle.search ? ["", `Cycle ${cycle.cycle} — hypotheses for ${cycle.failureModeId ?? "—"}:`, renderProposalSearchTable(cycle.search)] : []);
	const latestSearch = [...result.cycles].reverse().find((cycle) => cycle.search)?.search ?? null;
	const refusals = result.cycles.flatMap((cycle) =>
		cycle.skipped
			? [`Cycle ${cycle.cycle} refused ${cycle.skipped.proposalRunId}: ${IMPROVEMENT_CYCLE_SKIP_MESSAGES[cycle.skipped.reason]}.`]
			: []);
	const authorSpend = improvementAuthorSpendLine(result.cycles);
	return [
		header,
		divider,
		...rows,
		...searches,
		"",
		...refusals,
		...(result.experimentDesign ? [
			`Blind split ${result.experimentDesign.designId}: ` +
			`${result.experimentDesign.authoringTaskIds.length} authoring, ` +
			`${result.experimentDesign.validationTaskIds.length} unseen validation ` +
			`(${result.experimentDesign.designHash}).`,
		] : []),
		`Stopped: ${result.stopMessage}.`,
		...(result.cycles.at(-1)?.note ? [`Reason: ${result.cycles.at(-1)!.note}`] : []),
		`Target executions spent: ${result.executions}.`,
		...(authorSpend ? [authorSpend] : []),
		result.candidateId
			? `Candidate ${result.candidateId} is verified · awaiting your decision. Promotion is yours: ` +
				"`ship it` runs the sealed guardrail and the release decisions."
			: latestSearch && latestSearch.frontier.length > 0
				? "Several hypotheses were compared; pick one from the table above, then ship it."
				: "No improved candidate is waiting on a release decision.",
		authoringDisclosure,
	].join("\n");
}

interface CycleEval {
	record: EvalRunRecord;
	reused: boolean;
}

/**
 * The experiments this project already ran and lost, by changed-path set and
 * targeted failure mode. Reading the memory is best-effort: a runs root that
 * cannot be listed leaves the loop exactly as blind as it was before, never
 * broken.
 */
function losingSignatures(
	dependencies: ImprovementLoopDependencies,
	runsRoot: string,
	options: ImprovementLoopOptions,
): Set<string> {
	try {
		return losingExperimentSignatures(dependencies.compileExperimentHistory({
			runsRoot,
			projectId: options.projectId,
		}));
	} catch {
		return new Set<string>();
	}
}

/** Exactly what a recorded proposal would replace, before a byte of it is applied. */
function proposalChangedPaths(runsRoot: string, proposalRunId: string): string[] {
	try {
		const record = loadBuilderProposalRun(runsRoot, proposalRunId);
		if (record.result.status !== "completed" || record.result.proposal?.decision !== "propose") return [];
		return record.result.proposal.changes.map((change) => change.path).sort();
	} catch {
		return [];
	}
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

/**
 * Git is the last-resort checkpoint. If the process died after creating a ref
 * but before updating the loop ledger, resumption still skips that occupied
 * cycle ordinal instead of colliding with it or overwriting it.
 */
function claimedBranchCycles(
	repositoryDir: string,
	branchPrefix: string,
	searchBranchPrefix: string,
): { branches: string[]; lastCycle: number } {
	let branches: string[] = [];
	try {
		branches = execFileSync(
			"git",
			["-C", repositoryDir, "for-each-ref", "--format=%(refname:short)", "refs/heads"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		).split("\n").map((line) => line.trim()).filter(Boolean);
	} catch {
		return { branches: [], lastCycle: 0 };
	}
	let lastCycle = 0;
	const claimed: string[] = [];
	for (const branch of branches) {
		let ordinal: number | null = null;
		if (branch.startsWith(branchPrefix)) {
			const suffix = branch.slice(branchPrefix.length);
			if (/^\d+$/.test(suffix)) ordinal = Number(suffix);
		} else if (branch.startsWith(searchBranchPrefix)) {
			const suffix = branch.slice(searchBranchPrefix.length);
			const matched = /^(\d+)-\d+$/.exec(suffix);
			if (matched) ordinal = Number(matched[1]);
		}
		if (ordinal !== null && Number.isSafeInteger(ordinal) && ordinal > 0) {
			lastCycle = Math.max(lastCycle, ordinal);
			claimed.push(branch);
		}
	}
	return { branches: unique(claimed), lastCycle };
}

function sameLoopConfiguration(left: ImprovementLoopConfiguration, right: ImprovementLoopConfiguration): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export async function runImprovementLoop(
	options: ImprovementLoopOptions,
	dependenciesInput: Partial<ImprovementLoopDependencies> = {},
): Promise<ImprovementLoopResult> {
	const dependencies: ImprovementLoopDependencies = { ...DEFAULT_DEPENDENCIES, ...dependenciesInput };
	const repositoryDir = resolve(options.repositoryDir);
	const runsRoot = resolve(options.runsRoot);
	const stateRoot = resolve(options.stateRoot);
	const actorId = options.actorId ?? "local-user";
	const candidatesPerCycle = Math.trunc(options.candidates ?? 1);
	const now = options.now ?? (() => new Date().toISOString());
	if (!Number.isFinite(options.until) || options.until < 0 || options.until > 1) {
		throw new Error(`--until must be a pass rate between 0 and 1, got ${options.until}`);
	}
	if (!Number.isInteger(options.maxCycles) || options.maxCycles < 1 || options.maxCycles > MAX_IMPROVEMENT_CYCLES) {
		throw new Error(`--max-cycles must be between 1 and ${MAX_IMPROVEMENT_CYCLES}, got ${options.maxCycles}`);
	}
	if (candidatesPerCycle < 1 || candidatesPerCycle > MAX_SEARCH_CANDIDATES) {
		throw new Error(`--candidates must be between 1 and ${MAX_SEARCH_CANDIDATES}, got ${options.candidates}`);
	}
	// Before anything is resolved, read or spent: a gate that could still approve
	// a promotion is not a gate this loop may hold.
	assertImprovementLoopGate(options.gate);
	// The loop id is this invocation's identity, and it is in every branch name:
	// two loops on one project can never write the same ref, and `--resume` puts
	// a continuation back on the series it left.
	const loopId = LoopIdSchema.parse(options.loopId ?? newImprovementLoopId());
	const branchPrefix = options.branchPrefix ?? `candidate/auto-${loopId}-`;
	const searchBranchPrefix = options.searchBranchPrefix ?? `candidate/search-${loopId}-`;

	const developmentCorpus = options.developmentCorpus ? dependencies.loadCorpus(options.developmentCorpus) : null;
	if (candidatesPerCycle > 1 && !developmentCorpus) {
		throw new Error("blind hypothesis search requires one reviewed development corpus");
	}
	// This pure preflight rejects an underpowered basket before a split artifact,
	// branch, evaluator or Builder request exists.
	if (candidatesPerCycle > 1 && developmentCorpus) {
		planImprovementExperiment(developmentCorpus, loopId);
	}
	// Every branch this loop cuts and every candidate it verifies is bound to one
	// exact revision, so a dirty tree has nothing to bind to. Said here, in the
	// operator's words, rather than as a regex failure on `<sha>-dirty-<hash>` —
	// and it is easy to hit, because `improve > improve.log` inside the Target is
	// itself an uncommitted file.
	assertCleanTargetTree(repositoryDir, {
		because: "an improvement loop cuts every branch from one clean committed baseline",
		next: "commit or stash them (a run log written inside the Target counts), then run ahde improve again",
	});
	const experimentDesign = candidatesPerCycle > 1 && developmentCorpus
		? dependencies.materializeExperimentDesign({
			runsRoot,
			stateRoot,
			projectId: options.projectId,
			loopId,
			corpus: developmentCorpus,
			now,
		})
		: null;
	const splitRefs = experimentDesign ? improvementDesignCorpusRefs(experimentDesign, stateRoot) : null;
	const authoringCorpus = splitRefs ? dependencies.loadCorpus(splitRefs.authoring) : developmentCorpus;
	const validationCorpus = splitRefs ? dependencies.loadCorpus(splitRefs.validation) : null;
	const resolveTarget = (dir: string): ResolvedTarget => {
		const base = dependencies.loadTarget(dir);
		return authoringCorpus ? targetWithDevelopmentCorpus(base, authoringCorpus) : base;
	};
	const rootTarget = resolveTarget(repositoryDir);
	const configuration = ImprovementLoopConfigurationSchema.parse({
		approvedSpecId: options.approvedSpecId,
		targetGitSha: rootTarget.gitSha,
		developmentCorpusId: developmentCorpus?.metadata.id ?? null,
		developmentCorpusHash: developmentCorpus?.metadata.hash ?? null,
		experimentDesignId: experimentDesign?.designId ?? null,
		experimentDesignHash: experimentDesign?.designHash ?? null,
		until: options.until,
		maxCycles: options.maxCycles,
		repetitions: options.repetitions,
		candidates: candidatesPerCycle,
		branchPrefix,
		searchBranchPrefix,
	});
	const recordPath = improvementLoopRecordPath(runsRoot, loopId);
	const previous = existsSync(recordPath) ? loadImprovementLoopRun(runsRoot, loopId) : null;
	if (previous) {
		if (previous.projectId !== options.projectId) {
			throw new Error(`improvement loop ${loopId} belongs to project ${previous.projectId}`);
		}
		if (previous.status !== "running") {
			throw new Error(`improvement loop ${loopId} is ${previous.status}; only a running loop can be resumed`);
		}
		if (!sameLoopConfiguration(previous.configuration, configuration)) {
			throw new Error(
				`improvement loop ${loopId} cannot resume with different Target, Spec, corpus, target rate, ` +
				"cycle budget, repetitions, hypothesis count, or branch namespace; abandon it and start a new loop",
			);
		}
	}
	const gitClaims = claimedBranchCycles(repositoryDir, branchPrefix, searchBranchPrefix);
	if (!previous && gitClaims.branches.length > 0) {
		throw new Error(`improvement loop ${loopId} has branches but no durable ledger; choose a new loop id`);
	}

	const cycles: ImprovementLoopCycle[] = [];
	const candidateIds: string[] = [...(previous?.candidateIds ?? [])];
	const branchesMade: string[] = unique([...(previous?.branches ?? []), ...gitClaims.branches]);
	let executions = previous?.executions ?? 0;
	let consecutiveFlat = previous?.consecutiveFlat ?? 0;
	let candidateId: string | null = candidateIds.at(-1) ?? null;
	let finalPassRate = previous?.finalPassRate ?? 0;
	let lastCycle = Math.max(previous?.lastCycle ?? 0, gitClaims.lastCycle);
	let cached: CycleEval | null = null;
	let cachedForSha: string | null = null;
	// What already lost, read once: a project's candidate records do not change
	// while its own loop is running, and every experiment this loop finishes is
	// added below rather than re-read from disk.
	const losing = losingSignatures(dependencies, runsRoot, options);
	/** Failure modes this loop has stopped asking about. */
	const exhaustedModes = new Set<string>();

	const startedAt = previous?.startedAt ?? now();
	const ledger = (
		status: ImprovementLoopRunRecord["status"],
		stopReason: string | null,
	): void => {
		writeImprovementLoopRun(runsRoot, {
			schemaVersion: IMPROVEMENT_LOOP_RUN_SCHEMA_VERSION,
			loopId,
			projectId: options.projectId,
			status,
			startedAt,
			updatedAt: now(),
			configuration,
			lastCycle,
			branches: unique(branchesMade),
			candidateIds: [...candidateIds],
			executions,
			finalPassRate,
			consecutiveFlat,
			stopReason,
		});
	};
	ledger("running", null);

	/**
	 * A development EvalRun already on disk that answers exactly this cycle's
	 * question: same Target revision, same toolset, same workspace, same
	 * provenance, same repetitions, no infrastructure errors, `purpose:
	 * evidence`, and fresh enough. Reading one is the difference between a cycle
	 * that costs a full suite and a cycle that costs nothing.
	 */
	const reusableEvidence = (
		target: ResolvedTarget,
		label: "baseline" | "solo" = "solo",
	): EvalRunRecord | null => {
		try {
			const snapshot = dependencies.computeTargetSnapshotHashes(target, runsRoot);
			const query: ReusableBaselineQuery = {
				targetId: target.manifest.id,
				targetGitSha: target.gitSha,
				toolsetHash: target.toolsetHash,
				workspaceHash: snapshot.workspaceHash,
				preparedToolHomeHash: snapshot.preparedToolHomeHash,
				provenance: dependencies.effectiveProvenance(target),
				evidenceVisibility: "development",
				label,
				purpose: "evidence",
				repetitions: options.repetitions,
				...(options.baselineMaxAgeMs === undefined ? {} : { maxAgeMs: options.baselineMaxAgeMs }),
			};
			return dependencies.findReusableBaseline(runsRoot, query);
		} catch {
			// A reuse query that cannot be built is not a reason to stop; it is a
			// reason to measure, which is what the caller does next.
			return null;
		}
	};

	const finish = (
		reason: ImprovementLoopStopReason,
		note: string,
		partial?: ImprovementLoopCycle,
	): ImprovementLoopResult => {
		if (partial) {
			partial.note = note;
			cycles.push(partial);
			lastCycle = Math.max(lastCycle, partial.cycle);
			options.onCycle?.(improvementCycleLine(partial, options.maxCycles), partial);
		}
		ledger("finished", reason);
		return {
			cycles,
			stopReason: reason,
			stopMessage: IMPROVEMENT_LOOP_STOP_MESSAGES[reason],
			candidateId,
			loopId,
			finalPassRate,
			executions,
			experimentDesign,
		};
	};
	if (candidateId) {
		return finish(
			"sealed-gate-required",
			`candidate ${candidateId} was already verified before the interrupted process stopped`,
		);
	}

	/** Result of one cycle: either the loop stops, or it goes round again. */
	type CycleOutcome =
		| { kind: "stop"; result: ImprovementLoopResult }
		| { kind: "continue" };

	const runCycle = async (cycleIndex: number): Promise<CycleOutcome> => {
		abortIfRequested(options.signal);
		const target = resolveTarget(repositoryDir);
		const cycle: ImprovementLoopCycle = {
			cycle: cycleIndex,
			evalRunId: "",
			evalReused: false,
			baseTargetSha: target.gitSha,
			changedPaths: [],
			pass: 0,
			total: 0,
			passRate: 0,
			failureModeId: null,
			proposalRunId: null,
			branch: null,
			candidateSha: null,
			screen: null,
			verification: null,
			search: null,
			skipped: null,
			executions: 0,
			note: "",
		};

		// ---- run -----------------------------------------------------------
		// Three ways to get this cycle's numbers, cheapest first: an earlier cycle
		// of this loop measured the same revision; a fresh, comparable, conclusive
		// development EvalRun is already on disk; or pay for one.
		let evaluation: CycleEval;
		if (cached && cachedForSha === target.gitSha) {
			evaluation = { record: cached.record, reused: true };
		} else {
			const reusable = reusableEvidence(target);
			if (reusable) {
				evaluation = { record: reusable, reused: true };
				cached = evaluation;
				cachedForSha = target.gitSha;
			} else {
				const record = await dependencies.runSuite(target, {
					runsRoot,
					label: "solo",
					repetitions: options.repetitions,
					evidenceVisibility: "development",
					...(options.jobs === undefined ? {} : { jobs: options.jobs }),
					...(options.signal ? { signal: options.signal } : {}),
					...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
				});
				evaluation = { record, reused: false };
				cached = evaluation;
				cachedForSha = target.gitSha;
					executions += record.summary.total;
					cycle.executions += record.summary.total;
					ledger("running", null);
			}
		}
		cycle.evalRunId = evaluation.record.evalRunId;
		cycle.evalReused = evaluation.reused;
		cycle.pass = evaluation.record.summary.pass;
		cycle.total = evaluation.record.summary.total;
		cycle.passRate = evaluation.record.summary.allPassRate;
		finalPassRate = cycle.passRate;

		if (!withinInfrastructureBudget(evaluation.record.summary.error, evaluation.record.summary.total)) {
			return { kind: "stop", result: finish(
				"infrastructure-errors",
				`${evaluation.record.summary.error} infrastructure error(s) in ${evaluation.record.summary.total} runs`,
				cycle,
			) };
		}
		if (cycle.passRate >= options.until) {
			return { kind: "stop", result: finish("target-reached", `${percent(cycle.passRate)} ≥ ${percent(options.until)}`, cycle) };
		}

		// ---- diagnose and pick ---------------------------------------------
		const diagnosis = dependencies.diagnoseEval(runsRoot, evaluation.record.evalRunId);
		const brief = dependencies.compileImprovementBrief(runsRoot, diagnosis);
		const mode = brief.proposalEligible ? topProposableFailureMode(brief, exhaustedModes) : null;
		if (!mode) {
			// A mode the loop exhausted itself is a different answer from a brief
			// that never had one: the first says "everything left has been tried",
			// the second says "nothing here is a harness defect".
			if (exhaustedModes.size > 0) return { kind: "stop", result: finish("experiments-exhausted", brief.headline, cycle) };
			return { kind: "stop", result: finish("no-proposable-failure-mode", brief.headline, cycle) };
		}
		cycle.failureModeId = mode.failureModeId;
		const proposalBasis = {
			algorithmId: brief.algorithmId,
			evalRunId: brief.evalRunId,
			diagnosisId: brief.diagnosisId,
			briefId: brief.briefId,
			failureModeIds: [mode.failureModeId],
		};
		const selection = deriveEvidenceLinkedProposalSelection(brief, proposalBasis);
		const surface: ImprovementDevelopmentSurface = {
			targetId: evaluation.record.target.id,
			targetGitSha: target.gitSha,
			dataset: evaluation.record.dataset,
			datasetHash: evaluation.record.datasetHash,
			suiteHash: evaluation.record.suiteHash,
		};

		// ---- author ---------------------------------------------------------
		// With `candidates: 1` this asks once; a search asks for the same failure
		// mode `candidates` times and expects a different hypothesis each time.
		const failureBundlePath = dependencies.compileFailureBundle(target, evaluation.record, runsRoot);
		const proposalRunIds: string[] = [];
		const authorRefusals: string[] = [];
		for (let variant = 1; variant <= candidatesPerCycle; variant += 1) {
			const decision = await options.author({
				...(options.gate ? { gate: improvementLoopGate(options.gate) } : {}),
				cycle: cycleIndex,
				variant,
				variants: candidatesPerCycle,
				repositoryDir,
				runsRoot,
				stateRoot,
				projectId: options.projectId,
				approvedSpecId: options.approvedSpecId,
				baseTargetSha: target.gitSha,
				evalRunId: evaluation.record.evalRunId,
				surface,
				diagnosisId: diagnosis.diagnosisId,
				brief,
				failureMode: mode,
				selection,
				failureBundlePath,
				...(options.signal ? { signal: options.signal } : {}),
			});
			if (decision.authoring) (cycle.authoring ??= []).push(decision.authoring);
			abortIfRequested(options.signal);
			if (decision.kind === "no-change") {
				authorRefusals.push(decision.reason);
				continue;
			}
			if (decision.kind === "recorded") {
				proposalRunIds.push(decision.builderRunId);
				continue;
			}
			const recorded = await dependencies.recordProposal({
				proposal: decision.proposal,
				targetDir: repositoryDir,
				allowedPaths: candidateScopeFor(target.manifest).allowed,
				approvedSpec: { stateRoot, projectId: options.projectId, specId: options.approvedSpecId },
				runsRoot,
				timeoutMs: 30_000,
				sourceEvalRunId: evaluation.record.evalRunId,
				proposalBasis,
				...(options.signal ? { signal: options.signal } : {}),
			});
			if (recorded.record.result.status !== "completed" || recorded.record.result.proposal?.decision !== "propose") {
				authorRefusals.push("the recorded proposal carries no change");
				continue;
			}
			proposalRunIds.push(recorded.record.runId);
		}
		if (proposalRunIds.length === 0) {
			return { kind: "stop", result: finish(
				"no-change-proposed",
				authorRefusals.length > 0
					? authorRefusals.map((reason, index) => `variant ${index + 1}: ${reason}`).join("; ").slice(0, 2_000)
					: "the proposal author produced no change",
				cycle,
			) };
		}

		// ---- search, when this cycle wants several hypotheses -----------------
		if (candidatesPerCycle > 1) {
			if (proposalRunIds.length < MIN_SEARCH_CANDIDATES) {
				cycle.proposalRunId = proposalRunIds[0]!;
				cycle.skipped = {
					reason: "too-few-hypotheses",
					failureModeId: mode.failureModeId,
					changedPaths: proposalChangedPaths(runsRoot, proposalRunIds[0]!),
					proposalRunId: proposalRunIds[0]!,
				};
				return { kind: "stop", result: finish(
					"no-change-proposed",
					authorRefusals.length > 0
						? `${IMPROVEMENT_CYCLE_SKIP_MESSAGES["too-few-hypotheses"]}: ${authorRefusals.join("; ").slice(0, 1_500)}`
						: IMPROVEMENT_CYCLE_SKIP_MESSAGES["too-few-hypotheses"],
					cycle,
				) };
			}
			// The Builder has finished authoring. Only now may the host open the
			// validation arm. Its baseline is useful twice: it supplies failed cases
			// to the cheap screen and is reused by every matched candidate pair.
			let validationSourceEvalRunId: string | undefined;
			if (splitRefs && validationCorpus) {
				const validationTarget = targetWithDevelopmentCorpus(
					dependencies.loadTarget(repositoryDir),
					validationCorpus,
				);
				let validationBaseline = reusableEvidence(validationTarget, "baseline");
				if (!validationBaseline) {
					validationBaseline = await dependencies.runSuite(validationTarget, {
						runsRoot,
						label: "baseline",
						repetitions: options.repetitions,
						evidenceVisibility: "development",
						...(options.jobs === undefined ? {} : { jobs: options.jobs }),
						...(options.signal ? { signal: options.signal } : {}),
						...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
					});
					executions += validationBaseline.summary.total;
					cycle.executions += validationBaseline.summary.total;
					ledger("running", null);
				}
				if (!withinInfrastructureBudget(validationBaseline.summary.error, validationBaseline.summary.total)) {
					return { kind: "stop", result: finish(
						"infrastructure-errors",
						`validation baseline has ${validationBaseline.summary.error} infrastructure error(s) in ${validationBaseline.summary.total} runs`,
						cycle,
					) };
				}
				validationSourceEvalRunId = validationBaseline.evalRunId;
			}
			const search = await dependencies.runProposalSearch({
				repositoryDir,
				runsRoot,
				stateRoot,
				projectId: options.projectId,
				approvedSpecId: options.approvedSpecId,
				failureModeId: mode.failureModeId,
				proposalRunIds,
				...(validationSourceEvalRunId ? { validationSourceEvalRunId } : {}),
				...(experimentDesign ? { experimentDesignPath: improvementExperimentDesignPath(runsRoot, loopId) } : {}),
				...(splitRefs
					? { developmentCorpus: splitRefs.authoring, validationCorpus: splitRefs.validation }
					: options.developmentCorpus
						? { developmentCorpus: options.developmentCorpus }
						: {}),
				developmentTasks: validationCorpus?.metadata.taskCount ?? Math.round(evaluation.record.summary.total / options.repetitions),
				repetitions: options.repetitions,
				...(options.jobs === undefined ? {} : { jobs: options.jobs }),
				branchPrefix: `${searchBranchPrefix}${cycleIndex}-`,
				actorId,
				...(options.gate ? { gate: proposalSearchGate(options.gate) } : {}),
				...(options.signal ? { signal: options.signal } : {}),
				...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
				...(options.now ? { now: options.now } : {}),
			});
			executions += search.executions;
			cycle.executions += search.executions;
			cycle.search = search;
				cycle.proposalRunId = proposalRunIds[0]!;
				branchesMade.push(...search.rows.flatMap((row) => (row.branch === null ? [] : [row.branch])));
				lastCycle = Math.max(lastCycle, cycleIndex);
				ledger("running", null);
			// The search compares; it never picks. A non-improved row is evidence,
			// not a release option, so an empty frontier needs no human choice.
			if (search.frontier.length === 0) {
				return { kind: "stop", result: finish(
					"development-verdict",
					"no searched hypothesis reached an improved development verdict",
					cycle,
				) };
			}
			// Whichever improved hypothesis wins, the sealed guardrail and promotion
			// are still the human's.
			return { kind: "stop", result: finish(
				"search-decision-required",
				`${search.frontier.length} of ${search.rows.length} hypotheses are on the frontier`,
				cycle,
			) };
		}

		const proposalRunId = proposalRunIds[0]!;
		cycle.proposalRunId = proposalRunId;

		// ---- refuse a repeat --------------------------------------------------
		// Cycle five must not re-propose what cycle two already lost. The identity
		// of an experiment is its changed-path set plus the failure mode it aimed
		// at; a match against a rejected or non-`improved` attempt is a question
		// that already has an answer, and the budget goes elsewhere.
		const changedPaths = proposalChangedPaths(runsRoot, proposalRunId);
		if (changedPaths.length > 0 && losing.has(experimentSignature(changedPaths, mode.failureModeId))) {
			cycle.skipped = {
				reason: "repeat-of-a-losing-experiment",
				failureModeId: mode.failureModeId,
				changedPaths,
				proposalRunId,
			};
			exhaustedModes.add(mode.failureModeId);
			cycle.note = IMPROVEMENT_CYCLE_SKIP_MESSAGES["repeat-of-a-losing-experiment"];
			cycles.push(cycle);
			lastCycle = Math.max(lastCycle, cycleIndex);
			options.onCycle?.(improvementCycleLine(cycle, options.maxCycles), cycle);
			if (topProposableFailureMode(brief, exhaustedModes) === null) {
				ledger("finished", "experiments-exhausted");
				return { kind: "stop", result: {
					cycles,
					stopReason: "experiments-exhausted",
					stopMessage: IMPROVEMENT_LOOP_STOP_MESSAGES["experiments-exhausted"],
					candidateId,
					loopId,
					finalPassRate,
					executions,
					experimentDesign,
				} };
			}
			ledger("running", null);
			return { kind: "continue" };
		}

		// ---- apply ----------------------------------------------------------
		// On a throwaway branch, never the operator's. The receipt records the
		// operator who confirmed the loop AND `via: improvement-loop`, because
		// nobody read this diff on its own.
		const branch = `${branchPrefix}${cycleIndex}`;
		const applied = dependencies.applyProposal({
			repoDir: repositoryDir,
			runsRoot,
			runId: proposalRunId,
			requestedBranch: branch,
			actor: { kind: "human", id: actorId },
			via: "improvement-loop",
			reason: `Autoloop ${loopId} cycle ${cycleIndex}: apply the proposal for ${mode.failureModeId}.`,
		}, options.now ? { now: options.now } : {});
		cycle.branch = applied.receipt.branch;
		cycle.candidateSha = applied.receipt.candidateSha;
		cycle.changedPaths = [...applied.receipt.paths].sort();
		branchesMade.push(applied.receipt.branch);
		lastCycle = Math.max(lastCycle, cycleIndex);
		ledger("running", null);

		// ---- cheap check ------------------------------------------------------
		const screen = await dependencies.runCheapCheck({
			repositoryDir,
			runsRoot,
			candidateRef: applied.receipt.candidateSha,
			baselineRef: applied.receipt.baseTargetSha,
			sourceEvalRunId: evaluation.record.evalRunId,
			...(options.developmentCorpus ? { developmentCorpus: options.developmentCorpus } : {}),
			...(options.jobs === undefined ? {} : { jobs: options.jobs }),
			...(options.signal ? { signal: options.signal } : {}),
			...(options.now ? { now: options.now } : {}),
		});
		executions += screen.tasks.length;
		cycle.executions += screen.tasks.length;
		cycle.screen = {
			verdict: screen.verdict,
			tasks: screen.tasks.length,
			improved: screen.improved,
			unchanged: screen.unchanged,
			regressed: screen.regressed,
			inconclusive: screen.inconclusive,
			withinErrorBudget: screen.withinErrorBudget,
			screenEvalRunId: screen.screenEvalRunId,
		};
		// Persist spend before making a behavioural decision from the screen. A
		// crash may abandon this already-claimed branch, but it must not erase what
		// the loop paid for.
		ledger("running", null);

		// A flat screen from an over-budget run is inconclusive, not a finding
		// (invariant 9): the verification still gets to answer.
		if (screen.verdict === "flat" && screen.withinErrorBudget) {
			consecutiveFlat += 1;
			cycle.note = `screen flat (${consecutiveFlat} in a row) — no verification spent`;
			cycles.push(cycle);
			lastCycle = Math.max(lastCycle, cycleIndex);
			options.onCycle?.(improvementCycleLine(cycle, options.maxCycles), cycle);
			if (consecutiveFlat >= 2) {
				ledger("finished", "flat-screen-twice");
				return { kind: "stop", result: {
					cycles,
					stopReason: "flat-screen-twice",
					stopMessage: IMPROVEMENT_LOOP_STOP_MESSAGES["flat-screen-twice"],
					candidateId,
					loopId,
					finalPassRate,
					executions,
					experimentDesign,
				} };
			}
			ledger("running", null);
			return { kind: "continue" };
		}
		consecutiveFlat = 0;

		// ---- verification (development only; the sealed gate is the human's) --
		const verified = await dependencies.runAppliedCandidate({
			repositoryDir,
			runsRoot,
			builderRunId: proposalRunId,
			projectId: options.projectId,
			approvedSpec: { stateRoot, specId: options.approvedSpecId },
			repetitions: options.repetitions,
			...(options.developmentCorpus ? { developmentCorpus: options.developmentCorpus } : {}),
			actorId,
			...(options.jobs === undefined ? {} : { jobs: options.jobs }),
			...(options.baselineMaxAgeMs === undefined ? {} : { baselineMaxAgeMs: options.baselineMaxAgeMs }),
			...(options.signal ? { signal: options.signal } : {}),
			...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
		});
		const spent = verified.candidate.summary.total +
			(verified.baselineReused ? 0 : verified.baseline.summary.total);
		executions += spent;
		cycle.executions += spent;
		cycle.verification = {
			candidateId: verified.record.candidateId,
			verdict: verified.compare.gate.verdict,
			scoreDelta: verified.compare.summary.scoreDelta,
			passRateDelta: verified.compare.summary.delta,
			candidatePassRate: verified.compare.summary.candidatePassRate,
		};
		finalPassRate = verified.compare.summary.candidatePassRate;
		if (verified.compare.gate.verdict === "improved") {
			candidateId = verified.record.candidateId;
			candidateIds.splice(0, candidateIds.length, verified.record.candidateId);
		}
		// Checkpoint both arms before interpreting the verdict. Only an improved
		// candidate enters candidateIds; a flat/regressed experiment stays history,
		// never something the CLI tells the operator to review or ship.
		ledger("running", null);
		// This loop's own answers join its memory immediately, so a later cycle
		// cannot re-run the experiment this one just lost.
		if (verified.compare.gate.verdict !== "improved") {
			losing.add(experimentSignature([...applied.receipt.paths].sort(), mode.failureModeId));
			return { kind: "stop", result: finish(
				"development-verdict",
				`development verdict ${verified.compare.gate.verdict}`,
				cycle,
			) };
		}

		if (finalPassRate >= options.until) {
			return { kind: "stop", result: finish("target-reached", `${percent(finalPassRate)} ≥ ${percent(options.until)}`, cycle) };
		}
		// A verified candidate is a release decision boundary. Starting another
		// cycle from it would hide the earlier changes from the final matched and
		// sealed baseline, so the public loop stops instead of claiming to compound.
		return { kind: "stop", result: finish(
			"sealed-gate-required",
			`candidate ${verified.record.candidateId} verified · awaiting your decision`,
			cycle,
		) };
	};

	for (let cycleIndex = lastCycle + 1; cycleIndex <= options.maxCycles; cycleIndex += 1) {
		abortIfRequested(options.signal);
		const outcome = await runCycle(cycleIndex);
		if (outcome.kind === "stop") return outcome.result;
	}

	ledger("finished", "max-cycles");
	return {
		cycles,
		stopReason: "max-cycles",
		stopMessage: IMPROVEMENT_LOOP_STOP_MESSAGES["max-cycles"],
		candidateId,
		loopId,
		finalPassRate,
		executions,
		experimentDesign,
	};
}

export interface RecordedProposalAuthorOptions {
	stateRoot: string;
	runsRoot: string;
	projectId: string;
}

/**
 * The shipped proposal source: the next Builder proposal already recorded
 * against this cycle's exact development SURFACE, neither applied nor
 * discarded.
 *
 * Surface, not eval-run id. Every `ahde improve` invocation mints a fresh
 * EvalRun, so binding a proposal to `source.evalRunId === this run` meant no
 * proposal a human prepared in the conversation before the command could ever
 * match, and any prepared after a stop was stale on the next invocation. What
 * actually has to be unchanged for the proposal to still be about this problem
 * is: the Target revision it was written against, the development basket
 * (dataset label + hash), the eval suite hash, and the failure mode it attests
 * to. Those are compared here; the eval run id is not.
 *
 * This fallback reads recorded proposals without making model requests.
 * Builder Pi instead attaches its bounded author through the same
 * {@link ImprovementProposalAuthor} seam; both use the canonical apply path.
 */
export function recordedBuilderProposalAuthor(
	options: RecordedProposalAuthorOptions,
): ImprovementProposalAuthor {
	const used = new Set<string>();
	const stateRoot = resolve(options.stateRoot);
	const runsRoot = resolve(options.runsRoot);
	return (request) => {
		let admissions: ReturnType<typeof listBuilderProposalAdmissions>;
		try {
			admissions = listBuilderProposalAdmissions(stateRoot, options.projectId);
		} catch {
			admissions = [];
		}
		// The best refusal wins: "the dataset changed" is a more useful answer
		// than "nothing is recorded", so the reasons are ranked by how specific
		// they are about what moved.
		const RANK: Readonly<Record<RecordedProposalStaleReason, number>> = {
			"no-recorded-proposal": 0,
			"already-used": 1,
			"no-attested-basis": 2,
			"failure-mode-differs": 3,
			"spec-changed": 4,
			"target-revision-moved": 5,
			"suite-changed": 6,
			"dataset-changed": 7,
		};
		let best: RecordedProposalStaleReason = admissions.length === 0 ? "no-recorded-proposal" : "already-used";
		const note = (reason: RecordedProposalStaleReason): void => {
			if (RANK[reason] > RANK[best]) best = reason;
		};
		for (const admission of admissions) {
			if (used.has(admission.runId)) continue;
			let record: ReturnType<typeof loadBuilderProposalRun>;
			try {
				record = loadBuilderProposalRun(runsRoot, admission.runId);
			} catch {
				continue;
			}
			if (record.result.status !== "completed" || record.result.proposal?.decision !== "propose") continue;
			// Apply and Discard are terminal and mutually exclusive (invariant 20):
			// a proposal that already has either is not the loop's to try.
			try {
				assertBuilderProposalNotDiscarded(runsRoot, admission.runId);
			} catch {
				continue;
			}
			try {
				loadBuilderApplyReceipt(runsRoot, admission.runId);
				continue;
			} catch {
				// No apply receipt: this one is still open.
			}
			const attestation = record.request.sourceAttestation;
			const basis = record.request.proposalBasis;
			if (!attestation || !basis) {
				note("no-attested-basis");
				continue;
			}
			if (record.request.approvedSpec?.specId !== request.approvedSpecId) {
				note("spec-changed");
				continue;
			}
			// ---- the surface-binding rule, in full ----------------------------
			if (
				record.request.baseTargetSha !== request.surface.targetGitSha ||
				attestation.targetGitSha !== request.surface.targetGitSha ||
				attestation.targetId !== request.surface.targetId
			) {
				note("target-revision-moved");
				continue;
			}
			if (
				attestation.dataset !== request.surface.dataset ||
				attestation.datasetHash !== request.surface.datasetHash
			) {
				note("dataset-changed");
				continue;
			}
			if (attestation.suiteHash !== request.surface.suiteHash) {
				note("suite-changed");
				continue;
			}
			if (!basis.failureModes.some((attested) => attested.failureModeId === request.failureMode.failureModeId)) {
				note("failure-mode-differs");
				continue;
			}
			used.add(admission.runId);
			return { kind: "recorded", builderRunId: admission.runId };
		}
		return {
			kind: "no-change",
			staleness: best,
			reason:
				`${RECORDED_PROPOSAL_STALE_MESSAGES[best]}. ` +
				`This cycle wants a proposal on ${request.surface.dataset} ` +
				`(${request.surface.datasetHash.slice(0, 15)}\u2026), suite ${request.surface.suiteHash.slice(0, 15)}\u2026, ` +
				`Target ${request.surface.targetGitSha.slice(0, 12)}, for ${request.failureMode.failureModeId}. ` +
				IMPROVEMENT_LOOP_AUTHOR_DISCLOSURE,
		};
	};
}

/**
 * Executions one planned loop is expected to spend, for the routine cost guard.
 * A cycle that compares several hypotheses screens and verifies each of them,
 * so the estimate the operator is shown scales with `candidates` — a search
 * must never cost more than the one question they answered.
 */
export function plannedImprovementExecutions(input: {
	developmentTasks: number;
	/** Used by blind multi-hypothesis search; omitted preserves single-surface pricing. */
	authoringTasks?: number;
	validationTasks?: number;
	repetitions: number;
	maxCycles: number;
	candidates?: number;
}): number {
	const candidates = Math.max(1, Math.trunc(input.candidates ?? 1));
	if (candidates > 1 && input.authoringTasks !== undefined && input.validationTasks !== undefined) {
		const authoring = Math.max(0, Math.trunc(input.authoringTasks));
		const validation = Math.max(0, Math.trunc(input.validationTasks));
		const authoringRun = authoring * input.repetitions;
		const validationBaseline = validation * input.repetitions;
		const candidateSearch = candidates * (validation + 2 * validation * input.repetitions);
		return Math.max(0, Math.trunc(input.maxCycles)) * (authoringRun + validationBaseline + candidateSearch);
	}
	const run = input.developmentTasks * input.repetitions;
	const screen = input.developmentTasks;
	const verification = 2 * input.developmentTasks * input.repetitions;
	return Math.max(0, Math.trunc(input.maxCycles)) * (run + candidates * (screen + verification));
}
