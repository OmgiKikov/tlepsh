/**
 * Search, not one guess.
 *
 * One failure mode, two to four hypotheses, verified together, and a human who
 * picks. A single proposal per failure mode makes every cycle a coin flip: the
 * Builder writes one change, the gate says `unchanged`, and the budget is gone
 * with nothing learned about the neighbouring hypotheses. This module spends
 * the same money on several and hands back a Pareto table.
 *
 * What it does: apply each proposal on its own `candidate/search-<n>` branch,
 * screen it with the ordinary cheap check, and pay for the full matched
 * development verification only where the screen found something. What it never
 * does: promote, adopt, publish, approve, review, or open the sealed holdout.
 * {@link proposalSearchGate} makes that structural rather than a promise — the
 * gate it hands to anything nested throws instead of asking, exactly the way
 * `improvementLoopGate` does. Sealed verification is not part of the search:
 * the human picks one candidate and that one goes through the unchanged sealed
 * gate and promotion.
 *
 * The evidence rules are inherited, not re-invented. Every screen is a
 * {@link runCheapCheck}, so it carries all four of that module's exclusions
 * (the `solo` label that is never reused as a baseline and can never stand in
 * for a candidate arm, the durable `runs/screens/` marker, no comparison gate,
 * and the refusal to screen a screen or sealed evidence). Every verification is
 * an ordinary development candidate experiment whose candidate arm carries the
 * `candidate` label, which `findReusableBaseline` never asks for. No new
 * receipt type exists here: the search writes apply receipts, screen records
 * and candidate records, all of them shapes that already existed.
 */

import { resolve } from "node:path";
import type { CorpusRef } from "../corpus.js";
import type { GateVerdict } from "../domain/comparison-gate.js";
import { loadTarget } from "../manifest.js";
import type { RunEventListener } from "../run-events.js";
import type { WorkbenchDecisionInput, WorkbenchHumanGate } from "../workbench/types.js";
import { runAppliedBuilderCandidate } from "./builder-candidate.js";
import {
	applyBuilderProposal,
	loadBuilderApplyReceipt,
	loadBuilderProposalRun,
} from "./builder-proposal.js";
import { assertBuilderProposalNotDiscarded } from "./builder-discard.js";
import { runCheapCheck } from "./cheap-check.js";

/** Hypotheses one search may compare. Fewer is a guess; more is a budget hole. */
export const MIN_SEARCH_CANDIDATES = 2;
export const MAX_SEARCH_CANDIDATES = 4;

/**
 * Every decision that creates release authority or asks for human judgement.
 * The search refuses all of them. `apply-proposal` is deliberately absent: the
 * search applies each hypothesis on its own throwaway branch, which is the work
 * the operator asked for, and touches no branch the operator stands on.
 */
export const PROPOSAL_SEARCH_FORBIDDEN_DECISIONS: readonly WorkbenchDecisionInput["kind"][] = [
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

export class ProposalSearchForbiddenDecisionError extends Error {
	constructor(readonly decision: string) {
		super(
			`the proposal search may not decide ${decision}; that stays with the human. ` +
			"Read the table, pick a candidate, and decide it yourself.",
		);
		this.name = "ProposalSearchForbiddenDecisionError";
	}
}

export class ProposalSearchError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(`proposal search rejected: ${message}`, options);
		this.name = "ProposalSearchError";
	}
}

/**
 * The gate the search hands to anything it calls. A forbidden decision is not
 * declined, it throws: a search that reaches one is a bug, not a request.
 */
export function proposalSearchGate(gate: WorkbenchHumanGate): WorkbenchHumanGate {
	const forbidden = new Set<string>(PROPOSAL_SEARCH_FORBIDDEN_DECISIONS);
	return {
		async confirm(confirmation, signal) {
			if (forbidden.has(confirmation.kind)) {
				throw new ProposalSearchForbiddenDecisionError(confirmation.kind);
			}
			return gate.confirm(confirmation, signal);
		},
		async selectSealed() {
			// Sealed verification is not part of a search. The human picks one
			// candidate and that one meets the unchanged sealed gate.
			throw new ProposalSearchForbiddenDecisionError("sealed holdout selection");
		},
	};
}

/** Why one hypothesis did not reach a matched verification. Never a call-site string. */
export type ProposalSearchSkipReason =
	/** The Builder run carries no completed `propose`, or was already applied or discarded. */
	| "proposal-not-eligible"
	/** Its attested basis does not target the failure mode the search is about. */
	| "different-failure-mode"
	/** It was authored against another base revision or another source evaluation. */
	| "different-evidence"
	/** Applying it on its own branch failed. */
	| "apply-failed"
	/** The screen found nothing: no previously failing case now passes. */
	| "flat-screen"
	/** The verification would have run past the search's one estimate. */
	| "execution-budget"
	/** The matched verification itself could not complete. */
	| "verification-failed";

export const PROPOSAL_SEARCH_SKIP_MESSAGES: Readonly<Record<ProposalSearchSkipReason, string>> = {
	"proposal-not-eligible": "the proposal carries no applicable change, or was already applied or discarded",
	"different-failure-mode": "the proposal targets a different failure mode than this search",
	"different-evidence": "the proposal was authored against different evidence than this search",
	"apply-failed": "the change could not be applied on its own branch",
	"flat-screen": "the cheap screen found nothing, so no verification was spent",
	"execution-budget": "the search's execution estimate was already spent",
	"verification-failed": "the matched verification could not complete",
};

export type ProposalSearchStopReason =
	/** Every hypothesis reached a verdict or an honest skip. */
	| "search-complete"
	/** The estimate ran out before every hypothesis was reached. */
	| "execution-budget-exhausted";

export const PROPOSAL_SEARCH_STOP_MESSAGES: Readonly<Record<ProposalSearchStopReason, string>> = {
	"search-complete": "every candidate reached a verdict or a stated skip",
	"execution-budget-exhausted": "the search's execution estimate ran out before every candidate was reached",
};

export interface ProposalSearchScreen {
	verdict: "promising" | "flat";
	tasks: number;
	improved: number;
	unchanged: number;
	regressed: number;
	inconclusive: number;
	withinErrorBudget: boolean;
	/** A screen's EvalRun. Never a baseline, never a candidate arm, never evidence. */
	screenEvalRunId: string;
}

export interface ProposalSearchDevelopment {
	verdict: GateVerdict;
	/** Mean paired score delta the interval brackets. */
	scoreDelta: number;
	confidence95: { low: number; high: number };
	passRateDelta: number;
	candidatePassRate: number;
	tasks: number;
	repetitions: number;
	/** Candidate over baseline. Rendered beside the verdict, never gating. */
	costRatio: number | null;
	latencyRatio: number | null;
	tokenRatio: number | null;
}

export interface ProposalSearchRow {
	/** 1-based position, which is also the `candidate/search-<n>` branch number. */
	ordinal: number;
	proposalRunId: string;
	branch: string | null;
	candidateSha: string | null;
	candidateId: string | null;
	/** Exactly what the applied diff replaced, from the apply receipt. */
	changedPaths: string[];
	status: "verified" | "screened-out" | "skipped";
	skipReason: ProposalSearchSkipReason | null;
	screen: ProposalSearchScreen | null;
	development: ProposalSearchDevelopment | null;
	/** True when another verified candidate is at least as good on score and cost. */
	dominated: boolean;
	/** The lowest ordinal that dominates this row. */
	dominatedBy: number | null;
	/** Target executions this row actually spent. */
	executions: number;
}

export interface ProposalSearchResult {
	failureModeId: string;
	sourceEvalRunId: string;
	baseTargetSha: string;
	rows: ProposalSearchRow[];
	/** Non-dominated verified ordinals, best first. Empty when nothing verified. */
	frontier: number[];
	stopReason: ProposalSearchStopReason;
	stopMessage: string;
	/** Target executions the search spent. */
	executions: number;
	/** What one estimate said it would cost. */
	plannedExecutions: number;
	/** Every EvalRun this search produced as a screen; none of them is evidence. */
	screenEvalRunIds: string[];
}

export interface ProposalSearchOptions {
	repositoryDir: string;
	runsRoot: string;
	stateRoot: string;
	projectId: string;
	approvedSpecId: string;
	/** The one failure mode every hypothesis in this search must target. */
	failureModeId: string;
	/** 2..4 recorded Builder proposal runs, each an unapplied hypothesis. */
	proposalRunIds: readonly string[];
	/** The published development corpus every arm measures on. */
	developmentCorpus?: CorpusRef;
	/** Cases one arm runs. The manifest surface is the fallback. */
	developmentTasks?: number;
	repetitions: number;
	jobs?: number;
	/** Branch prefix; the ordinal is appended. */
	branchPrefix?: string;
	/**
	 * The one estimate the whole search runs under. A candidate whose
	 * verification would run past it is skipped with `execution-budget`, never
	 * silently trimmed.
	 */
	executionBudget?: number;
	actorId?: string;
	/**
	 * Handed to nothing today; kept so a caller that already wrapped a gate can
	 * pass it and get the same refusal surface the loop has. The search itself
	 * asks for nothing.
	 */
	gate?: WorkbenchHumanGate;
	/** One line per candidate, host-rendered. */
	onCandidate?: (line: string, row: ProposalSearchRow) => void;
	onRunEvent?: RunEventListener;
	signal?: AbortSignal;
	now?: () => string;
}

export interface ProposalSearchDependencies {
	loadTarget: typeof loadTarget;
	loadProposalRun: typeof loadBuilderProposalRun;
	loadApplyReceipt: typeof loadBuilderApplyReceipt;
	assertNotDiscarded: typeof assertBuilderProposalNotDiscarded;
	applyProposal: typeof applyBuilderProposal;
	runCheapCheck: typeof runCheapCheck;
	runAppliedCandidate: typeof runAppliedBuilderCandidate;
}

const DEFAULT_DEPENDENCIES: ProposalSearchDependencies = {
	loadTarget,
	loadProposalRun: loadBuilderProposalRun,
	loadApplyReceipt: loadBuilderApplyReceipt,
	assertNotDiscarded: assertBuilderProposalNotDiscarded,
	applyProposal: applyBuilderProposal,
	runCheapCheck,
	runAppliedCandidate: runAppliedBuilderCandidate,
};

function abortIfRequested(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("proposal search aborted");
}

/**
 * Executions one planned search is expected to spend: per candidate, one screen
 * over the previously failing cases plus both verification arms. The first
 * verification pays for its baseline arm and the rest may reuse it, so this is
 * an upper bound the cost guard can quote honestly.
 */
export function plannedProposalSearchExecutions(input: {
	developmentTasks: number;
	repetitions: number;
	candidates: number;
}): number {
	const tasks = Math.max(0, Math.trunc(input.developmentTasks));
	const repetitions = Math.max(0, Math.trunc(input.repetitions));
	const candidates = Math.max(0, Math.trunc(input.candidates));
	return candidates * (tasks + 2 * tasks * repetitions);
}

/**
 * The cost axis. A ratio is null when the baseline arm spent nothing
 * measurable, and a candidate nobody can price is treated as costing exactly
 * what the baseline did rather than being quietly ranked best or worst.
 */
function costKey(development: ProposalSearchDevelopment): number {
	return development.costRatio ?? 1;
}

/**
 * Domination, exactly.
 *
 * Row X is dominated by row Y when both are verified, Y is at least as good on
 * both axes — `Y.scoreDelta >= X.scoreDelta` and `Y.cost <= X.cost` — and
 * either Y is strictly better on one of them, or Y ties on both and comes
 * first. The tie-break by ordinal is what keeps the frontier non-empty when two
 * hypotheses measure identically; without it, "worse or equal on both" would
 * mark every member of a tie as dominated and leave the human nothing to pick.
 *
 * Only verified rows take part. A screened-out or skipped hypothesis has no
 * verdict, so it can neither dominate nor be dominated: it is reported with its
 * reason instead.
 */
function markDomination(rows: ProposalSearchRow[]): number[] {
	const verified = rows.filter((row) => row.status === "verified" && row.development !== null);
	for (const row of verified) {
		const mine = row.development as ProposalSearchDevelopment;
		let dominatedBy: number | null = null;
		for (const other of verified) {
			if (other === row) continue;
			const theirs = other.development as ProposalSearchDevelopment;
			const atLeastAsGood = theirs.scoreDelta >= mine.scoreDelta && costKey(theirs) <= costKey(mine);
			if (!atLeastAsGood) continue;
			const strictlyBetter = theirs.scoreDelta > mine.scoreDelta || costKey(theirs) < costKey(mine);
			if (!strictlyBetter && other.ordinal > row.ordinal) continue;
			dominatedBy = dominatedBy === null ? other.ordinal : Math.min(dominatedBy, other.ordinal);
		}
		row.dominated = dominatedBy !== null;
		row.dominatedBy = dominatedBy;
	}
	return verified
		.filter((row) => !row.dominated)
		.sort((left, right) => {
			const a = left.development as ProposalSearchDevelopment;
			const b = right.development as ProposalSearchDevelopment;
			return b.scoreDelta - a.scoreDelta || costKey(a) - costKey(b) || left.ordinal - right.ordinal;
		})
		.map((row) => row.ordinal);
}

interface ProposalPlan {
	proposalRunId: string;
	baseTargetSha: string;
	sourceEvalRunId: string;
	changedPaths: string[];
}

/**
 * What a recorded Builder run says about itself, checked against what this
 * search is about. Everything here is a read of immutable artifacts.
 */
function planFor(
	dependencies: ProposalSearchDependencies,
	runsRoot: string,
	proposalRunId: string,
	failureModeId: string,
): { plan: ProposalPlan } | { skip: ProposalSearchSkipReason } {
	let record: ReturnType<typeof loadBuilderProposalRun>;
	try {
		record = dependencies.loadProposalRun(runsRoot, proposalRunId);
	} catch {
		return { skip: "proposal-not-eligible" };
	}
	if (record.result.status !== "completed" || record.result.proposal?.decision !== "propose") {
		return { skip: "proposal-not-eligible" };
	}
	// Apply and Discard are terminal and mutually exclusive (invariant 20).
	try {
		dependencies.assertNotDiscarded(runsRoot, proposalRunId);
	} catch {
		return { skip: "proposal-not-eligible" };
	}
	try {
		dependencies.loadApplyReceipt(runsRoot, proposalRunId);
		return { skip: "proposal-not-eligible" };
	} catch {
		// No apply receipt: this hypothesis has not been tried yet.
	}
	const basis = record.request.proposalBasis;
	if (!basis || !basis.failureModes.some((mode) => mode.failureModeId === failureModeId)) {
		return { skip: "different-failure-mode" };
	}
	const sourceEvalRunId = record.request.source?.evalRunId;
	if (!sourceEvalRunId) return { skip: "different-evidence" };
	return {
		plan: {
			proposalRunId,
			baseTargetSha: record.request.baseTargetSha,
			sourceEvalRunId,
			changedPaths: record.result.proposal.changes.map((change) => change.path).sort(),
		},
	};
}

function emptyRow(ordinal: number, proposalRunId: string): ProposalSearchRow {
	return {
		ordinal,
		proposalRunId,
		branch: null,
		candidateSha: null,
		candidateId: null,
		changedPaths: [],
		status: "skipped",
		skipReason: null,
		screen: null,
		development: null,
		dominated: false,
		dominatedBy: null,
		executions: 0,
	};
}

/**
 * Compare 2..4 already-authored hypotheses for one failure mode and hand back a
 * Pareto table. Nothing here promotes, adopts, publishes, or runs a sealed
 * corpus.
 */
export async function runProposalSearch(
	options: ProposalSearchOptions,
	dependenciesInput: Partial<ProposalSearchDependencies> = {},
): Promise<ProposalSearchResult> {
	const dependencies: ProposalSearchDependencies = { ...DEFAULT_DEPENDENCIES, ...dependenciesInput };
	const repositoryDir = resolve(options.repositoryDir);
	const runsRoot = resolve(options.runsRoot);
	const stateRoot = resolve(options.stateRoot);
	const branchPrefix = options.branchPrefix ?? "candidate/search-";
	const actorId = options.actorId ?? "local-user";
	const proposalRunIds = [...options.proposalRunIds];
	if (proposalRunIds.length < MIN_SEARCH_CANDIDATES || proposalRunIds.length > MAX_SEARCH_CANDIDATES) {
		throw new ProposalSearchError(
			`a search compares between ${MIN_SEARCH_CANDIDATES} and ${MAX_SEARCH_CANDIDATES} hypotheses, got ${proposalRunIds.length}`,
		);
	}
	if (new Set(proposalRunIds).size !== proposalRunIds.length) {
		throw new ProposalSearchError("the same proposal cannot be two hypotheses in one search");
	}
	if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
		throw new ProposalSearchError(`repetitions must be a positive integer, got ${options.repetitions}`);
	}

	const plans = proposalRunIds.map((proposalRunId) =>
		planFor(dependencies, runsRoot, proposalRunId, options.failureModeId));
	const eligible = plans.flatMap((entry) => ("plan" in entry ? [entry.plan] : []));
	if (eligible.length === 0) {
		throw new ProposalSearchError(
			`no supplied proposal is an unapplied hypothesis for ${options.failureModeId}`,
		);
	}
	const baseTargetSha = eligible[0]!.baseTargetSha;
	const sourceEvalRunId = eligible[0]!.sourceEvalRunId;

	const budget = options.executionBudget;
	const rows: ProposalSearchRow[] = [];
	let executions = 0;
	let exhausted = false;

	for (const [index, entry] of plans.entries()) {
		abortIfRequested(options.signal);
		const ordinal = index + 1;
		const row = emptyRow(ordinal, proposalRunIds[index]!);
		rows.push(row);
		const record = (line: string): void => options.onCandidate?.(line, row);

		if ("skip" in entry) {
			row.skipReason = entry.skip;
			record(searchCandidateLine(row));
			continue;
		}
		const plan = entry.plan;
		row.changedPaths = plan.changedPaths;
		// Every hypothesis has to answer the same question about the same
		// revision, or the table compares nothing.
		if (plan.baseTargetSha !== baseTargetSha || plan.sourceEvalRunId !== sourceEvalRunId) {
			row.skipReason = "different-evidence";
			record(searchCandidateLine(row));
			continue;
		}

		let applied: ReturnType<typeof applyBuilderProposal>;
		try {
			applied = dependencies.applyProposal({
				repoDir: repositoryDir,
				runsRoot,
				runId: plan.proposalRunId,
				requestedBranch: `${branchPrefix}${ordinal}`,
				actor: { kind: "human", id: actorId },
				reason: `Proposal search ${ordinal}: try one hypothesis for ${options.failureModeId}.`,
			}, options.now ? { now: options.now } : {});
		} catch (error) {
			// A branch that cannot be created is this hypothesis's problem, not the
			// search's: say so and try the next one.
			console.error("AHDE host-only proposal search apply failure:", error);
			row.skipReason = "apply-failed";
			record(searchCandidateLine(row));
			continue;
		}
		row.branch = applied.receipt.branch;
		row.candidateSha = applied.receipt.candidateSha;
		row.changedPaths = [...applied.receipt.paths].sort();

		// The screen: the previously failing cases, once, candidate arm only. It
		// is never evidence and never enters a gate.
		try {
			const screen = await dependencies.runCheapCheck({
				repositoryDir,
				runsRoot,
				candidateRef: applied.receipt.candidateSha,
				baselineRef: applied.receipt.baseTargetSha,
				sourceEvalRunId: plan.sourceEvalRunId,
				...(options.developmentCorpus ? { developmentCorpus: options.developmentCorpus } : {}),
				...(options.jobs === undefined ? {} : { jobs: options.jobs }),
				...(options.signal ? { signal: options.signal } : {}),
				...(options.now ? { now: options.now } : {}),
			});
			executions += screen.tasks.length;
			row.executions += screen.tasks.length;
			row.screen = {
				verdict: screen.verdict,
				tasks: screen.tasks.length,
				improved: screen.improved,
				unchanged: screen.unchanged,
				regressed: screen.regressed,
				inconclusive: screen.inconclusive,
				withinErrorBudget: screen.withinErrorBudget,
				screenEvalRunId: screen.screenEvalRunId,
			};
		} catch (error) {
			// A screen that could not run is not a verdict (invariant 9): the
			// verification still gets to answer.
			console.error("AHDE host-only proposal search screen failure:", error);
		}

		// A flat screen from an over-budget run is inconclusive, not a finding.
		if (row.screen && row.screen.verdict === "flat" && row.screen.withinErrorBudget) {
			row.status = "screened-out";
			row.skipReason = "flat-screen";
			record(searchCandidateLine(row));
			continue;
		}

		const verificationCost = 2 * developmentTaskCount(dependencies, repositoryDir, options) * options.repetitions;
		if (budget !== undefined && verificationCost > 0 && executions + verificationCost > budget) {
			row.skipReason = "execution-budget";
			exhausted = true;
			record(searchCandidateLine(row));
			continue;
		}

		let verified: Awaited<ReturnType<typeof runAppliedBuilderCandidate>>;
		try {
			verified = await dependencies.runAppliedCandidate({
				repositoryDir,
				runsRoot,
				builderRunId: plan.proposalRunId,
				projectId: options.projectId,
				approvedSpec: { stateRoot, specId: options.approvedSpecId },
				repetitions: options.repetitions,
				...(options.developmentCorpus ? { developmentCorpus: options.developmentCorpus } : {}),
				// No sealed corpus, ever. The sealed guardrail answers one question —
				// may this ship — and a search never asks it.
				actorId,
				...(options.jobs === undefined ? {} : { jobs: options.jobs }),
				...(options.signal ? { signal: options.signal } : {}),
				...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
			});
		} catch (error) {
			console.error("AHDE host-only proposal search verification failure:", error);
			row.skipReason = "verification-failed";
			record(searchCandidateLine(row));
			continue;
		}
		const spent = verified.baseline.summary.total + verified.candidate.summary.total;
		executions += spent;
		row.executions += spent;
		row.candidateId = verified.record.candidateId;
		row.status = "verified";
		row.skipReason = null;
		row.development = {
			verdict: verified.compare.gate.verdict,
			scoreDelta: verified.compare.summary.scoreDelta,
			confidence95: verified.compare.summary.confidence95,
			passRateDelta: verified.compare.summary.delta,
			candidatePassRate: verified.compare.summary.candidatePassRate,
			tasks: verified.compare.design.tasks,
			repetitions: verified.compare.design.repetitions,
			costRatio: verified.compare.resources.costRatio,
			latencyRatio: verified.compare.resources.latencyRatio,
			tokenRatio: verified.compare.resources.tokenRatio,
		};
		record(searchCandidateLine(row));
	}

	const frontier = markDomination(rows);
	const stopReason: ProposalSearchStopReason = exhausted
		? "execution-budget-exhausted"
		: "search-complete";
	return {
		failureModeId: options.failureModeId,
		sourceEvalRunId,
		baseTargetSha,
		rows,
		frontier,
		stopReason,
		stopMessage: PROPOSAL_SEARCH_STOP_MESSAGES[stopReason],
		executions,
		plannedExecutions: plannedProposalSearchExecutions({
			developmentTasks: developmentTaskCount(dependencies, repositoryDir, options),
			repetitions: options.repetitions,
			candidates: proposalRunIds.length,
		}),
		screenEvalRunIds: rows.flatMap((row) => (row.screen ? [row.screen.screenEvalRunId] : [])),
	};
}

/**
 * How many cases one arm runs. The caller normally knows exactly (the
 * Workbench holds the published basket's task count); the manifest surface is
 * the fallback. An unreadable Target means the estimate is zero and the budget
 * guard simply never fires — refusing to search because a count could not be
 * read would be worse than searching without a bound.
 */
function developmentTaskCount(
	dependencies: ProposalSearchDependencies,
	repositoryDir: string,
	options: ProposalSearchOptions,
): number {
	if (options.developmentTasks !== undefined) return Math.max(0, Math.trunc(options.developmentTasks));
	try {
		return dependencies.loadTarget(repositoryDir).tasks.length;
	} catch {
		return 0;
	}
}

function points(value: number): string {
	const rounded = Math.round(value * 1000) / 10;
	return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}pp`;
}

function ratio(value: number | null): string {
	return value === null ? "—" : `×${value >= 10 ? value.toFixed(0) : value.toFixed(1)}`;
}

/** One progress line per hypothesis, in the shape the autoloop writes on stderr. */
export function searchCandidateLine(row: ProposalSearchRow): string {
	const parts = [`AHDE search candidate ${row.ordinal}`, row.branch ?? row.proposalRunId];
	if (row.screen) {
		parts.push(
			`screen ${row.screen.verdict} ${row.screen.improved}/${row.screen.tasks}` +
			(row.screen.withinErrorBudget ? "" : " (inconclusive)"),
		);
	}
	if (row.development) {
		parts.push(`verify ${row.development.verdict} ${points(row.development.scoreDelta)} cost ${ratio(row.development.costRatio)}`);
	}
	if (row.skipReason) parts.push(`skipped — ${PROPOSAL_SEARCH_SKIP_MESSAGES[row.skipReason]}`);
	return parts.join(" · ");
}

/** The Pareto table a human picks from. Nothing in it is a decision. */
export function renderProposalSearchTable(result: ProposalSearchResult): string {
	const header = "| # | branch | changed | screen | verdict | score Δ | 95% CI | cost | latency | frontier |";
	const divider = "|---|---|---|---|---|---|---|---|---|---|";
	const rows = result.rows.map((row) => {
		const screen = row.screen
			? `${row.screen.verdict} ${row.screen.improved}/${row.screen.tasks}` +
				(row.screen.withinErrorBudget ? "" : " · inconclusive")
			: "—";
		const development = row.development;
		const frontier = row.status !== "verified"
			? "—"
			: row.dominated
				? `dominated by ${row.dominatedBy}`
				: "best so far";
		return `| ${row.ordinal} | ${row.branch ?? "—"} | ${row.changedPaths.join(", ") || "—"} | ${screen} | ` +
			`${development ? development.verdict : "skipped"} | ${development ? points(development.scoreDelta) : "—"} | ` +
			`${development ? `${points(development.confidence95.low)}…${points(development.confidence95.high)}` : "—"} | ` +
			`${development ? ratio(development.costRatio) : "—"} | ${development ? ratio(development.latencyRatio) : "—"} | ${frontier} |`;
	});
	const skipped = result.rows.filter((row) => row.skipReason !== null);
	return [
		header,
		divider,
		...rows,
		"",
		`Stopped: ${result.stopMessage}.`,
		`Target executions spent: ${result.executions} of an estimated ${result.plannedExecutions}.`,
		...skipped.map((row) =>
			`Candidate ${row.ordinal} did not reach a verdict: ${PROPOSAL_SEARCH_SKIP_MESSAGES[row.skipReason as ProposalSearchSkipReason]}.`),
		result.frontier.length > 0
			? `Pick one: ${result.frontier.map((ordinal) => `candidate ${ordinal}`).join(", ")}. ` +
				"The sealed guardrail and the promotion run on the one you pick, unchanged."
			: "No candidate reached a development verdict; nothing here is ready for the sealed gate.",
	].join("\n");
}
