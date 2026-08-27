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

type RegisteredWorkbenchTool = ToolDefinition<TSchema, unknown>;

export interface BuilderWorkbenchDependencies {
	saveSpecDraft: AhdeWorkbenchDependencies["saveSpecDraft"];
	describeSpecApproval: AhdeWorkbenchDependencies["describeSpecApproval"];
	approveSpecDraft: AhdeWorkbenchDependencies["approveSpecDraft"];
	describeCorpusPublication: AhdeWorkbenchDependencies["describeCorpusPublication"];
	publishDevelopmentCorpus: AhdeWorkbenchDependencies["publishDevelopmentCorpus"];
	createCorpusDraft: AhdeWorkbenchDependencies["createCorpusDraft"];
	reviseCorpusDraft: AhdeWorkbenchDependencies["reviseCorpusDraft"];
	compileHarnessProposal: typeof compileHarnessAuthoringProposal;
	recordProposal: AhdeWorkbenchDependencies["recordProposal"];
	runSuite: AhdeWorkbenchDependencies["runSuite"];
	diagnoseEval: AhdeWorkbenchDependencies["diagnoseEval"];
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
	options: BuilderProjectContext,
	dependencies: BuilderWorkbenchDependencies,
): AhdeWorkbench {
	const workbenchDependencies: Partial<AhdeWorkbenchDependencies> = {
		saveSpecDraft: dependencies.saveSpecDraft,
		describeSpecApproval: dependencies.describeSpecApproval,
		approveSpecDraft: dependencies.approveSpecDraft,
		describeCorpusPublication: dependencies.describeCorpusPublication,
		publishDevelopmentCorpus: dependencies.publishDevelopmentCorpus,
		createCorpusDraft: dependencies.createCorpusDraft,
		reviseCorpusDraft: dependencies.reviseCorpusDraft,
		compileHarnessProposal: dependencies.compileHarnessProposal,
		recordProposal: dependencies.recordProposal,
		runSuite: dependencies.runSuite,
		diagnoseEval: dependencies.diagnoseEval,
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
		dependencies: workbenchDependencies,
	});
}

export function createBuilderWorkbenchTools(
	workbench: AhdeWorkbench,
	actorId: () => string,
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
			description: "Save a structured Spec, editable Spec-bound corpus draft/revision, semantic harness proposal, or exact artifact selection without granting consequential authority.",
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
				return textResult(await workbench.decide(
					params as WorkbenchDecisionInput,
					createWorkbenchHumanGate(ctx, actorId, (operation) => requireHostUI(ctx, operation)),
					{ signal },
				));
			},
		}),
	];
}
