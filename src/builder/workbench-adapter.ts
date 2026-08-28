import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { compileHarnessAuthoringProposal } from "../application/harness-authoring.js";
import {
	createAhdeWorkbench,
	type AhdeWorkbench,
	type AhdeWorkbenchDependencies,
} from "../workbench/workbench.js";
import type {
	WorkbenchDecisionInput,
	WorkbenchSubmitInput,
} from "../workbench/types.js";
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

export function createBuilderWorkbenchTools(
	workbench: AhdeWorkbench,
	actorId: () => string,
	options: { beginLiveTrace?: BeginBuilderLiveTrace } = {},
): readonly RegisteredWorkbenchTool[] {
	return [
		defineTool({
			name: "ahde_workbench_view",
			label: "Inspect Builder Workbench",
			description: "Inspect the current restart-safe workflow stage, legal actions, and optionally the exact review, trace, or Target detail.",
			parameters: WorkbenchViewParameters,
			async execute(_id, params, signal) {
				abortIfRequested(signal);
				return textResult(await workbench.view({ aspect: params.aspect ?? "summary" }));
			},
		}),
		defineTool({
			name: "ahde_workbench_submit",
			label: "Author in Builder Workbench",
			description: "Save a structured Spec, import or revise an editable Spec-bound corpus draft, bind a new regression case to verified development failure evidence, author a semantic harness proposal, or select an exact artifact without granting consequential authority.",
			parameters: WorkbenchSubmitParameters,
			async execute(_id, params, signal) {
				abortIfRequested(signal);
				const submission = params.kind === "spec-draft"
					? { ...params, spec: { schemaVersion: 1 as const, ...params.spec } }
					: params;
				return textResult(await workbench.submit(submission as WorkbenchSubmitInput, { signal }));
			},
		}),
		defineTool({
			name: "ahde_workbench_decide",
			label: "Decide in Builder Workbench",
			description: "Request one exact human-gated workflow transition. Actor identity and sealed holdout selection remain host-owned.",
			parameters: WorkbenchDecisionParameters,
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				requireHostUI(ctx, "Workbench decision");
				const showsRunProgress = params.kind === "run-current" ||
					params.kind === "run-eval" ||
					params.kind === "verify-candidate";
				const observation = showsRunProgress
					? await beginBuilderRunObservation(ctx.ui, options.beginLiveTrace)
					: null;
				let outcome: BuilderLiveTraceOutcome = "error";
				try {
					const result = await workbench.decide(
						params as WorkbenchDecisionInput,
						createWorkbenchHumanGate(ctx, actorId, (operation) => requireHostUI(ctx, operation)),
						{ signal, ...(observation ? { onRunEvent: observation.onRunEvent } : {}) },
					);
					outcome = "completed";
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
