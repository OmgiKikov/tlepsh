import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	GradersFile,
	resolveTaskGraders,
	suiteHashOf,
	type GraderSpec,
	type ResolvedTarget,
	type ResolvedTask,
} from "./manifest.js";
import {
	DEFAULT_EVAL_JOBS,
	EVAL_RUN_SCHEMA_VERSION,
	defaultEvalJobs,
	gradeRecordedRun,
	isSealedEvalRun,
	loadVerifiedEvalRun,
	newEvalRunId,
	runBoundedPool,
	writeEvalRun,
	type EvalRunRecord,
} from "./eval.js";
import {
	RunRecordSchema,
	canonicalJson,
	hashValue,
	modelFingerprint,
	provenanceAxes,
	provenanceKey,
	type JudgeMetrics,
	type RunRecord,
} from "./provenance.js";
import { newRunId } from "./runner.js";
import { verifiedRunArtifacts } from "./run-evidence.js";
import { WORLD_STATE_SEGMENTS } from "./target/world-state.js";
import { readJsonArtifact, writeJsonArtifact, writeTextArtifact } from "./storage/artifacts.js";
import { resolveContainedArtifactPath } from "./storage/paths.js";
import { readTraceArtifact, redactTraceText } from "./trace.js";
import { formatPoints } from "./domain/comparison-gate.js";

/**
 * Re-score the recorded traces of an existing EvalRun with graders, without
 * calling the Target model again.
 *
 * The Target model is what an EvalRun is expensive to buy; the graders are what
 * an operator actually iterates on. A regrade separates the two: it copies each
 * recorded `session.jsonl` (hash-verified against the run that produced it) into
 * a new run directory and grades the copy through the same `gradeRecordedRun`
 * seam `runSuite` uses, so the result is an ordinary EvalRun that list, compare,
 * diagnose and report treat like any other.
 *
 * Which graders decide the verdict:
 *
 * - PER-CASE graders come from the ORIGINAL case, always. The dataset resolved
 *   for a regrade must hash-match the source EvalRun's `datasetHash`, and that
 *   hash covers each case's own `graders`, so the graders a case carried when
 *   its trace was recorded are byte-for-byte the graders that re-score it. A
 *   regrade can never re-score a trace against a question it never answered.
 * - SUITE DEFAULT graders — the ones that fill in for a case declaring none —
 *   come from the new graders file: `--graders <path>`, or the Target's current
 *   `evalSuite.graders` at its current checkout.
 * - The JUDGE MODEL comes from the Target's current manifest.
 * - The SIMULATED USER never runs again. Its model must therefore still match
 *   the source provenance exactly; otherwise the old conversation would be
 *   attributed to a model that never produced it.
 *
 * So on a dataset where every case carries its own graders, a regrade with no
 * `--graders` is still meaningful: the judge model can have changed underneath
 * the same rubric, and re-running it is exactly what re-scores those cases.
 *
 * The new `suiteHash` is recomputed from the graders actually used, so a regrade
 * is comparable only to evidence scored the same way: regrade a baseline and a
 * candidate with the same graders and they compare to each other, while a
 * regrade whose graders changed is refused against its own source.
 */

// `baseline` is deliberately absent: it is the one label the reuse scan looks
// for, and derived evidence must never stand in for a measured baseline.
const REGRADE_LABELS = ["solo", "regrade"] as const;
export type RegradeLabel = typeof REGRADE_LABELS[number];

export function isRegradeLabel(value: string): value is RegradeLabel {
	return (REGRADE_LABELS as readonly string[]).includes(value);
}

/** A graders.yaml is a handful of declarative specs, never a data file. */
export const MAX_GRADERS_FILE_BYTES = 256 * 1024;

/** Read one graders.yaml from anywhere on disk, bounded and schema-checked. */
export function readGraderDefaults(path: string): GraderSpec[] {
	const filePath = resolve(path);
	const entry = statSync(filePath);
	if (!entry.isFile()) throw new Error(`--graders ${path} is not a regular file`);
	if (entry.size > MAX_GRADERS_FILE_BYTES) {
		throw new Error(`--graders ${path} exceeds the ${MAX_GRADERS_FILE_BYTES}-byte bound`);
	}
	const parsed = GradersFile.safeParse(parseYaml(readFileSync(filePath, "utf8")));
	if (!parsed.success) throw new Error(`${path}: ${parsed.error.message}`);
	return parsed.data.defaults;
}

export interface RegradeOptions {
	runsRoot: string;
	/** The eval run whose recorded traces are re-scored. */
	evalRunId: string;
	/**
	 * Target resolved to the exact case set the source eval scored: its dataset
	 * must hash-match the source. Its manifest supplies the judge model, and its
	 * graders file supplies the suite defaults unless `graderDefaults` overrides.
	 */
	target: ResolvedTarget;
	/** Suite grader defaults. Defaults to the Target's own graders file. */
	graderDefaults?: readonly GraderSpec[];
	/** Label for the new eval run. Defaults to `regrade`. */
	label?: RegradeLabel;
	/** Concurrent gradings; only judge graders actually contend for a network. */
	jobs?: number;
	/** Host-owned cancellation propagated into judge sessions. */
	signal?: AbortSignal;
}

export type RunOutcome = "pass" | "fail" | "error";

export interface RegradeFlip {
	taskId: string;
	repetitionIndex: number;
	from: RunOutcome;
	to: RunOutcome;
}

export interface RegradeResult {
	/** The new, fully valid EvalRun. */
	record: EvalRunRecord;
	/** The immutable eval run it re-scored. */
	source: EvalRunRecord;
	/** Every member whose outcome changed, in design order. */
	flips: RegradeFlip[];
	/** Aggregate judge spend of this regrade; zeros when no judge grader ran. */
	judge: JudgeMetrics;
	/** True when the source evidence is sealed: callers print counts only. */
	sealed: boolean;
}

function runOutcome(run: RunRecord): RunOutcome {
	if (run.status === "error") return "error";
	return run.evalResults?.outcome ?? "error";
}

/** Target spend is the recorded one; grading spend is re-earned by this regrade. */
function derivedMetrics(metrics: RunRecord["metrics"]): RunRecord["metrics"] {
	const next = { ...metrics };
	delete next.judge;
	return next;
}

function privateRunDirectory(runsRoot: string, runId: string): string {
	const dir = resolveContainedArtifactPath(runsRoot, runId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	return dir;
}

/**
 * Copy one recorded trace into the derived run directory.
 *
 * The bytes are re-read through the canonical bounded reader and checked
 * against the sha256 the original run recorded, so a tampered or oversized
 * trace refuses the whole regrade before one grader — or one judge token — is
 * spent. The copy therefore keeps the source hash by construction.
 */
function copyRecordedTrace(runsRoot: string, run: RunRecord, destinationRunId: string): void {
	if (run.trace.sha256 === null) {
		if (run.status === "completed") {
			throw new Error(`run ${run.runId} completed without a recorded trace hash; there is nothing to re-grade`);
		}
		return;
	}
	const content = readTraceArtifact(
		resolveContainedArtifactPath(runsRoot, run.runId),
		run.trace.path,
		run.trace.sha256,
	);
	writeTextArtifact(
		resolveContainedArtifactPath(runsRoot, destinationRunId, run.trace.path),
		content,
		{ mode: 0o600, immutable: true },
	);
}

interface PlannedRegrade {
	source: RunRecord;
	record: RunRecord;
	task: ResolvedTask;
}

export async function regradeEvalRun(options: RegradeOptions): Promise<RegradeResult> {
	const { runsRoot, target } = options;
	if (options.signal?.aborted) throw options.signal.reason ?? new Error("regrade aborted");
	const source = loadVerifiedEvalRun(runsRoot, options.evalRunId);
	const sourceRecord = source.record;
	if (target.manifest.id !== sourceRecord.target.id) {
		throw new Error(
			`eval run ${sourceRecord.evalRunId} belongs to target ${sourceRecord.target.id}, not ${target.manifest.id}`,
		);
	}
	// The Target revision is deliberately NOT checked: editing evals/graders.yaml
	// is the point of a regrade and already makes the checkout dirty. The cases
	// are checked instead, because those are what the traces answered.
	if (target.datasetHash !== sourceRecord.datasetHash) {
		throw new Error(
			`regrade needs the exact cases the recorded traces answered: eval run ${sourceRecord.evalRunId} scored ` +
				`${sourceRecord.dataset}/${sourceRecord.datasetHash}, the resolved Target offers ${target.datasetHash}`,
		);
	}
	const first = source.runs[0];
	if (!first) throw new Error(`eval run ${sourceRecord.evalRunId} has no member runs to re-grade`);

	const label: RegradeLabel = options.label ?? "regrade";
	const judge = target.manifest.evalSuite.judge;
	const simulatedUser = target.manifest.evalSuite.simulatedUser;
	const sourceSimulatedUser = sourceRecord.provenance.simulatedUser;
	const currentSimulatedUser = simulatedUser ? modelFingerprint(simulatedUser) : undefined;
	if (canonicalJson(sourceSimulatedUser) !== canonicalJson(currentSimulatedUser)) {
		throw new Error(
			`regrade cannot change the simulated-user model that produced the recorded conversation: ` +
				`source ${sourceSimulatedUser ? `${sourceSimulatedUser.provider}/${sourceSimulatedUser.id}` : "has none"}, ` +
				`Target ${currentSimulatedUser ? `${currentSimulatedUser.provider}/${currentSimulatedUser.id}` : "has none"}`,
		);
	}
	if (target.suiteIdentity === "corpus" && options.graderDefaults !== undefined) {
		throw new Error(
			`eval run ${sourceRecord.evalRunId} scored the published corpus ${sourceRecord.dataset}, whose cases all ` +
				"carry explicit graders: suite defaults cannot change a verdict there, so --graders is refused rather " +
				"than silently ignored. Re-grade the manifest dataset, or publish a corpus with the graders you want.",
		);
	}
	const defaults = options.graderDefaults ?? target.graderDefaults;
	const tasks = new Map(
		resolveTaskGraders(target.tasks, defaults, judge !== undefined, sourceSimulatedUser !== undefined)
			.map((task) => [task.id, task]),
	);
	// One identity rule per resolved surface. A published corpus fixed its own
	// suite hash, and that hash already covers everything a corpus regrade can
	// change (the corpus content and the judge as a measurement input), so the
	// manifest formula must not run here: it would mint an identity no live
	// evaluation can reproduce, and the regrade would drop out of every
	// compatibility check (invariant 15) while still looking like ordinary
	// evidence — the Workbench would rewind to `ready-to-evaluate` and ask for
	// exactly the Target spend a regrade exists to avoid.
	const suiteHash = target.suiteIdentity === "corpus"
		? target.suiteHash
		: suiteHashOf(target.tasks, defaults, judge ?? null, simulatedUser ?? null);
	const evidenceInput = {
		runtime: first.runtime,
		model: first.model,
		judge: judge ? modelFingerprint(judge) : null,
		// A regrade never replays a conversation — it re-scores the recorded one.
		// The source axis is therefore the authority; the equality check above keeps
		// the current manifest useful for rebuilding the suite hash without ever
		// laundering an old dialogue through a new user model.
		simulatedUser: sourceSimulatedUser,
		execution: first.execution,
		eval: { suiteHash, datasetHash: sourceRecord.datasetHash },
	};

	const evalRunId = newEvalRunId();
	const startedAt = new Date().toISOString();
	mkdirSync(runsRoot, { recursive: true, mode: 0o700 });

	// Every trace is verified and copied, and every derived run.json is on disk,
	// before the first grader runs: a refusal costs nothing and a crash mid-way
	// leaves complete provenance for what was already derived.
	const planned: PlannedRegrade[] = source.runs.map((run) => {
		const task = tasks.get(run.taskId);
		if (!task) {
			throw new Error(`eval run ${sourceRecord.evalRunId} scored task ${run.taskId}, which the resolved Target no longer has`);
		}
		if (run.status === "completed" && run.metrics.finalAnswer === undefined) {
			throw new Error(`run ${run.runId} predates host-observed completion; run the case again before regrading it under evaluator v4`);
		}
		const artifacts = verifiedRunArtifacts(runsRoot, run);
		if (run.status === "completed" && task.world && artifacts.world === null) {
			throw new Error(`run ${run.runId} has no attested final world; run the case again before regrading it`);
		}
		const record: RunRecord = {
			...run,
			runId: newRunId(),
			label,
			eval: { ...run.eval, suiteHash },
			metrics: derivedMetrics(run.metrics),
			evalResults: null,
			// Judge evidence is re-earned below, never inherited from the source.
			evidenceArtifacts: { world: run.evidenceArtifacts?.world ?? null, judge: {} },
			// A regrade is never a candidate arm: the revision lineage it re-scores
			// stays reachable through derivedFrom, not through candidateOf.
			parent: { evalRunId, candidateOf: null },
			derivedFrom: { evalRunId: sourceRecord.evalRunId, runId: run.runId },
		};
		privateRunDirectory(runsRoot, record.runId);
		copyRecordedTrace(runsRoot, run, record.runId);
		if (artifacts.world !== null) {
			writeTextArtifact(
				resolveContainedArtifactPath(runsRoot, record.runId, ...WORLD_STATE_SEGMENTS),
				canonicalJson(artifacts.world),
				{ mode: 0o600, immutable: true },
			);
		}
		writeJsonArtifact(
			resolveContainedArtifactPath(runsRoot, record.runId, "run.json"),
			RunRecordSchema,
			record,
		);
		return { source: run, record, task };
	});

	const jobs = options.jobs ?? (judge ? defaultEvalJobs(judge) : DEFAULT_EVAL_JOBS);
	const graded = await runBoundedPool(planned, jobs, async (item) => {
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("regrade aborted");
		// An infrastructure error is inconclusive evidence, not an answer: there is
		// no verdict to revise, so the derived run keeps the error it inherited.
		if (item.record.status === "error") {
			return { record: item.record, outcome: "error" as const, graded: null };
		}
		return gradeRecordedRun(item.task, item.record, runsRoot, judge, options.signal);
	});
	if (options.signal?.aborted) throw options.signal.reason ?? new Error("regrade aborted");

	const runIds = graded.map((item) => item.record.runId);
	const total = runIds.length;
	const pass = graded.filter((item) => item.outcome === "pass").length;
	const fail = graded.filter((item) => item.outcome === "fail").length;
	const error = graded.filter((item) => item.outcome === "error").length;
	const sealed = isSealedEvalRun(sourceRecord);
	// A regrade re-decides judge graders, so it pays the judge again — its own
	// spend, never the source's.
	const judgeCostUsd = graded.reduce(
		(sum, item) => sum + (item.record.metrics.judge?.costUsd ?? 0),
		0,
	);
	const record: EvalRunRecord = {
		schemaVersion: EVAL_RUN_SCHEMA_VERSION,
		// A regrade re-scores recorded traces; a regrade of a screen would still be
		// a screen, so the source's purpose is copied rather than assumed.
		purpose: sourceRecord.purpose,
		evalRunId,
		target: sourceRecord.target,
		label,
		baselineEvalRunId: null,
		regradeOf: sourceRecord.evalRunId,
		provenance: provenanceAxes(evidenceInput),
		provenanceKey: provenanceKey(evidenceInput),
		suiteId: sourceRecord.suiteId,
		suiteHash,
		dataset: sourceRecord.dataset,
		datasetHash: sourceRecord.datasetHash,
		// A sealed source stays sealed. A legacy index without an explicit
		// boundary is classified before it is copied, never widened by default.
		evidenceVisibility: sourceRecord.evidenceVisibility ?? (sealed ? "sealed" : "development"),
		taskIds: [...new Set(source.runs.map((run) => run.taskId))],
		repetitions: sourceRecord.repetitions,
		runIds,
		runArtifacts: runIds.map((runId) => ({
			runId,
			sha256: hashValue(readJsonArtifact(
				resolveContainedArtifactPath(runsRoot, runId, "run.json"),
				RunRecordSchema,
			)),
		})),
		startedAt,
		finishedAt: new Date().toISOString(),
		summary: { total, pass, fail, error, allPassRate: total === 0 ? 0 : pass / total },
		...(judgeCostUsd > 0 ? { judgeCostUsd } : {}),
	};
	writeEvalRun(runsRoot, record);

	const flips: RegradeFlip[] = [];
	for (const [index, item] of graded.entries()) {
		const before = runOutcome(planned[index]!.source);
		if (before === item.outcome) continue;
		flips.push({
			taskId: item.record.taskId,
			repetitionIndex: item.record.repetitionIndex,
			from: before,
			to: item.outcome,
		});
	}
	const judgeSpend = graded.reduce<JudgeMetrics>(
		(spend, item) => ({
			calls: spend.calls + (item.graded?.judge?.calls ?? 0),
			tokens: spend.tokens + (item.graded?.judge?.tokens ?? 0),
			costUsd: spend.costUsd + (item.graded?.judge?.costUsd ?? 0),
		}),
		{ calls: 0, tokens: 0, costUsd: 0 },
	);
	return { record, source: sourceRecord, flips, judge: judgeSpend, sealed };
}

/**
 * One-screen result. Sealed evidence prints counts only: which cases changed
 * verdict is itself holdout information.
 */
export function renderRegradeSummary(result: RegradeResult): string[] {
	const before = result.source.summary;
	const after = result.record.summary;
	const lines = [
		`regraded ${result.record.evalRunId} from ${result.source.evalRunId}: ` +
			`${before.pass}/${before.total} → ${after.pass}/${after.total} ` +
			`(Δ ${formatPoints(after.allPassRate - before.allPassRate)}) · ` +
			`judge calls ${result.judge.calls} · $${result.judge.costUsd.toFixed(4)}`,
	];
	if (result.flips.length === 0) {
		lines.push("  no outcome changed");
		return lines;
	}
	if (result.sealed) {
		lines.push(`  ${result.flips.length} outcome(s) changed · sealed evidence: task ids withheld`);
		return lines;
	}
	for (const flip of result.flips) {
		lines.push(
			`  ${redactTraceText(flip.taskId).slice(0, 200)}#${flip.repetitionIndex}: ${flip.from} → ${flip.to}`,
		);
	}
	return lines;
}
