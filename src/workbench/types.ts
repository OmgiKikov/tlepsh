import { z } from "zod";
import {
	BuilderCorpusDraftCoverageNotesSchema,
	BuilderCorpusDraftTasksInputSchema,
} from "../application/builder-corpus-draft.js";
import { BuilderCorpusImportSourcePathSchema } from "../application/builder-corpus-import-contract.js";
import { BuilderWorkbenchCorpusRevisionOperationsSchema } from "../application/builder-regression-case.js";
import { HarnessAuthoringIntentsSchema } from "../application/harness-authoring.js";
import type { RunEventListener } from "../run-events.js";
import { AgentSpecSchema } from "../spec.js";

const NonBlankSchema = z.string().min(1).refine((value) => value.trim().length > 0, "expected non-blank text");
const ArtifactIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);

export const WorkbenchSelectionKindSchema = z.enum([
	"spec-draft",
	"approved-spec",
	"corpus-draft",
	"development-corpus",
	"eval-run",
	"proposal",
	"candidate",
]);
export type WorkbenchSelectionKind = z.infer<typeof WorkbenchSelectionKindSchema>;

export const WorkbenchStageSchema = z.enum([
	"target-setup",
	"spec-design",
	"spec-review",
	"corpus-design",
	"corpus-review",
	"ready-to-evaluate",
	"improvement-authoring",
	"proposal-review",
	"candidate-verification",
	"candidate-review",
	"release-decision",
	"complete",
	"selection-required",
]);
export type WorkbenchStage = z.infer<typeof WorkbenchStageSchema>;

export interface WorkbenchSelectionSummary {
	kind: WorkbenchSelectionKind;
	id: string;
	label: string;
	status?: string;
	selected: boolean;
}

export interface WorkbenchView {
	schemaVersion: 1;
	project: { id: string; directory: string };
	stage: WorkbenchStage;
	headline: string;
	target: {
		status: "missing" | "bootstrap-required" | "ready";
		id: string | null;
		gitSha: string | null;
	};
	focus: Partial<Record<WorkbenchSelectionKind, string>>;
	selections: WorkbenchSelectionSummary[];
	actions: string[];
	blockers: string[];
	warnings: string[];
	detail?: {
		aspect: "traces" | "review" | "target";
		content: Record<string, unknown>;
	};
	counts: {
		specDrafts: number;
		approvedSpecs: number;
		corpusDrafts: number;
		developmentCorpora: number;
		sealedCorpora: number;
		developmentEvals: number;
		openProposals: number;
		candidates: number;
	};
}

export interface WorkbenchViewQuery {
	aspect?: "summary" | "traces" | "review" | "target";
}

const SelectInputSchema = z.strictObject({
	kind: z.literal("select"),
	entity: WorkbenchSelectionKindSchema,
	id: ArtifactIdSchema,
});

const SaveSpecDraftInputSchema = z.strictObject({
	kind: z.literal("spec-draft"),
	spec: AgentSpecSchema,
	sourceText: z.string().max(64 * 1024).optional(),
});

const CreateCorpusDraftInputSchema = z.strictObject({
	kind: z.literal("corpus-draft"),
	approvedSpecId: ArtifactIdSchema.optional(),
	name: NonBlankSchema.max(200),
	tasks: BuilderCorpusDraftTasksInputSchema,
	coverageNotes: BuilderCorpusDraftCoverageNotesSchema.default([]),
	revisionSummary: NonBlankSchema.max(4_000),
});

const ImportCorpusDraftInputSchema = z.strictObject({
	kind: z.literal("corpus-import"),
	approvedSpecId: ArtifactIdSchema.optional(),
	sourcePath: BuilderCorpusImportSourcePathSchema,
	name: NonBlankSchema.max(200),
	coverageNotes: BuilderCorpusDraftCoverageNotesSchema.default([]),
	revisionSummary: NonBlankSchema.max(4_000),
});

const ReviseCorpusDraftInputSchema = z.strictObject({
	kind: z.literal("corpus-revision"),
	approvedSpecId: ArtifactIdSchema.optional(),
	parentDraftId: ArtifactIdSchema.optional(),
	operations: BuilderWorkbenchCorpusRevisionOperationsSchema,
	revisionSummary: NonBlankSchema.max(4_000),
});

const StructuredProposalInputSchema = z.strictObject({
	kind: z.literal("structured-proposal"),
	approvedSpecId: ArtifactIdSchema.optional(),
	sourceEvalRunId: ArtifactIdSchema.optional(),
	summary: NonBlankSchema.max(4_000),
	diagnoses: z.array(z.strictObject({
		failureIds: z.array(NonBlankSchema.max(500)).min(1).max(100),
		evidence: z.array(NonBlankSchema.max(500)).min(1).max(100),
		rootCause: NonBlankSchema.max(8_000),
	})).max(100).default([]),
	intents: HarnessAuthoringIntentsSchema,
	risks: z.array(NonBlankSchema.max(4_000)).max(100).default([]),
	validationPlan: z.array(NonBlankSchema.max(4_000)).min(1).max(100),
});

export const WorkbenchSubmitInputSchema = z.discriminatedUnion("kind", [
	SelectInputSchema,
	SaveSpecDraftInputSchema,
	CreateCorpusDraftInputSchema,
	ImportCorpusDraftInputSchema,
	ReviseCorpusDraftInputSchema,
	StructuredProposalInputSchema,
]);
/** Caller input; downstream defaults are materialized by parse inside Workbench. */
export type WorkbenchSubmitInput = z.input<typeof WorkbenchSubmitInputSchema>;

export const WorkbenchDecisionInputSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("scaffold-target"),
		reason: NonBlankSchema.max(4_000),
	}),
	z.strictObject({
		kind: z.literal("configure-target"),
		targetId: z.string().max(100).regex(/^[a-z0-9][a-z0-9-]*$/),
		/** Complete non-secret model metadata; the application service rejects credential values. */
		model: z.unknown(),
		reason: NonBlankSchema.max(4_000),
	}),
	z.strictObject({
		kind: z.literal("run-current"),
		repetitions: z.number().int().min(1).max(10),
		reason: NonBlankSchema.max(4_000),
	}),
	z.strictObject({
		kind: z.literal("approve-spec"),
		draftSpecId: ArtifactIdSchema.optional(),
		reason: NonBlankSchema.max(4_000),
	}),
	z.strictObject({
		kind: z.literal("publish-corpus"),
		draftId: ArtifactIdSchema.optional(),
		name: NonBlankSchema.max(200).optional(),
		reason: NonBlankSchema.max(4_000),
	}),
	z.strictObject({
		kind: z.literal("run-eval"),
		developmentCorpusId: ArtifactIdSchema.optional(),
		repetitions: z.number().int().min(1).max(10),
		reason: NonBlankSchema.max(4_000),
	}),
	z.strictObject({
		kind: z.literal("apply-proposal"),
		runId: ArtifactIdSchema.optional(),
		branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/),
		reason: NonBlankSchema.max(4_000),
	}),
	z.strictObject({
		kind: z.literal("discard-proposal"),
		runId: ArtifactIdSchema.optional(),
		reason: NonBlankSchema.max(4_000),
	}),
	z.strictObject({
		kind: z.literal("verify-candidate"),
		builderRunId: ArtifactIdSchema.optional(),
		repetitions: z.number().int().min(1).max(10),
		reason: NonBlankSchema.max(4_000),
	}),
	z.strictObject({
		kind: z.literal("abandon-candidate"),
		candidateId: ArtifactIdSchema.optional(),
		reason: NonBlankSchema.max(4_000),
	}),
	z.strictObject({
		kind: z.literal("review-candidate"),
		candidateId: ArtifactIdSchema.optional(),
		recommendation: z.enum(["promote", "reject"]),
		reason: NonBlankSchema.max(4_000),
	}),
	z.strictObject({
		kind: z.literal("promote-candidate"),
		candidateId: ArtifactIdSchema.optional(),
		version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/).max(50),
		reason: NonBlankSchema.max(4_000),
	}),
	z.strictObject({
		kind: z.literal("reject-candidate"),
		candidateId: ArtifactIdSchema.optional(),
		reason: NonBlankSchema.max(4_000),
	}),
]);
export type WorkbenchDecisionInput = z.infer<typeof WorkbenchDecisionInputSchema>;

/** Host-owned execution hooks. These are deliberately outside the model-facing decision schema. */
export interface WorkbenchDecisionExecutionOptions {
	signal?: AbortSignal;
	onRunEvent?: RunEventListener;
}

export interface WorkbenchConfirmation {
	kind: WorkbenchDecisionInput["kind"];
	title: string;
	reason: string;
	subject: unknown;
	subjectHash: string;
}

export interface WorkbenchHumanApproval {
	approved: boolean;
	/** Host-owned identity. Ignored when approved=false. */
	actorId?: string;
}

export interface WorkbenchSealedChoice {
	approved: boolean;
	actorId?: string;
	/** Index into the opaque host list, never a corpus id supplied by Builder Pi. */
	selectedIndex?: number;
}

export interface WorkbenchHumanGate {
	confirm(confirmation: WorkbenchConfirmation, signal?: AbortSignal): Promise<WorkbenchHumanApproval>;
	selectSealed(
		request: {
			title: string;
			options: readonly { label: string; taskCount: number }[];
		},
		signal?: AbortSignal,
	): Promise<WorkbenchSealedChoice>;
}

export interface WorkbenchTurn {
	kind: WorkbenchSubmitInput["kind"];
	message: string;
	artifact: Record<string, unknown> | null;
	view: WorkbenchView;
}

export interface WorkbenchDecisionResult {
	kind: WorkbenchDecisionInput["kind"];
	message: string;
	result: Record<string, unknown>;
	view: WorkbenchView;
}
