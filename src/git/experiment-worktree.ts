import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * The two halves of every name this module creates: a temporary root under the
 * OS temp directory, and the fixed leaf a worktree is checked out into. They
 * live here because re-attaching to a worktree another process opened has to
 * recognize the same names — a convention invented in one module and re-spelled
 * in another is a convention that drifts.
 */
const TEMP_PREFIX = "ahde-experiment-";
const DETACHED_WORKTREE_NAME = "detached";
const WORKTREE_NAMES = ["baseline", "candidate", DETACHED_WORKTREE_NAME];
const COMMIT_SHA = /^[0-9a-f]{40}$/;

export type ExperimentWorktreeMode = "candidate" | "aa-calibration";

export interface ExperimentWorktree {
	ref: string;
	sha: string;
	path: string;
}

export interface ExperimentWorktreePair {
	mode: ExperimentWorktreeMode;
	repositoryDir: string;
	baseline: ExperimentWorktree;
	candidate: ExperimentWorktree;
}

export interface ExperimentWorktreeOptions {
	repositoryDir: string;
	baselineRef: string;
	candidateRef: string;
	mode?: ExperimentWorktreeMode;
}

export interface DetachedWorktreeOptions {
	repositoryDir: string;
	ref: string;
}

function git(repositoryDir: string, args: string[]): string {
	try {
		return execFileSync("git", ["-C", repositoryDir, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		const stderr =
			typeof error === "object" && error !== null && "stderr" in error
				? String((error as { stderr?: unknown }).stderr).trim()
				: "";
		throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, {
			cause: error,
		});
	}
}

function validateRepositoryDir(input: string): string {
	const absolute = resolve(input);
	if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
		throw new Error(`repository directory does not exist: ${absolute}`);
	}
	const repositoryDir = realpathSync(absolute);
	const topLevel = realpathSync(git(repositoryDir, ["rev-parse", "--show-toplevel"]));
	if (topLevel !== repositoryDir) {
		throw new Error(`repositoryDir must be the Git worktree root: ${repositoryDir}`);
	}
	return repositoryDir;
}

function validateRef(ref: string, label: string): void {
	if (!ref || ref.startsWith("-") || ref.includes("\0") || /[\r\n]/.test(ref)) {
		throw new Error(`invalid ${label} ref`);
	}
}

export function resolveCommitRef(repositoryDir: string, ref: string): string {
	validateRef(ref, "Git");
	const sha = git(repositoryDir, ["rev-parse", "--verify", `${ref}^{commit}`]);
	if (!COMMIT_SHA.test(sha)) {
		throw new Error(`ref ${JSON.stringify(ref)} did not resolve to a 40-character commit SHA`);
	}
	return sha;
}

function isAncestor(repositoryDir: string, baselineSha: string, candidateSha: string): boolean {
	const result = spawnSync(
		"git",
		["-C", repositoryDir, "merge-base", "--is-ancestor", baselineSha, candidateSha],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	if (result.status === 0) return true;
	if (result.status === 1) return false;
	throw new Error(
		`git merge-base --is-ancestor failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`,
	);
}

function validateLineage(
	repositoryDir: string,
	mode: ExperimentWorktreeMode,
	baselineSha: string,
	candidateSha: string,
): void {
	if (mode === "aa-calibration") {
		if (baselineSha !== candidateSha) {
			throw new Error("aa-calibration requires baseline and candidate to resolve to the same commit");
		}
		return;
	}

	if (baselineSha === candidateSha) {
		throw new Error("candidate experiment requires distinct baseline and candidate commits");
	}
	if (!isAncestor(repositoryDir, baselineSha, candidateSha)) {
		throw new Error("candidate commit must descend from the baseline commit");
	}
}

function assertSafeTemporaryRoot(root: string): void {
	const temporaryBase = resolve(tmpdir());
	const absoluteRoot = resolve(root);
	const fromTemporaryBase = relative(temporaryBase, absoluteRoot);
	if (
		!fromTemporaryBase ||
		isAbsolute(fromTemporaryBase) ||
		fromTemporaryBase.startsWith("..") ||
		!basename(absoluteRoot).startsWith(TEMP_PREFIX)
	) {
		throw new Error(`refusing to clean unsafe temporary root: ${absoluteRoot}`);
	}
}

function assertSafeWorktreePath(root: string, path: string): void {
	assertSafeTemporaryRoot(root);
	const child = relative(resolve(root), resolve(path));
	if (!WORKTREE_NAMES.includes(child) || isAbsolute(child)) {
		throw new Error(`refusing to clean unsafe worktree path: ${resolve(path)}`);
	}
}

function cleanupWorktree(
	repositoryDir: string,
	temporaryRoot: string,
	path: string,
	wasAdded: boolean,
	errors: unknown[],
): void {
	try {
		assertSafeWorktreePath(temporaryRoot, path);
		if (wasAdded) git(repositoryDir, ["worktree", "remove", "--force", path]);
	} catch (error) {
		errors.push(error);
	} finally {
		if (existsSync(path)) {
			try {
				assertSafeWorktreePath(temporaryRoot, path);
				rmSync(path, { recursive: true, force: true });
			} catch (error) {
				errors.push(error);
			}
		}
	}
}

/**
 * Resolve and validate immutable experiment revisions, expose detached
 * worktrees for the callback, then remove them without touching the user's
 * current checkout.
 */
export async function withExperimentWorktrees<T>(
	options: ExperimentWorktreeOptions,
	callback: (worktrees: ExperimentWorktreePair) => Promise<T> | T,
): Promise<T> {
	const repositoryDir = validateRepositoryDir(options.repositoryDir);
	const mode = options.mode ?? "candidate";
	if (mode !== "candidate" && mode !== "aa-calibration") {
		throw new Error(`unsupported experiment worktree mode: ${String(mode)}`);
	}
	validateRef(options.baselineRef, "baseline");
	validateRef(options.candidateRef, "candidate");
	const baselineSha = resolveCommitRef(repositoryDir, options.baselineRef);
	const candidateSha = resolveCommitRef(repositoryDir, options.candidateRef);
	validateLineage(repositoryDir, mode, baselineSha, candidateSha);

	const temporaryRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
	assertSafeTemporaryRoot(temporaryRoot);
	const baselinePath = join(temporaryRoot, "baseline");
	const candidatePath = join(temporaryRoot, "candidate");
	let baselineAdded = false;
	let candidateAdded = false;
	let operationError: unknown;

	try {
		git(repositoryDir, ["worktree", "add", "--detach", baselinePath, baselineSha]);
		baselineAdded = true;
		git(repositoryDir, ["worktree", "add", "--detach", candidatePath, candidateSha]);
		candidateAdded = true;

		return await callback({
			mode,
			repositoryDir,
			baseline: { ref: options.baselineRef, sha: baselineSha, path: baselinePath },
			candidate: { ref: options.candidateRef, sha: candidateSha, path: candidatePath },
		});
	} catch (error) {
		operationError = error;
		throw error;
	} finally {
		const cleanupErrors: unknown[] = [];
		cleanupWorktree(repositoryDir, temporaryRoot, candidatePath, candidateAdded, cleanupErrors);
		cleanupWorktree(repositoryDir, temporaryRoot, baselinePath, baselineAdded, cleanupErrors);
		try {
			git(repositoryDir, ["worktree", "prune"]);
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			assertSafeTemporaryRoot(temporaryRoot);
			rmSync(temporaryRoot, { recursive: true, force: true });
		} catch (error) {
			cleanupErrors.push(error);
		}

		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
				"failed to clean experiment worktrees",
			);
		}
	}
}

/**
 * Run a callback against one exact detached revision without reading or
 * changing the user's current checkout. The temporary worktree is removed
 * even when the callback fails.
 */
export async function withDetachedWorktree<T>(
	options: DetachedWorktreeOptions,
	callback: (worktree: ExperimentWorktree) => Promise<T> | T,
): Promise<T> {
	const worktree = openDetachedWorktree(options);
	let operationError: unknown;
	try {
		return await callback({ ref: worktree.ref, sha: worktree.sha, path: worktree.path });
	} catch (error) {
		operationError = error;
		throw error;
	} finally {
		try {
			worktree.close();
		} catch (cleanupError) {
			const errors = cleanupError instanceof AggregateError ? [...cleanupError.errors] : [cleanupError];
			throw new AggregateError(
				operationError === undefined ? errors : [operationError, ...errors],
				"failed to clean detached worktree",
			);
		}
	}
}

/** One detached worktree that outlives a single call. `close` is idempotent. */
export interface DetachedWorktreeHandle extends ExperimentWorktree {
	/** Remove the worktree and its temporary root. Safe to call more than once. */
	close(): void;
	/** False once `close` has removed it. */
	readonly open: boolean;
}

/**
 * The same detached worktree `withDetachedWorktree` scopes to one callback, held
 * open across several host operations — a Builder workshop lives for many tool
 * calls and must still leave the operator's checkout and `git worktree list`
 * exactly as it found them. The caller owns `close`.
 */
export function openDetachedWorktree(options: DetachedWorktreeOptions): DetachedWorktreeHandle {
	const repositoryDir = validateRepositoryDir(options.repositoryDir);
	validateRef(options.ref, "detached");
	const sha = resolveCommitRef(repositoryDir, options.ref);
	const temporaryRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
	assertSafeTemporaryRoot(temporaryRoot);
	const path = join(temporaryRoot, DETACHED_WORKTREE_NAME);
	let added = false;
	let closed = false;

	const close = (): void => {
		if (closed) return;
		closed = true;
		const cleanupErrors: unknown[] = [];
		cleanupWorktree(repositoryDir, temporaryRoot, path, added, cleanupErrors);
		try {
			git(repositoryDir, ["worktree", "prune"]);
		} catch (error) {
			cleanupErrors.push(error);
		}
		try {
			assertSafeTemporaryRoot(temporaryRoot);
			rmSync(temporaryRoot, { recursive: true, force: true });
		} catch (error) {
			cleanupErrors.push(error);
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, "failed to clean detached worktree");
		}
	};

	try {
		git(repositoryDir, ["worktree", "add", "--detach", path, sha]);
		added = true;
	} catch (error) {
		try {
			close();
		} catch (cleanupError) {
			const errors = cleanupError instanceof AggregateError ? [...cleanupError.errors] : [cleanupError];
			throw new AggregateError([error, ...errors], "failed to clean detached worktree");
		}
		throw error;
	}
	return {
		ref: options.ref,
		sha,
		path,
		close,
		get open() {
			return !closed;
		},
	};
}

export interface ReattachDetachedWorktreeOptions {
	repositoryDir: string;
	/** The recorded worktree path. Resolved and re-validated; never trusted. */
	path: string;
	/** The commit the worktree must still be detached at. */
	sha: string;
	/**
	 * Wraps every refusal, so a caller that reports its own error class keeps
	 * reporting it. Defaults to a plain `Error`.
	 */
	refuse?: (message: string, errorOptions?: ErrorOptions) => Error;
}

/**
 * The same handle `openDetachedWorktree` hands out, for a worktree this process
 * did not create — a Builder workshop a dead process left behind.
 *
 * Nothing recorded is trusted: the path must still carry the names this module
 * creates, the worktree must still belong to this repository, and it must still
 * be detached at the exact baseline commit. `--no-replace-objects` is not
 * decoration — a replace ref could make a different commit answer to that SHA.
 */
export function reattachDetachedWorktree(options: ReattachDetachedWorktreeOptions): DetachedWorktreeHandle {
	const refuse = options.refuse
		?? ((message: string, errorOptions?: ErrorOptions) => new Error(message, errorOptions));
	const repositoryDir = options.repositoryDir;
	const sha = options.sha;
	const path = realpathSync(resolve(options.path));
	const temporaryRoot = dirname(path);
	if (basename(path) !== DETACHED_WORKTREE_NAME || !basename(temporaryRoot).startsWith(TEMP_PREFIX)) {
		throw refuse(`refusing to re-attach an unexpected workshop worktree: ${path}`);
	}
	const read = (args: string[]): string => {
		try {
			return execFileSync("git", ["--no-replace-objects", "-C", path, ...args], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		} catch (error) {
			const stderr = typeof error === "object" && error !== null && "stderr" in error
				? String((error as { stderr?: unknown }).stderr).trim()
				: "";
			throw refuse(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, { cause: error });
		}
	};
	const commonDir = realpathSync(read(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
	if (commonDir !== realpathSync(join(repositoryDir, ".git"))) {
		throw refuse("the recorded workshop worktree does not belong to this repository");
	}
	if (read(["rev-parse", "--verify", "HEAD^{commit}"]) !== sha) {
		throw refuse("the recorded workshop worktree is no longer at its baseline commit");
	}
	let closed = false;
	return {
		ref: sha,
		sha,
		path,
		get open() {
			return !closed;
		},
		// Deliberately not `cleanupWorktree`: that path asserts the temporary root
		// is under `tmpdir()` as spelled, and a re-attached path has been through
		// `realpathSync` — on macOS `/var/…` becomes `/private/var/…` and the
		// assertion would refuse a root it created itself. The names were already
		// checked above. A refusal here is also softer: an error is only raised
		// when the worktree is still on disk afterwards.
		close() {
			if (closed) return;
			closed = true;
			const errors: unknown[] = [];
			try {
				execFileSync("git", ["-C", repositoryDir, "worktree", "remove", "--force", path], { stdio: "ignore" });
			} catch (error) {
				errors.push(error);
			}
			try {
				execFileSync("git", ["-C", repositoryDir, "worktree", "prune"], { stdio: "ignore" });
			} catch (error) {
				errors.push(error);
			}
			try {
				rmSync(temporaryRoot, { recursive: true, force: true });
			} catch (error) {
				errors.push(error);
			}
			if (errors.length > 0 && existsSync(path)) {
				throw new AggregateError(errors, "failed to clean the re-attached workshop worktree");
			}
		},
	};
}
