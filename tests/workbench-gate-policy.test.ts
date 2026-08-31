import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPolicyAwareGate } from "../src/builder/workbench-adapter.js";
import type { WorkbenchConfirmation } from "../src/workbench/types.js";
import { createHostContext } from "./helpers/builder-tools.js";
import { writeEvalRun, type EvalRunRecord } from "../src/eval.js";
import {
	RunRecordSchema,
	executionFingerprint,
	hashValue,
	modelFingerprint,
	provenanceAxes,
	provenanceKey,
	type RunRecord,
} from "../src/provenance.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";
import {
	DEFAULT_ROUTINE_COST_USD,
	DEFAULT_ROUTINE_MINUTES,
	WORKBENCH_GATE_POLICY,
	assertWorkbenchDecisionStage,
	estimateRunCost,
	routineCostBounds,
	routineCostGuard,
	workbenchDecisionStages,
	workbenchGateClass,
} from "../src/workbench/transition-policy.js";

const TARGET_ID = "gate-policy-target";
const GIT_SHA = "a".repeat(40);
const created: string[] = [];

afterEach(() => {
	while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

function runsRootWith(runs: readonly { costUsd: number; seconds: number }[], targetId = TARGET_ID): string {
	const runsRoot = mkdtempSync(join(tmpdir(), "ahde-gate-policy-"));
	created.push(runsRoot);
	if (runs.length === 0) return runsRoot;
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
		baseUrl: "https://example.invalid/v1",
		apiKeyEnv: "TEST_KEY",
		thinkingLevel: "off",
		params: {},
		spec: {},
	});
	const execution = executionFingerprint("isolated");
	const evaluation = {
		suiteId: "suite",
		suiteHash: `sha256:${"d".repeat(64)}`,
		dataset: "development",
		datasetHash: `sha256:${"e".repeat(64)}`,
	};
	const evalRunId = "erun_gate_policy_1";
	const runIds: string[] = [];
	const artifacts: { runId: string; sha256: string }[] = [];
	runs.forEach((sample, index) => {
		const runId = `run_gate_policy_${index}`;
		const started = new Date(Date.UTC(2026, 7, 28, 12, 0, 0));
		const finished = new Date(started.getTime() + sample.seconds * 1_000);
		const record: RunRecord = {
			schemaVersion: 1,
			runId,
			taskId: `task-${index}`,
			repetitionIndex: 0,
			label: "solo",
			status: "completed",
			error: null,
			startedAt: started.toISOString(),
			finishedAt: finished.toISOString(),
			target: { id: targetId, gitSha: GIT_SHA },
			runtime,
			model,
			execution,
			eval: evaluation,
			trace: { path: "session.jsonl", sessionId: null, sha256: null },
			metrics: {
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				costUsd: sample.costUsd,
				latencyMs: sample.seconds * 1_000,
				toolCalls: 0,
				toolErrors: 0,
				recoveryAttempts: 0,
			},
			evalResults: null,
			parent: { evalRunId, candidateOf: null },
		};
		mkdirSync(join(runsRoot, runId), { recursive: true });
		writeJsonArtifact(join(runsRoot, runId, "run.json"), RunRecordSchema, record);
		runIds.push(runId);
		artifacts.push({ runId, sha256: hashValue(record) });
	});
	const evidence = { runtime, model, judge: null, execution, eval: evaluation };
	const index: EvalRunRecord = {
		schemaVersion: 2,
		evalRunId,
		target: { id: targetId, gitSha: GIT_SHA },
		label: "solo",
		baselineEvalRunId: null,
		provenance: provenanceAxes(evidence),
		provenanceKey: provenanceKey(evidence),
		suiteId: evaluation.suiteId,
		suiteHash: evaluation.suiteHash,
		dataset: evaluation.dataset,
		datasetHash: evaluation.datasetHash,
		evidenceVisibility: "development",
		repetitions: 1,
		runIds,
		runArtifacts: artifacts,
		startedAt: "2026-08-28T12:00:00.000Z",
		finishedAt: "2026-08-28T12:10:00.000Z",
		summary: { total: runs.length, pass: runs.length, fail: 0, error: 0, allPassRate: 1 },
	};
	writeEvalRun(runsRoot, index);
	return runsRoot;
}

describe("Workbench gate policy", () => {
	it("asks for exactly three product moments and lets measurement run", () => {
		// The whole table, in one place: this is the product promise.
		expect(WORKBENCH_GATE_POLICY).toEqual({
			// One-time bootstrap of a real repository.
			"scaffold-target": "consequential",
			"configure-target": "consequential",
			// The judge and the user model commit to manifest.yaml too, and they
			// decide what every later measurement is measured with.
			"configure-evaluators": "consequential",
			// The three moments a normal cycle asks about.
			"start-testing": "consequential",
			"apply-proposal": "consequential",
			ship: "consequential",
			// Fine-grained authority, kept for the CLI, scripts and recovery.
			"approve-spec": "consequential",
			"publish-corpus": "consequential",
			"import-dataset": "consequential",
			"review-candidate": "consequential",
			"promote-candidate": "consequential",
			"adopt-candidate": "consequential",
			"continue-cycle": "consequential",
			// Terminal throw-aways: one short question, never a dialog.
			"discard-proposal": "one-question",
			"reject-candidate": "one-question",
			"abandon-candidate": "one-question",
			// Measurement: it just runs, under a cost guard.
			"run-current": "routine",
			"run-eval": "routine",
			calibrate: "routine",
			"verify-candidate": "routine",
			improve: "routine",
		});
		expect(workbenchGateClass("ship")).toBe("consequential");
		expect(workbenchGateClass("run-current")).toBe("routine");
	});

	it("admits the composites exactly where a step of them is still pending", () => {
		expect(workbenchDecisionStages("start-testing")).toEqual(["spec-review", "corpus-review"]);
		expect(workbenchDecisionStages("ship")).toEqual([
			"candidate-review",
			"release-decision",
			"candidate-adoption",
			"complete",
		]);
		for (const stage of ["spec-review", "corpus-review"] as const) {
			expect(() => assertWorkbenchDecisionStage("start-testing", stage)).not.toThrow();
		}
		for (const stage of ["candidate-review", "release-decision", "candidate-adoption", "complete"] as const) {
			expect(() => assertWorkbenchDecisionStage("ship", stage)).not.toThrow();
		}
	});

	it("fails an illegal transition closed and names the one thing that unblocks it", () => {
		expect(() => assertWorkbenchDecisionStage("start-testing", "improvement-authoring"))
			.toThrow(/start-testing is not legal during improvement-authoring/);
		expect(() => assertWorkbenchDecisionStage("start-testing", "improvement-authoring"))
			.toThrow(/Do this first: look at the failures, then say “fix it”\./);
		expect(() => assertWorkbenchDecisionStage("ship", "proposal-review"))
			.toThrow(/Do this first: review the diff, then say “apply” or “discard”\./);
		expect(() => assertWorkbenchDecisionStage("run-eval", "spec-review"))
			.toThrow(/Do this first: review the Spec draft, then say “tests”\./);
	});
});

describe("host gate", () => {
	function confirmation(
		policy: "consequential" | "one-question" | "routine",
		kind: "apply-proposal" | "discard-proposal" | "run-eval",
	): WorkbenchConfirmation {
		return {
			kind,
			title: `Confirm ${kind}`,
			reason: "The operator asked for it",
			subject: { operation: kind, branch: "candidate/fix" },
			subjectHash: `sha256:${"a".repeat(64)}`,
			policy,
			question: `${kind}, yes or no?`,
		};
	}

	it("renders a full dialog, one question, or nothing at all", async () => {
		const host = createHostContext();
		const guard = vi.fn();
		const gate = createPolicyAwareGate(host.ctx, () => "local:gate-test", guard);

		expect(await gate.confirm(confirmation("consequential", "apply-proposal")))
			.toEqual({ approved: true, actorId: "local:gate-test" });
		expect(await gate.confirm(confirmation("one-question", "discard-proposal")))
			.toEqual({ approved: true, actorId: "local:gate-test" });
		expect(await gate.confirm(confirmation("routine", "run-eval")))
			.toEqual({ approved: true, actorId: "local:gate-test" });

		// Two dialogs for three decisions, and the terminal one is one sentence.
		expect(host.confirmations.map((entry) => entry.title))
			.toEqual(["Confirm apply-proposal", "Confirm discard-proposal"]);
		expect(host.confirmations[1]?.body).toBe("discard-proposal, yes or no?");
		expect(host.confirmations[0]?.body).toContain("The operator asked for it");
		expect(host.confirmations[0]?.body.length).toBeGreaterThan(host.confirmations[1]!.body.length);
		expect(guard.mock.calls.flat()).toEqual(["apply-proposal", "discard-proposal"]);
	});

	it("lets routine work run headless and still fails everything else closed", async () => {
		const host = createHostContext({ hasUI: false, mode: "print" });
		const guard = vi.fn((operation: string) => {
			throw new Error(`${operation} requires a local TUI host confirmation`);
		});
		const gate = createPolicyAwareGate(host.ctx, () => "local:gate-test", guard);

		expect(await gate.confirm(confirmation("routine", "run-eval")))
			.toEqual({ approved: true, actorId: "local:gate-test" });
		expect(guard).not.toHaveBeenCalled();
		await expect(gate.confirm(confirmation("one-question", "discard-proposal")))
			.rejects.toThrow(/requires a local TUI host confirmation/);
		await expect(gate.confirm(confirmation("consequential", "apply-proposal")))
			.rejects.toThrow(/requires a local TUI host confirmation/);
		expect(host.confirmations).toEqual([]);
	});

	it("carries a declined answer back without an actor identity", async () => {
		const host = createHostContext({ confirm: false });
		const gate = createPolicyAwareGate(host.ctx, () => "local:gate-test", vi.fn());
		expect(await gate.confirm(confirmation("one-question", "discard-proposal"))).toEqual({ approved: false });
		expect(await gate.confirm(confirmation("consequential", "apply-proposal"))).toEqual({ approved: false });
	});
});

describe("routine cost guard", () => {
	it("estimates cost and wall-clock from the most recent comparable runs", () => {
		const runsRoot = runsRootWith([
			{ costUsd: 0.02, seconds: 30 },
			{ costUsd: 0.04, seconds: 90 },
		]);
		const estimate = estimateRunCost({ runsRoot, targetId: TARGET_ID, executions: 20, jobs: 4 });
		expect(estimate.sampledRuns).toBe(2);
		expect(estimate.executions).toBe(20);
		// Mean $0.03 per execution over 20 executions.
		expect(estimate.costUsd).toBeCloseTo(0.6, 10);
		// Mean 60 s per execution, four at a time: 20 × 60 / 4 = 5 minutes.
		expect(estimate.minutes).toBeCloseTo(5, 10);
		expect(routineCostGuard(estimate)).toBeNull();

		// The same history over a bigger design crosses the wall-clock bound.
		const bigger = estimateRunCost({ runsRoot, targetId: TARGET_ID, executions: 60, jobs: 4 });
		expect(bigger.minutes).toBeCloseTo(15, 10);
		expect(routineCostGuard(bigger)).toMatch(/about 15 minutes — over the 10-minute routine bound/);
		expect(routineCostGuard(bigger, { AHDE_ROUTINE_MINUTES: "30" })).toBeNull();
	});

	it("stays silent for a cheap, short run", () => {
		const runsRoot = runsRootWith([{ costUsd: 0.001, seconds: 2 }]);
		const estimate = estimateRunCost({ runsRoot, targetId: TARGET_ID, executions: 12, jobs: 4 });
		expect(estimate.sampledRuns).toBe(1);
		expect(estimate.costUsd).toBeCloseTo(0.012, 10);
		expect(estimate.minutes).toBeCloseTo(0.1, 10);
		expect(routineCostGuard(estimate)).toBeNull();
	});

	it("asks when nothing comparable has ever finished", () => {
		const empty = runsRootWith([]);
		const unknown = estimateRunCost({ runsRoot: empty, targetId: TARGET_ID, executions: 40, jobs: 4 });
		expect(unknown).toMatchObject({ sampledRuns: 0, costUsd: null, minutes: null });
		expect(routineCostGuard(unknown)).toMatch(/no comparable run has finished yet/);

		// Another Target's history is not this Target's estimate.
		const foreign = runsRootWith([{ costUsd: 0.01, seconds: 1 }], "another-agent");
		expect(estimateRunCost({ runsRoot: foreign, targetId: TARGET_ID, executions: 4, jobs: 4 }).sampledRuns).toBe(0);

		// A missing runs root is unknown, never a crash.
		expect(estimateRunCost({ runsRoot: join(empty, "missing"), targetId: TARGET_ID, executions: 4, jobs: 1 }))
			.toMatchObject({ sampledRuns: 0, costUsd: null });
	});

	it("asks when the money is over the bound, and honours the environment overrides", () => {
		const runsRoot = runsRootWith([{ costUsd: 0.5, seconds: 1 }]);
		const estimate = estimateRunCost({ runsRoot, targetId: TARGET_ID, executions: 10, jobs: 4 });
		expect(estimate.costUsd).toBeCloseTo(5, 10);
		expect(routineCostGuard(estimate)).toMatch(/about \$5\.00 — over the \$2 routine bound/);
		expect(routineCostGuard(estimate, { AHDE_ROUTINE_COST_USD: "20" })).toBeNull();
		expect(routineCostGuard(estimate, { AHDE_ROUTINE_COST_USD: "0" })).toMatch(/over the \$0 routine bound/);
		// Nonsense bounds fall back to the defaults rather than disabling the guard.
		expect(routineCostBounds({ AHDE_ROUTINE_COST_USD: "free", AHDE_ROUTINE_MINUTES: "-3" }))
			.toEqual({ costUsd: DEFAULT_ROUTINE_COST_USD, minutes: DEFAULT_ROUTINE_MINUTES });
		expect(routineCostBounds({})).toEqual({ costUsd: 2, minutes: 10 });
	});

	it("never asks about a run with nothing in it", () => {
		const runsRoot = runsRootWith([]);
		expect(routineCostGuard(estimateRunCost({ runsRoot, targetId: TARGET_ID, executions: 0, jobs: 1 }))).toBeNull();
	});
});
