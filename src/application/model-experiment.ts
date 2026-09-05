import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { loadCorpus, type CorpusRef } from "../corpus.js";
import { loadTarget, ModelBlock, type TargetManifest } from "../manifest.js";
import { loadVerifiedEvalRun, readEvalRunIndex, runSuite, type VerifiedEvalRun } from "../eval.js";
import { pairedComparisonRows, runCost, runGraderScore, runTokens } from "../compare.js";
import { judgeComparison, resourceTotals, type DevelopmentVerdict } from "../domain/comparison-gate.js";
import { axisDifferences, hashValue, modelFingerprint } from "../provenance.js";
import { withDetachedWorktree } from "../git/experiment-worktree.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import { redactTraceText } from "../trace.js";
import type { RunEventListener } from "../run-events.js";
import { targetWithDevelopmentCorpus } from "./corpus-target.js";
import { TargetModelSelectionSchema, type TargetModelSelection } from "./target-model-selection.js";
import { canonicalModelExperimentStore, cleanModelExperimentSource, modelExperimentHarnessHash, modelOnlyManifest } from "./model-experiment-source.js";
import {
	ModelExperimentIdSchema, ModelExperimentPlanSchema, ModelExperimentStateSchema, MODEL_EXPERIMENT_MIN_TASKS, MODEL_EXPERIMENT_MIN_REPETITIONS,
	type ModelExperimentArm, type ModelExperimentPlan, type ModelExperimentRecord, type ModelExperimentState,
} from "./model-experiment-types.js";

export * from "./model-experiment-types.js";
export { describeModelChange, applyModelChange } from "./model-experiment-change.js";

export interface PlanModelExperimentOptions {
	targetDir: string;
	runsRoot: string;
	corpus: CorpusRef;
	selections: readonly TargetModelSelection[];
	resolveTargetModel: (selection: TargetModelSelection) => TargetManifest["model"];
	repetitions?: number;
	executionBudget: number;
	qualityTolerance?: number;
	objective?: "cost" | "latency";
	/** Replanning the same confirmation preserves its identity, never starts it. */
	id?: string;
}

/** A clean committed harness, one immutable public basket and complete host-resolved models. */
export function planModelExperiment(options: PlanModelExperimentOptions): ModelExperimentPlan {
	const source = cleanModelExperimentSource(options.targetDir);
	if (options.selections.length < 1 || options.selections.length > 2) throw new Error("choose one or two alternative models");
	const corpus = loadCorpus(options.corpus);
	const target = targetWithDevelopmentCorpus(source.target, corpus);
	const alternatives = options.selections.map((raw) => {
		const selection = TargetModelSelectionSchema.parse(raw);
		const model = ModelBlock.parse(options.resolveTargetModel(selection));
		if (model.provider !== selection.provider || model.id !== selection.modelId) throw new Error("host model resolution disagrees with the requested identity");
		return model;
	});
	const models = [source.target.manifest.model, ...alternatives].map((model, index) => ({
		armId: index === 0 ? "baseline" as const : index === 1 ? "model-1" as const : "model-2" as const,
		model, modelHash: hashValue(model),
	}));
	const judge = target.manifest.evalSuite.judge;
	if (judge && models.some(({ model }) => model.provider === judge.provider && model.id === judge.id)) {
		throw new Error("model experiment requires a separate judge model, fixed across all arms");
	}
	const repetitions = options.repetitions ?? 2;
	const identity = {
		schemaVersion: 1 as const, id: options.id ?? `model-experiment-${randomBytes(12).toString("hex")}`,
		targetDir: source.dir, runsRoot: canonicalModelExperimentStore(options.runsRoot), targetId: target.manifest.id, baseSha: source.baseSha, headRef: source.headRef,
		manifestHash: source.manifestHash, harnessHash: modelExperimentHarnessHash(source.target),
		corpus: { ...options.corpus, stateRoot: resolve(options.corpus.stateRoot) }, corpusHash: corpus.metadata.hash,
		datasetHash: target.datasetHash, suiteHash: target.suiteHash, taskIds: target.tasks.map((task) => task.id),
		models, repetitions, executionBudget: options.executionBudget,
		plannedExecutions: models.length * target.tasks.length * repetitions,
		qualityTolerance: options.qualityTolerance ?? 0, objective: options.objective ?? "cost",
	};
	return ModelExperimentPlanSchema.parse({ ...identity, planHash: hashValue(identity) });
}

export function modelExperimentDirectory(runsRoot: string, id: string): string {
	const root = canonicalModelExperimentStore(runsRoot);
	const directory = join(root, "model-experiments", ModelExperimentIdSchema.parse(id));
	for (const path of [join(root, "model-experiments"), directory, join(directory, "evals")]) {
		if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())) throw new Error("model experiment storage must use regular directories");
	}
	return directory;
}

export interface ModelExperimentReadScope { targetDir?: string; stateRoot?: string; projectId?: string }

function scopeMatches(plan: ModelExperimentPlan, scope: ModelExperimentReadScope): boolean {
	return (scope.targetDir === undefined || plan.targetDir === realpathSync(scope.targetDir)) &&
		(scope.stateRoot === undefined || canonicalModelExperimentStore(plan.corpus.stateRoot) === canonicalModelExperimentStore(scope.stateRoot)) &&
		(scope.projectId === undefined || plan.corpus.projectId === scope.projectId);
}

function readState(runsRoot: string, id: string, scope: ModelExperimentReadScope = {}): ModelExperimentState {
	const state = readJsonArtifact(join(modelExperimentDirectory(runsRoot, id), "experiment.json"), ModelExperimentStateSchema);
	if (state.plan.runsRoot !== canonicalModelExperimentStore(runsRoot)) throw new Error("model experiment belongs to another evidence store");
	if (state.plan.id !== id || state.arms.length !== state.plan.models.length || state.arms.some((arm, index) => arm.armId !== state.plan.models[index]?.armId)) {
		throw new Error("model experiment identity or arm order changed");
	}
	if (!scopeMatches(state.plan, scope)) throw new Error("model experiment belongs to another Target or project scope");
	return state;
}

function expectedModelAxes(model: TargetManifest["model"]) {
	const value = modelFingerprint(model);
	return { provider: value.provider, modelId: value.id, modelApi: value.api, modelBaseUrl: value.baseUrl,
		modelApiKeyEnv: value.apiKeyEnv, thinkingLevel: value.thinkingLevel, params: value.params, modelSpec: value.spec };
}

function verifiedArm(runsRoot: string, state: ModelExperimentState, armId: string): VerifiedEvalRun | null {
	const arm = state.arms.find((item) => item.armId === armId);
	const model = state.plan.models.find((item) => item.armId === armId);
	if (!arm || !model) throw new Error("unknown model experiment arm");
	if (arm.evalRunId === null) return null;
	const evalsRoot = join(modelExperimentDirectory(runsRoot, state.plan.id), "evals");
	// Disclosure and exact index binding precede every member read. A redirected
	// sealed index must not leak even a member id through an integrity error.
	const record = readEvalRunIndex(evalsRoot, arm.evalRunId);
	const plan = state.plan;
	if (!record.runArtifacts || !record.target.toolsetHash || !record.target.preparedToolHomeHash || hashValue(record) !== arm.evalHash || record.purpose !== "model-experiment" ||
		record.evidenceVisibility !== "development" || record.label !== "solo" || record.target.id !== plan.targetId ||
		record.target.gitSha !== arm.targetRevision || record.repetitions !== plan.repetitions ||
		record.datasetHash !== plan.datasetHash || record.suiteHash !== plan.suiteHash ||
		hashValue(record.taskIds) !== hashValue(plan.taskIds)) throw new Error("model experiment arm does not match its pinned evidence");
	const actual = Object.fromEntries(Object.keys(expectedModelAxes(model.model)).map((key) => [key, record.provenance[key as keyof typeof record.provenance]]));
	if (hashValue(actual) !== hashValue(expectedModelAxes(model.model))) throw new Error("model experiment arm used a different model");
	const verified = loadVerifiedEvalRun(evalsRoot, arm.evalRunId);
	if (!verified.hasRunHashes || hashValue(verified.record) !== arm.evalHash) throw new Error("model experiment index changed during verification");
	return verified;
}

/** Read only a member of this exact public experiment; never an arbitrary or sealed eval. */
export function loadModelExperimentEval(runsRoot: string, id: string, evalRunId: string, options: ModelExperimentReadScope = {}): VerifiedEvalRun {
	const state = readState(runsRoot, id, options);
	const arm = state.arms.find((item) => item.evalRunId === evalRunId);
	if (!arm) throw new Error("eval is not a member of this model experiment");
	return verifiedArm(runsRoot, state, arm.armId)!;
}

function armResources(run: VerifiedEvalRun) {
	return resourceTotals(run.runs.map((item) => ({ costUsd: Object.values(item.model.spec.cost ?? {}).some((rate) => typeof rate === "number" && rate > 0) ? runCost(item) : null, latencyMs: item.metrics.latencyMs, tokens: runTokens(item)?.total ?? null })));
}

function completeDesign(run: VerifiedEvalRun, plan: ModelExperimentPlan): boolean {
	const expected = new Set(plan.taskIds.flatMap((task) => Array.from({ length: plan.repetitions }, (_, index) => `${task}\0${index}`)));
	return run.runs.length === expected.size && run.runs.every((item) => item.status !== "error" && expected.delete(`${item.taskId}\0${item.repetitionIndex}`)) && expected.size === 0;
}

function projectExperiment(runsRoot: string, state: ModelExperimentState): ModelExperimentRecord {
	const verified = new Map(state.arms.map((arm) => [arm.armId, verifiedArm(runsRoot, state, arm.armId)]));
	const baseline = verified.get("baseline");
	if (baseline) {
		for (const run of verified.values()) {
			if (run && (run.record.target.toolsetHash !== baseline.record.target.toolsetHash || run.record.target.preparedToolHomeHash !== baseline.record.target.preparedToolHomeHash)) {
				throw new Error("model experiment effective tools changed between arms; comparison and model selection are unavailable");
			}
		}
	}
	const arms: ModelExperimentArm[] = state.arms.map((arm, index) => {
		const run = verified.get(arm.armId);
		const resources = run ? armResources(run) : null;
		const complete = run !== null && run !== undefined && completeDesign(run, state.plan);
		const result: ModelExperimentArm = {
			armId: arm.armId, model: state.plan.models[index]!.model, status: arm.status, evalRunId: arm.evalRunId, error: arm.error,
			runs: run?.runs.length ?? 0,
			passRate: complete ? run.runs.filter((item) => item.evalResults?.outcome === "pass").length / run.runs.length : null,
			meanScore: complete ? run.runs.reduce((sum, item) => sum + runGraderScore(item), 0) / run.runs.length : null,
			targetCostUsd: resources?.costUsd ?? null, meanLatencyMs: resources?.meanLatencyMs ?? null,
			meanTokens: resources?.meanTokens ?? null, quality: null, dominated: null,
		};
		if (baseline && run && arm.armId !== "baseline") {
			const differences = axisDifferences(baseline.record.provenance, run.record.provenance).filter((axis) => !axis.startsWith("model."));
			if (differences.length > 0) throw new Error(`model experiment changed non-model axes: ${differences.join(", ")}`);
			const rows = pairedComparisonRows(baseline.runs, run.runs);
			const statistics = judgeComparison(rows, { surface: "development", repetitions: state.plan.repetitions,
				seed: `${baseline.record.evalRunId}:${run.record.evalRunId}`, resources: { baseline: armResources(baseline), candidate: resources! } });
			const drops = rows.filter((row) => row.scoreDelta < 0 && row.aStatus !== "error" && row.bStatus !== "error").sort((a, b) => a.scoreDelta - b.scoreDelta || a.taskId.localeCompare(b.taskId));
			const regressions = drops.slice(0, 20).flatMap((row) => {
				const pairs = baseline.runs.filter((item) => item.taskId === row.taskId).flatMap((a) => {
					const b = run.runs.find((item) => item.taskId === row.taskId && item.repetitionIndex === a.repetitionIndex);
					return b ? [{ a, b, delta: runGraderScore(b) - runGraderScore(a) }] : [];
				}).sort((x, y) => x.delta - y.delta || x.a.repetitionIndex - y.a.repetitionIndex);
				const pair = pairs[0];
				return pair ? [{ taskId: row.taskId, scoreDelta: row.scoreDelta, baselineRunId: pair.a.runId, candidateRunId: pair.b.runId }] : [];
			});
			result.quality = { verdict: statistics.gate.verdict as DevelopmentVerdict, summary: statistics.summary, design: statistics.design,
				withinTolerance: complete && completeDesign(baseline, state.plan) && statistics.design.tasks >= MODEL_EXPERIMENT_MIN_TASKS && state.plan.repetitions >= MODEL_EXPERIMENT_MIN_REPETITIONS && statistics.design.excludedTasks === 0 && statistics.summary.confidence95.low >= -state.plan.qualityTolerance,
				regressions, omittedRegressions: drops.length - regressions.length };
		}
		return result;
	});
	const measured = (arm: ModelExperimentArm) => arm.status === "completed" && arm.meanScore !== null && arm.targetCostUsd !== null && arm.meanLatencyMs !== null;
	for (const arm of arms) {
		if (!measured(arm)) continue;
		arm.dominated = arms.some((other) => other !== arm && measured(other) && other.meanScore! >= arm.meanScore! && other.targetCostUsd! <= arm.targetCostUsd! && other.meanLatencyMs! <= arm.meanLatencyMs! &&
			(other.meanScore! > arm.meanScore! || other.targetCostUsd! < arm.targetCostUsd! || other.meanLatencyMs! < arm.meanLatencyMs!));
	}
	const powered = state.plan.taskIds.length >= MODEL_EXPERIMENT_MIN_TASKS && state.plan.repetitions >= MODEL_EXPERIMENT_MIN_REPETITIONS && baseline && completeDesign(baseline, state.plan);
	const eligible = arms.filter((arm) => arm.status === "completed" && powered && (arm.armId === "baseline" || arm.quality?.withinTolerance) &&
		(state.plan.objective === "cost" ? arm.targetCostUsd !== null : arm.meanLatencyMs !== null));
	eligible.sort((a, b) => (state.plan.objective === "cost" ? a.targetCostUsd! - b.targetCostUsd! : a.meanLatencyMs! - b.meanLatencyMs!) || arms.indexOf(a) - arms.indexOf(b));
	const costs = arms.map((arm) => arm.targetCostUsd);
	return {
		id: state.plan.id, plan: state.plan, status: state.status, startedAt: state.startedAt, finishedAt: state.finishedAt, arms,
		frontierArmIds: arms.filter((arm) => arm.dominated === false).map((arm) => arm.armId),
		recommendedArmId: state.status === "completed" ? eligible[0]?.armId ?? null : null,
		targetCostUsd: costs.every((cost): cost is number => cost !== null) ? costs.reduce((a, b) => a + b, 0) : null,
		evaluatorOverhead: state.status === "completed" && state.arms.every((arm) => {
			const run = verified.get(arm.armId);
			return arm.status === "completed" && run && completeDesign(run, state.plan) && run.runs.every((item) => (item.metrics.judge?.calls ?? 0) === 0 && (item.metrics.simulatedUser?.calls ?? 0) === 0);
		}) ? "none" : "unverified",
		limitations: ["Exploratory development comparison; no release authorization or guarantee on unseen tasks.",
			"Recommendation requires at least 15 cases, two repetitions, complete evidence and the paired 95% lower bound inside the chosen tolerance.",
			"Intervals are unadjusted across alternatives. Selecting on these cases can overfit them; frontier reflects observed measurements.",
			"Costs cover Target usage at recorded rates only. Any judge or simulated-user spend is separate and unverified; this is not a provider invoice.",
			"A model whose four recorded rates are all zero has ambiguous pricing; its cost is shown as unknown, including possibly free models.",
			"Latency is observed with one execution at a time; provider load and model order can affect it."],
	};
}

export function loadModelExperiment(runsRoot: string, id: string, options: ModelExperimentReadScope = {}): ModelExperimentRecord {
	return projectExperiment(runsRoot, readState(runsRoot, id, options));
}

export function listModelExperiments(runsRoot: string, options: ModelExperimentReadScope = {}): ModelExperimentRecord[] {
	const root = join(resolve(runsRoot), "model-experiments");
	if (!existsSync(root)) return [];
	const ids = readdirSync(root).filter((id) => ModelExperimentIdSchema.safeParse(id).success).sort().reverse();
	if (ids.length > 100) throw new Error("more than 100 model experiments; inspect an exact experiment id");
	return ids.map((id) => readState(runsRoot, id)).filter((state) => scopeMatches(state.plan, options))
		.map((state) => projectExperiment(runsRoot, state)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export interface RunModelExperimentOptions {
	targetDir: string;
	runsRoot: string;
	plan: ModelExperimentPlan;
	expectedPlanHash: string;
	actorId: string;
	signal?: AbortSignal;
	onRunEvent?: RunEventListener;
}

/** Private snapshots and an isolated eval namespace keep auditions out of normal baseline/release discovery. */
export async function runModelExperiment(options: RunModelExperimentOptions, dependencies: { runSuite?: typeof runSuite } = {}): Promise<ModelExperimentRecord> {
	const plan = ModelExperimentPlanSchema.parse(options.plan);
	const actorId = z.string().trim().min(1).max(256).parse(options.actorId);
	if (realpathSync(options.targetDir) !== plan.targetDir || canonicalModelExperimentStore(options.runsRoot) !== plan.runsRoot || options.expectedPlanHash !== plan.planHash) throw new Error("model experiment confirmation is stale or belongs to another Target or evidence store");
	const source = cleanModelExperimentSource(options.targetDir);
	const corpus = loadCorpus(plan.corpus);
	const current = targetWithDevelopmentCorpus(source.target, corpus);
	if (source.baseSha !== plan.baseSha || source.headRef !== plan.headRef || source.manifestHash !== plan.manifestHash ||
		modelExperimentHarnessHash(source.target) !== plan.harnessHash || corpus.metadata.hash !== plan.corpusHash || current.datasetHash !== plan.datasetHash || current.suiteHash !== plan.suiteHash ||
		hashValue(current.tasks.map((task) => task.id)) !== hashValue(plan.taskIds) || hashValue(source.target.manifest.model) !== plan.models[0]!.modelHash) throw new Error("model experiment source changed after confirmation");
	options.signal?.throwIfAborted();
	const directory = modelExperimentDirectory(options.runsRoot, plan.id);
	mkdirSync(join(resolve(options.runsRoot), "model-experiments"), { recursive: true, mode: 0o700 });
	mkdirSync(directory, { mode: 0o700 }); // Exclusive reservation; the same consent cannot spend twice.
	let state: ModelExperimentState = { schemaVersion: 1, plan, actorId, status: "running", startedAt: new Date().toISOString(), finishedAt: null,
		arms: plan.models.map((model) => ({ armId: model.armId, status: "pending", evalRunId: null, evalHash: null, targetRevision: null, error: null })) };
	const save = () => writeJsonArtifact(join(directory, "experiment.json"), ModelExperimentStateSchema, state);
	save();
	let scheduled = 0;
	for (let index = 0; index < plan.models.length; index++) {
		const arm = state.arms[index]!;
		try {
			options.signal?.throwIfAborted();
			const executions = plan.taskIds.length * plan.repetitions;
			if (scheduled + executions > plan.executionBudget) throw new Error("model experiment execution budget exhausted");
			scheduled += executions;
			arm.status = "running";
			save();
			await withDetachedWorktree({ repositoryDir: plan.targetDir, ref: plan.baseSha }, async (worktree) => {
				if (index !== 0) writeFileSync(join(worktree.path, "manifest.yaml"), modelOnlyManifest(source.manifestText, plan.models[index]!.model), { mode: 0o600 });
				const variant = loadTarget(worktree.path);
				if (modelExperimentHarnessHash(variant) !== plan.harnessHash || hashValue(variant.manifest.model) !== plan.models[index]!.modelHash) throw new Error("private model snapshot changed the pinned harness");
				arm.targetRevision = variant.gitSha;
				save();
				const baseline = index === 0 ? null : verifiedArm(options.runsRoot, state, "baseline");
				const evaluation = await (dependencies.runSuite ?? runSuite)(targetWithDevelopmentCorpus(variant, corpus), {
					runsRoot: join(directory, "evals"), label: "solo", repetitions: plan.repetitions, jobs: 1,
					purpose: "model-experiment", evidenceVisibility: "development",
					...(baseline ? { expectedPreparedToolHomeHash: baseline.record.target.preparedToolHomeHash! } : {}),
					...(options.signal ? { signal: options.signal } : {}), ...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
				});
				arm.evalRunId = evaluation.evalRunId;
				arm.evalHash = hashValue(evaluation);
				arm.status = "completed";
				save();
				verifiedArm(options.runsRoot, state, arm.armId);
			});
		} catch (error) {
			const stopped = options.signal?.aborted === true;
			arm.status = stopped ? "stopped" : "failed";
			arm.error = redactTraceText(error instanceof Error ? error.message : String(error)).slice(0, 2000);
			state.status = stopped ? "stopped" : "failed";
			break;
		}
	}
	if (state.status === "running") state.status = "completed";
	state.finishedAt = new Date().toISOString();
	save();
	return projectExperiment(options.runsRoot, state);
}
