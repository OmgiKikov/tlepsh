import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
	createCorpus,
	listCorpora,
	loadCorpus,
	type CorpusMetadata,
	type CorpusRef,
	type CorpusTask,
	type LoadedCorpus,
} from "../corpus.js";
import { hashValue } from "../provenance.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";

/** Two cases per side is the smallest split that is more than a coin flip. */
export const MIN_BLIND_IMPROVEMENT_TASKS = 4;

const LoopIdSchema = z.string().regex(/^loop_[a-z0-9]{6,32}$/);
const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const CorpusIdSchema = z.string().regex(/^corpus-[0-9a-f]{64}$/);
const TaskIdsSchema = z.array(z.string().min(1).max(200)).min(2)
	.refine((values) => new Set(values).size === values.length, "task ids must be unique");

const CorpusIdentitySchema = z.strictObject({
	id: CorpusIdSchema,
	hash: Sha256Schema,
	taskCount: z.number().int().min(2),
});

export const ImprovementExperimentDesignSchema = z.strictObject({
	schemaVersion: z.literal(1),
	designId: z.string().regex(/^idesign_[0-9a-f]{24}$/),
	designHash: Sha256Schema,
	loopId: LoopIdSchema,
	projectId: z.string().min(1).max(128),
	createdAt: z.iso.datetime({ offset: true }),
	seed: Sha256Schema,
	sourceCorpus: CorpusIdentitySchema.extend({ name: z.string().min(1).max(200) }),
	authoringTaskIds: TaskIdsSchema,
	validationTaskIds: TaskIdsSchema,
	authoringCorpus: CorpusIdentitySchema,
	validationCorpus: CorpusIdentitySchema,
}).superRefine((design, context) => {
	const overlap = design.authoringTaskIds.filter((id) => design.validationTaskIds.includes(id));
	if (overlap.length > 0) {
		context.addIssue({ code: "custom", path: ["validationTaskIds"], message: "authoring and validation tasks must be disjoint" });
	}
	if (design.authoringTaskIds.length !== design.authoringCorpus.taskCount) {
		context.addIssue({ code: "custom", path: ["authoringCorpus", "taskCount"], message: "authoring task count does not match ids" });
	}
	if (design.validationTaskIds.length !== design.validationCorpus.taskCount) {
		context.addIssue({ code: "custom", path: ["validationCorpus", "taskCount"], message: "validation task count does not match ids" });
	}
	if (design.authoringTaskIds.length + design.validationTaskIds.length !== design.sourceCorpus.taskCount) {
		context.addIssue({ code: "custom", path: ["sourceCorpus", "taskCount"], message: "split does not cover the source corpus exactly" });
	}
});
export type ImprovementExperimentDesign = z.infer<typeof ImprovementExperimentDesignSchema>;

export class ImprovementExperimentDesignError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(`blind improvement rejected: ${message}`, options);
		this.name = "ImprovementExperimentDesignError";
	}
}

interface PlannedSplit {
	designId: string;
	seed: string;
	authoringTaskIds: string[];
	validationTaskIds: string[];
}

function designRoot(runsRoot: string): string {
	return join(resolve(runsRoot), "improvement-designs");
}

export function improvementExperimentDesignPath(runsRoot: string, loopId: string): string {
	return join(designRoot(runsRoot), `${LoopIdSchema.parse(loopId)}.json`);
}

/**
 * Stable hash-ranking keeps a split reproducible without depending on input
 * order. The original order is restored inside each arm so EvalRun task order
 * remains easy to compare with the reviewed basket.
 */
export function planImprovementExperiment(corpus: LoadedCorpus, loopId: string): PlannedSplit {
	LoopIdSchema.parse(loopId);
	if (corpus.metadata.visibility !== "development") {
		throw new ImprovementExperimentDesignError("only a reviewed development corpus can be split");
	}
	if (corpus.tasks.length < MIN_BLIND_IMPROVEMENT_TASKS) {
		throw new ImprovementExperimentDesignError(
			`comparing hypotheses needs at least ${MIN_BLIND_IMPROVEMENT_TASKS} reviewed cases ` +
			`(two authoring and two unseen validation cases); this corpus has ${corpus.tasks.length}`,
		);
	}
	const seed = hashValue({
		schemaVersion: 1,
		purpose: "blind-improvement-split",
		loopId,
		corpus: { id: corpus.metadata.id, hash: corpus.metadata.hash },
	});
	const ranked = corpus.tasks.map((task, index) => ({
		id: task.id,
		index,
		rank: hashValue({ schemaVersion: 1, seed, taskId: task.id }),
	})).sort((left, right) =>
		(left.rank < right.rank ? -1 : left.rank > right.rank ? 1 : 0) ||
		(left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
	const validationCount = Math.min(
		corpus.tasks.length - 2,
		Math.max(2, Math.round(corpus.tasks.length * 0.4)),
	);
	const validation = new Set(ranked.slice(0, validationCount).map((entry) => entry.id));
	const authoringTaskIds = corpus.tasks.filter((task) => !validation.has(task.id)).map((task) => task.id);
	const validationTaskIds = corpus.tasks.filter((task) => validation.has(task.id)).map((task) => task.id);
	const identity = hashValue({
		schemaVersion: 1,
		seed,
		sourceCorpus: { id: corpus.metadata.id, hash: corpus.metadata.hash },
		authoringTaskIds,
		validationTaskIds,
	});
	return {
		designId: `idesign_${identity.slice("sha256:".length, "sha256:".length + 24)}`,
		seed,
		authoringTaskIds,
		validationTaskIds,
	};
}

function exactTasks(corpus: LoadedCorpus, taskIds: readonly string[]): CorpusTask[] {
	const wanted = new Set(taskIds);
	const tasks = corpus.tasks.filter((task) => wanted.has(task.id));
	if (tasks.length !== wanted.size) {
		throw new ImprovementExperimentDesignError("the planned split names cases missing from its source corpus");
	}
	return tasks;
}

function ensureCorpus(options: {
	stateRoot: string;
	projectId: string;
	name: string;
	tasks: readonly CorpusTask[];
}): CorpusMetadata {
	const expectedHash = hashValue(options.tasks);
	const existing = (): CorpusMetadata | undefined => listCorpora(options)
		.find((entry) => entry.visibility === "development" && entry.name === options.name && entry.hash === expectedHash);
	const found = existing();
	if (found) return found;
	try {
		return createCorpus({ ...options, visibility: "development" });
	} catch (error) {
		const raced = existing();
		if (raced) return raced;
		throw new ImprovementExperimentDesignError("could not persist an immutable split corpus", { cause: error });
	}
}

function corpusIdentity(metadata: CorpusMetadata): { id: string; hash: string; taskCount: number } {
	return { id: metadata.id, hash: metadata.hash, taskCount: metadata.taskCount };
}

function computedDesignHash(design: Omit<ImprovementExperimentDesign, "designHash" | "createdAt">): string {
	return hashValue(design);
}

/** Read one design and verify its semantic hash before another artifact cites it. */
export function loadImprovementExperimentDesign(path: string): ImprovementExperimentDesign {
	const design = readJsonArtifact(resolve(path), ImprovementExperimentDesignSchema);
	const { designHash, createdAt: _createdAt, ...identity } = design;
	if (computedDesignHash(identity) !== designHash) {
		throw new ImprovementExperimentDesignError("the saved split design hash does not match its contents");
	}
	return design;
}

function refFor(stateRoot: string, projectId: string, corpusId: string): CorpusRef {
	return { stateRoot: resolve(stateRoot), projectId, corpusId };
}

function verifyPersistedDesign(
	design: ImprovementExperimentDesign,
	source: LoadedCorpus,
	stateRoot: string,
): ImprovementExperimentDesign {
	if (
		design.projectId !== source.metadata.projectId ||
		design.sourceCorpus.id !== source.metadata.id ||
		design.sourceCorpus.hash !== source.metadata.hash ||
		design.sourceCorpus.taskCount !== source.metadata.taskCount
	) {
		throw new ImprovementExperimentDesignError("the saved split belongs to a different source corpus");
	}
	const { designHash, createdAt: _createdAt, ...identity } = design;
	if (computedDesignHash(identity) !== designHash) {
		throw new ImprovementExperimentDesignError("the saved split design hash does not match its contents");
	}
	const sourceIds = source.tasks.map((task) => task.id);
	const splitIds = [...design.authoringTaskIds, ...design.validationTaskIds];
	if (new Set(splitIds).size !== sourceIds.length || sourceIds.some((id) => !splitIds.includes(id))) {
		throw new ImprovementExperimentDesignError("the saved split no longer covers the exact source corpus");
	}
	for (const [label, corpus] of [
		["authoring", design.authoringCorpus],
		["validation", design.validationCorpus],
	] as const) {
		const loaded = loadCorpus(refFor(stateRoot, design.projectId, corpus.id));
		const expectedIds = label === "authoring" ? design.authoringTaskIds : design.validationTaskIds;
		if (
			loaded.metadata.hash !== corpus.hash ||
			loaded.metadata.taskCount !== corpus.taskCount ||
			JSON.stringify(loaded.tasks.map((task) => task.id)) !== JSON.stringify(expectedIds)
		) {
			throw new ImprovementExperimentDesignError(`the saved ${label} corpus does not match the split design`);
		}
	}
	return design;
}

export function materializeImprovementExperimentDesign(options: {
	runsRoot: string;
	stateRoot: string;
	projectId: string;
	loopId: string;
	corpus: LoadedCorpus;
	now?: () => string;
}): ImprovementExperimentDesign {
	const path = improvementExperimentDesignPath(options.runsRoot, options.loopId);
	try {
		const saved = loadImprovementExperimentDesign(path);
		return verifyPersistedDesign(saved, options.corpus, options.stateRoot);
	} catch (error) {
		if (!(error instanceof Error) || !/ENOENT|does not exist|no such file/i.test(error.message)) throw error;
	}

	const plan = planImprovementExperiment(options.corpus, options.loopId);
	const short = plan.designId.slice("idesign_".length, "idesign_".length + 8);
	const authoring = ensureCorpus({
		stateRoot: options.stateRoot,
		projectId: options.projectId,
		name: `[AHDE ${short}] authoring · ${options.corpus.metadata.name}`,
		tasks: exactTasks(options.corpus, plan.authoringTaskIds),
	});
	const validation = ensureCorpus({
		stateRoot: options.stateRoot,
		projectId: options.projectId,
		name: `[AHDE ${short}] validation · ${options.corpus.metadata.name}`,
		tasks: exactTasks(options.corpus, plan.validationTaskIds),
	});
	const identity = {
		schemaVersion: 1 as const,
		designId: plan.designId,
		loopId: options.loopId,
		projectId: options.projectId,
		seed: plan.seed,
		sourceCorpus: {
			...corpusIdentity(options.corpus.metadata),
			name: options.corpus.metadata.name,
		},
		authoringTaskIds: plan.authoringTaskIds,
		validationTaskIds: plan.validationTaskIds,
		authoringCorpus: corpusIdentity(authoring),
		validationCorpus: corpusIdentity(validation),
	};
	const design = ImprovementExperimentDesignSchema.parse({
		...identity,
		designHash: computedDesignHash(identity),
		createdAt: (options.now ?? (() => new Date().toISOString()))(),
	});
	mkdirSync(designRoot(options.runsRoot), { recursive: true, mode: 0o700 });
	writeJsonArtifact(path, ImprovementExperimentDesignSchema, design, { immutable: true });
	return verifyPersistedDesign(design, options.corpus, options.stateRoot);
}

export function improvementDesignCorpusRefs(
	design: ImprovementExperimentDesign,
	stateRoot: string,
): { authoring: CorpusRef; validation: CorpusRef } {
	return {
		authoring: refFor(stateRoot, design.projectId, design.authoringCorpus.id),
		validation: refFor(stateRoot, design.projectId, design.validationCorpus.id),
	};
}
