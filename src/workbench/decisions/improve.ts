// One family of Workbench decisions, moved out of `AhdeWorkbench.decide()`
// unchanged: the gate, the stale check and the receipts are still the
// workbench's own; these functions only hold the branch bodies.
import { percent } from "../../measurement.js";
import { abandonImprovementLoop, IMPROVEMENT_LOOP_AUTHOR_DISCLOSURE, improvementLoopGate, listUnfinishedImprovementLoops, plannedImprovementExecutions, recordedBuilderProposalAuthor, renderImprovementLoopTable, UnfinishedImprovementLoopError, IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS } from "../../application/improvement-loop.js";
import { requireApprovedSpec, requireDevelopmentCorpus } from "../resolution.js";
import { formatEstimatedCost, formatEstimatedTime, actorId } from "../workbench.js";
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
	const candidates = input.candidates ?? 1;
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
	const plannedExecutions = plannedImprovementExecutions({
		developmentTasks: corpus.taskCount,
		repetitions: input.repetitions,
		maxCycles: input.maxCycles - (resumed?.lastCycle ?? 0),
		candidates,
	});
	const estimate = host.runEstimate(plannedExecutions, inventory.target);
	const target = percent(input.until);
	const subject = {
		operation: "improve",
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
		estimatedTime: formatEstimatedTime(estimate),
		// The one confirmation is also the one disclosure. What the operator is
		// approving is a loop that APPLIES diffs without showing each of them.
		applies: "on throwaway candidate/auto-<loopId>-<n> branches, without showing each diff",
		touchesYourBranch: false,
		diffsVisibleIn: ["changed paths in the cycle table", "the exact diff in /review", "the exact diff in the ship dialog"],
		authoring: IMPROVEMENT_LOOP_AUTHOR_DISCLOSURE,
		neverDecides: [...IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS],
	};
	const actor = await host.confirm(input, gate, `Improve until ${target}`, subject, options.signal, {
		question:
			`Run up to ${input.maxCycles} improvement cycle${input.maxCycles === 1 ? "" : "s"} ` +
			`towards ${target}` +
			(candidates > 1 ? `, comparing ${candidates} changes per cycle` : "") +
			` (at most ${plannedExecutions} Target executions)? ` +
			"This is the only time you will be asked: the loop APPLIES proposals on throwaway " +
			"`candidate/auto-<loopId>-<n>` branches WITHOUT showing you each diff. " +
			"Nothing touches your branch or your working tree. Changed paths are listed in the cycle " +
			"table; the exact diff is shown in /review and bound by hash to the ship dialog. " +
			"The loop never promotes, adopts, publishes or approves anything. " +
			IMPROVEMENT_LOOP_AUTHOR_DISCLOSURE,
		estimate,
	});
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
		...(resumed ? { loopId: resumed.loopId } : {}),
		...(input.baselineMaxAgeMs === undefined ? {} : { baselineMaxAgeMs: input.baselineMaxAgeMs }),
		...(input.jobs === undefined ? {} : { jobs: input.jobs }),
		author: host.dependencies.authorImprovementProposal ?? recordedBuilderProposalAuthor({
			stateRoot: host.stateRoot,
			runsRoot: host.runsRoot,
			projectId: host.projectId,
		}),
		gate: improvementLoopGate(gate),
		actorId: actor,
		...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
		...(options.signal ? { signal: options.signal } : {}),
		now: host.dependencies.now,
	});
	const table = renderImprovementLoopTable(loop);
	const search = [...loop.cycles].reverse().find((cycle) => cycle.search)?.search ?? null;
	return {
		kind: input.kind,
		message:
			`${loop.cycles.length} improvement cycle${loop.cycles.length === 1 ? "" : "s"} ran. ` +
			`Stopped because ${loop.stopMessage}. ${IMPROVEMENT_LOOP_AUTHOR_DISCLOSURE}`,
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
		},
		view: await host.viewOf(host.inventory()),
	};
}
