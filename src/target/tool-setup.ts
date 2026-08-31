import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { hashFile, hashValue } from "../provenance.js";
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
	/** False when a previous call for the same tool identities already prepared it. */
	prepared: boolean;
}

function boundedText(buffer: Buffer | string | null | undefined): { text: string; truncated: boolean } {
	const raw = typeof buffer === "string" ? Buffer.from(buffer, "utf8") : buffer ?? Buffer.alloc(0);
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
	const command = setupCommandPath(setup.argv[0] as string, environment.PATH ?? "/usr/bin:/bin");
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
		...(options.resourceLimits ? { limits: options.resourceLimits } : {}),
	});
	const startedMs = Date.now();
	const result = spawnSync(invocation.executable, invocation.args, {
		cwd: toolDir,
		env: environment,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: setup.timeoutMs,
		killSignal: "SIGKILL",
		maxBuffer: MAX_TOOL_SETUP_OUTPUT_BYTES,
		windowsHide: true,
	});
	const stdout = boundedText(result.stdout);
	const stderr = boundedText(result.stderr);
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
 * declared setup step exactly once for that home. The prepared bytes are the
 * hash-verified workspace bytes; whatever setup adds is derived state that no
 * provenance hash ever sees.
 */
export function prepareToolHome(options: PrepareToolHomeOptions): PreparedToolHome {
	const root = resolve(options.toolHomeRoot);
	const tools = directoryTools(options.tools);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const identity = markerIdentity(options.tools);
	const markerPath = join(root, MARKER_FILE);
	if (existsSync(markerPath)) {
		const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { identity?: string; setups?: ToolSetupOutcome[] };
		if (marker.identity === identity) {
			return { root, setups: marker.setups ?? [], prepared: false };
		}
	}
	if (tools.length === 0) {
		writeFileSync(markerPath, `${JSON.stringify({ identity, setups: [] })}\n`, { mode: 0o600 });
		return { root, setups: [], prepared: true };
	}

	const backend = options.sandboxBackend ?? detectTargetToolSandbox(options.workspaceDir, options.scratchDir);
	const setups: ToolSetupOutcome[] = [];
	for (const tool of tools) {
		const toolDir = join(root, tool.descriptor.name);
		copyToolDirectory(tool, options.workspaceDir, toolDir);
		setups.push(runSetup(tool, toolDir, { ...options, backend, toolHomeRoot: root }));
	}
	const temporary = `${markerPath}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ identity, setups })}\n`, { mode: 0o600 });
	renameSync(temporary, markerPath);
	return { root, setups, prepared: true };
}
