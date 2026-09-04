import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEvalRunIndex, runSuite } from "../src/eval.js";
import { evaluatorCostUsd } from "../src/evaluator-model.js";
import { money } from "../src/measurement.js";
import { loadTarget } from "../src/manifest.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import type { RunRecord } from "../src/provenance.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

/**
 * The judge is the instrument, not the thing being measured, so what it costs
 * is accounted separately all the way up: per run, per eval run, and on the
 * page the client is handed. A judge bill folded into the Target's `costUsd`
 * would answer neither "what does an answer cost" nor "what did measuring it
 * cost"; a judge bill that is not recorded at all is the same as claiming it
 * was free.
 */

const roots: string[] = [];
const servers: MockModelHandle[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The declared rates are the whole basis of the number; the mock reports 42/7. */
const JUDGE_COST = { input: 1, output: 3 };
const EXPECTED_PER_CALL = (1 * 42 + 3 * 7) / 1_000_000;

function manifestYaml(targetUrl: string, judgeUrl: string): string {
	return `id: judge-cost-target
model:
  provider: qwen-mock
  id: mock-target
  api: openai-completions
  baseUrl: ${targetUrl}
  apiKeyEnv: MOCK_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 60000
instructions:
  agentsMd: AGENTS.md
skills: []
evalSuite:
  id: judge-cost-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
  judge:
    provider: qwen-mock
    id: mock-judge
    api: openai-completions
    baseUrl: ${judgeUrl}
    apiKeyEnv: MOCK_MODEL_KEY
    thinkingLevel: "off"
    timeoutMs: 60000
    spec:
      cost:
        input: ${JUDGE_COST.input}
        output: ${JUDGE_COST.output}
`;
}

const DATASET = `${[
	{ id: "task-a", input: "Сколько длится возврат?", graders: [{ type: "judge", rubric: "назван срок" }] },
	{ id: "task-b", input: "Как оформить?", graders: [{ type: "judge", rubric: "назван канал" }] },
].map((task) => JSON.stringify(task)).join("\n")}\n`;

describe("judge spend is accounted beside the Target's, never inside it", () => {
	it("records it per run and sums it on the eval run", async () => {
		process.env.MOCK_MODEL_KEY = "test-key";
		const target = await startMockModel([{ steps: [], resolve: () => ({ text: "Тридцать дней." }) }]);
		const judge = await startMockModel([
			{ steps: [], resolve: () => ({ text: '{"passed": true, "reason": "ок"}' }) },
		]);
		servers.push(target, judge);
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifestYaml(target.url, judge.url),
			"evals/development.jsonl": DATASET,
		}));
		const runsRoot = join(dir, "..", `judge-cost-runs-${Date.now()}`);
		roots.push(runsRoot);
		try {
			const evalRun = await runSuite(loadTarget(dir), { runsRoot, label: "solo", repetitions: 1 });
			expect(evalRun.summary.error).toBe(0);
			expect(evalRun.runIds).toHaveLength(2);

			const runs = evalRun.runIds.map((runId) =>
				JSON.parse(readFileSync(join(runsRoot, runId, "run.json"), "utf8")) as RunRecord);
			for (const run of runs) {
				expect(run.metrics.judge).toMatchObject({ calls: 1, tokens: 49 });
				expect(run.metrics.judge?.costUsd).toBeCloseTo(EXPECTED_PER_CALL, 12);
				// The Target model declares no rates, and the judge's are not its own.
				expect(run.metrics.costUsd).toBe(0);
			}

			const recorded = readEvalRunIndex(runsRoot, evalRun.evalRunId);
			expect(recorded.judgeCostUsd).toBeCloseTo(EXPECTED_PER_CALL * 2, 12);
			expect(recorded.judgeCostUsd).toBe(
				runs.reduce((total, run) => total + (run.metrics.judge?.costUsd ?? 0), 0),
			);
			// The field is the returned record's too, so `ahde run` can print it
			// without re-reading what it just wrote.
			expect(evalRun.judgeCostUsd).toBe(recorded.judgeCostUsd);
		} finally {
			cleanup(dir);
		}
	}, 120_000);

	it("leaves an eval run that called no judge byte-for-byte as it was", async () => {
		process.env.TEST_MODEL_KEY = "test-key";
		const target = await startMockModel([{ steps: [], resolve: () => ({ text: "ready" }) }]);
		servers.push(target);
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": `id: no-judge-target
model:
  provider: qwen-mock
  id: mock-target
  api: openai-completions
  baseUrl: ${target.url}
  apiKeyEnv: TEST_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 60000
instructions:
  agentsMd: AGENTS.md
skills: []
evalSuite:
  id: no-judge-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`,
			"evals/development.jsonl":
				`${JSON.stringify({ id: "task-a", input: "hi", graders: [{ type: "output_contains", text: "ready" }] })}\n`,
		}));
		const runsRoot = join(dir, "..", `no-judge-runs-${Date.now()}`);
		roots.push(runsRoot);
		try {
			const evalRun = await runSuite(loadTarget(dir), { runsRoot, label: "solo", repetitions: 1 });
			expect(evalRun.judgeCostUsd).toBeUndefined();
			const raw = JSON.parse(
				readFileSync(join(runsRoot, evalRun.evalRunId, "eval_run.json"), "utf8"),
			) as Record<string, unknown>;
			expect("judgeCostUsd" in raw).toBe(false);
		} finally {
			cleanup(dir);
		}
	}, 120_000);
});

describe("what a judge bill is allowed to look like on a terminal", () => {
	it("is derived from the manifest's declared rates, tier by tier", () => {
		expect(evaluatorCostUsd(
			{ input: 1, output: 3, cacheRead: 0, cacheWrite: 0 },
			{ promptTokens: 42, completionTokens: 7, totalTokens: 49 },
		)).toBeCloseTo(EXPECTED_PER_CALL, 12);
		// No declared rates is a real zero, not a missing number.
		expect(evaluatorCostUsd(
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			{ promptTokens: 42, completionTokens: 7, totalTokens: 49 },
		)).toBe(0);
	});

	it("never rounds a real bill down to $0.00", () => {
		expect(money(0)).toBe("$0.00");
		expect(money(0.000378)).toBe("<$0.01");
		expect(money(0.004999)).toBe("<$0.01");
		expect(money(0.005)).toBe("$0.01");
		expect(money(0.1885)).toBe("$0.19");
	});
});
