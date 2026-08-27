import {
	chmodSync,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	InteractiveMode,
	SessionManager,
	createAgentSessionRuntime,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type InteractiveModeOptions,
} from "@earendil-works/pi-coding-agent";
import { buildExecutionPolicy } from "../execution-policy.js";
import type { ResolvedTarget } from "../manifest.js";
import { canonicalJson, hashFile, hashValue } from "../provenance.js";
import {
	disposeTargetWorkspaceSnapshot,
	generateModelsJson,
	materializeTargetWorkspaceSnapshot,
	type TargetWorkspaceSnapshot,
} from "../runner.js";
import {
	createTargetAgentSession,
	createTargetToolRuntime,
	loadTargetResourceBundle,
} from "./runtime.js";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
const INTERACTIVE_PROCESS_ENV_NAMES = [
	"PATH",
	"LANG",
	"LC_ALL",
	"TERM",
	"COLORTERM",
	"NO_COLOR",
	"FORCE_COLOR",
] as const;

export interface TargetInteractiveMode {
	run(): Promise<void>;
	stop?(): void;
}

export type TargetInteractiveModeFactory = (
	runtime: AgentSessionRuntime,
	options: InteractiveModeOptions,
) => TargetInteractiveMode;

/** Small host seam so tests do not need to manufacture a process TTY. */
export interface TargetInteractiveTtyAdapter {
	stdinIsTTY(): boolean;
	stdoutIsTTY(): boolean;
}

export interface RunInteractiveTargetOptions {
	/** Optional first user turn, submitted by Pi after the TUI is initialized. */
	initialMessage?: string;
	/** Host environment used only for the declared Target policy and apiKeyEnv lookup. */
	environment?: NodeJS.ProcessEnv;
}

/** @internal Process-local seams used by the dedicated entry point and focused tests. */
export interface RunInteractiveTargetProcessOptions extends RunInteractiveTargetOptions {
	/** @internal Injectable Pi mode constructor for focused host tests. */
	modeFactory?: TargetInteractiveModeFactory;
	/** @internal Injectable TTY probe for focused host tests. */
	tty?: TargetInteractiveTtyAdapter;
	/** @internal Parent-materialized, content-addressed workspace used by the production child. */
	workspaceSnapshot?: Pick<TargetWorkspaceSnapshot, "dir" | "sha256">;
}

/** Every resolved field that binds the parent-selected Target. */
export type InteractiveTargetIdentity = Readonly<{
	dir: string;
	manifest: ResolvedTarget["manifest"];
	evaluationFiles: string[];
	gitSha: string;
	runtime: ResolvedTarget["runtime"];
	tools: ResolvedTarget["tools"];
	toolsetHash: string;
	tasks: ResolvedTarget["tasks"];
	datasetHash: string;
	suiteHash: string;
}>;

/** @internal One-shot IPC payload sent only after the loader-safe child has started. */
export interface InteractiveTargetProcessLaunch {
	protocol: 1;
	targetDir: string;
	targetIdentity: InteractiveTargetIdentity;
	workspaceSnapshot: Pick<TargetWorkspaceSnapshot, "dir" | "sha256">;
	environment: NodeJS.ProcessEnv;
	initialMessage?: string;
}

const processTty: TargetInteractiveTtyAdapter = {
	stdinIsTTY: () => process.stdin.isTTY === true,
	stdoutIsTTY: () => process.stdout.isTTY === true,
};

const interactiveModeFactory: TargetInteractiveModeFactory = (runtime, options) =>
	new InteractiveMode(runtime, options);

function privateDirectory(path: string): string {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
	return realpathSync(path);
}

function writePrivateFile(path: string, content: string): void {
	writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
	chmodSync(path, 0o600);
}

function makeTreeRemovable(path: string): void {
	let stat;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) return;
	chmodSync(path, 0o700);
	for (const entry of readdirSync(path)) makeTreeRemovable(join(path, entry));
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
		const relativePath = relative(root, path).split(sep).join("/");
		if (stat.isSymbolicLink()) throw new Error(`interactive workspace snapshot contains a symlink: ${relativePath}`);
		if (stat.isDirectory()) {
			entries.push(...workspaceTreeEntries(root, path));
			continue;
		}
		if (!stat.isFile()) throw new Error(`interactive workspace snapshot contains a non-regular file: ${relativePath}`);
		entries.push({
			path: relativePath,
			mode: stat.mode & 0o777,
			sha256: hashFile(readFileSync(path).toString("base64")),
		});
	}
	return entries;
}

/** @internal Verify the parent-owned snapshot before any Target runtime is constructed. */
export function assertInteractiveTargetWorkspaceSnapshot(
	snapshot: Pick<TargetWorkspaceSnapshot, "dir" | "sha256">,
): string {
	const lexicalDir = resolve(snapshot.dir);
	if (lstatSync(lexicalDir).isSymbolicLink()) {
		throw new Error("interactive workspace snapshot root must not be a symlink");
	}
	const workspaceDir = realpathSync(lexicalDir);
	if (hashValue(workspaceTreeEntries(workspaceDir)) !== snapshot.sha256) {
		throw new Error("interactive workspace snapshot changed after parent materialization");
	}
	return workspaceDir;
}

/** @internal Canonical, secret-free identity sent to the dedicated child. */
export function interactiveTargetIdentity(target: ResolvedTarget): InteractiveTargetIdentity {
	return structuredClone({
		dir: realpathSync(resolve(target.dir)),
		manifest: target.manifest,
		evaluationFiles: [...target.evaluationFiles].sort(),
		gitSha: target.gitSha,
		runtime: target.runtime,
		tools: target.tools,
		toolsetHash: target.toolsetHash,
		tasks: target.tasks,
		datasetHash: target.datasetHash,
		suiteHash: target.suiteHash,
	});
}

/** @internal Fail closed unless the child resolved exactly what its parent selected. */
export function assertInteractiveTargetIdentity(
	expected: InteractiveTargetIdentity,
	actual: ResolvedTarget,
): void {
	if (canonicalJson(expected) !== canonicalJson(interactiveTargetIdentity(actual))) {
		throw new Error("interactive Target identity changed after parent resolution");
	}
}

function restoreEnvironment(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

function assertRuntimeBoundary(options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	workspaceDir: string;
	privateAgentDir: string;
	privateSessionDir: string;
}): void {
	if (realpathSync(resolve(options.cwd)) !== options.workspaceDir) {
		throw new Error("Target interactive session cannot leave its isolated workspace");
	}
	if (realpathSync(resolve(options.agentDir)) !== options.privateAgentDir) {
		throw new Error("Target interactive session cannot replace its private agent directory");
	}
	if (
		options.sessionManager.isPersisted() &&
		realpathSync(resolve(options.sessionManager.getSessionDir())) !== options.privateSessionDir
	) throw new Error("Target interactive session cannot use an ambient session directory");
	const sessionFile = options.sessionManager.getSessionFile();
	if (!options.sessionManager.isPersisted() && sessionFile) {
		throw new Error("in-memory Target interactive session cannot expose a session file");
	}
	if (sessionFile && realpathSync(dirname(sessionFile)) !== options.privateSessionDir) {
		throw new Error("Target interactive session cannot open an ambient session file");
	}
}

let interactiveTargetActive = false;

/**
 * Run the exact resolved Target harness in Pi's real InteractiveMode.
 *
 * The session, config, models file, sandbox, and git-visible workspace are all
 * temporary and private. Nothing is published into eval, candidate, or
 * promotion storage, and the source Target checkout is never the model cwd.
 */
/** @internal The actual Target runtime; callers should use runInteractiveTarget. */
export async function runInteractiveTargetProcess(
	target: ResolvedTarget,
	options: RunInteractiveTargetProcessOptions = {},
): Promise<void> {
	const tty = options.tty ?? processTty;
	if (!tty.stdinIsTTY() || !tty.stdoutIsTTY()) {
		throw new Error("Interactive Target Pi requires TTY stdin and stdout");
	}
	if (interactiveTargetActive) throw new Error("an interactive Target Pi is already active in this process");

	const sourceEnvironment: NodeJS.ProcessEnv = { ...(options.environment ?? process.env) };
	const apiKeyEnvironmentName = target.manifest.model.apiKeyEnv;
	const apiKey = sourceEnvironment[apiKeyEnvironmentName];
	if (!apiKey) throw new Error(`missing Target model credential ${apiKeyEnvironmentName}`);

	interactiveTargetActive = true;
	let privateRoot = "";
	let agentDir = "";
	let sessionDir = "";
	let scratchDir = "";
	let modelsPath = "";
	try {
		privateRoot = mkdtempSync(join(tmpdir(), "ahde-target-interactive-"));
		chmodSync(privateRoot, 0o700);
		agentDir = privateDirectory(join(privateRoot, "agent"));
		sessionDir = privateDirectory(join(privateRoot, "sessions"));
		scratchDir = privateDirectory(join(privateRoot, "sandbox"));
		modelsPath = join(privateRoot, "models.json");
		writePrivateFile(modelsPath, `${JSON.stringify(generateModelsJson(target.manifest.model), null, "\t")}\n`);
	} catch (error) {
		if (privateRoot) rmSync(privateRoot, { recursive: true, force: true });
		interactiveTargetActive = false;
		throw error;
	}

	let ownedWorkspace: TargetWorkspaceSnapshot | undefined;
	let runtime: AgentSessionRuntime | undefined;
	let mode: TargetInteractiveMode | undefined;
	let hostGlobalsBound = false;
	const previousCwd = process.cwd();
	const previousAgentDir = process.env[AGENT_DIR_ENV];
	const previousSessionDir = process.env[SESSION_DIR_ENV];
	const previousOffline = process.env.PI_OFFLINE;
	const previousSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
	const previousInteractiveEnvironment = new Map(
		INTERACTIVE_PROCESS_ENV_NAMES.map((name) => [name, process.env[name]] as const),
	);
	let storageCleaned = false;
	const cleanupStorage = (): void => {
		if (storageCleaned) return;
		storageCleaned = true;
		try {
			if (ownedWorkspace) disposeTargetWorkspaceSnapshot(ownedWorkspace);
		} finally {
			makeTreeRemovable(privateRoot);
			rmSync(privateRoot, { recursive: true, force: true });
			interactiveTargetActive = false;
		}
	};
	// Pi's real InteractiveMode terminates with process.exit() after its own
	// graceful session disposal, so a synchronous exit hook owns temp cleanup
	// when JavaScript control cannot return through the finally block below.
	const cleanupOnProcessExit = (): void => {
		try {
			cleanupStorage();
		} catch {}
	};
	process.once("exit", cleanupOnProcessExit);

	try {
		ownedWorkspace = options.workspaceSnapshot
			? undefined
			: materializeTargetWorkspaceSnapshot(target, privateRoot);
		const workspaceDir = options.workspaceSnapshot
			? assertInteractiveTargetWorkspaceSnapshot(options.workspaceSnapshot)
			: realpathSync(ownedWorkspace!.dir);
		const resourceBundle = loadTargetResourceBundle({
			target,
			cwd: workspaceDir,
			snapshotDir: privateDirectory(join(privateRoot, "resources")),
		});
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			agentDir: requestedAgentDir,
			sessionManager,
			sessionStartEvent,
		}) => {
			assertRuntimeBoundary({
				cwd,
				agentDir: requestedAgentDir,
				sessionManager,
				workspaceDir,
				privateAgentDir: agentDir,
				privateSessionDir: sessionDir,
			});
			const executionPolicy = buildExecutionPolicy({
				workspaceDir,
				scratchDir,
				policy: target.manifest.execution,
				environment: {
					PATH: sourceEnvironment.PATH ?? "/usr/bin:/bin",
					LANG: sourceEnvironment.LANG ?? "C.UTF-8",
					HOME: join(scratchDir, "home"),
					TMPDIR: join(scratchDir, "tmp"),
				},
				sourceEnvironment,
			});
			const targetTools = createTargetToolRuntime({
				target,
				workspaceDir,
				scratchDir,
				sourceEnvironment,
			});
			return createTargetAgentSession({
				target,
				cwd: workspaceDir,
				agentDir,
				runDir: sessionDir,
				modelsPath,
				executionPolicy,
				targetTools,
				apiKey,
				sessionManager,
				sessionStartEvent,
				resourceBundle,
			});
		};

		// The interactive Target is disposable by design. In-memory sessions avoid
		// printing a resume hint for a file that cleanup would immediately delete.
		const sessionManager = SessionManager.inMemory(workspaceDir);
		runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: workspaceDir,
			agentDir,
			sessionManager,
		});

		process.chdir(workspaceDir);
		hostGlobalsBound = true;
		// Display/locale values are safe to bind only now: the dedicated Node child
		// has already finished loader startup and the IPC payload has been checked.
		for (const name of INTERACTIVE_PROCESS_ENV_NAMES) {
			restoreEnvironment(name, sourceEnvironment[name]);
		}
		process.env[AGENT_DIR_ENV] = agentDir;
		process.env[SESSION_DIR_ENV] = sessionDir;
		// InteractiveMode otherwise performs ambient catalog, update, and telemetry
		// traffic unrelated to the manifest-selected Target model endpoint.
		process.env.PI_OFFLINE = "1";
		process.env.PI_SKIP_VERSION_CHECK = "1";
		mode = (options.modeFactory ?? interactiveModeFactory)(runtime, {
			startupDiagnostics: [...runtime.diagnostics],
			initialMessage: options.initialMessage,
		});
		await mode.run();
	} finally {
		try {
			mode?.stop?.();
		} finally {
			try {
				if (runtime) await runtime.dispose();
			} finally {
				let restorationError: unknown;
				if (hostGlobalsBound) {
					try {
						process.chdir(previousCwd);
					} catch (error) {
						restorationError = error;
					}
					for (const [name, previous] of [
						...previousInteractiveEnvironment.entries(),
						[AGENT_DIR_ENV, previousAgentDir],
						[SESSION_DIR_ENV, previousSessionDir],
						["PI_OFFLINE", previousOffline],
						["PI_SKIP_VERSION_CHECK", previousSkipVersionCheck],
					] as const) {
						try {
							restoreEnvironment(name, previous);
						} catch (error) {
							restorationError ??= error;
						}
					}
				}
				process.off("exit", cleanupOnProcessExit);
				try {
					cleanupStorage();
				} catch (error) {
					restorationError ??= error;
				}
				if (restorationError) throw restorationError;
			}
		}
	}
}

/** @internal Runtime-only values delivered over IPC after Node has loaded AHDE. */
export function targetInteractiveRuntimeEnvironment(
	target: ResolvedTarget,
	source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const environment = Object.create(null) as NodeJS.ProcessEnv;
	for (const name of [
		...INTERACTIVE_PROCESS_ENV_NAMES,
		target.manifest.model.apiKeyEnv,
		...target.manifest.execution.environmentAllowlist,
	]) {
		if (source[name] !== undefined) environment[name] = source[name];
	}
	return environment;
}

/**
 * Node consumes loader variables before process-entry.ts can inspect them.
 * Start with no inherited variables; all Target-selected values arrive later
 * over the already-established IPC channel and remain runtime data.
 */
export function targetInteractiveBootstrapEnvironment(): NodeJS.ProcessEnv {
	return Object.create(null) as NodeJS.ProcessEnv;
}

/** @internal Build the one-shot, post-startup IPC launch payload. */
export function interactiveTargetProcessLaunch(
	target: ResolvedTarget,
	workspaceSnapshot: Pick<TargetWorkspaceSnapshot, "dir" | "sha256">,
	options: RunInteractiveTargetOptions,
): InteractiveTargetProcessLaunch {
	const sourceEnvironment = { ...(options.environment ?? process.env) };
	return {
		protocol: 1,
		targetDir: realpathSync(resolve(target.dir)),
		targetIdentity: interactiveTargetIdentity(target),
		workspaceSnapshot: {
			dir: realpathSync(resolve(workspaceSnapshot.dir)),
			sha256: workspaceSnapshot.sha256,
		},
		environment: targetInteractiveRuntimeEnvironment(target, sourceEnvironment),
		...(options.initialMessage !== undefined ? { initialMessage: options.initialMessage } : {}),
	};
}

/**
 * Launch Runtime Pi in a dedicated process. This keeps Pi's unavoidable cwd,
 * TTY, and process-environment state from racing Builder/eval work in a host.
 */
export async function runInteractiveTarget(
	target: ResolvedTarget,
	options: RunInteractiveTargetOptions = {},
): Promise<void> {
	const workspace = materializeTargetWorkspaceSnapshot(target, tmpdir());
	const launch = interactiveTargetProcessLaunch(target, workspace, options);
	const entry = fileURLToPath(new URL("./process-entry.js", import.meta.url));
	try {
		await new Promise<void>((resolvePromise, reject) => {
			const child = spawn(process.execPath, [entry], {
				stdio: ["inherit", "inherit", "inherit", "ipc"],
				env: targetInteractiveBootstrapEnvironment(),
			});
			child.once("error", reject);
			child.once("spawn", () => {
				child.send(launch, (error) => {
					if (!error) return;
					child.kill();
					reject(error);
				});
			});
			child.once("exit", (code, signal) => {
				if (code === 0) resolvePromise();
				else reject(new Error(`interactive Target process exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`));
			});
		});
	} finally {
		disposeTargetWorkspaceSnapshot(workspace);
	}
}
