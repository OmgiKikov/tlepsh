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
 * Two surfaces read it, and one module serves both so the page cannot drift:
 *
 *   - `ahde passport --target <dir>` selects a subject (the newest promotion, a
 *     promotion tag, or one candidate id) and refuses with a next step when the
 *     subject or an artifact the page rests on is missing. Its projection is
 *     what `--json` prints, hashes whole.
 *   - `/passport [version]` inside Builder Pi describes one *shipped* version of
 *     the project the Workbench already has open. It never refuses over a
 *     missing sibling artifact: it narrows the section and says so under “What
 *     this page could not read”, because the operator is looking at a panel, not
 *     driving a script.
 *
 * The sealed boundary is the same one every other surface keeps: the holdout
 * contributes a verdict and a design size, and nothing else. Its corpus id, its
 * name, its tasks, its answers and its eval run ids never enter either
 * projection, so they cannot appear in a rendered page or in the JSON behind it
 * — the renderer is not what is keeping them out. The corpus store is opened for
 * the development corpus's name and case count, and for nothing sealed.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatJudgeAgreement, type JudgeAgreementStats } from "../domain/judge-agreement.js";
import { sealedOutcome, sealedOutcomeLabel, type SealedOutcome } from "../domain/comparison-gate.js";
import { hasMessage, plural, t, verdictLabel, type MessageKey } from "../i18n.js";
import { isPromotionGradeGateEvidence, type CandidateRecord } from "../domain/candidate.js";
import { loadDiagnosis } from "../diagnosis.js";
import { loadTarget } from "../manifest.js";
import { listCorpora } from "../corpus.js";
import { sealedExamOrigin, type SealedExamOrigin } from "./sealed-synth.js";

/**
 * The provenance clause on the exam, as a message key. An exam the operator
 * brought needs no explanation and carries no origin at all; the other four say
 * who wrote the questions, because a verdict on questions a model wrote is
 * worth a different amount depending on whether a human ever read them.
 *
 * One table, read by the markdown page here and by the panel in
 * `builder/render/passport.ts`, so the two surfaces cannot drift apart.
 */
export const EXAM_ORIGIN_KEY: Record<SealedExamOrigin, MessageKey> = {
	"judge-generated": "passport.exam-generated",
	"judge-generated-reviewed": "passport.exam-generated-reviewed",
	"judge-generated-kb": "passport.exam-generated-kb",
	"judge-generated-kb-reviewed": "passport.exam-generated-kb-reviewed",
};
import { readEvalRunIndex } from "../eval.js";

import { loadApprovedSpec, loadSpecSnapshot } from "../spec.js";
import { calibrationProjection } from "../workbench/calibration.js";
import { loadCandidateRecord } from "./candidate-review.js";
import { inspectCandidateImpact } from "./candidate-impact.js";
import { compileImprovementBrief, publicTaskId } from "./improvement-brief.js";
import { failureModeReading } from "./run-explanation.js";
import { judgeEvidenceCalibration } from "./judge-labels.js";
import { detectPromotionFlips } from "./regression-guards.js";
import {
	calibrationStrip,
	compileDecidedPredictionCalibration,
	measurementOf,
	readCandidatePrediction,
	scorePredictedOverall,
	type PredictedOverallOutcome,
	type PredictionCalibration,
} from "./prediction.js";
import { measurementLine, measurementSurface } from "./measurement-line.js";
import { bareDelta, fromPoints, kappa, money, percent, points, ratio } from "../measurement.js";

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

// ---------------------------------------------------------------------------
// Shared reads. Both surfaces walk the same candidate directory, keep the same
// sealed boundary, and compute the judge's majority-class baseline the same way.

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

type PromotedEvent = Extract<CandidateRecord["events"][number], { type: "promoted" }>;

function promotedEventOf(record: CandidateRecord): PromotedEvent | null {
	const event = record.events.find((candidate) => candidate.type === "promoted");
	return event?.type === "promoted" ? event : null;
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
 * The judge spend recorded on these exact eval runs. An index that cannot be
 * read contributes nothing: a missing number is reported as no judge spend
 * shown, never as a guess. Sealed runs are never passed in, as they are never
 * opened for anything else either.
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

// ---------------------------------------------------------------------------
// The CLI surface: one subject, chosen by id or tag, or the newest promotion.

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
	/**
	 * Which of the two findings a `pass` was: the interval wholly above zero, or
	 * merely not below it. Derived from the verdict's own interval, so it says
	 * nothing about the exam that the verdict did not already say.
	 */
	outcome: SealedOutcome | null;
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

/**
 * Why a section is narrower than it should be, as a code rather than a
 * sentence. The `--json` projection is machine-readable and language-neutral;
 * the page renders these through the dictionary, in the operator's language.
 */
export type PassportJudgeNote = "runs-unreadable";
export type PassportUnresolvedNote = "impact-unreadable" | "no-basis" | "all-resolved";

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
	note: PassportJudgeNote | null;
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
	/**
	 * Case count and where the exam came from. A sealed corpus still has no name
	 * and no id on this surface: `origin` is one word about who wrote the
	 * questions, which is exactly what a reader of this page needs in order to
	 * know how much the verdict is worth.
	 */
	sealed: { cases: number | null; origin: SealedExamOrigin | null };
}

export interface PassportProvenance {
	specId: string | null;
	proposalHash: string | null;
	gatePolicyIds: string[];
	/**
	 * The development lineage only. A sealed run id names the exam it came from
	 * to anyone holding the runs root, so it stays out of the projection rather
	 * than being filtered by whichever renderer happens to print it.
	 */
	evalRuns: {
		developmentBaseline: string;
		developmentCandidate: string;
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
		unresolvedNote: PassportUnresolvedNote | null;
		noiseBand: PassportNoiseBand | null;
		dataset: PassportDataset;
	};
	provenance: PassportProvenance;
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
	const promoted = promotedEventOf(record);
	return promoted ? { tag: promoted.decision.tag, at: promoted.at } : null;
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

function policyIdOf(comparison: unknown): string | null {
	const policyId = (comparison as { policyId?: unknown } | null | undefined)?.policyId;
	return typeof policyId === "string" ? policyId : null;
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
			note: "runs-unreadable",
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
function unresolvedTargetedModes(
	runsRoot: string,
	stateRoot: string,
	record: CandidateRecord,
): { diagnosisBound: boolean; unresolved: PassportUnresolvedMode[]; note: PassportUnresolvedNote | null } {
	const bound = record.origin.kind === "applied-builder" && record.origin.source !== null;
	if (!bound) return { diagnosisBound: false, unresolved: [], note: null };
	let basis;
	try {
		basis = inspectCandidateImpact({ runsRoot, stateRoot, candidateId: record.candidateId }).proposalBasis;
	} catch {
		// A passport says what the evidence supports and no more. The exact
		// filesystem reason belongs in the operator's terminal, not on the page.
		return { diagnosisBound: true, unresolved: [], note: "impact-unreadable" };
	}
	if (!basis) {
		return { diagnosisBound: true, unresolved: [], note: "no-basis" };
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
		note: unresolved.length === 0 ? "all-resolved" : null,
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
function compileTargetPassport(options: CompileVersionPassportOptions): VersionPassport {
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

	const limits = unresolvedTargetedModes(options.runsRoot, options.stateRoot, record);
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
				? {
					verdict: sealedComparison.verdict,
					design: sealedComparison.design,
					outcome: sealedOutcome(sealedComparison),
				}
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
				// Design size, plus the one provenance word. Read by corpus id from
				// the synthesis receipts and then thrown away: the id itself names
				// the exam to anyone holding the corpus store, so it stops here.
				sealed: {
					cases: sealedComparison?.design.tasks ?? null,
					origin: sealedExamOrigin(options.stateRoot, projectId, sealed?.corpus?.id ?? null),
				},
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
// The Builder surface: one shipped version of the project already open, with a
// warnings channel instead of a refusal for anything that narrows the page.

const MAX_CRITERIA = 20;
const MAX_MODE_TITLE_CHARS = 90;
const MAX_UNRESOLVED_MODES = 5;
const MAX_FLIPS_CONSIDERED = 200;
const MAX_REASON_CHARS = 300;

function clip(value: string, max: number): string {
	const flat = value.replace(/\s+/gu, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
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
	/** What a `pass` showed, from its own interval; null on every other verdict. */
	outcome: SealedOutcome | null;
}

export interface VersionPassportResources {
	costRatio: number | null;
	latencyRatio: number | null;
	tokenRatio: number | null;
	/**
	 * The judge endpoint's own bill across the two development arms. A total,
	 * never a ratio: an instrument's cost is not the agent's per-answer cost.
	 */
	judgeCostUsd: number;
}

export interface VersionPassportJudge {
	agreement: number;
	kappa: number | null;
	/** Independent labelled subjects behind the agreement. */
	subjects: number;
	checks: number;
	/**
	 * The share of human labels in their more common class. An instrument that
	 * always answered with that class would score exactly this, so agreement at
	 * or below the line certifies nothing.
	 */
	majorityClassBaseline: number | null;
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

export interface ShippedVersionPassport {
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
		/** What the applied proposal promised, beside what the gate measured. */
		predicted: PredictedOverallOutcome | null;
	};
	/** null means nobody has checked the judge against a human. */
	judge: VersionPassportJudge | null;
	limits: {
		/** Failure modes this change aimed at that did not fully flip. */
		unresolvedModes: string[];
		unresolvedOmitted: number;
		noise: VersionPassportNoise | null;
		/** Development basket identity, and the exam as a count and one word. */
		developmentCorpus: { id: string; hash: string } | null;
		sealedTasks: number;
		/** Who wrote the exam, when a receipt says. Never its id or its cases. */
		sealedOrigin: SealedExamOrigin | null;
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
		/** This Builder's whole predicted-vs-actual record on this project. */
		predictionCalibration: PredictionCalibration;
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
		const promotion = promotedEventOf(record);
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
function unresolvedModeTitles(
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
			.map((mode) => clip(failureModeReading(mode).title, MAX_MODE_TITLE_CHARS));
		return { titles, omitted: Math.max(0, unresolved.length - titles.length) };
	} catch {
		warnings.push(t("passport.md.warning-diagnosis"));
		return { titles: [], omitted: 0 };
	}
}

/**
 * One shipped version, as a page. Throws only when there is no such version to
 * describe; everything narrower is a warning on the page itself.
 */
function compileShippedPassport(
	input: VersionPassportInput,
	dependenciesInput: Partial<VersionPassportDependencies>,
): ShippedVersionPassport {
	const dependencies: VersionPassportDependencies = { ...DEFAULT_DEPENDENCIES, ...dependenciesInput };
	const runsRoot = resolve(input.runsRoot);
	const warnings: string[] = [];
	const { records, unreadable } = promotedRecords(input);
	if (unreadable > 0) {
		warnings.push(t("passport.md.warning-records-unreadable", { records: plural(unreadable, "record") }));
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

	let promised: ShippedVersionPassport["promised"] = null;
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
			warnings.push(t("passport.md.warning-spec-unreadable"));
		}
	} else {
		warnings.push(t("passport.md.warning-no-spec"));
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
				judge = {
					agreement: stats.agreement,
					kappa: stats.kappa,
					subjects: stats.n,
					checks: stats.nChecks,
					majorityClassBaseline: majorityClassBaseline(stats),
				};
			}
		} catch {
			warnings.push(t("passport.md.warning-judge-labels"));
		}
	}

	const unresolved = unresolvedModeTitles(record, runsRoot, dependencies, warnings);
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
				? {
					verdict: sealed.verdict,
					tasks: sealed.design.tasks,
					repetitions: sealed.design.repetitions,
					outcome: sealedOutcome({ verdict: sealed.verdict, confidence95: sealed.summary.confidence95 }),
				}
				: null,
			resources: isPromotionGradeGateEvidence(development)
				? {
					costRatio: development.resources.costRatio,
					latencyRatio: development.resources.latencyRatio,
					tokenRatio: development.resources.tokenRatio,
					judgeCostUsd: developmentRuns
						? judgeSpendOf(runsRoot, [developmentRuns.baseline, developmentRuns.candidate])
						: 0,
				}
				: null,
			// The promise the operator applied, scored against the gate that decided.
			predicted: scorePredictedOverall(
				readCandidatePrediction(runsRoot, record),
				measurementOf(isPromotionGradeGateEvidence(development) ? development.summary : null),
			),
		},
		judge,
		limits: {
			unresolvedModes: unresolved.titles,
			unresolvedOmitted: unresolved.omitted,
			noise: noiseFor(input, record.baseline.sha),
			developmentCorpus: evaluation?.development.corpus
				? { id: evaluation.development.corpus.id, hash: evaluation.development.corpus.hash }
				: null,
			// The exam's size, and one word about who wrote it.
			sealedTasks: isPromotionGradeGateEvidence(sealed) ? sealed.design.tasks : 0,
			sealedOrigin: sealedExamOrigin(input.stateRoot, input.projectId, evaluation?.sealedHoldout?.corpus?.id ?? null),
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
			// The development lineage only; the sealed arms name the exam.
			developmentEvalRuns: developmentRuns,
			predictionCalibration: predictionCalibrationOf(input, runsRoot),
		},
		warnings,
	};
}

/**
 * How well this Builder has predicted, over every decided candidate of the
 * project. It belongs beside the provenance of one version because a single
 * kept promise means little; a record of them is what makes the next promise
 * worth reading.
 */
function predictionCalibrationOf(input: VersionPassportInput, runsRoot: string): PredictionCalibration {
	return compileDecidedPredictionCalibration({
		runsRoot,
		projectId: input.projectId,
		...(input.targetId === undefined ? {} : { targetId: input.targetId }),
	});
}

/**
 * Compile a passport. `targetDir` picks the CLI's subject-selecting read of one
 * candidate; everything else is the Builder's read of one shipped version of the
 * project already open.
 */
export function compileVersionPassport(options: CompileVersionPassportOptions): VersionPassport;
export function compileVersionPassport(
	input: VersionPassportInput,
	dependencies?: Partial<VersionPassportDependencies>,
): ShippedVersionPassport;
export function compileVersionPassport(
	input: CompileVersionPassportOptions | VersionPassportInput,
	dependencies: Partial<VersionPassportDependencies> = {},
): VersionPassport | ShippedVersionPassport {
	return "targetDir" in input
		? compileTargetPassport(input)
		: compileShippedPassport(input, dependencies);
}

// ---------------------------------------------------------------------------
// Rendering.
//
// The passport is the one artifact that leaves this machine: the operator sends
// the markdown file to whoever paid for the agent. So it is a document, not a
// panel — every sentence on it goes through the dictionary and is written in
// the language the operator reads, and the only Latin left on the page is what
// is not language: ids, hashes, model names, command names.
//
// Hashes are cut to twelve hex characters on the face and printed whole in the
// footer, so nothing above the fold is a hash and an auditor can still resolve
// every identifier. The JSON projection stays exact either way.

const HASH_HEX = 12;
const SHA_HEX = 10;

/** `sha256:dddda4e91f3a…`, `spec-bc824da34f2e…`, `f0ae64c0f9`. */
function shortHash(value: string): string {
	const match = /^([A-Za-z][A-Za-z0-9-]*[:-])?([0-9a-f]{16,})$/.exec(value);
	if (!match) return value;
	return `${match[1] ?? ""}${match[2]!.slice(0, HASH_HEX)}…`;
}

function shortSha(value: string): string {
	return value.slice(0, HASH_HEX);
}

function ratioOrNull(value: number | null): string | null {
	return value === null ? null : ratio(value);
}

/** `6 cases × 2 repetitions` / `6 кейсах × 2 повтора`: the design, counted. */
function design(tasks: number, repetitions: number): string {
	return t("passport.md.design", {
		cases: plural(tasks, "case measured on"),
		repetitions: plural(repetitions, "repetition"),
	});
}

function bullets(items: readonly string[], empty: string): string[] {
	return items.length === 0 ? [`- ${empty}`] : items.map((item) => `- ${item}`);
}

/**
 * The clause that says who wrote the exam. An exam the operator brought carries
 * no origin and gets no clause: it needs no explanation.
 */
function examOriginClause(origin: SealedExamOrigin | null): string {
	return origin === null ? "" : `, ${t(EXAM_ORIGIN_KEY[origin])}`;
}

const JUDGE_NOTE_KEY: Record<PassportJudgeNote, MessageKey> = {
	"runs-unreadable": "passport.md.judge-runs-unreadable",
};

const UNRESOLVED_NOTE_KEY: Record<PassportUnresolvedNote, MessageKey> = {
	"impact-unreadable": "passport.md.note-impact-unreadable",
	"no-basis": "passport.md.note-no-basis",
	"all-resolved": "passport.md.note-all-resolved",
};

/** What happened to a targeted mode, in words; the stored token never bends. */
function modeOutcomeLabel(outcome: string): string {
	const key = `passport.md.mode-${outcome}`;
	return hasMessage(key) ? t(key) : outcome;
}

/** The diagnosis category, in words. A token nobody named prints as itself. */
function categoryLabel(category: string): string {
	const key = `passport.md.category.${category}`;
	return hasMessage(key) ? t(key) : category;
}

/** The judge line every surface shares, so the two cannot drift. */
export function judgeSummaryLine(judge: VersionPassportJudge | null): string {
	if (!judge) return t("passport.md.judge-not-calibrated");
	return t("passport.md.judge-line", {
		agreement: percent(judge.agreement),
		kappa: kappa(judge.kappa),
		subjects: plural(judge.subjects, "labelled subject"),
		checks: plural(judge.checks, "check"),
		// The majority-class baseline travels with agreement wherever agreement
		// goes: a number above a line nobody can see certifies nothing.
		baseline: judge.majorityClassBaseline === null
			? ""
			: t("passport.md.judge-baseline", { rate: percent(judge.majorityClassBaseline) }),
	});
}

/**
 * The development line every surface shares — the composed sentence, so the
 * passport, the panel and the Builder's own copy are the same string.
 */
export function developmentSummaryLine(development: VersionPassportDevelopment | null): string {
	if (!development) return t("passport.md.no-development-evidence");
	return measurementLine({ development: measurementSurface(development) }).text;
}

/**
 * `judge $0.01 total`, or null when no judge spend was recorded. A ratio
 * compares two arms; the judge's bill is a total, so it never joins them.
 */
export function judgeSpendLine(
	resources: VersionPassportResources | PassportResourceRatios | null,
): string | null {
	return resources && resources.judgeCostUsd > 0
		? t("passport.md.judge-spend", { cost: money(resources.judgeCostUsd) })
		: null;
}

/** The resource line every surface shares: three ratios and the judge's bill. */
export function resourceSummaryLine(resources: VersionPassportResources | null): string {
	return [
		`${t("unit.cost-ratio")} ${ratio(resources?.costRatio ?? null)}`,
		`${t("unit.latency-ratio")} ${ratio(resources?.latencyRatio ?? null)}`,
		`${t("unit.token-ratio")} ${ratio(resources?.tokenRatio ?? null)}`,
		judgeSpendLine(resources),
	].filter((part): part is string => part !== null).join(" · ");
}

/**
 * What the applied proposal promised, beside what the gate measured. The unit
 * is the dictionary's — `pts` or `п.п.` — and never a hardcoded `pp`.
 */
function predictionLine(outcome: PredictedOverallOutcome | null): string {
	if (!outcome) return `${t("label.prediction")}: ${t("passport.md.no-prediction")}`;
	const metric = t(outcome.kind === "score" ? "measurement.metric-score" : "measurement.metric-pass-rate");
	// `points` reads a [0,1] fraction; a stated prediction is already in points.
	const predicted = points(fromPoints(outcome.predictedPp));
	return outcome.actualPp === null
		? t("prediction.passport-unmeasured", { predicted, metric })
		: t("prediction.passport", { predicted, metric, actual: points(fromPoints(outcome.actualPp)) });
}

/** The Builder's whole predicted-against-actual record, unpainted. */
function predictionCalibrationText(calibration: PredictionCalibration): string {
	if (calibration.scored === 0) return t("prediction.calibration-none");
	return t("prediction.calibration", {
		hits: calibration.hits,
		total: calibration.scored,
		error: calibration.meanAbsoluteErrorPp === null ? "—" : `${calibration.meanAbsoluteErrorPp} ${t("unit.points")}`,
		strip: calibrationStrip(calibration),
	});
}

/**
 * `- development: **improved** — score 31% → 62% (+31 pts, 95% CI …) on 7
 * cases × 3 · pass rate 17% → 58%`. The verdict is bold because a reader scans
 * for it; everything after it is the composed sentence, unchanged.
 */
function developmentLine(measurement: PassportDevelopmentMeasurement): string {
	const line = measurementLine({
		development: measurementSurface({
			...measurement,
			tasks: measurement.design.tasks,
			repetitions: measurement.design.repetitions,
		}),
	});
	const body = [line.metric, line.delta, line.design].filter((part) => part.length > 0).join(" ");
	return `- ${t("passport.md.development", {
		verdict: verdictLabel(measurement.verdict),
		body: [body, line.passRate, line.smallBasket].filter((part) => part !== null && part.length > 0).join(" · "),
	})}`;
}

function judgeLines(judge: PassportJudge): string[] {
	if (judge.note !== null) {
		return [t("passport.md.judge-uncalibrated", { reason: t(JUDGE_NOTE_KEY[judge.note]) })];
	}
	if (judge.graderSpecs === 0) {
		return [t("passport.md.judge-uncalibrated", { reason: t("passport.md.judge-no-grader") })];
	}
	if (!judge.stats) {
		return [t("passport.md.judge-uncalibrated", { reason: t("passport.md.judge-no-labels") })];
	}
	const baseline = judge.majorityClassBaseline;
	return [
		t("passport.md.judge-agreement", {
			agreement: formatJudgeAgreement(judge.stats),
			baseline: baseline === null ? "" : t("passport.md.judge-baseline", { rate: percent(baseline) }),
		}),
		"",
		baseline === null
			? t("passport.md.judge-agreement-note")
			: t("passport.md.judge-baseline-note", { rate: percent(baseline) }),
	];
}

function limitLines(limits: VersionPassport["limits"]): string[] {
	const lines: string[] = [];
	if (!limits.diagnosisBound) {
		lines.push(`- ${t("passport.md.not-diagnosis-bound")}`);
	} else if (limits.unresolved.length > 0) {
		for (const mode of limits.unresolved) {
			lines.push(`- ${t("passport.md.unresolved-mode", {
				outcome: modeOutcomeLabel(mode.outcome),
				mode: shortHash(mode.failureModeId),
				category: categoryLabel(mode.category),
				before: percent(mode.baselineFailureRateBps / 10_000),
				after: percent(mode.candidateFailureRateBps / 10_000),
			})}`);
		}
	} else if (limits.unresolvedNote === "impact-unreadable" || limits.unresolvedNote === "no-basis") {
		lines.push(`- ${t(UNRESOLVED_NOTE_KEY[limits.unresolvedNote])}`);
	} else {
		lines.push(`- ${t("passport.md.limits-none", {
			note: limits.unresolvedNote === null
				? t("passport.md.note-none-remained")
				: t(UNRESOLVED_NOTE_KEY[limits.unresolvedNote]),
		})}`);
	}
	lines.push(`- ${limits.noiseBand
		? t("passport.md.noise-band", {
			ci: t("unit.ci"),
			low: bareDelta(limits.noiseBand.confidence95.low),
			high: bareDelta(limits.noiseBand.confidence95.high),
			sha: limits.noiseBand.targetSha.slice(0, SHA_HEX),
			design: design(limits.noiseBand.design.tasks, limits.noiseBand.design.repetitions),
		})
		: t("passport.md.noise-band-none")}`);
	const development = limits.dataset.development;
	const cases = development.cases === null ? t("passport.md.cases-unknown") : plural(development.cases, "case");
	const developmentText = development.corpusId === null
		? t("passport.md.data-development-no-corpus", { cases })
		: development.name === null
			? t("passport.md.data-development-unnamed", { corpus: shortHash(development.corpusId), cases })
			: t("passport.md.data-development", {
				name: development.name,
				corpus: shortHash(development.corpusId),
				cases,
			});
	const sealedText = limits.dataset.sealed.cases === null
		? t("passport.md.data-sealed-none")
		: t("passport.md.data-sealed", {
			cases: plural(limits.dataset.sealed.cases, "case"),
			origin: examOriginClause(limits.dataset.sealed.origin),
		});
	lines.push(`- ${t("passport.md.data", { development: developmentText, sealed: sealedText })}`);
	return lines;
}

/** The client-facing page for one candidate. Markdown, because the client keeps it. */
function renderTargetPassportMarkdown(passport: VersionPassport): string {
	const version = passport.promoted && passport.versionTag
		? passport.versionTag
		: t("passport.md.not-promoted");
	const lines: string[] = [
		`# ${t("passport.md.title", {
			agent: passport.agentId,
			version: passport.versionTag ?? t("passport.md.verified-only"),
		})}`,
		"",
		`- ${t("passport.md.agent")}: ${passport.agentId}`,
		`- ${t("passport.md.version")}: ${version}`,
		`- ${t("passport.md.date")}: ${passport.at.slice(0, 10)}`,
		`- ${t("passport.md.revision")}: ${passport.revisions.baselineSha.slice(0, SHA_HEX)} → ` +
			`${passport.revisions.candidateSha.slice(0, SHA_HEX)}`,
		`- ${t("passport.model")}: ${passport.model.provider}/${passport.model.id}`,
		"",
		`## ${t("passport.md.promised-spec", { spec: shortHash(passport.promised.specId) })}`,
		"",
		`*${passport.promised.title}*`,
		"",
		t("passport.success-criteria"),
		...bullets(passport.promised.successCriteria, t("passport.none-stated")),
		"",
		t("passport.constraints"),
		...bullets(passport.promised.constraints, t("passport.none-stated")),
		"",
		`## ${t("passport.measured")}`,
		"",
	];

	lines.push(
		passport.measured.development
			? developmentLine(passport.measured.development)
			: `- ${t("passport.md.development-none")}`,
	);
	lines.push(
		passport.measured.sealed
			? `- ${t("passport.md.sealed-guardrail", {
				verdict: `${verdictLabel(passport.measured.sealed.verdict)}${
					passport.measured.sealed.outcome ? ` · ${sealedOutcomeLabel(passport.measured.sealed.outcome)}` : ""
				}`,
				design: design(passport.measured.sealed.design.tasks, passport.measured.sealed.design.repetitions),
			})}`
			: `- ${t("passport.md.sealed-guardrail-none")}`,
	);
	const ratios = passport.measured.resources;
	const ratioParts = ratios
		? [
			ratioOrNull(ratios.costRatio) === null ? null : `${t("unit.cost-ratio")} ${ratioOrNull(ratios.costRatio)}`,
			ratioOrNull(ratios.latencyRatio) === null
				? null
				: `${t("unit.latency-ratio")} ${ratioOrNull(ratios.latencyRatio)}`,
			ratioOrNull(ratios.tokenRatio) === null ? null : `${t("unit.token-ratio")} ${ratioOrNull(ratios.tokenRatio)}`,
			judgeSpendLine(ratios),
		].filter((part): part is string => part !== null)
		: [];
	lines.push(
		ratioParts.length > 0
			? `- ${t("passport.md.per-answer", { parts: ratioParts.join(" · ") })}`
			: `- ${t("passport.md.per-answer-none")}`,
	);

	lines.push("", `## ${t("label.judge-instrument")}`, "", ...judgeLines(passport.judge));
	lines.push("", `## ${t("passport.known-limits")}`, "", ...limitLines(passport.limits));

	const provenance = passport.provenance;
	const evalRuns = provenance.evalRuns;
	lines.push(
		"",
		`## ${t("passport.provenance")}`,
		"",
		`- ${t("passport.md.spec", {
			value: provenance.specId === null ? t("passport.md.none") : shortHash(provenance.specId),
		})}`,
		`- ${t("passport.md.proposal", {
			value: provenance.proposalHash === null ? t("passport.md.none") : shortHash(provenance.proposalHash),
		})}`,
		`- ${t("passport.md.gate-policies", {
			value: provenance.gatePolicyIds.length > 0 ? provenance.gatePolicyIds.join(", ") : t("passport.md.none"),
		})}`,
		// The sealed arms are deliberately absent: an eval run id names the exam.
		`- ${t("passport.md.eval-runs", {
			baseline: evalRuns.developmentBaseline,
			candidate: evalRuns.developmentCandidate,
		})}`,
		provenance.appliedBy === null
			? `- ${t("passport.md.applied-by-none")}`
			: `- ${t("passport.md.applied-by", {
				actor: provenance.appliedBy.actorId,
				// Whoever's words they are, they are quoted and never translated;
				// the actor who wrote them is named right beside the quote.
				reason: t("passport.md.reason-plain", { reason: provenance.appliedBy.reason }),
			})}`,
		`- ${t("passport.md.candidate-record", { id: passport.candidateId })}`,
	);
	return `${lines.join("\n")}\n`;
}

/** The same page for a shipped version: what the operator can send onward. */
function renderShippedPassportMarkdown(passport: ShippedVersionPassport): string {
	const lines: string[] = [];
	lines.push(`# ${passport.agent} ${passport.version}`, "");
	lines.push(`- ${t("passport.md.shipped")}: ${passport.at}`);
	lines.push(`- ${t("passport.revisions")}: ${shortSha(passport.baselineSha)} → ${shortSha(passport.candidateSha)}`);
	lines.push(`- ${t("label.model")}: ${passport.model ? `${passport.model.provider}/${passport.model.id}` : "—"}`);
	lines.push("");

	lines.push(`## ${t("passport.promised")}`, "");
	if (!passport.promised) {
		lines.push(`_${t("passport.no-spec")}_`, "");
	} else {
		lines.push(
			t("passport.md.promised-title", { title: passport.promised.title, purpose: passport.promised.purpose }),
			"",
		);
		lines.push(`${t("passport.success-criteria")}:`, "");
		for (const criterion of passport.promised.successCriteria) lines.push(`- ${criterion}`);
		if (passport.promised.successCriteria.length === 0) lines.push(`- _${t("passport.none-stated")}_`);
		lines.push("", `${t("passport.constraints")}:`, "");
		for (const constraint of passport.promised.constraints) lines.push(`- ${constraint}`);
		if (passport.promised.constraints.length === 0) lines.push(`- _${t("passport.none-stated")}_`);
		lines.push("");
	}

	lines.push(`## ${t("passport.measured")}`, "");
	const development = passport.measured.development;
	lines.push(`- ${t("label.development")}: ${developmentSummaryLine(development)}`);
	if (development) {
		// The design stands on its own line here, with no "on" in front of it, so
		// the noun stands in the plain form the panel uses and not the one the
		// sentence above bends after "на".
		lines.push(`- ${t("calibration.design")}: ${t("passport.design", {
			tasks: plural(development.tasks, "case"),
			repetitions: plural(development.repetitions, "repetition"),
		})}${development.excludedTasks > 0 ? t("passport.excluded", { count: development.excludedTasks }) : ""}`);
	}
	const sealed = passport.measured.sealed;
	lines.push(`- ${t("passport.sealed-exam")}: ${sealed
		? `${verdictLabel(sealed.verdict)}${
			sealed.outcome ? ` · ${sealedOutcomeLabel(sealed.outcome)}` : ""
		} ${t("passport.sealed-shape", { tasks: sealed.tasks, repetitions: sealed.repetitions })}`
		: t("passport.sealed-none")}`);
	lines.push(`- ${t("passport.resources")}: ${
		passport.measured.resources ? resourceSummaryLine(passport.measured.resources) : "—"
	}`);
	lines.push(`- ${predictionLine(passport.measured.predicted)}`);
	lines.push("");

	lines.push(`## ${t("label.judge-instrument")}`, "");
	lines.push(`- ${judgeSummaryLine(passport.judge)}`);
	lines.push("");

	lines.push(`## ${t("passport.known-limits")}`, "");
	if (passport.limits.unresolvedModes.length === 0) {
		lines.push(`- ${t("passport.md.modes-none")}`);
	} else {
		lines.push(`- ${t("passport.md.modes-unresolved")}`);
		for (const title of passport.limits.unresolvedModes) lines.push(`  - ${title}`);
		if (passport.limits.unresolvedOmitted > 0) {
			lines.push(`  - _${t("dialog.more", { count: passport.limits.unresolvedOmitted })}_`);
		}
	}
	const noise = passport.limits.noise;
	lines.push(`- ${t("label.noise")}: ${noise
		? t("passport.noise-shape", {
			verdict: verdictLabel(noise.verdict),
			ci: t("unit.ci"),
			low: bareDelta(noise.confidence95.low),
			high: bareDelta(noise.confidence95.high),
			flipWord: t("noise.flip"),
			flip: percent(noise.flipRate),
			tasks: noise.tasks,
			repetitions: noise.repetitions,
		})
		: t("passport.noise-never")}`);
	// The basket is named by its short form here; the whole id is in the footer,
	// because nothing above the fold on a page a client reads may be a hash.
	lines.push(`- ${t("passport.data")}: ${t("passport.data-basket")} ${passport.limits.developmentCorpus
		? shortHash(passport.limits.developmentCorpus.id)
		: "—"} ${t("passport.data-exam")} ${plural(passport.limits.sealedTasks, "case")}${
		examOriginClause(passport.limits.sealedOrigin)
	} ${t("passport.identity-evaluator-only")}`);
	lines.push("");

	const provenance = passport.provenance;
	lines.push(`## ${t("passport.provenance")}`, "");
	lines.push(`- ${t("passport.applied-by")}: ${provenance.appliedBy ?? "—"} · ${provenance.appliedVia
		? t("passport.applied-via", {
			via: t(provenance.appliedVia === "improvement-loop" ? "candidate.applied-by-loop" : "candidate.applied-by-search"),
		})
		: t("passport.applied-read-diff")}`);
	lines.push(`- ${t("passport.reviewed-by")}: ${provenance.reviewedBy ?? "—"} ${t("passport.promoted-by")}: ${
		provenance.promotedBy ?? "—"
	}`);
	lines.push(`- ${predictionCalibrationText(provenance.predictionCalibration)}`);
	// The ship reason is whatever was typed when the version was shipped. It is
	// quoted, labelled as a quote, and never translated.
	if (provenance.reason) lines.push(`- ${t("passport.md.reason-quoted", { reason: provenance.reason })}`);

	if (passport.warnings.length > 0) {
		lines.push("", `## ${t("passport.unreadable")}`, "");
		for (const warning of passport.warnings) lines.push(`- ${warning}`);
	}

	// The footer: every identifier whole, for whoever has to resolve one. It is
	// last because a hash is the least readable thing on the page.
	lines.push("", `## ${t("passport.md.identifiers")}`, "");
	lines.push(`- ${t("passport.md.id-candidate", {
		candidate: provenance.candidateId,
		experiment: provenance.experimentId,
	})}`);
	lines.push(`- ${t("passport.md.id-spec", { spec: provenance.approvedSpecId ?? "—" })}`);
	if (provenance.proposalRunId !== null || provenance.proposalSha256 !== null) {
		lines.push(`- ${t("passport.md.id-proposal", {
			run: provenance.proposalRunId ?? "—",
			hash: provenance.proposalSha256 ?? "—",
		})}`);
	}
	if (passport.limits.developmentCorpus) {
		lines.push(`- ${t("passport.md.id-corpus", {
			corpus: passport.limits.developmentCorpus.id,
			hash: passport.limits.developmentCorpus.hash,
		})}`);
	}
	if (provenance.developmentEvalRuns) {
		lines.push(`- ${t("passport.md.id-eval-runs", {
			baseline: provenance.developmentEvalRuns.baseline,
			candidate: provenance.developmentEvalRuns.candidate,
		})}`);
	}
	return `${lines.join("\n")}\n`;
}

/** The page, for whichever of the two projections was compiled. */
export function renderVersionPassportMarkdown(passport: VersionPassport | ShippedVersionPassport): string {
	return "agentId" in passport
		? renderTargetPassportMarkdown(passport)
		: renderShippedPassportMarkdown(passport);
}
