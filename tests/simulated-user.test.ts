import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTarget } from "../src/manifest.js";
import { effectiveProvenance, runCandidateExperiment } from "../src/application/candidate-experiment.js";
import { compileDatasetCases } from "../src/application/dataset-ingest.js";
import { loadExactEvalSnapshot } from "../src/application/exact-eval-snapshot.js";
import { renderRunTurns, runSuite } from "../src/eval.js";
import {
	startMockModel,
	type MockModelHandle,
	type MockRequestContext,
	type MockStep,
} from "../src/mock-model.js";
import { axisDifferences, canonicalJson, hashValue } from "../src/provenance.js";
import { openTrace } from "../src/trace.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

/**
 * The simulated user, end to end: a second model plays the human while the real
 * Pi harness answers, and the whole conversation stays one Run with one
 * session.jsonl.
 *
 * Both sides are the scripted mock: the Target streams, the user model answers
 * JSON on the non-streaming path, and neither spends a real token.
 */

const GRADER_MARKER = "ТОКЕН-ГРЕЙДЕРА-777";
const REFERENCE_MARKER = "ЭТАЛОН-999";

/** `Это реплика N из M.` — which turn the user model is being asked for. */
function requestedTurn(prompt: string): number {
	return Number(/Это реплика (\d+) из/u.exec(prompt)?.[1] ?? "0");
}

function userReply(body: MockRequestContext): string {
	const turn = requestedTurn(body.firstUser);
	if (body.firstUser.includes("срок возврата")) {
		// Never finishes on its own: this case must end on the turn budget.
		return JSON.stringify({ done: false, message: `Уточнение ${turn}: а для золотых клиентов?` });
	}
	if (body.firstUser.includes("статус заявки")) {
		return turn >= 3
			? JSON.stringify({ done: true, message: "" })
			: JSON.stringify({ done: false, message: "А можно точнее?" });
	}
	if (body.firstUser.includes("оформить возврат")) {
		return turn >= 3
			? JSON.stringify({ done: false, stopWhen: true, message: "" })
			: JSON.stringify({ done: false, stopWhen: false, message: "И какой номер заявки?" });
	}
	if (body.firstUser.includes("ограничения ДБО")) {
		return JSON.stringify({ done: false, message: "А по второму договору?" });
	}
	return JSON.stringify({ done: true, message: "" });
}

/**
 * The agent numbers every reply, so a missing turn is visible in the trace. One
 * scripted case reaches for a tool on its SECOND turn and answers in plain text
 * on its last, so a `tool_called` grader that only looked at the final reply
 * would fail it.
 */
function agentStep(body: MockRequestContext): MockStep {
	const userTurns = body.messages.filter((message) => message.role === "user").length;
	if (body.firstUser.includes("ограничения ДБО") && userTurns === 2 && body.toolResults.length === 0) {
		return { toolCall: { name: "bash", arguments: { command: "bin/check_dbo --all" } } };
	}
	return { text: `Ответ ${userTurns}: возврат занимает тридцать дней.` };
}

function manifestYaml(options: {
	targetUrl: string;
	userUrl?: string | undefined;
	userModelId?: string;
	judgeUrl?: string | undefined;
	judgeRequireCalibration?: boolean;
}): string {
	return `id: simulated-user-target
model:
  provider: qwen-mock
  id: mock-target
  api: openai-completions
  baseUrl: ${options.targetUrl}
  apiKeyEnv: MOCK_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 60000
instructions:
  agentsMd: AGENTS.md
skills: []
evalSuite:
  id: simulated-user-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
${options.judgeUrl
		? `  judge:
    provider: qwen-mock
    id: mock-judge
    api: openai-completions
    baseUrl: ${options.judgeUrl}
    apiKeyEnv: MOCK_MODEL_KEY
    thinkingLevel: "off"
    timeoutMs: 60000
${options.judgeRequireCalibration ? "    requireCalibration:\n      minAgreement: 0.8\n      minLabels: 20\n" : ""}`
		: ""}${options.userUrl
		? `  simulatedUser:
    provider: qwen-mock
    id: ${options.userModelId ?? "mock-user"}
    api: openai-completions
    baseUrl: ${options.userUrl}
    apiKeyEnv: MOCK_MODEL_KEY
    thinkingLevel: "off"
    timeoutMs: 60000
`
		: ""}`;
}

const BUDGET_CASE = {
	id: "sim_budget",
	input: "Здравствуйте, у меня вопрос по возврату.",
	// Present only to prove the user model never sees it.
	expected: REFERENCE_MARKER,
	simulatedUser: { goal: "узнать срок возврата для золотого клиента", maxTurns: 3 },
	graders: [
		{ type: "turn_budget", max: 2 },
		{ type: "turn_budget", max: 3 },
		{ type: "turn_budget", max: 4 },
		{ type: "output_contains", text: GRADER_MARKER },
	],
};

const SENTINEL_CASE = {
	id: "sim_sentinel",
	input: "Добрый день, нужен статус заявки.",
	simulatedUser: { goal: "узнать статус заявки", persona: "торопливый клиент", maxTurns: 5 },
	graders: [{ type: "output_contains", text: "дней" }],
};

const STOP_WHEN_CASE = {
	id: "sim_stop_when",
	input: "Хочу оформить возврат.",
	simulatedUser: {
		goal: "оформить возврат",
		maxTurns: 5,
		stopWhen: "агент назвал номер заявки",
	},
	graders: [{ type: "output_contains", text: "дней" }],
};

const TOOL_CASE = {
	id: "sim_tool",
	input: "Проверь ограничения ДБО по договору 42.",
	simulatedUser: { goal: "проверить ограничения ДБО", maxTurns: 3 },
	graders: [{ type: "tool_called", tool: "bash", argsContains: "check_dbo" }],
};

const DIALOGUE_CASE = {
	id: "dlg_messages",
	input: "И для золотых клиентов?",
	messages: [
		{ role: "user", content: "Сколько длится возврат?" },
		{ role: "assistant", content: "Тридцать дней." },
		{ role: "user", content: "И для золотых клиентов?" },
	],
	graders: [{ type: "output_contains", text: "дней" }],
};

function datasetOf(tasks: readonly unknown[]): string {
	return `${tasks.map((task) => JSON.stringify(task)).join("\n")}\n`;
}

let targetMock: MockModelHandle;
let userMock: MockModelHandle;

beforeAll(async () => {
	process.env.MOCK_MODEL_KEY = "test-key";
	targetMock = await startMockModel([{ resolve: agentStep, steps: [] }]);
	userMock = await startMockModel([{ resolve: (body) => ({ text: userReply(body) }), steps: [] }]);
});

afterAll(async () => {
	await targetMock.close();
	await userMock.close();
});

describe("a conversation the host plays both sides of", () => {
	it("runs to the budget, ends on the sentinel and on stopWhen, and keeps one trace per Run", async () => {
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifestYaml({ targetUrl: targetMock.url, userUrl: userMock.url }),
			"evals/development.jsonl": datasetOf([
				BUDGET_CASE, SENTINEL_CASE, STOP_WHEN_CASE, TOOL_CASE, DIALOGUE_CASE,
			]),
		}));
		const runsRoot = join(dir, "..", `simulated-user-runs-${Date.now()}`);
		const callsBefore = userMock.requests();
		try {
			const evalRun = await runSuite(loadTarget(dir), { runsRoot, label: "solo", repetitions: 1 });
			expect(evalRun.summary.error).toBe(0);
			// One Run per case: a conversation is never several Runs stitched together.
			expect(evalRun.runIds).toHaveLength(5);
			const runs = evalRun.runIds.map((id) =>
				JSON.parse(readFileSync(join(runsRoot, id, "run.json"), "utf8")));
			const byTask = Object.fromEntries(runs.map((run) => [run.taskId, run]));

			// --- the turn budget ends the first conversation ---
			expect(byTask.sim_budget.metrics.conversationTurns).toBe(3);
			expect(byTask.sim_budget.metrics.conversationStop).toBe("max-turns");
			// Two user-model calls produced turns 2 and 3; the third turn needs none.
			expect(byTask.sim_budget.metrics.simulatedUser).toEqual({ calls: 2, tokens: 98, costUsd: 0 });

			// --- one session.jsonl, carrying every turn of the conversation ---
			const budgetDir = join(runsRoot, byTask.sim_budget.runId);
			expect(readdirSync(budgetDir).filter((entry) => entry.endsWith(".jsonl"))).toEqual(["session.jsonl"]);
			const trace = openTrace(budgetDir, "session.jsonl", byTask.sim_budget.trace.sha256);
			expect(trace.map((message) => message.role)).toEqual([
				"user", "assistant", "user", "assistant", "user", "assistant",
			]);
			expect(trace[0]?.text).toBe(BUDGET_CASE.input);
			expect(trace[2]?.text).toBe("Уточнение 2: а для золотых клиентов?");
			expect(trace[4]?.text).toBe("Уточнение 3: а для золотых клиентов?");
			expect(trace[1]?.text).toBe("Ответ 1: возврат занимает тридцать дней.");
			expect(trace[5]?.text).toBe("Ответ 3: возврат занимает тридцать дней.");

			// --- turn_budget truth table over the same three-turn conversation ---
			expect(byTask.sim_budget.evalResults.graders
				.filter((grader: { type: string }) => grader.type === "turn_budget")
				.map((grader: { passed: boolean }) => grader.passed)).toEqual([false, true, true]);
			expect(byTask.sim_budget.evalResults.graders[0].checkCode).toBe("turn-budget");
			expect(byTask.sim_budget.evalResults.graders[0].reason).toContain("3 turn(s)");

			// --- the sentinel ends the second one before its budget ---
			expect(byTask.sim_sentinel.metrics.conversationTurns).toBe(2);
			expect(byTask.sim_sentinel.metrics.conversationStop).toBe("sentinel");
			expect(byTask.sim_sentinel.evalResults.outcome).toBe("pass");

			// --- stopWhen is reported separately from the plain sentinel ---
			expect(byTask.sim_stop_when.metrics.conversationTurns).toBe(2);
			expect(byTask.sim_stop_when.metrics.conversationStop).toBe("stop-when");

			// --- tool_called sees the whole conversation, not the last reply ---
			// The agent reached for bash on turn 2 and answered in prose on turn 3.
			expect(byTask.sim_tool.metrics.conversationTurns).toBe(3);
			expect(byTask.sim_tool.metrics.toolCalls).toBe(1);
			expect(byTask.sim_tool.evalResults.graders[0]).toMatchObject({
				type: "tool_called",
				passed: true,
			});
			const toolTrace = openTrace(join(runsRoot, byTask.sim_tool.runId), "session.jsonl");
			expect(toolTrace.some((message) => message.toolCalls?.length)).toBe(true);
			expect(toolTrace.at(-1)?.role).toBe("assistant");
			expect(toolTrace.at(-1)?.toolCalls).toBeUndefined();

			// --- one line of `ahde run` per case ---
			expect(renderRunTurns(byTask.sim_budget.metrics)).toBe("  3 turns (max-turns)");
			expect(renderRunTurns(byTask.sim_sentinel.metrics)).toBe("  2 turns (sentinel)");
			expect(renderRunTurns(byTask.dlg_messages.metrics)).toBe("");

			// --- a seeded-history case is untouched by any of this ---
			expect(byTask.dlg_messages.metrics.seededTurns).toBe(2);
			expect(Object.keys(byTask.dlg_messages.metrics)).not.toContain("simulatedUser");
			expect(Object.keys(byTask.dlg_messages.metrics)).not.toContain("conversationTurns");
			expect(Object.keys(byTask.dlg_messages.metrics)).not.toContain("conversationStop");
			expect(existsSync(join(runsRoot, byTask.dlg_messages.runId, "user"))).toBe(false);
			// 2 + 2 + 2 calls for the three conversations, and none for the dialogue.
			expect(userMock.requests() - callsBefore).toBe(8);

			// --- what the user model was allowed to see ---
			const sidecar = (task: string, turn: number): string =>
				readFileSync(join(runsRoot, byTask[task].runId, "user", `${turn}.json`), "utf8");
			for (const turn of [2, 3]) {
				const payload = sidecar("sim_budget", turn);
				const exchange = JSON.parse(payload) as {
					request: { body: { messages: { role: string; content: string }[] } };
				};
				const prompt = exchange.request.body.messages[1]?.content ?? "";
				// It sees the goal and the conversation…
				expect(prompt).toContain("узнать срок возврата для золотого клиента");
				expect(prompt).toContain("Ответ 1: возврат занимает тридцать дней.");
				// …and never the graders, the reference answer, or the suite.
				expect(payload).not.toContain(GRADER_MARKER);
				expect(payload).not.toContain(REFERENCE_MARKER);
				expect(payload).not.toContain("turn_budget");
				expect(payload).not.toContain("output_contains");
				expect(payload).not.toContain("simulated-user-suite");
				expect(payload).not.toContain("sim_budget");
			}
			// A persona reaches the user model exactly when the case declares one.
			expect(sidecar("sim_sentinel", 2)).toContain("торопливый клиент");
			expect(sidecar("sim_budget", 2)).not.toContain("кто ты");
			// A declared stop condition is stated to the model, in plain language.
			expect(sidecar("sim_stop_when", 2)).toContain("агент назвал номер заявки");
		} finally {
			cleanup(dir);
			cleanup(runsRoot);
		}
	}, 180_000);

	it("treats a user-model failure as infrastructure, never as a behavioural failure", async () => {
		const brokenUser = await startMockModel([
			{ steps: [{ httpError: { status: 500, message: "user model exploded" } }] },
		]);
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifestYaml({ targetUrl: targetMock.url, userUrl: brokenUser.url }),
			"evals/development.jsonl": datasetOf([SENTINEL_CASE]),
		}));
		const runsRoot = join(dir, "..", `simulated-user-broken-${Date.now()}`);
		try {
			const evalRun = await runSuite(loadTarget(dir), { runsRoot, label: "solo", repetitions: 1 });
			// Inconclusive evidence, not a failing agent (invariant 9).
			expect(evalRun.summary).toMatchObject({ total: 1, pass: 0, fail: 0, error: 1 });
			const run = JSON.parse(readFileSync(join(runsRoot, evalRun.runIds[0]!, "run.json"), "utf8"));
			expect(run.status).toBe("error");
			expect(run.error).toContain("simulated user HTTP 500");
			expect(run.evalResults).toBeNull();
			// Retried like the judge, and every attempt kept its own evidence.
			expect(run.metrics.simulatedUser.calls).toBe(3);
			const attempts = readdirSync(join(runsRoot, run.runId, "user")).sort();
			expect(attempts).toEqual(["2.1.json", "2.2.json", "2.json"]);
		} finally {
			cleanup(dir);
			cleanup(runsRoot);
			await brokenUser.close();
		}
	}, 180_000);

	it("shows a judge the whole conversation instead of the last reply", async () => {
		const judgePrompts: string[] = [];
		const judgeMock = await startMockModel([
			{
				resolve: (body) => {
					judgePrompts.push(body.firstUser);
					return { text: '{"passed": true, "reason": "агент довёл пользователя до ответа"}' };
				},
				steps: [],
			},
		]);
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifestYaml({
				targetUrl: targetMock.url,
				userUrl: userMock.url,
				judgeUrl: judgeMock.url,
			}),
			"evals/development.jsonl": datasetOf([{
				...BUDGET_CASE,
				graders: [{ type: "judge", rubric: "агент отвечает на каждый вопрос пользователя" }],
			}]),
		}));
		const runsRoot = join(dir, "..", `simulated-user-judge-${Date.now()}`);
		try {
			const evalRun = await runSuite(loadTarget(dir), { runsRoot, label: "solo", repetitions: 1 });
			const run = JSON.parse(readFileSync(join(runsRoot, evalRun.runIds[0]!, "run.json"), "utf8"));
			expect(run.evalResults.outcome).toBe("pass");
			expect(run.metrics.judge.calls).toBe(1);
			expect(run.metrics.simulatedUser.calls).toBe(2);

			const prompt = judgePrompts[0] ?? "";
			// Every turn, both sides — not just the answer the last grader would see.
			expect(prompt).toContain("<диалог агента с пользователем>");
			expect(prompt).toContain(BUDGET_CASE.input);
			expect(prompt).toContain("Ответ 1: возврат занимает тридцать дней.");
			expect(prompt).toContain("Уточнение 2: а для золотых клиентов?");
			expect(prompt).toContain("Ответ 2: возврат занимает тридцать дней.");
			expect(prompt).toContain("Уточнение 3: а для золотых клиентов?");
			expect(prompt).toContain("Ответ 3: возврат занимает тридцать дней.");
			// The judge is told what the person wanted, since that is what it grades.
			expect(prompt).toContain("узнать срок возврата для золотого клиента");

			// The exchange is on disk, exactly as it went over the wire.
			const exchange = JSON.parse(
				readFileSync(join(runsRoot, run.runId, "judge", "0.json"), "utf8"),
			) as { request: { body: { messages: { content: string }[] } } };
			expect(exchange.request.body.messages[1]?.content).toBe(prompt);
		} finally {
			cleanup(dir);
			cleanup(runsRoot);
			await judgeMock.close();
		}
	}, 180_000);
});

describe("the user model is a measurement input", () => {
	function suiteHashFor(files: Record<string, string>): string {
		const dir = makeTargetFixture(baseFixtureFiles(files));
		try {
			return loadTarget(dir).suiteHash;
		} finally {
			cleanup(dir);
		}
	}

	const dataset = datasetOf([SENTINEL_CASE]);

	it("moves the suite hash when the user model changes, and not when a promotion policy does", () => {
		const withUser = suiteHashFor({
			"manifest.yaml": manifestYaml({ targetUrl: targetMock.url, userUrl: userMock.url }),
			"evals/development.jsonl": dataset,
		});
		const withOtherUser = suiteHashFor({
			"manifest.yaml": manifestYaml({
				targetUrl: targetMock.url,
				userUrl: userMock.url,
				userModelId: "mock-user-v2",
			}),
			"evals/development.jsonl": dataset,
		});
		expect(withOtherUser).not.toBe(withUser);

		// `requireCalibration` is promotion policy, not a grading input: it must
		// not invalidate evidence produced by the identical instruments.
		const judged = suiteHashFor({
			"manifest.yaml": manifestYaml({
				targetUrl: targetMock.url,
				userUrl: userMock.url,
				judgeUrl: "http://127.0.0.1:9/v1",
			}),
			"evals/development.jsonl": dataset,
		});
		const judgedCalibrated = suiteHashFor({
			"manifest.yaml": manifestYaml({
				targetUrl: targetMock.url,
				userUrl: userMock.url,
				judgeUrl: "http://127.0.0.1:9/v1",
				judgeRequireCalibration: true,
			}),
			"evals/development.jsonl": dataset,
		});
		expect(judgedCalibrated).toBe(judged);
	});

	it("records the user model as a provenance axis beside the judge's", async () => {
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifestYaml({ targetUrl: targetMock.url, userUrl: userMock.url }),
			"evals/development.jsonl": datasetOf([SENTINEL_CASE]),
		}));
		const runsRoot = join(dir, "..", `simulated-user-axis-${Date.now()}`);
		try {
			const evalRun = await runSuite(loadTarget(dir), { runsRoot, label: "solo", repetitions: 1 });
			expect(evalRun.provenance.simulatedUser).toMatchObject({
				provider: "qwen-mock",
				id: "mock-user",
				apiKeyEnv: "MOCK_MODEL_KEY",
			});
			// The credential value itself is never persisted, only its variable name.
			expect(JSON.stringify(evalRun.provenance)).not.toContain("test-key");
		} finally {
			cleanup(dir);
			cleanup(runsRoot);
		}
	}, 180_000);

	/**
	 * Regression: two of the three places that rebuild a run's provenance carried
	 * the judge axis and dropped the user model. A simulated-user baseline was
	 * therefore never reusable, and the snapshot verifier rejected the very
	 * evidence its own runSuite had just written.
	 */
	it("rebuilds the same axes everywhere: reconstruction, snapshot and the canonical index agree", async () => {
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifestYaml({ targetUrl: targetMock.url, userUrl: userMock.url }),
			"evals/development.jsonl": datasetOf([SENTINEL_CASE]),
		}));
		const runsRoot = join(dir, "..", `simulated-user-parity-${Date.now()}`);
		try {
			const target = loadTarget(dir);
			const evalRun = await runSuite(target, { runsRoot, label: "baseline", repetitions: 1 });

			// 1. candidate-experiment's reconstruction, the input to baseline reuse.
			const reconstructed = effectiveProvenance(loadTarget(dir));
			expect(axisDifferences(reconstructed, evalRun.provenance)).toEqual([]);
			expect(canonicalJson(reconstructed.simulatedUser))
				.toBe(canonicalJson(evalRun.provenance.simulatedUser));
			expect(hashValue(reconstructed)).toBe(evalRun.provenanceKey);

			// 2. exact-eval-snapshot, the verifier every sealed read goes through.
			const snapshot = loadExactEvalSnapshot(runsRoot, evalRun.evalRunId, "development");
			expect(snapshot.runs).toHaveLength(1);
			expect(hashValue(snapshot.record.provenance)).toBe(evalRun.provenanceKey);

			// 3. and the axis is the user model itself, not a placeholder.
			expect(evalRun.provenance.simulatedUser?.id).toBe("mock-user");
		} finally {
			cleanup(dir);
			cleanup(runsRoot);
		}
	}, 180_000);

	it("carries a candidate experiment on a simulated-user suite all the way to evaluated", async () => {
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifestYaml({ targetUrl: targetMock.url, userUrl: userMock.url }),
			"evals/development.jsonl": datasetOf([SENTINEL_CASE]),
		}));
		const runsRoot = join(dir, "..", `simulated-user-candidate-${Date.now()}`);
		try {
			const git = (...args: string[]): string =>
				execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
			git("config", "user.name", "AHDE Test");
			git("config", "user.email", "ahde-test@example.invalid");
			const baselineSha = git("rev-parse", "HEAD");
			writeFileSync(join(dir, "AGENTS.md"), "# Test Agent\n\nОтвечай кратко и называй срок в днях.\n");
			git("add", "-A");
			git("commit", "-qm", "candidate");
			const candidateSha = git("rev-parse", "HEAD");

			const result = await runCandidateExperiment({
				repositoryDir: dir,
				runsRoot,
				baselineRef: baselineSha,
				candidateRef: candidateSha,
				mode: "candidate",
				repetitions: 1,
				projectId: "simulated-user-project",
			});

			expect(result.record.events.map((event) => event.type))
				.toEqual(["proposed", "built", "validated", "evaluated"]);
			expect(result.changedFiles).toEqual(["AGENTS.md"]);
			// Both arms measured the same instrument, and both say so.
			for (const arm of [result.baseline, result.candidate]) {
				expect(arm.provenance.simulatedUser?.id).toBe("mock-user");
				expect(arm.summary.error).toBe(0);
			}
			expect(result.baseline.provenanceKey).toBe(result.candidate.provenanceKey);
			// The comparison the reviewer reads exists, over real conversations, and
			// the pair is comparable — which is exactly what the missing axis broke.
			expect(result.compare.a.evalRunId).toBe(result.baseline.evalRunId);
			expect(result.compare.b.evalRunId).toBe(result.candidate.evalRunId);
			expect(result.compare.status).not.toBe("invalid");
			expect(result.compare.issues).toEqual([]);
		} finally {
			cleanup(dir);
			cleanup(runsRoot);
		}
	}, 300_000);

	it("fails closed when a suite has simulated-user cases and no user model", () => {
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifestYaml({ targetUrl: targetMock.url }),
			"evals/development.jsonl": datasetOf([SENTINEL_CASE]),
		}));
		try {
			expect(() => loadTarget(dir)).toThrow(
				/sim_sentinel: dataset uses simulated-user cases but evalSuite\.simulatedUser model is not configured/,
			);
		} finally {
			cleanup(dir);
		}
	});

	it("refuses a case that carries both a frozen history and a live user", () => {
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifestYaml({ targetUrl: targetMock.url, userUrl: userMock.url }),
			"evals/development.jsonl": datasetOf([{
				...DIALOGUE_CASE,
				simulatedUser: { goal: "что-нибудь", maxTurns: 2 },
			}]),
		}));
		try {
			expect(() => loadTarget(dir)).toThrow(/a case carries messages or simulatedUser, never both/);
		} finally {
			cleanup(dir);
		}
	});

	it("compiles a chat export into simulated-user cases", () => {
		const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "ahde-simulated-user-")));
		try {
			mkdirSync(join(projectDir, "imports"), { recursive: true });
			writeFileSync(
				join(projectDir, "imports", "chats.jsonl"),
				`${[
					JSON.stringify({
						title: "клиент хочет узнать срок возврата",
						messages: [
							{ role: "user", content: "Сколько длится возврат?" },
							{ role: "assistant", content: "Тридцать дней." },
						],
					}),
					JSON.stringify({ title: "", messages: [{ role: "user", content: "Просто вопрос." }] }),
				].join("\n")}\n`,
				"utf8",
			);
			const compiled = compileDatasetCases({
				projectDir,
				sourcePath: "imports/chats.jsonl",
				recipe: {
					schemaVersion: 1,
					// The opening message the agent actually received.
					input: { column: "first_user" },
					simulatedUser: { goalColumn: "title", maxTurns: 4 },
					graders: [{ type: "turn_budget", max: 4 }],
				},
			});

			expect(compiled.tasks).toHaveLength(1);
			expect(compiled.tasks[0]?.input).toBe("Сколько длится возврат?");
			expect(compiled.tasks[0]?.simulatedUser).toEqual({
				goal: "клиент хочет узнать срок возврата",
				maxTurns: 4,
			});
			// A row without a goal cannot become a simulated-user case.
			expect(compiled.skipped).toEqual([{ row: 2, reason: "the simulated user has no goal" }]);

			// A recipe cannot map a frozen dialogue and a live user at once.
			expect(() => compileDatasetCases({
				projectDir,
				sourcePath: "imports/chats.jsonl",
				recipe: {
					schemaVersion: 1,
					input: { column: "first_user" },
					dialogue: { column: "messages" },
					simulatedUser: { goalColumn: "title" },
					graders: [{ type: "turn_budget", max: 4 }],
				},
			})).toThrow(/a recipe maps a dialogue column or a simulated user, never both/);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("refuses a user model that tries to sample", () => {
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": `${manifestYaml({ targetUrl: targetMock.url, userUrl: userMock.url })}    params:
      temperature: 0.9
`,
			"evals/development.jsonl": datasetOf([SENTINEL_CASE]),
		}));
		try {
			expect(() => loadTarget(dir)).toThrow(/evalSuite\.simulatedUser\.params cannot set/);
		} finally {
			cleanup(dir);
		}
	});
});
