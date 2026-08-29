import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi, type Mock } from "vitest";
import { recordBuilderAuthoredProposal } from "../../src/application/builder-authoring.js";
import { loadBuilderApplyReceipt } from "../../src/application/builder-proposal.js";
import { CANDIDATE_SCOPE_POLICY } from "../../src/application/candidate-experiment.js";
import { candidateRecordPath } from "../../src/application/candidate-review.js";
import { targetWithDevelopmentCorpus } from "../../src/application/corpus-target.js";
import { compileHarnessAuthoringProposal } from "../../src/application/harness-authoring.js";
import { loadCorpus } from "../../src/corpus.js";
import {
	CandidateRecordSchema,
	createCandidate,
	transitionCandidate,
	type CandidateRecord,
} from "../../src/domain/candidate.js";
import { writeEvalRun, type EvalRunRecord } from "../../src/eval.js";
import { loadTarget } from "../../src/manifest.js";
import {
	RunRecordSchema,
	executionFingerprint,
	hashFile,
	hashValue,
	modelFingerprint,
	provenanceAxes,
	provenanceKey,
	type RunRecord,
} from "../../src/provenance.js";
import { computeTargetWorkspaceHash } from "../../src/runner.js";
import type { AgentSpec } from "../../src/spec.js";
import { writeJsonArtifact } from "../../src/storage/artifacts.js";
import {
	createAhdeWorkbench,
	type AhdeWorkbench,
	type AhdeWorkbenchDependencies,
	type WorkbenchHumanGate,
} from "../../src/workbench/index.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "../fixtures.js";

export const NOW = "2026-08-28T12:00:00.000Z";
export const PROJECT_ID = "test-target";
export const ACTOR_ID = "local:test-human";
export const CANDIDATE_ID = "candidate-cycle-1";
export const PROMOTION_TAG = "v1.0.0";
export const CANDIDATE_BRANCH = "candidate/workbench-cycle";
export const CANDIDATE_AGENTS_MD = "# Cycle fixture\n\nAnswer only from approved local evidence and say when it is missing.\n";
export const APPLY_REASON = "Apply the reviewed cycle-fixture proposal";
export const EXPERIMENT_ID = "experiment-cycle-1";
const FIXTURE_HASH = `sha256:${"f".repeat(64)}`;

export interface FixturePaths {
	projectDir: string;
	stateRoot: string;
	runsRoot: string;
}

export interface RecordingGate extends WorkbenchHumanGate {
	confirm: Mock<WorkbenchHumanGate["confirm"]>;
	selectSealed: Mock<WorkbenchHumanGate["selectSealed"]>;
}

export interface CycleFixture extends FixturePaths {
	projectId: typeof PROJECT_ID;
	workbench: AhdeWorkbench;
	/** Name of the branch checked out in the Target (whatever `git init` chose). */
	branch: string;
	baselineSha: string;
	candidateSha: string;
	candidateId: string;
	status: "promoted" | "rejected";
	tag: string;
	proposalRunId: string;
	evalRunId: string;
	approvedSpecId: string;
	corpusId: string;
}

/** Git with a fixed identity so annotated tags and commits work in a clean environment. */
export function git(repositoryDir: string, ...args: string[]): string {
	return execFileSync("git", [
		"-C", repositoryDir,
		"-c", "user.name=AHDE Test",
		"-c", "user.email=test@ahde.local",
		...args,
	], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	}).trim();
}

export function targetPaths(): FixturePaths {
	const projectDir = makeTargetFixture(baseFixtureFiles({ ".gitignore": ".ahde/\nruns/\n" }));
	return { projectDir, stateRoot: join(projectDir, ".ahde"), runsRoot: join(projectDir, "runs") };
}

export function cleanupPaths(paths: FixturePaths | undefined): void {
	if (paths) cleanup(paths.projectDir);
}

export function spec(title = "Support policy assistant"): AgentSpec {
	return {
		schemaVersion: 1,
		title,
		purpose: "Answer support policy questions from approved local evidence.",
		users: ["Support operators"],
		jobs: ["Answer one policy question"],
		inputs: ["A policy question"],
		allowedActions: ["Read approved local policy"],
		successCriteria: ["Answer contains the applicable policy"],
		constraints: ["Never invent policy"],
		openQuestions: [],
	};
}

export function task(input = "What is the refund window?", text = "30 days") {
	return { input, graders: [{ type: "output_contains" as const, text }] };
}

export function gate(approved = true): RecordingGate {
	return {
		confirm: vi.fn<WorkbenchHumanGate["confirm"]>(async () => ({
			approved,
			...(approved ? { actorId: ACTOR_ID } : {}),
		})),
		selectSealed: vi.fn<WorkbenchHumanGate["selectSealed"]>(async () => ({
			approved,
			...(approved ? { actorId: ACTOR_ID, selectedIndex: 0 } : {}),
		})),
	};
}

function artifactRef(path: string): { path: string; sha256: string } {
	return { path, sha256: hashFile(readFileSync(path, "utf8")) };
}

function comparison(surface: "development" | "sealed") {
	return {
		schemaVersion: 3 as const,
		algorithmId: "exact-comparison-gate-v3" as const,
		policyId: surface === "sealed" ? "sealed-guardrail-v3" as const : "development-ci-v3" as const,
		surface,
		comparisonHash: FIXTURE_HASH,
		evidenceHash: FIXTURE_HASH,
		gateHash: FIXTURE_HASH,
		summary: {
			taskCount: 15,
			baselinePassRate: 0,
			candidatePassRate: 1,
			delta: 1,
			confidence95: { low: 1, high: 1 },
			improved: 15,
			regressed: 0,
			unchanged: 0,
		},
		design: { tasks: 15, repetitions: 2, excludedTasks: 0 },
		verdict: surface === "sealed" ? "pass" as const : "improved" as const,
		flags: { regressedTasks: 0, improvedTasks: 15, collapsedTasks: 0 },
		reasons: ["fixture verdict"],
	};
}

/** One conclusive development EvalRun for the current Target revision (mirrors tests/workbench.test.ts). */
export function writeDevelopmentEval(paths: FixturePaths, corpusId: string, evalRunId: string): EvalRunRecord {
	const resolved = targetWithDevelopmentCorpus(
		loadTarget(paths.projectDir),
		loadCorpus({ stateRoot: paths.stateRoot, projectId: PROJECT_ID, corpusId }),
	);
	const runtime = {
		piVersion: "0.84.3",
		piSha: "b".repeat(40),
		ahdeVersion: "0.1.0",
		ahdeCodeHash: `sha256:${"c".repeat(64)}`,
	};
	const model = modelFingerprint({
		provider: "mock",
		id: "model",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1/v1",
		apiKeyEnv: "TEST_KEY",
		thinkingLevel: "off",
		params: {},
		spec: {},
	});
	const execution = executionFingerprint("isolated");
	mkdirSync(paths.runsRoot, { recursive: true });
	const workspaceHash = computeTargetWorkspaceHash(resolved, paths.runsRoot);
	const evaluation = {
		suiteId: resolved.manifest.evalSuite.id,
		suiteHash: resolved.suiteHash,
		dataset: resolved.manifest.evalSuite.dataset.replace(/\.jsonl$/, "").split("/").pop() ?? "dataset",
		datasetHash: resolved.datasetHash,
	};
	const runId = `run-${evalRunId}`;
	const firstTask = resolved.tasks[0];
	if (!firstTask) throw new Error("fixture corpus has no tasks");
	const traceContent = [
		JSON.stringify({ type: "message", message: { role: "user", content: firstTask.input, timestamp: 1 } }),
		JSON.stringify({ type: "message", message: { role: "assistant", content: "fixture failure", timestamp: 2 } }),
	].join("\n") + "\n";
	const run: RunRecord = {
		schemaVersion: 1,
		runId,
		taskId: firstTask.id,
		repetitionIndex: 0,
		label: "solo",
		status: "completed",
		error: null,
		startedAt: NOW,
		finishedAt: NOW,
		target: {
			id: resolved.manifest.id,
			gitSha: resolved.gitSha,
			toolsetHash: resolved.toolsetHash,
			workspaceHash,
		},
		runtime,
		model,
		execution,
		eval: evaluation,
		trace: { path: "session.jsonl", sessionId: null, sha256: hashFile(traceContent) },
		metrics: {
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			costUsd: 0,
			latencyMs: 0,
			toolCalls: 0,
			toolErrors: 0,
			recoveryAttempts: 0,
		},
		evalResults: {
			outcome: "fail",
			graders: [{
				name: "fixture",
				type: "output_contains",
				passed: false,
				score: 0,
				reason: "fixture failure",
				specHash: hashValue(firstTask.effectiveGraders[0]!),
				checkCode: "output-contains",
			}],
		},
		parent: { evalRunId, candidateOf: null },
	};
	mkdirSync(join(paths.runsRoot, runId), { recursive: true });
	writeFileSync(join(paths.runsRoot, runId, "session.jsonl"), traceContent, "utf8");
	writeJsonArtifact(join(paths.runsRoot, runId, "run.json"), RunRecordSchema, run);
	const evidence = { runtime, model, judge: null, execution, eval: evaluation };
	const record: EvalRunRecord = {
		schemaVersion: 1,
		evalRunId,
		target: run.target,
		label: "solo",
		baselineEvalRunId: null,
		provenance: provenanceAxes(evidence),
		provenanceKey: provenanceKey(evidence),
		suiteId: evaluation.suiteId,
		suiteHash: evaluation.suiteHash,
		dataset: evaluation.dataset,
		datasetHash: evaluation.datasetHash,
		repetitions: 1,
		runIds: [runId],
		runArtifacts: [{ runId, sha256: hashValue(run) }],
		startedAt: NOW,
		finishedAt: NOW,
		summary: { total: 1, pass: 0, fail: 1, error: 0, allPassRate: 0 },
	};
	writeEvalRun(paths.runsRoot, record);
	return record;
}

/**
 * Build the terminal CandidateRecord the Workbench would hold after
 * `promote-candidate` / `reject-candidate`, bound to the exact admitted proposal,
 * apply receipt and approved Spec so `validateProjectCandidates` admits it.
 */
function terminalCandidateRecord(input: {
	paths: FixturePaths;
	status: "promoted" | "rejected";
	candidateId: string;
	proposalRunId: string;
	approvedSpec: { projectId: string; specId: string; specContentHash: string; snapshotHash: string };
	baselineRef: string;
	developmentCorpus: { id: string; hash: string };
	tag: string;
}): CandidateRecord {
	const receipt = loadBuilderApplyReceipt(input.paths.runsRoot, input.proposalRunId);
	const runDir = join(input.paths.runsRoot, "builders", input.proposalRunId);
	const human = { kind: "human" as const, id: receipt.actor.id };
	const system = { kind: "system" as const, id: "candidate-runner" };
	const baseline = { ref: input.baselineRef, sha: receipt.baseTargetSha };
	const revision = { ref: receipt.branch, sha: receipt.candidateSha };
	let record = createCandidate({
		candidateId: input.candidateId,
		projectId: input.approvedSpec.projectId,
		targetId: loadTarget(input.paths.projectDir).manifest.id,
		specId: input.approvedSpec.specId,
		proposalId: input.proposalRunId,
		diagnosisId: null,
		origin: {
			kind: "applied-builder",
			builderRunId: input.proposalRunId,
			builderRun: artifactRef(join(runDir, "builder_run.json")),
			builderInput: artifactRef(join(runDir, "builder_input.txt")),
			proposal: artifactRef(join(runDir, "proposal.json")),
			applyReceipt: artifactRef(join(runDir, "apply_receipt.json")),
			application: {
				actor: receipt.actor,
				reason: receipt.reason,
				appliedAt: receipt.appliedAt,
				baseTargetSha: receipt.baseTargetSha,
				candidateSha: receipt.candidateSha,
				proposalSha256: receipt.proposalSha256,
			},
			source: null,
			approvedSpec: {
				...input.approvedSpec,
				artifact: artifactRef(join(
					input.paths.stateRoot,
					"projects",
					input.approvedSpec.projectId,
					"specs",
					`${input.approvedSpec.specId}.json`,
				)),
			},
		},
		mode: "candidate",
		baseline,
		eventId: `${input.candidateId}:proposed`,
		at: NOW,
		actor: { kind: "builder", id: "builder-pi" },
	});
	record = transitionCandidate(record, {
		type: "built",
		eventId: `${input.candidateId}:built`,
		at: NOW,
		actor: human,
		candidate: revision,
	});
	record = transitionCandidate(record, {
		type: "validated",
		eventId: `${input.candidateId}:validated`,
		at: NOW,
		actor: system,
		lineage: { baseline, candidate: revision, relation: "descendant" },
		scope: {
			policyId: CANDIDATE_SCOPE_POLICY.id,
			baselineSha: baseline.sha,
			candidateSha: revision.sha,
			passed: true,
			changedFiles: [...receipt.paths],
			violations: [],
		},
	});
	record = transitionCandidate(record, {
		type: "evaluated",
		eventId: `${input.candidateId}:evaluated`,
		at: NOW,
		actor: system,
		evaluation: {
			experimentId: EXPERIMENT_ID,
			designHash: FIXTURE_HASH,
			mode: "candidate",
			development: {
				baseline: { evalRunId: "erun_cycle_development_baseline", harness: baseline },
				candidate: { evalRunId: "erun_cycle_development_candidate", harness: revision },
				comparison: comparison("development"),
				corpus: input.developmentCorpus,
			},
			sealedHoldout: {
				baseline: { evalRunId: "erun_cycle_sealed_baseline", harness: baseline },
				candidate: { evalRunId: "erun_cycle_sealed_candidate", harness: revision },
				comparison: comparison("sealed"),
				corpus: { id: "sealed-cycle-holdout", hash: FIXTURE_HASH },
			},
			infrastructureErrors: 0,
		},
	});
	record = transitionCandidate(record, {
		type: "reviewed",
		eventId: `${input.candidateId}:reviewed`,
		at: NOW,
		actor: human,
		review: {
			experimentId: EXPERIMENT_ID,
			recommendation: input.status === "promoted" ? "promote" : "reject",
			reason: input.status === "promoted"
				? "No sealed regressions; the development gain is real."
				: "Sealed evidence did not justify a release.",
		},
	});
	return transitionCandidate(record, input.status === "promoted"
		? {
			type: "promoted",
			eventId: `${input.candidateId}:promoted`,
			at: NOW,
			actor: human,
			decision: {
				experimentId: EXPERIMENT_ID,
				candidate: revision,
				tag: input.tag,
				reason: "Promote the sealed-evaluated candidate.",
			},
		}
		: {
			type: "rejected",
			eventId: `${input.candidateId}:rejected`,
			at: NOW,
			actor: human,
			decision: { experimentId: EXPERIMENT_ID, reason: "Keep the active Target at its baseline." },
		});
}

/**
 * Drive a real Workbench through Spec approval, corpus publication, a baseline
 * development EvalRun, proposal recording and `apply-proposal`, then persist the
 * terminal CandidateRecord (plus the annotated promotion tag) and focus it,
 * exactly the state `promote-candidate` / `reject-candidate` leave behind.
 */
export async function terminalCandidateFixture(
	status: "promoted" | "rejected",
	dependencies: Partial<AhdeWorkbenchDependencies> = {},
): Promise<CycleFixture> {
	const paths = targetPaths();
	const branch = git(paths.projectDir, "symbolic-ref", "--short", "HEAD");
	const workbench = createAhdeWorkbench({
		...paths,
		projectId: PROJECT_ID,
		dependencies: { now: () => NOW, ...dependencies },
	});

	await workbench.submit({ kind: "spec-draft", spec: spec() });
	const approved = await workbench.decide({ kind: "approve-spec", reason: "Approve the exact cycle Spec" }, gate());
	const approvedSpecId = approved.result.approvedSpecId;
	await workbench.submit({
		kind: "corpus-draft",
		name: "Cycle development basket",
		tasks: [task()],
		coverageNotes: ["Known refund policy"],
		revisionSummary: "Initial cycle basket",
	});
	const published = await workbench.decide({ kind: "publish-corpus", reason: "Publish the exact cycle basket" }, gate());
	const corpusId = published.result.corpusId;
	const evaluation = writeDevelopmentEval(paths, corpusId, "erun_cycle_baseline");

	const proposal = compileHarnessAuthoringProposal({
		repositoryDir: paths.projectDir,
		intents: [{ type: "instructions.replace", content: CANDIDATE_AGENTS_MD }],
		summary: "Make the evidence boundary explicit",
		diagnoses: [],
		risks: ["Instruction-only behavior change"],
		validationPlan: ["Re-run the reviewed development corpus"],
	});
	const recorded = await recordBuilderAuthoredProposal({
		proposal,
		targetDir: paths.projectDir,
		allowedPaths: [...CANDIDATE_SCOPE_POLICY.allowed],
		approvedSpec: { stateRoot: paths.stateRoot, projectId: PROJECT_ID, specId: approvedSpecId },
		runsRoot: paths.runsRoot,
		timeoutMs: 30_000,
	});
	const approvedSpec = recorded.record.request.approvedSpec;
	if (!approvedSpec) throw new Error("fixture proposal is not bound to an approved Spec");
	const applied = await workbench.decide({
		kind: "apply-proposal",
		runId: recorded.record.runId,
		branch: CANDIDATE_BRANCH,
		reason: APPLY_REASON,
	}, gate());
	const baselineSha = git(paths.projectDir, "rev-parse", "HEAD");
	if (applied.result.candidateSha === baselineSha) throw new Error("fixture apply did not create a candidate revision");

	const record = terminalCandidateRecord({
		paths,
		status,
		candidateId: CANDIDATE_ID,
		proposalRunId: recorded.record.runId,
		approvedSpec,
		baselineRef: `refs/heads/${branch}`,
		developmentCorpus: { id: corpusId, hash: published.result.corpusHash },
		tag: PROMOTION_TAG,
	});
	writeJsonArtifact(
		candidateRecordPath(paths.runsRoot, CANDIDATE_ID),
		CandidateRecordSchema,
		CandidateRecordSchema.parse(record),
	);
	if (status === "promoted") {
		git(paths.projectDir, "tag", "-a", PROMOTION_TAG, "-m", `AHDE promotion ${CANDIDATE_ID}`, applied.result.candidateSha);
	}
	// promote-candidate / reject-candidate leave the terminal candidate focused.
	await workbench.submit({ kind: "select", entity: "candidate", id: CANDIDATE_ID });

	return {
		...paths,
		projectId: PROJECT_ID,
		workbench,
		branch,
		baselineSha,
		candidateSha: applied.result.candidateSha,
		candidateId: CANDIDATE_ID,
		status,
		tag: PROMOTION_TAG,
		proposalRunId: recorded.record.runId,
		evalRunId: evaluation.evalRunId,
		approvedSpecId,
		corpusId,
	};
}
