import type { CompareOptions, CompareResult, CompareRow, CompareSummary } from "../compare.js";
import {
	loadRun,
	readEvalRunIndex,
	type EvidenceVisibility,
	type EvalRunRecord,
	type VerifiedEvalRun,
} from "../eval.js";
import {
	axisDifferences,
	canonicalJson,
	hashValue,
	provenanceAxes,
	sha256Hex,
	type RunRecord,
} from "../provenance.js";

/** Locale-independent UTF-8 ordering for every persisted/public projection. */
export function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

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
	const runs = record.runIds.map((runId) => {
		const run = loadRun(runsRoot, runId);
		if (run.runId !== runId) mismatch(evalRunId, `run path ${runId} contains record ${run.runId}`);
		const expectedHash = expectedHashes.get(runId);
		if (expectedHash && hashValue(run) !== expectedHash) {
			mismatch(evalRunId, `run ${runId} hash does not match the final eval index`);
		}
		if (run.parent?.evalRunId !== record.evalRunId) mismatch(evalRunId, `run ${runId} parent does not reference this eval`);
		if (
			run.target.id !== record.target.id ||
			run.target.gitSha !== record.target.gitSha ||
			run.target.toolsetHash !== record.target.toolsetHash ||
			run.target.workspaceHash !== record.target.workspaceHash
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
	return { record, runs, hasRunHashes: record.runArtifacts !== undefined };
}

function perTask(runs: readonly RunRecord[]): Map<string, { pass: number; total: number; status: string }> {
	const tasks = new Map<string, { pass: number; total: number; status: string }>();
	for (const run of runs) {
		const entry = tasks.get(run.taskId) ?? { pass: 0, total: 0, status: run.status };
		entry.total += 1;
		if (run.evalResults?.outcome === "pass") entry.pass += 1;
		if (run.status === "error") entry.status = "error";
		tasks.set(run.taskId, entry);
	}
	return tasks;
}

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function bootstrap95(deltas: number[], seedText: string): { low: number; high: number } {
	if (deltas.length === 0) return { low: 0, high: 0 };
	if (deltas.length === 1) return { low: deltas[0] ?? 0, high: deltas[0] ?? 0 };
	let state = Number.parseInt(sha256Hex(seedText).slice(0, 8), 16) >>> 0;
	const random = (): number => {
		state += 0x6d2b79f5;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
	const samples: number[] = [];
	for (let sample = 0; sample < 5_000; sample += 1) {
		let total = 0;
		for (let index = 0; index < deltas.length; index += 1) {
			total += deltas[Math.floor(random() * deltas.length)] ?? 0;
		}
		samples.push(total / deltas.length);
	}
	samples.sort((left, right) => left - right);
	return {
		low: samples[Math.floor(samples.length * 0.025)] ?? 0,
		high: samples[Math.floor(samples.length * 0.975)] ?? 0,
	};
}

/** Compare two already-verified snapshots without reopening any evidence. */
export function compareExactEvalSnapshots(
	baseline: VerifiedEvalRun,
	candidate: VerifiedEvalRun,
	options: CompareOptions = {},
): CompareResult {
	const a = baseline.record;
	const b = candidate.record;
	const mode = options.mode ?? "candidate";
	const invalid: string[] = [];
	const differences = axisDifferences(a.provenance, b.provenance);
	if (differences.length > 0) invalid.push(`differing axes: ${differences.join(", ")}`);
	if (a.target.id !== b.target.id) invalid.push(`different targets: ${a.target.id} vs ${b.target.id}`);
	if (a.repetitions !== b.repetitions) invalid.push(`different repetitions: ${a.repetitions} vs ${b.repetitions}`);
	if (mode === "candidate" && (a.label !== "baseline" || b.label !== "candidate")) {
		invalid.push(`candidate comparison requires baseline → candidate labels, got ${a.label} → ${b.label}`);
	}
	if (mode === "candidate" && a.target.gitSha === b.target.gitSha) {
		invalid.push(`baseline and candidate resolve to the same revision ${a.target.gitSha}`);
	}
	if ((mode === "candidate" || mode === "aa-calibration") && (!baseline.hasRunHashes || !candidate.hasRunHashes)) {
		invalid.push("promotion-grade comparison requires final run artifact hashes");
	}
	if ((mode === "candidate" || mode === "aa-calibration") && b.baselineEvalRunId !== a.evalRunId) {
		invalid.push(`candidate eval ${b.evalRunId} is not linked to baseline eval ${a.evalRunId}`);
	}
	if ((mode === "candidate" || mode === "aa-calibration") &&
		candidate.runs.some((run) => run.parent?.candidateOf !== a.target.gitSha)) {
		invalid.push("candidate RunRecords do not point to the exact baseline target revision");
	}
	if (mode === "aa-calibration" && a.target.gitSha !== b.target.gitSha) {
		invalid.push("A/A calibration requires the same target revision");
	}

	const aTasks = perTask(baseline.runs);
	const bTasks = perTask(candidate.runs);
	const taskIds = [...new Set([...aTasks.keys(), ...bTasks.keys()])].sort(compareUtf8);
	const rows: CompareRow[] = taskIds.map((taskId) => {
		const ae = aTasks.get(taskId);
		const be = bTasks.get(taskId);
		const aRate = ae && ae.total > 0 ? ae.pass / ae.total : 0;
		const bRate = be && be.total > 0 ? be.pass / be.total : 0;
		return {
			taskId,
			aPassRate: aRate,
			bPassRate: bRate,
			delta: bRate - aRate,
			aStatus: ae?.status ?? "missing",
			bStatus: be?.status ?? "missing",
			aPass: ae?.pass ?? 0,
			aTotal: ae?.total ?? 0,
			bPass: be?.pass ?? 0,
			bTotal: be?.total ?? 0,
		};
	});
	if (!sameJson([...aTasks.keys()].sort(compareUtf8), [...bTasks.keys()].sort(compareUtf8))) invalid.push("task sets differ");
	for (const row of rows) {
		if (row.aTotal !== a.repetitions || row.bTotal !== b.repetitions) {
			invalid.push(`task ${row.taskId} has incomplete repetitions: ${row.aTotal}/${a.repetitions} vs ${row.bTotal}/${b.repetitions}`);
		}
	}
	const infrastructure = [
		...rows.filter((row) => row.aStatus === "error").map((row) => `baseline task ${row.taskId} errored`),
		...rows.filter((row) => row.bStatus === "error").map((row) => `candidate task ${row.taskId} errored`),
	];
	const improved = rows.filter((row) => row.delta > 0).length;
	const regressed = rows.filter((row) => row.delta < 0).length;
	const deltas = rows.map((row) => row.delta);
	const summary: CompareSummary = {
		taskCount: rows.length,
		baselinePassRate: mean(rows.map((row) => row.aPassRate)),
		candidatePassRate: mean(rows.map((row) => row.bPassRate)),
		delta: mean(deltas),
		confidence95: bootstrap95(deltas, `${a.evalRunId}:${b.evalRunId}`),
		improved,
		regressed,
		unchanged: rows.length - improved - regressed,
	};
	const issues = [...invalid, ...infrastructure];
	const status = invalid.length > 0 ? "invalid" : infrastructure.length > 0 ? "inconclusive" : "comparable";
	const error = status === "comparable"
		? null
		: `${status === "invalid" ? "not comparable" : "inconclusive"}: ${issues.join("; ")} ` +
			`(baseline=${a.evalRunId}, candidate=${b.evalRunId})`;
	return { a, b, rows, status, issues, summary, error };
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
