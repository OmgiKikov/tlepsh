import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The engine's store lives inside the Target, and it holds the sealed exam.
 *
 * Two rules keep it out of Git, and both are enforced where an operator would
 * otherwise find out too late: `.gitignore` is topped up wherever AHDE creates
 * or blesses a Target, and any path under `.ahde/` or `runs/` that is already
 * tracked is a refusal — by then the sealed corpus is a Git object, and the
 * only honest answer is to say which path and how to undo it.
 *
 * This module deliberately imports no AHDE service, so `src/manifest.ts` can
 * use it from `scaffoldTarget` without a cycle.
 */

/** One ignore rule: the concept it covers, and the lines that express it. */
interface LocalIgnoreEntry {
	/** The path, with leading/trailing slashes stripped — how presence is tested. */
	readonly token: string;
	readonly lines: readonly string[];
}

const LOCAL_ARTIFACT_IGNORE_HEADER =
	"# AHDE local state, Builder imports, run evidence, and secrets";

/**
 * The three the skill names — `.ahde/`, `runs/`, `imports/` — plus the dotenv
 * files a Target's credential lands in. Order is the order they are appended.
 */
const LOCAL_ARTIFACT_IGNORES: readonly LocalIgnoreEntry[] = [
	{ token: ".ahde", lines: ["/.ahde/"] },
	{ token: "imports", lines: ["/imports/"] },
	{ token: "runs", lines: ["/runs/"] },
	{ token: ".env", lines: ["/.env"] },
	// The negation belongs to the pattern it carves out, so they are added together.
	{ token: ".env.*", lines: ["/.env.*", "!/.env.example"] },
];

/**
 * What one `.gitignore` line claims to ignore. `runs/`, `/runs/`, `runs` and
 * `/runs` are the same rule, so a Target that already wrote any of them is left
 * alone. Comments and negations claim nothing.
 */
function ignoreToken(line: string): string | null {
	const text = line.trim();
	if (text.length === 0 || text.startsWith("#") || text.startsWith("!")) return null;
	const token = text.replace(/^\/+/, "").replace(/\/+$/, "");
	return token.length > 0 ? token : null;
}

/**
 * Top up the Target's `.gitignore` with any AHDE-local rule it is missing, and
 * report exactly the lines that were appended. Idempotent line by line: a
 * Target that already ignores `runs/` its own way keeps its own spelling.
 */
export function ensureLocalArtifactIgnores(targetDir: string): string[] {
	const path = join(targetDir, ".gitignore");
	let existing = "";
	if (existsSync(path)) {
		if (!lstatSync(path).isFile()) throw new Error("target .gitignore must be a regular file");
		existing = readFileSync(path, "utf8");
	}
	const present = new Set(
		existing.split("\n").map(ignoreToken).filter((token): token is string => token !== null),
	);
	const missing = LOCAL_ARTIFACT_IGNORES
		.filter((entry) => !present.has(entry.token))
		.flatMap((entry) => entry.lines);
	if (missing.length === 0) return [];
	const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
	writeFileSync(path, `${existing}${separator}${LOCAL_ARTIFACT_IGNORE_HEADER}\n${missing.join("\n")}\n`);
	return missing;
}

/** One line for the terminal, or null when the file already covered everything. */
export function renderLocalArtifactIgnoreLine(added: readonly string[]): string | null {
	if (added.length === 0) return null;
	return `.gitignore     added ${added.join(", ")}`;
}

/** The engine store, by the two roots a Target must never commit. */
export const ENGINE_STORE_PATHS: readonly string[] = [".ahde", "runs"];

/**
 * A sealed corpus that reached a Git object cannot be un-published; the only
 * thing left is to stop using the branch that carries it. Surfaced as `next:`.
 */
const ENGINE_STORE_NEXT =
	"git rm -r --cached .ahde runs and ignore them; sealed content must never enter a git object";

export class TargetStoreHygieneError extends Error {
	readonly name = "TargetStoreHygieneError";
	/** What the operator should do about it. Surfaced by the CLI as `next:`. */
	readonly next = ENGINE_STORE_NEXT;
	readonly trackedPaths: readonly string[];

	constructor(trackedPaths: readonly string[]) {
		const [first, ...rest] = trackedPaths;
		const more = rest.length === 0 ? "" : ` (and ${rest.length} more path${rest.length === 1 ? "" : "s"})`;
		super(
			`${first ?? ".ahde"} is tracked by git in the Target${more}; ` +
			".ahde/ and runs/ are the engine's store and hold the sealed exam",
		);
		this.trackedPaths = [...trackedPaths];
	}
}

/**
 * Paths under `.ahde/` or `runs/` that Git already tracks in this Target, in
 * Git's own order. A directory that is not a repository tracks nothing — the
 * check is about a commit that happened, never about whether Git is usable.
 */
export function trackedEngineStorePaths(targetDir: string): string[] {
	let raw: string;
	try {
		raw = execFileSync("git", ["-C", targetDir, "ls-files", "-z", "--", ...ENGINE_STORE_PATHS], {
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return [];
	}
	return raw.split("\0").filter((path) => path.length > 0);
}

/**
 * A refusal about the state of the operator's checkout, with the next step.
 * Surfaced by the CLI as `error:` plus `next:`.
 */
export class DirtyTargetTreeError extends Error {
	readonly name = "DirtyTargetTreeError";
	readonly next: string;

	constructor(message: string, next: string) {
		super(message);
		this.next = next;
	}
}

/**
 * Whether the checkout carries anything the recorded revision cannot name.
 * Deliberately the same question `gitSha()` in manifest.ts asks before it
 * appends `-dirty-<hash>`, so the two can never disagree about what dirty is —
 * untracked files included, because they are hashed into that suffix too.
 */
export function targetTreeIsDirty(repositoryDir: string): boolean {
	const status = execFileSync(
		"git",
		["-C", repositoryDir, "status", "--porcelain=v1", "--untracked-files=all"],
		{ encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
	);
	return status.trim().length > 0;
}

/**
 * Every command that binds work to an exact commit needs one to exist. A dirty
 * tree records its revision as `<sha>-dirty-<hash>`, which names no Git object,
 * so the refusal says that instead of letting a schema or `rev-parse` fail on a
 * string neither was given.
 */
export function assertCleanTargetTree(
	repositoryDir: string,
	reason: { because: string; next: string },
): void {
	if (!targetTreeIsDirty(repositoryDir)) return;
	throw new DirtyTargetTreeError(
		`the Target has uncommitted changes; ${reason.because}`,
		reason.next,
	);
}

/** Refuse a Target whose engine store is already inside a Git object. */
export function assertUntrackedEngineStore(targetDir: string): void {
	const tracked = trackedEngineStorePaths(targetDir);
	if (tracked.length === 0) return;
	throw new TargetStoreHygieneError(tracked);
}
