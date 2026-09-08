import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { BuilderCorpusDraft } from "../application/builder-corpus-draft.js";
import type { DevelopmentCorpusPublicationResult } from "../application/builder-authoring.js";
import { loadCriticReceipt, saveCriticReceipt, type CriticReceipt } from "../application/case-critic.js";
import { WorkbenchTypedRefusalError } from "./errors.js";
import type { WorkbenchCriticProjection } from "./types.js";
import { canonicalJson, hashValue } from "../provenance.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import { workbenchStateDirectory } from "./focus.js";
import { captureCorpusSourceBinding, type CorpusSourceBinding } from "../application/corpus-source.js";
import type { ResolvedTarget, TargetManifest } from "../manifest.js";
import { knowledgeBaseDeclared } from "../target/kb-tool.js";
import { t } from "../i18n.js";

export interface CorpusSourceFreshness {
	status: "current" | "changed" | "unknown" | "unavailable";
	binding: CorpusSourceBinding | null;
}

/** A read-only review aid; only the publication path requires a current source. */
export function corpusSourceFreshness(draft: BuilderCorpusDraft, target: ResolvedTarget | null): CorpusSourceFreshness | null {
	if (!draft.sourceBinding && (!target || !knowledgeBaseDeclared(target.manifest.data))) return null;
	let binding: CorpusSourceBinding;
	try {
		if (!target) return { status: "unavailable", binding: null };
		binding = captureCorpusSourceBinding(target);
	} catch {
		return { status: "unavailable", binding: null };
	}
	if (!draft.sourceBinding) return { status: "unknown", binding };
	if (hashValue(binding) !== hashValue(draft.sourceBinding)) return { status: "changed", binding };
	return binding.roots.length === 0 ? null : { status: "current", binding };
}

export function requireCurrentCorpusSources(draft: BuilderCorpusDraft, target: ResolvedTarget | null): CorpusSourceFreshness | null {
	const freshness = corpusSourceFreshness(draft, target);
	if (freshness?.status === "changed" || freshness?.status === "unavailable") {
		throw new Error(t(`corpus.sources.${freshness.status}`));
	}
	return freshness;
}

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
	carryCriticReceiptToCorpus({
		stateRoot: input.stateRoot,
		projectId: record.projectId,
		draftHash: record.draftHash,
		corpus: { id: record.corpusId, hash: record.corpusHash },
	});
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

/** The receipt as the panel, the model and the refusal all read it. */
export function criticProjection(receipt: CriticReceipt): WorkbenchCriticProjection {
	return {
		receiptId: receipt.id,
		judge: `${receipt.judge.provider}/${receipt.judge.id}`,
		at: receipt.createdAt,
		counts: receipt.counts,
		findings: receipt.findings,
	};
}

/** The critic's last reading of exactly this content, or null when nobody asked. */
export function loadCorpusCritic(
	stateRoot: string,
	projectId: string,
	subjectHash: string,
): WorkbenchCriticProjection | null {
	let receipt: CriticReceipt | null;
	try {
		receipt = loadCriticReceipt(stateRoot, projectId, { hash: subjectHash });
	} catch {
		// A corrupt receipt is not a reason to block reading a draft; the critic
		// simply has not spoken about it until it is asked again.
		return null;
	}
	return receipt ? criticProjection(receipt) : null;
}

/**
 * The publication gate the rule above everything implies: a case the critic
 * could not make sense of is repaired or excluded with a reason, and never
 * quietly shipped as a measurement. `force` is the operator's own call and is
 * recorded as one; the composite has no force, so it always refuses.
 */
export function assertCriticApproves(
	stateRoot: string,
	projectId: string,
	subjectHash: string,
	force: boolean,
): void {
	if (force) return;
	const critic = loadCorpusCritic(stateRoot, projectId, subjectHash);
	const invalid = critic?.counts.invalid ?? 0;
	if (invalid === 0) return;
	throw new WorkbenchTypedRefusalError(
		`the critic marked ${invalid} case(s) invalid; repair them or exclude them with a reason, or publish with force`,
		{ code: "refusal.publish-invalid-cases", params: { invalid } },
	);
}

/**
 * Re-key the draft's reading onto the corpus it became, so a later basket
 * reading — which knows the corpus hash and not the draft's — still finds the
 * verdicts that were paid for once.
 */
export function carryCriticReceiptToCorpus(input: {
	stateRoot: string;
	projectId: string;
	draftHash: string;
	corpus: { id: string; hash: string };
}): CriticReceipt | null {
	const receipt = loadCriticReceipt(input.stateRoot, input.projectId, { hash: input.draftHash });
	if (!receipt) return null;
	return saveCriticReceipt({
		stateRoot: input.stateRoot,
		projectId: input.projectId,
		subject: { kind: "development-corpus", id: input.corpus.id, hash: input.corpus.hash },
		// The copy names the model that actually spoke, not whatever is configured now.
		judge: receipt.judge,
		findings: receipt.findings,
		spend: receipt.spend,
		now: () => receipt.createdAt,
	});
}
