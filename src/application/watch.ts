import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { compareVerifiedEvalRuns, runCost } from "../compare.js";
import {
	isSealedEvalRun,
	listEvalRunIndexesLenient,
	loadVerifiedEvalRun,
	runSuite,
	type EvalRunRecord,
	type VerifiedEvalRun,
} from "../eval.js";
import type { ResolvedTarget } from "../manifest.js";
import type { RunRecord } from "../provenance.js";
import type { RunEventListener } from "../run-events.js";
import { calibrationProjection } from "../workbench/calibration.js";
import type { WorkbenchCalibrationProjection } from "../workbench/types.js";
import type { CandidateRecord } from "../domain/candidate.js";
import { loadCandidateRecord } from "./candidate-review.js";
import { screenEvalRunIds } from "./cheap-check.js";

/**
 * `ahde watch`: the basket on a schedule, drift told apart from noise.
 *
 * Nothing about the Target changes between two ticks — same revision, same
 * workspace, same basket, same model id. So the pair is an A/A experiment, and
 * the comparison gate's honest answer to an A/A pair is `inconclusive`
 * (`domain/comparison-gate.ts`). Anything else on an unchanged revision is
 * evidence of behavioural drift somewhere below the harness boundary; the
 * score alone cannot identify which external component moved.
 *
 *   inconclusive → healthy
 *   regressed    → drift (the 95% interval is entirely below zero)
 *   improved     → drift as well; on an unchanged revision a gain is not a win
 *
 * A calibration of this exact revision, when one exists, says how much of
 * today's difference the harness produces against itself, so the operator can
 * see whether the number is inside known noise. Without one the line says
 * `noise not calibrated` rather than implying the difference means something.
 *
 * A tick writes exactly one ordinary development EvalRun and nothing else. No
 * candidate, no receipt, no promotion, no adoption, no new artifact type —
 * drift is a fact to look at, never a state change.
 */

/** Duration bounds for `--every`: a tick a minute is already aggressive. */
export const MIN_WATCH_INTERVAL_MS = 10_000;
export const MAX_WATCH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1_000;
/** Ticks one `--every` loop will run without `--max-runs`. */
export const MAX_WATCH_RUNS = 1_000;

export type WatchStatus = "healthy" | "drift" | "no-baseline" | "not-comparable";

/** Exit codes `ahde watch` reports, so a supervisor can act on a tick. */
export const WATCH_EXIT_HEALTHY = 0;
export const WATCH_EXIT_NO_BASELINE = 2;
export const WATCH_EXIT_DRIFT = 3;
export type WatchExitCode =
	| typeof WATCH_EXIT_HEALTHY
	| typeof WATCH_EXIT_NO_BASELINE
	| typeof WATCH_EXIT_DRIFT;

export interface WatchCalibration {
	candidateId: string;
	/** Share of cases that moved between two identical arms of this revision. */
	flipRate: number;
	tasks: number;
	repetitions: number;
	at: string;
}

export interface WatchTick {
	/** Wall clock at which the tick's eval run was recorded. */
	at: string;
	/** The active Target revision this tick ran. Unchanged by construction. */
	revision: string;
	targetId: string;
	evalRunId: string;
	/** Mean grader score of this tick, in [0,1]. */
	score: number;
	passRate: number;
	/** The previous watch run this tick was paired with. */
	previousEvalRunId: string | null;
	previousScore: number | null;
	/** The development gate verdict of the A/A pair, when there was one. */
	verdict: string | null;
	status: WatchStatus;
	/** Why the pair could not be compared; null when it could. */
	note: string | null;
	calibration: WatchCalibration | null;
	/** What this tick spent, in USD. */
	costUsd: number;
}

export interface WatchResult {
	ticks: WatchTick[];
	/** True when any tick in this run reported drift. */
	drifted: boolean;
	exitCode: WatchExitCode;
}

export interface WatchDependencies {
	runSuite: typeof runSuite;
	loadVerifiedEvalRun: typeof loadVerifiedEvalRun;
	compare: typeof compareVerifiedEvalRuns;
}

const DEFAULT_DEPENDENCIES: WatchDependencies = {
	runSuite,
	loadVerifiedEvalRun,
	compare: compareVerifiedEvalRuns,
};

export interface WatchTickOptions {
	target: ResolvedTarget;
	runsRoot: string;
	repetitions: number;
	jobs?: number;
	/** Only this project's calibration counts as this revision's noise. */
	projectId?: string;
	onRunEvent?: RunEventListener;
	signal?: AbortSignal;
	/** Bootstrap resamples; tests lower it. */
	resamples?: number;
}

export interface WatchLoopOptions extends WatchTickOptions {
	/** Milliseconds between ticks. Omit for a single tick. */
	everyMs?: number;
	/** Hard bound on ticks; defaults to one without `everyMs`. */
	maxRuns?: number;
	onTick?: (tick: WatchTick) => void;
	/** Monotonic clock, so a long tick cannot make the schedule drift. */
	monotonicNow?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Partial credit for one run: the mean of its grader scores, clamped to [0,1].
 * A run with no graders keeps the binary handling. The same definition
 * `compare.ts` uses, so a tick's own number and the gate's agree.
 */
function runScore(record: RunRecord): number {
	const graders = record.evalResults?.graders ?? [];
	if (graders.length === 0) return record.evalResults?.outcome === "pass" ? 1 : 0;
	const average = graders.reduce((sum, grader) => sum + grader.score, 0) / graders.length;
	return Math.min(1, Math.max(0, average));
}

/** Per-task mean over repetitions, then the mean over tasks. */
export function meanGraderScore(runs: readonly RunRecord[]): number {
	const byTask = new Map<string, { score: number; total: number }>();
	for (const run of runs) {
		const entry = byTask.get(run.taskId) ?? { score: 0, total: 0 };
		entry.score += runScore(run);
		entry.total += 1;
		byTask.set(run.taskId, entry);
	}
	if (byTask.size === 0) return 0;
	let total = 0;
	for (const entry of byTask.values()) total += entry.total > 0 ? entry.score / entry.total : 0;
	return total / byTask.size;
}

/** What a tick actually spent: the Target's tokens plus the graders it paid for. */
export function evalRunCostUsd(runs: readonly RunRecord[]): number {
	return runs.reduce(
		(total, run) =>
			total + (runCost(run) ?? 0) + (run.metrics.judge?.costUsd ?? 0) + (run.metrics.simulatedUser?.costUsd ?? 0),
		0,
	);
}

/**
 * The previous tick.
 *
 * A watch run is an ordinary `solo` development eval of this exact revision on
 * this exact basket. Screens carry `solo` too and are never evidence, so the
 * durable `runs/screens/` markers exclude them by id; sealed evidence, a
 * regrade, a different design and a different basket are excluded because they
 * are not the same measurement. Nothing new is stored to find this: the newest
 * matching index is the previous tick.
 */
export function findPreviousWatchRun(
	runsRootInput: string,
	target: ResolvedTarget,
	options: { repetitions: number },
): EvalRunRecord | null {
	const runsRoot = resolve(runsRootInput);
	const screens = screenEvalRunIds(runsRoot);
	const candidates = listEvalRunIndexesLenient(runsRoot).records.filter((record) =>
		record.label === "solo" &&
		record.regradeOf === undefined &&
		!screens.has(record.evalRunId) &&
		!isSealedEvalRun(record) &&
		record.target.id === target.manifest.id &&
		record.target.gitSha === target.gitSha &&
		record.suiteHash === target.suiteHash &&
		record.datasetHash === target.datasetHash &&
		record.repetitions === options.repetitions);
	// `listEvalRunIndexesLenient` already sorts newest first.
	return candidates[0] ?? null;
}

/** Directory names only, never following a symlink into somewhere else. */
function candidateIds(runsRoot: string): string[] {
	const root = join(resolve(runsRoot), "candidates");
	if (!existsSync(root)) return [];
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

/**
 * The newest A/A calibration of this exact revision. Calibration expires with
 * the revision it measured, so a calibration of another SHA says nothing about
 * today's noise and is not offered as if it did.
 */
export function findRevisionCalibration(
	runsRootInput: string,
	target: ResolvedTarget,
	options: { projectId?: string } = {},
): WatchCalibration | null {
	const runsRoot = resolve(runsRootInput);
	let newest: WorkbenchCalibrationProjection | null = null;
	for (const candidateId of candidateIds(runsRoot)) {
		let record: CandidateRecord;
		try {
			record = loadCandidateRecord(runsRoot, candidateId);
		} catch {
			// An unreadable calibration record narrows the answer, never fails it.
			continue;
		}
		if (record.mode !== "aa-calibration") continue;
		if (record.targetId !== target.manifest.id) continue;
		if (options.projectId !== undefined && record.projectId !== options.projectId) continue;
		if (record.baseline.sha !== target.gitSha) continue;
		const projection = calibrationProjection(record);
		if (!projection) continue;
		if (newest === null || projection.at > newest.at) newest = projection;
	}
	return newest === null
		? null
		: {
			candidateId: newest.candidateId,
			flipRate: newest.flipRate,
			tasks: newest.taskCount,
			repetitions: newest.repetitions,
			at: newest.at,
		};
}

/** `improved` and `regressed` are both drift on a revision that did not move. */
function statusOf(verdict: string): WatchStatus {
	return verdict === "inconclusive" ? "healthy" : "drift";
}

/**
 * One tick: run the basket against the ACTIVE Target revision as ordinary
 * development evidence, then compare it with the previous tick of the same
 * revision through the exploratory gate.
 */
export async function runWatchTick(
	options: WatchTickOptions,
	dependenciesInput: Partial<WatchDependencies> = {},
): Promise<WatchTick> {
	const dependencies: WatchDependencies = { ...DEFAULT_DEPENDENCIES, ...dependenciesInput };
	const runsRoot = resolve(options.runsRoot);
	const previous = findPreviousWatchRun(runsRoot, options.target, { repetitions: options.repetitions });
	const record = await dependencies.runSuite(options.target, {
		runsRoot,
		// Ordinary development evidence. Never a candidate arm: a watch has no
		// second revision to be a candidate of.
		label: "solo",
		repetitions: options.repetitions,
		evidenceVisibility: "development",
		...(options.jobs !== undefined ? { jobs: options.jobs } : {}),
		...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	});
	const current = dependencies.loadVerifiedEvalRun(runsRoot, record.evalRunId);
	const calibration = findRevisionCalibration(runsRoot, options.target, {
		...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
	});
	const base: Omit<WatchTick, "previousEvalRunId" | "previousScore" | "verdict" | "status" | "note"> = {
		at: record.finishedAt,
		revision: options.target.gitSha,
		targetId: options.target.manifest.id,
		evalRunId: record.evalRunId,
		score: meanGraderScore(current.runs),
		passRate: record.summary.allPassRate,
		calibration,
		costUsd: evalRunCostUsd(current.runs),
	};
	if (!previous) {
		return {
			...base,
			previousEvalRunId: null,
			previousScore: null,
			verdict: null,
			status: "no-baseline",
			note: "no earlier watch run of this revision and basket; the next tick has something to compare with",
		};
	}
	let comparison: ReturnType<WatchDependencies["compare"]>;
	let previousVerified: VerifiedEvalRun;
	try {
		previousVerified = dependencies.loadVerifiedEvalRun(runsRoot, previous.evalRunId);
		comparison = dependencies.compare(previousVerified, current, {
			mode: "exploratory",
			surface: "development",
			...(options.resamples !== undefined ? { resamples: options.resamples } : {}),
		});
	} catch (error) {
		return {
			...base,
			previousEvalRunId: previous.evalRunId,
			previousScore: null,
			verdict: null,
			status: "not-comparable",
			note: `previous watch run ${previous.evalRunId} could not be read: ${
				(error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").slice(0, 200)
			}`,
		};
	}
	if (comparison.status === "invalid") {
		return {
			...base,
			previousEvalRunId: previous.evalRunId,
			previousScore: meanGraderScore(previousVerified.runs),
			verdict: null,
			status: "not-comparable",
			note: (comparison.error ?? "the pair is not comparable").replace(/\s+/gu, " ").slice(0, 300),
		};
	}
	const verdict = comparison.gate.verdict;
	return {
		...base,
		previousEvalRunId: previous.evalRunId,
		previousScore: meanGraderScore(previousVerified.runs),
		verdict,
		status: statusOf(verdict),
		note: comparison.status === "inconclusive"
			? (comparison.error ?? "").replace(/\s+/gu, " ").slice(0, 300) || null
			: null,
	};
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise<void>((resolvePromise) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolvePromise();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolvePromise();
		};
		if (signal?.aborted) {
			clearTimeout(timer);
			resolvePromise();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** healthy 0 · no usable baseline 2 · drift 3, and drift anywhere wins. */
export function watchExitCode(ticks: readonly WatchTick[]): WatchExitCode {
	if (ticks.some((tick) => tick.status === "drift")) return WATCH_EXIT_DRIFT;
	const last = ticks.at(-1);
	if (!last) return WATCH_EXIT_NO_BASELINE;
	return last.status === "healthy" ? WATCH_EXIT_HEALTHY : WATCH_EXIT_NO_BASELINE;
}

/**
 * `--once` is one tick; `--every` loops on a monotonic schedule until SIGINT
 * or `--max-runs`. The next deadline is computed from a monotonic clock rather
 * than added to the previous one, so a slow tick shortens the wait instead of
 * pushing the whole schedule later.
 */
export async function runWatch(
	options: WatchLoopOptions,
	dependenciesInput: Partial<WatchDependencies> = {},
): Promise<WatchResult> {
	const everyMs = options.everyMs;
	if (everyMs !== undefined && (!Number.isFinite(everyMs) || everyMs < MIN_WATCH_INTERVAL_MS || everyMs > MAX_WATCH_INTERVAL_MS)) {
		throw new Error(`watch interval must be between ${MIN_WATCH_INTERVAL_MS}ms and ${MAX_WATCH_INTERVAL_MS}ms`);
	}
	const maxRuns = everyMs === undefined
		? 1
		: Math.trunc(options.maxRuns ?? MAX_WATCH_RUNS);
	if (!Number.isFinite(maxRuns) || maxRuns < 1 || maxRuns > MAX_WATCH_RUNS) {
		throw new Error(`watch maxRuns must be between 1 and ${MAX_WATCH_RUNS}`);
	}
	const monotonicNow = options.monotonicNow ?? (() => performance.now());
	const sleep = options.sleep ?? defaultSleep;
	const started = monotonicNow();
	const ticks: WatchTick[] = [];
	for (let index = 0; index < maxRuns; index += 1) {
		if (options.signal?.aborted) break;
		if (index > 0 && everyMs !== undefined) {
			const deadline = started + index * everyMs;
			await sleep(Math.max(0, deadline - monotonicNow()), options.signal);
			if (options.signal?.aborted) break;
		}
		const tick = await runWatchTick(options, dependenciesInput);
		ticks.push(tick);
		options.onTick?.(tick);
	}
	return {
		ticks,
		drifted: ticks.some((tick) => tick.status === "drift"),
		exitCode: watchExitCode(ticks),
	};
}
