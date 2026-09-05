import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { standInFilesLine } from "../src/target/placeholders.js";
import {
	AHDE_BUILDER_COMMAND_NAMES,
	AHDE_BUILDER_COMMANDS,
	PI_BUILTIN_COMMAND_NAMES,
	assertListedCommandName,
	assertRegistrableCommandName,
	builderCommandsOfTier,
	humanizeCommandError,
	registerAhdeBuilderCommands,
	renderBuilderHelp,
	type BuilderCommandTier,
	type RegisterBuilderCommandsOptions,
} from "../src/builder/commands.js";
import { createRunProgressPresenter } from "../src/builder/run-progress.js";
import { setLanguage } from "../src/i18n.js";
import { EvalRunRecordSchema } from "../src/eval.js";
import {
	RunRecordSchema,
	executionFingerprint,
	hashFile,
	hashValue,
	modelFingerprint,
	provenanceAxes,
	provenanceKey,
	type RunRecord,
} from "../src/provenance.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";
import { candidateHeadline } from "../src/workbench/resolution.js";
import { runResultLine } from "../src/application/measurement-line.js";
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
	WorkbenchRunEvalResult,
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
	const summary: WorkbenchCandidateSummary = {
		headline: "",
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
	// The host composes the headline from the same evidence; a fixture that
	// hand-wrote one could let a panel and its headline drift apart in a test.
	return { ...summary, headline: summary.headline || candidateHeadline(summary.development, summary.sealedHoldout) };
}

/** The run-eval result: the traces the operator reads plus the host's own sentence. */
function runResult(): WorkbenchRunEvalResult {
	const traces = tracesDetail();
	return {
		headline: runResultLine({
			pass: traces.evaluation.summary.pass,
			total: traces.evaluation.summary.total,
			failureModes: traces.improvementBrief.summary.failureModeCount,
		}),
		...traces,
	};
}

function tracesDetail(): WorkbenchTracesDetail {
	return {
		evaluation: {
			evalRunId: "erun-current",
			summary: { total: 3, pass: 1, fail: 2, error: 0, allPassRate: 1 / 3 },
			repetitions: 1,
			stableTasks: { stable: 1, measured: 3 },
			finishedAt: "2026-09-01T09:00:07.000Z",
			targetGitSha: "4d533f07030f0a4b1c2d3e4f5a6b7c8d9e0f1a2b",
			corpus: { name: "Ombudsman basket", taskCount: 3 },
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
					signature: { kind: "grader-check", checkCode: "required-tool", subject: "lookup", discriminatorHash: `sha256:${"d".repeat(64)}` },
					facts: "No tool was called in 2 of 2 failing runs.",
					observations: [{ code: "no-tool-call", runs: 2 }],
					observedRuns: 2,
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
					evidence: [{
						runId: "run-development-1",
						taskId: "task-routing",
						traceAvailable: true,
						graderNames: ["tool_called"],
						excerpt: { toolNames: [], reply: "I already know the answer.", observations: ["no-tool-call"] },
					}],
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
					signature: { kind: "outcome-instability", checkCode: null, subject: null, discriminatorHash: `sha256:${"e".repeat(64)}` },
					facts: "1 replies asked the user a question instead of answering.",
					observations: [{ code: "asks-a-question", runs: 1 }],
					observedRuns: 1,
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
					evidence: [{
						runId: "run-development-3",
						taskId: "task-format",
						traceAvailable: true,
						graderNames: ["output_contains"],
						excerpt: { toolNames: ["lookup"], reply: "Done.", observations: [] },
					}],
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
		recommendedExamCases: 15,
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
		prediction: null,
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
			return decision("run-current", { resolvedAs: "run-eval", ...runResult() }, viewAt("improvement-authoring"));
		case "calibrate":
			return decision("calibrate", {
				candidateId: "calibration-1",
				calibration: calibration({ repetitions: input.repetitions }),
			}, viewAt("ready-to-evaluate", { calibration: calibration({ repetitions: input.repetitions }) }));
		case "approve-spec":
			return decision("approve-spec", { approvedSpecId: "spec-1", receiptId: "receipt-approve" }, viewAt("corpus-design"));
		case "generate-holdout":
			return decision("generate-holdout", {
				...(input.mode === "seal" ? { corpusId: `corpus-${"a".repeat(64)}` } : { reviewPath: "/private/state/sealed-synth/review-abc.jsonl" }),
				cases: input.cases,
				source: input.source ?? "spec",
				requested: input.cases,
				dropped: { malformed: 0, duplicate: 0 },
				generator: "openrouter/anthropic/claude-sonnet-4.5",
				promptHash: hash("a"),
			}, viewAt("ready-to-evaluate"));
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
				headline: candidateSummary().headline,
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
				headline: runResult().headline,
				evaluation: runResult(),
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
		importSealedHoldout?: RegisterOptions["importSealedHoldout"];
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
		...(options.importSealedHoldout ? { importSealedHoldout: options.importSealedHoldout } : {}),
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

/** Real harness directories the stand-in scan reads; removed after each test. */
const standInDirs: string[] = [];

afterEach(() => {
	for (const path of standInDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function workbench(options: {
	view?: (query: Parameters<CommandWorkbench["view"]>[0]) => Promise<WorkbenchView>;
	decide?: DecideFake;
	/** Commands that read the harness itself (/doctor's stand-in scan) need a real path. */
	projectDir?: string;
	/** Commands that read durable evidence off disk (/dataset) need real roots. */
	runsRoot?: string;
	stateRoot?: string;
	projectId?: string;
} = {}): {
	value: CommandWorkbench;
	view: ReturnType<typeof vi.fn>;
	decide: ReturnType<typeof vi.fn>;
} {
	const view = vi.fn(options.view ?? (async () => baseView));
	const decide = vi.fn(options.decide ?? (async (input: WorkbenchDecisionInput) => defaultDecision(input)));
	const projectDir = options.projectDir ?? join(tmpdir(), "ahde-commands-no-such-target");
	return {
		value: {
			view,
			decide,
			projectDir,
			runsRoot: options.runsRoot ?? join(projectDir, "runs"),
			stateRoot: options.stateRoot ?? join(projectDir, ".ahde"),
			projectId: options.projectId ?? "demo",
		} as unknown as CommandWorkbench,
		view,
		decide,
	};
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

/**
 * A refusal reaches the operator as a transcript panel, never as Pi's raw
 * `Extension "command:<name>" error: …` with a stack under it. The sentence
 * is the one the handler raised; only its framing changed, so these assert
 * exactly what the operator now reads.
 */
async function expectRefusal(
	commands: Map<string, CommandOptions>,
	name: string,
	args: string,
	ctx: ExtensionCommandContext,
	output: ReturnType<typeof presenterFixture>,
	message: string | RegExp,
): Promise<void> {
	const before = output.blocks.length;
	await command(commands, name).handler(args, ctx);
	// The refusal is the last thing on screen; a handler that drew something
	// before it failed — /fix shows the diagnosis first — keeps what it drew.
	expect(output.blocks.length).toBeGreaterThan(before);
	const panel = output.blocks.at(-1)!;
	expect(panel.title).toBe(`AHDE · /${name}`);
	const text = stripMarkers(panel.lines.join("\n"));
	if (typeof message === "string") expect(text).toContain(message);
	else expect(text).toMatch(message);
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
			// Core: the whole product on one screen, in the order the work
			// happens. Never "export" for the dataset: Pi owns that name (see
			// the built-in guard below).
			"test",
			"fix",
			"ship",
			"status",
			"traces",
			"trace",
			"passport",
			"dataset",
			"help",
			// Expert: the same work one step at a time, plus the inspections.
			"run",
			"plan",
			"review",
			"jobs",
			"stop",
			"target",
			"log",
			"doctor",
			"label",
			"holdout",
			"calibrate",
			"regrade",
			// AHDE's own decisions, in the order it asks them.
			"approve",
			"publish",
			"apply",
			"discard",
			"promote",
			"reject",
			"adopt",
			"next",
		]);
		// The public order is the help order now, so the file's registration
		// order is only where the handlers happen to sit. What may never drift
		// is membership: a command registered off the table, or a table row
		// nobody registers, is a command documented nowhere or dead on arrival.
		expect(registered.map(({ name }) => name).sort()).toEqual([...AHDE_BUILDER_COMMAND_NAMES].sort());
		expect(registered).toHaveLength(29);
		expect(registered.every(({ options }) => options.description && options.handler)).toBe(true);
	});

	it("gives every registered command a tier, and refuses one that has none", () => {
		const registered = register(workbench().value).registered.map(({ name }) => name);
		const tiered = new Map(AHDE_BUILDER_COMMANDS.map((command) => [command.name, command.tier]));
		expect(registered.filter((name) => !tiered.has(name))).toEqual([]);
		// Nine the product is made of, twelve shortcuts, eight decisions AHDE
		// asks itself — 29 registrations, and `/help` shows nine of them.
		const count = (tier: BuilderCommandTier): number => builderCommandsOfTier(tier).length;
		expect([count("core"), count("expert"), count("host-decision")]).toEqual([9, 12, 8]);
		expect(() => assertListedCommandName("traces")).not.toThrow();
		expect(() => assertListedCommandName("summarise")).toThrow(
			/^\/summarise is registered without a row in AHDE_BUILDER_COMMANDS, so \/help cannot place it\./,
		);
	});

	/**
	 * Session 7's blocking defect, as an invariant.
	 *
	 * `/export` collided with Pi's own built-in, so the host answered it first
	 * and — because AHDE's `allowedBuiltinCommands` does not admit `export` —
	 * answered `Warning: /export is disabled by this host.` The only notice was
	 * an English `[Extension issues]` block printed once, forty minutes earlier.
	 */
	describe("a registered command may not shadow a Pi built-in", () => {
		it("registers nothing whose name Pi already owns", () => {
			const registered = register(workbench().value).registered.map(({ name }) => name);
			const collisions = registered.filter((name) => PI_BUILTIN_COMMAND_NAMES.has(name));
			expect(collisions).toEqual([]);
			// The public list and what is actually registered are the same list,
			// so neither can drift into a built-in behind the other's back.
			expect([...AHDE_BUILDER_COMMAND_NAMES].filter((name) => PI_BUILTIN_COMMAND_NAMES.has(name))).toEqual([]);
		});

		it("refuses a colliding name outright, naming the command and what to do instead", () => {
			// The guard the shared registration wrapper calls for every command,
			// so this is the code path the real registration takes.
			expect(() => assertRegistrableCommandName("export")).toThrow(
				/^\/export is one of Pi's own built-in commands, so the host would answer it before this extension ever saw it\./,
			);
			expect(() => assertRegistrableCommandName("model")).toThrow(/preferredExtensionCommands/);
			// A name Pi does not own is nobody's business but AHDE's.
			expect(() => assertRegistrableCommandName("dataset")).not.toThrow();
			expect(() => assertRegistrableCommandName("traces")).not.toThrow();
			// `/help` reads like an override and is not one: Pi has no built-in
			// `/help`, which is exactly why session 7 saw no warning for it while
			// `/export` got one.
			expect(PI_BUILTIN_COMMAND_NAMES.has("help")).toBe(false);
			expect(() => assertRegistrableCommandName("help")).not.toThrow();
		});

		/**
		 * The pinned set is a copy, because Pi's `exports` map does not publish
		 * `core/slash-commands.js`. A copy that nobody checks is how the next
		 * collision arrives silently, so this reads the real file of the pinned
		 * runtime and fails the day a Pi bump adds or drops a built-in.
		 */
		it("matches the built-in list of the pinned Pi, name for name", () => {
			const source = readFileSync(
				new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js", import.meta.url),
				"utf8",
			);
			const names = [...source.matchAll(/\{\s*name:\s*"([a-z-]+)"/g)].map((match) => match[1] as string);
			expect(names.length).toBeGreaterThan(15);
			expect([...names].sort()).toEqual([...PI_BUILTIN_COMMAND_NAMES].sort());
		});
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
		// The panel already carries `AHDE · Ready to run` as its title; the body
		// under it used to say the same words again, one line lower.
		expect(text).not.toContain("AHDE · Ready to run");
		expect(text).toContain("Target target-demo @ aaaaaaaaaa · anthropic/claude-sonnet-4 ✓");
		expect(text).toContain("Next Describe what the agent still needs built, or say “tests” to run them");
		expect(text).toContain("Target not created yet");
		// The way out of an empty folder is the conversation, not a second command.
		expect(text).toContain("the Builder creates it right here");
		expect(text).not.toContain("ahde init .");
		expect(text).not.toContain("schemaVersion");
		expect(text).not.toContain("{");
		expect(host.notify).not.toHaveBeenCalled();
		expect(host.select).not.toHaveBeenCalled();
		expect(fixture.decide).not.toHaveBeenCalled();

		await expectRefusal(commands, "target", "two paths", host.ctx, output, "/target takes at most one");
		expect(fixture.view).toHaveBeenCalledTimes(5);
	});

	/** Every `/name` the screen names, in the order it names them. */
	function slashNames(text: string): string[] {
		return [...new Set([...text.matchAll(/\/([a-z][a-z-]*)/g)].map((match) => match[1] as string))];
	}

	it("shows the nine commands the product is made of for /help, and nothing else", async () => {
		const fixture = workbench();
		const { commands, output } = register(fixture.value);

		await command(commands, "help").handler("", context().ctx);

		expect(fixture.view).not.toHaveBeenCalled();
		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([["AHDE Builder help", "info"]]);
		const text = output.text();
		// Exactly the core tier, in the order the work happens, and the last
		// line is the way to the rest.
		expect(slashNames(text)).toEqual(builderCommandsOfTier("core").map((entry) => entry.name));
		expect(text.trimEnd().split("\n").filter((line) => line.startsWith("  /"))).toHaveLength(9);
		expect(text).toContain("/help all    every command, shortcuts included");
		// Session 8's screen taught the machine: thirty-one commands over
		// forty-five lines, eight of them decisions AHDE asks itself and the
		// Builder is forbidden to name. None of those eight is here.
		for (const decision of builderCommandsOfTier("host-decision")) {
			expect(text).not.toContain(`/${decision.name}`);
		}
		for (const shortcut of builderCommandsOfTier("expert")) {
			expect(text).not.toContain(`/${shortcut.name}`);
		}
		expect(text).toContain("Talk normally");
		expect(text).toContain("Every consequential step shows the exact subject and asks you once: starting");
		expect(text).toContain("Runs and checks just happen");
	});

	it("shows every registered command exactly once for /help all, under a heading that says what it is", async () => {
		const fixture = workbench();
		const { commands, output } = register(fixture.value);

		await command(commands, "help").handler("all", context().ctx);

		expect(fixture.view).not.toHaveBeenCalled();
		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([["AHDE Builder · every command", "info"]]);
		const text = output.text();
		const usages = text.split("\n").filter((line) => line.startsWith("  /"));
		expect(usages).toHaveLength(AHDE_BUILDER_COMMANDS.length + 2); // + the two Pi built-ins
		expect(slashNames(usages.join("\n"))).toEqual([...AHDE_BUILDER_COMMAND_NAMES, "login", "model"]);
		expect(text).toContain("Expert shortcuts — the same work, one step at a time:");
		// The eight are listed under what they actually are, so nobody reads
		// them as vocabulary they were supposed to learn.
		expect(text).toContain("AHDE's own decisions — it asks them on screen; typing them is never needed:");
		expect(text.indexOf("/approve")).toBeGreaterThan(text.indexOf("AHDE's own decisions"));
	});

	it("takes nothing but all, and says so before touching the host", async () => {
		const fixture = workbench();
		const { commands, output } = register(fixture.value);
		const host = context();

		await expectRefusal(commands, "help", "everything", host.ctx, output, "/help takes nothing, or the word all");
		expect(host.waitForIdle).not.toHaveBeenCalled();
		expect(fixture.view).not.toHaveBeenCalled();
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
			{ signal: expect.any(AbortSignal), onRunEvent: expect.any(Function) },
		);
		expect(fixture.decide).toHaveBeenNthCalledWith(
			2,
			{ kind: "run-current", repetitions: 3, reason: "Requested interactively via /run" },
			expect.any(Object),
			{ signal: expect.any(AbortSignal), onRunEvent: expect.any(Function) },
		);
		expect(output.blocks.map((block) => block.title)).toEqual(["Run complete", "Run complete"]);

		await expectRefusal(commands, "run", "11 too many", host.ctx, output, "/run takes how many repetitions");
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
			{ signal: expect.any(AbortSignal), onRunEvent: expect.any(Function) },
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
				headline: runResult().headline,
				evaluation: runResult(),
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
		await expectRefusal(second.commands, "ship", "v2", explicitHost.ctx, second.output, "a version looks like 0.2.0");

		// Nothing to ship yet: the command says where the operator actually is.
		const early = workbench({ view: async () => viewAt("improvement-authoring") });
		const third = register(early.value);
		await expectRefusal(third.commands, "ship", "", context().ctx, third.output, /Shipping is not the next step here — Diagnosis/);
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
			"Fix problem 1 (failure-mode-111111111111111111111111): lookup was never called. " +
			"Prepare the change and show me the review.",
		);

		// An out-of-range ordinal is refused instead of guessed.
		await expectRefusal(commands, "fix", "7", host.ctx, output, /There is no problem 7 to fix/);
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
			{ signal: expect.any(AbortSignal), onRunEvent: expect.any(Function) },
		);
		expect(fixture.decide).toHaveBeenNthCalledWith(
			2,
			{ kind: "calibrate", repetitions: 5, reason: "before trusting small deltas" },
			expect.any(Object),
			{ signal: expect.any(AbortSignal), onRunEvent: expect.any(Function) },
		);
		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([
			["Noise calibrated", "success"],
			["Noise calibrated", "success"],
		]);
		const text = output.text();
		expect(text).toContain("Noise calibration A/A inconclusive");
		expect(text).toContain("Recommended 3 repetitions per run to keep noise under 10 points");
		expect(text).not.toContain("{");

		await expectRefusal(commands, "calibrate", "11 too many", host.ctx, output, "/calibrate takes how many repetitions");
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
		// The job segment reports the same measurement in the footer; the live
		// widget stays the only writer of its own key.
		expect(new Set(host.setStatus.mock.calls.map(([key]) => key))).toEqual(new Set(["ahde-run-progress", "ahde-job"]));
		expect(new Set(host.setWidget.mock.calls.map(([key]) => key))).toEqual(new Set(["ahde-run-progress"]));
		expect(host.setStatus).toHaveBeenCalledWith(
			"ahde-run-progress",
			expect.stringMatching(/^AHDE run graded 1\/1 · running 0 █{12} 100% · ✓1 ✗0 · task-routing · graded pass$/),
		);
		expect(host.setStatus).toHaveBeenCalledWith("ahde-run-progress", undefined);
		expect(host.setWidget).toHaveBeenLastCalledWith("ahde-run-progress", undefined);

		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([["Run complete", "success"]]);
		const text = output.text();
		expect(text).toContain("1/3 passed");
		expect(text).toContain("2 failed");
		expect(text).toContain("lookup was never called");
		expect(text).toContain("The same case flips between repetitions");
		expect(text).toContain(`Live trace ${LIVE_URL} · retained for 15 minutes`);
		expect(text).toContain("Next Prepare a change for the first actionable problem");
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

	it("counts the whole job the gate priced, not one eval run of it", () => {
		const setStatus = vi.fn();
		const setWidget = vi.fn();
		const progress = createRunProgressPresenter({ setStatus, setWidget });
		const leg = { total: 90 };
		const statuses = (): string[] => setStatus.mock.calls.map(([, value]) => String(value));

		// A verification runs two arms over the development basket and the sealed
		// exam; each eval run only knows its own 90.
		progress.plan(372);
		progress.onRunEvent(runEvent({ type: "run_started" }, { ...leg, runId: "run-a", ordinal: 1 }));
		expect(statuses().at(-1)).toContain("AHDE run graded 0/372 · running 1");
		progress.onRunEvent(runEvent(
			{ type: "run_graded", outcome: "pass", passedGraders: 1, totalGraders: 1 },
			{ ...leg, runId: "run-a", ordinal: 1 },
		));
		expect(statuses().at(-1)).toContain("AHDE run graded 1/372 · running 0");
		// A later, smaller estimate never shrinks a job that already ran past it.
		progress.plan(90);
		expect(statuses().at(-1)).toContain("/372");
		progress.dispose();
	});

	it("never prints a denominator smaller than what it has already graded", () => {
		const setStatus = vi.fn();
		const setWidget = vi.fn();
		const progress = createRunProgressPresenter({ setStatus, setWidget });
		const statuses = (): string[] => setStatus.mock.calls.map(([, value]) => String(value));

		// No estimate reached the presenter, and the job outlives one eval run:
		// the bar tracks what happened instead of claiming 200%.
		for (let index = 0; index < 3; index += 1) {
			progress.onRunEvent(runEvent(
				{ type: "run_graded", outcome: "fail", passedGraders: 0, totalGraders: 1 },
				{ total: 2, runId: `run-${index}`, ordinal: index + 1 },
			));
		}
		expect(statuses().at(-1)).toContain("AHDE run graded 3/3");
		expect(statuses().at(-1)).toContain("100%");
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

		await expectRefusal(commands, "run", "", host.ctx, output, message);
		expect(host.setStatus).toHaveBeenCalledWith("ahde-run-progress", undefined);
		expect(host.setWidget).toHaveBeenLastCalledWith("ahde-run-progress", undefined);
		expect(host.notify).toHaveBeenCalledTimes(1);
		expect(host.notify).toHaveBeenCalledWith(
			expect.stringContaining("Live trace retained for 15 minutes: http://127.0.0.1:43123/live/"),
			"info",
		);
		expect(JSON.stringify(host.notify.mock.calls)).not.toContain(message);
		expect(finish).toHaveBeenCalledWith(abort ? "aborted" : "error");
		// The refusal panel is the only thing drawn; no decision summary.
		expect(output.show).toHaveBeenCalledTimes(1);
		expect(output.note).not.toHaveBeenCalled();
		expect(onWorkbenchChanged).not.toHaveBeenCalled();
	});

	it("routes /apply to apply-proposal and names the branch itself when it is omitted", async () => {
		const fixture = workbench();
		const { commands, output, onWorkbenchChanged } = register(fixture.value);
		const host = context();

		await command(commands, "apply").handler("candidate/routing verify the fix", host.ctx);

		expect(fixture.decide).toHaveBeenCalledWith(
			{ kind: "apply-proposal", branch: "candidate/routing", verify: { repetitions: 3 }, reason: "verify the fix" },
			expect.objectContaining({ confirm: expect.any(Function), selectSealed: expect.any(Function) }),
			expect.objectContaining({ signal: expect.any(AbortSignal), onRunEvent: expect.any(Function) }),
		);
		expect(host.input).not.toHaveBeenCalled();
		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([["Proposal applied", "success"]]);
		expect(output.text()).toContain("Proposal applied branch candidate/routing");
		expect(output.text()).toContain("Your checkout was not switched");
		expect(output.note).toHaveBeenCalledWith(
			expect.stringContaining("Operator ran /apply"),
			expect.objectContaining({ label: expect.stringContaining("/apply") }),
		);
		expect(String(output.note.mock.calls[0]?.[0])).toContain("candidate-verification (Candidate verification)");
		expect(onWorkbenchChanged).toHaveBeenCalledTimes(1);

		await expectRefusal(commands, "apply", "-invalid", host.ctx, output, "a branch name may hold only");
		expect(fixture.decide).toHaveBeenCalledTimes(1);

		// Without a branch the proposal id names the candidate branch; nothing is asked.
		const implicit = context();
		await command(commands, "apply").handler("", implicit.ctx);
		expect(implicit.input).not.toHaveBeenCalled();
		expect(fixture.decide).toHaveBeenLastCalledWith(
			{ kind: "apply-proposal", branch: "candidate/next", verify: { repetitions: 3 }, reason: "Requested interactively via /apply" },
			expect.any(Object),
			expect.objectContaining({ signal: expect.any(AbortSignal), onRunEvent: expect.any(Function) }),
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
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(recovery.output.blocks.map((block) => [block.title, block.tone])).toEqual([["Candidate attempt abandoned", "info"]]);
		expect(recovery.output.text()).toContain("Interrupted candidate abandoned candidate-stopped · stopped at validated");
		expect(recovery.output.text()).toContain("The applied proposal can be verified again whenever you ask to check it.");
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
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(host.confirm).toHaveBeenCalledTimes(1);
		expect(host.confirm).toHaveBeenCalledWith(
			"Promote candidate as v1.2.0",
			expect.stringMatching(/records your review \(recommend promote\)[\s\S]*as v1\.2\.0[\s\S]*Reason Requested interactively via \/promote[\s\S]*Exact subject sha256:/),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(actorId).toHaveBeenCalled();
		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([["Candidate promoted", "success"]]);
		expect(output.text()).toContain("Candidate promoted v1.2.0");
		expect(output.text()).toContain("The active agent is unchanged until you ask to adopt it.");
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
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(output.blocks.map((block) => block.title)).toEqual(["Candidate promoted"]);

		const prompted = context({ confirm: async () => true, input: async () => "0.3.0" });
		await command(commands, "promote").handler("", prompted.ctx);
		expect(prompted.input).toHaveBeenCalledWith("Version to tag (semver, e.g. 0.2.0)", "0.1.0");
		expect(fixture.decide).toHaveBeenLastCalledWith(
			{ kind: "promote-candidate", version: "0.3.0", reason: "Requested interactively via /promote" },
			expect.any(Object),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);

		const cancelled = context({ confirm: async () => true, input: async () => undefined });
		await command(commands, "promote").handler("", cancelled.ctx);
		expect(fixture.decide).toHaveBeenCalledTimes(2);
		expect(cancelled.confirm).not.toHaveBeenCalled();

		await expectRefusal(commands, "promote", "v1", host.ctx, output, "a version looks like 0.2.0");
		const malformed = context({ confirm: async () => true, input: async () => "banana" });
		await expectRefusal(commands, "promote", "", malformed.ctx, output, "a version looks like 0.2.0");
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

		await expectRefusal(commands, name, args, host.ctx, output, `/${name} is not available during ${label}`);
		expect(fixture.decide).not.toHaveBeenCalled();
		expect(host.confirm).not.toHaveBeenCalled();
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
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(reviewingFixture.output.blocks.map((block) => [block.title, block.tone])).toEqual([["Candidate rejected", "warning"]]);
		expect(reviewingFixture.output.text()).toContain("Candidate rejected cand-1 · rejected");
		expect(reviewingFixture.output.note).toHaveBeenCalledWith(
			expect.stringContaining("Operator ran /reject"),
			expect.objectContaining({ label: expect.stringContaining("/reject") }),
		);
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
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
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
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([[title, tone]]);
		expect(output.text()).toContain("Next ");
		expect(output.text()).not.toMatch(/[{}]|schemaVersion/);
		expect(output.note).toHaveBeenCalledWith(
			expect.stringContaining(`Operator ran /${name}`),
			expect.objectContaining({ label: expect.stringContaining(`/${name}`) }),
		);
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

		expect(host.select).toHaveBeenCalledWith("Proposal review", ["Apply to a candidate branch", "Discard", "Just looking"], { signal: undefined });
		// The branch is named after the proposal; the diff was just rendered, so nothing else is asked.
		expect(host.input).not.toHaveBeenCalled();
		expect(fixture.decide).toHaveBeenCalledWith(
			{ kind: "apply-proposal", branch: "candidate/builder-proposal-1", verify: { repetitions: 3 }, reason: "from the /review menu", runId: "builder-proposal-1" },
			expect.any(Object),
			expect.objectContaining({ signal: expect.any(AbortSignal), onRunEvent: expect.any(Function) }),
		);
		expect(output.blocks.map((block) => block.title)).toEqual(["AHDE · Proposal review", "Proposal applied"]);
		const review = output.blocks[0]?.lines.map(stripMarkers).join("\n") ?? "";
		expect(review).toContain("Proposal builder-proposal-1");
		expect(review).toContain("Route lookups through the evidence tool before answering.");
		expect(review).toContain("Changes AGENTS.md (+1 -0)");
		expect(review).toContain("Evidence eval erun-current · 1 failure mode targeted · 1 run reference");
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
			{ kind: "discard-proposal", reason: "from the /review menu" },
			expect.any(Object),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
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
		{ stage: "spec-review", title: "Spec draft", choice: "Approve this Spec", input: { kind: "approve-spec", reason: "from the /review menu" }, receipt: "Spec approved" },
		{ stage: "corpus-review", title: "Eval basket draft", choice: "Publish this basket", input: { kind: "publish-corpus", reason: "from the /review menu" }, receipt: "Eval basket published" },
		{ stage: "candidate-adoption", title: "Candidate promoted", choice: "Adopt as the active Target", input: { kind: "adopt-candidate", reason: "from the /review menu" }, receipt: "Candidate adopted" },
		{ stage: "complete", title: "Cycle complete", choice: "Start the next cycle", input: { kind: "continue-cycle", reason: "from the /review menu" }, receipt: "Next cycle started" },
	];

	it.each(reviewCases)("offers “$choice” from /review at $stage", async ({ stage, title, choice, input, receipt }) => {
		const fixture = workbench({ view: async () => viewAt(stage) });
		const { commands, output } = register(fixture.value);
		const host = context({ select: async () => choice });

		await command(commands, "review").handler("", host.ctx);

		expect(host.select).toHaveBeenCalledWith(title, expect.arrayContaining([choice, "Just looking"]), { signal: undefined });
		expect(host.select.mock.calls[0]?.[1].at(-1)).toBe("Just looking");
		expect(fixture.decide).toHaveBeenCalledWith(input, expect.any(Object), expect.objectContaining({ signal: expect.any(AbortSignal) }));
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
			{ kind: "abandon-candidate", candidateId: "candidate-stopped", reason: "from the /review menu" },
			expect.any(Object),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(recovery.output.blocks.map((block) => block.title)).toEqual(["AHDE · Interrupted candidate", "Candidate attempt abandoned"]);
		expect(recovery.output.text()).toContain("Verification stopped before evidence was complete.");

		const verifying = workbench({
			view: async () => viewAt("candidate-verification"),
			decide: async () => decision("run-current", {
				resolvedAs: "verify-candidate",
				outcome: "verified" as const,
				headline: candidateSummary().headline,
				screen: null,
				candidate: candidateSummary(),
				development: { verdict: "improved", scoreDelta: 2 / 3, confidence95: { low: 0.1, high: 0.9 } },
				sealedHoldout: { executed: true, gatePassed: true, verdict: "pass" },
			}, viewAt("candidate-review")),
		});
		const verification = register(verifying.value);
		const verificationHost = context({ select: async () => "Verify the candidate now (/run)" });
		await command(verification.commands, "review").handler("", verificationHost.ctx);
		expect(verifying.decide).toHaveBeenCalledWith(
			{ kind: "run-current", repetitions: 3, reason: "from the /review menu" },
			expect.any(Object),
			{ signal: expect.any(AbortSignal), onRunEvent: expect.any(Function) },
		);
		expect(verification.output.blocks.map((block) => [block.title, block.tone])).toEqual([
			["AHDE · Candidate verification", "info"],
			["Candidate verified", "success"],
		]);
		expect(verification.output.text()).toContain("Development pass rate 33% → 100% (+66.7 pts, 95% CI +10 … +90) on 3 cases");
		expect(verification.output.text()).toContain("3 cases is a small basket: read the interval as indicative, not decisive");
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
			{ kind: "ship", version: "1.0.0", reason: "from the /review menu" },
		]);
		expect(promotionHost.confirm).toHaveBeenCalledTimes(1);
		expect(promotion.output.blocks.map((block) => block.title)).toEqual(["AHDE · Candidate review", "Shipped"]);

		const rejecting = gatedWorkbench("release-decision");
		const rejection = register(rejecting.value);
		const rejectionHost = context({ select: async () => "Reject", confirm: async () => true });
		await command(rejection.commands, "review").handler("", rejectionHost.ctx);
		expect(rejecting.decide.mock.calls.map(([input]) => input)).toEqual([
			{ kind: "reject-candidate", reason: "from the /review menu" },
		]);
		expect(rejection.output.blocks.map((block) => block.title)).toEqual(["AHDE · Release decision", "Candidate rejected"]);
	});

	it("renders the diagnosis for /traces and offers to fix one selectable failure mode", async () => {
		const tracesView = viewAt("improvement-authoring", { detail: { aspect: "traces", content: tracesDetail() } });
		const sendUserMessage = vi.fn();
		const fixture = workbench({ view: async () => tracesView });
		const { commands, output } = register(fixture.value, { sendUserMessage });
		const controller = new AbortController();
		const host = context({ signal: controller.signal, select: async () => "Fix 1: lookup was never called" });

		await command(commands, "traces").handler("", host.ctx);

		expect(fixture.view).toHaveBeenCalledWith({ aspect: "traces" });
		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([["AHDE · Diagnosis", "info"]]);
		const text = output.text();
		expect(text).toContain("Evaluation 1/3 passed");
		expect(text).toContain("Diagnosis actionable · 1/3 passed · 2 failure mode(s), 1 of them across tasks");
		expect(text).toContain("1. lookup was never called — 2 of 3 tasks (reproduces 100%)");
		expect(text).toContain("     No tool was called in 2 of 2 failing runs.");
		// The panel quotes one raw excerpt per mode instead of a template hypothesis.
		expect(text).toContain("run-development-1 · no tool call · “I already know the answer.”");
		expect(text).toContain("→ propose fix");
		expect(text).toContain("2. The same case flips between repetitions — 1 of 3 tasks");
		expect(text).toContain(`Evidence ${EVIDENCE_URL}`);
		expect(text).toContain("Next prepare a change for the first actionable problem");
		expect(text).not.toMatch(/[{}]|schemaVersion/);
		expect(text).not.toContain(FIRST_MODE);

		expect(host.select).toHaveBeenCalledWith(
			"Prepare a change?",
			["Fix 1: lookup was never called", "Not now"],
			{ signal: controller.signal },
		);
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		const message = String(sendUserMessage.mock.calls[0]?.[0]);
		expect(message).toContain(`Fix problem 1 (${FIRST_MODE})`);
		expect(message).toContain("lookup was never called");
		expect(message).toContain("Prepare the change and show me the review.");
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
		const unbridgedHost = context({ select: async () => "Fix 1: lookup was never called" });
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

	it("shows an unexpected Workbench error as one line, and off the TUI still raises it", async () => {
		const original = new Error("disk full\n    while writing the receipt");
		const fixture = workbench({
			decide: async () => {
				throw original;
			},
		});
		const { commands, output, onWorkbenchChanged } = register(fixture.value);
		const host = context();

		// The stack behind it is not the operator's business; the sentence is.
		await expectRefusal(commands, "approve", "", host.ctx, output, "disk full while writing the receipt");
		expect(output.blocks[0]?.tone).toBe("error");
		expect(host.notify).not.toHaveBeenCalled();
		expect(onWorkbenchChanged).not.toHaveBeenCalled();

		// A host with no transcript to draw into is owed the error itself.
		let failure: unknown;
		try {
			await command(commands, "approve").handler("", context({ hasUI: true, mode: "rpc" }).ctx);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe("/approve works only in the Builder window");
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
		const aborting = register(abortedFixture.value);
		const abortedHost = context({
			signal: aborted.signal,
			waitForIdle: async () => {
				aborted.abort(new Error("stopped while waiting"));
			},
		});
		await expectRefusal(aborting.commands, "run", "", abortedHost.ctx, aborting.output, "stopped while waiting");
		expect(abortedFixture.decide).not.toHaveBeenCalled();
	});

	/**
	 * Pi renders a thrown command handler as `Extension "command:traces"
	 * error: …` with a stack under it — its own framing, in English, and it
	 * looks like the product crashed. Every AHDE command goes into the
	 * transcript instead, whatever it failed on.
	 */
	it("puts any command failure in the transcript instead of Pi's raw extension error", async () => {
		const fixture = workbench({
			view: async () => {
				throw new WorkbenchSelectionRequiredError("development EvalRun", []);
			},
		});
		const { commands, output } = register(fixture.value);
		const host = context();

		// A host refusal, an argument the operator mistyped, and a plain crash.
		await expectRefusal(commands, "status", "", host.ctx, output, "No compatible development EvalRun is available");
		await expectRefusal(commands, "run", "11", host.ctx, output, "/run takes how many repetitions");
		expect(output.blocks.map((block) => block.title)).toEqual(["AHDE · /status", "AHDE · /run"]);
		expect(output.blocks.map((block) => block.tone)).toEqual(["warning", "error"]);

		// A cancelled dialog is not a failure: it stays a notification, and the
		// guard never turns it into a panel that looks like something broke.
		const cancelling = workbench({
			decide: async () => {
				throw new WorkbenchDecisionDeclinedError("approve-spec");
			},
		});
		const second = register(cancelling.value);
		const cancelled = context();
		await command(second.commands, "approve").handler("", cancelled.ctx);
		expect(second.output.show).not.toHaveBeenCalled();
		expect(cancelled.notify).toHaveBeenCalledWith("Cancelled — nothing changed.", "info");
	});

	it("fails closed for every command outside the local TUI", async () => {
		const fixture = workbench();
		const { commands, output } = register(fixture.value);
		const invocations = AHDE_BUILDER_COMMAND_NAMES.map((name): [string, string] => [
			name,
			name === "apply" ? "candidate/fix" : name === "promote" ? "1.0.0" : "",
		]);
		expect(invocations).toHaveLength(29);

		for (const settings of [
			{ hasUI: false, mode: "print" as const },
			{ hasUI: true, mode: "rpc" as const },
			{ hasUI: true, mode: "json" as const },
			{ hasUI: false, mode: "tui" as const },
		]) {
			const host = context(settings);
			for (const [name, args] of invocations) {
				await expect(command(commands, name).handler(args, host.ctx))
					.rejects.toThrow(`/${name} works only in the Builder window`);
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

	it.each(["doctor", "status", "review"])("rejects arguments to /%s before touching the host", async (name) => {
		const fixture = workbench();
		const { commands, output } = register(fixture.value);
		const host = context();

		await expectRefusal(commands, name, "unexpected", host.ctx, output, `/${name} takes no arguments`);
		expect(host.waitForIdle).not.toHaveBeenCalled();
		expect(fixture.view).not.toHaveBeenCalled();
	});

	it("/traces accepts only a row count, and rejects anything else before touching the host", async () => {
		const fixture = workbench();
		const { commands, output } = register(fixture.value);
		const host = context();

		await expectRefusal(commands, "traces", "unexpected", host.ctx, output, "/traces takes how many rows to show");
		expect(host.waitForIdle).not.toHaveBeenCalled();
		expect(fixture.view).not.toHaveBeenCalled();
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
		expect(text).toContain("· Judge model not configured · not required by the current basket");
		expect(text).toContain("· Simulated-user model not configured · not required by the current basket");
		expect(text).toContain("Stage Ready to run · Describe what the agent still needs built, or say “tests” to run them");
		expect(text).toContain("✓ Ready: everything needed for /run is in place");
		expect(text).not.toMatch(MARKERS);
		expect(text).not.toMatch(/[{}]|schemaVersion/);
	});

	/**
	 * The template ships both evaluator blocks on the built-in placeholder, so
	 * once the schema reads those as no evaluator, /doctor has to say the
	 * required ones are missing rather than showing a model on a dead port.
	 */
	it("names each evaluator the current basket needs and has not got in /doctor", async () => {
		const fixture = workbench({
			view: async () => viewAt("ready-to-evaluate", {
				target: {
					status: "ready",
					id: "target-demo",
					gitSha: SHA_A,
					model: { ...TARGET_MODEL },
					evaluators: { judge: null, simulatedUser: null },
					evaluatorRequirements: { judge: true, simulatedUser: true },
				},
			}),
		});
		const { commands, output } = register(fixture.value);

		await command(commands, "doctor").handler("", context().ctx);

		const text = output.text();
		expect(text).toContain("! Judge model is required by the current basket but not configured");
		expect(text).toContain("! Simulated-user model is required by the current basket but not configured");
		// Not "ready": two of the three models a measurement needs are missing.
		expect(text).toContain("! Action required before the next run");
		// Nothing about a placeholder endpoint reaches the operator.
		expect(text).not.toContain("replace-with-model-id");
		expect(text).not.toContain("127.0.0.1:1234");
	});

	it("reports an unavailable sealed holdout generically in /doctor", async () => {
		const fixture = workbench({
			view: async () => viewAt("ready-to-evaluate", {
				shippingReadiness: { sealedHoldout: "unavailable", minimumTasks: 15, sealedCases: null },
			}),
		});
		const { commands, output } = register(fixture.value);

		await command(commands, "doctor").handler("", context().ctx);

		const text = output.text();
		expect(text).toContain("! Ship gate holdout is unavailable or failed integrity checks — repair private corpus storage or /holdout privately imports a replacement");
		expect(text).not.toMatch(/corpus-[0-9a-f]{64}|sha256:|corpus\.jsonl|PRIVATE/);
	});

	it("does the subtraction for the operator when the exam is too small", async () => {
		const fixture = workbench({
			view: async () => viewAt("ready-to-evaluate", {
				shippingReadiness: { sealedHoldout: "underpowered", minimumTasks: 15, sealedCases: 12 },
			}),
		});
		const { commands, output } = register(fixture.value);

		await command(commands, "doctor").handler("", context().ctx);

		expect(output.text()).toContain(
			"! Ship gate: the exam has 12 cases; the gate needs 15 — 3 more — /holdout privately imports a separate exam",
		);
	});

	it("imports a sealed holdout through host UI without putting its path or identity in the Builder transcript", async () => {
		const fixture = workbench();
		const importSealedHoldout = vi.fn(() => ({ taskCount: 20 }));
		const { commands, output, onWorkbenchChanged } = register(fixture.value, { importSealedHoldout });
		const answers = ["/private/evals/customer-secrets.jsonl", "Private promotion exam"];
		const host = context({
			confirm: async () => true,
			// The first question is where the exam comes from; importing a file is
			// still the first option and still the same flow behind it.
			select: async (_title, choices) => choices[0],
			input: async () => answers.shift(),
		});

		await command(commands, "holdout").handler("", host.ctx);

		expect(importSealedHoldout).toHaveBeenCalledWith({
			sourcePath: "/private/evals/customer-secrets.jsonl",
			name: "Private promotion exam",
		});
		expect(onWorkbenchChanged).toHaveBeenCalledTimes(1);
		expect(output.text()).toContain("20 evaluator-only cases are ready for the ship gate");
		expect(output.text()).not.toContain("customer-secrets");
		expect(output.text()).not.toContain("Private promotion exam");
	});

	it("/holdout <path> imports that file straight away, without the menu or the path prompt", async () => {
		// The host's own next step after a judge-written draft is "/holdout <path>";
		// it used to answer "/holdout takes no arguments".
		const fixture = workbench();
		const importSealedHoldout = vi.fn(() => ({ taskCount: 20 }));
		const { commands, output } = register(fixture.value, { importSealedHoldout });
		const select = vi.fn(async () => undefined);
		const answers = ["Private promotion exam"];
		const host = context({
			confirm: async () => true,
			select,
			input: async () => answers.shift(),
		});

		await command(commands, "holdout").handler("  /private/evals/customer-secrets.jsonl ", host.ctx);

		expect(select).not.toHaveBeenCalled();
		expect(importSealedHoldout).toHaveBeenCalledWith({
			sourcePath: "/private/evals/customer-secrets.jsonl",
			name: "Private promotion exam",
		});
		expect(output.text()).toContain("20 evaluator-only cases are ready for the ship gate");
		expect(output.text()).not.toContain("customer-secrets");
	});

	it("routes /holdout's other two answers into the generate-holdout decision", async () => {
		for (const [choice, mode] of [[1, "seal"], [2, "review"]] as const) {
			const fixture = workbench();
			const importSealedHoldout = vi.fn(() => ({ taskCount: 20 }));
			const { commands, output } = register(fixture.value, { importSealedHoldout });
			const host = context({
				select: async (title, choices) => {
					expect(title).toBe("Where should the sealed exam come from?");
					expect(choices).toEqual(["Import a file", "Generate with the judge", "Generate a draft to review"]);
					return choices[choice];
				},
				input: async (title) => {
					expect(title).toBe("How many cases? (minimum 15)");
					return "24";
				},
			});

			await command(commands, "holdout").handler("", host.ctx);

			// The file import is untouched on these two paths: the exam is written,
			// not read off the operator's disk.
			expect(importSealedHoldout).not.toHaveBeenCalled();
			expect(fixture.decide).toHaveBeenCalledTimes(1);
			expect(fixture.decide.mock.calls[0]?.[0]).toMatchObject({ kind: "generate-holdout", cases: 24, mode });
			const text = output.text();
			expect(text).toContain("24 cases · written by the judge openrouter/anthropic/claude-sonnet-4.5");
			expect(text).toContain(mode === "seal" ? "Exam created" : "Exam draft ready");
		}
	});

	it("reads «из базы знаний» as a request to write the exam from the documents", async () => {
		for (const [args, expected] of [
			["20 из базы знаний", { cases: 20, mode: "seal" }],
			["из базы знаний", { cases: 20, mode: "seal" }],
			["--from-kb 24", { cases: 24, mode: "seal" }],
			["16 по базе знаний черновик", { cases: 16, mode: "review" }],
			["30 from the knowledge base", { cases: 30, mode: "seal" }],
		] as const) {
			const fixture = workbench();
			const importSealedHoldout = vi.fn(() => ({ taskCount: 20 }));
			const { commands, output } = register(fixture.value, { importSealedHoldout });
			const select = vi.fn(async () => undefined);
			const host = context({ select, input: async () => undefined });

			await command(commands, "holdout").handler(args, host.ctx);

			// No menu, no path prompt, and the file import stays untouched: the
			// phrase already said which of the three answers this is.
			expect(select).not.toHaveBeenCalled();
			expect(importSealedHoldout).not.toHaveBeenCalled();
			expect(fixture.decide).toHaveBeenCalledTimes(1);
			expect(fixture.decide.mock.calls[0]?.[0]).toMatchObject({
				kind: "generate-holdout",
				source: "kb",
				...expected,
			});
			expect(output.text()).toContain("from the knowledge base");
		}
	});

	it("still treats a path as a path, even one with kb in its name", async () => {
		const fixture = workbench();
		const importSealedHoldout = vi.fn(() => ({ taskCount: 20 }));
		const { commands } = register(fixture.value, { importSealedHoldout });
		const answers = ["Private promotion exam"];
		const host = context({
			confirm: async () => true,
			select: vi.fn(async () => undefined),
			input: async () => answers.shift(),
		});

		await command(commands, "holdout").handler("/private/evals/kb-holdout.jsonl", host.ctx);

		expect(fixture.decide).not.toHaveBeenCalled();
		expect(importSealedHoldout).toHaveBeenCalledWith({
			sourcePath: "/private/evals/kb-holdout.jsonl",
			name: "Private promotion exam",
		});
	});

	it("refuses a case count that is not a number, before asking the Workbench anything", async () => {
		const fixture = workbench();
		const { commands, output } = register(fixture.value, { importSealedHoldout: vi.fn(() => ({ taskCount: 20 })) });
		const host = context({
			select: async (_title, choices) => choices[1],
			input: async () => "twenty",
		});

		await expectRefusal(commands, "holdout", "", host.ctx, output, /whole number/);
		expect(fixture.decide).not.toHaveBeenCalled();
	});

	it("includes evaluator credential readiness and refuses ready when a configured evaluator key is missing", async () => {
		const fixture = workbench({
			view: async () => viewAt("ready-to-evaluate", {
				target: {
					...baseView.target,
					evaluators: {
						judge: { provider: "anthropic", id: "claude-judge", apiKeyEnv: "JUDGE_API_KEY", credentialPresent: false },
						simulatedUser: { provider: "openai", id: "gpt-user", apiKeyEnv: "USER_API_KEY", credentialPresent: true },
					},
				},
			}),
		});
		const { commands, output } = register(fixture.value);

		await command(commands, "doctor").handler("", context().ctx);

		expect(output.blocks.map((block) => [block.title, block.tone])).toEqual([["AHDE Doctor", "warning"]]);
		const text = output.text();
		expect(text).toContain("! Judge model anthropic/claude-judge · export JUDGE_API_KEY in the shell that runs ahde before /run");
		expect(text).toContain("✓ Simulated-user model openai/gpt-user · USER_API_KEY is set");
		expect(text).toContain("! Action required before the next run");
		expect(text).not.toContain("Ready: everything needed");
	});

	it("reports an unused evaluator's missing key without blocking the current basket", async () => {
		const fixture = workbench({
			view: async () => viewAt("ready-to-evaluate", {
				target: {
					...baseView.target,
					evaluatorRequirements: { judge: false, simulatedUser: false },
					evaluators: {
						judge: { provider: "anthropic", id: "claude-judge", apiKeyEnv: "JUDGE_API_KEY", credentialPresent: false },
						simulatedUser: null,
					},
				},
			}),
		});
		const { commands, output } = register(fixture.value);

		await command(commands, "doctor").handler("", context().ctx);

		expect(output.blocks[0]?.tone).toBe("success");
		expect(output.text()).toContain("· Judge model anthropic/claude-judge · JUDGE_API_KEY is missing, but this basket does not use it");
		expect(output.text()).toContain("✓ Ready: everything needed for /run is in place");
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

	it("says the template stand-in line once in /doctor, as a readiness line and not again as a warning", async () => {
		const targetDir = mkdtempSync(join(tmpdir(), "ahde-doctor-stand-ins-"));
		standInDirs.push(targetDir);
		mkdirSync(join(targetDir, "evals"), { recursive: true });
		writeFileSync(join(targetDir, "AGENTS.md"), "# Agent\n<REPLACE-ME: what this agent does>\n", "utf8");
		writeFileSync(join(targetDir, "evals", "development.jsonl"), '{"id":"task_001","input":"REPLACE-ME"}\n', "utf8");
		const line = standInFilesLine(targetDir);
		expect(line).toContain("AGENTS.md, evals/development.jsonl");

		// The Workbench carries the same sentence in `warnings` for the Builder to
		// read; /doctor states it itself, so printing both would read as two problems.
		const fixture = workbench({
			projectDir: targetDir,
			view: async () => viewAt("ready-to-evaluate", { warnings: [line as string, "Sealed holdout has only 2 cases"] }),
		});
		const { commands, output } = register(fixture.value);

		await command(commands, "doctor").handler("", context().ctx);

		const text = output.text();
		expect(text).toContain(`! ${line}`);
		expect(text.split(line as string)).toHaveLength(2);
		expect(text).toContain("· Sealed holdout has only 2 cases");
	});

	it("says nothing about stand-ins for a harness that has none", async () => {
		const fixture = workbench();
		const { commands, output } = register(fixture.value);

		await command(commands, "doctor").handler("", context().ctx);

		expect(output.text()).not.toContain("REPLACE-ME");
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
		expect(message).toContain("Next Describe what the agent still needs built, or say “tests” to run them");
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
		// The panel, then the one dim line naming what was put into the Builder's head.
		expect(appendEntry).toHaveBeenCalledTimes(2);
		expect(appendEntry).toHaveBeenNthCalledWith(
			1,
			AHDE_TRANSCRIPT_ENTRY_TYPE,
			expect.objectContaining({ schemaVersion: 1, title: "Spec approved", tone: "success", lines: expect.any(Array) }),
		);
		const lines = (appendEntry.mock.calls[0]?.[1] as { lines: string[] }).lines;
		expect(lines.map(stripMarkers).join("\n")).toContain("Spec approved spec-1");
		const injection = (appendEntry.mock.calls[1]?.[1] as { title: string; lines: string[] });
		expect(injection.title).toBe("");
		expect(injection.lines.map(stripMarkers).join("\n")).toBe("✎ Builder received: the result of /approve (approve-spec completed)");
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
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
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
			expect.objectContaining({ signal: expect.any(AbortSignal), onRunEvent: expect.any(Function) }),
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
			// The measurement runs under the job's own signal, so /stop dismisses
			// this picker exactly as it cancels the run behind it.
			{ signal: expect.any(AbortSignal) },
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

/**
 * The recorded dataset, from inside the Builder. The application function is
 * the one `ahde export` calls, so this pins only what the command owns: the
 * argument it accepts, and the one Russian line the operator reads.
 */
describe("/dataset", () => {
	const SHA = "a".repeat(40);
	const TRACE = [
		JSON.stringify({ type: "message", message: { role: "user", content: "Проверь договор 42." } }),
		JSON.stringify({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "Договор 42 действует." }] },
		}),
	].join("\n");

	/** One Target directory with one exportable eval run under its own runs/. */
	function targetWithEvidence(runCount = 2): string {
		const projectDir = mkdtempSync(join(tmpdir(), "ahde-export-command-"));
		standInDirs.push(projectDir);
		const runsRoot = join(projectDir, "runs");
		const evaluation = {
			suiteId: "suite",
			suiteHash: `sha256:${"d".repeat(64)}`,
			dataset: "development",
			datasetHash: `sha256:${"e".repeat(64)}`,
		};
		const target = { id: "demo", gitSha: SHA, workspaceHash: `sha256:${"9".repeat(64)}` };
		const runtime = {
			piVersion: "0.84.3",
			piSha: "b".repeat(40),
			ahdeVersion: "0.1.0",
			ahdeCodeHash: `sha256:${"c".repeat(64)}`,
		};
		const model = modelFingerprint({
			provider: "local",
			id: "qwen3.5-27b",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:9901/v1",
			apiKeyEnv: "TEST_MODEL_KEY",
			thinkingLevel: "off",
			params: {},
			spec: {},
		});
		const execution = executionFingerprint("isolated");
		const records = Array.from({ length: runCount }, (_, index): RunRecord => {
			const runId = `run_export_${index}`;
			const runDir = join(runsRoot, runId);
			const workspace = join(runDir, "workspace");
			mkdirSync(workspace, { recursive: true });
			writeFileSync(join(runDir, "session.jsonl"), `${TRACE}\n`);
			writeFileSync(join(workspace, "manifest.yaml"), "id: demo\ninstructions:\n  agentsMd: AGENTS.md\n");
			writeFileSync(join(workspace, "AGENTS.md"), "# Demo\n");
			const record: RunRecord = {
				schemaVersion: 1,
				runId,
				taskId: `task_${index}`,
				repetitionIndex: 0,
				label: "solo",
				status: "completed",
				error: null,
				startedAt: "2026-08-31T10:00:00.000Z",
				finishedAt: "2026-08-31T10:00:01.000Z",
				target,
				runtime,
				model,
				execution,
				eval: evaluation,
				trace: { path: "session.jsonl", sessionId: runId, sha256: hashFile(`${TRACE}\n`) },
				metrics: {
					tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 },
					costUsd: 0,
					latencyMs: 10,
					toolCalls: 0,
					toolErrors: 0,
					recoveryAttempts: 0,
				},
				evalResults: {
					graders: [{ name: "answer", type: "output_contains", passed: true, score: 1, reason: "ok" }],
					outcome: "pass",
				},
				parent: { evalRunId: "erun_export", candidateOf: null },
			};
			writeJsonArtifact(join(runDir, "run.json"), RunRecordSchema, record);
			return record;
		});
		const evidence = { runtime, model, judge: null, execution, eval: evaluation };
		writeJsonArtifact(join(runsRoot, "erun_export", "eval_run.json"), EvalRunRecordSchema, {
			schemaVersion: 3,
			purpose: "evidence",
			evalRunId: "erun_export",
			target,
			label: "solo",
			baselineEvalRunId: null,
			provenance: provenanceAxes(evidence),
			provenanceKey: provenanceKey(evidence),
			suiteId: evaluation.suiteId,
			suiteHash: evaluation.suiteHash,
			dataset: evaluation.dataset,
			datasetHash: evaluation.datasetHash,
			evidenceVisibility: "development",
			taskIds: records.map((run) => run.taskId),
			repetitions: 1,
			runIds: records.map((run) => run.runId),
			runArtifacts: records.map((run) => ({ runId: run.runId, sha256: hashValue(run) })),
			startedAt: "2026-08-31T10:00:00.000Z",
			finishedAt: "2026-08-31T10:00:02.000Z",
			summary: { total: records.length, pass: records.length, fail: 0, error: 0, allPassRate: 1 },
		});
		return projectDir;
	}

	afterEach(() => {
		setLanguage(null);
	});

	it("writes the last test run's conversations beside the agent and says so in one line", async () => {
		setLanguage("ru");
		const projectDir = targetWithEvidence();
		const fixture = workbench({ projectDir });
		const { commands, output } = register(fixture.value);
		const host = context();

		await command(commands, "dataset").handler("", host.ctx);

		expect(output.blocks).toHaveLength(1);
		expect(output.blocks[0]?.title).toBe("AHDE · Записанные диалоги");
		expect(output.blocks[0]?.lines).toEqual([
			"выгружено 2 из 2 диалогов → exports/erun_export.jsonl",
		]);
		// The file is real, and every line of it is one conversation.
		const written = readFileSync(join(projectDir, "exports", "erun_export.jsonl"), "utf8");
		expect(written.trimEnd().split("\n")).toHaveLength(2);
		expect(written).toContain("Договор 42 действует.");
		// Nothing ran and nothing was decided: this is a read.
		expect(fixture.decide).not.toHaveBeenCalled();
	});

	it("bends the noun to the count, the way every other Russian line does", async () => {
		setLanguage("ru");
		const fixture = workbench({ projectDir: targetWithEvidence(1) });
		const { commands, output } = register(fixture.value);
		await command(commands, "dataset").handler("--all", context().ctx);
		expect(output.blocks[0]?.lines[0]).toMatch(/^выгружено 1 из 1 диалога → exports\/all-.*\.jsonl$/);
	});

	it("says plainly that there is nothing recorded yet, and refuses an argument it does not know", async () => {
		setLanguage("ru");
		const empty = mkdtempSync(join(tmpdir(), "ahde-export-empty-"));
		standInDirs.push(empty);
		const fixture = workbench({ projectDir: empty });
		const { commands, output } = register(fixture.value);

		await command(commands, "dataset").handler("", context().ctx);
		expect(output.blocks[0]?.lines).toEqual(["выгружать пока нечего — сначала прогони тесты"]);

		await expectRefusal(
			commands,
			"dataset",
			"--everything",
			context().ctx,
			output,
			"/dataset принимает --all или ничего — тогда это последний прогон",
		);
	});
});
