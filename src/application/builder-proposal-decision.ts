import { existsSync } from "node:fs";
import { z } from "zod";
import { canonicalJson } from "../provenance.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";

const ArtifactIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
const GitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const NonBlankSchema = z.string().min(1).refine((value) => value.trim().length > 0, "expected non-blank text");
const HumanActorSchema = z.strictObject({ kind: z.literal("human"), id: NonBlankSchema });
const TimestampSchema = z.iso.datetime({ offset: true });

const CommonClaimShape = {
	schemaVersion: z.literal(1),
	runId: ArtifactIdSchema,
	builderRunSha256: HashSchema,
	proposalSha256: HashSchema,
	baseTargetSha: GitShaSchema,
};

export const BuilderProposalDecisionClaimSchema = z.discriminatedUnion("decision", [
	z.strictObject({
		...CommonClaimShape,
		decision: z.literal("apply"),
		candidateSha: GitShaSchema,
		branch: NonBlankSchema,
		paths: z.array(z.string().min(1)).min(1)
			.refine((paths) => new Set(paths).size === paths.length, "paths must be unique"),
		actor: HumanActorSchema,
		via: z.enum(["improvement-loop", "proposal-search"]).nullable(),
		/**
		 * The verification amount the apply dialog showed and the operator
		 * approved with the diff, or null for an automated apply. It rides on the
		 * claim because the claim, not the receipt, is what a crashed apply is
		 * rebuilt from: leaving it out would make a recovered receipt differ from
		 * the one the human authorized.
		 */
		verificationAuthorization: z.strictObject({
			executions: z.number().int().min(0),
			sampledRuns: z.number().int().min(0),
			costUsd: z.number().min(0).nullable(),
			minutes: z.number().min(0).nullable(),
		}).nullable(),
		decidedAt: TimestampSchema,
		reason: NonBlankSchema,
	}),
	z.strictObject({
		...CommonClaimShape,
		decision: z.literal("discard"),
		subjectHash: HashSchema,
		actor: HumanActorSchema,
		decidedAt: TimestampSchema,
		reason: NonBlankSchema,
	}),
]);
export type BuilderProposalDecisionClaim = z.infer<typeof BuilderProposalDecisionClaimSchema>;

export function builderProposalDecisionClaimPath(runsRoot: string, runId: string): string {
	return resolveContainedArtifactPath(
		runsRoot,
		"builders",
		ArtifactIdSchema.parse(runId),
		"decision_claim.json",
	);
}

export function loadBuilderProposalDecisionClaim(
	runsRoot: string,
	runId: string,
): BuilderProposalDecisionClaim | null {
	const path = builderProposalDecisionClaimPath(runsRoot, runId);
	return existsSync(path) ? readJsonArtifact(path, BuilderProposalDecisionClaimSchema) : null;
}

/**
 * Atomically claim the one terminal decision available to a proposal. Exact
 * retries are idempotent; a different action or payload can never replace the
 * winner, even when two processes race.
 */
export function claimBuilderProposalDecision(
	runsRoot: string,
	runId: string,
	claim: BuilderProposalDecisionClaim,
): { claim: BuilderProposalDecisionClaim; replay: boolean } {
	const parsed = BuilderProposalDecisionClaimSchema.parse(claim);
	if (parsed.runId !== ArtifactIdSchema.parse(runId)) {
		throw new Error("proposal decision claim run id mismatch");
	}
	const path = builderProposalDecisionClaimPath(runsRoot, runId);
	try {
		writeJsonArtifact(path, BuilderProposalDecisionClaimSchema, parsed, { immutable: true });
		return { claim: parsed, replay: false };
	} catch (error) {
		if (!existsSync(path)) throw error;
		const existing = readJsonArtifact(path, BuilderProposalDecisionClaimSchema);
		if (canonicalJson(existing) === canonicalJson(parsed)) {
			return { claim: existing, replay: true };
		}
		throw new Error(
			`builder proposal ${runId} already has an immutable ${existing.decision} decision claim; ` +
			`cannot ${parsed.decision}`,
			{ cause: error },
		);
	}
}
