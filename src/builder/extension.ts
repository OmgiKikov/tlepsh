import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
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
import {
	createBuilderCorpusDraft,
	reviseBuilderCorpusDraft,
} from "../application/builder-corpus-draft.js";
import { importBuilderCorpusDraft } from "../application/builder-corpus-import.js";
import { compileHarnessAuthoringProposal } from "../application/harness-authoring.js";
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
	loadCandidateRecord,
	promoteReviewedCandidate,
	reviewCandidate,
} from "../application/candidate-review.js";
import { targetWithDevelopmentCorpus } from "../application/corpus-target.js";
import {
	applyBuilderProposal,
	loadBuilderApplyReceipt,
	loadBuilderProposalRun,
	type ApplyBuilderProposalOptions,
	type ApplyBuilderProposalResult,
	type PersistedBuilderRun,
} from "../application/builder-proposal.js";
import {
	compileImprovementBrief,
	type ImprovementBrief,
} from "../application/improvement-brief.js";
import { CandidateProposalSchema, type CandidateProposal } from "../builders/adapters.js";
import { listCorpora, loadCorpus, type CorpusMetadata, type CorpusRef } from "../corpus.js";
import { diagnoseEvalRun, type DiagnosisRecord } from "../diagnosis.js";
import {
	isSealedEvalRun,
	listEvalRunIndexes,
	loadEvalRun,
	readEvalRunIndex,
	runSuite,
	type EvalRunRecord,
} from "../eval.js";
import { candidateStatus, type CandidateRecord } from "../domain/candidate.js";
import { loadTarget, scaffoldTarget, TargetManifest, type ResolvedTarget } from "../manifest.js";
import { canonicalJson, hashValue } from "../provenance.js";
import {
	AgentSpecSchema,
	listSpecSnapshots,
	loadSpecSnapshot,
	type AgentSpec,
} from "../spec.js";
import { redactTraceText } from "../trace.js";
import {
	buildProjectStatus,
	readPublicTargetFile,
	resolveBuilderProjectId,
	resolveBuilderTargetId,
	summarizeEvalRun,
	type BuilderProjectContext,
} from "./project-context.js";
import { parse as parseYaml } from "yaml";
import {
	createBuilderWorkbench,
	createBuilderWorkbenchTools,
} from "./workbench-adapter.js";
import { registerAhdeBuilderCommands } from "./commands.js";
import { installAhdeBuilderProductShell } from "./product-shell.js";
import type { BeginBuilderLiveTrace } from "./run-observation.js";

const MAX_LIST_ITEMS = 30;
const MAX_EXACT_DIFF_BYTES = 64 * 1024;
const MAX_CONFIRMATION_SUBJECT_BYTES = 256 * 1024;
const MAX_PROPOSAL_CHANGES = 50;
const MAX_SCAFFOLD_FILES = 200;
const MAX_SCAFFOLD_BYTES = 2 * 1024 * 1024;

type RegisteredAhdeTool = ToolDefinition<TSchema, unknown>;

export interface EvidenceLink {
	url: string;
	label?: string;
}

export interface BuilderExtensionDependencies {
	listSpecs: typeof listSpecSnapshots;
	loadSpec: typeof loadSpecSnapshot;
	saveSpecDraft: typeof saveBuilderSpecDraft;
	describeSpecApproval: typeof describeSpecDraftApproval;
	approveSpecDraft: typeof approveBuilderSpecDraft;
	loadSpecApprovalReceipt: typeof loadSpecApprovalReceipt;
	listCorpora: typeof listCorpora;
	loadCorpus: typeof loadCorpus;
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
	"ahde_workbench_view",
	"ahde_workbench_submit",
	"ahde_workbench_decide",
] as const;

/**
 * Transitional direct adapters kept for application-level regression tests.
 * Builder Pi never registers this compatibility surface.
 */
export const AHDE_BUILDER_COMPATIBILITY_TOOL_NAMES = [
	...AHDE_BUILDER_TOOL_NAMES,
	"ahde_project_status",
	"ahde_target_scaffold",
	"ahde_target_configure_model",
	"ahde_target_read",
	"ahde_spec_list",
	"ahde_spec_get",
	"ahde_spec_save_draft",
	"ahde_spec_approve",
	"ahde_corpus_list",
	"ahde_corpus_publish_development",
	"ahde_eval_list",
	"ahde_eval_get",
	"ahde_eval_run_development",
	"ahde_eval_diagnose",
	"ahde_evidence_link",
	"ahde_proposal_create",
	"ahde_proposal_diff",
	"ahde_proposal_discard",
	"ahde_proposal_apply",
	"ahde_candidate_get",
	"ahde_candidate_verify",
	"ahde_candidate_review",
	"ahde_candidate_promote",
	"ahde_candidate_reject",
] as const;

export const CONSEQUENTIAL_BUILDER_TOOL_NAMES = [
	"ahde_workbench_decide",
] as const;

function textResult(details: unknown): { content: { type: "text"; text: string }[]; details: unknown } {
	return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
}

function abortIfRequested(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason ?? new Error("operation aborted");
}

function requireHostUI(ctx: ExtensionContext, operation: string): void {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		throw new Error(`${operation} requires a local TUI host confirmation; RPC, print, and JSON execution fail closed`);
	}
}

async function confirmHostOperation(ctx: ExtensionContext, title: string, message: string): Promise<void> {
	requireHostUI(ctx, title);
	const confirmed = await ctx.ui.confirm(title, message);
	if (!confirmed) throw new Error(`${title} was declined by the operator`);
}

const EmptyParameters = Type.Object({}, { additionalProperties: false });
const SpecIdParameters = Type.Object({
	specId: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
const EvalRunIdParameters = Type.Object({
	evalRunId: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
const BuilderRunIdParameters = Type.Object({
	runId: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });

const AgentSpecParameters = Type.Object({
	title: Type.String({ minLength: 1, maxLength: 160 }),
	purpose: Type.String({ minLength: 1, maxLength: 4_000 }),
	users: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 50 }),
	jobs: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 50 }),
	inputs: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 50 }),
	allowedActions: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 50 }),
	successCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 50 }),
	constraints: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 50 }),
	openQuestions: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 50 }),
}, { additionalProperties: false });

const TargetModelParameters = Type.Object({
	provider: Type.String({ minLength: 1, maxLength: 100 }),
	id: Type.String({ minLength: 1, maxLength: 300 }),
	api: Type.String({ minLength: 1, maxLength: 100 }),
	baseUrl: Type.String({ minLength: 1, maxLength: 2_000 }),
	apiKeyEnv: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$", maxLength: 200 }),
	thinkingLevel: Type.Union([
		Type.Literal("off"),
		Type.Literal("minimal"),
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
		Type.Literal("xhigh"),
		Type.Literal("max"),
	]),
	timeoutMs: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
	params: Type.Object({}, { additionalProperties: false }),
	spec: Type.Object({
		reasoning: Type.Boolean(),
		contextWindow: Type.Integer({ minimum: 1, maximum: 100_000_000 }),
		maxTokens: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
		cost: Type.Object({
			input: Type.Number({ minimum: 0 }),
			output: Type.Number({ minimum: 0 }),
			cacheRead: Type.Number({ minimum: 0 }),
			cacheWrite: Type.Number({ minimum: 0 }),
		}, { additionalProperties: false }),
		compat: Type.Object({}, { additionalProperties: false }),
	}, { additionalProperties: false }),
}, { additionalProperties: false });

const OptionalGraderName = Type.Optional(Type.String({ minLength: 1, maxLength: 200 }));
const GraderParameters = Type.Union([
	Type.Object({
		type: Type.Literal("tool_called"),
		name: OptionalGraderName,
		tool: Type.String({ minLength: 1, maxLength: 200 }),
		argsContains: Type.Optional(Type.String({ maxLength: 2_000 })),
	}, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("output_contains"),
		name: OptionalGraderName,
		text: Type.String({ minLength: 1, maxLength: 4_000 }),
		caseSensitive: Type.Optional(Type.Boolean()),
	}, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("output_matches"),
		name: OptionalGraderName,
		pattern: Type.String({ minLength: 1, maxLength: 4_000 }),
	}, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("judge"),
		name: OptionalGraderName,
		rubric: Type.String({ minLength: 1, maxLength: 8_000 }),
	}, { additionalProperties: false }),
]);

const DevelopmentCorpusTaskParameters = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
	input: Type.String({ minLength: 1, maxLength: 32_000 }),
	graders: Type.Array(GraderParameters, { minItems: 1, maxItems: 16 }),
}, { additionalProperties: false });

const ProposalDiagnosisParameters = Type.Object({
	failureIds: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 100 }),
	evidence: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 100 }),
	rootCause: Type.String({ minLength: 1, maxLength: 8_000 }),
}, { additionalProperties: false });

const ProposalChangeParameters = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 500 }),
	baseSha256: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
	unifiedDiff: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
	rationale: Type.String({ minLength: 1, maxLength: 8_000 }),
	evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 100 }),
}, { additionalProperties: false });

const AuthoredProposalParameters = Type.Object({
	specDraftId: Type.String({ minLength: 1, maxLength: 200 }),
	sourceEvalRunId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	proposalBasis: Type.Optional(Type.Object({
		algorithmId: Type.Literal("exact-eval-signals-v1"),
		evalRunId: Type.String({ minLength: 1, maxLength: 200 }),
		diagnosisId: Type.String({ minLength: 1, maxLength: 200 }),
		briefId: Type.String({ pattern: "^brief-[0-9a-f]{24}$" }),
		failureModeIds: Type.Array(Type.String({ pattern: "^failure-mode-[0-9a-f]{24}$" }), {
			minItems: 1,
			maxItems: 8,
			uniqueItems: true,
		}),
	}, { additionalProperties: false })),
	decision: Type.Union([Type.Literal("propose"), Type.Literal("no-change")]),
	summary: Type.String({ minLength: 1, maxLength: 8_000 }),
	diagnoses: Type.Array(ProposalDiagnosisParameters, { maxItems: 100 }),
	changes: Type.Array(ProposalChangeParameters, { maxItems: MAX_PROPOSAL_CHANGES }),
	risks: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 100 }),
	validationPlan: Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 100 }),
}, { additionalProperties: false });

const CandidateIdParameters = Type.Object({
	candidateId: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });

interface ReviewableProposal {
	runId: string;
	proposalSha256: string;
	baseTargetSha: string;
	summary: string;
	diagnoses: CandidateProposal["diagnoses"];
	changes: { path: string; baseSha256: string; unifiedDiff: string; rationale: string; evidenceRefs: string[] }[];
	risks: string[];
	validationPlan: string[];
}

function reviewableProposal(record: PersistedBuilderRun): ReviewableProposal {
	if (record.result.status !== "completed" || !record.artifacts.proposal || !record.result.proposal) {
		throw new Error(`builder run ${record.runId} has no completed proposal`);
	}
	if (record.result.proposal.decision !== "propose") {
		throw new Error(`builder run ${record.runId} is a no-change decision and cannot be applied`);
	}
	return {
		runId: record.runId,
		proposalSha256: record.artifacts.proposal.sha256,
		baseTargetSha: record.result.proposal.baseTargetSha,
		summary: record.result.proposal.summary,
		diagnoses: record.result.proposal.diagnoses,
		changes: record.result.proposal.changes.map(({ path, baseSha256, unifiedDiff, rationale, evidenceRefs }) => ({
			path,
			baseSha256,
			unifiedDiff,
			rationale,
			evidenceRefs,
		})),
		risks: record.result.proposal.risks,
		validationPlan: record.result.proposal.validationPlan,
	};
}

function exactDiff(proposal: ReviewableProposal): string {
	return proposal.changes.map((change) => change.unifiedDiff.trimEnd()).join("\n");
}

function exactApprovalMessage(proposal: ReviewableProposal, branch: string, reason: string): string {
	const diff = exactDiff(proposal);
	if (Buffer.byteLength(diff, "utf8") > MAX_EXACT_DIFF_BYTES) {
		throw new Error(
			`proposal diff exceeds the ${MAX_EXACT_DIFF_BYTES}-byte interactive approval limit; split the proposal before applying`,
		);
	}
	return [
		`Operation: apply Builder proposal`,
		`Run: ${proposal.runId}`,
		`Proposal hash: ${proposal.proposalSha256}`,
		`Base target: ${proposal.baseTargetSha}`,
		`Branch: ${branch}`,
		`Paths: ${proposal.changes.map((change) => change.path).join(", ")}`,
		`Summary: ${proposal.summary}`,
		`Risks: ${proposal.risks.join("; ") || "none recorded"}`,
		`Validation: ${proposal.validationPlan.join("; ") || "none recorded"}`,
		`Reason: ${reason}`,
		"",
		"Exact diff:",
		diff,
	].join("\n");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function confirmationSubject(label: string, value: unknown): string {
	const serialized = canonicalJson(value);
	if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIRMATION_SUBJECT_BYTES) {
		throw new Error(`${label} exceeds the ${MAX_CONFIRMATION_SUBJECT_BYTES}-byte interactive review limit; split it first`);
	}
	return serialized;
}

function evalDetails(record: EvalRunRecord): Record<string, unknown> {
	return {
		...summarizeEvalRun(record),
		suiteId: record.suiteId,
		suiteHash: record.suiteHash,
		datasetHash: record.datasetHash,
		provenance: record.provenance,
		provenanceKey: record.provenanceKey,
		baselineEvalRunId: record.baselineEvalRunId,
		runIds: record.runIds.slice(0, MAX_LIST_ITEMS),
		omittedRunIds: Math.max(0, record.runIds.length - MAX_LIST_ITEMS),
	};
}

function diagnosisText(value: string, maxChars = 1_000): string {
	return redactTraceText(value).slice(0, maxChars);
}

function diagnosisDetails(record: DiagnosisRecord): Record<string, unknown> {
	return {
		diagnosisId: record.diagnosisId,
		evalRunId: record.evalRunId,
		targetId: record.targetId,
		targetRevision: record.targetRevision,
		status: record.status,
		inputHash: record.inputHash,
		summary: record.summary,
		issues: record.issues.slice(0, MAX_LIST_ITEMS).map((issue) => ({
			issueId: diagnosisText(issue.issueId, 500),
			taskId: diagnosisText(issue.taskId, 500),
			category: issue.category,
			severity: issue.severity,
			confidence: issue.confidence,
			summary: diagnosisText(issue.summary),
			rootCause: diagnosisText(issue.rootCause),
			suggestions: issue.suggestions.slice(0, 4).map((suggestion) => diagnosisText(suggestion, 500)),
			evidenceRunIds: issue.evidence.map((item) => item.runId).slice(0, 10),
		})),
		omittedIssues: Math.max(0, record.issues.length - MAX_LIST_ITEMS),
	};
}

function boundedEvidenceLink(link: EvidenceLink | null): EvidenceLink | null {
	if (!link) return null;
	let parsed: URL;
	try {
		parsed = new URL(link.url);
	} catch {
		throw new Error("evidence explorer returned an invalid URL");
	}
	if (
		parsed.protocol !== "http:" ||
		!new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsed.hostname) ||
		parsed.username !== "" ||
		parsed.password !== ""
	) {
		throw new Error("evidence explorer links must be unauthenticated loopback HTTP URLs");
	}
	return { url: parsed.toString(), ...(link.label ? { label: link.label.slice(0, 200) } : {}) };
}

function sealedCorpusHashes(
	dependencies: BuilderExtensionDependencies,
	options: BuilderExtensionOptions,
	projectId: string,
): Set<string> {
	try {
		return new Set(dependencies.listCorpora({ stateRoot: options.stateRoot, projectId })
			.filter((corpus) => corpus.visibility === "sealed")
			.map((corpus) => corpus.hash));
	} catch {
		throw new Error("corpus visibility metadata is unavailable; sealed identities remain hidden");
	}
}

function isSealedEval(record: EvalRunRecord, hashes: ReadonlySet<string>): boolean {
	return isSealedEvalRun(record, hashes);
}

function requireDevelopmentEval(
	record: EvalRunRecord,
	dependencies: BuilderExtensionDependencies,
	options: BuilderExtensionOptions,
	projectId: string,
): EvalRunRecord {
	if (isSealedEval(record, sealedCorpusHashes(dependencies, options, projectId))) {
		throw new Error("sealed holdout evidence is not visible to Builder Pi");
	}
	return record;
}

function loadDevelopmentEval(
	evalRunId: string,
	dependencies: BuilderExtensionDependencies,
	options: BuilderExtensionOptions,
	projectId: string,
): EvalRunRecord {
	const hashes = sealedCorpusHashes(dependencies, options, projectId);
	let preflight: EvalRunRecord;
	try {
		preflight = dependencies.readEvalIndex(options.runsRoot, evalRunId);
	} catch {
		throw new Error("evaluation metadata is unavailable; sealed identities remain hidden");
	}
	if (isSealedEval(preflight, hashes)) {
		throw new Error("sealed holdout evidence is not visible to Builder Pi");
	}
	let verified: EvalRunRecord;
	try {
		verified = dependencies.loadEval(options.runsRoot, evalRunId);
	} catch {
		throw new Error("development evaluation evidence failed integrity checks");
	}
	return requireDevelopmentEval(verified, dependencies, options, projectId);
}

function developmentEvalInput(
	dependencies: BuilderExtensionDependencies,
	options: BuilderExtensionOptions,
	projectId: string,
	developmentCorpusId: string | undefined,
	repetitions: number,
): { target: ResolvedTarget; subject: Record<string, unknown> } {
	let target = dependencies.loadTarget(options.projectDir);
	let corpus: { id: string; hash: string; taskCount: number } | null = null;
	if (developmentCorpusId) {
		const receipt = dependencies.loadCorpusPublicationReceipt(options.stateRoot, projectId, developmentCorpusId);
		const loaded = dependencies.loadCorpus({ stateRoot: options.stateRoot, projectId, corpusId: developmentCorpusId });
		if (loaded.metadata.visibility !== "development" || loaded.metadata.hash !== receipt.corpus.hash) {
			throw new Error("development corpus does not match its exact publication receipt");
		}
		target = targetWithDevelopmentCorpus(target, loaded);
		corpus = { id: loaded.metadata.id, hash: loaded.metadata.hash, taskCount: loaded.metadata.taskCount };
	}
	return {
		target,
		subject: {
			schemaVersion: 1,
			operation: "run-development-evaluation",
			projectId,
			target: { id: target.manifest.id, gitSha: target.gitSha, toolsetHash: target.toolsetHash },
			dataset: target.manifest.evalSuite.dataset,
			datasetHash: target.datasetHash,
			suiteHash: target.suiteHash,
			taskCount: target.tasks.length,
			repetitions,
			developmentCorpus: corpus,
		},
	};
}

function listDevelopmentEvals(
	dependencies: BuilderExtensionDependencies,
	options: BuilderExtensionOptions,
	projectId: string,
): EvalRunRecord[] {
	const sealedHashes = sealedCorpusHashes(dependencies, options, projectId);
	const targetId = resolveBuilderTargetId(options);
	try {
		return dependencies.listEvalIndexes(options.runsRoot)
			.filter((record) => targetId === null || record.target.id === targetId)
			.filter((record) => !isSealedEval(record, sealedHashes))
			.map((record) => dependencies.loadEval(options.runsRoot, record.evalRunId));
	} catch {
		throw new Error("evaluation metadata is unavailable; sealed identities remain hidden");
	}
}

function candidatePublicSummary(record: CandidateRecord): Record<string, unknown> {
	const built = record.events.find((event) => event.type === "built");
	const validated = record.events.find((event) => event.type === "validated");
	const evaluated = record.events.find((event) => event.type === "evaluated");
	const reviewed = record.events.find((event) => event.type === "reviewed");
	const promoted = record.events.find((event) => event.type === "promoted");
	const rejected = record.events.find((event) => event.type === "rejected");
	return {
		candidateId: record.candidateId,
		status: candidateStatus(record),
		projectId: record.projectId,
		targetId: record.targetId,
		specId: record.specId,
		proposalId: record.proposalId,
		diagnosisId: record.diagnosisId,
		baseline: record.baseline,
		candidate: built?.type === "built" ? built.candidate : null,
		changedFiles: validated?.type === "validated" ? validated.scope.changedFiles : [],
		development: evaluated?.type === "evaluated" ? {
			baselineEvalRunId: evaluated.evaluation.development.baseline.evalRunId,
			candidateEvalRunId: evaluated.evaluation.development.candidate.evalRunId,
			comparison: evaluated.evaluation.development.comparison?.summary ?? null,
		} : null,
		sealedHoldout: evaluated?.type === "evaluated"
			? { executed: evaluated.evaluation.sealedHoldout !== undefined, gatePassed: evaluated.evaluation.sealedHoldout !== undefined }
			: { executed: false, gatePassed: false },
		review: reviewed?.type === "reviewed" ? reviewed.review : null,
		promotion: promoted?.type === "promoted" ? { tag: promoted.decision.tag, reason: promoted.decision.reason } : null,
		rejection: rejected?.type === "rejected" ? { reason: rejected.decision.reason } : null,
	};
}

async function selectSealedCorpus(
	ctx: ExtensionContext,
	corpora: readonly CorpusMetadata[],
): Promise<CorpusMetadata> {
	requireHostUI(ctx, "Candidate verification");
	const sealed = corpora.filter((corpus) => corpus.visibility === "sealed");
	if (sealed.length === 0) throw new Error("Candidate verification requires an evaluator-owned sealed holdout corpus");
	if (sealed.length === 1) return sealed[0]!;
	const choices = sealed.map((corpus, index) => `Holdout ${index + 1} · ${corpus.name} · ${corpus.taskCount} tasks`);
	const selected = await ctx.ui.select("Select sealed holdout (evaluator-only)", choices);
	if (!selected) throw new Error("sealed holdout selection was cancelled");
	const index = choices.indexOf(selected);
	if (index < 0 || !sealed[index]) throw new Error("sealed holdout selection was invalid");
	return sealed[index];
}

function candidateVerificationInput(
	dependencies: BuilderExtensionDependencies,
	options: BuilderExtensionOptions,
	projectId: string,
	builderRunId: string,
	sealedCorpus: CorpusMetadata,
): {
	subject: Record<string, unknown>;
	approvedSpecId: string;
	developmentCorpus?: CorpusRef;
	sealedCorpus: CorpusRef;
} {
	if (sealedCorpus.visibility !== "sealed") throw new Error("candidate holdout must be sealed");
	const sealedRef: CorpusRef = {
		stateRoot: options.stateRoot,
		projectId,
		corpusId: sealedCorpus.id,
	};
	const loadedSealed = dependencies.loadCorpus(sealedRef);
	if (
		loadedSealed.metadata.visibility !== "sealed" ||
		loadedSealed.metadata.id !== sealedCorpus.id ||
		loadedSealed.metadata.hash !== sealedCorpus.hash
	) {
		throw new Error("selected sealed holdout content does not match its evaluator-owned metadata");
	}
	const builderRun = dependencies.loadProposal(options.runsRoot, builderRunId);
	const applyReceipt = dependencies.loadApplyReceipt(options.runsRoot, builderRunId);
	if (builderRun.request.approvedSpec?.projectId !== projectId) {
		throw new Error("Builder proposal is not bound to this project's approved Spec");
	}
	if (applyReceipt.runId !== builderRun.runId) throw new Error("Builder apply receipt belongs to another proposal");
	const development = builderRun.request.sourceAttestation?.developmentCorpus;
	let developmentCorpus: CorpusRef | undefined;
	if (development) {
		const receipt = dependencies.loadCorpusPublicationReceipt(options.stateRoot, projectId, development.id);
		if (receipt.corpus.hash !== development.hash) {
			throw new Error("Builder source development corpus differs from its publication receipt");
		}
		developmentCorpus = { stateRoot: options.stateRoot, projectId, corpusId: development.id };
	}
	return {
		subject: {
			schemaVersion: 1,
			operation: "verify-applied-candidate",
			builderRunId,
			builderRunHash: hashValue(builderRun),
			applyReceiptHash: hashValue(applyReceipt),
			proposalHash: builderRun.artifacts.proposal?.sha256 ?? null,
			baseTargetSha: applyReceipt.baseTargetSha,
			candidateSha: applyReceipt.candidateSha,
			approvedSpec: builderRun.request.approvedSpec,
			developmentCorpus: development ?? null,
			sealedHoldout: { id: sealedCorpus.id, hash: sealedCorpus.hash, taskCount: sealedCorpus.taskCount },
		},
		approvedSpecId: builderRun.request.approvedSpec.specId,
		developmentCorpus,
		sealedCorpus: sealedRef,
	};
}

async function sealedOperation<T>(ctx: ExtensionContext, operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		try {
			ctx.ui.notify(errorMessage(error), "error");
		} catch {
			// The model-visible error below remains safe even if a test/headless host has no notifier.
		}
		throw new Error("evaluator-only candidate verification failed; inspect the host evidence for details");
	}
}

async function protectedCandidateMutation<T>(
	ctx: ExtensionContext,
	operation: string,
	mutate: () => T | Promise<T>,
): Promise<T> {
	try {
		return await mutate();
	} catch (error) {
		try {
			ctx.ui.notify(errorMessage(error), "error");
		} catch {
			// Preserve the redaction boundary if notification is unavailable.
		}
		throw new Error(`${operation} failed; inspect the trusted host evidence for details`);
	}
}

function candidateDecisionSubject(
	record: CandidateRecord,
	operation: string,
	details: Record<string, unknown>,
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		operation,
		candidateId: record.candidateId,
		candidateRecordHash: hashValue(record),
		candidate: candidatePublicSummary(record),
		...details,
	};
}

interface ScaffoldFile {
	path: string;
	bytes: number;
	sha256: string;
}

interface ScaffoldSubject {
	schemaVersion: 1;
	operation: "initialize-current-directory";
	targetPath: string;
	targetId: string;
	templateFiles: ScaffoldFile[];
	templateHash: string;
	manifest: TargetManifest;
	generated: {
		gitRepository: "fresh repository with one scaffold commit";
		localArtifactIgnores: readonly ["/.ahde/", "/runs/", "/.env", "/.env.*", "!/.env.example"];
	};
}

function templateInventory(templateDirInput: string): ScaffoldFile[] {
	const templateDir = resolve(templateDirInput);
	if (!existsSync(templateDir)) throw new Error(`packaged target template is missing: ${templateDir}`);
	const rootEntry = lstatSync(templateDir);
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
		throw new Error(`packaged target template must be a regular non-symlink directory: ${templateDir}`);
	}
	const files: ScaffoldFile[] = [];
	let totalBytes = 0;
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const absolute = join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`packaged target template contains a symlink: ${relative(templateDir, absolute)}`);
			if (entry.isDirectory()) {
				walk(absolute);
				continue;
			}
			if (!entry.isFile()) throw new Error(`packaged target template contains an unsupported entry: ${relative(templateDir, absolute)}`);
			const path = relative(templateDir, absolute).split(sep).join("/");
			const bytes = statSync(absolute).size;
			totalBytes += bytes;
			files.push({
				path,
				bytes,
				sha256: `sha256:${createHash("sha256").update(readFileSync(absolute)).digest("hex")}`,
			});
			if (files.length > MAX_SCAFFOLD_FILES || totalBytes > MAX_SCAFFOLD_BYTES) {
				throw new Error("packaged target template exceeds the bounded scaffold limit");
			}
		}
	};
	walk(templateDir);
	if (!files.some((file) => file.path === "manifest.yaml")) {
		throw new Error("packaged target template has no manifest.yaml");
	}
	return files;
}

function scaffoldSubject(options: BuilderExtensionOptions): ScaffoldSubject {
	if (!options.templateDir) throw new Error("Builder runtime did not configure a packaged target template");
	const templateFiles = templateInventory(options.templateDir);
	const manifest = TargetManifest.parse(parseYaml(readFileSync(join(resolve(options.templateDir), "manifest.yaml"), "utf8")));
	return {
		schemaVersion: 1,
		operation: "initialize-current-directory",
		targetPath: resolve(options.projectDir),
		targetId: manifest.id,
		templateFiles,
		templateHash: hashValue(templateFiles),
		manifest,
		generated: {
			gitRepository: "fresh repository with one scaffold commit",
			localArtifactIgnores: ["/.ahde/", "/runs/", "/.env", "/.env.*", "!/.env.example"],
		},
	};
}

function assertScaffoldableProject(projectDirInput: string): void {
	const projectDir = resolve(projectDirInput);
	if (!existsSync(projectDir)) throw new Error(`target directory does not exist: ${projectDir}`);
	const root = lstatSync(projectDir);
	if (!root.isDirectory() || root.isSymbolicLink()) {
		throw new Error(`target directory must be a regular non-symlink directory: ${projectDir}`);
	}
	const allowed = new Set([".ahde", "runs"]);
	for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
		if (!allowed.has(entry.name)) {
			throw new Error(`target scaffold requires an otherwise empty current directory; found ${entry.name}`);
		}
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`allowed local scaffold entry must be a regular directory: ${entry.name}`);
		}
	}
}

function materializeScaffold(
	options: BuilderExtensionOptions,
	dependencies: BuilderExtensionDependencies,
	subject: ScaffoldSubject,
): ResolvedTarget {
	if (!options.templateDir) throw new Error("Builder runtime did not configure a packaged target template");
	assertScaffoldableProject(options.projectDir);
	if (!existsSync(options.stateRoot)) mkdirSync(options.stateRoot, { recursive: true, mode: 0o700 });
	const stateEntry = lstatSync(options.stateRoot);
	if (!stateEntry.isDirectory() || stateEntry.isSymbolicLink()) {
		throw new Error("Builder state root must be a regular non-symlink directory for scaffolding");
	}
	const scratch = mkdtempSync(join(resolve(options.stateRoot), "builder-scaffold-"));
	const copiedTemplate = join(scratch, "template");
	const stagedTarget = join(scratch, "target");
	const moved: string[] = [];
	try {
		cpSync(resolve(options.templateDir), copiedTemplate, { recursive: true });
		const copiedInventory = templateInventory(copiedTemplate);
		if (canonicalJson(copiedInventory) !== canonicalJson(subject.templateFiles)) {
			throw new Error("packaged target template changed while it was being staged");
		}
		dependencies.scaffoldTarget(copiedTemplate, stagedTarget);
		assertScaffoldableProject(options.projectDir);
		const entries = readdirSync(stagedTarget).sort((left, right) => {
			if (left === ".git") return 1;
			if (right === ".git") return -1;
			return left.localeCompare(right);
		});
		for (const entry of entries) {
			const destination = join(resolve(options.projectDir), entry);
			if (existsSync(destination)) throw new Error(`scaffold destination unexpectedly exists: ${entry}`);
			renameSync(join(stagedTarget, entry), destination);
			moved.push(entry);
		}
		const target = dependencies.loadTarget(options.projectDir);
		if (target.manifest.id !== subject.targetId) {
			throw new Error(`scaffolded target id mismatch: expected ${subject.targetId}, got ${target.manifest.id}`);
		}
		return target;
	} catch (error) {
		const rollbackFailures: string[] = [];
		for (const entry of [...moved].reverse()) {
			try {
				const destination = join(stagedTarget, entry);
				if (!existsSync(stagedTarget)) mkdirSync(stagedTarget);
				if (existsSync(join(resolve(options.projectDir), entry)) && !existsSync(destination)) {
					renameSync(join(resolve(options.projectDir), entry), destination);
				}
			} catch (rollbackError) {
				rollbackFailures.push(`${entry}: ${errorMessage(rollbackError)}`);
			}
		}
		if (rollbackFailures.length > 0) {
			throw new Error(`target scaffold failed and rollback was incomplete: ${rollbackFailures.join("; ")}`, { cause: error });
		}
		throw error;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function toolRegistry(
	options: BuilderExtensionOptions,
	providedWorkbenchTools?: readonly RegisteredAhdeTool[],
): RegisteredAhdeTool[] {
	const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
	const workbenchTools = providedWorkbenchTools
		?? createBuilderWorkbenchTools(createBuilderWorkbench(options, dependencies), dependencies.actorId, {
			beginLiveTrace: dependencies.beginLiveTrace,
		});
	const projectId = () => resolveBuilderProjectId(options);
	return [
		...workbenchTools,
		defineTool({
			name: "ahde_project_status",
			label: "AHDE project status",
			description: "Inspect bounded Target, Spec, corpus, and eval metadata for the current AHDE project.",
			promptSnippet: "Inspect the current AHDE project without reading private state.",
			parameters: EmptyParameters,
			async execute(_id, _params, signal) {
				abortIfRequested(signal);
				return textResult(buildProjectStatus(options));
			},
		}),
		defineTool({
			name: "ahde_target_scaffold",
			label: "Initialize Target in current directory",
			description: "Request TUI-confirmed initialization of the otherwise empty current directory from the packaged basic-agent template.",
			parameters: Type.Object({
				reason: Type.String({ minLength: 1, maxLength: 1_000 }),
			}, { additionalProperties: false }),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				requireHostUI(ctx, "Target scaffold");
				if (resolveBuilderTargetId(options) !== null) throw new Error("current directory is already an AHDE Target");
				assertScaffoldableProject(options.projectDir);
				const before = scaffoldSubject(options);
				await confirmHostOperation(ctx, "Initialize exact Target scaffold", [
					"Operation: initialize current directory as an AHDE Target",
					`Exact path: ${before.targetPath}`,
					`Target id: ${before.targetId}`,
					`Template hash: ${before.templateHash}`,
					`Files: ${before.templateFiles.map((file) => `${file.path} (${file.sha256})`).join(", ")}`,
					`Generated: ${before.generated.gitRepository}; .gitignore adds ${before.generated.localArtifactIgnores.join(", ")}`,
					`Reason: ${params.reason}`,
					"",
					"Effective packaged manifest (exact bytes are bound by the file hash above):",
					confirmationSubject("target scaffold manifest", before.manifest),
				].join("\n"));
				abortIfRequested(signal);
				if (resolveBuilderTargetId(options) !== null) throw new Error("current directory became a Target after confirmation");
				assertScaffoldableProject(options.projectDir);
				const after = scaffoldSubject(options);
				if (canonicalJson(before) !== canonicalJson(after)) {
					throw new Error("target scaffold subject changed after confirmation; initialization is stale");
				}
				const target = materializeScaffold(options, dependencies, after);
				return textResult({
					initialized: true,
					targetPath: target.dir,
					targetId: target.manifest.id,
					gitSha: target.gitSha,
					files: after.templateFiles.map((file) => file.path),
					next: "Configure the exact Target id and non-secret model definition with ahde_target_configure_model.",
				});
			},
		}),
		defineTool({
			name: "ahde_target_configure_model",
			label: "Configure initial Target model",
			description: "Request one exact TUI-confirmed bootstrap commit for the Target id and complete non-secret model definition. Credential values are never accepted.",
			parameters: Type.Object({
				targetId: Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9][a-z0-9-]*$" }),
				model: TargetModelParameters,
				reason: Type.String({ minLength: 1, maxLength: 4_000 }),
			}, { additionalProperties: false }),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				requireHostUI(ctx, "Target model configuration");
				const request = {
					targetDir: options.projectDir,
					stateRoot: options.stateRoot,
					runsRoot: options.runsRoot,
					targetId: params.targetId,
					model: params.model,
				};
				const before = dependencies.describeTargetBootstrap(request);
				await confirmHostOperation(ctx, "Configure exact initial Target", [
					"Operation: commit one-time Target id and model bootstrap",
					`Target path: ${resolve(options.projectDir)}`,
					`Base Target: ${before.baseTargetSha}`,
					`Subject hash: ${before.subjectHash}`,
					`Credential reference only: ${before.next.model.apiKeyEnv}`,
					`Reason: ${params.reason}`,
					"",
					"Exact manifest diff:",
					before.unifiedDiff,
				].join("\n"));
				abortIfRequested(signal);
				const after = dependencies.describeTargetBootstrap(request);
				if (canonicalJson(before) !== canonicalJson(after)) {
					throw new Error("Target bootstrap subject changed after confirmation; configuration is stale");
				}
				const result = dependencies.configureTargetBootstrap({
					...request,
					expectedSubjectHash: before.subjectHash,
					actor: { kind: "human", id: dependencies.actorId() },
					reason: params.reason,
				});
				return textResult({
					target: {
						id: result.manifest.id,
						gitSha: result.receipt.configuredTargetSha,
						model: result.manifest.model,
						evalSuiteId: result.manifest.evalSuite.id,
					},
					receipt: result.receipt,
					next: `Set ${result.manifest.model.apiKeyEnv} through the trusted host credential path, then define the Spec and development corpus.`,
				});
			},
		}),
		defineTool({
			name: "ahde_target_read",
			label: "Read public Target resource",
			description: "Read one bounded public Target harness file. Private state, runs, eval inputs, .git, and secrets are inaccessible.",
			parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
			async execute(_id, params, signal) {
				abortIfRequested(signal);
				return textResult(readPublicTargetFile(options.projectDir, params.path));
			},
		}),
		defineTool({
			name: "ahde_spec_list",
			label: "List specifications",
			description: "List immutable Spec snapshots for the current project.",
			parameters: EmptyParameters,
			async execute(_id, _params, signal) {
				abortIfRequested(signal);
				const all = dependencies.listSpecs(options.stateRoot, projectId());
				const records = all.slice(0, MAX_LIST_ITEMS);
				return textResult({
					specs: records.map(({ id, status, createdAt, sourceHash, spec }) => ({ id, status, createdAt, sourceHash, title: spec.title })),
					omitted: Math.max(0, all.length - records.length),
				});
			},
		}),
		defineTool({
			name: "ahde_spec_get",
			label: "Get specification",
			description: "Load one immutable Spec snapshot by its exact content-addressed id.",
			parameters: SpecIdParameters,
			async execute(_id, params, signal) {
				abortIfRequested(signal);
				return textResult(dependencies.loadSpec(options.stateRoot, projectId(), params.specId));
			},
		}),
		defineTool({
			name: "ahde_spec_save_draft",
			label: "Save Spec draft",
			description: "Save a typed immutable draft Spec. This does not approve it.",
			parameters: AgentSpecParameters,
			async execute(_id, params, signal) {
				abortIfRequested(signal);
				const spec: AgentSpec = AgentSpecSchema.parse({ schemaVersion: 1, ...params });
				return textResult(dependencies.saveSpecDraft({
					stateRoot: options.stateRoot,
					projectId: projectId(),
					spec,
				}));
			},
		}),
		defineTool({
			name: "ahde_spec_approve",
			label: "Approve Spec",
			description: "Request host-confirmed approval of an exact immutable draft Spec. The model cannot provide authority.",
			parameters: Type.Object({
				specId: Type.String({ minLength: 1, maxLength: 200 }),
				reason: Type.String({ minLength: 1, maxLength: 1_000 }),
			}, { additionalProperties: false }),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				requireHostUI(ctx, "Spec approval");
				const before = dependencies.loadSpec(options.stateRoot, projectId(), params.specId);
				if (before.status !== "draft") throw new Error(`specification ${before.id} is already ${before.status}`);
				const subject = dependencies.describeSpecApproval(options.stateRoot, projectId(), params.specId);
				await confirmHostOperation(ctx, "Approve immutable Spec", [
					`Operation: approve Spec`,
					`Spec id: ${before.id}`,
					`Snapshot hash: ${subject.draftSnapshotHash}`,
					`Spec content hash: ${subject.specContentHash}`,
					`Title: ${before.spec.title}`,
					`Reason: ${params.reason}`,
					"",
					"Exact Spec:",
					confirmationSubject("Spec", before.spec),
				].join("\n"));
				abortIfRequested(signal);
				const reloaded = dependencies.describeSpecApproval(options.stateRoot, projectId(), params.specId);
				if (canonicalJson(reloaded) !== canonicalJson(subject)) {
					throw new Error("Spec subject changed after confirmation; approval is stale");
				}
				const result = dependencies.approveSpecDraft({
					stateRoot: options.stateRoot,
					projectId: projectId(),
					draftSpecId: params.specId,
					expectedDraftSnapshotHash: subject.draftSnapshotHash,
					actor: { kind: "human", id: dependencies.actorId() },
					reason: params.reason,
				});
				return textResult({
					approved: result.approved,
					receipt: result.receipt,
				});
			},
		}),
		defineTool({
			name: "ahde_corpus_list",
			label: "List corpus metadata",
			description: "List development and sealed corpus metadata. Sealed task content is never exposed.",
			parameters: EmptyParameters,
			async execute(_id, _params, signal) {
				abortIfRequested(signal);
				let records: CorpusMetadata[];
				try {
					records = dependencies.listCorpora({ stateRoot: options.stateRoot, projectId: projectId() });
				} catch {
					throw new Error("corpus metadata is unavailable; sealed identities remain hidden");
				}
				const development = records.filter((record) => record.visibility === "development");
				return textResult({
					development: development.slice(0, MAX_LIST_ITEMS),
					omittedDevelopment: Math.max(0, development.length - MAX_LIST_ITEMS),
					sealed: { visibility: "sealed", count: records.length - development.length },
				});
			},
		}),
		defineTool({
			name: "ahde_corpus_publish_development",
			label: "Publish development corpus",
			description: "Request TUI-confirmed publication of an exact bounded development corpus. This tool cannot create sealed data.",
			parameters: Type.Object({
				name: Type.String({ minLength: 1, maxLength: 200 }),
				tasks: Type.Array(DevelopmentCorpusTaskParameters, { minItems: 1, maxItems: 100 }),
				reason: Type.String({ minLength: 1, maxLength: 4_000 }),
			}, { additionalProperties: false }),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				requireHostUI(ctx, "Development corpus publication");
				const before = dependencies.describeCorpusPublication({
					projectId: projectId(),
					name: params.name,
					tasks: params.tasks,
				});
				const exactTasks = confirmationSubject("development corpus", params.tasks);
				await confirmHostOperation(ctx, "Publish exact development corpus", [
					"Operation: publish development corpus",
					`Name: ${before.name}`,
					`Task count: ${before.taskCount}`,
					`Content hash: ${before.contentHash}`,
					`Subject hash: ${before.subjectHash}`,
					`Reason: ${params.reason}`,
					"",
					"Exact tasks and graders:",
					exactTasks,
				].join("\n"));
				abortIfRequested(signal);
				const after = dependencies.describeCorpusPublication({
					projectId: projectId(),
					name: params.name,
					tasks: params.tasks,
				});
				if (canonicalJson(before) !== canonicalJson(after)) {
					throw new Error("development corpus changed after confirmation; publication is stale");
				}
				const result = dependencies.publishDevelopmentCorpus({
					stateRoot: options.stateRoot,
					projectId: projectId(),
					name: params.name,
					tasks: params.tasks,
					expectedSubjectHash: before.subjectHash,
					actor: { kind: "human", id: dependencies.actorId() },
					reason: params.reason,
				});
				return textResult({ corpus: result.corpus, receipt: result.receipt });
			},
		}),
		defineTool({
			name: "ahde_eval_list",
			label: "List evaluation runs",
			description: "List bounded evaluation summaries for the current Target.",
			parameters: EmptyParameters,
			async execute(_id, _params, signal) {
				abortIfRequested(signal);
				const all = listDevelopmentEvals(dependencies, options, projectId());
				const records = all.slice(0, MAX_LIST_ITEMS);
				return textResult({ evalRuns: records.map(summarizeEvalRun), omitted: Math.max(0, all.length - records.length) });
			},
		}),
		defineTool({
			name: "ahde_eval_get",
			label: "Get evaluation summary",
			description: "Get one verified evaluation summary and provenance without injecting raw traces into chat.",
			parameters: EvalRunIdParameters,
			async execute(_id, params, signal) {
				abortIfRequested(signal);
				const record = loadDevelopmentEval(params.evalRunId, dependencies, options, projectId());
				return textResult(evalDetails(record));
			},
		}),
		defineTool({
			name: "ahde_eval_run_development",
			label: "Run development evaluation",
			description: "Request a TUI-confirmed development-only evaluation, deterministic diagnosis, and optional evidence link.",
			parameters: Type.Object({
				developmentCorpusId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
				repetitions: Type.Integer({ minimum: 1, maximum: 10 }),
				reason: Type.String({ minLength: 1, maxLength: 1_000 }),
			}, { additionalProperties: false }),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				requireHostUI(ctx, "Development evaluation");
				const before = developmentEvalInput(
					dependencies,
					options,
					projectId(),
					params.developmentCorpusId,
					params.repetitions,
				);
				await confirmHostOperation(ctx, "Run exact development evaluation", [
					"Operation: run development evaluation and diagnosis",
					`Reason: ${params.reason}`,
					"",
					"Exact evaluation subject:",
					confirmationSubject("development evaluation", before.subject),
				].join("\n"));
				abortIfRequested(signal);
				const after = developmentEvalInput(
					dependencies,
					options,
					projectId(),
					params.developmentCorpusId,
					params.repetitions,
				);
				if (canonicalJson(before.subject) !== canonicalJson(after.subject)) {
					throw new Error("development evaluation subject changed after confirmation; run is stale");
				}
				const record = requireDevelopmentEval(
					await dependencies.runSuite(after.target, {
						runsRoot: options.runsRoot,
						label: "solo",
						repetitions: params.repetitions,
					}),
					dependencies,
					options,
					projectId(),
				);
				abortIfRequested(signal);
				const diagnosis = dependencies.diagnoseEval(options.runsRoot, record.evalRunId);
				const improvementBrief = dependencies.compileImprovementBrief(options.runsRoot, diagnosis);
				const link = boundedEvidenceLink(await dependencies.evidenceLink(record));
				return textResult({
					evaluation: evalDetails(record),
					diagnosis: diagnosisDetails(diagnosis),
					improvementBrief,
					evidence: link ? { available: true, ...link } : { available: false },
				});
			},
		}),
		defineTool({
			name: "ahde_eval_diagnose",
			label: "Diagnose evaluation",
			description: "Build or load a deterministic bounded diagnosis for a verified evaluation run.",
			parameters: EvalRunIdParameters,
			async execute(_id, params, signal) {
				abortIfRequested(signal);
				loadDevelopmentEval(params.evalRunId, dependencies, options, projectId());
				const diagnosis = dependencies.diagnoseEval(options.runsRoot, params.evalRunId);
				return textResult({
					...diagnosisDetails(diagnosis),
					improvementBrief: dependencies.compileImprovementBrief(options.runsRoot, diagnosis),
				});
			},
		}),
		defineTool({
			name: "ahde_evidence_link",
			label: "Open evidence",
			description: "Resolve a read-only evidence explorer link for an evaluation run when the host provides one.",
			parameters: EvalRunIdParameters,
			async execute(_id, params, signal) {
				abortIfRequested(signal);
				const record = loadDevelopmentEval(params.evalRunId, dependencies, options, projectId());
				const link = boundedEvidenceLink(await dependencies.evidenceLink(record));
				return textResult(link
					? { available: true, ...link, evalRunId: record.evalRunId }
					: { available: false, evalRunId: record.evalRunId, reason: "read-only evidence explorer is not configured" });
			},
		}),
		defineTool({
			name: "ahde_proposal_create",
			label: "Create typed proposal",
			description: "Record a bounded typed proposal against the exact approved Spec, current Target revision, and optional development evidence.",
			parameters: AuthoredProposalParameters,
			async execute(_id, params, signal) {
				abortIfRequested(signal);
				if (Buffer.byteLength(canonicalJson(params), "utf8") > MAX_CONFIRMATION_SUBJECT_BYTES) {
					throw new Error("authored proposal exceeds the bounded Builder input limit; split the change");
				}
				const combinedDiff = params.changes.map((change) => change.unifiedDiff.trimEnd()).join("\n");
				if (Buffer.byteLength(combinedDiff, "utf8") > MAX_EXACT_DIFF_BYTES) {
					throw new Error("authored proposal diff exceeds the exact review limit; split the proposal before recording it");
				}
				const currentProjectId = projectId();
				const approval = dependencies.loadSpecApprovalReceipt(
					options.stateRoot,
					currentProjectId,
					params.specDraftId,
				);
				const target = dependencies.loadTarget(options.projectDir);
				if (params.sourceEvalRunId) {
					loadDevelopmentEval(params.sourceEvalRunId, dependencies, options, currentProjectId);
				}
				const proposal: CandidateProposal = CandidateProposalSchema.parse({
					schemaVersion: 1,
					decision: params.decision,
					baseTargetSha: target.gitSha,
					summary: params.summary,
					diagnoses: params.diagnoses,
					changes: params.changes,
					risks: params.risks,
					validationPlan: params.validationPlan,
				});
				const result = await dependencies.recordProposal({
					proposal,
					targetDir: options.projectDir,
					allowedPaths: [...CANDIDATE_SCOPE_POLICY.allowed],
					approvedSpec: {
						stateRoot: options.stateRoot,
						projectId: currentProjectId,
						specId: approval.approvedSpec.specId,
					},
					runsRoot: options.runsRoot,
					timeoutMs: 30_000,
					...(params.sourceEvalRunId ? { sourceEvalRunId: params.sourceEvalRunId } : {}),
					...(params.proposalBasis ? { proposalBasis: params.proposalBasis } : {}),
					signal,
				});
				return textResult({
					runId: result.record.runId,
					status: result.record.result.status,
					decision: result.record.result.proposal?.decision ?? null,
					proposalHash: result.record.artifacts.proposal?.sha256 ?? null,
					baseTargetSha: result.record.request.baseTargetSha,
					sourceEvalRunId: result.record.request.source?.evalRunId ?? null,
					approvedSpecId: result.record.request.approvedSpec?.specId ?? null,
				});
			},
		}),
		defineTool({
			name: "ahde_proposal_diff",
			label: "Inspect proposal diff",
			description: "Load the immutable typed Builder proposal and inspect its exact diff before applying it.",
			parameters: BuilderRunIdParameters,
			async execute(_id, params, signal) {
				abortIfRequested(signal);
				const proposal = reviewableProposal(dependencies.loadProposal(options.runsRoot, params.runId));
				const diff = exactDiff(proposal);
				const metadata = {
					...proposal,
					changes: proposal.changes.map(({ unifiedDiff: _diff, ...change }) => change),
				};
				return textResult(Buffer.byteLength(diff, "utf8") <= MAX_EXACT_DIFF_BYTES
					? { ...metadata, exactDiff: diff }
					: { ...metadata, exactDiff: null, error: "diff exceeds bounded model context; split the proposal" });
			},
		}),
		defineTool({
			name: "ahde_proposal_discard",
			label: "Discard proposal",
			description: "Request exact TUI-confirmed durable discard of an unapplied Builder proposal.",
			parameters: Type.Object({
				runId: Type.String({ minLength: 1, maxLength: 200 }),
				reason: Type.String({ minLength: 1, maxLength: 4_000 }),
			}, { additionalProperties: false }),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				requireHostUI(ctx, "Proposal discard");
				const before = dependencies.describeProposalDiscard(options.runsRoot, params.runId);
				await confirmHostOperation(ctx, "Discard exact Builder proposal", [
					"Operation: permanently discard Builder proposal",
					`Run: ${before.subject.runId}`,
					`Proposal hash: ${before.subject.proposalSha256}`,
					`Subject hash: ${before.subjectHash}`,
					`Base Target: ${before.subject.baseTargetSha}`,
					`Paths: ${before.subject.paths.join(", ")}`,
					`Summary: ${before.subject.summary}`,
					`Reason: ${params.reason}`,
				].join("\n"));
				abortIfRequested(signal);
				const after = dependencies.describeProposalDiscard(options.runsRoot, params.runId);
				if (canonicalJson(before) !== canonicalJson(after)) {
					throw new Error("proposal discard subject changed after confirmation; decision is stale");
				}
				const result = dependencies.discardProposal({
					runsRoot: options.runsRoot,
					runId: params.runId,
					actor: { kind: "human", id: dependencies.actorId() },
					reason: params.reason,
					expectedSubjectHash: before.subjectHash,
				});
				return textResult({ receipt: result.receipt });
			},
		}),
		defineTool({
			name: "ahde_proposal_apply",
			label: "Apply proposal",
			description: "Request host-confirmed application of an exact proposal into a candidate branch. No actor or approval field is accepted.",
			parameters: Type.Object({
				runId: Type.String({ minLength: 1, maxLength: 200 }),
				branch: Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]*$" }),
				reason: Type.String({ minLength: 1, maxLength: 1_000 }),
			}, { additionalProperties: false }),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				requireHostUI(ctx, "Proposal application");
				const before = reviewableProposal(dependencies.loadProposal(options.runsRoot, params.runId));
				await confirmHostOperation(ctx, "Apply exact Builder proposal", exactApprovalMessage(before, params.branch, params.reason));
				abortIfRequested(signal);
				const after = reviewableProposal(dependencies.loadProposal(options.runsRoot, params.runId));
				if (canonicalJson(before) !== canonicalJson(after)) {
					throw new Error("proposal changed after confirmation; approval is stale");
				}
				const result = dependencies.applyProposal({
					repoDir: options.projectDir,
					runsRoot: options.runsRoot,
					runId: params.runId,
					requestedBranch: params.branch,
					actor: { kind: "human", id: dependencies.actorId() },
					reason: params.reason,
				});
				return textResult({ receipt: result.receipt });
			},
		}),
		defineTool({
			name: "ahde_candidate_get",
			label: "Inspect candidate",
			description: "Inspect a bounded Candidate lifecycle summary. Sealed corpus and eval identities remain evaluator-only.",
			parameters: CandidateIdParameters,
			async execute(_id, params, signal) {
				abortIfRequested(signal);
				return textResult(candidatePublicSummary(dependencies.loadCandidate(options.runsRoot, params.candidateId)));
			},
		}),
		defineTool({
			name: "ahde_candidate_verify",
			label: "Verify applied candidate",
			description: "Request TUI-confirmed canonical candidate evaluation on development evidence plus an evaluator-owned sealed holdout.",
			parameters: Type.Object({
				builderRunId: Type.String({ minLength: 1, maxLength: 200 }),
				repetitions: Type.Integer({ minimum: 1, maximum: 10 }),
				reason: Type.String({ minLength: 1, maxLength: 1_000 }),
			}, { additionalProperties: false }),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				requireHostUI(ctx, "Candidate verification");
				const currentProjectId = projectId();
				const selected = await sealedOperation(ctx, async () => selectSealedCorpus(
					ctx,
					dependencies.listCorpora({ stateRoot: options.stateRoot, projectId: currentProjectId }),
				));
				const before = await sealedOperation(ctx, async () => candidateVerificationInput(
					dependencies,
					options,
					currentProjectId,
					params.builderRunId,
					selected,
				));
				const exactSubject = { ...before.subject, repetitions: params.repetitions, reason: params.reason };
				await confirmHostOperation(ctx, "Verify exact applied candidate", [
					"Operation: evaluate applied candidate on development plus evaluator-only sealed evidence",
					"The sealed identity below is shown only by the trusted host and will not be returned to Builder Pi.",
					"",
					confirmationSubject("candidate verification", exactSubject),
				].join("\n"));
				abortIfRequested(signal);
				const after = await sealedOperation(ctx, async () => {
					const reloaded = dependencies.listCorpora({ stateRoot: options.stateRoot, projectId: currentProjectId })
						.find((corpus) => corpus.visibility === "sealed" && corpus.id === selected.id);
					if (!reloaded || reloaded.hash !== selected.hash) {
						throw new Error("selected sealed holdout changed after confirmation");
					}
					return candidateVerificationInput(
						dependencies,
						options,
						currentProjectId,
						params.builderRunId,
						reloaded,
					);
				});
				if (canonicalJson(before.subject) !== canonicalJson(after.subject)) {
					throw new Error("candidate verification subject changed after confirmation; run is stale");
				}
				const result = await sealedOperation(ctx, () => dependencies.runAppliedCandidate({
					repositoryDir: options.projectDir,
					runsRoot: options.runsRoot,
					builderRunId: params.builderRunId,
					projectId: currentProjectId,
					approvedSpec: { stateRoot: options.stateRoot, specId: after.approvedSpecId },
					repetitions: params.repetitions,
					...(after.developmentCorpus ? { developmentCorpus: after.developmentCorpus } : {}),
					sealedCorpus: after.sealedCorpus,
					actorId: dependencies.actorId(),
				}));
				abortIfRequested(signal);
				return textResult({
					candidate: candidatePublicSummary(result.record),
					sealedHoldout: {
						executed: result.sealedHoldout !== null,
						gatePassed: result.sealedHoldout !== null,
					},
				});
			},
		}),
		defineTool({
			name: "ahde_candidate_review",
			label: "Review candidate",
			description: "Append an exact TUI-confirmed human recommendation to an evaluated Candidate.",
			parameters: Type.Object({
				candidateId: Type.String({ minLength: 1, maxLength: 200 }),
				recommendation: Type.Union([Type.Literal("promote"), Type.Literal("reject")]),
				reason: Type.String({ minLength: 1, maxLength: 4_000 }),
			}, { additionalProperties: false }),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				requireHostUI(ctx, "Candidate review");
				const before = dependencies.loadCandidate(options.runsRoot, params.candidateId);
				const subject = candidateDecisionSubject(before, "review-candidate", {
					recommendation: params.recommendation,
					reason: params.reason,
				});
				await confirmHostOperation(ctx, "Record exact candidate review", confirmationSubject("candidate review", subject));
				abortIfRequested(signal);
				const after = dependencies.loadCandidate(options.runsRoot, params.candidateId);
				if (canonicalJson(subject) !== canonicalJson(candidateDecisionSubject(after, "review-candidate", {
					recommendation: params.recommendation,
					reason: params.reason,
				}))) throw new Error("candidate changed after confirmation; review is stale");
				const reviewed = await protectedCandidateMutation(ctx, "candidate review", () => dependencies.reviewCandidate({
					runsRoot: options.runsRoot,
					candidateId: params.candidateId,
					recommendation: params.recommendation,
					reason: params.reason,
					actorId: dependencies.actorId(),
				}));
				return textResult(candidatePublicSummary(reviewed));
			},
		}),
		defineTool({
			name: "ahde_candidate_promote",
			label: "Promote candidate",
			description: "Request exact TUI-confirmed promotion of a reviewed Candidate to an immutable semantic version tag.",
			parameters: Type.Object({
				candidateId: Type.String({ minLength: 1, maxLength: 200 }),
				version: Type.String({ pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$", maxLength: 50 }),
				reason: Type.String({ minLength: 1, maxLength: 4_000 }),
			}, { additionalProperties: false }),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				requireHostUI(ctx, "Candidate promotion");
				const before = dependencies.loadCandidate(options.runsRoot, params.candidateId);
				const subject = candidateDecisionSubject(before, "promote-candidate", {
					version: params.version,
					tag: `v${params.version}`,
					reason: params.reason,
				});
				await confirmHostOperation(ctx, "Promote exact candidate", confirmationSubject("candidate promotion", subject));
				abortIfRequested(signal);
				const after = dependencies.loadCandidate(options.runsRoot, params.candidateId);
				if (canonicalJson(subject) !== canonicalJson(candidateDecisionSubject(after, "promote-candidate", {
					version: params.version,
					tag: `v${params.version}`,
					reason: params.reason,
				}))) throw new Error("candidate changed after confirmation; promotion is stale");
				const promoted = await protectedCandidateMutation(ctx, "candidate promotion", () => dependencies.promoteCandidate({
					repositoryDir: options.projectDir,
					runsRoot: options.runsRoot,
					candidateId: params.candidateId,
					version: params.version,
					reason: params.reason,
					actorId: dependencies.actorId(),
				}));
				return textResult({
					candidate: candidatePublicSummary(promoted.record),
					tag: promoted.tag,
					candidateSha: promoted.candidateSha,
				});
			},
		}),
		defineTool({
			name: "ahde_candidate_reject",
			label: "Reject candidate",
			description: "Append an exact TUI-confirmed human rejection decision to a reviewed Candidate.",
			parameters: Type.Object({
				candidateId: Type.String({ minLength: 1, maxLength: 200 }),
				reason: Type.String({ minLength: 1, maxLength: 4_000 }),
			}, { additionalProperties: false }),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				requireHostUI(ctx, "Candidate rejection");
				const before = dependencies.loadCandidate(options.runsRoot, params.candidateId);
				const subject = candidateDecisionSubject(before, "reject-candidate", { reason: params.reason });
				await confirmHostOperation(ctx, "Reject exact candidate", confirmationSubject("candidate rejection", subject));
				abortIfRequested(signal);
				const after = dependencies.loadCandidate(options.runsRoot, params.candidateId);
				if (canonicalJson(subject) !== canonicalJson(candidateDecisionSubject(after, "reject-candidate", {
					reason: params.reason,
				}))) throw new Error("candidate changed after confirmation; rejection is stale");
				const rejected = await protectedCandidateMutation(ctx, "candidate rejection", () => dependencies.rejectCandidate({
					runsRoot: options.runsRoot,
					candidateId: params.candidateId,
					reason: params.reason,
					actorId: dependencies.actorId(),
				}));
				return textResult(candidatePublicSummary(rejected));
			},
		}),
	];
}

/** The sole trusted extension factory loaded into Builder Pi. */
export function createAhdeBuilderExtension(options: BuilderExtensionOptions): ExtensionFactory {
	const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
	const workbench = createBuilderWorkbench(options, dependencies);
	const workbenchTools = createBuilderWorkbenchTools(workbench, dependencies.actorId, {
		beginLiveTrace: dependencies.beginLiveTrace,
	});
	const tools = workbenchTools;
	const allowedTools = new Set(tools.map((tool) => tool.name));
	return (pi: ExtensionAPI) => {
		pi.on("user_bash", () => ({
			result: {
				output: "AHDE Builder disables interactive shell execution; use a bounded ahde_* tool.\n",
				exitCode: 126,
				cancelled: false,
				truncated: false,
			},
		}));
		pi.on("tool_call", (event) => allowedTools.has(event.toolName)
			? undefined
			: { block: true, reason: `AHDE Builder tool is not allowed: ${event.toolName}`, terminate: true });
		for (const tool of tools) pi.registerTool(tool);
		installAhdeBuilderProductShell(pi, workbench);
		registerAhdeBuilderCommands(pi, {
			workbench,
			actorId: dependencies.actorId,
			beginLiveTrace: dependencies.beginLiveTrace,
		});
	};
}

/** Exposed for registry-level tests and future dependency composition. */
export function createAhdeBuilderTools(options: BuilderExtensionOptions): readonly RegisteredAhdeTool[] {
	const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
	return createBuilderWorkbenchTools(
		createBuilderWorkbench(options, dependencies),
		dependencies.actorId,
		{ beginLiveTrace: dependencies.beginLiveTrace },
	);
}

/** @internal Direct legacy adapters; deliberately absent from the Pi registry. */
export function createAhdeBuilderCompatibilityTools(options: BuilderExtensionOptions): readonly RegisteredAhdeTool[] {
	return toolRegistry(options);
}
