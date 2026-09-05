import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { compileAgentLog } from "../application/agent-log.js";
import { failureModeReading } from "../application/run-explanation.js";
import { SEALED_GATE_POLICY } from "../domain/comparison-gate.js";
import { collectEvalPage, collectRunDetailPage, EvidenceNotFound } from "../evidence/model.js";
import type { EvalPageModel, RunDetailPageModel } from "../evidence/pages.js";
import { hasMessage, t, type MessageKey, type MessageParams } from "../i18n.js";
import { standInFilesLine } from "../target/placeholders.js";
import { readFinalWorldState } from "../target/world-state.js";
import { DEFAULT_REPETITIONS } from "../workbench/calibration.js";
import {
	typedRefusalReason,
	WorkbenchDecisionDeclinedError,
	WorkbenchSelectionRequiredError,
	WorkbenchStaleDecisionError,
} from "../workbench/errors.js";
import type {
	WorkbenchDecisionInput,
	WorkbenchDecisionResult,
	WorkbenchTracesDetail,
	WorkbenchView
} from "../workbench/types.js";
import type { AhdeWorkbench } from "../workbench/workbench.js";
import { builderDecisionPresentation } from "./decision-presentation.js";
import { choose, confirmChoice, type DialogChoice } from "./dialog.js";
import { executeBuilderDecision } from "./execution.js";
import { createBuilderHostActions, type BuilderHostActions } from "./host-actions.js";
import { createBuilderJobs, type BuilderJobs } from "./jobs.js";
import {
	MAX_LABEL_SAMPLE
} from "./label-session.js";
import { renderAgentLog } from "./render/agent-log.js";
import { examShortfall, oneLine, pluralize } from "./render/format.js";
import { compilePlan, renderPlan, type PlanFacts } from "./render/plan.js";
import { nextStep, stageLabel } from "./render/stage.js";
import {
	DEFAULT_TRACE_TABLE_ROWS,
	MAX_TRACE_TABLE_ROWS,
	renderRunsTable,
	renderTracePanel,
	traceNoteForModel,
	type TraceWorld,
} from "./render/trace.js";
import { blockerLines, renderReview, renderStatus, renderTarget, renderTraces, viewTitle } from "./render/view.js";
import {
	type BeginBuilderLiveTrace
} from "./run-observation.js";
import type { BuilderSpendReader } from "./spend.js";
import {
	createTranscriptPresenter,
	markerPaint,
	type TranscriptPresenter,
	type TranscriptTone,
} from "./transcript.js";
import { createPolicyAwareGate } from "./workbench-adapter.js";
import { formatWorkbenchConfirmation } from "./workbench-gate.js";

type CommandWorkbench = Pick<
	AhdeWorkbench,
	"view" | "decide" | "projectDir" | "stateRoot" | "runsRoot" | "projectId"
>;

/**
 * Which screen a slash command belongs on.
 *
 * `core` is the product: the eight things an operator does — the three verbs,
 * the two ways to see what actually happened, the two deliverables, and the
 * way back to this list. Nothing else appears on `/help`.
 *
 * `expert` is the same work taken one step at a time, or an inspection someone
 * who already knows the loop reaches for. It is registered, it works, and it
 * is one `/help all` away.
 *
 * `host-decision` is the eight decisions AHDE itself puts on screen with the
 * exact subject and a single yes/no. They stay registered because a decision
 * the host offers has to be answerable from the keyboard too, and because
 * nothing here is removed until a real order runs end to end — but they are
 * never vocabulary the operator is taught: the Builder's persona is forbidden
 * from naming them at all, so `/help` must not teach them either.
 */
export type BuilderCommandTier = "core" | "expert" | "host-decision";

/** One row of the command table: what it is called, where it shows, what it says. */
export interface BuilderCommandListing {
	readonly name: string;
	readonly tier: BuilderCommandTier;
	/**
	 * Exactly what to type. The example argument is part of it — `/fix 2` reads
	 * as a sentence where `/fix [n]` reads as a manual — and it is machinery,
	 * not language: a command name and a digit bend in no language.
	 */
	readonly usage: string;
	/** The one line `/help` prints beside it. */
	readonly help: MessageKey;
	/** Constants that line interpolates; a number is not language either. */
	readonly helpParams?: MessageParams;
}

/**
 * Every Builder command, in the order the operator meets it.
 *
 * This is the one table: registration reads it (a command absent from it does
 * not register at all), `/help` renders it, and the CLI tour and the README
 * list it. Twenty-nine commands with one job each, of which nine are the
 * product and twenty are shortcuts and host decisions.
 */
export const AHDE_BUILDER_COMMANDS: readonly BuilderCommandListing[] = [
	// The whole product, in the order the work happens; `/help all` closes it.
	{ name: "test", tier: "core", usage: "/test", help: "help.cmd.test" },
	{ name: "fix", tier: "core", usage: "/fix 2", help: "help.cmd.fix" },
	{ name: "ship", tier: "core", usage: "/ship 0.1.0", help: "help.cmd.ship" },
	{ name: "status", tier: "core", usage: "/status", help: "help.cmd.status" },
	{ name: "traces", tier: "core", usage: "/traces", help: "help.cmd.traces" },
	{ name: "trace", tier: "core", usage: "/trace 3", help: "help.cmd.trace" },
	{ name: "passport", tier: "core", usage: "/passport", help: "help.cmd.passport" },
	{ name: "dataset", tier: "core", usage: "/dataset", help: "help.cmd.dataset" },
	{ name: "help", tier: "core", usage: "/help all", help: "help.cmd.help" },
	// The same work, one step at a time, plus the inspections. The sentence is
	// the one the palette already shows: a command has one description, not two.
	{ name: "run", tier: "expert", usage: "/run", help: "cmd.run" },
	{ name: "plan", tier: "expert", usage: "/plan", help: "cmd.plan" },
	{ name: "review", tier: "expert", usage: "/review", help: "cmd.review" },
	{ name: "jobs", tier: "expert", usage: "/jobs", help: "cmd.jobs" },
	{ name: "stop", tier: "expert", usage: "/stop", help: "cmd.stop" },
	{ name: "target", tier: "expert", usage: "/target", help: "cmd.target" },
	{ name: "log", tier: "expert", usage: "/log", help: "cmd.log" },
	{ name: "doctor", tier: "expert", usage: "/doctor", help: "cmd.doctor" },
	{ name: "label", tier: "expert", usage: "/label 20", help: "cmd.label", helpParams: { max: MAX_LABEL_SAMPLE } },
	{ name: "holdout", tier: "expert", usage: "/holdout", help: "cmd.holdout" },
	{ name: "calibrate", tier: "expert", usage: "/calibrate", help: "cmd.calibrate" },
	{ name: "regrade", tier: "expert", usage: "/regrade", help: "cmd.regrade" },
	// AHDE's own decisions. The operator answers them where they are asked.
	{ name: "approve", tier: "host-decision", usage: "/approve", help: "cmd.approve" },
	{ name: "publish", tier: "host-decision", usage: "/publish", help: "cmd.publish" },
	{ name: "apply", tier: "host-decision", usage: "/apply", help: "cmd.apply" },
	{ name: "discard", tier: "host-decision", usage: "/discard", help: "cmd.discard" },
	{ name: "promote", tier: "host-decision", usage: "/promote", help: "cmd.promote" },
	{ name: "reject", tier: "host-decision", usage: "/reject", help: "cmd.reject" },
	{ name: "adopt", tier: "host-decision", usage: "/adopt", help: "cmd.adopt" },
	{ name: "next", tier: "host-decision", usage: "/next", help: "cmd.next" },
];

/** The same table, as names: the public order every command list follows. */
export const AHDE_BUILDER_COMMAND_NAMES: readonly string[] =
	AHDE_BUILDER_COMMANDS.map((command) => command.name);

const LISTED_COMMANDS: ReadonlyMap<string, BuilderCommandListing> =
	new Map(AHDE_BUILDER_COMMANDS.map((command) => [command.name, command]));

/** Commands of one tier, in table order, as `/help` prints them. */
export function builderCommandsOfTier(tier: BuilderCommandTier): readonly BuilderCommandListing[] {
	return AHDE_BUILDER_COMMANDS.filter((command) => command.tier === tier);
}

/**
 * Pi's own interactive slash commands, pinned.
 *
 * Pi does not export `BUILTIN_SLASH_COMMANDS` (it lives behind
 * `dist/core/slash-commands.js`, which the package's `exports` map does not
 * publish), so the only honest way to know the names is to copy them and let a
 * test fail when the pinned runtime moves.
 *
 * They matter because a built-in name never reaches an extension: Pi's submit
 * handler resolves the name against this set FIRST, so a Builder command that
 * shares one is either shadowed by the built-in or — when the host's
 * `allowedBuiltinCommands` does not admit it, which is AHDE's case — refused
 * outright with `… is disabled by this host.` Session 7 lost `/export` that
 * way, and the only warning was an English `[Extension issues]` block on a
 * screen nobody reads twice.
 */
export const PI_BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set([
	"settings", "model", "tree", "thinking", "scoped-models", "export", "import",
	"share", "copy", "name", "session", "changelog", "hotkeys", "fork", "clone",
	"trust", "login", "logout", "new", "compact", "resume", "reload", "quit",
]);

/**
 * Built-in names AHDE deliberately serves itself.
 *
 * Empty, and that is the point: an override only works when the host also
 * lists the name in `preferredExtensionCommands`, so adding one here without
 * adding it there re-creates the `/export` defect. `/help` is not a Pi
 * built-in at all (Pi has no `/help`), and `/model` is a built-in AHDE never
 * registers — neither is an override.
 */
const AHDE_BUILTIN_OVERRIDES: ReadonlySet<string> = new Set<string>();

/**
 * The guard every Builder command passes before Pi hears about it: a name the
 * host already owns is not a command with a warning, it is a command that
 * never runs.
 */
export function assertRegistrableCommandName(name: string): void {
	if (!PI_BUILTIN_COMMAND_NAMES.has(name) || AHDE_BUILTIN_OVERRIDES.has(name)) return;
	throw new Error(
		`/${name} is one of Pi's own built-in commands, so the host would answer it before this extension ever saw it. ` +
		"Rename the Builder command, or add it to both AHDE_BUILTIN_OVERRIDES and preferredExtensionCommands.",
	);
}

/**
 * The second guard: a command with no row in the table has no tier, so `/help`
 * could not say which screen it belongs on — and the honest failure for that is
 * a startup error, not a command that quietly exists and is documented nowhere.
 */
export function assertListedCommandName(name: string): void {
	if (LISTED_COMMANDS.has(name)) return;
	throw new Error(
		`/${name} is registered without a row in AHDE_BUILDER_COMMANDS, so /help cannot place it. ` +
		"Add it there with its tier and its one-line description.",
	);
}

/** The column the sentences start in: the widest thing anyone has to type. */
const HELP_USAGE_COLUMN = Math.max(...AHDE_BUILDER_COMMANDS.map((command) => command.usage.length));

function helpLine(usage: string, sentence: string): string {
	return `  ${usage.padEnd(HELP_USAGE_COLUMN)}  ${sentence}`;
}

function helpLinesOfTier(tier: BuilderCommandTier): string[] {
	return builderCommandsOfTier(tier).map((command) => helpLine(command.usage, t(command.help, command.helpParams)));
}

/**
 * The `/help` reference, in the operator's language.
 *
 * Thirty-one registrations over forty-five lines taught the operator the
 * machine instead of the product — including the eight decisions AHDE asks
 * itself, which the Builder is forbidden to name and which nobody should ever
 * have to type. So the default screen is the nine core commands and nothing
 * else, and `/help all` is the whole table under headings that say what each
 * group is. Both are rendered from the one command table: a command cannot be
 * registered without a tier, so nothing can go missing from `all`.
 */
export function renderBuilderHelp(all = false): string[] {
	const paragraph = (key: MessageKey): string[] => t(key).split("\n");
	if (!all) {
		return [...paragraph("help.intro"), "", ...helpLinesOfTier("core"), "", ...paragraph("help.gate")];
	}
	return [
		...paragraph("help.workflow"),
		"",
		t("help.h.core"),
		...helpLinesOfTier("core"),
		"",
		t("help.h.expert"),
		...helpLinesOfTier("expert"),
		"",
		t("help.h.host"),
		...helpLinesOfTier("host-decision"),
		"",
		t("help.h.builtin"),
		helpLine("/login", t("help.cmd.login")),
		helpLine("/model", t("help.cmd.model")),
		"",
		...paragraph("help.gate"),
	];
}

/** `/help` takes nothing, or the one word that opens the rest of the table. */
function parseHelpScope(args: string): boolean {
	const rest = args.trim();
	if (!rest) return false;
	if (rest === "all") return true;
	throw new Error(t("cmd.err.help-arg"));
}

function requireTui(ctx: ExtensionCommandContext, command: string): void {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		throw new Error(t("cmd.err.tui", { command }));
	}
}

function abortIfRequested(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("command aborted");
}

async function awaitIdle(ctx: ExtensionCommandContext, command: string): Promise<AbortSignal | undefined> {
	requireTui(ctx, command);
	const signal = ctx.signal;
	await ctx.waitForIdle();
	abortIfRequested(signal);
	return signal;
}


function noArguments(command: string, args: string): void {
	if (args.trim()) throw new Error(t("cmd.err.no-args", { command }));
}

function reasonOrDefault(args: string, command: string): string {
	return args.trim() || t("reason.interactive", { command });
}

function parseRepetitions(args: string, command: string): { repetitions: number; reason: string } {
	const fallback = t("reason.interactive", { command });
	const trimmed = args.trim();
	if (!trimmed) return { repetitions: DEFAULT_REPETITIONS, reason: fallback };
	const tokens = trimmed.split(/\s+/);
	if (!/^\d+$/.test(tokens[0] ?? "")) {
		return { repetitions: DEFAULT_REPETITIONS, reason: trimmed };
	}
	const repetitions = Number(tokens.shift());
	if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
		throw new Error(t("cmd.err.repetitions", { command }));
	}
	return { repetitions, reason: tokens.join(" ") || fallback };
}

const EVAL_RUN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * `/regrade [erun] [draft|target] [reason]`.
 *
 * The default is the draft, because the operator typing `/regrade` has just
 * revised the rubric and that revision is what they mean. `target` re-runs
 * today's rubric, which says something only when the judge model itself moved
 * — the Workbench refuses it as a no-op otherwise rather than billing for it.
 */
export function parseRegrade(args: string): {
	evalRunId: string | null;
	graders: "draft" | "target";
	reason: string;
} {
	const fallback = t("reason.interactive", { command: "regrade" });
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const named = tokens[0]?.startsWith("erun_") ? tokens.shift() ?? null : null;
	if (named !== null && !EVAL_RUN_PATTERN.test(named)) {
		throw new Error(t("cmd.err.regrade-id"));
	}
	const graders = tokens[0] === "draft" || tokens[0] === "target" ? tokens.shift() as "draft" | "target" : "draft";
	return { evalRunId: named, graders, reason: tokens.join(" ") || fallback };
}

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * The offers that decide nothing. Ids, so a dialog is dispatched on what the
 * operator picked rather than on the sentence that was drawn for them.
 */
const JUST_LOOKING = "just-looking";
const NOT_NOW = "not-now";

function parseBranch(value: string): string {
	if (!BRANCH_PATTERN.test(value)) throw new Error(t("cmd.err.branch"));
	return value;
}

function parseVersion(value: string): string {
	if (!VERSION_PATTERN.test(value)) throw new Error(t("cmd.err.version"));
	return value;
}

/** `/fix [n] [note]`: the ordinal from `/traces`, or the first problem. */
function parseOrdinal(args: string, command: string): { ordinal: number | null; note: string } {
	const trimmed = args.trim();
	if (!trimmed) return { ordinal: null, note: "" };
	const tokens = trimmed.split(/\s+/);
	if (!/^\d+$/.test(tokens[0] ?? "")) return { ordinal: null, note: trimmed };
	const ordinal = Number(tokens.shift());
	if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 100) {
		throw new Error(t("cmd.err.ordinal", { command }));
	}
	return { ordinal, note: tokens.join(" ") };
}

/**
 * `/holdout 20 из базы знаний`, and the four other ways an operator says it.
 *
 * Deliberately narrow: only an unmistakable phrase turns `/holdout` from "here
 * is my exam file" into "write me one from the documents", because the argument
 * this command has always taken is a path, and a path that accidentally reads
 * as an instruction would spend money. `--from-kb` is the same request as a
 * flag, for a script or a keyboard in a hurry.
 */
const KNOWLEDGE_BASE_PHRASE = /--from-kb\b|(?:из|по)\s+баз[аеы]\s+знаний|баз[аеы]\s+знаний|knowledge\s+base/iu;
const HOLDOUT_DRAFT_PHRASE = /--review\b|черновик|draft/iu;

export function parseKnowledgeBaseHoldout(
	args: string,
): { cases: number | null; mode: "seal" | "review" } | null {
	const trimmed = args.trim();
	if (!trimmed || !KNOWLEDGE_BASE_PHRASE.test(trimmed)) return null;
	const digits = /\d+/.exec(trimmed);
	const cases = digits ? Number(digits[0]) : null;
	if (cases !== null && (!Number.isSafeInteger(cases) || cases < 1)) {
		throw new Error(t("cmd.err.holdout-count", { answer: JSON.stringify(digits?.[0] ?? "") }));
	}
	return { cases, mode: HOLDOUT_DRAFT_PHRASE.test(trimmed) ? "review" : "seal" };
}

function parseApply(args: string): { branch: string | null; reason: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const branch = tokens.shift();
	return {
		branch: branch ? parseBranch(branch) : null,
		reason: tokens.join(" ") || t("reason.interactive", { command: "apply" }),
	};
}

function parsePromote(args: string, command = "promote"): { version: string | null; reason: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const version = tokens.shift();
	return {
		version: version ? parseVersion(version) : null,
		reason: tokens.join(" ") || t("reason.interactive", { command }),
	};
}

/** Turn Workbench failures into one calm sentence; unknown errors keep their message. */
export function humanizeCommandError(error: unknown): { message: string; tone: TranscriptTone } {
	if (error instanceof WorkbenchDecisionDeclinedError) {
		return { message: t("error.cancelled"), tone: "info" };
	}
	if (error instanceof WorkbenchStaleDecisionError) {
		return { message: t("error.stale"), tone: "warning" };
	}
	if (error instanceof WorkbenchSelectionRequiredError) {
		const choices = error.choices.length > 0 ? t("error.selection-choices", { choices: error.choices.slice(0, 8).join(", ") }) : "";
		return { message: `${t("error.selection-required", { message: error.message })}${choices}`, tone: "warning" };
	}
	// A refusal that carries a code was written to be read by a person: it is
	// said in their language, and whatever machine text the code cannot carry
	// follows it, exactly the way a blocker's `detail` does.
	const refusal = typedRefusalReason(error);
	if (refusal && hasMessage(refusal.code)) {
		const sentence = t(refusal.code, refusal.params);
		return { message: refusal.detail ? `${sentence} ${refusal.detail}` : sentence, tone: "warning" };
	}
	const message = error instanceof Error ? error.message : String(error);
	return { message: oneLine(message, 600), tone: "error" };
}

export interface RegisterBuilderCommandsOptions {
	hostActions?: BuilderHostActions;
	workbench: CommandWorkbench;
	actorId: () => string;
	beginLiveTrace?: BeginBuilderLiveTrace;
	/** Shared transcript presenter; created locally when omitted. */
	presenter?: TranscriptPresenter;
	/** Invoked after any command that may change Workbench state (header refresh). */
	onWorkbenchChanged?: () => void | Promise<void>;
	/** Optional bridge to the conversation for “fix problem N” shortcuts. */
	sendUserMessage?: (text: string) => void;
	/** Evidence loaders behind /traces and /trace; the Explorer's own, unless a test injects page models. */
	evidence?: {
		evalPage: (runsRoot: string, evalRunId: string) => EvalPageModel;
		runDetail: (runsRoot: string, runId: string) => RunDetailPageModel;
	};
	/** Host-only sealed import. The path and corpus identity never enter Builder Pi. */
	importSealedHoldout?: (input: { sourcePath: string; name: string }) => { taskCount: number };
	/** What a finished measurement actually cost; without it, panels carry no receipt. */
	spend?: BuilderSpendReader;
	/** One background measurement at a time; created locally when omitted. */
	jobs?: BuilderJobs;
	/** Open workshop, for the `/plan` sub-items. */
	workshopStatus?: () => { files: number; tries: number } | null;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The world one run happened in, or null when its case declared none.
 *
 * `before` is the case's own starting state, as the traces view already
 * bounded and redacted it; `after` is what the conversation left behind. A
 * world file that will not parse is reported as unreadable rather than as an
 * empty world: it says nothing about the agent, and a caller that treated it
 * as an answer would be inventing one.
 *
 * The join is the task id on both sides — the corpus case's own id, and the
 * public form of it the evidence layer prints. An id that ever needed
 * redacting would simply not match, and the panel would show no world rather
 * than the wrong one.
 */
function worldOfRun(
	content: WorkbenchTracesDetail,
	detail: RunDetailPageModel,
	runsRoot: string,
): TraceWorld | null {
	const declared = content.worldCases?.find((item) => item.taskId === detail.run.taskId);
	if (!declared?.world) return null;
	try {
		return { before: declared.world.state, after: readFinalWorldState(join(runsRoot, detail.run.runId)) };
	} catch {
		return { before: declared.world.state, after: null, unreadable: true };
	}
}

/** Which row `/trace <arg>` means: a 1-based row, next/prev from the cursor, a task id, or a run id. */
export function resolveTraceTarget(
	argument: string,
	rows: readonly EvalPageModel["rows"][number][],
	cursor: number | null,
): { index: number; row: EvalPageModel["rows"][number] } | "end" {
	if (rows.length === 0) throw new Error(t("cmd.err.no-runs"));
	const at = (index: number) => ({ index, row: rows[index]! });
	if (argument === "" || argument === "next") {
		if (argument === "" && cursor === null) return at(0);
		const index = cursor === null ? 0 : cursor + 1;
		return index >= rows.length ? "end" : at(index);
	}
	if (argument === "prev") {
		if (cursor === null || cursor === 0) return "end";
		return at(cursor - 1);
	}
	if (/^\d{1,3}$/.test(argument)) {
		const index = Number(argument) - 1;
		if (index < 0 || index >= rows.length) throw new Error(t("cmd.err.trace-row", { argument, rows: pluralize(rows.length, "row") }));
		return at(index);
	}
	const byId = rows.findIndex((row) => row.runId === argument || row.taskId === argument || `${row.taskId}#${row.repetitionIndex}` === argument);
	if (byId >= 0) return at(byId);
	throw new Error(t("cmd.err.trace-arg", { argument }));
}

export function registerAhdeBuilderCommands(
	pi: ExtensionAPI,
	options: RegisterBuilderCommandsOptions,
): void {
	const presenter = options.presenter ?? createTranscriptPresenter(pi);
	const workbench = options.workbench;
	const evidence = options.evidence ?? {
		evalPage: (runsRoot: string, evalRunId: string) => collectEvalPage(runsRoot, evalRunId),
		runDetail: (runsRoot: string, runId: string) => collectRunDetailPage(runsRoot, runId),
	};
	/** Where /trace next|prev stands, per evaluation; forgotten when the eval changes. */
	let traceCursor: { evalRunId: string; index: number } | null = null;
	const spendReader = options.spend ?? null;
	/**
	 * The host context of the command being handled. A background job outlives
	 * its command, so it reports through the newest context the operator gave us
	 * rather than holding the one it started under.
	 */
	let host: ExtensionCommandContext | null = null;
	const jobs = options.jobs ?? createBuilderJobs({
		host: {
			setStatus: (key, text) => host?.ui.setStatus(key, text),
			show: (block) => {
				if (host) presenter.show(host, block);
			},
			note: (text, note) => presenter.note(text, { triggerTurn: note.triggerTurn, label: note.label }),
			waitForIdle: async () => {
				await host?.waitForIdle();
			},
		},
	});

	const hostActions = options.hostActions ?? createBuilderHostActions({ workbench, jobs, presenter,
		onWorkbenchChanged: options.onWorkbenchChanged, importSealedHoldout: options.importSealedHoldout });

	/** Every handler starts here: the host context a background job reports through. */
	const prepare = async (ctx: ExtensionCommandContext, command: string): Promise<AbortSignal | undefined> => {
		host = ctx;
		return awaitIdle(ctx, command);
	};

	/** One sentence instead of a second concurrent measurement. */
	const refuseWhileBusy = (ctx: ExtensionCommandContext): boolean => {
		const busy = jobs.busy();
		if (!busy) return false;
		ctx.ui.notify(busy, "warning");
		return true;
	};

	const showRunsTable = (ctx: ExtensionCommandContext, evalRunId: string, limit: number): void => {
		try {
			const page = evidence.evalPage(workbench.runsRoot, evalRunId);
			presenter.show(ctx, {
				title: t("panel.title", { detail: t("panel.runs") }),
				tone: "info",
				lines: renderRunsTable(page.rows, page.modes, markerPaint, { limit: Math.min(limit, MAX_TRACE_TABLE_ROWS) }),
			});
		} catch {
			// The table is a convenience over the same evidence the link opens; when
			// the runs cannot be read here, the diagnosis and its link stand alone.
		}
	};

	/**
	 * The evidence both /traces and /trace read. A project that has measured
	 * nothing yet is not an error — it is a sentence — so the one refusal the
	 * Workbench still raises here becomes the panel that says what to do next.
	 */
	const tracesDetail = async (ctx: ExtensionCommandContext): Promise<WorkbenchTracesDetail | null> => {
		let view: WorkbenchView;
		try {
			view = await workbench.view({ aspect: "traces" });
		} catch (error) {
			if (!(error instanceof WorkbenchSelectionRequiredError)) throw error;
			presenter.show(ctx, { title: t("panel.title", { detail: t("panel.runs") }), tone: "info", lines: [t("trace.noRuns")] });
			return null;
		}
		if (view.detail?.aspect !== "traces") {
			presenter.show(ctx, { title: viewTitle(view), tone: "warning", lines: renderStatus(view, markerPaint, { heading: false }) });
			return null;
		}
		return view.detail.content;
	};

	/**
	 * Every slash command, behind one guard.
	 *
	 * Pi renders a thrown command handler as `Extension "command:traces"
	 * error: …` with its stack under it — its own framing, in English — so a
	 * refusal the operator merely typed wrong reads like a crash of the
	 * product. The same sentence goes into the transcript as a panel instead.
	 *
	 * Without a TUI there is nowhere to draw one, and the caller — a script, an
	 * RPC host, a test — is owed the error itself, so it is rethrown.
	 */
	const registerCommand = (
		name: string,
		definition: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
	): void => {
		// Refusing here turns the class of defect into a startup failure a test
		// catches, instead of a slash command the operator discovers is dead on
		// the day they need it.
		assertRegistrableCommandName(name);
		assertListedCommandName(name);
		pi.registerCommand(name, {
			description: definition.description,
			handler: async (args, ctx) => {
				try {
					const reads = ["help", "status", "doctor", "review", "traces", "trace", "target", "log", "plan", "jobs", "stop", "passport", "dataset"];
					if (!reads.includes(name) && refuseWhileBusy(ctx)) return;
					await definition.handler(args, ctx);
				} catch (error) {
					if (!ctx.hasUI || ctx.mode !== "tui") throw error;
					const human = humanizeCommandError(error);
					presenter.show(ctx, {
						title: t("panel.title", { detail: `/${name}` }),
						tone: human.tone,
						lines: [human.message],
					});
				}
			},
		});
	};

	const gate = (ctx: ExtensionCommandContext) => createPolicyAwareGate(
		ctx,
		options.actorId,
		(operation) => requireTui(ctx, operation),
		"candidate verification",
	);

	const changed = async (): Promise<void> => {
		try {
			await options.onWorkbenchChanged?.();
		} catch {
			// Header refresh is cosmetic; the decision already happened.
		}
	};

	const showDecision = async (
		ctx: ExtensionCommandContext,
		command: string,
		result: WorkbenchDecisionResult,
		options: { liveTraceUrl?: string | null; note?: boolean } = {},
	): Promise<string> => {
		const { block, headline } = await builderDecisionPresentation(result, { workbench, source: command, liveTraceUrl: options.liveTraceUrl, spend: spendReader });
		presenter.show(ctx, block);
		if (options.note !== false) {
			presenter.note(
				`Operator ran /${command}: ${headline}. ` +
				`Workbench stage is now ${result.view.stage} (${stageLabel(result.view.stage)}): ${result.view.headline} ` +
				"Call ahde_workbench_view before relying on any earlier state.",
				{ label: t("note.decision", { command, detail: oneLine(headline, 80) }) },
			);
		}
		await changed();
		return headline;
	};

	/** Fine-grained recovery decisions stay foreground but share the session lock. */
	const decide = async (
		ctx: ExtensionCommandContext, command: string, input: WorkbenchDecisionInput,
		signal: AbortSignal | undefined, humanGate = gate(ctx),
	): Promise<WorkbenchDecisionResult | null> => {
		try {
			const outcome = await executeBuilderDecision({
				jobs, ctx, input, source: command, signal, gate: humanGate, background: false,
				run: (gate, execution) => workbench.decide(input, gate, execution),
				present: async (result) => result.message,
			});
			return outcome.status === "completed" ? outcome.result : null;
		} catch (error) {
			if (signal?.aborted) throw error;
			const human = humanizeCommandError(error);
			if (human.tone === "error") throw new Error(human.message, { cause: error });
			ctx.ui.notify(human.message, human.tone === "info" ? "info" : "warning");
			return null;
		}
	};

	/** Shortcuts use the same operation and observation as natural-language tools. */
	const runObserved = async (ctx: ExtensionCommandContext, command: string, input: WorkbenchDecisionInput, signal: AbortSignal | undefined): Promise<void> => {
		if (refuseWhileBusy(ctx)) return;
		await executeBuilderDecision({
			jobs, ctx, input, source: command, signal, gate: gate(ctx), hasResultPanel: true, beginLiveTrace: options.beginLiveTrace,
			run: async (humanGate, execution) => {
				try { return await workbench.decide(input, humanGate, execution); }
				catch (error) {
					if (execution.signal.aborted) throw error;
					const human = humanizeCommandError(error);
					if (human.tone === "error") throw new Error(human.message, { cause: error });
					ctx.ui.notify(human.message, human.tone === "info" ? "info" : "warning");
					return null;
				}
			},
			present: (result, background, liveTraceUrl) => showDecision(ctx, command, result, { liveTraceUrl, note: !background }),
		});
	};

	const askVersion = async (ctx: ExtensionCommandContext): Promise<string | null> => {
		const value = await ctx.ui.input(t("intent.version-prompt"), "0.1.0");
		if (value === undefined) return null;
		return parseVersion(value.trim());
	};

	/**
	 * Apply is one dialog: the exact diff was rendered by /review (and is
	 * rendered again here when the operator jumps straight to /apply), the
	 * branch defaults to candidate/<proposal>, and the confirmation stays short.
	 */
	const applyProposal = async (
		ctx: ExtensionCommandContext,
		signal: AbortSignal | undefined,
		branch: string | null,
		reason: string,
		runId?: string,
		displayOptions: { showReview?: boolean } = {},
	): Promise<void> => {
		if (refuseWhileBusy(ctx)) return;
		const review = await workbench.view({ aspect: "review" });
		const detail = review.detail?.aspect === "review" ? review.detail.content : undefined;
		const proposalRunId = runId ?? (detail?.kind === "proposal" ? detail.runId : undefined);
		if (displayOptions.showReview !== false && detail?.kind === "proposal") {
			presenter.show(ctx, { title: viewTitle(review), tone: "info", lines: renderReview(detail, markerPaint) });
		}
		const chosen = branch ?? `candidate/${proposalRunId ?? "next"}`;
		await runObserved(ctx, "apply", {
			kind: "apply-proposal", branch: chosen, verify: { repetitions: DEFAULT_REPETITIONS }, reason,
			...(proposalRunId ? { runId: proposalRunId } : {}),
		}, signal);
	};

	const discardCurrent = async (ctx: ExtensionCommandContext, signal: AbortSignal | undefined, reason: string): Promise<void> => {
		if (refuseWhileBusy(ctx)) return;
		const review = await workbench.view({ aspect: "review" });
		const detail = review.detail?.aspect === "review" ? review.detail.content : undefined;
		const input: WorkbenchDecisionInput = detail?.kind === "interrupted-candidate"
			? { kind: "abandon-candidate", candidateId: detail.candidateId, reason }
			: { kind: "discard-proposal", reason };
		const result = await decide(ctx, "discard", input, signal);
		if (result) await showDecision(ctx, "discard", result);
	};

	/**
	 * One human intent, one dialog, two receipts. The review and the release
	 * decision stay separate immutable records, but the operator confirms the
	 * whole intent once: the follow-up gate is pre-approved only for the same
	 * candidate id inside this single command invocation.
	 */
	const intentGate = (
		ctx: ExtensionCommandContext,
		intent: { title: string; summary: string; followUp: WorkbenchDecisionInput["kind"] },
	): ReturnType<typeof gate> => {
		const base = gate(ctx);
		let approvedCandidateId: string | null = null;
		const candidateIdOf = (subject: unknown): string | null => {
			const candidate = (subject as { candidate?: { candidateId?: unknown } } | null)?.candidate;
			return typeof candidate?.candidateId === "string" ? candidate.candidateId : null;
		};
		return {
			async confirm(confirmation, signal) {
				const candidateId = candidateIdOf(confirmation.subject);
				if (confirmation.kind === intent.followUp && approvedCandidateId && candidateId === approvedCandidateId) {
					return { approved: true, actorId: options.actorId() };
				}
				const approved = await ctx.ui.confirm(
					intent.title,
					[
						intent.summary,
						"",
						// A terminal decision with nothing to study stays one question.
						confirmation.policy === "one-question" ? confirmation.question : formatWorkbenchConfirmation(confirmation),
					].join("\n"),
					{ signal },
				);
				if (!approved) return { approved: false };
				approvedCandidateId = candidateId;
				return { approved: true, actorId: options.actorId() };
			},
			selectSealed: (request, signal) => base.selectSealed(request, signal),
		};
	};

	const decideWithGate = (ctx: ExtensionCommandContext, input: WorkbenchDecisionInput, humanGate: ReturnType<typeof gate>, signal: AbortSignal | undefined) =>
		decide(ctx, input.kind, input, signal, humanGate);

	const promoteCurrent = async (
		ctx: ExtensionCommandContext,
		signal: AbortSignal | undefined,
		version: string | null,
		reason: string,
	): Promise<void> => {
		if (refuseWhileBusy(ctx)) return;
		let view = await workbench.view();
		if (view.stage !== "candidate-review" && view.stage !== "release-decision") {
			throw new Error(t("error.not-available", { command: "promote", stage: stageLabel(view.stage), next: nextStep(view) }));
		}
		const chosen = version ?? await askVersion(ctx);
		if (!chosen) return;
		const humanGate = intentGate(ctx, {
			title: t("intent.promote.title", { version: chosen }),
			summary: t(view.stage === "candidate-review" ? "intent.promote.with-review" : "intent.promote.tag-only", { version: chosen }),
			followUp: "promote-candidate",
		});
		if (view.stage === "candidate-review") {
			const reviewed = await decideWithGate(ctx, { kind: "review-candidate", recommendation: "promote", reason }, humanGate, signal);
			if (!reviewed) return;
			view = reviewed.view;
		}
		const result = await decideWithGate(ctx, { kind: "promote-candidate", version: chosen, reason }, humanGate, signal);
		if (result) await showDecision(ctx, "promote", result);
	};

	const rejectCurrent = async (ctx: ExtensionCommandContext, signal: AbortSignal | undefined, reason: string): Promise<void> => {
		if (refuseWhileBusy(ctx)) return;
		let view = await workbench.view();
		if (view.stage !== "candidate-review" && view.stage !== "release-decision") {
			throw new Error(t("error.not-available", { command: "reject", stage: stageLabel(view.stage), next: nextStep(view) }));
		}
		const humanGate = intentGate(ctx, {
			title: t("intent.reject.title"),
			summary: t(view.stage === "candidate-review" ? "intent.reject.with-review" : "intent.reject.only"),
			followUp: "reject-candidate",
		});
		if (view.stage === "candidate-review") {
			const reviewed = await decideWithGate(ctx, { kind: "review-candidate", recommendation: "reject", reason }, humanGate, signal);
			if (!reviewed) return;
			view = reviewed.view;
		}
		const result = await decideWithGate(ctx, { kind: "reject-candidate", reason }, humanGate, signal);
		if (result) await showDecision(ctx, "reject", result);
	};

	const simpleDecision = async (
		ctx: ExtensionCommandContext,
		command: string,
		input: WorkbenchDecisionInput,
		signal: AbortSignal | undefined,
	): Promise<void> => {
		if (refuseWhileBusy(ctx)) return;
		await runObserved(ctx, command, input, signal);
	};

	/** Offer the stage's decisions right after the operator reviewed the exact subject. */
	const offerReviewActions = async (ctx: ExtensionCommandContext, view: WorkbenchView, signal: AbortSignal | undefined): Promise<void> => {
		if (typeof ctx.ui.select !== "function") return;
		const detail = view.detail?.aspect === "review" ? view.detail.content : undefined;
		const reason = t("review.reason");
		/**
		 * The stage's actions, plus the way out that decides nothing. What comes
		 * back is the id of the action, never the sentence the host drew.
		 */
		const offer = <T extends string>(title: string, actions: readonly DialogChoice<T>[]) =>
			choose<T | typeof JUST_LOOKING>(
				ctx,
				title,
				[...actions, { id: JUST_LOOKING, label: () => t("review.just-looking") }],
				{ signal },
			);
		switch (view.stage) {
			case "spec-review": {
				const choice = await offer(t("section.spec-draft"), [
					{ id: "approve", label: () => t("review.approve-spec") },
					{ id: "ask-changes", label: () => t("review.ask-changes") },
				]);
				if (choice === "approve") await simpleDecision(ctx, "approve", { kind: "approve-spec", reason }, signal);
				else if (choice === "ask-changes") ctx.ui.notify(t("review.spec-hint"), "info");
				return;
			}
			case "corpus-review": {
				const choice = await offer(t("section.basket-draft"), [
					{ id: "publish", label: () => t("review.publish-basket") },
					{ id: "ask-changes", label: () => t("review.ask-changes") },
				]);
				if (choice === "publish") await simpleDecision(ctx, "publish", { kind: "publish-corpus", reason }, signal);
				else if (choice === "ask-changes") ctx.ui.notify(t("review.basket-hint"), "info");
				return;
			}
			case "proposal-review": {
				const choice = await offer(t("panel.proposal-review"), [
					{ id: "apply", label: () => t("review.apply-branch") },
					{ id: "discard", label: () => t("review.discard") },
				]);
				const runId = detail?.kind === "proposal" ? detail.runId : undefined;
				if (choice === "apply") await applyProposal(ctx, signal, null, reason, runId, { showReview: false });
				else if (choice === "discard") await discardCurrent(ctx, signal, reason);
				return;
			}
			case "candidate-verification": {
				if (detail?.kind === "interrupted-candidate") {
					const abandon = await confirmChoice(ctx, t("panel.interrupted-candidate"), "review.abandon-attempt", "review.just-looking", { signal });
					if (abandon) await discardCurrent(ctx, signal, reason);
				} else {
					const verify = await confirmChoice(ctx, t("panel.applied-proposal"), "review.verify-now", "review.just-looking", { signal });
					if (verify) await runObserved(ctx, "run", { kind: "run-current", repetitions: DEFAULT_REPETITIONS, reason }, signal);
				}
				return;
			}
			case "candidate-review":
			case "release-decision": {
				const choice = await offer(t("candidate.title"), [
					{ id: "ship", label: () => t("review.ship") },
					{ id: "reject", label: () => t("review.reject") },
				]);
				if (choice === "ship") await shipCurrent(ctx, signal, null, reason);
				else if (choice === "reject") await rejectCurrent(ctx, signal, reason);
				return;
			}
			case "candidate-adoption": {
				const adopt = await confirmChoice(ctx, t("result.candidate-promoted"), "review.adopt", "review.just-looking", { signal });
				if (adopt) await simpleDecision(ctx, "adopt", { kind: "adopt-candidate", reason }, signal);
				return;
			}
			case "complete": {
				const next = await confirmChoice(ctx, t("stage.complete"), "review.next-cycle", "review.just-looking", { signal });
				if (next) await simpleDecision(ctx, "next", { kind: "continue-cycle", reason }, signal);
				return;
			}
			default:
				return;
		}
	};

	/**
	 * “Ship it” is one dialog over the release decisions that are left. The exact
	 * receipts are still four separate immutable records underneath.
	 */
	const shipCurrent = async (
		ctx: ExtensionCommandContext,
		signal: AbortSignal | undefined,
		version: string | null,
		reason: string,
	): Promise<void> => {
		if (refuseWhileBusy(ctx)) return;
		const view = await workbench.view();
		const shippable = ["candidate-review", "release-decision", "candidate-adoption", "complete"];
		if (!shippable.includes(view.stage)) {
			throw new Error(t("cmd.err.ship-stage", { stage: stageLabel(view.stage), next: nextStep(view) }));
		}
		const needsVersion = view.stage === "candidate-review" || view.stage === "release-decision";
		const chosen = version ?? (needsVersion ? await askVersion(ctx) : null);
		if (needsVersion && !chosen) return;
		await runObserved(ctx, "ship", {
			kind: "ship",
			...(chosen ? { version: chosen } : {}),
			reason,
		}, signal);
	};

	/**
	 * “Fix problem n” is the model's work, not a decision: the command resolves
	 * the ordinal against a fresh brief and asks the Builder for the proposal.
	 */
	const fixProblem = async (
		ctx: ExtensionCommandContext,
		ordinal: number | null,
		note: string,
	): Promise<void> => {
		const view = await workbench.view({ aspect: "traces" });
		if (view.detail?.aspect !== "traces") {
			presenter.show(ctx, { title: viewTitle(view), tone: "warning", lines: renderStatus(view, markerPaint, { heading: false }) });
			ctx.ui.notify(t("cmd.nothing-to-fix", { next: nextStep(view) }), "info");
			return;
		}
		presenter.show(ctx, { title: t("panel.title", { detail: t("panel.diagnosis") }), tone: "info", lines: renderTraces(view.detail.content, markerPaint) });
		const modes = view.detail.content.improvementBrief.modes.filter((mode) => mode.selectableForProposal);
		if (modes.length === 0) {
			ctx.ui.notify(t("cmd.nothing-fixable"), "info");
			return;
		}
		const mode = ordinal === null ? modes[0]! : modes.find((candidate) => candidate.ordinal === ordinal);
		if (!mode) {
			throw new Error(t("cmd.err.no-problem", { ordinal: ordinal ?? 1, count: pluralize(modes.length, "failure mode") }));
		}
		const request = t("traces.fix-message", {
			ordinal: mode.ordinal,
			id: mode.failureModeId,
			title: oneLine(failureModeReading(mode).title, 120),
		});
		if (!options.sendUserMessage) {
			ctx.ui.notify(t("cmd.ask-fix", { ordinal: mode.ordinal }), "info");
			return;
		}
		options.sendUserMessage(note ? `${request} ${note}` : request);
	};

	registerCommand("test", {
		description: t("cmd.test"),
		async handler(args, ctx) {
			const signal = await prepare(ctx, "test");
			const parsed = parseRepetitions(args, "test");
			await runObserved(ctx, "test", { kind: "run-current", repetitions: parsed.repetitions, reason: parsed.reason }, signal);
		},
	});

	registerCommand("fix", {
		description: t("cmd.fix"),
		async handler(args, ctx) {
			await prepare(ctx, "fix");
			const parsed = parseOrdinal(args, "fix");
			await fixProblem(ctx, parsed.ordinal, parsed.note);
		},
	});

	registerCommand("ship", {
		description: t("cmd.ship"),
		async handler(args, ctx) {
			const signal = await prepare(ctx, "ship");
			const parsed = parsePromote(args, "ship");
			await shipCurrent(ctx, signal, parsed.version, parsed.reason);
		},
	});

	registerCommand("help", {
		description: t("cmd.help"),
		async handler(args, ctx) {
			const all = parseHelpScope(args);
			await prepare(ctx, "help");
			presenter.show(ctx, {
				title: all ? t("panel.help-all") : t("panel.help"),
				tone: "info",
				lines: renderBuilderHelp(all),
			});
		},
	});

	registerCommand("doctor", {
		description: t("cmd.doctor"),
		async handler(args, ctx) {
			noArguments("doctor", args);
			await prepare(ctx, "doctor");
			const view = await workbench.view();
			const model = ctx.model;
			const credentialPresent = model ? ctx.modelRegistry.hasConfiguredAuth(model) : false;
			const p = markerPaint;
			const ok = (text: string) => p.success(`✓ ${text}`);
			const warn = (text: string) => p.warning(`! ${text}`);
			const lines: string[] = [];
			lines.push(model
				? (credentialPresent
					? ok(t("doctor.builder-ok", { model: `${model.provider}/${model.id}` }))
					: warn(t("doctor.builder-no-credential", { model: `${model.provider}/${model.id}` })))
				: warn(t("doctor.builder-none")));
			if (view.target.status === "missing") lines.push(warn(t("doctor.target-missing")));
			else if (view.target.status === "bootstrap-required") lines.push(warn(t("doctor.target-bootstrap")));
			else {
				lines.push(ok(t("doctor.target-ok", { id: view.target.id ?? "—", sha: view.target.gitSha?.slice(0, 10) ?? "—" })));
				const target = view.target.model;
				if (target) {
					const model = `${target.provider}/${target.id}`;
					lines.push(target.credentialPresent
						? ok(t("doctor.target-model-ok", { model, env: target.apiKeyEnv }))
						: warn(t("doctor.target-model-missing", { model, env: target.apiKeyEnv })));
				}
			}
			const evaluators = view.target.evaluators ?? { judge: null, simulatedUser: null };
			const evaluatorLabels = {
				judge: t("doctor.judge-model"),
				simulatedUser: t("doctor.simulated-user-model"),
			} as const;
			for (const role of ["judge", "simulatedUser"] as const) {
				const evaluator = evaluators[role];
				const label = evaluatorLabels[role];
				const required = view.target.evaluatorRequirements?.[role] ?? evaluator !== null;
				if (!evaluator) {
					lines.push(required
						? warn(t("doctor.evaluator-required", { label }))
						: p.muted(t("doctor.evaluator-optional", { label })));
					continue;
				}
				const model = `${evaluator.provider}/${evaluator.id}`;
				lines.push(evaluator.credentialPresent
					? ok(t("doctor.evaluator-ok", { label, model, env: evaluator.apiKeyEnv }))
					: required
						? warn(t("doctor.evaluator-missing", { label, model, env: evaluator.apiKeyEnv }))
						: p.muted(t("doctor.evaluator-unused", { label, model, env: evaluator.apiKeyEnv })));
			}
			const shipping = view.counts.approvedSpecs > 0 ? view.shippingReadiness : undefined;
			if (shipping?.sealedHoldout === "ready") {
				lines.push(ok(t("doctor.gate-ready")));
			} else if (shipping) {
				lines.push(warn(
					shipping.sealedHoldout === "missing"
						? t("doctor.gate-missing", { minimum: shipping.minimumTasks })
						: shipping.sealedHoldout === "underpowered"
							? t("doctor.gate-underpowered", examShortfall(shipping))
							: t("doctor.gate-unavailable"),
				));
			}
			// Template stand-ins are a readiness fact, not a footnote, so /doctor
			// says the line itself. The view carries the same sentence for the
			// Builder; printing it twice would only make it look like two problems.
			const standIns = standInFilesLine(workbench.projectDir);
			if (standIns) lines.push(warn(standIns));
			lines.push(`${p.dim(t("label.stage"))} ${stageLabel(view.stage)} · ${nextStep(view)}`);
			for (const blocker of blockerLines(view)) lines.push(warn(blocker));
			for (const warning of view.warnings.filter((entry) => entry !== standIns).slice(0, 6)) {
				lines.push(p.muted(`· ${oneLine(warning, 200)}`));
			}
			const evaluatorsReady = (["judge", "simulatedUser"] as const).every((role) => {
				const required = view.target.evaluatorRequirements?.[role] ?? evaluators[role] !== null;
				return !required || Boolean(evaluators[role]?.credentialPresent);
			});
			const ready = Boolean(
				model && credentialPresent && view.target.status === "ready" &&
				view.target.model?.credentialPresent && evaluatorsReady && view.blockers.length === 0
			);
			lines.push(ready ? ok(t("doctor.ready")) : warn(t("doctor.action-required")));
			presenter.show(ctx, { title: t("panel.doctor"), tone: ready ? "success" : "warning", lines });
		},
	});

	registerCommand("holdout", {
		description: t("cmd.holdout"),
		async handler(args, ctx) {
			await prepare(ctx, "holdout");
			const minimum = SEALED_GATE_POLICY.minTasks;
			// A path on the command line is the import, straight away: the host's
			// own "run /holdout on that file" used to lead to "/holdout does not
			// accept arguments". Without one, three ways to end up with an exam and
			// one question that names all three. The two generated ones are
			// Workbench decisions with their own dialog; the import is this
			// command's own host UI, as it always was.
			const givenPath = args.trim();
			// `/holdout 20 из базы знаний` — the one thing this command could not
			// say before. It is a phrase and not a fourth menu entry because the
			// menu cannot know whether this Target has a knowledge base, and an
			// option that always refuses is worse than one nobody found.
			const fromKnowledgeBase = parseKnowledgeBaseHoldout(givenPath);
			if (fromKnowledgeBase) {
				await simpleDecision(ctx, "holdout", {
					kind: "generate-holdout",
					cases: fromKnowledgeBase.cases ?? minimum + 5,
					mode: fromKnowledgeBase.mode,
					source: "kb",
					reason: t("holdout.reason-kb"),
				}, ctx.signal);
				return;
			}
			if (!givenPath && typeof ctx.ui.select === "function") {
				const chosen = await choose(ctx, t("holdout.choose"), [
					{ id: "import", label: () => t("holdout.import-file") },
					{ id: "seal", label: () => t("holdout.generate-seal") },
					{ id: "review", label: () => t("holdout.generate-review") },
				], { signal: ctx.signal });
				if (chosen === null) {
					ctx.ui.notify(t("error.cancelled"), "info");
					return;
				}
				if (chosen === "seal" || chosen === "review") {
					const answer = await ctx.ui.input(t("holdout.how-many", { minimum }), String(minimum + 5));
					if (answer === undefined || !answer.trim()) {
						ctx.ui.notify(t("error.cancelled"), "info");
						return;
					}
					const cases = Number(answer.trim());
					if (!Number.isSafeInteger(cases)) {
						throw new Error(t("cmd.err.holdout-count", { answer: JSON.stringify(answer.trim()) }));
					}
					await simpleDecision(ctx, "holdout", {
						kind: "generate-holdout",
						cases,
						mode: chosen === "seal" ? "seal" : "review",
						reason: t("holdout.reason"),
					}, ctx.signal);
					return;
				}
			}
			await hostActions.importExam(ctx, ctx.signal, givenPath);
		},
	});

	registerCommand("status", {
		description: t("cmd.status"),
		async handler(args, ctx) {
			noArguments("status", args);
			await prepare(ctx, "status");
			const view = await workbench.view({ aspect: "summary" });
			presenter.show(ctx, { title: viewTitle(view), tone: view.blockers.length > 0 ? "warning" : "info", lines: renderStatus(view, markerPaint, { heading: false }) });
		},
	});

	registerCommand("run", {
		description: t("cmd.run"),
		async handler(args, ctx) {
			const signal = await prepare(ctx, "run");
			const parsed = parseRepetitions(args, "run");
			await runObserved(ctx, "run", { kind: "run-current", repetitions: parsed.repetitions, reason: parsed.reason }, signal);
		},
	});

	registerCommand("calibrate", {
		description: t("cmd.calibrate"),
		async handler(args, ctx) {
			const signal = await prepare(ctx, "calibrate");
			const parsed = parseRepetitions(args, "calibrate");
			await runObserved(ctx, "calibrate", { kind: "calibrate", repetitions: parsed.repetitions, reason: parsed.reason }, signal);
		},
	});

	/**
	 * The answer to “the judge is too strict”. The rubric changes in the draft,
	 * the recorded answers are scored again, and the operator sees the
	 * difference — without buying one Target token a second time.
	 */
	registerCommand("regrade", {
		description: t("cmd.regrade"),
		async handler(args, ctx) {
			const signal = await prepare(ctx, "regrade");
			const parsed = parseRegrade(args);
			await runObserved(
				ctx,
				"regrade",
				{
					kind: "regrade",
					graders: parsed.graders,
					...(parsed.evalRunId ? { evalRunId: parsed.evalRunId } : {}),
					reason: parsed.reason,
				},
				signal,
			);
		},
	});

	registerCommand("traces", {
		description: t("cmd.traces"),
		async handler(args, ctx) {
			const rowsWanted = args.trim();
			if (rowsWanted && !/^\d{1,2}$/.test(rowsWanted)) throw new Error(t("cmd.err.traces-rows"));
			const signal = await prepare(ctx, "traces");
			const content = await tracesDetail(ctx);
			if (!content) return;
			presenter.show(ctx, { title: t("panel.title", { detail: t("panel.diagnosis") }), tone: "info", lines: renderTraces(content, markerPaint) });
			showRunsTable(ctx, content.evaluation.evalRunId, rowsWanted ? Number(rowsWanted) : DEFAULT_TRACE_TABLE_ROWS);
			const modes = content.improvementBrief.modes.filter((mode) => mode.selectableForProposal);
			if (modes.length > 0 && options.sendUserMessage && typeof ctx.ui.select === "function") {
				const titleOf = (mode: (typeof modes)[number]): string => oneLine(failureModeReading(mode).title, 60);
				// The failure mode's own id decides which change is prepared. Two
				// modes whose titles read alike after `oneLine(…, 60)` used to send
				// `/fix` to whichever came first in the list.
				const offered = modes.slice(0, 5);
				const picked = await choose(ctx, t("traces.prepare"), [
					// Reading traces must stay free when Enter accepts the default.
					{ id: NOT_NOW, label: () => t("traces.not-now") },
					...offered.map((mode) => ({
						id: mode.failureModeId,
						label: () => t("traces.fix-choice", { ordinal: mode.ordinal, title: titleOf(mode) }),
					})),
				], { signal });
				const mode = offered.find((candidate) => candidate.failureModeId === picked);
				if (mode) {
					options.sendUserMessage(t("traces.fix-message", { ordinal: mode.ordinal, id: mode.failureModeId, title: titleOf(mode) }));
				}
			}
		},
	});

	registerCommand("review", {
		description: t("cmd.review"),
		async handler(args, ctx) {
			noArguments("review", args);
			const signal = await prepare(ctx, "review");
			const view = await workbench.view({ aspect: "review" });
			const lines = view.detail?.aspect === "review"
				? renderReview(view.detail.content, markerPaint)
				: renderStatus(view, markerPaint, { heading: false });
			presenter.show(ctx, { title: viewTitle(view), tone: view.blockers.length > 0 ? "warning" : "info", lines });
			await offerReviewActions(ctx, view, signal);
		},
	});

	registerCommand("approve", {
		description: t("cmd.approve"),
		async handler(args, ctx) {
			const signal = await prepare(ctx, "approve");
			await simpleDecision(ctx, "approve", { kind: "approve-spec", reason: reasonOrDefault(args, "approve") }, signal);
		},
	});

	registerCommand("publish", {
		description: t("cmd.publish"),
		async handler(args, ctx) {
			const signal = await prepare(ctx, "publish");
			const name = args.trim();
			await simpleDecision(ctx, "publish", { kind: "publish-corpus", ...(name ? { name } : {}), reason: t("reason.interactive", { command: "publish" }) }, signal);
		},
	});

	registerCommand("apply", {
		description: t("cmd.apply"),
		async handler(args, ctx) {
			const signal = await prepare(ctx, "apply");
			const parsed = parseApply(args);
			await applyProposal(ctx, signal, parsed.branch, parsed.reason);
		},
	});

	registerCommand("discard", {
		description: t("cmd.discard"),
		async handler(args, ctx) {
			const signal = await prepare(ctx, "discard");
			await discardCurrent(ctx, signal, reasonOrDefault(args, "discard"));
		},
	});

	registerCommand("promote", {
		description: t("cmd.promote"),
		async handler(args, ctx) {
			const signal = await prepare(ctx, "promote");
			const parsed = parsePromote(args);
			await promoteCurrent(ctx, signal, parsed.version, parsed.reason);
		},
	});

	registerCommand("reject", {
		description: t("cmd.reject"),
		async handler(args, ctx) {
			const signal = await prepare(ctx, "reject");
			await rejectCurrent(ctx, signal, reasonOrDefault(args, "reject"));
		},
	});

	registerCommand("adopt", {
		description: t("cmd.adopt"),
		async handler(args, ctx) {
			const signal = await prepare(ctx, "adopt");
			await simpleDecision(ctx, "adopt", { kind: "adopt-candidate", reason: reasonOrDefault(args, "adopt") }, signal);
		},
	});

	registerCommand("next", {
		description: t("cmd.next"),
		async handler(args, ctx) {
			const signal = await prepare(ctx, "next");
			await simpleDecision(ctx, "next", { kind: "continue-cycle", reason: reasonOrDefault(args, "next") }, signal);
		},
	});

	registerCommand("target", {
		description: t("cmd.target"),
		async handler(args, ctx) {
			await prepare(ctx, "target");
			const resourcePath = args.trim();
			if (/\s/.test(resourcePath)) {
				throw new Error(t("cmd.err.target-arg"));
			}
			const view = await workbench.view({ aspect: "target", ...(resourcePath ? { resourcePath } : {}) });
			const lines = view.detail?.aspect === "target"
				? renderTarget(view.detail.content, markerPaint)
				: renderStatus(view, markerPaint, { heading: false });
			presenter.show(ctx, { title: t("panel.title", { detail: resourcePath ? oneLine(resourcePath, 60) : t("panel.target") }), tone: "info", lines });
		},
	});

	/**
	 * The version passport: what the shipped agent promised, what it measured,
	 * how far its judge has been checked, and what is still unknown. It is a
	 * read of durable artifacts — nothing here runs, spends, or decides — and it
	 * lands twice: on screen now, and as a file the operator can send to someone
	 * who was not in the room.
	 */
	registerCommand("passport", {
		description: t("cmd.passport"),
		async handler(args, ctx) {
			await prepare(ctx, "passport");
			const version = args.trim();
			if (/\s/.test(version)) throw new Error(t("cmd.err.passport-arg"));
			await hostActions.execute({ kind: "passport", ...(version ? { version } : {}) }, ctx, ctx.signal);
		},
	});

	/** One run on screen — the host's facts and the conversation — then the Builder's own reading of it. */
	registerCommand("trace", {
		description: t("cmd.trace"),
		async handler(args, ctx) {
			await prepare(ctx, "trace");
			const content = await tracesDetail(ctx);
			if (!content) return;
			const evalRunId = content.evaluation.evalRunId;
			let page: EvalPageModel;
			try {
				page = evidence.evalPage(workbench.runsRoot, evalRunId);
			} catch (error) {
				presenter.show(ctx, { title: t("panel.title", { detail: t("panel.traceShort") }), tone: "warning", lines: [oneLine(t("trace.notListed", { eval: evalRunId, reason: describeError(error) }), 200)] });
				return;
			}
			const cursor = traceCursor?.evalRunId === evalRunId ? traceCursor.index : null;
			const target = resolveTraceTarget(args.trim(), page.rows, cursor);
			if (target === "end") {
				ctx.ui.notify(t("trace.noMore"), "info");
				return;
			}
			traceCursor = { evalRunId, index: target.index };
			let detail: RunDetailPageModel;
			try {
				detail = evidence.runDetail(workbench.runsRoot, target.row.runId);
			} catch (error) {
				const reason = error instanceof EvidenceNotFound
					? t("trace.refused", { reason: describeError(error) })
					: t("trace.unreadable", { reason: describeError(error) });
				presenter.show(ctx, { title: t("panel.title", { detail: t("panel.traceShort") }), tone: "warning", lines: [oneLine(reason, 200)] });
				return;
			}
			presenter.show(ctx, {
				title: t("panel.title", { detail: t("panel.trace", { run: `${oneLine(detail.run.taskId, 40)}#${detail.run.repetitionIndex}` }) }),
				tone: detail.run.outcome === "pass" ? "info" : "warning",
				lines: renderTracePanel(detail, markerPaint, { world: worldOfRun(content, detail, workbench.runsRoot) }),
			});
			// The one thing the host cannot write: a reading of the trace. The
			// Builder gets the same bounded facts and answers in the operator's words.
			presenter.note(traceNoteForModel(detail), {
				triggerTurn: true,
				label: t("note.trace", { run: `${oneLine(detail.run.taskId, 40)}#${detail.run.repetitionIndex}` }),
			});
		},
	});

	/** The growth log: every decided attempt, newest first, and the curve under it. */
	registerCommand("log", {
		description: t("cmd.log"),
		async handler(args, ctx) {
			await prepare(ctx, "log");
			const requested = args.trim();
			if (requested && !/^\d{1,3}$/.test(requested)) throw new Error(t("cmd.err.log-rows"));
			const view = await workbench.view();
			const log = compileAgentLog({
				runsRoot: workbench.runsRoot,
				projectId: workbench.projectId,
				...(view.target.id ? { targetId: view.target.id } : {}),
				...(requested ? { limit: Number(requested) } : {}),
			});
			presenter.show(ctx, { title: t("panel.title", { detail: t("panel.growth") }), tone: "info", lines: renderAgentLog(log, markerPaint) });
		},
	});

	/**
	 * The recorded dataset: every emulated conversation this Target has already
	 * had, written beside the agent as one JSONL file the operator can hand on.
	 *
	 * A read of durable evidence — nothing runs, spends, or decides — through
	 * the same application function `ahde export` uses, so the boundary is the
	 * same boundary: the sealed exam is refused on the bounded index before a
	 * single trace is opened, and the one line says so.
	 *
	 * It is `/dataset` and not `/export` because Pi owns `/export` — its own
	 * built-in writes the session out — and a built-in name never reaches an
	 * extension: session 7 met `Warning: /export is disabled by this host.` and
	 * the operator had no way to read the dataset at all. The CLI verb stays
	 * `ahde export`; only the slash command moved.
	 */
	registerCommand("dataset", {
		description: t("cmd.dataset"),
		async handler(args, ctx) {
			await prepare(ctx, "dataset");
			const requested = args.trim();
			if (requested && requested !== "--all") throw new Error(t("cmd.err.dataset-arg"));
			await hostActions.execute({ kind: "dataset", all: requested === "--all" }, ctx, ctx.signal);
		},
	});

	/**
	 * The cycle as a checklist. A pure projection of the view — the same one the
	 * header folds into a single line — enriched with the two aspects that carry
	 * the harness surface and the newest measurement. Nothing runs, nothing is
	 * written, and the Builder is told nothing.
	 */
	registerCommand("plan", {
		description: t("cmd.plan"),
		async handler(args, ctx) {
			noArguments("plan", args);
			await prepare(ctx, "plan");
			const view = await workbench.view();
			const facts: PlanFacts = {};
			try {
				const target = await workbench.view({ aspect: "target" });
				const content = target.detail?.aspect === "target" ? target.detail.content : null;
				if (content && "target" in content) {
					facts.harness = {
						tools: content.target.execution.tools.length,
						skills: content.resources.filter((resource) => resource.kind === "skill").length,
					};
				}
			} catch {
				// The plan is worth reading without the harness surface.
			}
			if (view.counts.developmentEvals > 0) {
				try {
					const traces = await workbench.view({ aspect: "traces" });
					if (traces.detail?.aspect === "traces") {
						const summary = traces.detail.content.evaluation.summary;
						facts.baseline = { pass: summary.pass, total: summary.total };
					}
				} catch {
					// An undiagnosed evaluation still counts; only its rate is missing.
				}
			}
			const workshop = options.workshopStatus?.() ?? null;
			if (workshop) facts.workshop = workshop;
			const active = jobs.active();
			if (active) facts.job = { label: active.label, progress: active.progress };
			presenter.show(ctx, {
				title: t("panel.title", { detail: t("panel.plan") }),
				tone: view.blockers.length > 0 ? "warning" : "info",
				lines: renderPlan(compilePlan(view, facts), markerPaint),
			});
		},
	});

	/** What is measuring right now, and how to stop it. */
	registerCommand("jobs", {
		description: t("cmd.jobs"),
		async handler(args, ctx) {
			noArguments("jobs", args);
			requireTui(ctx, "jobs");
			host = ctx;
			presenter.show(ctx, {
				title: t("panel.title", { detail: t("panel.background") }),
				tone: "info",
				lines: jobs.lines(),
			});
		},
	});

	/** Cancel the running measurement through the signal the Workbench honours. */
	registerCommand("stop", {
		description: t("cmd.stop"),
		async handler(args, ctx) {
			noArguments("stop", args);
			requireTui(ctx, "stop");
			host = ctx;
			if (!jobs.stop()) ctx.ui.notify(t("job.nothing-to-stop"), "info");
		},
	});

	/**
	 * Check the judge: grade n of its answers blind, then see what it said.
	 *
	 * Nothing here runs the Target, spends a token, or decides anything. What it
	 * writes is a note about an instrument — how far this judge and this operator
	 * agree — and the exercise is over in ten minutes, which is the only reason
	 * anyone ever does it.
	 */
	registerCommand("label", {
		description: t("cmd.label", { max: MAX_LABEL_SAMPLE }),
		async handler(args, ctx) {
			const signal = await prepare(ctx, "label");
			const requested = args.trim();
			if (requested && !/^\d{1,2}$/.test(requested)) {
				throw new Error(t("cmd.err.label-count", { max: MAX_LABEL_SAMPLE }));
			}
			await hostActions.execute({ kind: "label-judge", ...(requested ? { sample: Number(requested) } : {}) }, ctx, signal);
		},
	});
}

/** Counts used by the header when a decision changed evidence. */
export function describeEvidence(view: WorkbenchView): string {
	return `${pluralize(view.counts.developmentEvals, "eval run")} · ${pluralize(view.counts.openProposals, "open proposal")} · ${pluralize(view.counts.candidates, "candidate")}`;
}
