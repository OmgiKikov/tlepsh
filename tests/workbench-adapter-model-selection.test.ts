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

	it("keeps evaluator credentials in the host UI and resolves both roles through the catalog", async () => {
		const resolved: unknown[] = [];
		const decide = vi.fn(async (decision, _gate, execution) => {
			resolved.push(
				execution.resolveEvaluatorModel("judge", decision.judge),
				execution.resolveEvaluatorModel("simulatedUser", decision.simulatedUser),
			);
			return {
				kind: "configure-evaluators",
				message: "configured",
				result: { configured: [] },
				view: { blockers: [] },
			};
		});
		const tool = createBuilderWorkbenchTools(
			{ decide } as unknown as AhdeWorkbench,
			() => "local:test",
		).find((candidate) => candidate.name === "ahde_workbench_decide")!;
		const find = vi.fn((_provider: string, id: string) => ({ ...hostModel(), id }));
		const input = vi.fn()
			.mockResolvedValueOnce("JUDGE_FIXTURE_API_KEY")
			.mockResolvedValueOnce("USER_FIXTURE_API_KEY");

		await tool.execute("configure-evaluators", {
			kind: "configure-evaluators",
			judge: { provider: "fixture-provider", modelId: "fixture-judge" },
			simulatedUser: { provider: "fixture-provider", modelId: "fixture-user" },
			reason: "The basket needs a judge and a simulated user",
		}, undefined, undefined, context(find, input));

		expect(input.mock.calls.map((call) => call[0])).toEqual([
			expect.stringContaining("for the judge"),
			expect.stringContaining("for the simulated user"),
		]);
		expect(resolved).toEqual([
			expect.objectContaining({ id: "fixture-judge", apiKeyEnv: "JUDGE_FIXTURE_API_KEY" }),
			expect.objectContaining({ id: "fixture-user", apiKeyEnv: "USER_FIXTURE_API_KEY" }),
		]);
		// The Builder-selected decision contains identities, never credential names
		// or values. Those enter only through the trusted execution seam above.
		expect(JSON.stringify(decide.mock.calls[0]?.[0])).not.toMatch(/JUDGE_FIXTURE|USER_FIXTURE/);
	});

	it("hands the model the host catalog while the Target still has no model", async () => {
		const view = vi.fn(async () => ({
			schemaVersion: 1,
			stage: "target-setup",
			headline: "Create the Target harness.",
			target: { status: "missing", id: null, gitSha: null, model: null, evaluators: { judge: null, simulatedUser: null } },
			selections: [],
			warnings: [],
			actions: ["scaffold-target"],
			blockers: [],
			counts: {},
		}));
		const tool = createBuilderWorkbenchTools(
			{ view } as unknown as AhdeWorkbench,
			() => "local:test",
		).find((candidate) => candidate.name === "ahde_workbench_view")!;
		const host = context(vi.fn(() => undefined), vi.fn(async () => CREDENTIAL_ENV)) as ExtensionContext & {
			modelRegistry: Record<string, unknown>;
		};
		host.modelRegistry.getAvailable = vi.fn(() => [
			{ ...hostModel(), provider: "openai", id: "gpt-5" },
			hostModel(),
		]);
		host.modelRegistry.hasConfiguredAuth = vi.fn((model: { provider: string }) => model.provider === "fixture-provider");

		const result = await tool.execute("inspect", {}, undefined, undefined, host);
		const first = result.content[0];
		if (!first || first.type !== "text") throw new Error("expected a text tool result");
		const projected = JSON.parse(first.text) as { hostModelCatalog?: { models: unknown[]; omittedModels: number } };
		expect(projected.hostModelCatalog).toEqual({
			models: [
				{ provider: "fixture-provider", modelId: "fixture-model", credentialPresent: true },
				{ provider: "openai", modelId: "gpt-5", credentialPresent: false },
			],
			omittedModels: 0,
		});
		expect(first.text).not.toContain(CREDENTIAL_ENV);
	});

	it("keeps the trusted catalog in summary views when configured evaluators can be replaced", async () => {
		const view = vi.fn(async () => ({
			schemaVersion: 1,
			stage: "ready-to-evaluate",
			headline: "The development basket is ready.",
			target: {
				status: "ready",
				id: "fixture-agent",
				gitSha: "a".repeat(40),
				model: { provider: "fixture-provider", id: "fixture-model", apiKeyEnv: "TARGET_KEY", credentialPresent: true },
				evaluators: {
					judge: { provider: "fixture-provider", id: "fixture-judge", apiKeyEnv: "JUDGE_KEY", credentialPresent: true },
					simulatedUser: { provider: "fixture-provider", id: "fixture-user", apiKeyEnv: "USER_KEY", credentialPresent: true },
				},
			},
			selections: [],
			warnings: [],
			actions: ["workshop-open", "run", "configure-evaluators"],
			blockers: [],
			counts: {},
		}));
		const tool = createBuilderWorkbenchTools(
			{ view } as unknown as AhdeWorkbench,
			() => "local:test",
		).find((candidate) => candidate.name === "ahde_workbench_view")!;
		const host = context(vi.fn(() => undefined), vi.fn(async () => CREDENTIAL_ENV)) as ExtensionContext & {
			modelRegistry: Record<string, unknown>;
		};
		host.modelRegistry.getAvailable = vi.fn(() => [hostModel()]);
		host.modelRegistry.hasConfiguredAuth = vi.fn(() => true);

		const result = await tool.execute("inspect", { aspect: "summary" }, undefined, undefined, host);
		const first = result.content[0];
		if (!first || first.type !== "text") throw new Error("expected a text tool result");
		const projected = JSON.parse(first.text) as { hostModelCatalog?: { models: unknown[] } };
		expect(projected.hostModelCatalog?.models).toEqual([
			{ provider: "fixture-provider", modelId: "fixture-model", credentialPresent: true },
		]);
		expect(first.text).not.toMatch(/TARGET_KEY|JUDGE_KEY|USER_KEY|apiKeyEnv/);
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
			.rejects.toThrow(/fixture-provider\/missing-model is not available in the trusted host catalog\. Choose one of: /);
	});
});
