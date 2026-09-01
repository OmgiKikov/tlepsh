import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadCandidateRecord } from "./candidate-review.js";
import { detectPromotionFlips } from "./regression-guards.js";
import { compileImprovementBrief, publicTaskId } from "./improvement-brief.js";
import { loadDiagnosis } from "../diagnosis.js";
import { readJsonArtifact } from "../storage/artifacts.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";
import { hashFile } from "../provenance.js";
import {
	compilePredictionCalibration,
	measurementOf,
	readCandidatePrediction,
	type PredictionCalibration,
} from "./prediction.js";
import type { ProposalPrediction } from "../builders/adapters.js";
import type { CandidateRecord } from "../domain/candidate.js";
import { isPromotionGradeGateEvidence, gateVerdictOf } from "../domain/candidate.js";
import { z } from "zod";

/**
 * The agent's growth, version by version.
 *
 * `ahde log` answers one question the operator has never been able to ask:
 * "what has this agent actually become?" Every fact is already durable —
 * promotions and rejections live in immutable Candidate records, their scores
 * in the v4 gate evidence those records carry, the tasks a promotion fixed in
 * the two development arms it was measured on. Nothing here writes, runs, or
 * decides; it is a bounded read in the discipline of
 * `application/experiment-history.ts`.
 *
 * Bounds and boundaries:
 *   - a sealed surface contributes a verdict and a design size, never a task
 *     id, an input, an answer, or a corpus identity (invariants 5 and 13);
 *   - rejections are rows too, so the chart is honest about what was tried and
 *     did not land — a growth curve drawn only from wins is a sales deck;
 *   - newest first, capped, every string clipped, every list bounded;
 *   - a sibling artifact that cannot be read narrows one row instead of
 *     failing the log: history is an aid, not evidence.
 */

/** Rows one log projection will carry. */
export const MAX_AGENT_LOG_ROWS = 20;
/** Public callers may ask for a longer page, but never an unbounded one. */
export const MAX_AGENT_LOG_LIMIT = 100;
/** Columns the terminal sparkline may occupy. */
export const MAX_SPARKLINE_WIDTH = 40;
/** Resolved failure modes named in a row; the rest are counted. */
export const MAX_RESOLVED_MODE_EXAMPLES = 3;
const MAX_REASON_CHARS = 200;
const MAX_MODE_TITLE_CHARS = 90;
const MAX_TAG_CHARS = 60;
/** Flips one row will look at; a big basket cannot make one row expensive. */
const MAX_FLIPS_CONSIDERED = 200;

/** How a version-shaped attempt ended. Only human decisions become rows. */
export type AgentLogOutcome = "promoted" | "rejected";

/** The paired statistics of one comparison surface. Display only. */
export interface AgentLogSurface {
	verdict: string;
	/** Mean grader score of each arm, in [0,1]. Null for pre-v4 evidence. */
	baselineScore: number | null;
	candidateScore: number | null;
	scoreDelta: number | null;
	confidence95: { low: number; high: number } | null;
	tasks: number;
	repetitions: number;
}

/**
 * The sealed surface as a log row may know it: the verdict the guardrail
 * decided and how big the design was. Never a task, never a corpus.
 */
export interface AgentLogSealedSurface {
	verdict: string;
	tasks: number;
	repetitions: number;
}

/** Failure modes present in the source diagnosis whose tasks flipped fail→pass. */
export interface AgentLogResolvedModes {
	count: number;
	/** Bounded mode titles; never a task id. */
	examples: string[];
	/** Resolved modes that exist but are not named above. */
	omitted: number;
	/** Tasks that flipped fail→pass between the two development arms. */
	flippedTasks: number;
}

export interface AgentLogRow {
	candidateId: string;
	outcome: AgentLogOutcome;
	/** When the human decided. */
	at: string;
	/** The promotion tag; null on a rejection. */
	tag: string | null;
	/** Short baseline → candidate revisions, so a reader can place the version. */
	baseline: string;
	candidate: string | null;
	development: AgentLogSurface | null;
	sealed: AgentLogSealedSurface | null;
	/** Candidate-over-baseline development cost ratio. Never gating. */
	costRatio: number | null;
	/** What this attempt spent across every arm it recorded, in USD. */
	costUsd: number;
	resolvedModes: AgentLogResolvedModes;
	/** The operator's own words on the promotion or the rejection. */
	reason: string | null;
	/** True when the apply receipt says the improvement loop applied it. */
	appliedByImprovementLoop: boolean;
	/** The promise the proposal behind this attempt made; null when it made none. */
	prediction: ProposalPrediction | null;
}

/** One point of the growth chart: a promoted version and what it scored. */
export interface AgentLogVersion {
	tag: string;
	at: string;
	/** Development candidate mean grader score, in [0,1]. */
	score: number;
}

export interface AgentLog {
	targetId: string | null;
	projectId: string | null;
	rows: AgentLogRow[];
	/** Decided attempts that existed but did not fit the cap. */
	omitted: number;
	/** Candidate directories that could not be read as records. */
	unreadable: number;
	/** Promotions in this projection, oldest first — the chart's x axis. */
	versions: AgentLogVersion[];
	/** Sum of every arm of every row in this projection, in USD. */
	cumulativeCostUsd: number;
	/** How often this Builder's promise survived the evidence, over these rows. */
	calibration: PredictionCalibration;
}

export interface AgentLogInput {
	runsRoot: string;
	/** Only this Target's versions. Omit for every Target in the runs root. */
	targetId?: string;
	/** Only this project's versions. */
	projectId?: string;
	limit?: number;
}

function clip(value: string, max: number): string {
	const flat = value.replace(/\s+/gu, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function shortSha(value: string): string {
	return value.slice(0, 12);
}

/** Directory names only, never following a symlink into somewhere else. */
function candidateIds(runsRoot: string): string[] {
	const root = join(resolve(runsRoot), "candidates");
	if (!existsSync(root)) return [];
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

type ComparisonEvidence = NonNullable<
	Extract<CandidateRecord["events"][number], { type: "evaluated" }>["evaluation"]["development"]["comparison"]
>;

function developmentSurfaceOf(evidence: ComparisonEvidence | null | undefined): AgentLogSurface | null {
	const verdict = gateVerdictOf(evidence);
	if (!evidence || verdict === null) return null;
	const v4 = isPromotionGradeGateEvidence(evidence) ? evidence : null;
	const design = "design" in evidence ? evidence.design : null;
	return {
		verdict,
		baselineScore: v4 ? v4.summary.baselineScore : null,
		candidateScore: v4 ? v4.summary.candidateScore : null,
		scoreDelta: v4 ? v4.summary.scoreDelta : null,
		confidence95: v4 ? { ...v4.summary.confidence95 } : null,
		tasks: design ? design.tasks : 0,
		repetitions: design ? design.repetitions : 0,
	};
}

/** The sealed row: a verdict and a size. Nothing that could name a case. */
function sealedSurfaceOf(evidence: ComparisonEvidence | null | undefined): AgentLogSealedSurface | null {
	const verdict = gateVerdictOf(evidence);
	if (!evidence || verdict === null) return null;
	const design = "design" in evidence ? evidence.design : null;
	return { verdict, tasks: design ? design.tasks : 0, repetitions: design ? design.repetitions : 0 };
}

/** What both arms of one surface spent. Zero for evidence written before v4. */
function surfaceCostUsd(evidence: ComparisonEvidence | null | undefined): number {
	if (!isPromotionGradeGateEvidence(evidence)) return 0;
	return evidence.resources.baseline.costUsd + evidence.resources.candidate.costUsd;
}

/**
 * `applied by the improvement loop`.
 *
 * The apply receipt is the authority on who applied a proposal, and the field
 * that would say so in one word does not exist yet — this lane adds no schema
 * version and does not own `builder-proposal.ts`. So the receipt is read
 * leniently: an optional `appliedBy` when a later revision adds one, and
 * otherwise the exact reason the autoloop records when it applies on its own.
 * Anything else is a human's apply, which is the honest default.
 */
const LenientApplyReceiptSchema = z.object({
	appliedBy: z.string().max(200).optional(),
	reason: z.string().max(4_000).optional(),
});

const AUTOLOOP_REASON = /^autoloop cycle \d+\b/i;

function appliedByImprovementLoop(record: CandidateRecord, runsRoot: string): boolean {
	if (record.origin.kind !== "applied-builder") return false;
	const origin = record.origin;
	let receipt: z.infer<typeof LenientApplyReceiptSchema> | null = null;
	try {
		// The record's path is provenance, not read authority. Derive the only
		// admissible location from runsRoot + builderRunId and verify its exact
		// recorded bytes before interpreting even this display-only hint.
		const receiptPath = resolveContainedArtifactPath(
			runsRoot,
			"builders",
			origin.builderRunId,
			"apply_receipt.json",
		);
		const bytes = readFileSync(receiptPath, "utf8");
		if (hashFile(bytes) !== origin.applyReceipt.sha256) return false;
		receipt = readJsonArtifact(receiptPath, LenientApplyReceiptSchema);
	} catch {
		// A pruned or unreadable receipt cannot claim the loop applied it; the
		// candidate record's own copy of the apply reason still can.
		receipt = null;
	}
	if (receipt?.appliedBy !== undefined) return receipt.appliedBy === "improvement-loop";
	const reason = receipt?.reason ?? origin.application.reason;
	return AUTOLOOP_REASON.test(reason.trim());
}

export interface AgentLogDependencies {
	detectFlips: typeof detectPromotionFlips;
	loadDiagnosis: typeof loadDiagnosis;
	compileBrief: typeof compileImprovementBrief;
}

const DEFAULT_DEPENDENCIES: AgentLogDependencies = {
	detectFlips: detectPromotionFlips,
	loadDiagnosis,
	compileBrief: compileImprovementBrief,
};

const NO_RESOLVED_MODES: AgentLogResolvedModes = { count: 0, examples: [], omitted: 0, flippedTasks: 0 };

/**
 * Which failure modes a promotion actually resolved.
 *
 * The two development arms say which tasks flipped fail→pass (the same strict
 * rule the regression guards use). The source diagnosis — the evidence the
 * proposal was authored against — says which failure modes those tasks were
 * examples of. A mode is called resolved only when every task attached to that
 * mode flipped fail→pass; one improved example must not erase the failures
 * that remain beside it.
 *
 * This is a description of a promotion, never evidence for one: per-task flips
 * do not decide a verdict (invariant 34), and a missing diagnosis, a pruned
 * eval run, or a rewritten brief narrows the row to "0 modes" rather than
 * failing the log.
 */
function resolvedModesOf(
	record: CandidateRecord,
	runsRoot: string,
	dependencies: AgentLogDependencies,
): AgentLogResolvedModes {
	if (record.origin.kind !== "applied-builder") return NO_RESOLVED_MODES;
	const source = record.origin.source;
	if (!source) return NO_RESOLVED_MODES;
	try {
		const flips = dependencies.detectFlips(runsRoot, record).slice(0, MAX_FLIPS_CONSIDERED);
		if (flips.length === 0) return NO_RESOLVED_MODES;
		// The brief speaks in public task ids; the arms speak in raw ones.
		const flipped = new Set(flips.map((flip) => publicTaskId(flip.taskId)));
		const diagnosis = dependencies.loadDiagnosis(runsRoot, source.evalRunId);
		const brief = dependencies.compileBrief(runsRoot, diagnosis);
		const resolved = brief.modes.filter(
			(mode) => mode.taskIds.length > 0 && mode.taskIds.every((taskId) => flipped.has(taskId)),
		);
		const examples = resolved
			.slice(0, MAX_RESOLVED_MODE_EXAMPLES)
			.map((mode) => clip(mode.title, MAX_MODE_TITLE_CHARS));
		return {
			count: resolved.length,
			examples,
			omitted: Math.max(0, resolved.length - examples.length),
			flippedTasks: flips.length,
		};
	} catch {
		return NO_RESOLVED_MODES;
	}
}

/** The terminal human decision on this candidate, if it has reached one. */
function decisionOf(record: CandidateRecord): {
	outcome: AgentLogOutcome;
	at: string;
	tag: string | null;
	reason: string;
} | null {
	for (const event of record.events) {
		if (event.type === "promoted") {
			return {
				outcome: "promoted",
				at: event.at,
				tag: clip(event.decision.tag, MAX_TAG_CHARS),
				reason: event.decision.reason,
			};
		}
		if (event.type === "rejected") {
			return { outcome: "rejected", at: event.at, tag: null, reason: event.decision.reason };
		}
	}
	return null;
}

function rowOf(
	record: CandidateRecord,
	runsRoot: string,
	dependencies: AgentLogDependencies,
): AgentLogRow | null {
	const decision = decisionOf(record);
	if (!decision) return null;
	const built = record.events.find((event) => event.type === "built");
	const evaluated = record.events.find((event) => event.type === "evaluated");
	const evaluation = evaluated?.type === "evaluated" ? evaluated.evaluation : null;
	const development = evaluation?.development.comparison ?? null;
	const sealed = evaluation?.sealedHoldout?.comparison ?? null;
	return {
		candidateId: record.candidateId,
		outcome: decision.outcome,
		at: decision.at,
		tag: decision.tag,
		baseline: shortSha(record.baseline.sha),
		candidate: built?.type === "built" ? shortSha(built.candidate.sha) : null,
		development: developmentSurfaceOf(development),
		sealed: sealedSurfaceOf(sealed),
		costRatio: isPromotionGradeGateEvidence(development) ? development.resources.costRatio : null,
		costUsd: surfaceCostUsd(development) + surfaceCostUsd(sealed),
		resolvedModes: decision.outcome === "promoted"
			? resolvedModesOf(record, runsRoot, dependencies)
			: NO_RESOLVED_MODES,
		reason: clip(decision.reason, MAX_REASON_CHARS),
		appliedByImprovementLoop: appliedByImprovementLoop(record, runsRoot),
		prediction: readCandidatePrediction(runsRoot, record),
	};
}

/**
 * Pure read. Newest decision first, so "what did this agent just become" is
 * answered by the first row and the whole story by the chart under it.
 */
export function compileAgentLog(
	input: AgentLogInput,
	dependenciesInput: Partial<AgentLogDependencies> = {},
): AgentLog {
	const dependencies: AgentLogDependencies = { ...DEFAULT_DEPENDENCIES, ...dependenciesInput };
	const runsRoot = resolve(input.runsRoot);
	const requestedLimit = input.limit ?? MAX_AGENT_LOG_ROWS;
	if (!Number.isFinite(requestedLimit)) throw new Error("agent log limit must be a finite number");
	const limit = Math.max(1, Math.min(MAX_AGENT_LOG_LIMIT, Math.trunc(requestedLimit)));
	const rows: AgentLogRow[] = [];
	let unreadable = 0;
	for (const candidateId of candidateIds(runsRoot)) {
		let record: CandidateRecord;
		try {
			record = loadCandidateRecord(runsRoot, candidateId);
		} catch {
			// An unreadable sibling is counted, never fatal.
			unreadable += 1;
			continue;
		}
		if (input.targetId !== undefined && record.targetId !== input.targetId) continue;
		if (input.projectId !== undefined && record.projectId !== input.projectId) continue;
		// A/A calibration measures noise; it is never a version of the agent.
		if (record.mode === "aa-calibration") continue;
		const row = rowOf(record, runsRoot, dependencies);
		if (row) rows.push(row);
	}
	rows.sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : left.candidateId < right.candidateId ? 1 : -1));
	const kept = rows.slice(0, limit);
	const versions: AgentLogVersion[] = [...kept]
		.reverse()
		.filter((row): row is AgentLogRow & { tag: string } => row.outcome === "promoted" && row.tag !== null)
		.flatMap((row) => {
			const score = row.development?.candidateScore;
			return typeof score === "number" ? [{ tag: row.tag, at: row.at, score }] : [];
		});
	return {
		targetId: input.targetId ?? null,
		projectId: input.projectId ?? null,
		rows: kept,
		omitted: Math.max(0, rows.length - kept.length),
		unreadable,
		versions,
		cumulativeCostUsd: kept.reduce((total, row) => total + row.costUsd, 0),
		// Rejections count exactly as promotions do: a track record drawn only
		// from the attempts that landed would flatter the Builder.
		calibration: compilePredictionCalibration(kept.map((row) => ({
			candidateId: row.candidateId,
			at: row.at,
			prediction: row.prediction,
			measurement: measurementOf(row.development),
		}))),
	};
}

// ---------------------------------------------------------------------------
// Rendering helpers shared by the terminal table and the HTML section.

const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * A bounded sparkline over [0,1] scores. The newest `width` points win when
 * there are more versions than columns, because the recent shape of the curve
 * is the part an operator is reading. Never wider than `width`.
 */
export function sparkline(values: readonly number[], width = MAX_SPARKLINE_WIDTH): string {
	const columns = Math.max(0, Math.min(Math.trunc(width), MAX_SPARKLINE_WIDTH));
	if (columns === 0) return "";
	const shown = values.slice(Math.max(0, values.length - columns));
	return shown
		.map((value) => {
			const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
			const index = Math.min(SPARK_LEVELS.length - 1, Math.floor(clamped * SPARK_LEVELS.length));
			return SPARK_LEVELS[index] ?? SPARK_LEVELS[0];
		})
		.join("");
}

export function formatPercent(value: number | null): string {
	return value === null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function formatScoreDelta(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "—";
	const rounded = Math.round(value * 1000) / 10;
	return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}pp`;
}

export function formatCostUsd(value: number): string {
	return `$${(Number.isFinite(value) ? Math.max(0, value) : 0).toFixed(2)}`;
}

/** `2 modes, e.g. Required tool check failed across tasks` — or `—`. */
export function formatResolvedModes(resolved: AgentLogResolvedModes): string {
	if (resolved.count === 0) return "—";
	const label = `${resolved.count} mode${resolved.count === 1 ? "" : "s"}`;
	return resolved.examples.length === 0 ? label : `${label}, e.g. ${resolved.examples.join("; ")}`;
}
