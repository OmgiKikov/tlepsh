import { z } from "zod";
import type { GateSurface, GateVerdict } from "../domain/comparison-gate.js";
import {
	BuilderCorpusDraftCoverageNotesSchema,
	BuilderCorpusDraftTasksInputSchema,
} from "../application/builder-corpus-draft.js";
import { BuilderCorpusImportSourcePathSchema } from "../application/builder-corpus-import-contract.js";
import { BuilderWorkbenchCorpusRevisionOperationsSchema } from "../application/builder-regression-case.js";
import { HarnessAuthoringIntentsSchema } from "../application/harness-authoring.js";
import {
	TargetModelSelectionSchema,
	type TargetModelSelection,
} from "../application/target-model-selection.js";
import { TargetAuthoringContextClaimSchema } from "../application/target-authoring-context.js";
import {
	FailureModeIdSchema,
	ProposalBasisSelectionSchema,
} from "../application/improvement-brief.js";
import type { RunEventListener } from "../run-events.js";
import type { TargetManifest } from "../manifest.js";
import { AgentSpecSchema, type AgentSpec } from "../spec.js";
import type { BuilderCorpusDraft } from "../application/builder-corpus-draft.js";
import type { PersistedBuilderRun } from "../application/builder-proposal.js";
import type { CandidateImpact } from "../application/candidate-impact.js";
import type { TargetAdoptionReceipt } from "../application/target-adoption.js";
import type { TargetAuthoringContext } from "../application/target-authoring-context.js";
import type { ImprovementBrief } from "../application/improvement-brief.js";
import type { DiagnosisRecord } from "../diagnosis.js";
import type { CandidateStatus, ComparisonSummaryEvidence } from "../domain/candidate.js";
import type { EvalRunSummary } from "../eval.js";
import type { CycleContinuationReceipt } from "./cycle-continuation.js";

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
	"candidate-adoption",
	"complete",
	"selection-required",
]);
export type WorkbenchStage = z.infer<typeof WorkbenchStageSchema>;

/** Non-secret Target model identity plus host-side credential presence. */
export interface WorkbenchTargetModelSummary {
	provider: string;
	id: string;
	/** Environment variable name only; the value never enters a view. */
	apiKeyEnv: string;
	credentialPresent: boolean;
}

/** Exact reviewable projection of one Builder proposal run. */
export interface WorkbenchProposalReview {
	runId: string;
	proposalHash: string;
	baseTargetSha: string;
	summary: string;
	paths: string[];
	risks: string[];
	validationPlan: string[];
	authoringContext: PersistedBuilderRun["request"]["authoringContext"];
	evidenceBasis: {
		algorithmId: string;
		evalRunId: string;
		diagnosisId: string;
		briefId: string;
		briefSha256: string;
		failureModes: { failureModeId: string; modeSha256: string }[];
		runRefs: string[];
	} | null;
	exactDiff: string;
}

/** Human-facing projection of one comparison-gate verdict. Never carries task ids. */
export interface WorkbenchGateProjection {
	verdict: GateVerdict;
	surface: GateSurface;
	delta: number;
	confidence95: { low: number; high: number };
	tasks: number;
	repetitions: number;
	excludedTasks: number;
	flags: { regressedTasks: number; improvedTasks: number; collapsedTasks: number };
	reasons: string[];
}

/**
 * Human-facing projection of one A/A calibration run: how much the Target
 * moves against itself on the reviewed development basket. It is measurement,
 * never evidence for promotion.
 */
export interface WorkbenchCalibrationProjection {
	candidateId: string;
	/** Exact Target revision both arms ran; calibration expires with it. */
	targetSha: string;
	taskCount: number;
	repetitions: number;
	/** Baseline arm pass rate; the A/A operating point p. */
	aaPassRate: number;
	delta: number;
	confidence95: { low: number; high: number };
	/** Share of cases that moved at all between two identical arms. */
	flipRate: number;
	/** Smallest k ∈ 1..5 whose expected noise band is at most 10 points. */
	recommendedRepetitions: number;
	/** Development verdict; `inconclusive` is the healthy A/A result. */
	verdict: GateVerdict;
	at: string;
}

export interface WorkbenchCandidateSummary {
	candidateId: string;
	status: CandidateStatus;
	projectId: string;
	targetId: string;
	specId: string | null;
	proposalId: string;
	baseline: { ref: string; sha: string };
	candidate: { ref: string; sha: string } | null;
	development: {
		baselineEvalRunId: string;
		candidateEvalRunId: string;
		comparison: ComparisonSummaryEvidence | null;
		/** v3 gate verdict; null for legacy evidence. */
		gate: WorkbenchGateProjection | null;
	} | null;
	sealedHoldout: { executed: boolean; gatePassed: boolean; gate: WorkbenchGateProjection | null };
	review: { experimentId: string; recommendation: "promote" | "reject"; reason: string } | null;
	promotion: { tag: string; reason: string; at: string } | null;
	rejection: { reason: string; at: string } | null;
}

export interface WorkbenchDiagnosisSummary {
	diagnosisId: string;
	evalRunId: string;
	status: DiagnosisRecord["status"];
	summary: DiagnosisRecord["summary"];
	issues: {
		issueId: string;
		category: DiagnosisRecord["issues"][number]["category"];
		severity: DiagnosisRecord["issues"][number]["severity"];
		confidence: DiagnosisRecord["issues"][number]["confidence"];
		summary: string;
		rootCause: string;
		suggestions: string[];
	}[];
	omittedIssues: number;
}

export interface WorkbenchFailureModeProjection {
	ordinal: number;
	failureModeId: string;
	category: ImprovementBrief["modes"][number]["category"];
	scope: ImprovementBrief["modes"][number]["scope"];
	severity: ImprovementBrief["modes"][number]["severity"];
	evidenceStrength: ImprovementBrief["modes"][number]["evidenceStrength"];
	decision: ImprovementBrief["modes"][number]["decision"];
	selectableForProposal: boolean;
	title: string;
	summary: string;
	hypothesis: string;
	suggestions: string[];
	impact: ImprovementBrief["modes"][number]["impact"];
	taskIds: string[];
	evidence: { runId: string; taskId: string; traceAvailable: boolean; graderNames: string[] }[];
	omittedEvidenceCount: number;
}

/** Small model-facing diagnosis projection; full evidence remains in the verified report. */
export interface WorkbenchImprovementBriefProjection {
	schemaVersion: ImprovementBrief["schemaVersion"];
	algorithmId: ImprovementBrief["algorithmId"];
	briefId: string;
	evalRunId: string;
	diagnosisId: string;
	status: ImprovementBrief["status"];
	proposalEligible: boolean;
	headline: string;
	summary: ImprovementBrief["summary"];
	modes: WorkbenchFailureModeProjection[];
	conversationProjection: {
		shownModes: number;
		addressableModes: number;
		omittedModes: number;
		fullEvidence: string;
	};
}

export type WorkbenchEvidenceLinkProjection =
	| { available: true; url: string; label?: string }
	| { available: false };

export interface WorkbenchEvaluationProjection {
	evalRunId: string;
	summary: EvalRunSummary;
	repetitions: number;
}

/** Bounded candidate impact projection or the exact reason it is unavailable. */
export type WorkbenchCandidateImpactProjection =
	| { available: true; impact: CandidateImpact }
	| { available: false; reason: string };

export type WorkbenchReviewDetail =
	| { kind: "spec-draft"; id: string; snapshotHash: string; spec: AgentSpec }
	| {
		kind: "corpus-draft";
		id: string;
		draftHash: string;
		approvedSpec: BuilderCorpusDraft["approvedSpec"];
		name: string;
		coverageNotes: string[];
		importSource: NonNullable<BuilderCorpusDraft["importSource"]> | null;
		tasks: BuilderCorpusDraft["tasks"];
		taskProvenance: NonNullable<BuilderCorpusDraft["taskProvenance"]>;
	}
	| ({ kind: "proposal" } & WorkbenchProposalReview)
	| ({ kind: "applied-proposal" } & WorkbenchProposalReview & {
		application: { branch: string; baseTargetSha: string; candidateSha: string; appliedAt: string };
	})
	| ({ kind: "candidate" } & WorkbenchCandidateSummary & {
		adoption: { receiptId: string; adoptedAt: string; branch: string } | null;
		continuation: { receiptId: string; continuedAt: string } | null;
		impact: WorkbenchCandidateImpactProjection | null;
	})
	| ({ kind: "interrupted-candidate" } & WorkbenchCandidateSummary)
	| { kind: "workflow"; stage: WorkbenchStage; headline: string };

export interface WorkbenchTracesDetail {
	evaluation: WorkbenchEvaluationProjection;
	diagnosis: WorkbenchDiagnosisSummary;
	improvementBrief: WorkbenchImprovementBriefProjection;
	evidence: WorkbenchEvidenceLinkProjection;
}

export type WorkbenchTargetDetail = TargetAuthoringContext | { launch: "ahde init ." };

export type WorkbenchDetail =
	| { aspect: "review"; content: WorkbenchReviewDetail }
	| { aspect: "traces"; content: WorkbenchTracesDetail }
	| { aspect: "target"; content: WorkbenchTargetDetail };

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
		model: WorkbenchTargetModelSummary | null;
	};
	focus: Partial<Record<WorkbenchSelectionKind, string>>;
	selections: WorkbenchSelectionSummary[];
	actions: string[];
	blockers: string[];
	warnings: string[];
	/** Newest A/A calibration of the exact active Target revision, if any. */
	calibration: WorkbenchCalibrationProjection | null;
	detail?: WorkbenchDetail;
	counts: {
		specDrafts: number;
		approvedSpecs: number;
		corpusDrafts: number;
		developmentCorpora: number;
		sealedCorpora: number;
		developmentEvals: number;
		openProposals: number;
		candidates: number;
		calibrations: number;
	};
}

export const WorkbenchViewQuerySchema = z.strictObject({
	aspect: z.enum(["summary", "traces", "review", "target"]).optional(),
	resourcePath: z.string().min(1).max(500).optional(),
}).superRefine((query, context) => {
	if (query.resourcePath !== undefined && query.aspect !== "target") {
		context.addIssue({
			code: "custom",
			path: ["resourcePath"],
			message: "resourcePath is valid only for the Target view",
		});
	}
});
export type WorkbenchViewQuery = z.infer<typeof WorkbenchViewQuerySchema>;

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
	/** Host-minted claim from the exact Target overview/resource view used to author these intents. */
	authoringContext: TargetAuthoringContextClaimSchema,
	approvedSpecId: ArtifactIdSchema.optional(),
	source: ProposalBasisSelectionSchema.omit({ failureModeIds: true }),
	failureModeIds: z.array(FailureModeIdSchema)
		.min(1)
		.max(8)
		.refine((ids) => new Set(ids).size === ids.length, "failure mode ids must be unique"),
	summary: NonBlankSchema.max(4_000),
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
		/** Builder-owned choices only; executable metadata is resolved by the trusted host. */
		model: TargetModelSelectionSchema,
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
		kind: z.literal("calibrate"),
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
	z.strictObject({
		kind: z.literal("adopt-candidate"),
		candidateId: ArtifactIdSchema.optional(),
		reason: NonBlankSchema.max(4_000),
	}),
	z.strictObject({
		kind: z.literal("continue-cycle"),
		candidateId: ArtifactIdSchema.optional(),
		reason: NonBlankSchema.max(4_000),
	}),
]);
export type WorkbenchDecisionInput = z.infer<typeof WorkbenchDecisionInputSchema>;

/** Host-owned execution hooks. These are deliberately outside the model-facing decision schema. */
export interface WorkbenchDecisionExecutionOptions {
	signal?: AbortSignal;
	onRunEvent?: RunEventListener;
	/** Resolve one bounded Builder selection through the current trusted host catalog. */
	resolveTargetModel?: (selection: TargetModelSelection) => TargetManifest["model"];
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

export interface WorkbenchRunEvalResult {
	evaluation: WorkbenchEvaluationProjection;
	diagnosis: WorkbenchDiagnosisSummary;
	improvementBrief: WorkbenchImprovementBriefProjection;
	evidence: WorkbenchEvidenceLinkProjection;
}

export interface WorkbenchVerifyCandidateResult {
	candidate: WorkbenchCandidateSummary;
	development: { verdict: GateVerdict; delta: number; confidence95: { low: number; high: number } };
	sealedHoldout: { executed: boolean; gatePassed: boolean; verdict: GateVerdict | null };
}

/** Typed payload of every consequential decision, keyed by its decision kind. */
export interface WorkbenchDecisionResultMap {
	"scaffold-target": { targetId: string; targetGitSha: string; receiptId: string };
	"configure-target": { targetId: string; targetGitSha: string; receiptId: string; credentialEnv: string };
	"approve-spec": { approvedSpecId: string; receiptId: string };
	"publish-corpus": {
		corpusId: string;
		corpusHash: string;
		taskCount: number;
		publicationReceiptId: string;
		lineageHash: string;
	};
	"run-eval": WorkbenchRunEvalResult;
	calibrate: { candidateId: string; calibration: WorkbenchCalibrationProjection };
	"run-current":
		| ({ resolvedAs: "run-eval" } & WorkbenchRunEvalResult)
		| ({ resolvedAs: "verify-candidate" } & WorkbenchVerifyCandidateResult);
	"apply-proposal": { runId: string; branch: string; candidateSha: string; proposalHash: string };
	"discard-proposal": { runId: string; receiptHash: string };
	"verify-candidate": WorkbenchVerifyCandidateResult;
	"abandon-candidate": {
		candidateId: string;
		interruptedStatus: "proposed" | "built" | "validated";
		receiptHash: string;
	};
	"review-candidate": WorkbenchCandidateSummary;
	"promote-candidate": { candidate: WorkbenchCandidateSummary; tag: string; candidateSha: string };
	"reject-candidate": WorkbenchCandidateSummary;
	"adopt-candidate": {
		candidate: WorkbenchCandidateSummary;
		disposition: "adopted" | "recovered" | "already-adopted";
		branch: string;
		fromSha: string;
		toSha: string;
		tag: string;
		receiptId: string;
	};
	"continue-cycle": {
		candidate: WorkbenchCandidateSummary;
		disposition: "recorded" | "already-recorded";
		activeTargetSha: string;
		receiptId: string;
		nextStage: WorkbenchStage;
	};
}

export type WorkbenchDecisionResult = {
	[K in WorkbenchDecisionInput["kind"]]: {
		kind: K;
		message: string;
		result: WorkbenchDecisionResultMap[K];
		view: WorkbenchView;
	};
}[WorkbenchDecisionInput["kind"]];

export type WorkbenchAdoptionReceiptSummary = Pick<TargetAdoptionReceipt, "receiptId" | "adoptedAt">;
export type WorkbenchContinuationReceiptSummary = Pick<CycleContinuationReceipt, "receiptId" | "continuedAt">;
