import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PiBuilderAdapter, type CandidateProposal } from "../src/builders/adapters.js";
import { PiSdkBuilderExecutor } from "../src/builders/pi-executor.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";

let mock: MockModelHandle;
let observedToolCount = -1;
const baseTargetSha = "a".repeat(40);

function proposal(): CandidateProposal {
	return {
		schemaVersion: 1,
		decision: "propose",
		baseTargetSha,
		summary: "Broaden the observable activation rule.",
		diagnoses: [{ failureIds: ["task-1"], evidence: ["run-1/session.jsonl"], rootCause: "skill did not activate" }],
		changes: [{
			path: "AGENTS.md",
			baseSha256: `sha256:${"b".repeat(64)}`,
			unifiedDiff: "diff --git a/AGENTS.md b/AGENTS.md\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n-old\n+new\n",
			rationale: "Make the trigger explicit.",
			evidenceRefs: ["run-1"],
		}],
		risks: ["May over-trigger."],
		validationPlan: ["Run the matched development corpus."],
	};
}

beforeAll(async () => {
	mock = await startMockModel([
		{
			match: ({ toolCount }) => {
				observedToolCount = toolCount;
				return true;
			},
			steps: [{ text: JSON.stringify(proposal()) }],
		},
	]);
	process.env.MOCK_MODEL_KEY = "test";
});

afterAll(async () => {
	delete process.env.MOCK_MODEL_KEY;
	await mock.close();
});

describe("Pi SDK builder executor", () => {
	it("runs the real embedded Pi backend tool-free and returns validated proposal evidence", async () => {
		const executor = new PiSdkBuilderExecutor({
			model: {
				provider: "pi-mock",
				id: "mock",
				api: "openai-completions",
				baseUrl: mock.url,
				apiKeyEnv: "MOCK_MODEL_KEY",
				thinkingLevel: "off",
				timeoutMs: 60_000,
				params: {},
				spec: {
					reasoning: false,
					contextWindow: 131_072,
					maxTokens: 8192,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					compat: {},
				},
			},
		});
		const adapter = new PiBuilderAdapter({ executor });
		const result = await adapter.run({
			bundle: "untrusted failure evidence",
			baseTargetSha,
			allowedPaths: ["AGENTS.md", "skills/**"],
			timeoutMs: 60_000,
		});

		expect(result.status).toBe("completed");
		expect(result.proposal).toEqual(proposal());
		expect(result.backendVersion).toContain("0.84.3+");
		expect(result.traceLevel).toBe("full");
		expect(result.rawEvents.length).toBeGreaterThan(0);
		expect(result.usage?.inputTokens).toBeGreaterThan(0);
		expect(observedToolCount).toBe(0);
	}, 60_000);
});
