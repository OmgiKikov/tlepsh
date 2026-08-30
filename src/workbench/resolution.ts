import type { PersistedBuilderRun } from "../application/builder-proposal.js";
import type { BuilderCorpusDraft } from "../application/builder-corpus-draft.js";
import type { CorpusMetadata } from "../corpus.js";
import type { DiagnosisRecord } from "../diagnosis.js";
import { candidateStatus, type CandidateRecord, gateVerdictOf, type ComparisonGateEvidence } from "../domain/candidate.js";
import type { EvalRunRecord } from "../eval.js";
import type { SpecSnapshot } from "../spec.js";
import { redactTraceText } from "../trace.js";
import { WorkbenchSelectionRequiredError } from "./errors.js";
import type {
	WorkbenchInventory,
	WorkbenchProposalInventory,
} from "./inventory.js";
import type {
	WorkbenchCandidateSummary,
	WorkbenchDiagnosisSummary,
	WorkbenchProposalReview, WorkbenchGateProjection } from "./types.js";

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

export function candidateSummary(record: CandidateRecord): WorkbenchCandidateSummary {
	const evaluated = record.events.find((event) => event.type === "evaluated");
	const reviewed = record.events.find((event) => event.type === "reviewed");
	const built = record.events.find((event) => event.type === "built");
	const promoted = record.events.find((event) => event.type === "promoted");
	const rejected = record.events.find((event) => event.type === "rejected");
	return {
		candidateId: record.candidateId,
		status: candidateStatus(record),
		projectId: record.projectId,
		targetId: record.targetId,
		specId: record.specId,
		proposalId: record.proposalId,
		baseline: record.baseline,
		candidate: built?.type === "built" ? built.candidate : null,
		development: evaluated?.type === "evaluated"
			? {
				baselineEvalRunId: evaluated.evaluation.development.baseline.evalRunId,
				candidateEvalRunId: evaluated.evaluation.development.candidate.evalRunId,
				comparison: evaluated.evaluation.development.comparison?.summary ?? null,
				gate: gateProjection(evaluated.evaluation.development.comparison),
			}
			: null,
		sealedHoldout: evaluated?.type === "evaluated"
			? {
				executed: evaluated.evaluation.sealedHoldout !== undefined,
				gatePassed: gateVerdictOf(evaluated.evaluation.sealedHoldout?.comparison) === "pass",
				gate: gateProjection(evaluated.evaluation.sealedHoldout?.comparison),
			}
			: { executed: false, gatePassed: false, gate: null },
		review: reviewed?.type === "reviewed" ? reviewed.review : null,
		promotion: promoted?.type === "promoted"
			? { tag: promoted.decision.tag, reason: promoted.decision.reason, at: promoted.at }
			: null,
		rejection: rejected?.type === "rejected"
			? { reason: rejected.decision.reason, at: rejected.at }
			: null,
	};
}

/** Verdict projection of v3 gate evidence; legacy evidence projects to null. */
function gateProjection(
	evidence: ComparisonGateEvidence | null | undefined,
): WorkbenchGateProjection | null {
	if (!evidence || !("verdict" in evidence)) return null;
	return {
		verdict: evidence.verdict,
		surface: evidence.surface,
		delta: evidence.summary.delta,
		confidence95: { ...evidence.summary.confidence95 },
		tasks: evidence.design.tasks,
		repetitions: evidence.design.repetitions,
		excludedTasks: evidence.design.excludedTasks,
		flags: { ...evidence.flags },
		reasons: [...evidence.reasons],
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

export function compatibleDevelopmentEvals(
	inventory: WorkbenchInventory,
	explicitApprovedSpecId?: string,
	explicitCorpusId?: string,
): EvalRunRecord[] {
	if (!inventory.target) return [];
	const approved = inventory.specs.filter((spec) =>
		spec.status === "approved" && inventory.verifiedApprovedSpecIds.has(spec.id)
	);
	const focusedSpec = inventory.validFocus["approved-spec"]?.id;
	const approvedSpecId = explicitApprovedSpecId ?? (focusedSpec && approved.some((spec) => spec.id === focusedSpec)
		? focusedSpec
		: approved.length === 1 ? approved[0]!.id : null);
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

export function requireProposal(
	inventory: WorkbenchInventory,
	status: WorkbenchProposalInventory["status"],
	explicitId?: string,
): WorkbenchProposalInventory {
	return resolveOne({
		items: inventory.proposals.filter((proposal) => proposal.status === status),
		explicitId,
		focusId: inventory.validFocus.proposal?.id,
		id: (proposal) => proposal.record.runId,
		label: `${status} proposal`,
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
