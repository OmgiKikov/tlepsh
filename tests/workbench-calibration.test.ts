import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXACT_COMPARISON_GATE_ALGORITHM_ID_V4 } from "../src/domain/comparison-gate.js";
import {
	createCandidate,
	transitionCandidate,
	type CandidateRecord,
	type ExperimentMode,
} from "../src/domain/candidate.js";
import {
	DEFAULT_REPETITIONS,
	calibrationProjection,
	recommendedRepetitions,
} from "../src/workbench/calibration.js";
import { examCasesForMeasuredBand, examCasesForTenPoints } from "../src/domain/power.js";
import { writeEvalRun, type EvalRunRecord } from "../src/eval.js";
import { plural, t } from "../src/i18n.js";
import { renderCalibration } from "../src/builder/render/calibration.js";
import { plainPaint } from "../src/builder/render/paint.js";
import {
	AHDE_EVALUATOR_ID,
	executionFingerprint,
	hashValue,
	modelFingerprint,
	type ProvenanceAxes,
} from "../src/provenance.js";
import type { AgentSpec } from "../src/spec.js";
import { createAhdeWorkbench, type WorkbenchHumanGate } from "../src/workbench/index.js";
import type { WorkbenchCalibrationProjection } from "../src/workbench/types.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

const NOW = "2026-08-29T09:00:00.000Z";
const LATER = "2026-08-29T09:30:00.000Z";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const HASH = `sha256:${"c".repeat(64)}`;

interface EvidenceOptions {
	taskCount?: number;
	repetitions?: number;
	baselinePassRate?: number;
	improved?: number;
	regressed?: number;
	delta?: number;
	confidence95?: { low: number; high: number };
	verdict?: "improved" | "inconclusive" | "regressed";
}

function developmentEvidence(options: EvidenceOptions = {}) {
	const taskCount = options.taskCount ?? 30;
	const improved = options.improved ?? 2;
	const regressed = options.regressed ?? 1;
	return {
		schemaVersion: 4 as const,
		algorithmId: EXACT_COMPARISON_GATE_ALGORITHM_ID_V4,
		policyId: "development-ci-v4" as const,
		surface: "development" as const,
		comparisonHash: HASH,
		evidenceHash: HASH,
		gateHash: HASH,
		summary: {
			taskCount,
			baselinePassRate: options.baselinePassRate ?? 0.9,
			candidatePassRate: options.baselinePassRate ?? 0.9,
			delta: options.delta ?? 0,
			baselineScore: options.baselinePassRate ?? 0.9,
			candidateScore: options.baselinePassRate ?? 0.9,
			scoreDelta: options.delta ?? 0,
			confidence95: options.confidence95 ?? { low: -0.06, high: 0.06 },
			improved,
			regressed,
			unchanged: taskCount - improved - regressed,
		},
		design: { tasks: taskCount, repetitions: options.repetitions ?? 3, excludedTasks: 0 },
		verdict: options.verdict ?? ("inconclusive" as const),
		flags: { regressedTasks: regressed, improvedTasks: improved, collapsedTasks: 0 },
		resources: { baseline: { runs: 30, costUsd: 0.1, meanLatencyMs: 2000, meanTokens: 800 }, candidate: { runs: 30, costUsd: 0.14, meanLatencyMs: 1800, meanTokens: 900 }, costRatio: 1.4, latencyRatio: 0.9, tokenRatio: 1.125 },
		reasons: ["95% CI -6.0pp … +6.0pp spans zero on 30 tasks × 3 repetitions"],
	};
}

function calibrationRecord(
	options: EvidenceOptions & { mode?: ExperimentMode; comparison?: unknown } = {},
): CandidateRecord {
	const actor = { kind: "human" as const, id: "local:test-human" };
	const system = { kind: "system" as const, id: "candidate-experiment" };
	const mode = options.mode ?? "aa-calibration";
	const revision = { ref: "refs/heads/master", sha: SHA };
	const built = mode === "candidate" ? { ref: "refs/heads/candidate", sha: OTHER_SHA } : revision;
	let record = createCandidate({
		candidateId: "calibration-1",
		projectId: "proj",
		targetId: "support-bot",
		specId: "spec-1",
		proposalId: "proposal-unspecified",
		diagnosisId: null,
		origin: { kind: "manual", reason: "A/A calibration" },
		mode,
		baseline: revision,
		eventId: "calibration-1:proposed",
		at: NOW,
		actor,
	});
	record = transitionCandidate(record, {
		type: "built",
		eventId: "calibration-1:built",
		at: NOW,
		actor,
		candidate: built,
	});
	record = transitionCandidate(record, {
		type: "validated",
		eventId: "calibration-1:validated",
		at: NOW,
		actor: system,
		lineage: {
			baseline: revision,
			candidate: built,
			relation: mode === "candidate" ? "descendant" : "same",
		},
		scope: {
			policyId: "candidate-harness-resources-v2",
			baselineSha: SHA,
			candidateSha: built.sha,
			passed: true,
			changedFiles: mode === "candidate" ? ["AGENTS.md"] : [],
			violations: [],
		},
	});
	return transitionCandidate(record, {
		type: "evaluated",
		eventId: "calibration-1:evaluated",
		at: LATER,
		actor: system,
		evaluation: {
			experimentId: "calibration-1",
			designHash: HASH,
			mode,
			development: {
				corpus: { id: "corpus-1", hash: HASH },
				baseline: { evalRunId: "erun-a", harness: revision },
				candidate: { evalRunId: "erun-b", harness: built },
				comparison: "comparison" in options
					? (options.comparison as never)
					: (developmentEvidence(options) as never),
			},
			infrastructureErrors: 0,
		},
	});
}

describe("calibration projection", () => {
	it("projects an A/A record into the one line a human needs", () => {
		const projection = calibrationProjection(calibrationRecord());

		expect(projection).toEqual({
			candidateId: "calibration-1",
			targetSha: SHA,
			taskCount: 30,
			repetitions: 3,
			aaPassRate: 0.9,
			delta: 0,
			confidence95: { low: -0.06, high: 0.06 },
			flipRate: 3 / 30,
			recommendedRepetitions: 3,
			// ±6 pp on 30 tasks scales to 11 tasks for ±10 pp, and the guardrail's
			// own minimum is the floor: no exam may be smaller than 15.
			recommendedExamCases: 15,
			verdict: "inconclusive",
			at: LATER,
		});
	});

	it("refuses anything that is not finished A/A evidence with a verdict", () => {
		expect(calibrationProjection(calibrationRecord({ mode: "candidate" }))).toBeNull();
		expect(calibrationProjection(calibrationRecord({ comparison: null }))).toBeNull();
		// Legacy v1 evidence parses but carries no verdict, so it projects to null.
		expect(calibrationProjection(calibrationRecord({
			comparison: {
				policyId: "exact-comparison-gate-v1",
				comparisonHash: HASH,
				gateHash: HASH,
				summary: {
					taskCount: 1,
					baselinePassRate: 1,
					candidatePassRate: 1,
					delta: 0,
					confidence95: { low: 0, high: 0 },
					improved: 0,
					regressed: 0,
					unchanged: 1,
				},
			},
		}))).toBeNull();
	});

	it("recommends the cheapest design whose noise band fits inside ten points", () => {
		// 1.96·√(2·0.9·0.1/(k·30)) ≤ 0.10 first holds at k = 3.
		expect(recommendedRepetitions(0.9, 30)).toBe(3);
		// A wide basket needs no repetition; a 50/50 Target needs the whole budget.
		expect(recommendedRepetitions(0.5, 200)).toBe(1);
		expect(recommendedRepetitions(0.5, 100)).toBe(2);
		expect(recommendedRepetitions(0.3, 60)).toBe(3);
		// A deterministic Target has no variance at all: one repetition is enough.
		expect(recommendedRepetitions(1, 5)).toBe(1);
		expect(recommendedRepetitions(0, 5)).toBe(1);
		// Small, noisy baskets exhaust the cap instead of promising precision.
		expect(recommendedRepetitions(0.5, 30)).toBe(5);
		expect(recommendedRepetitions(0.5, 0)).toBe(5);
		for (const [passRate, taskCount] of [[0.5, 100], [0.7, 12], [0.3, 60], [0.9, 30]] as const) {
			const k = recommendedRepetitions(passRate, taskCount);
			const band = 1.96 * Math.sqrt((2 * passRate * (1 - passRate)) / (k * taskCount));
			expect(k === 5 || band <= 0.1).toBe(true);
			if (k > 1) {
				const previous = 1.96 * Math.sqrt((2 * passRate * (1 - passRate)) / ((k - 1) * taskCount));
				expect(previous).toBeGreaterThan(0.1);
			}
		}
	});

	it("defaults human runs to three repetitions", () => {
		expect(DEFAULT_REPETITIONS).toBe(3);
	});
});

/**
 * How big an exam has to be, from the noise the A/A actually measured. The
 * deltas form is the definition; the band form is what a recorded calibration
 * can still answer with, and the two must never disagree.
 */
describe("exam size from measured noise", () => {
	/** `count` deltas with mean 0 and exactly this sample standard deviation. */
	function deltasWithSpread(spread: number, count = 20): number[] {
		return Array.from({ length: count }, (_, index) => (index % 2 === 0 ? spread : -spread))
			// The ±spread alternation has sample sd `spread·√(n/(n−1))`; scale it back.
			.map((delta) => delta * Math.sqrt((count - 1) / count));
	}

	it("sizes the exam from the spread of the per-task deltas", () => {
		// (1.96 · 0.3 / 0.10)² = 34.6 → 35 cases.
		expect(examCasesForTenPoints(deltasWithSpread(0.3))).toBe(35);
		// (1.96 · 0.1 / 0.10)² = 3.9 → 4, and the guardrail's own floor is 15.
		expect(examCasesForTenPoints(deltasWithSpread(0.1))).toBe(15);
		// A Target that disagrees with itself wildly is capped, not extrapolated.
		expect(examCasesForTenPoints(deltasWithSpread(2))).toBe(200);
	});

	it("refuses to describe noise it has not seen", () => {
		expect(examCasesForTenPoints([])).toBeNull();
		expect(examCasesForTenPoints([0.1, -0.1])).toBeNull();
		expect(examCasesForTenPoints([0.1, -0.1, Number.NaN])).toBeNull();
		expect(examCasesForMeasuredBand(0.06, 2)).toBeNull();
		expect(examCasesForMeasuredBand(0, 30)).toBeNull();
		expect(examCasesForMeasuredBand(Number.NaN, 30)).toBeNull();
	});

	it("recovers the same size from the interval a recorded A/A kept", () => {
		for (const spread of [0.15, 0.3, 0.5]) {
			const deltas = deltasWithSpread(spread, 40);
			// The half-width a bootstrap over those deltas approximates: 1.96·sd/√n.
			const band = (1.96 * spread) / Math.sqrt(40);
			expect(examCasesForMeasuredBand(band, 40)).toBe(examCasesForTenPoints(deltas));
		}
	});
});

/**
 * The A/A that measures the simulator instead of the harness: one revision, one
 * basket, and a second model on the user's side of every conversation. Its band
 * says nothing about the agent, so the decision names what it measured and the
 * projection reads that off the evidence rather than off the request.
 */
describe("simulator noise", () => {
	const roots: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const root of roots.splice(0)) cleanup(root);
	});

	function userBlock(id: string): string {
		return [
			"    provider: qwen-internal",
			`    id: ${id}`,
			"    api: openai-completions",
			"    baseUrl: http://127.0.0.1:9901/v1",
			"    apiKeyEnv: TEST_MODEL_KEY",
			'    thinkingLevel: "off"',
			"    timeoutMs: 300000",
		].join("\n");
	}

	/** The base fixture Target, plus one or two models that play the user. */
	function manifestYaml(alternate: boolean): string {
		return `id: test-target
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
  simulatedUser:
${userBlock("user-primary")}
${alternate ? `  simulatedUserAlternate:\n${userBlock("user-alternate")}\n` : ""}`;
	}

	function target(alternate: boolean): { projectDir: string; stateRoot: string; runsRoot: string } {
		const projectDir = makeTargetFixture(baseFixtureFiles({
			".gitignore": ".ahde/\nruns/\n",
			"manifest.yaml": manifestYaml(alternate),
		}));
		roots.push(projectDir);
		return { projectDir, stateRoot: join(projectDir, ".ahde"), runsRoot: join(projectDir, "runs") };
	}

	function spec(): AgentSpec {
		return {
			schemaVersion: 1,
			title: "Support policy assistant",
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

	function gate(approved = true): WorkbenchHumanGate & { confirm: ReturnType<typeof vi.fn> } {
		return {
			confirm: vi.fn(async () => ({ approved, ...(approved ? { actorId: "local:test-human" } : {}) })),
			selectSealed: vi.fn(async () => ({ approved, actorId: "local:test-human", selectedIndex: 0 })),
		};
	}

	const CONVERSATION_CASE = {
		input: "Мне нужно понять, что делать дальше.",
		simulatedUser: { goal: "Понять следующий шаг", maxTurns: 3 },
		graders: [{ type: "output_contains" as const, text: "шаг" }],
	};
	const PLAIN_CASE = { input: "What is the refund window?", graders: [{ type: "output_contains" as const, text: "30 days" }] };

	/** One eval-run index, carrying the model that played the user in that arm. */
	function writeArm(runsRoot: string, evalRunId: string, userId: string | null, baselineEvalRunId: string | null): void {
		const model = modelFingerprint({
			provider: "qwen-internal", id: "qwen3.5-27b", api: "openai-completions",
			baseUrl: "http://127.0.0.1:9901/v1", apiKeyEnv: "TEST_MODEL_KEY",
			thinkingLevel: "off", params: {}, spec: {},
		});
		const provenance: ProvenanceAxes = {
			piVersion: "0.84.3",
			piSha: "a".repeat(40),
			ahdeVersion: "0.1.0",
			evaluatorId: AHDE_EVALUATOR_ID,
			provider: model.provider,
			modelId: model.id,
			modelApi: model.api,
			modelBaseUrl: model.baseUrl,
			modelApiKeyEnv: model.apiKeyEnv,
			thinkingLevel: model.thinkingLevel,
			params: model.params,
			modelSpec: model.spec,
			judge: null,
			...(userId ? { simulatedUser: { ...model, id: userId } } : {}),
			execution: executionFingerprint("isolated"),
			suiteHash: HASH,
			datasetHash: HASH,
		};
		const record: EvalRunRecord = {
			schemaVersion: 3,
			purpose: "evidence",
			evalRunId,
			target: { id: "test-target", gitSha: SHA },
			label: baselineEvalRunId ? "candidate" : "baseline",
			baselineEvalRunId,
			provenance,
			provenanceKey: hashValue(provenance),
			suiteId: "test-suite",
			suiteHash: provenance.suiteHash,
			dataset: "development",
			datasetHash: provenance.datasetHash,
			evidenceVisibility: "development",
			repetitions: 3,
			runIds: [],
			startedAt: NOW,
			finishedAt: LATER,
			summary: { total: 0, pass: 0, fail: 0, error: 0, allPassRate: 0 },
		};
		writeEvalRun(runsRoot, record);
	}

	/** A runs root of its own: eval indexes are immutable, so no scenario shares one. */
	function runsRootWith(arms: { baseline: string | null; candidate: string | null }): string {
		const root = makeTargetFixture([{ path: ".keep", content: "" }], false);
		roots.push(root);
		writeArm(root, "erun-a", arms.baseline, null);
		writeArm(root, "erun-b", arms.candidate, "erun-a");
		return root;
	}

	it("says the band is the simulator's only when the two arms measured with different ones", () => {
		const record = calibrationRecord();
		// No runs root: the old readers ask nothing about the simulator and get
		// exactly the projection they always got.
		expect(calibrationProjection(record)).not.toHaveProperty("simulator");
		// A runs root that cannot answer says nothing either; a lost receipt is
		// never a fact about the experiment.
		expect(calibrationProjection(record, join(SHA, "missing"))).not.toHaveProperty("simulator");
		// One simulator on both arms is an ordinary A/A of the harness.
		expect(calibrationProjection(record, runsRootWith({ baseline: "user-primary", candidate: "user-primary" })))
			.not.toHaveProperty("simulator");
		// Two different ones, and the model that actually ran is the one named.
		expect(calibrationProjection(
			record,
			runsRootWith({ baseline: "user-primary", candidate: "user-alternate" }),
			{ provider: "qwen-internal", id: "manifest-alternate" },
		)?.simulator).toEqual({ kind: "alternate", model: "qwen-internal/user-alternate" });
		// Evidence too old to record the second arm's model falls back to the
		// manifest block the caller passed, and to nothing without one.
		const legacy = runsRootWith({ baseline: "user-primary", candidate: null });
		expect(calibrationProjection(record, legacy, { provider: "qwen-internal", id: "manifest-alternate" })?.simulator)
			.toEqual({ kind: "alternate", model: "qwen-internal/manifest-alternate" });
		expect(calibrationProjection(record, legacy)).not.toHaveProperty("simulator");
	});

	it("runs the second arm with the declared alternate model and reports a simulator band", async () => {
		const paths = target(true);
		const runCalibration = vi.fn(async (options: { runsRoot: string }) => {
			// What a real experiment leaves behind: two development arms of one
			// revision, one of them measured with the other user model.
			writeArm(options.runsRoot, "erun-a", "user-primary", null);
			writeArm(options.runsRoot, "erun-b", "user-alternate", "erun-a");
			return { record: calibrationRecord({ taskCount: 2, improved: 0, regressed: 0 }) };
		});
		const workbench = createAhdeWorkbench({
			...paths,
			projectId: "test-target",
			dependencies: { now: () => NOW, runCalibration: runCalibration as never },
		});
		await workbench.submit({ kind: "spec-draft", spec: spec() });
		await workbench.decide({ kind: "approve-spec", reason: "Approve the simulator Spec" }, gate());
		await workbench.submit({
			kind: "corpus-draft",
			name: "Conversation basket",
			tasks: [CONVERSATION_CASE, PLAIN_CASE],
			coverageNotes: [],
			revisionSummary: "One conversation and one plain case",
		});
		await workbench.decide({ kind: "publish-corpus", reason: "Publish the conversation basket" }, gate());

		const calibrationGate = gate();
		const decided = await workbench.decide(
			{ kind: "calibrate", repetitions: 3, simulator: "alternate", reason: "Measure the simulator, not the agent" },
			calibrationGate,
		);

		// The human is asked about the user model by name, and approves a subject
		// that says which one the second arm will use.
		const confirmation = calibrationGate.confirm.mock.calls[0]?.[0];
		// `toContain`, because a Target nobody has priced yet wraps every question
		// in the cost guard's own sentence.
		expect(confirmation.question).toContain(t("confirm.calibrate.simulator", {
			model: "qwen-internal/user-alternate",
			runs: plural(12, "execution"),
		}));
		expect(confirmation.subject).toMatchObject({
			operation: "calibrate-noise",
			simulator: { alternate: "qwen-internal/user-alternate" },
		});
		expect(runCalibration).toHaveBeenCalledWith(expect.objectContaining({
			mode: "aa-calibration",
			origin: { kind: "manual", reason: "A/A simulator noise" },
			simulatorNoise: { model: expect.objectContaining({ provider: "qwen-internal", id: "user-alternate" }) },
		}));
		expect(decided.result.calibration).toMatchObject({
			simulator: { kind: "alternate", model: "qwen-internal/user-alternate" },
		});
		expect(decided.message).toContain("Simulator noise");
		expect(decided.message).toContain("qwen-internal/user-alternate");

		// And the panel says it too: a band nobody labelled would be read as the
		// harness's own noise.
		const sentence = t("noise.simulator", { model: "qwen-internal/user-alternate" });
		const panel = renderCalibration(decided.result.calibration as WorkbenchCalibrationProjection, plainPaint);
		// Wrapped into the panel's own column budget, so the sentence is whole
		// again once the lines are put back together.
		expect(panel.join(" ")).toContain(sentence);
		for (const line of panel) expect(line.length).toBeLessThanOrEqual(110);
		expect(renderCalibration(calibrationProjection(calibrationRecord())!, plainPaint).join(" "))
			.not.toContain(sentence);
	});

	it("refuses a simulator A/A without a second model, and one without a conversation to hold", async () => {
		const runCalibration = vi.fn();
		const withoutAlternate = createAhdeWorkbench({
			...target(false),
			projectId: "test-target",
			dependencies: { now: () => NOW, runCalibration: runCalibration as never },
		});
		for (const [workbench, tasks, message] of [
			[withoutAlternate, [CONVERSATION_CASE], /evalSuite\.simulatedUserAlternate/],
			[
				createAhdeWorkbench({
					...target(true),
					projectId: "test-target",
					dependencies: { now: () => NOW, runCalibration: runCalibration as never },
				}),
				[PLAIN_CASE],
				/at least one simulated-user case/,
			],
		] as const) {
			await workbench.submit({ kind: "spec-draft", spec: spec() });
			await workbench.decide({ kind: "approve-spec", reason: "Approve the Spec" }, gate());
			await workbench.submit({
				kind: "corpus-draft",
				name: "Basket",
				tasks: [...tasks],
				coverageNotes: [],
				revisionSummary: "One case",
			});
			await workbench.decide({ kind: "publish-corpus", reason: "Publish the basket" }, gate());
			await expect(workbench.decide(
				{ kind: "calibrate", repetitions: 3, simulator: "alternate", reason: "Measure the simulator" },
				gate(),
			)).rejects.toThrow(message);
			// A plain A/A of the same Target is still legal: only the simulator arm
			// is refused, and nothing was spent finding that out.
			expect(runCalibration).not.toHaveBeenCalled();
		}
	});
});
