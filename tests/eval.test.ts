import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_EVAL_JOBS,
	EvalRunRecordSchema,
	defaultEvalJobs,
	findReusableBaseline,
	answerTokens,
	gradeRun,
	isLoopbackModelEndpoint,
	levenshteinRatio,
	tokenF1,
	isSealedEvalRun,
	listEvalRunIndexes,
	listEvalRunIndexesLenient,
	listPublicEvalRunIndexesBounded,
	readEvalRunIndex,
	EVAL_RUN_SCHEMA_VERSION,
	loadRun,
	loadVerifiedEvalRun,
	runSuite,
	writeEvalRun,
	type EvalRunRecord,
	type ReusableBaselineQuery,
} from "../src/eval.js";
import { loadTarget } from "../src/manifest.js";
import { startMockModel } from "../src/mock-model.js";
import { baseFixtureFiles, makeTargetFixture } from "./fixtures.js";
import { GraderSpec, type ResolvedTask } from "../src/manifest.js";
import {
	GraderResultSchema,
	RunRecordSchema,
	hashFile,
	hashValue,
	provenanceAxes,
	type GraderResult,
	type RunRecord,
} from "../src/provenance.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";
import { compareVerifiedEvalRuns } from "../src/compare.js";

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
		schemaVersion: 3,
		purpose: "evidence" as const,
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
		const { graders: results } = await gradeRun(task, baseRun({ status: "error", error: "boom", finishedAt: "2026-08-28T10:00:01.000Z", evalResults: null }), runsRoot);

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

describe("reference-answer graders", () => {
	/** Grade one answer through the real trace path, exactly as a run is graded. */
	async function grade(
		graders: unknown[],
		answer: string,
		expected?: string,
	): Promise<GraderResult[]> {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-reference-test-"));
		cleanupPaths.push(runsRoot);
		const trace = `${[
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "question" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: answer }] } },
		].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		mkdirSync(join(runsRoot, "run-a"), { recursive: true });
		writeFileSync(join(runsRoot, "run-a", "session.jsonl"), trace);
		const task = {
			id: "task-a",
			input: "question",
			...(expected === undefined ? {} : { expected }),
			effectiveGraders: graders as ResolvedTask["effectiveGraders"],
		} as ResolvedTask;
		const record = baseRun({ trace: { path: "session.jsonl", sessionId: null, sha256: hashFile(trace) } });
		return (await gradeRun(task, record, runsRoot)).graders;
	}

	it("exact match normalizes both sides the way the spec asks", async () => {
		const table: Array<{ normalize?: string; answer: string; expected: string; passed: boolean }> = [
			// Default `lower`: trim, case-fold, collapse internal whitespace.
			{ answer: "  Для золотых —  60   дней. ", expected: "для золотых — 60 дней.", passed: true },
			{ answer: "Для золотых — 61 день.", expected: "Для золотых — 60 дней.", passed: false },
			{ normalize: "trim", answer: " Да ", expected: "Да", passed: true },
			{ normalize: "trim", answer: "да", expected: "Да", passed: false },
			{ normalize: "trim", answer: "Да  и  нет", expected: "Да и нет", passed: false },
			{ normalize: "none", answer: "Да", expected: "Да", passed: true },
			{ normalize: "none", answer: "Да ", expected: "Да", passed: false },
		];
		for (const row of table) {
			const [result] = await grade(
				[{ type: "exact", ...(row.normalize ? { normalize: row.normalize } : {}) }],
				row.answer,
				row.expected,
			);
			expect({ ...row, actual: result?.passed }).toEqual({ ...row, actual: row.passed });
			expect(result?.checkCode).toBe("reference-exact");
			expect(result?.score).toBe(row.passed ? 1 : 0);
		}
	});

	it("similarity scores against its threshold and names the metric in the reason", async () => {
		const [tokenPass] = await grade(
			[{ type: "similarity", metric: "token-f1", threshold: 0.8 }],
			"Возврат занимает тридцать дней",
			"возврат занимает 30 дней",
		);
		expect(tokenPass?.passed).toBe(false);
		expect(tokenPass?.reason).toMatch(/^token-f1 = 0\.75, below threshold 0\.8$/);
		expect(tokenPass?.checkCode).toBe("reference-similarity");

		const [tokenLoose] = await grade(
			[{ type: "similarity", metric: "token-f1", threshold: 0.7 }],
			"Возврат занимает тридцать дней",
			"возврат занимает 30 дней",
		);
		expect(tokenLoose?.passed).toBe(true);

		// A long answer against a short reference is refused on the length bound
		// alone, without filling the distance matrix.
		const [bounded] = await grade(
			[{ type: "similarity", metric: "levenshtein", threshold: 0.9 }],
			`да. ${"и ещё много слов. ".repeat(200)}`,
			"да.",
		);
		expect(bounded?.passed).toBe(false);
		expect(bounded?.reason).toContain("length-difference bound");

		const [close] = await grade(
			[{ type: "similarity", metric: "levenshtein", threshold: 0.9 }],
			"Комиссия не взимается",
			"комиссия не взимаются",
		);
		expect(close?.passed).toBe(true);
		expect(close?.reason).toMatch(/^levenshtein = 0\.95\d*, at or above threshold 0\.9$/);
	});

	it("token-F1 and the levenshtein ratio are unicode-exact", () => {
		expect(answerTokens("Привет, мир! 42 — ok")).toEqual(["привет", "мир", "42", "ok"]);

		// Order-insensitive, case-folded, multiset overlap.
		expect(tokenF1("Кот сидит на окне", "на окне сидит кот")).toBe(1);
		expect(tokenF1("а б в", "а б в г")).toBeCloseTo(6 / 7, 10);
		expect(tokenF1("а а б", "а б")).toBeCloseTo(0.8, 10);
		expect(tokenF1("", "")).toBe(1);
		expect(tokenF1("что-то", "")).toBe(0);
		expect(tokenF1("кот", "пёс")).toBe(0);

		// Code points, not UTF-16 units: one changed emoji out of two is half.
		expect(levenshteinRatio("🙂🙂", "🙂🙃").score).toBe(0.5);
		expect(levenshteinRatio("кот", "код").score).toBeCloseTo(2 / 3, 10);
		expect(levenshteinRatio("", "").score).toBe(1);
		expect(levenshteinRatio("ёлка", "елка").score).toBe(0.75);
		expect(levenshteinRatio("да", "да")).toEqual({ score: 1, bounded: false });
		// The bound is only ever returned when it already fails the threshold.
		const wayOff = levenshteinRatio("a".repeat(10), "a".repeat(1000), 0.5);
		expect(wayOff.bounded).toBe(true);
		expect(wayOff.score).toBeCloseTo(0.01, 10);
		expect(levenshteinRatio("a".repeat(10), "a".repeat(1000), 0.001).bounded).toBe(false);
	});

	it("every reference grader fails loudly on a case with no expected answer", async () => {
		const results = await grade(
			[
				{ type: "exact" },
				{ type: "similarity", metric: "token-f1", threshold: 0.5 },
				{ type: "judge", rubric: "фактическая верность", withReference: true },
				{ type: "output_contains", text: "" },
			],
			"любой ответ",
		);
		expect(results.slice(0, 3).map((result) => [result.type, result.passed, result.reason])).toEqual([
			["exact", false, "case has no expected answer"],
			["similarity", false, "case has no expected answer"],
			["judge", false, "case has no expected answer"],
		]);
		expect(results.slice(0, 3).every((result) => result.score === 0)).toBe(true);
		// No judge model was configured and none was needed: the missing reference
		// is decided before any request would be built.
		expect(results[3]?.passed).toBe(true);
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

describe("concurrent suite execution", () => {
	const CONCURRENT_TIMEOUT_MS = 180_000;

	function suiteFixture(mockUrl: string, tasks: readonly { id: string; input: string; answer: string }[]): string {
		return makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": `id: concurrency-target
model:
  provider: qwen-mock
  id: mock
  api: openai-completions
  baseUrl: ${mockUrl}
  apiKeyEnv: MOCK_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 60000
instructions:
  agentsMd: AGENTS.md
skills: []
evalSuite:
  id: concurrency-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`,
			"evals/development.jsonl": tasks
				.map((task) => JSON.stringify({
					id: task.id,
					input: task.input,
					graders: [{ type: "output_contains", text: task.answer }],
				}))
				.join("\n"),
			"evals/graders.yaml": "defaults: []\n",
		}));
	}

	it("concurrent suite persists runIds and runArtifacts in design order and verifies", async () => {
		process.env.MOCK_MODEL_KEY = "test-key";
		// The first task in the design is the slowest, so completion order is
		// guaranteed to disagree with design order.
		const mock = await startMockModel([
			{ match: ({ firstUser }) => firstUser.includes("SLOW"), steps: [{ text: "answer-slow", delayMs: 600 }] },
			{ match: () => true, steps: [{ text: "answer-fast" }] },
		]);
		const dir = suiteFixture(mock.url, [
			{ id: "task_slow", input: "SLOW request", answer: "answer-slow" },
			{ id: "task_fast_a", input: "quick request a", answer: "answer-fast" },
			{ id: "task_fast_b", input: "quick request b", answer: "answer-fast" },
		]);
		const runsRoot = join(dir, "..", `concurrent-runs-${Date.now()}`);
		cleanupPaths.push(dir, runsRoot);
		try {
			const graded: number[] = [];
			const record = await runSuite(loadTarget(dir), {
				runsRoot,
				label: "baseline",
				repetitions: 2,
				jobs: 4,
				onRunEvent: (event) => {
					if (event.type === "run_graded") graded.push(event.run.ordinal);
				},
			});

			expect(record.summary).toMatchObject({ total: 6, pass: 6, fail: 0, error: 0 });
			expect(record.taskIds).toEqual(["task_slow", "task_fast_a", "task_fast_b"]);
			// Design order, not completion order: ordinals 1-2 are the slow task's
			// two repetitions and they graded last.
			expect(graded).toHaveLength(6);
			expect(graded.slice(-2).sort()).toEqual([1, 2]);
			expect(record.runIds.map((runId) => loadRun(runsRoot, runId).taskId)).toEqual([
				"task_slow", "task_slow", "task_fast_a", "task_fast_a", "task_fast_b", "task_fast_b",
			]);
			expect(record.runIds.map((runId) => loadRun(runsRoot, runId).repetitionIndex))
				.toEqual([0, 1, 0, 1, 0, 1]);
			expect(record.runArtifacts?.map((artifact) => artifact.runId)).toEqual(record.runIds);

			const verified = loadVerifiedEvalRun(runsRoot, record.evalRunId);
			expect(verified.runs.map((run) => run.runId)).toEqual(record.runIds);
		} finally {
			await mock.close();
		}
	}, CONCURRENT_TIMEOUT_MS);

	it("abort waits for in-flight runs before snapshot disposal", async () => {
		process.env.MOCK_MODEL_KEY = "test-key";
		const mock = await startMockModel([{ steps: [{ text: "answer-fast", delayMs: 400 }] }]);
		const dir = suiteFixture(mock.url, [
			{ id: "task_1", input: "one", answer: "answer-fast" },
			{ id: "task_2", input: "two", answer: "answer-fast" },
			{ id: "task_3", input: "three", answer: "answer-fast" },
			{ id: "task_4", input: "four", answer: "answer-fast" },
		]);
		const runsRoot = join(dir, "..", `abort-runs-${Date.now()}`);
		cleanupPaths.push(dir, runsRoot);
		try {
			const controller = new AbortController();
			const started: string[] = [];
			const finished: string[] = [];
			await expect(runSuite(loadTarget(dir), {
				runsRoot,
				label: "solo",
				repetitions: 1,
				jobs: 4,
				signal: controller.signal,
				onRunEvent: (event) => {
					if (event.type === "run_started") {
						started.push(event.run.runId);
						controller.abort();
					}
					if (event.type === "execution_finished") finished.push(event.run.runId);
				},
			})).rejects.toThrow(/abort/i);

			expect(started.length).toBeGreaterThan(0);
			// Every execution that started also settled: the shared snapshot stayed
			// alive until the last in-flight run was done with it.
			expect(finished.sort()).toEqual([...started].sort());
			for (const runId of started) {
				const durable = JSON.parse(readFileSync(join(runsRoot, runId, "run.json"), "utf8")) as {
					status: string;
					finishedAt: string | null;
					error: string | null;
				};
				expect(durable.status).not.toBe("running");
				expect(durable.finishedAt).not.toBeNull();
				expect(durable.error ?? "").not.toMatch(/snapshot/i);
			}
		} finally {
			await mock.close();
		}
	}, CONCURRENT_TIMEOUT_MS);

	it("loopback baseUrl defaults to one job", async () => {
		expect(isLoopbackModelEndpoint("http://127.0.0.1:1234/v1")).toBe(true);
		expect(isLoopbackModelEndpoint("http://localhost:8080/v1")).toBe(true);
		expect(isLoopbackModelEndpoint("http://[::1]:1234/v1")).toBe(true);
		expect(isLoopbackModelEndpoint("https://openrouter.ai/api/v1")).toBe(false);
		expect(defaultEvalJobs({ baseUrl: "http://127.0.0.1:1234/v1" })).toBe(1);
		expect(defaultEvalJobs({ baseUrl: "https://openrouter.ai/api/v1" })).toBe(DEFAULT_EVAL_JOBS);

		process.env.MOCK_MODEL_KEY = "test-key";
		const mock = await startMockModel([{ steps: [{ text: "answer-fast", delayMs: 60 }] }]);
		const dir = suiteFixture(mock.url, [
			{ id: "task_1", input: "one", answer: "answer-fast" },
			{ id: "task_2", input: "two", answer: "answer-fast" },
			{ id: "task_3", input: "three", answer: "answer-fast" },
		]);
		const runsRoot = join(dir, "..", `loopback-runs-${Date.now()}`);
		cleanupPaths.push(dir, runsRoot);
		try {
			let inFlight = 0;
			let peak = 0;
			const record = await runSuite(loadTarget(dir), {
				runsRoot,
				label: "solo",
				repetitions: 1,
				onRunEvent: (event) => {
					if (event.type === "run_started") {
						inFlight += 1;
						peak = Math.max(peak, inFlight);
					}
					if (event.type === "execution_finished") inFlight -= 1;
				},
			});
			expect(record.summary).toMatchObject({ total: 3, pass: 3 });
			// A local model server is the bottleneck; nothing overlaps it.
			expect(peak).toBe(1);
		} finally {
			await mock.close();
		}
	}, CONCURRENT_TIMEOUT_MS);
});

describe("baseline reuse", () => {
	const DAY_MS = 24 * 60 * 60 * 1_000;

	function writeReusableBaseline(finishedAt: string): { runsRoot: string; query: ReusableBaselineQuery } {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-reuse-test-"));
		cleanupPaths.push(runsRoot);
		const target = {
			id: "test-target",
			gitSha: "a".repeat(40),
			toolsetHash: hash("7"),
			workspaceHash: hash("8"),
		};
		const parent = { evalRunId: "erun_reusable", candidateOf: null };
		const runs = [
			baseRun({ runId: "reuse-run-a", taskId: "task-a", target, parent }),
			baseRun({ runId: "reuse-run-b", taskId: "task-b", target, parent }),
		];
		for (const run of runs) writeJsonArtifact(join(runsRoot, run.runId, "run.json"), RunRecordSchema, run);
		const first = runs[0];
		if (!first) throw new Error("reuse fixture requires at least one run");
		const provenance = provenanceAxes({
			runtime: first.runtime,
			model: first.model,
			judge: null,
			execution: first.execution,
			eval: first.eval,
		});
		writeEvalRun(runsRoot, {
			schemaVersion: 3,
			purpose: "evidence" as const,
			evalRunId: "erun_reusable",
			target,
			label: "baseline",
			baselineEvalRunId: null,
			provenance,
			provenanceKey: hashValue(provenance),
			suiteId: first.eval.suiteId,
			suiteHash: first.eval.suiteHash,
			dataset: first.eval.dataset,
			datasetHash: first.eval.datasetHash,
			evidenceVisibility: "development",
			taskIds: ["task-a", "task-b"],
			repetitions: 1,
			runIds: runs.map((run) => run.runId),
			startedAt: "2026-08-28T10:00:00.000Z",
			finishedAt,
			summary: { total: 2, pass: 2, fail: 0, error: 0, allPassRate: 1 },
		});
		return {
			runsRoot,
			query: {
				targetId: target.id,
				targetGitSha: target.gitSha,
				toolsetHash: target.toolsetHash,
				workspaceHash: target.workspaceHash,
				provenance,
				evidenceVisibility: "development",
				label: "baseline",
				repetitions: 1,
			},
		};
	}

	it("a v1 index lists as legacy and is never reused", () => {
		const fresh = writeReusableBaseline(new Date().toISOString());
		// A pre-V1.8 index: schemaVersion 1 and the retired ahdeCodeHash axis.
		const legacyDir = join(fresh.runsRoot, "erun_legacy_v1");
		mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
		writeFileSync(join(legacyDir, "eval_run.json"), JSON.stringify({
			schemaVersion: 1,
			evalRunId: "erun_legacy_v1",
			target: { id: "test-target", gitSha: "a".repeat(40) },
			label: "baseline",
			baselineEvalRunId: null,
			provenance: { ahdeCodeHash: hash("c") },
			provenanceKey: hash("f"),
			suiteId: "test-suite",
			suiteHash: hash("d"),
			dataset: "development",
			datasetHash: hash("e"),
			repetitions: 1,
			runIds: ["legacy-run"],
			startedAt: "2020-01-01T00:00:00.000Z",
			finishedAt: new Date().toISOString(),
			summary: { total: 1, pass: 1, fail: 0, error: 0, allPassRate: 1 },
		}));

		const listed = listEvalRunIndexesLenient(fresh.runsRoot);
		expect(listed.records.map((record) => record.evalRunId)).toEqual(["erun_reusable"]);
		expect(listed.invalid).toEqual([
			{ evalRunId: "erun_legacy_v1", reason: expect.stringContaining("legacy schemaVersion 1 (not comparable)") },
		]);
		// The fresh v2 baseline is still reusable; the legacy sibling is invisible.
		expect(findReusableBaseline(fresh.runsRoot, fresh.query)?.evalRunId).toBe("erun_reusable");
	});

	it("a baseline older than max-age is not reused", () => {
		const fresh = writeReusableBaseline(new Date(Date.now() - DAY_MS).toISOString());
		expect(findReusableBaseline(fresh.runsRoot, fresh.query)?.evalRunId).toBe("erun_reusable");

		const stale = writeReusableBaseline(new Date(Date.now() - 8 * DAY_MS).toISOString());
		expect(findReusableBaseline(stale.runsRoot, stale.query)).toBeNull();
		// The limit is the caller's to widen…
		expect(findReusableBaseline(stale.runsRoot, { ...stale.query, maxAgeMs: 30 * DAY_MS })?.evalRunId)
			.toBe("erun_reusable");
		// …or to close entirely, so every experiment measures its own baseline.
		expect(findReusableBaseline(fresh.runsRoot, { ...fresh.query, maxAgeMs: 0 })).toBeNull();
	});

	it("an unreadable finishedAt cannot prove freshness", () => {
		const broken = writeReusableBaseline("not-a-timestamp");
		expect(findReusableBaseline(broken.runsRoot, broken.query)).toBeNull();
	});
});

describe("eval run purpose", () => {
	it("reads a two-arm pre-purpose (v2) index as evidence, byte-for-byte unchanged on disk", () => {
		const fixture = writeEvalFixture();
		const path = join(fixture.runsRoot, fixture.record.evalRunId, "eval_run.json");
		// Exactly what a v2 index on disk looks like: no `purpose`, schemaVersion 2.
		const { purpose: _purpose, ...rest } = fixture.record;
		const legacyBytes = `${JSON.stringify({ ...rest, schemaVersion: 2 }, null, 2)}\n`;
		writeFileSync(path, legacyBytes);

		const read = readEvalRunIndex(fixture.runsRoot, fixture.record.evalRunId);
		// A screen could never wear a baseline/candidate label, so this arm is known.
		expect(read.purpose).toBe("evidence");
		expect(read.schemaVersion).toBe(EVAL_RUN_SCHEMA_VERSION);
		// Reading is not rewriting: the artifact keeps its exact bytes.
		expect(readFileSync(path, "utf8")).toBe(legacyBytes);
		// And it is still ordinary evidence: reusable, and comparable.
		expect(loadVerifiedEvalRun(fixture.runsRoot, fixture.record.evalRunId).record.purpose).toBe("evidence");
	});

	it("quarantines a one-arm v2 index because a missing marker makes screen vs evidence unknowable", () => {
		const fixture = writeEvalFixture();
		const path = join(fixture.runsRoot, fixture.record.evalRunId, "eval_run.json");
		const { purpose: _purpose, ...rest } = fixture.record;
		writeFileSync(path, `${JSON.stringify({ ...rest, schemaVersion: 2, label: "solo" }, null, 2)}\n`);

		const read = readEvalRunIndex(fixture.runsRoot, fixture.record.evalRunId);
		expect(read.purpose).toBe("legacy-unknown");
		const verified = { record: read, runs: [], hasRunHashes: true } as unknown as
			Parameters<typeof compareVerifiedEvalRuns>[0];
		const compared = compareVerifiedEvalRuns(verified, verified, { mode: "candidate" });
		expect(compared.status).toBe("invalid");
		expect(compared.issues.join(" ")).toContain("ambiguous one-arm evidence");
	});

	it("keeps every provenance key and the provenanceKey hash exactly where they were", () => {
		const fixture = writeEvalFixture();
		// `purpose` is OUTSIDE the provenance axes on purpose: adding it must not
		// move a single provenance key, or every baseline on disk stops matching.
		expect(Object.keys(fixture.record.provenance).sort()).toEqual([
			"ahdeVersion",
			"datasetHash",
			"evaluatorId",
			"execution",
			"judge",
			"modelApi",
			"modelApiKeyEnv",
			"modelBaseUrl",
			"modelId",
			"modelSpec",
			"params",
			"piSha",
			"piVersion",
			"provider",
			"suiteHash",
			"thinkingLevel",
		]);
		expect(fixture.record.provenance).not.toHaveProperty("purpose");
		expect(fixture.record.provenanceKey).toBe(hashValue(fixture.record.provenance));
		// The same axes hash the same whether the record is evidence or a screen.
		const asScreen = { ...fixture.record, purpose: "screen" as const, label: "solo" as const };
		expect(hashValue(asScreen.provenance)).toBe(fixture.record.provenanceKey);
	});

	it("refuses a v1 index, which really does describe a different contract", () => {
		const fixture = writeEvalFixture();
		const path = join(fixture.runsRoot, fixture.record.evalRunId, "eval_run.json");
		const { purpose: _purpose, ...rest } = fixture.record;
		writeFileSync(path, JSON.stringify({ ...rest, schemaVersion: 1 }, null, 2));
		expect(() => readEvalRunIndex(fixture.runsRoot, fixture.record.evalRunId)).toThrow();
	});

	it("will not let a screen wear a two-arm label", () => {
		const fixture = writeEvalFixture();
		expect(EvalRunRecordSchema.safeParse({
			...fixture.record,
			purpose: "screen",
			label: "baseline",
		}).success).toBe(false);
		expect(EvalRunRecordSchema.safeParse({
			...fixture.record,
			purpose: "screen",
			label: "solo",
		}).success).toBe(true);
	});
});
