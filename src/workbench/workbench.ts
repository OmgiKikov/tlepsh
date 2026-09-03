import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { plural as localizedCount, t } from "../i18n.js";
import {
	appendJsonlArtifact,
	readJsonArtifact,
	readJsonlArtifact,
	writeJsonArtifact,
} from "../storage/artifacts.js";
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
import {
	planSealedSynthesis,
	sealedSynthReviewPath,
	synthesizeSealedCorpus,
} from "../application/sealed-synth.js";
import { resolveDevelopmentFailureOperations } from "../application/builder-regression-case.js";
import {
	compileHarnessAuthoringProposal,
	type HarnessAuthoringIntent,
} from "../application/harness-authoring.js";
import {
	assertToolContract,
	compileToolPackage,
	ToolAuthoringBriefSchema,
	type ToolAuthoringBrief,
} from "../application/tool-authoring.js";
import { inspectTargetAuthoringContext } from "../application/target-authoring-context.js";
import { assertPredictionScope } from "../application/prediction.js";
import {
	compactExperimentHistory,
	compileExperimentHistory,
} from "../application/experiment-history.js";
import {
	openBuilderWorkshop,
	reattachBuilderWorkshop,
	MAX_WORKSHOP_GRANT_AUDIT_EVENTS,
	WorkshopGrantAuditEventSchema,
	type BuilderWorkshop,
	type BuilderWorkshopBinding,
	type BuilderWorkshopBasis,
	type BuilderWorkshopSource,
	type ToolFixtureRunResult,
	type TryToolResult,
	type WorkshopGrantAuditEvent,
	type WorkshopToolGrantRequirement,
	type WorkshopBashResult,
	type WorkshopReadResult,
	type WorkshopStatus,
	type WorkshopWriteResult,
} from "../application/tool-workshop.js";
import {
	changedToolDescriptors,
	toolContractCases,
	toolContractCasesWithoutJudge,
} from "../application/tool-contract-cases.js";
import { missingEnvNames } from "../env.js";
import { runAppliedBuilderCandidate } from "../application/builder-candidate.js";
import { SEALED_GATE_POLICY } from "../domain/comparison-gate.js";
import {
	configureTargetBootstrap,
	describeTargetBootstrap,
} from "../application/target-bootstrap.js";
import {
	configureEvaluators,
	describeEvaluatorConfiguration,
} from "../application/configure-evaluators.js";
import {
	applyTargetScaffold,
	applyTargetWrap,
	describeTargetScaffold,
	describeTargetWrap,
} from "../application/target-scaffold.js";
import { detectAgentFolder } from "../application/agent-folder-detect.js";
import {
	describeBuilderProposalDiscard,
	discardBuilderProposal,
} from "../application/builder-discard.js";
import {
	CANDIDATE_SCOPE_POLICY,
	candidateScopeFor,
	runCandidateExperiment,
} from "../application/candidate-experiment.js";
import {
	runCheapCheck,
	type CheapCheckResult,
} from "../application/cheap-check.js";
import { buildPromotionRegressionGuards } from "../application/regression-guards.js";
import {
	abandonImprovementLoop,
	IMPROVEMENT_LOOP_AUTHOR_DISCLOSURE,
	IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS,
	improvementLoopGate,
	listUnfinishedImprovementLoops,
	plannedImprovementExecutions,
	recordedBuilderProposalAuthor,
	renderImprovementLoopTable,
	runImprovementLoop,
	UnfinishedImprovementLoopError,
	type ImprovementProposalAuthor,
} from "../application/improvement-loop.js";
import {
	decideCandidateRejection,
	promoteReviewedCandidate,
	reviewCandidate,
} from "../application/candidate-review.js";
import {
	assertGradersRunnable,
	resolveScoredCasesForEval,
	targetWithDevelopmentCorpus,
} from "../application/corpus-target.js";
import {
	compileRegradeDiff,
	estimateRegradeJudgeSpend,
	planRegradeGraders,
	projectCandidateRegrade,
	resolveRegradeSource,
	type CandidateRegradeProjection,
	type RegradeDiff,
} from "../application/regrade-decision.js";
import { regradeEvalRun } from "../regrade.js";
import {
	applyBuilderProposal,
	loadBuilderApplyReceipt,
	type PersistedBuilderRun,
} from "../application/builder-proposal.js";
import {
	compileImprovementBrief,
	deriveEvidenceLinkedProposalSelection,
	type ImprovementBrief,
} from "../application/improvement-brief.js";
import type { CandidateProposal, ProposalPredictionInput } from "../builders/adapters.js";
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
	isSealedEvalRun,
	loadEvalRun,
	readEvalRunIndex,
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
	workbenchStateDirectory,
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
	candidateProposalReview,
	candidateMeasurement,
	candidateSummary,
	compatibleDevelopmentEvals,
	diagnosisSummary,
	proposalReview,
	requireApprovedSpec,
	requireCandidate,
	evaluationProjection,
	requireCorpusDraft,
	requireDevelopmentCorpus,
	requireDevelopmentEval,
	requireProposal,
	requireReadableDevelopmentEval,
	requireSpecDraft,
	resolveOne,
} from "./resolution.js";
import { calibrationProjection, DEFAULT_REPETITIONS } from "./calibration.js";
import {
	assertWorkbenchDecisionStage,
	assertWorkshopStage,
	estimateRunCost,
	routineCostGuard,
	workbenchGateClass,
	type AuthorizedRunEstimate,
	type WorkbenchRunEstimate,
} from "./transition-policy.js";
import {
	PersistedWorkbenchWorkshopSchema,
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
	type WorkbenchHistoryDetail,
	type WorkbenchHumanGate,
	type WorkbenchImprovementBriefProjection,
	type WorkbenchProposalReview,
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
	type WorkbenchVerifyCandidateResult,
	type PersistedWorkbenchWorkshop,
} from "./types.js";
import type { CandidateRecord } from "../domain/candidate.js";
import { decideScaffoldTarget, decideWrapTarget, decideConfigureTarget, decideConfigureEvaluators } from "./decisions/setup.js";
import { decideApproveSpec, decidePublishCorpus, decideImportDataset, decideGenerateHoldout } from "./decisions/corpus.js";
import { decideRunEval, decideCalibrate, decideRegrade } from "./decisions/evaluation.js";
import { decideApplyProposal, decideDiscardProposal } from "./decisions/proposal.js";
import { decideVerifyCandidate, decideAbandonCandidate } from "./decisions/candidate.js";
import { decideReviewCandidate, decidePromoteCandidate, decideRejectCandidate, decideAdoptCandidate, decideContinueCycle } from "./decisions/release.js";
import { decideImprove } from "./decisions/improve.js";
import type { DecisionContext } from "./decisions/shared.js";

const MAX_REVIEW_BYTES = 5 * 1024 * 1024;
const MAX_CONVERSATION_MODES = 3;
/** Enough compiled cases to argue about; never enough to be the dataset. */
/**
 * Every generated exam is called the same thing. A name is the one part of a
 * corpus a model could choose, and a chosen name is a channel: it would travel
 * with the corpus into the sealed selector and back out on every surface that
 * lists one. The host names it, once, for all of them.
 */
export const GENERATED_HOLDOUT_NAME = "Sealed exam (written by the judge)";
export const MAX_DATASET_SAMPLE_CASES = 5;
const MAX_DATASET_CASE_CHARS = 400;
const MAX_DATASET_CASE_TURNS = 6;

export interface WorkbenchEvidenceLink {
	url: string;
	label?: string;
}

export interface WorkbenchToolContractResult {
	name: string;
	passed: boolean;
	exitCode: number | null;
	durationMs: number;
	failure: string | null;
}

export interface WorkbenchToolAuthoringResult {
	tool: string;
	packageHash: string;
	files: string[];
	capabilities: {
		network: "deny" | "allow";
		filesystem: "read-only" | "workspace-write";
		process: "sandboxed-subprocess";
		credentials: number;
	};
	tests: WorkbenchToolContractResult[];
	allPassed: boolean;
}

/** The exact options the one canonical proposal-recording service accepts. */
type RecordProposalOptions = Parameters<typeof recordBuilderAuthoredProposal>[0];

export interface CompileHarnessAuthoringInput {
	repositoryDir: string;
	expectedBaseTargetSha: string;
	intents: readonly HarnessAuthoringIntent[];
	summary: string;
	/** Absent for construction: a Spec is intent, not invented failure evidence. */
	diagnoses?: CandidateProposal["diagnoses"];
	risks: string[];
	validationPlan: string[];
	/** The falsifiable promise hashed into the proposal the operator applies. */
	prediction?: ProposalPredictionInput | null;
}

export interface AhdeWorkbenchDependencies {
	now: () => string;
	/** The one read of durable project state; a test may serve it from memory. */
	loadInventory: typeof loadWorkbenchInventory;
	describeTargetScaffold: typeof describeTargetScaffold;
	applyTargetScaffold: typeof applyTargetScaffold;
	describeTargetWrap: typeof describeTargetWrap;
	applyTargetWrap: typeof applyTargetWrap;
	detectAgentFolder: typeof detectAgentFolder;
	describeTargetBootstrap: typeof describeTargetBootstrap;
	configureTargetBootstrap: typeof configureTargetBootstrap;
	describeEvaluatorConfiguration: typeof describeEvaluatorConfiguration;
	configureEvaluators: typeof configureEvaluators;
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
	/**
	 * The exam the judge writes, in two halves: what it would be, so a human can
	 * approve a price and a model before a token is spent, and doing it. Neither
	 * half returns a case; the second one writes the sealed corpus itself.
	 */
	planSealedSynthesis: typeof planSealedSynthesis;
	synthesizeSealedCorpus: typeof synthesizeSealedCorpus;
	sealedSynthReviewPath: typeof sealedSynthReviewPath;
	compileHarnessProposal: (input: CompileHarnessAuthoringInput) => CandidateProposal;
	recordProposal: typeof recordBuilderAuthoredProposal;
	runSuite: typeof runSuite;
	/** A/A calibration of one exact revision; never a promotion path. */
	runCalibration: typeof runCandidateExperiment;
	/** Re-score recorded traces with a revised rubric; never a Target call. */
	regradeEvalRun: typeof regradeEvalRun;
	diagnoseEval: typeof diagnoseEvalRun;
	compileImprovementBrief: (runsRoot: string, diagnosis: ReturnType<typeof diagnoseEvalRun>) => ImprovementBrief;
	inspectTargetAuthoringContext: typeof inspectTargetAuthoringContext;
	/** What was already tried: the read side of this project's candidate records. */
	compileExperimentHistory: typeof compileExperimentHistory;
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
	describeTargetWrap,
	applyTargetWrap,
	detectAgentFolder,
	describeTargetBootstrap,
	configureTargetBootstrap,
	describeEvaluatorConfiguration,
	configureEvaluators,
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
	planSealedSynthesis,
	synthesizeSealedCorpus,
	sealedSynthReviewPath,
	compileHarnessProposal: compileHarnessAuthoringProposal,
	recordProposal: recordBuilderAuthoredProposal,
	runSuite,
	runCalibration: runCandidateExperiment,
	regradeEvalRun,
	diagnoseEval: diagnoseEvalRun,
	compileImprovementBrief,
	inspectTargetAuthoringContext,
	compileExperimentHistory,
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

export function abortIfRequested(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("operation aborted");
}

/** The finished candidate whose loop is still open; focus only breaks ties. */
export function requireOpenTerminalCandidate(inventory: WorkbenchInventory, explicitId?: string): CandidateRecord {
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
export function formatEstimatedCost(estimate: WorkbenchRunEstimate | undefined): string {
	if (!estimate || estimate.costUsd === null) return `${t("estimate.unknown")} ${t("estimate.nothing-comparable")}`;
	if (estimate.costUsd < 0.01) return t("estimate.under-cent");
	return `${t("estimate.about-cost", { cost: estimate.costUsd.toFixed(2) })} (${
		t("estimate.from-earlier-runs", { runs: localizedCount(estimate.sampledRuns, "eval run") })
	})`;
}

export function formatEstimatedTime(estimate: WorkbenchRunEstimate | undefined): string {
	if (!estimate || estimate.minutes === null) return `${t("estimate.unknown")} ${t("estimate.nothing-comparable")}`;
	if (estimate.minutes < 1) return t("estimate.under-minute");
	const minutes = Math.ceil(estimate.minutes);
	return t("estimate.about-minutes", { minutes: localizedCount(minutes, "minute"), count: minutes });
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

/**
 * Refuse before asking whether a tool may read a key that is not there. The
 * `next:` clause is the whole recovery: one exported variable in the shell that
 * runs ahde. The value never reaches the Builder, this process, or the log.
 */
function assertDeclaredKeysPresent(requirement: WorkshopToolGrantRequirement): void {
	const missing = missingEnvNames(requirement.environment);
	if (missing.length === 0) return;
	throw new Error(
		`the ${requirement.tool} tool declares ${missing.join(", ")}, and ${missing.length === 1 ? "it is" : "they are"} not set here; ` +
		`next: export ${missing[0]} in the shell that runs ahde`,
	);
}

export function actorId(value: string | undefined): string {
	const actor = value?.trim();
	if (!actor || actor.length > 256) throw new Error("human gate did not provide a bounded actor identity");
	return actor;
}

export function exactSame(left: unknown, right: unknown): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

function persistedWorkshopBinding(workshop: PersistedWorkbenchWorkshop): BuilderWorkshopBinding {
	if (workshop.basis === "construction") {
		if (workshop.source !== null) {
			throw new Error("the recorded construction workshop carries improvement evidence");
		}
		return { basis: workshop.basis, approvedSpecId: workshop.approvedSpecId, source: null };
	}
	if (workshop.source === null) {
		throw new Error("the recorded improvement workshop has no exact evidence source; explicitly abandon it");
	}
	return {
		basis: workshop.basis,
		approvedSpecId: workshop.approvedSpecId,
		source: { ...workshop.source },
	};
}

function boundedSubject(value: unknown, label: string): unknown {
	if (Buffer.byteLength(canonicalJson(value), "utf8") > MAX_REVIEW_BYTES) {
		throw new Error(`${label} exceeds the ${MAX_REVIEW_BYTES}-byte exact review limit; split it before continuing`);
	}
	return value;
}

export function boundedEvidenceLink(link: WorkbenchEvidenceLink | null): WorkbenchEvidenceLink | null {
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
		case "no_secret":
			return { ...grader, ...named };
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
export function datasetCasePreview(task: CorpusTask): WorkbenchDatasetCase {
	return {
		input: datasetText(task.input),
		expected: task.expected === undefined ? null : datasetText(task.expected),
		messages: task.messages
			? task.messages.slice(-MAX_DATASET_CASE_TURNS).map((message) => ({
				role: message.role,
				content: datasetText(message.content, 200),
			}))
			: null,
		simulatedUser: task.simulatedUser
			? {
				goal: datasetText(task.simulatedUser.goal, 400),
				persona: task.simulatedUser.persona === undefined ? null : datasetText(task.simulatedUser.persona, 400),
				maxTurns: task.simulatedUser.maxTurns,
				stopWhen: task.simulatedUser.stopWhen === undefined ? null : datasetText(task.simulatedUser.stopWhen, 200),
			}
			: null,
		world: task.world
			? {
				state: datasetText(canonicalJson(task.world.state), 2_000),
				expect: task.world.expect
					? task.world.expect.map((expectation) => ({
						path: datasetText(expectation.path, 200),
						op: expectation.op,
						value: expectation.value === undefined ? null : datasetText(canonicalJson(expectation.value), 200),
					}))
					: null,
			}
			: null,
		metadata: task.metadata
			? Object.fromEntries(Object.entries(task.metadata).map(([key, value]) => [key, datasetText(value, 200)]))
			: null,
		graders: task.graders.map(datasetGrader),
	};
}

/** Small model-facing diagnosis projection; full evidence remains in the verified report. */
export function conversationalImprovementBrief(brief: ImprovementBrief): WorkbenchImprovementBriefProjection {
	const modes = brief.modes.slice(0, MAX_CONVERSATION_MODES).map((mode, index) => ({
		ordinal: index + 1,
		failureModeId: mode.failureModeId,
		signature: mode.signature,
		category: mode.category,
		scope: mode.scope,
		severity: mode.severity,
		evidenceStrength: mode.evidenceStrength,
		decision: mode.decision,
		selectableForProposal: brief.proposalEligible && mode.decision === "propose-harness-change",
		title: mode.title.slice(0, 500),
		summary: mode.summary.slice(0, 1_000),
		facts: mode.facts.slice(0, 1_000),
		observations: mode.observations,
		observedRuns: mode.observedRuns,
		suggestions: mode.suggestions.slice(0, 2).map((item) => item.slice(0, 500)),
		impact: mode.impact,
		taskIds: mode.taskIds.slice(0, 5),
		// The raw excerpt travels with the evidence: a Builder that reads this
		// projection reads what the Target called and said, not only that it failed.
		evidence: mode.evidence.slice(0, 3).map((item) => ({
			runId: item.runId,
			taskId: item.taskId,
			traceAvailable: item.traceAvailable,
			graderNames: item.graderNames.slice(0, 3),
			excerpt: item.excerpt,
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
	/** @internal — read by the decision handlers in ./decisions. */
	readonly templateDir: string | undefined;
	/** @internal — read by the decision handlers in ./decisions. */
	readonly dependencies: AhdeWorkbenchDependencies;
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

	/** @internal — called by the decision handlers in ./decisions. */
	inventory(): WorkbenchInventory {
		return this.dependencies.loadInventory({
			projectDir: this.projectDir,
			stateRoot: this.stateRoot,
			runsRoot: this.runsRoot,
			projectId: this.projectId,
			now: this.dependencies.now,
		});
	}

	/** @internal — called by the decision handlers in ./decisions. */
	decisionInventory(
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
	 * evidence has been checked and — when the operator has since rewritten the
	 * rubric and re-scored both arms — what that rubric says about the same two
	 * arms. Like impact, both are review aids: an unreadable label store or a
	 * half-readable re-score leaves the line off rather than blocking a decision.
	 */
	/** @internal — called by the decision handlers in ./decisions. */
	candidateView(
		candidate: CandidateRecord,
		developmentEvals: WorkbenchInventory["developmentEvals"],
	): WorkbenchCandidateSummary {
		const evaluated = candidate.events.find((event) => event.type === "evaluated");
		if (evaluated?.type !== "evaluated") return candidateSummary(candidate);
		const regraded = this.candidateRegrade(evaluated.evaluation.development, developmentEvals);
		try {
			const approvedSpec = candidate.origin.kind === "applied-builder"
				? {
					projectId: candidate.origin.approvedSpec.projectId,
					specId: candidate.origin.approvedSpec.specId,
					specContentHash: candidate.origin.approvedSpec.specContentHash,
					snapshotHash: candidate.origin.approvedSpec.snapshotHash,
				}
				: candidate.specId
					? loadApprovedSpec({ stateRoot: this.stateRoot, projectId: candidate.projectId, specId: candidate.specId }).reference
					: undefined;
			const calibration = judgeEvidenceCalibration({
				runsRoot: this.runsRoot,
				stateRoot: this.stateRoot,
				projectId: this.projectId,
				evalRunIds: [evaluated.evaluation.development.candidate.evalRunId],
				requireBoundLineage: true,
				...(approvedSpec ? { approvedSpec } : {}),
			});
			if (calibration.specHashes.length === 0) return candidateSummary(candidate, undefined, regraded);
			return candidateSummary(
				candidate,
				calibration.stats
					? {
						agreement: calibration.stats.agreement,
						kappa: calibration.stats.kappa,
						labels: calibration.stats.n,
					}
					: null,
				regraded,
			);
		} catch {
			return candidateSummary(candidate, undefined, regraded);
		}
	}

	/**
	 * Both development arms of one candidate, re-scored with the same revised
	 * rubric — or null, which is the ordinary answer: most candidates are never
	 * re-scored, and the check costs nothing until a derived run actually names
	 * one of the two arms.
	 */
	private candidateRegrade(
		development: { baseline: { evalRunId: string }; candidate: { evalRunId: string } },
		developmentEvals: WorkbenchInventory["developmentEvals"],
	): CandidateRegradeProjection | null {
		try {
			return projectCandidateRegrade({
				runsRoot: this.runsRoot,
				evals: developmentEvals,
				baselineEvalRunId: development.baseline.evalRunId,
				candidateEvalRunId: development.candidate.evalRunId,
			});
		} catch {
			return null;
		}
	}

	/** The exact code change behind a Builder candidate, when it has one. */
	/** @internal — called by the decision handlers in ./decisions. */
	candidateProposal(candidate: CandidateRecord): WorkbenchProposalReview | null {
		return candidateProposalReview(this.runsRoot, candidate);
	}

	/** Read-side degradation: show the corruption and keep rejection reachable. */
	private candidateProposalProjection(candidate: CandidateRecord): {
		proposal: WorkbenchProposalReview | null;
		proposalError: string | null;
	} {
		try {
			return { proposal: this.candidateProposal(candidate), proposalError: null };
		} catch (error) {
			return {
				proposal: null,
				proposalError: error instanceof Error ? error.message : String(error),
			};
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

	/**
	 * What this project already tried on the Target that is loaded now. Scoped
	 * to one Target and one project so a shared runs root cannot show the
	 * Builder another agent's experiments; an unreadable candidate directory is
	 * counted, never fatal, because memory is an aid.
	 */
	private experimentHistory(inventory: WorkbenchInventory): WorkbenchHistoryDetail {
		try {
			return this.dependencies.compileExperimentHistory({
				runsRoot: this.runsRoot,
				projectId: this.projectId,
				...(inventory.target ? { targetId: inventory.target.manifest.id } : {}),
			});
		} catch {
			return { attempts: [], omitted: 0, unreadable: 0 };
		}
	}

	/** Selects one artifact and returns the state the caller's view should report. */
	/** @internal — called by the decision handlers in ./decisions. */
	select(kind: WorkbenchSelectionKind, id: string): WorkbenchInventory {
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
	/** @internal — called by the decision handlers in ./decisions. */
	datasetHoldout(sourcePath: string): DatasetHoldoutSpec | null {
		return datasetHoldoutInForce(this.stateRoot, this.projectId, sourcePath);
	}

	/** The exact recipe under discussion: named, focused by recency, or ambiguous. */
	/** @internal — called by the decision handlers in ./decisions. */
	requireDatasetRecipe(approvedSpecId: string, submissionId?: string): DatasetRecipeSubmission {
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
	/** @internal — called by the decision handlers in ./decisions. */
	async confirm(
		input: WorkbenchDecisionInput,
		gate: WorkbenchHumanGate,
		title: string,
		subject: unknown,
		signal?: AbortSignal,
		presentation: {
			question?: string;
			estimate?: WorkbenchRunEstimate;
			/** What an earlier dialog already priced and the operator approved. */
			authorized?: AuthorizedRunEstimate | null;
		} = {},
	): Promise<string> {
		abortIfRequested(signal);
		const exact = boundedSubject(subject, input.kind);
		let policy = workbenchGateClass(input.kind);
		let question = presentation.question ?? t("confirm.question", { title });
		// The guard is the only thing that can turn a routine decision back into a
		// question: an unusually expensive or entirely unknown run that nobody has
		// already approved the price of.
		if (policy === "routine" && presentation.estimate) {
			const guard = routineCostGuard(presentation.estimate, process.env, presentation.authorized);
			if (guard) {
				policy = "one-question";
				question = t("confirm.cost-guard", { question, guard: capitalize(guard) });
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
	/** @internal — called by the decision handlers in ./decisions. */
	screenProjection(screen: CheapCheckResult): WorkbenchCheapCheckProjection {
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
	/** @internal — called by the decision handlers in ./decisions. */
	promotionGuards(record: CandidateRecord, tag: string): WorkbenchRegressionGuardsProjection {
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

	/**
	 * What checking this proposal will cost once it is applied, priced exactly
	 * the way `verify-candidate` prices itself: the screen over the cases that
	 * already failed, then both arms over the development basket and the sealed
	 * holdout, at the repetitions “check it” uses.
	 *
	 * The exam contributes its SIZE and nothing else — no id, no name — and only
	 * the money and the minutes ever leave this method. The largest eligible
	 * holdout is priced because the operator may pick any of them: the amount on
	 * screen is then the most the check can cost, never less.
	 */
	/** @internal — called by the decision handlers in ./decisions. */
	verificationEstimate(
		record: PersistedBuilderRun,
		inventory: WorkbenchInventory,
	): WorkbenchRunEstimate {
		// The same basket the verification will actually run: the published
		// development corpus of this proposal's Spec, not whatever the Builder
		// happened to be measured on. An unresolvable one prices at zero here and
		// refuses at `verify-candidate`, where there is a human to tell.
		const specId = record.request.approvedSpec?.specId;
		let developmentTasks = 0;
		try {
			developmentTasks = specId ? requireDevelopmentCorpus(inventory, undefined, specId).taskCount : 0;
		} catch {
			developmentTasks = 0;
		}
		const sealedTasks = inventory.corpora
			.filter((corpus) => corpus.visibility === "sealed" && corpus.taskCount >= SEALED_GATE_POLICY.minTasks)
			.reduce((largest, corpus) => Math.max(largest, corpus.taskCount), 0);
		const screen = record.request.source?.evalRunId ? developmentTasks : 0;
		return this.runEstimate(
			screen + 2 * (developmentTasks + sealedTasks) * DEFAULT_REPETITIONS,
			inventory.target,
		);
	}

	/**
	 * The recorded evaluation a re-score is about: the one named, or the newest
	 * measured development evidence of this Target.
	 *
	 * A regrade of a regrade is deliberately not the default — the operator
	 * means "the run I just read", and that is a run that actually called the
	 * Target — but naming one is allowed, because re-scoring a re-score is
	 * still only judge money.
	 *
	 * Sealed evidence is not in this list and can never be re-scored here. The
	 * refusal names the boundary rather than offering a menu the requested id
	 * could never be on: the id was already the caller's, and what stays hidden
	 * is the exam's content, not the fact that it is one.
	 */
	/** @internal — called by the decision handlers in ./decisions. */
	regradeSource(inventory: WorkbenchInventory, explicitId?: string): EvalRunRecord {
		const chosen = resolveRegradeSource({
			evals: inventory.developmentEvals,
			...(explicitId ? { explicitId } : {}),
			readIndex: (evalRunId) => readEvalRunIndex(this.runsRoot, evalRunId),
		});
		if (chosen) return chosen as EvalRunRecord;
		throw new WorkbenchSelectionRequiredError(
			"development EvalRun",
			inventory.developmentEvals.filter((run) => run.regradeOf === undefined).map((run) => run.evalRunId),
		);
	}

	/**
	 * The recorded evaluations one re-score covers, in comparison order.
	 *
	 * At `candidate-review` the recorded answers are not a run, they are a
	 * comparison: the candidate's two development arms. Re-scoring one of them
	 * alone would produce a number with nothing to compare it against, so both
	 * arms are always re-scored with the same revised graders — including when
	 * the operator names one of them explicitly. Any other development run, and
	 * every other stage, re-scores exactly one run, as before.
	 */
	/** @internal — called by the decision handlers in ./decisions. */
	regradeSources(
		inventory: WorkbenchInventory,
		stage: WorkbenchStage,
		explicitId?: string,
	): EvalRunRecord[] {
		const arms = stage === "candidate-review" ? this.candidateDevelopmentArms(inventory) : null;
		if (arms && (explicitId === undefined || arms.some((arm) => arm.evalRunId === explicitId))) return arms;
		return [this.regradeSource(inventory, explicitId)];
	}

	/** The candidate under review, as its two recorded development arms. */
	private candidateDevelopmentArms(inventory: WorkbenchInventory): [EvalRunRecord, EvalRunRecord] | null {
		let development: { baseline: { evalRunId: string }; candidate: { evalRunId: string } };
		try {
			const candidate = requireCandidate(inventory, ["evaluated"]);
			const evaluated = candidate.events.find((event) => event.type === "evaluated");
			if (evaluated?.type !== "evaluated") return null;
			development = evaluated.evaluation.development;
		} catch {
			return null;
		}
		const find = (evalRunId: string): EvalRunRecord | undefined =>
			inventory.developmentEvals.find((run) => run.evalRunId === evalRunId);
		const baseline = find(development.baseline.evalRunId);
		const candidateArm = find(development.candidate.evalRunId);
		return baseline && candidateArm ? [baseline, candidateArm] : null;
	}

	/** What one run of this many executions is expected to cost on this Target. */
	/** @internal — called by the decision handlers in ./decisions. */
	runEstimate(executions: number, target: WorkbenchInventory["target"]): WorkbenchRunEstimate {
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
				// A composite pre-approves the exact decisions the human read. It
				// never pre-approves a workshop grant: widening what pre-review code
				// may reach is its own question, every time.
				if (confirmation.kind === "workshop-grant" || confirmation.kind === "tool-authoring") {
					return gate.confirm(confirmation, signal);
				}
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
		if (specDraft) parts.push(t("confirm.start-testing.part.approve-spec"));
		if (corpusDraft) {
			parts.push(
				t("confirm.start-testing.part.publish-corpus", { cases: localizedCount(caseCount, "case") }),
				t("confirm.start-testing.part.run", { runs: localizedCount(executions, "execution") }),
			);
		}
		const title = t("confirm.start-testing.title", { parts: parts.join(", ") });
		const subject = {
			operation: "start-testing",
			steps: plan,
			spec: specDraft
				? t("confirm.start-testing.approve-draft", { title: specDraft.spec.title })
				: t("confirm.start-testing.already-approved", { title: approved!.spec.title }),
			basket: corpusDraft
				? t("confirm.start-testing.basket", { name: corpusDraft.name, cases: localizedCount(caseCount, "case") })
				: t("confirm.start-testing.not-drafted"),
			run: corpusDraft
				? t("confirm.start-testing.run", {
					cases: caseCount,
					repetitions: input.repetitions,
					executions: localizedCount(executions, "execution"),
				})
				: t("confirm.start-testing.not-yet"),
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
			question: t("confirm.question", { title }),
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
		const pending = evaluation ? null : t("result.tests-not-drafted");
		return {
			kind: input.kind,
			message: message || t("message.spec-approved-next"),
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
		const summary = this.candidateView(candidate, inventory.developmentEvals);
		const proposal = this.candidateProposal(candidate);
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
			// The exact sentence the panel, the log and the passport print. The
			// last gate before a release quotes the measurement, never a digest
			// of it that could differ from the screen the operator just read.
			// The exam has its own line below, so it is not repeated here.
			development: candidateMeasurement(summary.development, summary.sealedHoldout).development,
			sealed: summary.sealedHoldout.gate
				? `${summary.sealedHoldout.gate.verdict} · ${summary.sealedHoldout.gate.tasks} × ${summary.sealedHoldout.gate.repetitions}`
				: summary.sealedHoldout.executed ? "executed, no verdict" : "not run",
			// A token, not a sentence: the subject the human approves is the same
			// bytes in every language, and the dialog renders the phrase from it.
			sealedOutcome: summary.sealedHoldout.gate?.outcome ?? null,
			version: version ?? null,
			tag: version ? `v${version}` : null,
			fastForward: plan.includes("adopt-candidate")
				? `${branch ?? "current branch"} ${shortSha(summary.baseline.sha)} → ${shortSha(summary.candidate?.sha ?? "")}`
				: "already adopted",
			// What is actually being shipped, and who put it there. A candidate the
			// improvement loop applied was never shown to a human diff by diff; the
			// last gate before a release is where that stops being true.
			diff: summary.appliedBy
				? {
					appliedBy: summary.appliedBy.actorId,
					via: summary.appliedBy.via,
					files: summary.appliedBy.paths.length,
					paths: summary.appliedBy.paths.slice(0, 20),
					reviewed: summary.appliedBy.via === null,
					exactDiff: proposal?.exactDiff ?? null,
					proposalHash: proposal?.proposalHash ?? null,
				}
				: null,
			candidate: summary,
		};
		const title = version ? t("confirm.ship.title", { version }) : t("confirm.ship.title-untagged");
		const actor = await this.confirm(input, gate, title, subject, options.signal, { question: t("confirm.question", { title }) });
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
			result: { steps, headline: shipped.headline, candidate: shipped, tag, adoption, continuation, guards },
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
			/** An open workshop is already bound; mutable focus may not redirect it. */
			ignoreMutableFocus?: boolean;
		},
	): {
		approved: ReturnType<typeof requireApprovedSpec>;
		sourceEvalRunId: string;
		selectedEvidence: ReturnType<typeof deriveEvidenceLinkedProposalSelection>;
		authoringContext: ReturnType<typeof inspectTargetAuthoringContext>;
	} {
		const approved = requireApprovedSpec(inventory, input.approvedSpecId);
		const corpus = input.ignoreMutableFocus
			? null
			: requireDevelopmentCorpus(inventory, undefined, approved.id);
		if (
			corpus && inventory.validFocus["development-corpus"]?.id &&
			inventory.validFocus["development-corpus"]!.id !== corpus.id
		) {
			throw new Error("focused development corpus is not in the selected approved Spec lineage");
		}
		const sourceEvalRunId = requireDevelopmentEval(
			inventory,
			input.source.evalRunId,
			corpus
				? compatibleDevelopmentEvals(inventory, approved.id, corpus.id)
				: this.compatibleDevelopmentEvalsForSpec(inventory, approved.id),
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
	 * All conclusive development runs in one exact approved-Spec lineage. Focus
	 * is intentionally absent: an editable selection may choose an initial run,
	 * but may never redirect an already-open workshop.
	 */
	private compatibleDevelopmentEvalsForSpec(
		inventory: WorkbenchInventory,
		approvedSpecId: string,
	): WorkbenchInventory["developmentEvals"] {
		if (!inventory.target) return [];
		const lineages = inventory.corpora
			.filter((corpus) =>
				corpus.visibility === "development" &&
				inventory.developmentLineage.get(corpus.id)?.publication.approvedSpecId === approvedSpecId
			)
			.map((corpus) => inventory.developmentLineage.get(corpus.id)!)
			.filter((lineage) => lineage.currentSuiteHash !== null && lineage.currentTargetGitSha !== null);
		return inventory.developmentEvals.filter((run) =>
			run.summary.error === 0 &&
			run.target.id === inventory.target!.manifest.id &&
			lineages.some((lineage) =>
				run.target.gitSha === lineage.currentTargetGitSha &&
				run.datasetHash === lineage.datasetHash &&
				run.suiteHash === lineage.currentSuiteHash
			)
		);
	}

	/** Re-derive the exact authority an open/recovered workshop must still match. */
	private deriveWorkshopBinding(
		inventory: WorkbenchInventory,
		input: {
			approvedSpecId?: string;
			expectedBasis?: BuilderWorkshopBasis;
			source?: BuilderWorkshopSource | null;
		},
	): BuilderWorkshopBinding {
		const basis = assertWorkshopStage(deriveWorkbenchView(inventory).stage);
		if (input.expectedBasis !== undefined && basis !== input.expectedBasis) {
			throw new Error(
				`the workshop basis changed from ${input.expectedBasis} to ${basis}; explicitly abandon it or restore its exact lineage`,
			);
		}
		const approved = requireApprovedSpec(inventory, input.approvedSpecId);
		if (basis === "construction") {
			if (input.source !== undefined && input.source !== null) {
				throw new Error("the construction workshop's recorded evidence basis is stale");
			}
			return { basis, approvedSpecId: approved.id, source: null };
		}
		const run = requireDevelopmentEval(
			inventory,
			input.source?.evalRunId,
			this.compatibleDevelopmentEvalsForSpec(inventory, approved.id),
		);
		const diagnosis = this.dependencies.diagnoseEval(this.runsRoot, run.evalRunId);
		const brief = this.dependencies.compileImprovementBrief(this.runsRoot, diagnosis);
		const source: BuilderWorkshopSource = {
			algorithmId: brief.algorithmId,
			evalRunId: brief.evalRunId,
			diagnosisId: brief.diagnosisId,
			briefId: brief.briefId,
		};
		if (input.source !== undefined && !exactSame(source, input.source)) {
			throw new Error("the workshop's recorded evaluation, diagnosis, or improvement brief is stale");
		}
		return { basis, approvedSpecId: approved.id, source };
	}

	/**
	 * One exact compiled proposal — from intents or from a workshop diff — through
	 * the one canonical recording service, so both paths produce the same
	 * immutable run, the same admission receipt, and the same human apply gate.
	 */
	private async recordCompiledProposal(input: {
		proposal: CandidateProposal;
		approvedSpecId: string;
		/** Host compiler authority; workshops remain resource-only. */
		manifestChangePolicy?: "resources-only" | "execution-policy";
		/** Absent for a Spec-backed construction proposal: it cites no evaluation. */
		sourceEvalRunId?: string;
		proposalBasis?: RecordProposalOptions["proposalBasis"];
		authoringContext: RecordProposalOptions["authoringContext"];
		label: string;
		signal?: AbortSignal;
	}): Promise<Awaited<ReturnType<AhdeWorkbenchDependencies["recordProposal"]>>> {
		// The Target's own declared surface, so a proposal against a command
		// Target is scoped to the files that Target says are editable.
		const scoped = this.dependencies.loadInventory({
			projectDir: this.projectDir,
			stateRoot: this.stateRoot,
			runsRoot: this.runsRoot,
			projectId: this.projectId,
		}).target;
		const result = await this.dependencies.recordProposal({
			proposal: input.proposal,
			targetDir: this.projectDir,
			allowedPaths: scoped ? candidateScopeFor(scoped.manifest).allowed : [...CANDIDATE_SCOPE_POLICY.allowed],
			...(input.manifestChangePolicy === undefined
				? {}
				: { manifestChangePolicy: input.manifestChangePolicy }),
			approvedSpec: { stateRoot: this.stateRoot, projectId: this.projectId, specId: input.approvedSpecId },
			runsRoot: this.runsRoot,
			timeoutMs: 30_000,
			// A Spec-backed construction proposal cites nothing, so it passes
			// neither: the canonical service then records `source: null`.
			...(input.sourceEvalRunId === undefined ? {} : { sourceEvalRunId: input.sourceEvalRunId }),
			...(input.proposalBasis === undefined ? {} : { proposalBasis: input.proposalBasis }),
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

	/** Refuse, with the exact reason, unless a workshop is open. */
	assertWorkshopOpen(): void {
		this.requireWorkshop();
	}

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
		this.forgetWorkshop();
		workshop?.dispose();
	}

	/** Persist selection, then drop only process-local authority and scratch. */
	suspendWorkshop(): void {
		const workshop = this.workshop;
		if (!workshop?.open) return;
		this.rememberWorkshop(workshop);
		workshop.suspend();
		this.workshop = null;
	}

	/** Where an open workshop is remembered between two Builder processes. */
	private workshopStatePath(create: boolean): string | null {
		const directory = workbenchStateDirectory(this.stateRoot, this.projectId, create);
		return directory ? join(directory, "workshop.json") : null;
	}

	/** Append-only disclosure log. It is deliberately separate from authority. */
	private workshopGrantAuditPath(create: boolean): string | null {
		const directory = workbenchStateDirectory(this.stateRoot, this.projectId, create);
		return directory ? join(directory, "workshop-grants.jsonl") : null;
	}

	private rememberWorkshop(workshop: BuilderWorkshop): void {
		const path = this.workshopStatePath(true);
		if (!path) return;
		writeJsonArtifact(path, PersistedWorkbenchWorkshopSchema, workshop.describe() as PersistedWorkbenchWorkshop);
	}

	private forgetWorkshop(): void {
		const path = this.workshopStatePath(false);
		if (path && existsSync(path)) rmSync(path, { force: true });
		const auditPath = this.workshopGrantAuditPath(false);
		if (auditPath && existsSync(auditPath)) rmSync(auditPath, { force: true });
	}

	private recordedWorkshop(): PersistedWorkbenchWorkshop | null {
		const path = this.workshopStatePath(false);
		if (!path || !existsSync(path)) return null;
		try {
			return readJsonArtifact(path, PersistedWorkbenchWorkshopSchema, { maxBytes: 128 * 1024 });
		} catch (error) {
			// An unreadable note grants nothing, but recovery is not authority to
			// destroy it or the worktree it may identify.
			throw new Error("the recorded workshop note is unreadable; inspect or explicitly abandon it", { cause: error });
		}
	}

	private workshopGrantHistory(workshopId: string): WorkshopGrantAuditEvent[] {
		const path = this.workshopGrantAuditPath(false);
		if (!path || !existsSync(path)) return [];
		const events = readJsonlArtifact(path, WorkshopGrantAuditEventSchema, {
			maxBytes: 512 * 1024,
			maxRecords: MAX_WORKSHOP_GRANT_AUDIT_EVENTS,
		});
		if (events.some((event) => event.workshopId !== workshopId)) {
			throw new Error("the workshop grant audit belongs to a different workshop");
		}
		if (new Set(events.map((event) => event.eventId)).size !== events.length) {
			throw new Error("the workshop grant audit contains duplicate events");
		}
		return events;
	}

	private appendWorkshopGrantAudit(event: WorkshopGrantAuditEvent): void {
		const recorded = this.recordedWorkshop();
		if (!recorded || recorded.workshopId !== event.workshopId) {
			throw new Error("refusing to record a grant for an unrecorded workshop");
		}
		const history = this.workshopGrantHistory(event.workshopId);
		if (history.length >= MAX_WORKSHOP_GRANT_AUDIT_EVENTS) {
			throw new Error(`workshop grant audit reached ${MAX_WORKSHOP_GRANT_AUDIT_EVENTS} events`);
		}
		if (history.some((candidate) => candidate.eventId === event.eventId)) {
			throw new Error(`duplicate workshop grant audit event ${event.eventId}`);
		}
		const path = this.workshopGrantAuditPath(true);
		if (!path) throw new Error("workshop grant audit directory is unavailable");
		appendJsonlArtifact(path, WorkshopGrantAuditEventSchema, [event]);
	}

	/**
	 * Open the Builder's one writable surface.
	 *
	 * Two things can be built here and the stage says which: a Spec-backed
	 * **construction** workshop, legal as soon as a Spec is approved, so nobody
	 * has to run a knowingly-unbuilt agent to failure before they may build its
	 * tools; and the diagnosis-backed **improvement** workshop, unchanged.
	 * A `workshopId` re-attaches to a workshop a dead process left open, and
	 * `fromProposalRunId` seeds a new one from a closed proposal's exact diff.
	 */
	private async openWorkshop(input: {
		approvedSpecId?: string | undefined;
		workshopId?: string | undefined;
		fromProposalRunId?: string | undefined;
	}): Promise<WorkbenchTurn> {
		const inventory = this.inventory();
		if (!inventory.target) throw new Error("a workshop requires one exact Target");
		if (this.workshop?.open) {
			throw new Error(
				`workshop ${this.workshop.workshopId} is already open; close it into a proposal or discard it first`,
			);
		}
		const authoringContext = this.dependencies.inspectTargetAuthoringContext({
			repositoryDir: this.projectDir,
			expectedTarget: { id: inventory.target.manifest.id, gitSha: inventory.target.gitSha },
		});
		const recorded = this.recordedWorkshop();
		let workshop: BuilderWorkshop;
		let binding: BuilderWorkshopBinding;
		let reattached = false;
		if (input.workshopId !== undefined) {
			if (input.fromProposalRunId !== undefined) {
				throw new Error("re-attaching a workshop cannot also seed a different proposal");
			}
			if (!recorded || recorded.workshopId !== input.workshopId) {
				throw new Error(`no workshop ${input.workshopId} is recorded for this project; open a new one`);
			}
			if (input.approvedSpecId !== undefined && input.approvedSpecId !== recorded.approvedSpecId) {
				throw new Error("the requested approved Spec does not match the recorded workshop");
			}
			const recordedBinding = persistedWorkshopBinding(recorded);
			binding = this.deriveWorkshopBinding(inventory, {
				approvedSpecId: recordedBinding.approvedSpecId,
				expectedBasis: recordedBinding.basis,
				source: recordedBinding.source,
			});
			if (!exactSame(binding, recordedBinding)) {
				throw new Error("the recorded workshop Spec or evidence binding is stale");
			}
			workshop = reattachBuilderWorkshop({
				repositoryDir: this.projectDir,
				expectedTarget: { id: authoringContext.target.id, gitSha: authoringContext.target.gitSha },
				authoringContext: authoringContext.claim,
				descriptor: recorded,
				expectedBinding: binding,
				grantHistory: this.workshopGrantHistory(recorded.workshopId),
				onGrantConsumed: (event) => this.appendWorkshopGrantAudit(event),
			});
			reattached = true;
		} else {
			const seed = input.fromProposalRunId === undefined
				? null
				: this.proposalSeed(inventory, input.fromProposalRunId, authoringContext.target.gitSha);
			if (
				seed && input.approvedSpecId !== undefined &&
				input.approvedSpecId !== seed.binding.approvedSpecId
			) {
				throw new Error("the requested approved Spec does not match the seeded proposal");
			}
			binding = this.deriveWorkshopBinding(inventory, {
				approvedSpecId: seed?.binding.approvedSpecId ?? input.approvedSpecId,
				...(seed ? { expectedBasis: seed.binding.basis, source: seed.binding.source } : {}),
			});
			if (seed && !exactSame(binding, seed.binding)) {
				throw new Error("the seeded proposal's Spec or evidence binding is stale");
			}
			// Opening a new workshop explicitly abandons any crash-surviving one.
			// Re-validate it before cleanup so an edited state file can never choose a
			// path to remove. A refusal preserves the note and worktree for recovery.
			if (recorded) {
				const abandonedBinding = persistedWorkshopBinding(recorded);
				const abandoned = reattachBuilderWorkshop({
					repositoryDir: this.projectDir,
					expectedTarget: { id: authoringContext.target.id, gitSha: authoringContext.target.gitSha },
					authoringContext: authoringContext.claim,
					descriptor: recorded,
					expectedBinding: abandonedBinding,
					grantHistory: this.workshopGrantHistory(recorded.workshopId),
				});
				abandoned.dispose();
				this.forgetWorkshop();
			} else {
				// A note cannot be absent while an old audit retains meaning. Starting a
				// new workshop is the explicit abandonment boundary for such debris.
				this.forgetWorkshop();
			}
			workshop = openBuilderWorkshop({
				repositoryDir: this.projectDir,
				expectedTarget: { id: authoringContext.target.id, gitSha: authoringContext.target.gitSha },
				authoringContext: authoringContext.claim,
				binding,
				...(seed ? { seed: { proposalRunId: seed.proposalRunId, patch: seed.patch } } : {}),
				now: this.dependencies.now,
				onGrantConsumed: (event) => this.appendWorkshopGrantAudit(event),
			});
		}
		this.workshop = workshop;
		this.rememberWorkshop(workshop);
		const status = workshop.status();
		return {
			kind: "workshop-open",
			message: t("message.workshop-open", {
				workshop: workshop.workshopId,
				state: t(reattached ? "message.workshop-state-reattached" : "message.workshop-state-open"),
				target: `${authoringContext.target.id}@${shortSha(authoringContext.target.gitSha)}`,
				basis: binding.basis === "construction"
					? t("message.workshop-basis-construction")
					: t("message.workshop-basis-improvement", { brief: binding.source?.briefId ?? t("message.workshop-basis-diagnosis") }),
			}),
			artifact: {
				workshopId: workshop.workshopId,
				basis: binding.basis,
				approvedSpecId: binding.approvedSpecId,
				source: binding.source,
				fromProposalRunId: workshop.fromProposalRunId,
				reattached,
				changedPaths: status.changes.map((change) => `${change.status} ${change.path}`),
				target: { id: workshop.targetId, gitSha: workshop.baseTargetSha },
				scope: [...status.scope],
				mounted:
					"only AGENTS.md, skills/**, tools/**, bin/**, data/** and the host-rendered manifest.yaml exist inside; " +
					"there is no network, no Target credential, and no evals/, imports/, runs/, .git or .env to read",
				resources: authoringContext.resources.map((resource) => resource.path),
				data: authoringContext.data.map((directory) => `${directory.path} · ${plural(directory.files, "file")}`),
			},
			view: await this.viewOf(inventory),
		};
	}

	/**
	 * Close the workshop by compiling the diff of what is actually on disk.
	 *
	 * A **construction** workshop is bound to the approved Spec: there is no
	 * evaluation yet, so it names no failure modes and its proposal is recorded
	 * with `source: null` — the same admission receipt, the same human apply
	 * gate, the same baseline run afterwards. An **improvement** workshop is
	 * bound to a diagnosis exactly as before, and must name it.
	 */
	private async closeWorkshopIntoProposal(
		input: Extract<WorkbenchSubmitInput, { kind: "workshop-close" }> & {
			risks: string[];
			validationPlan: string[];
		},
		options: { signal?: AbortSignal },
	): Promise<WorkbenchTurn> {
		const workshop = this.requireWorkshop();
		const inventory = this.inventory();
		const construction = workshop.basis === "construction";
		if (input.approvedSpecId !== undefined && input.approvedSpecId !== workshop.approvedSpecId) {
			throw new Error("the requested approved Spec does not match the workshop's immutable binding");
		}
		if (construction && input.source !== undefined) {
			throw new Error(
				"a construction workshop has no evaluation to cite; close it without source and failureModeIds",
			);
		}
		if (!construction && input.source === undefined) {
			throw new Error(
				"an improvement workshop must name the exact source and failureModeIds it aims at (aspect: \"traces\")",
			);
		}
		if (!construction && !exactSame(input.source, workshop.source)) {
			throw new Error("the requested evaluation source does not match the workshop's immutable binding");
		}
		const currentBinding = this.deriveWorkshopBinding(inventory, {
			approvedSpecId: workshop.approvedSpecId,
			expectedBasis: workshop.basis,
			source: workshop.source,
		});
		const openedBinding: BuilderWorkshopBinding = construction
			? { basis: "construction", approvedSpecId: workshop.approvedSpecId, source: null }
			: {
				basis: "improvement",
				approvedSpecId: workshop.approvedSpecId,
				source: workshop.source as BuilderWorkshopSource,
			};
		if (!exactSame(currentBinding, openedBinding)) {
			throw new Error("the workshop's approved Spec or evidence basis changed while it was open");
		}
		const evidence = construction
			? null
			: this.proposalEvidence(inventory, {
				approvedSpecId: currentBinding.approvedSpecId,
				source: currentBinding.source as BuilderWorkshopSource,
				failureModeIds: [...(input.failureModeIds ?? [])],
				ignoreMutableFocus: true,
			});
		const approved = evidence?.approved ?? requireApprovedSpec(inventory, currentBinding.approvedSpecId);
		if (!inventory.target) throw new Error("a workshop requires one exact Target");
		const authoringContext = evidence?.authoringContext ?? this.dependencies.inspectTargetAuthoringContext({
			repositoryDir: this.projectDir,
			expectedTarget: { id: inventory.target.manifest.id, gitSha: inventory.target.gitSha },
		});
		if (canonicalJson(workshop.claim) !== canonicalJson(authoringContext.claim)) {
			throw new Error("the Target changed while the workshop was open; discard it and open a new one");
		}
		// A promise may only name what this close is actually aiming at, and a
		// construction close is aiming at nothing measured yet.
		assertPredictionScope(input.prediction, {
			failureModeIds: input.failureModeIds ?? [],
			basis: construction ? "construction" : "improvement",
		});
		// The diff is the proposal: whatever is on disk, compiled exactly, from one
		// snapshot taken before anything is derived from it.
		const compiled = workshop.compile({
			summary: input.summary,
			...(evidence ? { diagnoses: evidence.selectedEvidence.diagnoses } : {}),
			risks: input.risks,
			validationPlan: input.validationPlan,
			prediction: input.prediction ?? null,
		});
		if (compiled.proposal.baseTargetSha !== authoringContext.target.gitSha) {
			throw new Error("the workshop diff does not match the inspected Target authoring revision");
		}
		const workshopSummary = workshop.status();
		const grants = workshopSummary.grants;
		const recorded = await this.recordCompiledProposal({
			proposal: compiled.proposal,
			approvedSpecId: approved.id,
			...(compiled.manifestChangePolicy === "execution-policy"
				? { manifestChangePolicy: "execution-policy" as const }
				: {}),
			...(evidence ? { sourceEvalRunId: evidence.sourceEvalRunId } : {}),
			proposalBasis: evidence
				? { ...(currentBinding.source as BuilderWorkshopSource), failureModeIds: [...(input.failureModeIds ?? [])] }
				: undefined,
			authoringContext: authoringContext.claim,
			label: "workshop",
			...(options.signal ? { signal: options.signal } : {}),
		});
		// The workshop is bound to this proposal run and dies with it.
		const workshopId = workshop.workshopId;
		this.disposeWorkshop();
		const settled = this.select("proposal", recorded.record.runId);
		return {
			kind: "workshop-close",
			message: t("message.workshop-closed", {
				workshop: workshopId,
				changes: localizedCount(compiled.changes.length, "changed file"),
				construction: construction ? t("message.workshop-closed-construction") : "",
			}),
			artifact: {
				workshopId,
				basis: workshop.basis,
				runId: recorded.record.runId,
				proposalHash: recorded.record.artifacts.proposal?.sha256 ?? null,
				changedPaths: compiled.changes.map((change) => `${change.status} ${change.path}`),
				sourceEvalRunId: evidence?.sourceEvalRunId ?? null,
				improvementBriefId: evidence?.selectedEvidence.basis.briefId ?? null,
				failureModeIds: evidence?.selectedEvidence.basis.failureModes.map((mode) => mode.failureModeId) ?? [],
				approvedSpecId: approved.id,
				// What the operator allowed the workshop to reach, carried into the
				// dialog they apply this diff behind.
				// Builder Pi gets only the fact that host-owned authority was used.
				// Exact environment names and actor identity remain in the human review
				// and immutable audit record, never in conversational model context.
				grants: grants.map((grant) => ({
					tool: grant.tool,
					capabilityCount: grant.wants.length,
					used: grant.used,
				})),
				permissions: workshopSummary.toolCapabilities.map((capability) => ({
					tool: capability.tool,
					network: capability.network,
					filesystem: capability.filesystem,
					process: capability.process,
					credentials: capability.environment.length,
				})),
				toolTests: compiled.toolTests,
				authoringContextHash: authoringContext.contextHash,
			},
			view: await this.viewOf(settled),
		};
	}

	/**
	 * The exact reviewed diff of an admitted proposal, as a patch that seeds a
	 * revision. Only this project's own admitted proposals are reachable, and
	 * only against the revision they were written for.
	 */
	private proposalSeed(
		inventory: WorkbenchInventory,
		runId: string,
		expectedBaseTargetSha: string,
	): { proposalRunId: string; patch: string; binding: BuilderWorkshopBinding } {
		const entry = inventory.proposals.find((candidate) => candidate.record.runId === runId);
		if (!entry) throw new Error(`no admitted proposal ${runId} exists in this project`);
		const proposal = entry.record.result.proposal;
		if (!proposal || proposal.decision !== "propose") {
			throw new Error(`Builder run ${runId} carries no reviewable diff to reopen`);
		}
		if (proposal.baseTargetSha !== expectedBaseTargetSha) {
			throw new Error(
				`proposal ${runId} was written against ${shortSha(proposal.baseTargetSha)}, not the current ` +
				`${shortSha(expectedBaseTargetSha)}; it cannot seed a workshop here`,
			);
		}
		const approvedSpecId = entry.record.request.approvedSpec?.specId;
		if (!approvedSpecId) {
			throw new Error(`proposal ${runId} has no exact approved Spec authority and cannot seed a workshop`);
		}
		const proposalBasis = entry.record.request.proposalBasis;
		let binding: BuilderWorkshopBinding;
		if (proposalBasis) {
			binding = {
				basis: "improvement",
				approvedSpecId,
				source: {
					algorithmId: proposalBasis.algorithmId,
					evalRunId: proposalBasis.evalRunId,
					diagnosisId: proposalBasis.diagnosisId,
					briefId: proposalBasis.briefId,
				},
			};
		} else {
			if (entry.record.request.source !== null) {
				throw new Error(`proposal ${runId} has evidence ids but no exact proposal basis and cannot seed a workshop`);
			}
			binding = { basis: "construction", approvedSpecId, source: null };
		}
		return {
			proposalRunId: entry.record.runId,
			patch: `${proposal.changes.map((change) => change.unifiedDiff.trimEnd()).join("\n")}\n`,
			binding,
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
		const workshop = this.requireWorkshop();
		const result = workshop.write(WorkshopWriteInputSchema.parse(input));
		this.rememberWorkshop(workshop);
		return result;
	}

	/**
	 * Turn one conversational brief into a complete Target-tool package and run
	 * its contract fixtures. Credential bindings and the capability approval are
	 * host inputs; neither can be supplied by Builder Pi.
	 */
	async workshopAuthorTool(
		inputValue: ToolAuthoringBrief,
		options: {
			credentialBindings: Readonly<Record<string, string>>;
			gate: WorkbenchHumanGate;
			signal?: AbortSignal;
		},
	): Promise<WorkbenchToolAuthoringResult> {
		const workshop = this.requireWorkshop();
		const brief = ToolAuthoringBriefSchema.parse(inputValue);
		const current = loadTarget(workshop.path);
		const compiled = compileToolPackage({
			brief,
			credentialBindings: options.credentialBindings,
			currentExecution: current.manifest.execution,
		});
		const subject = {
			operation: "author-and-try-tool",
			workshopId: workshop.workshopId,
			packageHash: compiled.packageHash,
			tool: compiled.brief.name,
			purpose: compiled.brief.purpose,
			dataSource: compiled.brief.dataSource,
			inputSchema: compiled.brief.parameters,
			output: compiled.brief.output,
			errors: compiled.brief.errors,
			capabilities: {
				network: compiled.capabilities.network,
				filesystem: compiled.capabilities.filesystem,
				process: compiled.capabilities.process,
				credentials: compiled.capabilities.credentialSlots.map((slot) => ({
					id: slot.id,
					purpose: slot.purpose,
					environment: options.credentialBindings[slot.id],
				})),
			},
			files: compiled.files.map((file) => `tools/${compiled.brief.name}/${file.path}`),
			contractTests: compiled.fixtures.map((fixture) => fixture.name),
		};
		const confirmation: WorkbenchConfirmation = {
			kind: "tool-authoring",
			title: t("confirm.tool-authoring.title", { tool: compiled.brief.name }),
			reason: t("confirm.tool-authoring.reason"),
			subject,
			subjectHash: hashValue(subject),
			policy: "consequential",
			question: t("confirm.tool-authoring.question", {
				tool: compiled.brief.name,
				filesystem: compiled.capabilities.filesystem,
				network: compiled.capabilities.network,
				credentials: compiled.capabilities.credentialSlots.length > 0
					? t("confirm.tool-authoring.credentials", { count: compiled.capabilities.credentialSlots.length })
					: "",
				tests: localizedCount(compiled.fixtures.length, "contract test"),
			}),
		};
		const decision = await options.gate.confirm(confirmation, options.signal);
		abortIfRequested(options.signal);
		if (!decision.approved) throw new WorkbenchDecisionDeclinedError("tool-authoring");
		const operator = actorId(decision.actorId);

		workshop.configureToolAuthoringPolicy({
			network: compiled.executionPolicy.network,
			environmentAllowlist: compiled.executionPolicy.environmentAllowlist,
		});
		workshop.replaceToolPackage(compiled.brief.name, compiled.files);
		this.rememberWorkshop(workshop);

		const tests: WorkbenchToolContractResult[] = [];
		for (const fixture of compiled.fixtures) {
			abortIfRequested(options.signal);
			try {
				const requirement = workshop.describeToolGrant(compiled.brief.name);
				if (requirement) {
					assertDeclaredKeysPresent(requirement);
					workshop.grantToolAccess({
						tool: requirement.tool,
						wants: requirement.wants,
						snapshotHash: workshop.snapshotHash(),
						actorId: operator,
						now: this.dependencies.now,
					});
				}
				const tried = await workshop.tryTool({
					tool: compiled.brief.name,
					input: fixture.input,
					test: fixture.name,
					now: this.dependencies.now,
					...(options.signal ? { signal: options.signal } : {}),
				});
				const assertion = assertToolContract(
					fixture,
					tried,
					compiled.brief.output.format === "json" ? compiled.brief.output.schema : undefined,
				);
				workshop.recordContractAssertion(fixture.name, assertion.passed, assertion.failures);
				tests.push({
					name: fixture.name,
					passed: assertion.passed,
					exitCode: tried.exitCode,
					durationMs: tried.durationMs,
					failure: assertion.failures.join("; ") || null,
				});
			} catch (error) {
				workshop.recordFailedTry(compiled.brief.name, fixture.name, error, this.dependencies.now);
				tests.push({
					name: fixture.name,
					passed: false,
					exitCode: null,
					durationMs: 0,
					failure: redactTraceText(error instanceof Error ? error.message : String(error)).slice(0, 240),
				});
			}
			this.rememberWorkshop(workshop);
		}
		return {
			tool: compiled.brief.name,
			packageHash: compiled.packageHash,
			files: compiled.files.map((file) => `tools/${compiled.brief.name}/${file.path}`),
			capabilities: {
				network: compiled.capabilities.network,
				filesystem: compiled.capabilities.filesystem,
				process: compiled.capabilities.process,
				credentials: compiled.capabilities.credentialSlots.length,
			},
			tests,
			allPassed: tests.every((test) => test.passed),
		};
	}

	async workshopBash(input: WorkshopBashInput, options: { signal?: AbortSignal } = {}): Promise<WorkshopBashResult> {
		const workshop = this.requireWorkshop();
		const parsed = WorkshopBashInputSchema.parse(input);
		const result = await workshop.bash({
			argv: parsed.argv,
			...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
			...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
			...(options.signal ? { signal: options.signal } : {}),
		});
		this.rememberWorkshop(workshop);
		return result;
	}

	/**
	 * Try one declared tool of the open workshop.
	 *
	 * The authoring profile is the default and it has no network and no Target
	 * credential. A tool whose descriptor — or whose declared `setup` step —
	 * wants either is refused until the operator answers one question, and that
	 * answer is recorded on the workshop and carried into the proposal the close
	 * compiles. Without a gate there is nobody to ask, so it stays refused.
	 */
	/**
	 * One host question that authorizes the declared authority of one exact
	 * package, and the operator identity it was answered by, so a fixture run
	 * can re-grant per invocation without asking again.
	 *
	 * A declared environment variable that is not set on this host is refused
	 * before the question is asked: allowing a tool to read a key nobody
	 * exported produces a confusing failure inside the sandbox instead of a
	 * sentence naming the one thing to do.
	 */
	private async authorizeWorkshopTool(
		workshop: BuilderWorkshop,
		tool: string,
		options: { signal?: AbortSignal; gate?: WorkbenchHumanGate; invocations?: number },
	): Promise<{ requirement: WorkshopToolGrantRequirement; actor: string } | null> {
		const requirement = workshop.describeToolGrant(tool);
		if (!requirement) return null;
		assertDeclaredKeysPresent(requirement);
		if (workshop.toolAccessGranted(requirement)) return null;
		if (!options.gate) {
			throw new Error(
				`the ${requirement.tool} tool wants ${requirement.wants.join(" and ")}; ` +
				"a workshop grants neither by default and there is no host here to allow it once",
			);
		}
		const invocations = options.invocations ?? 1;
		const subject = {
			workshopId: workshop.workshopId,
			snapshotHash: workshop.snapshotHash(),
			tryNumber: workshop.status().tries + 1,
			tool: requirement.tool,
			toolDigest: requirement.toolDigest,
			network: requirement.network,
			setupNetwork: requirement.setupNetwork,
			runtimeNetwork: requirement.runtimeNetwork,
			environment: requirement.environment,
			...(invocations > 1 ? { invocations } : {}),
		};
		const scope = invocations > 1 ? `${invocations} exact fixture runs` : "one exact try";
		const asked = invocations > 1 ? `${invocations} exact fixture runs` : "this exact try";
		const confirmation: WorkbenchConfirmation = {
			kind: "workshop-grant",
			title: `Allow ${requirement.tool} ${requirement.wants.join(" and ")} for ${scope}`,
			reason: `the ${requirement.tool} tool declares it and the workshop denies it by default`,
			subject,
			subjectHash: hashValue(subject),
			policy: "one-question",
			question: `This tool wants ${requirement.wants.join(" and ")} — allow for ${asked}?`,
		};
		const decision = await options.gate.confirm(confirmation, options.signal);
		abortIfRequested(options.signal);
		if (!decision.approved) {
			throw new Error(
				`the operator did not allow ${requirement.tool} ${requirement.wants.join(" and ")}; ` +
				"write a tool that needs neither, or ask again",
			);
		}
		const actor = actorId(decision.actorId);
		workshop.grantToolAccess({
			tool: requirement.tool,
			wants: requirement.wants,
			snapshotHash: subject.snapshotHash,
			actorId: actor,
			now: this.dependencies.now,
		});
		return { requirement, actor };
	}

	/**
	 * Three development cases per tool an applied proposal created or changed:
	 * the tool is called with the argument that was meant, a missing argument is
	 * asked about rather than invented, and a tool failure is reported rather
	 * than papered over. Every one of them also fails if the answer contains
	 * something shaped like a credential.
	 *
	 * They land in an immutable draft and stop there. Publishing a case changes
	 * what every later verdict means, so it stays the operator's decision — the
	 * Builder's line is "I added 3 contract cases for <tool>; publish them with
	 * the next test", not "I added tests".
	 *
	 * Drafting can fail for ordinary reasons — no approved Spec yet, a Target
	 * that cannot be read — and none of them are a reason to pretend Apply did
	 * not happen. A failure here returns nothing and says nothing.
	 */
	/** @internal — called by the decision handlers in ./decisions. */
	draftToolContractCases(exactDiff: string): { tool: string; draftId: string; cases: number }[] {
		try {
			const inventory = this.inventory();
			if (!inventory.target) return [];
			const changed = changedToolDescriptors(exactDiff)
				.flatMap((entry) => entry.descriptor === null ? [] : [entry.descriptor]);
			if (changed.length === 0) return [];
			const approved = requireApprovedSpec(inventory);
			const exact = loadApprovedSpec({ stateRoot: this.stateRoot, projectId: this.projectId, specId: approved.id });
			const judged = Boolean(inventory.target.manifest.evalSuite.judge);
			const drafted: { tool: string; draftId: string; cases: number }[] = [];
			for (const descriptor of changed) {
				const name = typeof descriptor.name === "string" ? descriptor.name : null;
				if (!name) continue;
				const shape = {
					name,
					description: typeof descriptor.description === "string" ? descriptor.description : "",
					...(typeof descriptor.parameters === "object" && descriptor.parameters !== null
						? { parameters: descriptor.parameters as Record<string, unknown> }
						: {}),
				};
				const composed = judged ? toolContractCases(shape) : toolContractCasesWithoutJudge(shape);
				const tasks = composed.map((entry) => ({
					input: entry.input,
					graders: entry.graders,
					metadata: entry.metadata,
				}));
				assertGradersRunnable(tasks, inventory.target.manifest, `contract cases for ${name}`);
				// Revise the open draft when there is one, so the operator keeps one
				// editable surface instead of collecting a draft per applied tool.
				const open = inventory.corpusDrafts.filter((draft) => draft.approvedSpec.specId === approved.id);
				const parent = open[open.length - 1];
				const summary = `Contract cases for the ${name} tool`;
				const draft = parent
					? this.dependencies.reviseCorpusDraft({
						stateRoot: this.stateRoot,
						approvedSpec: exact.reference,
						parentDraftId: parent.id,
						operations: tasks.map((task) => ({ type: "add" as const, task })),
						verifiedTaskProvenance: [],
						revisionSummary: summary,
					}, { now: this.dependencies.now }).draft
					: this.dependencies.createCorpusDraft({
						stateRoot: this.stateRoot,
						approvedSpec: exact.reference,
						name: `${name} contract`,
						tasks,
						coverageNotes: [`Does the agent call ${name}, with the right arguments, and say so when it fails?`],
						revisionSummary: summary,
					}, { now: this.dependencies.now }).draft;
				drafted.push({ tool: name, draftId: draft.id, cases: tasks.length });
			}
			return drafted;
		} catch {
			// The apply is durable and the operator is looking at it. A draft that
			// could not be written is not a reason to make that look like a failure.
			return [];
		}
	}

	async workshopTry(
		input: WorkshopTryInput,
		options: { signal?: AbortSignal; gate?: WorkbenchHumanGate } = {},
	): Promise<TryToolResult> {
		const workshop = this.requireWorkshop();
		const parsed = WorkshopTryInputSchema.parse(input);
		await this.authorizeWorkshopTool(workshop, parsed.tool, options);
		const result = await workshop.tryTool({
			tool: parsed.tool,
			input: parsed.input,
			now: this.dependencies.now,
			...(options.signal ? { signal: options.signal } : {}),
		});
		this.rememberWorkshop(workshop);
		return result;
	}

	/**
	 * Run every declared contract fixture of one tool of the open workshop. One
	 * question authorizes the whole run, because running a package's own tests
	 * is one operator action, not one per file.
	 */
	async workshopTryFixtures(
		input: WorkshopTryInput,
		options: { signal?: AbortSignal; gate?: WorkbenchHumanGate } = {},
	): Promise<ToolFixtureRunResult> {
		const workshop = this.requireWorkshop();
		const parsed = WorkshopTryInputSchema.parse(input);
		const fixtures = workshop.fixturesFor(parsed.tool);
		if (fixtures.length === 0) {
			throw new Error(
				`tools/${parsed.tool} declares no contract fixtures; write tools/${parsed.tool}/fixtures/<name>.json first`,
			);
		}
		const granted = await this.authorizeWorkshopTool(workshop, parsed.tool, {
			...options,
			invocations: fixtures.length,
		});
		try {
			return await workshop.tryFixtures({
				tool: parsed.tool,
				now: this.dependencies.now,
				...(options.signal ? { signal: options.signal } : {}),
				...(granted
					? {
						// The operator allowed this exact package for this exact run; each
						// invocation still consumes its own single-use grant.
						beforeEach: () => {
							if (!workshop.toolAccessGranted(granted.requirement)) {
								workshop.grantToolAccess({
									tool: granted.requirement.tool,
									wants: granted.requirement.wants,
									snapshotHash: workshop.snapshotHash(),
									actorId: granted.actor,
									now: this.dependencies.now,
								});
							}
						},
					}
					: {}),
			});
		} finally {
			this.rememberWorkshop(workshop);
		}
	}

	/** True while the five workshop tools are legal. Host-side gate, not model state. */
	get workshopOpen(): boolean {
		return this.workshop?.open === true;
	}

	/** Explicit host cleanup for discard/abandon and tests. Session shutdown suspends. */
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
	/** @internal — called by the decision handlers in ./decisions. */
	async viewOf(inventory: WorkbenchInventory, queryValue: WorkbenchViewQuery = {}): Promise<WorkbenchView> {
		const query = WorkbenchViewQuerySchema.parse(queryValue);
		// The stage is a pure function of durable artifacts; an open workshop is
		// live host state, and the derived `next` block needs both to say which
		// workshop submission is legal right now.
		const view: WorkbenchView = {
			...deriveWorkbenchView(inventory),
			...(this.workshopOpen ? { workshopOpen: true } : {}),
		};
		const aspect = query.aspect ?? "summary";
		if (aspect === "summary") return view;
		if (aspect === "target") {
			// The Builder reads this immediately before it authors, so it is where
			// the memory of what was already tried belongs: what each attempt
			// changed, what it was aiming at, what it scored, and why it ended.
			const content: WorkbenchTargetDetail = inventory.target
				? this.dependencies.inspectTargetAuthoringContext({
					repositoryDir: this.projectDir,
					expectedTarget: {
						id: inventory.target.manifest.id,
						gitSha: inventory.target.gitSha,
					},
					...(query.resourcePath ? { resourcePath: query.resourcePath } : {}),
					history: compactExperimentHistory(this.experimentHistory(inventory)),
				})
				: { launch: "ahde init ." };
			return { ...view, detail: { aspect, content } };
		}
		if (aspect === "history") {
			return { ...view, detail: { aspect, content: this.experimentHistory(inventory) } };
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
			// Reading is not deciding: the run the operator just watched stays
			// readable after the Target moves. `requireDevelopmentEval` keeps the
			// strict set for everything that authors or promotes.
			const run = requireReadableDevelopmentEval(inventory);
			const diagnosis = this.dependencies.diagnoseEval(this.runsRoot, run.evalRunId);
			const improvementBrief = this.dependencies.compileImprovementBrief(this.runsRoot, diagnosis);
			const link = boundedEvidenceLink(await this.dependencies.evidenceLink(run));
			return {
				...view,
				detail: {
					aspect,
					content: {
						evaluation: evaluationProjection(run, inventory.corpora),
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
				const proposal = this.candidateProposalProjection(candidate);
				const adoption = inventory.adoptedCandidates.get(candidate.candidateId) ?? null;
				const continuation = inventory.continuedCandidates.get(candidate.candidateId) ?? null;
				content = {
					kind: "candidate",
					...this.candidateView(candidate, inventory.developmentEvals),
					...proposal,
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
				content = { kind: "proposal", ...proposalReview(requireProposal(inventory, ["open", "apply-pending", "discard-pending"]).record) };
				break;
			case "candidate-review":
			case "release-decision": {
				const candidate = requireCandidate(inventory, ["proposed", "built", "validated", "evaluated", "reviewed"]);
				const proposal = this.candidateProposalProjection(candidate);
				content = {
					kind: "candidate",
					...this.candidateView(candidate, inventory.developmentEvals),
					...proposal,
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
			return { kind: input.kind, message: t("message.spec-draft-saved"), artifact: { id: draft.id, snapshotHash: hashValue(draft), status: draft.status }, view: await this.viewOf(settled) };
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
			return { kind: input.kind, message: t("message.corpus-draft-saved"), artifact: { id: result.draft.id, draftHash: hashValue(result.draft), taskCount: result.draft.tasks.length, approvedSpecId: result.draft.approvedSpec.specId }, view: await this.viewOf(settled) };
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
			// A revision written in front of a candidate has exactly one next step,
			// and it is not the one the stage machine's headline suggests.
			const next = deriveWorkbenchView(settled).stage === "candidate-review"
				? ` ${t("submit.revision-at-candidate-review")}`
				: "";
			return { kind: input.kind, message: `New immutable corpus-draft revision saved.${next}`, artifact: { id: result.draft.id, parentDraftId: parent.id, draftHash: hashValue(result.draft), taskCount: result.draft.tasks.length }, view: await this.viewOf(settled) };
		}

		if (input.kind === "workshop-open") {
			return await this.openWorkshop({
				approvedSpecId: input.approvedSpecId,
				workshopId: input.workshopId,
				fromProposalRunId: input.fromProposalRunId,
			});
		}
		if (input.kind === "workshop-close") return await this.closeWorkshopIntoProposal(input, options);
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
		const basis = assertWorkshopStage(deriveWorkbenchView(inventory).stage);
		const construction = basis === "construction";
		if (construction && input.source !== undefined) {
			throw new Error(
				"a construction structured proposal is bound to the approved Spec; do not invent source or failureModeIds",
			);
		}
		if (!construction && input.source === undefined) {
			throw new Error(
				"an improvement structured proposal must name the exact source and failureModeIds it aims at (aspect: \"traces\")",
			);
		}
		const evidence = construction
			? null
			: this.proposalEvidence(inventory, {
				approvedSpecId: input.approvedSpecId,
				source: input.source as NonNullable<typeof input.source>,
				failureModeIds: [...(input.failureModeIds ?? [])],
			});
		const approved = evidence?.approved ?? requireApprovedSpec(inventory, input.approvedSpecId);
		if (!inventory.target) throw new Error("structured proposal authoring requires one exact Target");
		const authoringContext = evidence?.authoringContext ?? this.dependencies.inspectTargetAuthoringContext({
			repositoryDir: this.projectDir,
			expectedTarget: { id: inventory.target.manifest.id, gitSha: inventory.target.gitSha },
		});

		if (canonicalJson(input.authoringContext) !== canonicalJson(authoringContext.claim)) {
			throw new Error("Target authoring context is stale; refresh the Target overview and every replaced resource.");
		}
		assertPredictionScope(input.prediction, {
			failureModeIds: input.failureModeIds ?? [],
			basis: construction ? "construction" : "improvement",
		});
		const proposal = this.dependencies.compileHarnessProposal({
			repositoryDir: this.projectDir,
			expectedBaseTargetSha: authoringContext.target.gitSha,
			intents: input.intents,
			summary: input.summary,
			...(evidence ? { diagnoses: evidence.selectedEvidence.diagnoses } : {}),
			risks: input.risks,
			validationPlan: input.validationPlan,
			prediction: input.prediction ?? null,
		});
		if (proposal.baseTargetSha !== authoringContext.target.gitSha) {
			throw new Error("compiled proposal does not match the inspected Target authoring revision");
		}
		const result = await this.recordCompiledProposal({
			proposal,
			approvedSpecId: approved.id,
			...(input.intents.some((intent) => intent.type === "execution.configure")
				? { manifestChangePolicy: "execution-policy" as const }
				: {}),
			...(evidence ? { sourceEvalRunId: evidence.sourceEvalRunId } : {}),
			proposalBasis: evidence
				? {
					...(input.source as NonNullable<typeof input.source>),
					failureModeIds: [...(input.failureModeIds ?? [])],
				}
				: undefined,
			authoringContext: authoringContext.claim,
			label: "structured proposal",
			...(options.signal ? { signal: options.signal } : {}),
		});
		if (result.record.result.proposal?.decision === "propose") {
			const settled = this.select("proposal", result.record.runId);
			return {
				kind: input.kind,
				message: construction
					? "The approved Spec compiled into an exact reviewable construction proposal, with no evaluation evidence invented."
					: "Selected failure modes compiled into an evidence-linked, exact reviewable proposal.",
				artifact: {
					basis,
					runId: result.record.runId,
					proposalHash: result.record.artifacts.proposal?.sha256 ?? null,
					sourceEvalRunId: result.record.request.source?.evalRunId ?? null,
					improvementBriefId: evidence?.selectedEvidence.basis.briefId ?? null,
					failureModeIds: evidence?.selectedEvidence.basis.failureModes.map((mode) => mode.failureModeId) ?? [],
					approvedSpecId: approved.id,
					authoringContextHash: authoringContext.contextHash,
				},
				view: await this.viewOf(settled),
			};
		}
		return {
			kind: input.kind,
			message: "Structured authoring produced a durable no-change result; there is no diff to review or apply.",
			artifact: {
				basis,
				runId: result.record.runId,
				proposalHash: null,
				decision: "no-change",
				sourceEvalRunId: evidence?.sourceEvalRunId ?? null,
				improvementBriefId: evidence?.selectedEvidence.basis.briefId ?? null,
				failureModeIds: evidence?.selectedEvidence.basis.failureModes.map((mode) => mode.failureModeId) ?? [],
				approvedSpecId: approved.id,
				authoringContextHash: authoringContext.contextHash,
			},
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
		const ctx: DecisionContext = { inventory, stage, gate, options };
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

		if (input.kind === "scaffold-target") return decideScaffoldTarget(this, input, ctx);

		if (input.kind === "wrap-target") return decideWrapTarget(this, input, ctx);

		if (input.kind === "configure-target") return decideConfigureTarget(this, input, ctx);

		if (input.kind === "configure-evaluators") return decideConfigureEvaluators(this, input, ctx);

		if (input.kind === "approve-spec") return decideApproveSpec(this, input, ctx);

		if (input.kind === "abandon-candidate") return decideAbandonCandidate(this, input, ctx);

		if (input.kind === "publish-corpus") return decidePublishCorpus(this, input, ctx);

		if (input.kind === "import-dataset") return decideImportDataset(this, input, ctx);

		if (input.kind === "generate-holdout") return decideGenerateHoldout(this, input, ctx);

		if (input.kind === "run-eval") return decideRunEval(this, input, ctx);

		if (input.kind === "calibrate") return decideCalibrate(this, input, ctx);

		if (input.kind === "regrade") return decideRegrade(this, input, ctx);

		if (input.kind === "apply-proposal") return decideApplyProposal(this, input, ctx);

		if (input.kind === "discard-proposal") return decideDiscardProposal(this, input, ctx);

		if (input.kind === "verify-candidate") return decideVerifyCandidate(this, input, ctx);

		if (input.kind === "improve") return decideImprove(this, input, ctx);

		if (input.kind === "review-candidate") return decideReviewCandidate(this, input, ctx);

		if (input.kind === "promote-candidate") return decidePromoteCandidate(this, input, ctx);

		if (input.kind === "reject-candidate") return decideRejectCandidate(this, input, ctx);

		if (input.kind === "adopt-candidate") return decideAdoptCandidate(this, input, ctx);

		if (input.kind === "continue-cycle") return decideContinueCycle(this, input, ctx);

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
