import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
	ApprovedSpecBuilderInputSchema,
	BuilderApplyReceiptSchema,
	PersistedBuilderRunSchema,
} from "./builder-proposal.js";
import {
	comparisonGateEvidence,
} from "./candidate-experiment.js";
import { screenExclusion } from "./cheap-check.js";
import { corpusDatasetLabel } from "./corpus-target.js";
import { compareEvalRuns, type CompareResult } from "../compare.js";
import { promotableVerdicts, withinInfrastructureBudget, type GateSurface } from "../domain/comparison-gate.js";
import { CandidateProposalSchema } from "../builders/adapters.js";
import { DiagnosisRecordSchema } from "../diagnosis.js";
import {
	CandidateRecordSchema,
	type CandidateArtifactRef,
	type ComparisonGateEvidence,
	candidateStatus,
	isPromotionGradeGateEvidence,
	transitionCandidate,
	type CandidateRecord,
} from "../domain/candidate.js";
import { TargetManifest, type JudgeCalibrationPolicy } from "../manifest.js";
import { judgeEvidenceCalibration } from "./judge-labels.js";
import { judgeCalibrationRefusal } from "../domain/judge-agreement.js";
import { loadEvalRun, loadVerifiedEvalRun, readEvalRunIndex, type EvalRunRecord } from "../eval.js";
import { loadApprovedSpec, SpecSnapshotSchema } from "../spec.js";
import { canonicalJson, hashValue } from "../provenance.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";

export interface ReviewCandidateOptions {
	runsRoot: string;
	candidateId: string;
	/** Exact Candidate aggregate reviewed by a host confirmation, when one exists. */
	expectedCandidateHash?: string;
	/**
	 * Exact proposal artifact displayed by the host. Required for a promote
	 * recommendation when an automated improve/search applied the candidate,
	 * because that earlier authority did not mean the operator read the diff.
	 */
	expectedProposalHash?: string;
	recommendation: "promote" | "reject";
	reason: string;
	actorId?: string;
	now?: () => string;
}

export interface DecideCandidateOptions {
	runsRoot: string;
	candidateId: string;
	/** Exact Candidate aggregate reviewed by a host confirmation, when one exists. */
	expectedCandidateHash?: string;
	reason: string;
	actorId?: string;
	tag?: string;
	now?: () => string;
}

export interface PromoteReviewedCandidateOptions {
	repositoryDir: string;
	runsRoot: string;
	candidateId: string;
	/** Exact Candidate aggregate reviewed by a host confirmation, when one exists. */
	expectedCandidateHash?: string;
	version: string;
	reason: string;
	actorId?: string;
	/**
	 * Where this project's human judge labels live. Required only by a Target
	 * whose manifest sets `evalSuite.judge.requireCalibration`: without it that
	 * policy cannot be evaluated, and an unevaluable promotion policy refuses.
	 */
	stateRoot?: string;
	now?: () => string;
}

export interface PromoteReviewedCandidateResult {
	record: CandidateRecord;
	tag: string;
	candidateSha: string;
}

const PromotionIntentSchema = z.strictObject({
	schemaVersion: z.literal(1),
	candidateBeforeSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
	tag: z.string().regex(/^v\d+\.\d+\.\d+$/),
	candidateSha: z.string().regex(/^[0-9a-f]{40}$/),
	at: z.iso.datetime({ offset: true }),
	actorId: z.string().min(1),
	reason: z.string().min(1),
	tagMessage: z.string().min(1),
	promoted: CandidateRecordSchema,
});
type PromotionIntent = z.infer<typeof PromotionIntentSchema>;

export interface PromoteReviewedCandidateDependencies {
	writeIntent: (path: string, intent: PromotionIntent) => void;
}

const DEFAULT_PROMOTION_DEPENDENCIES: PromoteReviewedCandidateDependencies = {
	writeIntent: (path, intent) => writeJsonArtifact(path, PromotionIntentSchema, intent, { immutable: true }),
};

export function candidateRecordPath(runsRoot: string, candidateId: string): string {
	return resolveContainedArtifactPath(runsRoot, "candidates", candidateId, "candidate.json");
}

export function loadCandidateRecord(runsRoot: string, candidateId: string): CandidateRecord {
	return readJsonArtifact(candidateRecordPath(runsRoot, candidateId), CandidateRecordSchema);
}

function assertExpectedCandidateHash(
	record: CandidateRecord,
	expectedCandidateHash: string | undefined,
	operation: string,
): void {
	if (expectedCandidateHash !== undefined && hashValue(record) !== expectedCandidateHash) {
		throw new Error(`candidate changed after confirmation; ${operation} is stale`);
	}
}

function assertAutomatedProposalWasReviewed(
	record: CandidateRecord,
	expectedProposalHash: string | undefined,
	recommendation: ReviewCandidateOptions["recommendation"],
): void {
	// Rejecting creates no release authority and must remain possible even when a
	// proposal artifact is damaged. A promote recommendation is the boundary at
	// which an automated trial must become an individually reviewed diff.
	if (
		recommendation === "reject" ||
		record.origin.kind !== "applied-builder" ||
		record.origin.application.via === undefined
	) return;
	const proposalHash = record.origin.proposal.sha256;
	if (expectedProposalHash === undefined) {
		throw new Error(
			`candidate ${record.candidateId} was applied by ${record.origin.application.via} without individual diff review; ` +
			`review requires the exact proposal hash ${proposalHash}`,
		);
	}
	if (expectedProposalHash !== proposalHash) {
		throw new Error("proposal changed after confirmation; candidate review is stale");
	}
}

function evaluatedExperimentId(record: CandidateRecord): string {
	const evaluated = record.events.find((event) => event.type === "evaluated");
	if (!evaluated || evaluated.type !== "evaluated") {
		throw new Error(`candidate ${record.candidateId} has no evaluated experiment`);
	}
	return evaluated.evaluation.experimentId;
}

function persist(record: CandidateRecord, runsRoot: string): CandidateRecord {
	const validated = CandidateRecordSchema.parse(record);
	writeJsonArtifact(candidateRecordPath(runsRoot, record.candidateId), CandidateRecordSchema, validated);
	return validated;
}

/** Append an explicit human review. Review never promotes or rejects by itself. */
export function reviewCandidate(options: ReviewCandidateOptions): CandidateRecord {
	const record = loadCandidateRecord(options.runsRoot, options.candidateId);
	assertExpectedCandidateHash(record, options.expectedCandidateHash, "review");
	assertAutomatedProposalWasReviewed(record, options.expectedProposalHash, options.recommendation);
	if (candidateStatus(record) !== "evaluated") {
		throw new Error(`candidate ${record.candidateId} must be evaluated before review`);
	}
	return persist(
		transitionCandidate(record, {
			type: "reviewed",
			eventId: `${record.candidateId}:reviewed:${record.events.length}`,
			at: (options.now ?? (() => new Date().toISOString()))(),
			actor: { kind: "human", id: options.actorId ?? "local-user" },
			review: {
				experimentId: evaluatedExperimentId(record),
				recommendation: options.recommendation,
				reason: options.reason,
			},
		}),
		options.runsRoot,
	);
}

/** Append the human rejection decision after review. */
export function decideCandidateRejection(options: DecideCandidateOptions): CandidateRecord {
	const record = loadCandidateRecord(options.runsRoot, options.candidateId);
	assertExpectedCandidateHash(record, options.expectedCandidateHash, "rejection");
	if (candidateStatus(record) !== "reviewed") {
		throw new Error(`candidate ${record.candidateId} must be reviewed before rejection`);
	}
	return persist(
		transitionCandidate(record, {
			type: "rejected",
			eventId: `${record.candidateId}:rejected:${record.events.length}`,
			at: (options.now ?? (() => new Date().toISOString()))(),
			actor: { kind: "human", id: options.actorId ?? "local-user" },
			decision: { experimentId: evaluatedExperimentId(record), reason: options.reason },
		}),
		options.runsRoot,
	);
}

/**
 * Validate and append a human promotion decision. The caller owns creating
 * the Git tag first; this function refuses A/A, missing holdout evidence, or
 * a review that recommended rejection through the aggregate invariants.
 */
export function decideCandidatePromotion(options: DecideCandidateOptions & { tag: string }): CandidateRecord {
	const record = loadCandidateRecord(options.runsRoot, options.candidateId);
	assertExpectedCandidateHash(record, options.expectedCandidateHash, "promotion decision");
	if (candidateStatus(record) !== "reviewed") {
		throw new Error(`candidate ${record.candidateId} must be reviewed before promotion`);
	}
	verifyPromotionEvidence(record, options.runsRoot);
	const built = record.events.find((event) => event.type === "built");
	if (!built || built.type !== "built") throw new Error(`candidate ${record.candidateId} has no built revision`);
	return persist(
		transitionCandidate(record, {
			type: "promoted",
			eventId: `${record.candidateId}:promoted:${record.events.length}`,
			at: (options.now ?? (() => new Date().toISOString()))(),
			actor: { kind: "human", id: options.actorId ?? "local-user" },
			decision: {
				experimentId: evaluatedExperimentId(record),
				candidate: built.candidate,
				tag: options.tag,
				reason: options.reason,
			},
		}),
		options.runsRoot,
	);
}

function git(repositoryDir: string, args: string[]): string {
	return execFileSync("git", ["-C", repositoryDir, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function builtRevision(record: CandidateRecord): { ref: string; sha: string } {
	const built = record.events.find((event) => event.type === "built");
	if (!built || built.type !== "built") throw new Error(`candidate ${record.candidateId} has no built revision`);
	return built.candidate;
}

function previewPromotion(
	record: CandidateRecord,
	options: { tag: string; reason: string; actorId: string; at: string },
): CandidateRecord {
	const candidate = builtRevision(record);
	return transitionCandidate(record, {
		type: "promoted",
		eventId: `${record.candidateId}:promoted:${record.events.length}`,
		at: options.at,
		actor: { kind: "human", id: options.actorId },
		decision: {
			experimentId: evaluatedExperimentId(record),
			candidate,
			tag: options.tag,
			reason: options.reason,
		},
	});
}

function verifyEvaluationPair(
	runsRoot: string,
	record: CandidateRecord,
	pair: {
		baseline: { evalRunId: string; harness: { sha: string } };
		candidate: { evalRunId: string; harness: { sha: string } };
	},
	label: string,
	surface: GateSurface,
): CompareResult {
	const baseline = loadEvalRun(runsRoot, pair.baseline.evalRunId);
	const candidate = loadEvalRun(runsRoot, pair.candidate.evalRunId);
	for (const [side, evidence] of [["baseline", baseline], ["candidate", candidate]] as const) {
		if (!evidence.target.toolsetHash) {
			throw new Error(`${label} ${side} lacks a hash-anchored Target toolset and is legacy, non-promotable evidence`);
		}
		if (!evidence.target.workspaceHash) {
			throw new Error(`${label} ${side} lacks a hash-anchored Target workspace and is legacy, non-promotable evidence`);
		}
		if (!evidence.target.preparedToolHomeHash) {
			throw new Error(`${label} ${side} lacks a hash-anchored prepared tool home and is legacy, non-promotable evidence`);
		}
		const execution = evidence.provenance.execution;
		const processCapableTools = execution.tools.filter((tool) =>
			!["read", "edit", "write"].includes(tool),
		);
		if (
			execution.workspace !== "isolated-copy-v1" ||
			execution.filesystem !== "workspace-confined-v1" ||
			execution.sandbox === "unavailable" ||
			(processCapableTools.length > 0 && execution.sandbox === "none")
		) {
			throw new Error(
				`${label} ${side} uses non-promotable execution confinement: ` +
				`${execution.workspace}/${execution.filesystem}/${execution.sandbox}`,
			);
		}
	}
	if (baseline.target.id !== record.targetId || candidate.target.id !== record.targetId) {
		throw new Error(`${label} evidence belongs to a different target`);
	}
	if (baseline.target.gitSha !== pair.baseline.harness.sha || candidate.target.gitSha !== pair.candidate.harness.sha) {
		throw new Error(`${label} eval artifacts do not match CandidateRecord harness revisions`);
	}
	if (candidate.baselineEvalRunId !== baseline.evalRunId) {
		throw new Error(`${label} candidate eval is not linked to its recorded baseline`);
	}
	if (
		!withinInfrastructureBudget(baseline.summary.error, baseline.summary.total) ||
		!withinInfrastructureBudget(candidate.summary.error, candidate.summary.total)
	) {
		throw new Error(`${label} contains infrastructure errors over the budget and is inconclusive`);
	}
	const comparison = compareEvalRuns(runsRoot, baseline.evalRunId, candidate.evalRunId, {
		mode: record.mode,
		surface,
	});
	const usable = comparison.status === "comparable" || (
		comparison.status === "inconclusive" &&
		withinInfrastructureBudget(comparison.design.excludedTasks, comparison.design.tasks + comparison.design.excludedTasks)
	);
	if (!usable || comparison.summary.taskCount < 1) {
		throw new Error(comparison.error ?? `${label} contains no comparable task evidence`);
	}
	return comparison;
}

/**
 * Only `exact-comparison-gate-v4` evidence — paired mean grader scores — can
 * back a promotion. Everything older stays readable and is named exactly, so
 * the operator knows the candidate must be verified again rather than patched.
 */
function legacyEvidenceMessage(surface: GateSurface, evidence: ComparisonGateEvidence): string {
	const version = "schemaVersion" in evidence ? `v${evidence.schemaVersion}` : "v1";
	return `${surface} comparison uses legacy ${version} gate evidence and is not promotion-grade: ` +
		"re-verify the candidate to record exact-comparison-gate-v4 evidence";
}

const MAX_PROVENANCE_ARTIFACT_BYTES = 16 * 1024 * 1024;

function verifyArtifact(
	ref: CandidateArtifactRef,
	label: string,
	expectedPath?: string,
): void {
	const path = resolve(ref.path);
	const entry = lstatSync(path);
	if (entry.isSymbolicLink() || !entry.isFile()) {
		throw new Error(`${label} must remain a regular non-symlink artifact`);
	}
	const canonicalPath = realpathSync(path);
	if (expectedPath && canonicalPath !== realpathSync(resolve(expectedPath))) {
		throw new Error(`${label} path mismatch: expected ${resolve(expectedPath)}, recorded ${path}`);
	}
	if (entry.size > MAX_PROVENANCE_ARTIFACT_BYTES) {
		throw new Error(`${label} exceeds the provenance verification limit`);
	}
	const actual = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
	if (actual !== ref.sha256) {
		throw new Error(`${label} hash mismatch: expected ${ref.sha256}, got ${actual}`);
	}
}

function verifyAppliedBuilderOrigin(record: CandidateRecord, runsRootInput: string): EvalRunRecord | null {
	if (record.origin.kind !== "applied-builder") {
		throw new Error("production promotion requires reconstructable applied-Builder provenance");
	}
	const runsRoot = resolve(runsRootInput);
	const origin = record.origin;
	const builderArtifact = (name: string) => resolveContainedArtifactPath(runsRoot, "builders", origin.builderRunId, name);
	verifyArtifact(origin.builderRun, "Builder run", builderArtifact("builder_run.json"));
	verifyArtifact(origin.builderInput, "Builder input", builderArtifact("builder_input.txt"));
	verifyArtifact(origin.proposal, "Builder proposal", builderArtifact("proposal.json"));
	verifyArtifact(origin.applyReceipt, "Builder apply receipt", builderArtifact("apply_receipt.json"));
	if (origin.source) {
		verifyArtifact(
			origin.source.evalRun,
			"Builder source eval",
			resolveContainedArtifactPath(runsRoot, origin.source.evalRunId, "eval_run.json"),
		);
		verifyArtifact(
			origin.source.diagnosis,
			"Builder diagnosis",
			resolveContainedArtifactPath(runsRoot, origin.source.evalRunId, "diagnosis.json"),
		);
	}
	verifyArtifact(origin.approvedSpec.artifact, "approved Spec");

	const builderRun = readJsonArtifact(origin.builderRun.path, PersistedBuilderRunSchema);
	let builderInput: ReturnType<typeof ApprovedSpecBuilderInputSchema.parse>;
	try {
		builderInput = ApprovedSpecBuilderInputSchema.parse(
			JSON.parse(readFileSync(origin.builderInput.path, "utf8")) as unknown,
		);
	} catch (error) {
		throw new Error("Builder input is not reconstructable typed approved-Spec evidence", { cause: error });
	}
	const proposal = readJsonArtifact(origin.proposal.path, CandidateProposalSchema);
	const receipt = readJsonArtifact(origin.applyReceipt.path, BuilderApplyReceiptSchema);
	const verifiedSourceEval = origin.source
		? loadVerifiedEvalRun(runsRoot, origin.source.evalRunId)
		: null;
	if (verifiedSourceEval && !verifiedSourceEval.hasRunHashes) {
		throw new Error("Builder source eval must hash-anchor every member run before promotion");
	}
	const sourceEval = verifiedSourceEval?.record ?? null;
	const diagnosis = origin.source
		? readJsonArtifact(origin.source.diagnosis.path, DiagnosisRecordSchema)
		: null;
	const spec = readJsonArtifact(origin.approvedSpec.artifact.path, SpecSnapshotSchema);

	if (
		builderRun.runId !== origin.builderRunId ||
		builderRun.result.status !== "completed" ||
		!builderRun.artifacts.proposal ||
		builderRun.artifacts.proposal.sha256 !== origin.proposal.sha256 ||
		builderRun.artifacts.input.sha256 !== origin.builderInput.sha256 ||
		builderRun.request.baseTargetSha !== origin.application.baseTargetSha ||
		builderRun.request.provenanceMode !== "canonical"
	) throw new Error("Builder run no longer attributes the exact recorded proposal");
	if (
		builderRun.request.approvedSpec === null ||
		builderRun.request.approvedSpec.specId !== origin.approvedSpec.specId ||
		builderRun.request.approvedSpec.projectId !== origin.approvedSpec.projectId ||
		builderRun.request.approvedSpec.specContentHash !== origin.approvedSpec.specContentHash ||
		builderRun.request.approvedSpec.snapshotHash !== origin.approvedSpec.snapshotHash
	) throw new Error("Builder input no longer references the exact approved Spec");
	if (
		canonicalJson(builderInput.approvedSpec.reference) !== canonicalJson(builderRun.request.approvedSpec) ||
		canonicalJson(builderInput.evaluationEvidence?.source ?? null) !== canonicalJson(builderRun.request.source) ||
		canonicalJson(builderInput.evaluationEvidence?.sourceAttestation ?? null) !== canonicalJson(builderRun.request.sourceAttestation)
	) throw new Error("typed Builder input no longer matches its recorded Spec/source references");
	const failureBundle = builderInput.evaluationEvidence?.failureBundle ?? null;
	const failureBundleHash = failureBundle === null
		? null
		: `sha256:${createHash("sha256").update(failureBundle).digest("hex")}`;
	const failureBundleBytes = failureBundle === null ? 0 : Buffer.byteLength(failureBundle, "utf8");
	if (
		failureBundleHash !== builderRun.request.failureBundleSha256 ||
		failureBundleBytes !== builderRun.request.failureBundleBytes ||
		Buffer.byteLength(readFileSync(origin.builderInput.path)) !== builderRun.request.builderInputBytes
	) throw new Error("typed Builder input no longer matches its recorded evidence bytes");
	if (
		builderRun.result.proposal === null ||
		JSON.stringify(builderRun.result.proposal) !== JSON.stringify(proposal) ||
		proposal.decision !== "propose"
	) throw new Error("Builder proposal artifact no longer matches the completed Builder result");
	if (origin.source === null) {
		if (builderRun.request.source !== null || builderRun.request.sourceAttestation !== null) {
			throw new Error("Builder run unexpectedly claims source evidence absent from CandidateRecord");
		}
	} else {
		const attestation = builderRun.request.sourceAttestation;
		if (
			!builderRun.request.source ||
			!attestation ||
			builderRun.request.source.evalRunId !== origin.source.evalRunId ||
			builderRun.request.source.diagnosisId !== origin.source.diagnosisId ||
			attestation.evalRunId !== origin.source.evalRunId ||
			attestation.diagnosisId !== origin.source.diagnosisId ||
			attestation.evalRunSha256 !== origin.source.evalRun.sha256 ||
			attestation.diagnosisSha256 !== origin.source.diagnosis.sha256 ||
			attestation.dataset !== origin.source.dataset ||
			attestation.datasetHash !== origin.source.datasetHash ||
			attestation.suiteHash !== origin.source.suiteHash ||
			canonicalJson(attestation.developmentCorpus) !== canonicalJson(origin.source.developmentCorpus)
		) throw new Error("Builder run source evidence is misattributed");
	}
	if (
		proposal.baseTargetSha !== origin.application.baseTargetSha ||
		receipt.runId !== origin.builderRunId ||
		receipt.proposalSha256 !== origin.proposal.sha256 ||
		receipt.baseTargetSha !== origin.application.baseTargetSha ||
		receipt.candidateSha !== origin.application.candidateSha ||
		receipt.actor.id !== origin.application.actor.id ||
		// A candidate cannot quietly lose the fact that a loop applied it, nor
		// gain the claim that a human read the diff.
		receipt.via !== origin.application.via ||
		receipt.reason !== origin.application.reason ||
		receipt.appliedAt !== origin.application.appliedAt ||
		JSON.stringify([...receipt.paths].sort()) !== JSON.stringify(proposal.changes.map((change) => change.path).sort())
	) throw new Error("Builder apply receipt no longer matches CandidateRecord provenance");
	const validated = record.events.find((event) => event.type === "validated");
	if (
		!validated ||
		validated.type !== "validated" ||
		JSON.stringify([...validated.scope.changedFiles].sort()) !== JSON.stringify([...receipt.paths].sort())
	) throw new Error("validated candidate diff no longer matches the exact Builder apply receipt paths");
	if (origin.source && sourceEval && diagnosis) {
		const attestation = builderRun.request.sourceAttestation;
		if (!attestation) throw new Error("Builder source attestation disappeared before promotion");
		if (
			sourceEval.evalRunId !== origin.source.evalRunId ||
			sourceEval.target.id !== record.targetId ||
			sourceEval.target.gitSha !== origin.application.baseTargetSha ||
			sourceEval.dataset !== origin.source.dataset ||
			sourceEval.datasetHash !== origin.source.datasetHash ||
			sourceEval.suiteHash !== origin.source.suiteHash ||
			attestation.targetId !== sourceEval.target.id ||
			attestation.targetGitSha !== sourceEval.target.gitSha
		) throw new Error("Builder source eval is misattributed to another target or revision");
		if (
			diagnosis.diagnosisId !== origin.source.diagnosisId ||
			diagnosis.evalRunId !== origin.source.evalRunId ||
			diagnosis.targetId !== record.targetId ||
			diagnosis.targetRevision !== origin.application.baseTargetSha
		) throw new Error("Builder diagnosis is misattributed to another eval or target");
	}
	if (
		spec.id !== origin.approvedSpec.specId ||
		spec.projectId !== origin.approvedSpec.projectId ||
		spec.status !== "approved" ||
		hashValue(spec.spec) !== origin.approvedSpec.specContentHash ||
		hashValue(spec) !== origin.approvedSpec.snapshotHash
	) throw new Error("approved Spec identity or status no longer matches CandidateRecord provenance");
	return sourceEval;
}

/** Re-read referenced eval/run artifacts before any promotion side effect. */
/**
 * A cheap-check screen is a one-repetition, candidate-only run of the cases
 * that already failed. It exists to save money, never to prove anything, so it
 * can never reach a promotion — not as an arm, not as a source eval.
 */
function assertNoScreenEvidence(record: CandidateRecord, runsRoot: string): void {
	const exclusion = screenExclusion(runsRoot);
	const cited = new Set<string>();
	const evaluated = record.events.find((event) => event.type === "evaluated");
	if (evaluated?.type === "evaluated") {
		const { development, sealedHoldout } = evaluated.evaluation;
		cited.add(development.baseline.evalRunId);
		cited.add(development.candidate.evalRunId);
		if (sealedHoldout) {
			cited.add(sealedHoldout.baseline.evalRunId);
			cited.add(sealedHoldout.candidate.evalRunId);
		}
	}
	if (record.origin.kind === "applied-builder" && record.origin.source) {
		cited.add(record.origin.source.evalRunId);
	}
	// The EvalRun's own `purpose` is the first answer, so a screen whose sidecar
	// never got written is still refused. The sidecar is the second, and an
	// unreadable one refuses everything it might name.
	const offending = [...cited].filter((evalRunId) => {
		if (exclusion.blocksEverything || exclusion.ids.has(evalRunId)) return true;
		try {
			return readEvalRunIndex(runsRoot, evalRunId).purpose !== "evidence";
		} catch {
			return false;
		}
	}).sort();
	if (offending.length > 0) {
		throw new Error(
			`promotion refused: ${offending.join(", ")} includes a cheap-check screen, which is never promotion evidence, ` +
			"or an ambiguous legacy one-arm run, which must be rerun" +
			(exclusion.unreadable.length > 0
				? ` (${exclusion.unreadable.length} screen marker(s) could not be read, so nothing they might name is admitted)`
				: ""),
		);
	}
}

function verifyPromotionEvidence(record: CandidateRecord, runsRoot: string): void {
	assertNoScreenEvidence(record, runsRoot);
	const sourceEval = verifyAppliedBuilderOrigin(record, runsRoot);
	const evaluated = record.events.find((event) => event.type === "evaluated");
	if (!evaluated || evaluated.type !== "evaluated") throw new Error("candidate has no evaluated evidence");
	const development = verifyEvaluationPair(runsRoot, record, evaluated.evaluation.development, "development", "development");
	if (sourceEval && (
		development.a.dataset !== sourceEval.dataset ||
		development.b.dataset !== sourceEval.dataset ||
		development.a.datasetHash !== sourceEval.datasetHash ||
		development.b.datasetHash !== sourceEval.datasetHash ||
		development.a.suiteHash !== sourceEval.suiteHash ||
		development.b.suiteHash !== sourceEval.suiteHash
	)) {
		throw new Error(
			"development eval artifacts do not match the exact Builder source surface " +
				`${sourceEval.dataset}/${sourceEval.datasetHash}/${sourceEval.suiteHash}`,
		);
	}
	const developmentCorpus = evaluated.evaluation.development.corpus ?? null;
	if (
		record.origin.kind === "applied-builder" &&
		record.origin.source &&
		canonicalJson(developmentCorpus) !== canonicalJson(record.origin.source.developmentCorpus)
	) {
		throw new Error("development corpus identity no longer matches the canonical Builder source attestation");
	}
	if (developmentCorpus) {
		const expectedDataset = corpusDatasetLabel("development", developmentCorpus.id);
		if (
			development.a.dataset !== expectedDataset ||
			development.b.dataset !== expectedDataset ||
			development.a.datasetHash !== developmentCorpus.hash ||
			development.b.datasetHash !== developmentCorpus.hash
		) {
			throw new Error(
				`development eval artifacts do not match corpus ${developmentCorpus.id}/${developmentCorpus.hash}`,
			);
		}
	} else if (/^development-corpus-[0-9a-f]{64}$/.test(development.a.dataset)) {
		throw new Error("development corpus-backed eval evidence is missing exact corpus identity");
	}
	const developmentEvidence = evaluated.evaluation.development.comparison;
	if (!developmentEvidence) throw new Error("development comparison evidence is not reconstructable");
	if (!isPromotionGradeGateEvidence(developmentEvidence)) {
		throw new Error(legacyEvidenceMessage("development", developmentEvidence));
	}
	const expectedDevelopment = comparisonGateEvidence(
		development,
		developmentCorpus
			? { corpusId: developmentCorpus.id, corpusHash: developmentCorpus.hash }
			: {},
	);
	if (JSON.stringify(developmentEvidence) !== JSON.stringify(expectedDevelopment)) {
		throw new Error("development comparison/gate evidence hash or summary mismatch");
	}
	const holdout = evaluated.evaluation.sealedHoldout;
	if (!holdout) throw new Error("promotion requires sealed-holdout evidence");
	if (!holdout.corpus) throw new Error("sealed holdout is missing exact corpus identity");
	const comparison = verifyEvaluationPair(runsRoot, record, holdout, "sealed holdout", "sealed");
	if (
		comparison.a.datasetHash !== holdout.corpus.hash ||
		comparison.b.datasetHash !== holdout.corpus.hash ||
		comparison.a.dataset !== corpusDatasetLabel("sealed", holdout.corpus.id) ||
		comparison.b.dataset !== corpusDatasetLabel("sealed", holdout.corpus.id)
	) {
		throw new Error(
			`sealed eval artifacts do not match corpus ${holdout.corpus.id}/${holdout.corpus.hash}: ` +
			`${comparison.a.dataset}/${comparison.a.datasetHash} vs ${comparison.b.dataset}/${comparison.b.datasetHash}`,
		);
	}
	const holdoutEvidence = holdout.comparison;
	if (!holdoutEvidence) throw new Error("sealed comparison evidence is not reconstructable");
	if (!isPromotionGradeGateEvidence(holdoutEvidence)) {
		throw new Error(legacyEvidenceMessage("sealed", holdoutEvidence));
	}
	const expectedHoldout = comparisonGateEvidence(comparison, {
		corpusId: holdout.corpus.id,
		corpusHash: holdout.corpus.hash,
	});
	if (JSON.stringify(holdoutEvidence) !== JSON.stringify(expectedHoldout)) {
		throw new Error("sealed comparison/gate evidence hash or summary mismatch");
	}
	if (!promotableVerdicts(developmentEvidence.verdict, holdoutEvidence.verdict)) {
		throw new Error(
			`promotion refused by the comparison gate: development ${developmentEvidence.verdict}, sealed ${holdoutEvidence.verdict}`,
		);
	}
}

/** Every eval run this promotion rests on, development and sealed alike. */
function promotionEvalRunIds(record: CandidateRecord): string[] {
	const evaluated = record.events.find((event) => event.type === "evaluated");
	if (evaluated?.type !== "evaluated") return [];
	const holdout = evaluated.evaluation.sealedHoldout;
	return [
		evaluated.evaluation.development.candidate.evalRunId,
		...(holdout ? [holdout.candidate.evalRunId] : []),
	];
}

/**
 * A judge nobody has checked is an opinion, and `requireCalibration` is a
 * project saying it will not promote on one. The policy reads only grader spec
 * hashes — never sealed content — and it refuses rather than guesses when the
 * labels it would need cannot be reached at all.
 */
function assertJudgeCalibrated(
	policy: JudgeCalibrationPolicy | undefined,
	record: CandidateRecord,
	options: { runsRoot: string; stateRoot?: string },
): void {
	if (!policy) return;
	if (!options.stateRoot) {
		throw new Error(
			"promotion refused: evalSuite.judge.requireCalibration is set but this promotion has no label store to check it against",
		);
	}
	const approvedSpec = record.origin.kind === "applied-builder"
		? {
			projectId: record.origin.approvedSpec.projectId,
			specId: record.origin.approvedSpec.specId,
			specContentHash: record.origin.approvedSpec.specContentHash,
			snapshotHash: record.origin.approvedSpec.snapshotHash,
		}
		: record.specId
			? loadApprovedSpec({ stateRoot: options.stateRoot, projectId: record.projectId, specId: record.specId }).reference
			: undefined;
	const calibration = judgeEvidenceCalibration({
		runsRoot: options.runsRoot,
		stateRoot: options.stateRoot,
		projectId: record.projectId,
		evalRunIds: promotionEvalRunIds(record),
		// A human who was shown the first user turn and the last assistant reply
		// graded a different object from the judge, who was shown the rubric, the
		// assertions, the reference answer and — on a conversation — every turn.
		// Those labels stay on disk and stay readable; they just do not certify
		// this judge unless the Target says in writing that they may.
		includeLegacyLabels: policy.allowLegacyLabels === true,
		requireBoundLineage: true,
		...(approvedSpec ? { approvedSpec } : {}),
	});
	const refusal = judgeCalibrationRefusal(policy, {
		judgeGraderSpecs: Math.max(calibration.specHashes.length, calibration.instruments.length),
		stats: calibration.stats,
		byGraderSpec: calibration.instruments.map((instrument) => ({
			graderSpecHash: instrument.graderSpecHash,
			judgeFingerprintHash: instrument.judgeFingerprintHash,
			stats: instrument.stats,
		})),
	});
	if (refusal) {
		const legacy = policy.allowLegacyLabels !== true && calibration.legacyLabels > 0
			? ` ${calibration.legacyLabels} older label(s) were not counted: they were written before the labelling screen ` +
				"showed the judge's own subject. Re-label them, or set evalSuite.judge.requireCalibration.allowLegacyLabels: true."
			: "";
		const unbound = calibration.unboundLabels > 0
			? ` ${calibration.unboundLabels} label(s) were not counted because they lack an exact approved-Spec/eval-lineage receipt.`
			: "";
		const mismatched = calibration.lineageMismatchLabels > 0
			? ` ${calibration.lineageMismatchLabels} label(s) belong to another approved Spec or eval lineage.`
			: "";
		const repeats = calibration.stats?.duplicateLabels
			? ` ${calibration.stats.duplicateLabels} repeated label(s) were ignored.`
			: "";
		const conflicts = calibration.stats?.conflictedSubjects
			? ` ${calibration.stats.conflictedSubjects} conflicting subject(s) were excluded fail-closed.`
			: "";
		throw new Error(
			`promotion refused: ${refusal}.${legacy}${unbound}${mismatched}${repeats}${conflicts} ` +
				"Run `ahde label <evalRunId> --target <dir>` and grade the judge before promoting.",
		);
	}
}

/**
 * Create an annotated Git tag for the exact reviewed candidate and append the
 * canonical promotion event. The aggregate is validated before Git is touched;
 * if durable publication fails, only the tag created by this call is removed.
 */
export function promoteReviewedCandidate(
	options: PromoteReviewedCandidateOptions,
	dependencies: Partial<PromoteReviewedCandidateDependencies> = {},
): PromoteReviewedCandidateResult {
	const deps = { ...DEFAULT_PROMOTION_DEPENDENCIES, ...dependencies };
	if (!/^\d+\.\d+\.\d+$/.test(options.version)) {
		throw new Error(`invalid semver: ${options.version}`);
	}
	if (!options.reason.trim()) throw new Error("promotion reason must not be blank");
	const repositoryDir = resolve(options.repositoryDir);
	const record = loadCandidateRecord(options.runsRoot, options.candidateId);
	assertExpectedCandidateHash(record, options.expectedCandidateHash, "promotion");
	if (candidateStatus(record) !== "reviewed") {
		throw new Error(`candidate ${record.candidateId} must be reviewed before promotion`);
	}
	const candidate = builtRevision(record);
	const resolvedCommit = git(repositoryDir, ["rev-parse", "--verify", `${candidate.sha}^{commit}`]);
	if (resolvedCommit !== candidate.sha) {
		throw new Error(`candidate commit mismatch: expected ${candidate.sha}, resolved ${resolvedCommit}`);
	}
	const manifestResult = TargetManifest.safeParse(
		parseYaml(git(repositoryDir, ["show", `${candidate.sha}:manifest.yaml`])),
	);
	if (!manifestResult.success) {
		throw new Error(`candidate manifest.yaml is invalid: ${manifestResult.error.message}`);
	}
	if (manifestResult.data.id !== record.targetId) {
		throw new Error(
			`candidate target mismatch: record=${record.targetId}, commit=${manifestResult.data.id}`,
		);
	}
	verifyPromotionEvidence(record, options.runsRoot);
	assertJudgeCalibrated(manifestResult.data.evalSuite.judge?.requireCalibration, record, {
		runsRoot: options.runsRoot,
		...(options.stateRoot ? { stateRoot: options.stateRoot } : {}),
	});

	const tag = `v${options.version}`;
	const intentPath = resolveContainedArtifactPath(
		options.runsRoot,
		"candidates",
		record.candidateId,
		"promotion_intent.json",
	);
	const existingIntent = existsSync(intentPath)
		? readJsonArtifact(intentPath, PromotionIntentSchema)
		: null;
	const tagExists = spawnSync(
		"git",
		["-C", repositoryDir, "show-ref", "--verify", "--quiet", `refs/tags/${tag}`],
		{ stdio: "ignore" },
	);
	if (tagExists.status === 0 && !existingIntent) throw new Error(`tag ${tag} already exists`);
	if (tagExists.status !== 0 && tagExists.status !== 1) throw new Error(`cannot verify whether tag ${tag} exists`);

	const actorId = options.actorId ?? "local-user";
	const at = existingIntent?.at ?? (options.now ?? (() => new Date().toISOString()))();
	const promoted = CandidateRecordSchema.parse(
		previewPromotion(record, { tag, reason: options.reason, actorId, at }),
	);
	const message = JSON.stringify({
		candidateId: record.candidateId,
		targetId: record.targetId,
		candidateSha: candidate.sha,
		reason: options.reason,
	});
	const intent = PromotionIntentSchema.parse({
		schemaVersion: 1,
		candidateBeforeSha256: hashValue(record),
		tag,
		candidateSha: candidate.sha,
		at,
		actorId,
		reason: options.reason,
		tagMessage: message,
		promoted,
	});
	if (existingIntent) {
		if (canonicalJson(existingIntent) !== canonicalJson(intent)) {
			throw new Error("promotion retry does not match its durable pre-tag intent");
		}
	} else {
		deps.writeIntent(intentPath, intent);
	}

	if (tagExists.status === 0) {
		const tagRef = `refs/tags/${tag}`;
		if (
			git(repositoryDir, ["cat-file", "-t", tagRef]) !== "tag" ||
			git(repositoryDir, ["rev-parse", `${tagRef}^{commit}`]) !== candidate.sha ||
			git(repositoryDir, ["for-each-ref", "--format=%(contents)", tagRef]) !== message
		) throw new Error("durable promotion intent collides with a changed or unrelated tag");
	} else {
		git(repositoryDir, [
			"-c",
			"user.name=AHDE human gate",
			"-c",
			"user.email=ahde@local",
			"tag",
			"-a",
			tag,
			"-m",
			message,
			candidate.sha,
		]);
	}
	try {
		const result = { record: persist(promoted, options.runsRoot), tag, candidateSha: candidate.sha };
		try { unlinkSync(intentPath); } catch { /* Tag and Candidate record are already consistent. */ }
		return result;
	} catch (error) {
		// The tag did not exist before this call and was created only after every
		// validation gate passed, so compensating deletion cannot remove user data.
		const rollback = spawnSync("git", ["-C", repositoryDir, "tag", "-d", tag], { stdio: "ignore" });
		if (rollback.status === 0) {
			try { unlinkSync(intentPath); } catch { /* Preserve the persistence failure. */ }
		}
		throw error;
	}
}
