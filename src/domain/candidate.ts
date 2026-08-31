import { z } from "zod";
import {
	DEVELOPMENT_VERDICTS,
	EXACT_COMPARISON_GATE_ALGORITHM_ID_V3,
	EXACT_COMPARISON_GATE_ALGORITHM_ID_V4,
	SEALED_VERDICTS,
	isDevelopmentVerdict,
	isSealedVerdict,
	promotableVerdicts,
} from "./comparison-gate.js";

const IdSchema = z.string().trim().min(1).max(200);
const VerbatimIdSchema = z.string().min(1).max(200).refine((value) => value.trim().length > 0, "expected non-blank id");
const VerbatimTextSchema = z.string().min(1).max(4_000).refine((value) => value.trim().length > 0, "expected non-blank text");
const TimestampSchema = z.iso.datetime({ offset: true });
const GitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "expected a full Git SHA");
const FingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected a sha256 fingerprint");

const ExperimentModeSchema = z.enum(["candidate", "aa-calibration"]);
export type ExperimentMode = z.infer<typeof ExperimentModeSchema>;

const GitRevisionSchema = z.strictObject({
	ref: z.string().trim().min(1),
	sha: GitShaSchema,
});
export type GitRevision = z.infer<typeof GitRevisionSchema>;

const LineageValidationResultSchema = z.strictObject({
	baseline: GitRevisionSchema,
	candidate: GitRevisionSchema,
	relation: z.enum(["descendant", "same"]),
});

const ActorSchema = z.strictObject({
	kind: z.enum(["human", "builder", "system"]),
	id: IdSchema,
});
const HumanActorSchema = z.strictObject({ kind: z.literal("human"), id: VerbatimIdSchema });

export const CandidateArtifactRefSchema = z.strictObject({
	path: z.string().min(1).max(4_096).refine((value) => value.trim().length > 0, "expected non-blank path"),
	sha256: FingerprintSchema,
});
export type CandidateArtifactRef = z.infer<typeof CandidateArtifactRefSchema>;

export const CorpusIdentitySchema = z.strictObject({
	id: IdSchema,
	hash: FingerprintSchema,
});
export type CorpusIdentity = z.infer<typeof CorpusIdentitySchema>;

const AppliedBuilderOriginSchema = z.strictObject({
	kind: z.literal("applied-builder"),
	builderRunId: IdSchema,
	builderRun: CandidateArtifactRefSchema,
	builderInput: CandidateArtifactRefSchema,
	proposal: CandidateArtifactRefSchema,
	applyReceipt: CandidateArtifactRefSchema,
	application: z.strictObject({
		/**
		 * The human whose authority this apply carries. For an automated improve or
		 * search that is the operator who authorized the trial — and
		 * `via` below is what stops the record from implying they read this diff.
		 */
		actor: HumanActorSchema,
		/**
		 * How the diff reached the branch when no human saw it on its own. Absent —
		 * and canonically dropped — for every interactive apply, so existing
		 * candidate records are unchanged.
		 */
		via: z.enum(["improvement-loop", "proposal-search"]).optional(),
		reason: VerbatimTextSchema,
		appliedAt: TimestampSchema,
		baseTargetSha: GitShaSchema,
		candidateSha: GitShaSchema,
		proposalSha256: FingerprintSchema,
	}),
	source: z.strictObject({
		evalRunId: IdSchema,
		evalRun: CandidateArtifactRefSchema,
		diagnosisId: IdSchema,
		diagnosis: CandidateArtifactRefSchema,
		dataset: VerbatimIdSchema,
		datasetHash: FingerprintSchema,
		suiteHash: FingerprintSchema,
		developmentCorpus: CorpusIdentitySchema.nullable(),
	}).nullable(),
	approvedSpec: z.strictObject({
		specId: IdSchema,
		projectId: IdSchema,
		specContentHash: FingerprintSchema,
		snapshotHash: FingerprintSchema,
		artifact: CandidateArtifactRefSchema,
	}),
});

const ManualOriginSchema = z.strictObject({
	kind: z.literal("manual"),
	reason: z.string().trim().min(1).max(4_000),
});

export const CandidateOriginSchema = z.discriminatedUnion("kind", [
	AppliedBuilderOriginSchema,
	ManualOriginSchema,
]);
export type CandidateOrigin = z.infer<typeof CandidateOriginSchema>;

const ScopeValidationResultSchema = z.strictObject({
	policyId: IdSchema,
	baselineSha: GitShaSchema,
	candidateSha: GitShaSchema,
	passed: z.literal(true),
	changedFiles: z
		.array(z.string().trim().min(1))
		.refine((files) => new Set(files).size === files.length, "changedFiles must be unique"),
	violations: z.array(z.string()).max(0, "a passed scope validation cannot contain violations"),
});

const EvalRunRefSchema = z.strictObject({
	evalRunId: IdSchema,
	harness: GitRevisionSchema,
});

const ComparisonSummaryFieldsSchema = z.strictObject({
	taskCount: z.number().int().nonnegative(),
	baselinePassRate: z.number().min(0).max(1),
	candidatePassRate: z.number().min(0).max(1),
	delta: z.number().min(-1).max(1),
	confidence95: z.strictObject({
		low: z.number().min(-1).max(1),
		high: z.number().min(-1).max(1),
	}),
	improved: z.number().int().nonnegative(),
	regressed: z.number().int().nonnegative(),
	unchanged: z.number().int().nonnegative(),
});

function refineTaskCount(
	summary: { improved: number; regressed: number; unchanged: number; taskCount: number },
	context: z.RefinementCtx,
): void {
	if (summary.improved + summary.regressed + summary.unchanged !== summary.taskCount) {
		context.addIssue({ code: "custom", path: ["taskCount"], message: "must equal improved + regressed + unchanged" });
	}
}

export const ComparisonSummaryEvidenceSchema = ComparisonSummaryFieldsSchema.superRefine(refineTaskCount);
export type ComparisonSummaryEvidence = z.infer<typeof ComparisonSummaryEvidenceSchema>;

/**
 * v4 summary: the mean grader score decides, `delta` stays the pass-rate delta
 * so both are on the screen. improved/regressed/unchanged count score moves.
 */
export const ComparisonSummaryEvidenceV4Schema = ComparisonSummaryFieldsSchema.extend({
	baselineScore: z.number().min(0).max(1),
	candidateScore: z.number().min(0).max(1),
	scoreDelta: z.number().min(-1).max(1),
}).superRefine(refineTaskCount);
export type ComparisonSummaryEvidenceV4 = z.infer<typeof ComparisonSummaryEvidenceV4Schema>;

const ResourceTotalsSchema = z.strictObject({
	runs: z.number().int().nonnegative(),
	/** Arm total in USD. */
	costUsd: z.number().nonnegative(),
	/** Per-run mean, so arms with different run counts stay comparable. */
	meanLatencyMs: z.number().nonnegative(),
	meanTokens: z.number().nonnegative(),
});

/** Candidate-over-baseline resource ratios; null where the baseline is zero. */
export const ComparisonResourcesEvidenceSchema = z.strictObject({
	baseline: ResourceTotalsSchema,
	candidate: ResourceTotalsSchema,
	costRatio: z.number().nonnegative().nullable(),
	latencyRatio: z.number().nonnegative().nullable(),
	tokenRatio: z.number().nonnegative().nullable(),
});
export type ComparisonResourcesEvidence = z.infer<typeof ComparisonResourcesEvidenceSchema>;

/** Historical gate: row-level comparison only, without exact artifact anchoring. */
export const ComparisonGateEvidenceV1Schema = z.strictObject({
	policyId: IdSchema,
	comparisonHash: FingerprintSchema,
	gateHash: FingerprintSchema,
	summary: ComparisonSummaryEvidenceSchema,
});

export const EXACT_COMPARISON_GATE_ALGORITHM_ID = "exact-comparison-gate-v2" as const;

/** Promotion-grade gate binding the exact EvalRun indexes and ordered RunArtifact hashes. */
export const ComparisonGateEvidenceV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	algorithmId: z.literal(EXACT_COMPARISON_GATE_ALGORITHM_ID),
	policyId: IdSchema,
	comparisonHash: FingerprintSchema,
	evidenceHash: FingerprintSchema,
	gateHash: FingerprintSchema,
	summary: ComparisonSummaryEvidenceSchema,
});

const GateVerdictSchema = z.enum([...DEVELOPMENT_VERDICTS, ...SEALED_VERDICTS]);

const GateDesignSchema = z.strictObject({
	tasks: z.number().int().nonnegative(),
	repetitions: z.number().int().positive(),
	excludedTasks: z.number().int().nonnegative(),
});

const GateFlagsSchema = z.strictObject({
	regressedTasks: z.number().int().nonnegative(),
	improvedTasks: z.number().int().nonnegative(),
	collapsedTasks: z.number().int().nonnegative(),
});

const GateReasonsSchema = z.array(z.string().min(1).max(500)).max(8);

/**
 * Historical pass-rate gate. Still parseable so an old candidate renders its
 * verdict, but never promotion-grade: only v4 partial-credit evidence is.
 */
export const ComparisonGateEvidenceV3Schema = z.strictObject({
	schemaVersion: z.literal(3),
	algorithmId: z.literal(EXACT_COMPARISON_GATE_ALGORITHM_ID_V3),
	policyId: z.enum(["development-ci-v3", "sealed-guardrail-v3"]),
	surface: z.enum(["development", "sealed"]),
	comparisonHash: FingerprintSchema,
	evidenceHash: FingerprintSchema,
	gateHash: FingerprintSchema,
	summary: ComparisonSummaryEvidenceSchema,
	design: GateDesignSchema,
	verdict: GateVerdictSchema,
	flags: GateFlagsSchema,
	reasons: GateReasonsSchema,
}).superRefine((evidence, context) => {
	const consistent = evidence.surface === "sealed"
		? isSealedVerdict(evidence.verdict) && evidence.policyId === "sealed-guardrail-v3"
		: isDevelopmentVerdict(evidence.verdict) && evidence.policyId === "development-ci-v3";
	if (!consistent) {
		context.addIssue({ code: "custom", path: ["verdict"], message: `verdict ${evidence.verdict} does not belong to the ${evidence.surface} gate` });
	}
});
export type ComparisonGateEvidenceV3 = z.infer<typeof ComparisonGateEvidenceV3Schema>;

/**
 * Promotion-grade gate evidence: the exact paired statistics on mean grader
 * scores, the pass rates beside them, the resource ratios, and the one verdict
 * the comparison gate decided for its surface. Only v4 can back a promotion.
 */
export const ComparisonGateEvidenceV4Schema = z.strictObject({
	schemaVersion: z.literal(4),
	algorithmId: z.literal(EXACT_COMPARISON_GATE_ALGORITHM_ID_V4),
	policyId: z.enum(["development-ci-v4", "sealed-guardrail-v4"]),
	surface: z.enum(["development", "sealed"]),
	comparisonHash: FingerprintSchema,
	evidenceHash: FingerprintSchema,
	gateHash: FingerprintSchema,
	summary: ComparisonSummaryEvidenceV4Schema,
	design: GateDesignSchema,
	verdict: GateVerdictSchema,
	flags: GateFlagsSchema,
	resources: ComparisonResourcesEvidenceSchema,
	reasons: GateReasonsSchema,
}).superRefine((evidence, context) => {
	const consistent = evidence.surface === "sealed"
		? isSealedVerdict(evidence.verdict) && evidence.policyId === "sealed-guardrail-v4"
		: isDevelopmentVerdict(evidence.verdict) && evidence.policyId === "development-ci-v4";
	if (!consistent) {
		context.addIssue({ code: "custom", path: ["verdict"], message: `verdict ${evidence.verdict} does not belong to the ${evidence.surface} gate` });
	}
});
export type ComparisonGateEvidenceV4 = z.infer<typeof ComparisonGateEvidenceV4Schema>;

/** V1/V2/V3 remain parseable for historical review, but are never promotion-grade. */
export const ComparisonGateEvidenceSchema = z.union([
	ComparisonGateEvidenceV4Schema,
	ComparisonGateEvidenceV3Schema,
	ComparisonGateEvidenceV2Schema,
	ComparisonGateEvidenceV1Schema,
]);

export type ComparisonGateEvidence = z.infer<typeof ComparisonGateEvidenceSchema>;

/** Verdict of any evidence that carries one (v3 and v4). Display only. */
export function gateVerdictOf(evidence: ComparisonGateEvidence | null | undefined): string | null {
	return evidence && "verdict" in evidence ? evidence.verdict : null;
}

/** True only for v4 evidence — the one shape a promotion may rest on. */
export function isPromotionGradeGateEvidence(
	evidence: ComparisonGateEvidence | null | undefined,
): evidence is ComparisonGateEvidenceV4 {
	return Boolean(evidence && "schemaVersion" in evidence && evidence.schemaVersion === 4);
}

/** Verdict of promotion-grade evidence only; legacy v1/v2/v3 yield null. */
export function promotionGradeVerdictOf(evidence: ComparisonGateEvidence | null | undefined): string | null {
	return isPromotionGradeGateEvidence(evidence) ? evidence.verdict : null;
}

const MatchedEvaluationSchema = z.strictObject({
	baseline: EvalRunRefSchema,
	candidate: EvalRunRefSchema,
	comparison: ComparisonGateEvidenceSchema.nullable().optional(),
});

const CorpusMatchedEvaluationSchema = MatchedEvaluationSchema.extend({
	corpus: CorpusIdentitySchema.nullable().optional(),
});

const EvaluationEvidenceSchema = z.strictObject({
	experimentId: IdSchema,
	designHash: FingerprintSchema,
	mode: ExperimentModeSchema,
	development: CorpusMatchedEvaluationSchema,
	sealedHoldout: CorpusMatchedEvaluationSchema.optional(),
	infrastructureErrors: z.number().int().nonnegative(),
});
export type EvaluationEvidence = z.infer<typeof EvaluationEvidenceSchema>;

const HumanReviewSchema = z.strictObject({
	experimentId: IdSchema,
	recommendation: z.enum(["promote", "reject"]),
	reason: z.string().trim().min(1),
});

const EventMetadata = {
	eventId: IdSchema,
	at: TimestampSchema,
};

const ProposedEventSchema = z.strictObject({
	type: z.literal("proposed"),
	...EventMetadata,
	actor: ActorSchema,
});

const BuiltEventSchema = z.strictObject({
	type: z.literal("built"),
	...EventMetadata,
	actor: HumanActorSchema,
	candidate: GitRevisionSchema,
});

const ValidatedEventSchema = z.strictObject({
	type: z.literal("validated"),
	...EventMetadata,
	actor: ActorSchema,
	lineage: LineageValidationResultSchema,
	scope: ScopeValidationResultSchema,
});

const EvaluatedEventSchema = z.strictObject({
	type: z.literal("evaluated"),
	...EventMetadata,
	actor: ActorSchema,
	evaluation: EvaluationEvidenceSchema,
});

const ReviewedEventSchema = z.strictObject({
	type: z.literal("reviewed"),
	...EventMetadata,
	actor: HumanActorSchema,
	review: HumanReviewSchema,
});

const PromotedEventSchema = z.strictObject({
	type: z.literal("promoted"),
	...EventMetadata,
	actor: HumanActorSchema,
	decision: z.strictObject({
		experimentId: IdSchema,
		candidate: GitRevisionSchema,
		tag: z.string().trim().min(1),
		reason: z.string().trim().min(1),
	}),
});

const RejectedEventSchema = z.strictObject({
	type: z.literal("rejected"),
	...EventMetadata,
	actor: HumanActorSchema,
	decision: z.strictObject({
		experimentId: IdSchema,
		reason: z.string().trim().min(1),
	}),
});

const CandidateEventSchema = z.discriminatedUnion("type", [
	ProposedEventSchema,
	BuiltEventSchema,
	ValidatedEventSchema,
	EvaluatedEventSchema,
	ReviewedEventSchema,
	PromotedEventSchema,
	RejectedEventSchema,
]);

export const CandidateTransitionSchema = z.discriminatedUnion("type", [
	BuiltEventSchema,
	ValidatedEventSchema,
	EvaluatedEventSchema,
	ReviewedEventSchema,
	PromotedEventSchema,
	RejectedEventSchema,
]);
export type CandidateTransition = z.infer<typeof CandidateTransitionSchema>;

const CandidateStatusSchema = z.enum([
	"proposed",
	"built",
	"validated",
	"evaluated",
	"reviewed",
	"promoted",
	"rejected",
]);
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;

const ALLOWED_NEXT: Record<CandidateStatus, readonly CandidateStatus[]> = {
	proposed: ["built"],
	built: ["validated"],
	validated: ["evaluated"],
	evaluated: ["reviewed"],
	reviewed: ["promoted", "rejected"],
	promoted: [],
	rejected: [],
};

function addIssue(ctx: z.RefinementCtx, path: PropertyKey[], message: string): void {
	ctx.addIssue({ code: "custom", path, message });
}

function sameRevision(actual: GitRevision, expected: GitRevision): boolean {
	return actual.ref === expected.ref && actual.sha === expected.sha;
}

function validateEvaluationPair(
	pair: z.infer<typeof MatchedEvaluationSchema>,
	baseline: GitRevision,
	candidate: GitRevision,
	ctx: z.RefinementCtx,
	path: PropertyKey[],
): void {
	if (!sameRevision(pair.baseline.harness, baseline)) {
		addIssue(ctx, [...path, "baseline", "harness"], "evaluation baseline does not match candidate lineage");
	}
	if (!sameRevision(pair.candidate.harness, candidate)) {
		addIssue(ctx, [...path, "candidate", "harness"], "evaluation candidate does not match built revision");
	}
	if (pair.baseline.evalRunId === pair.candidate.evalRunId) {
		addIssue(ctx, path, "baseline and candidate must reference distinct eval runs");
	}
}

const CandidateRecordBaseSchema = z.strictObject({
	schemaVersion: z.literal(1),
	candidateId: IdSchema,
	projectId: IdSchema,
	targetId: IdSchema,
	specId: IdSchema.nullable().default(null),
	proposalId: IdSchema,
	diagnosisId: IdSchema.nullable(),
	origin: CandidateOriginSchema.default({
		kind: "manual",
		reason: "legacy or manual candidate without reconstructable artifact provenance",
	}),
	mode: ExperimentModeSchema,
	baseline: GitRevisionSchema,
	createdAt: TimestampSchema,
	events: z.array(CandidateEventSchema).min(1),
});

/** Durable V1 candidate aggregate. The last event is the current state. */
export const CandidateRecordSchema = CandidateRecordBaseSchema.superRefine((record, ctx) => {
	const first = record.events[0];
	if (first?.type !== "proposed") {
		addIssue(ctx, ["events", 0], "the first candidate event must be proposed");
		return;
	}
	if (record.createdAt !== first.at) {
		addIssue(ctx, ["createdAt"], "createdAt must equal the proposed event timestamp");
	}
	if (record.origin.kind === "applied-builder") {
		if (record.proposalId !== record.origin.builderRunId) {
			addIssue(ctx, ["proposalId"], "must match the applied Builder run id");
		}
		if (record.diagnosisId !== (record.origin.source?.diagnosisId ?? null)) {
			addIssue(ctx, ["diagnosisId"], "must match the applied Builder diagnosis evidence, or be null when none was supplied");
		}
		if (record.specId !== record.origin.approvedSpec.specId) {
			addIssue(ctx, ["specId"], "must match the exact approved Spec evidence");
		}
		if (record.projectId !== record.origin.approvedSpec.projectId) {
			addIssue(ctx, ["projectId"], "must match the approved Spec project");
		}
		if (record.baseline.sha !== record.origin.application.baseTargetSha) {
			addIssue(ctx, ["baseline", "sha"], "must match the exact Builder apply baseline");
		}
		if (record.origin.proposal.sha256 !== record.origin.application.proposalSha256) {
			addIssue(ctx, ["origin", "proposal", "sha256"], "must match the apply receipt proposal hash");
		}
	}

	const eventIds = new Set<string>();
	for (const [index, event] of record.events.entries()) {
		if (eventIds.has(event.eventId)) addIssue(ctx, ["events", index, "eventId"], "eventId must be unique");
		eventIds.add(event.eventId);
		if (index > 0) {
			const previous = record.events[index - 1];
			if (previous && !ALLOWED_NEXT[previous.type].some((next) => next === event.type)) {
				addIssue(ctx, ["events", index, "type"], `illegal transition ${previous.type} -> ${event.type}`);
			}
			if (previous && Date.parse(event.at) < Date.parse(previous.at)) {
				addIssue(ctx, ["events", index, "at"], "event timestamps must be append-ordered");
			}
		}
	}

	let built: z.infer<typeof BuiltEventSchema> | undefined;
	let evaluated: z.infer<typeof EvaluatedEventSchema> | undefined;
	let reviewed: z.infer<typeof ReviewedEventSchema> | undefined;
	for (const [index, event] of record.events.entries()) {
		if (event.type === "built") {
			built = event;
			if (record.origin.kind === "applied-builder") {
				if (
					event.actor.id !== record.origin.application.actor.id ||
					event.actor.kind !== record.origin.application.actor.kind
				) {
					addIssue(ctx, ["events", index, "actor"], "built actor must be the exact apply-receipt human");
				}
				if (event.candidate.sha !== record.origin.application.candidateSha) {
					addIssue(ctx, ["events", index, "candidate", "sha"], "built revision must match the apply receipt");
				}
			}
			const sameSha = event.candidate.sha === record.baseline.sha;
			if (record.mode === "candidate" && sameSha) {
				addIssue(ctx, ["events", index, "candidate", "sha"], "candidate mode requires a revision distinct from baseline");
			}
			if (record.mode === "aa-calibration" && !sameSha) {
				addIssue(ctx, ["events", index, "candidate", "sha"], "A/A calibration requires the same snapshot SHA");
			}
		} else if (event.type === "validated" && built) {
			if (!sameRevision(event.lineage.baseline, record.baseline)) {
				addIssue(ctx, ["events", index, "lineage", "baseline"], "lineage evidence has the wrong baseline revision");
			}
			if (!sameRevision(event.lineage.candidate, built.candidate)) {
				addIssue(ctx, ["events", index, "lineage", "candidate"], "lineage evidence has the wrong candidate revision");
			}
			const expectedRelation = record.mode === "candidate" ? "descendant" : "same";
			if (event.lineage.relation !== expectedRelation) {
				addIssue(ctx, ["events", index, "lineage", "relation"], `${record.mode} mode requires ${expectedRelation} lineage`);
			}
			if (event.scope.baselineSha !== record.baseline.sha) {
				addIssue(ctx, ["events", index, "scope", "baselineSha"], "scope evidence has the wrong baseline SHA");
			}
			if (event.scope.candidateSha !== built.candidate.sha) {
				addIssue(ctx, ["events", index, "scope", "candidateSha"], "scope evidence has the wrong candidate SHA");
			}
			if (record.mode === "candidate" && event.scope.changedFiles.length === 0) {
				addIssue(ctx, ["events", index, "scope", "changedFiles"], "candidate mode requires a non-empty scoped diff");
			}
			if (record.mode === "aa-calibration" && event.scope.changedFiles.length !== 0) {
				addIssue(ctx, ["events", index, "scope", "changedFiles"], "A/A calibration cannot contain changed files");
			}
		} else if (event.type === "evaluated" && built) {
			evaluated = event;
			if (event.evaluation.mode !== record.mode) {
				addIssue(ctx, ["events", index, "evaluation", "mode"], "evaluation mode does not match candidate mode");
			}
				// Infrastructure errors within the gate's budget are excluded from the
				// statistics and recorded here; above the budget the experiment never
				// reaches this event.
			validateEvaluationPair(event.evaluation.development, record.baseline, built.candidate, ctx, ["events", index, "evaluation", "development"]);
			if (record.origin.kind === "applied-builder" && !event.evaluation.development.comparison) {
				addIssue(ctx, ["events", index, "evaluation", "development", "comparison"], "applied Builder candidates require durable comparison evidence");
			}
			if (event.evaluation.sealedHoldout) {
				validateEvaluationPair(event.evaluation.sealedHoldout, record.baseline, built.candidate, ctx, ["events", index, "evaluation", "sealedHoldout"]);
				if (record.origin.kind === "applied-builder" && !event.evaluation.sealedHoldout.comparison) {
					addIssue(ctx, ["events", index, "evaluation", "sealedHoldout", "comparison"], "applied Builder holdouts require durable comparison evidence");
				}
				if (record.origin.kind === "applied-builder" && !event.evaluation.sealedHoldout.corpus) {
					addIssue(ctx, ["events", index, "evaluation", "sealedHoldout", "corpus"], "applied Builder holdouts require exact corpus identity");
				}
			}
		} else if (event.type === "reviewed") {
			reviewed = event;
			if (evaluated && event.review.experimentId !== evaluated.evaluation.experimentId) {
				addIssue(ctx, ["events", index, "review", "experimentId"], "review does not reference the evaluated experiment");
			}
		} else if (event.type === "promoted" && built && evaluated && reviewed) {
			if (record.origin.kind !== "applied-builder") {
				addIssue(ctx, ["events", index, "type"], "production promotion requires reconstructable applied-Builder provenance");
			}
			if (record.mode === "aa-calibration") {
				addIssue(ctx, ["events", index, "type"], "A/A calibration can never be promoted");
			}
			if (!evaluated.evaluation.sealedHoldout) {
				addIssue(ctx, ["events", index, "decision"], "promotion requires sealed-holdout evidence");
			}
			const developmentVerdict = promotionGradeVerdictOf(evaluated.evaluation.development.comparison);
			const sealedVerdict = promotionGradeVerdictOf(evaluated.evaluation.sealedHoldout?.comparison);
			if (developmentVerdict === null || sealedVerdict === null) {
				addIssue(ctx, ["events", index, "decision"], "promotion requires v4 comparison-gate evidence on both surfaces");
			} else if (!promotableVerdicts(developmentVerdict as never, sealedVerdict as never)) {
				addIssue(ctx, ["events", index, "decision"], `promotion requires a sealed pass and a development verdict other than regressed (got ${developmentVerdict} / ${sealedVerdict})`);
			}
			if (reviewed.review.recommendation !== "promote") {
				addIssue(ctx, ["events", index, "decision"], "promotion requires a human promote recommendation");
			}
			if (event.decision.experimentId !== evaluated.evaluation.experimentId) {
				addIssue(ctx, ["events", index, "decision", "experimentId"], "decision does not reference the evaluated experiment");
			}
			if (!sameRevision(event.decision.candidate, built.candidate)) {
				addIssue(ctx, ["events", index, "decision", "candidate"], "promotion does not target the exact evaluated candidate revision");
			}
		} else if (event.type === "rejected" && evaluated) {
			if (event.decision.experimentId !== evaluated.evaluation.experimentId) {
				addIssue(ctx, ["events", index, "decision", "experimentId"], "decision does not reference the evaluated experiment");
			}
		}
	}
});

type DeepReadonly<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly (infer Item)[]
		? readonly DeepReadonly<Item>[]
		: T extends object
			? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
			: T;

export type CandidateRecord = DeepReadonly<z.infer<typeof CandidateRecordSchema>>;

export const CreateCandidateInputSchema = z.strictObject({
	candidateId: IdSchema,
	projectId: IdSchema,
	targetId: IdSchema,
	specId: IdSchema.nullable().default(null),
	proposalId: IdSchema,
	diagnosisId: IdSchema.nullable().default(null),
	origin: CandidateOriginSchema.optional(),
	mode: ExperimentModeSchema,
	baseline: GitRevisionSchema,
	eventId: IdSchema,
	at: TimestampSchema,
	actor: ActorSchema,
});
export type CreateCandidateInput = z.input<typeof CreateCandidateInputSchema>;

export class CandidateTransitionError extends Error {
	constructor(candidateId: string, message: string) {
		super(`candidate ${JSON.stringify(candidateId)}: ${message}`);
		this.name = "CandidateTransitionError";
	}
}

function zodMessage(error: z.ZodError): string {
	return error.issues.map((issue) => issue.message).join("; ");
}

export function createCandidate(input: CreateCandidateInput): CandidateRecord {
	const value = CreateCandidateInputSchema.parse(input);
	return CandidateRecordSchema.parse({
		schemaVersion: 1,
		candidateId: value.candidateId,
		projectId: value.projectId,
		targetId: value.targetId,
		specId: value.specId,
		proposalId: value.proposalId,
		diagnosisId: value.diagnosisId,
		origin: value.origin ?? {
			kind: "manual",
			reason: "manual exact refs supplied without an applied-Builder artifact chain",
		},
		mode: value.mode,
		baseline: value.baseline,
		createdAt: value.at,
		events: [{ type: "proposed", eventId: value.eventId, at: value.at, actor: value.actor }],
	});
}

export function candidateStatus(record: CandidateRecord): CandidateStatus {
	const last = record.events.at(-1);
	if (!last) throw new CandidateTransitionError(record.candidateId, "candidate has no lifecycle events");
	return last.type;
}

/** Validate one legal transition and return a new record with one appended event. */
export function transitionCandidate(record: CandidateRecord, transition: CandidateTransition): CandidateRecord {
	const current = CandidateRecordSchema.parse(record);
	const status = candidateStatus(current);
	const parsedTransition = CandidateTransitionSchema.safeParse(transition);
	if (!parsedTransition.success) {
		throw new CandidateTransitionError(current.candidateId, `invalid transition evidence: ${zodMessage(parsedTransition.error)}`);
	}
	if (!ALLOWED_NEXT[status].some((next) => next === parsedTransition.data.type)) {
		throw new CandidateTransitionError(current.candidateId, `illegal transition ${status} -> ${parsedTransition.data.type}`);
	}

	const next = CandidateRecordSchema.safeParse({ ...current, events: [...current.events, parsedTransition.data] });
	if (!next.success) {
		throw new CandidateTransitionError(current.candidateId, `transition evidence rejected: ${zodMessage(next.error)}`);
	}
	return next.data;
}
