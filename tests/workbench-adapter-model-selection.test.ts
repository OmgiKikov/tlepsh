import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuilderWorkbenchTools } from "../src/builder/workbench-adapter.js";
import type { AhdeWorkbench } from "../src/workbench/workbench.js";

const CREDENTIAL_ENV = "TARGET_FIXTURE_API_KEY";

function hostModel(): Model<Api> {
	return {
		provider: "fixture-provider",
		id: "fixture-model",
		name: "Fixture Model",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:43199/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 4_096,
	};
}

function context(find: ReturnType<typeof vi.fn>, input: ReturnType<typeof vi.fn>): ExtensionContext {
	return {
		hasUI: true,
		mode: "tui",
		ui: {
			input,
			confirm: vi.fn(async () => true),
			select: vi.fn(async () => undefined),
			notify: vi.fn(),
		},
		modelRegistry: { find },
	} as unknown as ExtensionContext;
}

afterEach(() => {
	delete process.env.FIXTURE_PROVIDER_API_KEY;
});

describe("Workbench Target model selection adapter", () => {
	it("keeps credentials host-owned and resolves executable metadata from the exact Pi catalog model", async () => {
		const resolved: unknown[] = [];
		const decide = vi.fn(async (decision, _gate, execution) => {
			resolved.push(execution.resolveTargetModel(decision.model));
			return {
				kind: "configure-target",
				message: "configured",
				result: {},
				view: { blockers: [] },
			};
		});
		const tool = createBuilderWorkbenchTools(
			{ decide } as unknown as AhdeWorkbench,
			() => "local:test",
		).find((candidate) => candidate.name === "ahde_workbench_decide")!;
		const find = vi.fn(() => hostModel());
		const input = vi.fn(async () => CREDENTIAL_ENV);

		await tool.execute("configure", {
			kind: "configure-target",
			targetId: "fixture-agent",
			model: {
				provider: "fixture-provider",
				modelId: "fixture-model",
				thinkingLevel: "off",
			},
			reason: "Configure the exact catalog model",
		}, undefined, undefined, context(find, input));

		expect(input).toHaveBeenCalledWith(
			expect.stringContaining("Environment variable holding the"),
			"FIXTURE_PROVIDER_API_KEY",
		);
		expect(find).toHaveBeenCalledWith("fixture-provider", "fixture-model");
		expect(resolved).toEqual([expect.objectContaining({
			provider: "fixture-provider",
			id: "fixture-model",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:43199/v1",
			apiKeyEnv: CREDENTIAL_ENV,
			spec: expect.objectContaining({ contextWindow: 32_768, maxTokens: 4_096 }),
		})]);
		expect(JSON.stringify(decide.mock.calls[0]?.[0])).not.toContain(CREDENTIAL_ENV);
	});

	it("fails closed when the selected model is absent from the trusted host catalog", async () => {
		const decide = vi.fn(async (decision, _gate, execution) => {
			execution.resolveTargetModel(decision.model);
			throw new Error("unreachable");
		});
		const tool = createBuilderWorkbenchTools(
			{ decide } as unknown as AhdeWorkbench,
			() => "local:test",
		).find((candidate) => candidate.name === "ahde_workbench_decide")!;

		await expect(tool.execute("configure", {
			kind: "configure-target",
			targetId: "fixture-agent",
			model: { provider: "fixture-provider", modelId: "missing-model" },
			reason: "Reject an unavailable model",
		}, undefined, undefined, context(vi.fn(() => undefined), vi.fn(async () => CREDENTIAL_ENV))))
			.rejects.toThrow(/not available in the trusted host catalog/);
	});
});
