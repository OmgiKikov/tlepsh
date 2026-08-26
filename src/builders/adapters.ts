import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

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

export const CandidateProposalSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		decision: z.enum(["propose", "no-change"]),
		baseTargetSha: GitShaSchema,
		summary: NonEmptySchema,
		diagnoses: z.array(DiagnosisSchema),
		changes: z.array(ProposalChangeSchema),
		risks: z.array(NonEmptySchema),
		validationPlan: z.array(NonEmptySchema),
	})
	.superRefine((proposal, context) => {
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

export interface BuilderSpawnInvocation {
	executable: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	stdin: string;
	timeoutMs: number;
	maxOutputBytes: number;
	signal?: AbortSignal;
}

export interface BuilderSpawnResult {
	exitCode: number | null;
	signal: string | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	cancelled: boolean;
	outputLimitExceeded: boolean;
	spawnError: string | null;
}

export type BuilderSpawn = (invocation: BuilderSpawnInvocation) => Promise<BuilderSpawnResult>;

export const defaultBuilderSpawn: BuilderSpawn = async (invocation) =>
	new Promise((resolve) => {
		if (invocation.signal?.aborted) {
			resolve({
				exitCode: null,
				signal: null,
				stdout: "",
				stderr: "",
				timedOut: false,
				cancelled: true,
				outputLimitExceeded: false,
				spawnError: null,
			});
			return;
		}

		let child;
		try {
			child = spawn(invocation.executable, invocation.args, {
				cwd: invocation.cwd,
				env: invocation.env,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			resolve({
				exitCode: null,
				signal: null,
				stdout: "",
				stderr: "",
				timedOut: false,
				cancelled: false,
				outputLimitExceeded: false,
				spawnError: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let timedOut = false;
		let cancelled = false;
		let outputLimitExceeded = false;
		let spawnError: string | null = null;
		let settled = false;
		let forceKillTimer: NodeJS.Timeout | null = null;
		const terminate = (): void => {
			child.kill("SIGTERM");
			forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), 250);
		};
		const capture = (destination: Buffer[], chunk: Buffer): void => {
			const remaining = Math.max(0, invocation.maxOutputBytes - outputBytes);
			if (remaining > 0) destination.push(chunk.subarray(0, remaining));
			outputBytes += chunk.length;
			if (outputBytes > invocation.maxOutputBytes && !outputLimitExceeded) {
				outputLimitExceeded = true;
				terminate();
			}
		};
		child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
		child.on("error", (error) => {
			spawnError = error.message;
		});
		const onAbort = (): void => {
			cancelled = true;
			terminate();
		};
		invocation.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			terminate();
		}, invocation.timeoutMs);
		const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			invocation.signal?.removeEventListener("abort", onAbort);
			resolve({
				exitCode,
				signal: exitSignal,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
				timedOut,
				cancelled,
				outputLimitExceeded,
				spawnError,
			});
		};
		child.on("close", finish);
		child.stdin.on("error", () => undefined);
		child.stdin.end(invocation.stdin);
	});

export interface ProcessAdapterOptions {
	executable?: string;
	credentialEnv?: string;
	spawn?: BuilderSpawn;
	hostEnv?: NodeJS.ProcessEnv;
	now?: () => string;
	maxRawEventBytes?: number;
}

interface TempLayout {
	root: string;
	cwd: string;
	home: string;
	temp: string;
	schemaPath: string;
	finalPath: string;
}

async function withTempLayout<T>(callback: (layout: TempLayout) => Promise<T>): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "ahde-builder-"));
	const cwd = join(root, "cwd");
	const home = join(root, "home");
	const temp = join(root, "tmp");
	for (const directory of [cwd, home, temp]) mkdirSync(directory, { mode: 0o700 });
	const layout = {
		root,
		cwd,
		home,
		temp,
		schemaPath: join(root, "candidate-proposal.schema.json"),
		finalPath: join(root, "candidate-proposal.final.json"),
	};
	try {
		return await callback(layout);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function minimalEnvironment(
	hostEnv: NodeJS.ProcessEnv,
	credentialEnv: string,
	layout: TempLayout,
): Record<string, string> {
	const env: Record<string, string> = {
		PATH: hostEnv.PATH ?? "",
		HOME: layout.home,
		TMPDIR: layout.temp,
		CODEX_HOME: layout.home,
		XDG_CACHE_HOME: join(layout.home, ".cache"),
		XDG_CONFIG_HOME: join(layout.home, ".config"),
	};
	const credential = hostEnv[credentialEnv];
	if (credential !== undefined) env[credentialEnv] = credential;
	return env;
}

function executablePath(executable: string, pathValue: string): string {
	if (isAbsolute(executable)) return executable;
	for (const directory of pathValue.split(delimiter).filter(Boolean)) {
		const candidate = join(directory, executable);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return executable;
}

function sandboxString(value: string): string {
	return JSON.stringify(value);
}

function pathAncestors(path: string): string[] {
	const values: string[] = [];
	let current = dirname(path);
	while (current !== dirname(current)) {
		values.push(current);
		current = dirname(current);
	}
	return values;
}

function codexReadProfile(layout: TempLayout, executable: string): string {
	const canonicalRoot = realpathSync(layout.root);
	let canonicalExecutable = executable;
	try {
		canonicalExecutable = realpathSync(executable);
	} catch {}
	const readRoots = [
		"/System",
		"/usr",
		"/bin",
		"/sbin",
		"/Library",
		"/private/etc",
		"/dev",
		"/opt/homebrew",
		"/opt/local",
		"/nix/store",
		layout.root,
		canonicalRoot,
	];
	const readLiterals = [...new Set([
		executable,
		canonicalExecutable,
		...pathAncestors(layout.root),
		...pathAncestors(canonicalRoot),
		...pathAncestors(executable),
		...pathAncestors(canonicalExecutable),
	])];
	return [
		"(version 1)",
		"(deny default)",
		"(allow process*)",
		"(allow signal (target self))",
		"(allow sysctl-read)",
		"(allow mach-lookup)",
		"(allow ipc-posix*)",
		"(allow network*)",
		"(allow file-read-metadata)",
		`(allow file-read* (literal "/") ${readRoots.map((path) => `(subpath ${sandboxString(path)})`).join(" ")} ${readLiterals.map((path) => `(literal ${sandboxString(path)})`).join(" ")})`,
		`(allow file-write* (literal "/dev/null") (subpath ${sandboxString(layout.root)}) (subpath ${sandboxString(canonicalRoot)}))`,
	].join(" ");
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

function parsedEvents(rawEvents: string[]): Record<string, unknown>[] {
	const parsed: Record<string, unknown>[] = [];
	for (const raw of rawEvents) {
		try {
			const value = JSON.parse(raw) as unknown;
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				parsed.push(value as Record<string, unknown>);
			}
		} catch {
			// Raw evidence remains available verbatim; metadata extraction is optional.
		}
	}
	return parsed;
}

function numeric(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function metadata(events: Record<string, unknown>[]): {
	model: string | null;
	sessionId: string | null;
	usage: BuilderUsage | null;
	costUsd: number | null;
} {
	let model: string | null = null;
	let sessionId: string | null = null;
	let usage: BuilderUsage | null = null;
	let costUsd: number | null = null;
	for (const event of events) {
		model = stringValue(event.model) ?? model;
		sessionId = stringValue(event.session_id) ?? stringValue(event.thread_id) ?? sessionId;
		costUsd = numeric(event.total_cost_usd) ?? numeric(event.cost_usd) ?? costUsd;
		if (typeof event.usage === "object" && event.usage !== null) {
			const raw = event.usage as Record<string, unknown>;
			const inputTokens = numeric(raw.input_tokens) ?? numeric(raw.inputTokens);
			const outputTokens = numeric(raw.output_tokens) ?? numeric(raw.outputTokens);
			if (inputTokens !== null && outputTokens !== null) {
				usage = {
					inputTokens,
					outputTokens,
					cacheReadTokens: numeric(raw.cache_read_input_tokens) ?? numeric(raw.cache_read_tokens) ?? 0,
					cacheWriteTokens: numeric(raw.cache_creation_input_tokens) ?? numeric(raw.cache_write_tokens) ?? 0,
				};
			}
		}
	}
	return { model, sessionId, usage, costUsd };
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

abstract class CliBuilderAdapter implements BuilderAdapter {
	abstract readonly backend: string;
	abstract readonly capabilities: BuilderCapabilities;
	protected abstract readonly defaultExecutable: string;
	protected abstract readonly defaultCredentialEnv: string;

	private readonly options: ProcessAdapterOptions;
	private cachedProbe: BuilderProbe | null = null;

	constructor(options: ProcessAdapterOptions = {}) {
		this.options = options;
	}

	protected abstract commandArgs(layout: TempLayout): string[];
	protected abstract authoritativeFinal(layout: TempLayout, events: Record<string, unknown>[]): unknown;
	protected processInvocation(
		_layout: TempLayout,
		executable: string,
		args: string[],
		_env: Record<string, string>,
	): { executable: string; args: string[] } {
		return { executable, args };
	}

	protected get executable(): string {
		return this.options.executable ?? this.defaultExecutable;
	}

	private get spawnProcess(): BuilderSpawn {
		return this.options.spawn ?? defaultBuilderSpawn;
	}

	private env(layout: TempLayout): Record<string, string> {
		return minimalEnvironment(
			this.options.hostEnv ?? process.env,
			this.options.credentialEnv ?? this.defaultCredentialEnv,
			layout,
		);
	}

	private get now(): () => string {
		return this.options.now ?? (() => new Date().toISOString());
	}

	private get maxRawBytes(): number {
		return Math.min(this.options.maxRawEventBytes ?? MAX_RAW_EVENT_BYTES, MAX_RAW_EVENT_BYTES);
	}

	async probe(): Promise<BuilderProbe> {
		if (this.cachedProbe) return this.cachedProbe;
		const probe = await withTempLayout(async (layout) => {
			const env = this.env(layout);
			const invocation = this.processInvocation(layout, this.executable, ["--version"], env);
			const result = await this.spawnProcess({
				executable: invocation.executable,
				args: invocation.args,
				cwd: layout.cwd,
				env,
				stdin: "",
				timeoutMs: 5_000,
				maxOutputBytes: 64 * 1024,
			});
			const version = (result.stdout.trim() || result.stderr.trim()) || null;
			if (result.spawnError) {
				return BuilderProbeSchema.parse({
					backend: this.backend,
					available: false,
					version: null,
					capabilities: this.capabilities,
					error: builderError("binary-missing", result.spawnError, false),
				});
			}
			if (result.timedOut || result.cancelled || result.outputLimitExceeded || result.exitCode !== 0 || !version) {
				return BuilderProbeSchema.parse({
					backend: this.backend,
					available: false,
					version: null,
					capabilities: this.capabilities,
					error: builderError("probe-failed", result.stderr || "backend version probe failed", true),
				});
			}
			return BuilderProbeSchema.parse({
				backend: this.backend,
				available: true,
				version,
				capabilities: this.capabilities,
				error: null,
			});
		});
		if (probe.available) this.cachedProbe = probe;
		return probe;
	}

	async run(request: BuilderRequest): Promise<BuilderResult> {
		const { signal, ...requestData } = request;
		const value = BuilderRequestDataSchema.parse(requestData);
		const runId = value.runId ?? `builder-${randomUUID()}`;
		const startedAt = this.now();
		if (signal?.aborted) {
			return runRecord({
				runId,
				backend: this.backend,
				backendVersion: this.cachedProbe?.version ?? null,
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
				error: probe.error ?? builderError("probe-failed", "backend is unavailable", true),
			});
		}

		return withTempLayout(async (layout) => {
			writeFileSync(layout.schemaPath, `${JSON.stringify(z.toJSONSchema(CandidateProposalSchema), null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			const env = this.env(layout);
			const invocation = this.processInvocation(layout, this.executable, this.commandArgs(layout), env);
			const result = await this.spawnProcess({
				executable: invocation.executable,
				args: invocation.args,
				cwd: layout.cwd,
				env,
				stdin: value.bundle,
				timeoutMs: value.timeoutMs,
				maxOutputBytes: this.maxRawBytes,
				signal,
			});
			const raw = rawJsonl(result.stdout, this.maxRawBytes);
			const events = parsedEvents(raw.events);
			const extracted = metadata(events);
			const common = {
				runId,
				backend: this.backend,
				backendVersion: probe.version,
				capabilities: this.capabilities,
				baseTargetSha: value.baseTargetSha,
				startedAt,
				finishedAt: this.now(),
				proposal: null,
				model: extracted.model,
				sessionId: extracted.sessionId,
				usage: extracted.usage,
				costUsd: extracted.costUsd,
				traceLevel: "full" as const,
				rawEvents: raw.events,
			};

			if (result.cancelled) return runRecord({ ...common, status: "cancelled", error: builderError("cancelled", "backend execution was cancelled", false) });
			if (result.timedOut) return runRecord({ ...common, status: "timeout", error: builderError("timeout", "backend execution timed out", true) });
			if (result.outputLimitExceeded || raw.exceeded) {
				return runRecord({ ...common, status: "failed", error: builderError("output-limit", "backend JSONL exceeded the bounded trace limit", false) });
			}
			if (result.spawnError) return runRecord({ ...common, status: "failed", error: builderError("spawn-failed", result.spawnError, true) });
			if (result.exitCode !== 0) {
				return runRecord({ ...common, status: "failed", error: builderError("nonzero-exit", result.stderr || `backend exited ${result.exitCode}`, true) });
			}

			let proposal: CandidateProposal;
			try {
				const final = this.authoritativeFinal(layout, events);
				proposal = validateCandidateProposal(final, value);
			} catch (error) {
				return runRecord({
					...common,
					status: "failed",
					error: builderError(
						"invalid-structured-output",
						error instanceof Error ? error.message : String(error),
						false,
					),
				});
			}
			return runRecord({ ...common, status: "completed", proposal, error: null });
		});
	}
}

export class CodexCliBuilderAdapter extends CliBuilderAdapter {
	readonly backend = "codex-cli";
	readonly capabilities: BuilderCapabilities = {
		eventStream: true,
		structuredOutput: true,
		usage: true,
		cost: false,
		sessionId: true,
		cancellation: true,
		isolation: "read-confined-cli",
	};
	protected readonly defaultExecutable = "codex";
	protected readonly defaultCredentialEnv = "OPENAI_API_KEY";

	protected commandArgs(layout: TempLayout): string[] {
		return [
			"exec",
			"--ephemeral",
			"--json",
			"--sandbox",
			"read-only",
			"--ignore-user-config",
			"--ignore-rules",
			"--output-schema",
			layout.schemaPath,
			"--output-last-message",
			layout.finalPath,
			"-",
		];
	}

	protected processInvocation(
		layout: TempLayout,
		executable: string,
		args: string[],
		env: Record<string, string>,
	): { executable: string; args: string[] } {
		const child = executablePath(executable, env.PATH ?? "");
		if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
			return {
				executable: "/usr/bin/sandbox-exec",
				args: ["-p", codexReadProfile(layout, child), child, ...args],
			};
		}
		// Codex has shell/read tools and no supported tool-free CLI flag. Never
		// silently downgrade to an empty cwd on a host without a read sandbox.
		return {
			executable: `ahde-codex-read-sandbox-unavailable-${process.platform}`,
			args: [],
		};
	}

	protected authoritativeFinal(layout: TempLayout): unknown {
		if (!existsSync(layout.finalPath)) throw new Error("Codex did not create --output-last-message schema output");
		const content = readFileSync(layout.finalPath, "utf8").trim();
		if (!content) throw new Error("Codex schema output is empty");
		return JSON.parse(content) as unknown;
	}
}

export class ClaudeCliBuilderAdapter extends CliBuilderAdapter {
	readonly backend = "claude-cli";
	readonly capabilities: BuilderCapabilities = {
		eventStream: true,
		structuredOutput: true,
		usage: true,
		cost: true,
		sessionId: true,
		cancellation: true,
		isolation: "empty-temp-cwd",
	};
	protected readonly defaultExecutable = "claude";
	protected readonly defaultCredentialEnv = "ANTHROPIC_API_KEY";

	protected commandArgs(layout: TempLayout): string[] {
		return [
			"--bare",
			"-p",
			"--no-session-persistence",
			"--tools",
			"",
			"--disallowedTools",
			"*",
			"--permission-mode",
			"dontAsk",
			"--output-format",
			"stream-json",
			"--verbose",
			"--json-schema",
			layout.schemaPath,
		];
	}

	protected authoritativeFinal(_layout: TempLayout, events: Record<string, unknown>[]): unknown {
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (event?.type === "result" && "structured_output" in event) return event.structured_output;
		}
		throw new Error("Claude stream did not contain authoritative structured_output");
	}
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
