import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	openSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { GraderSpec, TaskSchema } from "./manifest.js";
import { canonicalJson, hashValue } from "./provenance.js";
import {
	ArtifactError,
	readJsonArtifact,
	readJsonlArtifact,
	writeJsonArtifact,
} from "./storage/artifacts.js";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CORPUS_ID_PATTERN = /^corpus-[0-9a-f]{64}$/;
const CONTENT_FILE_NAME = "corpus.jsonl";

const ProjectIdSchema = z
	.string()
	.regex(PROJECT_ID_PATTERN, "projectId must be one safe path segment");
const CorpusIdSchema = z
	.string()
	.regex(CORPUS_ID_PATTERN, "corpusId must be a canonical corpus identifier");
const CorpusHashSchema = z
	.string()
	.regex(/^sha256:[0-9a-f]{64}$/, "expected a sha256 corpus hash");

export const CorpusVisibilitySchema = z.enum(["development", "sealed"]);
export type CorpusVisibility = z.infer<typeof CorpusVisibilitySchema>;

/**
 * Corpus tasks must carry their graders with them. Suite-level defaults are
 * deliberately not allowed because a corpus snapshot must remain portable.
 */
export const CorpusTaskSchema = TaskSchema.extend({
	graders: z.array(GraderSpec).min(1, "portable corpus tasks require at least one explicit grader"),
});
export type CorpusTask = z.infer<typeof CorpusTaskSchema>;

export const CorpusMetadataSchema = z.strictObject({
	schemaVersion: z.literal(1),
	id: CorpusIdSchema,
	projectId: ProjectIdSchema,
	name: z.string().trim().min(1).max(200),
	visibility: CorpusVisibilitySchema,
	taskCount: z.number().int().positive(),
	hash: CorpusHashSchema,
	createdAt: z.iso.datetime({ offset: true }),
	contentPath: z.literal(CONTENT_FILE_NAME),
});
export type CorpusMetadata = z.infer<typeof CorpusMetadataSchema>;

export interface CorpusRef {
	stateRoot: string;
	projectId: string;
	corpusId: string;
}

export interface CreateCorpusOptions {
	stateRoot: string;
	projectId: string;
	name: string;
	visibility: CorpusVisibility;
	tasks: readonly unknown[];
}

export interface ImportCorpusOptions {
	stateRoot: string;
	projectId: string;
	name: string;
	visibility: CorpusVisibility;
	sourcePath: string;
}

export interface ListCorporaOptions {
	stateRoot: string;
	projectId: string;
}

export interface LoadedCorpus {
	metadata: CorpusMetadata;
	tasks: CorpusTask[];
}

export class CorpusError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CorpusError";
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function validateProjectId(projectId: string): string {
	const parsed = ProjectIdSchema.safeParse(projectId);
	if (!parsed.success) {
		throw new CorpusError(`invalid projectId ${JSON.stringify(projectId)}: traversal and path separators are forbidden`);
	}
	return parsed.data;
}

function validateCorpusId(corpusId: string): string {
	const parsed = CorpusIdSchema.safeParse(corpusId);
	if (!parsed.success) {
		throw new CorpusError(`invalid corpusId ${JSON.stringify(corpusId)}: traversal and non-canonical ids are forbidden`);
	}
	return parsed.data;
}

function assertInside(root: string, candidate: string, label: string): void {
	const rel = relative(root, candidate);
	if (rel === "") return;
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new CorpusError(`${label} escapes stateRoot`);
	}
}

function verifyRealContainment(stateRoot: string, candidate: string, label: string): void {
	const realRoot = realpathSync(resolve(stateRoot));
	const realCandidate = realpathSync(candidate);
	assertInside(realRoot, realCandidate, label);
}

function stateLayout(stateRoot: string, projectId: string, create: boolean): string | null {
	const root = resolve(stateRoot);
	if (!existsSync(root)) {
		if (!create) return null;
		mkdirSync(root, { recursive: true, mode: 0o700 });
	}
	const rootEntry = lstatSync(root);
	if (!rootEntry.isDirectory()) throw new CorpusError(`stateRoot must be a directory: ${root}`);
	const realRoot = realpathSync(root);

	let current = root;
	for (const segment of ["projects", validateProjectId(projectId), "corpora"]) {
		const next = join(current, segment);
		if (!existsSync(next)) {
			if (!create) return null;
			try {
				mkdirSync(next, { mode: 0o700 });
			} catch (error) {
				if (!isNodeError(error, "EEXIST")) throw error;
			}
		}
		const entry = lstatSync(next);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new CorpusError(`state layout component must be a regular directory: ${next}`);
		}
		assertInside(realRoot, realpathSync(next), "state layout");
		current = next;
	}
	return current;
}

function prepareCorporaRoot(stateRoot: string, projectId: string): string {
	const result = stateLayout(stateRoot, projectId, true);
	if (!result) throw new CorpusError("failed to create corpus state layout");
	return result;
}

function existingCorporaRoot(stateRoot: string, projectId: string): string | null {
	return stateLayout(stateRoot, projectId, false);
}

function parseTasks(values: readonly unknown[], source: string): CorpusTask[] {
	if (values.length === 0) throw new CorpusError(`${source}: corpus must contain at least one task`);
	const tasks = values.map((value, index) => {
		const result = CorpusTaskSchema.safeParse(value);
		if (!result.success) {
			throw new CorpusError(`${source}: task ${index + 1} is invalid: ${result.error.message}`);
		}
		return result.data;
	});
	const seen = new Set<string>();
	for (const task of tasks) {
		if (seen.has(task.id)) throw new CorpusError(`${source}: duplicate task id ${JSON.stringify(task.id)}`);
		seen.add(task.id);
	}
	return tasks;
}

function corpusIdFor(
	projectId: string,
	name: string,
	visibility: CorpusVisibility,
	contentHash: string,
): string {
	const identityHash = hashValue({ schemaVersion: 1, projectId, name, visibility, contentHash });
	return `corpus-${identityHash.slice("sha256:".length)}`;
}

function serializeTasks(tasks: readonly CorpusTask[]): string {
	return `${tasks.map((task) => canonicalJson(task)).join("\n")}\n`;
}

/** Publish a private JSONL file without ever replacing an existing inode. */
function writeImmutableJsonl(path: string, tasks: readonly CorpusTask[]): void {
	const artifactPath = resolve(path);
	const parentDir = dirname(artifactPath);
	const tempPath = join(parentDir, `.${basename(artifactPath)}.${process.pid}.${randomUUID()}.tmp`);
	let tempExists = false;
	try {
		const descriptor = openSync(tempPath, "wx", 0o600);
		tempExists = true;
		try {
			writeFileSync(descriptor, serializeTasks(tasks), "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}

		try {
			linkSync(tempPath, artifactPath);
		} catch (error) {
			if (isNodeError(error, "EEXIST")) {
				throw new CorpusError(`immutable corpus content already exists: ${artifactPath}`, { cause: error });
			}
			throw error;
		}
		chmodSync(artifactPath, 0o600);
		unlinkSync(tempPath);
		tempExists = false;
	} catch (error) {
		if (tempExists) {
			try {
				unlinkSync(tempPath);
			} catch {
				// Preserve the publication error; the temporary file is private.
			}
		}
		if (error instanceof CorpusError) throw error;
		throw new CorpusError(`atomic corpus content write failed: ${errorMessage(error)}`, { cause: error });
	}
}

function publishCorpus(options: Omit<CreateCorpusOptions, "tasks">, tasks: CorpusTask[]): CorpusMetadata {
	const projectId = validateProjectId(options.projectId);
	const nameResult = CorpusMetadataSchema.shape.name.safeParse(options.name);
	if (!nameResult.success) throw new CorpusError(`invalid corpus name: ${nameResult.error.message}`);
	const visibilityResult = CorpusVisibilitySchema.safeParse(options.visibility);
	if (!visibilityResult.success) throw new CorpusError(`invalid corpus visibility: ${visibilityResult.error.message}`);

	const name = nameResult.data;
	const visibility = visibilityResult.data;
	const contentHash = hashValue(tasks);
	const corpusId = corpusIdFor(projectId, name, visibility, contentHash);
	const corporaRoot = prepareCorporaRoot(options.stateRoot, projectId);
	const corpusDir = join(corporaRoot, corpusId);
	assertInside(corporaRoot, corpusDir, "corpus directory");

	try {
		mkdirSync(corpusDir, { mode: 0o700 });
	} catch (error) {
		if (isNodeError(error, "EEXIST")) {
			throw new CorpusError(`corpus ${corpusId} already exists; immutable corpora cannot be overwritten`, {
				cause: error,
			});
		}
		throw new CorpusError(`cannot create corpus directory ${corpusDir}: ${errorMessage(error)}`, { cause: error });
	}

	const metadata: CorpusMetadata = {
		schemaVersion: 1,
		id: corpusId,
		projectId,
		name,
		visibility,
		taskCount: tasks.length,
		hash: contentHash,
		createdAt: new Date().toISOString(),
		contentPath: CONTENT_FILE_NAME,
	};

	try {
		writeImmutableJsonl(join(corpusDir, CONTENT_FILE_NAME), tasks);
		writeJsonArtifact(join(corpusDir, "metadata.json"), CorpusMetadataSchema, metadata, { immutable: true });
		return metadata;
	} catch (error) {
		// This invocation created corpusDir exclusively, so cleanup cannot touch
		// an older corpus. metadata.json is written last and acts as the commit marker.
		try {
			rmSync(corpusDir, { recursive: true, force: true });
		} catch {
			// Preserve the original publication failure.
		}
		throw error;
	}
}

/** Create an immutable corpus snapshot from reviewed or synthetic in-memory tasks. */
export function createCorpus(options: CreateCorpusOptions): CorpusMetadata {
	const tasks = parseTasks(options.tasks, "in-memory corpus");
	return publishCorpus(options, tasks);
}

/** Import, normalize, and seal a bounded UTF-8 JSONL task corpus. */
export function importCorpus(options: ImportCorpusOptions): CorpusMetadata {
	let records: CorpusTask[];
	try {
		const sourcePath = resolve(options.sourcePath);
		assertOrdinaryFile(sourcePath, "corpus source");
		records = readJsonlArtifact(sourcePath, CorpusTaskSchema);
	} catch (error) {
		if (error instanceof ArtifactError) throw error;
		throw new CorpusError(`cannot import corpus: ${errorMessage(error)}`, { cause: error });
	}
	const tasks = parseTasks(records, `corpus source ${resolve(options.sourcePath)}`);
	return publishCorpus(
		{
			stateRoot: options.stateRoot,
			projectId: options.projectId,
			name: options.name,
			visibility: options.visibility,
		},
		tasks,
	);
}

function assertOrdinaryFile(path: string, label: string): void {
	let entry;
	try {
		entry = lstatSync(path);
	} catch (error) {
		throw new CorpusError(`${label} cannot be inspected: ${errorMessage(error)}`, { cause: error });
	}
	if (!entry.isFile() || entry.isSymbolicLink()) {
		throw new CorpusError(`${label} must be a regular, non-symlink file`);
	}
}

function readMetadata(corporaRoot: string, projectId: string, corpusId: string): CorpusMetadata {
	const corpusDir = join(corporaRoot, corpusId);
	assertInside(corporaRoot, corpusDir, "corpus directory");
	let corpusEntry;
	try {
		corpusEntry = lstatSync(corpusDir);
	} catch (error) {
		throw new CorpusError(`corpus ${corpusId} does not exist: ${errorMessage(error)}`, { cause: error });
	}
	if (!corpusEntry.isDirectory() || corpusEntry.isSymbolicLink()) {
		throw new CorpusError(`corpus ${corpusId} must be a regular directory`);
	}
	verifyRealContainment(corporaRoot, corpusDir, "corpus directory");

	const metadataPath = join(corpusDir, "metadata.json");
	assertOrdinaryFile(metadataPath, `corpus ${corpusId} metadata`);
	const metadata = readJsonArtifact(metadataPath, CorpusMetadataSchema);
	if (metadata.id !== corpusId) {
		throw new CorpusError(`corpus metadata id mismatch: expected ${corpusId}, got ${metadata.id}`);
	}
	if (metadata.projectId !== projectId) {
		throw new CorpusError(
			`corpus metadata projectId mismatch: expected ${projectId}, got ${metadata.projectId}`,
		);
	}
	const expectedId = corpusIdFor(metadata.projectId, metadata.name, metadata.visibility, metadata.hash);
	if (metadata.id !== expectedId) {
		throw new CorpusError(`corpus metadata id does not match its content identity: expected ${expectedId}`);
	}
	return metadata;
}

/** Strictly load and re-verify an immutable corpus and all of its tasks. */
export function loadCorpus(ref: CorpusRef): LoadedCorpus {
	const projectId = validateProjectId(ref.projectId);
	const corpusId = validateCorpusId(ref.corpusId);
	const corporaRoot = existingCorporaRoot(ref.stateRoot, projectId);
	if (!corporaRoot) throw new CorpusError(`project ${projectId} has no corpus store`);
	const metadata = readMetadata(corporaRoot, projectId, corpusId);
	const contentPath = join(corporaRoot, corpusId, metadata.contentPath);
	assertInside(join(corporaRoot, corpusId), contentPath, "corpus content path");
	assertOrdinaryFile(contentPath, `corpus ${corpusId} content`);
	if (metadata.visibility === "sealed") {
		const permissions = statSync(contentPath).mode & 0o777;
		if (permissions !== 0o600) {
			throw new CorpusError(
				`sealed corpus ${corpusId} must have content mode 0600, got 0${permissions.toString(8)}`,
			);
		}
	}

	const tasks = parseTasks(readJsonlArtifact(contentPath, CorpusTaskSchema), `corpus ${corpusId}`);
	if (tasks.length !== metadata.taskCount) {
		throw new CorpusError(
			`corpus ${corpusId} task count mismatch: metadata=${metadata.taskCount}, content=${tasks.length}`,
		);
	}
	const actualHash = hashValue(tasks);
	if (actualHash !== metadata.hash) {
		throw new CorpusError(
			`corpus ${corpusId} hash mismatch: metadata=${metadata.hash}, content=${actualHash}`,
		);
	}
	return { metadata, tasks };
}

/** List only metadata; sealed task content is never opened or returned. */
export function listCorpora(options: ListCorporaOptions): CorpusMetadata[] {
	const projectId = validateProjectId(options.projectId);
	const corporaRoot = existingCorporaRoot(options.stateRoot, projectId);
	if (!corporaRoot) return [];

	const metadata: CorpusMetadata[] = [];
	for (const entry of readdirSync(corporaRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || !CORPUS_ID_PATTERN.test(entry.name)) continue;
		metadata.push(readMetadata(corporaRoot, projectId, entry.name));
	}
	return metadata.sort((a, b) =>
		a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : b.createdAt.localeCompare(a.createdAt),
	);
}
