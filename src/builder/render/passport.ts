import {
	developmentSummaryLine,
	judgeSummaryLine,
	type VersionPassport,
} from "../../application/version-passport.js";
import { bullets, oneLine, section, shortHash, shortSha, wrap } from "./format.js";
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
export function renderVersionPassport(passport: VersionPassport, paint: Paint): string[] {
	const lines: string[] = [
		`${section(`${passport.agent} ${passport.version}`, paint)} ${paint.dim(passport.at.slice(0, 10))}`,
		`${paint.dim("Revisions")} ${shortSha(passport.baselineSha)} → ${paint.bold(shortSha(passport.candidateSha))} ${
			paint.dim("·")
		} ${paint.dim("model")} ${passport.model ? oneLine(`${passport.model.provider}/${passport.model.id}`, 50) : "—"}`,
		"",
		section("Promised", paint),
	];
	if (!passport.promised) {
		lines.push(paint.muted("No approved Spec is bound to this version."));
	} else {
		lines.push(paint.bold(oneLine(passport.promised.title, LINE_WIDTH)));
		lines.push(...wrap(passport.promised.purpose, 96, "  "));
		lines.push(paint.dim("Success criteria"));
		lines.push(...bullets(
			passport.promised.successCriteria.length > 0 ? passport.promised.successCriteria : ["none stated"],
			paint,
			{ limit: 10, max: 100 },
		));
		lines.push(paint.dim("Constraints"));
		lines.push(...bullets(
			passport.promised.constraints.length > 0 ? passport.promised.constraints : ["none stated"],
			paint,
			{ limit: 10, max: 100 },
		));
	}

	const development = passport.measured.development;
	const sealed = passport.measured.sealed;
	const resources = passport.measured.resources;
	lines.push("", section("Measured", paint));
	lines.push(`${paint.dim("Development")} ${oneLine(developmentSummaryLine(development), LINE_WIDTH - 12)}`);
	if (development) {
		lines.push(`${paint.dim("Design")} ${development.tasks} cases × ${development.repetitions} repetitions${
			development.excludedTasks > 0 ? paint.warning(` · ${development.excludedTasks} excluded`) : ""
		}`);
	}
	lines.push(`${paint.dim("Sealed exam")} ${sealed
		? `${paint.bold(sealed.verdict)} ${paint.dim(`on ${sealed.tasks} × ${sealed.repetitions} · contents stay evaluator-only`)}`
		: paint.warning("no promotion-grade sealed evidence on this record")}`);
	lines.push(`${paint.dim("Resources")} cost ${ratio(resources?.costRatio ?? null)} ${paint.dim("·")} latency ${
		ratio(resources?.latencyRatio ?? null)
	} ${paint.dim("·")} tokens ${ratio(resources?.tokenRatio ?? null)}`);

	lines.push("", section("Judge", paint));
	lines.push(passport.judge
		? `${paint.dim("Judge")} ${oneLine(judgeSummaryLine(passport.judge), LINE_WIDTH - 8)}`
		: `${paint.dim("Judge")} ${paint.warning("not calibrated")} ${paint.dim("· ahde label checks it against your own eyes")}`);

	lines.push("", section("Known limits", paint));
	if (passport.limits.unresolvedModes.length === 0) {
		lines.push(paint.dim("Unresolved"), ...bullets(["nothing this change targeted was left unresolved"], paint, { limit: 1 }));
	} else {
		lines.push(paint.warning("Still unresolved"));
		lines.push(...bullets(passport.limits.unresolvedModes, paint, { limit: 5, max: 100 }));
		if (passport.limits.unresolvedOmitted > 0) {
			lines.push(`  ${paint.dim(`… +${passport.limits.unresolvedOmitted} more`)}`);
		}
	}
	const noise = passport.limits.noise;
	lines.push(`${paint.dim("Noise")} ${noise
		? `A/A ${noise.verdict} ${paint.dim(`· 95% CI ${points(noise.confidence95.low)} … ${points(noise.confidence95.high)} · flip ${
			percent(noise.flipRate)
		} on ${noise.tasks} × ${noise.repetitions}`)}`
		: paint.muted("never measured on this revision")}`);
	lines.push(`${paint.dim("Data")} basket ${passport.limits.developmentCorpus
		? `${oneLine(passport.limits.developmentCorpus.id, 24)} ${paint.dim(`(${shortHash(passport.limits.developmentCorpus.hash)})`)}`
		: "—"} ${paint.dim("·")} exam ${passport.limits.sealedTasks} case${passport.limits.sealedTasks === 1 ? "" : "s"} ${
		paint.dim("· identity evaluator-only")
	}`);

	const provenance = passport.provenance;
	lines.push("", section("Provenance", paint));
	lines.push(`${paint.dim("Candidate")} ${oneLine(provenance.candidateId, 40)} ${paint.dim("· experiment")} ${
		oneLine(provenance.experimentId, 40)
	}`);
	lines.push(`${paint.dim("Spec")} ${oneLine(provenance.approvedSpecId ?? "—", 24)} ${paint.dim("· proposal")} ${
		oneLine(provenance.proposalRunId ?? "—", 24)
	} ${provenance.proposalSha256 ? paint.dim(`(${shortHash(provenance.proposalSha256)})`) : ""}`);
	lines.push(`${paint.dim("Applied by")} ${oneLine(provenance.appliedBy ?? "—", 40)} ${
		provenance.appliedVia
			? paint.warning(`via the ${provenance.appliedVia.replace("-", " ")} — no diff was shown one by one`)
			: paint.dim("who read the exact diff")
	}`);
	lines.push(`${paint.dim("Reviewed by")} ${oneLine(provenance.reviewedBy ?? "—", 40)} ${paint.dim("· promoted by")} ${
		oneLine(provenance.promotedBy ?? "—", 40)
	}`);
	if (provenance.reason) lines.push(...wrap(`“${provenance.reason}”`, 96, "  "));
	if (passport.warnings.length > 0) {
		lines.push("", paint.warning("Could not be read"));
		lines.push(...bullets(passport.warnings, paint, { limit: 6, max: 140 }));
	}
	return lines;
}
