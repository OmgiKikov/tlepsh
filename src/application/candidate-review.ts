import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	ApprovedSpecBuilderInputSchema,
	BuilderApplyReceiptSchema,
	PersistedBuilderRunSchema,
} from "./builder-proposal.js";
import {
	DEVELOPMENT_GATE_POLICY_ID,
	SEALED_GATE_POLICY_ID,
	comparisonGateEvidence,
} from "./candidate-experiment.js";
import { corpusDatasetLabel } from "./corpus-target.js";
import { compareEvalRuns, type CompareResult } from "../compare.js";
import { CandidateProposalSchema } from "../builders/adapters.js";
import { DiagnosisRecordSchema } from "../diagnosis.js";
import {
	CandidateRecordSchema,
	type CandidateArtifactRef,
	candidateStatus,
	transitionCandidate,
	type CandidateRecord,
} from "../domain/candidate.js";
import { TargetManifest } from "../manifest.js";
import { loadEvalRun, loadVerifiedEvalRun, type EvalRunRecord } from "../eval.js";
import { SpecSnapshotSchema } from "../spec.js";
import { canonicalJson, hashValue } from "../provenance.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";

export interface ReviewCandidateOptions {
	runsRoot: string;
	candidateId: string;
	recommendation: "promote" | "reject";
	reason: string;
	actorId?: string;
	now?: () => string;
}

export interface DecideCandidateOptions {
	runsRoot: string;
	candidateId: string;
	reason: string;
	actorId?: string;
	tag?: string;
	now?: () => string;
}

export interface PromoteReviewedCandidateOptions {
	repositoryDir: string;
	runsRoot: string;
	candidateId: string;
	version: string;
	reason: string;
	actorId?: string;
	now?: () => string;
}

export interface PromoteReviewedCandidateResult {
	record: CandidateRecord;
	tag: string;
	candidateSha: string;
}

export function candidateRecordPath(runsRoot: string, candidateId: string): string {
	return resolveContainedArtifactPath(runsRoot, "candidates", candidateId, "candidate.json");
}

export function loadCandidateRecord(runsRoot: string, candidateId: string): CandidateRecord {
	return readJsonArtifact(candidateRecordPath(runsRoot, candidateId), CandidateRecordSchema);
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
	if (baseline.summary.error > 0 || candidate.summary.error > 0) {
		throw new Error(`${label} contains infrastructure errors and is inconclusive`);
	}
	const comparison = compareEvalRuns(runsRoot, baseline.evalRunId, candidate.evalRunId, {
		mode: record.mode,
	});
	if (comparison.status !== "comparable" || comparison.summary.taskCount < 1) {
		throw new Error(comparison.error ?? `${label} contains no comparable task evidence`);
	}
	return comparison;
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
function verifyPromotionEvidence(record: CandidateRecord, runsRoot: string): void {
	const sourceEval = verifyAppliedBuilderOrigin(record, runsRoot);
	const evaluated = record.events.find((event) => event.type === "evaluated");
	if (!evaluated || evaluated.type !== "evaluated") throw new Error("candidate has no evaluated evidence");
	const development = verifyEvaluationPair(runsRoot, record, evaluated.evaluation.development, "development");
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
	const expectedDevelopment = comparisonGateEvidence(
		development,
		DEVELOPMENT_GATE_POLICY_ID,
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
	const comparison = verifyEvaluationPair(runsRoot, record, holdout, "sealed holdout");
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
	const expectedHoldout = comparisonGateEvidence(comparison, SEALED_GATE_POLICY_ID, {
		corpusId: holdout.corpus.id,
		corpusHash: holdout.corpus.hash,
	});
	if (JSON.stringify(holdoutEvidence) !== JSON.stringify(expectedHoldout)) {
		throw new Error("sealed comparison/gate evidence hash or summary mismatch");
	}
	const regressed = comparison.rows.filter((row) => row.delta < 0).map((row) => row.taskId);
	if (regressed.length > 0 || comparison.summary.delta < 0) {
		throw new Error(`sealed holdout regression in persisted evidence: ${regressed.join(", ") || comparison.summary.delta}`);
	}
}

/**
 * Create an annotated Git tag for the exact reviewed candidate and append the
 * canonical promotion event. The aggregate is validated before Git is touched;
 * if durable publication fails, only the tag created by this call is removed.
 */
export function promoteReviewedCandidate(
	options: PromoteReviewedCandidateOptions,
): PromoteReviewedCandidateResult {
	if (!/^\d+\.\d+\.\d+$/.test(options.version)) {
		throw new Error(`invalid semver: ${options.version}`);
	}
	if (!options.reason.trim()) throw new Error("promotion reason must not be blank");
	const repositoryDir = resolve(options.repositoryDir);
	const record = loadCandidateRecord(options.runsRoot, options.candidateId);
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

	const tag = `v${options.version}`;
	const tagExists = spawnSync(
		"git",
		["-C", repositoryDir, "show-ref", "--verify", "--quiet", `refs/tags/${tag}`],
		{ stdio: "ignore" },
	);
	if (tagExists.status === 0) throw new Error(`tag ${tag} already exists`);
	if (tagExists.status !== 1) throw new Error(`cannot verify whether tag ${tag} exists`);

	const at = (options.now ?? (() => new Date().toISOString()))();
	const actorId = options.actorId ?? "local-user";
	const promoted = CandidateRecordSchema.parse(
		previewPromotion(record, { tag, reason: options.reason, actorId, at }),
	);
	const message = JSON.stringify({
		candidateId: record.candidateId,
		targetId: record.targetId,
		candidateSha: candidate.sha,
		reason: options.reason,
	});
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
	try {
		return { record: persist(promoted, options.runsRoot), tag, candidateSha: candidate.sha };
	} catch (error) {
		// The tag did not exist before this call and was created only after every
		// validation gate passed, so compensating deletion cannot remove user data.
		spawnSync("git", ["-C", repositoryDir, "tag", "-d", tag], { stdio: "ignore" });
		throw error;
	}
}
