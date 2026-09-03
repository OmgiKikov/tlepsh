import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectAgentFolder } from "../src/application/agent-folder-detect.js";
import { assertAdoptableRepository } from "../src/application/target-bootstrap.js";
import {
	applyTargetWrap,
	describeTargetWrap,
	TargetScaffoldReceiptSchema,
} from "../src/application/target-scaffold.js";
import { executionKindOf, harnessFilesOf } from "../src/manifest.js";
import { hashValue } from "../src/provenance.js";

/**
 * The door: `ahde` in a folder that already holds an agent.
 *
 * The promise being tested is narrow and total — AHDE writes the four files it
 * said it would write, commits them, records a receipt that names the exact
 * revision, and touches nothing the operator wrote.
 */

const roots: string[] = [];

function agentFolder(options: { git?: boolean; extra?: Record<string, string> } = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "ahde-wrap-"));
	roots.push(dir);
	const files: Record<string, string> = {
		"agent.py": "import openai\n\n@tool\ndef lookup(): ...\n",
		"prompts/system.md": "Ты агент поддержки.\n",
		"README.md": "# my agent\n",
		...options.extra,
	};
	for (const [path, content] of Object.entries(files)) {
		const absolute = join(dir, path);
		mkdirSync(join(absolute, ".."), { recursive: true });
		writeFileSync(absolute, content, "utf8");
	}
	if (options.git !== false) {
		execFileSync("git", ["-C", dir, "init", "-q"]);
		execFileSync("git", ["-C", dir, "add", "."]);
		execFileSync("git", [
			"-C", dir,
			"-c", "user.name=test", "-c", "user.email=test@test",
			"commit", "-qm", "the operator's own first commit",
		]);
		execFileSync("git", ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-q", "--allow-empty", "-m", "and a second"]);
	}
	return dir;
}

function stateRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "ahde-wrap-state-"));
	roots.push(dir);
	return dir;
}

function wrapOptions(projectDir: string) {
	const found = detectAgentFolder(projectDir);
	if (!found) throw new Error("fixture is not an agent folder");
	return { projectDir, found, argv: ["python3", "agent.py"], harnessFiles: ["prompts/**"] };
}

function git(dir: string, args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("adopting a folder that already holds an agent", () => {
	it("describes exactly the files it will create, and creates only those", () => {
		const dir = agentFolder();
		const before = git(dir, ["rev-parse", "HEAD"]);
		const subject = describeTargetWrap(wrapOptions(dir));
		expect(subject.schemaVersion).toBe(2);
		expect(subject.operation).toBe("adopt-current-directory");
		expect(subject.found?.entry).toBe("agent.py");
		expect(subject.templateFiles.map((file) => file.path)).toEqual([
			"AGENTS.md",
			"evals/development.jsonl",
			"evals/graders.yaml",
			"manifest.yaml",
		]);
		expect(subject.generated.gitRepository).toBe("the existing clean repository, at its current HEAD");
		// Describing is pure: nothing on disk moved.
		expect(existsSync(join(dir, "manifest.yaml"))).toBe(false);
		expect(git(dir, ["rev-parse", "HEAD"])).toBe(before);

		const result = applyTargetWrap({
			...wrapOptions(dir),
			stateRoot: stateRoot(),
			expectedSubjectHash: hashValue(subject),
			actor: { kind: "human", id: "operator" },
			reason: "adopted the existing agent in this folder",
		});
		expect(executionKindOf(result.target.manifest.execution)).toBe("command");
		expect(result.target.manifest.execution.command?.argv).toEqual(["python3", "agent.py"]);
		expect(harnessFilesOf(result.target.manifest)).toEqual(["prompts/**"]);
		// The operator's sources are byte-identical.
		expect(readFileSync(join(dir, "agent.py"), "utf8")).toContain("import openai");
		expect(readFileSync(join(dir, "prompts/system.md"), "utf8")).toBe("Ты агент поддержки.\n");
		// Exactly one new commit, containing exactly the generated paths.
		expect(git(dir, ["rev-parse", "HEAD^"])).toBe(before);
		expect(git(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).split("\n").sort()).toEqual([
			".gitignore",
			"AGENTS.md",
			"evals/development.jsonl",
			"evals/graders.yaml",
			"manifest.yaml",
		]);
		expect(git(dir, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
	});

	it("writes a receipt that binds the exact subject and the exact revision", () => {
		const dir = agentFolder();
		const state = stateRoot();
		const options = wrapOptions(dir);
		const subject = describeTargetWrap(options);
		const result = applyTargetWrap({
			...options,
			stateRoot: state,
			expectedSubjectHash: hashValue(subject),
			actor: { kind: "human", id: "operator" },
			reason: "adopted the existing agent in this folder",
		});
		const persisted = TargetScaffoldReceiptSchema.parse(JSON.parse(readFileSync(result.receiptPath, "utf8")));
		expect(persisted.subject.operation).toBe("adopt-current-directory");
		expect(persisted.targetGitSha).toBe(git(dir, ["rev-parse", "HEAD"]));
		expect(persisted.id).toMatch(/^target-scaffold-[0-9a-f]{64}$/);
		// Replay is refused by the receipt, not by the name collision it would
		// also hit: the reason this fails is that the folder was already adopted.
		expect(() => applyTargetWrap({
			...options,
			stateRoot: state,
			expectedSubjectHash: hashValue(subject),
			actor: { kind: "human", id: "operator" },
			reason: "again",
		})).toThrow(/receipt already exists/);
	});

	it("initializes a repository when the folder is not one, with one commit", () => {
		const dir = agentFolder({ git: false });
		const subject = describeTargetWrap(wrapOptions(dir));
		expect(subject.generated.gitRepository).toBe("fresh repository with one scaffold commit");
		const result = applyTargetWrap({
			...wrapOptions(dir),
			stateRoot: stateRoot(),
			expectedSubjectHash: hashValue(subject),
			actor: { kind: "human", id: "operator" },
			reason: "adopted the existing agent in this folder",
		});
		expect(git(dir, ["rev-list", "--count", "HEAD"])).toBe("1");
		expect(result.target.gitSha).toBe(git(dir, ["rev-parse", "HEAD"]));
	});

	it("refuses a name collision before it writes a single byte", () => {
		const dir = agentFolder({ extra: { "evals/development.jsonl": "{}\n" } });
		expect(() => describeTargetWrap(wrapOptions(dir))).toThrow(/would overwrite an existing evals\/development\.jsonl/);
		expect(existsSync(join(dir, "manifest.yaml"))).toBe(false);
	});

	it("keeps an AGENTS.md the operator already wrote", () => {
		const dir = agentFolder({ extra: { "AGENTS.md": "# мой файл\n" } });
		const subject = describeTargetWrap(wrapOptions(dir));
		expect(subject.templateFiles.map((file) => file.path)).not.toContain("AGENTS.md");
		applyTargetWrap({
			...wrapOptions(dir),
			stateRoot: stateRoot(),
			expectedSubjectHash: hashValue(subject),
			actor: { kind: "human", id: "operator" },
			reason: "adopted the existing agent in this folder",
		});
		expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("# мой файл\n");
	});

	it("refuses a dirty repository, because a receipt would name a revision that is not on disk", () => {
		const dir = agentFolder();
		writeFileSync(join(dir, "agent.py"), "import openai\n# uncommitted\n", "utf8");
		const subject = describeTargetWrap(wrapOptions(dir));
		expect(() => applyTargetWrap({
			...wrapOptions(dir),
			stateRoot: stateRoot(),
			expectedSubjectHash: hashValue(subject),
			actor: { kind: "human", id: "operator" },
			reason: "adopted the existing agent in this folder",
		})).toThrow(/requires a clean repository/);
		expect(existsSync(join(dir, "manifest.yaml"))).toBe(false);
	});

	it("refuses a subject that changed after review", () => {
		const dir = agentFolder();
		const subject = describeTargetWrap(wrapOptions(dir));
		expect(() => applyTargetWrap({
			...wrapOptions(dir),
			// A different editable surface is a different subject.
			harnessFiles: ["docs/*.md"],
			stateRoot: stateRoot(),
			expectedSubjectHash: hashValue(subject),
			actor: { kind: "human", id: "operator" },
			reason: "adopted the existing agent in this folder",
		})).toThrow(/subject changed after review/);
	});
});

describe("bootstrapping an adopted Target", () => {
	it("accepts a history longer than one commit, at the exact adopted revision", () => {
		const dir = agentFolder();
		const subject = describeTargetWrap(wrapOptions(dir));
		const result = applyTargetWrap({
			...wrapOptions(dir),
			stateRoot: stateRoot(),
			expectedSubjectHash: hashValue(subject),
			actor: { kind: "human", id: "operator" },
			reason: "adopted the existing agent in this folder",
		});
		expect(Number(git(dir, ["rev-list", "--count", "HEAD"]))).toBeGreaterThan(1);
		expect(assertAdoptableRepository(resolve(dir), result.target.gitSha)).toEqual({
			baseTargetSha: result.target.gitSha,
			headRef: git(dir, ["symbolic-ref", "-q", "HEAD"]),
		});
	});

	it("refuses any revision but the one the receipt recorded", () => {
		const dir = agentFolder();
		const subject = describeTargetWrap(wrapOptions(dir));
		const result = applyTargetWrap({
			...wrapOptions(dir),
			stateRoot: stateRoot(),
			expectedSubjectHash: hashValue(subject),
			actor: { kind: "human", id: "operator" },
			reason: "adopted the existing agent in this folder",
		});
		execFileSync("git", [
			"-C", dir,
			"-c", "user.name=test", "-c", "user.email=test@test",
			"commit", "-q", "--allow-empty", "-m", "the operator kept working",
		]);
		expect(() => assertAdoptableRepository(resolve(dir), result.target.gitSha))
			.toThrow(/only on the exact adopted revision the receipt recorded/);
	});

	it("refuses a dirty tree and a detached HEAD", () => {
		const dir = agentFolder();
		const subject = describeTargetWrap(wrapOptions(dir));
		const result = applyTargetWrap({
			...wrapOptions(dir),
			stateRoot: stateRoot(),
			expectedSubjectHash: hashValue(subject),
			actor: { kind: "human", id: "operator" },
			reason: "adopted the existing agent in this folder",
		});
		writeFileSync(join(dir, "README.md"), "# changed\n", "utf8");
		expect(() => assertAdoptableRepository(resolve(dir), result.target.gitSha)).toThrow(/clean repository/);
		execFileSync("git", ["-C", dir, "checkout", "-q", "--", "README.md"]);
		execFileSync("git", ["-C", dir, "checkout", "-q", "--detach", "HEAD"]);
		expect(() => assertAdoptableRepository(resolve(dir), result.target.gitSha)).toThrow(/detached HEAD|local branch/);
	});
});

describe("what the adopted folder already carries", () => {
	it("declares the tool descriptors and data directories found on disk, and nothing else", () => {
		const dir = agentFolder({
			git: false,
			extra: {
				"tools/get_account.tool.yaml": readFileSync("templates/python-agent/tools/get_account.tool.yaml", "utf8"),
				"bin/get_account": readFileSync("templates/python-agent/bin/get_account", "utf8"),
				// A tool written in the agent's own language is the operator's code, not a descriptor.
				"tools/helpers.py": "def lookup(): ...\n",
				"tools/lookup/tool.yaml": readFileSync("templates/python-agent/tools/get_account.tool.yaml", "utf8")
					.replace("name: get_account", "name: lookup")
					.replace("argv: [bin/get_account]", "argv: [tools/lookup/run]"),
				"tools/lookup/run": readFileSync("templates/python-agent/bin/get_account", "utf8"),
				"data/kb/tariffs.md": "# Тарифы\n",
				"data/Bad Name/x.md": "not a declarable directory\n",
			},
		});
		for (const executable of ["bin/get_account", "tools/lookup/run"]) chmodSync(join(dir, executable), 0o755);
		execFileSync("git", ["-C", dir, "init", "-q"]);
		execFileSync("git", ["-C", dir, "add", "."]);
		execFileSync("git", ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "the operator's agent"]);

		const subject = describeTargetWrap(wrapOptions(dir));
		const manifestText = subject.templateFiles.find((file) => file.path === "manifest.yaml");
		expect(manifestText).toBeDefined();
		const result = applyTargetWrap({
			...wrapOptions(dir),
			stateRoot: stateRoot(),
			expectedSubjectHash: hashValue(subject),
			actor: { kind: "human", id: "operator" },
			reason: "adopted the existing agent in this folder",
		});
		expect(result.target.manifest.tools).toEqual(["tools/get_account.tool.yaml", "tools/lookup/tool.yaml"]);
		expect(result.target.manifest.data).toEqual(["data/kb"]);
		expect(result.target.tools.map((tool) => tool.descriptor.name).sort()).toEqual(["get_account", "lookup"]);
	});
});
