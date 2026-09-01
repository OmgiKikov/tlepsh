import { plural, t } from "../i18n.js";
import type { RunEvent, RunEventListener } from "../run-events.js";
import type {
	WorkbenchConfirmationKind,
	WorkbenchDecisionResult,
} from "../workbench/types.js";
import type { WorkbenchRunEstimate } from "../workbench/transition-policy.js";
import { oneLine } from "./render/format.js";
import { coarseElapsed, elapsed } from "./render/receipt.js";
import type { TranscriptTone } from "./transcript.js";

/**
 * Background measurements.
 *
 * A verification of 372 executions takes a quarter of an hour. Freezing the
 * conversation for it is the difference between an instrument and a wait: the
 * operator should be able to keep reading, keep asking, and be told when the
 * measurement lands.
 *
 * Nothing here is durable and nothing here is authority. A job is one decision
 * the host already had the right to run, held in memory while it runs:
 *
 *  - one at a time per Builder, because two concurrent measurements would
 *    compete for the same Target and the same money;
 *  - the decision goes to the background only after the human gate answered,
 *    so a question is still asked in front of the operator, never behind them;
 *  - a second consequential decision is refused with one sentence while a job
 *    is running, rather than queued into a surprise;
 *  - the job holds its own AbortController, so `/stop` cancels the measurement
 *    through the same signal the Workbench already honours.
 */

export const JOB_STATUS_KEY = "ahde-job";

/** Minutes above which a measurement is worth backgrounding. */
const DEFAULT_BACKGROUND_MINUTES = 1;
/** Decisions that always go to the background: they are never quick. */
const ALWAYS_BACKGROUND: ReadonlySet<WorkbenchConfirmationKind> = new Set([
	"verify-candidate",
	"calibrate",
	"improve",
]);
/** If the gate never answers (a host without a dialog), start anyway. */
const AUTHORIZATION_GRACE_MS = 2_000;
const STATUS_TICK_MS = 5_000;

export interface JobAuthorization {
	kind: WorkbenchConfirmationKind;
	estimate: WorkbenchRunEstimate | null;
}

export interface JobRunOptions {
	signal: AbortSignal;
	onRunEvent: RunEventListener;
	/** Called by the gate the moment the operator (or the routine policy) approved. */
	authorized(authorization: JobAuthorization): void;
}

export interface BuilderJobStart {
	/** The slash command that asked for it, for the notes. */
	command: string;
	/**
	 * The localized subject. `/run` only learns whether it is a test run or a
	 * candidate verification when the Workbench asks the gate, so the label is
	 * re-read then: `null` is what we can say before the decision resolved.
	 */
	label(kind: WorkbenchConfirmationKind | null): string;
	run(options: JobRunOptions): Promise<WorkbenchDecisionResult | null>;
	/**
	 * Show the finished decision (panel + receipt) and return its one-line
	 * headline. A backgrounded job owns the model note itself, so that it can
	 * trigger a turn only once the operator is idle.
	 */
	present(result: WorkbenchDecisionResult, background: boolean): Promise<string>;
}

export interface BuilderJobHost {
	setStatus(key: string, text: string | undefined): void;
	show(block: { title: string; tone: TranscriptTone; lines: string[] }): void;
	/** Hidden context for the Builder plus the visible one-line label. */
	note(text: string, options: { label: string; triggerTurn: boolean }): void;
	/** Resolves when nothing is streaming, so a note may trigger a turn. */
	waitForIdle(): Promise<void>;
}

export interface ActiveJob {
	command: string;
	label: string;
	/** `120/372` while runs are graded, `—` before the first one. */
	progress: string;
	elapsedMs: number;
	background: boolean;
}

export interface BuilderJobs {
	active(): ActiveJob | null;
	/** Resolves when the command that started this job may return. */
	start(input: BuilderJobStart): Promise<void>;
	/** One sentence refusing a second consequential decision, or null when free. */
	busy(): string | null;
	/** Cancel the running job. False when nothing was running. */
	stop(): boolean;
	/** `/jobs`: what is running, or that nothing is. */
	lines(): string[];
	dispose(): void;
}

function estimateMinutes(estimate: WorkbenchRunEstimate | null): number | null {
	return estimate && typeof estimate.minutes === "number" ? estimate.minutes : null;
}

function backgroundThresholdMinutes(env: NodeJS.ProcessEnv): number {
	const configured = env.AHDE_JOB_MIN_MINUTES?.trim();
	if (!configured) return DEFAULT_BACKGROUND_MINUTES;
	const raw = Number(configured);
	return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_BACKGROUND_MINUTES;
}

/** `~372 Target executions · ~14 minutes`, and nothing when nothing is known. */
export function estimateLine(estimate: WorkbenchRunEstimate | null): string {
	if (!estimate) return "";
	const parts: string[] = [];
	if (estimate.executions > 0) parts.push(`~${plural(estimate.executions, "execution")}`);
	const minutes = estimateMinutes(estimate);
	if (minutes !== null) parts.push(`~${plural(Math.max(1, Math.ceil(minutes)), "minute")}`);
	return parts.join(" · ");
}

export interface BuilderJobsOptions {
	host: BuilderJobHost;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	/** Injected for tests; the real timer is unref'd so it never holds the process. */
	setInterval?: (handler: () => void, ms: number) => { unref?(): void };
	clearInterval?: (handle: unknown) => void;
}

export function createBuilderJobs(options: BuilderJobsOptions): BuilderJobs {
	const host = options.host;
	const env = options.env ?? process.env;
	const now = options.now ?? (() => Date.now());
	const startTimer = options.setInterval ?? ((handler, ms) => {
		const handle = setInterval(handler, ms);
		handle.unref?.();
		return handle;
	});
	const stopTimer = options.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));

	interface RunningJob {
		command: string;
		label: string;
		controller: AbortController;
		startedAt: number;
		graded: number;
		/** The last eval run's own total; the fallback when no estimate priced the job. */
		total: number;
		/** What the approved estimate says the WHOLE job will execute. */
		planned: number | null;
		background: boolean;
		stopping: boolean;
		ticker: { unref?(): void } | null;
	}

	let running: RunningJob | null = null;

	// A verification runs two arms over two baskets, so one eval run's total is
	// not the job's. Prefer what the gate priced, and never print a denominator
	// smaller than what has already been graded.
	const progressOf = (job: RunningJob): string => {
		const total = Math.max(job.planned ?? job.total, job.graded);
		return total > 0 ? `${job.graded}/${total}` : "—";
	};

	const writeStatus = (): void => {
		if (!running) {
			try {
				host.setStatus(JOB_STATUS_KEY, undefined);
			} catch {
				// The status bar is cosmetic.
			}
			return;
		}
		const text = oneLine(
			`${running.label} ${progressOf(running)} · ${coarseElapsed(now() - running.startedAt)}`,
			60,
		);
		try {
			host.setStatus(JOB_STATUS_KEY, text);
		} catch {
			// The status bar is cosmetic.
		}
	};

	const finish = (job: RunningJob): void => {
		if (job.ticker) stopTimer(job.ticker);
		job.ticker = null;
		if (running === job) running = null;
		writeStatus();
	};

	const observe = (job: RunningJob): RunEventListener => (event: RunEvent) => {
		if (event.run.total > 0) job.total = event.run.total;
		if (event.type === "run_graded") job.graded += 1;
		writeStatus();
	};

	return {
		active() {
			if (!running) return null;
			return {
				command: running.command,
				label: running.label,
				progress: progressOf(running),
				elapsedMs: now() - running.startedAt,
				background: running.background,
			};
		},
		busy() {
			if (!running || !running.background) return null;
			return t("job.busy", { label: running.label, progress: progressOf(running) });
		},
		stop() {
			if (!running) return false;
			running.stopping = true;
			try {
				running.controller.abort(new Error("stopped by the operator"));
			} catch {
				// An already-aborted controller is the outcome we wanted.
			}
			return true;
		},
		lines() {
			if (!running) return [t("job.none")];
			return [
				`${running.label} ${progressOf(running)} · ${coarseElapsed(now() - running.startedAt)}`,
				t("job.stop-hint"),
			];
		},
		async start(input) {
			if (running) throw new Error(t("job.busy", { label: running.label, progress: progressOf(running) }));
			const job: RunningJob = {
				command: input.command,
				label: input.label(null),
				controller: new AbortController(),
				startedAt: now(),
				graded: 0,
				total: 0,
				planned: null,
				background: false,
				stopping: false,
				ticker: null,
			};
			running = job;
			writeStatus();

			// The command handler waits on exactly one thing: permission to return.
			// A foreground measurement keeps its failure — the operator asked for it
			// and is still standing in front of it.
			let settled = false;
			let release: () => void = () => undefined;
			let fail: (error: unknown) => void = () => undefined;
			const returnable = new Promise<void>((resolve, reject) => {
				release = () => {
					if (settled) return;
					settled = true;
					resolve();
				};
				fail = (error) => {
					if (settled) return;
					settled = true;
					reject(error);
				};
			});
			const goBackground = (authorization: JobAuthorization | null): void => {
				if (authorization) job.label = input.label(authorization.kind);
				if (job.background || settled) return;
				const estimate = authorization?.estimate ?? null;
				const minutes = estimateMinutes(estimate);
				const long = authorization === null ||
					ALWAYS_BACKGROUND.has(authorization.kind) ||
					minutes === null ||
					minutes >= backgroundThresholdMinutes(env);
				if (!long) return;
				job.background = true;
				job.ticker = startTimer(writeStatus, STATUS_TICK_MS);
				host.show({
					title: t("panel.title", { detail: t("panel.background") }),
					tone: "info",
					lines: [oneLine([t("job.started"), job.label, estimateLine(estimate)].filter(Boolean).join(" · "), 160)],
				});
				release();
			};
			const grace = setTimeout(() => goBackground(null), AUTHORIZATION_GRACE_MS);
			grace.unref?.();

			const settle = async (
				tone: TranscriptTone,
				key: "job.finished" | "job.failed" | "job.stopped",
				detail: string,
				note: string,
			): Promise<void> => {
				const took = elapsed(now() - job.startedAt);
				if (job.background) {
					host.show({
						title: t("panel.title", { detail: t("panel.background") }),
						tone,
						lines: [oneLine([t(key), job.label, took, detail].filter(Boolean).join(" · "), 200)],
					});
					try {
						await host.waitForIdle();
					} catch {
						// A host that cannot report idleness still gets the note.
					}
					host.note(note, {
						label: t("note.job", { label: job.label, detail: oneLine(detail || took, 80) }),
						triggerTurn: true,
					});
				}
			};

			void (async () => {
				try {
					const result = await input.run({
						signal: job.controller.signal,
						onRunEvent: observe(job),
						authorized: (authorization) => {
							clearTimeout(grace);
							const planned = authorization.estimate?.executions ?? 0;
							if (planned > 0) job.planned = Math.max(job.planned ?? 0, planned);
							goBackground(authorization);
						},
					});
					clearTimeout(grace);
					if (!result) {
						// Declined or handled as a warning; the command layer already said so.
						return;
					}
					const headline = await input.present(result, job.background);
					await settle(
						"success",
						"job.finished",
						oneLine(headline, 120),
						`The background ${input.command} finished: ${oneLine(headline, 200)}. ` +
						"Call ahde_workbench_view before relying on any earlier state.",
					);
				} catch (error) {
					clearTimeout(grace);
					const message = error instanceof Error ? error.message : String(error);
					const stopped = job.stopping || job.controller.signal.aborted;
					if (!job.background) {
						fail(error);
						return;
					}
					await settle(
						stopped ? "warning" : "error",
						stopped ? "job.stopped" : "job.failed",
						oneLine(stopped ? "" : message, 160),
						stopped
							? `The operator stopped the background ${input.command}. Nothing was decided.`
							: `The background ${input.command} failed: ${oneLine(message, 200)}.`,
					);
				} finally {
					finish(job);
					release();
				}
			})();

			return returnable;
		},
		dispose() {
			if (running) {
				if (running.ticker) stopTimer(running.ticker);
				running = null;
			}
			writeStatus();
		},
	};
}
