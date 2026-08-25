import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTarget } from "../src/manifest.js";
import { runSuite } from "../src/eval.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
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
		expect(runId).toBeDefined();
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
		const candidate = await runSuite(loadTarget(targetDir), { runsRoot, label: "candidate", repetitions: 1 });
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
		expect(candidateRun).toBeDefined();
		const calls = traceToolCalls(openTrace(join(runsRoot, candidateRun.runId)));
		expect(calls.some((c) => c.name === "bash" && JSON.stringify(c.arguments).includes("check_dbo"))).toBe(true);
	}, 180_000);
});
