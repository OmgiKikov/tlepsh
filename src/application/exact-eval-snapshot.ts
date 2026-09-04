import {
	loadRun,
	readEvalRunIndex,
	type EvidenceVisibility,
	type EvalRunRecord,
	type VerifiedEvalRun,
} from "../eval.js";
import { axisDifferences, canonicalJson, hashValue, provenanceAxes } from "../provenance.js";
import { verifiedRunArtifacts, type VerifiedRunArtifacts } from "../run-evidence.js";

export { compareUtf8 } from "../domain/comparison-gate.js";

function mismatch(evalRunId: string, message: string): never {
	throw new Error(`eval run ${evalRunId} evidence mismatch: ${message}`);
}

function sameJson(left: unknown, right: unknown): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

/**
 * Read one EvalRun index once, enforce its explicit disclosure class before
 * opening any member RunRecord, then verify the complete immutable snapshot.
 */
export function loadExactEvalSnapshot(
	runsRoot: string,
	evalRunId: string,
	expectedVisibility: EvidenceVisibility,
): VerifiedEvalRun {
	const record = readEvalRunIndex(runsRoot, evalRunId);
	if (record.evidenceVisibility !== expectedVisibility) {
		throw new Error(`eval run ${evalRunId} lacks explicit ${expectedVisibility} visibility`);
	}
	const expectedHashes = new Map(record.runArtifacts?.map((artifact) => [artifact.runId, artifact.sha256]) ?? []);
	const artifacts = new Map<string, VerifiedRunArtifacts>();
	const runs = record.runIds.map((runId) => {
		const run = loadRun(runsRoot, runId);
		if (run.runId !== runId) mismatch(evalRunId, `run path ${runId} contains record ${run.runId}`);
		const expectedHash = expectedHashes.get(runId);
		if (expectedHash && hashValue(run) !== expectedHash) {
			mismatch(evalRunId, `run ${runId} hash does not match the final eval index`);
		}
		artifacts.set(runId, verifiedRunArtifacts(runsRoot, run));
		if (run.parent?.evalRunId !== record.evalRunId) mismatch(evalRunId, `run ${runId} parent does not reference this eval`);
		if (
			run.target.id !== record.target.id ||
			run.target.gitSha !== record.target.gitSha ||
			run.target.toolsetHash !== record.target.toolsetHash ||
			run.target.workspaceHash !== record.target.workspaceHash ||
			run.target.preparedToolHomeHash !== record.target.preparedToolHomeHash
		) mismatch(evalRunId, `run ${runId} target does not match the eval target`);
		if (run.label !== record.label) mismatch(evalRunId, `run ${runId} label does not match`);
		if (run.eval.suiteId !== record.suiteId || run.eval.suiteHash !== record.suiteHash) {
			mismatch(evalRunId, `run ${runId} suite does not match`);
		}
		if (run.eval.dataset !== record.dataset || run.eval.datasetHash !== record.datasetHash) {
			mismatch(evalRunId, `run ${runId} dataset does not match`);
		}
		if (run.status === "running" || run.finishedAt === null) mismatch(evalRunId, `run ${runId} is not final`);
		if (run.status === "completed" && run.evalResults === null) mismatch(evalRunId, `completed run ${runId} has no grading result`);
		if (run.status === "error" && run.evalResults !== null) mismatch(evalRunId, `error run ${runId} unexpectedly has grading results`);
		const axes = provenanceAxes({
			runtime: run.runtime,
			model: run.model,
			judge: record.provenance.judge,
			// Both evaluator models are suite configuration, not per-run facts: a
			// RunRecord carries neither fingerprint, so both are taken from the
			// index being verified. Omitting the user model here made every
			// simulated-user snapshot disagree with its own canonical EvalRun.
			simulatedUser: record.provenance.simulatedUser,
			execution: run.execution,
			eval: run.eval,
		});
		const differences = axisDifferences(axes, record.provenance);
		if (differences.length > 0) mismatch(evalRunId, `run ${runId} differs on ${differences.join(", ")}`);
		if (record.label === "candidate" && run.parent.candidateOf === null) {
			mismatch(evalRunId, `candidate run ${runId} has no candidateOf revision`);
		}
		if (record.label !== "candidate" && run.parent.candidateOf !== null) {
			mismatch(evalRunId, `${record.label} run ${runId} has an unexpected candidateOf revision`);
		}
		return run;
	});

	const byTask = new Map<string, Set<number>>();
	for (const run of runs) {
		const repetitions = byTask.get(run.taskId) ?? new Set<number>();
		if (repetitions.has(run.repetitionIndex)) mismatch(evalRunId, `duplicate task/repetition ${run.taskId}/${run.repetitionIndex}`);
		repetitions.add(run.repetitionIndex);
		byTask.set(run.taskId, repetitions);
	}
	if (record.taskIds && !sameJson(record.taskIds, [...byTask.keys()])) {
		mismatch(evalRunId, "taskIds do not match the exact source task order");
	}
	const expectedRepetitions = Array.from({ length: record.repetitions }, (_, index) => index);
	for (const [taskId, repetitions] of byTask) {
		if (!sameJson([...repetitions].sort((a, b) => a - b), expectedRepetitions)) {
			mismatch(evalRunId, `task ${taskId} does not contain exactly ${record.repetitions} repetitions`);
		}
	}
	const pass = runs.filter((run) => run.status === "completed" && run.evalResults?.outcome === "pass").length;
	const summary = {
		total: runs.length,
		pass,
		fail: runs.filter((run) => run.status === "completed" && run.evalResults?.outcome === "fail").length,
		error: runs.filter((run) => run.status === "error").length,
		allPassRate: runs.length === 0 ? 0 : pass / runs.length,
	};
	if (!sameJson(summary, record.summary)) mismatch(evalRunId, "summary does not match verified runs");
	return { record, runs, artifacts, hasRunHashes: record.runArtifacts !== undefined };
}
/** Hashes exact grader-result arrays without projecting reason text into public DTOs. */
export function exactSignalDigest(snapshot: VerifiedEvalRun): string {
	return hashValue(snapshot.runs.map((run) => ({
		runId: run.runId,
		taskId: run.taskId,
		repetitionIndex: run.repetitionIndex,
		status: run.status,
		graders: run.evalResults?.graders ?? null,
		outcome: run.evalResults?.outcome ?? null,
	})));
}

export function exactSnapshotIdentity(snapshot: VerifiedEvalRun): {
	evalRunHash: string;
	runArtifacts: NonNullable<EvalRunRecord["runArtifacts"]> | null;
	signalDigest: string;
} {
	return {
		evalRunHash: hashValue(snapshot.record),
		runArtifacts: snapshot.record.runArtifacts ?? null,
		signalDigest: exactSignalDigest(snapshot),
	};
}
