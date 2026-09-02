import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	listBuilderCorpusDrafts,
	type BuilderCorpusDraft,
} from "../application/builder-corpus-draft.js";
import { loadBuilderCorpusImportReceiptForDraft } from "../application/builder-corpus-import.js";
import {
	builderDiscardReceiptPath,
	describeBuilderProposalDiscard,
	loadBuilderDiscardReceipt,
} from "../application/builder-discard.js";
import {
	builderApplyIntentPath,
	listBuilderProposalAdmissions,
	loadBuilderApplyIntent,
	loadBuilderApplyReceipt,
	loadBuilderProposalRunEnvelope,
	verifyBuilderProposalRunEvidence,
	type PersistedBuilderRun,
} from "../application/builder-proposal.js";
import { loadBuilderProposalDecisionClaim } from "../application/builder-proposal-decision.js";
import {
	loadDevelopmentCorpusPublicationReceipt,
	loadSpecApprovalReceipt,
} from "../application/builder-authoring.js";
import { loadCandidateRecord } from "../application/candidate-review.js";
import { targetWithDevelopmentCorpus } from "../application/corpus-target.js";
import {
	loadTargetAdoptionReceiptIfPresent,
	type TargetAdoptionReceipt,
} from "../application/target-adoption.js";
import {
	loadCycleContinuationReceipt,
	type CycleContinuationReceipt,
} from "./cycle-continuation.js";
import { targetBootstrapRequired, toolCredentialReadiness } from "../target/readiness.js";
import { standInFilesLine, standInManifestFields } from "../target/placeholders.js";
import { listCorpora, loadCorpus, type CorpusMetadata } from "../corpus.js";
import {
	candidateStatus,
	type CandidateArtifactRef,
	type CandidateRecord,
} from "../domain/candidate.js";
import { SEALED_GATE_POLICY } from "../domain/comparison-gate.js";
import { workbenchDecisionStages } from "./transition-policy.js";
import {
	isSealedEvalRun,
	listEvalRunIndexesLenient,
	loadEvalRun,
	type EvalRunRecord,
} from "../eval.js";
import { loadTarget, type ResolvedTarget } from "../manifest.js";
import { canonicalJson, hashFile, hashValue } from "../provenance.js";
import {
	listSpecSnapshots,
	type ApprovedSpecReference,
	type SpecSnapshot,
} from "../spec.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";
import {
	loadWorkbenchFocus,
	type WorkbenchFocus,
	type WorkbenchFocusEntry,
} from "./focus.js";
import {
	loadWorkbenchCorpusPublication,
	type WorkbenchCorpusPublication,
} from "./corpus-publication.js";
import {
	loadCandidateAbandonment,
	type CandidateAbandonmentReceipt,
} from "./candidate-abandonment.js";
import { calibrationProjection } from "./calibration.js";
import { plural } from "../i18n.js";
import type {
	WorkbenchBlockerReason,
	WorkbenchCalibrationProjection,
	WorkbenchSelectionKind,
	WorkbenchSelectionSummary,
	WorkbenchStage,
	WorkbenchView,
} from "./types.js";

const MAX_VIEW_ITEMS = 50;
const MAX_PROPOSAL_BYTES = 4 * 1024 * 1024;

export interface WorkbenchProposalInventory {
	record: PersistedBuilderRun;
	status: "open" | "apply-pending" | "discard-pending" | "applied" | "discarded";
}

export interface WorkbenchDevelopmentLineage {
	publication: WorkbenchCorpusPublication;
	datasetHash: string;
	currentSuiteHash: string | null;
	currentTargetGitSha: string | null;
}

export interface WorkbenchInventory {
	projectDir: string;
	stateRoot: string;
	runsRoot: string;
	projectId: string;
	target: ResolvedTarget | null;
	specs: SpecSnapshot[];
	corpusDrafts: BuilderCorpusDraft[];
	corpora: CorpusMetadata[];
	approvedDraftSpecIds: Set<string>;
	verifiedApprovedSpecIds: Set<string>;
	verifiedApprovedSpecReferences: Map<string, ApprovedSpecReference>;
	developmentLineage: Map<string, WorkbenchDevelopmentLineage>;
	developmentEvals: EvalRunRecord[];
	proposals: WorkbenchProposalInventory[];
	candidates: CandidateRecord[];
	/** A/A calibration records of this project, newest first. Never workflow. */
	calibrations: CandidateRecord[];
	abandonedCandidates: Map<string, CandidateAbandonmentReceipt>;
	/** Promoted candidates whose exact revision became the active Target branch head. */
	adoptedCandidates: Map<string, TargetAdoptionReceipt>;
	/** Terminal candidates whose reviewed loop was explicitly closed by a human. */
	continuedCandidates: Map<string, CycleContinuationReceipt>;
	/**
	 * Host-only verification of the private exam. The model sees only this
	 * coarse result; corpus identity, paths, content, hashes, and failure details
	 * never cross the Workbench view boundary.
	 */
	sealedHoldoutReadiness: NonNullable<WorkbenchView["shippingReadiness"]>["sealedHoldout"];
	/** Cases in the largest verified exam; null when none verified. Host-computed. */
	sealedHoldoutCases: number | null;
	focus: WorkbenchFocus;
	validFocus: Partial<Record<WorkbenchSelectionKind, WorkbenchFocusEntry>>;
	warnings: string[];
	integrityBlockers: string[];
}

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function integrityFailure(warnings: string[], blockers: string[], message: string): void {
	warnings.push(message);
	blockers.push(message);
}

function safeDirectoryNames(root: string, warnings: string[], blockers: string[], label: string): string[] {
	if (!existsSync(root)) return [];
	try {
		const rootEntry = lstatSync(root);
		if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
			throw new Error(`${label} root is not a regular non-symlink directory`);
		}
		const entries = readdirSync(root, { withFileTypes: true });
		for (const entry of entries.filter((item) => item.isSymbolicLink())) {
			integrityFailure(warnings, blockers, `${label}: symbolic-link entry ${entry.name} is not authoritative`);
		}
		return entries
			.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		integrityFailure(warnings, blockers, `${label}: ${errorMessage(error)}`);
		return [];
	}
}

function verifyProposalArtifact(runsRoot: string, record: PersistedBuilderRun): void {
	const artifact = record.artifacts.proposal;
	if (!artifact) throw new Error("completed proposal has no artifact reference");
	const path = resolveContainedArtifactPath(runsRoot, "builders", record.runId, artifact.path);
	const entry = lstatSync(path);
	if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_PROPOSAL_BYTES) {
		throw new Error("proposal artifact is not a bounded regular file");
	}
	const content = readFileSync(path, "utf8");
	if (Buffer.byteLength(content, "utf8") !== artifact.bytes || hashFile(content) !== artifact.sha256) {
		throw new Error("proposal artifact hash/size does not match builder_run evidence");
	}
	if (canonicalJson(JSON.parse(content)) !== canonicalJson(record.result.proposal)) {
		throw new Error("proposal artifact does not match builder_run proposal");
	}
}

function verifyCandidateArtifact(
	artifact: CandidateArtifactRef,
	expectedPath: string,
	expectedHash?: string,
): void {
	const path = resolve(expectedPath);
	// Records may carry the canonical form of a symlinked root (macOS /var →
	// /private/var); compare canonical paths, never spellings.
	const canonical = (value: string): string => {
		try {
			return realpathSync(value);
		} catch {
			return resolve(value);
		}
	};
	if (canonical(artifact.path) !== canonical(path)) throw new Error("candidate provenance points at an unexpected artifact path");
	const entry = lstatSync(path);
	if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_PROPOSAL_BYTES * 4) {
		throw new Error("candidate provenance artifact is not a bounded regular file");
	}
	const actualHash = hashFile(readFileSync(path, "utf8"));
	if (artifact.sha256 !== actualHash || (expectedHash !== undefined && actualHash !== expectedHash)) {
		throw new Error("candidate provenance artifact hash does not match authoritative evidence");
	}
}

function listProposals(
	stateRoot: string,
	runsRoot: string,
	projectId: string,
	approvedSpecs: Map<string, ApprovedSpecReference>,
	lineages: Map<string, WorkbenchDevelopmentLineage>,
	developmentEvals: EvalRunRecord[],
	warnings: string[],
	blockers: string[],
): WorkbenchProposalInventory[] {
	const proposals: WorkbenchProposalInventory[] = [];
	let admissions;
	try {
		admissions = listBuilderProposalAdmissions(stateRoot, projectId);
	} catch (error) {
		integrityFailure(warnings, blockers, `proposal admissions: ${errorMessage(error)}`);
		return [];
	}
	for (const admission of admissions) {
		const runId = admission.runId;
		try {
			const record = loadBuilderProposalRunEnvelope(runsRoot, runId);
			if (record.runId !== runId) throw new Error("proposal directory does not match its run id");
			if (
				hashValue(record) !== admission.builderRunSha256 ||
				canonicalJson(record.request.approvedSpec) !== canonicalJson(admission.approvedSpec) ||
				record.artifacts.proposal?.sha256 !== admission.proposalSha256
			) throw new Error("proposal no longer matches its project-owned admission");
			verifyBuilderProposalRunEvidence(runsRoot, record);
			if (
				record.result.status !== "completed" ||
				record.result.proposal?.decision !== "propose" ||
				record.result.proposal.changes.length === 0
			) continue;
			const approvedSpec = record.request.approvedSpec;
			if (approvedSpec?.projectId !== projectId) throw new Error("proposal project ownership changed after preflight");
			if (canonicalJson(approvedSpecs.get(approvedSpec.specId)) !== canonicalJson(approvedSpec)) {
				throw new Error("proposal approved Spec reference has no exact valid human approval receipt");
			}
			verifyProposalArtifact(runsRoot, record);
			const source = record.request.sourceAttestation;
			if (source) {
				const development = source.developmentCorpus;
				const lineage = development ? lineages.get(development.id) : undefined;
				const evalRun = developmentEvals.find((run) => run.evalRunId === source.evalRunId);
				if (
					!development || !lineage ||
					lineage.publication.approvedSpecId !== approvedSpec.specId ||
					lineage.datasetHash !== development.hash ||
					development.hash !== source.datasetHash ||
					!evalRun || evalRun.summary.error !== 0 ||
					record.request.baseTargetSha !== source.targetGitSha ||
					evalRun.target.id !== source.targetId ||
					evalRun.target.gitSha !== source.targetGitSha ||
					evalRun.dataset !== source.dataset ||
					evalRun.datasetHash !== source.datasetHash ||
					evalRun.suiteHash !== source.suiteHash
				) throw new Error("proposal source does not bind its approved Spec to one reviewed corpus and conclusive EvalRun");
			}
			const applyPath = resolveContainedArtifactPath(runsRoot, "builders", runId, "apply_receipt.json");
			const discardPath = builderDiscardReceiptPath(runsRoot, runId);
			const intentPath = builderApplyIntentPath(runsRoot, runId);
			const hasApply = existsSync(applyPath);
			const hasDiscard = existsSync(discardPath);
			const hasApplyIntent = existsSync(intentPath);
			const decisionClaim = loadBuilderProposalDecisionClaim(runsRoot, runId);
			if (hasApply && hasDiscard) throw new Error("proposal has mutually exclusive apply and discard receipts");
			if (decisionClaim && (
				decisionClaim.runId !== record.runId ||
				decisionClaim.builderRunSha256 !== hashValue(record) ||
				decisionClaim.proposalSha256 !== record.artifacts.proposal?.sha256 ||
				decisionClaim.baseTargetSha !== record.result.proposal.baseTargetSha
			)) throw new Error("proposal decision claim does not bind the exact admitted proposal");
			const expectedPaths = record.result.proposal.changes.map((change) => change.path).sort();
			if (
				decisionClaim?.decision === "apply" &&
				canonicalArray(decisionClaim.paths) !== canonicalArray(expectedPaths)
			) throw new Error("apply decision claim paths do not match the exact proposal");
			if (
				decisionClaim?.decision === "discard" &&
				decisionClaim.subjectHash !== describeBuilderProposalDiscard(runsRoot, runId).subjectHash
			) throw new Error("discard decision claim subject does not match the exact proposal");
			if (decisionClaim?.decision === "apply" && hasDiscard) {
				throw new Error("discard receipt conflicts with the immutable apply decision claim");
			}
			if (decisionClaim?.decision === "discard" && (hasApply || hasApplyIntent)) {
				throw new Error("apply state conflicts with the immutable discard decision claim");
			}
			if (hasApplyIntent) {
				const intent = loadBuilderApplyIntent(runsRoot, runId);
				if (
					intent.builderRunSha256 !== hashValue(record) ||
					intent.receipt.runId !== record.runId ||
					intent.receipt.proposalSha256 !== record.artifacts.proposal?.sha256 ||
					intent.receipt.baseTargetSha !== record.result.proposal.baseTargetSha ||
					canonicalArray(intent.receipt.paths) !== canonicalArray(expectedPaths)
				) throw new Error("apply intent does not bind the exact proposal");
				if (decisionClaim?.decision === "apply" && canonicalJson({
					candidateSha: decisionClaim.candidateSha,
					branch: decisionClaim.branch,
					paths: decisionClaim.paths,
					actor: decisionClaim.actor,
					via: decisionClaim.via,
					decidedAt: decisionClaim.decidedAt,
					reason: decisionClaim.reason,
				}) !== canonicalJson({
					candidateSha: intent.receipt.candidateSha,
					branch: intent.receipt.branch,
					paths: intent.receipt.paths,
					actor: intent.receipt.actor,
					via: intent.receipt.via ?? null,
					decidedAt: intent.receipt.appliedAt,
					reason: intent.receipt.reason,
				})) throw new Error("apply intent does not match the immutable apply decision claim");
			}
			if (hasApply) {
				const receipt = loadBuilderApplyReceipt(runsRoot, runId);
				if (
					receipt.runId !== record.runId ||
					receipt.proposalSha256 !== record.artifacts.proposal?.sha256 ||
					receipt.baseTargetSha !== record.result.proposal.baseTargetSha ||
					canonicalArray(receipt.paths) !== canonicalArray(expectedPaths)
				) throw new Error("apply receipt does not bind the exact proposal");
				if (decisionClaim?.decision === "apply" && canonicalJson({
					candidateSha: decisionClaim.candidateSha,
					branch: decisionClaim.branch,
					paths: decisionClaim.paths,
					actor: decisionClaim.actor,
					via: decisionClaim.via,
					decidedAt: decisionClaim.decidedAt,
					reason: decisionClaim.reason,
				}) !== canonicalJson({
					candidateSha: receipt.candidateSha,
					branch: receipt.branch,
					paths: receipt.paths,
					actor: receipt.actor,
					via: receipt.via ?? null,
					decidedAt: receipt.appliedAt,
					reason: receipt.reason,
				})) throw new Error("apply receipt does not match the immutable apply decision claim");
			}
			if (hasDiscard) {
				const receipt = loadBuilderDiscardReceipt(runsRoot, runId);
				if (
					receipt.runId !== record.runId ||
					receipt.proposalSha256 !== record.artifacts.proposal?.sha256 ||
					receipt.baseTargetSha !== record.result.proposal.baseTargetSha
				) throw new Error("discard receipt does not bind the exact proposal");
				if (decisionClaim?.decision === "discard" && (
					receipt.subjectHash !== decisionClaim.subjectHash ||
					canonicalJson(receipt.actor) !== canonicalJson(decisionClaim.actor) ||
					receipt.discardedAt !== decisionClaim.decidedAt ||
					receipt.reason !== decisionClaim.reason
				)) throw new Error("discard receipt does not match the immutable discard decision claim");
			}
			proposals.push({
				record,
				status: hasApply
					? "applied"
					: hasDiscard
						? "discarded"
						: decisionClaim?.decision === "discard"
							? "discard-pending"
							: decisionClaim?.decision === "apply" || hasApplyIntent
								? "apply-pending"
								: "open",
			});
		} catch (error) {
			integrityFailure(warnings, blockers, `proposal ${runId}: ${errorMessage(error)}`);
		}
	}
	return proposals.sort((left, right) => right.record.runId.localeCompare(left.record.runId));
}

function canonicalArray(values: readonly string[]): string {
	return JSON.stringify([...values].sort());
}

function listCandidates(runsRoot: string, warnings: string[], blockers: string[]): CandidateRecord[] {
	const root = join(resolve(runsRoot), "candidates");
	const candidates: CandidateRecord[] = [];
	for (const candidateId of safeDirectoryNames(root, warnings, blockers, "candidates")) {
		try {
			const candidate = loadCandidateRecord(runsRoot, candidateId);
			if (candidate.candidateId !== candidateId) throw new Error("candidate directory does not match its record id");
			candidates.push(candidate);
		} catch (error) {
			integrityFailure(warnings, blockers, `candidate ${candidateId}: ${errorMessage(error)}`);
		}
	}
	return candidates.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function validateProjectCandidates(options: {
	stateRoot: string;
	runsRoot: string;
	projectId: string;
	target: ResolvedTarget | null;
	candidates: CandidateRecord[];
	approvedSpecs: Map<string, ApprovedSpecReference>;
	proposals: WorkbenchProposalInventory[];
	warnings: string[];
	blockers: string[];
}): CandidateRecord[] {
	const valid: CandidateRecord[] = [];
	for (const candidate of options.candidates.filter((item) => item.projectId === options.projectId)) {
		try {
			if (options.target && candidate.targetId !== options.target.manifest.id) {
				throw new Error("candidate targets a different harness");
			}
			if (candidate.origin.kind === "applied-builder") {
				const origin = candidate.origin;
				const proposal = options.proposals.find((item) => item.record.runId === origin.builderRunId);
				if (!proposal || proposal.status !== "applied") {
					throw new Error("applied candidate has no exact admitted proposal and apply receipt");
				}
				const record = proposal.record;
				if (record.request.provenanceMode !== "canonical") {
					throw new Error("applied candidate proposal is not canonical");
				}
				const approvedSpec = options.approvedSpecs.get(origin.approvedSpec.specId);
				if (
					!approvedSpec ||
					canonicalJson(record.request.approvedSpec) !== canonicalJson(approvedSpec) ||
					canonicalJson({
						projectId: origin.approvedSpec.projectId,
						specId: origin.approvedSpec.specId,
						specContentHash: origin.approvedSpec.specContentHash,
						snapshotHash: origin.approvedSpec.snapshotHash,
					}) !== canonicalJson(approvedSpec)
				) throw new Error("candidate approved Spec does not match an exact human approval receipt");

				const runDir = join(resolve(options.runsRoot), "builders", record.runId);
				verifyCandidateArtifact(origin.builderRun, join(runDir, "builder_run.json"));
				verifyCandidateArtifact(origin.builderInput, join(runDir, "builder_input.txt"), record.artifacts.input.sha256);
				verifyCandidateArtifact(origin.proposal, join(runDir, "proposal.json"), record.artifacts.proposal?.sha256);
				verifyCandidateArtifact(origin.applyReceipt, join(runDir, "apply_receipt.json"));
				verifyCandidateArtifact(
					origin.approvedSpec.artifact,
					join(resolve(options.stateRoot), "projects", options.projectId, "specs", `${approvedSpec.specId}.json`),
				);

				const receipt = loadBuilderApplyReceipt(options.runsRoot, record.runId);
				if (canonicalJson(origin.application) !== canonicalJson({
					actor: receipt.actor,
					reason: receipt.reason,
					appliedAt: receipt.appliedAt,
					baseTargetSha: receipt.baseTargetSha,
					candidateSha: receipt.candidateSha,
					proposalSha256: receipt.proposalSha256,
				})) throw new Error("candidate application does not match the exact apply receipt");

				const source = record.request.sourceAttestation;
				if ((source === null) !== (origin.source === null)) {
					throw new Error("candidate source evidence does not match its proposal");
				}
				if (source && origin.source) {
					if (canonicalJson({
						evalRunId: origin.source.evalRunId,
						diagnosisId: origin.source.diagnosisId,
						dataset: origin.source.dataset,
						datasetHash: origin.source.datasetHash,
						suiteHash: origin.source.suiteHash,
						developmentCorpus: origin.source.developmentCorpus,
					}) !== canonicalJson({
						evalRunId: source.evalRunId,
						diagnosisId: source.diagnosisId,
						dataset: source.dataset,
						datasetHash: source.datasetHash,
						suiteHash: source.suiteHash,
						developmentCorpus: source.developmentCorpus,
					})) throw new Error("candidate source identity differs from the admitted proposal source");
					verifyCandidateArtifact(
						origin.source.evalRun,
						join(resolve(options.runsRoot), source.evalRunId, "eval_run.json"),
						source.evalRunSha256,
					);
					verifyCandidateArtifact(
						origin.source.diagnosis,
						join(resolve(options.runsRoot), source.evalRunId, "diagnosis.json"),
						source.diagnosisSha256,
					);
				}
			}
			valid.push(candidate);
		} catch (error) {
			integrityFailure(
				options.warnings,
				options.blockers,
				`candidate ${candidate.candidateId}: ${errorMessage(error)}`,
			);
		}
	}
	return valid;
}

export function workbenchArtifactValue(
	inventory: Omit<WorkbenchInventory, "validFocus">,
	kind: WorkbenchSelectionKind,
	id: string,
): unknown | null {
	switch (kind) {
		case "spec-draft":
			return inventory.specs.find((spec) => spec.id === id && spec.status === "draft") ?? null;
		case "approved-spec":
			return inventory.verifiedApprovedSpecIds.has(id)
				? inventory.specs.find((spec) => spec.id === id && spec.status === "approved") ?? null
				: null;
		case "corpus-draft":
			return inventory.corpusDrafts.find((draft) => draft.id === id) ?? null;
		case "development-corpus":
			return inventory.corpora.find((corpus) => corpus.id === id && corpus.visibility === "development") ?? null;
		case "eval-run":
			return inventory.developmentEvals.find((run) => run.evalRunId === id) ?? null;
		case "proposal":
			return inventory.proposals.find((proposal) => proposal.record.runId === id)?.record ?? null;
		case "candidate":
			return inventory.candidates.find((candidate) => candidate.candidateId === id) ?? null;
	}
}

function validateFocus(inventory: Omit<WorkbenchInventory, "validFocus">): Partial<Record<WorkbenchSelectionKind, WorkbenchFocusEntry>> {
	const valid: Partial<Record<WorkbenchSelectionKind, WorkbenchFocusEntry>> = {};
	for (const [kind, entry] of Object.entries(inventory.focus.selections) as [WorkbenchSelectionKind, WorkbenchFocusEntry][]) {
		const artifact = workbenchArtifactValue(inventory, kind, entry.id);
		if (!artifact) {
			inventory.warnings.push(`focus ${kind} ${entry.id} no longer resolves`);
			continue;
		}
		if (hashValue(artifact) !== entry.hash) {
			inventory.warnings.push(`focus ${kind} ${entry.id} changed; reselect it before a decision`);
			continue;
		}
		valid[kind] = entry;
	}
	return valid;
}

/**
 * The same inventory with a focus that was just written. `select` already read
 * the state its view reports, so the trailing view never re-reads disk to learn
 * about a selection this process made.
 */
export function withWorkbenchFocus(inventory: WorkbenchInventory, focus: WorkbenchFocus): WorkbenchInventory {
	const next = { ...inventory, focus, warnings: [...inventory.warnings] };
	return { ...next, validFocus: validateFocus(next) };
}

export function loadWorkbenchInventory(options: {
	projectDir: string;
	stateRoot: string;
	runsRoot: string;
	projectId: string;
	now?: () => string;
}): WorkbenchInventory {
	const warnings: string[] = [];
	const integrityBlockers: string[] = [];
	let target: ResolvedTarget | null = null;
	try {
		target = loadTarget(options.projectDir);
	} catch (error) {
		// "There is no manifest here" is the whole state of a fresh directory, and
		// the stage already says it as a blocker. Repeating it as a raw ENOENT
		// with an absolute path is the first thing a newcomer reads, and it reads
		// like a crash. Anything else that stops a manifest from loading — bad
		// YAML, a broken field — is still a warning, because it IS a surprise.
		if (!/\bENOENT\b/.test(errorMessage(error))) warnings.push(`target: ${errorMessage(error)}`);
	}
	// A template's prose is starting material, not the agent. Saying so once, as
	// a warning, is what stops the Builder from measuring `REPLACE-ME` and the
	// operator from wondering whether it was supposed to edit those files.
	if (target) {
		const standIns = standInFilesLine(target.dir);
		if (standIns) warnings.push(standIns);
	}
	let specs: SpecSnapshot[] = [];
	try {
		specs = listSpecSnapshots(options.stateRoot, options.projectId);
	} catch (error) {
		integrityFailure(warnings, integrityBlockers, `specs: ${errorMessage(error)}`);
	}
	let corpusDrafts: BuilderCorpusDraft[] = [];
	try {
		corpusDrafts = listBuilderCorpusDrafts(options.stateRoot, options.projectId);
	} catch (error) {
		integrityFailure(warnings, integrityBlockers, `corpus drafts: ${errorMessage(error)}`);
	}
	const corpusDraftById = new Map(corpusDrafts.map((draft) => [draft.id, draft] as const));
	for (const draft of corpusDrafts.filter((candidate) => candidate.importSource !== undefined)) {
		try {
			let root = draft;
			const visited = new Set<string>();
			while (root.parentDraftId !== null) {
				if (visited.has(root.id)) throw new Error("import draft parent lineage contains a cycle");
				visited.add(root.id);
				const parent = corpusDraftById.get(root.parentDraftId);
				if (!parent) throw new Error(`import draft parent ${root.parentDraftId} is missing`);
				if (canonicalJson(parent.importSource) !== canonicalJson(draft.importSource)) {
					throw new Error("import source changed within the immutable draft lineage");
				}
				root = parent;
			}
			loadBuilderCorpusImportReceiptForDraft(options.stateRoot, root);
		} catch (error) {
			integrityFailure(
				warnings,
				integrityBlockers,
				`corpus draft ${draft.id} import provenance: ${errorMessage(error)}`,
			);
		}
	}
	let corpora: CorpusMetadata[] = [];
	let sealedHoldoutReadiness: WorkbenchInventory["sealedHoldoutReadiness"] = "missing";
	let sealedHoldoutCases: number | null = null;
	try {
		corpora = listCorpora({ stateRoot: options.stateRoot, projectId: options.projectId });
		const sealed = corpora.filter((corpus) => corpus.visibility === "sealed");
		if (sealed.length > 0) {
			let largestVerifiedCorpus = 0;
			let verifiedCorpora = 0;
			for (const corpus of sealed) {
				try {
					const verified = loadCorpus({
						stateRoot: options.stateRoot,
						projectId: options.projectId,
						corpusId: corpus.id,
					});
					// Protect the metadata-list/read seam as well as content itself: a
					// corpus changed between those reads is not release evidence.
					if (canonicalJson(verified.metadata) !== canonicalJson(corpus)) {
						throw new Error("sealed corpus metadata changed during verification");
					}
					verifiedCorpora += 1;
					largestVerifiedCorpus = Math.max(largestVerifiedCorpus, verified.tasks.length);
				} catch {
					// A broken private exam cannot qualify, but it also cannot poison a
					// different independently verified exam. Failure details stay here.
				}
			}
			sealedHoldoutReadiness = verifiedCorpora === 0
				? "unavailable"
				: largestVerifiedCorpus >= SEALED_GATE_POLICY.minTasks ? "ready" : "underpowered";
			// The count of the exam the gate would actually use, so a shortfall can
			// be stated as arithmetic. Nothing else about that corpus travels.
			sealedHoldoutCases = verifiedCorpora === 0 ? null : largestVerifiedCorpus;
		}
	} catch {
		sealedHoldoutReadiness = "unavailable";
		integrityFailure(
			warnings,
			integrityBlockers,
			"private corpus inventory failed integrity checks; sealed identities remain hidden",
		);
	}
	const verifiedApprovedSpecIds = new Set<string>();
	const verifiedApprovedSpecReferences = new Map<string, ApprovedSpecReference>();
	const approvedDraftSpecIds = new Set<string>();
	for (const draft of specs.filter((spec) => spec.status === "draft")) {
		const receiptPath = join(
			resolve(options.stateRoot),
			"projects",
			options.projectId,
			"builder-authoring",
			"spec-approvals",
			`${draft.id}.json`,
		);
		if (!existsSync(receiptPath)) continue;
		try {
			const receipt = loadSpecApprovalReceipt(options.stateRoot, options.projectId, draft.id);
			approvedDraftSpecIds.add(draft.id);
			verifiedApprovedSpecIds.add(receipt.approvedSpec.specId);
			verifiedApprovedSpecReferences.set(receipt.approvedSpec.specId, receipt.approvedSpec);
		} catch (error) {
			integrityFailure(
				warnings,
				integrityBlockers,
				`Spec approval receipt for ${draft.id}: ${errorMessage(error)}`,
			);
		}
	}
	for (const approved of specs.filter((spec) => spec.status === "approved")) {
		if (!verifiedApprovedSpecIds.has(approved.id)) {
			warnings.push(`approved Spec ${approved.id} has no valid human approval receipt and is ignored`);
		}
	}
	const developmentLineage = new Map<string, WorkbenchDevelopmentLineage>();
	for (const corpus of corpora.filter((item) => item.visibility === "development")) {
		const receiptPath = join(
			resolve(options.stateRoot),
			"projects",
			options.projectId,
			"builder-authoring",
			"corpus-publications",
			`${corpus.id}.json`,
		);
		const lineagePath = join(
			resolve(options.stateRoot),
			"projects",
			options.projectId,
			"workbench",
			"corpus-publications",
			`${corpus.id}.json`,
		);
		const hasReceipt = existsSync(receiptPath);
		const hasLineage = existsSync(lineagePath);
		if (!hasReceipt && !hasLineage) {
			warnings.push(`development corpus ${corpus.id} is not receipt-backed and is ignored`);
			continue;
		}
		if (hasReceipt && !hasLineage) {
			try {
				const receipt = loadDevelopmentCorpusPublicationReceipt(options.stateRoot, options.projectId, corpus.id);
				const recoverable = corpusDrafts.some((draft) => {
					const approvedSpec = verifiedApprovedSpecReferences.get(draft.approvedSpec.specId);
					return canonicalJson(draft.approvedSpec) === canonicalJson(approvedSpec) &&
						draft.tasks.length === receipt.corpus.taskCount &&
						hashValue(draft.tasks) === receipt.corpus.hash;
				});
				warnings.push(recoverable
					? `development corpus ${corpus.id} has a recoverable incomplete Workbench lineage`
					: `development corpus ${corpus.id} is valid legacy/unbound evidence and is ignored by Workbench authority`);
			} catch {
				integrityFailure(
					warnings,
					integrityBlockers,
					`development corpus ${corpus.id} failed publication receipt integrity checks`,
				);
			}
			continue;
		}
		if (!hasReceipt) {
			integrityFailure(
				warnings,
				integrityBlockers,
				`development corpus ${corpus.id} has Workbench lineage without its publication receipt`,
			);
			continue;
		}
		try {
			const receipt = loadDevelopmentCorpusPublicationReceipt(options.stateRoot, options.projectId, corpus.id);
			const publication = loadWorkbenchCorpusPublication(options.stateRoot, options.projectId, corpus.id);
			const draft = corpusDrafts.find((item) => item.id === publication.draftId);
			const approvedSpec = verifiedApprovedSpecReferences.get(publication.approvedSpecId);
			if (
				!draft ||
				publication.projectId !== options.projectId ||
				publication.corpusId !== corpus.id ||
				hashValue(draft) !== publication.draftHash ||
				draft.approvedSpec.specId !== publication.approvedSpecId ||
				draft.approvedSpec.snapshotHash !== publication.approvedSpecHash ||
				!approvedSpec || canonicalJson(draft.approvedSpec) !== canonicalJson(approvedSpec) ||
				publication.corpusHash !== corpus.hash ||
				publication.publicationReceiptId !== receipt.id ||
				publication.publicationReceiptHash !== hashValue(receipt) ||
				canonicalJson(publication.actor) !== canonicalJson(receipt.actor) ||
				publication.reason !== receipt.reason ||
				publication.publishedAt !== receipt.publishedAt ||
				receipt.corpus.hash !== corpus.hash
			) throw new Error("invalid publication binding");
			const loaded = loadCorpus({ stateRoot: options.stateRoot, projectId: options.projectId, corpusId: corpus.id });
			if (loaded.metadata.hash !== corpus.hash || loaded.metadata.visibility !== "development") {
				throw new Error("corpus content changed");
			}
			// Lineage is intact from here on. Whether the basket can run on the
			// current Target is a compatibility question, not an integrity one: an
			// unrunnable grader must not lock the whole Workbench.
			let exactTarget: ResolvedTarget | null = null;
			if (target) {
				try {
					exactTarget = targetWithDevelopmentCorpus(target, loaded);
				} catch (error) {
					warnings.push(`development corpus ${corpus.id} cannot run on the current Target: ${errorMessage(error)}`);
				}
			}
			developmentLineage.set(corpus.id, {
				publication,
				datasetHash: corpus.hash,
				currentSuiteHash: exactTarget?.suiteHash ?? null,
				currentTargetGitSha: exactTarget?.gitSha ?? null,
			});
		} catch (error) {
			integrityFailure(
				warnings,
				integrityBlockers,
				`development corpus ${corpus.id} failed reviewed lineage integrity checks: ${errorMessage(error)}`,
			);
		}
	}
	const sealedHashes = new Set(corpora.filter((corpus) => corpus.visibility === "sealed").map((corpus) => corpus.hash));
	let developmentEvals: EvalRunRecord[] = [];
	try {
		const listed = listEvalRunIndexesLenient(options.runsRoot);
		if (listed.invalid.length > 0) {
			warnings.push(
				`${listed.invalid.length} legacy eval run index${listed.invalid.length === 1 ? "" : "es"} ignored: ` +
				"not comparable with the current evidence schema",
			);
		}
		developmentEvals = listed.records
			.filter((run) => !isSealedEvalRun(run, sealedHashes))
			// A cheap-check screen is a one-arm re-run of what already failed. It is
			// never selectable evidence, never a reusable baseline and never the
			// source a proposal or a regression case cites, and the record says so
			// itself — so it never enters the inventory at all.
			.filter((run) => run.purpose === "evidence")
			.map((run) => loadEvalRun(options.runsRoot, run.evalRunId))
			.filter((run) => target === null || run.target.id === target.manifest.id);
	} catch {
		integrityFailure(
			warnings,
			integrityBlockers,
			"evaluation inventory failed integrity checks; sealed identities remain hidden",
		);
	}
	const focus = loadWorkbenchFocus(options.stateRoot, options.projectId, options.now);
	const proposals = listProposals(
		options.stateRoot,
		options.runsRoot,
		options.projectId,
		verifiedApprovedSpecReferences,
		developmentLineage,
		developmentEvals,
		warnings,
		integrityBlockers,
	);
	// A/A calibration records are measurement, not workflow: they are split off
	// before admission so they can never become a candidate to review, an
	// interrupted attempt to abandon, or a selectable artifact.
	const listedCandidates = listCandidates(options.runsRoot, warnings, integrityBlockers);
	const calibrations = listedCandidates.filter((record) =>
		record.mode === "aa-calibration" && record.projectId === options.projectId
	);
	const candidates = validateProjectCandidates({
		stateRoot: options.stateRoot,
		runsRoot: options.runsRoot,
		projectId: options.projectId,
		target,
		candidates: listedCandidates.filter((record) => record.mode !== "aa-calibration"),
		approvedSpecs: verifiedApprovedSpecReferences,
		proposals,
		warnings,
		blockers: integrityBlockers,
	});
	const abandonedCandidates = new Map<string, CandidateAbandonmentReceipt>();
	for (const candidate of candidates.filter((item) => item.projectId === options.projectId)) {
		try {
			const receipt = loadCandidateAbandonment(
				options.stateRoot,
				options.projectId,
				candidate.candidateId,
			);
			if (!receipt) continue;
			const status = candidateStatus(candidate);
			if (
				receipt.candidateHash !== hashValue(candidate) ||
				receipt.projectId !== candidate.projectId ||
				receipt.interruptedStatus !== status
			) throw new Error("abandonment receipt does not bind exact interrupted candidate");
			abandonedCandidates.set(candidate.candidateId, receipt);
		} catch {
			integrityFailure(
				warnings,
				integrityBlockers,
				`candidate ${candidate.candidateId} has an invalid abandonment receipt and remains blocked`,
			);
		}
	}
	const adoptedCandidates = new Map<string, TargetAdoptionReceipt>();
	const continuedCandidates = new Map<string, CycleContinuationReceipt>();
	for (const candidate of candidates.filter((item) => item.projectId === options.projectId)) {
		const status = candidateStatus(candidate);
		if (status !== "promoted" && status !== "rejected") continue;
		const recordHash = hashValue(candidate);
		if (status === "promoted") {
			try {
				const receipt = loadTargetAdoptionReceiptIfPresent(options.stateRoot, candidate.candidateId);
				if (receipt) {
					const subject = receipt.intent.subject.candidate;
					if (
						subject.candidateId !== candidate.candidateId ||
						subject.targetId !== candidate.targetId ||
						subject.candidateRecordHash !== recordHash
					) throw new Error("adoption receipt does not bind the exact promoted candidate");
					adoptedCandidates.set(candidate.candidateId, receipt);
				}
			} catch {
				integrityFailure(
					warnings,
					integrityBlockers,
					`candidate ${candidate.candidateId} has an invalid Target adoption receipt and remains blocked`,
				);
			}
		}
		try {
			const receipt = loadCycleContinuationReceipt(options.stateRoot, options.projectId, candidate.candidateId);
			if (receipt) {
				const subject = receipt.subject;
				if (
					subject.projectId !== options.projectId ||
					subject.candidate.candidateId !== candidate.candidateId ||
					subject.candidate.recordHash !== recordHash ||
					subject.candidate.status !== status ||
					(status === "promoted") !== adoptedCandidates.has(candidate.candidateId)
				) throw new Error("continuation receipt does not bind the exact terminal candidate");
				continuedCandidates.set(candidate.candidateId, receipt);
			}
		} catch {
			integrityFailure(
				warnings,
				integrityBlockers,
				`candidate ${candidate.candidateId} has an invalid cycle continuation receipt and remains blocked`,
			);
		}
	}
	const base = {
		projectDir: resolve(options.projectDir),
		stateRoot: resolve(options.stateRoot),
		runsRoot: resolve(options.runsRoot),
		projectId: options.projectId,
		target,
		specs,
		corpusDrafts,
		corpora,
		approvedDraftSpecIds,
		verifiedApprovedSpecIds,
		verifiedApprovedSpecReferences,
		developmentLineage,
		developmentEvals,
		proposals,
		candidates,
		calibrations,
		abandonedCandidates,
		adoptedCandidates,
		continuedCandidates,
		sealedHoldoutReadiness,
		sealedHoldoutCases,
		focus,
		warnings,
		integrityBlockers,
	};
	return { ...base, validFocus: validateFocus(base) };
}

function selection(
	kind: WorkbenchSelectionKind,
	id: string,
	label: string,
	inventory: WorkbenchInventory,
	status?: string,
): WorkbenchSelectionSummary {
	return {
		kind,
		id,
		label,
		...(status ? { status } : {}),
		selected: inventory.validFocus[kind]?.id === id,
	};
}

function selectedOrUniqueId<T>(
	items: readonly T[],
	focusId: string | undefined,
	id: (item: T) => string,
): string | null | "ambiguous" {
	if (focusId && items.some((item) => id(item) === focusId)) return focusId;
	if (items.length === 1) return id(items[0]!);
	return items.length === 0 ? null : "ambiguous";
}

/** Promoted or rejected candidates of this project whose loop has not been closed by a human. */
export function openTerminalCandidatesOf(inventory: WorkbenchInventory): CandidateRecord[] {
	return inventory.candidates.filter((candidate) =>
		candidate.projectId === inventory.projectId &&
		["promoted", "rejected"].includes(candidateStatus(candidate)) &&
		!inventory.continuedCandidates.has(candidate.candidateId)
	);
}

/**
 * One blocker, twice: the English sentence the Builder model reads and scripts
 * match on, and the typed reason the host renders in the operator's language.
 * They are built together so the two can never drift apart.
 */
interface StageBlocker {
	text: string;
	reason: WorkbenchBlockerReason;
}

function blocked(
	text: string,
	code: string,
	params?: Record<string, string | number>,
	detail?: string,
): StageBlocker {
	return { text, reason: { code, ...(params ? { params } : {}), ...(detail ? { detail } : {}) } };
}

function stageFor(inventory: WorkbenchInventory): { stage: WorkbenchStage; headline: string; actions: string[]; blockers: StageBlocker[] } {
	if (inventory.integrityBlockers.length > 0) {
		return {
			stage: "selection-required",
			headline: "Workbench authority is blocked until artifact integrity is restored.",
			actions: [],
			blockers: [...new Set(inventory.integrityBlockers)].map((text) => blocked(text, "blocker.integrity", undefined, text)),
		};
	}
	const target = inventory.target;
	if (!target) {
		return {
			stage: "target-setup",
			headline: "Create the Target harness before authoring evidence.",
			actions: ["scaffold-target"],
			blockers: [blocked("Target harness is missing.", "blocker.target-missing")],
		};
	}
	if (targetBootstrapRequired(target.manifest)) {
		// Which fields are still stand-ins is the whole answer to "why am I being
		// asked this again", and a template that says REPLACE-ME in four places
		// deserves to have them named rather than described.
		const standIns = standInManifestFields(target.manifest);
		return {
			stage: "target-setup",
			headline: "Choose the Target identity and model before authoring evidence.",
			actions: ["configure-target"],
			blockers: [standIns.length > 0
				? blocked(
					`Target still contains the template's REPLACE-ME stand-ins in ${standIns.join(", ")}.`,
					"blocker.target-stand-ins",
					{ fields: standIns.join(", ") },
				)
				: blocked("Target still contains its one-time identity/model placeholders.", "blocker.target-placeholder")],
		};
	}

	const projectCandidates = inventory.candidates.filter((candidate) => candidate.projectId === inventory.projectId);
	const activeCandidates = projectCandidates.filter((candidate) =>
		!["promoted", "rejected"].includes(candidateStatus(candidate)) &&
		!inventory.abandonedCandidates.has(candidate.candidateId)
	);
	const candidateChoice = selectedOrUniqueId(
		activeCandidates,
		inventory.validFocus.candidate?.id,
		(candidate) => candidate.candidateId,
	);
	if (candidateChoice === "ambiguous") {
		return {
			stage: "selection-required",
			headline: "Choose the candidate lineage to continue.",
			actions: ["select candidate"],
			blockers: [blocked(`${activeCandidates.length} active candidates are compatible with this project.`, "blocker.candidates-ambiguous", { candidates: plural(activeCandidates.length, "candidate") })],
		};
	}
	if (candidateChoice) {
		const candidate = activeCandidates.find((item) => item.candidateId === candidateChoice)!;
		const status = candidateStatus(candidate);
		if (["proposed", "built", "validated"].includes(status)) {
			return {
				stage: "candidate-verification",
				headline: `Candidate verification was interrupted at ${status}; review its durable checkpoint.`,
				actions: ["review", "abandon-candidate"],
				blockers: [blocked("A human must explicitly abandon the interrupted attempt before retrying.", "blocker.interrupted-candidate")],
			};
		}
		if (status === "evaluated") return { stage: "candidate-review", headline: "Candidate evidence is ready for human review.", actions: ["review", "ship"], blockers: [] };
		if (status === "reviewed") return { stage: "release-decision", headline: "Make the final promotion or rejection decision.", actions: ["ship", "promote", "reject"], blockers: [] };
		return { stage: "candidate-verification", headline: "Finish exact candidate verification.", actions: ["run", "traces"], blockers: [] };
	}
	// A finished candidate holds the stage until a human closes its loop, no
	// matter where mutable focus points: adoption and continuation are not
	// skippable by selecting another artifact.
	const openTerminalCandidates = openTerminalCandidatesOf(inventory);
	const terminalChoice = selectedOrUniqueId(
		openTerminalCandidates,
		inventory.validFocus.candidate?.id,
		(candidate) => candidate.candidateId,
	);
	if (terminalChoice === "ambiguous") {
		return {
			stage: "selection-required",
			headline: "Choose which finished candidate to adopt or close before continuing.",
			actions: ["select candidate"],
			blockers: [blocked(`${openTerminalCandidates.length} finished candidates still need adoption or cycle closure.`, "blocker.terminal-candidates", { candidates: plural(openTerminalCandidates.length, "candidate") })],
		};
	}
	if (terminalChoice) {
		const terminal = openTerminalCandidates.find((candidate) => candidate.candidateId === terminalChoice)!;
		const status = candidateStatus(terminal);
		if (status === "promoted" && !inventory.adoptedCandidates.has(terminal.candidateId)) {
			return {
				stage: "candidate-adoption",
				headline: "Make the promoted candidate the active Target by fast-forwarding the current branch.",
				actions: ["ship", "adopt-candidate"],
				blockers: [],
			};
		}
		return {
			stage: "complete",
			headline: status === "promoted"
				? "The promoted candidate is the active Target. Start the next improvement cycle."
				: "The candidate was rejected and the Target stays at its baseline. Start the next improvement cycle.",
			// A rejected candidate has nothing left to ship; advertising it beside a
			// headline that says so would tell the model two opposite things.
			actions: status === "promoted" ? ["ship", "continue-cycle"] : ["continue-cycle"],
			blockers: [],
		};
	}

	const applied = inventory.proposals.filter((proposal) => proposal.status === "applied");
	const appliedWithoutCandidate = applied.filter((proposal) => !projectCandidates.some((candidate) =>
		candidate.origin.kind === "applied-builder" &&
		candidate.origin.builderRunId === proposal.record.runId &&
		!inventory.abandonedCandidates.has(candidate.candidateId),
	));
	const appliedChoice = selectedOrUniqueId(
		appliedWithoutCandidate,
		inventory.validFocus.proposal?.id,
		(proposal) => proposal.record.runId,
	);
	if (appliedChoice === "ambiguous") {
		return { stage: "selection-required", headline: "Choose the applied proposal to verify.", actions: ["select proposal"], blockers: [blocked(`${appliedWithoutCandidate.length} applied proposals have no candidate evidence.`, "blocker.applied-without-evidence", { proposals: plural(appliedWithoutCandidate.length, "applied change") })] };
	}
	if (appliedChoice) return { stage: "candidate-verification", headline: "The proposal is applied; verify its exact candidate revision.", actions: ["run"], blockers: [] };

	const reviewable = inventory.proposals.filter((proposal) =>
		proposal.status === "open" || proposal.status === "apply-pending" || proposal.status === "discard-pending"
	);
	const proposalChoice = selectedOrUniqueId(reviewable, inventory.validFocus.proposal?.id, (proposal) => proposal.record.runId);
	if (proposalChoice === "ambiguous") {
		return { stage: "selection-required", headline: "Choose the proposal to review.", actions: ["select proposal"], blockers: [blocked(`${reviewable.length} proposals await a decision or recovery.`, "blocker.proposals-await", { proposals: plural(reviewable.length, "open proposal") })] };
	}
	if (proposalChoice) {
		const proposal = reviewable.find((item) => item.record.runId === proposalChoice)!;
		if (proposal.status === "apply-pending") {
			return { stage: "proposal-review", headline: "This proposal has an interrupted apply; resume the exact apply decision.", actions: ["review", "apply"], blockers: [] };
		}
		if (proposal.status === "discard-pending") {
			return { stage: "proposal-review", headline: "This proposal has an interrupted discard; resume the exact discard decision.", actions: ["review", "discard"], blockers: [] };
		}
		return { stage: "proposal-review", headline: "Review the exact proposal diff, then apply or discard it.", actions: ["review", "apply", "discard"], blockers: [] };
	}

	const approved = inventory.specs.filter((spec) => spec.status === "approved" && inventory.verifiedApprovedSpecIds.has(spec.id));
	const unapprovedDrafts = inventory.specs.filter((spec) =>
		spec.status === "draft" && !inventory.approvedDraftSpecIds.has(spec.id)
	);
	if (unapprovedDrafts.length > 0) {
		const draftChoice = selectedOrUniqueId(unapprovedDrafts, inventory.validFocus["spec-draft"]?.id, (spec) => spec.id);
		if (draftChoice === "ambiguous") {
			return { stage: "selection-required", headline: "Choose the Spec draft to review.", actions: ["select spec-draft"], blockers: [blocked(`${unapprovedDrafts.length} Spec drafts await review.`, "blocker.spec-drafts", { drafts: plural(unapprovedDrafts.length, "description draft") })] };
		}
		return {
			stage: "spec-review",
			headline: "Review and approve an exact Spec draft; evaluator models can be configured before its cases are written.",
			actions: ["review", "start-testing", "approve-spec", "configure-evaluators"],
			blockers: [],
		};
	}
	if (approved.length === 0) {
		return {
			stage: "spec-design",
			headline: "Describe the agent; Builder Pi will structure an editable Spec draft.",
			actions: ["submit spec-draft", "configure-evaluators"],
			blockers: [],
		};
	}
	const approvedChoice = selectedOrUniqueId(approved, inventory.validFocus["approved-spec"]?.id, (spec) => spec.id);
	if (approvedChoice === "ambiguous") {
		return { stage: "selection-required", headline: "Choose the approved Spec lineage to continue.", actions: ["select approved-spec"], blockers: [blocked(`${approved.length} approved Specs exist.`, "blocker.approved-specs", { specs: plural(approved.length, "approved description") })] };
	}

	const compatibleDrafts = inventory.corpusDrafts.filter((draft) => draft.approvedSpec.specId === approvedChoice);
	const development = inventory.corpora.filter((corpus) =>
		corpus.visibility === "development" &&
		inventory.developmentLineage.get(corpus.id)?.publication.approvedSpecId === approvedChoice
	);
	const publishedDraftIds = new Set([...inventory.developmentLineage.values()].map((lineage) => lineage.publication.draftId));
	const reviewableDrafts = compatibleDrafts.filter((draft) => !publishedDraftIds.has(draft.id));
	const focusedDraft = inventory.validFocus["corpus-draft"]?.id;
	if (development.length === 0 || (focusedDraft && reviewableDrafts.some((draft) => draft.id === focusedDraft))) {
		if (reviewableDrafts.length === 0) {
			return {
				stage: "corpus-design",
				headline: "Build the first harness in a construction workshop and assemble a maintainable development eval basket from the approved Spec.",
				actions: ["workshop-open", "submit corpus-draft", "configure-evaluators"],
				blockers: [],
			};
		}
		const draftChoice = selectedOrUniqueId(reviewableDrafts, focusedDraft, (draft) => draft.id);
		if (draftChoice === "ambiguous") return { stage: "selection-required", headline: "Choose the corpus draft revision to publish.", actions: ["select corpus-draft"], blockers: [blocked(`${reviewableDrafts.length} unpublished corpus drafts match the approved Spec.`, "blocker.corpus-drafts", { drafts: plural(reviewableDrafts.length, "test-case draft") })] };
		return {
			stage: "corpus-review",
			headline: "Review the exact development corpus draft before publishing it; configure any evaluator model its cases require.",
			actions: ["review", "publish-corpus", "configure-evaluators"],
			blockers: [],
		};
	}
	const corpusChoice = selectedOrUniqueId(development, inventory.validFocus["development-corpus"]?.id, (corpus) => corpus.id);
	if (corpusChoice === "ambiguous") return { stage: "selection-required", headline: "Choose the development corpus for this loop.", actions: ["select development-corpus"], blockers: [blocked(`${development.length} development corpora exist.`, "blocker.development-corpora", { baskets: plural(development.length, "test basket") })] };

	const selectedCorpus = development.find((corpus) => corpus.id === corpusChoice)!;
	const lineage = inventory.developmentLineage.get(selectedCorpus.id)!;
	if (lineage.currentSuiteHash === null || lineage.currentTargetGitSha === null) {
		return {
			stage: "corpus-design",
			headline: "The published development basket cannot run on the current Target; configure its evaluator models or revise the cases.",
			actions: ["workshop-open", "configure-evaluators", "submit corpus-draft"],
			blockers: [blocked("The selected development basket is not runnable on the current Target.", "blocker.basket-not-runnable")],
		};
	}
	const compatibleEvals = inventory.developmentEvals.filter((run) =>
		run.target.id === target.manifest.id &&
		run.target.gitSha === lineage.currentTargetGitSha &&
		run.datasetHash === lineage.datasetHash &&
		run.suiteHash === lineage.currentSuiteHash &&
		run.summary.error === 0
	);
	if (compatibleEvals.length === 0) {
		return {
			stage: "ready-to-evaluate",
			headline: "The approved development surface is ready; run it, or finish the first harness in a construction workshop before measuring.",
			actions: ["workshop-open", "run", "configure-evaluators"],
			blockers: [],
		};
	}
	return {
		stage: "improvement-authoring",
		headline: "Use the diagnosis to improve the harness in a workshop or with a structured proposal.",
		actions: ["workshop-open", "traces", "submit structured-proposal", "configure-evaluators"],
		blockers: [],
	};
}

function modelSummary(
	model: { provider: string; id: string; apiKeyEnv: string } | undefined,
	env: NodeJS.ProcessEnv,
): WorkbenchView["target"]["model"] {
	if (!model) return null;
	return {
		provider: model.provider,
		id: model.id,
		apiKeyEnv: model.apiKeyEnv,
		credentialPresent: Boolean(env[model.apiKeyEnv]?.trim()),
	};
}

type EvaluatorRequirements = { judge: boolean; simulatedUser: boolean };
type EvaluatorRequirementTask = {
	graders?: readonly { type: string }[] | undefined;
	effectiveGraders?: readonly { type: string }[] | undefined;
	simulatedUser?: unknown;
};

function requirementsOf(
	tasks: readonly EvaluatorRequirementTask[],
): EvaluatorRequirements {
	return {
		judge: tasks.some((task) => (task.effectiveGraders ?? task.graders ?? []).some((grader) => grader.type === "judge")),
		simulatedUser: tasks.some((task) => task.simulatedUser !== undefined),
	};
}

/** Evaluator credentials only gate a run when the selected development surface calls them. */
function evaluatorRequirementsOf(inventory: WorkbenchInventory): EvaluatorRequirements {
	let tasks: readonly EvaluatorRequirementTask[] = inventory.target?.tasks ?? [];
	const focusedDraft = inventory.validFocus["corpus-draft"]?.id;
	const draft = focusedDraft ? inventory.corpusDrafts.find((item) => item.id === focusedDraft) : null;
	if (draft) return requirementsOf(draft.tasks);

	const focusedCorpus = inventory.validFocus["development-corpus"]?.id;
	const lineageIds = [...inventory.developmentLineage.keys()];
	const corpusId = focusedCorpus && inventory.developmentLineage.has(focusedCorpus)
		? focusedCorpus
		: lineageIds.length === 1
			? lineageIds[0]
			: null;
	if (corpusId) {
		try {
			const corpus = loadCorpus({
				stateRoot: inventory.stateRoot,
				projectId: inventory.projectId,
				corpusId,
			});
			tasks = corpus.tasks;
		} catch {
			// Inventory already reports corpus integrity failures. Readiness remains
			// conservative through that blocker without deriving claims from bad data.
		}
	}
	return requirementsOf(tasks);
}

function targetModelSummary(
	inventory: WorkbenchInventory,
	env: NodeJS.ProcessEnv,
): WorkbenchView["target"]["model"] {
	return modelSummary(inventory.target?.manifest.model, env);
}

/** What the suite measures WITH: the judge, and the model that plays the user. */
function evaluatorSummaries(
	inventory: WorkbenchInventory,
	env: NodeJS.ProcessEnv,
): WorkbenchView["target"]["evaluators"] {
	return {
		judge: modelSummary(inventory.target?.manifest.evalSuite.judge, env),
		simulatedUser: modelSummary(inventory.target?.manifest.evalSuite.simulatedUser, env),
	};
}

/**
 * Newest calibration of the exact revision the Target sits on. Calibration
 * expires with the revision: an older A/A run describes another harness.
 */
function calibrationOf(inventory: WorkbenchInventory): WorkbenchCalibrationProjection | null {
	const gitSha = inventory.target?.gitSha;
	if (!gitSha) return null;
	for (const record of inventory.calibrations) {
		if (record.baseline.sha !== gitSha) continue;
		const projection = calibrationProjection(record);
		if (projection) return projection;
	}
	return null;
}

/**
 * How often each sealed holdout has already judged a candidate. Repeated use
 * erodes a holdout; the warning counts uses and never names the corpus.
 */
const MAX_SEALED_EXPOSURE = 5;

function sealedExposureWarnings(inventory: WorkbenchInventory): string[] {
	const uses = new Map<string, number>();
	for (const candidate of inventory.candidates) {
		if (candidate.projectId !== inventory.projectId) continue;
		const evaluated = candidate.events.find((event) => event.type === "evaluated");
		if (evaluated?.type !== "evaluated") continue;
		const corpusId = evaluated.evaluation.sealedHoldout?.corpus?.id;
		if (!corpusId) continue;
		uses.set(corpusId, (uses.get(corpusId) ?? 0) + 1);
	}
	return [...uses.values()]
		.filter((count) => count > MAX_SEALED_EXPOSURE)
		.sort((left, right) => right - left)
		.map((count) => `A sealed holdout has been used in ${count} candidate verifications; consider refreshing it`);
}

export function deriveWorkbenchView(
	inventory: WorkbenchInventory,
	env: NodeJS.ProcessEnv = process.env,
): WorkbenchView {
	const specs = inventory.specs.slice(0, MAX_VIEW_ITEMS);
	const drafts = inventory.corpusDrafts.slice(0, MAX_VIEW_ITEMS);
	const development = inventory.corpora.filter((corpus) => corpus.visibility === "development").slice(0, MAX_VIEW_ITEMS);
	const evals = inventory.developmentEvals.slice(0, MAX_VIEW_ITEMS);
	const proposals = inventory.proposals.slice(0, MAX_VIEW_ITEMS);
	const candidates = inventory.candidates.slice(0, MAX_VIEW_ITEMS);
	const state = stageFor(inventory);
	const evaluatorRequirements = evaluatorRequirementsOf(inventory);
	return {
		schemaVersion: 1,
		project: { id: inventory.projectId, directory: basename(inventory.projectDir) },
		stage: state.stage,
		headline: state.headline,
		target: inventory.target
			? {
				status: targetBootstrapRequired(inventory.target.manifest) ? "bootstrap-required" : "ready",
				id: inventory.target.manifest.id,
				gitSha: inventory.target.gitSha,
				model: targetModelSummary(inventory, env),
				evaluators: evaluatorSummaries(inventory, env),
				evaluatorRequirements,
				toolCredentials: toolCredentialReadiness(inventory.target, env)
					.map((entry) => ({ tool: entry.tool, environment: entry.environmentName, present: entry.present })),
			}
			: {
				status: "missing",
				id: null,
				gitSha: null,
				model: null,
				evaluators: { judge: null, simulatedUser: null },
				evaluatorRequirements: { judge: false, simulatedUser: false },
				toolCredentials: [],
			},
		focus: Object.fromEntries(Object.entries(inventory.validFocus).map(([kind, entry]) => [kind, entry?.id])),
		selections: [
			...specs.map((spec) => selection(
				spec.status === "draft" ? "spec-draft" : "approved-spec",
				spec.id,
				spec.spec.title,
				inventory,
				spec.status === "approved" && !inventory.verifiedApprovedSpecIds.has(spec.id) ? "unverified" : spec.status,
			)),
			...drafts.map((draft) => selection("corpus-draft", draft.id, `${draft.name} · ${draft.tasks.length} tasks`, inventory, draft.parentDraftId ? "revision" : "initial")),
			...development.map((corpus) => selection("development-corpus", corpus.id, `${corpus.name} · ${corpus.taskCount} tasks`, inventory, inventory.developmentLineage.has(corpus.id) ? "reviewed" : "unbound")),
			...evals.map((run) => selection("eval-run", run.evalRunId, `${run.summary.pass}/${run.summary.total} passed`, inventory, run.summary.error > 0 ? "inconclusive" : "complete")),
			...proposals.map((proposal) => selection("proposal", proposal.record.runId, proposal.record.result.proposal?.summary ?? proposal.record.runId, inventory, proposal.status)),
			...candidates.map((candidate) => selection(
				"candidate",
				candidate.candidateId,
				candidate.proposalId,
				inventory,
				inventory.abandonedCandidates.has(candidate.candidateId)
					? "abandoned"
					: inventory.continuedCandidates.has(candidate.candidateId)
					? `${candidateStatus(candidate)} · cycle closed`
					: inventory.adoptedCandidates.has(candidate.candidateId)
					? "promoted · adopted"
					: candidateStatus(candidate),
			)),
		],
		// Offered where it is the answer to something and nowhere else: only when
		// there is no exam at all, and only at a stage that can act on it. An
		// underpowered or unavailable exam is repaired, not replaced by a guess.
		actions: inventory.sealedHoldoutReadiness === "missing" &&
				workbenchDecisionStages("generate-holdout").includes(state.stage)
			? [...state.actions, "generate-holdout"]
			: state.actions,
		blockers: state.blockers.map((entry) => entry.text),
		blockerReasons: state.blockers.map((entry) => entry.reason),
		warnings: [...inventory.warnings, ...sealedExposureWarnings(inventory)],
		shippingReadiness: {
			sealedHoldout: inventory.sealedHoldoutReadiness,
			minimumTasks: SEALED_GATE_POLICY.minTasks,
			sealedCases: inventory.sealedHoldoutCases,
		},
		calibration: calibrationOf(inventory),
		counts: {
			specDrafts: inventory.specs.filter((spec) => spec.status === "draft").length,
			approvedSpecs: inventory.verifiedApprovedSpecIds.size,
			corpusDrafts: inventory.corpusDrafts.length,
			developmentCorpora: inventory.developmentLineage.size,
			sealedCorpora: inventory.corpora.filter((corpus) => corpus.visibility === "sealed").length,
			developmentEvals: inventory.developmentEvals.length,
			openProposals: inventory.proposals.filter((proposal) =>
				proposal.status === "open" || proposal.status === "apply-pending" || proposal.status === "discard-pending"
			).length,
			candidates: inventory.candidates.length,
			calibrations: inventory.calibrations.length,
		},
	};
}
