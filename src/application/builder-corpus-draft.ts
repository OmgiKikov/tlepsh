import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { CorpusTaskSchema, type CorpusTask } from "../corpus.js";
import { GraderSpec, TaskSchema, taskDialogueIssue } from "../manifest.js";
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
export const BuilderCorpusDraftCoverageNotesSchema = z.array(NonBlankSchema.max(1_000)).max(100);
const RevisionSummarySchema = NonBlankSchema.max(4_000);

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
	schemaVersion: 2 | 3;
	kind: "builder-corpus-draft";
	projectId: string;
	approvedSpec: ApprovedSpecReference;
	parentDraftId: string | null;
	name: string;
	tasks: CorpusTask[];
	importSource?: BuilderCorpusImportSource;
	taskProvenance?: BuilderCorpusDraftTaskProvenance[];
	coverageNotes: string[];
	revisionSummary: string;
	source: "builder-pi";
}

export function builderCorpusDraftTaskId(approvedSpec: ApprovedSpecReference, task: BuilderCorpusDraftTaskInput): string {
	const identity = hashValue({ schemaVersion: 2, approvedSpec, task });
	return `task-${identity.slice("sha256:".length)}`;
}

function normalizeTasks(
	approvedSpec: ApprovedSpecReference,
	tasksInput: readonly unknown[],
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
	}
	return tasks;
}

function draftIdentity(record: BuilderCorpusDraftIdentity): string {
	return `corpus-draft-${hashValue(record).slice("sha256:".length)}`;
}

export const BuilderCorpusDraftSchema = z.strictObject({
	schemaVersion: z.union([z.literal(2), z.literal(3)]),
	kind: z.literal("builder-corpus-draft"),
	id: DraftIdSchema,
	projectId: ProjectIdSchema,
	approvedSpec: ApprovedSpecReferenceSchema,
	parentDraftId: DraftIdSchema.nullable(),
	name: DraftNameSchema,
	tasks: z.array(BuilderCorpusDraftStoredTaskSchema).min(1).max(MAX_DRAFT_TASKS),
	importSource: BuilderCorpusImportSourceSchema.optional(),
	taskProvenance: z.array(BuilderCorpusDraftTaskProvenanceSchema).max(MAX_DRAFT_TASKS).optional(),
	coverageNotes: BuilderCorpusDraftCoverageNotesSchema,
	revisionSummary: RevisionSummarySchema,
	source: z.literal("builder-pi"),
	createdAt: z.iso.datetime({ offset: true }),
}).superRefine((draft, context) => {
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
		...(draft.taskProvenance !== undefined ? { taskProvenance: draft.taskProvenance } : {}),
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
	/** Trusted host-derived task provenance; model-facing draft schemas cannot populate it. */
	verifiedTaskProvenance?: readonly unknown[];
	revisionSummary: string;
}

export interface ReviseBuilderCorpusDraftOptions {
	stateRoot: string;
	approvedSpec: ApprovedSpecReference;
	parentDraftId: string;
	operations: readonly unknown[];
	/** Trusted host-derived, operation-bound provenance; model-facing schemas cannot populate it. */
	verifiedTaskProvenance?: readonly unknown[];
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

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function draftsRoot(stateRoot: string, projectIdInput: string, create: boolean): string | null {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const root = resolve(stateRoot);
	if (!existsSync(root)) {
		if (!create) return null;
		mkdirSync(root, { recursive: true, mode: 0o700 });
	}
	const rootEntry = lstatSync(root);
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
		throw new Error(`Builder corpus draft stateRoot must be a regular non-symlink directory: ${root}`);
	}
	const canonicalRoot = realpathSync(root);
	let current = root;
	for (const segment of ["projects", projectId, "builder-corpus-drafts"]) {
		const next = join(current, segment);
		if (!existsSync(next)) {
			if (!create) return null;
			mkdirSync(next, { mode: 0o700 });
		}
		const entry = lstatSync(next);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`Builder corpus draft state component must be a regular non-symlink directory: ${next}`);
		}
		if (!contained(canonicalRoot, realpathSync(next))) {
			throw new Error("Builder corpus draft state path escaped stateRoot");
		}
		current = next;
	}
	return current;
}

function artifactPath(stateRoot: string, projectId: string, draftIdInput: string): string {
	const draftId = DraftIdSchema.parse(draftIdInput);
	const root = draftsRoot(stateRoot, projectId, false);
	if (!root) throw new Error(`project ${projectId} has no Builder corpus drafts`);
	return join(root, `${draftId}.json`);
}

function exactApprovedSpec(stateRoot: string, referenceInput: ApprovedSpecReference): ApprovedSpecReference {
	const reference = ApprovedSpecReferenceSchema.parse(referenceInput);
	const loaded = loadApprovedSpec({
		stateRoot,
		projectId: reference.projectId,
		specId: reference.specId,
	});
	if (canonicalJson(loaded.reference) !== canonicalJson(reference)) {
		throw new Error("approved Spec reference does not match the exact stored snapshot");
	}
	return reference;
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
		...(draft.taskProvenance !== undefined ? { taskProvenance: draft.taskProvenance } : {}),
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
	const approvedSpec = exactApprovedSpec(options.stateRoot, options.approvedSpec);
	const tasks = normalizeTasks(approvedSpec, options.tasks);
	const taskProvenance = z.array(BuilderCorpusDraftTaskProvenanceSchema).max(MAX_DRAFT_TASKS)
		.parse(options.verifiedTaskProvenance ?? []);
	const identity: BuilderCorpusDraftIdentity = {
		schemaVersion: taskProvenance.some((provenance) => provenance.kind === "production-failure") ? 3 : 2,
		kind: "builder-corpus-draft",
		projectId: approvedSpec.projectId,
		approvedSpec,
		parentDraftId: null,
		name: DraftNameSchema.parse(options.name),
		tasks,
		...(options.verifiedImportSource !== undefined
			? { importSource: BuilderCorpusImportSourceSchema.parse(options.verifiedImportSource) }
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
	dependencies: Partial<BuilderCorpusDraftDependencies> = {},
): BuilderCorpusDraftResult {
	const approvedSpec = exactApprovedSpec(options.stateRoot, options.approvedSpec);
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
		const normalized = normalizeTasks(approvedSpec, [{ ...carried, graders }])[0];
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
				const normalized = normalizeTasks(approvedSpec, [operation.task])[0];
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
				const normalized = normalizeTasks(approvedSpec, [operation.task])[0];
				if (!normalized) throw new Error("replace operation did not produce a task");
				taskProvenance.delete(operation.taskId);
				tasks[index] = normalized;
				break;
			}
			case "remove":
				taskProvenance.delete(operation.taskId);
				tasks.splice(taskIndex(tasks, operation.taskId, "remove"), 1);
				break;
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
		schemaVersion: parent.schemaVersion === 3 || [...taskProvenance.values()]
			.some((provenance) => provenance.kind === "production-failure")
			? 3
			: 2,
		kind: "builder-corpus-draft",
		projectId: approvedSpec.projectId,
		approvedSpec,
		parentDraftId: parent.id,
		name,
		tasks: normalizeTasks(
			approvedSpec,
			tasks.map(({ id: _id, ...task }) => task),
		),
		...(parent.importSource !== undefined ? { importSource: parent.importSource } : {}),
		...(taskProvenance.size > 0 ? { taskProvenance: [...taskProvenance.values()] } : {}),
		coverageNotes,
		revisionSummary: RevisionSummarySchema.parse(options.revisionSummary),
		source: "builder-pi",
	};
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
