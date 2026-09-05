import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { compareEvalRuns, compareVerifiedEvalRuns, renderCompareMarkdown, renderGateLine, runCost, runTokens } from "../src/compare.js";
import { loadVerifiedEvalRun, type EvalRunRecord, type VerifiedEvalRun } from "../src/eval.js";
import { AHDE_EVALUATOR_ID, hashValue, type ProvenanceAxes, type RunRecord } from "../src/provenance.js";

function hash(char: string): string {
	return `sha256:${char.repeat(64)}`;
}

function axes(overrides: Partial<ProvenanceAxes> = {}): ProvenanceAxes {
	return {
		piVersion: "0.84.3",
		piSha: "a".repeat(40),
		ahdeVersion: "0.1.0",
		evaluatorId: AHDE_EVALUATOR_ID,
		provider: "qwen-internal",
		modelId: "qwen3.5-27b",
		modelApi: "openai-completions",
		modelBaseUrl: "http://mock/v1",
		modelApiKeyEnv: "TEST_KEY",
		thinkingLevel: "off",
		params: {},
		modelSpec: {},
		judge: null,
		execution: {
			workspace: "isolated-copy-v1",
			tools: ["read", "bash", "edit", "write"],
			environment: ["process-env"],
			sandbox: "none",
			network: "allow",
			filesystem: "workspace-confined-v1",
			resources: {
				contextFiles: "disabled",
				extensions: "disabled",
				promptTemplates: "disabled",
				skills: "manifest-only",
			},
		},
		suiteHash: hash("b"),
		datasetHash: hash("d"),
		...overrides,
	};
}

function makeEvalRun(
	runsRoot: string,
	id: string,
	provenance: ProvenanceAxes,
	runIds: string[] = [],
	options: {
		label?: "baseline" | "candidate" | "solo";
		gitSha?: string;
		repetitions?: number;
		targetId?: string;
		baselineEvalRunId?: string;
	} = {},
): void {
	const label = options.label ?? "baseline";
	const repetitions = options.repetitions ?? 1;
	const effectiveRunIds = runIds.length > 0
		? runIds
		: Array.from({ length: repetitions }, (_, index) => `run-${id}-${index}`);
	const runs: RunRecord[] = effectiveRunIds.map((runId, index) => {
		const existingPath = join(runsRoot, runId, "run.json");
		const existing = existsSync(existingPath)
			? JSON.parse(readFileSync(existingPath, "utf8")) as Partial<RunRecord>
			: {};
		const record: RunRecord = {
			schemaVersion: 1,
			runId,
			taskId: existing.taskId ?? "task",
			repetitionIndex: existing.repetitionIndex ?? index,
			label,
			status: existing.status ?? "completed",
			error: existing.error ?? null,
			startedAt: "2026-08-25T10:00:00Z",
			finishedAt: "2026-08-25T10:01:00Z",
			target: { id: options.targetId ?? "ombudsman", gitSha: options.gitSha ?? "a".repeat(40) },
			runtime: {
				piVersion: provenance.piVersion,
				piSha: provenance.piSha,
				ahdeVersion: provenance.ahdeVersion,
				ahdeCodeHash: hash("a"),
			},
			model: {
				provider: provenance.provider,
				id: provenance.modelId,
				api: provenance.modelApi,
				baseUrl: provenance.modelBaseUrl,
				apiKeyEnv: provenance.modelApiKeyEnv,
				thinkingLevel: provenance.thinkingLevel,
				params: provenance.params,
				spec: provenance.modelSpec,
			},
			execution: provenance.execution,
			eval: { suiteId: "s", suiteHash: provenance.suiteHash, dataset: "development", datasetHash: provenance.datasetHash },
			trace: { path: "session.jsonl", sessionId: null, sha256: null },
			metrics: existing.metrics ?? {
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				costUsd: 0,
				latencyMs: 0,
				toolCalls: 0,
				toolErrors: 0,
				recoveryAttempts: 0,
			},
			evalResults: existing.evalResults ?? { graders: [], outcome: "pass" },
			parent: {
				evalRunId: id,
				candidateOf: label === "candidate" ? "a".repeat(40) : null,
			},
		};
		mkdirSync(join(runsRoot, runId), { recursive: true });
		writeFileSync(existingPath, JSON.stringify(record));
		return record;
	});
	const pass = runs.filter((run) => run.evalResults?.outcome === "pass").length;
	const fail = runs.filter((run) => run.evalResults?.outcome === "fail").length;
	const error = runs.filter((run) => run.status === "error").length;
	const record: EvalRunRecord = {
		schemaVersion: 3,
		purpose: "evidence" as const,
		evalRunId: id,
		target: { id: options.targetId ?? "ombudsman", gitSha: options.gitSha ?? "a".repeat(40) },
		label,
		baselineEvalRunId: label === "candidate" ? (options.baselineEvalRunId ?? id.replace(/_b$|_d$|_f$|_y$|_same_b$|_mismatch_b$/, (suffix) => ({ _b: "_a", _d: "_c", _f: "_e", _y: "_x", _same_b: "_same_a", _mismatch_b: "_mismatch_a" })[suffix] ?? suffix)) : null,
		provenance,
		provenanceKey: hashValue(provenance),
		suiteId: "s",
		suiteHash: provenance.suiteHash,
		dataset: "development",
		datasetHash: provenance.datasetHash,
		repetitions,
		runIds: effectiveRunIds,
		runArtifacts: runs.map((run) => ({ runId: run.runId, sha256: hashValue(run) })),
		startedAt: "2026-08-25T10:00:00Z",
		finishedAt: "2026-08-25T10:01:00Z",
		summary: { total: runs.length, pass, fail, error, allPassRate: runs.length === 0 ? 0 : pass / runs.length },
	};
	mkdirSync(join(runsRoot, id), { recursive: true });
	writeFileSync(join(runsRoot, id, "eval_run.json"), JSON.stringify(record));
}

const root = join(tmpdir(), `ahde-compare-${Date.now()}`);
const runsRoot = join(root, "runs");

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("compare guard", () => {
	it("refuses with the offending axis named when suiteHash differs", () => {
		makeEvalRun(runsRoot, "erun_a", axes());
		makeEvalRun(runsRoot, "erun_b", axes({ suiteHash: hash("c") }), [], { label: "candidate", gitSha: "b".repeat(40) });
		const result = compareEvalRuns(runsRoot, "erun_a", "erun_b", { mode: "candidate" });
		expect(result.error).toContain("eval.suiteHash");
		expect(renderCompareMarkdown(result)).toContain("Not comparable");
	});

	it("refuses when model params differ", () => {
		makeEvalRun(runsRoot, "erun_c", axes());
		makeEvalRun(runsRoot, "erun_d", axes({ params: { temperature: 0.2 } }), [], { label: "candidate", gitSha: "b".repeat(40) });
		const result = compareEvalRuns(runsRoot, "erun_c", "erun_d", { mode: "candidate" });
		expect(result.error).toContain("model.params");
	});

	it("refuses when the runtime differs", () => {
		makeEvalRun(runsRoot, "erun_e", axes());
		makeEvalRun(runsRoot, "erun_f", axes({ piVersion: "0.85.0", piSha: "b".repeat(40) }), [], { label: "candidate", gitSha: "b".repeat(40) });
		const result = compareEvalRuns(runsRoot, "erun_e", "erun_f", { mode: "candidate" });
		expect(result.error).toContain("runtime.piVersion");
		expect(result.error).toContain("runtime.piSha");
	});

	it("refuses same-SHA candidate evidence but permits explicit A/A calibration", () => {
		makeEvalRun(runsRoot, "erun_same_a", axes());
		makeEvalRun(runsRoot, "erun_same_b", axes(), [], { label: "candidate" });
		expect(compareEvalRuns(runsRoot, "erun_same_a", "erun_same_b", { mode: "candidate" }).error).toContain("same revision");
		expect(
			compareEvalRuns(runsRoot, "erun_same_a", "erun_same_b", { mode: "aa-calibration" }).error,
		).toBeNull();
	});

	it("refuses mismatched repetitions and target ids", () => {
		makeEvalRun(runsRoot, "erun_mismatch_a", axes(), [], { repetitions: 2 });
		makeEvalRun(runsRoot, "erun_mismatch_b", axes(), [], {
			label: "candidate",
			gitSha: "b".repeat(40),
			repetitions: 3,
			targetId: "other",
		});
		const result = compareEvalRuns(runsRoot, "erun_mismatch_a", "erun_mismatch_b", { mode: "candidate" });
		expect(result.error).toContain("different repetitions");
		expect(result.error).toContain("different targets");
	});
});

describe("compare table", () => {
	it("pairs per-task outcomes across runs", () => {
		// a: task_001 pass, task_002 fail; b: task_001 pass, task_002 pass
		for (const [evalRunId, outcomes] of [
			["erun_x", [["task_001", "pass"], ["task_002", "fail"]]],
			["erun_y", [["task_001", "pass"], ["task_002", "pass"]]],
		] as const) {
			const runIds: string[] = [];
			for (const [taskId, outcome] of outcomes) {
				const runId = `run_${evalRunId}_${taskId}`;
				runIds.push(runId);
				mkdirSync(join(runsRoot, runId), { recursive: true });
				writeFileSync(
					join(runsRoot, runId, "run.json"),
					JSON.stringify({
						schemaVersion: 1,
						runId,
						taskId,
						repetitionIndex: 0,
						label: "solo",
						status: "completed",
						error: null,
						startedAt: "2026-08-25T10:00:00Z",
						finishedAt: "2026-08-25T10:01:00Z",
						target: { id: "t", gitSha: "a".repeat(40) },
						runtime: {
							piVersion: "1",
							piSha: "a".repeat(40),
							ahdeVersion: "0.1.0",
							ahdeCodeHash: hash("a"),
						},
						model: {
							provider: "p",
							id: "m",
							api: "openai-completions",
							baseUrl: "http://mock/v1",
							apiKeyEnv: "TEST_KEY",
							thinkingLevel: "off",
							params: {},
							spec: {},
						},
						execution: axes().execution,
						eval: { suiteId: "s", suiteHash: hash("b"), dataset: "d", datasetHash: hash("d") },
						trace: { path: "session.jsonl", sessionId: null, sha256: null },
						metrics: {
							tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							costUsd: 0,
							latencyMs: 0,
							toolCalls: 0,
							toolErrors: 0,
							recoveryAttempts: 0,
						},
						evalResults: {
							graders: [{
								name: "fixture",
								type: "output_contains",
								passed: outcome === "pass",
								score: outcome === "pass" ? 1 : 0,
								reason: outcome === "pass" ? "present" : "missing",
							}],
							outcome,
						},
						parent: null,
					}),
				);
			}
			makeEvalRun(runsRoot, evalRunId, axes(), runIds, {
				label: evalRunId === "erun_y" ? "candidate" : "baseline",
				gitSha: evalRunId === "erun_y" ? "b".repeat(40) : "a".repeat(40),
			});
		}
		const result = compareEvalRuns(runsRoot, "erun_x", "erun_y", { mode: "candidate" });
		expect(result.error).toBeNull();
		const row1 = result.rows.find((r) => r.taskId === "task_001");
		const row2 = result.rows.find((r) => r.taskId === "task_002");
		expect(row1?.delta).toBe(0);
		expect(row2?.delta).toBe(1);
		const markdown = renderCompareMarkdown(result);
		expect(markdown).toContain("1 improved, 0 regressed");
		expect(result.summary.delta).toBe(0.5);
		expect(result.summary.confidence95.low).toBeLessThanOrEqual(result.summary.delta);
		expect(result.summary.confidence95.high).toBeGreaterThanOrEqual(result.summary.delta);
	});

	it("pairs mean grader scores and reports cost and latency beside the verdict", () => {
		// Both arms fail every threshold, so the pass rate cannot move; the
		// similarity scores climb 0.30 → 0.85 and the gate sees the improvement.
		const scores: Record<string, number> = { erun_score_a: 0.3, erun_score_b: 0.85 };
		const costs: Record<string, number> = { erun_score_a: 0.01, erun_score_b: 0.014 };
		const latencies: Record<string, number> = { erun_score_a: 2_000, erun_score_b: 1_800 };
		for (const evalRunId of ["erun_score_a", "erun_score_b"] as const) {
			const runIds: string[] = [];
			for (let index = 1; index <= 16; index += 1) {
				const taskId = `task_${String(index).padStart(3, "0")}`;
				const runId = `run_${evalRunId}_${taskId}`;
				runIds.push(runId);
				mkdirSync(join(runsRoot, runId), { recursive: true });
				writeFileSync(join(runsRoot, runId, "run.json"), JSON.stringify({
					schemaVersion: 1,
					runId,
					taskId,
					repetitionIndex: 0,
					label: evalRunId === "erun_score_b" ? "candidate" : "baseline",
					status: "completed",
					error: null,
					startedAt: "2026-08-25T10:00:00Z",
					finishedAt: "2026-08-25T10:01:00Z",
					target: { id: "ombudsman", gitSha: (evalRunId === "erun_score_b" ? "b" : "a").repeat(40) },
					runtime: { piVersion: "0.84.3", piSha: "a".repeat(40), ahdeVersion: "0.1.0", ahdeCodeHash: hash("a") },
					model: {
						provider: "qwen-internal",
						id: "qwen3.5-27b",
						api: "openai-completions",
						baseUrl: "http://mock/v1",
						apiKeyEnv: "TEST_KEY",
						thinkingLevel: "off",
						params: {},
						spec: {},
					},
					execution: axes().execution,
					eval: { suiteId: "s", suiteHash: hash("b"), dataset: "development", datasetHash: hash("d") },
					trace: { path: "session.jsonl", sessionId: null, sha256: null },
					metrics: {
						tokens: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, total: 200 },
						costUsd: costs[evalRunId]!,
						latencyMs: latencies[evalRunId]!,
						toolCalls: 0,
						toolErrors: 0,
						recoveryAttempts: 0,
					},
					evalResults: {
						graders: [{
							name: "similarity",
							type: "similarity",
							passed: false,
							score: scores[evalRunId]!,
							reason: `token-f1 = ${scores[evalRunId]}, below threshold 0.9`,
						}],
						outcome: "fail",
					},
					parent: {
						evalRunId,
						candidateOf: evalRunId === "erun_score_b" ? "a".repeat(40) : null,
					},
				}));
			}
			makeEvalRun(runsRoot, evalRunId, axes(), runIds, {
				label: evalRunId === "erun_score_b" ? "candidate" : "baseline",
				gitSha: (evalRunId === "erun_score_b" ? "b" : "a").repeat(40),
				baselineEvalRunId: "erun_score_a",
			});
		}
		const result = compareEvalRuns(runsRoot, "erun_score_a", "erun_score_b", { mode: "candidate" });
		expect(result.error).toBeNull();
		expect(result.summary.delta).toBe(0);
		expect(result.summary.baselinePassRate).toBe(0);
		expect(result.summary.baselineScore).toBeCloseTo(0.3, 12);
		expect(result.summary.candidateScore).toBeCloseTo(0.85, 12);
		expect(result.summary.scoreDelta).toBeCloseTo(0.55, 12);
		expect(result.gate.verdict).toBe("improved");
		expect(result.resources).toEqual({
			baseline: { runs: 16, costUsd: 0.16, meanLatencyMs: 2_000, meanTokens: 200 },
			candidate: { runs: 16, costUsd: 0.224, meanLatencyMs: 1_800, meanTokens: 200 },
			costRatio: 1.4,
			latencyRatio: 0.9,
			tokenRatio: 1,
		});

		const line = renderGateLine(result);
		expect(line).toContain("development verdict: improved");
		expect(line).toContain("+55.0pp");
		expect(line).toContain("· cost ×1.4 · latency ×0.9");
		expect(line.length).toBeLessThanOrEqual(110);

		const markdown = renderCompareMarkdown(result);
		expect(markdown).toContain("| task | baseline | candidate | score | delta |");
		// One table, one precision: the per-task delta used to drop the decimal
		// the summary line above it kept.
		expect(markdown).toContain("| task_001 | 0% (0/1) | 0% (0/1) | 30% → 85% | +55.0pp |");
		expect(markdown).toContain("- mean score: 30.0% → 85.0% (+55.0pp) · pass rate 0.0pp");
		expect(markdown).toContain("- resources: cost ×1.4 · latency ×0.9 · tokens ×1.0");
		expect(markdown).toContain("$0.1600");
	});

	it("does not invent a cost or token ratio from partially reported runs", () => {
		makeEvalRun(runsRoot, "erun_unknown_a", axes(), [], { repetitions: 2 });
		makeEvalRun(runsRoot, "erun_unknown_b", axes(), [], {
			label: "candidate", gitSha: "b".repeat(40), repetitions: 2, baselineEvalRunId: "erun_unknown_a",
		});
		const baseline = loadVerifiedEvalRun(runsRoot, "erun_unknown_a");
		const candidate = loadVerifiedEvalRun(runsRoot, "erun_unknown_b");
		baseline.runs = baseline.runs.map((run, index) => {
			const { costUsd: _cost, tokens: _tokens, ...metrics } = run.metrics;
			return {
				...run,
				metrics: {
					...metrics,
					latencyMs: 100,
					judge: { calls: 1, tokens: 100, costUsd: 0.1 },
					...(index === 0 ? { costUsd: 0.2, tokens: { input: 100, output: 100, total: 200, cacheRead: 0, cacheWrite: 0 } } : {}),
				},
			};
		});
		candidate.runs = candidate.runs.map((run) => ({
			...run,
			metrics: { ...run.metrics, costUsd: 1, latencyMs: 100 },
		}));
		const result = compareVerifiedEvalRuns(baseline, candidate, { mode: "candidate" });
		expect(result.resources.baseline).toMatchObject({ costUsd: null, meanTokens: null });
		expect(result.resources.candidate.costUsd).toBe(2);
		expect(result.resources).toMatchObject({ costRatio: null, tokenRatio: null, latencyRatio: 1 });
		expect(renderCompareMarkdown(result)).toContain("baseline unknown");
		expect(renderCompareMarkdown(result)).not.toContain("cost ×");
	});

	it("rejects replayed run IDs and post-index outcome swaps", () => {
		makeEvalRun(runsRoot, "erun_integrity_a", axes(), [], { repetitions: 2 });
		makeEvalRun(runsRoot, "erun_integrity_b", axes(), [], {
			label: "candidate",
			gitSha: "b".repeat(40),
			repetitions: 2,
			baselineEvalRunId: "erun_integrity_a",
		});
		const indexPath = join(runsRoot, "erun_integrity_b", "eval_run.json");
		const index = JSON.parse(readFileSync(indexPath, "utf8")) as EvalRunRecord;
		const first = index.runIds[0]!;
		writeFileSync(indexPath, JSON.stringify({
			...index,
			runIds: [first, first],
			runArtifacts: [index.runArtifacts?.[0], index.runArtifacts?.[0]],
		}));
		expect(() => compareEvalRuns(runsRoot, "erun_integrity_a", "erun_integrity_b", { mode: "candidate" })).toThrow(/runIds must be unique/);

		makeEvalRun(runsRoot, "erun_integrity_c", axes(), [], {
			label: "candidate",
			gitSha: "b".repeat(40),
			repetitions: 2,
			baselineEvalRunId: "erun_integrity_a",
		});
		const runPath = join(runsRoot, "run-erun_integrity_c-0", "run.json");
		const run = JSON.parse(readFileSync(runPath, "utf8")) as RunRecord;
		const outcome = run.evalResults?.outcome === "pass" ? "fail" : "pass";
		writeFileSync(runPath, JSON.stringify({
			...run,
			evalResults: {
				graders: outcome === "pass" ? [] : [{
					name: "tampered",
					type: "output_contains",
					passed: false,
					score: 0,
					reason: "tampered outcome",
				}],
				outcome,
			},
		}));
		expect(() => compareEvalRuns(runsRoot, "erun_integrity_a", "erun_integrity_c", { mode: "candidate" })).toThrow(/hash does not match/);
	});
});

/**
 * One lost repetition costs its case, never the whole verification.
 *
 * The gate has declared a 10% infrastructure budget since it was written, and
 * has always excluded the cases that spend it from the paired statistics. This
 * module ignored the budget: any errored arm made the comparison
 * `inconclusive`, and a case short one repetition made it `invalid` outright.
 * Session 8 paid for that twice in one sitting — two verifications of 150
 * executions each, thrown away over an error rate of 2.7%, with the difference
 * between the arms (39/75 against 50/75) already sitting in the rows.
 *
 * Now both spellings of the rule are one function in the gate: the excluded
 * cases are named on the result, the rest are paired, and the surface says
 * `comparable` for exactly as long as its own policy can carry a verdict.
 */
describe("the infrastructure budget", () => {
	/**
	 * One run, written where the loader will find it. An errored run carries no
	 * `evalResults` at all, exactly as the runner records one: it stopped before
	 * grading, so there is no outcome to record and none is invented.
	 */
	const writeRun = (input: {
		evalRunId: string;
		arm: "a" | "b";
		taskId: string;
		repetition: number;
		outcome: "pass" | "fail";
		errored?: boolean;
	}): RunRecord => {
		const runId = `run_${input.evalRunId}_${input.taskId}_${input.repetition}`;
		const record: RunRecord = {
			schemaVersion: 1,
			runId,
			taskId: input.taskId,
			repetitionIndex: input.repetition,
			label: input.arm === "a" ? "baseline" : "candidate",
			status: input.errored ? "error" : "completed",
			error: input.errored ? "provider 503" : null,
			startedAt: "2026-08-25T10:00:00Z",
			finishedAt: "2026-08-25T10:01:00Z",
			target: { id: "ombudsman", gitSha: (input.arm === "a" ? "a" : "b").repeat(40) },
			runtime: { piVersion: "0.84.3", piSha: "a".repeat(40), ahdeVersion: "0.1.0", ahdeCodeHash: hash("a") },
			model: {
				provider: "qwen-internal",
				id: "qwen3.5-27b",
				api: "openai-completions",
				baseUrl: "http://mock/v1",
				apiKeyEnv: "TEST_KEY",
				thinkingLevel: "off",
				params: {},
				spec: {},
			},
			execution: axes().execution,
			eval: { suiteId: "s", suiteHash: hash("b"), dataset: "development", datasetHash: hash("d") },
			trace: { path: "session.jsonl", sessionId: null, sha256: null },
			metrics: {
				tokens: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, total: 200 },
				costUsd: 0.01,
				latencyMs: 1_000,
				toolCalls: 0,
				toolErrors: 0,
				recoveryAttempts: 0,
			},
			evalResults: input.errored ? null : {
				graders: [{
					name: "fixture",
					type: "output_contains",
					passed: input.outcome === "pass",
					score: input.outcome === "pass" ? 1 : 0,
					reason: input.outcome,
				}],
				outcome: input.outcome,
			},
			parent: {
				evalRunId: `${input.evalRunId}`,
				candidateOf: input.arm === "b" ? "a".repeat(40) : null,
			},
		};
		mkdirSync(join(runsRoot, runId), { recursive: true });
		writeFileSync(join(runsRoot, runId, "run.json"), JSON.stringify(record));
		return record;
	};

	/** The EvalRun index over exactly those runs, summarised the way `runSuite` does. */
	const writeIndex = (evalRunId: string, arm: "a" | "b", repetitions: number, runs: RunRecord[]): EvalRunRecord => {
		const pass = runs.filter((run) => run.evalResults?.outcome === "pass").length;
		const fail = runs.filter((run) => run.evalResults?.outcome === "fail").length;
		const error = runs.filter((run) => run.status === "error").length;
		const record: EvalRunRecord = {
			schemaVersion: 3,
			purpose: "evidence",
			evalRunId,
			target: { id: "ombudsman", gitSha: (arm === "a" ? "a" : "b").repeat(40) },
			label: arm === "a" ? "baseline" : "candidate",
			baselineEvalRunId: arm === "b" ? evalRunId.replace(/_b$/, "_a") : null,
			provenance: axes(),
			provenanceKey: hashValue(axes()),
			suiteId: "s",
			suiteHash: hash("b"),
			dataset: "development",
			datasetHash: hash("d"),
			repetitions,
			runIds: runs.map((run) => run.runId),
			runArtifacts: runs.map((run) => ({ runId: run.runId, sha256: hashValue(run) })),
			startedAt: "2026-08-25T10:00:00Z",
			finishedAt: "2026-08-25T10:01:00Z",
			summary: { total: runs.length, pass, fail, error, allPassRate: runs.length === 0 ? 0 : pass / runs.length },
		};
		mkdirSync(join(runsRoot, evalRunId), { recursive: true });
		writeFileSync(join(runsRoot, evalRunId, "eval_run.json"), JSON.stringify(record));
		return record;
	};

	/**
	 * A matched pair of `tasks` cases × `repetitions`. `errored` names the one
	 * repetition that came back as an infrastructure failure.
	 */
	const pair = (id: string, design: {
		tasks: number;
		repetitions: number;
		baselinePasses: number;
		candidatePasses: number;
		errored?: { arm: "a" | "b"; task: number; repetition: number };
	}): void => {
		for (const arm of ["a", "b"] as const) {
			const runs: RunRecord[] = [];
			for (let task = 1; task <= design.tasks; task += 1) {
				const passes = arm === "a" ? design.baselinePasses : design.candidatePasses;
				for (let repetition = 0; repetition < design.repetitions; repetition += 1) {
					const lost = design.errored;
					runs.push(writeRun({
						evalRunId: `${id}_${arm}`,
						arm,
						taskId: `task_${String(task).padStart(3, "0")}`,
						repetition,
						outcome: repetition < passes ? "pass" : "fail",
						...(lost && lost.arm === arm && lost.task === task && lost.repetition === repetition
							? { errored: true }
							: {}),
					}));
				}
			}
			writeIndex(`${id}_${arm}`, arm, design.repetitions, runs);
		}
	};

	it("excludes the case that errored, names it, and still compares the rest", () => {
		pair("erun_budget", {
			tasks: 15,
			repetitions: 3,
			baselinePasses: 1,
			candidatePasses: 3,
			errored: { arm: "b", task: 4, repetition: 1 },
		});
		const result = compareEvalRuns(runsRoot, "erun_budget_a", "erun_budget_b", { mode: "candidate" });
		expect(result.status).toBe("comparable");
		expect(result.error).toBeNull();
		// One case in fifteen is 6.7%, inside the 10% budget the gate declares.
		expect(result.excluded).toEqual([{ taskId: "task_004", reason: "infrastructure", arm: "candidate" }]);
		expect(result.design).toEqual({ tasks: 14, repetitions: 3, excludedTasks: 1 });
		// It leaves BOTH arms, so the pairing the bootstrap resamples stays
		// matched — and it is still named where a reader can find it.
		expect(result.summary.taskCount).toBe(14);
		expect(result.issues).toEqual(["candidate task task_004 errored"]);
		expect(result.gate.verdict).toBe("improved");
		expect(renderGateLine(result)).toContain("1 excluded");
	});

	it("goes inconclusive once the exclusions leave the budget, and says by how much", () => {
		pair("erun_overbudget", {
			tasks: 8,
			repetitions: 3,
			baselinePasses: 1,
			candidatePasses: 3,
			errored: { arm: "a", task: 2, repetition: 0 },
		});
		// One case of eight is 12.5%: over the budget, and no verdict is owed.
		const result = compareEvalRuns(runsRoot, "erun_overbudget_a", "erun_overbudget_b", { mode: "candidate" });
		expect(result.status).toBe("inconclusive");
		expect(result.error).toContain("baseline task task_002 errored");
		expect(result.gate.verdict).toBe("inconclusive");
		expect(result.gate.reasons[0]).toContain("exceeds the 10% budget");
	});

	it("excludes a case short one repetition instead of voiding the verification", () => {
		// The loader refuses an index whose task count and repetitions disagree,
		// so this shape only reaches the comparison through already-verified
		// evidence. It is still the rule that used to make a whole pair
		// `invalid` over one lost run, and it is still the gate's to make.
		pair("erun_short", { tasks: 15, repetitions: 3, baselinePasses: 1, candidatePasses: 3 });
		const verified = (id: string): VerifiedEvalRun => loadVerifiedEvalRun(runsRoot, id);
		const baseline = verified("erun_short_a");
		const short: VerifiedEvalRun = {
			...baseline,
			runs: baseline.runs.filter((run) => !(run.taskId === "task_007" && run.repetitionIndex === 2)),
		};
		const result = compareVerifiedEvalRuns(short, verified("erun_short_b"), { mode: "candidate" });
		expect(result.status).toBe("comparable");
		expect(result.excluded).toEqual([{ taskId: "task_007", reason: "incomplete", arm: "baseline" }]);
		expect(result.issues).toEqual(["task task_007 has incomplete repetitions: 2/3 vs 3/3"]);
		expect(result.summary.taskCount).toBe(14);
	});

	it("keeps a mismatched task set invalid: that is not an error budget question", () => {
		pair("erun_sets", { tasks: 3, repetitions: 1, baselinePasses: 1, candidatePasses: 1 });
		const extra = writeRun({
			evalRunId: "erun_sets_b",
			arm: "b",
			taskId: "task_009",
			repetition: 0,
			outcome: "pass",
		});
		const index = JSON.parse(readFileSync(join(runsRoot, "erun_sets_b", "eval_run.json"), "utf8")) as EvalRunRecord;
		const runs = index.runIds.map((runId) =>
			JSON.parse(readFileSync(join(runsRoot, runId, "run.json"), "utf8")) as RunRecord);
		writeIndex("erun_sets_b", "b", 1, [...runs, extra]);
		const result = compareEvalRuns(runsRoot, "erun_sets_a", "erun_sets_b", { mode: "candidate" });
		expect(result.status).toBe("invalid");
		expect(result.error).toContain("task sets differ");
	});

	it("refuses a sealed surface whose exam was designed under the policy minimum", () => {
		// The minimum applies to the exam as designed; the budget above bounds
		// how many of its cases may then drop out. Fourteen is not an exam.
		pair("erun_small_exam", { tasks: 14, repetitions: 3, baselinePasses: 1, candidatePasses: 3 });
		const result = compareEvalRuns(runsRoot, "erun_small_exam_a", "erun_small_exam_b", {
			mode: "candidate",
			surface: "sealed",
		});
		expect(result.status).toBe("inconclusive");
		expect(result.gate.verdict).toBe("underpowered");
		expect(result.error).toContain("the sealed guardrail needs 15");
		// The same rows are a perfectly good development comparison.
		expect(compareEvalRuns(runsRoot, "erun_small_exam_a", "erun_small_exam_b", { mode: "candidate" }).status)
			.toBe("comparable");
	});
});

/**
 * The one way to read a Target's spend. A command Target may report none, and
 * an absence has to survive every projection between the record and a human —
 * `$0.00` beside a run that measured nothing is a claim nobody made.
 */
describe("what the Target reported spending", () => {
	const spent = {
		tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
		costUsd: 0.5,
		latencyMs: 100,
		toolCalls: 0,
		toolErrors: 0,
		recoveryAttempts: 0,
	};

	it("returns the numbers when the backend reported them", () => {
		expect(runTokens({ metrics: spent })).toEqual(spent.tokens);
		expect(runCost({ metrics: spent })).toBe(0.5);
	});

	it("returns null — never zero — when it reported nothing", () => {
		const { tokens: _tokens, costUsd: _costUsd, ...silent } = spent;
		expect(runTokens({ metrics: silent })).toBeNull();
		expect(runCost({ metrics: silent })).toBeNull();
		// The distinction that matters: a genuinely free run is not the same fact.
		expect(runCost({ metrics: { ...spent, costUsd: 0 } })).toBe(0);
	});
});
