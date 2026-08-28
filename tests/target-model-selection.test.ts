import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveTargetModelSelection } from "../src/application/target-model-selection.js";
import { ModelBlock } from "../src/manifest.js";

function hostModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: "openai",
		id: "gpt-test",
		name: "GPT Test",
		api: "openai-responses",
		baseUrl: "https://api.example.test/v1",
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
		input: ["text", "image"],
		cost: {
			input: 2.5,
			output: 15,
			cacheRead: 0.25,
			cacheWrite: 3.125,
			tiers: [{ inputTokensAbove: 272_000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 6.25 }],
		},
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		compat: { supportsStrictMode: true, supportsToolSearch: true },
		...overrides,
	};
}

function selection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		provider: "openai",
		modelId: "gpt-test",
		apiKeyEnv: "TARGET_MODEL_API_KEY",
		...overrides,
	};
}

describe("Target model selection", () => {
	it("materializes a complete ModelBlock while deriving executable metadata only from the host model", () => {
		const model = hostModel({
			headers: { Authorization: "host-only and deliberately not copied" },
		});
		const result = resolveTargetModelSelection(selection({
			thinkingLevel: "xhigh",
			timeoutMs: 120_000,
			params: { temperature: 0.2, metadata: { purpose: "target-eval" } },
		}), model);

		expect(ModelBlock.parse(result)).toEqual(result);
		expect(result).toEqual({
			provider: "openai",
			id: "gpt-test",
			api: "openai-responses",
			baseUrl: "https://api.example.test/v1",
			apiKeyEnv: "TARGET_MODEL_API_KEY",
			thinkingLevel: "xhigh",
			timeoutMs: 120_000,
			params: { metadata: { purpose: "target-eval" }, temperature: 0.2 },
			spec: {
				reasoning: true,
				contextWindow: 1_050_000,
				maxTokens: 128_000,
				cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
				compat: { supportsStrictMode: true, supportsToolSearch: true },
			},
		});
		expect(JSON.stringify(result)).not.toContain("Authorization");
	});

	it("chooses Pi's medium default when available and off for a non-reasoning model", () => {
		expect(resolveTargetModelSelection(selection(), hostModel())).toMatchObject({
			thinkingLevel: "medium",
			timeoutMs: 300_000,
			params: {},
		});
		expect(resolveTargetModelSelection(selection(), hostModel({
			reasoning: false,
			thinkingLevelMap: undefined,
		}))).toMatchObject({ thinkingLevel: "off" });
	});

	it("selects the nearest safe default above medium when a reasoning model requires it", () => {
		const result = resolveTargetModelSelection(selection(), hostModel({
			thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
		}));
		expect(result.thinkingLevel).toBe("high");
	});

	it.each([
		[selection({ provider: "anthropic" }), /provider does not match/],
		[selection({ modelId: "another-model" }), /modelId does not match/],
	] as const)("rejects provider/model identity mismatches", (input, expected) => {
		expect(() => resolveTargetModelSelection(input, hostModel())).toThrow(expected);
	});

	it.each([
		["api", "openai-completions"],
		["baseUrl", "https://attacker.invalid/v1"],
		["cost", { input: 0, output: 0 }],
		["compat", {}],
		["spec", {}],
	] as const)("does not let selection provide the host-owned %s field", (key, value) => {
		expect(() => resolveTargetModelSelection(selection({ [key]: value }), hostModel())).toThrow(/unrecognized key/i);
	});

	it.each([
		[selection({ apiKeyEnv: "not-an-env" }), /environment variable name/],
		[selection({ timeoutMs: 999 }), />=1000/i],
		[selection({ timeoutMs: 3_600_001 }), /<=3600000/i],
		[selection({ params: { note: "x".repeat(16 * 1024 + 1) } }), /oversized string/],
	] as const)("rejects an invalid or unbounded selection", (input, expected) => {
		expect(() => resolveTargetModelSelection(input, hostModel())).toThrow(expected);
	});

	it("rejects unsupported thinking levels instead of silently clamping them", () => {
		expect(() => resolveTargetModelSelection(selection({ thinkingLevel: "high" }), hostModel({
			reasoning: false,
			thinkingLevelMap: undefined,
		}))).toThrow(/not supported/);
		expect(() => resolveTargetModelSelection(selection({ thinkingLevel: "medium" }), hostModel({
			thinkingLevelMap: { medium: null, xhigh: "xhigh" },
		}))).toThrow(/not supported/);
	});

	it.each([
		[selection({ apiKey: "not-allowed" }), /credential-looking key/],
		[selection({ params: { api_key: "not-even-a-real-secret" } }), /credential-looking key/],
		[selection({ params: { metadata: { authorization: "not-even-a-real-secret" } } }), /credential-looking key/],
		[selection({ params: { label: "sk-proj-abcdefghijklmnopqrstuv" } }), /credential-looking value/],
		[selection({ params: { label: "prefix sk-proj-abcdefghijklmnopqrstuv suffix" } }), /credential-looking value/],
		[selection({ params: { label: "Bearer abcdefghijklmnop" } }), /credential-looking value/],
	] as const)("rejects secrets and credential-looking fields without echoing their values", (input, expected) => {
		expect(() => resolveTargetModelSelection(input, hostModel())).toThrow(expected);
	});

	it.each([
		"model",
		"messages",
		"input",
		"prompt",
		"instructions",
		"system",
		"stream",
		"tools",
		"tool_choice",
		"contents",
	] as const)("rejects reserved raw request override %s", (key) => {
		expect(() => resolveTargetModelSelection(selection({ params: { [key]: "override" } }), hostModel()))
			.toThrow(/reserved request field/);
	});

	it.each([
		[hostModel({ baseUrl: "file:///etc/passwd" }), /HTTP or HTTPS/],
		[hostModel({ baseUrl: "https://user:password@example.test/v1" }), /cannot contain credentials/],
		[hostModel({ baseUrl: "https://example.test/v1?api_key=value" }), /credential query/],
		[hostModel({ baseUrl: "https://example.test/v1#ignored" }), /fragment/],
		[hostModel({ contextWindow: Number.POSITIVE_INFINITY }), /expected number|finite/i],
		[hostModel({ cost: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 } }), />=0/i],
		[hostModel({ compat: { auth_token: "value" } as never }), /credential-looking key/],
		[hostModel({ compat: { label: "embedded sk-proj-abcdefghijklmnopqrstuv value" } as never }), /credential-looking value/],
		[hostModel({ compat: { transform: () => "unsafe" } as never }), /only JSON data/],
	] as const)("fails closed on unsafe or unparseable host metadata", (model, expected) => {
		expect(() => resolveTargetModelSelection(selection(), model)).toThrow(expected);
	});

	it("rejects cyclic catalog metadata and accepts bounded nested compatibility data", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => resolveTargetModelSelection(selection(), hostModel({ compat: cyclic as never }))).toThrow(/cycle/);

		const compat = {
			allowedFallbackModels: [{
				provider: "openai",
				model: "gpt-fallback",
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
			}],
		};
		expect(resolveTargetModelSelection(selection(), hostModel({ compat } as Partial<Model<Api>>)).spec.compat)
			.toEqual(compat);
	});

	it("returns detached, deterministically ordered metadata", () => {
		const params = { zeta: 1, alpha: { second: 2, first: 1 } };
		const compat = { zeta: true, alpha: { second: 2, first: 1 } };
		const first = resolveTargetModelSelection(selection({ params }), hostModel({ compat } as Partial<Model<Api>>));
		const second = resolveTargetModelSelection(selection({ params: { alpha: { first: 1, second: 2 }, zeta: 1 } }), hostModel({
			compat: { alpha: { first: 1, second: 2 }, zeta: true },
		} as Partial<Model<Api>>));

		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		params.alpha.first = 99;
		compat.alpha.first = 99;
		expect(first.params).toEqual({ alpha: { first: 1, second: 2 }, zeta: 1 });
		expect(first.spec.compat).toEqual({ alpha: { first: 1, second: 2 }, zeta: true });
	});
});
