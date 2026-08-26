import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { compareEvalRuns, renderCompareMarkdown } from "../src/compare.js";
import type { EvalRunRecord } from "../src/eval.js";
import { hashValue, type ProvenanceAxes, type RunRecord } from "../src/provenance.js";

function hash(char: string): string {
	return `sha256:${char.repeat(64)}`;
}

function axes(overrides: Partial<ProvenanceAxes> = {}): ProvenanceAxes {
	return {
		piVersion: "0.84.3",
		piSha: "a".repeat(40),
		ahdeVersion: "0.1.0",
		ahdeCodeHash: hash("a"),
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
				ahdeCodeHash: provenance.ahdeCodeHash,
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
		schemaVersion: 1,
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
		const result = compareEvalRuns(runsRoot, "erun_a", "erun_b");
		expect(result.error).toContain("eval.suiteHash");
		expect(renderCompareMarkdown(result)).toContain("Not comparable");
	});

	it("refuses when model params differ", () => {
		makeEvalRun(runsRoot, "erun_c", axes());
		makeEvalRun(runsRoot, "erun_d", axes({ params: { temperature: 0.2 } }), [], { label: "candidate", gitSha: "b".repeat(40) });
		const result = compareEvalRuns(runsRoot, "erun_c", "erun_d");
		expect(result.error).toContain("model.params");
	});

	it("refuses when the runtime differs", () => {
		makeEvalRun(runsRoot, "erun_e", axes());
		makeEvalRun(runsRoot, "erun_f", axes({ piVersion: "0.85.0", piSha: "b".repeat(40) }), [], { label: "candidate", gitSha: "b".repeat(40) });
		const result = compareEvalRuns(runsRoot, "erun_e", "erun_f");
		expect(result.error).toContain("runtime.piVersion");
		expect(result.error).toContain("runtime.piSha");
	});

	it("refuses same-SHA candidate evidence but permits explicit A/A calibration", () => {
		makeEvalRun(runsRoot, "erun_same_a", axes());
		makeEvalRun(runsRoot, "erun_same_b", axes(), [], { label: "candidate" });
		expect(compareEvalRuns(runsRoot, "erun_same_a", "erun_same_b").error).toContain("same revision");
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
		const result = compareEvalRuns(runsRoot, "erun_mismatch_a", "erun_mismatch_b");
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
						evalResults: { graders: [], outcome },
						parent: null,
					}),
				);
			}
			makeEvalRun(runsRoot, evalRunId, axes(), runIds, {
				label: evalRunId === "erun_y" ? "candidate" : "baseline",
				gitSha: evalRunId === "erun_y" ? "b".repeat(40) : "a".repeat(40),
			});
		}
		const result = compareEvalRuns(runsRoot, "erun_x", "erun_y");
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
		expect(() => compareEvalRuns(runsRoot, "erun_integrity_a", "erun_integrity_b")).toThrow(/runIds must be unique/);

		makeEvalRun(runsRoot, "erun_integrity_c", axes(), [], {
			label: "candidate",
			gitSha: "b".repeat(40),
			repetitions: 2,
			baselineEvalRunId: "erun_integrity_a",
		});
		const runPath = join(runsRoot, "run-erun_integrity_c-0", "run.json");
		const run = JSON.parse(readFileSync(runPath, "utf8")) as RunRecord;
		writeFileSync(runPath, JSON.stringify({
			...run,
			evalResults: { graders: [], outcome: run.evalResults?.outcome === "pass" ? "fail" : "pass" },
		}));
		expect(() => compareEvalRuns(runsRoot, "erun_integrity_a", "erun_integrity_c")).toThrow(/hash does not match/);
	});
});
