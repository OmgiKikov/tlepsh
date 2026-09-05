import { z } from "zod";
import { ModelBlock } from "../manifest.js";
import { hashValue } from "../provenance.js";
import type { CompareSummary, ComparisonDesign, DevelopmentVerdict } from "../domain/comparison-gate.js";

export const MODEL_EXPERIMENT_MIN_TASKS = 15;
export const MODEL_EXPERIMENT_MIN_REPETITIONS = 2;

const Hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Sha = z.string().regex(/^[0-9a-f]{40}$/);
export const ModelExperimentIdSchema = z.string().regex(/^model-experiment-[0-9a-f]{24}$/);
const ArmId = z.enum(["baseline", "model-1", "model-2"]);
export const ModelExperimentPlanSchema = z.strictObject({
	schemaVersion: z.literal(1),
	id: ModelExperimentIdSchema,
	targetDir: z.string(),
	runsRoot: z.string(),
	targetId: z.string(),
	baseSha: Sha,
	headRef: z.string().startsWith("refs/heads/"),
	manifestHash: Hash,
	harnessHash: Hash,
	corpus: z.strictObject({ stateRoot: z.string(), projectId: z.string(), corpusId: z.string() }),
	corpusHash: Hash,
	datasetHash: Hash,
	suiteHash: Hash,
	taskIds: z.array(z.string()).min(1).max(1000),
	models: z.array(z.strictObject({ armId: ArmId, model: ModelBlock, modelHash: Hash })).min(2).max(3),
	repetitions: z.number().int().min(1).max(5),
	executionBudget: z.number().int().positive().max(10000),
	plannedExecutions: z.number().int().positive(),
	qualityTolerance: z.number().min(0).max(0.2),
	objective: z.enum(["cost", "latency"]),
	planHash: Hash,
}).superRefine((plan, ctx) => {
	const { planHash, ...identity } = plan;
	if (planHash !== hashValue(identity)) ctx.addIssue({ code: "custom", path: ["planHash"], message: "plan hash mismatch" });
	if (plan.plannedExecutions !== plan.models.length * plan.taskIds.length * plan.repetitions || plan.plannedExecutions > plan.executionBudget) {
		ctx.addIssue({ code: "custom", path: ["plannedExecutions"], message: "execution design exceeds its exact budget" });
	}
	if (new Set(plan.taskIds).size !== plan.taskIds.length || new Set(plan.models.map((arm) => arm.modelHash)).size !== plan.models.length ||
		plan.models.some((arm, index) => arm.armId !== (index === 0 ? "baseline" : `model-${index}`) || arm.modelHash !== hashValue(arm.model))) {
		ctx.addIssue({ code: "custom", path: ["models"], message: "models and tasks must form a unique ordered design" });
	}
});
export type ModelExperimentPlan = z.infer<typeof ModelExperimentPlanSchema>;
export type ModelExperimentArmId = ModelExperimentPlan["models"][number]["armId"];

export const ModelExperimentStateSchema = z.strictObject({
	schemaVersion: z.literal(1),
	plan: ModelExperimentPlanSchema,
	status: z.enum(["running", "completed", "failed", "stopped"]),
	actorId: z.string().trim().min(1).max(256),
	startedAt: z.string(),
	finishedAt: z.string().nullable(),
	arms: z.array(z.strictObject({
		armId: ArmId,
		status: z.enum(["pending", "running", "completed", "failed", "stopped"]),
		evalRunId: z.string().nullable(),
		evalHash: Hash.nullable(),
		targetRevision: z.string().nullable(),
		error: z.string().nullable(),
	})).min(2).max(3),
});
export type ModelExperimentState = z.infer<typeof ModelExperimentStateSchema>;

/** Recomputed from verified member records on every read; never a second stored verdict. */
export interface ModelExperimentArm {
	armId: ModelExperimentArmId;
	model: z.infer<typeof ModelBlock>;
	status: ModelExperimentState["arms"][number]["status"];
	evalRunId: string | null;
	error: string | null;
	runs: number;
	passRate: number | null;
	meanScore: number | null;
	targetCostUsd: number | null;
	meanLatencyMs: number | null;
	meanTokens: number | null;
	quality: { verdict: DevelopmentVerdict; summary: CompareSummary; design: ComparisonDesign; withinTolerance: boolean; regressions: { taskId: string; scoreDelta: number; baselineRunId: string; candidateRunId: string }[]; omittedRegressions: number } | null;
	/** Descriptive frontier of fully measured arms, not a claim of future superiority. */
	dominated: boolean | null;
}

export interface ModelExperimentRecord {
	id: string;
	plan: ModelExperimentPlan;
	status: ModelExperimentState["status"];
	startedAt: string;
	finishedAt: string | null;
	arms: ModelExperimentArm[];
	frontierArmIds: ModelExperimentArmId[];
	recommendedArmId: ModelExperimentArmId | null;
	/** Target calls only. Judge/user overhead has no complete pricing attestation. */
	targetCostUsd: number | null;
	evaluatorOverhead: "none" | "unverified";
	limitations: string[];
}

export const ModelChangeSubjectSchema = z.strictObject({
	schemaVersion: z.literal(1),
	experimentId: ModelExperimentIdSchema,
	armId: ArmId,
	experimentHash: Hash,
	targetDir: z.string(),
	baseSha: Sha,
	headRef: z.string().startsWith("refs/heads/"),
	manifestPath: z.literal("manifest.yaml"),
	beforeManifestHash: Hash,
	afterManifestHash: Hash,
	previousModel: ModelBlock,
	nextModel: ModelBlock,
	diff: z.string(),
	subjectHash: Hash,
}).superRefine((subject, ctx) => {
	const { subjectHash, ...identity } = subject;
	if (subjectHash !== hashValue(identity)) ctx.addIssue({ code: "custom", path: ["subjectHash"], message: "model change hash mismatch" });
});
export type ModelChangeSubject = z.infer<typeof ModelChangeSubjectSchema>;
export const ModelChangeReceiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	id: z.string(),
	subject: ModelChangeSubjectSchema,
	configuredTargetSha: Sha,
	actorId: z.string().trim().min(1).max(256),
	reason: z.string().trim().min(1).max(4000),
	configuredAt: z.string(),
});
export type ModelChangeReceipt = z.infer<typeof ModelChangeReceiptSchema>;
