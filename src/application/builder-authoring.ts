import {
	existsSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
	BuilderRunRecordSchema,
	CandidateProposalSchema,
	validateCandidateProposal,
	type BuilderAdapter,
	type BuilderCapabilities,
	type CandidateProposal,
} from "../builders/adapters.js";
import {
	CorpusMetadataSchema,
	CorpusTaskSchema,
	createCorpus,
	listCorpora,
	loadCorpus,
	type CorpusMetadata,
	type CorpusTask,
} from "../corpus.js";
import { GraderSpec } from "../manifest.js";
import { canonicalJson, hashValue } from "../provenance.js";
import {
	ApprovedSpecReferenceSchema,
	loadApprovedSpec,
	loadSpecSnapshot,
	saveSpecSnapshot,
	type AgentSpec,
	type SpecSnapshot,
} from "../spec.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import {
	runApprovedSpecBuilderProposal,
	type BuilderProposalDependencies,
	type BuilderProposalRunResult,
	type RunApprovedSpecBuilderProposalOptions,
} from "./builder-proposal.js";

const MAX_SOURCE_TEXT_BYTES = 64 * 1024;
const MAX_CORPUS_TASKS = 100;
const MAX_CORPUS_TASK_BYTES = 64 * 1024;
const MAX_CORPUS_BYTES = 2 * 1024 * 1024;

const ProjectIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const SpecIdSchema = z.string().regex(/^spec-[0-9a-f]{64}$/);
const CorpusIdSchema = z.string().regex(/^corpus-[0-9a-f]{64}$/);
const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const TimestampSchema = z.iso.datetime({ offset: true });
const NonBlankSchema = z.string().min(1).refine((value) => value.trim().length > 0, "expected non-blank text");
const HumanActorSchema = z.strictObject({
	kind: z.literal("human"),
	id: NonBlankSchema.max(256),
});
const ApprovalReasonSchema = NonBlankSchema.max(4_000);
const SafeTaskIdSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/, "task id must be one bounded portable identifier");

const BuilderAuthoredCorpusTaskSchema = CorpusTaskSchema.extend({
	id: SafeTaskIdSchema,
	input: NonBlankSchema.max(32_000),
	graders: z.array(GraderSpec).min(1).max(16),
}).superRefine((task, context) => {
	if (Buffer.byteLength(canonicalJson(task), "utf8") > MAX_CORPUS_TASK_BYTES) {
		context.addIssue({ code: "custom", message: `task exceeds ${MAX_CORPUS_TASK_BYTES} bytes` });
	}
});

export const BuilderAuthoredCorpusTasksSchema = z
	.array(BuilderAuthoredCorpusTaskSchema)
	.min(1)
	.max(MAX_CORPUS_TASKS)
	.superRefine((tasks, context) => {
		const ids = new Set<string>();
		for (const [index, task] of tasks.entries()) {
			if (ids.has(task.id)) {
				context.addIssue({ code: "custom", path: [index, "id"], message: "task ids must be unique" });
			}
			ids.add(task.id);
		}
		if (Buffer.byteLength(canonicalJson(tasks), "utf8") > MAX_CORPUS_BYTES) {
			context.addIssue({ code: "custom", message: `corpus exceeds ${MAX_CORPUS_BYTES} bytes` });
		}
	});

export type BuilderAuthoredCorpusTasks = z.infer<typeof BuilderAuthoredCorpusTasksSchema>;

export const SpecDraftApprovalSubjectSchema = z.strictObject({
	schemaVersion: z.literal(1),
	projectId: ProjectIdSchema,
	draftSpecId: SpecIdSchema,
	draftSnapshotHash: Sha256Schema,
	specContentHash: Sha256Schema,
});
export type SpecDraftApprovalSubject = z.infer<typeof SpecDraftApprovalSubjectSchema>;

const SpecApprovalReceiptIdSchema = z.string().regex(/^spec-approval-[0-9a-f]{64}$/);

export const SpecApprovalReceiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	id: SpecApprovalReceiptIdSchema,
	projectId: ProjectIdSchema,
	draft: SpecDraftApprovalSubjectSchema,
	approvedSpec: ApprovedSpecReferenceSchema,
	actor: HumanActorSchema,
	reason: ApprovalReasonSchema,
	approvedAt: TimestampSchema,
}).superRefine((receipt, context) => {
	if (receipt.draft.projectId !== receipt.projectId || receipt.approvedSpec.projectId !== receipt.projectId) {
		context.addIssue({ code: "custom", path: ["projectId"], message: "receipt project references must match" });
	}
	if (receipt.draft.specContentHash !== receipt.approvedSpec.specContentHash) {
		context.addIssue({
			code: "custom",
			path: ["approvedSpec", "specContentHash"],
			message: "approved Spec content must exactly match the draft",
		});
	}
	const { id: _id, ...identity } = receipt;
	const expected = `spec-approval-${hashValue(identity).slice("sha256:".length)}`;
	if (receipt.id !== expected) {
		context.addIssue({ code: "custom", path: ["id"], message: "receipt id does not match approval evidence" });
	}
});
export type SpecApprovalReceipt = z.infer<typeof SpecApprovalReceiptSchema>;

export const DevelopmentCorpusPublicationSubjectSchema = z.strictObject({
	schemaVersion: z.literal(1),
	projectId: ProjectIdSchema,
	name: z.string().trim().min(1).max(200),
	visibility: z.literal("development"),
	taskCount: z.number().int().min(1).max(MAX_CORPUS_TASKS),
	contentHash: Sha256Schema,
	subjectHash: Sha256Schema,
});
export type DevelopmentCorpusPublicationSubject = z.infer<typeof DevelopmentCorpusPublicationSubjectSchema>;

const CorpusPublicationReceiptIdSchema = z.string().regex(/^corpus-publication-[0-9a-f]{64}$/);

export const DevelopmentCorpusPublicationReceiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	id: CorpusPublicationReceiptIdSchema,
	projectId: ProjectIdSchema,
	subject: DevelopmentCorpusPublicationSubjectSchema,
	corpus: CorpusMetadataSchema.extend({ visibility: z.literal("development") }),
	actor: HumanActorSchema,
	reason: ApprovalReasonSchema,
	publishedAt: TimestampSchema,
}).superRefine((receipt, context) => {
	if (
		receipt.subject.projectId !== receipt.projectId ||
		receipt.corpus.projectId !== receipt.projectId
	) {
		context.addIssue({ code: "custom", path: ["projectId"], message: "receipt project references must match" });
	}
	if (
		receipt.subject.name !== receipt.corpus.name ||
		receipt.subject.taskCount !== receipt.corpus.taskCount ||
		receipt.subject.contentHash !== receipt.corpus.hash
	) {
		context.addIssue({ code: "custom", path: ["corpus"], message: "published corpus does not match the approved subject" });
	}
	const { id: _id, ...identity } = receipt;
	const expected = `corpus-publication-${hashValue(identity).slice("sha256:".length)}`;
	if (receipt.id !== expected) {
		context.addIssue({ code: "custom", path: ["id"], message: "receipt id does not match publication evidence" });
	}
});
export type DevelopmentCorpusPublicationReceipt = z.infer<typeof DevelopmentCorpusPublicationReceiptSchema>;

export interface SaveBuilderSpecDraftOptions {
	stateRoot: string;
	projectId: string;
	spec: AgentSpec;
	sourceText?: string;
	now?: () => string;
}

export interface ApproveBuilderSpecDraftOptions {
	stateRoot: string;
	projectId: string;
	draftSpecId: string;
	expectedDraftSnapshotHash: string;
	actor: { kind: "human"; id: string };
	reason: string;
}

export interface PublishBuilderDevelopmentCorpusOptions {
	stateRoot: string;
	projectId: string;
	name: string;
	tasks: readonly unknown[];
	expectedSubjectHash: string;
	actor: { kind: "human"; id: string };
	reason: string;
}

export interface AuthoringDependencies {
	now: () => string;
}

export interface SpecApprovalResult {
	approved: SpecSnapshot;
	receipt: SpecApprovalReceipt;
	receiptPath: string;
}

export interface DevelopmentCorpusPublicationResult {
	corpus: CorpusMetadata;
	receipt: DevelopmentCorpusPublicationReceipt;
	receiptPath: string;
}

const DEFAULT_DEPENDENCIES: AuthoringDependencies = { now: () => new Date().toISOString() };

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

type ReceiptKind = "spec-approvals" | "corpus-publications";

function receiptRoot(
	stateRoot: string,
	projectIdInput: string,
	kind: ReceiptKind,
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
		throw new Error(`Builder authoring stateRoot must be a regular non-symlink directory: ${root}`);
	}
	const canonicalRoot = realpathSync(root);
	let current = root;
	for (const segment of ["projects", projectId, "builder-authoring", kind]) {
		const next = join(current, segment);
		if (!existsSync(next)) {
			if (!create) return null;
			mkdirSync(next, { mode: 0o700 });
		}
		const entry = lstatSync(next);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`Builder authoring state component must be a regular non-symlink directory: ${next}`);
		}
		if (!contained(canonicalRoot, realpathSync(next))) {
			throw new Error("Builder authoring state path escaped stateRoot");
		}
		current = next;
	}
	return current;
}

function assertPrivateReceiptFile(path: string): void {
	const entry = lstatSync(path);
	if (!entry.isFile() || entry.isSymbolicLink()) {
		throw new Error(`Builder authoring receipt must be a regular non-symlink file: ${path}`);
	}
	const mode = statSync(path).mode & 0o777;
	if (mode !== 0o600) throw new Error(`Builder authoring receipt must have mode 0600, got 0${mode.toString(8)}`);
}

function specApprovalReceiptPath(
	stateRoot: string,
	projectId: string,
	draftSpecIdInput: string,
	create: boolean,
): string {
	const draftSpecId = SpecIdSchema.parse(draftSpecIdInput);
	const root = receiptRoot(stateRoot, projectId, "spec-approvals", create);
	if (!root) throw new Error(`project ${projectId} has no Spec approval receipts`);
	return join(root, `${draftSpecId}.json`);
}

function corpusPublicationReceiptPath(
	stateRoot: string,
	projectId: string,
	corpusIdInput: string,
	create: boolean,
): string {
	const corpusId = CorpusIdSchema.parse(corpusIdInput);
	const root = receiptRoot(stateRoot, projectId, "corpus-publications", create);
	if (!root) throw new Error(`project ${projectId} has no corpus publication receipts`);
	return join(root, `${corpusId}.json`);
}

function sameValue(left: unknown, right: unknown): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

/** Save Builder-authored structured data as a bounded immutable draft. */
export function saveBuilderSpecDraft(options: SaveBuilderSpecDraftOptions): SpecSnapshot {
	if (
		options.sourceText !== undefined &&
		Buffer.byteLength(options.sourceText, "utf8") > MAX_SOURCE_TEXT_BYTES
	) {
		throw new Error(`Spec source text exceeds ${MAX_SOURCE_TEXT_BYTES} bytes`);
	}
	return saveSpecSnapshot({ ...options, status: "draft" });
}

/** Reload the exact immutable draft and produce the value a human must approve. */
export function describeSpecDraftApproval(
	stateRoot: string,
	projectIdInput: string,
	draftSpecIdInput: string,
): SpecDraftApprovalSubject {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const draftSpecId = SpecIdSchema.parse(draftSpecIdInput);
	const draft = loadSpecSnapshot(stateRoot, projectId, draftSpecId);
	if (draft.projectId !== projectId || draft.id !== draftSpecId) throw new Error("Spec draft belongs to a different project");
	if (draft.status !== "draft") throw new Error(`Spec ${draft.id} is ${draft.status}; an exact draft is required`);
	return SpecDraftApprovalSubjectSchema.parse({
		schemaVersion: 1,
		projectId,
		draftSpecId,
		draftSnapshotHash: hashValue(draft),
		specContentHash: hashValue(draft.spec),
	});
}

/**
 * Approve exactly the draft whose hash was shown at the trusted human gate.
 * Actor and reason are host-owned inputs; callers cannot replay one draft's gate.
 */
export function approveBuilderSpecDraft(
	options: ApproveBuilderSpecDraftOptions,
	dependencies: Partial<AuthoringDependencies> = {},
): SpecApprovalResult {
	const now = dependencies.now ?? DEFAULT_DEPENDENCIES.now;
	const projectId = ProjectIdSchema.parse(options.projectId);
	const expectedDraftSnapshotHash = Sha256Schema.parse(options.expectedDraftSnapshotHash);
	const actor = HumanActorSchema.parse(options.actor);
	const reason = ApprovalReasonSchema.parse(options.reason);
	const subject = describeSpecDraftApproval(options.stateRoot, projectId, options.draftSpecId);
	if (subject.draftSnapshotHash !== expectedDraftSnapshotHash) {
		throw new Error("Spec draft changed after review; approval is stale");
	}
	const receiptPath = specApprovalReceiptPath(options.stateRoot, projectId, subject.draftSpecId, true);
	if (existsSync(receiptPath)) {
		assertPrivateReceiptFile(receiptPath);
		throw new Error(`Spec draft ${subject.draftSpecId} already has an approval receipt; replay refused`);
	}

	const draft = loadSpecSnapshot(options.stateRoot, projectId, subject.draftSpecId);
	const approved = saveSpecSnapshot({
		stateRoot: options.stateRoot,
		projectId,
		spec: draft.spec,
		status: "approved",
		now,
	});
	const loadedApproved = loadApprovedSpec({ stateRoot: options.stateRoot, projectId, specId: approved.id });
	const reloadedSubject = describeSpecDraftApproval(options.stateRoot, projectId, subject.draftSpecId);
	if (!sameValue(reloadedSubject, subject)) throw new Error("Spec draft changed while approval was being published");

	const approvedAt = TimestampSchema.parse(now());
	const identity = {
		schemaVersion: 1 as const,
		projectId,
		draft: subject,
		approvedSpec: loadedApproved.reference,
		actor,
		reason,
		approvedAt,
	};
	const receipt = SpecApprovalReceiptSchema.parse({
		...identity,
		id: `spec-approval-${hashValue(identity).slice("sha256:".length)}`,
	});
	writeJsonArtifact(receiptPath, SpecApprovalReceiptSchema, receipt, { immutable: true });
	assertPrivateReceiptFile(receiptPath);
	return { approved: loadedApproved.snapshot, receipt, receiptPath };
}

/** Load a receipt and re-verify both immutable Spec snapshots it binds. */
export function loadSpecApprovalReceipt(
	stateRoot: string,
	projectIdInput: string,
	draftSpecIdInput: string,
): SpecApprovalReceipt {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const draftSpecId = SpecIdSchema.parse(draftSpecIdInput);
	const path = specApprovalReceiptPath(stateRoot, projectId, draftSpecId, false);
	assertPrivateReceiptFile(path);
	const receipt = readJsonArtifact(path, SpecApprovalReceiptSchema);
	if (receipt.projectId !== projectId || receipt.draft.draftSpecId !== draftSpecId) {
		throw new Error("Spec approval receipt belongs to a different project or draft");
	}
	const subject = describeSpecDraftApproval(stateRoot, projectId, draftSpecId);
	if (!sameValue(subject, receipt.draft)) throw new Error("Spec approval receipt no longer matches the exact draft");
	const approved = loadApprovedSpec({ stateRoot, projectId, specId: receipt.approvedSpec.specId });
	if (!sameValue(approved.reference, receipt.approvedSpec)) {
		throw new Error("Spec approval receipt no longer matches the exact approved snapshot");
	}
	return receipt;
}

function normalizeDevelopmentCorpusInput(input: {
	projectId: string;
	name: string;
	tasks: readonly unknown[];
}): { projectId: string; name: string; tasks: BuilderAuthoredCorpusTasks } {
	return {
		projectId: ProjectIdSchema.parse(input.projectId),
		name: DevelopmentCorpusPublicationSubjectSchema.shape.name.parse(input.name),
		tasks: BuilderAuthoredCorpusTasksSchema.parse(input.tasks),
	};
}

/** Produce the immutable content/subject hashes that must be shown at the human gate. */
export function describeDevelopmentCorpusPublication(input: {
	projectId: string;
	name: string;
	tasks: readonly unknown[];
}): DevelopmentCorpusPublicationSubject {
	const normalized = normalizeDevelopmentCorpusInput(input);
	const contentHash = hashValue(normalized.tasks);
	const identity = {
		schemaVersion: 1 as const,
		projectId: normalized.projectId,
		name: normalized.name,
		visibility: "development" as const,
		taskCount: normalized.tasks.length,
		contentHash,
	};
	return DevelopmentCorpusPublicationSubjectSchema.parse({
		...identity,
		subjectHash: hashValue({ ...identity, tasks: normalized.tasks }),
	});
}

function expectedCorpusId(subject: DevelopmentCorpusPublicationSubject): string {
	const identityHash = hashValue({
		schemaVersion: 1,
		projectId: subject.projectId,
		name: subject.name,
		visibility: "development",
		contentHash: subject.contentHash,
	});
	return CorpusIdSchema.parse(`corpus-${identityHash.slice("sha256:".length)}`);
}

function loadExactDevelopmentCorpus(
	stateRoot: string,
	subject: DevelopmentCorpusPublicationSubject,
	tasks: readonly CorpusTask[],
): CorpusMetadata {
	const corpusId = expectedCorpusId(subject);
	const loaded = loadCorpus({ stateRoot, projectId: subject.projectId, corpusId });
	if (
		loaded.metadata.visibility !== "development" ||
		loaded.metadata.name !== subject.name ||
		loaded.metadata.taskCount !== subject.taskCount ||
		loaded.metadata.hash !== subject.contentHash ||
		!sameValue(loaded.tasks, tasks)
	) {
		throw new Error("development corpus no longer matches the exact approved subject");
	}
	return loaded.metadata;
}

/** Publish only the bounded development task set whose exact hash a human approved. */
export function publishBuilderDevelopmentCorpus(
	options: PublishBuilderDevelopmentCorpusOptions,
	dependencies: Partial<AuthoringDependencies> = {},
): DevelopmentCorpusPublicationResult {
	const now = dependencies.now ?? DEFAULT_DEPENDENCIES.now;
	const normalized = normalizeDevelopmentCorpusInput(options);
	const subject = describeDevelopmentCorpusPublication(normalized);
	if (subject.subjectHash !== Sha256Schema.parse(options.expectedSubjectHash)) {
		throw new Error("development corpus changed after review; approval is stale");
	}
	const actor = HumanActorSchema.parse(options.actor);
	const reason = ApprovalReasonSchema.parse(options.reason);
	const corpusId = expectedCorpusId(subject);
	const receiptPath = corpusPublicationReceiptPath(options.stateRoot, normalized.projectId, corpusId, true);
	if (existsSync(receiptPath)) {
		assertPrivateReceiptFile(receiptPath);
		throw new Error(`development corpus ${corpusId} already has a publication receipt; replay refused`);
	}

	const alreadyExists = listCorpora({ stateRoot: options.stateRoot, projectId: normalized.projectId })
		.some((corpus) => corpus.id === corpusId);
	if (!alreadyExists) {
		try {
			createCorpus({
				stateRoot: options.stateRoot,
				projectId: normalized.projectId,
				name: normalized.name,
				visibility: "development",
				tasks: normalized.tasks,
			});
		} catch (error) {
			// A concurrent publisher may have won the content-addressed directory.
			// Only accept that race if the exact corpus now exists and revalidates below.
			const appeared = listCorpora({ stateRoot: options.stateRoot, projectId: normalized.projectId })
				.some((corpus) => corpus.id === corpusId);
			if (!appeared) throw error;
		}
	}
	const corpus = loadExactDevelopmentCorpus(options.stateRoot, subject, normalized.tasks);
	const publishedAt = TimestampSchema.parse(now());
	const identity = {
		schemaVersion: 1 as const,
		projectId: normalized.projectId,
		subject,
		corpus: CorpusMetadataSchema.extend({ visibility: z.literal("development") }).parse(corpus),
		actor,
		reason,
		publishedAt,
	};
	const receipt = DevelopmentCorpusPublicationReceiptSchema.parse({
		...identity,
		id: `corpus-publication-${hashValue(identity).slice("sha256:".length)}`,
	});
	writeJsonArtifact(receiptPath, DevelopmentCorpusPublicationReceiptSchema, receipt, { immutable: true });
	assertPrivateReceiptFile(receiptPath);
	return { corpus, receipt, receiptPath };
}

/** Load a publication receipt and re-verify the exact development task content. */
export function loadDevelopmentCorpusPublicationReceipt(
	stateRoot: string,
	projectIdInput: string,
	corpusIdInput: string,
): DevelopmentCorpusPublicationReceipt {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const corpusId = CorpusIdSchema.parse(corpusIdInput);
	const path = corpusPublicationReceiptPath(stateRoot, projectId, corpusId, false);
	assertPrivateReceiptFile(path);
	const receipt = readJsonArtifact(path, DevelopmentCorpusPublicationReceiptSchema);
	if (receipt.projectId !== projectId || receipt.corpus.id !== corpusId) {
		throw new Error("corpus publication receipt belongs to a different project or corpus");
	}
	const loaded = loadCorpus({ stateRoot, projectId, corpusId });
	if (loaded.metadata.visibility !== "development") throw new Error("Builder publication receipt cannot reference a sealed corpus");
	const subject = describeDevelopmentCorpusPublication({
		projectId,
		name: loaded.metadata.name,
		tasks: loaded.tasks,
	});
	if (!sameValue(subject, receipt.subject) || !sameValue(loaded.metadata, receipt.corpus)) {
		throw new Error("corpus publication receipt no longer matches exact development content");
	}
	return receipt;
}

const BUILDER_AUTHORED_BACKEND = "ahde-builder-pi";
const BUILDER_AUTHORED_VERSION = "ahde-builder-pi-authoring/1";
const BUILDER_AUTHORED_CAPABILITIES: BuilderCapabilities = {
	eventStream: true,
	structuredOutput: true,
	usage: false,
	cost: false,
	sessionId: false,
	cancellation: true,
	isolation: "tool-free-executor",
};

/** Adapter for a proposal already authored by the primary Builder Pi session. */
export function createBuilderAuthoredProposalAdapter(
	value: CandidateProposal,
	dependencies: Partial<AuthoringDependencies> = {},
): BuilderAdapter {
	const now = dependencies.now ?? DEFAULT_DEPENDENCIES.now;
	const proposal = CandidateProposalSchema.parse(value);
	return {
		backend: BUILDER_AUTHORED_BACKEND,
		capabilities: BUILDER_AUTHORED_CAPABILITIES,
		async probe() {
			return {
				backend: BUILDER_AUTHORED_BACKEND,
				available: true,
				version: BUILDER_AUTHORED_VERSION,
				capabilities: BUILDER_AUTHORED_CAPABILITIES,
				error: null,
			};
		},
		async run(request) {
			if (request.signal?.aborted) throw new Error("Builder-authored proposal recording was cancelled");
			const validated = validateCandidateProposal(proposal, request);
			const startedAt = now();
			const finishedAt = now();
			return BuilderRunRecordSchema.parse({
				schemaVersion: 1,
				runId: request.runId,
				backend: BUILDER_AUTHORED_BACKEND,
				backendVersion: BUILDER_AUTHORED_VERSION,
				capabilities: BUILDER_AUTHORED_CAPABILITIES,
				baseTargetSha: request.baseTargetSha,
				startedAt,
				finishedAt,
				status: "completed",
				proposal: validated,
				model: null,
				sessionId: null,
				usage: null,
				costUsd: null,
				traceLevel: "full",
				rawEvents: [canonicalJson({
					type: "builder_authored_proposal",
					proposalSha256: hashValue(validated),
				})],
				error: null,
			});
		},
	};
}

export type RecordBuilderAuthoredProposalOptions = Omit<
	RunApprovedSpecBuilderProposalOptions,
	"adapter"
> & {
	proposal: CandidateProposal;
};

/**
 * Record the proposal already authored in the primary Builder Pi as a normal
 * canonical run. The existing service reconstructs and binds approved Spec,
 * development EvalRun, Diagnosis, target revision, and corpus provenance.
 */
export function recordBuilderAuthoredProposal(
	options: RecordBuilderAuthoredProposalOptions,
	dependencies: Partial<BuilderProposalDependencies> = {},
): Promise<BuilderProposalRunResult> {
	const { proposal, ...canonicalOptions } = options;
	const parsedProposal = CandidateProposalSchema.parse(proposal);
	const adapter = createBuilderAuthoredProposalAdapter(
		parsedProposal,
		dependencies.now ? { now: dependencies.now } : {},
	);
	return runApprovedSpecBuilderProposal({ ...canonicalOptions, adapter }, dependencies);
}
