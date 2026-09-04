import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RunRow } from "../src/application/run-explanation.js";
import {
	AHDE_BUILDER_COMMAND_NAMES,
	registerAhdeBuilderCommands,
	resolveTraceTarget,
} from "../src/builder/commands.js";
import { stripMarkers } from "../src/builder/render/markers.js";
import { plainPaint } from "../src/builder/render/paint.js";
import {
	MAX_TRACE_PANEL_LINES,
	renderRunsTable,
	renderTracePanel,
	traceNoteForModel,
} from "../src/builder/render/trace.js";
import type { TranscriptPresenter, TranscriptTone } from "../src/builder/transcript.js";
import { EvidenceNotFound } from "../src/evidence/model.js";
import type { EvalPageModel, RunDetailPageModel } from "../src/evidence/pages.js";
import type { CorpusMetadata } from "../src/corpus.js";
import type { EvalRunRecord } from "../src/eval.js";
import type { WorkbenchInventory } from "../src/workbench/inventory.js";
import { WorkbenchSelectionRequiredError } from "../src/workbench/errors.js";
import {
	compatibleDevelopmentEvals,
	evaluationProjection,
	readableDevelopmentEvals,
	requireReadableDevelopmentEval,
} from "../src/workbench/resolution.js";

type Registered = { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
type Options = Parameters<typeof registerAhdeBuilderCommands>[1];

function row(over: Partial<RunRow> & Pick<RunRow, "runId" | "taskId" | "outcome">): RunRow {
	const passed = over.outcome === "pass";
	return {
		repetitionIndex: 0,
		score: passed ? 1 : 0,
		inputPreview: "Обращение: проверь договор №42 и ограничения ДБО по нему.",
		graders: [{ type: "tool_called", passed, chip: passed ? "✓" : "✗", name: "tool check_dbo" }],
		failureModeIds: passed ? [] : ["failure-mode-aaaaaaaaaaaaaaaaaaaaaaaa"],
		error: null,
		metrics: { latencyMs: 1234, toolCalls: passed ? 1 : 0, toolErrors: 0, tokens: 512, costUsd: 0.0012 },
		traceAvailable: true,
		...over,
	};
}

const rows: RunRow[] = [
	row({ runId: "run_fail1", taskId: "task_006", outcome: "fail" }),
	row({ runId: "run_fail2", taskId: "task_009", outcome: "fail", repetitionIndex: 1 }),
	row({ runId: "run_pass1", taskId: "task_001", outcome: "pass" }),
];

const page = {
	evalRunId: "erun_1",
	rows,
	modes: [{
		id: "failure-mode-aaaaaaaaaaaaaaaaaaaaaaaa",
		title: "Required tool check failed across tasks",
		scope: "systemic",
		severity: "major",
		decision: "propose-harness-change",
		hypothesis: "The same deterministic grader predicate was unsatisfied in the cited runs.",
		affectedTasks: 2,
		totalTasks: 3,
		reproductionBps: 6700,
		runCount: 2,
		href: "/evals/erun_1?mode=failure-mode-aaaaaaaaaaaaaaaaaaaaaaaa",
	}],
} as unknown as EvalPageModel;

function detail(runId: string, taskId: string, repetitionIndex: number, outcome: RunRow["outcome"]): RunDetailPageModel {
	return {
		evalRunId: "erun_1",
		targetId: "ombudsman",
		revision: "4d533f0703",
		label: "baseline",
		run: {
			runId,
			taskId,
			repetitionIndex,
			outcome,
			status: "completed",
			startedAt: "2026-09-01T09:00:00.000Z",
			finishedAt: "2026-09-01T09:00:07.000Z",
			error: null,
			metrics: { latencyMs: 7100, toolCalls: 0, toolErrors: 0, tokens: 640, costUsd: 0.0015 },
		},
		input: "Обращение: проверь договор №42 и ограничения ДБО по нему.",
		transcript: {
			entries: [
				{ kind: "user", text: "Обращение: проверь договор №42 и ограничения ДБО по нему.", at: null },
				{ kind: "assistant", text: "К сожалению, у меня нет доступа к банковской базе, поэтому проверить договор не могу.", thinking: null, at: null, final: true },
			],
			truncated: false,
			omittedCount: 0,
		},
		traceNotice: "",
		graders: [{
			name: `${taskId}#${repetitionIndex}:tool_called`,
			type: "tool_called",
			checkCode: null,
			passed: outcome === "pass",
			score: outcome === "pass" ? 1 : 0,
			reason: "tool bash with check_dbo was never called",
			assertions: null,
			assertionVerdicts: null,
			choice: null,
			jury: null,
			chip: outcome === "pass" ? "✓" : "✗",
		}],
		explanation: {
			runId,
			taskId,
			repetitionIndex,
			outcome,
			headline: `${taskId} repetition ${repetitionIndex} failed: 1 of 1 grader(s) did not pass.`,
			graders: [],
			failureModes: [],
			flip: null,
			sentences: [
				`${taskId} repetition ${repetitionIndex} failed: 1 of 1 grader(s) did not pass.`,
				"expected a call to `bash` with arguments containing `check_dbo`; the agent made 0 tool call(s).",
				"Hypothesis, not proof: the same deterministic grader predicate was unsatisfied in the cited runs.",
			],
		},
		prev: null,
		next: { runId: "run_fail2", taskId: "task_009", repetitionIndex: 1 },
	} as unknown as RunDetailPageModel;
}

function harness(evidence: NonNullable<Options["evidence"]>, view?: () => Promise<unknown>) {
	const registered = new Map<string, Registered>();
	const pi = {
		registerCommand(name: string, options: Registered) {
			registered.set(name, options);
		},
	} as unknown as ExtensionAPI;
	const blocks: Array<{ title: string; tone: TranscriptTone; lines: string[] }> = [];
	const notes: Array<{ text: string; options: { triggerTurn?: boolean } | undefined }> = [];
	const presenter: TranscriptPresenter = {
		show: (_ctx, block) => {
			blocks.push({ title: block.title, tone: block.tone ?? "info", lines: block.lines });
		},
		note: (text, options) => {
			notes.push({ text, options });
		},
	};
	const tracesView = {
		stage: "improvement-authoring",
		headline: "Diagnosis ready",
		blockers: [],
		detail: { aspect: "traces", content: { evaluation: { evalRunId: "erun_1", repetitions: 2 } } },
	};
	const workbench = {
		view: view ?? vi.fn(async () => tracesView),
		decide: vi.fn(),
		projectDir: "/tmp/agent",
		stateRoot: "/tmp/agent/.ahde",
		runsRoot: "/tmp/agent/runs",
		projectId: "demo",
	} as unknown as Options["workbench"];
	registerAhdeBuilderCommands(pi, { workbench, actorId: () => "local:test", presenter, evidence });
	const notify = vi.fn();
	const ctx = {
		hasUI: true,
		mode: "tui",
		waitForIdle: async () => undefined,
		model: { provider: "anthropic", id: "claude-sonnet-4" },
		modelRegistry: { hasConfiguredAuth: () => true },
		ui: { confirm: async () => false, notify, setStatus: vi.fn(), setWidget: vi.fn(), input: async () => undefined, select: async () => undefined },
	} as unknown as ExtensionCommandContext;
	const command = (name: string): Registered => {
		const found = registered.get(name);
		if (!found) throw new Error(`command ${name} is not registered`);
		return found;
	};
	return { command, blocks, notes, ctx, notify, text: () => blocks.flatMap((block) => block.lines).map(stripMarkers).join("\n") };
}

describe("traces in the TUI", () => {
	it("registers /trace beside the other read-only inspections", () => {
		const names = [...AHDE_BUILDER_COMMAND_NAMES];
		expect(names).toContain("trace");
		// One run is where the runs table sends you, so it is the next line of
		// `/help` and the next name in the public list.
		expect(names.indexOf("trace")).toBe(names.indexOf("traces") + 1);
	});

	it("renders the runs table failures first, width-bounded, with the failure mode named", () => {
		const lines = renderRunsTable(rows, page.modes, plainPaint, { limit: 2 }).map(stripMarkers);
		expect(lines[0]).toMatch(/^#\s+task\s+rep\s+outcome\s+score\s+graders\s+failure mode\s+tools\s+latency$/);
		expect(lines[1]).toContain("task_006");
		expect(lines[1]).toContain("fail");
		expect(lines[1]).toContain("✗tool check_dbo");
		expect(lines[1]).toContain("Required tool check fa");
		expect(lines[2]).toContain("task_009");
		expect(lines.some((line) => line.includes("… 1 more rows · /traces 3 shows more"))).toBe(true);
		expect(lines.at(-1)).toContain("/trace 1");
		for (const line of lines) expect([...line].length).toBeLessThanOrEqual(110);
	});

	it("renders one run: the host's Why, every verdict, the conversation, and where to walk next", () => {
		const lines = renderTracePanel(detail("run_fail1", "task_006", 0, "fail"), plainPaint).map(stripMarkers);
		const text = lines.join("\n");
		expect(lines[0]).toContain("Run task_006#0 · fail · score 0% · 7.1s · 0 tool call(s) · run_fail1");
		expect(text).toContain("Why");
		expect(text).toContain("expected a call to `bash` with arguments containing `check_dbo`");
		expect(text).toContain("Hypothesis, not proof");
		expect(text).toContain("Verdict");
		expect(text).toContain("✗ task_006#0:tool_called (tool_called) — tool bash with check_dbo was never called");
		expect(text).toContain("Conversation");
		expect(text).toContain("Обращение: проверь договор №42");
		expect(text).toContain("agent · final answer");
		expect(text).toContain("нет доступа к банковской базе");
		expect(lines.at(-1)).toContain("/trace next → task_009#1");
		expect(lines.at(-1)).toContain("explorer /runs/run_fail1");
		expect(lines.length).toBeLessThanOrEqual(MAX_TRACE_PANEL_LINES);
		for (const line of lines) expect([...line].length).toBeLessThanOrEqual(120);
	});

	/**
	 * A worlded case is graded on what the world holds afterwards, so a trace
	 * that shows only the conversation shows half the evidence. Session 7 opened
	 * the trace of a worlded case and found neither state on the screen.
	 */
	it("prints the world before and after, as two short lines under the run", () => {
		const lines = renderTracePanel(detail("run_fail1", "task_006", 0, "fail"), plainPaint, {
			world: {
				before: '{"accounts":{"42":{"status":"ok"}}}',
				after: { accounts: { "42": { status: "frozen" } } },
			},
		}).map(stripMarkers);
		expect(lines[1]).toBe('World before {"accounts":{"42":{"status":"ok"}}}');
		expect(lines[2]).toBe('World after {"accounts":{"42":{"status":"frozen"}}}');
		// Everything the panel said before still comes after them, in order.
		expect(lines[0]).toContain("Run task_006#0");
		expect(lines.join("\n")).toContain("Why");
	});

	it("says a world it cannot read is unread, and never invents an empty one", () => {
		const unreadable = renderTracePanel(detail("run_fail1", "task_006", 0, "fail"), plainPaint, {
			world: { before: '{"accounts":{}}', after: null, unreadable: true },
		}).map(stripMarkers);
		expect(unreadable[2]).toBe("World after could not be read");
		// A run that wrote no world file at all: a dash, not an empty object.
		const absent = renderTracePanel(detail("run_fail1", "task_006", 0, "fail"), plainPaint, {
			world: { before: '{"accounts":{}}', after: null },
		}).map(stripMarkers);
		expect(absent[2]).toBe("World after —");
	});

	it("keeps a worldless case exactly as it renders today", () => {
		const lines = renderTracePanel(detail("run_fail1", "task_006", 0, "fail"), plainPaint).map(stripMarkers);
		expect(lines.join("\n")).not.toContain("World before");
		expect(lines.join("\n")).not.toContain("World after");
	});

	/**
	 * Session 7, defects 2 and 6. The panel of a timed-out run printed the raw
	 * stem and nothing else, and the receipt beside it was three `null`s and a
	 * missing `usage` key on a case whose world the tool had answered from.
	 */
	it("reads an errored run from its error and prints a receipt that says what is true", () => {
		const model = detail("run_err", "task_004", 0, "error");
		const errored = {
			...model,
			run: { ...model.run, status: "error", error: "run timed out after 300000ms" },
			explanation: {
				...model.explanation,
				outcome: "error",
				error: {
					code: "timeout",
					sentence: "the agent did not answer within 300s — the model timed out",
					detail: "run timed out after 300000ms",
				},
			},
			receipt: {
				worldKeys: 3,
				judge: null,
				simulatedUser: null,
				tokens: null,
				costUsd: null,
				incomplete: true,
			},
		} as unknown as RunDetailPageModel;
		const text = renderTracePanel(errored, plainPaint).map(stripMarkers).join("\n");
		expect(text).toContain("Error the agent did not answer within 300s — the model timed out run timed out after 300000ms");
		// Each of the four is its own statement, and none of them is "null".
		expect(text).toContain("Receipt world: yes (3 keys)");
		expect(text).toContain("judge: never ran — the run failed");
		expect(text).toContain("user model: never ran — the run failed");
		expect(text).toContain("tokens: not reported");
	});

	it("says what an instrument actually spent on a run that finished", () => {
		const model = detail("run_ok", "task_004", 0, "pass");
		const spent = {
			...model,
			receipt: {
				worldKeys: null,
				judge: { calls: 2, costUsd: 0 },
				simulatedUser: { calls: 5, costUsd: 0.01 },
				tokens: 640,
				costUsd: 0.0015,
				incomplete: false,
			},
		} as unknown as RunDetailPageModel;
		const text = renderTracePanel(spent, plainPaint).map(stripMarkers).join("\n");
		expect(text).toContain("Receipt world: none · judge: 2 calls, $0.00 · user model: 5 calls, $0.01 · tokens: 640, $0.00");
	});

	it("tells the Builder what ended an errored run and forbids reading a cause off the trace", () => {
		const model = detail("run_err", "task_004", 0, "error");
		const note = traceNoteForModel({
			...model,
			run: { ...model.run, status: "error", error: "run timed out after 300000ms" },
			explanation: {
				...model.explanation,
				error: {
					code: "timeout",
					sentence: "the agent did not answer within 300s — the model timed out",
					detail: "run timed out after 300000ms",
				},
			},
		} as unknown as RunDetailPageModel);
		expect(note).toContain("The run recorded this error, and it is the ONLY statement about why it ended: run timed out after 300000ms");
		expect(note).toContain("Never infer a cause from its shape");
		expect(note).toContain("stabilize the path and run again, never a harness change");
		expect(note).not.toContain("Call it your hypothesis");
	});

	it("tells the Builder the facts and asks for its own hypothesis, within the note bound", () => {
		const note = traceNoteForModel(detail("run_fail1", "task_006", 0, "fail"));
		expect(note).toContain("Operator opened /trace for run run_fail1 — task_006#0, fail");
		expect(note).toContain("Host facts");
		expect(note).toContain("the agent made 0 tool call(s)");
		expect(note).toContain("Graders: task_006#0:tool_called=fail");
		expect(note).toContain("Case input: Обращение");
		expect(note).toContain("Agent's answer:");
		expect(note).toContain("Call it your hypothesis");
		expect(note.length).toBeLessThanOrEqual(3_800);
	});

	it("resolves rows, next/prev from the cursor, task ids and run ids", () => {
		expect(resolveTraceTarget("", rows, null)).toMatchObject({ index: 0 });
		expect(resolveTraceTarget("next", rows, 0)).toMatchObject({ index: 1 });
		expect(resolveTraceTarget("next", rows, 2)).toBe("end");
		expect(resolveTraceTarget("prev", rows, 0)).toBe("end");
		expect(resolveTraceTarget("prev", rows, 2)).toMatchObject({ index: 1 });
		expect(resolveTraceTarget("2", rows, null)).toMatchObject({ index: 1 });
		expect(resolveTraceTarget("task_001", rows, null)).toMatchObject({ index: 2 });
		expect(resolveTraceTarget("task_009#1", rows, null)).toMatchObject({ index: 1 });
		expect(resolveTraceTarget("run_pass1", rows, null)).toMatchObject({ index: 2 });
		expect(() => resolveTraceTarget("9", rows, null)).toThrow(/the table has 3 rows/);
		expect(() => resolveTraceTarget("nonsense", rows, null)).toThrow(/takes a row number/);
	});

	it("/trace opens a run as a panel and hands the Builder the facts with a turn", async () => {
		const runDetail = vi.fn((_root: string, runId: string) => {
			const found = rows.find((candidate) => candidate.runId === runId)!;
			return detail(found.runId, found.taskId, found.repetitionIndex, found.outcome);
		});
		const h = harness({ evalPage: () => page, runDetail });
		await h.command("trace").handler("1", h.ctx);
		expect(h.blocks.map((block) => [block.title, block.tone])).toEqual([["AHDE · Trace task_006#0", "warning"]]);
		expect(h.text()).toContain("Why");
		expect(h.notes).toHaveLength(1);
		// The injection is visible: the operator reads one dim line naming what
		// the Builder was just handed.
		expect(h.notes[0]!.options).toEqual({
			triggerTurn: true,
			label: "Builder received: the trace of task_006#0",
		});
		expect(h.notes[0]!.text).toContain("task_006#0");

		await h.command("trace").handler("next", h.ctx);
		expect(runDetail.mock.calls.map(([, runId]) => runId)).toEqual(["run_fail1", "run_fail2"]);
		await h.command("trace").handler("prev", h.ctx);
		expect(runDetail.mock.calls.at(-1)?.[1]).toBe("run_fail1");
		await h.command("trace").handler("prev", h.ctx);
		expect(h.notify).toHaveBeenCalledWith("No more runs in that direction.", "info");
		// A mistyped argument is a panel in the transcript, not Pi's raw
		// `Extension "command:trace" error:` with a stack under it.
		await h.command("trace").handler("what", h.ctx);
		expect(h.blocks.at(-1)?.title).toBe("AHDE · /trace");
		expect(stripMarkers(h.blocks.at(-1)!.lines.join("\n"))).toMatch(/takes a row number/);
	});

	it("refuses a run the Explorer refuses, without a note to the Builder", async () => {
		const h = harness({
			evalPage: () => page,
			runDetail: () => {
				throw new EvidenceNotFound("run run_fail1 does not name an eval run");
			},
		});
		await h.command("trace").handler("1", h.ctx);
		expect(h.blocks.map((block) => [block.title, block.tone])).toEqual([["AHDE · Trace", "warning"]]);
		expect(h.text()).toContain("This run cannot be opened here: run run_fail1 does not name an eval run");
		expect(h.notes).toHaveLength(0);
	});
});

/**
 * Reading evidence is not deciding on it. A commit in the Target — and the
 * Builder asks for one before it opens a workshop — used to make every past
 * run "incompatible", so `/traces` and `/trace` died on the run the operator
 * had just watched finish.
 */
describe("traces resolve as history", () => {
	const lineage = {
		publication: { approvedSpecId: "spec-1", draftId: "draft-1" },
		datasetHash: "sha256:dataset",
		currentSuiteHash: "sha256:suite",
		currentTargetGitSha: "b".repeat(40),
	};

	function evalRun(id: string, over: Partial<EvalRunRecord> = {}): EvalRunRecord {
		return {
			evalRunId: id,
			target: { id: "ombudsman", gitSha: "a".repeat(40) },
			datasetHash: "sha256:dataset",
			suiteHash: "sha256:suite",
			repetitions: 3,
			startedAt: `2026-09-01T09:0${id.at(-1)}:00.000Z`,
			finishedAt: `2026-09-01T09:0${id.at(-1)}:07.000Z`,
			summary: { total: 18, pass: 4, fail: 14, error: 0, allPassRate: 4 / 18 },
			...over,
		} as EvalRunRecord;
	}

	// Newest first, exactly as the inventory hands them over.
	function inventory(runs: readonly EvalRunRecord[], focusEvalRunId?: string): WorkbenchInventory {
		return {
			target: { manifest: { id: "ombudsman" } },
			specs: [{ id: "spec-1", status: "approved" }],
			verifiedApprovedSpecIds: new Set(["spec-1"]),
			corpora: [{ id: "corpus-1", name: "Ombudsman basket", visibility: "development", taskCount: 6, hash: "sha256:dataset" }],
			developmentLineage: new Map([["corpus-1", lineage]]),
			developmentEvals: [...runs],
			validFocus: focusEvalRunId ? { "eval-run": { id: focusEvalRunId } } : {},
		} as unknown as WorkbenchInventory;
	}

	it("keeps the last run readable after the Target revision moves, and after it errored", () => {
		const newest = evalRun("erun_2", { summary: { total: 18, pass: 0, fail: 15, error: 3, allPassRate: 0 } as EvalRunRecord["summary"] });
		const state = inventory([newest, evalRun("erun_1")]);

		// The strict set — what a proposal must be argued from — stays empty.
		expect(compatibleDevelopmentEvals(state)).toEqual([]);
		expect(readableDevelopmentEvals(state).map((run) => run.evalRunId)).toEqual(["erun_2", "erun_1"]);
		expect(requireReadableDevelopmentEval(state).evalRunId).toBe("erun_2");
	});

	it("prefers the named run, then the focused one, and says so when there is none", () => {
		const state = inventory([evalRun("erun_2"), evalRun("erun_1")], "erun_1");
		expect(requireReadableDevelopmentEval(state).evalRunId).toBe("erun_1");
		expect(requireReadableDevelopmentEval(state, "erun_2").evalRunId).toBe("erun_2");
		expect(() => requireReadableDevelopmentEval(state, "erun_9")).toThrow(WorkbenchSelectionRequiredError);
		expect(() => requireReadableDevelopmentEval(inventory([]))).toThrow(/No compatible development EvalRun/);
	});

	it("never reads a run of another basket than the approved Spec published", () => {
		const foreign = evalRun("erun_3", { datasetHash: "sha256:other" });
		expect(readableDevelopmentEvals(inventory([foreign])).map((run) => run.evalRunId)).toEqual([]);
	});

	it("names the run it shows: id, when, revision, basket", () => {
		const projection = evaluationProjection(evalRun("erun_2"), [
			{ id: "corpus-1", name: "Ombudsman basket", visibility: "development", taskCount: 6, hash: "sha256:dataset" },
		] as unknown as CorpusMetadata[]);
		expect(projection).toMatchObject({
			evalRunId: "erun_2",
			finishedAt: "2026-09-01T09:02:07.000Z",
			targetGitSha: "a".repeat(40),
			corpus: { name: "Ombudsman basket", taskCount: 6 },
		});
	});

	it("shows a calm panel instead of a raw refusal when nothing has been run yet", async () => {
		const h = harness(
			{ evalPage: () => page, runDetail: () => detail("run_fail1", "task_006", 0, "fail") },
			async () => {
				throw new WorkbenchSelectionRequiredError("development EvalRun", []);
			},
		);
		for (const name of ["traces", "trace"]) await h.command(name).handler("", h.ctx);
		expect(h.blocks.map((block) => [block.title, block.tone])).toEqual([
			["AHDE · Runs", "info"],
			["AHDE · Runs", "info"],
		]);
		expect(h.text()).toContain("No runs yet — say “test” and I will run the basket.");
		expect(h.notes).toHaveLength(0);
	});
});
