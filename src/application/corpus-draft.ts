import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
	BuilderUsageSchema,
	MAX_RAW_EVENT_BYTES,
	type PiBuilderExecutor,
	type PiBuilderExecutionResult,
} from "../builders/adapters.js";
import { CorpusTaskSchema, type CorpusTask } from "../corpus.js";
import { GraderSpec } from "../manifest.js";
import { canonicalJson, hashValue } from "../provenance.js";
import {
	AgentSpecSchema,
	ApprovedSpecReferenceSchema,
	loadApprovedSpec,
	type ApprovedSpecInput,
} from "../spec.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";

const MAX_DRAFT_TASKS = 100;
const MAX_TASK_BYTES = 64 * 1024;
const MAX_MODEL_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_GUIDANCE_BYTES = 16 * 1024;
const ProjectIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const DraftIdSchema = z.string().regex(/^corpus-draft-[0-9a-f]{64}$/);
const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const NonBlankSchema = z.string().min(1).refine((value) => value.trim().length > 0, "expected non-blank text");

const ModelDraftTaskSchema = z.strictObject({
	input: NonBlankSchema.max(32_000),
	graders: z.array(GraderSpec).min(1).max(16),
}).superRefine((task, context) => {
	if (Buffer.byteLength(canonicalJson(task), "utf8") > MAX_TASK_BYTES) {
		context.addIssue({ code: "custom", message: `task exceeds ${MAX_TASK_BYTES} bytes` });
	}
});

/** Strict structured output requested from the tool-free generation agent. */
export const CorpusDraftModelOutputSchema = z.strictObject({
	schemaVersion: z.literal(1),
	name: z.string().trim().min(1).max(200),
	tasks: z.array(ModelDraftTaskSchema).min(1).max(MAX_DRAFT_TASKS),
	coverageNotes: z.array(NonBlankSchema.max(1_000)).max(100),
});
export type CorpusDraftModelOutput = z.infer<typeof CorpusDraftModelOutputSchema>;

export const CorpusDraftPromptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	kind: z.literal("approved-spec-corpus-draft"),
	approvedSpec: z.strictObject({
		reference: ApprovedSpecReferenceSchema,
		spec: AgentSpecSchema,
	}),
	request: z.strictObject({
		taskCount: z.number().int().min(1).max(MAX_DRAFT_TASKS),
		guidance: z.string().max(MAX_GUIDANCE_BYTES).nullable(),
		publication: z.literal("draft-only-human-review-required"),
	}),
}).superRefine((prompt, context) => {
	if (hashValue(prompt.approvedSpec.spec) !== prompt.approvedSpec.reference.specContentHash) {
		context.addIssue({
			code: "custom",
			path: ["approvedSpec", "reference", "specContentHash"],
			message: "Spec content does not match its exact reference",
		});
	}
});
export type CorpusDraftPrompt = z.infer<typeof CorpusDraftPromptSchema>;

const GenerationEvidenceSchema = z.strictObject({
	executorVersion: NonBlankSchema.max(500),
	model: NonBlankSchema.max(500).nullable(),
	sessionId: NonBlankSchema.max(1_000).nullable(),
	usage: BuilderUsageSchema.nullable(),
	costUsd: z.number().nonnegative().nullable(),
	promptHash: Sha256Schema,
	modelOutputHash: Sha256Schema,
	eventsHash: Sha256Schema,
	eventsBytes: z.number().int().nonnegative().max(MAX_RAW_EVENT_BYTES),
	events: z.array(z.string()),
});

function taskId(specId: string, task: z.infer<typeof ModelDraftTaskSchema>): string {
	const identity = hashValue({ schemaVersion: 1, specId, input: task.input, graders: task.graders });
	return `task-${identity.slice("sha256:".length)}`;
}

function normalizeTasks(specId: string, tasks: CorpusDraftModelOutput["tasks"]): CorpusTask[] {
	const normalized = tasks.map((task) => CorpusTaskSchema.parse({ id: taskId(specId, task), ...task }));
	const seen = new Set<string>();
	for (const task of normalized) {
		if (seen.has(task.id)) throw new Error("corpus draft contains duplicate task content");
		seen.add(task.id);
	}
	return normalized;
}

export const CorpusDraftRecordSchema = z.strictObject({
	schemaVersion: z.literal(1),
	id: DraftIdSchema,
	projectId: ProjectIdSchema,
	approvedSpec: ApprovedSpecReferenceSchema,
	requestedTaskCount: z.number().int().min(1).max(MAX_DRAFT_TASKS),
	prompt: CorpusDraftPromptSchema,
	modelOutput: CorpusDraftModelOutputSchema,
	tasks: z.array(CorpusTaskSchema).min(1).max(MAX_DRAFT_TASKS),
	generation: GenerationEvidenceSchema,
	createdAt: z.iso.datetime({ offset: true }),
}).superRefine((record, context) => {
	let expectedTasks: CorpusTask[];
	try {
		expectedTasks = normalizeTasks(record.approvedSpec.specId, record.modelOutput.tasks);
	} catch (error) {
		context.addIssue({ code: "custom", path: ["tasks"], message: error instanceof Error ? error.message : String(error) });
		return;
	}
	if (canonicalJson(record.tasks) !== canonicalJson(expectedTasks)) {
		context.addIssue({ code: "custom", path: ["tasks"], message: "tasks do not match normalized model output" });
	}
	if (record.requestedTaskCount !== record.tasks.length) {
		context.addIssue({ code: "custom", path: ["tasks"], message: "model returned a different task count than requested" });
	}
	if (canonicalJson(record.prompt.approvedSpec.reference) !== canonicalJson(record.approvedSpec)) {
		context.addIssue({ code: "custom", path: ["prompt", "approvedSpec", "reference"], message: "prompt Spec reference mismatch" });
	}
	if (record.prompt.request.taskCount !== record.requestedTaskCount) {
		context.addIssue({ code: "custom", path: ["prompt", "request", "taskCount"], message: "prompt task count mismatch" });
	}
	if (hashValue(`${canonicalJson(record.prompt)}\n`) !== record.generation.promptHash) {
		context.addIssue({ code: "custom", path: ["generation", "promptHash"], message: "prompt hash mismatch" });
	}
	const eventContent = record.generation.events.join("\n");
	if (Buffer.byteLength(eventContent, "utf8") !== record.generation.eventsBytes) {
		context.addIssue({ code: "custom", path: ["generation", "eventsBytes"], message: "event byte count mismatch" });
	}
	if (hashValue(eventContent) !== record.generation.eventsHash) {
		context.addIssue({ code: "custom", path: ["generation", "eventsHash"], message: "event hash mismatch" });
	}
	if (hashValue(record.modelOutput) !== record.generation.modelOutputHash) {
		context.addIssue({ code: "custom", path: ["generation", "modelOutputHash"], message: "model output hash mismatch" });
	}
	const identity = hashValue({
		schemaVersion: record.schemaVersion,
		projectId: record.projectId,
		approvedSpec: record.approvedSpec,
		requestedTaskCount: record.requestedTaskCount,
		prompt: record.prompt,
		modelOutput: record.modelOutput,
		tasks: record.tasks,
		generation: record.generation,
	});
	const expectedId = `corpus-draft-${identity.slice("sha256:".length)}`;
	if (record.id !== expectedId) {
		context.addIssue({ code: "custom", path: ["id"], message: "draft id does not match its evidence identity" });
	}
});
export type CorpusDraftRecord = z.infer<typeof CorpusDraftRecordSchema>;

export interface GenerateCorpusDraftOptions {
	approvedSpec: ApprovedSpecInput;
	executor: PiBuilderExecutor;
	taskCount: number;
	guidance?: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface CorpusDraftResult {
	draft: CorpusDraftRecord;
	path: string;
}

export interface CorpusDraftDependencies {
	now: () => string;
}

const DEFAULT_DEPENDENCIES: CorpusDraftDependencies = { now: () => new Date().toISOString() };

function normalizeEvents(events: PiBuilderExecutionResult["events"]): string[] {
	const normalized = (events ?? []).map((event) => {
		if (typeof event !== "string") return JSON.stringify(event);
		return /[\r\n]/.test(event) ? JSON.stringify({ type: "raw_event", value: event }) : event;
	});
	const bytes = Buffer.byteLength(normalized.join("\n"), "utf8");
	if (bytes > MAX_RAW_EVENT_BYTES) throw new Error(`corpus draft events exceed ${MAX_RAW_EVENT_BYTES} bytes`);
	return normalized;
}

function assertInside(root: string, candidate: string): void {
	const rel = relative(root, candidate);
	if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return;
	throw new Error("corpus draft state path escaped stateRoot");
}

function draftsRoot(stateRoot: string, projectIdInput: string, create: boolean): string | null {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const root = resolve(stateRoot);
	if (!existsSync(root)) {
		if (!create) return null;
		mkdirSync(root, { recursive: true, mode: 0o700 });
	}
	const rootEntry = lstatSync(root);
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) throw new Error("corpus draft stateRoot must be a regular directory");
	const canonicalRoot = realpathSync(root);
	let current = root;
	for (const segment of ["projects", projectId, "corpus-drafts"]) {
		const next = join(current, segment);
		if (!existsSync(next)) {
			if (!create) return null;
			mkdirSync(next, { mode: 0o700 });
		}
		const entry = lstatSync(next);
		if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`corpus draft state component must be a regular directory: ${next}`);
		assertInside(canonicalRoot, realpathSync(next));
		current = next;
	}
	return current;
}

function draftPath(stateRoot: string, projectId: string, draftId: string): string {
	const id = DraftIdSchema.parse(draftId);
	const root = draftsRoot(stateRoot, projectId, false);
	if (!root) throw new Error(`project ${projectId} has no corpus drafts`);
	return join(root, `${id}.json`);
}

function recordIdentity(input: Omit<CorpusDraftRecord, "id" | "createdAt">): string {
	return `corpus-draft-${hashValue(input).slice("sha256:".length)}`;
}

export async function generateCorpusDraftFromApprovedSpec(
	options: GenerateCorpusDraftOptions,
	dependencies: Partial<CorpusDraftDependencies> = {},
): Promise<CorpusDraftResult> {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	const approved = loadApprovedSpec(options.approvedSpec);
	const taskCount = z.number().int().min(1).max(MAX_DRAFT_TASKS).parse(options.taskCount);
	const timeoutMs = z.number().int().positive().max(2_147_483_647).parse(options.timeoutMs);
	const guidance = options.guidance === undefined
		? null
		: z.string().max(MAX_GUIDANCE_BYTES).parse(options.guidance);
	if (Buffer.byteLength(guidance ?? "", "utf8") > MAX_GUIDANCE_BYTES) {
		throw new Error(`corpus draft guidance exceeds ${MAX_GUIDANCE_BYTES} bytes`);
	}
	if (!options.executor.version.trim()) throw new Error("corpus draft executor must provide an exact version");
	if (options.signal?.aborted) throw new Error("corpus draft generation was cancelled");

	const prompt = CorpusDraftPromptSchema.parse({
		schemaVersion: 1,
		kind: "approved-spec-corpus-draft",
		approvedSpec: { reference: approved.reference, spec: approved.snapshot.spec },
		request: {
			taskCount,
			guidance,
			publication: "draft-only-human-review-required",
		},
	});
	const promptText = `${canonicalJson(prompt)}\n`;
	const controller = new AbortController();
	let stop: "timeout" | "cancelled" | null = null;
	const cancel = (): void => {
		stop = "cancelled";
		controller.abort();
	};
	options.signal?.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(() => {
		stop = "timeout";
		controller.abort();
	}, timeoutMs);

	let execution: PiBuilderExecutionResult;
	try {
		execution = await options.executor.execute({
			input: promptText,
			outputSchema: z.toJSONSchema(CorpusDraftModelOutputSchema) as Record<string, unknown>,
			tools: [],
			timeoutMs,
			signal: controller.signal,
		});
		if (stop) throw new Error(`corpus draft generation ${stop}`);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", cancel);
	}

	const modelOutput = CorpusDraftModelOutputSchema.parse(execution.final);
	if (modelOutput.tasks.length !== taskCount) {
		throw new Error(`corpus draft requested ${taskCount} tasks but the model returned ${modelOutput.tasks.length}`);
	}
	if (Buffer.byteLength(canonicalJson(modelOutput), "utf8") > MAX_MODEL_OUTPUT_BYTES) {
		throw new Error(`corpus draft model output exceeds ${MAX_MODEL_OUTPUT_BYTES} bytes`);
	}
	const tasks = normalizeTasks(approved.reference.specId, modelOutput.tasks);
	const events = normalizeEvents(execution.events);
	const eventContent = events.join("\n");
	const body = {
		schemaVersion: 1 as const,
		projectId: approved.reference.projectId,
		approvedSpec: approved.reference,
		requestedTaskCount: taskCount,
		prompt,
		modelOutput,
		tasks,
		generation: {
			executorVersion: options.executor.version,
			model: execution.model ?? null,
			sessionId: execution.sessionId ?? null,
			usage: execution.usage ?? null,
			costUsd: execution.costUsd ?? null,
			promptHash: hashValue(promptText),
			modelOutputHash: hashValue(modelOutput),
			eventsHash: hashValue(eventContent),
			eventsBytes: Buffer.byteLength(eventContent, "utf8"),
			events,
		},
	};
	const draft = CorpusDraftRecordSchema.parse({
		...body,
		id: recordIdentity(body),
		createdAt: deps.now(),
	});
	const root = draftsRoot(options.approvedSpec.stateRoot, draft.projectId, true);
	if (!root) throw new Error("failed to create corpus draft state directory");
	const path = join(root, `${draft.id}.json`);
	if (existsSync(path)) {
		return { draft: readJsonArtifact(path, CorpusDraftRecordSchema), path };
	}
	try {
		writeJsonArtifact(path, CorpusDraftRecordSchema, draft, { immutable: true });
	} catch (error) {
		if (!existsSync(path)) throw error;
		return { draft: readJsonArtifact(path, CorpusDraftRecordSchema), path };
	}
	return { draft, path };
}

export function loadCorpusDraft(stateRoot: string, projectId: string, draftId: string): CorpusDraftRecord {
	return readJsonArtifact(draftPath(stateRoot, projectId, draftId), CorpusDraftRecordSchema);
}

export function listCorpusDrafts(stateRoot: string, projectIdInput: string): CorpusDraftRecord[] {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const root = draftsRoot(stateRoot, projectId, false);
	if (!root) return [];
	const drafts: CorpusDraftRecord[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isFile() || !/^corpus-draft-[0-9a-f]{64}\.json$/.test(entry.name)) continue;
		const draft = readJsonArtifact(join(root, entry.name), CorpusDraftRecordSchema);
		if (draft.projectId !== projectId) throw new Error(`corpus draft project mismatch: ${entry.name}`);
		drafts.push(draft);
	}
	return drafts.sort((a, b) => a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt));
}
