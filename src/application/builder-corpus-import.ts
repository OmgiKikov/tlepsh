import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import {
	type BuilderCorpusDraft,
	createBuilderCorpusDraft,
	loadBuilderCorpusDraft,
	type BuilderCorpusDraftDependencies,
	type BuilderCorpusDraftResult,
} from "./builder-corpus-draft.js";
import {
	BuilderCorpusImportSourcePathSchema,
	BuilderCorpusImportSourceSchema,
	MAX_BUILDER_CORPUS_IMPORT_BYTES,
	MAX_BUILDER_CORPUS_IMPORT_TASKS,
	type BuilderCorpusImportSource,
} from "./builder-corpus-import-contract.js";
import { CorpusTaskSchema } from "../corpus.js";
import { canonicalJson, HashSchema, hashValue } from "../provenance.js";
import {
	ApprovedSpecReferenceSchema,
	type ApprovedSpecReference,
} from "../spec.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";

const ProjectIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const DraftIdSchema = z.string().regex(/^corpus-draft-[0-9a-f]{64}$/);
const ImportIdSchema = z.string().regex(/^corpus-import-[0-9a-f]{64}$/);

interface BuilderCorpusImportIdentity {
	schemaVersion: 1;
	kind: "builder-corpus-import";
	projectId: string;
	approvedSpec: ApprovedSpecReference;
	draftId: string;
	draftHash: string;
	source: BuilderCorpusImportSource;
}

function receiptId(identity: BuilderCorpusImportIdentity): string {
	return `corpus-import-${hashValue(identity).slice("sha256:".length)}`;
}

export const BuilderCorpusImportReceiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	kind: z.literal("builder-corpus-import"),
	id: ImportIdSchema,
	projectId: ProjectIdSchema,
	approvedSpec: ApprovedSpecReferenceSchema,
	draftId: DraftIdSchema,
	draftHash: HashSchema,
	source: BuilderCorpusImportSourceSchema,
	createdAt: z.iso.datetime({ offset: true }),
}).superRefine((receipt, context) => {
	if (receipt.projectId !== receipt.approvedSpec.projectId) {
		context.addIssue({ code: "custom", path: ["projectId"], message: "import project must match the approved Spec" });
	}
	const { id: _id, createdAt: _createdAt, ...identity } = receipt;
	if (receipt.id !== receiptId(identity)) {
		context.addIssue({ code: "custom", path: ["id"], message: "import id does not match its exact provenance" });
	}
});
export type BuilderCorpusImportReceipt = z.infer<typeof BuilderCorpusImportReceiptSchema>;

export interface ImportBuilderCorpusDraftOptions {
	stateRoot: string;
	projectDir: string;
	runsRoot: string;
	approvedSpec: ApprovedSpecReference;
	sourcePath: string;
	name: string;
	coverageNotes?: readonly string[];
	revisionSummary: string;
}

export interface BuilderCorpusImportResult extends BuilderCorpusDraftResult {
	receipt: BuilderCorpusImportReceipt;
	receiptPath: string;
}

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sourceFilePath(options: ImportBuilderCorpusDraftOptions): {
	absolute: string;
	relative: string;
	expected: Stats;
} {
	const sourcePath = BuilderCorpusImportSourcePathSchema.parse(options.sourcePath);
	const root = resolve(options.projectDir);
	if (!existsSync(root)) throw new Error(`Builder corpus import project root does not exist: ${root}`);
	const rootEntry = lstatSync(root);
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
		throw new Error(`Builder corpus import project root must be a regular non-symlink directory: ${root}`);
	}

	const candidate = resolve(root, sourcePath);
	if (!contained(root, candidate)) throw new Error("Builder corpus import source escaped the project root");
	for (const protectedRoot of [resolve(options.stateRoot), resolve(options.runsRoot)]) {
		if (contained(protectedRoot, candidate)) {
			throw new Error("Builder corpus import cannot read private AHDE state or run evidence");
		}
	}

	let current = root;
	let sourceEntry: Stats | null = null;
	const segments = sourcePath.split("/");
	for (const [index, segment] of segments.entries()) {
		current = join(current, segment);
		let entry;
		try {
			entry = lstatSync(current);
		} catch (error) {
			throw new Error(`Builder corpus import source cannot be inspected: ${sourcePath}`, { cause: error });
		}
		if (entry.isSymbolicLink()) throw new Error("Builder corpus import source may not contain symlink components");
		const final = index === segments.length - 1;
		if (final ? !entry.isFile() : !entry.isDirectory()) {
			throw new Error(`Builder corpus import source is not a regular file: ${sourcePath}`);
		}
		if (final) sourceEntry = entry;
	}

	const canonicalRoot = realpathSync(root);
	const canonicalSource = realpathSync(candidate);
	if (!contained(canonicalRoot, canonicalSource)) {
		throw new Error("Builder corpus import source escaped the project root through a symlink");
	}
	if (!sourceEntry) throw new Error("Builder corpus import source did not resolve to a file");
	return { absolute: canonicalSource, relative: sourcePath, expected: sourceEntry };
}

function sameFileSnapshot(
	left: Stats,
	right: Stats,
): boolean {
	return left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs;
}

function readImportSource(
	path: string,
	expected: Stats,
): { bytes: Buffer; tasks: z.output<typeof CorpusTaskSchema>[] } {
	let descriptor: number;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		throw new Error("Builder corpus import source could not be opened safely", { cause: error });
	}
	try {
		const before = fstatSync(descriptor);
		if (!before.isFile()) throw new Error("Builder corpus import source must be a regular file");
		if (!sameFileSnapshot(expected, before)) {
			throw new Error("Builder corpus import source changed before it was read");
		}
		if (before.size > MAX_BUILDER_CORPUS_IMPORT_BYTES) {
			throw new Error(`Builder corpus import source exceeds ${MAX_BUILDER_CORPUS_IMPORT_BYTES} bytes`);
		}

		const chunks: Buffer[] = [];
		let totalBytes = 0;
		while (totalBytes <= MAX_BUILDER_CORPUS_IMPORT_BYTES) {
			const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BUILDER_CORPUS_IMPORT_BYTES + 1 - totalBytes));
			const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			chunks.push(chunk.subarray(0, bytesRead));
			totalBytes += bytesRead;
		}
		if (totalBytes > MAX_BUILDER_CORPUS_IMPORT_BYTES) {
			throw new Error(`Builder corpus import source exceeds ${MAX_BUILDER_CORPUS_IMPORT_BYTES} bytes`);
		}
		const after = fstatSync(descriptor);
		if (!sameFileSnapshot(before, after)) {
			throw new Error("Builder corpus import source changed while it was being read");
		}

		const bytes = Buffer.concat(chunks, totalBytes);
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch (error) {
			throw new Error("Builder corpus import source is not valid UTF-8", { cause: error });
		}

		const tasks: z.output<typeof CorpusTaskSchema>[] = [];
		const sourceIds = new Set<string>();
		for (const [index, line] of content.split("\n").entries()) {
			if (!line.trim()) continue;
			const lineNumber = index + 1;
			if (tasks.length >= MAX_BUILDER_CORPUS_IMPORT_TASKS) {
				throw new Error(`Builder corpus import exceeds ${MAX_BUILDER_CORPUS_IMPORT_TASKS} tasks at line ${lineNumber}`);
			}
			let value: unknown;
			try {
				value = JSON.parse(line) as unknown;
			} catch (error) {
				throw new Error(`Builder corpus import has invalid JSON at line ${lineNumber}`, { cause: error });
			}
			const parsed = CorpusTaskSchema.safeParse(value);
			if (!parsed.success) {
				throw new Error(`Builder corpus import task at line ${lineNumber} is invalid: ${parsed.error.message}`);
			}
			if (sourceIds.has(parsed.data.id)) {
				throw new Error(`Builder corpus import contains duplicate source id ${JSON.stringify(parsed.data.id)}`);
			}
			sourceIds.add(parsed.data.id);
			tasks.push(parsed.data);
		}
		if (tasks.length === 0) throw new Error("Builder corpus import must contain at least one task");
		return { bytes, tasks };
	} finally {
		closeSync(descriptor);
	}
}

function receiptsRoot(stateRoot: string, projectIdInput: string, create: boolean): string | null {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const root = resolve(stateRoot);
	if (!existsSync(root)) {
		if (!create) return null;
		mkdirSync(root, { recursive: true, mode: 0o700 });
	}
	const rootEntry = lstatSync(root);
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
		throw new Error(`Builder corpus import stateRoot must be a regular non-symlink directory: ${root}`);
	}
	const canonicalRoot = realpathSync(root);
	let current = root;
	for (const segment of ["projects", projectId, "builder-corpus-imports"]) {
		const next = join(current, segment);
		if (!existsSync(next)) {
			if (!create) return null;
			mkdirSync(next, { mode: 0o700 });
		}
		const entry = lstatSync(next);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`Builder corpus import state component must be a regular non-symlink directory: ${next}`);
		}
		if (!contained(canonicalRoot, realpathSync(next))) {
			throw new Error("Builder corpus import state path escaped stateRoot");
		}
		current = next;
	}
	return current;
}

function publishReceipt(
	stateRoot: string,
	identity: BuilderCorpusImportIdentity,
	now: () => string,
): { receipt: BuilderCorpusImportReceipt; path: string } {
	const receipt = BuilderCorpusImportReceiptSchema.parse({
		...identity,
		id: receiptId(identity),
		createdAt: now(),
	});
	const root = receiptsRoot(stateRoot, receipt.projectId, true);
	if (!root) throw new Error("failed to create Builder corpus import receipt directory");
	const path = join(root, `${receipt.id}.json`);
	if (existsSync(path)) {
		const existing = readJsonArtifact(path, BuilderCorpusImportReceiptSchema);
		const { createdAt: _existingCreatedAt, ...existingIdentity } = existing;
		const { createdAt: _receiptCreatedAt, ...receiptIdentity } = receipt;
		if (canonicalJson(existingIdentity) !== canonicalJson(receiptIdentity)) {
			throw new Error(`content-address collision for Builder corpus import ${receipt.id}`);
		}
		return { receipt: existing, path };
	}
	try {
		writeJsonArtifact(path, BuilderCorpusImportReceiptSchema, receipt, { immutable: true });
	} catch (error) {
		if (!existsSync(path)) throw error;
		const existing = readJsonArtifact(path, BuilderCorpusImportReceiptSchema);
		const { createdAt: _existingCreatedAt, ...existingIdentity } = existing;
		const { createdAt: _receiptCreatedAt, ...receiptIdentity } = receipt;
		if (canonicalJson(existingIdentity) !== canonicalJson(receiptIdentity)) throw error;
		return { receipt: existing, path };
	}
	return { receipt, path };
}

/** Import one bounded project-local JSONL file into a new editable, Spec-bound draft. */
export function importBuilderCorpusDraft(
	options: ImportBuilderCorpusDraftOptions,
	dependencies: Partial<BuilderCorpusDraftDependencies> = {},
): BuilderCorpusImportResult {
	const source = sourceFilePath(options);
	const imported = readImportSource(source.absolute, source.expected);
	const importSource = BuilderCorpusImportSourceSchema.parse({
		path: source.relative,
		sha256: `sha256:${createHash("sha256").update(imported.bytes).digest("hex")}`,
		bytes: imported.bytes.length,
		taskCount: imported.tasks.length,
	});
	const result = createBuilderCorpusDraft({
		stateRoot: options.stateRoot,
		approvedSpec: options.approvedSpec,
		name: options.name,
		tasks: imported.tasks.map(({ id: _sourceId, ...task }) => task),
		...(options.coverageNotes !== undefined ? { coverageNotes: options.coverageNotes } : {}),
		verifiedImportSource: importSource,
		revisionSummary: options.revisionSummary,
	}, dependencies);
	const identity: BuilderCorpusImportIdentity = {
		schemaVersion: 1,
		kind: "builder-corpus-import",
		projectId: result.draft.projectId,
		approvedSpec: result.draft.approvedSpec,
		draftId: result.draft.id,
		draftHash: hashValue(result.draft),
		source: importSource,
	};
	const published = publishReceipt(options.stateRoot, identity, dependencies.now ?? (() => new Date().toISOString()));
	return { ...result, receipt: published.receipt, receiptPath: published.path };
}

export function loadBuilderCorpusImportReceipt(
	stateRoot: string,
	projectIdInput: string,
	importIdInput: string,
): BuilderCorpusImportReceipt {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const importId = ImportIdSchema.parse(importIdInput);
	const root = receiptsRoot(stateRoot, projectId, false);
	if (!root) throw new Error(`project ${projectId} has no Builder corpus imports`);
	const receipt = readJsonArtifact(join(root, `${importId}.json`), BuilderCorpusImportReceiptSchema);
	if (receipt.projectId !== projectId || receipt.approvedSpec.projectId !== projectId) {
		throw new Error("Builder corpus import belongs to a different project");
	}
	const draft = loadBuilderCorpusDraft(stateRoot, projectId, receipt.draftId);
	if (
		hashValue(draft) !== receipt.draftHash ||
		canonicalJson(draft.approvedSpec) !== canonicalJson(receipt.approvedSpec) ||
		canonicalJson(draft.importSource) !== canonicalJson(receipt.source)
	) {
		throw new Error("Builder corpus import receipt does not match its exact draft lineage");
	}
	return receipt;
}

/** Reload the authority receipt deterministically referenced by an imported root draft. */
export function loadBuilderCorpusImportReceiptForDraft(
	stateRoot: string,
	draft: BuilderCorpusDraft,
): BuilderCorpusImportReceipt {
	if (draft.parentDraftId !== null || !draft.importSource) {
		throw new Error("Builder corpus import receipt authority requires an imported root draft");
	}
	const identity: BuilderCorpusImportIdentity = {
		schemaVersion: 1,
		kind: "builder-corpus-import",
		projectId: draft.projectId,
		approvedSpec: draft.approvedSpec,
		draftId: draft.id,
		draftHash: hashValue(draft),
		source: draft.importSource,
	};
	return loadBuilderCorpusImportReceipt(stateRoot, draft.projectId, receiptId(identity));
}
