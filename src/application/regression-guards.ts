/**
 * Promoted fixes become regression guards.
 *
 * A promotion says "these cases used to fail and now pass". Nothing pins that
 * down: the next cycle can quietly give it back. This module reads the two
 * development arms of the promoted candidate, finds the tasks whose outcome
 * flipped fail→pass, and derives one corpus draft revision holding those cases
 * as explicit guards.
 *
 * It reuses `builder-regression-case.ts` unchanged — hash-indexed failed
 * development evidence, bounded ids and hashes, never the trace answer. The
 * only difference is who selects: here the host does, at promotion, instead of
 * the Builder asking for `add-case-from-run`.
 *
 * The draft is a draft. Nothing here publishes, and a failure here is a
 * warning: the promotion is already written and must not be undone by a
 * bookkeeping step that runs after it.
 */

import { resolve } from "node:path";
import type { LoadedCorpus } from "../corpus.js";
import type { CandidateRecord } from "../domain/candidate.js";
import { loadVerifiedEvalRun, type EvalRunRecord } from "../eval.js";
import type { ResolvedTarget } from "../manifest.js";
import type { RunRecord } from "../provenance.js";
import type { ApprovedSpecReference } from "../spec.js";
import {
	reviseBuilderCorpusDraft,
	type BuilderCorpusDraftResult,
	type BuilderCorpusDraftTaskInput,
} from "./builder-corpus-draft.js";
import { resolveDevelopmentFailureOperations } from "./builder-regression-case.js";

/** Guard cases derived from one promotion, bounded so a big basket cannot explode a draft. */
export const MAX_PROMOTION_GUARD_CASES = 50;

/** Metadata keys the host stamps on a derived guard case. */
export const PROMOTION_GUARD_METADATA_KIND = "ahde.guard";
export const PROMOTION_GUARD_METADATA_TAG = "ahde.guard.promotion";
export const PROMOTION_GUARD_METADATA_SOURCE_TASK = "ahde.guard.case";
export const PROMOTION_GUARD_KIND = "promotion-regression";

export interface PromotionFlip {
	taskId: string;
	/** The baseline development EvalRun that recorded the failure. */
	evalRunId: string;
	/** The exact failing baseline Run the guard case cites. */
	runId: string;
	baselineFailures: number;
	candidatePasses: number;
}

interface TaskOutcomes {
	pass: number;
	fail: number;
	error: number;
	/** Completed failing run ids, sorted, so selection is deterministic. */
	failedRunIds: string[];
}

function outcomesByTask(runs: readonly RunRecord[]): Map<string, TaskOutcomes> {
	const byTask = new Map<string, TaskOutcomes>();
	for (const run of runs) {
		const entry = byTask.get(run.taskId) ?? { pass: 0, fail: 0, error: 0, failedRunIds: [] };
		if (run.status !== "completed") entry.error += 1;
		else if (run.evalResults?.outcome === "pass") entry.pass += 1;
		else if (run.evalResults?.outcome === "fail") {
			entry.fail += 1;
			entry.failedRunIds.push(run.runId);
		} else entry.error += 1;
		byTask.set(run.taskId, entry);
	}
	for (const entry of byTask.values()) entry.failedRunIds.sort();
	return byTask;
}

/** The development arms a promoted candidate was evaluated on. */
export function developmentArmsOf(record: CandidateRecord): {
	baselineEvalRunId: string;
	candidateEvalRunId: string;
	corpus: { id: string; hash: string } | null;
} {
	const evaluated = record.events.find((event) => event.type === "evaluated");
	if (evaluated?.type !== "evaluated") {
		throw new Error(`candidate ${record.candidateId} has no evaluated development arms`);
	}
	return {
		baselineEvalRunId: evaluated.evaluation.development.baseline.evalRunId,
		candidateEvalRunId: evaluated.evaluation.development.candidate.evalRunId,
		corpus: evaluated.evaluation.development.corpus
			? { ...evaluated.evaluation.development.corpus }
			: null,
	};
}

/**
 * Tasks whose outcome flipped fail→pass between the two development arms.
 *
 * Strict on both sides: the baseline must have failed and never passed, the
 * candidate must have passed and never failed. A task that merely got luckier
 * is not a fix, and invariant 34 already says per-task flips do not decide a
 * promotion — they only say what is worth pinning once one happened.
 */
export function detectPromotionFlips(
	runsRootInput: string,
	record: CandidateRecord,
): PromotionFlip[] {
	const runsRoot = resolve(runsRootInput);
	const arms = developmentArmsOf(record);
	const baseline = loadVerifiedEvalRun(runsRoot, arms.baselineEvalRunId);
	const candidate = loadVerifiedEvalRun(runsRoot, arms.candidateEvalRunId);
	const baselineTasks = outcomesByTask(baseline.runs);
	const candidateTasks = outcomesByTask(candidate.runs);
	const flips: PromotionFlip[] = [];
	for (const [taskId, before] of [...baselineTasks.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
		const after = candidateTasks.get(taskId);
		if (!after) continue;
		if (before.fail === 0 || before.pass > 0) continue;
		if (after.pass === 0 || after.fail > 0) continue;
		const runId = before.failedRunIds[0];
		if (!runId) continue;
		flips.push({
			taskId,
			evalRunId: baseline.record.evalRunId,
			runId,
			baselineFailures: before.fail,
			candidatePasses: after.pass,
		});
	}
	return flips;
}

/** The derived guard case: the same question, marked as pinned by a promotion. */
export function guardCaseFor(
	task: LoadedCorpus["tasks"][number],
	promotionTag: string,
): BuilderCorpusDraftTaskInput {
	const metadata: Record<string, string> = {
		...(task.metadata ?? {}),
		[PROMOTION_GUARD_METADATA_KIND]: PROMOTION_GUARD_KIND,
		[PROMOTION_GUARD_METADATA_TAG]: promotionTag.slice(0, 500),
		[PROMOTION_GUARD_METADATA_SOURCE_TASK]: task.id.slice(0, 500),
	};
	// A guard is the same scenario with promotion provenance. Preserve every
	// case field, including the world and the simulated conversation, and let
	// the draft derive its own id from that complete scenario.
	const { id: _id, ...scenario } = task;
	return {
		...structuredClone(scenario),
		metadata,
	};
}

export interface BuildPromotionGuardsOptions {
	runsRoot: string;
	stateRoot: string;
	/** The promoted Candidate record, already durable. */
	candidate: CandidateRecord;
	/** The exact approved Spec the development corpus belongs to. */
	approvedSpec: ApprovedSpecReference;
	/** The current resolved Target — promotion never moves it (invariant 31). */
	target: ResolvedTarget;
	/** The published development corpus the candidate was evaluated on. */
	developmentCorpus: LoadedCorpus;
	/** The corpus draft the published development corpus came from. */
	parentDraftId: string;
	/** Development evals the Workbench considers compatible right now. */
	compatibleEvalRuns: readonly EvalRunRecord[];
	/** The promotion tag, recorded on each guard case. */
	promotionTag: string;
	now?: () => string;
}

export interface PromotionGuardsResult {
	draftId: string;
	parentDraftId: string;
	cases: number;
	taskIds: string[];
	flips: PromotionFlip[];
}

export interface PromotionGuardsDependencies {
	reviseCorpusDraft: typeof reviseBuilderCorpusDraft;
}

const DEFAULT_DEPENDENCIES: PromotionGuardsDependencies = {
	reviseCorpusDraft: reviseBuilderCorpusDraft,
};

/**
 * Derive the guard draft for one promotion. Returns null when the promotion
 * flipped nothing — a promotion can be right without any single task moving.
 */
export function buildPromotionRegressionGuards(
	options: BuildPromotionGuardsOptions,
	dependenciesInput: Partial<PromotionGuardsDependencies> = {},
): PromotionGuardsResult | null {
	const dependencies: PromotionGuardsDependencies = { ...DEFAULT_DEPENDENCIES, ...dependenciesInput };
	const runsRoot = resolve(options.runsRoot);
	const flips = detectPromotionFlips(runsRoot, options.candidate).slice(0, MAX_PROMOTION_GUARD_CASES);
	if (flips.length === 0) return null;

	const operations = flips.map((flip) => {
		const source = options.developmentCorpus.tasks.find((task) => task.id === flip.taskId);
		if (!source) {
			throw new Error(`flipped task ${flip.taskId} is absent from the canonical development corpus`);
		}
		return {
			type: "add-case-from-run" as const,
			evalRunId: flip.evalRunId,
			runId: flip.runId,
			task: guardCaseFor(source, options.promotionTag),
		};
	});

	// The same host-side evidence rules the Builder's `add-case-from-run` goes
	// through: hash-indexed, completed, behavioural, non-duplicate, and never
	// the trace answer.
	const resolved = resolveDevelopmentFailureOperations({
		runsRoot,
		approvedSpec: options.approvedSpec,
		target: options.target,
		developmentCorpus: options.developmentCorpus,
		compatibleEvalRuns: options.compatibleEvalRuns,
		operations,
	});

	const result: BuilderCorpusDraftResult = dependencies.reviseCorpusDraft({
		stateRoot: resolve(options.stateRoot),
		approvedSpec: options.approvedSpec,
		parentDraftId: options.parentDraftId,
		operations: resolved.operations,
		verifiedTaskProvenance: resolved.verifiedTaskProvenance,
		revisionSummary:
			`Regression guards pinned by promotion ${options.promotionTag}: ` +
			`${flips.length} case${flips.length === 1 ? "" : "s"} that flipped fail→pass.`,
	}, options.now ? { now: options.now } : {});

	return {
		draftId: result.draft.id,
		parentDraftId: options.parentDraftId,
		cases: flips.length,
		taskIds: flips.map((flip) => flip.taskId),
		flips,
	};
}
