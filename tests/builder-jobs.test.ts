import { describe, expect, it, vi } from "vitest";
import { createBuilderJobs, estimateLine, JOB_STATUS_KEY, type BuilderJobHost } from "../src/builder/jobs.js";
import { registerAhdeBuilderCommands } from "../src/builder/commands.js";
import { stripMarkers, type TranscriptTone } from "../src/builder/transcript.js";
import type { RunEvent, RunEventIdentity } from "../src/run-events.js";
import type { WorkbenchDecisionResult, WorkbenchView } from "../src/workbench/types.js";

const commandView: WorkbenchView = {
	schemaVersion: 1,
	project: { id: "demo", directory: "demo" },
	stage: "candidate-verification",
	headline: "Verify the applied candidate.",
	target: { status: "ready", id: "support-agent", gitSha: "a".repeat(40), model: null },
	focus: {},
	selections: [],
	actions: [],
	blockers: [],
	warnings: [],
	calibration: null,
	counts: {
		specDrafts: 1,
		approvedSpecs: 1,
		corpusDrafts: 1,
		developmentCorpora: 1,
		sealedCorpora: 1,
		developmentEvals: 1,
		openProposals: 0,
		candidates: 1,
		calibrations: 0,
	},
};

/** What the Workbench answers with once the background measurement lands. */
const runEvalResult = {
	kind: "run-eval",
	message: "run complete",
	result: {
		evaluation: { evalRunId: "erun-1", summary: { total: 24, pass: 18, fail: 6, error: 0, allPassRate: 0.75 }, repetitions: 3 },
		diagnosis: {
			diagnosisId: "d-1",
			evalRunId: "erun-1",
			status: "actionable",
			summary: { tasks: 24, healthyTasks: 18, failedTasks: 6, infrastructureErrors: 0, issueCount: 1 },
			issues: [],
			omittedIssues: 0,
		},
		improvementBrief: {
			schemaVersion: 1,
			algorithmId: "exact-eval-signals-v1",
			briefId: "brief-1",
			evalRunId: "erun-1",
			diagnosisId: "d-1",
			status: "actionable",
			proposalEligible: true,
			headline: "18/24 passed.",
			summary: {
				tasks: 24,
				failedTasks: 6,
				infrastructureErrors: 0,
				failureModeCount: 3,
				systemicFailureModeCount: 1,
				taskLocalFailureModeCount: 2,
				omittedFailureModeCount: 0,
			},
			modes: [],
			conversationProjection: { shownModes: 0, addressableModes: 0, omittedModes: 0, fullEvidence: "" },
		},
		evidence: { available: false },
	},
	view: commandView,
} as unknown as WorkbenchDecisionResult;

const identity: RunEventIdentity = {
	evalRunId: "erun-1",
	runId: "run-1",
	taskId: "task-routing",
	repetitionIndex: 0,
	ordinal: 1,
	total: 372,
};

function graded(ordinal: number): RunEvent {
	return {
		type: "run_graded",
		at: "2026-08-28T10:00:00.000Z",
		run: { ...identity, ordinal },
		outcome: "pass",
		passedGraders: 1,
		totalGraders: 1,
	} as RunEvent;
}

const result = { kind: "verify-candidate", message: "verified" } as unknown as WorkbenchDecisionResult;

function hostFixture(): {
	host: BuilderJobHost;
	setStatus: ReturnType<typeof vi.fn>;
	show: ReturnType<typeof vi.fn>;
	note: ReturnType<typeof vi.fn>;
	blocks: { title: string; tone: TranscriptTone; lines: string[] }[];
	statuses: (string | undefined)[];
} {
	const blocks: { title: string; tone: TranscriptTone; lines: string[] }[] = [];
	const statuses: (string | undefined)[] = [];
	const setStatus = vi.fn((key: string, text: string | undefined) => {
		expect(key).toBe(JOB_STATUS_KEY);
		statuses.push(text);
	});
	const show = vi.fn((block: { title: string; tone: TranscriptTone; lines: string[] }) => {
		blocks.push(block);
	});
	const note = vi.fn();
	return {
		host: { setStatus, show, note, waitForIdle: async () => undefined },
		setStatus,
		show,
		note,
		blocks,
		statuses,
	};
}

/** A decision that only finishes when the test says so. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Let the job's own continuation chain (present, idle wait, note) drain. */
const settle = async (): Promise<void> => {
	for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
};

describe("background measurements", () => {
	it("keeps a durable decision successful when its observational callbacks fail", async () => {
		const fixture = hostFixture();
		fixture.host.show = () => { throw new Error("panel closed"); };
		fixture.host.note = () => { throw new Error("host closed"); };
		const jobs = createBuilderJobs({ host: fixture.host });
		const pending = deferred<WorkbenchDecisionResult>();
		const started = await jobs.start({
			command: "test", label: () => "test",
			run: async ({ authorized }) => { authorized({ kind: "verify-candidate", estimate: null }); return pending.promise; },
			present: async () => { throw new Error("receipt cannot render"); },
		});
		expect(started.status).toBe("running");
		pending.resolve(result);
		await settle();
		expect(jobs.busy()).toBeNull();
	});

	it("keeps an unanswered authorization foreground beyond two seconds and cancels it through the initiating turn", async () => {
		vi.useFakeTimers();
		try {
			const fixture = hostFixture();
			const jobs = createBuilderJobs({ host: fixture.host });
			const controller = new AbortController();
			let returned = false;
			const operation = jobs.start({
				command: "test", label: () => "pending review", signal: controller.signal,
				run: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
				present: async () => "unreachable",
			}).finally(() => { returned = true; });
			const rejection = expect(operation).rejects.toThrow("changed direction");
			await vi.advanceTimersByTimeAsync(2_500);
			expect(returned).toBe(false);
			expect(jobs.active()).toMatchObject({ state: "awaiting-authorization", background: false });
			expect(jobs.busy()).not.toBeNull();
			expect(fixture.show).not.toHaveBeenCalled();
			controller.abort(new Error("changed direction"));
			await rejection;
			expect(jobs.active()).toBeNull();
		} finally { vi.useRealTimers(); }
	});

	it("clears completed work before waiting for idle and never clears a newer operation", async () => {
		const fixture = hostFixture();
		const idle = deferred<void>();
		fixture.host.waitForIdle = () => idle.promise;
		const jobs = createBuilderJobs({ host: fixture.host });
		const first = deferred<WorkbenchDecisionResult>();
		const second = deferred<WorkbenchDecisionResult>();
		const start = (name: string, pending: typeof first) => jobs.start({
			command: name, label: () => name,
			run: async ({ authorized }) => { authorized({ kind: "verify-candidate", estimate: null }); return pending.promise; },
			present: async () => "saved",
		});
		await start("first", first);
		first.resolve(result);
		await settle();
		expect(jobs.busy()).toBeNull();
		expect(fixture.note).not.toHaveBeenCalled();
		await start("second", second);
		idle.resolve();
		await settle();
		expect(jobs.active()).toMatchObject({ command: "second" });
		expect(fixture.note).toHaveBeenCalledTimes(1);
		second.resolve(result);
		await settle();
		expect(fixture.note).toHaveBeenCalledTimes(2);
	});

	it("keeps background work independent of later turn interrupts and aborts it on shutdown without late presentation", async () => {
		const fixture = hostFixture();
		const jobs = createBuilderJobs({ host: fixture.host });
		const pending = deferred<WorkbenchDecisionResult>();
		const turn = new AbortController();
		let jobSignal: AbortSignal | undefined;
		const present = vi.fn(async () => "saved");
		await jobs.start({
			command: "test", label: () => "test", signal: turn.signal,
			run: async ({ signal, authorized }) => { jobSignal = signal; authorized({ kind: "verify-candidate", estimate: null }); return pending.promise; },
			present,
		});
		turn.abort();
		expect(jobSignal?.aborted).toBe(false);
		jobs.dispose();
		expect(jobSignal?.aborted).toBe(true);
		pending.resolve(result);
		await settle();
		expect(present).not.toHaveBeenCalled();
		expect(fixture.note).not.toHaveBeenCalled();
		expect(fixture.blocks).toHaveLength(1);
		expect(jobs.active()).toBeNull();
	});

	it("hands the conversation back the moment a long measurement is authorized", async () => {
		const fixture = hostFixture();
		let clock = 0;
		const jobs = createBuilderJobs({
			host: fixture.host,
			now: () => clock,
			setInterval: () => ({}),
			clearInterval: () => undefined,
		});
		const pending = deferred<WorkbenchDecisionResult | null>();
		const present = vi.fn(async () => "candidate improved · +12 pts");

		const returned = jobs.start({
			command: "run",
			label: (kind) => kind === "verify-candidate" ? "candidate verification" : "the test run",
			run: async ({ onRunEvent, authorized }) => {
				authorized({
					kind: "verify-candidate",
					estimate: { executions: 372, sampledRuns: 40, costUsd: 1.2, minutes: 14 },
				});
				onRunEvent(graded(1));
				return pending.promise;
			},
			present,
		});
		// The command returns before the measurement does.
		await expect(returned).resolves.toMatchObject({ status: "running", job: { background: true, state: "running" } });

		expect(fixture.blocks[0]?.lines).toEqual([
			"Started in the background · candidate verification · ~372 Target executions · ~14 minutes",
		]);
		const active = jobs.active();
		expect(active).toMatchObject({ command: "run", label: "candidate verification", progress: "1/372", background: true });
		expect(fixture.statuses).toContain("candidate verification 1/372 · 0s");

		// A second consequential decision is refused with one sentence.
		expect(jobs.busy()).toBe("Wait — candidate verification is running (1/372)");

		clock = 372_000;
		pending.resolve(result);
		await settle();

		expect(present).toHaveBeenCalledWith(result, true);
		expect(fixture.blocks[1]).toMatchObject({
			tone: "success",
			lines: ["Background task finished · candidate verification · 6m12s · candidate improved · +12 pts"],
		});
		// The Builder is told, and told visibly, and only once the operator is idle.
		expect(fixture.note).toHaveBeenCalledWith(
			expect.stringContaining("The background run finished"),
			{ label: "Builder received: the background candidate verification (candidate improved · +12 pts)", triggerTurn: true },
		);
		expect(jobs.active()).toBeNull();
		expect(jobs.busy()).toBeNull();
		expect(fixture.statuses.at(-1)).toBeUndefined();
	});

	it("keeps a short measurement in front of the operator, panels and failures included", async () => {
		const fixture = hostFixture();
		const jobs = createBuilderJobs({ host: fixture.host, now: () => 0 });
		const present = vi.fn(async () => "18/24 passed");

		await jobs.start({
			command: "run",
			label: () => "the test run",
			run: async ({ authorized }) => {
				authorized({ kind: "run-eval", estimate: { executions: 24, sampledRuns: 40, costUsd: 0.19, minutes: 0.4 } });
				return result;
			},
			present,
		});

		// No “started in the background”, no completion line: it simply happened.
		expect(fixture.show).not.toHaveBeenCalled();
		expect(fixture.note).not.toHaveBeenCalled();
		expect(present).toHaveBeenCalledWith(result, false);
		expect(jobs.busy()).toBeNull();

		await expect(jobs.start({
			command: "run",
			label: () => "the test run",
			run: async ({ authorized }) => {
				authorized({ kind: "run-eval", estimate: { executions: 24, sampledRuns: 40, costUsd: 0.19, minutes: 0.4 } });
				throw new Error("provider refused");
			},
			present,
		})).rejects.toThrow("provider refused");
		expect(jobs.active()).toBeNull();
	});

	it("backgrounds a measurement nobody can price, and reports a failure there", async () => {
		const fixture = hostFixture();
		const jobs = createBuilderJobs({ host: fixture.host, now: () => 0, setInterval: () => ({}), clearInterval: () => undefined });
		const pending = deferred<WorkbenchDecisionResult | null>();

		await jobs.start({
			command: "run",
			label: () => "the test run",
			// Nothing comparable has run yet, so the estimate is unknown.
			run: async ({ authorized }) => {
				authorized({ kind: "run-eval", estimate: { executions: 24, sampledRuns: 0, costUsd: null, minutes: null } });
				return pending.promise;
			},
			present: async () => "unused",
		});
		expect(fixture.blocks[0]?.lines).toEqual(["Started in the background · the test run · ~24 Target executions"]);

		pending.reject(new Error("provider refused"));
		await settle();
		expect(fixture.blocks[1]).toMatchObject({
			tone: "error",
			lines: ["Background task failed · the test run · 0s · provider refused"],
		});
		expect(fixture.note).toHaveBeenCalledWith(
			expect.stringContaining("The background run failed: provider refused"),
			expect.objectContaining({ triggerTurn: true }),
		);
	});

	it("stops the running measurement through the signal the Workbench honours", async () => {
		const fixture = hostFixture();
		const jobs = createBuilderJobs({ host: fixture.host, now: () => 0, setInterval: () => ({}), clearInterval: () => undefined });
		let seen: AbortSignal | null = null;

		await jobs.start({
			command: "calibrate",
			label: () => "the noise measurement",
			run: async ({ signal, authorized }) => {
				seen = signal;
				authorized({ kind: "calibrate", estimate: { executions: 180, sampledRuns: 40, costUsd: 0.9, minutes: 9 } });
				return new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
			present: async () => "unused",
		});

		expect(jobs.stop()).toBe(true);
		await settle();
		expect((seen as unknown as AbortSignal).aborted).toBe(true);
		expect(fixture.blocks.at(-1)).toMatchObject({
			tone: "warning",
			lines: ["Background task stopped · the noise measurement · 0s"],
		});
		expect(fixture.note).toHaveBeenCalledWith(
			expect.stringContaining("stopped the background calibrate"),
			expect.objectContaining({ triggerTurn: true }),
		);
		// Nothing is running any more, so there is nothing left to stop.
		expect(jobs.stop()).toBe(false);
		expect(jobs.lines()).toEqual(["Nothing is running in the background"]);
	});

	it("refuses a second measurement while one is running", async () => {
		const fixture = hostFixture();
		const jobs = createBuilderJobs({ host: fixture.host, now: () => 0, setInterval: () => ({}), clearInterval: () => undefined });
		const pending = deferred<WorkbenchDecisionResult | null>();

		await jobs.start({
			command: "run",
			label: () => "candidate verification",
			run: async ({ onRunEvent, authorized }) => {
				authorized({ kind: "verify-candidate", estimate: { executions: 372, sampledRuns: 40, costUsd: 1.2, minutes: 14 } });
				onRunEvent(graded(1));
				onRunEvent(graded(2));
				return pending.promise;
			},
			present: async () => "unused",
		});

		expect(jobs.lines()).toEqual([
			"candidate verification 2/372 · 0s",
			"Say stop to cancel; completed changes and artifacts remain saved",
		]);
		await expect(jobs.start({
			command: "calibrate",
			label: () => "the noise measurement",
			run: async () => null,
			present: async () => "unused",
		})).rejects.toThrow("Wait — candidate verification is running (2/372)");

		pending.resolve(null);
		await settle();
		expect(jobs.busy()).toBeNull();
	});

	it("runs /run in the background, refuses a second decision, and lands the receipt", async () => {
		const pending = deferred<WorkbenchDecisionResult>();
		const decided: string[] = [];
		const workbench = {
			runsRoot: "/tmp/runs",
			stateRoot: "/tmp/state",
			projectId: "demo",
			projectDir: "/tmp/demo",
			view: async () => commandView,
			decide: async (
				input: { kind: string; reason: string },
				gate: {
					confirm(confirmation: Record<string, unknown>): Promise<{ approved: boolean; actorId?: string }>;
				},
			) => {
				decided.push(input.kind);
				const approval = await gate.confirm({
					kind: "verify-candidate",
					title: "Verify exact applied candidate",
					reason: input.reason,
					subject: {},
					subjectHash: `sha256:${"a".repeat(64)}`,
					policy: "routine",
					question: "Verify?",
					estimate: { executions: 372, sampledRuns: 40, costUsd: 1.2, minutes: 14 },
				});
				expect(approval.approved).toBe(true);
				return input.kind === "run-current" ? pending.promise : runEvalResult;
			},
		};
		const registered = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const notify = vi.fn();
		const blocks: { title: string; lines: string[] }[] = [];
		const notes: { text: string; label?: string }[] = [];
		registerAhdeBuilderCommands(
			{ registerCommand: (name: string, spec: never) => registered.set(name, spec) } as never,
			{
				workbench: workbench as never,
				actorId: () => "local:test-operator",
				presenter: {
					show: (_ctx, block) => blocks.push({ title: block.title, lines: block.lines.map(stripMarkers) }),
					note: (text, note) => notes.push({ text, ...(note?.label ? { label: note.label } : {}) }),
				},
				spend: {
					ofEvalRun: () => ({
						evalRunId: "erun-1",
						runs: 24,
						costUsd: 0.19,
						judgeCostUsd: 0.03,
						startedAt: "2026-08-28T14:10:00.000Z",
						finishedAt: "2026-08-28T14:14:12.000Z",
					}),
					ofCandidate: () => [],
					cycle: () => null,
					branchOf: () => null,
				},
			},
		);
		const ctx = {
			hasUI: true,
			mode: "tui",
			signal: undefined,
			waitForIdle: async () => undefined,
			ui: { notify, setStatus: vi.fn(), setWidget: vi.fn(), confirm: async () => true },
		};

		await registered.get("run")!.handler("", ctx);
		expect(blocks[0]?.lines).toEqual([
			"Started in the background · candidate verification · ~372 Target executions · ~14 minutes",
		]);

		// A second consequential decision is refused with one sentence, and never reaches the Workbench.
		await registered.get("approve")!.handler("", ctx);
		// The denominator is the whole job the gate priced, before a single run is graded.
		expect(notify).toHaveBeenCalledWith("Wait — candidate verification is running (0/372)", "warning");
		expect(decided).toEqual(["run-current"]);
		await registered.get("jobs")!.handler("", ctx);
		expect(blocks.at(-1)?.lines[0]).toContain("candidate verification");

		pending.resolve(runEvalResult);
		await settle();
		const panel = blocks.find((block) => block.title === "Run complete");
		expect(panel?.lines.at(-1)).toContain("24 Target executions · $0.19 · 4m12s · judge $0.03");
		expect(blocks.at(-1)?.lines[0]).toContain("Background task finished · candidate verification");
		expect(notes.at(-1)?.label).toContain("Builder received: the background candidate verification");
	});

	it("prices a start panel only from what the gate actually knew", () => {
		expect(estimateLine(null)).toBe("");
		expect(estimateLine({ executions: 0, sampledRuns: 0, costUsd: null, minutes: null })).toBe("");
		expect(estimateLine({ executions: 372, sampledRuns: 12, costUsd: 1.2, minutes: 0.2 }))
			.toBe("~372 Target executions · ~1 minute");
	});
});
