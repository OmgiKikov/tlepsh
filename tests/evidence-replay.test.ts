import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectCandidateReplayPage, MAX_REPLAY_NAV_ITEMS } from "../src/evidence/replay-model.js";
import { loadPublicEvalRun } from "../src/evidence/model.js";
import { compareVerifiedEvalRuns } from "../src/compare.js";
import { CandidateRecordSchema, type CandidateRecord } from "../src/domain/candidate.js";
import { loadRun, readEvalRunIndex } from "../src/eval.js";
import { hashFile, hashValue, RunRecordSchema, type GraderResult, type RunRecord } from "../src/provenance.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";
import { SEALED_SENTINEL, writeExplorerFixture, type ArmCase } from "./helpers/evidence-fixture.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function check(passed: boolean): GraderResult {
	return { name: "required action", type: "tool_called", checkCode: "required-tool", checkSubject: "freeze",
		specHash: `sha256:${"a".repeat(64)}`, passed, score: passed ? 1 : 0, reason: passed ? "tool freeze called" : "tool freeze not called" };
}

function fixture(tasks = 8, repetitions = 2, costUsd?: number | null) {
	const data = writeExplorerFixture((candidate) => Array.from({ length: tasks }, (_, index) =>
		Array.from({ length: repetitions }, (_, repetitionIndex): ArmCase => {
			// The final task regresses only on its second repetition. Its first
			// replay is a pass on both sides, while all-repetition stats regress.
			const passed = candidate ? !(index === tasks - 1 && repetitionIndex > 0) : index !== 0;
			return { taskId: `task_${String(index + 1).padStart(3, "0")}`, repetitionIndex,
				input: `Case ${index + 1}`, answer: `${candidate ? "After" : "Before"} ${index + 1}/${repetitionIndex + 1}`,
				calledTool: passed, graders: [check(passed)], ...(costUsd !== undefined ? { costUsd } : {}) };
		})).flat());
	roots.push(data.runsRoot);
	return data;
}

function amendRun(runsRoot: string, runId: string, amend: (run: RunRecord) => RunRecord): RunRecord {
	const run = amend(loadRun(runsRoot, runId));
	writeJsonArtifact(join(runsRoot, runId, "run.json"), RunRecordSchema, run);
	const index = readEvalRunIndex(runsRoot, run.parent!.evalRunId);
	writeFileSync(join(runsRoot, index.evalRunId, "eval_run.json"), JSON.stringify({ ...index,
		runArtifacts: index.runArtifacts!.map((entry) => entry.runId === runId ? { runId, sha256: hashValue(run) } : entry) }));
	return run;
}

function rewriteCandidate(runsRoot: string, candidateId: string, amend: (event: CandidateRecord["events"][number]) => CandidateRecord["events"][number]) {
	const path = join(runsRoot, "candidates", candidateId, "candidate.json");
	const candidate = CandidateRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
	writeFileSync(path, JSON.stringify({ ...candidate, events: candidate.events.map(amend) }));
}

describe("recorded paired replay", () => {
	it("defaults to the first matched repetition of the regression and preserves whole-comparison statistics", () => {
		const data = fixture();
		const replay = collectCandidateReplayPage(data.runsRoot, data.candidateId);
		expect(replay.selected).toMatchObject({ taskId: "task_008", repetitionIndex: 0,
			stats: { aPass: 2, aTotal: 2, bPass: 1, bTotal: 2, scoreDelta: -0.5 },
			baseline: { outcome: "pass" }, candidate: { outcome: "pass" } });
		const comparison = compareVerifiedEvalRuns(loadPublicEvalRun(data.runsRoot, data.baselineEvalRunId),
			loadPublicEvalRun(data.runsRoot, data.candidateEvalRunId), { mode: "candidate" });
		expect(replay.comparison.summary).toEqual(comparison.summary);
		expect(replay.comparison.verdict).toEqual(comparison.gate.verdict);
		expect(replay.comparison.resources).toEqual(comparison.resources);
		expect(replay.navigation).toMatchObject({ total: 16, omittedCount: 0, selectedRunId: "run_base_14" });
		expect(replay.proposal).toMatchObject({ available: false });
	});

	it("selects the eighth case's second repetition, beyond the six static previews", () => {
		const data = fixture();
		const replay = collectCandidateReplayPage(data.runsRoot, data.candidateId, { runId: "run_base_15" });
		expect(replay.selected).toMatchObject({ taskId: "task_008", repetitionIndex: 1,
			baseline: { runId: "run_base_15", outcome: "pass" }, candidate: { runId: "run_cand_15", outcome: "fail" } });
		expect(JSON.stringify(replay.selected.baseline.transcript)).toContain("Before 8/2");
		expect(JSON.stringify(replay.selected.candidate.transcript)).toContain("After 8/2");
		expect(JSON.stringify(replay)).not.toContain("Before 3/1");
	});

	it("keeps a selected pair visible outside bounded navigation with exact omissions", () => {
		const data = fixture(60);
		const replay = collectCandidateReplayPage(data.runsRoot, data.candidateId, { runId: "run_base_113" });
		expect(replay.navigation.items).toHaveLength(MAX_REPLAY_NAV_ITEMS);
		expect(replay.navigation.items.some((item) => item.baselineRunId === "run_base_113")).toBe(true);
		expect(replay.navigation).toMatchObject({ total: 120, omittedCount: 20, selectedRunId: "run_base_113" });
		expect(replay.selected).toMatchObject({ taskId: "task_057", repetitionIndex: 1 });
	});

	it.each(["run_cand_0", "run_missing", "../run_base_0"])("refuses unmatched, same-arm or path-like selector %s", (runId) => {
		const data = fixture();
		expect(() => collectCandidateReplayPage(data.runsRoot, data.candidateId, { runId })).toThrow();
	});

	it("refuses same evaluation arms", () => {
		const data = fixture();
		rewriteCandidate(data.runsRoot, data.candidateId, (event) => event.type === "evaluated" ? {
			...event, evaluation: { ...event.evaluation, development: {
				...event.evaluation.development, candidate: { ...event.evaluation.development.candidate, evalRunId: data.baselineEvalRunId },
			} },
		} : event);
		expect(() => collectCandidateReplayPage(data.runsRoot, data.candidateId)).toThrow("distinct eval");
	});

	it("refuses altered Candidate revision links", () => {
		const data = fixture();
		rewriteCandidate(data.runsRoot, data.candidateId, (event) => event.type === "built"
			? { ...event, candidate: { ...event.candidate, sha: "9".repeat(40) } } : event);
		expect(() => collectCandidateReplayPage(data.runsRoot, data.candidateId)).toThrow();
	});

	it("never exposes sealed identities/content, even when a sealed run is selected or moved into the pair", () => {
		const data = fixture();
		expect(JSON.stringify(collectCandidateReplayPage(data.runsRoot, data.candidateId))).not.toContain(SEALED_SENTINEL);
		expect(JSON.stringify(collectCandidateReplayPage(data.runsRoot, data.candidateId))).not.toContain(data.sealedEvalRunId);
		expect(() => collectCandidateReplayPage(data.runsRoot, data.candidateId, { runId: data.sealedRunId })).toThrow();
		rewriteCandidate(data.runsRoot, data.candidateId, (event) => event.type === "evaluated" ? {
			...event, evaluation: { ...event.evaluation, development: {
				...event.evaluation.development, baseline: { ...event.evaluation.development.baseline, evalRunId: data.sealedEvalRunId },
			} },
		} : event);
		expect(() => collectCandidateReplayPage(data.runsRoot, data.candidateId)).toThrow("not public evidence");
	});

	it("refuses tampered run records and marks tampered or missing trace bytes unavailable", () => {
		const data = fixture();
		writeFileSync(join(data.runsRoot, "run_base_14", "session.jsonl"), "TAMPERED_TRACE_CONTENT");
		const replay = collectCandidateReplayPage(data.runsRoot, data.candidateId);
		expect(replay.selected.baseline.transcript).toBeNull();
		expect(replay.selected.baseline.graders).toHaveLength(1);
		expect(JSON.stringify(replay)).not.toContain("TAMPERED_TRACE_CONTENT");
		expect(replay.notices.join(" ")).toContain("integrity");
		const run = loadRun(data.runsRoot, "run_cand_14");
		writeFileSync(join(data.runsRoot, "run_cand_14", "run.json"), JSON.stringify({ ...run, metrics: { ...run.metrics, costUsd: 999 } }));
		expect(() => collectCandidateReplayPage(data.runsRoot, data.candidateId)).toThrow("hash");
	});

	it("redacts credentials, omits thinking, and retains reported and unanswered tool evidence", () => {
		const data = fixture();
		const trace = [
			{ type: "message", message: { role: "user", content: "password=REAL_SECRET", timestamp: 1 } },
			{ type: "message", message: { role: "assistant", content: [
				{ type: "thinking", thinking: "PRIVATE_THINKING" },
				{ type: "text", text: "Checking" },
				{ type: "toolCall", id: "reported", name: "freeze", arguments: { token: "OPAQUE_SECRET" }, evidence: "reported" },
				{ type: "toolCall", id: "unanswered", name: "read", arguments: { path: "record.json" } },
			], timestamp: 2 } },
		].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
		writeFileSync(join(data.runsRoot, "run_base_14", "session.jsonl"), trace);
		amendRun(data.runsRoot, "run_base_14", (run) => ({ ...run, trace: { ...run.trace, sha256: hashFile(trace) } }));
		const replay = collectCandidateReplayPage(data.runsRoot, data.candidateId);
		const serialized = JSON.stringify(replay);
		for (const secret of ["REAL_SECRET", "OPAQUE_SECRET", "PRIVATE_THINKING"]) expect(serialized).not.toContain(secret);
		expect(replay.selected.baseline.transcript?.entries).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "tool", evidence: "reported", result: null }),
			expect.objectContaining({ kind: "tool", name: "read", result: null }),
		]));
	});

	it("keeps unknown cost unknown and exposes transcript clipping explicitly", () => {
		const data = fixture(8, 2, null);
		const trace = JSON.stringify({ type: "message", message: { role: "assistant", content: "a".repeat(30_000) } }) + "\n";
		writeFileSync(join(data.runsRoot, "run_base_14", "session.jsonl"), trace);
		amendRun(data.runsRoot, "run_base_14", (run) => ({ ...run, trace: { ...run.trace, sha256: hashFile(trace) } }));
		const replay = collectCandidateReplayPage(data.runsRoot, data.candidateId);
		expect(replay.selected.baseline.transcript?.truncated).toBe(true);
		expect(replay.selected.baseline.receipt.costUsd).toBeNull();
		expect(replay.comparison.resources.costRatio).toBeNull();
		expect(replay.notices.join(" ")).toContain("display bounds");
		expect(JSON.stringify(replay.selected.baseline.transcript).length).toBeLessThan(21_000);
	});

	it("shows attested final-world checks without exposing raw world values or manufacturing state history", () => {
		const data = fixture();
		const world = { account: { status: "frozen", customer: "PRIVATE_CUSTOMER_WORLD" } };
		const worldDirectory = join(data.runsRoot, "run_base_14", "runtime", "world");
		mkdirSync(worldDirectory, { recursive: true });
		writeFileSync(join(worldDirectory, "state.json"), JSON.stringify(world));
		amendRun(data.runsRoot, "run_base_14", (run) => ({ ...run,
			evidenceArtifacts: { world: hashValue(world), judge: {} },
			evalResults: { outcome: "pass", graders: [{ name: "final account state", type: "world_state", checkCode: "world-state",
				specHash: hashValue({ type: "world_state", path: "account.status", equals: "frozen" }),
				passed: true, score: 1, reason: 'world at account.status equals "frozen"' }] },
		}));
		const replay = collectCandidateReplayPage(data.runsRoot, data.candidateId, { runId: "run_base_14" });
		expect(replay.selected.baseline.receipt.worldKeys).toBe(1);
		expect(replay.selected.baseline.graders[0]).toMatchObject({ checkCode: "world-state", passed: true });
		expect(JSON.stringify(replay)).not.toContain("PRIVATE_CUSTOMER_WORLD");
		expect(replay.notices.join(" ")).toContain("intermediate world changes were not recorded");
	});

	it("bounds recorded check lists with explicit omissions", () => {
		const data = fixture();
		amendRun(data.runsRoot, "run_base_14", (run) => ({ ...run, evalResults: {
			outcome: "pass", graders: Array.from({ length: 80 }, (_, index) => ({ ...check(true), name: `Check ${index + 1}` })),
		} }));
		const replay = collectCandidateReplayPage(data.runsRoot, data.candidateId, { runId: "run_base_14" });
		expect(replay.selected.baseline.graders).toHaveLength(64);
		expect(replay.selected.baseline.omittedGraders).toBe(16);
	});
});
