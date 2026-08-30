import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareEvalRuns } from "../src/compare.js";
import {
	loadRun,
	loadVerifiedEvalRun,
	renderEvalRunListLine,
	runSuite,
	type EvalRunRecord,
} from "../src/eval.js";
import { loadTarget } from "../src/manifest.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import {
	readGraderDefaults,
	regradeEvalRun,
	renderRegradeSummary,
	type RegradeResult,
} from "../src/regrade.js";
import { MAX_TRACE_ARTIFACT_BYTES } from "../src/trace.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

/**
 * `ahde regrade` re-scores recorded traces. Every test here therefore checks two
 * things at once: the new evidence is a valid EvalRun, and the Target model was
 * never asked anything again.
 */

const SUITE_TIMEOUT_MS = 180_000;

/** Two cases with no graders of their own, so the suite defaults decide. */
const DEFAULTS_DATASET = [
	JSON.stringify({ id: "task_alpha", input: "alpha request" }),
	JSON.stringify({ id: "task_beta", input: "beta request" }),
].join("\n");

function defaultsFixture(mockUrl: string, overrides: Record<string, string> = {}): string {
	return makeTargetFixture(baseFixtureFiles({
		"manifest.yaml": `id: regrade-target
model:
  provider: qwen-mock
  id: mock
  api: openai-completions
  baseUrl: ${mockUrl}
  apiKeyEnv: MOCK_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 60000
instructions:
  agentsMd: AGENTS.md
skills: []
evalSuite:
  id: regrade-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`,
		"evals/development.jsonl": DEFAULTS_DATASET,
		"evals/graders.yaml": "defaults:\n  - type: output_contains\n    text: \"ответ\"\n",
		...overrides,
	}));
}

describe("regrade with changed suite defaults", () => {
	let mock: MockModelHandle;
	let targetDir: string;
	let runsRoot: string;
	let narrowedGraders: string;
	let sourceA: EvalRunRecord;
	let sourceB: EvalRunRecord;
	let sealedSource: EvalRunRecord;

	beforeAll(async () => {
		process.env.MOCK_MODEL_KEY = "test-key";
		mock = await startMockModel([
			{ match: ({ firstUser }) => firstUser.includes("alpha"), steps: [{ text: "ответ alpha" }] },
			{ match: () => true, steps: [{ text: "ответ beta" }] },
		]);
		targetDir = defaultsFixture(mock.url);
		runsRoot = join(targetDir, "..", `regrade-runs-${Date.now()}`);
		// Written outside the Target so the recorded checkout stays exactly what it
		// was: only the regrade sees these defaults.
		narrowedGraders = join(targetDir, "..", `regrade-graders-${Date.now()}.yaml`);
		writeFileSync(narrowedGraders, "defaults:\n  - type: output_contains\n    text: \"ответ alpha\"\n");
		const target = loadTarget(targetDir);
		sourceA = await runSuite(target, { runsRoot, label: "baseline", repetitions: 1 });
		sourceB = await runSuite(target, { runsRoot, label: "solo", repetitions: 1 });
		sealedSource = await runSuite(target, {
			runsRoot,
			label: "solo",
			repetitions: 1,
			evidenceVisibility: "sealed",
		});
	}, SUITE_TIMEOUT_MS);

	afterAll(async () => {
		cleanup(targetDir);
		cleanup(runsRoot);
		await mock.close();
	});

	async function regrade(evalRunId: string, gradersPath?: string): Promise<RegradeResult> {
		return regradeEvalRun({
			runsRoot,
			evalRunId,
			target: loadTarget(targetDir),
			...(gradersPath ? { graderDefaults: readGraderDefaults(gradersPath) } : {}),
		});
	}

	it("flips outcomes on changed graders without asking the Target model anything", async () => {
		expect(sourceA.summary).toMatchObject({ total: 2, pass: 2, fail: 0, error: 0 });
		const requestsBefore = mock.requests();

		const result = await regrade(sourceA.evalRunId, narrowedGraders);

		expect(mock.requests()).toBe(requestsBefore);
		expect(result.record.summary).toMatchObject({ total: 2, pass: 1, fail: 1, error: 0 });
		expect(result.flips).toEqual([
			{ taskId: "task_beta", repetitionIndex: 0, from: "pass", to: "fail" },
		]);
		expect(result.judge).toEqual({ calls: 0, tokens: 0, costUsd: 0 });
		// The new evidence is an ordinary EvalRun: it verifies like any other.
		const verified = loadVerifiedEvalRun(runsRoot, result.record.evalRunId);
		expect(verified.record.summary.pass).toBe(1);
		expect(verified.runs.map((run) => run.taskId)).toEqual(["task_alpha", "task_beta"]);
		const beta = verified.runs.find((run) => run.taskId === "task_beta");
		expect(beta?.evalResults?.graders[0]).toMatchObject({
			type: "output_contains",
			passed: false,
			checkCode: "output-contains",
		});

		const summary = renderRegradeSummary(result);
		expect(summary[0]).toBe(
			`regraded ${result.record.evalRunId} from ${sourceA.evalRunId}: 2/2 → 1/2 ` +
				"(Δ -50.0pp) · judge calls 0 · $0.0000",
		);
		expect(summary[1]).toBe("  task_beta#0: pass → fail");
	}, SUITE_TIMEOUT_MS);

	it("preserves execution provenance, changes only the suite, and copies traces byte-for-byte", async () => {
		const result = await regrade(sourceA.evalRunId, narrowedGraders);
		const record = result.record;

		expect(record.target).toEqual(sourceA.target);
		expect(record.target.gitSha).toBe(sourceA.target.gitSha);
		expect(record.target.workspaceHash).toBe(sourceA.target.workspaceHash);
		expect(record.datasetHash).toBe(sourceA.datasetHash);
		expect(record.dataset).toBe(sourceA.dataset);
		expect(record.suiteId).toBe(sourceA.suiteId);
		expect(record.suiteHash).not.toBe(sourceA.suiteHash);
		expect(record.provenance.suiteHash).toBe(record.suiteHash);
		expect(record.provenance.datasetHash).toBe(sourceA.provenance.datasetHash);
		expect(record.provenance.modelId).toBe(sourceA.provenance.modelId);
		expect(record.provenance.execution).toEqual(sourceA.provenance.execution);
		expect(record.label).toBe("regrade");
		expect(record.regradeOf).toBe(sourceA.evalRunId);
		expect(record.baselineEvalRunId).toBeNull();
		expect(record.evidenceVisibility).toBe("development");
		expect(record.taskIds).toEqual(sourceA.taskIds);
		expect(record.repetitions).toBe(sourceA.repetitions);

		// Fresh identities everywhere, nothing shared with the source.
		expect(record.evalRunId).not.toBe(sourceA.evalRunId);
		expect(new Set([...sourceA.runIds, ...record.runIds]).size).toBe(4);

		for (const [index, runId] of record.runIds.entries()) {
			const derived = loadRun(runsRoot, runId);
			const original = loadRun(runsRoot, sourceA.runIds[index]!);
			expect(derived.derivedFrom).toEqual({
				evalRunId: sourceA.evalRunId,
				runId: original.runId,
			});
			expect(derived.trace.sha256).toBe(original.trace.sha256);
			expect(readFileSync(join(runsRoot, runId, "session.jsonl"), "utf8"))
				.toBe(readFileSync(join(runsRoot, original.runId, "session.jsonl"), "utf8"));
			expect(statSync(join(runsRoot, runId, "session.jsonl")).mode & 0o777).toBe(0o600);
			// Target spend is the recorded one; grading spend is re-earned.
			expect(derived.metrics.tokens).toEqual(original.metrics.tokens);
			expect(derived.metrics.latencyMs).toBe(original.metrics.latencyMs);
			expect(derived.metrics.judge).toBeUndefined();
			expect(derived.eval.suiteHash).toBe(record.suiteHash);
			expect(derived.parent).toEqual({ evalRunId: record.evalRunId, candidateOf: null });
			expect(derived.model).toEqual(original.model);
			expect(derived.runtime).toEqual(original.runtime);
		}
	}, SUITE_TIMEOUT_MS);

	it("regrading with the Target's own graders reproduces the source verdicts and suite", async () => {
		const result = await regrade(sourceA.evalRunId);
		expect(result.record.suiteHash).toBe(sourceA.suiteHash);
		expect(result.record.summary).toMatchObject({ total: 2, pass: 2, fail: 0, error: 0 });
		expect(result.flips).toEqual([]);
		expect(renderRegradeSummary(result)[1]).toBe("  no outcome changed");
	}, SUITE_TIMEOUT_MS);

	it("refuses a tampered or oversized trace before any grading", async () => {
		const runId = sourceA.runIds[0]!;
		const tracePath = join(runsRoot, runId, "session.jsonl");
		const original = readFileSync(tracePath, "utf8");
		try {
			writeFileSync(tracePath, `${original}{"type":"note"}\n`);
			await expect(regrade(sourceA.evalRunId, narrowedGraders)).rejects.toThrow(/trace SHA mismatch/);

			writeFileSync(tracePath, "x".repeat(MAX_TRACE_ARTIFACT_BYTES + 1));
			await expect(regrade(sourceA.evalRunId, narrowedGraders))
				.rejects.toThrow(new RegExp(`${MAX_TRACE_ARTIFACT_BYTES}-byte artifact limit`));
		} finally {
			writeFileSync(tracePath, original);
		}
		// The restored evidence still regrades, so nothing was lost.
		expect((await regrade(sourceA.evalRunId, narrowedGraders)).record.summary.total).toBe(2);
	}, SUITE_TIMEOUT_MS);

	it("compares two regrades to each other and refuses a regrade against its source", async () => {
		const regradedA = (await regrade(sourceA.evalRunId, narrowedGraders)).record;
		const regradedB = (await regrade(sourceB.evalRunId, narrowedGraders)).record;
		expect(regradedA.suiteHash).toBe(regradedB.suiteHash);

		const across = compareEvalRuns(runsRoot, regradedA.evalRunId, regradedB.evalRunId, {
			mode: "exploratory",
			resamples: 64,
		});
		expect(across.status).toBe("comparable");
		expect(across.error).toBeNull();
		expect(across.rows.map((row) => row.taskId)).toEqual(["task_alpha", "task_beta"]);

		const againstSource = compareEvalRuns(runsRoot, sourceA.evalRunId, regradedA.evalRunId, {
			mode: "exploratory",
			resamples: 64,
		});
		expect(againstSource.status).toBe("invalid");
		expect(againstSource.error).toContain("eval.suiteHash");
	}, SUITE_TIMEOUT_MS);

	it("keeps a sealed source sealed and prints counts without task identity", async () => {
		const result = await regrade(sealedSource.evalRunId, narrowedGraders);

		expect(result.sealed).toBe(true);
		expect(result.record.evidenceVisibility).toBe("sealed");
		expect(result.flips).toHaveLength(1);

		const summary = renderRegradeSummary(result);
		expect(summary).toHaveLength(2);
		expect(summary[1]).toBe("  1 outcome(s) changed · sealed evidence: task ids withheld");
		const printed = summary.join("\n");
		for (const secret of ["task_alpha", "task_beta", "alpha request", "beta request", "ответ"]) {
			expect(printed).not.toContain(secret);
		}
	}, SUITE_TIMEOUT_MS);

	it("names its source in the ahde list row", async () => {
		const result = await regrade(sourceA.evalRunId, narrowedGraders);
		const line = renderEvalRunListLine(result.record);

		expect(line).toContain(`regrade of ${sourceA.evalRunId}`);
		expect(line).toContain(result.record.evalRunId);
		expect(line).toContain("regrade  ");
		expect(renderEvalRunListLine(sourceA)).not.toContain("regrade of");
	}, SUITE_TIMEOUT_MS);

	it("refuses cases that are not the ones the traces answered", async () => {
		const otherDir = defaultsFixture(mock.url, {
			"evals/development.jsonl": `${JSON.stringify({ id: "task_alpha", input: "another question" })}\n`,
		});
		try {
			await expect(regradeEvalRun({
				runsRoot,
				evalRunId: sourceA.evalRunId,
				target: loadTarget(otherDir),
			})).rejects.toThrow(/exact cases the recorded traces answered/);
		} finally {
			cleanup(otherDir);
		}
	}, SUITE_TIMEOUT_MS);
});

describe("regrade with a judge grader", () => {
	it("re-asks the judge and writes its sidecars under the new run", async () => {
		process.env.MOCK_MODEL_KEY = "test-key";
		let judgeCalls = 0;
		const mock = await startMockModel([
			{
				match: ({ system }) => system.includes("грейдер"),
				resolve: () => {
					judgeCalls += 1;
					return judgeCalls === 1
						? { text: '{"passed": true, "reason": "по существу"}' }
						: { text: '{"passed": false, "reason": "рубрика стала строже"}' };
				},
				steps: [],
			},
			{ match: () => true, steps: [{ text: "Комиссия не взимается." }] },
		]);
		const targetDir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": `id: regrade-judge-target
model:
  provider: qwen-mock
  id: mock
  api: openai-completions
  baseUrl: ${mock.url}
  apiKeyEnv: MOCK_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 60000
instructions:
  agentsMd: AGENTS.md
skills: []
evalSuite:
  id: regrade-judge-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
  judge:
    provider: judge-mock
    id: judge-model
    api: openai-completions
    baseUrl: ${mock.url}
    apiKeyEnv: MOCK_MODEL_KEY
    thinkingLevel: "off"
    timeoutMs: 60000
`,
			"evals/development.jsonl": `${JSON.stringify({
				id: "ask_fee",
				input: "Вопрос про комиссию",
				graders: [{ type: "judge", rubric: "ответ по существу комиссии" }],
			})}\n`,
			"evals/graders.yaml": "defaults: []\n",
		}));
		const runsRoot = join(targetDir, "..", `regrade-judge-runs-${Date.now()}`);
		try {
			const source = await runSuite(loadTarget(targetDir), { runsRoot, label: "solo", repetitions: 1 });
			expect(source.summary).toMatchObject({ total: 1, pass: 1 });
			expect(judgeCalls).toBe(1);
			const targetRequests = mock.requests() - judgeCalls;

			// No --graders: the case keeps its own judge rubric, and the judge model
			// is asked again. That alone can change the verdict.
			const result = await regradeEvalRun({ runsRoot, evalRunId: source.evalRunId, target: loadTarget(targetDir) });

			expect(judgeCalls).toBe(2);
			expect(mock.requests() - judgeCalls).toBe(targetRequests);
			expect(result.record.summary).toMatchObject({ total: 1, pass: 0, fail: 1, error: 0 });
			expect(result.judge).toEqual({ calls: 1, tokens: 49, costUsd: 0 });
			expect(result.flips).toEqual([
				{ taskId: "ask_fee", repetitionIndex: 0, from: "pass", to: "fail" },
			]);

			const runId = result.record.runIds[0]!;
			const derived = loadRun(runsRoot, runId);
			expect(derived.evalResults?.graders[0]).toMatchObject({
				type: "judge",
				passed: false,
				reason: "рубрика стала строже",
			});
			expect(derived.metrics.judge).toEqual({ calls: 1, tokens: 49, costUsd: 0 });

			const sidecar = JSON.parse(readFileSync(join(runsRoot, runId, "judge", "0.json"), "utf8")) as {
				request: { body: { messages: { content: string }[]; temperature: number } };
				response: { status: number; text: string };
			};
			expect(sidecar.request.body.messages[1]?.content).toContain("комиссию");
			expect(sidecar.request.body.temperature).toBe(0);
			expect(sidecar.response.status).toBe(200);
			expect(sidecar.response.text).toContain("строже");
			expect(statSync(join(runsRoot, runId, "judge")).mode & 0o777).toBe(0o700);
			// The source run's own sidecar is untouched evidence of the first verdict.
			const original = JSON.parse(
				readFileSync(join(runsRoot, source.runIds[0]!, "judge", "0.json"), "utf8"),
			) as { response: { text: string } };
			expect(original.response.text).toContain("по существу");

			// Nothing about the scoring configuration changed — only what the judge
			// answered — so the suite identity is deliberately unchanged.
			expect(result.record.suiteHash).toBe(source.suiteHash);
			expect(loadVerifiedEvalRun(runsRoot, result.record.evalRunId).record.summary.fail).toBe(1);
		} finally {
			cleanup(targetDir);
			cleanup(runsRoot);
			await mock.close();
		}
	}, SUITE_TIMEOUT_MS);
});

describe("regrade and infrastructure errors", () => {
	it("keeps an errored source run an error and never grades it", async () => {
		process.env.MOCK_MODEL_KEY = "test-key";
		const mock = await startMockModel([
			{ match: ({ firstUser }) => firstUser.includes("alpha"), steps: [{ text: "ответ alpha" }] },
			// An empty final answer is an infrastructure failure, not a wrong answer.
			{ match: () => true, steps: [{ text: "" }] },
		]);
		const targetDir = defaultsFixture(mock.url);
		const runsRoot = join(targetDir, "..", `regrade-error-runs-${Date.now()}`);
		try {
			const source = await runSuite(loadTarget(targetDir), { runsRoot, label: "solo", repetitions: 1 });
			expect(source.summary).toMatchObject({ total: 2, pass: 1, fail: 0, error: 1 });
			const erroredSource = source.runIds
				.map((runId) => loadRun(runsRoot, runId))
				.find((run) => run.status === "error");
			expect(erroredSource?.taskId).toBe("task_beta");
			const requestsBefore = mock.requests();

			const result = await regradeEvalRun({
				runsRoot,
				evalRunId: source.evalRunId,
				target: loadTarget(targetDir),
			});

			expect(mock.requests()).toBe(requestsBefore);
			expect(result.record.summary).toMatchObject({ total: 2, pass: 1, fail: 0, error: 1 });
			expect(result.flips).toEqual([]);
			const derived = result.record.runIds
				.map((runId) => loadRun(runsRoot, runId))
				.find((run) => run.taskId === "task_beta");
			expect(derived?.status).toBe("error");
			expect(derived?.error).toBe(erroredSource?.error);
			expect(derived?.evalResults).toBeNull();
			expect(derived?.derivedFrom?.runId).toBe(erroredSource?.runId);
			// An errored execution has no verdict to revise, so nothing was graded.
			expect(existsSync(join(runsRoot, derived!.runId, "judge"))).toBe(false);
			expect(loadVerifiedEvalRun(runsRoot, result.record.evalRunId).record.summary.error).toBe(1);
		} finally {
			cleanup(targetDir);
			cleanup(runsRoot);
			await mock.close();
		}
	}, SUITE_TIMEOUT_MS);
});
