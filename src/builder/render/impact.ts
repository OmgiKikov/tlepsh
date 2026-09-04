import type { CandidateFamilyImpact, CandidateImpact } from "../../application/candidate-impact.js";
import {
	scorePredictedModes,
	scorePredictedOverall,
	type PredictionMeasurement,
} from "../../application/prediction.js";
import type { ProposalPrediction } from "../../builders/adapters.js";
import { formatResourceFragment } from "../../domain/comparison-gate.js";
import { plural, t, verdictLabel } from "../../i18n.js";
import type { WorkbenchCandidateImpactProjection } from "../../workbench/types.js";
import { oneLine, percent } from "./format.js";
import { predictedModeFragment, predictedOverallLine } from "./prediction.js";
import type { Paint } from "./paint.js";

const OUTCOME_GLYPH: Record<CandidateImpact["proposalBasis"] extends infer T
	? T extends { targetedFailureModes: readonly (infer M)[] }
		? M extends { outcome: infer O } ? O extends string ? O : never : never
		: never
	: never, string> = {
	resolved: "✓",
	improved: "↑",
	persisted: "=",
	worsened: "↓",
	"not-reproduced": "?",
};



/**
 * A family named the way the corpus names it: the check, and the tool it
 * requires where it requires one. `tool_called check_dbo`, `judge`,
 * `output_contains` — machine-readable tokens the operator can grep for, so
 * this line and the grader that produced it use the same word.
 */
function familyLabel(family: CandidateFamilyImpact): string {
	const check = GRADER_TYPE_OF_CHECK[family.signature.checkCode];
	return family.signature.subject ? `${check} ${family.signature.subject}` : check;
}

const GRADER_TYPE_OF_CHECK: Record<CandidateFamilyImpact["signature"]["checkCode"], string> = {
	"required-tool": "tool_called",
	"output-contains": "output_contains",
	"output-matches": "output_matches",
	"no-secret": "no_secret",
	"semantic-rubric": "judge",
	"reference-exact": "exact",
	"reference-similarity": "similarity",
	"turn-budget": "turn_budget",
	"world-state": "world_state",
	"final-answer": "final_answer",
	"cites-source": "cites_source",
};

function verdictText(verdict: CandidateImpact["verdict"], paint: Paint): string {
	const label = verdictLabel(verdict);
	switch (verdict) {
		case "improved": return paint.success(label);
		case "mixed": return paint.warning(label);
		case "no-change": return paint.muted(label);
		case "regressed": return paint.error(label);
		case "inconclusive": return paint.warning(label);
	}
}

/**
 * The four questions a tool change is measured by, named where the verdict is
 * read. Three of them are behaviour — does the agent call the tool, with the
 * arguments that were meant, and does it say so when the tool fails — and the
 * fourth is that the answer never contains the credential. All four are
 * development cases; "answers better" is the gate below them, not a case.
 */
function toolContractLines(tools: readonly string[], paint: Paint): string[] {
	if (tools.length === 0) return [];
	return [
		`  ${paint.dim(t("impact.tool-contract", { tools: tools.join(", ") }))}`,
		`    ${paint.dim(t("impact.tool-contract-questions"))}`,
	];
}

export interface RenderImpactOptions {
	/** Tools this change brings in, named where the verdict is read. */
	tools?: readonly string[];
	/** The promise hashed into the proposal this candidate was applied from. */
	prediction?: ProposalPrediction | null;
	/** What the gate measured, so the promise can be read against it. */
	measurement?: PredictionMeasurement | null;
}

/** Human summary of what the candidate did to the failure modes it targeted. */
export function renderImpact(
	projection: WorkbenchCandidateImpactProjection | null,
	paint: Paint,
	options: RenderImpactOptions = {},
): string[] {
	if (!projection) return [];
	if (!projection.available) {
		return [`${paint.dim(t("label.impact"))} ${paint.muted(t("impact.unavailable", { reason: oneLine(projection.reason, 200) }))}`];
	}
	const impact = projection.impact;
	const resources = formatResourceFragment(impact.development.resources, { tokens: true });
	const lines: string[] = [
		`${paint.dim(t("label.impact"))} ${verdictText(impact.verdict, paint)}` +
			(resources ? ` ${paint.dim(`· ${resources}`)}` : ""),
		...toolContractLines(options.tools ?? [], paint),
	];
	// The promise beside the result, before the per-mode detail: the one number
	// the operator can hold this change to.
	const overall = predictedOverallLine(
		scorePredictedOverall(options.prediction, options.measurement ?? null),
		paint,
	);
	if (overall) lines.push(`  ${overall}`);
	// What moved, per grader family. This is the answer to "did it work" that
	// does not need a diagnosis behind it: every candidate has two matched arms.
	if (impact.families.length > 0) {
		lines.push(`  ${paint.dim(t("impact.families"))}`);
		for (const family of impact.families) {
			const delta = family.candidatePassedTasks - family.baselinePassedTasks;
			const tone = delta > 0 ? paint.success : delta < 0 ? paint.error : paint.muted;
			lines.push(
				`    ${tone(delta > 0 ? "↑" : delta < 0 ? "↓" : "=")} ${oneLine(familyLabel(family), 60)}` +
				` ${paint.dim("·")} ${tone(t("impact.family-tasks", {
					before: family.baselinePassedTasks,
					after: family.candidatePassedTasks,
					tasks: family.tasks,
				}))}` +
				(family.regressedTaskIds.length > 0
					? ` ${paint.error(t("impact.family-regressed", { count: family.regressedTaskIds.length }))}`
					: ""),
			);
		}
		if (impact.omittedFamilyCount > 0) {
			lines.push(`    ${paint.dim(t("impact.family-omitted", { count: impact.omittedFamilyCount }))}`);
		}
	}
	if (impact.proposalBasis) {
		const modes = impact.proposalBasis.targetedFailureModes;
		const scored = new Map(
			scorePredictedModes(options.prediction, modes).map((outcome) => [outcome.failureModeId, outcome]),
		);
		lines.push(`  ${paint.dim(t("impact.targeted", { modes: plural(modes.length, "failure mode") }))}`);
		for (const mode of modes) {
			const glyph = OUTCOME_GLYPH[mode.outcome] ?? "·";
			const tone = mode.outcome === "resolved" || mode.outcome === "improved"
				? paint.success
				: mode.outcome === "worsened" ? paint.error : paint.warning;
			lines.push(
				`    ${tone(glyph)} ${tone(mode.outcome)} ${paint.dim("·")} ${mode.category} ${paint.dim("·")} ` +
				t("impact.mode-rate", {
					baselineFailed: mode.baseline.failedOccurrences,
					baselineTotal: mode.baseline.totalOccurrences,
					candidateFailed: mode.candidate.failedOccurrences,
					candidateTotal: mode.candidate.totalOccurrences,
					affected: mode.candidateAffectedTasks,
					source: mode.sourceAffectedTasks,
				}),
			);
			const outcome = scored.get(mode.failureModeId);
			// Only where a promise exists at all; an unpredicted mode says so once
			// the proposal carried a prediction, and stays silent when it did not.
			if (outcome && options.prediction) lines.push(`      ${predictedModeFragment(outcome, paint)}`);
		}
	} else {
		lines.push(`  ${paint.muted(t("impact.no-diagnosis"))}`);
	}
	if (impact.newFailureModes.length > 0) {
		lines.push(`  ${paint.error(t("impact.new-modes", { modes: plural(impact.newFailureModes.length, "failure mode") }))}`);
		for (const mode of impact.newFailureModes) {
			lines.push(`    ✗ ${t("impact.new-mode-rate", {
				category: mode.category,
				tasks: plural(mode.affectedTasks, "task"),
				failed: mode.candidate.failedOccurrences,
				total: mode.candidate.totalOccurrences,
			})}`);
		}
		if (impact.omittedNewFailureModeCount > 0) lines.push(`    ${paint.dim(t("impact.omitted", { count: impact.omittedNewFailureModeCount }))}`);
	}
	if (impact.worsenedFailureModes.length > 0) {
		lines.push(`  ${paint.error(t("impact.worsened-modes", { modes: plural(impact.worsenedFailureModes.length, "failure mode") }))}`);
		for (const mode of impact.worsenedFailureModes) {
			lines.push(`    ↓ ${t("impact.worsened-mode-rate", {
				category: mode.category,
				baselineFailed: mode.baseline.failedOccurrences,
				baselineTotal: mode.baseline.totalOccurrences,
				candidateFailed: mode.candidate.failedOccurrences,
				candidateTotal: mode.candidate.totalOccurrences,
			})}`);
		}
		if (impact.omittedWorsenedFailureModeCount > 0) lines.push(`    ${paint.dim(t("impact.omitted", { count: impact.omittedWorsenedFailureModeCount }))}`);
	}
	if (impact.taskRegressions.length > 0) {
		lines.push(`  ${paint.error(t("impact.task-regressions", { regressions: plural(impact.taskRegressions.length, "regression") }))}`);
		for (const regression of impact.taskRegressions.slice(0, 8)) {
			lines.push(`    ↓ ${oneLine(regression.taskId, 60)} · ${percent(regression.baselinePassRate)} → ${percent(regression.candidatePassRate)}`);
		}
		const hidden = impact.taskRegressions.length - 8 + impact.omittedTaskRegressionCount;
		if (hidden > 0) lines.push(`    ${paint.dim(t("impact.omitted", { count: hidden }))}`);
	}
	if (impact.inconclusiveReasons.length > 0) {
		lines.push(`  ${paint.warning(t("impact.inconclusive"))}`);
		for (const reason of impact.inconclusiveReasons.slice(0, 6)) lines.push(`    • ${oneLine(reason, 160)}`);
	}
	return lines;
}
