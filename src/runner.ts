import { execFileSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { loadTarget, type ResolvedTarget, type ResolvedTask, type TargetManifest } from "./manifest.js";
import {
	executionFingerprint,
	hashFile,
	hashValue,
	modelFingerprint,
	RunRecordSchema,
	type RunRecord,
} from "./provenance.js";
import { writeJsonArtifact } from "./storage/artifacts.js";
import { readTraceArtifact, traceToolErrors } from "./trace.js";
import {
	buildExecutionPolicy,
	type ExecutionPolicyResult,
} from "./execution-policy.js";
import {
	emitExecutionFinished,
	emitRunStarted,
	observeRunSessionEvent,
	type RunEventIdentity,
	type RunEventListener,
} from "./run-events.js";
import {
	createTargetAgentSession,
	createTargetToolRuntime,
	targetFilesystemConfinement,
	type TargetToolRuntime,
} from "./target/runtime.js";

/**
 * Task orchestration around the single Target Pi construction seam in
 * target/runtime.ts. Translates a resolved target + task into an isolated
 * session and a durable run directory.
 */

export interface RunTaskOptions {
	/** Root directory for run artifacts (e.g. <repo>/runs). */
	runsRoot: string;
	label: "baseline" | "candidate" | "solo";
	repetitionIndex: number;
	evalRunId: string | null;
	/** Target git sha this candidate improves (null for baseline/solo). */
	candidateOf: string | null;
	/** One-based position within the parent suite's tasks × repetitions. */
	ordinal?: number;
	/** Total executions within the parent suite's tasks × repetitions. */
	total?: number;
	/** Optional synchronous, observational event listener. */
	onRunEvent?: RunEventListener;
	/** Host-owned cancellation for the entire parent decision. */
	signal?: AbortSignal;
	/**
	 * Targets run in an isolated copy by default. Explicit diagnostic callers
	 * may opt into direct mode, which provenance records as unconfined.
	 */
	workspaceMode?: "isolated" | "direct";
	/**
	 * @internal Opaque, runner-created source snapshot shared by every task in
	 * one EvalRun. Hand-authored objects are rejected at runtime.
	 */
	workspaceSnapshot?: TargetWorkspaceSnapshot;
}

export interface TargetWorkspaceSnapshot {
	readonly dir: string;
	readonly sha256: string;
	readonly targetIdentity: string;
}

const trustedWorkspaceSnapshots = new WeakSet<TargetWorkspaceSnapshot>();
const workspaceSnapshotRoots = new WeakMap<TargetWorkspaceSnapshot, string>();

export const FINAL_ANSWER_RECOVERY_PROMPT =
	"Сформируй итоговый ответ пользователю сейчас, используя уже полученные результаты инструментов. " +
	"Не вызывай инструменты. Выполни требования target harness к финальному ответу.";

/**
 * Concurrent runs routinely start inside the same millisecond, and two runs
 * sharing an id would share a directory and destroy each other's evidence. The
 * counter guarantees uniqueness within this process; the random suffix keeps
 * ids unique across processes writing to the same runs root.
 */
let runSequence = 0;

function newRunId(): string {
	runSequence += 1;
	return `run_${Date.now().toString(36)}${runSequence.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function generateModelsJson(model: TargetManifest["model"]): Record<string, unknown> {
	const spec = model.spec;
	return {
		providers: {
			[model.provider]: {
				baseUrl: model.baseUrl,
				// Target auth is injected into an in-memory provider credential at
				// session construction. models.json contains neither a secret nor an
				// env reference that could resolve arbitrary ambient host secrets.
				api: model.api,
				models: [
					{
						id: model.id,
						name: model.id,
						reasoning: spec.reasoning,
						input: spec.input ?? ["text"],
						cost: spec.cost,
						contextWindow: spec.contextWindow,
						maxTokens: spec.maxTokens,
						...(spec.thinkingLevelMap ? { thinkingLevelMap: spec.thinkingLevelMap } : {}),
						...(Object.keys(spec.compat).length > 0 ? { compat: spec.compat } : {}),
					},
				],
			},
		},
	};
}

function emptyMetrics(): RunRecord["metrics"] {
	return {
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		costUsd: 0,
		latencyMs: 0,
		toolCalls: 0,
		toolErrors: 0,
		recoveryAttempts: 0,
	};
}

function extractSessionError(content: string): string | undefined {
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed) as unknown;
		} catch {
			continue;
		}
		if (
			typeof parsed !== "object" || parsed === null ||
			typeof (parsed as { type?: unknown }).type !== "string" ||
			(parsed as { type?: string }).type !== "message"
		) {
			continue;
		}
		const message = (parsed as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message;
		if (message?.role === "assistant" && message.stopReason === "error" && message.errorMessage) {
			return message.errorMessage;
		}
	}
	return undefined;
}

function writeRunRecord(runDir: string, record: RunRecord): void {
	writeJsonArtifact(join(runDir, "run.json"), RunRecordSchema, record);
}

function privateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}

function writePrivateFile(path: string, content: string): void {
	writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
	chmodSync(path, 0o600);
}

const WORKSPACE_PRIVATE_COMPONENTS = new Set([".git", ".ahde", "evals", "runs"]);

function repositoryPathParts(path: string): string[] {
	if (!path || path.includes("\0") || isAbsolute(path)) {
		throw new Error(`unsafe git workspace path: ${JSON.stringify(path)}`);
	}
	const parts = path.split(/[\\/]/);
	if (parts.some((part) => !part || part === "." || part === "..")) {
		throw new Error(`unsafe git workspace path: ${JSON.stringify(path)}`);
	}
	return parts;
}

function normalizedRepositoryPath(path: string): string {
	return repositoryPathParts(path).join("/");
}

function containedRelativePath(root: string, candidate: string): string | null {
	const rel = relative(root, candidate);
	if (rel === "") return "";
	if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return null;
	return normalizedRepositoryPath(rel);
}

function isPrivateWorkspacePath(
	path: string,
	evaluationFiles: ReadonlySet<string>,
	nestedRunsRoot: string | null,
): boolean {
	const normalized = normalizedRepositoryPath(path);
	const parts = normalized.split("/");
	if (parts[0] === "imports") return true;
	if (parts.some((part) => WORKSPACE_PRIVATE_COMPONENTS.has(part))) return true;
	if (parts.some((part) => part === ".env" || (part.startsWith(".env.") && part !== ".env.example"))) {
		return true;
	}
	if (evaluationFiles.has(normalized)) return true;
	return nestedRunsRoot !== null && (normalized === nestedRunsRoot || normalized.startsWith(`${nestedRunsRoot}/`));
}

function regularSourceFile(
	sourceDir: string,
	path: string,
): { path: string; mode: number } | null {
	const parts = repositoryPathParts(path);
	let cursor = sourceDir;
	for (const [index, part] of parts.entries()) {
		cursor = join(cursor, part);
		let entry;
		try {
			entry = lstatSync(cursor);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		if (entry.isSymbolicLink()) {
			throw new Error(`isolated workspace path must not traverse a symlink: ${path}`);
		}
		const final = index === parts.length - 1;
		if ((!final && !entry.isDirectory()) || (final && !entry.isFile())) {
			throw new Error(`isolated workspace only accepts regular files and directory ancestors: ${path}`);
		}
		const canonical = realpathSync(cursor);
		if (containedRelativePath(sourceDir, canonical) === null) {
			throw new Error(`isolated workspace source escaped the target repository: ${path}`);
		}
		if (final) return { path: canonical, mode: entry.mode };
	}
	throw new Error(`isolated workspace could not resolve git path: ${path}`);
}

function targetSnapshotIdentity(target: ResolvedTarget): string {
	return hashValue({
		targetId: target.manifest.id,
		gitSha: target.gitSha,
		manifest: target.manifest,
		evaluationFiles: [...target.evaluationFiles].sort(),
		toolsetHash: target.toolsetHash,
		datasetHash: target.datasetHash,
		suiteHash: target.suiteHash,
	});
}

function targetSourceIdentity(target: ResolvedTarget): string {
	const manifestDataset = target.evaluationFiles[0] ?? target.manifest.evalSuite.dataset;
	return hashValue({
		gitSha: target.gitSha,
		manifest: {
			...target.manifest,
			evalSuite: { ...target.manifest.evalSuite, dataset: manifestDataset },
		},
		toolsetHash: target.toolsetHash,
	});
}

function assertTargetSourceIdentity(expected: ResolvedTarget, actual: ResolvedTarget, phase: string): void {
	if (targetSourceIdentity(actual) !== targetSourceIdentity(expected)) {
		throw new Error(`target changed ${phase} eval workspace snapshot materialization`);
	}
}

function workspaceTreeEntries(root: string, directory = root): Array<{
	path: string;
	mode: number;
	sha256: string;
}> {
	const entries: Array<{ path: string; mode: number; sha256: string }> = [];
	for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const path = join(directory, entry.name);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) throw new Error(`workspace snapshot contains a symlink: ${relative(root, path)}`);
		if (stat.isDirectory()) {
			entries.push(...workspaceTreeEntries(root, path));
			continue;
		}
		if (!stat.isFile()) throw new Error(`workspace snapshot contains a non-regular file: ${relative(root, path)}`);
		entries.push({
			path: normalizedRepositoryPath(relative(root, path)),
			mode: stat.mode & 0o777,
			sha256: hashFile(readFileSync(path).toString("base64")),
		});
	}
	return entries;
}

function workspaceTreeHash(root: string): string {
	return hashValue(workspaceTreeEntries(realpathSync(root)));
}

function copySnapshotTree(sourceRoot: string, destinationRoot: string, directory = sourceRoot): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const sourcePath = join(directory, entry.name);
		const relativePath = normalizedRepositoryPath(relative(sourceRoot, sourcePath));
		const destinationPath = resolve(destinationRoot, ...repositoryPathParts(relativePath));
		if (containedRelativePath(destinationRoot, destinationPath) === null) {
			throw new Error(`workspace snapshot destination escaped the run directory: ${relativePath}`);
		}
		const stat = lstatSync(sourcePath);
		if (stat.isSymbolicLink()) throw new Error(`workspace snapshot contains a symlink: ${relativePath}`);
		if (stat.isDirectory()) {
			mkdirSync(destinationPath, { recursive: true, mode: 0o700 });
			copySnapshotTree(sourceRoot, destinationRoot, sourcePath);
			continue;
		}
		if (!stat.isFile()) throw new Error(`workspace snapshot contains a non-regular file: ${relativePath}`);
		mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
		copyFileSync(sourcePath, destinationPath);
		chmodSync(destinationPath, stat.mode & 0o777);
	}
}

function copyGitVisibleWorkspace(target: ResolvedTarget, workspaceDir: string, runsRoot: string): void {
	const sourceDir = realpathSync(resolve(target.dir));
	const canonicalRunsRoot = realpathSync(resolve(runsRoot));
	const nestedRunsRoot = containedRelativePath(sourceDir, canonicalRunsRoot);
	if (nestedRunsRoot === "") {
		throw new Error("runsRoot must not be the target repository root in isolated mode");
	}
	const evaluationFiles = new Set(target.evaluationFiles.map(normalizedRepositoryPath));

	const listed = execFileSync(
		"git",
		["-C", sourceDir, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	for (const path of listed.split("\0").filter(Boolean)) {
		if (isPrivateWorkspacePath(path, evaluationFiles, nestedRunsRoot)) continue;
		const sourcePath = resolve(sourceDir, path);
		const sourceRelative = containedRelativePath(sourceDir, sourcePath);
		if (sourceRelative === null || sourceRelative === "") {
			throw new Error(`git workspace path escaped the target repository: ${path}`);
		}
		// A tracked deletion remains in the index but is intentionally absent
		// from the dirty working-tree snapshot.
		const sourceFile = regularSourceFile(sourceDir, sourceRelative);
		if (sourceFile === null) continue;
		const destinationPath = resolve(workspaceDir, ...repositoryPathParts(sourceRelative));
		if (containedRelativePath(workspaceDir, destinationPath) === null) {
			throw new Error(`git workspace destination escaped the run directory: ${path}`);
		}
		mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
		copyFileSync(sourceFile.path, destinationPath);
		chmodSync(destinationPath, sourceFile.mode & 0o777);
	}
}

/**
 * Capture the model-visible Target workspace once for an entire EvalRun.
 * The live target is re-resolved on both sides of the copy; a concurrent
 * change aborts before any model call receives the snapshot.
 */
export function materializeTargetWorkspaceSnapshot(
	target: ResolvedTarget,
	runsRoot: string,
): TargetWorkspaceSnapshot {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "ahde-eval-snapshot-"));
	chmodSync(temporaryRoot, 0o700);
	const destination = join(temporaryRoot, "source");
	privateDirectory(destination);
	try {
		copyGitVisibleWorkspace(target, destination, runsRoot);
		assertTargetSourceIdentity(target, loadTarget(target.dir), "during");
		const snapshot = Object.freeze({
			dir: realpathSync(destination),
			sha256: workspaceTreeHash(destination),
			targetIdentity: targetSnapshotIdentity(target),
		});
		trustedWorkspaceSnapshots.add(snapshot);
		workspaceSnapshotRoots.set(snapshot, temporaryRoot);
		return snapshot;
	} catch (error) {
		rmSync(temporaryRoot, { recursive: true, force: true });
		throw error;
	}
}

export function disposeTargetWorkspaceSnapshot(snapshot: TargetWorkspaceSnapshot): void {
	if (!trustedWorkspaceSnapshots.delete(snapshot)) {
		throw new Error("refusing to dispose an untrusted eval workspace snapshot");
	}
	const temporaryRoot = workspaceSnapshotRoots.get(snapshot);
	workspaceSnapshotRoots.delete(snapshot);
	if (!temporaryRoot) throw new Error("eval workspace snapshot cleanup root is missing");
	rmSync(temporaryRoot, { recursive: true, force: true });
}

/** Resolve the exact model-visible Target workspace identity without running a model. */
export function computeTargetWorkspaceHash(target: ResolvedTarget, runsRoot: string): string {
	const snapshot = materializeTargetWorkspaceSnapshot(target, runsRoot);
	try {
		return snapshot.sha256;
	} finally {
		disposeTargetWorkspaceSnapshot(snapshot);
	}
}

/**
 * Materialize only the git-visible working tree into the isolated workspace.
 * Ignored state/secrets never participate in target provenance and therefore
 * must never become model-readable input. Explicit eval files are subtracted
 * even when a target stores them outside the conventional evals/ directory.
 */
function prepareWorkspace(
	target: ResolvedTarget,
	runDir: string,
	mode: RunTaskOptions["workspaceMode"],
	snapshot?: TargetWorkspaceSnapshot,
): string {
	if (mode === "direct") {
		if (snapshot) throw new Error("direct workspace mode cannot use an eval workspace snapshot");
		return target.dir;
	}

	const workspaceDir = join(runDir, "workspace");
	privateDirectory(workspaceDir);
	if (!snapshot) {
		copyGitVisibleWorkspace(target, workspaceDir, resolve(runDir, ".."));
		return workspaceDir;
	}
	if (!trustedWorkspaceSnapshots.has(snapshot)) throw new Error("untrusted eval workspace snapshot");
	if (snapshot.targetIdentity !== targetSnapshotIdentity(target)) {
		throw new Error("eval workspace snapshot belongs to a different Target revision");
	}
	if (workspaceTreeHash(snapshot.dir) !== snapshot.sha256) {
		throw new Error("eval workspace snapshot changed before task materialization");
	}
	copySnapshotTree(snapshot.dir, workspaceDir);
	if (workspaceTreeHash(snapshot.dir) !== snapshot.sha256 || workspaceTreeHash(workspaceDir) !== snapshot.sha256) {
		throw new Error("eval workspace snapshot changed during task materialization");
	}
	return workspaceDir;
}

/**
 * Run one task on the target harness. Never throws for task-level failures —
 * the returned RunRecord carries status "error" with a message instead.
 */
export async function runTask(target: ResolvedTarget, task: ResolvedTask, options: RunTaskOptions): Promise<RunRecord> {
	if (options.signal?.aborted) throw options.signal.reason ?? new Error("run aborted");
	const runId = newRunId();
	const runDir = join(options.runsRoot, runId);
	const runtimeDir = join(runDir, "runtime");
	const agentDir = join(runtimeDir, "agent");
	privateDirectory(runDir);
	privateDirectory(runtimeDir);
	privateDirectory(agentDir);
	const executionCwd = prepareWorkspace(target, runDir, options.workspaceMode, options.workspaceSnapshot);
	const workspaceHash = (options.workspaceMode ?? "isolated") === "isolated"
		? workspaceTreeHash(executionCwd)
		: undefined;
	const scratchDir = join(runtimeDir, "sandbox");
	let policyResult: ExecutionPolicyResult | undefined;
	let targetToolRuntime: TargetToolRuntime | undefined;
	let policyError: unknown;
	try {
		policyResult = buildExecutionPolicy({
			workspaceDir: executionCwd,
			scratchDir,
			policy: target.manifest.execution,
			environment: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				LANG: process.env.LANG ?? "C.UTF-8",
				HOME: join(scratchDir, "home"),
				TMPDIR: join(scratchDir, "tmp"),
			},
		});
		targetToolRuntime = createTargetToolRuntime({
			target,
			workspaceDir: executionCwd,
			scratchDir,
		});
	} catch (error) {
		policyError = error;
	}
	const capabilityToolNames = [
		...target.manifest.execution.tools,
		...(targetToolRuntime?.toolNames ?? target.tools.map((tool) => tool.descriptor.name)),
	];
	const effectiveSandbox = target.tools.length > 0
		? targetToolRuntime?.sandboxBackend ?? "unavailable"
		: policyResult?.sandboxBackend ?? "unavailable";
	const effectiveFilesystem = targetFilesystemConfinement({
		workspaceMode: options.workspaceMode ?? "isolated",
		toolNames: capabilityToolNames,
		sandbox: effectiveSandbox,
	});

	const model = target.manifest.model;
	const record: RunRecord = {
		schemaVersion: 1,
		runId,
		taskId: task.id,
		repetitionIndex: options.repetitionIndex,
		label: options.label,
		status: "running",
		error: null,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		target: {
			id: target.manifest.id,
			gitSha: target.gitSha,
			toolsetHash: target.toolsetHash,
			...(workspaceHash ? { workspaceHash } : {}),
		},
		runtime: { ...target.runtime },
		model: modelFingerprint(model),
		execution: executionFingerprint(options.workspaceMode ?? "isolated", {
			// Declarative tools are versioned Harness resources. Their exact
			// descriptors/executables live in target.toolsetHash so a candidate
			// may intentionally change them without falsifying runtime-policy
			// comparability. This list is only the fixed host capability policy.
			tools: target.manifest.execution.tools,
			environment:
				policyResult
					? [...policyResult.effectiveEnvironmentNames].sort()
					: ["HOME", "LANG", "PATH", "TMPDIR", ...target.manifest.execution.environmentAllowlist].sort(),
			sandbox: effectiveSandbox,
			network: target.manifest.execution.network,
			filesystem: effectiveFilesystem,
		}),
		eval: {
			suiteId: target.manifest.evalSuite.id,
			suiteHash: target.suiteHash,
			dataset: target.manifest.evalSuite.dataset.replace(/\.jsonl$/, "").split("/").pop() ?? "dataset",
			datasetHash: target.datasetHash,
		},
		trace: { path: "session.jsonl", sessionId: null, sha256: null },
		metrics: emptyMetrics(),
		evalResults: null,
		parent: options.evalRunId
			? { evalRunId: options.evalRunId, candidateOf: options.candidateOf }
			: null,
	};

	// Crash-tolerant: provenance is on disk before any model call.
	writeRunRecord(runDir, record);
	const eventRun: RunEventIdentity = {
		evalRunId: options.evalRunId,
		runId,
		taskId: task.id,
		repetitionIndex: options.repetitionIndex,
		ordinal: options.ordinal ?? 1,
		total: options.total ?? 1,
	};
	emitRunStarted(options.onRunEvent, eventRun);

	const startedMs = Date.now();
	let session: AgentSession | undefined;
	let unsubscribeSessionEvents: (() => void) | undefined;
	let removeAbortListener: (() => void) | undefined;
	let recoveryAttempts = 0;
	try {
		if (!policyResult || !targetToolRuntime) {
			throw new Error(
				`execution policy unavailable: ${policyError instanceof Error ? policyError.message : String(policyError)}`,
			);
		}
		// Per-run isolation: fresh models.json + credentials + services.
		const modelsPath = join(runtimeDir, "models.json");
		writePrivateFile(modelsPath, `${JSON.stringify(generateModelsJson(model), null, "\t")}\n`);
		const scopedApiKey = process.env[model.apiKeyEnv];
		if (model.baseUrl.includes("openrouter.ai") && !scopedApiKey) {
			throw new Error(`missing ${model.apiKeyEnv} for OpenRouter endpoint ${model.baseUrl}`);
		}
		const created = await createTargetAgentSession({
			target,
			cwd: executionCwd,
			agentDir,
			runDir,
			modelsPath,
			executionPolicy: policyResult,
			targetTools: targetToolRuntime,
			// This is the only secret value Target Pi receives. The credential is
			// memory-only and is never written to models.json/session evidence.
			apiKey: scopedApiKey ?? "unset",
		});
		session = created.session;
		if (options.signal) {
			const abortSession = () => { void session?.abort(); };
			options.signal.addEventListener("abort", abortSession, { once: true });
			removeAbortListener = () => options.signal?.removeEventListener("abort", abortSession);
			if (options.signal.aborted) abortSession();
		}
		const sessionManager = created.sessionManager;
		unsubscribeSessionEvents = session.subscribe(
			(event) => observeRunSessionEvent(options.onRunEvent, eventRun, event),
		);

		// Watchdog: prompt() has no deadline of its own.
		let timedOut = false;
		const watchdog = setTimeout(() => {
			timedOut = true;
			void session?.abort();
		}, model.timeoutMs);

		let finalAssistant;
		try {
			await session.prompt(task.input);
			if (options.signal?.aborted) throw options.signal.reason ?? new Error("run aborted");
			if (timedOut) throw new Error(`run timed out after ${model.timeoutMs}ms`);

			finalAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
			const hasToolResults = session.messages.some((message) => message.role === "toolResult");
			if (finalAssistant?.stopReason === "stop" && !session.getLastAssistantText()?.trim() && hasToolResults) {
				recoveryAttempts = 1;
				const activeTools = session.agent.state.tools;
				session.agent.state.tools = [];
				try {
					await session.prompt(FINAL_ANSWER_RECOVERY_PROMPT);
				} finally {
					session.agent.state.tools = activeTools;
				}
				if (options.signal?.aborted) throw options.signal.reason ?? new Error("run aborted");
				if (timedOut) throw new Error(`run timed out after ${model.timeoutMs}ms`);
				finalAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
			}
		} finally {
			clearTimeout(watchdog);
		}

		if (!finalAssistant) throw new Error("agent run completed without an assistant message");
		if (finalAssistant.stopReason !== "stop") {
			throw new Error(
				finalAssistant.errorMessage ?? `agent run ended with unexpected stop reason: ${finalAssistant.stopReason}`,
			);
		}
		// The answer must be text in the final assistant message. Reusing text
		// from an earlier pre-tool turn would turn an incomplete run into false
		// evidence.
		const answerText = finalAssistant.content
			.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map((content) => content.text)
			.join("");
		if (!answerText) throw new Error("agent run produced no assistant text");

		// Pin the session file to its canonical name inside the run dir.
		const sessionFile = sessionManager.getSessionFile();
		if (sessionFile) {
			renameSync(sessionFile, join(runDir, "session.jsonl"));
			chmodSync(join(runDir, "session.jsonl"), 0o600);
		}

		const stats = session.getSessionStats();
			const sessionContent = readTraceArtifact(runDir);
			const sessionError = extractSessionError(sessionContent);
			if (sessionError) throw new Error(sessionError);
			const toolErrors = traceToolErrors(
				// parse lazily through trace.ts to keep a single format owner
				(await import("./trace.js")).parseSessionJsonl(sessionContent),
		);

		record.status = "completed";
		record.finishedAt = new Date().toISOString();
		record.trace = {
			path: "session.jsonl",
			sessionId: stats.sessionId,
			sha256: hashFile(sessionContent),
		};
		record.metrics = {
			tokens: {
				input: stats.tokens.input,
				output: stats.tokens.output,
				cacheRead: stats.tokens.cacheRead,
				cacheWrite: stats.tokens.cacheWrite,
				total: stats.tokens.total,
			},
			costUsd: stats.cost,
			latencyMs: Date.now() - startedMs,
			toolCalls: stats.toolCalls,
			toolErrors,
			recoveryAttempts,
		};
	} catch (error) {
		record.status = "error";
		record.finishedAt = new Date().toISOString();
		record.error = error instanceof Error ? error.message : String(error);
		record.metrics = { ...record.metrics, latencyMs: Date.now() - startedMs, recoveryAttempts };
		// Best effort: keep whatever trace survived.
		try {
			const files = execFileSync("find", [runDir, "-name", "*.jsonl", "-maxdepth", "1"], { encoding: "utf8" })
				.trim()
				.split("\n")
				.filter(Boolean);
			const sessionFile = files[0];
			if (sessionFile && sessionFile.endsWith(".jsonl")) {
				if (!sessionFile.endsWith("session.jsonl")) renameSync(sessionFile, join(runDir, "session.jsonl"));
				chmodSync(join(runDir, "session.jsonl"), 0o600);
				const content = readTraceArtifact(runDir);
				record.trace = { path: "session.jsonl", sessionId: null, sha256: hashFile(content) };
			}
		} catch {
			// no trace survived
		}
	} finally {
		removeAbortListener?.();
		try {
			unsubscribeSessionEvents?.();
		} catch {
			// Listener teardown during error paths is best-effort.
		}
		try {
			session?.dispose();
		} catch {
			// dispose during error paths is best-effort
		}
	}

	writeRunRecord(runDir, record);
	emitExecutionFinished(options.onRunEvent, eventRun, record);
	return record;
}
