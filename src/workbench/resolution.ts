import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
	loadBuilderProposalRun,
	type PersistedBuilderRun,
} from "../application/builder-proposal.js";
import type { BuilderCorpusDraft } from "../application/builder-corpus-draft.js";
import { measurementLine, measurementSurface, type MeasurementLine } from "../application/measurement-line.js";
import type { CorpusMetadata } from "../corpus.js";
import type { DiagnosisRecord } from "../diagnosis.js";
import {
	candidateStatus,
	type CandidateRecord,
	isPromotionGradeGateEvidence,
	promotionGradeVerdictOf,
	type ComparisonGateEvidence,
} from "../domain/candidate.js";
import { sealedOutcome, sealedOutcomeLine } from "../domain/comparison-gate.js";
import { stableTasks } from "../compare.js";
import type { EvalRunRecord } from "../eval.js";
import type { SpecSnapshot } from "../spec.js";
import { redactTraceText } from "../trace.js";
import { canonicalJson, type RunRecord } from "../provenance.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";
import { WorkbenchSelectionRequiredError } from "./errors.js";
import type {
	WorkbenchInventory,
	WorkbenchProposalInventory,
} from "./inventory.js";
import type {
	WorkbenchCandidateSummary,
	WorkbenchDiagnosisSummary,
	WorkbenchEvaluationProjection,
	WorkbenchGateProjection,
	WorkbenchProposalReview,
} from "./types.js";

const MAX_DIFF_BYTES = 4 * 1024 * 1024;

function diagnosisText(value: string, maxChars = 1_000): string {
	return redactTraceText(value).slice(0, maxChars);
}

export function proposalReview(record: PersistedBuilderRun): WorkbenchProposalReview {
	if (
		record.result.status !== "completed" ||
		record.result.proposal?.decision !== "propose" ||
		!record.artifacts.proposal
	) throw new Error(`builder run ${record.runId} has no reviewable proposal`);
	const exactDiff = record.result.proposal.changes.map((change) => change.unifiedDiff.trimEnd()).join("\n");
	if (Buffer.byteLength(exactDiff, "utf8") > MAX_DIFF_BYTES) {
		throw new Error(`proposal diff exceeds the ${MAX_DIFF_BYTES}-byte exact review limit; split the proposal`);
	}
	return {
		runId: record.runId,
		proposalHash: record.artifacts.proposal.sha256,
		baseTargetSha: record.result.proposal.baseTargetSha,
		summary: record.result.proposal.summary,
		paths: record.result.proposal.changes.map((change) => change.path),
		risks: record.result.proposal.risks,
		validationPlan: record.result.proposal.validationPlan,
		prediction: record.result.proposal.prediction,
		authoringContext: record.request.authoringContext ?? null,
		evidenceBasis: record.request.proposalBasis
			? {
				algorithmId: record.request.proposalBasis.algorithmId,
				evalRunId: record.request.proposalBasis.evalRunId,
				diagnosisId: record.request.proposalBasis.diagnosisId,
				briefId: record.request.proposalBasis.briefId,
				briefSha256: record.request.proposalBasis.briefSha256,
				failureModes: record.request.proposalBasis.failureModes,
				runRefs: [...new Set(record.result.proposal.diagnoses.flatMap((diagnosis) => diagnosis.evidence))],
			}
			: null,
		exactDiff,
	};
}

function assertExactCandidateArtifact(
	path: string,
	recordedPath: string,
	expectedHash: string,
	label: string,
): Buffer {
	const entry = lstatSync(path);
	if (entry.isSymbolicLink() || !entry.isFile()) {
		throw new Error(`${label} must remain a regular non-symlink artifact`);
	}
	const recordedEntry = lstatSync(resolve(recordedPath));
	if (recordedEntry.isSymbolicLink() || !recordedEntry.isFile()) {
		throw new Error(`${label} Candidate path must remain a regular non-symlink artifact`);
	}
	// macOS may spell the same regular file through /var and /private/var. The
	// resolved inode must match; a symlink at the recorded leaf is still refused.
	if (realpathSync(path) !== realpathSync(resolve(recordedPath))) {
		throw new Error(`${label} path no longer matches the Candidate record`);
	}
	const bytes = readFileSync(path);
	const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	if (actual !== expectedHash) throw new Error(`${label} changed after the candidate was created`);
	return bytes;
}

/**
 * Resolve the exact proposal behind a Candidate, not merely another run with
 * the same id. Automated applies cross a trust boundary here: both immutable
 * artifact hashes and the embedded proposal must agree before a host may show
 * the diff or bind a human review to it.
 */
export function candidateProposalReview(
	runsRoot: string,
	candidate: CandidateRecord,
): WorkbenchProposalReview | null {
	if (candidate.origin.kind !== "applied-builder") return null;
	const origin = candidate.origin;
	const builderRunPath = resolveContainedArtifactPath(runsRoot, "builders", origin.builderRunId, "builder_run.json");
	assertExactCandidateArtifact(builderRunPath, origin.builderRun.path, origin.builderRun.sha256, "Builder run");
	const proposalPath = resolveContainedArtifactPath(runsRoot, "builders", origin.builderRunId, "proposal.json");
	const proposalBytes = assertExactCandidateArtifact(
		proposalPath,
		origin.proposal.path,
		origin.proposal.sha256,
		"Builder proposal",
	);
	const record = loadBuilderProposalRun(runsRoot, origin.builderRunId);
	const review = proposalReview(record);
	if (
		review.proposalHash !== origin.proposal.sha256 ||
		origin.application.proposalSha256 !== origin.proposal.sha256
	) {
		throw new Error("Builder proposal identity no longer matches the Candidate record");
	}
	let artifact: unknown;
	try {
		artifact = JSON.parse(proposalBytes.toString("utf8")) as unknown;
	} catch (error) {
		throw new Error("Builder proposal is no longer valid JSON", { cause: error });
	}
	if (canonicalJson(artifact) !== canonicalJson(record.result.proposal)) {
		throw new Error("Builder proposal artifact no longer matches the exact diff recorded by the Builder run");
	}
	return review;
}

export function diagnosisSummary(record: DiagnosisRecord): WorkbenchDiagnosisSummary {
	return {
		diagnosisId: record.diagnosisId,
		evalRunId: record.evalRunId,
		status: record.status,
		summary: record.summary,
		issues: record.issues.slice(0, 30).map((issue) => ({
			issueId: diagnosisText(issue.issueId, 500),
			category: issue.category,
			severity: issue.severity,
			confidence: issue.confidence,
			summary: diagnosisText(issue.summary),
			rootCause: diagnosisText(issue.rootCause),
			suggestions: issue.suggestions.slice(0, 4).map((suggestion) => diagnosisText(suggestion, 500)),
		})),
		omittedIssues: Math.max(0, record.issues.length - 30),
	};
}

/**
 * The one sentence a candidate carries, from the evidence it carries. The v4
 * gate wins over the stored summary where both spell a field, which is what
 * makes the interval the score's rather than the pass rate's.
 */
export function candidateMeasurement(
	development: WorkbenchCandidateSummary["development"],
	sealedHoldout: WorkbenchCandidateSummary["sealedHoldout"],
): MeasurementLine {
	return measurementLine({
		development: development && (development.comparison || development.gate)
			? measurementSurface({ ...development.comparison, ...development.gate })
			: null,
		// The gate says what the exam decided; the receipt says why it was the
		// size it was. Both belong to the same sentence.
		exam: sealedHoldout.gate
			? { ...sealedHoldout.gate, generation: sealedHoldout.generation ?? null }
			: null,
	});
}

/** That measurement as the one sentence every surface prints. */
export function candidateHeadline(
	development: WorkbenchCandidateSummary["development"],
	sealedHoldout: WorkbenchCandidateSummary["sealedHoldout"],
): string {
	return candidateMeasurement(development, sealedHoldout).text;
}

export function candidateSummary(
	record: CandidateRecord,
	/** Judge calibration for the evidence this candidate rests on, when it uses one. */
	judgeAgreement?: WorkbenchCandidateSummary["judgeAgreement"],
	/** Both development arms re-scored with one revised rubric, when a pair exists. */
	regraded?: WorkbenchCandidateSummary["regraded"],
): WorkbenchCandidateSummary {
	const evaluated = record.events.find((event) => event.type === "evaluated");
	const reviewed = record.events.find((event) => event.type === "reviewed");
	const built = record.events.find((event) => event.type === "built");
	const promoted = record.events.find((event) => event.type === "promoted");
	const rejected = record.events.find((event) => event.type === "rejected");
	const development = evaluated?.type === "evaluated"
		? {
			baselineEvalRunId: evaluated.evaluation.development.baseline.evalRunId,
			candidateEvalRunId: evaluated.evaluation.development.candidate.evalRunId,
			comparison: evaluated.evaluation.development.comparison?.summary ?? null,
			gate: gateProjection(evaluated.evaluation.development.comparison),
		}
		: null;
	const sealedHoldout = evaluated?.type === "evaluated"
		? {
			executed: evaluated.evaluation.sealedHoldout !== undefined,
			gatePassed: promotionGradeVerdictOf(evaluated.evaluation.sealedHoldout?.comparison) === "pass",
			gate: gateProjection(evaluated.evaluation.sealedHoldout?.comparison),
		}
		: { executed: false, gatePassed: false, gate: null };
	return {
		headline: candidateHeadline(development, sealedHoldout),
		candidateId: record.candidateId,
		status: candidateStatus(record),
		projectId: record.projectId,
		targetId: record.targetId,
		specId: record.specId,
		proposalId: record.proposalId,
		baseline: record.baseline,
		candidate: built?.type === "built" ? built.candidate : null,
		// How the diff got onto the branch. `improvement-loop` says a human
		// authorized an automated trial rather than this diff, and every reader of
		// this candidate — the review, the ship dialog — is told so.
		appliedBy: record.origin.kind === "applied-builder"
			? {
				actorId: record.origin.application.actor.id,
				via: record.origin.application.via ?? null,
				paths: [...(record.events.find((event) => event.type === "validated")?.scope.changedFiles ?? [])].sort(),
			}
			: null,
		development,
		sealedHoldout,
		...(judgeAgreement === undefined ? {} : { judgeAgreement }),
		...(regraded === undefined || regraded === null ? {} : { regraded }),
		review: reviewed?.type === "reviewed" ? reviewed.review : null,
		promotion: promoted?.type === "promoted"
			? { tag: promoted.decision.tag, reason: promoted.decision.reason, at: promoted.at }
			: null,
		rejection: rejected?.type === "rejected"
			? { reason: rejected.decision.reason, at: rejected.at }
			: null,
	};
}

/** Verdict projection of v4 gate evidence; legacy (v1–v3) evidence projects to null. */
function gateProjection(
	evidence: ComparisonGateEvidence | null | undefined,
): WorkbenchGateProjection | null {
	if (!isPromotionGradeGateEvidence(evidence)) return null;
	// A sealed `pass` says one of two different things; the projection carries
	// which, so the model reads it instead of inferring it from the interval.
	const decided = { verdict: evidence.verdict, confidence95: evidence.summary.confidence95 };
	const outcome = sealedOutcome(decided);
	const outcomeLine = sealedOutcomeLine(decided);
	return {
		verdict: evidence.verdict,
		surface: evidence.surface,
		delta: evidence.summary.delta,
		baselineScore: evidence.summary.baselineScore,
		candidateScore: evidence.summary.candidateScore,
		scoreDelta: evidence.summary.scoreDelta,
		confidence95: { ...evidence.summary.confidence95 },
		tasks: evidence.design.tasks,
		repetitions: evidence.design.repetitions,
		excludedTasks: evidence.design.excludedTasks,
		flags: { ...evidence.flags },
		resources: {
			costRatio: evidence.resources.costRatio,
			latencyRatio: evidence.resources.latencyRatio,
			tokenRatio: evidence.resources.tokenRatio,
		},
		reasons: [...evidence.reasons],
		...(outcome ? { outcome } : {}),
		...(outcomeLine ? { outcomeLine } : {}),
	};
}

export function resolveOne<T>(input: {
	items: readonly T[];
	explicitId?: string;
	focusId?: string;
	id: (item: T) => string;
	label: string;
}): T {
	if (input.explicitId) {
		const exact = input.items.find((item) => input.id(item) === input.explicitId);
		if (!exact) throw new WorkbenchSelectionRequiredError(input.label, input.items.map(input.id));
		return exact;
	}
	if (input.focusId) {
		const focused = input.items.find((item) => input.id(item) === input.focusId);
		if (focused) return focused;
	}
	if (input.items.length !== 1) {
		throw new WorkbenchSelectionRequiredError(input.label, input.items.map(input.id));
	}
	return input.items[0]!;
}

export function requireApprovedSpec(inventory: WorkbenchInventory, explicitId?: string): SpecSnapshot {
	return resolveOne({
		items: inventory.specs.filter((spec) =>
			spec.status === "approved" && inventory.verifiedApprovedSpecIds.has(spec.id)
		),
		explicitId,
		focusId: inventory.validFocus["approved-spec"]?.id,
		id: (spec) => spec.id,
		label: "approved Spec",
	});
}

export function requireSpecDraft(inventory: WorkbenchInventory, explicitId?: string): SpecSnapshot {
	return resolveOne({
		items: inventory.specs.filter((spec) =>
			spec.status === "draft" && !inventory.approvedDraftSpecIds.has(spec.id)
		),
		explicitId,
		focusId: inventory.validFocus["spec-draft"]?.id,
		id: (spec) => spec.id,
		label: "Spec draft",
	});
}

export function requireCorpusDraft(
	inventory: WorkbenchInventory,
	explicitId?: string,
	approvedSpecId?: string,
	unpublishedOnly = false,
): BuilderCorpusDraft {
	let items = approvedSpecId
		? inventory.corpusDrafts.filter((draft) => draft.approvedSpec.specId === approvedSpecId)
		: inventory.corpusDrafts;
	if (unpublishedOnly) {
		const published = new Set([...inventory.developmentLineage.values()].map((lineage) => lineage.publication.draftId));
		items = items.filter((draft) => !published.has(draft.id));
	}
	return resolveOne({
		items,
		explicitId,
		focusId: inventory.validFocus["corpus-draft"]?.id,
		id: (draft) => draft.id,
		label: "corpus draft",
	});
}

export function requireDevelopmentCorpus(
	inventory: WorkbenchInventory,
	explicitId?: string,
	approvedSpecId?: string,
): CorpusMetadata {
	return resolveOne({
		items: inventory.corpora.filter((corpus) =>
			corpus.visibility === "development" &&
			inventory.developmentLineage.has(corpus.id) &&
			(!approvedSpecId || inventory.developmentLineage.get(corpus.id)?.publication.approvedSpecId === approvedSpecId)
		),
		explicitId,
		focusId: inventory.validFocus["development-corpus"]?.id,
		id: (corpus) => corpus.id,
		label: "development corpus",
	});
}

/** The approved Spec a read or a decision is about: explicit, focused, or the only one. */
function chosenApprovedSpecId(inventory: WorkbenchInventory, explicitId?: string): string | null {
	const approved = inventory.specs.filter((spec) =>
		spec.status === "approved" && inventory.verifiedApprovedSpecIds.has(spec.id)
	);
	const focused = inventory.validFocus["approved-spec"]?.id;
	return explicitId ?? (focused && approved.some((spec) => spec.id === focused)
		? focused
		: approved.length === 1 ? approved[0]!.id : null);
}

export function compatibleDevelopmentEvals(
	inventory: WorkbenchInventory,
	explicitApprovedSpecId?: string,
	explicitCorpusId?: string,
): EvalRunRecord[] {
	if (!inventory.target) return [];
	const approvedSpecId = chosenApprovedSpecId(inventory, explicitApprovedSpecId);
	if (!approvedSpecId) return [];
	const compatibleCorpora = inventory.corpora.filter((corpus) =>
		corpus.visibility === "development" &&
		inventory.developmentLineage.get(corpus.id)?.publication.approvedSpecId === approvedSpecId
	);
	const focusedCorpus = inventory.validFocus["development-corpus"]?.id;
	const corpus = explicitCorpusId
		? compatibleCorpora.find((item) => item.id === explicitCorpusId) ?? null
		: focusedCorpus && compatibleCorpora.some((item) => item.id === focusedCorpus)
		? compatibleCorpora.find((item) => item.id === focusedCorpus)!
		: compatibleCorpora.length === 1 ? compatibleCorpora[0]! : null;
	if (!corpus) return [];
	const lineage = inventory.developmentLineage.get(corpus.id)!;
	return inventory.developmentEvals.filter((run) =>
		run.target.id === inventory.target!.manifest.id &&
		run.target.gitSha === lineage.currentTargetGitSha &&
		run.datasetHash === lineage.datasetHash &&
		run.suiteHash === lineage.currentSuiteHash &&
		run.summary.error === 0,
	);
}

export function requireDevelopmentEval(
	inventory: WorkbenchInventory,
	explicitId?: string,
	items = compatibleDevelopmentEvals(inventory),
): EvalRunRecord {
	return resolveOne({
		items,
		explicitId,
		focusId: inventory.validFocus["eval-run"]?.id,
		id: (run) => run.evalRunId,
		label: "development EvalRun",
	});
}

/**
 * Evidence to READ, which is a different question from evidence to DECIDE on.
 *
 * `compatibleDevelopmentEvals` demands the run's revision, suite and dataset
 * still match the Target's head, because a proposal may only be argued from a
 * run of the revision it changes. History owes nothing of the sort: one commit
 * in the Target — and the Builder asks for one before it opens a workshop —
 * would otherwise hide every trace the operator had just watched being made.
 * So the only rule left here is that the run measured a published development
 * corpus of the approved Spec; a moved revision and recorded errors stay.
 */
export function readableDevelopmentEvals(
	inventory: WorkbenchInventory,
	explicitApprovedSpecId?: string,
): EvalRunRecord[] {
	if (!inventory.target) return [];
	const approvedSpecId = chosenApprovedSpecId(inventory, explicitApprovedSpecId);
	if (!approvedSpecId) return [];
	const published = new Set(
		[...inventory.developmentLineage.values()]
			.filter((lineage) => lineage.publication.approvedSpecId === approvedSpecId)
			.map((lineage) => lineage.datasetHash),
	);
	// `developmentEvals` already arrives newest first.
	return inventory.developmentEvals.filter((run) =>
		run.target.id === inventory.target!.manifest.id && published.has(run.datasetHash)
	);
}

/** The run `/traces` and `/trace` show: the one named, else the focused one, else the newest. */
export function requireReadableDevelopmentEval(
	inventory: WorkbenchInventory,
	explicitId?: string,
): EvalRunRecord {
	const items = readableDevelopmentEvals(inventory);
	const ids = items.map((run) => run.evalRunId);
	if (explicitId) {
		const exact = items.find((run) => run.evalRunId === explicitId);
		if (!exact) throw new WorkbenchSelectionRequiredError("development EvalRun", ids);
		return exact;
	}
	const focusId = inventory.validFocus["eval-run"]?.id;
	const chosen = items.find((run) => run.evalRunId === focusId) ?? items[0];
	// Several readable runs are never ambiguous — the newest one is the answer —
	// so the only refusal left is a project that has not measured anything yet.
	if (!chosen) throw new WorkbenchSelectionRequiredError("development EvalRun", []);
	return chosen;
}

/** Which evaluation this is, for a reader who did not launch it. */
export function evaluationProjection(
	run: EvalRunRecord,
	corpora: readonly CorpusMetadata[],
	runs: readonly RunRecord[],
): WorkbenchEvaluationProjection {
	const corpus = corpora.find((item) => item.hash === run.datasetHash);
	const stable = stableTasks(runs);
	return {
		evalRunId: run.evalRunId,
		summary: run.summary,
		repetitions: run.repetitions,
		stableTasks: { stable: stable.stable, measured: stable.measured },
		finishedAt: run.finishedAt,
		targetGitSha: run.target.gitSha,
		corpus: corpus ? { name: corpus.name, taskCount: corpus.taskCount } : null,
	};
}

export function requireProposal(
	inventory: WorkbenchInventory,
	status: WorkbenchProposalInventory["status"] | readonly WorkbenchProposalInventory["status"][],
	explicitId?: string,
): WorkbenchProposalInventory {
	const statuses = Array.isArray(status) ? status : [status];
	return resolveOne({
		items: inventory.proposals.filter((proposal) => statuses.includes(proposal.status)),
		explicitId,
		focusId: inventory.validFocus.proposal?.id,
		id: (proposal) => proposal.record.runId,
		label: `${statuses.join("/")} proposal`,
	});
}

export function requireCandidate(
	inventory: WorkbenchInventory,
	statuses: readonly ReturnType<typeof candidateStatus>[],
	explicitId?: string,
): CandidateRecord {
	return resolveOne({
		items: inventory.candidates.filter((candidate) => statuses.includes(candidateStatus(candidate))),
		explicitId,
		focusId: inventory.validFocus.candidate?.id,
		id: (candidate) => candidate.candidateId,
		label: "candidate",
	});
}
