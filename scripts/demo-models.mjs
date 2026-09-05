#!/usr/bin/env node
// Scripted local models, real Pi execution / corpus / traces / Git / human gates.
// Prices below are fixture rates, never market prices or a claim about a real model.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { startMockModel } from "../dist/mock-model.js";
import { createAhdeWorkbench } from "../dist/workbench/workbench.js";
import { loadTarget, ModelBlock } from "../dist/manifest.js";
import { loadModelExperiment } from "../dist/application/model-experiment.js";
import { renderModelExperiment, renderModelAcceptance } from "../dist/builder/render/model-experiment.js";
import { plainPaint } from "../dist/builder/render/paint.js";
import { setLanguage } from "../dist/i18n.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "ahde-model-demo-"));
const projectDir = join(root, "target");
const runsRoot = join(root, "runs");
const stateRoot = join(root, "state");
const projectId = "model-demo";
const servers = [];
setLanguage(process.env.AHDE_LANG === "en" ? "en" : "ru");
const git = (...args) => execFileSync("git", ["-C", projectDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const good = "Возврат возможен в течение 30 дней после покупки. Сохраните чек.";
const questions = [
	"Какой срок возврата товара?", "Можно вернуть покупку через 20 дней?", "Сколько дней действует возврат?",
	"Купил вчера. До какого дня можно вернуть?", "Прошло две недели, ещё успею вернуть?", "Подскажи срок возврата подарка.",
	"Где заканчивается окно возврата?", "Покупка месячной давности: какой общий срок?", "Напомни политику возврата.",
	"Срок на чеке не указан. Сколько дней есть?", "Три недели после покупки. Ещё можно вернуть?", "Нужны условия срока возврата.",
	"Осталась неделя до 30 дней. Каков полный срок?", "Возврат через 25 дней — что говорит политика?", "Объясни клиенту окно возврата.",
];
console.log("Сценарная демонстрация: локальные модели, фиктивные тарифы, без внешних API и расходов.\n");

try {
	servers.push(await startMockModel([{ steps: [{ text: good, delayMs: 20 }] }]));
	servers.push(await startMockModel([{ steps: [{ text: good, delayMs: 5 }] }]));
	const badQuestions = new Set(questions.slice(0, 6));
	servers.push(await startMockModel([
		{ match: ({ firstUser }) => badQuestions.has(firstUser), steps: [{ text: "Возврат доступен только 7 дней." }] },
		{ steps: [{ text: good }] },
	]));
	cpSync(join(repo, "templates", "basic-agent"), projectDir, { recursive: true });
	writeFileSync(join(projectDir, "AGENTS.md"), "# Политика возвратов\nОтвечай на вопрос по правилу: возврат доступен 30 дней после покупки, нужен чек.\n");
	const definitions = servers.map((server, index) => ModelBlock.parse({
		provider: "demo-models", id: ["current", "efficient", "cheap-but-wrong"][index],
		api: "openai-completions", baseUrl: server.url, apiKeyEnv: "AHDE_MODEL_DEMO_KEY",
		thinkingLevel: "off", timeoutMs: 30_000,
		spec: { cost: { input: [8, 1, 0.25][index], output: [24, 3, 0.75][index], cacheRead: 0, cacheWrite: 0 } },
	}));
	const manifestPath = join(projectDir, "manifest.yaml");
	const manifest = parse(readFileSync(manifestPath, "utf8"));
	manifest.id = "model-demo-agent"; manifest.model = definitions[0]; manifest.execution.tools = ["read"]; manifest.tools = [];
	writeFileSync(manifestPath, stringify(manifest));
	git("init", "-b", "main"); git("config", "user.name", "AHDE model demo"); git("config", "user.email", "demo@ahde.local");
	git("add", "."); git("commit", "-m", "Scripted model experiment baseline");
	process.env.AHDE_MODEL_DEMO_KEY = "local-fixture";
	const workbench = createAhdeWorkbench({ projectDir, runsRoot, stateRoot, projectId });
	const gate = {
		async confirm(confirmation) {
			console.log(`[Сценарное подтверждение] ${confirmation.title}`);
			return { approved: true, actorId: "demo:scripted-operator" };
		},
		async selectSealed() { throw new Error("Model experiments must never open a sealed exam"); },
	};
	await workbench.submit({ kind: "spec-draft", spec: {
		schemaVersion: 1, title: "Поддержка возвратов", purpose: "Объяснять политику возвратов",
		users: ["Покупатели"], jobs: ["Ответить о сроке возврата"], inputs: ["Вопрос"], allowedActions: ["Ответить по политике"],
		successCriteria: ["Верно назвать срок 30 дней"], constraints: ["Не придумывать сроки"], openQuestions: [],
	} });
	await workbench.decide({ kind: "approve-spec", reason: "Approve demo intent" }, gate);
	await workbench.submit({ kind: "corpus-draft", name: "Пятнадцать сценарных вопросов", revisionSummary: "Fixture cases for the model experiment", tasks: questions.map((input) => ({ input, graders: [{ type: "output_contains", text: "30 дней" }] })) });
	await workbench.decide({ kind: "publish-corpus", reason: "Publish demo cases" }, gate);
	const baseSha = git("rev-parse", "HEAD");
	const result = await workbench.decide({
		kind: "model-experiment", models: definitions.slice(1).map((model) => ({ provider: model.provider, modelId: model.id })),
		repetitions: 2, executionBudget: 90, qualityTolerance: 0, objective: "cost", reason: "Find a less expensive model on these exact cases",
	}, gate, { resolveTargetModel: (selection) => {
		const model = definitions.find((item) => item.id === selection.modelId && item.provider === selection.provider);
		assert.ok(model); return model;
	} });
	const experiment = result.result.experiment;
	assert.equal(experiment.status, "completed");
	assert.equal(experiment.recommendedArmId, "model-1");
	assert.equal(experiment.arms[1].quality.withinTolerance, true);
	assert.equal(experiment.arms[2].quality.withinTolerance, false);
	assert.ok(experiment.arms[2].quality.regressions.length > 0);
	assert.equal(git("rev-parse", "HEAD"), baseSha);
	assert.equal(result.view.counts.developmentEvals, 0, "exploratory arms cannot become ordinary baseline evidence");
	assert.equal(servers.reduce((sum, server) => sum + server.requests(), 0), 90);
	assert.deepEqual(loadModelExperiment(runsRoot, experiment.id, { targetDir: projectDir }), experiment);
	const failure = experiment.arms[2].quality.regressions[0];
	const trace = await workbench.view({ aspect: "models", experimentId: experiment.id, armId: "model-2", runId: failure.candidateRunId });
	assert.ok(trace.detail.content.selectedRun.transcript.entries.some((entry) => entry.kind === "assistant" && entry.text.includes("7 дней")));
	const text = renderModelExperiment(experiment, plainPaint).join("\n");
	console.log(`\n${text}\n`);
	writeFileSync(join(root, "experiment.json"), JSON.stringify(experiment, null, 2));
	writeFileSync(join(root, "result.txt"), `Сценарная демонстрация; фиктивные тарифы.\n\n${text}\n`);
	const accepted = await workbench.decide({ kind: "accept-model", experimentId: experiment.id, armId: "model-1", reason: "Choose the measured demo alternative" }, gate);
	assert.equal(loadTarget(projectDir).manifest.model.id, "efficient");
	assert.equal(accepted.view.stage, "ready-to-evaluate");
	assert.equal(git("diff", "--name-only", baseSha, "HEAD"), "manifest.yaml");
	console.log(renderModelAcceptance(accepted.result.receipt, plainPaint).join("\n"));
	const baseline = await workbench.decide({ kind: "run-eval", repetitions: 1, reason: "Establish an ordinary baseline after the model choice" }, gate);
	assert.equal(baseline.result.evaluation.summary.pass, 15);
	assert.equal(baseline.view.stage, "improvement-authoring");
	console.log(`\nПроверено: 90 исполнений сравнения; точное принятие; 15 исполнений нового baseline.\nАртефакты: ${root}\n`);
} finally {
	await Promise.all(servers.map((server) => server.close()));
}
