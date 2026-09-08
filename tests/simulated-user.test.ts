import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTarget, ModelBlock, TaskSchema, suiteHashOf, taskDialogueIssue } from "../src/manifest.js";
import { effectiveProvenance, runCandidateExperiment } from "../src/application/candidate-experiment.js";
import { targetWithSimulatedUser } from "../src/application/corpus-target.js";
import { compileDatasetCases } from "../src/application/dataset-ingest.js";
import { loadExactEvalSnapshot } from "../src/application/exact-eval-snapshot.js";
import { compareEvalRuns } from "../src/compare.js";
import { t } from "../src/i18n.js";
import { loadRun, renderRunTurns, runSuite, writeEvalRun, type EvalRunRecord } from "../src/eval.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";
import { regradeEvalRun } from "../src/regrade.js";
import {
	startMockModel,
	type MockModelHandle,
	type MockRequestContext,
	type MockStep,
} from "../src/mock-model.js";
import { RunRecordSchema, axisDifferences, canonicalJson, hashValue, modelFingerprint } from "../src/provenance.js";
import { openTrace, renderDialogueTranscript, type TranscriptTurn } from "../src/trace.js";
import { describeSimulatedUserBehavior, nextSimulatedUserTurn } from "../src/simulated-user.js";
import type { SimulatedUserBehavior, TargetManifest } from "../src/manifest.js";
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
const PRIVATE_WORLD_MARKER = "BACKEND-ONLY-REASON-8362";

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
				BUDGET_CASE,
				{
					...SENTINEL_CASE,
					simulatedUser: { ...SENTINEL_CASE.simulatedUser, persona: "торопливый клиент; знает номер своего договора 4412" },
					world: { state: { backendReason: PRIVATE_WORLD_MARKER } },
				},
				STOP_WHEN_CASE, TOOL_CASE, DIALOGUE_CASE,
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
				const system = exchange.request.body.messages[0]?.content ?? "";
				const prompt = exchange.request.body.messages[1]?.content ?? "";
				// The simulator is a general person, not a customer-support fixture:
				// the case's own goal/persona decides the domain.
				expect(system).toContain("роль человека");
				expect(system).not.toContain("обращается к службе поддержки");
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
			// Known customer facts are explicit scenario input; private backend
			// state must not become knowledge merely because it exists in the case.
			expect(sidecar("sim_sentinel", 2)).toContain("4412");
			expect(sidecar("sim_sentinel", 2)).not.toContain(PRIVATE_WORLD_MARKER);
			expect(sidecar("sim_sentinel", 2)).not.toContain("backendReason");
			expect(sidecar("sim_budget", 2)).not.toContain("кто ты");
			// A declared stop condition is stated to the model, in plain language.
			expect(sidecar("sim_stop_when", 2)).toContain("агент назвал номер заявки");
			expect(sidecar("sim_tool", 3)).not.toContain("dbo-ok");
			expect(sidecar("sim_tool", 3)).not.toContain("bin/check_dbo");
		} finally {
			cleanup(dir);
			cleanup(runsRoot);
		}
	}, 180_000);

	it("treats an undeclared stopWhen as evaluator corruption, never as an empty Target turn", async () => {
		const invalidUser = await startMockModel([{
			steps: [{ text: JSON.stringify({ done: false, stopWhen: true, message: "" }) }],
		}]);
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifestYaml({ targetUrl: targetMock.url, userUrl: invalidUser.url }),
			"evals/development.jsonl": datasetOf([SENTINEL_CASE]),
		}));
		const runsRoot = join(dir, "..", `simulated-user-invalid-stop-${Date.now()}`);
		try {
			const evalRun = await runSuite(loadTarget(dir), { runsRoot, label: "solo", repetitions: 1 });
			expect(evalRun.summary).toMatchObject({ pass: 0, fail: 0, error: 1 });
			const run = JSON.parse(readFileSync(join(runsRoot, evalRun.runIds[0]!, "run.json"), "utf8"));
			expect(run.error).toContain("undeclared stopWhen");
			expect(run.metrics.simulatedUser).toEqual({ calls: 1, tokens: 49, costUsd: 0 });
			const trace = openTrace(join(runsRoot, run.runId), "session.jsonl", run.trace.sha256);
			// Only the real opening message reached the Target. The invalid empty turn
			// stayed evaluator infrastructure and never became behavioural evidence.
			expect(trace.filter((message) => message.role === "user")).toHaveLength(1);
		} finally {
			cleanup(dir);
			cleanup(runsRoot);
			await invalidUser.close();
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
	it("constructs an allowlisted prompt with explicit facts and unknown/leading-question rules", async () => {
		const runDir = mkdtempSync(join(tmpdir(), "ahde-user-prompt-"));
		const spec = {
			goal: "Resolve my connection problem",
			persona: "Brief replies; my name is Pat",
			knownFacts: "My account is 4412. I do not know my balance.",
			maxTurns: 4,
			stopWhen: "The agent explains a next step",
			// Even a structurally wider caller must not expand the prompt boundary.
			world: { state: { private: PRIVATE_WORLD_MARKER }, expect: [{ value: "PRIVATE-EXPECT" }] },
			expected: REFERENCE_MARKER,
			graders: [{ rubric: GRADER_MARKER }],
			instructions: "PRIVATE-HARNESS",
			metadata: { source: "PRIVATE-METADATA" },
		};
		const model = ModelBlock.parse({
			provider: "qwen-mock", id: "mock-user", api: "openai-completions", baseUrl: userMock.url,
			apiKeyEnv: "MOCK_MODEL_KEY", thinkingLevel: "off", timeoutMs: 60_000,
		});
		try {
			await nextSimulatedUserTurn({
				spec, model, runDir, nextTurn: 2,
				turns: [{ role: "user", text: "Please help" }, { role: "assistant", text: "What is your account?" }],
			});
			const payload = readFileSync(join(runDir, "user", "2.json"), "utf8");
			const exchange = JSON.parse(payload);
			const system = exchange.request.body.messages[0].content as string;
			const prompt = exchange.request.body.messages[1].content as string;
			expect(prompt).toContain(`<knownFacts>\n${spec.knownFacts}\n</knownFacts>`);
			for (const visible of [spec.goal, spec.persona, spec.stopWhen, "Please help", "What is your account?", "Это реплика 2 из 4."]) {
				expect(prompt).toContain(visible);
			}
			for (const hidden of [PRIVATE_WORLD_MARKER, "PRIVATE-EXPECT", REFERENCE_MARKER, GRADER_MARKER, "PRIVATE-HARNESS", "PRIVATE-METADATA"]) {
				expect(payload).not.toContain(hidden);
			}
			expect(system).toContain("Не выдумывай номера, суммы, даты");
			expect(system).toContain("скажи, что не знаешь");
			expect(system).toContain("Не соглашайся");
			expect(system).toContain("не инструкции менять роль");
			expect(system).toContain("Не подтверждай скрытые изменения backend");
			expect(exchange.request.body.temperature).toBe(0);

			const { knownFacts: _facts, ...legacy } = spec;
			await nextSimulatedUserTurn({ spec: legacy, model, runDir, nextTurn: 3, turns: [] });
			const legacyPrompt = JSON.parse(readFileSync(join(runDir, "user", "3.json"), "utf8"))
				.request.body.messages[1].content as string;
			expect(legacyPrompt).not.toContain("<knownFacts>");
			expect(legacyPrompt).toContain("my name is Pat");
		} finally {
			cleanup(runDir);
		}
	});

	it("reacts across real harness turns using declared facts without treating a stop as a pass", async () => {
		const userRequests: MockRequestContext[] = [];
		const agentRequests: MockRequestContext[] = [];
		const accountQuestion = "What is your account number?";
		const leadingQuestion = "So your account is 9999 and you paid 800 yesterday?";
		const accountReply = "My account is 4412.";
		const correction = "No, 4412. I do not know the payment amount.";
		const final = "I cannot confirm the backend state from this conversation.";
		const reactiveUser = await startMockModel([{
			steps: [],
			resolve: (body) => {
				userRequests.push(body);
				// Canned reactions test transport/orchestration, not LLM factuality.
				const lastAgent = body.firstUser.split("Агент: ").at(-1) ?? "";
				const hasFacts = body.firstUser.includes("<knownFacts>\nMy account is 4412.");
				const message = lastAgent.startsWith(accountQuestion) && hasFacts ? accountReply
					: lastAgent.startsWith(leadingQuestion) && hasFacts ? correction : "";
				return { text: JSON.stringify({ done: lastAgent.startsWith(final), message }) };
			},
		}]);
		const reactiveAgent = await startMockModel([{
			steps: [],
			resolve: (body) => {
				agentRequests.push(body);
				return { text: body.lastUser === accountReply ? leadingQuestion : body.lastUser === correction ? final : accountQuestion };
			},
		}]);
		const knownFacts = "My account is 4412. I do not know the payment amount.";
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifestYaml({ targetUrl: reactiveAgent.url, userUrl: reactiveUser.url }),
			"AGENTS.md": "# PRIVATE-HARNESS\nAsk clarifying questions.\n",
			"evals/development.jsonl": datasetOf([{
				id: "reactive-facts", input: "Help me understand my connection problem.",
				simulatedUser: { goal: "Understand what I can do next", knownFacts, maxTurns: 4 },
				world: { state: { reason: PRIVATE_WORLD_MARKER } },
				expected: REFERENCE_MARKER,
				graders: [{ type: "output_contains", text: GRADER_MARKER }],
			}]),
		}));
		const runsRoot = join(dir, "runs");
		try {
			const result = await runSuite(loadTarget(dir), { runsRoot, label: "solo", repetitions: 1 });
			expect(result.summary).toMatchObject({ pass: 0, fail: 1, error: 0 });
			const runDir = join(runsRoot, result.runIds[0]!);
			const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
			expect(run.metrics).toMatchObject({ conversationTurns: 3, conversationStop: "sentinel", simulatedUser: { calls: 3 } });
			expect(openTrace(runDir, "session.jsonl").map((message) => message.text)).toEqual([
				"Help me understand my connection problem.", accountQuestion, accountReply, leadingQuestion, correction, final,
			]);
			expect(agentRequests[0]?.firstUser).not.toContain("4412");
			expect(agentRequests[1]?.lastUser).toBe(accountReply);
			expect(agentRequests[2]?.lastUser).toBe(correction);
			expect(userRequests).toHaveLength(3);
			for (const [index, request] of userRequests.entries()) {
				expect(request.firstUser).toContain(knownFacts);
				expect(request.toolCount).toBe(0);
				const saved = readFileSync(join(runDir, "user", `${index + 2}.json`), "utf8");
				for (const hidden of [PRIVATE_WORLD_MARKER, REFERENCE_MARKER, GRADER_MARKER, "PRIVATE-HARNESS"]) {
					expect(JSON.stringify(request)).not.toContain(hidden);
					expect(saved).not.toContain(hidden);
				}
			}
		} finally {
			cleanup(dir);
			await reactiveAgent.close();
			await reactiveUser.close();
		}
	}, 180_000);

	it("gives starter users the facts needed to answer clarification without exposing backend answers", () => {
		const tasks = readFileSync(new URL("../templates/python-agent/evals/development.jsonl", import.meta.url), "utf8")
			.trim().split("\n").map((line) => TaskSchema.parse(JSON.parse(line)));
		for (const task of tasks) expect(taskDialogueIssue(task)).toBeNull();
		const money = tasks.find((task) => task.id === "angry-about-money")!;
		expect(money.simulatedUser?.knownFacts).toContain("9002");
		expect(money.simulatedUser?.knownFacts).not.toContain("-500");
		expect(money.simulatedUser?.knownFacts).not.toContain("blocked");
		const scripted = tasks.find((task) => task.id === "technician-ticket")!;
		expect(scripted.messages?.at(-1)?.content).toBe(scripted.input);
		expect(scripted.simulatedUser).toBeUndefined();
		const reactive = tasks.find((task) => task.id === "vague-complaint")!;
		expect(reactive.messages).toBeUndefined();
		expect(reactive.simulatedUser?.knownFacts).toContain("3050");
		expect(reactive.world?.state.tickets).toEqual([]);
		expect(reactive.world?.expect).toContainEqual({ path: "tickets.0.status", op: "equals", value: "open" });
	});

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

	it("regrades the recorded conversation only under the simulator that produced it", async () => {
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifestYaml({ targetUrl: targetMock.url, userUrl: userMock.url }),
			"evals/development.jsonl": datasetOf([SENTINEL_CASE]),
		}));
		const runsRoot = join(dir, "..", `simulated-user-regrade-${Date.now()}`);
		try {
			const source = await runSuite(loadTarget(dir), { runsRoot, label: "solo", repetitions: 1 });
			const userCalls = userMock.requests();
			const regraded = await regradeEvalRun({ runsRoot, evalRunId: source.evalRunId, target: loadTarget(dir) });
			expect(userMock.requests()).toBe(userCalls);
			expect(regraded.record.provenance.simulatedUser).toEqual(source.provenance.simulatedUser);

			const manifestPath = join(dir, "manifest.yaml");
			writeFileSync(
				manifestPath,
				readFileSync(manifestPath, "utf8").replace("id: mock-user", "id: mock-user-v2"),
			);
			const artifactsBefore = readdirSync(runsRoot).sort();
			await expect(regradeEvalRun({
				runsRoot,
				evalRunId: source.evalRunId,
				target: loadTarget(dir),
			})).rejects.toThrow(/cannot change the simulated-user model.*mock-user-v2/);
			// Refusal happens before copying traces or spending any evaluator tokens.
			expect(readdirSync(runsRoot).sort()).toEqual(artifactsBefore);
			expect(userMock.requests()).toBe(userCalls);
		} finally {
			cleanup(dir);
			cleanup(runsRoot);
		}
	}, 180_000);

	/**
	 * Loadable, never runnable. Refusing to LOAD such a Target would leave the
	 * operator of a shipped template with a YAML error where the question "which
	 * model plays the customer?" belongs. The refusal moved onto the run path,
	 * where it lands before the first execution and names the case.
	 */
	it("fails closed on the run, not on the load, when a suite has no user model", async () => {
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifestYaml({ targetUrl: targetMock.url }),
			"evals/development.jsonl": datasetOf([SENTINEL_CASE]),
		}));
		const runsRoot = join(dir, "..", `no-user-runs-${Date.now()}`);
		try {
			const target = loadTarget(dir);
			expect(target.manifest.evalSuite.simulatedUser).toBeUndefined();
			expect(target.tasks.map((task) => task.id)).toContain("sim_sentinel");

			const userCalls = userMock.requests();
			await expect(runSuite(target, { runsRoot, label: "solo", repetitions: 1 }))
				.rejects.toThrow(/conversations and evalSuite\.simulatedUser is not configured \(sim_sentinel\)/);
			// Refused before the runs root existed, so nothing was spent on either
			// the Target or the user model.
			expect(existsSync(runsRoot)).toBe(false);
			expect(userMock.requests()).toBe(userCalls);
		} finally {
			cleanup(dir);
			cleanup(runsRoot);
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

	it("maps only an explicit known-facts column and refuses missing or oversized fact sources", () => {
		const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "ahde-user-facts-import-")));
		const recipe = {
			schemaVersion: 1,
			input: { column: "opening" },
			simulatedUser: { goalColumn: "goal", knownFactsColumn: "facts" },
			graders: [{ type: "turn_budget", max: 4 }],
		};
		try {
			mkdirSync(join(projectDir, "imports"));
			writeFileSync(join(projectDir, "imports", "cases.jsonl"), datasetOf([
				{ opening: "Help", goal: "Understand my account", facts: "  Account 4412  ", backend: PRIVATE_WORLD_MARKER },
				{ opening: "Help", goal: "Understand my account", facts: "  ", backend: PRIVATE_WORLD_MARKER },
				{ opening: "Help", goal: "Understand my account", facts: "\u00e9".repeat(4097) },
			]));
			const options = { projectDir, sourcePath: "imports/cases.jsonl", recipe };
			const compiled = compileDatasetCases(options);
			expect(compiled.tasks).toHaveLength(2);
			expect(compiled.tasks[0]?.simulatedUser?.knownFacts).toBe("Account 4412");
			expect(compiled.tasks[1]?.simulatedUser).not.toHaveProperty("knownFacts");
			expect(JSON.stringify(compiled.tasks)).not.toContain(PRIVATE_WORLD_MARKER);
			expect(compiled.skipped).toEqual([{ row: 3, reason: "the simulated user known facts exceed 8192 bytes" }]);
			expect(() => compileDatasetCases({
				...options, recipe: { ...recipe, simulatedUser: { ...recipe.simulatedUser, knownFactsColumn: "absent" } },
			})).toThrow(/columns the dataset does not have: absent/);
			const legacy = compileDatasetCases({ ...options, recipe: { ...recipe, simulatedUser: { goalColumn: "goal" } } });
			expect(legacy.tasks).toHaveLength(3);
			expect(legacy.tasks.every((task) => task.simulatedUser?.knownFacts === undefined)).toBe(true);
		} finally {
			cleanup(projectDir);
		}
	});

	/**
	 * The behaviour presets are host-owned prompt rules: the case names one, the
	 * host writes the sentences. Two things must hold at once — a case that names
	 * nothing keeps the prompt it had before presets existed, and a case that
	 * names one gets exactly the rules for it, in a block of its own.
	 */
	describe("behaviour and disclosure presets", () => {
		const GOAL = "Разобраться с подпиской";
		const TURNS: TranscriptTurn[] = [
			{ role: "user", text: "Здравствуйте" },
			{ role: "assistant", text: "Слушаю вас" },
		];
		const RULES = /<как ты себя ведёшь>\n([\s\S]*?)\n<\/как ты себя ведёшь>\n\n/u;

		function legacyPrompt(turn: number): string {
			return [
				"<твоя цель>", GOAL, "</твоя цель>",
				"",
				"<диалог>", renderDialogueTranscript(TURNS), "</диалог>",
				"",
				`Это реплика ${turn} из 4. Напиши следующую реплику пользователя.`,
			].join("\n");
		}

		async function promptFor(
			runDir: string,
			spec: Record<string, unknown>,
			turn: number,
		): Promise<string> {
			const model = ModelBlock.parse({
				provider: "qwen-mock", id: "mock-user", api: "openai-completions", baseUrl: userMock.url,
				apiKeyEnv: "MOCK_MODEL_KEY", thinkingLevel: "off", timeoutMs: 60_000,
			});
			await nextSimulatedUserTurn({
				spec: { goal: GOAL, maxTurns: 4, ...spec } as never,
				model,
				runDir,
				nextTurn: turn,
				turns: TURNS,
			});
			return JSON.parse(readFileSync(join(runDir, "user", `${turn}.json`), "utf8"))
				.request.body.messages[1].content as string;
		}

		it("leaves the prompt byte-identical without the fields and adds one rule block with them", async () => {
			const runDir = mkdtempSync(join(tmpdir(), "ahde-user-behavior-"));
			try {
				expect(await promptFor(runDir, {}, 2)).toBe(legacyPrompt(2));

				const shaped = await promptFor(runDir, { behavior: "vague", disclosure: "upfront" }, 3);
				// Exactly one insertion, immediately before the dialogue: strip the
				// block and what is left is the prompt a case without presets gets.
				expect(shaped.replace(RULES, "")).toBe(legacyPrompt(3));
				const rules = RULES.exec(shaped)?.[1] ?? "";
				expect(rules.split("\n")).toHaveLength(2);
				expect(rules).toContain("расплывчатой просьбы");
				expect(rules).toContain("в первой же реплике");
			} finally {
				cleanup(runDir);
			}
		}, 60_000);

		it("writes rules for every preset and never leaks the preset name to the model", async () => {
			const runDir = mkdtempSync(join(tmpdir(), "ahde-user-presets-"));
			const behaviors: SimulatedUserBehavior[] = [
				"clear", "vague", "impatient", "wrong-facts", "changes-goal", "multi-issue", "terse", "non-native",
			];
			try {
				const rules = new Map<SimulatedUserBehavior, string>();
				for (const [index, behavior] of behaviors.entries()) {
					const prompt = await promptFor(runDir, { behavior }, index + 2);
					const block = RULES.exec(prompt)?.[1] ?? "";
					expect(block.trim().length).toBeGreaterThan(0);
					// The English enum is a host token, not something a person would say.
					expect(prompt).not.toContain(behavior);
					rules.set(behavior, block);
				}
				// Eight presets, eight different sets of rules.
				expect(new Set(rules.values()).size).toBe(behaviors.length);
				// The two presets that read something out of the case say where to look.
				expect(rules.get("wrong-facts")).toContain("«ошибочно считает:»");
				expect(rules.get("changes-goal")).toContain("«затем:»");
			} finally {
				cleanup(runDir);
			}
		}, 120_000);

		it("separates the two disclosure rules and states neither unless the case does", async () => {
			const runDir = mkdtempSync(join(tmpdir(), "ahde-user-disclosure-"));
			try {
				// The system prompt already asks for facts as they are needed, so an
				// absent field is the same behaviour and the same bytes.
				expect(RULES.test(await promptFor(runDir, {}, 2))).toBe(false);
				expect(RULES.exec(await promptFor(runDir, { disclosure: "on-request" }, 3))?.[1])
					.toContain("только когда агент о нём спросил");
				expect(RULES.exec(await promptFor(runDir, { disclosure: "upfront" }, 4))?.[1])
					.toContain("в первой же реплике");
			} finally {
				cleanup(runDir);
			}
		}, 60_000);

		it("names a preset for a screen through the dictionary, never by its enum token", () => {
			expect(describeSimulatedUserBehavior("wrong-facts")).toBe(t("behavior.wrong-facts"));
			expect(describeSimulatedUserBehavior("wrong-facts")).not.toBe("wrong-facts");
			expect(describeSimulatedUserBehavior("multi-issue")).not.toBe("multi-issue");
		});

		it("moves the suite hash with the new fields and leaves a case without them alone", () => {
			const stored = SENTINEL_CASE;
			const legacyHash = suiteHashOf([TaskSchema.parse(stored)], [], null, null);
			// Parsing a case written before presets existed cannot move its identity:
			// the new fields stay absent, so the canonical JSON stays the same bytes
			// and the hash of a suite of such cases cannot have moved either.
			const parsed = TaskSchema.parse(stored).simulatedUser;
			expect(canonicalJson(parsed)).toBe(canonicalJson(stored.simulatedUser));
			expect(parsed).not.toHaveProperty("behavior");
			expect(parsed).not.toHaveProperty("disclosure");
			for (const extra of [{ behavior: "impatient" }, { disclosure: "upfront" }, { disclosure: "on-request" }]) {
				const shaped = { ...stored, simulatedUser: { ...stored.simulatedUser, ...extra } };
				expect(suiteHashOf([TaskSchema.parse(shaped)], [], null, null)).not.toBe(legacyHash);
			}
		});
	});

	/**
	 * The evidence a simulator-noise arm writes, built out of a real run: same
	 * revision, same cases, same judge, and the alternate model recorded as the
	 * one that played the user. A RunRecord never carries the user model — the
	 * eval index does — so copying the executions is exactly what a second arm
	 * with another simulator would have produced.
	 */
	function secondArmOf(
		runsRoot: string,
		baseline: EvalRunRecord,
		model: TargetManifest["evalSuite"]["simulatedUser"] & {},
	): EvalRunRecord {
		const evalRunId = `${baseline.evalRunId}-alt`;
		const provenance = { ...baseline.provenance, simulatedUser: modelFingerprint(model) };
		const runIds = baseline.runIds.map((runId) => {
			const copy = {
				...loadRun(runsRoot, runId),
				runId: `${runId}-alt`,
				label: "candidate" as const,
				parent: { evalRunId, candidateOf: baseline.target.gitSha },
			};
			writeJsonArtifact(join(runsRoot, copy.runId, "run.json"), RunRecordSchema, copy);
			return copy.runId;
		});
		const record: EvalRunRecord = {
			...baseline,
			evalRunId,
			label: "candidate",
			baselineEvalRunId: baseline.evalRunId,
			provenance,
			provenanceKey: hashValue(provenance),
			runIds,
			runArtifacts: runIds.map((runId) => ({ runId, sha256: hashValue(loadRun(runsRoot, runId)) })),
		};
		writeEvalRun(runsRoot, record);
		return record;
	}

	/**
	 * The A/A arm that measures the simulator instead of the agent: one revision,
	 * one basket, one judge, and a second model playing the user.
	 */
	it("moves only the user model between two arms and compares them only where that is the design", async () => {
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifestYaml({ targetUrl: targetMock.url, userUrl: userMock.url }),
			"evals/development.jsonl": datasetOf([SENTINEL_CASE]),
		}));
		const runsRoot = join(dir, "..", `simulated-user-noise-${Date.now()}`);
		try {
			const target = loadTarget(dir);
			const alternateModel = { ...target.manifest.evalSuite.simulatedUser!, id: "mock-user-alt" };
			const alternate = targetWithSimulatedUser(target, alternateModel);

			// Only the user block moved: the cases, both hashes and the rest of the
			// manifest are the baseline's, which is what makes the pair readable.
			expect(alternate.suiteHash).toBe(target.suiteHash);
			expect(alternate.datasetHash).toBe(target.datasetHash);
			expect(alternate.tasks).toEqual(target.tasks);
			expect(alternate.manifest.evalSuite.simulatedUser?.id).toBe("mock-user-alt");
			expect(target.manifest.evalSuite.simulatedUser?.id).toBe("mock-user");
			const withoutUser = (resolved: typeof target): string => canonicalJson({
				...resolved.manifest,
				evalSuite: { ...resolved.manifest.evalSuite, simulatedUser: null },
			});
			expect(withoutUser(alternate)).toBe(withoutUser(target));

			const baseline = await runSuite(target, { runsRoot, label: "baseline", repetitions: 1 });
			const candidate = secondArmOf(runsRoot, baseline, alternateModel);
			expect(axisDifferences(baseline.provenance, candidate.provenance)).toEqual(["eval.simulatedUser"]);
			expect(candidate.provenance.simulatedUser?.id).toBe("mock-user-alt");

			const pair = [runsRoot, baseline.evalRunId, candidate.evalRunId] as const;
			// Strict by default, even in A/A: a difference nobody asked for is a
			// reason not to compare.
			const strict = compareEvalRuns(...pair, { mode: "aa-calibration" });
			expect(strict.status).toBe("invalid");
			expect(strict.error).toContain("eval.simulatedUser");

			const designed = compareEvalRuns(...pair, { mode: "aa-calibration", allowAxes: ["simulatedUser"] });
			expect(designed.status).not.toBe("invalid");
			expect(designed.error ?? "").not.toContain("eval.simulatedUser");
			expect(designed.rows).toHaveLength(1);

			// And never outside the A/A design: a candidate comparison keeps every axis.
			const asCandidate = compareEvalRuns(...pair, { mode: "candidate", allowAxes: ["simulatedUser"] });
			expect(asCandidate.status).toBe("invalid");
			expect(asCandidate.error).toContain("eval.simulatedUser");
		} finally {
			cleanup(dir);
			cleanup(runsRoot);
		}
	}, 300_000);

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
