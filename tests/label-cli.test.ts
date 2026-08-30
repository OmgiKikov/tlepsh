import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendJudgeLabels,
	collectJudgeLabelSubjects,
	importJudgeLabels,
	judgeEvidenceCalibration,
	judgeLabelFilePath,
	loadJudgeCalibration,
	readProjectJudgeLabels,
	runJudgeLabelSession,
	type JudgeLabelRow,
} from "../src/application/judge-labels.js";
import { judgeCalibrationRefusal } from "../src/domain/judge-agreement.js";
import { writeEvalRun, type EvalRunRecord } from "../src/eval.js";
import { collectEvalReportData, renderEvalReportHtml } from "../src/report.js";
import {
	RunRecordSchema,
	hashFile,
	hashValue,
	provenanceAxes,
	type RunRecord,
} from "../src/provenance.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";
import { baseRunRecord } from "./helpers/judge-fixtures.js";

const roots: string[] = [];
const at = "2026-08-30T10:00:00.000Z";
const SPEC_A = `sha256:${"a1".repeat(32)}`;
const SPEC_B = `sha256:${"b2".repeat(32)}`;

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface EvidenceFixture {
	runsRoot: string;
	stateRoot: string;
	evalRunId: string;
	projectId: string;
}

/**
 * One development eval run of `tasks` judge-graded cases. Every second case
 * fails its judge, so the fixture has both directions of disagreement to label.
 */
function evidence(options: { tasks?: number; sealed?: boolean } = {}): EvidenceFixture {
	const tasks = options.tasks ?? 4;
	const runsRoot = mkdtempSync(join(tmpdir(), "ahde-label-runs-"));
	const stateRoot = mkdtempSync(join(tmpdir(), "ahde-label-state-"));
	roots.push(runsRoot, stateRoot);
	const evalRunId = "erun-labels";
	const runs: RunRecord[] = [];
	for (let index = 0; index < tasks; index += 1) {
		const runId = `run-${index}`;
		const passed = index % 2 === 0;
		const trace = `${[
			{ type: "message", message: { role: "user", content: [{ type: "text", text: `вопрос ${index}` }] } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `ответ ${index} · ключ sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345` }],
				},
			},
		].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		mkdirSync(join(runsRoot, runId), { recursive: true });
		writeFileSync(join(runsRoot, runId, "session.jsonl"), trace);
		runs.push(baseRunRecord({
			runId,
			taskId: `task-${index}`,
			trace: { path: "session.jsonl", sessionId: null, sha256: hashFile(trace) },
			parent: { evalRunId, candidateOf: null },
			evalResults: {
				graders: [
					{ name: "contains", type: "output_contains", passed: true, score: 1, reason: "ok" },
					{
						name: `task-${index}#1:judge`,
						type: "judge",
						passed,
						score: passed ? 1 : 0,
						reason: passed ? "судья доволен" : "судья недоволен",
						specHash: SPEC_A,
						checkCode: "semantic-rubric",
					},
				],
				outcome: passed ? "pass" : "fail",
			},
		}));
	}
	for (const run of runs) writeJsonArtifact(join(runsRoot, run.runId, "run.json"), RunRecordSchema, run);
	const first = runs[0]!;
	const provenance = provenanceAxes({
		runtime: first.runtime,
		model: first.model,
		judge: null,
		execution: first.execution,
		eval: first.eval,
	});
	const pass = runs.filter((run) => run.evalResults?.outcome === "pass").length;
	const record: EvalRunRecord = {
		schemaVersion: 2,
		evalRunId,
		target: first.target,
		label: "baseline",
		baselineEvalRunId: null,
		provenance,
		provenanceKey: hashValue(provenance),
		suiteId: first.eval.suiteId,
		suiteHash: first.eval.suiteHash,
		dataset: first.eval.dataset,
		datasetHash: first.eval.datasetHash,
		evidenceVisibility: options.sealed ? "sealed" : "development",
		taskIds: runs.map((run) => run.taskId),
		repetitions: 1,
		runIds: runs.map((run) => run.runId),
		runArtifacts: runs.map((run) => ({ runId: run.runId, sha256: hashValue(run) })),
		startedAt: at,
		finishedAt: at,
		summary: {
			total: runs.length,
			pass,
			fail: runs.length - pass,
			error: 0,
			allPassRate: pass / runs.length,
		},
	};
	writeEvalRun(runsRoot, record);
	return { runsRoot, stateRoot, evalRunId, projectId: "project" };
}

function labelFile(dir: string, rows: readonly unknown[]): string {
	const path = join(dir, "labels.jsonl");
	writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
	return path;
}

describe("label subjects", () => {
	it("shows the task and the answer bounded and credential-redacted, never the judge first", () => {
		const value = evidence({ tasks: 2 });
		const subjects = collectJudgeLabelSubjects({ runsRoot: value.runsRoot, evalRunId: value.evalRunId });
		expect(subjects).toHaveLength(2);
		expect(subjects[0]).toMatchObject({
			runId: "run-0",
			taskId: "task-0",
			graderIndex: 1,
			graderSpecHash: SPEC_A,
			judge: "pass",
		});
		expect(subjects[0]?.input).toBe("вопрос 0");
		expect(subjects[0]?.answer).toContain("ответ 0");
		expect(subjects[0]?.answer).not.toContain("sk-ant-api03");
		expect(subjects[0]?.answer).toContain("[REDACTED");
	});

	it("draws the same sample for the same seed and a different one for another", () => {
		const value = evidence({ tasks: 12 });
		const query = { runsRoot: value.runsRoot, evalRunId: value.evalRunId, sample: 4 };
		const first = collectJudgeLabelSubjects({ ...query, seed: "первый" }).map((s) => s.runId);
		const again = collectJudgeLabelSubjects({ ...query, seed: "первый" }).map((s) => s.runId);
		const other = collectJudgeLabelSubjects({ ...query, seed: "второй" }).map((s) => s.runId);
		expect(first).toHaveLength(4);
		expect(again).toEqual(first);
		expect(other).not.toEqual(first);
		// A sample is a subset, never an invention.
		const all = new Set(collectJudgeLabelSubjects({ runsRoot: value.runsRoot, evalRunId: value.evalRunId })
			.map((s) => s.runId));
		expect(first.every((runId) => all.has(runId))).toBe(true);
		// Asking for more than exists is the whole set, not an error.
		expect(collectJudgeLabelSubjects({ ...query, sample: 99, seed: "первый" })).toHaveLength(12);
	});

	it("refuses sealed evidence outright: labelling it would be reading it", () => {
		const value = evidence({ tasks: 2, sealed: true });
		expect(() => collectJudgeLabelSubjects({ runsRoot: value.runsRoot, evalRunId: value.evalRunId }))
			.toThrow(/sealed holdout evidence is never labelled/);
		expect(() => importJudgeLabels({
			runsRoot: value.runsRoot,
			stateRoot: value.stateRoot,
			projectId: value.projectId,
			evalRunId: value.evalRunId,
			filePath: labelFile(value.stateRoot, []),
		})).toThrow(/sealed holdout evidence is never labelled/);
	});
});

describe("label import", () => {
	it("stores rows that match the evidence and stamps the judge verdict from the run", () => {
		const value = evidence({ tasks: 2 });
		const rows = importJudgeLabels({
			runsRoot: value.runsRoot,
			stateRoot: value.stateRoot,
			projectId: value.projectId,
			evalRunId: value.evalRunId,
			now: () => at,
			filePath: labelFile(value.stateRoot, [
				{ runId: "run-0", taskId: "task-0", graderIndex: 1, graderSpecHash: SPEC_A, human: "fail", note: "судья добр" },
				{ runId: "run-1", taskId: "task-1", graderIndex: 1, graderSpecHash: SPEC_A, human: "fail" },
			]),
		});
		expect(rows.map((row) => [row.human, row.judge])).toEqual([["fail", "pass"], ["fail", "fail"]]);
		expect(rows[0]?.at).toBe(at);
		expect(rows[0]?.note).toBe("судья добр");
		const stored = readProjectJudgeLabels(value.stateRoot, value.projectId);
		expect(stored).toEqual(rows);
		expect(readFileSync(judgeLabelFilePath(value.stateRoot, value.projectId, value.evalRunId), "utf8")
			.trim().split("\n")).toHaveLength(2);
	});

	it("refuses a row that does not describe evidence this eval run actually holds", () => {
		const value = evidence({ tasks: 2 });
		const base = { runId: "run-0", taskId: "task-0", graderIndex: 1, graderSpecHash: SPEC_A, human: "pass" as const };
		const importWith = (rows: readonly unknown[]): JudgeLabelRow[] => importJudgeLabels({
			runsRoot: value.runsRoot,
			stateRoot: value.stateRoot,
			projectId: value.projectId,
			evalRunId: value.evalRunId,
			now: () => at,
			filePath: labelFile(value.stateRoot, rows),
		});
		expect(() => importWith([{ ...base, runId: "run-404" }])).toThrow(/is not a judge check of eval run/);
		// Grader 0 is an output_contains check, not a judge check.
		expect(() => importWith([{ ...base, graderIndex: 0 }])).toThrow(/is not a judge check of eval run/);
		expect(() => importWith([{ ...base, graderSpecHash: SPEC_B }])).toThrow(/graderSpecHash does not match/);
		expect(() => importWith([{ ...base, taskId: "task-1" }])).toThrow(/taskId does not match/);
		expect(() => importWith([{ ...base, judge: "fail" }])).toThrow(/judge verdict contradicts the recorded grade/);
		expect(() => importWith([base, base])).toThrow(/duplicate label/);
		expect(() => importWith([{ ...base, human: "maybe" }])).toThrow(/schema validation failed/);
		expect(() => importWith([{ ...base, extra: 1 }])).toThrow(/schema validation failed/);
		// Nothing partial was stored on the way to any of those refusals.
		expect(readProjectJudgeLabels(value.stateRoot, value.projectId)).toEqual([]);
	});
});

describe("interactive labelling", () => {
	it("asks blind, reveals afterwards, and keeps every answer given before an interruption", async () => {
		const value = evidence({ tasks: 4 });
		const order: string[] = [];
		const session = await runJudgeLabelSession({
			runsRoot: value.runsRoot,
			stateRoot: value.stateRoot,
			projectId: value.projectId,
			evalRunId: value.evalRunId,
			sample: 3,
			seed: "калибровка",
			now: () => at,
			prompt: {
				ask: (subject, ordinal) => {
					order.push(`ask ${subject.runId}`);
					return Promise.resolve(ordinal === 2 ? { answer: "skip" as const } : { answer: "fail" as const, note: " заметка " });
				},
				reveal: (subject) => order.push(`reveal ${subject.runId} ${subject.judge}`),
			},
		});
		expect(session.labelled).toBe(2);
		expect(session.skipped).toBe(1);
		// Every reveal comes after its own question, never before.
		expect(order.filter((_entry, index) => index % 2 === 0).every((entry) => entry.startsWith("ask"))).toBe(true);
		expect(order.filter((_entry, index) => index % 2 === 1).every((entry) => entry.startsWith("reveal"))).toBe(true);
		expect(readProjectJudgeLabels(value.stateRoot, value.projectId)).toHaveLength(2);
		expect(session.rows[0]?.note).toBe("заметка");
	});
});

describe("calibration on the screens", () => {
	function label(value: EvidenceFixture, human: "pass" | "fail", judge: "pass" | "fail", count: number): void {
		appendJudgeLabels(
			value.stateRoot,
			value.projectId,
			value.evalRunId,
			Array.from({ length: count }, (_unused, index) => ({
				runId: `run-${index % 2}`,
				taskId: `task-${index % 2}`,
				graderIndex: 1,
				graderSpecHash: SPEC_A,
				human,
				judge,
				at,
			})),
		);
	}

	it("puts one line per judge grader on the report, and says so when nobody has checked", () => {
		const value = evidence({ tasks: 2 });
		const uncalibrated = collectEvalReportData(value.runsRoot, value.evalRunId, () => at, {
			labels: { stateRoot: value.stateRoot, projectId: value.projectId },
		});
		expect(uncalibrated.judgeCalibration).toHaveLength(1);
		expect(uncalibrated.judgeCalibration[0]).toMatchObject({
			graderSpecHash: SPEC_A,
			calibrated: false,
			labels: 0,
			line: "judge not calibrated",
		});

		label(value, "pass", "pass", 8);
		label(value, "fail", "pass", 2);
		const calibrated = collectEvalReportData(value.runsRoot, value.evalRunId, () => at, {
			labels: { stateRoot: value.stateRoot, projectId: value.projectId },
		});
		// 80% raw agreement, κ 0: this judge said pass to everything, so chance
		// alone explains all of it. The line shows both numbers for that reason.
		expect(calibrated.judgeCalibration[0]?.line).toBe("judge agreement 80% · κ 0.00 · n=10");
		expect(calibrated.judgeCalibration[0]?.labels).toBe(10);
		expect(renderEvalReportHtml(calibrated)).toContain("judge agreement 80%");
	});

	it("pools only the labels of the grader specs this evidence actually used", () => {
		const value = evidence({ tasks: 2 });
		label(value, "pass", "pass", 4);
		appendJudgeLabels(value.stateRoot, value.projectId, "erun-elsewhere", [{
			runId: "run-0",
			taskId: "task-0",
			graderIndex: 1,
			graderSpecHash: SPEC_B,
			human: "pass",
			judge: "pass",
			at,
		}]);
		expect(loadJudgeCalibration(value.stateRoot, value.projectId).totalLabels).toBe(5);
		const calibration = judgeEvidenceCalibration({
			runsRoot: value.runsRoot,
			stateRoot: value.stateRoot,
			projectId: value.projectId,
			evalRunIds: [value.evalRunId],
		});
		expect(calibration.specHashes).toEqual([SPEC_A]);
		expect(calibration.stats?.n).toBe(4);
	});
});

describe("promotion policy", () => {
	const stats = (n: number, agreement: number) => ({
		n,
		agreement,
		kappa: 0.5,
		falsePass: 0,
		falseFail: 0,
		truePass: 0,
		trueFail: 0,
	});

	it("is silent by default: an unset policy never blocks a promotion", () => {
		expect(judgeCalibrationRefusal(undefined, { judgeGraderSpecs: 2, stats: null })).toBeNull();
	});

	it("never blocks evidence that no judge graded", () => {
		expect(judgeCalibrationRefusal(
			{ minAgreement: 0.8, minLabels: 30 },
			{ judgeGraderSpecs: 0, stats: null },
		)).toBeNull();
	});

	it("refuses too few labels or too much disagreement, and says which", () => {
		const policy = { minAgreement: 0.8, minLabels: 30 };
		expect(judgeCalibrationRefusal(policy, { judgeGraderSpecs: 1, stats: null }))
			.toMatch(/with 0 human label\(s\) at 0% agreement; the Target requires at least 30 label\(s\) at 80%/);
		expect(judgeCalibrationRefusal(policy, { judgeGraderSpecs: 1, stats: stats(29, 1) }))
			.toContain("29 human label(s)");
		expect(judgeCalibrationRefusal(policy, { judgeGraderSpecs: 1, stats: stats(40, 0.75) }))
			.toContain("75% agreement");
		expect(judgeCalibrationRefusal(policy, { judgeGraderSpecs: 1, stats: stats(30, 0.8) })).toBeNull();
	});
});
