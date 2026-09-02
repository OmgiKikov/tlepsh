import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { recordBuilderAuthoredProposal } from "../src/application/builder-authoring.js";
import { loadBuilderApplyReceipt } from "../src/application/builder-proposal.js";
import { CANDIDATE_SCOPE_POLICY, CandidateExperimentError } from "../src/application/candidate-experiment.js";
import { compileHarnessAuthoringProposal } from "../src/application/harness-authoring.js";
import { createPolicyAwareGate } from "../src/builder/workbench-adapter.js";
import { createCorpus, listCorpora } from "../src/corpus.js";
import { loadTarget } from "../src/manifest.js";
import {
	createAhdeWorkbench,
	type AhdeWorkbench,
	type AhdeWorkbenchDependencies,
} from "../src/workbench/index.js";
import type { WorkbenchConfirmation } from "../src/workbench/types.js";
import { createHostContext } from "./helpers/builder-tools.js";
import {
	NOW,
	PROJECT_ID,
	gate,
	git,
	spec,
	targetPaths,
	task,
	writeDevelopmentEval,
	type FixturePaths,
	type RecordingGate,
} from "./helpers/cycle-fixtures.js";
import { SEALED_VERIFICATION_REPETITIONS, sealedHoldoutTasks } from "./helpers/sealed-holdout.js";
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
	AUTHORIZED_RUN_HEADROOM,
	DEFAULT_ROUTINE_COST_USD,
	DEFAULT_ROUTINE_MINUTES,
	WORKBENCH_GATE_POLICY,
	assertWorkbenchDecisionStage,
	authorizedRunCovers,
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

function runsRootWith(
	runs: readonly { costUsd: number; seconds: number }[],
	targetId = TARGET_ID,
	into?: string,
): string {
	const runsRoot = into ?? mkdtempSync(join(tmpdir(), "ahde-gate-policy-"));
	if (!into) created.push(runsRoot);
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
		schemaVersion: 3,
		purpose: "evidence" as const,
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
			// The judge writing the exam spends money and creates the artifact
			// promotion is measured against: always the full dialog.
			"generate-holdout": "consequential",
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
			// Cheapest measurement there is: it re-scores answers already bought
			// and calls no Target at all. The guard still prices the judge.
			regrade: "routine",
			"verify-candidate": "routine",
				improve: "consequential",
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

	it("stays silent for a measurement an earlier dialog already priced", () => {
		const runsRoot = runsRootWith([{ costUsd: 0.5, seconds: 60 }]);
		const estimate = estimateRunCost({ runsRoot, targetId: TARGET_ID, executions: 20, jobs: 4 });
		expect(estimate).toMatchObject({ costUsd: 10, minutes: 5 });
		// $10 was on screen at apply time; the check that follows costs $10.
		expect(routineCostGuard(estimate, {}, { costUsd: 10, minutes: 5 })).toBeNull();
		// Drift is drift: half as much again is still the same decision.
		expect(routineCostGuard(estimate, {}, { costUsd: 7, minutes: 4 })).toBeNull();
		expect(authorizedRunCovers(estimate, { costUsd: 10 / AUTHORIZED_RUN_HEADROOM, minutes: 5 })).toBe(true);
		// Beyond it, the operator is being asked about a different amount.
		expect(routineCostGuard(estimate, {}, { costUsd: 6, minutes: 5 }))
			.toMatch(/about \$10\.00 — over the \$2 routine bound/);
		// Time is authorized the same way money is, and the guard names whichever
		// bound it crosses first.
		expect(authorizedRunCovers(estimate, { costUsd: 10, minutes: 3 })).toBe(false);
		expect(routineCostGuard(estimate, { AHDE_ROUTINE_COST_USD: "100", AHDE_ROUTINE_MINUTES: "4" }, { costUsd: 10, minutes: 3 }))
			.toMatch(/about 5 minutes — over the 4-minute routine bound/);
		// Nothing authorized, and an amount nobody could read when it was given,
		// authorize nothing at all.
		expect(routineCostGuard(estimate, {}, null)).toMatch(/over the \$2 routine bound/);
		expect(routineCostGuard(estimate, {}, { costUsd: null, minutes: null }))
			.toMatch(/over the \$2 routine bound/);
		// An amount that has become unknowable is a question again.
		const unknown = estimateRunCost({ runsRoot: runsRootWith([]), targetId: TARGET_ID, executions: 20, jobs: 4 });
		expect(routineCostGuard(unknown, {}, { costUsd: 10, minutes: 5 }))
			.toMatch(/no comparable run has finished yet/);
	});
});

// ---------------------------------------------------------------------------
// The money question, asked once per cycle.
// ---------------------------------------------------------------------------

/** Spec → basket → baseline eval → proposal → apply, against a gate we can read. */
async function appliedProposalFixture(
	human: RecordingGate,
	dependencies: Partial<AhdeWorkbenchDependencies> = {},
	/** How big the operator's own basket is, and how big the manifest dataset is. */
	basket: { developmentTasks?: number; manifestTasks?: number } = {},
): Promise<{ paths: FixturePaths; workbench: AhdeWorkbench; runId: string }> {
	const paths = targetPaths();
	created.push(paths.projectDir);
	if (basket.manifestTasks !== undefined) {
		// A template `evals/development.jsonl` nobody wrote cases into. Nothing in
		// a Builder cycle may ever measure it; it is here to be visibly not used.
		writeFileSync(
			join(paths.projectDir, "evals", "development.jsonl"),
			`${Array.from({ length: basket.manifestTasks }, (_, index) =>
				JSON.stringify({ id: `template_${index}`, input: `Template case ${index}`, graders: [{ type: "output_contains", text: "30 days" }] })).join("\n")}\n`,
			"utf8",
		);
		git(paths.projectDir, "add", "evals/development.jsonl");
		git(paths.projectDir, "commit", "-qm", "template dataset");
	}
	const workbench = createAhdeWorkbench({
		...paths,
		projectId: PROJECT_ID,
		dependencies: { now: () => NOW, ...dependencies },
	});
	await workbench.submit({ kind: "spec-draft", spec: spec() });
	const approved = await workbench.decide({ kind: "approve-spec", reason: "Approve the exact Spec" }, human);
	await workbench.submit({
		kind: "corpus-draft",
		name: "Authorization development basket",
		tasks: Array.from({ length: basket.developmentTasks ?? 1 }, (_, index) =>
			task(`What is the refund window for policy ${index}?`)),
		coverageNotes: ["One policy question"],
		revisionSummary: "Initial basket",
	});
	const published = await workbench.decide({ kind: "publish-corpus", reason: "Publish the exact basket" }, human);
	// A baseline that really cost something, so the guard has an amount to
	// object to and the estimate has history to read.
	writeDevelopmentEval(paths, published.result.corpusId, "erun_authorization_baseline", {
		costUsd: 1,
		latencyMs: 6_000,
	});
	// The exam exists before the diff does, exactly as it must: the price of the
	// check is only honest when the holdout it will run is already reserved.
	createCorpus({
		stateRoot: paths.stateRoot,
		projectId: PROJECT_ID,
		name: "Evaluator-only authorization holdout",
		visibility: "sealed",
		tasks: sealedHoldoutTasks("PRIVATE AUTHORIZATION HOLDOUT"),
	});
	const recorded = await recordBuilderAuthoredProposal({
		proposal: compileHarnessAuthoringProposal({
			repositoryDir: paths.projectDir,
			intents: [{ type: "instructions.replace", content: "# Authorized\n\nAnswer only from approved local evidence.\n" }],
			summary: "Make the evidence boundary explicit",
			diagnoses: [],
			risks: ["Instruction-only behavior change"],
			validationPlan: ["Re-run the reviewed development basket"],
		}),
		targetDir: paths.projectDir,
		allowedPaths: [...CANDIDATE_SCOPE_POLICY.allowed],
		approvedSpec: { stateRoot: paths.stateRoot, projectId: PROJECT_ID, specId: approved.result.approvedSpecId },
		runsRoot: paths.runsRoot,
		timeoutMs: 30_000,
	});
	await workbench.decide({
		kind: "apply-proposal",
		runId: recorded.record.runId,
		branch: "candidate/authorized",
		reason: "Apply the exact reviewed diff",
	}, human);
	return { paths, workbench, runId: recorded.record.runId };
}

/** Rewrite the immutable receipt: what a candidate applied another way looks like. */
function rewriteAuthorization(
	paths: FixturePaths,
	runId: string,
	authorization: { executions: number; sampledRuns: number; costUsd: number | null; minutes: number | null } | null,
): void {
	const path = join(paths.runsRoot, "builders", runId, "apply_receipt.json");
	const receipt = { ...loadBuilderApplyReceipt(paths.runsRoot, runId) };
	if (authorization) receipt.verificationAuthorization = authorization;
	else delete receipt.verificationAuthorization;
	rmSync(path);
	writeFileSync(path, `${JSON.stringify(receipt, null, "\t")}\n`, "utf8");
}

describe("one money question per cycle", () => {
	/** The verification stops here, right after the gate has had its chance. */
	function stopAtTheMeasurement(): {
		measured: Mock;
		dependencies: Partial<AhdeWorkbenchDependencies>;
	} {
		const measured = vi.fn(async () => {
			throw new Error("fixture stop: the measurement itself is not what this test spends");
		});
		return { measured, dependencies: { runAppliedCandidate: measured as never } };
	}

	/**
	 * Questions, not gate calls: a routine decision still passes through the
	 * gate for its actor identity, and the host shows no dialog for it.
	 */
	function questions(human: RecordingGate): number {
		return human.confirm.mock.calls.filter((call) => call[0].policy !== "routine").length;
	}

	async function verify(workbench: AhdeWorkbench, human: RecordingGate, measured: Mock): Promise<void> {
		const before = measured.mock.calls.length;
		await expect(workbench.decide({
			kind: "verify-candidate",
			repetitions: SEALED_VERIFICATION_REPETITIONS,
			reason: "Check the applied candidate",
		}, human)).rejects.toThrow(/candidate verification failed/);
		// The gate had its chance and the measurement was reached: whatever the
		// gate did or did not ask, it did it here.
		expect(measured.mock.calls.length).toBe(before + 1);
	}

	it("prices the check on the apply dialog, records it, and does not ask again", async () => {
		const human = gate();
		const { measured, dependencies } = stopAtTheMeasurement();
		const { paths, workbench, runId } = await appliedProposalFixture(human, dependencies);
		const apply = human.confirm.mock.calls.at(-1)?.[0];
		expect(apply).toMatchObject({ kind: "apply-proposal", policy: "consequential" });
		// A construction diff attests no basket, but the check still runs the
		// published development corpus of its Spec: 1 development case plus the
		// 15-case exam, both arms, at the repetitions “check it” uses.
		expect(apply?.estimate).toMatchObject({ executions: 2 * (1 + 15) * 3, sampledRuns: 1 });
		expect(apply?.estimate?.costUsd).toBeGreaterThan(DEFAULT_ROUTINE_COST_USD);

		// The receipt of this exact candidate carries exactly what was on screen.
		const receipt = loadBuilderApplyReceipt(paths.runsRoot, runId);
		expect(receipt.schemaVersion).toBe(4);
		expect(receipt.verificationAuthorization).toEqual(apply?.estimate);

		// The check itself is cheaper than what was authorized, so it just runs:
		// the sealed holdout is still selected, but nothing is asked.
		const asked = questions(human);
		await verify(workbench, human, measured);
		expect(human.selectSealed).toHaveBeenCalledTimes(1);
		expect(questions(human)).toBe(asked);
	}, 60_000);

	it("asks again when nothing was authorized, when the amount grew, and when it was unknown", async () => {
		const human = gate();
		const { measured, dependencies } = stopAtTheMeasurement();
		const { paths, workbench, runId } = await appliedProposalFixture(human, dependencies);
		const authorized = loadBuilderApplyReceipt(paths.runsRoot, runId).verificationAuthorization;
		if (!authorized) throw new Error("the apply dialog recorded no authorization");

		// A candidate applied outside the dialog — no diff was read, no price shown.
		rewriteAuthorization(paths, runId, null);
		let asked = questions(human);
		await verify(workbench, human, measured);
		expect(questions(human)).toBe(asked + 1);
		expect(human.confirm.mock.calls.at(-1)?.[0]).toMatchObject({ kind: "verify-candidate", policy: "one-question" });
		expect(human.confirm.mock.calls.at(-1)?.[0].question).toMatch(/over the \$2 routine bound/);

		// An amount far under what the check now costs.
		rewriteAuthorization(paths, runId, { ...authorized, costUsd: (authorized.costUsd ?? 0) / 10, minutes: 0.001 });
		asked = questions(human);
		await verify(workbench, human, measured);
		expect(questions(human)).toBe(asked + 1);

		// Unknown when it was given: nothing was on screen, so nothing was approved.
		rewriteAuthorization(paths, runId, { ...authorized, costUsd: null, minutes: null });
		asked = questions(human);
		await verify(workbench, human, measured);
		expect(questions(human)).toBe(asked + 1);

		// Restored, it is silent again.
		rewriteAuthorization(paths, runId, authorized);
		asked = questions(human);
		await verify(workbench, human, measured);
		expect(questions(human)).toBe(asked);
	}, 60_000);
});

// ---------------------------------------------------------------------------
// Which basket the check actually runs.
// ---------------------------------------------------------------------------

describe("the development arm of a verification", () => {
	it("runs the published basket of the Spec, never the manifest dataset", async () => {
		const human = gate();
		const measured = vi.fn(async (_options: { developmentCorpus?: { corpusId: string } }) => {
			throw new Error("fixture stop: the measurement itself is not what this test spends");
		});
		const { workbench } = await appliedProposalFixture(
			human,
			{ runAppliedCandidate: measured as never },
			{ developmentTasks: 6, manifestTasks: 30 },
		);
		await expect(workbench.decide({
			kind: "verify-candidate",
			repetitions: SEALED_VERIFICATION_REPETITIONS,
			reason: "Check the applied candidate",
		}, human)).rejects.toThrow(/candidate verification failed/);

		// This is a construction proposal: `request.sourceAttestation` is null, and
		// reading the basket off the attestation left it undefined — which made the
		// experiment fall back to `evals/development.jsonl` and report a verdict
		// over 30 template cases the operator never wrote.
		const asked = human.confirm.mock.calls.at(-1)?.[0] as WorkbenchConfirmation;
		expect(asked.kind).toBe("verify-candidate");
		const subject = asked.subject as Record<string, unknown>;
		const corpus = subject.developmentCorpus as { id: string; taskCount: number };
		expect(corpus.taskCount).toBe(6);
		expect(asked.question).toContain(`${2 * (6 + 15) * SEALED_VERIFICATION_REPETITIONS} Target executions`);
		expect(asked.estimate?.executions).toBe(2 * (6 + 15) * SEALED_VERIFICATION_REPETITIONS);

		// And the experiment is handed that exact corpus, not a dataset override.
		expect(measured).toHaveBeenCalledTimes(1);
		expect(measured.mock.calls[0]?.[0].developmentCorpus).toMatchObject({ corpusId: corpus.id });
	}, 60_000);

	it("names the reason when the check stops in the development arms, and hides it when it stops in the exam", async () => {
		// The fifth live session: one candidate run errored, the comparison was
		// inconclusive, and the operator read "failed after the sealed gate" —
		// wrong phase, no reason, no way out.
		for (const [phase, expected] of [
			["development", /stopped before the exam: inconclusive: candidate task task-1 errored.*abandon the interrupted attempt/],
			["sealed", /during the sealed exam; sealed identities and contents remain hidden.*Abandon the interrupted attempt/],
		] as const) {
			const human = gate();
			const measured = vi.fn(async () => {
				throw new CandidateExperimentError(
					"candidate experiment stopped at validated: inconclusive: candidate task task-1 errored (baseline=erun-a, candidate=erun-b)",
					"/private/runs/candidates/candidate-1/candidate.json",
					{ phase },
				);
			});
			const { workbench } = await appliedProposalFixture(human, { runAppliedCandidate: measured as never });
			await expect(workbench.decide({
				kind: "verify-candidate",
				repetitions: SEALED_VERIFICATION_REPETITIONS,
				reason: "Check the applied candidate",
			}, human)).rejects.toThrow(expected);
			if (phase === "sealed") {
				await expect(workbench.decide({
					kind: "verify-candidate",
					repetitions: SEALED_VERIFICATION_REPETITIONS,
					reason: "Check the applied candidate",
				}, human)).rejects.not.toThrow(/candidate\.json|task-1/);
			}
		}
	}, 120_000);

	it("refuses the check when the Spec has no published basket at all", async () => {
		const human = gate();
		const measured = vi.fn(async () => {
			throw new Error("the verification must never run without a development basket");
		});
		const { paths, workbench } = await appliedProposalFixture(human, { runAppliedCandidate: measured as never });
		// Take the published basket away and leave the exam: without the
		// operator's own cases there is no before/after to measure at all.
		for (const corpus of listCorpora({ stateRoot: paths.stateRoot, projectId: PROJECT_ID })) {
			if (corpus.visibility !== "development") continue;
			rmSync(join(paths.stateRoot, "projects", PROJECT_ID, "corpora", corpus.id), { recursive: true, force: true });
		}
		await expect(workbench.decide({
			kind: "verify-candidate",
			repetitions: SEALED_VERIFICATION_REPETITIONS,
			reason: "Check the applied candidate",
		}, human)).rejects.toThrow(/No compatible development corpus is available.*publish-corpus — legal at this stage/);
		expect(measured).not.toHaveBeenCalled();
	}, 60_000);
});
