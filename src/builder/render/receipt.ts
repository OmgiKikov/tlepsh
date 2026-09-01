import { plural, t } from "../../i18n.js";
import { formatEvaluatorSpend } from "../../evaluator-model.js";
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
}

export interface ReceiptFacts {
	/** When the last measurement finished, ISO. */
	at: string;
	runs: number;
	costUsd: number | null;
	judgeCostUsd: number;
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
export function receiptFacts(spends: readonly EvalRunSpend[]): ReceiptFacts | null {
	if (spends.length === 0) return null;
	let runs = 0;
	let costUsd: number | null = null;
	let judgeCostUsd = 0;
	let started: string | null = null;
	let finished: string | null = null;
	for (const spend of spends) {
		runs += spend.runs;
		if (spend.costUsd !== null) costUsd = (costUsd ?? 0) + spend.costUsd;
		judgeCostUsd += spend.judgeCostUsd;
		if (started === null || spend.startedAt < started) started = spend.startedAt;
		if (finished === null || spend.finishedAt > finished) finished = spend.finishedAt;
	}
	if (!finished) return null;
	const span = started ? Date.parse(finished) - Date.parse(started) : Number.NaN;
	return {
		at: finished,
		runs,
		costUsd,
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

/** `4м12с` / `4m12s`; never rounded up to a unit that did not elapse. */
export function elapsed(milliseconds: number): string {
	const total = Math.max(0, Math.round(milliseconds / 1_000));
	const hours = Math.floor(total / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}${t("unit.hour-short")}${String(minutes).padStart(2, "0")}${t("unit.minute-short")}`;
	if (minutes > 0) return `${minutes}${t("unit.minute-short")}${String(seconds).padStart(2, "0")}${t("unit.second-short")}`;
	return `${seconds}${t("unit.second-short")}`;
}

/**
 * `12m` / `1h04m` / `47s` — the same clock without the seconds, for the two
 * places that are re-read constantly and only need the magnitude.
 */
export function coarseElapsed(milliseconds: number): string {
	const total = Math.max(0, Math.round(milliseconds / 1_000));
	const hours = Math.floor(total / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	if (hours > 0) return `${hours}${t("unit.hour-short")}${String(minutes).padStart(2, "0")}${t("unit.minute-short")}`;
	if (minutes > 0) return `${minutes}${t("unit.minute-short")}`;
	return `${total}${t("unit.second-short")}`;
}

/** One dim line from measured facts, or nothing when there is nothing measured. */
export function renderReceiptFacts(facts: ReceiptFacts, paint: Paint): string | null {
	const parts = joinNonEmpty([
		clockOf(facts.at),
		facts.runs > 0 ? plural(facts.runs, "execution") : null,
		facts.costUsd === null ? null : formatEvaluatorSpend(facts.costUsd),
		facts.durationMs === null ? null : elapsed(facts.durationMs),
		facts.judgeCostUsd > 0 ? t("receipt.judge", { cost: formatEvaluatorSpend(facts.judgeCostUsd) }) : null,
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
			if (spend) spends.push(spend);
		}
		for (const candidateId of wanted.candidateIds) spends.push(...lookup.ofCandidate(candidateId));
	} catch {
		return null;
	}
	const facts = receiptFacts(spends);
	return facts ? renderReceiptFacts(facts, paint) : null;
}
