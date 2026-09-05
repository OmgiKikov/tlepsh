import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compileHarnessAuthoringProposal } from "../src/application/harness-authoring.js";
import {
	improvementLoopGate, improvementLoopRecordPath, loadImprovementLoopRun,
	plannedImprovementExecutions, runImprovementLoop,
	type ImprovementLoopOptions, type ImprovementProposalAuthor,
} from "../src/application/improvement-loop.js";
import {
	selectBestImprovement, type ImprovementMeasuredCandidate,
} from "../src/application/improvement-selection.js";
import { loadCandidateRecord } from "../src/application/candidate-review.js";
import { runProposalSearch } from "../src/application/proposal-search.js";
import { readEvalRunIndex } from "../src/eval.js";
import { loadCorpus } from "../src/corpus.js";
import { planImprovementExperiment } from "../src/application/improvement-experiment-design.js";
import { candidateStatus } from "../src/domain/candidate.js";
import { approvingGate, git, improveFixture, type ImproveFixture } from "./helpers/improve-fixtures.js";

function author(instructions: readonly string[], seen: Parameters<ImprovementProposalAuthor>[0][] = []): ImprovementProposalAuthor {
	return (request) => {
		seen.push(request);
		const instruction = instructions[(request.cycle - 1) * request.variants + request.variant - 1];
		if (!instruction) return { kind: "no-change", reason: "no further hypothesis" };
		return {
			kind: "propose",
			proposal: compileHarnessAuthoringProposal({
				repositoryDir: request.repositoryDir, expectedBaseTargetSha: request.baseTargetSha,
				intents: [{ type: "instructions.replace", content: `# Hypothesis\n\n${instruction}\n` }],
				summary: `Independent hypothesis ${request.cycle}.${request.variant}`,
				diagnoses: request.selection.diagnoses, risks: ["instruction behavior change"],
				validationPlan: ["Measure the unchanged validation partition"],
			}),
		};
	};
}

function options(f: ImproveFixture, loopId: string, overrides: Partial<ImprovementLoopOptions> = {}): ImprovementLoopOptions {
	return {
		repositoryDir: f.projectDir, runsRoot: f.runsRoot, stateRoot: f.stateRoot,
		projectId: f.projectId, approvedSpecId: f.approvedSpecId,
		developmentCorpus: { stateRoot: f.stateRoot, projectId: f.projectId, corpusId: f.corpusId },
		loopId, selection: "best", executionBudget: 200, maxCycles: 5, repetitions: 2, until: 1,
		author: author(["WEAK", "STRONG", "WORSE", "STRONG"]),
		gate: improvementLoopGate(approvingGate()), ...overrides,
	};
}

describe("automatic measured candidate selection", () => {
	let fixture: ImproveFixture;
	beforeAll(async () => {
		fixture = await improveFixture({}, {
			developmentCases: 4, repetitions: 2,
			graderTexts: ["READY", "BETTER", "BEST", "UNATTAINED"],
			modelScripts: [
				{ match: ({ system }) => system.includes("STRONG"), steps: [{ text: "READY BETTER BEST" }] },
				{ match: ({ system }) => system.includes("WEAK"), steps: [{ text: "READY BETTER" }] },
				{ match: ({ system }) => system.includes("WORSE"), steps: [{ text: "pending" }] },
				{ steps: [{ text: "READY" }] },
			],
		});
	});
	afterAll(async () => { await fixture?.close(); });

	it("keeps the best of later independent hypotheses, survives a regression, and stops after two rounds without progress", async () => {
		const requests: Parameters<ImprovementProposalAuthor>[0][] = [];
		const gate = approvingGate();
		const result = await runImprovementLoop(options(fixture, "loop_bestwinner", {
			author: author(["WEAK", "STRONG", "WORSE", "STRONG"], requests), gate: improvementLoopGate(gate),
		}));
		expect(result.stopReason).toBe("no-progress-twice");
		expect(result.cycles).toHaveLength(4);
		expect(result.candidateId).toBe("candidate-loop_bestwinner-2-1");
		expect(result.selectionSummary).toMatchObject({
			policy: "measured-best-v1", evaluatedCandidates: 3, noProgressRounds: 2,
			incumbent: { cycle: 2, scoreDelta: 0.5, verdict: "improved", candidatePassRate: 0 },
		});
		expect(result.cycles[2]!.search!.rows[0]!.development!.verdict).toBe("regressed");
		// A partial grader gain is verified even though the pass-only cheap screen was flat.
		expect(result.cycles[0]!.search!.rows[0]!.screen!.verdict).toBe("flat");
		expect(result.cycles[0]!.search!.rows[0]!.development!.scoreDelta).toBe(0.25);
		expect(result.cycles[3]!.executions).toBe(0); // Identical content, regardless of new proposal id/summary.
		const ledger = loadImprovementLoopRun(fixture.runsRoot, result.loopId);
		expect(ledger.selectionState!.proposalHashes).toHaveLength(3);
		expect(ledger.candidateIds).toHaveLength(2);
		expect(result.selectionSummary!.executionsCharged).toBe(result.executions);
		const baselineIds = result.cycles.flatMap((cycle) => cycle.search?.rows.flatMap((row) => {
			if (!row.candidateId) return [];
			const record = loadCandidateRecord(fixture.runsRoot, row.candidateId);
			expect(candidateStatus(record)).toBe("evaluated");
			expect(record.origin.kind).toBe("applied-builder");
			const event = record.events.find((entry) => entry.type === "evaluated")!;
			if (event.type !== "evaluated") throw new Error("missing verification");
			expect(event.evaluation.sealedHoldout).toBeUndefined();
			expect(event.evaluation.development.baseline.harness.sha).toBe(fixture.baselineSha);
			return [event.evaluation.development.baseline.evalRunId];
		}) ?? []);
		expect(new Set(baselineIds).size).toBe(1);
		expect(new Set(requests.map((request) => request.evalRunId)).size).toBe(1);
		const validation = readEvalRunIndex(fixture.runsRoot, baselineIds[0]!);
		for (const request of requests) {
			expect(request.baseTargetSha).toBe(fixture.baselineSha);
			expect(request.evalRunId).not.toBe(validation.evalRunId);
			const bundle = readFileSync(request.failureBundlePath, "utf8");
			for (const id of validation.taskIds!) expect(bundle).not.toContain(id);
			expect(bundle).not.toContain("PRIVATE IMPROVE FIXTURE HOLDOUT");
		}
		expect(gate.confirm).not.toHaveBeenCalled();
		expect(gate.selectSealed).not.toHaveBeenCalled();
		expect(git(fixture.projectDir, "rev-parse", "HEAD")).toBe(fixture.baselineSha);
		expect(git(fixture.projectDir, "symbolic-ref", "--short", "HEAD")).toBe(fixture.branch);
		expect(git(fixture.projectDir, "status", "--porcelain")).toBe("");
		expect(git(fixture.projectDir, "tag", "-l")).toBe("");
	});

	it("chooses automatically inside a multi-hypothesis round without asking which frontier row wins", async () => {
		const result = await runImprovementLoop(options(fixture, "loop_bestmulti", {
			maxCycles: 1, candidates: 2, author: author(["WEAK", "STRONG"]),
		}));
		expect(result.stopReason).toBe("max-cycles");
		expect(result.candidateId).toBe("candidate-loop_bestmulti-1-2");
		expect(result.selectionSummary!.evaluatedCandidates).toBe(2);
	});

	it("refuses an unaffordable complete round before authoring and caps the next round", async () => {
		const unused = vi.fn<ImprovementProposalAuthor>(() => ({ kind: "no-change", reason: "unused" }));
		const before = fixture.mock.requests();
		const result = await runImprovementLoop(options(fixture, "loop_besttiny", { executionBudget: 1, author: unused }));
		expect(result.stopReason).toBe("execution-budget-exhausted");
		expect(result.executions).toBe(0);
		expect(fixture.mock.requests()).toBe(before);
		expect(unused).not.toHaveBeenCalled();
		// 4 authoring + 4 original validation + 2 screen + 4 candidate = 14 executions.
		const capped = await runImprovementLoop(options(fixture, "loop_bestbudget", { executionBudget: 14 }));
		expect(capped.stopReason).toBe("execution-budget-exhausted");
		expect(capped.cycles).toHaveLength(1);
		expect(capped.selectionSummary!.executionsCharged).toBeLessThanOrEqual(14);
		expect(capped.candidateId).toBe("candidate-loop_bestbudget-1-1");
	});

	it("recovers a canonical verification written before its callback and preserves the interrupted round reservation", async () => {
		const loopId = "loop_bestrecover";
		const input = options(fixture, loopId, { maxCycles: 3 });
		await expect(runImprovementLoop(input, {
			runProposalSearch: async (searchOptions) => {
				await runProposalSearch({ ...searchOptions, onCandidate: undefined });
				throw new Error("simulated process loss after candidate receipt");
			},
		})).rejects.toThrow("simulated process loss");
		const interrupted = loadImprovementLoopRun(fixture.runsRoot, loopId);
		expect(interrupted.status).toBe("running");
		expect(interrupted.candidateIds).toEqual([]);
		expect(interrupted.selectionState!.measured).toEqual([]);
		expect(interrupted.selectionState!.executionsCharged).toBe(14);
		const resumed = await runImprovementLoop(input);
		expect(resumed.cycles.map((cycle) => cycle.cycle)).toEqual([2, 3]);
		expect(resumed.candidateId).toBe("candidate-loop_bestrecover-2-1");
		expect(resumed.selectionSummary!.evaluatedCandidates).toBe(3);
		expect(resumed.selectionSummary!.executionsCharged).toBeGreaterThan(resumed.executions);
		const state = loadImprovementLoopRun(fixture.runsRoot, loopId).selectionState!;
		expect(state.measured[0]!.candidateId).toBe("candidate-loop_bestrecover-1-1");
		expect(state.validationBaseline).toEqual(interrupted.selectionState!.validationBaseline);
	});

	it("keeps the budget reservation if interruption occurs before any candidate is recorded", async () => {
		const loopId = "loop_bestpartial";
		const input = options(fixture, loopId, { executionBudget: 14, author: () => { throw new Error("author interrupted"); } });
		await expect(runImprovementLoop(input)).rejects.toThrow("author interrupted");
		expect(loadImprovementLoopRun(fixture.runsRoot, loopId).selectionState!.executionsCharged).toBe(14);
		const resumed = await runImprovementLoop({ ...input, author: author(["WEAK", "STRONG"]) });
		expect(resumed.stopReason).toBe("execution-budget-exhausted");
		expect(resumed.selectionSummary!.executionsCharged).toBe(14);
		expect(resumed.candidateId).toBeNull();
	});

	it("refuses a concurrent resume before it can read and spend the same remaining budget", async () => {
		let entered!: () => void;
		let unblock!: () => void;
		const ready = new Promise<void>((resolve) => { entered = resolve; });
		const held = new Promise<void>((resolve) => { unblock = resolve; });
		const loopId = "loop_bestconcurrent";
		const input = options(fixture, loopId, { maxCycles: 1, executionBudget: 14 });
		const first = runImprovementLoop({ ...input, author: async () => {
			entered(); await held; return { kind: "no-change", reason: "no proposal" };
		} });
		await ready;
		try {
			const before = fixture.mock.requests();
			const unused = vi.fn<ImprovementProposalAuthor>(() => ({ kind: "no-change", reason: "unused" }));
			await expect(runImprovementLoop({ ...input, author: unused })).rejects.toThrow("already running");
			expect(unused).not.toHaveBeenCalled();
			expect(fixture.mock.requests()).toBe(before);
			expect(loadImprovementLoopRun(fixture.runsRoot, loopId).selectionState!.executionsCharged).toBe(14);
		} finally { unblock(); await first; }
	});

	it("recovers a dead process claim before reading the persisted remaining budget", async () => {
		const loopId = "loop_bestdeadowner";
		const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
		expect(child.status).toBe(0);
		const path = join(fixture.runsRoot, "loops", `${loopId}.lock`);
		writeFileSync(path, JSON.stringify({ pid: child.pid, host: hostname(), nonce: randomUUID() }));
		const result = await runImprovementLoop(options(fixture, loopId, { executionBudget: 1 }));
		expect(result.stopReason).toBe("execution-budget-exhausted");
		expect(result.executions).toBe(0);
		expect(() => readFileSync(path)).toThrow();
	});

	it("refuses a changed pinned baseline before resuming authoring or target calls", async () => {
		const loopId = "loop_besttamper";
		const input = options(fixture, loopId, { onCycle: () => { throw new Error("pause after checkpoint"); } });
		await expect(runImprovementLoop(input)).rejects.toThrow("pause after checkpoint");
		const record = loadImprovementLoopRun(fixture.runsRoot, loopId);
		const pin = record.selectionState!.validationBaseline!;
		const path = join(fixture.runsRoot, pin.evalRunId, "eval_run.json");
		const original = readFileSync(path, "utf8");
		try {
			const value = JSON.parse(original); value.evidenceVisibility = "sealed";
			value.runIds = value.runIds.map((_: unknown, index: number) => `PRIVATE-SEALED-MISSING-MEMBER-CANARY-${index}`);
			value.runArtifacts = value.runArtifacts.map((artifact: Record<string, unknown>, index: number) => ({ ...artifact, runId: value.runIds[index] }));
			writeFileSync(path, JSON.stringify(value));
			const unused = vi.fn<ImprovementProposalAuthor>(() => ({ kind: "no-change", reason: "unused" }));
			const before = fixture.mock.requests();
			await expect(runImprovementLoop({ ...input, author: unused, onCycle: undefined })).rejects.toThrow("not development evidence");
			expect(unused).not.toHaveBeenCalled();
			expect(fixture.mock.requests()).toBe(before);
		} finally { writeFileSync(path, original); }
	});

	it("refuses ledger-derived score, pass-rate and verdict changes even when the candidate hash is unchanged", async () => {
		const loopId = "loop_bestscoretamper";
		const input = options(fixture, loopId, { onCycle: () => { throw new Error("pause after measured checkpoint"); } });
		await expect(runImprovementLoop(input)).rejects.toThrow("pause after measured checkpoint");
		const path = improvementLoopRecordPath(fixture.runsRoot, loopId);
		const original = readFileSync(path, "utf8");
		const candidateHash = JSON.parse(original).selectionState.measured[0].candidateHash;
		try {
			for (const mutation of [{ scoreDelta: 1 }, { candidatePassRate: 1 }, { verdict: "regressed" }]) {
				const record = JSON.parse(original);
				Object.assign(record.selectionState.measured[0], mutation);
				expect(record.selectionState.measured[0].candidateHash).toBe(candidateHash);
				writeFileSync(path, JSON.stringify(record));
				const unused = vi.fn<ImprovementProposalAuthor>(() => ({ kind: "no-change", reason: "unused" }));
				const before = fixture.mock.requests();
				await expect(runImprovementLoop({ ...input, author: unused, onCycle: undefined })).rejects.toThrow("derived scores changed");
				expect(unused).not.toHaveBeenCalled();
				expect(fixture.mock.requests()).toBe(before);
			}
		} finally { writeFileSync(path, original); }
	});

	it("reads old ledgers as review mode and derives a finite maximum for best with one hypothesis", () => {
		const path = improvementLoopRecordPath(fixture.runsRoot, "loop_bestwinner");
		const original = readFileSync(path, "utf8");
		try {
			const record = JSON.parse(original);
			delete record.configuration.selection; delete record.configuration.executionBudget; delete record.selectionState;
			writeFileSync(path, JSON.stringify(record));
			expect(loadImprovementLoopRun(fixture.runsRoot, "loop_bestwinner").configuration.selection).toBe("review");
		} finally { writeFileSync(path, original); }
		expect(plannedImprovementExecutions({ developmentTasks: 4, authoringTasks: 2, validationTasks: 2,
			repetitions: 2, maxCycles: 3, candidates: 1, selection: "best" })).toBe(54);
	});

	it("does not declare the target reached from a passing authoring partition when unseen cases fail", async () => {
		const passingInputs = new Set<string>();
		const mixed = await improveFixture({}, {
			developmentCases: 4, repetitions: 2,
			modelScripts: [{ steps: [], resolve: ({ firstUser }) => ({ text: passingInputs.has(firstUser) ? "READY" : "pending" }) }],
		});
		try {
			const loopId = "loop_bestpartialpass";
			const corpus = loadCorpus({ stateRoot: mixed.stateRoot, projectId: mixed.projectId, corpusId: mixed.corpusId });
			const split = planImprovementExperiment(corpus, loopId);
			for (const task of corpus.tasks) if (split.authoringTaskIds.includes(task.id)) passingInputs.add(task.input);
			expect(split.validationTaskIds.every((id) => !passingInputs.has(corpus.tasks.find((task) => task.id === id)!.input))).toBe(true);
			const unused = vi.fn<ImprovementProposalAuthor>(() => ({ kind: "no-change", reason: "unused" }));
			const result = await runImprovementLoop(options(mixed, loopId, { author: unused }));
			expect(result.cycles[0]!.passRate).toBe(1);
			expect(result.stopReason).toBe("no-proposable-failure-mode");
			expect(result.candidateId).toBeNull();
			expect(result.selectionSummary!.incumbent).toBeNull();
			expect(unused).not.toHaveBeenCalled();
		} finally { await mixed.close(); }
	});
});

describe("predeclared measured ranking", () => {
	const measurement = (id: string, overrides: Partial<ImprovementMeasuredCandidate> = {}): ImprovementMeasuredCandidate => ({
		candidateId: id, candidateHash: `sha256:${"a".repeat(64)}`, cycle: 1, ordinal: 1,
		verdict: "improved", scoreDelta: 0.2, confidence95: { low: 0.1, high: 0.3 },
		candidatePassRate: 0.7, costRatio: null, latencyRatio: null, ...overrides,
	});
	it("uses canonical improved verdict first, then score, confidence, comparable resources and earliest tie", () => {
		const first = measurement("first");
		expect(selectBestImprovement([first, measurement("inconclusive", { verdict: "inconclusive", scoreDelta: 1 })])!.candidateId).toBe("first");
		expect(selectBestImprovement([first, measurement("higher", { cycle: 2, scoreDelta: 0.3 })])!.candidateId).toBe("higher");
		expect(selectBestImprovement([first, measurement("lower-bound", { cycle: 2, confidence95: { low: 0.15, high: 0.3 } })])!.candidateId).toBe("lower-bound");
		expect(selectBestImprovement([measurement("costly", { costRatio: 2 }), measurement("cheaper", { cycle: 2, costRatio: 1 })])!.candidateId).toBe("cheaper");
		expect(selectBestImprovement([measurement("slow", { latencyRatio: 2 }), measurement("fast", { cycle: 2, latencyRatio: 1 })])!.candidateId).toBe("fast");
		expect(selectBestImprovement([first, measurement("unknown-is-not-free", { cycle: 2, costRatio: 0 })])!.candidateId).toBe("first");
		expect(selectBestImprovement([measurement("later", { cycle: 3 }), first])!.candidateId).toBe("first");
	});
});
