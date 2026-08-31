import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
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
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { hashFile, hashValue } from "../provenance.js";
import { redactSensitiveText } from "../trace.js";
import { resolveExecutionBackend } from "./container-backend.js";
import {
	buildToolEnvironment,
	detectTargetToolSandbox,
	sandboxInvocation,
	type SandboxResourceLimits,
	type TargetToolSandboxBackend,
} from "./tool-broker.js";
import type { ResolvedTargetTool, TargetToolPolicyEnvelope } from "./tool-manifest.js";

/** Setup chatter is diagnostic, never evidence; a package manager can print megabytes. */
export const MAX_TOOL_SETUP_OUTPUT_BYTES = 64 * 1024;

const MARKER_FILE = ".ahde-tool-home.json";
const MAX_TOOL_HOME_MARKER_BYTES = 256 * 1024;

/** The exact empty prepared-home identity used by Targets with no directory tools. */
export const EMPTY_PREPARED_TOOL_HOME_HASH = hashValue({ schemaVersion: 1, entries: [] });

export interface ToolSetupOutcome {
	tool: string;
	/** False when the tool declares no setup step. */
	ran: boolean;
	exitCode: number | null;
	durationMs: number;
	stdout: string;
	stderr: string;
	truncated: boolean;
	network: "deny" | "allow";
}

/**
 * A dependency step that failed. Callers surface this as an infrastructure
 * failure for the run: the harness never produced behavior to grade.
 */
export class ToolSetupError extends Error {
	readonly toolName: string;
	readonly outcome: ToolSetupOutcome;

	constructor(message: string, outcome: ToolSetupOutcome) {
		super(message);
		this.name = "ToolSetupError";
		this.toolName = outcome.tool;
		this.outcome = outcome;
	}
}

export interface PrepareToolHomeOptions {
	/** Hash-verified workspace the tool files are copied out of. */
	workspaceDir: string;
	scratchDir: string;
	tools: readonly ResolvedTargetTool[];
	/** Private directory that will hold `<tool name>/…`. Never the user's checkout. */
	toolHomeRoot: string;
	policy: TargetToolPolicyEnvelope;
	sandboxBackend?: TargetToolSandboxBackend;
	sourceEnvironment?: NodeJS.ProcessEnv;
	/** Optional caps for an unreviewed setup process; normal Target setup omits them. */
	resourceLimits?: SandboxResourceLimits;
}

export interface PreparedToolHome {
	root: string;
	setups: ToolSetupOutcome[];
	/** Exact paths, bytes, and executable bits produced by preparation. */
	sha256: string;
	/** False when a previous call for the same tool identities already prepared it. */
	prepared: boolean;
}

interface ToolHomeMarker {
	schemaVersion: 2;
	identity: string;
	sha256: string;
	setups: ToolSetupOutcome[];
}

function portableRelativePath(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

function comparePath(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Attest the complete prepared tree. The marker is host bookkeeping, not
 * Target state; every other entry participates, including empty directories.
 * Permissions are reduced to executable bits: those change whether a command
 * can run, while host umask-specific read/write bits do not describe Target
 * behaviour.
 */
export function preparedToolHomeHash(rootPath: string): string {
	const root = resolve(rootPath);
	const rootStat = lstatSync(root);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		throw new Error("prepared tool home root must be a real directory");
	}
	const canonicalRoot = realpathSync(root);
	const entries: Array<{
		path: string;
		kind: "directory" | "file";
		executableMode: number;
		sha256?: string;
	}> = [];

	const visit = (directory: string): void => {
		for (const name of readdirSync(directory).sort(comparePath)) {
			const path = join(directory, name);
			const relativePath = portableRelativePath(canonicalRoot, path);
			const before = lstatSync(path);
			if (before.isSymbolicLink()) {
				throw new Error(`prepared tool home contains a symlink: ${relativePath}`);
			}
			// Only the exact, regular host marker at the root is excluded. A
			// marker-shaped symlink or directory is untrusted state and fails closed.
			if (relativePath === MARKER_FILE) {
				if (!before.isFile()) throw new Error("prepared tool home marker is not a regular file");
				continue;
			}
			if (before.isDirectory()) {
				entries.push({
					path: relativePath,
					kind: "directory",
					executableMode: before.mode & 0o111,
				});
				visit(path);
				continue;
			}
			if (!before.isFile()) {
				throw new Error(`prepared tool home contains a non-regular file: ${relativePath}`);
			}
			const content = readFileSync(path);
			const after = lstatSync(path);
			if (
				after.isSymbolicLink() || !after.isFile() ||
				after.dev !== before.dev || after.ino !== before.ino ||
				after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
				(after.mode & 0o111) !== (before.mode & 0o111)
			) {
				throw new Error(`prepared tool home changed while hashing: ${relativePath}`);
			}
			entries.push({
				path: relativePath,
				kind: "file",
				executableMode: before.mode & 0o111,
				sha256: hashFile(content.toString("base64")),
			});
		}
	};
	visit(canonicalRoot);
	return entries.length === 0 ? EMPTY_PREPARED_TOOL_HOME_HASH : hashValue({ schemaVersion: 1, entries });
}

function isToolSetupOutcome(value: unknown): value is ToolSetupOutcome {
	if (typeof value !== "object" || value === null) return false;
	const outcome = value as Partial<ToolSetupOutcome>;
	return typeof outcome.tool === "string" && outcome.tool.length > 0 &&
		typeof outcome.ran === "boolean" &&
		(outcome.exitCode === null || (typeof outcome.exitCode === "number" && Number.isInteger(outcome.exitCode))) &&
		typeof outcome.durationMs === "number" && Number.isFinite(outcome.durationMs) && outcome.durationMs >= 0 &&
		typeof outcome.stdout === "string" && typeof outcome.stderr === "string" &&
		typeof outcome.truncated === "boolean" &&
		(outcome.network === "deny" || outcome.network === "allow");
}

function readMarker(path: string): ToolHomeMarker | null {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isFile()) {
			throw new Error("prepared tool home marker must be a regular file");
		}
		if (stat.size > MAX_TOOL_HOME_MARKER_BYTES) return null;
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ToolHomeMarker>;
		if (
			value.schemaVersion !== 2 || typeof value.identity !== "string" ||
			typeof value.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.sha256) ||
			!Array.isArray(value.setups) || !value.setups.every(isToolSetupOutcome)
		) return null;
		return value as ToolHomeMarker;
	} catch {
		return null;
	}
}

/** Remove only a fully inspectable old cache. Symlinks and special files stop preparation. */
function resetPreparedToolHome(root: string): void {
	// Inspection includes every old entry except a regular host marker. This is
	// intentionally done before removal so an attacker cannot turn a bad cache
	// into an accepted one merely by making us delete the evidence.
	preparedToolHomeHash(root);
	for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true });
}

function boundedText(
	buffer: Buffer | string | null | undefined,
	sensitiveValues: readonly string[] = [],
): { text: string; truncated: boolean } {
	const source = typeof buffer === "string" ? buffer : (buffer ?? Buffer.alloc(0)).toString("utf8");
	const raw = Buffer.from(redactSensitiveText(source, sensitiveValues), "utf8");
	const truncated = raw.byteLength > MAX_TOOL_SETUP_OUTPUT_BYTES;
	const slice = truncated ? raw.subarray(0, MAX_TOOL_SETUP_OUTPUT_BYTES) : raw;
	return { text: slice.toString("utf8"), truncated };
}

function setupCommandPath(command: string, pathValue: string): string {
	if (command.startsWith("/")) return command;
	for (const entry of pathValue.split(delimiter).filter(Boolean)) {
		const candidate = join(entry, command);
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(`tool setup command is not on PATH: ${command}`);
}

function directoryTools(tools: readonly ResolvedTargetTool[]): ResolvedTargetTool[] {
	return tools.filter((tool) => tool.layout === "directory");
}

function markerIdentity(tools: readonly ResolvedTargetTool[]): string {
	return hashValue(directoryTools(tools).map((tool) => ({ name: tool.descriptor.name, digest: tool.digest })));
}

function copyToolDirectory(tool: ResolvedTargetTool, workspaceDir: string, destination: string): void {
	if (!tool.directoryPath) throw new Error(`tool ${tool.descriptor.name} has no directory to prepare`);
	rmSync(destination, { recursive: true, force: true });
	mkdirSync(destination, { recursive: true, mode: 0o700 });
	for (const file of tool.files) {
		const source = resolve(workspaceDir, ...tool.directoryPath.split("/"), ...file.path.split("/"));
		const content = readFileSync(source);
		if (hashFile(content.toString("base64")) !== file.sha256) {
			throw new Error(`tool ${tool.descriptor.name} file changed before preparation: ${file.path}`);
		}
		const target = join(destination, ...file.path.split("/"));
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		writeFileSync(target, content, { mode: file.executable ? 0o700 : 0o600 });
		chmodSync(target, file.executable ? 0o700 : 0o600);
	}
}

function runSetup(
	tool: ResolvedTargetTool,
	toolDir: string,
	options: PrepareToolHomeOptions & { backend: TargetToolSandboxBackend; toolHomeRoot: string },
): ToolSetupOutcome {
	const setup = tool.descriptor.setup;
	if (!setup) {
		return {
			tool: tool.descriptor.name,
			ran: false,
			exitCode: 0,
			durationMs: 0,
			stdout: "",
			stderr: "",
			truncated: false,
			network: "deny",
		};
	}
	const { environment } = buildToolEnvironment({
		label: `${tool.descriptor.name}-setup`,
		scratchDir: options.scratchDir,
		environmentAllowlist: tool.descriptor.permissions.environment,
		...(options.sourceEnvironment ? { sourceEnvironment: options.sourceEnvironment } : {}),
		toolHome: toolDir,
	});
	const sourceEnvironment = options.sourceEnvironment ?? process.env;
	const sensitiveValues = tool.descriptor.permissions.environment
		.map((name) => sourceEnvironment[name])
		.filter((value): value is string => typeof value === "string" && value.length > 0);
	// Under the container backend the setup command must resolve inside the
	// image, so the host PATH is not consulted at all: resolving it here would
	// bake a host path into the container's argv.
	const command = options.backend === "container"
		? (setup.argv[0] as string)
		: setupCommandPath(setup.argv[0] as string, environment.PATH ?? "/usr/bin:/bin");
	const invocation = sandboxInvocation({
		backend: options.backend,
		workspaceDir: options.workspaceDir,
		scratchDir: options.scratchDir,
		environment,
		confinement: {
			// A setup step reaches the network only when the descriptor says so and
			// the Target execution policy already permits it.
			network: setup.network,
			readRoots: [options.toolHomeRoot],
			writeRoots: [toolDir],
		},
		cwd: toolDir,
		argv: [command, ...setup.argv.slice(1)],
		...(options.policy.container ? { container: options.policy.container } : {}),
		toolHomeRoot: options.toolHomeRoot,
		// The one moment the prepared home is writable: a setup step populates
		// the directory every later tool call then reads read-only.
		toolHomeMode: "rw",
		...(options.resourceLimits ? { limits: options.resourceLimits } : {}),
	});
	const startedMs = Date.now();
	const result = spawnSync(invocation.executable, invocation.args, {
		cwd: toolDir,
		env: invocation.spawnEnvironment ?? environment,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: setup.timeoutMs,
		killSignal: "SIGKILL",
		maxBuffer: MAX_TOOL_SETUP_OUTPUT_BYTES,
		windowsHide: true,
	});
	// `spawnSync` kills only the attached runtime CLI on timeout or output
	// overflow. A container is daemon-owned, so force-remove its exact minted
	// name before surfacing the infrastructure error.
	if (result.error) invocation.terminate?.();
	invocation.dispose?.();
	const stdout = boundedText(result.stdout, sensitiveValues);
	const stderr = boundedText(result.stderr, sensitiveValues);
	const outcome: ToolSetupOutcome = {
		tool: tool.descriptor.name,
		ran: true,
		exitCode: result.status,
		durationMs: Date.now() - startedMs,
		stdout: stdout.text,
		stderr: stderr.text,
		truncated: stdout.truncated || stderr.truncated,
		network: setup.network,
	};
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code;
		const reason = code === "ETIMEDOUT"
			? `timed out after ${setup.timeoutMs}ms`
			: code === "ENOBUFS"
				? `exceeded ${MAX_TOOL_SETUP_OUTPUT_BYTES} output bytes`
				: result.error.message;
		throw new ToolSetupError(`Target tool ${tool.descriptor.name} setup ${reason}`, { ...outcome, truncated: true });
	}
	if (result.status !== 0) {
		const detail = outcome.stderr.trim() || outcome.stdout.trim();
		throw new ToolSetupError(
			`Target tool ${tool.descriptor.name} setup exited with ${result.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
			outcome,
		);
	}
	return outcome;
}

/**
 * Materialize every multi-file tool into a private prepared home and run each
 * declared setup step exactly once for that home. Setup output is attested and
 * returned to the caller as Target identity; the host-owned marker stores the
 * same digest and is excluded from it.
 */
export function prepareToolHome(options: PrepareToolHomeOptions): PreparedToolHome {
	const root = resolve(options.toolHomeRoot);
	const tools = directoryTools(options.tools);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const rootStat = lstatSync(root);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		throw new Error("prepared tool home root must be a real directory");
	}
	const identity = markerIdentity(options.tools);
	const markerPath = join(root, MARKER_FILE);
	if (existsSync(markerPath)) {
		const marker = readMarker(markerPath);
		if (marker?.identity === identity) {
			const currentHash = preparedToolHomeHash(root);
			if (currentHash === marker.sha256) {
				return { root, setups: marker.setups, sha256: currentHash, prepared: false };
			}
		}
	}
	resetPreparedToolHome(root);
	if (tools.length === 0) {
		const sha256 = preparedToolHomeHash(root);
		writeFileSync(markerPath, `${JSON.stringify({ schemaVersion: 2, identity, sha256, setups: [] })}\n`, { mode: 0o600 });
		return { root, setups: [], sha256, prepared: true };
	}

	const backend = options.sandboxBackend
		?? resolveExecutionBackend({
			policy: options.policy,
			osBackend: () => detectTargetToolSandbox(options.workspaceDir, options.scratchDir),
		}).backend;
	const setups: ToolSetupOutcome[] = [];
	for (const tool of tools) {
		// A setup may have broader env/network authority than another tool. Never
		// mount their shared final home rw: prepare one tool in a private home and
		// scratch, attest it, then atomically compose only that directory.
		const preparationRoot = mkdtempSync(join(dirname(root), ".ahde-tool-prepare-"));
		chmodSync(preparationRoot, 0o700);
		const stagingHome = join(preparationRoot, "tool-home");
		const stagingScratch = join(preparationRoot, "scratch");
		mkdirSync(stagingHome, { mode: 0o700 });
		mkdirSync(stagingScratch, { mode: 0o700 });
		try {
			const stagedToolDir = join(stagingHome, tool.descriptor.name);
			copyToolDirectory(tool, options.workspaceDir, stagedToolDir);
			const outcome = runSetup(tool, stagedToolDir, {
				...options,
				backend,
				scratchDir: stagingScratch,
				toolHomeRoot: stagingHome,
			});
			const topLevel = readdirSync(stagingHome).sort(comparePath);
			if (topLevel.length !== 1 || topLevel[0] !== tool.descriptor.name) {
				throw new Error(`Target tool ${tool.descriptor.name} setup wrote outside its private tool directory`);
			}
			// Refuse symlinks, special files, and a tree changing during the
			// handoff before it can enter the shared runtime home.
			preparedToolHomeHash(stagingHome);
			const destination = join(root, tool.descriptor.name);
			if (existsSync(destination)) {
				throw new Error(`prepared tool home already contains ${tool.descriptor.name}`);
			}
			renameSync(stagedToolDir, destination);
			setups.push(outcome);
		} finally {
			rmSync(preparationRoot, { recursive: true, force: true });
		}
	}
	const sha256 = preparedToolHomeHash(root);
	const temporary = `${markerPath}.tmp`;
	// The marker lives under a mounted tool home. Keep only non-sensitive setup
	// metadata there: raw stdout/stderr are transient diagnostics and may contain
	// a credential even after a successful command.
	const markerSetups = setups.map((outcome) => ({ ...outcome, stdout: "", stderr: "" }));
	writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 2, identity, sha256, setups: markerSetups })}\n`, { mode: 0o600 });
	renameSync(temporary, markerPath);
	return { root, setups, sha256, prepared: true };
}
