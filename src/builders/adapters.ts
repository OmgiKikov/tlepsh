import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * The Builder proposal contract: the durable proposal/run schemas, the trust
 * boundary that validates a model-authored proposal against its exact request,
 * and the one in-process adapter that drives a tool-free Pi executor.
 */

const GitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, "expected a full Git SHA");
const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected a sha256 base hash");
const NonEmptySchema = z.string().min(1).refine((value) => value.trim().length > 0, "expected a non-blank string");
const SafePathSchema = z
	.string()
	.min(1)
	.refine(
		(path) =>
			path === path.trim() &&
			!path.startsWith("/") &&
			!path.includes("\\") &&
			!path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
		"path must be a normalized repository-relative path",
	);

function looksLikeUnifiedDiff(diff: string): boolean {
	const lines = diff.split("\n");
	return lines.some((line) => line.startsWith("--- ")) &&
		lines.some((line) => line.startsWith("+++ ")) &&
		lines.some((line) => line.startsWith("@@ "));
}

const DiagnosisSchema = z.strictObject({
	failureIds: z.array(NonEmptySchema).min(1),
	evidence: z.array(NonEmptySchema).min(1),
	rootCause: NonEmptySchema,
});

const ProposalChangeSchema = z.strictObject({
	path: SafePathSchema,
	baseSha256: Sha256Schema,
	unifiedDiff: NonEmptySchema.refine(looksLikeUnifiedDiff, "expected a non-empty unified diff"),
	rationale: NonEmptySchema,
	evidenceRefs: z.array(NonEmptySchema),
});

/** Predicted failure modes one proposal may name; a proposal targets at most 8. */
export const MAX_PREDICTED_MODES = 8;
/** A delta is a percentage-point figure; nothing outside ±100 is a prediction. */
const DeltaPointsSchema = z.number().min(-100).max(100);

const PredictedModeSchema = z
	.strictObject({
		failureModeId: NonEmptySchema,
		/** Tasks this mode is still expected to fail after the change. */
		expectedFailingTasks: z.number().int().nonnegative().max(1_000_000),
		/** Tasks the mode was measured over — the denominator the promise is read against. */
		ofTasks: z.number().int().positive().max(1_000_000),
	})
	.superRefine((mode, context) => {
		if (mode.expectedFailingTasks > mode.ofTasks) {
			context.addIssue({
				code: "custom",
				path: ["expectedFailingTasks"],
				message: "expectedFailingTasks cannot exceed ofTasks",
			});
		}
	});
export type ProposalPredictedMode = z.infer<typeof PredictedModeSchema>;

/**
 * The falsifiable number a change is judged against.
 *
 * Evidence, an inferred cause and a targeted fix already travel with every
 * proposal; the promise did not. Without it a verification can only say
 * "improved" or "regressed" — never "the Builder said 26/26 would become 3/26
 * and it became 1/26". It is authored once, at submission, hashed into the
 * proposal the operator approves, and never edited afterwards: a prediction
 * that can be revised once the result is in predicts nothing.
 */
export const ProposalPredictionSchema = z
	.strictObject({
		modes: z.array(PredictedModeSchema).max(MAX_PREDICTED_MODES),
		/** Expected pass-rate movement of the whole basket, in percentage points. */
		expectedPassRateDeltaPp: DeltaPointsSchema.nullable().default(null),
		/** Expected movement of the mean paired grader score the gate decides on. */
		expectedScoreDeltaPp: DeltaPointsSchema.nullable().default(null),
		note: NonEmptySchema.nullable().default(null),
	})
	.superRefine((prediction, context) => {
		if (new Set(prediction.modes.map((mode) => mode.failureModeId)).size !== prediction.modes.length) {
			context.addIssue({ code: "custom", path: ["modes"], message: "predicted failure mode ids must be unique" });
		}
		if (
			prediction.modes.length === 0 &&
			prediction.expectedPassRateDeltaPp === null &&
			prediction.expectedScoreDeltaPp === null
		) {
			context.addIssue({ code: "custom", path: [], message: "a prediction must promise at least one number" });
		}
	});
export type ProposalPrediction = z.infer<typeof ProposalPredictionSchema>;
/** The shape a caller may hand a compiler, before the schema fills its defaults. */
export type ProposalPredictionInput = z.input<typeof ProposalPredictionSchema>;

/**
 * Proposals carrying a `prediction` are written at version 2. Version 1 is
 * still read exactly as before and reads back as `prediction: null` — an old
 * proposal promised nothing, and nothing may invent a promise for it.
 */
export const CANDIDATE_PROPOSAL_SCHEMA_VERSION = 2;

export const CandidateProposalSchema = z
	.strictObject({
		schemaVersion: z.union([z.literal(1), z.literal(CANDIDATE_PROPOSAL_SCHEMA_VERSION)]),
		decision: z.enum(["propose", "no-change"]),
		baseTargetSha: GitShaSchema,
		summary: NonEmptySchema,
		diagnoses: z.array(DiagnosisSchema),
		changes: z.array(ProposalChangeSchema),
		risks: z.array(NonEmptySchema),
		validationPlan: z.array(NonEmptySchema),
		/** Absent on every pre-v2 proposal, and on a construction proposal that stated no number. */
		prediction: ProposalPredictionSchema.nullable().default(null),
	})
	.superRefine((proposal, context) => {
		if (proposal.prediction && proposal.schemaVersion < CANDIDATE_PROPOSAL_SCHEMA_VERSION) {
			context.addIssue({
				code: "custom",
				path: ["prediction"],
				message: `a prediction requires proposal schemaVersion ${CANDIDATE_PROPOSAL_SCHEMA_VERSION}`,
			});
		}
		if (proposal.decision === "no-change" && proposal.prediction) {
			context.addIssue({ code: "custom", path: ["prediction"], message: "no-change cannot promise an impact" });
		}
		if (proposal.decision === "propose" && proposal.changes.length === 0) {
			context.addIssue({ code: "custom", path: ["changes"], message: "propose requires at least one change" });
		}
		if (proposal.decision === "no-change" && proposal.changes.length !== 0) {
			context.addIssue({ code: "custom", path: ["changes"], message: "no-change cannot contain changes" });
		}
		const paths = new Set<string>();
		for (const [index, change] of proposal.changes.entries()) {
			if (paths.has(change.path)) {
				context.addIssue({ code: "custom", path: ["changes", index, "path"], message: "change paths must be unique" });
			}
			paths.add(change.path);
			if (change.path.startsWith("evals/")) {
				context.addIssue({ code: "custom", path: ["changes", index, "path"], message: "v1 proposals cannot modify evals/**" });
			}
		}
	});
export type CandidateProposal = z.infer<typeof CandidateProposalSchema>;

export const BuilderCapabilitiesSchema = z.strictObject({
	eventStream: z.boolean(),
	structuredOutput: z.boolean(),
	usage: z.boolean(),
	cost: z.boolean(),
	sessionId: z.boolean(),
	cancellation: z.boolean(),
	isolation: z.enum(["empty-temp-cwd", "read-confined-cli", "tool-free-executor"]),
});
export type BuilderCapabilities = z.infer<typeof BuilderCapabilitiesSchema>;

export const BuilderErrorSchema = z.strictObject({
	code: NonEmptySchema,
	message: NonEmptySchema,
	retryable: z.boolean(),
});
export type BuilderError = z.infer<typeof BuilderErrorSchema>;

export const BuilderUsageSchema = z.strictObject({
	inputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
	cacheReadTokens: z.number().int().nonnegative(),
	cacheWriteTokens: z.number().int().nonnegative(),
});
export type BuilderUsage = z.infer<typeof BuilderUsageSchema>;

export const MAX_RAW_EVENT_BYTES = 1024 * 1024;

export const BuilderRunRecordSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		runId: NonEmptySchema,
		backend: NonEmptySchema,
		backendVersion: NonEmptySchema.nullable(),
		capabilities: BuilderCapabilitiesSchema,
		baseTargetSha: GitShaSchema,
		startedAt: z.iso.datetime({ offset: true }),
		finishedAt: z.iso.datetime({ offset: true }),
		status: z.enum(["completed", "failed", "timeout", "cancelled"]),
		proposal: CandidateProposalSchema.nullable(),
		model: NonEmptySchema.nullable(),
		sessionId: NonEmptySchema.nullable(),
		usage: BuilderUsageSchema.nullable(),
		costUsd: z.number().nonnegative().nullable(),
		traceLevel: z.enum(["full", "final-only"]),
		rawEvents: z.array(z.string()),
		error: BuilderErrorSchema.nullable(),
	})
	.superRefine((record, context) => {
		const bytes = Buffer.byteLength(record.rawEvents.join("\n"), "utf8");
		if (bytes > MAX_RAW_EVENT_BYTES) {
			context.addIssue({ code: "custom", path: ["rawEvents"], message: "raw JSONL exceeds the record limit" });
		}
		if (record.status === "completed") {
			if (!record.proposal) context.addIssue({ code: "custom", path: ["proposal"], message: "completed run requires a proposal" });
			if (record.error) context.addIssue({ code: "custom", path: ["error"], message: "completed run cannot contain an error" });
			if (!record.backendVersion) context.addIssue({ code: "custom", path: ["backendVersion"], message: "completed run requires an exact backend version" });
		} else {
			if (record.proposal) context.addIssue({ code: "custom", path: ["proposal"], message: `${record.status} run cannot publish a proposal` });
			if (!record.error) context.addIssue({ code: "custom", path: ["error"], message: `${record.status} run requires an error` });
		}
	});
export type BuilderRunRecord = z.infer<typeof BuilderRunRecordSchema>;
export type BuilderResult = BuilderRunRecord;

export const BuilderProbeSchema = z
	.strictObject({
		backend: NonEmptySchema,
		available: z.boolean(),
		version: NonEmptySchema.nullable(),
		capabilities: BuilderCapabilitiesSchema,
		error: BuilderErrorSchema.nullable(),
	})
	.superRefine((probe, context) => {
		if (probe.available && (!probe.version || probe.error)) {
			context.addIssue({ code: "custom", message: "available probe requires version and no error" });
		}
		if (!probe.available && (probe.version || !probe.error)) {
			context.addIssue({ code: "custom", message: "unavailable probe requires an error and no version" });
		}
	});
export type BuilderProbe = z.infer<typeof BuilderProbeSchema>;

const BuilderRequestDataSchema = z.strictObject({
	runId: NonEmptySchema.optional(),
	bundle: NonEmptySchema,
	baseTargetSha: GitShaSchema,
	allowedPaths: z
		.array(SafePathSchema)
		.min(1)
		.refine((paths) => new Set(paths).size === paths.length, "allowedPaths must be unique"),
	timeoutMs: z.number().int().positive().max(2_147_483_647),
});

export interface BuilderRequest extends z.input<typeof BuilderRequestDataSchema> {
	signal?: AbortSignal;
}

export interface BuilderAdapter {
	readonly backend: string;
	readonly capabilities: BuilderCapabilities;
	probe(): Promise<BuilderProbe>;
	run(request: BuilderRequest): Promise<BuilderResult>;
}

function matchesAllowedPath(path: string, allowed: string): boolean {
	return allowed.endsWith("/**") ? path.startsWith(allowed.slice(0, -2)) : path === allowed;
}

function diffTargetsPath(diff: string, path: string): boolean {
	const lines = diff.split("\n");
	const oldHeaders = lines.filter((line) => line.startsWith("--- a/") || line === "--- /dev/null");
	const newHeaders = lines.filter((line) => line.startsWith("+++ b/") || line === "+++ /dev/null");
	if (oldHeaders.length !== 1 || newHeaders.length !== 1) return false;
	const gitHeaders = lines.filter((line) => line.startsWith("diff --git "));
	if (gitHeaders.length > 1 || (gitHeaders.length === 1 && gitHeaders[0] !== `diff --git a/${path} b/${path}`)) {
		return false;
	}
	const oldHeader = oldHeaders[0]?.slice(4).trim();
	const newHeader = newHeaders[0]?.slice(4).trim();
	const expectedOld = `a/${path}`;
	const expectedNew = `b/${path}`;
	return (oldHeader === expectedOld || oldHeader === "/dev/null") &&
		(newHeader === expectedNew || newHeader === "/dev/null") &&
		!(oldHeader === "/dev/null" && newHeader === "/dev/null");
}

/** Validate an authoritative structured proposal against its exact request. */
export function validateCandidateProposal(value: unknown, request: Pick<BuilderRequest, "baseTargetSha" | "allowedPaths">): CandidateProposal {
	const proposal = CandidateProposalSchema.parse(value);
	if (proposal.baseTargetSha !== request.baseTargetSha) {
		throw new Error(`proposal baseTargetSha ${proposal.baseTargetSha} does not match requested ${request.baseTargetSha}`);
	}
	for (const change of proposal.changes) {
		if (!request.allowedPaths.some((allowed) => matchesAllowedPath(change.path, allowed))) {
			throw new Error(`proposal path is outside the allowed scope: ${change.path}`);
		}
		if (!diffTargetsPath(change.unifiedDiff, change.path)) {
			throw new Error(`unified diff headers do not match proposal path: ${change.path}`);
		}
	}
	return proposal;
}


function rawJsonl(stdout: string, limit: number): { events: string[]; exceeded: boolean } {
	if (Buffer.byteLength(stdout, "utf8") > limit) {
		let bytes = 0;
		const events: string[] = [];
		for (const line of stdout.split("\n")) {
			if (!line) continue;
			const next = Buffer.byteLength(line, "utf8") + (events.length > 0 ? 1 : 0);
			if (bytes + next > limit) break;
			events.push(line);
			bytes += next;
		}
		return { events, exceeded: true };
	}
	return { events: stdout.split("\n").filter((line) => line.length > 0), exceeded: false };
}

function builderError(code: string, message: string, retryable: boolean): BuilderError {
	return { code, message: message.trim() || code, retryable };
}

interface RecordInput {
	runId: string;
	backend: string;
	backendVersion: string | null;
	capabilities: BuilderCapabilities;
	baseTargetSha: string;
	startedAt: string;
	finishedAt: string;
	status: BuilderRunRecord["status"];
	proposal: CandidateProposal | null;
	model?: string | null;
	sessionId?: string | null;
	usage?: BuilderUsage | null;
	costUsd?: number | null;
	traceLevel: BuilderRunRecord["traceLevel"];
	rawEvents?: string[];
	error: BuilderError | null;
}

function runRecord(input: RecordInput): BuilderRunRecord {
	return BuilderRunRecordSchema.parse({
		schemaVersion: 1,
		...input,
		model: input.model ?? null,
		sessionId: input.sessionId ?? null,
		usage: input.usage ?? null,
		costUsd: input.costUsd ?? null,
		rawEvents: input.rawEvents ?? [],
	});
}

export interface PiBuilderExecutionRequest {
	input: string;
	outputSchema: Record<string, unknown>;
	tools: readonly [];
	timeoutMs: number;
	signal: AbortSignal;
}

export interface PiBuilderExecutionResult {
	final: unknown;
	events?: Array<string | unknown>;
	model?: string | null;
	sessionId?: string | null;
	usage?: BuilderUsage | null;
	costUsd?: number | null;
}

export interface PiBuilderExecutor {
	version: string;
	capabilities?: Partial<Pick<BuilderCapabilities, "eventStream" | "usage" | "cost" | "sessionId">>;
	execute(request: PiBuilderExecutionRequest): Promise<PiBuilderExecutionResult>;
	/** Force an abort-ignoring execution to settle. The returned promise confirms termination. */
	terminate?(reason: "timeout" | "cancelled"): Promise<void>;
}

export interface PiBuilderAdapterOptions {
	executor: PiBuilderExecutor;
	now?: () => string;
	maxRawEventBytes?: number;
}

class StopError extends Error {
	constructor(readonly kind: "timeout" | "cancelled") {
		super(kind);
	}
}

export class PiBuilderAdapter implements BuilderAdapter {
	readonly backend = "pi";
	readonly capabilities: BuilderCapabilities;
	private readonly executor: PiBuilderExecutor;
	private readonly now: () => string;
	private readonly maxRawBytes: number;

	constructor(options: PiBuilderAdapterOptions) {
		this.executor = options.executor;
		this.capabilities = BuilderCapabilitiesSchema.parse({
			eventStream: options.executor.capabilities?.eventStream ?? false,
			structuredOutput: true,
			usage: options.executor.capabilities?.usage ?? false,
			cost: options.executor.capabilities?.cost ?? false,
			sessionId: options.executor.capabilities?.sessionId ?? false,
			cancellation: true,
			isolation: "tool-free-executor",
		});
		this.now = options.now ?? (() => new Date().toISOString());
		this.maxRawBytes = Math.min(options.maxRawEventBytes ?? MAX_RAW_EVENT_BYTES, MAX_RAW_EVENT_BYTES);
	}

	async probe(): Promise<BuilderProbe> {
		if (!this.executor.version.trim()) {
			return BuilderProbeSchema.parse({
				backend: this.backend,
				available: false,
				version: null,
				capabilities: this.capabilities,
				error: builderError("probe-failed", "Pi executor did not provide a version", false),
			});
		}
		return BuilderProbeSchema.parse({
			backend: this.backend,
			available: true,
			version: this.executor.version,
			capabilities: this.capabilities,
			error: null,
		});
	}

	async run(request: BuilderRequest): Promise<BuilderResult> {
		const { signal, ...requestData } = request;
		const value = BuilderRequestDataSchema.parse(requestData);
		const runId = value.runId ?? `builder-${randomUUID()}`;
		const startedAt = this.now();
		const probe = await this.probe();
		if (!probe.available || !probe.version) {
			return runRecord({
				runId,
				backend: this.backend,
				backendVersion: null,
				capabilities: this.capabilities,
				baseTargetSha: value.baseTargetSha,
				startedAt,
				finishedAt: this.now(),
				status: "failed",
				proposal: null,
				traceLevel: "final-only",
				error: probe.error,
			});
		}
		if (signal?.aborted) {
			return runRecord({
				runId,
				backend: this.backend,
				backendVersion: probe.version,
				capabilities: this.capabilities,
				baseTargetSha: value.baseTargetSha,
				startedAt,
				finishedAt: this.now(),
				status: "cancelled",
				proposal: null,
				traceLevel: "final-only",
				error: builderError("cancelled", "builder request was cancelled", false),
			});
		}

		const controller = new AbortController();
		let stop: "timeout" | "cancelled" | null = null;
		const onAbort = (): void => {
			stop = "cancelled";
			controller.abort();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => {
			stop = "timeout";
			controller.abort();
		}, value.timeoutMs);
		const stopped = new Promise<never>((_resolve, reject) => {
			if (stop) reject(new StopError(stop));
			controller.signal.addEventListener("abort", () => reject(new StopError(stop ?? "cancelled")), { once: true });
		});

			const executionPromise = this.executor.execute({
				input: value.bundle,
				outputSchema: z.toJSONSchema(CandidateProposalSchema) as Record<string, unknown>,
				tools: [],
				timeoutMs: value.timeoutMs,
				signal: controller.signal,
			});
		try {
			const execution = await Promise.race([executionPromise, stopped]);
			if (stop) throw new StopError(stop);
			const raw = rawJsonl(
				(execution.events ?? []).map((event) => typeof event === "string" ? event : JSON.stringify(event)).join("\n"),
				this.maxRawBytes,
			);
			const common = {
				runId,
				backend: this.backend,
				backendVersion: probe.version,
				capabilities: this.capabilities,
				baseTargetSha: value.baseTargetSha,
				startedAt,
				finishedAt: this.now(),
				model: execution.model ?? null,
				sessionId: execution.sessionId ?? null,
				usage: execution.usage ?? null,
				costUsd: execution.costUsd ?? null,
				traceLevel: raw.events.length > 0 ? "full" as const : "final-only" as const,
				rawEvents: raw.events,
			};
			if (raw.exceeded) {
				return runRecord({ ...common, status: "failed", proposal: null, error: builderError("output-limit", "Pi events exceeded the bounded trace limit", false) });
			}
			try {
				const proposal = validateCandidateProposal(execution.final, value);
				return runRecord({ ...common, status: "completed", proposal, error: null });
			} catch (error) {
				return runRecord({
					...common,
					status: "failed",
					proposal: null,
					error: builderError("invalid-structured-output", error instanceof Error ? error.message : String(error), false),
				});
			}
		} catch (error) {
			const kind = error instanceof StopError ? error.kind : null;
			if (kind) {
				await this.executor.terminate?.(kind);
				// Do not publish timeout/cancellation evidence while executor work can
				// still mutate resources or consume tokens in the background.
				try {
					await executionPromise;
				} catch {}
			}
			return runRecord({
				runId,
				backend: this.backend,
				backendVersion: probe.version,
				capabilities: this.capabilities,
				baseTargetSha: value.baseTargetSha,
				startedAt,
				finishedAt: this.now(),
				status: kind ?? "failed",
				proposal: null,
				traceLevel: "final-only",
				error: builderError(kind ?? "executor-failed", kind ?? (error instanceof Error ? error.message : String(error)), kind === "timeout"),
			});
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}
}
