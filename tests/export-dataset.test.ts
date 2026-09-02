import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DATASET_TRUNCATION_MARKER,
	DEFAULT_DATASET_MIN_SCORE,
	DatasetExportError,
	corpusTaskLookup,
	datasetExportOptionsFromFlags,
	datasetLine,
	exportDataset,
	renderDatasetExportSummary,
	runAgentKind,
	MAX_DATASET_MESSAGE_CHARS,
	type DatasetExportLine,
	type DatasetTaskFacts,
	type DatasetTaskLookup,
} from "../src/application/export-dataset.js";
import { corpusDatasetLabel } from "../src/application/corpus-target.js";
import { createCorpus } from "../src/corpus.js";
import {
	CliInvocationError,
	parseCliInvocation,
	type ParsedCliInvocation,
} from "../src/cli-invocation.js";
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
import { isPrivateWorkspacePath } from "../src/runner.js";
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
	/** What the world lane writes at runs/<runId>/runtime/world/state.json. */
	finalWorld?: Record<string, unknown>;
	/** Judge verdict sidecars by grader index, as eval.ts writes them. */
	verdicts?: Record<number, Record<string, unknown>>;
	/** What the conversation actually did, when a model played the user. */
	conversation?: { turns: number; stop: "max-turns" | "sentinel" | "stop-when" };
}

interface EvalRunSpec {
	evalRunId: string;
	runs: RunSpec[];
	label?: EvalRunRecord["label"];
	purpose?: EvalRunRecord["purpose"];
	visibility?: "development" | "sealed";
	dataset?: string;
	datasetHash?: string;
	gitSha?: string;
	baselineEvalRunId?: string;
	candidateOf?: string;
	finishedAt?: string;
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
		datasetHash: spec.datasetHash ?? `sha256:${"e".repeat(64)}`,
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
		if (run.finalWorld) {
			mkdirSync(join(runDir, "runtime", "world"), { recursive: true });
			writeFileSync(join(runDir, "runtime", "world", "state.json"), `${JSON.stringify(run.finalWorld)}\n`);
		}
		if (run.verdicts) {
			mkdirSync(join(runDir, "judge"), { recursive: true });
			for (const [index, verdict] of Object.entries(run.verdicts)) {
				writeFileSync(join(runDir, "judge", `${index}.verdict.json`), `${JSON.stringify(verdict)}\n`);
			}
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
				...(run.conversation
					? { conversationTurns: run.conversation.turns, conversationStop: run.conversation.stop }
					: {}),
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
		finishedAt: spec.finishedAt ?? "2026-08-31T10:00:02.000Z",
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
	const runsRoot = mkdtempSync(join(tmpdir(), "ahde-export-dataset-"));
	roots.push(runsRoot);
	return runsRoot;
}

function readLines(path: string): DatasetExportLine[] {
	const content = readFileSync(path, "utf8");
	return content
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as DatasetExportLine);
}

/** The flag map the CLI hands the export, produced by the real parser. */
function commandFlags(argv: readonly string[]): ParsedCliInvocation["flags"] {
	const parsed = parseCliInvocation(argv);
	expect(parsed.kind).toBe("command");
	return (parsed as ParsedCliInvocation).flags;
}

function totalSkipped(counts: { skipped: Record<string, number> }): number {
	return Object.values(counts.skipped).reduce((sum, value) => sum + value, 0);
}

/** A hand-built lookup, for the world and the user a case declared. */
function tasksNamed(entries: Record<string, DatasetTaskFacts>): DatasetTaskLookup {
	return () => new Map(Object.entries(entries));
}

describe("ahde export: the exported line", () => {
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

		const result = exportDataset({ runsRoot, evalRunId: "erun_dev" });
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
			graders: [{ name: "answer", type: "output_contains", passed: true, score: 1, reason: "ok" }],
			score: 1,
			passed: true,
			repetition: 0,
			execution: { agent: "pi-v1" },
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

		const [line] = readLines(exportDataset({ runsRoot, evalRunId: "erun_shape" }).path);
		expect(line!.messages[2]).toEqual({
			role: "assistant",
			tool_calls: [{ id: "call_a", type: "function", function: { name: "lookup", arguments: "{}" } }],
		});
		expect(line!.messages[2]!.content).toBeUndefined();
		expect(line!.messages[4]).toEqual({ role: "assistant", content: "готово" });
	});

	it("truncates oversized content with a marker instead of dropping the message", () => {
		const runsRoot = newRunsRoot();
		const flood = "п".repeat(MAX_DATASET_MESSAGE_CHARS + 500);
		const trace = [
			JSON.stringify({ type: "message", message: { role: "user", content: flood } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
		].join("\n");
		writeEvalRun(runsRoot, { evalRunId: "erun_big", runs: [{ runId: "run_big", taskId: "task_big", trace }] });

		const [line] = readLines(exportDataset({ runsRoot, evalRunId: "erun_big" }).path);
		expect(line!.messages).toHaveLength(3);
		expect(line!.messages[1]!.content).toHaveLength(MAX_DATASET_MESSAGE_CHARS + DATASET_TRUNCATION_MARKER.length);
		expect(line!.messages[1]!.content?.endsWith(DATASET_TRUNCATION_MARKER)).toBe(true);
		expect(line!.messages[2]).toEqual({ role: "assistant", content: "ok" });
	});

	it("never repeats a tool call or its result in meta: the conversation already carries both", () => {
		const runsRoot = newRunsRoot();
		writeEvalRun(runsRoot, {
			evalRunId: "erun_tools",
			runs: [{
				runId: "run_tools",
				taskId: "task_tools",
				trace: conversationTrace({ question: "q", answer: "a", toolResult: "contract 42: active" }),
			}],
		});
		const [line] = readLines(exportDataset({ runsRoot, evalRunId: "erun_tools" }).path);
		expect(JSON.stringify(line!.messages)).toContain("contract 42: active");
		expect(JSON.stringify(line!.meta)).not.toContain("contract 42: active");
		expect(JSON.stringify(line!.meta)).not.toContain("call_1");
		expect(Object.keys(line!.meta)).not.toContain("toolCalls");
	});
});

describe("ahde export: sealed evidence never leaves", () => {
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
				finalWorld: { secret: SENTINEL },
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
		const result = exportDataset({ runsRoot, all: true });

		expect(readFileSync(result.path, "utf8")).not.toContain(SENTINEL);
		expect(result.counts.exported).toBe(1);
		expect(result.counts.skipped.sealed).toBe(1);
		expect(readLines(result.path).map((line) => line.meta.evalRunId)).toEqual(["erun_dev"]);
		expect(result.notes.some((note) => note.reason === "sealed")).toBe(true);
	});

	it("refuses a sealed eval run named explicitly, by --eval and by --run", () => {
		const runsRoot = sealedCorpusFixture();
		expect(() => exportDataset({ runsRoot, evalRunId: "erun_sealed" }))
			.toThrow(DatasetExportError);
		expect(() => exportDataset({ runsRoot, evalRunId: "erun_sealed" }))
			.toThrow(/sealed holdout evidence is never exported/);
		// A sealed member run is not a way around the sealed eval run above it.
		expect(() => exportDataset({ runsRoot, runId: "run_sealed" }))
			.toThrow(/sealed holdout evidence is never exported/);
	});

	it("never lets --latest land on a sealed eval run, however recent it is", () => {
		const runsRoot = newRunsRoot();
		writeEvalRun(runsRoot, {
			evalRunId: "erun_dev",
			finishedAt: "2026-08-31T10:00:00.000Z",
			runs: [{ runId: "run_dev", taskId: "task_dev", trace: conversationTrace({ question: "q", answer: "a", toolResult: "r" }) }],
		});
		writeEvalRun(runsRoot, {
			evalRunId: "erun_sealed",
			visibility: "sealed",
			finishedAt: "2026-09-02T10:00:00.000Z",
			runs: [{
				runId: "run_sealed",
				taskId: `holdout-${SENTINEL}`,
				agentsMd: `# Holdout harness\n${SENTINEL}\n`,
				trace: conversationTrace({ question: SENTINEL, answer: SENTINEL, toolResult: SENTINEL }),
			}],
		});

		const result = exportDataset({ runsRoot, latest: true });
		expect(result.evalRunIds).toEqual(["erun_dev"]);
		expect(readFileSync(result.path, "utf8")).not.toContain(SENTINEL);
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

		const result = exportDataset({
			runsRoot,
			all: true,
			sealedDatasetHashes: new Set([`sha256:${"e".repeat(64)}`]),
		});
		expect(result.counts.exported).toBe(0);
		expect(result.counts.skipped.sealed).toBe(1);
		expect(readFileSync(result.path, "utf8")).not.toContain(SENTINEL);
	});
});

describe("ahde export: what is not evidence is not a dataset", () => {
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

		const result = exportDataset({ runsRoot, all: true });
		expect(result.counts.exported).toBe(1);
		expect(result.counts.skipped.screen).toBe(2);
		expect(readLines(result.path).map((line) => line.meta.runId)).toEqual(["run_ok"]);
		expect(() => exportDataset({ runsRoot, evalRunId: "erun_screen" }))
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

		const excluded = exportDataset({ runsRoot, all: true });
		expect(excluded.counts.skipped.aa).toBe(2);
		expect(new Set(readLines(excluded.path).map((line) => line.meta.runId)))
			.toEqual(new Set(["run_b_base", "run_b_cand"]));

		const included = exportDataset({ runsRoot, all: true, includeAa: true });
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

		const result = exportDataset({ runsRoot, all: true });
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
		const prunedResult = exportDataset({ runsRoot: pruned, all: true });
		expect(prunedResult.counts.exported).toBe(0);
		expect(prunedResult.counts.skipped.infra).toBe(1);
		expect(prunedResult.notes[0]?.detail).toContain("workspace snapshot");
	});
});

describe("ahde export: redaction", () => {
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

		const result = exportDataset({ runsRoot, evalRunId: "erun_secret" });
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

describe("ahde export: the selection bar", () => {
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
		const result = exportDataset({ runsRoot, all: true });
		expect(DEFAULT_DATASET_MIN_SCORE).toBe(1);
		expect(result.counts.exported).toBe(1);
		expect(result.counts.skipped.failed).toBe(2);
		expect(readLines(result.path).map((line) => line.meta.runId)).toEqual(["run_perfect"]);
	});

	it("lets --min-score take partial credit", () => {
		const runsRoot = scoredFixture();
		const result = exportDataset({ runsRoot, all: true, minScore: 0.5 });
		expect(result.counts.exported).toBe(2);
		expect(result.counts.skipped.failed).toBe(1);
		expect(readLines(result.path).map((line) => [line.meta.runId, line.meta.score, line.meta.passed]))
			.toEqual([["run_perfect", 1, true], ["run_partial", 0.5, true]]);
	});

	it("writes the rest with passed:false under --include-failed", () => {
		const runsRoot = scoredFixture();
		const result = exportDataset({ runsRoot, all: true, includeFailed: true });
		expect(result.counts.exported).toBe(3);
		expect(result.counts.skipped.failed).toBe(0);
		expect(readLines(result.path).map((line) => [line.meta.runId, line.meta.passed]))
			.toEqual([["run_perfect", true], ["run_partial", false], ["run_zero", false]]);
	});

	it("refuses a --min-score outside [0,1]", () => {
		const runsRoot = scoredFixture();
		expect(() => exportDataset({ runsRoot, all: true, minScore: 1.5 }))
			.toThrow(/--min-score must be between 0 and 1/);
	});
});

describe("ahde export: what is selected", () => {
	function threeEvalRuns(): string {
		const runsRoot = newRunsRoot();
		const trace = conversationTrace({ question: "q", answer: "a", toolResult: "r" });
		writeEvalRun(runsRoot, {
			evalRunId: "erun_one",
			finishedAt: "2026-08-30T10:00:00.000Z",
			runs: [
				{ runId: "run_one_a", taskId: "task_a", trace },
				{ runId: "run_one_b", taskId: "task_b", trace },
			],
		});
		writeEvalRun(runsRoot, {
			evalRunId: "erun_two",
			finishedAt: "2026-09-01T10:00:00.000Z",
			runs: [{ runId: "run_two_a", taskId: "task_a", trace }],
		});
		return runsRoot;
	}

	it("--run exports exactly that run and names the file after it", () => {
		const runsRoot = threeEvalRuns();
		const result = exportDataset({ runsRoot, runId: "run_one_b" });
		expect(result.path).toBe(join(runsRoot, "exports", "run_one_b.jsonl"));
		expect(result.counts.runsScanned).toBe(1);
		expect(readLines(result.path).map((line) => line.meta.runId)).toEqual(["run_one_b"]);
		expect(result.evalRunIds).toEqual(["erun_one"]);
	});

	it("--eval exports one eval run's members and names the file after it", () => {
		const runsRoot = threeEvalRuns();
		const result = exportDataset({ runsRoot, evalRunId: "erun_one" });
		expect(result.path).toBe(join(runsRoot, "exports", "erun_one.jsonl"));
		expect(readLines(result.path).map((line) => line.meta.runId)).toEqual(["run_one_a", "run_one_b"]);
	});

	it("--all exports every exportable eval run under one timestamped name", () => {
		const runsRoot = threeEvalRuns();
		const result = exportDataset({ runsRoot, all: true, now: () => new Date("2026-09-03T12:34:56.789Z") });
		expect(result.path).toBe(join(runsRoot, "exports", "all-2026-09-03T12-34-56-789Z.jsonl"));
		expect(result.counts.exported).toBe(3);
		expect([...result.evalRunIds].sort()).toEqual(["erun_one", "erun_two"]);
	});

	it("--latest picks the newest exportable eval run, which is what /export uses", () => {
		const runsRoot = threeEvalRuns();
		const result = exportDataset({ runsRoot, latest: true });
		expect(result.path).toBe(join(runsRoot, "exports", "erun_two.jsonl"));
		expect(readLines(result.path).map((line) => line.meta.runId)).toEqual(["run_two_a"]);
	});

	it("refuses a selection that is neither one subject nor all of them", () => {
		const runsRoot = newRunsRoot();
		expect(() => exportDataset({ runsRoot }))
			.toThrow(/one --run <run-id>, one --eval <erun-id>, or --all/);
		expect(() => exportDataset({ runsRoot, evalRunId: "erun_dev", all: true }))
			.toThrow(/one --run <run-id>, one --eval <erun-id>, or --all/);
		expect(() => exportDataset({ runsRoot, runId: "run_x", evalRunId: "erun_dev" }))
			.toThrow(/one --run <run-id>, one --eval <erun-id>, or --all/);
	});

	it("refuses a run id no readable eval run owns, and an empty --latest", () => {
		const runsRoot = newRunsRoot();
		expect(() => exportDataset({ runsRoot, runId: "run_nowhere" }))
			.toThrow(/run run_nowhere belongs to no readable eval run/);
		expect(() => exportDataset({ runsRoot, latest: true }))
			.toThrow(/no exportable development evidence has been recorded yet/);
	});
});

describe("ahde export: output and refusals", () => {
	it("defaults the output to exports/ under the Target and counts every scanned run", () => {
		const runsRoot = newRunsRoot();
		const targetDir = newRunsRoot();
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

		const result = exportDataset({
			runsRoot,
			outRoot: targetDir,
			all: true,
			now: () => new Date("2026-09-01T12:34:56.789Z"),
		});
		expect(result.path).toBe(join(targetDir, "exports", "all-2026-09-01T12-34-56-789Z.jsonl"));
		expect(result.counts.evalRunsScanned).toBe(2);
		expect(result.counts.runsScanned).toBe(3);
		expect(result.counts.exported + totalSkipped(result.counts)).toBe(result.counts.runsScanned);
	});

	it("honours an explicit --out directory and keeps the subject's own name", () => {
		const runsRoot = newRunsRoot();
		writeEvalRun(runsRoot, {
			evalRunId: "erun_explicit_out",
			runs: [{ runId: "run_explicit_out", taskId: "task_1", trace: conversationTrace({ question: "q", answer: "a", toolResult: "r" }) }],
		});
		const outDir = join(runsRoot, "elsewhere");
		const result = exportDataset({ runsRoot, evalRunId: "erun_explicit_out", outDir });
		expect(result.path).toBe(join(outDir, "erun_explicit_out.jsonl"));
		expect(readLines(result.path)).toHaveLength(1);
	});

	it("writes an empty file rather than a partial one when nothing qualifies", () => {
		const runsRoot = newRunsRoot();
		const result = exportDataset({ runsRoot, all: true });
		expect(result.counts.exported).toBe(0);
		expect(readFileSync(result.path, "utf8")).toBe("");
	});

	/** cli.ts maps every DatasetExportError to exit 2. */
	it("refuses a missing eval run", () => {
		const runsRoot = newRunsRoot();
		expect(() => exportDataset({ runsRoot, evalRunId: "erun_missing" }))
			.toThrow(DatasetExportError);
		expect(() => exportDataset({ runsRoot, evalRunId: "erun_missing" }))
			.toThrow(/erun_missing is unavailable/);
	});

	it("refuses an eval run whose member run artifact is missing", () => {
		const runsRoot = newRunsRoot();
		writeEvalRun(runsRoot, {
			evalRunId: "erun_broken",
			runs: [{ runId: "run_broken", taskId: "task_1", trace: conversationTrace({ question: "q", answer: "a", toolResult: "r" }) }],
		});
		rmSync(join(runsRoot, "run_broken", "run.json"));
		const result = exportDataset({ runsRoot, all: true });
		expect(result.counts.exported).toBe(0);
		expect(result.counts.skipped.infra).toBe(1);
	});

	it("reports an eval run index it could not read instead of silently skipping it", () => {
		const runsRoot = newRunsRoot();
		writeEvalRun(runsRoot, {
			evalRunId: "erun_good",
			runs: [{ runId: "run_good", taskId: "task_1", trace: conversationTrace({ question: "q", answer: "a", toolResult: "r" }) }],
		});
		mkdirSync(join(runsRoot, "erun_damaged"), { recursive: true });
		writeFileSync(join(runsRoot, "erun_damaged", "eval_run.json"), "{ not json");

		const result = exportDataset({ runsRoot, all: true });
		expect(result.counts.exported).toBe(1);
		expect(result.unreadableEvalRunIds).toEqual(["erun_damaged"]);
		expect(renderDatasetExportSummary(result).join("\n")).toContain("could not be read and were not scanned");
	});
});

describe("ahde export: the world a case happens in", () => {
	const trace = conversationTrace({ question: "Отмени заказ 7.", answer: "Отменил.", toolResult: "ok" });

	it("carries the state the case started from and the state the run left behind", () => {
		const runsRoot = newRunsRoot();
		writeEvalRun(runsRoot, {
			evalRunId: "erun_world",
			runs: [{
				runId: "run_world",
				taskId: "task_world",
				trace,
				finalWorld: { order: { id: 7, status: "cancelled" } },
			}],
		});

		const result = exportDataset({
			runsRoot,
			evalRunId: "erun_world",
			tasks: tasksNamed({ task_world: { world: { state: { order: { id: 7, status: "open" } } } } }),
		});
		const [line] = readLines(result.path);
		expect(line!.meta.world).toEqual({
			initial: { order: { id: 7, status: "open" } },
			final: { order: { id: 7, status: "cancelled" } },
		});
	});

	it("leaves world absent entirely on a case that has none", () => {
		const runsRoot = newRunsRoot();
		writeEvalRun(runsRoot, {
			evalRunId: "erun_no_world",
			runs: [{ runId: "run_no_world", taskId: "task_plain", trace }],
		});
		const [line] = readLines(exportDataset({ runsRoot, evalRunId: "erun_no_world" }).path);
		expect(line!.meta.world).toBeUndefined();
		expect(Object.keys(line!.meta)).not.toContain("world");
	});

	it("keeps final null when the case had a world but the run wrote no state", () => {
		const runsRoot = newRunsRoot();
		writeEvalRun(runsRoot, {
			evalRunId: "erun_world_only",
			runs: [{ runId: "run_world_only", taskId: "task_world", trace }],
		});
		const [line] = readLines(exportDataset({
			runsRoot,
			evalRunId: "erun_world_only",
			tasks: tasksNamed({ task_world: { world: { state: { order: { status: "open" } } } } }),
		}).path);
		expect(line!.meta.world).toEqual({ initial: { order: { status: "open" } }, final: null });
	});

	it("reads the case's world through the published corpus the eval run cites", () => {
		const runsRoot = newRunsRoot();
		const stateRoot = newRunsRoot();
		const corpus = createCorpus({
			stateRoot,
			projectId: "demo",
			name: "worlded",
			visibility: "development",
			tasks: [{
				id: "task_world",
				input: "Отмени заказ 7.",
				world: { state: { order: { id: 7, status: "open" } } },
				simulatedUser: { goal: "отменить заказ", persona: "торопится", maxTurns: 4 },
				graders: [{ type: "output_contains", text: "Отменил" }],
			}],
		});
		writeEvalRun(runsRoot, {
			evalRunId: "erun_corpus",
			dataset: corpusDatasetLabel("development", corpus.id),
			datasetHash: corpus.hash,
			runs: [{
				runId: "run_corpus",
				taskId: "task_world",
				trace,
				finalWorld: { order: { id: 7, status: "cancelled" } },
				conversation: { turns: 3, stop: "stop-when" },
			}],
		});

		const [line] = readLines(exportDataset({
			runsRoot,
			evalRunId: "erun_corpus",
			tasks: corpusTaskLookup({ stateRoot, projectId: "demo" }),
		}).path);
		expect(line!.meta.world).toEqual({
			initial: { order: { id: 7, status: "open" } },
			final: { order: { id: 7, status: "cancelled" } },
		});
		expect(line!.meta.simulatedUser).toEqual({
			goal: "отменить заказ",
			persona: "торопится",
			turns: 3,
			stop: "stop-when",
		});
	});

	it("carries the case's user but never invents turns the run did not record", () => {
		const runsRoot = newRunsRoot();
		writeEvalRun(runsRoot, {
			evalRunId: "erun_user",
			runs: [{ runId: "run_user", taskId: "task_user", trace }],
		});
		const [line] = readLines(exportDataset({
			runsRoot,
			evalRunId: "erun_user",
			tasks: tasksNamed({ task_user: { simulatedUser: { goal: "отменить заказ" } } }),
		}).path);
		expect(line!.meta.simulatedUser).toEqual({ goal: "отменить заказ" });
	});
});

describe("ahde export: graders, verdicts, and the agent kind", () => {
	const trace = conversationTrace({ question: "q", answer: "a", toolResult: "r" });

	it("carries every grader row run.json recorded, including an abstention the judge lane writes", () => {
		const runsRoot = newRunsRoot();
		const graders: GraderResult[] = [
			{
				name: "answers the question",
				type: "judge",
				passed: true,
				score: 1,
				reason: "the reply names the contract and its state",
				specHash: `sha256:${"1".repeat(64)}`,
				checkCode: "semantic-rubric",
				assertions: { total: 2, failed: [] },
			},
			{
				name: "calls lookup",
				type: "tool_called",
				passed: true,
				score: 1,
				reason: "lookup was called",
				specHash: `sha256:${"2".repeat(64)}`,
				checkCode: "required-tool",
				checkSubject: "lookup",
			},
		];
		writeEvalRun(runsRoot, {
			evalRunId: "erun_graders",
			runs: [{
				runId: "run_graders",
				taskId: "task_graders",
				trace,
				graders,
				verdicts: {
					0: {
						passed: true,
						score: 1,
						choice: "A",
						// A field the sidecar may grow that the line does not carry.
						juror: 1,
						assertions: [
							{ index: 1, answer: "yes", evidence: "names the contract" },
							{ index: 2, answer: "yes", evidence: "names its state" },
						],
					},
				},
			}],
		});
		const [line] = readLines(exportDataset({ runsRoot, evalRunId: "erun_graders" }).path);
		expect(line!.meta.graders).toEqual([
			{
				name: "answers the question",
				type: "judge",
				passed: true,
				score: 1,
				reason: "the reply names the contract and its state",
				checkCode: "semantic-rubric",
				assertions: { total: 2, failed: [] },
			},
			{
				name: "calls lookup",
				type: "tool_called",
				passed: true,
				score: 1,
				reason: "lookup was called",
				checkCode: "required-tool",
				checkSubject: "lookup",
			},
		]);
		// The verdict is read from the sidecar and named by the grader it decided.
		expect(line!.meta.judge).toEqual({
			verdicts: [{
				grader: 0,
				passed: true,
				score: 1,
				choice: "A",
				assertions: [
					{ index: 1, answer: "yes", evidence: "names the contract" },
					{ index: 2, answer: "yes", evidence: "names its state" },
				],
			}],
		});
		// `specHash` is grading configuration, not evidence about the answer, and
		// a sidecar field the line does not name never leaks through.
		expect(JSON.stringify(line!.meta.graders)).not.toContain("specHash");
		expect(JSON.stringify(line!.meta.judge)).not.toContain("juror");
	});

	it("leaves judge absent when no judge graded the run", () => {
		const runsRoot = newRunsRoot();
		writeEvalRun(runsRoot, { evalRunId: "erun_local", runs: [{ runId: "run_local", taskId: "task_local", trace }] });
		const [line] = readLines(exportDataset({ runsRoot, evalRunId: "erun_local" }).path);
		expect(line!.meta.judge).toBeUndefined();
	});

	/**
	 * `GraderResultSchema` is strict on master, so the judge lane's `abstained`
	 * cannot travel through `run.json` yet — a record carrying it is refused on
	 * read. The optional read path is exercised on a hand-written row instead,
	 * which is exactly what that lane will hand this module once it lands.
	 */
	it("carries a judge abstention when the grader row has one, and nothing when it does not", () => {
		const abstaining = datasetLine({
			run: {
				runId: "run_abstain",
				taskId: "task_abstain",
				repetitionIndex: 0,
				target: { gitSha: DEVELOPMENT_SHA, workspaceHash: WORKSPACE_HASH },
				model: { id: "qwen3.5-27b" },
				execution: { tools: [] },
				metrics: {},
				evalResults: {
					graders: [
						{ name: "rubric", type: "judge", passed: false, score: 0, reason: "judge declined", abstained: true },
						{ name: "plain", type: "output_contains", passed: true, score: 1, reason: "ok" },
					],
				},
			},
			evalRunId: "erun_abstain",
			harness: { system: "S", tools: [] },
			messages: [],
			score: 0.5,
			passed: false,
		});

		expect(abstaining.meta.graders[0]?.abstained).toBe(true);
		expect(abstaining.meta.graders[1]).not.toHaveProperty("abstained");
		// Only a boolean is carried: this module never decides what the field means.
		const nonBoolean = datasetLine({
			run: {
				runId: "run_odd",
				taskId: "task_odd",
				repetitionIndex: 0,
				target: { gitSha: DEVELOPMENT_SHA },
				model: { id: "m" },
				execution: { tools: [] },
				metrics: {},
				evalResults: {
					graders: [{ name: "rubric", type: "judge", passed: true, score: 1, reason: "ok", abstained: "maybe" }],
				},
			},
			evalRunId: "erun_odd",
			harness: { system: "S", tools: [] },
			messages: [],
			score: 1,
			passed: true,
		});
		expect(nonBoolean.meta.graders[0]).not.toHaveProperty("abstained");
	});

	/**
	 * `RunMetricsSchema` still requires `tokens` and `costUsd` on master, and
	 * `ExecutionFingerprintSchema` is strict, so a command-Target record cannot
	 * be written through the schema yet. The optional read path is exercised on
	 * a hand-written record instead — which is exactly what the adapter lane
	 * will hand this module once it lands.
	 */
	it("reads the agent kind off the record and fabricates no metric the record lacks", () => {
		const line = datasetLine({
			run: {
				runId: "run_cmd",
				taskId: "task_cmd",
				repetitionIndex: 0,
				target: { gitSha: DEVELOPMENT_SHA },
				model: { id: "local-command" },
				execution: { workspace: "direct-v1", tools: [], agent: "command-v1" },
				metrics: {},
				evalResults: {
					graders: [{ name: "a", type: "output_contains", passed: true, score: 1, reason: "ok" }],
				},
			},
			evalRunId: "erun_cmd",
			harness: { system: "S", tools: [] },
			messages: [],
			score: 1,
			passed: true,
		});

		expect(line.meta.execution).toEqual({ agent: "command-v1" });
		expect(line.meta.workspaceHash).toBeNull();
		// No invented zero: a metric the record does not carry is simply absent.
		const meta = JSON.stringify(line.meta);
		for (const invented of ["tokens", "costUsd", "latencyMs", "toolCalls"]) {
			expect(meta).not.toContain(invented);
		}
		expect(line.meta.simulatedUser).toBeUndefined();
		expect(line.meta.world).toBeUndefined();

		// And the default is a fact, not a fallback: every record written before
		// the field existed was a Pi invocation.
		expect(runAgentKind({ execution: { tools: [] } })).toBe("pi-v1");
		expect(runAgentKind({ execution: { agent: "command-v1" } })).toBe("command-v1");
		expect(runAgentKind({ execution: { agent: "something-else" } })).toBe("pi-v1");
	});
});

describe("ahde export: where the file lands", () => {
	/**
	 * The dataset is compiled FROM evidence, so it must never be fed back into a
	 * Target workspace snapshot: it would move the workspace hash every time an
	 * operator exported, and hand the agent its own past conversations.
	 */
	it("keeps exports/ out of every model-visible workspace snapshot", () => {
		const evaluationFiles = new Set(["evals/dataset.jsonl"]);
		for (const path of ["exports/erun_abc.jsonl", "exports/nested/all-2026.jsonl", "exports"]) {
			expect(isPrivateWorkspacePath(path, evaluationFiles, null, [])).toBe(true);
		}
		// Top-level only, exactly like `imports/`: a declared skill or tool whose
		// own directory happens to be called `exports` is not the host's file.
		expect(isPrivateWorkspacePath("skills/exports/SKILL.md", evaluationFiles, null, [])).toBe(false);
		expect(isPrivateWorkspacePath("AGENTS.md", evaluationFiles, null, [])).toBe(false);
	});
});

describe("ahde export: invocation", () => {
	it("parses the documented forms", () => {
		expect(parseCliInvocation(["export", "--target", "./agent", "--all"])).toEqual({
			kind: "command",
			command: "export",
			action: null,
			flags: { target: "./agent", all: "true" },
			positionals: [],
		});
		expect(parseCliInvocation([
			"export", "--target", "./agent", "--project", "demo",
			"--eval", "erun_1", "--out", "./out", "--min-score", "0.8",
			"--include-failed", "--include-aa",
		])).toEqual({
			kind: "command",
			command: "export",
			action: null,
			flags: {
				target: "./agent",
				project: "demo",
				eval: "erun_1",
				out: "./out",
				"min-score": "0.8",
				"include-failed": "true",
				"include-aa": "true",
			},
			positionals: [],
		});
		expect(parseCliInvocation(["export", "--run", "run_1"])).toEqual({
			kind: "command",
			command: "export",
			action: null,
			flags: { run: "run_1" },
			positionals: [],
		});
	});

	/**
	 * The bug this pins: a value-less `--all` at the end of the line is invisible
	 * to a helper that reads the token AFTER a flag, and `--all --include-failed`
	 * makes one boolean swallow the next. The parser already resolved both into
	 * `"true"`, so the mapping consumes its map and never re-reads argv.
	 */
	it("maps the parser's own flags, boolean flags included", () => {
		const trailing = commandFlags(["export", "--target", "./agent", "--all"]);
		expect(datasetExportOptionsFromFlags(trailing, { runsRoot: "/runs" }))
			.toEqual({ runsRoot: "/runs", all: true });

		const adjacent = commandFlags([
			"export", "--target", "./agent", "--all", "--include-failed", "--include-aa",
		]);
		expect(datasetExportOptionsFromFlags(adjacent, { runsRoot: "/runs" }))
			.toEqual({ runsRoot: "/runs", all: true, includeFailed: true, includeAa: true });

		const named = commandFlags(["export", "--target", "./agent", "--eval", "erun_1", "--min-score", "80%"]);
		expect(datasetExportOptionsFromFlags(named, { runsRoot: "/runs" }))
			.toEqual({ runsRoot: "/runs", evalRunId: "erun_1", minScore: 0.8 });

		const one = commandFlags(["export", "--run", "run_1"]);
		expect(datasetExportOptionsFromFlags(one, { runsRoot: "/runs", outRoot: "/agent" }))
			.toEqual({ runsRoot: "/runs", outRoot: "/agent", runId: "run_1" });

		// Every mapped form must survive the module's own selection check.
		expect(() => exportDataset({ ...datasetExportOptionsFromFlags(trailing, { runsRoot: newRunsRoot() }) }))
			.not.toThrow();
	});

	it.each([
		[["export", "--target", "./agent"], /exactly one of --run <run-id>, --eval <erun-id>, or --all/],
		[["export", "--target", "./agent", "--eval", "erun_1", "--all"], /exactly one of --run <run-id>, --eval <erun-id>, or --all/],
		[["export", "--run", "run_1", "--eval", "erun_1"], /exactly one of --run <run-id>, --eval <erun-id>, or --all/],
		[["export", "--all", "--min-score", "high"], /--min-score for export must be a pass rate/],
		[["export", "--all", "--training"], /unknown flag --training for export/],
	] as const)("refuses %j", (argv, message) => {
		expect(() => parseCliInvocation(argv)).toThrow(CliInvocationError);
		expect(() => parseCliInvocation(argv)).toThrow(message);
	});
});
