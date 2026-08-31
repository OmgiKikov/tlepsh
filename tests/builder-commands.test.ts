import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	AHDE_BUILDER_COMMAND_NAMES,
	humanizeCommandError,
	registerAhdeBuilderCommands,
	type RegisterBuilderCommandsOptions,
} from "../src/builder/commands.js";
import { createRunProgressPresenter } from "../src/builder/run-progress.js";
import {
	AHDE_MODEL_NOTE_TYPE,
	AHDE_TRANSCRIPT_ENTRY_TYPE,
	stripMarkers,
	type TranscriptPresenter,
	type TranscriptTone,
} from "../src/builder/transcript.js";
import type { RunEvent, RunEventIdentity } from "../src/run-events.js";
import {
	WorkbenchDecisionDeclinedError,
	WorkbenchSelectionRequiredError,
	WorkbenchStaleDecisionError,
} from "../src/workbench/errors.js";
import { workbenchGateClass } from "../src/workbench/transition-policy.js";
import type {
	WorkbenchCalibrationProjection,
	WorkbenchCandidateSummary,
	WorkbenchConfirmation,
	WorkbenchDecisionExecutionOptions,
	WorkbenchDecisionInput,
	WorkbenchDecisionResult,
	WorkbenchDecisionResultMap,
	WorkbenchHumanApproval,
	WorkbenchHumanGate,
	WorkbenchReviewDetail,
	WorkbenchSealedChoice,
	WorkbenchStage,
	WorkbenchTracesDetail,
	WorkbenchView,
} from "../src/workbench/types.js";

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;
type RegisterOptions = RegisterBuilderCommandsOptions;
type CommandWorkbench = RegisterOptions["workbench"];
/** One plain signature so fakes are contextually typed regardless of the class's overloads. */
type DecideFake = (
	input: WorkbenchDecisionInput,
	gate: WorkbenchHumanGate,
	execution?: WorkbenchDecisionExecutionOptions,
) => Promise<WorkbenchDecisionResult>;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const hash = (char: string): string => `sha256:${char.repeat(64)}`;
const FIRST_MODE = `failure-mode-${"1".repeat(24)}`;
const SECOND_MODE = `failure-mode-${"2".repeat(24)}`;
const LIVE_URL = `http://127.0.0.1:43123/live/${"a".repeat(32)}`;
const EVIDENCE_URL = "http://127.0.0.1:43123/evidence/erun-current";
/** Private-use paint markers must never leak into plain notifications. */
const MARKERS = /[]/;
const TARGET_MODEL = {
	provider: "anthropic",
	id: "claude-sonnet-4",
	apiKeyEnv: "ANTHROPIC_API_KEY",
	credentialPresent: true,
} as const;

const baseView: WorkbenchView = {
	schemaVersion: 1,
	project: { id: "demo", directory: "/tmp/ahde-demo" },
	stage: "ready-to-evaluate",
	headline: "Development corpus is ready.",
	target: { status: "ready", id: "target-demo", gitSha: SHA_A, model: { ...TARGET_MODEL } },
	focus: {},
	selections: [],
	actions: ["run development eval"],
	blockers: [],
	warnings: [],
	calibration: null,
	counts: {
		specDrafts: 1,
		approvedSpecs: 1,
		corpusDrafts: 1,
		developmentCorpora: 1,
		sealedCorpora: 1,
		developmentEvals: 0,
		openProposals: 0,
		candidates: 0,
		calibrations: 0,
	},
};

function viewAt(stage: WorkbenchStage, overrides: Partial<WorkbenchView> = {}): WorkbenchView {
	return { ...baseView, stage, ...overrides };
}

function candidateSummary(overrides: Partial<WorkbenchCandidateSummary> = {}): WorkbenchCandidateSummary {
	return {
		candidateId: "cand-1",
		status: "evaluated",
		projectId: "demo",
		targetId: "target-demo",
		specId: "spec-1",
		proposalId: "builder-proposal-1",
		baseline: { ref: "main", sha: SHA_A },
		candidate: { ref: "candidate/routing", sha: SHA_B },
		development: {
			baselineEvalRunId: "erun-baseline",
			candidateEvalRunId: "erun-candidate",
			comparison: {
				taskCount: 3,
				baselinePassRate: 1 / 3,
				candidatePassRate: 1,
				delta: 2 / 3,
				confidence95: { low: 0.1, high: 0.9 },
				improved: 2,
				regressed: 0,
				unchanged: 1,
			},
			gate: null,
		},
		sealedHoldout: { executed: true, gatePassed: true, gate: null },
		review: null,
		promotion: null,
		rejection: null,
		...overrides,
	};
}

function tracesDetail(): WorkbenchTracesDetail {
	return {
		evaluation: {
			evalRunId: "erun-current",
			summary: { total: 3, pass: 1, fail: 2, error: 0, allPassRate: 1 / 3 },
			repetitions: 1,
		},
		diagnosis: {
			diagnosisId: "diagnosis-current",
			evalRunId: "erun-current",
			status: "actionable",
			summary: { tasks: 3, healthyTasks: 1, failedTasks: 2, infrastructureErrors: 0, issueCount: 2 },
			issues: [{
				issueId: "task-routing:tool-selection",
				category: "tool-selection",
				severity: "major",
				confidence: "high",
				summary: "task-routing: 0/1 passed; 1 failed and 0 ended with infrastructure errors.",
				rootCause: "The agent did not select the required tool under the task wording.",
				suggestions: ["Add a short tool-selection rule to AGENTS.md."],
			}],
			omittedIssues: 0,
		},
		improvementBrief: {
			schemaVersion: 1,
			algorithmId: "exact-eval-signals-v1",
			briefId: `brief-${"a".repeat(24)}`,
			evalRunId: "erun-current",
			diagnosisId: "diagnosis-current",
			status: "actionable",
			proposalEligible: true,
			headline: "1/3 passed. Two exact failure modes found.",
			summary: {
				tasks: 3,
				failedTasks: 2,
				infrastructureErrors: 0,
				failureModeCount: 2,
				systemicFailureModeCount: 1,
				taskLocalFailureModeCount: 1,
				omittedFailureModeCount: 0,
			},
			modes: [
				{
					ordinal: 1,
					failureModeId: FIRST_MODE,
					category: "tool-selection",
					scope: "systemic",
					severity: "major",
					evidenceStrength: "high",
					decision: "propose-harness-change",
					selectableForProposal: true,
					title: "Missing evidence lookup instruction",
					summary: "Two tasks answered without calling the lookup tool.",
					hypothesis: "AGENTS.md never says when the lookup tool is mandatory.",
					suggestions: ["Add a tool-selection rule to AGENTS.md."],
					impact: {
						affectedTasks: 2,
						totalTasks: 3,
						taskCoverageBps: 6_666,
						failedOccurrences: 2,
						passedOccurrences: 0,
						reproductionBps: 10_000,
					},
					taskIds: ["task-routing", "task-lookup"],
					evidence: [{ runId: "run-development-1", taskId: "task-routing", traceAvailable: true, graderNames: ["tool_called"] }],
					omittedEvidenceCount: 0,
				},
				{
					ordinal: 2,
					failureModeId: SECOND_MODE,
					category: "flaky-behavior",
					scope: "task-local",
					severity: "minor",
					evidenceStrength: "low",
					decision: "stabilize-and-rerun",
					selectableForProposal: false,
					title: "Unstable output",
					summary: "One task alternates between pass and fail.",
					hypothesis: "The answer format is underspecified.",
					suggestions: ["Run A/A calibration before claiming an improvement."],
					impact: {
						affectedTasks: 1,
						totalTasks: 3,
						taskCoverageBps: 3_333,
						failedOccurrences: 1,
						passedOccurrences: 1,
						reproductionBps: 5_000,
					},
					taskIds: ["task-format"],
					evidence: [{ runId: "run-development-3", taskId: "task-format", traceAvailable: true, graderNames: ["output_contains"] }],
					omittedEvidenceCount: 0,
				},
			],
			conversationProjection: { shownModes: 2, addressableModes: 1, omittedModes: 0, fullEvidence: EVIDENCE_URL },
		},
		evidence: { available: true, url: EVIDENCE_URL },
	};
}

function calibration(overrides: Partial<WorkbenchCalibrationProjection> = {}): WorkbenchCalibrationProjection {
	return {
		candidateId: "calibration-1",
		targetSha: SHA_A,
		taskCount: 30,
		repetitions: 3,
		aaPassRate: 0.7,
		delta: 0,
		confidence95: { low: -0.06, high: 0.06 },
		flipRate: 0.1,
		recommendedRepetitions: 3,
		verdict: "inconclusive",
		at: "2026-08-28T10:05:00.000Z",
		...overrides,
	};
}

function proposalReview(): Extract<WorkbenchReviewDetail, { kind: "proposal" }> {
	return {
		kind: "proposal",
		runId: "builder-proposal-1",
		proposalHash: hash("e"),
		baseTargetSha: SHA_A,
		summary: "Route lookups through the evidence tool before answering.",
		paths: ["AGENTS.md"],
		risks: ["Longer answers on trivial questions"],
		validationPlan: ["Re-run the development basket"],
		authoringContext: null,
		evidenceBasis: {
			algorithmId: "exact-eval-signals-v1",
			evalRunId: "erun-current",
			diagnosisId: "diagnosis-current",
			briefId: `brief-${"a".repeat(24)}`,
			briefSha256: hash("9"),
			failureModes: [{ failureModeId: FIRST_MODE, modeSha256: hash("8") }],
			runRefs: ["run-development-1"],
		},
		exactDiff: [
			"diff --git a/AGENTS.md b/AGENTS.md",
			"--- a/AGENTS.md",
			"+++ b/AGENTS.md",
			"@@ -1,2 +1,3 @@",
			" # Test Agent",
			"+Always call the lookup tool before answering.",
			"",
		].join("\n"),
	};
}

const interruptedDetail: WorkbenchReviewDetail = {
	kind: "interrupted-candidate",
	...candidateSummary({
		candidateId: "candidate-stopped",
		status: "validated",
		development: null,
		sealedHoldout: { executed: false, gatePassed: false, gate: null },
	}),
};
const interruptedView = viewAt("candidate-verification", { detail: { aspect: "review", content: interruptedDetail } });

function decision<K extends WorkbenchDecisionInput["kind"]>(
	kind: K,
	result: WorkbenchDecisionResultMap[K],
	view: WorkbenchView,
): WorkbenchDecisionResult {
	return { kind, message: `${kind} completed`, result, view } as unknown as WorkbenchDecisionResult;
}

/** Type-correct receipt for every decision a slash command can issue. */
function defaultDecision(input: WorkbenchDecisionInput): WorkbenchDecisionResult {
	const at = "2026-08-28T10:05:00.000Z";
	switch (input.kind) {
		case "run-current":
			return decision("run-current", { resolvedAs: "run-eval", ...tracesDetail() }, viewAt("improvement-authoring"));
		case "calibrate":
			return decision("calibrate", {
				candidateId: "calibration-1",
				calibration: calibration({ repetitions: input.repetitions }),
			}, viewAt("ready-to-evaluate", { calibration: calibration({ repetitions: input.repetitions }) }));
		case "approve-spec":
			return decision("approve-spec", { approvedSpecId: "spec-1", receiptId: "receipt-approve" }, viewAt("corpus-design"));
		case "publish-corpus":
			return decision("publish-corpus", {
				corpusId: "corpus-1",
				corpusHash: hash("c"),
				taskCount: 3,
				publicationReceiptId: "receipt-publish",
				lineageHash: hash("d"),
			}, viewAt("ready-to-evaluate"));
		case "apply-proposal":
			return decision("apply-proposal", {
				runId: input.runId ?? "builder-proposal-1",
				branch: input.branch,
				candidateSha: SHA_B,
				proposalHash: hash("e"),
			}, viewAt("candidate-verification"));
		case "discard-proposal":
			return decision("discard-proposal", { runId: input.runId ?? "builder-proposal-1", receiptHash: hash("f") }, viewAt("improvement-authoring"));
		case "abandon-candidate":
			return decision("abandon-candidate", {
				candidateId: input.candidateId ?? "cand-1",
				interruptedStatus: "validated",
				receiptHash: hash("0"),
			}, viewAt("candidate-verification"));
		case "review-candidate":
			return decision("review-candidate", candidateSummary({
				status: "reviewed",
				review: { experimentId: "exp-1", recommendation: input.recommendation, reason: input.reason },
			}), viewAt("release-decision"));
		case "promote-candidate":
			return decision("promote-candidate", {
				candidate: candidateSummary({ status: "promoted", promotion: { tag: `v${input.version}`, reason: input.reason, at } }),
				tag: `v${input.version}`,
				candidateSha: SHA_B,
				guards: { draftId: null, cases: 0, taskIds: [], warning: null },
			}, viewAt("candidate-adoption"));
		case "reject-candidate":
			return decision("reject-candidate", candidateSummary({ status: "rejected", rejection: { reason: input.reason, at } }), viewAt("complete"));
		case "adopt-candidate":
			return decision("adopt-candidate", {
				candidate: candidateSummary({ status: "promoted" }),
				disposition: "adopted",
				branch: "main",
				fromSha: SHA_A,
				toSha: SHA_B,
				tag: "v1.2.0",
				receiptId: "receipt-adopt",
			}, viewAt("complete"));
		case "continue-cycle":
			return decision("continue-cycle", {
				candidate: candidateSummary({ status: "promoted" }),
				disposition: "recorded",
				activeTargetSha: SHA_B,
				receiptId: "receipt-next",
				nextStage: "ready-to-evaluate",
			}, viewAt("ready-to-evaluate"));
		case "ship":
			return decision("ship", {
				steps: [
					{ kind: "review-candidate", message: "Human candidate review recorded." },
					{ kind: "promote-candidate", message: `Candidate promoted as v${input.version}.` },
					{ kind: "adopt-candidate", message: "Branch main now points at the promoted candidate." },
					{ kind: "continue-cycle", message: "Improvement cycle closed." },
				],
				candidate: candidateSummary({ status: "promoted", promotion: { tag: `v${input.version}`, reason: input.reason, at } }),
				tag: `v${input.version}`,
				adoption: { branch: "main", fromSha: SHA_A, toSha: SHA_B },
				continuation: { receiptId: "receipt-next", nextStage: "ready-to-evaluate" },
				guards: { draftId: null, cases: 0, taskIds: [], warning: null },
			}, viewAt("ready-to-evaluate"));
		case "start-testing":
			return decision("start-testing", {
				steps: [
					{ kind: "publish-corpus", message: "Development corpus published." },
					{ kind: "run-eval", message: "3 of 3 cases passed." },
				],
				approvedSpecId: "spec-1",
				developmentCorpus: { id: "corpus-1", taskCount: 3 },
				evaluation: tracesDetail(),
				pending: null,
			}, viewAt("improvement-authoring"));
		default:
			throw new Error(`slash commands never issue ${input.kind}`);
	}
}

function presenterFixture(): {
	presenter: TranscriptPresenter;
	show: ReturnType<typeof vi.fn>;
	note: ReturnType<typeof vi.fn>;
	blocks: Array<{ title: string; tone: TranscriptTone; lines: string[] }>;
	/** Every rendered line with paint markers removed. */
	text(): string;
} {
	const blocks: Array<{ title: string; tone: TranscriptTone; lines: string[] }> = [];
	const show = vi.fn((_ctx: unknown, block: { title: string; tone?: TranscriptTone; lines: string[] }) => {
		blocks.push({ title: block.title, tone: block.tone ?? "info", lines: block.lines });
	});
	const note = vi.fn((_text: string) => undefined);
	return {
		presenter: { show, note },
		show,
		note,
		blocks,
		text: () => blocks.flatMap((block) => block.lines).map(stripMarkers).join("\n"),
	};
}

function register(
	workbench: CommandWorkbench,
	options: {
		actorId?: () => string;
		beginLiveTrace?: RegisterOptions["beginLiveTrace"];
		/** `null` omits the presenter so the command layer builds one from `pi`. */
		presenter?: TranscriptPresenter | null;
		sendUserMessage?: (text: string) => void;
		/** Extra host capabilities (appendEntry, sendMessage) for the presenter fallback tests. */
		pi?: Record<string, unknown>;
	} = {},
): {
	registered: Array<{ name: string; options: CommandOptions }>;
	commands: Map<string, CommandOptions>;
	actorId: ReturnType<typeof vi.fn<() => string>>;
	onWorkbenchChanged: ReturnType<typeof vi.fn>;
	output: ReturnType<typeof presenterFixture>;
} {
	const registered: Array<{ name: string; options: CommandOptions }> = [];
	const actorId = vi.fn(options.actorId ?? (() => "local:test-operator"));
	const onWorkbenchChanged = vi.fn(async () => undefined);
	const output = presenterFixture();
	const pi = {
		registerCommand(name: string, commandOptions: CommandOptions) {
			registered.push({ name, options: commandOptions });
		},
		...options.pi,
	} as unknown as ExtensionAPI;
	registerAhdeBuilderCommands(pi, {
		workbench,
		actorId,
		onWorkbenchChanged,
		...(options.presenter === null ? {} : { presenter: options.presenter ?? output.presenter }),
		...(options.beginLiveTrace ? { beginLiveTrace: options.beginLiveTrace } : {}),
		...(options.sendUserMessage ? { sendUserMessage: options.sendUserMessage } : {}),
	});
	return {
		registered,
		commands: new Map(registered.map(({ name, options: commandOptions }) => [name, commandOptions])),
		actorId,
		onWorkbenchChanged,
		output,
	};
}

type DialogOptions = { signal?: AbortSignal };

function context(options: {
	hasUI?: boolean;
	mode?: "tui" | "rpc" | "json" | "print";
	signal?: AbortSignal;
	waitForIdle?: () => Promise<void>;
	confirm?: (title: string, message: string, options?: DialogOptions) => Promise<boolean>;
	select?: (title: string, choices: string[], options?: DialogOptions) => Promise<string | undefined>;
	input?: (title: string, placeholder?: string, options?: DialogOptions) => Promise<string | undefined>;
	/** Hosts without a selector expose no `select` at all; optional pickers must then be skipped. */
	withoutSelect?: boolean;
	/** `null` means no Builder model is selected. */
	model?: { provider: string; id: string } | null;
	hasConfiguredAuth?: boolean;
} = {}): {
	ctx: ExtensionCommandContext;
	waitForIdle: ReturnType<typeof vi.fn<() => Promise<void>>>;
	confirm: ReturnType<typeof vi.fn>;
	select: ReturnType<typeof vi.fn>;
	input: ReturnType<typeof vi.fn>;
	notify: ReturnType<typeof vi.fn>;
	setStatus: ReturnType<typeof vi.fn>;
	setWidget: ReturnType<typeof vi.fn>;
	hasConfiguredAuth: ReturnType<typeof vi.fn>;
} {
	const waitForIdle = vi.fn(options.waitForIdle ?? (async () => undefined));
	const confirm = vi.fn(options.confirm ?? (async () => false));
	const select = vi.fn(options.select ?? (async () => undefined));
	const input = vi.fn(options.input ?? (async () => undefined));
	const notify = vi.fn();
	const setStatus = vi.fn();
	const setWidget = vi.fn();
	const hasConfiguredAuth = vi.fn(() => options.hasConfiguredAuth ?? true);
	const model = options.model === null ? undefined : options.model ?? { provider: "anthropic", id: "claude-sonnet-4" };
	return {
		ctx: {
			hasUI: options.hasUI ?? true,
			mode: options.mode ?? "tui",
			signal: options.signal,
			waitForIdle,
			model,
			modelRegistry: { hasConfiguredAuth },
			ui: { confirm, notify, setStatus, setWidget, input, ...(options.withoutSelect ? {} : { select }) },
		} as unknown as ExtensionCommandContext,
		waitForIdle,
		confirm,
		select,
		input,
		notify,
		setStatus,
		setWidget,
		hasConfiguredAuth,
	};
}

const runIdentity: RunEventIdentity = {
	evalRunId: "eval-development",
	runId: "run-development-1",
	taskId: "task-routing",
	repetitionIndex: 0,
	ordinal: 1,
	total: 1,
};

type RunEventInput<Event> = Event extends RunEvent
	? Omit<Event, "at" | "run">
	: never;

function runEvent(event: RunEventInput<RunEvent>, run: Partial<RunEventIdentity> = {}): RunEvent {
	return {
		...event,
		at: "2026-08-28T10:00:00.000Z",
		run: { ...runIdentity, ...run },
	} as RunEvent;
}

function workbench(options: {
	view?: (query: Parameters<CommandWorkbench["view"]>[0]) => Promise<WorkbenchView>;
	decide?: DecideFake;
} = {}): {
	value: CommandWorkbench;
	view: ReturnType<typeof vi.fn>;
	decide: ReturnType<typeof vi.fn>;
} {
	const view = vi.fn(options.view ?? (async () => baseView));
	const decide = vi.fn(options.decide ?? (async (input: WorkbenchDecisionInput) => defaultDecision(input)));
	return { value: { view, decide } as unknown as CommandWorkbench, view, decide };
}

/**
 * Workbench whose every decision asks the gate to confirm a candidate-scoped
 * subject, exactly like the real review/promotion/rejection receipts.
 */
function gatedWorkbench(
	stage: WorkbenchStage,
	options: { candidateIdFor?: (input: WorkbenchDecisionInput) => string } = {},
): ReturnType<typeof workbench> {
	return workbench({
		view: async () => viewAt(stage),
		decide: async (input, gate, execution) => {
			const approval = await gate.confirm({
				kind: input.kind,
				title: `Confirm ${input.kind}`,
				reason: input.reason,
				subject: { candidate: { candidateId: options.candidateIdFor?.(input) ?? "cand-1" } },
				subjectHash: hash("b"),
				policy: workbenchGateClass(input.kind),
				question: `Confirm ${input.kind}?`,
			}, execution?.signal);
			if (!approval.approved) throw new WorkbenchDecisionDeclinedError(input.kind);
			return defaultDecision(input);
		},
	});
}

function command(
	commands: Map<string, CommandOptions>,
	name: string,
): CommandOptions {
	const found = commands.get(name);
	if (!found) throw new Error(`missing /${name}`);
	return found;
}

describe("Builder Pi slash commands", () => {
	it("registers the AHDE help, readiness, and workflow commands in stable public order", () => {
		const fixture = workbench();
		const registered = register(fixture.value).registered;

		expect([...AHDE_BUILDER_COMMAND_NAMES]).toEqual([
			// The three verbs the operator actually says, then the shortcuts.
			"test",
			"fix",
			"ship",
			"help",
			"doctor",
			"status",
			"run",
			"calibrate",
			"traces",
			"review",
			"approve",
			"publish",
			"apply",
			"discard",
			"promote",
			"reject",
			"adopt",
			"next",
			"target",
		]);
		expect(registered.map(({ name }) => name)).toEqual([...AHDE_BUILDER_COMMAND_NAMES]);
		expect(registered).toHaveLength(19);
		expect(registered.every(({ options }) => options.description && options.handler)).toBe(true);
	});

	it("maps read-only commands to their exact Workbench view aspects and renders humans, not JSON", async () => {
		const fixture = workbench({
			view: async (query) => query?.aspect === "target"
				? viewAt("target-setup", {
					target: { status: "missing", id: null, gitSha: null, model: null },
					detail: { aspect: "target", content: { launch: "ahde init ." } },
				})
				: baseView,
		});
		const { commands, output } = register(fixture.value);
		const host = context();

		for (const name of ["status", "traces", "review", "target"] as const) {
			await command(commands, name).handler("", host.ctx);
		}
		await command(commands, "target").handler("AGENTS.md", host.ctx);

		expect(fixture.view.mock.calls.map(([query]) => query)).toEqual([
			{ aspect: "summary" },
			{ aspect: "traces" },
			{ aspect: "review" },
			{ aspect: "target" },
			{ aspect: "target", resourcePath: "AGENTS.md" },
		]);
		expect(host.waitForIdle).toHaveBeenCalledTimes(5);
		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([
			["AHDE · Ready to run", "info"],
			["AHDE · Ready to run", "warning"],
			["AHDE · Ready to run", "info"],
			["AHDE · Target", "info"],
			["AHDE · AGENTS.md", "info"],
		]);
		const text = output.text();
		expect(text).toContain("AHDE · Ready to run");
		expect(text).toContain("Target target-demo @ aaaaaaaaaa · anthropic/claude-sonnet-4 ✓");
		expect(text).toContain("Next Say “tests” to run them");
		expect(text).toContain("Target not created yet");
		expect(text).toContain("ahde init .");
		expect(text).not.toContain("schemaVersion");
		expect(text).not.toContain("{");
		expect(host.notify).not.toHaveBeenCalled();
		expect(host.select).not.toHaveBeenCalled();
		expect(fixture.decide).not.toHaveBeenCalled();

		await expect(command(commands, "target").handler("two paths", host.ctx))
			.rejects.toThrow("/target accepts at most one");
		expect(fixture.view).toHaveBeenCalledTimes(5);
	});

	it("shows the workflow reference for /help", async () => {
		const fixture = workbench();
		const { commands, output } = register(fixture.value);

		await command(commands, "help").handler("", context().ctx);

		expect(fixture.view).not.toHaveBeenCalled();
		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([["AHDE Builder help", "info"]]);
		const text = output.text();
		expect(text).toContain("Talk normally");
		expect(text).toContain("/promote <version>");
		// The three verbs come first, and the gate policy is stated in the operator's words.
		expect(text.indexOf("/test")).toBeGreaterThan(-1);
		expect(text.indexOf("/test")).toBeLessThan(text.indexOf("/status"));
		expect(text.indexOf("/fix")).toBeLessThan(text.indexOf("/status"));
		expect(text.indexOf("/ship")).toBeLessThan(text.indexOf("/status"));
		expect(text).toContain("Every consequential step shows the exact subject and asks you once: starting");
		expect(text).toContain("Runs and checks just happen");
	});

	it("routes /run to run-current and parses repetitions plus a human-readable reason", async () => {
		const fixture = workbench();
		const { commands, output } = register(fixture.value);
		const controller = new AbortController();
		const host = context({ signal: controller.signal });

		await command(commands, "run").handler("3 investigate routing", host.ctx);
		await command(commands, "run").handler("", host.ctx);

		expect(fixture.decide).toHaveBeenNthCalledWith(
			1,
			{ kind: "run-current", repetitions: 3, reason: "investigate routing" },
			expect.objectContaining({ confirm: expect.any(Function), selectSealed: expect.any(Function) }),
			{ signal: controller.signal, onRunEvent: expect.any(Function) },
		);
		expect(fixture.decide).toHaveBeenNthCalledWith(
			2,
			{ kind: "run-current", repetitions: 3, reason: "Requested interactively via /run" },
			expect.any(Object),
			{ signal: controller.signal, onRunEvent: expect.any(Function) },
		);
		expect(output.blocks.map((block) => block.title)).toEqual(["Run complete", "Run complete"]);

		await expect(command(commands, "run").handler("11 too many", host.ctx))
			.rejects.toThrow("/run repetitions must be an integer between 1 and 10");
		expect(fixture.decide).toHaveBeenCalledTimes(2);
	});

	it("routes /test to the same decision as /run, so “test it” works wherever the operator stands", async () => {
		const fixture = workbench();
		const { commands, output } = register(fixture.value);
		const host = context();

		await command(commands, "test").handler("2 check the routing fix", host.ctx);

		expect(fixture.decide).toHaveBeenCalledWith(
			{ kind: "run-current", repetitions: 2, reason: "check the routing fix" },
			expect.objectContaining({ confirm: expect.any(Function) }),
			{ signal: undefined, onRunEvent: expect.any(Function) },
		);
		expect(output.blocks.map((block) => block.title)).toEqual(["Run complete"]);

		// A pending review is not an error: the Workbench answers with the
		// composite, and the command renders what it did.
		const pending = workbench({
			view: async () => viewAt("corpus-review"),
			decide: async () => decision("run-current", {
				resolvedAs: "start-testing",
				steps: [
					{ kind: "publish-corpus", message: "Development corpus published." },
					{ kind: "run-eval", message: "2 of 3 cases passed." },
				],
				approvedSpecId: "spec-1",
				developmentCorpus: { id: "corpus-1", taskCount: 3 },
				evaluation: tracesDetail(),
				pending: null,
			}, viewAt("improvement-authoring")),
		});
		const composite = register(pending.value);
		await command(composite.commands, "test").handler("", context().ctx);
		expect(composite.output.blocks.map((block) => block.title)).toEqual(["Run complete"]);
		expect(composite.output.text()).toContain("Tests published 3 cases");
	});

	it("routes /ship to the one composite decision and asks for the version once", async () => {
		const fixture = gatedWorkbench("candidate-review");
		const { commands, output } = register(fixture.value);
		const host = context({ input: async () => "2.1.0", confirm: async () => true });

		await command(commands, "ship").handler("", host.ctx);
		expect(host.input).toHaveBeenCalledWith("Version to tag (semver, e.g. 0.2.0)", "0.1.0");
		expect(fixture.decide.mock.calls.map(([input]) => input)).toEqual([
			{ kind: "ship", version: "2.1.0", reason: "Requested interactively via /ship" },
		]);
		expect(host.confirm).toHaveBeenCalledTimes(1);
		expect(output.blocks.map((block) => block.title)).toEqual(["Shipped"]);

		// An explicit version skips the prompt; a bad one never reaches a decision.
		const explicit = gatedWorkbench("release-decision");
		const second = register(explicit.value);
		const explicitHost = context({ confirm: async () => true });
		await command(second.commands, "ship").handler("2.2.0 ship the reviewed fix", explicitHost.ctx);
		expect(explicitHost.input).not.toHaveBeenCalled();
		expect(explicit.decide.mock.calls.map(([input]) => input)).toEqual([
			{ kind: "ship", version: "2.2.0", reason: "ship the reviewed fix" },
		]);
		await expect(command(second.commands, "ship").handler("v2", explicitHost.ctx))
			.rejects.toThrow("version must be semver like 0.2.0");

		// Nothing to ship yet: the command says where the operator actually is.
		const early = workbench({ view: async () => viewAt("improvement-authoring") });
		const third = register(early.value);
		await expect(command(third.commands, "ship").handler("", context().ctx))
			.rejects.toThrow(/\/ship is not available during Diagnosis/);
		expect(early.decide).not.toHaveBeenCalled();
	});

	it("routes /fix to the model with the exact failure mode it resolved from a fresh brief", async () => {
		const fixture = workbench({
			view: async (query) => query?.aspect === "traces"
				? viewAt("improvement-authoring", { detail: { aspect: "traces", content: tracesDetail() } })
				: baseView,
		});
		const sendUserMessage = vi.fn();
		const { commands, output } = register(fixture.value, { sendUserMessage });
		const host = context();

		await command(commands, "fix").handler("", host.ctx);
		expect(fixture.view).toHaveBeenCalledWith({ aspect: "traces" });
		expect(output.blocks.map((block) => block.title)).toEqual(["AHDE · Diagnosis"]);
		expect(sendUserMessage).toHaveBeenCalledWith(
			"Fix problem 1 (failure-mode-111111111111111111111111): Missing evidence lookup instruction. " +
			"Prepare the proposal and show me the review.",
		);

		// An out-of-range ordinal is refused instead of guessed.
		await expect(command(commands, "fix").handler("7", host.ctx))
			.rejects.toThrow(/there is no problem 7 to fix/);
		expect(sendUserMessage).toHaveBeenCalledTimes(1);

		// Nothing measured yet: /fix explains where to start rather than failing.
		const early = workbench();
		const second = register(early.value, { sendUserMessage });
		const earlyHost = context();
		await command(second.commands, "fix").handler("", earlyHost.ctx);
		expect(earlyHost.notify).toHaveBeenCalledWith(expect.stringContaining("Nothing to fix yet"), "info");
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
	});

	it("/run defaults to 3 repetitions so one sample is never mistaken for evidence", async () => {
		const fixture = workbench();
		const { commands } = register(fixture.value);
		const host = context();

		await command(commands, "run").handler("", host.ctx);
		await command(commands, "run").handler("recheck the routing fix", host.ctx);

		for (const call of [1, 2] as const) {
			expect(fixture.decide).toHaveBeenNthCalledWith(
				call,
				expect.objectContaining({ kind: "run-current", repetitions: 3 }),
				expect.any(Object),
				expect.any(Object),
			);
		}
	});

	it("/calibrate runs the calibrate decision and renders the noise, not JSON", async () => {
		const fixture = workbench();
		const { commands, output } = register(fixture.value);
		const host = context();

		await command(commands, "calibrate").handler("", host.ctx);
		await command(commands, "calibrate").handler("5 before trusting small deltas", host.ctx);

		expect(fixture.decide).toHaveBeenNthCalledWith(
			1,
			{ kind: "calibrate", repetitions: 3, reason: "Requested interactively via /calibrate" },
			expect.objectContaining({ confirm: expect.any(Function), selectSealed: expect.any(Function) }),
			{ signal: undefined, onRunEvent: expect.any(Function) },
		);
		expect(fixture.decide).toHaveBeenNthCalledWith(
			2,
			{ kind: "calibrate", repetitions: 5, reason: "before trusting small deltas" },
			expect.any(Object),
			{ signal: undefined, onRunEvent: expect.any(Function) },
		);
		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([
			["Noise calibrated", "success"],
			["Noise calibrated", "success"],
		]);
		const text = output.text();
		expect(text).toContain("Noise calibration A/A inconclusive");
		expect(text).toContain("Recommended 3 repetitions per run to keep noise under 10 points");
		expect(text).not.toContain("{");

		await expect(command(commands, "calibrate").handler("11 too many", host.ctx))
			.rejects.toThrow("/calibrate repetitions must be an integer between 1 and 10");
		expect(fixture.decide).toHaveBeenCalledTimes(2);
	});

	it("observes a run live, then shows one human summary with the retained trace link", async () => {
		const liveEvent = vi.fn();
		const finish = vi.fn();
		const fixture = workbench({
			decide: async (input, _gate, execution) => {
				const emit = execution?.onRunEvent;
				expect(emit).toEqual(expect.any(Function));
				emit?.(runEvent({ type: "run_started" }));
				emit?.(runEvent({ type: "assistant_delta", delta: "Inspecting ", truncated: false }));
				emit?.(runEvent({ type: "assistant_delta", delta: "the route.", truncated: false }));
				emit?.(runEvent({
					type: "tool_started",
					toolCallId: "tool-1",
					toolName: "bash",
					arguments: "{\"command\":\"pwd\"}",
					truncated: false,
				}));
				emit?.(runEvent({
					type: "tool_finished",
					toolCallId: "tool-1",
					toolName: "bash",
					isError: false,
					output: "/tmp/ahde-demo",
					truncated: false,
				}));
				emit?.(runEvent({ type: "run_graded", outcome: "pass", passedGraders: 2, totalGraders: 2 }));
				return defaultDecision(input);
			},
		});
		const { commands, output, onWorkbenchChanged } = register(fixture.value, {
			beginLiveTrace: async () => ({ url: LIVE_URL, onRunEvent: liveEvent, finish }),
		});
		const host = context();

		await command(commands, "run").handler("", host.ctx);

		const frames = host.setWidget.mock.calls
			.map(([, content]) => content)
			.filter((content): content is string[] => Array.isArray(content));
		const visible = (frames.at(-1) ?? []).join("\n");
		expect(visible).toContain("provisional development trace");
		expect(visible).toContain(`open live trace · ${LIVE_URL}`);
		expect(visible).toContain("assistant · Inspecting the route.");
		expect(visible).toContain("tool → bash · {\"command\":\"pwd\"}");
		expect(visible).toContain("tool ✓ bash · /tmp/ahde-demo");
		expect(visible).toContain("grade ✓ · pass · 2/2 graders · ✓1 ✗0 so far");
		expect(new Set(host.setStatus.mock.calls.map(([key]) => key))).toEqual(new Set(["ahde-run-progress"]));
		expect(new Set(host.setWidget.mock.calls.map(([key]) => key))).toEqual(new Set(["ahde-run-progress"]));
		expect(host.setStatus).toHaveBeenCalledWith(
			"ahde-run-progress",
			expect.stringMatching(/^AHDE run graded 1\/1 · running 0 █{12} 100% · ✓1 ✗0 · task-routing · graded pass$/),
		);
		expect(host.setStatus).toHaveBeenLastCalledWith("ahde-run-progress", undefined);
		expect(host.setWidget).toHaveBeenLastCalledWith("ahde-run-progress", undefined);

		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([["Run complete", "success"]]);
		const text = output.text();
		expect(text).toContain("1/3 passed");
		expect(text).toContain("2 failed");
		expect(text).toContain("Missing evidence lookup instruction");
		expect(text).toContain("Unstable output");
		expect(text).toContain(`Live trace ${LIVE_URL} · retained for 15 minutes`);
		expect(text).toContain("Next Say “fix the first problem”");
		expect(text).not.toContain("schemaVersion");
		expect(text).not.toContain("{");
		expect(output.note).toHaveBeenCalledTimes(1);
		const note = String(output.note.mock.calls[0]?.[0]);
		expect(note).toContain("Operator ran /run: 1/3 passed · 2 failure modes");
		expect(note).toContain("improvement-authoring (Diagnosis)");
		expect(onWorkbenchChanged).toHaveBeenCalledTimes(1);
		expect(liveEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "assistant_delta", delta: "Inspecting " }));
		expect(finish).toHaveBeenCalledOnce();
		expect(finish).toHaveBeenCalledWith("completed");
		expect(host.notify).not.toHaveBeenCalled();
	});

	it("fans /run into one retained web trace without exposing live text in the final output", async () => {
		const liveEvent = vi.fn();
		const finish = vi.fn();
		const fixture = workbench({
			decide: async (input, _gate, execution) => {
				execution?.onRunEvent?.(runEvent({ type: "assistant_delta", delta: "WEB_FANOUT_CANARY", truncated: false }));
				return defaultDecision(input);
			},
		});
		const { commands, output } = register(fixture.value, {
			beginLiveTrace: async () => ({ url: LIVE_URL, onRunEvent: liveEvent, finish }),
		});
		const host = context();

		await command(commands, "run").handler("", host.ctx);

		expect(liveEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "assistant_delta", delta: "WEB_FANOUT_CANARY" }));
		expect(finish).toHaveBeenCalledWith("completed");
		const frames = host.setWidget.mock.calls
			.map(([, content]) => content)
			.filter((content): content is string[] => Array.isArray(content));
		expect(frames.some((frame) => frame.join("\n").includes(LIVE_URL))).toBe(true);
		expect(output.text()).toContain(LIVE_URL);
		expect(JSON.stringify(output.show.mock.calls)).not.toContain("WEB_FANOUT_CANARY");
		expect(JSON.stringify(output.note.mock.calls)).not.toContain("WEB_FANOUT_CANARY");
		expect(host.notify).not.toHaveBeenCalled();
	});

	it("keeps /run operational when the live web host cannot start", async () => {
		const fixture = workbench();
		const { commands, output } = register(fixture.value, {
			beginLiveTrace: async () => {
				throw new Error("port unavailable");
			},
		});
		const host = context();

		await expect(command(commands, "run").handler("", host.ctx)).resolves.toBeUndefined();
		expect(fixture.decide).toHaveBeenCalledOnce();
		expect(output.blocks.map((block) => block.title)).toEqual(["Run complete"]);
		expect(output.text()).not.toContain("Live trace");
	});

	it("rejects a non-loopback live URL without exposing or blocking the run", async () => {
		const finish = vi.fn();
		const fixture = workbench();
		const { commands, output } = register(fixture.value, {
			beginLiveTrace: async () => ({
				url: `https://attacker.invalid/live/${"d".repeat(32)}`,
				onRunEvent: vi.fn(),
				finish,
			}),
		});
		const host = context();

		await command(commands, "run").handler("", host.ctx);
		expect(finish).toHaveBeenCalledWith("aborted");
		expect(JSON.stringify(host.setWidget.mock.calls)).not.toContain("attacker.invalid");
		expect(JSON.stringify(output.show.mock.calls)).not.toContain("attacker.invalid");
		expect(fixture.decide).toHaveBeenCalledOnce();
	});

	it("reports graded and running counts while executions overlap", () => {
		const setStatus = vi.fn();
		const setWidget = vi.fn();
		const progress = createRunProgressPresenter({ setStatus, setWidget });
		const three = { total: 3 };
		const statuses = (): string[] => setStatus.mock.calls.map(([, value]) => String(value));

		progress.onRunEvent(runEvent({ type: "run_started" }, { ...three, runId: "run-a", ordinal: 1 }));
		progress.onRunEvent(runEvent({ type: "run_started" }, { ...three, runId: "run-b", ordinal: 2 }));
		progress.onRunEvent(runEvent({ type: "run_started" }, { ...three, runId: "run-c", ordinal: 3 }));
		expect(statuses().at(-1)).toContain("AHDE run graded 0/3 · running 3");

		// A pool finishes out of order; the counters follow completion, not ordinals.
		progress.onRunEvent(runEvent(
			{ type: "run_graded", outcome: "pass", passedGraders: 1, totalGraders: 1 },
			{ ...three, runId: "run-b", ordinal: 2 },
		));
		expect(statuses().at(-1)).toContain("AHDE run graded 1/3 · running 2");
		progress.onRunEvent(runEvent(
			{ type: "run_graded", outcome: "fail", passedGraders: 0, totalGraders: 1 },
			{ ...three, runId: "run-c", ordinal: 3 },
		));
		progress.onRunEvent(runEvent(
			{ type: "run_graded", outcome: "error", passedGraders: 0, totalGraders: 1 },
			{ ...three, runId: "run-a", ordinal: 1 },
		));
		expect(statuses().at(-1)).toContain("AHDE run graded 3/3 · running 0 ");
		expect(statuses().at(-1)).toContain("✓1 ✗1 !1");
		progress.dispose();
	});

	it("never splices interleaved assistant text from two runs into one line", () => {
		const setStatus = vi.fn();
		const setWidget = vi.fn();
		const progress = createRunProgressPresenter({ setStatus, setWidget });

		progress.onRunEvent(runEvent(
			{ type: "assistant_delta", delta: "first-run-text", truncated: false },
			{ runId: "run-a", ordinal: 1, total: 2 },
		));
		progress.onRunEvent(runEvent(
			{ type: "assistant_delta", delta: "second-run-text", truncated: false },
			{ runId: "run-b", ordinal: 2, total: 2 },
		));

		const frame = (setWidget.mock.calls.at(-1)?.[1] ?? []) as string[];
		expect(frame).toContain("assistant · first-run-text");
		expect(frame).toContain("assistant · second-run-text");
		expect(frame.join("\n")).not.toContain("first-run-textsecond-run-text");
		progress.dispose();
	});

	it("keeps every live widget frame within Pi's 10 visible lines and 32 KiB", () => {
		const setStatus = vi.fn();
		const setWidget = vi.fn();
		const progress = createRunProgressPresenter({ setStatus, setWidget });

		progress.onRunEvent(runEvent({ type: "run_started" }));
		for (let index = 0; index < 80; index += 1) {
			progress.onRunEvent(runEvent({
				type: "assistant_delta",
				delta: `line-${index}\n`,
				truncated: false,
			}));
		}
		for (let index = 0; index < 20; index += 1) {
			progress.onRunEvent(runEvent({
				type: "tool_started",
				toolCallId: `tool-${index}`,
				toolName: "bash",
				arguments: `${index}:${"x".repeat(4_096)}`,
				truncated: false,
			}));
		}

		const frames = setWidget.mock.calls
			.map(([, content]) => content)
			.filter((content): content is string[] => Array.isArray(content));
		expect(frames.length).toBeGreaterThan(1);
		for (const frame of frames) {
			expect(frame.length).toBeLessThanOrEqual(10);
			expect(frame.every((line) => !/[\r\n]/.test(line))).toBe(true);
			expect(Buffer.byteLength(frame.join("\n"), "utf8")).toBeLessThanOrEqual(32 * 1024);
		}
		const finalFrame = frames.at(-1)?.join("\n") ?? "";
		expect(finalFrame).toContain("tool → bash · 19:");
		expect(finalFrame).not.toContain("tool → bash · 0:");
		progress.dispose();
	});

	it("strips terminal control channels from untrusted live text", () => {
		const setStatus = vi.fn();
		const setWidget = vi.fn();
		const progress = createRunProgressPresenter({ setStatus, setWidget });

		progress.onRunEvent(runEvent({
			type: "assistant_delta",
			delta: "before]52;c;CLIPBOARD_CANARYafter",
			truncated: false,
		}));
		progress.onRunEvent(runEvent({
			type: "tool_started",
			toolCallId: "tool-control",
			toolName: "safe[31m-name",
			arguments: "left_APC_CANARY\\right",
			truncated: false,
		}));

		const rendered = JSON.stringify({
			statuses: setStatus.mock.calls,
			widgets: setWidget.mock.calls,
		});
		expect(rendered).not.toContain("");
		expect(rendered).not.toContain("CLIPBOARD_CANARY");
		expect(rendered).not.toContain("APC_CANARY");
		expect(rendered).toContain("beforeafter");
		expect(rendered).toContain("safe-name");
		expect(rendered).toContain("leftright");
		progress.dispose();
	});

	it.each([
		{ label: "error", message: "runner failed", abort: false },
		{ label: "abort", message: "run cancelled", abort: true },
	])("cleans live UI after a run $label and still points at the retained trace", async ({ message, abort }) => {
		const controller = new AbortController();
		const finish = vi.fn();
		const fixture = workbench({
			decide: async (_input, _gate, execution) => {
				execution?.onRunEvent?.(runEvent({ type: "run_started" }));
				const failure = new Error(message);
				if (abort) controller.abort(failure);
				throw failure;
			},
		});
		const { commands, output, onWorkbenchChanged } = register(fixture.value, {
			beginLiveTrace: async () => ({
				url: `http://127.0.0.1:43123/live/${"c".repeat(32)}`,
				onRunEvent: vi.fn(),
				finish,
			}),
		});
		const host = context({ signal: controller.signal });

		await expect(command(commands, "run").handler("", host.ctx)).rejects.toThrow(message);
		expect(host.setStatus).toHaveBeenLastCalledWith("ahde-run-progress", undefined);
		expect(host.setWidget).toHaveBeenLastCalledWith("ahde-run-progress", undefined);
		expect(host.notify).toHaveBeenCalledTimes(1);
		expect(host.notify).toHaveBeenCalledWith(
			expect.stringContaining("Live trace retained for 15 minutes: http://127.0.0.1:43123/live/"),
			"info",
		);
		expect(JSON.stringify(host.notify.mock.calls)).not.toContain(message);
		expect(finish).toHaveBeenCalledWith(abort ? "aborted" : "error");
		expect(output.show).not.toHaveBeenCalled();
		expect(output.note).not.toHaveBeenCalled();
		expect(onWorkbenchChanged).not.toHaveBeenCalled();
	});

	it("routes /apply to apply-proposal and names the branch itself when it is omitted", async () => {
		const fixture = workbench();
		const { commands, output, onWorkbenchChanged } = register(fixture.value);
		const host = context();

		await command(commands, "apply").handler("candidate/routing verify the fix", host.ctx);

		expect(fixture.decide).toHaveBeenCalledWith(
			{ kind: "apply-proposal", branch: "candidate/routing", reason: "verify the fix" },
			expect.objectContaining({ confirm: expect.any(Function), selectSealed: expect.any(Function) }),
			{ signal: undefined },
		);
		expect(host.input).not.toHaveBeenCalled();
		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([["Proposal applied", "success"]]);
		expect(output.text()).toContain("Proposal applied branch candidate/routing");
		expect(output.text()).toContain("Your checkout was not switched");
		expect(output.note).toHaveBeenCalledWith(expect.stringContaining("Operator ran /apply"));
		expect(String(output.note.mock.calls[0]?.[0])).toContain("candidate-verification (Candidate verification)");
		expect(onWorkbenchChanged).toHaveBeenCalledTimes(1);

		await expect(command(commands, "apply").handler("-invalid", host.ctx))
			.rejects.toThrow("branch must be one bounded Git branch name");
		expect(fixture.decide).toHaveBeenCalledTimes(1);

		// Without a branch the proposal id names the candidate branch; nothing is asked.
		const implicit = context();
		await command(commands, "apply").handler("", implicit.ctx);
		expect(implicit.input).not.toHaveBeenCalled();
		expect(fixture.decide).toHaveBeenLastCalledWith(
			{ kind: "apply-proposal", branch: "candidate/next", reason: "Requested interactively via /apply" },
			expect.any(Object),
			{ signal: undefined },
		);
		expect(fixture.decide).toHaveBeenCalledTimes(2);
	});

	it("routes /discard to discard-proposal and abandons an interrupted candidate instead", async () => {
		const fixture = workbench();
		const { commands, output } = register(fixture.value);
		const host = context();

		await command(commands, "discard").handler("wrong root cause", host.ctx);
		await command(commands, "discard").handler("   ", host.ctx);

		expect(fixture.view.mock.calls.map(([query]) => query)).toEqual([{ aspect: "review" }, { aspect: "review" }]);
		expect(fixture.decide.mock.calls.map(([input]) => input)).toEqual([
			{ kind: "discard-proposal", reason: "wrong root cause" },
			{ kind: "discard-proposal", reason: "Requested interactively via /discard" },
		]);
		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([
			["Proposal discarded", "info"],
			["Proposal discarded", "info"],
		]);

		const interrupted = workbench({ view: async () => interruptedView });
		const recovery = register(interrupted.value);
		await command(recovery.commands, "discard").handler("retry from exact apply receipt", context().ctx);

		expect(interrupted.decide).toHaveBeenCalledWith(
			{ kind: "abandon-candidate", candidateId: "candidate-stopped", reason: "retry from exact apply receipt" },
			expect.any(Object),
			{ signal: undefined },
		);
		expect(recovery.output.blocks.map((block) => [block.title, block.tone])).toEqual([["Candidate attempt abandoned", "info"]]);
		expect(recovery.output.text()).toContain("Interrupted candidate abandoned candidate-stopped · stopped at validated");
		expect(recovery.output.text()).toContain("The applied proposal can be verified again with /run.");
	});

	it("records the review and promotes through one intent gate at candidate-review", async () => {
		const fixture = gatedWorkbench("candidate-review");
		const { commands, output, onWorkbenchChanged, actorId } = register(fixture.value);
		const host = context({ confirm: async () => true });

		await command(commands, "promote").handler("1.2.0", host.ctx);

		expect(fixture.decide.mock.calls.map(([input]) => input)).toEqual([
			{ kind: "review-candidate", recommendation: "promote", reason: "Requested interactively via /promote" },
			{ kind: "promote-candidate", version: "1.2.0", reason: "Requested interactively via /promote" },
		]);
		expect(fixture.decide).toHaveBeenNthCalledWith(
			2,
			expect.anything(),
			expect.objectContaining({ confirm: expect.any(Function), selectSealed: expect.any(Function) }),
			{ signal: undefined },
		);
		expect(host.confirm).toHaveBeenCalledTimes(1);
		expect(host.confirm).toHaveBeenCalledWith(
			"Promote candidate as v1.2.0",
			expect.stringMatching(/records your review \(recommend promote\)[\s\S]*as v1\.2\.0[\s\S]*Reason Requested interactively via \/promote[\s\S]*Exact subject sha256:/),
			{ signal: undefined },
		);
		expect(actorId).toHaveBeenCalled();
		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([["Candidate promoted", "success"]]);
		expect(output.text()).toContain("Candidate promoted v1.2.0");
		expect(output.text()).toContain("The active Target is unchanged until you /adopt.");
		expect(output.note).toHaveBeenCalledTimes(1);
		expect(String(output.note.mock.calls[0]?.[0])).toContain("Operator ran /promote");
		expect(String(output.note.mock.calls[0]?.[0])).toContain("candidate-adoption (Adopt candidate)");
		expect(onWorkbenchChanged).toHaveBeenCalledTimes(1);
		expect(host.notify).not.toHaveBeenCalled();
	});

	it("promotes with a single receipt at release-decision and asks for the version when omitted", async () => {
		const fixture = gatedWorkbench("release-decision");
		const { commands, output } = register(fixture.value);
		const host = context({ confirm: async () => true });

		await command(commands, "promote").handler("2.0.0 ship it", host.ctx);

		expect(fixture.decide.mock.calls.map(([input]) => input)).toEqual([
			{ kind: "promote-candidate", version: "2.0.0", reason: "ship it" },
		]);
		expect(host.confirm).toHaveBeenCalledTimes(1);
		expect(host.confirm).toHaveBeenCalledWith(
			"Promote candidate as v2.0.0",
			expect.stringContaining("This tags the exact reviewed revision as v2.0.0."),
			{ signal: undefined },
		);
		expect(output.blocks.map((block) => block.title)).toEqual(["Candidate promoted"]);

		const prompted = context({ confirm: async () => true, input: async () => "0.3.0" });
		await command(commands, "promote").handler("", prompted.ctx);
		expect(prompted.input).toHaveBeenCalledWith("Version to tag (semver, e.g. 0.2.0)", "0.1.0");
		expect(fixture.decide).toHaveBeenLastCalledWith(
			{ kind: "promote-candidate", version: "0.3.0", reason: "Requested interactively via /promote" },
			expect.any(Object),
			{ signal: undefined },
		);

		const cancelled = context({ confirm: async () => true, input: async () => undefined });
		await command(commands, "promote").handler("", cancelled.ctx);
		expect(fixture.decide).toHaveBeenCalledTimes(2);
		expect(cancelled.confirm).not.toHaveBeenCalled();

		await expect(command(commands, "promote").handler("v1", host.ctx)).rejects.toThrow("version must be semver like 0.2.0");
		const malformed = context({ confirm: async () => true, input: async () => "banana" });
		await expect(command(commands, "promote").handler("", malformed.ctx)).rejects.toThrow("version must be semver like 0.2.0");
		expect(fixture.decide).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ command: "promote", args: "1.0.0", stage: "ready-to-evaluate" as const, label: "Ready to run" },
		{ command: "promote", args: "1.0.0", stage: "proposal-review" as const, label: "Proposal review" },
		{ command: "promote", args: "1.0.0", stage: "candidate-verification" as const, label: "Candidate verification" },
		{ command: "reject", args: "", stage: "spec-review" as const, label: "Spec review" },
		{ command: "reject", args: "", stage: "complete" as const, label: "Cycle complete" },
	])("refuses /$command during $label without touching the Workbench", async ({ command: name, args, stage, label }) => {
		const fixture = gatedWorkbench(stage);
		const { commands, output } = register(fixture.value);
		const host = context({ confirm: async () => true });

		await expect(command(commands, name).handler(args, host.ctx))
			.rejects.toThrow(`/${name} is not available during ${label}`);
		expect(fixture.decide).not.toHaveBeenCalled();
		expect(host.confirm).not.toHaveBeenCalled();
		expect(output.show).not.toHaveBeenCalled();
	});

	it("stops after a declined review and never pre-approves a different candidate", async () => {
		const declined = gatedWorkbench("candidate-review");
		const declinedFixture = register(declined.value);
		const declinedHost = context({ confirm: async () => false });

		await command(declinedFixture.commands, "promote").handler("1.2.0", declinedHost.ctx);

		expect(declined.decide.mock.calls.map(([input]) => input)).toEqual([
			{ kind: "review-candidate", recommendation: "promote", reason: "Requested interactively via /promote" },
		]);
		expect(declinedHost.confirm).toHaveBeenCalledTimes(1);
		expect(declinedHost.notify).toHaveBeenCalledWith("Cancelled — nothing changed.", "info");
		expect(declinedFixture.output.show).not.toHaveBeenCalled();
		expect(declinedFixture.onWorkbenchChanged).not.toHaveBeenCalled();

		const swapped = gatedWorkbench("candidate-review", {
			candidateIdFor: (input) => input.kind === "promote-candidate" ? "cand-other" : "cand-1",
		});
		const swappedFixture = register(swapped.value);
		const swappedHost = context({ confirm: async () => true });

		await command(swappedFixture.commands, "promote").handler("1.2.0", swappedHost.ctx);

		expect(swapped.decide).toHaveBeenCalledTimes(2);
		expect(swappedHost.confirm).toHaveBeenCalledTimes(2);
		expect(swappedFixture.output.blocks.map((block) => block.title)).toEqual(["Candidate promoted"]);
	});

	it("mirrors the intent gate for /reject at candidate-review and release-decision", async () => {
		const reviewing = gatedWorkbench("candidate-review");
		const reviewingFixture = register(reviewing.value);
		const reviewingHost = context({ confirm: async () => true });

		await command(reviewingFixture.commands, "reject").handler("wrong direction", reviewingHost.ctx);

		expect(reviewing.decide.mock.calls.map(([input]) => input)).toEqual([
			{ kind: "review-candidate", recommendation: "reject", reason: "wrong direction" },
			{ kind: "reject-candidate", reason: "wrong direction" },
		]);
		expect(reviewingHost.confirm).toHaveBeenCalledTimes(1);
		expect(reviewingHost.confirm).toHaveBeenCalledWith(
			"Reject candidate",
			expect.stringMatching(/records your review \(recommend reject\)[\s\S]*Reason wrong direction[\s\S]*Exact subject sha256:/),
			{ signal: undefined },
		);
		expect(reviewingFixture.output.blocks.map((block) => [block.title, block.tone])).toEqual([["Candidate rejected", "warning"]]);
		expect(reviewingFixture.output.text()).toContain("Candidate rejected cand-1 · rejected");
		expect(reviewingFixture.output.note).toHaveBeenCalledWith(expect.stringContaining("Operator ran /reject"));
		expect(reviewingFixture.onWorkbenchChanged).toHaveBeenCalledTimes(1);

		const deciding = gatedWorkbench("release-decision");
		const decidingFixture = register(deciding.value);
		const decidingHost = context({ confirm: async () => true });

		await command(decidingFixture.commands, "reject").handler("", decidingHost.ctx);

		expect(deciding.decide.mock.calls.map(([input]) => input)).toEqual([
			{ kind: "reject-candidate", reason: "Requested interactively via /reject" },
		]);
		expect(decidingHost.confirm).toHaveBeenCalledTimes(1);
		expect(decidingHost.confirm).toHaveBeenCalledWith(
			"Reject candidate",
			expect.stringContaining("This rejects the reviewed candidate durably."),
			{ signal: undefined },
		);
	});

	const simpleCases: Array<{ name: string; args: string; input: WorkbenchDecisionInput; title: string; tone: TranscriptTone }> = [
		{ name: "approve", args: "looks right", input: { kind: "approve-spec", reason: "looks right" }, title: "Spec approved", tone: "success" },
		{ name: "approve", args: "", input: { kind: "approve-spec", reason: "Requested interactively via /approve" }, title: "Spec approved", tone: "success" },
		{ name: "publish", args: "routing-basket", input: { kind: "publish-corpus", name: "routing-basket", reason: "Requested interactively via /publish" }, title: "Eval basket published", tone: "success" },
		{ name: "publish", args: "", input: { kind: "publish-corpus", reason: "Requested interactively via /publish" }, title: "Eval basket published", tone: "success" },
		{ name: "adopt", args: "ship it", input: { kind: "adopt-candidate", reason: "ship it" }, title: "Candidate adopted", tone: "success" },
		{ name: "adopt", args: "", input: { kind: "adopt-candidate", reason: "Requested interactively via /adopt" }, title: "Candidate adopted", tone: "success" },
		{ name: "next", args: "", input: { kind: "continue-cycle", reason: "Requested interactively via /next" }, title: "Next cycle started", tone: "success" },
		{ name: "next", args: "start on latency", input: { kind: "continue-cycle", reason: "start on latency" }, title: "Next cycle started", tone: "success" },
	];

	it.each(simpleCases)("routes /$name $args to its decision and shows one human receipt", async ({ name, args, input, title, tone }) => {
		const fixture = workbench();
		const { commands, output, onWorkbenchChanged } = register(fixture.value);
		const host = context();

		await command(commands, name).handler(args, host.ctx);

		expect(fixture.decide).toHaveBeenCalledTimes(1);
		expect(fixture.decide).toHaveBeenCalledWith(
			input,
			expect.objectContaining({ confirm: expect.any(Function), selectSealed: expect.any(Function) }),
			{ signal: undefined },
		);
		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([[title, tone]]);
		expect(output.text()).toContain("Next ");
		expect(output.text()).not.toMatch(/[{}]|schemaVersion/);
		expect(output.note).toHaveBeenCalledWith(expect.stringContaining(`Operator ran /${name}`));
		expect(onWorkbenchChanged).toHaveBeenCalledTimes(1);
		expect(host.notify).not.toHaveBeenCalled();
		expect(host.confirm).not.toHaveBeenCalled();
	});

	it("offers apply and discard after rendering a proposal in /review", async () => {
		const proposalView = viewAt("proposal-review", { detail: { aspect: "review", content: proposalReview() } });
		const fixture = workbench({ view: async () => proposalView });
		const { commands, output } = register(fixture.value);
		const host = context({ select: async () => "Apply to a candidate branch" });

		await command(commands, "review").handler("", host.ctx);

		expect(host.select).toHaveBeenCalledWith("Proposal", ["Apply to a candidate branch", "Discard", "Just looking"], { signal: undefined });
		// The branch is named after the proposal; the diff was just rendered, so nothing else is asked.
		expect(host.input).not.toHaveBeenCalled();
		expect(fixture.decide).toHaveBeenCalledWith(
			{ kind: "apply-proposal", branch: "candidate/builder-proposal-1", reason: "Applied from /review", runId: "builder-proposal-1" },
			expect.any(Object),
			{ signal: undefined },
		);
		expect(output.blocks.map((block) => block.title)).toEqual(["AHDE · Proposal review", "Proposal applied"]);
		const review = output.blocks[0]?.lines.map(stripMarkers).join("\n") ?? "";
		expect(review).toContain("Proposal builder-proposal-1");
		expect(review).toContain("Route lookups through the evidence tool before answering.");
		expect(review).toContain("Changes AGENTS.md (+1 -0)");
		expect(review).toContain("Evidence eval erun-current · 1 targeted failure mode");
		expect(review).toContain("+Always call the lookup tool before answering.");
		expect(review).not.toMatch(/[{}]|schemaVersion/);

		const looking = context({ select: async () => "Just looking" });
		const lookingFixture = register(fixture.value);
		await command(lookingFixture.commands, "review").handler("", looking.ctx);
		expect(looking.select).toHaveBeenCalledTimes(1);
		expect(looking.input).not.toHaveBeenCalled();
		expect(fixture.decide).toHaveBeenCalledTimes(1);
		expect(lookingFixture.output.blocks.map((block) => block.title)).toEqual(["AHDE · Proposal review"]);

		const discarding = context({ select: async () => "Discard" });
		const discardingFixture = register(fixture.value);
		await command(discardingFixture.commands, "review").handler("", discarding.ctx);
		expect(fixture.decide).toHaveBeenLastCalledWith(
			{ kind: "discard-proposal", reason: "Discarded from /review" },
			expect.any(Object),
			{ signal: undefined },
		);
		expect(discardingFixture.output.blocks.map((block) => block.title)).toEqual(["AHDE · Proposal review", "Proposal discarded"]);

		const noSelector = context({ withoutSelect: true });
		const noSelectorFixture = register(fixture.value);
		await command(noSelectorFixture.commands, "review").handler("", noSelector.ctx);
		expect(noSelector.input).not.toHaveBeenCalled();
		expect(fixture.decide).toHaveBeenCalledTimes(2);
		expect(noSelectorFixture.output.blocks.map((block) => block.title)).toEqual(["AHDE · Proposal review"]);
	});

	const reviewCases: Array<{ stage: WorkbenchStage; title: string; choice: string; input: WorkbenchDecisionInput; receipt: string }> = [
		{ stage: "spec-review", title: "Spec draft", choice: "Approve this Spec", input: { kind: "approve-spec", reason: "Approved from /review" }, receipt: "Spec approved" },
		{ stage: "corpus-review", title: "Eval basket draft", choice: "Publish this basket", input: { kind: "publish-corpus", reason: "Published from /review" }, receipt: "Eval basket published" },
		{ stage: "candidate-adoption", title: "Promoted candidate", choice: "Adopt as the active Target", input: { kind: "adopt-candidate", reason: "Adopted from /review" }, receipt: "Candidate adopted" },
		{ stage: "complete", title: "Cycle complete", choice: "Start the next cycle", input: { kind: "continue-cycle", reason: "Continued from /review" }, receipt: "Next cycle started" },
	];

	it.each(reviewCases)("offers “$choice” from /review at $stage", async ({ stage, title, choice, input, receipt }) => {
		const fixture = workbench({ view: async () => viewAt(stage) });
		const { commands, output } = register(fixture.value);
		const host = context({ select: async () => choice });

		await command(commands, "review").handler("", host.ctx);

		expect(host.select).toHaveBeenCalledWith(title, expect.arrayContaining([choice, "Just looking"]), { signal: undefined });
		expect(host.select.mock.calls[0]?.[1].at(-1)).toBe("Just looking");
		expect(fixture.decide).toHaveBeenCalledWith(input, expect.any(Object), { signal: undefined });
		expect(output.blocks.map((block) => block.title).at(-1)).toBe(receipt);
	});

	it("routes “Ask for changes” back to the conversation instead of a decision", async () => {
		const fixture = workbench({ view: async () => viewAt("spec-review") });
		const { commands } = register(fixture.value);
		const host = context({ select: async () => "Ask for changes" });

		await command(commands, "review").handler("", host.ctx);

		expect(host.select).toHaveBeenCalledWith("Spec draft", ["Approve this Spec", "Ask for changes", "Just looking"], { signal: undefined });
		expect(fixture.decide).not.toHaveBeenCalled();
		expect(host.notify).toHaveBeenCalledWith(expect.stringContaining("Tell the Builder what to change"), "info");
	});

	it("offers recovery, verification, and release decisions from /review for candidates", async () => {
		const interrupted = workbench({ view: async () => interruptedView });
		const recovery = register(interrupted.value);
		const recoveryHost = context({ select: async () => "Abandon this attempt" });
		await command(recovery.commands, "review").handler("", recoveryHost.ctx);
		expect(recoveryHost.select).toHaveBeenCalledWith("Interrupted candidate", ["Abandon this attempt", "Just looking"], { signal: undefined });
		expect(interrupted.decide).toHaveBeenCalledWith(
			{ kind: "abandon-candidate", candidateId: "candidate-stopped", reason: "Abandoned from /review" },
			expect.any(Object),
			{ signal: undefined },
		);
		expect(recovery.output.blocks.map((block) => block.title)).toEqual(["AHDE · Interrupted candidate", "Candidate attempt abandoned"]);
		expect(recovery.output.text()).toContain("Verification stopped before evidence was complete.");

		const verifying = workbench({
			view: async () => viewAt("candidate-verification"),
			decide: async () => decision("run-current", {
				resolvedAs: "verify-candidate",
				outcome: "verified" as const,
				screen: null,
				candidate: candidateSummary(),
				development: { verdict: "improved", delta: 2 / 3, confidence95: { low: 0.1, high: 0.9 } },
				sealedHoldout: { executed: true, gatePassed: true, verdict: "pass" },
			}, viewAt("candidate-review")),
		});
		const verification = register(verifying.value);
		const verificationHost = context({ select: async () => "Verify the candidate now (/run)" });
		await command(verification.commands, "review").handler("", verificationHost.ctx);
		expect(verifying.decide).toHaveBeenCalledWith(
			{ kind: "run-current", repetitions: 3, reason: "Verification from /review" },
			expect.any(Object),
			{ signal: undefined, onRunEvent: expect.any(Function) },
		);
		expect(verification.output.blocks.map((block) => [block.title, block.tone])).toEqual([
			["AHDE · Candidate verification", "info"],
			["Candidate verified", "success"],
		]);
		expect(verification.output.text()).toContain("Development baseline 33% → candidate 100% (+66.7 pts) on 3 tasks");
		expect(verification.output.text()).toContain("Sealed holdout gate passed");
		expect(verificationHost.setWidget).toHaveBeenLastCalledWith("ahde-run-progress", undefined);

		const promoting = gatedWorkbench("candidate-review");
		const promotion = register(promoting.value);
		const promotionHost = context({ select: async () => "Ship it…", input: async () => "1.0.0", confirm: async () => true });
		await command(promotion.commands, "review").handler("", promotionHost.ctx);
		expect(promotionHost.select).toHaveBeenCalledWith("Candidate", ["Ship it…", "Reject", "Just looking"], { signal: undefined });
		expect(promotionHost.input).toHaveBeenCalledWith("Version to tag (semver, e.g. 0.2.0)", "0.1.0");
		// One composite decision, not four: review, promote, adopt and continue run
		// underneath it and write the same four receipts.
		expect(promoting.decide.mock.calls.map(([input]) => input)).toEqual([
			{ kind: "ship", version: "1.0.0", reason: "Shipped from /review" },
		]);
		expect(promotionHost.confirm).toHaveBeenCalledTimes(1);
		expect(promotion.output.blocks.map((block) => block.title)).toEqual(["AHDE · Candidate review", "Shipped"]);

		const rejecting = gatedWorkbench("release-decision");
		const rejection = register(rejecting.value);
		const rejectionHost = context({ select: async () => "Reject", confirm: async () => true });
		await command(rejection.commands, "review").handler("", rejectionHost.ctx);
		expect(rejecting.decide.mock.calls.map(([input]) => input)).toEqual([
			{ kind: "reject-candidate", reason: "Rejected from /review" },
		]);
		expect(rejection.output.blocks.map((block) => block.title)).toEqual(["AHDE · Release decision", "Candidate rejected"]);
	});

	it("renders the diagnosis for /traces and offers to fix one selectable failure mode", async () => {
		const tracesView = viewAt("improvement-authoring", { detail: { aspect: "traces", content: tracesDetail() } });
		const sendUserMessage = vi.fn();
		const fixture = workbench({ view: async () => tracesView });
		const { commands, output } = register(fixture.value, { sendUserMessage });
		const controller = new AbortController();
		const host = context({ signal: controller.signal, select: async () => "Fix 1: Missing evidence lookup instruction" });

		await command(commands, "traces").handler("", host.ctx);

		expect(fixture.view).toHaveBeenCalledWith({ aspect: "traces" });
		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([["AHDE · Diagnosis", "info"]]);
		const text = output.text();
		expect(text).toContain("Evaluation 1/3 passed");
		expect(text).toContain("Diagnosis actionable · 1/3 passed. Two exact failure modes found.");
		expect(text).toContain("Failure modes 1 systemic · 1 task-local");
		expect(text).toContain("1. Missing evidence lookup instruction — 2 tasks (67% · reproduces 100%)");
		expect(text).toContain("→ propose fix");
		expect(text).toContain("2. Unstable output — 1 task");
		expect(text).toContain(`Evidence ${EVIDENCE_URL}`);
		expect(text).toContain("Next say “fix the first problem”");
		expect(text).not.toMatch(/[{}]|schemaVersion/);
		expect(text).not.toContain(FIRST_MODE);

		expect(host.select).toHaveBeenCalledWith(
			"Prepare a proposal?",
			["Fix 1: Missing evidence lookup instruction", "Not now"],
			{ signal: controller.signal },
		);
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		const message = String(sendUserMessage.mock.calls[0]?.[0]);
		expect(message).toContain(`Fix problem 1 (${FIRST_MODE})`);
		expect(message).toContain("Missing evidence lookup instruction");
		expect(message).not.toContain(SECOND_MODE);
		expect(fixture.decide).not.toHaveBeenCalled();

		const declined = context({ select: async () => "Not now" });
		sendUserMessage.mockClear();
		await command(commands, "traces").handler("", declined.ctx);
		expect(sendUserMessage).not.toHaveBeenCalled();

		const noSelector = context({ withoutSelect: true });
		await command(commands, "traces").handler("", noSelector.ctx);
		expect(sendUserMessage).not.toHaveBeenCalled();

		const unbridged = register(fixture.value);
		const unbridgedHost = context({ select: async () => "Fix 1: Missing evidence lookup instruction" });
		await command(unbridged.commands, "traces").handler("", unbridgedHost.ctx);
		expect(unbridgedHost.select).not.toHaveBeenCalled();
		expect(unbridged.output.blocks.map((block) => block.title)).toEqual(["AHDE · Diagnosis"]);
	});

	it("humanizes Workbench failures into one calm sentence", () => {
		expect(humanizeCommandError(new WorkbenchDecisionDeclinedError("apply-proposal")))
			.toEqual({ message: "Cancelled — nothing changed.", tone: "info" });
		expect(humanizeCommandError(new WorkbenchStaleDecisionError("apply-proposal")))
			.toEqual({ message: expect.stringContaining("changed while you were reviewing"), tone: "warning" });
		expect(humanizeCommandError(new WorkbenchSelectionRequiredError("proposal", ["builder-1", "builder-2"])))
			.toEqual({
				message: "Several compatible proposal artifacts exist; select one before continuing. Ask the Builder to select one (for example “use the first one”). Choices: builder-1, builder-2.",
				tone: "warning",
			});
		expect(humanizeCommandError(new Error("disk full\n    at writeReceipt")))
			.toEqual({ message: "disk full at writeReceipt", tone: "error" });
		expect(humanizeCommandError("plain failure")).toEqual({ message: "plain failure", tone: "error" });
	});

	it.each([
		{
			label: "declined",
			error: () => new WorkbenchDecisionDeclinedError("apply-proposal"),
			message: "Cancelled — nothing changed.",
			type: "info",
		},
		{
			label: "stale",
			error: () => new WorkbenchStaleDecisionError("apply-proposal"),
			message: expect.stringContaining("The subject changed while you were reviewing it."),
			type: "warning",
		},
		{
			label: "ambiguous",
			error: () => new WorkbenchSelectionRequiredError("proposal", ["builder-1", "builder-2"]),
			message: expect.stringContaining("Choices: builder-1, builder-2."),
			type: "warning",
		},
	])("turns a $label Workbench failure into one notification without a receipt", async ({ error, message, type }) => {
		const fixture = workbench({
			decide: async () => {
				throw error();
			},
		});
		const { commands, output, onWorkbenchChanged } = register(fixture.value);
		const host = context();

		await expect(command(commands, "apply").handler("candidate/fix", host.ctx)).resolves.toBeUndefined();

		expect(host.notify).toHaveBeenCalledTimes(1);
		expect(host.notify).toHaveBeenCalledWith(message, type);
		expect(output.show).not.toHaveBeenCalled();
		expect(output.note).not.toHaveBeenCalled();
		expect(onWorkbenchChanged).not.toHaveBeenCalled();
	});

	it("rethrows unexpected Workbench errors with a one-line message and the original cause", async () => {
		const original = new Error("disk full\n    while writing the receipt");
		const fixture = workbench({
			decide: async () => {
				throw original;
			},
		});
		const { commands, output, onWorkbenchChanged } = register(fixture.value);
		const host = context();

		let failure: unknown;
		try {
			await command(commands, "approve").handler("", host.ctx);
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe("disk full while writing the receipt");
		expect((failure as Error).cause).toBe(original);
		expect(host.notify).not.toHaveBeenCalled();
		expect(output.show).not.toHaveBeenCalled();
		expect(onWorkbenchChanged).not.toHaveBeenCalled();
	});

	it("waits for the agent to become idle before reading or mutating Workbench state", async () => {
		const events: string[] = [];
		const fixture = workbench({
			view: async () => {
				events.push("view");
				return baseView;
			},
			decide: async (input) => {
				events.push("decide");
				return defaultDecision(input);
			},
		});
		const { commands } = register(fixture.value);
		const host = context({
			waitForIdle: async () => {
				events.push("idle");
			},
		});

		await command(commands, "status").handler("", host.ctx);
		await command(commands, "run").handler("", host.ctx);
		expect(events).toEqual(["idle", "view", "idle", "decide"]);

		const aborted = new AbortController();
		const abortedFixture = workbench();
		const abortedCommands = register(abortedFixture.value).commands;
		const abortedHost = context({
			signal: aborted.signal,
			waitForIdle: async () => {
				aborted.abort(new Error("stopped while waiting"));
			},
		});
		await expect(command(abortedCommands, "run").handler("", abortedHost.ctx))
			.rejects.toThrow("stopped while waiting");
		expect(abortedFixture.decide).not.toHaveBeenCalled();
	});

	it("fails closed for every command outside the local TUI", async () => {
		const fixture = workbench();
		const { commands, output } = register(fixture.value);
		const invocations = AHDE_BUILDER_COMMAND_NAMES.map((name): [string, string] => [
			name,
			name === "apply" ? "candidate/fix" : name === "promote" ? "1.0.0" : "",
		]);
		expect(invocations).toHaveLength(19);

		for (const settings of [
			{ hasUI: false, mode: "print" as const },
			{ hasUI: true, mode: "rpc" as const },
			{ hasUI: true, mode: "json" as const },
			{ hasUI: false, mode: "tui" as const },
		]) {
			const host = context(settings);
			for (const [name, args] of invocations) {
				await expect(command(commands, name).handler(args, host.ctx))
					.rejects.toThrow(`/${name} requires the local Builder Pi TUI`);
			}
			expect(host.waitForIdle).not.toHaveBeenCalled();
			expect(host.notify).not.toHaveBeenCalled();
			expect(host.confirm).not.toHaveBeenCalled();
			expect(host.select).not.toHaveBeenCalled();
			expect(host.input).not.toHaveBeenCalled();
		}

		expect(fixture.view).not.toHaveBeenCalled();
		expect(fixture.decide).not.toHaveBeenCalled();
		expect(output.show).not.toHaveBeenCalled();
	});

	it.each(["help", "doctor", "status", "traces", "review"])("rejects arguments to /%s before touching the host", async (name) => {
		const fixture = workbench();
		const { commands, output } = register(fixture.value);
		const host = context();

		await expect(command(commands, name).handler("unexpected", host.ctx))
			.rejects.toThrow(`/${name} does not accept arguments`);
		expect(host.waitForIdle).not.toHaveBeenCalled();
		expect(fixture.view).not.toHaveBeenCalled();
		expect(output.show).not.toHaveBeenCalled();
	});

	it("reports Builder model auth and Target credential readiness in /doctor", async () => {
		const fixture = workbench();
		const { commands, output } = register(fixture.value);
		const host = context();

		await command(commands, "doctor").handler("", host.ctx);

		expect(fixture.view).toHaveBeenCalledTimes(1);
		expect(host.hasConfiguredAuth).toHaveBeenCalledWith(host.ctx.model);
		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([["AHDE Doctor", "success"]]);
		const text = output.text();
		expect(text).toContain("✓ Builder model anthropic/claude-sonnet-4 · credential present");
		expect(text).toContain("✓ Target target-demo @ aaaaaaaaaa");
		expect(text).toContain("✓ Target model anthropic/claude-sonnet-4 · ANTHROPIC_API_KEY is set");
		expect(text).toContain("Stage Ready to run · Say “tests” to run them");
		expect(text).toContain("✓ Ready: everything needed for /run is in place");
		expect(text).not.toMatch(MARKERS);
		expect(text).not.toMatch(/[{}]|schemaVersion/);
	});

	it("names the missing credential env and blockers in /doctor without ever printing a value", async () => {
		const fixture = workbench({
			view: async () => viewAt("ready-to-evaluate", {
				target: { ...baseView.target, model: { ...TARGET_MODEL, credentialPresent: false } },
				blockers: ["Target manifest declares an unknown tool"],
				warnings: ["Sealed holdout has only 2 cases"],
			}),
		});
		const { commands, output } = register(fixture.value);

		await command(commands, "doctor").handler("", context().ctx);

		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([["AHDE Doctor", "warning"]]);
		const text = output.text();
		expect(text).toContain("! Target model anthropic/claude-sonnet-4 · export ANTHROPIC_API_KEY in the shell that runs ahde before /run");
		expect(text).toContain("! Target manifest declares an unknown tool");
		expect(text).toContain("· Sealed holdout has only 2 cases");
		expect(text).toContain("! Action required before the next run");
		expect(text).not.toContain("Ready: everything needed");

		const unauthenticated = register(workbench().value);
		await command(unauthenticated.commands, "doctor").handler("", context({ hasConfiguredAuth: false }).ctx);
		expect(unauthenticated.output.blocks[0]?.tone).toBe("warning");
		expect(unauthenticated.output.text()).toContain("! Builder model anthropic/claude-sonnet-4 has no credential — /login, or /model to pick a configured model");

		const modelless = register(workbench().value);
		const modellessHost = context({ model: null });
		await command(modelless.commands, "doctor").handler("", modellessHost.ctx);
		expect(modellessHost.hasConfiguredAuth).not.toHaveBeenCalled();
		expect(modelless.output.text()).toContain("! No Builder model selected — /login to connect a provider, then /model");
	});

	it("falls back to plain notifications when the host has no transcript entries", async () => {
		const fixture = workbench();
		const { commands } = register(fixture.value, { presenter: null });
		const host = context();

		await command(commands, "status").handler("", host.ctx);

		expect(host.notify).toHaveBeenCalledTimes(1);
		const [message, type] = host.notify.mock.calls[0] as [string, string];
		expect(type).toBe("info");
		expect(message.split("\n")[0]).toBe("AHDE · Ready to run");
		expect(message).toContain("Target target-demo @ aaaaaaaaaa · anthropic/claude-sonnet-4 ✓");
		expect(message).toContain("Next Say “tests” to run them");
		expect(message).not.toMatch(MARKERS);
		expect(message).not.toContain("schemaVersion");

		await command(commands, "approve").handler("", host.ctx);
		expect(host.notify).toHaveBeenCalledTimes(2);
		const [receipt] = host.notify.mock.calls[1] as [string, string];
		expect(receipt.split("\n")[0]).toBe("Spec approved");
		expect(receipt).not.toMatch(MARKERS);
	});

	it("persists transcript panels through appendEntry and notes decisions to the model without display", async () => {
		const appendEntry = vi.fn();
		const sendMessage = vi.fn();
		const fixture = workbench();
		const { commands } = register(fixture.value, { presenter: null, pi: { appendEntry, sendMessage } });
		const host = context();

		await command(commands, "approve").handler("", host.ctx);

		expect(host.notify).not.toHaveBeenCalled();
		expect(appendEntry).toHaveBeenCalledTimes(1);
		expect(appendEntry).toHaveBeenCalledWith(
			AHDE_TRANSCRIPT_ENTRY_TYPE,
			expect.objectContaining({ schemaVersion: 1, title: "Spec approved", tone: "success", lines: expect.any(Array) }),
		);
		const lines = (appendEntry.mock.calls[0]?.[1] as { lines: string[] }).lines;
		expect(lines.map(stripMarkers).join("\n")).toContain("Spec approved spec-1");
		expect(sendMessage).toHaveBeenCalledWith(
			{ customType: AHDE_MODEL_NOTE_TYPE, content: expect.stringContaining("Operator ran /approve"), display: false },
			{ triggerTurn: false },
		);
	});

	it("derives the human actor lazily, caches it, and forwards the command signal to confirmation", async () => {
		const confirmation: WorkbenchConfirmation = {
			kind: "apply-proposal",
			title: "Apply exact proposal",
			reason: "Observed routing failure",
			subject: {
				branch: "candidate/routing",
				baseTargetSha: SHA_A,
				summary: "Route lookups through the tool.",
				paths: ["AGENTS.md"],
				exactDiff: "",
			},
			subjectHash: hash("b"),
			policy: "consequential",
			question: "Apply this exact diff?",
		};
		const controller = new AbortController();

		const declinedActor = vi.fn(() => "local:must-not-be-read");
		const declined = workbench({
			decide: async (input, gate, execution) => {
				const approval = await gate.confirm(confirmation, execution?.signal);
				if (!approval.approved) throw new WorkbenchDecisionDeclinedError(input.kind);
				return defaultDecision(input);
			},
		});
		const declinedFixture = register(declined.value, { actorId: declinedActor });
		const declinedHost = context({ signal: controller.signal, confirm: async () => false });
		await command(declinedFixture.commands, "apply").handler("candidate/routing", declinedHost.ctx);
		expect(declinedActor).not.toHaveBeenCalled();
		expect(declinedHost.confirm).toHaveBeenCalledWith(
			"Apply exact proposal",
			expect.stringMatching(/Branch candidate\/routing[\s\S]*Reason Observed routing failure[\s\S]*Exact subject sha256:/),
			{ signal: controller.signal },
		);
		expect(declinedHost.notify).toHaveBeenCalledWith("Cancelled — nothing changed.", "info");
		expect(declinedFixture.output.show).not.toHaveBeenCalled();

		const approvals: WorkbenchHumanApproval[] = [];
		const approvedActor = vi.fn(() => "local:alice");
		const approved = workbench({
			decide: async (input, gate, execution) => {
				approvals.push(await gate.confirm(confirmation, execution?.signal));
				approvals.push(await gate.confirm(confirmation, execution?.signal));
				return defaultDecision(input);
			},
		});
		const approvedFixture = register(approved.value, { actorId: approvedActor });
		const approvedHost = context({ signal: controller.signal, confirm: async () => true });
		await command(approvedFixture.commands, "apply").handler("candidate/routing", approvedHost.ctx);
		expect(approvedActor).toHaveBeenCalledTimes(1);
		expect(approvedHost.confirm).toHaveBeenCalledTimes(2);
		expect(approvals).toEqual([
			{ approved: true, actorId: "local:alice" },
			{ approved: true, actorId: "local:alice" },
		]);
		expect(approved.decide).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "apply-proposal" }),
			expect.any(Object),
			{ signal: controller.signal },
		);
		expect(approvedFixture.output.blocks.map((block) => block.title)).toEqual(["Proposal applied"]);
	});

	it("auto-approves a single sealed holdout and treats selector cancellation as denial", async () => {
		const holdouts = [
			{ label: "Holdout A", taskCount: 5 },
			{ label: "Holdout B", taskCount: 7 },
		] as const;
		const sealed = (
			options: readonly { label: string; taskCount: number }[],
			choices: WorkbenchSealedChoice[],
		): ReturnType<typeof workbench> => workbench({
			decide: async (input, gate, execution) => {
				choices.push(await gate.selectSealed({ title: "Choose sealed holdout", options }, execution?.signal));
				return defaultDecision(input);
			},
		});

		const single: WorkbenchSealedChoice[] = [];
		const singleActor = vi.fn(() => "local:alice");
		const singleFixture = register(sealed(holdouts.slice(0, 1), single).value, { actorId: singleActor });
		const singleHost = context();
		await command(singleFixture.commands, "run").handler("", singleHost.ctx);
		expect(singleHost.select).not.toHaveBeenCalled();
		expect(single).toEqual([{ approved: true, actorId: "local:alice", selectedIndex: 0 }]);
		expect(singleActor).toHaveBeenCalledTimes(1);
		expect(singleFixture.output.blocks.map((block) => block.title)).toEqual(["Run complete"]);

		const controller = new AbortController();
		const chosen: WorkbenchSealedChoice[] = [];
		const chosenFixture = register(sealed(holdouts, chosen).value, { actorId: () => "local:alice" });
		const chosenHost = context({ signal: controller.signal, select: async () => "2. Holdout B · 7 tasks" });
		await command(chosenFixture.commands, "run").handler("", chosenHost.ctx);
		expect(chosenHost.select).toHaveBeenCalledWith(
			"Choose sealed holdout",
			["1. Holdout A · 5 tasks", "2. Holdout B · 7 tasks"],
			{ signal: controller.signal },
		);
		expect(chosen).toEqual([{ approved: true, actorId: "local:alice", selectedIndex: 1 }]);

		const cancelled: WorkbenchSealedChoice[] = [];
		const cancelledActor = vi.fn(() => "local:must-not-be-read");
		const cancelledFixture = register(sealed(holdouts, cancelled).value, { actorId: cancelledActor });
		const cancelledHost = context({ select: async () => undefined });
		await command(cancelledFixture.commands, "run").handler("", cancelledHost.ctx);
		expect(cancelled).toEqual([{ approved: false }]);
		expect(cancelledActor).not.toHaveBeenCalled();
	});
});
