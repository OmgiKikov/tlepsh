import type { CandidateRecord } from "../domain/candidate.js";
import { formatPoints, sealedOutcome, sealedOutcomeLabel } from "../domain/comparison-gate.js";
import { comparisonSurfaceOf, type AttemptSurface } from "./experiment-history.js";

/**
 * The two verdicts a finished candidate experiment turned on, read back from
 * the record it wrote.
 *
 * The sealed guardrail decides whether a candidate may ship, and until now no
 * CLI printed it — so the one number the ship gate rests on had no evidence
 * surface at all. What may be shown is exactly what the sealed surface already
 * exposes everywhere else: the verdict, the design size, and the gate's own
 * reasons, which are written without task identifiers for this purpose. No
 * task, no input, no answer, no corpus identity.
 */

export interface CandidateSurfaceVerdict extends AttemptSurface {
	/** Gate sentences; already free of task identifiers by construction. */
	reasons: string[];
}

export interface CandidateVerdicts {
	development: CandidateSurfaceVerdict | null;
	sealed: CandidateSurfaceVerdict | null;
}

function reasonsOf(evaluation: unknown): string[] {
	const comparison = (evaluation as { comparison?: { reasons?: unknown } } | undefined)?.comparison;
	const reasons = comparison?.reasons;
	return Array.isArray(reasons) ? reasons.filter((reason): reason is string => typeof reason === "string") : [];
}

function surfaceVerdict(evaluation: unknown): CandidateSurfaceVerdict | null {
	const surface = comparisonSurfaceOf(evaluation);
	return surface === null ? null : { ...surface, reasons: reasonsOf(evaluation) };
}

/** Both surfaces of the exact evaluation this record carries. */
export function candidateVerdicts(record: CandidateRecord): CandidateVerdicts {
	const evaluated = record.events.find((event) => event.type === "evaluated");
	if (evaluated?.type !== "evaluated") return { development: null, sealed: null };
	return {
		development: surfaceVerdict(evaluated.evaluation.development),
		sealed: evaluated.evaluation.sealedHoldout
			? surfaceVerdict(evaluated.evaluation.sealedHoldout)
			: null,
	};
}

function design(surface: CandidateSurfaceVerdict): string {
	return `${surface.tasks} task${surface.tasks === 1 ? "" : "s"} × ` +
		`${surface.repetitions} repetition${surface.repetitions === 1 ? "" : "s"}`;
}

function delta(surface: CandidateSurfaceVerdict): string {
	if (surface.scoreDelta === null) return "";
	const interval = surface.confidence95
		? ` (95% CI ${formatPoints(surface.confidence95.low)} … ${formatPoints(surface.confidence95.high)})`
		: "";
	return ` ${formatPoints(surface.scoreDelta)}${interval}`;
}

/**
 * The two lines an operator needs to decide, and the only two an agent may
 * quote for the ship gate.
 */
export function renderCandidateVerdictLines(record: CandidateRecord): string[] {
	const verdicts = candidateVerdicts(record);
	const lines: string[] = [];
	lines.push(
		verdicts.development
			? `development verdict: ${verdicts.development.verdict}${delta(verdicts.development)} on ${design(verdicts.development)}`
			: "development verdict: none recorded",
	);
	if (verdicts.sealed) {
		const why = verdicts.sealed.reasons[0];
		// `pass` is two findings under one token; the line that decides a ship
		// says which one the interval actually supports.
		const outcome = sealedOutcome(verdicts.sealed);
		lines.push(
			`sealed guardrail: ${verdicts.sealed.verdict}${outcome ? ` · ${sealedOutcomeLabel(outcome)}` : ""} ` +
			`on ${design(verdicts.sealed)}${why ? ` — ${why}` : ""}`,
		);
	} else {
		lines.push("sealed guardrail: not run (promotion stays locked)");
	}
	return lines;
}
