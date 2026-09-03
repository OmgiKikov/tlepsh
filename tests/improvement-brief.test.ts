import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseEvalRun, type DiagnosisRecord } from "../src/diagnosis.js";
import { EvalRunRecordSchema, type EvalRunRecord } from "../src/eval.js";
import {
	IMPROVEMENT_BRIEF_ALGORITHM_ID,
	FailureModeIdSchema,
	ImprovementBriefSchema,
	ProposalBasisSelectionSchema,
	compileImprovementBrief,
	deriveEvidenceLinkedProposalSelection,
	graderFamilyDiscriminator,
	graderFamilyModeId,
} from "../src/application/improvement-brief.js";
import { failureModeReading } from "../src/application/run-explanation.js";
import {
	RunRecordSchema,
	canonicalJson,
	executionFingerprint,
	hashFile,
	hashValue,
	modelFingerprint,
	provenanceAxes,
	provenanceKey,
	type GraderResult,
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

interface RunInput {
	taskId: string;
	repetitionIndex: number;
	status?: "completed" | "error";
	graders?: GraderResult[];
	error?: string;
	trace?: boolean;
	/** Tools the Target called in this run, in order. */
	toolCalls?: string[];
	/** The last thing the Target said. */
	reply?: string;
}

interface FixtureOptions {
	evalRunId?: string;
	dataset?: string;
	evidenceVisibility?: "development" | "sealed";
	repetitions: number;
	runs: RunInput[];
}

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "ahde-improvement-brief-"));
	roots.push(value);
	return value;
}

function exactGrader(options: {
	passed: boolean;
	specHash: string;
	checkCode?:
		| "required-tool"
		| "output-contains"
		| "output-matches"
		| "semantic-rubric"
		| "reference-exact"
		| "reference-similarity";
	name?: string;
	type?: string;
	reason?: string;
	checkSubject?: string;
}): GraderResult {
	return {
		name: options.name ?? "required-answer",
		type: options.type ?? "output_contains",
		passed: options.passed,
		score: options.passed ? 1 : 0,
		reason: options.reason ?? (options.passed ? "required answer present" : "required answer missing"),
		specHash: options.specHash,
		checkCode: options.checkCode ?? "output-contains",
		...(options.checkSubject === undefined ? {} : { checkSubject: options.checkSubject }),
	};
}

function legacyGrader(passed: boolean, name = "legacy-check", reason = "legacy check failed"): GraderResult {
	return {
		name,
		type: "output_contains",
		passed,
		score: passed ? 1 : 0,
		reason: passed ? "legacy check passed" : reason,
	};
}

function fixture(options: FixtureOptions): {
	runsRoot: string;
	evalRun: EvalRunRecord;
	diagnosis: DiagnosisRecord;
	runs: RunRecord[];
} {
	const runsRoot = root();
	const evalRunId = options.evalRunId ?? "erun-improvement-brief";
	const dataset = options.dataset ?? "development";
	const evaluation = {
		suiteId: "suite",
		suiteHash: `sha256:${"d".repeat(64)}`,
		dataset,
		datasetHash: `sha256:${"e".repeat(64)}`,
	};
	const runs = options.runs.map((input, index): RunRecord => {
		const runId = `run-${index.toString().padStart(4, "0")}`;
		const runDir = join(runsRoot, runId);
		mkdirSync(runDir, { recursive: true });
		let traceHash: string | null = null;
		if (input.trace) {
			const calls = (input.toolCalls ?? []).map((name, callIndex) => ({
				type: "toolCall",
				id: `call-${callIndex}`,
				name,
				arguments: {},
			}));
			const lines = [
				...(calls.length === 0 ? [] : [JSON.stringify({
					type: "message",
					message: { role: "assistant", content: calls },
				})]),
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: input.reply ?? `answer:${runId}` }],
					},
				}),
			];
			const trace = `${lines.join("\n")}\n`;
			writeFileSync(join(runDir, "session.jsonl"), trace);
			traceHash = hashFile(trace);
		}
		const status = input.status ?? "completed";
		const graders = status === "completed" ? input.graders ?? [] : [];
		const outcome = graders.every((grader) => grader.passed) ? "pass" : "fail";
		const record: RunRecord = {
			schemaVersion: 1,
			runId,
			taskId: input.taskId,
			repetitionIndex: input.repetitionIndex,
			label: "solo",
			status,
			error: status === "error" ? input.error ?? "evaluation infrastructure failed" : null,
			startedAt: "2026-08-28T10:00:00.000Z",
			finishedAt: "2026-08-28T10:00:01.000Z",
			target: { id: "target", gitSha },
			runtime,
			model,
			execution,
			eval: evaluation,
			trace: { path: "session.jsonl", sessionId: traceHash ? `session-${index}` : null, sha256: traceHash },
			metrics: {
				tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
				costUsd: 0,
				latencyMs: 1,
				toolCalls: 0,
				toolErrors: 0,
				recoveryAttempts: 0,
			},
			evalResults: status === "completed" ? { graders, outcome } : null,
			parent: { evalRunId, candidateOf: null },
		};
		writeJsonArtifact(join(runDir, "run.json"), RunRecordSchema, record);
		return record;
	});
	const taskIds = [...new Set(runs.map((run) => run.taskId))];
	const pass = runs.filter((run) => run.status === "completed" && run.evalResults?.outcome === "pass").length;
	const fail = runs.filter((run) => run.status === "completed" && run.evalResults?.outcome === "fail").length;
	const error = runs.filter((run) => run.status === "error").length;
	const evidence = { runtime, model, judge: null, execution, eval: evaluation };
	const evalRun: EvalRunRecord = {
		schemaVersion: 3,
		purpose: "evidence" as const,
		evalRunId,
		target: { id: "target", gitSha },
		label: "solo",
		baselineEvalRunId: null,
		provenance: provenanceAxes(evidence),
		provenanceKey: provenanceKey(evidence),
		suiteId: evaluation.suiteId,
		suiteHash: evaluation.suiteHash,
		dataset,
		datasetHash: evaluation.datasetHash,
		...(options.evidenceVisibility ? { evidenceVisibility: options.evidenceVisibility } : {}),
		taskIds,
		repetitions: options.repetitions,
		runIds: runs.map((run) => run.runId),
		runArtifacts: runs.map((run) => ({ runId: run.runId, sha256: hashValue(run) })),
		startedAt: "2026-08-28T10:00:00.000Z",
		finishedAt: "2026-08-28T10:00:02.000Z",
		summary: {
			total: runs.length,
			pass,
			fail,
			error,
			allPassRate: runs.length === 0 ? 0 : pass / runs.length,
		},
	};
	mkdirSync(join(runsRoot, evalRunId), { recursive: true });
	writeJsonArtifact(join(runsRoot, evalRunId, "eval_run.json"), EvalRunRecordSchema, evalRun);
	const diagnosis = diagnoseEvalRun(runsRoot, evalRunId, () => "2026-08-28T11:00:00.000Z");
	return { runsRoot, evalRun, diagnosis, runs };
}

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("deterministic improvement brief", () => {
	it("groups only an exact grader signature across tasks and retains passing counterevidence", () => {
		const specHash = hashValue({ type: "output_contains", text: "answer" });
		const value = fixture({
			repetitions: 2,
			evidenceVisibility: "development",
			runs: [
				{ taskId: "task-a", repetitionIndex: 0, graders: [exactGrader({ passed: false, specHash })], trace: true },
				{ taskId: "task-a", repetitionIndex: 1, graders: [exactGrader({ passed: true, specHash })] },
				{ taskId: "task-b", repetitionIndex: 0, graders: [exactGrader({ passed: false, specHash })] },
				{ taskId: "task-b", repetitionIndex: 1, graders: [exactGrader({ passed: true, specHash })] },
			],
		});

		const first = compileImprovementBrief(value.runsRoot, value.diagnosis);
		const second = compileImprovementBrief(value.runsRoot, value.diagnosis);
		expect(second).toEqual(first);
		expect(first.headline).toContain("diagnosed failure mode");
		expect(first.headline).not.toContain("deterministic failure mode");
		expect(ImprovementBriefSchema.parse(first)).toEqual(first);
		expect(first.briefId).toBe(`brief-${hashValue({
			algorithmId: IMPROVEMENT_BRIEF_ALGORITHM_ID,
			diagnosisInputHash: value.diagnosis.inputHash,
		}).slice(7, 31)}`);

		const mode = first.modes.find((candidate) => candidate.signature.kind === "grader-check" && candidate.scope === "systemic");
		expect(mode).toBeDefined();
		expect(mode).toMatchObject({
			signature: {
				checkCode: "output-contains",
				subject: null,
				discriminatorHash: hashValue({ checkCode: "output-contains", subject: null }),
			},
			category: "output-contract",
			scope: "systemic",
			severity: "major",
			evidenceStrength: "medium",
			// Two failures and two passes reproduce 50% of the time: a real weakness
			// with counter-evidence retained, not noise to stabilize.
			decision: "propose-harness-change",
			impact: {
				affectedTasks: 2,
				totalTasks: 2,
				taskCoverageBps: 10_000,
				failedOccurrences: 2,
				passedOccurrences: 2,
				reproductionBps: 5_000,
			},
		});
		expect(mode?.failureModeId).toBe(`failure-mode-${hashValue({
			algorithmId: IMPROVEMENT_BRIEF_ALGORITHM_ID,
			signature: { kind: "grader-check", checkCode: "output-contains", subject: null },
		}).slice(7, 31)}`);
		expect(mode?.evidence.map((item) => item.taskId)).toEqual(["task-a", "task-b"]);
		expect(mode?.evidence[0]?.traceAvailable).toBe(true);
		expect(mode?.counterEvidence.map((item) => item.taskId)).toEqual(["task-a", "task-b"]);
		expect(mode?.title).toBe("Output contract check failed across tasks");
		expect(first.headline).toContain("2/4 passed.");
		// A 50%-reproducing mode with retained counter-evidence is proposal-eligible.
		expect(first.proposalEligible).toBe(true);
	});

	it("uses category-specific exact titles and proposes only repeatable checks without counterevidence", () => {
		const toolHash = hashValue({ type: "tool_called", tool: "search" });
		const outputHash = hashValue({ type: "output_matches", pattern: "result" });
		const semanticHash = hashValue({ type: "judge", rubric: "correct" });
		const graders = [
			exactGrader({ passed: false, specHash: toolHash, checkCode: "required-tool", type: "tool_called", name: "tool" }),
			exactGrader({ passed: false, specHash: outputHash, checkCode: "output-matches", type: "output_matches", name: "format" }),
			exactGrader({ passed: false, specHash: semanticHash, checkCode: "semantic-rubric", type: "judge", name: "quality" }),
		];
		const value = fixture({
			repetitions: 1,
			evidenceVisibility: "development",
			runs: [{ taskId: "task", repetitionIndex: 0, graders }],
		});

		const brief = compileImprovementBrief(value.runsRoot, value.diagnosis);
		expect(brief.modes.map((mode) => mode.title).sort()).toEqual([
			"Output contract check failed",
			"Required tool check failed",
			"Semantic rubric check failed",
		]);
		expect(brief.modes.every((mode) => mode.decision === "propose-harness-change")).toBe(true);
		expect(brief.proposalEligible).toBe(true);
		expect(brief.headline).toContain("0/1 passed.");
	});

	/**
	 * A judge that said it could not tell has failed the check, but there is no
	 * agent behaviour under that failure to change. The family, the id and the
	 * counts are untouched — modes cluster by the exact typed grader family and
	 * nothing else — and only the decision and the reading move.
	 */
	it("reads a mode failed only by an unsure judge as stabilize-and-rerun", () => {
		const semanticHash = hashValue({ type: "judge", rubric: "correct" });
		const abstained = {
			...exactGrader({
				passed: false,
				specHash: semanticHash,
				checkCode: "semantic-rubric",
				type: "judge",
				name: "quality",
				reason: "судить не о чем",
			}),
			abstained: true,
		};
		const value = fixture({
			repetitions: 1,
			evidenceVisibility: "development",
			runs: [
				{ taskId: "task-a", repetitionIndex: 0, graders: [abstained] },
				{ taskId: "task-b", repetitionIndex: 0, graders: [abstained] },
			],
		});
		const brief = compileImprovementBrief(value.runsRoot, value.diagnosis);
		const [mode] = brief.modes;
		expect(mode?.abstained).toBe(true);
		expect(mode?.decision).toBe("stabilize-and-rerun");
		// The family is unchanged: the same id the same check would get anyway.
		expect(mode?.failureModeId).toBe(graderFamilyModeId({ checkCode: "semantic-rubric", subject: null }));
		expect(failureModeReading(mode!)).toEqual({
			title: "The judge could not tell",
			facts: "2 matching observation(s) were failed by a judge that said it could not decide, " +
				"never by a check the agent missed",
		});

		// One decided failure in the same run and it is evidence about the agent
		// again, so the mode goes back to being something to propose against.
		const mixed = fixture({
			repetitions: 1,
			evidenceVisibility: "development",
			runs: [
				{ taskId: "task-a", repetitionIndex: 0, graders: [abstained] },
				{
					taskId: "task-b",
					repetitionIndex: 0,
					graders: [exactGrader({
						passed: false,
						specHash: semanticHash,
						checkCode: "semantic-rubric",
						type: "judge",
						name: "quality",
					})],
				},
			],
		});
		const second = compileImprovementBrief(mixed.runsRoot, mixed.diagnosis);
		expect(second.modes[0]?.abstained).toBeUndefined();
		expect(second.modes[0]?.decision).toBe("propose-harness-change");
	});

	it("gives every check code its own title and category, reference graders included", () => {
		const graders = [
			exactGrader({
				passed: false,
				specHash: hashValue({ type: "exact", normalize: "lower" }),
				checkCode: "reference-exact",
				type: "exact",
				name: "exact",
			}),
			exactGrader({
				passed: false,
				specHash: hashValue({ type: "similarity", metric: "token-f1", threshold: 0.8 }),
				checkCode: "reference-similarity",
				type: "similarity",
				name: "similarity",
			}),
		];
		const value = fixture({
			repetitions: 1,
			evidenceVisibility: "development",
			runs: [{ taskId: "task", repetitionIndex: 0, graders }],
		});

		const brief = compileImprovementBrief(value.runsRoot, value.diagnosis);
		expect(brief.modes.map((mode) => [mode.signature.checkCode, mode.title, mode.category]).sort())
			.toEqual([
				["reference-exact", "Exact reference-answer check failed", "output-contract"],
				["reference-similarity", "Reference similarity check failed", "answer-quality"],
			]);
		expect(brief.modes.every((mode) => mode.decision === "propose-harness-change")).toBe(true);
	});

	it("keeps legacy and unknown infrastructure signals task-local and never calls pass-plus-error flaky", () => {
		const secret = "sk-infrastructuresecret1234567890";
		const value = fixture({
			repetitions: 2,
			evidenceVisibility: "development",
			runs: [
				{ taskId: "legacy-a", repetitionIndex: 0, graders: [legacyGrader(false)] },
				{ taskId: "legacy-a", repetitionIndex: 1, graders: [legacyGrader(false)] },
				{ taskId: "legacy-b", repetitionIndex: 0, graders: [legacyGrader(false)] },
				{ taskId: "legacy-b", repetitionIndex: 1, graders: [legacyGrader(false)] },
				{ taskId: "flaky", repetitionIndex: 0, graders: [legacyGrader(true, "flaky-check")] },
				{ taskId: "flaky", repetitionIndex: 1, graders: [legacyGrader(false, "flaky-check")] },
				{ taskId: "infra", repetitionIndex: 0, graders: [legacyGrader(true, "infra-check")] },
				{ taskId: "infra", repetitionIndex: 1, status: "error", error: `timeout ${secret}` },
			],
		});

		const brief = compileImprovementBrief(value.runsRoot, value.diagnosis);
		const legacyModes = brief.modes.filter((mode) => mode.signature.kind === "grader-check");
		expect(legacyModes.every((mode) => mode.scope === "task-local" && mode.signature.checkCode === null)).toBe(true);
		expect(legacyModes.filter((mode) => mode.taskIds.includes("legacy-a"))).toHaveLength(1);
		expect(legacyModes.filter((mode) => mode.taskIds.includes("legacy-b"))).toHaveLength(1);
		expect(brief.modes.filter((mode) => mode.signature.kind === "outcome-instability").map((mode) => mode.taskIds))
			.toEqual([["flaky"]]);

		const infrastructure = brief.modes.find((mode) => mode.signature.kind === "infrastructure-error");
		// An error stem this host does not write is `other`, and its rate is
		// counted against every run that did NOT end this way — the whole
		// evaluation, because "one of eight executions ended here" is the fact a
		// reader needs. A per-task denominator made a fully-failed task reproduce
		// at 100% no matter how rare the cause was.
		expect(infrastructure).toMatchObject({
			scope: "task-local",
			severity: "blocking",
			decision: "repair-evidence-path",
			signature: { kind: "infrastructure-error", subject: "other" },
			title: "Evidence-path failure: an interrupted run",
			impact: { failedOccurrences: 1, passedOccurrences: 7, reproductionBps: 1_250 },
		});
		expect(infrastructure?.facts).toBe(
			"1 of 8 run(s) ended at an interrupted run; this is evidence about the evaluation path, not about Target behavior.",
		);
		expect(JSON.stringify(brief)).not.toContain(secret);
		expect(infrastructure?.evidenceNotes.join(" ")).toContain("REDACTED_API_KEY");
		expect(brief.status).toBe("inconclusive");
		expect(brief.proposalEligible).toBe(false);
	});

	it("redacts and deterministically bounds model-visible task ids without changing grouping", () => {
		const rawTaskId = `customer-sk-supersecret12345-${"x".repeat(240)}`;
		const specHash = hashValue({ type: "output_contains", text: "required" });
		const value = fixture({
			evalRunId: "erun-long-task-id",
			repetitions: 1,
			runs: [{
				taskId: rawTaskId,
				repetitionIndex: 0,
				graders: [exactGrader({ passed: false, specHash })],
			}],
		});

		const first = compileImprovementBrief(value.runsRoot, value.diagnosis);
		const second = compileImprovementBrief(value.runsRoot, value.diagnosis);
		const mode = first.modes.find((candidate) => candidate.signature.kind === "grader-check")!;
		expect(second).toEqual(first);
		expect(mode.impact.affectedTasks).toBe(1);
		expect(mode.taskIds).toHaveLength(1);
		expect(mode.taskIds[0]!.length).toBeLessThanOrEqual(200);
		expect(mode.taskIds[0]).toContain("REDACTED_API_KEY");
		expect(mode.taskIds[0]).not.toContain("sk-supersecret12345");
		expect(mode.evidence[0]?.taskId).toBe(mode.taskIds[0]);
	});

	it("rejects formal and legacy sealed evaluations generically and verifies diagnosis identity", () => {
		const formal = fixture({
			evalRunId: "erun-formal-secret",
			repetitions: 1,
			evidenceVisibility: "sealed",
			runs: [{ taskId: "hidden-formal-task", repetitionIndex: 0, graders: [legacyGrader(true)] }],
		});
		expect(() => compileImprovementBrief(formal.runsRoot, formal.diagnosis))
			.toThrow("improvement brief is unavailable for this evaluation");
		writeFileSync(join(formal.runsRoot, formal.runs[0]!.runId, "run.json"), "SEALED_MEMBER_MUST_NOT_BE_READ\n");
		expect(() => compileImprovementBrief(formal.runsRoot, formal.diagnosis))
			.toThrow("improvement brief is unavailable for this evaluation");
		try {
			compileImprovementBrief(formal.runsRoot, formal.diagnosis);
		} catch (error) {
			expect(String(error)).not.toContain("hidden-formal-task");
			expect(String(error)).not.toContain("erun-formal-secret");
		}

		const legacy = fixture({
			evalRunId: "erun-legacy-secret",
			dataset: "sealed-corpus-private",
			repetitions: 1,
			runs: [{ taskId: "hidden-legacy-task", repetitionIndex: 0, graders: [legacyGrader(true)] }],
		});
		expect(() => compileImprovementBrief(legacy.runsRoot, legacy.diagnosis))
			.toThrow("improvement brief is unavailable for this evaluation");

		const development = fixture({
			evalRunId: "erun-development",
			repetitions: 1,
			evidenceVisibility: "development",
			runs: [{ taskId: "public-task", repetitionIndex: 0, graders: [legacyGrader(false)] }],
		});
		expect(() => compileImprovementBrief(development.runsRoot, {
			...development.diagnosis,
			targetRevision: "f".repeat(40),
		})).toThrow("diagnosis does not match the verified evaluation evidence");
		expect(() => compileImprovementBrief(development.runsRoot, {
			...development.diagnosis,
			inputHash: `sha256:${"f".repeat(64)}`,
		})).toThrow("diagnosis does not match the verified evaluation evidence");
		expect(() => compileImprovementBrief(development.runsRoot, {
			...development.diagnosis,
			diagnosisId: "diagnosis-tampered",
		})).toThrow("diagnosis does not match the verified evaluation evidence");
		expect(() => compileImprovementBrief(development.runsRoot, {
			...development.diagnosis,
			status: "healthy",
		})).toThrow("diagnosis does not match the verified evaluation evidence");
	});

	it("bounds mode, task, evidence, counterevidence, and note projections with explicit omissions", () => {
		const specHash = hashValue({ type: "output_contains", text: "shared" });
		const runs: RunInput[] = [];
		for (let index = 0; index < 105; index += 1) {
			const taskId = `task-${index.toString().padStart(3, "0")}`;
			// One family every task shares, plus one family of its own: modes cluster
			// by family now, so the task-local count comes from distinct tools.
			const ownTool = exactGrader({
				passed: false,
				specHash: hashValue({ type: "tool_called", index }),
				checkCode: "required-tool",
				type: "tool_called",
				checkSubject: `tool-${index}`,
			});
			runs.push({
				taskId,
				repetitionIndex: 0,
				graders: [
					exactGrader({
						passed: false,
						specHash,
						reason: `failure-${index} ${"x".repeat(600)} sk-boundedsecret1234567890`,
					}),
					ownTool,
				],
			});
			runs.push({ taskId, repetitionIndex: 1, graders: [exactGrader({ passed: true, specHash })] });
		}
		const value = fixture({ repetitions: 2, evidenceVisibility: "development", runs });

		const brief = compileImprovementBrief(value.runsRoot, value.diagnosis);
		expect(brief.summary).toMatchObject({
			tasks: 105,
			failedTasks: 105,
			failureModeCount: 107,
			systemicFailureModeCount: 2,
			taskLocalFailureModeCount: 105,
			omittedFailureModeCount: 77,
		});
		expect(brief.modes).toHaveLength(30);
		const systemic = brief.modes.find((mode) => mode.signature.checkCode === "output-contains");
		expect(systemic?.scope).toBe("systemic");
		expect(systemic?.taskIds).toHaveLength(100);
		expect(systemic?.evidence).toHaveLength(12);
		expect(systemic?.counterEvidence).toHaveLength(4);
		expect(systemic?.evidenceNotes).toHaveLength(3);
		expect(systemic?.evidenceNotes.every((note) => note.length <= 500)).toBe(true);
		expect(systemic?.omittedEvidenceCount).toBe(194);
		expect(JSON.stringify(brief)).not.toContain("sk-boundedsecret1234567890");
		expect(ImprovementBriefSchema.parse(brief)).toEqual(brief);
	});

	it("drops lowest-ranked modes deterministically until the canonical brief fits 256 KiB", () => {
		const runs: RunInput[] = [];
		for (let taskIndex = 0; taskIndex < 12; taskIndex += 1) {
			const graders: GraderResult[] = [];
			for (let modeIndex = 0; modeIndex < 30; modeIndex += 1) {
				const specHash = hashValue({ type: "tool_called", modeIndex });
				for (let duplicate = 0; duplicate < 8; duplicate += 1) {
					graders.push(exactGrader({
						passed: false,
						specHash,
						checkCode: "required-tool",
						type: "tool_called",
						checkSubject: `tool-${modeIndex}`,
						name: `mode-${modeIndex}-check-${duplicate}-${"n".repeat(170)}`,
						reason: `mode ${modeIndex} failed ${"r".repeat(490)}`,
					}));
				}
			}
			runs.push({ taskId: `task-${taskIndex}`, repetitionIndex: 0, graders });
		}
		const value = fixture({ repetitions: 1, evidenceVisibility: "development", runs });

		const first = compileImprovementBrief(value.runsRoot, value.diagnosis);
		const second = compileImprovementBrief(value.runsRoot, value.diagnosis);
		expect(second).toEqual(first);
		expect(first.summary.failureModeCount).toBe(30);
		expect(first.modes.length).toBeLessThan(30);
		expect(first.summary.omittedFailureModeCount).toBe(30 - first.modes.length);
		expect(Buffer.byteLength(canonicalJson(first), "utf8")).toBeLessThanOrEqual(256 * 1024);
		expect(ImprovementBriefSchema.parse(first)).toEqual(first);
	});
});

describe("proposal basis selection", () => {
	function proposalFixture(): ReturnType<typeof fixture> & {
		brief: ReturnType<typeof compileImprovementBrief>;
	} {
		const firstSpecHash = hashValue({ type: "output_contains", text: "first" });
		const secondSpecHash = hashValue({ type: "tool_called", tool: "search" });
		const value = fixture({
			repetitions: 1,
			evidenceVisibility: "development",
			runs: [
				{
					taskId: "task-a",
					repetitionIndex: 0,
					trace: true,
					graders: [
						exactGrader({ passed: false, specHash: firstSpecHash, name: "first" }),
						exactGrader({
							passed: false,
							specHash: secondSpecHash,
							checkCode: "required-tool",
							type: "tool_called",
							name: "second",
						}),
					],
				},
				{
					taskId: "task-b",
					repetitionIndex: 0,
					trace: true,
					graders: [
						exactGrader({ passed: false, specHash: firstSpecHash, name: "first" }),
						exactGrader({
							passed: false,
							specHash: secondSpecHash,
							checkCode: "required-tool",
							type: "tool_called",
							name: "second",
						}),
					],
				},
			],
		});
		return { ...value, brief: compileImprovementBrief(value.runsRoot, value.diagnosis) };
	}

	function basisTuple(brief: ReturnType<typeof compileImprovementBrief>) {
		return {
			algorithmId: brief.algorithmId,
			evalRunId: brief.evalRunId,
			diagnosisId: brief.diagnosisId,
			briefId: brief.briefId,
			failureModeIds: brief.modes.map((mode) => mode.failureModeId),
		};
	}

	it("canonicalizes selected modes and derives all proposal evidence and basis hashes", () => {
		const { brief } = proposalFixture();
		expect(brief.modes).toHaveLength(2);
		expect(brief.modes.every((mode) => mode.decision === "propose-harness-change")).toBe(true);

		const selection = deriveEvidenceLinkedProposalSelection(brief, {
			...basisTuple(brief),
			failureModeIds: brief.modes.map((mode) => mode.failureModeId).reverse(),
		});

		expect(selection.basis).toEqual({
			schemaVersion: 1,
			algorithmId: brief.algorithmId,
			evalRunId: brief.evalRunId,
			diagnosisId: brief.diagnosisId,
			briefId: brief.briefId,
			briefSha256: hashValue(brief),
			failureModes: brief.modes.map((mode) => ({
				failureModeId: mode.failureModeId,
				modeSha256: hashValue(mode),
			})),
		});
		expect(selection.diagnoses).toEqual(brief.modes.map((mode) => ({
			failureIds: [mode.failureModeId],
			evidence: mode.evidence.map((item) => `eval:${brief.evalRunId}/run:${item.runId}`),
			rootCause: `Host-derived from the cited traces (what happened, not why): ${mode.facts}`,
		})));
	});

	it("rejects duplicate, unknown, and stale proposal selections", () => {
		const { brief } = proposalFixture();
		const tuple = basisTuple(brief);
		const selectedId = brief.modes[0]!.failureModeId;

		expect(() => deriveEvidenceLinkedProposalSelection(brief, {
			...tuple,
			failureModeIds: [selectedId, selectedId],
		})).toThrow(/failure mode ids must be unique/);

		const unknownId = `failure-mode-${"f".repeat(24)}`;
		expect(brief.modes.some((mode) => mode.failureModeId === unknownId)).toBe(false);
		expect(() => deriveEvidenceLinkedProposalSelection(brief, {
			...tuple,
			failureModeIds: [unknownId],
		})).toThrow("one or more selected failure modes are absent from the exact improvement brief");

		for (const stale of [
			{ ...tuple, evalRunId: "erun-stale", failureModeIds: [selectedId] },
			{ ...tuple, diagnosisId: "diagnosis-stale", failureModeIds: [selectedId] },
			{ ...tuple, briefId: `brief-${"f".repeat(24)}`, failureModeIds: [selectedId] },
		]) {
			expect(() => deriveEvidenceLinkedProposalSelection(brief, stale))
				.toThrow("proposal basis does not match the exact improvement brief");
		}
	});

	it("rejects a selected mode whose host decision is not propose-harness-change", () => {
		const stableHash = hashValue({ type: "output_contains", text: "stable" });
		const mixedHash = hashValue({ type: "output_matches", pattern: "mixed" });
		const value = fixture({
			repetitions: 5,
			evidenceVisibility: "development",
			runs: Array.from({ length: 5 }, (_, repetitionIndex) => ({
				taskId: "task",
				repetitionIndex,
				graders: [
					exactGrader({ passed: false, specHash: stableHash }),
					// The mixed check fails once in five runs (20%): below the
					// reproduction floor, so the host decision stays stabilize-and-rerun.
					exactGrader({
						passed: repetitionIndex !== 0,
						specHash: mixedHash,
						checkCode: "output-matches",
						type: "output_matches",
					}),
				],
			})),
		});
		const brief = compileImprovementBrief(value.runsRoot, value.diagnosis);
		expect(brief.proposalEligible).toBe(true);
		const nonProposalMode = brief.modes.find((mode) => mode.decision === "stabilize-and-rerun")!;

		expect(() => deriveEvidenceLinkedProposalSelection(brief, {
			...basisTuple(brief),
			failureModeIds: [nonProposalMode.failureModeId],
		})).toThrow(`failure mode ${nonProposalMode.failureModeId} is not eligible for a harness proposal`);
	});

	it("requires unique failure-mode identities in both selection and brief schemas", () => {
		const { brief } = proposalFixture();
		const id = brief.modes[0]!.failureModeId;
		expect(FailureModeIdSchema.parse(id)).toBe(id);
		expect(() => ProposalBasisSelectionSchema.parse({
			...basisTuple(brief),
			failureModeIds: [id, id],
		})).toThrow(/failure mode ids must be unique/);

		expect(() => ImprovementBriefSchema.parse({
			...brief,
			modes: [
				brief.modes[0],
				{ ...brief.modes[1]!, failureModeId: id },
			],
		})).toThrow(/failure mode ids must be unique/);
	});
});

/**
 * The live ombudsman run, in miniature: six cases times three repetitions, a
 * `check_dbo` contract on three of them, a classification keyword on five, and
 * one judge rubric per case. The host used to report sixteen task-local modes
 * for what a person reading the traces called in one line — no tool call, no
 * classification, a question back to the customer.
 */
describe("the diagnosis a person would have written", () => {
	const toolSpec = hashValue({ type: "tool_called", tool: "check_dbo" });
	const rubricSpec = (task: string) => hashValue({ type: "judge", rubric: task });
	const keywordSpec = (task: string) => hashValue({ type: "output_contains", text: task });

	function contractGraders(task: string, options: { keyword: boolean; rubric: boolean }): GraderResult[] {
		return [
			exactGrader({
				passed: false,
				specHash: toolSpec,
				checkCode: "required-tool",
				type: "tool_called",
				checkSubject: "check_dbo",
				name: `${task}:tool_called:check_dbo`,
				reason: "never called check_dbo",
			}),
			exactGrader({ passed: options.keyword, specHash: keywordSpec(task), name: `${task}:contains` }),
			exactGrader({
				passed: options.rubric,
				specHash: rubricSpec(task),
				checkCode: "semantic-rubric",
				type: "judge",
				name: `${task}:judge`,
			}),
		];
	}

	function answerGraders(task: string, options: { keyword: boolean; rubric: boolean }): GraderResult[] {
		return [
			exactGrader({ passed: options.keyword, specHash: keywordSpec(task), name: `${task}:contains` }),
			exactGrader({
				passed: options.rubric,
				specHash: rubricSpec(task),
				checkCode: "semantic-rubric",
				type: "judge",
				name: `${task}:judge`,
			}),
		];
	}

	function liveRun(): ReturnType<typeof fixture> {
		const runs: RunInput[] = [];
		for (let repetitionIndex = 0; repetitionIndex < 3; repetitionIndex += 1) {
			// Three contract cases: check_dbo is required, never called, and the
			// agent hands the question back instead of answering.
			runs.push({
				taskId: "task-complaint",
				repetitionIndex,
				trace: true,
				reply: "Для рассмотрения жалобы уточните дату списания.\nПодготовить официальный текст?",
				graders: contractGraders("task-complaint", { keyword: true, rubric: false }),
			});
			runs.push({
				taskId: "task-closure",
				repetitionIndex,
				trace: true,
				// One repetition types the tool call instead of making it.
				reply: repetitionIndex === 0
					? "<tool_call>\n<function=check_dbo>\n<parameter=contract_number>\nДБО-1\n</parameter>\n</function>\n</tool_call>"
					: "Я не имею полномочий закрывать договоры.",
				graders: contractGraders("task-closure", { keyword: repetitionIndex === 0, rubric: repetitionIndex !== 2 }),
			});
			runs.push({
				taskId: "task-fee",
				repetitionIndex,
				trace: true,
				// One repetition answers in a mix of scripts.
				reply: repetitionIndex === 1
					? "Клиент表达了不满 regarding комиссию."
					: "Укажите файл договора, чтобы я проверил тариф.",
				graders: contractGraders("task-fee", { keyword: true, rubric: false }),
			});
			// Three answer-only cases: no tool is required of them.
			runs.push({
				taskId: "task-question",
				repetitionIndex,
				trace: true,
				toolCalls: ["bash", "read"],
				reply: "Комиссия начисляется по тарифу. Что-нибудь ещё?",
				graders: answerGraders("task-question", { keyword: repetitionIndex !== 0, rubric: false }),
			});
			runs.push({
				taskId: "task-thanks",
				repetitionIndex,
				trace: true,
				reply: "Спасибо за обращение.",
				graders: answerGraders("task-thanks", { keyword: repetitionIndex === 2, rubric: false }),
			});
			// One case flips between repetitions: instability, not a defect.
			runs.push({
				taskId: "task-rights",
				repetitionIndex,
				trace: true,
				toolCalls: ["bash"],
				reply: "Вы вправе подать жалобу в течение 30 дней.",
				graders: answerGraders("task-rights", { keyword: repetitionIndex !== 2, rubric: repetitionIndex !== 2 }),
			});
		}
		return fixture({ repetitions: 3, evidenceVisibility: "development", runs });
	}

	it("clusters three causes across the corpus instead of one mode per case", () => {
		const value = liveRun();
		const brief = compileImprovementBrief(value.runsRoot, value.diagnosis);

		expect(brief.modes.map((mode) => [mode.title, mode.scope, mode.impact.affectedTasks])).toEqual([
			["Semantic rubric check failed across tasks", "systemic", 6],
			["Output contract check failed across tasks", "systemic", 4],
			["Required tool check failed: check_dbo across tasks", "systemic", 3],
			["Task outcome instability", "task-local", 1],
		]);
		expect(brief.summary.systemicFailureModeCount).toBe(3);
		expect(brief.summary.taskLocalFailureModeCount).toBe(1);
		expect(brief.headline).toContain("Found 4 diagnosed failure mode(s); 3 repeat across tasks");
	});

	it("says what the traces show instead of restating the failed predicate", () => {
		const value = liveRun();
		const brief = compileImprovementBrief(value.runsRoot, value.diagnosis);
		const tool = brief.modes.find((mode) => mode.signature.subject === "check_dbo")!;

		expect(tool.observations).toEqual([
			{ code: "no-tool-call", runs: 9 },
			{ code: "tool-call-as-text", runs: 1 },
			{ code: "asks-a-question", runs: 3 },
			{ code: "mixed-script", runs: 1 },
		]);
		expect(tool.observedRuns).toBe(9);
		expect(tool.facts).toBe(
			"No tool was called in 9 of 9 failing runs; " +
			"1 reply printed a tool call as text instead of making one; " +
			"3 replies asked the user a question instead of answering; " +
			"1 reply mixed writing systems.",
		);
		// Every cited run carries the raw trace it was read from.
		expect(tool.evidence[0]).toMatchObject({
			taskId: "task-closure",
			excerpt: {
				toolNames: [],
				reply: expect.stringContaining("<function=check_dbo>"),
				observations: ["no-tool-call", "tool-call-as-text"],
			},
		});
		expect(tool.evidence.every((item) => item.excerpt !== null)).toBe(true);
		// A mode that is not about tools still quotes what the agent said.
		const rubric = brief.modes.find((mode) => mode.signature.checkCode === "semantic-rubric")!;
		expect(rubric.evidence.some((item) => item.excerpt?.toolNames.includes("bash"))).toBe(true);
	});

	// Session 7: a hung network read timed out 21 of 24 executions, and the panel
	// reported `7 типов сбоя` — the same sentence seven times, one per task.
	it("makes one infrastructure mode per cause, not one per case", () => {
		const runs: RunInput[] = [];
		for (const taskId of ["a", "b", "c", "d", "e", "f", "g"]) {
			for (const repetitionIndex of [0, 1, 2]) {
				runs.push({ taskId, repetitionIndex, status: "error", error: "run timed out after 300000ms" });
			}
		}
		// One case survived, and one execution died a different death.
		runs.push({ taskId: "h", repetitionIndex: 0, graders: [legacyGrader(true, "ok")] });
		runs.push({ taskId: "h", repetitionIndex: 1, graders: [legacyGrader(true, "ok")] });
		runs.push({
			taskId: "h",
			repetitionIndex: 2,
			status: "error",
			error: "command Target exited with 7: agent gave up",
		});
		const value = fixture({ repetitions: 3, evidenceVisibility: "development", runs });
		const brief = compileImprovementBrief(value.runsRoot, value.diagnosis);
		const infrastructure = brief.modes.filter((mode) => mode.signature.kind === "infrastructure-error");

		// Two causes, two modes — not twenty-two rows, and not one merged blob.
		expect(infrastructure.map((mode) => [mode.signature.subject, mode.title, mode.impact.failedOccurrences]))
			.toEqual([
				["timeout", "Evidence-path failure: model timeout", 21],
				["exit", "Evidence-path failure: the agent process ended", 1],
			]);
		const timeout = infrastructure[0]!;
		// Counted in runs against the whole evaluation: 21 of 24 ended this way.
		expect(timeout.impact).toMatchObject({ failedOccurrences: 21, passedOccurrences: 2, affectedTasks: 7, totalTasks: 8 });
		expect(timeout.facts).toBe(
			"21 of 23 run(s) ended at model timeout; this is evidence about the evaluation path, not about Target behavior.",
		);
		// The tasks it hit are the list INSIDE the one mode.
		expect(timeout.taskIds).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
		expect(timeout.scope).toBe("systemic");
		// Never a harness change: an infrastructure mode is stabilize-and-rerun.
		expect(infrastructure.every((mode) => mode.decision === "repair-evidence-path")).toBe(true);
		expect(brief.proposalEligible).toBe(false);
		// One mode id per cause, and the two causes are not the same mode.
		expect(new Set(infrastructure.map((mode) => mode.failureModeId)).size).toBe(2);
	});

	it("keeps the failure mode id a stable function of the family alone", () => {
		const value = liveRun();
		const brief = compileImprovementBrief(value.runsRoot, value.diagnosis);
		const tool = brief.modes.find((mode) => mode.signature.subject === "check_dbo")!;

		expect(tool.failureModeId).toBe(graderFamilyModeId({ checkCode: "required-tool", subject: "check_dbo" }));
		expect(tool.signature.discriminatorHash)
			.toBe(graderFamilyDiscriminator({ checkCode: "required-tool", subject: "check_dbo" }));
		// A second tool is a second defect, never the same one.
		expect(graderFamilyModeId({ checkCode: "required-tool", subject: "search" }))
			.not.toBe(tool.failureModeId);
	});
});
