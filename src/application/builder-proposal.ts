import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import {
	BuilderCapabilitiesSchema,
	BuilderProbeSchema,
	BuilderRunRecordSchema,
	CandidateProposalSchema,
	MAX_RAW_EVENT_BYTES,
	validateCandidateProposal,
	type BuilderAdapter,
	type BuilderCapabilities,
	type BuilderError,
	type BuilderProbe,
	type BuilderRunRecord,
	type CandidateProposal,
} from "../builders/adapters.js";
import { compileFailureBundle } from "../bundle.js";
import { listCorpora } from "../corpus.js";
import { DiagnosisRecordSchema, diagnoseEvalRun } from "../diagnosis.js";
import { isSealedEvalRun, loadVerifiedEvalRun, readEvalRunIndex } from "../eval.js";
import { loadTarget, TargetManifest, type TargetManifest as TargetManifestValue } from "../manifest.js";
import { canonicalJson, hashValue } from "../provenance.js";
import {
	AgentSpecSchema,
	ApprovedSpecReferenceSchema,
	loadApprovedSpec,
	type ApprovedSpecInput,
} from "../spec.js";
import { readJsonArtifact, writeJsonArtifact, writeTextArtifact } from "../storage/artifacts.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";
import { resolveDevelopmentTargetForEval } from "./corpus-target.js";
import {
	ProposalBasisAttestationSchema,
	ProposalBasisSelectionSchema,
	compileImprovementBrief,
	deriveEvidenceLinkedProposalSelection,
	type EvidenceLinkedProposalDiagnosis,
	type EvidenceLinkedProposalSelection,
	type ProposalBasisAttestation,
	type ProposalBasisSelection,
} from "./improvement-brief.js";
import { withDetachedWorktree } from "../git/experiment-worktree.js";

const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ZERO_SHA = "0".repeat(40);
const MAX_PROPOSAL_BYTES = 4 * 1024 * 1024;
const MAX_RUN_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_BUILDER_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_OPERATOR_GUIDANCE_BYTES = 16 * 1024;
const TEMP_PREFIX = "ahde-builder-apply-";
const MAX_PROPOSAL_ADMISSIONS = 10_000;

const NonBlankSchema = z.string().min(1).refine((value) => value.trim().length > 0, "expected non-blank text");
const OperatorGuidanceSchema = NonBlankSchema.refine(
	(value) => Buffer.byteLength(value, "utf8") <= MAX_OPERATOR_GUIDANCE_BYTES,
	`operator guidance must not exceed ${MAX_OPERATOR_GUIDANCE_BYTES} UTF-8 bytes`,
);
const GitShaSchema = z.string().regex(GIT_SHA, "expected an exact 40-character Git SHA");
const Sha256Schema = z.string().regex(SHA256, "expected sha256:<64 lowercase hex>");
const RunIdSchema = z.string().regex(RUN_ID, "invalid builder run id");
const ProjectIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const TimestampSchema = z.iso.datetime({ offset: true });
const MAX_PROPOSAL_ADMISSION_BYTES = 64 * 1024;

function isSafeRepositoryPath(value: string): boolean {
	return value === value.trim() &&
		!value.startsWith("/") &&
		!value.includes("\\") &&
		!/[\0\r\n]/.test(value) &&
		!value.split("/").some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git");
}

const AllowedPathSchema = z.string().min(1).refine((value) => {
	if (value.endsWith("/**")) {
		const directory = value.slice(0, -3);
		return Boolean(directory) && !directory.includes("*") && isSafeRepositoryPath(directory);
	}
	return !value.includes("*") && isSafeRepositoryPath(value);
}, "expected an exact repository path or normalized directory/** scope");

const ArtifactRefSchema = z.strictObject({
	path: z.string().min(1),
	sha256: Sha256Schema,
	bytes: z.number().int().nonnegative(),
});

const SourceEvidenceSchema = z.strictObject({
	evalRunId: RunIdSchema,
	diagnosisId: RunIdSchema,
});

const EvidenceLinkedProposalDiagnosisSchema = z.strictObject({
	failureIds: z.array(NonBlankSchema).min(1).max(8),
	evidence: z.array(NonBlankSchema).min(1).max(100),
	rootCause: NonBlankSchema,
});

export const CanonicalBuilderSourceSchema = z.strictObject({
	evalRunId: RunIdSchema,
	diagnosisId: RunIdSchema,
	targetId: NonBlankSchema,
	targetGitSha: GitShaSchema,
	evalRunSha256: Sha256Schema,
	diagnosisSha256: Sha256Schema,
	dataset: NonBlankSchema,
	datasetHash: Sha256Schema,
	suiteHash: Sha256Schema,
	developmentCorpus: z.strictObject({
		id: NonBlankSchema,
		hash: Sha256Schema,
	}).nullable(),
});
export type CanonicalBuilderSource = z.infer<typeof CanonicalBuilderSourceSchema>;

/** The exact typed value serialized and sent to a Builder for canonical runs. */
export const ApprovedSpecBuilderInputSchema = z.strictObject({
	schemaVersion: z.literal(1),
	approvedSpec: z.strictObject({
		reference: ApprovedSpecReferenceSchema,
		spec: AgentSpecSchema,
	}),
	/** Untrusted human-authored data; it is evidence, never an instruction channel. */
	operatorGuidance: OperatorGuidanceSchema.nullable().default(null),
	evaluationEvidence: z.strictObject({
		source: SourceEvidenceSchema.nullable(),
		sourceAttestation: CanonicalBuilderSourceSchema.nullable().default(null),
		proposalBasis: ProposalBasisAttestationSchema.nullable().default(null),
		proposalDiagnoses: z.array(EvidenceLinkedProposalDiagnosisSchema).min(1).max(8).nullable().default(null),
		failureBundle: NonBlankSchema,
	}).nullable(),
}).superRefine((input, context) => {
	if (hashValue(input.approvedSpec.spec) !== input.approvedSpec.reference.specContentHash) {
		context.addIssue({
			code: "custom",
			path: ["approvedSpec", "reference", "specContentHash"],
			message: "Spec content does not match its exact reference",
		});
	}
	const evidence = input.evaluationEvidence;
	if (evidence?.sourceAttestation && (
		evidence.source === null ||
		evidence.source.evalRunId !== evidence.sourceAttestation.evalRunId ||
		evidence.source.diagnosisId !== evidence.sourceAttestation.diagnosisId
	)) {
		context.addIssue({
			code: "custom",
			path: ["evaluationEvidence", "sourceAttestation"],
			message: "canonical source attestation must match the embedded source ids",
		});
	}
	if (evidence?.proposalBasis && (
		evidence.sourceAttestation === null ||
		evidence.proposalBasis.evalRunId !== evidence.sourceAttestation.evalRunId ||
		evidence.proposalBasis.diagnosisId !== evidence.sourceAttestation.diagnosisId
	)) {
		context.addIssue({
			code: "custom",
			path: ["evaluationEvidence", "proposalBasis"],
			message: "proposal basis must match the canonical source attestation",
		});
	}
	if ((evidence?.proposalBasis === null) !== (evidence?.proposalDiagnoses === null)) {
		context.addIssue({
			code: "custom",
			path: ["evaluationEvidence", "proposalDiagnoses"],
			message: "proposal basis and host-derived diagnoses must be present together",
		});
	}
});
export type ApprovedSpecBuilderInput = z.infer<typeof ApprovedSpecBuilderInputSchema>;

const BuilderRequestEvidenceSchema = z.strictObject({
	baseTargetSha: GitShaSchema,
	allowedPaths: z.array(AllowedPathSchema).min(1).refine((paths) => new Set(paths).size === paths.length, "allowed paths must be unique"),
	approvedSpec: ApprovedSpecReferenceSchema.nullable(),
	source: SourceEvidenceSchema.nullable(),
	provenanceMode: z.enum(["canonical", "unverified"]).default("unverified"),
	sourceAttestation: CanonicalBuilderSourceSchema.nullable().default(null),
	proposalBasis: ProposalBasisAttestationSchema.nullable().default(null),
	proposalDiagnoses: z.array(EvidenceLinkedProposalDiagnosisSchema).min(1).max(8).nullable().default(null),
	failureBundleSha256: Sha256Schema.nullable(),
	failureBundleBytes: z.number().int().nonnegative(),
	builderInputSha256: Sha256Schema,
	builderInputBytes: z.number().int().positive(),
	timeoutMs: z.number().int().positive().max(2_147_483_647),
}).superRefine((request, context) => {
	if ((request.failureBundleSha256 === null) !== (request.failureBundleBytes === 0)) {
		context.addIssue({
			code: "custom",
			path: ["failureBundleSha256"],
			message: "failure bundle hash and byte count must both be absent or present",
		});
	}
	if (request.source !== null && request.failureBundleSha256 === null) {
		context.addIssue({ code: "custom", path: ["source"], message: "source ids require failure evidence" });
	}
	if (request.provenanceMode === "unverified" && (request.sourceAttestation !== null || request.proposalBasis !== null)) {
		context.addIssue({ code: "custom", path: ["proposalBasis"], message: "unverified runs cannot claim canonical proposal evidence" });
	}
	if (request.provenanceMode === "canonical") {
		if ((request.source === null) !== (request.sourceAttestation === null)) {
			context.addIssue({ code: "custom", path: ["sourceAttestation"], message: "canonical source ids and attestation must be present together" });
		}
		if ((request.source === null) !== (request.failureBundleSha256 === null)) {
			context.addIssue({ code: "custom", path: ["failureBundleSha256"], message: "canonical failure evidence requires an exact source" });
		}
	}
	if (request.source && request.sourceAttestation && (
		request.source.evalRunId !== request.sourceAttestation.evalRunId ||
		request.source.diagnosisId !== request.sourceAttestation.diagnosisId
	)) {
		context.addIssue({ code: "custom", path: ["sourceAttestation"], message: "source attestation ids do not match request source" });
	}
	if (request.proposalBasis && (
		request.sourceAttestation === null ||
		request.proposalBasis.evalRunId !== request.sourceAttestation.evalRunId ||
		request.proposalBasis.diagnosisId !== request.sourceAttestation.diagnosisId
	)) {
		context.addIssue({ code: "custom", path: ["proposalBasis"], message: "proposal basis does not match source attestation" });
	}
	if ((request.proposalBasis === null) !== (request.proposalDiagnoses === null)) {
		context.addIssue({ code: "custom", path: ["proposalDiagnoses"], message: "proposal basis and host-derived diagnoses must be present together" });
	}
});

export const PersistedBuilderRunSchema = z.strictObject({
	schemaVersion: z.literal(1),
	runId: RunIdSchema,
	request: BuilderRequestEvidenceSchema,
	probe: BuilderProbeSchema,
	result: BuilderRunRecordSchema,
	artifacts: z.strictObject({
		input: ArtifactRefSchema,
		events: ArtifactRefSchema,
		proposal: ArtifactRefSchema.nullable(),
	}),
}).superRefine((record, context) => {
	if (record.runId !== record.result.runId) {
		context.addIssue({ code: "custom", path: ["result", "runId"], message: "result run id mismatch" });
	}
	if (record.request.baseTargetSha !== record.result.baseTargetSha) {
		context.addIssue({ code: "custom", path: ["result", "baseTargetSha"], message: "result base SHA mismatch" });
	}
	if (record.probe.backend !== record.result.backend) {
		context.addIssue({ code: "custom", path: ["result", "backend"], message: "probe/result backend mismatch" });
	}
	if (JSON.stringify(record.probe.capabilities) !== JSON.stringify(record.result.capabilities)) {
		context.addIssue({ code: "custom", path: ["result", "capabilities"], message: "probe/result capabilities mismatch" });
	}
	if (record.probe.available && record.result.backendVersion !== record.probe.version) {
		context.addIssue({ code: "custom", path: ["result", "backendVersion"], message: "probe/result version mismatch" });
	}
	if ((record.result.status === "completed") !== (record.artifacts.proposal !== null)) {
		context.addIssue({ code: "custom", path: ["artifacts", "proposal"], message: "proposal artifact is completed-run only" });
	}
	if (record.artifacts.events.path !== "events.jsonl") {
		context.addIssue({ code: "custom", path: ["artifacts", "events", "path"], message: "unexpected events artifact path" });
	}
	if (record.artifacts.input.path !== "builder_input.txt") {
		context.addIssue({ code: "custom", path: ["artifacts", "input", "path"], message: "unexpected input artifact path" });
	}
	if (
		record.artifacts.input.sha256 !== record.request.builderInputSha256 ||
		record.artifacts.input.bytes !== record.request.builderInputBytes
	) {
		context.addIssue({ code: "custom", path: ["artifacts", "input"], message: "input artifact/request identity mismatch" });
	}
	if (record.artifacts.proposal && record.artifacts.proposal.path !== "proposal.json") {
		context.addIssue({ code: "custom", path: ["artifacts", "proposal", "path"], message: "unexpected proposal artifact path" });
	}
	if (record.result.status === "completed") {
		try {
			validateCandidateProposal(record.result.proposal, {
				baseTargetSha: record.request.baseTargetSha,
				allowedPaths: record.request.allowedPaths,
			});
		} catch (error) {
			context.addIssue({ code: "custom", path: ["result", "proposal"], message: errorMessage(error) });
		}
	}
});
export type PersistedBuilderRun = z.infer<typeof PersistedBuilderRunSchema>;

/**
 * Project-owned authority admitting one shared Builder run into a Workbench.
 * The shared run's mutable self-description is never used to decide ownership.
 */
export const BuilderProposalAdmissionSchema = z.strictObject({
	schemaVersion: z.literal(1),
	projectId: ProjectIdSchema,
	runId: RunIdSchema,
	approvedSpec: ApprovedSpecReferenceSchema,
	builderRunSha256: Sha256Schema,
	proposalSha256: Sha256Schema,
}).superRefine((admission, context) => {
	if (admission.approvedSpec.projectId !== admission.projectId) {
		context.addIssue({
			code: "custom",
			path: ["approvedSpec", "projectId"],
			message: "admission approved Spec belongs to a different project",
		});
	}
});
export type BuilderProposalAdmission = z.infer<typeof BuilderProposalAdmissionSchema>;

const HumanActorSchema = z.strictObject({ kind: z.literal("human"), id: NonBlankSchema });

export const BuilderApplyReceiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	runId: RunIdSchema,
	proposalSha256: Sha256Schema,
	baseTargetSha: GitShaSchema,
	candidateSha: GitShaSchema,
	branch: NonBlankSchema,
	paths: z.array(z.string().min(1)).min(1).refine((paths) => new Set(paths).size === paths.length, "paths must be unique"),
	actor: HumanActorSchema,
	appliedAt: TimestampSchema,
	reason: NonBlankSchema,
});
export type BuilderApplyReceipt = z.infer<typeof BuilderApplyReceiptSchema>;

export interface RunBuilderProposalOptions {
	adapter: BuilderAdapter;
	baseTargetSha: string;
	allowedPaths: string[];
	/** Optional only when an approved Spec is the primary Builder input. */
	failureBundle?: string;
	runsRoot: string;
	timeoutMs: number;
	evidence?: { evalRunId: string; diagnosisId: string };
	approvedSpec?: ApprovedSpecInput;
	/** Untrusted human guidance embedded in the typed approved-Spec Builder input. */
	operatorGuidance?: string;
	signal?: AbortSignal;
	runId?: string;
}

export interface BuilderProposalRunResult {
	record: PersistedBuilderRun;
	runDir: string;
	builderRunPath: string;
	eventsPath: string;
	proposalPath: string | null;
}

/**
 * Admit an actionable canonical proposal into exactly one project's Workbench.
 * Replaying the exact receipt is crash-safe; conflicting authority is refused.
 */
export function admitBuilderProposalRun(
	stateRoot: string,
	projectIdInput: string,
	result: BuilderProposalRunResult,
): BuilderProposalAdmission | null {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const { record } = result;
	if (
		record.request.provenanceMode !== "canonical" ||
		record.result.status !== "completed" ||
		record.result.proposal?.decision !== "propose" ||
		record.result.proposal.changes.length === 0
	) return null;
	const approvedSpec = record.request.approvedSpec;
	const proposal = record.artifacts.proposal;
	if (!approvedSpec || approvedSpec.projectId !== projectId || !proposal) {
		throw new Error("canonical Builder proposal cannot be admitted without its exact project and proposal evidence");
	}
	const admission = BuilderProposalAdmissionSchema.parse({
		schemaVersion: 1,
		projectId,
		runId: record.runId,
		approvedSpec,
		builderRunSha256: hashValue(record),
		proposalSha256: proposal.sha256,
	});
	const path = proposalAdmissionPath(stateRoot, projectId, record.runId, true);
	if (existsSync(path)) {
		assertPrivateAdmissionFile(path);
		const existing = readJsonArtifact(path, BuilderProposalAdmissionSchema, {
			maxBytes: MAX_PROPOSAL_ADMISSION_BYTES,
		});
		if (canonicalJson(existing) !== canonicalJson(admission)) {
			throw new Error(`Builder proposal ${record.runId} already has conflicting project authority`);
		}
		return existing;
	}
	writeJsonArtifact(path, BuilderProposalAdmissionSchema, admission, { immutable: true });
	assertPrivateAdmissionFile(path);
	return admission;
}

export interface BuilderProposalDependencies {
	now: () => string;
	newRunId: () => string;
}

interface BuilderProvenanceContext {
	mode: "canonical" | "unverified";
	sourceAttestation: CanonicalBuilderSource | null;
	proposalBasis: ProposalBasisAttestation | null;
	proposalDiagnoses: EvidenceLinkedProposalDiagnosis[] | null;
}

const DEFAULT_RUN_DEPENDENCIES: BuilderProposalDependencies = {
	now: () => new Date().toISOString(),
	newRunId: () => `builder-${randomUUID()}`,
};

function sha256(content: string | Buffer): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function isContained(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function proposalAdmissionRoot(
	stateRoot: string,
	projectIdInput: string,
	create: boolean,
): string | null {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const root = resolve(stateRoot);
	if (!existsSync(root)) {
		if (!create) return null;
		mkdirSync(root, { recursive: true, mode: 0o700 });
	}
	const rootEntry = lstatSync(root);
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
		throw new Error(`Builder proposal stateRoot must be a regular non-symlink directory: ${root}`);
	}
	const canonicalRoot = realpathSync(root);
	let current = root;
	for (const segment of ["projects", projectId, "workbench", "proposal-admissions"]) {
		const next = join(current, segment);
		if (!existsSync(next)) {
			if (!create) return null;
			mkdirSync(next, { mode: 0o700 });
		}
		const entry = lstatSync(next);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`Builder proposal state component must be a regular non-symlink directory: ${next}`);
		}
		if (!isContained(canonicalRoot, realpathSync(next))) {
			throw new Error("Builder proposal state path escaped stateRoot");
		}
		current = next;
	}
	return current;
}

function assertPrivateAdmissionFile(path: string): void {
	const entry = lstatSync(path);
	if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_PROPOSAL_ADMISSION_BYTES) {
		throw new Error(`Builder proposal admission must be a bounded regular non-symlink file: ${path}`);
	}
	const mode = statSync(path).mode & 0o777;
	if (mode !== 0o600) {
		throw new Error(`Builder proposal admission must have mode 0600, got 0${mode.toString(8)}`);
	}
}

function proposalAdmissionPath(
	stateRoot: string,
	projectId: string,
	runIdInput: string,
	create: boolean,
): string {
	const runId = RunIdSchema.parse(runIdInput);
	const root = proposalAdmissionRoot(stateRoot, projectId, create);
	if (!root) throw new Error(`project ${projectId} has no Builder proposal admissions`);
	return join(root, `${runId}.json`);
}

/** Enumerate only the current project's proposal authority, never the shared runsRoot. */
export function listBuilderProposalAdmissions(
	stateRoot: string,
	projectIdInput: string,
): BuilderProposalAdmission[] {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const root = proposalAdmissionRoot(stateRoot, projectId, false);
	if (!root) return [];
	const entries = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.name.endsWith(".json"))
		.sort((left, right) => left.name.localeCompare(right.name));
	if (entries.length > MAX_PROPOSAL_ADMISSIONS) {
		throw new Error(`project ${projectId} exceeds ${MAX_PROPOSAL_ADMISSIONS} Builder proposal admissions`);
	}
	return entries.map((entry) => {
		if (!entry.isFile() || entry.isSymbolicLink()) {
			throw new Error(`Builder proposal admission entry is not a regular file: ${entry.name}`);
		}
		const runId = RunIdSchema.parse(entry.name.slice(0, -".json".length));
		const path = join(root, entry.name);
		assertPrivateAdmissionFile(path);
		const admission = readJsonArtifact(path, BuilderProposalAdmissionSchema, {
			maxBytes: MAX_PROPOSAL_ADMISSION_BYTES,
		});
		if (admission.projectId !== projectId || admission.runId !== runId) {
			throw new Error("Builder proposal admission path does not match its exact identity");
		}
		return admission;
	});
}

function verifyPersistedBuilderInput(record: PersistedBuilderRun, content: Buffer): void {
	if (record.request.approvedSpec === null) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(content.toString("utf8")) as unknown;
	} catch (error) {
		throw new Error("approved-Spec Builder input is not valid JSON", { cause: error });
	}
	const input = ApprovedSpecBuilderInputSchema.parse(parsed);
	if (canonicalJson(input.approvedSpec.reference) !== canonicalJson(record.request.approvedSpec)) {
		throw new Error("Builder input approved Spec reference does not match builder_run evidence");
	}
	const embeddedSource = input.evaluationEvidence?.source ?? null;
	if (canonicalJson(embeddedSource) !== canonicalJson(record.request.source)) {
		throw new Error("Builder input source reference does not match builder_run evidence");
	}
	const embeddedAttestation = input.evaluationEvidence?.sourceAttestation ?? null;
	if (canonicalJson(embeddedAttestation) !== canonicalJson(record.request.sourceAttestation)) {
		throw new Error("Builder input source attestation does not match builder_run evidence");
	}
	const embeddedProposalBasis = input.evaluationEvidence?.proposalBasis ?? null;
	if (canonicalJson(embeddedProposalBasis) !== canonicalJson(record.request.proposalBasis)) {
		throw new Error("Builder input proposal basis does not match builder_run evidence");
	}
	const embeddedProposalDiagnoses = input.evaluationEvidence?.proposalDiagnoses ?? null;
	if (canonicalJson(embeddedProposalDiagnoses) !== canonicalJson(record.request.proposalDiagnoses)) {
		throw new Error("Builder input host-derived diagnoses do not match builder_run evidence");
	}
	const bundle = input.evaluationEvidence?.failureBundle ?? null;
	const bundleHash = bundle === null ? null : sha256(bundle);
	const bundleBytes = bundle === null ? 0 : Buffer.byteLength(bundle, "utf8");
	if (bundleHash !== record.request.failureBundleSha256 || bundleBytes !== record.request.failureBundleBytes) {
		throw new Error("Builder input failure evidence does not match builder_run evidence");
	}
}

function rederiveAttestedProposalSelection(
	runsRoot: string,
	source: CanonicalBuilderSource,
	basis: ProposalBasisAttestation,
): EvidenceLinkedProposalSelection {
	let preflight;
	try {
		preflight = readEvalRunIndex(runsRoot, basis.evalRunId);
	} catch {
		throw new Error("attested proposal source failed integrity checks");
	}
	if (isSealedEvalRun(preflight)) {
		throw new Error("attested proposal source is unavailable");
	}
	const evalPath = resolveContainedArtifactPath(runsRoot, basis.evalRunId, "eval_run.json");
	assertRegularBounded(evalPath, MAX_RUN_RECORD_BYTES, "source eval_run.json");
	if (sha256(readFileSync(evalPath)) !== source.evalRunSha256) {
		throw new Error("attested proposal EvalRun changed after authoring");
	}
	const diagnosisPath = resolveContainedArtifactPath(runsRoot, basis.evalRunId, "diagnosis.json");
	assertRegularBounded(diagnosisPath, MAX_RUN_RECORD_BYTES, "source diagnosis.json");
	const diagnosisBytes = readFileSync(diagnosisPath);
	if (sha256(diagnosisBytes) !== source.diagnosisSha256) {
		throw new Error("attested proposal diagnosis changed after authoring");
	}
	const diagnosis = readJsonArtifact(diagnosisPath, DiagnosisRecordSchema);
	const selected = deriveEvidenceLinkedProposalSelection(
		compileImprovementBrief(runsRoot, diagnosis),
		ProposalBasisSelectionSchema.parse({
			algorithmId: basis.algorithmId,
			evalRunId: basis.evalRunId,
			diagnosisId: basis.diagnosisId,
			briefId: basis.briefId,
			failureModeIds: basis.failureModes.map((mode) => mode.failureModeId),
		}),
	);
	if (canonicalJson(selected.basis) !== canonicalJson(basis)) {
		throw new Error("attested proposal basis no longer matches canonical evidence");
	}
	return selected;
}

function verifyPersistedProposalBasis(record: PersistedBuilderRun, runsRoot: string): void {
	const basis = record.request.proposalBasis;
	if (basis === null) return;
	const source = record.request.sourceAttestation;
	if (source === null) throw new Error("attested proposal basis is missing its canonical source");
	const selected = rederiveAttestedProposalSelection(runsRoot, source, basis);
	if (canonicalJson(record.request.proposalDiagnoses) !== canonicalJson(selected.diagnoses)) {
		throw new Error("persisted host-derived diagnoses no longer match canonical evidence");
	}
	if (record.result.status === "completed" && record.result.proposal) {
		assertProposalEvidenceBinding(record.result.proposal, selected.basis, selected.diagnoses);
	}
}

function assertProposalEvidenceBinding(
	proposal: CandidateProposal,
	basis: ProposalBasisAttestation | null,
	diagnoses: EvidenceLinkedProposalDiagnosis[] | null,
): void {
	if (basis === null || diagnoses === null) return;
	if (canonicalJson(proposal.diagnoses) !== canonicalJson(diagnoses)) {
		throw new Error("proposal diagnoses do not match the host-derived failure-mode evidence");
	}
	const evidenceRefs = [...new Set(diagnoses.flatMap((diagnosis) => diagnosis.evidence))];
	for (const change of proposal.changes) {
		if (canonicalJson(change.evidenceRefs) !== canonicalJson(evidenceRefs)) {
			throw new Error("proposal change evidence refs do not match the host-derived failure-mode evidence");
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function builderError(code: string, message: string, retryable: boolean): BuilderError {
	return { code, message: message.trim() || code, retryable };
}

function failedRecord(input: {
	runId: string;
	backend: string;
	backendVersion: string | null;
	capabilities: BuilderCapabilities;
	baseTargetSha: string;
	startedAt: string;
	finishedAt: string;
	status?: "failed" | "timeout" | "cancelled";
	error: BuilderError;
}): BuilderRunRecord {
	return BuilderRunRecordSchema.parse({
		schemaVersion: 1,
		...input,
		status: input.status ?? "failed",
		proposal: null,
		model: null,
		sessionId: null,
		usage: null,
		costUsd: null,
		traceLevel: "final-only",
		rawEvents: [],
	});
}

function unavailableProbe(adapter: BuilderAdapter, capabilities: BuilderCapabilities, error: unknown): BuilderProbe {
	return BuilderProbeSchema.parse({
		backend: adapter.backend,
		available: false,
		version: null,
		capabilities,
		error: builderError("probe-failed", errorMessage(error), true),
	});
}

async function probeAdapter(adapter: BuilderAdapter, capabilities: BuilderCapabilities): Promise<BuilderProbe> {
	try {
		const probe = BuilderProbeSchema.parse(await adapter.probe());
		if (probe.backend !== adapter.backend) throw new Error("adapter probe reported a different backend");
		if (JSON.stringify(probe.capabilities) !== JSON.stringify(capabilities)) {
			throw new Error("adapter probe reported different capabilities");
		}
		return probe;
	} catch (error) {
		return unavailableProbe(adapter, capabilities, error);
	}
}

async function invokeAdapter(
	options: RunBuilderProposalOptions & { failureBundle: string },
	runId: string,
	probe: BuilderProbe,
	capabilities: BuilderCapabilities,
	now: () => string,
	executionTimeoutMs: number,
): Promise<BuilderRunRecord> {
	const startedAt = now();
	if (!probe.available || !probe.version) {
		return failedRecord({
			runId,
			backend: options.adapter.backend,
			backendVersion: null,
			capabilities,
			baseTargetSha: options.baseTargetSha,
			startedAt,
			finishedAt: now(),
			error: probe.error ?? builderError("probe-failed", "backend unavailable", true),
		});
	}

	if (options.signal?.aborted) {
		return failedRecord({
			runId,
			backend: options.adapter.backend,
			backendVersion: probe.version,
			capabilities,
			baseTargetSha: options.baseTargetSha,
			startedAt,
			finishedAt: now(),
			status: "cancelled",
			error: builderError("cancelled", "builder request was cancelled", false),
		});
	}
	if (!capabilities.cancellation) {
		return failedRecord({
			runId,
			backend: options.adapter.backend,
			backendVersion: probe.version,
			capabilities,
			baseTargetSha: options.baseTargetSha,
			startedAt,
			finishedAt: now(),
			error: builderError("cancellation-unsupported", "production proposal runs require adapter cancellation", false),
		});
	}

	const controller = new AbortController();
	let interruption: "timeout" | "cancelled" | undefined;
	const cancel = () => {
		interruption = "cancelled";
		controller.abort();
	};
	options.signal?.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(() => {
		interruption = "timeout";
		controller.abort();
	}, executionTimeoutMs);

	try {
		let value: unknown;
		let adapterFailure: unknown;
		try {
			value = await Promise.resolve().then(() => options.adapter.run({
				runId,
				bundle: options.failureBundle,
				baseTargetSha: options.baseTargetSha,
				allowedPaths: options.allowedPaths,
				timeoutMs: options.timeoutMs,
				signal: controller.signal,
			}));
		} catch (error) {
			adapterFailure = error;
		}

		if (interruption) {
			const status = interruption;
			return failedRecord({
				runId,
				backend: options.adapter.backend,
				backendVersion: probe.version,
				capabilities,
				baseTargetSha: options.baseTargetSha,
				startedAt,
				finishedAt: now(),
				status,
				error: builderError(status, status === "timeout" ? "builder execution timed out" : "builder request was cancelled", status === "timeout"),
			});
		}
		if (adapterFailure !== undefined) {
			return failedRecord({
				runId,
				backend: options.adapter.backend,
				backendVersion: probe.version,
				capabilities,
				baseTargetSha: options.baseTargetSha,
				startedAt,
				finishedAt: now(),
				error: builderError("adapter-threw", errorMessage(adapterFailure), true),
			});
		}

		try {
			const result = BuilderRunRecordSchema.parse(value);
			if (result.runId !== runId) throw new Error("adapter result runId mismatch");
			if (result.backend !== options.adapter.backend) throw new Error("adapter result backend mismatch");
			if (result.backendVersion !== probe.version) throw new Error("adapter result version mismatch");
			if (result.baseTargetSha !== options.baseTargetSha) throw new Error("adapter result baseTargetSha mismatch");
			if (JSON.stringify(result.capabilities) !== JSON.stringify(capabilities)) {
				throw new Error("adapter result capabilities mismatch");
			}
			if (result.rawEvents.some((event) => /[\r\n]/.test(event))) {
				throw new Error("adapter raw event entries must be individual JSONL lines");
			}
			if (result.status === "completed") {
				const proposal = validateCandidateProposal(result.proposal, {
					baseTargetSha: options.baseTargetSha,
					allowedPaths: options.allowedPaths,
				});
				if (Buffer.byteLength(JSON.stringify(proposal), "utf8") > MAX_PROPOSAL_BYTES) {
					throw new Error("adapter proposal exceeds the evidence limit");
				}
			}
			return result;
		} catch (error) {
			return failedRecord({
				runId,
				backend: options.adapter.backend,
				backendVersion: probe.version,
				capabilities,
				baseTargetSha: options.baseTargetSha,
				startedAt,
				finishedAt: now(),
				error: builderError("invalid-adapter-result", errorMessage(error), false),
			});
		}
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", cancel);
	}
}

async function runBuilderProposalInternal(
	options: RunBuilderProposalOptions,
	dependencies: Partial<BuilderProposalDependencies> = {},
	provenance: BuilderProvenanceContext,
): Promise<BuilderProposalRunResult> {
	const deps = { ...DEFAULT_RUN_DEPENDENCIES, ...dependencies };
	const runId = RunIdSchema.parse(options.runId ?? deps.newRunId());
	const baseTargetSha = GitShaSchema.parse(options.baseTargetSha);
	const allowedPaths = z.array(AllowedPathSchema).min(1).parse(options.allowedPaths);
	if (new Set(allowedPaths).size !== allowedPaths.length) throw new Error("allowedPaths must be unique");
	if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) {
		throw new Error("timeoutMs must be a positive bounded integer");
	}
	const capabilities = BuilderCapabilitiesSchema.parse(options.adapter.capabilities);
	if (!options.adapter.backend.trim()) throw new Error("adapter backend must be non-blank");
	const source = options.evidence === undefined
		? null
		: SourceEvidenceSchema.parse(options.evidence);
	const failureBundle = options.failureBundle?.trim() ? options.failureBundle : null;
	if (options.failureBundle !== undefined && failureBundle === null) throw new Error("failureBundle must be non-blank");
	if (source !== null && failureBundle === null) throw new Error("eval/diagnosis evidence requires a failureBundle");
	const operatorGuidance = options.operatorGuidance === undefined
		? null
		: OperatorGuidanceSchema.parse(options.operatorGuidance);
	const loadedSpec = options.approvedSpec === undefined ? null : loadApprovedSpec(options.approvedSpec);
	if (loadedSpec === null && operatorGuidance !== null) {
		throw new Error("operatorGuidance requires an approved Spec");
	}
	if (loadedSpec === null && failureBundle === null) {
		throw new Error("an approved Spec or a non-blank failureBundle is required");
	}
	const typedInput = loadedSpec === null
		? null
		: ApprovedSpecBuilderInputSchema.parse({
			schemaVersion: 1,
			approvedSpec: {
				reference: loadedSpec.reference,
				spec: loadedSpec.snapshot.spec,
			},
			operatorGuidance,
			evaluationEvidence: failureBundle === null
				? null
				: {
					source,
					sourceAttestation: provenance.sourceAttestation,
					proposalBasis: provenance.proposalBasis,
					proposalDiagnoses: provenance.proposalDiagnoses,
					failureBundle,
				},
		});
	const builderInput = typedInput === null ? failureBundle! : `${canonicalJson(typedInput)}\n`;
	const builderInputBytes = Buffer.byteLength(builderInput, "utf8");
	if (builderInputBytes > MAX_BUILDER_INPUT_BYTES) {
		throw new Error(`Builder input exceeds ${MAX_BUILDER_INPUT_BYTES} bytes`);
	}

	const buildersRoot = join(resolve(options.runsRoot), "builders");
	mkdirSync(buildersRoot, { recursive: true, mode: 0o700 });
	const runDir = join(buildersRoot, runId);
	if (existsSync(runDir)) throw new Error(`builder run ${runId} already exists`);
	const lockPath = join(buildersRoot, `.${runId}.lock`);
	const stagingDir = mkdtempSync(join(buildersRoot, `.${runId}.staging-`));
	let lockDescriptor: number;
	try {
		lockDescriptor = openSync(lockPath, "wx", 0o600);
	} catch (error) {
		rmSync(stagingDir, { recursive: true, force: true });
		throw new Error(`builder run ${runId} already exists or cannot be claimed`, { cause: error });
	}
	const deadline = Date.now() + options.timeoutMs;
	let published = false;
	try {
		const normalizedOptions: RunBuilderProposalOptions & { failureBundle: string } = {
			...options,
			runId,
			baseTargetSha,
			allowedPaths,
			failureBundle: builderInput,
		};
		const probeStartedAt = deps.now();
		const probe = await probeAdapter(options.adapter, capabilities);
		const remainingMs = deadline - Date.now();
		const result = remainingMs <= 0
			? failedRecord({
				runId,
				backend: options.adapter.backend,
				backendVersion: probe.available ? probe.version : null,
				capabilities,
				baseTargetSha,
				startedAt: probeStartedAt,
				finishedAt: deps.now(),
				status: "timeout",
				error: builderError("timeout", "builder probe exhausted the end-to-end deadline", true),
			})
			: await invokeAdapter(normalizedOptions, runId, probe, capabilities, deps.now, remainingMs);
		if (provenance.proposalBasis) {
			if (!provenance.sourceAttestation || !provenance.proposalDiagnoses) {
				throw new Error("attested proposal basis is missing its canonical host-derived evidence");
			}
			const current = rederiveAttestedProposalSelection(
				options.runsRoot,
				provenance.sourceAttestation,
				provenance.proposalBasis,
			);
			if (canonicalJson(current.diagnoses) !== canonicalJson(provenance.proposalDiagnoses)) {
				throw new Error("canonical proposal evidence changed during Builder execution");
			}
			if (result.status === "completed" && result.proposal) {
				assertProposalEvidenceBinding(result.proposal, current.basis, current.diagnoses);
			}
		}
		const rawEvents = result.rawEvents.join("\n");
		const rawBytes = Buffer.byteLength(rawEvents, "utf8");
		if (rawBytes > MAX_RAW_EVENT_BYTES) throw new Error("normalized adapter events exceed the evidence limit");

		writeTextArtifact(join(stagingDir, "builder_input.txt"), builderInput, { immutable: true });
		writeTextArtifact(join(stagingDir, "events.jsonl"), rawEvents, { immutable: true });
		let hasProposal = false;
		let proposalArtifact: z.infer<typeof ArtifactRefSchema> | null = null;
		if (result.status === "completed") {
			const proposal = validateCandidateProposal(result.proposal, { baseTargetSha, allowedPaths });
			const content = `${JSON.stringify(proposal, null, "\t")}\n`;
			if (Buffer.byteLength(content, "utf8") > MAX_PROPOSAL_BYTES) throw new Error("proposal exceeds the evidence limit");
			writeTextArtifact(join(stagingDir, "proposal.json"), content, { immutable: true });
			hasProposal = true;
			proposalArtifact = { path: "proposal.json", sha256: sha256(content), bytes: Buffer.byteLength(content, "utf8") };
		}

		const record = PersistedBuilderRunSchema.parse({
			schemaVersion: 1,
			runId,
			request: {
				baseTargetSha,
				allowedPaths,
				approvedSpec: loadedSpec?.reference ?? null,
				source,
				provenanceMode: provenance.mode,
				sourceAttestation: provenance.sourceAttestation,
				proposalBasis: provenance.proposalBasis,
				proposalDiagnoses: provenance.proposalDiagnoses,
				failureBundleSha256: failureBundle === null ? null : sha256(failureBundle),
				failureBundleBytes: failureBundle === null ? 0 : Buffer.byteLength(failureBundle, "utf8"),
				builderInputSha256: sha256(builderInput),
				builderInputBytes,
				timeoutMs: options.timeoutMs,
			},
			probe,
			result,
			artifacts: {
				input: { path: "builder_input.txt", sha256: sha256(builderInput), bytes: builderInputBytes },
				events: { path: "events.jsonl", sha256: sha256(rawEvents), bytes: rawBytes },
				proposal: proposalArtifact,
			},
		});
		writeJsonArtifact(join(stagingDir, "builder_run.json"), PersistedBuilderRunSchema, record, { immutable: true });
		if (existsSync(runDir)) throw new Error(`builder run ${runId} appeared while evidence was staged`);
		renameSync(stagingDir, runDir);
		published = true;
		return {
			record,
			runDir,
			builderRunPath: join(runDir, "builder_run.json"),
			eventsPath: join(runDir, "events.jsonl"),
			proposalPath: hasProposal ? join(runDir, "proposal.json") : null,
		};
	} finally {
		if (!published && existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
		closeSync(lockDescriptor);
		try {
			unlinkSync(lockPath);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
}

/**
 * Low-level adapter runner for experiments and tests. Caller-supplied bundles
 * are durably marked unverified and can never enter the promotable Candidate
 * path. Production callers must use runApprovedSpecBuilderProposal().
 */
export function runBuilderProposal(
	options: RunBuilderProposalOptions,
	dependencies: Partial<BuilderProposalDependencies> = {},
): Promise<BuilderProposalRunResult> {
	return runBuilderProposalInternal(options, dependencies, {
		mode: "unverified",
		sourceAttestation: null,
		proposalBasis: null,
		proposalDiagnoses: null,
	});
}

export type RunApprovedSpecBuilderProposalOptions = Omit<
	RunBuilderProposalOptions,
	"approvedSpec" | "baseTargetSha" | "failureBundle" | "evidence"
> & {
	approvedSpec: ApprovedSpecInput;
	targetDir: string;
	dataset?: string;
	sourceEvalRunId?: string;
	/** Exact model-selected handles; the host recompiles and attests their canonical brief. */
	proposalBasis?: ProposalBasisSelection;
};

function assertDevelopmentProposalSourceMetadata(
	runsRoot: string,
	approvedSpec: ApprovedSpecInput,
	evalRunIdInput: string,
): string {
	const evalRunId = RunIdSchema.parse(evalRunIdInput);
	const sealedHashes = new Set(listCorpora({
		stateRoot: approvedSpec.stateRoot,
		projectId: approvedSpec.projectId,
	}).filter((corpus) => corpus.visibility === "sealed").map((corpus) => corpus.hash));
	let preflight;
	try {
		preflight = readEvalRunIndex(runsRoot, evalRunId);
	} catch {
		throw new Error("canonical Builder source metadata failed integrity checks");
	}
	if (isSealedEvalRun(preflight, sealedHashes)) {
		throw new Error("sealed holdout evidence cannot be used to steer a Builder proposal");
	}
	return evalRunId;
}

export interface ResolveCanonicalProposalBasisOptions {
	runsRoot: string;
	approvedSpec: ApprovedSpecInput;
	sourceEvalRunId: string;
	failureModeIds: string[];
}

/** CLI/host convenience which performs the sealed preflight before diagnosis. */
export function resolveCanonicalProposalBasis(
	options: ResolveCanonicalProposalBasisOptions,
): ProposalBasisSelection {
	loadApprovedSpec(options.approvedSpec);
	const evalRunId = assertDevelopmentProposalSourceMetadata(
		options.runsRoot,
		options.approvedSpec,
		options.sourceEvalRunId,
	);
	const diagnosis = diagnoseEvalRun(options.runsRoot, evalRunId);
	const brief = compileImprovementBrief(options.runsRoot, diagnosis);
	const selection = ProposalBasisSelectionSchema.parse({
		algorithmId: brief.algorithmId,
		evalRunId: brief.evalRunId,
		diagnosisId: brief.diagnosisId,
		briefId: brief.briefId,
		failureModeIds: options.failureModeIds,
	});
	deriveEvidenceLinkedProposalSelection(brief, selection);
	return selection;
}

/**
 * Canonical Spec-first entry point. It derives every evidence byte from the
 * verified EvalRun/Diagnosis and the exact reconstructable development target;
 * callers cannot inject a raw bundle while retaining promotable provenance.
 */
export async function runApprovedSpecBuilderProposal(
	options: RunApprovedSpecBuilderProposalOptions,
	dependencies: Partial<BuilderProposalDependencies> = {},
): Promise<BuilderProposalRunResult> {
	for (const forbidden of ["baseTargetSha", "failureBundle", "evidence"] as const) {
		if (Object.prototype.hasOwnProperty.call(options, forbidden)) {
			throw new Error(`canonical Builder options must not include caller-supplied ${forbidden}`);
		}
	}
	const requestedBasis = options.proposalBasis
		? ProposalBasisSelectionSchema.parse(options.proposalBasis)
		: null;
	if (options.sourceEvalRunId !== undefined && requestedBasis === null) {
		throw new Error("canonical Builder source requires an exact improvement-brief and failure-mode selection");
	}
	if (options.sourceEvalRunId === undefined && requestedBasis !== null) {
		throw new Error("proposal basis requires an exact canonical source EvalRun");
	}
	const sourceEvalRunId = options.sourceEvalRunId === undefined
		? undefined
		: RunIdSchema.parse(options.sourceEvalRunId);
	if (requestedBasis && requestedBasis.evalRunId !== sourceEvalRunId) {
		throw new Error("proposal basis must name the exact canonical source EvalRun");
	}
	const {
		targetDir: _targetDir,
		dataset: _dataset,
		sourceEvalRunId: _sourceEvalRunId,
		proposalBasis: _proposalBasis,
		...rest
	} = options;
	void _targetDir;
	void _dataset;
	void _sourceEvalRunId;
	const runCanonical = async (
		targetDir: string,
		sourceEvalRunId?: string,
	): Promise<BuilderProposalRunResult> => {
		const target = loadTarget(targetDir, options.dataset ? { dataset: options.dataset } : undefined);
		const baseTargetSha = GitShaSchema.parse(target.gitSha);
		let failureBundle: string | undefined;
		let evidence: { evalRunId: string; diagnosisId: string } | undefined;
		let sourceAttestation: CanonicalBuilderSource | null = null;
		let proposalBasis: ProposalBasisAttestation | null = null;
		let proposalDiagnoses: EvidenceLinkedProposalDiagnosis[] | null = null;
		if (sourceEvalRunId) {
			const sealed = listCorpora({
				stateRoot: options.approvedSpec.stateRoot,
				projectId: options.approvedSpec.projectId,
			}).filter((corpus) => corpus.visibility === "sealed");
			const sealedHashes = new Set(sealed.map((corpus) => corpus.hash));
			let preflight;
			try {
				preflight = readEvalRunIndex(options.runsRoot, sourceEvalRunId);
			} catch {
				throw new Error("canonical Builder source metadata failed integrity checks");
			}
			if (isSealedEvalRun(preflight, sealedHashes)) {
				throw new Error("sealed holdout evidence cannot be used to steer a Builder proposal");
			}
			const verifiedEval = loadVerifiedEvalRun(options.runsRoot, sourceEvalRunId);
			if (!verifiedEval.hasRunHashes) {
				throw new Error("canonical Builder source eval must hash-anchor every member run");
			}
			const evalRun = verifiedEval.record;
			if (evalRun.target.id !== target.manifest.id || evalRun.target.gitSha !== target.gitSha) {
				throw new Error("canonical Builder source must belong to the reconstructed exact target revision");
			}
			if (isSealedEvalRun(evalRun, sealedHashes)) {
				throw new Error("sealed holdout evidence cannot be used to steer a Builder proposal");
			}
			const resolved = resolveDevelopmentTargetForEval({
				target,
				evalRun,
				stateRoot: options.approvedSpec.stateRoot,
				projectId: options.approvedSpec.projectId,
			});
			const diagnosis = diagnoseEvalRun(options.runsRoot, evalRun.evalRunId);
			if (diagnosis.status === "inconclusive") {
				throw new Error(
					`canonical Builder source diagnosis ${diagnosis.diagnosisId} is inconclusive; ` +
					"resolve infrastructure errors and re-run the evaluation before proposing changes",
				);
			}
			if (requestedBasis) {
				const selected = deriveEvidenceLinkedProposalSelection(
					compileImprovementBrief(options.runsRoot, diagnosis),
					requestedBasis,
				);
				proposalBasis = selected.basis;
				proposalDiagnoses = selected.diagnoses;
			}
			const bundlePath = compileFailureBundle(resolved.target, evalRun, options.runsRoot);
			assertRegularBounded(bundlePath, MAX_BUILDER_INPUT_BYTES, "canonical failure bundle");
			failureBundle = readFileSync(bundlePath, "utf8");
			evidence = { evalRunId: evalRun.evalRunId, diagnosisId: diagnosis.diagnosisId };
			const evalPath = resolveContainedArtifactPath(options.runsRoot, evalRun.evalRunId, "eval_run.json");
			const diagnosisPath = resolveContainedArtifactPath(options.runsRoot, evalRun.evalRunId, "diagnosis.json");
			assertRegularBounded(evalPath, MAX_RUN_RECORD_BYTES, "source eval_run.json");
			assertRegularBounded(diagnosisPath, MAX_RUN_RECORD_BYTES, "source diagnosis.json");
			sourceAttestation = CanonicalBuilderSourceSchema.parse({
				evalRunId: evalRun.evalRunId,
				diagnosisId: diagnosis.diagnosisId,
				targetId: evalRun.target.id,
				targetGitSha: evalRun.target.gitSha,
				evalRunSha256: sha256(readFileSync(evalPath)),
				diagnosisSha256: sha256(readFileSync(diagnosisPath)),
				dataset: evalRun.dataset,
				datasetHash: evalRun.datasetHash,
				suiteHash: evalRun.suiteHash,
				developmentCorpus: resolved.corpus
					? { id: resolved.corpus.metadata.id, hash: resolved.corpus.metadata.hash }
					: null,
			});
		}
		return runBuilderProposalInternal({
			...rest,
			baseTargetSha,
			failureBundle,
			evidence,
		}, dependencies, {
			mode: "canonical",
			sourceAttestation,
			proposalBasis,
			proposalDiagnoses,
		});
	};

	let result: BuilderProposalRunResult;
	if (!sourceEvalRunId) {
		result = await runCanonical(options.targetDir);
		admitBuilderProposalRun(options.approvedSpec.stateRoot, options.approvedSpec.projectId, result);
		return result;
	}
	assertDevelopmentProposalSourceMetadata(options.runsRoot, options.approvedSpec, sourceEvalRunId);
	const verifiedEval = loadVerifiedEvalRun(options.runsRoot, sourceEvalRunId);
	if (!verifiedEval.hasRunHashes) {
		throw new Error("canonical Builder source eval must hash-anchor every member run");
	}
	const evalRun = verifiedEval.record;
	result = await withDetachedWorktree({
		repositoryDir: options.targetDir,
		ref: evalRun.target.gitSha,
	}, async (worktree) => {
		if (worktree.sha !== evalRun.target.gitSha) {
			throw new Error("canonical Builder source ref did not resolve to the recorded target revision");
		}
		return runCanonical(worktree.path, evalRun.evalRunId);
	});
	admitBuilderProposalRun(options.approvedSpec.stateRoot, options.approvedSpec.projectId, result);
	return result;
}

/** Read only the bounded Builder record envelope; do not follow any evidence references. */
export function loadBuilderProposalRunEnvelope(runsRoot: string, runIdInput: string): PersistedBuilderRun {
	const runId = RunIdSchema.parse(runIdInput);
	const runDir = canonicalBuilderRunDirectory(runsRoot, runId);
	const record = readJsonArtifact(
		join(runDir, "builder_run.json"),
		PersistedBuilderRunSchema,
	);
	if (record.runId !== runId) throw new Error("builder run directory does not match its record id");
	return record;
}

/** Verify the self-contained input and then all canonical evidence reached by this exact record. */
export function verifyBuilderProposalRunEvidence(runsRoot: string, record: PersistedBuilderRun): void {
	const runDir = canonicalBuilderRunDirectory(runsRoot, record.runId);
	const inputPath = join(runDir, record.artifacts.input.path);
	assertRegularBounded(inputPath, MAX_BUILDER_INPUT_BYTES, "builder_input.txt");
	const input = readFileSync(inputPath);
	if (input.length !== record.artifacts.input.bytes || sha256(input) !== record.artifacts.input.sha256) {
		throw new Error("builder input artifact hash/size does not match builder_run evidence");
	}
	verifyPersistedBuilderInput(record, input);
	verifyPersistedProposalBasis(record, runsRoot);
	return;
}

export function loadBuilderProposalRun(runsRoot: string, runIdInput: string): PersistedBuilderRun {
	const record = loadBuilderProposalRunEnvelope(runsRoot, runIdInput);
	verifyBuilderProposalRunEvidence(runsRoot, record);
	return record;
}

export function loadBuilderApplyReceipt(runsRoot: string, runIdInput: string): BuilderApplyReceipt {
	const runId = RunIdSchema.parse(runIdInput);
	return readJsonArtifact(
		resolveContainedArtifactPath(runsRoot, "builders", runId, "apply_receipt.json"),
		BuilderApplyReceiptSchema,
	);
}

export interface ApplyBuilderProposalOptions {
	repoDir: string;
	/** Trusted configured root containing builders/<runId> immutable evidence. */
	runsRoot: string;
	runId: string;
	/** Exact Builder record reviewed by a host confirmation, when one exists. */
	expectedBuilderRunHash?: string;
	requestedBranch: string;
	actor: { kind: "human"; id: string };
	reason: string;
}

export interface ApplyBuilderProposalResult {
	receipt: BuilderApplyReceipt;
	receiptPath: string;
}

export interface ApplyBuilderProposalDependencies {
	now: () => string;
	writeReceipt: (path: string, receipt: BuilderApplyReceipt) => void;
}

const DEFAULT_APPLY_DEPENDENCIES: ApplyBuilderProposalDependencies = {
	now: () => new Date().toISOString(),
	writeReceipt: (path, receipt) => writeJsonArtifact(path, BuilderApplyReceiptSchema, receipt, { immutable: true }),
};

function gitText(repositoryDir: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): string {
	try {
		return execFileSync("git", ["-C", repositoryDir, ...args], {
			encoding: "utf8",
			input,
			env,
			maxBuffer: 16 * 1024 * 1024,
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		const stderr = typeof error === "object" && error !== null && "stderr" in error
			? String((error as { stderr?: unknown }).stderr).trim()
			: "";
		throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, { cause: error });
	}
}

function gitStatus(repositoryDir: string, args: string[]): number | null {
	return spawnSync("git", ["-C", repositoryDir, ...args], { stdio: "ignore" }).status;
}

function repositoryRoot(input: string): string {
	const absolute = resolve(input);
	if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error(`repository does not exist: ${absolute}`);
	const canonical = realpathSync(absolute);
	const top = realpathSync(gitText(canonical, ["rev-parse", "--show-toplevel"]));
	if (top !== canonical) throw new Error(`repoDir must be the Git worktree root: ${canonical}`);
	return canonical;
}

function validateBranch(repositoryDir: string, branch: string): string {
	if (!branch || branch !== branch.trim() || branch.startsWith("-") || branch.startsWith("refs/") || /[\0\r\n]/.test(branch)) {
		throw new Error("requestedBranch must be an exact clean local branch name");
	}
	const checked = gitText(repositoryDir, ["check-ref-format", "--branch", branch]);
	if (checked !== branch) throw new Error("Git normalized requestedBranch; refusing an inexact name");
	const ref = `refs/heads/${branch}`;
	if (gitStatus(repositoryDir, ["show-ref", "--verify", "--quiet", ref]) === 0) {
		throw new Error(`branch already exists: ${branch}`);
	}
	return ref;
}

function assertRegularBounded(path: string, maxBytes: number, label: string): void {
	const info = lstatSync(path);
	if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
	if (info.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
}

function canonicalBuilderRunDirectory(runsRoot: string, runId: string): string {
	const runDir = resolveContainedArtifactPath(runsRoot, "builders", runId);
	let runInfo;
	try {
		runInfo = lstatSync(runDir);
	} catch (error) {
		throw new Error(`builder run ${runId} does not exist under the configured runsRoot`, { cause: error });
	}
	if (!runInfo.isDirectory() || runInfo.isSymbolicLink()) {
		throw new Error(`builder run ${runId} must be a regular non-symlink directory`);
	}
	return runDir;
}

function matchesAllowedPath(path: string, allowed: string): boolean {
	return allowed.endsWith("/**") ? path.startsWith(allowed.slice(0, -2)) : path === allowed;
}

function validateChangePath(path: string, allowedPaths: string[]): void {
	if (!isSafeRepositoryPath(path) || path.includes(":")) throw new Error(`unsafe proposal path: ${path}`);
	const lower = path.toLowerCase();
	if (lower.startsWith("evals/")) throw new Error(`forbidden proposal path: ${path}`);
	if (!allowedPaths.some((allowed) => matchesAllowedPath(path, allowed))) {
		throw new Error(`proposal path is outside persisted allowed scope: ${path}`);
	}
}

const PROTECTED_MANIFEST_FIELDS = ["id", "model", "execution", "instructions", "evalSuite"] as const;

/**
 * Prove that a Target manifest change is resource-declaration-only. Both
 * values must already have passed the strict TargetManifest schema; defaults
 * are therefore compared in their canonical effective form.
 */
export function assertResourceOnlyManifestChange(
	base: TargetManifestValue,
	candidate: TargetManifestValue,
): void {
	const changed = PROTECTED_MANIFEST_FIELDS.filter(
		(field) => canonicalJson(base[field]) !== canonicalJson(candidate[field]),
	);
	if (changed.length > 0) {
		throw new Error(
			`manifest.yaml may change only resource declarations (skills/tools); protected field(s) changed: ${changed.join(", ")}`,
		);
	}
}

export function parseStrictTargetManifest(content: string | Buffer, label: string): TargetManifestValue {
	let parsed: unknown;
	try {
		parsed = parseYaml(content.toString());
	} catch (error) {
		throw new Error(`${label} is not valid YAML`, { cause: error });
	}
	const result = TargetManifest.safeParse(parsed);
	if (!result.success) throw new Error(`${label}: ${result.error.message}`);
	return result.data;
}

function validateAppliedTargetResources(
	repositoryDir: string,
	baseSha: string,
	worktreePath: string,
): void {
	const baseManifest = parseStrictTargetManifest(baseBlob(repositoryDir, baseSha, "manifest.yaml"), "base manifest.yaml");
	const appliedManifest = parseStrictTargetManifest(
		readFileSync(join(worktreePath, "manifest.yaml")),
		"applied manifest.yaml",
	);
	assertResourceOnlyManifestChange(baseManifest, appliedManifest);
	// This resolves every declared skill and tool and enforces descriptor,
	// executable-mode, and execution-policy constraints before a commit exists.
	loadTarget(worktreePath);
}

function validateDiff(change: CandidateProposal["changes"][number]): void {
	for (const line of change.unifiedDiff.split("\n")) {
		if (/^(rename|copy) (from|to) /.test(line)) throw new Error(`diff rename/copy metadata is forbidden: ${change.path}`);
		const mode = /^(?:new file mode|new mode) ([0-7]{6})$/.exec(line)?.[1];
		if (mode && mode !== "100644" && mode !== "100755") {
			throw new Error(`diff cannot create non-regular mode ${mode}: ${change.path}`);
		}
		if (line === "GIT binary patch" || line.startsWith("Binary files ")) {
			throw new Error(`binary diffs are forbidden: ${change.path}`);
		}
	}
}

interface TreeEntry { mode: string; type: string; path: string }

function treeEntry(repositoryDir: string, baseSha: string, path: string): TreeEntry | null {
	const output = gitText(repositoryDir, ["ls-tree", "-z", baseSha, "--", path]);
	if (!output) return null;
	const records = output.split("\0").filter(Boolean);
	const exact = records.find((record) => record.slice(record.indexOf("\t") + 1) === path);
	if (!exact) return null;
	const tab = exact.indexOf("\t");
	const [mode, type] = exact.slice(0, tab).split(" ");
	if (!mode || !type) throw new Error(`could not parse Git tree entry for ${path}`);
	return { mode, type, path };
}

function validateTreePath(repositoryDir: string, baseSha: string, path: string): TreeEntry | null {
	const parts = path.split("/");
	for (let index = 1; index < parts.length; index += 1) {
		const ancestor = parts.slice(0, index).join("/");
		const entry = treeEntry(repositoryDir, baseSha, ancestor);
		if (entry?.mode === "120000") throw new Error(`proposal path traverses symlink ${ancestor}`);
		if (entry && entry.type !== "tree") throw new Error(`proposal parent is not a directory: ${ancestor}`);
	}
	const entry = treeEntry(repositoryDir, baseSha, path);
	if (entry?.mode === "120000") throw new Error(`proposal targets symlink: ${path}`);
	if (entry && entry.type !== "blob") throw new Error(`proposal target is not a file: ${path}`);
	if (entry && entry.mode !== "100644" && entry.mode !== "100755") {
		throw new Error(`proposal target has unsupported Git mode ${entry.mode}: ${path}`);
	}
	return entry;
}

function validateWorktreePath(worktreePath: string, path: string): void {
	const root = realpathSync(worktreePath);
	let cursor = root;
	for (const [index, part] of path.split("/").entries()) {
		cursor = join(cursor, part);
		if (!existsSync(cursor)) return;
		const info = lstatSync(cursor);
		if (info.isSymbolicLink()) throw new Error(`proposal path traverses filesystem symlink: ${path}`);
		const canonical = realpathSync(cursor);
		const rel = relative(root, canonical);
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
			throw new Error(`proposal path escapes detached worktree: ${path}`);
		}
		if (index < path.split("/").length - 1 && !info.isDirectory()) {
			throw new Error(`proposal path parent is not a directory: ${path}`);
		}
	}
}

function baseBlob(repositoryDir: string, baseSha: string, path: string): Buffer {
	try {
		return execFileSync("git", ["-C", repositoryDir, "show", `${baseSha}:${path}`], {
			maxBuffer: MAX_PROPOSAL_BYTES,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		throw new Error(`could not read base blob for ${path}`, { cause: error });
	}
}

function safeTemporaryRoot(path: string): void {
	const root = resolve(path);
	const rel = relative(resolve(tmpdir()), root);
	if (!rel || isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === ".." || !basename(root).startsWith(TEMP_PREFIX)) {
		throw new Error(`unsafe proposal temporary root: ${root}`);
	}
}

function cleanupWorktree(repositoryDir: string, temporaryRoot: string, worktreePath: string, added: boolean): void {
	safeTemporaryRoot(temporaryRoot);
	const rel = relative(temporaryRoot, worktreePath);
	if (rel !== "worktree" || isAbsolute(rel)) throw new Error(`unsafe proposal worktree path: ${worktreePath}`);
	if (added) {
		const result = spawnSync("git", ["-C", repositoryDir, "worktree", "remove", "--force", worktreePath], {
			encoding: "utf8",
		});
		if (result.status !== 0) throw new Error(`failed to remove proposal worktree: ${result.stderr.trim()}`);
	}
	if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
	rmSync(temporaryRoot, { recursive: true, force: true });
	gitText(repositoryDir, ["worktree", "prune"]);
}

function changedPaths(worktreePath: string, revision = "--cached"): string[] {
	const output = gitText(worktreePath, ["diff", revision, "--name-only", "-z", "--"]);
	return output.split("\0").filter(Boolean).sort();
}

function samePaths(actual: string[], expected: string[]): boolean {
	return actual.length === expected.length && actual.every((path, index) => path === expected[index]);
}

export function applyBuilderProposal(
	options: ApplyBuilderProposalOptions,
	dependencies: Partial<ApplyBuilderProposalDependencies> = {},
): ApplyBuilderProposalResult {
	const deps = { ...DEFAULT_APPLY_DEPENDENCIES, ...dependencies };
	const now = deps.now;
	const runId = RunIdSchema.parse(options.runId);
	const actor = HumanActorSchema.parse(options.actor);
	const reason = NonBlankSchema.parse(options.reason);
	const repositoryDir = repositoryRoot(options.repoDir);
	const branchRef = validateBranch(repositoryDir, options.requestedBranch);
	const runDir = canonicalBuilderRunDirectory(options.runsRoot, runId);
	const builderRunPath = resolveContainedArtifactPath(options.runsRoot, "builders", runId, "builder_run.json");
	const proposalPath = resolveContainedArtifactPath(options.runsRoot, "builders", runId, "proposal.json");
	const receiptPath = resolveContainedArtifactPath(options.runsRoot, "builders", runId, "apply_receipt.json");
	if (existsSync(receiptPath)) throw new Error(`apply receipt already exists for builder run ${runId}`);
	const discardReceiptPath = resolveContainedArtifactPath(options.runsRoot, "builders", runId, "discard_receipt.json");
	if (existsSync(discardReceiptPath)) {
		throw new Error(`builder proposal ${runId} was already discarded and cannot be applied`);
	}
	assertRegularBounded(builderRunPath, MAX_RUN_RECORD_BYTES, "builder_run.json");
	assertRegularBounded(proposalPath, MAX_PROPOSAL_BYTES, "proposal.json");

	const persisted = readJsonArtifact(builderRunPath, PersistedBuilderRunSchema);
	if (
		options.expectedBuilderRunHash !== undefined &&
		hashValue(persisted) !== options.expectedBuilderRunHash
	) {
		throw new Error("builder proposal changed after confirmation; application is stale");
	}
	if (persisted.runId !== runId || persisted.result.status !== "completed" || !persisted.artifacts.proposal) {
		throw new Error("builder run does not contain a completed proposal");
	}
	const inputPath = join(runDir, persisted.artifacts.input.path);
	assertRegularBounded(inputPath, MAX_BUILDER_INPUT_BYTES, "builder_input.txt");
	const inputBytes = readFileSync(inputPath);
	if (inputBytes.length !== persisted.artifacts.input.bytes || sha256(inputBytes) !== persisted.artifacts.input.sha256) {
		throw new Error("builder input artifact hash/size does not match builder_run evidence");
	}
	verifyPersistedBuilderInput(persisted, inputBytes);
	verifyPersistedProposalBasis(persisted, options.runsRoot);
	if (
		persisted.request.provenanceMode === "canonical" &&
		persisted.request.source !== null &&
		persisted.request.proposalBasis === null
	) {
		throw new Error("legacy source-backed proposals without an attested failure-mode basis are read-only");
	}
	const eventsPath = join(runDir, persisted.artifacts.events.path);
	assertRegularBounded(eventsPath, MAX_RAW_EVENT_BYTES, "events.jsonl");
	const eventBytes = readFileSync(eventsPath);
	if (eventBytes.length !== persisted.artifacts.events.bytes || sha256(eventBytes) !== persisted.artifacts.events.sha256) {
		throw new Error("events artifact hash/size does not match builder_run evidence");
	}
	const proposalBytes = readFileSync(proposalPath);
	if (proposalBytes.length !== persisted.artifacts.proposal.bytes || sha256(proposalBytes) !== persisted.artifacts.proposal.sha256) {
		throw new Error("proposal artifact hash/size does not match builder_run evidence");
	}
	const proposal = readJsonArtifact(proposalPath, CandidateProposalSchema);
	if (JSON.stringify(proposal) !== JSON.stringify(persisted.result.proposal)) {
		throw new Error("proposal artifact does not match completed adapter result");
	}
	validateCandidateProposal(proposal, {
		baseTargetSha: persisted.request.baseTargetSha,
		allowedPaths: persisted.request.allowedPaths,
	});
	if (proposal.decision !== "propose") throw new Error("no-change proposal cannot be applied");

	const baseSha = proposal.baseTargetSha;
	const resolvedBase = gitText(repositoryDir, ["rev-parse", "--verify", `${baseSha}^{commit}`]);
	if (resolvedBase !== baseSha) throw new Error(`proposal base commit does not exist exactly: ${baseSha}`);
	const paths = proposal.changes.map((change) => change.path).sort();
	for (const change of proposal.changes) {
		validateChangePath(change.path, persisted.request.allowedPaths);
		validateDiff(change);
		const existing = validateTreePath(repositoryDir, baseSha, change.path);
		if (existing) {
			const actualHash = sha256(baseBlob(repositoryDir, baseSha, change.path));
			if (actualHash !== change.baseSha256) {
				throw new Error(`stale baseSha256 for ${change.path}: expected ${actualHash}, proposal has ${change.baseSha256}`);
			}
		} else if (change.baseSha256 !== sha256(Buffer.alloc(0))) {
			throw new Error(`new file ${change.path} must use the empty-content baseSha256 sentinel`);
		}
	}

	const patch = `${proposal.changes.map((change) => change.unifiedDiff.trimEnd()).join("\n")}\n`;
	const temporaryRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
	safeTemporaryRoot(temporaryRoot);
	const worktreePath = join(temporaryRoot, "worktree");
	const hooksPath = join(temporaryRoot, "empty-hooks");
	mkdirSync(hooksPath);
	let worktreeAdded = false;
	let branchCreated = false;
	let receiptWritten = false;
	let candidateSha = "";
	let operationError: unknown;

	try {
		gitText(repositoryDir, ["worktree", "add", "--detach", worktreePath, baseSha]);
		worktreeAdded = true;
		for (const path of paths) validateWorktreePath(worktreePath, path);
		gitText(worktreePath, ["apply", "--check", "--index", "-"], patch);
		gitText(worktreePath, ["apply", "--index", "-"], patch);
		const appliedPaths = changedPaths(worktreePath);
		if (!samePaths(appliedPaths, paths)) {
			throw new Error(`applied diff paths differ from proposal: ${appliedPaths.join(", ")}`);
		}
		for (const path of appliedPaths) {
			validateChangePath(path, persisted.request.allowedPaths);
			validateWorktreePath(worktreePath, path);
			const indexEntry = gitText(worktreePath, ["ls-files", "-s", "--", path]);
			if (indexEntry) {
				const mode = indexEntry.split(" ", 1)[0];
				if (mode !== "100644" && mode !== "100755") {
					throw new Error(`applied diff created non-regular mode ${mode}: ${path}`);
				}
			}
		}
		if (appliedPaths.includes("manifest.yaml")) {
			validateAppliedTargetResources(repositoryDir, baseSha, worktreePath);
		}

		const appliedAt = TimestampSchema.parse(now());
		const identityEnvironment: NodeJS.ProcessEnv = {
			...process.env,
			GIT_AUTHOR_NAME: "AHDE Builder",
			GIT_AUTHOR_EMAIL: "builder@ahde.local",
			GIT_COMMITTER_NAME: "AHDE Builder",
			GIT_COMMITTER_EMAIL: "builder@ahde.local",
			GIT_AUTHOR_DATE: appliedAt,
			GIT_COMMITTER_DATE: appliedAt,
		};
		gitText(worktreePath, [
			"-c", `core.hooksPath=${hooksPath}`,
			"-c", "commit.gpgSign=false",
			"commit", "--no-verify", "--no-gpg-sign", "-m", `AHDE builder proposal ${runId}`,
		], undefined, identityEnvironment);
		candidateSha = gitText(worktreePath, ["rev-parse", "HEAD"]);
		if (!GIT_SHA.test(candidateSha) || candidateSha === baseSha) throw new Error("proposal commit did not create a candidate revision");
		if (gitText(worktreePath, ["rev-parse", "HEAD^"]) !== baseSha) throw new Error("proposal commit parent differs from exact base");
		const committedPaths = gitText(worktreePath, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"])
			.split("\0").filter(Boolean).sort();
		if (!samePaths(committedPaths, paths)) throw new Error("candidate commit paths differ from validated proposal paths");

		gitText(repositoryDir, ["update-ref", "-m", `AHDE apply ${runId}`, branchRef, candidateSha, ZERO_SHA]);
		branchCreated = true;
		const receipt = BuilderApplyReceiptSchema.parse({
			schemaVersion: 1,
			runId,
			proposalSha256: persisted.artifacts.proposal.sha256,
			baseTargetSha: baseSha,
			candidateSha,
			branch: options.requestedBranch,
			paths,
			actor,
			appliedAt,
			reason,
		});
		try {
			deps.writeReceipt(receiptPath, receipt);
			receiptWritten = true;
		} catch (error) {
			const rollback = spawnSync("git", ["-C", repositoryDir, "update-ref", "-d", branchRef, candidateSha], {
				encoding: "utf8",
			});
			if (rollback.status !== 0) {
				throw new AggregateError([error, new Error(rollback.stderr.trim())], "receipt write and branch rollback failed");
			}
			branchCreated = false;
			throw error;
		}
		return { receipt, receiptPath };
	} catch (error) {
		operationError = error;
		if (branchCreated && !receiptWritten && candidateSha) {
			const rollback = spawnSync("git", ["-C", repositoryDir, "update-ref", "-d", branchRef, candidateSha], {
				encoding: "utf8",
			});
			if (rollback.status !== 0) {
				throw new AggregateError([error, new Error(rollback.stderr.trim())], "proposal apply and branch rollback failed");
			}
			branchCreated = false;
		}
		throw error;
	} finally {
		try {
			cleanupWorktree(repositoryDir, temporaryRoot, worktreePath, worktreeAdded);
		} catch (cleanupError) {
			if (operationError !== undefined) {
				throw new AggregateError([operationError, cleanupError], "proposal application and cleanup failed");
			}
			throw cleanupError;
		}
	}
}
