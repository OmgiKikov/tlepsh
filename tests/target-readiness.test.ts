import { describe, expect, it } from "vitest";
import {
	assertTargetReadyToRun,
	inspectTargetReadiness,
} from "../src/target/readiness.js";
import type { ResolvedTarget } from "../src/manifest.js";

function target(id = "docs-agent", modelId = "model-1"): Pick<ResolvedTarget, "manifest"> {
	return {
		manifest: {
			id,
			model: {
				provider: "test-provider",
				id: modelId,
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:7777/v1",
				apiKeyEnv: "TARGET_TEST_KEY",
				thinkingLevel: "off",
				timeoutMs: 10_000,
				params: {},
				spec: {
					reasoning: false,
					contextWindow: 8_192,
					maxTokens: 1_024,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					compat: {},
				},
			},
			execution: { tools: ["read"], environmentAllowlist: [], network: "deny", sandbox: "best-effort" },
			instructions: { agentsMd: "AGENTS.md" },
			skills: [],
			tools: [],
			evalSuite: { id: "development", dataset: "evals/tasks.jsonl", graders: "evals/graders.yaml" },
		},
	};
}

describe("Target readiness", () => {
	it("reports a credential as present but never claims provider authentication", () => {
		expect(inspectTargetReadiness(target(), { TARGET_TEST_KEY: "configured" })).toEqual({
			ready: true,
			bootstrapRequired: false,
			credential: { environmentName: "TARGET_TEST_KEY", status: "present-unverified" },
			issues: [],
		});
	});

	it("blocks starter placeholders and missing credentials before a model run", () => {
		const starter = target("my-agent", "replace-with-model-id");
		const readiness = inspectTargetReadiness(starter, {});
		expect(readiness.ready).toBe(false);
		expect(readiness.issues).toEqual([
			"Target identity and model still contain starter placeholders.",
			"TARGET_TEST_KEY is not configured outside chat.",
		]);
		expect(() => assertTargetReadyToRun(starter, {})).toThrow(/not ready to run.*starter placeholders.*TARGET_TEST_KEY/);
	});

	it("treats an empty credential as missing", () => {
		expect(inspectTargetReadiness(target(), { TARGET_TEST_KEY: "  " }).credential.status).toBe("missing");
	});
});
