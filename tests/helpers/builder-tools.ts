import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAhdeBuilderTools } from "../../src/builder/extension.js";
import type { BuilderExtensionOptions } from "../../src/builder/extension.js";
import type { TargetManifest } from "../../src/manifest.js";

/**
 * Shared plumbing for the tests that drive the three production Builder tools
 * (`ahde_workbench_view` / `_submit` / `_decide`). Nothing here grants
 * authority: the host context is the only place a confirmation can come from.
 */

export function modelDefinition(
	provider: string,
	id: string,
	baseUrl: string,
	apiKeyEnv: string,
): TargetManifest["model"] {
	return {
		provider,
		id,
		api: "openai-completions",
		baseUrl,
		apiKeyEnv,
		thinkingLevel: "off",
		timeoutMs: 60_000,
		params: {},
		spec: {
			reasoning: false,
			contextWindow: 131_072,
			maxTokens: 4_096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: {},
		},
	};
}

/** One exact entry of the trusted host catalog `configure-target` resolves against. */
export function hostCatalogModel(provider: string, id: string, baseUrl: string): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 4_096,
	};
}

export interface HostContextOptions {
	hasUI?: boolean;
	mode?: ExtensionContext["mode"];
	/** Answer for every gate confirmation; `false` declines. */
	confirm?: boolean;
	/** Trusted catalog lookup used only by `configure-target`. */
	catalog?: (provider: string, modelId: string) => Model<Api> | undefined;
	/** Environment variable name offered for the Target credential. */
	credentialEnv?: string;
}

export interface RecordingHostContext {
	ctx: ExtensionContext;
	confirmations: { title: string; body: string }[];
	selections: { title: string; choices: readonly string[] }[];
}

/** A fake TUI host: it records what the human was shown and answers uniformly. */
export function createHostContext(options: HostContextOptions = {}): RecordingHostContext {
	const confirmations: { title: string; body: string }[] = [];
	const selections: { title: string; choices: readonly string[] }[] = [];
	const hasUI = options.hasUI ?? true;
	const ctx = {
		hasUI,
		mode: options.mode ?? (hasUI ? "tui" : "print"),
		ui: {
			confirm: async (title: string, body: string) => {
				confirmations.push({ title, body });
				return options.confirm ?? true;
			},
			select: async (title: string, choices: readonly string[]) => {
				selections.push({ title, choices });
				return choices[0];
			},
			input: async () => options.credentialEnv,
			notify: () => undefined,
			setStatus: () => undefined,
			setWidget: () => undefined,
		},
		modelRegistry: { find: options.catalog ?? (() => undefined) },
	} as unknown as ExtensionContext;
	return { ctx, confirmations, selections };
}

export function productionTools(options: BuilderExtensionOptions): readonly ToolDefinition[] {
	return createAhdeBuilderTools(options) as readonly ToolDefinition[];
}

export function toolNamed(tools: readonly ToolDefinition[], name: string): ToolDefinition {
	const found = tools.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`missing production Builder tool ${name}`);
	return found;
}

/** Invoke one production tool exactly as Pi would and parse its model-visible text. */
export async function invokeTool(
	tools: readonly ToolDefinition[],
	name: string,
	params: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<Record<string, any>> {
	const result = await toolNamed(tools, name).execute(name, params, undefined, undefined, ctx);
	const first = result.content[0];
	if (!first || first.type !== "text") throw new Error(`tool ${name} returned no text`);
	return JSON.parse(first.text) as Record<string, any>;
}
