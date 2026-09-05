import type {
	ExecutiveVersionCard,
	VersionCardFact,
} from "../../application/executive-version-card.js";
import { bareDelta, money, percent, points, ratio } from "../../measurement.js";
import type { Paint } from "./paint.js";
import { plural, t, tokenLabel } from "../../i18n.js";

const MAX_SUMMARY = 72;
const MAX_PATHS = 3;

function clip(value: string, max = MAX_SUMMARY): string {
	const flat = value.replace(/\s+/gu, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function shortHash(value: string): string {
	const match = /^(sha256:)?([0-9a-f]{16,})$/u.exec(value);
	return match ? `${match[1] ?? ""}${match[2]!.slice(0, 12)}…` : clip(value, 24);
}

function unknown<T>(fact: VersionCardFact<T>, paint: Paint): string | null {
	return fact.status === "unknown"
		? paint.warning(t("version-card.unknown", { reason: clip(fact.reason, 80) }))
		: null;
}

function decisionTone(card: ExecutiveVersionCard, paint: Paint): string {
	const headline = tokenLabel("version-card.decision", card.decision.code);
	if (card.decision.code === "improvement-proved" || card.decision.code === "no-regression-proved") {
		return paint.success(headline);
	}
	if (card.decision.code === "sealed-failed") return paint.error(headline);
	return paint.warning(headline);
}

function validationLine(card: ExecutiveVersionCard, paint: Paint): string {
	if (card.validation.status === "unknown") {
		return `${paint.dim(t("version-card.validation"))} ${paint.warning(t("version-card.unknown", { reason: clip(card.validation.reason, 80) }))}`;
	}
	const value = card.validation.value;
	const surface = value.context.status === "known"
		? tokenLabel("version-card.surface", value.context.value.surface)
		: t("version-card.surface.unknown");
	return `${paint.dim(t("version-card.validation"))} ${paint.bold(surface)} · ${t("version-card.score")} ${percent(value.baseline.score, { digits: 1 })} → ${percent(value.candidate.score, { digits: 1 })} ` +
		`(${points(value.scoreDelta)}, 95% CI ${bareDelta(value.confidence95.low)} … ${bareDelta(value.confidence95.high)}) · ` +
		`${t("version-card.pass-rate")} ${percent(value.baseline.passRate, { digits: 1 })} → ${percent(value.candidate.passRate, { digits: 1 })} · ` +
		`${plural(value.design.tasks, "case")} × ${value.design.repetitions}` +
		(value.design.excludedTasks > 0 ? ` · ${t("version-card.excluded", { count: value.design.excludedTasks })}` : "");
}

function sealedLine(card: ExecutiveVersionCard, paint: Paint): string {
	if (card.sealed.status === "unknown") {
		return `${paint.dim(t("version-card.sealed"))} ${paint.warning(t("version-card.unknown", { reason: clip(card.sealed.reason, 80) }))}`;
	}
	const value = card.sealed.value;
	const finding = value.outcome === "improved"
		? t("version-card.sealed.improved")
		: value.outcome === "no-regression" ? t("version-card.sealed.no-regression") : tokenLabel("verdict", value.verdict);
	const origin = value.origin.status === "known" ? value.origin.value : t("version-card.sealed.origin-unknown");
	return `${paint.dim(t("version-card.sealed"))} ${paint.bold(finding)} · ${plural(value.design.tasks, "case")} × ${value.design.repetitions} · ${origin}`;
}

function capabilityLines(card: ExecutiveVersionCard, paint: Paint): string[] {
	if (card.capabilities.status === "unknown") {
		return [`${paint.dim(t("version-card.capabilities"))} ${paint.warning(t("version-card.unknown", { reason: clip(card.capabilities.reason, 80) }))}`];
	}
	const value = card.capabilities.value;
	if (value.rows.length === 0) return [`${paint.dim(t("version-card.capabilities"))} ${paint.muted(t("version-card.none-measured"))}`];
	const rows = value.rows.slice(0, 4).map((row) => {
		const check = tokenLabel("version-card.check", row.check);
		const name = row.subject ? `${check} ${row.subject}` : check;
		return `${clip(name, 32)} ${row.baselinePassed}/${row.tasks} → ${row.candidatePassed}/${row.tasks}`;
	});
	const hidden = Math.max(0, value.rows.length - rows.length) + value.omitted;
	return [
		`${paint.dim(t("version-card.capabilities"))} ${rows.join(" · ")}${hidden > 0 ? ` · ${t("version-card.more", { count: hidden })}` : ""}`,
	];
}

function regressionLine(card: ExecutiveVersionCard, paint: Paint): string {
	if (card.regressions.status === "unknown") {
		return `${paint.dim(t("version-card.regressions"))} ${paint.warning(t("version-card.unknown", { reason: clip(card.regressions.reason, 80) }))}`;
	}
	const value = card.regressions.value;
	const text = t("version-card.regression-summary", {
		tasks: value.tasks,
		newModes: value.newFailureModes,
		worsened: value.worsenedFailureModes,
		unresolved: value.targetedUnresolved,
	});
	return `${paint.dim(t("version-card.regressions"))} ${value.tasks + value.newFailureModes + value.worsenedFailureModes > 0 ? paint.warning(text) : paint.success(text)}`;
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
		parts.push(`${t("version-card.absolute")} ${unknown(arms, paint)}`);
	}
	if (ratios.status === "known") {
		parts.push(`${t("version-card.cost")} ${ratio(ratios.value.cost)} · ${t("version-card.latency")} ${ratio(ratios.value.latency)} · ${t("version-card.tokens")} ${ratio(ratios.value.tokens)}`);
	} else {
		parts.push(`${t("version-card.ratios")} ${unknown(ratios, paint)}`);
	}
	return `${paint.dim(t("version-card.resources"))} ${parts.join(" · ")}`;
}

function changeLines(card: ExecutiveVersionCard, paint: Paint): string[] {
	if (card.change.status === "unknown") {
		return [`${paint.dim(t("version-card.change"))} ${paint.warning(t("version-card.unknown", { reason: clip(card.change.reason, 80) }))}`];
	}
	const value = card.change.value;
	const shown = value.paths.slice(0, MAX_PATHS);
	const omitted = value.paths.length - shown.length;
	return [
		`${paint.dim(t("version-card.change"))} ${paint.bold(clip(value.summary))} · ${plural(value.files, "file")} · ` +
			`${paint.added(`+${value.addedLines}`)} ${paint.removed(`-${value.removedLines}`)} · ${shortHash(value.proposalHash)}`,
		`${paint.dim(t("version-card.paths"))} ${shown.join(", ")}${omitted > 0 ? ` · ${t("version-card.more", { count: omitted })}` : ""}`,
	];
}

function artifactLine(card: ExecutiveVersionCard, paint: Paint): string {
	const parts: string[] = [];
	if (card.artifacts.passport.status === "known") {
		parts.push(`${card.artifacts.passport.value.path} (${shortHash(card.artifacts.passport.value.sha256)})`);
	} else {
		parts.push(`${t("version-card.passport")} ${unknown(card.artifacts.passport, paint)}`);
	}
	if (card.artifacts.dataset.status === "known") {
		const dataset = card.artifacts.dataset.value;
		parts.push(`${dataset.path} (${t("version-card.dialogues", { count: dataset.dialogues })}, ${shortHash(dataset.sha256)})`);
	} else {
		parts.push(`${t("version-card.dataset")} ${unknown(card.artifacts.dataset, paint)}`);
	}
	return `${paint.dim(t("version-card.artifacts"))} ${parts.join(" · ")}`;
}

/** Compact terminal rendering. The full exact diff remains in card.change. */
export function renderExecutiveVersionCard(card: ExecutiveVersionCard, paint: Paint): string[] {
	const lines = [
		paint.heading(t("version-card.title", { agent: card.release.agent, version: card.release.version })),
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
		lines.push(`${paint.warning(t("version-card.warnings"))} ${card.warnings.slice(0, 3).map((item) => clip(item, 90)).join(" · ")}`);
	}
	return lines;
}
