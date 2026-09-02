import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_TRAINING_MIN_SCORE,
	TRAINING_TRUNCATION_MARKER,
	TrainingExportError,
	exportTrainingData,
	MAX_TRAINING_MESSAGE_CHARS,
	type TrainingExportLine,
} from "../src/application/export-training.js";
import { CliInvocationError, parseCliInvocation } from "../src/cli-invocation.js";
import { EvalRunRecordSchema, type EvalRunRecord } from "../src/eval.js";
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
import { writeJsonArtifact } from "../src/storage/artifacts.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DEVELOPMENT_SHA = "a".repeat(40);
const CANDIDATE_SHA = "c".repeat(40);
const WORKSPACE_HASH = `sha256:${"9".repeat(64)}`;

const AGENTS_MD = `# Contract agent

Ответь по договору. Используй инструмент lookup.
`;

const TOOL_DESCRIPTOR = `schemaVersion: 1
name: lookup
description: Look up a contract by its number.
parameters:
  type: object
  properties:
    number:
      type: string
  required: [number]
command:
  argv: [tools/lookup]
timeoutMs: 5000
maxOutputBytes: 65536
output: text
permissions:
  environment: []
  network: deny
  filesystem: read-only
`;

const SNAPSHOT_MANIFEST = `id: test-target
instructions:
  agentsMd: AGENTS.md
tools:
  - tools/lookup.tool.yaml
`;

/** A two-turn conversation with one tool call and one tool result. */
function conversationTrace(options: { question: string; answer: string; toolResult: string }): string {
	return [
		JSON.stringify({ type: "message", message: { role: "user", content: options.question } }),
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Сейчас посмотрю договор." },
					{ type: "toolCall", id: "call_1", name: "lookup", arguments: { number: "42" } },
				],
			},
		}),
		JSON.stringify({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "lookup",
				isError: false,
				content: options.toolResult,
			},
		}),
		JSON.stringify({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: options.answer }] },
		}),
	].join("\n");
}

interface RunSpec {
	runId: string;
	taskId: string;
	trace: string;
	graders?: GraderResult[];
	/** Omit the workspace snapshot to model a pruned or direct-mode run. */
	workspace?: false;
	agentsMd?: string;
	status?: "completed" | "error";
	error?: string;
	/** Drop the trace artifact reference to model a run that recorded none. */
	traceless?: true;
}

interface EvalRunSpec {
	evalRunId: string;
	runs: RunSpec[];
	label?: EvalRunRecord["label"];
	purpose?: EvalRunRecord["purpose"];
	visibility?: "development" | "sealed";
	dataset?: string;
	gitSha?: string;
	baselineEvalRunId?: string;
	candidateOf?: string;
}

const runtime = {
	piVersion: "0.84.3",
	piSha: "b".repeat(40),
	ahdeVersion: "0.1.0",
	ahdeCodeHash: `sha256:${"c".repeat(64)}`,
};
const model = modelFingerprint({
	provider: "qwen-internal",
	id: "qwen3.5-27b",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:9901/v1",
	apiKeyEnv: "TEST_MODEL_KEY",
	thinkingLevel: "off",
	params: {},
	spec: {},
});
const execution = executionFingerprint("isolated");

function passingGraders(): GraderResult[] {
	return [{ name: "answer", type: "output_contains", passed: true, score: 1, reason: "ok" }];
}

function writeEvalRun(runsRoot: string, spec: EvalRunSpec): void {
	const label = spec.label ?? "solo";
	const gitSha = spec.gitSha ?? DEVELOPMENT_SHA;
	const dataset = spec.dataset ?? "development";
	const evaluation = {
		suiteId: "suite",
		suiteHash: `sha256:${"d".repeat(64)}`,
		dataset,
		datasetHash: `sha256:${"e".repeat(64)}`,
	};
	const target = { id: "test-target", gitSha, workspaceHash: WORKSPACE_HASH };

	const records = spec.runs.map((run): RunRecord => {
		const runDir = join(runsRoot, run.runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "session.jsonl"), `${run.trace}\n`);
		if (run.workspace !== false) {
			const workspace = join(runDir, "workspace");
			mkdirSync(join(workspace, "tools"), { recursive: true });
			writeFileSync(join(workspace, "manifest.yaml"), SNAPSHOT_MANIFEST);
			writeFileSync(join(workspace, "AGENTS.md"), run.agentsMd ?? AGENTS_MD);
			writeFileSync(join(workspace, "tools", "lookup.tool.yaml"), TOOL_DESCRIPTOR);
		}
		const status = run.status ?? "completed";
		const graders = run.graders ?? passingGraders();
		const record: RunRecord = {
			schemaVersion: 1,
			runId: run.runId,
			taskId: run.taskId,
			repetitionIndex: 0,
			label,
			status,
			error: status === "error" ? (run.error ?? "model endpoint unreachable") : null,
			startedAt: "2026-08-31T10:00:00.000Z",
			finishedAt: "2026-08-31T10:00:01.000Z",
			target,
			runtime,
			model,
			execution,
			eval: evaluation,
			trace: run.traceless
				? { path: "session.jsonl", sessionId: null, sha256: null }
				: { path: "session.jsonl", sessionId: run.runId, sha256: hashFile(`${run.trace}\n`) },
			metrics: {
				tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 },
				costUsd: 0,
				latencyMs: 10,
				toolCalls: 1,
				toolErrors: 0,
				recoveryAttempts: 0,
			},
			evalResults: status === "error"
				? null
				: { graders, outcome: graders.every((grader) => grader.passed) ? "pass" : "fail" },
			parent: { evalRunId: spec.evalRunId, candidateOf: label === "candidate" ? (spec.candidateOf ?? null) : null },
		};
		writeJsonArtifact(join(runDir, "run.json"), RunRecordSchema, record);
		return record;
	});

	const evidence = { runtime, model, judge: null, execution, eval: evaluation };
	const pass = records.filter((run) => run.status === "completed" && run.evalResults?.outcome === "pass").length;
	const fail = records.filter((run) => run.status === "completed" && run.evalResults?.outcome === "fail").length;
	const error = records.filter((run) => run.status === "error").length;
	const evalRun: EvalRunRecord = {
		schemaVersion: 3,
		purpose: spec.purpose ?? "evidence",
		evalRunId: spec.evalRunId,
		target,
		label,
		baselineEvalRunId: label === "candidate" ? (spec.baselineEvalRunId ?? null) : null,
		provenance: provenanceAxes(evidence),
		provenanceKey: provenanceKey(evidence),
		suiteId: evaluation.suiteId,
		suiteHash: evaluation.suiteHash,
		dataset,
		datasetHash: evaluation.datasetHash,
		evidenceVisibility: spec.visibility ?? "development",
		taskIds: records.map((run) => run.taskId),
		repetitions: 1,
		runIds: records.map((run) => run.runId),
		runArtifacts: records.map((run) => ({ runId: run.runId, sha256: hashValue(run) })),
		startedAt: "2026-08-31T10:00:00.000Z",
		finishedAt: "2026-08-31T10:00:02.000Z",
		summary: {
			total: records.length,
			pass,
			fail,
			error,
			allPassRate: records.length === 0 ? 0 : pass / records.length,
		},
	};
	writeJsonArtifact(join(runsRoot, spec.evalRunId, "eval_run.json"), EvalRunRecordSchema, evalRun);
}

function newRunsRoot(): string {
	const runsRoot = mkdtempSync(join(tmpdir(), "ahde-export-training-"));
	roots.push(runsRoot);
	return runsRoot;
}

function readLines(path: string): TrainingExportLine[] {
	const content = readFileSync(path, "utf8");
	return content
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as TrainingExportLine);
}

function totalSkipped(counts: { skipped: Record<string, number> }): number {
	return Object.values(counts.skipped).reduce((sum, value) => sum + value, 0);
}

describe("ahde export --training: the exported line", () => {
	it("carries the harness the run saw, the whole conversation, and its evidence", () => {
		const runsRoot = newRunsRoot();
		writeEvalRun(runsRoot, {
			evalRunId: "erun_dev",
			runs: [{
				runId: "run_dev_1",
				taskId: "task_001",
				trace: conversationTrace({
					question: "Проверь договор 42.",
					answer: "Договор 42 действует.",
					toolResult: "contract 42: active",
				}),
			}],
		});

		const result = exportTrainingData({ runsRoot, evalRunId: "erun_dev" });
		expect(result.counts.exported).toBe(1);
		const [line] = readLines(result.path);
		expect(line).toBeDefined();

		// The system message is the effective instructions AS THAT RUN SAW THEM.
		expect(line!.messages[0]).toEqual({ role: "system", content: AGENTS_MD });
		expect(line!.messages.map((message) => message.role))
			.toEqual(["system", "user", "assistant", "tool", "assistant"]);
		expect(line!.messages[1]).toEqual({ role: "user", content: "Проверь договор 42." });
		expect(line!.messages[2]).toEqual({
			role: "assistant",
			tool_calls: [{
				id: "call_1",
				type: "function",
				function: { name: "lookup", arguments: JSON.stringify({ number: "42" }) },
			}],
			content: "Сейчас посмотрю договор.",
		});
		expect(line!.messages[3]).toEqual({
			role: "tool",
			name: "lookup",
			tool_call_id: "call_1",
			content: "contract 42: active",
		});
		expect(line!.messages[4]).toEqual({ role: "assistant", content: "Договор 42 действует." });

		// Built-in capabilities carry no invented schema; the declared tool carries
		// exactly the JSON Schema the harness declared.
		expect(line!.tools.map((tool) => tool.function.name)).toEqual(["bash", "edit", "read", "write", "lookup"]);
		for (const builtin of line!.tools.slice(0, 4)) {
			expect(builtin.function.parameters).toBeUndefined();
			expect(builtin.function.description).toContain("Built-in Target capability");
		}
		expect(line!.tools[4]).toEqual({
			type: "function",
			function: {
				name: "lookup",
				description: "Look up a contract by its number.",
				parameters: {
					type: "object",
					properties: { number: { type: "string" } },
					required: ["number"],
				},
			},
		});

		expect(line!.meta).toEqual({
			taskId: "task_001",
			runId: "run_dev_1",
			evalRunId: "erun_dev",
			targetSha: DEVELOPMENT_SHA,
			workspaceHash: WORKSPACE_HASH,
			model: "qwen3.5-27b",
			graders: [{ type: "output_contains", passed: true, score: 1 }],
			score: 1,
			passed: true,
			repetition: 0,
		});
	});

	it("keeps an assistant turn that only called a tool, and one that only spoke", () => {
		const runsRoot = newRunsRoot();
		const trace = [
			JSON.stringify({ type: "message", message: { role: "user", content: "go" } }),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call_a", name: "lookup", arguments: {} }],
				},
			}),
			JSON.stringify({
				type: "message",
				message: { role: "toolResult", toolCallId: "call_a", toolName: "lookup", content: "done" },
			}),
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "готово" }] } }),
		].join("\n");
		writeEvalRun(runsRoot, { evalRunId: "erun_shape", runs: [{ runId: "run_shape", taskId: "task_shape", trace }] });

		const [line] = readLines(exportTrainingData({ runsRoot, evalRunId: "erun_shape" }).path);
		expect(line!.messages[2]).toEqual({
			role: "assistant",
			tool_calls: [{ id: "call_a", type: "function", function: { name: "lookup", arguments: "{}" } }],
		});
		expect(line!.messages[2]!.content).toBeUndefined();
		expect(line!.messages[4]).toEqual({ role: "assistant", content: "готово" });
	});

	it("truncates oversized content with a marker instead of dropping the message", () => {
		const runsRoot = newRunsRoot();
		const flood = "п".repeat(MAX_TRAINING_MESSAGE_CHARS + 500);
		const trace = [
			JSON.stringify({ type: "message", message: { role: "user", content: flood } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
		].join("\n");
		writeEvalRun(runsRoot, { evalRunId: "erun_big", runs: [{ runId: "run_big", taskId: "task_big", trace }] });

		const [line] = readLines(exportTrainingData({ runsRoot, evalRunId: "erun_big" }).path);
		expect(line!.messages).toHaveLength(3);
		expect(line!.messages[1]!.content).toHaveLength(MAX_TRAINING_MESSAGE_CHARS + TRAINING_TRUNCATION_MARKER.length);
		expect(line!.messages[1]!.content?.endsWith(TRAINING_TRUNCATION_MARKER)).toBe(true);
		expect(line!.messages[2]).toEqual({ role: "assistant", content: "ok" });
	});
});

describe("ahde export --training: sealed evidence never leaves", () => {
	/**
	 * The sentinel is a sealed holdout task's own input, repeated in every place
	 * an export could plausibly read it from: the task id, the conversation, the
	 * tool result, and the instructions of that run's snapshot.
	 */
	const SENTINEL = "SEALED-HOLDOUT-SENTINEL-9f3c";

	function sealedCorpusFixture(): string {
		const runsRoot = newRunsRoot();
		writeEvalRun(runsRoot, {
			evalRunId: "erun_sealed",
			visibility: "sealed",
			dataset: "sealed-holdout",
			runs: [{
				runId: "run_sealed",
				taskId: `holdout-${SENTINEL}`,
				agentsMd: `# Holdout harness\n${SENTINEL}\n`,
				trace: conversationTrace({
					question: `Реши задачу ${SENTINEL}.`,
					answer: `Ответ на ${SENTINEL}.`,
					toolResult: SENTINEL,
				}),
			}],
		});
		writeEvalRun(runsRoot, {
			evalRunId: "erun_dev",
			runs: [{
				runId: "run_dev",
				taskId: "task_dev",
				trace: conversationTrace({ question: "обычный вопрос", answer: "обычный ответ", toolResult: "ok" }),
			}],
		});
		return runsRoot;
	}

	it("never writes a sealed task's sentinel with --all, and counts the refusal", () => {
		const runsRoot = sealedCorpusFixture();
		const result = exportTrainingData({ runsRoot, all: true });

		expect(readFileSync(result.path, "utf8")).not.toContain(SENTINEL);
		expect(result.counts.exported).toBe(1);
		expect(result.counts.skipped.sealed).toBe(1);
		expect(readLines(result.path).map((line) => line.meta.evalRunId)).toEqual(["erun_dev"]);
		expect(result.notes.some((note) => note.reason === "sealed")).toBe(true);
	});

	it("refuses a sealed eval run named explicitly", () => {
		const runsRoot = sealedCorpusFixture();
		expect(() => exportTrainingData({ runsRoot, evalRunId: "erun_sealed" }))
			.toThrow(TrainingExportError);
		expect(() => exportTrainingData({ runsRoot, evalRunId: "erun_sealed" }))
			.toThrow(/sealed holdout evidence is never exported/);
	});

	it("refuses a legacy sealed dataset hash the caller supplies", () => {
		const runsRoot = newRunsRoot();
		writeEvalRun(runsRoot, {
			evalRunId: "erun_legacy",
			runs: [{ runId: "run_legacy", taskId: `task-${SENTINEL}`, trace: conversationTrace({ question: SENTINEL, answer: SENTINEL, toolResult: SENTINEL }) }],
		});
		// The record calls itself development; the project's sealed corpus hashes
		// say otherwise, and the export believes the corpus.
		const legacyPath = join(runsRoot, "erun_legacy", "eval_run.json");
		const record = JSON.parse(readFileSync(legacyPath, "utf8")) as Record<string, unknown>;
		delete record.evidenceVisibility;
		writeFileSync(legacyPath, `${JSON.stringify(record)}\n`);

		const result = exportTrainingData({
			runsRoot,
			all: true,
			sealedDatasetHashes: new Set([`sha256:${"e".repeat(64)}`]),
		});
		expect(result.counts.exported).toBe(0);
		expect(result.counts.skipped.sealed).toBe(1);
		expect(readFileSync(result.path, "utf8")).not.toContain(SENTINEL);
	});
});

describe("ahde export --training: what is not evidence is not training data", () => {
	it("refuses a cheap-check screen and an ambiguous legacy one-arm record", () => {
		const runsRoot = newRunsRoot();
		const trace = conversationTrace({ question: "q", answer: "a", toolResult: "r" });
		writeEvalRun(runsRoot, {
			evalRunId: "erun_screen",
			purpose: "screen",
			runs: [{ runId: "run_screen", taskId: "task_screen", trace }],
		});
		writeEvalRun(runsRoot, {
			evalRunId: "erun_legacy_unknown",
			purpose: "legacy-unknown",
			runs: [{ runId: "run_legacy_unknown", taskId: "task_legacy", trace }],
		});
		writeEvalRun(runsRoot, { evalRunId: "erun_ok", runs: [{ runId: "run_ok", taskId: "task_ok", trace }] });

		const result = exportTrainingData({ runsRoot, all: true });
		expect(result.counts.exported).toBe(1);
		expect(result.counts.skipped.screen).toBe(2);
		expect(readLines(result.path).map((line) => line.meta.runId)).toEqual(["run_ok"]);
		expect(() => exportTrainingData({ runsRoot, evalRunId: "erun_screen" }))
			.toThrow(/cheap-check screen is never evidence/);
	});

	it("excludes A/A calibration arms unless asked, and keeps ordinary candidate arms", () => {
		const runsRoot = newRunsRoot();
		const trace = conversationTrace({ question: "q", answer: "a", toolResult: "r" });
		// An A/A pair: baseline and candidate on the SAME revision.
		writeEvalRun(runsRoot, { evalRunId: "erun_aa_base", label: "baseline", runs: [{ runId: "run_aa_base", taskId: "task_aa", trace }] });
		writeEvalRun(runsRoot, {
			evalRunId: "erun_aa_cand",
			label: "candidate",
			baselineEvalRunId: "erun_aa_base",
			candidateOf: DEVELOPMENT_SHA,
			runs: [{ runId: "run_aa_cand", taskId: "task_aa", trace }],
		});
		// An ordinary improvement pair: the revisions differ.
		writeEvalRun(runsRoot, { evalRunId: "erun_b_base", label: "baseline", runs: [{ runId: "run_b_base", taskId: "task_b", trace }] });
		writeEvalRun(runsRoot, {
			evalRunId: "erun_b_cand",
			label: "candidate",
			gitSha: CANDIDATE_SHA,
			baselineEvalRunId: "erun_b_base",
			candidateOf: DEVELOPMENT_SHA,
			runs: [{ runId: "run_b_cand", taskId: "task_b", trace }],
		});

		const excluded = exportTrainingData({ runsRoot, all: true });
		expect(excluded.counts.skipped.aa).toBe(2);
		expect(new Set(readLines(excluded.path).map((line) => line.meta.runId)))
			.toEqual(new Set(["run_b_base", "run_b_cand"]));

		const included = exportTrainingData({ runsRoot, all: true, includeAa: true });
		expect(included.counts.skipped.aa).toBe(0);
		expect(included.counts.exported).toBe(4);
	});

	it("never exports an infrastructure error, a traceless run, or a run without its workspace snapshot", () => {
		const runsRoot = newRunsRoot();
		const trace = conversationTrace({ question: "q", answer: "a", toolResult: "r" });
		writeEvalRun(runsRoot, {
			evalRunId: "erun_infra",
			runs: [
				{ runId: "run_error", taskId: "task_error", trace, status: "error", error: "model endpoint unreachable" },
				{ runId: "run_traceless", taskId: "task_traceless", trace, traceless: true },
				{ runId: "run_ok", taskId: "task_ok", trace },
			],
		});

		const result = exportTrainingData({ runsRoot, all: true });
		expect(result.counts.exported).toBe(1);
		expect(result.counts.skipped.infra).toBe(2);
		expect(readLines(result.path).map((line) => line.meta.runId)).toEqual(["run_ok"]);

		// A whole eval run whose members carry no workspace snapshot has no
		// reconstructable system message, and the current checkout never stands in.
		const pruned = newRunsRoot();
		writeEvalRun(pruned, {
			evalRunId: "erun_pruned",
			runs: [{ runId: "run_pruned", taskId: "task_pruned", trace, workspace: false }],
		});
		const prunedResult = exportTrainingData({ runsRoot: pruned, all: true });
		expect(prunedResult.counts.exported).toBe(0);
		expect(prunedResult.counts.skipped.infra).toBe(1);
		expect(prunedResult.notes[0]?.detail).toContain("workspace snapshot");
	});
});

describe("ahde export --training: redaction", () => {
	it("redacts credentials in the instructions, the conversation, and the tool result", () => {
		const runsRoot = newRunsRoot();
		const trace = [
			JSON.stringify({
				type: "message",
				message: { role: "user", content: "используй sk-usersecret1234567890 для доступа" },
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Authorization: Bearer assistantsecret1234567890" },
						{ type: "toolCall", id: "call_1", name: "lookup", arguments: { api_key: "argumentsecret1234567890" } },
					],
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "lookup",
					content: "log line: ghp_toolresultsecret1234567890 was used",
				},
			}),
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "готово" }] } }),
		].join("\n");
		writeEvalRun(runsRoot, {
			evalRunId: "erun_secret",
			runs: [{
				runId: "run_secret",
				taskId: "task_secret",
				agentsMd: 'AWS key: AKIAIOSFODNN7EXAMPLE\napi_key: "instructionsecret1234567890"\n',
				trace,
			}],
		});

		const result = exportTrainingData({ runsRoot, evalRunId: "erun_secret" });
		const raw = readFileSync(result.path, "utf8");
		for (const secret of [
			"sk-usersecret1234567890",
			"assistantsecret1234567890",
			"argumentsecret1234567890",
			"ghp_toolresultsecret1234567890",
			"AKIAIOSFODNN7EXAMPLE",
			"instructionsecret1234567890",
		]) {
			expect(raw).not.toContain(secret);
		}
		const [line] = readLines(result.path);
		expect(line!.messages[0]!.content).toContain("[REDACTED_AWS_ACCESS_KEY]");
		expect(line!.messages[1]!.content).toContain("[REDACTED_API_KEY]");
		expect(line!.messages[2]!.content).toContain("[REDACTED_TOKEN]");
		expect(line!.messages[2]!.tool_calls?.[0]?.function.arguments).toContain("[REDACTED]");
		expect(line!.messages[3]!.content).toContain("[REDACTED_GITHUB_TOKEN]");
	});
});

describe("ahde export --training: the selection bar", () => {
	function scoredFixture(): string {
		const runsRoot = newRunsRoot();
		const trace = conversationTrace({ question: "q", answer: "a", toolResult: "r" });
		writeEvalRun(runsRoot, {
			evalRunId: "erun_scores",
			runs: [
				{ runId: "run_perfect", taskId: "task_perfect", trace },
				{
					runId: "run_partial",
					taskId: "task_partial",
					trace,
					graders: [
						{ name: "a", type: "output_contains", passed: true, score: 1, reason: "ok" },
						{ name: "b", type: "output_contains", passed: false, score: 0, reason: "missing" },
					],
				},
				{
					runId: "run_zero",
					taskId: "task_zero",
					trace,
					graders: [{ name: "a", type: "output_contains", passed: false, score: 0, reason: "missing" }],
				},
			],
		});
		return runsRoot;
	}

	it("defaults to only the runs whose graders were completely satisfied", () => {
		const runsRoot = scoredFixture();
		const result = exportTrainingData({ runsRoot, all: true });
		expect(DEFAULT_TRAINING_MIN_SCORE).toBe(1);
		expect(result.counts.exported).toBe(1);
		expect(result.counts.skipped.failed).toBe(2);
		expect(readLines(result.path).map((line) => line.meta.runId)).toEqual(["run_perfect"]);
	});

	it("lets --min-score take partial credit", () => {
		const runsRoot = scoredFixture();
		const result = exportTrainingData({ runsRoot, all: true, minScore: 0.5 });
		expect(result.counts.exported).toBe(2);
		expect(result.counts.skipped.failed).toBe(1);
		expect(readLines(result.path).map((line) => [line.meta.runId, line.meta.score, line.meta.passed]))
			.toEqual([["run_perfect", 1, true], ["run_partial", 0.5, true]]);
	});

	it("writes the rest with passed:false under --include-failed", () => {
		const runsRoot = scoredFixture();
		const result = exportTrainingData({ runsRoot, all: true, includeFailed: true });
		expect(result.counts.exported).toBe(3);
		expect(result.counts.skipped.failed).toBe(0);
		expect(readLines(result.path).map((line) => [line.meta.runId, line.meta.passed]))
			.toEqual([["run_perfect", true], ["run_partial", false], ["run_zero", false]]);
	});

	it("refuses a --min-score outside [0,1]", () => {
		const runsRoot = scoredFixture();
		expect(() => exportTrainingData({ runsRoot, all: true, minScore: 1.5 }))
			.toThrow(/--min-score must be between 0 and 1/);
	});
});

describe("ahde export --training: output and refusals", () => {
	it("defaults the output under <runs-root>/exports/ and counts every scanned run", () => {
		const runsRoot = newRunsRoot();
		const trace = conversationTrace({ question: "q", answer: "a", toolResult: "r" });
		writeEvalRun(runsRoot, {
			evalRunId: "erun_out",
			runs: [
				{ runId: "run_out_1", taskId: "task_1", trace },
				{ runId: "run_out_2", taskId: "task_2", trace, status: "error" },
			],
		});
		writeEvalRun(runsRoot, {
			evalRunId: "erun_out_sealed",
			visibility: "sealed",
			runs: [{ runId: "run_out_sealed", taskId: "task_3", trace }],
		});

		const result = exportTrainingData({
			runsRoot,
			all: true,
			now: () => new Date("2026-09-01T12:34:56.789Z"),
		});
		expect(result.path).toBe(join(runsRoot, "exports", "training-2026-09-01T12-34-56-789Z.jsonl"));
		expect(result.counts.evalRunsScanned).toBe(2);
		expect(result.counts.runsScanned).toBe(3);
		expect(result.counts.exported + totalSkipped(result.counts)).toBe(result.counts.runsScanned);
	});

	it("honours an explicit --out", () => {
		const runsRoot = newRunsRoot();
		writeEvalRun(runsRoot, {
			evalRunId: "erun_explicit_out",
			runs: [{ runId: "run_explicit_out", taskId: "task_1", trace: conversationTrace({ question: "q", answer: "a", toolResult: "r" }) }],
		});
		const outPath = join(runsRoot, "elsewhere", "corpus.jsonl");
		const result = exportTrainingData({ runsRoot, all: true, outPath });
		expect(result.path).toBe(outPath);
		expect(readLines(outPath)).toHaveLength(1);
	});

	it("writes an empty file rather than a partial one when nothing qualifies", () => {
		const runsRoot = newRunsRoot();
		const result = exportTrainingData({ runsRoot, all: true });
		expect(result.counts.exported).toBe(0);
		expect(readFileSync(result.path, "utf8")).toBe("");
	});

	/** cli.ts maps every TrainingExportError to exit 2. */
	it("refuses a missing eval run", () => {
		const runsRoot = newRunsRoot();
		expect(() => exportTrainingData({ runsRoot, evalRunId: "erun_missing" }))
			.toThrow(TrainingExportError);
		expect(() => exportTrainingData({ runsRoot, evalRunId: "erun_missing" }))
			.toThrow(/erun_missing is unavailable/);
	});

	it("refuses an eval run whose member run artifact is missing", () => {
		const runsRoot = newRunsRoot();
		writeEvalRun(runsRoot, {
			evalRunId: "erun_broken",
			runs: [{ runId: "run_broken", taskId: "task_1", trace: conversationTrace({ question: "q", answer: "a", toolResult: "r" }) }],
		});
		rmSync(join(runsRoot, "run_broken", "run.json"));
		const result = exportTrainingData({ runsRoot, all: true });
		expect(result.counts.exported).toBe(0);
		expect(result.counts.skipped.infra).toBe(1);
	});

	it("refuses a selection that is neither one eval run nor all of them", () => {
		const runsRoot = newRunsRoot();
		expect(() => exportTrainingData({ runsRoot }))
			.toThrow(/either one --eval <erun-id> or --all/);
		expect(() => exportTrainingData({ runsRoot, evalRunId: "erun_dev", all: true }))
			.toThrow(/either one --eval <erun-id> or --all/);
	});
});

describe("ahde export --training: invocation", () => {
	it("parses the documented forms", () => {
		expect(parseCliInvocation(["export", "--training", "--target", "./agent", "--all"])).toEqual({
			kind: "command",
			command: "export",
			action: null,
			flags: { training: "true", target: "./agent", all: "true" },
			positionals: [],
		});
		expect(parseCliInvocation([
			"export", "--training", "--target", "./agent", "--project", "demo",
			"--eval", "erun_1", "--out", "./training.jsonl", "--min-score", "0.8",
			"--include-failed", "--include-aa",
		])).toEqual({
			kind: "command",
			command: "export",
			action: null,
			flags: {
				training: "true",
				target: "./agent",
				project: "demo",
				eval: "erun_1",
				out: "./training.jsonl",
				"min-score": "0.8",
				"include-failed": "true",
				"include-aa": "true",
			},
			positionals: [],
		});
	});

	it.each([
		[["export", "--target", "./agent", "--all"], /missing required flag --training/],
		[["export", "--training", "--all"], /missing required flag --target/],
		[["export", "--training", "--target", "./agent"], /either --eval <erun-id> or --all/],
		[["export", "--training", "--target", "./agent", "--eval", "erun_1", "--all"], /either --eval <erun-id> or --all/],
		[["export", "--training", "--target", "./agent", "--all", "--min-score", "high"], /--min-score for export must be a pass rate/],
	] as const)("refuses %j", (argv, message) => {
		expect(() => parseCliInvocation(argv)).toThrow(CliInvocationError);
		expect(() => parseCliInvocation(argv)).toThrow(message);
	});
});
