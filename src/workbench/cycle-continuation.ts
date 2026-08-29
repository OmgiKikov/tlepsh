import { execFileSync } from "node:child_process";
import {
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
import {
	TargetAdoptionIntentSchema,
	TargetAdoptionReceiptSchema,
	type TargetAdoptionReceipt,
} from "../application/target-adoption.js";
import { loadCandidateRecord } from "../application/candidate-review.js";
import { candidateStatus, type CandidateRecord } from "../domain/candidate.js";
import { canonicalJson, hashValue } from "../provenance.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import { safeArtifactSegment } from "../storage/paths.js";

const GitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "expected a full Git SHA");
const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected a sha256 fingerprint");
const TimestampSchema = z.iso.datetime({ offset: true });
const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
const NonBlankSchema = z.string().min(1).refine((value) => value.trim().length > 0, "expected non-blank text");
const ActorSchema = z.strictObject({ kind: z.literal("human"), id: NonBlankSchema.max(256) });
const ReasonSchema = NonBlankSchema.max(4_000);
const BranchRefSchema = z.string().min(12).max(1_024).startsWith("refs/heads/");

const CONTINUATIONS_DIRECTORY = "cycle-continuations";
const RECEIPT_FILENAME = "receipt.json";
const ADOPTIONS_DIRECTORY = "target-adoptions";
const ADOPTION_INTENT_FILENAME = "intent.json";
const ADOPTION_RECEIPT_FILENAME = "receipt.json";
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_SUBJECT_BYTES = 1024 * 1024;

export type CycleContinuationErrorCode =
	| "CYCLE_CONTINUATION_INVALID_REPOSITORY"
	| "CYCLE_CONTINUATION_DIRTY"
	| "CYCLE_CONTINUATION_STALE"
	| "CYCLE_CONTINUATION_INVALID_CANDIDATE"
	| "CYCLE_CONTINUATION_INVALID_ADOPTION"
	| "CYCLE_CONTINUATION_ARTIFACT_INVALID"
	| "CYCLE_CONTINUATION_CONFLICT";

/** A bounded host-facing failure. Filesystem and Git details remain in `cause`. */
export class CycleContinuationError extends Error {
	readonly code: CycleContinuationErrorCode;

	constructor(code: CycleContinuationErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "CycleContinuationError";
		this.code = code;
	}
}

export const CycleContinuationSubjectSchema = z.strictObject({
	schemaVersion: z.literal(1),
	algorithmId: z.literal("terminal-candidate-cycle-continuation-v1"),
	projectId: IdSchema,
	targetId: IdSchema,
	candidate: z.strictObject({
		candidateId: IdSchema,
		recordHash: HashSchema,
		status: z.enum(["promoted", "rejected"]),
		baselineSha: GitShaSchema,
		builtSha: GitShaSchema,
	}),
	activeTargetSha: GitShaSchema,
	branchRef: BranchRefSchema,
	adoptionReceiptHash: HashSchema.nullable(),
	subjectHash: HashSchema,
}).superRefine((subject, context) => {
	const expectedActiveSha = subject.candidate.status === "promoted"
		? subject.candidate.builtSha
		: subject.candidate.baselineSha;
	if (subject.activeTargetSha !== expectedActiveSha) {
		context.addIssue({
			code: "custom",
			path: ["activeTargetSha"],
			message: `must match the ${subject.candidate.status === "promoted" ? "adopted candidate" : "rejected candidate baseline"}`,
		});
	}
	if ((subject.candidate.status === "promoted") !== (subject.adoptionReceiptHash !== null)) {
		context.addIssue({
			code: "custom",
			path: ["adoptionReceiptHash"],
			message: subject.candidate.status === "promoted"
				? "is required for a promoted Candidate"
				: "must be null for a rejected Candidate",
		});
	}
	const { subjectHash: _subjectHash, ...identity } = subject;
	if (Buffer.byteLength(canonicalJson(identity), "utf8") > MAX_SUBJECT_BYTES) {
		context.addIssue({ code: "custom", path: [], message: "exact continuation subject exceeds its durable evidence limit" });
	}
	if (subject.subjectHash !== hashValue(identity)) {
		context.addIssue({ code: "custom", path: ["subjectHash"], message: "does not match the exact continuation subject" });
	}
});
export type CycleContinuationSubject = z.infer<typeof CycleContinuationSubjectSchema>;

export const CycleContinuationReceiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	algorithmId: z.literal("cycle-continuation-receipt-v1"),
	receiptId: z.string().regex(/^cycle-continuation-receipt-[0-9a-f]{64}$/),
	subject: CycleContinuationSubjectSchema,
	actor: ActorSchema,
	reason: ReasonSchema,
	continuedAt: TimestampSchema,
}).superRefine((receipt, context) => {
	const { receiptId: _receiptId, ...identity } = receipt;
	const expected = `cycle-continuation-receipt-${hashValue(identity).slice("sha256:".length)}`;
	if (receipt.receiptId !== expected) {
		context.addIssue({ code: "custom", path: ["receiptId"], message: "does not match the exact continuation receipt" });
	}
});
export type CycleContinuationReceipt = z.infer<typeof CycleContinuationReceiptSchema>;

export interface DescribeCycleContinuationOptions {
	repositoryDir: string;
	runsRoot: string;
	stateRoot: string;
	projectId: string;
	targetId: string;
	candidateId: string;
}

export interface RecordCycleContinuationOptions extends DescribeCycleContinuationOptions {
	expectedSubjectHash: string;
	actor: { kind: "human"; id: string };
	reason: string;
}

export interface CycleContinuationResult {
	disposition: "recorded" | "already-recorded";
	subject: CycleContinuationSubject;
	receipt: CycleContinuationReceipt;
	receiptPath: string;
}

export interface CycleContinuationDependencies {
	now: () => string;
	writeReceipt: (path: string, receipt: CycleContinuationReceipt) => void;
}

interface BranchIdentity {
	ref: string;
	head: string;
}

interface ContinuationPaths {
	directory: string;
	receipt: string;
}

function fail(code: CycleContinuationErrorCode, message: string, cause?: unknown): never {
	throw new CycleContinuationError(code, message, cause);
}

function gitEnvironment(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_TERMINAL_PROMPT: "0",
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
		return fail("CYCLE_CONTINUATION_INVALID_REPOSITORY", "Target Git state could not be verified.", error);
	}
}

function gitText(repositoryDir: string, args: string[]): string {
	return gitRaw(repositoryDir, args).toString("utf8").trim();
}

function repositoryRoot(input: string): string {
	try {
		const requested = resolve(input);
		const entry = lstatSync(requested);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			return fail("CYCLE_CONTINUATION_INVALID_REPOSITORY", "Target must be a regular non-symlink Git worktree root.");
		}
		const canonical = realpathSync(requested);
		const top = realpathSync(gitText(canonical, ["rev-parse", "--show-toplevel"]));
		if (canonical !== top) {
			return fail("CYCLE_CONTINUATION_INVALID_REPOSITORY", "Target must be the Git worktree root.");
		}
		return canonical;
	} catch (error) {
		if (error instanceof CycleContinuationError) throw error;
		return fail("CYCLE_CONTINUATION_INVALID_REPOSITORY", "Target must be a regular non-symlink Git worktree root.", error);
	}
}

function assertClean(repositoryDir: string): void {
	if (gitRaw(repositoryDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).length > 0) {
		fail("CYCLE_CONTINUATION_DIRTY", "Starting the next cycle requires a clean Target worktree and index.");
	}
}

function currentBranch(repositoryDir: string): BranchIdentity {
	let branchRef: string;
	try {
		branchRef = gitText(repositoryDir, ["symbolic-ref", "-q", "HEAD"]);
	} catch (error) {
		return fail("CYCLE_CONTINUATION_STALE", "Starting the next cycle requires a named local branch, not detached HEAD.", error);
	}
	if (!branchRef.startsWith("refs/heads/")) {
		fail("CYCLE_CONTINUATION_STALE", "Starting the next cycle requires a named local branch.");
	}
	const head = GitShaSchema.parse(gitText(repositoryDir, ["rev-parse", "--verify", "HEAD^{commit}"]));
	return { ref: BranchRefSchema.parse(branchRef), head };
}

function exactCommit(repositoryDir: string, shaInput: string, label: string): string {
	const expected = GitShaSchema.parse(shaInput);
	let actual: string;
	try {
		actual = GitShaSchema.parse(gitText(repositoryDir, ["rev-parse", "--verify", `${expected}^{commit}`]));
	} catch (error) {
		return fail("CYCLE_CONTINUATION_INVALID_CANDIDATE", `${label} is not an exact local commit.`, error);
	}
	if (actual !== expected) {
		fail("CYCLE_CONTINUATION_INVALID_CANDIDATE", `${label} resolves to a different commit.`);
	}
	return actual;
}

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function permissionMode(path: string): number {
	try {
		return statSync(path).mode & 0o777;
	} catch (error) {
		return fail("CYCLE_CONTINUATION_ARTIFACT_INVALID", "Cycle continuation state permissions could not be verified.", error);
	}
}

function assertPrivateDirectory(path: string, label: string): void {
	try {
		const entry = lstatSync(path);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			return fail("CYCLE_CONTINUATION_ARTIFACT_INVALID", `${label} must be a regular non-symlink directory.`);
		}
	} catch (error) {
		if (error instanceof CycleContinuationError) throw error;
		return fail("CYCLE_CONTINUATION_ARTIFACT_INVALID", `${label} could not be inspected.`, error);
	}
	const mode = permissionMode(path);
	if (mode !== 0o700) {
		fail("CYCLE_CONTINUATION_ARTIFACT_INVALID", `${label} must have mode 0700, got 0${mode.toString(8)}.`);
	}
}

function assertPrivateArtifact(path: string, label: string): void {
	try {
		const entry = lstatSync(path);
		if (!entry.isFile() || entry.isSymbolicLink()) {
			return fail("CYCLE_CONTINUATION_ARTIFACT_INVALID", `${label} must be a regular non-symlink file.`);
		}
	} catch (error) {
		if (error instanceof CycleContinuationError) throw error;
		return fail("CYCLE_CONTINUATION_ARTIFACT_INVALID", `${label} could not be inspected.`, error);
	}
	const mode = permissionMode(path);
	if (mode !== 0o600) {
		fail("CYCLE_CONTINUATION_ARTIFACT_INVALID", `${label} must have mode 0600, got 0${mode.toString(8)}.`);
	}
}

function secureStateRoot(stateRootInput: string, create: boolean): string | null {
	const requested = resolve(stateRootInput);
	try {
		let created = false;
		if (!existsSync(requested)) {
			if (!create) return null;
			try {
				mkdirSync(requested, { recursive: true, mode: 0o700 });
				created = true;
			} catch (error) {
				if (!isNodeError(error, "EEXIST")) throw error;
			}
		}
		assertPrivateDirectory(requested, "Cycle continuation state root");
		if (created) {
			fsyncDirectory(requested);
			fsyncDirectory(dirname(requested));
		}
		return realpathSync(requested);
	} catch (error) {
		if (error instanceof CycleContinuationError) throw error;
		return fail("CYCLE_CONTINUATION_ARTIFACT_INVALID", "Cycle continuation state root could not be secured.", error);
	}
}

function secureChildDirectory(root: string, path: string, create: boolean, label: string): string | null {
	if (!contained(root, path)) {
		fail("CYCLE_CONTINUATION_ARTIFACT_INVALID", `${label} escaped the configured state root.`);
	}
	let created = false;
	if (!existsSync(path)) {
		if (!create) return null;
		try {
			mkdirSync(path, { mode: 0o700 });
			created = true;
		} catch (error) {
			if (!isNodeError(error, "EEXIST")) {
				return fail("CYCLE_CONTINUATION_ARTIFACT_INVALID", `${label} could not be created.`, error);
			}
		}
	}
	assertPrivateDirectory(path, label);
	if (created) {
		fsyncDirectory(path);
		fsyncDirectory(dirname(path));
	}
	const canonical = realpathSync(path);
	if (!contained(root, canonical)) {
		fail("CYCLE_CONTINUATION_ARTIFACT_INVALID", `${label} escaped the configured state root.`);
	}
	return canonical;
}

function continuationPaths(
	stateRootInput: string,
	projectIdInput: string,
	candidateIdInput: string,
	create: boolean,
): ContinuationPaths | null {
	const root = secureStateRoot(stateRootInput, create);
	if (!root) return null;
	const projectId = safeArtifactSegment(projectIdInput, "project id");
	const candidateId = safeArtifactSegment(candidateIdInput, "candidate id");
	let current = root;
	for (const [segment, label] of [
		["projects", "Cycle continuation projects directory"],
		[projectId, "Cycle continuation project directory"],
		["workbench", "Cycle continuation Workbench directory"],
		[CONTINUATIONS_DIRECTORY, "Cycle continuations directory"],
		[candidateId, "Candidate continuation directory"],
	] as const) {
		const next = secureChildDirectory(root, join(current, segment), create, label);
		if (!next) return null;
		current = next;
	}
	return { directory: current, receipt: join(current, RECEIPT_FILENAME) };
}

function assertStateRootDoesNotDirtyTarget(repositoryDir: string, stateRootInput: string): void {
	const stateRoot = resolve(stateRootInput);
	if (!contained(repositoryDir, stateRoot)) return;
	const relativeState = relative(repositoryDir, stateRoot);
	if (!relativeState || relativeState === ".git" || relativeState.startsWith(`.git${sep}`)) {
		fail("CYCLE_CONTINUATION_ARTIFACT_INVALID", "Cycle continuation state must not be the repository root or live inside .git.");
	}
	try {
		execFileSync(
			"git",
			["--no-replace-objects", "-C", repositoryDir, "check-ignore", "-q", "--no-index", "--", relativeState],
			{ stdio: "ignore", env: gitEnvironment() },
		);
	} catch (error) {
		return fail(
			"CYCLE_CONTINUATION_ARTIFACT_INVALID",
			"An in-repository cycle continuation state root must be ignored by Git.",
			error,
		);
	}
}

function fsyncDirectory(path: string): void {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, constants.O_RDONLY);
		fsyncSync(descriptor);
	} catch (error) {
		return fail("CYCLE_CONTINUATION_ARTIFACT_INVALID", "Cycle continuation evidence directory could not be synchronized.", error);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function loadReceipt(path: string): CycleContinuationReceipt {
	assertPrivateArtifact(path, "Cycle continuation receipt");
	try {
		return readJsonArtifact(path, CycleContinuationReceiptSchema, { maxBytes: MAX_RECEIPT_BYTES });
	} catch (error) {
		return fail("CYCLE_CONTINUATION_ARTIFACT_INVALID", "Cycle continuation receipt is invalid.", error);
	}
}

function exactMatch(actual: unknown, expected: unknown, message: string): void {
	if (canonicalJson(actual) !== canonicalJson(expected)) {
		fail("CYCLE_CONTINUATION_CONFLICT", message);
	}
}

function builtRevision(record: CandidateRecord): string {
	const built = record.events.find((event) => event.type === "built");
	if (!built || built.type !== "built") {
		fail("CYCLE_CONTINUATION_INVALID_CANDIDATE", `Terminal Candidate ${record.candidateId} is missing its built revision.`);
	}
	return built.candidate.sha;
}

function adoptionArtifacts(stateRootInput: string, candidateIdInput: string): {
	intentPath: string;
	receiptPath: string;
} {
	const root = secureStateRoot(stateRootInput, false);
	if (!root) {
		fail("CYCLE_CONTINUATION_INVALID_ADOPTION", "A promoted Candidate must be adopted before starting the next cycle.");
	}
	const candidateId = safeArtifactSegment(candidateIdInput, "candidate id");
	const adoptions = join(root, ADOPTIONS_DIRECTORY);
	const candidate = join(adoptions, candidateId);
	for (const [path, label] of [
		[adoptions, "Target adoption directory"],
		[candidate, "Candidate adoption directory"],
	] as const) {
		if (!existsSync(path)) {
			fail("CYCLE_CONTINUATION_INVALID_ADOPTION", "A promoted Candidate must be adopted before starting the next cycle.");
		}
		assertPrivateDirectory(path, label);
		if (!contained(root, realpathSync(path))) {
			fail("CYCLE_CONTINUATION_ARTIFACT_INVALID", `${label} escaped the configured state root.`);
		}
	}
	const intentPath = join(candidate, ADOPTION_INTENT_FILENAME);
	const receiptPath = join(candidate, ADOPTION_RECEIPT_FILENAME);
	if (!existsSync(intentPath) || !existsSync(receiptPath)) {
		fail("CYCLE_CONTINUATION_INVALID_ADOPTION", "Target adoption evidence is incomplete.");
	}
	assertPrivateArtifact(intentPath, "Target adoption intent");
	assertPrivateArtifact(receiptPath, "Target adoption receipt");
	return { intentPath, receiptPath };
}

function loadExactAdoptionReceipt(
	stateRoot: string,
	record: CandidateRecord,
	recordHash: string,
	builtSha: string,
	branch: BranchIdentity,
): TargetAdoptionReceipt {
	let receipt: TargetAdoptionReceipt;
	try {
		const paths = adoptionArtifacts(stateRoot, record.candidateId);
		const intent = readJsonArtifact(paths.intentPath, TargetAdoptionIntentSchema, { maxBytes: MAX_RECEIPT_BYTES });
		receipt = readJsonArtifact(paths.receiptPath, TargetAdoptionReceiptSchema, { maxBytes: MAX_RECEIPT_BYTES });
		if (canonicalJson(intent) !== canonicalJson(receipt.intent)) {
			fail("CYCLE_CONTINUATION_INVALID_ADOPTION", "Target adoption receipt does not match its durable intent.");
		}
	} catch (error) {
		if (error instanceof CycleContinuationError) throw error;
		return fail("CYCLE_CONTINUATION_INVALID_ADOPTION", "Target adoption evidence is invalid.", error);
	}
	const adopted = receipt.intent.subject;
	if (
		adopted.candidate.candidateId !== record.candidateId ||
		adopted.candidate.targetId !== record.targetId ||
		adopted.candidate.candidateRecordHash !== recordHash ||
		adopted.candidate.baseline.sha !== record.baseline.sha ||
		adopted.candidate.revision.sha !== builtSha ||
		receipt.previousHead !== record.baseline.sha ||
		receipt.adoptedHead !== builtSha ||
		receipt.branchRef !== branch.ref
	) {
		fail("CYCLE_CONTINUATION_INVALID_ADOPTION", "Target adoption evidence does not bind the exact terminal Candidate and active branch.");
	}
	return receipt;
}

function loadExactCandidate(options: DescribeCycleContinuationOptions): CandidateRecord {
	const projectId = IdSchema.parse(options.projectId);
	const targetId = IdSchema.parse(options.targetId);
	const candidateId = IdSchema.parse(options.candidateId);
	let record: CandidateRecord;
	try {
		record = loadCandidateRecord(options.runsRoot, candidateId);
	} catch (error) {
		return fail("CYCLE_CONTINUATION_INVALID_CANDIDATE", "CandidateRecord could not be loaded exactly.", error);
	}
	if (record.candidateId !== candidateId || record.projectId !== projectId || record.targetId !== targetId) {
		fail("CYCLE_CONTINUATION_INVALID_CANDIDATE", "CandidateRecord does not belong to the requested project and Target.");
	}
	const status = candidateStatus(record);
	if (status !== "promoted" && status !== "rejected") {
		fail("CYCLE_CONTINUATION_INVALID_CANDIDATE", `Candidate ${candidateId} is not terminal.`);
	}
	return record;
}

function buildSubject(
	options: DescribeCycleContinuationOptions,
	repositoryDir: string,
	branch: BranchIdentity,
): CycleContinuationSubject {
	const record = loadExactCandidate(options);
	const status = candidateStatus(record) as "promoted" | "rejected";
	const recordHash = hashValue(record);
	const baselineSha = exactCommit(repositoryDir, record.baseline.sha, "Candidate baseline");
	const builtSha = exactCommit(repositoryDir, builtRevision(record), "Candidate revision");
	let adoptionReceiptHash: string | null = null;
	const expectedHead = status === "promoted" ? builtSha : baselineSha;
	if (branch.head !== expectedHead) {
		fail(
			"CYCLE_CONTINUATION_STALE",
			status === "promoted"
				? "Target HEAD must equal the adopted Candidate before starting the next cycle."
				: "Target HEAD must remain at the rejected Candidate baseline before starting the next cycle.",
		);
	}
	if (status === "promoted") {
		const adoption = loadExactAdoptionReceipt(options.stateRoot, record, recordHash, builtSha, branch);
		adoptionReceiptHash = hashValue(adoption);
	}
	const identity = {
		schemaVersion: 1 as const,
		algorithmId: "terminal-candidate-cycle-continuation-v1" as const,
		projectId: record.projectId,
		targetId: record.targetId,
		candidate: {
			candidateId: record.candidateId,
			recordHash,
			status,
			baselineSha,
			builtSha,
		},
		activeTargetSha: branch.head,
		branchRef: branch.ref,
		adoptionReceiptHash,
	};
	return CycleContinuationSubjectSchema.parse({ ...identity, subjectHash: hashValue(identity) });
}

/** Build the exact terminal Candidate and active Target subject a trusted host must confirm. */
export function describeCycleContinuation(options: DescribeCycleContinuationOptions): CycleContinuationSubject {
	const repositoryDir = repositoryRoot(options.repositoryDir);
	assertStateRootDoesNotDirtyTarget(repositoryDir, options.stateRoot);
	const existingStateRoot = secureStateRoot(options.stateRoot, false);
	if (existingStateRoot) assertPrivateDirectory(existingStateRoot, "Cycle continuation state root");
	assertClean(repositoryDir);
	return buildSubject(options, repositoryDir, currentBranch(repositoryDir));
}

function makeReceipt(
	subject: CycleContinuationSubject,
	actor: z.infer<typeof ActorSchema>,
	reason: string,
	continuedAt: string,
): CycleContinuationReceipt {
	const identity = {
		schemaVersion: 1 as const,
		algorithmId: "cycle-continuation-receipt-v1" as const,
		subject,
		actor,
		reason,
		continuedAt,
	};
	return CycleContinuationReceiptSchema.parse({
		...identity,
		receiptId: `cycle-continuation-receipt-${hashValue(identity).slice("sha256:".length)}`,
	});
}

const DEFAULT_DEPENDENCIES: CycleContinuationDependencies = {
	now: () => new Date().toISOString(),
	writeReceipt: (path, receipt) => writeJsonArtifact(path, CycleContinuationReceiptSchema, receipt, { immutable: true }),
};

function validateReplay(
	receipt: CycleContinuationReceipt,
	subject: CycleContinuationSubject,
	actor: z.infer<typeof ActorSchema>,
	reason: string,
): void {
	exactMatch(receipt.subject, subject, "Cycle continuation receipt belongs to a different terminal Candidate or Target state.");
	exactMatch(receipt.actor, actor, "Cycle continuation receipt belongs to a different human actor.");
	if (receipt.reason !== reason) {
		fail("CYCLE_CONTINUATION_CONFLICT", "Cycle continuation receipt has a different human reason.");
	}
}

/**
 * Record one exact human-confirmed transition into the next improvement cycle.
 * This host-only module grants no model-facing authority and never mutates Git.
 */
export function recordCycleContinuation(
	options: RecordCycleContinuationOptions,
	dependencies: Partial<CycleContinuationDependencies> = {},
): CycleContinuationResult {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	const expectedSubjectHash = HashSchema.parse(options.expectedSubjectHash);
	const actor = ActorSchema.parse(options.actor);
	const reason = ReasonSchema.parse(options.reason);
	const repositoryDir = repositoryRoot(options.repositoryDir);
	assertStateRootDoesNotDirtyTarget(repositoryDir, options.stateRoot);
	assertClean(repositoryDir);
	const subject = buildSubject(options, repositoryDir, currentBranch(repositoryDir));
	if (subject.subjectHash !== expectedSubjectHash) {
		fail("CYCLE_CONTINUATION_STALE", "Cycle continuation subject changed after review; confirmation is stale.");
	}

	const paths = continuationPaths(options.stateRoot, subject.projectId, subject.candidate.candidateId, true)!;
	if (existsSync(paths.receipt)) {
		const existing = loadReceipt(paths.receipt);
		validateReplay(existing, subject, actor, reason);
		return { disposition: "already-recorded", subject, receipt: existing, receiptPath: paths.receipt };
	}

	assertClean(repositoryDir);
	const revalidated = buildSubject(options, repositoryDir, currentBranch(repositoryDir));
	exactMatch(revalidated, subject, "Candidate, Target, or adoption evidence changed before continuation was recorded.");
	const receipt = makeReceipt(subject, actor, reason, TimestampSchema.parse(deps.now()));
	try {
		deps.writeReceipt(paths.receipt, receipt);
	} catch (error) {
		if (!existsSync(paths.receipt)) throw error;
		const concurrent = loadReceipt(paths.receipt);
		validateReplay(concurrent, subject, actor, reason);
		assertClean(repositoryDir);
		const finalSubject = buildSubject(options, repositoryDir, currentBranch(repositoryDir));
		exactMatch(finalSubject, subject, "Candidate, Target, or adoption evidence changed while continuation was recorded.");
		return { disposition: "already-recorded", subject, receipt: concurrent, receiptPath: paths.receipt };
	}
	assertPrivateArtifact(paths.receipt, "Cycle continuation receipt");
	fsyncDirectory(paths.directory);
	const persisted = loadReceipt(paths.receipt);
	exactMatch(persisted, receipt, "Persisted cycle continuation receipt differs from the confirmed evidence.");
	assertClean(repositoryDir);
	const finalSubject = buildSubject(options, repositoryDir, currentBranch(repositoryDir));
	exactMatch(finalSubject, subject, "Candidate, Target, or adoption evidence changed while continuation was recorded.");
	return { disposition: "recorded", subject, receipt: persisted, receiptPath: paths.receipt };
}

/** Load one immutable private receipt. Absence means this Candidate has not started a next cycle. */
export function loadCycleContinuationReceipt(
	stateRoot: string,
	projectId: string,
	candidateId: string,
): CycleContinuationReceipt | null {
	const paths = continuationPaths(stateRoot, IdSchema.parse(projectId), IdSchema.parse(candidateId), false);
	if (!paths || !existsSync(paths.receipt)) return null;
	return loadReceipt(paths.receipt);
}
