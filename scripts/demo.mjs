#!/usr/bin/env node
// Complete local product loop with a scripted OpenAI-compatible model.
// It spends no tokens and keeps the resulting evidence directory for inspection.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyBuilderProposal, runApprovedSpecBuilderProposal } from "../dist/application/builder-proposal.js";
import { runAppliedBuilderCandidate } from "../dist/application/builder-candidate.js";
import { promoteReviewedCandidate, reviewCandidate } from "../dist/application/candidate-review.js";
import { adoptTargetCandidate, describeTargetAdoption } from "../dist/application/target-adoption.js";
import { describeCycleContinuation, recordCycleContinuation } from "../dist/workbench/cycle-continuation.js";
import {
	compileImprovementBrief,
	deriveEvidenceLinkedProposalSelection,
} from "../dist/application/improvement-brief.js";
import { BuilderRunRecordSchema } from "../dist/builders/adapters.js";
import { createCorpus } from "../dist/corpus.js";
import { diagnoseEvalRun } from "../dist/diagnosis.js";
import { runSuite } from "../dist/eval.js";
import { loadTarget } from "../dist/manifest.js";
import { startMockModel } from "../dist/mock-model.js";
import { buildEvalReport } from "../dist/report.js";
import { saveSpecSnapshot } from "../dist/spec.js";
import { collectRunDetailPage } from "../dist/evidence/model.js";
import { renderRunDetailPage } from "../dist/evidence/pages.js";
import { setLanguage } from "../dist/i18n.js";
import { compileBuilderPassport } from "../dist/builder/passport-presentation.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const step = (title) => console.log(`\n\x1b[1m=== ${title} ===\x1b[0m`);
const now = () => new Date().toISOString();
const oldInstructions = "# Refund support agent\n\nAlways say refunds are available for 7 days.\n";
const newInstructions = "# Refund support agent\n\nSearch the refund policy with kb_search before answering. Cite the returned source id.\n";
const correctAnswer = "Возврат возможен в течение 30 дней после покупки. Источник: refunds.md#0";
const graders = [
	{ type: "output_contains", text: "30 дней" },
	{ type: "tool_called", tool: "kb_search" },
	{ type: "cites_source", chunk: "refunds.md#0" },
];
setLanguage(process.env.AHDE_LANG === "en" ? "en" : "ru");
const capabilities = {
	eventStream: true,
	structuredOutput: true,
	usage: false,
	cost: false,
	sessionId: false,
	cancellation: true,
	isolation: "tool-free-executor",
};
const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const mock = await startMockModel([
	{
		match: ({ system }) => system.includes("Search the refund policy with kb_search before answering."),
		steps: [
			{ toolCall: { name: "kb_search", arguments: { query: "возврат покупки дней", k: 3 } } },
			{ text: correctAnswer },
		],
	},
	{ match: () => true, steps: [{ text: "Возврат возможен в течение 7 дней." }] },
]);
const root = mkdtempSync(join(tmpdir(), "ahde-demo-"));
const targetDir = join(root, "target");
const runsRoot = join(root, "runs");
const stateRoot = join(root, "state");
const git = (...args) => execFileSync("git", ["-C", targetDir, ...args], { encoding: "utf8" }).trim();

try {
	cpSync(join(REPO, "templates", "basic-agent"), targetDir, { recursive: true });
	writeFileSync(join(targetDir, "AGENTS.md"), oldInstructions);
	mkdirSync(join(targetDir, "data", "kb"), { recursive: true });
	writeFileSync(join(targetDir, "data", "kb", "refunds.md"), "# Возврат покупки\n\nВозврат возможен в течение 30 дней после покупки. Сохраните чек.\n");
	writeFileSync(join(targetDir, "evals", "development.jsonl"), [
		JSON.stringify({ id: "dev-1", input: "Сколько дней у меня есть на возврат покупки?", graders }),
		JSON.stringify({ id: "dev-2", input: "Можно ли вернуть покупку через 20 дней?", graders }),
	].join("\n") + "\n");
	const manifestPath = join(targetDir, "manifest.yaml");
	writeFileSync(
		manifestPath,
		readFileSync(manifestPath, "utf8")
			.replace("baseUrl: http://127.0.0.1:1234/v1", `baseUrl: ${mock.url}`)
			.replace("apiKeyEnv: AHDE_MODEL_API_KEY", "apiKeyEnv: AHDE_DEMO_KEY")
			.replace("id: my-agent", "id: refund-support")
			.replace("tools: [read, bash]", "tools: [read]")
			.replace("tools: [tools/echo_json.tool.yaml]", "tools: []\ndata: [data/kb]"),
	);
	git("init", "-b", "main");
	git("config", "user.name", "AHDE demo");
	git("config", "user.email", "demo@ahde.local");
	git("add", ".");
	git("commit", "-m", "baseline");
	process.env.AHDE_DEMO_KEY = "fixture";
	const baseSha = git("rev-parse", "HEAD");
	const spec = saveSpecSnapshot({
		stateRoot,
		projectId: "demo",
		status: "approved",
		spec: {
			schemaVersion: 1,
			title: "Поддержка возвратов",
			purpose: "Отвечать о возврате покупки по проверенной политике.",
			users: ["demo reviewer"],
			jobs: ["Объяснить срок возврата"],
			inputs: ["text request"],
			allowedActions: ["Искать в локальной базе знаний", "Ссылаться на политику"],
			successCriteria: ["Правильный срок возврата и ссылка на источник"],
			constraints: ["no network"],
			openQuestions: [],
		},
	});

	step("1. Baseline and diagnosis");
	const baselineTarget = loadTarget(targetDir);
	const baseline = await runSuite(baselineTarget, { runsRoot, label: "baseline", repetitions: 1 });
	const diagnosis = diagnoseEvalRun(runsRoot, baseline.evalRunId);
	const brief = compileImprovementBrief(runsRoot, diagnosis);
	const proposalBasis = {
		algorithmId: brief.algorithmId,
		evalRunId: brief.evalRunId,
		diagnosisId: brief.diagnosisId,
		briefId: brief.briefId,
		failureModeIds: brief.modes
			.filter((mode) => mode.decision === "propose-harness-change")
			.map((mode) => mode.failureModeId),
	};
	const selectedEvidence = deriveEvidenceLinkedProposalSelection(brief, proposalBasis);
	const evidenceRefs = [...new Set(selectedEvidence.diagnoses.flatMap((item) => item.evidence))];
	console.log(`baseline ${baseline.evalRunId}: ${baseline.summary.pass}/${baseline.summary.total} passed`);
	console.log(`diagnosis ${diagnosis.diagnosisId}: ${brief.summary.failureModeCount} failure mode(s)`);

	step("2. Builder proposal (repository is still untouched)");
	const proposal = {
		schemaVersion: 1,
		decision: "propose",
		baseTargetSha: baseSha,
		summary: "Агент проверяет политику возврата и указывает источник вместо ответа по памяти.",
		diagnoses: selectedEvidence.diagnoses,
		changes: [{
			path: "AGENTS.md",
			baseSha256: hash(oldInstructions),
			unifiedDiff: [
				"diff --git a/AGENTS.md b/AGENTS.md",
				"--- a/AGENTS.md",
				"+++ b/AGENTS.md",
				"@@ -1,3 +1,3 @@",
				" # Refund support agent",
				" ",
				"-Always say refunds are available for 7 days.",
				"+Search the refund policy with kb_search before answering. Cite the returned source id.",
			].join("\n"),
			rationale: "Use the approved knowledge base instead of the stale seven-day policy.",
			evidenceRefs,
		}],
		risks: ["Narrow demo contract"],
		validationPlan: ["Matched development and sealed evaluations"],
	};
	const adapter = {
		backend: "demo-builder",
		capabilities,
		async probe() {
			return { backend: "demo-builder", available: true, version: "demo-builder 1.0.0", capabilities, error: null };
		},
		async run(request) {
			return BuilderRunRecordSchema.parse({
				schemaVersion: 1,
				runId: request.runId,
				backend: "demo-builder",
				backendVersion: "demo-builder 1.0.0",
				capabilities,
				baseTargetSha: request.baseTargetSha,
				startedAt: now(),
				finishedAt: now(),
				status: "completed",
				proposal,
				model: null,
				sessionId: null,
				usage: null,
				costUsd: null,
				traceLevel: "full",
				rawEvents: ['{"type":"final"}'],
				error: null,
			});
		},
	};
	const builder = await runApprovedSpecBuilderProposal({
		adapter,
		approvedSpec: { stateRoot, projectId: "demo", specId: spec.id },
		targetDir,
		allowedPaths: ["AGENTS.md", "skills/**", "bin/**", "tools/**"],
		sourceEvalRunId: baseline.evalRunId,
		proposalBasis,
		runsRoot,
		timeoutMs: 5_000,
		runId: "builder-demo",
	});
	console.log(`proposal: ${builder.proposalPath}`);

	step("3. Explicit human apply");
	const applied = applyBuilderProposal({
		repoDir: targetDir,
		runsRoot,
		runId: builder.record.runId,
		requestedBranch: "candidate/demo",
		actor: { kind: "human", id: "demo-user" },
		reason: "Reviewed the bounded diff.",
	});
	console.log(`candidate ${applied.receipt.candidateSha.slice(0, 12)} on ${applied.receipt.branch}; checkout remains on main`);

	step("4. Exact development + sealed Candidate Experiment");
	const sealed = createCorpus({
		stateRoot,
		projectId: "demo",
		name: "Sealed promotion gate",
		visibility: "sealed",
		// The sealed guardrail needs at least 15 tasks × 2 repetitions for a verdict.
		tasks: Array.from({ length: 15 }, (_, index) => ({
			id: `holdout-${index + 1}`,
			input: `PRIVATE HOLDOUT ${index + 1}: Какой срок возврата покупки?`,
			graders,
		})),
	});
	const experiment = await runAppliedBuilderCandidate({
		repositoryDir: targetDir,
		runsRoot,
		builderRunId: builder.record.runId,
		repetitions: 2,
		candidateId: "candidate-demo",
		projectId: "demo",
		approvedSpec: { stateRoot, specId: spec.id },
		sealedCorpus: { stateRoot, projectId: "demo", corpusId: sealed.id },
	});
	console.log(`development: ${experiment.compare.gate.verdict} (${experiment.compare.gate.reasons[0]})`);
	console.log(`sealed: ${experiment.sealedHoldout.compare.gate.verdict} (${experiment.sealedHoldout.compare.gate.reasons[0]})`);

	step("5. Human review, promotion, and report");
	reviewCandidate({
		runsRoot,
		candidateId: experiment.record.candidateId,
		recommendation: "promote",
		reason: "Development improved and sealed holdout did not regress.",
		actorId: "demo-user",
	});
	const promotion = promoteReviewedCandidate({
		repositoryDir: targetDir,
		runsRoot,
		candidateId: experiment.record.candidateId,
		version: "0.2.0",
		reason: "Ship the exact reviewed candidate.",
		actorId: "demo-user",
	});
	diagnoseEvalRun(runsRoot, experiment.candidate.evalRunId);
	const reportPath = buildEvalReport(runsRoot, experiment.candidate.evalRunId).path;
	const releaseArtifacts = await compileBuilderPassport({
		async view() { throw new Error("demo passes the release view explicitly"); },
		projectDir: targetDir,
		stateRoot,
		runsRoot,
		projectId: "demo",
	}, {
		save: true,
		view: {
			target: {
				id: baselineTarget.manifest.id,
				model: {
					provider: baselineTarget.manifest.model.provider,
					id: baselineTarget.manifest.model.id,
				},
			},
		},
	});
	if (releaseArtifacts.card.artifacts.dataset.status !== "known") {
		throw new Error(`release dataset is unknown: ${releaseArtifacts.card.artifacts.dataset.reason}`);
	}
	console.log(`tag ${promotion.tag} → ${promotion.candidateSha.slice(0, 12)}`);
	console.log(`report: ${reportPath}`);
	const rag = collectRunDetailPage(runsRoot, experiment.candidate.runIds[0]);
	if (rag.explanation.rag?.diagnosis !== "retrieved-and-cited") throw new Error("RAG X-ray did not verify retrieval and citation");
	const ragReportPath = join(targetDir, "exports", "rag-xray.html");
	writeFileSync(ragReportPath, renderRunDetailPage(rag));
	console.log(`RAG X-ray: ${ragReportPath} (Hit@k ${rag.explanation.rag.hitAtK}, MRR ${rag.explanation.rag.mrr})`);
	console.log(`version card: ${releaseArtifacts.card.decision.headline}`);
	if (!releaseArtifacts.reportWritten) throw new Error("shareable release report was not saved");
	console.log(`shareable report: ${releaseArtifacts.reportWritten}`);
	console.log(`passport: ${releaseArtifacts.written}`);
	console.log(`dataset: ${join(targetDir, releaseArtifacts.card.artifacts.dataset.value.path)} (${releaseArtifacts.card.artifacts.dataset.value.dialogues} dialogues)`);

	step("6. Adopt the promoted candidate and close the cycle");
	const adoptionSubject = describeTargetAdoption({ repositoryDir: targetDir, runsRoot, candidateId: experiment.record.candidateId });
	const adoption = adoptTargetCandidate({
		repositoryDir: targetDir,
		runsRoot,
		stateRoot,
		candidateId: experiment.record.candidateId,
		expectedSubjectHash: adoptionSubject.subjectHash,
		actor: { kind: "human", id: "demo-user" },
		reason: "Make the promoted harness the active Target.",
	});
	const activeSha = git("rev-parse", "HEAD");
	if (activeSha !== promotion.candidateSha) throw new Error(`adoption left HEAD at ${activeSha}, expected ${promotion.candidateSha}`);
	console.log(`branch ${adoption.subject.branch.name}: ${baseSha.slice(0, 12)} → ${activeSha.slice(0, 12)} (${adoption.disposition})`);
	const continuationSubject = describeCycleContinuation({
		repositoryDir: targetDir,
		runsRoot,
		stateRoot,
		projectId: "demo",
		targetId: loadTarget(targetDir).manifest.id,
		candidateId: experiment.record.candidateId,
	});
	const continuation = recordCycleContinuation({
		repositoryDir: targetDir,
		runsRoot,
		stateRoot,
		projectId: "demo",
		targetId: loadTarget(targetDir).manifest.id,
		candidateId: experiment.record.candidateId,
		expectedSubjectHash: continuationSubject.subjectHash,
		actor: { kind: "human", id: "demo-user" },
		reason: "Start the next improvement cycle from the adopted Target.",
	});
	console.log(`cycle closed: ${continuation.disposition} · active Target ${continuation.subject.activeTargetSha.slice(0, 12)}`);
	console.log(`\n\x1b[32mComplete: proposal → approval → evidence → sealed gate → human promotion → adoption → next cycle.\x1b[0m`);
	console.log(`Evidence kept at: ${root}`);
} finally {
	delete process.env.AHDE_DEMO_KEY;
	await mock.close();
}
