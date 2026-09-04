import type {
	AgentToolResult,
	ExtensionContext,
	Theme,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { decisionHeadline, renderDecision } from "./render/decision.js";
import { oneLine, wrap } from "./render/format.js";
import { themePaint } from "./render/paint.js";
import { nextStep, stageLabel } from "./render/stage.js";
import { renderDatasetCases, renderReview, renderView, viewTitle } from "./render/view.js";
import { hasMessage, plural, t } from "../i18n.js";
import { renderVersionPassport } from "./render/passport.js";
import { renderExecutiveVersionCard } from "./render/version-card.js";
import { renderAgentLogChart } from "./render/agent-log.js";
import { handoffLines } from "./render/handoff.js";
import { compileAgentLog } from "../application/agent-log.js";
import { renderWorkshopCloseReview } from "./render/workshop-close.js";
import type { ToolFixtureRunResult } from "../application/tool-workshop.js";
import { markerPaint, type TranscriptPresenter } from "./transcript.js";
import type {
	WorkbenchConfirmation,
	WorkbenchDatasetRecipeArtifact,
	WorkbenchDecisionResult,
	WorkbenchHumanGate,
	WorkbenchTurn,
	WorkbenchView,
	WorkbenchViewInclude,
} from "../workbench/types.js";
import { workbenchGateClass } from "../workbench/transition-policy.js";
import { workbenchNext } from "../workbench/next-actions.js";
import {
	evaluatorModelResolver,
	hostDefaultJudge,
	hostModelCatalog,
	selectEvaluatorCredentialEnvironment,
	selectTargetCredentialEnvironment,
	targetModelResolver,
	type HostModelCatalog,
} from "./onboarding.js";
import {
	createAhdeWorkbench,
	type AhdeWorkbench,
	type AhdeWorkbenchDependencies,
} from "../workbench/workbench.js";

function isWorkbenchView(value: unknown): value is WorkbenchView {
	return typeof value === "object" && value !== null &&
		(value as { schemaVersion?: unknown }).schemaVersion === 1 &&
		typeof (value as { stage?: unknown }).stage === "string" &&
		typeof (value as { headline?: unknown }).headline === "string" &&
		typeof (value as { counts?: unknown }).counts === "object";
}

function isWorkbenchTurn(value: unknown): value is WorkbenchTurn {
	return typeof value === "object" && value !== null &&
		typeof (value as { kind?: unknown }).kind === "string" &&
		typeof (value as { message?: unknown }).message === "string" &&
		isWorkbenchView((value as { view?: unknown }).view);
}

function isWorkbenchDecision(value: unknown): value is WorkbenchDecisionResult {
	return isWorkbenchTurn(value) && typeof (value as { result?: unknown }).result === "object";
}

function card(lines: readonly string[]): Component {
	return new Text(lines.join("\n"), 0, 0);
}

/**
 * A refused tool call, on screen. Pi hands a thrown tool the reason as text
 * and an empty `details`, so every collapsed card used to fall through to its
 * own label — “Workbench submission” — and the only account of the refusal the
 * human ever read was the Builder's paraphrase of it.
 *
 * The first line is the sentence the host wrote; the rest is stack and
 * context the transcript does not owe anyone.
 */
export function refusalCard(
	result: AgentToolResult<unknown>,
	theme: Theme,
	/** What was refused — a path, an argv, a tool name — when the card has one to show. */
	subject?: string,
): Component {
	const paint = themePaint(theme);
	const reason = result.content
		.flatMap((part) => (part.type === "text" ? part.text.split("\n") : []))
		.map((line) => line.trim())
		.find((line) => line.length > 0) ?? "";
	const named = subject ? `${paint.bold(subject)} ` : "";
	// A refusal is the operator's whole account of what did not happen, so it
	// wraps instead of being cut: `name a file, for example bi…` is not advice,
	// and a validation error cut at `/tasks/3/gr…` is not a repair instruction.
	// Line breaks the host put in survive, so a list stays a list.
	const said = hostRefusal(reason);
	const [head, ...rest] = wrap([...said].length > 600 ? `${[...said].slice(0, 599).join("")}…` : said, 120);
	return card([`${paint.error("✗")} ${named}${head ?? ""}`, ...rest.map((line) => `  ${line}`)]);
}

/**
 * The refusals the host words itself, bent into the operator's language.
 *
 * The Workbench mints one English sentence for the model, scripts and tests;
 * this is the one place it is turned into something a person who has never
 * seen AHDE can act on. Anything not matched here still reaches the card in
 * English, which is why the list grows rather than the Workbench bending.
 */
function hostRefusal(reason: string): string {
	if (/ was declined by the human operator$/.test(reason)) return t("refusal.declined");
	if (/^No compatible development EvalRun is available/.test(reason)) return t("refusal.nothing-yet");
	const nothing = /^No compatible (.+?) is available/.exec(reason);
	if (nothing) return t("refusal.nothing-of-kind", { kind: artifactLabel(nothing[1] ?? "") });
	const several = /^Several compatible (.+?) artifacts exist/.exec(reason);
	if (several) return t("refusal.pick-one", { kind: artifactLabel(several[1] ?? "") });
	if (/ subject changed after confirmation; the decision is stale$/.test(reason)) return t("refusal.stale");
	if (/^Target is not ready\b/.test(reason)) {
		return t("refusal.target-not-ready", { next: t("next.target-setup") });
	}
	const running = /^running is not possible during ([a-z-]+)/.exec(reason);
	if (running) return stageRefusal(running[1] ?? "");
	// A workshop refusal already has the offending path bolded beside it on the
	// card, so the operator's half never repeats it.
	if (/^workshop scope refuses .*: a workshop addresses AGENTS\.md/.test(reason)) {
		return t("refusal.workshop-out-of-scope", { scope: WORKSHOP_SCOPE_WORDS });
	}
	// A Target that declares `harness.files` is refused in the words of its own
	// declaration; the scope the sentence names is the only one that helps.
	const declaredScope = /^workshop scope refuses .*: this Target's harness declares (.+?); a workshop addresses/.exec(reason);
	if (declaredScope) return t("refusal.workshop-declared-scope", { scope: declaredScope[1] ?? "" });
	if (/^workshop scope refuses .*: a workshop path is a safe relative POSIX path/.test(reason)) {
		return t("refusal.workshop-unsafe-path");
	}
	// A rejected submission is a schema failure the MODEL repairs, so the
	// JSON pointers stay exactly as they are — one per line, all of them. What
	// the operator gets is the sentence in front of them: which artifact, and
	// how many fields, instead of a pointer list cut at `/tasks/3/gr…`.
	const invalid = /^(\S+) is invalid — ([\s\S]+?)\. Nested objects and arrays must be JSON values, not strings\.$/.exec(reason);
	if (invalid) {
		const pointers = (invalid[2] ?? "").split(";").map((item) => item.trim()).filter((item) => item.length > 0);
		return [
			t("refusal.submission-invalid", { kind: artifactLabel(invalid[1] ?? ""), fields: pointers.length }),
			...pointers,
		].join("\n");
	}
	return reason;
}

/** The four directories a workshop addresses, as one phrase for the refusal. */
const WORKSHOP_SCOPE_WORDS = "skills/, tools/, bin/, data/";

/** The Workbench's own artifact words, in the operator's vocabulary. */
function artifactLabel(kind: string): string {
	const key = `artifact.${kind.trim().toLowerCase().replace(/\s+/g, "-")}`;
	return hasMessage(key) ? t(key) : kind;
}

/** `running is not possible during spec-review` and its kin, said as a next step. */
function stageRefusal(stage: string): string {
	const label = `stage.${stage}`;
	const next = `next.${stage}`;
	if (!hasMessage(label) || !hasMessage(next)) return t("refusal.not-now", { stage, next: "" }).trim();
	return t("refusal.not-now", { stage: t(label), next: t(next) });
}

/** Compact, theme-aware transcript cards for the three Workbench tools. */
const WORKBENCH_TOOL_RENDERERS = {
	view: {
		renderCall(args: { aspect?: string; resourcePath?: string }, theme: Theme): Component {
			const paint = themePaint(theme);
			const detail = args.resourcePath ? ` ${oneLine(args.resourcePath, 60)}` : "";
			return card([`${paint.accent("AHDE")} ${paint.dim(`· ${t("card.inspect")}`)} ${args.aspect ?? "summary"}${detail}`]);
		},
		renderResult(details: unknown, expanded: boolean, theme: Theme): Component {
			const paint = themePaint(theme);
			if (!isWorkbenchView(details)) return card([paint.muted(t("card.unreadable.view"))]);
			if (!expanded) {
				return card([`${paint.bold(viewTitle(details))} ${paint.dim("·")} ${nextStep(details)}`]);
			}
			return card(renderView(details, paint, { maxDiffLines: 120, maxTasks: 12 }));
		},
	},
	submit: {
		renderCall(args: { kind?: string }, theme: Theme): Component {
			const paint = themePaint(theme);
			return card([`${paint.accent("AHDE")} ${paint.dim(`· ${t("card.author")}`)} ${args.kind ?? "submission"}`]);
		},
		renderResult(details: unknown, expanded: boolean, theme: Theme): Component {
			const paint = themePaint(theme);
			if (!isWorkbenchTurn(details)) return card([paint.muted(t("card.unreadable.submit"))]);
			const lines = [`${paint.success("✓")} ${oneLine(details.message, 160)} ${paint.dim(`· ${t("card.now", { stage: stageLabel(details.view.stage) })}`)}`];
			// A recipe is argued about in cases, so its card shows cases, not fields.
			const recipe = details.kind === "dataset-recipe" && details.artifact
				? details.artifact as unknown as WorkbenchDatasetRecipeArtifact
				: null;
			if (recipe) {
				const shown = expanded ? recipe.sampleCases : recipe.sampleCases.slice(0, 2);
				lines.push(
					`  ${paint.dim(t("card.from"))} ${oneLine(recipe.sourcePath, 70)} ${paint.dim("·")} ${plural(recipe.developmentCount, "case")}` +
						`${recipe.skippedRows > 0 ? paint.dim(` ${t("card.skipped", { rows: plural(recipe.skippedRows, "row") })}`) : ""}` +
						`${recipe.sealedReserved > 0 ? paint.dim(` ${t("card.already-sealed", { count: recipe.sealedReserved })}`) : ""}`,
					...renderDatasetCases(shown, paint),
				);
				if (recipe.sampleCases.length > shown.length) {
					lines.push(`  ${paint.dim(t("card.more-samples", { count: recipe.sampleCases.length - shown.length }))}`);
				}
				return card(lines);
			}
			if (expanded && details.artifact) {
				for (const [key, value] of Object.entries(details.artifact)) {
					if (value === null || value === undefined) continue;
					lines.push(`  ${paint.dim(key)} ${oneLine(typeof value === "string" ? value : JSON.stringify(value), 120)}`);
				}
				lines.push(`  ${paint.dim(t("label.next"))} ${nextStep(details.view)}`);
			}
			return card(lines);
		},
	},
	decide: {
		renderCall(args: { kind?: string; reason?: string }, theme: Theme): Component {
			const paint = themePaint(theme);
			return card([`${paint.accent("AHDE")} ${paint.dim(`· ${t("card.decide")}`)} ${paint.bold(args.kind ?? "decision")}${args.reason ? ` ${paint.dim(`— ${oneLine(args.reason, 100)}`)}` : ""}`]);
		},
		renderResult(details: unknown, expanded: boolean, theme: Theme): Component {
			const paint = themePaint(theme);
			if (!isWorkbenchDecision(details)) return card([paint.muted(t("card.unreadable.decide"))]);
			if (!expanded) {
				return card([`${paint.success("✓")} ${decisionHeadline(details)} ${paint.dim(`· ${t("card.now", { stage: stageLabel(details.view.stage) })}`)}`]);
			}
			return card(renderDecision(details, paint));
		},
	},
} as const;
import type { BuilderProjectContext } from "./project-context.js";
import { createWorkbenchHumanGate } from "./workbench-gate.js";
import {
	WorkbenchDecisionToolSchema,
	WorkbenchSubmitToolSchema,
	WorkbenchViewToolSchema,
} from "./workbench-transport.js";
import {
	beginBuilderRunObservation,
	type BeginBuilderLiveTrace,
	type BuilderLiveTraceOutcome,
} from "./run-observation.js";
import { compileBuilderPassport } from "./passport-presentation.js";

/** One tool result on screen: what it produced, or why it refused. */
function renderToolResult(
	renderer: (details: unknown, expanded: boolean, theme: Theme) => Component,
	result: AgentToolResult<unknown>,
	renderOptions: ToolRenderResultOptions,
	theme: Theme,
	/** Pi's render context, of which only this one fact reaches a card. */
	context: { isError: boolean },
): Component {
	if (context.isError) return refusalCard(result, theme);
	return renderer(result.details, renderOptions.expanded, theme);
}

type RegisteredWorkbenchTool = ToolDefinition<TSchema, unknown>;

/**
 * The Workbench dependency bag as the Builder extension composes it, plus the
 * host-owned actor identity the extension keeps for itself. Every Workbench
 * dependency passes straight through; the previous field-by-field copy silently
 * dropped the seven it had never been updated for.
 */
export type BuilderWorkbenchDependencies = Partial<AhdeWorkbenchDependencies> & { actorId: () => string };

export function createBuilderWorkbench(
	options: BuilderProjectContext & { templateDir?: string },
	dependencies: BuilderWorkbenchDependencies,
): AhdeWorkbench {
	const { actorId: _hostActor, ...workbenchDependencies } = dependencies;
	return createAhdeWorkbench({ ...options, dependencies: workbenchDependencies });
}

function abortIfRequested(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("operation aborted");
}

/** At most this many warnings reach the model; the header shows every one to the human. */
const MODEL_WARNING_LIMIT = 3;
/** Digest fields the persona is forbidden to quote and no tool call ever accepts back. */
const DIGEST_KEY = /(?:hash|sha256)$/i;
/** Credential references are useful to the human renderer, never to Builder Pi. */
const HOST_CREDENTIAL_KEYS = new Set(["apiKeyEnv", "credentialEnv"]);
/** Claims the persona must echo verbatim to author its next call; never pruned. */
const VERBATIM_KEYS = new Set(["authoringContext", "claim"]);

export interface ModelProjectionOptions {
	include?: readonly WorkbenchViewInclude[];
	/** Attached while a summary view can configure or replace a Target/evaluator model. */
	hostModelCatalog?: HostModelCatalog | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeWorkbenchView(value: Record<string, unknown>): boolean {
	return value.schemaVersion === 1 &&
		typeof value.stage === "string" &&
		Array.isArray(value.selections) &&
		isRecord(value.counts);
}

/** Preserve every echo-required claim field, including digests, except host credential references. */
function projectCredentialSafeVerbatim(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(projectCredentialSafeVerbatim);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !HOST_CREDENTIAL_KEYS.has(key))
			.map(([key, item]) => [key, projectCredentialSafeVerbatim(item)]),
	);
}

function projectWorkbenchView(view: Record<string, unknown>, options: ModelProjectionOptions): Record<string, unknown> {
	// `actions` is the host's loose stage hint list; the model gets `next`
	// instead, derived from the same tables the Workbench refuses against. Two
	// lists of what to do next is one list too many.
	const { selections, warnings, actions: _hostHints, ...rest } = view as
		{ selections: unknown[]; warnings: string[]; actions: unknown } & Record<string, unknown>;
	const kept = warnings.slice(0, MODEL_WARNING_LIMIT);
	const wanted = options.include?.includes("selections") ?? false;
	return {
		...projectForModel(rest, options) as Record<string, unknown>,
		next: workbenchNext(view as unknown as WorkbenchView),
		warnings: kept,
		...(warnings.length > kept.length ? { omittedWarnings: warnings.length - kept.length } : {}),
		...(wanted
			? { selections: projectForModel(selections, options) }
			: selections.length > 0
				? { selections: `${selections.length} selectable artifacts; call again with include: ["selections"]` }
				: {}),
		...(options.hostModelCatalog ? { hostModelCatalog: options.hostModelCatalog } : {}),
	};
}

/**
 * The one place that decides what the model sees. The human renderers read
 * `details` and keep the whole view; the model gets the same object without the
 * bulk it cannot act on (the selection list) and without digests it must never
 * quote back. Ids, claims, and every workflow field survive untouched.
 */
export function projectForModel(value: unknown, options: ModelProjectionOptions = {}): unknown {
	if (Array.isArray(value)) return value.map((item) => projectForModel(item, options));
	if (!isRecord(value)) return value;
	if (looksLikeWorkbenchView(value)) return projectWorkbenchView(value, options);
	const projected: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (DIGEST_KEY.test(key)) continue;
		if (HOST_CREDENTIAL_KEYS.has(key)) continue;
		projected[key] = VERBATIM_KEYS.has(key)
			? projectCredentialSafeVerbatim(item)
			: projectForModel(item, options);
	}
	return projected;
}

function textResult(
	details: unknown,
	options: ModelProjectionOptions = {},
): { content: { type: "text"; text: string }[]; details: unknown } {
	return { content: [{ type: "text", text: JSON.stringify(projectForModel(details, options), null, 2) }], details };
}

function requireHostUI(ctx: ExtensionContext, operation: string): void {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		throw new Error(`${operation} requires a local TUI host confirmation; RPC, print, and JSON execution fail closed`);
	}
}

/**
 * The host obeys the gate policy the Workbench put on each confirmation:
 *
 * - `consequential` — the full dialog with the exact subject;
 * - `one-question` — the single sentence, nothing else;
 * - `routine` — no dialog at all. The operator asking for the work is the
 *   permission, so this is also the only class that may run headless: a
 *   platform integration can measure without a TUI, and everything that creates
 *   durable authority still fails closed outside one.
 */
export function createPolicyAwareGate(
	ctx: ExtensionContext,
	actorId: () => string,
	requireInteractive: (operation: string) => void,
	sealedSelectionOperation?: string,
	/**
	 * Guard for the sealed-holdout picker. It is the requested decision that
	 * decides whether picking a holdout may run headless (a routine verification
	 * picks its own), while every confirmation below is guarded by its OWN
	 * policy — a routine request can auto-chain into a consequential composite,
	 * and that composite must still meet the local TUI.
	 */
	requireInteractiveForSealed: (operation: string) => void = requireInteractive,
): WorkbenchHumanGate {
	const dialog = createWorkbenchHumanGate(ctx, actorId, requireInteractive, sealedSelectionOperation);
	const sealedDialog = requireInteractiveForSealed === requireInteractive
		? dialog
		: createWorkbenchHumanGate(ctx, actorId, requireInteractiveForSealed, sealedSelectionOperation);
	return {
		async confirm(confirmation, signal) {
			if (confirmation.policy === "routine") return { approved: true, actorId: actorId() };
			if (confirmation.policy === "one-question") {
				requireInteractive(confirmation.kind);
				const approved = await ctx.ui.confirm(confirmation.title, confirmation.question, { signal });
				return approved ? { approved: true, actorId: actorId() } : { approved: false };
			}
			return dialog.confirm(confirmation, signal);
		},
		selectSealed: (request, signal) => sealedDialog.selectSealed(request, signal),
	};
}

export interface BuilderWorkbenchToolOptions {
	beginLiveTrace?: BeginBuilderLiveTrace;
	/** Shows the human rendering of model-driven decisions in the transcript. */
	presenter?: TranscriptPresenter;
	/** Invoked after a decision changed Workbench state (header refresh). */
	onWorkbenchChanged?: () => void | Promise<void>;
	/** Host handoff from Builder Pi to the isolated interactive Target Pi. */
	onTalkToTarget?: () => void | Promise<void>;
}

export function createBuilderWorkbenchTools(
	workbench: AhdeWorkbench,
	actorId: () => string,
	options: BuilderWorkbenchToolOptions = {},
): readonly RegisteredWorkbenchTool[] {
	const changed = async (): Promise<void> => {
		try {
			await options.onWorkbenchChanged?.();
		} catch {
			// Header refresh is cosmetic.
		}
	};
	return [
		defineTool({
			name: "ahde_workbench_view",
			executionMode: "sequential",
			label: "Inspect Builder Workbench",
			description: [
				"Read the AHDE Workbench: the current stage, the exact subject under review, the diagnosis, the committed Target, or what was already tried.",
				"Every result carries next: { unblock, decide[], submit[], workshop? } — exactly the decisions and submissions that are legal right here, each with one sentence saying when it is the right move, and asks: true where the host will put a question to the operator. It is authoritative; never work from a remembered sequence of stages.",
				"Arguments: { aspect?: \"summary\" | \"review\" | \"traces\" | \"target\" | \"history\" | \"dataset\", resourcePath?: string, include?: [\"selections\"] }.",
				"aspect omitted/summary = stage + counts; review = the exact Spec draft, eval basket, proposal diff, or candidate awaiting a decision;",
				"traces = evaluation summary, failure modes (improvementBrief.modes with ordinal + failureModeId), evidence link;",
				"each mode is one cause across tasks — the check and the tool it names — and carries facts (what the traces show, counted), observations, and evidence[].excerpt: the tools that run called, its last reply, and what the host observed about it. Read the excerpts before you write anything;",
				"target = the committed Target index (resources with path/kind) — pass one returned resourcePath to read that file's complete content;",
				"it also carries priorAttempts: the newest earlier attempts on this agent (what each changed, which failure modes it aimed at, what it scored, how it ended) plus priorAttemptsOmitted;",
				"history = the same memory in full: every recorded attempt on this Target, newest first, with omitted and unreadable counts. Read it before proposing and never re-run an experiment that already lost;",
				"dataset = a bounded preview of one operator-provided file in the imports/ inbox — pass resourcePath: \"imports/<file>\" (csv, tsv, json, jsonl, md, txt);",
				"it returns the format, the columns with inferred types and three sample values each, the row count, and how many rows a sealed slice already reserved.",
				"You never read imports/ yourself, and rows held out for the sealed exam are removed before the preview is computed.",
				"include: [\"selections\"] adds the selectable-artifact ids that kind: select needs; omit it otherwise.",
				"Call this before relying on remembered state; operator slash commands change state between your turns.",
			].join(" "),
			parameters: WorkbenchViewToolSchema.parameters,
			prepareArguments: (args) => WorkbenchViewToolSchema.prepare(args),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				const { include, ...query } = params;
				const view = await workbench.view(query);
				// configure-target and configure-evaluators are the decisions that need
				// a model id, and the trusted host catalog is the only place those ids
				// exist. It rides along while either is still the next thing to do.
				const evaluatorConfigurationLegal = view.actions.includes("configure-evaluators");
				const catalog = (view.stage === "target-setup" || evaluatorConfigurationLegal) &&
						(query.aspect ?? "summary") === "summary"
					? hostModelCatalog(ctx)
					: null;
				const models = catalog && catalog.models.length > 0 ? catalog : null;
				return textResult(view, { include: include ?? [], hostModelCatalog: models });
			},
			renderCall: (args, theme) => WORKBENCH_TOOL_RENDERERS.view.renderCall(args, theme),
			renderResult: (result, renderOptions, theme, context) => renderToolResult(WORKBENCH_TOOL_RENDERERS.view.renderResult, result, renderOptions, theme, context),
		}),
		defineTool({
			name: "ahde_workbench_submit",
			executionMode: "sequential",
			label: "Author in Builder Workbench",
			description: [
				"Author non-consequential Workbench artifacts. Send nested objects/arrays as JSON values (not strings). Exactly one shape per kind:",
				"• { kind: \"spec-draft\", spec: { title, purpose, users: string[], jobs: string[], inputs: string[], allowedActions: string[], successCriteria: string[], constraints: string[], openQuestions: string[] }, sourceText?: string }",
					"• { kind: \"corpus-draft\", name, tasks: [{ input, expected?, messages?, simulatedUser?: { goal, persona?, maxTurns, stopWhen? }, world?: { state: object, expect?: [{ path, op, value? }] }, metadata?, graders: [grader, …] }], coverageNotes?: string[], revisionSummary, approvedSpecId? } — every task needs ≥1 grader; ids are host-derived; messages and simulatedUser are mutually exclusive.",
					"A case whose expected behaviour reads a tool that consults the world — any declared tool naming AHDE_WORLD in its descriptor environment, and every declared tool when the Target is a command agent — must carry world.state holding the data that tool will find, or the tool answers that the run has no world and the case is unpassable by construction.",
				"• { kind: \"corpus-revision\", parentDraftId?, operations: [{ type: \"add\", task } | { type: \"replace\", taskId, task } | { type: \"remove\", taskId } | { type: \"set-graders\", taskId, graders } | { type: \"grader.add\", taskId, grader } | { type: \"grader.update\", taskId, graderIndex, grader } | { type: \"grader.remove\", taskId, graderIndex } | { type: \"add-case-from-run\", evalRunId, runId, task } | { type: \"rename\", name } | { type: \"set-notes\", coverageNotes }], revisionSummary }",
				"• { kind: \"corpus-import\", sourcePath: \"imports/<file>.jsonl\", name, revisionSummary, coverageNotes? }",
				"• { kind: \"production-failure\", sourcePath: \"imports/<one-trace>.json|jsonl|ndjson\", sourceKind: \"real\" | \"synthetic\", targetClaim?: { id, gitSha }, classification: { kind: \"wrong-answer\" | \"missed-tool-call\" | \"incorrect-tool-call\" | \"unsupported-claim\" | \"unsafe-action\" | \"conversation-failure\" | \"other\", summary }, case: { expected?, world?, graders: [grader, …] }, draftName?, coverageNotes?, revisionSummary, approvedSpecId?, parentDraftId? } — turn exactly one production conversation into an editable regression. The host derives input/messages from the credential-redacted trace, stamps the current Target id/SHA, keeps any external target claim separate, and treats imported tool names as reported rather than executed evidence. This submission asks nothing; /test is the single review that publishes the revised basket and runs it. Never claim this generic scrubber made arbitrary PII safe.",
				"• { kind: \"dataset-recipe\", sourcePath: \"imports/<file>\", recipe, name, revisionSummary, approvedSpecId? } — how to read any other data file (csv/tsv/json/jsonl/markdown/text/chat export) as cases. Write the recipe from aspect: \"dataset\" alone; the host re-validates it against the real columns and answers with the first compiled sample cases plus a submissionId. Nothing is imported until the operator confirms { kind: \"import-dataset\" }.",
					"recipe = { schemaVersion: 1, input?: { column } | { template: \"…{{column}}…\" }, expected?: { column }, dialogue?: { column }, simulatedUser?: { goalColumn, personaColumn?, maxTurns?, stopWhen? }, metadata?: [column, …], filters?: [{ column, equals } | { column, matches }], sample?: { limit, seed, stratifyBy? }, graders: [grader, …], idPrefix? } — needs input or dialogue; a simulatedUser recipe needs input and cannot carry dialogue; grader text may use {{column}} and {{expected}}.",
				"• { kind: \"select\", entity: \"spec-draft\" | \"approved-spec\" | \"corpus-draft\" | \"development-corpus\" | \"eval-run\" | \"proposal\" | \"candidate\", id }",
				"• { kind: \"workshop-open\", fromProposalRunId?, workshopId? } — open your only writable surface: a private copy of the exact clean Target revision, scoped to AGENTS.md, skills/**, tools/**, bin/**, data/**. While it is open you also have ahde_workshop_read / _write / _bash / _try / _author_tool; use _author_tool for a complete tested external-action package and the low-level tools for focused repairs. Nothing inside it has undeclared authority or any evals/, imports/, runs/, .git or .env to read. It opens two ways: right after the Spec is approved, to BUILD the first harness against that Spec (no evidence is cited, and the proposal records none); and after a conclusive evaluation, to IMPROVE it against the diagnosis. fromProposalRunId reopens a closed proposal seeded with its exact diff; workshopId re-attaches to a workshop a previous session left open.",
				"• { kind: \"workshop-close\", summary, validationPlan: string[], risks?: string[], source?: { algorithmId, evalRunId, diagnosisId, briefId } (from aspect=traces), failureModeIds?: [failureModeId, …], prediction?: { modes: [{ failureModeId, expectedFailingTasks, ofTasks }], expectedScoreDeltaPp?, expectedPassRateDeltaPp?, note? } } — compile the workshop's diff into the exact reviewable proposal. State the prediction in numbers on EVERY close, construction included: it is hashed into the proposal the operator applies, the next verification is read against it, and it can never be edited afterwards. A construction close names no mode — it still states the delta it expects on the next verification (expectedPassRateDeltaPp or expectedScoreDeltaPp) and names the grader families it expects to move in `note`. A construction workshop closes without source/failureModeIds; an improvement workshop needs both. The host derives every path, mode, hash and diff from one snapshot of what is on disk; a workshop that changed nothing, touched anything out of scope, or left a Git-ignored file inside the scope is refused by path.",
				"• { kind: \"workshop-discard\" } — throw the open workshop away; nothing it wrote ever existed.",
				"• { kind: \"structured-proposal\", authoringContext: <claim from aspect=target>, approvedSpecId?, source?, failureModeIds?, summary, intents: [intent, …], risks?: string[], validationPlan: string[], prediction?: { modes: [{ failureModeId, expectedFailingTasks, ofTasks }], expectedScoreDeltaPp?, expectedPassRateDeltaPp?, note? } } — the second path: cheaper for a semantic edit you have no reason to run, and the only way to change the Target's execution policy. During construction (an approved Spec, before evaluation), omit source and failureModeIds: the proposal is Spec-bound and records no invented evidence. During improvement, both are required and must come verbatim from aspect=traces.",
					"grader = { type: \"output_contains\", text, caseSensitive? } | { type: \"output_matches\", pattern (JavaScript regex, no (?i) flags) } | { type: \"tool_called\", tool, argsContains? } | { type: \"judge\", rubric? , assertions?: string[] (yes/no checks, one behaviour each; needs rubric or assertions), jury?: 1-5, withReference? } | { type: \"exact\", normalize? } | { type: \"similarity\", metric: \"token-f1\" | \"levenshtein\", threshold } | { type: \"turn_budget\", max } | { type: \"world_state\", path (dotted, e.g. accounts.42.status), op: \"equals\" | \"exists\" | \"contains\", value? } (judge only when the Target configures a judge model; exact, similarity and judge withReference need expected; turn_budget measures assistant turns; world_state reads the case's world after the conversation and needs a world on the case).",
				"intent = { type: \"instructions.replace\", content } | { type: \"skill.upsert\", name, description, body, disableModelInvocation? } | { type: \"skill.remove\", name } | { type: \"tool.upsert\", name, descriptor: { description, parameters (JSON Schema), arguments?, timeoutMs, maxOutputBytes, output: \"json\" | \"text\", permissions: { environment: string[], network: \"deny\" | \"allow\", filesystem: \"read-only\" | \"workspace-write\" } }, executable (script text starting with #!) } | { type: \"tool.remove\", name } | { type: \"execution.configure\", execution: { tools?, environmentAllowlist?, network?, sandbox?, container?: { action: \"replace\", value: { runtime, image (name@sha256:digest), platform, memoryMb?, cpus?, pidsLimit?, readOnlyRootfs? } } | { action: \"remove\" } } }. execution.configure is a patch: omitted fields are preserved. In particular, omitting container preserves its exact manifest bytes; changing or removing it requires the explicit reviewed action.",
				"aspect=target exposes the complete current non-secret execution policy, including the pinned container block, so copy authority from that exact revision instead of guessing it.",
				"This is how Target tools and skills get written: open a workshop, write and run them there, and close it — or, for a one-file edit, express intents and let the host compile them. Either way the operator reviews and applies the exact diff. Submission grants no consequential authority.",
			].join("\n"),
			parameters: WorkbenchSubmitToolSchema.parameters,
			prepareArguments: (args) => WorkbenchSubmitToolSchema.prepare(args),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				const turn = await workbench.submit(params, { signal });
				await changed();
				// A closed workshop has become a diff the operator has to decide on.
				// Put it on screen now: reading it must not depend on remembering
				// /review or ctrl+o.
				if (params.kind === "workshop-close" && options.presenter) {
					try {
						const review = await workbench.view({ aspect: "review" });
						const content = review.detail?.aspect === "review" ? review.detail.content : undefined;
						if (content?.kind === "proposal") {
							const artifact = turn.artifact as { toolTests?: ToolFixtureRunResult[] } | null;
							options.presenter.show(ctx, {
								title: viewTitle(review),
								tone: "info",
								lines: renderWorkshopCloseReview(content, artifact?.toolTests ?? [], markerPaint),
							});
						}
					} catch {
						// Showing the diff never changes what the submission returned.
					}
				}
				return textResult(turn);
			},
			renderCall: (args, theme) => WORKBENCH_TOOL_RENDERERS.submit.renderCall(args, theme),
			renderResult: (result, renderOptions, theme, context) => renderToolResult(WORKBENCH_TOOL_RENDERERS.submit.renderResult, result, renderOptions, theme, context),
		}),
		defineTool({
			name: "ahde_workbench_decide",
			executionMode: "sequential",
			label: "Decide in Builder Workbench",
			description: [
				"Do the work the operator asked for. Call this yourself when they say it in plain words (test, run, check, fix it, apply, ship, next) — never tell them to type a slash command instead. Every kind requires a non-blank `reason`.",
				"• { kind: \"talk-to-agent\", reason } — when the operator says they want to try, open, or talk to the built agent. The host leaves Builder Pi, opens the isolated Target Pi on the exact active revision, then returns to this Builder conversation when they exit.",
				"Four kinds ask the operator a question; the rest just happen. Prefer these:",
				"• { kind: \"run-current\", repetitions (3 recommended; a sealed verdict needs ≥ 2) } — “test it”, wherever they are. At spec-review/corpus-review it becomes start-testing (approve + publish + run in one question); at ready-to-evaluate/improvement-authoring it runs the basket without asking; at candidate-verification it verifies the applied candidate without asking. An unusually expensive run asks once.",
				"• { kind: \"apply-proposal\", runId?, branch, verify: { repetitions: 3 } } — the only moment a diff touches the repository; the host shows the exact diff and cost, then automatically runs the matched candidate verification. Always include verify on the conversational product path; omission exists only for low-level recovery.",
				"• { kind: \"ship\", version: \"x.y.z\" } — “ship it”: records the promote review, tags the exact revision, fast-forwards the operator's branch, and closes the cycle, in one question. `version` is required while the promotion is still pending; at candidate-adoption/complete it is optional.",
				"Also available: { kind: \"start-testing\", repetitions } explicitly; { kind: \"calibrate\", repetitions } measures noise once per Target revision (no question); { kind: \"discard-proposal\" } and { kind: \"reject-candidate\" } and { kind: \"abandon-candidate\" } are one short yes/no.",
				"• { kind: \"improve\", until (0..1 pass rate), maxCycles, repetitions, candidates?, jobs?, developmentCorpusId?, baselineMaxAgeMs?, resumeLoopId?, abandonLoopId? } — reuse or run → diagnose → author a small proposal → apply on a throwaway branch → cheap check → development verification. Builder Pi attaches a bounded private Pi author using the selected Builder model: no pre-written proposals are needed. The host discloses authoring limits and additional model spend before one confirmation. Hosts without a model author use matching recorded proposals. The exact diff, sealed guardrail and release remain human decisions; it never promotes, adopts, publishes or approves.",
				"  candidates: 2..4 asks for distinct hypotheses for the top failure mode. AHDE persists a deterministic authoring/validation split before model spend, gives the Builder only authoring cases, then screens and ranks each hypothesis on unseen validation cases. It returns a Pareto table (score delta with its interval, cost and latency ratios, which candidates are dominated) and picks nothing — show the comparison and let the operator choose. At least four reviewed cases are required. Already-lost experiments are refused. Expanded permissions require a separate human-reviewed Workshop.",
				"• { kind: \"configure-evaluators\", judge?: { provider, modelId, thinkingLevel?, timeoutMs?, params? }, simulatedUser?: same, reason } — the two models a measurement uses BESIDES the agent: the judge that grades an answer and the model that plays the user. You do not have to ask for a judge before writing judge graders: start-testing pre-fills the first host model that is not the agent's own and puts it inside the same dialog. Request this when a basket needs a simulated user, or when the operator wants a different judge, and never write those blocks into manifest.yaml yourself. Pick from the same host catalog as configure-target; the host resolves the endpoint and pricing, asks the operator which environment variable holds the key, shows the exact manifest diff, and commits. The judge may not be the Target's own model.",
				"• { kind: \"generate-holdout\", cases (15..200, default 20), seed?, mode: \"seal\" | \"review\", reason } — the exam, when the operator has no data to hold out. The Target's JUDGE writes it from the approved Spec and a seeded draw of published development cases shown for their shape; you never author, read, or guess a case, and none comes back. Offer it once when the header says the ship gate has no sealed holdout, with both modes in one sentence, and never as a substitute for real cases the operator does have. `seal` writes the sealed corpus; `review` writes a draft to a private file the operator edits and imports with /holdout, which is the honest default for a first exam. Add `source: \"kb\"` when the Target declares a knowledge base: the judge then writes every question from one passage of the agent's own documents, which is the only honest exam for an agent that answers from them. Never ask for more than `shippingReadiness.maxKbQuestions` on that source — it is what the documents can answer, and the host refuses the rest before spending. You learn the case count, the generator's name and the prompt hash — nothing else, ever.",
				"The fine-grained decisions still exist for scripts and for recovery, each with its own dialog: target-setup → { kind: \"scaffold-target\" } then { kind: \"configure-target\", targetId (kebab-case), model: { provider, modelId, thinkingLevel?, timeoutMs?, params? } };",
				"spec-review → { kind: \"approve-spec\", draftSpecId? }; corpus-review → { kind: \"publish-corpus\", draftId?, name? };",
				"corpus-design / corpus-review → { kind: \"import-dataset\", submissionId? (from a dataset-recipe submission; the newest one otherwise), sealed: { count, seed, stratifyBy? } | null } — the operator confirms the mapping on the sample cases; the host reserves the sealed slice first, compiles the rest into a new draft, and tells you only how many cases were held out.",
				"ready-to-evaluate / improvement-authoring → { kind: \"run-eval\", repetitions }; candidate-verification → { kind: \"verify-candidate\", repetitions }; candidate-review → { kind: \"review-candidate\", recommendation: \"promote\" | \"reject\" };",
				"release-decision → { kind: \"promote-candidate\", version: \"x.y.z\" }; candidate-adoption → { kind: \"adopt-candidate\" }; complete → { kind: \"continue-cycle\" }.",
				"Actor identity and sealed-holdout selection stay host-owned; never add approved/confirmed/actor fields.",
			].join("\n"),
			parameters: WorkbenchDecisionToolSchema.parameters,
			prepareArguments: (args) => WorkbenchDecisionToolSchema.prepare(args),
			renderCall: (args, theme) => WORKBENCH_TOOL_RENDERERS.decide.renderCall(args, theme),
			renderResult: (result, renderOptions, theme, context) => renderToolResult(WORKBENCH_TOOL_RENDERERS.decide.renderResult, result, renderOptions, theme, context),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				if (params.kind === "talk-to-agent") {
					requireHostUI(ctx, "Talk to agent");
					if (!options.onTalkToTarget) throw new Error("this host cannot open the interactive agent conversation");
					const view = await workbench.view();
					if (view.target.status !== "ready") throw new Error("the agent must be created and configured before it can be opened");
					if (!view.target.model?.credentialPresent) throw new Error("the agent model credential is not available in this host environment");
					await options.onTalkToTarget();
					try {
						ctx.ui.notify(t("card.opening-agent"), "info");
					} catch {
						// Handoff still proceeds when the notification surface is unavailable.
					}
					setTimeout(() => ctx.shutdown(), 0);
					return textResult({
						kind: params.kind,
						message: "The host is opening the active agent in its isolated Runtime Pi.",
						view,
					});
				}
				// Routine measurement may run headless; anything that can create
				// durable authority still needs the local TUI, and the policy on each
				// confirmation enforces that again at the moment of the decision.
				//
				const policy = workbenchGateClass(params.kind);
				if (policy !== "routine") requireHostUI(ctx, "Workbench decision");
				// Never close this over the REQUESTED kind: routine `run-current`
				// auto-chains into the consequential `start-testing` composite, and a
				// guard that already decided "routine" would let an RPC or print host
				// approve a Spec with no human in front of it. `createPolicyAwareGate`
				// re-decides per confirmation, so routine measurement still runs
				// headless — only the sealed picker follows the requested kind.
				const guard = (operation: string): void => requireHostUI(ctx, operation);
				const sealedGuard = (operation: string): void => {
					if (policy !== "routine") requireHostUI(ctx, operation);
				};
				const targetModelSelection = params.kind === "configure-target" ? params.model : null;
				const targetCredentialEnvironment = targetModelSelection
					? await selectTargetCredentialEnvironment(ctx, targetModelSelection)
					: null;
				// One host question per evaluator role, asked before the dialog and
				// never answered by the model: the value stays in the operator's
				// shell and only its NAME reaches the manifest.
				const evaluatorCredentialEnvironment: Record<"judge" | "simulatedUser", string | undefined> = {
					judge: params.kind === "configure-evaluators" && params.judge
						? await selectEvaluatorCredentialEnvironment(ctx, "judge", params.judge)
						: undefined,
					simulatedUser: params.kind === "configure-evaluators" && params.simulatedUser
						? await selectEvaluatorCredentialEnvironment(ctx, "simulatedUser", params.simulatedUser)
						: undefined,
				};
				const showsRunProgress = params.kind === "run-current" ||
					params.kind === "run-eval" ||
					params.kind === "calibrate" ||
					params.kind === "improve" ||
					(params.kind === "apply-proposal" && params.verify !== undefined) ||
					params.kind === "verify-candidate";
				const observation = showsRunProgress
					? await beginBuilderRunObservation(ctx.ui, options.beginLiveTrace)
					: null;
				let outcome: BuilderLiveTraceOutcome = "error";
				try {
					const resolveTargetModel = targetModelSelection && targetCredentialEnvironment
						? targetModelResolver(ctx, targetCredentialEnvironment)
						: undefined;
					const resolveEvaluatorModel = params.kind === "configure-evaluators"
						? evaluatorModelResolver(ctx, evaluatorCredentialEnvironment)
						: undefined;
					// The composite that starts testing may need a judge the manifest
					// does not have yet. Only the host can choose one — it holds the
					// catalog and the credential names — so it answers on demand,
					// inside the one dialog, instead of sending the operator away to
					// configure evaluators first.
					const defaultJudge = params.kind === "start-testing" || params.kind === "run-current"
						? (target: { provider: string; id: string }) => hostDefaultJudge(ctx, target)
						: undefined;
					// Every confirmation passes through the gate, routine ones included,
					// so this is where the live counter learns what the whole job plans
					// to execute rather than what one eval run does.
					const gate = createPolicyAwareGate(ctx, actorId, guard, undefined, sealedGuard);
					const reporting = observation
						? {
							...gate,
							async confirm(confirmation: WorkbenchConfirmation, confirmSignal?: AbortSignal) {
								const approval = await gate.confirm(confirmation, confirmSignal);
								if (approval.approved) observation.plan(confirmation.estimate?.executions ?? null);
								return approval;
							},
						}
						: gate;
					const result = await workbench.decide(
						params,
						reporting,
						{
							signal,
							...(observation ? { onRunEvent: observation.onRunEvent } : {}),
							...(resolveTargetModel ? { resolveTargetModel } : {}),
							...(resolveEvaluatorModel ? { resolveEvaluatorModel } : {}),
							...(defaultJudge ? { defaultJudge } : {}),
						},
					);
					outcome = "completed";
					if (options.presenter) {
						try {
							const lines = renderDecision(result, markerPaint, { liveTraceUrl: observation?.liveTraceUrl ?? null });
							// Ship is the moment the agent became a version, so the page that
							// says what it promised and what it measured is shown without
							// being asked for, and the growth line puts it beside the ones
							// before it.
							if (result.kind === "ship") {
								try {
									const { passport, card, reportWritten } = await compileBuilderPassport(workbench, { view: result.view, save: true });
									lines.push(
										"",
										...renderExecutiveVersionCard(card, markerPaint),
										reportWritten ? t("release.html.saved", { path: reportWritten }) : markerPaint.warning(t("release.html.not-saved")),
										"",
										...renderVersionPassport(passport, markerPaint),
									);
								} catch (error) {
									lines.push("", markerPaint.warning(t("result.passport-unavailable", {
										reason: oneLine(error instanceof Error ? error.message : String(error), 180),
									})));
								}
								try {
									lines.push("", ...renderAgentLogChart(compileAgentLog({
										runsRoot: workbench.runsRoot,
										projectId: workbench.projectId,
										...(result.view.target.id ? { targetId: result.view.target.id } : {}),
									}), markerPaint));
								} catch {
									// The growth line is a second look at the same evidence.
								}
							}
							lines.push(...handoffLines(result, markerPaint));
							options.presenter.show(ctx, {
								title: `${decisionHeadline(result)}`,
								tone: "success",
								lines,
							});
						} catch {
							// Human presentation never changes the decision result.
						}
					}
					await changed();
					return textResult(result);
				} catch (error) {
					if (signal?.aborted) outcome = "aborted";
					throw error;
				} finally {
					observation?.finish(outcome);
					if (observation?.liveTraceUrl) {
						try {
							ctx.ui.notify(
								t("card.live-trace-retained", { url: observation.liveTraceUrl }),
								"info",
							);
						} catch {
							// Host notification is observational and cannot change the decision.
						}
					}
				}
			},
		}),
	];
}
