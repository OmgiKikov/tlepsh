import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	resolveCommitRef,
	withExperimentWorktrees,
} from "../src/git/experiment-worktree.js";

interface TestRepository {
	dir: string;
	baselineSha: string;
	candidateSha: string;
	branch: string;
}

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function createRepository(): TestRepository {
	const dir = mkdtempSync(join(tmpdir(), "ahde-worktree-test-"));
	git(dir, "init", "-q");
	git(dir, "config", "user.name", "AHDE Test");
	git(dir, "config", "user.email", "ahde-test@example.invalid");
	git(dir, "branch", "-M", "main");

	writeFileSync(join(dir, "AGENTS.md"), "baseline\n");
	git(dir, "add", "AGENTS.md");
	git(dir, "commit", "-qm", "baseline");
	const baselineSha = git(dir, "rev-parse", "HEAD");

	writeFileSync(join(dir, "AGENTS.md"), "candidate\n");
	git(dir, "add", "AGENTS.md");
	git(dir, "commit", "-qm", "candidate");
	const candidateSha = git(dir, "rev-parse", "HEAD");
	git(dir, "checkout", "-qb", "user-checkout");

	return { dir, baselineSha, candidateSha, branch: "user-checkout" };
}

function removeRepository(repository: TestRepository): void {
	rmSync(repository.dir, { recursive: true, force: true });
}

describe("experiment worktrees", () => {
	it("resolves exact commits, exposes detached worktrees, and never switches the user's checkout", async () => {
		const repository = createRepository();
		let baselinePath = "";
		let candidatePath = "";
		try {
			const originalBranch = git(repository.dir, "branch", "--show-current");
			const originalHead = git(repository.dir, "rev-parse", "HEAD");

			const result = await withExperimentWorktrees(
				{
					repositoryDir: repository.dir,
					baselineRef: repository.baselineSha.slice(0, 12),
					candidateRef: "user-checkout",
				},
				(worktrees) => {
					baselinePath = worktrees.baseline.path;
					candidatePath = worktrees.candidate.path;
					expect(worktrees.baseline.sha).toBe(repository.baselineSha);
					expect(worktrees.candidate.sha).toBe(repository.candidateSha);
					expect(git(baselinePath, "rev-parse", "HEAD")).toBe(repository.baselineSha);
					expect(git(candidatePath, "rev-parse", "HEAD")).toBe(repository.candidateSha);
					expect(git(baselinePath, "branch", "--show-current")).toBe("");
					expect(git(candidatePath, "branch", "--show-current")).toBe("");
					expect(git(repository.dir, "branch", "--show-current")).toBe(originalBranch);
					expect(git(repository.dir, "rev-parse", "HEAD")).toBe(originalHead);
					return "evaluated";
				},
			);

			expect(result).toBe("evaluated");
			expect(git(repository.dir, "branch", "--show-current")).toBe(originalBranch);
			expect(git(repository.dir, "rev-parse", "HEAD")).toBe(originalHead);
			expect(existsSync(baselinePath)).toBe(false);
			expect(existsSync(candidatePath)).toBe(false);
			expect(git(repository.dir, "worktree", "list", "--porcelain")).not.toContain(baselinePath);
			expect(git(repository.dir, "worktree", "list", "--porcelain")).not.toContain(candidatePath);
		} finally {
			removeRepository(repository);
		}
	});

	it("cleans both worktrees when the callback fails", async () => {
		const repository = createRepository();
		let baselinePath = "";
		let candidatePath = "";
		try {
			await expect(
				withExperimentWorktrees(
					{
						repositoryDir: repository.dir,
						baselineRef: repository.baselineSha,
						candidateRef: repository.candidateSha,
					},
					(worktrees) => {
						baselinePath = worktrees.baseline.path;
						candidatePath = worktrees.candidate.path;
						throw new Error("evaluation failed");
					},
				),
			).rejects.toThrow("evaluation failed");

			expect(existsSync(baselinePath)).toBe(false);
			expect(existsSync(candidatePath)).toBe(false);
			expect(git(repository.dir, "branch", "--show-current")).toBe(repository.branch);
			expect(git(repository.dir, "worktree", "list", "--porcelain")).not.toContain(baselinePath);
			expect(git(repository.dir, "worktree", "list", "--porcelain")).not.toContain(candidatePath);
		} finally {
			removeRepository(repository);
		}
	});

	it("rejects equal commits in candidate mode", async () => {
		const repository = createRepository();
		try {
			await expect(
				withExperimentWorktrees(
					{
						repositoryDir: repository.dir,
						baselineRef: repository.candidateSha,
						candidateRef: "HEAD",
					},
					() => undefined,
				),
			).rejects.toThrow("requires distinct baseline and candidate commits");
		} finally {
			removeRepository(repository);
		}
	});

	it("requires equal commits in A/A calibration mode", async () => {
		const repository = createRepository();
		try {
			await expect(
				withExperimentWorktrees(
					{
						repositoryDir: repository.dir,
						baselineRef: repository.baselineSha,
						candidateRef: repository.candidateSha,
						mode: "aa-calibration",
					},
					() => undefined,
				),
			).rejects.toThrow("aa-calibration requires baseline and candidate to resolve to the same commit");

			await expect(
				withExperimentWorktrees(
					{
						repositoryDir: repository.dir,
						baselineRef: repository.candidateSha,
						candidateRef: "HEAD",
						mode: "aa-calibration",
					},
					(worktrees) => worktrees.baseline.sha === worktrees.candidate.sha,
				),
			).resolves.toBe(true);
		} finally {
			removeRepository(repository);
		}
	});

	it("rejects a candidate that does not descend from baseline", async () => {
		const repository = createRepository();
		try {
			const tree = git(repository.dir, "rev-parse", `${repository.candidateSha}^{tree}`);
			const unrelatedSha = git(repository.dir, "commit-tree", tree, "-m", "unrelated root");

			await expect(
				withExperimentWorktrees(
					{
						repositoryDir: repository.dir,
						baselineRef: repository.baselineSha,
						candidateRef: unrelatedSha,
					},
					() => undefined,
				),
			).rejects.toThrow("candidate commit must descend from the baseline commit");
		} finally {
			removeRepository(repository);
		}
	});

	it("ignores dirty source state because experiments use exact committed refs", async () => {
		const repository = createRepository();
		try {
			writeFileSync(join(repository.dir, "uncommitted.txt"), "not evidence\n");

			await expect(
				withExperimentWorktrees(
					{
						repositoryDir: repository.dir,
						baselineRef: repository.baselineSha,
						candidateRef: repository.candidateSha,
					},
					(worktrees) => worktrees.candidate.sha,
				),
			).resolves.toBe(repository.candidateSha);
			expect(existsSync(join(repository.dir, "uncommitted.txt"))).toBe(true);
			expect(git(repository.dir, "branch", "--show-current")).toBe(repository.branch);
			expect(git(repository.dir, "worktree", "list", "--porcelain")).not.toContain("ahde-experiment-");
		} finally {
			removeRepository(repository);
		}
	});

	it("rejects refs that do not resolve to commits", () => {
		const repository = createRepository();
		try {
			expect(() => resolveCommitRef(repository.dir, "missing-ref")).toThrow(/rev-parse .* failed/);
		} finally {
			removeRepository(repository);
		}
	});
});
