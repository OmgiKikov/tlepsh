import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	BuilderRunRecordSchema,
	type BuilderAdapter,
	type BuilderCapabilities,
	type CandidateProposal,
} from "../builders/adapters.js";
import { diagnoseEvalRun } from "../diagnosis.js";
import { readEvalRunIndex } from "../eval.js";
import { resolveCommitRef } from "../git/experiment-worktree.js";
import { assertUntrackedEngineStore } from "./store-hygiene.js";
import {
	resolveCanonicalProposalBasis,
	runApprovedSpecBuilderProposal,
	type BuilderProposalRunResult,
} from "./builder-proposal.js";
import { HARNESS_AUTHORING_ALLOWED_PATHS, wholeFileDiff } from "./harness-authoring.js";
import {
	compileImprovementBrief,
	deriveEvidenceLinkedProposalSelection,
	type EvidenceLinkedProposalDiagnosis,
	type ProposalBasisSelection,
} from "./improvement-brief.js";

/**
 * A Git branch compiled into the typed Builder proposal the engine gates on.
 *
 * The operator edits harness files the way they always have — on a branch — and
 * this reads that branch back as whole-file changes against the exact committed
 * base the proposal will bind to. Every guard that matters (path allowlist,
 * base-SHA binding, evidence linkage, the apply receipt) stays where it already
 * lives: this module only renders the diff and hands the same artifact a
 * Builder would have produced to {@link runApprovedSpecBuilderProposal}.
 */

const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const MAX_CHANGED_FILES = 64;

/** The scope a reviewed harness change may touch. */
export const BRANCH_PROPOSAL_ALLOWED_PATHS: readonly string[] = HARNESS_AUTHORING_ALLOWED_PATHS;

const CAPABILITIES: BuilderCapabilities = {
	eventStream: true,
	structuredOutput: true,
	usage: false,
	cost: false,
	sessionId: false,
	cancellation: true,
	isolation: "tool-free-executor",
};

const BACKEND = "branch-diff";
const BACKEND_VERSION = "branch-diff 1.0.0";

function git(repositoryDir: string, args: readonly string[]): string {
	return execFileSync("git", ["-C", repositoryDir, ...args], {
		encoding: "utf8",
		maxBuffer: GIT_MAX_BUFFER,
		stdio: ["ignore", "pipe", "pipe"],
	}).trimEnd();
}

function gitBuffer(repositoryDir: string, args: readonly string[]): Buffer {
	return execFileSync("git", ["-C", repositoryDir, ...args], {
		maxBuffer: GIT_MAX_BUFFER,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function sha256(content: Buffer): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function matchesAllowedPath(path: string, allowed: string): boolean {
	if (allowed.endsWith("/**")) return path.startsWith(allowed.slice(0, -2));
	return path === allowed;
}

/** `100644`/`100755` for one path in one tree, or null when it is absent. */
function treeEntryMode(repositoryDir: string, sha: string, path: string): "100644" | "100755" | null {
	const entry = git(repositoryDir, ["ls-tree", "-z", "--full-tree", sha, "--", path]);
	if (!entry) return null;
	const mode = entry.split(" ", 1)[0];
	if (mode === "100644" || mode === "100755") return mode;
	throw new Error(`branch change ${path} is not a regular file at ${sha.slice(0, 12)} (mode ${mode ?? "unknown"})`);
}

/** A refusal `ahde propose` can explain, with the operator's next step. */
export class BranchProposalError extends Error {
	readonly name = "BranchProposalError";
	/** What the operator should do about it. Surfaced by the CLI as `next:`. */
	readonly next: string;

	constructor(message: string, next: string, options?: ErrorOptions) {
		super(message, options);
		this.next = next;
	}
}

/**
 * Whether the checkout carries anything the recorded revision cannot name.
 * Deliberately the same question `gitSha()` in manifest.ts asks before it
 * appends `-dirty-<hash>`, so the two can never disagree about what dirty is.
 */
function hasUncommittedChanges(repositoryDir: string): boolean {
	return git(repositoryDir, ["status", "--porcelain=v1", "--untracked-files=all"]).trim().length > 0;
}

/**
 * A proposal is a diff against an exact commit. A dirty tree has no commit to
 * be a diff against — the revision recorded for it is `<sha>-dirty-<hash>`,
 * which names no Git object — so the refusal says that instead of letting
 * `rev-parse` fail on a string it was never given.
 */
export function assertCleanProposalBaseline(repositoryDir: string, sourceRevision?: string): void {
	if (hasUncommittedChanges(repositoryDir)) {
		throw new BranchProposalError(
			"the Target has uncommitted changes; a proposal compiles only against a clean committed baseline",
			"commit or stash them, then run ahde propose again",
		);
	}
	if (sourceRevision !== undefined && sourceRevision.includes("-dirty-")) {
		throw new BranchProposalError(
			`the evidence was recorded on a dirty tree (${sourceRevision}); ` +
			"a proposal compiles only against a clean committed baseline",
			"the tree is clean now — re-run the baseline and propose against that eval run",
		);
	}
}

/**
 * The revision the named evidence was recorded at, or undefined when there is
 * no evidence to name and when its index cannot be read — an unreadable eval
 * run is reported by the evidence chain below, in its own words.
 */
function recordedSourceRevision(runsRoot: string, sourceEvalRunId?: string): string | undefined {
	if (sourceEvalRunId === undefined) return undefined;
	try {
		return readEvalRunIndex(runsRoot, sourceEvalRunId).target.gitSha;
	} catch {
		return undefined;
	}
}

export interface BranchChangeInput {
	summary: string;
	evidenceRefs: string[];
}

/**
 * The changed harness files between the committed base and the branch, as the
 * whole-file replacements a reviewed proposal always carries. Refuses anything
 * outside the allowed scope by name — a proposal that touched it could not be
 * applied anyway, and finding out at apply time is finding out too late.
 */
export function compileBranchChanges(
	repositoryDir: string,
	baseSha: string,
	branchSha: string,
	allowedPaths: readonly string[],
	input: BranchChangeInput,
): CandidateProposal["changes"] {
	const raw = git(repositoryDir, [
		"diff", "--no-renames", "--name-only", "-z", baseSha, branchSha,
	]);
	const paths = raw.split("\0").filter((path) => path.length > 0).sort();
	if (paths.length === 0) {
		throw new Error(
			`branch ${branchSha.slice(0, 12)} changes nothing against the Target baseline ${baseSha.slice(0, 12)}`,
		);
	}
	if (paths.length > MAX_CHANGED_FILES) {
		throw new Error(`branch changes ${paths.length} files; a reviewed proposal carries at most ${MAX_CHANGED_FILES}`);
	}
	for (const path of paths) {
		if (!allowedPaths.some((allowed) => matchesAllowedPath(path, allowed))) {
			throw new Error(
				`branch change is outside the allowed harness scope: ${path} ` +
				`(allowed: ${allowedPaths.join(", ")})`,
			);
		}
	}
	return paths.map((path) => {
		const beforeMode = treeEntryMode(repositoryDir, baseSha, path);
		const afterMode = treeEntryMode(repositoryDir, branchSha, path);
		const before = beforeMode
			? { mode: beforeMode, content: gitBuffer(repositoryDir, ["cat-file", "blob", `${baseSha}:${path}`]) }
			: null;
		const after = afterMode
			? gitBuffer(repositoryDir, ["cat-file", "blob", `${branchSha}:${path}`]).toString("utf8")
			: null;
		return {
			path,
			baseSha256: before ? sha256(before.content) : sha256(Buffer.alloc(0)),
			unifiedDiff: wholeFileDiff({ path, before, after, afterMode }),
			rationale: input.summary,
			evidenceRefs: input.evidenceRefs,
		};
	});
}

export interface BranchProposalOptions {
	targetDir: string;
	runsRoot: string;
	stateRoot: string;
	projectId: string;
	/** The approved Spec this proposal is authored under. */
	specId: string;
	/** The branch that already carries the change. */
	branch: string;
	summary?: string;
	/** Together with `failureModeIds`, binds the proposal to diagnosed evidence. */
	sourceEvalRunId?: string;
	failureModeIds?: readonly string[];
	dataset?: string;
	runId?: string;
	timeoutMs?: number;
	now?: () => string;
}

export interface BranchProposalResult {
	builderRunId: string;
	proposalPath: string | null;
	baseTargetSha: string;
	branchSha: string;
	changedPaths: string[];
	sourceEvalRunId: string | null;
	run: BuilderProposalRunResult;
}

/**
 * Compile one branch into a typed proposal bound to this project's approved
 * Spec. With `sourceEvalRunId`/`failureModeIds` it is a diagnosed fix and the
 * canonical evidence chain is built for it; without them it is a construction
 * change the Spec alone justifies.
 */
export async function proposeBranchChange(options: BranchProposalOptions): Promise<BranchProposalResult> {
	const approvedSpec = {
		stateRoot: options.stateRoot,
		projectId: options.projectId,
		specId: options.specId,
	};
	const failureModeIds = [...(options.failureModeIds ?? [])];
	if ((options.sourceEvalRunId === undefined) !== (failureModeIds.length === 0)) {
		throw new Error("a diagnosed proposal needs both --eval and --mode; a construction proposal needs neither");
	}
	// Both refusals before any work: the engine store must not already be inside
	// a Git object, and the baseline this diff is taken against must be a commit.
	assertUntrackedEngineStore(options.targetDir);
	assertCleanProposalBaseline(options.targetDir, recordedSourceRevision(options.runsRoot, options.sourceEvalRunId));
	const branchSha = resolveCommitRef(options.targetDir, options.branch);
	const summary = options.summary ?? `Harness change from branch ${options.branch}.`;

	let diagnoses: EvidenceLinkedProposalDiagnosis[] = [];
	let evidenceRefs: string[] = [];
	let proposalBasis: ProposalBasisSelection | undefined;
	if (options.sourceEvalRunId !== undefined) {
		// The sealed preflight and the failure-mode check live in this call;
		// the brief is then recompiled only to carry the evidence links.
		proposalBasis = resolveCanonicalProposalBasis({
			runsRoot: options.runsRoot,
			approvedSpec,
			sourceEvalRunId: options.sourceEvalRunId,
			failureModeIds,
		});
		const selected = deriveEvidenceLinkedProposalSelection(
			compileImprovementBrief(options.runsRoot, diagnoseEvalRun(options.runsRoot, options.sourceEvalRunId)),
			proposalBasis,
		);
		diagnoses = selected.diagnoses;
		evidenceRefs = [...new Set(selected.diagnoses.flatMap((entry) => entry.evidence))];
	}

	const changedPaths: string[] = [];
	const now = options.now ?? (() => new Date().toISOString());
	const adapter: BuilderAdapter = {
		backend: BACKEND,
		capabilities: CAPABILITIES,
		async probe() {
			return {
				backend: BACKEND,
				available: true,
				version: BACKEND_VERSION,
				capabilities: CAPABILITIES,
				error: null,
			};
		},
		async run(request) {
			// The host owns the base revision, so the diff is rendered against the
			// SHA it decided on, never against whatever the checkout happens to be.
			const changes = compileBranchChanges(
				options.targetDir,
				request.baseTargetSha,
				branchSha,
				request.allowedPaths,
				{ summary, evidenceRefs },
			);
			changedPaths.splice(0, changedPaths.length, ...changes.map((change) => change.path));
			const startedAt = now();
			return BuilderRunRecordSchema.parse({
				schemaVersion: 1,
				runId: request.runId,
				backend: BACKEND,
				backendVersion: BACKEND_VERSION,
				capabilities: CAPABILITIES,
				baseTargetSha: request.baseTargetSha,
				startedAt,
				finishedAt: now(),
				status: "completed",
				proposal: {
					schemaVersion: 1,
					decision: "propose",
					baseTargetSha: request.baseTargetSha,
					summary,
					diagnoses,
					changes,
					risks: [`Whole-file replacement of ${changes.length} harness file(s) taken from branch ${options.branch}.`],
					validationPlan: ["Matched development comparison plus the sealed holdout gate"],
				},
				model: null,
				sessionId: null,
				usage: null,
				costUsd: null,
				traceLevel: "full",
				rawEvents: [JSON.stringify({ type: "final", branch: options.branch, branchSha })],
				error: null,
			});
		},
	};

	const run = await runApprovedSpecBuilderProposal({
		adapter,
		approvedSpec,
		targetDir: options.targetDir,
		allowedPaths: [...BRANCH_PROPOSAL_ALLOWED_PATHS],
		runsRoot: options.runsRoot,
		timeoutMs: options.timeoutMs ?? 60_000,
		...(options.dataset === undefined ? {} : { dataset: options.dataset }),
		...(options.sourceEvalRunId === undefined ? {} : { sourceEvalRunId: options.sourceEvalRunId }),
		...(proposalBasis === undefined ? {} : { proposalBasis }),
		...(options.runId === undefined ? {} : { runId: options.runId }),
	});

	// A refused branch is recorded as a failed Builder run rather than thrown, so
	// the reason has to be lifted back out: an operator who typed `propose` must
	// see the path that was out of scope, not a run id with nothing applied.
	if (run.record.result.status !== "completed") {
		const failure = run.record.result.error;
		throw new Error(
			`branch ${options.branch} did not produce a proposal (${run.record.result.status}): ` +
			`${failure?.message ?? "no reason recorded"} · builder run ${run.record.runId}`,
		);
	}

	return {
		builderRunId: run.record.runId,
		proposalPath: run.proposalPath,
		baseTargetSha: run.record.request.baseTargetSha,
		branchSha,
		changedPaths: [...changedPaths].sort(),
		sourceEvalRunId: options.sourceEvalRunId ?? null,
		run,
	};
}
