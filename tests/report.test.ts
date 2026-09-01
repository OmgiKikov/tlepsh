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
	MAX_NORMALIZED_TRACE_MESSAGES,
	MAX_NORMALIZED_TOOL_CALLS,
	MAX_REPORT_HTML_BYTES,
	buildEvalReport,
	collectEvalReportData,
	renderEvalReportHtml,
	reportPath,
} from "../src/report.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";

const roots: string[] = [];
const gitSha = "a".repeat(40);
const GRADER_METADATA_SECRET = "sk-gradersecret1234567890";
const RUN_ERROR_SECRET = "Bearer reporterrorsecret1234567890";
const TASK_ID_SECRET = "sk-taskidentitysecret1234567890";

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { structuralFlood?: boolean } = {}): { runsRoot: string; evalRunId: string } {
	const runsRoot = mkdtempSync(join(tmpdir(), "ahde-report-"));
	roots.push(runsRoot);
	const runId = "run-report";
	const runDir = join(runsRoot, runId);
	mkdirSync(runDir, { recursive: true });
	const trace = options.structuralFlood
		? Array.from({ length: 500 }, (_, messageIndex) => JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: Array.from({ length: 50 }, (_, callIndex) => ({
					type: "toolCall",
					id: `flood-${messageIndex}-${callIndex}`,
					name: "x",
					arguments: {},
				})),
			},
		})).join("\n")
		: [
		JSON.stringify({ type: "message", message: { role: "user", content: "Bearer abcdefghijklmnop" } }),
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "sk-1234567890abcdef </script><script>alert(1)</script>" }],
			},
		}),
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: Array.from({ length: 75 }, (_, index) => ({
					type: "toolCall",
					id: `call-${index}`,
					name: `tool-${index.toString().padStart(2, "0")}`,
					arguments: {},
				})),
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
		taskId: TASK_ID_SECRET,
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
			graders: [
				{
					name: 'answer"><svg onload=alert(3)>',
					type: "output_contains",
					passed: false,
					score: 0,
					reason: `${GRADER_METADATA_SECRET} missing expected answer`,
				},
				...Array.from({ length: 24 }, (_, index) => ({
					name: `bounded-grader-${index}`,
					type: "output_contains",
					passed: false,
					score: 0,
					reason: `missing-${index}`,
				})),
			],
		},
		parent: { evalRunId: "erun-report", candidateOf: null },
	};
	writeJsonArtifact(join(runDir, "run.json"), RunRecordSchema, record);
	const errorRunId = "run-report-error";
	const errorRunDir = join(runsRoot, errorRunId);
	mkdirSync(errorRunDir, { recursive: true });
	writeFileSync(join(errorRunDir, "session.jsonl"), `${trace}\n`);
	const errorRecord: RunRecord = {
		...record,
		runId: errorRunId,
		taskId: "unsafe-error-task",
		status: "error",
		error: RUN_ERROR_SECRET,
		trace: { path: "session.jsonl", sessionId: "error-session", sha256: hashFile(`${trace}\n`) },
		evalResults: null,
	};
	writeJsonArtifact(join(errorRunDir, "run.json"), RunRecordSchema, errorRecord);

	const evidence = { runtime, model, judge: null, execution, eval: evaluation };
	const evalRun: EvalRunRecord = {
		schemaVersion: 3,
		purpose: "evidence" as const,
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
		evidenceVisibility: "development",
		taskIds: [record.taskId, errorRecord.taskId],
		repetitions: 1,
		runIds: [runId, errorRunId],
		runArtifacts: [
			{ runId, sha256: hashValue(record) },
			{ runId: errorRunId, sha256: hashValue(errorRecord) },
		],
		startedAt: record.startedAt,
		finishedAt: record.finishedAt ?? "2026-08-26T10:00:01.000Z",
		summary: { total: 2, pass: 0, fail: 1, error: 1, allPassRate: 0 },
	};
	writeJsonArtifact(join(runsRoot, evalRun.evalRunId, "eval_run.json"), EvalRunRecordSchema, evalRun);
	return { runsRoot, evalRunId: evalRun.evalRunId };
}

function sealedBaselineFixture(): { runsRoot: string; evalRunId: string; sealedEvalRunId: string } {
	const value = fixture();
	const baselineRevision = "b".repeat(40);
	const candidateRuns = ["run-report", "run-report-error"].map((runId) => {
		const path = join(value.runsRoot, runId, "run.json");
		const run = RunRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
		const candidate = RunRecordSchema.parse({
			...run,
			label: "candidate",
			parent: { evalRunId: value.evalRunId, candidateOf: baselineRevision },
		});
		writeJsonArtifact(path, RunRecordSchema, candidate);
		return candidate;
	});
	const evalPath = join(value.runsRoot, value.evalRunId, "eval_run.json");
	const source = EvalRunRecordSchema.parse(JSON.parse(readFileSync(evalPath, "utf8")));
	const sealedEvalRunId = "erun_formal_sealed_baseline";
	const candidate = EvalRunRecordSchema.parse({
		...source,
		label: "candidate",
		baselineEvalRunId: sealedEvalRunId,
		evidenceVisibility: "development",
		runArtifacts: candidateRuns.map((run) => ({ runId: run.runId, sha256: hashValue(run) })),
	});
	writeJsonArtifact(evalPath, EvalRunRecordSchema, candidate);
	writeJsonArtifact(
		join(value.runsRoot, sealedEvalRunId, "eval_run.json"),
		EvalRunRecordSchema,
		{
			...source,
			evalRunId: sealedEvalRunId,
			target: { ...source.target, gitSha: baselineRevision },
			label: "baseline",
			baselineEvalRunId: null,
			evidenceVisibility: "sealed",
			taskIds: ["task-super-secret-baseline"],
			runIds: ["run-super-secret-baseline"],
			runArtifacts: undefined,
			summary: { total: 1, pass: 0, fail: 1, error: 0, allPassRate: 0 },
		},
	);
	return { ...value, sealedEvalRunId };
}

/**
 * A comparable development pair whose graders score fractionally: both arms
 * miss the threshold, so only the mean score moves. The candidate also costs
 * more and answers faster, so the resource fragment has something to say.
 */
function comparedFixture(): { runsRoot: string; evalRunId: string; baselineEvalRunId: string } {
	const value = fixture();
	const baselineEvalRunId = "erun-report-baseline";
	const candidatePath = join(value.runsRoot, "run-report", "run.json");
	const source = RunRecordSchema.parse(JSON.parse(readFileSync(candidatePath, "utf8")));
	const scored = (score: number) => ({
		outcome: "fail" as const,
		graders: [{ name: "similarity", type: "similarity", passed: false, score, reason: `token-f1 = ${score}` }],
	});
	const candidate = RunRecordSchema.parse({
		...source,
		label: "candidate",
		parent: { evalRunId: value.evalRunId, candidateOf: "b".repeat(40) },
		metrics: { ...source.metrics, costUsd: 0.014, latencyMs: 1_800, tokens: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0, total: 200 } },
		evalResults: scored(0.85),
	});
	writeJsonArtifact(candidatePath, RunRecordSchema, candidate);

	const baselineRunId = "run-report-baseline";
	const baselineDir = join(value.runsRoot, baselineRunId);
	mkdirSync(baselineDir, { recursive: true });
	writeFileSync(join(baselineDir, "session.jsonl"), readFileSync(join(value.runsRoot, "run-report", "session.jsonl"), "utf8"));
	const baselineRun = RunRecordSchema.parse({
		...candidate,
		runId: baselineRunId,
		label: "baseline",
		target: { ...candidate.target, gitSha: "b".repeat(40) },
		metrics: { ...candidate.metrics, costUsd: 0.01, latencyMs: 2_000 },
		evalResults: scored(0.3),
		parent: { evalRunId: baselineEvalRunId, candidateOf: null },
	});
	writeJsonArtifact(join(baselineDir, "run.json"), RunRecordSchema, baselineRun);

	const evalPath = join(value.runsRoot, value.evalRunId, "eval_run.json");
	const index = EvalRunRecordSchema.parse(JSON.parse(readFileSync(evalPath, "utf8")));
	const oneTask = { total: 1, pass: 0, fail: 1, error: 0, allPassRate: 0 };
	writeJsonArtifact(join(value.runsRoot, baselineEvalRunId, "eval_run.json"), EvalRunRecordSchema, {
		...index,
		evalRunId: baselineEvalRunId,
		label: "baseline",
		target: baselineRun.target,
		taskIds: [baselineRun.taskId],
		runIds: [baselineRunId],
		runArtifacts: [{ runId: baselineRunId, sha256: hashValue(baselineRun) }],
		summary: oneTask,
	});
	writeJsonArtifact(evalPath, EvalRunRecordSchema, {
		...index,
		label: "candidate",
		baselineEvalRunId,
		taskIds: [candidate.taskId],
		runIds: [candidate.runId],
		runArtifacts: [{ runId: candidate.runId, sha256: hashValue(candidate) }],
		summary: oneTask,
	});
	return { ...value, baselineEvalRunId };
}

const RAW_OMITTED_SENTINEL = "SEALED_RAW_HOLDOUT_DO_NOT_RENDER";
const INCLUDED_SECRET = "sk-oversizedsecret1234567890";

function oversizedFixture(): {
	runsRoot: string;
	evalRunId: string;
	sourceRunIds: string[];
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
	const runCount = MAX_DETAIL_RUNS + 2;
	const sourceRunIds = Array.from({ length: runCount }, (_, index) => `run-oversized-${index.toString().padStart(2, "0")}`);
	const outcomes = sourceRunIds.map((_, index): "pass" | "fail" =>
		index < MAX_DETAIL_RUNS - 1 || index === runCount - 1 ? "fail" : "pass"
	);
	const records: RunRecord[] = [];
	let omittedRawTracePath = "";

	for (const [index, runId] of sourceRunIds.entries()) {
		const runDir = join(runsRoot, runId);
		mkdirSync(runDir, { recursive: true });
		let traceMessages: string[];
		if (index === 1) {
			traceMessages = Array.from({ length: 13 }, (_, messageIndex) => JSON.stringify({
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
			taskId: "task-bounded-projection",
			repetitionIndex: index,
			label: "solo",
			status: "completed",
			error: null,
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
			evalResults: {
				outcome,
				graders: index === runCount - 1
					? [{
						name: "required-tool",
						type: "tool_called",
						passed: false,
						score: 0,
						reason: "never called search",
					}]
					: [{
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
	const evalRun: EvalRunRecord = {
		schemaVersion: 3,
		purpose: "evidence" as const,
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
		repetitions: runCount,
		runIds: sourceRunIds,
		runArtifacts: records.map((record) => ({ runId: record.runId, sha256: hashValue(record) })),
		startedAt: "2026-08-26T10:00:00.000Z",
		finishedAt: "2026-08-26T10:00:01.000Z",
		summary: { total: runCount, pass, fail, error: 0, allPassRate: pass / runCount },
	};
	writeJsonArtifact(join(runsRoot, evalRunId, "eval_run.json"), EvalRunRecordSchema, evalRun);
	return { runsRoot, evalRunId, sourceRunIds, omittedRawTracePath };
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
	it("rejects a development report linked to a formally sealed baseline before opening it", () => {
		const value = sealedBaselineFixture();
		let message = "";
		try {
			collectEvalReportData(value.runsRoot, value.evalRunId);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toBe("cross-visibility baseline evidence is unavailable");
		expect(message).not.toContain(value.sealedEvalRunId);
		expect(message).not.toContain("super-secret");
	});

	it("carries the score verdict and its cost/latency fragment into the HTML comparison", () => {
		const value = comparedFixture();
		const data = collectEvalReportData(value.runsRoot, value.evalRunId, () => "2026-08-26T11:00:00.000Z");
		expect(data.comparison?.status).toBe("comparable");
		expect(data.comparison?.summary.delta).toBe(0);
		expect(data.comparison?.summary.scoreDelta).toBeCloseTo(0.55, 12);
		expect(data.comparison?.rows[0]).toMatchObject({ aScore: 0.3, bScore: 0.85, scoreDelta: 0.55, delta: 0 });
		expect(data.comparison?.resources).toMatchObject({ costRatio: 1.4, latencyRatio: 0.9, tokenRatio: 1 });
		expect(data.comparisonGateLine).toContain("development verdict:");
		expect(data.comparisonGateLine).toContain("· cost ×1.4 · latency ×0.9");
		expect(data.comparisonGateLine.length).toBeLessThanOrEqual(110);

		const html = renderEvalReportHtml(data);
		expect(html).toContain("cost ×1.4 · latency ×0.9");
		expect(html).toContain("<th>Score</th>");
		expect(html).toContain("id=\"comparison-gate\"");
		expect(html).toContain("q('#comparison-gate').textContent=DATA.comparisonGateLine");
	});

	it("strictly collects evidence while redacting credentials and bounding script embedding", () => {
		const value = fixture();
		const data = collectEvalReportData(value.runsRoot, value.evalRunId, () => "2026-08-26T11:00:00.000Z");
		expect(data.improvementBrief).toMatchObject({
			evalRunId: value.evalRunId,
			status: "inconclusive",
		});
		expect(data.improvementBrief.summary.failureModeCount).toBeGreaterThan(0);
		expect(data.projection).toMatchObject({
			selection: "mode-evidence-then-failures-errors-then-passes-source-order",
			sourceRunCount: 2,
			includedRunCount: 2,
			omittedRunCount: 0,
			traceTruncated: true,
			limits: { detailRuns: MAX_DETAIL_RUNS, traceCharacters: MAX_NORMALIZED_TRACE_CHARS },
			evalRun: {
				runIds: { sourceCount: 2, includedCount: 2, omittedCount: 0 },
			},
			diagnosis: {
				issues: { sourceCount: data.diagnosis.issues.length, includedCount: data.diagnosis.issues.length, omittedCount: 0 },
			},
			comparison: null,
		});
		expect(new Set(data.projection.truncatedTraceRunIds)).toEqual(new Set(["run-report", "run-report-error"]));
		expect(new Set(data.projection.includedRunIds)).toEqual(new Set(["run-report", "run-report-error"]));
		const toolMessage = data.runs[0]?.trace.find((message) => message.toolCalls.length > 0);
		expect(toolMessage?.toolCalls).toHaveLength(50);
		expect(toolMessage?.omittedToolCallCount).toBe(25);
		const gradedRun = data.runs.find((run) => run.graderProjection.sourceCount > 0);
		expect(gradedRun?.graders).toHaveLength(20);
		expect(gradedRun?.graderProjection).toEqual({ sourceCount: 25, includedCount: 20, omittedCount: 5 });
		expect(data.projection.diagnosis.toolNames.omittedCount).toBeGreaterThan(0);
		const traceSerialized = JSON.stringify(data.runs[0]?.trace);
		expect(traceSerialized).not.toContain("abcdefghijklmnop");
		expect(traceSerialized).not.toContain("sk-1234567890abcdef");
		expect(traceSerialized).toContain("REDACTED");
		const projectedData = JSON.stringify(data);
		expect(projectedData).not.toContain(GRADER_METADATA_SECRET);
		expect(projectedData).not.toContain(RUN_ERROR_SECRET);
		expect(projectedData).not.toContain(TASK_ID_SECRET);
		expect(projectedData).toContain("REDACTED");
		expect(data.evalRun).not.toHaveProperty("provenance");
		expect(data.evalRun.taskIds?.[0]).toMatch(/^\[REDACTED_API_KEY\]~/);
		const canonicalRun = readFileSync(join(value.runsRoot, "run-report", "run.json"), "utf8");
		const canonicalErrorRun = readFileSync(join(value.runsRoot, "run-report-error", "run.json"), "utf8");
		expect(canonicalRun).toContain(GRADER_METADATA_SECRET);
		expect(canonicalErrorRun).toContain(RUN_ERROR_SECRET);

		const html = renderEvalReportHtml(data);
		expect(html).toContain("AHDE Evidence Report");
		expect(html.indexOf("<h2>Failure modes</h2>")).toBeLessThan(html.indexOf("<h2>Task issue drill-down</h2>"));
		expect(html).toContain("Evidence-backed hypothesis, not proof.");
		expect(html).toContain("Projected evidence");
		expect(html).toContain("graders:");
		expect(html).toContain("tool call(s) omitted");
		expect(html).toContain("grader(s) omitted");
		expect(html).toContain("Proposal gate: blocked");
		expect(html).toContain("window.location.hash.slice(1)");
		expect(html).toContain("new URLSearchParams");
		expect(html).toContain("function showRun(id,scroll=true,syncHash=true)");
		expect(html).toContain("window.addEventListener('hashchange'");
		expect(html).toContain("window.location.hash=next");
		expect(html).toContain("if(scroll)q('#trace').scrollIntoView");
		expect(html).toContain("showRun(DATA.runs[0].runId,false,false)");
		expect(html).not.toContain("<img src=x onerror=alert(2)>");
		expect(html).not.toContain("</script><script>alert(1)</script>");
		expect(html).not.toContain("<svg onload=alert(3)>");
		expect(html).not.toContain(GRADER_METADATA_SECRET);
		expect(html).not.toContain(RUN_ERROR_SECRET);
		expect(html).toContain("\\u003cimg src=x onerror=alert(2)>");
		expect(html).toContain("\\u003csvg onload=alert(3)>");

		// The offline artifact carries the live explorer's own runs table and its
		// host-written explanations, so an operator reading report.html and an
		// operator reading /evals/<id> see the same rows and the same sentences.
		expect(html).toContain(
			"<thead><tr><th>Task</th><th>Rep</th><th>Input</th><th>Outcome</th><th>Score</th><th>Graders</th>" +
			"<th>Failure mode</th><th>Tools</th><th>Latency</th><th>Cost</th><th>Tokens</th></tr></thead>",
		);
		expect(html).toContain('href="#run=run-report"');
		expect(html).toContain('data-run="run-report"');
		expect(html).toContain('<span class="chip error">error</span>');
		expect(html).toContain('id="filter"');
		expect(data.rows.map((row) => row.runId)).toEqual(["run-report-error", "run-report"]);
		expect(data.rows.map((row) => row.taskId)).toEqual(["unsafe-error-task", "[REDACTED_API_KEY]~082c20a7e365"]);
		expect(data.omittedTableRowCount).toBe(0);
		// Every projected run failed here, so each one is explained.
		expect(data.explanations).toHaveLength(2);
		expect(data.explanations.every((explanation) => explanation.sentences.length > 0)).toBe(true);
		expect(JSON.stringify(data.explanations)).not.toContain(GRADER_METADATA_SECRET);
		expect(JSON.stringify(data.explanations)).not.toContain(RUN_ERROR_SECRET);
		expect(JSON.stringify(data.explanations)).not.toContain(TASK_ID_SECRET);
	});

	it("projects oversized evidence failure-first with deterministic run and cumulative trace budgets", () => {
		const value = oversizedFixture();
		const rawBefore = readFileSync(value.omittedRawTracePath, "utf8");
		const now = () => "2026-08-26T11:00:00.000Z";
		const first = collectEvalReportData(value.runsRoot, value.evalRunId, now);

		expect(first.evalRun.runIds).toEqual(value.sourceRunIds.slice(0, 50));
		expect(first.evalRun.summary.total).toBe(value.sourceRunIds.length);
		expect(first.projection.evalRun.runIds).toEqual({
			sourceCount: value.sourceRunIds.length,
			includedCount: 50,
			omittedCount: 2,
		});
		expect(first.diagnosis.summary.tasks).toBe(1);
		const failureRepresentativeRunIds = [...new Set(first.improvementBrief.modes.flatMap((mode) => {
			const representative = mode.evidence.find((evidence) => evidence.traceAvailable);
			return representative ? [representative.runId] : [];
		}))];
		const failureRepresentativeRunIdSet = new Set(failureRepresentativeRunIds);
		const counterRepresentativeRunIds = [...new Set(first.improvementBrief.modes.flatMap((mode) => {
			if (mode.decision !== "stabilize-and-rerun") return [];
			const representative = mode.counterEvidence.find((evidence) =>
				evidence.traceAvailable && !failureRepresentativeRunIdSet.has(evidence.runId)
			);
			return representative ? [representative.runId] : [];
		}))].slice(0, 5);
		const representativeRunIds = [...failureRepresentativeRunIds, ...counterRepresentativeRunIds];
		const representativeRunIdSet = new Set(representativeRunIds);
		const rawOmittedRunId = value.sourceRunIds.at(-2)!;
		const expectedIncludedRunIds = [
			...representativeRunIds,
			...value.sourceRunIds.filter((runId) =>
				runId !== rawOmittedRunId && !representativeRunIdSet.has(runId)
			),
			...(representativeRunIdSet.has(rawOmittedRunId) ? [] : [rawOmittedRunId]),
		].slice(0, MAX_DETAIL_RUNS);
		expect(first.runs.map((run) => run.runId)).toEqual(expectedIncludedRunIds);
		const beyondLegacyLimit = value.sourceRunIds.at(-1)!;
		const farMode = first.improvementBrief.modes.find((mode) =>
			mode.evidence.some((evidence) => evidence.runId === beyondLegacyLimit && evidence.traceAvailable)
		);
		expect(farMode).toBeDefined();
		expect(first.runs.map((run) => run.runId)).toContain(beyondLegacyLimit);
		for (const mode of first.improvementBrief.modes) {
			const representative = mode.evidence.find((evidence) => evidence.traceAvailable);
			if (!representative) continue;
			const projected = first.runs.find((run) => run.runId === representative.runId);
			expect(projected?.trace.length, mode.failureModeId).toBeGreaterThan(0);
		}
		expect(first.runs.filter((run) => run.outcome === "pass").map((run) => run.runId))
			.toEqual(counterRepresentativeRunIds);
		expect(first.projection).toMatchObject({
			selection: "mode-evidence-then-failures-errors-then-passes-source-order",
			sourceRunCount: value.sourceRunIds.length,
			includedRunCount: MAX_DETAIL_RUNS,
			omittedRunCount: 2,
			traceCharactersIncluded: MAX_NORMALIZED_TRACE_CHARS,
			traceTruncated: true,
			limits: { detailRuns: MAX_DETAIL_RUNS, traceCharacters: MAX_NORMALIZED_TRACE_CHARS },
		});
		expect(first.projection.truncatedTraceRunIds.length).toBeGreaterThan(0);
		expect(first.projection.truncatedTraceRunIds.every((runId) =>
			first.projection.includedRunIds.includes(runId)
		)).toBe(true);
		expect(projectedTraceCharacters(first)).toBe(first.projection.traceCharactersIncluded);
		expect(projectedTraceCharacters(first)).toBeLessThanOrEqual(MAX_NORMALIZED_TRACE_CHARS);
		expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(3 * 1024 * 1024);

		const serialized = JSON.stringify(first);
		const html = renderEvalReportHtml(first);
		expect(serialized).not.toContain(INCLUDED_SECRET);
		expect(serialized).toContain("REDACTED_API_KEY");
		expect(serialized).not.toContain(RAW_OMITTED_SENTINEL);
		expect(html).not.toContain(RAW_OMITTED_SENTINEL);
		expect(html).toContain("2 runs omitted");
		expect(html).toContain(`truncated for ${first.projection.truncatedTraceRunIds.length} included runs`);
		expect(html).toContain("250,000-character global budget");
		expect(readFileSync(value.omittedRawTracePath, "utf8")).toBe(rawBefore);
		expect(rawBefore).toContain(RAW_OMITTED_SENTINEL);
	});

	it("bounds mostly-empty trace structure before JSON and HTML serialization", () => {
		const value = fixture({ structuralFlood: true });
		const data = collectEvalReportData(value.runsRoot, value.evalRunId);
		const includedToolCalls = data.runs.reduce((total, run) =>
			total + run.trace.reduce((traceTotal, message) => traceTotal + message.toolCalls.length, 0), 0);

		expect(data.projection.toolCallsIncluded).toBe(MAX_NORMALIZED_TOOL_CALLS);
		expect(includedToolCalls).toBe(MAX_NORMALIZED_TOOL_CALLS);
		expect(data.projection.traceMessagesIncluded).toBeLessThanOrEqual(MAX_NORMALIZED_TRACE_MESSAGES);
		expect(data.projection.traceTruncated).toBe(true);
		expect(data.runs.some((run) => run.trace.some((message) => message.omittedToolCallCount > 0))).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(data), "utf8")).toBeLessThanOrEqual(3 * 1024 * 1024);

		const html = renderEvalReportHtml(data);
		expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(MAX_REPORT_HTML_BYTES);
		expect(html).toContain("structural caps");
	});

	it("atomically publishes an owner-only, self-contained HTML file", () => {
		const value = fixture();
		const output = buildEvalReport(value.runsRoot, value.evalRunId).path;
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
