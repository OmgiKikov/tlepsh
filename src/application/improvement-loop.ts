/**
 * The autoloop, inside the gates.
 *
 * One cycle is: run → diagnose → pick the top proposable failure mode →
 * author a proposal through the existing application chain → apply it on
 * `candidate/auto-<n>` → cheap check → full development verification if the
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

import { resolve } from "node:path";
import { compileFailureBundle } from "../bundle.js";
import type { CandidateProposal } from "../builders/adapters.js";
import type { CorpusRef } from "../corpus.js";
import { loadCorpus } from "../corpus.js";
import { diagnoseEvalRun } from "../diagnosis.js";
import type { GateVerdict } from "../domain/comparison-gate.js";
import { withinInfrastructureBudget } from "../domain/comparison-gate.js";
import { runSuite, type EvalRunRecord } from "../eval.js";
import { loadTarget } from "../manifest.js";
import type { RunEventListener } from "../run-events.js";
import type {
	WorkbenchDecisionInput,
	WorkbenchHumanGate,
} from "../workbench/types.js";
import { recordBuilderAuthoredProposal } from "./builder-authoring.js";
import { runAppliedBuilderCandidate } from "./builder-candidate.js";
import {
	applyBuilderProposal,
	listBuilderProposalAdmissions,
	loadBuilderApplyReceipt,
	loadBuilderProposalRun,
} from "./builder-proposal.js";
import { assertBuilderProposalNotDiscarded } from "./builder-discard.js";
import { CANDIDATE_SCOPE_POLICY } from "./candidate-experiment.js";
import { runCheapCheck, type CheapCheckResult } from "./cheap-check.js";
import { targetWithDevelopmentCorpus } from "./corpus-target.js";
import {
	compileImprovementBrief,
	deriveEvidenceLinkedProposalSelection,
	type EvidenceLinkedProposalSelection,
	type FailureMode,
	type ImprovementBrief,
} from "./improvement-brief.js";

/** Bounds a single `ahde improve` invocation. */
export const MAX_IMPROVEMENT_CYCLES = 10;

/**
 * Every decision that creates release authority or asks for human judgement.
 * The loop refuses all of them; `apply-proposal` is deliberately absent
 * because applying on `candidate/auto-<n>` is the work the operator asked for.
 */
export const IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS: readonly WorkbenchDecisionInput["kind"][] = [
	"scaffold-target",
	"configure-target",
	"approve-spec",
	"publish-corpus",
	"import-dataset",
	"start-testing",
	"review-candidate",
	"promote-candidate",
	"reject-candidate",
	"adopt-candidate",
	"continue-cycle",
	"abandon-candidate",
	"discard-proposal",
	"ship",
];

export class ImprovementLoopForbiddenDecisionError extends Error {
	constructor(readonly decision: string) {
		super(
			`the improvement loop may not decide ${decision}; that stays with the human. ` +
			"Stop the loop and make it yourself.",
		);
		this.name = "ImprovementLoopForbiddenDecisionError";
	}
}

/**
 * The gate the loop hands to anything it calls. A forbidden decision is not
 * declined, it throws: a loop that reaches one is a bug, not a request.
 */
export function improvementLoopGate(gate: WorkbenchHumanGate): WorkbenchHumanGate {
	const forbidden = new Set<string>(IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS);
	return {
		async confirm(confirmation, signal) {
			if (forbidden.has(confirmation.kind)) {
				throw new ImprovementLoopForbiddenDecisionError(confirmation.kind);
			}
			return gate.confirm(confirmation, signal);
		},
		async selectSealed() {
			// The sealed holdout answers one question — may this ship — and the
			// loop never asks it.
			throw new ImprovementLoopForbiddenDecisionError("sealed holdout selection");
		},
	};
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
	| "no-change-proposed";

export const IMPROVEMENT_LOOP_STOP_MESSAGES: Readonly<Record<ImprovementLoopStopReason, string>> = {
	"target-reached": "the target pass rate is reached",
	"max-cycles": "the cycle budget is spent",
	"development-verdict": "the development verdict is not `improved`",
	"flat-screen-twice": "two cheap checks in a row found nothing",
	"infrastructure-errors": "infrastructure errors are over the budget, so the evidence is inconclusive",
	"sealed-gate-required": "a verified candidate is ready — the sealed guardrail and the promotion are yours",
	"no-proposable-failure-mode": "no failure mode is eligible for a harness change",
	"no-change-proposed": "the proposal author produced no change",
};

export interface ImprovementProposalRequest {
	cycle: number;
	repositoryDir: string;
	runsRoot: string;
	stateRoot: string;
	projectId: string;
	approvedSpecId: string;
	baseTargetSha: string;
	evalRunId: string;
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

export type ImprovementProposalDecision =
	/** A proposal to record through the canonical Builder chain. */
	| { kind: "propose"; proposal: CandidateProposal }
	/** An already-recorded, still-open Builder proposal to apply. */
	| { kind: "recorded"; builderRunId: string }
	/** Nothing to try this cycle. */
	| { kind: "no-change"; reason: string };

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
	evalRunId: string;
	/** True when this cycle measured the base revision that an earlier cycle already measured. */
	evalReused: boolean;
	pass: number;
	total: number;
	passRate: number;
	failureModeId: string | null;
	proposalRunId: string | null;
	branch: string | null;
	candidateSha: string | null;
	screen: ImprovementLoopScreen | null;
	verification: ImprovementLoopVerification | null;
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
	finalPassRate: number;
	executions: number;
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
	jobs?: number;
	branchPrefix?: string;
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
};

function abortIfRequested(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("improvement loop aborted");
}

/**
 * The mode worth spending a cycle on: proposable, then widest blast radius,
 * then most reproducible, then the stable id so the choice never depends on
 * map order.
 */
export function topProposableFailureMode(brief: ImprovementBrief): FailureMode | null {
	const proposable = brief.modes.filter((mode) => mode.decision === "propose-harness-change");
	if (proposable.length === 0) return null;
	return [...proposable].sort((left, right) =>
		right.impact.taskCoverageBps - left.impact.taskCoverageBps ||
		right.impact.reproductionBps - left.impact.reproductionBps ||
		right.impact.failedOccurrences - left.impact.failedOccurrences ||
		(left.failureModeId < right.failureModeId ? -1 : left.failureModeId > right.failureModeId ? 1 : 0),
	)[0]!;
}

function percent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

/** One progress line per cycle, in the shape `run-progress.ts` uses on stderr. */
export function improvementCycleLine(cycle: ImprovementLoopCycle, maxCycles: number): string {
	const parts = [
		`AHDE improve cycle ${cycle.cycle}/${maxCycles}`,
		`run ${cycle.pass}/${cycle.total} ${percent(cycle.passRate)}${cycle.evalReused ? " (reused)" : ""}`,
	];
	if (cycle.failureModeId) parts.push(`mode ${cycle.failureModeId}`);
	if (cycle.branch) parts.push(`branch ${cycle.branch}`);
	if (cycle.screen) {
		parts.push(
			`screen ${cycle.screen.verdict} ${cycle.screen.improved}/${cycle.screen.tasks}` +
			(cycle.screen.withinErrorBudget ? "" : " (inconclusive)"),
		);
	}
	if (cycle.verification) {
		const delta = cycle.verification.scoreDelta;
		parts.push(`verify ${cycle.verification.verdict} ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}pp`);
	}
	parts.push(cycle.note);
	return parts.join(" · ");
}

/** The compact per-cycle table the loop hands back. */
export function renderImprovementLoopTable(result: ImprovementLoopResult): string {
	const header = "| cycle | pass rate | failure mode | branch | screen | verification |";
	const divider = "|---|---|---|---|---|---|";
	const rows = result.cycles.map((cycle) => {
		const screen = cycle.screen
			? `${cycle.screen.verdict} ${cycle.screen.improved}/${cycle.screen.tasks}` +
				(cycle.screen.withinErrorBudget ? "" : " · inconclusive")
			: "—";
		const verification = cycle.verification
			? `${cycle.verification.verdict} ${cycle.verification.scoreDelta >= 0 ? "+" : ""}` +
				`${(cycle.verification.scoreDelta * 100).toFixed(1)}pp`
			: "skipped";
		return `| ${cycle.cycle} | ${percent(cycle.passRate)}${cycle.evalReused ? " (reused)" : ""} | ` +
			`${cycle.failureModeId ?? "—"} | ${cycle.branch ?? "—"} | ${screen} | ${verification} |`;
	});
	return [
		header,
		divider,
		...rows,
		"",
		`Stopped: ${result.stopMessage}.`,
		`Target executions spent: ${result.executions}.`,
		result.candidateId
			? `Candidate ${result.candidateId} is verified on development evidence. Promotion is yours: ` +
				"`ship it` runs the sealed guardrail and the release decisions."
			: "No candidate reached a development verdict; nothing is waiting on a release decision.",
	].join("\n");
}

interface CycleEval {
	record: EvalRunRecord;
	reused: boolean;
}

export async function runImprovementLoop(
	options: ImprovementLoopOptions,
	dependenciesInput: Partial<ImprovementLoopDependencies> = {},
): Promise<ImprovementLoopResult> {
	const dependencies: ImprovementLoopDependencies = { ...DEFAULT_DEPENDENCIES, ...dependenciesInput };
	const repositoryDir = resolve(options.repositoryDir);
	const runsRoot = resolve(options.runsRoot);
	const stateRoot = resolve(options.stateRoot);
	const branchPrefix = options.branchPrefix ?? "candidate/auto-";
	const actorId = options.actorId ?? "local-user";
	if (!Number.isFinite(options.until) || options.until < 0 || options.until > 1) {
		throw new Error(`--until must be a pass rate between 0 and 1, got ${options.until}`);
	}
	if (!Number.isInteger(options.maxCycles) || options.maxCycles < 1 || options.maxCycles > MAX_IMPROVEMENT_CYCLES) {
		throw new Error(`--max-cycles must be between 1 and ${MAX_IMPROVEMENT_CYCLES}, got ${options.maxCycles}`);
	}

	const cycles: ImprovementLoopCycle[] = [];
	let executions = 0;
	let consecutiveFlat = 0;
	let candidateId: string | null = null;
	let finalPassRate = 0;
	let cached: CycleEval | null = null;
	let cachedForSha: string | null = null;

	const resolveTarget = () => {
		const base = dependencies.loadTarget(repositoryDir);
		const corpus = options.developmentCorpus ? dependencies.loadCorpus(options.developmentCorpus) : null;
		return corpus ? targetWithDevelopmentCorpus(base, corpus) : base;
	};

	const finish = (
		reason: ImprovementLoopStopReason,
		note: string,
		partial?: ImprovementLoopCycle,
	): ImprovementLoopResult => {
		if (partial) {
			partial.note = note;
			cycles.push(partial);
			options.onCycle?.(improvementCycleLine(partial, options.maxCycles), partial);
		}
		return {
			cycles,
			stopReason: reason,
			stopMessage: IMPROVEMENT_LOOP_STOP_MESSAGES[reason],
			candidateId,
			finalPassRate,
			executions,
		};
	};

	for (let cycleIndex = 1; cycleIndex <= options.maxCycles; cycleIndex += 1) {
		abortIfRequested(options.signal);
		const target = resolveTarget();
		const cycle: ImprovementLoopCycle = {
			cycle: cycleIndex,
			evalRunId: "",
			evalReused: false,
			pass: 0,
			total: 0,
			passRate: 0,
			failureModeId: null,
			proposalRunId: null,
			branch: null,
			candidateSha: null,
			screen: null,
			verification: null,
			executions: 0,
			note: "",
		};

		// ---- run -----------------------------------------------------------
		let evaluation: CycleEval;
		if (cached && cachedForSha === target.gitSha) {
			evaluation = { record: cached.record, reused: true };
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
		}
		cycle.evalRunId = evaluation.record.evalRunId;
		cycle.evalReused = evaluation.reused;
		cycle.pass = evaluation.record.summary.pass;
		cycle.total = evaluation.record.summary.total;
		cycle.passRate = evaluation.record.summary.allPassRate;
		finalPassRate = cycle.passRate;

		if (!withinInfrastructureBudget(evaluation.record.summary.error, evaluation.record.summary.total)) {
			return finish(
				"infrastructure-errors",
				`${evaluation.record.summary.error} infrastructure error(s) in ${evaluation.record.summary.total} runs`,
				cycle,
			);
		}
		if (cycle.passRate >= options.until) {
			return finish("target-reached", `${percent(cycle.passRate)} ≥ ${percent(options.until)}`, cycle);
		}

		// ---- diagnose and pick ---------------------------------------------
		const diagnosis = dependencies.diagnoseEval(runsRoot, evaluation.record.evalRunId);
		const brief = dependencies.compileImprovementBrief(runsRoot, diagnosis);
		const mode = brief.proposalEligible ? topProposableFailureMode(brief) : null;
		if (!mode) {
			return finish("no-proposable-failure-mode", brief.headline, cycle);
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

		// ---- author ---------------------------------------------------------
		const failureBundlePath = dependencies.compileFailureBundle(target, evaluation.record, runsRoot);
		const decision = await options.author({
			...(options.gate ? { gate: improvementLoopGate(options.gate) } : {}),
			cycle: cycleIndex,
			repositoryDir,
			runsRoot,
			stateRoot,
			projectId: options.projectId,
			approvedSpecId: options.approvedSpecId,
			baseTargetSha: target.gitSha,
			evalRunId: evaluation.record.evalRunId,
			diagnosisId: diagnosis.diagnosisId,
			brief,
			failureMode: mode,
			selection,
			failureBundlePath,
			...(options.signal ? { signal: options.signal } : {}),
		});
		abortIfRequested(options.signal);
		if (decision.kind === "no-change") {
			return finish("no-change-proposed", decision.reason, cycle);
		}

		let proposalRunId: string;
		if (decision.kind === "recorded") {
			proposalRunId = decision.builderRunId;
		} else {
			const recorded = await dependencies.recordProposal({
				proposal: decision.proposal,
				targetDir: repositoryDir,
				allowedPaths: [...CANDIDATE_SCOPE_POLICY.allowed],
				approvedSpec: { stateRoot, projectId: options.projectId, specId: options.approvedSpecId },
				runsRoot,
				timeoutMs: 30_000,
				sourceEvalRunId: evaluation.record.evalRunId,
				proposalBasis,
				...(options.signal ? { signal: options.signal } : {}),
			});
			if (recorded.record.result.status !== "completed" || recorded.record.result.proposal?.decision !== "propose") {
				return finish("no-change-proposed", "the recorded proposal carries no change", cycle);
			}
			proposalRunId = recorded.record.runId;
		}
		cycle.proposalRunId = proposalRunId;

		// ---- apply ----------------------------------------------------------
		const branch = `${branchPrefix}${cycleIndex}`;
		const applied = dependencies.applyProposal({
			repoDir: repositoryDir,
			runsRoot,
			runId: proposalRunId,
			requestedBranch: branch,
			actor: { kind: "human", id: actorId },
			reason: `Autoloop cycle ${cycleIndex}: apply the proposal for ${mode.failureModeId}.`,
		}, options.now ? { now: options.now } : {});
		cycle.branch = applied.receipt.branch;
		cycle.candidateSha = applied.receipt.candidateSha;

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

		// A flat screen from an over-budget run is inconclusive, not a finding
		// (invariant 9): the verification still gets to answer.
		if (screen.verdict === "flat" && screen.withinErrorBudget) {
			consecutiveFlat += 1;
			cycle.note = `screen flat (${consecutiveFlat} in a row) — no verification spent`;
			cycles.push(cycle);
			options.onCycle?.(improvementCycleLine(cycle, options.maxCycles), cycle);
			if (consecutiveFlat >= 2) {
				return {
					cycles,
					stopReason: "flat-screen-twice",
					stopMessage: IMPROVEMENT_LOOP_STOP_MESSAGES["flat-screen-twice"],
					candidateId,
					finalPassRate,
					executions,
				};
			}
			continue;
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
			...(options.signal ? { signal: options.signal } : {}),
			...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
		});
		const spent = verified.baseline.summary.total + verified.candidate.summary.total;
		executions += spent;
		cycle.executions += spent;
		candidateId = verified.record.candidateId;
		cycle.verification = {
			candidateId: verified.record.candidateId,
			verdict: verified.compare.gate.verdict,
			scoreDelta: verified.compare.summary.scoreDelta,
			passRateDelta: verified.compare.summary.delta,
			candidatePassRate: verified.compare.summary.candidatePassRate,
		};
		finalPassRate = verified.compare.summary.candidatePassRate;

		if (verified.compare.gate.verdict !== "improved") {
			return finish(
				"development-verdict",
				`development verdict ${verified.compare.gate.verdict}`,
				cycle,
			);
		}
		if (finalPassRate >= options.until) {
			return finish("target-reached", `${percent(finalPassRate)} ≥ ${percent(options.until)}`, cycle);
		}
		// An improved, unpromoted candidate is as far as measurement goes: making
		// it the next baseline means promoting and adopting it, and both are the
		// human's, behind the sealed guardrail.
		return finish(
			"sealed-gate-required",
			`candidate ${verified.record.candidateId} improved development evidence`,
			cycle,
		);
	}

	return {
		cycles,
		stopReason: "max-cycles",
		stopMessage: IMPROVEMENT_LOOP_STOP_MESSAGES["max-cycles"],
		candidateId,
		finalPassRate,
		executions,
	};
}

export interface RecordedProposalAuthorOptions {
	stateRoot: string;
	runsRoot: string;
	projectId: string;
}

/**
 * The shipped proposal source: the next Builder proposal already recorded
 * against this cycle's exact evidence, neither applied nor discarded.
 *
 * A host does not author harness text. Authoring stays with Builder Pi; the
 * loop applies, screens and verifies what the Builder wrote. Wiring a headless
 * Builder into the {@link ImprovementProposalAuthor} seam is what turns this
 * into a hands-free loop.
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
		for (const admission of admissions) {
			if (used.has(admission.runId)) continue;
			let record: ReturnType<typeof loadBuilderProposalRun>;
			try {
				record = loadBuilderProposalRun(runsRoot, admission.runId);
			} catch {
				continue;
			}
			if (record.result.status !== "completed" || record.result.proposal?.decision !== "propose") continue;
			if (record.request.baseTargetSha !== request.baseTargetSha) continue;
			if (record.request.source?.evalRunId !== request.evalRunId) continue;
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
				// No apply receipt: this is the next one to try.
			}
			used.add(admission.runId);
			return { kind: "recorded", builderRunId: admission.runId };
		}
		return {
			kind: "no-change",
			reason:
				"no unapplied Builder proposal is bound to this evidence. Author one in `ahde` (say \u201cfix it\u201d) " +
				"before asking the loop to screen and verify it.",
		};
	};
}

/** Executions one planned loop is expected to spend, for the routine cost guard. */
export function plannedImprovementExecutions(input: {
	developmentTasks: number;
	repetitions: number;
	maxCycles: number;
}): number {
	const run = input.developmentTasks * input.repetitions;
	const screen = input.developmentTasks;
	const verification = 2 * input.developmentTasks * input.repetitions;
	return Math.max(0, Math.trunc(input.maxCycles)) * (run + screen + verification);
}
