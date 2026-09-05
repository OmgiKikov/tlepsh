// One family of Workbench decisions, moved out of `AhdeWorkbench.decide()`
// unchanged: the gate, the stale check and the receipts are still the
// workbench's own; these functions only hold the branch bodies.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { percent } from "../../measurement.js";
import { hashValue } from "../../provenance.js";
import { abandonImprovementLoop, IMPROVEMENT_LOOP_AUTHOR_DISCLOSURE, improvementLoopGate, listUnfinishedImprovementLoops, newImprovementLoopId, plannedImprovementExecutions, recordedBuilderProposalAuthor, renderImprovementLoopTable, UnfinishedImprovementLoopError, IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS } from "../../application/improvement-loop.js";
import { planImprovementExperiment } from "../../application/improvement-experiment-design.js";
import { loadCorpus } from "../../corpus.js";
import { requireApprovedSpec, requireDevelopmentCorpus } from "../resolution.js";
import { exactSame, formatEstimatedCost, formatEstimatedTime } from "../workbench.js";
import { WorkbenchStaleDecisionError } from "../errors.js";
import type { WorkbenchInventory } from "../inventory.js";
import type { DecisionContext, DecisionHost, DecisionInputOf } from "./shared.js";
import type { WorkbenchDecisionResult } from "../types.js";

export async function decideImprove(
	host: DecisionHost,
	input: DecisionInputOf<"improve">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, gate, options } = ctx;
	if (!inventory.target) throw new Error("`improve` needs one exact resolved Target");
	const approved = requireApprovedSpec(inventory);
	const corpus = requireDevelopmentCorpus(inventory, input.developmentCorpusId, approved.id);
	const bindings = (current: WorkbenchInventory) => {
		const spec = requireApprovedSpec(current, approved.id);
		const cases = requireDevelopmentCorpus(current, corpus.id, spec.id);
		const target = current.target;
		if (!target) throw new WorkbenchStaleDecisionError(input.kind);
		return {
			target: {
				id: target.manifest.id, revision: target.gitSha, directory: realpathSync(target.dir),
				branch: execFileSync("git", ["-C", target.dir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(),
				manifestHash: hashValue(target.manifest), toolsetHash: target.toolsetHash,
				runtimeHash: hashValue(target.runtime), model: target.manifest.model,
			},
			approvedSpec: { id: spec.id, hash: hashValue(spec) },
			corpus: { id: cases.id, hash: cases.hash, taskCount: cases.taskCount },
			lineageHash: hashValue(current.developmentLineage.get(cases.id) ?? null),
		};
	};
	const original = bindings(inventory);
	if (input.resumeLoopId && input.abandonLoopId) {
		throw new Error("improve cannot resume and abandon a loop in the same decision");
	}
	// An unfinished loop is reported, not raced. `--abandon` drops the claim
	// (never the branches); `--resume` continues the same branch series.
	const unfinished = listUnfinishedImprovementLoops(host.runsRoot, host.projectId);
	const resumed = input.resumeLoopId
		? unfinished.running.find((loop) => loop.loopId === input.resumeLoopId) ?? null
		: null;
	if (input.resumeLoopId && !resumed) {
		throw new Error(`no unfinished improvement loop ${input.resumeLoopId} in this project`);
	}
	const abandoned = input.abandonLoopId
		? unfinished.running.find((loop) => loop.loopId === input.abandonLoopId) ?? null
		: null;
	if (input.abandonLoopId && !abandoned) {
		throw new Error(`no unfinished improvement loop ${input.abandonLoopId} in this project`);
	}
	const blocking = unfinished.running.filter((loop) =>
		loop.loopId !== resumed?.loopId && loop.loopId !== abandoned?.loopId);
	if (blocking.length > 0 || unfinished.unreadable.length > 0) {
		throw new UnfinishedImprovementLoopError(blocking, unfinished.unreadable);
	}
	const loopId = resumed?.loopId ?? newImprovementLoopId();
	const selection = input.selection ?? resumed?.configuration.selection ?? "best";
	const candidates = input.candidates ?? resumed?.configuration.candidates ?? 1;
	if (resumed && selection !== resumed.configuration.selection) throw new Error("A resumed improvement loop must keep its original selection policy");
	if (selection === "review" && input.executionBudget !== undefined) throw new Error("An execution budget requires automatic best selection");
	// Pure and model-free. A four-case minimum and the exact split are known
	// before provider preparation, confirmation, branches, or spend.
	const blindPlan = candidates > 1 || selection === "best"
		? planImprovementExperiment(loadCorpus({
			stateRoot: host.stateRoot,
			projectId: host.projectId,
			corpusId: corpus.id,
		}), loopId)
		: null;
	const plannedExecutions = plannedImprovementExecutions({
		developmentTasks: corpus.taskCount,
		...(blindPlan
			? {
				authoringTasks: blindPlan.authoringTaskIds.length,
				validationTasks: blindPlan.validationTaskIds.length,
			}
			: {}),
		repetitions: input.repetitions,
		maxCycles: input.maxCycles - (resumed?.lastCycle ?? 0),
		candidates,
		selection,
	});
	const executionBudget = input.executionBudget ?? resumed?.configuration.executionBudget ?? plannedExecutions;
	if (resumed && executionBudget !== resumed.configuration.executionBudget && selection === "best") {
		throw new Error("A resumed improvement loop must keep its original execution limit");
	}
	const targetEstimate = host.runEstimate(Math.min(plannedExecutions, executionBudget), inventory.target);
	const prepared = host.dependencies.authorImprovementProposal
		? null : await host.dependencies.prepareImprovementAuthor?.();
	const author = host.dependencies.authorImprovementProposal ?? prepared?.author ?? recordedBuilderProposalAuthor({
		stateRoot: host.stateRoot, runsRoot: host.runsRoot, projectId: host.projectId,
	});
	const disclosure = prepared?.disclosure ?? (host.dependencies.authorImprovementProposal
		? "A host-provided proposal author prepares the variants; release decisions remain human-owned."
		: IMPROVEMENT_LOOP_AUTHOR_DISCLOSURE);
	const authorVariants = (input.maxCycles - (resumed?.lastCycle ?? 0)) * candidates;
	const authoring = prepared?.budget
		? {
			maxVariants: authorVariants,
			maxRequests: authorVariants * prepared.budget.maxRequestsPerVariant,
			maxOutputTokens: authorVariants * prepared.budget.maxRequestsPerVariant * prepared.budget.maxOutputTokensPerRequest,
			maxCostUsd: prepared.budget.maxCostUsdPerVariant === null
				? null : authorVariants * prepared.budget.maxCostUsdPerVariant,
			maxMinutes: authorVariants * prepared.budget.maxMinutesPerVariant,
		}
		: host.dependencies.authorImprovementProposal
			? { maxVariants: authorVariants, maxRequests: null, maxOutputTokens: null, maxCostUsd: null, maxMinutes: null }
			: { maxVariants: 0, maxRequests: 0, maxOutputTokens: 0, maxCostUsd: 0, maxMinutes: 0 };
	const estimate = {
		...targetEstimate,
		costUsd: targetEstimate.costUsd === null || authoring.maxCostUsd === null
			? null : targetEstimate.costUsd + authoring.maxCostUsd,
		minutes: targetEstimate.minutes === null || authoring.maxMinutes === null
			? null : targetEstimate.minutes + authoring.maxMinutes,
	};
	const authorBudgetLine = authoring.maxRequests === null
		? "Builder request count and total cost are unknown for the attached author."
		: `The Builder may make at most ${authoring.maxRequests} model request${authoring.maxRequests === 1 ? "" : "s"} ` +
			`across ${authoring.maxVariants} variant${authoring.maxVariants === 1 ? "" : "s"}` +
			` (${authoring.maxOutputTokens} output tokens; authoring ceiling ${authoring.maxCostUsd === null ? "unknown" : `$${authoring.maxCostUsd.toFixed(2)}`}).`;
	const target = percent(input.until);
	const subject = {
		operation: "improve",
		original,
		selection,
		executionBudget,
		selectionPolicy: selection === "best" ? "measured-best-v1: score delta, lower confidence bound, known cost, known latency, earliest tie" : "operator review",
		approvedSpecId: approved.id,
		developmentCorpus: { id: corpus.id, hash: corpus.hash, taskCount: corpus.taskCount },
		until: input.until,
		maxCycles: input.maxCycles,
		repetitions: input.repetitions,
		candidates,
		resumingLoopId: resumed?.loopId ?? null,
		abandoningLoopId: abandoned?.loopId ?? null,
		plannedExecutions,
		estimatedCost: formatEstimatedCost(estimate),
		targetEstimatedCost: formatEstimatedCost(targetEstimate),
		authoringBudget: authoring,
		estimatedTime: formatEstimatedTime(estimate),
		// The one confirmation is also the one disclosure. What the operator is
		// approving is a loop that APPLIES diffs without showing each of them.
		applies: "on throwaway candidate/auto-<loopId>-<n> branches, without showing each diff",
		touchesYourBranch: false,
		diffsVisibleIn: ["changed paths in the cycle table", "the exact diff in /review", "the exact diff in the ship dialog"],
		authoring: disclosure,
		neverDecides: [...IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS],
		blindValidation: blindPlan ? {
			authoringTasks: blindPlan.authoringTaskIds.length,
			validationTasks: blindPlan.validationTaskIds.length,
			seed: blindPlan.seed,
		} : null,
	};
	const actor = await host.confirm(input, gate, `Improve until ${target}`, subject, options.signal, {
		question:
			`Run up to ${input.maxCycles} improvement cycle${input.maxCycles === 1 ? "" : "s"} ` +
			`towards ${target}` +
			(candidates > 1 ? `, comparing ${candidates} changes per cycle` : "") +
			` (Target execution limit ${executionBudget})? ` +
			"This is the only time you will be asked: the loop APPLIES proposals on throwaway " +
			"`candidate/auto-<loopId>-<n>` branches WITHOUT showing you each diff. " +
			"Nothing touches your branch or your working tree. Changed paths are listed in the cycle " +
			"table; the exact diff is shown in /review and bound by hash to the ship dialog. " +
			"The loop never promotes, adopts, publishes or approves anything. " +
			(selection === "best" ? "It keeps the best measured independent hypothesis against the original baseline, stopping after two rounds without progress or at the budget. Final review is yours. " : "") +
			(blindPlan
				? `The Builder sees ${blindPlan.authoringTaskIds.length} authoring cases; ` +
					`all hypotheses are ranked on ${blindPlan.validationTaskIds.length} unseen validation cases. `
				: "") +
			authorBudgetLine + " " +
			disclosure,
		estimate,
	});
	// Consent names a concrete baseline. A new clean commit, model change or
	// same-SHA branch switch during the dialog cannot become that baseline.
	try {
		if (!exactSame(original, bindings(host.decisionInventory(input.kind)))) throw new WorkbenchStaleDecisionError(input.kind);
	} catch { throw new WorkbenchStaleDecisionError(input.kind); }
	// Abandoning is itself state-changing. Do it only after the human approved
	// the exact improve subject, never while merely preparing the dialog.
	if (input.abandonLoopId) {
		abandonImprovementLoop(host.runsRoot, host.projectId, input.abandonLoopId, host.dependencies.now);
	}
	const loop = await host.dependencies.runImprovementLoop({
		repositoryDir: host.projectDir,
		runsRoot: host.runsRoot,
		stateRoot: host.stateRoot,
		projectId: host.projectId,
		approvedSpecId: approved.id,
		developmentCorpus: { stateRoot: host.stateRoot, projectId: host.projectId, corpusId: corpus.id },
		until: input.until,
		maxCycles: input.maxCycles,
		repetitions: input.repetitions,
		candidates,
		selection,
		...(selection === "best" ? { executionBudget } : {}),
		loopId,
		...(input.baselineMaxAgeMs === undefined ? {} : { baselineMaxAgeMs: input.baselineMaxAgeMs }),
		...(input.jobs === undefined ? {} : { jobs: input.jobs }),
		author,
		gate: improvementLoopGate(gate),
		actorId: actor,
		...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
		...(options.signal ? { signal: options.signal } : {}),
		now: host.dependencies.now,
	});
	const table = renderImprovementLoopTable(loop, disclosure);
	const search = [...loop.cycles].reverse().find((cycle) => cycle.search)?.search ?? null;
	// The last experiment can lose. Review the measured incumbent, never
	// whichever candidate happens to be newest in the inventory.
	const nextInventory = loop.selectionSummary?.incumbent
		? host.select("candidate", loop.selectionSummary.incumbent.candidateId)
		: host.inventory();
	return {
		kind: input.kind,
		message:
			`${loop.cycles.length} improvement cycle${loop.cycles.length === 1 ? "" : "s"} ran. ` +
			`Stopped because ${loop.stopMessage}.`,
		result: {
			cycles: loop.cycles,
			stopReason: loop.stopReason,
			stopMessage: loop.stopMessage,
			table,
			candidateId: loop.candidateId,
			loopId: loop.loopId,
			finalPassRate: loop.finalPassRate,
			executions: loop.executions,
			candidates,
			search,
			...(loop.selectionSummary ? { selectionSummary: loop.selectionSummary } : {}),
		},
		view: await host.viewOf(nextInventory),
	};
}
