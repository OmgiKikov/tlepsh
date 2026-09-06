import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface GitOptions {
	env?: NodeJS.ProcessEnv;
	maxBuffer?: number;
	/** Fed to stdin; without it stdin is closed. */
	input?: string;
}

/** Git never asks a question and never sees a replaced object, whatever the operator's config says. */
export function gitEnvironment(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_MERGE_AUTOEDIT: "no",
	};
}

/** Raw stdout of one git command in `repositoryDir`. Failures throw execFileSync's own error. */
export function git(repositoryDir: string, args: readonly string[], options: GitOptions = {}): Buffer {
	return execFileSync("git", ["--no-replace-objects", "-C", repositoryDir, ...args], {
		stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		maxBuffer: options.maxBuffer ?? MAX_OUTPUT_BYTES,
		env: options.env,
		input: options.input,
	});
}

/** Trimmed UTF-8 stdout of one git command. */
export function gitText(repositoryDir: string, args: readonly string[], options: GitOptions = {}): string {
	return git(repositoryDir, args, options).toString("utf8").trim();
}

/** execFileSync's failure restated as the command and whatever git said on stderr. */
export function gitFailure(args: readonly string[], error: unknown): Error {
	const stderr = typeof error === "object" && error !== null && "stderr" in error
		? String((error as { stderr?: unknown }).stderr).trim()
		: "";
	return new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, { cause: error });
}

/** Why `input` is not a worktree root: not a regular directory, or a directory below the root. */
export class NotWorktreeRootError extends Error {
	constructor(readonly reason: "directory" | "root", readonly path: string) {
		super(reason === "directory"
			? `targetDir must be a regular non-symlink directory: ${path}`
			: `targetDir must be the Git worktree root: ${path}`);
		this.name = "NotWorktreeRootError";
	}
}

/**
 * The canonical path of `input` when it is a regular non-symlink directory that
 * is itself the root of a Git worktree. `run` reads `rev-parse`, so a module
 * that wraps Git failures in its own error keeps doing so.
 */
export function worktreeRoot(
	input: string,
	run: (repositoryDir: string, args: string[]) => string = gitText,
): string {
	const requested = resolve(input);
	const entry = lstatSync(requested);
	if (!entry.isDirectory() || entry.isSymbolicLink()) throw new NotWorktreeRootError("directory", requested);
	const canonical = realpathSync(requested);
	const top = realpathSync(run(canonical, ["rev-parse", "--show-toplevel"]));
	if (top !== canonical) throw new NotWorktreeRootError("root", canonical);
	return canonical;
}
