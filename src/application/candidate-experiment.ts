import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { compareEvalRuns, type CompareResult } from "../compare.js";
import { loadCorpus, type CorpusRef, type LoadedCorpus } from "../corpus.js";
import {
	CandidateRecordSchema,
	ComparisonGateEvidenceSchema,
	candidateStatus,
	createCandidate,
	transitionCandidate,
	type CandidateRecord,
	type CandidateOrigin,
	type ComparisonGateEvidence,
	type ExperimentMode,
} from "../domain/candidate.js";
import {
	findReusableBaseline,
	runSuite,
	type EvalRunRecord,
	type ReusableBaselineQuery,
} from "../eval.js";
import {
	withExperimentWorktrees,
	type ExperimentWorktreePair,
} from "../git/experiment-worktree.js";
import { loadTarget, type ResolvedTarget } from "../manifest.js";
import {
	axisDifferences,
	executionFingerprint,
	hashValue,
	modelFingerprint,
	provenanceAxes,
	type ProvenanceAxes,
} from "../provenance.js";
import { writeJsonArtifact } from "../storage/artifacts.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";
import { buildExecutionPolicy } from "../execution-policy.js";
import { createTargetToolRuntime, targetFilesystemConfinement } from "../target/runtime.js";
import { computeTargetWorkspaceHash } from "../runner.js";
import {
	targetEvalSurface,
	targetWithDevelopmentCorpus,
	targetWithSealedCorpus,
} from "./corpus-target.js";
import { assertResourceOnlyManifestChange, parseStrictTargetManifest } from "./builder-proposal.js";

export const CANDIDATE_SCOPE_POLICY = {
	id: "candidate-harness-resources-v2",
	allowed: ["AGENTS.md", "manifest.yaml", "skills/**", "bin/**", "tools/**"],
} as const;

export const DEVELOPMENT_GATE_POLICY_ID = "development-comparable-v1" as const;
export const SEALED_GATE_POLICY_ID = "sealed-no-regression-v1" as const;
export const AA_SEALED_GATE_POLICY_ID = "sealed-aa-recorded-v1" as const;

export interface CandidateExperimentOptions {
	repositoryDir: string;
	runsRoot: string;
	baselineRef: string;
	candidateRef: string;
	mode: ExperimentMode;
	repetitions: number;
	dataset?: string;
	candidateId?: string;
	projectId?: string;
	specId?: string;
	proposalId?: string;
	diagnosisId?: string | null;
	actorId?: string;
	origin?: CandidateOrigin;
	developmentCorpus?: CorpusRef;
	/** Exact source-eval surface that a Builder proposal was derived from. */
	expectedDevelopmentSource?: {
		dataset: string;
		datasetHash: string;
		suiteHash: string;
	};
	sealedCorpus?: CorpusRef;
}

export interface CandidateExperimentHoldoutResult {
	corpusId: string;
	corpusHash: string;
	baseline: EvalRunRecord;
	candidate: EvalRunRecord;
	compare: CompareResult;
	baselineReused: boolean;
}

export interface CandidateExperimentResult {
	record: CandidateRecord;
	baseline: EvalRunRecord;
	candidate: EvalRunRecord;
	compare: CompareResult;
	changedFiles: string[];
	baselineReused: boolean;
	developmentCorpus: { id: string; hash: string } | null;
	sealedHoldout: CandidateExperimentHoldoutResult | null;
	designHash: string;
	/** Durable path only; detached worktree paths are deliberately not exposed. */
	candidateRecordPath: string;
}

export interface CandidateExperimentDependencies {
	withWorktrees: typeof withExperimentWorktrees;
	loadTarget: typeof loadTarget;
	runSuite: typeof runSuite;
	findReusableBaseline: typeof findReusableBaseline;
	compareEvalRuns: typeof compareEvalRuns;
	loadCorpus: typeof loadCorpus;
	now: () => string;
}

const DEFAULT_DEPENDENCIES: CandidateExperimentDependencies = {
	withWorktrees: withExperimentWorktrees,
	loadTarget,
	runSuite,
	findReusableBaseline,
	compareEvalRuns,
	loadCorpus,
	now: () => new Date().toISOString(),
};

export class CandidateExperimentError extends Error {
	readonly candidateRecordPath: string;

	constructor(message: string, candidateRecordPath: string, options?: ErrorOptions) {
		super(`${message}; validated candidate record: ${candidateRecordPath}`, options);
		this.name = "CandidateExperimentError";
		this.candidateRecordPath = candidateRecordPath;
	}
}

export class CandidateDevelopmentSurfaceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CandidateDevelopmentSurfaceError";
	}
}

function changedFiles(repositoryDir: string, baselineSha: string, candidateSha: string): string[] {
	const output = execFileSync(
		"git",
		["-C", repositoryDir, "diff", "--no-renames", "--name-only", "-z", baselineSha, candidateSha, "--"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	return output.split("\0").filter(Boolean).sort();
}

function isAllowedCandidatePath(path: string): boolean {
	return path === "AGENTS.md" || path === "manifest.yaml" || ["skills/", "bin/", "tools/"].some((prefix) => path.startsWith(prefix));
}

function validateScope(mode: ExperimentMode, files: string[]): void {
	const violations = files.filter((path) => !isAllowedCandidatePath(path));
	if (violations.length > 0) {
		throw new Error(`candidate scope violation: ${violations.join(", ")}`);
	}
	if (mode === "candidate" && files.length === 0) {
		throw new Error("candidate mode requires a non-empty harness diff");
	}
	if (mode === "aa-calibration" && files.length !== 0) {
		throw new Error("A/A calibration requires an empty diff");
	}
}

function effectiveProvenance(target: ResolvedTarget): ProvenanceAxes {
	const scratch = mkdtempSync(join(tmpdir(), "ahde-execution-probe-"));
	try {
		const policy = buildExecutionPolicy({
			workspaceDir: target.dir,
			scratchDir: scratch,
			policy: target.manifest.execution,
			environment: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				LANG: process.env.LANG ?? "C.UTF-8",
				HOME: join(scratch, "home"),
				TMPDIR: join(scratch, "tmp"),
			},
		});
		const targetTools = createTargetToolRuntime({
			target,
			workspaceDir: target.dir,
			scratchDir: scratch,
		});
		const processCapableTools = [
			...target.manifest.execution.tools,
			...targetTools.toolNames,
		];
		const sandbox = target.tools.length > 0
			? targetTools.sandboxBackend ?? "unavailable"
			: policy.sandboxBackend;
		return provenanceAxes({
			runtime: target.runtime,
			model: modelFingerprint(target.manifest.model),
			judge: target.manifest.evalSuite.judge ? modelFingerprint(target.manifest.evalSuite.judge) : null,
			execution: executionFingerprint("isolated", {
				// Target-owned tool identity is target revision/toolset provenance,
				// not an execution axis: adding a candidate tool must remain comparable.
				tools: [...target.manifest.execution.tools],
				environment: [...policy.effectiveEnvironmentNames],
				sandbox,
				network: target.manifest.execution.network,
				filesystem: targetFilesystemConfinement({ workspaceMode: "isolated", toolNames: processCapableTools, sandbox }),
			}),
			eval: { suiteHash: target.suiteHash, datasetHash: target.datasetHash },
		});
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function isExactReusableBaseline(record: EvalRunRecord, query: ReusableBaselineQuery): boolean {
	return (
		record.label === (query.label ?? "baseline") &&
		record.target.id === query.targetId &&
		record.target.gitSha === query.targetGitSha &&
		(query.toolsetHash === undefined || record.target.toolsetHash === query.toolsetHash) &&
		(query.workspaceHash === undefined || record.target.workspaceHash === query.workspaceHash) &&
		(query.repetitions === undefined || record.repetitions === query.repetitions) &&
		axisDifferences(record.provenance, query.provenance).length === 0
	);
}

function persistCandidate(path: string, record: CandidateRecord, immutable = false): void {
	const validated = CandidateRecordSchema.parse(record);
	writeJsonArtifact(path, CandidateRecordSchema, validated, immutable ? { immutable: true } : undefined);
}

function assertResolvedTarget(target: ResolvedTarget, worktree: { sha: string }, label: string): void {
	if (target.gitSha !== worktree.sha) {
		throw new Error(`${label} target resolved ${target.gitSha}, expected exact worktree SHA ${worktree.sha}`);
	}
}

function designHash(
	worktrees: ExperimentWorktreePair,
	target: ResolvedTarget,
	options: CandidateExperimentOptions,
	developmentCorpus: LoadedCorpus | null,
	sealedCorpus: LoadedCorpus | null,
): string {
	return hashValue({
		schemaVersion: 1,
		baseline: { ref: worktrees.baseline.ref, sha: worktrees.baseline.sha },
		candidate: { ref: worktrees.candidate.ref, sha: worktrees.candidate.sha },
		mode: options.mode,
		repetitions: options.repetitions,
		dataset: target.manifest.evalSuite.dataset,
		scopePolicy: CANDIDATE_SCOPE_POLICY,
		...(developmentCorpus
			? { developmentCorpus: { id: developmentCorpus.metadata.id, hash: developmentCorpus.metadata.hash } }
			: {}),
		...(sealedCorpus
			? { sealedCorpus: { id: sealedCorpus.metadata.id, hash: sealedCorpus.metadata.hash } }
			: {}),
	});
}

function assertExpectedDevelopmentSource(
	target: ResolvedTarget,
	expected: CandidateExperimentOptions["expectedDevelopmentSource"],
): void {
	if (!expected) return;
	const actual = targetEvalSurface(target);
	if (
		actual.dataset !== expected.dataset ||
		actual.datasetHash !== expected.datasetHash ||
		actual.suiteHash !== expected.suiteHash
	) {
		throw new CandidateDevelopmentSurfaceError(
			"Candidate development surface does not match the Builder source eval: " +
				`expected ${expected.dataset}/${expected.datasetHash}/${expected.suiteHash}, ` +
				`got ${actual.dataset}/${actual.datasetHash}/${actual.suiteHash}`,
		);
	}
}

/** Canonical durable digest of a matched comparison and the gate that accepted it. */
export function comparisonGateEvidence(
	compare: CompareResult,
	policyId: string,
	context: Record<string, unknown> = {},
): ComparisonGateEvidence {
	if (compare.status !== "comparable") {
		throw new Error(compare.error ?? `cannot evidence a ${compare.status} comparison`);
	}
	const summary = {
		taskCount: compare.summary.taskCount,
		baselinePassRate: compare.summary.baselinePassRate,
		candidatePassRate: compare.summary.candidatePassRate,
		delta: compare.summary.delta,
		confidence95: { ...compare.summary.confidence95 },
		improved: compare.summary.improved,
		regressed: compare.summary.regressed,
		unchanged: compare.summary.unchanged,
	};
	const comparisonHash = hashValue({
		schemaVersion: 1,
		baselineEvalRunId: compare.a.evalRunId,
		candidateEvalRunId: compare.b.evalRunId,
		status: compare.status,
		rows: compare.rows,
		summary,
	});
	return ComparisonGateEvidenceSchema.parse({
		policyId,
		comparisonHash,
		gateHash: hashValue({ schemaVersion: 1, policyId, comparisonHash, context, passed: true }),
		summary,
	});
}

function infrastructureError(evalRun: EvalRunRecord): string | null {
	return evalRun.summary.error > 0
		? `${evalRun.label} eval ${evalRun.evalRunId} has ${evalRun.summary.error} infrastructure error(s)`
		: null;
}

interface MatchedEvaluationResult {
	baseline: EvalRunRecord;
	candidate: EvalRunRecord;
	compare: CompareResult;
	baselineReused: boolean;
}

async function runMatchedEvaluation(
	dependencies: CandidateExperimentDependencies,
	runsRoot: string,
	baselineTarget: ResolvedTarget,
	candidateTarget: ResolvedTarget,
	baselineSha: string,
	mode: ExperimentMode,
	repetitions: number,
): Promise<MatchedEvaluationResult> {
	const baselineWorkspaceHash = computeTargetWorkspaceHash(baselineTarget, runsRoot);
	const query: ReusableBaselineQuery = {
		targetId: baselineTarget.manifest.id,
		targetGitSha: baselineSha,
		toolsetHash: baselineTarget.toolsetHash,
		workspaceHash: baselineWorkspaceHash,
		provenance: effectiveProvenance(baselineTarget),
		label: "baseline",
		repetitions,
	};
	let baseline = dependencies.findReusableBaseline(runsRoot, query);
	if (baseline && !isExactReusableBaseline(baseline, query)) baseline = null;
	const baselineReused = baseline !== null;
	if (!baseline) {
		baseline = await dependencies.runSuite(baselineTarget, {
			runsRoot,
			label: "baseline",
			repetitions,
			expectedWorkspaceHash: baselineWorkspaceHash,
		});
	}
	const baselineProblem = infrastructureError(baseline);
	if (baselineProblem) throw new Error(baselineProblem);

	const candidate = await dependencies.runSuite(candidateTarget, {
		runsRoot,
		label: "candidate",
		repetitions,
		candidateOf: baselineSha,
		baselineEvalRunId: baseline.evalRunId,
	});
	const candidateProblem = infrastructureError(candidate);
	if (candidateProblem) throw new Error(candidateProblem);

	const compare = dependencies.compareEvalRuns(runsRoot, baseline.evalRunId, candidate.evalRunId, {
		mode,
	});
	if (compare.status !== "comparable") {
		throw new Error(compare.error ?? `${compare.status} candidate comparison`);
	}

	return { baseline, candidate, compare, baselineReused };
}

function holdoutRegression(compare: CompareResult, mode: ExperimentMode): string | null {
	if (mode !== "candidate") return null;
	const regressedTasks = compare.rows.filter((row) => row.delta < 0).map((row) => row.taskId);
	if (regressedTasks.length > 0) {
		return `sealed holdout regressed task(s): ${regressedTasks.join(", ")}`;
	}
	if (compare.summary.delta < 0) {
		return `sealed holdout aggregate delta is negative (${compare.summary.delta})`;
	}
	return null;
}

/**
 * Evaluate exact baseline/candidate revisions without switching the user's
 * checkout. Every use of a detached path remains inside withWorktrees.
 */
export async function runCandidateExperiment(
	options: CandidateExperimentOptions,
	dependencies: Partial<CandidateExperimentDependencies> = {},
): Promise<CandidateExperimentResult> {
	if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
		throw new Error(`repetitions must be a positive integer, got ${options.repetitions}`);
	}
	if (options.mode !== "candidate" && options.mode !== "aa-calibration") {
		throw new Error(`unsupported candidate experiment mode: ${String(options.mode)}`);
	}

	const deps: CandidateExperimentDependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	const repositoryDir = resolve(options.repositoryDir);
	const runsRoot = resolve(options.runsRoot);
	mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
	const candidateId = options.candidateId ?? `candidate-${randomUUID()}`;
	const candidateRecordPath = resolveContainedArtifactPath(runsRoot, "candidates", candidateId, "candidate.json");
	if (options.dataset && options.developmentCorpus) {
		throw new Error("Candidate Experiment cannot combine --dataset with an explicit development corpus");
	}
	const developmentCorpus = options.developmentCorpus ? deps.loadCorpus(options.developmentCorpus) : null;
	if (developmentCorpus && developmentCorpus.metadata.visibility !== "development") {
		throw new Error(
			`development evaluation requires a development corpus, got ${developmentCorpus.metadata.visibility} (${developmentCorpus.metadata.id})`,
		);
	}
	const sealedCorpus = options.sealedCorpus ? deps.loadCorpus(options.sealedCorpus) : null;
	if (sealedCorpus && sealedCorpus.metadata.visibility !== "sealed") {
		throw new Error(
			`candidate holdout requires a sealed corpus, got ${sealedCorpus.metadata.visibility} (${sealedCorpus.metadata.id})`,
		);
	}

	return deps.withWorktrees(
		{
			repositoryDir,
			baselineRef: options.baselineRef,
			candidateRef: options.candidateRef,
			mode: options.mode,
		},
		async (worktrees) => {
			// Pure preflight first: no evaluator may run until scope, both target
			// identities, and any sealed in-memory target clones are validated.
			const files = changedFiles(worktrees.repositoryDir, worktrees.baseline.sha, worktrees.candidate.sha);
			validateScope(options.mode, files);
			if (files.includes("manifest.yaml")) {
				assertResourceOnlyManifestChange(
					parseStrictTargetManifest(
						readFileSync(join(worktrees.baseline.path, "manifest.yaml")),
						"baseline manifest.yaml",
					),
					parseStrictTargetManifest(
						readFileSync(join(worktrees.candidate.path, "manifest.yaml")),
						"candidate manifest.yaml",
					),
				);
			}
			const datasetOverride = options.dataset ? { dataset: options.dataset } : undefined;
			const resolvedBaselineTarget = deps.loadTarget(worktrees.baseline.path, datasetOverride);
			const resolvedCandidateTarget = deps.loadTarget(worktrees.candidate.path, datasetOverride);
			assertResolvedTarget(resolvedBaselineTarget, worktrees.baseline, "baseline");
			assertResolvedTarget(resolvedCandidateTarget, worktrees.candidate, "candidate");
			if (resolvedBaselineTarget.manifest.id !== resolvedCandidateTarget.manifest.id) {
				throw new Error(
					`target id mismatch: baseline=${resolvedBaselineTarget.manifest.id}, candidate=${resolvedCandidateTarget.manifest.id}`,
				);
			}
			const baselineTarget = developmentCorpus
				? targetWithDevelopmentCorpus(resolvedBaselineTarget, developmentCorpus)
				: resolvedBaselineTarget;
			const candidateTarget = developmentCorpus
				? targetWithDevelopmentCorpus(resolvedCandidateTarget, developmentCorpus)
				: resolvedCandidateTarget;
			assertExpectedDevelopmentSource(baselineTarget, options.expectedDevelopmentSource);
			assertExpectedDevelopmentSource(candidateTarget, options.expectedDevelopmentSource);
			const holdoutBaselineTarget = sealedCorpus
				? targetWithSealedCorpus(resolvedBaselineTarget, sealedCorpus)
				: null;
			const holdoutCandidateTarget = sealedCorpus
				? targetWithSealedCorpus(resolvedCandidateTarget, sealedCorpus)
				: null;
			if (holdoutBaselineTarget) {
				assertResolvedTarget(holdoutBaselineTarget, worktrees.baseline, "holdout baseline");
			}
			if (holdoutCandidateTarget) {
				assertResolvedTarget(holdoutCandidateTarget, worktrees.candidate, "holdout candidate");
			}

			const origin: CandidateOrigin = options.origin ?? {
				kind: "manual",
				reason: "manual Candidate Experiment invocation with caller-supplied exact refs",
			};
			const actor = origin.kind === "applied-builder"
				? origin.application.actor
				: { kind: "human" as const, id: options.actorId ?? "local-user" };
			const system = { kind: "system" as const, id: "candidate-experiment" };
			const eventId = (state: string): string => `${candidateId}:${state}`;
			let record = createCandidate({
				candidateId,
				projectId: options.projectId ?? basename(repositoryDir),
				targetId: baselineTarget.manifest.id,
				specId: options.specId ?? null,
				proposalId: options.proposalId ?? "proposal-unspecified",
				diagnosisId: options.diagnosisId ?? null,
				origin,
				mode: options.mode,
				baseline: { ref: worktrees.baseline.ref, sha: worktrees.baseline.sha },
				eventId: eventId("proposed"),
				at: deps.now(),
				actor,
			});
			persistCandidate(candidateRecordPath, record, true);

			record = transitionCandidate(record, {
				type: "built",
				eventId: eventId("built"),
				at: deps.now(),
				actor,
				candidate: { ref: worktrees.candidate.ref, sha: worktrees.candidate.sha },
			});
			persistCandidate(candidateRecordPath, record);

			record = transitionCandidate(record, {
				type: "validated",
				eventId: eventId("validated"),
				at: deps.now(),
				actor: system,
				lineage: {
					baseline: { ref: worktrees.baseline.ref, sha: worktrees.baseline.sha },
					candidate: { ref: worktrees.candidate.ref, sha: worktrees.candidate.sha },
					relation: options.mode === "candidate" ? "descendant" : "same",
				},
				scope: {
					policyId: CANDIDATE_SCOPE_POLICY.id,
					baselineSha: worktrees.baseline.sha,
					candidateSha: worktrees.candidate.sha,
					passed: true,
					changedFiles: files,
					violations: [],
				},
			});
			persistCandidate(candidateRecordPath, record);

			const experimentDesignHash = designHash(
				worktrees,
				baselineTarget,
				options,
				developmentCorpus,
				sealedCorpus,
			);
			try {
				const development = await runMatchedEvaluation(
					deps,
					runsRoot,
					baselineTarget,
					candidateTarget,
					worktrees.baseline.sha,
					options.mode,
					options.repetitions,
				);

				let sealedHoldout: CandidateExperimentHoldoutResult | null = null;
				if (sealedCorpus && holdoutBaselineTarget && holdoutCandidateTarget) {
					const holdout = await runMatchedEvaluation(
						deps,
						runsRoot,
						holdoutBaselineTarget,
						holdoutCandidateTarget,
						worktrees.baseline.sha,
						options.mode,
						options.repetitions,
					);
					const regression = holdoutRegression(holdout.compare, options.mode);
					if (regression) throw new Error(regression);
					sealedHoldout = {
						corpusId: sealedCorpus.metadata.id,
						corpusHash: sealedCorpus.metadata.hash,
						...holdout,
					};
				}

				record = transitionCandidate(record, {
					type: "evaluated",
					eventId: eventId("evaluated"),
					at: deps.now(),
					actor: system,
					evaluation: {
						experimentId: candidateId,
						designHash: experimentDesignHash,
						mode: options.mode,
						development: {
							...(developmentCorpus
								? {
									corpus: {
										id: developmentCorpus.metadata.id,
										hash: developmentCorpus.metadata.hash,
									},
								}
								: {}),
							baseline: {
								evalRunId: development.baseline.evalRunId,
								harness: { ref: worktrees.baseline.ref, sha: worktrees.baseline.sha },
							},
							candidate: {
								evalRunId: development.candidate.evalRunId,
								harness: { ref: worktrees.candidate.ref, sha: worktrees.candidate.sha },
							},
							comparison: comparisonGateEvidence(
								development.compare,
								DEVELOPMENT_GATE_POLICY_ID,
								developmentCorpus
									? {
										corpusId: developmentCorpus.metadata.id,
										corpusHash: developmentCorpus.metadata.hash,
									}
									: {},
							),
						},
						...(sealedHoldout
							? {
								sealedHoldout: {
									corpus: {
										id: sealedHoldout.corpusId,
										hash: sealedHoldout.corpusHash,
									},
									baseline: {
										evalRunId: sealedHoldout.baseline.evalRunId,
										harness: {
											ref: worktrees.baseline.ref,
											sha: worktrees.baseline.sha,
										},
									},
									candidate: {
										evalRunId: sealedHoldout.candidate.evalRunId,
										harness: {
											ref: worktrees.candidate.ref,
											sha: worktrees.candidate.sha,
										},
									},
									comparison: comparisonGateEvidence(
										sealedHoldout.compare,
										options.mode === "candidate" ? SEALED_GATE_POLICY_ID : AA_SEALED_GATE_POLICY_ID,
										{ corpusId: sealedHoldout.corpusId, corpusHash: sealedHoldout.corpusHash },
									),
								},
							}
							: {}),
						infrastructureErrors: 0,
					},
				});
				persistCandidate(candidateRecordPath, record);
				if (candidateStatus(record) !== "evaluated") {
					throw new Error("candidate record did not reach evaluated state");
				}

				return {
					record,
					baseline: development.baseline,
					candidate: development.candidate,
					compare: development.compare,
					changedFiles: files,
					baselineReused: development.baselineReused,
					developmentCorpus: developmentCorpus
						? { id: developmentCorpus.metadata.id, hash: developmentCorpus.metadata.hash }
						: null,
					sealedHoldout,
					designHash: experimentDesignHash,
					candidateRecordPath,
				};
			} catch (error) {
				if (error instanceof CandidateExperimentError) throw error;
				throw new CandidateExperimentError(
					`candidate experiment stopped at validated: ${error instanceof Error ? error.message : String(error)}`,
					candidateRecordPath,
					{ cause: error },
				);
			}
		},
	);
}
