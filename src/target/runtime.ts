import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	loadSkillsFromDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { ExecutionPolicyResult } from "../execution-policy.js";
import { EXECUTION_POLICY_SESSION_OPTIONS } from "../execution-policy.js";
import type { ResolvedTarget } from "../manifest.js";
import type { ExecutionFingerprint } from "../provenance.js";
import { TargetToolBroker, type TargetToolSandboxBackend } from "./tool-broker.js";
import { loadTargetTools, type ResolvedTargetTool } from "./tool-manifest.js";

export interface TargetToolRuntime {
	customTools: ToolDefinition<any, any, any>[];
	sandboxBackend: TargetToolSandboxBackend | null;
	effectiveEnvironmentNames: string[];
	toolNames: string[];
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
		return { customTools: [], sandboxBackend: null, effectiveEnvironmentNames: [], toolNames: [] };
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
	const broker = new TargetToolBroker({
		workspaceDir: options.workspaceDir,
		scratchDir: options.scratchDir,
		policy: options.target.manifest.execution,
		sourceEnvironment: options.sourceEnvironment,
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
}

/**
 * The single Target Pi construction seam. Eval and future interactive Target
 * sessions must call this factory so resource discovery and tool isolation do
 * not drift into two implementations.
 */
export async function createTargetAgentSession(options: CreateTargetAgentSessionOptions): Promise<{
	session: AgentSession;
	sessionManager: SessionManager;
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

	const agentsMdContent = readFileSync(resolve(options.cwd, options.target.manifest.instructions.agentsMd), "utf8");
	const skills = options.target.manifest.skills.flatMap((skillRel) =>
		loadSkillsFromDir({ dir: resolve(options.cwd, skillRel), source: "target" }).skills,
	);
	const services = await createAgentSessionServices({
		cwd: options.cwd,
		agentDir: options.agentDir,
		modelRuntime,
		settingsManager: SettingsManager.inMemory(),
		resourceLoaderOptions: {
			noContextFiles: true,
			noExtensions: true,
			noPromptTemplates: true,
			agentsFilesOverride: () => ({ agentsFiles: [{ path: "AGENTS.md", content: agentsMdContent }] }),
			skillsOverride: (base) => ({ skills, diagnostics: base.diagnostics }),
		},
	});
	const sessionManager = SessionManager.create(options.cwd, options.runDir);
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager,
		model: selected,
		thinkingLevel: model.thinkingLevel,
		...EXECUTION_POLICY_SESSION_OPTIONS,
		customTools: [...options.executionPolicy.customTools, ...options.targetTools.customTools],
	});
	session.agent.onPayload = (payload) => ({ ...(payload as Record<string, unknown>), ...model.params });
	return { session, sessionManager };
}
