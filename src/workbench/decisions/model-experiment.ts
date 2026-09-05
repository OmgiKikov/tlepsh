import { t } from "../../i18n.js";
import { hashValue } from "../../provenance.js";
import { loadDevelopmentCorpusPublicationReceipt } from "../../application/builder-authoring.js";
import { loadModelExperiment } from "../../application/model-experiment.js";
import { loadCorpus } from "../../corpus.js";
import { clearWorkbenchFocus, loadWorkbenchFocus, saveWorkbenchFocus } from "../focus.js";
import { requireApprovedSpec, requireDevelopmentCorpus } from "../resolution.js";
import { WorkbenchStaleDecisionError } from "../errors.js";
import { exactSame } from "../workbench.js";
import type { DecisionContext, DecisionHost, DecisionInputOf } from "./shared.js";
import type { WorkbenchDecisionResult } from "../types.js";

/** One declared model intervention on the reviewed development cases. */
export async function decideModelExperiment(
	host: DecisionHost,
	input: DecisionInputOf<"model-experiment">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, gate, options } = ctx;
	if (!inventory.target) throw new Error("Target is not ready");
	if (!options.resolveTargetModel) throw new Error("Model experiments require the trusted host model catalog");
	const approved = requireApprovedSpec(inventory);
	const corpus = requireDevelopmentCorpus(inventory, undefined, approved.id);
	const build = (id?: string) => {
		const current = host.decisionInventory(input.kind);
		const currentApproved = requireApprovedSpec(current, approved.id);
		const currentCorpus = requireDevelopmentCorpus(current, corpus.id, currentApproved.id);
		const ref = { stateRoot: host.stateRoot, projectId: host.projectId, corpusId: currentCorpus.id };
		const loaded = loadCorpus(ref);
		const receipt = loadDevelopmentCorpusPublicationReceipt(host.stateRoot, host.projectId, currentCorpus.id);
		const lineage = current.developmentLineage.get(currentCorpus.id);
		if (!lineage || lineage.publication.approvedSpecId !== currentApproved.id ||
			loaded.metadata.visibility !== "development" || loaded.metadata.hash !== receipt.corpus.hash) {
			throw new Error("Model experiments require an exact reviewed development corpus and Spec lineage");
		}
		const plan = host.dependencies.planModelExperiment({
			targetDir: host.projectDir, runsRoot: host.runsRoot, corpus: ref,
			selections: input.models, repetitions: input.repetitions,
			executionBudget: input.executionBudget, qualityTolerance: input.qualityTolerance,
			objective: input.objective, resolveTargetModel: options.resolveTargetModel!,
			...(id ? { id } : {}),
		});
		return { plan, approvedSpec: { id: currentApproved.id, hash: hashValue(currentApproved) }, lineageHash: lineage.publication.linkHash };
	};
	const before = build();
	const actorId = await host.confirm(input, gate, t("models.confirm-title"), before, options.signal, {
		question: t("models.confirm-question"),
		// A different model has no comparable spending history. The exact number
		// of Target calls is a hard limit; the product never labels it a USD cap.
		estimate: { executions: before.plan.plannedExecutions, sampledRuns: 0, costUsd: null, minutes: null },
	});
	const after = build(before.plan.id);
	if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
	const experiment = await host.dependencies.runModelExperiment({
		targetDir: host.projectDir, runsRoot: host.runsRoot, plan: after.plan,
		expectedPlanHash: before.plan.planHash, actorId,
		...(options.signal ? { signal: options.signal } : {}),
		...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
	});
	return {
		kind: input.kind,
		message: `Model experiment ${experiment.id}: ${experiment.status}. ` +
			"Exploratory development results; no release decision or active model change was made.",
		result: { experiment }, view: await host.view(),
	};
}

/** Exact model change, followed by a fresh ordinary baseline on the next run. */
export async function decideAcceptModel(
	host: DecisionHost,
	input: DecisionInputOf<"accept-model">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { gate, options } = ctx;
	const describe = async () => {
		const current = host.decisionInventory(input.kind);
		const approved = requireApprovedSpec(current);
		const experiment = loadModelExperiment(host.runsRoot, input.experimentId, { targetDir: host.projectDir, stateRoot: host.stateRoot, projectId: host.projectId });
		if (experiment.plan.corpus.projectId !== host.projectId || experiment.plan.corpus.stateRoot !== host.stateRoot) {
			throw new Error("The model experiment belongs to another project state");
		}
		requireDevelopmentCorpus(current, experiment.plan.corpus.corpusId, approved.id);
		const view = await host.viewOf(current);
		if (view.workshop && view.workshop.state !== "stale") {
			throw new Error("Finish or discard the open workshop before changing its base model");
		}
		return host.dependencies.describeModelChange({
			targetDir: host.projectDir, runsRoot: host.runsRoot, stateRoot: host.stateRoot, projectId: host.projectId,
			experimentId: input.experimentId, armId: input.armId,
		});
	};
	const before = await describe();
	const actorId = await host.confirm(input, gate, t("models.accept-title"), before, options.signal, {
		question: t("models.accept-question"),
	});
	const after = await describe();
	if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
	const receipt = host.dependencies.applyModelChange({
		targetDir: host.projectDir, runsRoot: host.runsRoot, stateRoot: host.stateRoot, projectId: host.projectId, subject: after,
		expectedSubjectHash: before.subjectHash, actorId, reason: input.reason,
	});
	// The cases and approved intent survive; old-model evidence cannot remain
	// the selected baseline or silently fund a proposal on the new revision.
	saveWorkbenchFocus(host.stateRoot, clearWorkbenchFocus(
		loadWorkbenchFocus(host.stateRoot, host.projectId, host.dependencies.now), "eval-run", host.dependencies.now,
	));
	return {
		kind: input.kind,
		message: "The reviewed model change is committed. Run the development cases to establish its new baseline before improving or releasing it.",
		result: { receipt }, view: await host.view(),
	};
}
