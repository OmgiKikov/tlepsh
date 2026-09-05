import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEvalRun, type EvalRunRecord } from "../../src/eval.js";
import { diagnoseEvalRun } from "../../src/diagnosis.js";
import { RunRecordSchema, executionFingerprint, hashFile, hashValue, modelFingerprint, provenanceAxes, provenanceKey, type GraderResult } from "../../src/provenance.js";
import { writeJsonArtifact } from "../../src/storage/artifacts.js";

/**
 * A small but complete Target's evidence: a baseline and a candidate over the
 * same three cases, a sealed holdout pair that must stay invisible, and the
 * Candidate record that ties them together.
 *
 * `SEALED_SENTINEL` is written into every sealed surface a leak could travel
 * through — the eval index, a member RunRecord, that run's trace, and the
 * Candidate's own sealed corpus identity — so a single assertion can prove the
 * whole holdout stayed out of every page.
 */
export const SEALED_SENTINEL = "SEALED-HOLDOUT-SENTINEL-8f31";
const BASELINE_SHA = "1".repeat(40);
const CANDIDATE_SHA = "2".repeat(40);

const fixtureRuntime = {
	piVersion: "0.84.3",
	piSha: "b".repeat(40),
	ahdeVersion: "0.1.0",
	ahdeCodeHash: `sha256:${"c".repeat(64)}`,
};
const fixtureModel = modelFingerprint({
	provider: "mock",
	id: "model",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1/v1",
	apiKeyEnv: "TEST_KEY",
	thinkingLevel: "off",
	params: {},
	spec: {},
});
const fixtureExecution = executionFingerprint("isolated");
const fixtureEvaluation = {
	suiteId: "ombudsman-suite",
	suiteHash: `sha256:${"d".repeat(64)}`,
	dataset: "development",
	datasetHash: `sha256:${"e".repeat(64)}`,
};

function traceFor(input: string, answer: string, calledTool: boolean): string {
	const lines = [
		JSON.stringify({ type: "message", message: { role: "user", content: input, timestamp: 1_000 } }),
		...(calledTool
			? [
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "check_dbo 42" } }],
						timestamp: 1_100,
					},
				}),
				JSON.stringify({
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: "c1",
						toolName: "bash",
						isError: false,
						content: "ok",
						timestamp: 1_400,
					},
				}),
			]
			: []),
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: answer }], timestamp: 1_500 } }),
	];
	return `${lines.join("\n")}\n`;
}

export interface ArmCase {
	taskId: string;
	input: string;
	answer: string;
	calledTool: boolean;
	graders: GraderResult[];
	status?: "completed" | "error";
	error?: string;
	repetitionIndex?: number;
	costUsd?: number | null;
}

function writeArm(options: {
	runsRoot: string;
	evalRunId: string;
	label: "baseline" | "candidate";
	gitSha: string;
	baselineEvalRunId: string | null;
	candidateOf: string | null;
	visibility: "development" | "sealed";
	dataset?: string;
	datasetHash?: string;
	cases: ArmCase[];
	runIdPrefix: string;
}): EvalRunRecord {
	const execution = options.cases.some(entry => entry.costUsd === null) ? {
		...fixtureExecution,
		agent: "command-v1" as const,
		commandProtocol: { version: 2 as const, usageSemantics: "request-incremental-v2" as const },
	} : fixtureExecution;
	const evaluation = {
		...fixtureEvaluation,
		...(options.dataset ? { dataset: options.dataset } : {}),
		...(options.datasetHash ? { datasetHash: options.datasetHash } : {}),
	};
	const runs = options.cases.map((entry, index) => {
		const runId = `${options.runIdPrefix}${index}`;
		const runDir = join(options.runsRoot, runId);
		mkdirSync(runDir, { recursive: true });
		const trace = traceFor(entry.input, entry.answer, entry.calledTool);
		writeFileSync(join(runDir, "session.jsonl"), trace);
		const status = entry.status ?? "completed";
		const record = RunRecordSchema.parse({
			schemaVersion: 1,
			runId,
			taskId: entry.taskId,
			repetitionIndex: entry.repetitionIndex ?? 0,
			label: options.label,
			status,
			error: status === "error" ? (entry.error ?? "sandbox unavailable") : null,
			startedAt: "2026-08-30T10:00:00.000Z",
			finishedAt: "2026-08-30T10:00:01.000Z",
			target: { id: "ombudsman", gitSha: options.gitSha },
			runtime: fixtureRuntime,
			model: fixtureModel,
			execution,
			eval: evaluation,
			trace: { path: "session.jsonl", sessionId: null, sha256: hashFile(trace) },
			metrics: {
				tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
				...(entry.costUsd === null ? {} : { costUsd: entry.costUsd ?? 0.0004 }),
				latencyMs: 1_200,
				toolCalls: entry.calledTool ? 1 : 0,
				toolErrors: 0,
				recoveryAttempts: 0,
			},
			evalResults: status === "error"
				? null
				: { outcome: entry.graders.every((grader) => grader.passed) ? "pass" : "fail", graders: entry.graders },
			parent: { evalRunId: options.evalRunId, candidateOf: options.candidateOf },
		});
		writeJsonArtifact(join(runDir, "run.json"), RunRecordSchema, record);
		return record;
	});
	const evidence = {
		runtime: fixtureRuntime,
		model: fixtureModel,
		judge: null,
		execution,
		eval: evaluation,
	};
	const pass = runs.filter((run) => run.evalResults?.outcome === "pass").length;
	const error = runs.filter((run) => run.status === "error").length;
	const record: EvalRunRecord = {
		schemaVersion: 3,
		purpose: "evidence",
		evalRunId: options.evalRunId,
		target: { id: "ombudsman", gitSha: options.gitSha },
		label: options.label,
		baselineEvalRunId: options.baselineEvalRunId,
		provenance: provenanceAxes(evidence),
		provenanceKey: provenanceKey(evidence),
		suiteId: evaluation.suiteId,
		suiteHash: evaluation.suiteHash,
		dataset: evaluation.dataset,
		datasetHash: evaluation.datasetHash,
		evidenceVisibility: options.visibility,
		taskIds: [...new Set(runs.map((run) => run.taskId))],
		repetitions: Math.max(1, ...runs.map((run) => run.repetitionIndex + 1)),
		runIds: runs.map((run) => run.runId),
		runArtifacts: runs.map((run) => ({ runId: run.runId, sha256: hashValue(run) })),
		startedAt: "2026-08-30T10:00:00.000Z",
		finishedAt: "2026-08-30T10:00:02.000Z",
		summary: {
			total: runs.length,
			pass,
			fail: runs.length - pass - error,
			error,
			allPassRate: runs.length === 0 ? 0 : pass / runs.length,
		},
	};
	writeEvalRun(options.runsRoot, record);
	return record;
}

const toolGrader = (passed: boolean): GraderResult => ({
	name: "task_001#0:tool_called:bash(check_dbo)",
	type: "tool_called",
	checkCode: "required-tool",
	specHash: `sha256:${"a1".repeat(32)}`,
	passed,
	score: passed ? 1 : 0,
	reason: passed ? 'called bash (args contain "check_dbo")' : 'never called bash with args containing "check_dbo"',
});
const containsGrader = (passed: boolean): GraderResult => ({
	name: 'task_002#0:output_contains:"жалоба"',
	type: "output_contains",
	checkCode: "output-contains",
	specHash: `sha256:${"a2".repeat(32)}`,
	passed,
	score: passed ? 1 : 0,
	reason: passed ? 'output contains "жалоба"' : 'output does not contain "жалоба"',
});

function gateEvidence(surface: "development" | "sealed", verdict: string, tasks: number) {
	return {
		schemaVersion: 4,
		algorithmId: "exact-comparison-gate-v4",
		policyId: surface === "sealed" ? "sealed-guardrail-v4" : "development-ci-v4",
		surface,
		comparisonHash: `sha256:${"a".repeat(64)}`,
		evidenceHash: `sha256:${"b".repeat(64)}`,
		gateHash: `sha256:${"c".repeat(64)}`,
		summary: {
			taskCount: tasks,
			baselinePassRate: 0.33,
			candidatePassRate: 1,
			delta: 0.67,
			baselineScore: 0.5,
			candidateScore: 1,
			scoreDelta: 0.5,
			confidence95: { low: 0.2, high: 0.8 },
			improved: tasks,
			regressed: 0,
			unchanged: 0,
		},
		design: { tasks, repetitions: 1, excludedTasks: 0 },
		verdict,
		flags: { regressedTasks: 0, improvedTasks: tasks, collapsedTasks: 0 },
		reasons: [`${verdict} on ${tasks} tasks × 1 repetition`],
		resources: {
			baseline: { runs: tasks, costUsd: 0.001, meanLatencyMs: 1_200, meanTokens: 15 },
			candidate: { runs: tasks, costUsd: 0.0008, meanLatencyMs: 900, meanTokens: 12 },
			costRatio: 0.8,
			latencyRatio: 0.75,
			tokenRatio: 0.8,
		},
	};
}

interface ExplorerFixture {
	runsRoot: string;
	baselineEvalRunId: string;
	candidateEvalRunId: string;
	sealedEvalRunId: string;
	sealedRunId: string;
	candidateId: string;
	failingRunId: string;
	passingRunId: string;
	erroredRunId: string;
}

export function writeExplorerFixture(customCases?: (candidate: boolean) => ArmCase[]): ExplorerFixture {
	const runsRoot = mkdtempSync(join(tmpdir(), "ahde-explorer-"));
	const baselineEvalRunId = "erun_baseline";
	const candidateEvalRunId = "erun_candidate";
	const sealedEvalRunId = "erun_sealed";
	const cases = (armPasses: boolean): ArmCase[] => [
		{
			taskId: "task_001",
			input: "Обращение: проверь договор №42 и ограничения ДБО по нему.",
			answer: "Ответ без проверки.",
			calledTool: armPasses,
			graders: [toolGrader(armPasses)],
		},
		{
			taskId: "task_002",
			input: "Обращение: классифицируй — списание средств.",
			answer: armPasses ? "Это жалоба." : "Это обращение.",
			calledTool: false,
			graders: [containsGrader(armPasses)],
		},
		{
			taskId: "task_003",
			input: "Обращение: третий случай.",
			answer: "",
			calledTool: false,
			graders: [],
			...(armPasses ? {} : { status: "error" as const, error: "sandbox unavailable" }),
			...(armPasses ? { graders: [containsGrader(true)] } : {}),
		},
	];
	writeArm({
		runsRoot,
		evalRunId: baselineEvalRunId,
		label: "baseline",
		gitSha: BASELINE_SHA,
		baselineEvalRunId: null,
		candidateOf: null,
		visibility: "development",
		cases: customCases?.(false) ?? cases(false),
		runIdPrefix: "run_base_",
	});
	writeArm({
		runsRoot,
		evalRunId: candidateEvalRunId,
		label: "candidate",
		gitSha: CANDIDATE_SHA,
		baselineEvalRunId,
		candidateOf: BASELINE_SHA,
		visibility: "development",
		cases: customCases?.(true) ?? cases(true),
		runIdPrefix: "run_cand_",
	});
	// The sealed arm: its index, its member run, and that run's trace all carry
	// the sentinel, so one assertion covers every path a leak could take.
	writeArm({
		runsRoot,
		evalRunId: sealedEvalRunId,
		label: "baseline",
		gitSha: BASELINE_SHA,
		baselineEvalRunId: null,
		candidateOf: null,
		visibility: "sealed",
		dataset: `sealed-corpus-${"f".repeat(64)}`,
		datasetHash: `sha256:${"f".repeat(64)}`,
		cases: [{
			taskId: `${SEALED_SENTINEL}-task`,
			input: `${SEALED_SENTINEL} обращение`,
			answer: `${SEALED_SENTINEL} ответ`,
			calledTool: false,
			graders: [containsGrader(false)],
		}],
		runIdPrefix: "run_sealed_",
	});
	diagnoseEvalRun(runsRoot, baselineEvalRunId, () => "2026-08-30T10:01:00.000Z");
	diagnoseEvalRun(runsRoot, candidateEvalRunId, () => "2026-08-30T10:01:00.000Z");

	const candidateId = "candidate-fixture-0001";
	mkdirSync(join(runsRoot, "candidates", candidateId), { recursive: true });
	writeFileSync(
		join(runsRoot, "candidates", candidateId, "candidate.json"),
		`${JSON.stringify({
			schemaVersion: 1,
			candidateId,
			projectId: "ombudsman",
			targetId: "ombudsman",
			specId: null,
			proposalId: "proposal-fixture",
			diagnosisId: null,
			origin: { kind: "manual", reason: "fixture candidate" },
			mode: "candidate",
			baseline: { ref: "main", sha: BASELINE_SHA },
			createdAt: "2026-08-30T10:02:00.000Z",
			events: [
				{ type: "proposed", eventId: `${candidateId}-1`, at: "2026-08-30T10:02:00.000Z", actor: { kind: "human", id: "local:test" } },
				{
					type: "built",
					eventId: `${candidateId}-2`,
					at: "2026-08-30T10:02:01.000Z",
					actor: { kind: "human", id: "local:test" },
					candidate: { ref: "candidate/fixture", sha: CANDIDATE_SHA },
				},
				{
					type: "validated",
					eventId: `${candidateId}-3`,
					at: "2026-08-30T10:02:02.000Z",
					actor: { kind: "system", id: "validator" },
					lineage: {
						baseline: { ref: "main", sha: BASELINE_SHA },
						candidate: { ref: "candidate/fixture", sha: CANDIDATE_SHA },
						relation: "descendant",
					},
					scope: {
						policyId: "harness-scope-v1",
						baselineSha: BASELINE_SHA,
						candidateSha: CANDIDATE_SHA,
						passed: true,
						changedFiles: ["AGENTS.md"],
						violations: [],
					},
				},
				{
					type: "evaluated",
					eventId: `${candidateId}-4`,
					at: "2026-08-30T10:02:03.000Z",
					actor: { kind: "system", id: "evaluator" },
					evaluation: {
						experimentId: `${candidateId}-exp`,
						designHash: `sha256:${"d".repeat(64)}`,
						mode: "candidate",
						development: {
							baseline: { evalRunId: baselineEvalRunId, harness: { ref: "main", sha: BASELINE_SHA } },
							candidate: { evalRunId: candidateEvalRunId, harness: { ref: "candidate/fixture", sha: CANDIDATE_SHA } },
							comparison: gateEvidence("development", "improved", 3),
						},
						sealedHoldout: {
							baseline: { evalRunId: sealedEvalRunId, harness: { ref: "main", sha: BASELINE_SHA } },
							candidate: { evalRunId: `${sealedEvalRunId}_candidate`, harness: { ref: "candidate/fixture", sha: CANDIDATE_SHA } },
							corpus: { id: `corpus-${SEALED_SENTINEL}`, hash: `sha256:${"f".repeat(64)}` },
							comparison: gateEvidence("sealed", "pass", 2),
						},
						infrastructureErrors: 0,
					},
				},
			],
		}, null, "\t")}\n`,
	);
	return {
		runsRoot,
		baselineEvalRunId,
		candidateEvalRunId,
		sealedEvalRunId,
		sealedRunId: "run_sealed_0",
		candidateId,
		failingRunId: "run_base_0",
		passingRunId: "run_cand_0",
		erroredRunId: "run_base_2",
	};
}
