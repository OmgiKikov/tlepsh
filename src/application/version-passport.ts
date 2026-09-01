import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadCandidateRecord } from "./candidate-review.js";
import { compileImprovementBrief, publicTaskId } from "./improvement-brief.js";
import { judgeEvidenceCalibration } from "./judge-labels.js";
import { detectPromotionFlips } from "./regression-guards.js";
import { loadDiagnosis } from "../diagnosis.js";
import type { CandidateRecord } from "../domain/candidate.js";
import { isPromotionGradeGateEvidence } from "../domain/candidate.js";
import { loadApprovedSpec } from "../spec.js";

/**
 * The version passport: what one shipped version of an agent promised, what it
 * actually measured, and what is still unknown about it.
 *
 * Everything here is already durable — the promotion lives in an immutable
 * Candidate record, its numbers in the v4 gate evidence that record carries,
 * the promise in the approved Spec it was built against, the judge's own
 * reliability in the operator's labels. This module reads them and composes
 * one page; it writes nothing, runs nothing, and decides nothing.
 *
 * Bounds and boundaries:
 *   - the sealed exam contributes a verdict and a design size and nothing
 *     else: no corpus id, no task, no input, no eval run id (invariants 5, 13);
 *   - a missing sibling artifact narrows a section and adds a warning rather
 *     than failing the passport — it is a description, never evidence;
 *   - the Spec's promise is quoted verbatim, because paraphrasing what was
 *     promised is how a passport becomes marketing.
 */

const MAX_CRITERIA = 20;
const MAX_MODE_TITLE_CHARS = 90;
const MAX_UNRESOLVED_MODES = 5;
const MAX_FLIPS_CONSIDERED = 200;
const MAX_REASON_CHARS = 300;

function clip(value: string, max: number): string {
	const flat = value.replace(/\s+/gu, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function shortSha(value: string): string {
	return value.slice(0, 12);
}

/** The paired development statistics of the promoted comparison. */
export interface VersionPassportDevelopment {
	verdict: string;
	tasks: number;
	repetitions: number;
	excludedTasks: number;
	baselinePassRate: number;
	candidatePassRate: number;
	baselineScore: number;
	candidateScore: number;
	scoreDelta: number;
	confidence95: { low: number; high: number };
}

/** The sealed exam as a passport may know it: a verdict and a design size. */
export interface VersionPassportSealed {
	verdict: string;
	tasks: number;
	repetitions: number;
}

export interface VersionPassportResources {
	costRatio: number | null;
	latencyRatio: number | null;
	tokenRatio: number | null;
}

export interface VersionPassportJudge {
	agreement: number;
	kappa: number | null;
	/** Independent labelled subjects behind the agreement. */
	subjects: number;
	checks: number;
}

/** How much this exact revision disagrees with itself, when anyone measured. */
export interface VersionPassportNoise {
	verdict: string;
	confidence95: { low: number; high: number };
	flipRate: number;
	tasks: number;
	repetitions: number;
	at: string;
}

export interface VersionPassport {
	schemaVersion: 1;
	agent: string;
	version: string;
	at: string;
	baselineSha: string;
	candidateSha: string;
	model: { provider: string; id: string } | null;
	promised: {
		title: string;
		purpose: string;
		successCriteria: string[];
		constraints: string[];
	} | null;
	measured: {
		development: VersionPassportDevelopment | null;
		sealed: VersionPassportSealed | null;
		resources: VersionPassportResources | null;
	};
	/** null means nobody has checked the judge against a human. */
	judge: VersionPassportJudge | null;
	limits: {
		/** Failure modes this change aimed at that did not fully flip. */
		unresolvedModes: string[];
		unresolvedOmitted: number;
		noise: VersionPassportNoise | null;
		/** Development basket identity, and the exam as a count only. */
		developmentCorpus: { id: string; hash: string } | null;
		sealedTasks: number;
	};
	provenance: {
		candidateId: string;
		experimentId: string;
		approvedSpecId: string | null;
		proposalRunId: string | null;
		proposalSha256: string | null;
		appliedBy: string | null;
		/** Absent for an interactive apply: a human read that exact diff. */
		appliedVia: string | null;
		reviewedBy: string | null;
		promotedBy: string | null;
		reason: string | null;
		developmentEvalRuns: { baseline: string; candidate: string } | null;
	};
	/** What could not be read; each one narrows a section above. */
	warnings: string[];
}

export interface VersionPassportInput {
	runsRoot: string;
	stateRoot: string;
	projectId: string;
	/** Promotion tag to compile. The newest promotion of this project otherwise. */
	version?: string;
	targetId?: string;
	/** The Target's current model, as the manifest records it. Display only. */
	model?: { provider: string; id: string } | null;
}

export interface VersionPassportDependencies {
	detectFlips: typeof detectPromotionFlips;
	loadDiagnosis: typeof loadDiagnosis;
	compileBrief: typeof compileImprovementBrief;
	judgeCalibration: typeof judgeEvidenceCalibration;
	loadSpec: typeof loadApprovedSpec;
}

const DEFAULT_DEPENDENCIES: VersionPassportDependencies = {
	detectFlips: detectPromotionFlips,
	loadDiagnosis,
	compileBrief: compileImprovementBrief,
	judgeCalibration: judgeEvidenceCalibration,
	loadSpec: loadApprovedSpec,
};

function candidateIds(runsRoot: string): string[] {
	const root = join(resolve(runsRoot), "candidates");
	if (!existsSync(root)) return [];
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

type PromotedEvent = Extract<CandidateRecord["events"][number], { type: "promoted" }>;

function promotionOf(record: CandidateRecord): PromotedEvent | null {
	const event = record.events.find((candidate) => candidate.type === "promoted");
	return event?.type === "promoted" ? event : null;
}

/**
 * Every promoted version of this project, newest first. A/A calibration is
 * never a version, and an unreadable record narrows the list instead of
 * failing it.
 */
function promotedRecords(
	input: VersionPassportInput,
): { records: { record: CandidateRecord; promotion: PromotedEvent }[]; unreadable: number } {
	const runsRoot = resolve(input.runsRoot);
	const records: { record: CandidateRecord; promotion: PromotedEvent }[] = [];
	let unreadable = 0;
	for (const candidateId of candidateIds(runsRoot)) {
		let record: CandidateRecord;
		try {
			record = loadCandidateRecord(runsRoot, candidateId);
		} catch {
			unreadable += 1;
			continue;
		}
		if (record.mode === "aa-calibration") continue;
		if (record.projectId !== input.projectId) continue;
		if (input.targetId !== undefined && record.targetId !== input.targetId) continue;
		const promotion = promotionOf(record);
		if (promotion) records.push({ record, promotion });
	}
	records.sort((left, right) => (left.promotion.at < right.promotion.at ? 1 : left.promotion.at > right.promotion.at ? -1 : 0));
	return { records, unreadable };
}

/** `v0.2.0` and `0.2.0` name the same version to an operator. */
function sameVersion(tag: string, requested: string): boolean {
	const normalize = (value: string): string => value.trim().replace(/^v/i, "");
	return normalize(tag) === normalize(requested);
}

/** The noise measurement for this exact revision, when one exists. */
function noiseFor(input: VersionPassportInput, targetSha: string): VersionPassportNoise | null {
	const runsRoot = resolve(input.runsRoot);
	let newest: VersionPassportNoise | null = null;
	for (const candidateId of candidateIds(runsRoot)) {
		let record: CandidateRecord;
		try {
			record = loadCandidateRecord(runsRoot, candidateId);
		} catch {
			continue;
		}
		if (record.mode !== "aa-calibration" || record.projectId !== input.projectId) continue;
		if (record.baseline.sha !== targetSha) continue;
		const evaluated = record.events.find((event) => event.type === "evaluated");
		if (evaluated?.type !== "evaluated") continue;
		const evidence = evaluated.evaluation.development.comparison;
		if (!evidence || !("verdict" in evidence) || !("design" in evidence)) continue;
		const summary = evidence.summary;
		const measured: VersionPassportNoise = {
			verdict: evidence.verdict,
			confidence95: { ...summary.confidence95 },
			flipRate: summary.taskCount > 0 ? (summary.improved + summary.regressed) / summary.taskCount : 0,
			tasks: evidence.design.tasks,
			repetitions: evidence.design.repetitions,
			at: evaluated.at,
		};
		if (!newest || measured.at > newest.at) newest = measured;
	}
	return newest;
}

/**
 * Failure modes the change aimed at that did not fully flip fail→pass. The
 * same strict rule the growth log uses to call a mode resolved, read the other
 * way round: one improved example never retires a mode.
 */
function unresolvedModes(
	record: CandidateRecord,
	runsRoot: string,
	dependencies: VersionPassportDependencies,
	warnings: string[],
): { titles: string[]; omitted: number } {
	if (record.origin.kind !== "applied-builder" || !record.origin.source) return { titles: [], omitted: 0 };
	try {
		const flips = dependencies.detectFlips(runsRoot, record).slice(0, MAX_FLIPS_CONSIDERED);
		const flipped = new Set(flips.map((flip) => publicTaskId(flip.taskId)));
		const diagnosis = dependencies.loadDiagnosis(runsRoot, record.origin.source.evalRunId);
		const brief = dependencies.compileBrief(runsRoot, diagnosis);
		const unresolved = brief.modes.filter(
			(mode) => mode.taskIds.length > 0 && !mode.taskIds.every((taskId) => flipped.has(taskId)),
		);
		const titles = unresolved
			.slice(0, MAX_UNRESOLVED_MODES)
			.map((mode) => clip(mode.title, MAX_MODE_TITLE_CHARS));
		return { titles, omitted: Math.max(0, unresolved.length - titles.length) };
	} catch {
		warnings.push("the diagnosis this change was authored against could not be read, so unresolved failure modes are unknown");
		return { titles: [], omitted: 0 };
	}
}

/**
 * One shipped version, as a page. Throws only when there is no such version to
 * describe; everything narrower is a warning on the page itself.
 */
export function compileVersionPassport(
	input: VersionPassportInput,
	dependenciesInput: Partial<VersionPassportDependencies> = {},
): VersionPassport {
	const dependencies: VersionPassportDependencies = { ...DEFAULT_DEPENDENCIES, ...dependenciesInput };
	const runsRoot = resolve(input.runsRoot);
	const warnings: string[] = [];
	const { records, unreadable } = promotedRecords(input);
	if (unreadable > 0) {
		warnings.push(`${unreadable} candidate record${unreadable === 1 ? "" : "s"} could not be read and were skipped`);
	}
	const chosen = input.version
		? records.find((entry) => sameVersion(entry.promotion.decision.tag, input.version!))
		: records[0];
	if (!chosen) {
		throw new Error(input.version
			? `no promoted version ${input.version} exists for this agent`
			: "nothing has been promoted yet, so there is no version to describe");
	}
	const { record, promotion } = chosen;
	const evaluated = record.events.find((event) => event.type === "evaluated");
	const evaluation = evaluated?.type === "evaluated" ? evaluated.evaluation : null;
	const development = evaluation?.development.comparison ?? null;
	const sealed = evaluation?.sealedHoldout?.comparison ?? null;
	const reviewed = record.events.find((event) => event.type === "reviewed");

	let promised: VersionPassport["promised"] = null;
	const approvedSpecId = record.specId ??
		(record.origin.kind === "applied-builder" ? record.origin.approvedSpec.specId : null);
	if (approvedSpecId) {
		try {
			const loaded = dependencies.loadSpec({
				stateRoot: input.stateRoot,
				projectId: input.projectId,
				specId: approvedSpecId,
			});
			promised = {
				title: loaded.snapshot.spec.title,
				purpose: loaded.snapshot.spec.purpose,
				successCriteria: loaded.snapshot.spec.successCriteria.slice(0, MAX_CRITERIA),
				constraints: loaded.snapshot.spec.constraints.slice(0, MAX_CRITERIA),
			};
		} catch {
			warnings.push("the approved Spec this version was built against could not be read, so its promise is not quoted here");
		}
	} else {
		warnings.push("this version is not bound to an approved Spec, so it promised nothing in writing");
	}

	// The judge that graded the development evidence, checked against the
	// operator's own blind labels. Sealed evidence is never labelled.
	let judge: VersionPassportJudge | null = null;
	const developmentRuns = evaluation
		? { baseline: evaluation.development.baseline.evalRunId, candidate: evaluation.development.candidate.evalRunId }
		: null;
	if (developmentRuns) {
		try {
			const calibration = dependencies.judgeCalibration({
				runsRoot,
				stateRoot: input.stateRoot,
				projectId: input.projectId,
				evalRunIds: [developmentRuns.baseline, developmentRuns.candidate],
			});
			const stats = calibration.stats;
			if (stats && stats.nChecks > 0) {
				judge = { agreement: stats.agreement, kappa: stats.kappa, subjects: stats.n, checks: stats.nChecks };
			}
		} catch {
			warnings.push("judge labels could not be read, so the judge reads as not calibrated here");
		}
	}

	const unresolved = unresolvedModes(record, runsRoot, dependencies, warnings);
	const built = record.events.find((event) => event.type === "built");
	return {
		schemaVersion: 1,
		agent: record.targetId,
		version: promotion.decision.tag,
		at: promotion.at,
		baselineSha: record.baseline.sha,
		candidateSha: built?.type === "built" ? built.candidate.sha : promotion.decision.candidate.sha,
		model: input.model ?? null,
		promised,
		measured: {
			development: isPromotionGradeGateEvidence(development)
				? {
					verdict: development.verdict,
					tasks: development.design.tasks,
					repetitions: development.design.repetitions,
					excludedTasks: development.design.excludedTasks,
					baselinePassRate: development.summary.baselinePassRate,
					candidatePassRate: development.summary.candidatePassRate,
					baselineScore: development.summary.baselineScore,
					candidateScore: development.summary.candidateScore,
					scoreDelta: development.summary.scoreDelta,
					confidence95: { ...development.summary.confidence95 },
				}
				: null,
			sealed: isPromotionGradeGateEvidence(sealed)
				? { verdict: sealed.verdict, tasks: sealed.design.tasks, repetitions: sealed.design.repetitions }
				: null,
			resources: isPromotionGradeGateEvidence(development)
				? {
					costRatio: development.resources.costRatio,
					latencyRatio: development.resources.latencyRatio,
					tokenRatio: development.resources.tokenRatio,
				}
				: null,
		},
		judge,
		limits: {
			unresolvedModes: unresolved.titles,
			unresolvedOmitted: unresolved.omitted,
			noise: noiseFor(input, record.baseline.sha),
			developmentCorpus: evaluation?.development.corpus
				? { id: evaluation.development.corpus.id, hash: evaluation.development.corpus.hash }
				: null,
			// The exam's size, and not one thing more about it.
			sealedTasks: isPromotionGradeGateEvidence(sealed) ? sealed.design.tasks : 0,
		},
		provenance: {
			candidateId: record.candidateId,
			experimentId: promotion.decision.experimentId,
			approvedSpecId,
			proposalRunId: record.origin.kind === "applied-builder" ? record.origin.builderRunId : null,
			proposalSha256: record.origin.kind === "applied-builder" ? record.origin.application.proposalSha256 : null,
			appliedBy: record.origin.kind === "applied-builder" ? record.origin.application.actor.id : null,
			appliedVia: record.origin.kind === "applied-builder" ? record.origin.application.via ?? null : null,
			reviewedBy: reviewed?.type === "reviewed" ? reviewed.actor.id : null,
			promotedBy: promotion.actor.kind === "human" ? promotion.actor.id : null,
			reason: clip(promotion.decision.reason, MAX_REASON_CHARS),
			developmentEvalRuns: developmentRuns,
		},
		warnings,
	};
}

// ---------------------------------------------------------------------------
// Markdown: the same page as a file the operator can send to someone else.

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

/** The judge line every surface shares, so the two cannot drift. */
export function judgeSummaryLine(judge: VersionPassportJudge | null): string {
	if (!judge) return "judge not calibrated — nobody has checked it against a human";
	const kappa = judge.kappa === null ? "κ n/a" : `κ ${judge.kappa.toFixed(2)}`;
	return `agreement ${Math.round(judge.agreement * 100)}% · ${kappa} · ${judge.subjects} subject${
		judge.subjects === 1 ? "" : "s"
	}, ${judge.checks} check${judge.checks === 1 ? "" : "s"}`;
}

/** The development line every surface shares. */
export function developmentSummaryLine(development: VersionPassportDevelopment | null): string {
	if (!development) return "no promotion-grade development evidence on this record";
	return `${development.verdict} · pass ${percent(development.baselinePassRate)} → ${
		percent(development.candidatePassRate)
	} · score ${percent(development.baselineScore)} → ${percent(development.candidateScore)} (${
		points(development.scoreDelta)
	}, 95% CI ${points(development.confidence95.low)} … ${points(development.confidence95.high)})`;
}

export function renderVersionPassportMarkdown(passport: VersionPassport): string {
	const lines: string[] = [];
	lines.push(`# ${passport.agent} ${passport.version}`, "");
	lines.push(`- Shipped: ${passport.at}`);
	lines.push(`- Revisions: ${shortSha(passport.baselineSha)} → ${shortSha(passport.candidateSha)}`);
	lines.push(`- Model: ${passport.model ? `${passport.model.provider}/${passport.model.id}` : "—"}`);
	lines.push("");

	lines.push("## Promised", "");
	if (!passport.promised) {
		lines.push("_No approved Spec is bound to this version._", "");
	} else {
		lines.push(`**${passport.promised.title}** — ${passport.promised.purpose}`, "");
		lines.push("Success criteria:", "");
		for (const criterion of passport.promised.successCriteria) lines.push(`- ${criterion}`);
		if (passport.promised.successCriteria.length === 0) lines.push("- _none stated_");
		lines.push("", "Constraints:", "");
		for (const constraint of passport.promised.constraints) lines.push(`- ${constraint}`);
		if (passport.promised.constraints.length === 0) lines.push("- _none stated_");
		lines.push("");
	}

	lines.push("## Measured", "");
	const development = passport.measured.development;
	lines.push(`- Development: ${developmentSummaryLine(development)}`);
	if (development) {
		lines.push(`- Design: ${development.tasks} cases × ${development.repetitions} repetitions${
			development.excludedTasks > 0 ? `, ${development.excludedTasks} excluded` : ""
		}`);
	}
	lines.push(`- Sealed exam: ${passport.measured.sealed
		? `${passport.measured.sealed.verdict} on ${passport.measured.sealed.tasks} × ${passport.measured.sealed.repetitions} (contents evaluator-only)`
		: "no promotion-grade sealed evidence on this record"}`);
	const resources = passport.measured.resources;
	lines.push(`- Resources: ${resources
		? `cost ${ratio(resources.costRatio)} · latency ${ratio(resources.latencyRatio)} · tokens ${ratio(resources.tokenRatio)}`
		: "—"}`);
	lines.push("");

	lines.push("## Judge", "");
	lines.push(`- ${judgeSummaryLine(passport.judge)}`);
	lines.push("");

	lines.push("## Known limits", "");
	if (passport.limits.unresolvedModes.length === 0) {
		lines.push("- Targeted failure modes: none left unresolved by this change, or none were targeted");
	} else {
		lines.push("- Targeted failure modes still unresolved:");
		for (const title of passport.limits.unresolvedModes) lines.push(`  - ${title}`);
		if (passport.limits.unresolvedOmitted > 0) {
			lines.push(`  - _…and ${passport.limits.unresolvedOmitted} more_`);
		}
	}
	const noise = passport.limits.noise;
	lines.push(`- Noise: ${noise
		? `A/A ${noise.verdict} · 95% CI ${points(noise.confidence95.low)} … ${points(noise.confidence95.high)} · flip rate ${
			percent(noise.flipRate)
		} on ${noise.tasks} × ${noise.repetitions}`
		: "never measured on this revision"}`);
	lines.push(`- Data: development basket ${passport.limits.developmentCorpus
		? `${passport.limits.developmentCorpus.id} (${passport.limits.developmentCorpus.hash.replace("sha256:", "").slice(0, 12)})`
		: "—"} · sealed exam ${passport.limits.sealedTasks} case${passport.limits.sealedTasks === 1 ? "" : "s"} (identity evaluator-only)`);
	lines.push("");

	lines.push("## Provenance", "");
	const provenance = passport.provenance;
	lines.push(`- Candidate: ${provenance.candidateId} · experiment ${provenance.experimentId}`);
	lines.push(`- Approved Spec: ${provenance.approvedSpecId ?? "—"}`);
	lines.push(`- Proposal: ${provenance.proposalRunId ?? "—"}${
		provenance.proposalSha256 ? ` (${provenance.proposalSha256.replace("sha256:", "").slice(0, 12)})` : ""
	}`);
	lines.push(`- Applied by: ${provenance.appliedBy ?? "—"}${
		provenance.appliedVia ? ` via the ${provenance.appliedVia.replace("-", " ")}, which showed no diff` : ", who read the exact diff"
	}`);
	lines.push(`- Reviewed by: ${provenance.reviewedBy ?? "—"} · promoted by: ${provenance.promotedBy ?? "—"}`);
	lines.push(`- Development evidence: ${provenance.developmentEvalRuns
		? `${provenance.developmentEvalRuns.baseline} vs ${provenance.developmentEvalRuns.candidate}`
		: "—"}`);
	if (provenance.reason) lines.push(`- Reason: ${provenance.reason}`);
	if (passport.warnings.length > 0) {
		lines.push("", "## What this page could not read", "");
		for (const warning of passport.warnings) lines.push(`- ${warning}`);
	}
	return `${lines.join("\n")}\n`;
}
