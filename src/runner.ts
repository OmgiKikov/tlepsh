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
import {
	executionKindOf,
	loadTarget,
	type ResolvedTarget,
	type ResolvedTask,
	type TargetManifest,
} from "./manifest.js";
import {
	executionFingerprint,
	hashFile,
	hashValue,
	modelFingerprint,
	RunRecordSchema,
	type RunRecord,
} from "./provenance.js";
import { writeJsonArtifact } from "./storage/artifacts.js";
import { resolveContainedArtifactPath } from "./storage/paths.js";
import { WORLD_STATE_SEGMENTS } from "./target/world-state.js";
import { readTraceArtifact, traceToolErrors, type TranscriptTurn } from "./trace.js";
import { EvaluatorModelError, type EvaluatorModelMetrics } from "./evaluator-model.js";
import { nextSimulatedUserTurn, simulatedUserStop, type SimulatedUserStop } from "./simulated-user.js";

function addSpend(total: EvaluatorModelMetrics, spent: EvaluatorModelMetrics): void {
	total.calls += spent.calls;
	total.tokens += spent.tokens;
	total.costUsd += spent.costUsd;
}
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
	composeSetupDerivedToolHash,
	createTargetToolRuntime,
	effectiveTargetSandbox,
	targetFilesystemConfinement,
	type TargetToolRuntime,
} from "./target/runtime.js";
import { preparedToolHomeHash as hashPreparedToolHome } from "./target/tool-setup.js";
import { commandTargetEnvironmentNames, createCommandTargetSession } from "./target/session-command.js";
import { createPiTargetSession } from "./target/session-pi.js";
import { FINAL_ANSWER_RECOVERY_PROMPT, type TargetSession, type TargetSessionStats } from "./target/session.js";

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
	/**
	 * Private home shared by every run of this snapshot. Multi-file tools are
	 * materialized there and their declared setup step runs once for the whole
	 * EvalRun; nothing it produces re-enters the hashed workspace.
	 */
	readonly toolHomeDir: string;
	/**
	 * The setup-derived tool identity: the prepared home's tree attestation
	 * folded with `kbIndexHash`. Null only when a caller requested a source-only
	 * snapshot.
	 */
	readonly preparedToolHomeHash: string | null;
	/**
	 * Identity of the knowledge-base index this snapshot serves, or null when it
	 * declares none. Held beside the tree hash because re-verifying the
	 * attestation means recomposing it, and the chunk index is not a file in the
	 * prepared home.
	 */
	readonly kbIndexHash: string | null;
}

const trustedWorkspaceSnapshots = new WeakSet<TargetWorkspaceSnapshot>();
const workspaceSnapshotRoots = new WeakMap<TargetWorkspaceSnapshot, string>();

/** Re-exported from the session seam, where both backends now send it. */
export { FINAL_ANSWER_RECOVERY_PROMPT };

/**
 * Concurrent runs routinely start inside the same millisecond, and two runs
 * sharing an id would share a directory and destroy each other's evidence. The
 * counter guarantees uniqueness within this process; the random suffix keeps
 * ids unique across processes writing to the same runs root.
 */
let runSequence = 0;

/** The one run-id minter. `ahde regrade` shares it so a derived run cannot collide. */
export function newRunId(): string {
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

/**
 * The metrics a record starts with. A command Target begins with usage ABSENT
 * rather than zero: if the run then fails before the agent reports anything,
 * the record must say nobody measured, not that the run was free.
 */
function emptyMetrics(agent: RunRecord["execution"]["agent"] = "pi-v1"): RunRecord["metrics"] {
	return {
		...(agent === "command-v1"
			? {}
			: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, costUsd: 0 }),
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

/**
 * Whether one repository-relative path is host-private and must never reach a
 * model-visible workspace snapshot. Exported so the rule can be pinned
 * directly: it is the boundary between what the operator wrote and what AHDE
 * put in their working tree.
 */
export function isPrivateWorkspacePath(
	path: string,
	evaluationFiles: ReadonlySet<string>,
	nestedRunsRoot: string | null,
	dataDirectories: readonly string[],
): boolean {
	const normalized = normalizedRepositoryPath(path);
	const parts = normalized.split("/");
	if (parts[0] === "imports") return true;
	// The recorded dataset `ahde export` writes beside the Target. It is
	// compiled FROM evidence, so letting it back into a workspace snapshot would
	// feed a run its own past conversations and move the workspace hash every
	// time an operator exported. Top-level only, exactly like `imports/`.
	if (parts[0] === "exports") return true;
	// `data/` is a declared scope: undeclared data never reaches a Target.
	if (parts[0] === "data" && !dataDirectories.some((declared) => normalized.startsWith(`${declared}/`))) {
		return true;
	}
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
	const dataDirectories = target.manifest.data.map(normalizedRepositoryPath);

	const listed = execFileSync(
		"git",
		["-C", sourceDir, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	for (const path of listed.split("\0").filter(Boolean)) {
		if (isPrivateWorkspacePath(path, evaluationFiles, nestedRunsRoot, dataDirectories)) continue;
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
	options: { prepareToolHome?: boolean } = {},
): TargetWorkspaceSnapshot {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "ahde-eval-snapshot-"));
	chmodSync(temporaryRoot, 0o700);
	const destination = join(temporaryRoot, "source");
	privateDirectory(destination);
	try {
		copyGitVisibleWorkspace(target, destination, runsRoot);
		assertTargetSourceIdentity(target, loadTarget(target.dir), "during");
		const toolHomeDir = join(temporaryRoot, "tool-home");
		privateDirectory(toolHomeDir);
		let preparedToolHomeHash: string | null = null;
		let kbIndexHash: string | null = null;
		if (options.prepareToolHome) {
			const preparationScratch = join(temporaryRoot, "preparation-sandbox");
			try {
				const runtime = createTargetToolRuntime({
					target,
					workspaceDir: destination,
					scratchDir: preparationScratch,
					toolHomeRoot: toolHomeDir,
				});
				kbIndexHash = runtime.kbIndexHash;
				preparedToolHomeHash = composeSetupDerivedToolHash(hashPreparedToolHome(toolHomeDir), kbIndexHash);
				if (preparedToolHomeHash !== runtime.preparedToolHomeHash) {
					throw new Error("prepared tool-home attestation does not match its materialized bytes");
				}
			} finally {
				rmSync(preparationScratch, { recursive: true, force: true });
			}
			assertTargetSourceIdentity(target, loadTarget(target.dir), "after tool-home preparation for");
		}
		const snapshot = Object.freeze({
			dir: realpathSync(destination),
			sha256: workspaceTreeHash(destination),
			targetIdentity: targetSnapshotIdentity(target),
			toolHomeDir: realpathSync(toolHomeDir),
			preparedToolHomeHash,
			kbIndexHash,
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
	let verificationError: Error | undefined;
	try {
		if (
			snapshot.preparedToolHomeHash !== null &&
			composeSetupDerivedToolHash(hashPreparedToolHome(snapshot.toolHomeDir), snapshot.kbIndexHash) !==
				snapshot.preparedToolHomeHash
		) {
			verificationError = new Error("prepared tool-home snapshot changed before cleanup");
		}
	} catch (error) {
		verificationError = error instanceof Error ? error : new Error(String(error));
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
	if (verificationError) throw verificationError;
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

/** Reproduce the complete source + setup-derived Target identity without a model call. */
export function computeTargetSnapshotHashes(
	target: ResolvedTarget,
	runsRoot: string,
): { workspaceHash: string; preparedToolHomeHash: string } {
	const snapshot = materializeTargetWorkspaceSnapshot(target, runsRoot, { prepareToolHome: true });
	try {
		if (snapshot.preparedToolHomeHash === null) {
			throw new Error("prepared Target snapshot has no tool-home attestation");
		}
		return {
			workspaceHash: snapshot.sha256,
			preparedToolHomeHash: snapshot.preparedToolHomeHash,
		};
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
	if (
		snapshot.preparedToolHomeHash !== null &&
		composeSetupDerivedToolHash(hashPreparedToolHome(snapshot.toolHomeDir), snapshot.kbIndexHash) !==
			snapshot.preparedToolHomeHash
	) {
		throw new Error("prepared tool-home snapshot changed before task materialization");
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
	// The world lives beside the sandbox, never inside `workspace/`: the
	// workspace hash and the shared per-EvalRun snapshot are the Target's
	// identity (invariant 19), and a case's starting state is not part of it.
	// The directory is created now, before any sandbox profile is built, because
	// a profile names concrete paths and bwrap binds them; the state itself is
	// written below, once the run record is on disk.
	const worldPath = task.world
		? resolveContainedArtifactPath(options.runsRoot, runId, ...WORLD_STATE_SEGMENTS)
		: undefined;
	if (worldPath) privateDirectory(dirname(worldPath));
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
			// One prepared tool home per EvalRun snapshot: a declared setup step
			// runs once for the whole suite, not once per task × repetition. A
			// failure here is infrastructure — the record below records "error".
			...(options.workspaceSnapshot ? { toolHomeRoot: options.workspaceSnapshot.toolHomeDir } : {}),
			...(worldPath ? { worldPath } : {}),
		});
		if (
			options.workspaceSnapshot?.preparedToolHomeHash !== null &&
			options.workspaceSnapshot?.preparedToolHomeHash !== undefined &&
			targetToolRuntime.preparedToolHomeHash !== options.workspaceSnapshot.preparedToolHomeHash
		) {
			throw new Error("prepared tool-home snapshot changed before run initialization");
		}
	} catch (error) {
		policyError = error;
	}
	const capabilityToolNames = [
		...target.manifest.execution.tools,
		...(targetToolRuntime?.toolNames ?? target.tools.map((tool) => tool.descriptor.name)),
	];
	const effectiveSandbox = effectiveTargetSandbox({
		hasDeclaredTools: target.tools.length > 0,
		...(policyResult ? { executionPolicy: policyResult } : {}),
		...(targetToolRuntime ? { targetTools: targetToolRuntime } : {}),
	});
	const effectiveFilesystem = targetFilesystemConfinement({
		workspaceMode: options.workspaceMode ?? "isolated",
		toolNames: capabilityToolNames,
		sandbox: effectiveSandbox,
	});

	const model = target.manifest.model;
	/** Which backend answers. Recorded so a Pi arm and a command arm never compare. */
	const agent = executionKindOf(target.manifest.execution) === "command" ? "command-v1" : "pi-v1";
	const preparedToolHomeHash = targetToolRuntime?.preparedToolHomeHash
		?? options.workspaceSnapshot?.preparedToolHomeHash
		?? undefined;
	// A dialogue case ends in the user turn `input` repeats, so the turns before
	// it are the conversation to seed and the last one stays the graded prompt.
	const seededTurns = task.messages ? task.messages.slice(0, -1) : [];
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
			...(preparedToolHomeHash ? { preparedToolHomeHash } : {}),
		},
		runtime: { ...target.runtime },
		model: modelFingerprint(model),
		execution: executionFingerprint(options.workspaceMode ?? "isolated", {
			// Declarative tools are versioned Harness resources. Their exact
			// descriptors/executables live in target.toolsetHash so a candidate
			// may intentionally change them without falsifying runtime-policy
			// comparability. This list is only the fixed host capability policy.
			tools: target.manifest.execution.tools,
			// What the process that answers actually receives. A command Target's
			// child is not the Pi execution policy's process: it gets the fixed
			// four, the readable half of the manifest allowlist, the credential
			// under its own name, `AHDE_PROTOCOL`, and `AHDE_WORLD` when the case
			// has a world. Recording the policy's list there under-reported the
			// receipt by three names (session 7, defect 19).
			environment: agent === "command-v1"
				? commandTargetEnvironmentNames({
					environmentAllowlist: target.manifest.execution.environmentAllowlist,
					apiKeyEnv: model.apiKeyEnv,
					hasWorld: Boolean(worldPath),
				})
				: policyResult
					? [...policyResult.effectiveEnvironmentNames].sort()
					: ["HOME", "LANG", "PATH", "TMPDIR", ...target.manifest.execution.environmentAllowlist].sort(),
			sandbox: effectiveSandbox,
			network: target.manifest.execution.network,
			filesystem: effectiveFilesystem,
			agent,
		}),
		eval: {
			suiteId: target.manifest.evalSuite.id,
			suiteHash: target.suiteHash,
			dataset: target.manifest.evalSuite.dataset.replace(/\.jsonl$/, "").split("/").pop() ?? "dataset",
			datasetHash: target.datasetHash,
		},
		trace: { path: "session.jsonl", sessionId: null, sha256: null },
		metrics: { ...emptyMetrics(agent), ...(task.messages ? { seededTurns: seededTurns.length } : {}) },
		evalResults: null,
		parent: options.evalRunId
			? { evalRunId: options.evalRunId, candidateOf: options.candidateOf }
			: null,
	};

	// Crash-tolerant: provenance is on disk before any model call.
	writeRunRecord(runDir, record);
	// The world exists before the Target does. A tool that reads `AHDE_WORLD` on
	// the agent's very first turn must find the state the case declared, not an
	// empty file, and the state a run ends with is evidence, so it is written
	// once, here, and never again by the host.
	if (task.world && worldPath) {
		writePrivateFile(worldPath, `${JSON.stringify(task.world.state, null, "\t")}\n`);
	}
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
	let session: TargetSession | undefined;
	let unsubscribeSessionEvents: (() => void) | undefined;
	let removeAbortListener: (() => void) | undefined;
	let recoveryAttempts = 0;
	// A simulated conversation is ONE Run with ONE session.jsonl: every user turn
	// is appended to the Target's own session exactly as a human's would be, so
	// trace.ts stays the single parser and nothing downstream learns a format.
	const simulated = task.simulatedUser;
	const userModel = target.manifest.evalSuite.simulatedUser;
	const maxTurns = simulated?.maxTurns ?? 1;
	const transcript: TranscriptTurn[] = [];
	const simulatedUserSpend = { calls: 0, tokens: 0, costUsd: 0 };
	// Reaching the budget is the default ending; the user model can end it sooner.
	let conversationStop: SimulatedUserStop = "max-turns";
	let conversationTurns = 0;
	try {
		if (!policyResult || !targetToolRuntime) {
			throw new Error(
				`execution policy unavailable: ${policyError instanceof Error ? policyError.message : String(policyError)}`,
			);
		}
		// loadTarget already fails closed on this; a hand-built ResolvedTask can
		// still arrive here, and a silently one-turn "conversation" would be
		// evidence about a dialogue that never happened.
		if (simulated && !userModel) {
			throw new Error("simulated-user case without evalSuite.simulatedUser model config");
		}
		const scopedApiKey = process.env[model.apiKeyEnv];
		if (model.baseUrl.includes("openrouter.ai") && !scopedApiKey) {
			throw new Error(`missing ${model.apiKeyEnv} for OpenRouter endpoint ${model.baseUrl}`);
		}
		// Counted the moment a recovery is decided, not when it succeeds: an
		// attempt that then fails is still an attempt the error path records.
		const onRecoveryAttempt = () => {
			recoveryAttempts += 1;
		};
		if (agent === "command-v1") {
			// Protocol v1 has one way to give the Target a message and it is a
			// `user` line. A seeded dialogue would have to arrive as invented
			// history, and history the agent never produced is not evidence.
			if (seededTurns.length > 0) {
				throw new Error("command Target cannot replay a dialogue case's seeded turns: protocol v1 carries no history");
			}
			const command = await createCommandTargetSession({
				target,
				workspaceDir: executionCwd,
				scratchDir,
				runDir,
				targetTools: targetToolRuntime,
				// The only secret the child receives, and it arrives in its
				// environment under the manifest's own `apiKeyEnv` name.
				apiKey: scopedApiKey ?? "unset",
				timeoutMs: model.timeoutMs,
				// This lane passes the path; the world lane writes the file.
				worldPath: task.world
					? resolveContainedArtifactPath(options.runsRoot, runId, "runtime", "world", "state.json")
					: null,
				onRecoveryAttempt,
				...(options.signal ? { signal: options.signal } : {}),
			});
			session = command.session;
			// Rehashed at spawn, exactly as a declared tool's executable is: the
			// bytes that ran are the identity, not the bytes resolution saw.
			record.target = { ...record.target, agentEntryHash: command.agentEntryHash };
		} else {
			// Per-run isolation: fresh models.json + credentials + services.
			const modelsPath = join(runtimeDir, "models.json");
			writePrivateFile(modelsPath, `${JSON.stringify(generateModelsJson(model), null, "\t")}\n`);
			session = await createPiTargetSession({
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
				seedMessages: seededTurns,
				timeoutMs: model.timeoutMs,
				onRecoveryAttempt,
				...(options.signal ? { signal: options.signal } : {}),
			});
		}
		if (options.signal) {
			const abortSession = () => { session?.abort(); };
			options.signal.addEventListener("abort", abortSession, { once: true });
			removeAbortListener = () => options.signal?.removeEventListener("abort", abortSession);
			if (options.signal.aborted) abortSession();
		}
		unsubscribeSessionEvents = session.subscribe(
			(event) => observeRunSessionEvent(options.onRunEvent, eventRun, event),
		);

		let prompt = task.input;
		for (let turn = 1; turn <= maxTurns; turn += 1) {
			transcript.push({ role: "user", text: prompt });
			const { text: turnText } = await session.takeTurn(prompt);
			conversationTurns = turn;
			transcript.push({ role: "assistant", text: turnText });
			// The last turn needs no next question: asking for one would spend a
			// user-model call on a message no agent will ever read.
			if (!simulated || !userModel || turn === maxTurns) break;
			// A user-model failure throws out of here into the catch below, where it
			// becomes status "error" — infrastructure, never a behavioural failure
			// (invariant 9). It says nothing about the agent. What it already spent
			// is billed on the way past, because exhausted retries are real money.
			let next;
			try {
				next = await nextSimulatedUserTurn({
					spec: simulated,
					model: userModel,
					turns: transcript,
					nextTurn: turn + 1,
					runDir,
					...(options.signal ? { signal: options.signal } : {}),
				});
			} catch (error) {
				if (error instanceof EvaluatorModelError) addSpend(simulatedUserSpend, error.metrics);
				throw error;
			}
			addSpend(simulatedUserSpend, next.metrics);
			const stop = simulatedUserStop(simulated, next.reply);
			if (stop) {
				conversationStop = stop;
				break;
			}
			prompt = next.reply.message;
		}

		session.finalizeTrace(runDir);

		const stats = session.stats();
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
			// Spread, never defaulted: a backend that reported no usage records
			// ABSENT. Zero would say the run was free.
			...(stats.tokens ? { tokens: { ...stats.tokens } } : {}),
			...(stats.costUsd === null ? {} : { costUsd: stats.costUsd }),
			latencyMs: Date.now() - startedMs,
			toolCalls: stats.toolCalls,
			toolErrors,
			recoveryAttempts,
			...(task.messages ? { seededTurns: seededTurns.length } : {}),
			// Absent on every case without a simulated user, so their run.json
			// stays byte-for-byte what it was before simulated users existed.
			...(simulated
				? {
					simulatedUser: { ...simulatedUserSpend },
					conversationTurns,
					conversationStop,
				}
				: {}),
		};
	} catch (error) {
		record.status = "error";
		record.finishedAt = new Date().toISOString();
		record.error = error instanceof Error ? error.message : String(error);
		// What the session actually did before it ended. A run that timed out
		// after brokering two tool calls made two tool calls: leaving the record
		// at zero made `/traces`, the trace header and `run.json` all say "0"
		// while the trace beside them showed the calls (session 7, defect 7).
		let observed: TargetSessionStats | null = null;
		try {
			observed = session?.stats() ?? null;
		} catch {
			// A backend that cannot report is a backend that reports nothing.
		}
		record.metrics = {
			...record.metrics,
			// Usage the backend did report before it failed is real spend, and an
			// absent one stays ABSENT: zero would say the run was free.
			...(observed?.tokens ? { tokens: { ...observed.tokens } } : {}),
			...(observed && observed.costUsd !== null ? { costUsd: observed.costUsd } : {}),
			latencyMs: Date.now() - startedMs,
			toolCalls: observed?.toolCalls ?? record.metrics.toolCalls,
			recoveryAttempts,
			// Spend already incurred is spend, even on a run that then failed.
			...(simulated ? { simulatedUser: { ...simulatedUserSpend } } : {}),
		};
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
			await session?.close();
		} catch {
			// close during error paths is best-effort
		}
	}

	writeRunRecord(runDir, record);
	emitExecutionFinished(options.onRunEvent, eventRun, record);
	return record;
}
