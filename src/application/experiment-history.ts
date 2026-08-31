import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadCandidateRecord } from "./candidate-review.js";
import { loadBuilderProposalRunEnvelope } from "./builder-proposal.js";
import type { CandidateRecord } from "../domain/candidate.js";
import { gateVerdictOf } from "../domain/candidate.js";
import { canonicalJson } from "../provenance.js";

/**
 * What this project already tried, and how it went.
 *
 * Every proposal, its exact diff, its verdict and the human's reason are
 * already durable on disk — and nothing ever reads them back to the Builder.
 * So cycle five can re-propose the change cycle two already lost, and a search
 * that cannot remember its own failures wanders instead of compounding. This
 * module is the read side: a bounded, ordered projection of prior attempts,
 * derived from immutable candidate records and never from mutable focus.
 *
 * Bounds and boundaries, because this projection is Builder-visible:
 *   - sealed evidence contributes a verdict and a design size, never a task id,
 *     an input, an answer or a corpus identity (invariants 5 and 13);
 *   - no trace content, no hashes, no receipts — an attempt is what changed,
 *     what it scored, and how it ended;
 *   - newest first, capped, with every string clipped, so a long project cannot
 *     push the rest of the Builder's context out.
 */

/** Newest attempts a history projection will carry. */
export const MAX_HISTORY_ATTEMPTS = 20;
/** Newest attempts the compact authoring projection will carry. */
export const MAX_AUTHORING_HISTORY_ATTEMPTS = 8;
/**
 * Bytes the compact authoring projection may add to a bounded authoring
 * context. Attempts are dropped oldest-first until the canonical JSON fits, and
 * the count of dropped attempts is always reported — a silent truncation would
 * let the Builder believe it had seen everything.
 */
export const MAX_AUTHORING_HISTORY_BYTES = 8 * 1024;
const MAX_REASON_CHARS = 300;
const MAX_PATHS = 12;
/** Attested failure modes one attempt may name; a proposal is capped at 8. */
const MAX_FAILURE_MODES = 8;

export type AttemptOutcome =
	| "promoted"
	| "rejected"
	| "evaluated"
	| "applied"
	| "proposed"
	| "abandoned";

export interface AttemptSurface {
	verdict: string;
	/** Mean paired score delta, in points. Null for pre-v4 evidence. */
	scoreDelta: number | null;
	confidence95: { low: number; high: number } | null;
	tasks: number;
	repetitions: number;
}

export interface Attempt {
	candidateId: string;
	at: string;
	/** Short baseline → candidate revisions, so a reader can place the attempt. */
	baseline: string;
	candidate: string | null;
	mode: string;
	/**
	 * Harness paths the proposal replaced, from the scope validation the host
	 * recorded — the exact list, without a byte of their content.
	 */
	changedPaths: string[];
	/**
	 * The failure modes this attempt targeted, from the attested proposal basis
	 * on the Builder run the candidate was applied from. Empty when the attempt
	 * has no Builder run, or when that run can no longer be read — history is an
	 * aid, so an unreadable sibling narrows the answer instead of failing it.
	 */
	failureModeIds: string[];
	development: AttemptSurface | null;
	/** Sealed verdict and design only; never its content. */
	sealed: AttemptSurface | null;
	outcome: AttemptOutcome;
	/** The human's own words on review, promotion or rejection. */
	reason: string | null;
}

export interface ExperimentHistory {
	attempts: Attempt[];
	/** Attempts that existed but did not fit the cap. */
	omitted: number;
	/** Candidate directories that could not be read as records. */
	unreadable: number;
}

export interface ExperimentHistoryInput {
	runsRoot: string;
	/** Only this Target's attempts. Omit for every Target in the runs root. */
	targetId?: string;
	/** Only this project's attempts. */
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

/**
 * The verdict and design one evaluated surface carries, and nothing else.
 * Exported because every reader of a candidate's outcome — history here, the
 * verdict lines `ahde candidate` prints — must be bounded the same way: a
 * verdict, a delta, an interval and a design size, never a task or a corpus.
 */
export function comparisonSurfaceOf(evaluation: unknown): AttemptSurface | null {
	const matched = evaluation as { comparison?: unknown } | undefined;
	const comparison = matched?.comparison as
		| {
			verdict?: unknown;
			summary?: { scoreDelta?: unknown; confidence95?: { low: number; high: number } };
			design?: { tasks?: unknown; repetitions?: unknown };
		}
		| null
		| undefined;
	if (!comparison) return null;
	const verdict = gateVerdictOf(comparison as never);
	if (!verdict) return null;
	const summary = comparison.summary;
	const design = comparison.design;
	return {
		verdict,
		scoreDelta: typeof summary?.scoreDelta === "number" ? summary.scoreDelta : null,
		confidence95: summary?.confidence95 ?? null,
		tasks: typeof design?.tasks === "number" ? design.tasks : 0,
		repetitions: typeof design?.repetitions === "number" ? design.repetitions : 0,
	};
}

function outcomeOf(record: CandidateRecord): { outcome: AttemptOutcome; reason: string | null } {
	let reason: string | null = null;
	let outcome: AttemptOutcome = "proposed";
	for (const event of record.events) {
		switch (event.type) {
			case "built":
				outcome = "applied";
				break;
			case "evaluated":
				outcome = "evaluated";
				break;
			case "reviewed":
				reason = event.review.reason;
				break;
			case "promoted":
				outcome = "promoted";
				reason = event.decision.reason;
				break;
			case "rejected":
				outcome = "rejected";
				reason = event.decision.reason;
				break;
			default:
				break;
		}
	}
	return { outcome, reason: reason === null ? null : clip(reason, MAX_REASON_CHARS) };
}

function attemptOf(record: CandidateRecord, runsRoot: string): Attempt {
	const built = record.events.find((event) => event.type === "built");
	const evaluated = record.events.find((event) => event.type === "evaluated");
	const evaluation = evaluated?.type === "evaluated" ? evaluated.evaluation : null;
	const origin = record.origin;
	const source = origin.kind === "applied-builder" ? origin.source : null;
	const { outcome, reason } = outcomeOf(record);
	return {
		candidateId: record.candidateId,
		at: record.createdAt,
		baseline: shortSha(record.baseline.sha),
		candidate: built?.type === "built" ? shortSha(built.candidate.sha) : null,
		mode: record.mode,
		changedPaths: readChangedPaths(record).slice(0, MAX_PATHS),
		failureModeIds: readFailureModeIds(record, runsRoot),
		development: evaluation ? comparisonSurfaceOf(evaluation.development) : null,
		sealed: evaluation?.sealedHoldout ? comparisonSurfaceOf(evaluation.sealedHoldout) : null,
		outcome,
		reason: reason ?? (source ? null : originReason(record)),
	};
}

function originReason(record: CandidateRecord): string | null {
	return record.origin.kind === "manual" ? clip(record.origin.reason, MAX_REASON_CHARS) : null;
}

/**
 * The scope validation the host ran before evaluating is the authority on what
 * an attempt changed: it is the same list the file-scope rule was enforced
 * against. Nothing is guessed from another artifact.
 */
function readChangedPaths(record: CandidateRecord): string[] {
	const validated = record.events.find((event) => event.type === "validated");
	return validated?.type === "validated" ? [...validated.scope.changedFiles].sort() : [];
}

/**
 * The attested proposal basis on the Builder run this candidate was applied
 * from is the authority on what an attempt was aiming at. Read leniently: a
 * Builder run that has been pruned narrows one row of the memory, it never
 * makes the memory unreadable.
 */
function readFailureModeIds(record: CandidateRecord, runsRoot: string): string[] {
	if (record.origin.kind !== "applied-builder") return [];
	try {
		const run = loadBuilderProposalRunEnvelope(runsRoot, record.origin.builderRunId);
		const basis = run.request.proposalBasis;
		if (!basis) return [];
		return basis.failureModes.map((mode) => mode.failureModeId).sort().slice(0, MAX_FAILURE_MODES);
	} catch {
		return [];
	}
}

/**
 * Pure read. Newest attempts first, so "what did we already try for this" is
 * answered by the first few rows.
 */
export function compileExperimentHistory(input: ExperimentHistoryInput): ExperimentHistory {
	const limit = Math.max(1, Math.trunc(input.limit ?? MAX_HISTORY_ATTEMPTS));
	const attempts: Attempt[] = [];
	let unreadable = 0;
	for (const candidateId of candidateIds(input.runsRoot)) {
		let record: CandidateRecord;
		try {
			record = loadCandidateRecord(input.runsRoot, candidateId);
		} catch {
			// An unreadable sibling is counted, never fatal: history is an aid.
			unreadable += 1;
			continue;
		}
		if (input.targetId !== undefined && record.targetId !== input.targetId) continue;
		if (input.projectId !== undefined && record.projectId !== input.projectId) continue;
		attempts.push(attemptOf(record, resolve(input.runsRoot)));
	}
	attempts.sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0));
	return { attempts: attempts.slice(0, limit), omitted: Math.max(0, attempts.length - limit), unreadable };
}

/** One line per attempt, for a host panel or a bounded model-facing view. */
export function renderExperimentHistory(history: ExperimentHistory): string[] {
	if (history.attempts.length === 0) return ["No earlier attempts on this Target."];
	const lines = history.attempts.map((attempt) => {
		const change = attempt.changedPaths.length > 0 ? attempt.changedPaths.join(", ") : "—";
		const development = attempt.development
			? `${attempt.development.verdict}${attempt.development.scoreDelta === null ? "" : ` ${points(attempt.development.scoreDelta)}`}`
			: "not evaluated";
		const sealed = attempt.sealed ? ` · sealed ${attempt.sealed.verdict}` : "";
		const why = attempt.reason ? ` · “${attempt.reason}”` : "";
		const aim = attempt.failureModeIds.length > 0 ? ` · for ${attempt.failureModeIds.join(", ")}` : "";
		return `${attempt.outcome} · ${change} · ${development}${sealed}${aim}${why}`;
	});
	if (history.omitted > 0) lines.push(`… and ${history.omitted} earlier attempt${history.omitted === 1 ? "" : "s"}`);
	return lines;
}

function points(value: number): string {
	const rounded = Math.round(value * 1000) / 10;
	return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}pp`;
}

// ---------------------------------------------------------------------------
// The compact form that fits inside a bounded authoring context.

/**
 * One prior attempt in the shape the Builder reads immediately before it
 * authors: what it changed, what it was aiming at, what it scored, how it
 * ended and, when a human said it, why. Everything is a short string, so
 * folding this into the authoring context cannot cost more than its own byte
 * budget.
 */
export interface CompactAttempt {
	at: string;
	outcome: AttemptOutcome;
	changedPaths: string[];
	failureModeIds: string[];
	/** `improved +5.6pp`, `regressed -2.0pp`, or `not evaluated`. */
	development: string;
	/** The sealed verdict alone — never a task, an input or a corpus identity. */
	sealed: string | null;
	reason: string | null;
}

export interface CompactExperimentHistory {
	attempts: CompactAttempt[];
	/** Attempts that exist but did not fit the cap or the byte budget. */
	omitted: number;
}

export interface CompactExperimentHistoryOptions {
	/** Newest attempts to consider. Defaults to {@link MAX_AUTHORING_HISTORY_ATTEMPTS}. */
	limit?: number;
	/** Canonical-JSON bytes the projection may occupy. */
	maxBytes?: number;
}

function compactAttemptOf(attempt: Attempt): CompactAttempt {
	return {
		at: attempt.at,
		outcome: attempt.outcome,
		changedPaths: attempt.changedPaths,
		failureModeIds: attempt.failureModeIds,
		development: attempt.development
			? `${attempt.development.verdict}${attempt.development.scoreDelta === null ? "" : ` ${points(attempt.development.scoreDelta)}`}`
			: "not evaluated",
		sealed: attempt.sealed ? attempt.sealed.verdict : null,
		reason: attempt.reason,
	};
}

/**
 * Fold a history projection into the few newest attempts that fit a byte
 * budget. Oldest first out of the door, and every dropped attempt is counted:
 * a Builder that is shown five of nineteen attempts is told it is five of
 * nineteen.
 */
export function compactExperimentHistory(
	history: ExperimentHistory,
	options: CompactExperimentHistoryOptions = {},
): CompactExperimentHistory {
	const limit = Math.max(0, Math.trunc(options.limit ?? MAX_AUTHORING_HISTORY_ATTEMPTS));
	const maxBytes = Math.max(0, Math.trunc(options.maxBytes ?? MAX_AUTHORING_HISTORY_BYTES));
	const considered = history.attempts.slice(0, limit).map(compactAttemptOf);
	let kept = considered;
	while (kept.length > 0 && Buffer.byteLength(canonicalJson(kept), "utf8") > maxBytes) {
		kept = kept.slice(0, -1);
	}
	return {
		attempts: kept,
		omitted: history.omitted + (history.attempts.length - kept.length),
	};
}

/**
 * The identity a repeat is recognised by: the exact changed-path set plus one
 * targeted failure mode. Two attempts that replace the same files for the same
 * mode are the same experiment, whatever the diff inside those files said.
 */
export function experimentSignature(changedPaths: readonly string[], failureModeId: string): string {
	return canonicalJson({ changedPaths: [...changedPaths].sort(), failureModeId });
}

/**
 * Attempts whose development verdict was anything but `improved`, or that a
 * human rejected outright. Re-running one of these is spending the budget on a
 * question that already has an answer.
 */
export function losingExperimentSignatures(history: ExperimentHistory): Set<string> {
	const signatures = new Set<string>();
	for (const attempt of history.attempts) {
		const lost = attempt.outcome === "rejected" ||
			(attempt.development !== null && attempt.development.verdict !== "improved");
		if (!lost || attempt.changedPaths.length === 0) continue;
		for (const failureModeId of attempt.failureModeIds) {
			signatures.add(experimentSignature(attempt.changedPaths, failureModeId));
		}
	}
	return signatures;
}
