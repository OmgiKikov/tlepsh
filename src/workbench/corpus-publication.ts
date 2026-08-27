import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { BuilderCorpusDraft } from "../application/builder-corpus-draft.js";
import type { DevelopmentCorpusPublicationResult } from "../application/builder-authoring.js";
import { canonicalJson, hashValue } from "../provenance.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import { workbenchStateDirectory } from "./focus.js";

const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const NonBlankSchema = z.string().min(1).refine((value) => value.trim().length > 0);

export const WorkbenchCorpusPublicationSchema = z.strictObject({
	schemaVersion: z.literal(1),
	projectId: IdSchema,
	draftId: IdSchema,
	draftHash: HashSchema,
	approvedSpecId: IdSchema,
	approvedSpecHash: HashSchema,
	corpusId: IdSchema,
	corpusHash: HashSchema,
	publicationReceiptId: IdSchema,
	publicationReceiptHash: HashSchema,
	actor: z.strictObject({ kind: z.literal("human"), id: NonBlankSchema.max(256) }),
	reason: NonBlankSchema.max(4_000),
	publishedAt: z.iso.datetime({ offset: true }),
	linkHash: HashSchema,
}).superRefine((record, context) => {
	const { linkHash: _linkHash, ...identity } = record;
	if (record.linkHash !== hashValue(identity)) {
		context.addIssue({ code: "custom", path: ["linkHash"], message: "link hash does not match exact publication lineage" });
	}
});
export type WorkbenchCorpusPublication = z.infer<typeof WorkbenchCorpusPublicationSchema>;

function publicationPath(stateRoot: string, projectId: string, corpusId: string, create: boolean): string {
	const root = workbenchStateDirectory(stateRoot, projectId, create);
	if (!root) throw new Error(`project ${projectId} has no Workbench state`);
	const directory = join(root, "corpus-publications");
	if (!existsSync(directory)) {
		if (!create) throw new Error(`development corpus ${corpusId} has no Workbench publication lineage`);
		mkdirSync(directory, { mode: 0o700 });
	}
	const entry = lstatSync(directory);
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new Error(`Workbench corpus publication directory must be a regular non-symlink directory: ${directory}`);
	}
	return join(directory, `${IdSchema.parse(corpusId)}.json`);
}

export function recordWorkbenchCorpusPublication(input: {
	stateRoot: string;
	draft: BuilderCorpusDraft;
	publication: DevelopmentCorpusPublicationResult;
}): WorkbenchCorpusPublication {
	if (input.draft.projectId !== input.publication.corpus.projectId) throw new Error("corpus draft and publication belong to different projects");
	if (input.draft.tasks.length !== input.publication.corpus.taskCount || hashValue(input.draft.tasks) !== input.publication.corpus.hash) {
		throw new Error("published development corpus does not match the exact reviewed corpus draft");
	}
	const identity = {
		schemaVersion: 1 as const,
		projectId: input.draft.projectId,
		draftId: input.draft.id,
		draftHash: hashValue(input.draft),
		approvedSpecId: input.draft.approvedSpec.specId,
		approvedSpecHash: input.draft.approvedSpec.snapshotHash,
		corpusId: input.publication.corpus.id,
		corpusHash: input.publication.corpus.hash,
		publicationReceiptId: input.publication.receipt.id,
		publicationReceiptHash: hashValue(input.publication.receipt),
		actor: input.publication.receipt.actor,
		reason: input.publication.receipt.reason,
		publishedAt: input.publication.receipt.publishedAt,
	};
	const record = WorkbenchCorpusPublicationSchema.parse({ ...identity, linkHash: hashValue(identity) });
	const path = publicationPath(input.stateRoot, record.projectId, record.corpusId, true);
	if (existsSync(path)) {
		const existing = readJsonArtifact(path, WorkbenchCorpusPublicationSchema);
		if (canonicalJson(existing) !== canonicalJson(record)) throw new Error("development corpus already has different Workbench lineage");
		return existing;
	}
	writeJsonArtifact(path, WorkbenchCorpusPublicationSchema, record, { immutable: true });
	return record;
}

export function loadWorkbenchCorpusPublication(
	stateRoot: string,
	projectId: string,
	corpusId: string,
): WorkbenchCorpusPublication {
	return readJsonArtifact(publicationPath(stateRoot, projectId, corpusId, false), WorkbenchCorpusPublicationSchema);
}
