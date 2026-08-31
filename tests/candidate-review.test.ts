import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCandidate, transitionCandidate } from "../src/domain/candidate.js";
import {
	candidateRecordPath,
	decideCandidatePromotion,
	decideCandidateRejection,
	loadCandidateRecord,
	promoteReviewedCandidate,
	reviewCandidate,
} from "../src/application/candidate-review.js";
import {
	CandidateRecordSchema,
	candidateStatus,
	gateVerdictOf,
	isPromotionGradeGateEvidence,
} from "../src/domain/candidate.js";
import { EvalRunRecordSchema, loadEvalRun, loadVerifiedEvalRun, writeEvalRun, type EvalRunRecord } from "../src/eval.js";
import { compareEvalRuns } from "../src/compare.js";
import {
	comparisonGateEvidence,
} from "../src/application/candidate-experiment.js";
import { DiagnosisRecordSchema, diagnoseEvalRun } from "../src/diagnosis.js";
import { SpecSnapshotSchema, loadApprovedSpec, saveSpecSnapshot } from "../src/spec.js";
import {
	ApprovedSpecBuilderInputSchema,
	BuilderApplyReceiptSchema,
	loadBuilderProposalRun,
	PersistedBuilderRunSchema,
} from "../src/application/builder-proposal.js";
import { CandidateProposalSchema } from "../src/builders/adapters.js";
import {
	RunRecordSchema,
	canonicalJson,
	executionFingerprint,
	modelFingerprint,
	hashValue,
	provenanceAxes,
	type ExecutionFingerprint,
	type RunRecord,
} from "../src/provenance.js";
import { readJsonArtifact, writeJsonArtifact, writeTextArtifact } from "../src/storage/artifacts.js";
import { baseFixtureFiles } from "./fixtures.js";
import {
	appendJudgeLabels,
	judgeFingerprintHashOf,
	judgeLabelLineageFor,
	type JudgeLabelRow,
} from "../src/application/judge-labels.js";
import { runImprovementLoop } from "../src/application/improvement-loop.js";
import { compileHarnessAuthoringProposal } from "../src/application/harness-authoring.js";
import { candidateProposalReview, candidateSummary, proposalReview } from "../src/workbench/resolution.js";
import { plainPaint, renderCandidate, renderConfirmation } from "../src/builder/render/index.js";
import { SEALED_VERIFICATION_REPETITIONS } from "./helpers/sealed-holdout.js";
import { improveFixture, READY_INSTRUCTION } from "./helpers/improve-fixtures.js";

const roots: string[] = [];
const baselineSha = "a".repeat(40);
const candidateSha = "b".repeat(40);
const at = "2026-08-26T10:00:00.000Z";
const piSha = "c".repeat(40);
const artifactHash = `sha256:${"d".repeat(64)}`;
const judgeSpec = `sha256:${"e".repeat(64)}`;

/** The starter manifest plus a judge that this Target refuses to trust blind. */
const calibratedManifest = `id: test-target
model:
  provider: qwen-internal
  id: qwen3.5-27b
  api: openai-completions
  baseUrl: http://127.0.0.1:9901/v1
  apiKeyEnv: TEST_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 300000
instructions:
  agentsMd: AGENTS.md
skills: [skills/check-dbo]
evalSuite:
  id: test-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
  judge:
    provider: qwen-internal
    id: qwen3.5-judge
    api: openai-completions
    baseUrl: http://127.0.0.1:9901/v1
    apiKeyEnv: TEST_JUDGE_KEY
    thinkingLevel: "off"
    timeoutMs: 300000
    requireCalibration:
      minAgreement: 0.8
      minLabels: 4
`;

function fileRef(path: string): { path: string; sha256: string } {
	return {
		path,
		sha256: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
	};
}

function textHash(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function writePair(
	runsRoot: string,
	targetId: string,
	baselineRevision: string,
	candidateRevision: string,
	baselineEvalRunId: string,
	candidateEvalRunId: string,
	dataset: string,
	execution: ExecutionFingerprint,
	design: { tasks: number; repetitions: number } = { tasks: 1, repetitions: 1 },
	/** When set, every run also carries a judge grader result with this spec. */
	judgeSpecHash?: string,
): void {
	const runtime = { piVersion: "0.84.3", piSha, ahdeVersion: "0.1.0", ahdeCodeHash: artifactHash };
	const model = {
		provider: "fixture",
		id: "fixture-model",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1/v1",
		apiKeyEnv: "FIXTURE_KEY",
		thinkingLevel: "off",
		params: {},
		spec: {},
	};
	const suiteHash = hashValue({ dataset, suite: true });
	const datasetHash = hashValue({ dataset });
	const workspaceHash = (gitSha: string): string => hashValue({ targetId, gitSha, workspace: true });
	const preparedToolHomeHash = (gitSha: string): string => hashValue({ targetId, gitSha, preparedToolHome: true });
	const provenance = provenanceAxes({
		runtime,
		model,
		// A judge-graded pair records the judge that graded it; labels certify that
		// exact instrument, so the fixture must carry one when it grades by judge.
		judge: judgeSpecHash
			? modelFingerprint({
				provider: "test",
				id: "test-judge",
				api: "openai-completions",
				baseUrl: "https://example.invalid/v1",
				apiKeyEnv: "TEST_JUDGE_KEY",
				thinkingLevel: "off",
				params: {},
				spec: {},
			})
			: null,
		execution,
		eval: { suiteHash, datasetHash },
	});
	const writeRun = (
		runId: string,
		evalRunId: string,
		label: "baseline" | "candidate",
		gitSha: string,
		taskId = `${dataset}-task`,
		repetitionIndex = 0,
	): string => {
		const record: RunRecord = {
			schemaVersion: 1,
			runId,
			taskId,
			repetitionIndex,
			label,
			status: "completed",
			error: null,
			startedAt: at,
			finishedAt: at,
			target: {
				id: targetId,
				gitSha,
				toolsetHash: `sha256:${"a".repeat(64)}`,
				workspaceHash: workspaceHash(gitSha),
				preparedToolHomeHash: preparedToolHomeHash(gitSha),
			},
			runtime,
			model,
			execution,
			eval: { suiteId: `${dataset}-suite`, suiteHash, dataset, datasetHash },
			trace: { path: "session.jsonl", sessionId: null, sha256: null },
			metrics: {
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				costUsd: 0,
				latencyMs: 0,
				toolCalls: 0,
				toolErrors: 0,
				recoveryAttempts: 0,
			},
			evalResults: {
				graders: [
					{ name: "fixture", type: "output_contains", passed: true, score: 1, reason: "pass" },
					...(judgeSpecHash
						? [{
							name: "fixture-judge",
							type: "judge",
							passed: true,
							score: 1,
							reason: "судья доволен",
							specHash: judgeSpecHash,
							checkCode: "semantic-rubric" as const,
						}]
						: []),
				],
				outcome: "pass",
			},
			parent: { evalRunId, candidateOf: label === "candidate" ? baselineRevision : null },
		};
		writeJsonArtifact(join(runsRoot, runId, "run.json"), RunRecordSchema, record);
		return hashValue(record);
	};
	const taskIds = Array.from({ length: design.tasks }, (_, index) => index === 0 ? `${dataset}-task` : `${dataset}-task-${index + 1}`);
	const writeRuns = (evalRunId: string, label: "baseline" | "candidate", gitSha: string) => {
		const artifacts: { runId: string; sha256: string }[] = [];
		for (const [taskIndex, taskId] of taskIds.entries()) {
			for (let repetition = 0; repetition < design.repetitions; repetition += 1) {
				const runId = taskIndex === 0 && repetition === 0 ? `${evalRunId}-run` : `${evalRunId}-run-${taskIndex}-${repetition}`;
				artifacts.push({ runId, sha256: writeRun(runId, evalRunId, label, gitSha, taskId, repetition) });
			}
		}
		return artifacts;
	};
	const baseArtifacts = writeRuns(baselineEvalRunId, "baseline", baselineRevision);
	const candidateArtifacts = writeRuns(candidateEvalRunId, "candidate", candidateRevision);
	const evalRecord = (
		evalRunId: string,
		label: "baseline" | "candidate",
		gitSha: string,
		artifacts: { runId: string; sha256: string }[],
		baselineId: string | null,
	): EvalRunRecord => ({
		schemaVersion: 3,
		purpose: "evidence" as const,
		evalRunId,
		target: {
			id: targetId,
			gitSha,
			toolsetHash: `sha256:${"a".repeat(64)}`,
			workspaceHash: workspaceHash(gitSha),
			preparedToolHomeHash: preparedToolHomeHash(gitSha),
		},
		label,
		baselineEvalRunId: baselineId,
		provenance,
		provenanceKey: hashValue(provenance),
		suiteId: `${dataset}-suite`,
		suiteHash,
		dataset,
		datasetHash,
		repetitions: design.repetitions,
		runIds: artifacts.map((artifact) => artifact.runId),
		runArtifacts: artifacts,
		startedAt: at,
		finishedAt: at,
		summary: { total: artifacts.length, pass: artifacts.length, fail: 0, error: 0, allPassRate: 1 },
	});
	writeEvalRun(runsRoot, evalRecord(baselineEvalRunId, "baseline", baselineRevision, baseArtifacts, null));
	writeEvalRun(runsRoot, evalRecord(candidateEvalRunId, "candidate", candidateRevision, candidateArtifacts, baselineEvalRunId));
}

function fixture(
	withHoldout: boolean,
	overrides: {
		baselineSha?: string;
		candidateSha?: string;
		targetId?: string;
		execution?: ExecutionFingerprint;
		judgeSpecHash?: string;
		developmentTasks?: number;
	} = {},
	withSource = true,
): { runsRoot: string; candidateId: string } {
	const runsRoot = mkdtempSync(join(tmpdir(), "ahde-review-"));
	const stateRoot = mkdtempSync(join(tmpdir(), "ahde-review-state-"));
	roots.push(runsRoot, stateRoot);
	const candidateId = "candidate-1";
	const fixtureBaselineSha = overrides.baselineSha ?? baselineSha;
	const fixtureCandidateSha = overrides.candidateSha ?? candidateSha;
	const targetId = overrides.targetId ?? "target";
	const execution = overrides.execution ?? executionFingerprint("isolated", {
		tools: ["read"],
		environment: ["HOME", "LANG", "PATH", "TMPDIR"],
		sandbox: "none",
		network: "deny",
		filesystem: "workspace-confined-v1",
	});
	writePair(runsRoot, targetId, fixtureBaselineSha, fixtureCandidateSha, "eval-base", "eval-candidate", "development", execution, { tasks: overrides.developmentTasks ?? 1, repetitions: 1 }, overrides.judgeSpecHash);
	if (withHoldout) {
		writePair(runsRoot, targetId, fixtureBaselineSha, fixtureCandidateSha, "holdout-base", "holdout-candidate", "sealed-holdout", execution, { tasks: 15, repetitions: 2 });
	}

	const diagnosis = diagnoseEvalRun(runsRoot, "eval-base", () => at);
	const sourceEval = loadEvalRun(runsRoot, "eval-base");
	const sourceEvalPath = join(runsRoot, "eval-base", "eval_run.json");
	const diagnosisPath = join(runsRoot, "eval-base", "diagnosis.json");
	const sourceAttestation = withSource
		? {
			evalRunId: sourceEval.evalRunId,
			diagnosisId: diagnosis.diagnosisId,
			targetId: sourceEval.target.id,
			targetGitSha: sourceEval.target.gitSha,
			evalRunSha256: fileRef(sourceEvalPath).sha256,
			diagnosisSha256: fileRef(diagnosisPath).sha256,
			dataset: sourceEval.dataset,
			datasetHash: sourceEval.datasetHash,
			suiteHash: sourceEval.suiteHash,
			developmentCorpus: null,
		}
		: null;
	const spec = saveSpecSnapshot({
		stateRoot,
		projectId: "project",
		status: "approved",
		now: () => at,
		spec: {
			schemaVersion: 1,
			title: "Promotion fixture",
			purpose: "Exercise reconstructable candidate provenance.",
			users: ["reviewer"],
			jobs: ["review exact evidence"],
			inputs: ["candidate artifacts"],
			allowedActions: ["promote exact SHA"],
			successCriteria: ["all hashes remain exact"],
			constraints: ["no unreviewed mutation"],
			openQuestions: [],
		},
	});
	const builderRunId = "builder-review-fixture";
	const builderDir = join(runsRoot, "builders", builderRunId);
	const approvedSpec = loadApprovedSpec({
		stateRoot,
		projectId: "project",
		specId: spec.id,
	});
	const failureBundle = withSource ? "fixture failure bundle" : null;
	const builderInput = `${canonicalJson(ApprovedSpecBuilderInputSchema.parse({
		schemaVersion: 1,
		approvedSpec: {
			reference: approvedSpec.reference,
			spec: approvedSpec.snapshot.spec,
		},
		evaluationEvidence: failureBundle === null
			? null
			: {
				source: { evalRunId: "eval-base", diagnosisId: diagnosis.diagnosisId },
				sourceAttestation,
				failureBundle,
			},
	}))}\n`;
	const proposal = CandidateProposalSchema.parse({
		schemaVersion: 1,
		decision: "propose",
		baseTargetSha: fixtureBaselineSha,
		summary: "Apply the reviewed harness change.",
		diagnoses: withSource
			? [{
				failureIds: ["development-task"],
				evidence: [diagnosis.diagnosisId],
				rootCause: "The baseline harness needs the reviewed change.",
			}]
			: [],
		changes: [{
			path: "AGENTS.md",
			baseSha256: artifactHash,
			unifiedDiff: [
				"diff --git a/AGENTS.md b/AGENTS.md",
				"--- a/AGENTS.md",
				"+++ b/AGENTS.md",
				"@@ -1 +1 @@",
				"-baseline harness",
				"+candidate harness",
			].join("\n"),
			rationale: "Exact reviewed scope.",
			evidenceRefs: withSource ? [diagnosis.diagnosisId] : [],
		}],
		risks: ["Fixture only."],
		validationPlan: ["Run development and sealed comparisons."],
	});
	const proposalPath = join(builderDir, "proposal.json");
	const builderInputPath = join(builderDir, "builder_input.txt");
	const eventsPath = join(builderDir, "events.jsonl");
	writeTextArtifact(builderInputPath, builderInput);
	writeJsonArtifact(proposalPath, CandidateProposalSchema, proposal);
	writeTextArtifact(eventsPath, "");
	const builderInputRef = fileRef(builderInputPath);
	const proposalRef = fileRef(proposalPath);
	const eventsRef = fileRef(eventsPath);
	const capabilities = {
		eventStream: true,
		structuredOutput: true,
		usage: false,
		cost: false,
		sessionId: false,
		cancellation: true,
		isolation: "tool-free-executor" as const,
	};
	const builderRunPath = join(builderDir, "builder_run.json");
	writeJsonArtifact(builderRunPath, PersistedBuilderRunSchema, PersistedBuilderRunSchema.parse({
		schemaVersion: 1,
		runId: builderRunId,
		request: {
			baseTargetSha: fixtureBaselineSha,
			allowedPaths: ["AGENTS.md"],
			approvedSpec: approvedSpec.reference,
			source: withSource
				? { evalRunId: "eval-base", diagnosisId: diagnosis.diagnosisId }
				: null,
			provenanceMode: "canonical",
			sourceAttestation,
			failureBundleSha256: failureBundle === null ? null : textHash(failureBundle),
			failureBundleBytes: failureBundle === null ? 0 : Buffer.byteLength(failureBundle, "utf8"),
			builderInputSha256: builderInputRef.sha256,
			builderInputBytes: Buffer.byteLength(builderInput, "utf8"),
			timeoutMs: 1_000,
		},
		probe: {
			backend: "fixture-builder",
			available: true,
			version: "fixture 1.0.0",
			capabilities,
			error: null,
		},
		result: {
			schemaVersion: 1,
			runId: builderRunId,
			backend: "fixture-builder",
			backendVersion: "fixture 1.0.0",
			capabilities,
			baseTargetSha: fixtureBaselineSha,
			startedAt: at,
			finishedAt: at,
			status: "completed",
			proposal,
			model: null,
			sessionId: null,
			usage: null,
			costUsd: null,
			traceLevel: "full",
			rawEvents: [],
			error: null,
		},
		artifacts: {
			input: {
				path: "builder_input.txt",
				sha256: builderInputRef.sha256,
				bytes: Buffer.byteLength(builderInput, "utf8"),
			},
			events: { path: "events.jsonl", sha256: eventsRef.sha256, bytes: 0 },
			proposal: { path: "proposal.json", sha256: proposalRef.sha256, bytes: readFileSync(proposalPath).length },
		},
	}));
	const receiptPath = join(builderDir, "apply_receipt.json");
	const receipt = BuilderApplyReceiptSchema.parse({
		schemaVersion: 1,
		runId: builderRunId,
		proposalSha256: proposalRef.sha256,
		baseTargetSha: fixtureBaselineSha,
		candidateSha: fixtureCandidateSha,
		branch: "candidate",
		paths: ["AGENTS.md"],
		actor: { kind: "human", id: "user" },
		appliedAt: at,
		reason: "Reviewed fixture apply.",
	});
	writeJsonArtifact(receiptPath, BuilderApplyReceiptSchema, receipt);
	const specPath = join(stateRoot, "projects", "project", "specs", `${spec.id}.json`);
	let record = createCandidate({
		candidateId,
		projectId: "project",
		targetId,
		specId: spec.id,
		proposalId: builderRunId,
		diagnosisId: withSource ? diagnosis.diagnosisId : null,
		origin: {
			kind: "applied-builder",
			builderRunId,
			builderRun: fileRef(builderRunPath),
			builderInput: builderInputRef,
			proposal: proposalRef,
			applyReceipt: fileRef(receiptPath),
			application: {
				actor: receipt.actor,
				reason: receipt.reason,
				appliedAt: receipt.appliedAt,
				baseTargetSha: receipt.baseTargetSha,
				candidateSha: receipt.candidateSha,
				proposalSha256: receipt.proposalSha256,
			},
			source: withSource
				? {
					evalRunId: "eval-base",
					evalRun: fileRef(sourceEvalPath),
					diagnosisId: diagnosis.diagnosisId,
					diagnosis: fileRef(diagnosisPath),
					dataset: sourceEval.dataset,
					datasetHash: sourceEval.datasetHash,
					suiteHash: sourceEval.suiteHash,
					developmentCorpus: null,
				}
				: null,
			approvedSpec: {
				specId: spec.id,
				projectId: spec.projectId,
				specContentHash: approvedSpec.reference.specContentHash,
				snapshotHash: approvedSpec.reference.snapshotHash,
				artifact: fileRef(specPath),
			},
		},
		mode: "candidate",
		baseline: { ref: "main", sha: fixtureBaselineSha },
		eventId: "proposed",
		at,
		actor: { kind: "human", id: "user" },
	});
	record = transitionCandidate(record, {
		type: "built",
		eventId: "built",
		at,
		actor: { kind: "human", id: "user" },
		candidate: { ref: "candidate", sha: fixtureCandidateSha },
	});
	record = transitionCandidate(record, {
		type: "validated",
		eventId: "validated",
		at,
		actor: { kind: "system", id: "experiment" },
		lineage: {
			baseline: { ref: "main", sha: fixtureBaselineSha },
			candidate: { ref: "candidate", sha: fixtureCandidateSha },
			relation: "descendant",
		},
		scope: {
			policyId: "scope-v1",
			baselineSha: fixtureBaselineSha,
			candidateSha: fixtureCandidateSha,
			passed: true,
			changedFiles: ["AGENTS.md"],
			violations: [],
		},
	});
	const pair = {
		baseline: { evalRunId: "eval-base", harness: { ref: "main", sha: fixtureBaselineSha } },
		candidate: { evalRunId: "eval-candidate", harness: { ref: "candidate", sha: fixtureCandidateSha } },
		comparison: comparisonGateEvidence(
			compareEvalRuns(runsRoot, "eval-base", "eval-candidate", { mode: "candidate" }),
		),
	};
	record = transitionCandidate(record, {
		type: "evaluated",
		eventId: "evaluated",
		at,
		actor: { kind: "system", id: "experiment" },
		evaluation: {
			experimentId: candidateId,
			designHash: `sha256:${"c".repeat(64)}`,
			mode: "candidate",
			development: pair,
			...(withHoldout
				? {
					sealedHoldout: {
						corpus: {
							id: "holdout",
							hash: loadEvalRun(runsRoot, "holdout-base").datasetHash,
						},
						baseline: { ...pair.baseline, evalRunId: "holdout-base" },
						candidate: { ...pair.candidate, evalRunId: "holdout-candidate" },
						comparison: comparisonGateEvidence(
							compareEvalRuns(runsRoot, "holdout-base", "holdout-candidate", { mode: "candidate", surface: "sealed" }),
							{
								corpusId: "holdout",
								corpusHash: loadEvalRun(runsRoot, "holdout-base").datasetHash,
							},
						),
					},
				}
				: {}),
			infrastructureErrors: 0,
		},
	});
	writeJsonArtifact(candidateRecordPath(runsRoot, candidateId), CandidateRecordSchema, CandidateRecordSchema.parse(record));
	return { runsRoot, candidateId };
}

/** Exact, source-validated calibration subjects for this Candidate's Spec. */
function calibrationRows(value: { runsRoot: string; candidateId: string }): JudgeLabelRow[] {
	const candidate = loadCandidateRecord(value.runsRoot, value.candidateId);
	if (candidate.origin.kind !== "applied-builder") throw new Error("fixture requires an applied Builder origin");
	const evalRunId = "eval-candidate";
	const verified = loadVerifiedEvalRun(value.runsRoot, evalRunId);
	const lineage = judgeLabelLineageFor({
		runsRoot: value.runsRoot,
		evalRunId,
		approvedSpec: {
			projectId: candidate.origin.approvedSpec.projectId,
			specId: candidate.origin.approvedSpec.specId,
			specContentHash: candidate.origin.approvedSpec.specContentHash,
			snapshotHash: candidate.origin.approvedSpec.snapshotHash,
		},
	});
	const judgeFingerprintHash = judgeFingerprintHashOf(value.runsRoot, evalRunId) ?? undefined;
	return verified.runs.map((run) => {
		const graderIndex = run.evalResults?.graders.findIndex((grader) => grader.checkCode === "semantic-rubric") ?? -1;
		const grader = graderIndex >= 0 ? run.evalResults?.graders[graderIndex] : undefined;
		if (!grader?.specHash) throw new Error(`run ${run.runId} has no judge grader fixture`);
		const judge = grader.passed ? "pass" as const : "fail" as const;
		return {
			lineage,
			runId: run.runId,
			taskId: run.taskId,
			graderIndex,
			graderSpecHash: grader.specHash,
			judgeFingerprintHash,
			subject: "judge-facing" as const,
			subjectHash: hashValue({ evalRunId, runId: run.runId, graderIndex, fixture: "judge-subject" }),
			human: judge,
			judge,
			at,
		};
	});
}

function legacyCalibrationRows(value: { runsRoot: string; candidateId: string }): JudgeLabelRow[] {
	return calibrationRows(value).map(({ subject: _subject, subjectHash: _subjectHash, ...row }) => row);
}

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function repository(manifest?: string): { dir: string; baselineSha: string; candidateSha: string } {
	const dir = mkdtempSync(join(tmpdir(), "ahde-promotion-repo-"));
	roots.push(dir);
	git(dir, "init", "-q");
	git(dir, "config", "user.name", "AHDE Test");
	git(dir, "config", "user.email", "test@example.invalid");
	for (const file of baseFixtureFiles(manifest ? { "manifest.yaml": manifest } : {})) {
		const path = join(dir, file.path);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, file.content);
	}
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "baseline");
	const baseline = git(dir, "rev-parse", "HEAD");
	writeFileSync(join(dir, "AGENTS.md"), "candidate harness\n");
	git(dir, "add", "AGENTS.md");
	git(dir, "commit", "-qm", "candidate");
	return { dir, baselineSha: baseline, candidateSha: git(dir, "rev-parse", "HEAD") };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("candidate human review", () => {
	it("reconstructs an exact candidate proposal and fails closed when its artifact changes", () => {
		const value = fixture(false);
		const candidate = loadCandidateRecord(value.runsRoot, value.candidateId);
		if (candidate.origin.kind !== "applied-builder") throw new Error("fixture must be Builder-authored");
		const review = candidateProposalReview(value.runsRoot, candidate);
		expect(review).toMatchObject({
			runId: candidate.origin.builderRunId,
			proposalHash: candidate.origin.proposal.sha256,
			paths: ["AGENTS.md"],
		});
		writeFileSync(candidate.origin.proposal.path, "{}\n");
		expect(() => candidateProposalReview(value.runsRoot, candidate)).toThrow(
			/Builder proposal changed after the candidate was created/,
		);
	});

	it("requires the exact displayed proposal hash before reviewing an automated apply", () => {
		const value = fixture(false);
		const candidate = loadCandidateRecord(value.runsRoot, value.candidateId);
		if (candidate.origin.kind !== "applied-builder") throw new Error("fixture must be Builder-authored");
		const automated = CandidateRecordSchema.parse({
			...candidate,
			origin: {
				...candidate.origin,
				application: { ...candidate.origin.application, via: "improvement-loop" },
			},
		});
		writeJsonArtifact(candidateRecordPath(value.runsRoot, value.candidateId), CandidateRecordSchema, automated);

		expect(() => reviewCandidate({
			...value,
			recommendation: "promote",
			reason: "looks good",
			now: () => at,
		})).toThrow(/review requires the exact proposal hash/);
		expect(() => reviewCandidate({
			...value,
			expectedProposalHash: `sha256:${"0".repeat(64)}`,
			recommendation: "promote",
			reason: "looks good",
			now: () => at,
		})).toThrow(/proposal changed after confirmation/);
		reviewCandidate({
			...value,
			expectedProposalHash: candidate.origin.proposal.sha256,
			recommendation: "promote",
			reason: "read exact diff",
			now: () => at,
		});
		expect(loadCandidateRecord(value.runsRoot, value.candidateId).events.at(-1)).toMatchObject({
			type: "reviewed",
			review: { recommendation: "promote", reason: "read exact diff" },
		});
	});

	it("keeps rejection available when an automated proposal artifact is damaged", () => {
		const value = fixture(false);
		const candidate = loadCandidateRecord(value.runsRoot, value.candidateId);
		if (candidate.origin.kind !== "applied-builder") throw new Error("fixture must be Builder-authored");
		writeJsonArtifact(candidateRecordPath(value.runsRoot, value.candidateId), CandidateRecordSchema, CandidateRecordSchema.parse({
			...candidate,
			origin: {
				...candidate.origin,
				application: { ...candidate.origin.application, via: "proposal-search" },
			},
		}));
		writeFileSync(candidate.origin.proposal.path, "damaged\n");
		expect(() => reviewCandidate({
			...value,
			recommendation: "reject",
			reason: "artifact is damaged",
			now: () => at,
		})).not.toThrow();
	});

	it("rejects stale review and rejection hashes before appending an event", () => {
		const value = fixture(false);
		const evaluated = loadCandidateRecord(value.runsRoot, value.candidateId);
		const staleHash = `sha256:${"0".repeat(64)}`;

		expect(() => reviewCandidate({
			...value,
			expectedCandidateHash: staleHash,
			recommendation: "reject",
			reason: "stale review",
			now: () => at,
		})).toThrow(/candidate changed after confirmation; review is stale/);
		expect(loadCandidateRecord(value.runsRoot, value.candidateId)).toEqual(evaluated);

		reviewCandidate({
			...value,
			expectedCandidateHash: hashValue(evaluated),
			recommendation: "reject",
			reason: "current review",
			now: () => at,
		});
		const reviewed = loadCandidateRecord(value.runsRoot, value.candidateId);
		expect(() => decideCandidateRejection({
			...value,
			expectedCandidateHash: staleHash,
			reason: "stale rejection",
			now: () => at,
		})).toThrow(/candidate changed after confirmation; rejection is stale/);
		expect(loadCandidateRecord(value.runsRoot, value.candidateId)).toEqual(reviewed);
	});

	it("persists review and rejection as separate human decisions", () => {
		const value = fixture(false);
		reviewCandidate({ ...value, recommendation: "reject", reason: "regression", now: () => at });
		decideCandidateRejection({ ...value, reason: "do not ship", now: () => at });
		expect(loadCandidateRecord(value.runsRoot, value.candidateId).events.at(-1)?.type).toBe("rejected");
	});

	it("refuses promotion without sealed holdout evidence", () => {
		const value = fixture(false);
		reviewCandidate({ ...value, recommendation: "promote", reason: "looks good", now: () => at });
		expect(() =>
			decideCandidatePromotion({ ...value, tag: "v1.0.0", reason: "ship", now: () => at }),
		).toThrow(/promotion requires sealed-holdout evidence/);
	});

	it("refuses promotion when process-capable tools ran without an enforceable sandbox", () => {
		const value = fixture(true, {
			execution: executionFingerprint("isolated", {
				tools: ["read", "bash"],
				environment: ["HOME", "LANG", "PATH", "TMPDIR"],
				sandbox: "none",
				network: "allow",
				filesystem: "isolated-copy-unconfined-v1",
			}),
		});
		reviewCandidate({ ...value, recommendation: "promote", reason: "looks good", now: () => at });
		expect(() =>
			decideCandidatePromotion({ ...value, tag: "v1.0.0", reason: "ship", now: () => at }),
		).toThrow(/non-promotable execution confinement/);
	});

	it("refuses legacy promotion evidence without an exact Target workspace hash", () => {
		const value = fixture(true, {}, false);
		const baseline = loadEvalRun(value.runsRoot, "eval-base");
		const baselineRunPath = join(value.runsRoot, "eval-base-run", "run.json");
		const baselineRun = readJsonArtifact(baselineRunPath, RunRecordSchema);
		const { workspaceHash: _legacyRunWorkspaceHash, ...legacyRunTarget } = baselineRun.target;
		const legacyRun = { ...baselineRun, target: legacyRunTarget };
		writeJsonArtifact(baselineRunPath, RunRecordSchema, legacyRun);
		const { workspaceHash: _legacyWorkspaceHash, ...legacyTarget } = baseline.target;
		writeJsonArtifact(
			join(value.runsRoot, "eval-base", "eval_run.json"),
			EvalRunRecordSchema,
			{
				...baseline,
				target: legacyTarget,
				runArtifacts: [{ runId: baselineRun.runId, sha256: hashValue(legacyRun) }],
			},
		);
		reviewCandidate({ ...value, recommendation: "promote", reason: "looks good", now: () => at });
		expect(() =>
			decideCandidatePromotion({ ...value, tag: "v1.0.0", reason: "ship", now: () => at }),
		).toThrow(/lacks a hash-anchored Target workspace/);
	});

	it("records promotion only after promote review and holdout evidence", () => {
		const value = fixture(true);
		reviewCandidate({ ...value, recommendation: "promote", reason: "verified", now: () => at });
		decideCandidatePromotion({ ...value, tag: "v1.0.0", reason: "ship", now: () => at });
		expect(loadCandidateRecord(value.runsRoot, value.candidateId).events.at(-1)?.type).toBe("promoted");
	});

	it("promotes a reconstructable Spec-only Builder candidate without inventing diagnosis provenance", () => {
		const value = fixture(true, {}, false);
		const before = loadCandidateRecord(value.runsRoot, value.candidateId);
		expect(before.diagnosisId).toBeNull();
		expect(before.origin.kind === "applied-builder" ? before.origin.source : "manual").toBeNull();
		reviewCandidate({ ...value, recommendation: "promote", reason: "verified", now: () => at });
		decideCandidatePromotion({ ...value, tag: "v1.0.0", reason: "ship", now: () => at });
		expect(loadCandidateRecord(value.runsRoot, value.candidateId).events.at(-1)?.type).toBe("promoted");
	});

	it("refuses production promotion for an explicit manual origin", () => {
		const value = fixture(true);
		const record = loadCandidateRecord(value.runsRoot, value.candidateId);
		const manualRecord = CandidateRecordSchema.parse({
			...record,
			origin: { kind: "manual", reason: "legacy imported candidate" },
		});
		writeJsonArtifact(
			candidateRecordPath(value.runsRoot, value.candidateId),
			CandidateRecordSchema,
			manualRecord,
		);
		reviewCandidate({ ...value, recommendation: "promote", reason: "verified", now: () => at });
		expect(() =>
			decideCandidatePromotion({ ...value, tag: "v1.0.0", reason: "ship", now: () => at }),
		).toThrow(/production promotion requires reconstructable applied-Builder provenance/);
	});

	it("refuses promotion on legacy v3 pass-rate gate evidence and names what is missing", () => {
		for (const surface of ["development", "sealedHoldout"] as const) {
			const value = fixture(true);
			const record = loadCandidateRecord(value.runsRoot, value.candidateId);
			const evaluated = record.events.find((event) => event.type === "evaluated");
			if (evaluated?.type !== "evaluated") throw new Error("expected an evaluated event");
			const evidence = surface === "development"
				? evaluated.evaluation.development.comparison
				: evaluated.evaluation.sealedHoldout?.comparison;
			if (!isPromotionGradeGateEvidence(evidence)) throw new Error("expected v4 gate evidence in the fixture");
			// Exactly the shape v1.8 wrote: pass rates, no scores, no resources.
			const { baselineScore: _b, candidateScore: _c, scoreDelta: _d, ...summary } = evidence.summary;
			const { resources: _r, ...rest } = evidence;
			const legacy = {
				...rest,
				schemaVersion: 3,
				algorithmId: "exact-comparison-gate-v3",
				policyId: surface === "development" ? "development-ci-v3" : "sealed-guardrail-v3",
				summary,
			};
			const downgraded = CandidateRecordSchema.parse({
				...record,
				events: record.events.map((event) =>
					event.type !== "evaluated"
						? event
						: {
							...event,
							evaluation: surface === "development"
								? { ...event.evaluation, development: { ...event.evaluation.development, comparison: legacy } }
								: {
									...event.evaluation,
									sealedHoldout: { ...event.evaluation.sealedHoldout!, comparison: legacy },
								},
						}),
			});
			// Legacy evidence still parses and still renders its verdict.
			expect(gateVerdictOf(legacy as never)).toBe(evidence.verdict);
			writeJsonArtifact(candidateRecordPath(value.runsRoot, value.candidateId), CandidateRecordSchema, downgraded);
			reviewCandidate({ ...value, recommendation: "promote", reason: "verified", now: () => at });
			expect(() => decideCandidatePromotion({ ...value, tag: "v1.0.0", reason: "ship", now: () => at }))
				.toThrow(/legacy v3 gate evidence and is not promotion-grade: re-verify the candidate to record exact-comparison-gate-v4 evidence/);
		}
	});

	it("tags only the exact reviewed candidate and preserves the user's dirty checkout", () => {
		const repo = repository();
		const value = fixture(true, { ...repo, targetId: "test-target" });
		reviewCandidate({ ...value, recommendation: "promote", reason: "verified", now: () => at });
		writeFileSync(join(repo.dir, "user-notes.txt"), "keep me\n");
		const branch = git(repo.dir, "branch", "--show-current");
		const head = git(repo.dir, "rev-parse", "HEAD");

		const result = promoteReviewedCandidate({
			repositoryDir: repo.dir,
			...value,
			version: "1.2.3",
			reason: "sealed holdout is clean",
			now: () => at,
		});

		expect(result.tag).toBe("v1.2.3");
		expect(git(repo.dir, "rev-list", "-n", "1", "v1.2.3")).toBe(repo.candidateSha);
		expect(git(repo.dir, "branch", "--show-current")).toBe(branch);
		expect(git(repo.dir, "rev-parse", "HEAD")).toBe(head);
		expect(git(repo.dir, "status", "--short")).toContain("user-notes.txt");
		expect(candidateStatus(result.record)).toBe("promoted");
	});

	it("recovers an exact promotion after a crash between tag creation and Candidate receipt publication", () => {
		const repo = repository();
		const value = fixture(true, { ...repo, targetId: "test-target" });
		reviewCandidate({ ...value, recommendation: "promote", reason: "verified", now: () => at });
		const options = {
			repositoryDir: repo.dir,
			...value,
			version: "1.2.9",
			reason: "recover exact promotion",
			now: () => at,
		};
		let captured: unknown = null;
		expect(() => promoteReviewedCandidate(options, {
			writeIntent: (path, intent) => {
				captured = intent;
				writeFileSync(path, `${JSON.stringify(intent)}\n`, { mode: 0o600 });
				throw new Error("simulated process death after promotion intent");
			},
		})).toThrow(/simulated process death/);
		const staged = captured as {
			tag: string;
			candidateSha: string;
			tagMessage: string;
		};
		git(
			repo.dir,
			"-c", "user.name=AHDE human gate",
			"-c", "user.email=ahde@local",
			"tag", "-a", staged.tag, "-m", staged.tagMessage, staged.candidateSha,
		);
		expect(candidateStatus(loadCandidateRecord(value.runsRoot, value.candidateId))).toBe("reviewed");

		const recovered = promoteReviewedCandidate({ ...options, now: () => "2099-01-01T00:00:00.000Z" });
		expect(candidateStatus(recovered.record)).toBe("promoted");
		expect(recovered.tag).toBe(staged.tag);
		expect(git(repo.dir, "rev-list", "-n", "1", staged.tag)).toBe(staged.candidateSha);
		expect(existsSync(join(value.runsRoot, "candidates", value.candidateId, "promotion_intent.json"))).toBe(false);
	});

	it("rejects a stale promotion hash before creating a tag or promotion event", () => {
		const repo = repository();
		const value = fixture(true, { ...repo, targetId: "test-target" });
		reviewCandidate({ ...value, recommendation: "promote", reason: "verified", now: () => at });
		const reviewed = loadCandidateRecord(value.runsRoot, value.candidateId);

		expect(() => promoteReviewedCandidate({
			repositoryDir: repo.dir,
			...value,
			expectedCandidateHash: `sha256:${"0".repeat(64)}`,
			version: "1.2.4",
			reason: "stale promotion",
			now: () => at,
		})).toThrow(/candidate changed after confirmation; promotion is stale/);
		expect(git(repo.dir, "tag", "--list", "v1.2.4")).toBe("");
		expect(loadCandidateRecord(value.runsRoot, value.candidateId)).toEqual(reviewed);
	});

	it("promotes judge-graded evidence with no calibration policy: the default never blocks", () => {
		const repo = repository();
		const value = fixture(true, { ...repo, targetId: "test-target", judgeSpecHash: judgeSpec });
		const stateRoot = mkdtempSync(join(tmpdir(), "ahde-promote-labels-"));
		roots.push(stateRoot);
		reviewCandidate({ ...value, recommendation: "promote", reason: "verified", now: () => at });

		const result = promoteReviewedCandidate({
			repositoryDir: repo.dir,
			...value,
			stateRoot,
			version: "3.0.0",
			reason: "judge is unchecked, and this Target has not asked to care",
			now: () => at,
		});
		expect(result.tag).toBe("v3.0.0");
	});

	it("refuses promotion on an unchecked judge when the Target requires calibration", () => {
		const repo = repository(calibratedManifest);
		const value = fixture(true, { ...repo, targetId: "test-target", judgeSpecHash: judgeSpec, developmentTasks: 4 });
		const stateRoot = mkdtempSync(join(tmpdir(), "ahde-promote-labels-"));
		roots.push(stateRoot);
		reviewCandidate({ ...value, recommendation: "promote", reason: "verified", now: () => at });

		const promote = (version: string) => promoteReviewedCandidate({
			repositoryDir: repo.dir,
			...value,
			stateRoot,
			version,
			reason: "ship it",
			now: () => at,
		});
		expect(() => promote("3.1.0")).toThrow(/promotion refused: this evidence is graded by 1 judge grader spec\(s\), but each spec requires at least 4 independent subject\(s\)/);
		expect(git(repo.dir, "tag", "--list", "v3.1.0")).toBe("");

		// Three agreeing labels are still one short of the declared minimum.
		const rows = calibrationRows(value);
		appendJudgeLabels(stateRoot, "project", "eval-candidate", rows.slice(0, 3));
		expect(() => promote("3.1.0")).toThrow(/3 subject\(s\) at 100%/);

		appendJudgeLabels(stateRoot, "project", "eval-candidate", rows.slice(3));
		expect(promote("3.1.0").tag).toBe("v3.1.0");
	});

	it("does not let repeated labels for one subject satisfy minLabels", () => {
		const repo = repository(calibratedManifest);
		const value = fixture(true, { ...repo, targetId: "test-target", judgeSpecHash: judgeSpec, developmentTasks: 4 });
		const stateRoot = mkdtempSync(join(tmpdir(), "ahde-promote-label-repeat-"));
		roots.push(stateRoot);
		reviewCandidate({ ...value, recommendation: "promote", reason: "verified", now: () => at });
		const [one] = calibrationRows(value);
		appendJudgeLabels(stateRoot, "project", "eval-candidate", [one!, one!, one!, one!]);
		expect(() => promoteReviewedCandidate({
			repositoryDir: repo.dir,
			...value,
			stateRoot,
			version: "3.1.1",
			reason: "ship it",
			now: () => at,
		})).toThrow(/1 subject\(s\) at 100%.*3 repeated label\(s\) were ignored/);
		expect(git(repo.dir, "tag", "--list", "v3.1.1")).toBe("");
	});

	/**
	 * A human shown the first user turn and the last assistant reply graded a
	 * different object from the judge, which read the rubric, the assertions and
	 * the reference answer. Those labels stay on disk and stay readable; they
	 * just do not certify this judge until the Target says so in writing.
	 */
	it("does not let labels written under the old screen satisfy requireCalibration", () => {
		const repo = repository(calibratedManifest);
		const value = fixture(true, { ...repo, targetId: "test-target", judgeSpecHash: judgeSpec, developmentTasks: 4 });
		const stateRoot = mkdtempSync(join(tmpdir(), "ahde-promote-legacy-"));
		roots.push(stateRoot);
		reviewCandidate({ ...value, recommendation: "promote", reason: "verified", now: () => at });
		appendJudgeLabels(stateRoot, "project", "eval-candidate", legacyCalibrationRows(value));
		const promote = (version: string) => promoteReviewedCandidate({
			repositoryDir: repo.dir,
			...value,
			stateRoot,
			version,
			reason: "ship it",
			now: () => at,
		});
		// Four labels on disk, none of them counted, and the refusal says why.
		expect(() => promote("3.3.0")).toThrow(/0 subject\(s\) at 0%/);
		expect(() => promote("3.3.0")).toThrow(/4 older label\(s\) were not counted/);
		expect(() => promote("3.3.0")).toThrow(/allowLegacyLabels: true/);
		expect(git(repo.dir, "tag", "--list", "v3.3.0")).toBe("");
	});

	it("counts the same old labels when the Target opts in with allowLegacyLabels", () => {
		const repo = repository(
			calibratedManifest.replace("      minLabels: 4\n", "      minLabels: 4\n      allowLegacyLabels: true\n"),
		);
		const value = fixture(true, { ...repo, targetId: "test-target", judgeSpecHash: judgeSpec, developmentTasks: 4 });
		const stateRoot = mkdtempSync(join(tmpdir(), "ahde-promote-legacy-ok-"));
		roots.push(stateRoot);
		reviewCandidate({ ...value, recommendation: "promote", reason: "verified", now: () => at });
		appendJudgeLabels(stateRoot, "project", "eval-candidate", legacyCalibrationRows(value));
		expect(promoteReviewedCandidate({
			repositoryDir: repo.dir,
			...value,
			stateRoot,
			version: "3.4.0",
			reason: "ship it",
			now: () => at,
		}).tag).toBe("v3.4.0");
	});

	it("refuses when the policy cannot be evaluated at all", () => {
		const repo = repository(calibratedManifest);
		const value = fixture(true, { ...repo, targetId: "test-target", judgeSpecHash: judgeSpec });
		reviewCandidate({ ...value, recommendation: "promote", reason: "verified", now: () => at });
		expect(() => promoteReviewedCandidate({
			repositoryDir: repo.dir,
			...value,
			version: "3.2.0",
			reason: "ship it",
			now: () => at,
		})).toThrow(/no label store to check it against/);
	});

	it("does not create a tag when the aggregate lacks sealed holdout evidence", () => {
		const repo = repository();
		const value = fixture(false, { ...repo, targetId: "test-target" });
		reviewCandidate({ ...value, recommendation: "promote", reason: "looks good", now: () => at });
		expect(() =>
			promoteReviewedCandidate({
				repositoryDir: repo.dir,
				...value,
				version: "2.0.0",
				reason: "ship",
				now: () => at,
			}),
		).toThrow(/promotion requires sealed-holdout evidence/);
		expect(git(repo.dir, "tag", "--list", "v2.0.0")).toBe("");
	});

	it("re-reads persisted evidence and refuses a tag when it no longer matches the reviewed candidate", () => {
		const repo = repository();
		const value = fixture(true, { ...repo, targetId: "test-target" });
		reviewCandidate({ ...value, recommendation: "promote", reason: "verified", now: () => at });
		const holdout = loadEvalRun(value.runsRoot, "holdout-candidate");
		writeJsonArtifact(
			join(value.runsRoot, "holdout-candidate", "eval_run.json"),
			EvalRunRecordSchema,
			{ ...holdout, target: { ...holdout.target, gitSha: "e".repeat(40) } },
		);

		expect(() =>
			promoteReviewedCandidate({
				repositoryDir: repo.dir,
				...value,
				version: "2.1.0",
				reason: "ship",
				now: () => at,
			}),
		).toThrow(/(?:eval artifacts do not match CandidateRecord harness revisions|evidence mismatch)/);
		expect(git(repo.dir, "tag", "--list", "v2.1.0")).toBe("");
	});

	it("refuses a tag after the human apply receipt is tampered", () => {
		const repo = repository();
		const value = fixture(true, { ...repo, targetId: "test-target" });
		reviewCandidate({ ...value, recommendation: "promote", reason: "verified", now: () => at });
		const record = loadCandidateRecord(value.runsRoot, value.candidateId);
		if (record.origin.kind !== "applied-builder") throw new Error("expected applied Builder origin");
		const receipt = readJsonArtifact(record.origin.applyReceipt.path, BuilderApplyReceiptSchema);
		writeJsonArtifact(record.origin.applyReceipt.path, BuilderApplyReceiptSchema, {
			...receipt,
			actor: { kind: "human", id: "different-human" },
		});

		expect(() => promoteReviewedCandidate({
			repositoryDir: repo.dir,
			...value,
			version: "2.2.0",
			reason: "ship",
			now: () => at,
		})).toThrow(/Builder apply receipt hash mismatch/);
		expect(git(repo.dir, "tag", "--list", "v2.2.0")).toBe("");
	});

	it("refuses a tag after the approved Spec snapshot is tampered", () => {
		const repo = repository();
		const value = fixture(true, { ...repo, targetId: "test-target" });
		reviewCandidate({ ...value, recommendation: "promote", reason: "verified", now: () => at });
		const record = loadCandidateRecord(value.runsRoot, value.candidateId);
		if (record.origin.kind !== "applied-builder") throw new Error("expected applied Builder origin");
		const spec = readJsonArtifact(record.origin.approvedSpec.artifact.path, SpecSnapshotSchema);
		writeJsonArtifact(record.origin.approvedSpec.artifact.path, SpecSnapshotSchema, {
			...spec,
			createdAt: "2026-08-26T10:00:01.000Z",
		});

		expect(() => promoteReviewedCandidate({
			repositoryDir: repo.dir,
			...value,
			version: "2.3.0",
			reason: "ship",
			now: () => at,
		})).toThrow(/approved Spec hash mismatch/);
		expect(git(repo.dir, "tag", "--list", "v2.3.0")).toBe("");
	});

	it("refuses a tag after the source diagnosis is tampered", () => {
		const repo = repository();
		const value = fixture(true, { ...repo, targetId: "test-target" });
		reviewCandidate({ ...value, recommendation: "promote", reason: "verified", now: () => at });
		const record = loadCandidateRecord(value.runsRoot, value.candidateId);
		if (record.origin.kind !== "applied-builder") throw new Error("expected applied Builder origin");
		if (!record.origin.source) throw new Error("expected Builder source evidence");
		const diagnosis = readJsonArtifact(record.origin.source.diagnosis.path, DiagnosisRecordSchema);
		writeJsonArtifact(record.origin.source.diagnosis.path, DiagnosisRecordSchema, {
			...diagnosis,
			createdAt: "2026-08-26T10:00:01.000Z",
		});

		expect(() => promoteReviewedCandidate({
			repositoryDir: repo.dir,
			...value,
			version: "2.4.0",
			reason: "ship",
			now: () => at,
		})).toThrow(/Builder diagnosis hash mismatch/);
		expect(git(repo.dir, "tag", "--list", "v2.4.0")).toBe("");
	});
});

describe("a candidate the improvement loop applied says so", () => {
	it("renders its origin in the review, and the ship dialog shows the diff first", async () => {
		const fixture = await improveFixture();
		try {
			const loop = await runImprovementLoop({
				repositoryDir: fixture.projectDir,
				runsRoot: fixture.runsRoot,
				stateRoot: fixture.stateRoot,
				projectId: fixture.projectId,
				approvedSpecId: fixture.approvedSpecId,
				developmentCorpus: {
					stateRoot: fixture.stateRoot,
					projectId: fixture.projectId,
					corpusId: fixture.corpusId,
				},
				until: 1,
				maxCycles: 1,
				repetitions: SEALED_VERIFICATION_REPETITIONS,
				actorId: "local:improve-human",
				author: (request) => ({
					kind: "propose",
					proposal: compileHarnessAuthoringProposal({
						repositoryDir: request.repositoryDir,
						expectedBaseTargetSha: request.baseTargetSha,
						intents: [{ type: "instructions.replace", content: `# Improve fixture\n\n${READY_INSTRUCTION}\n` }],
						summary: "Make the answer contract explicit.",
						diagnoses: request.selection.diagnoses,
						risks: ["Instruction-only behaviour change"],
						validationPlan: ["Re-run the reviewed development basket"],
					}),
				}),
			});
			const record = loadCandidateRecord(fixture.runsRoot, loop.candidateId!);
			const summary = candidateSummary(record);
			const proposal = proposalReview(loadBuilderProposalRun(fixture.runsRoot, record.proposalId));

			// The projection carries who applied it, how, and what changed.
			expect(summary.appliedBy).toMatchObject({
				actorId: "local:improve-human",
				via: "improvement-loop",
				paths: ["AGENTS.md"],
			});

			// candidate-review renders that origin instead of implying a reviewed diff.
			const review = renderCandidate({ ...summary, proposal }, plainPaint).join("\n");
			expect(review).toContain("applied by the improvement loop");
			expect(review).toContain("authorized the automated trial, not this individual diff");
			expect(review).toContain("AGENTS.md");
			expect(review).toContain("Exact proposal");
			expect(review).toContain("READY");

			// …and the ship dialog shows the diff summary BEFORE the human ships.
			const dialog = renderConfirmation({
				kind: "ship",
				title: "Ship this candidate",
				reason: "Ship it",
				policy: "consequential",
				subjectHash: `sha256:${"0".repeat(64)}`,
				question: "Ship this candidate?",
				subject: {
					operation: "ship",
					steps: ["review-candidate", "promote-candidate"],
					candidateId: summary.candidateId,
					development: "improved · +50.0pp",
					sealed: "not run",
					version: "0.2.0",
					tag: "v0.2.0",
					fastForward: "already adopted",
					diff: {
						appliedBy: "local:improve-human",
						via: "improvement-loop",
						files: 1,
						paths: ["AGENTS.md"],
						reviewed: false,
						exactDiff: proposal.exactDiff,
						proposalHash: proposal.proposalHash,
					},
					candidate: summary,
				},
			}, plainPaint).join("\n");
			expect(dialog).toContain("Diff");
			expect(dialog).toContain("AGENTS.md");
			expect(dialog).toContain("by the improvement loop");
			expect(dialog).toContain("Exact diff");
			expect(dialog).toContain("READY");
			expect(dialog.indexOf("Diff")).toBeLessThan(dialog.indexOf("This one confirmation covers"));

			// An interactively applied candidate reads the other way round.
			const application = { ...(record.origin as { application: Record<string, unknown> }).application };
			delete application.via;
			const byHand = candidateSummary({
				...record,
				origin: { ...record.origin, application },
			} as typeof record);
			expect(byHand.appliedBy?.via).toBeNull();
			expect(renderCandidate(byHand, plainPaint).join("\n")).toContain("who read this diff");
		} finally {
			await fixture.close();
		}
	}, 600_000);
});
