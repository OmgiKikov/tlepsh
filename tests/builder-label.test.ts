import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import {
	AHDE_BUILDER_COMMAND_NAMES,
	registerAhdeBuilderCommands,
} from "../src/builder/commands.js";
import {
	DEFAULT_LABEL_SAMPLE,
	MAX_LABEL_SAMPLE,
	NoJudgedEvidence,
	newestJudgedEvalRun,
	runBuilderLabelSession,
	type LabelScreen,
} from "../src/builder/label-session.js";
import { judgeMeaning, judgeNextStep } from "../src/builder/render/label.js";
import { stripMarkers, type TranscriptPresenter, type TranscriptTone } from "../src/builder/transcript.js";
import { plainPaint } from "../src/builder/render/paint.js";
import {
	judgeEvidenceCalibration,
	judgeLabelFilePath,
	readProjectJudgeLabels,
	type JudgeLabelSuite,
} from "../src/application/judge-labels.js";
import { formatJudgeAgreement } from "../src/domain/judge-agreement.js";
import { GraderSpec } from "../src/manifest.js";
import { writeEvalRun, type EvalRunRecord } from "../src/eval.js";
import { setLanguage } from "../src/i18n.js";
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

/** Real grader specs: the screen refuses to render a spec that does not hash to what the run recorded. */
const RUBRIC_GRADER = { type: "judge" as const, rubric: "Ответ полный и вежливый" };
const ASSERTIONS_GRADER = {
	type: "judge" as const,
	assertions: ["назван срок", "назван канал подачи", "нет лишних обещаний"],
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	setLanguage(null);
});

interface EvidenceFixture {
	runsRoot: string;
	stateRoot: string;
	evalRunId: string;
	projectId: string;
	targetId: string;
	suite: JudgeLabelSuite;
}

/**
 * One development eval run of judge-graded cases. Every second case fails its
 * judge, so the fixture carries both directions of disagreement to label.
 */
function evidence(
	options: {
		tasks?: number;
		assertions?: boolean;
		/** Grade with no judge at all, so `/label` has nothing to check. */
		noJudge?: boolean;
		evalRunId?: string;
		runsRoot?: string;
		stateRoot?: string;
		startedAt?: string;
	} = {},
): EvidenceFixture {
	const tasks = options.tasks ?? 6;
	const grader = options.assertions ? ASSERTIONS_GRADER : RUBRIC_GRADER;
	const specHash = hashValue(GraderSpec.parse(grader));
	const runsRoot = options.runsRoot ?? mkdtempSync(join(tmpdir(), "ahde-label-runs-"));
	const stateRoot = options.stateRoot ?? mkdtempSync(join(tmpdir(), "ahde-label-state-"));
	if (!options.runsRoot) roots.push(runsRoot);
	if (!options.stateRoot) roots.push(stateRoot);
	const evalRunId = options.evalRunId ?? "erun_labels";
	const startedAt = options.startedAt ?? at;
	const runs: RunRecord[] = [];
	for (let index = 0; index < tasks; index += 1) {
		const runId = `${evalRunId}-run-${index}`;
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
					...(options.noJudge ? [] : [{
						name: `task-${index}#1:judge`,
						type: "judge" as const,
						passed,
						score: passed ? 1 : 0,
						reason: passed ? "судья доволен" : "судья недоволен",
						specHash,
						checkCode: "semantic-rubric" as const,
						...(options.assertions ? { assertions: { total: 3, failed: passed ? [] : [2] } } : {}),
					}]),
				],
				// The outcome is the conjunction of the graders, so a run with no
				// judge has nothing left that can fail it.
				outcome: options.noJudge || passed ? "pass" as const : "fail" as const,
			},
		}));
	}
	for (const run of runs) writeJsonArtifact(join(runsRoot, run.runId, "run.json"), RunRecordSchema, run);
	const first = runs[0]!;
	const provenance = provenanceAxes({
		runtime: first.runtime,
		model: first.model,
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
		schemaVersion: 3,
		purpose: "evidence",
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
		evidenceVisibility: "development",
		taskIds: runs.map((run) => run.taskId),
		repetitions: 1,
		runIds: runs.map((run) => run.runId),
		runArtifacts: runs.map((run) => ({ runId: run.runId, sha256: hashValue(run) })),
		startedAt,
		finishedAt: startedAt,
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
		targetId: first.target.id,
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

interface ScreenFixture {
	screen: LabelScreen;
	blocks: Array<{ title: string; tone: TranscriptTone; lines: string[] }>;
	notices: Array<{ message: string; tone: string }>;
	selects: Array<{ title: string; choices: string[] }>;
	inputs: string[];
	/** Every rendered line of every panel, markers stripped. */
	text(): string;
	panel(index: number): string;
}

/**
 * A scripted operator. `answers` are consumed one per select; `undefined`
 * dismisses the dialog, which the exercise reads as leaving.
 */
function screenFixture(answers: readonly (string | undefined)[], notes: readonly string[] = []): ScreenFixture {
	const blocks: ScreenFixture["blocks"] = [];
	const notices: ScreenFixture["notices"] = [];
	const selects: ScreenFixture["selects"] = [];
	const inputs: string[] = [];
	const pendingAnswers = [...answers];
	const pendingNotes = [...notes];
	return {
		screen: {
			show: (block) => blocks.push({ title: block.title, tone: block.tone, lines: block.lines }),
			select: async (title, choices) => {
				selects.push({ title, choices });
				const answer = pendingAnswers.shift();
				if (answer !== undefined && !choices.includes(answer)) {
					throw new Error(`scripted answer ${JSON.stringify(answer)} is not offered: ${choices.join(" / ")}`);
				}
				return answer;
			},
			input: async (title) => {
				inputs.push(title);
				return pendingNotes.shift();
			},
			notify: (message, tone) => notices.push({ message, tone }),
		},
		blocks,
		notices,
		selects,
		inputs,
		text: () => blocks.flatMap((block) => block.lines).map(stripMarkers).join("\n"),
		panel: (index) => (blocks[index]?.lines ?? []).map(stripMarkers).join("\n"),
	};
}

function session(fixture: EvidenceFixture, screen: LabelScreen, sample?: number) {
	return runBuilderLabelSession({
		runsRoot: fixture.runsRoot,
		stateRoot: fixture.stateRoot,
		projectId: fixture.projectId,
		targetDir: fixture.runsRoot,
		targetId: fixture.targetId,
		...(sample === undefined ? {} : { sample }),
		screen,
		paint: plainPaint,
		suiteFor: () => fixture.suite,
		now: () => at,
	});
}

describe("/label — the judge check as an exercise", () => {
	it("shows exactly what the judge was given, and never its verdict before the answer", async () => {
		setLanguage("ru");
		const fixture = evidence({ tasks: 4 });
		const ui = screenFixture(["хорошо", "плохо", "хорошо", "стоп"], ["ответ мимо вопроса"]);

		const result = await session(fixture, ui.screen, 4);

		// Subject, reveal, subject, reveal, subject, reveal — then the fourth
		// subject, which was shown and then left, so it has no reveal at all.
		expect(ui.blocks.map((block) => block.title)).toEqual([
			"AHDE · Судья 1/4",
			"AHDE · Судья 1/4",
			"AHDE · Судья 2/4",
			"AHDE · Судья 2/4",
			"AHDE · Судья 3/4",
			"AHDE · Судья 3/4",
			"AHDE · Судья 4/4",
			"AHDE · Судья проверен",
		]);
		// The first panel is the judge's own subject and nothing else.
		const first = ui.panel(0);
		expect(first).toContain("что спросили");
		expect(first).toContain("вопрос");
		expect(first).toContain("агент ответил");
		expect(first).toContain("критерий, который дали судье");
		expect(first).toContain("Ответ полный и вежливый");
		// Credentials never reach a screen, here or anywhere else.
		expect(first).not.toContain("sk-ant-api03");
		expect(first).toContain("[REDACTED");
		// The whole point: no verdict, no reason, no score before the answer.
		for (const leak of ["судья сказал", "судья доволен", "судья недоволен", "хорошо", "плохо"]) {
			expect(first).not.toContain(leak);
		}
		expect(result.stopped).toBe(true);
		expect(result.labelled).toBe(3);
	});

	it("reveals the judge only after the verdict, and says which way they differ", async () => {
		setLanguage("ru");
		const fixture = evidence({ tasks: 4 });
		// run-0 passed its judge, run-1 failed it. The draw is seeded, so the two
		// answers below are read against whichever two the seed produced.
		const ui = screenFixture(["хорошо", "хорошо", "стоп"], []);

		await session(fixture, ui.screen, 4);

		const reveals = [ui.panel(1), ui.panel(3)];
		for (const reveal of reveals) expect(reveal).toMatch(/^судья сказал: (хорошо|плохо) · /);
		// Saying "good" to both a passed and a failed judge check must produce one
		// agreement and one disagreement, in the operator's own words.
		expect(reveals.join("\n")).toContain("судья сказал: хорошо · согласен с тобой");
		expect(reveals.join("\n")).toContain("судья сказал: плохо · РАСХОДИТСЯ с тобой");
		// The judge's own reason arrives with the reveal, never before it.
		expect(reveals.join("\n")).toMatch(/судья (доволен|недоволен)/);
	});

	it("writes every answer through the service with its lineage receipt, before the next question", async () => {
		const fixture = evidence({ tasks: 4 });
		const ui = screenFixture(["good", "bad", "stop"], ["missed the deadline"]);

		const result = await session(fixture, ui.screen, 4);

		const rows = readProjectJudgeLabels(fixture.stateRoot, fixture.projectId);
		expect(rows).toHaveLength(2);
		expect(result.labelled).toBe(2);
		for (const row of rows) {
			expect(row.lineage).toMatchObject({
				evalRunId: fixture.evalRunId,
				targetId: fixture.targetId,
				datasetHash: fixture.suite.datasetHash,
				suiteHash: fixture.suite.suiteHash,
			});
			// The judge that was actually checked, and the exact subject that was read.
			expect(row.judgeFingerprintHash).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(row.subject).toBe("judge-facing");
			expect(row.subjectHash).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(row.at).toBe(at);
		}
		expect(rows.map((row) => row.human)).toEqual(["pass", "fail"]);
		expect(rows[1]?.note).toBe("missed the deadline");
		// A note is asked for only when the operator said the answer was bad.
		expect(ui.inputs).toHaveLength(1);
		// The same file `ahde label` writes.
		expect(judgeLabelFilePath(fixture.stateRoot, fixture.projectId, fixture.evalRunId))
			.toBe(join(fixture.stateRoot, "projects", fixture.projectId, "labels", `${fixture.evalRunId}.jsonl`));
	});

	it("ends on the same numbers judge-agreement computes, with one sentence of what they mean", async () => {
		setLanguage("ru");
		const fixture = evidence({ tasks: 6 });
		const ui = screenFixture(["хорошо", "хорошо", "хорошо", "плохо", "стоп"], ["не то"]);

		const result = await session(fixture, ui.screen, 6);

		const exact = judgeEvidenceCalibration({
			runsRoot: fixture.runsRoot,
			stateRoot: fixture.stateRoot,
			projectId: fixture.projectId,
			evalRunIds: [fixture.evalRunId],
		});
		expect(exact.stats).not.toBeNull();
		expect(result.stats).toEqual(exact.stats);
		const end = ui.panel(ui.blocks.length - 1);
		expect(end).toContain(`n=${exact.stats!.n}`);
		expect(end).toContain(`согласие ${Math.round(exact.stats!.agreement * 100)}%`);
		// The same arithmetic the CLI table prints, down to κ.
		expect(formatJudgeAgreement(exact.stats!)).toContain(`n=${exact.stats!.n}`);
		// The sentence is wrapped onto the panel, so it is matched word by word.
		expect(end.replace(/\s+/g, " ")).toContain(judgeMeaning(exact.stats!));
		expect(end).toContain(judgeNextStep(exact.stats!));
		expect(end).toContain("Судья ошибается примерно в одном ответе из");
		expect(end).toContain("Ещё");
	});

	it("says which way the judge errs, and what would settle the number", () => {
		const base = {
			n: 20,
			nChecks: 20,
			duplicateLabels: 0,
			conflictedSubjects: 0,
			kappa: 0.62,
			truePass: 8,
			trueFail: 9,
		};
		setLanguage("ru");
		// Three false passes against zero false fails: the judge waves failures through.
		expect(judgeMeaning({ ...base, agreement: 0.85, falsePass: 3, falseFail: 0 }))
			.toBe("Судья ошибается примерно в одном ответе из семи; провалы он ловит хуже, чем успехи.");
		expect(judgeMeaning({ ...base, agreement: 0.85, falsePass: 0, falseFail: 3 }))
			.toContain("он заваливает ответы, которые ты бы принял");
		expect(judgeMeaning({ ...base, agreement: 1, falsePass: 0, falseFail: 0 }))
			.toBe("Судья согласился с тобой везде.");
		// Above the exercise's own floor the next step stops asking for more.
		expect(judgeNextStep({ ...base, agreement: 0.85, falsePass: 3, falseFail: 0 }))
			.toBe("Этого достаточно, чтобы верить судье при выпуске");
		expect(judgeNextStep({ ...base, n: 6, nChecks: 6, agreement: 0.5, falsePass: 3, falseFail: 0 }))
			.toBe("Ещё 14 ответов уточнят цифру");
		setLanguage("en");
		expect(judgeMeaning({ ...base, agreement: 0.85, falsePass: 3, falseFail: 0 }))
			.toBe("The judge is wrong about one answer in 7; it catches failures worse than successes.");
		expect(judgeNextStep({ ...base, agreement: 0.85, falsePass: 3, falseFail: 0 }))
			.toBe("That is enough to trust the judge at release");
	});

	it("asks an assertion rubric one assertion at a time, and reveals the ones that differ", async () => {
		setLanguage("ru");
		const fixture = evidence({ tasks: 4, assertions: true });
		// First subject: all three yes. Second: yes, yes, no — the judge's own answer
		// on a failed case. Then leave.
		const ui = screenFixture(["да", "да", "да", "да", "да", "нет", "стоп"], ["третий пункт не выполнен"]);

		await session(fixture, ui.screen, 4);

		expect(ui.panel(0)).toContain("чек-лист, который заполнял судья");
		expect(ui.panel(0)).toContain("1. назван срок");
		expect(ui.panel(0)).toContain("3. нет лишних обещаний");
		// One question per assertion, and `стоп` only on the first of each subject.
		expect(ui.selects[0]?.choices).toEqual(["да", "нет", "не знаю", "стоп"]);
		expect(ui.selects[1]?.choices).toEqual(["да", "нет", "не знаю"]);
		expect(ui.selects[0]?.title).toContain("1/3 · назван срок");
		const rows = readProjectJudgeLabels(fixture.stateRoot, fixture.projectId);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.assertions).toEqual(["yes", "yes", "yes"]);
		expect(rows[1]?.assertions).toEqual(["yes", "yes", "no"]);
		// The pooled verdict follows from the ticks; it is never asked for twice.
		expect(rows.map((row) => row.human)).toEqual(["pass", "fail"]);
		// Whichever subject disagreed says which assertion did.
		const reveals = [ui.panel(1), ui.panel(3)].join("\n");
		expect(reveals).toMatch(/\d\. ты — (да|нет) · судья — (да|нет)/);
	});

	it("refuses in one sentence when no judge graded anything", async () => {
		const fixture = evidence({ tasks: 3, noJudge: true });
		const ui = screenFixture([]);

		await expect(session(fixture, ui.screen, 3)).rejects.toThrow(NoJudgedEvidence);
		setLanguage("ru");
		expect(new NoJudgedEvidence().message).toBe("Судью проверять не на чем — в тестах нет judge-грейдеров");
		setLanguage("en");
		expect(new NoJudgedEvidence().message)
			.toBe("There is nothing to check the judge on — the tests have no judge graders");
		expect(ui.blocks).toHaveLength(0);
	});

	it("never asks twice about the same answer", async () => {
		const fixture = evidence({ tasks: 6 });
		const first = screenFixture(["good", "good", "stop"]);
		await session(fixture, first.screen, 2);
		const asked = first.blocks
			.filter((block) => block.lines.some((line) => stripMarkers(line).includes("what they asked")))
			.map((block) => stripMarkers(block.lines[0] ?? ""));
		expect(asked).toHaveLength(2);

		const second = screenFixture(["good", "good", "good", "good", "stop"]);
		await session(fixture, second.screen, 4);

		const askedAgain = second.blocks
			.filter((block) => block.lines.some((line) => stripMarkers(line).includes("what they asked")))
			.map((block) => stripMarkers(block.lines[0] ?? ""));
		// Four judged checks are left, and none of them is one already answered.
		expect(askedAgain).toHaveLength(4);
		for (const subject of asked) expect(askedAgain).not.toContain(subject);
		expect(readProjectJudgeLabels(fixture.stateRoot, fixture.projectId)).toHaveLength(6);

		// With nothing left, the exercise says so instead of asking again.
		const third = screenFixture([]);
		const result = await session(fixture, third.screen, 4);
		expect(result.total).toBe(0);
		expect(third.notices[0]?.message).toContain("already answered every judged case");
		expect(third.blocks.at(-1)?.title).toBe("AHDE · Judge checked");
	});

	it("picks the newest judged development run of this Target", () => {
		const older = evidence({ tasks: 2, evalRunId: "erun_older", startedAt: "2026-08-29T10:00:00.000Z" });
		const newer = evidence({
			tasks: 2,
			evalRunId: "erun_newer",
			runsRoot: older.runsRoot,
			stateRoot: older.stateRoot,
			startedAt: "2026-08-31T10:00:00.000Z",
		});
		// Newer still, but nothing a judge graded: not what the operator asked about.
		evidence({
			tasks: 2,
			noJudge: true,
			evalRunId: "erun_newest_unjudged",
			runsRoot: older.runsRoot,
			stateRoot: older.stateRoot,
			startedAt: "2026-09-01T10:00:00.000Z",
		});

		expect(newestJudgedEvalRun({
			runsRoot: older.runsRoot,
			stateRoot: older.stateRoot,
			projectId: older.projectId,
			targetId: older.targetId,
		})?.evalRunId).toBe(newer.evalRunId);
		// Another Target's evidence is never silently labelled as this one's.
		expect(newestJudgedEvalRun({
			runsRoot: older.runsRoot,
			stateRoot: older.stateRoot,
			projectId: older.projectId,
			targetId: "some-other-target",
		})).toBeNull();
	});

	it("renders the same exercise in English", async () => {
		setLanguage("en");
		const fixture = evidence({ tasks: 4 });
		const ui = screenFixture(["good", "bad", "stop"], ["the answer misses the question"]);

		await session(fixture, ui.screen, 4);

		expect(ui.blocks[0]?.title).toBe("AHDE · Judge 1/4");
		expect(ui.blocks.at(-1)?.title).toBe("AHDE · Judge checked");
		expect(ui.panel(0)).toContain("what they asked");
		expect(ui.panel(0)).toContain("the agent answered");
		expect(ui.panel(0)).toContain("the rubric the judge was given");
		expect(ui.selects[0]?.title).toBe("Your verdict — before you see the judge's");
		expect(ui.selects[0]?.choices).toEqual(["good", "bad", "skip", "stop"]);
		expect(ui.inputs[0]).toBe("What was wrong? (optional)");
		expect(ui.text()).toMatch(/the judge said: (good|bad) · (agrees with you|DISAGREES with you)/);
		expect(ui.panel(ui.blocks.length - 1)).toContain("agreement ");
	});

	it("keeps a skipped answer out of the labels and still reveals the judge", async () => {
		setLanguage("en");
		const fixture = evidence({ tasks: 4 });
		const ui = screenFixture(["skip", "good", "stop"]);

		const result = await session(fixture, ui.screen, 4);

		expect(result.skipped).toBe(1);
		expect(result.labelled).toBe(1);
		expect(readProjectJudgeLabels(fixture.stateRoot, fixture.projectId)).toHaveLength(1);
		expect(ui.panel(1)).toContain("the judge said: ");
		expect(ui.panel(1)).toContain("· skip");
		// A skipped subject is asked again next time; it was never answered.
		expect(ui.inputs).toHaveLength(0);
	});

	it("reads a dismissed dialog as leaving, not as a verdict", async () => {
		setLanguage("en");
		const fixture = evidence({ tasks: 4 });
		const ui = screenFixture([undefined]);

		const result = await session(fixture, ui.screen, 4);

		expect(result.labelled).toBe(0);
		expect(result.stopped).toBe(true);
		expect(readProjectJudgeLabels(fixture.stateRoot, fixture.projectId)).toHaveLength(0);
		expect(ui.notices.at(-1)?.message).toBe("Nothing was answered, so nothing was written.");
		// One subject panel and no reveal: leaving reveals nothing.
		expect(ui.blocks).toHaveLength(1);
	});
});

// ---------- the slash command ----------

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

function registerLabel(workbenchOverrides: Record<string, unknown> = {}): {
	command: CommandOptions;
	show: ReturnType<typeof vi.fn>;
	note: ReturnType<typeof vi.fn>;
} {
	const registered = new Map<string, CommandOptions>();
	const show = vi.fn();
	const note = vi.fn();
	const presenter: TranscriptPresenter = { show, note };
	const pi = {
		registerCommand(name: string, options: CommandOptions) {
			registered.set(name, options);
		},
	} as unknown as ExtensionAPI;
	registerAhdeBuilderCommands(pi, {
		workbench: {
			view: async () => ({
				stage: "ready-to-evaluate",
				target: { status: "ready", id: "test-target", gitSha: "a".repeat(40), model: null },
			}),
			decide: async () => {
				throw new Error("/label decides nothing");
			},
			projectDir: "/tmp/ahde-label",
			stateRoot: "/tmp/ahde-label-state",
			runsRoot: "/tmp/ahde-label-runs",
			projectId: "project",
			...workbenchOverrides,
		} as never,
		actorId: () => "local:test-operator",
		presenter,
	});
	const command = registered.get("label");
	if (!command) throw new Error("missing /label");
	return { command, show, note };
}

function labelContext(options: { mode?: "tui" | "print"; hasUI?: boolean; withoutSelect?: boolean } = {}): {
	ctx: ExtensionCommandContext;
	notify: ReturnType<typeof vi.fn>;
	select: ReturnType<typeof vi.fn>;
} {
	const notify = vi.fn();
	const select = vi.fn(async () => undefined);
	return {
		ctx: {
			hasUI: options.hasUI ?? true,
			mode: options.mode ?? "tui",
			waitForIdle: async () => undefined,
			ui: {
				notify,
				input: async () => undefined,
				...(options.withoutSelect ? {} : { select }),
			},
		} as unknown as ExtensionCommandContext,
		notify,
		select,
	};
}

describe("/label as a Builder command", () => {
	it("is registered, documented, and last in the public order", () => {
		expect([...AHDE_BUILDER_COMMAND_NAMES]).toContain("label");
		const { command } = registerLabel();
		expect(command.description).toContain("judge");
		expect(command.description).toContain(String(MAX_LABEL_SAMPLE));
		expect(DEFAULT_LABEL_SAMPLE).toBe(20);
	});

	it("takes the sample size and rejects anything else before touching the host", async () => {
		const { command, show } = registerLabel();
		const host = labelContext();
		for (const bad of ["twenty", "3 more", "-1", "999"]) {
			// The refusal is a panel in the transcript, never Pi's raw
			// `Extension "command:label" error:` with a stack under it.
			await command.handler(bad, host.ctx);
			expect(show).toHaveBeenLastCalledWith(host.ctx, expect.objectContaining({
				title: "AHDE · /label",
				lines: [expect.stringContaining("/label takes how many answers to grade")],
			}));
		}
		expect(host.select).not.toHaveBeenCalled();
	});

	it("fails closed outside the local TUI", async () => {
		const { command } = registerLabel();
		for (const settings of [
			{ hasUI: false, mode: "print" as const },
			{ hasUI: false, mode: "tui" as const },
		]) {
			const host = labelContext(settings);
			await expect(command.handler("3", host.ctx)).rejects.toThrow("/label works only in the Builder window");
			expect(host.notify).not.toHaveBeenCalled();
		}
	});

	it("refuses a host that cannot ask a question, and one with no judged evidence", async () => {
		const withoutSelect = registerLabel();
		const selectless = labelContext({ withoutSelect: true });
		await withoutSelect.command.handler("", selectless.ctx);
		expect(withoutSelect.show).toHaveBeenLastCalledWith(selectless.ctx, expect.objectContaining({
			lines: [expect.stringContaining("/label needs a window that can ask you questions")],
		}));

		setLanguage("ru");
		const fixture = evidence({ tasks: 2, noJudge: true });
		const { command, show, note } = registerLabel({
			runsRoot: fixture.runsRoot,
			stateRoot: fixture.stateRoot,
			projectDir: fixture.runsRoot,
			projectId: fixture.projectId,
		});
		const host = labelContext();
		await command.handler("", host.ctx);
		// A refusal, not a fault: one sentence and nothing else happens.
		expect(host.notify).toHaveBeenCalledWith("Судью проверять не на чем — в тестах нет judge-грейдеров", "info");
		expect(show).not.toHaveBeenCalled();
		expect(note).not.toHaveBeenCalled();
	});

	it("/label 3 draws three, and tells the Builder the number without the answers", async () => {
		setLanguage("en");
		const fixture = evidence({ tasks: 8 });
		const { command, show, note } = registerLabel({
			runsRoot: fixture.runsRoot,
			stateRoot: fixture.stateRoot,
			projectDir: fixture.runsRoot,
			projectId: fixture.projectId,
		});
		const answers = ["good", "good", "bad"];
		const host = labelContext();
		const select = vi.fn(async () => answers.shift());
		const input = vi.fn(async () => "kept private");
		(host.ctx as unknown as { ui: Record<string, unknown> }).ui = {
			notify: host.notify,
			select,
			input,
		};

		await command.handler("3", host.ctx);

		const titles = show.mock.calls.map((call) => (call[1] as { title: string }).title);
		expect(titles.filter((title) => title === "AHDE · Judge 1/3")).toHaveLength(2);
		expect(titles).toContain("AHDE · Judge 3/3");
		expect(titles.at(-1)).toBe("AHDE · Judge checked");
		expect(readProjectJudgeLabels(fixture.stateRoot, fixture.projectId)).toHaveLength(3);

		// The Builder is told the number and told to stop offering; it is never
		// handed a single label, a case id, or the operator's note.
		const [text, options] = note.mock.calls[0] as [string, { label?: string }];
		expect(text).toContain("/label");
		expect(text).toContain(fixture.evalRunId);
		expect(text).toContain("3 answer(s) graded blind");
		expect(text).toMatch(/judge agreement now \d+% over 3 independent subject\(s\)/);
		expect(text).toContain("Do not offer the judge check again");
		expect(text).not.toContain("kept private");
		expect(options.label).toBe("Judge checked");
	});
});
