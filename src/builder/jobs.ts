import { plural, t } from "../i18n.js";
import type { RunEvent, RunEventListener } from "../run-events.js";
import type { WorkbenchRunEstimate } from "../workbench/transition-policy.js";
import type {
	WorkbenchConfirmationKind,
	WorkbenchDecisionResult,
} from "../workbench/types.js";
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

export type BuilderJobResult =
	| { status: "completed"; result: WorkbenchDecisionResult | null }
	| { status: "running"; job: ActiveJob };

export interface BuilderJobStart {
	/** Only measurement operations may leave the foreground. */
	background?: boolean;
	/** The initiating turn can cancel only while this operation remains foreground. */
	signal?: AbortSignal;
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
	id: string;
	state: "awaiting-authorization" | "running" | "stopping";
	command: string;
	label: string;
	/** `120/372` while runs are graded, `—` before the first one. */
	progress: string;
	elapsedMs: number;
	background: boolean;
}

export interface BuilderJobs {
	closed(): boolean;
	active(): ActiveJob | null;
	/** Resolves when the command that started this job may return. */
	start(input: BuilderJobStart): Promise<BuilderJobResult>;
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
		id: string;
		authorized: boolean;
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
	let sequence = 0;
	let disposed = false;
	const snapshot = (job: RunningJob): ActiveJob => ({
		id: job.id,
		state: job.stopping ? "stopping" : job.authorized ? "running" : "awaiting-authorization",
		command: job.command, label: job.label, progress: progressOf(job),
		elapsedMs: now() - job.startedAt, background: job.background,
	});

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
		if (disposed || running !== job) return;
		if (event.run.total > 0) job.total = event.run.total;
		if (event.type === "run_graded") job.graded += 1;
		writeStatus();
	};

	return {
		closed: () => disposed,
		active() { return running ? snapshot(running) : null; },
		busy() {
			if (!running) return null;
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
			if (disposed) throw new Error("Builder session is closed");
			if (input.signal?.aborted) throw input.signal.reason ?? new Error("operation cancelled");
			if (running) throw new Error(t("job.busy", { label: running.label, progress: progressOf(running) }));
			const job: RunningJob = {
				id: `job-${++sequence}`,
				authorized: false,
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

			let returned = false;
			let release!: (result: BuilderJobResult) => void;
			let fail!: (error: unknown) => void;
			const returnable = new Promise<BuilderJobResult>((resolve, reject) => {
				release = (result) => { if (!returned) { returned = true; resolve(result); } };
				fail = (error) => { if (!returned) { returned = true; reject(error); } };
			});
			const interrupt = (): void => {
				job.stopping = true;
				job.controller.abort(input.signal?.reason ?? new Error("operation cancelled"));
			};
			input.signal?.addEventListener("abort", interrupt, { once: true });
			const goBackground = (authorization: JobAuthorization): void => {
				job.authorized = true;
				job.label = input.label(authorization.kind);
				if (disposed || job.controller.signal.aborted || job.background || returned || input.background === false) return;
				const estimate = authorization.estimate;
				// A composite may first approve a description or a release. That is
				// not yet a running measurement; wait for its actual spending step.
				const measurement = ["run-eval", "verify-candidate", "calibrate", "regrade", "improve"].includes(authorization.kind)
					|| (["start-testing", "apply-proposal"].includes(authorization.kind) && (estimate?.executions ?? 0) > 0);
				if (!measurement) return;
				const minutes = estimateMinutes(estimate);
				if (!ALWAYS_BACKGROUND.has(authorization.kind) && minutes !== null && minutes < backgroundThresholdMinutes(env)) return;
				job.background = true;
				input.signal?.removeEventListener("abort", interrupt);
				job.ticker = startTimer(writeStatus, STATUS_TICK_MS);
				try {
					host.show({
						title: t("panel.title", { detail: t("panel.background") }), tone: "info",
						lines: [oneLine([t("job.started"), job.label, estimateLine(estimate)].filter(Boolean).join(" · "), 160)],
					});
				} catch { /* A presentation failure cannot revoke an approved operation. */ }
				release({ status: "running", job: snapshot(job) });
			};

			const settle = async (
				tone: TranscriptTone,
				key: "job.finished" | "job.failed" | "job.stopped",
				detail: string,
				note: string,
			): Promise<void> => {
				const took = elapsed(now() - job.startedAt);
				if (job.background && !disposed) {
					try {
						host.show({
							title: t("panel.title", { detail: t("panel.background") }), tone,
							lines: [oneLine([t(key), job.label, took, detail].filter(Boolean).join(" · "), 200)],
						});
					} catch { /* Delivery does not change the completed operation. */ }
					try {
						await host.waitForIdle();
					} catch {
						// A host that cannot report idleness still gets the note.
					}
					if (disposed) return;
					try {
						host.note(note, {
							label: t("note.job", { label: job.label, detail: oneLine(detail || took, 80) }), triggerTurn: true,
						});
					} catch { /* A closed host cannot receive a continuation. */ }
				}
			};

			void (async () => {
				try {
					const result = await input.run({
						signal: job.controller.signal,
						onRunEvent: observe(job),
						authorized: (authorization) => {
							const planned = authorization.estimate?.executions ?? 0;
							if (planned > 0) job.planned = Math.max(job.planned ?? 0, planned);
							goBackground(authorization);
						},
					});
					if (!result) {
						finish(job);
						release({ status: "completed", result: null });
						await settle("warning", "job.stopped", "", `The background ${input.command} ended without a new decision result. Completed artifacts remain saved. Call ahde_workbench_view before continuing.`);
						return;
					}
					if (disposed) return;
					let headline = result.message;
					try { headline = await input.present(result, job.background); }
					catch { /* The durable result remains true when its panel cannot render. */ }
					finish(job);
					release({ status: "completed", result });
					await settle(
						"success",
						"job.finished",
						oneLine(headline, 120),
						`The background ${input.command} finished: ${oneLine(headline, 200)}. ` +
						"Call ahde_workbench_view before relying on any earlier state.",
					);
				} catch (error) {
					finish(job);
					if (disposed) return;
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
							? `The operator stopped the background ${input.command}. Completed changes and artifacts remain saved. Refresh ahde_workbench_view before continuing; do not assume rollback or treat interrupted runs as quality evidence.`
							: `The background ${input.command} failed: ${oneLine(message, 200)}. Completed changes and artifacts may remain saved. Call ahde_workbench_view before continuing; failed execution is not evidence of agent quality.`,
					);
				} finally {
					finish(job);
					input.signal?.removeEventListener("abort", interrupt);
					release({ status: "completed", result: null });
				}
			})().catch(fail);

			return returnable;
		},
		dispose() {
			disposed = true;
			if (running) {
				running.controller.abort(new Error("Builder session closed"));
				if (running.ticker) stopTimer(running.ticker);
				running = null;
			}
			writeStatus();
		},
	};
}
