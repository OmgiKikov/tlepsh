import { execFileSync } from "node:child_process";
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
import {
	openBuilderWorkshop,
	type BuilderWorkshop,
	type TryToolResult,
	type WorkshopBashResult,
	type WorkshopReadResult,
	type WorkshopStatus,
	type WorkshopWriteResult,
} from "../application/tool-workshop.js";
import { runAppliedBuilderCandidate } from "../application/builder-candidate.js";
import { formatPoints, SEALED_GATE_POLICY } from "../domain/comparison-gate.js";
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
	runCheapCheck,
	type CheapCheckResult,
} from "../application/cheap-check.js";
import { buildPromotionRegressionGuards } from "../application/regression-guards.js";
import {
	IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS,
	improvementLoopGate,
	plannedImprovementExecutions,
	recordedBuilderProposalAuthor,
	renderImprovementLoopTable,
	runImprovementLoop,
	type ImprovementProposalAuthor,
} from "../application/improvement-loop.js";
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
	DEFAULT_EVAL_JOBS,
	defaultEvalJobs,
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
import {
	loadWorkbenchCorpusPublication,
	recordWorkbenchCorpusPublication,
} from "./corpus-publication.js";
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
import {
	assertWorkbenchDecisionStage,
	estimateRunCost,
	routineCostGuard,
	workbenchGateClass,
	type WorkbenchRunEstimate,
} from "./transition-policy.js";
import {
	WorkbenchDecisionInputSchema,
	WorkbenchSubmitInputSchema,
	WorkbenchViewQuerySchema,
	WorkshopBashInputSchema,
	WorkshopReadInputSchema,
	WorkshopTryInputSchema,
	WorkshopWriteInputSchema,
	type WorkshopBashInput,
	type WorkshopReadInput,
	type WorkshopTryInput,
	type WorkshopWriteInput,
	type WorkbenchCandidateImpactProjection,
	type WorkbenchCandidateSummary,
	type WorkbenchCompositeStep,
	type WorkbenchConfirmation,
	type WorkbenchDatasetCase,
	type WorkbenchDecisionInput,
	type WorkbenchDecisionExecutionOptions,
	type WorkbenchDecisionResult,
	type WorkbenchHumanGate,
	type WorkbenchImprovementBriefProjection,
	type WorkbenchDatasetRecipeArtifact,
	type WorkbenchReviewDetail,
	type WorkbenchRunEvalResult,
	type WorkbenchSelectionKind,
	type WorkbenchStage,
	type WorkbenchSubmitInput,
	type WorkbenchTargetDetail,
	type WorkbenchTurn,
	type WorkbenchView,
	type WorkbenchViewQuery,
	type WorkbenchCheapCheckProjection,
	type WorkbenchRegressionGuardsProjection,
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

/** The exact options the one canonical proposal-recording service accepts. */
type RecordProposalOptions = Parameters<typeof recordBuilderAuthoredProposal>[0];

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
	/** The cheap screen that runs before a verification is paid for. */
	runCheapCheck: typeof runCheapCheck;
	/** Derived after the promotion receipt; a failure is a warning, never a block. */
	buildPromotionGuards: typeof buildPromotionRegressionGuards;
	runImprovementLoop: typeof runImprovementLoop;
	/**
	 * Where one autoloop cycle's proposal comes from. Undefined means the next
	 * open Builder proposal already recorded against this cycle's evidence.
	 */
	authorImprovementProposal?: ImprovementProposalAuthor;
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
	runCheapCheck,
	buildPromotionGuards: buildPromotionRegressionGuards,
	runImprovementLoop,
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

function shortSha(sha: string): string {
	return sha ? sha.slice(0, 10) : "—";
}

/** Money the human recognises, or an honest “unknown”. */
function formatEstimatedCost(estimate: WorkbenchRunEstimate | undefined): string {
	if (!estimate || estimate.costUsd === null) return "unknown — nothing comparable has run yet";
	if (estimate.costUsd < 0.01) return "under $0.01";
	return `about $${estimate.costUsd.toFixed(2)} (from ${estimate.sampledRuns} earlier run${estimate.sampledRuns === 1 ? "" : "s"})`;
}

function formatEstimatedTime(estimate: WorkbenchRunEstimate | undefined): string {
	if (!estimate || estimate.minutes === null) return "unknown — nothing comparable has run yet";
	if (estimate.minutes < 1) return "under a minute";
	return `about ${Math.ceil(estimate.minutes)} minute${Math.ceil(estimate.minutes) === 1 ? "" : "s"}`;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function capitalize(text: string): string {
	return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/** The branch a fast-forward would move, read only to show it before deciding. */
function currentBranchName(repositoryDir: string): string | null {
	try {
		const name = execFileSync("git", ["-C", repositoryDir, "symbolic-ref", "-q", "--short", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return name || null;
	} catch {
		return null;
	}
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
		case "turn_budget":
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
	/** At most one open workshop per Builder conversation; it dies with its proposal. */
	private workshop: BuilderWorkshop | null = null;

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

	/**
	 * The one place a human is asked. The Workbench decides how much of their
	 * attention the decision is worth and the host renders that: a full dialog,
	 * one question, or nothing at all. A routine decision still passes through
	 * here, so it still has exactly one human actor identity and can still be
	 * declined; it simply does not interrupt.
	 */
	private async confirm(
		input: WorkbenchDecisionInput,
		gate: WorkbenchHumanGate,
		title: string,
		subject: unknown,
		signal?: AbortSignal,
		presentation: { question?: string; estimate?: WorkbenchRunEstimate } = {},
	): Promise<string> {
		abortIfRequested(signal);
		const exact = boundedSubject(subject, input.kind);
		let policy = workbenchGateClass(input.kind);
		let question = presentation.question ?? `${title}?`;
		// The guard is the only thing that can turn a routine decision back into a
		// question: an unusually expensive or entirely unknown run.
		if (policy === "routine" && presentation.estimate) {
			const guard = routineCostGuard(presentation.estimate);
			if (guard) {
				policy = "one-question";
				question = `${question} ${capitalize(guard)}. Continue?`;
			}
		}
		const confirmation: WorkbenchConfirmation = {
			kind: input.kind,
			title,
			reason: input.reason,
			subject: exact,
			subjectHash: hashValue(exact),
			policy,
			question,
			...(presentation.estimate ? { estimate: presentation.estimate } : {}),
		};
		const decision = await gate.confirm(confirmation, signal);
		abortIfRequested(signal);
		if (!decision.approved) throw new WorkbenchDecisionDeclinedError(input.kind);
		return actorId(decision.actorId);
	}

	/** The screen, as the operator reads it. It is never gate evidence. */
	private screenProjection(screen: CheapCheckResult): WorkbenchCheapCheckProjection {
		return {
			verdict: screen.verdict,
			tasks: screen.tasks.length,
			improved: screen.improved,
			unchanged: screen.unchanged,
			regressed: screen.regressed,
			inconclusive: screen.inconclusive,
			withinErrorBudget: screen.withinErrorBudget,
			screenEvalRunId: screen.screenEvalRunId,
			sourceEvalRunId: screen.sourceEvalRunId,
		};
	}

	/**
	 * Pin the cases a promotion flipped. This runs *after* the promotion receipt
	 * is durable, so it can neither block nor delay it: everything it can go
	 * wrong with degrades to a warning the operator reads next to the tag.
	 * Nothing here publishes — the draft waits for an explicit publication.
	 */
	private promotionGuards(record: CandidateRecord, tag: string): WorkbenchRegressionGuardsProjection {
		const empty = { draftId: null, cases: 0, taskIds: [] as string[] };
		try {
			const evaluated = record.events.find((event) => event.type === "evaluated");
			if (evaluated?.type !== "evaluated") throw new Error("candidate has no evaluated development arms");
			const corpusIdentity = evaluated.evaluation.development.corpus;
			if (!corpusIdentity) {
				return { ...empty, warning: "the promotion was measured without a published development corpus, so there is no basket to pin guards into" };
			}
			const current = this.inventory();
			if (!current.target) throw new Error("no resolved Target");
			const specId = record.specId ??
				(record.origin.kind === "applied-builder" ? record.origin.approvedSpec.specId : null);
			if (!specId) throw new Error("the promoted candidate is not bound to an approved Spec");
			const approved = loadApprovedSpec({
				stateRoot: this.stateRoot,
				projectId: this.projectId,
				specId,
			});
			const lineage = loadWorkbenchCorpusPublication(this.stateRoot, this.projectId, corpusIdentity.id);
			const corpus = loadCorpus({ stateRoot: this.stateRoot, projectId: this.projectId, corpusId: corpusIdentity.id });
			if (corpus.metadata.hash !== corpusIdentity.hash) {
				throw new Error("the published development corpus changed since the promotion evidence was recorded");
			}
			const built = this.dependencies.buildPromotionGuards({
				runsRoot: this.runsRoot,
				stateRoot: this.stateRoot,
				candidate: record,
				approvedSpec: approved.reference,
				target: current.target,
				developmentCorpus: corpus,
				parentDraftId: lineage.draftId,
				compatibleEvalRuns: compatibleDevelopmentEvals(current, approved.reference.specId, corpusIdentity.id),
				promotionTag: tag,
				now: this.dependencies.now,
			});
			if (!built) return { ...empty, warning: null };
			return { draftId: built.draftId, cases: built.cases, taskIds: built.taskIds, warning: null };
		} catch (error) {
			return {
				...empty,
				warning: `regression guards were not built: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	/** What one run of this many executions is expected to cost on this Target. */
	private runEstimate(executions: number, target: WorkbenchInventory["target"]): WorkbenchRunEstimate {
		return estimateRunCost({
			runsRoot: this.runsRoot,
			targetId: target?.manifest.id ?? "",
			executions,
			jobs: target ? defaultEvalJobs(target.manifest.model) : DEFAULT_EVAL_JOBS,
		});
	}

	/**
	 * The gate a composite hands to its own steps. Each planned step is
	 * pre-approved exactly once, and only when its exact subject is the one the
	 * human already read in the composite dialog; anything else falls through to
	 * the real human gate rather than being escalated silently.
	 */
	private compositeGate(
		gate: WorkbenchHumanGate,
		actor: string,
		planned: ReadonlyMap<WorkbenchDecisionInput["kind"], (subject: unknown) => boolean>,
	): WorkbenchHumanGate {
		const used = new Set<WorkbenchDecisionInput["kind"]>();
		return {
			async confirm(confirmation, signal) {
				const matches = planned.get(confirmation.kind);
				if (matches && !used.has(confirmation.kind) && matches(confirmation.subject)) {
					used.add(confirmation.kind);
					return { approved: true, actorId: actor };
				}
				return gate.confirm(confirmation, signal);
			},
			selectSealed: (request, signal) => gate.selectSealed(request, signal),
		};
	}

	/**
	 * “Start testing”: the pending reviews plus the run, behind one dialog.
	 *
	 * It is orchestration, not authority. Every step is the same fine-grained
	 * decision the CLI calls, through the same application service, in the same
	 * order, writing the same receipts. A step that declines or fails ends the
	 * composite there and leaves durable state exactly where that step left it.
	 */
	private async startTesting(
		input: Extract<WorkbenchDecisionInput, { kind: "start-testing" }>,
		gate: WorkbenchHumanGate,
		options: WorkbenchDecisionExecutionOptions,
		inventory: WorkbenchInventory,
		stage: WorkbenchStage,
	): Promise<Extract<WorkbenchDecisionResult, { kind: "start-testing" }>> {
		const plan: WorkbenchCompositeStep["kind"][] = [];
		const planned = new Map<WorkbenchDecisionInput["kind"], (subject: unknown) => boolean>();
		const specDraft = stage === "spec-review" ? requireSpecDraft(inventory) : null;
		const approved = specDraft ? null : requireApprovedSpec(inventory);
		// A corpus draft is bound to an already-approved Spec, so the basket only
		// exists once the approval does. Approving is therefore its own start.
		const corpusDraft = approved ? requireCorpusDraft(inventory, undefined, approved.id, true) : null;
		if (specDraft) {
			plan.push("approve-spec");
			planned.set("approve-spec", (subject) => (subject as { draftSpecId?: unknown }).draftSpecId === specDraft.id);
		}
		if (corpusDraft) {
			plan.push("publish-corpus", "run-eval");
			planned.set("publish-corpus", (subject) => (subject as { draftId?: unknown }).draftId === corpusDraft.id);
			planned.set("run-eval", (subject) => {
				const bag = subject as { operation?: unknown; repetitions?: unknown };
				return bag.operation === "run-development-evaluation" && bag.repetitions === input.repetitions;
			});
		}
		const caseCount = corpusDraft?.tasks.length ?? 0;
		const executions = caseCount * input.repetitions;
		const estimate = corpusDraft ? this.runEstimate(executions, inventory.target) : undefined;
		const parts: string[] = [];
		if (specDraft) parts.push("approve the Spec");
		if (corpusDraft) parts.push("publish the eval basket", `run ${executions} Target execution${executions === 1 ? "" : "s"}`);
		const title = `Start testing — ${parts.join(", ")}`;
		const subject = {
			operation: "start-testing",
			steps: plan,
			spec: specDraft
				? `${specDraft.spec.title} — approve this draft`
				: `${approved!.spec.title} — already approved`,
			basket: corpusDraft
				? `${corpusDraft.name} · ${caseCount} case${caseCount === 1 ? "" : "s"}`
				: "not drafted yet",
			run: corpusDraft
				? `${caseCount} × ${input.repetitions} = ${executions} Target executions`
				: "not yet",
			estimatedCost: formatEstimatedCost(estimate),
			estimatedTime: formatEstimatedTime(estimate),
			exact: {
				specDraftId: specDraft?.id ?? null,
				specSnapshotHash: specDraft ? hashValue(specDraft) : null,
				approvedSpecId: approved?.id ?? null,
				corpusDraftId: corpusDraft?.id ?? null,
				corpusDraftHash: corpusDraft ? hashValue(corpusDraft) : null,
				repetitions: input.repetitions,
			},
		};
		const actor = await this.confirm(input, gate, title, subject, options.signal, {
			question: `${title}?`,
			...(estimate ? { estimate } : {}),
		});
		const scoped = this.compositeGate(gate, actor, planned);
		const steps: WorkbenchCompositeStep[] = [];
		let approvedSpecId = approved?.id ?? null;
		let developmentCorpus: { id: string; taskCount: number } | null = null;
		let evaluation: WorkbenchRunEvalResult | null = null;
		let view = await this.viewOf(inventory);
		let message = "";
		for (const step of plan) {
			if (step === "approve-spec") {
				const done = await this.decide({ kind: "approve-spec", draftSpecId: specDraft!.id, reason: input.reason }, scoped, options);
				approvedSpecId = done.result.approvedSpecId;
				steps.push({ kind: step, message: done.message });
				view = done.view;
			} else if (step === "publish-corpus") {
				const done = await this.decide({ kind: "publish-corpus", draftId: corpusDraft!.id, reason: input.reason }, scoped, options);
				developmentCorpus = { id: done.result.corpusId, taskCount: done.result.taskCount };
				steps.push({ kind: step, message: done.message });
				view = done.view;
			} else {
				const done = await this.decide({ kind: "run-eval", repetitions: input.repetitions, reason: input.reason }, scoped, options);
				evaluation = done.result;
				steps.push({ kind: step, message: done.message });
				view = done.view;
				message = done.message;
			}
		}
		// The basket is bound to an approved Spec, so it can only be drafted after
		// this approval; saying so is more useful than an error.
		const pending = evaluation ? null : "the test cases are not drafted yet";
		return {
			kind: input.kind,
			message: message ||
				"Spec approved. Next: draft the test cases, then “tests” publishes them and runs.",
			result: { steps, approvedSpecId, developmentCorpus, evaluation, pending },
			view,
		};
	}

	/**
	 * “Ship it”: the release decisions that are left, behind one dialog — review,
	 * promote, adopt, continue. Same services, same order, same receipts, and the
	 * same stop-at-the-first-refusal behaviour as the four separate decisions.
	 */
	private async ship(
		input: Extract<WorkbenchDecisionInput, { kind: "ship" }>,
		gate: WorkbenchHumanGate,
		options: WorkbenchDecisionExecutionOptions,
		inventory: WorkbenchInventory,
		stage: WorkbenchStage,
	): Promise<Extract<WorkbenchDecisionResult, { kind: "ship" }>> {
		const plan: WorkbenchCompositeStep["kind"][] = [];
		let candidate: CandidateRecord;
		if (stage === "candidate-review") {
			candidate = requireCandidate(inventory, ["evaluated"], input.candidateId);
			plan.push("review-candidate", "promote-candidate", "adopt-candidate", "continue-cycle");
		} else if (stage === "release-decision") {
			candidate = requireCandidate(inventory, ["reviewed"], input.candidateId);
			plan.push("promote-candidate", "adopt-candidate", "continue-cycle");
		} else {
			candidate = requireOpenTerminalCandidate(inventory, input.candidateId);
			if (candidateStatus(candidate) !== "promoted") {
				throw new Error(
					`candidate ${candidate.candidateId} was rejected; there is nothing to ship. Close the cycle instead.`,
				);
			}
			if (stage === "candidate-adoption") plan.push("adopt-candidate");
			plan.push("continue-cycle");
		}
		const version = input.version;
		if (plan.includes("promote-candidate") && !version) {
			throw new Error("shipping tags an exact version; say for example “ship 0.2.0”");
		}
		// The judge-aware projection, not the plain summary: this subject is what
		// the one consequential ship dialog renders, and an uncalibrated judge is
		// exactly what the operator must see BEFORE approving — promotion can
		// refuse on it. `candidateView` swallows its own errors, so a missing
		// label store degrades to the plain summary instead of blocking a ship.
		const summary = this.candidateView(candidate);
		const candidateId = candidate.candidateId;
		const sameCandidate = (subject: unknown): boolean =>
			(subject as { candidate?: { candidateId?: unknown } }).candidate?.candidateId === candidateId;
		const planned = new Map<WorkbenchDecisionInput["kind"], (subject: unknown) => boolean>();
		if (plan.includes("review-candidate")) {
			planned.set("review-candidate", (subject) =>
				sameCandidate(subject) && (subject as { recommendation?: unknown }).recommendation === "promote");
		}
		if (plan.includes("promote-candidate")) {
			planned.set("promote-candidate", (subject) =>
				sameCandidate(subject) && (subject as { version?: unknown }).version === version);
		}
		if (plan.includes("adopt-candidate")) planned.set("adopt-candidate", sameCandidate);
		planned.set("continue-cycle", sameCandidate);
		const branch = plan.includes("adopt-candidate") ? currentBranchName(this.projectDir) : null;
		const subject = {
			operation: "ship",
			steps: plan,
			candidateId,
			development: summary.development?.gate
				? `${summary.development.gate.verdict} · ${formatPoints(summary.development.gate.scoreDelta)}`
				: "no development verdict",
			sealed: summary.sealedHoldout.gate
				? `${summary.sealedHoldout.gate.verdict} · ${summary.sealedHoldout.gate.tasks} × ${summary.sealedHoldout.gate.repetitions}`
				: summary.sealedHoldout.executed ? "executed, no verdict" : "not run",
			version: version ?? null,
			tag: version ? `v${version}` : null,
			fastForward: plan.includes("adopt-candidate")
				? `${branch ?? "current branch"} ${shortSha(summary.baseline.sha)} → ${shortSha(summary.candidate?.sha ?? "")}`
				: "already adopted",
			candidate: summary,
		};
		const title = version ? `Ship candidate as v${version}` : "Ship this candidate";
		const actor = await this.confirm(input, gate, title, subject, options.signal, { question: `${title}?` });
		const scoped = this.compositeGate(gate, actor, planned);
		const steps: WorkbenchCompositeStep[] = [];
		let shipped = summary;
		let tag: string | null = null;
		let adoption: { branch: string; fromSha: string; toSha: string } | null = null;
		let continuation: { receiptId: string; nextStage: WorkbenchStage } | null = null;
		let guards: WorkbenchRegressionGuardsProjection | null = null;
		let view = await this.viewOf(inventory);
		for (const step of plan) {
			if (step === "review-candidate") {
				const done = await this.decide({ kind: "review-candidate", candidateId, recommendation: "promote", reason: input.reason }, scoped, options);
				shipped = done.result;
				steps.push({ kind: step, message: done.message });
				view = done.view;
			} else if (step === "promote-candidate") {
				const done = await this.decide({ kind: "promote-candidate", candidateId, version: version!, reason: input.reason }, scoped, options);
				shipped = done.result.candidate;
				tag = done.result.tag;
				guards = done.result.guards;
				steps.push({ kind: step, message: done.message });
				view = done.view;
			} else if (step === "adopt-candidate") {
				const done = await this.decide({ kind: "adopt-candidate", candidateId, reason: input.reason }, scoped, options);
				adoption = { branch: done.result.branch, fromSha: done.result.fromSha, toSha: done.result.toSha };
				tag ??= done.result.tag;
				steps.push({ kind: step, message: done.message });
				view = done.view;
			} else {
				const done = await this.decide({ kind: "continue-cycle", candidateId, reason: input.reason }, scoped, options);
				continuation = { receiptId: done.result.receiptId, nextStage: done.result.nextStage };
				steps.push({ kind: step, message: done.message });
				view = done.view;
			}
		}
		return {
			kind: input.kind,
			message: [
				`Shipped${tag ? ` ${tag}` : ""}${adoption ? ` on ${adoption.branch}` : ""}.`,
				...(guards?.cases ? [`${guards.cases} regression guard case(s) drafted as ${guards.draftId}; publish them to pin the fix.`] : []),
				...(guards?.warning ? [guards.warning] : []),
				...(continuation ? [`The next cycle starts at ${continuation.nextStage}.`] : []),
			].join(" "),
			result: { steps, candidate: shipped, tag, adoption, continuation, guards },
			view,
		};
	}

	/**
	 * The evidence every Builder-authored proposal binds, resolved once: the
	 * approved Spec, the compatible development EvalRun the failure modes came
	 * from, the exact selected modes, and the host-minted authoring context of
	 * the clean revision the change is written against.
	 */
	private proposalEvidence(
		inventory: WorkbenchInventory,
		input: {
			approvedSpecId?: string | undefined;
			source: Omit<Parameters<typeof deriveEvidenceLinkedProposalSelection>[1], "failureModeIds">;
			failureModeIds: string[];
		},
	): {
		approved: ReturnType<typeof requireApprovedSpec>;
		sourceEvalRunId: string;
		selectedEvidence: ReturnType<typeof deriveEvidenceLinkedProposalSelection>;
		authoringContext: ReturnType<typeof inspectTargetAuthoringContext>;
	} {
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
		return { approved, sourceEvalRunId, selectedEvidence, authoringContext };
	}

	/**
	 * One exact compiled proposal — from intents or from a workshop diff — through
	 * the one canonical recording service, so both paths produce the same
	 * immutable run, the same admission receipt, and the same human apply gate.
	 */
	private async recordCompiledProposal(input: {
		proposal: CandidateProposal;
		approvedSpecId: string;
		sourceEvalRunId: string;
		proposalBasis: RecordProposalOptions["proposalBasis"];
		authoringContext: RecordProposalOptions["authoringContext"];
		label: string;
		signal?: AbortSignal;
	}): Promise<Awaited<ReturnType<AhdeWorkbenchDependencies["recordProposal"]>>> {
		const result = await this.dependencies.recordProposal({
			proposal: input.proposal,
			targetDir: this.projectDir,
			allowedPaths: [...CANDIDATE_SCOPE_POLICY.allowed],
			approvedSpec: { stateRoot: this.stateRoot, projectId: this.projectId, specId: input.approvedSpecId },
			runsRoot: this.runsRoot,
			timeoutMs: 30_000,
			sourceEvalRunId: input.sourceEvalRunId,
			proposalBasis: input.proposalBasis,
			authoringContext: input.authoringContext,
			signal: input.signal,
		});
		if (result.record.result.status !== "completed") {
			const failure = result.record.result.error;
			throw new Error(
				`${input.label} recording failed closed (${result.record.result.status})` +
				(failure ? `: ${failure.code}: ${failure.message}` : ""),
			);
		}
		return result;
	}

	// -- the Builder workshop ------------------------------------------------

	/** The open workshop, or the exact reason there is none. */
	private requireWorkshop(): BuilderWorkshop {
		if (!this.workshop?.open) {
			throw new Error("no workshop is open; submit { kind: \"workshop-open\" } before writing, running, or trying anything");
		}
		return this.workshop;
	}

	private disposeWorkshop(): void {
		const workshop = this.workshop;
		this.workshop = null;
		workshop?.dispose();
	}

	private async openWorkshop(approvedSpecId?: string): Promise<WorkbenchTurn> {
		const inventory = this.inventory();
		if (deriveWorkbenchView(inventory).stage !== "improvement-authoring") {
			throw new Error("a workshop opens only after a conclusive development evaluation");
		}
		if (!inventory.target) throw new Error("a workshop requires one exact Target");
		if (this.workshop?.open) {
			throw new Error(
				`workshop ${this.workshop.workshopId} is already open; close it into a proposal or discard it first`,
			);
		}
		requireApprovedSpec(inventory, approvedSpecId);
		const authoringContext = this.dependencies.inspectTargetAuthoringContext({
			repositoryDir: this.projectDir,
			expectedTarget: { id: inventory.target.manifest.id, gitSha: inventory.target.gitSha },
		});
		const workshop = openBuilderWorkshop({
			repositoryDir: this.projectDir,
			expectedTarget: { id: authoringContext.target.id, gitSha: authoringContext.target.gitSha },
			authoringContext: authoringContext.claim,
			now: this.dependencies.now,
		});
		this.workshop = workshop;
		return {
			kind: "workshop-open",
			message:
				`Workshop ${workshop.workshopId} is open on ${authoringContext.target.id}@${shortSha(authoringContext.target.gitSha)}. ` +
				"Read, write, run, and try the tool there; closing compiles the diff into a proposal the operator still has to apply.",
			artifact: {
				workshopId: workshop.workshopId,
				target: { id: workshop.targetId, gitSha: workshop.baseTargetSha },
				scope: [...workshop.status().scope],
				resources: authoringContext.resources.map((resource) => resource.path),
				data: authoringContext.data.map((directory) => `${directory.path} · ${plural(directory.files, "file")}`),
			},
			view: await this.viewOf(inventory),
		};
	}

	/** What the open workshop is, and everything it has changed so far. */
	workshopStatus(): WorkshopStatus {
		return this.requireWorkshop().status();
	}

	workshopRead(input: WorkshopReadInput): WorkshopReadResult {
		return this.requireWorkshop().read(WorkshopReadInputSchema.parse(input).path);
	}

	workshopWrite(input: WorkshopWriteInput): WorkshopWriteResult {
		return this.requireWorkshop().write(WorkshopWriteInputSchema.parse(input));
	}

	async workshopBash(input: WorkshopBashInput, options: { signal?: AbortSignal } = {}): Promise<WorkshopBashResult> {
		const workshop = this.requireWorkshop();
		const parsed = WorkshopBashInputSchema.parse(input);
		return workshop.bash({
			argv: parsed.argv,
			...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
			...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
			...(options.signal ? { signal: options.signal } : {}),
		});
	}

	async workshopTry(input: WorkshopTryInput, options: { signal?: AbortSignal } = {}): Promise<TryToolResult> {
		const workshop = this.requireWorkshop();
		const parsed = WorkshopTryInputSchema.parse(input);
		return workshop.tryTool({
			tool: parsed.tool,
			input: parsed.input,
			...(options.signal ? { signal: options.signal } : {}),
		});
	}

	/** True while the four workshop tools are legal. Host-side gate, not model state. */
	get workshopOpen(): boolean {
		return this.workshop?.open === true;
	}

	/**
	 * End of conversation, end of workshop. A Builder session that dies with an
	 * open workshop leaves no worktree behind.
	 */
	closeWorkshop(): void {
		this.disposeWorkshop();
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

		if (input.kind === "workshop-open") return await this.openWorkshop(input.approvedSpecId);
		if (input.kind === "workshop-discard") {
			const workshop = this.requireWorkshop();
			const workshopId = workshop.workshopId;
			const discarded = workshop.status().changes.length;
			this.disposeWorkshop();
			return {
				kind: input.kind,
				message: `Workshop ${workshopId} discarded with ${plural(discarded, "uncompiled change")}. Nothing it wrote ever existed.`,
				artifact: { workshopId, discardedChanges: discarded },
				view: await this.view(),
			};
		}

		const inventory = this.inventory();
		if (deriveWorkbenchView(inventory).stage !== "improvement-authoring") {
			throw new Error("structured proposal authoring is only legal after a conclusive development evaluation");
		}
		const evidence = this.proposalEvidence(inventory, input);
		const { approved, sourceEvalRunId, selectedEvidence, authoringContext } = evidence;

		if (input.kind === "workshop-close") {
			const workshop = this.requireWorkshop();
			if (canonicalJson(workshop.claim) !== canonicalJson(authoringContext.claim)) {
				throw new Error("the Target changed while the workshop was open; discard it and open a new one");
			}
			// The diff is the proposal: whatever is on disk, compiled exactly, with
			// the same scope assertion and the same evidence binding as an intent.
			const compiled = workshop.compile({
				summary: input.summary,
				diagnoses: selectedEvidence.diagnoses,
				risks: input.risks,
				validationPlan: input.validationPlan,
			});
			if (compiled.proposal.baseTargetSha !== authoringContext.target.gitSha) {
				throw new Error("the workshop diff does not match the inspected Target authoring revision");
			}
			const recorded = await this.recordCompiledProposal({
				proposal: compiled.proposal,
				approvedSpecId: approved.id,
				sourceEvalRunId,
				proposalBasis: { ...input.source, failureModeIds: input.failureModeIds },
				authoringContext: authoringContext.claim,
				label: "workshop",
				...(options.signal ? { signal: options.signal } : {}),
			});
			// The workshop is bound to this proposal run and dies with it.
			const workshopId = workshop.workshopId;
			this.disposeWorkshop();
			const settled = this.select("proposal", recorded.record.runId);
			return {
				kind: input.kind,
				message: `Workshop ${workshopId} closed: ${plural(compiled.changes.length, "changed file")} compiled into an exact reviewable proposal. Nothing is applied until the operator says so.`,
				artifact: {
					workshopId,
					runId: recorded.record.runId,
					proposalHash: recorded.record.artifacts.proposal?.sha256 ?? null,
					changedPaths: compiled.changes.map((change) => `${change.status} ${change.path}`),
					sourceEvalRunId,
					improvementBriefId: selectedEvidence.basis.briefId,
					failureModeIds: selectedEvidence.basis.failureModes.map((mode) => mode.failureModeId),
					approvedSpecId: approved.id,
					authoringContextHash: authoringContext.contextHash,
				},
				view: await this.viewOf(settled),
			};
		}

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
		const result = await this.recordCompiledProposal({
			proposal,
			approvedSpecId: approved.id,
			sourceEvalRunId,
			proposalBasis: { ...input.source, failureModeIds: input.failureModeIds },
			authoringContext: authoringContext.claim,
			label: "structured proposal",
			...(options.signal ? { signal: options.signal } : {}),
		});
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
			} else if (stage === "spec-review" || stage === "corpus-review") {
				// “Run the tests” with a review still pending is not an error: the
				// composite does the pending reviews and the run behind one dialog.
				resolved = await this.decide({ kind: "start-testing", repetitions: input.repetitions, reason: input.reason }, gate, options);
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
				assertWorkbenchDecisionStage("run-eval", stage);
				throw new Error(`running is not possible during ${stage}`);
			}
			if (resolved.kind === "start-testing") {
				return {
					kind: "run-current",
					message: resolved.message,
					result: { resolvedAs: "start-testing", ...resolved.result },
					view: resolved.view,
				};
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

		// The two composites: one operator intent, one dialog, the same
		// fine-grained decisions and receipts underneath.
		if (input.kind === "start-testing") return await this.startTesting(input, gate, options, inventory, stage);
		if (input.kind === "ship") return await this.ship(input, gate, options, inventory, stage);

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
			const actor = await this.confirm(input, gate, "Abandon interrupted candidate attempt", before, options.signal, {
				question: "Abandon this interrupted attempt? The applied proposal can be verified again.",
			});
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
			await this.confirm(input, gate, "Run exact development evaluation", before.subject, options.signal, {
				question: `Run ${Number(before.subject.taskCount) * input.repetitions} Target executions on the reviewed basket?`,
				estimate: this.runEstimate(Number(before.subject.taskCount) * input.repetitions, inventory.target),
			});
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
			const actor = await this.confirm(input, gate, "Calibrate run-to-run noise", before.subject, options.signal, {
				question: `Measure noise with ${Number(before.subject.executions)} Target executions?`,
				estimate: this.runEstimate(Number(before.subject.executions), inventory.target),
			});
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
			const actor = await this.confirm(input, gate, "Discard exact Builder proposal", before, options.signal, {
				question: "Discard this proposal? It can never be applied later.",
			});
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
					subject: { operation: "verify-applied-candidate", builderRunId: builderRun.runId, builderRunHash: hashValue(builderRun), applyReceiptHash: hashValue(applyReceipt), proposalHash: builderRun.artifacts.proposal?.sha256 ?? null, baseTargetSha: applyReceipt.baseTargetSha, candidateSha: applyReceipt.candidateSha, approvedSpec: builderRun.request.approvedSpec, developmentCorpus: development ?? null, sealedHoldout: { id: selected.id, hash: selected.hash, taskCount: selected.taskCount }, repetitions: input.repetitions, screen: builderRun.request.source?.evalRunId ?? null, force: input.force === true },
					approvedSpecId: builderRun.request.approvedSpec.specId,
					sourceEvalRunId: builderRun.request.source?.evalRunId ?? null,
					developmentCorpus,
					sealedCorpus: { stateRoot: this.stateRoot, projectId: this.projectId, corpusId: selected.id } satisfies CorpusRef,
				};
			};
			const before = build();
			// Two arms over the development basket and the sealed holdout.
			const developmentTasks = inventory.corpora
				.find((corpus) => corpus.id === before.subject.developmentCorpus?.id)?.taskCount ?? 0;
			const executions = 2 * (developmentTasks + selected.taskCount) * input.repetitions;
			const actor = await this.confirm(input, gate, "Verify exact applied candidate", before.subject, options.signal, {
				question: before.sourceEvalRunId
					? `Screen the cases that already failed, then verify the candidate against its baseline (up to ${executions + developmentTasks} Target executions)?`
					: `Verify the candidate against its baseline (${executions} Target executions)?`,
				estimate: this.runEstimate(executions + (before.sourceEvalRunId ? developmentTasks : 0), inventory.target),
			});
			if (choice.actorId && actorId(choice.actorId) !== actor) throw new Error("sealed selection and confirmation came from different human actors");
			const after = build();
			if (!exactSame(before.subject, after.subject)) throw new WorkbenchStaleDecisionError(input.kind);

			// The cheap check first. It runs the candidate on the cases that already
			// failed, once, candidate arm only — a screen, never evidence: it enters
			// no gate and can never reach promotion. A flat screen stops the spend
			// unless the operator explicitly forced it; a screen whose own
			// infrastructure errors blew the budget is inconclusive and stops
			// nothing (invariant 9).
			let screen: CheapCheckResult | null = null;
			if (after.sourceEvalRunId) {
				try {
					screen = await this.dependencies.runCheapCheck({
						repositoryDir: this.projectDir,
						runsRoot: this.runsRoot,
						candidateRef: after.subject.candidateSha,
						baselineRef: after.subject.baseTargetSha,
						sourceEvalRunId: after.sourceEvalRunId,
						...(after.developmentCorpus ? { developmentCorpus: after.developmentCorpus } : {}),
						...(options.signal ? { signal: options.signal } : {}),
						...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
						now: this.dependencies.now,
					});
				} catch (error) {
					// A screen that cannot run is not a verdict. Say so and measure.
					console.error("AHDE host-only cheap check failure:", error);
					screen = null;
				}
			}
			if (screen && screen.verdict === "flat" && screen.withinErrorBudget && input.force !== true) {
				const projection = this.screenProjection(screen);
				return {
					kind: input.kind,
					message:
						`Cheap check found nothing: ${screen.tasks.length} previously failing case` +
						`${screen.tasks.length === 1 ? "" : "s"} re-run once on the candidate, ` +
						`${screen.improved} improved, ${screen.unchanged} unchanged, ${screen.regressed} regressed. ` +
						`The ${executions}-execution verification was not spent. ` +
						"Author another change, or verify anyway with force.",
					result: {
						outcome: "stopped-by-screen",
						builderRunId: after.subject.builderRunId,
						candidateSha: after.subject.candidateSha,
						screen: projection,
						spared: { executions },
					},
					view: await this.viewOf(this.inventory()),
				};
			}

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
					outcome: "verified",
					candidate: candidateSummary(result.record),
					development: { verdict: result.compare.gate.verdict, delta: result.compare.summary.delta, confidence95: result.compare.summary.confidence95 },
					sealedHoldout: { executed: result.sealedHoldout !== null, gatePassed: sealedVerdict === "pass", verdict: sealedVerdict },
					screen: screen ? this.screenProjection(screen) : null,
				},
				view: await this.viewOf(settled),
			};
		}

		if (input.kind === "improve") {
			if (!inventory.target) throw new Error("`improve` needs one exact resolved Target");
			const approved = requireApprovedSpec(inventory);
			const corpus = requireDevelopmentCorpus(inventory, input.developmentCorpusId, approved.id);
			const plannedExecutions = plannedImprovementExecutions({
				developmentTasks: corpus.taskCount,
				repetitions: input.repetitions,
				maxCycles: input.maxCycles,
			});
			const target = `${Math.round(input.until * 100)}%`;
			const subject = {
				operation: "improve",
				approvedSpecId: approved.id,
				developmentCorpus: { id: corpus.id, hash: corpus.hash, taskCount: corpus.taskCount },
				until: input.until,
				maxCycles: input.maxCycles,
				repetitions: input.repetitions,
				plannedExecutions,
				neverDecides: [...IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS],
			};
			const actor = await this.confirm(input, gate, `Improve until ${target}`, subject, options.signal, {
				question:
					`Run up to ${input.maxCycles} improvement cycle${input.maxCycles === 1 ? "" : "s"} ` +
					`towards ${target} (at most ${plannedExecutions} Target executions)? ` +
					"The loop never promotes, adopts, publishes or approves anything.",
				estimate: this.runEstimate(plannedExecutions, inventory.target),
			});
			const loop = await this.dependencies.runImprovementLoop({
				repositoryDir: this.projectDir,
				runsRoot: this.runsRoot,
				stateRoot: this.stateRoot,
				projectId: this.projectId,
				approvedSpecId: approved.id,
				developmentCorpus: { stateRoot: this.stateRoot, projectId: this.projectId, corpusId: corpus.id },
				until: input.until,
				maxCycles: input.maxCycles,
				repetitions: input.repetitions,
				...(input.jobs === undefined ? {} : { jobs: input.jobs }),
				author: this.dependencies.authorImprovementProposal ?? recordedBuilderProposalAuthor({
					stateRoot: this.stateRoot,
					runsRoot: this.runsRoot,
					projectId: this.projectId,
				}),
				gate: improvementLoopGate(gate),
				actorId: actor,
				...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
				...(options.signal ? { signal: options.signal } : {}),
				now: this.dependencies.now,
			});
			const table = renderImprovementLoopTable(loop);
			return {
				kind: input.kind,
				message:
					`${loop.cycles.length} improvement cycle${loop.cycles.length === 1 ? "" : "s"} ran. ` +
					`Stopped because ${loop.stopMessage}.`,
				result: {
					cycles: loop.cycles,
					stopReason: loop.stopReason,
					stopMessage: loop.stopMessage,
					table,
					candidateId: loop.candidateId,
					finalPassRate: loop.finalPassRate,
					executions: loop.executions,
				},
				view: await this.viewOf(this.inventory()),
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
			// The promotion is written. Pinning what it fixed comes after, and its
			// failure is a warning: a bookkeeping step never un-ships a release.
			const guards = this.promotionGuards(promoted.record, promoted.tag);
			const settled = this.select("candidate", promoted.record.candidateId);
			return {
				kind: input.kind,
				message: [
					`Candidate promoted as ${promoted.tag}. Adopt it to make it the active Target.`,
					...(guards.cases > 0
						? [`${guards.cases} case(s) that flipped fail→pass are drafted as regression guards in ${guards.draftId}; publish that draft to pin them.`]
						: []),
					...(guards.warning ? [guards.warning] : []),
				].join(" "),
				result: { candidate: candidateSummary(promoted.record), tag: promoted.tag, candidateSha: promoted.candidateSha, guards },
				view: await this.viewOf(settled),
			};
		}

		if (input.kind === "reject-candidate") {
			// Rejecting is legal where the operator reads the evidence, not only one
			// step later: at `candidate-review` the review is recorded first, after
			// the same single question, so "reject" never bounces off a stage rule.
			const candidate = requireCandidate(inventory, ["evaluated", "reviewed"], input.candidateId);
			const needsReview = candidateStatus(candidate) === "evaluated";
			const before = { operation: "reject-candidate", candidateHash: hashValue(candidate), candidate: this.candidateView(candidate) };
			const actor = await this.confirm(input, gate, "Reject exact candidate", before, options.signal, {
				question: "Reject this candidate? The agent stays at its baseline.",
			});
			const current = this.decisionInventory(input.kind);
			if (hashValue(requireCandidate(current, ["evaluated", "reviewed"], candidate.candidateId)) !== hashValue(candidate)) throw new WorkbenchStaleDecisionError(input.kind);
			const reviewedRecord = needsReview
				? this.dependencies.reviewCandidate({ runsRoot: this.runsRoot, candidateId: candidate.candidateId, expectedCandidateHash: before.candidateHash, recommendation: "reject", reason: input.reason, actorId: actor, now: this.dependencies.now })
				: candidate;
			const rejected = this.dependencies.rejectCandidate({ runsRoot: this.runsRoot, candidateId: candidate.candidateId, expectedCandidateHash: hashValue(reviewedRecord), reason: input.reason, actorId: actor, now: this.dependencies.now });
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
