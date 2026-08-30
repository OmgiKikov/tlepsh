import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	CHEAP_CHECK_REPETITIONS,
	CHEAP_CHECK_SCREEN_LABEL,
	CheapCheckError,
	cheapCheckPlanForCandidate,
	isScreenEvalRun,
	renderCheapCheckLine,
	resolveFailedTaskIds,
	runCheapCheck,
	screenEvalRunIds,
	type CheapCheckResult,
} from "../src/application/cheap-check.js";
import { loadCorpus } from "../src/corpus.js";
import { targetWithDevelopmentCorpus } from "../src/application/corpus-target.js";
import {
	DEFAULT_BASELINE_MAX_AGE_MS,
	findReusableBaseline,
	loadEvalRun,
	loadVerifiedEvalRun,
} from "../src/eval.js";
import { loadTarget } from "../src/manifest.js";
import { computeTargetWorkspaceHash } from "../src/runner.js";
import type { CandidateRecord } from "../src/domain/candidate.js";
import { SEALED_VERIFICATION_REPETITIONS } from "./helpers/sealed-holdout.js";
import {
	approvingGate,
	git,
	improveFixture,
	NO_OP_INSTRUCTION,
	READY_INSTRUCTION,
	recordFixtureProposal,
	type ImproveFixture,
} from "./helpers/improve-fixtures.js";

let fixture: ImproveFixture;
let fixSha: string;
let noopSha: string;

/** Commit one instruction change on its own branch without moving the checkout. */
function branchWithInstruction(name: string, instruction: string): string {
	const agents = join(fixture.projectDir, "AGENTS.md");
	const before = git(fixture.projectDir, "rev-parse", "HEAD");
	git(fixture.projectDir, "checkout", "-q", "-b", name);
	writeFileSync(agents, `# Improve fixture\n\n${instruction}\n`);
	git(fixture.projectDir, "add", "AGENTS.md");
	git(fixture.projectDir, "commit", "-qm", `fixture: ${name}`);
	const sha = git(fixture.projectDir, "rev-parse", "HEAD");
	git(fixture.projectDir, "checkout", "-q", fixture.branch);
	git(fixture.projectDir, "reset", "-q", "--hard", before);
	return sha;
}

beforeAll(async () => {
	fixture = await improveFixture();
	fixSha = branchWithInstruction("candidate/fix", READY_INSTRUCTION);
	noopSha = branchWithInstruction("candidate/noop", NO_OP_INSTRUCTION);
}, 120_000);

afterAll(async () => {
	await fixture?.close();
});

describe("cheap check — the screen before the expensive measurement", () => {
	it("screens exactly the cases the source eval recorded as failing, once", async () => {
		const source = loadVerifiedEvalRun(fixture.runsRoot, fixture.evalRunId);
		expect(source.record.summary.pass).toBe(0);
		const failed = resolveFailedTaskIds(source.runs);
		expect(failed).toHaveLength(2);

		const screen = await runCheapCheck({
			repositoryDir: fixture.projectDir,
			runsRoot: fixture.runsRoot,
			candidateRef: fixSha,
			baselineRef: fixture.baselineSha,
			sourceEvalRunId: fixture.evalRunId,
			developmentCorpus: {
				stateRoot: fixture.stateRoot,
				projectId: fixture.projectId,
				corpusId: fixture.corpusId,
			},
		});

		expect(screen.tasks).toEqual(failed);
		expect(screen.verdict).toBe("promising");
		expect(screen.improved).toBe(2);
		expect(screen.unchanged).toBe(0);
		expect(screen.regressed).toBe(0);
		expect(screen.inconclusive).toBe(0);
		expect(screen.withinErrorBudget).toBe(true);
		// The whole point: one run per previously failing case, one arm. The
		// verification it replaces would have been 2 arms × every case × 2 reps.
		expect(screen.runIds).toHaveLength(failed.length * CHEAP_CHECK_REPETITIONS);
		expect(screen.candidateSha).toBe(fixSha);
		expect(renderCheapCheckLine(screen)).toContain("screen promising");
	}, 120_000);

	it("calls a change that fixes nothing flat", async () => {
		const screen = await runCheapCheck({
			repositoryDir: fixture.projectDir,
			runsRoot: fixture.runsRoot,
			candidateRef: noopSha,
			baselineRef: fixture.baselineSha,
			sourceEvalRunId: fixture.evalRunId,
			developmentCorpus: {
				stateRoot: fixture.stateRoot,
				projectId: fixture.projectId,
				corpusId: fixture.corpusId,
			},
		});
		expect(screen.verdict).toBe("flat");
		expect(screen.improved).toBe(0);
		expect(screen.unchanged).toBe(2);
		expect(screen.rows.every((row) => row.screenOutcome === "fail")).toBe(true);
	}, 120_000);

	it("keeps every screen outside the reusable set and marks it as a screen", async () => {
		const screens = screenEvalRunIds(fixture.runsRoot);
		expect(screens.size).toBeGreaterThanOrEqual(2);

		for (const evalRunId of screens) {
			const record = loadEvalRun(fixture.runsRoot, evalRunId);
			// `solo` is the treatment `regrade` got: never reused as a baseline, and
			// the schema forbids it from naming one, so it can never stand in for a
			// candidate arm either.
			expect(record.label).toBe(CHEAP_CHECK_SCREEN_LABEL);
			expect(record.label).not.toBe("baseline");
			expect(record.label).not.toBe("candidate");
			expect(record.baselineEvalRunId).toBeNull();
			expect(record.evidenceVisibility).toBe("development");
			expect(isScreenEvalRun(fixture.runsRoot, evalRunId)).toBe(true);
		}

		// The one query a matched verification ever makes cannot see a screen.
		const corpus = loadCorpus({
			stateRoot: fixture.stateRoot,
			projectId: fixture.projectId,
			corpusId: fixture.corpusId,
		});
		const screenTarget = targetWithDevelopmentCorpus(loadTarget(fixture.projectDir), corpus);
		const anyScreen = loadEvalRun(fixture.runsRoot, [...screens][0]!);
		const reusable = findReusableBaseline(fixture.runsRoot, {
			targetId: anyScreen.target.id,
			targetGitSha: anyScreen.target.gitSha,
			toolsetHash: anyScreen.target.toolsetHash!,
			workspaceHash: anyScreen.target.workspaceHash!,
			provenance: anyScreen.provenance,
			evidenceVisibility: "development",
			label: "baseline",
			repetitions: anyScreen.repetitions,
			maxAgeMs: DEFAULT_BASELINE_MAX_AGE_MS,
		});
		expect(reusable).toBeNull();
		expect(screenTarget.datasetHash).toBe(anyScreen.datasetHash);
	});

	it("refuses to screen against another screen, and never reads sealed evidence", async () => {
		const screen = [...screenEvalRunIds(fixture.runsRoot)][0]!;
		await expect(runCheapCheck({
			repositoryDir: fixture.projectDir,
			runsRoot: fixture.runsRoot,
			candidateRef: fixSha,
			baselineRef: fixture.baselineSha,
			sourceEvalRunId: screen,
		})).rejects.toThrow(/a screen cannot be screened against another screen/);
	});

	it("has nothing to screen when the source eval recorded no behavioural failure", async () => {
		// The screen exists to re-run failures; a green eval has none, and saying
		// so is honest where inventing a verdict would not be.
		const green = loadVerifiedEvalRun(fixture.runsRoot, fixture.evalRunId);
		expect(resolveFailedTaskIds(green.runs.filter((run) => run.evalResults?.outcome === "pass"))).toEqual([]);
	});

	it("reads the revision and source eval a Candidate record was built from", () => {
		const record = {
			candidateId: "candidate-plan",
			projectId: fixture.projectId,
			specId: fixture.approvedSpecId,
			origin: {
				kind: "applied-builder",
				application: { baseTargetSha: fixture.baselineSha },
				source: {
					evalRunId: fixture.evalRunId,
					developmentCorpus: { id: fixture.corpusId, hash: "sha256:0" },
				},
			},
			events: [{ type: "built", candidate: { ref: "candidate/fix", sha: fixSha } }],
		} as unknown as CandidateRecord;
		const plan = cheapCheckPlanForCandidate(record, fixture.stateRoot);
		expect(plan).toMatchObject({
			candidateSha: fixSha,
			baseTargetSha: fixture.baselineSha,
			sourceEvalRunId: fixture.evalRunId,
		});
		expect(plan.developmentCorpus?.corpusId).toBe(fixture.corpusId);
	});

	it("refuses a candidate whose origin carries no source eval", () => {
		const manual = {
			candidateId: "candidate-manual",
			projectId: fixture.projectId,
			origin: { kind: "manual", reason: "hand-made" },
			events: [],
		} as unknown as CandidateRecord;
		expect(() => cheapCheckPlanForCandidate(manual, fixture.stateRoot)).toThrow(CheapCheckError);
	});
});

describe("verify-candidate spends nothing on a flat screen", () => {
	const flatScreen: CheapCheckResult = {
		tasks: ["task-a", "task-b"],
		improved: 0,
		unchanged: 2,
		regressed: 0,
		inconclusive: 0,
		verdict: "flat",
		runIds: ["run-a", "run-b"],
		rows: [],
		withinErrorBudget: true,
		screenId: "screen-erun_flat",
		screenEvalRunId: "erun_flat",
		screenRecordPath: "/dev/null",
		sourceEvalRunId: "erun_source",
		candidateSha: "0".repeat(40),
	};

	async function verificationFixture(screen: CheapCheckResult) {
		const runCheapCheckStub = vi.fn(async () => screen);
		const runAppliedCandidate = vi.fn(async () => {
			throw new Error("the verification must not run when the screen stopped it");
		});
		const local = await improveFixture({
			runCheapCheck: runCheapCheckStub as never,
			runAppliedCandidate: runAppliedCandidate as never,
		});
		const proposal = await recordFixtureProposal(local, READY_INSTRUCTION);
		await local.workbench.decide({
			kind: "apply-proposal",
			runId: proposal.runId,
			branch: "candidate/screened",
			reason: "Apply the reviewed fixture proposal",
		}, approvingGate());
		return { local, runCheapCheckStub, runAppliedCandidate };
	}

	it("stops with the numbers and spends no verification, then force spends it", async () => {
		const { local, runCheapCheckStub, runAppliedCandidate } = await verificationFixture(flatScreen);
		try {
			const stopped = await local.workbench.decide({
				kind: "verify-candidate",
				repetitions: SEALED_VERIFICATION_REPETITIONS,
				reason: "Verify the applied candidate",
			}, approvingGate());
			expect(runCheapCheckStub).toHaveBeenCalledTimes(1);
			expect(runAppliedCandidate).not.toHaveBeenCalled();
			if (stopped.result.outcome !== "stopped-by-screen") throw new Error("expected the screen to stop the verification");
			expect(stopped.result.screen).toMatchObject({
				verdict: "flat",
				tasks: 2,
				improved: 0,
				unchanged: 2,
				regressed: 0,
				screenEvalRunId: "erun_flat",
			});
			expect(stopped.result.spared.executions).toBeGreaterThan(0);
			expect(stopped.message).toContain("Cheap check found nothing");
			expect(stopped.message).toContain("was not spent");
			// Nothing durable moved: no candidate record exists yet.
			expect(existsSync(join(local.runsRoot, "candidates"))).toBe(false);

			// `force` is the operator saying they read the screen and want the
			// matched measurement anyway.
			await expect(local.workbench.decide({
				kind: "verify-candidate",
				repetitions: SEALED_VERIFICATION_REPETITIONS,
				force: true,
				reason: "Verify anyway; the screen is only a screen",
			}, approvingGate())).rejects.toThrow(/candidate verification failed/);
			expect(runCheapCheckStub).toHaveBeenCalledTimes(2);
			expect(runAppliedCandidate).toHaveBeenCalledTimes(1);
		} finally {
			await local.close();
		}
	}, 180_000);

	it("treats an over-budget screen as inconclusive and measures anyway", async () => {
		const inconclusive: CheapCheckResult = {
			...flatScreen,
			inconclusive: 2,
			unchanged: 0,
			withinErrorBudget: false,
		};
		const { local, runAppliedCandidate } = await verificationFixture(inconclusive);
		try {
			await expect(local.workbench.decide({
				kind: "verify-candidate",
				repetitions: SEALED_VERIFICATION_REPETITIONS,
				reason: "Verify the applied candidate",
			}, approvingGate())).rejects.toThrow(/candidate verification failed/);
			// Invariant 9: an infrastructure error is inconclusive evidence, never a
			// behavioural finding, so it can never be the reason nothing was measured.
			expect(runAppliedCandidate).toHaveBeenCalledTimes(1);
		} finally {
			await local.close();
		}
	}, 180_000);
});

describe("cheap check bookkeeping", () => {
	it("writes one durable screen record per screen and keeps it out of runs/", async () => {
		const screens = screenEvalRunIds(fixture.runsRoot);
		for (const evalRunId of screens) {
			expect(existsSync(join(fixture.runsRoot, "screens", `screen-${evalRunId}.json`))).toBe(true);
		}
		// A missing screens directory is simply "no screens", never a failure.
		const empty = join(fixture.runsRoot, "no-screens-here");
		rmSync(empty, { recursive: true, force: true });
		expect(screenEvalRunIds(empty).size).toBe(0);
	});

	it("keeps the screened surface identical to the source eval", async () => {
		const source = loadEvalRun(fixture.runsRoot, fixture.evalRunId);
		for (const evalRunId of screenEvalRunIds(fixture.runsRoot)) {
			const screen = loadEvalRun(fixture.runsRoot, evalRunId);
			// Invariant 15: a candidate re-tests the exact development surface.
			expect(screen.dataset).toBe(source.dataset);
			expect(screen.datasetHash).toBe(source.datasetHash);
			expect(screen.suiteHash).toBe(source.suiteHash);
			expect(screen.repetitions).toBe(CHEAP_CHECK_REPETITIONS);
			expect(screen.taskIds).toHaveLength(2);
		}
		expect(computeTargetWorkspaceHash(loadTarget(fixture.projectDir), fixture.runsRoot)).toMatch(/^sha256:/);
	});
});
