import type { CandidateImpact } from "../../application/candidate-impact.js";
import { formatResourceFragment } from "../../domain/comparison-gate.js";
import { t } from "../../i18n.js";
import type { WorkbenchCandidateImpactProjection } from "../../workbench/types.js";
import { oneLine, pluralize } from "./format.js";
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

function rate(counts: { failedOccurrences: number; totalOccurrences: number }): string {
	return `${counts.failedOccurrences}/${counts.totalOccurrences} failed`;
}

function verdictText(verdict: CandidateImpact["verdict"], paint: Paint): string {
	switch (verdict) {
		case "improved": return paint.success("improved");
		case "mixed": return paint.warning("mixed");
		case "no-change": return paint.muted("no change");
		case "regressed": return paint.error("regressed");
		case "inconclusive": return paint.warning("inconclusive");
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

/** Human summary of what the candidate did to the failure modes it targeted. */
export function renderImpact(
	projection: WorkbenchCandidateImpactProjection | null,
	paint: Paint,
	options: { tools?: readonly string[] } = {},
): string[] {
	if (!projection) return [];
	if (!projection.available) {
		return [`${paint.dim("Impact")} ${paint.muted(`unavailable — ${oneLine(projection.reason, 200)}`)}`];
	}
	const impact = projection.impact;
	const resources = formatResourceFragment(impact.development.resources, { tokens: true });
	const lines: string[] = [
		`${paint.dim("Impact")} ${verdictText(impact.verdict, paint)}` +
			(resources ? ` ${paint.dim(`· ${resources}`)}` : ""),
		...toolContractLines(options.tools ?? [], paint),
	];
	if (impact.proposalBasis) {
		const modes = impact.proposalBasis.targetedFailureModes;
		lines.push(`  ${paint.dim(`Targeted ${pluralize(modes.length, "failure mode")}:`)}`);
		for (const mode of modes) {
			const glyph = OUTCOME_GLYPH[mode.outcome] ?? "·";
			const tone = mode.outcome === "resolved" || mode.outcome === "improved"
				? paint.success
				: mode.outcome === "worsened" ? paint.error : paint.warning;
			lines.push(
				`    ${tone(glyph)} ${tone(mode.outcome)} · ${mode.category} · baseline ${rate(mode.baseline)} → candidate ${rate(mode.candidate)}` +
				` · ${mode.candidateAffectedTasks}/${mode.sourceAffectedTasks} tasks still affected`,
			);
		}
	} else {
		lines.push(`  ${paint.muted("No targeted failure modes: this candidate was not authored from a diagnosis.")}`);
	}
	if (impact.newFailureModes.length > 0) {
		lines.push(`  ${paint.error(`New ${pluralize(impact.newFailureModes.length, "failure mode")}:`)}`);
		for (const mode of impact.newFailureModes) {
			lines.push(`    ✗ ${mode.category} · ${pluralize(mode.affectedTasks, "task")} · candidate ${rate(mode.candidate)}`);
		}
		if (impact.omittedNewFailureModeCount > 0) lines.push(`    ${paint.dim(`… +${impact.omittedNewFailureModeCount} more`)}`);
	}
	if (impact.worsenedFailureModes.length > 0) {
		lines.push(`  ${paint.error(`Worsened ${pluralize(impact.worsenedFailureModes.length, "failure mode")}:`)}`);
		for (const mode of impact.worsenedFailureModes) {
			lines.push(`    ↓ ${mode.category} · baseline ${rate(mode.baseline)} → candidate ${rate(mode.candidate)}`);
		}
		if (impact.omittedWorsenedFailureModeCount > 0) lines.push(`    ${paint.dim(`… +${impact.omittedWorsenedFailureModeCount} more`)}`);
	}
	if (impact.taskRegressions.length > 0) {
		lines.push(`  ${paint.error(`Task ${pluralize(impact.taskRegressions.length, "regression")}:`)}`);
		for (const regression of impact.taskRegressions.slice(0, 8)) {
			lines.push(`    ↓ ${oneLine(regression.taskId, 60)} · ${Math.round(regression.baselinePassRate * 100)}% → ${Math.round(regression.candidatePassRate * 100)}%`);
		}
		const hidden = impact.taskRegressions.length - 8 + impact.omittedTaskRegressionCount;
		if (hidden > 0) lines.push(`    ${paint.dim(`… +${hidden} more`)}`);
	}
	if (impact.inconclusiveReasons.length > 0) {
		lines.push(`  ${paint.warning("Inconclusive because:")}`);
		for (const reason of impact.inconclusiveReasons.slice(0, 6)) lines.push(`    • ${oneLine(reason, 160)}`);
	}
	return lines;
}
