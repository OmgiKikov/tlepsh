import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { CandidateProposalSchema } from "../builders/adapters.js";
import { compareVerifiedEvalRuns, type CompareResult } from "../compare.js";
import { DiagnosisCategorySchema, DiagnosisRecordSchema } from "../diagnosis.js";
import {
	CandidateRecordSchema, EXACT_COMPARISON_GATE_ALGORITHM_ID, gateVerdictOf,
	type CandidateArtifactRef, type CandidateRecord,
} from "../domain/candidate.js";
import {
	DEVELOPMENT_VERDICTS, EXACT_COMPARISON_GATE_ALGORITHM_ID_V3, EXACT_COMPARISON_GATE_ALGORITHM_ID_V4,
	SEALED_VERDICTS, withinInfrastructureBudget,
	type GateVerdict,
} from "../domain/comparison-gate.js";
import type { EvidenceVisibility, VerifiedEvalRun } from "../eval.js";
import {
	GraderCheckCodeSchema, HashSchema, canonicalJson, hashValue,
	type GraderCheckCode, type RunRecord,
} from "../provenance.js";
import { SpecSnapshotSchema } from "../spec.js";
import { readJsonArtifact } from "../storage/artifacts.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";
import { BuilderApplyReceiptSchema, loadBuilderProposalRun } from "./builder-proposal.js";
import { comparisonGateEvidence } from "./candidate-experiment.js";
import { corpusDatasetLabel } from "./corpus-target.js";
import { compareUtf8, exactSnapshotIdentity, loadExactEvalSnapshot } from "./exact-eval-snapshot.js";
import {
	IMPROVEMENT_BRIEF_ALGORITHM_ID, FailureModeIdSchema,
	compileImprovementBrief, publicTaskId,
} from "./improvement-brief.js";

export const CANDIDATE_IMPACT_ALGORITHM_ID = "exact-candidate-impact-v1" as const;

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_NEW_MODES = 10;
const MAX_TASK_REGRESSIONS = 20;
const MAX_EVIDENCE_PER_ITEM = 3;
const MAX_TASK_IDS_PER_MODE = 12;
const MAX_INCONCLUSIVE_REASONS = 20;
const HASH_HEX_OFFSET = "sha256:".length;

const ArtifactIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
const GitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

export const CandidateImpactFocusSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("summary") }),
	z.strictObject({ kind: z.literal("mode"), failureModeId: FailureModeIdSchema }),
	z.strictObject({ kind: z.literal("run"), runId: ArtifactIdSchema }),
]);
export type CandidateImpactFocus = z.infer<typeof CandidateImpactFocusSchema>;

const EvidenceHandleSchema = z.strictObject({
	handle: z.string().regex(/^eval:[A-Za-z0-9][A-Za-z0-9._-]{0,199}\/run:[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),
	runId: ArtifactIdSchema,
	runSha256: HashSchema,
	taskId: z.string().min(1).max(200),
	side: z.enum(["baseline", "candidate"]),
	outcome: z.enum(["pass", "fail"]),
	traceAvailable: z.boolean(),
});
export type CandidateImpactEvidenceHandle = z.infer<typeof EvidenceHandleSchema>;

const ExactSignatureSchema = z.strictObject({
	kind: z.literal("grader-check"),
	checkCode: GraderCheckCodeSchema,
	discriminatorHash: HashSchema,
});

const OutcomeCountsSchema = z.strictObject({
	failedOccurrences: z.number().int().nonnegative(),
	totalOccurrences: z.number().int().nonnegative(),
	failureRateBps: z.number().int().min(0).max(10_000),
}).superRefine((counts, context) => {
	if (counts.failedOccurrences > counts.totalOccurrences) {
		context.addIssue({ code: "custom", path: ["failedOccurrences"], message: "cannot exceed totalOccurrences" });
	}
	const expected = counts.totalOccurrences === 0
		? 0
		: Math.floor(counts.failedOccurrences * 10_000 / counts.totalOccurrences);
	if (counts.failureRateBps !== expected) {
		context.addIssue({ code: "custom", path: ["failureRateBps"], message: "does not match failed / total occurrences" });
	}
});

const TargetedModeImpactSchema = z.strictObject({
	failureModeId: FailureModeIdSchema,
	modeSha256: HashSchema,
	signature: ExactSignatureSchema,
	category: DiagnosisCategorySchema,
	outcome: z.enum(["resolved", "improved", "persisted", "worsened", "not-reproduced"]),
	baseline: OutcomeCountsSchema,
	candidate: OutcomeCountsSchema,
	sourceAffectedTasks: z.number().int().positive(),
	candidateAffectedTasks: z.number().int().nonnegative(),
	sourceTaskIds: z.array(z.string().min(1).max(200)).max(MAX_TASK_IDS_PER_MODE),
	candidateAffectedTaskIds: z.array(z.string().min(1).max(200)).max(MAX_TASK_IDS_PER_MODE),
	evidence: z.array(EvidenceHandleSchema).max(MAX_EVIDENCE_PER_ITEM),
}).superRefine((mode, context) => {
	if (mode.sourceTaskIds.length > mode.sourceAffectedTasks) {
		context.addIssue({ code: "custom", path: ["sourceTaskIds"], message: "projection exceeds sourceAffectedTasks" });
	}
	if (mode.candidateAffectedTaskIds.length > mode.candidateAffectedTasks) {
		context.addIssue({ code: "custom", path: ["candidateAffectedTaskIds"], message: "projection exceeds candidateAffectedTasks" });
	}
	if (new Set(mode.evidence.map((item) => item.handle)).size !== mode.evidence.length) {
		context.addIssue({ code: "custom", path: ["evidence"], message: "evidence handles must be unique" });
	}
	if (mode.baseline.totalOccurrences > 0 && mode.candidate.totalOccurrences > 0 &&
		(!mode.evidence.some((item) => item.side === "baseline") || !mode.evidence.some((item) => item.side === "candidate"))) {
		context.addIssue({ code: "custom", path: ["evidence"], message: "must represent both sides of a matched mode" });
	}
});
export type TargetedModeImpact = z.infer<typeof TargetedModeImpactSchema>;

const NonTargetedModeImpactSchema = z.strictObject({
	failureModeId: FailureModeIdSchema,
	signature: ExactSignatureSchema,
	category: DiagnosisCategorySchema,
	baseline: OutcomeCountsSchema,
	candidate: OutcomeCountsSchema,
	affectedTasks: z.number().int().positive(),
	affectedTaskIds: z.array(z.string().min(1).max(200)).max(MAX_TASK_IDS_PER_MODE),
	evidence: z.array(EvidenceHandleSchema).min(1).max(MAX_EVIDENCE_PER_ITEM),
}).superRefine((mode, context) => {
	if (mode.affectedTaskIds.length > mode.affectedTasks) {
		context.addIssue({ code: "custom", path: ["affectedTaskIds"], message: "projection exceeds affectedTasks" });
	}
	if (new Set(mode.evidence.map((item) => item.handle)).size !== mode.evidence.length) {
		context.addIssue({ code: "custom", path: ["evidence"], message: "evidence handles must be unique" });
	}
	if (!mode.evidence.some((item) => item.side === "baseline") || !mode.evidence.some((item) => item.side === "candidate")) {
		context.addIssue({ code: "custom", path: ["evidence"], message: "must represent baseline and candidate" });
	}
});
export type CandidateNewFailureMode = z.infer<typeof NonTargetedModeImpactSchema>;

const TaskRegressionSchema = z.strictObject({
	taskId: z.string().min(1).max(200),
	baselinePassRate: z.number().min(0).max(1),
	candidatePassRate: z.number().min(0).max(1),
	delta: z.number().min(-1).negative(),
	evidence: z.array(EvidenceHandleSchema).max(MAX_EVIDENCE_PER_ITEM),
}).superRefine((regression, context) => {
	if (Math.abs(regression.delta - (regression.candidatePassRate - regression.baselinePassRate)) > Number.EPSILON) {
		context.addIssue({ code: "custom", path: ["delta"], message: "must equal candidatePassRate - baselinePassRate" });
	}
});
export type CandidateTaskRegression = z.infer<typeof TaskRegressionSchema>;

const ComparisonSummarySchema = z.strictObject({
	taskCount: z.number().int().nonnegative(),
	baselinePassRate: z.number().min(0).max(1),
	candidatePassRate: z.number().min(0).max(1),
	delta: z.number().min(-1).max(1),
	confidence95: z.strictObject({
		low: z.number().min(-1).max(1),
		high: z.number().min(-1).max(1),
	}),
	improved: z.number().int().nonnegative(),
	regressed: z.number().int().nonnegative(),
	unchanged: z.number().int().nonnegative(),
}).superRefine((summary, context) => {
	if (summary.improved + summary.regressed + summary.unchanged !== summary.taskCount) {
		context.addIssue({ code: "custom", path: ["taskCount"], message: "must equal improved + regressed + unchanged" });
	}
	if (Math.abs(summary.delta - (summary.candidatePassRate - summary.baselinePassRate)) > Number.EPSILON) {
		context.addIssue({ code: "custom", path: ["delta"], message: "must equal candidatePassRate - baselinePassRate" });
	}
});

const FocusResultSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("summary") }),
	z.strictObject({
		kind: z.literal("mode"),
		failureModeId: FailureModeIdSchema,
		role: z.enum(["targeted", "new", "worsened"]),
	}),
	z.strictObject({
		kind: z.literal("run"),
		runId: ArtifactIdSchema,
		side: z.enum(["baseline", "candidate"]),
		taskId: z.string().min(1).max(200),
		repetitionIndex: z.number().int().nonnegative(),
		outcome: z.enum(["pass", "fail", "error"]),
		traceAvailable: z.boolean(),
		failureModeIds: z.array(FailureModeIdSchema).max(100),
	}),
]);

const CandidateImpactBaseSchema = z.strictObject({
	schemaVersion: z.literal(1),
	algorithmId: z.literal(CANDIDATE_IMPACT_ALGORITHM_ID),
	candidateId: ArtifactIdSchema,
	targetId: z.string().min(1).max(200),
	candidateHash: HashSchema,
	verdict: z.enum(["improved", "mixed", "no-change", "regressed", "inconclusive"]),
	inconclusiveReasons: z.array(z.string().min(1).max(500)).max(MAX_INCONCLUSIVE_REASONS),
	development: z.strictObject({
		pair: z.strictObject({
			baseline: z.strictObject({ evalRunId: ArtifactIdSchema, harnessSha: GitShaSchema, evalRunHash: HashSchema }),
			candidate: z.strictObject({ evalRunId: ArtifactIdSchema, harnessSha: GitShaSchema, evalRunHash: HashSchema }),
		}),
		comparison: z.strictObject({
			algorithmId: z.enum([
				EXACT_COMPARISON_GATE_ALGORITHM_ID_V4,
				EXACT_COMPARISON_GATE_ALGORITHM_ID_V3,
				EXACT_COMPARISON_GATE_ALGORITHM_ID,
			]).nullable(),
			policyId: z.string().min(1).max(200),
			comparisonHash: HashSchema,
			evidenceHash: HashSchema.nullable(),
			gateHash: HashSchema,
			verified: z.boolean(),
			/** v3/v4 gate verdict; null for legacy evidence. */
			verdict: z.enum([...DEVELOPMENT_VERDICTS, ...SEALED_VERDICTS]).nullable(),
		}),
		summary: ComparisonSummarySchema,
		/** Candidate-over-baseline resource ratios. Rendered, never gating. */
		resources: z.strictObject({
			costRatio: z.number().nonnegative().nullable(),
			latencyRatio: z.number().nonnegative().nullable(),
			tokenRatio: z.number().nonnegative().nullable(),
		}),
	}),
	proposalBasis: z.strictObject({
		algorithmId: z.literal(IMPROVEMENT_BRIEF_ALGORITHM_ID),
		evalRunId: ArtifactIdSchema,
		diagnosisId: ArtifactIdSchema,
		briefId: z.string().regex(/^brief-[0-9a-f]{24}$/),
		briefSha256: HashSchema,
		basisSha256: HashSchema,
		targetedFailureModes: z.array(TargetedModeImpactSchema).max(8),
	}).nullable(),
	newFailureModes: z.array(NonTargetedModeImpactSchema).max(MAX_NEW_MODES),
	omittedNewFailureModeCount: z.number().int().nonnegative(),
	worsenedFailureModes: z.array(NonTargetedModeImpactSchema).max(MAX_NEW_MODES),
	omittedWorsenedFailureModeCount: z.number().int().nonnegative(),
	taskRegressions: z.array(TaskRegressionSchema).max(MAX_TASK_REGRESSIONS),
	omittedTaskRegressionCount: z.number().int().nonnegative(),
	sealedHoldout: z.strictObject({
		executed: z.boolean(),
		gatePassed: z.boolean(),
		verdict: z.enum([...DEVELOPMENT_VERDICTS, ...SEALED_VERDICTS]).nullable(),
	}),
	focus: FocusResultSchema,
});

export const CandidateImpactSchema = CandidateImpactBaseSchema.extend({
	subjectHash: HashSchema,
}).superRefine((impact, context) => {
	const { subjectHash, ...subject } = impact;
	if (subjectHash !== hashValue(subject)) {
		context.addIssue({ code: "custom", path: ["subjectHash"], message: "does not match the exact impact subject" });
	}
	if (impact.verdict === "inconclusive" && impact.inconclusiveReasons.length === 0) {
		context.addIssue({ code: "custom", path: ["inconclusiveReasons"], message: "inconclusive verdict requires a reason" });
	}
	if (impact.verdict !== "inconclusive" && impact.inconclusiveReasons.length > 0) {
		context.addIssue({ code: "custom", path: ["inconclusiveReasons"], message: "conclusive verdict cannot contain inconclusive reasons" });
	}
	if (Buffer.byteLength(canonicalJson(impact), "utf8") > MAX_OUTPUT_BYTES) {
		context.addIssue({ code: "custom", path: [], message: `candidate impact exceeds ${MAX_OUTPUT_BYTES} bytes` });
	}
});
export type CandidateImpact = z.infer<typeof CandidateImpactSchema>;

export interface InspectCandidateImpactOptions {
	runsRoot: string;
	candidateId: string;
	/** Exact Candidate aggregate presented by the caller, when one exists. */
	expectedCandidateHash?: string;
	focus?: CandidateImpactFocus;
}

interface ExactGraderSignature {
	checkCode: GraderCheckCode;
	specHash: string;
	discriminatorHash: string;
	failureModeId: string;
	category: z.infer<typeof DiagnosisCategorySchema>;
}

interface SignatureObservation {
	run: RunRecord;
	passed: boolean;
}

interface SignatureAggregate {
	signature: ExactGraderSignature;
	observations: Map<string, SignatureObservation>;
}

interface EvaluationSignals {
	byModeId: Map<string, SignatureAggregate>;
	missingExactSignatures: boolean;
}

interface VerifiedPair {
	baseline: VerifiedEvalRun;
	candidate: VerifiedEvalRun;
	compare: CompareResult;
	gateVerified: boolean;
}

function sha256(content: Buffer): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function readBoundedRegularFile(path: string, label: string): Buffer {
	const entry = lstatSync(path);
	if (!entry.isFile() || entry.isSymbolicLink()) {
		throw new Error(`${label} must remain a regular non-symlink artifact`);
	}
	if (entry.size > MAX_ARTIFACT_BYTES) throw new Error(`${label} exceeds the verification limit`);
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = fstatSync(descriptor);
		if (!opened.isFile() || opened.size > MAX_ARTIFACT_BYTES) {
			throw new Error(`${label} must remain a bounded regular artifact`);
		}
		const chunks: Buffer[] = [];
		let total = 0;
		while (total <= MAX_ARTIFACT_BYTES) {
			const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_ARTIFACT_BYTES + 1 - total));
			const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			chunks.push(chunk.subarray(0, bytesRead));
			total += bytesRead;
		}
		if (total > MAX_ARTIFACT_BYTES) throw new Error(`${label} exceeds the verification limit`);
		return Buffer.concat(chunks, total);
	} finally {
		closeSync(descriptor);
	}
}

function verifyArtifactRef(ref: CandidateArtifactRef, label: string, expectedPath?: string): void {
	const path = resolve(ref.path);
	if (expectedPath && realpathSync(path) !== realpathSync(resolve(expectedPath))) {
		throw new Error(`${label} path no longer matches its canonical artifact`);
	}
	const actual = sha256(readBoundedRegularFile(path, label));
	if (actual !== ref.sha256) throw new Error(`${label} hash mismatch: expected ${ref.sha256}, got ${actual}`);
}

function failureModeId(signature: Pick<ExactGraderSignature, "checkCode" | "specHash">): string {
	const digest = hashValue({
		algorithmId: IMPROVEMENT_BRIEF_ALGORITHM_ID,
		signature: {
			kind: "grader-check",
			checkCode: signature.checkCode,
			specHash: signature.specHash,
		},
	});
	return `failure-mode-${digest.slice(HASH_HEX_OFFSET, HASH_HEX_OFFSET + 24)}`;
}

function categoryFor(checkCode: GraderCheckCode): z.infer<typeof DiagnosisCategorySchema> {
	switch (checkCode) {
		case "required-tool": return "tool-selection";
		case "output-contains":
		case "output-matches":
		case "no-secret":
		case "turn-budget":
		case "reference-exact": return "output-contract";
		case "semantic-rubric":
		case "reference-similarity": return "answer-quality";
	}
}

function collectEvaluationSignals(runs: readonly RunRecord[]): EvaluationSignals {
	const byModeId = new Map<string, SignatureAggregate>();
	let missingExactSignatures = false;
	for (const run of runs) {
		if (run.status === "error" || !run.evalResults) continue;
		for (const grader of run.evalResults.graders) {
			if (!grader.checkCode || !grader.specHash) {
				missingExactSignatures = true;
				continue;
			}
			const signature: ExactGraderSignature = {
				checkCode: grader.checkCode,
				specHash: grader.specHash,
				discriminatorHash: hashValue({ checkCode: grader.checkCode, specHash: grader.specHash }),
				failureModeId: failureModeId({ checkCode: grader.checkCode, specHash: grader.specHash }),
				category: categoryFor(grader.checkCode),
			};
			const aggregate = byModeId.get(signature.failureModeId) ?? {
				signature,
				observations: new Map<string, SignatureObservation>(),
			};
			if (canonicalJson(aggregate.signature) !== canonicalJson(signature)) {
				throw new Error("grader signature hash collision in verified evidence");
			}
			const observationKey = `${run.taskId}\0${run.repetitionIndex}`;
			const existing = aggregate.observations.get(observationKey);
			aggregate.observations.set(observationKey, {
				run,
				passed: (existing?.passed ?? true) && grader.passed,
			});
			byModeId.set(signature.failureModeId, aggregate);
		}
	}
	return { byModeId, missingExactSignatures };
}

function sortedObservationKeys(aggregate: SignatureAggregate | undefined): string[] {
	return [...(aggregate?.observations.keys() ?? [])].sort();
}

function sameObservationInventory(
	baseline: SignatureAggregate | undefined,
	candidate: SignatureAggregate | undefined,
): boolean {
	return canonicalJson(sortedObservationKeys(baseline)) === canonicalJson(sortedObservationKeys(candidate));
}

function counts(aggregate: SignatureAggregate | undefined): z.infer<typeof OutcomeCountsSchema> {
	const observations = [...(aggregate?.observations.values() ?? [])];
	const failedOccurrences = observations.filter((item) => !item.passed).length;
	return {
		failedOccurrences,
		totalOccurrences: observations.length,
		failureRateBps: observations.length === 0
			? 0
			: Math.floor(failedOccurrences * 10_000 / observations.length),
	};
}

function evidenceHandle(
	evalRunId: string,
	side: "baseline" | "candidate",
	observation: SignatureObservation,
): CandidateImpactEvidenceHandle {
	return EvidenceHandleSchema.parse({
		handle: `eval:${evalRunId}/run:${observation.run.runId}`,
		runId: observation.run.runId,
		// Equals the ordered RunArtifact hash the final eval index anchors; the
		// exact snapshot already verified the two agree before this run was read.
		runSha256: hashValue(observation.run),
		taskId: publicTaskId(observation.run.taskId),
		side,
		outcome: observation.passed ? "pass" : "fail",
		traceAvailable: observation.run.trace.sha256 !== null,
	});
}

function modeEvidence(
	baselineEvalRunId: string,
	candidateEvalRunId: string,
	baseline: SignatureAggregate | undefined,
	candidate: SignatureAggregate | undefined,
): CandidateImpactEvidenceHandle[] {
	const project = (
		aggregate: SignatureAggregate | undefined,
		evalRunId: string,
		side: "baseline" | "candidate",
	): CandidateImpactEvidenceHandle[] => [...(aggregate?.observations.values() ?? [])]
		.sort((left, right) =>
			Number(left.passed) - Number(right.passed) ||
			compareUtf8(left.run.taskId, right.run.taskId) ||
			compareUtf8(left.run.runId, right.run.runId))
		.map((item) => evidenceHandle(evalRunId, side, item));
	const candidateItems = project(candidate, candidateEvalRunId, "candidate");
	const baselineItems = project(baseline, baselineEvalRunId, "baseline");
	// A matched mode must surface both sides, so the candidate never consumes
	// the whole bounded budget while baseline observations exist.
	const candidateBudget = baselineItems.length > 0 ? MAX_EVIDENCE_PER_ITEM - 1 : MAX_EVIDENCE_PER_ITEM;
	return [...candidateItems.slice(0, candidateBudget), ...baselineItems].slice(0, MAX_EVIDENCE_PER_ITEM);
}

function affectedTasks(aggregate: SignatureAggregate | undefined): { count: number; taskIds: string[] } {
	const taskIds = [...new Set(
		[...(aggregate?.observations.values() ?? [])]
			.filter((item) => !item.passed)
			.map((item) => publicTaskId(item.run.taskId)),
	)].sort(compareUtf8);
	return { count: taskIds.length, taskIds: taskIds.slice(0, MAX_TASK_IDS_PER_MODE) };
}

function targetedOutcome(
	baseline: z.infer<typeof OutcomeCountsSchema>,
	candidate: z.infer<typeof OutcomeCountsSchema>,
): TargetedModeImpact["outcome"] {
	if (baseline.failedOccurrences === 0) return "not-reproduced";
	if (candidate.failedOccurrences === 0) return "resolved";
	if (candidate.failureRateBps < baseline.failureRateBps) return "improved";
	if (candidate.failureRateBps > baseline.failureRateBps) return "worsened";
	return "persisted";
}

/** Classifies a non-targeted mode that only appeared or got worse under the candidate. */
function nonTargetedRole(
	baseline: z.infer<typeof OutcomeCountsSchema>,
	candidate: z.infer<typeof OutcomeCountsSchema>,
): "new" | "worsened" | null {
	if (candidate.failedOccurrences === 0) return null;
	if (baseline.failedOccurrences === 0) return "new";
	return candidate.failureRateBps > baseline.failureRateBps ? "worsened" : null;
}

function pairIdentity(snapshot: VerifiedEvalRun): { evalRunId: string; harnessSha: string; evalRunHash: string } {
	return {
		evalRunId: snapshot.record.evalRunId,
		harnessSha: snapshot.record.target.gitSha,
		evalRunHash: exactSnapshotIdentity(snapshot).evalRunHash,
	};
}

function comparisonSummary(compare: CompareResult): z.infer<typeof ComparisonSummarySchema> {
	return {
		taskCount: compare.summary.taskCount,
		baselinePassRate: compare.summary.baselinePassRate,
		candidatePassRate: compare.summary.candidatePassRate,
		delta: compare.summary.delta,
		confidence95: { ...compare.summary.confidence95 },
		improved: compare.summary.improved,
		regressed: compare.summary.regressed,
		unchanged: compare.summary.unchanged,
	};
}

function assertSameRevision(
	actual: { ref: string; sha: string },
	expected: { ref: string; sha: string },
	label: string,
): void {
	if (actual.ref !== expected.ref || actual.sha !== expected.sha) {
		throw new Error(`${label} does not match Candidate lineage`);
	}
}

function verifyPair(
	runsRoot: string,
	record: CandidateRecord,
	pair: {
		baseline: { evalRunId: string; harness: { ref: string; sha: string } };
		candidate: { evalRunId: string; harness: { ref: string; sha: string } };
		comparison?: {
			policyId: string;
			comparisonHash: string;
			gateHash: string;
			summary: unknown;
		} | null;
	},
	visibility: EvidenceVisibility,
	context: Record<string, unknown>,
	issues: string[],
): VerifiedPair {
	// Each snapshot enforces its explicit disclosure class before any member
	// RunRecord is opened, then verifies every RunRecord hash against the index.
	const baseline = loadExactEvalSnapshot(runsRoot, pair.baseline.evalRunId, visibility);
	const candidate = loadExactEvalSnapshot(runsRoot, pair.candidate.evalRunId, visibility);
	if (!baseline.hasRunHashes || !candidate.hasRunHashes) {
		issues.push(`${visibility} evidence is missing final RunRecord hashes`);
	}
	if (baseline.record.target.id !== record.targetId || candidate.record.target.id !== record.targetId) {
		throw new Error(`${visibility} evidence belongs to another Target`);
	}
	if (
		baseline.record.target.gitSha !== pair.baseline.harness.sha ||
		candidate.record.target.gitSha !== pair.candidate.harness.sha
	) {
		throw new Error(`${visibility} EvalRun revisions do not match Candidate lineage`);
	}
	if (candidate.record.baselineEvalRunId !== baseline.record.evalRunId) {
		throw new Error(`${visibility} candidate EvalRun is not linked to its exact baseline`);
	}
	if (!baseline.record.target.toolsetHash || !candidate.record.target.toolsetHash) {
		issues.push(`${visibility} evidence is missing exact Target toolset hashes`);
	}
	if (!baseline.record.target.workspaceHash || !candidate.record.target.workspaceHash) {
		issues.push(`${visibility} evidence is missing exact Target workspace hashes`);
	}
	if (!baseline.record.target.preparedToolHomeHash || !candidate.record.target.preparedToolHomeHash) {
		issues.push(`${visibility} evidence is missing exact prepared tool-home hashes`);
	}
	if (
		!withinInfrastructureBudget(baseline.record.summary.error, baseline.record.summary.total) ||
		!withinInfrastructureBudget(candidate.record.summary.error, candidate.record.summary.total)
	) {
		issues.push(`${visibility} comparison contains infrastructure errors over the budget`);
	}
	const compare = compareVerifiedEvalRuns(baseline, candidate, { mode: record.mode, surface: visibility });
	if (compare.status === "invalid") throw new Error(compare.error ?? `${visibility} comparison is invalid`);
	const usable = compare.status === "comparable" || (
		compare.status === "inconclusive" &&
		withinInfrastructureBudget(compare.design.excludedTasks, compare.design.tasks + compare.design.excludedTasks)
	);
	if (!usable) {
		issues.push(`${visibility} comparison is inconclusive`);
	}
	if (compare.summary.taskCount < 1) issues.push(`${visibility} comparison contains no task evidence`);
	if (!pair.comparison) throw new Error(`${visibility} comparison identity is missing`);
	let gateVerified = false;
	if (usable) {
		const expected = comparisonGateEvidence(compare, context);
		if (canonicalJson(expected) !== canonicalJson(pair.comparison)) {
			throw new Error(`${visibility} comparison identity no longer matches verified evidence`);
		}
		gateVerified = true;
	}
	return { baseline, candidate, compare, gateVerified };
}

function verifiedBuilderBasis(
	runsRoot: string,
	record: CandidateRecord,
): {
	basis: NonNullable<ReturnType<typeof loadBuilderProposalRun>["request"]["proposalBasis"]> | null;
	brief: ReturnType<typeof compileImprovementBrief> | null;
} {
	if (record.origin.kind !== "applied-builder") return { basis: null, brief: null };
	const origin = record.origin;
	const builderDir = resolveContainedArtifactPath(runsRoot, "builders", origin.builderRunId);
	verifyArtifactRef(origin.builderRun, "Builder run", resolveContainedArtifactPath(builderDir, "builder_run.json"));
	verifyArtifactRef(origin.builderInput, "Builder input", resolveContainedArtifactPath(builderDir, "builder_input.txt"));
	verifyArtifactRef(origin.proposal, "Builder proposal", resolveContainedArtifactPath(builderDir, "proposal.json"));
	verifyArtifactRef(origin.applyReceipt, "Builder apply receipt", resolveContainedArtifactPath(builderDir, "apply_receipt.json"));
	verifyArtifactRef(origin.approvedSpec.artifact, "approved Spec");

	const builder = loadBuilderProposalRun(runsRoot, origin.builderRunId);
	const proposal = readJsonArtifact(origin.proposal.path, CandidateProposalSchema);
	const receipt = readJsonArtifact(origin.applyReceipt.path, BuilderApplyReceiptSchema);
	const spec = readJsonArtifact(origin.approvedSpec.artifact.path, SpecSnapshotSchema);
	const validated = record.events.find((event) => event.type === "validated");
	if (
		builder.runId !== origin.builderRunId ||
		builder.request.provenanceMode !== "canonical" ||
		builder.result.status !== "completed" ||
		!builder.artifacts.proposal ||
		builder.artifacts.proposal.sha256 !== origin.proposal.sha256 ||
		builder.artifacts.input.sha256 !== origin.builderInput.sha256 ||
		canonicalJson(builder.result.proposal) !== canonicalJson(proposal) ||
		proposal.decision !== "propose"
	) {
		throw new Error("Candidate no longer references its exact canonical Builder proposal");
	}
	if (
		!builder.request.approvedSpec ||
		builder.request.approvedSpec.specId !== origin.approvedSpec.specId ||
		builder.request.approvedSpec.projectId !== origin.approvedSpec.projectId ||
		builder.request.approvedSpec.specContentHash !== origin.approvedSpec.specContentHash ||
		builder.request.approvedSpec.snapshotHash !== origin.approvedSpec.snapshotHash
	) {
		throw new Error("Candidate Builder request no longer references its exact approved Spec");
	}
	if (
		receipt.runId !== origin.builderRunId ||
		receipt.proposalSha256 !== origin.proposal.sha256 ||
		receipt.baseTargetSha !== origin.application.baseTargetSha ||
		receipt.candidateSha !== origin.application.candidateSha ||
		receipt.actor.id !== origin.application.actor.id ||
		receipt.appliedAt !== origin.application.appliedAt ||
		receipt.reason !== origin.application.reason ||
		canonicalJson([...receipt.paths].sort()) !== canonicalJson(proposal.changes.map((change) => change.path).sort()) ||
		!validated || validated.type !== "validated" ||
		canonicalJson([...validated.scope.changedFiles].sort()) !== canonicalJson([...receipt.paths].sort())
	) {
		throw new Error("Candidate apply lineage no longer matches its exact proposal");
	}
	if (
		spec.id !== origin.approvedSpec.specId ||
		spec.projectId !== origin.approvedSpec.projectId ||
		spec.status !== "approved" ||
		hashValue(spec.spec) !== origin.approvedSpec.specContentHash ||
		hashValue(spec) !== origin.approvedSpec.snapshotHash
	) {
		throw new Error("Candidate approved Spec identity no longer matches its provenance");
	}
	if (
		builder.request.baseTargetSha !== record.baseline.sha ||
		builder.request.baseTargetSha !== origin.application.baseTargetSha ||
		origin.application.candidateSha !== record.events.find((event) => event.type === "built")?.candidate.sha
	) {
		throw new Error("Builder apply revisions no longer match Candidate lineage");
	}
	const basis = builder.request.proposalBasis;
	if (!origin.source) {
		if (builder.request.source || builder.request.sourceAttestation || basis) {
			throw new Error("Candidate source provenance disappeared from its Builder origin");
		}
		return { basis: null, brief: null };
	}
	verifyArtifactRef(
		origin.source.evalRun,
		"Builder source EvalRun",
		resolveContainedArtifactPath(runsRoot, origin.source.evalRunId, "eval_run.json"),
	);
	verifyArtifactRef(
		origin.source.diagnosis,
		"Builder source diagnosis",
		resolveContainedArtifactPath(runsRoot, origin.source.evalRunId, "diagnosis.json"),
	);
	// Only explicit development evidence may seed a proposal; sealed or legacy
	// indexes without a disclosure class fail closed before any run is opened.
	const source = loadExactEvalSnapshot(runsRoot, origin.source.evalRunId, "development");
	const diagnosis = readJsonArtifact(origin.source.diagnosis.path, DiagnosisRecordSchema);
	const attestation = builder.request.sourceAttestation;
	if (
		!builder.request.source || !attestation ||
		builder.request.source.evalRunId !== origin.source.evalRunId ||
		builder.request.source.diagnosisId !== origin.source.diagnosisId ||
		attestation.evalRunId !== origin.source.evalRunId ||
		attestation.diagnosisId !== origin.source.diagnosisId ||
		attestation.targetId !== record.targetId ||
		attestation.targetGitSha !== record.baseline.sha ||
		attestation.evalRunSha256 !== origin.source.evalRun.sha256 ||
		attestation.diagnosisSha256 !== origin.source.diagnosis.sha256 ||
		attestation.dataset !== origin.source.dataset ||
		attestation.datasetHash !== origin.source.datasetHash ||
		attestation.suiteHash !== origin.source.suiteHash ||
		canonicalJson(attestation.developmentCorpus) !== canonicalJson(origin.source.developmentCorpus) ||
		source.record.target.id !== record.targetId ||
		source.record.target.gitSha !== record.baseline.sha ||
		source.record.dataset !== origin.source.dataset ||
		source.record.datasetHash !== origin.source.datasetHash ||
		source.record.suiteHash !== origin.source.suiteHash ||
		diagnosis.diagnosisId !== origin.source.diagnosisId ||
		diagnosis.evalRunId !== origin.source.evalRunId
	) {
		throw new Error("Candidate Builder source is misattributed");
	}
	const brief = compileImprovementBrief(runsRoot, diagnosis);
	if (!basis) return { basis: null, brief };
	if (basis.briefSha256 !== hashValue(brief)) {
		throw new Error("Candidate proposal basis no longer matches its exact improvement brief");
	}
	for (const selected of basis.failureModes) {
		const mode = brief.modes.find((item) => item.failureModeId === selected.failureModeId);
		if (!mode || hashValue(mode) !== selected.modeSha256) {
			throw new Error("Candidate targeted failure mode no longer matches its proposal basis");
		}
	}
	return { basis, brief };
}

function assertDevelopmentSource(
	record: CandidateRecord,
	verified: VerifiedPair,
): void {
	if (record.origin.kind !== "applied-builder" || !record.origin.source) return;
	const source = record.origin.source;
	for (const run of [verified.baseline.record, verified.candidate.record]) {
		if (
			run.dataset !== source.dataset ||
			run.datasetHash !== source.datasetHash ||
			run.suiteHash !== source.suiteHash
		) {
			throw new Error("development comparison does not match the exact Builder source surface");
		}
	}
}

function verdictFor(
	targeted: readonly TargetedModeImpact[],
	newModes: readonly CandidateNewFailureMode[],
	worsenedModes: readonly CandidateNewFailureMode[],
	developmentVerdict: GateVerdict | null,
	issues: readonly string[],
	sealedVerdict: GateVerdict | null,
	sealedExecuted: boolean,
): CandidateImpact["verdict"] {
	if (issues.length > 0 || targeted.length === 0) return "inconclusive";
	// Per-task flips are flags for humans; only the gate verdicts and the
	// exact failure-mode signals decide the impact verdict.
	if (
		developmentVerdict === "regressed" || (sealedExecuted && sealedVerdict === "fail") ||
		newModes.length > 0 || worsenedModes.length > 0 ||
		targeted.some((mode) => mode.outcome === "worsened")
	) {
		return "regressed";
	}
	const positive = targeted.filter((mode) => mode.outcome === "resolved" || mode.outcome === "improved").length;
	if (positive === targeted.length) return "improved";
	if (positive > 0) return "mixed";
	return "no-change";
}

function focusResult(
	focus: CandidateImpactFocus,
	targeted: readonly TargetedModeImpact[],
	newModes: readonly CandidateNewFailureMode[],
	worsenedModes: readonly CandidateNewFailureMode[],
	development: VerifiedPair,
): z.infer<typeof FocusResultSchema> {
	if (focus.kind === "summary") return focus;
	if (focus.kind === "mode") {
		if (targeted.some((mode) => mode.failureModeId === focus.failureModeId)) {
			return { ...focus, role: "targeted" };
		}
		if (newModes.some((mode) => mode.failureModeId === focus.failureModeId)) {
			return { ...focus, role: "new" };
		}
		if (worsenedModes.some((mode) => mode.failureModeId === focus.failureModeId)) {
			return { ...focus, role: "worsened" };
		}
		throw new Error(`failure mode ${focus.failureModeId} is absent from this exact Candidate impact`);
	}
	const match = [
		...development.baseline.runs.map((run) => ({ side: "baseline" as const, run })),
		...development.candidate.runs.map((run) => ({ side: "candidate" as const, run })),
	].find((item) => item.run.runId === focus.runId);
	if (!match) throw new Error(`run ${focus.runId} is not public development evidence for this Candidate`);
	const signals = collectEvaluationSignals([match.run]);
	return {
		kind: "run",
		runId: match.run.runId,
		side: match.side,
		taskId: publicTaskId(match.run.taskId),
		repetitionIndex: match.run.repetitionIndex,
		outcome: match.run.status === "error" ? "error" : match.run.evalResults?.outcome ?? "error",
		traceAvailable: match.run.trace.sha256 !== null,
		failureModeIds: [...signals.byModeId.values()]
			.filter((mode) => [...mode.observations.values()].some((item) => !item.passed))
			.map((mode) => mode.signature.failureModeId)
			.sort(compareUtf8)
			.slice(0, 100),
	};
}

/**
 * Inspect one immutable Candidate through a single read-only seam. Every
 * lineage, proposal-basis, EvalRun, grader-signature, and gate claim is
 * re-derived before a bounded model-safe DTO is returned.
 */
export function inspectCandidateImpact(options: InspectCandidateImpactOptions): CandidateImpact {
	const candidateId = ArtifactIdSchema.parse(options.candidateId);
	const focus = CandidateImpactFocusSchema.parse(options.focus ?? { kind: "summary" });
	const record = readJsonArtifact(
		resolveContainedArtifactPath(options.runsRoot, "candidates", candidateId, "candidate.json"),
		CandidateRecordSchema,
	);
	if (record.candidateId !== candidateId) {
		throw new Error("Candidate artifact identity does not match its canonical path");
	}
	const candidateHash = hashValue(record);
	const expectedCandidateHash = options.expectedCandidateHash === undefined
		? undefined
		: HashSchema.parse(options.expectedCandidateHash);
	if (expectedCandidateHash !== undefined && expectedCandidateHash !== candidateHash) {
		throw new Error("candidate changed after impact inspection was requested; expected Candidate hash is stale");
	}
	const evaluated = record.events.find((event) => event.type === "evaluated");
	const built = record.events.find((event) => event.type === "built");
	if (!evaluated || evaluated.type !== "evaluated" || !built || built.type !== "built") {
		throw new Error(`candidate ${candidateId} has no completed evaluation pair`);
	}
	assertSameRevision(evaluated.evaluation.development.baseline.harness, record.baseline, "development baseline");
	assertSameRevision(evaluated.evaluation.development.candidate.harness, built.candidate, "development candidate");

	const issues: string[] = [];
	if (record.mode !== "candidate") issues.push("A/A calibration cannot establish Candidate impact");
	const { basis, brief } = verifiedBuilderBasis(options.runsRoot, record);
	if (!basis || !brief) issues.push("Candidate has no exact proposal-basis failure modes");
	const developmentCorpus = evaluated.evaluation.development.corpus ?? null;
	if (record.origin.kind === "applied-builder" && record.origin.source &&
		canonicalJson(developmentCorpus) !== canonicalJson(record.origin.source.developmentCorpus)) {
		throw new Error("development corpus identity no longer matches the Builder source");
	}
	const developmentContext = developmentCorpus
		? { corpusId: developmentCorpus.id, corpusHash: developmentCorpus.hash }
		: {};
	const development = verifyPair(
		options.runsRoot,
		record,
		evaluated.evaluation.development,
		"development",
		developmentContext,
		issues,
	);
	assertDevelopmentSource(record, development);
	if (developmentCorpus) {
		const expectedDataset = corpusDatasetLabel("development", developmentCorpus.id);
		for (const run of [development.baseline.record, development.candidate.record]) {
			if (run.dataset !== expectedDataset || run.datasetHash !== developmentCorpus.hash) {
				throw new Error("development EvalRun does not match its exact corpus identity");
			}
		}
	}

	const baselineSignals = collectEvaluationSignals(development.baseline.runs);
	const candidateSignals = collectEvaluationSignals(development.candidate.runs);
	if (baselineSignals.missingExactSignatures || candidateSignals.missingExactSignatures) {
		issues.push("development evidence contains graders without exact checkCode/specHash signatures");
	}
	const targeted: TargetedModeImpact[] = [];
	if (basis && brief) {
		for (const selected of basis.failureModes) {
			const sourceMode = brief.modes.find((mode) => mode.failureModeId === selected.failureModeId);
			if (!sourceMode) throw new Error("proposal basis references a missing canonical failure mode");
			if (sourceMode.signature.kind !== "grader-check" || sourceMode.signature.checkCode === null) {
				throw new Error("canonical proposal basis contains a failure mode without an exact grader signature");
			}
			const baseline = baselineSignals.byModeId.get(selected.failureModeId);
			const candidate = candidateSignals.byModeId.get(selected.failureModeId);
			const exactMatch = Boolean(
				baseline && candidate &&
				sameObservationInventory(baseline, candidate) &&
				baseline.signature.checkCode === sourceMode.signature.checkCode &&
				baseline.signature.discriminatorHash === sourceMode.signature.discriminatorHash &&
				candidate.signature.checkCode === sourceMode.signature.checkCode &&
				candidate.signature.discriminatorHash === sourceMode.signature.discriminatorHash,
			);
			if (!exactMatch) {
				issues.push(`targeted failure mode ${selected.failureModeId} lacks matched exact grader signatures`);
			}
			const baselineCounts = counts(baseline);
			const candidateCounts = counts(candidate);
			const candidateAffected = affectedTasks(candidate);
			targeted.push(TargetedModeImpactSchema.parse({
				failureModeId: selected.failureModeId,
				modeSha256: selected.modeSha256,
				signature: {
					kind: "grader-check",
					checkCode: sourceMode.signature.checkCode,
					discriminatorHash: sourceMode.signature.discriminatorHash,
				},
				category: sourceMode.category,
				outcome: exactMatch ? targetedOutcome(baselineCounts, candidateCounts) : "not-reproduced",
				baseline: baselineCounts,
				candidate: candidateCounts,
				sourceAffectedTasks: sourceMode.impact.affectedTasks,
				candidateAffectedTasks: candidateAffected.count,
				sourceTaskIds: sourceMode.taskIds.slice(0, MAX_TASK_IDS_PER_MODE),
				candidateAffectedTaskIds: candidateAffected.taskIds,
				evidence: modeEvidence(
					development.baseline.record.evalRunId,
					development.candidate.record.evalRunId,
					baseline,
					candidate,
				),
			}));
		}
	}

	const targetedIds = new Set(targeted.map((mode) => mode.failureModeId));
	const allModeIds = [...new Set([
		...baselineSignals.byModeId.keys(),
		...candidateSignals.byModeId.keys(),
	])].sort(compareUtf8);
	const newFailureModes: CandidateNewFailureMode[] = [];
	const worsenedFailureModes: CandidateNewFailureMode[] = [];
	let newFailureModeCount = 0;
	let worsenedFailureModeCount = 0;
	for (const modeId of allModeIds) {
		if (targetedIds.has(modeId)) continue;
		const baseline = baselineSignals.byModeId.get(modeId);
		const candidate = candidateSignals.byModeId.get(modeId);
		if (!baseline || !candidate || !sameObservationInventory(baseline, candidate)) {
			issues.push(`grader signature inventory changed for ${modeId}`);
			continue;
		}
		const baselineCounts = counts(baseline);
		const candidateCounts = counts(candidate);
		const role = nonTargetedRole(baselineCounts, candidateCounts);
		if (role === null) continue;
		if (role === "new") newFailureModeCount += 1;
		else worsenedFailureModeCount += 1;
		const bucket = role === "new" ? newFailureModes : worsenedFailureModes;
		if (bucket.length >= MAX_NEW_MODES) continue;
		const affected = affectedTasks(candidate);
		// Evidence keeps both sides so a reviewer can open the baseline pass next
		// to the candidate failure without re-deriving the matched inventory.
		bucket.push(NonTargetedModeImpactSchema.parse({
			failureModeId: modeId,
			signature: {
				kind: "grader-check",
				checkCode: candidate.signature.checkCode,
				discriminatorHash: candidate.signature.discriminatorHash,
			},
			category: candidate.signature.category,
			baseline: baselineCounts,
			candidate: candidateCounts,
			affectedTasks: affected.count,
			affectedTaskIds: affected.taskIds,
			evidence: modeEvidence(
				development.baseline.record.evalRunId,
				development.candidate.record.evalRunId,
				baseline,
				candidate,
			),
		}));
	}

	const candidateRunsByTask = new Map<string, RunRecord[]>();
	for (const run of development.candidate.runs) {
		const values = candidateRunsByTask.get(run.taskId) ?? [];
		values.push(run);
		candidateRunsByTask.set(run.taskId, values);
	}
	const allTaskRegressions = development.compare.rows
		.filter((row) => row.delta < 0)
		.sort((left, right) => compareUtf8(left.taskId, right.taskId));
	const taskRegressions = allTaskRegressions
		.slice(0, MAX_TASK_REGRESSIONS)
		.map((row) => TaskRegressionSchema.parse({
			taskId: publicTaskId(row.taskId),
			baselinePassRate: row.aPassRate,
			candidatePassRate: row.bPassRate,
			delta: row.delta,
			evidence: (candidateRunsByTask.get(row.taskId) ?? [])
				.filter((run) => run.status !== "error" && run.evalResults?.outcome === "fail")
				.sort((left, right) => compareUtf8(left.runId, right.runId))
				.slice(0, MAX_EVIDENCE_PER_ITEM)
				.map((run) => evidenceHandle(development.candidate.record.evalRunId, "candidate", { run, passed: false })),
		}));

	let sealedHoldout: { executed: boolean; gatePassed: boolean; verdict: GateVerdict | null } = { executed: false, gatePassed: false, verdict: null };
	const holdout = evaluated.evaluation.sealedHoldout;
	if (holdout) {
		if (!holdout.corpus) throw new Error("sealed holdout is missing its exact corpus identity");
		const verified = verifyPair(
			options.runsRoot,
			record,
			holdout,
			"sealed",
			{ corpusId: holdout.corpus.id, corpusHash: holdout.corpus.hash },
			issues,
		);
		const expectedDataset = corpusDatasetLabel("sealed", holdout.corpus.id);
		for (const run of [verified.baseline.record, verified.candidate.record]) {
			if (run.dataset !== expectedDataset || run.datasetHash !== holdout.corpus.hash) {
				throw new Error("sealed EvalRun does not match its exact corpus identity");
			}
		}
		const sealedVerdict = verified.gateVerified ? verified.compare.gate.verdict : null;
		sealedHoldout = {
			executed: true,
			gatePassed: verified.gateVerified && sealedVerdict === "pass",
			verdict: sealedVerdict,
		};
	}

	const uniqueIssues = [...new Set(issues)].sort(compareUtf8).slice(0, MAX_INCONCLUSIVE_REASONS);
	const verdict = verdictFor(
		targeted,
		newFailureModes,
		worsenedFailureModes,
		development.gateVerified ? development.compare.gate.verdict : null,
		uniqueIssues,
		sealedHoldout.verdict,
		sealedHoldout.executed,
	);
	if (verdict === "inconclusive" && uniqueIssues.length === 0) {
		uniqueIssues.push("Candidate impact has no exact targeted failure-mode evidence");
	}
	const comparison = evaluated.evaluation.development.comparison;
	if (!comparison) throw new Error("development comparison identity is missing");
	const subject = CandidateImpactBaseSchema.parse({
		schemaVersion: 1,
		algorithmId: CANDIDATE_IMPACT_ALGORITHM_ID,
		candidateId,
		targetId: record.targetId,
		candidateHash,
		verdict,
		inconclusiveReasons: verdict === "inconclusive" ? uniqueIssues : [],
		development: {
			pair: {
				baseline: pairIdentity(development.baseline),
				candidate: pairIdentity(development.candidate),
			},
			comparison: {
				// Legacy v1 gate evidence carries neither field; it is surfaced as
				// null and can never be reported as verified above.
				algorithmId: "algorithmId" in comparison ? comparison.algorithmId : null,
				policyId: comparison.policyId,
				comparisonHash: comparison.comparisonHash,
				evidenceHash: "evidenceHash" in comparison ? comparison.evidenceHash : null,
				gateHash: comparison.gateHash,
				verified: development.gateVerified,
				verdict: gateVerdictOf(comparison),
			},
			summary: comparisonSummary(development.compare),
			resources: {
				costRatio: development.compare.resources.costRatio,
				latencyRatio: development.compare.resources.latencyRatio,
				tokenRatio: development.compare.resources.tokenRatio,
			},
		},
		proposalBasis: basis && brief
			? {
				algorithmId: basis.algorithmId,
				evalRunId: basis.evalRunId,
				diagnosisId: basis.diagnosisId,
				briefId: basis.briefId,
				briefSha256: basis.briefSha256,
				basisSha256: hashValue(basis),
				targetedFailureModes: targeted,
			}
			: null,
		newFailureModes,
		omittedNewFailureModeCount: newFailureModeCount - newFailureModes.length,
		worsenedFailureModes,
		omittedWorsenedFailureModeCount: worsenedFailureModeCount - worsenedFailureModes.length,
		taskRegressions,
		omittedTaskRegressionCount: allTaskRegressions.length - taskRegressions.length,
		sealedHoldout,
		focus: focusResult(focus, targeted, newFailureModes, worsenedFailureModes, development),
	});
	return CandidateImpactSchema.parse({ ...subject, subjectHash: hashValue(subject) });
}
