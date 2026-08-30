import type { ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { decisionHeadline, renderDecision } from "./render/decision.js";
import { oneLine, pluralize } from "./render/format.js";
import { themePaint } from "./render/paint.js";
import { nextStep, stageLabel } from "./render/stage.js";
import { renderDatasetCases, renderView, viewTitle } from "./render/view.js";
import { markerPaint, type TranscriptPresenter } from "./transcript.js";
import type {
	WorkbenchDatasetRecipeArtifact,
	WorkbenchDecisionResult,
	WorkbenchHumanGate,
	WorkbenchTurn,
	WorkbenchView,
	WorkbenchViewInclude,
} from "../workbench/types.js";
import { workbenchGateClass } from "../workbench/transition-policy.js";
import {
	hostModelCatalog,
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

/** Compact, theme-aware transcript cards for the three Workbench tools. */
const WORKBENCH_TOOL_RENDERERS = {
	view: {
		renderCall(args: { aspect?: string; resourcePath?: string }, theme: Theme): Component {
			const paint = themePaint(theme);
			const detail = args.resourcePath ? ` ${oneLine(args.resourcePath, 60)}` : "";
			return card([`${paint.accent("AHDE")} ${paint.dim("inspect")} ${args.aspect ?? "summary"}${detail}`]);
		},
		renderResult(details: unknown, expanded: boolean, theme: Theme): Component {
			const paint = themePaint(theme);
			if (!isWorkbenchView(details)) return card([paint.muted("Workbench view")]);
			if (!expanded) {
				return card([`${paint.bold(viewTitle(details))} ${paint.dim("·")} ${nextStep(details)}`]);
			}
			return card(renderView(details, paint, { maxDiffLines: 120, maxTasks: 12 }));
		},
	},
	submit: {
		renderCall(args: { kind?: string }, theme: Theme): Component {
			const paint = themePaint(theme);
			return card([`${paint.accent("AHDE")} ${paint.dim("author")} ${args.kind ?? "submission"}`]);
		},
		renderResult(details: unknown, expanded: boolean, theme: Theme): Component {
			const paint = themePaint(theme);
			if (!isWorkbenchTurn(details)) return card([paint.muted("Workbench submission")]);
			const lines = [`${paint.success("✓")} ${oneLine(details.message, 160)} ${paint.dim(`· now ${stageLabel(details.view.stage)}`)}`];
			// A recipe is argued about in cases, so its card shows cases, not fields.
			const recipe = details.kind === "dataset-recipe" && details.artifact
				? details.artifact as unknown as WorkbenchDatasetRecipeArtifact
				: null;
			if (recipe) {
				const shown = expanded ? recipe.sampleCases : recipe.sampleCases.slice(0, 2);
				lines.push(
					`  ${paint.dim("From")} ${oneLine(recipe.sourcePath, 70)} ${paint.dim("·")} ${pluralize(recipe.developmentCount, "case")}` +
						`${recipe.skippedRows > 0 ? paint.dim(` · ${pluralize(recipe.skippedRows, "row")} skipped`) : ""}` +
						`${recipe.sealedReserved > 0 ? paint.dim(` · ${recipe.sealedReserved} already sealed`) : ""}`,
					...renderDatasetCases(shown, paint),
				);
				if (recipe.sampleCases.length > shown.length) {
					lines.push(`  ${paint.dim(`… +${recipe.sampleCases.length - shown.length} more sample cases`)}`);
				}
				return card(lines);
			}
			if (expanded && details.artifact) {
				for (const [key, value] of Object.entries(details.artifact)) {
					if (value === null || value === undefined) continue;
					lines.push(`  ${paint.dim(key)} ${oneLine(typeof value === "string" ? value : JSON.stringify(value), 120)}`);
				}
				lines.push(`  ${paint.dim("Next")} ${nextStep(details.view)}`);
			}
			return card(lines);
		},
	},
	decide: {
		renderCall(args: { kind?: string; reason?: string }, theme: Theme): Component {
			const paint = themePaint(theme);
			return card([`${paint.accent("AHDE")} ${paint.dim("decide")} ${paint.bold(args.kind ?? "decision")}${args.reason ? ` ${paint.dim(`— ${oneLine(args.reason, 100)}`)}` : ""}`]);
		},
		renderResult(details: unknown, expanded: boolean, theme: Theme): Component {
			const paint = themePaint(theme);
			if (!isWorkbenchDecision(details)) return card([paint.muted("Workbench decision")]);
			if (!expanded) {
				return card([`${paint.success("✓")} ${decisionHeadline(details)} ${paint.dim(`· now ${stageLabel(details.view.stage)}`)}`]);
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
/** Claims the persona must echo verbatim to author its next call; never pruned. */
const VERBATIM_KEYS = new Set(["authoringContext", "claim"]);

export interface ModelProjectionOptions {
	include?: readonly WorkbenchViewInclude[];
	/** Attached to a summary view while `configure-target` is the legal next step. */
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

function projectWorkbenchView(view: Record<string, unknown>, options: ModelProjectionOptions): Record<string, unknown> {
	const { selections, warnings, ...rest } = view as { selections: unknown[]; warnings: string[] } & Record<string, unknown>;
	const kept = warnings.slice(0, MODEL_WARNING_LIMIT);
	const wanted = options.include?.includes("selections") ?? false;
	return {
		...projectForModel(rest, options) as Record<string, unknown>,
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
		projected[key] = VERBATIM_KEYS.has(key) ? item : projectForModel(item, options);
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
			label: "Inspect Builder Workbench",
			description: [
				"Read the AHDE Workbench: the current stage, legal next actions, the exact subject under review, the diagnosis, or the committed Target.",
				"Arguments: { aspect?: \"summary\" | \"review\" | \"traces\" | \"target\" | \"dataset\", resourcePath?: string, include?: [\"selections\"] }.",
				"aspect omitted/summary = stage + counts; review = the exact Spec draft, eval basket, proposal diff, or candidate awaiting a decision;",
				"traces = evaluation summary, failure modes (improvementBrief.modes with ordinal + failureModeId), evidence link;",
				"target = the committed Target index (resources with path/kind) — pass one returned resourcePath to read that file's complete content;",
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
				// configure-target is the only decision that needs a model id, and the
				// trusted host catalog is the only place those ids exist.
				const catalog = view.stage === "target-setup" && (query.aspect ?? "summary") === "summary"
					? hostModelCatalog(ctx)
					: null;
				const models = catalog && catalog.models.length > 0 ? catalog : null;
				return textResult(view, { include: include ?? [], hostModelCatalog: models });
			},
			renderCall: (args, theme) => WORKBENCH_TOOL_RENDERERS.view.renderCall(args, theme),
			renderResult: (result, renderOptions, theme) => WORKBENCH_TOOL_RENDERERS.view.renderResult(result.details, renderOptions.expanded, theme),
		}),
		defineTool({
			name: "ahde_workbench_submit",
			label: "Author in Builder Workbench",
			description: [
				"Author non-consequential Workbench artifacts. Send nested objects/arrays as JSON values (not strings). Exactly one shape per kind:",
				"• { kind: \"spec-draft\", spec: { title, purpose, users: string[], jobs: string[], inputs: string[], allowedActions: string[], successCriteria: string[], constraints: string[], openQuestions: string[] }, sourceText?: string }",
				"• { kind: \"corpus-draft\", name, tasks: [{ input, graders: [grader, …] }], coverageNotes?: string[], revisionSummary, approvedSpecId? } — every task needs ≥1 grader; no other task fields (no id/notes/expected).",
				"• { kind: \"corpus-revision\", parentDraftId?, operations: [{ type: \"add\", task } | { type: \"replace\", taskId, task } | { type: \"remove\", taskId } | { type: \"set-graders\", taskId, graders } | { type: \"grader.add\", taskId, grader } | { type: \"grader.update\", taskId, graderIndex, grader } | { type: \"grader.remove\", taskId, graderIndex } | { type: \"add-case-from-run\", evalRunId, runId, task } | { type: \"rename\", name } | { type: \"set-notes\", coverageNotes }], revisionSummary }",
				"• { kind: \"corpus-import\", sourcePath: \"imports/<file>.jsonl\", name, revisionSummary, coverageNotes? }",
				"• { kind: \"dataset-recipe\", sourcePath: \"imports/<file>\", recipe, name, revisionSummary, approvedSpecId? } — how to read any other data file (csv/tsv/json/jsonl/markdown/text/chat export) as cases. Write the recipe from aspect: \"dataset\" alone; the host re-validates it against the real columns and answers with the first compiled sample cases plus a submissionId. Nothing is imported until the operator confirms { kind: \"import-dataset\" }.",
				"recipe = { schemaVersion: 1, input?: { column } | { template: \"…{{column}}…\" }, expected?: { column }, dialogue?: { column }, metadata?: [column, …], filters?: [{ column, equals } | { column, matches }], sample?: { limit, seed, stratifyBy? }, graders: [grader, …], idPrefix? } — needs input or dialogue; grader text may use {{column}} and {{expected}}.",
				"• { kind: \"select\", entity: \"spec-draft\" | \"approved-spec\" | \"corpus-draft\" | \"development-corpus\" | \"eval-run\" | \"proposal\" | \"candidate\", id }",
				"• { kind: \"workshop-open\" } — open your only writable surface: a private copy of the exact clean Target revision, scoped to AGENTS.md, skills/**, tools/**, bin/**, data/**. While it is open you also have ahde_workshop_read / _write / _bash / _try; write the change, run it, fix it, run it again. It is not the operator's checkout and nothing in it is applied.",
				"• { kind: \"workshop-close\", source: { algorithmId, evalRunId, diagnosisId, briefId } (from aspect=traces), failureModeIds: [failureModeId, …], summary, risks?: string[], validationPlan: string[] } — compile the workshop's diff into the exact reviewable proposal. The host derives every path, mode, hash and diff from what is on disk; a workshop that changed nothing or touched anything out of scope is refused by path.",
				"• { kind: \"workshop-discard\" } — throw the open workshop away; nothing it wrote ever existed.",
				"• { kind: \"structured-proposal\", authoringContext: <claim from aspect=target>, source: { algorithmId, evalRunId, diagnosisId, briefId } (from aspect=traces), failureModeIds: [failureModeId, …], summary, intents: [intent, …], risks?: string[], validationPlan: string[] } — the second path: cheaper for a single-file edit you have no reason to run, and the only way to change the Target's execution policy.",
				"grader = { type: \"output_contains\", text, caseSensitive? } | { type: \"output_matches\", pattern (JavaScript regex, no (?i) flags) } | { type: \"tool_called\", tool, argsContains? } | { type: \"judge\", rubric? , assertions?: string[] (yes/no checks, one behaviour each; needs rubric or assertions), jury?: 1-5, withReference? } | { type: \"exact\", normalize? } | { type: \"similarity\", metric: \"token-f1\" | \"levenshtein\", threshold } (judge only when the Target manifest configures a judge model; exact, similarity and judge withReference need the case's expected answer).",
				"intent = { type: \"instructions.replace\", content } | { type: \"skill.upsert\", name, description, body, disableModelInvocation? } | { type: \"skill.remove\", name } | { type: \"tool.upsert\", name, descriptor: { description, parameters (JSON Schema), arguments?, timeoutMs, maxOutputBytes, output: \"json\" | \"text\", permissions: { environment: string[], network: \"deny\" | \"allow\", filesystem: \"read-only\" | \"workspace-write\" } }, executable (script text starting with #!) } | { type: \"tool.remove\", name } | { type: \"execution.configure\", execution: { tools: (\"read\" | \"bash\" | \"edit\" | \"write\")[], environmentAllowlist: string[], network, sandbox: \"required\" | \"best-effort\" | \"off\" } }.",
				"This is how Target tools and skills get written: open a workshop, write and run them there, and close it — or, for a one-file edit, express intents and let the host compile them. Either way the operator reviews and applies the exact diff. Submission grants no consequential authority.",
			].join("\n"),
			parameters: WorkbenchSubmitToolSchema.parameters,
			prepareArguments: (args) => WorkbenchSubmitToolSchema.prepare(args),
			async execute(_id, params, signal) {
				abortIfRequested(signal);
				const turn = await workbench.submit(params, { signal });
				await changed();
				return textResult(turn);
			},
			renderCall: (args, theme) => WORKBENCH_TOOL_RENDERERS.submit.renderCall(args, theme),
			renderResult: (result, renderOptions, theme) => WORKBENCH_TOOL_RENDERERS.submit.renderResult(result.details, renderOptions.expanded, theme),
		}),
		defineTool({
			name: "ahde_workbench_decide",
			label: "Decide in Builder Workbench",
			description: [
				"Do the work the operator asked for. Call this yourself when they say it in plain words (test, run, check, fix it, apply, ship, next) — never tell them to type a slash command instead. Every kind requires a non-blank `reason`.",
				"Three kinds ask the operator a question; the rest just happen. Prefer these three:",
				"• { kind: \"run-current\", repetitions (3 recommended; a sealed verdict needs ≥ 2) } — “test it”, wherever they are. At spec-review/corpus-review it becomes start-testing (approve + publish + run in one question); at ready-to-evaluate/improvement-authoring it runs the basket without asking; at candidate-verification it verifies the applied candidate without asking. An unusually expensive run asks once.",
				"• { kind: \"apply-proposal\", runId?, branch } — the only moment a diff touches the repository; the host shows the exact diff.",
				"• { kind: \"ship\", version: \"x.y.z\" } — “ship it”: records the promote review, tags the exact revision, fast-forwards the operator's branch, and closes the cycle, in one question. `version` is required while the promotion is still pending; at candidate-adoption/complete it is optional.",
				"Also available: { kind: \"start-testing\", repetitions } explicitly; { kind: \"calibrate\", repetitions } measures noise once per Target revision (no question); { kind: \"discard-proposal\" } and { kind: \"reject-candidate\" } and { kind: \"abandon-candidate\" } are one short yes/no.",
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
			renderResult: (result, renderOptions, theme) => WORKBENCH_TOOL_RENDERERS.decide.renderResult(result.details, renderOptions.expanded, theme),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				// Routine measurement may run headless; anything that can create
				// durable authority still needs the local TUI, and the policy on each
				// confirmation enforces that again at the moment of the decision.
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
				const showsRunProgress = params.kind === "run-current" ||
					params.kind === "run-eval" ||
					params.kind === "calibrate" ||
					params.kind === "verify-candidate";
				const observation = showsRunProgress
					? await beginBuilderRunObservation(ctx.ui, options.beginLiveTrace)
					: null;
				let outcome: BuilderLiveTraceOutcome = "error";
				try {
					const resolveTargetModel = targetModelSelection && targetCredentialEnvironment
						? targetModelResolver(ctx, targetCredentialEnvironment)
						: undefined;
					const result = await workbench.decide(
						params,
						createPolicyAwareGate(ctx, actorId, guard, undefined, sealedGuard),
						{
							signal,
							...(observation ? { onRunEvent: observation.onRunEvent } : {}),
							...(resolveTargetModel ? { resolveTargetModel } : {}),
						},
					);
					outcome = "completed";
					if (options.presenter) {
						try {
							options.presenter.show(ctx, {
								title: `${decisionHeadline(result)}`,
								tone: "success",
								lines: renderDecision(result, markerPaint, { liveTraceUrl: observation?.liveTraceUrl ?? null }),
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
								`Live trace retained for 15 minutes: ${observation.liveTraceUrl}`,
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
