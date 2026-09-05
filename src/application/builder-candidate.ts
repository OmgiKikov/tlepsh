import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadCorpus, type CorpusRef } from "../corpus.js";
import { loadDiagnosis } from "../diagnosis.js";
import { CandidateOriginSchema, type CandidateArtifactRef } from "../domain/candidate.js";
import { loadVerifiedEvalRun } from "../eval.js";
import type { RunEventListener } from "../run-events.js";
import { loadApprovedSpec } from "../spec.js";
import { hashValue } from "../provenance.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";
import { writeTextArtifact } from "../storage/artifacts.js";
import { portableCandidateArtifact } from "./candidate-artifacts.js";
import { loadImprovementExperimentDesign } from "./improvement-experiment-design.js";
import type { CandidateExperimentResult } from "./candidate-experiment.js";
import { runCandidateExperiment } from "./candidate-experiment.js";
import {
	loadBuilderApplyReceipt,
	loadBuilderProposalRunEnvelope,
	verifyBuilderProposalRunEvidence,
} from "./builder-proposal.js";

export interface RunAppliedBuilderCandidateOptions {
	repositoryDir: string;
	runsRoot: string;
	builderRunId: string;
	/** Exact Builder record confirmed by the host before evaluation. */
	expectedBuilderRunHash?: string;
	/** Exact apply receipt confirmed by the host before evaluation. */
	expectedApplyReceiptHash?: string;
	projectId: string;
	approvedSpec?: { stateRoot: string; specId: string };
	repetitions: number;
	dataset?: string;
	developmentCorpus?: CorpusRef;
	/**
	 * Optional unseen arm for an automatic hypothesis search. The Builder source
	 * remains bound to developmentCorpus; the matched experiment runs here.
	 */
	validationCorpus?: CorpusRef;
	/** Immutable host design proving how authoring and validation were separated. */
	experimentDesignPath?: string;
	sealedCorpus?: CorpusRef;
	candidateId?: string;
	actorId?: string;
	/** Host-only live events for development evaluation; never used for sealed holdouts. */
	onRunEvent?: RunEventListener;
	/** Host-owned cancellation for the complete candidate experiment. */
	signal?: AbortSignal;
	/** Concurrent executions inside each suite. Undefined keeps runSuite's default. */
	jobs?: number;
	/** How old a reusable baseline may be. Undefined keeps the seven-day default. */
	baselineMaxAgeMs?: number;
	/** Exact original validation baseline for bounded automatic selection. */
	pinnedDevelopmentBaseline?: { evalRunId: string; hash: string };
}

/**
 * Close the provenance chain from an immutable Builder run and human apply
 * receipt into the canonical exact-ref Candidate Experiment.
 */
export async function runAppliedBuilderCandidate(
	options: RunAppliedBuilderCandidateOptions,
): Promise<CandidateExperimentResult> {
	if (!options.approvedSpec) {
		throw new Error("an applied Builder candidate requires an exact approved Spec snapshot");
	}
	const runsRoot = resolve(options.runsRoot);
	const artifactRef = (path: string): CandidateArtifactRef => portableCandidateArtifact(runsRoot, path);
	const validationCorpus = options.validationCorpus ? loadCorpus(options.validationCorpus) : null;
	if (validationCorpus && validationCorpus.metadata.visibility !== "development") {
		throw new Error("candidate validation requires a development corpus");
	}
	if ((validationCorpus === null) !== (options.experimentDesignPath === undefined)) {
		throw new Error("blind validation corpus and experiment design must be supplied together");
	}
	const experimentDesign = options.experimentDesignPath
		? loadImprovementExperimentDesign(options.experimentDesignPath)
		: null;
	const experimentDesignArtifact = options.experimentDesignPath
		? artifactRef(options.experimentDesignPath)
		: null;
	const builderArtifact = (name: string) => resolveContainedArtifactPath(
		runsRoot,
		"builders",
		options.builderRunId,
		name,
	);
	const builderRun = loadBuilderProposalRunEnvelope(options.runsRoot, options.builderRunId);
	if (
		options.expectedBuilderRunHash !== undefined &&
		hashValue(builderRun) !== options.expectedBuilderRunHash
	) {
		throw new Error("Builder proposal changed after confirmation; candidate verification is stale");
	}
	verifyBuilderProposalRunEvidence(options.runsRoot, builderRun);
	const receipt = loadBuilderApplyReceipt(options.runsRoot, options.builderRunId);
	if (
		options.expectedApplyReceiptHash !== undefined &&
		hashValue(receipt) !== options.expectedApplyReceiptHash
	) {
		throw new Error("Builder apply receipt changed after confirmation; candidate verification is stale");
	}
	const builderRunArtifact = artifactRef(builderArtifact("builder_run.json"));
	const builderInputArtifact = artifactRef(builderArtifact("builder_input.txt"));
	const proposalArtifact = artifactRef(builderArtifact("proposal.json"));
	const receiptArtifact = artifactRef(builderArtifact("apply_receipt.json"));
	if (builderRun.request.provenanceMode !== "canonical") {
		throw new Error("applied Builder candidate requires a canonical Builder run; caller-supplied bundles are non-promotable");
	}
	if (builderRun.request.source !== null && builderRun.request.proposalBasis === null) {
		throw new Error("legacy source-backed proposals without an attested failure-mode basis are non-promotable");
	}
	if (builderRun.result.status !== "completed" || !builderRun.artifacts.proposal) {
		throw new Error(`builder run ${options.builderRunId} has no completed proposal`);
	}
	if (receipt.runId !== builderRun.runId) throw new Error("builder apply receipt belongs to a different run");
	if (receipt.baseTargetSha !== builderRun.request.baseTargetSha) {
		throw new Error("builder apply receipt baseline does not match proposal evidence");
	}
	if (receipt.proposalSha256 !== builderRun.artifacts.proposal.sha256) {
		throw new Error("builder apply receipt proposal hash does not match proposal evidence");
	}
	if (proposalArtifact.sha256 !== builderRun.artifacts.proposal.sha256) {
		throw new Error("proposal artifact hash does not match immutable Builder evidence");
	}
	if (
		builderInputArtifact.sha256 !== builderRun.artifacts.input.sha256 ||
		builderRun.request.approvedSpec === null
	) {
		throw new Error("applied Builder candidate requires exact approved-Spec Builder input evidence");
	}
	if (options.actorId && options.actorId !== receipt.actor.id) {
		throw new Error(
			`candidate actor ${options.actorId} does not match apply-receipt human ${receipt.actor.id}`,
		);
	}

	let source: {
		evalRunId: string;
		evalRun: CandidateArtifactRef;
		diagnosisId: string;
		diagnosis: CandidateArtifactRef;
		dataset: string;
		datasetHash: string;
		suiteHash: string;
		developmentCorpus: { id: string; hash: string } | null;
	} | null = null;
	let expectedDevelopmentSource: {
		dataset: string;
		datasetHash: string;
		suiteHash: string;
	} | undefined;
	if (builderRun.request.source) {
		const attestation = builderRun.request.sourceAttestation;
		if (!attestation) throw new Error("canonical Builder source is missing its exact source attestation");
		const verifiedSource = loadVerifiedEvalRun(runsRoot, builderRun.request.source.evalRunId);
		if (!verifiedSource.hasRunHashes) {
			throw new Error("canonical Builder source eval must hash-anchor every member run");
		}
		const sourceEval = verifiedSource.record;
		if (sourceEval.target.gitSha !== builderRun.request.baseTargetSha) {
			throw new Error("Builder source eval revision does not match the proposal base revision");
		}
		const diagnosis = loadDiagnosis(runsRoot, builderRun.request.source.evalRunId);
		if (
			diagnosis.diagnosisId !== builderRun.request.source.diagnosisId ||
			diagnosis.evalRunId !== sourceEval.evalRunId ||
			diagnosis.targetId !== sourceEval.target.id ||
			diagnosis.targetRevision !== sourceEval.target.gitSha
		) {
			throw new Error("Builder diagnosis evidence is misattributed to its source eval");
		}
		const evalRunArtifact = artifactRef(join(runsRoot, sourceEval.evalRunId, "eval_run.json"));
		const diagnosisArtifact = artifactRef(join(runsRoot, sourceEval.evalRunId, "diagnosis.json"));
		if (
			attestation.evalRunId !== sourceEval.evalRunId ||
			attestation.diagnosisId !== diagnosis.diagnosisId ||
			attestation.targetId !== sourceEval.target.id ||
			attestation.targetGitSha !== sourceEval.target.gitSha ||
			attestation.evalRunSha256 !== evalRunArtifact.sha256 ||
			attestation.diagnosisSha256 !== diagnosisArtifact.sha256 ||
			attestation.dataset !== sourceEval.dataset ||
			attestation.datasetHash !== sourceEval.datasetHash ||
			attestation.suiteHash !== sourceEval.suiteHash
		) {
			throw new Error("canonical Builder source attestation does not match its verified eval/diagnosis artifacts");
		}
		if (attestation.developmentCorpus) {
			if (!options.developmentCorpus) {
				throw new Error("candidate must use the exact development corpus supplied to the Builder");
			}
			const corpus = loadCorpus(options.developmentCorpus);
			if (
				corpus.metadata.visibility !== "development" ||
				corpus.metadata.id !== attestation.developmentCorpus.id ||
				corpus.metadata.hash !== attestation.developmentCorpus.hash
			) {
				throw new Error("candidate development corpus does not match the canonical Builder source attestation");
			}
		} else if (options.developmentCorpus) {
			throw new Error("candidate cannot replace the Builder's manifest development surface with a corpus");
		}
		if (validationCorpus) {
			if (!attestation.developmentCorpus) {
				throw new Error("blind validation requires a corpus-backed Builder source");
			}
			if (validationCorpus.metadata.id === attestation.developmentCorpus.id) {
				throw new Error("blind validation cannot reuse the Builder's authoring corpus");
			}
			const authoringTaskIds = new Set(sourceEval.taskIds ?? []);
			if (authoringTaskIds.size === 0) {
				throw new Error("blind validation requires exact authoring task ids in the source eval");
			}
			if (validationCorpus.tasks.some((task) => authoringTaskIds.has(task.id))) {
				throw new Error("blind validation cases overlap the Builder's authoring evidence");
			}
			if (
				!experimentDesign ||
				experimentDesign.projectId !== options.projectId ||
				experimentDesign.authoringCorpus.id !== attestation.developmentCorpus.id ||
				experimentDesign.authoringCorpus.hash !== attestation.developmentCorpus.hash ||
				experimentDesign.validationCorpus.id !== validationCorpus.metadata.id ||
				experimentDesign.validationCorpus.hash !== validationCorpus.metadata.hash ||
				JSON.stringify(experimentDesign.authoringTaskIds) !== JSON.stringify(sourceEval.taskIds) ||
				JSON.stringify(experimentDesign.validationTaskIds) !== JSON.stringify(validationCorpus.tasks.map((task) => task.id))
			) {
				throw new Error("blind validation corpora do not match the immutable experiment design");
			}
		}
		source = {
			evalRunId: sourceEval.evalRunId,
			evalRun: evalRunArtifact,
			diagnosisId: diagnosis.diagnosisId,
			diagnosis: diagnosisArtifact,
			dataset: attestation.dataset,
			datasetHash: attestation.datasetHash,
			suiteHash: attestation.suiteHash,
			developmentCorpus: attestation.developmentCorpus,
		};
		if (!validationCorpus) {
			expectedDevelopmentSource = {
				dataset: sourceEval.dataset,
				datasetHash: sourceEval.datasetHash,
				suiteHash: sourceEval.suiteHash,
			};
		}
	} else if (builderRun.request.sourceAttestation !== null) {
		throw new Error("canonical Spec-only Builder run unexpectedly contains source attestation evidence");
	}

	const loadedSpec = loadApprovedSpec({
		stateRoot: options.approvedSpec.stateRoot,
		projectId: options.projectId,
		specId: options.approvedSpec.specId,
	});
	const spec = loadedSpec.snapshot;
	if (JSON.stringify(loadedSpec.reference) !== JSON.stringify(builderRun.request.approvedSpec)) {
		throw new Error("candidate approved Spec differs from the exact Spec supplied to the Builder");
	}
	const sourceSpecPath = resolveContainedArtifactPath(
		options.approvedSpec.stateRoot,
		"projects",
		options.projectId,
		"specs",
		`${spec.id}.json`,
	);
	const specPath = builderArtifact("approved_spec.json");
	const specBytes = readFileSync(sourceSpecPath);
	if (!existsSync(specPath)) writeTextArtifact(specPath, specBytes.toString("utf8"), { immutable: true });
	const specArtifact = artifactRef(specPath);
	if (!readFileSync(specPath).equals(specBytes)) throw new Error("candidate approved Spec copy differs from the exact approved snapshot");
	const origin = CandidateOriginSchema.parse({
		kind: "applied-builder",
		builderRunId: builderRun.runId,
		builderRun: builderRunArtifact,
		builderInput: builderInputArtifact,
		proposal: proposalArtifact,
		applyReceipt: receiptArtifact,
		application: {
			actor: receipt.actor,
			// Carried through verbatim: a candidate the loop applied says so for the
			// rest of its life, including in the ship dialog.
			...(receipt.via ? { via: receipt.via } : {}),
			reason: receipt.reason,
			appliedAt: receipt.appliedAt,
			baseTargetSha: receipt.baseTargetSha,
			candidateSha: receipt.candidateSha,
			proposalSha256: receipt.proposalSha256,
		},
		source,
		...(experimentDesignArtifact ? { experimentDesign: experimentDesignArtifact } : {}),
		approvedSpec: {
			specId: spec.id,
			projectId: spec.projectId,
			specContentHash: loadedSpec.reference.specContentHash,
			snapshotHash: loadedSpec.reference.snapshotHash,
			artifact: specArtifact,
		},
	});
	return runCandidateExperiment({
		repositoryDir: options.repositoryDir,
		runsRoot: options.runsRoot,
		baselineRef: receipt.baseTargetSha,
		candidateRef: receipt.candidateSha,
		mode: "candidate",
		repetitions: options.repetitions,
		dataset: options.dataset,
		developmentCorpus: options.validationCorpus ?? options.developmentCorpus,
		expectedDevelopmentSource,
		candidateId: options.candidateId,
		projectId: options.projectId,
		specId: spec.id,
		proposalId: builderRun.runId,
		diagnosisId: source?.diagnosisId ?? null,
		actorId: receipt.actor.id,
		origin,
		manifestChangePolicy: builderRun.request.manifestChangePolicy,
		sealedCorpus: options.sealedCorpus,
		...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
		...(options.signal ? { signal: options.signal } : {}),
		...(options.jobs === undefined ? {} : { jobs: options.jobs }),
		...(options.baselineMaxAgeMs === undefined ? {} : { baselineMaxAgeMs: options.baselineMaxAgeMs }),
		...(options.pinnedDevelopmentBaseline ? { pinnedDevelopmentBaseline: options.pinnedDevelopmentBaseline } : {}),
	});
}
