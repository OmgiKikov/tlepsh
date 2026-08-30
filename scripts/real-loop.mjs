#!/usr/bin/env node
// Real-model closed loop through the production application chain (no Builder
// Pi UI): approved Spec → baseline → A/A calibration → diagnosis → a Builder-
// origin proposal replaying a known harness change → apply → matched
// verification (development + sealed) → review → promote → adopt → continue.
// This is how docs/V1_8_EVIDENCE_GATE.md "Closed loop on a real Target" was run.
//
// Usage:
//   node scripts/real-loop.mjs <target-repo> <work-dir> <base-ref> <improved-ref> <holdout.jsonl> [repetitions] [jobs]
// Env: BASELINE_EVAL=<erun id> reuse a finished baseline in <work-dir>/runs;
//      SKIP_CALIBRATION=1 skip the A/A pair; RESUME_BUILDER_RUN=<id> resume at
//      verification with an already applied builder run. Reads the operator's
//      .env next to this repository for the model credential.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [ombudsmanRepo, workDir, baseRefArg, improvedRefArg, holdoutArg, repsArg, jobsArg] = process.argv.slice(2);
if (!ombudsmanRepo || !workDir || !baseRefArg || !improvedRefArg || !holdoutArg) {
	console.error("usage: node scripts/real-loop.mjs <target-repo> <work-dir> <base-ref> <improved-ref> <holdout.jsonl> [repetitions] [jobs]");
	process.exit(2);
}
const harnessRepo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repetitions = Number(repsArg ?? 3);
const jobs = Number(jobsArg ?? 4);
const dist = (p) => pathToFileURL(join(resolve(harnessRepo), "dist", p)).href;
const { loadTarget } = await import(dist("manifest.js"));
const { runSuite } = await import(dist("eval.js"));
const { diagnoseEvalRun } = await import(dist("diagnosis.js"));
const { compileImprovementBrief, deriveEvidenceLinkedProposalSelection } = await import(dist("application/improvement-brief.js"));
const { saveSpecSnapshot } = await import(dist("spec.js"));
const { createCorpus } = await import(dist("corpus.js"));
const { BuilderRunRecordSchema } = await import(dist("builders/adapters.js"));
const { applyBuilderProposal, runApprovedSpecBuilderProposal } = await import(dist("application/builder-proposal.js"));
const { runAppliedBuilderCandidate } = await import(dist("application/builder-candidate.js"));
const { runCandidateExperiment } = await import(dist("application/candidate-experiment.js"));
const { promoteReviewedCandidate, reviewCandidate } = await import(dist("application/candidate-review.js"));
const { adoptTargetCandidate, describeTargetAdoption } = await import(dist("application/target-adoption.js"));
const { describeCycleContinuation, recordCycleContinuation } = await import(dist("workbench/cycle-continuation.js"));

// Load the operator's .env without printing it.
for (const line of readFileSync(join(resolve(harnessRepo), ".env"), "utf8").split("\n")) {
	const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
	if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY missing");

const BASE_SHA = baseRefArg;
const IMPROVED_SHA = improvedRefArg;
const step = (t) => console.log(`\n\x1b[1m=== ${t} ===\x1b[0m`);
const now = () => new Date().toISOString();
const hash = (v) => `sha256:${createHash("sha256").update(v).digest("hex")}`;
const root = resolve(workDir);
mkdirSync(root, { recursive: true });
const targetDir = join(root, "target");
const runsRoot = join(root, "runs");
const stateRoot = join(root, "state");
const git = (...args) => execFileSync("git", ["-C", targetDir, ...args], { encoding: "utf8" }).trim();
const results = { startedAt: now(), repetitions, jobs };
const save = () => writeFileSync(join(root, "results.json"), JSON.stringify(results, null, 2));

step(`0. Clone the Target at ${BASE_SHA}`);
if (!existsSync(targetDir)) {
	execFileSync("git", ["clone", "-q", "--no-hardlinks", resolve(ombudsmanRepo), targetDir]);
	git("checkout", "-q", "-b", "v18-baseline", BASE_SHA);
	git("config", "user.name", "AHDE v1.8 loop");
	git("config", "user.email", "loop@ahde.local");
}
const baseSha = git("rev-parse", "HEAD");
const expectedBase = git("rev-parse", `${BASE_SHA}^{commit}`);
if (baseSha !== expectedBase) throw new Error(`expected HEAD at ${expectedBase}, got ${baseSha}`);
results.baseSha = baseSha;
const projectId = loadTarget(targetDir).manifest.id;

step("1. Approved Spec + sealed holdout (15 cases)");
const spec = saveSpecSnapshot({
	stateRoot, projectId, status: "approved",
	spec: {
		schemaVersion: 1,
		title: "Ombudsman agent",
		purpose: "Классифицировать обращения клиентов банка и отвечать по существу, проверяя ограничения ДБО по договору.",
		users: ["служба омбудсмена банка"],
		jobs: ["классифицировать обращение", "проверить ограничения ДБО по номеру договора", "дать содержательный ответ одним сообщением"],
		inputs: ["текст обращения клиента"],
		allowedActions: ["bash bin/check_dbo --client <номер договора>", "ответ текстом"],
		successCriteria: ["тип обращения назван явно", "check_dbo вызван при упоминании договора", "ответ по существу без уточняющих вопросов"],
		constraints: ["только русский язык", "однотактный диалог"],
		openQuestions: [],
	},
});
const holdoutTasks = readFileSync(resolve(holdoutArg), "utf8").trim().split("\n").map((l) => JSON.parse(l));
let sealed;
try {
	sealed = createCorpus({ stateRoot, projectId, name: `${projectId} sealed holdout`, visibility: "sealed", tasks: holdoutTasks });
} catch (error) {
	const existing = /corpus (corpus-[0-9a-f]{64}) already exists/.exec(String((error && error.message) || error));
	if (!existing) throw error;
	sealed = { id: existing[1] };
	console.log("sealed holdout already published; reusing it");
}
results.spec = spec.id; results.sealedCorpus = { id: sealed.id, tasks: holdoutTasks.length };
save();

step(`2. Baseline ${repetitions}× on 30 development cases`);
const baselineTarget = loadTarget(targetDir);
const { loadEvalRun } = await import(dist("eval.js"));
const baseline = process.env.BASELINE_EVAL
	? loadEvalRun(runsRoot, process.env.BASELINE_EVAL)
	: await runSuite(baselineTarget, { runsRoot, label: "baseline", repetitions, jobs });
if (process.env.BASELINE_EVAL) console.log(`reusing baseline ${baseline.evalRunId}`);
results.baseline = { evalRunId: baseline.evalRunId, ...baseline.summary };
console.log(`baseline ${baseline.evalRunId}: ${baseline.summary.pass}/${baseline.summary.total} (${baseline.summary.error} errors)`);
save();

step("3. A/A calibration on the same revision");
if (process.env.SKIP_CALIBRATION) {
	results.calibration = { skipped: "measured in an earlier attempt; see the log" };
	console.log("A/A calibration skipped (SKIP_CALIBRATION set)");
} else try {
	const aa = await runCandidateExperiment({
		repositoryDir: targetDir, runsRoot, baselineRef: baseSha, candidateRef: baseSha,
		mode: "aa-calibration", repetitions, jobs, projectId, specId: spec.id,
		proposalId: "aa-calibration", diagnosisId: null, actorId: "loop",
		origin: { kind: "manual", reason: "A/A calibration" },
	});
	results.calibration = { candidateId: aa.record.candidateId, baselineReused: aa.baselineReused, summary: aa.compare.summary, design: aa.compare.design, gate: aa.compare.gate ?? null };
	console.log(`A/A: ${aa.compare.gate.verdict} ${JSON.stringify(aa.compare.summary)}`);
} catch (error) {
	results.calibration = { error: String((error && error.message) || error).slice(0, 300) };
	console.log(`A/A calibration failed (continuing without it): ${results.calibration.error}`);
}
save();

const resumeBuilderRun = process.env.RESUME_BUILDER_RUN;
let builder;
if (resumeBuilderRun) {
	console.log(`resuming at verification with applied builder run ${resumeBuilderRun}`);
	builder = { record: { runId: resumeBuilderRun } };
	results.builderRun = resumeBuilderRun;
} else {
step("4. Diagnosis + improvement brief");
const diagnosis = diagnoseEvalRun(runsRoot, baseline.evalRunId);
const brief = compileImprovementBrief(runsRoot, diagnosis);
const proposalBasis = {
	algorithmId: brief.algorithmId, evalRunId: brief.evalRunId, diagnosisId: brief.diagnosisId, briefId: brief.briefId,
	failureModeIds: brief.modes.filter((m) => m.decision === "propose-harness-change").map((m) => m.failureModeId),
};
const selected = deriveEvidenceLinkedProposalSelection(brief, proposalBasis);
const evidenceRefs = [...new Set(selected.diagnoses.flatMap((d) => d.evidence))];
results.diagnosis = { id: diagnosis.diagnosisId, modes: brief.modes.map((m) => ({ id: m.failureModeId, title: m.title ?? m.summary ?? null, decision: m.decision, tasks: m.affectedTaskCount ?? null })) };
console.log(`modes: ${brief.modes.length}, proposable: ${proposalBasis.failureModeIds.length}`);
save();
if (proposalBasis.failureModeIds.length === 0) throw new Error("no proposable failure modes — baseline did not fail as expected");

step(`5. Builder proposal = the ${IMPROVED_SHA} harness change replayed as a proposal`);
// Exact bytes of the base file (the clone is checked out at BASE_SHA); git() trims output.
const contentAt = (_sha, path) => readFileSync(join(targetDir, path));
const diffFor = (path) => execFileSync("git", ["-C", targetDir, "diff", BASE_SHA, IMPROVED_SHA, "--", path], { encoding: "utf8" });
const changes = ["AGENTS.md", "skills/check-dbo/SKILL.md"].map((path) => ({
	path, baseSha256: hash(contentAt(BASE_SHA, path)), unifiedDiff: diffFor(path),
	rationale: path === "AGENTS.md"
		? "Явный порядок: классификация → bash bin/check_dbo --client <№ договора> → ответ по существу одним сообщением."
		: "Точный вызов через bash с номером договора как --client, без уточняющих вопросов.",
	evidenceRefs,
}));
const proposal = {
	schemaVersion: 1, decision: "propose", baseTargetSha: baseSha,
	summary: "Обязательная классификация, прямой вызов check_dbo по номеру договора, ответ по существу.",
	diagnoses: selected.diagnoses, changes,
	risks: ["Более длинные ответы", "Ложные вызовы check_dbo без номера договора"],
	validationPlan: ["Matched development 30×k and sealed 15×k"],
};
const capabilities = { eventStream: true, structuredOutput: true, usage: false, cost: false, sessionId: false, cancellation: true, isolation: "tool-free-executor" };
const adapter = {
	backend: "replay-builder", capabilities,
	async probe() { return { backend: "replay-builder", available: true, version: "1.0.0", capabilities, error: null }; },
	async run(request) {
		return BuilderRunRecordSchema.parse({
			schemaVersion: 1, runId: request.runId, backend: "replay-builder", backendVersion: "1.0.0", capabilities,
			baseTargetSha: request.baseTargetSha, startedAt: now(), finishedAt: now(), status: "completed",
			proposal, model: null, sessionId: null, usage: null, costUsd: null, traceLevel: "full", rawEvents: ['{"type":"final"}'], error: null,
		});
	},
};
builder = await runApprovedSpecBuilderProposal({
	adapter, approvedSpec: { stateRoot, projectId, specId: spec.id }, targetDir,
	allowedPaths: ["AGENTS.md", "skills/**", "bin/**", "tools/**"],
	sourceEvalRunId: baseline.evalRunId, proposalBasis, runsRoot, timeoutMs: 10_000, runId: `builder-v18-ombudsman-${Date.now().toString(36)}`,
});
results.builderRun = builder.record.runId;
save();

step("6. Human apply → candidate branch");
const applied = applyBuilderProposal({ repoDir: targetDir, runsRoot, runId: builder.record.runId, requestedBranch: "candidate/v18", actor: { kind: "human", id: "kikov" }, reason: "Reviewed the exact diff replayed from dd68f00." });
results.candidateSha = applied.receipt.candidateSha;
console.log(`candidate ${applied.receipt.candidateSha.slice(0, 12)} on ${applied.receipt.branch}`);
save();
}

step(`7. Verification: development 30×${repetitions} + sealed 15×${repetitions}`);
const experiment = await runAppliedBuilderCandidate({
	repositoryDir: targetDir, runsRoot, builderRunId: builder.record.runId, repetitions, jobs,
	candidateId: `candidate-v18-ombudsman-${Date.now().toString(36)}`, projectId, approvedSpec: { stateRoot, specId: spec.id },
	sealedCorpus: { stateRoot, projectId, corpusId: sealed.id },
});
results.verification = {
	candidateId: experiment.record.candidateId,
	development: { summary: experiment.compare.summary, gate: experiment.compare.gate ?? null, baselineReused: experiment.baselineReused },
	sealed: experiment.sealedHoldout ? { summary: experiment.sealedHoldout.compare.summary, gate: experiment.sealedHoldout.compare.gate ?? null } : null,
};
console.log(`development: ${JSON.stringify(experiment.compare.summary)}`);
console.log(`sealed: ${JSON.stringify(experiment.sealedHoldout?.compare.summary)}`);
save();

step("8. Review → promote v0.2.0 → adopt → next cycle");
reviewCandidate({ runsRoot, candidateId: experiment.record.candidateId, recommendation: "promote", reason: "Development improved with CI above zero; sealed guardrail passed.", actorId: "kikov" });
const promotion = promoteReviewedCandidate({ repositoryDir: targetDir, runsRoot, candidateId: experiment.record.candidateId, version: "0.2.0", reason: "First evidence-gated promotion on a real Target.", actorId: "kikov" });
const adoptionSubject = describeTargetAdoption({ repositoryDir: targetDir, runsRoot, candidateId: experiment.record.candidateId });
const adoption = adoptTargetCandidate({ repositoryDir: targetDir, runsRoot, stateRoot, candidateId: experiment.record.candidateId, expectedSubjectHash: adoptionSubject.subjectHash, actor: { kind: "human", id: "kikov" }, reason: "Make the promoted harness the active Target." });
const targetId = loadTarget(targetDir).manifest.id;
const continuationSubject = describeCycleContinuation({ repositoryDir: targetDir, runsRoot, stateRoot, projectId, targetId, candidateId: experiment.record.candidateId });
const continuation = recordCycleContinuation({ repositoryDir: targetDir, runsRoot, stateRoot, projectId, targetId, candidateId: experiment.record.candidateId, expectedSubjectHash: continuationSubject.subjectHash, actor: { kind: "human", id: "kikov" }, reason: "Close the first real loop." });
results.promotion = { tag: promotion.tag, candidateSha: promotion.candidateSha, adopted: adoption.disposition, head: git("rev-parse", "HEAD"), continuation: continuation.disposition };
results.finishedAt = now();
save();
console.log(`\n\x1b[32mtag ${promotion.tag} → ${promotion.candidateSha.slice(0, 12)} · ${adoption.disposition} · cycle ${continuation.disposition}\x1b[0m`);
console.log(`results: ${join(root, "results.json")}`);
