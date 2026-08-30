import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadCandidateRecord } from "./candidate-review.js";
import type { CandidateRecord } from "../domain/candidate.js";
import { gateVerdictOf } from "../domain/candidate.js";

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
const MAX_REASON_CHARS = 300;
const MAX_PATHS = 12;

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
	 * recorded — the exact list, without a byte of their content. The failure
	 * modes an attempt targeted live on the Builder proposal artifact, not on
	 * the candidate record, and join this projection when the Builder view is
	 * wired to it.
	 */
	changedPaths: string[];
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

function surfaceOf(evaluation: unknown): AttemptSurface | null {
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

function attemptOf(record: CandidateRecord): Attempt {
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
		development: evaluation ? surfaceOf(evaluation.development) : null,
		sealed: evaluation?.sealedHoldout ? surfaceOf(evaluation.sealedHoldout) : null,
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
		attempts.push(attemptOf(record));
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
		return `${attempt.outcome} · ${change} · ${development}${sealed}${why}`;
	});
	if (history.omitted > 0) lines.push(`… and ${history.omitted} earlier attempt${history.omitted === 1 ? "" : "s"}`);
	return lines;
}

function points(value: number): string {
	const rounded = Math.round(value * 1000) / 10;
	return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}pp`;
}
