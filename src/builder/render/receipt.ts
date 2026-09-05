import { plural, t } from "../../i18n.js";
import { elapsed as elapsedOf, money } from "../../measurement.js";
import type { WorkbenchDecisionResult } from "../../workbench/types.js";
import type { EvalRunSpend } from "../spend.js";
import { joinNonEmpty } from "./format.js";
import type { Paint } from "./paint.js";

/**
 * The receipt line.
 *
 * Every decision that spent money or wall-clock ends with one dim line saying
 * what it actually cost: the time of day it finished, the executions it ran,
 * the money, the elapsed time, and the judge's own bill when there was one.
 *
 * Two rules make it trustworthy: nothing here is estimated — every number is
 * summed from the immutable records the measurement wrote, and a decision
 * whose records cannot be read gets no line at all rather than a guess — and
 * no sealed measurement is ever summed, so an exam contributes neither cost
 * nor duration.
 */

/** Which measurements one decision result is the receipt for. */
export interface ReceiptSubject {
	evalRunIds: string[];
	/** Candidates whose two development arms are the measurement. */
	candidateIds: string[];
	/**
	 * The measurement called no Target: its member runs carry the *recorded*
	 * Target spend of the runs they were derived from, and re-printing that as
	 * this decision's bill would charge the operator twice for one answer. Only
	 * the judge's own line survives.
	 */
	judgeOnly?: boolean;
}

export interface ReceiptFacts {
	/** When the last measurement finished, ISO. */
	at: string;
	runs: number;
	costUsd: number | null;
	judgeCostUsd: number | null;
	durationMs: number | null;
}

/** Resolve one EvalRun's recorded spend; `null` when it is unreadable or sealed. */
export type EvalRunSpendLookup = {
	ofEvalRun(evalRunId: string): EvalRunSpend | null;
	ofCandidate(candidateId: string): EvalRunSpend[];
};

function subject(evalRunIds: readonly (string | null | undefined)[], candidateIds: readonly (string | null | undefined)[] = []): ReceiptSubject {
	const unique = (values: readonly (string | null | undefined)[]): string[] =>
		[...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
	return { evalRunIds: unique(evalRunIds), candidateIds: unique(candidateIds) };
}

/**
 * What a decision measured, named by id only. Pure: it reads the result the
 * Workbench already returned and never touches the disk.
 */
export function receiptSubject(result: WorkbenchDecisionResult): ReceiptSubject | null {
	switch (result.kind) {
		case "run-eval":
			return subject([result.result.evaluation.evalRunId]);
		case "start-testing":
			return result.result.evaluation ? subject([result.result.evaluation.evaluation.evalRunId]) : null;
		case "calibrate":
			return subject([], [result.result.calibration.candidateId]);
		case "regrade":
			return { ...subject([result.result.evalRunId]), judgeOnly: true };
		case "verify-candidate":
			return verifySubject(result.result);
		case "run-current":
			if (result.result.resolvedAs === "run-eval") return subject([result.result.evaluation.evalRunId]);
			if (result.result.resolvedAs === "start-testing") {
				return result.result.evaluation ? subject([result.result.evaluation.evaluation.evalRunId]) : null;
			}
			return verifySubject(result.result);
		case "improve":
			return subject(
				result.result.cycles.map((cycle) => cycle.evalRunId),
				[result.result.candidateId],
			);
		default:
			// Everything else records a decision; it spends no model time.
			return null;
	}
}

function verifySubject(
	result: Extract<WorkbenchDecisionResult, { kind: "verify-candidate" }>["result"],
): ReceiptSubject | null {
	if (result.outcome === "stopped-by-screen") return subject([result.screen.screenEvalRunId]);
	const development = result.candidate.development;
	return subject(
		[result.screen?.screenEvalRunId, development?.baselineEvalRunId, development?.candidateEvalRunId],
		// The sealed arm is deliberately absent: its cost would describe the exam.
		[],
	);
}

/** Fold every arm of one decision into a single receipt. */
export function receiptFacts(
	spends: readonly EvalRunSpend[],
	options: { judgeOnly?: boolean } = {},
): ReceiptFacts | null {
	if (spends.length === 0) return null;
	let runs = 0;
	let costUsd: number | null = 0;
	let judgeCostUsd: number | null = 0;
	let started: string | null = null;
	let finished: string | null = null;
	for (const spend of spends) {
		runs += spend.runs;
		costUsd = costUsd === null || spend.costUsd === null ? null : costUsd + spend.costUsd;
		judgeCostUsd = judgeCostUsd === null || spend.judgeCostUsd === null ? null : judgeCostUsd + spend.judgeCostUsd;
		if (started === null || spend.startedAt < started) started = spend.startedAt;
		if (finished === null || spend.finishedAt > finished) finished = spend.finishedAt;
	}
	if (!finished) return null;
	const span = started ? Date.parse(finished) - Date.parse(started) : Number.NaN;
	return {
		at: finished,
		// A judge-only measurement ran no Target execution and bought no Target
		// tokens: the count and the money would both be the source run's.
		runs: options.judgeOnly ? 0 : runs,
		costUsd: options.judgeOnly ? null : costUsd,
		judgeCostUsd,
		durationMs: Number.isFinite(span) && span >= 0 ? span : null,
	};
}

/** `18:14` in the operator's own clock. */
export function clockOf(iso: string): string | null {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return null;
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

// The two clocks — `4м12с` and the coarse `12м` — are measured quantities
// like any other, so they are formatted where every measured quantity is.
// Re-exported here because the receipt is where every caller looks for them.
export { coarseElapsed, elapsed } from "../../measurement.js";

/** One dim line from measured facts, or nothing when there is nothing measured. */
export function renderReceiptFacts(facts: ReceiptFacts, paint: Paint): string | null {
	const parts = joinNonEmpty([
		clockOf(facts.at),
		facts.runs > 0 ? plural(facts.runs, "execution") : null,
		facts.costUsd === null ? null : money(facts.costUsd),
		facts.durationMs === null ? null : elapsedOf(facts.durationMs),
		facts.judgeCostUsd !== null && facts.judgeCostUsd > 0 ? t("receipt.judge", { cost: money(facts.judgeCostUsd) }) : null,
	]);
	return parts ? paint.dim(parts) : null;
}

/**
 * The receipt for one decision, or nothing. `lookup` is the only thing that
 * reads the disk, so the rendering itself stays pure and testable.
 */
export function renderReceipt(
	result: WorkbenchDecisionResult,
	paint: Paint,
	lookup: EvalRunSpendLookup,
): string | null {
	const wanted = receiptSubject(result);
	if (!wanted) return null;
	const spends: EvalRunSpend[] = [];
	try {
		for (const evalRunId of wanted.evalRunIds) {
			const spend = lookup.ofEvalRun(evalRunId);
			if (!spend) return null;
			spends.push(spend);
		}
		for (const candidateId of wanted.candidateIds) {
			const candidateSpends = lookup.ofCandidate(candidateId);
			if (candidateSpends.length === 0) return null;
			spends.push(...candidateSpends);
		}
	} catch {
		return null;
	}
	const facts = receiptFacts(spends, wanted.judgeOnly ? { judgeOnly: true } : {});
	return facts ? renderReceiptFacts(facts, paint) : null;
}
