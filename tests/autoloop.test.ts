import { execFileSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compileHarnessAuthoringProposal } from "../src/application/harness-authoring.js";
import {
	abandonImprovementLoop,
	IMPROVEMENT_CYCLE_SKIP_MESSAGES,
	IMPROVEMENT_LOOP_AUTHOR_DISCLOSURE,
	IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS,
	IMPROVEMENT_LOOP_STOP_MESSAGES,
	ImprovementLoopForbiddenDecisionError,
	improvementCycleLine,
	improvementLoopGate,
	listUnfinishedImprovementLoops,
	loadImprovementLoopRun,
	plannedImprovementExecutions,
	RECORDED_PROPOSAL_STALE_MESSAGES,
	recordedBuilderProposalAuthor,
	renderImprovementLoopTable,
	runImprovementLoop,
	topProposableFailureMode,
	UnfinishedImprovementLoopError,
	type ImprovementLoopCycle,
	type ImprovementLoopDependencies,
	type ImprovementLoopResult,
	type ImprovementProposalAuthor,
} from "../src/application/improvement-loop.js";
import { loadBuilderApplyReceipt } from "../src/application/builder-proposal.js";
import { loadEvalRun } from "../src/eval.js";
import { loadCandidateRecord } from "../src/application/candidate-review.js";
import { compileImprovementBrief } from "../src/application/improvement-brief.js";
import { diagnoseEvalRun } from "../src/diagnosis.js";
import { candidateStatus } from "../src/domain/candidate.js";
import { listCorpora } from "../src/corpus.js";
import { createBuilderWorkbenchTools } from "../src/builder/workbench-adapter.js";
import { createAhdeWorkbench } from "../src/workbench/index.js";
import type { WorkbenchConfirmation, WorkbenchHumanGate } from "../src/workbench/types.js";
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

/**
 * A gate that fails any decision creating release authority, and a sealed
 * picker that refuses outright. A loop driven by this can only finish if it
 * never asked.
 */
function refusingGate(): WorkbenchHumanGate & { calls: WorkbenchConfirmation[] } {
	const calls: WorkbenchConfirmation[] = [];
	return {
		calls,
		async confirm(confirmation) {
			calls.push(confirmation);
			if (confirmation.policy !== "routine") {
				throw new Error(`the loop asked for a ${confirmation.policy} decision: ${confirmation.kind}`);
			}
			return { approved: true, actorId: "local:loop-human" };
		},
		async selectSealed() {
			throw new Error("the loop opened the sealed holdout");
		},
	};
}

function recordingApprovingGate(): WorkbenchHumanGate & { calls: WorkbenchConfirmation[] } {
	const calls: WorkbenchConfirmation[] = [];
	return {
		calls,
		async confirm(confirmation) {
			calls.push(confirmation);
			return { approved: true, actorId: "local:loop-human" };
		},
		async selectSealed() {
			throw new Error("the loop opened the sealed holdout");
		},
	};
}

/** One scripted Builder author: the same chain a real proposal goes through. */
function scriptedAuthor(instructions: readonly string[]): ImprovementProposalAuthor {
	return (request) => {
		const instruction = instructions[request.cycle - 1];
		if (!instruction) return { kind: "no-change", reason: "the script ran out of proposals" };
		return {
			kind: "propose",
			proposal: compileHarnessAuthoringProposal({
				repositoryDir: request.repositoryDir,
				expectedBaseTargetSha: request.baseTargetSha,
				intents: [{ type: "instructions.replace", content: `# Improve fixture\n\n${instruction}\n` }],
				summary: `Cycle ${request.cycle}: make the answer contract explicit.`,
				diagnoses: request.selection.diagnoses,
				risks: ["Instruction-only behaviour change"],
				validationPlan: ["Re-run the reviewed development basket"],
			}),
		};
	};
}

function branches(projectDir: string): string[] {
	return execFileSync("git", ["-C", projectDir, "branch", "--format=%(refname:short)"], { encoding: "utf8" })
		.split("\n").map((line) => line.trim()).filter(Boolean).sort();
}

function tags(projectDir: string): string[] {
	return execFileSync("git", ["-C", projectDir, "tag", "-l"], { encoding: "utf8" })
		.split("\n").map((line) => line.trim()).filter(Boolean);
}

function loopOptions(fixture: ImproveFixture, overrides: Record<string, unknown> = {}) {
	return {
		repositoryDir: fixture.projectDir,
		runsRoot: fixture.runsRoot,
		stateRoot: fixture.stateRoot,
		projectId: fixture.projectId,
		approvedSpecId: fixture.approvedSpecId,
		developmentCorpus: {
			stateRoot: fixture.stateRoot,
			projectId: fixture.projectId,
			corpusId: fixture.corpusId,
		},
		until: 1,
		maxCycles: 3,
		repetitions: SEALED_VERIFICATION_REPETITIONS,
		author: scriptedAuthor([READY_INSTRUCTION]),
		...overrides,
	} as Parameters<typeof runImprovementLoop>[0];
}

/** A verification result shaped like the one `runAppliedBuilderCandidate` returns. */
function fakeVerification(verdict: string, candidatePassRate: number, candidateId = "candidate-fake", baselineReused = false) {
	return {
		record: { candidateId },
		baseline: { summary: { total: 4 } },
		candidate: { summary: { total: 4 } },
		baselineReused,
		compare: {
			gate: { verdict },
			summary: { scoreDelta: 0, delta: 0, candidatePassRate },
		},
	};
}

describe("autoloop — one cycle, inside the gates", () => {
	let fixture: ImproveFixture;
	let result: ImprovementLoopResult;
	let gate: ReturnType<typeof refusingGate>;

	beforeAll(async () => {
		fixture = await improveFixture();
		gate = refusingGate();
		// The loop only takes a gate that already refuses release decisions; the
		// raw one underneath still records everything it was asked.
		result = await runImprovementLoop(loopOptions(fixture, { gate: improvementLoopGate(gate) }));
	}, 600_000);

	afterAll(async () => {
		await fixture?.close();
	});

	it("runs, diagnoses, applies, screens and verifies, then stops at the target", () => {
		expect(result.cycles).toHaveLength(1);
		const cycle = result.cycles[0]!;
		expect(cycle.evalRunId).toMatch(/^erun_/);
		expect(cycle.failureModeId).toMatch(/^failure-mode-/);
		expect(cycle.branch).toBe(`candidate/auto-${result.loopId}-1`);
		expect(cycle.screen).toMatchObject({ verdict: "promising", improved: 2, tasks: 2, withinErrorBudget: true });
		expect(cycle.verification).toMatchObject({ verdict: "improved", candidatePassRate: 1 });
		expect(result.stopReason).toBe("target-reached");
		expect(result.stopMessage).toBe(IMPROVEMENT_LOOP_STOP_MESSAGES["target-reached"]);
		expect(result.finalPassRate).toBe(1);
		expect(result.candidateId).toBe(cycle.verification!.candidateId);
		// The screen cost one run per previously failing case; the verification
		// cost both arms. Both are counted, so "what did this spend" is answerable.
		expect(result.executions).toBe(result.cycles.reduce((sum, entry) => sum + entry.executions, 0));
		expect(cycle.executions).toBeGreaterThan(cycle.screen!.tasks);
	});

	it("refuses every consequential decision and never opens the sealed holdout", () => {
		// The loop finished; a gate that throws on anything consequential proves
		// it asked for none. It asked for nothing at all.
		expect(gate.calls).toEqual([]);
		expect(tags(fixture.projectDir)).toEqual([]);
		expect(branches(fixture.projectDir).filter((name) => name.startsWith("candidate/")))
			.toEqual([`candidate/auto-${result.loopId}-1`]);
		// The candidate the loop produced is evidence, not a release.
		const record = loadCandidateRecord(fixture.runsRoot, result.candidateId!);
		expect(candidateStatus(record)).toBe("evaluated");
		expect(record.events.some((event) => event.type === "reviewed" || event.type === "promoted")).toBe(false);
		// No sealed holdout ran: the loop's verification is development-only.
		const evaluated = record.events.find((event) => event.type === "evaluated");
		expect(evaluated?.type === "evaluated" && evaluated.evaluation.sealedHoldout).toBeUndefined();
		// Exactly the corpora the fixture published; the loop published nothing.
		expect(listCorpora({ stateRoot: fixture.stateRoot, projectId: fixture.projectId })).toHaveLength(2);
	});

	it("renders one progress line per cycle and a compact table", () => {
		const line = improvementCycleLine(result.cycles[0]!, 3);
		expect(line).toContain("AHDE improve cycle 1/3");
		expect(line).toContain("screen promising 2/2");
		expect(line).toContain("verify improved");

		const table = renderImprovementLoopTable(result);
		const rows = table.split("\n");
		expect(rows[0]).toBe("| cycle | pass rate | failure mode | branch | changed paths | screen | verification |");
		expect(rows[2]).toContain("| 1 |");
		expect(rows[2]).toContain(`candidate/auto-${result.loopId}-1`);
		expect(table).toContain(`Stopped: ${IMPROVEMENT_LOOP_STOP_MESSAGES["target-reached"]}.`);
		expect(table).toContain(`Target executions spent: ${result.executions}.`);
		expect(table).toContain("verified · awaiting your decision");
		expect(table).toContain("Promotion is yours");
		// The table never pretends the loop wrote the change it applied.
		expect(table).toContain(IMPROVEMENT_LOOP_AUTHOR_DISCLOSURE);
	});
});

describe("autoloop — the stop conditions", () => {
	it("stops after two flat screens without spending a verification", async () => {
		const fixture = await improveFixture();
		try {
			const runAppliedCandidate = vi.fn(async () => {
				throw new Error("a flat screen must not spend a verification");
			});
			const flat = vi.fn(async () => ({
				tasks: ["a", "b"],
				improved: 0,
				unchanged: 2,
				regressed: 0,
				inconclusive: 0,
				verdict: "flat" as const,
				runIds: ["r1", "r2"],
				rows: [],
				withinErrorBudget: true,
				screenId: "screen-x",
				screenEvalRunId: "erun_x",
				screenRecordPath: "/dev/null",
				sourceEvalRunId: "erun_source",
				candidateSha: "0".repeat(40),
			}));
			const result = await runImprovementLoop(
				loopOptions(fixture, {
					author: scriptedAuthor([NO_OP_INSTRUCTION, `${NO_OP_INSTRUCTION} Twice.`, READY_INSTRUCTION]),
				}),
				{
					runCheapCheck: flat as unknown as ImprovementLoopDependencies["runCheapCheck"],
					runAppliedCandidate: runAppliedCandidate as unknown as ImprovementLoopDependencies["runAppliedCandidate"],
				},
			);
			expect(result.stopReason).toBe("flat-screen-twice");
			expect(result.cycles).toHaveLength(2);
			expect(result.candidateId).toBeNull();
			expect(flat).toHaveBeenCalledTimes(2);
			expect(runAppliedCandidate).not.toHaveBeenCalled();
			expect(result.cycles.map((cycle) => cycle.branch)).toEqual([
				`candidate/auto-${result.loopId}-1`,
				`candidate/auto-${result.loopId}-2`,
			]);
			expect(result.cycles[1]!.evalReused).toBe(true);
			expect(result.cycles[1]!.note).toContain("2 in a row");
			expect(renderImprovementLoopTable(result)).toContain("No improved candidate is waiting on a release decision");
		} finally {
			await fixture.close();
		}
	}, 600_000);

	it("stops when the development verdict is not improved", async () => {
		const fixture = await improveFixture();
		try {
			const promising = vi.fn(async () => ({
				tasks: ["a", "b"],
				improved: 1,
				unchanged: 1,
				regressed: 0,
				inconclusive: 0,
				verdict: "promising" as const,
				runIds: ["r1", "r2"],
				rows: [],
				withinErrorBudget: true,
				screenId: "screen-y",
				screenEvalRunId: "erun_y",
				screenRecordPath: "/dev/null",
				sourceEvalRunId: "erun_source",
				candidateSha: "0".repeat(40),
			}));
			const result = await runImprovementLoop(loopOptions(fixture), {
				runCheapCheck: promising as unknown as ImprovementLoopDependencies["runCheapCheck"],
				runAppliedCandidate: (async () =>
					fakeVerification("unchanged", 0)) as unknown as ImprovementLoopDependencies["runAppliedCandidate"],
			});
			expect(result.stopReason).toBe("development-verdict");
			expect(result.cycles).toHaveLength(1);
			expect(result.candidateId).toBeNull();
			expect(result.cycles[0]!.verification).toMatchObject({ verdict: "unchanged" });
			expect(result.cycles[0]!.note).toContain("unchanged");
			expect(renderImprovementLoopTable(result)).toContain("No improved candidate is waiting");
		} finally {
			await fixture.close();
		}
	}, 600_000);

	it("stops when infrastructure errors go over the budget, without calling it a failure", async () => {
		const fixture = await improveFixture();
		try {
			// Reuse off: this test is about what a fresh, errored measurement does.
			const result = await runImprovementLoop(loopOptions(fixture, { baselineMaxAgeMs: 0 }), {
				runSuite: (async () => ({
					evalRunId: "erun_broken",
					summary: { total: 4, pass: 0, fail: 0, error: 4, allPassRate: 0 },
				})) as unknown as ImprovementLoopDependencies["runSuite"],
			});
			expect(result.stopReason).toBe("infrastructure-errors");
			expect(result.cycles).toHaveLength(1);
			expect(result.cycles[0]!.note).toContain("infrastructure error");
			// Invariant 9: inconclusive, so nothing was proposed or applied.
			expect(result.cycles[0]!.proposalRunId).toBeNull();
			expect(result.cycles[0]!.branch).toBeNull();
		} finally {
			await fixture.close();
		}
	}, 600_000);

	it("stops when the author has nothing left to try", async () => {
		const fixture = await improveFixture();
		try {
			const result = await runImprovementLoop(loopOptions(fixture, { author: scriptedAuthor([]) }));
			expect(result.stopReason).toBe("no-change-proposed");
			expect(result.cycles).toHaveLength(1);
			expect(result.cycles[0]!.note).toContain("ran out of proposals");
		} finally {
			await fixture.close();
		}
	}, 600_000);

	it("refuses an out-of-range target, cycle budget, or hypothesis count before spending anything", async () => {
		const fixture = await improveFixture();
		try {
			await expect(runImprovementLoop(loopOptions(fixture, { until: 1.5 })))
				.rejects.toThrow(/--until must be a pass rate between 0 and 1/);
			await expect(runImprovementLoop(loopOptions(fixture, { maxCycles: 99 })))
				.rejects.toThrow(/--max-cycles must be between 1 and 10/);
			await expect(runImprovementLoop(loopOptions(fixture, { candidates: 9 })))
				.rejects.toThrow(/--candidates must be between 1 and 4/);
		} finally {
			await fixture.close();
		}
	}, 600_000);
});

describe("the loop remembers what already lost", () => {
	/** The one proposable failure mode the fixture's baseline run produces. */
	function fixtureFailureModeId(fixture: ImproveFixture): string {
		const diagnosis = diagnoseEvalRun(fixture.runsRoot, fixture.evalRunId);
		const brief = compileImprovementBrief(fixture.runsRoot, diagnosis);
		const mode = brief.modes.find((candidate) => candidate.decision === "propose-harness-change");
		if (!mode) throw new Error("fixture produced no proposal-eligible failure mode");
		return mode.failureModeId;
	}

	/** A memory containing exactly one attempt: this change, this mode, rejected. */
	function rejectedHistory(failureModeId: string, changedPaths: string[]) {
		return () => ({
			attempts: [{
				candidateId: "cand-earlier",
				at: "2026-08-01T10:00:00.000Z",
				baseline: "0".repeat(12),
				candidate: "1".repeat(12),
				mode: "candidate",
				changedPaths,
				failureModeIds: [failureModeId],
				development: { verdict: "inconclusive", scoreDelta: 0, confidence95: null, tasks: 2, repetitions: 2 },
				sealed: null,
				outcome: "rejected" as const,
				reason: "3× the cost for nothing",
			}],
			omitted: 0,
			unreadable: 0,
		});
	}

	it("refuses to re-run a rejected experiment and stops with the honest reason", async () => {
		const fixture = await improveFixture();
		try {
			const failureModeId = fixtureFailureModeId(fixture);
			const runCheapCheck = vi.fn(async () => {
				throw new Error("a repeat must never reach the screen");
			});
			const applyProposal = vi.fn(() => {
				throw new Error("a repeat must never be applied");
			});
			const result = await runImprovementLoop(
				// The scripted author replaces AGENTS.md, which is exactly what the
				// remembered attempt changed for exactly this failure mode.
				loopOptions(fixture, { author: scriptedAuthor([READY_INSTRUCTION, READY_INSTRUCTION]) }),
				{
					compileExperimentHistory: rejectedHistory(failureModeId, ["AGENTS.md"]) as never,
					runCheapCheck: runCheapCheck as unknown as ImprovementLoopDependencies["runCheapCheck"],
					applyProposal: applyProposal as unknown as ImprovementLoopDependencies["applyProposal"],
				},
			);

			expect(result.stopReason).toBe("experiments-exhausted");
			expect(result.stopMessage).toBe(IMPROVEMENT_LOOP_STOP_MESSAGES["experiments-exhausted"]);
			expect(result.candidateId).toBeNull();
			expect(result.cycles).toHaveLength(1);
			expect(result.cycles[0]!.skipped).toMatchObject({
				reason: "repeat-of-a-losing-experiment",
				failureModeId,
				changedPaths: ["AGENTS.md"],
			});
			expect(result.cycles[0]!.branch).toBeNull();
			// Nothing was applied, screened or verified: the answer already existed.
			expect(applyProposal).not.toHaveBeenCalled();
			expect(runCheapCheck).not.toHaveBeenCalled();
			expect(branches(fixture.projectDir).filter((name) => name.startsWith("candidate/"))).toEqual([]);
			const table = renderImprovementLoopTable(result);
			expect(table).toContain("refused (repeat-of-a-losing-experiment)");
			expect(table).toContain(IMPROVEMENT_CYCLE_SKIP_MESSAGES["repeat-of-a-losing-experiment"]);
			expect(improvementCycleLine(result.cycles[0]!, 3))
				.toContain(`refused — ${IMPROVEMENT_CYCLE_SKIP_MESSAGES["repeat-of-a-losing-experiment"]}`);
		} finally {
			await fixture.close();
		}
	}, 600_000);

	it("lets a different change through for the same failure mode", async () => {
		const fixture = await improveFixture();
		try {
			const failureModeId = fixtureFailureModeId(fixture);
			// The memory says a skill edit lost; this cycle edits the instructions.
			const result = await runImprovementLoop(
				loopOptions(fixture, { author: scriptedAuthor([READY_INSTRUCTION]) }),
				{ compileExperimentHistory: rejectedHistory(failureModeId, ["skills/other/SKILL.md"]) as never },
			);

			expect(result.cycles[0]!.skipped).toBeNull();
			expect(result.cycles[0]!.branch).toBe(`candidate/auto-${result.loopId}-1`);
			expect(result.stopReason).toBe("target-reached");
		} finally {
			await fixture.close();
		}
	}, 600_000);
});

/**
 * One hypothesis per variant, so a cycle that asks for three different changes
 * gets three different changes — and an author that runs out says so.
 */
function variantAuthor(instructions: readonly string[]): ImprovementProposalAuthor {
	return (request) => {
		const instruction = instructions[request.variant - 1];
		if (!instruction) return { kind: "no-change", reason: "the script ran out of hypotheses" };
		return {
			kind: "propose",
			proposal: compileHarnessAuthoringProposal({
				repositoryDir: request.repositoryDir,
				expectedBaseTargetSha: request.baseTargetSha,
				intents: [{ type: "instructions.replace", content: `# Improve fixture\n\n${instruction}\n` }],
				summary: `Cycle ${request.cycle}, hypothesis ${request.variant} of ${request.variants}.`,
				diagnoses: request.selection.diagnoses,
				risks: ["Instruction-only behaviour change"],
				validationPlan: ["Re-run the reviewed development basket"],
			}),
		};
	};
}

describe("--candidates turns a cycle into a search", () => {
	it("authors several hypotheses for the top mode and hands back a table", async () => {
		const fixture = await improveFixture();
		try {
			const gate = refusingGate();
			const result = await runImprovementLoop(loopOptions(fixture, {
				gate: improvementLoopGate(gate),
				candidates: 2,
				author: variantAuthor([READY_INSTRUCTION, NO_OP_INSTRUCTION]),
			}));

			expect(result.cycles).toHaveLength(1);
			const search = result.cycles[0]!.search;
			expect(search).not.toBeNull();
			expect(search!.failureModeId).toBe(result.cycles[0]!.failureModeId);
			expect(search!.rows.map((row) => row.branch)).toEqual([
				`candidate/search-${result.loopId}-1-1`,
				`candidate/search-${result.loopId}-1-2`,
			]);
			// One hypothesis fixes the cases, the other changes nothing the graders
			// see: the screen keeps the second out of a paid verification.
			expect(search!.rows[0]).toMatchObject({ status: "verified" });
			expect(search!.rows[1]).toMatchObject({ status: "screened-out", skipReason: "flat-screen" });
			expect(search!.frontier).toEqual([1]);

			// The loop compares and stops; it never picks, promotes or adopts.
			expect(result.stopReason).toBe("search-decision-required");
			expect(result.stopMessage).toBe(IMPROVEMENT_LOOP_STOP_MESSAGES["search-decision-required"]);
			expect(result.candidateId).toBeNull();
			expect(gate.calls).toEqual([]);
			expect(tags(fixture.projectDir)).toEqual([]);
			expect(renderImprovementLoopTable(result)).toContain("Pick one: candidate 1.");
			expect(improvementCycleLine(result.cycles[0]!, 3)).toContain("search 1/2 verified");
		} finally {
			await fixture.close();
		}
	}, 900_000);

	it("stops honestly when fewer hypotheses come back than a search needs", async () => {
		const fixture = await improveFixture();
		try {
			const result = await runImprovementLoop(loopOptions(fixture, {
				candidates: 3,
				author: variantAuthor([READY_INSTRUCTION]),
			}));

			expect(result.stopReason).toBe("no-change-proposed");
			expect(result.cycles[0]!.skipped).toMatchObject({ reason: "too-few-hypotheses" });
			expect(result.cycles[0]!.search).toBeNull();
			expect(branches(fixture.projectDir).filter((name) => name.startsWith("candidate/"))).toEqual([]);
		} finally {
			await fixture.close();
		}
	}, 600_000);

	it("prices a search cycle as one run plus a screen and both arms per hypothesis", () => {
		expect(plannedImprovementExecutions({ developmentTasks: 10, repetitions: 3, maxCycles: 2, candidates: 3 }))
			.toBe(2 * (30 + 3 * (10 + 60)));
		// The default is today's behaviour, unchanged.
		expect(plannedImprovementExecutions({ developmentTasks: 10, repetitions: 3, maxCycles: 2 }))
			.toBe(plannedImprovementExecutions({ developmentTasks: 10, repetitions: 3, maxCycles: 2, candidates: 1 }));
	});
});

describe("the loop's gate", () => {
	it("throws on every decision that creates release authority", async () => {
		const inner = approvingGate();
		const guarded = improvementLoopGate(inner);
		for (const kind of IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS) {
			await expect(guarded.confirm({
				kind,
				title: "t",
				reason: "r",
				subject: {},
				subjectHash: `sha256:${"0".repeat(64)}`,
				policy: "consequential",
				question: "q?",
			})).rejects.toThrow(ImprovementLoopForbiddenDecisionError);
		}
		await expect(guarded.selectSealed({ title: "pick", options: [] }))
			.rejects.toThrow(/sealed holdout selection/);
		expect(inner.confirm).not.toHaveBeenCalled();
		expect(inner.selectSealed).not.toHaveBeenCalled();
	});

	it("lets routine measurement and the applies the operator asked for through", async () => {
		const inner = approvingGate();
		const guarded = improvementLoopGate(inner);
		for (const kind of ["run-eval", "verify-candidate", "apply-proposal", "improve"] as const) {
			await expect(guarded.confirm({
				kind,
				title: "t",
				reason: "r",
				subject: {},
				subjectHash: `sha256:${"0".repeat(64)}`,
				policy: "routine",
				question: "q?",
			})).resolves.toMatchObject({ approved: true });
		}
		expect(inner.confirm).toHaveBeenCalledTimes(4);
	});

	it("names promotion as the thing the human keeps", () => {
		expect(IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS).toContain("promote-candidate");
		expect(IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS).toContain("adopt-candidate");
		expect(IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS).toContain("publish-corpus");
		expect(IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS).toContain("approve-spec");
		expect(IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS).not.toContain("apply-proposal");
	});
});

describe("the improve decision", () => {
	it("asks once with the full automated-apply disclosure and a whole-loop estimate", async () => {
		const fixture = await improveFixture();
		try {
			const observed: ImprovementLoopResult = {
				cycles: [],
				stopReason: "max-cycles",
				stopMessage: IMPROVEMENT_LOOP_STOP_MESSAGES["max-cycles"],
				candidateId: null,
				loopId: "loop_observed01",
				finalPassRate: 0,
				executions: 0,
			};
			let received: Record<string, unknown> | null = null;
			const workbench = createAhdeWorkbench({
				projectDir: fixture.projectDir,
				stateRoot: fixture.stateRoot,
				runsRoot: fixture.runsRoot,
				projectId: fixture.projectId,
				dependencies: {
					runImprovementLoop: (async (options: Record<string, unknown>) => {
						received = options as unknown as Record<string, unknown>;
						return observed;
					}) as never,
				},
			});
			const gate = recordingApprovingGate();
			const decided = await workbench.decide({
				kind: "improve",
				until: 0.9,
				maxCycles: 3,
				repetitions: 2,
				reason: "Improve this agent towards 90%",
			}, gate);

			expect(gate.calls).toHaveLength(1);
			const confirmation = gate.calls[0]!;
			expect(confirmation.kind).toBe("improve");
			expect(confirmation.policy).toBe("consequential");
			expect(confirmation.estimate?.executions).toBe(plannedImprovementExecutions({
				developmentTasks: 2,
				repetitions: 2,
				maxCycles: 3,
			}));
			expect(confirmation.question).toContain("never promotes, adopts, publishes or approves");
			// The ONE question is also the ONE disclosure. It says out loud that the
			// loop applies diffs nobody will see one by one, on throwaway branches,
			// and where those diffs can be read afterwards.
			expect(confirmation.question).toContain("only time you will be asked");
			expect(confirmation.question).toContain("APPLIES proposals on throwaway");
			expect(confirmation.question).toContain("candidate/auto-<loopId>-<n>");
			expect(confirmation.question).toContain("WITHOUT showing you each diff");
			expect(confirmation.question).toContain("Nothing touches your branch or your working tree");
			expect(confirmation.question).toContain("cycle table");
			expect(confirmation.question).toContain("ship dialog");
			// And it does not pretend the loop writes the proposals.
			expect(confirmation.question).toContain(IMPROVEMENT_LOOP_AUTHOR_DISCLOSURE);
			const subject = confirmation.subject as {
				neverDecides: string[];
				touchesYourBranch: boolean;
				applies: string;
				diffsVisibleIn: string[];
			};
			expect(subject.neverDecides).toEqual([...IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS]);
			expect(subject.touchesYourBranch).toBe(false);
			expect(subject.applies).toContain("without showing each diff");
			expect(subject.diffsVisibleIn).toContain("the exact diff in the ship dialog");

			expect(decided.result.stopReason).toBe("max-cycles");
			expect(decided.result.table).toContain("| cycle |");
			// The loop is handed a gate that cannot be talked into a promotion.
			const handed = received as unknown as { gate: WorkbenchHumanGate };
			await expect(handed.gate.selectSealed({ title: "pick", options: [] }))
				.rejects.toThrow(ImprovementLoopForbiddenDecisionError);
		} finally {
			await fixture.close();
		}
	}, 600_000);

	it("renders the Pareto table under the same full confirmation when it is asked for several changes", async () => {
		const fixture = await improveFixture();
		try {
			const gate = recordingApprovingGate();
			const workbench = createAhdeWorkbench({
				projectDir: fixture.projectDir,
				stateRoot: fixture.stateRoot,
				runsRoot: fixture.runsRoot,
				projectId: fixture.projectId,
				dependencies: {
					authorImprovementProposal: variantAuthor([READY_INSTRUCTION, NO_OP_INSTRUCTION]),
				},
			});

			const decided = await workbench.decide({
				kind: "improve",
				until: 1,
				maxCycles: 1,
				repetitions: SEALED_VERIFICATION_REPETITIONS,
				candidates: 2,
				reason: "Try two different fixes for the top problem",
			}, gate);

			// One full question, and the estimate covers both hypotheses.
			expect(gate.calls).toHaveLength(1);
			expect(gate.calls[0]!.policy).toBe("consequential");
			expect(gate.calls[0]!.estimate?.executions).toBe(plannedImprovementExecutions({
				developmentTasks: 2,
				repetitions: SEALED_VERIFICATION_REPETITIONS,
				maxCycles: 1,
				candidates: 2,
			}));
			expect(gate.calls[0]!.question).toContain("comparing 2 changes per cycle");

			expect(decided.result.candidates).toBe(2);
			expect(decided.result.stopReason).toBe("search-decision-required");
			expect(decided.result.search?.rows).toHaveLength(2);
			expect(decided.result.search?.frontier).toEqual([1]);
			expect(decided.result.table).toContain("| # | branch | changed | screen | verdict |".slice(0, 20));
			expect(decided.result.table).toContain("Pick one: candidate 1.");
			// The decision compares and stops: nothing was promoted or adopted.
			expect(decided.result.candidateId).toBeNull();
			expect(tags(fixture.projectDir)).toEqual([]);
		} finally {
			await fixture.close();
		}
	}, 900_000);

	it("is illegal where a release decision is what is pending", async () => {
		const fixture = await improveFixture();
		try {
			// `improve` measures; it is not a way around the stages that gate a release.
			const workbench = createAhdeWorkbench({
				projectDir: fixture.projectDir,
				stateRoot: fixture.stateRoot,
				runsRoot: fixture.runsRoot,
				projectId: fixture.projectId,
			});
			git(fixture.projectDir, "status", "--short");
			await expect(workbench.decide({
				kind: "improve",
				until: 0.9,
				maxCycles: 1,
				repetitions: 2,
				developmentCorpusId: "corpus-that-does-not-exist",
				reason: "Improve with a basket that is not there",
			}, approvingGate())).rejects.toThrow();
		} finally {
			await fixture.close();
		}
	}, 600_000);
});

describe("improve needs a human in front of a terminal", () => {
	function decideTool() {
		const decide = vi.fn(async () => ({
			kind: "improve",
			message: "done",
			result: { cycles: [], stopReason: "max-cycles", stopMessage: "m", table: "t", candidateId: null, finalPassRate: 0, executions: 0 },
			view: { stage: "ready-to-evaluate" },
		}));
		const tool = createBuilderWorkbenchTools(decide2workbench(decide), () => "local:test")
			.find((candidate) => candidate.name === "ahde_workbench_decide");
		if (!tool) throw new Error("missing ahde_workbench_decide");
		return { tool, decide };
	}

	function decide2workbench(decide: unknown) {
		return { decide } as unknown as Parameters<typeof createBuilderWorkbenchTools>[0];
	}

	const headless = { hasUI: false, mode: "rpc" } as unknown as ExtensionContext;
	const tui = {
		hasUI: true,
		mode: "tui",
		ui: {
			confirm: vi.fn(async () => true),
			select: vi.fn(async () => undefined),
			notify: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
		},
	} as unknown as ExtensionContext;

	const input = { kind: "improve", until: 0.9, maxCycles: 2, repetitions: 2, reason: "Improve this agent" } as const;

	it("fails closed without the local TUI because it applies proposals", async () => {
		const { tool, decide } = decideTool();
		await expect(tool.execute("call", input, undefined, vi.fn(), headless)).rejects.toThrow();
		// The loop applies diffs; an RPC or print host is not a human saying yes.
		expect(decide).not.toHaveBeenCalled();
	});

	it("runs from the terminal", async () => {
		const { tool, decide } = decideTool();
		await tool.execute("call", input, undefined, vi.fn(), tui);
		expect(decide).toHaveBeenCalledTimes(1);
	});

	it("still lets plain measurement run headless", async () => {
		const { tool, decide } = decideTool();
		await tool.execute(
			"call",
			{ kind: "run-eval", repetitions: 1, reason: "Measure" } as const,
			undefined,
			vi.fn(),
			headless,
		);
		expect(decide).toHaveBeenCalledTimes(1);
	});
});

/**
 * A request shaped exactly as the loop builds one, for the surface the fixture's
 * own development eval measured. `evalRunId` is deliberately something the
 * author must ignore.
 */
function authorRequest(
	fixture: ImproveFixture,
	failureModeId: string,
	overrides: Partial<Record<string, unknown>> = {},
) {
	const source = loadEvalRun(fixture.runsRoot, fixture.evalRunId);
	return {
		cycle: 1,
		variant: 1,
		variants: 1,
		repositoryDir: fixture.projectDir,
		runsRoot: fixture.runsRoot,
		stateRoot: fixture.stateRoot,
		projectId: fixture.projectId,
		approvedSpecId: fixture.approvedSpecId,
		baseTargetSha: fixture.baselineSha,
		// A fresh invocation always has a NEW eval run id. Nothing may key off it.
		evalRunId: "erun_a_brand_new_invocation",
		surface: {
			targetId: source.target.id,
			targetGitSha: source.target.gitSha,
			dataset: source.dataset,
			datasetHash: source.datasetHash,
			suiteHash: source.suiteHash,
		},
		diagnosisId: "diagnosis-x",
		brief: {} as never,
		failureMode: { failureModeId } as never,
		selection: {} as never,
		failureBundlePath: "/dev/null",
		...overrides,
	} as Parameters<ImprovementProposalAuthor>[0];
}

describe("the shipped proposal author binds by surface, not by eval-run id", () => {
	it("applies a proposal the Builder prepared BEFORE the command, and uses each once", async () => {
		const fixture = await improveFixture();
		try {
			const author = recordedBuilderProposalAuthor({
				stateRoot: fixture.stateRoot,
				runsRoot: fixture.runsRoot,
				projectId: fixture.projectId,
			});

			// Nothing recorded yet: the loop is told what to do, not left guessing.
			const empty = await author(authorRequest(fixture, "failure-mode-unknown"));
			expect(empty).toMatchObject({ kind: "no-change", staleness: "no-recorded-proposal" });
			expect(empty.kind === "no-change" && empty.reason)
				.toContain(RECORDED_PROPOSAL_STALE_MESSAGES["no-recorded-proposal"]);
			// No pretending: the stop names the missing milestone.
			expect(empty.kind === "no-change" && empty.reason).toContain("headless proposal author is not shipped yet");

			// The Builder writes one, in the conversation, before `ahde improve` runs.
			const recorded = await recordFixtureProposal(fixture, READY_INSTRUCTION);
			const request = authorRequest(fixture, recorded.failureModeId);

			// The invocation's own eval run id is new and irrelevant: the surface matches.
			expect(await author(request)).toEqual({ kind: "recorded", builderRunId: recorded.runId });
			// One proposal is one attempt: the next cycle does not re-apply it.
			expect(await author({ ...request, cycle: 2 })).toMatchObject({
				kind: "no-change",
				staleness: "already-used",
			});
		} finally {
			await fixture.close();
		}
	}, 600_000);

	it("refuses a stale proposal with a typed reason naming exactly what moved", async () => {
		const fixture = await improveFixture();
		try {
			const author = () => recordedBuilderProposalAuthor({
				stateRoot: fixture.stateRoot,
				runsRoot: fixture.runsRoot,
				projectId: fixture.projectId,
			});
			const recorded = await recordFixtureProposal(fixture, READY_INSTRUCTION);
			const request = authorRequest(fixture, recorded.failureModeId);

			const moved = [
				["spec-changed", { approvedSpecId: "spec-another-approved-contract" }],
				["target-revision-moved", { surface: { ...request.surface, targetGitSha: "b".repeat(40) } }],
				["dataset-changed", { surface: { ...request.surface, datasetHash: `sha256:${"c".repeat(64)}` } }],
				["suite-changed", { surface: { ...request.surface, suiteHash: `sha256:${"d".repeat(64)}` } }],
				["failure-mode-differs", { failureMode: { failureModeId: `failure-mode-${"e".repeat(24)}` } }],
			] as const;
			for (const [reason, override] of moved) {
				const refused = await author()({ ...request, ...override } as typeof request);
				expect(refused).toMatchObject({ kind: "no-change", staleness: reason });
				expect(refused.kind === "no-change" && refused.reason)
					.toContain(RECORDED_PROPOSAL_STALE_MESSAGES[reason]);
			}

			// The unchanged surface still matches, so the refusals above were about
			// what moved and not about the proposal being unusable.
			expect(await author()(request)).toEqual({ kind: "recorded", builderRunId: recorded.runId });
		} finally {
			await fixture.close();
		}
	}, 600_000);
});

describe("a cycle reuses evidence it already paid for", () => {
	it("reads the fresh development eval on this revision instead of running one", async () => {
		const fixture = await improveFixture();
		try {
			// The fixture's own `run-eval` measured exactly this revision, basket and
			// suite at the same repetitions. A cycle that re-ran it would be spending
			// money on a question that already has an answer.
			const runSuite = vi.fn(async () => {
				throw new Error("a reusable development eval must not be re-run");
			});
			const result = await runImprovementLoop(loopOptions(fixture), {
				runSuite: runSuite as unknown as ImprovementLoopDependencies["runSuite"],
			});

			expect(runSuite).not.toHaveBeenCalled();
			const first = result.cycles[0]!;
			expect(first.evalReused).toBe(true);
			expect(first.evalRunId).toBe(fixture.evalRunId);
			// The reuse is free: only screen and candidate verification work remains.
			expect(first.executions).toBeLessThan(plannedImprovementExecutions({
				developmentTasks: 2,
				repetitions: SEALED_VERIFICATION_REPETITIONS,
				maxCycles: 1,
			}));
			expect(improvementCycleLine(first, 3)).toContain("(reused)");
			expect(renderImprovementLoopTable(result)).toContain("(reused)");
		} finally {
			await fixture.close();
		}
	}, 600_000);

	it("does not report a reused verification baseline as newly spent work", async () => {
		const fixture = await improveFixture();
		try {
			const result = await runImprovementLoop(loopOptions(fixture), {
				runCheapCheck: (async () => ({
					tasks: ["a", "b"], improved: 2, unchanged: 0, regressed: 0, inconclusive: 0,
					verdict: "promising", runIds: ["r1", "r2"], rows: [], withinErrorBudget: true,
					screenId: "screen-reused", screenEvalRunId: "erun_screen_reused",
					screenRecordPath: "/dev/null", sourceEvalRunId: fixture.evalRunId,
					candidateSha: "0".repeat(40),
				})) as unknown as ImprovementLoopDependencies["runCheapCheck"],
				runAppliedCandidate: (async () =>
					fakeVerification("improved", 1, "candidate-reused-baseline", true)) as unknown as
					ImprovementLoopDependencies["runAppliedCandidate"],
			});
			expect(result.executions).toBe(2 + 4);
			expect(result.cycles[0]!.executions).toBe(2 + 4);
		} finally {
			await fixture.close();
		}
	}, 600_000);

	it("pays for the measurement when reuse is disabled", async () => {
		const fixture = await improveFixture();
		try {
			const result = await runImprovementLoop(
				loopOptions(fixture, { baselineMaxAgeMs: 0, author: scriptedAuthor([]) }),
			);
			expect(result.cycles[0]!.evalReused).toBe(false);
			expect(result.cycles[0]!.evalRunId).not.toBe(fixture.evalRunId);
			expect(result.cycles[0]!.executions).toBeGreaterThan(0);
		} finally {
			await fixture.close();
		}
	}, 600_000);
});

describe("the loop's applies are honestly attributed", () => {
	it("records the confirming operator AND via: improvement-loop on the receipt", async () => {
		const fixture = await improveFixture();
		try {
			const result = await runImprovementLoop(loopOptions(fixture, { actorId: "local:loop-human" }));
			const cycle = result.cycles[0]!;
			const receipt = loadBuilderApplyReceipt(fixture.runsRoot, cycle.proposalRunId!);

			expect(receipt.schemaVersion).toBe(4);
			// The actor is real — they confirmed the loop — and `via` is what stops
			// the record from claiming they read this diff.
			expect(receipt.actor).toEqual({ kind: "human", id: "local:loop-human" });
			expect(receipt.via).toBe("improvement-loop");
			// No dialog priced this diff's check, so the loop authorized no spend
			// for it: a later verification asks the money question for itself.
			expect(receipt.verificationAuthorization).toBeUndefined();
			expect(receipt.branch).toBe(cycle.branch);

			// It survives into the candidate, which is what the review reads.
			const record = loadCandidateRecord(fixture.runsRoot, result.candidateId!);
			expect(record.origin.kind === "applied-builder" && record.origin.application.via)
				.toBe("improvement-loop");
			// And the cycle table shows the diff the operator never saw one by one.
			expect(cycle.changedPaths).toEqual(["AGENTS.md"]);
			expect(renderImprovementLoopTable(result)).toContain("AGENTS.md");
		} finally {
			await fixture.close();
		}
	}, 600_000);

	it("leaves an interactive apply without a via, so a reviewed diff stays a reviewed diff", async () => {
		const fixture = await improveFixture();
		try {
			const proposal = await recordFixtureProposal(fixture, READY_INSTRUCTION);
			await fixture.workbench.decide({
				kind: "apply-proposal",
				runId: proposal.runId,
				branch: "candidate/by-hand",
				reason: "Apply the reviewed fixture proposal",
			}, approvingGate());
			const receipt = loadBuilderApplyReceipt(fixture.runsRoot, proposal.runId);
			expect(receipt.via).toBeUndefined();
		} finally {
			await fixture.close();
		}
	}, 600_000);
});

describe("one invocation, unique resumable branches", () => {
	it("names every branch after the loop, and never reuses one", async () => {
		const fixture = await improveFixture();
		try {
			const result = await runImprovementLoop(loopOptions(fixture));
			expect(result.loopId).toMatch(/^loop_[a-z0-9]{6,32}$/);
			expect(result.cycles[0]!.branch).toBe(`candidate/auto-${result.loopId}-1`);
			expect(branches(fixture.projectDir)).toContain(`candidate/auto-${result.loopId}-1`);

			// The ledger says the loop finished, so the next `improve` is unblocked.
			const ledger = loadImprovementLoopRun(fixture.runsRoot, result.loopId);
			expect(ledger).toMatchObject({ status: "finished", projectId: fixture.projectId });
			expect(ledger.branches).toEqual([`candidate/auto-${result.loopId}-1`]);
			expect(listUnfinishedImprovementLoops(fixture.runsRoot, fixture.projectId).running).toEqual([]);
		} finally {
			await fixture.close();
		}
	}, 600_000);

	it("reports an unfinished loop and refuses until --resume or --abandon", async () => {
		const fixture = await improveFixture();
		try {
			// A loop killed mid-flight leaves a `running` ledger entry.
			const stranded = "loop_abandonme01";
			await expect(runImprovementLoop(loopOptions(fixture, {
				loopId: stranded,
				runSuite: undefined,
				author: () => {
					throw new Error("killed mid-cycle");
				},
			}))).rejects.toThrow(/killed mid-cycle/);
			const open = listUnfinishedImprovementLoops(fixture.runsRoot, fixture.projectId);
			expect(open.running.map((loop) => loop.loopId)).toEqual([stranded]);

			// A second `improve` sees it and says exactly what to do about it.
			const refusal = new UnfinishedImprovementLoopError(open.running, open.unreadable);
			expect(refusal.message).toContain(stranded);
			expect(refusal.message).toContain("--resume");
			expect(refusal.message).toContain("--abandon");
			await expect(fixture.workbench.decide({
				kind: "improve",
				until: 1,
				maxCycles: 1,
				repetitions: SEALED_VERIFICATION_REPETITIONS,
				reason: "Improve while another loop is open",
			}, approvingGate())).rejects.toThrow(UnfinishedImprovementLoopError);

			// `--abandon` drops the claim and leaves the branches alone.
			const before = branches(fixture.projectDir);
			const dropped = abandonImprovementLoop(fixture.runsRoot, fixture.projectId, stranded);
			expect(dropped.status).toBe("abandoned");
			expect(() => abandonImprovementLoop(fixture.runsRoot, fixture.projectId, stranded))
				.toThrow(/only a running loop can be abandoned/);
			expect(branches(fixture.projectDir)).toEqual(before);
			expect(listUnfinishedImprovementLoops(fixture.runsRoot, fixture.projectId).running).toEqual([]);
		} finally {
			await fixture.close();
		}
	}, 600_000);

	it("checkpoints a partial branch and resumes on the next collision-free cycle", async () => {
		const fixture = await improveFixture();
		try {
			const loopId = "loop_resumeme01";
			await expect(runImprovementLoop(
				loopOptions(fixture, {
					loopId,
					maxCycles: 2,
					author: scriptedAuthor([NO_OP_INSTRUCTION, READY_INSTRUCTION]),
				}),
				{
					runCheapCheck: (async () => {
						throw new Error("killed after the branch was created");
					}) as unknown as ImprovementLoopDependencies["runCheapCheck"],
				},
			)).rejects.toThrow(/killed after the branch/);
			const interrupted = loadImprovementLoopRun(fixture.runsRoot, loopId);
			expect(interrupted).toMatchObject({ status: "running", lastCycle: 1 });
			expect(interrupted.branches).toEqual([`candidate/auto-${loopId}-1`]);

			const result = await runImprovementLoop(loopOptions(fixture, {
				loopId,
				maxCycles: 2,
				author: scriptedAuthor([NO_OP_INSTRUCTION, READY_INSTRUCTION]),
			}));
			expect(result.loopId).toBe(loopId);
			expect(result.cycles[0]!.cycle).toBe(2);
			expect(result.cycles[0]!.branch).toBe(`candidate/auto-${loopId}-2`);
		} finally {
			await fixture.close();
		}
	}, 600_000);
});

describe("failure-mode selection", () => {
	it("takes the widest blast radius, then reproducibility, then the stable id", () => {
		const mode = (id: string, coverage: number, reproduction: number) => ({
			failureModeId: `failure-mode-${id}`,
			decision: "propose-harness-change" as const,
			impact: {
				affectedTasks: 1,
				totalTasks: 4,
				taskCoverageBps: coverage,
				failedOccurrences: 2,
				passedOccurrences: 0,
				reproductionBps: reproduction,
			},
		});
		const brief = {
			modes: [
				mode("b".repeat(24), 2_500, 10_000),
				mode("a".repeat(24), 5_000, 5_000),
				{ ...mode("c".repeat(24), 7_500, 10_000), decision: "stabilize-and-rerun" as const },
			],
		} as unknown as Parameters<typeof topProposableFailureMode>[0];
		expect(topProposableFailureMode(brief)?.failureModeId).toBe(`failure-mode-${"a".repeat(24)}`);
		expect(topProposableFailureMode({ modes: [] } as unknown as Parameters<typeof topProposableFailureMode>[0])).toBeNull();
	});

	it("prices a planned loop as run + screen + both verification arms per cycle", () => {
		expect(plannedImprovementExecutions({ developmentTasks: 10, repetitions: 3, maxCycles: 2 }))
			.toBe(2 * (30 + 10 + 60));
		expect(plannedImprovementExecutions({ developmentTasks: 0, repetitions: 3, maxCycles: 5 })).toBe(0);
	});

	it("renders a cycle that never got past its run", () => {
		const cycle: ImprovementLoopCycle = {
			cycle: 2,
			evalRunId: "erun_1",
			evalReused: true,
			baseTargetSha: "0".repeat(40),
			changedPaths: [],
			pass: 1,
			total: 4,
			passRate: 0.25,
			failureModeId: null,
			proposalRunId: null,
			branch: null,
			candidateSha: null,
			screen: null,
			verification: null,
			search: null,
			skipped: null,
			executions: 0,
			note: "nothing to propose",
		};
		expect(improvementCycleLine(cycle, 5)).toBe(
			"AHDE improve cycle 2/5 · run 1/4 25% (reused) · nothing to propose",
		);
	});
});
