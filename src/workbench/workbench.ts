import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
	MAX_BUILDER_CORPUS_DRAFT_TASKS,
} from "../application/builder-corpus-draft.js";
import { importBuilderCorpusDraft } from "../application/builder-corpus-import.js";
import {
	compileDatasetCases,
	datasetHoldoutInForce,
	ingestDataset,
	inspectDatasetFile,
	type DatasetHoldoutSpec,
} from "../application/dataset-ingest.js";
import {
	listDatasetRecipeSubmissions,
	loadDatasetRecipeSubmission,
	saveDatasetRecipeSubmission,
	type DatasetRecipeSubmission,
} from "../application/dataset-recipe.js";
import { resolveDevelopmentFailureOperations } from "../application/builder-regression-case.js";
import {
	compileHarnessAuthoringProposal,
	type HarnessAuthoringIntent,
} from "../application/harness-authoring.js";
import { inspectTargetAuthoringContext } from "../application/target-authoring-context.js";
import { runAppliedBuilderCandidate } from "../application/builder-candidate.js";
import { SEALED_GATE_POLICY } from "../domain/comparison-gate.js";
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
import {
	CANDIDATE_SCOPE_POLICY,
	runCandidateExperiment,
} from "../application/candidate-experiment.js";
import {
	decideCandidateRejection,
	promoteReviewedCandidate,
	reviewCandidate,
} from "../application/candidate-review.js";
import { assertGradersRunnable, targetWithDevelopmentCorpus } from "../application/corpus-target.js";
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
	type CorpusTask,
} from "../corpus.js";
import { redactTraceText } from "../trace.js";
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
import { inspectCandidateImpact } from "../application/candidate-impact.js";
import { judgeEvidenceCalibration } from "../application/judge-labels.js";
import {
	adoptTargetCandidate,
	describeTargetAdoption,
} from "../application/target-adoption.js";
import {
	clearWorkbenchFocus,
	loadWorkbenchFocus,
	saveWorkbenchFocus,
	selectWorkbenchFocus,
} from "./focus.js";
import { recordWorkbenchCorpusPublication } from "./corpus-publication.js";
import { recordCandidateAbandonment } from "./candidate-abandonment.js";
import {
	describeCycleContinuation,
	recordCycleContinuation,
} from "./cycle-continuation.js";
import {
	WorkbenchDecisionDeclinedError,
	WorkbenchSelectionRequiredError,
	WorkbenchStaleDecisionError,
} from "./errors.js";
import {
	deriveWorkbenchView,
	loadWorkbenchInventory,
	withWorkbenchFocus,
	openTerminalCandidatesOf,
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
import { calibrationProjection } from "./calibration.js";
import { assertWorkbenchDecisionStage } from "./transition-policy.js";
import {
	WorkbenchDecisionInputSchema,
	WorkbenchSubmitInputSchema,
	WorkbenchViewQuerySchema,
	type WorkbenchCandidateImpactProjection,
	type WorkbenchCandidateSummary,
	type WorkbenchConfirmation,
	type WorkbenchDatasetCase,
	type WorkbenchDecisionInput,
	type WorkbenchDecisionExecutionOptions,
	type WorkbenchDecisionResult,
	type WorkbenchHumanGate,
	type WorkbenchImprovementBriefProjection,
	type WorkbenchDatasetRecipeArtifact,
	type WorkbenchReviewDetail,
	type WorkbenchSelectionKind,
	type WorkbenchSubmitInput,
	type WorkbenchTargetDetail,
	type WorkbenchTurn,
	type WorkbenchView,
	type WorkbenchViewQuery,
} from "./types.js";
import type { CandidateRecord } from "../domain/candidate.js";

const MAX_REVIEW_BYTES = 5 * 1024 * 1024;
const MAX_CONVERSATION_MODES = 3;
/** Enough compiled cases to argue about; never enough to be the dataset. */
const MAX_DATASET_SAMPLE_CASES = 5;
const MAX_DATASET_CASE_CHARS = 400;
const MAX_DATASET_CASE_TURNS = 6;

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
	/** The one read of durable project state; a test may serve it from memory. */
	loadInventory: typeof loadWorkbenchInventory;
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
	/** The host reads `imports/`; the Builder only ever reads what these return. */
	inspectDataset: typeof inspectDatasetFile;
	compileDatasetCases: typeof compileDatasetCases;
	saveDatasetRecipe: typeof saveDatasetRecipeSubmission;
	ingestDataset: typeof ingestDataset;
	compileHarnessProposal: (input: CompileHarnessAuthoringInput) => CandidateProposal;
	recordProposal: typeof recordBuilderAuthoredProposal;
	runSuite: typeof runSuite;
	/** A/A calibration of one exact revision; never a promotion path. */
	runCalibration: typeof runCandidateExperiment;
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
	describeTargetAdoption: typeof describeTargetAdoption;
	adoptTargetCandidate: typeof adoptTargetCandidate;
	describeCycleContinuation: typeof describeCycleContinuation;
	recordCycleContinuation: typeof recordCycleContinuation;
	/** Bounded, host-only candidate impact projection; failures degrade to an explicit reason. */
	candidateImpact: (input: {
		runsRoot: string;
		stateRoot: string;
		projectId: string;
		candidate: CandidateRecord;
	}) => WorkbenchCandidateImpactProjection;
}

export interface AhdeWorkbenchOptions extends BuilderProjectContext {
	/** Trusted packaged starter. Builder input can select no alternate template. */
	templateDir?: string;
	dependencies?: Partial<AhdeWorkbenchDependencies>;
}

const DEFAULT_DEPENDENCIES: AhdeWorkbenchDependencies = {
	now: () => new Date().toISOString(),
	loadInventory: loadWorkbenchInventory,
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
	inspectDataset: inspectDatasetFile,
	compileDatasetCases,
	saveDatasetRecipe: saveDatasetRecipeSubmission,
	ingestDataset,
	compileHarnessProposal: compileHarnessAuthoringProposal,
	recordProposal: recordBuilderAuthoredProposal,
	runSuite,
	runCalibration: runCandidateExperiment,
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
	describeTargetAdoption,
	adoptTargetCandidate,
	describeCycleContinuation,
	recordCycleContinuation,
	candidateImpact: ({ runsRoot, candidate }) => ({
		available: true,
		impact: inspectCandidateImpact({
			runsRoot,
			candidateId: candidate.candidateId,
			expectedCandidateHash: hashValue(candidate),
		}),
	}),
};

/**
 * One spelling per path: the deepest existing ancestor is resolved through
 * symlinks (macOS /var → /private/var, symlinked checkouts) so every artifact
 * written under a root compares equal to the root the Workbench was opened with.
 */
export function canonicalPath(input: string): string {
	const absolute = resolve(input);
	try {
		return realpathSync(absolute);
	} catch {
		const parent = dirname(absolute);
		if (parent === absolute) return absolute;
		return join(canonicalPath(parent), basename(absolute));
	}
}

function abortIfRequested(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("operation aborted");
}

/** The finished candidate whose loop is still open; focus only breaks ties. */
function requireOpenTerminalCandidate(inventory: WorkbenchInventory, explicitId?: string): CandidateRecord {
	return resolveOne({
		items: openTerminalCandidatesOf(inventory),
		explicitId,
		focusId: inventory.validFocus.candidate?.id,
		id: (candidate) => candidate.candidateId,
		label: "finished candidate",
	});
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

function datasetText(value: string, max = MAX_DATASET_CASE_CHARS): string {
	const redacted = redactTraceText(value);
	return redacted.length <= max ? redacted : `${redacted.slice(0, max - 1)}…`;
}

function datasetGrader(grader: WorkbenchDatasetCase["graders"][number]): WorkbenchDatasetCase["graders"][number] {
	const named = grader.name !== undefined ? { name: datasetText(grader.name, 120) } : {};
	switch (grader.type) {
		case "tool_called":
			return {
				...grader,
				...named,
				tool: datasetText(grader.tool, 120),
				...(grader.argsContains !== undefined ? { argsContains: datasetText(grader.argsContains) } : {}),
			};
		case "output_contains":
			return { ...grader, ...named, text: datasetText(grader.text) };
		case "output_matches":
			return { ...grader, ...named, pattern: datasetText(grader.pattern) };
		case "judge":
			return {
				...grader,
				...named,
				...(grader.rubric !== undefined ? { rubric: datasetText(grader.rubric) } : {}),
				...(grader.assertions ? { assertions: grader.assertions.map((item) => datasetText(item)) } : {}),
			};
		case "exact":
		case "similarity":
			return { ...grader, ...named };
	}
}

/**
 * One compiled case as a human reads it: bounded, credential-redacted, and
 * carrying no derived id, so a sample can never be mistaken for the corpus.
 */
function datasetCasePreview(task: CorpusTask): WorkbenchDatasetCase {
	return {
		input: datasetText(task.input),
		expected: task.expected === undefined ? null : datasetText(task.expected),
		messages: task.messages
			? task.messages.slice(-MAX_DATASET_CASE_TURNS).map((message) => ({
				role: message.role,
				content: datasetText(message.content, 200),
			}))
			: null,
		metadata: task.metadata
			? Object.fromEntries(Object.entries(task.metadata).map(([key, value]) => [key, datasetText(value, 200)]))
			: null,
		graders: task.graders.map(datasetGrader),
	};
}

/** Small model-facing diagnosis projection; full evidence remains in the verified report. */
function conversationalImprovementBrief(brief: ImprovementBrief): WorkbenchImprovementBriefProjection {
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
		this.projectDir = canonicalPath(options.projectDir);
		this.stateRoot = canonicalPath(options.stateRoot);
		this.runsRoot = canonicalPath(options.runsRoot);
		this.projectId = resolveBuilderProjectId(options);
		this.templateDir = options.templateDir ? resolve(options.templateDir) : undefined;
		this.dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
	}

	private inventory(): WorkbenchInventory {
		return this.dependencies.loadInventory({
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

	/**
	 * One candidate as a human reads it, carrying how far the judge behind its
	 * evidence has been checked. Like impact, this is a review aid: an
	 * unreadable label store leaves the line off rather than blocking a decision.
	 */
	private candidateView(candidate: CandidateRecord): WorkbenchCandidateSummary {
		const evaluated = candidate.events.find((event) => event.type === "evaluated");
		if (evaluated?.type !== "evaluated") return candidateSummary(candidate);
		try {
			const calibration = judgeEvidenceCalibration({
				runsRoot: this.runsRoot,
				stateRoot: this.stateRoot,
				projectId: this.projectId,
				evalRunIds: [evaluated.evaluation.development.candidate.evalRunId],
			});
			if (calibration.specHashes.length === 0) return candidateSummary(candidate);
			return candidateSummary(
				candidate,
				calibration.stats
					? {
						agreement: calibration.stats.agreement,
						kappa: calibration.stats.kappa,
						labels: calibration.stats.n,
					}
					: null,
			);
		} catch {
			return candidateSummary(candidate);
		}
	}

	/** Impact is a review aid; an unavailable projection never blocks a human decision. */
	private candidateImpact(candidate: CandidateRecord): WorkbenchCandidateImpactProjection {
		if (!["evaluated", "reviewed", "promoted", "rejected"].includes(candidateStatus(candidate))) {
			return { available: false, reason: "candidate has no matched evaluation evidence yet" };
		}
		try {
			return this.dependencies.candidateImpact({
				runsRoot: this.runsRoot,
				stateRoot: this.stateRoot,
				projectId: this.projectId,
				candidate,
			});
		} catch (error) {
			return {
				available: false,
				reason: (error instanceof Error ? error.message : String(error)).slice(0, 500),
			};
		}
	}

	/** Selects one artifact and returns the state the caller's view should report. */
	private select(kind: WorkbenchSelectionKind, id: string): WorkbenchInventory {
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
		return withWorkbenchFocus(inventory, focus);
	}

	/**
	 * The holdout already in force for one inbox file. Once an import has sealed
	 * rows out of a file, every later read of that file replays the exact draw,
	 * so the reserved rows never reappear in a preview or a compiled case.
	 */
	private datasetHoldout(sourcePath: string): DatasetHoldoutSpec | null {
		return datasetHoldoutInForce(this.stateRoot, this.projectId, sourcePath);
	}

	/** The exact recipe under discussion: named, focused by recency, or ambiguous. */
	private requireDatasetRecipe(approvedSpecId: string, submissionId?: string): DatasetRecipeSubmission {
		if (submissionId) {
			const submission = loadDatasetRecipeSubmission(this.stateRoot, this.projectId, submissionId);
			if (submission.approvedSpec.specId !== approvedSpecId) {
				throw new Error("that dataset recipe belongs to a different approved Spec lineage");
			}
			return submission;
		}
		const submissions = listDatasetRecipeSubmissions(this.stateRoot, this.projectId)
			.filter((submission) => submission.approvedSpec.specId === approvedSpecId);
		const newest = submissions[0];
		if (!newest) throw new Error("submit a dataset-recipe and review its sample cases before importing");
		return newest;
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
		return this.viewOf(this.inventory(), queryValue);
	}

	/**
	 * Render a view from state that was already read. Every write path reads the
	 * inventory once after its write and reports that exact state, instead of
	 * paying for a second read of the same thing.
	 */
	private async viewOf(inventory: WorkbenchInventory, queryValue: WorkbenchViewQuery = {}): Promise<WorkbenchView> {
		const query = WorkbenchViewQuerySchema.parse(queryValue);
		const view = deriveWorkbenchView(inventory);
		const aspect = query.aspect ?? "summary";
		if (aspect === "summary") return view;
		if (aspect === "target") {
			const content: WorkbenchTargetDetail = inventory.target
				? this.dependencies.inspectTargetAuthoringContext({
					repositoryDir: this.projectDir,
					expectedTarget: {
						id: inventory.target.manifest.id,
						gitSha: inventory.target.gitSha,
					},
					...(query.resourcePath ? { resourcePath: query.resourcePath } : {}),
				})
				: { launch: "ahde init ." };
			return { ...view, detail: { aspect, content } };
		}
		if (aspect === "dataset") {
			const sourcePath = query.resourcePath!;
			const holdout = this.datasetHoldout(sourcePath);
			const preview = this.dependencies.inspectDataset({
				projectDir: this.projectDir,
				sourcePath,
				holdout,
			});
			return { ...view, detail: { aspect, content: { sourcePath, preview } } };
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
		let content: WorkbenchReviewDetail;
		switch (view.stage) {
			case "spec-review": {
				const draft = requireSpecDraft(inventory);
				content = { kind: "spec-draft", id: draft.id, snapshotHash: hashValue(draft), spec: draft.spec };
				break;
			}
			case "candidate-adoption":
			case "complete": {
				const candidate = requireOpenTerminalCandidate(inventory);
				const adoption = inventory.adoptedCandidates.get(candidate.candidateId) ?? null;
				const continuation = inventory.continuedCandidates.get(candidate.candidateId) ?? null;
				content = {
					kind: "candidate",
					...this.candidateView(candidate),
					adoption: adoption
						? { receiptId: adoption.receiptId, adoptedAt: adoption.adoptedAt, branch: adoption.intent.subject.branch.name }
						: null,
					continuation: continuation
						? { receiptId: continuation.receiptId, continuedAt: continuation.continuedAt }
						: null,
					impact: this.candidateImpact(candidate),
				};
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
			case "release-decision": {
				const candidate = requireCandidate(inventory, ["proposed", "built", "validated", "evaluated", "reviewed"]);
				content = {
					kind: "candidate",
					...this.candidateView(candidate),
					adoption: null,
					continuation: null,
					impact: this.candidateImpact(candidate),
				};
				break;
			}
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
			const settled = this.select(input.entity, input.id);
			return { kind: input.kind, message: `Selected ${input.entity} ${input.id}.`, artifact: { kind: input.entity, id: input.id }, view: await this.viewOf(settled) };
		}
		if (input.kind === "spec-draft") {
			const draft = this.dependencies.saveSpecDraft({
				stateRoot: this.stateRoot,
				projectId: this.projectId,
				spec: input.spec,
				...(input.sourceText !== undefined ? { sourceText: input.sourceText } : {}),
				now: this.dependencies.now,
			});
			const settled = this.select("spec-draft", draft.id);
			return { kind: input.kind, message: "Spec draft saved. Review it before approval.", artifact: { id: draft.id, snapshotHash: hashValue(draft), status: draft.status }, view: await this.viewOf(settled) };
		}
		if (input.kind === "corpus-draft") {
			const inventory = this.inventory();
			const approved = requireApprovedSpec(inventory, input.approvedSpecId);
			const exact = loadApprovedSpec({ stateRoot: this.stateRoot, projectId: this.projectId, specId: approved.id });
			if (inventory.target) assertGradersRunnable(input.tasks, inventory.target.manifest);
			const result = this.dependencies.createCorpusDraft({
				stateRoot: this.stateRoot,
				approvedSpec: exact.reference,
				name: input.name,
				tasks: input.tasks,
				coverageNotes: input.coverageNotes,
				revisionSummary: input.revisionSummary,
			}, { now: this.dependencies.now });
			const settled = this.select("corpus-draft", result.draft.id);
			return { kind: input.kind, message: "Corpus draft saved. Revise freely or publish it through the human gate.", artifact: { id: result.draft.id, draftHash: hashValue(result.draft), taskCount: result.draft.tasks.length, approvedSpecId: result.draft.approvedSpec.specId }, view: await this.viewOf(settled) };
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
			const settled = this.select("corpus-draft", result.draft.id);
			if (inventory.target) {
				try {
					assertGradersRunnable(result.draft.tasks, inventory.target.manifest, "imported corpus draft");
				} catch (error) {
					throw new Error(
						`${error instanceof Error ? error.message : String(error)}\nThe import was saved as draft ${result.draft.id}; revise those graders with kind: corpus-revision before publishing.`,
					);
				}
			}
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
				view: await this.viewOf(settled),
			};
		}
		if (input.kind === "dataset-recipe") {
			const inventory = this.inventory();
			const approved = requireApprovedSpec(inventory, input.approvedSpecId);
			const exact = loadApprovedSpec({ stateRoot: this.stateRoot, projectId: this.projectId, specId: approved.id });
			const holdout = this.datasetHoldout(input.sourcePath);
			// The compile is the validation: it resolves every column and every
			// {{placeholder}} before a single row is mapped.
			const compiled = this.dependencies.compileDatasetCases({
				projectDir: this.projectDir,
				sourcePath: input.sourcePath,
				recipe: input.recipe,
				holdout,
			});
			if (compiled.tasks.length === 0) {
				throw new Error(
					`the recipe compiled no cases from ${input.sourcePath}; ` +
					`${compiled.skipped.length > 0 ? `the first skipped row says: ${compiled.skipped[0]?.reason}` : "loosen the filters or map a different column"}`,
				);
			}
			if (compiled.tasks.length > MAX_BUILDER_CORPUS_DRAFT_TASKS) {
				throw new Error(
					`the recipe compiled ${compiled.tasks.length} cases; a reviewable basket holds at most ` +
					`${MAX_BUILDER_CORPUS_DRAFT_TASKS}. Add sample: { limit, seed } to the recipe to thin the development side.`,
				);
			}
			if (inventory.target) assertGradersRunnable(compiled.tasks, inventory.target.manifest, "dataset recipe");
			const saved = this.dependencies.saveDatasetRecipe({
				stateRoot: this.stateRoot,
				approvedSpec: exact.reference,
				sourcePath: input.sourcePath,
				sourceSha256: compiled.sourceSha256,
				recipeSha256: compiled.recipeSha256,
				recipe: input.recipe,
				name: input.name,
				revisionSummary: input.revisionSummary,
				now: this.dependencies.now,
			});
			const artifact: WorkbenchDatasetRecipeArtifact = {
				submissionId: saved.submission.id,
				sourcePath: input.sourcePath,
				name: saved.submission.name,
				developmentCount: compiled.tasks.length,
				skippedRows: compiled.skipped.length,
				sealedReserved: holdout?.count ?? 0,
				sampleCases: compiled.tasks.slice(0, MAX_DATASET_SAMPLE_CASES).map(datasetCasePreview),
			};
			return {
				kind: input.kind,
				message: `The recipe reads ${input.sourcePath} into ${compiled.tasks.length} case${compiled.tasks.length === 1 ? "" : "s"}. ` +
					"Show the samples, then ask for the import decision.",
				artifact,
				view: await this.viewOf(inventory),
			};
		}
		if (input.kind === "corpus-revision") {
			const inventory = this.inventory();
			const approved = requireApprovedSpec(inventory, input.approvedSpecId);
			const exact = loadApprovedSpec({ stateRoot: this.stateRoot, projectId: this.projectId, specId: approved.id });
			const parent = requireCorpusDraft(inventory, input.parentDraftId, approved.id);
			if (inventory.target) {
				// Validate every grader carried by the revision before an immutable draft is written.
				const carried = input.operations.flatMap((operation) => {
					if ("task" in operation && operation.task) return [{ graders: operation.task.graders }];
					if ("graders" in operation && Array.isArray(operation.graders)) return [{ graders: operation.graders }];
					if ("grader" in operation && operation.grader) return [{ graders: [operation.grader] }];
					return [];
				});
				assertGradersRunnable(carried, inventory.target.manifest, "corpus revision");
			}
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
			const settled = this.select("corpus-draft", result.draft.id);
			return { kind: input.kind, message: "New immutable corpus-draft revision saved.", artifact: { id: result.draft.id, parentDraftId: parent.id, draftHash: hashValue(result.draft), taskCount: result.draft.tasks.length }, view: await this.viewOf(settled) };
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
			const settled = this.select("proposal", result.record.runId);
			return { kind: input.kind, message: "Selected failure modes compiled into an evidence-linked, exact reviewable proposal.", artifact: { runId: result.record.runId, proposalHash: result.record.artifacts.proposal?.sha256 ?? null, sourceEvalRunId: result.record.request.source?.evalRunId ?? null, improvementBriefId: selectedEvidence.basis.briefId, failureModeIds: selectedEvidence.basis.failureModes.map((mode) => mode.failureModeId), approvedSpecId: approved.id, authoringContextHash: authoringContext.contextHash }, view: await this.viewOf(settled) };
		}
		return {
			kind: input.kind,
			message: "Structured authoring produced a durable no-change result; there is no diff to review or apply.",
			artifact: { runId: result.record.runId, proposalHash: null, decision: "no-change", sourceEvalRunId, improvementBriefId: selectedEvidence.basis.briefId, failureModeIds: selectedEvidence.basis.failureModes.map((mode) => mode.failureModeId), approvedSpecId: approved.id, authoringContextHash: authoringContext.contextHash },
			view: await this.view(),
		};
	}

	/** A literal decision kind yields its exact typed result; the union stays available for generic callers. */
	decide<K extends WorkbenchDecisionInput["kind"]>(
		inputValue: Extract<WorkbenchDecisionInput, { kind: K }>,
		gate: WorkbenchHumanGate,
		options?: WorkbenchDecisionExecutionOptions,
	): Promise<Extract<WorkbenchDecisionResult, { kind: K }>>;
	decide(
		inputValue: WorkbenchDecisionInput,
		gate: WorkbenchHumanGate,
		options?: WorkbenchDecisionExecutionOptions,
	): Promise<WorkbenchDecisionResult>;
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
			if (resolved.kind === "run-eval") {
				return {
					kind: "run-current",
					message: resolved.message,
					result: { resolvedAs: "run-eval", ...resolved.result },
					view: resolved.view,
				};
			}
			if (resolved.kind === "verify-candidate") {
				return {
					kind: "run-current",
					message: resolved.message,
					result: { resolvedAs: "verify-candidate", ...resolved.result },
					view: resolved.view,
				};
			}
			throw new Error(`run-current resolved to an unexpected decision ${String((resolved as { kind?: unknown }).kind)}`);
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
			if (!options.resolveTargetModel) {
				throw new Error("Target model selection requires the trusted host model catalog");
			}
			const describe = () => this.dependencies.describeTargetBootstrap({
				targetDir: this.projectDir,
				stateRoot: this.stateRoot,
				runsRoot: this.runsRoot,
				targetId: input.targetId,
				model: options.resolveTargetModel!(input.model),
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
				model: after.next.model,
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
			const settled = this.select("approved-spec", result.approved.id);
			return { kind: input.kind, message: "Spec approved as an exact immutable snapshot.", result: { approvedSpecId: result.approved.id, receiptId: result.receipt.id }, view: await this.viewOf(settled) };
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
			const settled = candidate.origin.kind === "applied-builder"
				? this.select("proposal", candidate.origin.builderRunId)
				: this.inventory();
			return {
				kind: input.kind,
				message: "Interrupted candidate attempt abandoned durably; the exact applied proposal can be retried.",
				result: { candidateId: candidate.candidateId, interruptedStatus: status, receiptHash: receipt.receiptHash },
				view: await this.viewOf(settled),
			};
		}

		if (input.kind === "publish-corpus") {
			const approved = requireApprovedSpec(inventory);
			const draft = requireCorpusDraft(inventory, input.draftId, approved.id, true);
			if (inventory.target) assertGradersRunnable(draft.tasks, inventory.target.manifest, `corpus draft ${draft.id}`);
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
			const settled = this.select("development-corpus", result.corpus.id);
			return { kind: input.kind, message: "Development corpus published with exact Spec and draft lineage.", result: { corpusId: result.corpus.id, corpusHash: result.corpus.hash, taskCount: result.corpus.taskCount, publicationReceiptId: result.receipt.id, lineageHash: lineage.linkHash }, view: await this.viewOf(settled) };
		}

		if (input.kind === "import-dataset") {
			const approved = requireApprovedSpec(inventory);
			const submission = this.requireDatasetRecipe(approved.id, input.submissionId);
			const inForce = this.datasetHoldout(submission.sourcePath);
			const requested: DatasetHoldoutSpec | null = input.sealed
				? {
					count: input.sealed.count,
					seed: input.sealed.seed,
					...(input.sealed.stratifyBy !== undefined ? { stratifyBy: input.sealed.stratifyBy } : {}),
				}
				: null;
			// A second draw over a file that already has one would put previously
			// sealed rows into a development corpus, so the exam is drawn once.
			if (inForce && !exactSame(inForce, requested)) {
				throw new Error(
					`${submission.sourcePath} already holds out ${inForce.count} row${inForce.count === 1 ? "" : "s"} ` +
					`with seed ${JSON.stringify(inForce.seed)}; import it again with that exact sealed slice, or use another file.`,
				);
			}
			const holdout = requested;
			const build = (): { subject: Record<string, unknown>; developmentCount: number } => {
				const compiled = this.dependencies.compileDatasetCases({
					projectDir: this.projectDir,
					sourcePath: submission.sourcePath,
					recipe: submission.recipe,
					holdout,
				});
				if (compiled.sourceSha256 !== submission.sourceSha256) {
					throw new Error(`${submission.sourcePath} changed since the recipe was validated; submit the recipe again`);
				}
				if (compiled.tasks.length === 0) throw new Error("the recipe compiles no development cases");
				if (compiled.tasks.length > MAX_BUILDER_CORPUS_DRAFT_TASKS) {
					throw new Error(
						`the recipe compiles ${compiled.tasks.length} cases; a reviewable basket holds at most ` +
						`${MAX_BUILDER_CORPUS_DRAFT_TASKS}. Add sample: { limit, seed } to the recipe first.`,
					);
				}
				return {
					subject: {
						operation: "import-dataset",
						submissionId: submission.id,
						approvedSpec: submission.approvedSpec,
						sourcePath: submission.sourcePath,
						name: submission.name,
						recipe: submission.recipe,
						developmentCount: compiled.tasks.length,
						skippedRows: compiled.skipped.length,
						sealed: holdout,
						sampleCases: compiled.tasks.slice(0, MAX_DATASET_SAMPLE_CASES).map(datasetCasePreview),
					},
					developmentCount: compiled.tasks.length,
				};
			};
			const before = build();
			const actor = await this.confirm(input, gate, "Import an exact dataset as eval cases", before.subject, options.signal);
			const current = this.decisionInventory(input.kind);
			requireApprovedSpec(current, approved.id);
			const after = build();
			if (!exactSame(before.subject, after.subject)) throw new WorkbenchStaleDecisionError(input.kind);
			// Fixed order: the sealed slice is compiled and published before any
			// development case exists, so no reserved row can leak into the draft.
			const ingested = this.dependencies.ingestDataset({
				projectDir: this.projectDir,
				stateRoot: this.stateRoot,
				projectId: this.projectId,
				sourcePath: submission.sourcePath,
				recipe: submission.recipe,
				holdout,
				developmentName: submission.name,
				now: this.dependencies.now,
			});
			const exact = loadApprovedSpec({ stateRoot: this.stateRoot, projectId: this.projectId, specId: approved.id });
			const result = this.dependencies.createCorpusDraft({
				stateRoot: this.stateRoot,
				approvedSpec: exact.reference,
				name: submission.name,
				tasks: ingested.tasks.map(({ id: _derivedId, ...task }) => task),
				coverageNotes: [],
				revisionSummary: submission.revisionSummary,
			}, { now: this.dependencies.now });
			const settled = this.select("corpus-draft", result.draft.id);
			const sealedCount = ingested.sealedCorpus?.taskCount ?? 0;
			return {
				kind: input.kind,
				message: `Imported ${ingested.tasks.length} case${ingested.tasks.length === 1 ? "" : "s"} into an editable draft` +
					`${sealedCount > 0 ? `; ${sealedCount} sealed case${sealedCount === 1 ? "" : "s"} held out` : ""}. ` +
					"Review it, then publish.",
				result: {
					draftId: result.draft.id,
					taskCount: result.draft.tasks.length,
					approvedSpecId: result.draft.approvedSpec.specId,
					sourcePath: ingested.receipt.sourcePath,
					sealedCount,
					skippedRows: ingested.skipped.length,
					receiptId: ingested.receiptPath.split(/[\\/]/).at(-1)?.replace(/\.json$/, "") ?? "",
				},
				view: await this.viewOf(settled),
			};
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
			const settled = this.select("eval-run", record.evalRunId);
			return { kind: input.kind, message: improvementBrief.headline, result: { evaluation: { evalRunId: record.evalRunId, summary: record.summary, repetitions: record.repetitions }, diagnosis: diagnosisSummary(diagnosis), improvementBrief: conversationalImprovementBrief(improvementBrief), evidence: link ? { available: true, ...link } : { available: false } }, view: await this.viewOf(settled) };
		}

		if (input.kind === "calibrate") {
			if (!inventory.target) throw new Error("Target is not ready");
			const approved = requireApprovedSpec(inventory);
			const corpus = requireDevelopmentCorpus(inventory, undefined, approved.id);
			const build = (): {
				subject: Record<string, unknown>;
				targetGitSha: string;
				approvedSpecId: string;
				developmentCorpus: CorpusRef;
			} => {
				const current = this.decisionInventory(input.kind);
				const currentApproved = requireApprovedSpec(current, approved.id);
				const currentCorpus = requireDevelopmentCorpus(current, corpus.id, currentApproved.id);
				const target = loadTarget(this.projectDir);
				const receipt = loadDevelopmentCorpusPublicationReceipt(this.stateRoot, this.projectId, currentCorpus.id);
				const lineage = current.developmentLineage.get(currentCorpus.id);
				const loaded = loadCorpus({ stateRoot: this.stateRoot, projectId: this.projectId, corpusId: currentCorpus.id });
				if (
					!lineage ||
					lineage.publication.approvedSpecId !== currentApproved.id ||
					loaded.metadata.visibility !== "development" ||
					loaded.metadata.hash !== receipt.corpus.hash
				) throw new Error("development corpus does not match its reviewed Spec lineage");
				return {
					subject: {
						operation: "calibrate-noise",
						target: { id: target.manifest.id, gitSha: target.gitSha },
						developmentCorpus: {
							id: loaded.metadata.id,
							hash: loaded.metadata.hash,
							taskCount: loaded.metadata.taskCount,
						},
						repetitions: input.repetitions,
						executions: 2 * loaded.metadata.taskCount * input.repetitions,
					},
					targetGitSha: target.gitSha,
					approvedSpecId: currentApproved.id,
					developmentCorpus: { stateRoot: this.stateRoot, projectId: this.projectId, corpusId: currentCorpus.id },
				};
			};
			const before = build();
			const actor = await this.confirm(input, gate, "Calibrate run-to-run noise", before.subject, options.signal);
			const after = build();
			if (!exactSame(before.subject, after.subject)) throw new WorkbenchStaleDecisionError(input.kind);
			// Both arms are the same exact revision: the experiment measures the
			// harness against itself and can never become promotion evidence.
			const result = await this.dependencies.runCalibration({
				repositoryDir: this.projectDir,
				runsRoot: this.runsRoot,
				baselineRef: after.targetGitSha,
				candidateRef: after.targetGitSha,
				mode: "aa-calibration",
				repetitions: input.repetitions,
				projectId: this.projectId,
				specId: after.approvedSpecId,
				origin: { kind: "manual", reason: "A/A calibration" },
				developmentCorpus: after.developmentCorpus,
				actorId: actor,
				...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			});
			abortIfRequested(options.signal);
			const calibration = calibrationProjection(result.record);
			if (!calibration) throw new Error("calibration produced no development verdict; nothing was measured");
			return {
				kind: input.kind,
				message: `Noise measured on this revision: A/A ${calibration.verdict}; ` +
					`${calibration.recommendedRepetitions} repetition${calibration.recommendedRepetitions === 1 ? "" : "s"} recommended.`,
				result: { candidateId: result.record.candidateId, calibration },
				view: await this.view(),
			};
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
			const settled = this.select("proposal", proposal.record.runId);
			return { kind: input.kind, message: "Proposal applied to an exact candidate branch; verification is now required.", result: { runId: result.receipt.runId, branch: result.receipt.branch, candidateSha: result.receipt.candidateSha, proposalHash: result.receipt.proposalSha256 }, view: await this.viewOf(settled) };
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
			if (selected.taskCount < SEALED_GATE_POLICY.minTasks) {
				throw new Error(
					`The selected sealed holdout has ${selected.taskCount} task${selected.taskCount === 1 ? "" : "s"}; ` +
					`a sealed verdict needs at least ${SEALED_GATE_POLICY.minTasks}. Add holdout cases before verifying.`,
				);
			}
			if (input.repetitions < SEALED_GATE_POLICY.minRepetitions) {
				throw new Error(`Candidate verification needs at least ${SEALED_GATE_POLICY.minRepetitions} repetitions for a sealed verdict.`);
			}
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
			const settled = this.select("candidate", result.record.candidateId);
			const sealedVerdict = result.sealedHoldout?.compare.gate.verdict ?? null;
			return {
				kind: input.kind,
				message: sealedVerdict === "pass"
					? "Candidate verification completed: development compared and the sealed guardrail passed."
					: sealedVerdict === null
						? "Candidate verification completed on development evidence; no sealed holdout ran."
						: `Candidate verification completed; the sealed guardrail verdict is ${sealedVerdict}, so this candidate cannot be promoted.`,
				result: {
					candidate: candidateSummary(result.record),
					development: { verdict: result.compare.gate.verdict, delta: result.compare.summary.delta, confidence95: result.compare.summary.confidence95 },
					sealedHoldout: { executed: result.sealedHoldout !== null, gatePassed: sealedVerdict === "pass", verdict: sealedVerdict },
				},
				view: await this.viewOf(settled),
			};
		}

		if (input.kind === "review-candidate") {
			const candidate = requireCandidate(inventory, ["evaluated"], input.candidateId);
			const before = { operation: "review-candidate", candidateHash: hashValue(candidate), candidate: this.candidateView(candidate), recommendation: input.recommendation };
			const actor = await this.confirm(input, gate, "Record exact candidate review", before, options.signal);
			const current = this.decisionInventory(input.kind);
			const after = requireCandidate(current, ["evaluated"], candidate.candidateId);
			if (hashValue(after) !== hashValue(candidate)) throw new WorkbenchStaleDecisionError(input.kind);
			const reviewed = this.dependencies.reviewCandidate({ runsRoot: this.runsRoot, candidateId: candidate.candidateId, expectedCandidateHash: before.candidateHash, recommendation: input.recommendation, reason: input.reason, actorId: actor, now: this.dependencies.now });
			const settled = this.select("candidate", reviewed.candidateId);
			return { kind: input.kind, message: "Human candidate review recorded.", result: candidateSummary(reviewed), view: await this.viewOf(settled) };
		}

		if (input.kind === "promote-candidate") {
			const candidate = requireCandidate(inventory, ["reviewed"], input.candidateId);
			const before = { operation: "promote-candidate", candidateHash: hashValue(candidate), candidate: this.candidateView(candidate), version: input.version, tag: `v${input.version}` };
			const actor = await this.confirm(input, gate, "Promote exact candidate", before, options.signal);
			const current = this.decisionInventory(input.kind);
			if (hashValue(requireCandidate(current, ["reviewed"], candidate.candidateId)) !== hashValue(candidate)) throw new WorkbenchStaleDecisionError(input.kind);
			const promoted = this.dependencies.promoteCandidate({ repositoryDir: this.projectDir, runsRoot: this.runsRoot, stateRoot: this.stateRoot, candidateId: candidate.candidateId, expectedCandidateHash: before.candidateHash, version: input.version, reason: input.reason, actorId: actor, now: this.dependencies.now });
			const settled = this.select("candidate", promoted.record.candidateId);
			return { kind: input.kind, message: `Candidate promoted as ${promoted.tag}. Adopt it to make it the active Target.`, result: { candidate: candidateSummary(promoted.record), tag: promoted.tag, candidateSha: promoted.candidateSha }, view: await this.viewOf(settled) };
		}

		if (input.kind === "reject-candidate") {
			const candidate = requireCandidate(inventory, ["reviewed"], input.candidateId);
			const before = { operation: "reject-candidate", candidateHash: hashValue(candidate), candidate: candidateSummary(candidate) };
			const actor = await this.confirm(input, gate, "Reject exact candidate", before, options.signal);
			const current = this.decisionInventory(input.kind);
			if (hashValue(requireCandidate(current, ["reviewed"], candidate.candidateId)) !== hashValue(candidate)) throw new WorkbenchStaleDecisionError(input.kind);
			const rejected = this.dependencies.rejectCandidate({ runsRoot: this.runsRoot, candidateId: candidate.candidateId, expectedCandidateHash: before.candidateHash, reason: input.reason, actorId: actor, now: this.dependencies.now });
			const settled = this.select("candidate", rejected.candidateId);
			return { kind: input.kind, message: "Candidate rejected durably. The Target stays at its baseline.", result: candidateSummary(rejected), view: await this.viewOf(settled) };
		}

		if (input.kind === "adopt-candidate") {
			const candidate = requireOpenTerminalCandidate(inventory, input.candidateId);
			if (candidateStatus(candidate) !== "promoted") throw new Error("only a promoted candidate can be adopted");
			if (inventory.adoptedCandidates.has(candidate.candidateId)) throw new WorkbenchStaleDecisionError(input.kind);
			const describe = () => this.dependencies.describeTargetAdoption({
				repositoryDir: this.projectDir,
				runsRoot: this.runsRoot,
				candidateId: candidate.candidateId,
			});
			const before = describe();
			const actor = await this.confirm(
				input,
				gate,
				"Adopt promoted candidate as the active Target",
				{ operation: "adopt-candidate", candidateHash: hashValue(candidate), candidate: candidateSummary(candidate), adoption: before },
				options.signal,
			);
			const current = this.decisionInventory(input.kind);
			if (current.adoptedCandidates.has(candidate.candidateId)) throw new WorkbenchStaleDecisionError(input.kind);
			if (hashValue(requireOpenTerminalCandidate(current, candidate.candidateId)) !== hashValue(candidate)) throw new WorkbenchStaleDecisionError(input.kind);
			const after = describe();
			if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
			const result = this.dependencies.adoptTargetCandidate({
				repositoryDir: this.projectDir,
				runsRoot: this.runsRoot,
				stateRoot: this.stateRoot,
				candidateId: candidate.candidateId,
				expectedSubjectHash: after.subjectHash,
				actor: { kind: "human", id: actor },
				reason: input.reason,
			}, { now: this.dependencies.now });
			const settled = this.select("candidate", candidate.candidateId);
			return {
				kind: input.kind,
				message: `Branch ${result.subject.branch.name} now points at the promoted candidate ${result.subject.promotion.tag}. Start the next cycle when ready.`,
				result: {
					candidate: candidateSummary(candidate),
					disposition: result.disposition,
					branch: result.subject.branch.name,
					fromSha: result.receipt.previousHead,
					toSha: result.receipt.adoptedHead,
					tag: result.subject.promotion.tag,
					receiptId: result.receipt.receiptId,
				},
				view: await this.viewOf(settled),
			};
		}

		if (input.kind === "continue-cycle") {
			const candidate = requireOpenTerminalCandidate(inventory, input.candidateId);
			if (inventory.continuedCandidates.has(candidate.candidateId)) throw new WorkbenchStaleDecisionError(input.kind);
			if (!inventory.target) throw new Error("continuing the improvement cycle requires one exact Target");
			const continuationOptions = {
				repositoryDir: this.projectDir,
				runsRoot: this.runsRoot,
				stateRoot: this.stateRoot,
				projectId: this.projectId,
				targetId: inventory.target.manifest.id,
				candidateId: candidate.candidateId,
			};
			const before = this.dependencies.describeCycleContinuation(continuationOptions);
			const actor = await this.confirm(
				input,
				gate,
				"Close this improvement cycle and continue",
				{ operation: "continue-cycle", candidateHash: hashValue(candidate), candidate: candidateSummary(candidate), continuation: before },
				options.signal,
			);
			const current = this.decisionInventory(input.kind);
			if (current.continuedCandidates.has(candidate.candidateId)) throw new WorkbenchStaleDecisionError(input.kind);
			if (hashValue(requireOpenTerminalCandidate(current, candidate.candidateId)) !== hashValue(candidate)) throw new WorkbenchStaleDecisionError(input.kind);
			const after = this.dependencies.describeCycleContinuation(continuationOptions);
			if (!exactSame(before, after)) throw new WorkbenchStaleDecisionError(input.kind);
			const result = this.dependencies.recordCycleContinuation({
				...continuationOptions,
				expectedSubjectHash: after.subjectHash,
				actor: { kind: "human", id: actor },
				reason: input.reason,
			}, { now: this.dependencies.now });
			// Release the closed candidate from focus so the next stage derives from artifacts alone.
			saveWorkbenchFocus(
				this.stateRoot,
				clearWorkbenchFocus(
					loadWorkbenchFocus(this.stateRoot, this.projectId, this.dependencies.now),
					"candidate",
					this.dependencies.now,
				),
			);
			const view = await this.view();
			return {
				kind: input.kind,
				message: `Improvement cycle closed. The Workbench continues at ${view.stage}: ${view.headline}`,
				result: {
					candidate: candidateSummary(candidate),
					disposition: result.disposition,
					activeTargetSha: result.subject.activeTargetSha,
					receiptId: result.receipt.receiptId,
					nextStage: view.stage,
				},
				view,
			};
		}

		const exhaustive: never = input;
		throw new Error(`unsupported Workbench decision ${JSON.stringify(exhaustive)}`);
	}
}

export function createAhdeWorkbench(options: AhdeWorkbenchOptions): AhdeWorkbench {
	return new AhdeWorkbench(options);
}

export function localWorkbenchActorId(): string {
	return `local:${userInfo().username || basename(resolve(process.cwd()))}`;
}
