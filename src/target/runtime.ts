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
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { ExecutionPolicyResult } from "../execution-policy.js";
import { EXECUTION_POLICY_SESSION_OPTIONS } from "../execution-policy.js";
import type { ResolvedTarget } from "../manifest.js";
import type { ExecutionFingerprint } from "../provenance.js";
import { detectTargetToolSandbox, TargetToolBroker, type TargetToolSandboxBackend } from "./tool-broker.js";
import { prepareToolHome, type ToolSetupOutcome } from "./tool-setup.js";
import { loadTargetTools, type ResolvedTargetTool } from "./tool-manifest.js";

export interface TargetToolRuntime {
	customTools: ToolDefinition<any, any, any>[];
	sandboxBackend: TargetToolSandboxBackend | null;
	effectiveEnvironmentNames: string[];
	toolNames: string[];
	/** Prepared home for multi-file tools, or null when none are declared. */
	toolHomeRoot: string | null;
	/** One entry per multi-file tool; `ran` is false when it declares no setup. */
	toolSetups: ToolSetupOutcome[];
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
	const processCapable = options.toolNames.some((tool) => !["read", "edit", "write"].includes(tool));
	return processCapable && (options.sandbox === "none" || options.sandbox === "unavailable")
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

export function createTargetToolRuntime(options: CreateTargetToolRuntimeOptions): TargetToolRuntime {
	if (options.target.tools.length === 0) {
		return {
			customTools: [],
			sandboxBackend: null,
			effectiveEnvironmentNames: [],
			toolNames: [],
			toolHomeRoot: null,
			toolSetups: [],
		};
	}
	const reloaded = loadTargetTools(
		options.workspaceDir,
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
	const sandboxBackend = needsToolHome
		? detectTargetToolSandbox(realpathSync(resolve(options.workspaceDir)), options.scratchDir)
		: undefined;
	const prepared = needsToolHome
		? prepareToolHome({
			workspaceDir: options.workspaceDir,
			scratchDir: options.scratchDir,
			tools: reloaded.tools,
			toolHomeRoot: options.toolHomeRoot ?? join(options.scratchDir, "tool-workshop"),
			policy: options.target.manifest.execution,
			...(sandboxBackend ? { sandboxBackend } : {}),
			...(options.sourceEnvironment ? { sourceEnvironment: options.sourceEnvironment } : {}),
		})
		: null;
	const broker = new TargetToolBroker({
		workspaceDir: options.workspaceDir,
		scratchDir: options.scratchDir,
		policy: options.target.manifest.execution,
		sourceEnvironment: options.sourceEnvironment,
		...(prepared ? { toolHomeRoot: prepared.root } : {}),
		...(sandboxBackend ? { sandboxBackend } : {}),
	});
	const environmentNames = new Set<string>();
	for (const tool of reloaded.tools) {
		for (const name of broker.effectiveEnvironmentNames(tool)) environmentNames.add(name);
	}
	return {
		customTools: reloaded.tools.map((tool) => definition(tool, broker)),
		sandboxBackend: broker.sandboxBackend,
		effectiveEnvironmentNames: [...environmentNames].sort(),
		toolNames: reloaded.tools.map((tool) => tool.descriptor.name),
		toolHomeRoot: prepared?.root ?? null,
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
	/** Forwarded when AgentSessionRuntime replaces an interactive session. */
	sessionStartEvent?: SessionStartEvent;
	/** Immutable host-captured resources reused by interactive replacement flows. */
	resourceBundle?: TargetResourceBundle;
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
			extensionFactories: [{
				name: "ahde-target-guard",
				hidden: true,
				factory: createTargetGuardExtension({
					allowedToolNames,
					thinkingLevel: model.thinkingLevel,
				}),
			}],
			agentsFilesOverride: () => ({ agentsFiles: [{ path: "AGENTS.md", content: resources.agentsMdContent }] }),
			skillsOverride: (base) => ({ skills: resources.skills, diagnostics: base.diagnostics }),
		},
	});
	const sessionManager = options.sessionManager ?? SessionManager.create(options.cwd, options.runDir);
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
	session.agent.onPayload = (payload) => ({ ...(payload as Record<string, unknown>), ...model.params });
	return { ...created, sessionManager, services, diagnostics: services.diagnostics };
}
