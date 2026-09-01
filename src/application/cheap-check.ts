/**
 * The cheap check: run a candidate on the cases that already failed, once,
 * candidate arm only, before paying for a matched verification.
 *
 * A verification costs (development + sealed tasks) × repetitions × 2 arms.
 * This costs `failed tasks × 1`. It is a SCREEN and never evidence:
 *
 * - its EvalRun carries `purpose: "screen"`, written atomically with the record
 *   itself. Baseline reuse, the comparison gate, promotion evidence,
 *   regression-case selection and the Workbench inventory all read that field,
 *   so a process killed before anything else is written still leaves a run
 *   nothing will admit;
 * - it also carries the one-arm `solo` label, but purpose — not label — is the
 *   exclusion boundary. Ordinary solo development evidence may be reused;
 *   a screen may not, and it can never stand in for a candidate arm;
 * - every screen is additionally recorded in `runs/screens/<id>.json` as
 *   belt-and-braces. {@link screenExclusion} reads that sidecar and fails
 *   CLOSED: an unreadable marker refuses everything it might name;
 * - nothing here ever calls the comparison gate. The screen compares the
 *   candidate's outcomes with the *recorded* outcomes of the source eval,
 *   which is a reading of artifacts, not a matched measurement.
 *
 * Invariant 9: an infrastructure error is inconclusive, never a behavioural
 * failure — an over-budget screen reports `withinErrorBudget: false` and the
 * caller must spend the full verification anyway.
 *
 * Invariant 15: the screen re-tests the exact development surface that
 * produced the source eval (dataset label, dataset hash, suite hash).
 */

import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { z } from "zod";
import type { CorpusRef, LoadedCorpus } from "../corpus.js";
import { loadCorpus } from "../corpus.js";
import { withinInfrastructureBudget } from "../domain/comparison-gate.js";
import {
	loadVerifiedEvalRun,
	readEvalRunIndex,
	runSuite,
	type EvalRunRecord,
} from "../eval.js";
import { withDetachedWorktree } from "../git/experiment-worktree.js";
import { loadTarget, type ResolvedTarget } from "../manifest.js";
import type { RunRecord } from "../provenance.js";
import type { RunEventListener } from "../run-events.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";
import { assertEvalSurfaceMatches, targetWithDevelopmentCorpus } from "./corpus-target.js";
import { loadBuilderApplyReceipt, loadBuilderProposalRunEnvelope } from "./builder-proposal.js";
import { CandidateRecordSchema, type CandidateRecord } from "../domain/candidate.js";

/**
 * The screen borrows the one launchable label that is never reused as a
 * baseline and never stands in for a candidate arm. Adding a first-class
 * `screen` label would have to change the EvalRun schema in `src/eval.ts`.
 */
export const CHEAP_CHECK_SCREEN_LABEL = "solo" as const;

/**
 * A screen's identity, written into its EvalRun. This — not the sidecar — is
 * what `findReusableBaseline`, the comparison gate, promotion evidence,
 * regression-case selection and the Workbench inventory read.
 */
export const CHEAP_CHECK_SCREEN_PURPOSE = "screen" as const;

/** One screen repetition. More would make it a measurement, not a screen. */
export const CHEAP_CHECK_REPETITIONS = 1;

const ArtifactIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const MAX_SCREEN_TASKS = 1_000;

export type CheapCheckClassification = "improved" | "unchanged" | "regressed" | "inconclusive";

export const CheapCheckRowSchema = z.strictObject({
	taskId: z.string().min(1).max(200),
	/** Recorded pass rate of this task in the source eval, over completed runs. */
	sourcePassRate: z.number().min(0).max(1),
	sourceFailures: z.number().int().nonnegative(),
	screenOutcome: z.enum(["pass", "fail", "error"]),
	classification: z.enum(["improved", "unchanged", "regressed", "inconclusive"]),
	runId: ArtifactIdSchema,
});
export type CheapCheckRow = z.infer<typeof CheapCheckRowSchema>;

/**
 * Durable, versioned marker that one EvalRun is a screen. Nothing downstream
 * has to guess: promotion evidence and regression-case selection read this.
 */
export const CheapCheckScreenRecordSchema = z.strictObject({
	schemaVersion: z.literal(1),
	kind: z.literal("cheap-check-screen"),
	screenId: ArtifactIdSchema,
	/** The screen's own EvalRun. Never a baseline, never a candidate arm. */
	evalRunId: ArtifactIdSchema,
	/** The development EvalRun whose recorded failures the screen re-ran. */
	sourceEvalRunId: ArtifactIdSchema,
	targetId: z.string().min(1).max(200),
	baseTargetSha: z.string().regex(/^[0-9a-f]{40}$/),
	candidateSha: z.string().regex(/^[0-9a-f]{40}$/),
	surface: z.strictObject({
		dataset: z.string().min(1).max(200),
		datasetHash: HashSchema,
		suiteHash: HashSchema,
	}),
	taskIds: z.array(z.string().min(1).max(200)).max(MAX_SCREEN_TASKS),
	runIds: z.array(ArtifactIdSchema).max(MAX_SCREEN_TASKS),
	rows: z.array(CheapCheckRowSchema).max(MAX_SCREEN_TASKS),
	summary: z.strictObject({
		tasks: z.number().int().nonnegative(),
		improved: z.number().int().nonnegative(),
		unchanged: z.number().int().nonnegative(),
		regressed: z.number().int().nonnegative(),
		inconclusive: z.number().int().nonnegative(),
	}),
	verdict: z.enum(["promising", "flat"]),
	withinErrorBudget: z.boolean(),
	createdAt: z.string().min(1).max(64),
});
export type CheapCheckScreenRecord = z.infer<typeof CheapCheckScreenRecordSchema>;

export interface CheapCheckResult {
	/** Failed task ids the screen ran, in evaluation order. */
	tasks: string[];
	improved: number;
	unchanged: number;
	regressed: number;
	/** Screened tasks whose run errored: inconclusive, never a failure. */
	inconclusive: number;
	/** `flat` means zero previously-failing tasks now pass. */
	verdict: "promising" | "flat";
	runIds: string[];
	rows: CheapCheckRow[];
	/**
	 * False when the screen's own infrastructure errors blew the budget. A
	 * `flat` verdict from such a screen is inconclusive and must not stop a
	 * verification (invariant 9).
	 */
	withinErrorBudget: boolean;
	screenId: string;
	screenEvalRunId: string;
	screenRecordPath: string;
	sourceEvalRunId: string;
	candidateSha: string;
}

export interface CheapCheckOptions {
	repositoryDir: string;
	runsRoot: string;
	/** Exact revision to screen. */
	candidateRef: string;
	/** The revision the source eval measured. */
	baselineRef: string;
	/** Development EvalRun whose recorded failures define the screened set. */
	sourceEvalRunId: string;
	/** The published development corpus the source eval used, when it used one. */
	developmentCorpus?: CorpusRef;
	/** Dataset override, mutually exclusive with `developmentCorpus`. */
	dataset?: string;
	jobs?: number;
	signal?: AbortSignal;
	onRunEvent?: RunEventListener;
	now?: () => string;
}

export interface CheapCheckDependencies {
	runSuite: typeof runSuite;
	loadTarget: typeof loadTarget;
	loadCorpus: typeof loadCorpus;
	withDetachedWorktree: typeof withDetachedWorktree;
}

const DEFAULT_DEPENDENCIES: CheapCheckDependencies = {
	runSuite,
	loadTarget,
	loadCorpus,
	withDetachedWorktree,
};

export class CheapCheckError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(`cheap check rejected: ${message}`, options);
		this.name = "CheapCheckError";
	}
}

function screensRoot(runsRoot: string): string {
	return join(resolve(runsRoot), "screens");
}

export function screenRecordPath(runsRoot: string, screenId: string): string {
	return join(screensRoot(runsRoot), `${ArtifactIdSchema.parse(screenId)}.json`);
}

/**
 * What the `runs/screens/` sidecar says, including what it fails to say.
 *
 * The sidecar is belt-and-braces now that {@link EvalRunRecord.purpose} carries
 * a screen's identity, and it fails CLOSED: an entry that cannot be read still
 * names something, so whatever it might name is refused. A marker keeps its
 * screen's eval run id in its filename (`screen-<evalRunId>.json`), so a
 * corrupt-but-named marker blocks exactly that run; a marker whose name reveals
 * nothing blocks everything, because everything is what it might name.
 */
export interface ScreenExclusion {
	/** Eval runs a readable — or name-readable — marker calls a screen. */
	ids: Set<string>;
	/** Marker filenames that could not be read at all. */
	unreadable: string[];
	/** True when an unreadable marker's filename named no eval run. */
	blocksEverything: boolean;
}

const NAMED_SCREEN_MARKER = /^screen-([A-Za-z0-9][A-Za-z0-9._-]{0,199})\.json$/;

export function screenExclusion(runsRoot: string): ScreenExclusion {
	const ids = new Set<string>();
	const unreadable: string[] = [];
	let blocksEverything = false;
	const root = screensRoot(runsRoot);
	if (!existsSync(root)) return { ids, unreadable, blocksEverything };
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		// A screens directory that cannot be listed hides an unknown number of
		// screens. Nothing in it can be ruled out, so nothing is admitted.
		return { ids, unreadable: [root], blocksEverything: true };
	}
	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		try {
			const record = readJsonArtifact(join(root, entry), CheapCheckScreenRecordSchema);
			ids.add(record.evalRunId);
			continue;
		} catch {
			unreadable.push(entry);
		}
		const named = NAMED_SCREEN_MARKER.exec(entry);
		if (named) ids.add(named[1]!);
		else blocksEverything = true;
	}
	return { ids, unreadable, blocksEverything };
}

/**
 * Every EvalRun this project's sidecar records as a screen. Kept for callers
 * that only need the set; use {@link screenExclusion} where an unreadable
 * marker has to fail closed.
 */
export function screenEvalRunIds(runsRoot: string): Set<string> {
	return screenExclusion(runsRoot).ids;
}

/**
 * True when this EvalRun is excluded from evidence: a screen, or quarantined
 * legacy one-arm evidence whose purpose cannot be reconstructed. The record's
 * own `purpose` is the primary answer; the sidecar is consulted after it, and
 * an unreadable marker refuses rather than passes.
 */
export function isScreenEvalRun(runsRoot: string, evalRunId: string): boolean {
	try {
		if (readEvalRunIndex(runsRoot, evalRunId).purpose !== "evidence") return true;
	} catch {
		// An index that will not parse is not proof of anything; the sidecar and
		// every downstream verifier still get their say.
	}
	const exclusion = screenExclusion(runsRoot);
	return exclusion.blocksEverything || exclusion.ids.has(evalRunId);
}

interface TaskOutcomeAggregate {
	pass: number;
	fail: number;
	error: number;
}

function aggregateByTask(runs: readonly RunRecord[]): Map<string, TaskOutcomeAggregate> {
	const byTask = new Map<string, TaskOutcomeAggregate>();
	for (const run of runs) {
		const entry = byTask.get(run.taskId) ?? { pass: 0, fail: 0, error: 0 };
		if (run.status !== "completed") entry.error += 1;
		else if (run.evalResults?.outcome === "pass") entry.pass += 1;
		else if (run.evalResults?.outcome === "fail") entry.fail += 1;
		else entry.error += 1;
		byTask.set(run.taskId, entry);
	}
	return byTask;
}

/**
 * The tasks a screen re-runs: those with at least one recorded *behavioural*
 * failure. A task whose only non-pass runs were infrastructure errors is
 * inconclusive, not failed, and is deliberately left out (invariant 9).
 */
export function resolveFailedTaskIds(runs: readonly RunRecord[]): string[] {
	const aggregates = aggregateByTask(runs);
	const failed: string[] = [];
	const seen = new Set<string>();
	for (const run of runs) {
		if (seen.has(run.taskId)) continue;
		if ((aggregates.get(run.taskId)?.fail ?? 0) === 0) continue;
		seen.add(run.taskId);
		failed.push(run.taskId);
	}
	return failed;
}

function classify(
	source: TaskOutcomeAggregate,
	screenOutcome: "pass" | "fail" | "error",
): CheapCheckClassification {
	if (screenOutcome === "error") return "inconclusive";
	const completed = source.pass + source.fail;
	const sourcePassRate = completed === 0 ? 0 : source.pass / completed;
	if (screenOutcome === "pass") return "improved";
	// It still fails. If it used to pass some of the time and does not now,
	// that is a regression inside the screened set, not "no change".
	return sourcePassRate > 0 ? "regressed" : "unchanged";
}

function screenTarget(target: ResolvedTarget, taskIds: readonly string[]): ResolvedTarget {
	const wanted = new Set(taskIds);
	const tasks = target.tasks.filter((task) => wanted.has(task.id));
	if (tasks.length !== wanted.size) {
		const missing = [...wanted].filter((id) => !tasks.some((task) => task.id === id));
		throw new CheapCheckError(
			`the candidate development surface no longer carries ${missing.length} screened case(s)`,
		);
	}
	return { ...target, tasks };
}

function resolveScreenSurface(
	dependencies: CheapCheckDependencies,
	worktreePath: string,
	options: CheapCheckOptions,
	source: EvalRunRecord,
): { target: ResolvedTarget; corpus: LoadedCorpus | null } {
	if (options.dataset && options.developmentCorpus) {
		throw new CheapCheckError("a screen cannot combine --dataset with an explicit development corpus");
	}
	const base = dependencies.loadTarget(
		worktreePath,
		options.dataset ? { dataset: options.dataset } : undefined,
	);
	const corpus = options.developmentCorpus ? dependencies.loadCorpus(options.developmentCorpus) : null;
	if (corpus && corpus.metadata.visibility !== "development") {
		throw new CheapCheckError(
			`a screen runs on development cases, got ${corpus.metadata.visibility} (${corpus.metadata.id})`,
		);
	}
	const target = corpus ? targetWithDevelopmentCorpus(base, corpus) : base;
	// Invariant 15: a candidate re-tests the exact development surface that
	// produced its source eval — the screen included.
	assertEvalSurfaceMatches(target, source, "cheap-check screen surface");
	return { target, corpus };
}

/**
 * Run the candidate on exactly the cases the source eval recorded as failing,
 * once, and compare with those cases' recorded outcomes.
 */
export async function runCheapCheck(
	options: CheapCheckOptions,
	dependenciesInput: Partial<CheapCheckDependencies> = {},
): Promise<CheapCheckResult> {
	const dependencies: CheapCheckDependencies = { ...DEFAULT_DEPENDENCIES, ...dependenciesInput };
	const runsRoot = resolve(options.runsRoot);
	const now = options.now ?? (() => new Date().toISOString());

	if (isScreenEvalRun(runsRoot, options.sourceEvalRunId)) {
		throw new CheapCheckError("a screen cannot be screened against another screen");
	}
	const source = loadVerifiedEvalRun(runsRoot, options.sourceEvalRunId);
	if (source.record.evidenceVisibility === "sealed") {
		throw new CheapCheckError("a screen never reads sealed evidence");
	}
	if (source.record.label === "candidate") {
		throw new CheapCheckError("a screen measures against recorded baseline outcomes, not another candidate arm");
	}
	const sourceByTask = aggregateByTask(source.runs);
	const failedTaskIds = resolveFailedTaskIds(source.runs);
	if (failedTaskIds.length === 0) {
		throw new CheapCheckError(
			`source eval ${options.sourceEvalRunId} recorded no behavioural failure; there is nothing to screen`,
		);
	}
	if (failedTaskIds.length > MAX_SCREEN_TASKS) {
		throw new CheapCheckError(`a screen is bounded to ${MAX_SCREEN_TASKS} cases`);
	}

	return dependencies.withDetachedWorktree(
		{ repositoryDir: resolve(options.repositoryDir), ref: options.candidateRef },
		async (worktree) => {
			const { target } = resolveScreenSurface(dependencies, worktree.path, options, source.record);
			const subset = screenTarget(target, failedTaskIds);
			mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
			const screen = await dependencies.runSuite(subset, {
				runsRoot,
				label: CHEAP_CHECK_SCREEN_LABEL,
				// Written into the EvalRun itself, atomically with the record: the
				// marker below is belt-and-braces, and a crash between the two leaves
				// a run that every reader still refuses.
				purpose: CHEAP_CHECK_SCREEN_PURPOSE,
				repetitions: CHEAP_CHECK_REPETITIONS,
				evidenceVisibility: "development",
				...(options.jobs === undefined ? {} : { jobs: options.jobs }),
				...(options.signal ? { signal: options.signal } : {}),
				...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
			});
			const executed = loadVerifiedEvalRun(runsRoot, screen.evalRunId);
			const rows: CheapCheckRow[] = [];
			for (const taskId of failedTaskIds) {
				const run = executed.runs.find((candidate) => candidate.taskId === taskId);
				if (!run) throw new CheapCheckError(`screen produced no run for case ${taskId}`);
				const screenOutcome = run.status !== "completed"
					? "error" as const
					: run.evalResults?.outcome === "pass"
						? "pass" as const
						: run.evalResults?.outcome === "fail"
							? "fail" as const
							: "error" as const;
				const aggregate = sourceByTask.get(taskId) ?? { pass: 0, fail: 0, error: 0 };
				const completed = aggregate.pass + aggregate.fail;
				rows.push(CheapCheckRowSchema.parse({
					taskId,
					sourcePassRate: completed === 0 ? 0 : aggregate.pass / completed,
					sourceFailures: aggregate.fail,
					screenOutcome,
					classification: classify(aggregate, screenOutcome),
					runId: run.runId,
				}));
			}
			const count = (kind: CheapCheckClassification): number =>
				rows.filter((row) => row.classification === kind).length;
			const summary = {
				tasks: rows.length,
				improved: count("improved"),
				unchanged: count("unchanged"),
				regressed: count("regressed"),
				inconclusive: count("inconclusive"),
			};
			const withinErrorBudget = withinInfrastructureBudget(summary.inconclusive, summary.tasks);
			const verdict = summary.improved > 0 ? "promising" as const : "flat" as const;
			const screenId = `screen-${screen.evalRunId}`;
			const record = CheapCheckScreenRecordSchema.parse({
				schemaVersion: 1,
				kind: "cheap-check-screen",
				screenId,
				evalRunId: screen.evalRunId,
				sourceEvalRunId: source.record.evalRunId,
				targetId: subset.manifest.id,
				baseTargetSha: source.record.target.gitSha,
				candidateSha: worktree.sha,
				surface: {
					dataset: screen.dataset,
					datasetHash: screen.datasetHash,
					suiteHash: screen.suiteHash,
				},
				taskIds: failedTaskIds,
				runIds: screen.runIds,
				rows,
				summary,
				verdict,
				withinErrorBudget,
				createdAt: now(),
			});
			mkdirSync(screensRoot(runsRoot), { recursive: true, mode: 0o700 });
			const path = screenRecordPath(runsRoot, screenId);
			writeJsonArtifact(path, CheapCheckScreenRecordSchema, record, { immutable: true });
			return {
				tasks: failedTaskIds,
				improved: summary.improved,
				unchanged: summary.unchanged,
				regressed: summary.regressed,
				inconclusive: summary.inconclusive,
				verdict,
				runIds: [...screen.runIds],
				rows,
				withinErrorBudget,
				screenId,
				screenEvalRunId: screen.evalRunId,
				screenRecordPath: path,
				sourceEvalRunId: source.record.evalRunId,
				candidateSha: worktree.sha,
			} satisfies CheapCheckResult;
		},
	);
}

export interface CheapCheckCandidateOptions {
	repositoryDir: string;
	runsRoot: string;
	stateRoot: string;
	candidateId: string;
	/** Refuses when the record names another project; never selects one. */
	expectedProjectId?: string;
	jobs?: number;
	signal?: AbortSignal;
	onRunEvent?: RunEventListener;
	now?: () => string;
}

/**
 * The scriptable form: screen the exact revision one Candidate record was
 * built from, against the development EvalRun its Builder proposal came from.
 */
export async function runCheapCheckForCandidate(
	options: CheapCheckCandidateOptions,
	dependencies: Partial<CheapCheckDependencies> = {},
): Promise<CheapCheckResult> {
	const runsRoot = resolve(options.runsRoot);
	// Read the record directly rather than through candidate-review, which
	// depends on this module for the screen exclusion.
	const record = readJsonArtifact(
		resolveContainedArtifactPath(runsRoot, "candidates", options.candidateId, "candidate.json"),
		CandidateRecordSchema,
	);
	const plan = cheapCheckPlanForCandidate(record, options.stateRoot);
	assertExpectedProject(plan, options.expectedProjectId, `candidate ${options.candidateId}`);
	return runCheapCheck({
		repositoryDir: options.repositoryDir,
		runsRoot,
		candidateRef: plan.candidateSha,
		baselineRef: plan.baseTargetSha,
		sourceEvalRunId: plan.sourceEvalRunId,
		...(plan.developmentCorpus ? { developmentCorpus: plan.developmentCorpus } : {}),
		...(options.jobs === undefined ? {} : { jobs: options.jobs }),
		...(options.signal ? { signal: options.signal } : {}),
		...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
		...(options.now ? { now: options.now } : {}),
	}, dependencies);
}

export interface CheapCheckBuilderRunOptions {
	repositoryDir: string;
	runsRoot: string;
	stateRoot: string;
	builderRunId: string;
	/** Refuses when the Builder run names another project; never selects one. */
	expectedProjectId?: string;
	jobs?: number;
	signal?: AbortSignal;
	onRunEvent?: RunEventListener;
	now?: () => string;
}

/**
 * The screen where the skill puts it: before the verification it exists to
 * save. An applied Builder run already carries everything the screen needs —
 * the source eval on the run record, the exact revisions on the apply receipt —
 * so it does not have to wait for the CandidateRecord `ahde candidate` writes.
 */
export async function runCheapCheckForBuilderRun(
	options: CheapCheckBuilderRunOptions,
	dependencies: Partial<CheapCheckDependencies> = {},
): Promise<CheapCheckResult> {
	const runsRoot = resolve(options.runsRoot);
	const plan = cheapCheckPlanForBuilderRun(runsRoot, options.builderRunId, options.stateRoot);
	assertExpectedProject(plan, options.expectedProjectId, `builder run ${options.builderRunId}`);
	return runCheapCheck({
		repositoryDir: options.repositoryDir,
		runsRoot,
		candidateRef: plan.candidateSha,
		baselineRef: plan.baseTargetSha,
		sourceEvalRunId: plan.sourceEvalRunId,
		...(plan.developmentCorpus ? { developmentCorpus: plan.developmentCorpus } : {}),
		...(options.jobs === undefined ? {} : { jobs: options.jobs }),
		...(options.signal ? { signal: options.signal } : {}),
		...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
		...(options.now ? { now: options.now } : {}),
	}, dependencies);
}

/** What an applied Builder run says a screen of it would have to run. */
export function cheapCheckPlanForBuilderRun(
	runsRoot: string,
	builderRunId: string,
	stateRoot: string,
): CheapCheckPlan {
	const run = loadBuilderProposalRunEnvelope(runsRoot, builderRunId);
	const source = run.request.source;
	if (!source) {
		throw new CheapCheckError(
			`builder run ${builderRunId} has no source development eval to screen against`,
		);
	}
	let receipt;
	try {
		receipt = loadBuilderApplyReceipt(runsRoot, builderRunId);
	} catch (error) {
		throw new CheapCheckError(
			`builder run ${builderRunId} has not been applied; run \`ahde apply --builder-run ${builderRunId}\` first`,
			{ cause: error },
		);
	}
	const projectId = run.request.approvedSpec?.projectId ?? null;
	const corpus = run.request.sourceAttestation?.developmentCorpus ?? null;
	return {
		candidateSha: receipt.candidateSha,
		baseTargetSha: receipt.baseTargetSha,
		sourceEvalRunId: source.evalRunId,
		developmentCorpus: corpus && projectId
			? { stateRoot: resolve(stateRoot), projectId, corpusId: corpus.id }
			: null,
		projectId,
	};
}

export interface CheapCheckPlan {
	candidateSha: string;
	baseTargetSha: string;
	sourceEvalRunId: string;
	developmentCorpus: CorpusRef | null;
	/** The project the evidence itself names. Null on legacy evidence only. */
	projectId: string | null;
}

/**
 * A screen never selects its project — it reads the one its evidence was
 * recorded under. `--project` is therefore a check, not a selector: naming a
 * different project is a mistake about which candidate is being screened, and
 * silently screening the other one would be worse than saying so.
 */
export function assertExpectedProject(plan: CheapCheckPlan, expected: string | undefined, subject: string): void {
	if (expected === undefined || plan.projectId === null || plan.projectId === expected) return;
	throw new CheapCheckError(
		`${subject} belongs to project ${plan.projectId}, not ${expected}`,
	);
}

/** What a Candidate record says a screen of it would have to run. */
export function cheapCheckPlanForCandidate(
	record: CandidateRecord,
	stateRoot: string,
): CheapCheckPlan {
	if (record.origin.kind !== "applied-builder") {
		throw new CheapCheckError("only a Builder-seeded candidate carries the source eval a screen compares against");
	}
	const source = record.origin.source;
	if (!source) {
		throw new CheapCheckError(`candidate ${record.candidateId} has no source development eval to screen against`);
	}
	const built = record.events.find((event) => event.type === "built");
	if (built?.type !== "built") {
		throw new CheapCheckError(`candidate ${record.candidateId} has no built revision to screen`);
	}
	return {
		candidateSha: built.candidate.sha,
		baseTargetSha: record.origin.application.baseTargetSha,
		sourceEvalRunId: source.evalRunId,
		developmentCorpus: source.developmentCorpus
			? { stateRoot: resolve(stateRoot), projectId: record.projectId, corpusId: source.developmentCorpus.id }
			: null,
		projectId: record.projectId,
	};
}

/** One line an operator reads: what the screen cost and what it found. */
export function renderCheapCheckLine(result: CheapCheckResult): string {
	const detail = `${result.improved} improved · ${result.unchanged} unchanged · ${result.regressed} regressed` +
		(result.inconclusive > 0 ? ` · ${result.inconclusive} inconclusive` : "");
	const caveat = result.withinErrorBudget
		? ""
		: " (over the infrastructure error budget — inconclusive, not a reason to stop)";
	return `screen ${result.verdict} · ${result.tasks.length} previously failing case` +
		`${result.tasks.length === 1 ? "" : "s"} × 1 · ${detail}${caveat}`;
}
