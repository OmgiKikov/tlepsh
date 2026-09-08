import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { readDatasetSource } from "./dataset-source.js";
import { canonicalJson, HashSchema, hashValue } from "../provenance.js";
import {
	ApprovedSpecReferenceSchema,
	type ApprovedSpecReference,
} from "../spec.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import { projectStateDir } from "../storage/paths.js";

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

/** The JSONL lines of one inbox file as tasks: bounded in count, unique by source id. */
function parseImportTasks(content: string): z.output<typeof CorpusTaskSchema>[] {
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
	return tasks;
}

function receiptsRoot(stateRoot: string, projectIdInput: string, create: boolean): string | null {
	return projectStateDir(stateRoot, projectIdInput, "builder-corpus-imports", { create, label: "Builder corpus import" });
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
	// The importer's own path contract first (its messages name the Builder
	// inbox), then the one physical inbox reader every import shares, capped at
	// this importer's smaller bound; the JSONL contract is applied to its text.
	const sourcePath = BuilderCorpusImportSourcePathSchema.parse(options.sourcePath);
	const file = readDatasetSource({
		projectDir: options.projectDir,
		sourcePath,
		protectedRoots: [resolve(options.stateRoot), resolve(options.runsRoot)],
		maxBytes: MAX_BUILDER_CORPUS_IMPORT_BYTES,
	});
	const tasks = parseImportTasks(file.text);
	const importSource = BuilderCorpusImportSourceSchema.parse({
		path: file.path,
		sha256: file.sha256,
		bytes: file.bytes,
		taskCount: tasks.length,
	});
	const result = createBuilderCorpusDraft({
		stateRoot: options.stateRoot,
		approvedSpec: options.approvedSpec,
		name: options.name,
		tasks: tasks.map(({ id: _sourceId, ...task }) => task),
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
