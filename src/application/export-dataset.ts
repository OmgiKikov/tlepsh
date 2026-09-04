import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parsePassRateFlag } from "../cli-invocation.js";
import { runGraderScore } from "../compare.js";
import { isScreenEvalRun } from "./cheap-check.js";
import { corpusDatasetLabel } from "./corpus-target.js";
import { publicTaskId } from "./improvement-brief.js";
import { listCorpora, loadCorpus, type CorpusVisibility } from "../corpus.js";
import {
	isSealedEvalRun,
	listEvalRunIndexesLenient,
	loadVerifiedEvalRun,
	readEvalRunIndex,
	type EvalRunRecord,
} from "../eval.js";
import type { RunRecord } from "../provenance.js";
import { writeTextArtifact } from "../storage/artifacts.js";
import { resolveContainedArtifactPath, safeArtifactSegment } from "../storage/paths.js";
import { openTrace, redactTraceText, type TraceMessage } from "../trace.js";

/**
 * `ahde export` — the recorded dataset.
 *
 * Every emulated conversation AHDE ran is already on disk. This module compiles
 * it into JSONL somebody else can read: one line per exported run in the
 * standard chat-tuning shape — `messages`, the `tools` the harness declared, and
 * a `meta` block naming the exact evidence behind the line. It is a pure read
 * over durable artifacts: no model call, no Target execution, nothing written
 * except the one output file.
 *
 * Three rules decide everything here.
 *
 * 1. Sealed evidence never leaves. Visibility is checked on the bounded EvalRun
 *    index — the same `isSealedEvalRun` check `report`/`diagnose` use — BEFORE
 *    any member RunRecord, trace, or workspace snapshot is opened, and again on
 *    the verified record afterwards. A screen (`purpose: "screen"`) is not
 *    evidence and is refused the same way, and so is a legacy one-arm record
 *    whose purpose cannot be reconstructed.
 * 2. Everything is derived through `trace.ts`. It stays the only parser of Pi
 *    session JSONL, its hash check is the integrity proof, and its credential
 *    redactor runs over every string that reaches the output.
 * 3. The system message is what the run actually saw. It is read from that
 *    run's own model-visible workspace snapshot under
 *    `<runsRoot>/<runId>/workspace/`, never from the operator's current
 *    checkout — a dataset labelled with instructions the agent never received
 *    would be a lie about the harness (invariant 2).
 *
 * The same rule governs everything the line gained beyond the conversation. The
 * world a case started in is read from the corpus the EvalRun cites, its final
 * state from that run's own `runtime/world/state.json`; the judge's verdicts are
 * read from the sidecars `eval.ts` wrote and are never re-derived; the agent
 * kind is read off the run's own execution fingerprint. Every one of those
 * fields is optional in the line, so a file written before they existed is still
 * a valid file of this shape.
 */

/** Per-message content bound. Longer text is truncated with a marker, never dropped. */
export const MAX_DATASET_MESSAGE_CHARS = 20_000;
/** The effective instructions may legitimately be long; they are still bounded. */
export const MAX_DATASET_SYSTEM_CHARS = 60_000;
/** One tool call's serialized arguments. */
export const MAX_DATASET_TOOL_ARGUMENT_CHARS = 8_000;
/** Names, ids and other short metadata. */
export const MAX_DATASET_NAME_CHARS = 200;
/** Grader rows carried in `meta`. */
export const MAX_DATASET_GRADERS = 64;
/** Declared tool schemas carried in `tools`. */
export const MAX_DATASET_TOOLS = 128;
/** Skip reasons kept for the operator; the counts are always complete. */
export const MAX_DATASET_EXPORT_NOTES = 20;

const MAX_SNAPSHOT_MANIFEST_BYTES = 256 * 1024;
const MAX_SNAPSHOT_INSTRUCTIONS_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_TOOL_DESCRIPTOR_BYTES = 256 * 1024;
/** The world a case happens in is bounded at 16 KiB by the manifest; four times that is generous. */
const MAX_WORLD_STATE_BYTES = 64 * 1024;
/** One judge verdict sidecar. Bounded the way every other evidence read is. */
const MAX_JUDGE_VERDICT_BYTES = 256 * 1024;

/** Appended wherever content was cut. Nothing is ever silently shortened. */
export const DATASET_TRUNCATION_MARKER = "…[truncated by ahde export]";

/** Default selection bar: only runs whose graders were completely satisfied. */
export const DEFAULT_DATASET_MIN_SCORE = 1;

export class DatasetExportError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DatasetExportError";
	}
}

// ---------- The exported line ----------

export interface DatasetToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface DatasetMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: string;
	tool_calls?: DatasetToolCall[];
	/** Tool messages only: the tool that produced this result. */
	name?: string;
	/** Tool messages only: the assistant tool call this result answers. */
	tool_call_id?: string;
}

export interface DatasetToolSchema {
	type: "function";
	function: {
		name: string;
		description: string;
		/** Absent for a built-in capability, whose schema the harness does not own. */
		parameters?: Record<string, unknown>;
	};
}

/**
 * One grader row, as `run.json` recorded it.
 *
 * Only `type`, `passed` and `score` are guaranteed: every field below them
 * arrived with the recorded dataset, so a line written before them carries none
 * and is still a valid line of this shape.
 */
export interface DatasetGraderResult {
	type: string;
	passed: boolean;
	score: number;
	name?: string;
	reason?: string;
	checkCode?: string;
	checkSubject?: string;
	assertions?: { total: number; failed: number[] };
	/**
	 * Whether the judge declined to decide. Owned by the judge lane and read
	 * here as an optional boolean: this module never defines what it means.
	 */
	abstained?: boolean;
}

/**
 * The state a case happens in: what the corpus recorded it starting from, and
 * what the run left behind. `final` is `null` when the run wrote no world state
 * — a case with no world, or evidence recorded before worlds were persisted.
 */
export interface DatasetWorld {
	initial: Record<string, unknown> | null;
	final: Record<string, unknown> | null;
}

/** One judge verdict, exactly as its sidecar recorded it. Never re-derived. */
export interface DatasetJudgeVerdict {
	/** 0-based index into `meta.graders` — the grader this verdict decided. */
	grader: number;
	passed: boolean;
	score: number;
	choice?: string;
	assertions?: { index: number; answer: string; evidence: string }[];
	jury?: Record<string, unknown>[];
}

/**
 * The person the Target was talking to, when a model played one. `goal` and
 * `persona` are the case's own; `turns` and `stop` are what the conversation
 * actually did, and are absent rather than invented when the run recorded none.
 */
export interface DatasetSimulatedUser {
	goal: string;
	persona?: string;
	turns?: number;
	stop?: string;
}

/** Which kind of agent produced the conversation. Absent on a record predating the field. */
export interface DatasetExecution {
	agent: "pi-v1" | "command-v1";
}

export interface DatasetMeta {
	taskId: string;
	runId: string;
	evalRunId: string;
	targetSha: string;
	workspaceHash: string | null;
	model: string;
	graders: DatasetGraderResult[];
	/** Mean grader score in [0,1]; a graderless run keeps its binary outcome. */
	score: number;
	/** Whether `score` cleared the export's `--min-score` bar. */
	passed: boolean;
	repetition: number;
	/** Absent when the case had no world and the run left no world state. */
	world?: DatasetWorld;
	/** Absent when no judge graded this run. */
	judge?: { verdicts: DatasetJudgeVerdict[] };
	/** Absent when no model played the user. */
	simulatedUser?: DatasetSimulatedUser;
	execution?: DatasetExecution;
}

export interface DatasetExportLine {
	messages: DatasetMessage[];
	tools: DatasetToolSchema[];
	meta: DatasetMeta;
}

// ---------- Result ----------

export type DatasetSkipReason = "sealed" | "screen" | "failed" | "infra" | "aa";

export interface DatasetExportCounts {
	evalRunsScanned: number;
	/** Member runs across every scanned EvalRun, read from the bounded indexes. */
	runsScanned: number;
	exported: number;
	skipped: Record<DatasetSkipReason, number>;
}

export interface DatasetExportNote {
	evalRunId: string;
	runId: string | null;
	reason: DatasetSkipReason;
	detail: string;
}

export interface DatasetExportResult {
	path: string;
	counts: DatasetExportCounts;
	notes: DatasetExportNote[];
	/** True only when more notes existed than {@link MAX_DATASET_EXPORT_NOTES}. */
	notesTruncated: boolean;
	/**
	 * EvalRun indexes in the runs root that would not parse — legacy schema
	 * versions, damaged artifacts. They are not scanned and contribute to no
	 * count, so they are reported rather than silently absent from the export.
	 */
	unreadableEvalRunIds: string[];
	/**
	 * Which eval runs actually contributed a line, in scan order. The Builder
	 * names the one it exported; a summary line that had to guess would be a
	 * different claim from the file it points at.
	 */
	evalRunIds: string[];
}

/**
 * What one case declared about itself, read from the corpus the EvalRun cites.
 *
 * Deliberately a lookup rather than a corpus reference: the export never
 * re-reads the operator's checkout, and an eval whose cases came from the
 * manifest dataset simply has no published corpus to cite — it contributes no
 * task facts and the line carries none.
 */
export interface DatasetTaskFacts {
	world?: { state: Record<string, unknown> } | undefined;
	simulatedUser?: { goal: string; persona?: string | undefined } | undefined;
}

export type DatasetTaskLookup = (record: EvalRunRecord) => ReadonlyMap<string, DatasetTaskFacts>;

export interface ExportDatasetOptions {
	runsRoot: string;
	/** Exactly one of `runId`, `evalRunId`, `all` or `latest` selects the evidence. */
	runId?: string;
	evalRunId?: string;
	all?: boolean;
	/** The newest exportable evidence EvalRun. What `/export` in the Builder uses. */
	latest?: boolean;
	/**
	 * The directory that receives `<id>.jsonl`. Defaults to `exports/` under
	 * {@link ExportDatasetOptions.outRoot}.
	 */
	outDir?: string;
	/**
	 * Where the default `exports/` directory lives — the Target directory from
	 * the CLI. Defaults to the runs root, so the module stands alone.
	 */
	outRoot?: string;
	/** Selection bar on the mean grader score, in [0,1]. Defaults to 1. */
	minScore?: number;
	/** Also export runs below the bar, marked `passed: false`. */
	includeFailed?: boolean;
	/** Also export A/A calibration arms, which measure noise rather than behaviour. */
	includeAa?: boolean;
	/** Sealed corpus content hashes, so a legacy sealed eval run is refused too. */
	sealedDatasetHashes?: ReadonlySet<string>;
	/** The cases behind an EvalRun, for the world a case starts in and the user it played. */
	tasks?: DatasetTaskLookup;
	now?: () => Date;
}

// ---------- Bounded, redacted text ----------

function boundedText(value: string, maxChars: number): string {
	const redacted = redactTraceText(value);
	if (redacted.length <= maxChars) return redacted;
	return `${redacted.slice(0, maxChars)}${DATASET_TRUNCATION_MARKER}`;
}

// ---------- Workspace snapshot reads ----------

function snapshotPathParts(relativePath: string): string[] {
	if (!relativePath || relativePath.includes("\0") || isAbsolute(relativePath)) {
		throw new DatasetExportError(`unsafe workspace snapshot path ${JSON.stringify(relativePath)}`);
	}
	const parts = relativePath.split(/[\\/]/);
	if (parts.some((part) => !part || part === "." || part === "..")) {
		throw new DatasetExportError(`unsafe workspace snapshot path ${JSON.stringify(relativePath)}`);
	}
	return parts;
}

/**
 * Read one regular file out of a run's own model-visible workspace snapshot.
 * Symlinks, traversal, non-regular files and oversized bodies fail closed: this
 * is the only door between an export and bytes on disk, and the export must not
 * be talked out of the snapshot it was pointed at.
 */
function readSnapshotText(workspaceDir: string, relativePath: string, maxBytes: number): string {
	const parts = snapshotPathParts(relativePath);
	let cursor = workspaceDir;
	for (const [index, part] of parts.entries()) {
		cursor = join(cursor, part);
		let entry;
		try {
			entry = lstatSync(cursor);
		} catch (error) {
			throw new DatasetExportError(`workspace snapshot is missing ${relativePath}`, { cause: error });
		}
		if (entry.isSymbolicLink()) {
			throw new DatasetExportError(`workspace snapshot path must not traverse a symlink: ${relativePath}`);
		}
		const final = index === parts.length - 1;
		if (final ? !entry.isFile() : !entry.isDirectory()) {
			throw new DatasetExportError(`workspace snapshot path is not a regular file: ${relativePath}`);
		}
		if (final && entry.size > maxBytes) {
			throw new DatasetExportError(`workspace snapshot file exceeds ${maxBytes} bytes: ${relativePath}`);
		}
	}
	const canonical = realpathSync(cursor);
	const rel = relative(realpathSync(workspaceDir), canonical);
	if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
		throw new DatasetExportError(`workspace snapshot path escaped the run directory: ${relativePath}`);
	}
	return readFileSync(canonical, "utf8");
}

/**
 * Deliberately lenient about everything the export does not use. The snapshot
 * manifest is a historical artifact; refusing it because a field the export
 * never reads has since changed shape would throw away evidence for no gain.
 */
const SnapshotManifestSchema = z.object({
	instructions: z.object({ agentsMd: z.string().min(1).max(200) }),
	tools: z.array(z.string().min(1).max(200)).max(MAX_DATASET_TOOLS).default([]),
});

const SnapshotToolDescriptorSchema = z.object({
	name: z.string().min(1).max(MAX_DATASET_NAME_CHARS),
	description: z.string().min(1).max(4_000),
	parameters: z.record(z.string(), z.unknown()).optional(),
});

/** The harness as one run saw it: its effective instructions and declared tools. */
export interface DatasetHarnessProjection {
	system: string;
	tools: DatasetToolSchema[];
}

/**
 * Rebuild the harness projection from the exact workspace snapshot the run
 * executed against. A run without one — a `--workspace direct` diagnostic run,
 * or evidence whose run directory was pruned — has no reconstructable system
 * message, and the current checkout is never allowed to stand in for it.
 */
export function datasetHarnessProjection(runsRoot: string, run: RunRecord): DatasetHarnessProjection {
	const workspaceDir = resolveContainedArtifactPath(runsRoot, run.runId, "workspace");
	if (!existsSync(workspaceDir)) {
		throw new DatasetExportError(
			"run has no model-visible workspace snapshot, so its effective instructions cannot be reconstructed",
		);
	}
	const entry = lstatSync(workspaceDir);
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new DatasetExportError("run workspace snapshot must be a regular non-symlink directory");
	}

	const manifestText = readSnapshotText(workspaceDir, "manifest.yaml", MAX_SNAPSHOT_MANIFEST_BYTES);
	let manifestValue: unknown;
	try {
		manifestValue = parseYaml(manifestText);
	} catch (error) {
		throw new DatasetExportError("run workspace snapshot manifest is not valid YAML", { cause: error });
	}
	const manifest = SnapshotManifestSchema.safeParse(manifestValue);
	if (!manifest.success) {
		throw new DatasetExportError("run workspace snapshot manifest does not declare instructions and tools");
	}

	const system = boundedText(
		readSnapshotText(workspaceDir, manifest.data.instructions.agentsMd, MAX_SNAPSHOT_INSTRUCTIONS_BYTES),
		MAX_DATASET_SYSTEM_CHARS,
	);

	// Two kinds of capability travel together, and neither is invented. The
	// built-ins are the fixed host policy this run recorded; their schemas are
	// host-owned, so no `parameters` is fabricated for them. The declarative
	// tools carry the exact JSON Schema the harness declared.
	const builtins: DatasetToolSchema[] = [...new Set(run.execution.tools)]
		.sort()
		.slice(0, MAX_DATASET_TOOLS)
		.map((name) => ({
			type: "function" as const,
			function: {
				name: boundedText(name, MAX_DATASET_NAME_CHARS),
				description:
					"Built-in Target capability declared by the harness (execution.tools). " +
					"Its schema is host-owned and the harness declares no parameters for it.",
			},
		}));

	const declared: DatasetToolSchema[] = [];
	for (const descriptorPath of manifest.data.tools) {
		const descriptorText = readSnapshotText(workspaceDir, descriptorPath, MAX_SNAPSHOT_TOOL_DESCRIPTOR_BYTES);
		let descriptorValue: unknown;
		try {
			descriptorValue = parseYaml(descriptorText);
		} catch (error) {
			throw new DatasetExportError(`declared tool descriptor is not valid YAML: ${descriptorPath}`, { cause: error });
		}
		const descriptor = SnapshotToolDescriptorSchema.safeParse(descriptorValue);
		if (!descriptor.success) {
			throw new DatasetExportError(`declared tool descriptor is unreadable: ${descriptorPath}`);
		}
		declared.push({
			type: "function",
			function: {
				name: boundedText(descriptor.data.name, MAX_DATASET_NAME_CHARS),
				description: boundedText(descriptor.data.description, MAX_DATASET_MESSAGE_CHARS),
				...(descriptor.data.parameters ? { parameters: descriptor.data.parameters } : {}),
			},
		});
	}
	declared.sort((left, right) => left.function.name.localeCompare(right.function.name));

	return { system, tools: [...builtins, ...declared].slice(0, MAX_DATASET_TOOLS) };
}

// ---------- Messages ----------

/**
 * One conversation in the standard chat-tuning shape. Bounded the way a report
 * bounds a trace — per-message truncation with a marker — but nothing is ever
 * dropped: a training example missing a turn is a different conversation.
 *
 * Every tool call and every tool result the run made is already here, as an
 * assistant `tool_calls` entry and the `tool` message that answers it. Nothing
 * in `meta` repeats them.
 */
export function datasetMessages(system: string, messages: readonly TraceMessage[]): DatasetMessage[] {
	const out: DatasetMessage[] = [{ role: "system", content: system }];
	for (const message of messages) {
		if (message.role === "user") {
			out.push({ role: "user", content: boundedText(message.text, MAX_DATASET_MESSAGE_CHARS) });
			continue;
		}
		if (message.role === "assistant") {
			const text = boundedText(message.text, MAX_DATASET_MESSAGE_CHARS);
			const calls = (message.toolCalls ?? []).map((call): DatasetToolCall => ({
				id: boundedText(call.id, MAX_DATASET_NAME_CHARS),
				type: "function",
				function: {
					name: boundedText(call.name, MAX_DATASET_NAME_CHARS),
					arguments: boundedText(JSON.stringify(call.arguments), MAX_DATASET_TOOL_ARGUMENT_CHARS),
				},
			}));
			// An assistant turn that only called tools said nothing; an assistant
			// turn that only spoke called nothing. Both are real turns and both stay.
			out.push({
				role: "assistant",
				...(calls.length > 0 ? { tool_calls: calls } : {}),
				...(calls.length === 0 || text.length > 0 ? { content: text } : {}),
			});
			continue;
		}
		const result = message.toolResult;
		out.push({
			role: "tool",
			name: boundedText(result?.toolName ?? "", MAX_DATASET_NAME_CHARS),
			tool_call_id: boundedText(result?.toolCallId ?? "", MAX_DATASET_NAME_CHARS),
			content: boundedText(result?.text ?? message.text, MAX_DATASET_MESSAGE_CHARS),
		});
	}
	return out;
}

// ---------- The world, the verdicts, and the agent kind ----------

const JsonObjectSchema = z.record(z.string(), z.unknown());

/**
 * Read one bounded JSON object out of a run's own directory by convention.
 * Every rule the workspace snapshot reader applies applies here: the resolver
 * refuses traversal and symlinked ancestors, the size is checked before the
 * bytes are read, and anything that is not a JSON object is nothing.
 */
function readContainedJsonObject(
	runsRoot: string,
	runId: string,
	descendants: readonly string[],
	maxBytes: number,
): Record<string, unknown> | null {
	let path: string;
	try {
		path = resolveContainedArtifactPath(runsRoot, runId, ...descendants);
	} catch {
		return null;
	}
	let entry;
	try {
		entry = lstatSync(path);
	} catch {
		return null;
	}
	if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maxBytes) return null;
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
	const parsed = JsonObjectSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/**
 * The world the run left behind, written by the world lane at
 * `runs/<runId>/runtime/world/state.json`. Absent is the ordinary case — a case
 * with no world, or evidence recorded before worlds were persisted — and is
 * `null`, never an invented empty state.
 */
export function runFinalWorld(runsRoot: string, runId: string): Record<string, unknown> | null {
	return readContainedJsonObject(runsRoot, runId, ["runtime", "world", "state.json"], MAX_WORLD_STATE_BYTES);
}

/** Lenient on purpose: the sidecar is read, never re-derived, and its shape belongs to `eval.ts`. */
const JudgeVerdictSidecarSchema = z.object({
	passed: z.boolean(),
	score: z.number().finite(),
	choice: z.string().max(MAX_DATASET_NAME_CHARS).optional(),
	assertions: z
		.array(z.object({
			index: z.number().int(),
			answer: z.string().max(MAX_DATASET_NAME_CHARS),
			evidence: z.string(),
		}))
		.max(64)
		.optional(),
	jury: z.array(JsonObjectSchema).max(16).optional(),
});

/**
 * The verdicts the judge wrote for this run, read from
 * `runs/<runId>/judge/<graderIndex>.verdict.json`. The index is the grader's
 * own position, so a verdict always names the grader it decided. A grader that
 * called no judge has no sidecar and contributes nothing.
 */
export function runJudgeVerdicts(
	runsRoot: string,
	runId: string,
	graderCount: number,
): DatasetJudgeVerdict[] {
	const verdicts: DatasetJudgeVerdict[] = [];
	for (let index = 0; index < Math.min(graderCount, MAX_DATASET_GRADERS); index += 1) {
		const value = readContainedJsonObject(
			runsRoot,
			runId,
			["judge", `${index}.verdict.json`],
			MAX_JUDGE_VERDICT_BYTES,
		);
		if (!value) continue;
		const parsed = JudgeVerdictSidecarSchema.safeParse(value);
		if (!parsed.success) continue;
		verdicts.push({
			grader: index,
			passed: parsed.data.passed,
			score: parsed.data.score,
			...(parsed.data.choice !== undefined ? { choice: boundedText(parsed.data.choice, MAX_DATASET_NAME_CHARS) } : {}),
			...(parsed.data.assertions
				? {
					assertions: parsed.data.assertions.map((assertion) => ({
						index: assertion.index,
						answer: assertion.answer,
						evidence: boundedText(assertion.evidence, MAX_DATASET_MESSAGE_CHARS),
					})),
				}
				: {}),
			...(parsed.data.jury ? { jury: parsed.data.jury } : {}),
		});
	}
	return verdicts;
}

/**
 * Which kind of agent produced this conversation.
 *
 * The adapter lane owns `execution.agent`; this reads it as an optional value
 * and defines nothing. Every run recorded before the field existed was a Pi
 * invocation, so its absence means `pi-v1` — that is a fact about the harness,
 * not a default standing in for one.
 */
export function runAgentKind(run: { execution: Readonly<Record<string, unknown>> }): DatasetExecution["agent"] {
	return run.execution.agent === "command-v1" ? "command-v1" : "pi-v1";
}

// ---------- Selection ----------

/**
 * A/A calibration arms, derived from the indexes themselves rather than from a
 * Candidate record. Invariant 3: baseline and candidate revisions differ EXCEPT
 * in explicit A/A calibration mode, so a candidate arm whose baseline ran the
 * same Target revision is one half of an A/A pair and its baseline is the other.
 *
 * A candidate whose baseline index cannot be read is counted here too: without
 * that record there is no proof the two revisions differ, and an unprovable
 * pair is excluded rather than assumed to be behavioural evidence.
 */
export function aaCalibrationEvalRunIds(indexes: readonly EvalRunRecord[]): Set<string> {
	const byId = new Map(indexes.map((record) => [record.evalRunId, record]));
	const arms = new Set<string>();
	for (const record of indexes) {
		if (record.label !== "candidate" || record.baselineEvalRunId === null) continue;
		const baseline = byId.get(record.baselineEvalRunId);
		if (baseline && baseline.target.gitSha !== record.target.gitSha) continue;
		arms.add(record.evalRunId);
		if (baseline) arms.add(baseline.evalRunId);
	}
	return arms;
}

interface SkipTally {
	counts: DatasetExportCounts;
	notes: DatasetExportNote[];
	notesTruncated: boolean;
}

function note(tally: SkipTally, entry: DatasetExportNote): void {
	if (tally.notes.length < MAX_DATASET_EXPORT_NOTES) {
		tally.notes.push({ ...entry, detail: entry.detail.slice(0, 400) });
		return;
	}
	tally.notesTruncated = true;
}

function errorDetail(error: unknown): string {
	return redactTraceText(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ");
}

/**
 * Why one EvalRun contributes nothing, decided on the bounded index alone. This
 * runs before any member RunRecord, trace or workspace snapshot is opened, so a
 * sealed or screen eval run is refused without its content ever being read.
 */
function indexRefusal(
	record: EvalRunRecord,
	options: { sealedDatasetHashes: ReadonlySet<string>; aaArms: ReadonlySet<string>; includeAa: boolean },
): { reason: DatasetSkipReason; detail: string } | null {
	if (isSealedEvalRun(record, options.sealedDatasetHashes)) {
		return { reason: "sealed", detail: "sealed holdout evidence is never exported" };
	}
	if (record.purpose !== "evidence") {
		return {
			reason: "screen",
			detail: record.purpose === "screen"
				? "a cheap-check screen is never evidence"
				: "a legacy one-arm record whose purpose cannot be reconstructed is never evidence",
		};
	}
	if (!options.includeAa && options.aaArms.has(record.evalRunId)) {
		return {
			reason: "aa",
			detail: "an A/A calibration arm measures run-to-run noise, not behaviour",
		};
	}
	return null;
}

/** Exactly one selection, named the way the operator named it. */
function selectionOf(options: ExportDatasetOptions): "run" | "eval" | "all" | "latest" {
	const chosen: ("run" | "eval" | "all" | "latest")[] = [];
	if (options.runId !== undefined) chosen.push("run");
	if (options.evalRunId !== undefined) chosen.push("eval");
	if (options.all === true) chosen.push("all");
	if (options.latest === true) chosen.push("latest");
	if (chosen.length !== 1) {
		throw new DatasetExportError("the dataset export selects one --run <run-id>, one --eval <erun-id>, or --all");
	}
	return chosen[0]!;
}

/**
 * Compile the recorded dataset. Returns the written path plus exactly how many
 * runs were scanned, exported, and skipped for each reason.
 */
export function exportDataset(options: ExportDatasetOptions): DatasetExportResult {
	const runsRoot = resolve(options.runsRoot);
	const selection = selectionOf(options);
	const minScore = options.minScore ?? DEFAULT_DATASET_MIN_SCORE;
	if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
		throw new DatasetExportError("--min-score must be between 0 and 1");
	}
	const sealedDatasetHashes = options.sealedDatasetHashes ?? new Set<string>();
	const includeAa = options.includeAa === true;

	// Every index is read regardless of the selection: A/A pairing is a fact
	// about two eval runs, and one of them may not be the one that was named.
	const listed = listEvalRunIndexesLenient(runsRoot);
	const aaArms = aaCalibrationEvalRunIds(listed.records);
	const refusalOptions = { sealedDatasetHashes, aaArms, includeAa };

	let selected: EvalRunRecord[];
	/** Only the runs the operator asked for, when they asked for one. */
	let onlyRunId: string | null = null;
	let subject: string;
	if (selection === "all") {
		selected = listed.records;
		subject = `all-${(options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-")}`;
	} else if (selection === "latest") {
		const exportable = listed.records
			.filter((record) => indexRefusal(record, refusalOptions) === null)
			.sort((left, right) => left.finishedAt.localeCompare(right.finishedAt));
		const newest = exportable[exportable.length - 1];
		if (!newest) throw new DatasetExportError("no exportable development evidence has been recorded yet");
		selected = [newest];
		subject = newest.evalRunId;
	} else if (selection === "run") {
		const runId = options.runId!;
		const owner = listed.records.find((record) => record.runIds.includes(runId));
		if (!owner) throw new DatasetExportError(`run ${runId} belongs to no readable eval run`);
		const refusal = indexRefusal(owner, refusalOptions);
		if (refusal) throw new DatasetExportError(`run ${runId} is not exportable: ${refusal.detail}`);
		selected = [owner];
		onlyRunId = runId;
		subject = runId;
	} else {
		const explicit = options.evalRunId!;
		let record: EvalRunRecord;
		try {
			record = readEvalRunIndex(runsRoot, explicit);
		} catch (error) {
			throw new DatasetExportError(`eval run ${explicit} is unavailable: ${errorDetail(error)}`, { cause: error });
		}
		const refusal = indexRefusal(record, refusalOptions);
		if (refusal) throw new DatasetExportError(`eval run ${explicit} is not exportable: ${refusal.detail}`);
		selected = [record];
		subject = explicit;
	}

	const tally: SkipTally = {
		counts: {
			evalRunsScanned: selected.length,
			runsScanned: 0,
			exported: 0,
			skipped: { sealed: 0, screen: 0, failed: 0, infra: 0, aa: 0 },
		},
		notes: [],
		notesTruncated: false,
	};
	const lines: string[] = [];
	const contributed: string[] = [];

	for (const index of selected) {
		const memberCount = onlyRunId === null ? index.runIds.length : 1;
		tally.counts.runsScanned += memberCount;
		const refusal = indexRefusal(index, refusalOptions);
		if (refusal) {
			tally.counts.skipped[refusal.reason] += memberCount;
			note(tally, { evalRunId: index.evalRunId, runId: null, reason: refusal.reason, detail: refusal.detail });
			continue;
		}
		// Belt and braces after the record's own `purpose`: an unreadable
		// `runs/screens/` marker refuses everything it might name.
		if (isScreenEvalRun(runsRoot, index.evalRunId)) {
			tally.counts.skipped.screen += memberCount;
			note(tally, {
				evalRunId: index.evalRunId,
				runId: null,
				reason: "screen",
				detail: "the runs/screens/ marker refuses this eval run",
			});
			continue;
		}

		let verified;
		try {
			verified = loadVerifiedEvalRun(runsRoot, index.evalRunId);
		} catch (error) {
			tally.counts.skipped.infra += memberCount;
			note(tally, { evalRunId: index.evalRunId, runId: null, reason: "infra", detail: errorDetail(error) });
			continue;
		}
		// Visibility is re-read from the verified record: the index that passed
		// preflight and the record that produced these runs must be the same one.
		if (isSealedEvalRun(verified.record, sealedDatasetHashes) || verified.record.purpose !== "evidence") {
			tally.counts.skipped.sealed += memberCount;
			note(tally, {
				evalRunId: index.evalRunId,
				runId: null,
				reason: "sealed",
				detail: "evaluation visibility or purpose changed during collection",
			});
			continue;
		}

		const members = onlyRunId === null
			? verified.runs
			: verified.runs.filter((run) => run.runId === onlyRunId);

		let harness: DatasetHarnessProjection | undefined;
		let harnessError: unknown;
		for (const run of verified.runs) {
			if (harness) break;
			try {
				harness = datasetHarnessProjection(runsRoot, run);
			} catch (error) {
				harnessError ??= error;
			}
		}
		if (!harness) {
			tally.counts.skipped.infra += members.length;
			note(tally, {
				evalRunId: index.evalRunId,
				runId: null,
				reason: "infra",
				detail: errorDetail(harnessError ?? new Error("no member run carries a workspace snapshot")),
			});
			continue;
		}

		// The cases the eval cited, read once per eval run rather than per run.
		// A lookup that cannot find the corpus contributes an empty map, and the
		// lines simply carry no world and no simulated user.
		let taskFacts: ReadonlyMap<string, DatasetTaskFacts>;
		try {
			taskFacts = options.tasks?.(index) ?? new Map();
		} catch {
			taskFacts = new Map();
		}

		let contributedHere = false;
		for (const run of members) {
			if (run.status !== "completed" || run.evalResults === null) {
				tally.counts.skipped.infra += 1;
				note(tally, {
					evalRunId: index.evalRunId,
					runId: run.runId,
					reason: "infra",
					detail: run.error ? errorDetail(new Error(run.error)) : `run status ${run.status} is inconclusive`,
				});
				continue;
			}
			if (run.trace.sha256 === null) {
				tally.counts.skipped.infra += 1;
				note(tally, {
					evalRunId: index.evalRunId,
					runId: run.runId,
					reason: "infra",
					detail: "completed run has no recorded trace",
				});
				continue;
			}
			const score = runGraderScore(run);
			const passed = score >= minScore;
			if (!passed && options.includeFailed !== true) {
				tally.counts.skipped.failed += 1;
				note(tally, {
					evalRunId: index.evalRunId,
					runId: run.runId,
					reason: "failed",
					detail: `mean grader score ${score.toFixed(3)} is below --min-score ${minScore}`,
				});
				continue;
			}

			let messages: TraceMessage[];
			try {
				const traceArtifact = resolveContainedArtifactPath(runsRoot, run.runId, run.trace.path);
				messages = openTrace(dirname(traceArtifact), basename(traceArtifact), run.trace.sha256);
			} catch (error) {
				tally.counts.skipped.infra += 1;
				note(tally, { evalRunId: index.evalRunId, runId: run.runId, reason: "infra", detail: errorDetail(error) });
				continue;
			}

			lines.push(JSON.stringify(datasetLine({
				run,
				evalRunId: index.evalRunId,
				harness,
				messages,
				score,
				passed,
				task: taskFacts.get(run.taskId),
				finalWorld: runFinalWorld(runsRoot, run.runId),
				verdicts: runJudgeVerdicts(runsRoot, run.runId, run.evalResults.graders.length),
			})));
			tally.counts.exported += 1;
			contributedHere = true;
		}
		if (contributedHere) contributed.push(index.evalRunId);
	}

	const path = join(
		options.outDir ? resolve(options.outDir) : join(resolve(options.outRoot ?? runsRoot), "exports"),
		`${safeArtifactSegment(subject, "export subject")}.jsonl`,
	);
	writeTextArtifact(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
	return {
		path,
		counts: tally.counts,
		notes: tally.notes,
		notesTruncated: tally.notesTruncated,
		// An index that will not parse was never a candidate for export, but an
		// operator counting lines deserves to know it existed.
		unreadableEvalRunIds: selection === "all"
			? listed.invalid.map((entry) => entry.evalRunId).sort()
			: [],
		evalRunIds: contributed,
	};
}

// ---------- One line ----------

/** Everything one exported line reads off a run record. */
export interface DatasetRunFacts {
	runId: string;
	taskId: string;
	repetitionIndex: number;
	target: { gitSha: string; workspaceHash?: string | undefined };
	model: { id: string };
	/**
	 * Structural on purpose. The adapter lane owns `execution.agent`; this
	 * module reads it without defining it, and a record that has none is a Pi
	 * invocation by construction.
	 */
	execution: Readonly<Record<string, unknown>>;
	metrics: { conversationTurns?: number | undefined; conversationStop?: string | undefined };
	evalResults: {
		graders: readonly {
			name?: string;
			type: string;
			passed: boolean;
			score: number;
			reason?: string;
			checkCode?: string | undefined;
			checkSubject?: string | undefined;
			assertions?: { total: number; failed: readonly number[] } | undefined;
			/** The judge lane's field: read as optional, never defined here. */
			abstained?: unknown;
		}[];
	} | null;
}

export interface DatasetLineInput {
	run: DatasetRunFacts;
	evalRunId: string;
	harness: DatasetHarnessProjection;
	messages: readonly TraceMessage[];
	score: number;
	passed: boolean;
	/** What the corpus recorded about this case, when the eval cited one. */
	task?: DatasetTaskFacts | undefined;
	/** The world the run left behind, or null when it left none. */
	finalWorld?: Record<string, unknown> | null;
	verdicts?: readonly DatasetJudgeVerdict[];
}

/**
 * One exported line: the conversation, the harness that produced it, and the
 * evidence behind it.
 *
 * Pure, and typed structurally rather than against `RunRecord`, so the two
 * fields that belong to other lanes — the adapter's `execution.agent` and a
 * command Target's metrics — can be exercised without this module claiming
 * either. Nothing here invents a number: a metric the record does not carry is
 * an absent key, never a zero.
 */
export function datasetLine(input: DatasetLineInput): DatasetExportLine {
	const { run } = input;
	const graders = (run.evalResults?.graders ?? []).slice(0, MAX_DATASET_GRADERS).map((grader): DatasetGraderResult => ({
		type: boundedText(grader.type, MAX_DATASET_NAME_CHARS),
		passed: grader.passed,
		score: grader.score,
		...(grader.name !== undefined ? { name: boundedText(grader.name, MAX_DATASET_NAME_CHARS) } : {}),
		...(grader.reason !== undefined ? { reason: boundedText(grader.reason, MAX_DATASET_MESSAGE_CHARS) } : {}),
		...(grader.checkCode !== undefined ? { checkCode: boundedText(grader.checkCode, MAX_DATASET_NAME_CHARS) } : {}),
		...(grader.checkSubject !== undefined
			? { checkSubject: boundedText(grader.checkSubject, MAX_DATASET_NAME_CHARS) }
			: {}),
		...(grader.assertions
			? { assertions: { total: grader.assertions.total, failed: [...grader.assertions.failed] } }
			: {}),
		...(typeof grader.abstained === "boolean" ? { abstained: grader.abstained } : {}),
	}));

	const initialWorld = input.task?.world?.state ?? null;
	const finalWorld = input.finalWorld ?? null;
	const simulatedUser = input.task?.simulatedUser;
	const verdicts = input.verdicts ?? [];

	return {
		messages: datasetMessages(input.harness.system, input.messages),
		tools: input.harness.tools,
		meta: {
			taskId: publicTaskId(run.taskId),
			runId: run.runId,
			evalRunId: input.evalRunId,
			targetSha: run.target.gitSha,
			workspaceHash: run.target.workspaceHash ?? null,
			model: boundedText(run.model.id, MAX_DATASET_NAME_CHARS),
			graders,
			score: input.score,
			passed: input.passed,
			repetition: run.repetitionIndex,
			// A case with neither a recorded starting world nor a recorded final
			// one had no world; the key is absent rather than two nulls.
			...(initialWorld !== null || finalWorld !== null
				? { world: { initial: initialWorld, final: finalWorld } }
				: {}),
			...(verdicts.length > 0 ? { judge: { verdicts: [...verdicts] } } : {}),
			...(simulatedUser
				? {
					simulatedUser: {
						goal: boundedText(simulatedUser.goal, MAX_DATASET_MESSAGE_CHARS),
						...(simulatedUser.persona !== undefined
							? { persona: boundedText(simulatedUser.persona, MAX_DATASET_MESSAGE_CHARS) }
							: {}),
						...(run.metrics.conversationTurns !== undefined ? { turns: run.metrics.conversationTurns } : {}),
						...(run.metrics.conversationStop !== undefined ? { stop: run.metrics.conversationStop } : {}),
					},
				}
				: {}),
			execution: { agent: runAgentKind(run) },
		},
	};
}

// ---------- The cases an eval cited ----------

/**
 * This project's sealed corpus content hashes, so an eval run recorded before
 * `evidenceVisibility` existed is still refused by what its dataset hashes to.
 * A state root that cannot be listed contributes nothing rather than an
 * exception: the explicit `evidenceVisibility` check is unaffected.
 */
/**
 * The cases behind an EvalRun, read from the published corpus it cites.
 *
 * The corpus is the only place the export will look: `loadCorpus` verifies the
 * content hash it was published under, and the eval run names both the label
 * and the hash, so the cases returned are provably the ones that were scored.
 * An eval whose cases came from the Target's manifest dataset cites no corpus —
 * reading `evals/dataset.jsonl` out of the operator's current checkout would be
 * exactly the reread invariant 2 forbids — and contributes no facts at all.
 */
export function sealedDatasetHashesFor(options: { stateRoot: string; projectId: string }): Set<string> {
	try {
		return new Set(
			listCorpora(options)
				.filter((corpus) => corpus.visibility === "sealed")
				.map((corpus) => corpus.hash),
		);
	} catch {
		return new Set();
	}
}

export function corpusTaskLookup(options: { stateRoot: string; projectId: string }): DatasetTaskLookup {
	const cache = new Map<string, ReadonlyMap<string, DatasetTaskFacts>>();
	return (record) => {
		const key = `${record.dataset}\x00${record.datasetHash}`;
		const cached = cache.get(key);
		if (cached) return cached;
		const facts = new Map<string, DatasetTaskFacts>();
		try {
			const match = listCorpora({ stateRoot: options.stateRoot, projectId: options.projectId }).find(
				(metadata) =>
					corpusDatasetLabel(metadata.visibility as CorpusVisibility, metadata.id) === record.dataset &&
					metadata.hash === record.datasetHash,
			);
			// A sealed corpus never reaches here — the export refused the eval run
			// long before — but the visibility check is stated rather than assumed.
			if (match && match.visibility === "development") {
				for (const task of loadCorpus({ ...options, corpusId: match.id }).tasks) {
					facts.set(task.id, {
						...(task.world ? { world: { state: task.world.state } } : {}),
						...(task.simulatedUser
							? {
								simulatedUser: {
									goal: task.simulatedUser.goal,
									...(task.simulatedUser.persona !== undefined ? { persona: task.simulatedUser.persona } : {}),
								},
							}
							: {}),
					});
				}
			}
		} catch {
			// A corpus that will not load contributes nothing. The conversation,
			// the graders and the verdicts are unaffected, and a line without a
			// world is honest about the one thing that could not be read.
		}
		cache.set(key, facts);
		return facts;
	};
}

// ---------- CLI glue ----------

/**
 * Turn one validated CLI invocation's flags into export options.
 *
 * This lives here rather than in `cli.ts` so it can be pinned by a test. It
 * consumes the parser's own flag map — where a boolean flag is the string
 * `"true"` — instead of re-reading `process.argv`, which cannot tell
 * `--all` at the end of a line from `--all` that was never passed.
 */
export function datasetExportOptionsFromFlags(
	flags: Readonly<Record<string, string | undefined>>,
	base: {
		runsRoot: string;
		outRoot?: string;
		sealedDatasetHashes?: ReadonlySet<string>;
		tasks?: DatasetTaskLookup;
		now?: () => Date;
	},
): ExportDatasetOptions {
	const minScore = flags["min-score"] === undefined
		? undefined
		: parsePassRateFlag(flags["min-score"]) ?? DEFAULT_DATASET_MIN_SCORE;
	return {
		runsRoot: base.runsRoot,
		...(base.outRoot !== undefined ? { outRoot: base.outRoot } : {}),
		...(base.sealedDatasetHashes ? { sealedDatasetHashes: base.sealedDatasetHashes } : {}),
		...(base.tasks ? { tasks: base.tasks } : {}),
		...(base.now ? { now: base.now } : {}),
		...(flags.run !== undefined ? { runId: flags.run } : {}),
		...(flags.eval !== undefined ? { evalRunId: flags.eval } : {}),
		...(flags.all === "true" ? { all: true } : {}),
		...(flags.out !== undefined ? { outDir: resolve(flags.out) } : {}),
		...(minScore !== undefined ? { minScore } : {}),
		...(flags["include-failed"] === "true" ? { includeFailed: true } : {}),
		...(flags["include-aa"] === "true" ? { includeAa: true } : {}),
	};
}

/** One operator-facing summary; the counts always add up to `runsScanned`. */
export function renderDatasetExportSummary(result: DatasetExportResult): string[] {
	const { counts } = result;
	const skippedTotal = Object.values(counts.skipped).reduce((sum, value) => sum + value, 0);
	const lines = [
		result.path,
		`scanned ${counts.evalRunsScanned} eval run(s) · ${counts.runsScanned} run(s) · exported ${counts.exported}`,
		`skipped ${skippedTotal} — sealed ${counts.skipped.sealed}, screen ${counts.skipped.screen}, ` +
			`failed ${counts.skipped.failed}, infra ${counts.skipped.infra}, aa ${counts.skipped.aa}`,
	];
	for (const entry of result.notes) {
		lines.push(`note: ${entry.evalRunId}${entry.runId ? `/${entry.runId}` : ""} · ${entry.reason} · ${entry.detail}`);
	}
	if (result.notesTruncated) lines.push(`note: further skip reasons omitted after ${MAX_DATASET_EXPORT_NOTES}`);
	if (result.unreadableEvalRunIds.length > 0) {
		lines.push(
			`note: ${result.unreadableEvalRunIds.length} eval run index(es) could not be read and were not scanned: ` +
				result.unreadableEvalRunIds.slice(0, MAX_DATASET_EXPORT_NOTES).join(", "),
		);
	}
	return lines;
}
