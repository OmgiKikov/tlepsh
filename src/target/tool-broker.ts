import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { hashFile } from "../provenance.js";
import {
	resolveStrictTargetFile,
	type ResolvedTargetTool,
	type TargetToolPolicyEnvelope,
	validateTargetToolArguments,
} from "./tool-manifest.js";

export type TargetToolSandboxBackend = "sandbox-exec" | "bwrap";

export interface TargetToolBrokerOptions {
	workspaceDir: string;
	scratchDir: string;
	policy: TargetToolPolicyEnvelope;
	sourceEnvironment?: NodeJS.ProcessEnv;
	/** Production callers should omit this. Tests may inject a previously probed backend. */
	sandboxBackend?: TargetToolSandboxBackend;
}

export interface TargetToolBrokerResult {
	text: string;
	json?: unknown;
	exitCode: number;
	toolDigest: string;
}

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

function macosProfile(
	workspaceDir: string,
	scratchDir: string,
	tool: ResolvedTargetTool,
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
	];
	const reads = readRoots.map((path) => `(subpath ${sandboxString(path)})`).join(" ");
	const writes = [
		`(literal "/dev/null")`,
		`(subpath ${sandboxString(scratchDir)})`,
		...(tool.descriptor.permissions.filesystem === "workspace-write"
			? [`(subpath ${sandboxString(workspaceDir)})`]
			: []),
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
		tool.descriptor.permissions.network === "deny" ? "(deny network*)" : "(allow network*)",
	].join(" ");
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

function bwrapArguments(
	workspaceDir: string,
	scratchDir: string,
	environment: NodeJS.ProcessEnv,
	tool: ResolvedTargetTool,
	executable: string,
): string[] {
	const args = [
		"--die-with-parent",
		"--new-session",
		"--unshare-user",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--unshare-cgroup",
	];
	if (tool.descriptor.permissions.network === "deny") args.push("--unshare-net");
	args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
	for (const path of existingSystemPaths()) args.push("--ro-bind", path, path);
	args.push(
		tool.descriptor.permissions.filesystem === "workspace-write" ? "--bind" : "--ro-bind",
		workspaceDir,
		workspaceDir,
		"--bind",
		scratchDir,
		scratchDir,
		"--chdir",
		workspaceDir,
		"--clearenv",
	);
	for (const [name, value] of Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))) {
		if (value !== undefined) args.push("--setenv", name, value);
	}
	args.push("--", executable, ...tool.descriptor.command.argv.slice(1));
	return args;
}

function probeMacSandbox(binary: string, workspaceDir: string, scratchDir: string): boolean {
	const probeTool: ResolvedTargetTool = {
		descriptorPath: "tools/probe.tool.yaml",
		executablePath: "bin/probe",
		executableHash: "",
		digest: "",
		descriptor: {
			schemaVersion: 1,
			name: "probe",
			description: "probe",
			parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
			command: { argv: ["bin/probe"] },
			timeoutMs: 1_000,
			maxOutputBytes: 1,
			output: "text",
			permissions: { environment: [], network: "deny", filesystem: "read-only" },
		},
	};
	const probe = spawnSync(binary, ["-p", macosProfile(workspaceDir, scratchDir, probeTool), "/usr/bin/true"], {
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

function buildEnvironment(
	tool: ResolvedTargetTool,
	options: TargetToolBrokerOptions,
): { environment: NodeJS.ProcessEnv; names: string[] } {
	const home = join(options.scratchDir, "tool-home", tool.descriptor.name);
	const temporary = join(options.scratchDir, "tool-tmp", tool.descriptor.name);
	mkdirSync(home, { recursive: true, mode: 0o700 });
	mkdirSync(temporary, { recursive: true, mode: 0o700 });
	const source = options.sourceEnvironment ?? process.env;
	const environment: NodeJS.ProcessEnv = {
		PATH: source.PATH ?? "/usr/bin:/bin",
		LANG: source.LANG ?? "C.UTF-8",
		HOME: home,
		TMPDIR: temporary,
	};
	for (const name of tool.descriptor.permissions.environment) {
		if (FIXED_ENVIRONMENT.has(name)) continue;
		const value = source[name];
		if (value !== undefined) environment[name] = value;
	}
	return { environment, names: Object.keys(environment).sort() };
}

function invocation(
	backend: TargetToolSandboxBackend,
	workspaceDir: string,
	scratchDir: string,
	environment: NodeJS.ProcessEnv,
	tool: ResolvedTargetTool,
	executable: string,
): { executable: string; args: string[] } {
	if (backend === "sandbox-exec") {
		return {
			executable: "/usr/bin/sandbox-exec",
			args: [
				"-p",
				macosProfile(workspaceDir, scratchDir, tool),
				executable,
				...tool.descriptor.command.argv.slice(1),
			],
		};
	}
	const binary = executableOnPath("bwrap", process.env.PATH ?? "") ?? "/usr/bin/bwrap";
	return { executable: binary, args: bwrapArguments(workspaceDir, scratchDir, environment, tool, executable) };
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

	constructor(private readonly options: TargetToolBrokerOptions) {
		this.options.workspaceDir = realWorkspace(options.workspaceDir);
		this.options.scratchDir = resolve(options.scratchDir);
		mkdirSync(this.options.scratchDir, { recursive: true, mode: 0o700 });
		this.options.scratchDir = realpathSync(this.options.scratchDir);
		this.sandboxBackend = options.sandboxBackend ?? detectTargetToolSandbox(this.options.workspaceDir, this.options.scratchDir);
	}

	effectiveEnvironmentNames(tool: ResolvedTargetTool): string[] {
		return buildEnvironment(tool, this.options).names;
	}

	async execute(
		tool: ResolvedTargetTool,
		argumentsValue: unknown,
		signal?: AbortSignal,
	): Promise<TargetToolBrokerResult> {
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
		const executable = resolveStrictTargetFile(
			this.options.workspaceDir,
			tool.executablePath,
			`tool ${tool.descriptor.name} executable`,
		);
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
		const command = invocation(
			this.sandboxBackend,
			this.options.workspaceDir,
			this.options.scratchDir,
			environment,
			tool,
			executable,
		);
		const child = spawn(command.executable, command.args, {
			cwd: this.options.workspaceDir,
			detached: process.platform !== "win32",
			env: environment,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let stopped: "aborted" | "overflow" | "timeout" | undefined;
		let stdinError: Error | undefined;
		const collect = (destination: Buffer[]) => (chunk: Buffer) => {
			outputBytes += chunk.byteLength;
			if (outputBytes > tool.descriptor.maxOutputBytes) {
				if (!stopped) stopped = "overflow";
				killProcessTree(child.pid);
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
			if (!stopped) stopped = "aborted";
			killProcessTree(child.pid);
		};
		signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => {
			if (!stopped) stopped = "timeout";
			killProcessTree(child.pid);
		}, tool.descriptor.timeoutMs);

		try {
			child.stdin.end(input);
			const exitCode = await new Promise<number | null>((resolveExit, reject) => {
				child.once("error", reject);
				child.once("close", resolveExit);
			});
			if (stopped === "aborted" || signal?.aborted) throw new Error(`Target tool ${tool.descriptor.name} aborted`);
			if (stopped === "timeout") throw new Error(`Target tool ${tool.descriptor.name} timed out after ${tool.descriptor.timeoutMs}ms`);
			if (stopped === "overflow") {
				throw new Error(`Target tool ${tool.descriptor.name} exceeded ${tool.descriptor.maxOutputBytes} output bytes`);
			}
			if (stdinError) throw new Error(`Target tool ${tool.descriptor.name} could not read JSON input`, { cause: stdinError });
			const stderrText = decodeUtf8(Buffer.concat(stderr), `Target tool ${tool.descriptor.name} stderr`).trim();
			if (exitCode !== 0) {
				throw new Error(
					`Target tool ${tool.descriptor.name} exited with ${exitCode}${stderrText ? `: ${stderrText}` : ""}`,
				);
			}
			const text = decodeUtf8(Buffer.concat(stdout), `Target tool ${tool.descriptor.name} stdout`).trimEnd();
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
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
	}
}

function realWorkspace(path: string): string {
	const absolute = realpathSync(resolve(path));
	if (!statSync(absolute).isDirectory()) throw new Error(`Target tool workspace must be a directory: ${absolute}`);
	return absolute;
}
