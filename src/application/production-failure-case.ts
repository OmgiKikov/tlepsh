import { z } from "zod";
import { GraderSpec, TaskSchema } from "../manifest.js";
import type { ApprovedSpecReference } from "../spec.js";
import {
	builderCorpusDraftTaskId,
	BuilderCorpusDraftCoverageNotesSchema,
	BuilderCorpusDraftTaskInputSchema,
	createBuilderCorpusDraft,
	reviseBuilderCorpusDraft,
	type BuilderCorpusDraft,
	type BuilderCorpusDraftTaskInput,
} from "./builder-corpus-draft.js";
import { DatasetSourcePathSchema } from "./dataset-source.js";
import {
	importProductionFailure,
	ProductionFailureSourceKindSchema,
	ProductionFailureTargetClaimSchema,
	type ProductionFailureRecord,
} from "./failure-intake.js";

const NonBlankSchema = z.string().min(1).refine((value) => value.trim().length > 0, "expected non-blank text");

/** Operator classification. It describes the failure; it never upgrades the imported trace to verified evidence. */
export const ProductionFailureClassificationSchema = z.strictObject({
	kind: z.enum([
		"wrong-answer",
		"missed-tool-call",
		"incorrect-tool-call",
		"unsupported-claim",
		"unsafe-action",
		"conversation-failure",
		"other",
	]),
	summary: NonBlankSchema.max(500),
});
export type ProductionFailureClassification = z.infer<typeof ProductionFailureClassificationSchema>;

/**
 * The operator supplies only the future measurement. The host derives the
 * input and frozen dialogue from the redacted imported trace, so a submitted
 * regression cannot silently rewrite the production failure it cites.
 */
export const ProductionFailureCaseMeasurementSchema = z.strictObject({
	expected: TaskSchema.shape.expected,
	world: TaskSchema.shape.world,
	graders: z.array(GraderSpec).min(1).max(16),
});
export type ProductionFailureCaseMeasurement = z.infer<
	typeof ProductionFailureCaseMeasurementSchema
>;

export const ProductionFailureCaseSubmissionSchema = z.strictObject({
	sourcePath: DatasetSourcePathSchema.refine(
		(value) => /\.(?:json|jsonl|ndjson)$/i.test(value),
		"production failure source must be .json, .jsonl, or .ndjson",
	),
	sourceKind: ProductionFailureSourceKindSchema,
	/** An external label only. The current Target binding is always host-observed. */
	targetClaim: ProductionFailureTargetClaimSchema.optional(),
	classification: ProductionFailureClassificationSchema,
	case: ProductionFailureCaseMeasurementSchema,
	draftName: NonBlankSchema.max(200).default("Production regressions"),
	coverageNotes: BuilderCorpusDraftCoverageNotesSchema.default([]),
	revisionSummary: NonBlankSchema.max(4_000),
});
export type ProductionFailureCaseSubmission = z.input<typeof ProductionFailureCaseSubmissionSchema>;

export interface AddProductionFailureCaseOptions {
	projectDir: string;
	stateRoot: string;
	approvedSpec: ApprovedSpecReference;
	parentDraftId?: string;
	submission: ProductionFailureCaseSubmission;
}

export interface AddProductionFailureCaseDependencies {
	now: () => string;
	importFailure: typeof importProductionFailure;
	createDraft: typeof createBuilderCorpusDraft;
	reviseDraft: typeof reviseBuilderCorpusDraft;
}

const DEFAULT_DEPENDENCIES: AddProductionFailureCaseDependencies = {
	now: () => new Date().toISOString(),
	importFailure: importProductionFailure,
	createDraft: createBuilderCorpusDraft,
	reviseDraft: reviseBuilderCorpusDraft,
};

export interface AddProductionFailureCaseResult {
	failure: ProductionFailureRecord;
	classification: ProductionFailureClassification;
	task: BuilderCorpusDraftTaskInput;
	draft: BuilderCorpusDraft;
	path: string;
}

function regressionTask(
	failure: ProductionFailureRecord,
	classification: ProductionFailureClassification,
	measurementInput: unknown,
): BuilderCorpusDraftTaskInput {
	const measurement = ProductionFailureCaseMeasurementSchema.parse(measurementInput);
	const lastUserIndex = failure.messages.findLastIndex((message) => message.role === "user");
	if (lastUserIndex < 0) throw new Error("production failure has no user turn to replay");
	const messages = failure.messages.slice(0, lastUserIndex + 1);
	const input = messages.at(-1)?.content;
	if (!input) throw new Error("production failure has no non-empty final user turn");
	return BuilderCorpusDraftTaskInputSchema.parse({
		input,
		messages,
		...(measurement.expected !== undefined ? { expected: measurement.expected } : {}),
		...(measurement.world !== undefined ? { world: measurement.world } : {}),
		metadata: {
			production_failure_id: failure.id,
			production_failure_class: classification.kind,
			production_failure_summary: classification.summary,
		},
		graders: measurement.graders,
	});
}

/** Import one failure and place its exact redacted conversation in the editable corpus lineage. */
export function addProductionFailureCase(
	options: AddProductionFailureCaseOptions,
	dependencies: Partial<AddProductionFailureCaseDependencies> = {},
): AddProductionFailureCaseResult {
	const submission = ProductionFailureCaseSubmissionSchema.parse(options.submission);
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	const imported = deps.importFailure({
		projectDir: options.projectDir,
		stateRoot: options.stateRoot,
		projectId: options.approvedSpec.projectId,
		sourcePath: submission.sourcePath,
		sourceKind: submission.sourceKind,
		...(submission.targetClaim !== undefined ? { targetClaim: submission.targetClaim } : {}),
	}, { now: deps.now });
	if (imported.failure.projectId !== options.approvedSpec.projectId) {
		throw new Error("production failure does not belong to the approved Spec project");
	}

	const task = regressionTask(imported.failure, submission.classification, submission.case);
	const taskId = builderCorpusDraftTaskId(options.approvedSpec, task);
	const provenance = {
		kind: "production-failure" as const,
		taskId,
		source: imported.provenance,
	};
	const result = options.parentDraftId
		? deps.reviseDraft({
			stateRoot: options.stateRoot,
			approvedSpec: options.approvedSpec,
			parentDraftId: options.parentDraftId,
			operations: [{ type: "add", task }],
			verifiedTaskProvenance: [{ operationIndex: 0, provenance }],
			revisionSummary: submission.revisionSummary,
		}, { now: deps.now })
		: deps.createDraft({
			stateRoot: options.stateRoot,
			approvedSpec: options.approvedSpec,
			name: submission.draftName,
			tasks: [task],
			coverageNotes: submission.coverageNotes,
			verifiedTaskProvenance: [provenance],
			revisionSummary: submission.revisionSummary,
		}, { now: deps.now });

	return {
		failure: imported.failure,
		classification: submission.classification,
		task,
		draft: result.draft,
		path: result.path,
	};
}
