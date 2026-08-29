import { chmodSync, mkdirSync, opendirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { GraderSpec, graderName, type ResolvedTarget, type ResolvedTask, type TargetManifest } from "./manifest.js";
import {
	HashSchema,
	modelFingerprint,
	axisDifferences,
	canonicalJson,
	hashValue,
	provenanceAxes,
	provenanceKey,
	ProvenanceAxesSchema,
	RunRecordSchema,
	TargetRevisionSchema,
	type GraderResult,
	type GraderCheckCode,
	type RunRecord,
	type ProvenanceAxes,
	type ExecutionFingerprint,
} from "./provenance.js";
import {
	disposeTargetWorkspaceSnapshot,
	materializeTargetWorkspaceSnapshot,
	runTask,
} from "./runner.js";
import {
	emitRunGraded,
	type RunEventIdentity,
	type RunEventListener,
} from "./run-events.js";
import { readJsonArtifact, writeJsonArtifact, writeTextArtifact } from "./storage/artifacts.js";
import { resolveContainedArtifactPath } from "./storage/paths.js";
import { lastAssistantText, openTrace, redactTraceText, traceToolCalls } from "./trace.js";

/** Grader implementations over (task, record, trace). Declarative specs live in the target suite. */

function gradeToolCalled(
	spec: { tool: string; argsContains?: string },
	toolCalls: ReturnType<typeof traceToolCalls>,
): GraderResult {
	const matching = toolCalls.filter(
		(call) =>
			call.name === spec.tool &&
			(!spec.argsContains || JSON.stringify(call.arguments).includes(spec.argsContains)),
	);
	return {
		name: "",
		type: "tool_called",
		passed: matching.length > 0,
		score: matching.length > 0 ? 1 : 0,
		reason: matching.length > 0
			? `called ${spec.tool}${spec.argsContains ? ` (args contain "${spec.argsContains}")` : ""}`
			: `never called ${spec.tool}${spec.argsContains ? ` with args containing "${spec.argsContains}"` : ""}`,
	};
}

function gradeOutputContains(
	spec: { text: string; caseSensitive: boolean },
	output: string | undefined,
): GraderResult {
	const haystack = spec.caseSensitive ? (output ?? "") : (output ?? "").toLowerCase();
	const needle = spec.caseSensitive ? spec.text : spec.text.toLowerCase();
	const passed = haystack.includes(needle);
	return {
		name: "",
		type: "output_contains",
		passed,
		score: passed ? 1 : 0,
		reason: passed ? `output contains "${spec.text}"` : `output does not contain "${spec.text}"`,
	};
}

function gradeOutputMatches(spec: { pattern: string }, output: string | undefined): GraderResult {
	const regex = new RegExp(spec.pattern);
	const passed = output !== undefined && regex.test(output);
	return {
		name: "",
		type: "output_matches",
		passed,
		score: passed ? 1 : 0,
		reason: passed ? `output matches /${spec.pattern}/` : `output does not match /${spec.pattern}/`,
	};
}

// ---------- Judge grader ----------
// Judge calls leave a sidecar trace (exact request + raw response) in
// runs/<run_id>/judge/<graderIndex>.json — written BEFORE parsing, so even an
// unparseable verdict keeps its evidence. ponytail: sidecar file, not a
// judge-as-run through runner.ts; upgrade if judge verdicts ever need their
// own provenance/cost accounting.

const JUDGE_SYSTEM =
	'Ты — грейдер. Оцени ответ агента на обращение по критерию. ' +
	'Ответь строго одной строкой JSON без markdown: {"passed": true|false, "reason": "краткое обоснование"}';

function parseVerdict(text: string): { passed: boolean; reason: string } {
	const stripped = text.replace(/```(?:json)?/g, "").trim();
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	const raw = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`judge returned unparseable verdict: ${text.slice(0, 120)}`);
	}
	const verdict = parsed as { passed?: unknown; reason?: unknown };
	if (typeof verdict.passed !== "boolean" || typeof verdict.reason !== "string") {
		throw new Error(`judge verdict missing passed/reason: ${text.slice(0, 120)}`);
	}
	return { passed: verdict.passed, reason: verdict.reason };
}

function contentToString(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : ""))
			.join("");
	}
	return "";
}

async function gradeJudge(
	spec: { rubric: string },
	judge: TargetManifest["model"],
	task: { input: string },
	output: string,
	tracePath: string,
	signal?: AbortSignal,
): Promise<GraderResult> {
	const key = process.env[judge.apiKeyEnv];
	if (judge.baseUrl.includes("openrouter.ai") && !key) {
		throw new Error(`missing ${judge.apiKeyEnv} for judge endpoint ${judge.baseUrl}`);
	}
	const url = `${judge.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const requestBody = {
		model: judge.id,
		messages: [
			{ role: "system", content: JUDGE_SYSTEM },
			{ role: "user", content: `Критерий: ${spec.rubric}\n\nОбращение: ${task.input}\n\nОтвет агента: ${output}` },
		],
		temperature: 0,
		stream: false,
		...judge.params,
		...(judge.thinkingLevel !== "off" ? { reasoning: { effort: judge.thinkingLevel } } : {}),
	};
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
		body: JSON.stringify(requestBody),
		signal: signal
			? AbortSignal.any([signal, AbortSignal.timeout(judge.timeoutMs)])
			: AbortSignal.timeout(judge.timeoutMs),
	});
	const rawText = await response.text();
	// Evidence first: the exact exchange is on disk even if parsing/HTTP fails.
	const judgeDir = join(tracePath, "..");
	mkdirSync(judgeDir, { recursive: true, mode: 0o700 });
	chmodSync(judgeDir, 0o700);
	writeTextArtifact(
		tracePath,
		`${JSON.stringify({ request: { url, body: requestBody }, response: { status: response.status, text: rawText } }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
	if (!response.ok) {
		throw new Error(`judge HTTP ${response.status}: ${rawText.slice(0, 120)}`);
	}
	const body = JSON.parse(rawText) as { choices?: { message?: { content?: unknown } }[] };
	const text = contentToString(body.choices?.[0]?.message?.content);
	const verdict = parseVerdict(text);
	return { name: "", type: "judge", passed: verdict.passed, score: verdict.passed ? 1 : 0, reason: verdict.reason };
}

/** Grade one completed run against its task's effective graders. */
function graderCheckCode(type: GraderSpec["type"]): GraderCheckCode {
	switch (type) {
		case "tool_called": return "required-tool";
		case "output_contains": return "output-contains";
		case "output_matches": return "output-matches";
		case "judge": return "semantic-rubric";
	}
}

export async function gradeRun(
	task: ResolvedTask,
	record: RunRecord,
	runsRoot: string,
	judge?: TargetManifest["model"],
	signal?: AbortSignal,
): Promise<GraderResult[]> {
	const runDir = resolveContainedArtifactPath(runsRoot, ArtifactIdSchema.parse(record.runId));
	let output: string | undefined;
	let toolCalls: ReturnType<typeof traceToolCalls> = [];
	if (record.status === "completed" && record.trace.path) {
		const messages = openTrace(runDir, record.trace.path, record.trace.sha256 ?? undefined);
		output = lastAssistantText(messages);
		toolCalls = traceToolCalls(messages);
	}
	const results: GraderResult[] = [];
	for (const [index, spec] of task.effectiveGraders.entries()) {
		if (signal?.aborted) throw signal.reason ?? new Error("grading aborted");
		const normalizedSpec = GraderSpec.parse(spec);
		let result: GraderResult;
		if (record.status !== "completed") {
			result = {
				name: "",
				type: normalizedSpec.type,
				passed: false,
				score: 0,
				reason: `run did not complete (${record.status}${record.error ? `: ${record.error}` : ""})`,
			};
		} else if (normalizedSpec.type === "tool_called") {
			result = gradeToolCalled(normalizedSpec, toolCalls);
		} else if (normalizedSpec.type === "output_contains") {
			result = gradeOutputContains(normalizedSpec, output ?? "");
		} else if (normalizedSpec.type === "judge") {
			if (!judge) throw new Error("judge grader without judge model config");
			result = await gradeJudge(normalizedSpec, judge, task, output ?? "", join(runDir, "judge", `${index}.json`), signal);
		} else {
			result = gradeOutputMatches(normalizedSpec, output ?? "");
		}
		results.push({
			...result,
			name: graderName(normalizedSpec, task, index),
			specHash: hashValue(normalizedSpec),
			checkCode: graderCheckCode(normalizedSpec.type),
		});
	}
	return results;
}

// ---------- Eval run aggregation ----------

export const EvalRunSummarySchema = z
	.strictObject({
		total: z.number().int().nonnegative(),
		pass: z.number().int().nonnegative(),
		fail: z.number().int().nonnegative(),
		error: z.number().int().nonnegative(),
		allPassRate: z.number().min(0).max(1),
	})
	.superRefine((summary, context) => {
		if (summary.total !== summary.pass + summary.fail + summary.error) {
			context.addIssue({ code: "custom", path: ["total"], message: "must equal pass + fail + error" });
		}
		const expected = summary.total === 0 ? 0 : summary.pass / summary.total;
		if (Math.abs(summary.allPassRate - expected) > Number.EPSILON) {
			context.addIssue({ code: "custom", path: ["allPassRate"], message: "must equal pass / total" });
		}
	});
export type EvalRunSummary = z.infer<typeof EvalRunSummarySchema>;

const ArtifactIdSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/, "expected one safe artifact path segment");

const EvalRunArtifactSchema = z.strictObject({
	runId: ArtifactIdSchema,
	sha256: HashSchema,
});

export const EvidenceVisibilitySchema = z.enum(["development", "sealed"]);
export type EvidenceVisibility = z.infer<typeof EvidenceVisibilitySchema>;

/**
 * Bumped to 2 in V1.8: `provenance` lost `ahdeCodeHash` and gained
 * `evaluatorId`, so a v1 index describes a different comparability contract.
 * v1 records stay readable only as display-only legacy rows
 * (`listEvalRunIndexesLenient`); they are never comparable or reusable.
 */
export const EVAL_RUN_SCHEMA_VERSION = 2;

export const EvalRunRecordSchema = z.strictObject({
	schemaVersion: z.literal(EVAL_RUN_SCHEMA_VERSION),
	evalRunId: ArtifactIdSchema,
	target: z.strictObject({
		id: z.string().min(1),
		gitSha: TargetRevisionSchema,
		/** Optional only for legacy indexes. New evals always persist it. */
		toolsetHash: HashSchema.optional(),
		/** Exact shared model-visible source snapshot. Legacy indexes may omit it. */
		workspaceHash: HashSchema.optional(),
	}),
	label: z.enum(["baseline", "candidate", "solo"]),
	/** For candidate runs: the baseline eval run it was compared against. */
	baselineEvalRunId: ArtifactIdSchema.nullable(),
	provenance: ProvenanceAxesSchema,
	provenanceKey: HashSchema,
	suiteId: z.string().min(1),
	suiteHash: HashSchema,
	dataset: z.string().min(1),
	datasetHash: HashSchema,
	/** Explicit evidence boundary. Optional only for legacy eval indexes. */
	evidenceVisibility: EvidenceVisibilitySchema.optional(),
	/** Source task ids in their exact evaluation order. Optional for legacy indexes. */
	taskIds: z
		.array(z.string().min(1))
		.refine((values) => new Set(values).size === values.length, "taskIds must be unique")
		.optional(),
	repetitions: z.number().int().positive(),
	runIds: z
		.array(ArtifactIdSchema)
		.refine((values) => new Set(values).size === values.length, "runIds must be unique"),
	/** Canonical hashes for final run.json records. Legacy indexes may omit this, but cannot be promotion evidence. */
	runArtifacts: z.array(EvalRunArtifactSchema).optional(),
	startedAt: z.string().min(1),
	finishedAt: z.string().min(1),
	summary: EvalRunSummarySchema,
}).superRefine((record, context) => {
	if (record.provenanceKey !== hashValue(record.provenance)) {
		context.addIssue({ code: "custom", path: ["provenanceKey"], message: "does not match provenance" });
	}
	if (record.suiteHash !== record.provenance.suiteHash) {
		context.addIssue({ code: "custom", path: ["suiteHash"], message: "does not match provenance.suiteHash" });
	}
	if (record.datasetHash !== record.provenance.datasetHash) {
		context.addIssue({ code: "custom", path: ["datasetHash"], message: "does not match provenance.datasetHash" });
	}
	if (record.evidenceVisibility === "development" && record.dataset.startsWith("sealed-")) {
		context.addIssue({
			code: "custom",
			path: ["evidenceVisibility"],
			message: "development visibility conflicts with a legacy sealed dataset name",
		});
	}
	if (record.label === "candidate" && record.baselineEvalRunId === null) {
		context.addIssue({ code: "custom", path: ["baselineEvalRunId"], message: "candidate eval requires a baseline eval reference" });
	}
	if (record.label !== "candidate" && record.baselineEvalRunId !== null) {
		context.addIssue({ code: "custom", path: ["baselineEvalRunId"], message: `${record.label} eval cannot reference a baseline eval` });
	}
	if (record.runArtifacts) {
		const artifactIds = record.runArtifacts.map((artifact) => artifact.runId);
		if (new Set(artifactIds).size !== artifactIds.length) {
			context.addIssue({ code: "custom", path: ["runArtifacts"], message: "run artifact ids must be unique" });
		}
		if (JSON.stringify(artifactIds) !== JSON.stringify(record.runIds)) {
			context.addIssue({ code: "custom", path: ["runArtifacts"], message: "run artifacts must match runIds in order" });
		}
	}
});
export type EvalRunRecord = z.infer<typeof EvalRunRecordSchema>;

/** Explicit visibility for new evidence, with the legacy sealed dataset convention as a fallback. */
export function isSealedEvalRun(
	record: Pick<EvalRunRecord, "dataset" | "evidenceVisibility"> & { datasetHash?: string },
	legacySealedDatasetHashes: ReadonlySet<string> = new Set(),
): boolean {
	return record.evidenceVisibility === "sealed" ||
		record.dataset.startsWith("sealed-") ||
		(record.evidenceVisibility === undefined && record.datasetHash !== undefined &&
			legacySealedDatasetHashes.has(record.datasetHash));
}

export interface VerifiedEvalRun {
	record: EvalRunRecord;
	runs: RunRecord[];
	hasRunHashes: boolean;
}

export function newEvalRunId(): string {
	return `erun_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface RunSuiteOptions {
	runsRoot: string;
	label: "baseline" | "candidate" | "solo";
	repetitions: number;
	candidateOf?: string | null;
	/** Restrict an ad-hoc diagnostic run to one task id. */
	taskId?: string;
	/** Baseline eval run id this candidate will be compared against. */
	baselineEvalRunId?: string | null;
	/** Evidence disclosure boundary. New suites persist development by default. */
	evidenceVisibility?: EvidenceVisibility;
	/** @internal Exact source hash captured for a baseline-reuse query. */
	expectedWorkspaceHash?: string;
	/** Optional synchronous, observational listener for all task executions. */
	onRunEvent?: RunEventListener;
	/** Host-owned cancellation propagated through Target and judge sessions. */
	signal?: AbortSignal;
}

/**
 * Run (and grade) a suite: tasks × repetitions on the target harness.
 * Writes per-run run.json and one eval_run.json index.
 */
export async function runSuite(target: ResolvedTarget, options: RunSuiteOptions): Promise<EvalRunRecord> {
	if (options.signal?.aborted) throw options.signal.reason ?? new Error("evaluation aborted");
	if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
		throw new Error(`repetitions must be a positive integer, got ${options.repetitions}`);
	}
	mkdirSync(options.runsRoot, { recursive: true });
	const evalRunId = newEvalRunId();
	const tasks = options.taskId ? target.tasks.filter((t) => t.id === options.taskId) : target.tasks;
	if (tasks.length === 0) throw new Error(`task not found: ${options.taskId}`);

	const startedAt = new Date().toISOString();
	const runIds: string[] = [];
	let pass = 0;
	let fail = 0;
	let error = 0;
	let effectiveExecution: ExecutionFingerprint | undefined;
	const workspaceSnapshot = materializeTargetWorkspaceSnapshot(
		target,
		options.runsRoot,
	);
	if (options.expectedWorkspaceHash && workspaceSnapshot.sha256 !== options.expectedWorkspaceHash) {
		disposeTargetWorkspaceSnapshot(workspaceSnapshot);
		throw new Error("Target workspace changed after the baseline reuse query");
	}
	const executionTotal = tasks.length * options.repetitions;
	try {
		for (const [taskIndex, task] of tasks.entries()) {
			for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
				if (options.signal?.aborted) throw options.signal.reason ?? new Error("evaluation aborted");
				const ordinal = taskIndex * options.repetitions + repetition + 1;
				const record = await runTask(target, task, {
					runsRoot: options.runsRoot,
					label: options.label,
					repetitionIndex: repetition,
					evalRunId,
					candidateOf: options.candidateOf ?? null,
					workspaceSnapshot,
					ordinal,
					total: executionTotal,
					onRunEvent: options.onRunEvent,
					signal: options.signal,
				});
				if (options.signal?.aborted) throw options.signal.reason ?? new Error("evaluation aborted");
				const eventRun: RunEventIdentity = {
					evalRunId,
					runId: record.runId,
					taskId: record.taskId,
					repetitionIndex: record.repetitionIndex,
					ordinal,
					total: executionTotal,
				};
				runIds.push(record.runId);
				if (!effectiveExecution) effectiveExecution = record.execution;
				else if (canonicalJson(effectiveExecution) !== canonicalJson(record.execution)) {
					throw new Error("execution policy changed within one eval run");
				}
				if (record.status === "error") {
					error += 1;
					emitRunGraded(options.onRunEvent, eventRun, "error", [], task.effectiveGraders.length);
					continue;
				}
				let graders: GraderResult[];
				try {
					graders = await gradeRun(task, record, options.runsRoot, target.manifest.evalSuite.judge, options.signal);
				} catch (gradeError) {
					record.status = "error";
					record.error = `evaluation infrastructure: ${gradeError instanceof Error ? gradeError.message : String(gradeError)}`;
					writeJsonArtifact(
						resolveContainedArtifactPath(options.runsRoot, ArtifactIdSchema.parse(record.runId), "run.json"),
						RunRecordSchema,
						record,
					);
					error += 1;
					emitRunGraded(options.onRunEvent, eventRun, "error", [], task.effectiveGraders.length);
					continue;
				}
				const outcome = graders.every((g) => g.passed) ? "pass" : "fail";
				record.evalResults = { graders, outcome };
				// finalize run.json with eval results (second and final write)
				writeJsonArtifact(
					resolveContainedArtifactPath(options.runsRoot, ArtifactIdSchema.parse(record.runId), "run.json"),
					RunRecordSchema,
					record,
				);
				emitRunGraded(options.onRunEvent, eventRun, outcome, graders);
				if (outcome === "pass") pass += 1;
				else fail += 1;
			}
		}
	} finally {
		disposeTargetWorkspaceSnapshot(workspaceSnapshot);
	}

	const total = runIds.length;
	if (!effectiveExecution) throw new Error("evaluation produced no execution fingerprint");
	const evidenceInput = {
		runtime: target.runtime,
		model: modelFingerprint(target.manifest.model),
		judge: target.manifest.evalSuite.judge ? modelFingerprint(target.manifest.evalSuite.judge) : null,
		execution: effectiveExecution,
		eval: { suiteHash: target.suiteHash, datasetHash: target.datasetHash },
	};
	const record: EvalRunRecord = {
		schemaVersion: EVAL_RUN_SCHEMA_VERSION,
		evalRunId,
		target: {
			id: target.manifest.id,
			gitSha: target.gitSha,
			toolsetHash: target.toolsetHash,
			workspaceHash: workspaceSnapshot.sha256,
		},
		label: options.label,
		baselineEvalRunId: options.baselineEvalRunId ?? null,
		provenance: provenanceAxes(evidenceInput),
		provenanceKey: provenanceKey(evidenceInput),
		suiteId: target.manifest.evalSuite.id,
		suiteHash: target.suiteHash,
		dataset: target.manifest.evalSuite.dataset.replace(/\.jsonl$/, "").split("/").pop() ?? "dataset",
		datasetHash: target.datasetHash,
		evidenceVisibility: options.evidenceVisibility ?? "development",
		taskIds: tasks.map((task) => task.id),
		repetitions: options.repetitions,
		runIds,
		runArtifacts: runIds.map((runId) => ({
			runId,
			sha256: hashValue(readJsonArtifact(
				resolveContainedArtifactPath(options.runsRoot, runId, "run.json"),
				RunRecordSchema,
			)),
		})),
		startedAt,
		finishedAt: new Date().toISOString(),
		summary: { total, pass, fail, error, allPassRate: total === 0 ? 0 : pass / total },
	};
	writeEvalRun(options.runsRoot, record);
	return record;
}

export function writeEvalRun(runsRoot: string, record: EvalRunRecord): void {
	mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
	const evalDir = resolveContainedArtifactPath(runsRoot, ArtifactIdSchema.parse(record.evalRunId));
	mkdirSync(evalDir, { recursive: true, mode: 0o700 });
	writeJsonArtifact(resolveContainedArtifactPath(runsRoot, record.evalRunId, "eval_run.json"), EvalRunRecordSchema, record, {
		immutable: true,
	});
}

export function loadRun(runsRoot: string, runId: string): RunRecord {
	return readJsonArtifact(
		resolveContainedArtifactPath(runsRoot, ArtifactIdSchema.parse(runId), "run.json"),
		RunRecordSchema,
	);
}

/**
 * Read only the bounded EvalRun index. This deliberately does not open member
 * RunRecords so visibility can be checked before sealed evidence is touched.
 */
export function readEvalRunIndex(runsRoot: string, evalRunId: string): EvalRunRecord {
	const parsedId = ArtifactIdSchema.parse(evalRunId);
	const record = readJsonArtifact(
		resolveContainedArtifactPath(runsRoot, parsedId, "eval_run.json"),
		EvalRunRecordSchema,
	);
	if (record.evalRunId !== parsedId) {
		throw new Error("eval run index identity does not match its artifact path");
	}
	return record;
}

/** Index-only inventory for visibility preflight. Member Runs remain unopened. */
export function listEvalRunIndexes(runsRoot: string): EvalRunRecord[] {
	let entries: string[];
	try {
		entries = readdirSync(runsRoot);
	} catch {
		return [];
	}
	const records: EvalRunRecord[] = [];
	for (const entry of entries) {
		if (!entry.startsWith("erun_")) continue;
		records.push(readEvalRunIndex(runsRoot, entry));
	}
	return records.sort((a, b) =>
		b.startedAt.localeCompare(a.startedAt) || b.evalRunId.localeCompare(a.evalRunId));
}

const MAX_BOUNDED_EVAL_INDEX_RESULTS = 1_000;

export interface PublicEvalRunIndexEntry {
	evalRunId: string;
	targetId: string;
	label: EvalRunRecord["label"];
	startedAt: string;
	allPassRate: number;
	fieldsTruncated: boolean;
	fieldsRedacted: boolean;
}

export interface BoundedPublicEvalRunIndexes {
	entries: PublicEvalRunIndexEntry[];
	/** True only when additional public records were omitted. Sealed records never affect this value. */
	truncated: boolean;
	/** Exact number of omitted public records. Sealed records never contribute to this count. */
	omittedPublicCount: number;
}

function newestEvalIndexFirst(left: PublicEvalRunIndexEntry, right: PublicEvalRunIndexEntry): number {
	return right.startedAt.localeCompare(left.startedAt) || right.evalRunId.localeCompare(left.evalRunId);
}

function publicIndexText(value: string, maxChars: number): {
	text: string;
	truncated: boolean;
	redacted: boolean;
} {
	const redacted = redactTraceText(value);
	if (redacted.length <= maxChars) {
		return { text: redacted, truncated: false, redacted: redacted !== value };
	}
	return {
		text: `${redacted.slice(0, maxChars - 1)}…`,
		truncated: true,
		redacted: redacted !== value,
	};
}

function projectPublicEvalRunIndex(record: EvalRunRecord): PublicEvalRunIndexEntry {
	const targetId = publicIndexText(record.target.id, 160);
	const startedAt = publicIndexText(record.startedAt, 64);
	return {
		evalRunId: record.evalRunId,
		targetId: targetId.text,
		label: record.label,
		startedAt: startedAt.text,
		allPassRate: record.summary.allPassRate,
		fieldsTruncated: targetId.truncated || startedAt.truncated,
		fieldsRedacted: targetId.redacted || startedAt.redacted,
	};
}

/**
 * Index-only top-K inventory for public Evidence Explorer surfaces.
 *
 * The directory is streamed and only `limit` bounded display projections are
 * retained in memory; full indexes are released after each projection. Every
 * index is still schema-checked so the result is an exact newest-first top-K.
 * Sealed indexes affect neither returned entries nor truncation metadata.
 * Member RunRecords remain unopened until the caller has completed visibility
 * preflight.
 */
export function listPublicEvalRunIndexesBounded(
	runsRoot: string,
	limit: number,
): BoundedPublicEvalRunIndexes {
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BOUNDED_EVAL_INDEX_RESULTS) {
		throw new Error(`eval index limit must be an integer between 1 and ${MAX_BOUNDED_EVAL_INDEX_RESULTS}`);
	}
	let directory;
	try {
		directory = opendirSync(runsRoot);
	} catch {
		return { entries: [], truncated: false, omittedPublicCount: 0 };
	}
	const entries: PublicEvalRunIndexEntry[] = [];
	let publicCount = 0;
	try {
		let entry = directory.readSync();
		while (entry !== null) {
			if (entry.name.startsWith("erun_")) {
				const record = readEvalRunIndex(runsRoot, entry.name);
				if (!isSealedEvalRun(record)) {
					publicCount += 1;
					entries.push(projectPublicEvalRunIndex(record));
					entries.sort(newestEvalIndexFirst);
					if (entries.length > limit) entries.pop();
				}
			}
			entry = directory.readSync();
		}
	} finally {
		directory.closeSync();
	}
	const omittedPublicCount = publicCount - entries.length;
	return {
		entries,
		truncated: omittedPublicCount > 0,
		omittedPublicCount,
	};
}

export interface InvalidEvalRunIndex {
	evalRunId: string;
	/** Bounded validation reason; legacy indexes predate the current provenance axes. */
	reason: string;
}

/**
 * Bounded peek at an index that failed validation. A pre-V1.8 record is a fact
 * of history, not a defect, and saying so beats a zod dump. Display only: the
 * value is never used to accept, migrate, or compare the record.
 */
function indexSchemaVersion(runsRoot: string, evalRunId: string): number | null {
	try {
		return readJsonArtifact(
			resolveContainedArtifactPath(runsRoot, ArtifactIdSchema.parse(evalRunId), "eval_run.json"),
			z.object({ schemaVersion: z.number().int() }),
		).schemaVersion;
	} catch {
		return null;
	}
}

/**
 * Best-effort index listing: invalid or legacy siblings never hide healthy
 * indexes and never block a caller. Each invalid index is reported with its
 * reason so humans can see "legacy · not comparable" instead of nothing.
 */
export function listEvalRunIndexesLenient(runsRoot: string): {
	records: EvalRunRecord[];
	invalid: InvalidEvalRunIndex[];
	invalidCount: number;
} {
	let entries: string[];
	try {
		entries = readdirSync(runsRoot);
	} catch {
		return { records: [], invalid: [], invalidCount: 0 };
	}
	const records: EvalRunRecord[] = [];
	const invalid: InvalidEvalRunIndex[] = [];
	for (const entry of entries) {
		if (!entry.startsWith("erun_")) continue;
		try {
			records.push(readEvalRunIndex(runsRoot, entry));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const version = indexSchemaVersion(runsRoot, entry);
			const note = version !== null && version < EVAL_RUN_SCHEMA_VERSION
				? `legacy schemaVersion ${version} (not comparable): `
				: "";
			invalid.push({
				evalRunId: entry,
				reason: `${note}${message.replace(/\s+/g, " ")}`.slice(0, 200),
			});
		}
	}
	records.sort((left, right) =>
		right.startedAt.localeCompare(left.startedAt) || right.evalRunId.localeCompare(left.evalRunId));
	invalid.sort((left, right) => left.evalRunId.localeCompare(right.evalRunId));
	return { records, invalid, invalidCount: invalid.length };
}

function evidenceMismatch(evalRunId: string, message: string): never {
	throw new Error(`eval run ${evalRunId} evidence mismatch: ${message}`);
}

function sameJson(a: unknown, b: unknown): boolean {
	return canonicalJson(a) === canonicalJson(b);
}

/**
 * Reconstruct and validate the final EvalRun membership from its RunRecords.
 * The index is never trusted as an unchecked list of passing run IDs.
 */
export function loadVerifiedEvalRun(runsRoot: string, evalRunId: string): VerifiedEvalRun {
	const record = readEvalRunIndex(runsRoot, evalRunId);
	const expectedHashes = new Map(record.runArtifacts?.map((artifact) => [artifact.runId, artifact.sha256]) ?? []);
	const runs = record.runIds.map((runId) => {
		const run = loadRun(runsRoot, runId);
		if (run.runId !== runId) evidenceMismatch(evalRunId, `run path ${runId} contains record ${run.runId}`);
		const expectedHash = expectedHashes.get(runId);
		if (expectedHash && hashValue(run) !== expectedHash) {
			evidenceMismatch(evalRunId, `run ${runId} hash does not match the final eval index`);
		}
		if (run.parent?.evalRunId !== record.evalRunId) {
			evidenceMismatch(evalRunId, `run ${runId} parent does not reference this eval`);
		}
		if (
			run.target.id !== record.target.id ||
			run.target.gitSha !== record.target.gitSha ||
			run.target.toolsetHash !== record.target.toolsetHash ||
			run.target.workspaceHash !== record.target.workspaceHash
		) {
			evidenceMismatch(evalRunId, `run ${runId} target does not match the eval target`);
		}
		if (run.label !== record.label) evidenceMismatch(evalRunId, `run ${runId} label does not match`);
		if (run.eval.suiteId !== record.suiteId || run.eval.suiteHash !== record.suiteHash) {
			evidenceMismatch(evalRunId, `run ${runId} suite does not match`);
		}
		if (run.eval.dataset !== record.dataset || run.eval.datasetHash !== record.datasetHash) {
			evidenceMismatch(evalRunId, `run ${runId} dataset does not match`);
		}
		if (run.status === "running" || run.finishedAt === null) {
			evidenceMismatch(evalRunId, `run ${runId} is not final`);
		}
		if (run.status === "completed" && run.evalResults === null) {
			evidenceMismatch(evalRunId, `completed run ${runId} has no grading result`);
		}
		if (run.status === "error" && run.evalResults !== null) {
			evidenceMismatch(evalRunId, `error run ${runId} unexpectedly has grading results`);
		}
		const axes = provenanceAxes({
			runtime: run.runtime,
			model: run.model,
			judge: record.provenance.judge,
			execution: run.execution,
			eval: run.eval,
		});
		const differences = axisDifferences(axes, record.provenance);
		if (differences.length > 0) {
			evidenceMismatch(evalRunId, `run ${runId} differs on ${differences.join(", ")}`);
		}
		if (record.label === "candidate" && run.parent.candidateOf === null) {
			evidenceMismatch(evalRunId, `candidate run ${runId} has no candidateOf revision`);
		}
		if (record.label !== "candidate" && run.parent.candidateOf !== null) {
			evidenceMismatch(evalRunId, `${record.label} run ${runId} has an unexpected candidateOf revision`);
		}
		return run;
	});

	const byTask = new Map<string, Set<number>>();
	for (const run of runs) {
		const repetitions = byTask.get(run.taskId) ?? new Set<number>();
		if (repetitions.has(run.repetitionIndex)) {
			evidenceMismatch(evalRunId, `duplicate task/repetition ${run.taskId}/${run.repetitionIndex}`);
		}
		repetitions.add(run.repetitionIndex);
		byTask.set(run.taskId, repetitions);
	}
	if (record.taskIds) {
		const observedTaskIds = [...byTask.keys()];
		if (!sameJson(record.taskIds, observedTaskIds)) {
			evidenceMismatch(evalRunId, "taskIds do not match the exact source task order");
		}
	}
	const expectedRepetitions = Array.from({ length: record.repetitions }, (_, index) => index);
	for (const [taskId, repetitions] of byTask) {
		if (!sameJson([...repetitions].sort((a, b) => a - b), expectedRepetitions)) {
			evidenceMismatch(evalRunId, `task ${taskId} does not contain exactly ${record.repetitions} repetitions`);
		}
	}
	const summary = {
		total: runs.length,
		pass: runs.filter((run) => run.status === "completed" && run.evalResults?.outcome === "pass").length,
		fail: runs.filter((run) => run.status === "completed" && run.evalResults?.outcome === "fail").length,
		error: runs.filter((run) => run.status === "error").length,
		allPassRate: runs.length === 0
			? 0
			: runs.filter((run) => run.status === "completed" && run.evalResults?.outcome === "pass").length / runs.length,
	};
	if (!sameJson(summary, record.summary)) evidenceMismatch(evalRunId, "summary does not match verified runs");
	return { record, runs, hasRunHashes: record.runArtifacts !== undefined };
}

export function loadEvalRun(runsRoot: string, evalRunId: string): EvalRunRecord {
	return loadVerifiedEvalRun(runsRoot, evalRunId).record;
}

export function listEvalRuns(runsRoot: string): EvalRunRecord[] {
	return listEvalRunIndexes(runsRoot).map((record) => loadEvalRun(runsRoot, record.evalRunId));
}

/**
 * The exact identity a reusable baseline must match. Every field is required:
 * a partial query would let sealed evidence reuse a development index or a
 * one-repetition baseline stand in for a three-repetition design.
 */
export interface ReusableBaselineQuery {
	targetId: string;
	targetGitSha: string;
	/** Exact tool identity. */
	toolsetHash: string;
	/** Exact model-visible workspace identity. */
	workspaceHash: string;
	provenance: ProvenanceAxes;
	evidenceVisibility: EvidenceVisibility;
	label: "baseline" | "candidate" | "solo";
	repetitions: number;
}

/**
 * Find the newest eval run whose identity matches the query (baseline reuse).
 * The scan reads indexes only and skips legacy, errored, or otherwise
 * unusable siblings; only the chosen match is fully verified, so one bad
 * index on disk can never abort a candidate verification.
 */
export function findReusableBaseline(runsRoot: string, query: ReusableBaselineQuery): EvalRunRecord | null {
	for (const record of listEvalRunIndexesLenient(runsRoot).records) {
		if (record.label !== query.label) continue;
		if (record.target.id !== query.targetId || record.target.gitSha !== query.targetGitSha) continue;
		if (record.target.toolsetHash !== query.toolsetHash) continue;
		if (record.target.workspaceHash !== query.workspaceHash) continue;
		if (record.evidenceVisibility !== query.evidenceVisibility) continue;
		if (record.provenanceKey === "") continue;
		if (record.repetitions !== query.repetitions) continue;
		// Errored evidence is inconclusive and would only stop the experiment later.
		if (record.summary.error > 0) continue;
		if (axisDifferences(record.provenance, query.provenance).length !== 0) continue;
		try {
			return loadVerifiedEvalRun(runsRoot, record.evalRunId).record;
		} catch {
			// A match whose member runs no longer verify is not evidence; keep scanning.
			continue;
		}
	}
	return null;
}
