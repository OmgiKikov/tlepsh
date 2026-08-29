import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CANDIDATE_SCOPE_POLICY,
	CandidateDevelopmentSurfaceError,
	CandidateExperimentError,
	DEVELOPMENT_GATE_POLICY_ID,
	SEALED_GATE_POLICY_ID,
	comparisonGateEvidence,
	runCandidateExperiment,
	type CandidateExperimentDependencies,
} from "../src/application/candidate-experiment.js";
import { type CompareResult } from "../src/compare.js";
import { createCorpus, loadCorpus, type CorpusMetadata, type CorpusRef } from "../src/corpus.js";
import {
	targetEvalSurface,
	targetWithDevelopmentCorpus,
} from "../src/application/corpus-target.js";
import {
	CandidateRecordSchema,
	EXACT_COMPARISON_GATE_ALGORITHM_ID,
	candidateStatus,
} from "../src/domain/candidate.js";
import {
	type EvalRunRecord,
	type ReusableBaselineQuery,
	type RunSuiteOptions,
	loadRun,
	loadVerifiedEvalRun,
	writeEvalRun,
} from "../src/eval.js";
import { loadTarget, type ResolvedTarget } from "../src/manifest.js";
import {
	RunRecordSchema,
	executionFingerprint,
	hashValue,
	modelFingerprint,
	provenanceAxes,
	type GraderResult,
	type RunRecord,
} from "../src/provenance.js";
import { readJsonArtifact, writeJsonArtifact } from "../src/storage/artifacts.js";
import { baseFixtureFiles } from "./fixtures.js";

interface RepositoryFixture {
	dir: string;
	runsRoot: string;
	baselineSha: string;
	candidateSha: string;
	branch: string;
	head: string;
}

interface FakeRuntimeOptions {
	reuseBaseline?: boolean;
	reuseWorkspaceMismatch?: boolean;
	compareStatus?: CompareResult["status"];
	comparisonDeltas?: number[];
	baselineErrors?: number;
	candidateErrors?: number;
}

interface FakeRuntime {
	dependencies: Partial<CandidateExperimentDependencies>;
	suiteCalls: Array<{ target: ResolvedTarget; options: RunSuiteOptions }>;
	reuseQueries: ReusableBaselineQuery[];
	compareModes: string[];
	targetPaths: string[];
}

const cleanupPaths: string[] = [];

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function writeFixtureFiles(dir: string): void {
	for (const file of baseFixtureFiles()) {
		const path = join(dir, file.path);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, file.content);
	}
}

interface RepositoryChange {
	path: string;
	content: string;
	mode?: number;
}

function createRepository(change?: RepositoryChange | RepositoryChange[]): RepositoryFixture {
	const dir = mkdtempSync(join(tmpdir(), "ahde-candidate-experiment-"));
	const runsRoot = mkdtempSync(join(tmpdir(), "ahde-candidate-runs-"));
	cleanupPaths.push(dir, runsRoot);
	git(dir, "init", "-q");
	git(dir, "config", "user.name", "AHDE Test");
	git(dir, "config", "user.email", "ahde-test@example.invalid");
	git(dir, "branch", "-M", "main");
	writeFixtureFiles(dir);
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "baseline");
	const baselineSha = git(dir, "rev-parse", "HEAD");

	if (change) {
		for (const item of Array.isArray(change) ? change : [change]) {
			const path = join(dir, item.path);
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, item.content);
			if (item.mode !== undefined) chmodSync(path, item.mode);
		}
		git(dir, "add", "-A");
		git(dir, "commit", "-qm", "candidate");
	}
	const candidateSha = git(dir, "rev-parse", "HEAD");
	git(dir, "checkout", "-qb", "user-checkout");
	return {
		dir,
		runsRoot,
		baselineSha,
		candidateSha,
		branch: git(dir, "branch", "--show-current"),
		head: git(dir, "rev-parse", "HEAD"),
	};
}

function targetProvenance(target: ResolvedTarget) {
	return provenanceAxes({
		runtime: target.runtime,
		model: modelFingerprint(target.manifest.model),
		judge: target.manifest.evalSuite.judge ? modelFingerprint(target.manifest.evalSuite.judge) : null,
		execution: executionFingerprint("isolated"),
		eval: { suiteHash: target.suiteHash, datasetHash: target.datasetHash },
	});
}

const RUN_STARTED_AT = "2026-08-26T10:00:00.000Z";
const RUN_FINISHED_AT = "2026-08-26T10:00:30.000Z";
const PASSING_GRADER: GraderResult = {
	name: "fixture",
	type: "output_contains",
	passed: true,
	score: 1,
	reason: "fixture pass",
};
const EMPTY_TRACE: RunRecord["trace"] = { path: "session.jsonl", sessionId: null, sha256: null };
const EMPTY_METRICS: RunRecord["metrics"] = {
	tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	costUsd: 0,
	latencyMs: 0,
	toolCalls: 0,
	toolErrors: 0,
	recoveryAttempts: 0,
};

/**
 * Persist final run.json records and anchor them exactly as production
 * runSuite does: each RunArtifact hash is computed from the re-read persisted
 * RunRecord, so loadVerifiedEvalRun can verify the index against disk.
 */
function persistRuns(
	runsRoot: string,
	runs: RunRecord[],
): { runIds: string[]; runArtifacts: NonNullable<EvalRunRecord["runArtifacts"]> } {
	const runIds: string[] = [];
	const runArtifacts: NonNullable<EvalRunRecord["runArtifacts"]> = [];
	for (const run of runs) {
		writeJsonArtifact(join(runsRoot, run.runId, "run.json"), RunRecordSchema, run);
		runIds.push(run.runId);
		runArtifacts.push({ runId: run.runId, sha256: hashValue(loadRun(runsRoot, run.runId)) });
	}
	return { runIds, runArtifacts };
}

/** Fake runSuite output: tasks × repetitions final RunRecords plus the index that anchors them. */
function evalRecord(
	target: ResolvedTarget,
	options: RunSuiteOptions,
	id: string,
	errors = 0,
): EvalRunRecord {
	const provenance = targetProvenance(target);
	const runTarget = {
		id: target.manifest.id,
		gitSha: target.gitSha,
		toolsetHash: target.toolsetHash,
		workspaceHash: options.expectedWorkspaceHash ?? hashValue({ target: target.gitSha, id }),
	};
	const evalSurface = {
		suiteId: target.manifest.evalSuite.id,
		suiteHash: target.suiteHash,
		dataset: targetEvalSurface(target).dataset,
		datasetHash: target.datasetHash,
	};
	const runs: RunRecord[] = [];
	for (const [taskIndex, task] of target.tasks.entries()) {
		for (let repetitionIndex = 0; repetitionIndex < options.repetitions; repetitionIndex += 1) {
			const ordinal = taskIndex * options.repetitions + repetitionIndex;
			const failed = ordinal < errors;
			runs.push({
				schemaVersion: 1,
				runId: `${id}-run-${ordinal}`,
				taskId: task.id,
				repetitionIndex,
				label: options.label,
				status: failed ? "error" : "completed",
				error: failed ? "fixture infrastructure failure" : null,
				startedAt: RUN_STARTED_AT,
				finishedAt: RUN_FINISHED_AT,
				target: runTarget,
				runtime: target.runtime,
				model: modelFingerprint(target.manifest.model),
				execution: executionFingerprint("isolated"),
				eval: evalSurface,
				trace: EMPTY_TRACE,
				metrics: EMPTY_METRICS,
				evalResults: failed ? null : { graders: [PASSING_GRADER], outcome: "pass" },
				parent: { evalRunId: id, candidateOf: options.candidateOf ?? null },
			});
		}
	}
	const persisted = persistRuns(options.runsRoot, runs);
	const total = runs.length;
	const pass = total - errors;
	return {
		schemaVersion: 1,
		evalRunId: id,
		target: runTarget,
		label: options.label,
		baselineEvalRunId: options.baselineEvalRunId ?? null,
		provenance,
		provenanceKey: hashValue(provenance),
		suiteId: evalSurface.suiteId,
		suiteHash: evalSurface.suiteHash,
		dataset: evalSurface.dataset,
		datasetHash: evalSurface.datasetHash,
		evidenceVisibility: options.evidenceVisibility ?? "development",
		taskIds: target.tasks.map((task) => task.id),
		repetitions: options.repetitions,
		runIds: persisted.runIds,
		runArtifacts: persisted.runArtifacts,
		startedAt: RUN_STARTED_AT,
		finishedAt: "2026-08-26T10:01:00.000Z",
		summary: {
			total,
			pass,
			fail: 0,
			error: errors,
			allPassRate: pass / total,
		},
	};
}

/** A previously persisted baseline that matches the reuse query exactly, with its final RunRecords on disk. */
function reusableRecord(
	runsRoot: string,
	query: ReusableBaselineQuery,
	id = "eval-reused-baseline",
): EvalRunRecord {
	const repetitions = query.repetitions ?? 1;
	const label = query.label ?? "baseline";
	const axes = query.provenance;
	const runTarget = {
		id: query.targetId,
		gitSha: query.targetGitSha,
		toolsetHash: query.toolsetHash,
		workspaceHash: query.workspaceHash,
	};
	const evalSurface = {
		suiteId: "test-suite",
		suiteHash: axes.suiteHash,
		dataset: "development",
		datasetHash: axes.datasetHash,
	};
	const runs = Array.from({ length: repetitions }, (_, repetitionIndex): RunRecord => ({
		schemaVersion: 1,
		runId: `${id}-run-${repetitionIndex}`,
		taskId: "reused-task",
		repetitionIndex,
		label,
		status: "completed",
		error: null,
		startedAt: "2026-08-26T09:00:00.000Z",
		finishedAt: "2026-08-26T09:00:30.000Z",
		target: runTarget,
		runtime: {
			piVersion: axes.piVersion,
			piSha: axes.piSha,
			ahdeVersion: axes.ahdeVersion,
			ahdeCodeHash: axes.ahdeCodeHash,
		},
		model: {
			provider: axes.provider,
			id: axes.modelId,
			api: axes.modelApi,
			baseUrl: axes.modelBaseUrl,
			apiKeyEnv: axes.modelApiKeyEnv,
			thinkingLevel: axes.thinkingLevel,
			params: axes.params,
			spec: axes.modelSpec,
		},
		execution: axes.execution,
		eval: evalSurface,
		trace: EMPTY_TRACE,
		metrics: EMPTY_METRICS,
		evalResults: { graders: [PASSING_GRADER], outcome: "pass" },
		parent: { evalRunId: id, candidateOf: null },
	}));
	const persisted = persistRuns(runsRoot, runs);
	return {
		schemaVersion: 1,
		evalRunId: id,
		target: runTarget,
		label,
		baselineEvalRunId: null,
		provenance: query.provenance,
		provenanceKey: hashValue(query.provenance),
		suiteId: evalSurface.suiteId,
		suiteHash: evalSurface.suiteHash,
		dataset: evalSurface.dataset,
		datasetHash: evalSurface.datasetHash,
		evidenceVisibility: query.evidenceVisibility,
		repetitions,
		runIds: persisted.runIds,
		runArtifacts: persisted.runArtifacts,
		startedAt: "2026-08-26T09:00:00.000Z",
		finishedAt: "2026-08-26T09:01:00.000Z",
		summary: { total: repetitions, pass: repetitions, fail: 0, error: 0, allPassRate: 1 },
	};
}

function comparison(
	a: EvalRunRecord,
	b: EvalRunRecord,
	status: CompareResult["status"],
	forcedDelta?: number,
): CompareResult {
	const error = status === "comparable" ? null : `${status}: test comparison`;
	const delta = forcedDelta ?? b.summary.allPassRate - a.summary.allPassRate;
	const rows = forcedDelta === undefined
		? []
		: [{
				taskId: "forced-task",
				aPassRate: forcedDelta < 0 ? 1 : 0,
				bPassRate: forcedDelta < 0 ? 1 + forcedDelta : forcedDelta,
				delta: forcedDelta,
				aStatus: "completed",
				bStatus: "completed",
				aPass: forcedDelta < 0 ? 1 : 0,
				aTotal: 1,
				bPass: forcedDelta < 0 ? 0 : 1,
				bTotal: 1,
			}];
	return {
		a,
		b,
		rows,
		status,
		issues: error ? [error] : [],
		error,
		summary: {
			taskCount: rows.length,
			baselinePassRate: a.summary.allPassRate,
			candidatePassRate: b.summary.allPassRate,
			delta,
			confidence95: { low: 0, high: 0 },
			improved: delta > 0 ? 1 : 0,
			regressed: delta < 0 ? 1 : 0,
			unchanged: delta === 0 ? rows.length : 0,
		},
	};
}

function fakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
	const suiteCalls: Array<{ target: ResolvedTarget; options: RunSuiteOptions }> = [];
	const reuseQueries: ReusableBaselineQuery[] = [];
	const compareModes: string[] = [];
	const targetPaths: string[] = [];
	const evaluations = new Map<string, EvalRunRecord>();
	let sequence = 0;
	let reuseSequence = 0;
	const dependencies: Partial<CandidateExperimentDependencies> = {
		now: () => "2026-08-26T10:00:00.000Z",
		findReusableBaseline: (runsRoot, query) => {
			reuseQueries.push(query);
			if (!options.reuseBaseline) return null;
			reuseSequence += 1;
			const record = reusableRecord(
				runsRoot,
				options.reuseWorkspaceMismatch
					? { ...query, workspaceHash: hashValue({ staleWorkspace: reuseSequence }) }
					: query,
				reuseSequence === 1 ? "eval-reused-baseline" : `eval-reused-baseline-${reuseSequence}`,
			);
			evaluations.set(record.evalRunId, record);
			writeEvalRun(runsRoot, record);
			return record;
		},
		runSuite: async (target, runOptions) => {
			targetPaths.push(target.dir);
			expect(existsSync(target.dir)).toBe(true);
			suiteCalls.push({ target, options: runOptions });
			sequence += 1;
			const errors = runOptions.label === "baseline"
				? (options.baselineErrors ?? 0)
				: (options.candidateErrors ?? 0);
			const record = evalRecord(target, runOptions, `eval-${sequence}-${runOptions.label}`, errors);
			evaluations.set(record.evalRunId, record);
			writeEvalRun(runOptions.runsRoot, record);
			return record;
		},
		compareEvalRuns: (_runsRoot, aId, bId, compareOptions) => {
			compareModes.push(compareOptions?.mode ?? "candidate");
			const a = evaluations.get(aId);
			const b = evaluations.get(bId);
			if (!a || !b) throw new Error("fake comparison missing eval record");
			return comparison(
				a,
				b,
				options.compareStatus ?? "comparable",
				options.comparisonDeltas?.[compareModes.length - 1],
			);
		},
	};
	return { dependencies, suiteCalls, reuseQueries, compareModes, targetPaths };
}

function corpusFixture(
	visibility: "development" | "sealed",
	input = "SEALED_TASK_INPUT_NEVER_METADATA",
	name = "private holdout name",
): { ref: CorpusRef; metadata: CorpusMetadata; stateRoot: string; input: string; name: string } {
	const stateRoot = mkdtempSync(join(tmpdir(), "ahde-candidate-corpus-"));
	cleanupPaths.push(stateRoot);
	const projectId = "project-1";
	const metadata = createCorpus({
		stateRoot,
		projectId,
		name,
		visibility,
		tasks: [
			{
				id: "sealed-task-1",
				input,
				graders: [{ type: "output_contains", text: "expected-one" }],
			},
			{
				id: "sealed-task-2",
				input: `${input}-second`,
				graders: [{ type: "output_matches", pattern: "expected-two" }],
			},
		],
	});
	return {
		ref: { stateRoot, projectId, corpusId: metadata.id },
		metadata,
		stateRoot,
		input,
		name,
	};
}

function assertCheckoutUnchanged(repository: RepositoryFixture): void {
	expect(git(repository.dir, "branch", "--show-current")).toBe(repository.branch);
	expect(git(repository.dir, "rev-parse", "HEAD")).toBe(repository.head);
}

describe("Candidate Experiment application service", () => {
	it("rejects an out-of-scope diff before baseline lookup or evaluator calls", async () => {
		const repository = createRepository({
			path: "evals/development.jsonl",
			content: `${JSON.stringify({ id: "changed", input: "x", graders: [{ type: "output_contains", text: "x" }] })}\n`,
		});
		const runtime = fakeRuntime();

		await expect(
			runCandidateExperiment(
				{
					repositoryDir: repository.dir,
					runsRoot: repository.runsRoot,
					baselineRef: repository.baselineSha,
					candidateRef: repository.candidateSha,
					mode: "candidate",
					repetitions: 1,
					candidateId: "scope-failure",
				},
				runtime.dependencies,
			),
		).rejects.toThrow(/scope violation.*evals\/development\.jsonl/);

		expect(runtime.reuseQueries).toHaveLength(0);
		expect(runtime.suiteCalls).toHaveLength(0);
		expect(existsSync(join(repository.runsRoot, "candidates", "scope-failure", "candidate.json"))).toBe(false);
		assertCheckoutUnchanged(repository);
	});

	it("accepts a bounded skill/tool manifest diff as a comparable candidate", async () => {
		const baselineManifest = baseFixtureFiles().find((file) => file.path === "manifest.yaml")?.content;
		if (!baselineManifest) throw new Error("missing manifest fixture");
		const candidateManifest = baselineManifest.replace(
			"skills: [skills/check-dbo]\n",
			"skills: [skills/check-dbo, skills/search-docs]\ntools: [tools/search_docs.tool.yaml]\n",
		);
		const repository = createRepository([
			{ path: "manifest.yaml", content: candidateManifest },
			{
				path: "skills/search-docs/SKILL.md",
				content: "---\nname: search-docs\ndescription: Search local documentation.\n---\n\nUse search_docs.\n",
			},
			{
				path: "tools/search_docs.tool.yaml",
				content: `schemaVersion: 1
name: search_docs
description: Search local documentation.
parameters:
  type: object
  properties:
    query: { type: string, minLength: 1 }
  required: [query]
  additionalProperties: false
command:
  argv: [bin/search_docs]
timeoutMs: 1000
maxOutputBytes: 4096
output: json
permissions:
  environment: []
  network: deny
  filesystem: read-only
`,
			},
			{ path: "bin/search_docs", content: "#!/bin/sh\nprintf '{\"matches\":[]}\\n'\n", mode: 0o755 },
		]);
		const runtime = fakeRuntime();

		const result = await runCandidateExperiment({
			repositoryDir: repository.dir,
			runsRoot: repository.runsRoot,
			baselineRef: repository.baselineSha,
			candidateRef: repository.candidateSha,
			mode: "candidate",
			repetitions: 1,
			candidateId: "candidate-resource-manifest",
		}, runtime.dependencies);

		expect(result.compare.status).toBe("comparable");
		expect(result.changedFiles).toEqual([
			"bin/search_docs",
			"manifest.yaml",
			"skills/search-docs/SKILL.md",
			"tools/search_docs.tool.yaml",
		]);
		expect(runtime.suiteCalls[0]?.target.tools).toHaveLength(0);
		expect(runtime.suiteCalls[1]?.target.tools.map((tool) => tool.descriptor.name)).toEqual(["search_docs"]);
		// Custom tool identity is deliberately not an execution comparison axis.
		expect(runtime.reuseQueries[0]?.provenance.execution.tools).toEqual(["read", "bash"]);
		assertCheckoutUnchanged(repository);
	});

	it("rejects a protected manifest mutation even when invoked with manual exact refs", async () => {
		const baselineManifest = baseFixtureFiles().find((file) => file.path === "manifest.yaml")?.content;
		if (!baselineManifest) throw new Error("missing manifest fixture");
		const repository = createRepository({
			path: "manifest.yaml",
			content: baselineManifest.replace("id: qwen3.5-27b", "id: changed-model"),
		});
		const runtime = fakeRuntime();

		await expect(runCandidateExperiment({
			repositoryDir: repository.dir,
			runsRoot: repository.runsRoot,
			baselineRef: repository.baselineSha,
			candidateRef: repository.candidateSha,
			mode: "candidate",
			repetitions: 1,
			candidateId: "candidate-protected-manifest",
		}, runtime.dependencies)).rejects.toThrow(/protected field\(s\) changed: model/);

		expect(runtime.reuseQueries).toHaveLength(0);
		expect(runtime.suiteCalls).toHaveLength(0);
		expect(existsSync(join(repository.runsRoot, "candidates", "candidate-protected-manifest", "candidate.json"))).toBe(false);
		assertCheckoutUnchanged(repository);
	});

	it("validates target identity before any evaluator call", async () => {
		const repository = createRepository({ path: "AGENTS.md", content: "candidate harness\n" });
		const runtime = fakeRuntime();
		let loads = 0;
		const mismatchedLoad: typeof loadTarget = (path, override) => {
			loads += 1;
			const target = loadTarget(path, override);
			return loads === 2
				? { ...target, manifest: { ...target.manifest, id: "different-target" } }
				: target;
		};

		await expect(
			runCandidateExperiment(
				{
					repositoryDir: repository.dir,
					runsRoot: repository.runsRoot,
					baselineRef: repository.baselineSha,
					candidateRef: repository.candidateSha,
					mode: "candidate",
					repetitions: 1,
				},
				{ ...runtime.dependencies, loadTarget: mismatchedLoad },
			),
		).rejects.toThrow(/target id mismatch/);
		expect(runtime.reuseQueries).toHaveLength(0);
		expect(runtime.suiteCalls).toHaveLength(0);
		assertCheckoutUnchanged(repository);
	});

	it("reuses only the exact baseline and persists an evaluated record", async () => {
		const repository = createRepository({ path: "AGENTS.md", content: "candidate harness\n" });
		const runtime = fakeRuntime({ reuseBaseline: true });
		const candidateId = "candidate-reuse";

		const result = await runCandidateExperiment(
			{
				repositoryDir: repository.dir,
				runsRoot: repository.runsRoot,
				baselineRef: repository.baselineSha,
				candidateRef: repository.candidateSha,
				mode: "candidate",
				repetitions: 3,
				candidateId,
				projectId: "project-1",
				proposalId: "proposal-1",
				diagnosisId: "diagnosis-1",
				actorId: "alice",
			},
			runtime.dependencies,
		);

		expect(result.baselineReused).toBe(true);
		expect(result.sealedHoldout).toBeNull();
		expect(runtime.reuseQueries).toHaveLength(1);
		expect(runtime.reuseQueries[0]).toMatchObject({
			targetId: "test-target",
			targetGitSha: repository.baselineSha,
			label: "baseline",
			repetitions: 3,
		});
		expect(runtime.suiteCalls).toHaveLength(1);
		expect(runtime.suiteCalls[0]?.options).toMatchObject({
			label: "candidate",
			candidateOf: repository.baselineSha,
			baselineEvalRunId: "eval-reused-baseline",
			repetitions: 3,
		});
		expect(result.changedFiles).toEqual(["AGENTS.md"]);
		expect(candidateStatus(result.record)).toBe("evaluated");
		const finalEvent = result.record.events.at(-1);
		expect(finalEvent?.type).toBe("evaluated");
		if (finalEvent?.type === "evaluated") {
			expect(finalEvent.evaluation.sealedHoldout).toBeUndefined();
			expect(finalEvent.evaluation.development.comparison).toMatchObject({
				schemaVersion: 2,
				algorithmId: EXACT_COMPARISON_GATE_ALGORITHM_ID,
				policyId: DEVELOPMENT_GATE_POLICY_ID,
			});
		}
		// The reused index anchors its persisted final RunRecords, so it is promotion-grade evidence.
		for (const evalRunId of ["eval-reused-baseline", result.candidate.evalRunId]) {
			expect(loadVerifiedEvalRun(repository.runsRoot, evalRunId).hasRunHashes).toBe(true);
		}
		const expectedDesignHash = hashValue({
			schemaVersion: 1,
			baseline: { ref: repository.baselineSha, sha: repository.baselineSha },
			candidate: { ref: repository.candidateSha, sha: repository.candidateSha },
			mode: "candidate",
			repetitions: 3,
			dataset: "evals/development.jsonl",
			scopePolicy: CANDIDATE_SCOPE_POLICY,
		});
		expect(result.designHash).toBe(expectedDesignHash);
		expect(
			candidateStatus(readJsonArtifact(result.candidateRecordPath, CandidateRecordSchema)),
		).toBe("evaluated");
		for (const path of runtime.targetPaths) expect(existsSync(path)).toBe(false);
		assertCheckoutUnchanged(repository);
	});

	it("rejects a reusable baseline whose model-visible workspace hash differs", async () => {
		const repository = createRepository({ path: "AGENTS.md", content: "candidate harness\n" });
		const runtime = fakeRuntime({ reuseBaseline: true, reuseWorkspaceMismatch: true });

		const result = await runCandidateExperiment(
			{
				repositoryDir: repository.dir,
				runsRoot: repository.runsRoot,
				baselineRef: repository.baselineSha,
				candidateRef: repository.candidateSha,
				mode: "candidate",
				repetitions: 1,
				candidateId: "candidate-stale-workspace-reuse",
			},
			runtime.dependencies,
		);

		expect(result.baselineReused).toBe(false);
		expect(runtime.reuseQueries[0]?.workspaceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(runtime.suiteCalls.map((call) => call.options.label)).toEqual(["baseline", "candidate"]);
		expect(runtime.suiteCalls[0]?.options.expectedWorkspaceHash).toBe(
			runtime.reuseQueries[0]?.workspaceHash,
		);
		assertCheckoutUnchanged(repository);
	});

	it("rejects a development corpus before creating or evaluating a candidate", async () => {
		const repository = createRepository({ path: "AGENTS.md", content: "candidate harness\n" });
		const corpus = corpusFixture("development");
		const runtime = fakeRuntime();
		const candidateId = "candidate-development-holdout";

		await expect(
			runCandidateExperiment(
				{
					repositoryDir: repository.dir,
					runsRoot: repository.runsRoot,
					baselineRef: repository.baselineSha,
					candidateRef: repository.candidateSha,
					mode: "candidate",
					repetitions: 1,
					candidateId,
					sealedCorpus: corpus.ref,
				},
				runtime.dependencies,
			),
		).rejects.toThrow(/requires a sealed corpus, got development/);

		expect(runtime.reuseQueries).toHaveLength(0);
		expect(runtime.suiteCalls).toHaveLength(0);
		expect(existsSync(join(repository.runsRoot, "candidates", candidateId, "candidate.json"))).toBe(false);
		assertCheckoutUnchanged(repository);
	});

	it("runs the matched development pair on one exact published corpus and persists its identity", async () => {
		const repository = createRepository({ path: "AGENTS.md", content: "candidate harness\n" });
		const corpus = corpusFixture(
			"development",
			"PRIVATE_DEVELOPMENT_TASK_INPUT_4291",
			"private development basket",
		);
		const runtime = fakeRuntime();
		const sourceSurface = targetEvalSurface(
			targetWithDevelopmentCorpus(loadTarget(repository.dir), loadCorpus(corpus.ref)),
		);

		const result = await runCandidateExperiment(
			{
				repositoryDir: repository.dir,
				runsRoot: repository.runsRoot,
				baselineRef: repository.baselineSha,
				candidateRef: repository.candidateSha,
				mode: "candidate",
				repetitions: 2,
				candidateId: "candidate-development-corpus",
				projectId: "project-1",
				developmentCorpus: corpus.ref,
				expectedDevelopmentSource: sourceSurface,
			},
			runtime.dependencies,
		);

		expect(result.developmentCorpus).toEqual({ id: corpus.metadata.id, hash: corpus.metadata.hash });
		expect(result.sealedHoldout).toBeNull();
		expect(runtime.suiteCalls).toHaveLength(2);
		for (const call of runtime.suiteCalls) {
			expect(targetEvalSurface(call.target)).toEqual(sourceSurface);
			expect(call.target.manifest.evalSuite.dataset).toBe(`development-${corpus.metadata.id}.jsonl`);
			expect(call.target.tasks.map((task) => task.id)).toEqual(["sealed-task-1", "sealed-task-2"]);
		}
		const evaluated = result.record.events.at(-1);
		expect(evaluated?.type).toBe("evaluated");
		if (evaluated?.type !== "evaluated") throw new Error("expected evaluated event");
		expect(evaluated.evaluation.development.corpus).toEqual({
			id: corpus.metadata.id,
			hash: corpus.metadata.hash,
		});
		expect(evaluated.evaluation.development.comparison).toEqual(comparisonGateEvidence(
			result.compare,
			DEVELOPMENT_GATE_POLICY_ID,
			{ corpusId: corpus.metadata.id, corpusHash: corpus.metadata.hash },
		));
		expect(result.designHash).toBe(hashValue({
			schemaVersion: 1,
			baseline: { ref: repository.baselineSha, sha: repository.baselineSha },
			candidate: { ref: repository.candidateSha, sha: repository.candidateSha },
			mode: "candidate",
			repetitions: 2,
			dataset: `development-${corpus.metadata.id}.jsonl`,
			scopePolicy: CANDIDATE_SCOPE_POLICY,
			developmentCorpus: { id: corpus.metadata.id, hash: corpus.metadata.hash },
		}));
		for (const path of [
			result.candidateRecordPath,
			join(repository.runsRoot, result.baseline.evalRunId, "eval_run.json"),
			join(repository.runsRoot, result.candidate.evalRunId, "eval_run.json"),
		]) {
			const evidence = readFileSync(path, "utf8");
			expect(evidence).not.toContain(corpus.input);
			expect(evidence).not.toContain(corpus.name);
			expect(evidence).not.toContain(corpus.stateRoot);
		}
		assertCheckoutUnchanged(repository);
	});

	it("rejects invalid development-corpus combinations before candidate publication", async () => {
		const repository = createRepository({ path: "AGENTS.md", content: "candidate harness\n" });
		const development = corpusFixture("development");
		const sealed = corpusFixture("sealed");
		const runtime = fakeRuntime();

		await expect(runCandidateExperiment({
			repositoryDir: repository.dir,
			runsRoot: repository.runsRoot,
			baselineRef: repository.baselineSha,
			candidateRef: repository.candidateSha,
			mode: "candidate",
			repetitions: 1,
			candidateId: "candidate-mutually-exclusive",
			dataset: "evals/development.jsonl",
			developmentCorpus: development.ref,
		}, runtime.dependencies)).rejects.toThrow(/cannot combine --dataset/);

		await expect(runCandidateExperiment({
			repositoryDir: repository.dir,
			runsRoot: repository.runsRoot,
			baselineRef: repository.baselineSha,
			candidateRef: repository.candidateSha,
			mode: "candidate",
			repetitions: 1,
			candidateId: "candidate-sealed-development",
			developmentCorpus: sealed.ref,
		}, runtime.dependencies)).rejects.toThrow(/requires a development corpus, got sealed/);

		expect(runtime.reuseQueries).toHaveLength(0);
		expect(runtime.suiteCalls).toHaveLength(0);
		expect(existsSync(join(repository.runsRoot, "candidates", "candidate-mutually-exclusive", "candidate.json"))).toBe(false);
		expect(existsSync(join(repository.runsRoot, "candidates", "candidate-sealed-development", "candidate.json"))).toBe(false);
	});

	it.each(["dataset", "datasetHash", "suiteHash"] as const)(
		"rejects a Builder source %s mismatch before any evaluation",
		async (field) => {
			const repository = createRepository({ path: "AGENTS.md", content: "candidate harness\n" });
			const corpus = corpusFixture("development");
			const runtime = fakeRuntime();
			const exact = targetEvalSurface(
				targetWithDevelopmentCorpus(loadTarget(repository.dir), loadCorpus(corpus.ref)),
			);
			const expected = {
				...exact,
				[field]: field === "dataset" ? "development-other" : `sha256:${"f".repeat(64)}`,
			};
			const candidateId = `candidate-source-mismatch-${field}`;

			await expect(runCandidateExperiment({
				repositoryDir: repository.dir,
				runsRoot: repository.runsRoot,
				baselineRef: repository.baselineSha,
				candidateRef: repository.candidateSha,
				mode: "candidate",
				repetitions: 1,
				candidateId,
				developmentCorpus: corpus.ref,
				expectedDevelopmentSource: expected,
			}, runtime.dependencies)).rejects.toBeInstanceOf(CandidateDevelopmentSurfaceError);

			expect(runtime.reuseQueries).toHaveLength(0);
			expect(runtime.suiteCalls).toHaveLength(0);
			expect(existsSync(join(repository.runsRoot, "candidates", candidateId, "candidate.json"))).toBe(false);
			assertCheckoutUnchanged(repository);
		},
	);

	it("runs development then sealed matched pairs without leaking corpus content into metadata", async () => {
		const repository = createRepository({ path: "AGENTS.md", content: "candidate harness\n" });
		const corpus = corpusFixture(
			"sealed",
			"ULTRA_SECRET_SEALED_TASK_INPUT_7219",
			"unpublished customer holdout",
		);
		const runtime = fakeRuntime();
		const candidateId = "candidate-sealed-pairs";
		const onRunEvent = () => {};

		const result = await runCandidateExperiment(
			{
				repositoryDir: repository.dir,
				runsRoot: repository.runsRoot,
				baselineRef: repository.baselineSha,
				candidateRef: repository.candidateSha,
				mode: "candidate",
				repetitions: 2,
				candidateId,
				projectId: "project-1",
				sealedCorpus: corpus.ref,
				onRunEvent,
			},
			runtime.dependencies,
		);

		expect(runtime.suiteCalls.map((call) => call.options.label)).toEqual([
			"baseline",
			"candidate",
			"baseline",
			"candidate",
		]);
		expect(runtime.compareModes).toEqual(["candidate", "candidate"]);
		expect(runtime.reuseQueries).toHaveLength(2);
		for (const call of runtime.suiteCalls.slice(0, 2)) {
			expect(call.options.onRunEvent).toBe(onRunEvent);
			expect(call.options.evidenceVisibility).toBe("development");
		}
		for (const call of runtime.suiteCalls.slice(2)) {
			expect(call.options).not.toHaveProperty("onRunEvent");
			expect(call.options.evidenceVisibility).toBe("sealed");
		}
		expect(runtime.reuseQueries.map((query) => query.evidenceVisibility)).toEqual(["development", "sealed"]);
		expect(runtime.suiteCalls.slice(0, 2).every((call) => call.target.datasetHash !== corpus.metadata.hash)).toBe(true);
		for (const call of runtime.suiteCalls.slice(2)) {
			expect(call.target.datasetHash).toBe(corpus.metadata.hash);
			expect(call.target.manifest.evalSuite.dataset).toBe(`sealed-${corpus.metadata.id}.jsonl`);
			expect(call.target.tasks.map((task) => task.id)).toEqual(["sealed-task-1", "sealed-task-2"]);
			expect(call.target.tasks.every((task) => task.graders === task.effectiveGraders)).toBe(false);
			expect(call.target.tasks.every((task) => task.effectiveGraders.length > 0)).toBe(true);
		}

		const holdout = result.sealedHoldout;
		expect(holdout).not.toBeNull();
		if (!holdout) throw new Error("expected sealed holdout result");
		expect(holdout).toMatchObject({
			corpusId: corpus.metadata.id,
			corpusHash: corpus.metadata.hash,
			baselineReused: false,
		});
		expect(holdout.baseline.target.gitSha).toBe(repository.baselineSha);
		expect(holdout.candidate.target.gitSha).toBe(repository.candidateSha);
		expect(holdout.candidate.baselineEvalRunId).toBe(holdout.baseline.evalRunId);
		const finalEvent = result.record.events.at(-1);
		expect(finalEvent?.type).toBe("evaluated");
		if (finalEvent?.type === "evaluated") {
			expect(finalEvent.evaluation.sealedHoldout).toMatchObject({
				baseline: {
					evalRunId: holdout.baseline.evalRunId,
					harness: { sha: repository.baselineSha },
				},
				candidate: {
					evalRunId: holdout.candidate.evalRunId,
					harness: { sha: repository.candidateSha },
				},
				comparison: {
					schemaVersion: 2,
					algorithmId: EXACT_COMPARISON_GATE_ALGORITHM_ID,
					policyId: SEALED_GATE_POLICY_ID,
				},
			});
		}
		for (const record of [result.baseline, result.candidate, holdout.baseline, holdout.candidate]) {
			expect(loadVerifiedEvalRun(repository.runsRoot, record.evalRunId).hasRunHashes).toBe(true);
		}
		expect(result.designHash).toBe(hashValue({
			schemaVersion: 1,
			baseline: { ref: repository.baselineSha, sha: repository.baselineSha },
			candidate: { ref: repository.candidateSha, sha: repository.candidateSha },
			mode: "candidate",
			repetitions: 2,
			dataset: "evals/development.jsonl",
			scopePolicy: CANDIDATE_SCOPE_POLICY,
			sealedCorpus: { id: corpus.metadata.id, hash: corpus.metadata.hash },
		}));

		const metadataPaths = [
			result.candidateRecordPath,
			...[
				result.baseline,
				result.candidate,
				holdout.baseline,
				holdout.candidate,
			].map((record) => join(repository.runsRoot, record.evalRunId, "eval_run.json")),
		];
		for (const path of metadataPaths) {
			const json = readFileSync(path, "utf8");
			expect(json).not.toContain(corpus.input);
			expect(json).not.toContain(corpus.name);
			expect(json).not.toContain(corpus.stateRoot);
		}
		const holdoutMetadata = readFileSync(
			join(repository.runsRoot, holdout.baseline.evalRunId, "eval_run.json"),
			"utf8",
		);
		expect(holdoutMetadata).toContain(corpus.metadata.id);
		expect(holdoutMetadata).toContain(corpus.metadata.hash);
		for (const path of runtime.targetPaths) expect(existsSync(path)).toBe(false);
		assertCheckoutUnchanged(repository);
	});

	it("reuses development and holdout baselines only through two exact provenance queries", async () => {
		const repository = createRepository({ path: "AGENTS.md", content: "candidate harness\n" });
		const corpus = corpusFixture("sealed");
		const runtime = fakeRuntime({ reuseBaseline: true });

		const result = await runCandidateExperiment(
			{
				repositoryDir: repository.dir,
				runsRoot: repository.runsRoot,
				baselineRef: repository.baselineSha,
				candidateRef: repository.candidateSha,
				mode: "candidate",
				repetitions: 3,
				candidateId: "candidate-two-reuse-queries",
				sealedCorpus: corpus.ref,
			},
			runtime.dependencies,
		);

		expect(runtime.reuseQueries).toHaveLength(2);
		for (const query of runtime.reuseQueries) {
			expect(query).toMatchObject({
				targetId: "test-target",
				targetGitSha: repository.baselineSha,
				label: "baseline",
				repetitions: 3,
			});
		}
		expect(runtime.reuseQueries.map((query) => query.evidenceVisibility)).toEqual(["development", "sealed"]);
		expect(runtime.reuseQueries[0]?.provenance.datasetHash).not.toBe(corpus.metadata.hash);
		expect(runtime.reuseQueries[1]?.provenance.datasetHash).toBe(corpus.metadata.hash);
		expect(runtime.reuseQueries[1]?.provenance.suiteHash).not.toBe(
			runtime.reuseQueries[0]?.provenance.suiteHash,
		);
		expect(runtime.suiteCalls.map((call) => call.options.label)).toEqual(["candidate", "candidate"]);
		expect(runtime.suiteCalls[1]?.options.baselineEvalRunId).toBe("eval-reused-baseline-2");
		expect(result.baselineReused).toBe(true);
		expect(result.sealedHoldout?.baselineReused).toBe(true);
		assertCheckoutUnchanged(repository);
	});

	it("fails closed on a per-task sealed regression and keeps durable state validated", async () => {
		const repository = createRepository({ path: "AGENTS.md", content: "candidate harness\n" });
		const corpus = corpusFixture("sealed");
		const runtime = fakeRuntime({ comparisonDeltas: [0, -1] });
		const candidateId = "candidate-holdout-regression";
		const path = join(repository.runsRoot, "candidates", candidateId, "candidate.json");

		await expect(
			runCandidateExperiment(
				{
					repositoryDir: repository.dir,
					runsRoot: repository.runsRoot,
					baselineRef: repository.baselineSha,
					candidateRef: repository.candidateSha,
					mode: "candidate",
					repetitions: 1,
					candidateId,
					sealedCorpus: corpus.ref,
				},
				runtime.dependencies,
			),
		).rejects.toThrow(/sealed holdout regressed task.*forced-task/);

		expect(runtime.suiteCalls).toHaveLength(4);
		expect(runtime.compareModes).toEqual(["candidate", "candidate"]);
		expect(candidateStatus(readJsonArtifact(path, CandidateRecordSchema))).toBe("validated");
		assertCheckoutUnchanged(repository);
	});

	it("records a regressed sealed pair in A/A mode without treating it as a candidate gate", async () => {
		const repository = createRepository();
		const corpus = corpusFixture("sealed");
		const runtime = fakeRuntime({ comparisonDeltas: [0, -1] });

		const result = await runCandidateExperiment(
			{
				repositoryDir: repository.dir,
				runsRoot: repository.runsRoot,
				baselineRef: repository.baselineSha,
				candidateRef: repository.baselineSha,
				mode: "aa-calibration",
				repetitions: 1,
				candidateId: "candidate-aa-sealed-regression",
				sealedCorpus: corpus.ref,
			},
			runtime.dependencies,
		);

		expect(result.sealedHoldout?.compare.summary.delta).toBe(-1);
		expect(candidateStatus(result.record)).toBe("evaluated");
		expect(runtime.compareModes).toEqual(["aa-calibration", "aa-calibration"]);
		assertCheckoutUnchanged(repository);
	});

	it("runs A/A on the same exact revision with an empty diff", async () => {
		const repository = createRepository({ path: "AGENTS.md", content: "later checkout\n" });
		const runtime = fakeRuntime();

		const result = await runCandidateExperiment(
			{
				repositoryDir: repository.dir,
				runsRoot: repository.runsRoot,
				baselineRef: repository.baselineSha,
				candidateRef: repository.baselineSha,
				mode: "aa-calibration",
				repetitions: 2,
				candidateId: "candidate-aa",
			},
			runtime.dependencies,
		);

		expect(result.changedFiles).toEqual([]);
		expect(result.baseline.target.gitSha).toBe(repository.baselineSha);
		expect(result.candidate.target.gitSha).toBe(repository.baselineSha);
		expect(runtime.suiteCalls.map((call) => call.options.label)).toEqual(["baseline", "candidate"]);
		expect(runtime.compareModes).toEqual(["aa-calibration"]);
		expect(result.record.mode).toBe("aa-calibration");
		expect(candidateStatus(result.record)).toBe("evaluated");
		assertCheckoutUnchanged(repository);
	});

	it("leaves durable state at validated when comparison is invalid", async () => {
		const repository = createRepository({ path: "skills/check-dbo/SKILL.md", content: "candidate skill\n" });
		const runtime = fakeRuntime({ compareStatus: "invalid" });
		const candidateId = "candidate-invalid";
		const path = join(repository.runsRoot, "candidates", candidateId, "candidate.json");

		await expect(
			runCandidateExperiment(
				{
					repositoryDir: repository.dir,
					runsRoot: repository.runsRoot,
					baselineRef: repository.baselineSha,
					candidateRef: repository.candidateSha,
					mode: "candidate",
					repetitions: 1,
					candidateId,
				},
				runtime.dependencies,
			),
		).rejects.toBeInstanceOf(CandidateExperimentError);

		expect(candidateStatus(readJsonArtifact(path, CandidateRecordSchema))).toBe("validated");
		assertCheckoutUnchanged(repository);
	});

	it("treats infrastructure errors as inconclusive and never appends Evaluated", async () => {
		const repository = createRepository({ path: "bin/check_dbo", content: "#!/bin/sh\necho candidate\n" });
		const runtime = fakeRuntime({ baselineErrors: 1 });
		const candidateId = "candidate-infrastructure";
		const path = join(repository.runsRoot, "candidates", candidateId, "candidate.json");

		await expect(
			runCandidateExperiment(
				{
					repositoryDir: repository.dir,
					runsRoot: repository.runsRoot,
					baselineRef: repository.baselineSha,
					candidateRef: repository.candidateSha,
					mode: "candidate",
					repetitions: 1,
					candidateId,
				},
				runtime.dependencies,
			),
		).rejects.toThrow(/infrastructure error/);

		expect(runtime.suiteCalls).toHaveLength(1);
		expect(runtime.compareModes).toHaveLength(0);
		expect(candidateStatus(readJsonArtifact(path, CandidateRecordSchema))).toBe("validated");
		assertCheckoutUnchanged(repository);
	});

	it("binds exact comparison gate evidence to ordered final RunArtifact hashes and rejects legacy indexes", async () => {
		const repository = createRepository({ path: "AGENTS.md", content: "candidate harness\n" });
		const runtime = fakeRuntime();

		const result = await runCandidateExperiment(
			{
				repositoryDir: repository.dir,
				runsRoot: repository.runsRoot,
				baselineRef: repository.baselineSha,
				candidateRef: repository.candidateSha,
				mode: "candidate",
				repetitions: 2,
				candidateId: "candidate-exact-gate",
			},
			runtime.dependencies,
		);

		// The persisted indexes anchor their final run.json records exactly as runSuite does.
		for (const evalRun of [result.baseline, result.candidate]) {
			const verified = loadVerifiedEvalRun(repository.runsRoot, evalRun.evalRunId);
			expect(verified.hasRunHashes).toBe(true);
			expect(verified.record.taskIds).toEqual(["task_001", "task_002"]);
			expect(verified.runs).toHaveLength(2 * evalRun.repetitions);
			expect(verified.record.runArtifacts).toEqual(
				verified.runs.map((run) => ({ runId: run.runId, sha256: hashValue(run) })),
			);
		}

		const evaluated = result.record.events.at(-1);
		if (evaluated?.type !== "evaluated") throw new Error("expected evaluated event");
		const evidence = evaluated.evaluation.development.comparison;
		if (!evidence || !("algorithmId" in evidence)) throw new Error("expected exact v2 comparison evidence");
		expect(evidence).toMatchObject({
			schemaVersion: 2,
			algorithmId: EXACT_COMPARISON_GATE_ALGORITHM_ID,
			policyId: DEVELOPMENT_GATE_POLICY_ID,
		});
		expect(evidence.evidenceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(evidence).toEqual(comparisonGateEvidence(result.compare, DEVELOPMENT_GATE_POLICY_ID));

		// Replacing one final RunArtifact hash changes the evidence and gate hashes without touching the row digest.
		const candidateArtifacts = result.candidate.runArtifacts;
		if (!candidateArtifacts) throw new Error("expected candidate run artifacts");
		const tampered = comparisonGateEvidence(
			{
				...result.compare,
				b: {
					...result.candidate,
					runArtifacts: candidateArtifacts.map((artifact, index) =>
						index === 0 ? { ...artifact, sha256: hashValue({ tampered: artifact.runId }) } : artifact),
				},
			},
			DEVELOPMENT_GATE_POLICY_ID,
		);
		if (!("algorithmId" in tampered)) throw new Error("expected exact v2 comparison evidence");
		expect(tampered.comparisonHash).toBe(evidence.comparisonHash);
		expect(tampered.evidenceHash).not.toBe(evidence.evidenceHash);
		expect(tampered.gateHash).not.toBe(evidence.gateHash);

		// Legacy v1 indexes without ordered final RunArtifact hashes are never promotion-grade evidence.
		const { runArtifacts: _legacyBaselineArtifacts, ...legacyBaseline } = result.baseline;
		const { runArtifacts: _legacyCandidateArtifacts, ...legacyCandidate } = result.candidate;
		expect(() => comparisonGateEvidence({ ...result.compare, a: legacyBaseline }, DEVELOPMENT_GATE_POLICY_ID))
			.toThrow(/exact comparison gate requires ordered final RunArtifact hashes/);
		expect(() => comparisonGateEvidence({ ...result.compare, b: legacyCandidate }, DEVELOPMENT_GATE_POLICY_ID))
			.toThrow(/exact comparison gate requires ordered final RunArtifact hashes/);
		assertCheckoutUnchanged(repository);
	});
});
