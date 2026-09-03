import { describe, expect, it } from "vitest";
import {
	assertTargetReadyToRun,
	inspectTargetReadiness,
	toolCredentialReadiness,
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
			data: [],
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

describe("declared tool credentials", () => {
	const tools = [
		{ descriptor: { name: "weather", permissions: { environment: ["WEATHER_API_KEY"] } } },
		{ descriptor: { name: "crm", permissions: { environment: ["CRM_TOKEN", "CRM_REGION"] } } },
		{ descriptor: { name: "clock", permissions: { environment: [] } } },
	] as unknown as ResolvedTarget["tools"];

	it("says set or MISSING for every key a declared tool names, and reads no value", () => {
		const lines = toolCredentialReadiness({ tools }, { CRM_TOKEN: "sk-live-000111", CRM_REGION: "  " });
		expect(lines.map((line) => line.line)).toEqual([
			"tool weather: key WEATHER_API_KEY MISSING",
			"tool crm: key CRM_TOKEN set",
			"tool crm: key CRM_REGION MISSING",
		]);
		expect(JSON.stringify(lines)).not.toContain("sk-live");
	});

	it("says nothing at all about a tool that declares no key", () => {
		expect(toolCredentialReadiness({ tools }, { WEATHER_API_KEY: "k", CRM_TOKEN: "k", CRM_REGION: "k" })
			.every((line) => line.present)).toBe(true);
		expect(toolCredentialReadiness({ tools }, {}).some((line) => line.tool === "clock")).toBe(false);
	});

	/**
	 * Session 7: 21 of 24 runs failed on a network timeout, and the product
	 * explained it as a missing `AHDE_WORLD` — a variable the broker sets on
	 * every tool process itself and which was in the child's environment the
	 * whole time. The header repeated it, the Builder repeated it, and the
	 * operator was sent to a terminal to export it.
	 */
	it("never calls a host-owned name a credential the operator has to export", () => {
		const worlded = [
			{ descriptor: { name: "get_account", permissions: { environment: ["AHDE_WORLD"] } } },
			{ descriptor: { name: "create_ticket", permissions: { environment: ["AHDE_WORLD", "AHDE_TOOL_HOME"] } } },
			{ descriptor: { name: "crm", permissions: { environment: ["AHDE_WORLD", "CRM_TOKEN"] } } },
		] as unknown as ResolvedTarget["tools"];
		// An empty environment is exactly the shell `ahde` ran in when the child
		// still had AHDE_WORLD: the two host-owned names are simply not questions.
		expect(toolCredentialReadiness({ tools: worlded }, {})).toEqual([{
			tool: "crm",
			environmentName: "CRM_TOKEN",
			present: false,
			line: "tool crm: key CRM_TOKEN MISSING",
		}]);
		expect(JSON.stringify(toolCredentialReadiness({ tools: worlded }, {}))).not.toContain("AHDE_");
	});
});
