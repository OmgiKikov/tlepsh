import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	calmSetupFailure,
	confirmDeclaredToolCredentials,
	defaultJudgeSelection,
	describeHostModelCatalog,
	hostDefaultJudge,
	hostModelCatalog,
	targetIdFromDirectory,
	targetModelResolver,
} from "../src/builder/onboarding.js";

function registry(options: {
	available?: { provider: string; id: string }[];
	credentialed?: (model: { provider: string; id: string }) => boolean;
	find?: (provider: string, modelId: string) => unknown;
} = {}): Pick<ExtensionContext, "modelRegistry"> {
	return {
		modelRegistry: {
			getAvailable: vi.fn(() => options.available ?? []),
			hasConfiguredAuth: vi.fn(options.credentialed ?? (() => true)),
			find: vi.fn(options.find ?? (() => undefined)),
		},
	} as unknown as Pick<ExtensionContext, "modelRegistry">;
}

describe("host model catalog", () => {
	it("lists credentialed models first and never a credential value", () => {
		const catalog = hostModelCatalog(registry({
			available: [
				{ provider: "openai", id: "gpt-5" },
				{ provider: "anthropic", id: "claude-opus" },
				{ provider: "openai", id: "gpt-5" },
			],
			credentialed: (model) => model.provider === "anthropic",
		}));
		expect(catalog.models).toEqual([
			{ provider: "anthropic", modelId: "claude-opus", credentialPresent: true },
			{ provider: "openai", modelId: "gpt-5", credentialPresent: false },
		]);
		expect(catalog.omittedModels).toBe(0);
		expect(JSON.stringify(catalog)).not.toMatch(/sk-|key|token/i);
	});

	it("stays bounded and says how many it left out", () => {
		const available = Array.from({ length: 55 }, (_, index) => ({ provider: "openrouter", id: `model-${index}` }));
		const catalog = hostModelCatalog(registry({ available, credentialed: () => false }));
		expect(catalog.models).toHaveLength(40);
		expect(catalog.omittedModels).toBe(15);
		expect(describeHostModelCatalog(catalog)).toContain("and 15 more");
	});

	it("survives a host registry that throws", () => {
		const broken = {
			modelRegistry: {
				getAvailable: () => {
					throw new Error("registry unavailable");
				},
				hasConfiguredAuth: () => true,
			},
		} as unknown as Pick<ExtensionContext, "modelRegistry">;
		expect(hostModelCatalog(broken)).toEqual({ models: [], omittedModels: 0 });
		expect(describeHostModelCatalog(hostModelCatalog(broken))).toContain("private model connection picker");
		expect(describeHostModelCatalog(hostModelCatalog(broken))).not.toContain("/login");
	});

	it("names real ids when configure-target guesses one that does not exist", () => {
		const resolve = targetModelResolver(
			registry({
				available: [{ provider: "openai", id: "gpt-5" }, { provider: "anthropic", id: "claude-opus" }],
				credentialed: (model) => model.provider === "openai",
			}),
			"OPENAI_API_KEY",
		);
		expect(() => resolve({ provider: "openai", modelId: "gpt-9-turbo" })).toThrow(
			/openai\/gpt-9-turbo is not available in the trusted host catalog\. Choose one of: openai\/gpt-5, anthropic\/claude-opus \(no credential\)\./,
		);
	});
});

/**
 * The judge the host would pick for a basket that needs one. The predicate is
 * the one `configure-evaluators` enforces after the fact — a model grading a
 * copy of itself is not a second opinion — applied before the question.
 */
describe("the default judge", () => {
	const catalog = (models: { provider: string; id: string; credentialed?: boolean }[]) =>
		hostModelCatalog(registry({
			available: models,
			credentialed: (model) => models.find((entry) =>
				entry.provider === model.provider && entry.id === model.id)?.credentialed !== false,
		}));

	it("takes the first credentialed model that is not the agent's own", () => {
		expect(defaultJudgeSelection(
			catalog([
				{ provider: "qwen-internal", id: "qwen3.5-27b" },
				{ provider: "openrouter", id: "glm-5.3" },
			]),
			{ provider: "qwen-internal", id: "qwen3.5-27b" },
		)).toMatchObject({ provider: "openrouter", modelId: "glm-5.3" });
	});

	it("takes another model from the same provider: the comparison is provider+id", () => {
		expect(defaultJudgeSelection(
			catalog([{ provider: "anthropic", id: "claude-opus" }, { provider: "anthropic", id: "claude-haiku" }]),
			{ provider: "anthropic", id: "claude-opus" },
		)).toMatchObject({ provider: "anthropic", modelId: "claude-haiku" });
	});

	it("offers nothing when every other model is uncredentialed, or there is no other model", () => {
		expect(defaultJudgeSelection(
			catalog([
				{ provider: "qwen-internal", id: "qwen3.5-27b" },
				{ provider: "openrouter", id: "glm-5.3", credentialed: false },
			]),
			{ provider: "qwen-internal", id: "qwen3.5-27b" },
		)).toBeNull();
		expect(defaultJudgeSelection(
			catalog([{ provider: "qwen-internal", id: "qwen3.5-27b" }]),
			{ provider: "qwen-internal", id: "qwen3.5-27b" },
		)).toBeNull();
	});

	it("pre-fills nothing unless the operator has already exported the key's variable", () => {
		const ctx = registry({
			available: [{ provider: "qwen-internal", id: "qwen3.5-27b" }, { provider: "openrouter", id: "glm-5.3" }],
			find: (provider, modelId) => ({
				provider,
				id: modelId,
				name: modelId,
				api: "openai-completions",
				baseUrl: "https://openrouter.invalid/api/v1",
				reasoning: false,
				thinkingLevelMap: { off: null },
				input: ["text"],
				cost: { input: 0.2, output: 0.8, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 32_000,
			}),
		});
		const target = { provider: "qwen-internal", id: "qwen3.5-27b" };
		// A name the operator has not exported is a question, and a question
		// belongs in the dialog `configure-evaluators` already asks.
		expect(hostDefaultJudge(ctx, target, {})).toBeNull();
		const chosen = hostDefaultJudge(ctx, target, { OPENROUTER_API_KEY: "sk-live" });
		expect(chosen?.model).toMatchObject({
			provider: "openrouter",
			id: "glm-5.3",
			apiKeyEnv: "OPENROUTER_API_KEY",
		});
	});
});

describe("first-run setup failures", () => {
	it("turns the non-empty directory guard into one calm sentence", () => {
		const calm = calmSetupFailure(new Error("target scaffold requires an otherwise empty current directory; found package.json"));
		expect(calm).toContain("This folder already holds");
		expect(calm).toContain("package.json");
		expect(calm).not.toContain("target scaffold requires");
	});

	it("keeps a cancelled setup calm and keeps unknown failures bounded", () => {
		expect(calmSetupFailure(new Error("Target model configuration was cancelled by the operator"))).toContain("Setup stopped");
		const unknown = calmSetupFailure(new Error("x".repeat(500)));
		expect(unknown.startsWith("Setup did not finish: ")).toBe(true);
		expect(unknown.length).toBeLessThan(240);
	});
});

describe("target id from directory", () => {
	it("keeps a usable slug and falls back to a neutral id", () => {
		expect(targetIdFromDirectory("Competitor Research")).toBe("competitor-research");
		expect(targetIdFromDirectory("my-agent")).toBe("agent");
		expect(targetIdFromDirectory("...")).toBe("agent");
	});
});

describe("a declared tool key nobody exported", () => {
	function uiContext(answers: (string | undefined)[]) {
		const notes: { message: string; tone: string }[] = [];
		const asked: { prompt: string; preset: string }[] = [];
		const queue = [...answers];
		return {
			notes,
			asked,
			ctx: {
				ui: {
					input: vi.fn((prompt: string, preset: string) => {
						asked.push({ prompt, preset });
						return Promise.resolve(queue.shift());
					}),
					notify: vi.fn((message: string, tone: string) => {
						notes.push({ message, tone });
					}),
				},
			} as unknown as Pick<ExtensionContext, "ui">,
		};
	}

	it("asks the host's own question about the variable and tells the operator to export it", async () => {
		const host = uiContext(["WEATHER_API_KEY"]);
		await confirmDeclaredToolCredentials(host.ctx, [
			{ tool: "weather", environment: "WEATHER_API_KEY" },
			{ tool: "weather", environment: "WEATHER_API_KEY" },
		]);
		// One question per variable, prefilled with the declared name.
		expect(host.asked).toEqual([
			{ prompt: "Environment variable holding the credential for weather", preset: "WEATHER_API_KEY" },
		]);
		expect(host.notes).toEqual([{
			message: "Nothing is stored here. Export WEATHER_API_KEY in the shell that runs ahde, then try the tool again.",
			tone: "info",
		}]);
	});

	it("says a different variable is a change to the tool, and refuses a pasted value", async () => {
		const renamed = uiContext(["MY_OWN_KEY"]);
		await confirmDeclaredToolCredentials(renamed.ctx, [{ tool: "weather", environment: "WEATHER_API_KEY" }]);
		expect(renamed.notes[0]?.message).toBe(
			"weather declares WEATHER_API_KEY, not MY_OWN_KEY. Changing which variable it reads is a change to the tool, " +
			"so ask for it in plain words and I will prepare the diff.",
		);

		const pasted = uiContext(["sk-live-000111222333"]);
		await confirmDeclaredToolCredentials(pasted.ctx, [{ tool: "weather", environment: "WEATHER_API_KEY" }]);
		expect(pasted.notes).toEqual([{
			message: "That is not an environment-variable name. Name the variable, never paste the credential itself.",
			tone: "warning",
		}]);
		// Whatever was typed is never echoed back or kept.
		expect(JSON.stringify(pasted.notes)).not.toContain("sk-live");
	});
});
