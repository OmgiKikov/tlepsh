import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	candidateFlip,
	classifyRunError,
	explainRun,
	graderFindings,
	renderRunExplanationText,
	runErrorReading,
	runReceipt,
	runTranscript,
	runsTable,
	traceFacts,
	type GraderFinding,
	type RunErrorClass,
} from "../src/application/run-explanation.js";
import { compileImprovementBrief } from "../src/application/improvement-brief.js";
import { diagnoseEvalRun } from "../src/diagnosis.js";
import { parseSessionJsonl } from "../src/trace.js";
import {
	RunRecordSchema,
	executionFingerprint,
	hashFile,
	hashValue,
	modelFingerprint,
	provenanceAxes,
	provenanceKey,
	type GraderResult,
	type RunRecord,
} from "../src/provenance.js";
import { writeEvalRun, type EvalRunRecord } from "../src/eval.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";

/**
 * The one place a run is turned into words.
 *
 * These tests pin the wording per grader type, because the whole point of the
 * module is that three surfaces — the web table, the static report, and the
 * Builder TUI — cannot describe the same failure differently.
 */

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
	const created = mkdtempSync(join(tmpdir(), "ahde-explain-"));
	roots.push(created);
	return created;
}

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

const TRACE_LINES = [
	JSON.stringify({
		type: "message",
		message: { role: "user", content: "Обращение: проверь договор №42.", timestamp: 1_000 },
	}),
	JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "внутренние рассуждения" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "spec.md" } },
			],
			timestamp: 1_200,
		},
	}),
	JSON.stringify({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			isError: false,
			content: "договор найден",
			timestamp: 1_900,
		},
	}),
	JSON.stringify({
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: "Итог: жалоба принята." }], timestamp: 2_000 },
	}),
];

function writeRun(
	runsRoot: string,
	options: {
		runId: string;
		taskId?: string;
		repetitionIndex?: number;
		graders: GraderResult[];
		trace?: boolean;
		status?: "completed" | "error";
		error?: string;
		toolCalls?: number;
		evalRunId?: string;
	},
): RunRecord {
	const runDir = join(runsRoot, options.runId);
	mkdirSync(runDir, { recursive: true });
	let traceSha: string | null = null;
	if (options.trace !== false) {
		const content = `${TRACE_LINES.join("\n")}\n`;
		writeFileSync(join(runDir, "session.jsonl"), content);
		traceSha = hashFile(content);
	}
	const status = options.status ?? "completed";
	const record = RunRecordSchema.parse({
		schemaVersion: 1,
		runId: options.runId,
		taskId: options.taskId ?? "task-1",
		repetitionIndex: options.repetitionIndex ?? 0,
		label: "solo",
		status,
		error: status === "error" ? (options.error ?? "sandbox exploded") : null,
		startedAt: "2026-08-30T10:00:00.000Z",
		finishedAt: "2026-08-30T10:00:01.000Z",
		target: { id: "target", gitSha: "a".repeat(40) },
		runtime,
		model,
		execution,
		eval: evaluation,
		trace: { path: "session.jsonl", sessionId: null, sha256: traceSha },
		metrics: {
			tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
			costUsd: 0.001,
			latencyMs: 1_500,
			toolCalls: options.toolCalls ?? 1,
			toolErrors: 0,
			recoveryAttempts: 0,
		},
		evalResults: status === "error"
			? null
			: {
				outcome: options.graders.every((grader) => grader.passed) ? "pass" : "fail",
				graders: options.graders,
			},
		parent: { evalRunId: options.evalRunId ?? "erun_fixture", candidateOf: null },
	});
	writeJsonArtifact(join(runDir, "run.json"), RunRecordSchema, record);
	return record;
}

function findings(runsRoot: string, run: RunRecord): GraderFinding[] {
	return graderFindings(runsRoot, run, { includeJudgeVerdicts: true });
}

function explain(runsRoot: string, run: RunRecord): string[] {
	const messages = run.trace.sha256 ? parseSessionJsonl(`${TRACE_LINES.join("\n")}\n`) : null;
	return renderRunExplanationText(explainRun({
		run,
		graders: findings(runsRoot, run),
		facts: messages ? traceFacts(messages) : null,
		modes: [],
		flip: null,
	}));
}

describe("the host's plain-language account of one run", () => {
	it("names the expected tool and what the agent did instead", () => {
		const runsRoot = root();
		const run = writeRun(runsRoot, {
			runId: "run-tool",
			toolCalls: 0,
			graders: [{
				name: "task-1#0:tool_called:bash(check_dbo)",
				type: "tool_called",
				checkCode: "required-tool",
				specHash: `sha256:${"1".repeat(64)}`,
				passed: false,
				score: 0,
				reason: 'never called bash with args containing "check_dbo"',
			}],
		});
		// The trace records one `read` call; the run's own metric says none. Both are
		// facts, and the sentence quotes the trace because that is the evidence.
		const lines = explain(runsRoot, run);
		expect(lines[0]).toBe("task-1 repetition 0 failed: 1 of 1 grader(s) did not pass.");
		expect(lines[1]).toBe(
			"task-1#0:tool_called:bash(check_dbo) (tool_called) expected a call to `bash` with arguments containing `check_dbo`; " +
			"the agent made 1 tool call(s), to read.",
		);
		expect(lines[2]).toBe('The grader recorded: “never called bash with args containing "check_dbo"”.');
	});

	it("says the agent answered directly when it called nothing at all", () => {
		const runsRoot = root();
		const run = writeRun(runsRoot, {
			runId: "run-no-tool",
			trace: false,
			toolCalls: 0,
			graders: [{
				name: "needs-tool",
				type: "tool_called",
				checkCode: "required-tool",
				specHash: `sha256:${"1".repeat(64)}`,
				passed: false,
				score: 0,
				reason: "never called check_dbo",
			}],
		});
		expect(explain(runsRoot, run)[1]).toBe(
			"needs-tool (tool_called) expected a call to `check_dbo`; the agent made 0 tool calls and answered directly.",
		);
	});

	it("names the missing text, pattern, reference answer, threshold, and turn budget", () => {
		const runsRoot = root();
		const cases: Array<[GraderResult, string]> = [
			[{
				name: "contains",
				type: "output_contains",
				checkCode: "output-contains",
				specHash: `sha256:${"2".repeat(64)}`,
				passed: false,
				score: 0,
				reason: 'output does not contain "договор"',
			}, "contains (output_contains) expected the final answer to contain `договор`; the recorded final answer (21 characters) does not contain it."],
			[{
				name: "matches",
				type: "output_matches",
				checkCode: "output-matches",
				specHash: `sha256:${"3".repeat(64)}`,
				passed: false,
				score: 0,
				reason: "output does not match /^ИТОГ/",
			}, "matches (output_matches) expected the final answer to match `/^ИТОГ/`; the recorded final answer (21 characters) does not match it."],
			[{
				name: "exact",
				type: "exact",
				checkCode: "reference-exact",
				specHash: `sha256:${"4".repeat(64)}`,
				passed: false,
				score: 0,
				reason: "output differs from the expected answer (normalize: lower)",
			}, "exact (exact) expected the final answer to equal the case's reference answer; the recorded final answer (21 characters) differs from it."],
			[{
				name: "similar",
				type: "similarity",
				checkCode: "reference-similarity",
				specHash: `sha256:${"5".repeat(64)}`,
				passed: false,
				score: 0.3,
				reason: "token-f1 = 0.3, below threshold 0.8",
			}, "similar (similarity) expected token-f1 against the reference answer to reach 0.8; it reached 0.3."],
			[{
				name: "turns",
				type: "turn_budget",
				checkCode: "turn-budget",
				specHash: `sha256:${"6".repeat(64)}`,
				passed: false,
				score: 0,
				reason: "agent took 7 turn(s), over the budget of 3",
			}, "turns (turn_budget) expected at most 3 agent turn(s); the agent took 7."],
		];
		for (const [grader, expected] of cases) {
			const run = writeRun(runsRoot, { runId: `run-${grader.name}`, graders: [grader] });
			expect(explain(runsRoot, run)[1]).toBe(expected);
		}
	});

	it("says what the world had to look like, and never quotes the answer about it", () => {
		const runsRoot = root();
		const cases: [{ reason: string }, string][] = [
			[{
				reason: 'world at accounts.42.status is "open", expected "frozen"',
			}, 'world (world_state) expected the world at `accounts.42.status` to be `"frozen"`; it is `"open"`.'],
			[{
				reason: "world at accounts.42.frozenAt is not set",
			}, "world (world_state) expected the conversation to set the world at `accounts.42.frozenAt`; the conversation left it unset."],
			[{
				reason: 'world at log is not set, expected contains "closed"',
			}, 'world (world_state) expected the world at `log` to contains `"closed"`; the conversation left it unset.'],
			[{
				reason: 'world at log does not contain "closed"',
			}, 'world (world_state) expected the world at `log` to contain `"closed"`; it does not.'],
			[{
				reason: 'world at count is 3, which cannot contain "x"',
			}, 'world (world_state) expected the world at `count` to contain `"x"`; it is `3`, which contains nothing.'],
			[{
				reason: "case declares no world",
			}, "world (world_state) expected the case to declare the world this check is about; it declares none, so the check could not pass."],
		];
		for (const [index, [extra, expected]] of cases.entries()) {
			const run = writeRun(runsRoot, {
				runId: `run-world-${index}`,
				graders: [{
					name: "world",
					type: "world_state",
					checkCode: "world-state",
					specHash: `sha256:${"8".repeat(64)}`,
					passed: false,
					score: 0,
					...extra,
				}],
			});
			expect(explain(runsRoot, run)[1], extra.reason).toBe(expected);
		}
	});

	it("quotes an unfamiliar grader reason instead of guessing what it wanted", () => {
		const runsRoot = root();
		const run = writeRun(runsRoot, {
			runId: "run-unknown",
			graders: [{
				name: "bespoke",
				type: "output_contains",
				checkCode: "output-contains",
				specHash: `sha256:${"7".repeat(64)}`,
				passed: false,
				score: 0,
				reason: "the bespoke predicate said no",
			}],
		});
		const lines = explain(runsRoot, run);
		expect(lines[1]).toBe("bespoke (output_contains): the bespoke predicate said no.");
		expect(lines[2]).toBe("The grader recorded: “the bespoke predicate said no”.");
	});

	it("reports a judge's assertions, its evidence, and its jury from the verdict sidecar", () => {
		const runsRoot = root();
		const grader: GraderResult = {
			name: "rubric",
			type: "judge",
			checkCode: "semantic-rubric",
			specHash: `sha256:${"8".repeat(64)}`,
			passed: false,
			score: 0.5,
			reason: "assertion 2 failed (1/3 yes): не назван срок",
			assertions: { total: 4, failed: [2, 4] },
		};
		const run = writeRun(runsRoot, { runId: "run-judge", graders: [grader] });
		mkdirSync(join(runsRoot, run.runId, "judge"), { recursive: true });
		writeFileSync(
			join(runsRoot, run.runId, "judge", "0.verdict.json"),
			`${JSON.stringify({
				passed: false,
				score: 0.5,
				assertions: [
					{ index: 1, answer: "yes", evidence: "срок указан" },
					{ index: 2, answer: "no", evidence: "не назван срок" },
					{ index: 3, answer: "yes", evidence: "тон корректный" },
					{ index: 4, answer: "unknown", evidence: "ответа недостаточно" },
				],
				jury: [
					{ juror: 1, passed: false, answers: ["yes", "no", "yes", "unknown"] },
					{ juror: 2, passed: false, answers: ["yes", "no", "yes", "yes"] },
					{ juror: 3, passed: true, answers: ["yes", "yes", "yes", "yes"] },
				],
			})}\n`,
		);
		const lines = explain(runsRoot, run);
		expect(lines[1]).toBe(
			"rubric (judge) expected all 4 rubric assertion(s) to hold; the judge answered 2 of 4 with yes; assertion(s) 2, 4 did not hold.",
		);
		expect(lines).toContain("Assertion 2 was answered “no”; the judge's evidence: “не назван срок”.");
		expect(lines).toContain("Assertion 4 was answered “unknown”; the judge's evidence: “ответа недостаточно”.");
		expect(lines).toContain("A jury of 3 decided this grader: 1 of 3 voted pass.");
		// A passing assertion is in the verdict but is not part of the "why".
		expect(lines.some((line) => line.includes("срок указан"))).toBe(false);
		const verdict = findings(runsRoot, run)[0]!;
		expect(verdict.chip).toBe("2/4");
		expect(verdict.assertionVerdicts?.map((assertion) => assertion.answer)).toEqual(["yes", "no", "yes", "unknown"]);
		expect(verdict.jury).toHaveLength(3);
	});

	it("drops a verdict sidecar that contradicts the graded record", () => {
		const runsRoot = root();
		const run = writeRun(runsRoot, {
			runId: "run-liar",
			graders: [{
				name: "rubric",
				type: "judge",
				checkCode: "semantic-rubric",
				specHash: `sha256:${"9".repeat(64)}`,
				passed: false,
				score: 0,
				reason: "assertion 1 failed: nope",
				assertions: { total: 2, failed: [1] },
			}],
		});
		mkdirSync(join(runsRoot, run.runId, "judge"), { recursive: true });
		writeFileSync(
			join(runsRoot, run.runId, "judge", "0.verdict.json"),
			// Claims both assertions held, which the RunRecord denies.
			`${JSON.stringify({
				passed: false,
				score: 0,
				assertions: [
					{ index: 1, answer: "yes", evidence: "invented" },
					{ index: 2, answer: "yes", evidence: "invented" },
				],
			})}\n`,
		);
		const verdict = findings(runsRoot, run)[0]!;
		expect(verdict.assertionVerdicts).toBeNull();
		expect(explain(runsRoot, run).some((line) => line.includes("invented"))).toBe(false);
	});

	it("calls an infrastructure error inconclusive rather than a behavioural failure", () => {
		const runsRoot = root();
		const run = writeRun(runsRoot, { runId: "run-error", status: "error", graders: [] });
		const lines = explain(runsRoot, run);
		expect(lines[0]).toBe(
			"task-1 repetition 0 ended with an infrastructure error, so its evidence is inconclusive rather than a behavioural failure.",
		);
	});

	/**
	 * Session 7, defect 2. The trace of a timed-out run ends on a tool call that
	 * SUCCEEDED — `get_account · 930ms · ok` — because the run stopped waiting
	 * for the model's next reply. Reading a cause off that shape produced
	 * `called get_account · no reply` on the same screen as the ok.
	 */
	it("reads an errored run from its recorded error, never from the shape of the trace", () => {
		const runsRoot = root();
		const run = writeRun(runsRoot, {
			runId: "run-timeout",
			status: "error",
			error: "run timed out after 300000ms",
			graders: [],
		});
		const explanation = explainRun({
			run,
			graders: findings(runsRoot, run),
			facts: traceFacts(parseSessionJsonl(`${TRACE_LINES.join("\n")}\n`)),
			modes: [],
			flip: null,
		});
		expect(explanation.error).toEqual({
			code: "timeout",
			sentence: "the agent did not answer within 300s — the model timed out",
			detail: "run timed out after 300000ms",
		});
		// The sentence lands second, right under the headline, before anything a
		// trace could suggest.
		expect(renderRunExplanationText(explanation)[1])
			.toBe("the agent did not answer within 300s — the model timed out (run timed out after 300000ms)");
	});

	it("classifies every error stem this host writes, and quotes the rest verbatim", () => {
		const cases: [string, RunErrorClass, string][] = [
			["run timed out after 45000ms", "timeout", "the agent did not answer within 45s — the model timed out"],
			["command Target exited with 7: agent gave up", "exit", "the agent process ended before it answered"],
			["command Target protocol violation at line 3", "protocol", "the agent broke the protocol the host speaks"],
			["command Target did not start within 5000ms", "startup", "the agent never started"],
			["evaluation infrastructure: world state file is not JSON", "evaluation", "the evaluation path failed before any grading"],
			["missing OPENROUTER_API_KEY for OpenRouter endpoint https://openrouter.ai/api/v1", "other", "the run ended before the model answered"],
			["something nobody wrote a stem for", "other", "the run ended before the model answered"],
		];
		for (const [stem, code, sentence] of cases) {
			expect(classifyRunError(stem), stem).toBe(code);
			expect(runErrorReading(stem), stem).toEqual({ code, sentence, detail: stem });
		}
		// A run that recorded nothing gets no sentence at all rather than a guess.
		expect(runErrorReading(null)).toBeNull();
		expect(runErrorReading("   ")).toBeNull();
	});

	it("tells a grader of an errored run what ended it instead of what it saw", () => {
		const runsRoot = root();
		const run = writeRun(runsRoot, {
			runId: "run-exit",
			status: "error",
			error: "command Target exited with 7: agent gave up",
			graders: [],
		});
		const explanation = explainRun({
			run: { ...run, status: "error" },
			graders: [{
				name: "contains",
				type: "output_contains",
				checkCode: "output-contains",
				passed: false,
				score: 0,
				reason: 'output does not contain "договор"',
				abstained: false,
				assertions: null,
				assertionVerdicts: null,
				choice: null,
				jury: null,
				chip: "✗",
			}],
			facts: null,
			modes: [],
			flip: null,
		});
		expect(explanation.graders[0]!.actual).toBe(
			"the run never completed, so nothing was graded — the agent process ended before it answered "
			+ "(command Target exited with 7: agent gave up)",
		);
	});

	it("labels a failure mode as a hypothesis and names an A/A calibration for what it is", () => {
		const runsRoot = root();
		const run = writeRun(runsRoot, {
			runId: "run-mode",
			graders: [{
				name: "contains",
				type: "output_contains",
				checkCode: "output-contains",
				specHash: `sha256:${"a".repeat(64)}`,
				passed: false,
				score: 0,
				reason: 'output does not contain "договор"',
			}],
		});
		const explanation = explainRun({
			run,
			graders: findings(runsRoot, run),
			facts: null,
			modes: [{
				failureModeId: "failure-mode-" + "0".repeat(24),
				signature: { kind: "grader-check", checkCode: "output-contains", subject: null, discriminatorHash: `sha256:${"b".repeat(64)}` },
				category: "output-contract",
				scope: "task-local",
				severity: "major",
				evidenceStrength: "medium",
				decision: "propose-harness-change",
				title: "Output contract check failed",
				summary: "one task",
				facts: "No tool was called in 1 of 1 failing runs.",
				observations: [{ code: "no-tool-call" as const, runs: 1 }],
				observedRuns: 1,
				suggestions: ["define the answer fields"],
				impact: {
					affectedTasks: 1,
					totalTasks: 4,
					taskCoverageBps: 2_500,
					failedOccurrences: 1,
					passedOccurrences: 1,
					reproductionBps: 5_000,
				},
				taskIds: ["task-1"],
				evidence: [{
					runId: run.runId,
					taskId: "task-1",
					traceAvailable: true,
					graderNames: ["contains"],
					excerpt: { toolNames: [], reply: "нет договора", observations: ["no-tool-call" as const] },
				}],
				counterEvidence: [],
				evidenceNotes: [],
				omittedEvidenceCount: 0,
			}],
			flip: candidateFlip({
				candidateId: "candidate-aa",
				mode: "aa-calibration",
				baselineEvalRunId: "erun_a",
				candidateEvalRunId: "erun_b",
				baselinePass: 0,
				baselineTotal: 2,
				candidatePass: 2,
				candidateTotal: 2,
			}),
		});
		// The scope and the severity are words, not the typed tokens: session 7
		// read «(task-local, blocking, задач: 1 из 8…)» — two Latin tokens inside
		// a Russian sentence, where nothing matches on them.
		expect(explanation.sentences).toContain(
			'This run is evidence for the failure mode “The answer missed a required element” (one case, major, 1 of 4 task(s), 50% reproduction).',
		);
		expect(explanation.sentences.join(" ")).not.toContain("task-local");
		// The host says what the traces show, counted, instead of a template hypothesis.
		expect(explanation.sentences).toContain(
			"What the traces show: No tool was called in 1 of 1 failing run.",
		);
		expect(explanation.sentences.at(-1)).toBe(
			"A/A calibration candidate-aa re-ran this task: failed → passed (improved; baseline 0/2, candidate 2/2).",
		);
		expect(explanation.flip?.badge).toBe("↑");
	});
});

describe("the runs table projection", () => {
	function evalFixture(runsRoot: string): { evalRunId: string; runs: RunRecord[] } {
		const evalRunId = "erun_table";
		const runs = [
			writeRun(runsRoot, {
				runId: "run-pass",
				taskId: "task-a",
				evalRunId,
				graders: [{ name: "g", type: "output_contains", passed: true, score: 1, reason: 'output contains "x"' }],
			}),
			writeRun(runsRoot, {
				runId: "run-fail",
				taskId: "task-b",
				evalRunId,
				graders: [
					{ name: "g1", type: "output_contains", passed: true, score: 1, reason: 'output contains "x"' },
					{ name: "g2", type: "tool_called", passed: false, score: 0, reason: "never called bash" },
				],
			}),
			writeRun(runsRoot, { runId: "run-err", taskId: "task-c", evalRunId, status: "error", graders: [] }),
		];
		const evidence = { runtime, model, judge: null, execution, eval: evaluation };
		const record: EvalRunRecord = {
			schemaVersion: 3,
			purpose: "evidence",
			evalRunId,
			target: { id: "target", gitSha: "a".repeat(40) },
			label: "solo",
			baselineEvalRunId: null,
			provenance: provenanceAxes(evidence),
			provenanceKey: provenanceKey(evidence),
			suiteId: evaluation.suiteId,
			suiteHash: evaluation.suiteHash,
			dataset: evaluation.dataset,
			datasetHash: evaluation.datasetHash,
			evidenceVisibility: "development",
			taskIds: runs.map((run) => run.taskId),
			repetitions: 1,
			runIds: runs.map((run) => run.runId),
			runArtifacts: runs.map((run) => ({ runId: run.runId, sha256: hashValue(run) })),
			startedAt: "2026-08-30T10:00:00.000Z",
			finishedAt: "2026-08-30T10:00:02.000Z",
			summary: { total: 3, pass: 1, fail: 1, error: 1, allPassRate: 1 / 3 },
		};
		writeEvalRun(runsRoot, record);
		return { evalRunId, runs };
	}

	it("orders errors, then failures, then passes, and carries the input preview", () => {
		const runsRoot = root();
		const { evalRunId, runs } = evalFixture(runsRoot);
		const brief = compileImprovementBrief(runsRoot, diagnoseEvalRun(runsRoot, evalRunId, () => "2026-08-30T10:01:00.000Z"));
		const rows = runsTable(runsRoot, runs, brief);
		expect(rows.map((row) => row.outcome)).toEqual(["error", "fail", "pass"]);
		expect(rows.map((row) => row.taskId)).toEqual(["task-c", "task-b", "task-a"]);
		expect(rows[1]?.score).toBe(0.5);
		expect(rows[1]?.graders.map((grader) => grader.chip)).toEqual(["✓", "✗"]);
		expect(rows[1]?.inputPreview).toBe("Обращение: проверь договор №42.");
		expect(rows[1]?.failureModeIds.length).toBeGreaterThan(0);
	});
});

describe("the transcript projection", () => {
	it("pairs a tool result with its call, times it, and keeps thinking separate", () => {
		const transcript = runTranscript(parseSessionJsonl(`${TRACE_LINES.join("\n")}\n`));
		expect(transcript.entries.map((entry) => entry.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
		const tool = transcript.entries[2];
		expect(tool?.kind === "tool" && tool.name).toBe("read");
		expect(tool?.kind === "tool" && tool.durationMs).toBe(700);
		expect(tool?.kind === "tool" && tool.result).toBe("договор найден");
		const first = transcript.entries[1];
		expect(first?.kind === "assistant" && first.thinking).toBe("внутренние рассуждения");
		expect(first?.kind === "assistant" && first.final).toBe(false);
		const last = transcript.entries[3];
		expect(last?.kind === "assistant" && last.final).toBe(true);
		expect(transcript.truncated).toBe(false);
	});

	it("redacts credential shapes before any turn is rendered", () => {
		const lines = [
			JSON.stringify({ type: "message", message: { role: "user", content: "api_key=\"sk-abcdefghijklmnop\"" } }),
		].join("\n");
		const transcript = runTranscript(parseSessionJsonl(`${lines}\n`));
		const text = JSON.stringify(transcript);
		expect(text).not.toContain("sk-abcdefghijklmnop");
		expect(text).toContain("REDACTED");
	});
});

/**
 * Session 7, defect 6: the receipt of a worlded run read `world: null · judge:
 * null · simulatedUser: null` with no `usage` key at all, on a case whose world
 * the tool had answered from thirty lines above. Four absent JSON keys are four
 * different statements and the receipt makes each of them.
 */
describe("the run receipt", () => {
	it("says a world was there, an instrument never ran, and a spend was never reported", () => {
		const runsRoot = root();
		const run = writeRun(runsRoot, {
			runId: "run-receipt",
			status: "error",
			error: "run timed out after 300000ms",
			graders: [],
		});
		mkdirSync(join(runsRoot, "run-receipt", "runtime", "world"), { recursive: true });
		writeFileSync(
			join(runsRoot, "run-receipt", "runtime", "world", "state.json"),
			JSON.stringify({ accounts: { "33333": { balance: -500 } }, tickets: [], client: { name: "Пётр" } }),
		);
		const noUsage: RunRecord = {
			...run,
			execution: { ...run.execution, agent: "command-v1" },
			metrics: { latencyMs: 300_012, toolCalls: 2, toolErrors: 0, recoveryAttempts: 0 },
		};
		expect(runReceipt(runsRoot, noUsage)).toEqual({
			worldKeys: 3,
			judge: null,
			simulatedUser: null,
			tokens: null,
			costUsd: null,
			incomplete: true,
		});
	});

	it("counts what the judge and the user model actually spent on a completed run", () => {
		const runsRoot = root();
		const run = writeRun(runsRoot, { runId: "run-spent", graders: [] });
		const spent: RunRecord = {
			...run,
			metrics: {
				...run.metrics,
				judge: { calls: 2, tokens: 900, costUsd: 0.004 },
				simulatedUser: { calls: 5, tokens: 1_200, costUsd: 0.01 },
			},
		};
		expect(runReceipt(runsRoot, spent)).toEqual({
			// This case declared no world, and "none" is a fact, not a missing one.
			worldKeys: null,
			judge: { calls: 2, costUsd: 0.004 },
			simulatedUser: { calls: 5, costUsd: 0.01 },
			tokens: 2,
			costUsd: 0.001,
			incomplete: false,
		});
	});

	it("treats an unreadable world as none rather than throwing at render time", () => {
		const runsRoot = root();
		const run = writeRun(runsRoot, { runId: "run-badworld", graders: [] });
		mkdirSync(join(runsRoot, "run-badworld", "runtime", "world"), { recursive: true });
		writeFileSync(join(runsRoot, "run-badworld", "runtime", "world", "state.json"), "{ not json");
		expect(runReceipt(runsRoot, run).worldKeys).toBeNull();
	});
});
