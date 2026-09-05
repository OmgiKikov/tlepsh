import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	evalRunCostUsd,
	findPreviousWatchRun,
	findRevisionCalibration,
	runWatch,
	runWatchTick,
	watchExitCode,
	WATCH_EXIT_DRIFT,
	WATCH_EXIT_HEALTHY,
	WATCH_EXIT_NO_BASELINE,
	type WatchTick,
} from "../src/application/watch.js";
import { renderWatchTick, renderWatchTickDetail } from "../src/builder/render/watch.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { loadTarget, type ResolvedTarget } from "../src/manifest.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import { baseFixtureFiles, makeTargetFixture } from "./fixtures.js";

/**
 * `ahde watch`: the basket on a schedule.
 *
 * Nothing about the Target moves between two ticks, so the pair is an A/A
 * experiment and `inconclusive` is the healthy answer. These tests script the
 * one thing that CAN move — the provider behind an unchanged model id — and
 * check that the command calls it drift and changes nothing durable.
 */

const WATCH_TIMEOUT_MS = 180_000;
/** The gate is seeded, so a small resample count is deterministic and fast. */
const RESAMPLES = 200;

const cleanupPaths: string[] = [];
const openMocks: MockModelHandle[] = [];

it("does not price a partially reported tick as the judge subtotal", () => {
	const metrics = { latencyMs: 10, toolCalls: 0, toolErrors: 0, recoveryAttempts: 0 };
	const judge = { calls: 1, tokens: 100, costUsd: 0.1 };
	expect(evalRunCostUsd([{ metrics: { ...metrics, judge } }])).toBeNull();
	expect(evalRunCostUsd([{ metrics: { ...metrics, judge, costUsd: 0 } }])).toBe(0.1);
	expect(evalRunCostUsd([
		{ metrics: { ...metrics, costUsd: 1 } },
		{ metrics: { ...metrics, judge } },
	])).toBeNull();
});

afterEach(async () => {
	for (const mock of openMocks.splice(0)) await mock.close();
	for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const TASKS = ["watch_a", "watch_b", "watch_c"];

interface WatchFixture {
	target: ResolvedTarget;
	targetDir: string;
	runsRoot: string;
	/** The scripted provider's current answer; the revision never changes. */
	answer: { text: string; errorStatus?: number };
}

/**
 * One committed Target revision and a scripted provider whose answer a test can
 * change without touching a byte of the harness. The runs root deliberately
 * lives outside the repository so a tick cannot make the workspace dirty.
 */
async function watchFixture(): Promise<WatchFixture> {
	process.env.MOCK_MODEL_KEY = "test-key";
	const answer: WatchFixture["answer"] = { text: "answer-ok" };
	const mock = await startMockModel([
		{ match: () => true, resolve: () => answer.errorStatus
			? { httpError: { status: answer.errorStatus, message: "Provider credentials expired" } }
			: { text: answer.text }, steps: [] },
	]);
	openMocks.push(mock);
	const targetDir = makeTargetFixture(baseFixtureFiles({
		"manifest.yaml": `id: watch-target
model:
  provider: qwen-mock
  id: mock
  api: openai-completions
  baseUrl: ${mock.url}
  apiKeyEnv: MOCK_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 60000
instructions:
  agentsMd: AGENTS.md
skills: []
evalSuite:
  id: watch-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`,
		"evals/development.jsonl": TASKS
			.map((id) => JSON.stringify({ id, input: `request ${id}`, graders: [{ type: "output_contains", text: "answer-ok" }] }))
			.join("\n"),
		"evals/graders.yaml": "defaults: []\n",
	}));
	const runsRoot = join(targetDir, "..", `watch-runs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	cleanupPaths.push(targetDir, runsRoot);
	return { target: loadTarget(targetDir), targetDir, runsRoot, answer };
}

function tick(fixture: WatchFixture): Promise<WatchTick> {
	return runWatchTick({
		target: fixture.target,
		runsRoot: fixture.runsRoot,
		repetitions: 1,
		resamples: RESAMPLES,
	});
}

/** Nothing outside the ordinary eval runs a tick produced. */
function durableStateBeyondEvalRuns(runsRoot: string): string[] {
	return ["candidates", "builders", "screens", "specs"].filter((entry) => existsSync(join(runsRoot, entry)));
}

it("has nothing to compare the first tick with, and calls the second inconclusive", async () => {
	const fixture = await watchFixture();

	const first = await tick(fixture);
	expect(first.status).toBe("no-baseline");
	expect(first.verdict).toBeNull();
	expect(first.previousEvalRunId).toBeNull();
	expect(first.score).toBe(1);
	expect(renderWatchTick(first, plainPaint)).toContain("no baseline");

	const second = await tick(fixture);
	expect(second.status).toBe("healthy");
	expect(second.verdict).toBe("inconclusive");
	expect(second.previousEvalRunId).toBe(first.evalRunId);
	expect(second.previousScore).toBe(1);
	expect(second.revision).toBe(fixture.target.gitSha);

	// A/A on an unchanged revision is the healthy answer, and it is exit 0.
	expect(watchExitCode([first, second])).toBe(WATCH_EXIT_HEALTHY);
	expect(watchExitCode([first])).toBe(WATCH_EXIT_NO_BASELINE);
	expect(renderWatchTick(second, plainPaint)).toMatch(
		/^watch \d{4}-\d{2}-\d{2}T\d{2}:\d{2} · 100\.0% vs 100\.0% · inconclusive · noise not calibrated · \$0\.00$/,
	);
	// Both ticks are ordinary `solo` development evidence and nothing else.
	expect(durableStateBeyondEvalRuns(fixture.runsRoot)).toEqual([]);
}, WATCH_TIMEOUT_MS);

it("reports a provider outage as unusable evidence and never exits healthy", async () => {
	const fixture = await watchFixture();
	await tick(fixture);
	fixture.answer.errorStatus = 401;
	const outage = await tick(fixture);
	expect(outage.status).toBe("not-comparable");
	expect(outage.verdict).toBeNull();
	expect(outage.note).toContain("errored");
	expect(watchExitCode([outage])).toBe(WATCH_EXIT_NO_BASELINE);
	expect(renderWatchTick(outage, plainPaint)).toContain("no comparable baseline");
	expect(renderWatchTickDetail(outage, plainPaint).join("\n")).toContain("errored");
}, WATCH_TIMEOUT_MS);

it("calls a scripted behaviour change on an unchanged revision drift, and exits 3", async () => {
	const fixture = await watchFixture();
	const healthy = await tick(fixture);
	expect(healthy.status).toBe("no-baseline");

	// The harness did not move. The provider did.
	fixture.answer.text = "answer-somewhere-else";
	const drifted = await tick(fixture);

	expect(drifted.revision).toBe(healthy.revision);
	expect(drifted.verdict).toBe("regressed");
	expect(drifted.status).toBe("drift");
	expect(drifted.score).toBe(0);
	expect(watchExitCode([healthy, drifted])).toBe(WATCH_EXIT_DRIFT);
	const line = renderWatchTick(drifted, plainPaint);
	expect(line).toContain("regressed · drift");
	expect(line).toContain("0.0% vs 100.0%");
	const detail = renderWatchTickDetail(drifted, plainPaint).join("\n");
	expect(detail).toContain("behaviour changed below the harness boundary");
	expect(detail).toContain("provider/model rollout, stochastic variance, runtime, tool, or external-data change");
	expect(detail).toContain("nothing was promoted, adopted, or written as a receipt");

	// A drift settling back is drift again, not a win.
	fixture.answer.text = "answer-ok";
	const recovered = await tick(fixture);
	expect(recovered.verdict).toBe("improved");
	expect(recovered.status).toBe("drift");
	expect(renderWatchTickDetail(recovered, plainPaint).join("\n")).toContain("a gain here is drift, not a win");

	// Drift anywhere in the run wins the exit code, and nothing durable moved.
	expect(watchExitCode([healthy, drifted, recovered])).toBe(WATCH_EXIT_DRIFT);
	expect(durableStateBeyondEvalRuns(fixture.runsRoot)).toEqual([]);
}, WATCH_TIMEOUT_MS);

it("shows this revision's flip rate beside the verdict when a calibration exists", async () => {
	const fixture = await watchFixture();
	expect(findRevisionCalibration(fixture.runsRoot, fixture.target)).toBeNull();
	writeCalibration(fixture.runsRoot, fixture.target.gitSha, { improved: 1, regressed: 1, taskCount: 20 });

	const first = await tick(fixture);
	const second = await tick(fixture);

	expect(second.calibration).toMatchObject({ flipRate: 0.1, tasks: 20, repetitions: 3 });
	expect(renderWatchTick(second, plainPaint)).toContain("flip 10% (calibrated)");
	// A calibration of another revision says nothing about this one's noise.
	expect(findRevisionCalibration(fixture.runsRoot, fixture.target, { projectId: "someone-else" })).toBeNull();
	expect(renderWatchTickDetail(first, plainPaint).join("\n")).not.toContain("ahde calibrate");
}, WATCH_TIMEOUT_MS);

it("never mistakes a cheap-check screen for the previous tick", async () => {
	const fixture = await watchFixture();
	const real = await tick(fixture);
	const screened = await tick(fixture);
	writeScreenMarker(fixture.runsRoot, fixture.target, screened.evalRunId);

	// The newest `solo` run on this revision is the screen; watch must skip it.
	const previous = findPreviousWatchRun(fixture.runsRoot, fixture.target, { repetitions: 1 });
	expect(previous?.evalRunId).toBe(real.evalRunId);
	// A different design is a different measurement, not a baseline.
	expect(findPreviousWatchRun(fixture.runsRoot, fixture.target, { repetitions: 2 })).toBeNull();
}, WATCH_TIMEOUT_MS);

it("runs one tick without --every and bounds the loop with --max-runs", async () => {
	const fixture = await watchFixture();

	const once = await runWatch({
		target: fixture.target,
		runsRoot: fixture.runsRoot,
		repetitions: 1,
		resamples: RESAMPLES,
	});
	expect(once.ticks).toHaveLength(1);
	expect(once.exitCode).toBe(WATCH_EXIT_NO_BASELINE);
	expect(once.drifted).toBe(false);

	// A monotonic schedule, driven by an injected clock so the test does not wait.
	const waited: number[] = [];
	let clock = 0;
	const looped = await runWatch({
		target: fixture.target,
		runsRoot: fixture.runsRoot,
		repetitions: 1,
		resamples: RESAMPLES,
		everyMs: 60_000,
		maxRuns: 2,
		monotonicNow: () => clock,
		sleep: async (ms) => {
			waited.push(ms);
			clock += ms;
		},
	});

	expect(looped.ticks).toHaveLength(2);
	expect(waited).toEqual([60_000]);
	expect(looped.ticks.map((entry) => entry.status)).toEqual(["healthy", "healthy"]);
	expect(looped.exitCode).toBe(WATCH_EXIT_HEALTHY);
	expect(durableStateBeyondEvalRuns(fixture.runsRoot)).toEqual([]);
}, WATCH_TIMEOUT_MS);

it("stops a schedule on the abort signal and refuses an interval it cannot honour", async () => {
	const fixture = await watchFixture();
	const controller = new AbortController();

	const stopped = await runWatch({
		target: fixture.target,
		runsRoot: fixture.runsRoot,
		repetitions: 1,
		resamples: RESAMPLES,
		everyMs: 60_000,
		maxRuns: 5,
		signal: controller.signal,
		sleep: async () => {},
		onTick: () => controller.abort(),
	});

	expect(stopped.ticks).toHaveLength(1);
	await expect(runWatch({
		target: fixture.target,
		runsRoot: fixture.runsRoot,
		repetitions: 1,
		everyMs: 500,
	})).rejects.toThrow(/watch interval must be between/);
	await expect(runWatch({
		target: fixture.target,
		runsRoot: fixture.runsRoot,
		repetitions: 1,
		everyMs: 60_000,
		maxRuns: 1_001,
	})).rejects.toThrow(/watch maxRuns must be between 1 and 1000/);
}, WATCH_TIMEOUT_MS);

// ---------------------------------------------------------------------------
// Fixtures that stand in for artifacts another command writes.

/**
 * An A/A calibration record of this exact revision. `ahde calibrate` writes
 * one through a full experiment; watch only ever reads it.
 */
function writeCalibration(
	runsRoot: string,
	sha: string,
	summary: { improved: number; regressed: number; taskCount: number },
): void {
	const revision = { ref: "HEAD", sha };
	const at = "2026-08-30T10:00:00.000Z";
	const record = {
		schemaVersion: 1,
		candidateId: "cand-calibration",
		projectId: "watch-target",
		targetId: "watch-target",
		specId: null,
		proposalId: "calibration",
		diagnosisId: null,
		origin: { kind: "manual", reason: "A/A calibration" },
		mode: "aa-calibration",
		baseline: revision,
		createdAt: at,
		events: [
			{ type: "proposed", eventId: "cal-1", at, actor: { kind: "human", id: "local:test" } },
			{ type: "built", eventId: "cal-2", at, actor: { kind: "human", id: "local:test" }, candidate: revision },
			{
				type: "validated",
				eventId: "cal-3",
				at,
				actor: { kind: "system", id: "validator" },
				lineage: { baseline: revision, candidate: revision, relation: "same" },
				scope: {
					policyId: "harness-scope-v1",
					baselineSha: sha,
					candidateSha: sha,
					passed: true,
					changedFiles: [],
					violations: [],
				},
			},
			{
				type: "evaluated",
				eventId: "cal-4",
				at,
				actor: { kind: "system", id: "evaluator" },
				evaluation: {
					experimentId: "cal-exp",
					designHash: `sha256:${"d".repeat(64)}`,
					mode: "aa-calibration",
					development: {
						baseline: { evalRunId: "erun_cal_a", harness: revision },
						candidate: { evalRunId: "erun_cal_b", harness: revision },
						comparison: {
							schemaVersion: 4,
							algorithmId: "exact-comparison-gate-v4",
							policyId: "development-ci-v4",
							surface: "development",
							comparisonHash: `sha256:${"a".repeat(64)}`,
							evidenceHash: `sha256:${"b".repeat(64)}`,
							gateHash: `sha256:${"c".repeat(64)}`,
							summary: {
								taskCount: summary.taskCount,
								baselinePassRate: 0.9,
								candidatePassRate: 0.9,
								delta: 0,
								baselineScore: 0.9,
								candidateScore: 0.9,
								scoreDelta: 0,
								confidence95: { low: -0.04, high: 0.04 },
								improved: summary.improved,
								regressed: summary.regressed,
								unchanged: summary.taskCount - summary.improved - summary.regressed,
							},
							design: { tasks: summary.taskCount, repetitions: 3, excludedTasks: 0 },
							verdict: "inconclusive",
							flags: { regressedTasks: summary.regressed, improvedTasks: summary.improved, collapsedTasks: 0 },
							resources: {
								baseline: { runs: summary.taskCount * 3, costUsd: 0, meanLatencyMs: 10, meanTokens: 5 },
								candidate: { runs: summary.taskCount * 3, costUsd: 0, meanLatencyMs: 10, meanTokens: 5 },
								costRatio: null,
								latencyRatio: 1,
								tokenRatio: 1,
							},
							reasons: ["inconclusive on an A/A pair"],
						},
					},
					infrastructureErrors: 0,
				},
			},
		],
	};
	const dir = join(runsRoot, "candidates", "cand-calibration");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "candidate.json"), `${JSON.stringify(record, null, "\t")}\n`);
}

/** The durable marker `ahde check` writes so a screen is never mistaken for evidence. */
function writeScreenMarker(runsRoot: string, target: ResolvedTarget, evalRunId: string): void {
	const record = {
		schemaVersion: 1,
		kind: "cheap-check-screen",
		screenId: "screen-1",
		evalRunId,
		sourceEvalRunId: "erun_source",
		targetId: target.manifest.id,
		baseTargetSha: target.gitSha,
		candidateSha: target.gitSha,
		surface: {
			dataset: "development",
			datasetHash: target.datasetHash,
			suiteHash: target.suiteHash,
		},
		taskIds: [],
		runIds: [],
		rows: [],
		summary: { tasks: 0, improved: 0, unchanged: 0, regressed: 0, inconclusive: 0 },
		verdict: "flat",
		withinErrorBudget: true,
		createdAt: "2026-08-30T10:00:00.000Z",
	};
	mkdirSync(join(runsRoot, "screens"), { recursive: true });
	writeFileSync(join(runsRoot, "screens", "screen-1.json"), `${JSON.stringify(record, null, "\t")}\n`);
}
