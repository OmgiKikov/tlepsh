import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { compareEvalRuns, renderCompareMarkdown } from "../src/compare.js";
import type { EvalRunRecord } from "../src/eval.js";
import type { ProvenanceAxes } from "../src/provenance.js";

function axes(overrides: Partial<ProvenanceAxes> = {}): ProvenanceAxes {
	return {
		piVersion: "0.84.3",
		piSha: "aaa",
		ahdeVersion: "0.1.0",
		ahdeCodeHash: "sha256:code-a",
		provider: "qwen-internal",
		modelId: "qwen3.5-27b",
		thinkingLevel: "off",
		params: {},
		suiteHash: "sha256:s",
		datasetHash: "sha256:d",
		...overrides,
	};
}

function makeEvalRun(runsRoot: string, id: string, provenance: ProvenanceAxes, runIds: string[] = []): void {
	const record: EvalRunRecord = {
		schemaVersion: 1,
		evalRunId: id,
		target: { id: "ombudsman", gitSha: "deadbeef" },
		label: "baseline",
		baselineEvalRunId: null,
		provenance,
		provenanceKey: "sha256:key",
		suiteId: "s",
		suiteHash: provenance.suiteHash,
		dataset: "development",
		datasetHash: provenance.datasetHash,
		repetitions: 1,
		runIds,
		startedAt: "2026-08-25T10:00:00Z",
		finishedAt: "2026-08-25T10:01:00Z",
		summary: { total: 0, pass: 0, fail: 0, error: 0, allPassRate: 0 },
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
		makeEvalRun(runsRoot, "erun_b", axes({ suiteHash: "sha256:changed" }));
		const result = compareEvalRuns(runsRoot, "erun_a", "erun_b");
		expect(result.error).toContain("eval.suiteHash");
		expect(renderCompareMarkdown(result)).toContain("Not comparable");
	});

	it("refuses when model params differ", () => {
		makeEvalRun(runsRoot, "erun_c", axes());
		makeEvalRun(runsRoot, "erun_d", axes({ params: { temperature: 0.2 } }));
		const result = compareEvalRuns(runsRoot, "erun_c", "erun_d");
		expect(result.error).toContain("model.params");
	});

	it("refuses when the runtime differs", () => {
		makeEvalRun(runsRoot, "erun_e", axes());
		makeEvalRun(runsRoot, "erun_f", axes({ piVersion: "0.85.0", piSha: "bbb" }));
		const result = compareEvalRuns(runsRoot, "erun_e", "erun_f");
		expect(result.error).toContain("runtime.piVersion");
		expect(result.error).toContain("runtime.piSha");
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
						startedAt: "",
						finishedAt: "",
						target: { id: "t", gitSha: "a" },
						runtime: { piVersion: "1", piSha: "a", ahdeVersion: "0.1.0", ahdeCodeHash: "sha256:code-a" },
						model: { provider: "p", id: "m", thinkingLevel: "off", params: {} },
						eval: { suiteId: "s", suiteHash: "sha256:s", dataset: "d", datasetHash: "sha256:d" },
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
			makeEvalRun(runsRoot, evalRunId, axes(), runIds);
		}
		const result = compareEvalRuns(runsRoot, "erun_x", "erun_y");
		expect(result.error).toBeNull();
		const row1 = result.rows.find((r) => r.taskId === "task_001");
		const row2 = result.rows.find((r) => r.taskId === "task_002");
		expect(row1?.delta).toBe(0);
		expect(row2?.delta).toBe(1);
		const markdown = renderCompareMarkdown(result);
		expect(markdown).toContain("1 improved, 0 regressed");
	});
});
