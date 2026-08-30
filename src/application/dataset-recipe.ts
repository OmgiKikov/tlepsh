import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { canonicalJson, HashSchema, hashValue } from "../provenance.js";
import { ApprovedSpecReferenceSchema, type ApprovedSpecReference } from "../spec.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import {
	DatasetMappingRecipeSchema,
	DatasetSourcePathSchema,
	type DatasetMappingRecipe,
} from "./dataset-ingest.js";

const ProjectIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const SubmissionIdSchema = z.string().regex(/^dataset-recipe-[0-9a-f]{64}$/);
const NonBlankSchema = z.string().min(1).refine((value) => value.trim().length > 0, "expected non-blank text");

const MAX_SUBMISSION_BYTES = 512 * 1024;

interface DatasetRecipeSubmissionIdentity {
	schemaVersion: 1;
	kind: "dataset-recipe";
	projectId: string;
	approvedSpec: ApprovedSpecReference;
	sourcePath: string;
	sourceSha256: string;
	recipeSha256: string;
	recipe: DatasetMappingRecipe;
	name: string;
	revisionSummary: string;
}

function submissionId(identity: DatasetRecipeSubmissionIdentity): string {
	return `dataset-recipe-${hashValue(identity).slice("sha256:".length)}`;
}

/**
 * One proposed mapping, frozen exactly as the host validated it against the
 * real columns. It carries no rows: a submission is an argument about how to
 * read a file, and the file stays the only place its contents live.
 */
export const DatasetRecipeSubmissionSchema = z.strictObject({
	schemaVersion: z.literal(1),
	kind: z.literal("dataset-recipe"),
	id: SubmissionIdSchema,
	projectId: ProjectIdSchema,
	approvedSpec: ApprovedSpecReferenceSchema,
	sourcePath: DatasetSourcePathSchema,
	sourceSha256: HashSchema,
	recipeSha256: HashSchema,
	recipe: DatasetMappingRecipeSchema,
	name: z.string().trim().min(1).max(200),
	revisionSummary: NonBlankSchema.max(4_000),
	createdAt: z.iso.datetime({ offset: true }),
}).superRefine((submission, context) => {
	if (submission.projectId !== submission.approvedSpec.projectId) {
		context.addIssue({ code: "custom", path: ["projectId"], message: "a recipe must match its approved Spec project" });
	}
	const { id: _id, createdAt: _createdAt, ...identity } = submission;
	if (submission.id !== submissionId(identity)) {
		context.addIssue({ code: "custom", path: ["id"], message: "recipe id does not match its exact content" });
	}
});
export type DatasetRecipeSubmission = z.infer<typeof DatasetRecipeSubmissionSchema>;

export interface SaveDatasetRecipeSubmissionOptions {
	stateRoot: string;
	approvedSpec: ApprovedSpecReference;
	sourcePath: string;
	sourceSha256: string;
	recipeSha256: string;
	/** Already validated against the real columns by the caller. */
	recipe: unknown;
	name: string;
	revisionSummary: string;
	now?: () => string;
}

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function recipesRoot(stateRoot: string, projectIdInput: string, create: boolean): string | null {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const root = resolve(stateRoot);
	if (!existsSync(root)) {
		if (!create) return null;
		mkdirSync(root, { recursive: true, mode: 0o700 });
	}
	const rootEntry = lstatSync(root);
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
		throw new Error(`dataset recipe stateRoot must be a regular non-symlink directory: ${root}`);
	}
	const canonicalRoot = realpathSync(root);
	let current = root;
	for (const segment of ["projects", projectId, "dataset-recipes"]) {
		const next = join(current, segment);
		if (!existsSync(next)) {
			if (!create) return null;
			mkdirSync(next, { mode: 0o700 });
		}
		const entry = lstatSync(next);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`dataset recipe state component must be a regular non-symlink directory: ${next}`);
		}
		if (!contained(canonicalRoot, realpathSync(next))) {
			throw new Error("dataset recipe state path escaped stateRoot");
		}
		current = next;
	}
	return current;
}

/** Freeze one validated mapping recipe as a small immutable, content-addressed artifact. */
export function saveDatasetRecipeSubmission(
	options: SaveDatasetRecipeSubmissionOptions,
): { submission: DatasetRecipeSubmission; path: string } {
	const approvedSpec = ApprovedSpecReferenceSchema.parse(options.approvedSpec);
	const identity: DatasetRecipeSubmissionIdentity = {
		schemaVersion: 1,
		kind: "dataset-recipe",
		projectId: approvedSpec.projectId,
		approvedSpec,
		sourcePath: DatasetSourcePathSchema.parse(options.sourcePath),
		sourceSha256: HashSchema.parse(options.sourceSha256),
		recipeSha256: HashSchema.parse(options.recipeSha256),
		recipe: DatasetMappingRecipeSchema.parse(options.recipe),
		name: z.string().trim().min(1).max(200).parse(options.name),
		revisionSummary: NonBlankSchema.max(4_000).parse(options.revisionSummary),
	};
	const submission = DatasetRecipeSubmissionSchema.parse({
		...identity,
		id: submissionId(identity),
		createdAt: (options.now ?? (() => new Date().toISOString()))(),
	});
	const root = recipesRoot(options.stateRoot, submission.projectId, true);
	if (!root) throw new Error("failed to create the dataset recipe directory");
	const path = join(root, `${submission.id}.json`);
	const sameIdentity = (existing: DatasetRecipeSubmission): boolean => {
		const { id: _id, createdAt: _createdAt, ...existingIdentity } = existing;
		return canonicalJson(existingIdentity) === canonicalJson(identity);
	};
	if (existsSync(path)) {
		const existing = readJsonArtifact(path, DatasetRecipeSubmissionSchema, { maxBytes: MAX_SUBMISSION_BYTES });
		if (!sameIdentity(existing)) throw new Error(`content-address collision for dataset recipe ${submission.id}`);
		return { submission: existing, path };
	}
	try {
		writeJsonArtifact(path, DatasetRecipeSubmissionSchema, submission, { immutable: true });
	} catch (error) {
		if (!existsSync(path)) throw error;
		const existing = readJsonArtifact(path, DatasetRecipeSubmissionSchema, { maxBytes: MAX_SUBMISSION_BYTES });
		if (!sameIdentity(existing)) throw error;
		return { submission: existing, path };
	}
	return { submission, path };
}

export function loadDatasetRecipeSubmission(
	stateRoot: string,
	projectIdInput: string,
	submissionIdInput: string,
): DatasetRecipeSubmission {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const id = SubmissionIdSchema.parse(submissionIdInput);
	const root = recipesRoot(stateRoot, projectId, false);
	if (!root) throw new Error(`project ${projectId} has no dataset recipes`);
	const submission = readJsonArtifact(join(root, `${id}.json`), DatasetRecipeSubmissionSchema, {
		maxBytes: MAX_SUBMISSION_BYTES,
	});
	if (submission.projectId !== projectId) throw new Error("dataset recipe belongs to a different project");
	return submission;
}

/** Every recipe proposed for this project, newest first. */
export function listDatasetRecipeSubmissions(
	stateRoot: string,
	projectIdInput: string,
): DatasetRecipeSubmission[] {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const root = recipesRoot(stateRoot, projectId, false);
	if (!root) return [];
	const submissions: DatasetRecipeSubmission[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isFile() || !/^dataset-recipe-[0-9a-f]{64}\.json$/.test(entry.name)) continue;
		const submission = readJsonArtifact(join(root, entry.name), DatasetRecipeSubmissionSchema, {
			maxBytes: MAX_SUBMISSION_BYTES,
		});
		if (submission.projectId !== projectId) throw new Error(`dataset recipe project mismatch: ${entry.name}`);
		submissions.push(submission);
	}
	return submissions.sort((left, right) => left.createdAt === right.createdAt
		? right.id.localeCompare(left.id)
		: right.createdAt.localeCompare(left.createdAt));
}
