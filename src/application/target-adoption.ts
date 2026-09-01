import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { candidateStatus, type CandidateRecord } from "../domain/candidate.js";
import { canonicalJson, hashValue } from "../provenance.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import { safeArtifactSegment } from "../storage/paths.js";
import { loadCandidateRecord } from "./candidate-review.js";
import { namedDirtyPaths, operatorDirtyPaths } from "./store-hygiene.js";

const GitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "expected a full Git SHA");
const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected a sha256 fingerprint");
const TimestampSchema = z.iso.datetime({ offset: true });
const NonBlankSchema = z.string().min(1).refine((value) => value.trim().length > 0, "expected non-blank text");
const ActorSchema = z.strictObject({ kind: z.literal("human"), id: NonBlankSchema.max(256) });
const ReasonSchema = NonBlankSchema.max(4_000);
const BranchRefSchema = z.string().min(12).max(1_024).startsWith("refs/heads/");
const TagRefSchema = z.string().min(11).max(1_024).startsWith("refs/tags/");

const ADOPTIONS_DIRECTORY = "target-adoptions";
const INTENT_FILENAME = "intent.json";
const RECEIPT_FILENAME = "receipt.json";
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ADOPTION_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_ADOPTION_SUBJECT_BYTES = 1024 * 1024;

export type TargetAdoptionErrorCode =
	| "TARGET_ADOPTION_INVALID_REPOSITORY"
	| "TARGET_ADOPTION_DIRTY"
	| "TARGET_ADOPTION_STALE"
	| "TARGET_ADOPTION_INVALID_CANDIDATE"
	| "TARGET_ADOPTION_INVALID_TAG"
	| "TARGET_ADOPTION_NON_FAST_FORWARD"
	| "TARGET_ADOPTION_INTENT_MISMATCH"
	| "TARGET_ADOPTION_AMBIGUOUS_RECOVERY"
	| "TARGET_ADOPTION_ARTIFACT_INVALID";

/** A bounded host-facing failure. Subprocess and filesystem details remain in `cause`. */
export class TargetAdoptionError extends Error {
	readonly code: TargetAdoptionErrorCode;

	constructor(code: TargetAdoptionErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "TargetAdoptionError";
		this.code = code;
	}
}

export const TargetAdoptionSubjectSchema = z.strictObject({
	schemaVersion: z.literal(1),
	algorithmId: z.literal("promoted-candidate-fast-forward-v1"),
	candidate: z.strictObject({
		candidateId: NonBlankSchema.max(200),
		targetId: NonBlankSchema.max(200),
		candidateRecordHash: HashSchema,
		baseline: z.strictObject({ ref: NonBlankSchema.max(1_024), sha: GitShaSchema }),
		revision: z.strictObject({ ref: NonBlankSchema.max(1_024), sha: GitShaSchema }),
		changedFiles: z.array(NonBlankSchema.max(4_096)).min(1).max(10_000),
	}),
	branch: z.strictObject({
		name: NonBlankSchema.max(1_012),
		ref: BranchRefSchema,
	}),
	promotion: z.strictObject({
		tag: NonBlankSchema.max(1_013),
		tagRef: TagRefSchema,
		tagObjectSha: GitShaSchema,
		promotedAt: TimestampSchema,
		actorId: NonBlankSchema.max(200),
		reason: ReasonSchema,
	}),
	subjectHash: HashSchema,
}).superRefine((subject, context) => {
	if (subject.candidate.baseline.sha === subject.candidate.revision.sha) {
		context.addIssue({ code: "custom", path: ["candidate", "revision", "sha"], message: "must differ from baseline" });
	}
	if (subject.branch.ref !== `refs/heads/${subject.branch.name}`) {
		context.addIssue({ code: "custom", path: ["branch", "ref"], message: "must match the named local branch" });
	}
	if (subject.promotion.tagRef !== `refs/tags/${subject.promotion.tag}`) {
		context.addIssue({ code: "custom", path: ["promotion", "tagRef"], message: "must match the promoted tag" });
	}
	if (new Set(subject.candidate.changedFiles).size !== subject.candidate.changedFiles.length) {
		context.addIssue({ code: "custom", path: ["candidate", "changedFiles"], message: "must be unique" });
	}
	const { subjectHash: _subjectHash, ...identity } = subject;
	if (Buffer.byteLength(canonicalJson(identity), "utf8") > MAX_ADOPTION_SUBJECT_BYTES) {
		context.addIssue({ code: "custom", path: [], message: "exact adoption subject exceeds its durable evidence limit" });
	}
	if (subject.subjectHash !== hashValue(identity)) {
		context.addIssue({ code: "custom", path: ["subjectHash"], message: "does not match the exact adoption subject" });
	}
});
export type TargetAdoptionSubject = z.infer<typeof TargetAdoptionSubjectSchema>;

export const TargetAdoptionIntentSchema = z.strictObject({
	schemaVersion: z.literal(1),
	algorithmId: z.literal("target-adoption-intent-v1"),
	intentId: z.string().regex(/^target-adoption-intent-[0-9a-f]{64}$/),
	subject: TargetAdoptionSubjectSchema,
	actor: ActorSchema,
	reason: ReasonSchema,
	initiatedAt: TimestampSchema,
}).superRefine((intent, context) => {
	const { intentId: _intentId, ...identity } = intent;
	const expected = `target-adoption-intent-${hashValue(identity).slice("sha256:".length)}`;
	if (intent.intentId !== expected) {
		context.addIssue({ code: "custom", path: ["intentId"], message: "does not match the exact adoption intent" });
	}
});
export type TargetAdoptionIntent = z.infer<typeof TargetAdoptionIntentSchema>;

export const TargetAdoptionReceiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	algorithmId: z.literal("target-adoption-receipt-v1"),
	receiptId: z.string().regex(/^target-adoption-receipt-[0-9a-f]{64}$/),
	intent: TargetAdoptionIntentSchema,
	previousHead: GitShaSchema,
	adoptedHead: GitShaSchema,
	branchRef: BranchRefSchema,
	adoptedAt: TimestampSchema,
}).superRefine((receipt, context) => {
	if (receipt.previousHead !== receipt.intent.subject.candidate.baseline.sha) {
		context.addIssue({ code: "custom", path: ["previousHead"], message: "must match the confirmed baseline" });
	}
	if (receipt.adoptedHead !== receipt.intent.subject.candidate.revision.sha) {
		context.addIssue({ code: "custom", path: ["adoptedHead"], message: "must match the confirmed candidate" });
	}
	if (receipt.branchRef !== receipt.intent.subject.branch.ref) {
		context.addIssue({ code: "custom", path: ["branchRef"], message: "must match the confirmed local branch" });
	}
	const { receiptId: _receiptId, ...identity } = receipt;
	const expected = `target-adoption-receipt-${hashValue(identity).slice("sha256:".length)}`;
	if (receipt.receiptId !== expected) {
		context.addIssue({ code: "custom", path: ["receiptId"], message: "does not match the exact adoption receipt" });
	}
});
export type TargetAdoptionReceipt = z.infer<typeof TargetAdoptionReceiptSchema>;

export interface DescribeTargetAdoptionOptions {
	repositoryDir: string;
	runsRoot: string;
	candidateId: string;
}

export interface AdoptTargetCandidateOptions extends DescribeTargetAdoptionOptions {
	stateRoot: string;
	expectedSubjectHash: string;
	actor: { kind: "human"; id: string };
	reason: string;
}

export interface TargetAdoptionResult {
	disposition: "adopted" | "recovered" | "already-adopted";
	subject: TargetAdoptionSubject;
	intent: TargetAdoptionIntent;
	receipt: TargetAdoptionReceipt;
	receiptPath: string;
}

export interface TargetAdoptionDependencies {
	now: () => string;
	fastForward: (repositoryDir: string, candidateSha: string) => void;
	writeIntent: (path: string, intent: TargetAdoptionIntent) => void;
	writeReceipt: (path: string, receipt: TargetAdoptionReceipt) => void;
}

function fail(code: TargetAdoptionErrorCode, message: string, cause?: unknown): never {
	throw new TargetAdoptionError(code, message, cause);
}

function gitEnvironment(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_MERGE_AUTOEDIT: "no",
	};
}

function gitRaw(repositoryDir: string, args: string[]): Buffer {
	try {
		return execFileSync("git", ["--no-replace-objects", "-C", repositoryDir, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: MAX_GIT_OUTPUT_BYTES,
			env: gitEnvironment(),
		});
	} catch (error) {
		return fail("TARGET_ADOPTION_INVALID_REPOSITORY", "Target Git state could not be verified.", error);
	}
}

function gitText(repositoryDir: string, args: string[]): string {
	return gitRaw(repositoryDir, args).toString("utf8").trim();
}

function gitExitStatus(repositoryDir: string, args: string[]): number {
	const result = spawnSync("git", ["--no-replace-objects", "-C", repositoryDir, ...args], {
		stdio: "ignore",
		env: gitEnvironment(),
	});
	if (result.error || result.status === null) {
		return fail("TARGET_ADOPTION_INVALID_REPOSITORY", "Target Git state could not be verified.", result.error);
	}
	return result.status;
}

function repositoryRoot(input: string): string {
	try {
		const requested = resolve(input);
		const entry = lstatSync(requested);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			return fail("TARGET_ADOPTION_INVALID_REPOSITORY", "Target must be a regular non-symlink Git worktree root.");
		}
		const canonical = realpathSync(requested);
		const top = realpathSync(gitText(canonical, ["rev-parse", "--show-toplevel"]));
		if (canonical !== top) {
			return fail("TARGET_ADOPTION_INVALID_REPOSITORY", "Target must be the Git worktree root.");
		}
		return canonical;
	} catch (error) {
		if (error instanceof TargetAdoptionError) throw error;
		return fail("TARGET_ADOPTION_INVALID_REPOSITORY", "Target must be a regular non-symlink Git worktree root.", error);
	}
}

function assertClean(repositoryDir: string): void {
	// The host's own `.ahde/` and `runs/` sit inside the Target; only the
	// operator's files can stand between them and their released version.
	const dirty = operatorDirtyPaths(
		gitRaw(repositoryDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).toString("utf8"),
	);
	if (dirty.length > 0) {
		fail(
			"TARGET_ADOPTION_DIRTY",
			`Target adoption requires a clean worktree and index; commit ${namedDirtyPaths(dirty)}.`,
		);
	}
}

interface BranchIdentity {
	name: string;
	ref: string;
	head: string;
}

function currentBranch(repositoryDir: string): BranchIdentity {
	let ref: string;
	try {
		ref = gitText(repositoryDir, ["symbolic-ref", "-q", "HEAD"]);
	} catch (error) {
		return fail("TARGET_ADOPTION_STALE", "Target adoption requires a named local branch, not detached HEAD.", error);
	}
	if (!ref.startsWith("refs/heads/") || gitExitStatus(repositoryDir, ["check-ref-format", ref]) !== 0) {
		fail("TARGET_ADOPTION_STALE", "Target adoption requires a valid named local branch.");
	}
	const name = ref.slice("refs/heads/".length);
	const head = GitShaSchema.parse(gitText(repositoryDir, ["rev-parse", "--verify", "HEAD^{commit}"]));
	return { name, ref, head };
}

function exactCommit(repositoryDir: string, sha: string, label: string): string {
	const expected = GitShaSchema.parse(sha);
	let actual: string;
	try {
		actual = GitShaSchema.parse(gitText(repositoryDir, ["rev-parse", "--verify", `${expected}^{commit}`]));
	} catch (error) {
		return fail("TARGET_ADOPTION_INVALID_CANDIDATE", `${label} is not an exact local commit.`, error);
	}
	if (actual !== expected) {
		fail("TARGET_ADOPTION_INVALID_CANDIDATE", `${label} resolves to a different commit.`);
	}
	return actual;
}

function assertFastForward(repositoryDir: string, baselineSha: string, candidateSha: string): void {
	if (baselineSha === candidateSha) {
		fail("TARGET_ADOPTION_NON_FAST_FORWARD", "Candidate must differ from its baseline.");
	}
	const status = gitExitStatus(repositoryDir, ["merge-base", "--is-ancestor", baselineSha, candidateSha]);
	if (status === 1) {
		fail("TARGET_ADOPTION_NON_FAST_FORWARD", "Candidate is not a fast-forward descendant of its baseline.");
	}
	if (status !== 0) {
		fail("TARGET_ADOPTION_INVALID_CANDIDATE", "Candidate lineage could not be verified.");
	}
}

function promotedEvidence(record: CandidateRecord): {
	baseline: CandidateRecord["baseline"];
	candidate: { ref: string; sha: string };
	changedFiles: string[];
	promotion: { tag: string; at: string; actorId: string; reason: string };
} {
	if (candidateStatus(record) !== "promoted") {
		fail("TARGET_ADOPTION_INVALID_CANDIDATE", `Candidate ${record.candidateId} is not promoted.`);
	}
	const built = record.events.find((event) => event.type === "built");
	const validated = record.events.find((event) => event.type === "validated");
	const evaluated = record.events.find((event) => event.type === "evaluated");
	const promoted = record.events.find((event) => event.type === "promoted");
	if (!built || built.type !== "built" || !validated || validated.type !== "validated" ||
		!evaluated || evaluated.type !== "evaluated" || !promoted || promoted.type !== "promoted") {
		fail("TARGET_ADOPTION_INVALID_CANDIDATE", "Promoted CandidateRecord is missing exact lifecycle evidence.");
	}
	const candidateSha = built.candidate.sha;
	const evaluatedShas = [
		evaluated.evaluation.development.candidate.harness.sha,
		...(evaluated.evaluation.sealedHoldout
			? [evaluated.evaluation.sealedHoldout.candidate.harness.sha]
			: []),
	];
	if (
		promoted.decision.candidate.sha !== candidateSha ||
		validated.lineage.candidate.sha !== candidateSha ||
		validated.scope.candidateSha !== candidateSha ||
		evaluatedShas.some((sha) => sha !== candidateSha)
	) {
		fail("TARGET_ADOPTION_INVALID_CANDIDATE", "Built, validated, evaluated, and promoted revisions do not match exactly.");
	}
	return {
		baseline: record.baseline,
		candidate: built.candidate,
		changedFiles: [...validated.scope.changedFiles],
		promotion: {
			tag: promoted.decision.tag,
			at: promoted.at,
			actorId: promoted.actor.id,
			reason: promoted.decision.reason,
		},
	};
}

function tagIdentity(
	repositoryDir: string,
	tag: string,
	candidateSha: string,
): { tagRef: string; tagObjectSha: string } {
	const tagRef = `refs/tags/${tag}`;
	if (gitExitStatus(repositoryDir, ["check-ref-format", tagRef]) !== 0) {
		fail("TARGET_ADOPTION_INVALID_TAG", "Promoted CandidateRecord contains an invalid Git tag.");
	}
	let tagObjectSha: string;
	let taggedCommit: string;
	try {
		tagObjectSha = GitShaSchema.parse(gitText(repositoryDir, ["rev-parse", "--verify", tagRef]));
		taggedCommit = GitShaSchema.parse(gitText(repositoryDir, ["rev-parse", "--verify", `${tagRef}^{commit}`]));
	} catch (error) {
		return fail("TARGET_ADOPTION_INVALID_TAG", "The promoted Git tag is missing or invalid.", error);
	}
	if (taggedCommit !== candidateSha) {
		fail("TARGET_ADOPTION_INVALID_TAG", "The promoted Git tag does not point at the exact evaluated candidate.");
	}
	return { tagRef, tagObjectSha };
}

function buildSubject(
	repositoryDir: string,
	runsRoot: string,
	candidateId: string,
	branch: BranchIdentity,
): TargetAdoptionSubject {
	let record: CandidateRecord;
	try {
		record = loadCandidateRecord(runsRoot, candidateId);
	} catch (error) {
		return fail("TARGET_ADOPTION_INVALID_CANDIDATE", "CandidateRecord could not be loaded exactly.", error);
	}
	if (record.candidateId !== candidateId) {
		fail("TARGET_ADOPTION_INVALID_CANDIDATE", "CandidateRecord identity does not match its requested artifact path.");
	}
	const evidence = promotedEvidence(record);
	const baselineSha = exactCommit(repositoryDir, evidence.baseline.sha, "Candidate baseline");
	const candidateSha = exactCommit(repositoryDir, evidence.candidate.sha, "Promoted candidate");
	assertFastForward(repositoryDir, baselineSha, candidateSha);
	const tag = tagIdentity(repositoryDir, evidence.promotion.tag, candidateSha);
	const identity = {
		schemaVersion: 1 as const,
		algorithmId: "promoted-candidate-fast-forward-v1" as const,
		candidate: {
			candidateId: record.candidateId,
			targetId: record.targetId,
			candidateRecordHash: hashValue(record),
			baseline: { ref: evidence.baseline.ref, sha: baselineSha },
			revision: { ref: evidence.candidate.ref, sha: candidateSha },
			changedFiles: [...evidence.changedFiles].sort(),
		},
		branch: { name: branch.name, ref: branch.ref },
		promotion: {
			tag: evidence.promotion.tag,
			tagRef: tag.tagRef,
			tagObjectSha: tag.tagObjectSha,
			promotedAt: evidence.promotion.at,
			actorId: evidence.promotion.actorId,
			reason: evidence.promotion.reason,
		},
	};
	return TargetAdoptionSubjectSchema.parse({ ...identity, subjectHash: hashValue(identity) });
}

/** Build the exact immutable subject a trusted host must render and confirm. */
export function describeTargetAdoption(options: DescribeTargetAdoptionOptions): TargetAdoptionSubject {
	const repositoryDir = repositoryRoot(options.repositoryDir);
	assertClean(repositoryDir);
	const branch = currentBranch(repositoryDir);
	const subject = buildSubject(repositoryDir, options.runsRoot, options.candidateId, branch);
	if (branch.head !== subject.candidate.baseline.sha) {
		fail("TARGET_ADOPTION_STALE", "Target HEAD must equal the Candidate baseline before adoption.");
	}
	return subject;
}

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function stateRootPath(input: string, create: boolean): string {
	const requested = resolve(input);
	try {
		let created = false;
		if (!existsSync(requested)) {
			if (!create) fail("TARGET_ADOPTION_ARTIFACT_INVALID", "Target adoption state root does not exist.");
			mkdirSync(requested, { recursive: true, mode: 0o700 });
			created = true;
		}
		const entry = lstatSync(requested);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			return fail("TARGET_ADOPTION_ARTIFACT_INVALID", "Target adoption state root must be a regular non-symlink directory.");
		}
		if (create) chmodSync(requested, 0o700);
		if (created) {
			fsyncDirectory(dirname(requested));
			fsyncDirectory(requested);
		}
		return realpathSync(requested);
	} catch (error) {
		if (error instanceof TargetAdoptionError) throw error;
		return fail("TARGET_ADOPTION_ARTIFACT_INVALID", "Target adoption state root could not be secured.", error);
	}
}

function ensurePrivateDirectory(path: string): void {
	try {
		let created = false;
		if (!existsSync(path)) {
			mkdirSync(path, { mode: 0o700 });
			created = true;
		}
		const entry = lstatSync(path);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			return fail("TARGET_ADOPTION_ARTIFACT_INVALID", "Target adoption state must not traverse a symlink.");
		}
		chmodSync(path, 0o700);
		if (created) {
			fsyncDirectory(dirname(path));
			fsyncDirectory(path);
		}
	} catch (error) {
		if (error instanceof TargetAdoptionError) throw error;
		return fail("TARGET_ADOPTION_ARTIFACT_INVALID", "Target adoption state directory could not be secured.", error);
	}
}

interface AdoptionPaths {
	intent: string;
	receipt: string;
}

function adoptionPaths(stateRootInput: string, candidateId: string, create: boolean): AdoptionPaths {
	const stateRoot = stateRootPath(stateRootInput, create);
	const safeCandidateId = safeArtifactSegment(candidateId, "candidate id");
	const adoptions = join(stateRoot, ADOPTIONS_DIRECTORY);
	const candidate = join(adoptions, safeCandidateId);
	if (!contained(stateRoot, candidate)) {
		fail("TARGET_ADOPTION_ARTIFACT_INVALID", "Target adoption state escaped its configured root.");
	}
	if (create) {
		ensurePrivateDirectory(adoptions);
		ensurePrivateDirectory(candidate);
	} else {
		// Reads never repair modes: inventory must not mutate state while looking.
		for (const path of [adoptions, candidate]) {
			if (!existsSync(path)) fail("TARGET_ADOPTION_ARTIFACT_INVALID", "Target adoption state does not exist.");
			const entry = lstatSync(path);
			if (!entry.isDirectory() || entry.isSymbolicLink()) {
				fail("TARGET_ADOPTION_ARTIFACT_INVALID", "Target adoption state must not traverse a symlink.");
			}
			if ((entry.mode & 0o777) !== 0o700) {
				fail("TARGET_ADOPTION_ARTIFACT_INVALID", `Target adoption state must have mode 0700, got 0${(entry.mode & 0o777).toString(8)}.`);
			}
		}
	}
	return { intent: join(candidate, INTENT_FILENAME), receipt: join(candidate, RECEIPT_FILENAME) };
}

function assertStateRootDoesNotDirtyTarget(repositoryDir: string, stateRootInput: string): void {
	const stateRoot = resolve(stateRootInput);
	if (!contained(repositoryDir, stateRoot)) return;
	const relativeState = relative(repositoryDir, stateRoot);
	if (!relativeState || relativeState === ".git" || relativeState.startsWith(`.git${sep}`)) {
		fail("TARGET_ADOPTION_ARTIFACT_INVALID", "Target adoption state must not be the repository root or live inside .git.");
	}
	if (gitExitStatus(repositoryDir, ["check-ignore", "-q", "--no-index", "--", relativeState]) !== 0) {
		fail("TARGET_ADOPTION_ARTIFACT_INVALID", "An in-repository Target adoption state root must be ignored by Git.");
	}
}

function assertPrivateArtifact(path: string): void {
	try {
		const entry = lstatSync(path);
		if (!entry.isFile() || entry.isSymbolicLink()) {
			return fail("TARGET_ADOPTION_ARTIFACT_INVALID", "Target adoption evidence must be a regular non-symlink file.");
		}
		const mode = statSync(path).mode & 0o777;
		if (mode !== 0o600) {
			fail("TARGET_ADOPTION_ARTIFACT_INVALID", `Target adoption evidence must have mode 0600, got 0${mode.toString(8)}.`);
		}
	} catch (error) {
		if (error instanceof TargetAdoptionError) throw error;
		return fail("TARGET_ADOPTION_ARTIFACT_INVALID", "Target adoption evidence could not be verified.", error);
	}
}

function fsyncDirectory(path: string): void {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, constants.O_RDONLY);
		fsyncSync(descriptor);
	} catch (error) {
		return fail("TARGET_ADOPTION_ARTIFACT_INVALID", "Target adoption evidence directory could not be synchronized.", error);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function loadIntent(path: string): TargetAdoptionIntent {
	assertPrivateArtifact(path);
	try {
		return readJsonArtifact(path, TargetAdoptionIntentSchema, { maxBytes: MAX_ADOPTION_ARTIFACT_BYTES });
	} catch (error) {
		return fail("TARGET_ADOPTION_ARTIFACT_INVALID", "Target adoption intent is invalid.", error);
	}
}

function loadReceipt(path: string): TargetAdoptionReceipt {
	assertPrivateArtifact(path);
	try {
		return readJsonArtifact(path, TargetAdoptionReceiptSchema, { maxBytes: MAX_ADOPTION_ARTIFACT_BYTES });
	} catch (error) {
		return fail("TARGET_ADOPTION_ARTIFACT_INVALID", "Target adoption receipt is invalid.", error);
	}
}

function exactMatch(actual: unknown, expected: unknown, message: string): void {
	if (canonicalJson(actual) !== canonicalJson(expected)) {
		fail("TARGET_ADOPTION_INTENT_MISMATCH", message);
	}
}

function makeIntent(
	subject: TargetAdoptionSubject,
	actor: z.infer<typeof ActorSchema>,
	reason: string,
	initiatedAt: string,
): TargetAdoptionIntent {
	const identity = {
		schemaVersion: 1 as const,
		algorithmId: "target-adoption-intent-v1" as const,
		subject,
		actor,
		reason,
		initiatedAt,
	};
	return TargetAdoptionIntentSchema.parse({
		...identity,
		intentId: `target-adoption-intent-${hashValue(identity).slice("sha256:".length)}`,
	});
}

function makeReceipt(intent: TargetAdoptionIntent, adoptedAt: string): TargetAdoptionReceipt {
	const identity = {
		schemaVersion: 1 as const,
		algorithmId: "target-adoption-receipt-v1" as const,
		intent,
		previousHead: intent.subject.candidate.baseline.sha,
		adoptedHead: intent.subject.candidate.revision.sha,
		branchRef: intent.subject.branch.ref,
		adoptedAt,
	};
	return TargetAdoptionReceiptSchema.parse({
		...identity,
		receiptId: `target-adoption-receipt-${hashValue(identity).slice("sha256:".length)}`,
	});
}

function defaultFastForward(repositoryDir: string, candidateSha: string): void {
	try {
		execFileSync("git", [
			"--no-replace-objects",
			"-C", repositoryDir,
			"-c", "core.hooksPath=/dev/null",
			"merge", "--ff-only", "--no-edit", "--no-stat", candidateSha,
		], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: MAX_GIT_OUTPUT_BYTES,
			env: gitEnvironment(),
		});
	} catch (error) {
		return fail("TARGET_ADOPTION_STALE", "The confirmed fast-forward could not be applied.", error);
	}
}

const DEFAULT_DEPENDENCIES: TargetAdoptionDependencies = {
	now: () => new Date().toISOString(),
	fastForward: defaultFastForward,
	writeIntent: (path, intent) => writeJsonArtifact(path, TargetAdoptionIntentSchema, intent, { immutable: true }),
	writeReceipt: (path, receipt) => writeJsonArtifact(path, TargetAdoptionReceiptSchema, receipt, { immutable: true }),
};

function validateRequestAgainstIntent(
	intent: TargetAdoptionIntent,
	subject: TargetAdoptionSubject,
	expectedSubjectHash: string,
	actor: z.infer<typeof ActorSchema>,
	reason: string,
): void {
	if (intent.subject.subjectHash !== expectedSubjectHash) {
		fail("TARGET_ADOPTION_INTENT_MISMATCH", "Pending adoption intent belongs to a different confirmation.");
	}
	exactMatch(intent.subject, subject, "Candidate, tag, or branch changed after the adoption intent was recorded.");
	exactMatch(intent.actor, actor, "Pending adoption intent belongs to a different human actor.");
	if (intent.reason !== reason) {
		fail("TARGET_ADOPTION_INTENT_MISMATCH", "Pending adoption intent has a different human reason.");
	}
}

function assertExactAdoptedState(
	repositoryDir: string,
	subject: TargetAdoptionSubject,
): void {
	assertClean(repositoryDir);
	const branch = currentBranch(repositoryDir);
	if (branch.ref !== subject.branch.ref || branch.head !== subject.candidate.revision.sha) {
		fail("TARGET_ADOPTION_AMBIGUOUS_RECOVERY", "Target is not on the exact adopted branch revision recorded by the intent.");
	}
}

/**
 * Apply one exact human-confirmed fast-forward. The same operation is its own
 * restart recovery: only a matching immutable intent authorizes recognizing an
 * already-fast-forwarded candidate and completing the immutable receipt.
 */
export function adoptTargetCandidate(
	options: AdoptTargetCandidateOptions,
	dependencies: Partial<TargetAdoptionDependencies> = {},
): TargetAdoptionResult {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	const expectedSubjectHash = HashSchema.parse(options.expectedSubjectHash);
	const actor = ActorSchema.parse(options.actor);
	const reason = ReasonSchema.parse(options.reason);
	const repositoryDir = repositoryRoot(options.repositoryDir);
	assertStateRootDoesNotDirtyTarget(repositoryDir, options.stateRoot);
	const paths = adoptionPaths(options.stateRoot, options.candidateId, true);
	assertClean(repositoryDir);
	let branch = currentBranch(repositoryDir);
	const subject = buildSubject(repositoryDir, options.runsRoot, options.candidateId, branch);

	if (subject.subjectHash !== expectedSubjectHash) {
		fail("TARGET_ADOPTION_STALE", "Target adoption subject changed after review; confirmation is stale.");
	}

	if (existsSync(paths.receipt)) {
		const receipt = loadReceipt(paths.receipt);
		if (!existsSync(paths.intent)) {
			fail("TARGET_ADOPTION_ARTIFACT_INVALID", "Completed Target adoption is missing its durable intent.");
		}
		const persistedIntent = loadIntent(paths.intent);
		exactMatch(persistedIntent, receipt.intent, "Target adoption receipt does not match its durable intent.");
		validateRequestAgainstIntent(receipt.intent, subject, expectedSubjectHash, actor, reason);
		assertExactAdoptedState(repositoryDir, subject);
		return {
			disposition: "already-adopted",
			subject,
			intent: receipt.intent,
			receipt,
			receiptPath: paths.receipt,
		};
	}

	let intent: TargetAdoptionIntent;
	let recovering = false;
	if (existsSync(paths.intent)) {
		intent = loadIntent(paths.intent);
		validateRequestAgainstIntent(intent, subject, expectedSubjectHash, actor, reason);
		recovering = true;
	} else {
		if (branch.head !== subject.candidate.baseline.sha) {
			fail(
				"TARGET_ADOPTION_AMBIGUOUS_RECOVERY",
				"Target is already away from the Candidate baseline and has no matching adoption intent.",
			);
		}
		intent = makeIntent(subject, actor, reason, TimestampSchema.parse(deps.now()));
		try {
			deps.writeIntent(paths.intent, intent);
		} catch (error) {
			if (!existsSync(paths.intent)) throw error;
			const concurrent = loadIntent(paths.intent);
			exactMatch(concurrent, intent, "A different Target adoption intent was published concurrently.");
			intent = concurrent;
			recovering = true;
		}
		assertPrivateArtifact(paths.intent);
		fsyncDirectory(resolve(paths.intent, ".."));
	}

	assertClean(repositoryDir);
	branch = currentBranch(repositoryDir);
	if (branch.ref !== subject.branch.ref) {
		fail("TARGET_ADOPTION_AMBIGUOUS_RECOVERY", "Current branch changed after the adoption intent was recorded.");
	}

	if (branch.head === subject.candidate.baseline.sha) {
		const revalidated = buildSubject(repositoryDir, options.runsRoot, options.candidateId, branch);
		exactMatch(revalidated, subject, "Candidate or promotion evidence changed before the fast-forward.");
		deps.fastForward(repositoryDir, subject.candidate.revision.sha);
	} else if (branch.head !== subject.candidate.revision.sha) {
		fail(
			"TARGET_ADOPTION_AMBIGUOUS_RECOVERY",
			"Target HEAD matches neither the confirmed baseline nor the confirmed candidate.",
		);
	}

	assertExactAdoptedState(repositoryDir, subject);
	const receipt = makeReceipt(intent, TimestampSchema.parse(deps.now()));
	try {
		deps.writeReceipt(paths.receipt, receipt);
	} catch (error) {
		if (!existsSync(paths.receipt)) throw error;
		const concurrent = loadReceipt(paths.receipt);
		exactMatch(concurrent, receipt, "A different Target adoption receipt was published concurrently.");
	}
	assertPrivateArtifact(paths.receipt);
	fsyncDirectory(resolve(paths.receipt, ".."));
	const persisted = loadReceipt(paths.receipt);
	exactMatch(persisted, receipt, "Persisted Target adoption receipt differs from the completed fast-forward.");
	return {
		disposition: recovering ? "recovered" : "adopted",
		subject,
		intent,
		receipt: persisted,
		receiptPath: paths.receipt,
	};
}

/** Load one private immutable receipt without consulting or mutating Git. */
export function loadTargetAdoptionReceipt(stateRoot: string, candidateId: string): TargetAdoptionReceipt {
	const paths = adoptionPaths(stateRoot, candidateId, false);
	if (!existsSync(paths.receipt)) {
		fail("TARGET_ADOPTION_ARTIFACT_INVALID", "Target adoption receipt does not exist.");
	}
	return loadReceipt(paths.receipt);
}

/**
 * Absence means this Candidate was never adopted; an existing but invalid
 * receipt still fails closed so inventory can block on it.
 */
export function loadTargetAdoptionReceiptIfPresent(
	stateRoot: string,
	candidateId: string,
): TargetAdoptionReceipt | null {
	const stateRoot_ = resolve(stateRoot);
	const safeCandidateId = safeArtifactSegment(candidateId, "candidate id");
	const receiptPath = join(stateRoot_, ADOPTIONS_DIRECTORY, safeCandidateId, RECEIPT_FILENAME);
	if (!existsSync(stateRoot_) || !existsSync(receiptPath)) return null;
	return loadTargetAdoptionReceipt(stateRoot_, candidateId);
}
