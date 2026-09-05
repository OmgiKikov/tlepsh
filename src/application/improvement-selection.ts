import { resolveCandidateArtifact } from "./candidate-artifacts.js";
/** Durable measured selection for the existing improvement loop. No release authority. */
import { existsSync, realpathSync } from "node:fs";
import { z } from "zod";
import { DEVELOPMENT_VERDICTS } from "../domain/comparison-gate.js";
import { compareEvalRuns } from "../compare.js";
import { loadVerifiedEvalRun, readEvalRunIndex, type EvalRunRecord } from "../eval.js";
import { hashValue } from "../provenance.js";
import { comparisonGateEvidence } from "./candidate-experiment.js";
import { candidateRecordPath, loadCandidateRecord } from "./candidate-review.js";
import { loadBuilderProposalRun } from "./builder-proposal.js";

const Hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const ImprovementEvalPinSchema = z.strictObject({ evalRunId: z.string().min(1), hash: Hash });
export type ImprovementEvalPin = z.infer<typeof ImprovementEvalPinSchema>;

const MeasuredCandidateSchema = z.strictObject({
	candidateId: z.string().min(1),
	candidateHash: Hash,
	cycle: z.number().int().positive(),
	ordinal: z.number().int().positive(),
	verdict: z.enum(DEVELOPMENT_VERDICTS),
	scoreDelta: z.number().min(-1).max(1),
	confidence95: z.strictObject({ low: z.number().min(-1).max(1), high: z.number().min(-1).max(1) }),
	candidatePassRate: z.number().min(0).max(1),
	costRatio: z.number().nonnegative().nullable(),
	latencyRatio: z.number().nonnegative().nullable(),
});
export type ImprovementMeasuredCandidate = z.infer<typeof MeasuredCandidateSchema>;

export const ImprovementSelectionStateSchema = z.strictObject({
	version: z.literal(1),
	policy: z.literal("measured-best-v1"),
	authoringBaseline: ImprovementEvalPinSchema.nullable(),
	validationBaseline: ImprovementEvalPinSchema.nullable(),
	proposalHashes: z.array(Hash).max(40),
	measured: z.array(MeasuredCandidateSchema).max(40),
	/** Includes conservative reservations for interrupted calls whose spend is unknown. */
	executionsCharged: z.number().int().nonnegative(),
	noProgressRounds: z.number().int().min(0).max(2),
	completedCycle: z.number().int().min(0).max(10),
});
export type ImprovementSelectionState = z.infer<typeof ImprovementSelectionStateSchema>;

export interface ImprovementSelectionSummary {
	policy: "measured-best-v1";
	executionBudget: number;
	executionsCharged: number;
	incumbent: ImprovementMeasuredCandidate | null;
	evaluatedCandidates: number;
	noProgressRounds: number;
	uncertainty: string;
}

export function initialImprovementSelection(): ImprovementSelectionState {
	return {
		version: 1, policy: "measured-best-v1", authoringBaseline: null, validationBaseline: null,
		proposalHashes: [], measured: [], executionsCharged: 0, noProgressRounds: 0, completedCycle: 0,
	};
}

/** Stable predeclared ranking; an unknown resource is never treated as free or preferable. */
export function selectBestImprovement(
	measured: readonly ImprovementMeasuredCandidate[],
): ImprovementMeasuredCandidate | null {
	let best: ImprovementMeasuredCandidate | null = null;
	for (const candidate of [...measured].sort((a, b) => a.cycle - b.cycle || a.ordinal - b.ordinal)) {
		if (candidate.verdict !== "improved") continue;
		if (!best) { best = candidate; continue; }
		const score = candidate.scoreDelta - best.scoreDelta;
		const lower = candidate.confidence95.low - best.confidence95.low;
		const cost = candidate.costRatio !== null && best.costRatio !== null ? best.costRatio - candidate.costRatio : 0;
		const latency = candidate.latencyRatio !== null && best.latencyRatio !== null ? best.latencyRatio - candidate.latencyRatio : 0;
		if ((score || lower || cost || latency) > 0) best = candidate;
	}
	return best;
}

export function improvementSelectionSummary(state: ImprovementSelectionState, executionBudget: number): ImprovementSelectionSummary {
	return {
		policy: state.policy, executionBudget, executionsCharged: state.executionsCharged,
		incumbent: selectBestImprovement(state.measured), evaluatedCandidates: state.measured.length,
		noProgressRounds: state.noProgressRounds,
		uncertainty: "Independent hypotheses are compared with one fixed original baseline on the same unseen development partition. Ranking uses measured score delta, lower 95% bound, known cost, known latency, then earliest trial. Repeated selection and unadjusted intervals do not prove superiority or generalization; final sealed verification and human release remain required. Charged capacity retains interrupted reservations; recorded executions may be a subtotal after a crash.",
	};
}

export function pinImprovementEval(record: EvalRunRecord): ImprovementEvalPin {
	return { evalRunId: record.evalRunId, hash: hashValue(record) };
}

/** Inspect the index before opening members: never open a redirected sealed run. */
export function loadPinnedImprovementEval(runsRoot: string, pin: ImprovementEvalPin): EvalRunRecord {
	const index = readEvalRunIndex(runsRoot, pin.evalRunId);
	if (index.evidenceVisibility !== "development" || index.purpose !== "evidence" || hashValue(index) !== pin.hash) {
		throw new Error("improvement baseline changed or is not development evidence");
	}
	return loadVerifiedEvalRun(runsRoot, pin.evalRunId).record;
}

/** Content, not changed paths or prose summary, identifies a hypothesis. */
export function improvementProposalHash(runsRoot: string, proposalRunId: string): string {
	const run = loadBuilderProposalRun(runsRoot, proposalRunId);
	const proposal = run.result.proposal;
	if (!proposal || proposal.decision !== "propose") throw new Error("improvement hypothesis has no recorded change");
	return hashValue(proposal.changes.map(({ path, baseSha256, unifiedDiff }) => ({ path, baseSha256, unifiedDiff }))
		.sort((a, b) => a.path.localeCompare(b.path)));
}

export function improvementCandidateId(loopId: string, cycle: number, ordinal: number): string {
	return `candidate-${loopId}-${cycle}-${ordinal}`;
}

export interface ImprovementCandidateScope {
	projectId: string;
	approvedSpecId: string;
	baseTargetSha: string;
	authoringBaseline: ImprovementEvalPin;
	validationBaseline: ImprovementEvalPin;
	experimentDesignPath: string;
}

/** Rebuild ranking from canonical, verified comparisons, including a receipt written before a crash. */
export function readImprovementMeasurement(
	runsRoot: string, candidateId: string, cycle: number, ordinal: number, scope: ImprovementCandidateScope,
): ImprovementMeasuredCandidate | null {
	if (!existsSync(candidateRecordPath(runsRoot, candidateId))) return null;
	const record = loadCandidateRecord(runsRoot, candidateId);
	const origin = record.origin;
	if (record.projectId !== scope.projectId || origin?.kind !== "applied-builder" ||
		origin.approvedSpec.specId !== scope.approvedSpecId || origin.application.baseTargetSha !== scope.baseTargetSha ||
		origin.source?.evalRunId !== scope.authoringBaseline.evalRunId ||
		(!origin.experimentDesign || resolveCandidateArtifact(runsRoot, origin, "experimentDesign") !== realpathSync(scope.experimentDesignPath)) || origin.application.via !== "proposal-search") {
		throw new Error("improvement candidate is outside its fixed original experiment");
	}
	const event = record.events.find((entry) => entry.type === "evaluated");
	if (!event || event.type !== "evaluated") return null;
	if (event.evaluation.sealedHoldout) throw new Error("an automatic improvement cannot contain sealed evaluation");
	const pair = event.evaluation.development;
	if (pair.baseline.evalRunId !== scope.validationBaseline.evalRunId) throw new Error("improvement candidate changed its pinned baseline");
	loadPinnedImprovementEval(runsRoot, scope.validationBaseline);
	const candidateIndex = readEvalRunIndex(runsRoot, pair.candidate.evalRunId);
	if (candidateIndex.evidenceVisibility !== "development" || candidateIndex.purpose !== "evidence" || candidateIndex.label !== "candidate") {
		throw new Error("improvement candidate is not development candidate evidence");
	}
	const compared = compareEvalRuns(runsRoot, pair.baseline.evalRunId, pair.candidate.evalRunId, { mode: "candidate", surface: "development" });
	if (hashValue(comparisonGateEvidence(compared, pair.corpus ? { corpusId: pair.corpus.id, corpusHash: pair.corpus.hash } : {})) !== hashValue(pair.comparison)) {
		throw new Error("improvement candidate comparison changed since verification");
	}
	return MeasuredCandidateSchema.parse({
		candidateId, candidateHash: hashValue(record), cycle, ordinal, verdict: compared.gate.verdict,
		scoreDelta: compared.summary.scoreDelta, confidence95: compared.summary.confidence95,
		candidatePassRate: compared.summary.candidatePassRate,
		costRatio: compared.resources.costRatio, latencyRatio: compared.resources.latencyRatio,
	});
}
