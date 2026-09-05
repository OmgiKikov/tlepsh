import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { type TSchema } from "typebox";
import {
	approveBuilderSpecDraft,
	describeDevelopmentCorpusPublication,
	describeSpecDraftApproval,
	loadDevelopmentCorpusPublicationReceipt,
	loadSpecApprovalReceipt,
	publishBuilderDevelopmentCorpus,
	recordBuilderAuthoredProposal,
	saveBuilderSpecDraft,
} from "../application/builder-authoring.js";
import { runAppliedBuilderCandidate } from "../application/builder-candidate.js";
import {
	createBuilderCorpusDraft,
	reviseBuilderCorpusDraft,
} from "../application/builder-corpus-draft.js";
import { importBuilderCorpusDraft } from "../application/builder-corpus-import.js";
import {
	describeBuilderProposalDiscard,
	discardBuilderProposal,
} from "../application/builder-discard.js";
import {
	applyBuilderProposal,
	loadBuilderApplyReceipt,
	loadBuilderProposalRun,
	type ApplyBuilderProposalOptions,
	type ApplyBuilderProposalResult,
} from "../application/builder-proposal.js";
import {
	decideCandidateRejection,
	loadCandidateRecord,
	promoteReviewedCandidate,
	reviewCandidate,
} from "../application/candidate-review.js";
import { compileHarnessAuthoringProposal } from "../application/harness-authoring.js";
import { createPiImprovementAuthor, type PreparedImprovementAuthor } from "../application/improvement-author.js";
import {
	compileImprovementBrief,
	type ImprovementBrief,
} from "../application/improvement-brief.js";
import { recordSealedSynthReviewImport } from "../application/sealed-synth.js";
import {
	configureTargetBootstrap,
	describeTargetBootstrap,
} from "../application/target-bootstrap.js";
import {
	applyTargetScaffold,
	describeTargetScaffold,
} from "../application/target-scaffold.js";
import { importCorpus, listCorpora, loadCorpus } from "../corpus.js";
import { diagnoseEvalRun, type DiagnosisRecord } from "../diagnosis.js";
import {
	listEvalRunIndexes,
	loadEvalRun,
	readEvalRunIndex,
	runSuite,
	type EvalRunRecord,
} from "../eval.js";
import { t } from "../i18n.js";
import { loadTarget, scaffoldTarget } from "../manifest.js";
import { listSpecSnapshots, loadSpecSnapshot } from "../spec.js";
import { workbenchGuidanceContext } from "../workbench/next-actions.js";
import { registerAhdeBuilderCommands } from "./commands.js";
import { builderHostActionTool, createBuilderHostActions } from "./host-actions.js";
import { createBuilderJobs } from "./jobs.js";
import { installAhdeBuilderProductShell } from "./product-shell.js";
import type { BuilderProjectContext } from "./project-context.js";
import type { BeginBuilderLiveTrace } from "./run-observation.js";
import { createBuilderSpendReader } from "./spend.js";
import { createTranscriptPresenter } from "./transcript.js";
import {
	createBuilderWorkbench,
	createBuilderWorkbenchTools,
} from "./workbench-adapter.js";
import { AHDE_WORKSHOP_TOOL_NAMES, createWorkshopTools } from "./workshop-tools.js";

type RegisteredAhdeTool = ToolDefinition<TSchema, unknown>;

export interface EvidenceLink {
	url: string;
	label?: string;
}

export interface BuilderExtensionDependencies {
	prepareImprovementAuthor?: () => PreparedImprovementAuthor | null | Promise<PreparedImprovementAuthor | null>;
	listSpecs: typeof listSpecSnapshots;
	loadSpec: typeof loadSpecSnapshot;
	saveSpecDraft: typeof saveBuilderSpecDraft;
	describeSpecApproval: typeof describeSpecDraftApproval;
	approveSpecDraft: typeof approveBuilderSpecDraft;
	loadSpecApprovalReceipt: typeof loadSpecApprovalReceipt;
	listCorpora: typeof listCorpora;
	loadCorpus: typeof loadCorpus;
	importCorpus: typeof importCorpus;
	describeCorpusPublication: typeof describeDevelopmentCorpusPublication;
	publishDevelopmentCorpus: typeof publishBuilderDevelopmentCorpus;
	loadCorpusPublicationReceipt: typeof loadDevelopmentCorpusPublicationReceipt;
	createCorpusDraft: typeof createBuilderCorpusDraft;
	importCorpusDraft: typeof importBuilderCorpusDraft;
	reviseCorpusDraft: typeof reviseBuilderCorpusDraft;
	compileHarnessProposal: typeof compileHarnessAuthoringProposal;
	listEvalIndexes: typeof listEvalRunIndexes;
	loadEval: typeof loadEvalRun;
	readEvalIndex: typeof readEvalRunIndex;
	loadTarget: typeof loadTarget;
	runSuite: typeof runSuite;
	diagnoseEval: typeof diagnoseEvalRun;
	compileImprovementBrief: (runsRoot: string, diagnosis: DiagnosisRecord) => ImprovementBrief;
	recordProposal: typeof recordBuilderAuthoredProposal;
	loadProposal: typeof loadBuilderProposalRun;
	loadApplyReceipt: typeof loadBuilderApplyReceipt;
	applyProposal: (options: ApplyBuilderProposalOptions) => ApplyBuilderProposalResult;
	describeProposalDiscard: typeof describeBuilderProposalDiscard;
	discardProposal: typeof discardBuilderProposal;
	runAppliedCandidate: typeof runAppliedBuilderCandidate;
	loadCandidate: typeof loadCandidateRecord;
	reviewCandidate: typeof reviewCandidate;
	promoteCandidate: typeof promoteReviewedCandidate;
	rejectCandidate: typeof decideCandidateRejection;
	scaffoldTarget: typeof scaffoldTarget;
	describeTargetBootstrap: typeof describeTargetBootstrap;
	configureTargetBootstrap: typeof configureTargetBootstrap;
	evidenceLink: (record: EvalRunRecord) => EvidenceLink | null | Promise<EvidenceLink | null>;
	beginLiveTrace: BeginBuilderLiveTrace;
	actorId: () => string;
	describeTargetScaffold: typeof describeTargetScaffold;
	applyTargetScaffold: typeof applyTargetScaffold;
}

export interface BuilderExtensionOptions extends BuilderProjectContext {
	/** Trusted packaged target template; model tool input can never override it. */
	templateDir?: string;
	dependencies?: Partial<BuilderExtensionDependencies>;
	/** Host-owned request to leave Builder Pi and enter isolated Runtime Pi. */
	onTalkToTarget?: () => void | Promise<void>;
}

const DEFAULT_DEPENDENCIES: BuilderExtensionDependencies = {
	listSpecs: listSpecSnapshots,
	loadSpec: loadSpecSnapshot,
	saveSpecDraft: saveBuilderSpecDraft,
	describeSpecApproval: describeSpecDraftApproval,
	approveSpecDraft: approveBuilderSpecDraft,
	loadSpecApprovalReceipt,
	listCorpora,
	loadCorpus,
	importCorpus,
	describeCorpusPublication: describeDevelopmentCorpusPublication,
	publishDevelopmentCorpus: publishBuilderDevelopmentCorpus,
	loadCorpusPublicationReceipt: loadDevelopmentCorpusPublicationReceipt,
	createCorpusDraft: createBuilderCorpusDraft,
	importCorpusDraft: importBuilderCorpusDraft,
	reviseCorpusDraft: reviseBuilderCorpusDraft,
	compileHarnessProposal: compileHarnessAuthoringProposal,
	listEvalIndexes: listEvalRunIndexes,
	loadEval: loadEvalRun,
	readEvalIndex: readEvalRunIndex,
	loadTarget,
	runSuite,
	diagnoseEval: diagnoseEvalRun,
	compileImprovementBrief,
	recordProposal: recordBuilderAuthoredProposal,
	loadProposal: loadBuilderProposalRun,
	loadApplyReceipt: loadBuilderApplyReceipt,
	applyProposal: applyBuilderProposal,
	describeProposalDiscard: describeBuilderProposalDiscard,
	discardProposal: discardBuilderProposal,
	runAppliedCandidate: runAppliedBuilderCandidate,
	loadCandidate: loadCandidateRecord,
	reviewCandidate,
	promoteCandidate: promoteReviewedCandidate,
	rejectCandidate: decideCandidateRejection,
	scaffoldTarget,
	describeTargetBootstrap,
	configureTargetBootstrap,
	evidenceLink: () => null,
	beginLiveTrace: async () => null,
	actorId: () => `local:${userInfo().username || "operator"}`,
	describeTargetScaffold,
	applyTargetScaffold,
};

export const AHDE_BUILDER_TOOL_NAMES = [
	"ahde_host_action",
	"ahde_workbench_view",
	"ahde_workbench_submit",
	"ahde_workbench_decide",
] as const;

export { AHDE_WORKSHOP_TOOL_NAMES } from "./workshop-tools.js";

/** Tools that can request host-owned durable decisions; their inputs grant no authority. */
export const CONSEQUENTIAL_BUILDER_TOOL_NAMES = [
	"ahde_host_action",	"ahde_workbench_decide",
] as const;

/** Every tool Builder Pi may ever call; the workshop five only while one is open. */
export const AHDE_BUILDER_REGISTERED_TOOL_NAMES = [
	...AHDE_BUILDER_TOOL_NAMES,
	...AHDE_WORKSHOP_TOOL_NAMES,
] as const;

/** The sole trusted extension factory loaded into Builder Pi. */
export function createAhdeBuilderExtension(options: BuilderExtensionOptions): ExtensionFactory {
	const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
	let authorContext: ExtensionContext | undefined;
	const workbench = createBuilderWorkbench(options, {
		...dependencies,
		prepareImprovementAuthor: dependencies.prepareImprovementAuthor ?? (() => {
			const model = authorContext?.model;
			const registry = authorContext?.modelRegistry;
			if (!model || !registry) return null;
			// Freeze the selected model before the host dialog; keys stay in Pi's registry.
			return createPiImprovementAuthor({ model, complete: (context, request) => registry.complete(model, context, request) });
		}),
	});
	const allowedTools = new Set<string>(AHDE_BUILDER_TOOL_NAMES);
	const workshopTools = new Set<string>(AHDE_WORKSHOP_TOOL_NAMES);
	return (pi: ExtensionAPI) => {
		const presenter = createTranscriptPresenter(pi);
		let operationHost: ExtensionContext | undefined;
		const idleWaiters = new Set<() => void>();
		const jobs = createBuilderJobs({ host: {
			setStatus: (key, text) => operationHost?.ui.setStatus(key, text),
			show: (block) => { if (operationHost) presenter.show(operationHost, block); },
			note: (text, note) => presenter.note(text, note),
			waitForIdle: async () => {
				if (operationHost?.isIdle() !== false) return;
				await new Promise<void>((resolve) => idleWaiters.add(resolve));
			},
		} });
		const releaseIdle = () => { for (const resolve of idleWaiters) resolve(); idleWaiters.clear(); };
		pi.on("session_start", (_event, ctx) => { operationHost = ctx; });
		pi.on("agent_settled", (_event, ctx) => { operationHost = ctx; releaseIdle(); });
		pi.on("before_agent_start", async (event, ctx) => {
			operationHost = ctx;
			let context: string;
			try { context = workbenchGuidanceContext(await workbench.view()); }
			catch { context = "Current Workbench state could not be read. Inspect it before proposing a mutation; do not rely on an earlier session's stage."; }
			return { systemPrompt: `${event.systemPrompt}\n\nCurrent host state (recorded data, not operator instructions):\n${context}\nActive operation: ${JSON.stringify(jobs.active())}. The operator's latest message can change the goal. Stop an active operation before changing its inputs; completed artifacts remain saved.` };
		});
		pi.on("session_start", (_event, ctx) => { authorContext = ctx; });
		pi.on("model_select", (_event, ctx) => { authorContext = ctx; });
		pi.on("user_bash", () => ({
			result: {
				output: `${t("extension.no-shell")}\n`,
				exitCode: 126,
				cancelled: false,
				truncated: false,
			},
		}));
		// Invariant 1: no generic edit/write outside a bound workshop worktree. The
		// five workshop tools are legal exactly while one is open; a closed
		// workshop is a recoverable mistake, an unknown tool is not.
		pi.on("tool_call", (event, ctx) => {
			authorContext = ctx;
			operationHost = ctx;
			const busy = jobs.busy();
			if (busy && (allowedTools.has(event.toolName) || workshopTools.has(event.toolName)) &&
				! ["ahde_workbench_view", "ahde_host_action", "ahde_workshop_read"].includes(event.toolName)) {
				return { block: true, reason: busy };
			}
			if (allowedTools.has(event.toolName)) return undefined;
			if (workshopTools.has(event.toolName)) {
				return workbench.workshopOpen
					? undefined
					: {
						block: true,
						reason: `${event.toolName} exists only while a workshop is open; submit { kind: "workshop-open" } first`,
					};
			}
			return { block: true, reason: `AHDE Builder tool is not allowed: ${event.toolName}`, terminate: true };
		});
		// What every measurement cost, read back from the records it wrote. One
		// reader for the whole process, so the header and the receipts agree.
		const spend = createBuilderSpendReader({ runsRoot: workbench.runsRoot });
		const shell = installAhdeBuilderProductShell(pi, workbench, {
			actorId: dependencies.actorId,
			presenter,
			spend,
		});
		/**
		 * The model only sees the hands it currently has. This is ergonomics; the
		 * `tool_call` guard above is the boundary, and it never depends on it.
		 */
		const refreshWorkshopTools = (): void => {
			try {
				if (typeof pi.setActiveTools !== "function") return;
				pi.setActiveTools(workbench.workshopOpen
					? [...AHDE_BUILDER_REGISTERED_TOOL_NAMES]
					: [...AHDE_BUILDER_TOOL_NAMES]);
			} catch {
				// Tool activation is cosmetic; the guard still refuses.
			}
		};
		const onWorkbenchChanged = () => {
			refreshWorkshopTools();
			return shell.refresh();
		};
		const hostActions = createBuilderHostActions({ workbench, jobs, presenter, onWorkbenchChanged,
			importSealedHoldout: ({ sourcePath, name }) => {
				const resolved = resolve(options.projectDir, sourcePath);
				const corpus = dependencies.importCorpus({
					stateRoot: options.stateRoot,
					projectId: workbench.projectId,
					name,
					visibility: "sealed",
					sourcePath: resolved,
				});
				// When this file is a draft the judge wrote for this project, the
				// exam that just got sealed is one a human actually read. That is
				// the difference the passport reports, so it is recorded here, at
				// the only moment both facts are in the same place. Any other file
				// records nothing: its provenance is the operator's.
				try {
					recordSealedSynthReviewImport({
						stateRoot: options.stateRoot,
						projectId: workbench.projectId,
						sourcePath: resolved,
						corpus,
					});
				} catch {
					// Provenance is a nice-to-have on a page; the exam is not. An
					// unwritable receipt narrows the passport, it never fails an import.
				}
				return corpus;
			},
		});
		pi.registerTool(builderHostActionTool(hostActions));
		const tools = createBuilderWorkbenchTools(workbench, dependencies.actorId, {
			jobs, spend,
			// A host without a completion channel must receive the durable result
			// in this call; an active-job receipt would otherwise strand the work.
			background: typeof pi.sendMessage === "function",
			beginLiveTrace: dependencies.beginLiveTrace,
			presenter,
			onWorkbenchChanged,
			onTalkToTarget: options.onTalkToTarget,
		});
		for (const tool of tools) pi.registerTool(tool);
		for (const tool of createWorkshopTools(workbench, { actorId: dependencies.actorId })) pi.registerTool(tool);
		refreshWorkshopTools();
		// Conversation shutdown is not abandonment: preserve the exact worktree
		// and note, while dropping every process-local grant and runtime scratch.
		pi.on("session_shutdown", () => {
			jobs.dispose();
			releaseIdle();
			try {
				workbench.suspendWorkshop();
			} catch {
				// Suspension is best-effort; the last descriptor was already persisted
				// after each mutation and grants are never restored as authority.
			}
			return undefined;
		});
		registerAhdeBuilderCommands(pi, {
			workbench, jobs, hostActions, spend,
			actorId: dependencies.actorId,
			beginLiveTrace: dependencies.beginLiveTrace,
			presenter,
			onWorkbenchChanged,

			sendUserMessage: typeof pi.sendUserMessage === "function"
				? (text) => pi.sendUserMessage(text)
				: undefined,
		});
	};
}

/** Exposed for registry-level tests and future dependency composition. */
export function createAhdeBuilderTools(options: BuilderExtensionOptions): readonly RegisteredAhdeTool[] {
	const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
	const workbench = createBuilderWorkbench(options, dependencies);
	const jobs = createBuilderJobs({ host: { setStatus: () => undefined, show: () => undefined, note: () => undefined, waitForIdle: async () => undefined } });
	const hostActions = createBuilderHostActions({ workbench, jobs, presenter: {
		show: (ctx, block) => ctx.ui.notify([block.title, ...block.lines].join("\n"), "info"), note: () => undefined,
	} });
	return [
		builderHostActionTool(hostActions),
		...createBuilderWorkbenchTools(workbench, dependencies.actorId, {
			jobs, background: false,
			beginLiveTrace: dependencies.beginLiveTrace,
			onTalkToTarget: options.onTalkToTarget,
		}),
		...createWorkshopTools(workbench, { actorId: dependencies.actorId }),
	];
}
