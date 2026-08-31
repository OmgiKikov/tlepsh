import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { hashFile } from "../provenance.js";
import { containerBackendFor, type ContainerPolicy } from "./container-backend.js";
import {
	resolveStrictTargetFile,
	type ResolvedTargetTool,
	type TargetToolPolicyEnvelope,
	validateTargetToolArguments,
} from "./tool-manifest.js";

export type TargetToolSandboxBackend = "sandbox-exec" | "bwrap" | "container";

export interface TargetToolBrokerOptions {
	workspaceDir: string;
	scratchDir: string;
	policy: TargetToolPolicyEnvelope;
	sourceEnvironment?: NodeJS.ProcessEnv;
	/**
	 * Prepared home for multi-file tools: `<root>/<tool name>/…`. Directory
	 * tools execute from here, never from the model-writable workspace copy.
	 */
	toolHomeRoot?: string;
	/** Production callers should omit this. Tests may inject a previously probed backend. */
	sandboxBackend?: TargetToolSandboxBackend;
}

export interface TargetToolBrokerResult {
	text: string;
	json?: unknown;
	exitCode: number;
	toolDigest: string;
}

/** The exact, bounded outcome of one sandboxed process. */
export interface TargetToolRawResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	durationMs: number;
	truncated: boolean;
	stopped: "aborted" | "overflow" | "timeout" | null;
}

/** What one sandboxed process may reach. Nothing else is negotiable at runtime. */
export interface TargetToolConfinement {
	network: "deny" | "allow";
	/** Extra absolute read roots (prepared tool home, data mounts). */
	readRoots: readonly string[];
	/** Absolute directories the process may write. Scratch is always writable. */
	writeRoots: readonly string[];
}

export const AHDE_TOOL_HOME_ENVIRONMENT = "AHDE_TOOL_HOME";

const FIXED_ENVIRONMENT = new Set(["HOME", "LANG", "PATH", "TMPDIR"]);

function executableOnPath(name: string, pathValue: string): string | undefined {
	const candidates = name.startsWith("/")
		? [name]
		: pathValue.split(delimiter).filter(Boolean).map((entry) => join(entry, name));
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return undefined;
}

function sandboxString(value: string): string {
	return JSON.stringify(value);
}

export function macosProfile(
	workspaceDir: string,
	scratchDir: string,
	confinement: TargetToolConfinement,
): string {
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
		workspaceDir,
		scratchDir,
		...confinement.readRoots,
	];
	const reads = readRoots.map((path) => `(subpath ${sandboxString(path)})`).join(" ");
	const writes = [
		`(literal "/dev/null")`,
		`(subpath ${sandboxString(scratchDir)})`,
		...confinement.writeRoots.map((path) => `(subpath ${sandboxString(path)})`),
	].join(" ");
	return [
		"(version 1)",
		"(deny default)",
		"(allow process*)",
		"(allow signal (target self))",
		"(allow sysctl-read)",
		"(allow mach-lookup)",
		"(allow ipc-posix*)",
		"(allow file-read-metadata)",
		`(allow file-read* (literal "/") ${reads})`,
		`(allow file-write* ${writes})`,
		confinement.network === "deny" ? "(deny network*)" : "(allow network*)",
	].join(" ");
}

/** The confinement one declared tool call runs under. */
export function toolConfinement(
	tool: ResolvedTargetTool,
	workspaceDir: string,
	toolHomeRoot: string | undefined,
): TargetToolConfinement {
	return {
		network: tool.descriptor.permissions.network,
		readRoots: toolHomeRoot ? [toolHomeRoot] : [],
		writeRoots: tool.descriptor.permissions.filesystem === "workspace-write" ? [workspaceDir] : [],
	};
}

function existingSystemPaths(): string[] {
	return ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/nix/store"].filter((path) => {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	});
}

export function bwrapArguments(options: {
	workspaceDir: string;
	scratchDir: string;
	environment: NodeJS.ProcessEnv;
	confinement: TargetToolConfinement;
	cwd: string;
	argv: readonly string[];
}): string[] {
	const args = [
		"--die-with-parent",
		"--new-session",
		"--unshare-user",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--unshare-cgroup",
	];
	if (options.confinement.network === "deny") args.push("--unshare-net");
	args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
	for (const path of existingSystemPaths()) args.push("--ro-bind", path, path);
	args.push("--ro-bind", options.workspaceDir, options.workspaceDir);
	for (const path of options.confinement.readRoots) args.push("--ro-bind", path, path);
	args.push("--bind", options.scratchDir, options.scratchDir);
	// Write roots come last so a writable subtree overrides its read-only parent.
	for (const path of options.confinement.writeRoots) args.push("--bind", path, path);
	args.push("--chdir", options.cwd, "--clearenv");
	for (const [name, value] of Object.entries(options.environment).sort(([a], [b]) => a.localeCompare(b))) {
		if (value !== undefined) args.push("--setenv", name, value);
	}
	args.push("--", ...options.argv);
	return args;
}

const PROBE_CONFINEMENT: TargetToolConfinement = { network: "deny", readRoots: [], writeRoots: [] };

function probeMacSandbox(binary: string, workspaceDir: string, scratchDir: string): boolean {
	const probe = spawnSync(binary, ["-p", macosProfile(workspaceDir, scratchDir, PROBE_CONFINEMENT), "/usr/bin/true"], {
		cwd: workspaceDir,
		stdio: "ignore",
		timeout: 3_000,
	});
	return probe.status === 0 && !probe.error;
}

function probeBwrap(binary: string, workspaceDir: string, scratchDir: string): boolean {
	const args = [
		"--die-with-parent",
		"--new-session",
		"--unshare-user",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--unshare-cgroup",
		"--unshare-net",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
	];
	for (const path of existingSystemPaths()) args.push("--ro-bind", path, path);
	args.push("--ro-bind", workspaceDir, workspaceDir, "--bind", scratchDir, scratchDir, "--", "/bin/true");
	const probe = spawnSync(binary, args, { cwd: workspaceDir, stdio: "ignore", timeout: 3_000 });
	return probe.status === 0 && !probe.error;
}

export function detectTargetToolSandbox(workspaceDir: string, scratchDir: string): TargetToolSandboxBackend {
	mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
	if (process.platform === "darwin") {
		const binary = executableOnPath("/usr/bin/sandbox-exec", "");
		if (binary && probeMacSandbox(binary, workspaceDir, scratchDir)) return "sandbox-exec";
	}
	if (process.platform === "linux") {
		const binary = executableOnPath("bwrap", process.env.PATH ?? "") ?? executableOnPath("/usr/bin/bwrap", "");
		if (binary && probeBwrap(binary, workspaceDir, scratchDir)) return "bwrap";
	}
	throw new Error(`No usable sandbox backend for declarative Target tools on ${process.platform}; execution fails closed`);
}

/**
 * The scrubbed environment one sandboxed Target process receives. `label`
 * separates per-tool HOME/TMPDIR sandboxes (a tool call and its setup step
 * must not share mutable state by accident).
 */
export function buildToolEnvironment(options: {
	label: string;
	scratchDir: string;
	environmentAllowlist: readonly string[];
	sourceEnvironment?: NodeJS.ProcessEnv;
	toolHome?: string;
}): { environment: NodeJS.ProcessEnv; names: string[] } {
	const home = join(options.scratchDir, "tool-home", options.label);
	const temporary = join(options.scratchDir, "tool-tmp", options.label);
	mkdirSync(home, { recursive: true, mode: 0o700 });
	mkdirSync(temporary, { recursive: true, mode: 0o700 });
	const source = options.sourceEnvironment ?? process.env;
	const environment: NodeJS.ProcessEnv = {
		PATH: source.PATH ?? "/usr/bin:/bin",
		LANG: source.LANG ?? "C.UTF-8",
		HOME: home,
		TMPDIR: temporary,
	};
	if (options.toolHome) environment[AHDE_TOOL_HOME_ENVIRONMENT] = options.toolHome;
	for (const name of options.environmentAllowlist) {
		if (FIXED_ENVIRONMENT.has(name) || name === AHDE_TOOL_HOME_ENVIRONMENT) continue;
		const value = source[name];
		if (value !== undefined) environment[name] = value;
	}
	return { environment, names: Object.keys(environment).sort() };
}

function buildEnvironment(
	tool: ResolvedTargetTool,
	options: TargetToolBrokerOptions,
): { environment: NodeJS.ProcessEnv; names: string[] } {
	return buildToolEnvironment({
		label: tool.descriptor.name,
		scratchDir: options.scratchDir,
		environmentAllowlist: tool.descriptor.permissions.environment,
		...(options.sourceEnvironment ? { sourceEnvironment: options.sourceEnvironment } : {}),
		...(tool.layout === "directory" && options.toolHomeRoot
			? { toolHome: join(options.toolHomeRoot, tool.descriptor.name) }
			: {}),
	});
}

/** Wrap one argv in the detected OS sandbox under an explicit confinement. */
export function sandboxInvocation(options: {
	backend: TargetToolSandboxBackend;
	workspaceDir: string;
	scratchDir: string;
	environment: NodeJS.ProcessEnv;
	confinement: TargetToolConfinement;
	cwd: string;
	argv: readonly string[];
	/** Required when `backend` is "container"; selects the container runtime and image. */
	container?: ContainerPolicy;
	/** Prepared multi-file tool home to mount at /tools, and whether that mount is writable. */
	toolHomeRoot?: string;
	toolHomeMode?: "ro" | "rw";
	hostEnvironment?: NodeJS.ProcessEnv;
}): { executable: string; args: string[]; spawnEnvironment?: NodeJS.ProcessEnv; terminate?: () => void } {
	if (options.backend === "container") {
		if (!options.container) throw new Error("container backend requires an execution.container policy");
		return containerBackendFor(options.container.runtime).invocation({
			policy: options.container,
			mounts: {
				workspaceDir: options.workspaceDir,
				workspaceMode: options.confinement.writeRoots.includes(options.workspaceDir) ? "rw" : "ro",
				scratchDir: options.scratchDir,
				...(options.toolHomeRoot ? { toolHomeRoot: options.toolHomeRoot } : {}),
				...(options.toolHomeMode ? { toolHomeMode: options.toolHomeMode } : {}),
			},
			network: options.confinement.network,
			environment: options.environment,
			cwd: options.cwd,
			argv: options.argv,
			...(options.hostEnvironment ? { hostEnvironment: options.hostEnvironment } : {}),
		});
	}
	if (options.backend === "sandbox-exec") {
		const [command, ...rest] = options.argv;
		if (!command) throw new Error("sandboxed invocation requires a command");
		return {
			executable: "/usr/bin/sandbox-exec",
			args: ["-p", macosProfile(options.workspaceDir, options.scratchDir, options.confinement), command, ...rest],
		};
	}
	const binary = executableOnPath("bwrap", process.env.PATH ?? "") ?? "/usr/bin/bwrap";
	return { executable: binary, args: bwrapArguments(options) };
}

function killProcessTree(pid: number | undefined): void {
	if (!pid) return;
	try {
		if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
		else process.kill(pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

function decodeUtf8(buffer: Buffer, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch (error) {
		throw new Error(`${label} was not valid UTF-8`, { cause: error });
	}
}

export class TargetToolBroker {
	readonly sandboxBackend: TargetToolSandboxBackend;
	private readonly toolHomeRoot: string | undefined;

	constructor(private readonly options: TargetToolBrokerOptions) {
		this.options.workspaceDir = realWorkspace(options.workspaceDir);
		this.options.scratchDir = resolve(options.scratchDir);
		mkdirSync(this.options.scratchDir, { recursive: true, mode: 0o700 });
		this.options.scratchDir = realpathSync(this.options.scratchDir);
		this.toolHomeRoot = options.toolHomeRoot ? realWorkspace(options.toolHomeRoot) : undefined;
		this.options.toolHomeRoot = this.toolHomeRoot;
		this.sandboxBackend = options.sandboxBackend ?? detectTargetToolSandbox(this.options.workspaceDir, this.options.scratchDir);
	}

	effectiveEnvironmentNames(tool: ResolvedTargetTool): string[] {
		return buildEnvironment(tool, this.options).names;
	}

	/**
	 * Resolve the exact bytes that will run. Directory tools execute from the
	 * prepared tool home so a workspace-write tool cannot rewrite its own code
	 * between resolution and the next call.
	 */
	private resolveExecutable(tool: ResolvedTargetTool): string {
		const label = `tool ${tool.descriptor.name} executable`;
		if (tool.layout === "single-file") {
			return resolveStrictTargetFile(this.options.workspaceDir, tool.executablePath, label);
		}
		if (!this.toolHomeRoot) {
			throw new Error(`Target tool ${tool.descriptor.name} requires a prepared tool home`);
		}
		return resolveStrictTargetFile(this.toolHomeRoot, `${tool.descriptor.name}/run`, label);
	}

	/**
	 * Run one tool and return its bounded raw outcome. Non-zero exits, timeouts,
	 * and overflow are data here, not exceptions: the workshop shows them to a
	 * human and `execute` below turns them into the model-facing contract.
	 */
	async runRaw(
		tool: ResolvedTargetTool,
		argumentsValue: unknown,
		signal?: AbortSignal,
	): Promise<TargetToolRawResult> {
		if (signal?.aborted) throw new Error(`Target tool ${tool.descriptor.name} aborted`);
		const args = validateTargetToolArguments(tool, argumentsValue);
		let input: string;
		try {
			input = `${JSON.stringify(args)}\n`;
		} catch (error) {
			throw new Error(`Target tool ${tool.descriptor.name} arguments are not JSON-serializable`, { cause: error });
		}
		if (Buffer.byteLength(input) > 1024 * 1024) {
			throw new Error(`Target tool ${tool.descriptor.name} JSON input exceeds 1048576 bytes`);
		}
		const executable = this.resolveExecutable(tool);
		try {
			accessSync(executable, constants.X_OK);
		} catch {
			throw new Error(`Target tool ${tool.descriptor.name} executable is not executable`);
		}
		const actualHash = hashFile(readFileSync(executable).toString("base64"));
		if (actualHash !== tool.executableHash) {
			throw new Error(`Target tool ${tool.descriptor.name} executable changed after resolution`);
		}
		const { environment } = buildEnvironment(tool, this.options);
		const command = sandboxInvocation({
			backend: this.sandboxBackend,
			workspaceDir: this.options.workspaceDir,
			scratchDir: this.options.scratchDir,
			environment,
			confinement: toolConfinement(tool, this.options.workspaceDir, this.toolHomeRoot),
			cwd: this.options.workspaceDir,
			argv: [executable, ...tool.descriptor.command.argv.slice(1)],
			...(this.options.policy.container ? { container: this.options.policy.container } : {}),
			...(this.toolHomeRoot ? { toolHomeRoot: this.toolHomeRoot } : {}),
		});
		const startedMs = Date.now();
		const child = spawn(command.executable, command.args, {
			cwd: this.options.workspaceDir,
			detached: process.platform !== "win32",
			// The container runtime CLI is a host process and needs the host's own
			// PATH and daemon variables; the container's environment travels in the
			// `-e` flags inside `command.args`, never here.
			env: command.spawnEnvironment ?? environment,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let stopped: "aborted" | "overflow" | "timeout" | undefined;
		let stdinError: Error | undefined;
		const stop = (reason: "aborted" | "overflow" | "timeout") => {
			if (stopped) return;
			stopped = reason;
			command.terminate?.();
			killProcessTree(child.pid);
		};
		const collect = (destination: Buffer[]) => (chunk: Buffer) => {
			outputBytes += chunk.byteLength;
			if (outputBytes > tool.descriptor.maxOutputBytes) {
				stop("overflow");
				return;
			}
			destination.push(Buffer.from(chunk));
		};
		child.stdout.on("data", collect(stdout));
		child.stderr.on("data", collect(stderr));
		child.stdin.on("error", (error) => {
			stdinError = error;
		});
		const abort = () => {
			stop("aborted");
		};
		signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => {
			stop("timeout");
		}, tool.descriptor.timeoutMs);

		try {
			child.stdin.end(input);
			const exitCode = await new Promise<number | null>((resolveExit, reject) => {
				child.once("error", reject);
				child.once("close", resolveExit);
			});
			if (stopped === "aborted" || signal?.aborted) throw new Error(`Target tool ${tool.descriptor.name} aborted`);
			if (stdinError) throw new Error(`Target tool ${tool.descriptor.name} could not read JSON input`, { cause: stdinError });
			return {
				stdout: decodeUtf8(Buffer.concat(stdout), `Target tool ${tool.descriptor.name} stdout`),
				stderr: decodeUtf8(Buffer.concat(stderr), `Target tool ${tool.descriptor.name} stderr`),
				exitCode,
				durationMs: Date.now() - startedMs,
				truncated: stopped === "overflow",
				stopped: stopped ?? null,
			};
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
	}

	async execute(
		tool: ResolvedTargetTool,
		argumentsValue: unknown,
		signal?: AbortSignal,
	): Promise<TargetToolBrokerResult> {
		const raw = await this.runRaw(tool, argumentsValue, signal);
		if (raw.stopped === "timeout") {
			throw new Error(`Target tool ${tool.descriptor.name} timed out after ${tool.descriptor.timeoutMs}ms`);
		}
		if (raw.stopped === "overflow") {
			throw new Error(`Target tool ${tool.descriptor.name} exceeded ${tool.descriptor.maxOutputBytes} output bytes`);
		}
		const stderrText = raw.stderr.trim();
		if (raw.exitCode !== 0) {
			throw new Error(
				`Target tool ${tool.descriptor.name} exited with ${raw.exitCode}${stderrText ? `: ${stderrText}` : ""}`,
			);
		}
		const text = raw.stdout.trimEnd();
		if (tool.descriptor.output === "text") {
			return { text, exitCode: 0, toolDigest: tool.digest };
		}
		let json: unknown;
		try {
			json = JSON.parse(text) as unknown;
		} catch (error) {
			throw new Error(`Target tool ${tool.descriptor.name} returned malformed JSON`, { cause: error });
		}
		return { text: JSON.stringify(json), json, exitCode: 0, toolDigest: tool.digest };
	}
}

function realWorkspace(path: string): string {
	const absolute = realpathSync(resolve(path));
	if (!statSync(absolute).isDirectory()) throw new Error(`Target tool workspace must be a directory: ${absolute}`);
	return absolute;
}
