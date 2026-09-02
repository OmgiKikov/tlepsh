import {
	chmodSync,
	copyFileSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	loadSkillsFromDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionServices,
	type CreateAgentSessionResult,
	type ExtensionFactory,
	type SessionStartEvent,
	type Skill,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { ExecutionPolicyResult } from "../execution-policy.js";
import { EXECUTION_POLICY_SESSION_OPTIONS } from "../execution-policy.js";
import type { DialogueMessage, ResolvedTarget } from "../manifest.js";
import { ExecutionFingerprintSchema, hashValue, type ExecutionFingerprint } from "../provenance.js";
import {
	isContainerSandboxFingerprint,
	resolveExecutionBackend,
	type ContainerRuntimeName,
	type ContainerRuntimeStatus,
} from "./container-backend.js";
import { detectTargetToolSandbox, TargetToolBroker, type TargetToolSandboxBackend } from "./tool-broker.js";
import {
	EMPTY_PREPARED_TOOL_HOME_HASH,
	prepareToolHome,
	type ToolSetupOutcome,
} from "./tool-setup.js";
import { loadTargetTools, type ResolvedTargetTool } from "./tool-manifest.js";
import {
	createKbSearchTool,
	knowledgeBaseDeclared,
	readKnowledgeBase,
	KB_SEARCH_TOOL_NAME,
} from "./kb-tool.js";
import { kbIndexHash } from "../domain/kb.js";
import {
	createTargetFeedbackExtension,
	TARGET_FEEDBACK_EXTENSION_NAME,
	type TargetFeedbackChannel,
} from "./feedback-extension.js";

export interface TargetToolRuntime {
	customTools: ToolDefinition<any, any, any>[];
	/**
	 * The *OS* sandbox that confined this run, or null. Deliberately narrower
	 * than `TargetToolSandboxBackend`: a container run reports null here and
	 * carries its content-pinned identity in `sandboxFingerprint` instead.
	 */
	sandboxBackend: Exclude<TargetToolSandboxBackend, "container"> | null;
	/**
	 * The value the provenance `sandbox` axis must carry:
	 * `container:docker@sha256:…:config:…` for a containerized run, otherwise the OS
	 * backend's own name. Evidence produced in a container is never comparable
	 * with evidence produced on the host, by design.
	 */
	sandboxFingerprint: ExecutionFingerprint["sandbox"];
	/** Recorded, non-fatal findings such as a best-effort fallback. */
	sandboxWarnings: string[];
	effectiveEnvironmentNames: string[];
	toolNames: string[];
	/** Prepared home for multi-file tools, or null when none are declared. */
	toolHomeRoot: string | null;
	/**
	 * The setup-derived tool identity: the prepared home's tree attestation,
	 * folded with the knowledge-base index hash when one exists. See
	 * {@link composeSetupDerivedToolHash}.
	 */
	preparedToolHomeHash: string;
	/**
	 * Identity of the `kb_search` index this runtime serves, or null when no
	 * `data/kb` is declared. Null is not a hash of nothing: it is the fact that
	 * this Target has no knowledge base, and it keeps the composed hash
	 * byte-identical to what a Target without one has always recorded.
	 */
	kbIndexHash: string | null;
	/** One entry per multi-file tool; `ran` is false when it declares no setup. */
	toolSetups: ToolSetupOutcome[];
}

/**
 * The one place the setup-derived tool identity is assembled.
 *
 * A knowledge base changes what `kb_search` answers, so it changes the Target.
 * Its bytes already travel in `workspaceHash`; what a chunk index adds is the
 * *chunker* — the same documents cut differently are a different tool — and
 * that is a setup-derived fact, built once from the snapshot exactly like a
 * prepared tool home. `toolsetHash` is resolved from the operator's checkout
 * before a snapshot exists and deliberately never reads declared data
 * contents, so this is the honest home.
 *
 * Without a knowledge base the tree hash passes through unchanged, so every
 * hash recorded before this existed still reproduces.
 */
export function composeSetupDerivedToolHash(toolHomeHash: string, kbIndexHash: string | null): string {
	return kbIndexHash === null ? toolHomeHash : hashValue({ toolHome: toolHomeHash, kbIndex: kbIndexHash });
}

/**
 * The one sandbox identity persisted by both ordinary runs and candidate
 * preflight. Declared process tools own the effective backend when present;
 * otherwise the built-in execution policy does. Parsing here makes it
 * impossible to silently collapse a container into `none` or `unavailable`.
 */
export function effectiveTargetSandbox(options: {
	hasDeclaredTools: boolean;
	executionPolicy?: Pick<ExecutionPolicyResult, "sandboxFingerprint">;
	targetTools?: Pick<TargetToolRuntime, "sandboxFingerprint">;
}): ExecutionFingerprint["sandbox"] {
	const identity = options.hasDeclaredTools
		? options.targetTools?.sandboxFingerprint ?? "unavailable"
		: options.executionPolicy?.sandboxFingerprint ?? "unavailable";
	return ExecutionFingerprintSchema.shape.sandbox.parse(identity);
}

/**
 * Host-captured Target instructions. Interactive session replacement reuses
 * this bundle instead of rereading files the Target may have edited.
 */
export interface TargetResourceBundle {
	agentsMdContent: string;
	skills: Skill[];
}

function containedPath(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function declaredSkillDirectory(cwd: string, skillRel: string): string {
	const root = realpathSync(resolve(cwd));
	const lexical = resolve(root, skillRel);
	if (!containedPath(root, lexical)) throw new Error(`Target skill directory escapes workspace: ${skillRel}`);
	const rel = relative(root, lexical);
	let cursor = root;
	for (const part of rel.split(sep).filter(Boolean)) {
		cursor = join(cursor, part);
		const stat = lstatSync(cursor);
		if (stat.isSymbolicLink()) throw new Error(`Target skill directory traverses a symlink: ${skillRel}`);
		if (!stat.isDirectory()) throw new Error(`Target skill path is not a directory: ${skillRel}`);
	}
	const canonical = realpathSync(lexical);
	if (!containedPath(root, canonical)) throw new Error(`Target skill directory escapes workspace: ${skillRel}`);
	return canonical;
}

function snapshotSkillDirectory(source: string, destination: string): void {
	mkdirSync(destination, { mode: 0o700 });
	for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const sourcePath = join(source, entry.name);
		const destinationPath = join(destination, entry.name);
		const stat = lstatSync(sourcePath);
		if (stat.isSymbolicLink()) {
			throw new Error(`Target skill snapshot refuses symlink: ${relative(source, sourcePath)}`);
		}
		if (stat.isDirectory()) {
			snapshotSkillDirectory(sourcePath, destinationPath);
			continue;
		}
		if (!stat.isFile()) {
			throw new Error(`Target skill snapshot refuses non-regular file: ${relative(source, sourcePath)}`);
		}
		copyFileSync(sourcePath, destinationPath);
		chmodSync(destinationPath, (stat.mode & 0o555) | 0o400);
	}
	chmodSync(destination, 0o500);
}

function makeSnapshotWritable(path: string): void {
	let stat;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (stat.isDirectory() && !stat.isSymbolicLink()) {
		chmodSync(path, 0o700);
		for (const entry of readdirSync(path)) makeSnapshotWritable(join(path, entry));
	} else if (stat.isFile()) {
		chmodSync(path, 0o600);
	}
}

export function loadTargetResourceBundle(options: {
	target: ResolvedTarget;
	cwd: string;
	/** Optional private directory used to make skill bodies immutable for a session family. */
	snapshotDir?: string;
}): TargetResourceBundle {
	const agentsMdContent = readFileSync(
		resolve(options.cwd, options.target.manifest.instructions.agentsMd),
		"utf8",
	);
	if (!options.snapshotDir) {
		const skills = options.target.manifest.skills.flatMap((skillRel) =>
			loadSkillsFromDir({ dir: resolve(options.cwd, skillRel), source: "target" }).skills,
		);
		return { agentsMdContent, skills };
	}

	mkdirSync(options.snapshotDir, { recursive: true, mode: 0o700 });
	chmodSync(options.snapshotDir, 0o700);
	try {
		const skills = options.target.manifest.skills.flatMap((skillRel, index) => {
			const sourceDir = declaredSkillDirectory(options.cwd, skillRel);
			const snapshotSkillDir = join(options.snapshotDir!, String(index));
			snapshotSkillDirectory(sourceDir, snapshotSkillDir);
			return loadSkillsFromDir({ dir: snapshotSkillDir, source: "target" }).skills;
		});
		chmodSync(options.snapshotDir, 0o500);
		return { agentsMdContent, skills };
	} catch (error) {
		makeSnapshotWritable(options.snapshotDir);
		throw error;
	}
}

function createTargetGuardExtension(options: {
	allowedToolNames: readonly string[];
	thinkingLevel: ResolvedTarget["manifest"]["model"]["thinkingLevel"];
}): ExtensionFactory {
	const allowedToolNames = new Set(options.allowedToolNames);
	return (pi) => {
		// `!command` is a separate InteractiveMode execution path. Without a
		// handler Pi falls back to the host shell, bypassing the Target broker.
		pi.on("user_bash", () => ({
			result: {
				output: "AHDE Target disables interactive shell commands; ask the Target agent to use its declared tools.\n",
				exitCode: 126,
				cancelled: false,
				truncated: false,
			},
		}));
		pi.on("tool_call", (event) => {
			if (allowedToolNames.has(event.toolName)) return;
			return {
				block: true,
				reason: `AHDE Target blocked undeclared tool ${JSON.stringify(event.toolName)}`,
				terminate: true,
			};
		});
		// Pi exposes /thinking and a shortcut even with a one-model scope. Restore
		// the manifest identity synchronously before the next model turn.
		pi.on("thinking_level_select", (event) => {
			if (event.level !== options.thinkingLevel) pi.setThinkingLevel(options.thinkingLevel);
		});
		pi.on("session_before_switch", (event) => {
			if (event.reason === "resume") return { cancel: true };
		});
	};
}

export function targetFilesystemConfinement(options: {
	workspaceMode: "isolated" | "direct";
	toolNames: readonly string[];
	sandbox: ExecutionFingerprint["sandbox"];
}): ExecutionFingerprint["filesystem"] {
	if (options.workspaceMode === "direct") return "direct-unconfined-v1";
	const sandbox = ExecutionFingerprintSchema.shape.sandbox.parse(options.sandbox);
	if (isContainerSandboxFingerprint(sandbox)) return "workspace-confined-v1";
	// `kb_search` joins the built-in file tools here: it starts no process, takes
	// no path, and reads only the workspace copy it was built from, so it cannot
	// be the reason a run is recorded as unconfined.
	const inProcess = ["read", "edit", "write", KB_SEARCH_TOOL_NAME];
	const processCapable = options.toolNames.some((tool) => !inProcess.includes(tool));
	return processCapable && (sandbox === "none" || sandbox === "unavailable")
		? "isolated-copy-unconfined-v1"
		: "workspace-confined-v1";
}

export interface CreateTargetToolRuntimeOptions {
	target: ResolvedTarget;
	workspaceDir: string;
	scratchDir: string;
	sourceEnvironment?: NodeJS.ProcessEnv;
	/**
	 * Shared prepared home for multi-file tools. One EvalRun passes its
	 * snapshot-scoped root so every run reuses one setup; omitting it prepares a
	 * private home under `scratchDir` for this run alone.
	 */
	toolHomeRoot?: string;
	/** Container-runtime detection seam. Production callers omit this. */
	detectContainerRuntime?: (runtime: ContainerRuntimeName) => ContainerRuntimeStatus;
}

function assertWorkspaceToolIdentity(
	expected: readonly ResolvedTargetTool[],
	actual: readonly ResolvedTargetTool[],
	expectedToolsetHash: string,
	actualToolsetHash: string,
): void {
	if (expectedToolsetHash !== actualToolsetHash || expected.length !== actual.length) {
		throw new Error("Target declarative tools changed after target resolution");
	}
	for (const [index, expectedTool] of expected.entries()) {
		const actualTool = actual[index];
		if (!actualTool || actualTool.descriptor.name !== expectedTool.descriptor.name || actualTool.digest !== expectedTool.digest) {
			throw new Error(`Target declarative tool identity changed after target resolution: ${expectedTool.descriptor.name}`);
		}
	}
}

function definition(tool: ResolvedTargetTool, broker: TargetToolBroker): ToolDefinition<any, any, any> {
	return {
		name: tool.descriptor.name,
		label: tool.descriptor.name,
		description: tool.descriptor.description,
		promptSnippet: tool.descriptor.description,
		parameters: tool.descriptor.parameters as any,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const result = await broker.execute(tool, params, signal);
			return {
				content: [{ type: "text", text: result.text }],
				details: {
					toolDigest: result.toolDigest,
					exitCode: result.exitCode,
					outputType: tool.descriptor.output,
				},
			};
		},
	};
}

/**
 * The knowledge base this workspace serves, built once per runtime creation and
 * held for the life of the returned runtime. Null when the manifest declares no
 * `data/kb`: an agent that answers from nothing gets no retrieval tool, and the
 * absence stays out of the identity hash.
 */
function knowledgeBaseOf(
	target: ResolvedTarget,
	workspaceDir: string,
): { tool: ToolDefinition<any, any, any>; indexHash: string } | null {
	if (!knowledgeBaseDeclared(target.manifest.data)) return null;
	const chunks = readKnowledgeBase(workspaceDir);
	return { tool: createKbSearchTool(chunks), indexHash: kbIndexHash(chunks) };
}

export function createTargetToolRuntime(options: CreateTargetToolRuntimeOptions): TargetToolRuntime {
	if (options.target.tools.length === 0) {
		// A knowledge base is a whole Target surface on its own: an agent that only
		// answers from documents declares no subprocess tool at all, so the
		// no-declared-tools path has to be able to carry `kb_search`.
		const knowledge = knowledgeBaseOf(options.target, realpathSync(resolve(options.workspaceDir)));
		return {
			customTools: knowledge ? [knowledge.tool] : [],
			sandboxBackend: null,
			sandboxFingerprint: "unavailable",
			sandboxWarnings: [],
			effectiveEnvironmentNames: [],
			toolNames: knowledge ? [KB_SEARCH_TOOL_NAME] : [],
			toolHomeRoot: null,
			preparedToolHomeHash: composeSetupDerivedToolHash(
				EMPTY_PREPARED_TOOL_HOME_HASH,
				knowledge?.indexHash ?? null,
			),
			kbIndexHash: knowledge?.indexHash ?? null,
			toolSetups: [],
		};
	}
	// Sandbox profiles name concrete filesystem paths. macOS exposes its temp
	// directory through `/var` while the kernel resolves it as `/private/var`;
	// mixing the two spellings makes an otherwise allowed setup cwd unreadable
	// inside sandbox-exec. Canonicalize every runtime root once before it reaches
	// either backend so the profile, cwd and prepared tool home describe the same
	// bytes.
	const workspaceDir = realpathSync(resolve(options.workspaceDir));
	mkdirSync(resolve(options.scratchDir), { recursive: true, mode: 0o700 });
	const scratchDir = realpathSync(resolve(options.scratchDir));
	const reloaded = loadTargetTools(
		workspaceDir,
		options.target.manifest.tools,
		options.target.manifest.execution,
	);
	assertWorkspaceToolIdentity(
		options.target.tools,
		reloaded.tools,
		options.target.toolsetHash,
		reloaded.toolsetHash,
	);
	const needsToolHome = reloaded.tools.some((tool) => tool.layout === "directory");
	// Detecting the backend once keeps preparation and execution on one decision.
	// A container backend must be decided here too: the declared `setup` step
	// has to run inside the same container the tool calls will run in.
	const execution = options.target.manifest.execution;
	const choice = needsToolHome || execution.container
		? resolveExecutionBackend({
			policy: execution,
			osBackend: () => detectTargetToolSandbox(workspaceDir, scratchDir),
			...(options.detectContainerRuntime ? { detect: options.detectContainerRuntime } : {}),
		})
		: undefined;
	const sandboxBackend = choice?.backend;
	const requestedToolHomeRoot = options.toolHomeRoot ?? join(scratchDir, "tool-workshop");
	if (needsToolHome) mkdirSync(resolve(requestedToolHomeRoot), { recursive: true, mode: 0o700 });
	const toolHomeRoot = needsToolHome ? realpathSync(resolve(requestedToolHomeRoot)) : undefined;
	const prepared = needsToolHome
		? prepareToolHome({
			workspaceDir,
			scratchDir,
			tools: reloaded.tools,
			toolHomeRoot: toolHomeRoot as string,
			policy: options.target.manifest.execution,
			...(sandboxBackend ? { sandboxBackend } : {}),
			...(choice?.containerRuntime ? { containerRuntime: choice.containerRuntime } : {}),
			...(options.sourceEnvironment ? { sourceEnvironment: options.sourceEnvironment } : {}),
		})
		: null;
	const broker = new TargetToolBroker({
		workspaceDir,
		scratchDir,
		policy: options.target.manifest.execution,
		sourceEnvironment: options.sourceEnvironment,
		...(prepared ? { toolHomeRoot: prepared.root } : {}),
		...(sandboxBackend ? { sandboxBackend } : {}),
		...(choice?.containerRuntime ? { containerRuntime: choice.containerRuntime } : {}),
	});
	const environmentNames = new Set<string>();
	for (const tool of reloaded.tools) {
		for (const name of broker.effectiveEnvironmentNames(tool)) environmentNames.add(name);
	}
	// The host tool joins the declared ones on one list, so the guard extension's
	// allowed-tool set, the capability names a run records, and whatever a future
	// adapter brokers all see the same surface without a second registration.
	const knowledge = knowledgeBaseOf(options.target, workspaceDir);
	return {
		customTools: [
			...reloaded.tools.map((tool) => definition(tool, broker)),
			...(knowledge ? [knowledge.tool] : []),
		],
		sandboxBackend: broker.sandboxBackend === "container" ? null : broker.sandboxBackend,
		sandboxFingerprint: choice?.sandboxFingerprint ?? broker.sandboxBackend,
		sandboxWarnings: choice?.warnings ?? [],
		effectiveEnvironmentNames: [...environmentNames].sort(),
		toolNames: [
			...reloaded.tools.map((tool) => tool.descriptor.name),
			...(knowledge ? [KB_SEARCH_TOOL_NAME] : []),
		],
		toolHomeRoot: prepared?.root ?? null,
		preparedToolHomeHash: composeSetupDerivedToolHash(
			prepared?.sha256 ?? EMPTY_PREPARED_TOOL_HOME_HASH,
			knowledge?.indexHash ?? null,
		),
		kbIndexHash: knowledge?.indexHash ?? null,
		toolSetups: prepared?.setups ?? [],
	};
}

export interface CreateTargetAgentSessionOptions {
	target: ResolvedTarget;
	cwd: string;
	agentDir: string;
	runDir: string;
	modelsPath: string;
	executionPolicy: ExecutionPolicyResult;
	targetTools: TargetToolRuntime;
	/** Exact host-selected Target credential; never persisted by this factory. */
	apiKey: string;
	/** Runtime-owned manager used by Pi session replacement flows. */
	sessionManager?: SessionManager;
	/**
	 * Conversation to seed before the first prompt (a dialogue case's earlier
	 * turns). Appended to the session manager, which is exactly how Pi restores
	 * a conversation, so the turns are both in the trace and in the model's
	 * context for the graded prompt.
	 */
	seedMessages?: readonly DialogueMessage[];
	/** Forwarded when AgentSessionRuntime replaces an interactive session. */
	sessionStartEvent?: SessionStartEvent;
	/** Immutable host-captured resources reused by interactive replacement flows. */
	resourceBundle?: TargetResourceBundle;
	/**
	 * Present only for the interactive Target: registers `/good` and `/bad` and
	 * routes every mark to the parent process. Eval runs never mark anything.
	 */
	feedbackChannel?: TargetFeedbackChannel;
}

/** No usage: a seeded turn was never generated here and must not be billed. */
const SEEDED_TURN_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

/** One prior dialogue turn as the Pi session message it stands in for. */
function seededSessionMessage(
	turn: DialogueMessage,
	model: ResolvedTarget["manifest"]["model"],
): Message {
	const timestamp = Date.now();
	if (turn.role === "user") {
		return { role: "user", content: [{ type: "text", text: turn.content }], timestamp };
	}
	return {
		role: "assistant",
		content: [{ type: "text", text: turn.content }],
		// The manifest carries the api id as a string; Pi types it as a union.
		api: model.api as AssistantMessage["api"],
		provider: model.provider,
		model: model.id,
		usage: { ...SEEDED_TURN_USAGE, cost: { ...SEEDED_TURN_USAGE.cost } },
		stopReason: "stop",
		timestamp,
	};
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text")
		.map((part) => part.text)
		.join("");
}

/** The restored conversation must end with exactly the turns that were seeded. */
function assertSeededHistory(
	restored: readonly { role: string; content?: unknown }[],
	seeded: readonly DialogueMessage[],
): void {
	const tail = restored.slice(-seeded.length);
	const matches = tail.length === seeded.length &&
		seeded.every((turn, index) =>
			tail[index]?.role === turn.role && messageText(tail[index]?.content) === turn.content);
	if (!matches) {
		throw new Error(
			`Target session restored ${restored.length} message(s) that do not end with the ${seeded.length} seeded dialogue turn(s)`,
		);
	}
}

/**
 * The single Target Pi construction seam. Eval and future interactive Target
 * sessions must call this factory so resource discovery and tool isolation do
 * not drift into two implementations.
 */
export async function createTargetAgentSession(options: CreateTargetAgentSessionOptions): Promise<CreateAgentSessionResult & {
	session: AgentSession;
	sessionManager: SessionManager;
	services: AgentSessionServices;
	diagnostics: AgentSessionServices["diagnostics"];
}> {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(options.target.manifest.model.provider, async () => ({
		type: "api_key",
		key: options.apiKey,
	}));
	const modelRuntime = await ModelRuntime.create({
		modelsPath: options.modelsPath,
		credentials,
		allowModelNetwork: false,
	});
	const model = options.target.manifest.model;
	const selected = modelRuntime.getModel(model.provider, model.id);
	if (!selected) throw new Error(`model ${model.provider}/${model.id} not found in generated models.json`);

	const resources = options.resourceBundle ?? loadTargetResourceBundle({ target: options.target, cwd: options.cwd });
	const allowedToolNames = [
		...options.executionPolicy.customTools.map((tool) => tool.name),
		...options.targetTools.customTools.map((tool) => tool.name),
	];
	const services = await createAgentSessionServices({
		cwd: options.cwd,
		agentDir: options.agentDir,
		modelRuntime,
		settingsManager: SettingsManager.inMemory(),
		resourceLoaderOptions: {
			noContextFiles: true,
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [
				{
					name: "ahde-target-guard",
					hidden: true,
					factory: createTargetGuardExtension({
						allowedToolNames,
						thinkingLevel: model.thinkingLevel,
					}),
				},
				...(options.feedbackChannel
					? [{
						name: TARGET_FEEDBACK_EXTENSION_NAME,
						hidden: true,
						factory: createTargetFeedbackExtension({ channel: options.feedbackChannel }),
					}]
					: []),
			],
			agentsFilesOverride: () => ({ agentsFiles: [{ path: "AGENTS.md", content: resources.agentsMdContent }] }),
			skillsOverride: (base) => ({ skills: resources.skills, diagnostics: base.diagnostics }),
		},
	});
	const sessionManager = options.sessionManager ?? SessionManager.create(options.cwd, options.runDir);
	// Seeded before construction: Pi restores a session manager that already has
	// messages into agent.state.messages, so the history reaches the model with
	// no runner surgery and stays in session.jsonl as ordinary evidence.
	const seedMessages = options.seedMessages ?? [];
	for (const turn of seedMessages) {
		sessionManager.appendMessage(seededSessionMessage(turn, model));
	}
	const created = await createAgentSessionFromServices({
		services,
		sessionManager,
		sessionStartEvent: options.sessionStartEvent,
		model: selected,
		thinkingLevel: model.thinkingLevel,
		// Target model choice is manifest identity, not an interactive preference.
		// Scoping also prevents ambient host credentials from making unrelated
		// built-in providers selectable inside Target InteractiveMode.
		scopedModels: [{ model: selected, thinkingLevel: model.thinkingLevel }],
		...EXECUTION_POLICY_SESSION_OPTIONS,
		customTools: [...options.executionPolicy.customTools, ...options.targetTools.customTools],
	});
	const { session } = created;
	// A silently unseeded dialogue would grade the last turn out of context and
	// still look like an ordinary answer, so the restore is checked, never assumed.
	if (seedMessages.length > 0) assertSeededHistory(session.agent.state.messages, seedMessages);
	session.agent.onPayload = (payload) => ({ ...(payload as Record<string, unknown>), ...model.params });
	return { ...created, sessionManager, services, diagnostics: services.diagnostics };
}
