import { resolveCandidateArtifact, type CandidateArtifactKind } from "./candidate-artifacts.js";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
	ApprovedSpecBuilderInputSchema,
	BuilderApplyReceiptSchema,
	PersistedBuilderRunSchema,
} from "./builder-proposal.js";
import {
	comparisonGateEvidence,
} from "./candidate-experiment.js";
import { screenExclusion } from "./cheap-check.js";
import { corpusDatasetLabel } from "./corpus-target.js";
import {
	loadImprovementExperimentDesign,
	type ImprovementExperimentDesign,
} from "./improvement-experiment-design.js";
import { compareEvalRuns, type CompareResult } from "../compare.js";
import { promotableVerdicts, withinInfrastructureBudget, type GateSurface } from "../domain/comparison-gate.js";
import { CandidateProposalSchema } from "../builders/adapters.js";
import { DiagnosisRecordSchema } from "../diagnosis.js";
import {
	CandidateRecordSchema,
	type ComparisonGateEvidence,
	candidateStatus,
	isPromotionGradeGateEvidence,
	transitionCandidate,
	type CandidateRecord,
} from "../domain/candidate.js";
import { TargetManifest, type JudgeCalibrationPolicy } from "../manifest.js";
import { judgeEvidenceCalibration } from "./judge-labels.js";
import { judgeCalibrationRefusal } from "../domain/judge-agreement.js";
import { loadEvalRun, loadVerifiedEvalRun, readEvalRunIndex, type EvalRunRecord } from "../eval.js";
import { loadApprovedSpec, SpecSnapshotSchema } from "../spec.js";
import { canonicalJson, hashValue } from "../provenance.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";

export interface ReviewCandidateOptions {
	runsRoot: string;
	stateRoot?: string;
	candidateId: string;
	/** Exact Candidate aggregate reviewed by a host confirmation, when one exists. */
	expectedCandidateHash?: string;
	/**
	 * Exact proposal artifact displayed by the host. Required for a promote
	 * recommendation when an automated improve/search applied the candidate,
	 * because that earlier authority did not mean the operator read the diff.
	 */
	expectedProposalHash?: string;
	recommendation: "promote" | "reject";
	reason: string;
	actorId?: string;
	now?: () => string;
}

export interface DecideCandidateOptions {
	runsRoot: string;
	stateRoot?: string;
	candidateId: string;
	/** Exact Candidate aggregate reviewed by a host confirmation, when one exists. */
	expectedCandidateHash?: string;
	reason: string;
	actorId?: string;
	tag?: string;
	now?: () => string;
}

export interface PromoteReviewedCandidateOptions {
	repositoryDir: string;
	runsRoot: string;
	candidateId: string;
	/** Exact Candidate aggregate reviewed by a host confirmation, when one exists. */
	expectedCandidateHash?: string;
	version: string;
	reason: string;
	actorId?: string;
	/**
	 * Current project state store for legacy Spec provenance and human judge labels.
	 * Required for a legacy non-sibling Spec layout or a Target whose manifest sets `evalSuite.judge.requireCalibration`: without it that
	 * policy cannot be evaluated, and an unevaluable promotion policy refuses.
	 */
	stateRoot?: string;
	now?: () => string;
}

export interface PromoteReviewedCandidateResult {
	record: CandidateRecord;
	tag: string;
	candidateSha: string;
}

const LegacyPromotionIntentSchema = z.strictObject({
	schemaVersion: z.literal(1),
	candidateBeforeSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
	tag: z.string().regex(/^v\d+\.\d+\.\d+$/),
	candidateSha: z.string().regex(/^[0-9a-f]{40}$/),
	at: z.iso.datetime({ offset: true }),
	actorId: z.string().min(1),
	reason: z.string().min(1),
	tagMessage: z.string().min(1),
	promoted: CandidateRecordSchema,
});

const ExactPromotionIntentSchema = z.strictObject({
	schemaVersion: z.literal(2),
	candidateBeforeSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
	tag: z.string().regex(/^v\d+\.\d+\.\d+$/),
	candidateSha: z.string().regex(/^[0-9a-f]{40}$/),
	at: z.iso.datetime({ offset: true }),
	actorId: z.string().min(1),
	reason: z.string().min(1),
	tagMessage: z.string().min(1),
	taggerName: z.literal("AHDE human gate"),
	taggerEmail: z.literal("ahde@local"),
	promoted: CandidateRecordSchema,
});
const PromotionIntentSchema = z.discriminatedUnion("schemaVersion", [
	LegacyPromotionIntentSchema,
	ExactPromotionIntentSchema,
]);
type PromotionIntent = z.infer<typeof PromotionIntentSchema>;
const PROMOTION_TAGGER_NAME = "AHDE human gate";
const PROMOTION_TAGGER_EMAIL = "ahde@local";

const CandidateTransitionClaimSchema = z.strictObject({
	schemaVersion: z.literal(1),
	operation: z.enum(["promote", "reject"]),
	channel: z.enum(["record-only", "git-tag"]),
	candidateId: z.string().min(1),
	candidateBeforeSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
	candidateAfterSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
	promotionIntentSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
	after: CandidateRecordSchema,
});
type CandidateTransitionClaim = z.infer<typeof CandidateTransitionClaimSchema>;

export interface PromoteReviewedCandidateDependencies {
	writeIntent: (path: string, intent: PromotionIntent) => void;
	writeClaim: (path: string, claim: CandidateTransitionClaim) => void;
}

const DEFAULT_PROMOTION_DEPENDENCIES: PromoteReviewedCandidateDependencies = {
	writeIntent: (path, intent) => writeJsonArtifact(path, PromotionIntentSchema, intent, { immutable: true }),
	writeClaim: (path, claim) => writeJsonArtifact(path, CandidateTransitionClaimSchema, claim, { immutable: true }),
};

export function candidateRecordPath(runsRoot: string, candidateId: string): string {
	return resolveContainedArtifactPath(runsRoot, "candidates", candidateId, "candidate.json");
}

export function loadCandidateRecord(runsRoot: string, candidateId: string): CandidateRecord {
	return readJsonArtifact(candidateRecordPath(runsRoot, candidateId), CandidateRecordSchema);
}

function assertExpectedCandidateHash(
	record: CandidateRecord,
	expectedCandidateHash: string | undefined,
	operation: string,
): void {
	if (expectedCandidateHash !== undefined && hashValue(record) !== expectedCandidateHash) {
		throw new Error(`candidate changed after confirmation; ${operation} is stale`);
	}
}

function assertAutomatedProposalWasReviewed(
	record: CandidateRecord,
	expectedProposalHash: string | undefined,
	recommendation: ReviewCandidateOptions["recommendation"],
): void {
	// Rejecting creates no release authority and must remain possible even when a
	// proposal artifact is damaged. A promote recommendation is the boundary at
	// which an automated trial must become an individually reviewed diff.
	if (
		recommendation === "reject" ||
		record.origin.kind !== "applied-builder" ||
		record.origin.application.via === undefined
	) return;
	const proposalHash = record.origin.proposal.sha256;
	if (expectedProposalHash === undefined) {
		throw new Error(
			`candidate ${record.candidateId} was applied by ${record.origin.application.via} without individual diff review; ` +
			`review requires the exact proposal hash ${proposalHash}`,
		);
	}
	if (expectedProposalHash !== proposalHash) {
		throw new Error("proposal changed after confirmation; candidate review is stale");
	}
}

function evaluatedExperimentId(record: CandidateRecord): string {
	const evaluated = record.events.find((event) => event.type === "evaluated");
	if (!evaluated || evaluated.type !== "evaluated") {
		throw new Error(`candidate ${record.candidateId} has no evaluated experiment`);
	}
	return evaluated.evaluation.experimentId;
}

function persist(record: CandidateRecord, runsRoot: string): CandidateRecord {
	const validated = CandidateRecordSchema.parse(record);
	writeJsonArtifact(candidateRecordPath(runsRoot, record.candidateId), CandidateRecordSchema, validated);
	return validated;
}

function persistIfUnchanged(
	record: CandidateRecord,
	runsRoot: string,
	expectedCurrentHash: string,
	operation: string,
): CandidateRecord {
	const current = loadCandidateRecord(runsRoot, record.candidateId);
	if (hashValue(current) !== expectedCurrentHash) {
		throw new Error(`candidate changed while ${operation}; refusing to overwrite newer state`);
	}
	return persist(record, runsRoot);
}

function promotionIntentPath(runsRoot: string, candidateId: string): string {
	return resolveContainedArtifactPath(runsRoot, "candidates", candidateId, "promotion_intent.json");
}

function transitionClaimPath(runsRoot: string, candidateId: string): string {
	return resolveContainedArtifactPath(runsRoot, "candidates", candidateId, "transition_claim.json");
}

function readTransitionClaim(path: string): CandidateTransitionClaim | null {
	if (!existsSync(path)) return null;
	const claim = readJsonArtifact(path, CandidateTransitionClaimSchema);
	if (
		hashValue(claim.after) !== claim.candidateAfterSha256 ||
		claim.after.candidateId !== claim.candidateId
	) {
		throw new Error("candidate transition claim failed its integrity check");
	}
	return claim;
}

function assertExactClaim(actual: CandidateTransitionClaim, expected: CandidateTransitionClaim): void {
	if (canonicalJson(actual) !== canonicalJson(expected)) {
		throw new Error(
			`candidate ${expected.candidateId} already has a different ${actual.operation} transition in progress`,
		);
	}
}

function acquireTransitionClaim(
	path: string,
	claim: CandidateTransitionClaim,
	writeClaim: (path: string, claim: CandidateTransitionClaim) => void,
): CandidateTransitionClaim {
	const existing = readTransitionClaim(path);
	if (existing) {
		assertExactClaim(existing, claim);
		return existing;
	}
	writeClaim(path, claim);
	const published = readTransitionClaim(path);
	if (!published) throw new Error("candidate transition claim disappeared during publication");
	assertExactClaim(published, claim);
	return published;
}

function removeExactTransitionClaim(path: string, claim: CandidateTransitionClaim): void {
	const existing = readTransitionClaim(path);
	if (!existing) return;
	assertExactClaim(existing, claim);
	unlinkSync(path);
}

function transitionClaim(
	operation: "promote" | "reject",
	channel: "record-only" | "git-tag",
	before: CandidateRecord,
	after: CandidateRecord,
	promotionIntentSha256: string | null,
): CandidateTransitionClaim {
	return CandidateTransitionClaimSchema.parse({
		schemaVersion: 1,
		operation,
		channel,
		candidateId: before.candidateId,
		candidateBeforeSha256: hashValue(before),
		candidateAfterSha256: hashValue(after),
		promotionIntentSha256,
		after,
	});
}

/** Append an explicit human review. Review never promotes or rejects by itself. */
export function reviewCandidate(options: ReviewCandidateOptions): CandidateRecord {
	const record = loadCandidateRecord(options.runsRoot, options.candidateId);
	assertExpectedCandidateHash(record, options.expectedCandidateHash, "review");
	assertAutomatedProposalWasReviewed(record, options.expectedProposalHash, options.recommendation);
	if (candidateStatus(record) !== "evaluated") {
		throw new Error(`candidate ${record.candidateId} must be evaluated before review`);
	}
	return persist(
		transitionCandidate(record, {
			type: "reviewed",
			eventId: `${record.candidateId}:reviewed:${record.events.length}`,
			at: (options.now ?? (() => new Date().toISOString()))(),
			actor: { kind: "human", id: options.actorId ?? "local-user" },
			review: {
				experimentId: evaluatedExperimentId(record),
				recommendation: options.recommendation,
				reason: options.reason,
			},
		}),
		options.runsRoot,
	);
}

/** Append the human rejection decision after review. */
export function decideCandidateRejection(
	options: DecideCandidateOptions,
	dependencies: Partial<Pick<PromoteReviewedCandidateDependencies, "writeClaim">> = {},
): CandidateRecord {
	const writeClaim = dependencies.writeClaim ?? DEFAULT_PROMOTION_DEPENDENCIES.writeClaim;
	const claimPath = transitionClaimPath(options.runsRoot, options.candidateId);
	const pendingPromotionPath = promotionIntentPath(options.runsRoot, options.candidateId);
	let record = loadCandidateRecord(options.runsRoot, options.candidateId);
	const existingClaim = readTransitionClaim(claimPath);
	if (existingClaim?.operation === "promote" || existsSync(pendingPromotionPath)) {
		throw new Error(`candidate ${record.candidateId} has a promotion in progress; resume that exact promotion before rejection`);
	}

	if (existingClaim) {
		const decision = existingClaim.after.events.at(-1);
		if (
			existingClaim.operation !== "reject" ||
			existingClaim.channel !== "record-only" ||
			decision?.type !== "rejected" ||
			decision.actor.id !== (options.actorId ?? "local-user") ||
			decision.decision.reason !== options.reason
		) {
			throw new Error(`candidate ${record.candidateId} already has a different rejection in progress`);
		}
		if (
			options.expectedCandidateHash !== undefined &&
			options.expectedCandidateHash !== existingClaim.candidateBeforeSha256
		) throw new Error("candidate changed after confirmation; rejection is stale");
		const currentHash = hashValue(record);
		if (currentHash === existingClaim.candidateAfterSha256) {
			removeExactTransitionClaim(claimPath, existingClaim);
			return existingClaim.after;
		}
		if (currentHash !== existingClaim.candidateBeforeSha256) {
			throw new Error("candidate changed while rejecting; refusing to overwrite newer state");
		}
		const rejected = persistIfUnchanged(
			existingClaim.after,
			options.runsRoot,
			existingClaim.candidateBeforeSha256,
			"rejecting",
		);
		removeExactTransitionClaim(claimPath, existingClaim);
		return rejected;
	}

	assertExpectedCandidateHash(record, options.expectedCandidateHash, "rejection");
	if (candidateStatus(record) !== "reviewed") {
		throw new Error(`candidate ${record.candidateId} must be reviewed before rejection`);
	}
	const rejected = transitionCandidate(record, {
		type: "rejected",
		eventId: `${record.candidateId}:rejected:${record.events.length}`,
		at: (options.now ?? (() => new Date().toISOString()))(),
		actor: { kind: "human", id: options.actorId ?? "local-user" },
		decision: { experimentId: evaluatedExperimentId(record), reason: options.reason },
	});
	const claim = transitionClaim("reject", "record-only", record, rejected, null);
	acquireTransitionClaim(claimPath, claim, writeClaim);
	// A promoter may have published its durable intent just before this claim won.
	// Give that earlier external-effect journal priority and leave neither decision
	// half-applied; a retry will deterministically acquire one claim.
	if (existsSync(pendingPromotionPath)) {
		removeExactTransitionClaim(claimPath, claim);
		throw new Error(`candidate ${record.candidateId} has a promotion in progress; resume that exact promotion before rejection`);
	}
	try {
		record = persistIfUnchanged(rejected, options.runsRoot, claim.candidateBeforeSha256, "rejecting");
	} catch (error) {
		// No external effect exists for a rejection. A stale reader that acquired
		// the now-free claim must not strand that claim after the CAS refuses.
		removeExactTransitionClaim(claimPath, claim);
		throw error;
	}
	removeExactTransitionClaim(claimPath, claim);
	return record;
}

/**
 * Validate and append a human promotion decision. The caller owns creating
 * the Git tag first; this function refuses A/A, missing holdout evidence, or
 * a review that recommended rejection through the aggregate invariants.
 */
export function decideCandidatePromotion(
	options: DecideCandidateOptions & { tag: string },
	dependencies: Partial<Pick<PromoteReviewedCandidateDependencies, "writeClaim">> = {},
): CandidateRecord {
	const writeClaim = dependencies.writeClaim ?? DEFAULT_PROMOTION_DEPENDENCIES.writeClaim;
	const claimPath = transitionClaimPath(options.runsRoot, options.candidateId);
	const pendingIntentPath = promotionIntentPath(options.runsRoot, options.candidateId);
	if (existsSync(pendingIntentPath)) {
		throw new Error(`candidate ${options.candidateId} already has a Git promotion in progress`);
	}
	const record = loadCandidateRecord(options.runsRoot, options.candidateId);
	const existingClaim = readTransitionClaim(claimPath);
	if (existingClaim) {
		if (existingClaim.operation !== "promote" || existingClaim.channel !== "record-only") {
			throw new Error(`candidate ${record.candidateId} already has a different ${existingClaim.operation} transition in progress`);
		}
		const decision = existingClaim.after.events.at(-1);
		if (
			decision?.type !== "promoted" ||
			decision.actor.id !== (options.actorId ?? "local-user") ||
			decision.decision.tag !== options.tag ||
			decision.decision.reason !== options.reason
		) throw new Error(`candidate ${record.candidateId} already has a different promotion in progress`);
		if (
			options.expectedCandidateHash !== undefined &&
			options.expectedCandidateHash !== existingClaim.candidateBeforeSha256
		) throw new Error("candidate changed after confirmation; promotion decision is stale");
		const currentHash = hashValue(record);
		if (currentHash === existingClaim.candidateAfterSha256) {
			removeExactTransitionClaim(claimPath, existingClaim);
			return existingClaim.after;
		}
		if (currentHash !== existingClaim.candidateBeforeSha256) {
			throw new Error("candidate changed while promoting; refusing to overwrite newer state");
		}
		const promoted = persistIfUnchanged(
			existingClaim.after,
			options.runsRoot,
			existingClaim.candidateBeforeSha256,
			"promoting",
		);
		removeExactTransitionClaim(claimPath, existingClaim);
		return promoted;
	}

	assertExpectedCandidateHash(record, options.expectedCandidateHash, "promotion decision");
	if (candidateStatus(record) !== "reviewed") {
		throw new Error(`candidate ${record.candidateId} must be reviewed before promotion`);
	}
	verifyPromotionEvidence(record, options.runsRoot, options.stateRoot);
	const promoted = previewPromotion(record, {
		tag: options.tag,
		reason: options.reason,
		actorId: options.actorId ?? "local-user",
		at: (options.now ?? (() => new Date().toISOString()))(),
	});
	const claim = transitionClaim("promote", "record-only", record, promoted, null);
	acquireTransitionClaim(claimPath, claim, writeClaim);
	let persisted: CandidateRecord;
	try {
		persisted = persistIfUnchanged(promoted, options.runsRoot, claim.candidateBeforeSha256, "promoting");
	} catch (error) {
		// This record-only decision has no external side effect to recover.
		removeExactTransitionClaim(claimPath, claim);
		throw error;
	}
	removeExactTransitionClaim(claimPath, claim);
	return persisted;
}

function git(repositoryDir: string, args: string[]): string {
	return execFileSync("git", ["-C", repositoryDir, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function gitRaw(repositoryDir: string, args: string[]): string {
	return execFileSync("git", ["-C", repositoryDir, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function tagExists(repositoryDir: string, tag: string): boolean {
	const tagRef = `refs/tags/${tag}`;
	const symbolic = spawnSync(
		"git",
		["-C", repositoryDir, "symbolic-ref", "--quiet", "--no-recurse", tagRef],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	if (symbolic.status === 0) {
		throw new Error(`tag ${tag} is a symbolic ref; promotion requires a direct annotated tag`);
	}
	if (symbolic.status !== 1 && symbolic.status !== 128) {
		throw new Error(`cannot inspect whether ${tagRef} is symbolic`);
	}
	const result = spawnSync(
		"git",
		["-C", repositoryDir, "show-ref", "--verify", "--quiet", tagRef],
		{ stdio: "ignore" },
	);
	if (result.status === 0) return true;
	if (result.status === 1) return false;
	throw new Error(`cannot verify whether tag ${tag} exists`);
}

function taggerOffset(at: string): string {
	const match = /(Z|[+-]\d{2}:\d{2})$/.exec(at);
	if (!match) throw new Error(`invalid promotion timestamp: ${at}`);
	return match[1] === "Z" ? "+0000" : match[1]!.replace(":", "");
}

function verifyExactPromotionTag(repositoryDir: string, intent: PromotionIntent): void {
	const tagRef = `refs/tags/${intent.tag}`;
	const symbolic = spawnSync(
		"git",
		["-C", repositoryDir, "symbolic-ref", "--quiet", "--no-recurse", tagRef],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	if (symbolic.status === 0) {
		throw new Error("durable promotion intent collides with a symbolic tag ref");
	}
	if (symbolic.status !== 1) {
		throw new Error(`cannot inspect whether ${tagRef} is symbolic`);
	}
	const tagObject = git(repositoryDir, ["rev-parse", "--verify", tagRef]);
	if (git(repositoryDir, ["cat-file", "-t", tagObject]) !== "tag") {
		throw new Error("durable promotion intent requires a direct annotated tag object");
	}
	const raw = gitRaw(repositoryDir, ["cat-file", "tag", tagObject]);
	const separator = raw.indexOf("\n\n");
	if (separator < 0) throw new Error("durable promotion tag object is malformed");
	const headers = raw.slice(0, separator).split("\n");
	const expectedPrefix = [
		`object ${intent.candidateSha}`,
		"type commit",
		`tag ${intent.tag}`,
	];
	const tagger = headers[3] ?? "";
	const exactTagger = intent.schemaVersion === 2
		? `tagger ${intent.taggerName} <${intent.taggerEmail}> ${Math.floor(Date.parse(intent.at) / 1_000)} ${taggerOffset(intent.at)}`
		: null;
	const taggerMatches = exactTagger
		? tagger === exactTagger
		: /^tagger AHDE human gate <ahde@local> \d+ [+-]\d{4}$/.test(tagger);
	const headersMatch =
		headers.length === 4 &&
		canonicalJson(headers.slice(0, 3)) === canonicalJson(expectedPrefix) &&
		taggerMatches;
	const body = raw.slice(separator + 2);
	const messageMatches = intent.schemaVersion === 2
		? body === intent.tagMessage
		: body === intent.tagMessage || body === `${intent.tagMessage}\n`;
	if (!headersMatch || !messageMatches) {
		throw new Error(
			`durable promotion intent collides with a changed or unrelated annotated tag (${headersMatch ? "message" : "headers"})`,
		);
	}
}

function createExactPromotionTag(repositoryDir: string, intent: PromotionIntent): void {
	execFileSync(
		"git",
		[
			"-C",
			repositoryDir,
			"-c",
			`user.name=${PROMOTION_TAGGER_NAME}`,
			"-c",
			`user.email=${PROMOTION_TAGGER_EMAIL}`,
			"-c",
			"tag.gpgSign=false",
			"tag",
			"-a",
			"--no-sign",
			"--cleanup=verbatim",
			intent.tag,
			"-m",
			intent.tagMessage,
			intent.candidateSha,
		],
		{
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				GIT_COMMITTER_NAME: PROMOTION_TAGGER_NAME,
				GIT_COMMITTER_EMAIL: PROMOTION_TAGGER_EMAIL,
				GIT_COMMITTER_DATE: intent.at,
			},
		},
	);
	verifyExactPromotionTag(repositoryDir, intent);
}

function candidateBeforePromotion(promoted: CandidateRecord, expectedHash: string): CandidateRecord {
	const last = promoted.events.at(-1);
	if (last?.type !== "promoted") throw new Error("durable promotion state has no terminal promotion event");
	const before = CandidateRecordSchema.parse({ ...promoted, events: promoted.events.slice(0, -1) });
	if (hashValue(before) !== expectedHash) {
		throw new Error("durable promotion state does not match its pre-transition Candidate hash");
	}
	return before;
}

function removeExactPromotionIntent(path: string, intent: PromotionIntent): void {
	if (!existsSync(path)) return;
	const existing = readJsonArtifact(path, PromotionIntentSchema);
	if (canonicalJson(existing) !== canonicalJson(intent)) {
		throw new Error("promotion intent changed before cleanup");
	}
	unlinkSync(path);
}

function rollbackExactPromotionTag(repositoryDir: string, intent: PromotionIntent): boolean {
	if (!tagExists(repositoryDir, intent.tag)) return true;
	verifyExactPromotionTag(repositoryDir, intent);
	const tagRef = `refs/tags/${intent.tag}`;
	const objectId = git(repositoryDir, ["rev-parse", "--verify", tagRef]);
	const deleted = spawnSync(
		"git",
		["-C", repositoryDir, "update-ref", "-d", tagRef, objectId],
		{ stdio: "ignore" },
	);
	return deleted.status === 0 && !tagExists(repositoryDir, intent.tag);
}

function builtRevision(record: CandidateRecord): { ref: string; sha: string } {
	const built = record.events.find((event) => event.type === "built");
	if (!built || built.type !== "built") throw new Error(`candidate ${record.candidateId} has no built revision`);
	return built.candidate;
}

function previewPromotion(
	record: CandidateRecord,
	options: { tag: string; reason: string; actorId: string; at: string },
): CandidateRecord {
	const candidate = builtRevision(record);
	return transitionCandidate(record, {
		type: "promoted",
		eventId: `${record.candidateId}:promoted:${record.events.length}`,
		at: options.at,
		actor: { kind: "human", id: options.actorId },
		decision: {
			experimentId: evaluatedExperimentId(record),
			candidate,
			tag: options.tag,
			reason: options.reason,
		},
	});
}

function verifyEvaluationPair(
	runsRoot: string,
	record: CandidateRecord,
	pair: {
		baseline: { evalRunId: string; harness: { sha: string } };
		candidate: { evalRunId: string; harness: { sha: string } };
	},
	label: string,
	surface: GateSurface,
): CompareResult {
	const baseline = loadEvalRun(runsRoot, pair.baseline.evalRunId);
	const candidate = loadEvalRun(runsRoot, pair.candidate.evalRunId);
	for (const [side, evidence] of [["baseline", baseline], ["candidate", candidate]] as const) {
		if (!evidence.target.toolsetHash) {
			throw new Error(`${label} ${side} lacks a hash-anchored Target toolset and is legacy, non-promotable evidence`);
		}
		if (!evidence.target.workspaceHash) {
			throw new Error(`${label} ${side} lacks a hash-anchored Target workspace and is legacy, non-promotable evidence`);
		}
		if (!evidence.target.preparedToolHomeHash) {
			throw new Error(`${label} ${side} lacks a hash-anchored prepared tool home and is legacy, non-promotable evidence`);
		}
		const execution = evidence.provenance.execution;
		const processCapableTools = execution.tools.filter((tool) =>
			!["read", "edit", "write"].includes(tool),
		);
		if (
			execution.workspace !== "isolated-copy-v1" ||
			execution.filesystem !== "workspace-confined-v1" ||
			execution.sandbox === "unavailable" ||
			(processCapableTools.length > 0 && execution.sandbox === "none")
		) {
			throw new Error(
				`${label} ${side} uses non-promotable execution confinement: ` +
				`${execution.workspace}/${execution.filesystem}/${execution.sandbox}`,
			);
		}
	}
	if (baseline.target.id !== record.targetId || candidate.target.id !== record.targetId) {
		throw new Error(`${label} evidence belongs to a different target`);
	}
	if (baseline.target.gitSha !== pair.baseline.harness.sha || candidate.target.gitSha !== pair.candidate.harness.sha) {
		throw new Error(`${label} eval artifacts do not match CandidateRecord harness revisions`);
	}
	if (candidate.baselineEvalRunId !== baseline.evalRunId) {
		throw new Error(`${label} candidate eval is not linked to its recorded baseline`);
	}
	if (
		!withinInfrastructureBudget(baseline.summary.error, baseline.summary.total) ||
		!withinInfrastructureBudget(candidate.summary.error, candidate.summary.total)
	) {
		throw new Error(`${label} contains infrastructure errors over the budget and is inconclusive`);
	}
	const comparison = compareEvalRuns(runsRoot, baseline.evalRunId, candidate.evalRunId, {
		mode: record.mode,
		surface,
	});
	const usable = comparison.status === "comparable" || (
		comparison.status === "inconclusive" &&
		withinInfrastructureBudget(comparison.design.excludedTasks, comparison.design.tasks + comparison.design.excludedTasks)
	);
	if (!usable || comparison.summary.taskCount < 1) {
		throw new Error(comparison.error ?? `${label} contains no comparable task evidence`);
	}
	return comparison;
}

/**
 * Only `exact-comparison-gate-v4` evidence — paired mean grader scores — can
 * back a promotion. Everything older stays readable and is named exactly, so
 * the operator knows the candidate must be verified again rather than patched.
 */
function legacyEvidenceMessage(surface: GateSurface, evidence: ComparisonGateEvidence): string {
	const version = "schemaVersion" in evidence ? `v${evidence.schemaVersion}` : "v1";
	return `${surface} comparison uses legacy ${version} gate evidence and is not promotion-grade: ` +
		"re-verify the candidate to record exact-comparison-gate-v4 evidence";
}

function verifyAppliedBuilderOrigin(
	record: CandidateRecord,
	runsRootInput: string,
	stateRoot?: string,
): { sourceEval: EvalRunRecord | null; experimentDesign: ImprovementExperimentDesign | null } {
	if (record.origin.kind !== "applied-builder") {
		throw new Error("production promotion requires reconstructable applied-Builder provenance");
	}
	const runsRoot = resolve(runsRootInput);
	const origin = record.origin;
	const artifact = (kind: CandidateArtifactKind) => resolveCandidateArtifact(runsRoot, origin, kind, { stateRoot });
	const builderRunPath = artifact("builderRun");
	const builderInputPath = artifact("builderInput");
	const proposalPath = artifact("proposal");
	const receiptPath = artifact("applyReceipt");
	const specPath = artifact("approvedSpec");
	if (origin.source) artifact("sourceEval");
	const diagnosisPath = origin.source ? artifact("sourceDiagnosis") : null;
	const designPath = origin.experimentDesign ? artifact("experimentDesign") : null;

	const builderRun = readJsonArtifact(builderRunPath, PersistedBuilderRunSchema);
	let builderInput: ReturnType<typeof ApprovedSpecBuilderInputSchema.parse>;
	try {
		builderInput = ApprovedSpecBuilderInputSchema.parse(
			JSON.parse(readFileSync(builderInputPath, "utf8")) as unknown,
		);
	} catch (error) {
		throw new Error("Builder input is not reconstructable typed approved-Spec evidence", { cause: error });
	}
	const proposal = readJsonArtifact(proposalPath, CandidateProposalSchema);
	const receipt = readJsonArtifact(receiptPath, BuilderApplyReceiptSchema);
	const verifiedSourceEval = origin.source
		? loadVerifiedEvalRun(runsRoot, origin.source.evalRunId)
		: null;
	if (verifiedSourceEval && !verifiedSourceEval.hasRunHashes) {
		throw new Error("Builder source eval must hash-anchor every member run before promotion");
	}
	const sourceEval = verifiedSourceEval?.record ?? null;
	const diagnosis = origin.source
		? readJsonArtifact(diagnosisPath!, DiagnosisRecordSchema)
		: null;
	const spec = readJsonArtifact(specPath, SpecSnapshotSchema);
	const experimentDesign = origin.experimentDesign
		? loadImprovementExperimentDesign(designPath!)
		: null;
	if (experimentDesign && designPath !== resolveContainedArtifactPath(runsRoot, "improvement-designs", `${experimentDesign.loopId}.json`)) {
		throw new Error("candidate blind experiment design path does not match its identity");
	}

	if (
		builderRun.runId !== origin.builderRunId ||
		builderRun.result.status !== "completed" ||
		!builderRun.artifacts.proposal ||
		builderRun.artifacts.proposal.sha256 !== origin.proposal.sha256 ||
		builderRun.artifacts.input.sha256 !== origin.builderInput.sha256 ||
		builderRun.request.baseTargetSha !== origin.application.baseTargetSha ||
		builderRun.request.provenanceMode !== "canonical"
	) throw new Error("Builder run no longer attributes the exact recorded proposal");
	if (
		builderRun.request.approvedSpec === null ||
		builderRun.request.approvedSpec.specId !== origin.approvedSpec.specId ||
		builderRun.request.approvedSpec.projectId !== origin.approvedSpec.projectId ||
		builderRun.request.approvedSpec.specContentHash !== origin.approvedSpec.specContentHash ||
		builderRun.request.approvedSpec.snapshotHash !== origin.approvedSpec.snapshotHash
	) throw new Error("Builder input no longer references the exact approved Spec");
	if (
		canonicalJson(builderInput.approvedSpec.reference) !== canonicalJson(builderRun.request.approvedSpec) ||
		canonicalJson(builderInput.evaluationEvidence?.source ?? null) !== canonicalJson(builderRun.request.source) ||
		canonicalJson(builderInput.evaluationEvidence?.sourceAttestation ?? null) !== canonicalJson(builderRun.request.sourceAttestation)
	) throw new Error("typed Builder input no longer matches its recorded Spec/source references");
	const failureBundle = builderInput.evaluationEvidence?.failureBundle ?? null;
	const failureBundleHash = failureBundle === null
		? null
		: `sha256:${createHash("sha256").update(failureBundle).digest("hex")}`;
	const failureBundleBytes = failureBundle === null ? 0 : Buffer.byteLength(failureBundle, "utf8");
	if (
		failureBundleHash !== builderRun.request.failureBundleSha256 ||
		failureBundleBytes !== builderRun.request.failureBundleBytes ||
		Buffer.byteLength(readFileSync(builderInputPath)) !== builderRun.request.builderInputBytes
	) throw new Error("typed Builder input no longer matches its recorded evidence bytes");
	if (
		builderRun.result.proposal === null ||
		JSON.stringify(builderRun.result.proposal) !== JSON.stringify(proposal) ||
		proposal.decision !== "propose"
	) throw new Error("Builder proposal artifact no longer matches the completed Builder result");
	if (origin.source === null) {
		if (builderRun.request.source !== null || builderRun.request.sourceAttestation !== null) {
			throw new Error("Builder run unexpectedly claims source evidence absent from CandidateRecord");
		}
	} else {
		const attestation = builderRun.request.sourceAttestation;
		if (
			!builderRun.request.source ||
			!attestation ||
			builderRun.request.source.evalRunId !== origin.source.evalRunId ||
			builderRun.request.source.diagnosisId !== origin.source.diagnosisId ||
			attestation.evalRunId !== origin.source.evalRunId ||
			attestation.diagnosisId !== origin.source.diagnosisId ||
			attestation.evalRunSha256 !== origin.source.evalRun.sha256 ||
			attestation.diagnosisSha256 !== origin.source.diagnosis.sha256 ||
			attestation.dataset !== origin.source.dataset ||
			attestation.datasetHash !== origin.source.datasetHash ||
			attestation.suiteHash !== origin.source.suiteHash ||
			canonicalJson(attestation.developmentCorpus) !== canonicalJson(origin.source.developmentCorpus)
		) throw new Error("Builder run source evidence is misattributed");
	}
	if (
		proposal.baseTargetSha !== origin.application.baseTargetSha ||
		receipt.runId !== origin.builderRunId ||
		receipt.proposalSha256 !== origin.proposal.sha256 ||
		receipt.baseTargetSha !== origin.application.baseTargetSha ||
		receipt.candidateSha !== origin.application.candidateSha ||
		receipt.actor.id !== origin.application.actor.id ||
		// A candidate cannot quietly lose the fact that a loop applied it, nor
		// gain the claim that a human read the diff.
		receipt.via !== origin.application.via ||
		receipt.reason !== origin.application.reason ||
		receipt.appliedAt !== origin.application.appliedAt ||
		JSON.stringify([...receipt.paths].sort()) !== JSON.stringify(proposal.changes.map((change) => change.path).sort())
	) throw new Error("Builder apply receipt no longer matches CandidateRecord provenance");
	const validated = record.events.find((event) => event.type === "validated");
	if (
		!validated ||
		validated.type !== "validated" ||
		JSON.stringify([...validated.scope.changedFiles].sort()) !== JSON.stringify([...receipt.paths].sort())
	) throw new Error("validated candidate diff no longer matches the exact Builder apply receipt paths");
	if (origin.source && sourceEval && diagnosis) {
		const attestation = builderRun.request.sourceAttestation;
		if (!attestation) throw new Error("Builder source attestation disappeared before promotion");
		if (
			sourceEval.evalRunId !== origin.source.evalRunId ||
			sourceEval.target.id !== record.targetId ||
			sourceEval.target.gitSha !== origin.application.baseTargetSha ||
			sourceEval.dataset !== origin.source.dataset ||
			sourceEval.datasetHash !== origin.source.datasetHash ||
			sourceEval.suiteHash !== origin.source.suiteHash ||
			attestation.targetId !== sourceEval.target.id ||
			attestation.targetGitSha !== sourceEval.target.gitSha
		) throw new Error("Builder source eval is misattributed to another target or revision");
		if (
			diagnosis.diagnosisId !== origin.source.diagnosisId ||
			diagnosis.evalRunId !== origin.source.evalRunId ||
			diagnosis.targetId !== record.targetId ||
			diagnosis.targetRevision !== origin.application.baseTargetSha
		) throw new Error("Builder diagnosis is misattributed to another eval or target");
	}
	if (
		spec.id !== origin.approvedSpec.specId ||
		spec.projectId !== origin.approvedSpec.projectId ||
		spec.status !== "approved" ||
		hashValue(spec.spec) !== origin.approvedSpec.specContentHash ||
		hashValue(spec) !== origin.approvedSpec.snapshotHash
	) throw new Error("approved Spec identity or status no longer matches CandidateRecord provenance");
	if (experimentDesign) {
		if (!origin.source || !sourceEval || !origin.source.developmentCorpus) {
			throw new Error("blind improvement design requires exact Builder authoring evidence");
		}
		if (
			experimentDesign.projectId !== origin.approvedSpec.projectId ||
			experimentDesign.authoringCorpus.id !== origin.source.developmentCorpus.id ||
			experimentDesign.authoringCorpus.hash !== origin.source.developmentCorpus.hash ||
			JSON.stringify(experimentDesign.authoringTaskIds) !== JSON.stringify(sourceEval.taskIds ?? [])
		) {
			throw new Error("blind improvement design no longer matches the exact Builder authoring evidence");
		}
	}
	return { sourceEval, experimentDesign };
}

/** Re-read referenced eval/run artifacts before any promotion side effect. */
/**
 * A cheap-check screen is a one-repetition, candidate-only run of the cases
 * that already failed. It exists to save money, never to prove anything, so it
 * can never reach a promotion — not as an arm, not as a source eval.
 */
function assertNoScreenEvidence(record: CandidateRecord, runsRoot: string): void {
	const exclusion = screenExclusion(runsRoot);
	const cited = new Set<string>();
	const evaluated = record.events.find((event) => event.type === "evaluated");
	if (evaluated?.type === "evaluated") {
		const { development, sealedHoldout } = evaluated.evaluation;
		cited.add(development.baseline.evalRunId);
		cited.add(development.candidate.evalRunId);
		if (sealedHoldout) {
			cited.add(sealedHoldout.baseline.evalRunId);
			cited.add(sealedHoldout.candidate.evalRunId);
		}
	}
	if (record.origin.kind === "applied-builder" && record.origin.source) {
		cited.add(record.origin.source.evalRunId);
	}
	// The EvalRun's own `purpose` is the first answer, so a screen whose sidecar
	// never got written is still refused. The sidecar is the second, and an
	// unreadable one refuses everything it might name.
	const offending = [...cited].filter((evalRunId) => {
		if (exclusion.blocksEverything || exclusion.ids.has(evalRunId)) return true;
		try {
			return readEvalRunIndex(runsRoot, evalRunId).purpose !== "evidence";
		} catch {
			return false;
		}
	}).sort();
	if (offending.length > 0) {
		throw new Error(
			`promotion refused: ${offending.join(", ")} includes a cheap-check screen, which is never promotion evidence, ` +
			"or an ambiguous legacy one-arm run, which must be rerun" +
			(exclusion.unreadable.length > 0
				? ` (${exclusion.unreadable.length} screen marker(s) could not be read, so nothing they might name is admitted)`
				: ""),
		);
	}
}

function verifyPromotionEvidence(record: CandidateRecord, runsRoot: string, stateRoot?: string): void {
	assertNoScreenEvidence(record, runsRoot);
	const { sourceEval, experimentDesign } = verifyAppliedBuilderOrigin(record, runsRoot, stateRoot);
	const evaluated = record.events.find((event) => event.type === "evaluated");
	if (!evaluated || evaluated.type !== "evaluated") throw new Error("candidate has no evaluated evidence");
	const development = verifyEvaluationPair(runsRoot, record, evaluated.evaluation.development, "development", "development");
	if (!experimentDesign && sourceEval && (
		development.a.dataset !== sourceEval.dataset ||
		development.b.dataset !== sourceEval.dataset ||
		development.a.datasetHash !== sourceEval.datasetHash ||
		development.b.datasetHash !== sourceEval.datasetHash ||
		development.a.suiteHash !== sourceEval.suiteHash ||
		development.b.suiteHash !== sourceEval.suiteHash
	)) {
		throw new Error(
			"development eval artifacts do not match the exact Builder source surface " +
				`${sourceEval.dataset}/${sourceEval.datasetHash}/${sourceEval.suiteHash}`,
		);
	}
	const developmentCorpus = evaluated.evaluation.development.corpus ?? null;
	const expectedDevelopmentCorpus = experimentDesign
		? { id: experimentDesign.validationCorpus.id, hash: experimentDesign.validationCorpus.hash }
		: record.origin.kind === "applied-builder" && record.origin.source
			? record.origin.source.developmentCorpus
			: null;
	if (
		record.origin.kind === "applied-builder" &&
		record.origin.source &&
		canonicalJson(developmentCorpus) !== canonicalJson(expectedDevelopmentCorpus)
	) {
		throw new Error(
			experimentDesign
				? "development corpus identity no longer matches the blind validation design"
				: "development corpus identity no longer matches the canonical Builder source attestation",
		);
	}
	if (experimentDesign) {
		for (const run of [development.a, development.b]) {
			if (JSON.stringify(run.taskIds ?? []) !== JSON.stringify(experimentDesign.validationTaskIds)) {
				throw new Error("development eval task ids no longer match the blind validation design");
			}
		}
	}
	if (developmentCorpus) {
		const expectedDataset = corpusDatasetLabel("development", developmentCorpus.id);
		if (
			development.a.dataset !== expectedDataset ||
			development.b.dataset !== expectedDataset ||
			development.a.datasetHash !== developmentCorpus.hash ||
			development.b.datasetHash !== developmentCorpus.hash
		) {
			throw new Error(
				`development eval artifacts do not match corpus ${developmentCorpus.id}/${developmentCorpus.hash}`,
			);
		}
	} else if (/^development-corpus-[0-9a-f]{64}$/.test(development.a.dataset)) {
		throw new Error("development corpus-backed eval evidence is missing exact corpus identity");
	}
	const developmentEvidence = evaluated.evaluation.development.comparison;
	if (!developmentEvidence) throw new Error("development comparison evidence is not reconstructable");
	if (!isPromotionGradeGateEvidence(developmentEvidence)) {
		throw new Error(legacyEvidenceMessage("development", developmentEvidence));
	}
	const expectedDevelopment = comparisonGateEvidence(
		development,
		developmentCorpus
			? { corpusId: developmentCorpus.id, corpusHash: developmentCorpus.hash }
			: {},
	);
	if (JSON.stringify(developmentEvidence) !== JSON.stringify(expectedDevelopment)) {
		throw new Error("development comparison/gate evidence hash or summary mismatch");
	}
	const holdout = evaluated.evaluation.sealedHoldout;
	if (!holdout) throw new Error("promotion requires sealed-holdout evidence");
	if (!holdout.corpus) throw new Error("sealed holdout is missing exact corpus identity");
	const comparison = verifyEvaluationPair(runsRoot, record, holdout, "sealed holdout", "sealed");
	if (
		comparison.a.datasetHash !== holdout.corpus.hash ||
		comparison.b.datasetHash !== holdout.corpus.hash ||
		comparison.a.dataset !== corpusDatasetLabel("sealed", holdout.corpus.id) ||
		comparison.b.dataset !== corpusDatasetLabel("sealed", holdout.corpus.id)
	) {
		throw new Error(
			`sealed eval artifacts do not match corpus ${holdout.corpus.id}/${holdout.corpus.hash}: ` +
			`${comparison.a.dataset}/${comparison.a.datasetHash} vs ${comparison.b.dataset}/${comparison.b.datasetHash}`,
		);
	}
	const holdoutEvidence = holdout.comparison;
	if (!holdoutEvidence) throw new Error("sealed comparison evidence is not reconstructable");
	if (!isPromotionGradeGateEvidence(holdoutEvidence)) {
		throw new Error(legacyEvidenceMessage("sealed", holdoutEvidence));
	}
	const expectedHoldout = comparisonGateEvidence(comparison, {
		corpusId: holdout.corpus.id,
		corpusHash: holdout.corpus.hash,
	});
	if (JSON.stringify(holdoutEvidence) !== JSON.stringify(expectedHoldout)) {
		throw new Error("sealed comparison/gate evidence hash or summary mismatch");
	}
	if (!promotableVerdicts(developmentEvidence.verdict, holdoutEvidence.verdict)) {
		throw new Error(
			`promotion refused by the comparison gate: development ${developmentEvidence.verdict}, sealed ${holdoutEvidence.verdict}`,
		);
	}
}

/** Every eval run this promotion rests on, development and sealed alike. */
function promotionEvalRunIds(record: CandidateRecord): string[] {
	const evaluated = record.events.find((event) => event.type === "evaluated");
	if (evaluated?.type !== "evaluated") return [];
	const holdout = evaluated.evaluation.sealedHoldout;
	return [
		evaluated.evaluation.development.candidate.evalRunId,
		...(holdout ? [holdout.candidate.evalRunId] : []),
	];
}

/**
 * A judge nobody has checked is an opinion, and `requireCalibration` is a
 * project saying it will not promote on one. The policy reads only grader spec
 * hashes — never sealed content — and it refuses rather than guesses when the
 * labels it would need cannot be reached at all.
 */
function assertJudgeCalibrated(
	policy: JudgeCalibrationPolicy | undefined,
	record: CandidateRecord,
	options: { runsRoot: string; stateRoot?: string },
): void {
	if (!policy) return;
	if (!options.stateRoot) {
		throw new Error(
			"promotion refused: evalSuite.judge.requireCalibration is set but this promotion has no label store to check it against",
		);
	}
	const approvedSpec = record.origin.kind === "applied-builder"
		? {
			projectId: record.origin.approvedSpec.projectId,
			specId: record.origin.approvedSpec.specId,
			specContentHash: record.origin.approvedSpec.specContentHash,
			snapshotHash: record.origin.approvedSpec.snapshotHash,
		}
		: record.specId
			? loadApprovedSpec({ stateRoot: options.stateRoot, projectId: record.projectId, specId: record.specId }).reference
			: undefined;
	const calibration = judgeEvidenceCalibration({
		runsRoot: options.runsRoot,
		stateRoot: options.stateRoot,
		projectId: record.projectId,
		evalRunIds: promotionEvalRunIds(record),
		// A human who was shown the first user turn and the last assistant reply
		// graded a different object from the judge, who was shown the rubric, the
		// assertions, the reference answer and — on a conversation — every turn.
		// Those labels stay on disk and stay readable; they just do not certify
		// this judge unless the Target says in writing that they may.
		includeLegacyLabels: policy.allowLegacyLabels === true,
		requireBoundLineage: true,
		...(approvedSpec ? { approvedSpec } : {}),
	});
	const refusal = judgeCalibrationRefusal(policy, {
		judgeGraderSpecs: Math.max(calibration.specHashes.length, calibration.instruments.length),
		stats: calibration.stats,
		byGraderSpec: calibration.instruments.map((instrument) => ({
			graderSpecHash: instrument.graderSpecHash,
			judgeFingerprintHash: instrument.judgeFingerprintHash,
			stats: instrument.stats,
		})),
	});
	if (refusal) {
		const legacy = policy.allowLegacyLabels !== true && calibration.legacyLabels > 0
			? ` ${calibration.legacyLabels} older label(s) were not counted: they were written before the labelling screen ` +
				"showed the judge's own subject. Re-label them, or set evalSuite.judge.requireCalibration.allowLegacyLabels: true."
			: "";
		const unbound = calibration.unboundLabels > 0
			? ` ${calibration.unboundLabels} label(s) were not counted because they lack an exact approved-Spec/eval-lineage receipt.`
			: "";
		const mismatched = calibration.lineageMismatchLabels > 0
			? ` ${calibration.lineageMismatchLabels} label(s) belong to another approved Spec or eval lineage.`
			: "";
		const repeats = calibration.stats?.duplicateLabels
			? ` ${calibration.stats.duplicateLabels} repeated label(s) were ignored.`
			: "";
		const conflicts = calibration.stats?.conflictedSubjects
			? ` ${calibration.stats.conflictedSubjects} conflicting subject(s) were excluded fail-closed.`
			: "";
		throw new Error(
			`promotion refused: ${refusal}.${legacy}${unbound}${mismatched}${repeats}${conflicts} ` +
				"Grade the judge before promoting: /label in Builder Pi, or `ahde label <evalRunId> --target <dir>` outside it.",
		);
	}
}

/**
 * Create an annotated Git tag for the exact reviewed candidate and append the
 * canonical promotion event. The aggregate is validated before Git is touched;
 * if durable publication fails, only the tag created by this call is removed.
 */
export function promoteReviewedCandidate(
	options: PromoteReviewedCandidateOptions,
	dependencies: Partial<PromoteReviewedCandidateDependencies> = {},
): PromoteReviewedCandidateResult {
	const deps = { ...DEFAULT_PROMOTION_DEPENDENCIES, ...dependencies };
	if (!/^\d+\.\d+\.\d+$/.test(options.version)) {
		throw new Error(`invalid semver: ${options.version}`);
	}
	if (!options.reason.trim()) throw new Error("promotion reason must not be blank");
	const repositoryDir = resolve(options.repositoryDir);
	const tag = `v${options.version}`;
	const intentPath = promotionIntentPath(options.runsRoot, options.candidateId);
	const claimPath = transitionClaimPath(options.runsRoot, options.candidateId);
	// Load both journals before inspecting lifecycle status: after a process dies,
	// candidate.json may already contain the terminal event while cleanup remains.
	const existingIntent = existsSync(intentPath)
		? readJsonArtifact(intentPath, PromotionIntentSchema)
		: null;
	const existingClaim = readTransitionClaim(claimPath);
	if (existingClaim && (existingClaim.operation !== "promote" || existingClaim.channel !== "git-tag")) {
		throw new Error(
			`candidate ${options.candidateId} already has a ${existingClaim.operation} transition in progress`,
		);
	}
	const initiallyLoaded = loadCandidateRecord(options.runsRoot, options.candidateId);
	let record: CandidateRecord;
	let at: string;
	if (existingIntent) {
		record = candidateBeforePromotion(existingIntent.promoted, existingIntent.candidateBeforeSha256);
		at = existingIntent.at;
	} else if (existingClaim) {
		record = candidateBeforePromotion(existingClaim.after, existingClaim.candidateBeforeSha256);
		const promotion = existingClaim.after.events.at(-1);
		if (promotion?.type !== "promoted") throw new Error("promotion claim has no promotion event");
		at = promotion.at;
	} else {
		record = initiallyLoaded;
		at = (options.now ?? (() => new Date().toISOString()))();
	}
	if (
		options.expectedCandidateHash !== undefined &&
		options.expectedCandidateHash !== hashValue(record)
	) throw new Error("candidate changed after confirmation; promotion is stale");
	if (candidateStatus(record) !== "reviewed") {
		throw new Error(`candidate ${record.candidateId} must be reviewed before promotion`);
	}
	const candidate = builtRevision(record);
	const resolvedCommit = git(repositoryDir, ["rev-parse", "--verify", `${candidate.sha}^{commit}`]);
	if (resolvedCommit !== candidate.sha) {
		throw new Error(`candidate commit mismatch: expected ${candidate.sha}, resolved ${resolvedCommit}`);
	}
	const manifestResult = TargetManifest.safeParse(
		parseYaml(git(repositoryDir, ["show", `${candidate.sha}:manifest.yaml`])),
	);
	if (!manifestResult.success) {
		throw new Error(`candidate manifest.yaml is invalid: ${manifestResult.error.message}`);
	}
	if (manifestResult.data.id !== record.targetId) {
		throw new Error(
			`candidate target mismatch: record=${record.targetId}, commit=${manifestResult.data.id}`,
		);
	}
	verifyPromotionEvidence(record, options.runsRoot, options.stateRoot);
	assertJudgeCalibrated(manifestResult.data.evalSuite.judge?.requireCalibration, record, {
		runsRoot: options.runsRoot,
		...(options.stateRoot ? { stateRoot: options.stateRoot } : {}),
	});

	const actorId = options.actorId ?? "local-user";
	const promoted = CandidateRecordSchema.parse(
		previewPromotion(record, { tag, reason: options.reason, actorId, at }),
	);
	const message = JSON.stringify({
		candidateId: record.candidateId,
		targetId: record.targetId,
		candidateSha: candidate.sha,
		reason: options.reason,
	});
	const intent = PromotionIntentSchema.parse({
		schemaVersion: existingIntent?.schemaVersion ?? 2,
		candidateBeforeSha256: hashValue(record),
		tag,
		candidateSha: candidate.sha,
		at,
		actorId,
		reason: options.reason,
		tagMessage: message,
		...(existingIntent?.schemaVersion === 1
			? {}
			: { taggerName: PROMOTION_TAGGER_NAME, taggerEmail: PROMOTION_TAGGER_EMAIL }),
		promoted,
	});
	if (existingIntent) {
		if (canonicalJson(existingIntent) !== canonicalJson(intent)) {
			throw new Error("promotion retry does not match its durable pre-tag intent");
		}
	}
	const claim = transitionClaim("promote", "git-tag", record, promoted, hashValue(intent));
	acquireTransitionClaim(claimPath, claim, deps.writeClaim);

	// The immutable claim closes the stale-reader race. Re-read before the first
	// external effect; if a reject won and completed while this process still held
	// a reviewed snapshot, release our effect-free claim and fail closed.
	const currentAfterClaim = loadCandidateRecord(options.runsRoot, options.candidateId);
	const currentAfterClaimHash = hashValue(currentAfterClaim);
	if (
		currentAfterClaimHash !== claim.candidateBeforeSha256 &&
		currentAfterClaimHash !== claim.candidateAfterSha256
	) {
		if (!existingIntent) removeExactTransitionClaim(claimPath, claim);
		throw new Error("candidate changed while claiming promotion; refusing to create a tag");
	}

	const existingTag = tagExists(repositoryDir, tag);
	if (existingTag && !existingIntent) {
		removeExactTransitionClaim(claimPath, claim);
		throw new Error(`tag ${tag} already exists`);
	}
	if (!existingIntent) deps.writeIntent(intentPath, intent);
	const publishedIntent = readJsonArtifact(intentPath, PromotionIntentSchema);
	if (canonicalJson(publishedIntent) !== canonicalJson(intent)) {
		throw new Error("promotion intent changed during publication");
	}

	let createdTagThisCall = false;
	try {
		if (existingTag) {
			verifyExactPromotionTag(repositoryDir, intent);
		} else {
			createExactPromotionTag(repositoryDir, intent);
			createdTagThisCall = true;
		}
		const current = loadCandidateRecord(options.runsRoot, options.candidateId);
		const currentHash = hashValue(current);
		const persisted = currentHash === claim.candidateAfterSha256
			? promoted
			: persistIfUnchanged(promoted, options.runsRoot, claim.candidateBeforeSha256, "promoting");
		const result = { record: persisted, tag, candidateSha: candidate.sha };
		// Once both stores agree, either cleanup order is recoverable. Removing the
		// mutex first leaves the promotion intent as a conservative rejection block.
		removeExactTransitionClaim(claimPath, claim);
		removeExactPromotionIntent(intentPath, intent);
		return result;
	} catch (error) {
		const current = loadCandidateRecord(options.runsRoot, options.candidateId);
		if (hashValue(current) === claim.candidateAfterSha256) {
			// Publication won even if a later cleanup step failed. Leave any remaining
			// journal for an exact retry to finish instead of undoing a valid release.
			throw error;
		}
		if (createdTagThisCall && rollbackExactPromotionTag(repositoryDir, intent)) {
			removeExactPromotionIntent(intentPath, intent);
			removeExactTransitionClaim(claimPath, claim);
		}
		throw error;
	}
}
