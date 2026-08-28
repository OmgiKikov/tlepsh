import { userInfo } from "node:os";
import { basename, resolve } from "node:path";
import {
	approveBuilderSpecDraft,
	describeDevelopmentCorpusPublication,
	describeSpecDraftApproval,
	loadDevelopmentCorpusPublicationReceipt,
	publishBuilderDevelopmentCorpus,
	recordBuilderAuthoredProposal,
	saveBuilderSpecDraft,
} from "../application/builder-authoring.js";
import {
	createBuilderCorpusDraft,
	reviseBuilderCorpusDraft,
} from "../application/builder-corpus-draft.js";
import { importBuilderCorpusDraft } from "../application/builder-corpus-import.js";
import { resolveDevelopmentFailureOperations } from "../application/builder-regression-case.js";
import {
	compileHarnessAuthoringProposal,
	type HarnessAuthoringIntent,
} from "../application/harness-authoring.js";
import { inspectTargetAuthoringContext } from "../application/target-authoring-context.js";
import { runAppliedBuilderCandidate } from "../application/builder-candidate.js";
import {
	configureTargetBootstrap,
	describeTargetBootstrap,
} from "../application/target-bootstrap.js";
import {
	applyTargetScaffold,
	describeTargetScaffold,
} from "../application/target-scaffold.js";
import {
	describeBuilderProposalDiscard,
	discardBuilderProposal,
} from "../application/builder-discard.js";
import { CANDIDATE_SCOPE_POLICY } from "../application/candidate-experiment.js";
import {
	decideCandidateRejection,
	promoteReviewedCandidate,
	reviewCandidate,
} from "../application/candidate-review.js";
import { targetWithDevelopmentCorpus } from "../application/corpus-target.js";
import {
	applyBuilderProposal,
	loadBuilderApplyReceipt,
} from "../application/builder-proposal.js";
import {
	compileImprovementBrief,
	deriveEvidenceLinkedProposalSelection,
	type ImprovementBrief,
} from "../application/improvement-brief.js";
import type { CandidateProposal } from "../builders/adapters.js";
import {
	listCorpora,
	loadCorpus,
	type CorpusMetadata,
	type CorpusRef,
} from "../corpus.js";
import { diagnoseEvalRun } from "../diagnosis.js";
import { candidateStatus } from "../domain/candidate.js";
import {
	loadEvalRun,
	runSuite,
	type EvalRunRecord,
} from "../eval.js";
import { loadTarget, type ResolvedTarget } from "../manifest.js";
import { canonicalJson, hashValue } from "../provenance.js";
import {
	loadApprovedSpec,
} from "../spec.js";
import {
	resolveBuilderProjectId,
	type BuilderProjectContext,
} from "../builder/project-context.js";
import {
	loadWorkbenchFocus,
	saveWorkbenchFocus,
	selectWorkbenchFocus,
} from "./focus.js";
import { recordWorkbenchCorpusPublication } from "./corpus-publication.js";
import { recordCandidateAbandonment } from "./candidate-abandonment.js";
import {
	WorkbenchDecisionDeclinedError,
	WorkbenchSelectionRequiredError,
	WorkbenchStaleDecisionError,
} from "./errors.js";
import {
	deriveWorkbenchView,
	loadWorkbenchInventory,
	workbenchArtifactValue,
	type WorkbenchInventory,
} from "./inventory.js";
import {
	candidateSummary,
	compatibleDevelopmentEvals,
	diagnosisSummary,
	proposalReview,
	requireApprovedSpec,
	requireCandidate,
	requireCorpusDraft,
	requireDevelopmentCorpus,
	requireDevelopmentEval,
	requireProposal,
	requireSpecDraft,
	resolveOne,
} from "./resolution.js";
import { assertWorkbenchDecisionStage } from "./transition-policy.js";
import {
	WorkbenchDecisionInputSchema,
	WorkbenchSubmitInputSchema,
	WorkbenchViewQuerySchema,
	type WorkbenchConfirmation,
	type WorkbenchDecisionInput,
	type WorkbenchDecisionExecutionOptions,
	type WorkbenchDecisionResult,
	type WorkbenchHumanGate,
	type WorkbenchSelectionKind,
	type WorkbenchSubmitInput,
	type WorkbenchTurn,
	type WorkbenchView,
	type WorkbenchViewQuery,
} from "./types.js";

const MAX_REVIEW_BYTES = 5 * 1024 * 1024;
const MAX_CONVERSATION_MODES = 3;

export interface WorkbenchEvidenceLink {
	url: string;
	label?: string;
}

export interface CompileHarnessAuthoringInput {
	repositoryDir: string;
	expectedBaseTargetSha: string;
	intents: readonly HarnessAuthoringIntent[];
	summary: string;
	diagnoses: CandidateProposal["diagnoses"];
	risks: string[];
	validationPlan: string[];
}

export interface AhdeWorkbenchDependencies {
	now: () => string;
	describeTargetScaffold: typeof describeTargetScaffold;
	applyTargetScaffold: typeof applyTargetScaffold;
	describeTargetBootstrap: typeof describeTargetBootstrap;
	configureTargetBootstrap: typeof configureTargetBootstrap;
	saveSpecDraft: typeof saveBuilderSpecDraft;
	describeSpecApproval: typeof describeSpecDraftApproval;
	approveSpecDraft: typeof approveBuilderSpecDraft;
	describeCorpusPublication: typeof describeDevelopmentCorpusPublication;
	publishDevelopmentCorpus: typeof publishBuilderDevelopmentCorpus;
	createCorpusDraft: typeof createBuilderCorpusDraft;
	importCorpusDraft: typeof importBuilderCorpusDraft;
	reviseCorpusDraft: typeof reviseBuilderCorpusDraft;
	compileHarnessProposal: (input: CompileHarnessAuthoringInput) => CandidateProposal;
	recordProposal: typeof recordBuilderAuthoredProposal;
	runSuite: typeof runSuite;
	diagnoseEval: typeof diagnoseEvalRun;
	compileImprovementBrief: (runsRoot: string, diagnosis: ReturnType<typeof diagnoseEvalRun>) => ImprovementBrief;
	inspectTargetAuthoringContext: typeof inspectTargetAuthoringContext;
	evidenceLink: (record: EvalRunRecord) => WorkbenchEvidenceLink | null | Promise<WorkbenchEvidenceLink | null>;
	applyProposal: typeof applyBuilderProposal;
	describeProposalDiscard: typeof describeBuilderProposalDiscard;
	discardProposal: typeof discardBuilderProposal;
	runAppliedCandidate: typeof runAppliedBuilderCandidate;
	reviewCandidate: typeof reviewCandidate;
	promoteCandidate: typeof promoteReviewedCandidate;
	rejectCandidate: typeof decideCandidateRejection;
}

export interface AhdeWorkbenchOptions extends BuilderProjectContext {
	/** Trusted packaged starter. Builder input can select no alternate template. */
	templateDir?: string;
	dependencies?: Partial<AhdeWorkbenchDependencies>;
}

const DEFAULT_DEPENDENCIES: AhdeWorkbenchDependencies = {
	now: () => new Date().toISOString(),
	describeTargetScaffold,
	applyTargetScaffold,
	describeTargetBootstrap,
	configureTargetBootstrap,
	saveSpecDraft: saveBuilderSpecDraft,
	describeSpecApproval: describeSpecDraftApproval,
	approveSpecDraft: approveBuilderSpecDraft,
	describeCorpusPublication: describeDevelopmentCorpusPublication,
	publishDevelopmentCorpus: publishBuilderDevelopmentCorpus,
	createCorpusDraft: createBuilderCorpusDraft,
	importCorpusDraft: importBuilderCorpusDraft,
	reviseCorpusDraft: reviseBuilderCorpusDraft,
	compileHarnessProposal: compileHarnessAuthoringProposal,
	recordProposal: recordBuilderAuthoredProposal,
	runSuite,
	diagnoseEval: diagnoseEvalRun,
	compileImprovementBrief,
	inspectTargetAuthoringContext,
	evidenceLink: () => null,
	applyProposal: applyBuilderProposal,
	describeProposalDiscard: describeBuilderProposalDiscard,
	discardProposal: discardBuilderProposal,
	runAppliedCandidate: runAppliedBuilderCandidate,
	reviewCandidate,
	promoteCandidate: promoteReviewedCandidate,
	rejectCandidate: decideCandidateRejection,
};

function abortIfRequested(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("operation aborted");
}

function actorId(value: string | undefined): string {
	const actor = value?.trim();
	if (!actor || actor.length > 256) throw new Error("human gate did not provide a bounded actor identity");
	return actor;
}

function exactSame(left: unknown, right: unknown): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

function boundedSubject(value: unknown, label: string): unknown {
	if (Buffer.byteLength(canonicalJson(value), "utf8") > MAX_REVIEW_BYTES) {
		throw new Error(`${label} exceeds the ${MAX_REVIEW_BYTES}-byte exact review limit; split it before continuing`);
	}
	return value;
}

function boundedEvidenceLink(link: WorkbenchEvidenceLink | null): WorkbenchEvidenceLink | null {
	if (!link) return null;
	const parsed = new URL(link.url);
	if (
		parsed.protocol !== "http:" ||
		!new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsed.hostname) ||
		parsed.username !== "" ||
		parsed.password !== ""
	) throw new Error("evidence links must be unauthenticated loopback HTTP URLs");
	return { url: parsed.toString(), ...(link.label ? { label: link.label.slice(0, 200) } : {}) };
}

/** Small model-facing diagnosis projection; full evidence remains in the verified report. */
function conversationalImprovementBrief(brief: ImprovementBrief): Record<string, unknown> {
	const modes = brief.modes.slice(0, MAX_CONVERSATION_MODES).map((mode, index) => ({
		ordinal: index + 1,
		failureModeId: mode.failureModeId,
		category: mode.category,
		scope: mode.scope,
		severity: mode.severity,
		evidenceStrength: mode.evidenceStrength,
		decision: mode.decision,
		selectableForProposal: brief.proposalEligible && mode.decision === "propose-harness-change",
		title: mode.title.slice(0, 500),
		summary: mode.summary.slice(0, 1_000),
		hypothesis: mode.hypothesis.slice(0, 1_000),
		suggestions: mode.suggestions.slice(0, 2).map((item) => item.slice(0, 500)),
		impact: mode.impact,
		taskIds: mode.taskIds.slice(0, 5),
		evidence: mode.evidence.slice(0, 3).map((item) => ({
			runId: item.runId,
			taskId: item.taskId,
			traceAvailable: item.traceAvailable,
			graderNames: item.graderNames.slice(0, 3),
		})),
		omittedEvidenceCount: mode.omittedEvidenceCount + Math.max(0, mode.evidence.length - 3),
	}));
	return {
		schemaVersion: brief.schemaVersion,
		algorithmId: brief.algorithmId,
		briefId: brief.briefId,
		evalRunId: brief.evalRunId,
		diagnosisId: brief.diagnosisId,
		status: brief.status,
		proposalEligible: brief.proposalEligible,
		headline: brief.headline.slice(0, 1_000),
		summary: brief.summary,
		modes,
		conversationProjection: {
			shownModes: modes.length,
			addressableModes: brief.modes.length,
			omittedModes: Math.max(0, brief.modes.length - modes.length) + brief.summary.omittedFailureModeCount,
			fullEvidence: "Use the returned loopback evidence link or /traces report drill-down.",
		},
	};
}

export class AhdeWorkbench {
	readonly projectDir: string;
	readonly stateRoot: string;
	readonly runsRoot: string;
	readonly projectId: string;
	private readonly templateDir: string | undefined;
	private readonly dependencies: AhdeWorkbenchDependencies;

	constructor(options: AhdeWorkbenchOptions) {
		this.projectDir = resolve(options.projectDir);
		this.stateRoot = resolve(options.stateRoot);
		this.runsRoot = resolve(options.runsRoot);
		this.projectId = resolveBuilderProjectId(options);
		this.templateDir = options.templateDir ? resolve(options.templateDir) : undefined;
		this.dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
	}

	private inventory(): WorkbenchInventory {
		return loadWorkbenchInventory({
			projectDir: this.projectDir,
			stateRoot: this.stateRoot,
			runsRoot: this.runsRoot,
			projectId: this.projectId,
			now: this.dependencies.now,
		});
	}

	private decisionInventory(
		kind: Exclude<WorkbenchDecisionInput["kind"], "run-current">,
	): WorkbenchInventory {
		const inventory = this.inventory();
		try {
			assertWorkbenchDecisionStage(kind, deriveWorkbenchView(inventory).stage);
		} catch {
			throw new WorkbenchStaleDecisionError(kind);
		}
		return inventory;
	}

	private select(kind: WorkbenchSelectionKind, id: string): void {
		const inventory = this.inventory();
		const artifact = workbenchArtifactValue(inventory, kind, id);
		if (!artifact) {
			const choices = deriveWorkbenchView(inventory).selections
				.filter((item) => item.kind === kind)
				.map((item) => item.id);
			throw new WorkbenchSelectionRequiredError(kind, choices);
		}
		const focus = selectWorkbenchFocus(
			loadWorkbenchFocus(this.stateRoot, this.projectId, this.dependencies.now),
			kind,
			{ id, hash: hashValue(artifact) },
			this.dependencies.now,
		);
		saveWorkbenchFocus(this.stateRoot, focus);
	}

	private async confirm(
		input: WorkbenchDecisionInput,
		gate: WorkbenchHumanGate,
		title: string,
		subject: unknown,
		signal?: AbortSignal,
	): Promise<string> {
		abortIfRequested(signal);
		const exact = boundedSubject(subject, input.kind);
		const confirmation: WorkbenchConfirmation = {
			kind: input.kind,
			title,
			reason: input.reason,
			subject: exact,
			subjectHash: hashValue(exact),
		};
		const decision = await gate.confirm(confirmation, signal);
		abortIfRequested(signal);
		if (!decision.approved) throw new WorkbenchDecisionDeclinedError(input.kind);
		return actorId(decision.actorId);
	}

	async view(queryValue: WorkbenchViewQuery = {}): Promise<WorkbenchView> {
		const query = WorkbenchViewQuerySchema.parse(queryValue);
		const inventory = this.inventory();
		const view = deriveWorkbenchView(inventory);
		const aspect = query.aspect ?? "summary";
		if (aspect === "summary") return view;
		if (aspect === "target") {
			return {
				...view,
				detail: {
					aspect,
					content: inventory.target
						? { ...this.dependencies.inspectTargetAuthoringContext({
							repositoryDir: this.projectDir,
							expectedTarget: {
								id: inventory.target.manifest.id,
								gitSha: inventory.target.gitSha,
							},
							...(query.resourcePath ? { resourcePath: query.resourcePath } : {}),
						}) }
						: { launch: "ahde init ." },
				},
			};
		}
		if (aspect === "traces") {
			const run = requireDevelopmentEval(inventory);
			const diagnosis = this.dependencies.diagnoseEval(this.runsRoot, run.evalRunId);
			const improvementBrief = this.dependencies.compileImprovementBrief(this.runsRoot, diagnosis);
			const link = boundedEvidenceLink(await this.dependencies.evidenceLink(run));
			return {
				...view,
				detail: {
					aspect,
					content: {
						evaluation: { evalRunId: run.evalRunId, summary: run.summary, repetitions: run.repetitions },
						diagnosis: diagnosisSummary(diagnosis),
						improvementBrief: conversationalImprovementBrief(improvementBrief),
						evidence: link ? { available: true, ...link } : { available: false },
					},
				},
			};
		}
		let content: Record<string, unknown>;
		switch (view.stage) {
			case "spec-review": {
				const draft = requireSpecDraft(inventory);
				content = { kind: "spec-draft", id: draft.id, snapshotHash: hashValue(draft), spec: draft.spec };
				break;
			}
			case "corpus-review": {
				const approved = requireApprovedSpec(inventory);
				const draft = requireCorpusDraft(inventory, undefined, approved.id, true);
				content = { kind: "corpus-draft", id: draft.id, draftHash: hashValue(draft), approvedSpec: draft.approvedSpec, name: draft.name, coverageNotes: draft.coverageNotes, importSource: draft.importSource ?? null, tasks: draft.tasks, taskProvenance: draft.taskProvenance ?? [] };
				break;
			}
			case "proposal-review":
				content = { kind: "proposal", ...proposalReview(requireProposal(inventory, "open").record) };
				break;
			case "candidate-review":
			case "release-decision":
				content = { kind: "candidate", ...candidateSummary(requireCandidate(inventory, ["proposed", "built", "validated", "evaluated", "reviewed"])) };
				break;
			case "candidate-verification": {
				const partial = inventory.candidates.filter((candidate) =>
					candidate.projectId === this.projectId &&
					["proposed", "built", "validated"].includes(candidateStatus(candidate)) &&
					!inventory.abandonedCandidates.has(candidate.candidateId)
				);
				if (partial.length > 0) {
					const candidate = resolveOne({
						items: partial,
						focusId: inventory.validFocus.candidate?.id,
						id: (item) => item.candidateId,
						label: "interrupted candidate",
					});
					content = { kind: "interrupted-candidate", ...candidateSummary(candidate) };
					break;
				}
				const proposal = requireProposal(inventory, "applied");
				const receipt = loadBuilderApplyReceipt(this.runsRoot, proposal.record.runId);
				content = {
					kind: "applied-proposal",
					...proposalReview(proposal.record),
					application: {
						branch: receipt.branch,
						baseTargetSha: receipt.baseTargetSha,
						candidateSha: receipt.candidateSha,
						appliedAt: receipt.appliedAt,
					},
				};
				break;
			}
			default:
				content = { kind: "workflow", stage: view.stage, headline: view.headline };
		}
		boundedSubject(content, "review detail");
		return { ...view, detail: { aspect: "review", content } };
	}

	async submit(
		inputValue: WorkbenchSubmitInput,
		options: { signal?: AbortSignal } = {},
	): Promise<WorkbenchTurn> {
		const input = WorkbenchSubmitInputSchema.parse(inputValue);
		abortIfRequested(options.signal);
		if (input.kind === "select") {
			this.select(input.entity, input.id);
			return { kind: input.kind, message: `Selected ${input.entity} ${input.id}.`, artifact: { kind: input.entity, id: input.id }, view: await this.view() };
		}
		if (input.kind === "spec-draft") {
			const draft = this.dependencies.saveSpecDraft({
				stateRoot: this.stateRoot,
				projectId: this.projectId,
				spec: input.spec,
				...(input.sourceText !== undefined ? { sourceText: input.sourceText } : {}),
				now: this.dependencies.now,
			});
			this.select("spec-draft", draft.id);
			return { kind: input.kind, message: "Spec draft saved. Review it before approval.", artifact: { id: draft.id, snapshotHash: hashValue(draft), status: draft.status }, view: await this.view() };
		}
		if (input.kind === "corpus-draft") {
			const inventory = this.inventory();
			const approved = requireApprovedSpec(inventory, input.approvedSpecId);
			const exact = loadApprovedSpec({ stateRoot: this.stateRoot, projectId: this.projectId, specId: approved.id });
			const result = this.dependencies.createCorpusDraft({
				stateRoot: this.stateRoot,
				approvedSpec: exact.reference,
				name: input.name,
				tasks: input.tasks,
				coverageNotes: input.coverageNotes,
				revisionSummary: input.revisionSummary,
			}, { now: this.dependencies.now });
			this.select("corpus-draft", result.draft.id);
			return { kind: input.kind, message: "Corpus draft saved. Revise freely or publish it through the human gate.", artifact: { id: result.draft.id, draftHash: hashValue(result.draft), taskCount: result.draft.tasks.length, approvedSpecId: result.draft.approvedSpec.specId }, view: await this.view() };
		}
		if (input.kind === "corpus-import") {
			const inventory = this.inventory();
			const approved = requireApprovedSpec(inventory, input.approvedSpecId);
			const exact = loadApprovedSpec({ stateRoot: this.stateRoot, projectId: this.projectId, specId: approved.id });
			const result = this.dependencies.importCorpusDraft({
				stateRoot: this.stateRoot,
				projectDir: this.projectDir,
				runsRoot: this.runsRoot,
				approvedSpec: exact.reference,
				sourcePath: input.sourcePath,
				name: input.name,
				coverageNotes: input.coverageNotes,
				revisionSummary: input.revisionSummary,
			}, { now: this.dependencies.now });
			this.select("corpus-draft", result.draft.id);
			return {
				kind: input.kind,
				message: "Project-local JSONL imported into an immutable, editable Spec-bound corpus draft.",
				artifact: {
					id: result.draft.id,
					draftHash: hashValue(result.draft),
					taskCount: result.draft.tasks.length,
					approvedSpecId: result.draft.approvedSpec.specId,
					importReceipt: {
						id: result.receipt.id,
						source: result.receipt.source,
					},
				},
				view: await this.view(),
			};
		}
		if (input.kind === "corpus-revision") {
			const inventory = this.inventory();
			const approved = requireApprovedSpec(inventory, input.approvedSpecId);
			const exact = loadApprovedSpec({ stateRoot: this.stateRoot, projectId: this.projectId, specId: approved.id });
			const parent = requireCorpusDraft(inventory, input.parentDraftId, approved.id);
			let operations: readonly unknown[] = input.operations;
			let verifiedTaskProvenance: readonly unknown[] = [];
			if (input.operations.some((operation) => operation.type === "add-case-from-run")) {
				const development = requireDevelopmentCorpus(inventory, undefined, approved.id);
				if (!inventory.target) throw new Error("add-case-from-run requires a resolved Target");
				const resolved = resolveDevelopmentFailureOperations({
					runsRoot: this.runsRoot,
					approvedSpec: exact.reference,
					target: inventory.target,
					developmentCorpus: loadCorpus({
						stateRoot: this.stateRoot,
						projectId: this.projectId,
						corpusId: development.id,
					}),
					compatibleEvalRuns: compatibleDevelopmentEvals(inventory, approved.id, development.id),
					operations: input.operations,
				});
				operations = resolved.operations;
				verifiedTaskProvenance = resolved.verifiedTaskProvenance;
			}
			const result = this.dependencies.reviseCorpusDraft({
				stateRoot: this.stateRoot,
				approvedSpec: exact.reference,
				parentDraftId: parent.id,
				operations,
				verifiedTaskProvenance,
				revisionSummary: input.revisionSummary,
			}, { now: this.dependencies.now });
			this.select("corpus-draft", result.draft.id);
			return { kind: input.kind, message: "New immutable corpus-draft revision saved.", artifact: { id: result.draft.id, parentDraftId: parent.id, draftHash: hashValue(result.draft), taskCount: result.draft.tasks.length }, view: await this.view() };
		}

		const inventory = this.inventory();
		if (deriveWorkbenchView(inventory).stage !== "improvement-authoring") {
			throw new Error("structured proposal authoring is only legal after a conclusive development evaluation");
		}
		const approved = requireApprovedSpec(inventory, input.approvedSpecId);
		const corpus = requireDevelopmentCorpus(inventory, undefined, approved.id);
		if (inventory.validFocus["development-corpus"]?.id && inventory.validFocus["development-corpus"]!.id !== corpus.id) {
			throw new Error("focused development corpus is not in the selected approved Spec lineage");
		}
		const sourceEvalRunId = requireDevelopmentEval(
			inventory,
			input.source.evalRunId,
			compatibleDevelopmentEvals(inventory, approved.id, corpus.id),
		).evalRunId;
		const diagnosis = this.dependencies.diagnoseEval(this.runsRoot, sourceEvalRunId);
		const improvementBrief = this.dependencies.compileImprovementBrief(this.runsRoot, diagnosis);
		const selectedEvidence = deriveEvidenceLinkedProposalSelection(improvementBrief, {
			...input.source,
			failureModeIds: input.failureModeIds,
		});
		if (!inventory.target) throw new Error("structured proposal authoring requires one exact Target");
		const authoringContext = this.dependencies.inspectTargetAuthoringContext({
			repositoryDir: this.projectDir,
			expectedTarget: {
				id: inventory.target.manifest.id,
				gitSha: inventory.target.gitSha,
			},
		});
		if (canonicalJson(input.authoringContext) !== canonicalJson(authoringContext.claim)) {
			throw new Error("Target authoring context is stale; refresh the Target overview and every replaced resource.");
		}
		const proposal = this.dependencies.compileHarnessProposal({
			repositoryDir: this.projectDir,
			expectedBaseTargetSha: authoringContext.target.gitSha,
			intents: input.intents,
			summary: input.summary,
			diagnoses: selectedEvidence.diagnoses,
			risks: input.risks,
			validationPlan: input.validationPlan,
		});
		if (proposal.baseTargetSha !== authoringContext.target.gitSha) {
			throw new Error("compiled proposal does not match the inspected Target authoring revision");
		}
		const result = await this.dependencies.recordProposal({
			proposal,
			targetDir: this.projectDir,
			allowedPaths: [...CANDIDATE_SCOPE_POLICY.allowed],
			approvedSpec: { stateRoot: this.stateRoot, projectId: this.projectId, specId: approved.id },
			runsRoot: this.runsRoot,
			timeoutMs: 30_000,
			sourceEvalRunId,
			proposalBasis: {
				...input.source,
				failureModeIds: input.failureModeIds,
			},
			authoringContext: authoringContext.claim,
			signal: options.signal,
		});
		if (result.record.result.status !== "completed") {
			const failure = result.record.result.error;
			throw new Error(
				`structured proposal recording failed closed (${result.record.result.status})` +
				(failure ? `: ${failure.code}: ${failure.message}` : ""),
			);
		}
		if (result.record.result.proposal?.decision === "propose") {
			this.select("proposal", result.record.runId);
			return { kind: input.kind, message: "Selected failure modes compiled into an evidence-linked, exact reviewable proposal.", artifact: { runId: result.record.runId, proposalHash: result.record.artifacts.proposal?.sha256 ?? null, sourceEvalRunId: result.record.request.source?.evalRunId ?? null, improvementBriefId: selectedEvidence.basis.briefId, failureModeIds: selectedEvidence.basis.failureModes.map((mode) => mode.failureModeId), approvedSpecId: approved.id, authoringContextHash: authoringContext.contextHash }, view: await this.view() };
		}
		return {
			kind: input.kind,
			message: "Structured authoring produced a durable no-change result; there is no diff to review or apply.",
			artifact: { runId: result.record.runId, proposalHash: null, decision: "no-change", sourceEvalRunId, improvementBriefId: selectedEvidence.basis.briefId, failureModeIds: selectedEvidence.basis.failureModes.map((mode) => mode.failureModeId), approvedSpecId: approved.id, authoringContextHash: authoringContext.contextHash },
			view: await this.view(),
		};
	}

	async decide(
		inputValue: WorkbenchDecisionInput,
		gate: WorkbenchHumanGate,
		options: WorkbenchDecisionExecutionOptions = {},
	): Promise<WorkbenchDecisionResult> {
		const input = WorkbenchDecisionInputSchema.parse(inputValue);
		abortIfRequested(options.signal);
		const inventory = this.inventory();
		const stage = deriveWorkbenchView(inventory).stage;
		if (input.kind === "run-current") {
			const partialCandidate = inventory.candidates.find((candidate) =>
				candidate.projectId === this.projectId &&
				["proposed", "built", "validated"].includes(candidateStatus(candidate)) &&
				!inventory.abandonedCandidates.has(candidate.candidateId),
			);
			if (partialCandidate) {
				throw new Error(
					`candidate ${partialCandidate.candidateId} stopped at ${candidateStatus(partialCandidate)}; ` +
					"review and explicitly abandon or recover it before starting another run",
				);
			}
			let resolved: WorkbenchDecisionResult;
			if (stage === "ready-to-evaluate" || stage === "improvement-authoring") {
				resolved = await this.decide({ kind: "run-eval", repetitions: input.repetitions, reason: input.reason }, gate, options);
			} else if (stage === "candidate-verification") {
				const appliedWithoutCandidate = inventory.proposals.filter((proposal) =>
					proposal.status === "applied" && !inventory.candidates.some((candidate) =>
						candidate.origin.kind === "applied-builder" &&
						candidate.origin.builderRunId === proposal.record.runId &&
						!inventory.abandonedCandidates.has(candidate.candidateId),
					),
				);
				const proposal = resolveOne({
					items: appliedWithoutCandidate,
					focusId: inventory.validFocus.proposal?.id,
					id: (item) => item.record.runId,
					label: "applied proposal",
				});
				resolved = await this.decide({ kind: "verify-candidate", builderRunId: proposal.record.runId, repetitions: input.repetitions, reason: input.reason }, gate, options);
			} else {
				throw new Error(`/run is not legal during ${stage}; complete the current review gate first`);
			}
			return {
				...resolved,
				kind: "run-current",
				message: resolved.message,
				result: { resolvedAs: resolved.kind, ...resolved.result },
				};
		}
		assertWorkbenchDecisionStage(input.kind, stage);

		if (input.kind === "scaffold-target") {
			if (inventory.target) throw new WorkbenchStaleDecisionError(input.kind);
			if (!this.templateDir) throw new Error("AHDE Builder is missing its trusted starter template");
			const before = this.dependencies.describeTargetScaffold({
				projectDir: this.projectDir,
				templateDir: this.templateDir,
			});
			const actor = await this.confirm(input, gate, "Create exact Target harness", before, options.signal);
			const current = this.decisionInventory(input.kind);
			if (current.target) throw new WorkbenchStaleDecisionError(input.kind);
			const after = this.dependencies.describeTargetScaffold({
				projectDir: this.projectDir,
				templateDir: this.templateDir,
			});
			if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
			const result = this.dependencies.applyTargetScaffold({
				projectDir: this.projectDir,
				stateRoot: this.stateRoot,
				templateDir: this.templateDir,
				expectedSubjectHash: hashValue(before),
				actor: { kind: "human", id: actor },
				reason: input.reason,
			});
			return {
				kind: input.kind,
				message: "Target harness created. Choose its identity and model next.",
				result: {
					targetId: result.target.manifest.id,
					targetGitSha: result.target.gitSha,
					receiptId: result.receipt.id,
				},
				view: await this.view(),
			};
		}

		if (input.kind === "configure-target") {
			if (!inventory.target) throw new WorkbenchStaleDecisionError(input.kind);
			const describe = () => this.dependencies.describeTargetBootstrap({
				targetDir: this.projectDir,
				stateRoot: this.stateRoot,
				runsRoot: this.runsRoot,
				targetId: input.targetId,
				model: input.model,
			});
			const before = describe();
			const actor = await this.confirm(input, gate, "Configure exact Target identity and model", before, options.signal);
			const current = this.decisionInventory(input.kind);
			if (!current.target) throw new WorkbenchStaleDecisionError(input.kind);
			const after = describe();
			if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
			const result = this.dependencies.configureTargetBootstrap({
				targetDir: this.projectDir,
				stateRoot: this.stateRoot,
				runsRoot: this.runsRoot,
				targetId: input.targetId,
				model: input.model,
				expectedSubjectHash: before.subjectHash,
				actor: { kind: "human", id: actor },
				reason: input.reason,
			});
			return {
				kind: input.kind,
				message: "Target identity and model configured in a one-time reviewed commit.",
				result: {
					targetId: result.manifest.id,
					targetGitSha: result.receipt.configuredTargetSha,
					receiptId: result.receipt.id,
					credentialEnv: result.manifest.model.apiKeyEnv,
				},
				view: await this.view(),
			};
		}

		if (input.kind === "approve-spec") {
			const draft = requireSpecDraft(inventory, input.draftSpecId);
			const beforeDescription = this.dependencies.describeSpecApproval(this.stateRoot, this.projectId, draft.id);
			const before = { ...beforeDescription, spec: draft.spec };
			const actor = await this.confirm(input, gate, "Approve exact Spec draft", before, options.signal);
			const current = this.decisionInventory(input.kind);
			const reloadedDraft = requireSpecDraft(current, draft.id);
			const afterDescription = this.dependencies.describeSpecApproval(this.stateRoot, this.projectId, draft.id);
			const after = { ...afterDescription, spec: reloadedDraft.spec };
			if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
			const result = this.dependencies.approveSpecDraft({ stateRoot: this.stateRoot, projectId: this.projectId, draftSpecId: draft.id, expectedDraftSnapshotHash: beforeDescription.draftSnapshotHash, actor: { kind: "human", id: actor }, reason: input.reason }, { now: this.dependencies.now });
			this.select("approved-spec", result.approved.id);
			return { kind: input.kind, message: "Spec approved as an exact immutable snapshot.", result: { approvedSpecId: result.approved.id, receiptId: result.receipt.id }, view: await this.view() };
		}

		if (input.kind === "abandon-candidate") {
			const candidates = inventory.candidates.filter((candidate) =>
				candidate.projectId === this.projectId &&
				["proposed", "built", "validated"].includes(candidateStatus(candidate)) &&
				!inventory.abandonedCandidates.has(candidate.candidateId)
			);
			const candidate = resolveOne({
				items: candidates,
				explicitId: input.candidateId,
				focusId: inventory.validFocus.candidate?.id,
				id: (item) => item.candidateId,
				label: "interrupted candidate",
			});
			const status = candidateStatus(candidate);
			if (status !== "proposed" && status !== "built" && status !== "validated") {
				throw new Error("only an interrupted candidate checkpoint can be abandoned");
			}
			const before = {
				operation: "abandon-interrupted-candidate",
				candidateHash: hashValue(candidate),
				candidate: candidateSummary(candidate),
			};
			const actor = await this.confirm(input, gate, "Abandon interrupted candidate attempt", before, options.signal);
			const current = this.decisionInventory(input.kind);
			if (current.abandonedCandidates.has(candidate.candidateId)) throw new WorkbenchStaleDecisionError(input.kind);
			const reloaded = requireCandidate(current, [status], candidate.candidateId);
			if (hashValue(reloaded) !== hashValue(candidate)) throw new WorkbenchStaleDecisionError(input.kind);
			const receipt = recordCandidateAbandonment({
				stateRoot: this.stateRoot,
				projectId: this.projectId,
				candidate: reloaded,
				interruptedStatus: status,
				actor: { kind: "human", id: actor },
				reason: input.reason,
				now: this.dependencies.now,
			});
			if (candidate.origin.kind === "applied-builder") {
				this.select("proposal", candidate.origin.builderRunId);
			}
			return {
				kind: input.kind,
				message: "Interrupted candidate attempt abandoned durably; the exact applied proposal can be retried.",
				result: { candidateId: candidate.candidateId, interruptedStatus: status, receiptHash: receipt.receiptHash },
				view: await this.view(),
			};
		}

		if (input.kind === "publish-corpus") {
			const approved = requireApprovedSpec(inventory);
			const draft = requireCorpusDraft(inventory, input.draftId, approved.id, true);
			const name = input.name ?? draft.name;
			const publication = this.dependencies.describeCorpusPublication({ projectId: this.projectId, name, tasks: draft.tasks });
			const before = { operation: "publish-development-corpus", draftId: draft.id, draftHash: hashValue(draft), approvedSpec: draft.approvedSpec, publication, tasks: draft.tasks };
			const actor = await this.confirm(input, gate, "Publish exact development corpus", before, options.signal);
			const current = this.decisionInventory(input.kind);
			const currentApproved = requireApprovedSpec(current, approved.id);
			const reloaded = requireCorpusDraft(current, draft.id, currentApproved.id, true);
			const afterPublication = this.dependencies.describeCorpusPublication({ projectId: this.projectId, name, tasks: reloaded.tasks });
			const after = { operation: "publish-development-corpus", draftId: reloaded.id, draftHash: hashValue(reloaded), approvedSpec: reloaded.approvedSpec, publication: afterPublication, tasks: reloaded.tasks };
			if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
			let matchingExisting: CorpusMetadata[];
			try {
				matchingExisting = listCorpora({ stateRoot: this.stateRoot, projectId: this.projectId }).filter((corpus) =>
					corpus.visibility === "development" &&
					corpus.name === name &&
					corpus.hash === publication.contentHash &&
					corpus.taskCount === publication.taskCount
				);
			} catch {
				throw new Error("development corpus inventory is unavailable; publication cannot be recovered safely");
			}
			if (matchingExisting.length > 1) throw new Error("multiple development corpora match the reviewed publication subject");
			const result = matchingExisting[0]
				? (() => {
					const corpus = matchingExisting[0]!;
					const receipt = loadDevelopmentCorpusPublicationReceipt(this.stateRoot, this.projectId, corpus.id);
					if (receipt.subject.subjectHash !== publication.subjectHash || receipt.corpus.hash !== corpus.hash) {
						throw new Error("existing corpus publication receipt does not match the reviewed subject");
					}
					return { corpus, receipt, receiptPath: "recovered-existing-publication" };
				})()
				: this.dependencies.publishDevelopmentCorpus({ stateRoot: this.stateRoot, projectId: this.projectId, name, tasks: reloaded.tasks, expectedSubjectHash: publication.subjectHash, actor: { kind: "human", id: actor }, reason: input.reason }, { now: this.dependencies.now });
			const lineage = recordWorkbenchCorpusPublication({ stateRoot: this.stateRoot, draft: reloaded, publication: result });
			this.select("development-corpus", result.corpus.id);
			return { kind: input.kind, message: "Development corpus published with exact Spec and draft lineage.", result: { corpusId: result.corpus.id, corpusHash: result.corpus.hash, taskCount: result.corpus.taskCount, publicationReceiptId: result.receipt.id, lineageHash: lineage.linkHash }, view: await this.view() };
		}

		if (input.kind === "run-eval") {
			if (!inventory.target) throw new Error("Target is not ready");
			const approved = requireApprovedSpec(inventory);
			const corpus = requireDevelopmentCorpus(inventory, input.developmentCorpusId, approved.id);
			const build = (): { target: ResolvedTarget; subject: Record<string, unknown> } => {
				const current = this.decisionInventory(input.kind);
				const currentApproved = requireApprovedSpec(current, approved.id);
				const currentCorpus = requireDevelopmentCorpus(current, corpus.id, currentApproved.id);
				let target = loadTarget(this.projectDir);
				const receipt = loadDevelopmentCorpusPublicationReceipt(this.stateRoot, this.projectId, currentCorpus.id);
				const lineage = current.developmentLineage.get(currentCorpus.id);
				const loaded = loadCorpus({ stateRoot: this.stateRoot, projectId: this.projectId, corpusId: currentCorpus.id });
				if (
					!lineage ||
					lineage.publication.approvedSpecId !== currentApproved.id ||
					loaded.metadata.visibility !== "development" ||
					loaded.metadata.hash !== receipt.corpus.hash
				) throw new Error("development corpus does not match its reviewed Spec lineage");
				target = targetWithDevelopmentCorpus(target, loaded);
				return { target, subject: { operation: "run-development-evaluation", projectId: this.projectId, approvedSpec: { id: currentApproved.id, snapshotHash: hashValue(currentApproved) }, target: { id: target.manifest.id, gitSha: target.gitSha, toolsetHash: target.toolsetHash }, dataset: target.manifest.evalSuite.dataset, datasetHash: target.datasetHash, suiteHash: target.suiteHash, taskCount: target.tasks.length, repetitions: input.repetitions, developmentCorpus: { id: loaded.metadata.id, hash: loaded.metadata.hash, taskCount: loaded.metadata.taskCount, lineageHash: lineage.publication.linkHash } } };
			};
			const before = build();
			await this.confirm(input, gate, "Run exact development evaluation", before.subject, options.signal);
			const after = build();
			if (!exactSame(before.subject, after.subject)) throw new WorkbenchStaleDecisionError(input.kind);
			const record = await this.dependencies.runSuite(after.target, {
				runsRoot: this.runsRoot,
				label: "solo",
				repetitions: input.repetitions,
				...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			});
			abortIfRequested(options.signal);
			const diagnosis = this.dependencies.diagnoseEval(this.runsRoot, record.evalRunId);
			const improvementBrief = this.dependencies.compileImprovementBrief(this.runsRoot, diagnosis);
			const link = boundedEvidenceLink(await this.dependencies.evidenceLink(record));
			this.select("eval-run", record.evalRunId);
			return { kind: input.kind, message: improvementBrief.headline, result: { evaluation: { evalRunId: record.evalRunId, summary: record.summary, repetitions: record.repetitions }, diagnosis: diagnosisSummary(diagnosis), improvementBrief: conversationalImprovementBrief(improvementBrief), evidence: link ? { available: true, ...link } : { available: false } }, view: await this.view() };
		}

		if (input.kind === "apply-proposal") {
			const proposal = requireProposal(inventory, "open", input.runId);
			const before = { operation: "apply-proposal", branch: input.branch, builderRunHash: hashValue(proposal.record), ...proposalReview(proposal.record) };
			const actor = await this.confirm(input, gate, "Apply exact Builder proposal", before, options.signal);
			const current = this.decisionInventory(input.kind);
			const afterProposal = requireProposal(current, "open", proposal.record.runId);
			const after = { operation: "apply-proposal", branch: input.branch, builderRunHash: hashValue(afterProposal.record), ...proposalReview(afterProposal.record) };
			if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
			const result = this.dependencies.applyProposal({ repoDir: this.projectDir, runsRoot: this.runsRoot, runId: proposal.record.runId, expectedBuilderRunHash: after.builderRunHash, requestedBranch: input.branch, actor: { kind: "human", id: actor }, reason: input.reason });
			this.select("proposal", proposal.record.runId);
			return { kind: input.kind, message: "Proposal applied to an exact candidate branch; verification is now required.", result: { runId: result.receipt.runId, branch: result.receipt.branch, candidateSha: result.receipt.candidateSha, proposalHash: result.receipt.proposalSha256 }, view: await this.view() };
		}

		if (input.kind === "discard-proposal") {
			const proposal = requireProposal(inventory, "open", input.runId);
			const before = this.dependencies.describeProposalDiscard(this.runsRoot, proposal.record.runId);
			const actor = await this.confirm(input, gate, "Discard exact Builder proposal", before, options.signal);
			const current = this.decisionInventory(input.kind);
			requireProposal(current, "open", proposal.record.runId);
			const after = this.dependencies.describeProposalDiscard(this.runsRoot, proposal.record.runId);
			if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
			const result = this.dependencies.discardProposal({ runsRoot: this.runsRoot, runId: proposal.record.runId, actor: { kind: "human", id: actor }, reason: input.reason, expectedSubjectHash: before.subjectHash }, { now: this.dependencies.now });
			return { kind: input.kind, message: "Proposal discarded durably.", result: { runId: result.receipt.runId, receiptHash: hashValue(result.receipt) }, view: await this.view() };
		}

		if (input.kind === "verify-candidate") {
			const interrupted = inventory.candidates.find((candidate) =>
				["proposed", "built", "validated"].includes(candidateStatus(candidate)) &&
				!inventory.abandonedCandidates.has(candidate.candidateId)
			);
			if (interrupted) {
				throw new Error(
					`candidate ${interrupted.candidateId} stopped at ${candidateStatus(interrupted)}; ` +
					"review and explicitly abandon or recover it before starting another verification",
				);
			}
			const proposal = requireProposal(inventory, "applied", input.builderRunId);
			let sealed: CorpusMetadata[];
			try {
				sealed = listCorpora({ stateRoot: this.stateRoot, projectId: this.projectId }).filter((corpus) => corpus.visibility === "sealed");
			} catch {
				throw new Error("evaluator-owned sealed holdout inventory is unavailable; identities remain hidden");
			}
			if (sealed.length === 0) throw new Error("Candidate verification requires an evaluator-owned sealed holdout corpus");
			const choice = await gate.selectSealed({ title: "Select evaluator-only sealed holdout", options: sealed.map((corpus, index) => ({ label: `Holdout ${index + 1} · ${corpus.name}`, taskCount: corpus.taskCount })) }, options.signal);
			abortIfRequested(options.signal);
			if (!choice.approved) throw new WorkbenchDecisionDeclinedError(input.kind);
			if (choice.selectedIndex === undefined || !sealed[choice.selectedIndex]) throw new Error("human gate returned an invalid sealed holdout selection");
			const selected = sealed[choice.selectedIndex]!;
			const build = () => {
				const current = this.decisionInventory(input.kind);
				const partial = current.candidates.find((candidate) =>
					["proposed", "built", "validated"].includes(candidateStatus(candidate)) &&
					!current.abandonedCandidates.has(candidate.candidateId)
				);
				if (partial) throw new WorkbenchStaleDecisionError(input.kind);
				const currentProposal = requireProposal(current, "applied", proposal.record.runId);
				const builderRun = currentProposal.record;
				const applyReceipt = loadBuilderApplyReceipt(this.runsRoot, proposal.record.runId);
				if (builderRun.request.approvedSpec?.projectId !== this.projectId) throw new Error("Builder proposal is not bound to this project approved Spec");
				let sealedLoaded: ReturnType<typeof loadCorpus>;
				try {
					sealedLoaded = loadCorpus({ stateRoot: this.stateRoot, projectId: this.projectId, corpusId: selected.id });
				} catch {
					throw new Error("selected evaluator-owned holdout is unavailable or changed; identity remains hidden");
				}
				if (sealedLoaded.metadata.visibility !== "sealed" || sealedLoaded.metadata.hash !== selected.hash) throw new Error("sealed holdout changed");
				const development = builderRun.request.sourceAttestation?.developmentCorpus;
				let developmentCorpus: CorpusRef | undefined;
				if (development) {
					const receipt = loadDevelopmentCorpusPublicationReceipt(this.stateRoot, this.projectId, development.id);
					if (receipt.corpus.hash !== development.hash) throw new Error("Builder development source differs from its publication receipt");
					developmentCorpus = { stateRoot: this.stateRoot, projectId: this.projectId, corpusId: development.id };
				}
				return {
					subject: { operation: "verify-applied-candidate", builderRunId: builderRun.runId, builderRunHash: hashValue(builderRun), applyReceiptHash: hashValue(applyReceipt), proposalHash: builderRun.artifacts.proposal?.sha256 ?? null, baseTargetSha: applyReceipt.baseTargetSha, candidateSha: applyReceipt.candidateSha, approvedSpec: builderRun.request.approvedSpec, developmentCorpus: development ?? null, sealedHoldout: { id: selected.id, hash: selected.hash, taskCount: selected.taskCount }, repetitions: input.repetitions },
					approvedSpecId: builderRun.request.approvedSpec.specId,
					developmentCorpus,
					sealedCorpus: { stateRoot: this.stateRoot, projectId: this.projectId, corpusId: selected.id } satisfies CorpusRef,
				};
			};
			const before = build();
			const actor = await this.confirm(input, gate, "Verify exact applied candidate", before.subject, options.signal);
			if (choice.actorId && actorId(choice.actorId) !== actor) throw new Error("sealed selection and confirmation came from different human actors");
			const after = build();
			if (!exactSame(before.subject, after.subject)) throw new WorkbenchStaleDecisionError(input.kind);
			let result: Awaited<ReturnType<typeof runAppliedBuilderCandidate>>;
			try {
				result = await this.dependencies.runAppliedCandidate({
					repositoryDir: this.projectDir,
					runsRoot: this.runsRoot,
					builderRunId: proposal.record.runId,
					expectedBuilderRunHash: after.subject.builderRunHash,
					expectedApplyReceiptHash: after.subject.applyReceiptHash,
					projectId: this.projectId,
					approvedSpec: { stateRoot: this.stateRoot, specId: after.approvedSpecId },
					repetitions: input.repetitions,
					...(after.developmentCorpus ? { developmentCorpus: after.developmentCorpus } : {}),
					sealedCorpus: after.sealedCorpus,
					actorId: actor,
					...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
					...(options.signal ? { signal: options.signal } : {}),
				});
			} catch (error) {
				// Exact evaluator diagnostics remain host-only because thrown messages can
				// otherwise become Builder model context through a failed tool result.
				console.error("AHDE host-only candidate verification failure:", error);
				throw new Error("candidate verification failed after the sealed gate; sealed identities and contents remain hidden");
			}
			this.select("candidate", result.record.candidateId);
			return { kind: input.kind, message: "Candidate verification completed on development and evaluator-only sealed evidence.", result: { candidate: candidateSummary(result.record), sealedHoldout: { executed: result.sealedHoldout !== null, gatePassed: result.sealedHoldout !== null } }, view: await this.view() };
		}

		if (input.kind === "review-candidate") {
			const candidate = requireCandidate(inventory, ["evaluated"], input.candidateId);
			const before = { operation: "review-candidate", candidateHash: hashValue(candidate), candidate: candidateSummary(candidate), recommendation: input.recommendation };
			const actor = await this.confirm(input, gate, "Record exact candidate review", before, options.signal);
			const current = this.decisionInventory(input.kind);
			const after = requireCandidate(current, ["evaluated"], candidate.candidateId);
			if (hashValue(after) !== hashValue(candidate)) throw new WorkbenchStaleDecisionError(input.kind);
			const reviewed = this.dependencies.reviewCandidate({ runsRoot: this.runsRoot, candidateId: candidate.candidateId, expectedCandidateHash: before.candidateHash, recommendation: input.recommendation, reason: input.reason, actorId: actor, now: this.dependencies.now });
			this.select("candidate", reviewed.candidateId);
			return { kind: input.kind, message: "Human candidate review recorded.", result: candidateSummary(reviewed), view: await this.view() };
		}

		if (input.kind === "promote-candidate") {
			const candidate = requireCandidate(inventory, ["reviewed"], input.candidateId);
			const before = { operation: "promote-candidate", candidateHash: hashValue(candidate), candidate: candidateSummary(candidate), version: input.version, tag: `v${input.version}` };
			const actor = await this.confirm(input, gate, "Promote exact candidate", before, options.signal);
			const current = this.decisionInventory(input.kind);
			if (hashValue(requireCandidate(current, ["reviewed"], candidate.candidateId)) !== hashValue(candidate)) throw new WorkbenchStaleDecisionError(input.kind);
			const promoted = this.dependencies.promoteCandidate({ repositoryDir: this.projectDir, runsRoot: this.runsRoot, candidateId: candidate.candidateId, expectedCandidateHash: before.candidateHash, version: input.version, reason: input.reason, actorId: actor, now: this.dependencies.now });
			this.select("candidate", promoted.record.candidateId);
			return { kind: input.kind, message: `Candidate promoted as ${promoted.tag}.`, result: { candidate: candidateSummary(promoted.record), tag: promoted.tag, candidateSha: promoted.candidateSha }, view: await this.view() };
		}

		const candidate = requireCandidate(inventory, ["reviewed"], input.candidateId);
		const before = { operation: "reject-candidate", candidateHash: hashValue(candidate), candidate: candidateSummary(candidate) };
		const actor = await this.confirm(input, gate, "Reject exact candidate", before, options.signal);
		const current = this.decisionInventory(input.kind);
		if (hashValue(requireCandidate(current, ["reviewed"], candidate.candidateId)) !== hashValue(candidate)) throw new WorkbenchStaleDecisionError(input.kind);
		const rejected = this.dependencies.rejectCandidate({ runsRoot: this.runsRoot, candidateId: candidate.candidateId, expectedCandidateHash: before.candidateHash, reason: input.reason, actorId: actor, now: this.dependencies.now });
		this.select("candidate", rejected.candidateId);
		return { kind: input.kind, message: "Candidate rejected durably.", result: candidateSummary(rejected), view: await this.view() };
	}
}

export function createAhdeWorkbench(options: AhdeWorkbenchOptions): AhdeWorkbench {
	return new AhdeWorkbench(options);
}

export function localWorkbenchActorId(): string {
	return `local:${userInfo().username || basename(resolve(process.cwd()))}`;
}
