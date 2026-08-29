import { createHash } from "node:crypto";
import { z } from "zod";

/** Canonical JSON: objects with sorted keys, arrays preserve order. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function hashValue(value: unknown): string {
	return `sha256:${sha256Hex(canonicalJson(value))}`;
}

export function hashFile(content: string): string {
	return `sha256:${sha256Hex(content)}`;
}

/** Execution lifecycle of a run (pass/fail lives in evalResults.outcome). */
export const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const GitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const TargetRevisionSchema = z.string().regex(/^[0-9a-f]{40}(?:-dirty-[0-9a-f]{12})?$/);
const NonEmptyStringSchema = z.string().min(1);
const ArtifactIdSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/, "expected one safe artifact path segment");
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const RunStatusSchema = z.enum(["running", "completed", "error"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;
export const EvalOutcomeSchema = z.enum(["pass", "fail"]);
export type EvalOutcome = z.infer<typeof EvalOutcomeSchema>;

export const GraderCheckCodeSchema = z.enum([
	"required-tool",
	"output-contains",
	"output-matches",
	"semantic-rubric",
]);
export type GraderCheckCode = z.infer<typeof GraderCheckCodeSchema>;

export const GraderResultSchema = z
	.strictObject({
		name: NonEmptyStringSchema,
		type: NonEmptyStringSchema,
		passed: z.boolean(),
		score: z.number().finite(),
		reason: z.string(),
		/** Stable identity of the normalized effective grader specification. */
		specHash: HashSchema.optional(),
		/** Typed systemic check category. Paired with specHash for new evidence. */
		checkCode: GraderCheckCodeSchema.optional(),
	})
	.superRefine((result, context) => {
		const hasSpecHash = result.specHash !== undefined;
		const hasCheckCode = result.checkCode !== undefined;
		if (hasSpecHash !== hasCheckCode) {
			context.addIssue({
				code: "custom",
				path: [hasSpecHash ? "checkCode" : "specHash"],
				message: "specHash and checkCode must be present together",
			});
			return;
		}
		if (!hasSpecHash) return;
		const expectedType = {
			"required-tool": "tool_called",
			"output-contains": "output_contains",
			"output-matches": "output_matches",
			"semantic-rubric": "judge",
		}[result.checkCode!];
		if (result.type !== expectedType) {
			context.addIssue({
				code: "custom",
				path: ["checkCode"],
				message: `checkCode ${result.checkCode} does not match grader type ${result.type}`,
			});
		}
	});
export type GraderResult = z.infer<typeof GraderResultSchema>;

export const TokenMetricsSchema = z.strictObject({
	input: z.number().nonnegative(),
	output: z.number().nonnegative(),
	cacheRead: z.number().nonnegative(),
	cacheWrite: z.number().nonnegative(),
	total: z.number().nonnegative(),
});
export type TokenMetrics = z.infer<typeof TokenMetricsSchema>;

export const RunMetricsSchema = z.strictObject({
	tokens: TokenMetricsSchema,
	costUsd: z.number().nonnegative(),
	latencyMs: z.number().nonnegative(),
	toolCalls: z.number().int().nonnegative(),
	toolErrors: z.number().int().nonnegative(),
	recoveryAttempts: z.number().int().nonnegative(),
});
export type RunMetrics = z.infer<typeof RunMetricsSchema>;

/** Effective non-secret model configuration. Credential values are never persisted. */
export const ModelFingerprintSchema = z.strictObject({
	provider: NonEmptyStringSchema,
	id: NonEmptyStringSchema,
	api: NonEmptyStringSchema,
	baseUrl: NonEmptyStringSchema,
	apiKeyEnv: NonEmptyStringSchema,
	thinkingLevel: NonEmptyStringSchema,
	params: JsonObjectSchema,
	spec: JsonObjectSchema,
});
export type ModelFingerprint = z.infer<typeof ModelFingerprintSchema>;

/** Capabilities and resource-discovery policy that can change agent behaviour. */
export const ExecutionFingerprintSchema = z.strictObject({
	workspace: z.enum(["isolated-copy-v1", "direct-v1"]),
	tools: z.array(NonEmptyStringSchema),
	environment: z.array(NonEmptyStringSchema),
	sandbox: z.enum(["sandbox-exec", "bwrap", "none", "unavailable"]),
	network: z.enum(["deny", "allow"]),
	filesystem: z.enum([
		"workspace-confined-v1",
		"isolated-copy-unconfined-v1",
		"direct-unconfined-v1",
	]),
	resources: z.strictObject({
		contextFiles: z.enum(["disabled", "discovered"]),
		extensions: z.enum(["disabled", "discovered"]),
		promptTemplates: z.enum(["disabled", "discovered"]),
		skills: z.enum(["manifest-only", "discovered"]),
	}),
});
export type ExecutionFingerprint = z.infer<typeof ExecutionFingerprintSchema>;

export const RunRecordSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		runId: ArtifactIdSchema,
		taskId: NonEmptyStringSchema,
		repetitionIndex: z.number().int().nonnegative(),
		label: z.enum(["baseline", "candidate", "solo"]),
		status: RunStatusSchema,
		error: z.string().nullable(),
		startedAt: NonEmptyStringSchema,
		finishedAt: NonEmptyStringSchema.nullable(),
		target: z.strictObject({
			id: NonEmptyStringSchema,
			gitSha: TargetRevisionSchema,
			/** Optional only so pre-toolset V1 artifacts remain readable. New runs always persist it. */
			toolsetHash: HashSchema.optional(),
			/** Exact model-visible workspace bytes/modes. Legacy or direct-mode runs may omit it. */
			workspaceHash: HashSchema.optional(),
		}),
		runtime: z.strictObject({
			piVersion: NonEmptyStringSchema,
			piSha: GitShaSchema,
			ahdeVersion: NonEmptyStringSchema,
			ahdeCodeHash: HashSchema,
		}),
		model: ModelFingerprintSchema,
		execution: ExecutionFingerprintSchema,
		eval: z.strictObject({
			suiteId: NonEmptyStringSchema,
			suiteHash: HashSchema,
			dataset: NonEmptyStringSchema,
			datasetHash: HashSchema,
		}),
		trace: z.strictObject({
			path: z.literal("session.jsonl"),
			sessionId: z.string().nullable(),
			sha256: HashSchema.nullable(),
		}),
		metrics: RunMetricsSchema,
		evalResults: z
			.strictObject({ graders: z.array(GraderResultSchema), outcome: EvalOutcomeSchema })
			.nullable(),
		parent: z
			.strictObject({ evalRunId: NonEmptyStringSchema, candidateOf: GitShaSchema.nullable() })
			.nullable(),
	})
	.superRefine((record, context) => {
		if (record.status === "running") {
			if (record.finishedAt !== null) context.addIssue({ code: "custom", path: ["finishedAt"], message: "running run cannot be finished" });
			if (record.error !== null) context.addIssue({ code: "custom", path: ["error"], message: "running run cannot have an error" });
			if (record.evalResults !== null) context.addIssue({ code: "custom", path: ["evalResults"], message: "running run cannot be graded" });
		} else if (record.finishedAt === null) {
			context.addIssue({ code: "custom", path: ["finishedAt"], message: `${record.status} run must have finishedAt` });
		}
		if (record.status === "completed" && record.error !== null) {
			context.addIssue({ code: "custom", path: ["error"], message: "completed run cannot have an error" });
		}
		if (record.status === "error" && !record.error) {
			context.addIssue({ code: "custom", path: ["error"], message: "error run must explain the error" });
		}
		if (record.evalResults) {
			const expectedOutcome = record.evalResults.graders.every((grader) => grader.passed) ? "pass" : "fail";
			if (record.evalResults.outcome !== expectedOutcome) {
				context.addIssue({
					code: "custom",
					path: ["evalResults", "outcome"],
					message: "outcome must equal the conjunction of grader results",
				});
			}
		}
	});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export function modelFingerprint(model: {
	provider: string;
	id: string;
	api: string;
	baseUrl: string;
	apiKeyEnv: string;
	thinkingLevel: string;
	params: Record<string, unknown>;
	spec: object;
}): ModelFingerprint {
	return {
		provider: model.provider,
		id: model.id,
		api: model.api,
		baseUrl: model.baseUrl.replace(/\/+$/, ""),
		apiKeyEnv: model.apiKeyEnv,
		thinkingLevel: model.thinkingLevel,
		params: model.params,
		spec: { ...model.spec },
	};
}

/** Build a complete execution fingerprint; defaults exist only for fixture compatibility. */
export function executionFingerprint(
	workspace: "isolated" | "direct" = "isolated",
	effective?: {
		tools: string[];
		environment: string[];
		sandbox: ExecutionFingerprint["sandbox"];
		network: ExecutionFingerprint["network"];
		filesystem?: ExecutionFingerprint["filesystem"];
	},
): ExecutionFingerprint {
	return {
		workspace: workspace === "direct" ? "direct-v1" : "isolated-copy-v1",
		tools: effective?.tools ?? ["read", "bash", "edit", "write"],
		environment: effective?.environment ?? ["process-env"],
		sandbox: effective?.sandbox ?? "none",
		network: effective?.network ?? "allow",
		filesystem: effective?.filesystem ?? (workspace === "direct" ? "direct-unconfined-v1" : "workspace-confined-v1"),
		resources: {
			contextFiles: "disabled",
			extensions: "disabled",
			promptTemplates: "disabled",
			skills: "manifest-only",
		},
	};
}

/**
 * Identity of the evaluator semantics that decide a run's outcome: the runner,
 * the eval loop, trace extraction and the judge protocol.
 *
 * BUMP THIS BY HAND (…-v2, -v3, …) whenever a change to `runner.ts`,
 * `eval.ts`, `trace.ts` or the judge request/verdict protocol could move a
 * pass/fail outcome for identical inputs. Evidence produced before the bump
 * then becomes legacy (incomparable) instead of silently comparable.
 *
 * It replaces `ahdeCodeHash` as an axis on purpose: the source hash covers all
 * 1.3 MB of AHDE, so a README-adjacent edit used to invalidate every baseline.
 * The exact hash is still recorded in `runtime.ahdeCodeHash` of every record.
 */
export const AHDE_EVALUATOR_ID = "ahde-evaluator-v1";

/**
 * The provenance axes compared between two runs. The target git SHA is
 * deliberately NOT an axis: baseline and candidate differ exactly there.
 */
export const ProvenanceAxesSchema = z.strictObject({
	piVersion: NonEmptyStringSchema,
	piSha: GitShaSchema,
	ahdeVersion: NonEmptyStringSchema,
	evaluatorId: NonEmptyStringSchema,
	provider: NonEmptyStringSchema,
	modelId: NonEmptyStringSchema,
	modelApi: NonEmptyStringSchema,
	modelBaseUrl: NonEmptyStringSchema,
	modelApiKeyEnv: NonEmptyStringSchema,
	thinkingLevel: NonEmptyStringSchema,
	params: JsonObjectSchema,
	modelSpec: JsonObjectSchema,
	judge: ModelFingerprintSchema.nullable(),
	execution: ExecutionFingerprintSchema,
	suiteHash: HashSchema,
	datasetHash: HashSchema,
});
export type ProvenanceAxes = z.infer<typeof ProvenanceAxesSchema>;

export function provenanceAxes(record: {
	runtime: { piVersion: string; piSha: string; ahdeVersion: string };
	model: ModelFingerprint;
	judge?: ModelFingerprint | null;
	execution: ExecutionFingerprint;
	eval: { suiteHash: string; datasetHash: string };
}): ProvenanceAxes {
	return {
		piVersion: record.runtime.piVersion,
		piSha: record.runtime.piSha,
		ahdeVersion: record.runtime.ahdeVersion,
		evaluatorId: AHDE_EVALUATOR_ID,
		provider: record.model.provider,
		modelId: record.model.id,
		modelApi: record.model.api,
		modelBaseUrl: record.model.baseUrl,
		modelApiKeyEnv: record.model.apiKeyEnv,
		thinkingLevel: record.model.thinkingLevel,
		params: record.model.params,
		modelSpec: record.model.spec,
		judge: record.judge ?? null,
		execution: record.execution,
		suiteHash: record.eval.suiteHash,
		datasetHash: record.eval.datasetHash,
	};
}

export function provenanceKey(record: Parameters<typeof provenanceAxes>[0]): string {
	return hashValue(provenanceAxes(record));
}

const AXIS_LABELS: Record<keyof ProvenanceAxes, string> = {
	piVersion: "runtime.piVersion",
	piSha: "runtime.piSha",
	ahdeVersion: "runtime.ahdeVersion",
	evaluatorId: "runtime.evaluatorId",
	provider: "model.provider",
	modelId: "model.id",
	modelApi: "model.api",
	modelBaseUrl: "model.baseUrl",
	modelApiKeyEnv: "model.apiKeyEnv",
	thinkingLevel: "model.thinkingLevel",
	params: "model.params",
	modelSpec: "model.spec",
	judge: "eval.judge",
	execution: "execution",
	suiteHash: "eval.suiteHash",
	datasetHash: "eval.datasetHash",
};

/** Names of axes that differ between two runs; empty array means comparable. */
export function axisDifferences(a: ProvenanceAxes, b: ProvenanceAxes): string[] {
	const diffs: string[] = [];
	for (const key of Object.keys(AXIS_LABELS) as (keyof ProvenanceAxes)[]) {
		const av = a[key];
		const bv = b[key];
		if (typeof av === "object" || typeof bv === "object") {
			if (canonicalJson(av) !== canonicalJson(bv)) diffs.push(AXIS_LABELS[key]);
		} else if (av !== bv) {
			diffs.push(AXIS_LABELS[key]);
		}
	}
	return diffs;
}

export function comparable(a: ProvenanceAxes, b: ProvenanceAxes): boolean {
	return axisDifferences(a, b).length === 0;
}
