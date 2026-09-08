import { taskInputPreviews } from "../application/run-explanation.js";
import { publicTaskId } from "../application/improvement-brief.js";
import { compareVerifiedEvalRuns } from "../compare.js";
import type { ExclusionReason } from "../domain/comparison-gate.js";
import { loadPublicEvalRun, orderedComparisonRows } from "../evidence/model.js";

/**
 * One case of a candidate's development comparison, as the panel prints it:
 * both arms' pass counts and mean scores, the paired score delta, and whether
 * the gate excluded it. Read from the two public eval runs the candidate
 * record names, so the table and the Explorer's compare page agree cell for
 * cell. Sealed arms never appear here — they have no cases to show.
 */
export interface WorkbenchCandidateCase {
	taskId: string;
	/** The case's opening words, for a hashed id; null when no trace could be read. */
	input: string | null;
	baseline: { pass: number; total: number; score: number };
	candidate: { pass: number; total: number; score: number };
	scoreDelta: number;
	exclusion: ExclusionReason | null;
}

/** Maximum cases per read projection; later rows are readable by offset. */
export const MAX_CANDIDATE_CASES = 60;
/** Enough of a case's words to recognise it by in a row. */
const MAX_CASE_INPUT_CHARS = 80;

function preview(input: string | undefined): string | null {
	if (input === undefined) return null;
	return input.length <= MAX_CASE_INPUT_CHARS ? input : `${input.slice(0, MAX_CASE_INPUT_CHARS - 1)}…`;
}

/**
 * The Explorer's regression-first order, bounded for a panel.
 * Null cases when either arm cannot be read: a missing table is a missing table, not
 * a candidate with no cases.
 */
export function candidateCases(
	runsRoot: string,
	development: { baseline: { evalRunId: string }; candidate: { evalRunId: string } },
	casesOffset = 0,
): { cases: WorkbenchCandidateCase[] | null; casesTotal?: number; casesOffset?: number } {
	try {
		const baseline = loadPublicEvalRun(runsRoot, development.baseline.evalRunId);
		const candidate = loadPublicEvalRun(runsRoot, development.candidate.evalRunId);
		const comparison = compareVerifiedEvalRuns(baseline, candidate, { mode: "exploratory" });
		const exclusions = new Map(comparison.excluded.map((task) => [task.taskId, task.reason]));
		const rows = orderedComparisonRows(comparison);
		const selected = rows.slice(casesOffset, casesOffset + MAX_CANDIDATE_CASES);
		const taskIds = new Set(selected.map((row) => row.taskId));
		// Select before opening traces: regressions can be anywhere in the eval's order.
		const previews = taskInputPreviews(runsRoot, baseline.runs.filter((run) => taskIds.has(run.taskId)), selected.length);
		return {
			casesTotal: rows.length,
			casesOffset,
			cases: selected.map((row) => ({
				taskId: publicTaskId(row.taskId),
				input: preview(previews.get(row.taskId)),
				baseline: { pass: row.aPass, total: row.aTotal, score: row.aScore },
				candidate: { pass: row.bPass, total: row.bTotal, score: row.bScore },
				scoreDelta: row.scoreDelta,
				exclusion: exclusions.get(row.taskId) ?? null,
			})),
		};
	} catch {
		return { cases: null };
	}
}
