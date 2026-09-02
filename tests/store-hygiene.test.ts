import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertCleanTargetTree,
	assertScaffoldableTargetLocation,
	assertUntrackedEngineStore,
	DirtyTargetTreeError,
	commitLocalArtifactIgnores,
	ensureLocalArtifactIgnores,
	operatorDirtyPaths,
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
 * `.gitignore` covers it, and Git does not already track it — asked of the
 * Target itself, and of the checkout a new Target would be scaffolded into.
 * The last rule here is the one that used to fail as raw plumbing: work bound
 * to an exact commit has none when the tree is dirty.
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

describe("commitLocalArtifactIgnores", () => {
	it("commits the lines it appended and nothing else, so the host never dirties the Target", () => {
		// The fixture is a committed repository already; only the operator's own
		// unfinished file is added on top of it.
		const dir = repoFixture();
		try {
			writeFileSync(join(dir, "notes.md"), "the operator's own unfinished work\n");
			const added = ensureLocalArtifactIgnores(dir);
			expect(commitLocalArtifactIgnores(dir, added)).toBe(true);
			expect(git(dir, "status", "--porcelain=v1", "--untracked-files=all")).toBe("?? notes.md");
			expect(git(dir, "log", "--format=%s", "-1")).toBe("chore(ahde): ignore the host's local state");
			expect(git(dir, "show", "--stat", "--format=", "HEAD")).toContain(".gitignore");
			expect(git(dir, "show", "--stat", "--format=", "HEAD")).not.toContain("notes.md");
			// Idempotent: nothing to add, nothing to commit.
			expect(commitLocalArtifactIgnores(dir, ensureLocalArtifactIgnores(dir))).toBe(false);
			expect(git(dir, "rev-list", "--count", "HEAD")).toBe("2");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves a Target outside Git as it is", () => {
		const dir = repoFixture();
		try {
			rmSync(join(dir, ".git"), { recursive: true, force: true });
			expect(commitLocalArtifactIgnores(dir, ensureLocalArtifactIgnores(dir))).toBe(false);
			expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("/.ahde/");
		} finally {
			rmSync(dir, { recursive: true, force: true });
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

describe("assertScaffoldableTargetLocation", () => {
	/**
	 * `ahde init <dir>` creates `<dir>`, so the refusal has to be asked of the
	 * checkout the scaffold would land in — the dir itself does not exist yet.
	 */
	it("refuses a scaffold inside a checkout that already committed the store", () => {
		const dir = repoFixture();
		try {
			mkdirSync(join(dir, "runs", "erun_1"), { recursive: true });
			writeFileSync(join(dir, "runs", "erun_1", "eval_run.json"), "{}\n");
			git(dir, "add", "-A");
			git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "oops");

			let thrown: unknown;
			try {
				assertScaffoldableTargetLocation(join(dir, "new-agent"));
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(TargetStoreHygieneError);
			expect((thrown as TargetStoreHygieneError).message).toContain("runs/erun_1/eval_run.json");
			expect((thrown as TargetStoreHygieneError).next).toContain("git rm -r --cached .ahde runs");
		} finally {
			cleanup(dir);
		}
	});

	it("allows a scaffold beside a clean checkout, and outside a repository", () => {
		const repo = repoFixture();
		const plain = makeTargetFixture([{ path: "AGENTS.md", content: AGENTS_MD }], false);
		try {
			expect(() => assertScaffoldableTargetLocation(join(repo, "new-agent"))).not.toThrow();
			expect(() => assertScaffoldableTargetLocation(join(plain, "new-agent"))).not.toThrow();
		} finally {
			cleanup(repo);
			cleanup(plain);
		}
	});
});

describe("assertCleanTargetTree", () => {
	it("accepts a clean tree", () => {
		const dir = repoFixture();
		try {
			expect(targetTreeIsDirty(dir)).toBe(false);
			expect(() => assertCleanTargetTree(dir, { because: "why", next: "how" })).not.toThrow();
		} finally {
			cleanup(dir);
		}
	});

	/**
	 * AHDE writes `.ahde/` and `runs/` into the Target itself, so a checkout
	 * that has not been told to ignore them yet is not the operator's dirt.
	 * `-z` is why: porcelain quotes any path that is not plain ASCII, and a
	 * quoted `"runs/…"` would otherwise read as somebody's own file.
	 */
	it("reads the operator's paths out of a porcelain status, host store excluded", () => {
		expect(operatorDirtyPaths("?? .ahde/\0?? runs/erun_1/eval_run.json\0")).toEqual([]);
		expect(operatorDirtyPaths(" M AGENTS.md\0?? runs/x\0?? tools/check_dbo/\0"))
			.toEqual(["AGENTS.md", "tools/check_dbo/"]);
		// A rename contributes both paths, so moving a real file into the store counts.
		expect(operatorDirtyPaths("R  runs/moved.md\0notes.md\0")).toEqual(["notes.md"]);
		expect(operatorDirtyPaths("?? runs/файл\0?? кейсы.md\0")).toEqual(["кейсы.md"]);
		expect(operatorDirtyPaths("")).toEqual([]);
		// The store never masks a path that only starts with the same letters.
		expect(operatorDirtyPaths("?? runsheet.md\0")).toEqual(["runsheet.md"]);
	});

	it("leaves an unignored engine store out of the dirty tree it refuses on", () => {
		const dir = repoFixture();
		try {
			mkdirSync(join(dir, ".ahde", "projects"), { recursive: true });
			writeFileSync(join(dir, ".ahde", "projects", "focus.json"), "{}\n");
			mkdirSync(join(dir, "runs", "erun_1"), { recursive: true });
			writeFileSync(join(dir, "runs", "erun_1", "eval_run.json"), "{}\n");
			expect(git(dir, "status", "--porcelain=v1", "--untracked-files=all")).not.toBe("");

			expect(targetTreeIsDirty(dir)).toBe(false);
			expect(() => assertCleanTargetTree(dir, { because: "why", next: "how" })).not.toThrow();
		} finally {
			cleanup(dir);
		}
	});

	it("says what a dirty tree stops, per command, with the operator's next step", () => {
		const dir = repoFixture();
		try {
			// An untracked file is a dirty tree: `gitSha` hashes it into the
			// revision. The improvement loop used to fail this as a regex on
			// `<sha>-dirty-<hash>`, which is easy to hit: `improve > improve.log`
			// inside the Target is itself the uncommitted file.
			writeFileSync(join(dir, "improve.log"), "AHDE improve cycle 1/2\n");
			let thrown: unknown;
			try {
				assertCleanTargetTree(dir, { because: "why", next: "how" });
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(DirtyTargetTreeError);
			const error = thrown as DirtyTargetTreeError;
			// The paths, because "commit them" is unactionable without them.
			expect(error.message).toBe("the Target has uncommitted changes (improve.log); why");
			expect(error.next).toBe("how");
			expect(targetTreeIsDirty(dir)).toBe(true);
		} finally {
			cleanup(dir);
		}
	});
});
