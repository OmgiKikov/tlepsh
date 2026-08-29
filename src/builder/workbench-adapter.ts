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
	prepareWorkbenchArguments,
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
			description: [
				"Read the AHDE Workbench: the current stage, legal next actions, the exact subject under review, the diagnosis, or the committed Target.",
				"Arguments: { aspect?: \"summary\" | \"review\" | \"traces\" | \"target\", resourcePath?: string }.",
				"aspect omitted/summary = stage + counts; review = the exact Spec draft, eval basket, proposal diff, or candidate awaiting a decision;",
				"traces = evaluation summary, failure modes (improvementBrief.modes with ordinal + failureModeId), evidence link;",
				"target = the committed Target index (resources with path/kind) — pass one returned resourcePath to read that file's complete content.",
				"Call this before relying on remembered state; operator slash commands change state between your turns.",
			].join(" "),
			parameters: WorkbenchViewParameters,
			prepareArguments: (args) => prepareWorkbenchArguments(WorkbenchViewParameters, args, "aspect") as never,
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
			parameters: WorkbenchSubmitParameters,
			prepareArguments: (args) => prepareWorkbenchArguments(WorkbenchSubmitParameters, args) as never,
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
			description: [
				"Request one human-gated workflow transition. Call this yourself when the operator asks for the step in plain words (run, approve, publish, apply, promote, adopt, next): the host shows the exact subject and asks the operator to confirm in its own dialog before anything happens — never tell the operator to type a slash command instead. Every kind requires a non-blank `reason`.",
				"Kinds by stage: target-setup → { kind: \"scaffold-target\" } then { kind: \"configure-target\", targetId (kebab-case), model: { provider, modelId, thinkingLevel?, timeoutMs?, params? } };",
				"spec-review → { kind: \"approve-spec\", draftSpecId? }; corpus-review → { kind: \"publish-corpus\", draftId?, name? };",
				"ready-to-evaluate / improvement-authoring → { kind: \"run-current\", repetitions: 1..10 } (or run-eval); proposal-review → { kind: \"apply-proposal\", branch } | { kind: \"discard-proposal\" };",
				"candidate-verification → { kind: \"run-current\", repetitions } (verify) | { kind: \"abandon-candidate\" } for an interrupted attempt; candidate-review → { kind: \"review-candidate\", recommendation: \"promote\" | \"reject\" };",
				"release-decision → { kind: \"promote-candidate\", version: \"x.y.z\" } | { kind: \"reject-candidate\" }; candidate-adoption → { kind: \"adopt-candidate\" }; complete → { kind: \"continue-cycle\" }.",
				"Actor identity and sealed-holdout selection stay host-owned; never add approved/confirmed/actor fields.",
			].join("\n"),
			parameters: WorkbenchDecisionParameters,
			prepareArguments: (args) => prepareWorkbenchArguments(WorkbenchDecisionParameters, args) as never,
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
