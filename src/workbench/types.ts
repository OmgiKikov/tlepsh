import { z } from "zod";
import { ProposalPredictionSchema, type ProposalPrediction } from "../builders/adapters.js";
import type { GateSurface, GateVerdict, SealedOutcome } from "../domain/comparison-gate.js";
import {
	BuilderCorpusDraftCoverageNotesSchema,
	BuilderCorpusDraftTasksInputSchema,
} from "../application/builder-corpus-draft.js";
import { BuilderCorpusImportSourcePathSchema } from "../application/builder-corpus-import-contract.js";
import {
	DatasetMappingRecipeSchema,
	DatasetSeedSchema,
	DatasetSourcePathSchema,
	type DatasetPreview,
} from "../application/dataset-ingest.js";
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
import type { GraderSpec, TargetManifest } from "../manifest.js";
import { AgentSpecSchema, type AgentSpec } from "../spec.js";
import type { BuilderCorpusDraft } from "../application/builder-corpus-draft.js";
import type { PersistedBuilderRun } from "../application/builder-proposal.js";
import type { CandidateImpact } from "../application/candidate-impact.js";
import type { TargetAdoptionReceipt } from "../application/target-adoption.js";
import type { TargetAuthoringContext } from "../application/target-authoring-context.js";
import type { ExperimentHistory } from "../application/experiment-history.js";
import type { ImprovementBrief } from "../application/improvement-brief.js";
import type { DiagnosisRecord } from "../diagnosis.js";
import type { CandidateStatus, ComparisonSummaryEvidence } from "../domain/candidate.js";
import type { EvalRunSummary } from "../eval.js";
import type {
	ImprovementLoopCycle,
	ImprovementLoopStopReason,
} from "../application/improvement-loop.js";
import type { ProposalSearchResult } from "../application/proposal-search.js";
import type { CandidateRegradeProjection, RegradeDiff } from "../application/regrade-decision.js";
import type { CycleContinuationReceipt } from "./cycle-continuation.js";
import type { WorkbenchGateClass, WorkbenchRunEstimate } from "./transition-policy.js";

// A regex, not a refinement: the generated tool schema carries `pattern` so the
// model sees the constraint instead of only being corrected by it.
const NonBlankSchema = z.string().min(1).regex(/\S/, "expected non-blank text");
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
	/** The promise hashed into this exact proposal; null on a pre-v2 proposal. */
	prediction: ProposalPrediction | null;
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
	/** Pass-rate delta, shown next to the score the gate decided on. */
	delta: number;
	baselineScore: number;
	candidateScore: number;
	/** The mean paired score delta the interval brackets. */
	scoreDelta: number;
	confidence95: { low: number; high: number };
	tasks: number;
	repetitions: number;
	excludedTasks: number;
	flags: { regressedTasks: number; improvedTasks: number; collapsedTasks: number };
	/** Cost/latency/token ratios of candidate over baseline. Rendered, never gating. */
	resources: { costRatio: number | null; latencyRatio: number | null; tokenRatio: number | null };
	reasons: string[];
	/**
	 * What a sealed `pass` showed: `improved` when the whole interval is above
	 * zero, `no-regression` when it spans it. Absent on every other verdict and
	 * on the development surface. `outcomeLine` is the phrase every surface
	 * renders, so the Builder quotes it instead of saying "the exam passed".
	 */
	outcome?: SealedOutcome;
	outcomeLine?: string;
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
	/**
	 * Cases an exam would need before a ±10 pp difference could show through
	 * this much noise. Null when too few tasks measured it.
	 */
	recommendedExamCases: number | null;
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
	/**
	 * Who put the diff on the branch, and how. A non-null `via` means a human
	 * authorized an automated improve/search trial, not this individual diff:
	 * review and ship say so and show the exact hash-bound proposal. Null for a
	 * manual candidate.
	 */
	appliedBy?: { actorId: string; via: "improvement-loop" | "proposal-search" | null; paths: string[] } | null;
	/**
	 * What this candidate measured, in the operator's language, as one sentence
	 * the host composed: the score the gate decided on, its interval, the design
	 * size, the pass rate behind it, and the sealed exam where one ran. Every
	 * panel, the growth log, the passport and this field are the same string, so
	 * the Builder quotes it instead of computing a delta of its own.
	 */
	headline: string;
	development: {
		baselineEvalRunId: string;
		candidateEvalRunId: string;
		comparison: ComparisonSummaryEvidence | null;
		/** v4 gate verdict; null for legacy (v1–v3) evidence. */
		gate: WorkbenchGateProjection | null;
	} | null;
	sealedHoldout: {
		executed: boolean;
		gatePassed: boolean;
		gate: WorkbenchGateProjection | null;
		/**
		 * What the judge was asked for and what survived, for an exam this
		 * project generated. Read off the sealed-synthesis receipt so a screen
		 * can say why an exam ordered at 20 cases ran on 19; absent for an exam
		 * the operator brought, whose provenance is theirs.
		 */
		generation?: { requested: number; accepted: number; droppedDuplicate: number; droppedMalformed: number } | null;
	};
	/**
	 * How far the judge behind this evidence has been checked against a human.
	 * Absent when the evidence leans on no judge grader; null when it does and
	 * nobody has labelled that judge yet.
	 */
	judgeAgreement?: { agreement: number; kappa: number | null; labels: number } | null;
	/**
	 * Both development arms re-scored with one revised rubric, when the project
	 * holds such a pair. It is read beside the recorded verdict and never in
	 * place of it: a re-score is not a new baseline, and this candidate was
	 * decided by the graders that were in force when its answers were scored.
	 */
	regraded?: CandidateRegradeProjection | null;
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
	/** The family this mode is: what the check was, and what it named. */
	signature: ImprovementBrief["modes"][number]["signature"];
	category: ImprovementBrief["modes"][number]["category"];
	scope: ImprovementBrief["modes"][number]["scope"];
	severity: ImprovementBrief["modes"][number]["severity"];
	evidenceStrength: ImprovementBrief["modes"][number]["evidenceStrength"];
	decision: ImprovementBrief["modes"][number]["decision"];
	/** Every failure here was a judge that could not tell. Absent otherwise. */
	abstained?: boolean;
	selectableForProposal: boolean;
	title: string;
	summary: string;
	/** What the cited traces show, in canonical English; screens re-say it. */
	facts: string;
	observations: ImprovementBrief["modes"][number]["observations"];
	observedRuns: number;
	suggestions: string[];
	impact: ImprovementBrief["modes"][number]["impact"];
	taskIds: string[];
	evidence: ImprovementBrief["modes"][number]["evidence"];
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
	/**
	 * Cases the agent got right in EVERY repetition, and how many were measured
	 * at all. Derived at read time from the run records — nothing durable — so
	 * the panel can say `5 of 12 passed · 3 in every repetition` instead of
	 * leaving a pass rate to stand for two very different baskets.
	 */
	stableTasks: { stable: number; measured: number };
	/** When it finished, the exact revision it measured, and the basket it ran. */
	finishedAt: string;
	targetGitSha: string;
	corpus: { name: string; taskCount: number } | null;
}

/** Bounded candidate impact projection or the exact reason it is unavailable. */
export type WorkbenchCandidateImpactProjection =
	| { available: true; impact: CandidateImpact }
	| { available: false; reason: string };

/**
 * The failure modes a proposal promised about, named the way the diagnosis
 * panel names them.
 *
 * The attestation inside the proposal carries ids and content hashes — the
 * right thing to hash, the wrong thing to show: the forecast read `Ожидаю тип
 * сбоя «fb9f2a97» 4/4 → ≤0/4` while the diagnosis above it had already said
 * "check_dbo was never called". This is read off the brief the attestation
 * names and travels with the VIEW only; nothing here enters the bytes a human
 * approves, so a language never changes a decision subject.
 */
export interface WorkbenchTargetedModeTitles {
	targetedModes?: { failureModeId: string; title: string }[];
}

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
	| ({ kind: "proposal" } & WorkbenchProposalReview & WorkbenchTargetedModeTitles)
	| ({ kind: "applied-proposal" } & WorkbenchProposalReview & WorkbenchTargetedModeTitles & {
		application: { branch: string; baseTargetSha: string; candidateSha: string; appliedAt: string };
	})
	| ({ kind: "candidate" } & WorkbenchCandidateSummary & {
		/** Exact proposal behind an applied Builder candidate, including its diff. */
		proposal?: WorkbenchProposalReview | null;
		/** Read-side corruption is visible while rejection remains available. */
		proposalError?: string | null;
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
	/**
	 * How far the judge that graded THIS run has been checked against a human.
	 * Absent when no judge graded it, so the panel stays silent; null when one
	 * did and nobody has labelled it — which is a statement, never a blocker.
	 */
	judgeAgreement?: WorkbenchCandidateSummary["judgeAgreement"];
	/** Grader results this run lost to a judge that said it could not tell. */
	judgeAbstained?: number;
	/**
	 * The worlded cases of the basket this run scored, bounded, each keyed by
	 * the task it belongs to.
	 *
	 * A case with a world is not a question with an answer: it is a person, a
	 * state, a want and an obligation, and reading it as a row of a table loses
	 * three of the four. `/traces` shows these as the same four-line card the
	 * dataset view uses, and `/trace` joins on `taskId` to say what the world
	 * held before the conversation.
	 */
	worldCases?: Array<WorkbenchDatasetCase & { taskId: string }>;
}

export type WorkbenchTargetDetail = TargetAuthoringContext | { launch: "ahde init ." };

/**
 * What was already tried on this Target, newest first. Compiled from immutable
 * candidate records: sealed evidence contributes a verdict and a design size,
 * never a task, an input or a corpus identity, and nothing here carries a hash,
 * a receipt or a byte of trace content.
 */
export interface WorkbenchHistoryDetail {
	attempts: ExperimentHistory["attempts"];
	/** Attempts that exist but did not fit the cap. */
	omitted: number;
	/** Candidate directories that could not be read as records. */
	unreadable: number;
}

/**
 * One inbox file as the host reads it. The preview is bounded and
 * credential-redacted, and the rows a sealed slice already reserved are gone
 * before it is computed, so nothing here describes the exam.
 */
export interface WorkbenchDatasetDetail {
	sourcePath: string;
	preview: DatasetPreview;
}

export type WorkbenchDetail =
	| { aspect: "review"; content: WorkbenchReviewDetail }
	| { aspect: "traces"; content: WorkbenchTracesDetail }
	| { aspect: "target"; content: WorkbenchTargetDetail }
	| { aspect: "history"; content: WorkbenchHistoryDetail }
	| { aspect: "dataset"; content: WorkbenchDatasetDetail };

export interface WorkbenchSelectionSummary {
	kind: WorkbenchSelectionKind;
	id: string;
	label: string;
	status?: string;
	selected: boolean;
}

/**
 * One blocker as a code the host can localize, plus whatever detail only the
 * raw text carries (an id, a path, an integrity failure). `params` holds the
 * already-bent nouns and counts the message interpolates.
 */
export interface WorkbenchBlockerReason {
	code: string;
	params?: Record<string, string | number>;
	/** Free text the code cannot carry, appended after the localized sentence. */
	detail?: string;
}

/**
 * Apply is durable; the verification funded by the same confirmation is not.
 * A missing exam, a declined holdout or a runtime failure stops it, and the
 * refusal is minted twice for the same reason blockers are: `reason` is the
 * English sentence the model reads, `reasonCode` the typed form the host
 * renders in the operator's language. The English used to be the only form,
 * and it reached the operator inside the `◆` headline, cut mid-word.
 */
export interface WorkbenchVerificationBlocked {
	outcome: "blocked";
	reason: string;
	reasonCode?: WorkbenchBlockerReason;
}

/**
 * The one workshop a project can have, as the view reports it.
 *
 * `live` is this process's own open handle — the same fact `workshopOpen`
 * carries for the tool gate. `recorded` is the note a previous Builder process
 * left under the state root with its worktree still on disk: exactly what
 * `{ kind: "workshop-open", workshopId }` re-attaches to, and the only state
 * that is offered as a place to continue. `stale` is a note that re-attaches to
 * nothing any more, so it is reported as a dead end rather than as work waiting.
 */
export type WorkbenchWorkshopSummary =
	| {
		state: "live" | "recorded";
		workshopId: string;
		/** What the workshop is bound to: an approved Spec, or a diagnosis. */
		basis: "construction" | "improvement";
		/** The improvement brief it aims at; null for a construction workshop. */
		briefId: string | null;
		openedAt: string;
	}
	| {
		state: "stale";
		/** What a re-attach would refuse on. Both are dead ends, for different reasons. */
		reason: "worktree-gone" | "unreadable-note";
		/** Null when the note itself cannot be read, so it names no workshop. */
		workshopId: string | null;
	};

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
		/**
		 * The two models a measurement uses besides the agent. A `null` role means
		 * the manifest has no such block — the thing the Builder checks before it
		 * writes a judge grader or a simulated-user case. Optional only so a view
		 * serialized before evaluator setup existed still parses; every view this
		 * Workbench builds carries it.
		 */
		evaluators?: {
			judge: WorkbenchTargetModelSummary | null;
			simulatedUser: WorkbenchTargetModelSummary | null;
		};
		/** Which evaluator roles the currently selected development surface calls. */
		evaluatorRequirements?: {
			judge: boolean;
			simulatedUser: boolean;
		};
		/**
		 * Every environment variable a declared tool says it needs, and whether
		 * anything is exported under that name. The name is policy, never the
		 * value: a tool credential is entered in the operator's own shell, and
		 * neither the Builder nor this projection ever reads what it holds.
		 */
		toolCredentials?: readonly { tool: string; environment: string; present: boolean }[];
	};
	focus: Partial<Record<WorkbenchSelectionKind, string>>;
	selections: WorkbenchSelectionSummary[];
	/**
	 * Host-side stage hints in loose words. The model-facing projection replaces
	 * this with the derived `next` block, so nothing outside the host reads it.
	 */
	actions: string[];
	/**
	 * True while the five workshop tools are legal. Not derived from the
	 * inventory — the open workshop is live host state — so it is attached
	 * where the view is rendered rather than where the stage is computed.
	 */
	workshopOpen?: boolean;
	/**
	 * The one workshop this project has, live or on disk. Absent means there is
	 * none of either.
	 *
	 * {@link workshopOpen} is process memory and answers one question: are the
	 * five workshop tools legal right now. It says nothing after a restart,
	 * which is how a Builder that had a half-written harness in a worktree read
	 * “no open workshop” and wrote the whole prompt a second time. This field is
	 * read from the durable note instead, so a fresh process is told the
	 * workshop is still there and which id re-attaches to it.
	 */
	workshop?: WorkbenchWorkshopSummary;
	/**
	 * The standing offer to check the judge by hand, once one has graded
	 * something. Live host state like `workshopOpen`: the marker and the label
	 * count live under the state root, not in the artifacts the stage is
	 * derived from. Absent means the offer was never made.
	 */
	judgeCalibration?: { labelled: number; offered: boolean };
	blockers: string[];
	/**
	 * The same blockers as a typed reason, index-aligned with {@link blockers}.
	 *
	 * `blockers` is the English sentence the Builder model reads and scripts
	 * match on; the host draws the operator's language from the code instead, so
	 * a Russian screen never has to print an English rule. Optional because a
	 * view serialized before this field existed still parses — a host with no
	 * reason simply renders the sentence it already had.
	 */
	blockerReasons?: readonly WorkbenchBlockerReason[];
	warnings: string[];
	/**
	 * Coarse, model-safe release readiness. It never carries a holdout id, name,
	 * hash, task, or grader; the Builder only learns whether the operator-owned
	 * exam is large enough to make a future ship decision meaningful.
	 */
	shippingReadiness?: {
		sealedHoldout: "missing" | "underpowered" | "ready" | "unavailable";
		minimumTasks: number;
		/**
		 * Cases in the largest verified exam, so a shortfall can say how many are
		 * missing instead of "fewer than the minimum". A count, never content:
		 * every other surface already prints it beside the verdict.
		 */
		sealedCases: number | null;
		/**
		 * The most questions this Target's knowledge base could ever answer, when
		 * it declares one. A ceiling, not an offer: without it the Builder read a
		 * three-question exam and proposed loading twelve more from a base that
		 * did not have them (live session 8). Absent when no knowledge base is
		 * declared, or when it cannot be read.
		 */
		maxKbQuestions?: number;
	};
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

/** Bulk parts of the view a caller must ask for; the model-facing projection drops them otherwise. */
export const WorkbenchViewIncludeSchema = z.enum(["selections"]);
export type WorkbenchViewInclude = z.infer<typeof WorkbenchViewIncludeSchema>;

export const WorkbenchViewQuerySchema = z.strictObject({
	aspect: z.enum(["summary", "traces", "review", "target", "history", "dataset"]).optional(),
	resourcePath: z.string().min(1).max(500).optional(),
	/**
	 * Projection hint read by the model-facing transport, not by the Workbench:
	 * `["selections"]` asks for the full selectable-artifact list, which every
	 * human renderer always receives.
	 */
	include: z.array(WorkbenchViewIncludeSchema).max(1).optional(),
}).superRefine((query, context) => {
	if (query.resourcePath !== undefined && query.aspect !== "target" && query.aspect !== "dataset") {
		context.addIssue({
			code: "custom",
			path: ["resourcePath"],
			message: "resourcePath is valid only for the Target and dataset views",
		});
	}
	if (query.aspect === "dataset" && query.resourcePath === undefined) {
		context.addIssue({
			code: "custom",
			path: ["resourcePath"],
			message: "the dataset view needs the imports/ path of the file to preview",
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
	/** The schema version is host-owned; a Builder never authors or restates it. */
	spec: AgentSpecSchema.extend({ schemaVersion: z.literal(1).default(1) }),
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

/**
 * A proposed reading of one inbox file. The Builder writes it from the preview
 * alone; the host re-validates it against the real columns and answers with the
 * first cases it produces, so the human argues with cases, not with JSON.
 */
const DatasetRecipeInputSchema = z.strictObject({
	kind: z.literal("dataset-recipe"),
	approvedSpecId: ArtifactIdSchema.optional(),
	sourcePath: DatasetSourcePathSchema,
	recipe: DatasetMappingRecipeSchema,
	name: NonBlankSchema.max(200),
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
	/** Omitted for Spec-backed construction; required for evidence-backed improvement. */
	source: ProposalBasisSelectionSchema.omit({ failureModeIds: true }).optional(),
	failureModeIds: z.array(FailureModeIdSchema)
		.min(1)
		.max(8)
		.refine((ids) => new Set(ids).size === ids.length, "failure mode ids must be unique")
		.optional(),
	summary: NonBlankSchema.max(4_000),
	intents: HarnessAuthoringIntentsSchema,
	risks: z.array(NonBlankSchema.max(4_000)).max(100).default([]),
	validationPlan: z.array(NonBlankSchema.max(4_000)).min(1).max(100),
	/**
	 * The falsifiable promise this change is judged against. It is hashed into
	 * the proposal the operator applies, so it cannot be edited once the result
	 * is in. A construction proposal names no mode: there is no measurement yet.
	 */
	prediction: ProposalPredictionSchema.optional(),
}).superRefine((value, context) => {
	if ((value.source === undefined) !== (value.failureModeIds === undefined)) {
		context.addIssue({
			code: "custom",
			message: "an evidence-backed structured proposal needs both source and failureModeIds, or neither",
		});
	}
});

/**
 * Open the one writable surface Builder Pi ever gets: a detached worktree of
 * the exact clean Target commit, scoped to the Harness. It changes nothing
 * durable, so it is a submission, not a decision.
 */
const OpenWorkshopInputSchema = z.strictObject({
	kind: z.literal("workshop-open"),
	approvedSpecId: ArtifactIdSchema.optional(),
	/**
	 * Re-attach to the workshop a previous Builder process left open. The host
	 * verifies the recorded worktree and its snapshot hash and fails closed on a
	 * mismatch; the id grants nothing on its own.
	 */
	workshopId: z.string().regex(/^workshop_[0-9a-f]{16}$/).optional(),
	/** Reopen a closed proposal for revision: its exact diff seeds the worktree. */
	fromProposalRunId: ArtifactIdSchema.optional(),
});

/**
 * Close the workshop by compiling its worktree diff into the ordinary immutable
 * proposal. A diagnosis-backed workshop carries the same evidence binding as
 * `structured-proposal`; a Spec-backed construction workshop carries none, and
 * must not name any — its proposal is recorded with `source: null`.
 */
const CloseWorkshopInputSchema = z.strictObject({
	kind: z.literal("workshop-close"),
	approvedSpecId: ArtifactIdSchema.optional(),
	source: ProposalBasisSelectionSchema.omit({ failureModeIds: true }).optional(),
	failureModeIds: z.array(FailureModeIdSchema)
		.min(1)
		.max(8)
		.refine((ids) => new Set(ids).size === ids.length, "failure mode ids must be unique")
		.optional(),
	summary: NonBlankSchema.max(4_000),
	risks: z.array(NonBlankSchema.max(4_000)).max(100).default([]),
	validationPlan: z.array(NonBlankSchema.max(4_000)).min(1).max(100),
	/** The same falsifiable promise a `structured-proposal` carries. */
	prediction: ProposalPredictionSchema.optional(),
}).superRefine((value, context) => {
	if ((value.source === undefined) !== (value.failureModeIds === undefined)) {
		context.addIssue({
			code: "custom",
			message: "an evidence-backed close needs both source and failureModeIds, or neither",
		});
	}
});

/** Throw the workshop away unread. Nothing it wrote ever existed. */
const DiscardWorkshopInputSchema = z.strictObject({
	kind: z.literal("workshop-discard"),
});

/**
 * Where an open workshop lives between two Builder processes. This is selection
 * state, like focus: it grants nothing, it is not a receipt, and re-attaching
 * re-derives every fact and refuses on a snapshot-hash mismatch.
 */
export const PersistedWorkbenchWorkshopSchema = z.strictObject({
	schemaVersion: z.literal(1),
	workshopId: z.string().regex(/^workshop_[0-9a-f]{16}$/),
	targetId: z.string().min(1).max(100),
	baseTargetSha: z.string().regex(/^[0-9a-f]{40}$/),
	basis: z.enum(["construction", "improvement"]),
	approvedSpecId: ArtifactIdSchema,
	/** Exact improvement lineage captured at open; null for construction/legacy notes. */
	source: ProposalBasisSelectionSchema.omit({ failureModeIds: true }).nullable().default(null),
	fromProposalRunId: ArtifactIdSchema.nullable(),
	worktreePath: z.string().min(1).max(4_096),
	scratchRoot: z.string().min(1).max(4_096),
	openedAt: z.iso.datetime({ offset: true }),
	snapshotHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
	toolAuthoringPolicy: z.strictObject({
		network: z.enum(["deny", "allow"]),
		environmentAllowlist: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,199}$/)).max(64),
	}).optional(),
	tryHistory: z.array(z.strictObject({
		tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
		test: z.string().min(1).max(200).nullable(),
		passed: z.boolean(),
		exitCode: z.number().int().nullable(),
		timedOut: z.boolean(),
		truncated: z.boolean(),
		durationMs: z.number().int().nonnegative(),
		failure: z.string().max(240).nullable(),
		snapshotHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
		at: z.iso.datetime({ offset: true }),
	})).max(32).optional(),
	// Legacy V1 notes persisted grants here. Parse them only so an existing
	// workshop can be re-attached safely; the reattach path deliberately ignores
	// them and every new descriptor omits them. Editable selection state grants
	// no runtime authority.
	grants: z.array(z.strictObject({
		tool: z.string().min(1).max(64),
		wants: z.array(NonBlankSchema.max(200)).min(1).max(8),
		grantedAt: z.iso.datetime({ offset: true }),
		actorId: z.string().min(1).max(200),
	})).max(32).optional(),
});
export type PersistedWorkbenchWorkshop = z.infer<typeof PersistedWorkbenchWorkshopSchema>;

export const WorkbenchSubmitInputSchema = z.discriminatedUnion("kind", [
	SelectInputSchema,
	SaveSpecDraftInputSchema,
	CreateCorpusDraftInputSchema,
	ImportCorpusDraftInputSchema,
	DatasetRecipeInputSchema,
	ReviseCorpusDraftInputSchema,
	StructuredProposalInputSchema,
	OpenWorkshopInputSchema,
	CloseWorkshopInputSchema,
	DiscardWorkshopInputSchema,
]);

// ---------------------------------------------------------------------------
// The five tools that exist only while a workshop is open. Their authority is
// the open workshop itself: no repository, no revision, no absolute path, and
// no scope ever arrives from the model.

const WorkshopPathSchema = z.string().min(1).max(200);

export const WorkshopReadInputSchema = z.strictObject({
	path: WorkshopPathSchema,
});
export type WorkshopReadInput = z.infer<typeof WorkshopReadInputSchema>;

export const WorkshopWriteInputSchema = z.strictObject({
	path: WorkshopPathSchema,
	/** Whole-file form. */
	content: z.string().max(512 * 1024).optional(),
	/** Exact-replacement form: `oldText` must occur exactly once in the file. */
	oldText: z.string().min(1).max(512 * 1024).optional(),
	newText: z.string().max(512 * 1024).optional(),
	/** Removal form. */
	remove: z.literal(true).optional(),
	mode: z.enum(["100644", "100755"]).optional(),
}).superRefine((value, context) => {
	const forms = [
		value.content !== undefined,
		value.oldText !== undefined || value.newText !== undefined,
		value.remove === true,
	].filter(Boolean).length;
	if (forms !== 1) {
		context.addIssue({ code: "custom", message: "use exactly one of content, oldText+newText, or remove" });
	}
	if ((value.oldText === undefined) !== (value.newText === undefined)) {
		context.addIssue({ code: "custom", message: "an exact replacement needs both oldText and newText" });
	}
});
export type WorkshopWriteInput = z.infer<typeof WorkshopWriteInputSchema>;

export const WorkshopBashInputSchema = z.strictObject({
	/** argv[0] is a bare PATH command or an absolute path; there is no shell. */
	argv: z.array(z.string().min(1).max(4096)).min(1).max(64),
	cwd: WorkshopPathSchema.optional(),
	timeoutMs: z.number().int().min(1).max(600_000).optional(),
});
export type WorkshopBashInput = z.infer<typeof WorkshopBashInputSchema>;

export const WorkshopTryInputSchema = z.strictObject({
	tool: z.string().min(1).max(64),
	/** JSON arguments, validated against the tool's own declared schema. */
	input: z.unknown(),
	/**
	 * Ignore `input` and run every `tools/<tool>/fixtures/*.json` instead. One
	 * question authorizes the whole run; the answer is per-fixture pass/fail.
	 */
	fixtures: z.boolean().optional(),
});
export type WorkshopTryInput = z.infer<typeof WorkshopTryInputSchema>;
/** Caller input; downstream defaults are materialized by parse inside Workbench. */
export type WorkbenchSubmitInput = z.input<typeof WorkbenchSubmitInputSchema>;

export const WorkbenchDecisionInputSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("scaffold-target"),
		reason: NonBlankSchema.max(4_000),
	}),
	/**
	 * Adopt the agent that is already in this folder. Deliberately NOT called
	 * `adopt-*`: that name belongs to candidate adoption, which fast-forwards a
	 * Target onto a promoted revision. This wraps an operator's existing
	 * program in a Target manifest and touches none of their sources.
	 */
	z.strictObject({
		kind: z.literal("wrap-target"),
		/** The exact command, as argv. argv[0] is absolute or a bare PATH name. */
		argv: z.array(z.string().min(1).max(4_096)).min(1).max(32),
		/** The editable surface: which files a proposal may rewrite. */
		harnessFiles: z.array(z.string().min(1).max(200)).min(1).max(64),
		reason: NonBlankSchema.max(4_000),
	}),
	z.strictObject({
		kind: z.literal("configure-target"),
		targetId: z.string().max(100).regex(/^[a-z0-9][a-z0-9-]*$/),
		/** Builder-owned choices only; executable metadata is resolved by the trusted host. */
		model: TargetModelSelectionSchema,
		reason: NonBlankSchema.max(4_000),
	}),
	/**
	 * The other two models a measurement uses: the judge that grades the answer
	 * and the model that plays the user. Same dialog shape as `configure-target`
	 * — a bounded selection resolved by the trusted host catalog, a credential
	 * named by the host UI and never valued, and the exact manifest diff.
	 */
	z.strictObject({
		kind: z.literal("configure-evaluators"),
		judge: TargetModelSelectionSchema.optional(),
		simulatedUser: TargetModelSelectionSchema.optional(),
		reason: NonBlankSchema.max(4_000),
	}).refine(
		(value) => value.judge !== undefined || value.simulatedUser !== undefined,
		"configure-evaluators needs a judge, a simulatedUser, or both",
	),
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
		kind: z.literal("import-dataset"),
		submissionId: ArtifactIdSchema.optional(),
		/** The exam, drawn before anything development-facing is compiled. */
		sealed: z.strictObject({
			count: z.number().int().min(1),
			seed: DatasetSeedSchema,
			stratifyBy: z.string().min(1).max(200).optional(),
		}).nullable(),
		reason: NonBlankSchema.max(4_000),
	}),
	/**
	 * The exam, when there is no data to hold out. The judge writes it — the one
	 * model already outside the Target's trust domain, whose output never
	 * re-enters a Builder context — from the approved Spec the host reads and a
	 * seeded draw of published development cases shown for their shape. Nothing
	 * about a case is model-supplied and nothing about one comes back: the
	 * Builder asks for a count and a mode, and learns a count and a mode.
	 *
	 * `seal` writes the sealed corpus. `review` writes one 0600 draft into
	 * private state for the operator to read, edit, and import through
	 * `/holdout` — the honest default for a first exam, and the only path on
	 * which a human has actually vouched for the questions.
	 */
	z.strictObject({
		kind: z.literal("generate-holdout"),
		/** Below the sealed guardrail's minimum an exam can only say `underpowered`. */
		cases: z.number().int().min(15).max(200).default(20),
		/** Fixes which development cases are shown as format examples. */
		seed: z.string().min(1).max(200).optional(),
		mode: z.enum(["seal", "review"]),
		/**
		 * What the questions are written from. `spec` is the original path and the
		 * default, so every receipt and dialog written before this is unchanged.
		 * `kb` shows the judge one passage of the Target's declared knowledge base
		 * at a time and keeps the passage nailed to the case it produced — the
		 * only honest exam for an agent that answers from documents.
		 *
		 * Optional and never defaulted, for the reason the manifest's `harness`
		 * field is: the decision subject is hashed for the confirmation and the
		 * stale check, and a defaulted key would write itself into the canonical
		 * JSON of a request nobody made differently. Absent means `spec`.
		 */
		source: z.enum(["spec", "kb"]).optional(),
		reason: NonBlankSchema.max(4_000),
	}),
	z.strictObject({
		kind: z.literal("run-eval"),
		developmentCorpusId: ArtifactIdSchema.optional(),
		repetitions: z.number().int().min(1).max(10),
		reason: NonBlankSchema.max(4_000),
	}),
	/**
	 * One operator intent — “start testing” — over the reviews that still stand
	 * between the current drafts and a running evaluation. It is orchestration,
	 * not new authority: it performs the same fine-grained decisions, in order,
	 * through the same application services, and stops at the first one that
	 * declines or fails.
	 */
	z.strictObject({
		kind: z.literal("start-testing"),
		repetitions: z.number().int().min(1).max(10),
		reason: NonBlankSchema.max(4_000),
	}),
	z.strictObject({
		kind: z.literal("calibrate"),
		repetitions: z.number().int().min(1).max(10),
		reason: NonBlankSchema.max(4_000),
	}),
	/**
	 * Re-score recorded answers with a rubric that just changed. The Target is
	 * never called — the answers are already on disk — so the only bill is the
	 * judge's, and the only thing that may differ from the source evaluation is
	 * how its cases are graded. `draft` takes the rubrics from the unpublished
	 * corpus revision the Builder just wrote; `target` re-runs the judge under
	 * the ones the basket already carries, which says something only when the
	 * judge model itself moved.
	 */
	z.strictObject({
		kind: z.literal("regrade"),
		/** Defaults to the newest measured development evaluation of this Target. */
		evalRunId: ArtifactIdSchema.optional(),
		graders: z.enum(["draft", "target"]),
		reason: NonBlankSchema.max(4_000),
	}),
	z.strictObject({
		kind: z.literal("apply-proposal"),
		runId: ArtifactIdSchema.optional(),
		branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/),
		/** Product path: the same Apply confirmation immediately funds verification. */
		verify: z.strictObject({
			repetitions: z.number().int().min(1).max(10).default(3),
			force: z.boolean().optional(),
		}).optional(),
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
		/**
		 * Spend the full verification even when the cheap check found nothing.
		 * The screen is a screen: it can be wrong, and an operator who has read
		 * its numbers may still want the matched measurement.
		 */
		force: z.boolean().optional(),
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
	/**
	 * One operator intent — “ship it” — over the release decisions that are left:
	 * review (recommend promote), promote, adopt, continue. Orchestration only:
	 * the same services, the same order, the same receipts, and a stop at the
	 * first step that declines or fails. `version` is required exactly when the
	 * plan still contains the promotion.
	 */
	z.strictObject({
		kind: z.literal("ship"),
		candidateId: ArtifactIdSchema.optional(),
		version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/).max(50).optional(),
		reason: NonBlankSchema.max(4_000),
	}),
	/**
	 * The autoloop: run -> diagnose -> propose -> apply -> cheap check -> verify,
	 * up to `maxCycles` times or until `until` is reached. Routine measurement
	 * under the same cost guard as every other run, with the estimate covering
	 * the whole planned loop. It never promotes, adopts, publishes a corpus or
	 * approves a Spec; those stay with the human.
	 */
	z.strictObject({
		kind: z.literal("improve"),
		/** Target development pass rate, 0..1. */
		until: z.number().min(0).max(1),
		maxCycles: z.number().int().min(1).max(10),
		repetitions: z.number().int().min(1).max(10),
		/**
		 * Hypotheses per cycle. 1 (the default) is one change, one screen, one
		 * verification. 2..4 asks for that many different changes for the top
		 * failure mode and compares them in one Pareto table; the loop stops
		 * there, because which one wins is the operator's to say.
		 */
		candidates: z.number().int().min(1).max(4).optional(),
		jobs: z.number().int().min(1).max(64).optional(),
		developmentCorpusId: ArtifactIdSchema.optional(),
		/** Continue the named unfinished loop instead of refusing to start. */
		resumeLoopId: z.string().regex(/^loop_[a-z0-9]{6,32}$/).optional(),
		/** Drop the named unfinished loop (its branches survive), then start fresh. */
		abandonLoopId: z.string().regex(/^loop_[a-z0-9]{6,32}$/).optional(),
		/** How old a development EvalRun may be and still be reused, in milliseconds. */
		baselineMaxAgeMs: z.number().int().min(0).max(365 * 24 * 60 * 60 * 1_000).optional(),
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
	/**
	 * The same resolution for an evaluator model. Separate hook because the
	 * credential variable is a separate answer: the operator may hold the judge
	 * key under a different name from the Target's, and the host UI asks once
	 * per role. Never a credential value, and never a name a model supplied.
	 */
	resolveEvaluatorModel?: (
		role: "judge" | "simulatedUser",
		selection: TargetModelSelection,
	) => TargetManifest["model"];
	/**
	 * The judge a pending basket needs when the manifest has none, chosen by the
	 * host: a bounded catalog selection plus the model it resolves to, under a
	 * credential variable NAME the operator has already exported.
	 *
	 * Only the host holds the catalog, so only the host can answer this; the
	 * Workbench asks exactly when the basket about to be published grades with a
	 * judge and none is configured, and treats null as "this machine cannot
	 * offer one" — which is a blocker, never a guess.
	 */
	defaultJudge?: (target: { provider: string; id: string }) => {
		selection: TargetModelSelection;
		model: TargetManifest["model"];
	} | null;
}

/**
 * Every question the host may put to the operator. `workshop-grant` is the one
 * that is not a decision: it widens what pre-review authored code may reach for
 * exactly one tool inside one open workshop, and like every other confirmation
 * it is host-owned — a model can ask for it, never assert it.
 */
export type WorkbenchConfirmationKind = WorkbenchDecisionInput["kind"] | "workshop-grant" | "tool-authoring";

export interface WorkbenchConfirmation {
	kind: WorkbenchConfirmationKind;
	title: string;
	reason: string;
	subject: unknown;
	subjectHash: string;
	/**
	 * How much of the human's attention this decision is worth. The Workbench
	 * decides it; the host renders it. `consequential` is the full dialog,
	 * `one-question` is `question` alone, and `routine` runs without a dialog —
	 * unless the cost guard raised it, which arrives as `one-question` too.
	 */
	policy: WorkbenchGateClass;
	/** The whole dialog for a `one-question` gate; a summary line otherwise. */
	question: string;
	/** What a run is expected to cost, when this decision starts one. */
	estimate?: WorkbenchRunEstimate;
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

/** One compiled case, bounded and credential-redacted, exactly as a human reads it. */
export interface WorkbenchDatasetCase {
	input: string;
	expected: string | null;
	messages: { role: "user" | "assistant"; content: string }[] | null;
	/**
	 * The live user a case asks for, when it is a conversation rather than one
	 * message. The operator confirms an import by reading these sample cases, so
	 * a goal and a persona that shape every turn must be visible there.
	 */
	simulatedUser: { goal: string; persona: string | null; maxTurns: number; stopWhen: string | null } | null;
	/**
	 * The world a case happens in. `state` and each expectation's `value` are
	 * bounded, redacted canonical JSON rather than live data: this is a thing a
	 * human reads to confirm an import, and the same rule that keeps a case's
	 * text out of a screen unredacted applies to the state behind it.
	 */
	world: {
		state: string;
		expect: { path: string; op: "equals" | "exists" | "contains"; value: string | null }[] | null;
	} | null;
	metadata: Record<string, string> | null;
	graders: GraderSpec[];
}

/** What a `dataset-recipe` submission hands back: cases, not JSON. */
export interface WorkbenchDatasetRecipeArtifact {
	submissionId: string;
	sourcePath: string;
	name: string;
	/** Cases the recipe would produce on the rows the exam did not take. */
	developmentCount: number;
	skippedRows: number;
	sealedReserved: number;
	sampleCases: WorkbenchDatasetCase[];
	[key: string]: unknown;
}

export interface WorkbenchTurn {
	kind: WorkbenchSubmitInput["kind"];
	message: string;
	artifact: Record<string, unknown> | null;
	view: WorkbenchView;
}

export interface WorkbenchRunEvalResult {
	/**
	 * The host's own sentence about this run — the pass count and the number of
	 * diagnosed failure modes — for the Builder to quote verbatim, exactly as a
	 * candidate's `headline` is quoted.
	 */
	headline: string;
	evaluation: WorkbenchEvaluationProjection;
	diagnosis: WorkbenchDiagnosisSummary;
	improvementBrief: WorkbenchImprovementBriefProjection;
	evidence: WorkbenchEvidenceLinkProjection;
	/** The same two judge readings the traces screen carries. */
	judgeAgreement?: WorkbenchCandidateSummary["judgeAgreement"];
	judgeAbstained?: number;
	/**
	 * The one-time offer to check this judge by hand, present only on a run a
	 * judge graded: how many labels exist, and whether THIS run is the one that
	 * made the offer. Ten labels is a prompt threshold, not a gate.
	 */
	judgeCalibration?: { labelled: number; offered: boolean };
}

/**
 * What the cheap check found before the expensive measurement started. It is a
 * screen: one repetition, candidate arm only, over the cases that already
 * failed. It never enters a gate and never becomes promotion evidence.
 */
export interface WorkbenchCheapCheckProjection {
	verdict: "promising" | "flat";
	tasks: number;
	improved: number;
	unchanged: number;
	regressed: number;
	inconclusive: number;
	/** False when the screen's own infrastructure errors blew the budget. */
	withinErrorBudget: boolean;
	screenEvalRunId: string;
	sourceEvalRunId: string;
}

export type WorkbenchVerifyCandidateResult =
	| {
		outcome: "verified";
		/** The candidate's own {@link WorkbenchCandidateSummary.headline}, hoisted. */
		headline: string;
		candidate: WorkbenchCandidateSummary;
		/**
		 * The gate's own quantity: the mean paired score delta and the interval
		 * that brackets it. This field used to carry the pass-rate delta beside
		 * the score's interval, which is how the two came to be read as one.
		 */
		development: { verdict: GateVerdict; scoreDelta: number; confidence95: { low: number; high: number } };
		sealedHoldout: { executed: boolean; gatePassed: boolean; verdict: GateVerdict | null };
		/** The screen that let this verification start, when one ran. */
		screen: WorkbenchCheapCheckProjection | null;
	}
	| {
		/** The cheap check found nothing and no `force` was given: nothing was spent. */
		outcome: "stopped-by-screen";
		builderRunId: string;
		candidateSha: string;
		screen: WorkbenchCheapCheckProjection;
		/** What the full verification would have cost. */
		spared: { executions: number };
	};

/** One fine-grained decision a composite performed, in the order it ran. */
export interface WorkbenchCompositeStep {
	kind: Exclude<WorkbenchDecisionInput["kind"], "run-current" | "start-testing" | "ship" | "improve">;
	message: string;
}

/** Approve · publish · run, as far as the reviewed drafts allow. */
export interface WorkbenchStartTestingResult {
	steps: WorkbenchCompositeStep[];
	/** The run's own {@link WorkbenchRunEvalResult.headline}, hoisted; null before a run. */
	headline: string | null;
	approvedSpecId: string | null;
	developmentCorpus: { id: string; taskCount: number } | null;
	evaluation: WorkbenchRunEvalResult | null;
	/** What the operator has to do before a run is possible, or null. */
	pending: string | null;
}

/**
 * The cases a promotion pinned as regression guards, as a draft the operator
 * publishes like any other. Building them never blocks or delays the
 * promotion: a failure degrades to `warning`.
 */
export interface WorkbenchRegressionGuardsProjection {
	draftId: string | null;
	cases: number;
	taskIds: string[];
	warning: string | null;
}

/** Review · promote · adopt · continue, as far as the candidate allows. */
export interface WorkbenchShipResult {
	steps: WorkbenchCompositeStep[];
	/** The candidate's own {@link WorkbenchCandidateSummary.headline}, hoisted. */
	headline: string;
	candidate: WorkbenchCandidateSummary;
	tag: string | null;
	adoption: { branch: string; fromSha: string; toSha: string } | null;
	continuation: { receiptId: string; nextStage: WorkbenchStage } | null;
	/** Present exactly when this composite performed the promotion. */
	guards: WorkbenchRegressionGuardsProjection | null;
}

/** What `ahde improve` did, cycle by cycle. */
export interface WorkbenchImproveResult {
	cycles: ImprovementLoopCycle[];
	stopReason: ImprovementLoopStopReason;
	stopMessage: string;
	table: string;
	candidateId: string | null;
	/** This invocation's id. `--resume`/`--abandon` name it. */
	loopId: string;
	finalPassRate: number;
	executions: number;
	/** Hypotheses each cycle compared; 1 means today's single-change behaviour. */
	candidates: number;
	/**
	 * The Pareto table of the last cycle that compared several hypotheses. The
	 * operator picks one and applies or ships it through the unchanged path.
	 */
	search: ProposalSearchResult | null;
}

/** Typed payload of every consequential decision, keyed by its decision kind. */
export interface WorkbenchDecisionResultMap {
	"scaffold-target": { targetId: string; targetGitSha: string; receiptId: string };
	"wrap-target": { targetId: string; targetGitSha: string; receiptId: string; entry: string };
	"configure-target": { targetId: string; targetGitSha: string; receiptId: string; credentialEnv: string };
	"configure-evaluators": {
		targetGitSha: string;
		receiptId: string;
		/** One entry per block this decision actually wrote. */
		configured: { role: "judge" | "simulatedUser"; model: string; credentialEnv: string }[];
	};
	"approve-spec": { approvedSpecId: string; receiptId: string };
	"publish-corpus": {
		corpusId: string;
		corpusHash: string;
		taskCount: number;
		publicationReceiptId: string;
		lineageHash: string;
	};
	/**
	 * A draft, plus how many cases the exam took. The sealed corpus id lives in
	 * the ingest receipt and in no development-facing object.
	 */
	"import-dataset": {
		draftId: string;
		taskCount: number;
		approvedSpecId: string;
		sourcePath: string;
		sealedCount: number;
		skippedRows: number;
		receiptId: string;
	};
	/**
	 * The whole of what a generated exam says about itself. `corpusId` is present
	 * only on the sealing path, where it is the id of a corpus whose content no
	 * model may read — the same id `publish-corpus` returns for a development
	 * basket, and the same rule applies to it: an id is not content. `reviewPath`
	 * is a path the operator is about to open, never a file anything here reads.
	 */
	"generate-holdout": {
		corpusId?: string;
		cases: number;
		/** Where the questions came from: the agent's description, or its documents. */
		source: "spec" | "kb";
		/** How many the operator asked for, and how many the judge's draft lost to validation. */
		requested: number;
		dropped: { malformed: number; duplicate: number };
		generator: string;
		promptHash: string;
		reviewPath?: string;
	};
	"run-eval": WorkbenchRunEvalResult;
	calibrate: { candidateId: string; calibration: WorkbenchCalibrationProjection };
	/** The derived EvalRun, and exactly what the new rubric moved. */
	regrade: RegradeDiff;
	/**
	 * Whatever “run it” means where the operator stands. A pending review is not
	 * an error: it resolves to the `start-testing` composite and its one dialog.
	 */
	"run-current":
		| ({ resolvedAs: "run-eval" } & WorkbenchRunEvalResult)
		| ({ resolvedAs: "verify-candidate" } & WorkbenchVerifyCandidateResult)
		| ({ resolvedAs: "start-testing" } & WorkbenchStartTestingResult);
	"apply-proposal": {
		runId: string;
		branch: string;
		candidateSha: string;
		proposalHash: string;
		/** Present on the product Apply path; omitted by low-level recovery callers. */
		verification?: WorkbenchVerifyCandidateResult | WorkbenchVerificationBlocked;
		/**
		 * Development cases the host drafted for every tool this proposal created
		 * or changed. A draft, never a publication: what the agent does with a new
		 * tool is the operator's next test, not a silent change to the corpus.
		 */
		contractCases?: { tool: string; draftId: string; cases: number }[];
	};
	"discard-proposal": { runId: string; receiptHash: string };
	"verify-candidate": WorkbenchVerifyCandidateResult;
	"abandon-candidate": {
		candidateId: string;
		interruptedStatus: "proposed" | "built" | "validated";
		receiptHash: string;
	};
	"review-candidate": WorkbenchCandidateSummary;
	"promote-candidate": {
		candidate: WorkbenchCandidateSummary;
		tag: string;
		candidateSha: string;
		/** Regression guards derived after the promotion receipt was written. */
		guards: WorkbenchRegressionGuardsProjection;
	};
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
	"start-testing": WorkbenchStartTestingResult;
	ship: WorkbenchShipResult;
	improve: WorkbenchImproveResult;
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
