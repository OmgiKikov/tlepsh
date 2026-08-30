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
} from "../src/application/improvement-brief.js";
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
}): GraderResult {
	return {
		name: options.name ?? "required-answer",
		type: options.type ?? "output_contains",
		passed: options.passed,
		score: options.passed ? 1 : 0,
		reason: options.reason ?? (options.passed ? "required answer present" : "required answer missing"),
		specHash: options.specHash,
		checkCode: options.checkCode ?? "output-contains",
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
			const trace = `${JSON.stringify({
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: `answer:${runId}` }] },
			})}\n`;
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
		schemaVersion: 2,
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
				discriminatorHash: hashValue({ checkCode: "output-contains", specHash }),
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
			signature: { kind: "grader-check", checkCode: "output-contains", specHash },
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
		expect(infrastructure).toMatchObject({
			scope: "task-local",
			severity: "blocking",
			decision: "repair-evidence-path",
			impact: { failedOccurrences: 1, passedOccurrences: 1, reproductionBps: 5_000 },
		});
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
			runs.push({
				taskId,
				repetitionIndex: 0,
				graders: [exactGrader({
					passed: false,
					specHash,
					reason: `failure-${index} ${"x".repeat(600)} sk-boundedsecret1234567890`,
				})],
			});
			runs.push({ taskId, repetitionIndex: 1, graders: [exactGrader({ passed: true, specHash })] });
		}
		const value = fixture({ repetitions: 2, evidenceVisibility: "development", runs });

		const brief = compileImprovementBrief(value.runsRoot, value.diagnosis);
		expect(brief.summary).toMatchObject({
			tasks: 105,
			failedTasks: 105,
			failureModeCount: 106,
			systemicFailureModeCount: 1,
			taskLocalFailureModeCount: 105,
			omittedFailureModeCount: 76,
		});
		expect(brief.modes).toHaveLength(30);
		const systemic = brief.modes[0];
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
				const specHash = hashValue({ type: "output_contains", modeIndex });
				for (let duplicate = 0; duplicate < 8; duplicate += 1) {
					graders.push(exactGrader({
						passed: false,
						specHash,
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
			rootCause: `Host-derived hypothesis (not proven): ${mode.hypothesis}`,
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
