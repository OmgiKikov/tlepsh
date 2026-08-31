import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseEvalRun, diagnosisPath, loadDiagnosis } from "../src/diagnosis.js";
import { EvalRunRecordSchema, type EvalRunRecord } from "../src/eval.js";
import {
	RunRecordSchema,
	executionFingerprint,
	hashFile,
	hashValue,
	modelFingerprint,
	provenanceAxes,
	provenanceKey,
	type RunRecord,
} from "../src/provenance.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";

const roots: string[] = [];
const gitSha = "a".repeat(40);
const runtime = {
	piVersion: "0.84.3",
	piSha: "b".repeat(40),
	ahdeVersion: "0.1.0",
	ahdeCodeHash: `sha256:${"c".repeat(64)}`,
};
const model = modelFingerprint({
	provider: "mock",
	id: "model",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1/v1",
	apiKeyEnv: "TEST_KEY",
	thinkingLevel: "off",
	params: {},
	spec: {},
});
const execution = executionFingerprint("isolated");
const evaluation = {
	suiteId: "suite",
	suiteHash: `sha256:${"d".repeat(64)}`,
	dataset: "development",
	datasetHash: `sha256:${"e".repeat(64)}`,
};

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "ahde-diagnosis-"));
	roots.push(value);
	return value;
}

function writeRun(runsRoot: string, runId: string, taskId: string, outcome: "pass" | "fail", repetition: number): RunRecord {
	const runDir = join(runsRoot, runId);
	mkdirSync(runDir, { recursive: true });
	const trace = [
		`{"type":"message","message":{"role":"user","content":"task"}}`,
		`{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"answer"}]}}`,
	].join("\n");
	writeFileSync(join(runDir, "session.jsonl"), `${trace}\n`);
	const record: RunRecord = {
		schemaVersion: 1,
		runId,
		taskId,
		repetitionIndex: repetition,
		label: "baseline",
		status: "completed",
		error: null,
		startedAt: "2026-08-26T10:00:00.000Z",
		finishedAt: "2026-08-26T10:00:01.000Z",
		target: { id: "target", gitSha },
		runtime,
		model,
		execution,
		eval: evaluation,
		trace: { path: "session.jsonl", sessionId: "session", sha256: hashFile(`${trace}\n`) },
		metrics: {
			tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
			costUsd: 0,
			latencyMs: 1,
			toolCalls: 0,
			toolErrors: 0,
			recoveryAttempts: 0,
		},
		evalResults: {
			outcome,
			graders: [
				{
					name: "required-tool",
					type: "tool_called",
					passed: outcome === "pass",
					score: outcome === "pass" ? 1 : 0,
					reason: outcome === "pass" ? "called bash" : "never called bash",
				},
			],
		},
		parent: { evalRunId: "erun-diagnosis", candidateOf: null },
	};
	writeJsonArtifact(join(runDir, "run.json"), RunRecordSchema, record);
	return record;
}

function writeEval(runsRoot: string, runs: RunRecord[]): EvalRunRecord {
	const evidence = { runtime, model, judge: null, execution, eval: evaluation };
	const pass = runs.filter((run) => run.evalResults?.outcome === "pass").length;
	const record: EvalRunRecord = {
		schemaVersion: 3,
		purpose: "evidence" as const,
		evalRunId: "erun-diagnosis",
		target: { id: "target", gitSha },
		label: "baseline",
		baselineEvalRunId: null,
		provenance: provenanceAxes(evidence),
		provenanceKey: provenanceKey(evidence),
		suiteId: evaluation.suiteId,
		suiteHash: evaluation.suiteHash,
		dataset: evaluation.dataset,
		datasetHash: evaluation.datasetHash,
		repetitions: runs.length,
		runIds: runs.map((run) => run.runId),
		runArtifacts: runs.map((run) => ({ runId: run.runId, sha256: hashValue(run) })),
		startedAt: "2026-08-26T10:00:00.000Z",
		finishedAt: "2026-08-26T10:00:02.000Z",
		summary: {
			total: runs.length,
			pass,
			fail: runs.length - pass,
			error: 0,
			allPassRate: pass / runs.length,
		},
	};
	writeJsonArtifact(join(runsRoot, record.evalRunId, "eval_run.json"), EvalRunRecordSchema, record);
	return record;
}

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("diagnosis", () => {
	it("turns repeated grader failures into an evidence-linked root-cause recommendation", () => {
		const runsRoot = root();
		const evalRun = writeEval(runsRoot, [
			writeRun(runsRoot, "run-1", "task-tool", "fail", 0),
			writeRun(runsRoot, "run-2", "task-tool", "fail", 1),
		]);
		const diagnosis = diagnoseEvalRun(runsRoot, evalRun.evalRunId, () => "2026-08-26T11:00:00.000Z");
		expect(diagnosis.status).toBe("actionable");
		expect(diagnosis.issues).toHaveLength(1);
		expect(diagnosis.issues[0]).toMatchObject({
			category: "tool-selection",
			confidence: "high",
			occurrences: { pass: 0, fail: 2, error: 0, total: 2 },
		});
		expect(diagnosis.issues[0]?.rootCause).toContain("never called bash");
		expect(diagnosis.issues[0]?.suggestions.join(" ")).toContain("skill description");
		expect(loadDiagnosis(runsRoot, evalRun.evalRunId)).toEqual(diagnosis);
	});

	it("refuses diagnosis when trace content no longer matches its evidence hash", () => {
		const runsRoot = root();
		const run = writeRun(runsRoot, "run-corrupt", "task", "fail", 0);
		const evalRun = writeEval(runsRoot, [run]);
		writeFileSync(join(runsRoot, run.runId, "session.jsonl"), "tampered\n");
		expect(() => diagnoseEvalRun(runsRoot, evalRun.evalRunId)).toThrow(/trace SHA mismatch/);
	});

	it("rejects traversal and symlinked eval artifact directories", () => {
		const runsRoot = root();
		const outside = root();
		symlinkSync(outside, join(runsRoot, "erun-link"), "dir");

		expect(() => diagnosisPath(runsRoot, "../../escape")).toThrow(/traversal are forbidden/);
		expect(() => diagnosisPath(runsRoot, "erun-link")).toThrow(/must not traverse a symlink/);
	});
});
