import type {
	ExecutiveVersionCard,
	VersionCardFact,
} from "../../application/executive-version-card.js";
import { bareDelta, money, percent, points, ratio } from "../../measurement.js";
import type { Paint } from "./paint.js";

const MAX_SUMMARY = 72;
const MAX_PATHS = 3;

function clip(value: string, max = MAX_SUMMARY): string {
	const flat = value.replace(/\s+/gu, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** A ratio nobody measured is said so, not printed as a number. */
function ratioOrUnknown(value: number | null): string {
	return value === null ? "unknown" : ratio(value);
}

function shortHash(value: string): string {
	const match = /^(sha256:)?([0-9a-f]{16,})$/u.exec(value);
	return match ? `${match[1] ?? ""}${match[2]!.slice(0, 12)}…` : clip(value, 24);
}

function unknown<T>(fact: VersionCardFact<T>, paint: Paint): string | null {
	return fact.status === "unknown" ? paint.warning(`unknown (${clip(fact.reason, 80)})`) : null;
}

function decisionTone(card: ExecutiveVersionCard, paint: Paint): string {
	if (card.decision.code === "improvement-proved" || card.decision.code === "no-regression-proved") {
		return paint.success(card.decision.headline);
	}
	if (card.decision.code === "sealed-failed") return paint.error(card.decision.headline);
	return paint.warning(card.decision.headline);
}

function validationLine(card: ExecutiveVersionCard, paint: Paint): string {
	if (card.validation.status === "unknown") {
		return `${paint.dim("Validation")} ${paint.warning(`unknown (${clip(card.validation.reason, 80)})`)}`;
	}
	const value = card.validation.value;
	const surface = value.context.status === "known"
		? value.context.value.surface === "blind-validation" ? "blind validation" : "development"
		: "validation surface unknown";
	return `${paint.dim("Validation")} ${paint.bold(surface)} · score ${percent(value.baseline.score, { digits: 1 })} → ${percent(value.candidate.score, { digits: 1 })} ` +
		`(${points(value.scoreDelta)}, 95% CI ${bareDelta(value.confidence95.low)} … ${bareDelta(value.confidence95.high)}) · ` +
		`pass ${percent(value.baseline.passRate, { digits: 1 })} → ${percent(value.candidate.passRate, { digits: 1 })} · ` +
		`${value.design.tasks} cases × ${value.design.repetitions}` +
		(value.design.excludedTasks > 0 ? ` · ${value.design.excludedTasks} excluded` : "");
}

function sealedLine(card: ExecutiveVersionCard, paint: Paint): string {
	if (card.sealed.status === "unknown") {
		return `${paint.dim("Sealed exam")} ${paint.warning(`unknown (${clip(card.sealed.reason, 80)})`)}`;
	}
	const value = card.sealed.value;
	const finding = value.outcome === "improved"
		? "improvement proved"
		: value.outcome === "no-regression" ? "no regression proved" : value.verdict;
	const origin = value.origin.status === "known" ? value.origin.value : "origin unknown";
	return `${paint.dim("Sealed exam")} ${paint.bold(finding)} · ${value.design.tasks} cases × ${value.design.repetitions} · ${origin}`;
}

function capabilityLines(card: ExecutiveVersionCard, paint: Paint): string[] {
	if (card.capabilities.status === "unknown") {
		return [`${paint.dim("Capabilities")} ${paint.warning(`unknown (${clip(card.capabilities.reason, 80)})`)}`];
	}
	const value = card.capabilities.value;
	if (value.rows.length === 0) return [`${paint.dim("Capabilities")} ${paint.muted("none measured")}`];
	const rows = value.rows.slice(0, 4).map((row) => {
		const name = row.subject ? `${row.check} ${row.subject}` : row.check;
		return `${clip(name, 32)} ${row.baselinePassed}/${row.tasks} → ${row.candidatePassed}/${row.tasks}`;
	});
	const hidden = Math.max(0, value.rows.length - rows.length) + value.omitted;
	return [
		`${paint.dim("Capabilities")} ${rows.join(" · ")}${hidden > 0 ? ` · ${hidden} more` : ""}`,
	];
}

function regressionLine(card: ExecutiveVersionCard, paint: Paint): string {
	if (card.regressions.status === "unknown") {
		return `${paint.dim("Regressions")} ${paint.warning(`unknown (${clip(card.regressions.reason, 80)})`)}`;
	}
	const value = card.regressions.value;
	const text = `${value.tasks} task regressions · ${value.newFailureModes} new modes · ` +
		`${value.worsenedFailureModes} worsened modes · ${value.targetedUnresolved} targeted unresolved`;
	return `${paint.dim("Regressions")} ${value.tasks + value.newFailureModes + value.worsenedFailureModes > 0 ? paint.warning(text) : paint.success(text)}`;
}

function resourceLine(card: ExecutiveVersionCard, paint: Paint): string {
	const arms = card.resources.arms;
	const ratios = card.resources.ratios;
	const parts: string[] = [];
	if (arms.status === "known") {
		parts.push(
			`${money(arms.value.baseline.costUsd)} / ${Math.round(arms.value.baseline.meanLatencyMs)} ms → ` +
			`${money(arms.value.candidate.costUsd)} / ${Math.round(arms.value.candidate.meanLatencyMs)} ms`,
		);
	} else {
		parts.push(`absolute ${unknown(arms, paint)}`);
	}
	if (ratios.status === "known") {
		parts.push(`cost ${ratioOrUnknown(ratios.value.cost)} · latency ${ratioOrUnknown(ratios.value.latency)} · tokens ${ratioOrUnknown(ratios.value.tokens)}`);
	} else {
		parts.push(`ratios ${unknown(ratios, paint)}`);
	}
	return `${paint.dim("Resources")} ${parts.join(" · ")}`;
}

function changeLines(card: ExecutiveVersionCard, paint: Paint): string[] {
	if (card.change.status === "unknown") {
		return [`${paint.dim("Change")} ${paint.warning(`unknown (${clip(card.change.reason, 80)})`)}`];
	}
	const value = card.change.value;
	const shown = value.paths.slice(0, MAX_PATHS);
	const omitted = value.paths.length - shown.length;
	return [
		`${paint.dim("Change")} ${paint.bold(clip(value.summary))} · ${value.files} files · ` +
			`${paint.added(`+${value.addedLines}`)} ${paint.removed(`-${value.removedLines}`)} · ${shortHash(value.proposalHash)}`,
		`${paint.dim("Paths")} ${shown.join(", ")}${omitted > 0 ? ` · ${omitted} more` : ""}`,
	];
}

function artifactLine(card: ExecutiveVersionCard, paint: Paint): string {
	const parts: string[] = [];
	if (card.artifacts.passport.status === "known") {
		parts.push(`${card.artifacts.passport.value.path} (${shortHash(card.artifacts.passport.value.sha256)})`);
	} else {
		parts.push(`passport ${unknown(card.artifacts.passport, paint)}`);
	}
	if (card.artifacts.dataset.status === "known") {
		const dataset = card.artifacts.dataset.value;
		parts.push(`${dataset.path} (${dataset.dialogues} dialogues, ${shortHash(dataset.sha256)})`);
	} else {
		parts.push(`dataset ${unknown(card.artifacts.dataset, paint)}`);
	}
	return `${paint.dim("Artifacts")} ${parts.join(" · ")}`;
}

/** Compact terminal rendering. The full exact diff remains in card.change. */
export function renderExecutiveVersionCard(card: ExecutiveVersionCard, paint: Paint): string[] {
	const lines = [
		paint.heading(`VERSION CARD · ${card.release.agent} ${card.release.version}`),
		decisionTone(card, paint),
		validationLine(card, paint),
		sealedLine(card, paint),
		...capabilityLines(card, paint),
		regressionLine(card, paint),
		resourceLine(card, paint),
		...changeLines(card, paint),
		artifactLine(card, paint),
	];
	if (card.warnings.length > 0) {
		lines.push(`${paint.warning("Warnings")} ${card.warnings.slice(0, 3).map((item) => clip(item, 90)).join(" · ")}`);
	}
	return lines;
}
