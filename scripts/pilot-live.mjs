#!/usr/bin/env node
import { resolveCandidateArtifact } from "../dist/application/candidate-artifacts.js";
// Live acceptance of the automatic author → blind comparison → sealed check.
// All cases are synthetic; the real provider writes every proposed change.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { createModels } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { loadDotEnv } from "../dist/env.js";
import { createAhdeWorkbench } from "../dist/workbench/index.js";
import { createPiImprovementAuthor } from "../dist/application/improvement-author.js";
import { createCorpus } from "../dist/corpus.js";
import { loadCandidateRecord } from "../dist/application/candidate-review.js";
import { inspectCandidateImpact } from "../dist/application/candidate-impact.js";
import { loadImprovementExperimentDesign } from "../dist/application/improvement-experiment-design.js";
import { readTraceArtifact, redactTraceText } from "../dist/trace.js";
import { loadEvalRun, loadRun, runSuite } from "../dist/eval.js";
import { loadTarget } from "../dist/manifest.js";
import { listBuilderCorpusDrafts, loadBuilderCorpusDraft } from "../dist/application/builder-corpus-draft.js";

if (!process.argv.includes("--live")) {
	console.error("This calls a paid provider. Run with --live to execute the synthetic pilot.");
	process.exit(2);
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv(repo);
if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not configured");
const provider = openrouterProvider();
const models = createModels();
models.setProvider(provider);
const findModel = id => {
	const model = models.getModel("openrouter", id);
	if (!model) throw new Error(`Model is absent from the installed catalog: ${id}`);
	return model;
};
const builder = findModel(process.env.AHDE_PILOT_BUILDER ?? "anthropic/claude-sonnet-4.6");
const target = findModel(process.env.AHDE_PILOT_TARGET ?? "qwen/qwen3.5-9b");
const parent = join(repo, ".ahde", "live-pilots");
mkdirSync(parent, { recursive: true, mode: 0o700 });
const resumeIndex = process.argv.indexOf("--after-release");
const resume = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : undefined;
if (resumeIndex >= 0 && !resume) throw new Error("--after-release requires a completed pilot directory");
const root = resume ? resolve(resume) : mkdtempSync(join(parent, "support-"));
if (dirname(root) !== parent) throw new Error("Pilot evidence must stay under .ahde/live-pilots");
const projectDir = join(root, "target");
const stateRoot = join(projectDir, ".ahde");
const runsRoot = join(projectDir, "runs");
const projectId = "live-support-pilot";
const signal = AbortSignal.timeout(15 * 60_000);
const results = resume ? JSON.parse(readFileSync(join(root, "results.json"), "utf8")) : { startedAt: new Date().toISOString(), builder: builder.id, target: target.id, synthetic: true, root, stages: [] };
if (results.synthetic !== true || results.root !== root) throw new Error("Not this driver's synthetic pilot");
const save = () => writeFileSync(join(root, "results.json"), JSON.stringify(results, null, 2));
const stage = (name, value) => { results.stages.push({ name, at: new Date().toISOString(), ...value }); save(); console.log(JSON.stringify({ stage: name, ...value })); };
const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
const git = (...args) => execFileSync("git", ["-C", projectDir, "-c", "user.name=AHDE live pilot", "-c", "user.email=pilot@ahde.local", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let authorCostUsd = resume ? results.authorCostUsd ?? Number.NaN : 0;
let authorRequests = resume ? results.authorRequests : 0;
const authorContexts = [];
// A conservative pre-request author ceiling. Unknown provider usage stops the
// pilot rather than silently giving it another paid call.
const authorBudgetUsd = 2;
const prepared = createPiImprovementAuthor({
	model: builder,
	async complete(context, options) {
		const upperCost = (Buffer.byteLength(JSON.stringify(context)) * Math.max(builder.cost.input, builder.cost.cacheWrite) + options.maxTokens * builder.cost.output) / 1_000_000;
		if (!Number.isFinite(authorCostUsd) || authorCostUsd + upperCost > authorBudgetUsd) throw new Error("Live pilot author budget exhausted");
		authorContexts.push(JSON.stringify(context));
		authorRequests += 1;
		const lastToolResults = context.messages.slice(-5).filter(message => message.role === "toolResult").map(message => ({ tool: message.toolName, error: message.isError ?? false, ...(message.isError ? { reason: redactTraceText(JSON.stringify(message.content)).slice(0, 1200) } : {}) }));
		const reply = await models.complete(builder, context, options);
		authorCostUsd += reply.usage?.cost?.total ?? Number.NaN;
		stage("author-request", { requests: authorRequests, costUsd: Number.isFinite(authorCostUsd) ? authorCostUsd : null, stopReason: reply.stopReason, lastToolResults, tools: reply.content.filter(item => item.type === "toolCall").map(item => ({ name: item.name, path: item.arguments.path, decision: item.arguments.decision })) });
		return reply;
	},
});
const gate = {
	async confirm(request) {
		stage("host-decision", { title: request.title });
		return { approved: true, actorId: "local:synthetic-pilot" };
	},
	async selectSealed() { return { approved: true, actorId: "local:synthetic-pilot", selectedIndex: 0 }; },
};
const policy = "Возврат покупки возможен в течение 30 дней. Доставка заказа занимает 4 дня. Гарантия действует 18 месяцев.";
const questions = [
	["Какой срок возврата покупки?", "30"],
	["Через сколько дней можно вернуть покупку?", "30"],
	["Сколько дней занимает доставка заказа?", "4"],
	["Как долго ждать доставку?", "4"],
	["На сколько месяцев даётся гарантия?", "18"],
	["Какой гарантийный срок у товара?", "18"],
	["Назови срок возврата по действующей политике.", "30"],
	["Назови срок гарантии по действующей политике.", "18"],
];
const task = (input, answer) => ({ input, graders: [
	{ type: "tool_called", tool: "kb_search" },
	{ type: "output_contains", text: answer },
	{ type: "output_contains", text: "policy.md#0" },
] });
try {
	if (!resume) {
		write(join(projectDir, ".gitignore"), ".ahde/\nruns/\nimports/\nexports/\npassport-*.md\n");
		write(join(projectDir, "AGENTS.md"), "# Поддержка магазина\n\nОтвечай кратко на русском языке. Пользуйся памятью: возврат 7 дней, доставка 2 дня, гарантия 12 месяцев. Не трать время на поиск.\n");
		write(join(projectDir, "data/kb/policy.md"), `# Действующая политика магазина\n\n${policy}\n`);
		write(join(projectDir, "evals/development.jsonl"), questions.map(([q,a], i) => JSON.stringify({ id: `seed-${i}`, ...task(q,a) })).join("\n") + "\n");
		write(join(projectDir, "evals/graders.yaml"), "defaults: []\n");
		write(join(projectDir, "manifest.yaml"), stringify({
			id: projectId,
			model: { provider: "openrouter", id: target.id, api: target.api, baseUrl: target.baseUrl, apiKeyEnv: "OPENROUTER_API_KEY", thinkingLevel: "off", timeoutMs: 60_000, params: { max_tokens: 400 }, spec: { cost: target.cost, contextWindow: target.contextWindow, maxTokens: 400 } },
			execution: { tools: ["read"], environmentAllowlist: [], network: "deny", sandbox: "best-effort" },
			instructions: { agentsMd: "AGENTS.md" }, skills: [], tools: [], data: ["data/kb"],
			evalSuite: { id: "support-pilot", dataset: "evals/development.jsonl", graders: "evals/graders.yaml" },
		}));
		git("init", "-q", "-b", "main"); git("add", "."); git("commit", "-qm", "Synthetic support pilot baseline");
		const baselineSha = git("rev-parse", "HEAD");
		const workbench = createAhdeWorkbench({ projectDir, stateRoot, runsRoot, projectId, dependencies: { prepareImprovementAuthor: async () => prepared } });
		await workbench.submit({ kind: "spec-draft", spec: { schemaVersion: 1, title: "Поддержка магазина по базе знаний", purpose: "Давать актуальные ответы по действующей политике магазина.", users: ["Покупатели"], jobs: ["Объяснять возврат", "Объяснять доставку", "Объяснять гарантию"], inputs: ["Вопрос покупателя на русском"], allowedActions: ["Искать политику через kb_search", "Отвечать со ссылкой на найденный источник"], successCriteria: ["Проверять политику поиском, а не по памяти", "Верные сроки", "Указывать идентификатор источника в ответе"], constraints: ["Не придумывать правила", "Не обещать операций над заказом"], openQuestions: [] } });
		await workbench.decide({ kind: "approve-spec", reason: "Synthetic acceptance specification" }, gate, { signal });
		const basket = await workbench.submit({ kind: "corpus-draft", name: "Synthetic support capabilities", tasks: questions.map(([q,a]) => task(q,a)), coverageNotes: ["Refund, delivery and warranty; multiple phrasings."], revisionSummary: "Initial capability basket" });
		const baseline = await workbench.decide({ kind: "start-testing", repetitions: 1, reason: "Measure the actual small Target model" }, gate, { signal });
		const baselineEvaluation = loadEvalRun(runsRoot, baseline.result.evaluation.evaluation.evalRunId);
		stage("baseline", { evalRunId: baselineEvaluation.evalRunId, draftId: basket.artifact.id, summary: baselineEvaluation.summary });
		const sealedMarker = "PRIVATE_PILOT_EXAM_";
		createCorpus({ stateRoot, projectId, name: "Independent synthetic holdout", visibility: "sealed", tasks: Array.from({length:15}, (_,i) => ({ id: `sealed-${i}`, ...task(`${sealedMarker}${i}: ${questions[i % questions.length][0]} Объясни правило покупателю.`, questions[i % questions.length][1]) })) });
		const improved = await workbench.decide({ kind: "improve", until: 1, maxCycles: 1, repetitions: 2, candidates: 2, jobs: 2, reason: "Author two real hypotheses and compare on unseen cases" }, gate, { signal });
		stage("blind-search", { stopReason: improved.result.stopReason, table: improved.result.table, search: improved.result.search });
		if (git("rev-parse", "HEAD") !== baselineSha || git("status", "--porcelain")) throw new Error("The search changed the operator checkout");
		const search = improved.result.search;
		const winner = search?.rows.filter(row => search.frontier.includes(row.ordinal)).sort((a,b) => (b.development?.scoreDelta ?? -Infinity) - (a.development?.scoreDelta ?? -Infinity))[0];
		if (!winner?.candidateId) throw new Error("No independently improved candidate; inspect the preserved author receipts and search skips");
		const candidate = loadCandidateRecord(runsRoot, winner.candidateId);
		const design = loadImprovementExperimentDesign(resolveCandidateArtifact(runsRoot, candidate.origin, "experimentDesign"));
		const serializedContexts = authorContexts.join("\n");
		if (serializedContexts.includes(sealedMarker) || design.validationTaskIds.some(id => serializedContexts.includes(id))) throw new Error("Held-out identity reached the author");
		stage("independent-winner", { candidateId: winner.candidateId, authoringCases: design.authoringTaskIds.length, validationCases: design.validationTaskIds.length, authorRequests, authorCostUsd, impact: inspectCandidateImpact({runsRoot,candidateId:winner.candidateId}).verdict });
		// This driver is the synthetic operator. Selection/release stay outside the
		// autonomous author and retain the production Workbench's ordinary gates.
		await workbench.submit({ kind: "select", entity: "candidate", id: winner.candidateId });
		const shipped = await workbench.decide({ kind: "ship", candidateId: winner.candidateId, version: "0.1.0", reason: "Synthetic live acceptance: release the independently measured winner" }, gate, { signal });
		stage("released", { tag: shipped.result.tag, steps: shipped.result.steps.map(step=>step.kind), nextStage: shipped.view.stage });
		if (shipped.view.stage !== "ready-to-evaluate") throw new Error("Release did not return to a runnable next cycle");
	} else {
		if (!results.stages.some(stage => stage.name === "released") || git("rev-parse", "HEAD") !== git("rev-parse", "v0.1.0^{commit}")) throw new Error("Follow-up requires the exact released revision");
		stage("follow-up-resumed", { previousError: results.error ?? null });
		delete results.error;
	}
	// Import an actual failed model conversation from this synthetic run. The
	// host preserves its dialogue and source revision through the next /test.
	const baselineStage = results.stages.find(stage => stage.name === "baseline");
	const baselineEvaluation = loadEvalRun(runsRoot, baselineStage.evalRunId);
	const failedRun = loadRun(runsRoot, baselineEvaluation.runIds[0]);
	const originalCase = listBuilderCorpusDrafts(stateRoot, projectId).flatMap(draft => draft.tasks).find(task => task.id === failedRun.taskId);
	if (!originalCase || failedRun.evalResults.outcome !== "fail") throw new Error("The regression source must be an observed failing case");
	write(join(projectDir, "imports/observed-failure.jsonl"), readTraceArtifact(join(runsRoot, failedRun.runId), failedRun.trace.path, failedRun.trace.sha256));
	const followup = createAhdeWorkbench({ projectDir, stateRoot, runsRoot, projectId });
	const imported = await followup.submit({ kind: "production-failure", sourcePath: "imports/observed-failure.jsonl", sourceKind: "synthetic", targetClaim: { id: projectId, gitSha: baselineEvaluation.target.gitSha }, classification: { kind: "wrong-answer", summary: "The live baseline answered from an obsolete policy without checking its source." }, case: { graders: originalCase.graders }, revisionSummary: "Keep the observed obsolete-policy answer as a regression" });
	const restarted = createAhdeWorkbench({ projectDir, stateRoot, runsRoot, projectId });
	const replay = await restarted.decide({ kind: "start-testing", repetitions: 1, reason: "Replay the imported failure after restart" }, gate, { signal });
	const regressionDraft = loadBuilderCorpusDraft(stateRoot, projectId, imported.artifact.draftId);
	const regression = regressionDraft.tasks.find(task => task.metadata?.production_failure_id === imported.artifact.failureId);
	const replayEvaluation = loadEvalRun(runsRoot, replay.result.evaluation.evaluation.evalRunId);
	const replayRun = replayEvaluation.runIds.map(id => loadRun(runsRoot, id)).find(run => run.taskId === regression.id);
	stage("regression-replayed", { failureId: imported.artifact.failureId, preservedCases: regressionDraft.tasks.length, summary: replayEvaluation.summary, regressionOutcome: replayRun?.evalResults.outcome });
	if (!replayRun) throw new Error("The imported failure disappeared from the next measurement");
	// An independent data-change probe: leave the authored instructions exactly
	// as released, change every policy number, and measure new answers.
	const probeDir = join(root, "changed-policy");
	git("worktree", "add", "--detach", probeDir, "HEAD");
	write(join(probeDir, "data/kb/policy.md"), "# Действующая политика магазина\n\nВозврат покупки возможен в течение 45 дней. Доставка заказа занимает 6 дней. Гарантия действует 24 месяца.\n");
	write(join(probeDir, "evals/development.jsonl"), [[questions[0][0], "45"], [questions[2][0], "6"], [questions[4][0], "24"]].map(([q,a], i) => JSON.stringify({ id: `changed-policy-${i}`, ...task(q,a) })).join("\n") + "\n");
	execFileSync("git", ["-C", probeDir, "add", "data/kb/policy.md", "evals/development.jsonl"], { stdio: "pipe" });
	execFileSync("git", ["-C", probeDir, "-c", "user.name=AHDE live pilot", "-c", "user.email=pilot@ahde.local", "commit", "-qm", "Independent policy change probe"], { stdio: "pipe" });
	const probe = await runSuite(loadTarget(probeDir), { runsRoot: join(root, "policy-probe-runs"), label: "solo", repetitions: 2, jobs: 2, signal });
	stage("changed-policy", { evalRunId: probe.evalRunId, summary: probe.summary, instructionUnchanged: readFileSync(join(probeDir, "AGENTS.md"), "utf8") === readFileSync(join(projectDir, "AGENTS.md"), "utf8") });
	results.status = "passed";
} catch (error) {
	results.status = "failed";
	results.error = error instanceof Error ? error.message : String(error);
	console.error(results.error);
	process.exitCode = 1;
} finally {
	results.finishedAt = new Date().toISOString();
	results.authorCostUsd = Number.isFinite(authorCostUsd) ? authorCostUsd : null;
	results.authorRequests = authorRequests;
	save();
	console.log(`Evidence: ${root}`);
}
