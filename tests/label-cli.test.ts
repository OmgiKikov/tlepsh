import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendJudgeLabels,
	collectJudgeLabelSubjects,
	importJudgeLabels,
	isLegacyJudgeLabel,
	judgeEvidenceCalibration,
	judgeFingerprintHashOf,
	judgeLabelFilePath,
	type JudgeLabelRow,
	type JudgeLabelSuite,
	loadJudgeCalibration,
	readProjectJudgeLabels,
	runJudgeLabelSession,
} from "../src/application/judge-labels.js";
import { judgeAgreement, judgeCalibrationRefusal } from "../src/domain/judge-agreement.js";
import { GraderSpec, loadTarget, type ResolvedTask } from "../src/manifest.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import { judgeSubjectFor, runSuite, writeEvalRun, type EvalRunRecord } from "../src/eval.js";
import { openTrace } from "../src/trace.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";
import { collectEvalReportData, renderEvalReportHtml } from "../src/report.js";
import {
	RunRecordSchema,
	hashFile,
	hashValue,
	modelFingerprint,
	provenanceAxes,
	type RunRecord,
} from "../src/provenance.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";
import { baseRunRecord } from "./helpers/judge-fixtures.js";

const roots: string[] = [];
const at = "2026-08-30T10:00:00.000Z";
/**
 * A real grader spec, not an invented hash: the label screen now checks that
 * the spec it renders hashes to the identity the run recorded, so a fixture
 * that lies about it gets the legacy screen instead of the judge's own.
 */
const RUBRIC_GRADER = { type: "judge" as const, rubric: "Ответ полный и вежливый" };
const ASSERTIONS_GRADER = {
	type: "judge" as const,
	assertions: ["назван срок", "назван канал подачи", "нет лишних обещаний"],
};
const SPEC_A = hashValue(GraderSpec.parse(RUBRIC_GRADER));
const SPEC_ASSERTIONS = hashValue(GraderSpec.parse(ASSERTIONS_GRADER));
const SPEC_B = `sha256:${"b2".repeat(32)}`;

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface EvidenceFixture {
	runsRoot: string;
	stateRoot: string;
	evalRunId: string;
	projectId: string;
	/** The exact suite that graded this evidence, as `ahde label --target` passes it. */
	suite: JudgeLabelSuite;
}

/**
 * One development eval run of `tasks` judge-graded cases. Every second case
 * fails its judge, so the fixture has both directions of disagreement to label.
 */
function evidence(
	options: { tasks?: number; sealed?: boolean; assertions?: boolean } = {},
): EvidenceFixture {
	const tasks = options.tasks ?? 4;
	const grader = options.assertions ? ASSERTIONS_GRADER : RUBRIC_GRADER;
	const specHash = options.assertions ? SPEC_ASSERTIONS : SPEC_A;
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
						specHash,
						checkCode: "semantic-rubric",
						// The judge's own per-assertion answers, which the checklist
						// screen compares the human's ticks against.
						...(options.assertions ? { assertions: { total: 3, failed: passed ? [] : [2] } } : {}),
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
		// Judge-graded evidence always records the judge that graded it; the
		// labels below certify that exact instrument, not the rubric alone.
		judge: modelFingerprint({
			provider: "test",
			id: "test-judge",
			api: "openai-completions",
			baseUrl: "https://example.invalid/v1",
			apiKeyEnv: "TEST_JUDGE_KEY",
			thinkingLevel: "off",
			params: {},
			spec: {},
		}),
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
	return {
		runsRoot,
		stateRoot,
		evalRunId,
		projectId: "project",
		suite: {
			datasetHash: record.datasetHash,
			suiteHash: record.suiteHash,
			tasks: runs.map((run, index) => ({
				id: run.taskId,
				input: `вопрос ${index}`,
				effectiveGraders: [
					GraderSpec.parse({ type: "output_contains", text: "ответ" }),
					GraderSpec.parse(grader),
				],
			})),
		},
	};
}

function labelFile(dir: string, rows: readonly unknown[]): string {
	const path = join(dir, "labels.jsonl");
	writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
	return path;
}

describe("label subjects", () => {
	it("shows the task and the answer bounded and credential-redacted, never the judge first", () => {
		const value = evidence({ tasks: 2 });
		const subjects = collectJudgeLabelSubjects({
			runsRoot: value.runsRoot,
			evalRunId: value.evalRunId,
			suite: value.suite,
		});
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

	/**
	 * The rubric is the question the judge was asked. A human who never sees it
	 * is answering a question of their own, and the agreement number that comes
	 * out is about two different instruments.
	 */
	it("shows the question the judge was asked, and says so when it cannot", () => {
		const value = evidence({ tasks: 2 });
		const [withSuite] = collectJudgeLabelSubjects({
			runsRoot: value.runsRoot,
			evalRunId: value.evalRunId,
			suite: value.suite,
		});
		expect(withSuite).toMatchObject({
			subject: "judge-facing",
			kind: "single-turn",
			rubric: "Ответ полный и вежливый",
			assertions: null,
			reference: null,
		});
		expect(withSuite?.subjectHash).toMatch(/^sha256:[0-9a-f]{64}$/);

		// No suite in scope, or a suite that graded something else: the screen
		// falls back and marks itself, rather than showing a rubric it guessed.
		for (const suite of [undefined, { ...value.suite, suiteHash: `sha256:${"f".repeat(64)}` }]) {
			const [fallback] = collectJudgeLabelSubjects({
				runsRoot: value.runsRoot,
				evalRunId: value.evalRunId,
				...(suite ? { suite } : {}),
			});
			expect(fallback).toMatchObject({ subject: "legacy", subjectHash: null, rubric: null });
		}
	});

	it("puts the assertion checklist in front of the human, with the judge's own answers", () => {
		const value = evidence({ tasks: 2, assertions: true });
		const subjects = collectJudgeLabelSubjects({
			runsRoot: value.runsRoot,
			evalRunId: value.evalRunId,
			suite: value.suite,
		});
		expect(subjects[0]).toMatchObject({
			subject: "judge-facing",
			rubric: null,
			assertions: ASSERTIONS_GRADER.assertions,
			// run-0 passed every assertion; run-1 failed the second.
			judgeAssertions: ["yes", "yes", "yes"],
		});
		expect(subjects[1]?.judgeAssertions).toEqual(["yes", "no", "yes"]);
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

/**
 * The lane's whole point: what the human is shown is what the judge was shown.
 * Not "similar to" — the same object, derived by the same function, provable
 * against the exact request that is on disk beside the verdict.
 */
describe("subject parity with the judge", () => {
	const servers: MockModelHandle[] = [];

	afterEach(async () => {
		for (const server of servers.splice(0)) await server.close();
	});

	const manifestYaml = (targetUrl: string, judgeUrl: string, userUrl: string): string =>
		`id: parity-target
model:
  provider: qwen-mock
  id: mock-target
  api: openai-completions
  baseUrl: ${targetUrl}
  apiKeyEnv: MOCK_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 60000
instructions:
  agentsMd: AGENTS.md
skills: []
evalSuite:
  id: parity-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
  judge:
    provider: qwen-mock
    id: mock-judge
    api: openai-completions
    baseUrl: ${judgeUrl}
    apiKeyEnv: MOCK_MODEL_KEY
    thinkingLevel: "off"
    timeoutMs: 60000
  simulatedUser:
    provider: qwen-mock
    id: mock-user
    api: openai-completions
    baseUrl: ${userUrl}
    apiKeyEnv: MOCK_MODEL_KEY
    thinkingLevel: "off"
    timeoutMs: 60000
`;

	it("puts the same context, answer, rubric and reference in front of both", async () => {
		process.env.MOCK_MODEL_KEY = "test-key";
		const target = await startMockModel([{ steps: [], resolve: () => ({ text: "Возврат занимает тридцать дней." }) }]);
		const judge = await startMockModel([{
			steps: [],
			// One mock, three judge protocols: it answers whichever one it was asked.
			resolve: (body) => ({
				text: body.firstUser.includes("<утверждения>")
					? JSON.stringify({ verdicts: [1, 2].map((index) => ({ index, answer: "yes", evidence: "ок" })) })
					: body.firstUser.includes("<эталонный ответ>")
					? '{"choice": "C", "reason": "то же самое"}'
					: '{"passed": true, "reason": "ок"}',
			}),
		}]);
		const user = await startMockModel([
			{ steps: [], resolve: () => ({ text: '{"done": true, "message": ""}' }) },
		]);
		servers.push(target, judge, user);
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifestYaml(target.url, judge.url, user.url),
			"evals/development.jsonl": `${[
				{
					id: "single",
					input: "Сколько длится возврат?",
					expected: "тридцать дней",
					graders: [{ type: "judge", rubric: "агент называет срок", withReference: true }],
				},
				{
					id: "frozen",
					input: "А для золотых?",
					messages: [
						{ role: "user", content: "Сколько длится возврат?" },
						{ role: "assistant", content: "Тридцать дней." },
						{ role: "user", content: "А для золотых?" },
					],
					graders: [{ type: "judge", assertions: ["назван срок", "нет лишних обещаний"] }],
				},
				{
					id: "simulated",
					input: "Здравствуйте, вопрос по возврату.",
					simulatedUser: { goal: "узнать срок возврата", maxTurns: 2 },
					graders: [{ type: "judge", rubric: "агент довёл пользователя до ответа" }],
				},
			].map((task) => JSON.stringify(task)).join("\n")}\n`,
		}));
		const runsRoot = join(dir, "..", `label-parity-runs-${Date.now()}`);
		roots.push(runsRoot);
		try {
			const resolved = loadTarget(dir);
			const evalRun = await runSuite(resolved, { runsRoot, label: "solo", repetitions: 1 });
			expect(evalRun.summary.error).toBe(0);

			const subjects = collectJudgeLabelSubjects({
				runsRoot,
				evalRunId: evalRun.evalRunId,
				suite: {
					datasetHash: resolved.datasetHash,
					suiteHash: resolved.suiteHash,
					tasks: resolved.tasks,
				},
			});
			expect(subjects).toHaveLength(3);
			for (const subject of subjects) {
				const task = resolved.tasks.find((candidate) => candidate.id === subject.taskId)!;
				const spec = task.effectiveGraders[subject.graderIndex]!;
				const run = evalRun.runIds
					.map((runId) => JSON.parse(readFileSync(join(runsRoot, runId, "run.json"), "utf8")) as {
						runId: string;
						trace: { path: "session.jsonl"; sha256: string | null };
					})
					.find((candidate) => candidate.runId === subject.runId)!;

				// 1. The label subject IS the judge subject, hash and visible
				// bytes alike — including a bounded multi-turn transcript.
				const exactSubject = judgeSubjectFor(
					{
						input: task.input,
						messages: openTrace(join(runsRoot, run.runId), "session.jsonl", run.trace.sha256 ?? undefined),
						simulatedUser: task.simulatedUser,
						expected: task.expected,
					},
					spec as never,
				);
				expect(subject.subject).toBe("judge-facing");
				expect(subject.subjectHash).toBe(hashValue(exactSubject));
				expect(subject.input).toBe(exactSubject.context);
				expect(subject.answer).toBe(exactSubject.answer);
				expect(subject.rubric).toEqual(exactSubject.rubric);
				expect(subject.assertions).toEqual(exactSubject.assertions);
				expect(subject.reference).toEqual(exactSubject.reference);

				// 2. And every part of it is literally inside the request the judge
				//    was sent, which is on disk beside the verdict it produced.
				const prompt = (JSON.parse(
					readFileSync(join(runsRoot, run.runId, "judge", `${subject.graderIndex}.json`), "utf8"),
				) as { request: { body: { messages: { content: string }[] } } }).request.body.messages[1]!.content;
				expect(prompt).toContain(subject.input);
				expect(prompt).toContain(subject.answer);
				if (subject.rubric) expect(prompt).toContain(subject.rubric);
				if (subject.reference) expect(prompt).toContain(subject.reference);
				for (const assertion of subject.assertions ?? []) expect(prompt).toContain(assertion);
				expect(prompt.includes("<диалог агента с пользователем>")).toBe(subject.kind === "dialogue");
			}

			const byTask = Object.fromEntries(subjects.map((subject) => [subject.taskId, subject]));
			// The single-turn case: the request, the final answer, the reference.
			expect(byTask.single).toMatchObject({
				kind: "single-turn",
				input: "Сколько длится возврат?",
				answer: "Возврат занимает тридцать дней.",
				reference: "тридцать дней",
			});
			// The frozen-history case: what the judge saw is the last user turn and
			// the reply, plus the checklist it was asked.
			expect(byTask.frozen).toMatchObject({
				kind: "single-turn",
				input: "А для золотых?",
				assertions: ["назван срок", "нет лишних обещаний"],
				reference: null,
			});
			// The simulated case: the goal, and the whole conversation.
			expect(byTask.simulated).toMatchObject({ kind: "dialogue", input: "узнать срок возврата" });
			expect(byTask.simulated?.answer).toContain("Пользователь: Здравствуйте, вопрос по возврату.");
			expect(byTask.simulated?.answer).toContain("Агент: Возврат занимает тридцать дней.");
		} finally {
			cleanup(dir);
		}
	}, 180_000);
});

describe("assertion checklists", () => {
	it("writes one tick per assertion and scores agreement assertion by assertion", async () => {
		const value = evidence({ tasks: 2, assertions: true });
		const session = await runJudgeLabelSession({
			runsRoot: value.runsRoot,
			stateRoot: value.stateRoot,
			projectId: value.projectId,
			evalRunId: value.evalRunId,
			suite: value.suite,
			now: () => at,
			prompt: {
				// The human agrees with the judge on run-0 and differs on exactly one
				// assertion of run-1: 5 of 6 comparisons agree.
				ask: (subject) => Promise.resolve(subject.runId === "run-0"
					? { answer: "pass" as const, assertions: ["yes", "yes", "yes"] as const }
					: { answer: "fail" as const, assertions: ["no", "no", "yes"] as const }),
				reveal: () => {},
			},
		});
		expect(session.labelled).toBe(2);
		expect(session.rows[0]).toMatchObject({
			subject: "judge-facing",
			assertions: ["yes", "yes", "yes"],
			judgeAssertions: ["yes", "yes", "yes"],
			human: "pass",
			judge: "pass",
		});
		expect(session.rows[1]).toMatchObject({
			assertions: ["no", "no", "yes"],
			judgeAssertions: ["yes", "no", "yes"],
			human: "fail",
			judge: "fail",
		});
		// Pooled, these two labels agree perfectly and say nothing. Per assertion
		// they say the judge waves through exactly one check out of six.
		const report = judgeAgreement(readProjectJudgeLabels(value.stateRoot, value.projectId));
		expect(report.pooled.n).toBe(6);
		expect(report.pooled.agreement).toBeCloseTo(5 / 6, 10);
		expect(report.pooled.falsePass).toBe(1);
	});

	it("refuses an imported checklist that does not fit the grader it claims", () => {
		const value = evidence({ tasks: 2, assertions: true });
		const importWith = (rows: readonly unknown[]): JudgeLabelRow[] => importJudgeLabels({
			runsRoot: value.runsRoot,
			stateRoot: value.stateRoot,
			projectId: value.projectId,
			evalRunId: value.evalRunId,
			suite: value.suite,
			now: () => at,
			filePath: labelFile(value.stateRoot, rows),
		});
		const base = {
			runId: "run-0",
			taskId: "task-0",
			graderIndex: 1,
			graderSpecHash: SPEC_ASSERTIONS,
			human: "pass" as const,
		};
		expect(() => importWith([{ ...base, assertions: ["yes", "yes"] }]))
			.toThrow(/expected 3 assertion answer\(s\), got 2/);
		// The summary verdict must follow from the ticks it claims to summarize.
		expect(() => importWith([{ ...base, assertions: ["yes", "no", "yes"] }]))
			.toThrow(/must reflect the ticked assertions/);
		const rows = importWith([{ ...base, assertions: ["yes", "yes", "yes"] }]);
		expect(rows[0]?.assertions).toEqual(["yes", "yes", "yes"]);
		expect(rows[0]?.judgeAssertions).toEqual(["yes", "yes", "yes"]);
		// A file cannot claim its own subject identity: the host stamps it.
		expect(rows[0]?.subject).toBe("judge-facing");
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
				// A label certifies one rubric as answered by one judge.
				judgeFingerprintHash: judgeFingerprintHashOf(value.runsRoot, value.evalRunId) ?? undefined,
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
			judgeFingerprintHash: judgeFingerprintHashOf(value.runsRoot, value.evalRunId) ?? undefined,
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

	/**
	 * Regression: labels were keyed on the rubric alone. Swap the judge model and
	 * the rubric hash does not move, so yesterday's labels vouched for a judge
	 * nobody had ever read — exactly the number the promotion policy trusts.
	 */
	it("does not let labels for one judge certify a different judge", () => {
		const value = evidence({ tasks: 2 });
		label(value, "pass", "pass", 6);
		const own = judgeEvidenceCalibration({
			runsRoot: value.runsRoot,
			stateRoot: value.stateRoot,
			projectId: value.projectId,
			evalRunIds: [value.evalRunId],
		});
		expect(own.stats?.n).toBe(6);

		// The same rubric, answered by a judge nobody labelled.
		appendJudgeLabels(value.stateRoot, value.projectId, value.evalRunId, [{
			runId: "run-0",
			taskId: "task-0",
			graderIndex: 1,
			graderSpecHash: SPEC_A,
			judgeFingerprintHash: `sha256:${"f".repeat(64)}`,
			human: "fail",
			judge: "pass",
			at,
		}]);
		const unchanged = judgeEvidenceCalibration({
			runsRoot: value.runsRoot,
			stateRoot: value.stateRoot,
			projectId: value.projectId,
			evalRunIds: [value.evalRunId],
		});
		expect(unchanged.stats?.n).toBe(6);
		expect(unchanged.stats?.agreement).toBe(1);
	});
});

describe("labels written under the old screen", () => {
	it("stay readable, are counted separately, and are left out of the gate by default", () => {
		const value = evidence({ tasks: 2 });
		const judgeFingerprintHash = judgeFingerprintHashOf(value.runsRoot, value.evalRunId) ?? undefined;
		const row = (index: number, judgeFacing: boolean) => ({
			runId: `run-${index % 2}`,
			taskId: `task-${index % 2}`,
			graderIndex: 1,
			graderSpecHash: SPEC_A,
			judgeFingerprintHash,
			...(judgeFacing ? { subject: "judge-facing" as const, subjectHash: `sha256:${"7".repeat(64)}` } : {}),
			human: "pass" as const,
			judge: "pass" as const,
			at,
		});
		appendJudgeLabels(value.stateRoot, value.projectId, value.evalRunId, [
			row(0, false),
			row(1, false),
			row(2, true),
		]);
		// All three are still on disk and still parse.
		const stored = readProjectJudgeLabels(value.stateRoot, value.projectId);
		expect(stored).toHaveLength(3);
		expect(stored.filter(isLegacyJudgeLabel)).toHaveLength(2);

		const query = {
			runsRoot: value.runsRoot,
			stateRoot: value.stateRoot,
			projectId: value.projectId,
			evalRunIds: [value.evalRunId],
		};
		// The screens keep showing every label the project has collected…
		expect(judgeEvidenceCalibration(query).stats?.n).toBe(3);
		expect(judgeEvidenceCalibration(query).legacyLabels).toBe(2);
		// …and the gate counts only the ones that graded the judge's own subject.
		expect(judgeEvidenceCalibration({ ...query, includeLegacyLabels: false }).stats?.n).toBe(1);
		expect(judgeEvidenceCalibration({ ...query, includeLegacyLabels: false }).legacyLabels).toBe(2);
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
