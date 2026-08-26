import { existsSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTarget } from "../src/manifest.js";
import { runSuite } from "../src/eval.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import { FINAL_ANSWER_RECOVERY_PROMPT } from "../src/runner.js";
import { openTrace } from "../src/trace.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

/**
 * End-to-end: a real Pi harness session (skills injection, bash tool,
 * session.jsonl tracing) driven by a scripted OpenAI-compatible mock model.
 * Zero real tokens.
 */

let mock: MockModelHandle;
let targetDir: string;
let runsRoot: string;

beforeAll(async () => {
	mock = await startMockModel([
		{
			// task_001 with the narrow skill: answers directly, never calls check_dbo.
			match: ({ system, firstUser }) =>
				!system.includes("для любых обращений") && firstUser.includes("договор"),
			steps: [{ text: "Договор 42 действующий. Ограничений не найдено." }],
		},
		{
			// task_001 with the widened skill: follows it, calls check_dbo via bash.
			match: ({ system, firstUser }) =>
				system.includes("для любых обращений") && firstUser.includes("договор"),
			steps: [
				{ toolCall: { name: "bash", arguments: { command: "bin/check_dbo --all" } } },
				{ text: "Договор 42 действующий. Ограничения ДБО: нет." },
			],
		},
		{
			// task_002: unaffected by the skill change.
			match: ({ firstUser }) => firstUser.includes("Классифицируй"),
			steps: [{ text: "Категория: жалоба." }],
		},
	]);
	void (() => {});

	targetDir = makeTargetFixture(
		baseFixtureFiles({
			"manifest.yaml": `id: test-target
model:
  provider: qwen-mock
  id: qwen3.5-27b
  api: openai-completions
  baseUrl: ${mock.url}
  apiKeyEnv: MOCK_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 60000
instructions:
  agentsMd: AGENTS.md
skills: [skills/check-dbo]
evalSuite:
  id: test-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`,
		}),
	);
	runsRoot = join(targetDir, "..", `ahde-runs-${Date.now()}`);
	process.env.MOCK_MODEL_KEY = "test-key";
});

afterAll(() => {
	cleanup(targetDir);
	cleanup(runsRoot);
	void mock.close();
});

describe("runSuite with real Pi harness + mock model", () => {
	it("runs the suite, grades tasks, writes eval_run and run dirs", async () => {
		const target = loadTarget(targetDir);
		expect(target.manifest.model.baseUrl).toContain("127.0.0.1");

		const evalRun = await runSuite(target, { runsRoot, label: "baseline", repetitions: 1 });
		expect(evalRun.summary.total).toBe(2);
		// weak script: task_001 fails (no check_dbo call), task_002 passes
		expect(evalRun.summary.pass).toBe(1);
		expect(evalRun.summary.fail).toBe(1);
		expect(evalRun.provenanceKey).toMatch(/^sha256:/);

		const runId = evalRun.runIds[0];
		if (!runId) throw new Error("evaluation produced no run id");
		const runDir = join(runsRoot, runId);
		const runJson = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
		expect(runJson.status).toBe("completed");
		expect(runJson.trace.sha256).toMatch(/^sha256:/);
		expect(runJson.trace.sessionId).toBeTruthy();
		expect(runJson.metrics.toolCalls).toBeGreaterThanOrEqual(0);
		expect(runJson.evalResults.outcome).toBe("fail");
		const failedGrader = runJson.evalResults.graders.find(
			(g: { type: string }) => g.type === "tool_called",
		);
		expect(failedGrader.passed).toBe(false);
		expect(failedGrader.reason).toContain("never called bash");

		const session = readFileSync(join(runDir, "session.jsonl"), "utf8");
		expect(session).toContain('"role":"user"');
		expect(session).toContain('"type":"session"');
		expect(statSync(runDir).mode & 0o777).toBe(0o700);
		expect(statSync(join(runDir, "runtime")).mode & 0o777).toBe(0o700);
		expect(statSync(join(runDir, "run.json")).mode & 0o777).toBe(0o600);
		expect(statSync(join(runDir, "session.jsonl")).mode & 0o777).toBe(0o600);
		expect(statSync(join(runDir, "runtime", "models.json")).mode & 0o777).toBe(0o600);

		// eval_run index exists with provenance
		const evalRunJson = JSON.parse(readFileSync(join(runsRoot, evalRun.evalRunId, "eval_run.json"), "utf8"));
		expect(evalRunJson.provenance.piVersion).toBe(target.runtime.piVersion);
		expect(evalRunJson.runIds).toHaveLength(2);
	}, 180_000);

	it("THE THESIS: patching the skill changes agent behavior (baseline fail → candidate pass)", async () => {
		const { writeFileSync } = await import("node:fs");
		const { execFileSync } = await import("node:child_process");

		// Baseline with the narrow skill.
		const baseline = await runSuite(loadTarget(targetDir), { runsRoot, label: "baseline", repetitions: 1 });
		expect(baseline.summary.pass).toBe(1);

		// Patch: widen the skill description.
		writeFileSync(
			join(targetDir, "skills/check-dbo/SKILL.md"),
			`---
name: check-dbo
description: Проверка ограничений ДБО для любых обращений, где упоминаются договоры или списания.
---

Проверь ограничения через bin/check_dbo.
`,
		);
		execFileSync("git", ["-C", targetDir, "add", "."]);
		execFileSync("git", ["-C", targetDir, "-c", "user.name=test", "-c", "user.email=t@t", "commit", "-qm", "widen skill"]);

		// Candidate: same suite, same model, only the harness file changed.
		const candidate = await runSuite(loadTarget(targetDir), {
			runsRoot,
			label: "candidate",
			candidateOf: baseline.target.gitSha,
			baselineEvalRunId: baseline.evalRunId,
			repetitions: 1,
		});
		expect(candidate.summary.pass).toBe(2);
		expect(candidate.target.gitSha).not.toBe(baseline.target.gitSha);

		// Comparable: everything except the target git sha matches.
		const { comparable, provenanceAxes } = await import("../src/provenance.js");
		expect(comparable(baseline.provenance, candidate.provenance)).toBe(true);
		void provenanceAxes;

		// The winning run actually called check_dbo through the bash tool.
		const { loadRun } = await import("../src/eval.js");
		const { openTrace, traceToolCalls } = await import("../src/trace.js");
		const candidateRun = candidate.runIds.map((id) => loadRun(runsRoot, id)).find((r) => r.taskId === "task_001");
		if (!candidateRun) throw new Error("candidate evaluation did not include task_001");
		const calls = traceToolCalls(openTrace(join(runsRoot, candidateRun.runId)));
		expect(calls.some((c) => c.name === "bash" && JSON.stringify(c.arguments).includes("check_dbo"))).toBe(true);
	}, 180_000);
});

describe("judge grader", () => {
	function judgeFixtureFiles(mockUrl: string): Record<string, string> {
		return {
			"manifest.yaml": `id: judge-target
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
  id: judge-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
  judge:
    provider: judge-mock
    id: judge-model
    api: openai-completions
    baseUrl: ${mockUrl}
    apiKeyEnv: MOCK_MODEL_KEY
    thinkingLevel: "off"
    timeoutMs: 60000
`,
			"evals/development.jsonl": [
				JSON.stringify({
					id: "ask_pass",
					input: "Вопрос про комиссию по своей карте",
					graders: [{ type: "judge", rubric: "ответ по существу комиссии" }],
				}),
				JSON.stringify({
					id: "ask_fail",
					input: "Вопрос про тарифы",
					graders: [{ type: "judge", rubric: "ответ по существу тарифов" }],
				}),
			].join("\n"),
			"evals/graders.yaml": "defaults: []\n",
		};
	}

	it("a failed rubric is a fail (not an error); verdicts are recorded in run.json", async () => {
		// Judge requests carry the task input in the user message, so the
		// stateless mock routes a different verdict per task.
		const judgeMock = await startMockModel([
			{
				match: ({ system, firstUser }) => system.includes("грейдер") && firstUser.includes("тарифы"),
				steps: [{ text: '{"passed": false, "reason": "нет существа дела"}' }],
			},
			{
				match: ({ system }) => system.includes("грейдер"),
				steps: [{ text: '{"passed": true, "reason": "классификация и суть верны"}' }],
			},
			{
				match: ({ firstUser }) => firstUser.includes("тарифы"),
				steps: [{ text: "Тарифы зависят от пакета услуг." }],
			},
			{
				match: ({ firstUser }) => firstUser.includes("комиссию"),
				steps: [{ text: "Комиссия за перевод между своими счетами не взимается." }],
			},
		]);
		const dir = makeTargetFixture(baseFixtureFiles(judgeFixtureFiles(judgeMock.url)));
		const judgeRuns = join(dir, "..", `judge-runs-${Date.now()}`);
		try {
			const result = await runSuite(loadTarget(dir), { runsRoot: judgeRuns, label: "solo", repetitions: 1 });
			expect(result.summary.pass).toBe(1);
			expect(result.summary.fail).toBe(1);
			expect(result.summary.error).toBe(0);
			const runs = result.runIds.map((id) => JSON.parse(readFileSync(join(judgeRuns, id, "run.json"), "utf8")));
			const judged = Object.fromEntries(
				runs.map((r) => [r.taskId, r.evalResults.graders.find((g: { type: string }) => g.type === "judge")]),
			);
			expect(judged.ask_pass?.passed).toBe(true);
			expect(judged.ask_pass?.reason).toBe("классификация и суть верны");
			expect(judged.ask_fail?.passed).toBe(false);
			expect(judged.ask_fail?.reason).toBe("нет существа дела");
			// Judge trace sidecar: exact request + raw response on disk.
			for (const run of runs) {
				const judgeDir = join(judgeRuns, run.runId, "judge");
				const tracePath = join(judgeDir, "0.json");
				const trace = JSON.parse(readFileSync(tracePath, "utf8"));
				expect(trace.request.body.messages[0].content).toContain("грейдер");
				expect(trace.request.body.messages[1].content).toContain(run.taskId === "ask_pass" ? "комиссию" : "тарифы");
				expect(trace.response.status).toBe(200);
				expect(trace.response.text).toContain("passed");
				expect(statSync(judgeDir).mode & 0o777).toBe(0o700);
				expect(statSync(tracePath).mode & 0o777).toBe(0o600);
			}
		} finally {
			cleanup(dir);
			cleanup(judgeRuns);
			await judgeMock.close();
		}
	}, 180_000);

	it("unparseable judge output is recorded as infrastructure error, not a grade", async () => {
		const judgeMock = await startMockModel([
			{
				match: ({ system }) => system.includes("грейдер"),
				steps: [{ text: "Не могу оценить ответ." }],
			},
			{
				match: ({ firstUser }) => firstUser.includes("тарифы"),
				steps: [{ text: "Тарифы зависят от пакета услуг." }],
			},
			{
				match: ({ firstUser }) => firstUser.includes("комиссию"),
				steps: [{ text: "Комиссия за перевод между своими счетами не взимается." }],
			},
		]);
		const dir = makeTargetFixture(baseFixtureFiles(judgeFixtureFiles(judgeMock.url)));
		const judgeRuns = join(dir, "..", `judge-err-runs-${Date.now()}`);
		try {
			const evaluation = await runSuite(loadTarget(dir), {
				runsRoot: judgeRuns,
				label: "solo",
				repetitions: 1,
			});
			expect(evaluation.summary).toMatchObject({ pass: 0, fail: 0, error: 2, total: 2 });
			// Evidence survives the infrastructure failure: the unparseable
			// exchange and an explicit run error are both on disk.
			const runDir = readdirSync(judgeRuns).find((entry) => entry.startsWith("run_"));
			const trace = JSON.parse(readFileSync(join(judgeRuns, runDir ?? "", "judge", "0.json"), "utf8"));
			expect(trace.response.text).toContain("Не могу оценить ответ.");
			const run = JSON.parse(readFileSync(join(judgeRuns, runDir ?? "", "run.json"), "utf8"));
			expect(run.status).toBe("error");
			expect(run.error).toMatch(/evaluation infrastructure: judge returned unparseable verdict/);
			expect(run.evalResults).toBeNull();
		} finally {
			cleanup(dir);
			cleanup(judgeRuns);
			await judgeMock.close();
		}
	}, 180_000);
});

describe("target workspace isolation", () => {
	it("uses one immutable source snapshot even if the live Target changes between tasks", async () => {
		let liveTargetDir = "";
		let mutated = false;
		const observedSystems: string[] = [];
		const snapshotMock = await startMockModel([{
			match: ({ system }) => {
				observedSystems.push(system);
				if (!mutated) {
					mutated = true;
					writeFileSync(join(liveTargetDir, "AGENTS.md"), "# MUTATED LIVE TARGET\n");
				}
				return true;
			},
			steps: [{ text: "snapshot-stable" }],
		}]);
		liveTargetDir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": `id: immutable-snapshot-target
model:
  provider: qwen-mock
  id: mock
  api: openai-completions
  baseUrl: ${snapshotMock.url}
  apiKeyEnv: MOCK_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 60000
instructions:
  agentsMd: AGENTS.md
skills: []
evalSuite:
  id: immutable-snapshot-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`,
			"AGENTS.md": "# ORIGINAL SNAPSHOT TARGET\n",
			"evals/development.jsonl": [
				JSON.stringify({
					id: "snapshot-a",
					input: "first task",
					graders: [{ type: "output_contains", text: "snapshot-stable" }],
				}),
				JSON.stringify({
					id: "snapshot-b",
					input: "second task",
					graders: [{ type: "output_contains", text: "snapshot-stable" }],
				}),
			].join("\n"),
		}));
		const snapshotRuns = join(liveTargetDir, "..", `immutable-snapshot-runs-${Date.now()}`);
		try {
			const result = await runSuite(loadTarget(liveTargetDir), {
				runsRoot: snapshotRuns,
				label: "solo",
				repetitions: 1,
			});
			expect(result.summary).toMatchObject({ total: 2, pass: 2, fail: 0, error: 0 });
			expect(observedSystems).toHaveLength(2);
			expect(observedSystems.every((system) => system.includes("ORIGINAL SNAPSHOT TARGET"))).toBe(true);
			expect(observedSystems.every((system) => !system.includes("MUTATED LIVE TARGET"))).toBe(true);
			expect(result.target.workspaceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
			for (const runId of result.runIds) {
				const run = JSON.parse(readFileSync(join(snapshotRuns, runId, "run.json"), "utf8"));
				expect(run.target.workspaceHash).toBe(result.target.workspaceHash);
				expect(readFileSync(join(snapshotRuns, runId, "workspace", "AGENTS.md"), "utf8"))
					.toBe("# ORIGINAL SNAPSHOT TARGET\n");
			}
			expect(readFileSync(join(liveTargetDir, "AGENTS.md"), "utf8")).toBe("# MUTATED LIVE TARGET\n");
		} finally {
			cleanup(liveTargetDir);
			cleanup(snapshotRuns);
			await snapshotMock.close();
		}
	}, 180_000);

	it("supports a nested default runs root without copying evals, state, or secrets into the agent workspace", async () => {
		const snapshotMock = await startMockModel([{ steps: [{ text: "workspace-safe" }] }]);
		const dir = makeTargetFixture(
			baseFixtureFiles({
				"manifest.yaml": `id: snapshot-target
model:
  provider: qwen-mock
  id: mock
  api: openai-completions
  baseUrl: ${snapshotMock.url}
  apiKeyEnv: MOCK_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 60000
instructions:
  agentsMd: AGENTS.md
skills: []
evalSuite:
  id: snapshot-suite
  dataset: benchmarks/development.jsonl
  graders: config/graders.yaml
`,
				"benchmarks/development.jsonl": `${JSON.stringify({
					id: "snapshot",
					input: "Verify the isolated workspace",
					graders: [{ type: "output_contains", text: "workspace-safe" }],
				})}\n`,
				"config/graders.yaml": "defaults: []\n",
				"evals/sealed.jsonl": '{"id":"sealed","input":"HOLDOUT_CANARY"}\n',
				".ahde/projects/snapshot/corpora/sealed/corpus.jsonl": "SEALED_CORPUS_CANARY\n",
				".env": "MODEL_SECRET=env-canary\n",
				".env.local": "MODEL_SECRET=local-env-canary\n",
				".env.example": "MODEL_SECRET=replace-me\n",
				"visible.txt": "safe target input\n",
			}),
		);
		const nestedRunsRoot = join(dir, "runs");
		try {
			const result = await runSuite(loadTarget(dir), {
				runsRoot: nestedRunsRoot,
				label: "solo",
				repetitions: 1,
			});
			expect(result.summary).toMatchObject({ pass: 1, fail: 0, error: 0 });
			const runId = result.runIds[0];
			if (!runId) throw new Error("snapshot evaluation produced no run id");
			const workspace = join(nestedRunsRoot, runId, "workspace");

			expect(readFileSync(join(workspace, "visible.txt"), "utf8")).toBe("safe target input\n");
			expect(readFileSync(join(workspace, ".env.example"), "utf8")).toBe("MODEL_SECRET=replace-me\n");
			expect(existsSync(join(workspace, ".env"))).toBe(false);
			expect(existsSync(join(workspace, ".env.local"))).toBe(false);
			expect(existsSync(join(workspace, ".ahde"))).toBe(false);
			expect(existsSync(join(workspace, "evals"))).toBe(false);
			expect(existsSync(join(workspace, "benchmarks", "development.jsonl"))).toBe(false);
			expect(existsSync(join(workspace, "config", "graders.yaml"))).toBe(false);
			expect(existsSync(join(workspace, "runs"))).toBe(false);
		} finally {
			cleanup(dir);
			await snapshotMock.close();
		}
	}, 180_000);

	it("rejects a git-visible file whose source path traverses a symlinked directory", async () => {
		const dir = makeTargetFixture(baseFixtureFiles({ "safe/file.txt": "tracked-safe\n" }));
		const outside = makeTargetFixture([{ path: "file.txt", content: "EXTERNAL_SECRET_CANARY\n" }], false);
		const target = loadTarget(dir);
		const nestedRunsRoot = join(dir, "runs");
		try {
			rmSync(join(dir, "safe"), { recursive: true, force: true });
			symlinkSync(outside, join(dir, "safe"), "dir");

			await expect(runSuite(target, {
				runsRoot: nestedRunsRoot,
				label: "solo",
				repetitions: 1,
			})).rejects.toThrow(/must not traverse a symlink/);

			const runDir = existsSync(nestedRunsRoot)
				? readdirSync(nestedRunsRoot).find((entry) => entry.startsWith("run_"))
				: undefined;
			if (runDir) {
				expect(existsSync(join(nestedRunsRoot, runDir, "workspace", "safe", "file.txt"))).toBe(false);
			}
		} finally {
			cleanup(dir);
			cleanup(outside);
		}
	}, 180_000);

	it("does not let target tools mutate the source harness repo", async () => {
		const isolatedMock = await startMockModel([
			{
				steps: [
					{ toolCall: { name: "bash", arguments: { command: "chmod +x bin/check_dbo" } } },
					{ text: "done" },
				],
			},
		]);
		const dir = makeTargetFixture(
			baseFixtureFiles({
				"manifest.yaml": `id: isolation-target
model:
  provider: qwen-mock
  id: mock
  api: openai-completions
  baseUrl: ${isolatedMock.url}
  apiKeyEnv: MOCK_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 60000
instructions:
  agentsMd: AGENTS.md
skills: [skills/check-dbo]
evalSuite:
  id: isolation-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`,
				"evals/development.jsonl": `${JSON.stringify({
					id: "mutate",
					input: "Test workspace isolation",
					graders: [{ type: "output_contains", text: "done" }],
				})}\n`,
			}),
		);
		const isolatedRuns = join(dir, "..", `isolation-runs-${Date.now()}`);
		const sourceScript = join(dir, "bin/check_dbo");
		const modeBefore = statSync(sourceScript).mode;
		try {
			const result = await runSuite(loadTarget(dir), { runsRoot: isolatedRuns, label: "solo", repetitions: 1 });
			expect(result.summary.error).toBe(0);
			expect(statSync(sourceScript).mode).toBe(modeBefore);
		} finally {
			cleanup(dir);
			cleanup(isolatedRuns);
			await isolatedMock.close();
		}
	}, 180_000);
});

describe("run completion contract", () => {
	it("records a run error when the model stops without final assistant text", async () => {
		const emptyMock = await startMockModel([{ steps: [{ text: "" }] }]);
		const dir = makeTargetFixture(
			baseFixtureFiles({
				"manifest.yaml": `id: empty-output-target
model:
  provider: qwen-mock
  id: mock
  api: openai-completions
  baseUrl: ${emptyMock.url}
  apiKeyEnv: MOCK_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 60000
instructions:
  agentsMd: AGENTS.md
skills: []
evalSuite:
  id: empty-output-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`,
				"evals/development.jsonl": `${JSON.stringify({
					id: "empty",
					input: "Return nothing",
					graders: [{ type: "output_contains", text: "expected" }],
				})}\n`,
			}),
		);
		const emptyRuns = join(dir, "..", `empty-runs-${Date.now()}`);
		try {
			const result = await runSuite(loadTarget(dir), { runsRoot: emptyRuns, label: "solo", repetitions: 1 });
			expect(result.summary.error).toBe(1);
			const record = JSON.parse(readFileSync(join(emptyRuns, result.runIds[0] ?? "", "run.json"), "utf8"));
			expect(record.error).toContain("no assistant text");
		} finally {
			cleanup(dir);
			cleanup(emptyRuns);
			await emptyMock.close();
		}
	}, 180_000);

	it("recovers once after a tool loop with empty final text, with tools disabled", async () => {
		const recoveryMock = await startMockModel([
			{
				match: ({ lastUser, toolCount }) => lastUser.includes("Сформируй итоговый ответ") && toolCount === 0,
				steps: [{ text: "unused" }, { text: "Recovered final answer" }],
			},
			{
				steps: [
					{ toolCall: { name: "bash", arguments: { command: "echo tool-result" } } },
					{ text: "" },
				],
			},
		]);
		const dir = makeTargetFixture(
			baseFixtureFiles({
				"manifest.yaml": `id: recovery-target
model:
  provider: qwen-mock
  id: mock
  api: openai-completions
  baseUrl: ${recoveryMock.url}
  apiKeyEnv: MOCK_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 60000
instructions:
  agentsMd: AGENTS.md
skills: []
evalSuite:
  id: recovery-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`,
				"evals/development.jsonl": `${JSON.stringify({
					id: "recover",
					input: "Use a tool, then answer",
					graders: [{ type: "output_contains", text: "Recovered final answer" }],
				})}\n`,
			}),
		);
		const recoveryRuns = join(dir, "..", `recovery-runs-${Date.now()}`);
		try {
			const result = await runSuite(loadTarget(dir), { runsRoot: recoveryRuns, label: "solo", repetitions: 1 });
			expect(result.summary.pass).toBe(1);
			const runId = result.runIds[0] ?? "";
			const record = JSON.parse(readFileSync(join(recoveryRuns, runId, "run.json"), "utf8"));
			expect(record.metrics.recoveryAttempts).toBe(1);
			const messages = openTrace(join(recoveryRuns, runId));
			expect(messages.some((message) => message.role === "user" && message.text === FINAL_ANSWER_RECOVERY_PROMPT)).toBe(true);
		} finally {
			cleanup(dir);
			cleanup(recoveryRuns);
			await recoveryMock.close();
		}
	}, 180_000);
});
