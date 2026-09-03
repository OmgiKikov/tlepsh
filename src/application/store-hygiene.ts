import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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
function readIgnoreFile(targetDir: string): string {
	const path = join(targetDir, ".gitignore");
	if (!existsSync(path)) return "";
	if (!lstatSync(path).isFile()) throw new Error("target .gitignore must be a regular file");
	return readFileSync(path, "utf8");
}

/**
 * Which lines `ensureLocalArtifactIgnores` WOULD add, without adding them. The
 * adopt path has to show the operator this list before it writes anything, and
 * computing it twice in two places is how the two would drift apart.
 */
export function missingLocalArtifactIgnores(targetDir: string): string[] {
	const present = new Set(
		readIgnoreFile(targetDir).split("\n").map(ignoreToken).filter((token): token is string => token !== null),
	);
	return LOCAL_ARTIFACT_IGNORES
		.filter((entry) => !present.has(entry.token))
		.flatMap((entry) => entry.lines);
}

export function ensureLocalArtifactIgnores(targetDir: string): string[] {
	const path = join(targetDir, ".gitignore");
	const existing = readIgnoreFile(targetDir);
	const missing = missingLocalArtifactIgnores(targetDir);
	if (missing.length === 0) return [];
	const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
	writeFileSync(path, `${existing}${separator}${LOCAL_ARTIFACT_IGNORE_HEADER}\n${missing.join("\n")}\n`);
	return missing;
}

/**
 * Commit the lines `ensureLocalArtifactIgnores` just appended, and nothing
 * else. A `.gitignore` the host wrote and left uncommitted is the host making
 * the Target dirty by its own hand: the first workshop then refuses on
 * "uncommitted changes: .gitignore" and the operator is sent to Git for a
 * file they never touched. Only that one path is committed, so the operator's
 * own uncommitted work is never swept into a host commit; a Target outside
 * Git, or one whose commit fails, is left as it is and the caller carries on.
 */
export function commitLocalArtifactIgnores(targetDir: string, added: readonly string[]): boolean {
	if (added.length === 0) return false;
	const git = (...args: string[]): string =>
		execFileSync("git", ["-C", targetDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	try {
		// The Target must be the root of its own repository: a checkout nested in
		// some other repository would otherwise receive a host commit it never
		// asked for, in a history that is not the Target's.
		if (git("rev-parse", "--is-inside-work-tree") !== "true") return false;
		if (realpathSync(git("rev-parse", "--show-toplevel")) !== realpathSync(targetDir)) return false;
		// The operator's identity when Git has one; the host's own otherwise.
		const identity = (() => {
			try {
				return git("config", "user.name") && git("config", "user.email") ? [] : null;
			} catch {
				return null;
			}
		})() ?? ["-c", "user.name=ahde", "-c", "user.email=ahde@local"];
		git("add", "--", ".gitignore");
		git(...identity, "commit", "-q", "-m", "chore(ahde): ignore the host's local state", "--", ".gitignore");
		return true;
	} catch {
		return false;
	}
}

/** One line for the terminal, or null when the file already covered everything. */
export function renderLocalArtifactIgnoreLine(added: readonly string[]): string | null {
	if (added.length === 0) return null;
	return `.gitignore     added ${added.join(", ")}`;
}

/** The engine store, by the two roots a Target must never commit. */
export const ENGINE_STORE_PATHS: readonly string[] = [".ahde", "runs"];

/** Whether one repository-relative path belongs to the engine's store. */
function inEngineStore(path: string): boolean {
	return ENGINE_STORE_PATHS.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * The paths in `git status --porcelain=v1 -z` that the OPERATOR owns.
 *
 * AHDE creates `.ahde/` and `runs/` inside the Target itself, so a Target
 * whose `.gitignore` does not name them yet is not a dirty checkout — it is a
 * checkout the host has not finished tidying, and no refusal about
 * uncommitted work may be built on it. `ensureLocalArtifactIgnores` writes
 * the rules; this makes every dirty check agree even before it has run, or
 * after an operator edits the file back.
 *
 * `-z` because porcelain quotes any other path that is not plain ASCII, and a
 * quoted `"runs/…"` would read as the operator's. A rename contributes both
 * of its paths, so moving a real file into the store still counts.
 */
export function operatorDirtyPaths(porcelain: string): string[] {
	const paths = porcelain
		.split("\0")
		.filter((field) => field.length > 0)
		// A rename's second field carries no `XY ` status prefix; it is a bare path.
		.map((field) => (/^[ MADRCU?!]{2} /.test(field) ? field.slice(3) : field))
		.filter((path) => !inEngineStore(path));
	return [...new Set(paths)].sort();
}

/** Git's exclusion of the same two roots, for commands that read the tree rather than its status. */
export const ENGINE_STORE_EXCLUDE: readonly string[] = ENGINE_STORE_PATHS.map((root) => `:(exclude)${root}`);

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
 * Everything in the checkout the recorded revision cannot name, host store
 * excluded. Deliberately the same question `gitSha()` in manifest.ts asks
 * before it appends `-dirty-<hash>`, so the two can never disagree about what
 * dirty is — untracked files included, because they are hashed into that
 * suffix too.
 */
export function dirtyTargetPaths(repositoryDir: string): string[] {
	const status = execFileSync(
		"git",
		["-C", repositoryDir, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
		{ encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
	);
	return operatorDirtyPaths(status);
}

export function targetTreeIsDirty(repositoryDir: string): boolean {
	return dirtyTargetPaths(repositoryDir).length > 0;
}

/** `AGENTS.md, tools/check_dbo` — at most four, so a refusal stays one sentence. */
export function namedDirtyPaths(paths: readonly string[]): string {
	const shown = paths.slice(0, 4).join(", ");
	return paths.length > 4 ? `${shown} (and ${paths.length - 4} more)` : shown;
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
	const dirty = dirtyTargetPaths(repositoryDir);
	if (dirty.length === 0) return;
	// Which files. An operator told only "uncommitted changes" cannot act on it,
	// and the answer is always to commit them — never to throw them away.
	throw new DirtyTargetTreeError(
		`the Target has uncommitted changes (${namedDirtyPaths(dirty)}); ${reason.because}`,
		reason.next,
	);
}

/** Refuse a Target whose engine store is already inside a Git object. */
export function assertUntrackedEngineStore(targetDir: string): void {
	const tracked = trackedEngineStorePaths(targetDir);
	if (tracked.length === 0) return;
	throw new TargetStoreHygieneError(tracked);
}

/**
 * The same refusal, asked before a Target exists.
 *
 * `ahde init` creates `destDir`, so there is nothing there to inspect yet; the
 * question is about the checkout it would be created in. A directory that
 * already committed an engine store would hand the new Target that store's
 * problem — the sealed exam is a Git object there, and a scaffold beside it
 * only adds a second one.
 */
export function assertScaffoldableTargetLocation(destDir: string): void {
	assertUntrackedEngineStore(dirname(resolve(destDir)));
}
