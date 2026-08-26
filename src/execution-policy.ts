import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type BashOperations,
	type EditOperations,
	type ReadOperations,
	type ToolDefinition,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

export type ExecutionTool = "read" | "bash" | "edit" | "write";
export type SandboxBackend = "sandbox-exec" | "bwrap" | "none";

export interface ExecutionPolicy {
	tools: ExecutionTool[];
	environmentAllowlist: string[];
	network: "deny" | "allow";
	sandbox: "required" | "best-effort" | "off";
}

export interface ExecutionPolicyOptions {
	workspaceDir: string;
	scratchDir: string;
	policy: ExecutionPolicy;
	environment: {
		PATH: string;
		LANG: string;
		HOME: string;
		TMPDIR: string;
	};
	/** Environment from which explicitly allowlisted values are copied. Defaults to process.env. */
	sourceEnvironment?: NodeJS.ProcessEnv;
}

export interface ExecutionPolicyResult {
	customTools: ToolDefinition<any, any, any>[];
	sandboxBackend: SandboxBackend;
	effectiveEnvironmentNames: string[];
}

/**
 * Pass this together with result.customTools to createAgentSession(). Custom definitions
 * intentionally have the built-in names, so the built-ins must not remain active.
 */
export const EXECUTION_POLICY_SESSION_OPTIONS = { noTools: "builtin" as const };

const FIXED_ENVIRONMENT_NAMES = new Set(["PATH", "LANG", "HOME", "TMPDIR"]);
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isContained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertContained(root: string, candidate: string, label: string): void {
	if (!isContained(root, candidate)) {
		throw new Error(`Execution policy refused ${label} outside workspace: ${candidate}`);
	}
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function existingPathIn(root: string, candidate: string, label = "path"): Promise<string> {
	let canonical: string;
	try {
		canonical = await realpath(resolve(candidate));
	} catch (error) {
		throw new Error(`Execution policy could not resolve ${label}: ${candidate}`, { cause: error });
	}
	assertContained(root, canonical, label);
	return canonical;
}

async function creationPathIn(root: string, candidate: string, label = "path"): Promise<string> {
	let cursor = resolve(candidate);
	const missingParts: string[] = [];

	for (;;) {
		try {
			const info = await lstat(cursor);
			if (info.isSymbolicLink()) {
				let canonical: string;
				try {
					canonical = await realpath(cursor);
				} catch (error) {
					throw new Error(`Execution policy refused dangling symlink in ${label}: ${cursor}`, { cause: error });
				}
				assertContained(root, canonical, label);
				return join(canonical, ...missingParts);
			}

			const canonical = await realpath(cursor);
			assertContained(root, canonical, label);
			const result = join(canonical, ...missingParts);
			assertContained(root, result, label);
			return result;
		} catch (error) {
			if (!isMissing(error)) throw error;
			const parent = dirname(cursor);
			if (parent === cursor) throw error;
			missingParts.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
			cursor = parent;
		}
	}
}

function creationPathInSync(root: string, candidate: string, label: string): string {
	let cursor = resolve(candidate);
	const missingParts: string[] = [];

	for (;;) {
		try {
			const info = lstatSync(cursor);
			if (info.isSymbolicLink()) {
				let canonical: string;
				try {
					canonical = realpathSync(cursor);
				} catch (error) {
					throw new Error(`Execution policy refused dangling symlink in ${label}: ${cursor}`, { cause: error });
				}
				assertContained(root, canonical, label);
				return join(canonical, ...missingParts);
			}
			const canonical = realpathSync(cursor);
			assertContained(root, canonical, label);
			const result = join(canonical, ...missingParts);
			assertContained(root, result, label);
			return result;
		} catch (error) {
			if (!isMissing(error)) throw error;
			const parent = dirname(cursor);
			if (parent === cursor) throw error;
			missingParts.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
			cursor = parent;
		}
	}
}

function canonicalDirectory(path: string, label: string): string {
	let canonical: string;
	try {
		canonical = realpathSync(resolve(path));
	} catch (error) {
		throw new Error(`Execution policy could not resolve ${label}: ${path}`, { cause: error });
	}
	if (!statSync(canonical).isDirectory()) throw new Error(`${label} must be a directory: ${canonical}`);
	return canonical;
}

function isolatedDirectory(scratchDir: string, requested: string, label: string): string {
	const safePath = creationPathInSync(scratchDir, requested, label);
	mkdirSync(safePath, { recursive: true, mode: 0o700 });
	const canonical = canonicalDirectory(safePath, label);
	assertContained(scratchDir, canonical, label);
	return canonical;
}

function buildEnvironment(options: ExecutionPolicyOptions, scratchDir: string): NodeJS.ProcessEnv {
	for (const name of options.policy.environmentAllowlist) {
		if (!ENVIRONMENT_NAME.test(name)) throw new Error(`Invalid environment variable name: ${name}`);
	}

	const home = isolatedDirectory(scratchDir, options.environment.HOME, "isolated HOME");
	const temporary = isolatedDirectory(scratchDir, options.environment.TMPDIR, "isolated TMPDIR");
	const environment: NodeJS.ProcessEnv = {
		PATH: options.environment.PATH,
		LANG: options.environment.LANG,
		HOME: home,
		TMPDIR: temporary,
	};
	const source = options.sourceEnvironment ?? process.env;
	for (const name of options.policy.environmentAllowlist) {
		if (FIXED_ENVIRONMENT_NAMES.has(name)) continue;
		const value = source[name];
		if (value !== undefined) environment[name] = value;
	}
	return environment;
}

function filesystemOperations(workspaceDir: string): {
	read: ReadOperations;
	edit: EditOperations;
	write: WriteOperations;
} {
	const readExisting = (path: string) => existingPathIn(workspaceDir, path);
	const writeTarget = (path: string) => creationPathIn(workspaceDir, path);
	const writeConfined = async (path: string, content: string) => {
		const safePath = await writeTarget(path);
		const handle = await open(
			safePath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await handle.writeFile(content, "utf8");
		} finally {
			await handle.close();
		}
	};

	return {
		read: {
			access: async (path) => access(await readExisting(path), constants.R_OK),
			readFile: async (path) => readFile(await readExisting(path)),
		},
		edit: {
			access: async (path) => access(await readExisting(path), constants.R_OK | constants.W_OK),
			readFile: async (path) => readFile(await readExisting(path)),
			writeFile: writeConfined,
		},
		write: {
			mkdir: async (path) => {
				const safePath = await writeTarget(path);
				await mkdir(safePath, { recursive: true });
				await existingPathIn(workspaceDir, safePath);
			},
			writeFile: writeConfined,
		},
	};
}

function executableOnPath(name: string, pathValue: string): string | undefined {
	const candidates = isAbsolute(name)
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

function macosProfile(workspaceDir: string, scratchDir: string, network: "deny" | "allow"): string {
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
		`(allow file-write* (literal "/dev/null") (subpath ${sandboxString(workspaceDir)}) (subpath ${sandboxString(scratchDir)}))`,
		network === "deny" ? "(deny network*)" : "(allow network*)",
	].join(" ");
}

function bwrapArguments(
	workspaceDir: string,
	scratchDir: string,
	environment: NodeJS.ProcessEnv,
	network: "deny" | "allow",
	command: string,
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
	if (network === "deny") args.push("--unshare-net");
	args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
	for (const systemPath of ["/usr", "/bin", "/sbin", "/lib", "/lib64"]) {
		try {
			if (statSync(systemPath)) args.push("--ro-bind", systemPath, systemPath);
		} catch {}
	}
	args.push("--bind", workspaceDir, workspaceDir, "--bind", scratchDir, scratchDir, "--chdir", workspaceDir);
	args.push("--clearenv");
	for (const [name, value] of Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))) {
		if (value !== undefined) args.push("--setenv", name, value);
	}
	args.push("--", "/bin/sh", "-c", command);
	return args;
}

function sandboxInvocation(
	backend: SandboxBackend,
	binary: string | undefined,
	profile: string,
	workspaceDir: string,
	scratchDir: string,
	environment: NodeJS.ProcessEnv,
	network: "deny" | "allow",
	command: string,
): { executable: string; args: string[] } {
	if (backend === "sandbox-exec" && binary) {
		return { executable: binary, args: ["-p", profile, "/bin/sh", "-c", command] };
	}
	if (backend === "bwrap" && binary) {
		return {
			executable: binary,
			args: bwrapArguments(workspaceDir, scratchDir, environment, network, command),
		};
	}
	return { executable: "/bin/sh", args: ["-c", command] };
}

function detectSandbox(
	options: ExecutionPolicyOptions,
	workspaceDir: string,
	scratchDir: string,
	environment: NodeJS.ProcessEnv,
): { backend: SandboxBackend; binary?: string; profile: string } {
	const profile = macosProfile(workspaceDir, scratchDir, options.policy.network);
	if (!options.policy.tools.includes("bash") || options.policy.sandbox === "off") {
		if (options.policy.tools.includes("bash") && options.policy.network === "deny") {
			throw new Error("network=deny requires sandbox=required or sandbox=best-effort");
		}
		return { backend: "none", profile };
	}

	let backend: SandboxBackend = "none";
	let binary: string | undefined;
	if (process.platform === "darwin") {
		binary = executableOnPath("/usr/bin/sandbox-exec", environment.PATH ?? "");
		if (binary) backend = "sandbox-exec";
	} else if (process.platform === "linux") {
		binary = executableOnPath("bwrap", environment.PATH ?? "") ?? executableOnPath("/usr/bin/bwrap", "");
		if (binary) backend = "bwrap";
	}

	if (backend !== "none") {
		const invocation = sandboxInvocation(
			backend,
			binary,
			profile,
			workspaceDir,
			scratchDir,
			environment,
			options.policy.network,
			":",
		);
		const probe = spawnSync(invocation.executable, invocation.args, {
			cwd: workspaceDir,
			env: environment,
			stdio: "ignore",
			timeout: 3_000,
		});
		if (probe.status !== 0 || probe.error) {
			backend = "none";
			binary = undefined;
		}
	}

	if (backend === "none" && options.policy.tools.includes("bash") && options.policy.network === "deny") {
		throw new Error(`No usable sandbox backend for ${process.platform}; network=deny fails closed for bash`);
	}
	if (backend === "none" && options.policy.sandbox === "required") {
		throw new Error(`No usable sandbox backend for ${process.platform}; required policy fails closed`);
	}
	return { backend, binary, profile };
}

function terminateProcess(pid: number | undefined): void {
	if (!pid) return;
	try {
		if (process.platform !== "win32") process.kill(-pid, "SIGTERM");
		else process.kill(pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {}
	}
}

function bashOperations(
	backend: SandboxBackend,
	binary: string | undefined,
	profile: string,
	workspaceDir: string,
	scratchDir: string,
	environment: NodeJS.ProcessEnv,
	network: "deny" | "allow",
): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			if (signal?.aborted) throw new Error("aborted");
			if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1_000 > 2_147_483_647)) {
				throw new Error("Invalid timeout: must be a positive, bounded number of seconds");
			}
			const canonicalCwd = await existingPathIn(workspaceDir, cwd, "bash cwd");
			const invocation = sandboxInvocation(
				backend,
				binary,
				profile,
				workspaceDir,
				scratchDir,
				environment,
				network,
				command,
			);
			const child = spawn(invocation.executable, invocation.args, {
				cwd: canonicalCwd,
				detached: process.platform !== "win32",
				env: environment,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			child.stdout.on("data", (chunk: Buffer) => onData(chunk));
			child.stderr.on("data", (chunk: Buffer) => onData(chunk));

			let stopped: "aborted" | "timeout" | undefined;
			const stopForAbort = () => {
				stopped = "aborted";
				terminateProcess(child.pid);
			};
			signal?.addEventListener("abort", stopForAbort, { once: true });
			const timer = timeout === undefined
				? undefined
				: setTimeout(() => {
					stopped = "timeout";
					terminateProcess(child.pid);
				}, timeout * 1_000);

			try {
				const exitCode = await new Promise<number | null>((resolveExit, reject) => {
					child.once("error", reject);
					child.once("close", resolveExit);
				});
				if (stopped === "aborted" || signal?.aborted) throw new Error("aborted");
				if (stopped === "timeout") throw new Error(`timeout:${timeout}`);
				return { exitCode };
			} finally {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", stopForAbort);
			}
		},
	};
}

export function buildExecutionPolicy(options: ExecutionPolicyOptions): ExecutionPolicyResult {
	const workspaceDir = canonicalDirectory(options.workspaceDir, "workspaceDir");
	const requestedScratch = resolve(options.scratchDir);
	mkdirSync(requestedScratch, { recursive: true, mode: 0o700 });
	const scratchDir = canonicalDirectory(requestedScratch, "scratchDir");
	const environment = buildEnvironment(options, scratchDir);
	const sandbox = detectSandbox(options, workspaceDir, scratchDir, environment);
	const operations = filesystemOperations(workspaceDir);
	const tools = [...new Set(options.policy.tools)];
	const customTools: ToolDefinition<any, any, any>[] = [];

	for (const tool of tools) {
		if (tool === "read") customTools.push(createReadToolDefinition(workspaceDir, { operations: operations.read }));
		else if (tool === "edit") customTools.push(createEditToolDefinition(workspaceDir, { operations: operations.edit }));
		else if (tool === "write") customTools.push(createWriteToolDefinition(workspaceDir, { operations: operations.write }));
		else if (tool === "bash") {
			customTools.push(
				createBashToolDefinition(workspaceDir, {
					exposeSessionEnvironment: false,
					spawnHook: ({ command, cwd }) => ({ command, cwd, env: { ...environment } }),
					operations: bashOperations(
						sandbox.backend,
						sandbox.binary,
						sandbox.profile,
						workspaceDir,
						scratchDir,
						environment,
						options.policy.network,
					),
				}),
			);
		}
	}

	return {
		customTools,
		sandboxBackend: sandbox.backend,
		effectiveEnvironmentNames: Object.keys(environment).sort(),
	};
}
