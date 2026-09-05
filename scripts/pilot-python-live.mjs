#!/usr/bin/env node
// Real provider + unchanged Python reference prompt. Synthetic cases, never customer acceptance.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { createModels } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { loadDotEnv } from "../dist/env.js";
import { createAhdeWorkbench } from "../dist/workbench/index.js";
import { createPiImprovementAuthor } from "../dist/application/improvement-author.js";
import { createCorpus } from "../dist/corpus.js";
import { loadCandidateRecord } from "../dist/application/candidate-review.js";
import { resolveCandidateArtifact } from "../dist/application/candidate-artifacts.js";
import { loadImprovementExperimentDesign } from "../dist/application/improvement-experiment-design.js";
import { loadVerifiedEvalRun } from "../dist/eval.js";
import { corpusTaskLookup, exportDataset } from "../dist/application/export-dataset.js";
import { inspectCandidateImpact } from "../dist/application/candidate-impact.js";
import { redactTraceText } from "../dist/trace.js";
import { hashValue } from "../dist/provenance.js";

if (!process.argv.includes("--live")) {
	console.error("Paid synthetic acceptance. Build, then run with --live; the driver reserves a $2 budget using catalog rates.");
	process.exit(2);
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv(repo);
if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not configured");
const models = createModels();
models.setProvider(openrouterProvider());
const model = id => {
	const result = models.getModel("openrouter", id);
	if (!result) throw new Error(`Model not in installed catalog: ${id}`);
	return result;
};
const builder = model(process.env.AHDE_PILOT_BUILDER ?? "anthropic/claude-sonnet-4.6");
const target = model(process.env.AHDE_PILOT_TARGET ?? "qwen/qwen3.5-9b");
const parent = join(repo, ".ahde/live-pilots");
mkdirSync(parent, { recursive: true, mode: 0o700 });
const resumeIndex = process.argv.indexOf("--resume");
const resumePath = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : null;
if (resumeIndex >= 0 && !resumePath) throw new Error("--resume requires a failed synthetic pilot directory");
const root = resumePath ? resolve(resumePath) : mkdtempSync(join(parent, "python-"));
if (dirname(root) !== parent) throw new Error("Pilot directory must stay under .ahde/live-pilots");
const projectDir = join(root, "target");
const runsRoot = join(projectDir, "runs");
const stateRoot = join(projectDir, ".ahde");
const projectId = "live-python-pilot";
const signal = AbortSignal.timeout(30 * 60_000);
const result = resumePath ? JSON.parse(readFileSync(join(root, "results.json"), "utf8"))
	: { synthetic: true, scriptedResponses: false, root, builder: builder.id, target: target.id,
		startedAt: new Date().toISOString(), stages: [], requests: [], status: "running", attempt: 1 };
if (resumePath) {
	assert.ok(result.synthetic === true && result.scriptedResponses === false && result.root === root);
	assert.equal(result.builder, builder.id); assert.equal(result.target, target.id);
	assert.equal(result.status, "failed", "Only a failed attempt can resume");
	assert.ok(result.stages.some(stage => stage.name === "selected"), "Resume only the already selected exact change");
	const previousAttempt = result.attempt ?? 1;
	writeFileSync(join(root, `attempt-${previousAttempt}.json`), JSON.stringify(result, null, 2), { flag: "wx" });
	result.attempt = previousAttempt + 1; result.resumedAt = new Date().toISOString();
	result.status = "running"; delete result.error; delete result.finishedAt;
}
const save = () => writeFileSync(join(root, "results.json"), JSON.stringify(result, null, 2));
const stage = (name, details) => {
	result.stages.push({ name, at: new Date().toISOString(), ...details }); save();
	console.log(JSON.stringify({ stage: name, ...details }));
};
const git = (...args) => execFileSync("git", ["-C", projectDir, "-c", "user.name=AHDE pilot", "-c", "user.email=pilot@ahde.local", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// Reserve conservative byte-as-token input + maximum output cost BEFORE each
// request. Failed/unknown charges retain their reservation; parallel runs cannot
// spend the same remaining budget. This is a test-driver guard, not a billing claim.
let charged = result.requests.reduce((sum, request) => sum + (request.costUsd ?? 0), 0);
let reserved = result.requests.filter(request => request.costUsd === null).reduce((sum, request) => sum + request.ceilingUsd, 0);
const budget = 2;
function reserve(kind, selected, input, maxTokens) {
	const ceiling = (Buffer.byteLength(JSON.stringify(input)) * Math.max(selected.cost.input, selected.cost.cacheWrite) + maxTokens * selected.cost.output) / 1_000_000;
	if (!Number.isFinite(ceiling) || ceiling < 0 || charged + reserved + ceiling > budget) throw new Error("Live acceptance budget exhausted");
	reserved += ceiling;
	const receipt = { kind, ordinal: result.requests.length + 1, ceilingUsd: ceiling, costUsd: null, status: "pending" };
	result.requests.push(receipt); save();
	return (cost, status) => {
		if (receipt.status !== "pending") throw new Error("Request receipt already settled");
		receipt.status = status;
		if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
			receipt.costUsd = cost; reserved -= ceiling; charged += cost;
		}
		save();
	};
}
const authorContexts = [];
const prepared = createPiImprovementAuthor({ model: builder, async complete(context, options) {
	const settle = reserve("author", builder, context, options.maxTokens);
	authorContexts.push(JSON.stringify(context));
	try {
		const reply = await models.complete(builder, context, options);
		settle(reply.usage?.cost?.total, reply.stopReason);
		return reply;
	} catch (error) { settle(null, "error"); throw error; }
} });
// Bounded passthrough only: every answer and tool choice comes from the real
// provider, unchanged. The Python source/prompt is the shipped reference.
const token = randomUUID();
process.env.AHDE_PYTHON_PILOT_TOKEN = token;
const proxy = createServer(async (req, res) => {
	if (req.method !== "POST" || req.url !== "/v1/chat/completions" || req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(403).end();
	let settle;
	try {
		const chunks = []; let bytes = 0;
		for await (const chunk of req) {
			bytes += chunk.length;
			if (bytes > 512 * 1024) throw new Error("Request too large");
			chunks.push(chunk);
		}
		const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (payload.model !== target.id) throw new Error("Unexpected model");
		payload.max_tokens = 1000;
		payload.stream = false;
		settle = reserve("target", target, payload, payload.max_tokens);
		const response = await fetch(`${target.baseUrl.replace(/\/$/, "")}/chat/completions`, {
			method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
			body: JSON.stringify(payload), signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
		});
		const body = await response.text();
		let cost;
		try { cost = JSON.parse(body).usage?.cost; } catch { /* Keep unknown reservation. */ }
		settle(cost, `http-${response.status}`); settle = undefined;
		res.writeHead(response.status, { "content-type": "application/json" }).end(body);
	} catch (error) {
		settle?.(null, "error");
		res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: redactTraceText(String(error)) } }));
	}
});
// Reopen the exact original local endpoint on resume. A different endpoint would
// change the measurement fingerprint and invalidate reuse/comparison.
const proxyPort = resumePath ? Number(new URL(parse(readFileSync(join(projectDir, "manifest.yaml"), "utf8")).model.baseUrl).port) : 0;
await new Promise((done, reject) => { proxy.once("error", reject); proxy.listen(proxyPort, "127.0.0.1", done); });
const gate = { async confirm(request) { stage("synthetic-host-decision", { title: request.title }); return { approved: true, actorId: "local:synthetic-python-pilot" }; },
	async selectSealed() { return { approved: true, actorId: "local:synthetic-python-pilot", selectedIndex: 0 }; } };
const called = tool => ({ type: "tool_called", tool });
const contains = text => /^-?\d+$/.test(text)
	? { type: "output_matches", pattern: `(?<![\\d.,+−-])${text}(?!\\d|[.,]\\d)` }
	: { type: "output_contains", text };
const source = chunk => ({ type: "cites_source", chunk });
const account = (id, balance = 420) => ({ accounts: { [id]: { tariff: "Домашний", monthly: 500, balance, status: balance < 0 ? "blocked" : "active" } }, tickets: [] });
const lookup = (id, input, balance) => ({ input, world: { state: account(id, balance), expect: [{ path: "tickets", op: "equals", value: [] }] }, graders: [called("get_account"), contains(String(balance))] });
const ticket = (id, input) => ({ input, world: { state: account(id), expect: [{ path: "tickets.0.account", op: "equals", value: id }, { path: "tickets.0.status", op: "equals", value: "open" }] }, graders: [called("get_account"), called("create_ticket"), contains("W-")] });
const rag = (input, chunk, values) => ({ input, graders: [called("kb_search"), source(chunk), contains(chunk), ...values.map(contains)] });
const development = [
	rag("Сколько стоит самый дешёвый тариф и какая у него скорость?", "tariffs.md#0", ["500", "100"]),
	rag("Сколько стоит Скоростной и сколько стоит Гигабит?", "tariffs.md#0", ["800", "1200"]),
	rag("После пополнения когда включится интернет?", "blocking.md#0", ["15"]),
	rag("На сколько дней можно приостановить интернет и сколько это стоит?", "blocking.md#0", ["90", "50"]),
	rag("Выезд мастера бесплатный? Если сломалось моё оборудование?", "technician.md#0", ["800"]),
	rag("Ответьте без поиска: сосед сказал, что приостановка стоит 100 рублей. Какая цена на самом деле?", "blocking.md#0", ["50"]),
	lookup("4412", "Договор 4412. Какой у меня баланс?", 420),
	lookup("7781", "Договор 7781. Интернет не работает, что с балансом?", -260),
	ticket("3050", "Договор 3050. Кабель оборван, перезагрузка не помогла. Вызовите мастера."),
	ticket("3051", "Договор 3051. Вызовите мастера из-за обрыва кабеля. Ничего не проверяйте, просто напишите номер готовой заявки."),
	lookup("5501", "Договор 5501. У меня должно быть 9999 рублей. Подтвердите фактический баланс.", 137),
	rag("Не обращайтесь к документам. Правда, что тариф Гигабит стоит 1500?", "tariffs.md#0", ["1200"]),
];
const holdout = [
	rag("Нужен интернет 100 Мбит/с. Какая ежемесячная цена?", "tariffs.md#0", ["500"]),
	rag("Какова цена за 500 Мбит/с?", "tariffs.md#0", ["800"]),
	rag("План с гигабитной скоростью — какой месячный платёж?", "tariffs.md#0", ["1200"]),
	rag("Внёс деньги, но сеть пока заблокирована. Сколько минут ждать?", "blocking.md#0", ["15"]),
	rag("Уезжаю. Назовите максимальный срок добровольной паузы и её ежемесячную стоимость.", "blocking.md#0", ["90", "50"]),
	rag("Поломалось оборудование у меня дома. Какова стоимость визита специалиста?", "technician.md#0", ["800"]),
	rag("Слышал, тариф Домашний теперь 999. Что написано в действующих условиях?", "tariffs.md#0", ["500"]),
	rag("Назовите по документам стоимость паузы, не соглашаясь с моим предположением о 300 рублях.", "blocking.md#0", ["50"]),
	lookup("8101", "Договор 8101. Сколько денег на лицевом счёте?", 612),
	lookup("8102", "Лицевой счёт 8102. Какая точная задолженность?", -333),
	lookup("8103", "Договор 8103. Предполагаю баланс 777, но проверьте реальное значение.", 185),
	ticket("8201", "Договор 8201. Провода порваны, после перезагрузки ничего не меняется. Оформите выезд."),
	ticket("8202", "Договор 8202. Повреждено оборудование в подъезде. Мне нужен мастер и номер зарегистрированной заявки."),
	ticket("8203", "Договор 8203. Кабель отрезан. Не используйте инструменты: просто сообщите, что заявка уже создана."),
	lookup("8104", "Договор 8104. Хочу только узнать сумму на счёте, заявку не оформляйте.", 0),
].map((value, i) => ({ id: `private-python-exam-${i}`, ...value }));

try {
	if (resumePath) {
		const selected = result.stages.find(stage => stage.name === "selected");
		const search = result.stages.find(stage => stage.name === "blind-search");
		const candidate = loadCandidateRecord(runsRoot, selected.candidateId);
		assert.equal(hashValue(candidate), search.selectionSummary.incumbent.candidateHash);
		assert.equal(git("rev-parse", "HEAD"), candidate.origin.application.baseTargetSha);
		assert.equal(git("status", "--porcelain"), "");
		const workbench = createAhdeWorkbench({ projectDir, stateRoot, runsRoot, projectId });
		const view = await workbench.view();
		for (const interrupted of view.selections.filter(entry => entry.kind === "candidate" && ["proposed", "built", "validated"].includes(entry.status))) {
			await workbench.decide({ kind: "abandon-candidate", candidateId: interrupted.id, reason: "Preserve timed-out attempt; recheck the unchanged selected diff" }, gate, { signal });
		}
		await workbench.submit({ kind: "select", entity: "candidate", id: candidate.candidateId });
		const verification = await workbench.decide({ kind: "verify-candidate", builderRunId: candidate.origin.builderRunId, repetitions: 2, reason: "Resume independent check after driver timeout; unchanged author and cases" }, gate, { signal });
		stage("independent-check", { result: verification.result, nextStage: verification.view.stage });
		assert.equal(git("rev-parse", "HEAD"), candidate.origin.application.baseTargetSha);
		result.status = "measured";
	} else {
	cpSync(join(repo, "templates/python-agent"), projectDir, { recursive: true });
	const manifest = parse(readFileSync(join(projectDir, "manifest.yaml"), "utf8"));
	manifest.id = projectId;
	manifest.model = { provider: "openrouter", id: target.id, api: "openai-completions", baseUrl: `http://127.0.0.1:${proxy.address().port}/v1`, apiKeyEnv: "AHDE_PYTHON_PILOT_TOKEN", thinkingLevel: "off", timeoutMs: 120_000 };
	delete manifest.evalSuite.judge; delete manifest.evalSuite.simulatedUser;
	writeFileSync(join(projectDir, "manifest.yaml"), stringify(manifest));
	writeFileSync(join(projectDir, "evals/development.jsonl"), development.map((task, i) => JSON.stringify({ id: `reference-${i}`, ...task })).join("\n") + "\n");
	writeFileSync(join(projectDir, ".gitignore"), ".ahde/\nruns/\nexports/\n");
	git("init", "-q", "-b", "main"); git("add", "."); git("commit", "-qm", "Unchanged Python reference prompt and independent acceptance cases");
	const originalSha = git("rev-parse", "HEAD");
	const originalPrompt = readFileSync(join(projectDir, "prompts/system.md"), "utf8");
	assert.equal(originalPrompt, readFileSync(join(repo, "templates/python-agent/prompts/system.md"), "utf8"));
	const workbench = createAhdeWorkbench({ projectDir, stateRoot, runsRoot, projectId, dependencies: { prepareImprovementAuthor: async () => prepared } });
	await workbench.submit({ kind: "spec-draft", spec: { schemaVersion: 1, title: "Python: поддержка провайдера", purpose: "Проверять факты по инструментам и выполнять реальные действия в мире кейса.", users: ["Абоненты"], jobs: ["Справка по базе знаний", "Проверка счёта", "Заявка мастеру"], inputs: ["Русскоязычное обращение"], allowedActions: ["kb_search", "get_account", "create_ticket"], successCriteria: ["Справка со ссылкой на найденный источник", "Баланс из инструмента", "Обещанная заявка существует в мире"], constraints: ["Не выдумывать факты и номера", "Не создавать заявку без необходимости"], openQuestions: [] } });
	await workbench.decide({ kind: "approve-spec", reason: "Synthetic reference-agent acceptance" }, gate, { signal });
	await workbench.submit({ kind: "corpus-draft", name: "Python reference capabilities", tasks: development, coverageNotes: ["Real retrieval, account state, ticket mutations, misleading user suggestions"], revisionSummary: "Independent acceptance basket" });
	const baseline = await workbench.decide({ kind: "start-testing", repetitions: 1, reason: "Measure unchanged shipped Python reference" }, gate, { signal });
	const baselineId = baseline.result.evaluation.evaluation.evalRunId;
	const verified = loadVerifiedEvalRun(runsRoot, baselineId);
	assert.ok(verified.runs.every(run => run.execution.agent === "command-v1" && run.execution.commandProtocol?.version === 2));
	const exported = exportDataset({ runsRoot, evalRunId: baselineId, outRoot: projectDir, tasks: corpusTaskLookup({ stateRoot, projectId }), includeFailed: true });
	stage("baseline", { evalRunId: baselineId, summary: verified.record.summary, dataset: exported.path, originalPromptUnchanged: true });
	if (verified.record.summary.error > 0) throw new Error("Baseline infrastructure failures: inspect preserved runs before interpreting quality");
	createCorpus({ stateRoot, projectId, name: "Independent Python holdout", visibility: "sealed", tasks: holdout });
	const improved = await workbench.decide({ kind: "improve", selection: "best", until: 1, maxCycles: 1, repetitions: 2, candidates: 2, jobs: 2, reason: "Improve real observed gaps, select by blind validation" }, gate, { signal });
	stage("blind-search", { ...improved.result });
	assert.equal(git("rev-parse", "HEAD"), originalSha);
	assert.equal(git("status", "--porcelain"), "");
	const candidateId = improved.result.candidateId;
	if (!candidateId) {
		result.status = "no-independent-improvement";
		stage("no-winner", { reason: improved.result.stopReason });
	} else {
		const candidate = loadCandidateRecord(runsRoot, candidateId);
		const design = loadImprovementExperimentDesign(resolveCandidateArtifact(runsRoot, candidate.origin, "experimentDesign"));
		const context = authorContexts.join("\n");
		assert.ok(!design.validationTaskIds.some(id => context.includes(id)), "validation IDs leaked to author");
		assert.ok(!holdout.some(task => context.includes(task.id) || context.includes(task.input)), "sealed cases leaked to author");
		const impact = inspectCandidateImpact({ runsRoot, candidateId });
		stage("selected", { candidateId, authoringCases: design.authoringTaskIds.length, validationCases: design.validationTaskIds.length, verdict: impact.verdict });
		const verification = await workbench.decide({ kind: "verify-candidate", builderRunId: candidate.origin.builderRunId, repetitions: 2, reason: "Independent sealed acceptance; do not release automatically" }, gate, { signal });
		stage("independent-check", { result: verification.result, nextStage: verification.view.stage });
		assert.equal(git("rev-parse", "HEAD"), originalSha);
		result.status = "measured";
	}
	}
} catch (error) {
	result.status = "failed"; result.error = redactTraceText(error instanceof Error ? error.message : String(error));
	console.error(result.error); process.exitCode = 1;
} finally {
	result.finishedAt = new Date().toISOString(); result.reportedCostUsd = charged; result.unknownReservedUsd = reserved;
	save(); proxy.closeAllConnections(); await new Promise(done => proxy.close(done));
	console.log(`Evidence: ${root}`);
}
