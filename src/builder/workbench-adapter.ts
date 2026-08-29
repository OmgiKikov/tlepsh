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
} from "../workbench/types.js";
import type { compileHarnessAuthoringProposal } from "../application/harness-authoring.js";
import { TargetModelSelectionSchema } from "../application/target-model-selection.js";
import { selectTargetCredentialEnvironment, targetModelResolver } from "./onboarding.js";
import {
	createAhdeWorkbench,
	type AhdeWorkbench,
	type AhdeWorkbenchDependencies,
} from "../workbench/workbench.js";
import type {
	WorkbenchDecisionInput,
	WorkbenchSubmitInput,
} from "../workbench/types.js";

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
	WorkbenchDecisionParameters,
	WorkbenchSubmitParameters,
	WorkbenchViewParameters,
} from "./workbench-transport.js";
import {
	beginBuilderRunObservation,
	type BeginBuilderLiveTrace,
	type BuilderLiveTraceOutcome,
} from "./run-observation.js";

type RegisteredWorkbenchTool = ToolDefinition<TSchema, unknown>;

export interface BuilderWorkbenchDependencies {
	describeTargetScaffold: AhdeWorkbenchDependencies["describeTargetScaffold"];
	applyTargetScaffold: AhdeWorkbenchDependencies["applyTargetScaffold"];
	describeTargetBootstrap: AhdeWorkbenchDependencies["describeTargetBootstrap"];
	configureTargetBootstrap: AhdeWorkbenchDependencies["configureTargetBootstrap"];
	saveSpecDraft: AhdeWorkbenchDependencies["saveSpecDraft"];
	describeSpecApproval: AhdeWorkbenchDependencies["describeSpecApproval"];
	approveSpecDraft: AhdeWorkbenchDependencies["approveSpecDraft"];
	describeCorpusPublication: AhdeWorkbenchDependencies["describeCorpusPublication"];
	publishDevelopmentCorpus: AhdeWorkbenchDependencies["publishDevelopmentCorpus"];
	createCorpusDraft: AhdeWorkbenchDependencies["createCorpusDraft"];
	importCorpusDraft: AhdeWorkbenchDependencies["importCorpusDraft"];
	reviseCorpusDraft: AhdeWorkbenchDependencies["reviseCorpusDraft"];
	compileHarnessProposal: typeof compileHarnessAuthoringProposal;
	recordProposal: AhdeWorkbenchDependencies["recordProposal"];
	runSuite: AhdeWorkbenchDependencies["runSuite"];
	diagnoseEval: AhdeWorkbenchDependencies["diagnoseEval"];
	compileImprovementBrief: AhdeWorkbenchDependencies["compileImprovementBrief"];
	evidenceLink: AhdeWorkbenchDependencies["evidenceLink"];
	applyProposal: AhdeWorkbenchDependencies["applyProposal"];
	describeProposalDiscard: AhdeWorkbenchDependencies["describeProposalDiscard"];
	discardProposal: AhdeWorkbenchDependencies["discardProposal"];
	runAppliedCandidate: AhdeWorkbenchDependencies["runAppliedCandidate"];
	reviewCandidate: AhdeWorkbenchDependencies["reviewCandidate"];
	promoteCandidate: AhdeWorkbenchDependencies["promoteCandidate"];
	rejectCandidate: AhdeWorkbenchDependencies["rejectCandidate"];
	actorId: () => string;
}

function abortIfRequested(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("operation aborted");
}

function textResult(details: unknown): { content: { type: "text"; text: string }[]; details: unknown } {
	return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
}

function requireHostUI(ctx: ExtensionContext, operation: string): void {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		throw new Error(`${operation} requires a local TUI host confirmation; RPC, print, and JSON execution fail closed`);
	}
}

export function createBuilderWorkbench(
	options: BuilderProjectContext & { templateDir?: string },
	dependencies: BuilderWorkbenchDependencies,
): AhdeWorkbench {
	const workbenchDependencies: Partial<AhdeWorkbenchDependencies> = {
		describeTargetScaffold: dependencies.describeTargetScaffold,
		applyTargetScaffold: dependencies.applyTargetScaffold,
		describeTargetBootstrap: dependencies.describeTargetBootstrap,
		configureTargetBootstrap: dependencies.configureTargetBootstrap,
		saveSpecDraft: dependencies.saveSpecDraft,
		describeSpecApproval: dependencies.describeSpecApproval,
		approveSpecDraft: dependencies.approveSpecDraft,
		describeCorpusPublication: dependencies.describeCorpusPublication,
		publishDevelopmentCorpus: dependencies.publishDevelopmentCorpus,
		createCorpusDraft: dependencies.createCorpusDraft,
		importCorpusDraft: dependencies.importCorpusDraft,
		reviseCorpusDraft: dependencies.reviseCorpusDraft,
		compileHarnessProposal: dependencies.compileHarnessProposal,
		recordProposal: dependencies.recordProposal,
		runSuite: dependencies.runSuite,
		diagnoseEval: dependencies.diagnoseEval,
		compileImprovementBrief: dependencies.compileImprovementBrief,
		evidenceLink: dependencies.evidenceLink,
		applyProposal: dependencies.applyProposal,
		describeProposalDiscard: dependencies.describeProposalDiscard,
		discardProposal: dependencies.discardProposal,
		runAppliedCandidate: dependencies.runAppliedCandidate,
		reviewCandidate: dependencies.reviewCandidate,
		promoteCandidate: dependencies.promoteCandidate,
		rejectCandidate: dependencies.rejectCandidate,
	};
	return createAhdeWorkbench({
		projectDir: options.projectDir,
		stateRoot: options.stateRoot,
		runsRoot: options.runsRoot,
		projectId: options.projectId,
		templateDir: options.templateDir,
		dependencies: workbenchDependencies,
	});
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
			description: "Inspect the current restart-safe workflow stage, legal actions, exact review or traces, and the safe exact-Git Target authoring context. For aspect=target, omit resourcePath for the overview or pass one returned declared resource path for its complete content.",
			parameters: WorkbenchViewParameters,
			async execute(_id, params, signal) {
				abortIfRequested(signal);
				const resourcePath = "resourcePath" in params ? params.resourcePath : undefined;
				return textResult(await workbench.view({
					aspect: params.aspect ?? "summary",
					...(resourcePath ? { resourcePath } : {}),
				}));
			},
			renderCall: (args, theme) => WORKBENCH_TOOL_RENDERERS.view.renderCall(args, theme),
			renderResult: (result, renderOptions, theme) => WORKBENCH_TOOL_RENDERERS.view.renderResult(result.details, renderOptions.expanded, theme),
		}),
		defineTool({
			name: "ahde_workbench_submit",
			label: "Author in Builder Workbench",
			description: "Save a structured Spec, import or revise an editable Spec-bound corpus draft, bind a regression case to verified development failure evidence, or author semantic Harness intents against the exact authoringContext claim plus source and failureModeIds from fresh views. Proposal diagnoses and evidence are host-derived; submission grants no consequential authority.",
			parameters: WorkbenchSubmitParameters,
			async execute(_id, params, signal) {
				abortIfRequested(signal);
				const submission = params.kind === "spec-draft"
					? { ...params, spec: { schemaVersion: 1 as const, ...params.spec } }
					: params;
				const turn = await workbench.submit(submission as WorkbenchSubmitInput, { signal });
				await changed();
				return textResult(turn);
			},
			renderCall: (args, theme) => WORKBENCH_TOOL_RENDERERS.submit.renderCall(args, theme),
			renderResult: (result, renderOptions, theme) => WORKBENCH_TOOL_RENDERERS.submit.renderResult(result.details, renderOptions.expanded, theme),
		}),
		defineTool({
			name: "ahde_workbench_decide",
			label: "Decide in Builder Workbench",
			description: "Request one exact human-gated workflow transition. Actor identity and sealed holdout selection remain host-owned.",
			parameters: WorkbenchDecisionParameters,
			renderCall: (args, theme) => WORKBENCH_TOOL_RENDERERS.decide.renderCall(args, theme),
			renderResult: (result, renderOptions, theme) => WORKBENCH_TOOL_RENDERERS.decide.renderResult(result.details, renderOptions.expanded, theme),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				requireHostUI(ctx, "Workbench decision");
				const targetModelSelection = params.kind === "configure-target"
					? TargetModelSelectionSchema.parse(params.model)
					: null;
				const targetCredentialEnvironment = targetModelSelection
					? await selectTargetCredentialEnvironment(ctx, targetModelSelection)
					: null;
				const showsRunProgress = params.kind === "run-current" ||
					params.kind === "run-eval" ||
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
						params as WorkbenchDecisionInput,
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
