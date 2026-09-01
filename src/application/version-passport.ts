/**
 * The version passport: what was promised, beside what was measured.
 *
 * Every other read surface in this engine answers an operator's question mid
 * loop. This one answers the client's question after it: you said the agent
 * would do X — what does the evidence say it does? So the passport is assembled
 * from durable artifacts alone — the Candidate record, the approved Spec
 * snapshot, the EvalRun indexes, the corpus metadata, the human judge labels —
 * and never from a model, a memory, or a number somebody typed into a report.
 *
 * The sealed boundary is the same one every other surface keeps: the holdout
 * contributes a verdict and a design size, and nothing else. Its corpus id, its
 * name, its tasks and its answers never enter the projection, so they cannot
 * appear in the rendered page or in the JSON behind it — the renderer is not
 * what is keeping them out. The corpus store is opened for the development
 * corpus's name and case count, and for nothing sealed.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatJudgeAgreement, type JudgeAgreementStats } from "../domain/judge-agreement.js";
import { formatPoints } from "../domain/comparison-gate.js";
import type { CandidateRecord } from "../domain/candidate.js";
import { loadTarget } from "../manifest.js";
import { listCorpora } from "../corpus.js";
import { readEvalRunIndex } from "../eval.js";
import { formatEvaluatorSpend } from "../evaluator-model.js";
import { loadSpecSnapshot } from "../spec.js";
import { calibrationProjection } from "../workbench/calibration.js";
import { loadCandidateRecord } from "./candidate-review.js";
import { inspectCandidateImpact } from "./candidate-impact.js";
import { judgeEvidenceCalibration } from "./judge-labels.js";

/** Failure a passport cannot recover from, with the operator's next step. */
export class VersionPassportError extends Error {
	readonly name = "VersionPassportError";
	/** What the operator should do about it. Surfaced by the CLI as `next:`. */
	readonly next: string;

	constructor(message: string, next: string, options?: ErrorOptions) {
		super(message, options);
		this.next = next;
	}
}

export interface CompileVersionPassportOptions {
	/** The Target checkout, for the manifest that names the agent and its model. */
	targetDir: string;
	runsRoot: string;
	stateRoot: string;
	/** Defaults to the Target manifest id. */
	projectId?: string;
	/** Exactly one subject selector, or neither for the newest promotion. */
	candidateId?: string;
	tag?: string;
}

export interface PassportDesign {
	tasks: number;
	repetitions: number;
}

export interface PassportPromise {
	specId: string;
	title: string;
	successCriteria: string[];
	constraints: string[];
}

export interface PassportDevelopmentMeasurement {
	verdict: string;
	baselinePassRate: number;
	candidatePassRate: number;
	baselineScore: number | null;
	candidateScore: number | null;
	scoreDelta: number | null;
	confidence95: { low: number; high: number } | null;
	design: PassportDesign;
}

/** Verdict and design size. Deliberately nothing else about the exam. */
export interface PassportSealedMeasurement {
	verdict: string;
	design: PassportDesign;
}

export interface PassportResourceRatios {
	costRatio: number | null;
	latencyRatio: number | null;
	tokenRatio: number | null;
	/**
	 * What the judge endpoint cost across the two development arms this page
	 * rests on. Its own number, never inside the ratios: the judge is the
	 * instrument, and an instrument's bill is not the agent's per-answer cost.
	 * Sealed evidence contributes nothing here, as it contributes nothing else.
	 */
	judgeCostUsd: number;
}

export interface PassportJudge {
	/** Judge grader specs the development evidence rests on. 0 means none. */
	graderSpecs: number;
	stats: JudgeAgreementStats | null;
	/**
	 * Share of the human labels that fell in their more common class. An
	 * instrument that always guessed that class would score exactly this, so
	 * agreement below or near it certifies nothing.
	 */
	majorityClassBaseline: number | null;
	/** Why there is no calibration to show, when the reason is not "no judge". */
	note: string | null;
}

export interface PassportUnresolvedMode {
	failureModeId: string;
	category: string;
	outcome: string;
	baselineFailureRateBps: number;
	candidateFailureRateBps: number;
}

export interface PassportNoiseBand {
	candidateId: string;
	targetSha: string;
	design: PassportDesign;
	confidence95: { low: number; high: number };
	verdict: string;
}

export interface PassportDataset {
	development: { corpusId: string | null; name: string | null; cases: number | null };
	/** Case count only. A sealed corpus has no name and no id on this surface. */
	sealed: { cases: number | null };
}

export interface PassportProvenance {
	specId: string | null;
	proposalHash: string | null;
	gatePolicyIds: string[];
	evalRuns: {
		developmentBaseline: string;
		developmentCandidate: string;
		sealedBaseline: string | null;
		sealedCandidate: string | null;
	};
	/** Verbatim from the apply receipt the record carries. */
	appliedBy: { actorId: string; reason: string; at: string } | null;
}

export interface VersionPassport {
	schemaVersion: 1;
	agentId: string;
	projectId: string;
	candidateId: string;
	promoted: boolean;
	versionTag: string | null;
	/** Promotion instant when promoted, else the instant it was evaluated. */
	at: string;
	revisions: { baselineSha: string; candidateSha: string };
	model: { provider: string; id: string };
	promised: PassportPromise;
	measured: {
		development: PassportDevelopmentMeasurement | null;
		sealed: PassportSealedMeasurement | null;
		resources: PassportResourceRatios | null;
	};
	judge: PassportJudge;
	limits: {
		/** False for a construction change the approved Spec alone justified. */
		diagnosisBound: boolean;
		unresolved: PassportUnresolvedMode[];
		/** Why the unresolved list is empty, when it is empty for a reason. */
		unresolvedNote: string | null;
		noiseBand: PassportNoiseBand | null;
		dataset: PassportDataset;
	};
	provenance: PassportProvenance;
}

/** Candidate directories only, never following a symlink out of the runs root. */
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

/**
 * Every readable record for one project, newest first. An unreadable sibling is
 * skipped rather than fatal: a passport is about one candidate, and a broken
 * neighbour must not be the reason it cannot be issued.
 */
function projectRecords(runsRoot: string, projectId: string): CandidateRecord[] {
	const records: CandidateRecord[] = [];
	for (const candidateId of candidateIds(runsRoot)) {
		try {
			const record = loadCandidateRecord(runsRoot, candidateId);
			if (record.projectId === projectId) records.push(record);
		} catch {
			continue;
		}
	}
	return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function promotionOf(record: CandidateRecord): { tag: string; at: string } | null {
	const promoted = record.events.find((event) => event.type === "promoted");
	return promoted?.type === "promoted" ? { tag: promoted.decision.tag, at: promoted.at } : null;
}

function evaluatedEvent(record: CandidateRecord) {
	const evaluated = record.events.find((event) => event.type === "evaluated");
	return evaluated?.type === "evaluated" ? evaluated : null;
}

function builtRevision(record: CandidateRecord): string | null {
	const built = record.events.find((event) => event.type === "built");
	return built?.type === "built" ? built.candidate.sha : null;
}

function selectSubject(options: CompileVersionPassportOptions, projectId: string): CandidateRecord {
	if (options.candidateId !== undefined && options.tag !== undefined) {
		throw new VersionPassportError(
			"passport takes --candidate or --tag, not both",
			"Name the candidate id, or the promotion tag, or neither for the newest promotion.",
		);
	}
	if (options.candidateId !== undefined) {
		try {
			return loadCandidateRecord(options.runsRoot, options.candidateId);
		} catch (error) {
			throw new VersionPassportError(
				`candidate ${options.candidateId} has no readable record under ${options.runsRoot}`,
				"Run `ahde list` for the eval runs on this Target, or name a candidate id `ahde candidate` printed.",
				{ cause: error },
			);
		}
	}
	const records = projectRecords(options.runsRoot, projectId);
	if (options.tag !== undefined) {
		const tagged = records.find((record) => promotionOf(record)?.tag === options.tag);
		if (!tagged) {
			throw new VersionPassportError(
				`no promoted candidate of project ${projectId} carries the tag ${options.tag}`,
				"Run `ahde passport --target <dir>` for the newest promotion, or name a tag `ahde promote` printed.",
			);
		}
		return tagged;
	}
	const promoted = records.find((record) => promotionOf(record) !== null);
	if (!promoted) {
		throw new VersionPassportError(
			`project ${projectId} has no promoted candidate to issue a passport for`,
			"Promote one with `ahde promote --target <dir> --candidate <id> --to 0.X.0 --reason …`, " +
				"or pass --candidate <id> to issue a verified-only passport for an evaluated candidate.",
		);
	}
	return promoted;
}

/**
 * One gate's evidence, read through the same reader for either surface. The
 * development surface keeps the whole of it; the sealed surface keeps the
 * verdict and the design and the caller drops the rest on the floor.
 */
function gateMeasurement(comparison: unknown): PassportDevelopmentMeasurement | null {
	const evidence = comparison as {
		verdict?: unknown;
		summary?: Record<string, unknown>;
		design?: { tasks?: unknown; repetitions?: unknown };
	} | null | undefined;
	if (!evidence || typeof evidence.verdict !== "string" || !evidence.summary || !evidence.design) return null;
	const summary = evidence.summary;
	const number = (value: unknown): number | null => (typeof value === "number" ? value : null);
	const interval = summary.confidence95 as { low: number; high: number } | undefined;
	return {
		verdict: evidence.verdict,
		baselinePassRate: number(summary.baselinePassRate) ?? 0,
		candidatePassRate: number(summary.candidatePassRate) ?? 0,
		baselineScore: number(summary.baselineScore),
		candidateScore: number(summary.candidateScore),
		scoreDelta: number(summary.scoreDelta),
		confidence95: interval ? { low: interval.low, high: interval.high } : null,
		design: {
			tasks: typeof evidence.design.tasks === "number" ? evidence.design.tasks : 0,
			repetitions: typeof evidence.design.repetitions === "number" ? evidence.design.repetitions : 0,
		},
	};
}

function resourceRatios(comparison: unknown, judgeCostUsd: number): PassportResourceRatios | null {
	const resources = (comparison as { resources?: PassportResourceRatios } | null | undefined)?.resources;
	if (!resources) return null;
	const { costRatio, latencyRatio, tokenRatio } = resources;
	if (costRatio === null && latencyRatio === null && tokenRatio === null && judgeCostUsd === 0) return null;
	return { costRatio, latencyRatio, tokenRatio, judgeCostUsd };
}

/**
 * The judge spend recorded on these exact eval runs. An index that cannot be
 * read contributes nothing: a missing number is reported as no judge spend
 * shown, never as a guess.
 */
function judgeSpendOf(runsRoot: string, evalRunIds: readonly string[]): number {
	let total = 0;
	for (const evalRunId of evalRunIds) {
		try {
			total += readEvalRunIndex(runsRoot, evalRunId).judgeCostUsd ?? 0;
		} catch {
			// An unreadable index is already reported by every other surface.
		}
	}
	return total;
}

function policyIdOf(comparison: unknown): string | null {
	const policyId = (comparison as { policyId?: unknown } | null | undefined)?.policyId;
	return typeof policyId === "string" ? policyId : null;
}

/**
 * The share of human labels in their more common class — the score a judge that
 * never looked would get. Reported beside agreement because 90% agreement on a
 * corpus where 90% of the labels say pass is 90% agreement with a coin that
 * always says pass.
 */
function majorityClassBaseline(stats: JudgeAgreementStats): number | null {
	if (stats.n === 0) return null;
	const humanPass = stats.truePass + stats.falseFail;
	const humanFail = stats.trueFail + stats.falsePass;
	return Math.max(humanPass, humanFail) / stats.n;
}

/**
 * How far the judge behind this evidence has been checked. Evidence whose runs
 * can no longer be opened says so rather than claiming an uncalibrated judge:
 * "nobody labelled it" and "nobody can read it" are different statements.
 */
function judgeCalibration(
	options: CompileVersionPassportOptions,
	projectId: string,
	evalRunIds: readonly string[],
): PassportJudge {
	try {
		const calibration = judgeEvidenceCalibration({
			runsRoot: options.runsRoot,
			stateRoot: options.stateRoot,
			projectId,
			evalRunIds,
		});
		return {
			graderSpecs: calibration.specHashes.length,
			stats: calibration.stats,
			majorityClassBaseline: calibration.stats ? majorityClassBaseline(calibration.stats) : null,
			note: null,
		};
	} catch {
		return {
			graderSpecs: 0,
			stats: null,
			majorityClassBaseline: null,
			note: "the graded runs behind this evidence are no longer readable",
		};
	}
}

/**
 * The A/A record that measured this revision's own run-to-run noise, when one
 * exists for either side of the comparison. Newest first: the last calibration
 * is the one that describes the machine the evidence was produced on.
 */
function noiseBand(
	runsRoot: string,
	projectId: string,
	revisions: readonly string[],
): PassportNoiseBand | null {
	for (const record of projectRecords(runsRoot, projectId)) {
		if (record.mode !== "aa-calibration") continue;
		const projection = calibrationProjection(record);
		if (!projection || !revisions.includes(projection.targetSha)) continue;
		return {
			candidateId: projection.candidateId,
			targetSha: projection.targetSha,
			design: { tasks: projection.taskCount, repetitions: projection.repetitions },
			confidence95: projection.confidence95,
			verdict: projection.verdict,
		};
	}
	return null;
}

/**
 * The targeted failure modes the change did not put to rest, recomputed through
 * the read-only candidate-impact seam. Only the targeted-mode outcomes are read
 * from it; the sealed fields it also carries are not part of a passport.
 */
function unresolvedModes(
	runsRoot: string,
	record: CandidateRecord,
): { diagnosisBound: boolean; unresolved: PassportUnresolvedMode[]; note: string | null } {
	const bound = record.origin.kind === "applied-builder" && record.origin.source !== null;
	if (!bound) return { diagnosisBound: false, unresolved: [], note: null };
	let basis;
	try {
		basis = inspectCandidateImpact({ runsRoot, candidateId: record.candidateId }).proposalBasis;
	} catch {
		// A passport says what the evidence supports and no more. The exact
		// filesystem reason belongs in the operator's terminal, not on the page.
		return {
			diagnosisBound: true,
			unresolved: [],
			note: "not derivable — the candidate impact could not be recomputed from the recorded evidence",
		};
	}
	if (!basis) {
		return {
			diagnosisBound: true,
			unresolved: [],
			note: "not derivable — the proposal carries no attested failure-mode basis",
		};
	}
	const unresolved = basis.targetedFailureModes
		.filter((mode) => mode.outcome !== "resolved")
		.map((mode) => ({
			failureModeId: mode.failureModeId,
			category: mode.category,
			outcome: mode.outcome,
			baselineFailureRateBps: mode.baseline.failureRateBps,
			candidateFailureRateBps: mode.candidate.failureRateBps,
		}));
	return {
		diagnosisBound: true,
		unresolved,
		note: unresolved.length === 0 ? "every targeted failure mode the proposal named was resolved" : null,
	};
}

function developmentDataset(
	options: CompileVersionPassportOptions,
	projectId: string,
	corpus: { id: string; hash: string } | null,
	evalRunId: string,
): PassportDataset["development"] {
	let cases: number | null = null;
	try {
		cases = readEvalRunIndex(options.runsRoot, evalRunId).taskIds?.length ?? null;
	} catch {
		cases = null;
	}
	if (!corpus) return { corpusId: null, name: null, cases };
	let name: string | null = null;
	try {
		const metadata = listCorpora({ stateRoot: options.stateRoot, projectId })
			.find((entry) => entry.id === corpus.id && entry.visibility === "development");
		if (metadata) {
			name = metadata.name;
			cases = metadata.taskCount;
		}
	} catch {
		// A corpus store that cannot be listed narrows the line, never fails it.
	}
	return { corpusId: corpus.id, name, cases };
}

function measuredModel(runsRoot: string, evalRunId: string): { provider: string; id: string } | null {
	try {
		const index = readEvalRunIndex(runsRoot, evalRunId);
		return { provider: index.provenance.provider, id: index.provenance.modelId };
	} catch {
		return null;
	}
}

function approvedPromise(options: CompileVersionPassportOptions, record: CandidateRecord): PassportPromise {
	if (record.specId === null) {
		throw new VersionPassportError(
			`candidate ${record.candidateId} carries no approved Spec; a passport cannot say what was promised`,
			"Open `ahde` in the Target, approve the Spec there, and re-run the candidate against it.",
		);
	}
	try {
		const snapshot = loadSpecSnapshot(options.stateRoot, record.projectId, record.specId);
		return {
			specId: snapshot.id,
			title: snapshot.spec.title,
			successCriteria: [...snapshot.spec.successCriteria],
			constraints: [...snapshot.spec.constraints],
		};
	} catch (error) {
		throw new VersionPassportError(
			`approved Spec ${record.specId} of project ${record.projectId} cannot be read from ${options.stateRoot}`,
			"Point --target at the checkout whose .ahde holds this project's specs, or set AHDE_STATE_DIR to it.",
			{ cause: error },
		);
	}
}

/** Read one candidate's promise-against-measurement, from artifacts alone. */
export function compileVersionPassport(options: CompileVersionPassportOptions): VersionPassport {
	const target = loadTarget(options.targetDir);
	const projectId = options.projectId ?? target.manifest.id;
	const record = selectSubject(options, projectId);
	const evaluated = evaluatedEvent(record);
	const candidateSha = builtRevision(record);
	if (!evaluated || !candidateSha) {
		throw new VersionPassportError(
			`candidate ${record.candidateId} was never evaluated; there is nothing measured to put beside the promise`,
			"Verify it first with `ahde candidate --target <dir> --builder-run <id>`.",
		);
	}
	// The promise is read first: a page that cannot say what was promised is not
	// a passport, whatever else it could have measured.
	const promised = approvedPromise(options, record);
	const promotion = promotionOf(record);
	const development = evaluated.evaluation.development;
	const sealed = evaluated.evaluation.sealedHoldout ?? null;
	const sealedComparison = gateMeasurement(sealed?.comparison);

	const judge = judgeCalibration(options, projectId, [
		// The development lineage only. Sealed evidence is never labelled and its
		// runs are never opened to find out what graded them.
		development.baseline.evalRunId,
		development.candidate.evalRunId,
	]);

	const limits = unresolvedModes(options.runsRoot, record);
	const model = measuredModel(options.runsRoot, development.candidate.evalRunId) ??
		{ provider: target.manifest.model.provider, id: target.manifest.model.id };

	return {
		schemaVersion: 1,
		agentId: target.manifest.id,
		projectId,
		candidateId: record.candidateId,
		promoted: promotion !== null,
		versionTag: promotion?.tag ?? null,
		at: promotion?.at ?? evaluated.at,
		revisions: { baselineSha: record.baseline.sha, candidateSha },
		model,
		promised,
		measured: {
			development: gateMeasurement(development.comparison),
			sealed: sealedComparison
				? { verdict: sealedComparison.verdict, design: sealedComparison.design }
				: null,
			resources: resourceRatios(
				development.comparison,
				judgeSpendOf(options.runsRoot, [
					development.baseline.evalRunId,
					development.candidate.evalRunId,
				]),
			),
		},
		judge,
		limits: {
			diagnosisBound: limits.diagnosisBound,
			unresolved: limits.unresolved,
			unresolvedNote: limits.note,
			noiseBand: noiseBand(options.runsRoot, projectId, [record.baseline.sha, candidateSha]),
			dataset: {
				development: developmentDataset(
					options,
					projectId,
					development.corpus ?? null,
					development.candidate.evalRunId,
				),
				// Design size is the whole of what a sealed exam may say about itself.
				sealed: { cases: sealedComparison?.design.tasks ?? null },
			},
		},
		provenance: {
			specId: record.specId,
			proposalHash: record.origin.kind === "applied-builder" ? record.origin.proposal.sha256 : null,
			gatePolicyIds: [policyIdOf(development.comparison), policyIdOf(sealed?.comparison)]
				.filter((policyId): policyId is string => policyId !== null),
			evalRuns: {
				developmentBaseline: development.baseline.evalRunId,
				developmentCandidate: development.candidate.evalRunId,
				sealedBaseline: sealed?.baseline.evalRunId ?? null,
				sealedCandidate: sealed?.candidate.evalRunId ?? null,
			},
			appliedBy: record.origin.kind === "applied-builder"
				? {
					actorId: record.origin.application.actor.id,
					reason: record.origin.application.reason,
					at: record.origin.application.appliedAt,
				}
				: null,
		},
	};
}

// ---------------------------------------------------------------------------
// Rendering. Hashes are cut to twelve hex characters here and nowhere else, so
// the JSON projection stays exact and the page stays readable.

const HASH_HEX = 12;
const SHA_HEX = 10;

/** `sha256:dddda4e91f3a…`, `spec-bc824da34f2e…`, `f0ae64c0f9`. */
function shortHash(value: string): string {
	const match = /^([A-Za-z][A-Za-z0-9-]*[:-])?([0-9a-f]{16,})$/.exec(value);
	if (!match) return value;
	return `${match[1] ?? ""}${match[2]!.slice(0, HASH_HEX)}…`;
}

function percent(rate: number): string {
	const rounded = Math.round(rate * 1_000) / 10;
	return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function score(value: number | null): string {
	return value === null ? "n/a" : value.toFixed(2);
}

function ratio(value: number | null): string | null {
	return value === null ? null : `×${value.toFixed(2)}`;
}

function design(value: PassportDesign): string {
	return `${value.tasks} task${value.tasks === 1 ? "" : "s"} × ` +
		`${value.repetitions} repetition${value.repetitions === 1 ? "" : "s"}`;
}

function bullets(items: readonly string[], empty: string): string[] {
	return items.length === 0 ? [`- ${empty}`] : items.map((item) => `- ${item}`);
}

function developmentLine(measurement: PassportDevelopmentMeasurement): string {
	const interval = measurement.confidence95
		? `, 95% CI ${formatPoints(measurement.confidence95.low)} … ${formatPoints(measurement.confidence95.high)}`
		: "";
	const delta = measurement.scoreDelta === null ? "" : ` (${formatPoints(measurement.scoreDelta)}${interval})`;
	return `- development: **${measurement.verdict}** — pass rate ` +
		`${percent(measurement.baselinePassRate)} → ${percent(measurement.candidatePassRate)} · ` +
		`mean score ${score(measurement.baselineScore)} → ${score(measurement.candidateScore)}${delta} ` +
		`on ${design(measurement.design)}`;
}

function judgeLines(judge: PassportJudge): string[] {
	if (judge.note !== null) return [`judge not calibrated — ${judge.note}`];
	if (judge.graderSpecs === 0) {
		return ["judge not calibrated — no judge grader graded this evidence"];
	}
	if (!judge.stats) {
		return ["judge not calibrated — this judge has no human labels; run `ahde label <evalRunId> --target <dir>`"];
	}
	const baseline = judge.majorityClassBaseline;
	const beside = baseline === null ? "" : ` · majority-class baseline ${percent(baseline)}`;
	return [
		`judge agreement ${formatJudgeAgreement(judge.stats)}${beside}`,
		"",
		baseline === null
			? "Agreement is the share of checks where the judge and the human said the same thing."
			: `An instrument that always answered with the more common human label would score ${percent(baseline)}; ` +
				"only the distance above that line is agreement the judge earned.",
	];
}

function limitLines(limits: VersionPassport["limits"]): string[] {
	const lines: string[] = [];
	if (!limits.diagnosisBound) {
		lines.push("- not diagnosis-bound (construction)");
	} else if (limits.unresolved.length > 0) {
		for (const mode of limits.unresolved) {
			lines.push(
				`- ${mode.outcome}: ${shortHash(mode.failureModeId)} (${mode.category}) — ` +
					`failure rate ${percent(mode.baselineFailureRateBps / 10_000)} → ` +
					`${percent(mode.candidateFailureRateBps / 10_000)}`,
			);
		}
	} else if (limits.unresolvedNote?.startsWith("not derivable")) {
		lines.push(`- ${limits.unresolvedNote}`);
	} else {
		lines.push(`- none recorded — ${limits.unresolvedNote ?? "no targeted failure mode remained"}`);
	}
	lines.push(
		limits.noiseBand
			? `- calibrated noise band: 95% CI ${formatPoints(limits.noiseBand.confidence95.low)} … ` +
				`${formatPoints(limits.noiseBand.confidence95.high)} from an A/A run of ` +
				`${limits.noiseBand.targetSha.slice(0, SHA_HEX)} on ${design(limits.noiseBand.design)}`
			: "- calibrated noise band: not measured (`ahde calibrate --target <dir>`)",
	);
	const development = limits.dataset.development;
	const cases = development.cases === null ? "an unknown number of cases" : `${development.cases} cases`;
	const developmentText = development.corpusId === null
		? `development evidence (no published corpus, ${cases})`
		: `development ${development.name ? `“${development.name}” ` : ""}` +
			`(${shortHash(development.corpusId)}, ${cases})`;
	const sealedText = limits.dataset.sealed.cases === null
		? "sealed exam (not run)"
		: `sealed exam (${limits.dataset.sealed.cases} cases)`;
	lines.push(`- data: ${developmentText}; ${sealedText}`);
	return lines;
}

/** The client-facing page. Markdown, because the client keeps it. */
export function renderVersionPassportMarkdown(passport: VersionPassport): string {
	const version = passport.promoted && passport.versionTag
		? passport.versionTag
		: "not promoted — verified only";
	const lines: string[] = [
		`# Version passport — ${passport.agentId} ${passport.versionTag ?? "(verified only)"}`,
		"",
		`- agent: ${passport.agentId}`,
		`- version: ${version}`,
		`- date: ${passport.at.slice(0, 10)}`,
		`- revision: ${passport.revisions.baselineSha.slice(0, SHA_HEX)} → ` +
			`${passport.revisions.candidateSha.slice(0, SHA_HEX)}`,
		`- model: ${passport.model.provider}/${passport.model.id}`,
		"",
		`## Promised — ${shortHash(passport.promised.specId)}`,
		"",
		`*${passport.promised.title}*`,
		"",
		"Success criteria",
		...bullets(passport.promised.successCriteria, "none stated"),
		"",
		"Constraints",
		...bullets(passport.promised.constraints, "none stated"),
		"",
		"## Measured",
		"",
	];

	lines.push(
		passport.measured.development
			? developmentLine(passport.measured.development)
			: "- development: no comparison evidence recorded",
	);
	lines.push(
		passport.measured.sealed
			? `- sealed guardrail: **${passport.measured.sealed.verdict}** on ${design(passport.measured.sealed.design)}`
			: "- sealed guardrail: not run (promotion stays locked)",
	);
	const ratios = passport.measured.resources;
	const ratioParts = ratios
		? [
			ratio(ratios.costRatio) === null ? null : `cost ${ratio(ratios.costRatio)}`,
			ratio(ratios.latencyRatio) === null ? null : `latency ${ratio(ratios.latencyRatio)}`,
			ratio(ratios.tokenRatio) === null ? null : `tokens ${ratio(ratios.tokenRatio)}`,
			// A ratio compares two arms; this is a total, so it says so.
			ratios.judgeCostUsd > 0 ? `judge ${formatEvaluatorSpend(ratios.judgeCostUsd)} total` : null,
		].filter((part): part is string => part !== null)
		: [];
	lines.push(
		ratioParts.length > 0
			? `- per answer, candidate over baseline: ${ratioParts.join(" · ")}`
			: "- per answer, candidate over baseline: not recorded",
	);

	lines.push("", "## Judge", "", ...judgeLines(passport.judge));
	lines.push("", "## Known limits", "", ...limitLines(passport.limits));

	const provenance = passport.provenance;
	const evalRuns = provenance.evalRuns;
	const sealedRuns = evalRuns.sealedBaseline && evalRuns.sealedCandidate
		? `; sealed ${evalRuns.sealedBaseline} → ${evalRuns.sealedCandidate}`
		: "";
	lines.push(
		"",
		"## Provenance",
		"",
		`- spec: ${provenance.specId === null ? "none" : shortHash(provenance.specId)}`,
		`- proposal: ${provenance.proposalHash === null ? "none" : shortHash(provenance.proposalHash)}`,
		`- gate policies: ${provenance.gatePolicyIds.length > 0 ? provenance.gatePolicyIds.join(", ") : "none"}`,
		`- eval runs: development ${evalRuns.developmentBaseline} → ${evalRuns.developmentCandidate}${sealedRuns}`,
		provenance.appliedBy === null
			? "- applied by: not recorded (manual candidate)"
			: `- applied by: ${provenance.appliedBy.actorId} — ${provenance.appliedBy.reason}`,
		`- candidate record: ${passport.candidateId}`,
	);
	return `${lines.join("\n")}\n`;
}
