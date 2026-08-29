import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	EvalRunRecordSchema,
	gradeRun,
	isSealedEvalRun,
	listEvalRunIndexes,
	listPublicEvalRunIndexesBounded,
	loadVerifiedEvalRun,
	writeEvalRun,
	type EvalRunRecord,
} from "../src/eval.js";
import { GraderSpec, type ResolvedTask } from "../src/manifest.js";
import {
	GraderResultSchema,
	RunRecordSchema,
	hashValue,
	provenanceAxes,
	type RunRecord,
} from "../src/provenance.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";

const cleanupPaths: string[] = [];

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function hash(character: string): string {
	return `sha256:${character.repeat(64)}`;
}

function baseRun(overrides: Partial<RunRecord> = {}): RunRecord {
	return RunRecordSchema.parse({
		schemaVersion: 1,
		runId: "run-a",
		taskId: "task-a",
		repetitionIndex: 0,
		label: "baseline",
		status: "completed",
		error: null,
		startedAt: "2026-08-28T10:00:00.000Z",
		finishedAt: "2026-08-28T10:00:01.000Z",
		target: { id: "test-target", gitSha: "a".repeat(40) },
		runtime: {
			piVersion: "0.84.3",
			piSha: "b".repeat(40),
			ahdeVersion: "0.1.0",
			ahdeCodeHash: hash("c"),
		},
		model: {
			provider: "test",
			id: "test-model",
			api: "openai-completions",
			baseUrl: "https://example.invalid/v1",
			apiKeyEnv: "TEST_KEY",
			thinkingLevel: "off",
			params: {},
			spec: {},
		},
		execution: {
			workspace: "isolated-copy-v1",
			tools: ["read"],
			environment: [],
			sandbox: "none",
			network: "deny",
			filesystem: "workspace-confined-v1",
			resources: {
				contextFiles: "disabled",
				extensions: "disabled",
				promptTemplates: "disabled",
				skills: "manifest-only",
			},
		},
		eval: {
			suiteId: "test-suite",
			suiteHash: hash("d"),
			dataset: "development",
			datasetHash: hash("e"),
		},
		trace: { path: "session.jsonl", sessionId: null, sha256: null },
		metrics: {
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			costUsd: 0,
			latencyMs: 1,
			toolCalls: 0,
			toolErrors: 0,
			recoveryAttempts: 0,
		},
		evalResults: {
			graders: [{ name: "legacy", type: "output_contains", passed: true, score: 1, reason: "ok" }],
			outcome: "pass",
		},
		parent: { evalRunId: "erun-test", candidateOf: null },
		...overrides,
	});
}

function writeEvalFixture(taskIds?: string[]): { runsRoot: string; record: EvalRunRecord } {
	const runsRoot = mkdtempSync(join(tmpdir(), "ahde-eval-test-"));
	cleanupPaths.push(runsRoot);
	const runs = [
		baseRun(),
		baseRun({ runId: "run-b", taskId: "task-b" }),
	];
	for (const run of runs) {
		writeJsonArtifact(join(runsRoot, run.runId, "run.json"), RunRecordSchema, run);
	}
	const first = runs[0];
	if (!first) throw new Error("eval fixture requires at least one run");
	const provenance = provenanceAxes({
		runtime: first.runtime,
		model: first.model,
		judge: null,
		execution: first.execution,
		eval: first.eval,
	});
	const record: EvalRunRecord = {
		schemaVersion: 2,
		evalRunId: "erun-test",
		target: first.target,
		label: "baseline",
		baselineEvalRunId: null,
		provenance,
		provenanceKey: hashValue(provenance),
		suiteId: first.eval.suiteId,
		suiteHash: first.eval.suiteHash,
		dataset: first.eval.dataset,
		datasetHash: first.eval.datasetHash,
		...(taskIds ? { evidenceVisibility: "development" as const, taskIds } : {}),
		repetitions: 1,
		runIds: runs.map((run) => run.runId),
		startedAt: "2026-08-28T10:00:00.000Z",
		finishedAt: "2026-08-28T10:00:01.000Z",
		summary: { total: 2, pass: 2, fail: 0, error: 0, allPassRate: 1 },
	};
	writeEvalRun(runsRoot, record);
	return { runsRoot, record };
}

describe("typed grader evidence", () => {
	it("accepts legacy or complete typed evidence, but rejects half a pair", () => {
		const legacy = { name: "check", type: "output_contains", passed: true, score: 1, reason: "ok" };
		const specHash = hashValue({ type: "output_contains", text: "ok", caseSensitive: false });

		expect(GraderResultSchema.safeParse(legacy).success).toBe(true);
		expect(GraderResultSchema.safeParse({
			...legacy,
			specHash,
			checkCode: "output-contains",
		}).success).toBe(true);
		expect(GraderResultSchema.safeParse({ ...legacy, specHash }).success).toBe(false);
		expect(GraderResultSchema.safeParse({ ...legacy, checkCode: "output-contains" }).success).toBe(false);
		expect(GraderResultSchema.safeParse({
			...legacy,
			specHash,
			checkCode: "required-tool",
		}).success).toBe(false);
	});

	it("gradeRun emits normalized spec hashes and stable check codes for every grader type", async () => {
		const rawSpecs = [
			{ type: "tool_called", tool: "search_docs" },
			{ type: "output_contains", text: "answer" },
			{ type: "output_matches", pattern: "ans.*" },
			{ type: "judge", rubric: "Correct and concise" },
		] as const;
		const task: ResolvedTask = {
			id: "task-a",
			input: "question",
			effectiveGraders: rawSpecs as unknown as ResolvedTask["effectiveGraders"],
		};
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-grade-test-"));
		cleanupPaths.push(runsRoot);
		const results = await gradeRun(task, baseRun({ status: "error", error: "boom", finishedAt: "2026-08-28T10:00:01.000Z", evalResults: null }), runsRoot);

		expect(results.map((result) => result.checkCode)).toEqual([
			"required-tool",
			"output-contains",
			"output-matches",
			"semantic-rubric",
		]);
		expect(results.map((result) => result.specHash)).toEqual(
			rawSpecs.map((spec) => hashValue(GraderSpec.parse(spec))),
		);
	});
});

describe("typed eval evidence", () => {
	it("rejects a run outcome that contradicts its grader results", () => {
		const valid = baseRun();
		expect(RunRecordSchema.safeParse({
			...valid,
			evalResults: {
				outcome: "pass",
				graders: [{
					name: "contradiction",
					type: "output_contains",
					passed: false,
					score: 0,
					reason: "missing",
				}],
			},
		}).success).toBe(false);
	});

	it("loads new task order metadata and remains compatible with legacy indexes", () => {
		const current = writeEvalFixture(["task-a", "task-b"]);
		expect(loadVerifiedEvalRun(current.runsRoot, current.record.evalRunId).record).toMatchObject({
			evidenceVisibility: "development",
			taskIds: ["task-a", "task-b"],
		});

		const legacy = writeEvalFixture();
		expect(loadVerifiedEvalRun(legacy.runsRoot, legacy.record.evalRunId).record.taskIds).toBeUndefined();
	});

	it("rejects taskIds that do not match the exact run source order", () => {
		const fixture = writeEvalFixture(["task-b", "task-a"]);
		expect(() => loadVerifiedEvalRun(fixture.runsRoot, fixture.record.evalRunId)).toThrow(
			/taskIds do not match the exact source task order/,
		);
	});

	it("orders equal-timestamp indexes deterministically by eval run id", () => {
		const fixture = writeEvalFixture(["task-a", "task-b"]);
		writeEvalRun(fixture.runsRoot, { ...fixture.record, evalRunId: "erun_y" });
		writeEvalRun(fixture.runsRoot, { ...fixture.record, evalRunId: "erun_z" });

		const first = listEvalRunIndexes(fixture.runsRoot).map(({ evalRunId }) => evalRunId);
		const second = listEvalRunIndexes(fixture.runsRoot).map(({ evalRunId }) => evalRunId);
		expect(first).toEqual(["erun_z", "erun_y"]);
		expect(second).toEqual(first);
	});

	it("retains an exact public top-K without leaking sealed records into truncation metadata", () => {
		const fixture = writeEvalFixture(["task-a", "task-b"]);
		for (const [evalRunId, startedAt] of [
			["erun_newest", "2026-08-28T12:00:00.000Z"],
			["erun_middle", "2026-08-28T11:00:00.000Z"],
			["erun_base", "2026-08-28T10:00:00.000Z"],
			["erun_oldest", "2026-08-28T09:00:00.000Z"],
		] as const) {
			writeEvalRun(fixture.runsRoot, { ...fixture.record, evalRunId, startedAt });
		}
		writeEvalRun(fixture.runsRoot, {
			...fixture.record,
			evalRunId: "erun_sealed_newer_than_public",
			startedAt: "2026-08-28T13:00:00.000Z",
			evidenceVisibility: "sealed",
			taskIds: ["sealed-task-a", "sealed-task-b"],
			runIds: ["sealed-run-a", "sealed-run-b"],
		});

		const bounded = listPublicEvalRunIndexesBounded(fixture.runsRoot, 2);

		expect(bounded.entries.map((record) => record.evalRunId)).toEqual(["erun_newest", "erun_middle"]);
		expect(bounded).toMatchObject({ truncated: true, omittedPublicCount: 2 });
		expect(bounded.entries[0]).not.toHaveProperty("runIds");
		expect(bounded.entries[0]).not.toHaveProperty("taskIds");
		expect(JSON.stringify(bounded)).not.toContain("sealed");
		expect(() => listPublicEvalRunIndexesBounded(fixture.runsRoot, 1_001)).toThrow(/between 1 and 1000/);
	});

	it("recognizes explicit and legacy sealed evidence and rejects conflicting metadata", () => {
		const sameContentSealedHashes = new Set([hash("e")]);
		expect(isSealedEvalRun({ dataset: "development", evidenceVisibility: "sealed" })).toBe(true);
		expect(isSealedEvalRun({ dataset: "sealed-private", evidenceVisibility: undefined })).toBe(true);
		expect(isSealedEvalRun({ dataset: "development", evidenceVisibility: "development" })).toBe(false);
		expect(isSealedEvalRun({
			dataset: "development",
			datasetHash: hash("e"),
			evidenceVisibility: "development",
		}, sameContentSealedHashes)).toBe(false);
		expect(isSealedEvalRun({
			dataset: "legacy-development",
			datasetHash: hash("e"),
			evidenceVisibility: undefined,
		}, sameContentSealedHashes)).toBe(true);

		const { record } = writeEvalFixture(["task-a", "task-b"]);
		expect(EvalRunRecordSchema.safeParse({
			...record,
			dataset: "sealed-private",
			evidenceVisibility: "development",
		}).success).toBe(false);
	});
});
