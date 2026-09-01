import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertCleanProposalBaseline,
	BranchProposalError,
} from "../src/application/branch-proposal.js";
import {
	assertCleanTargetTree,
	assertUntrackedEngineStore,
	DirtyTargetTreeError,
	ensureLocalArtifactIgnores,
	renderLocalArtifactIgnoreLine,
	targetTreeIsDirty,
	TargetStoreHygieneError,
	trackedEngineStorePaths,
} from "../src/application/store-hygiene.js";
import { scaffoldTarget } from "../src/manifest.js";
import { AGENTS_MD, cleanup, makeTargetFixture } from "./fixtures.js";

/**
 * The engine store lives inside the Target and holds the sealed exam, so two
 * things have to be true before any command that a promotion later rests on:
 * `.gitignore` covers it, and Git does not already track it. The third rule
 * here is the one that used to fail as raw plumbing — a proposal is a diff
 * against a commit, and a dirty tree has no commit to be a diff against.
 */

const ALL_IGNORE_LINES = ["/.ahde/", "/imports/", "/runs/", "/.env", "/.env.*", "!/.env.example"];

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function repoFixture(gitignore?: string): string {
	return makeTargetFixture([
		{ path: "AGENTS.md", content: AGENTS_MD },
		...(gitignore === undefined ? [] : [{ path: ".gitignore", content: gitignore }]),
	]);
}

describe("ensureLocalArtifactIgnores", () => {
	it("writes every AHDE rule into a Target that has no .gitignore at all", () => {
		const dir = repoFixture();
		try {
			expect(ensureLocalArtifactIgnores(dir)).toEqual(ALL_IGNORE_LINES);
			expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(
				"# AHDE local state, Builder imports, run evidence, and secrets\n" +
					`${ALL_IGNORE_LINES.join("\n")}\n`,
			);
			// Idempotent: a second call has nothing to add and rewrites nothing.
			expect(ensureLocalArtifactIgnores(dir)).toEqual([]);
		} finally {
			cleanup(dir);
		}
	});

	it("tops up only the missing rules and keeps the Target's own spelling", () => {
		// `runs/` and `.ahde` without slashes are the same rules, differently written.
		const dir = repoFixture("runs/\n.ahde\nattempts.tsv\n");
		try {
			expect(ensureLocalArtifactIgnores(dir)).toEqual(["/imports/", "/.env", "/.env.*", "!/.env.example"]);
			const written = readFileSync(join(dir, ".gitignore"), "utf8");
			expect(written.startsWith("runs/\n.ahde\nattempts.tsv\n")).toBe(true);
			expect(written).not.toContain("/runs/");
			expect(written).not.toContain("/.ahde/");
		} finally {
			cleanup(dir);
		}
	});

	it("never reads a comment or a negation as coverage", () => {
		const dir = repoFixture("# runs/\n!imports/keep.jsonl\n");
		try {
			expect(ensureLocalArtifactIgnores(dir)).toEqual(ALL_IGNORE_LINES);
		} finally {
			cleanup(dir);
		}
	});

	it("names what it added, and says nothing when it added nothing", () => {
		expect(renderLocalArtifactIgnoreLine(["/runs/"])).toBe(".gitignore     added /runs/");
		expect(renderLocalArtifactIgnoreLine([])).toBeNull();
	});

	it("is applied by scaffoldTarget before the first commit, and reported to its caller", () => {
		const template = makeTargetFixture([
			{ path: "manifest.yaml", content: "id: t\n" },
			{ path: "AGENTS.md", content: AGENTS_MD },
		]);
		const dest = join(template, "..", `ahde-scaffold-${Date.now()}`);
		let added: readonly string[] = [];
		try {
			scaffoldTarget(template, dest, (lines) => { added = lines; });
			expect(added).toEqual(ALL_IGNORE_LINES);
			// The rules are in the scaffold commit, not merely in the working tree.
			expect(git(dest, "ls-files", "--", ".gitignore")).toBe(".gitignore");
		} finally {
			cleanup(template);
			cleanup(dest);
		}
	});
});

describe("assertUntrackedEngineStore", () => {
	it("passes on a Target whose store was never committed", () => {
		const dir = repoFixture();
		try {
			mkdirSync(join(dir, ".ahde", "projects"), { recursive: true });
			writeFileSync(join(dir, ".ahde", "projects", "state.json"), "{}\n");
			expect(trackedEngineStorePaths(dir)).toEqual([]);
			expect(() => assertUntrackedEngineStore(dir)).not.toThrow();
		} finally {
			cleanup(dir);
		}
	});

	it("refuses by name once sealed content is inside a Git object", () => {
		const dir = repoFixture();
		try {
			mkdirSync(join(dir, ".ahde", "projects", "p", "corpora"), { recursive: true });
			writeFileSync(join(dir, ".ahde", "projects", "p", "corpora", "corpus.jsonl"), "{}\n");
			mkdirSync(join(dir, "runs", "erun_1"), { recursive: true });
			writeFileSync(join(dir, "runs", "erun_1", "eval_run.json"), "{}\n");
			git(dir, "add", "-A");
			git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "oops");

			expect(trackedEngineStorePaths(dir)).toEqual([
				".ahde/projects/p/corpora/corpus.jsonl",
				"runs/erun_1/eval_run.json",
			]);
			let thrown: unknown;
			try {
				assertUntrackedEngineStore(dir);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(TargetStoreHygieneError);
			const error = thrown as TargetStoreHygieneError;
			expect(error.message).toContain(".ahde/projects/p/corpora/corpus.jsonl");
			expect(error.message).toContain("(and 1 more path)");
			expect(error.next).toBe(
				"git rm -r --cached .ahde runs and ignore them; sealed content must never enter a git object",
			);
		} finally {
			cleanup(dir);
		}
	});

	it("treats a directory that is not a repository as tracking nothing", () => {
		const dir = makeTargetFixture([{ path: "AGENTS.md", content: AGENTS_MD }], false);
		try {
			expect(trackedEngineStorePaths(dir)).toEqual([]);
		} finally {
			cleanup(dir);
		}
	});
});

describe("assertCleanProposalBaseline", () => {
	it("accepts a clean tree and a committed evidence revision", () => {
		const dir = repoFixture();
		try {
			expect(() => assertCleanProposalBaseline(dir, "a".repeat(40))).not.toThrow();
		} finally {
			cleanup(dir);
		}
	});

	it("refuses uncommitted changes in words, with the operator's next step", () => {
		const dir = repoFixture();
		try {
			// An untracked file is a dirty tree: `gitSha` hashes it into the revision.
			writeFileSync(join(dir, "run.log"), "eval run erun_1\n");
			let thrown: unknown;
			try {
				assertCleanProposalBaseline(dir);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(DirtyTargetTreeError);
			const error = thrown as DirtyTargetTreeError;
			expect(error.message).toBe(
				"the Target has uncommitted changes; a proposal compiles only against a clean committed baseline",
			);
			expect(error.next).toBe("commit or stash them, then run ahde propose again");
		} finally {
			cleanup(dir);
		}
	});

	it("refuses evidence recorded on a dirty tree, naming the revision that is not a commit", () => {
		const dir = repoFixture();
		try {
			const dirty = `${"a".repeat(40)}-dirty-bf3db8dbd147`;
			expect(() => assertCleanProposalBaseline(dir, dirty)).toThrow(BranchProposalError);
			expect(() => assertCleanProposalBaseline(dir, dirty)).toThrow(new RegExp(dirty));
			expect(() => assertCleanProposalBaseline(dir, dirty))
				.toThrow(/a proposal compiles only against a clean committed baseline/);
		} finally {
			cleanup(dir);
		}
	});

	it("says what a dirty tree stops, per command", () => {
		const dir = repoFixture();
		try {
			writeFileSync(join(dir, "improve.log"), "AHDE improve cycle 1/2\n");
			// The improvement loop used to fail this as a regex on
			// `<sha>-dirty-<hash>`, which is easy to hit: `improve > improve.log`
			// inside the Target is itself the uncommitted file.
			expect(() => assertCleanTargetTree(dir, { because: "why", next: "how" }))
				.toThrow("the Target has uncommitted changes; why");
			expect(targetTreeIsDirty(dir)).toBe(true);
		} finally {
			cleanup(dir);
		}
	});
});
