import type { ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { decisionHeadline, renderDecision } from "./render/decision.js";
import { oneLine } from "./render/format.js";
import { themePaint } from "./render/paint.js";
import { nextStep, stageLabel } from "./render/stage.js";
import { renderView, viewTitle } from "./render/view.js";
import { markerPaint, type TranscriptPresenter } from "./transcript.js";
import type {
	WorkbenchDecisionResult,
	WorkbenchTurn,
	WorkbenchView,
	WorkbenchViewInclude,
} from "../workbench/types.js";
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
				"Arguments: { aspect?: \"summary\" | \"review\" | \"traces\" | \"target\", resourcePath?: string, include?: [\"selections\"] }.",
				"aspect omitted/summary = stage + counts; review = the exact Spec draft, eval basket, proposal diff, or candidate awaiting a decision;",
				"traces = evaluation summary, failure modes (improvementBrief.modes with ordinal + failureModeId), evidence link;",
				"target = the committed Target index (resources with path/kind) — pass one returned resourcePath to read that file's complete content.",
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
				"• { kind: \"select\", entity: \"spec-draft\" | \"approved-spec\" | \"corpus-draft\" | \"development-corpus\" | \"eval-run\" | \"proposal\" | \"candidate\", id }",
				"• { kind: \"structured-proposal\", authoringContext: <claim from aspect=target>, source: { algorithmId, evalRunId, diagnosisId, briefId } (from aspect=traces), failureModeIds: [failureModeId, …], summary, intents: [intent, …], risks?: string[], validationPlan: string[] }",
				"grader = { type: \"output_contains\", text, caseSensitive? } | { type: \"output_matches\", pattern (JavaScript regex, no (?i) flags) } | { type: \"tool_called\", tool, argsContains? } | { type: \"judge\", rubric } (judge only when the Target manifest configures a judge model).",
				"intent = { type: \"instructions.replace\", content } | { type: \"skill.upsert\", name, description, body, disableModelInvocation? } | { type: \"skill.remove\", name } | { type: \"tool.upsert\", name, descriptor: { description, parameters (JSON Schema), arguments?, timeoutMs, maxOutputBytes, output: \"json\" | \"text\", permissions: { environment: string[], network: \"deny\" | \"allow\", filesystem: \"read-only\" | \"workspace-write\" } }, executable (script text starting with #!) } | { type: \"tool.remove\", name } | { type: \"execution.configure\", execution: { tools: (\"read\" | \"bash\" | \"edit\" | \"write\")[], environmentAllowlist: string[], network, sandbox: \"required\" | \"best-effort\" | \"off\" } }.",
				"This is how Target tools and skills get written: the host compiles the exact files and diff from these intents; the operator reviews and applies. Submission grants no consequential authority.",
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
				"Request one human-gated workflow transition. Call this yourself when the operator asks for the step in plain words (run, approve, publish, apply, promote, adopt, next): the host shows the exact subject and asks the operator to confirm in its own dialog before anything happens — never tell the operator to type a slash command instead. Every kind requires a non-blank `reason`.",
				"Kinds by stage: target-setup → { kind: \"scaffold-target\" } then { kind: \"configure-target\", targetId (kebab-case), model: { provider, modelId, thinkingLevel?, timeoutMs?, params? } };",
				"spec-review → { kind: \"approve-spec\", draftSpecId? }; corpus-review → { kind: \"publish-corpus\", draftId?, name? };",
				"ready-to-evaluate / improvement-authoring → { kind: \"run-current\", repetitions (3 recommended; sealed verdicts need ≥ 2) } (or run-eval), and { kind: \"calibrate\", repetitions } measures noise once per Target revision; proposal-review → { kind: \"apply-proposal\", branch } | { kind: \"discard-proposal\" };",
				"candidate-verification → { kind: \"run-current\", repetitions } (verify) | { kind: \"abandon-candidate\" } for an interrupted attempt; candidate-review → { kind: \"review-candidate\", recommendation: \"promote\" | \"reject\" };",
				"release-decision → { kind: \"promote-candidate\", version: \"x.y.z\" } | { kind: \"reject-candidate\" }; candidate-adoption → { kind: \"adopt-candidate\" }; complete → { kind: \"continue-cycle\" }.",
				"Actor identity and sealed-holdout selection stay host-owned; never add approved/confirmed/actor fields.",
			].join("\n"),
			parameters: WorkbenchDecisionToolSchema.parameters,
			prepareArguments: (args) => WorkbenchDecisionToolSchema.prepare(args),
			renderCall: (args, theme) => WORKBENCH_TOOL_RENDERERS.decide.renderCall(args, theme),
			renderResult: (result, renderOptions, theme) => WORKBENCH_TOOL_RENDERERS.decide.renderResult(result.details, renderOptions.expanded, theme),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				requireHostUI(ctx, "Workbench decision");
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
						createWorkbenchHumanGate(ctx, actorId, (operation) => requireHostUI(ctx, operation)),
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
