import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import {
	MAX_DETAIL_RUNS,
	MAX_NORMALIZED_TRACE_CHARS,
	buildEvalReport,
	collectEvalReportData,
	renderEvalReportHtml,
	reportPath,
} from "../src/report.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";

const roots: string[] = [];
const gitSha = "a".repeat(40);

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { runsRoot: string; evalRunId: string } {
	const runsRoot = mkdtempSync(join(tmpdir(), "ahde-report-"));
	roots.push(runsRoot);
	const runId = "run-report";
	const runDir = join(runsRoot, runId);
	mkdirSync(runDir, { recursive: true });
	const trace = [
		JSON.stringify({ type: "message", message: { role: "user", content: "Bearer abcdefghijklmnop" } }),
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "sk-1234567890abcdef </script><script>alert(1)</script>" }],
			},
		}),
	].join("\n");
	writeFileSync(join(runDir, "session.jsonl"), `${trace}\n`);

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
	const record: RunRecord = {
		schemaVersion: 1,
		runId,
		taskId: "unsafe-task",
		repetitionIndex: 0,
		label: "solo",
		status: "completed",
		error: null,
		startedAt: "2026-08-26T10:00:00.000Z",
		finishedAt: "2026-08-26T10:00:01.000Z",
		target: { id: "<img src=x onerror=alert(2)>", gitSha },
		runtime,
		model,
		execution,
		eval: evaluation,
		trace: { path: "session.jsonl", sessionId: "session", sha256: hashFile(`${trace}\n`) },
		metrics: {
			tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 },
			costUsd: 0,
			latencyMs: 10,
			toolCalls: 0,
			toolErrors: 0,
			recoveryAttempts: 0,
		},
		evalResults: {
			outcome: "fail",
			graders: [{ name: "answer", type: "output_contains", passed: false, score: 0, reason: "missing expected answer" }],
		},
		parent: { evalRunId: "erun-report", candidateOf: null },
	};
	writeJsonArtifact(join(runDir, "run.json"), RunRecordSchema, record);

	const evidence = { runtime, model, judge: null, execution, eval: evaluation };
	const evalRun: EvalRunRecord = {
		schemaVersion: 1,
		evalRunId: "erun-report",
		target: record.target,
		label: "solo",
		baselineEvalRunId: null,
		provenance: provenanceAxes(evidence),
		provenanceKey: provenanceKey(evidence),
		suiteId: evaluation.suiteId,
		suiteHash: evaluation.suiteHash,
		dataset: evaluation.dataset,
		datasetHash: evaluation.datasetHash,
		repetitions: 1,
		runIds: [runId],
		runArtifacts: [{ runId, sha256: hashValue(record) }],
		startedAt: record.startedAt,
		finishedAt: record.finishedAt ?? "2026-08-26T10:00:01.000Z",
		summary: { total: 1, pass: 0, fail: 1, error: 0, allPassRate: 0 },
	};
	writeJsonArtifact(join(runsRoot, evalRun.evalRunId, "eval_run.json"), EvalRunRecordSchema, evalRun);
	return { runsRoot, evalRunId: evalRun.evalRunId };
}

const RAW_OMITTED_SENTINEL = "SEALED_RAW_HOLDOUT_DO_NOT_RENDER";
const INCLUDED_SECRET = "sk-oversizedsecret1234567890";

function oversizedFixture(): {
	runsRoot: string;
	evalRunId: string;
	sourceRunIds: string[];
	expectedIncludedRunIds: string[];
	omittedRawTracePath: string;
} {
	const runsRoot = mkdtempSync(join(tmpdir(), "ahde-report-oversized-"));
	roots.push(runsRoot);
	const evalRunId = "erun-oversized";
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
		suiteId: "suite-oversized",
		suiteHash: `sha256:${"d".repeat(64)}`,
		dataset: "development",
		datasetHash: `sha256:${"e".repeat(64)}`,
	};
	const runCount = MAX_DETAIL_RUNS + 5;
	const sourceRunIds = Array.from({ length: runCount }, (_, index) => `run-oversized-${index.toString().padStart(2, "0")}`);
	const outcomes = sourceRunIds.map((_, index): "pass" | "fail" | "error" => {
		if (index === 1 || index === runCount - 1) return "fail";
		if (index === runCount - 3) return "error";
		return "pass";
	});
	const records: RunRecord[] = [];
	let omittedRawTracePath = "";

	for (const [index, runId] of sourceRunIds.entries()) {
		const runDir = join(runsRoot, runId);
		mkdirSync(runDir, { recursive: true });
		let traceMessages: string[];
		if (index === 1) {
			traceMessages = Array.from({ length: 20 }, (_, messageIndex) => JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: `${messageIndex === 0 ? `${INCLUDED_SECRET} ` : ""}${String(messageIndex % 10).repeat(20_500)}`,
				},
			}));
		} else if (index === runCount - 2) {
			traceMessages = [JSON.stringify({
				type: "message",
				message: { role: "user", content: `${RAW_OMITTED_SENTINEL} Bearer rawomittedtoken123456` },
			})];
		} else {
			traceMessages = [JSON.stringify({
				type: "message",
				message: { role: "user", content: `trace:${runId}` },
			})];
		}
		const trace = `${traceMessages.join("\n")}\n`;
		const tracePath = join(runDir, "session.jsonl");
		writeFileSync(tracePath, trace);
		if (index === runCount - 2) omittedRawTracePath = tracePath;
		const outcome = outcomes[index]!;
		const record: RunRecord = {
			schemaVersion: 1,
			runId,
			taskId: `task-${index.toString().padStart(2, "0")}`,
			repetitionIndex: 0,
			label: "solo",
			status: outcome === "error" ? "error" : "completed",
			error: outcome === "error" ? "synthetic infrastructure failure" : null,
			startedAt: "2026-08-26T10:00:00.000Z",
			finishedAt: "2026-08-26T10:00:01.000Z",
			target: { id: "oversized-target", gitSha },
			runtime,
			model,
			execution,
			eval: evaluation,
			trace: { path: "session.jsonl", sessionId: `session-${index}`, sha256: hashFile(trace) },
			metrics: {
				tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
				costUsd: 0,
				latencyMs: index,
				toolCalls: 0,
				toolErrors: 0,
				recoveryAttempts: 0,
			},
			evalResults: outcome === "error"
				? null
				: {
					outcome,
					graders: [{
						name: "answer",
						type: "output_contains",
						passed: outcome === "pass",
						score: outcome === "pass" ? 1 : 0,
						reason: outcome === "pass" ? "present" : "missing expected answer",
					}],
				},
			parent: { evalRunId, candidateOf: null },
		};
		writeJsonArtifact(join(runDir, "run.json"), RunRecordSchema, record);
		records.push(record);
	}

	const evidence = { runtime, model, judge: null, execution, eval: evaluation };
	const pass = outcomes.filter((outcome) => outcome === "pass").length;
	const fail = outcomes.filter((outcome) => outcome === "fail").length;
	const error = outcomes.filter((outcome) => outcome === "error").length;
	const evalRun: EvalRunRecord = {
		schemaVersion: 1,
		evalRunId,
		target: { id: "oversized-target", gitSha },
		label: "solo",
		baselineEvalRunId: null,
		provenance: provenanceAxes(evidence),
		provenanceKey: provenanceKey(evidence),
		suiteId: evaluation.suiteId,
		suiteHash: evaluation.suiteHash,
		dataset: evaluation.dataset,
		datasetHash: evaluation.datasetHash,
		repetitions: 1,
		runIds: sourceRunIds,
		runArtifacts: records.map((record) => ({ runId: record.runId, sha256: hashValue(record) })),
		startedAt: "2026-08-26T10:00:00.000Z",
		finishedAt: "2026-08-26T10:00:01.000Z",
		summary: { total: runCount, pass, fail, error, allPassRate: pass / runCount },
	};
	writeJsonArtifact(join(runsRoot, evalRunId, "eval_run.json"), EvalRunRecordSchema, evalRun);
	const expectedIncludedRunIds = [
		...sourceRunIds.filter((_, index) => outcomes[index] !== "pass"),
		...sourceRunIds.filter((_, index) => outcomes[index] === "pass"),
	].slice(0, MAX_DETAIL_RUNS);
	return { runsRoot, evalRunId, sourceRunIds, expectedIncludedRunIds, omittedRawTracePath };
}

function projectedTraceCharacters(data: ReturnType<typeof collectEvalReportData>): number {
	return data.runs.reduce((runTotal, run) => runTotal + run.trace.reduce((traceTotal, message) => (
		traceTotal +
		message.text.length +
		message.toolCalls.reduce((toolTotal, call) => toolTotal + call.name.length + call.arguments.length, 0) +
		(message.toolResult ? message.toolResult.name.length + message.toolResult.text.length : 0)
	), 0), 0);
}

describe("static evidence report", () => {
	it("strictly collects evidence while redacting credentials and bounding script embedding", () => {
		const value = fixture();
		const data = collectEvalReportData(value.runsRoot, value.evalRunId, () => "2026-08-26T11:00:00.000Z");
		expect(data.projection).toMatchObject({
			sourceRunCount: 1,
			includedRunCount: 1,
			includedRunIds: ["run-report"],
			omittedRunCount: 0,
			traceTruncated: false,
			truncatedTraceRunIds: [],
			limits: { detailRuns: MAX_DETAIL_RUNS, traceCharacters: MAX_NORMALIZED_TRACE_CHARS },
		});
		const serialized = JSON.stringify(data.runs[0]?.trace);
		expect(serialized).not.toContain("abcdefghijklmnop");
		expect(serialized).not.toContain("sk-1234567890abcdef");
		expect(serialized).toContain("REDACTED");

		const html = renderEvalReportHtml(data);
		expect(html).toContain("AHDE Evidence Report");
		expect(html).not.toContain("<img src=x onerror=alert(2)>");
		expect(html).not.toContain("</script><script>alert(1)</script>");
		expect(html).toContain("\\u003cimg src=x onerror=alert(2)>");
	});

	it("projects oversized evidence failure-first with deterministic run and cumulative trace budgets", () => {
		const value = oversizedFixture();
		const rawBefore = readFileSync(value.omittedRawTracePath, "utf8");
		const now = () => "2026-08-26T11:00:00.000Z";
		const first = collectEvalReportData(value.runsRoot, value.evalRunId, now);
		const second = collectEvalReportData(value.runsRoot, value.evalRunId, now);

		expect(first.evalRun.runIds).toEqual(value.sourceRunIds);
		expect(first.evalRun.summary.total).toBe(value.sourceRunIds.length);
		expect(first.diagnosis.summary.tasks).toBe(value.sourceRunIds.length);
		expect(first.runs.map((run) => run.runId)).toEqual(value.expectedIncludedRunIds);
		expect(second.runs.map((run) => run.runId)).toEqual(value.expectedIncludedRunIds);
		expect(second.projection).toEqual(first.projection);
		expect(first.runs.slice(0, 3).map((run) => run.outcome)).toEqual(["fail", "error", "fail"]);
		expect(first.projection).toMatchObject({
			selection: "failures-errors-then-passes-source-order",
			sourceRunCount: value.sourceRunIds.length,
			includedRunCount: MAX_DETAIL_RUNS,
			includedRunIds: value.expectedIncludedRunIds,
			omittedRunCount: 5,
			traceCharactersIncluded: MAX_NORMALIZED_TRACE_CHARS,
			traceTruncated: true,
			limits: { detailRuns: MAX_DETAIL_RUNS, traceCharacters: MAX_NORMALIZED_TRACE_CHARS },
		});
		expect(first.projection.truncatedTraceRunIds).toHaveLength(MAX_DETAIL_RUNS);
		expect(projectedTraceCharacters(first)).toBe(first.projection.traceCharactersIncluded);
		expect(projectedTraceCharacters(first)).toBeLessThanOrEqual(MAX_NORMALIZED_TRACE_CHARS);

		const serialized = JSON.stringify(first);
		const html = renderEvalReportHtml(first);
		expect(serialized).not.toContain(INCLUDED_SECRET);
		expect(serialized).toContain("REDACTED_API_KEY");
		expect(serialized).not.toContain(RAW_OMITTED_SENTINEL);
		expect(html).not.toContain(RAW_OMITTED_SENTINEL);
		expect(html).toContain("5 runs omitted");
		expect(html).toContain(`truncated for ${MAX_DETAIL_RUNS} included runs`);
		expect(html).toContain("250,000-character global budget");
		expect(readFileSync(value.omittedRawTracePath, "utf8")).toBe(rawBefore);
		expect(rawBefore).toContain(RAW_OMITTED_SENTINEL);
	});

	it("atomically publishes an owner-only, self-contained HTML file", () => {
		const value = fixture();
		const output = buildEvalReport(value.runsRoot, value.evalRunId);
		const html = readFileSync(output, "utf8");
		expect(html).toContain("const DATA=");
		expect(html).not.toMatch(/<script[^>]+src=/);
		expect(statSync(output).mode & 0o777).toBe(0o600);
		chmodSync(output, 0o600);
	});

	it("rejects traversal and symlinked report artifact directories", () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-report-paths-"));
		const outside = mkdtempSync(join(tmpdir(), "ahde-report-outside-"));
		roots.push(runsRoot, outside);
		symlinkSync(outside, join(runsRoot, "erun-link"), "dir");

		expect(() => reportPath(runsRoot, "../escape")).toThrow(/traversal are forbidden/);
		expect(() => reportPath(runsRoot, "erun-link")).toThrow(/must not traverse a symlink/);
	});
});
