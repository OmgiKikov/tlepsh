import { execFileSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compileHarnessAuthoringProposal } from "../src/application/harness-authoring.js";
import {
	IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS,
	IMPROVEMENT_LOOP_STOP_MESSAGES,
	ImprovementLoopForbiddenDecisionError,
	improvementCycleLine,
	improvementLoopGate,
	plannedImprovementExecutions,
	recordedBuilderProposalAuthor,
	renderImprovementLoopTable,
	runImprovementLoop,
	topProposableFailureMode,
	type ImprovementLoopCycle,
	type ImprovementLoopDependencies,
	type ImprovementLoopResult,
	type ImprovementProposalAuthor,
} from "../src/application/improvement-loop.js";
import { loadCandidateRecord } from "../src/application/candidate-review.js";
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
function fakeVerification(verdict: string, candidatePassRate: number) {
	return {
		record: { candidateId: "candidate-fake" },
		baseline: { summary: { total: 4 } },
		candidate: { summary: { total: 4 } },
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
		result = await runImprovementLoop(loopOptions(fixture, { gate }));
	}, 600_000);

	afterAll(async () => {
		await fixture?.close();
	});

	it("runs, diagnoses, applies, screens and verifies, then stops at the target", () => {
		expect(result.cycles).toHaveLength(1);
		const cycle = result.cycles[0]!;
		expect(cycle.evalRunId).toMatch(/^erun_/);
		expect(cycle.failureModeId).toMatch(/^failure-mode-/);
		expect(cycle.branch).toBe("candidate/auto-1");
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
		expect(branches(fixture.projectDir).filter((name) => name.startsWith("candidate/"))).toEqual(["candidate/auto-1"]);
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
		expect(rows[0]).toBe("| cycle | pass rate | failure mode | branch | screen | verification |");
		expect(rows[2]).toContain("| 1 |");
		expect(rows[2]).toContain("candidate/auto-1");
		expect(table).toContain(`Stopped: ${IMPROVEMENT_LOOP_STOP_MESSAGES["target-reached"]}.`);
		expect(table).toContain(`Target executions spent: ${result.executions}.`);
		expect(table).toContain("Promotion is yours");
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
			expect(result.cycles.map((cycle) => cycle.branch)).toEqual(["candidate/auto-1", "candidate/auto-2"]);
			expect(result.cycles[1]!.evalReused).toBe(true);
			expect(result.cycles[1]!.note).toContain("2 in a row");
			expect(renderImprovementLoopTable(result)).toContain("nothing is waiting on a release decision");
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
			expect(result.cycles[0]!.verification).toMatchObject({ verdict: "unchanged" });
			expect(result.cycles[0]!.note).toContain("unchanged");
		} finally {
			await fixture.close();
		}
	}, 600_000);

	it("stops when infrastructure errors go over the budget, without calling it a failure", async () => {
		const fixture = await improveFixture();
		try {
			const result = await runImprovementLoop(loopOptions(fixture), {
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

	it("refuses an out-of-range target or cycle budget before spending anything", async () => {
		const fixture = await improveFixture();
		try {
			await expect(runImprovementLoop(loopOptions(fixture, { until: 1.5 })))
				.rejects.toThrow(/--until must be a pass rate between 0 and 1/);
			await expect(runImprovementLoop(loopOptions(fixture, { maxCycles: 99 })))
				.rejects.toThrow(/--max-cycles must be between 1 and 10/);
		} finally {
			await fixture.close();
		}
	}, 600_000);
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
	it("asks once, as routine measurement, with an estimate covering the whole planned loop", async () => {
		const fixture = await improveFixture();
		try {
			const observed: ImprovementLoopResult = {
				cycles: [],
				stopReason: "max-cycles",
				stopMessage: IMPROVEMENT_LOOP_STOP_MESSAGES["max-cycles"],
				candidateId: null,
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
			const gate = refusingGate();
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
			expect(confirmation.policy).toBe("routine");
			expect(confirmation.estimate?.executions).toBe(plannedImprovementExecutions({
				developmentTasks: 2,
				repetitions: 2,
				maxCycles: 3,
			}));
			expect(confirmation.question).toContain("never promotes, adopts, publishes or approves");
			expect((confirmation.subject as { neverDecides: string[] }).neverDecides)
				.toEqual([...IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS]);

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

	it("fails closed without the local TUI, even though it is routine measurement", async () => {
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

describe("the shipped proposal author", () => {
	it("takes the next unapplied proposal bound to this evidence, once each", async () => {
		const fixture = await improveFixture();
		try {
			const author = recordedBuilderProposalAuthor({
				stateRoot: fixture.stateRoot,
				runsRoot: fixture.runsRoot,
				projectId: fixture.projectId,
			});
			const request = {
				cycle: 1,
				repositoryDir: fixture.projectDir,
				runsRoot: fixture.runsRoot,
				stateRoot: fixture.stateRoot,
				projectId: fixture.projectId,
				approvedSpecId: fixture.approvedSpecId,
				baseTargetSha: fixture.baselineSha,
				evalRunId: fixture.evalRunId,
				diagnosisId: "diagnosis-x",
				brief: {} as never,
				failureMode: {} as never,
				selection: {} as never,
				failureBundlePath: "/dev/null",
			};

			// Nothing recorded yet: the loop is told what to do, not left guessing.
			const empty = await author(request);
			expect(empty).toMatchObject({ kind: "no-change" });
			expect(empty.kind === "no-change" && empty.reason).toContain("Author one in `ahde`");

			const recorded = await recordFixtureProposal(fixture, READY_INSTRUCTION);
			const first = await author(request);
			expect(first).toEqual({ kind: "recorded", builderRunId: recorded.runId });
			// One proposal is one attempt: the next cycle does not re-apply it.
			expect(await author({ ...request, cycle: 2 })).toMatchObject({ kind: "no-change" });

			// A proposal bound to different evidence is not this cycle's.
			expect(await author({ ...request, evalRunId: "erun_somewhere_else" })).toMatchObject({ kind: "no-change" });
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
			pass: 1,
			total: 4,
			passRate: 0.25,
			failureModeId: null,
			proposalRunId: null,
			branch: null,
			candidateSha: null,
			screen: null,
			verification: null,
			executions: 0,
			note: "nothing to propose",
		};
		expect(improvementCycleLine(cycle, 5)).toBe(
			"AHDE improve cycle 2/5 · run 1/4 25% (reused) · nothing to propose",
		);
	});
});
