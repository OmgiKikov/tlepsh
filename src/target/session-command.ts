import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedTarget } from "../manifest.js";
import { hashFile, type TokenMetrics } from "../provenance.js";
import { MAX_TRACE_ARTIFACT_BYTES, redactSensitiveText } from "../trace.js";
import { resolveExecutionBackend } from "./container-backend.js";
import {
	AHDE_TOOL_HOME_ENVIRONMENT,
	AHDE_WORLD_ENVIRONMENT,
	buildToolEnvironment,
	detectTargetToolSandbox,
	sandboxInvocation,
	type TargetToolConfinement,
	type TargetToolSandboxBackend,
} from "./tool-broker.js";
import {
	CANCEL_GRACE_MS,
	AgentMessageDecoder,
	encodeHostMessage,
	MAX_CAPTURED_STDERR_BYTES,
	MAX_TOOL_CALLS_PER_TURN,
	type AgentMessage,
	type HelloMessage,
	type HelloTool,
} from "./command-protocol.js";
import type { TargetToolRuntime } from "./runtime.js";
import { SessionJsonlWriter } from "./session-jsonl-writer.js";
import {
	FINAL_ANSWER_RECOVERY_PROMPT,
	type TargetSession,
	type TargetSessionStats,
	type TurnResult,
} from "./session.js";

/**
 * The command Target: one child process per Run, speaking protocol v1.
 *
 * Everything the Pi backend gets from being in-process this backend has to
 * earn explicitly — the sandbox is the same one a declared tool runs in, the
 * credential is injected by NAME into the child's environment and never onto
 * the wire, the tools the agent may call are exactly the ones `hello`
 * declared, and the transcript is written as canonical session JSONL so
 * `trace.ts` stays the single parser.
 *
 * Every failure here is infrastructure (invariant 9 and 43). A protocol
 * violation, an undeclared tool, a non-zero exit: none of them is evidence
 * that the agent answered badly, so all of them end the run as "error" with a
 * message stem a panel can count.
 */

/** The environment names a child process must never inherit (invariant 24). */
function assertLoaderSafeEnvironment(environment: NodeJS.ProcessEnv): void {
	const dangerous = Object.keys(environment).find((name) =>
		name === "NODE_OPTIONS" ||
		name === "LD_PRELOAD" ||
		name === "LD_AUDIT" ||
		name.startsWith("DYLD_"),
	);
	if (dangerous) {
		throw new Error(`command Target refused loader environment ${dangerous}`);
	}
}

/**
 * Resolve argv[0] to the exact bytes that will run. A bare name is looked up
 * on the child's own PATH and an absolute path is taken as written; a relative
 * path is refused outright, because "./agent" means something different
 * depending on a cwd the manifest does not control.
 */
function resolveEntryExecutable(name: string, pathValue: string): string {
	if (name.includes("/") && !isAbsolute(name)) {
		throw new Error(`command Target argv[0] must be an absolute path or a bare PATH name, got ${JSON.stringify(name)}`);
	}
	const candidates = isAbsolute(name)
		? [name]
		: pathValue.split(delimiter).filter(Boolean).map((entry) => join(entry, name));
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			return resolve(candidate);
		} catch {}
	}
	throw new Error(`command Target argv[0] ${JSON.stringify(name)} is not an executable on PATH`);
}

/**
 * The directories a sandbox must be able to read for argv[0] to start: where
 * the executable is, and — when it is a symlink — where it really lives.
 */
function entryReadRoots(entry: string): string[] {
	const roots = new Set([dirname(entry)]);
	try {
		roots.add(dirname(realpathSync(entry)));
	} catch {
		// An entry we cannot canonicalize is one the spawn will refuse anyway.
	}
	return [...roots];
}

/** The text a host tool result carries, whatever shape the definition returned. */
function toolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	const content = (result as { content?: unknown } | null)?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text")
		.map((part) => part.text)
		.join("");
}

export interface CreateCommandTargetSessionOptions {
	target: ResolvedTarget;
	/** The run's workspace copy. Also the child's cwd (invariant 19). */
	workspaceDir: string;
	scratchDir: string;
	/** Where `session.jsonl` is written, directly, as the dialogue happens. */
	runDir: string;
	targetTools: TargetToolRuntime;
	/**
	 * The exact host-selected Target credential. Injected into the child's
	 * environment under `model.apiKeyEnv` and nowhere else: never in
	 * `models.json`, never in the workspace, never on the wire (invariant 18).
	 */
	apiKey: string;
	/** Bounds ONE reply, not a whole conversation. From `model.timeoutMs`. */
	timeoutMs: number;
	/**
	 * Absolute path of this case's world state file, or null when the case has
	 * no world. This lane only passes the path; the file is the world lane's.
	 */
	worldPath: string | null;
	signal?: AbortSignal;
	onRecoveryAttempt?: () => void;
	sourceEnvironment?: NodeJS.ProcessEnv;
	/** Test seam: a previously probed backend. Production callers omit it. */
	sandboxBackend?: TargetToolSandboxBackend;
}

class CommandTargetSession implements TargetSession {
	readonly kind = "command" as const;

	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly tools = new Map<string, ToolDefinition<any, any, any>>();
	private readonly pending: AgentMessage[] = [];
	private waiter: (() => void) | undefined;
	/** Set once and never cleared: the first fatal condition owns the run. */
	private fatal: Error | undefined;
	private readonly decoder: AgentMessageDecoder;
	private stdoutBytes = 0;
	private stderrBytes = 0;
	private readonly stderrChunks: Buffer[] = [];
	private exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	private sawOutput = false;
	private turn = 0;
	private toolCalls = 0;
	private reportedToolCalls = 0;
	private tokens: TokenMetrics | null = null;
	private costUsd: number | null = null;
	private unknownRequestCost = false;
	private killed = false;

	constructor(
		private readonly child: ChildProcess,
		private readonly writer: SessionJsonlWriter,
		private readonly options: CreateCommandTargetSessionOptions,
		readonly agentEntryHash: string,
		tools: readonly ToolDefinition<any, any, any>[],
		private readonly teardown: { terminate?: () => void; dispose?: () => void },
	) {
		this.decoder = new AgentMessageDecoder(options.target.manifest.execution.command!.protocolVersion);
		for (const tool of tools) this.tools.set(tool.name, tool);
		this.child.stdout?.on("data", (chunk: Buffer) => this.readStdout(chunk));
		this.child.stdout?.on("end", () => {
			try { this.decoder.finish(); } catch (error) { this.fail(error as Error); }
		});
		this.child.stderr?.on("data", (chunk: Buffer) => this.readStderr(chunk));
		this.child.on("error", (error) => this.fail(new Error(`command Target could not run: ${error.message}`)));
		this.child.on("close", (code, signal) => {
			this.exited = { code, signal };
			this.wake();
		});
	}

	// -----------------------------------------------------------------------
	// The wire

	private readStdout(chunk: Buffer): void {
		this.stdoutBytes += chunk.byteLength;
		if (this.stdoutBytes > MAX_TRACE_ARTIFACT_BYTES) {
			this.fail(new Error(`command Target exceeded ${MAX_TRACE_ARTIFACT_BYTES} output bytes`));
			return;
		}
		try {
			const messages = this.decoder.push(chunk);
			this.sawOutput ||= messages.length > 0;
			this.pending.push(...messages);
		} catch (error) {
			this.fail(error as Error);
			return;
		}
		this.wake();
	}

	/**
	 * stderr is captured, bounded, and surfaces in exactly one place: the tail
	 * of an exit error. A command Target's diagnostics are not evidence, and
	 * letting them into the trace would give a second, unparsed format a way in.
	 */
	private readStderr(chunk: Buffer): void {
		if (this.stderrBytes >= MAX_CAPTURED_STDERR_BYTES) return;
		this.stderrBytes += chunk.byteLength;
		this.stderrChunks.push(Buffer.from(chunk));
	}

	private capturedStderr(): string {
		const text = Buffer.concat(this.stderrChunks).toString("utf8").slice(0, MAX_CAPTURED_STDERR_BYTES);
		return redactSensitiveText(text, [this.options.apiKey]).trim();
	}

	private fail(error: Error): void {
		this.fatal ??= error;
		this.wake();
	}

	private wake(): void {
		const waiter = this.waiter;
		this.waiter = undefined;
		waiter?.();
	}

	private send(message: Parameters<typeof encodeHostMessage>[0]): void {
		if (!this.child.stdin || this.child.stdin.destroyed) return;
		this.child.stdin.write(encodeHostMessage(message));
	}

	/**
	 * The next protocol message, or the reason there will not be one. Exit and
	 * timeout are decided here so every caller reports them identically.
	 */
	private async next(deadline: number): Promise<AgentMessage> {
		for (;;) {
			if (this.fatal) throw this.fatal;
			const message = this.pending.shift();
			if (message) return message;
			if (this.options.signal?.aborted) {
				throw this.options.signal.reason ?? new Error("run aborted");
			}
			if (this.exited) {
				const stderr = this.capturedStderr();
				// Never a protocol line: this child never started, and blaming the
				// conversation for something that happened before it began would
				// point a reader at the wrong half of the system.
				if (!this.sawOutput) {
					throw new Error(
						`command Target exited before its first protocol message with ${this.exited.signal ?? this.exited.code}${stderr ? `: ${stderr}` : ""}`,
					);
				}
				throw new Error(
					`command Target exited with ${this.exited.signal ?? this.exited.code}${stderr ? `: ${stderr}` : ""}`,
				);
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`run timed out after ${this.options.timeoutMs}ms`);
			await new Promise<void>((resolveWait) => {
				const timer = setTimeout(() => {
					this.waiter = undefined;
					resolveWait();
				}, Math.min(remaining, 250));
				this.waiter = () => {
					clearTimeout(timer);
					resolveWait();
				};
			});
		}
	}

	// -----------------------------------------------------------------------
	// Observation

	private emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// Observability is deliberately best-effort.
			}
		}
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	// -----------------------------------------------------------------------
	// One turn

	async takeTurn(prompt: string): Promise<TurnResult> {
		this.turn += 1;
		const text = await this.ask(prompt, false);
		if (text.trim()) return { text, recovered: false };
		// The same second ask an empty Pi answer earns, in this protocol's terms.
		this.options.onRecoveryAttempt?.();
		const recoveredText = await this.ask(FINAL_ANSWER_RECOVERY_PROMPT, true);
		// Silence twice is the agent's answer, not the host's failure: the turn
		// completes empty and the graders fail it (see session-pi.ts).
		if (!recoveredText.trim()) return { text: "", recovered: true, silent: true };
		return { text: recoveredText, recovered: true };
	}

	private async ask(prompt: string, recovery: boolean): Promise<string> {
		this.writer.user(prompt);
		this.send({
			v: this.options.target.manifest.execution.command!.protocolVersion,
			type: "user",
			turn: this.turn,
			text: prompt,
			...(recovery ? { recovery: true as const } : {}),
		});
		const deadline = Date.now() + this.options.timeoutMs;
		let callsThisTurn = 0;
		for (;;) {
			const message = await this.next(deadline);
			if ("turn" in message && message.turn !== this.turn) {
				throw new Error(`command Target ${message.type} refers to turn ${message.turn}, expected ${this.turn}`);
			}
			if (message.type === "assistant") {
				this.writer.assistant({
					...(message.text ? { text: message.text } : {}),
					...(message.thinking ? { thinking: message.thinking } : {}),
				});
				this.emit({
					type: "message_end",
					message: {
						role: "assistant",
						content: message.text ? [{ type: "text", text: message.text }] : [],
					},
				} as unknown as AgentSessionEvent);
				return message.text;
			}
			if (message.type === "usage") {
				if (message.v === 1) {
					this.tokens = { ...message.tokens };
				} else {
					this.tokens ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
					for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) this.tokens[key] += message.tokens[key];
					if (message.costUsd === undefined) this.unknownRequestCost = true;
				}
				if (message.costUsd !== undefined) this.costUsd = (this.costUsd ?? 0) + message.costUsd;
				continue;
			}
			if (message.type === "error") {
				throw new Error(`command Target reported an error: ${message.message}`);
			}
			callsThisTurn += 1;
			if (callsThisTurn > MAX_TOOL_CALLS_PER_TURN) {
				throw new Error(`command Target made more than ${MAX_TOOL_CALLS_PER_TURN} tool calls in one turn`);
			}
			if (message.type === "tool_note") {
				this.note(message.name, message.arguments, message.result, callsThisTurn);
				continue;
			}
			await this.broker(message.id, message.name, message.arguments);
		}
	}

	/**
	 * A self-report is trace context, not proof of execution. The marker survives
	 * parsing/export so neither a grader nor a reader mistakes it for a brokered call.
	 */
	private note(name: string, args: Record<string, unknown>, result: string, ordinal: number): void {
		const id = `note-${this.turn}-${ordinal}`;
		this.reportedToolCalls += 1;
		this.writer.assistant({ toolCalls: [{ id, name, arguments: args, evidence: "reported" }] });
		this.writer.toolResult({ toolCallId: id, toolName: name, text: result, isError: false });
	}

	private async broker(id: string, name: string, args: Record<string, unknown>): Promise<void> {
		this.toolCalls += 1;
		this.writer.assistant({ toolCalls: [{ id, name, arguments: args }] });
		this.emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args } as AgentSessionEvent);
		const tool = this.tools.get(name);
		if (!tool) {
			// The same refusal the Pi guard makes, for the same reason: a Target
			// reaching for a capability nobody granted it is infrastructure, not a
			// wrong answer. The agent is told, and then the run ends.
			const reason = `AHDE Target blocked undeclared tool ${JSON.stringify(name)}`;
			this.writer.toolResult({ toolCallId: id, toolName: name, text: reason, isError: true });
			this.emit({ type: "tool_execution_end", toolCallId: id, toolName: name, result: reason, isError: true } as AgentSessionEvent);
			this.send({ v: this.options.target.manifest.execution.command!.protocolVersion, type: "tool_result", id, name, text: reason, isError: true });
			throw new Error(reason);
		}
		let text: string;
		let isError = false;
		try {
			// `onUpdate` and the extension context are Pi's; a command Target has
			// neither, and every AHDE tool definition ignores both.
			const result = await tool.execute(id, args as never, this.options.signal, undefined as never, undefined as never);
			text = toolResultText(result);
		} catch (error) {
			isError = true;
			text = redactSensitiveText(error instanceof Error ? error.message : String(error), [this.options.apiKey]);
		}
		this.writer.toolResult({ toolCallId: id, toolName: name, text, isError });
		this.emit({ type: "tool_execution_end", toolCallId: id, toolName: name, result: text, isError } as AgentSessionEvent);
		this.send({ v: this.options.target.manifest.execution.command!.protocolVersion, type: "tool_result", id, name, text, isError });
	}

	// -----------------------------------------------------------------------
	// Lifecycle

	stats(): TargetSessionStats {
		return {
			// A command Target has no Pi session id, and inventing one would be a
			// claim about evidence that does not exist.
			sessionId: null,
			tokens: this.tokens,
			costUsd: this.unknownRequestCost ? null : this.costUsd,
			toolCalls: this.toolCalls,
			...(this.reportedToolCalls > 0 ? { reportedToolCalls: this.reportedToolCalls } : {}),
		};
	}

	finalizeTrace(_runDir: string): void {
		this.writer.finalize();
	}

	abort(): void {
		this.killTree();
	}

	async close(): Promise<void> {
		if (!this.exited && !this.killed) {
			this.send({ v: this.options.target.manifest.execution.command!.protocolVersion, type: "cancel" });
			this.child.stdin?.end();
			await new Promise<void>((resolveWait) => {
				if (this.exited) return resolveWait();
				const timer = setTimeout(resolveWait, CANCEL_GRACE_MS);
				this.child.once("close", () => {
					clearTimeout(timer);
					resolveWait();
				});
			});
		}
		this.killTree();
		try {
			this.teardown.terminate?.();
		} catch {}
		try {
			this.teardown.dispose?.();
		} catch {}
	}

	private killTree(): void {
		this.killed = true;
		const pid = this.child.pid;
		if (!pid || this.exited) return;
		try {
			if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
			else process.kill(pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	}
}

/**
 * Every environment name the child of a command Target actually receives.
 *
 * The provenance receipt exists to record what was handed to the agent, and
 * session 7 caught it listing four of seven: it was reporting the Pi execution
 * policy's environment, which is a different process's environment entirely.
 * The child gets the fixed four, whatever the manifest allowlisted AND the
 * host could actually read, the credential under the manifest's own
 * `apiKeyEnv` name, `AHDE_PROTOCOL`, and `AHDE_WORLD`. The last is listed
 * whether or not this particular case hands the child a world: the fingerprint
 * is the EXECUTION POLICY of the whole eval run, shared by every case in it
 * (live session 8 — listing it per case split one eval run into two policies
 * and `runSuite` refused the run), while which case carries a world is
 * dataset identity. Names only — a value never leaves this function
 * (invariant 18).
 *
 * Derived, not observed, because the fingerprint is written to disk BEFORE the
 * child is spawned; `createCommandTargetSession` builds the environment from
 * the same three inputs, and `tests/target-command-run.test.ts` pins the two
 * against what the child itself reports.
 */
export function commandTargetEnvironmentNames(options: {
	environmentAllowlist: readonly string[];
	apiKeyEnv: string;
	sourceEnvironment?: NodeJS.ProcessEnv;
}): string[] {
	const source = options.sourceEnvironment ?? process.env;
	const names = new Set(["PATH", "LANG", "HOME", "TMPDIR"]);
	for (const name of options.environmentAllowlist) {
		// The same rule `buildToolEnvironment` applies: a name the host cannot
		// read is a name the child never gets, so it is not recorded either.
		if (names.has(name) || name === AHDE_TOOL_HOME_ENVIRONMENT || name === AHDE_WORLD_ENVIRONMENT) continue;
		if (source[name] !== undefined) names.add(name);
	}
	names.add(options.apiKeyEnv);
	names.add("AHDE_PROTOCOL");
	names.add(AHDE_WORLD_ENVIRONMENT);
	return [...names].sort();
}

export interface CommandTargetSessionHandle {
	session: TargetSession;
	/**
	 * sha256 of argv[0]'s bytes as they were at spawn. Target identity on the
	 * same terms as a declared tool's executable (invariant 17), rehashed per
	 * spawn rather than trusted from resolution time.
	 */
	agentEntryHash: string;
}

export async function createCommandTargetSession(
	options: CreateCommandTargetSessionOptions,
): Promise<CommandTargetSessionHandle> {
	const execution = options.target.manifest.execution;
	const command = execution.command;
	if (!command) throw new Error("command Target requires an execution.command block");

	// Sandbox paths and the kernel's cwd must name the same directories. macOS
	// temp paths commonly arrive through /var while the kernel sees /private/var.
	// ToolBroker canonicalizes these too; command agents need the same boundary.
	// Do this before deriving HOME/TMPDIR: bwrap only mounts the canonical roots.
	mkdirSync(options.scratchDir, { recursive: true, mode: 0o700 });
	options = {
		...options,
		workspaceDir: realpathSync(options.workspaceDir),
		scratchDir: realpathSync(options.scratchDir),
		...(options.worldPath ? { worldPath: realpathSync(options.worldPath) } : {}),
	};
	const { environment } = buildToolEnvironment({
		label: "agent",
		scratchDir: options.scratchDir,
		environmentAllowlist: execution.environmentAllowlist,
		...(options.sourceEnvironment ? { sourceEnvironment: options.sourceEnvironment } : {}),
	});
	const model = options.target.manifest.model;
	environment[model.apiKeyEnv] = options.apiKey;
	environment.AHDE_PROTOCOL = String(command.protocolVersion);
	if (options.worldPath) environment.AHDE_WORLD = options.worldPath;
	assertLoaderSafeEnvironment(environment);

	const entry = resolveEntryExecutable(command.argv[0] as string, environment.PATH ?? "");
	const agentEntryHash = hashFile(readFileSync(entry).toString("base64"));

	const backend = options.sandboxBackend ?? resolveExecutionBackend({
		policy: execution,
		osBackend: () => detectTargetToolSandbox(options.workspaceDir, options.scratchDir),
	}).backend;

	// The child writes only where the manifest says the Target may write. A
	// read-only harness is the default; `write`/`edit` in `execution.tools` is
	// the only thing that opens the workspace copy.
	const writesWorkspace = execution.tools.includes("write") || execution.tools.includes("edit");
	const confinement: TargetToolConfinement = {
		network: execution.network,
		readRoots: [
			// The interpreter itself. A Python or Node Target's entry lives
			// wherever that toolchain was installed — a framework, a Homebrew
			// prefix, a version manager's shims — and a sandbox that cannot read
			// the binary it was asked to run fails in a way no operator can read.
			...entryReadRoots(entry),
			...(options.targetTools.toolHomeRoot ? [options.targetTools.toolHomeRoot] : []),
			...(options.worldPath ? [dirname(options.worldPath)] : []),
		],
		writeRoots: writesWorkspace ? [options.workspaceDir] : [],
	};
	const invocation = sandboxInvocation({
		backend,
		workspaceDir: options.workspaceDir,
		scratchDir: options.scratchDir,
		environment,
		confinement,
		cwd: options.workspaceDir,
		argv: [entry, ...command.argv.slice(1)],
		...(execution.container ? { container: execution.container } : {}),
		...(options.targetTools.toolHomeRoot ? { toolHomeRoot: options.targetTools.toolHomeRoot } : {}),
		lifecycleTimeoutMs: command.startupTimeoutMs,
	});
	invocation.assertReady?.();

	const child = spawn(invocation.executable, invocation.args, {
		cwd: options.workspaceDir,
		// Its own process group, so a timeout or an abort kills the whole tree
		// and not just the shim the sandbox wrapped it in.
		detached: process.platform !== "win32",
		env: invocation.spawnEnvironment ?? environment,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	child.stdin?.on("error", () => {
		// A child that closed stdin is reported by its exit, not by a write.
	});

	const writer = new SessionJsonlWriter(join(options.runDir, "session.jsonl"), MAX_TRACE_ARTIFACT_BYTES);
	const tools = options.targetTools.customTools;
	const session = new CommandTargetSession(child, writer, options, agentEntryHash, tools, {
		...(invocation.terminate ? { terminate: invocation.terminate } : {}),
		...(invocation.dispose ? { dispose: invocation.dispose } : {}),
	});

	// The one-time handshake. The credential travels by NAME; the value is
	// already in the child's environment under exactly that name.
	const hello: HelloMessage = {
		v: command.protocolVersion,
		type: "hello",
		tools: tools.map((tool): HelloTool => ({
			name: tool.name,
			description: tool.description,
			parameters: (tool.parameters ?? {}) as Record<string, unknown>,
		})),
		model: {
			provider: model.provider,
			id: model.id,
			baseUrl: model.baseUrl,
			apiKeyEnv: model.apiKeyEnv,
		},
		workspace: options.workspaceDir,
		world: options.worldPath,
	};
	await startupHandshake(child, hello, command.startupTimeoutMs);
	return { session, agentEntryHash };
}

/**
 * Write `hello` and confirm the child took it. A child that dies here never
 * started: reporting that as a mid-dialogue exit would blame the conversation
 * for something that happened before it began.
 */
function startupHandshake(
	child: ChildProcess,
	hello: Parameters<typeof encodeHostMessage>[0],
	startupTimeoutMs: number,
): Promise<void> {
	const line = encodeHostMessage(hello);
	return new Promise<void>((resolveStart, reject) => {
		const failStartup = () => {
			cleanup();
			reject(new Error(`command Target did not start within ${startupTimeoutMs}ms`));
		};
		const timer = setTimeout(failStartup, startupTimeoutMs);
		const onClose = () => failStartup();
		const cleanup = () => {
			clearTimeout(timer);
			child.off("close", onClose);
		};
		child.once("close", onClose);
		if (!child.stdin) {
			cleanup();
			reject(new Error("command Target has no stdin"));
			return;
		}
		child.stdin.write(line, (error) => {
			if (error) {
				cleanup();
				reject(new Error(`command Target did not start within ${startupTimeoutMs}ms`));
				return;
			}
			cleanup();
			resolveStart();
		});
	});
}
