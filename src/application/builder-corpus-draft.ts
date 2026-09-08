import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CorpusTaskSchema, type CorpusTask } from "../corpus.js";
import { GraderSpec, TaskSchema, taskDialogueIssue, type CaseSource, isDeterministicGrader } from "../manifest.js";
import { canonicalJson, HashSchema, hashValue } from "../provenance.js";
import {
	ApprovedSpecReferenceSchema,
	loadApprovedSpec,
	type ApprovedSpecReference,
} from "../spec.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import {
	BuilderCorpusImportSourceSchema,
	type BuilderCorpusImportSource,
} from "./builder-corpus-import-contract.js";
import { ProductionFailureProvenanceSourceSchema } from "./failure-intake.js";
import { CorpusSourceBindingSchema, type CorpusSourceBinding } from "./corpus-source.js";
import { contained, projectStateDir } from "../storage/paths.js";

/** A draft stays small enough for a human to read every case before publishing. */
export const MAX_BUILDER_CORPUS_DRAFT_TASKS = 100;
const MAX_DRAFT_TASKS = MAX_BUILDER_CORPUS_DRAFT_TASKS;
const MAX_TASK_BYTES = 64 * 1024;
const MAX_DRAFT_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_DRAFT_ARTIFACT_BYTES = MAX_DRAFT_CONTENT_BYTES + 64 * 1024;
const MAX_REVISION_OPERATIONS = 200;
const MAX_REVISION_OPERATIONS_BYTES = 2 * 1024 * 1024;

const ProjectIdSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "projectId must be one safe path segment");
const DraftIdSchema = z
	.string()
	.regex(/^corpus-draft-[0-9a-f]{64}$/, "draftId must be a canonical corpus draft identifier");
const TaskIdSchema = z
	.string()
	.regex(/^task-[0-9a-f]{64}$/, "taskId must be a canonical derived task identifier");
const NonBlankSchema = z
	.string()
	.min(1)
	.refine((value) => value.trim().length > 0, "expected non-blank text");
const DraftNameSchema = z.string().trim().min(1).max(200);
const GraderIndexSchema = z.number().int().min(0).max(15);
export const BuilderCorpusDraftCoverageNotesSchema = z.array(NonBlankSchema.max(1_000)).max(100)
	.describe("Explain covered behaviours, synthetic fixture assumptions and unresolved coverage. Unknown business rules are questions, not invented scored answers. Simulator cases exercise model-generated dialogue, not proven real-user behaviour.");
const RevisionSummarySchema = NonBlankSchema.max(4_000);
const ExclusionReasonSchema = NonBlankSchema.max(500)
	.describe("Why this case is not a valid test. Never “it fails”: a failing correct case is capability work, not an exclusion.");

/** One case taken out of the basket, and the reason that took it out. */
export const BuilderCorpusDraftExclusionSchema = z.strictObject({
	taskId: TaskIdSchema,
	reason: ExclusionReasonSchema,
	at: z.iso.datetime({ offset: true }),
});
export type BuilderCorpusDraftExclusion = z.infer<typeof BuilderCorpusDraftExclusionSchema>;
const MAX_EXCLUSIONS = 500;

/**
 * Builder input deliberately omits task ids; the trusted host derives them.
 * The optional case fields reuse `manifest.ts` schemas verbatim, so a
 * compiled dataset case and a hand-written one are bounded identically, and
 * the dialogue invariant is checked on this path too.
 */
export const BuilderCorpusDraftTaskInputSchema = z.strictObject({
	input: NonBlankSchema.max(32_000),
	expected: TaskSchema.shape.expected,
	messages: TaskSchema.shape.messages,
	// A case may instead ask a second model to play the user for N turns.
	// `taskDialogueIssue` below is the one place that refuses both at once.
	simulatedUser: TaskSchema.shape.simulatedUser,
	// The world a case happens in travels with the case: this is an explicit
	// field list, so omitting it would drop the world between draft and corpus.
	world: TaskSchema.shape.world,
	metadata: TaskSchema.shape.metadata,
	// Which cell of the basket this case fills, and where it came from. Both are
	// checked against the world outside the draft — the approved Spec's jobs and
	// the bytes the citation names — before the draft is written.
	coverage: TaskSchema.shape.coverage,
	source: TaskSchema.shape.source,
	graders: z.array(GraderSpec).min(1).max(16),
}).superRefine((task, context) => {
	const dialogue = taskDialogueIssue(task);
	if (dialogue) context.addIssue({ code: "custom", path: ["messages"], message: dialogue });
	if (Buffer.byteLength(canonicalJson(task), "utf8") > MAX_TASK_BYTES) {
		context.addIssue({ code: "custom", message: `task exceeds ${MAX_TASK_BYTES} bytes` });
	}
});
export type BuilderCorpusDraftTaskInput = z.infer<typeof BuilderCorpusDraftTaskInputSchema>;

const BuilderCorpusDraftStoredTaskSchema = CorpusTaskSchema.extend({
	id: TaskIdSchema,
	input: NonBlankSchema.max(32_000),
	graders: z.array(GraderSpec).min(1).max(16),
}).superRefine((task, context) => {
	const { id: _id, ...input } = task;
	const dialogue = taskDialogueIssue(task);
	if (dialogue) context.addIssue({ code: "custom", path: ["messages"], message: dialogue });
	if (Buffer.byteLength(canonicalJson(input), "utf8") > MAX_TASK_BYTES) {
		context.addIssue({ code: "custom", message: `task exceeds ${MAX_TASK_BYTES} bytes` });
	}
});

export const BuilderCorpusDraftTasksInputSchema = z
	.array(BuilderCorpusDraftTaskInputSchema)
	.min(1)
	.max(MAX_DRAFT_TASKS);

export const BuilderCorpusDraftRevisionOperationSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("add"),
		task: BuilderCorpusDraftTaskInputSchema,
	}),
	z.strictObject({
		type: z.literal("replace"),
		taskId: TaskIdSchema,
		task: BuilderCorpusDraftTaskInputSchema,
	}),
	z.strictObject({
		type: z.literal("remove"),
		taskId: TaskIdSchema,
		// A case is never dropped for failing. Taking one out is an exclusion, and
		// an exclusion without a stated reason is indistinguishable from deleting
		// the hard tasks until the numbers look better.
		reason: ExclusionReasonSchema,
	}),
	z.strictObject({
		type: z.literal("set-graders"),
		taskId: TaskIdSchema,
		graders: z.array(GraderSpec).min(1).max(16),
	}),
	z.strictObject({
		type: z.literal("grader.add"),
		taskId: TaskIdSchema,
		grader: GraderSpec,
	}),
	z.strictObject({
		type: z.literal("grader.update"),
		taskId: TaskIdSchema,
		graderIndex: GraderIndexSchema,
		grader: GraderSpec,
	}),
	z.strictObject({
		type: z.literal("grader.remove"),
		taskId: TaskIdSchema,
		graderIndex: GraderIndexSchema,
	}),
	z.strictObject({
		type: z.literal("rename"),
		name: DraftNameSchema,
	}),
	z.strictObject({
		type: z.literal("set-notes"),
		coverageNotes: BuilderCorpusDraftCoverageNotesSchema,
	}),
]);
export type BuilderCorpusDraftRevisionOperation = z.infer<typeof BuilderCorpusDraftRevisionOperationSchema>;

export const BuilderCorpusDraftDevelopmentFailureTaskProvenanceSchema = z.strictObject({
	kind: z.literal("development-failure"),
	taskId: TaskIdSchema,
	source: z.strictObject({
		corpusId: z.string().regex(/^corpus-[0-9a-f]{64}$/),
		corpusHash: HashSchema,
		evalRunId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),
		evalRunHash: HashSchema,
		runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),
		runHash: HashSchema,
		tracePath: z.literal("session.jsonl"),
		traceSha256: HashSchema,
		sourceTaskId: z.string().min(1).max(500),
		sourceTaskHash: HashSchema,
	}),
});
export const BuilderCorpusDraftProductionFailureTaskProvenanceSchema = z.strictObject({
	kind: z.literal("production-failure"),
	taskId: TaskIdSchema,
	// Optional-never legacy keys keep source inspection type-compatible for
	// callers that already narrow `kind` at runtime. The strict schema still
	// refuses every one of them on a production provenance record.
	source: ProductionFailureProvenanceSourceSchema.extend({
		corpusId: z.never().optional(),
		corpusHash: z.never().optional(),
		evalRunId: z.never().optional(),
		evalRunHash: z.never().optional(),
		runId: z.never().optional(),
		runHash: z.never().optional(),
		tracePath: z.never().optional(),
		traceSha256: z.never().optional(),
		sourceTaskId: z.never().optional(),
		sourceTaskHash: z.never().optional(),
	}),
});
export const BuilderCorpusDraftTaskProvenanceSchema = z.discriminatedUnion("kind", [
	BuilderCorpusDraftDevelopmentFailureTaskProvenanceSchema,
	BuilderCorpusDraftProductionFailureTaskProvenanceSchema,
]);
export type BuilderCorpusDraftTaskProvenance = z.infer<typeof BuilderCorpusDraftTaskProvenanceSchema>;

export const BuilderCorpusDraftVerifiedProvenanceBindingSchema = z.strictObject({
	operationIndex: z.number().int().min(0).max(MAX_REVISION_OPERATIONS - 1),
	provenance: BuilderCorpusDraftTaskProvenanceSchema,
});
export type BuilderCorpusDraftVerifiedProvenanceBinding = z.infer<
	typeof BuilderCorpusDraftVerifiedProvenanceBindingSchema
>;

export const BuilderCorpusDraftRevisionOperationsSchema = z
	.array(BuilderCorpusDraftRevisionOperationSchema)
	.min(1)
	.max(MAX_REVISION_OPERATIONS)
	.superRefine((operations, context) => {
		if (Buffer.byteLength(canonicalJson(operations), "utf8") > MAX_REVISION_OPERATIONS_BYTES) {
			context.addIssue({
				code: "custom",
				message: `revision operations exceed ${MAX_REVISION_OPERATIONS_BYTES} bytes`,
			});
		}
	});

interface BuilderCorpusDraftIdentity {
	schemaVersion: 2 | 3 | 4;
	kind: "builder-corpus-draft";
	projectId: string;
	approvedSpec: ApprovedSpecReference;
	parentDraftId: string | null;
	name: string;
	tasks: CorpusTask[];
	importSource?: BuilderCorpusImportSource;
	sourceBinding?: CorpusSourceBinding;
	taskProvenance?: BuilderCorpusDraftTaskProvenance[];
	/** Absent on every draft that never excluded a case, so old ids still verify. */
	exclusions?: BuilderCorpusDraftExclusion[];
	coverageNotes: string[];
	revisionSummary: string;
	source: "builder-pi";
}

export function builderCorpusDraftTaskId(approvedSpec: ApprovedSpecReference, task: BuilderCorpusDraftTaskInput): string {
	const identity = hashValue({ schemaVersion: 2, approvedSpec, task });
	return `task-${identity.slice("sha256:".length)}`;
}

/** What a task's labels are checked against: the Spec that names the jobs, and the sources on disk. */
interface TaskLabelChecks {
	/** The approved Spec's jobs, verbatim; a coverage label must name one of them. */
	jobs: readonly string[];
	/** Host-side verification of a model-facing citation, when a Target is resolved. */
	verifySource?: ((source: CaseSource) => void) | undefined;
}

function normalizeTasks(
	approvedSpec: ApprovedSpecReference,
	tasksInput: readonly unknown[],
	checks: TaskLabelChecks,
): CorpusTask[] {
	const inputs = BuilderCorpusDraftTasksInputSchema.parse(tasksInput);
	const tasks = inputs.map((task) => CorpusTaskSchema.parse({
		id: builderCorpusDraftTaskId(approvedSpec, task),
		...task,
	}));
	const seen = new Set<string>();
	for (const task of tasks) {
		if (seen.has(task.id)) throw new Error("Builder corpus draft contains duplicate task content");
		seen.add(task.id);
		// A coverage matrix whose rows are the author's paraphrases measures
		// nothing against the Spec, so the job must be one of the Spec's own.
		if (task.coverage && !checks.jobs.includes(task.coverage.job)) {
			throw new Error(
				`coverage.job ${JSON.stringify(task.coverage.job)} is not a job of the approved Spec; ` +
				`use one of: ${checks.jobs.map((job) => JSON.stringify(job)).join(", ")}`,
			);
		}
		if (task.source) {
			if (task.source.kind === "production" || task.source.kind === "generated") {
				throw new Error(`source.kind ${task.source.kind} is host-minted and cannot be written by a Builder`);
			}
			checks.verifySource?.(task.source);
		}
		// A simulated dialogue is scored by its outcome: what the world says
		// afterwards, or a check that reads the transcript deterministically. A
		// judge-only simulated case proves nothing about the interaction the
		// simulator exists to test, only that two models agreed with each other.
		if (task.simulatedUser && !task.world?.expect?.length && !task.graders.some(isDeterministicGrader)) {
			throw new Error(
				`simulated-user case “${task.input.slice(0, 80)}” is scored only by a judge; add a world.expect or a deterministic grader ` +
				"(world_state, tool_called, output_contains, output_matches, turn_budget) so its outcome decides the case",
			);
		}
	}
	return tasks;
}

function draftIdentity(record: BuilderCorpusDraftIdentity): string {
	return `corpus-draft-${hashValue(record).slice("sha256:".length)}`;
}

export const BuilderCorpusDraftSchema = z.strictObject({
	schemaVersion: z.union([z.literal(2), z.literal(3), z.literal(4)]),
	kind: z.literal("builder-corpus-draft"),
	id: DraftIdSchema,
	projectId: ProjectIdSchema,
	approvedSpec: ApprovedSpecReferenceSchema,
	parentDraftId: DraftIdSchema.nullable(),
	name: DraftNameSchema,
	tasks: z.array(BuilderCorpusDraftStoredTaskSchema).min(1).max(MAX_DRAFT_TASKS),
	importSource: BuilderCorpusImportSourceSchema.optional(),
	sourceBinding: CorpusSourceBindingSchema.optional(),
	taskProvenance: z.array(BuilderCorpusDraftTaskProvenanceSchema).max(MAX_DRAFT_TASKS).optional(),
	/** Optional so drafts written before exclusions carried reasons still load and still hash. */
	exclusions: z.array(BuilderCorpusDraftExclusionSchema).max(MAX_EXCLUSIONS).optional(),
	coverageNotes: BuilderCorpusDraftCoverageNotesSchema,
	revisionSummary: RevisionSummarySchema,
	source: z.literal("builder-pi"),
	createdAt: z.iso.datetime({ offset: true }),
}).superRefine((draft, context) => {
	if ((draft.schemaVersion === 4) !== (draft.sourceBinding !== undefined)) {
		context.addIssue({
			code: "custom",
			path: ["sourceBinding"],
			message: "sourceBinding requires Builder corpus draft schemaVersion 4, and version 4 requires sourceBinding",
		});
	}
	if (draft.schemaVersion === 2 && draft.taskProvenance?.some((entry) => entry.kind === "production-failure")) {
		context.addIssue({
			code: "custom",
			path: ["taskProvenance"],
			message: "production-failure provenance requires Builder corpus draft schemaVersion 3",
		});
	}
	if (draft.projectId !== draft.approvedSpec.projectId) {
		context.addIssue({
			code: "custom",
			path: ["projectId"],
			message: "draft project must match its exact approved Spec reference",
		});
	}

	const taskIds = new Set<string>();
	for (const [index, task] of draft.tasks.entries()) {
		const { id: _id, ...input } = task;
		const expected = builderCorpusDraftTaskId(draft.approvedSpec, input);
		if (task.id !== expected) {
			context.addIssue({
				code: "custom",
				path: ["tasks", index, "id"],
				message: "task id does not match the approved Spec and task content",
			});
		}
		if (taskIds.has(task.id)) {
			context.addIssue({
				code: "custom",
				path: ["tasks", index, "id"],
				message: "task ids must be unique",
			});
		}
		taskIds.add(task.id);
	}
	const provenanceTaskIds = new Set<string>();
	for (const [index, provenance] of (draft.taskProvenance ?? []).entries()) {
		if (!taskIds.has(provenance.taskId)) {
			context.addIssue({
				code: "custom",
				path: ["taskProvenance", index, "taskId"],
				message: "task provenance must reference a task in this draft",
			});
		}
		if (provenanceTaskIds.has(provenance.taskId)) {
			context.addIssue({
				code: "custom",
				path: ["taskProvenance", index, "taskId"],
				message: "each task may have only one failure provenance record",
			});
		}
		provenanceTaskIds.add(provenance.taskId);
	}

	const identity: BuilderCorpusDraftIdentity = {
		schemaVersion: draft.schemaVersion,
		kind: draft.kind,
		projectId: draft.projectId,
		approvedSpec: draft.approvedSpec,
		parentDraftId: draft.parentDraftId,
		name: draft.name,
		tasks: draft.tasks,
		...(draft.importSource !== undefined ? { importSource: draft.importSource } : {}),
		...(draft.sourceBinding !== undefined ? { sourceBinding: draft.sourceBinding } : {}),
		...(draft.taskProvenance !== undefined ? { taskProvenance: draft.taskProvenance } : {}),
		...(draft.exclusions !== undefined ? { exclusions: draft.exclusions } : {}),
		coverageNotes: draft.coverageNotes,
		revisionSummary: draft.revisionSummary,
		source: draft.source,
	};
	if (Buffer.byteLength(canonicalJson(identity), "utf8") > MAX_DRAFT_CONTENT_BYTES) {
		context.addIssue({ code: "custom", message: `draft content exceeds ${MAX_DRAFT_CONTENT_BYTES} bytes` });
	}
	if (draft.id !== draftIdentity(identity)) {
		context.addIssue({ code: "custom", path: ["id"], message: "draft id does not match its content" });
	}
	if (draft.parentDraftId === draft.id) {
		context.addIssue({ code: "custom", path: ["parentDraftId"], message: "draft cannot be its own parent" });
	}
});
export type BuilderCorpusDraft = z.infer<typeof BuilderCorpusDraftSchema>;

export interface CreateBuilderCorpusDraftOptions {
	stateRoot: string;
	approvedSpec: ApprovedSpecReference;
	name: string;
	tasks: readonly unknown[];
	coverageNotes?: readonly string[];
	/** Trusted host-derived import provenance; model-facing draft schemas cannot populate it. */
	verifiedImportSource?: unknown;
	/** Host-captured KB source identity; never accepted from model-facing draft inputs. */
	sourceBinding?: CorpusSourceBinding;
	/** Trusted host-derived task provenance; model-facing draft schemas cannot populate it. */
	verifiedTaskProvenance?: readonly unknown[];
	/** Host check of every model-written citation; absent where no Target is resolved to check against. */
	verifySource?: (source: CaseSource) => void;
	revisionSummary: string;
}

export interface ReviseBuilderCorpusDraftOptions {
	stateRoot: string;
	approvedSpec: ApprovedSpecReference;
	parentDraftId: string;
	operations: readonly unknown[];
	/** Trusted host-derived, operation-bound provenance; model-facing schemas cannot populate it. */
	verifiedTaskProvenance?: readonly unknown[];
	/** Host check of every model-written citation; absent where no Target is resolved to check against. */
	verifySource?: (source: CaseSource) => void;
	revisionSummary: string;
}

export interface BuilderCorpusDraftResult {
	draft: BuilderCorpusDraft;
	path: string;
}

export interface BuilderCorpusDraftDependencies {
	now: () => string;
}

const DEFAULT_DEPENDENCIES: BuilderCorpusDraftDependencies = {
	now: () => new Date().toISOString(),
};

function draftsRoot(stateRoot: string, projectIdInput: string, create: boolean): string | null {
	return projectStateDir(stateRoot, projectIdInput, "builder-corpus-drafts", { create, label: "Builder corpus draft" });
}

function artifactPath(stateRoot: string, projectId: string, draftIdInput: string): string {
	const draftId = DraftIdSchema.parse(draftIdInput);
	const root = draftsRoot(stateRoot, projectId, false);
	if (!root) throw new Error(`project ${projectId} has no Builder corpus drafts`);
	return join(root, `${draftId}.json`);
}

/** The exact reference, plus the jobs a coverage label has to name. */
function exactApprovedSpec(
	stateRoot: string,
	referenceInput: ApprovedSpecReference,
): { reference: ApprovedSpecReference; jobs: readonly string[] } {
	const reference = ApprovedSpecReferenceSchema.parse(referenceInput);
	const loaded = loadApprovedSpec({
		stateRoot,
		projectId: reference.projectId,
		specId: reference.specId,
	});
	if (canonicalJson(loaded.reference) !== canonicalJson(reference)) {
		throw new Error("approved Spec reference does not match the exact stored snapshot");
	}
	return { reference, jobs: loaded.snapshot.spec.jobs };
}

function identityOf(draft: BuilderCorpusDraft): BuilderCorpusDraftIdentity {
	return {
		schemaVersion: draft.schemaVersion,
		kind: draft.kind,
		projectId: draft.projectId,
		approvedSpec: draft.approvedSpec,
		parentDraftId: draft.parentDraftId,
		name: draft.name,
		tasks: draft.tasks,
		...(draft.importSource !== undefined ? { importSource: draft.importSource } : {}),
		...(draft.sourceBinding !== undefined ? { sourceBinding: draft.sourceBinding } : {}),
		...(draft.taskProvenance !== undefined ? { taskProvenance: draft.taskProvenance } : {}),
		...(draft.exclusions !== undefined ? { exclusions: draft.exclusions } : {}),
		coverageNotes: draft.coverageNotes,
		revisionSummary: draft.revisionSummary,
		source: draft.source,
	};
}

function publishDraft(
	stateRoot: string,
	identity: BuilderCorpusDraftIdentity,
	dependencies: Partial<BuilderCorpusDraftDependencies>,
): BuilderCorpusDraftResult {
	const draft = BuilderCorpusDraftSchema.parse({
		...identity,
		id: draftIdentity(identity),
		createdAt: (dependencies.now ?? DEFAULT_DEPENDENCIES.now)(),
	});
	const root = draftsRoot(stateRoot, draft.projectId, true);
	if (!root) throw new Error("failed to create Builder corpus draft state directory");
	const path = join(root, `${draft.id}.json`);
	if (existsSync(path)) {
		const existing = readJsonArtifact(path, BuilderCorpusDraftSchema, { maxBytes: MAX_DRAFT_ARTIFACT_BYTES });
		if (canonicalJson(identityOf(existing)) !== canonicalJson(identity)) {
			throw new Error(`content-address collision for Builder corpus draft ${draft.id}`);
		}
		return { draft: existing, path };
	}
	try {
		writeJsonArtifact(path, BuilderCorpusDraftSchema, draft, { immutable: true });
	} catch (error) {
		if (!existsSync(path)) throw error;
		const existing = readJsonArtifact(path, BuilderCorpusDraftSchema, { maxBytes: MAX_DRAFT_ARTIFACT_BYTES });
		if (canonicalJson(identityOf(existing)) !== canonicalJson(identity)) throw error;
		return { draft: existing, path };
	}
	return { draft, path };
}

/** Create the first immutable corpus draft for one exact approved Spec. */
export function createBuilderCorpusDraft(
	options: CreateBuilderCorpusDraftOptions,
	dependencies: Partial<BuilderCorpusDraftDependencies> = {},
): BuilderCorpusDraftResult {
	const { reference: approvedSpec, jobs } = exactApprovedSpec(options.stateRoot, options.approvedSpec);
	const checks: TaskLabelChecks = { jobs, verifySource: options.verifySource };
	const tasks = normalizeTasks(approvedSpec, options.tasks, checks);
	const taskProvenance = z.array(BuilderCorpusDraftTaskProvenanceSchema).max(MAX_DRAFT_TASKS)
		.parse(options.verifiedTaskProvenance ?? []);
	const identity: BuilderCorpusDraftIdentity = {
		schemaVersion: options.sourceBinding !== undefined ? 4
			: taskProvenance.some((provenance) => provenance.kind === "production-failure") ? 3 : 2,
		kind: "builder-corpus-draft",
		projectId: approvedSpec.projectId,
		approvedSpec,
		parentDraftId: null,
		name: DraftNameSchema.parse(options.name),
		tasks,
		...(options.verifiedImportSource !== undefined
			? { importSource: BuilderCorpusImportSourceSchema.parse(options.verifiedImportSource) }
			: {}),
		...(options.sourceBinding !== undefined
			? { sourceBinding: CorpusSourceBindingSchema.parse(options.sourceBinding) }
			: {}),
		...(taskProvenance.length > 0 ? { taskProvenance } : {}),
		coverageNotes: BuilderCorpusDraftCoverageNotesSchema.parse(options.coverageNotes ?? []),
		revisionSummary: RevisionSummarySchema.parse(options.revisionSummary),
		source: "builder-pi",
	};
	return publishDraft(options.stateRoot, identity, dependencies);
}

function taskIndex(tasks: CorpusTask[], taskIdInput: string, operation: string): number {
	const taskId = TaskIdSchema.parse(taskIdInput);
	const index = tasks.findIndex((task) => task.id === taskId);
	if (index < 0) throw new Error(`${operation} references unknown task ${taskId}`);
	return index;
}

/** Apply bounded semantic operations and publish a new immutable child draft. */
export function reviseBuilderCorpusDraft(
	options: ReviseBuilderCorpusDraftOptions,
	dependencies: Partial<BuilderCorpusDraftDependencies> & {
		/** Check the final task context once all operations are applied, before writing the child. */
		validateTasks?: (tasks: readonly CorpusTask[]) => void;
	} = {},
): BuilderCorpusDraftResult {
	const { reference: approvedSpec, jobs } = exactApprovedSpec(options.stateRoot, options.approvedSpec);
	const checks: TaskLabelChecks = { jobs, verifySource: options.verifySource };
	const now = dependencies.now ?? DEFAULT_DEPENDENCIES.now;
	const parentDraftId = DraftIdSchema.parse(options.parentDraftId);
	const parent = loadBuilderCorpusDraft(options.stateRoot, approvedSpec.projectId, parentDraftId);
	if (parent.projectId !== approvedSpec.projectId) {
		throw new Error("parent corpus draft belongs to a different project");
	}
	if (canonicalJson(parent.approvedSpec) !== canonicalJson(approvedSpec)) {
		throw new Error("parent corpus draft belongs to a different approved Spec");
	}

	const operations = BuilderCorpusDraftRevisionOperationsSchema.parse(options.operations);
	let name = parent.name;
	let coverageNotes = [...parent.coverageNotes];
	// Carried forward, never rewritten: the lineage of what left the basket is
	// the only defence against a basket that improves by losing its hard cases.
	const exclusions: BuilderCorpusDraftExclusion[] = [...(parent.exclusions ?? [])];
	const tasks = parent.tasks.map((task) => ({ ...task, graders: task.graders.map((grader) => ({ ...grader })) }));
	const knownTaskProvenance = new Map(
		(parent.taskProvenance ?? []).map((provenance) => [provenance.taskId, provenance] as const),
	);
	const taskProvenance = new Map(knownTaskProvenance);
	const replaceGraders = (taskId: string, graders: readonly unknown[], operation: string): void => {
		const index = taskIndex(tasks, taskId, operation);
		// Everything but the graders survives a regrade, including a reference
		// answer, a dialogue, and imported row metadata.
		const { id: _previousId, graders: _previousGraders, ...carried } = tasks[index]!;
		const normalized = normalizeTasks(approvedSpec, [{ ...carried, graders }], checks)[0];
		if (!normalized) throw new Error(`${operation} did not produce a task`);
		const provenance = taskProvenance.get(taskId);
		if (provenance) {
			taskProvenance.delete(taskId);
			const remapped = { ...provenance, taskId: normalized.id };
			taskProvenance.set(normalized.id, remapped);
			knownTaskProvenance.set(normalized.id, remapped);
		}
		tasks[index] = normalized;
	};
	const exactGraderIndex = (taskId: string, graderIndex: number, operation: string): {
		task: CorpusTask;
		index: number;
	} => {
		const task = tasks[taskIndex(tasks, taskId, operation)]!;
		if (graderIndex >= task.graders.length) {
			throw new Error(`${operation} references unknown grader index ${graderIndex} on task ${taskId}`);
		}
		return { task, index: graderIndex };
	};
	const pendingVerifiedProvenance = new Map<number, BuilderCorpusDraftTaskProvenance>();
	for (const binding of z.array(BuilderCorpusDraftVerifiedProvenanceBindingSchema).max(MAX_DRAFT_TASKS)
		.parse(options.verifiedTaskProvenance ?? [])) {
		if (pendingVerifiedProvenance.has(binding.operationIndex)) {
			throw new Error(`revision operation ${binding.operationIndex} has duplicate verified failure provenance`);
		}
		pendingVerifiedProvenance.set(binding.operationIndex, binding.provenance);
	}
	for (const [operationIndex, operation] of operations.entries()) {
		const verifiedProvenance = pendingVerifiedProvenance.get(operationIndex);
		if (verifiedProvenance && operation.type !== "add") {
			throw new Error(`verified failure provenance must bind an add operation, not ${operation.type}`);
		}
		switch (operation.type) {
			case "add": {
				const normalized = normalizeTasks(approvedSpec, [operation.task], checks)[0];
				if (!normalized) throw new Error("add operation did not produce a task");
				tasks.push(normalized);
				if (verifiedProvenance) {
					if (verifiedProvenance.taskId !== normalized.id) {
						throw new Error(`verified failure provenance does not match task added by operation ${operationIndex}`);
					}
					if (taskProvenance.has(normalized.id)) {
						throw new Error(`task ${normalized.id} already has failure provenance`);
					}
					taskProvenance.set(normalized.id, verifiedProvenance);
					knownTaskProvenance.set(normalized.id, verifiedProvenance);
					pendingVerifiedProvenance.delete(operationIndex);
				}
				break;
			}
			case "replace": {
				const index = taskIndex(tasks, operation.taskId, "replace");
				const normalized = normalizeTasks(approvedSpec, [operation.task], checks)[0];
				if (!normalized) throw new Error("replace operation did not produce a task");
				taskProvenance.delete(operation.taskId);
				tasks[index] = normalized;
				break;
			}
			case "remove": {
				const index = taskIndex(tasks, operation.taskId, "remove");
				taskProvenance.delete(operation.taskId);
				tasks.splice(index, 1);
				exclusions.push({ taskId: operation.taskId, reason: operation.reason, at: now() });
				break;
			}
			case "set-graders":
				replaceGraders(operation.taskId, operation.graders, "set-graders");
				break;
			case "grader.add": {
				const task = tasks[taskIndex(tasks, operation.taskId, "grader.add")]!;
				replaceGraders(operation.taskId, [...task.graders, operation.grader], "grader.add");
				break;
			}
			case "grader.update": {
				const { task, index } = exactGraderIndex(operation.taskId, operation.graderIndex, "grader.update");
				replaceGraders(
					operation.taskId,
					task.graders.map((grader, graderIndex) => graderIndex === index ? operation.grader : grader),
					"grader.update",
				);
				break;
			}
			case "grader.remove": {
				const { task, index } = exactGraderIndex(operation.taskId, operation.graderIndex, "grader.remove");
				replaceGraders(
					operation.taskId,
					task.graders.filter((_grader, graderIndex) => graderIndex !== index),
					"grader.remove",
				);
				break;
			}
			case "rename":
				name = operation.name;
				break;
			case "set-notes":
				coverageNotes = [...operation.coverageNotes];
				break;
		}
	}
	if (pendingVerifiedProvenance.size > 0) {
		throw new Error(
			`verified failure provenance was not consumed by operation(s): ${[
				...pendingVerifiedProvenance.keys(),
			].join(", ")}`,
		);
	}
	const finalTaskIds = new Set(tasks.map((task) => task.id));
	for (const [taskId, provenance] of knownTaskProvenance) {
		if (finalTaskIds.has(taskId) && !taskProvenance.has(taskId)) taskProvenance.set(taskId, provenance);
	}

	const identity: BuilderCorpusDraftIdentity = {
		schemaVersion: parent.sourceBinding !== undefined ? 4 : parent.schemaVersion === 3 || [...taskProvenance.values()]
			.some((provenance) => provenance.kind === "production-failure")
			? 3
			: 2,
		kind: "builder-corpus-draft",
		projectId: approvedSpec.projectId,
		approvedSpec,
		parentDraftId: parent.id,
		name,
		// Citations are verified where they are written; re-reading the Git blob
		// of every carried case on every revision would charge a grader edit for
		// the whole basket's sources.
		tasks: normalizeTasks(
			approvedSpec,
			tasks.map(({ id: _id, ...task }) => task),
			{ jobs },
		),
		...(parent.importSource !== undefined ? { importSource: parent.importSource } : {}),
		...(parent.sourceBinding !== undefined ? { sourceBinding: parent.sourceBinding } : {}),
		...(taskProvenance.size > 0 ? { taskProvenance: [...taskProvenance.values()] } : {}),
		...(exclusions.length > 0 ? { exclusions: exclusions.slice(-MAX_EXCLUSIONS) } : {}),
		coverageNotes,
		revisionSummary: RevisionSummarySchema.parse(options.revisionSummary),
		source: "builder-pi",
	};
	dependencies.validateTasks?.(identity.tasks);
	return publishDraft(options.stateRoot, identity, dependencies);
}

export function loadBuilderCorpusDraft(
	stateRoot: string,
	projectIdInput: string,
	draftId: string,
): BuilderCorpusDraft {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const draft = readJsonArtifact(
		artifactPath(stateRoot, projectId, draftId),
		BuilderCorpusDraftSchema,
		{ maxBytes: MAX_DRAFT_ARTIFACT_BYTES },
	);
	if (draft.projectId !== projectId || draft.approvedSpec.projectId !== projectId) {
		throw new Error("Builder corpus draft belongs to a different project");
	}
	return draft;
}

export function listBuilderCorpusDrafts(
	stateRoot: string,
	projectIdInput: string,
): BuilderCorpusDraft[] {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const root = draftsRoot(stateRoot, projectId, false);
	if (!root) return [];
	const drafts: BuilderCorpusDraft[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isFile() || !/^corpus-draft-[0-9a-f]{64}\.json$/.test(entry.name)) continue;
		const draft = readJsonArtifact(join(root, entry.name), BuilderCorpusDraftSchema, {
			maxBytes: MAX_DRAFT_ARTIFACT_BYTES,
		});
		if (draft.projectId !== projectId || draft.approvedSpec.projectId !== projectId) {
			throw new Error(`Builder corpus draft project mismatch: ${entry.name}`);
		}
		drafts.push(draft);
	}
	return drafts.sort((left, right) => left.createdAt === right.createdAt
		? right.id.localeCompare(left.id)
		: right.createdAt.localeCompare(left.createdAt));
}
