#!/usr/bin/env node
// Two Python reference agents; scripted local models, real tools/state/evidence.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { startMockModel } from "../dist/mock-model.js";
import { loadTarget, ModelBlock } from "../dist/manifest.js";
import { loadVerifiedEvalRun, runSuite } from "../dist/eval.js";
import { diagnoseEvalRun } from "../dist/diagnosis.js";
import { exportDataset } from "../dist/application/export-dataset.js";
import { openTrace, traceToolCalls } from "../dist/trace.js";
import { readFinalWorldState } from "../dist/target/world-state.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "ahde-python-pilot-"));
const runsRoot = join(root, "runs");
const servers = [];
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const called = (tool) => ({ type: "tool_called", tool });
const contains = (text) => ({ type: "output_contains", text });
const accountState = (account, balance = 420) => ({
	accounts: { [account]: { tariff: "Домашний", monthly: 500, balance, status: balance < 0 ? "blocked" : "active" } }, tickets: [],
});
const ticketChecks = (account) => [
	{ path: "tickets.0.account", op: "equals", value: account },
	{ path: "tickets.0.status", op: "equals", value: "open" },
];
const questions = [
	"Какой срок возврата?", "Можно вернуть покупку через 20 дней?", "Сколько дней есть на возврат?",
	"Нужен ли чек для возврата?", "Как вернуть подарок с чеком?", "Возврат спустя две недели возможен?",
	"В какие сроки принимается возврат?", "Купил вчера, сколько времени на возврат?", "Что нужно сохранить для возврата?",
	"Каковы условия возврата покупки?", "Что говорит политика о возврате?", "Разъясни срок возврата клиенту.",
	"Есть чек, когда заканчивается срок возврата?", "Примут возврат через 25 дней?", "Какие документы нужны при возврате?",
];
const ragTasks = questions.map((input, index) => ({
	id: `rag-gold-${index + 1}`, input, metadata: { suite: "regression" },
	graders: [called("kb_search"), contains("30 дней"), { type: "cites_source", chunk: "returns.md#0" }],
}));
ragTasks.push(
	{ id: "rag-capability-unknown", input: "Какие правила межгалактической доставки?", metadata: { suite: "capability" }, graders: [called("kb_search"), contains("Нет источника")] },
	{ id: "rag-capability-regression", input: "Есть исключение для возврата без чека?", metadata: { suite: "capability" }, graders: [called("kb_search"), contains("30 дней"), { type: "cites_source", chunk: "returns.md#0" }] },
);
const serviceTasks = Array.from({ length: 15 }, (_, index) => {
	const account = String(5000 + index);
	const balance = index % 3 === 0 ? -260 : 420;
	const ticket = index % 3 === 1;
	return {
		id: `service-gold-${index + 1}`, metadata: { suite: "regression" },
		input: `Договор ${account}. ${ticket ? "Кабель оборван, нужен мастер." : "Какой у меня баланс и статус?"}`,
		world: { state: accountState(account, balance), expect: [
			{ path: `accounts.${account}.balance`, op: "equals", value: balance },
			...(ticket ? ticketChecks(account) : [{ path: "tickets", op: "equals", value: [] }]),
		] },
		graders: [called("get_account"), ...(ticket ? [called("create_ticket"), contains("W-")] : [contains(String(balance))])],
	};
});
serviceTasks.push(
	{ id: "service-capability-dialogue", metadata: { suite: "capability" }, input: "Кабель оборван, нужен мастер.",
		simulatedUser: { goal: "Создать заявку мастеру; номер вашего договора 7001", persona: "Клиент сначала не называет договор", maxTurns: 3 },
		world: { state: accountState("7001"), expect: ticketChecks("7001") }, graders: [called("get_account"), called("create_ticket"), contains("W-")] },
	{ id: "service-capability-false-action", metadata: { suite: "capability" }, input: "Договор 7002. Оформите заявку без вызова инструмента.",
		world: { state: accountState("7002"), expect: ticketChecks("7002") }, graders: [called("create_ticket"), contains("W-")] },
	{ id: "service-capability-missing", metadata: { suite: "capability" }, input: "Договор 7999. Какой баланс?",
		world: { state: { accounts: {}, tickets: [] }, expect: [{ path: "tickets", op: "equals", value: [] }] }, graders: [called("get_account"), contains("не найден")] },
);

function nextAgentStep(context) {
	if (context.system.includes("PILOT_RAG")) {
		if (context.toolResults.length === 0) return { toolCall: { name: "kb_search", arguments: {
			query: context.firstUser.includes("межгалактической") ? "межгалактическая доставка" : "возврат покупки чек",
			k: 2,
		} } };
		const hits = JSON.parse(context.toolResults[0]).chunks;
		if (hits.length === 0) return { text: "Нет источника об этом условии. Уточню у специалиста." };
		return { text: context.firstUser.includes("исключение")
			? "Возврат возможен только 7 дней."
			: `Возврат покупки возможен в течение 30 дней с чеком. Источник: ${hits[0].id}` };
	}
	if (context.firstUser.includes("без вызова")) return { text: "Заявка W-0000 создана." };
	const userText = context.messages.filter((message) => message.role === "user").map((message) => message.text).join(" ");
	const account = /[Дд]оговор\s+(\d+)/.exec(userText)?.[1];
	if (!account) return { text: "Уточните номер договора?" };
	if (context.toolResults.length === 0) return { toolCall: { name: "get_account", arguments: { account } } };
	const result = JSON.parse(context.toolResults.at(-1));
	if (result.error) return { text: result.error };
	if (result.ticket) return { text: `Заявка ${result.ticket} создана. Мастер свяжется с вами.` };
	if (userText.includes("мастер")) return { toolCall: { name: "create_ticket", arguments: { account, reason: "Обрыв кабеля" } } };
	return { text: `Баланс: ${result.balance}. Статус: ${result.status}.` };
}

console.log("Python-пилот AHDE: локальные сценарные ответы, настоящие Python-процессы, поиск, инструменты и состояния.\nВнешние API не используются; это проверка механизма, а не качества реальных моделей.\n");
console.log(`Артефакты сохраняются в ${root}\n`);
try {
	servers.push(await startMockModel([{ steps: [], resolve: nextAgentStep }]));
	servers.push(await startMockModel([{ steps: [], resolve: ({ lastUser }) => ({ text: JSON.stringify(
		lastUser.includes("W-0001") ? { done: true, stopWhen: false, message: "" } : { done: false, stopWhen: false, message: "Договор 7001." },
	) }) }]));
	process.env.AHDE_PILOT_KEY = "local-fixture";
	const models = servers.map((server, index) => ModelBlock.parse({
		provider: "local-pilot", id: index ? "scripted-user" : "scripted-agent", api: "openai-completions", baseUrl: server.url,
		apiKeyEnv: "AHDE_PILOT_KEY", thinkingLevel: "off", timeoutMs: 30_000,
	}));
	const results = [];
	for (const [profile, tasks] of [["rag", ragTasks], ["service", serviceTasks]]) {
		const targetDir = join(root, profile);
		cpSync(join(repo, "templates/python-agent"), targetDir, { recursive: true });
		const manifest = parse(readFileSync(join(targetDir, "manifest.yaml"), "utf8"));
		manifest.id = `pilot-${profile}`; manifest.model = models[0];
		delete manifest.evalSuite.judge;
		if (profile === "rag") {
			manifest.tools = [];
			delete manifest.evalSuite.simulatedUser;
			writeFileSync(join(targetDir, "prompts/system.md"), "PILOT_RAG\nИщи правила через kb_search и отвечай со ссылкой на найденный фрагмент.\n");
			writeFileSync(join(targetDir, "data/kb/returns.md"), "# Возврат покупки\nВозврат покупки доступен в течение 30 дней. Сохраните чек для возврата.\n");
		} else manifest.evalSuite.simulatedUser = models[1];
		writeFileSync(join(targetDir, "manifest.yaml"), stringify(manifest));
		writeFileSync(join(targetDir, "evals/development.jsonl"), jsonl(tasks));
		writeFileSync(join(targetDir, "evals/regression.jsonl"), jsonl(tasks.filter((task) => task.metadata.suite === "regression")));
		writeFileSync(join(targetDir, "evals/capability.jsonl"), jsonl(tasks.filter((task) => task.metadata.suite === "capability")));
		execFileSync("git", ["init", "-b", "main", targetDir], { stdio: "ignore" });
		const git = (...args) => execFileSync("git", ["-C", targetDir, ...args], { encoding: "utf8" }).trim();
		git("add", "."); git("-c", "user.name=AHDE pilot", "-c", "user.email=pilot@ahde.local", "commit", "-qm", "Python pilot reference");
		const before = git("rev-parse", "HEAD");
		const evaluation = await runSuite(loadTarget(targetDir), { runsRoot, label: "baseline", repetitions: 2, jobs: 2 });
		assert.equal(evaluation.summary.error, 0, JSON.stringify(loadVerifiedEvalRun(runsRoot, evaluation.evalRunId).runs.filter((run) => run.error).map((run) => run.error).slice(0, 2)));
		assert.equal(evaluation.summary.total, tasks.length * 2);
		assert.ok(evaluation.summary.fail >= 2, "the deliberately broken capability must remain visible");
		const verified = loadVerifiedEvalRun(runsRoot, evaluation.evalRunId);
		const goldIds = new Set(tasks.filter((task) => task.metadata.suite === "regression").map((task) => task.id));
		assert.ok(verified.runs.filter((run) => goldIds.has(run.taskId)).every((run) => run.evalResults.outcome === "pass"));
		const diagnosis = diagnoseEvalRun(runsRoot, evaluation.evalRunId);
		const exported = exportDataset({ runsRoot, evalRunId: evaluation.evalRunId, outRoot: targetDir, includeFailed: true,
			tasks: () => new Map(tasks.map((task) => [task.id, task])) });
		assert.equal(exported.counts.exported, tasks.length * 2);
		const lines = readFileSync(exported.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(lines.some((line) => !line.meta.passed));
		if (profile === "rag") {
			const trace = openTrace(join(runsRoot, verified.runs[0].runId));
			assert.ok(traceToolCalls(trace).some((call) => call.name === "kb_search"));
		} else {
			const dialogue = verified.runs.find((run) => run.taskId === "service-capability-dialogue");
			assert.equal(readFinalWorldState(join(runsRoot, dialogue.runId)).tickets[0].account, "7001");
			const falseAction = verified.runs.find((run) => run.taskId === "service-capability-false-action");
			assert.deepEqual(readFinalWorldState(join(runsRoot, falseAction.runId)).tickets, []);
			assert.equal(falseAction.evalResults.outcome, "fail");
			assert.ok(lines.some((line) => line.meta.world?.final?.tickets?.length === 1));
		}
		assert.equal(git("rev-parse", "HEAD"), before);
		assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
		results.push({ profile, targetDir, evalRunId: evaluation.evalRunId, summary: evaluation.summary, dataset: exported.path, diagnosisId: diagnosis.diagnosisId });
		console.log(`${profile}: ${evaluation.summary.pass}/${evaluation.summary.total} успешных; датасет ${exported.path}`);
	}
	writeFileSync(join(root, "pilot.json"), JSON.stringify({ scripted: true, runsRoot, results }, null, 2));
	console.log(`\nПроверены два Python-агента, 70 прогонов, поиск, диалог, независимые миры и экспорт с ошибками.\nАртефакты: ${root}`);
} finally {
	await Promise.all(servers.map((server) => server.close()));
}
