import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parsePassRateFlag } from "../cli-invocation.js";
import { runGraderScore } from "../compare.js";
import { isScreenEvalRun } from "./cheap-check.js";
import { publicTaskId } from "./improvement-brief.js";
import {
	isSealedEvalRun,
	listEvalRunIndexesLenient,
	loadVerifiedEvalRun,
	readEvalRunIndex,
	type EvalRunRecord,
} from "../eval.js";
import type { RunRecord } from "../provenance.js";
import { writeTextArtifact } from "../storage/artifacts.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";
import { openTrace, redactTraceText, type TraceMessage } from "../trace.js";

/**
 * `ahde export --training` — the training-data export.
 *
 * This module turns already-created development evidence into JSONL a later
 * "train a small model under the optimized harness" step can read. It is a pure
 * read over durable artifacts: no model call, no Target execution, nothing
 * written except the one output file.
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
 *    checkout — a training corpus labelled with instructions the agent never
 *    received would be a lie about the harness (invariant 2).
 */

/** Per-message content bound. Longer text is truncated with a marker, never dropped. */
export const MAX_TRAINING_MESSAGE_CHARS = 20_000;
/** The effective instructions may legitimately be long; they are still bounded. */
export const MAX_TRAINING_SYSTEM_CHARS = 60_000;
/** One tool call's serialized arguments. */
export const MAX_TRAINING_TOOL_ARGUMENT_CHARS = 8_000;
/** Names, ids and other short metadata. */
export const MAX_TRAINING_NAME_CHARS = 200;
/** Grader rows carried in `meta`. */
export const MAX_TRAINING_GRADERS = 64;
/** Declared tool schemas carried in `tools`. */
export const MAX_TRAINING_TOOLS = 128;
/** Skip reasons kept for the operator; the counts are always complete. */
export const MAX_TRAINING_EXPORT_NOTES = 20;

const MAX_SNAPSHOT_MANIFEST_BYTES = 256 * 1024;
const MAX_SNAPSHOT_INSTRUCTIONS_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_TOOL_DESCRIPTOR_BYTES = 256 * 1024;

/** Appended wherever content was cut. Nothing is ever silently shortened. */
export const TRAINING_TRUNCATION_MARKER = "…[truncated by ahde export --training]";

/** Default selection bar: only runs whose graders were completely satisfied. */
export const DEFAULT_TRAINING_MIN_SCORE = 1;

export class TrainingExportError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "TrainingExportError";
	}
}

// ---------- The exported line ----------

export interface TrainingToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface TrainingMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: string;
	tool_calls?: TrainingToolCall[];
	/** Tool messages only: the tool that produced this result. */
	name?: string;
	/** Tool messages only: the assistant tool call this result answers. */
	tool_call_id?: string;
}

export interface TrainingToolSchema {
	type: "function";
	function: {
		name: string;
		description: string;
		/** Absent for a built-in capability, whose schema the harness does not own. */
		parameters?: Record<string, unknown>;
	};
}

export interface TrainingGraderResult {
	type: string;
	passed: boolean;
	score: number;
}

export interface TrainingMeta {
	taskId: string;
	runId: string;
	evalRunId: string;
	targetSha: string;
	workspaceHash: string | null;
	model: string;
	graders: TrainingGraderResult[];
	/** Mean grader score in [0,1]; a graderless run keeps its binary outcome. */
	score: number;
	/** Whether `score` cleared the export's `--min-score` bar. */
	passed: boolean;
	repetition: number;
}

export interface TrainingExportLine {
	messages: TrainingMessage[];
	tools: TrainingToolSchema[];
	meta: TrainingMeta;
}

// ---------- Result ----------

export type TrainingSkipReason = "sealed" | "screen" | "failed" | "infra" | "aa";

export interface TrainingExportCounts {
	evalRunsScanned: number;
	/** Member runs across every scanned EvalRun, read from the bounded indexes. */
	runsScanned: number;
	exported: number;
	skipped: Record<TrainingSkipReason, number>;
}

export interface TrainingExportNote {
	evalRunId: string;
	runId: string | null;
	reason: TrainingSkipReason;
	detail: string;
}

export interface TrainingExportResult {
	path: string;
	counts: TrainingExportCounts;
	notes: TrainingExportNote[];
	/** True only when more notes existed than {@link MAX_TRAINING_EXPORT_NOTES}. */
	notesTruncated: boolean;
	/**
	 * EvalRun indexes in the runs root that would not parse — legacy schema
	 * versions, damaged artifacts. They are not scanned and contribute to no
	 * count, so they are reported rather than silently absent from the export.
	 */
	unreadableEvalRunIds: string[];
}

export interface ExportTrainingDataOptions {
	runsRoot: string;
	/** Exactly one of `evalRunId` or `all` selects the evidence. */
	evalRunId?: string;
	all?: boolean;
	outPath?: string;
	/** Selection bar on the mean grader score, in [0,1]. Defaults to 1. */
	minScore?: number;
	/** Also export runs below the bar, marked `passed: false`. */
	includeFailed?: boolean;
	/** Also export A/A calibration arms, which measure noise rather than behaviour. */
	includeAa?: boolean;
	/** Sealed corpus content hashes, so a legacy sealed eval run is refused too. */
	sealedDatasetHashes?: ReadonlySet<string>;
	now?: () => Date;
}

// ---------- Bounded, redacted text ----------

function boundedText(value: string, maxChars: number): string {
	const redacted = redactTraceText(value);
	if (redacted.length <= maxChars) return redacted;
	return `${redacted.slice(0, maxChars)}${TRAINING_TRUNCATION_MARKER}`;
}

// ---------- Workspace snapshot reads ----------

function snapshotPathParts(relativePath: string): string[] {
	if (!relativePath || relativePath.includes("\0") || isAbsolute(relativePath)) {
		throw new TrainingExportError(`unsafe workspace snapshot path ${JSON.stringify(relativePath)}`);
	}
	const parts = relativePath.split(/[\\/]/);
	if (parts.some((part) => !part || part === "." || part === "..")) {
		throw new TrainingExportError(`unsafe workspace snapshot path ${JSON.stringify(relativePath)}`);
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
			throw new TrainingExportError(`workspace snapshot is missing ${relativePath}`, { cause: error });
		}
		if (entry.isSymbolicLink()) {
			throw new TrainingExportError(`workspace snapshot path must not traverse a symlink: ${relativePath}`);
		}
		const final = index === parts.length - 1;
		if (final ? !entry.isFile() : !entry.isDirectory()) {
			throw new TrainingExportError(`workspace snapshot path is not a regular file: ${relativePath}`);
		}
		if (final && entry.size > maxBytes) {
			throw new TrainingExportError(`workspace snapshot file exceeds ${maxBytes} bytes: ${relativePath}`);
		}
	}
	const canonical = realpathSync(cursor);
	const rel = relative(realpathSync(workspaceDir), canonical);
	if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
		throw new TrainingExportError(`workspace snapshot path escaped the run directory: ${relativePath}`);
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
	tools: z.array(z.string().min(1).max(200)).max(MAX_TRAINING_TOOLS).default([]),
});

const SnapshotToolDescriptorSchema = z.object({
	name: z.string().min(1).max(MAX_TRAINING_NAME_CHARS),
	description: z.string().min(1).max(4_000),
	parameters: z.record(z.string(), z.unknown()).optional(),
});

/** The harness as one run saw it: its effective instructions and declared tools. */
export interface TrainingHarnessProjection {
	system: string;
	tools: TrainingToolSchema[];
}

/**
 * Rebuild the harness projection from the exact workspace snapshot the run
 * executed against. A run without one — a `--workspace direct` diagnostic run,
 * or evidence whose run directory was pruned — has no reconstructable system
 * message, and the current checkout is never allowed to stand in for it.
 */
export function trainingHarnessProjection(runsRoot: string, run: RunRecord): TrainingHarnessProjection {
	const workspaceDir = resolveContainedArtifactPath(runsRoot, run.runId, "workspace");
	if (!existsSync(workspaceDir)) {
		throw new TrainingExportError(
			"run has no model-visible workspace snapshot, so its effective instructions cannot be reconstructed",
		);
	}
	const entry = lstatSync(workspaceDir);
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new TrainingExportError("run workspace snapshot must be a regular non-symlink directory");
	}

	const manifestText = readSnapshotText(workspaceDir, "manifest.yaml", MAX_SNAPSHOT_MANIFEST_BYTES);
	let manifestValue: unknown;
	try {
		manifestValue = parseYaml(manifestText);
	} catch (error) {
		throw new TrainingExportError("run workspace snapshot manifest is not valid YAML", { cause: error });
	}
	const manifest = SnapshotManifestSchema.safeParse(manifestValue);
	if (!manifest.success) {
		throw new TrainingExportError("run workspace snapshot manifest does not declare instructions and tools");
	}

	const system = boundedText(
		readSnapshotText(workspaceDir, manifest.data.instructions.agentsMd, MAX_SNAPSHOT_INSTRUCTIONS_BYTES),
		MAX_TRAINING_SYSTEM_CHARS,
	);

	// Two kinds of capability travel together, and neither is invented. The
	// built-ins are the fixed host policy this run recorded; their schemas are
	// host-owned, so no `parameters` is fabricated for them. The declarative
	// tools carry the exact JSON Schema the harness declared.
	const builtins: TrainingToolSchema[] = [...new Set(run.execution.tools)]
		.sort()
		.slice(0, MAX_TRAINING_TOOLS)
		.map((name) => ({
			type: "function" as const,
			function: {
				name: boundedText(name, MAX_TRAINING_NAME_CHARS),
				description:
					"Built-in Target capability declared by the harness (execution.tools). " +
					"Its schema is host-owned and the harness declares no parameters for it.",
			},
		}));

	const declared: TrainingToolSchema[] = [];
	for (const descriptorPath of manifest.data.tools) {
		const descriptorText = readSnapshotText(workspaceDir, descriptorPath, MAX_SNAPSHOT_TOOL_DESCRIPTOR_BYTES);
		let descriptorValue: unknown;
		try {
			descriptorValue = parseYaml(descriptorText);
		} catch (error) {
			throw new TrainingExportError(`declared tool descriptor is not valid YAML: ${descriptorPath}`, { cause: error });
		}
		const descriptor = SnapshotToolDescriptorSchema.safeParse(descriptorValue);
		if (!descriptor.success) {
			throw new TrainingExportError(`declared tool descriptor is unreadable: ${descriptorPath}`);
		}
		declared.push({
			type: "function",
			function: {
				name: boundedText(descriptor.data.name, MAX_TRAINING_NAME_CHARS),
				description: boundedText(descriptor.data.description, MAX_TRAINING_MESSAGE_CHARS),
				...(descriptor.data.parameters ? { parameters: descriptor.data.parameters } : {}),
			},
		});
	}
	declared.sort((left, right) => left.function.name.localeCompare(right.function.name));

	return { system, tools: [...builtins, ...declared].slice(0, MAX_TRAINING_TOOLS) };
}

// ---------- Messages ----------

/**
 * One conversation in the standard chat-tuning shape. Bounded the way a report
 * bounds a trace — per-message truncation with a marker — but nothing is ever
 * dropped: a training example missing a turn is a different conversation.
 */
export function trainingMessages(system: string, messages: readonly TraceMessage[]): TrainingMessage[] {
	const out: TrainingMessage[] = [{ role: "system", content: system }];
	for (const message of messages) {
		if (message.role === "user") {
			out.push({ role: "user", content: boundedText(message.text, MAX_TRAINING_MESSAGE_CHARS) });
			continue;
		}
		if (message.role === "assistant") {
			const text = boundedText(message.text, MAX_TRAINING_MESSAGE_CHARS);
			const calls = (message.toolCalls ?? []).map((call): TrainingToolCall => ({
				id: boundedText(call.id, MAX_TRAINING_NAME_CHARS),
				type: "function",
				function: {
					name: boundedText(call.name, MAX_TRAINING_NAME_CHARS),
					arguments: boundedText(JSON.stringify(call.arguments), MAX_TRAINING_TOOL_ARGUMENT_CHARS),
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
			name: boundedText(result?.toolName ?? "", MAX_TRAINING_NAME_CHARS),
			tool_call_id: boundedText(result?.toolCallId ?? "", MAX_TRAINING_NAME_CHARS),
			content: boundedText(result?.text ?? message.text, MAX_TRAINING_MESSAGE_CHARS),
		});
	}
	return out;
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

function defaultOutPath(runsRoot: string, now: () => Date): string {
	const stamp = now().toISOString().replace(/[:.]/g, "-");
	return join(resolve(runsRoot), "exports", `training-${stamp}.jsonl`);
}

interface SkipTally {
	counts: TrainingExportCounts;
	notes: TrainingExportNote[];
	notesTruncated: boolean;
}

function note(tally: SkipTally, entry: TrainingExportNote): void {
	if (tally.notes.length < MAX_TRAINING_EXPORT_NOTES) {
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
): { reason: TrainingSkipReason; detail: string } | null {
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

/**
 * Compile the training export. Returns the written path plus exactly how many
 * runs were scanned, exported, and skipped for each reason.
 */
export function exportTrainingData(options: ExportTrainingDataOptions): TrainingExportResult {
	const runsRoot = resolve(options.runsRoot);
	const explicit = options.evalRunId;
	if ((explicit === undefined) === (options.all !== true)) {
		throw new TrainingExportError("training export selects either one --eval <erun-id> or --all");
	}
	const minScore = options.minScore ?? DEFAULT_TRAINING_MIN_SCORE;
	if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
		throw new TrainingExportError("--min-score must be between 0 and 1");
	}
	const sealedDatasetHashes = options.sealedDatasetHashes ?? new Set<string>();
	const now = options.now ?? (() => new Date());

	// Every index is read regardless of the selection: A/A pairing is a fact
	// about two eval runs, and one of them may not be the one that was named.
	const listed = listEvalRunIndexesLenient(runsRoot);
	const aaArms = aaCalibrationEvalRunIds(listed.records);

	let selected: EvalRunRecord[];
	if (explicit !== undefined) {
		let record: EvalRunRecord;
		try {
			record = readEvalRunIndex(runsRoot, explicit);
		} catch (error) {
			throw new TrainingExportError(`eval run ${explicit} is unavailable: ${errorDetail(error)}`, { cause: error });
		}
		const refusal = indexRefusal(record, { sealedDatasetHashes, aaArms, includeAa: options.includeAa === true });
		if (refusal) throw new TrainingExportError(`eval run ${explicit} is not exportable: ${refusal.detail}`);
		selected = [record];
	} else {
		selected = listed.records;
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

	for (const index of selected) {
		const memberCount = index.runIds.length;
		tally.counts.runsScanned += memberCount;
		const refusal = indexRefusal(index, { sealedDatasetHashes, aaArms, includeAa: options.includeAa === true });
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

		let harness: TrainingHarnessProjection | undefined;
		let harnessError: unknown;
		for (const run of verified.runs) {
			if (harness) break;
			try {
				harness = trainingHarnessProjection(runsRoot, run);
			} catch (error) {
				harnessError ??= error;
			}
		}
		if (!harness) {
			tally.counts.skipped.infra += verified.runs.length;
			note(tally, {
				evalRunId: index.evalRunId,
				runId: null,
				reason: "infra",
				detail: errorDetail(harnessError ?? new Error("no member run carries a workspace snapshot")),
			});
			continue;
		}

		for (const run of verified.runs) {
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

			const line: TrainingExportLine = {
				messages: trainingMessages(harness.system, messages),
				tools: harness.tools,
				meta: {
					taskId: publicTaskId(run.taskId),
					runId: run.runId,
					evalRunId: index.evalRunId,
					targetSha: run.target.gitSha,
					workspaceHash: run.target.workspaceHash ?? null,
					model: boundedText(run.model.id, MAX_TRAINING_NAME_CHARS),
					graders: (run.evalResults.graders ?? []).slice(0, MAX_TRAINING_GRADERS).map((grader) => ({
						type: boundedText(grader.type, MAX_TRAINING_NAME_CHARS),
						passed: grader.passed,
						score: grader.score,
					})),
					score,
					passed,
					repetition: run.repetitionIndex,
				},
			};
			lines.push(JSON.stringify(line));
			tally.counts.exported += 1;
		}
	}

	const path = options.outPath ? resolve(options.outPath) : defaultOutPath(runsRoot, now);
	writeTextArtifact(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
	return {
		path,
		counts: tally.counts,
		notes: tally.notes,
		notesTruncated: tally.notesTruncated,
		// An index that will not parse was never a candidate for export, but an
		// operator counting lines deserves to know it existed.
		unreadableEvalRunIds: explicit === undefined
			? listed.invalid.map((entry) => entry.evalRunId).sort()
			: [],
	};
}

/**
 * Turn one validated CLI invocation's flags into export options.
 *
 * This lives here rather than in `cli.ts` so it can be pinned by a test. It
 * consumes the parser's own flag map — where a boolean flag is the string
 * `"true"` — instead of re-reading `process.argv`, which cannot tell
 * `--all` at the end of a line from `--all` that was never passed.
 */
export function trainingExportOptionsFromFlags(
	flags: Readonly<Record<string, string | undefined>>,
	base: { runsRoot: string; sealedDatasetHashes?: ReadonlySet<string>; now?: () => Date },
): ExportTrainingDataOptions {
	const minScore = flags["min-score"] === undefined
		? undefined
		: parsePassRateFlag(flags["min-score"]) ?? DEFAULT_TRAINING_MIN_SCORE;
	return {
		runsRoot: base.runsRoot,
		...(base.sealedDatasetHashes ? { sealedDatasetHashes: base.sealedDatasetHashes } : {}),
		...(base.now ? { now: base.now } : {}),
		...(flags.eval !== undefined ? { evalRunId: flags.eval } : {}),
		...(flags.all === "true" ? { all: true } : {}),
		...(flags.out !== undefined ? { outPath: resolve(flags.out) } : {}),
		...(minScore !== undefined ? { minScore } : {}),
		...(flags["include-failed"] === "true" ? { includeFailed: true } : {}),
		...(flags["include-aa"] === "true" ? { includeAa: true } : {}),
	};
}

/** One operator-facing summary; the counts always add up to `runsScanned`. */
export function renderTrainingExportSummary(result: TrainingExportResult): string[] {
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
	if (result.notesTruncated) lines.push(`note: further skip reasons omitted after ${MAX_TRAINING_EXPORT_NOTES}`);
	if (result.unreadableEvalRunIds.length > 0) {
		lines.push(
			`note: ${result.unreadableEvalRunIds.length} eval run index(es) could not be read and were not scanned: ` +
				result.unreadableEvalRunIds.slice(0, MAX_TRAINING_EXPORT_NOTES).join(", "),
		);
	}
	return lines;
}
