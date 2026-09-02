import {
	developmentSummaryLine,
	judgeSpendLine,
	judgeSummaryLine,
	type ShippedVersionPassport,
} from "../../application/version-passport.js";
import { plural, t, verdictLabel } from "../../i18n.js";
import { sealedOutcomeLabel } from "../../domain/comparison-gate.js";
import { bullets, oneLine, section, shortHash, shortSha, wrap } from "./format.js";
import { passportPredictionLine, predictionCalibrationLine } from "./prediction.js";
import type { Paint } from "./paint.js";

/** One-line renderings share the 110-column budget every AHDE panel uses. */
const LINE_WIDTH = 110;

function percent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function points(value: number): string {
	const rounded = Math.round(value * 1000) / 10;
	return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}pp`;
}

function ratio(value: number | null): string {
	return value === null || !Number.isFinite(value) ? "—" : `×${value.toFixed(2)}`;
}

/**
 * The passport as a terminal panel: what this version promised, what it
 * measured, how far the judge behind those numbers has been checked, and what
 * is still unknown. The sealed exam appears as a verdict and a size, never as
 * a case.
 */
export function renderVersionPassport(passport: ShippedVersionPassport, paint: Paint): string[] {
	const lines: string[] = [
		`${section(`${passport.agent} ${passport.version}`, paint)} ${paint.dim(passport.at.slice(0, 10))}`,
		`${paint.dim(t("passport.revisions"))} ${shortSha(passport.baselineSha)} → ${paint.bold(shortSha(passport.candidateSha))} ${
			paint.dim("·")
		} ${paint.dim(t("passport.model"))} ${passport.model ? oneLine(`${passport.model.provider}/${passport.model.id}`, 50) : "—"}`,
		"",
		section(t("passport.promised"), paint),
	];
	if (!passport.promised) {
		lines.push(paint.muted(t("passport.no-spec")));
	} else {
		lines.push(paint.bold(oneLine(passport.promised.title, LINE_WIDTH)));
		lines.push(...wrap(passport.promised.purpose, 96, "  "));
		lines.push(paint.dim(t("passport.success-criteria")));
		lines.push(...bullets(
			passport.promised.successCriteria.length > 0 ? passport.promised.successCriteria : [t("passport.none-stated")],
			paint,
			{ limit: 10, max: 100 },
		));
		lines.push(paint.dim(t("passport.constraints")));
		lines.push(...bullets(
			passport.promised.constraints.length > 0 ? passport.promised.constraints : [t("passport.none-stated")],
			paint,
			{ limit: 10, max: 100 },
		));
	}

	const development = passport.measured.development;
	const sealed = passport.measured.sealed;
	const resources = passport.measured.resources;
	lines.push("", section(t("passport.measured"), paint));
	lines.push(`${paint.dim(t("label.development"))} ${oneLine(developmentSummaryLine(development), LINE_WIDTH - 12)}`);
	if (development) {
		lines.push(`${paint.dim(t("calibration.design"))} ${t("passport.design", {
			tasks: plural(development.tasks, "case"),
			repetitions: plural(development.repetitions, "repetition"),
		})}${
			development.excludedTasks > 0 ? paint.warning(t("passport.excluded", { count: development.excludedTasks })) : ""
		}`);
	}
	// A shipped version's exam line says which finding the `pass` was; the page
	// is read months later, when nobody remembers the interval.
	lines.push(`${paint.dim(t("passport.sealed-exam"))} ${sealed
		? `${paint.bold(verdictLabel(sealed.verdict))}${
			sealed.outcome ? ` ${paint.dim("·")} ${paint.bold(sealedOutcomeLabel(sealed.outcome))}` : ""
		} ${paint.dim(t("passport.sealed-shape", { tasks: sealed.tasks, repetitions: sealed.repetitions }))}`
		: paint.warning(t("passport.sealed-none"))}`);
	const judgeSpend = judgeSpendLine(resources);
	lines.push(`${paint.dim(t("passport.resources"))} ${t("unit.cost-ratio")} ${ratio(resources?.costRatio ?? null)} ${paint.dim("·")} ${t("unit.latency-ratio")} ${
		ratio(resources?.latencyRatio ?? null)
	} ${paint.dim("·")} ${t("unit.token-ratio")} ${ratio(resources?.tokenRatio ?? null)}${
		judgeSpend === null ? "" : ` ${paint.dim("·")} ${judgeSpend}`
	}`);
	// What this version promised before anyone measured it.
	const predicted = passportPredictionLine(passport.measured.predicted, paint);
	if (predicted) lines.push(predicted);

	lines.push("", section(t("label.judge-instrument"), paint));
	lines.push(passport.judge
		? `${paint.dim(t("label.judge-instrument"))} ${oneLine(judgeSummaryLine(passport.judge), LINE_WIDTH - 8)}`
		: `${paint.dim(t("label.judge-instrument"))} ${paint.warning(t("judge.not-calibrated"))} ${paint.dim(t("passport.judge-uncalibrated-hint"))}`);

	lines.push("", section(t("passport.known-limits"), paint));
	if (passport.limits.unresolvedModes.length === 0) {
		lines.push(paint.dim(t("passport.unresolved")), ...bullets([t("passport.nothing-unresolved")], paint, { limit: 1 }));
	} else {
		lines.push(paint.warning(t("passport.still-unresolved")));
		lines.push(...bullets(passport.limits.unresolvedModes, paint, { limit: 5, max: 100 }));
		if (passport.limits.unresolvedOmitted > 0) {
			lines.push(`  ${paint.dim(t("dialog.more", { count: passport.limits.unresolvedOmitted }))}`);
		}
	}
	const noise = passport.limits.noise;
	lines.push(`${paint.dim(t("label.noise"))} ${noise
		? paint.dim(t("passport.noise-shape", {
			verdict: verdictLabel(noise.verdict),
			ci: t("unit.ci"),
			low: points(noise.confidence95.low),
			high: points(noise.confidence95.high),
			flipWord: t("noise.flip"),
			flip: percent(noise.flipRate),
			tasks: noise.tasks,
			repetitions: noise.repetitions,
		}))
		: paint.muted(t("passport.noise-never"))}`);
	lines.push(`${paint.dim(t("passport.data"))} ${t("passport.data-basket")} ${passport.limits.developmentCorpus
		? `${oneLine(passport.limits.developmentCorpus.id, 24)} ${paint.dim(`(${shortHash(passport.limits.developmentCorpus.hash)})`)}`
		: "—"} ${paint.dim(t("passport.data-exam"))} ${plural(passport.limits.sealedTasks, "case")}${
		// Who wrote the questions, when a receipt says so. It changes what the
		// verdict is worth, so it belongs beside the count and not in a footnote.
		passport.limits.sealedOrigin
			? ` ${paint.dim(`· ${t(passport.limits.sealedOrigin === "judge-generated-reviewed"
				? "passport.exam-generated-reviewed"
				: "passport.exam-generated")}`)}`
			: ""
	} ${paint.dim(t("passport.identity-evaluator-only"))}`);

	const provenance = passport.provenance;
	lines.push("", section(t("passport.provenance"), paint));
	lines.push(`${paint.dim(t("candidate.title"))} ${oneLine(provenance.candidateId, 40)} ${paint.dim(t("passport.experiment"))} ${
		oneLine(provenance.experimentId, 40)
	}`);
	lines.push(`${paint.dim(t("label.spec"))} ${oneLine(provenance.approvedSpecId ?? "—", 24)} ${paint.dim(`· ${t("result.proposal-word")}`)} ${
		oneLine(provenance.proposalRunId ?? "—", 24)
	} ${provenance.proposalSha256 ? paint.dim(`(${shortHash(provenance.proposalSha256)})`) : ""}`);
	lines.push(`${paint.dim(t("passport.applied-by"))} ${oneLine(provenance.appliedBy ?? "—", 40)} ${
		provenance.appliedVia
			? paint.warning(t("passport.applied-via", {
				via: t(provenance.appliedVia === "improvement-loop" ? "candidate.applied-by-loop" : "candidate.applied-by-search"),
			}))
			: paint.dim(t("passport.applied-read-diff"))
	}`);
	lines.push(`${paint.dim(t("passport.reviewed-by"))} ${oneLine(provenance.reviewedBy ?? "—", 40)} ${paint.dim(t("passport.promoted-by"))} ${
		oneLine(provenance.promotedBy ?? "—", 40)
	}`);
	lines.push(predictionCalibrationLine(provenance.predictionCalibration, paint));
	if (provenance.reason) lines.push(...wrap(`“${provenance.reason}”`, 96, "  "));
	if (passport.warnings.length > 0) {
		lines.push("", paint.warning(t("passport.unreadable")));
		lines.push(...bullets(passport.warnings, paint, { limit: 6, max: 140 }));
	}
	return lines;
}
