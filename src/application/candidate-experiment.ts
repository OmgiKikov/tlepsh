import { percent } from "../measurement.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { compareEvalRuns, type CompareResult } from "../compare.js";
import { loadCorpus, type CorpusRef, type LoadedCorpus } from "../corpus.js";
import { EXACT_COMPARISON_GATE_ALGORITHM_ID_V4, INFRASTRUCTURE_ERROR_BUDGET, withinInfrastructureBudget } from "../domain/comparison-gate.js";
import {
	harnessScopePaths,
	isDefaultPiHarness,
	matchesHarnessGlob,
	PI_HARNESS_SCOPE_PATHS,
} from "../domain/harness-surface.js";
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
	loadVerifiedEvalRun,
	readEvalRunIndex,
	runSuite,
	type EvalRunRecord,
	type ReusableBaselineQuery,
} from "../eval.js";
import {
	withExperimentWorktrees,
	type ExperimentWorktreePair,
} from "../git/experiment-worktree.js";
import {
	DEFAULT_PI_HARNESS_FILES,
	executionKindOf,
	harnessFilesOf,
	loadTarget,
	type ResolvedTarget,
} from "../manifest.js";
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
import { createTargetToolRuntime, effectiveTargetSandbox, targetFilesystemConfinement } from "../target/runtime.js";
import { computeTargetSnapshotHashes } from "../runner.js";
import type { RunEventListener } from "../run-events.js";
import {
	targetEvalSurface,
	targetWithDevelopmentCorpus,
	targetWithSealedCorpus,
} from "./corpus-target.js";
import {
	assertManifestChangePolicy,
	parseStrictTargetManifest,
	type ManifestChangePolicy,
} from "./builder-proposal.js";

export const CANDIDATE_SCOPE_POLICY = {
	id: "candidate-harness-resources-v3",
	allowed: PI_HARNESS_SCOPE_PATHS,
} as const;

/**
 * What a candidate may change, for THIS Target.
 *
 * The Pi layout used to be the answer everywhere, and for a Pi Target it still
 * is — byte for byte, same policy id, same order, so no existing evidence
 * moves. A Target that declares its own `harness.files` gets that surface
 * instead, under its own policy id: an agent whose behaviour lives in a prompt
 * file cannot be improved by a loop that is only allowed to rewrite `skills/`,
 * and a scope that quietly widened to cover the operator's source code would
 * be a much worse fix than a second policy id.
 *
 * `manifest.yaml` and `data/**` stay in both: the manifest is host-owned and
 * the data directories are declared resources, not the agent's program.
 */
export function candidateScopeFor(
	manifest: Pick<ResolvedTarget["manifest"], "harness">,
): { id: string; allowed: string[] } {
	const declared = harnessFilesOf(manifest);
	return {
		id: isDefaultPiHarness(declared) ? CANDIDATE_SCOPE_POLICY.id : "candidate-declared-harness-v1",
		allowed: harnessScopePaths(declared),
	};
}


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
	/** Immutable Builder-request authority; manual candidates stay resource-only. */
	manifestChangePolicy?: ManifestChangePolicy;
	developmentCorpus?: CorpusRef;
	/** Exact source-eval surface that a Builder proposal was derived from. */
	expectedDevelopmentSource?: {
		dataset: string;
		datasetHash: string;
		suiteHash: string;
	};
	sealedCorpus?: CorpusRef;
	/** Host-only live events for the development pair. Sealed holdout runs never receive it. */
	onRunEvent?: RunEventListener;
	/** Host-owned cancellation propagated through development and sealed executions. */
	signal?: AbortSignal;
	/** Concurrent executions inside each suite. Undefined keeps runSuite's default. */
	jobs?: number;
	/** How old a reusable baseline may be. Undefined keeps the seven-day default. */
	baselineMaxAgeMs?: number;
	/** Host-pinned development baseline; never forwarded to the sealed arm. */
	pinnedDevelopmentBaseline?: { evalRunId: string; hash: string };
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
	/**
	 * Which arm was running when the experiment stopped. A development-phase
	 * reason names only development evidence and may be shown to the Builder;
	 * a sealed-phase reason may carry sealed identities and stays host-only.
	 */
	readonly phase: "development" | "sealed";
	/** The reason alone, without the record path: what a screen may repeat. */
	readonly reason: string;

	constructor(message: string, candidateRecordPath: string, options?: ErrorOptions & { phase?: "development" | "sealed" }) {
		super(`${message}; validated candidate record: ${candidateRecordPath}`, options);
		this.name = "CandidateExperimentError";
		this.candidateRecordPath = candidateRecordPath;
		this.phase = options?.phase ?? "sealed";
		this.reason = message;
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

/**
 * The declared surface of one worktree, for the scope check that runs before
 * anything is loaded. An unreadable manifest is not decided here: it falls back
 * to the Pi layout and fails a few lines later, loudly, in `loadTarget`.
 */
function declaredHarnessAt(worktreePath: string): readonly string[] {
	try {
		return harnessFilesOf(
			parseStrictTargetManifest(readFileSync(join(worktreePath, "manifest.yaml")), "baseline manifest.yaml"),
		);
	} catch {
		return DEFAULT_PI_HARNESS_FILES;
	}
}

function validateScope(mode: ExperimentMode, files: string[], declared: readonly string[]): void {
	// The same scope the proposal was authored under, read through the same
	// matcher. A Target whose harness is `prompts/**` would otherwise be
	// measured only to have its own declared change refused here.
	const allowed = harnessScopePaths(declared);
	const violations = files.filter((path) => !allowed.some((glob) => matchesHarnessGlob(path, glob)));
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

/**
 * Fold a case input to its shape: lowercase, digits removed, every run of
 * non-letters collapsed to one space. Two cases that differ only in a
 * contract number, a date, or punctuation fold to the same key.
 */
function normalizedCaseKey(input: string): string {
	return input
		.toLowerCase()
		.replace(/[0-9]+/gu, "")
		.replace(/[^\p{L}]+/gu, " ")
		.trim();
}

/**
 * A sealed holdout only measures generalization while it stays disjoint from
 * the set the harness was tuned on. Near-twins ("проверь договор №23" vs
 * "проверь договор №42") leak just as badly as exact copies, so the check
 * compares normalized shapes.
 *
 * The error reports counts only: sealed inputs and ids never reach a caller,
 * a log line, or a Builder-visible message.
 */
export function assertHoldoutDisjoint(
	developmentTasks: readonly { input: string }[],
	sealedTasks: readonly { input: string }[],
): void {
	const development = new Set(
		developmentTasks.map((task) => normalizedCaseKey(task.input)).filter((key) => key.length > 0),
	);
	const collisions = sealedTasks
		.map((task) => normalizedCaseKey(task.input))
		.filter((key) => key.length > 0 && development.has(key)).length;
	if (collisions > 0) {
		throw new Error(
			`sealed holdout shares ${collisions} case(s) with the development set after normalization; refresh the holdout`,
		);
	}
}

/**
 * The provenance axes a run of this exact Target would carry, probed without
 * running it. Tests hold this against a real EvalRun axis for axis, and the
 * improvement loop uses it to ask whether evidence it already paid for is still
 * comparable. If this reconstruction drifts, baseline reuse and snapshot
 * verification must fail closed rather than accept a different measurement.
 */
export function effectiveProvenance(target: ResolvedTarget): ProvenanceAxes {
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
		const sandbox = effectiveTargetSandbox({
			hasDeclaredTools: target.tools.length > 0,
			executionPolicy: policy,
			targetTools,
		});
		return provenanceAxes({
			runtime: target.runtime,
			model: modelFingerprint(target.manifest.model),
			judge: target.manifest.evalSuite.judge ? modelFingerprint(target.manifest.evalSuite.judge) : null,
			// The user model travels exactly like the judge: it is half of what a
			// simulated-user suite measures with, and a reconstruction that drops it
			// disagrees with the canonical EvalRun the suite actually wrote — which
			// is a reuse miss and a verification mismatch, not a comparability fact.
			// `undefined` rather than `null` when unconfigured, so every provenance
			// key written before user models existed is byte-for-byte unchanged.
			simulatedUser: target.manifest.evalSuite.simulatedUser
				? modelFingerprint(target.manifest.evalSuite.simulatedUser)
				: undefined,
			execution: executionFingerprint("isolated", {
				// Target-owned tool identity is target revision/toolset provenance,
				// not an execution axis: adding a candidate tool must remain comparable.
				tools: [...target.manifest.execution.tools],
				environment: [...policy.effectiveEnvironmentNames],
				sandbox,
				network: target.manifest.execution.network,
				filesystem: targetFilesystemConfinement({ workspaceMode: "isolated", toolNames: processCapableTools, sandbox }),
				// Which backend will answer. The reconstruction has to name it for
				// the same reason it names the sandbox: a baseline produced by a
				// different agent is not this experiment's baseline.
				agent: executionKindOf(target.manifest.execution) === "command" ? "command-v1" : "pi-v1",
			}),
			eval: { suiteHash: target.suiteHash, datasetHash: target.datasetHash },
		});
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** The reuse seam returns exactly what was asked for, or the experiment stops before spending tokens. */
function assertReusableBaselineIdentity(record: EvalRunRecord, query: ReusableBaselineQuery): void {
	const mismatch =
		record.label !== query.label ? "label" :
		record.target.id !== query.targetId ? "target id" :
		record.target.gitSha !== query.targetGitSha ? "target revision" :
		record.target.toolsetHash !== query.toolsetHash ? "toolset hash" :
		record.target.workspaceHash !== query.workspaceHash ? "workspace hash" :
		record.target.preparedToolHomeHash !== query.preparedToolHomeHash ? "prepared tool-home hash" :
		record.evidenceVisibility !== query.evidenceVisibility ? "evidence visibility" :
		record.repetitions !== query.repetitions ? "repetitions" :
		axisDifferences(record.provenance, query.provenance).length > 0 ? "provenance axes" :
		null;
	if (mismatch) {
		throw new Error(`reusable baseline ${record.evalRunId} does not match its reuse query on ${mismatch}`);
	}
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
		scopePolicy: candidateScopeFor(target.manifest),
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

/** Canonical durable digest of a matched comparison and the verdict the gate decided. */
export function comparisonGateEvidence(
	compare: CompareResult,
	context: Record<string, unknown> = {},
): ComparisonGateEvidence {
	if (!comparisonUsable(compare)) {
		throw new Error(compare.error ?? `cannot evidence a ${compare.status} comparison`);
	}
	if (!compare.a.runArtifacts || !compare.b.runArtifacts) {
		throw new Error("exact comparison gate requires ordered final RunArtifact hashes");
	}
	const summary = {
		taskCount: compare.summary.taskCount,
		baselinePassRate: compare.summary.baselinePassRate,
		candidatePassRate: compare.summary.candidatePassRate,
		delta: compare.summary.delta,
		baselineScore: compare.summary.baselineScore,
		candidateScore: compare.summary.candidateScore,
		scoreDelta: compare.summary.scoreDelta,
		confidence95: { ...compare.summary.confidence95 },
		improved: compare.summary.improved,
		regressed: compare.summary.regressed,
		unchanged: compare.summary.unchanged,
	};
	const rows = [...compare.rows].sort((left, right) =>
		Buffer.compare(Buffer.from(left.taskId, "utf8"), Buffer.from(right.taskId, "utf8")));
	const design = { ...compare.design };
	const flags = { ...compare.flags };
	const resources = {
		baseline: { ...compare.resources.baseline },
		candidate: { ...compare.resources.candidate },
		costRatio: compare.resources.costRatio,
		latencyRatio: compare.resources.latencyRatio,
		tokenRatio: compare.resources.tokenRatio,
	};
	const { policyId, surface, verdict, reasons } = compare.gate;
	const comparisonHash = hashValue({
		schemaVersion: 4,
		algorithmId: EXACT_COMPARISON_GATE_ALGORITHM_ID_V4,
		baselineEvalRunId: compare.a.evalRunId,
		candidateEvalRunId: compare.b.evalRunId,
		status: compare.status,
		policyId,
		surface,
		rows,
		summary,
		design,
		flags,
		resources,
		verdict,
	});
	const evidenceHash = hashValue({
		schemaVersion: 4,
		algorithmId: EXACT_COMPARISON_GATE_ALGORITHM_ID_V4,
		baseline: {
			evalRunHash: hashValue(compare.a),
			signalAnchor: "ordered-run-record-sha256-v1",
			runArtifacts: compare.a.runArtifacts,
		},
		candidate: {
			evalRunHash: hashValue(compare.b),
			signalAnchor: "ordered-run-record-sha256-v1",
			runArtifacts: compare.b.runArtifacts,
		},
	});
	return ComparisonGateEvidenceSchema.parse({
		schemaVersion: 4,
		algorithmId: EXACT_COMPARISON_GATE_ALGORITHM_ID_V4,
		policyId,
		surface,
		comparisonHash,
		evidenceHash,
		gateHash: hashValue({
			schemaVersion: 4,
			algorithmId: EXACT_COMPARISON_GATE_ALGORITHM_ID_V4,
			policyId,
			surface,
			comparisonHash,
			evidenceHash,
			context,
			verdict,
		}),
		summary,
		design,
		verdict,
		flags,
		resources,
		reasons: reasons.slice(0, 8),
	});
}

/**
 * Infrastructure errors within the budget are excluded from the statistics
 * by the gate; above it the evaluation is inconclusive and the experiment
 * stops before spending more tokens.
 */
function infrastructureError(evalRun: EvalRunRecord): string | null {
	const { error, total } = evalRun.summary;
	return withinInfrastructureBudget(error, total)
		? null
		: `${evalRun.label} eval ${evalRun.evalRunId} has ${error} infrastructure error(s) in ${total} runs, over the ${percent(INFRASTRUCTURE_ERROR_BUDGET)} budget`;
}

/** A comparison is usable evidence when it is comparable, or inconclusive only within the error budget. */
export function comparisonUsable(compare: CompareResult): boolean {
	if (compare.status === "comparable") return true;
	if (compare.status !== "inconclusive") return false;
	return withinInfrastructureBudget(compare.design.excludedTasks, compare.design.tasks + compare.design.excludedTasks);
}

interface MatchedEvaluationResult {
	baseline: EvalRunRecord;
	candidate: EvalRunRecord;
	compare: CompareResult;
	baselineReused: boolean;
}

/** Everything the matched pair needs that is not the pair itself. */
interface MatchedEvaluationExecution {
	onRunEvent?: RunEventListener;
	signal?: AbortSignal;
	/** Concurrent executions per suite; undefined keeps runSuite's own default. */
	jobs?: number;
	/** Age limit on a reusable baseline; undefined keeps the seven-day default. */
	baselineMaxAgeMs?: number;
	/** Host-pinned development baseline; never forwarded to the sealed arm. */
	pinnedDevelopmentBaseline?: { evalRunId: string; hash: string };
}

async function runMatchedEvaluation(
	dependencies: CandidateExperimentDependencies,
	runsRoot: string,
	baselineTarget: ResolvedTarget,
	candidateTarget: ResolvedTarget,
	baselineSha: string,
	mode: ExperimentMode,
	repetitions: number,
	evidenceVisibility: "development" | "sealed",
	execution: MatchedEvaluationExecution = {},
): Promise<MatchedEvaluationResult> {
	const { onRunEvent, signal, jobs, baselineMaxAgeMs } = execution;
	const baselineSnapshot = computeTargetSnapshotHashes(baselineTarget, runsRoot);
	const query: ReusableBaselineQuery = {
		targetId: baselineTarget.manifest.id,
		targetGitSha: baselineSha,
		toolsetHash: baselineTarget.toolsetHash,
		workspaceHash: baselineSnapshot.workspaceHash,
		preparedToolHomeHash: baselineSnapshot.preparedToolHomeHash,
		provenance: effectiveProvenance(baselineTarget),
		evidenceVisibility,
		label: "baseline",
		repetitions,
		...(baselineMaxAgeMs === undefined ? {} : { maxAgeMs: baselineMaxAgeMs }),
	};
	let baseline: EvalRunRecord | null;
	if (execution.pinnedDevelopmentBaseline) {
		const pin = execution.pinnedDevelopmentBaseline;
		const index = readEvalRunIndex(runsRoot, pin.evalRunId);
		if (evidenceVisibility !== "development" || index.evidenceVisibility !== "development" || index.purpose !== "evidence" || hashValue(index) !== pin.hash) {
			throw new Error("pinned development baseline changed or is not development evidence");
		}
		assertReusableBaselineIdentity(index, query);
		baseline = loadVerifiedEvalRun(runsRoot, pin.evalRunId).record;
	} else {
		baseline = dependencies.findReusableBaseline(runsRoot, query);
	}
	if (baseline) assertReusableBaselineIdentity(baseline, query);
	const baselineReused = baseline !== null;
	if (!baseline) {
		baseline = await dependencies.runSuite(baselineTarget, {
			runsRoot,
			label: "baseline",
			repetitions,
			evidenceVisibility,
			expectedWorkspaceHash: baselineSnapshot.workspaceHash,
			expectedPreparedToolHomeHash: baselineSnapshot.preparedToolHomeHash,
			...(onRunEvent ? { onRunEvent } : {}),
			...(signal ? { signal } : {}),
			...(jobs === undefined ? {} : { jobs }),
		});
	}
	const baselineProblem = infrastructureError(baseline);
	if (baselineProblem) throw new Error(baselineProblem);

	const candidate = await dependencies.runSuite(candidateTarget, {
		runsRoot,
		label: "candidate",
		repetitions,
		evidenceVisibility,
		candidateOf: baselineSha,
		baselineEvalRunId: baseline.evalRunId,
		...(onRunEvent ? { onRunEvent } : {}),
		...(signal ? { signal } : {}),
		...(jobs === undefined ? {} : { jobs }),
	});
	const candidateProblem = infrastructureError(candidate);
	if (candidateProblem) throw new Error(candidateProblem);

	const compare = dependencies.compareEvalRuns(runsRoot, baseline.evalRunId, candidate.evalRunId, {
		mode,
		surface: evidenceVisibility,
	});
	if (!comparisonUsable(compare)) {
		throw new Error(compare.error ?? `${compare.status} candidate comparison`);
	}

	return { baseline, candidate, compare, baselineReused };
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
			validateScope(options.mode, files, declaredHarnessAt(worktrees.baseline.path));
			if (files.includes("manifest.yaml")) {
				assertManifestChangePolicy(
					parseStrictTargetManifest(
						readFileSync(join(worktrees.baseline.path, "manifest.yaml")),
						"baseline manifest.yaml",
					),
					parseStrictTargetManifest(
						readFileSync(join(worktrees.candidate.path, "manifest.yaml")),
						"candidate manifest.yaml",
					),
					options.manifestChangePolicy ?? "resources-only",
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
			if (holdoutBaselineTarget) {
				assertHoldoutDisjoint(baselineTarget.tasks, holdoutBaselineTarget.tasks);
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
					policyId: candidateScopeFor(resolvedBaselineTarget.manifest).id,
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
			let phase: "development" | "sealed" = "development";
			try {
				const development = await runMatchedEvaluation(
					deps,
					runsRoot,
					baselineTarget,
					candidateTarget,
					worktrees.baseline.sha,
					options.mode,
					options.repetitions,
					"development",
					{
						...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
						...(options.signal ? { signal: options.signal } : {}),
						...(options.jobs === undefined ? {} : { jobs: options.jobs }),
						...(options.baselineMaxAgeMs === undefined ? {} : { baselineMaxAgeMs: options.baselineMaxAgeMs }),
						...(options.pinnedDevelopmentBaseline ? { pinnedDevelopmentBaseline: options.pinnedDevelopmentBaseline } : {}),
					},
				);

				let sealedHoldout: CandidateExperimentHoldoutResult | null = null;
				if (sealedCorpus && holdoutBaselineTarget && holdoutCandidateTarget) {
					phase = "sealed";
					const holdout = await runMatchedEvaluation(
						deps,
						runsRoot,
						holdoutBaselineTarget,
						holdoutCandidateTarget,
						worktrees.baseline.sha,
						options.mode,
						options.repetitions,
						"sealed",
						{
							...(options.signal ? { signal: options.signal } : {}),
							...(options.jobs === undefined ? {} : { jobs: options.jobs }),
							...(options.baselineMaxAgeMs === undefined ? {} : { baselineMaxAgeMs: options.baselineMaxAgeMs }),
						},
					);
					// The sealed verdict is recorded, never thrown: a fail or an
					// underpowered gate is durable evidence the human reviews, and
					// promotion refuses it from the persisted verdict.
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
										{ corpusId: sealedHoldout.corpusId, corpusHash: sealedHoldout.corpusHash },
									),
								},
							}
							: {}),
						infrastructureErrors: development.baseline.summary.error + development.candidate.summary.error +
							(sealedHoldout ? sealedHoldout.baseline.summary.error + sealedHoldout.candidate.summary.error : 0),
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
					{ cause: error, phase },
				);
			}
		},
	);
}
