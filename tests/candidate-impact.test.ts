import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CandidateProposalSchema } from "../src/builders/adapters.js";
import {
	BuilderApplyReceiptSchema,
	ApprovedSpecBuilderInputSchema,
	PersistedBuilderRunSchema,
} from "../src/application/builder-proposal.js";
import {
	CANDIDATE_IMPACT_ALGORITHM_ID,
	inspectCandidateImpact,
} from "../src/application/candidate-impact.js";
import {
	comparisonGateEvidence,
} from "../src/application/candidate-experiment.js";
import { candidateRecordPath } from "../src/application/candidate-review.js";
import { corpusDatasetLabel } from "../src/application/corpus-target.js";
import {
	compileImprovementBrief,
	deriveEvidenceLinkedProposalSelection,
} from "../src/application/improvement-brief.js";
import { compareEvalRuns } from "../src/compare.js";
import { diagnoseEvalRun } from "../src/diagnosis.js";
import {
	CandidateRecordSchema,
	createCandidate,
	transitionCandidate,
} from "../src/domain/candidate.js";
import { writeEvalRun, type EvalRunRecord } from "../src/eval.js";
import {
	RunRecordSchema,
	canonicalJson,
	executionFingerprint,
	hashValue,
	provenanceAxes,
	type GraderCheckCode,
	type RunRecord,
} from "../src/provenance.js";
import { loadApprovedSpec, saveSpecSnapshot } from "../src/spec.js";
import { readJsonArtifact, writeJsonArtifact, writeTextArtifact } from "../src/storage/artifacts.js";

const roots: string[] = [];
const baselineSha = "a".repeat(40);
const candidateSha = "b".repeat(40);
const piSha = "c".repeat(40);
const at = "2026-08-28T12:00:00.000Z";
const targetId = "impact-target";
const artifactHash = `sha256:${"d".repeat(64)}`;
const primarySpecHash = hashValue({ type: "output_contains", text: "primary" });
const secondarySpecHash = hashValue({ type: "output_contains", text: "secondary" });

interface GraderState {
	primary: boolean;
	secondary: boolean;
	legacy?: boolean;
}

interface FixtureOptions {
	source?: GraderState[];
	baseline?: GraderState[];
	candidate?: GraderState[];
	withHoldout?: boolean;
}

function fileRef(path: string): { path: string; sha256: string } {
	return {
		path,
		sha256: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
	};
}

function textHash(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function grader(
	name: string,
	passed: boolean,
	checkCode: GraderCheckCode,
	specHash: string,
	legacy: boolean,
) {
	return {
		name,
		type: checkCode === "required-tool" ? "tool_called" : "output_contains",
		passed,
		score: passed ? 1 : 0,
		reason: passed ? `${name} passed` : `${name} failed`,
		...(legacy ? {} : { checkCode, specHash }),
	};
}

function writeEvaluation(options: {
	runsRoot: string;
	evalRunId: string;
	label: "baseline" | "candidate";
	gitSha: string;
	baselineEvalRunId: string | null;
	states: GraderState[];
	dataset?: string;
	datasetHash?: string;
	suiteHash?: string;
	visibility?: "development" | "sealed";
	/** Task ids to materialize; every task repeats the same grader states. */
	taskIds?: string[];
}): EvalRunRecord {
	const dataset = options.dataset ?? "development";
	const datasetHash = options.datasetHash ?? hashValue({ dataset: "development" });
	const suiteHash = options.suiteHash ?? hashValue({ suite: "development" });
	const runtime = {
		piVersion: "0.84.3",
		piSha,
		ahdeVersion: "0.1.0",
		ahdeCodeHash: artifactHash,
	};
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
	const execution = executionFingerprint("isolated", {
		tools: ["read"],
		environment: ["HOME", "LANG", "PATH", "TMPDIR"],
		sandbox: "none",
		network: "deny",
		filesystem: "workspace-confined-v1",
	});
	const provenance = provenanceAxes({
		runtime,
		model,
		judge: null,
		execution,
		eval: { suiteHash, datasetHash },
	});
	const workspaceHash = hashValue({ targetId, gitSha: options.gitSha, workspace: true });
	const runIds: string[] = [];
	const runArtifacts: { runId: string; sha256: string }[] = [];
	let pass = 0;
	const taskIds = options.taskIds ?? ["task-1"];
	for (const [taskIndex, taskId] of taskIds.entries()) for (const [repetitionIndex, state] of options.states.entries()) {
		const runId = taskIndex === 0
			? `${options.evalRunId}-run-${repetitionIndex}`
			: `${options.evalRunId}-${taskId}-run-${repetitionIndex}`;
		const graders = [
			grader("primary", state.primary, "output-contains", primarySpecHash, state.legacy ?? false),
			grader("secondary", state.secondary, "output-contains", secondarySpecHash, state.legacy ?? false),
		];
		const outcome = graders.every((item) => item.passed) ? "pass" as const : "fail" as const;
		if (outcome === "pass") pass += 1;
		const record: RunRecord = {
			schemaVersion: 1,
			runId,
			taskId,
			repetitionIndex,
			label: options.label,
			status: "completed",
			error: null,
			startedAt: at,
			finishedAt: at,
			target: {
				id: targetId,
				gitSha: options.gitSha,
				toolsetHash: hashValue({ tools: true }),
				workspaceHash,
			},
			runtime,
			model,
			execution,
			eval: { suiteId: "suite", suiteHash, dataset, datasetHash },
			trace: { path: "session.jsonl", sessionId: null, sha256: null },
			metrics: {
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				costUsd: 0,
				latencyMs: 0,
				toolCalls: 0,
				toolErrors: 0,
				recoveryAttempts: 0,
			},
			evalResults: { graders, outcome },
			parent: {
				evalRunId: options.evalRunId,
				candidateOf: options.label === "candidate" ? baselineSha : null,
			},
		};
		writeJsonArtifact(join(options.runsRoot, runId, "run.json"), RunRecordSchema, record);
		runIds.push(runId);
		runArtifacts.push({ runId, sha256: hashValue(record) });
	}
	const record: EvalRunRecord = {
		schemaVersion: 1,
		evalRunId: options.evalRunId,
		target: {
			id: targetId,
			gitSha: options.gitSha,
			toolsetHash: hashValue({ tools: true }),
			workspaceHash,
		},
		label: options.label,
		baselineEvalRunId: options.baselineEvalRunId,
		provenance,
		provenanceKey: hashValue(provenance),
		suiteId: "suite",
		suiteHash,
		dataset,
		datasetHash,
		evidenceVisibility: options.visibility ?? "development",
		taskIds,
		repetitions: options.states.length,
		runIds,
		runArtifacts,
		startedAt: at,
		finishedAt: at,
		summary: {
			total: runIds.length,
			pass,
			fail: runIds.length - pass,
			error: 0,
			allPassRate: pass / runIds.length,
		},
	};
	writeEvalRun(options.runsRoot, record);
	return record;
}

function fixture(options: FixtureOptions = {}) {
	const runsRoot = mkdtempSync(join(tmpdir(), "ahde-impact-runs-"));
	const stateRoot = mkdtempSync(join(tmpdir(), "ahde-impact-state-"));
	roots.push(runsRoot, stateRoot);
	const sourceStates = options.source ?? [
		{ primary: false, secondary: true },
		{ primary: false, secondary: true },
	];
	const baselineStates = options.baseline ?? sourceStates;
	const candidateStates = options.candidate ?? [
		{ primary: true, secondary: true },
		{ primary: true, secondary: true },
	];
	const source = writeEvaluation({
		runsRoot,
		evalRunId: "eval-source",
		label: "baseline",
		gitSha: baselineSha,
		baselineEvalRunId: null,
		states: sourceStates,
	});
	const baseline = writeEvaluation({
		runsRoot,
		evalRunId: "eval-base",
		label: "baseline",
		gitSha: baselineSha,
		baselineEvalRunId: null,
		states: baselineStates,
	});
	const candidate = writeEvaluation({
		runsRoot,
		evalRunId: "eval-candidate",
		label: "candidate",
		gitSha: candidateSha,
		baselineEvalRunId: baseline.evalRunId,
		states: candidateStates,
	});
	const diagnosis = diagnoseEvalRun(runsRoot, source.evalRunId, () => at);
	const brief = compileImprovementBrief(runsRoot, diagnosis);
	const primaryMode = brief.modes.find((mode) =>
		mode.signature.checkCode === "output-contains" &&
		mode.signature.discriminatorHash === hashValue({
			checkCode: "output-contains",
			specHash: primarySpecHash,
		}));
	if (!primaryMode) throw new Error("fixture primary failure mode missing");
	const selection = deriveEvidenceLinkedProposalSelection(brief, {
		algorithmId: brief.algorithmId,
		evalRunId: brief.evalRunId,
		diagnosisId: brief.diagnosisId,
		briefId: brief.briefId,
		failureModeIds: [primaryMode.failureModeId],
	});

	const spec = saveSpecSnapshot({
		stateRoot,
		projectId: "project",
		status: "approved",
		now: () => at,
		spec: {
			schemaVersion: 1,
			title: "Candidate impact fixture",
			purpose: "Verify exact Candidate impact evidence.",
			users: ["reviewer"],
			jobs: ["inspect Candidate impact"],
			inputs: ["immutable evidence"],
			allowedActions: ["read evidence"],
			successCriteria: ["exact signatures are compared"],
			constraints: ["sealed content is not disclosed"],
			openQuestions: [],
		},
	});
	const approvedSpec = loadApprovedSpec({ stateRoot, projectId: "project", specId: spec.id });
	const sourceEvalPath = join(runsRoot, source.evalRunId, "eval_run.json");
	const diagnosisPath = join(runsRoot, source.evalRunId, "diagnosis.json");
	const sourceAttestation = {
		evalRunId: source.evalRunId,
		diagnosisId: diagnosis.diagnosisId,
		targetId,
		targetGitSha: baselineSha,
		evalRunSha256: fileRef(sourceEvalPath).sha256,
		diagnosisSha256: fileRef(diagnosisPath).sha256,
		dataset: source.dataset,
		datasetHash: source.datasetHash,
		suiteHash: source.suiteHash,
		developmentCorpus: null,
	};
	const failureBundle = "exact fixture failure bundle";
	const builderInput = `${canonicalJson(ApprovedSpecBuilderInputSchema.parse({
		schemaVersion: 1,
		approvedSpec: { reference: approvedSpec.reference, spec: approvedSpec.snapshot.spec },
		operatorGuidance: null,
		evaluationEvidence: {
			source: { evalRunId: source.evalRunId, diagnosisId: diagnosis.diagnosisId },
			sourceAttestation,
			proposalBasis: selection.basis,
			proposalDiagnoses: selection.diagnoses,
			failureBundle,
		},
	}))}\n`;
	const evidenceRefs = [...new Set(selection.diagnoses.flatMap((item) => item.evidence))];
	const proposal = CandidateProposalSchema.parse({
		schemaVersion: 1,
		decision: "propose",
		baseTargetSha: baselineSha,
		summary: "Fix the exact primary failure mode.",
		diagnoses: selection.diagnoses,
		changes: [{
			path: "AGENTS.md",
			baseSha256: artifactHash,
			unifiedDiff: [
				"diff --git a/AGENTS.md b/AGENTS.md",
				"--- a/AGENTS.md",
				"+++ b/AGENTS.md",
				"@@ -1 +1 @@",
				"-baseline",
				"+candidate",
			].join("\n"),
			rationale: "Exact targeted change.",
			evidenceRefs,
		}],
		risks: ["Fixture only."],
		validationPlan: ["Run the matched Candidate experiment."],
	});
	const builderRunId = "builder-impact";
	const builderDir = join(runsRoot, "builders", builderRunId);
	const builderInputPath = join(builderDir, "builder_input.txt");
	const proposalPath = join(builderDir, "proposal.json");
	const eventsPath = join(builderDir, "events.jsonl");
	writeTextArtifact(builderInputPath, builderInput);
	writeJsonArtifact(proposalPath, CandidateProposalSchema, proposal);
	writeTextArtifact(eventsPath, "");
	const inputRef = fileRef(builderInputPath);
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
			baseTargetSha: baselineSha,
			allowedPaths: ["AGENTS.md"],
			approvedSpec: approvedSpec.reference,
			source: { evalRunId: source.evalRunId, diagnosisId: diagnosis.diagnosisId },
			provenanceMode: "canonical",
			sourceAttestation,
			proposalBasis: selection.basis,
			proposalDiagnoses: selection.diagnoses,
			authoringContext: null,
			failureBundleSha256: textHash(failureBundle),
			failureBundleBytes: Buffer.byteLength(failureBundle, "utf8"),
			builderInputSha256: inputRef.sha256,
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
			baseTargetSha: baselineSha,
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
			input: { path: "builder_input.txt", sha256: inputRef.sha256, bytes: Buffer.byteLength(builderInput, "utf8") },
			events: { path: "events.jsonl", sha256: eventsRef.sha256, bytes: 0 },
			proposal: { path: "proposal.json", sha256: proposalRef.sha256, bytes: readFileSync(proposalPath).length },
		},
	}));
	const receiptPath = join(builderDir, "apply_receipt.json");
	const receipt = BuilderApplyReceiptSchema.parse({
		schemaVersion: 1,
		runId: builderRunId,
		proposalSha256: proposalRef.sha256,
		baseTargetSha: baselineSha,
		candidateSha,
		branch: "candidate",
		paths: ["AGENTS.md"],
		actor: { kind: "human", id: "user" },
		appliedAt: at,
		reason: "Apply exact proposal.",
	});
	writeJsonArtifact(receiptPath, BuilderApplyReceiptSchema, receipt);
	const specPath = join(stateRoot, "projects", "project", "specs", `${spec.id}.json`);
	const candidateId = "candidate-impact";
	let record = createCandidate({
		candidateId,
		projectId: "project",
		targetId,
		specId: spec.id,
		proposalId: builderRunId,
		diagnosisId: diagnosis.diagnosisId,
		origin: {
			kind: "applied-builder",
			builderRunId,
			builderRun: fileRef(builderRunPath),
			builderInput: inputRef,
			proposal: proposalRef,
			applyReceipt: fileRef(receiptPath),
			application: {
				actor: receipt.actor,
				reason: receipt.reason,
				appliedAt: receipt.appliedAt,
				baseTargetSha: baselineSha,
				candidateSha,
				proposalSha256: proposalRef.sha256,
			},
			source: {
				evalRunId: source.evalRunId,
				evalRun: fileRef(sourceEvalPath),
				diagnosisId: diagnosis.diagnosisId,
				diagnosis: fileRef(diagnosisPath),
				dataset: source.dataset,
				datasetHash: source.datasetHash,
				suiteHash: source.suiteHash,
				developmentCorpus: null,
			},
			approvedSpec: {
				specId: spec.id,
				projectId: spec.projectId,
				specContentHash: approvedSpec.reference.specContentHash,
				snapshotHash: approvedSpec.reference.snapshotHash,
				artifact: fileRef(specPath),
			},
		},
		mode: "candidate",
		baseline: { ref: "main", sha: baselineSha },
		eventId: "proposed",
		at,
		actor: { kind: "human", id: "user" },
	});
	record = transitionCandidate(record, {
		type: "built",
		eventId: "built",
		at,
		actor: { kind: "human", id: "user" },
		candidate: { ref: "candidate", sha: candidateSha },
	});
	record = transitionCandidate(record, {
		type: "validated",
		eventId: "validated",
		at,
		actor: { kind: "system", id: "experiment" },
		lineage: {
			baseline: { ref: "main", sha: baselineSha },
			candidate: { ref: "candidate", sha: candidateSha },
			relation: "descendant",
		},
		scope: {
			policyId: "candidate-harness-resources-v2",
			baselineSha,
			candidateSha,
			passed: true,
			changedFiles: ["AGENTS.md"],
			violations: [],
		},
	});
	const developmentCompare = compareEvalRuns(runsRoot, baseline.evalRunId, candidate.evalRunId, { mode: "candidate" });
	const development = {
		baseline: { evalRunId: baseline.evalRunId, harness: { ref: "main", sha: baselineSha } },
		candidate: { evalRunId: candidate.evalRunId, harness: { ref: "candidate", sha: candidateSha } },
		comparison: comparisonGateEvidence(developmentCompare),
	};
	let sealedHoldout;
	if (options.withHoldout) {
		const corpusId = "holdout";
		const corpusHash = hashValue({ corpus: corpusId });
		const sealedTaskIds = Array.from({ length: 15 }, (_, index) => `sealed-${index + 1}`);
		const suiteHash = hashValue({ sealed: corpusId });
		const dataset = corpusDatasetLabel("sealed", corpusId);
		const holdoutBaseline = writeEvaluation({
			runsRoot,
			evalRunId: "holdout-base",
			label: "baseline",
			gitSha: baselineSha,
			baselineEvalRunId: null,
			states: [{ primary: true, secondary: true }, { primary: true, secondary: true }],
			dataset,
			datasetHash: corpusHash,
			suiteHash,
			visibility: "sealed",
			taskIds: sealedTaskIds,
		});
		const holdoutCandidate = writeEvaluation({
			runsRoot,
			evalRunId: "holdout-candidate",
			label: "candidate",
			gitSha: candidateSha,
			baselineEvalRunId: holdoutBaseline.evalRunId,
			states: [{ primary: true, secondary: true }, { primary: true, secondary: true }],
			dataset,
			datasetHash: corpusHash,
			suiteHash,
			visibility: "sealed",
			taskIds: sealedTaskIds,
		});
		const holdoutCompare = compareEvalRuns(runsRoot, holdoutBaseline.evalRunId, holdoutCandidate.evalRunId, { mode: "candidate", surface: "sealed" });
		sealedHoldout = {
			corpus: { id: corpusId, hash: corpusHash },
			baseline: { evalRunId: holdoutBaseline.evalRunId, harness: { ref: "main", sha: baselineSha } },
			candidate: { evalRunId: holdoutCandidate.evalRunId, harness: { ref: "candidate", sha: candidateSha } },
			comparison: comparisonGateEvidence(holdoutCompare, { corpusId, corpusHash }),
		};
	}
	record = transitionCandidate(record, {
		type: "evaluated",
		eventId: "evaluated",
		at,
		actor: { kind: "system", id: "experiment" },
		evaluation: {
			experimentId: candidateId,
			designHash: hashValue({ design: true }),
			mode: "candidate",
			development,
			...(sealedHoldout ? { sealedHoldout } : {}),
			infrastructureErrors: 0,
		},
	});
	writeJsonArtifact(
		candidateRecordPath(runsRoot, candidateId),
		CandidateRecordSchema,
		CandidateRecordSchema.parse(record),
	);
	return {
		runsRoot,
		candidateId,
		primaryModeId: primaryMode.failureModeId,
		candidateRunId: candidate.runIds[0]!,
		sealedRunId: sealedHoldout?.candidate.evalRunId === "holdout-candidate" ? "holdout-candidate-run-0" : null,
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CandidateImpact", () => {
	it("returns a deterministic bounded resolved impact and only opaque sealed gate state", () => {
		const value = fixture({ withHoldout: true });
		const first = inspectCandidateImpact(value);
		const second = inspectCandidateImpact({
			...value,
			expectedCandidateHash: first.candidateHash,
		});

		expect(second).toEqual(first);
		expect(first.algorithmId).toBe(CANDIDATE_IMPACT_ALGORITHM_ID);
		expect(first.verdict).toBe("improved");
		expect(first.proposalBasis?.targetedFailureModes).toMatchObject([{
			failureModeId: value.primaryModeId,
			outcome: "resolved",
			baseline: { failedOccurrences: 2, totalOccurrences: 2, failureRateBps: 10_000 },
			candidate: { failedOccurrences: 0, totalOccurrences: 2, failureRateBps: 0 },
		}]);
		expect(first.development.comparison.verified).toBe(true);
		expect(first.sealedHoldout).toEqual({ executed: true, gatePassed: true, verdict: "pass" });
		expect(Object.keys(first.sealedHoldout)).toEqual(["executed", "gatePassed", "verdict"]);
		expect(canonicalJson(first)).not.toContain("holdout-candidate");
		const { subjectHash, ...subject } = first;
		expect(subjectHash).toBe(hashValue(subject));
		expect(Buffer.byteLength(canonicalJson(first), "utf8")).toBeLessThanOrEqual(256 * 1024);
	});

	it.each([
		{
			name: "improved",
			baseline: [{ primary: false, secondary: true }, { primary: false, secondary: true }],
			candidate: [{ primary: false, secondary: true }, { primary: true, secondary: true }],
			outcome: "improved",
			verdict: "improved",
		},
		{
			name: "persisted",
			baseline: [{ primary: false, secondary: true }, { primary: true, secondary: true }],
			candidate: [{ primary: false, secondary: true }, { primary: true, secondary: true }],
			outcome: "persisted",
			verdict: "no-change",
		},
		{
			name: "worsened",
			baseline: [{ primary: false, secondary: true }, { primary: true, secondary: true }],
			candidate: [{ primary: false, secondary: true }, { primary: false, secondary: true }],
			outcome: "worsened",
			verdict: "regressed",
		},
		{
			name: "not reproduced",
			baseline: [{ primary: true, secondary: true }, { primary: true, secondary: true }],
			candidate: [{ primary: true, secondary: true }, { primary: true, secondary: true }],
			outcome: "not-reproduced",
			verdict: "no-change",
		},
	] as const)("classifies $name without model or semantic inference", ({ baseline, candidate, outcome, verdict }) => {
		const value = fixture({ baseline: [...baseline], candidate: [...candidate] });
		const impact = inspectCandidateImpact(value);
		expect(impact.proposalBasis?.targetedFailureModes[0]?.outcome).toBe(outcome);
		expect(impact.verdict).toBe(verdict);
	});

	it("reports exact new signatures and task regressions", () => {
		const value = fixture({
			baseline: [
				{ primary: true, secondary: true },
				{ primary: true, secondary: true },
			],
			candidate: [
				{ primary: true, secondary: false },
				{ primary: true, secondary: false },
			],
		});
		const impact = inspectCandidateImpact(value);

		expect(impact.verdict).toBe("regressed");
		expect(impact.newFailureModes).toHaveLength(1);
		expect(impact.newFailureModes[0]).toMatchObject({
			signature: { checkCode: "output-contains" },
			baseline: { failedOccurrences: 0 },
			candidate: { failedOccurrences: 2 },
		});
		expect(impact.taskRegressions).toMatchObject([{
			taskId: "task-1",
			baselinePassRate: 1,
			candidatePassRate: 0,
		}]);
	});

	it("supports exact mode and safe development-run focus while denying sealed runs", () => {
		const value = fixture({ withHoldout: true });
		const mode = inspectCandidateImpact({
			...value,
			focus: { kind: "mode", failureModeId: value.primaryModeId },
		});
		const run = inspectCandidateImpact({
			...value,
			focus: { kind: "run", runId: value.candidateRunId },
		});

		expect(mode.focus).toEqual({ kind: "mode", failureModeId: value.primaryModeId, role: "targeted" });
		expect(run.focus).toMatchObject({
			kind: "run",
			runId: value.candidateRunId,
			side: "candidate",
			taskId: "task-1",
		});
		expect(() => inspectCandidateImpact({
			...value,
			focus: { kind: "run", runId: value.sealedRunId! },
		})).toThrow(/not public development evidence/);
	});

	it("returns inconclusive when exact grader signatures are missing", () => {
		const legacy = [
			{ primary: false, secondary: true, legacy: true },
			{ primary: false, secondary: true, legacy: true },
		];
		// Source remains exact so the proposal basis is canonical; only the
		// matched Candidate experiment is legacy and cannot support attribution.
		const value = fixture({ baseline: legacy, candidate: legacy });
		const impact = inspectCandidateImpact(value);

		expect(impact.verdict).toBe("inconclusive");
		expect(impact.inconclusiveReasons.join(" ")).toMatch(/without exact checkCode\/specHash|lacks matched exact grader signatures/);
	});

	it("fails closed on stale Candidate hashes and tampered RunRecords", () => {
		const value = fixture();
		expect(() => inspectCandidateImpact({
			...value,
			expectedCandidateHash: `sha256:${"0".repeat(64)}`,
		})).toThrow(/expected Candidate hash is stale/);

		const path = join(value.runsRoot, value.candidateRunId, "run.json");
		const run = readJsonArtifact(path, RunRecordSchema);
		writeJsonArtifact(path, RunRecordSchema, {
			...run,
			metrics: { ...run.metrics, latencyMs: run.metrics.latencyMs + 1 },
		});
		expect(() => inspectCandidateImpact(value)).toThrow(/hash does not match the final eval index/);
	});
});
