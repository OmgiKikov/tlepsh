import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCorpus } from "../src/corpus.js";
import { loadTarget, ModelBlock, scaffoldTarget, type ResolvedTarget } from "../src/manifest.js";
import { compareVerifiedEvalRuns } from "../src/compare.js";
import { listEvalRuns, writeEvalRun, type EvalRunRecord, type RunSuiteOptions } from "../src/eval.js";
import { executionFingerprint, hashFile, hashValue, modelFingerprint, provenanceAxes, RunRecordSchema } from "../src/provenance.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";
import { startMockModel } from "../src/mock-model.js";
import * as modelExperimentSource from "../src/application/model-experiment-source.js";
import { fastForwardReviewedModel } from "../src/application/model-experiment-ref-guard.js";
import {
	applyModelChange, describeModelChange, listModelExperiments, loadModelExperiment, loadModelExperimentEval,
	modelExperimentDirectory, planModelExperiment, runModelExperiment,
} from "../src/application/model-experiment.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(dir: string, ...args: string[]) {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(taskCount = 15, repetitions = 2) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ahde-model-experiment-test-")));
	roots.push(root);
	const targetDir = join(root, "target");
	scaffoldTarget(resolve("templates/basic-agent"), targetDir);
	const manifestPath = join(targetDir, "manifest.yaml");
	const manifest = parse(readFileSync(manifestPath, "utf8"));
	const model = ModelBlock.parse({ ...manifest.model, provider: "mock", id: "baseline-model", spec: { cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } });
	manifest.model = model;
	writeFileSync(manifestPath, stringify(manifest));
	git(targetDir, "add", "manifest.yaml");
	git(targetDir, "-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "Configure actual model");
	const stateRoot = join(root, "state");
	const corpus = createCorpus({ stateRoot, projectId: "project", name: "development", visibility: "development",
		tasks: Array.from({ length: taskCount }, (_, index) => ({ id: `case-${index}`, input: `Input ${index}`, graders: [{ type: "output_contains", text: "done" }] })) });
	const options = { targetDir, runsRoot: join(root, "runs"), corpus: { stateRoot, projectId: "project", corpusId: corpus.id },
		selections: [{ provider: "mock", modelId: "alternative" }], resolveTargetModel: (selection: { modelId: string }) => ({ ...model, id: selection.modelId }),
		repetitions, executionBudget: 1000, qualityTolerance: 0.05, objective: "cost" as const };
	return { ...options, options, root, model, manifestPath };
}

function runner(options: { score?: (modelId: string, taskId: string, repetitionIndex: number) => number; evaluatorCalls?: boolean; observe?: (target: ResolvedTarget, options: RunSuiteOptions) => void } = {}) {
	let arm = 0;
	return vi.fn(async (target: ResolvedTarget, runOptions: RunSuiteOptions): Promise<EvalRunRecord> => {
		options.observe?.(target, runOptions);
		const evalRunId = `erun_model_fixture_${arm++}`;
		const model = modelFingerprint(target.manifest.model);
		const execution = executionFingerprint("isolated");
		const evaluation = { suiteId: target.manifest.evalSuite.id, dataset: target.manifest.evalSuite.dataset.replace(/\.jsonl$/, "").split("/").pop()!, suiteHash: target.suiteHash, datasetHash: target.datasetHash };
		const targetIdentity = { id: target.manifest.id, gitSha: target.gitSha, toolsetHash: target.toolsetHash, preparedToolHomeHash: hashValue("stable prepared tools") };
		const runs = target.tasks.flatMap((task) => Array.from({ length: runOptions.repetitions }, (_, repetitionIndex) => {
			const runId = `${evalRunId}_${task.id}_${repetitionIndex}`;
			const runDir = join(runOptions.runsRoot, runId);
			mkdirSync(runDir, { recursive: true });
			const trace = `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`;
			writeFileSync(join(runDir, "session.jsonl"), trace);
			const score = options.score?.(model.id, task.id, repetitionIndex) ?? 1;
			const record = RunRecordSchema.parse({ schemaVersion: 1, runId, taskId: task.id, repetitionIndex,
				label: "solo", status: "completed", error: null, startedAt: "2026-09-05T10:00:00.000Z", finishedAt: "2026-09-05T10:00:01.000Z",
				target: targetIdentity, runtime: target.runtime, model, execution, eval: evaluation,
				trace: { path: "session.jsonl", sessionId: null, sha256: hashFile(trace) },
				metrics: { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, costUsd: model.id === "baseline-model" ? 1 : 0.25,
					...(options.evaluatorCalls ? { judge: { calls: 1, tokens: 5, costUsd: 0.1 } } : {}),
					latencyMs: model.id === "baseline-model" ? 1200 : 700, toolCalls: 0, toolErrors: 0, recoveryAttempts: 0 },
				evalResults: { outcome: score === 1 ? "pass" : "fail", graders: [{ name: "required output", type: "output_contains", passed: score === 1, score, reason: "fixture measurement" }] },
				parent: { evalRunId, candidateOf: null } });
			writeJsonArtifact(join(runDir, "run.json"), RunRecordSchema, record);
			return record;
		}));
		const provenance = provenanceAxes({ runtime: target.runtime, model, execution, eval: evaluation });
		const pass = runs.filter((run) => run.evalResults?.outcome === "pass").length;
		const record: EvalRunRecord = { schemaVersion: 3, purpose: "model-experiment", evalRunId, target: targetIdentity,
			label: "solo", baselineEvalRunId: null, provenance, provenanceKey: hashValue(provenance), ...evaluation, evidenceVisibility: "development",
			taskIds: target.tasks.map((task) => task.id), repetitions: runOptions.repetitions, runIds: runs.map((run) => run.runId),
			runArtifacts: runs.map((run) => ({ runId: run.runId, sha256: hashValue(run) })), startedAt: "2026-09-05T10:00:00.000Z", finishedAt: "2026-09-05T10:00:02.000Z",
			summary: { total: runs.length, pass, fail: runs.length - pass, error: 0, allPassRate: pass / runs.length } };
		writeEvalRun(runOptions.runsRoot, record);
		return record;
	});
}

async function execute(value: ReturnType<typeof fixture>, dependency = runner()) {
	const plan = planModelExperiment(value.options);
	return runModelExperiment({ targetDir: value.targetDir, runsRoot: value.runsRoot, plan, expectedPlanHash: plan.planHash, actorId: "human" }, { runSuite: dependency });
}

describe("model experiment boundary", () => {
	it("executes both pinned models through the real Pi runner against a local endpoint", async () => {
		const f = fixture(1, 1);
		const mock = await startMockModel([{ steps: [{ text: "done" }] }]);
		const previousKey = process.env.AHDE_MODEL_API_KEY;
		process.env.AHDE_MODEL_API_KEY = "local-test-key";
		try {
			const manifest = parse(readFileSync(f.manifestPath, "utf8"));
			manifest.model.baseUrl = mock.url;
			writeFileSync(f.manifestPath, stringify(manifest));
			git(f.targetDir, "add", "manifest.yaml");
			git(f.targetDir, "-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "Pin local endpoint");
			f.options.resolveTargetModel = (selection) => ({ ...f.model, baseUrl: mock.url, id: selection.modelId });
			const plan = planModelExperiment(f.options);
			const result = await runModelExperiment({ ...f, plan, expectedPlanHash: plan.planHash, actorId: "human" });
			expect(result.status).toBe("completed");
			expect(result.arms.map((arm) => ({ status: arm.status, score: arm.meanScore }))).toEqual([{ status: "completed", score: 1 }, { status: "completed", score: 1 }]);
			expect(mock.requests()).toBe(2);
			expect(loadTarget(f.targetDir).manifest.model.id).toBe("baseline-model");
		} finally {
			if (previousKey === undefined) delete process.env.AHDE_MODEL_API_KEY;
			else process.env.AHDE_MODEL_API_KEY = previousKey;
			await mock.close();
		}
	}, 30_000);

	it("runs the same pinned design in private snapshots, ranks measured resources and never changes the checkout or release evidence", async () => {
		const f = fixture();
		const before = git(f.targetDir, "rev-parse", "HEAD");
		const original = readFileSync(f.manifestPath, "utf8");
		const run = runner({ observe(target, options) {
			expect(target.dir).not.toBe(f.targetDir);
			expect(options).toMatchObject({ jobs: 1, purpose: "model-experiment", evidenceVisibility: "development", repetitions: 2 });
			expect(readFileSync(f.manifestPath, "utf8")).toBe(original);
		} });
		const result = await execute(f, run);
		expect(result).toMatchObject({ status: "completed", recommendedArmId: "model-1", frontierArmIds: ["model-1"], evaluatorOverhead: "none", targetCostUsd: 37.5 });
		expect(result.arms[1]).toMatchObject({ meanScore: 1, passRate: 1, targetCostUsd: 7.5, quality: { withinTolerance: true, summary: { confidence95: { low: 0, high: 0 } } } });
		expect(run).toHaveBeenCalledTimes(2);
		expect(git(f.targetDir, "rev-parse", "HEAD")).toBe(before);
		expect(git(f.targetDir, "status", "--porcelain")).toBe("");
		expect(listEvalRuns(f.runsRoot)).toEqual([]);
		const a = loadModelExperimentEval(f.runsRoot, result.id, result.arms[0]!.evalRunId!);
		const b = loadModelExperimentEval(f.runsRoot, result.id, result.arms[1]!.evalRunId!);
		expect(compareVerifiedEvalRuns(a, b, { mode: "candidate" }).status).toBe("invalid");
		expect(loadModelExperiment(f.runsRoot, result.id)).toEqual(result);
	});

	it("rejects excess budget, duplicate models, stale branch consent and replayed execution before spend", async () => {
		const f = fixture();
		expect(() => planModelExperiment({ ...f.options, executionBudget: 59 })).toThrow(/budget/);
		expect(() => planModelExperiment({ ...f.options, selections: [{ provider: "mock", modelId: "baseline-model" }] })).toThrow(/unique/);
		const plan = planModelExperiment(f.options);
		expect(planModelExperiment({ ...f.options, id: plan.id })).toEqual(plan);
		const unauthorized = runner();
		await expect(runModelExperiment({ ...f, runsRoot: join(f.root, "another-store"), plan, expectedPlanHash: plan.planHash, actorId: "human" }, { runSuite: unauthorized })).rejects.toThrow(/another Target or evidence store/);
		expect(unauthorized).not.toHaveBeenCalled();
		git(f.targetDir, "checkout", "-b", "other-branch");
		const run = runner();
		await expect(runModelExperiment({ ...f, plan, expectedPlanHash: plan.planHash, actorId: "human" }, { runSuite: run })).rejects.toThrow(/changed/);
		expect(run).not.toHaveBeenCalled();
		const fresh = planModelExperiment(f.options);
		await runModelExperiment({ ...f, plan: fresh, expectedPlanHash: fresh.planHash, actorId: "human" }, { runSuite: run });
		await expect(runModelExperiment({ ...f, plan: fresh, expectedPlanHash: fresh.planHash, actorId: "human" }, { runSuite: run })).rejects.toThrow();
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("refuses a competing model that would grade itself, while allowing a fixed independent judge", () => {
		const f = fixture();
		const manifest = parse(readFileSync(f.manifestPath, "utf8"));
		manifest.evalSuite.judge = { ...f.model, id: "alternative" };
		writeFileSync(f.manifestPath, stringify(manifest));
		git(f.targetDir, "add", "manifest.yaml");
		git(f.targetDir, "-c", "user.name=Test", "-c", "user.email=test@test.local", "commit", "-m", "Configure independent instrument");
		expect(() => planModelExperiment(f.options)).toThrow(/separate judge/);
		expect(planModelExperiment({ ...f.options, selections: [{ provider: "mock", modelId: "third-model" }] }).models).toHaveLength(2);
	});

	it("keeps an underpowered comparison inspectable without recommending a winner", async () => {
		const result = await execute(fixture(1, 1));
		expect(result.recommendedArmId).toBeNull();
		expect(result.arms[1]!.quality?.withinTolerance).toBe(false);
		expect(result.arms[1]!.meanScore).toBe(1);
	});

	it("does not recommend a cheap model outside the tolerance and retains reproducible regressing pairs", async () => {
		const result = await execute(fixture(), runner({ score: (model) => model === "alternative" ? 0 : 1 }));
		expect(result.recommendedArmId).toBe("baseline");
		expect(result.arms[1]!.quality).toMatchObject({ withinTolerance: false, verdict: "regressed", omittedRegressions: 0 });
		expect(result.arms[1]!.quality!.regressions).toHaveLength(15);
	});

	it("links a regression to its worst matched repetition, including a failure only in the last repeat", async () => {
		const result = await execute(fixture(), runner({ score: (model, task, repetition) => model === "alternative" && task === "case-0" && repetition === 1 ? 0 : 1 }));
		expect(result.arms[1]!.quality!.regressions[0]).toMatchObject({ taskId: "case-0", scoreDelta: -0.5,
			baselineRunId: "erun_model_fixture_0_case-0_1", candidateRunId: "erun_model_fixture_1_case-0_1" });
	});

	it("treats all-zero rate metadata as unknown, not a free winner", async () => {
		const f = fixture();
		f.options.resolveTargetModel = (selection) => ({ ...f.model, id: selection.modelId, spec: { ...f.model.spec, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
		const result = await execute(f);
		expect(result.arms[1]).toMatchObject({ targetCostUsd: null, dominated: null });
		expect(result.targetCostUsd).toBeNull();
		expect(result.recommendedArmId).toBe("baseline");
	});

	it("keeps actual evaluator calls explicitly unverified outside Target cost", async () => {
		const result = await execute(fixture(), runner({ evaluatorCalls: true }));
		expect(result).toMatchObject({ evaluatorOverhead: "unverified", targetCostUsd: 37.5 });
	});

	it("records cancellation after a completed arm and never launches later alternatives", async () => {
		const f = fixture();
		const controller = new AbortController();
		const run = runner({ observe: () => controller.abort() });
		const plan = planModelExperiment(f.options);
		const result = await runModelExperiment({ ...f, plan, expectedPlanHash: plan.planHash, actorId: "human", signal: controller.signal }, { runSuite: run });
		expect(result.status).toBe("stopped");
		expect(result.arms.map((arm) => arm.status)).toEqual(["completed", "stopped"]);
		expect(result.recommendedArmId).toBeNull();
		expect(run).toHaveBeenCalledTimes(1);
		expect(loadModelExperiment(f.runsRoot, result.id).status).toBe("stopped");
	});

	it("records failed startup without fabricating successful or zero-cost arms", async () => {
		const f = fixture();
		const run = vi.fn(async () => { throw new Error("provider unavailable"); });
		const result = await execute(f, run);
		expect(result).toMatchObject({ status: "failed", targetCostUsd: null, recommendedArmId: null });
		expect(result.arms[0]).toMatchObject({ status: "failed", error: "provider unavailable", meanScore: null });
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("refuses tampered evidence, unrelated member ids and cross-project loading", async () => {
		const f = fixture();
		const other = fixture();
		const result = await execute(f);
		expect(() => loadModelExperiment(f.runsRoot, result.id, { targetDir: other.targetDir })).toThrow(/another/);
		expect(listModelExperiments(f.runsRoot, { targetDir: other.targetDir })).toEqual([]);
		expect(listModelExperiments(f.runsRoot, { targetDir: f.targetDir, stateRoot: other.corpus.stateRoot, projectId: "project" })).toEqual([]);
		expect(() => loadModelExperiment(f.runsRoot, result.id, { targetDir: f.targetDir, stateRoot: other.corpus.stateRoot })).toThrow(/project scope/);
		expect(() => loadModelExperimentEval(f.runsRoot, result.id, result.arms[0]!.evalRunId!, { projectId: "another-project" })).toThrow(/project scope/);
		expect(() => loadModelExperimentEval(f.runsRoot, result.id, "sealed-unrelated")).toThrow(/member/);
		const baseline = loadModelExperimentEval(f.runsRoot, result.id, result.arms[0]!.evalRunId!);
		const path = join(modelExperimentDirectory(f.runsRoot, result.id), "evals", baseline.runs[0]!.runId, "run.json");
		const record = JSON.parse(readFileSync(path, "utf8"));
		record.metrics.costUsd = 0;
		writeFileSync(path, JSON.stringify(record));
		expect(() => loadModelExperiment(f.runsRoot, result.id)).toThrow(/hash/);
	});

	it("rejects a redirected experiment storage directory", () => {
		const f = fixture();
		mkdirSync(f.runsRoot);
		symlinkSync(f.root, join(f.runsRoot, "model-experiments"));
		expect(() => modelExperimentDirectory(f.runsRoot, `model-experiment-${"a".repeat(24)}`)).toThrow(/regular/);
	});

	it("rejects a sealed index before opening or naming any of its private members", async () => {
		const f = fixture(1, 1);
		const result = await execute(f);
		const directory = modelExperimentDirectory(f.runsRoot, result.id);
		const indexPath = join(directory, "evals", result.arms[0]!.evalRunId!, "eval_run.json");
		const index = JSON.parse(readFileSync(indexPath, "utf8"));
		index.purpose = "evidence";
		index.evidenceVisibility = "sealed";
		index.runIds = ["run_SEALED_MEMBER_CANARY"];
		index.runArtifacts = [{ runId: "run_SEALED_MEMBER_CANARY", sha256: `sha256:${"a".repeat(64)}` }];
		writeFileSync(indexPath, JSON.stringify(index));
		const statePath = join(directory, "experiment.json");
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		state.arms[0].evalHash = hashValue(index);
		writeFileSync(statePath, JSON.stringify(state));
		let error = "";
		try { loadModelExperiment(f.runsRoot, result.id); } catch (caught) { error = String(caught); }
		expect(error).toContain("does not match its pinned evidence");
		expect(error).not.toContain("SEALED_MEMBER_CANARY");
	});

	it("refuses internally valid arms with different prepared tool bytes before giving quality, frontier or acceptance", async () => {
		const f = fixture(1, 1);
		const result = await execute(f);
		const directory = modelExperimentDirectory(f.runsRoot, result.id);
		const indexPath = join(directory, "evals", result.arms[1]!.evalRunId!, "eval_run.json");
		const index = JSON.parse(readFileSync(indexPath, "utf8"));
		index.target.preparedToolHomeHash = hashValue("different effective setup output");
		for (const artifact of index.runArtifacts) {
			const path = join(directory, "evals", artifact.runId, "run.json");
			const record = JSON.parse(readFileSync(path, "utf8"));
			record.target.preparedToolHomeHash = index.target.preparedToolHomeHash;
			artifact.sha256 = hashValue(record);
			writeFileSync(path, JSON.stringify(record));
		}
		writeFileSync(indexPath, JSON.stringify(index));
		const statePath = join(directory, "experiment.json");
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		state.arms[1].evalHash = hashValue(index);
		writeFileSync(statePath, JSON.stringify(state));
		expect(() => loadModelExperiment(f.runsRoot, result.id)).toThrow(/effective tools changed/);
		expect(() => describeModelChange({ ...f, experimentId: result.id, armId: "model-1" })).toThrow(/effective tools changed/);
	});

	it("commits only an exactly reviewed model change and preserves experiment history without releasing it", async () => {
		const f = fixture();
		const result = await execute(f);
		const subject = describeModelChange({ ...f, experimentId: result.id, armId: "model-1" });
		expect(subject.diff).toContain("@@");
		expect(subject.diff).toContain("-  id: baseline-model");
		expect(subject.diff).not.toContain("-evalSuite:");
		const before = loadTarget(f.targetDir).manifest;
		const receipt = applyModelChange({ ...f, subject, expectedSubjectHash: subject.subjectHash, actorId: "human", reason: "Measured cost within my tolerance" });
		expect(receipt.configuredTargetSha).toBe(git(f.targetDir, "rev-parse", "HEAD"));
		expect(git(f.targetDir, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe("manifest.yaml");
		expect({ ...loadTarget(f.targetDir).manifest, model: null }).toEqual({ ...before, model: null });
		expect(loadTarget(f.targetDir).manifest.model.id).toBe("alternative");
		expect(git(f.targetDir, "tag", "--list")).toBe("");
		expect(loadModelExperiment(f.runsRoot, result.id)).toEqual(result);
		expect(() => applyModelChange({ ...f, subject, expectedSubjectHash: subject.subjectHash, actorId: "human", reason: "Replay" })).toThrow(/already/);
	});

	it("refuses branch-switched and edited model acceptance without mutating the checkout", async () => {
		const f = fixture();
		const result = await execute(f);
		const subject = describeModelChange({ ...f, experimentId: result.id, armId: "model-1" });
		git(f.targetDir, "checkout", "-b", "new-branch");
		expect(() => applyModelChange({ ...f, subject, expectedSubjectHash: subject.subjectHash, actorId: "human", reason: "Stale" })).toThrow(/changed/);
		expect(loadTarget(f.targetDir).manifest.model.id).toBe("baseline-model");
		expect(() => describeModelChange({ ...f, experimentId: result.id, armId: "baseline" })).toThrow(/alternative/);
	});

	it("refuses a same-SHA branch switch after freshness checking, under Git's actual reference transaction", async () => {
		const f = fixture(1, 1);
		const result = await execute(f);
		const subject = describeModelChange({ ...f, experimentId: result.id, armId: "model-1" });
		const original = readFileSync(f.manifestPath, "utf8");
		git(f.targetDir, "branch", "unapproved-same-sha");
		const originalGit = modelExperimentSource.modelExperimentGit;
		let switched = false;
		vi.spyOn(modelExperimentSource, "modelExperimentGit").mockImplementation((dir, args, input, env) => {
			if (args.includes("merge")) {
				switched = true;
				git(f.targetDir, "checkout", "unapproved-same-sha");
			}
			return originalGit(dir, args, input, env);
		});
		expect(() => applyModelChange({ ...f, subject, expectedSubjectHash: subject.subjectHash, actorId: "human", reason: "Exact model choice" })).toThrow(/model selection reference update differs from the approved branch and revision/);
		expect(switched).toBe(true);
		expect(git(f.targetDir, "rev-parse", subject.headRef)).toBe(subject.baseSha);
		expect(git(f.targetDir, "rev-parse", "refs/heads/unapproved-same-sha")).toBe(subject.baseSha);
		expect(git(f.targetDir, "symbolic-ref", "HEAD")).toBe("refs/heads/unapproved-same-sha");
		expect(readFileSync(f.manifestPath, "utf8")).toBe(original);
		expect(git(f.targetDir, "status", "--porcelain")).toBe("");
	});

	it("fails closed before a fast-forward when Git ignores the reference-transaction hook", async () => {
		const f = fixture(1, 1);
		const result = await execute(f);
		const subject = describeModelChange({ ...f, experimentId: result.id, armId: "model-1" });
		const originalGit = modelExperimentSource.modelExperimentGit;
		let merged = false;
		vi.spyOn(modelExperimentSource, "modelExperimentGit").mockImplementation((dir, args, input, env) => {
			if (args.includes("update-ref") && args.includes("--stdin")) return "";
			if (args.includes("merge")) merged = true;
			return originalGit(dir, args, input, env);
		});
		expect(() => applyModelChange({ ...f, subject, expectedSubjectHash: subject.subjectHash, actorId: "human", reason: "Exact model choice" })).toThrow(/requires Git reference-transaction hook support/);
		expect(merged).toBe(false);
		expect(git(f.targetDir, "rev-parse", "HEAD")).toBe(subject.baseSha);
		expect(loadTarget(f.targetDir).manifest.model.id).toBe("baseline-model");
	});

	it("accepts legacy log-only HEAD only with the same transaction's exact approved branch update", () => {
		const f = fixture(1, 1);
		const hooksPath = join(f.root, "legacy-transaction-hooks");
		mkdirSync(hooksPath);
		const baseSha = git(f.targetDir, "rev-parse", "HEAD");
		const headRef = git(f.targetDir, "symbolic-ref", "HEAD");
		const revision = "f".repeat(40);
		const zero = "0".repeat(40);
		const originalGit = modelExperimentSource.modelExperimentGit;
		let tested = false;
		vi.spyOn(modelExperimentSource, "modelExperimentGit").mockImplementation((dir, args, input, env) => {
			if (!args.includes("merge")) return originalGit(dir, args, input, env);
			tested = true;
			const invoke = (transaction: string) => spawnSync(join(hooksPath, "reference-transaction"), ["prepared"], {
				cwd: f.targetDir, env, input: transaction, encoding: "utf8",
			}).status;
			const branch = `${baseSha} ${revision} ${headRef}\n`;
			// Git 2.39 exposes the log-only HEAD entry; newer Git omits it.
			expect(invoke(`${zero} ${revision} HEAD\n${branch}`)).toBe(0);
			expect(invoke(`${branch}${baseSha} ${revision} HEAD\n`)).toBe(0);
			expect(invoke(`${zero} ${revision} HEAD\n`)).not.toBe(0);
			expect(invoke(`${zero} ${revision} HEAD\n${baseSha} ${revision} refs/heads/unapproved\n`)).not.toBe(0);
			expect(invoke(`${baseSha} ${baseSha} HEAD\n${branch}`)).not.toBe(0);
			expect(invoke(`${revision} ${revision} HEAD\n${branch}`)).not.toBe(0);
			expect(invoke(`${zero} ${revision} HEAD\n${zero} ${revision} ${headRef}\n`)).not.toBe(0);
			return "";
		});
		fastForwardReviewedModel({ targetDir: f.targetDir, hooksPath, headRef, baseSha, revision });
		expect(tested).toBe(true);
		expect(git(f.targetDir, "rev-parse", "HEAD")).toBe(baseSha);
	});

	it("rejects changed source bytes after plan confirmation before starting a private run", async () => {
		const f = fixture();
		const plan = planModelExperiment(f.options);
		writeFileSync(join(f.targetDir, "AGENTS.md"), "Changed instructions after consent");
		const run = runner();
		await expect(runModelExperiment({ ...f, plan, expectedPlanHash: plan.planHash, actorId: "human" }, { runSuite: run })).rejects.toThrow(/clean/);
		expect(run).not.toHaveBeenCalled();
	});
});
