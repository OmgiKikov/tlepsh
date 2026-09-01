import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	calmSetupFailure,
	describeHostModelCatalog,
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

describe("first-run setup failures", () => {
	it("turns the non-empty directory guard into one calm sentence", () => {
		const calm = calmSetupFailure(new Error("target scaffold requires an otherwise empty current directory; found package.json"));
		expect(calm).toContain("This folder is not empty");
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
