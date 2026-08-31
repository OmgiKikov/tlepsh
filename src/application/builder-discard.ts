import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CandidateProposalSchema } from "../builders/adapters.js";
import { canonicalJson, hashValue } from "../provenance.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";
import { builderApplyIntentPath, loadBuilderProposalRun } from "./builder-proposal.js";
import {
	claimBuilderProposalDecision,
	loadBuilderProposalDecisionClaim,
} from "./builder-proposal-decision.js";

const ArtifactIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const NonBlankSchema = z.string().min(1).refine((value) => value.trim().length > 0, "expected non-blank text");

export const BuilderProposalDiscardSubjectSchema = z.strictObject({
	schemaVersion: z.literal(1),
	runId: ArtifactIdSchema,
	proposalSha256: HashSchema,
	baseTargetSha: z.string().regex(/^[0-9a-f]{40}$/),
	summary: NonBlankSchema,
	paths: z.array(z.string().min(1)).min(1),
});
export type BuilderProposalDiscardSubject = z.infer<typeof BuilderProposalDiscardSubjectSchema>;

export const BuilderDiscardReceiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	runId: ArtifactIdSchema,
	proposalSha256: HashSchema,
	subjectHash: HashSchema,
	baseTargetSha: z.string().regex(/^[0-9a-f]{40}$/),
	actor: z.strictObject({ kind: z.literal("human"), id: NonBlankSchema }),
	discardedAt: z.iso.datetime({ offset: true }),
	reason: NonBlankSchema,
});
export type BuilderDiscardReceipt = z.infer<typeof BuilderDiscardReceiptSchema>;

export interface DiscardBuilderProposalOptions {
	runsRoot: string;
	runId: string;
	actor: { kind: "human"; id: string };
	reason: string;
	/** Host-owned hash captured before the confirmation dialog. */
	expectedSubjectHash: string;
}

export interface DiscardBuilderProposalResult {
	receipt: BuilderDiscardReceipt;
	receiptPath: string;
}

function sha256(bytes: Buffer): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function builderDiscardReceiptPath(runsRoot: string, runId: string): string {
	return resolveContainedArtifactPath(runsRoot, "builders", ArtifactIdSchema.parse(runId), "discard_receipt.json");
}

export function describeBuilderProposalDiscard(
	runsRoot: string,
	runIdInput: string,
): { subject: BuilderProposalDiscardSubject; subjectHash: string } {
	const runId = ArtifactIdSchema.parse(runIdInput);
	const record = loadBuilderProposalRun(runsRoot, runId);
	if (record.result.status !== "completed" || !record.result.proposal || !record.artifacts.proposal) {
		throw new Error(`builder run ${runId} has no completed proposal to discard`);
	}
	if (record.result.proposal.decision !== "propose" || record.result.proposal.changes.length === 0) {
		throw new Error(`builder run ${runId} is a no-change result and has no proposal to discard`);
	}
	const proposalPath = resolveContainedArtifactPath(runsRoot, "builders", runId, record.artifacts.proposal.path);
	const proposalBytes = readFileSync(proposalPath);
	if (
		proposalBytes.length !== record.artifacts.proposal.bytes ||
		sha256(proposalBytes) !== record.artifacts.proposal.sha256
	) {
		throw new Error(`builder run ${runId} proposal artifact does not match its immutable evidence reference`);
	}
	const proposal = readJsonArtifact(proposalPath, CandidateProposalSchema);
	if (canonicalJson(proposal) !== canonicalJson(record.result.proposal)) {
		throw new Error(`builder run ${runId} proposal artifact does not match its completed result`);
	}
	const subject = BuilderProposalDiscardSubjectSchema.parse({
		schemaVersion: 1,
		runId,
		proposalSha256: record.artifacts.proposal.sha256,
		baseTargetSha: proposal.baseTargetSha,
		summary: proposal.summary,
		paths: proposal.changes.map((change) => change.path).sort(),
	});
	return { subject, subjectHash: hashValue(subject) };
}

export function assertBuilderProposalNotDiscarded(runsRoot: string, runId: string): void {
	if (existsSync(builderDiscardReceiptPath(runsRoot, runId))) {
		throw new Error(`builder proposal ${runId} was already discarded and cannot be applied`);
	}
	if (loadBuilderProposalDecisionClaim(runsRoot, runId)?.decision === "discard") {
		throw new Error(`builder proposal ${runId} has an immutable discard decision claim and cannot be applied`);
	}
}

export function discardBuilderProposal(
	options: DiscardBuilderProposalOptions,
	dependencies: {
		now?: () => string;
		writeReceipt?: (path: string, receipt: BuilderDiscardReceipt) => void;
	} = {},
): DiscardBuilderProposalResult {
	const runId = ArtifactIdSchema.parse(options.runId);
	const reason = NonBlankSchema.parse(options.reason);
	const actor = z.strictObject({ kind: z.literal("human"), id: NonBlankSchema }).parse(options.actor);
	const expectedSubjectHash = HashSchema.parse(options.expectedSubjectHash);
	const receiptPath = builderDiscardReceiptPath(options.runsRoot, runId);
	if (existsSync(receiptPath)) throw new Error(`discard receipt already exists for builder run ${runId}`);
	const applyReceiptPath = resolveContainedArtifactPath(options.runsRoot, "builders", runId, "apply_receipt.json");
	if (existsSync(applyReceiptPath)) throw new Error(`builder proposal ${runId} was already applied and cannot be discarded`);
	if (existsSync(builderApplyIntentPath(options.runsRoot, runId))) {
		throw new Error(`builder proposal ${runId} has a recoverable apply in progress and cannot be discarded`);
	}

	const described = describeBuilderProposalDiscard(options.runsRoot, runId);
	if (described.subjectHash !== expectedSubjectHash) {
		throw new Error("Builder proposal changed after confirmation; discard approval is stale");
	}
	const record = loadBuilderProposalRun(options.runsRoot, runId);
	const builderRunSha256 = hashValue(record);
	const existingClaim = loadBuilderProposalDecisionClaim(options.runsRoot, runId);
	if (existingClaim?.decision === "apply") {
		throw new Error(`builder proposal ${runId} already has an immutable apply decision claim; cannot discard`);
	}
	const discardedAt = existingClaim?.decision === "discard"
		? existingClaim.decidedAt
		: (dependencies.now ?? (() => new Date().toISOString()))();
	const receipt = BuilderDiscardReceiptSchema.parse({
		schemaVersion: 1,
		runId,
		proposalSha256: described.subject.proposalSha256,
		subjectHash: described.subjectHash,
		baseTargetSha: described.subject.baseTargetSha,
		actor,
		discardedAt,
		reason,
	});
	claimBuilderProposalDecision(options.runsRoot, runId, {
		schemaVersion: 1,
		decision: "discard",
		runId,
		builderRunSha256,
		proposalSha256: receipt.proposalSha256,
		baseTargetSha: receipt.baseTargetSha,
		subjectHash: receipt.subjectHash,
		actor: receipt.actor,
		decidedAt: receipt.discardedAt,
		reason: receipt.reason,
	});
	(dependencies.writeReceipt ?? ((path, value) => {
		writeJsonArtifact(path, BuilderDiscardReceiptSchema, value, { immutable: true });
	}))(receiptPath, receipt);
	return { receipt, receiptPath };
}

export function loadBuilderDiscardReceipt(runsRoot: string, runId: string): BuilderDiscardReceipt {
	return readJsonArtifact(builderDiscardReceiptPath(runsRoot, runId), BuilderDiscardReceiptSchema);
}
