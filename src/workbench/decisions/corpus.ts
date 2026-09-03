// One family of Workbench decisions, moved out of `AhdeWorkbench.decide()`
// unchanged: the gate, the stale check and the receipts are still the
// workbench's own; these functions only hold the branch bodies.
import { plural as localizedCount, t } from "../../i18n.js";
import { loadDevelopmentCorpusPublicationReceipt } from "../../application/builder-authoring.js";
import { MAX_BUILDER_CORPUS_DRAFT_TASKS } from "../../application/builder-corpus-draft.js";
import { type DatasetHoldoutSpec } from "../../application/dataset-ingest.js";
import { assertGradersRunnable, targetToolContext } from "../../application/corpus-target.js";
import { listCorpora, type CorpusMetadata } from "../../corpus.js";
import { hashValue } from "../../provenance.js";
import { loadApprovedSpec } from "../../spec.js";
import { recordWorkbenchCorpusPublication } from "../corpus-publication.js";
import { WorkbenchStaleDecisionError } from "../errors.js";
import { requireApprovedSpec, requireCorpusDraft, requireSpecDraft } from "../resolution.js";
import { exactSame, datasetCasePreview, MAX_DATASET_SAMPLE_CASES, GENERATED_HOLDOUT_NAME } from "../workbench.js";
import type { DecisionContext, DecisionHost, DecisionInputOf } from "./shared.js";
import type { WorkbenchDecisionResult } from "../types.js";

export async function decideApproveSpec(
	host: DecisionHost,
	input: DecisionInputOf<"approve-spec">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, gate, options } = ctx;
	const draft = requireSpecDraft(inventory, input.draftSpecId);
	const beforeDescription = host.dependencies.describeSpecApproval(host.stateRoot, host.projectId, draft.id);
	const before = { ...beforeDescription, spec: draft.spec };
	const actor = await host.confirm(input, gate, t("confirm.title.approve-spec"), before, options.signal);
	const current = host.decisionInventory(input.kind);
	const reloadedDraft = requireSpecDraft(current, draft.id);
	const afterDescription = host.dependencies.describeSpecApproval(host.stateRoot, host.projectId, draft.id);
	const after = { ...afterDescription, spec: reloadedDraft.spec };
	if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
	const result = host.dependencies.approveSpecDraft({ stateRoot: host.stateRoot, projectId: host.projectId, draftSpecId: draft.id, expectedDraftSnapshotHash: beforeDescription.draftSnapshotHash, actor: { kind: "human", id: actor }, reason: input.reason }, { now: host.dependencies.now });
	const settled = host.select("approved-spec", result.approved.id);
	return { kind: input.kind, message: t("message.spec-approved"), result: { approvedSpecId: result.approved.id, receiptId: result.receipt.id }, view: await host.viewOf(settled) };
}

export async function decidePublishCorpus(
	host: DecisionHost,
	input: DecisionInputOf<"publish-corpus">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, gate, options } = ctx;
	const approved = requireApprovedSpec(inventory);
	const draft = requireCorpusDraft(inventory, input.draftId, approved.id, true);
	if (inventory.target) assertGradersRunnable(draft.tasks, inventory.target.manifest, `corpus draft ${draft.id}`, targetToolContext(inventory.target));
	const name = input.name ?? draft.name;
	const publication = host.dependencies.describeCorpusPublication({ projectId: host.projectId, name, tasks: draft.tasks });
	const before = { operation: "publish-development-corpus", draftId: draft.id, draftHash: hashValue(draft), approvedSpec: draft.approvedSpec, publication, tasks: draft.tasks };
	const actor = await host.confirm(input, gate, t("confirm.title.publish-corpus"), before, options.signal);
	const current = host.decisionInventory(input.kind);
	const currentApproved = requireApprovedSpec(current, approved.id);
	const reloaded = requireCorpusDraft(current, draft.id, currentApproved.id, true);
	const afterPublication = host.dependencies.describeCorpusPublication({ projectId: host.projectId, name, tasks: reloaded.tasks });
	const after = { operation: "publish-development-corpus", draftId: reloaded.id, draftHash: hashValue(reloaded), approvedSpec: reloaded.approvedSpec, publication: afterPublication, tasks: reloaded.tasks };
	if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
	let matchingExisting: CorpusMetadata[];
	try {
		matchingExisting = listCorpora({ stateRoot: host.stateRoot, projectId: host.projectId }).filter((corpus) =>
			corpus.visibility === "development" &&
			corpus.name === name &&
			corpus.hash === publication.contentHash &&
			corpus.taskCount === publication.taskCount
		);
	} catch {
		throw new Error("development corpus inventory is unavailable; publication cannot be recovered safely");
	}
	if (matchingExisting.length > 1) throw new Error("multiple development corpora match the reviewed publication subject");
	const result = matchingExisting[0]
		? (() => {
			const corpus = matchingExisting[0]!;
			const receipt = loadDevelopmentCorpusPublicationReceipt(host.stateRoot, host.projectId, corpus.id);
			if (receipt.subject.subjectHash !== publication.subjectHash || receipt.corpus.hash !== corpus.hash) {
				throw new Error("existing corpus publication receipt does not match the reviewed subject");
			}
			return { corpus, receipt, receiptPath: "recovered-existing-publication" };
		})()
		: host.dependencies.publishDevelopmentCorpus({ stateRoot: host.stateRoot, projectId: host.projectId, name, tasks: reloaded.tasks, expectedSubjectHash: publication.subjectHash, actor: { kind: "human", id: actor }, reason: input.reason }, { now: host.dependencies.now });
	const lineage = recordWorkbenchCorpusPublication({ stateRoot: host.stateRoot, draft: reloaded, publication: result });
	const settled = host.select("development-corpus", result.corpus.id);
	return { kind: input.kind, message: t("message.corpus-published"), result: { corpusId: result.corpus.id, corpusHash: result.corpus.hash, taskCount: result.corpus.taskCount, publicationReceiptId: result.receipt.id, lineageHash: lineage.linkHash }, view: await host.viewOf(settled) };
}

export async function decideImportDataset(
	host: DecisionHost,
	input: DecisionInputOf<"import-dataset">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, gate, options } = ctx;
	const approved = requireApprovedSpec(inventory);
	const submission = host.requireDatasetRecipe(approved.id, input.submissionId);
	const inForce = host.datasetHoldout(submission.sourcePath);
	const requested: DatasetHoldoutSpec | null = input.sealed
		? {
			count: input.sealed.count,
			seed: input.sealed.seed,
			...(input.sealed.stratifyBy !== undefined ? { stratifyBy: input.sealed.stratifyBy } : {}),
		}
		: null;
	// A second draw over a file that already has one would put previously
	// sealed rows into a development corpus, so the exam is drawn once.
	if (inForce && !exactSame(inForce, requested)) {
		throw new Error(
			`${submission.sourcePath} already holds out ${inForce.count} row${inForce.count === 1 ? "" : "s"} ` +
			`with seed ${JSON.stringify(inForce.seed)}; import it again with that exact sealed slice, or use another file.`,
		);
	}
	const holdout = requested;
	const build = (): { subject: Record<string, unknown>; developmentCount: number } => {
		const compiled = host.dependencies.compileDatasetCases({
			projectDir: host.projectDir,
			sourcePath: submission.sourcePath,
			recipe: submission.recipe,
			holdout,
		});
		if (compiled.sourceSha256 !== submission.sourceSha256) {
			throw new Error(`${submission.sourcePath} changed since the recipe was validated; submit the recipe again`);
		}
		if (compiled.tasks.length === 0) throw new Error("the recipe compiles no development cases");
		if (compiled.tasks.length > MAX_BUILDER_CORPUS_DRAFT_TASKS) {
			throw new Error(
				`the recipe compiles ${compiled.tasks.length} cases; a reviewable basket holds at most ` +
				`${MAX_BUILDER_CORPUS_DRAFT_TASKS}. Add sample: { limit, seed } to the recipe first.`,
			);
		}
		return {
			subject: {
				operation: "import-dataset",
				submissionId: submission.id,
				approvedSpec: submission.approvedSpec,
				sourcePath: submission.sourcePath,
				name: submission.name,
				recipe: submission.recipe,
				developmentCount: compiled.tasks.length,
				skippedRows: compiled.skipped.length,
				sealed: holdout,
				sampleCases: compiled.tasks.slice(0, MAX_DATASET_SAMPLE_CASES).map(datasetCasePreview),
			},
			developmentCount: compiled.tasks.length,
		};
	};
	const before = build();
	const actor = await host.confirm(input, gate, t("confirm.title.import-dataset"), before.subject, options.signal);
	const current = host.decisionInventory(input.kind);
	requireApprovedSpec(current, approved.id);
	const after = build();
	if (!exactSame(before.subject, after.subject)) throw new WorkbenchStaleDecisionError(input.kind);
	// Fixed order: the sealed slice is compiled and published before any
	// development case exists, so no reserved row can leak into the draft.
	const ingested = host.dependencies.ingestDataset({
		projectDir: host.projectDir,
		stateRoot: host.stateRoot,
		projectId: host.projectId,
		sourcePath: submission.sourcePath,
		recipe: submission.recipe,
		holdout,
		developmentName: submission.name,
		now: host.dependencies.now,
	});
	const exact = loadApprovedSpec({ stateRoot: host.stateRoot, projectId: host.projectId, specId: approved.id });
	const result = host.dependencies.createCorpusDraft({
		stateRoot: host.stateRoot,
		approvedSpec: exact.reference,
		name: submission.name,
		tasks: ingested.tasks.map(({ id: _derivedId, ...task }) => task),
		coverageNotes: [],
		revisionSummary: submission.revisionSummary,
	}, { now: host.dependencies.now });
	const settled = host.select("corpus-draft", result.draft.id);
	const sealedCount = ingested.sealedCorpus?.taskCount ?? 0;
	return {
		kind: input.kind,
		message: `Imported ${ingested.tasks.length} case${ingested.tasks.length === 1 ? "" : "s"} into an editable draft` +
			`${sealedCount > 0 ? `; ${sealedCount} sealed case${sealedCount === 1 ? "" : "s"} held out` : ""}. ` +
			"Review it, then publish.",
		result: {
			draftId: result.draft.id,
			taskCount: result.draft.tasks.length,
			approvedSpecId: result.draft.approvedSpec.specId,
			sourcePath: ingested.receipt.sourcePath,
			sealedCount,
			skippedRows: ingested.skipped.length,
			receiptId: ingested.receiptPath.split(/[\\/]/).at(-1)?.replace(/\.json$/, "") ?? "",
		},
		view: await host.viewOf(settled),
	};
}

export async function decideGenerateHoldout(
	host: DecisionHost,
	input: DecisionInputOf<"generate-holdout">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { gate, options } = ctx;
	// Host-owned, all of it. The name is the same for every generated exam
	// because the model asks for an exam, not for a label on one; the Spec
	// comes from the approved snapshot the host reads; the format examples
	// are a seeded draw over published development cases. Nothing in
	// `input` reaches the generator except a count and a seed.
	const reviewPath = input.mode === "review"
		? host.dependencies.sealedSynthReviewPath(
			host.stateRoot,
			host.projectId,
			`${host.projectId} ${input.cases} ${input.seed ?? ""} ${host.dependencies.now()}`,
		)
		: undefined;
	const request = {
		targetDir: host.projectDir,
		stateRoot: host.stateRoot,
		projectId: host.projectId,
		name: GENERATED_HOLDOUT_NAME,
		count: input.cases,
		source: input.source ?? "spec",
		...(input.seed ? { seed: input.seed } : {}),
		...(reviewPath ? { reviewPath } : {}),
	};
	// Planned once before the dialog and again after it: the model, the
	// price and the exact question the human approved must still be the
	// ones the generator is asked. The plan is also the whole subject —
	// hashes, ids and counts, and not one case, because there is no case
	// yet and there never will be one on this side of the boundary.
	const describe = () => ({
		operation: "generate-holdout",
		mode: input.mode,
		...host.dependencies.planSealedSynthesis(request),
	});
	const before = describe();
	await host.confirm(input, gate, t("confirm.title.generate-holdout"), before, options.signal);
	host.decisionInventory(input.kind);
	if (!exactSame(before, describe())) throw new WorkbenchStaleDecisionError(input.kind);
	const generated = await host.dependencies.synthesizeSealedCorpus({
		...request,
		...(options.signal ? { signal: options.signal } : {}),
	});
	const cases = generated.corpus?.taskCount ?? generated.accepted;
	// A judge that wrote 20 and had one thrown out by validation must not
	// read as "wrote 19": the operator asked for a number, and the answer
	// says which cases of it never existed and why.
	const dropped = generated.droppedMalformed + generated.droppedDuplicate;
	const shortfall = cases < generated.requested
		? ` ${t("message.exam-shortfall", {
			requested: generated.requested,
			dropped,
			malformed: generated.droppedMalformed,
			duplicate: generated.droppedDuplicate,
		})}`
		: "";
	// The one sentence names the source: an exam written from the agent's own
	// documents is a different claim from one written from its description, and
	// the operator is the person who has to know which they just paid for.
	const sealedKey = generated.source === "kb" ? "message.exam-sealed-kb" : "message.exam-sealed";
	const draftKey = generated.source === "kb" ? "message.exam-draft-kb" : "message.exam-draft";
	return {
		kind: input.kind,
		message: `${t(generated.corpus ? sealedKey : draftKey, {
			cases: localizedCount(cases, "case"),
		})}${shortfall}`,
		result: {
			...(generated.corpus ? { corpusId: generated.corpus.id } : {}),
			cases,
			source: generated.source,
			requested: generated.requested,
			dropped: { malformed: generated.droppedMalformed, duplicate: generated.droppedDuplicate },
			generator: generated.generatorModel,
			promptHash: generated.promptSha256,
			...(generated.reviewPath ? { reviewPath: generated.reviewPath } : {}),
		},
		view: await host.view(),
	};
}
