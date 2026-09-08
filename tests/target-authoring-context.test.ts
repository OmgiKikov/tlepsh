import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	classifyTargetAuthoringResourcePath,
	explainTargetAuthoringResourcePath,
	inspectTargetAuthoringContext,
	TargetAuthoringContextError,
	TARGET_AUTHORING_LIMITS,
	type TargetAuthoringContextErrorCode,
} from "../src/application/target-authoring-context.js";
import { createAhdeWorkbench } from "../src/workbench/workbench.js";
import { loadTarget } from "../src/manifest.js";
import { createBuilderWorkbenchTools } from "../src/builder/workbench-adapter.js";
import { WorkbenchSubmitToolSchema, WorkbenchViewToolSchema } from "../src/builder/workbench-transport.js";
import { loadBuilderCorpusDraft } from "../src/application/builder-corpus-draft.js";

const roots: string[] = [];
const AGENTS = "# Context Agent\n\nUse the declared search capability.\n";
const SKILL = "---\nname: search\ndescription: Search approved local evidence.\n---\n\n# Search\n\nCall the declared tool.\n";
const TOOL = `schemaVersion: 1
name: search
description: Search approved local evidence.
parameters:
  type: object
  properties:
    query:
      type: string
      minLength: 1
      maxLength: 200
  required: [query]
  additionalProperties: false
command:
  argv: [bin/search]
timeoutMs: 2000
maxOutputBytes: 8192
output: json
permissions:
  environment: [SEARCH_INDEX]
  network: deny
  filesystem: read-only
`;

function root(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	roots.push(path);
	return path;
}

function git(repositoryDir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repositoryDir, ...args], { encoding: "utf8" }).trim();
}

function manifest(skills = "[skills/search]", tools = "[tools/search.tool.yaml]"): string {
	return `id: context-agent
model:
  provider: fixture-provider
  id: fixture-model
  api: openai-completions
  baseUrl: https://private-model.invalid/v1
  apiKeyEnv: PRIVATE_MODEL_KEY
  thinkingLevel: medium
  timeoutMs: 30000
execution:
  tools: [read]
  environmentAllowlist: [SEARCH_INDEX]
  network: deny
  sandbox: best-effort
instructions:
  agentsMd: AGENTS.md
skills: ${skills}
tools: ${tools}
evalSuite:
  id: private-development
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`;
}

function commitFixture(options: {
	agents?: string | Buffer;
	manifest?: string;
	executableMode?: number;
	beforeCommit?: (repositoryDir: string) => void;
} = {}): { repositoryDir: string; gitSha: string } {
	const repositoryDir = root("ahde-target-authoring-context-");
	git(repositoryDir, "init", "-q");
	git(repositoryDir, "config", "user.name", "Context Fixture");
	git(repositoryDir, "config", "user.email", "context@example.test");
	mkdirSync(join(repositoryDir, "skills", "search"), { recursive: true });
	mkdirSync(join(repositoryDir, "tools"), { recursive: true });
	mkdirSync(join(repositoryDir, "bin"), { recursive: true });
	mkdirSync(join(repositoryDir, "evals"), { recursive: true });
	writeFileSync(join(repositoryDir, "manifest.yaml"), options.manifest ?? manifest());
	writeFileSync(join(repositoryDir, "AGENTS.md"), options.agents ?? AGENTS);
	writeFileSync(join(repositoryDir, "skills", "search", "SKILL.md"), SKILL);
	writeFileSync(join(repositoryDir, "tools", "search.tool.yaml"), TOOL);
	writeFileSync(join(repositoryDir, "bin", "search"), "#!/bin/sh\nprintf '{\"results\":[]}\\n'\n");
	chmodSync(join(repositoryDir, "bin", "search"), options.executableMode ?? 0o755);
	writeFileSync(join(repositoryDir, "evals", "development.jsonl"), `${JSON.stringify({
		id: "private-case",
		input: "DO NOT EXPOSE THIS EVAL INPUT",
		graders: [{ type: "output_contains", text: "private" }],
	})}\n`);
	writeFileSync(join(repositoryDir, "evals", "graders.yaml"), "defaults: []\n");
	writeFileSync(join(repositoryDir, ".env"), "PRIVATE_MODEL_KEY=never-expose\n");
	writeFileSync(join(repositoryDir, "undeclared.txt"), "AMBIENT SENTINEL\n");
	options.beforeCommit?.(repositoryDir);
	git(repositoryDir, "add", ".");
	git(repositoryDir, "commit", "-qm", "context fixture");
	return { repositoryDir, gitSha: git(repositoryDir, "rev-parse", "HEAD") };
}

function inspect(repositoryDir: string, gitSha: string, resourcePath?: string) {
	return inspectTargetAuthoringContext({
		repositoryDir,
		expectedTarget: { id: "context-agent", gitSha },
		...(resourcePath ? { resourcePath } : {}),
	});
}

function expectCode(action: () => unknown, code: TargetAuthoringContextErrorCode): void {
	try {
		action();
		throw new Error("expected TargetAuthoringContextError");
	} catch (error) {
		expect(error).toBeInstanceOf(TargetAuthoringContextError);
		expect((error as TargetAuthoringContextError).code).toBe(code);
		expect((error as Error).message).not.toMatch(/\/var\/|\/Users\/|PRIVATE_MODEL_KEY=|DO NOT EXPOSE/);
	}
}

function sha256(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

afterEach(() => {
	vi.unstubAllEnvs();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Target Authoring Context", () => {
	it("returns a deterministic sanitized overview and one exact declared resource", () => {
		const fixture = commitFixture();
		const overview = inspect(fixture.repositoryDir, fixture.gitSha);
		expect(overview).toMatchObject({
			schemaVersion: 1,
			algorithmId: "git-manifest-context-v1",
			target: {
				id: "context-agent",
				gitSha: fixture.gitSha,
				model: { provider: "fixture-provider", id: "fixture-model", thinkingLevel: "medium" },
				execution: {
					tools: ["read"],
					environmentAllowlist: ["SEARCH_INDEX"],
					network: "deny",
					sandbox: "best-effort",
				},
			},
			launch: "ahde target",
		});
		expect(overview.resources.map(({ kind, path, mode }) => ({ kind, path, mode }))).toEqual([
			{ kind: "instructions", path: "AGENTS.md", mode: "100644" },
			{ kind: "tool-executable", path: "bin/search", mode: "100755" },
			{ kind: "skill", path: "skills/search/SKILL.md", mode: "100644" },
			{ kind: "tool-descriptor", path: "tools/search.tool.yaml", mode: "100644" },
		]);
		expect(overview.resource).toBeUndefined();
		expect(overview.contextHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(overview.claim).toEqual({
			algorithmId: "git-manifest-context-v1",
			targetId: "context-agent",
			targetGitSha: fixture.gitSha,
			contextHash: overview.contextHash,
		});

		const exact = inspect(fixture.repositoryDir, fixture.gitSha, "AGENTS.md");
		expect(exact.contextHash).toBe(overview.contextHash);
		expect(exact.claim).toEqual(overview.claim);
		expect(exact.resource).toEqual({
			kind: "instructions",
			name: null,
			path: "AGENTS.md",
			mode: "100644",
			bytes: Buffer.byteLength(AGENTS),
			sha256: sha256(AGENTS),
			content: AGENTS,
		});

		const serialized = JSON.stringify(exact);
		for (const privateValue of [
			"private-model.invalid",
			"PRIVATE_MODEL_KEY",
			"DO NOT EXPOSE THIS EVAL INPUT",
			"AMBIENT SENTINEL",
			"manifest.yaml",
			".env",
		]) expect(serialized).not.toContain(privateValue);
	});

	it("projects and hashes the complete non-secret execution policy", () => {
		const strict = manifest().replace("  sandbox: best-effort\n", "  sandbox: required\n");
		const fixture = commitFixture({ manifest: strict });
		const overview = inspect(fixture.repositoryDir, fixture.gitSha);
		expect(overview.target.execution).toEqual({
			tools: ["read"],
			environmentAllowlist: ["SEARCH_INDEX"],
			network: "deny",
			sandbox: "required",
		});

		const changed = commitFixture({ manifest: strict.replace("  network: deny\n", "  network: allow\n") });
		expect(inspect(changed.repositoryDir, changed.gitSha).contextHash).not.toBe(overview.contextHash);
	});

	it("denies private, undeclared, absolute, and traversal reads through one non-oracle error", () => {
		const fixture = commitFixture();
		for (const path of [
			"manifest.yaml",
			".env",
			"evals/development.jsonl",
			"undeclared.txt",
			"skills/missing/SKILL.md",
			"../AGENTS.md",
			"/etc/passwd",
		]) expectCode(() => inspect(fixture.repositoryDir, fixture.gitSha, path), "TARGET_RESOURCE_DENIED");
	});

	it("fails closed on tracked dirt, untracked dirt, and a stale selected revision", () => {
		const tracked = commitFixture();
		writeFileSync(join(tracked.repositoryDir, "AGENTS.md"), "changed but uncommitted\n");
		expectCode(() => inspect(tracked.repositoryDir, tracked.gitSha), "TARGET_CONTEXT_DIRTY");

		const untracked = commitFixture();
		writeFileSync(join(untracked.repositoryDir, "scratch.txt"), "untracked\n");
		expectCode(() => inspect(untracked.repositoryDir, untracked.gitSha), "TARGET_CONTEXT_DIRTY");

		const stale = commitFixture();
		writeFileSync(join(stale.repositoryDir, "AGENTS.md"), `${AGENTS}\nNew committed behavior.\n`);
		git(stale.repositoryDir, "add", "AGENTS.md");
		git(stale.repositoryDir, "commit", "-qm", "new revision");
		expectCode(() => inspect(stale.repositoryDir, stale.gitSha), "TARGET_CONTEXT_STALE");
	});

	/**
	 * The host creates `.ahde/` and `runs/` inside the Target, so a checkout
	 * that has not been told to ignore them is not the operator's dirt. This is
	 * what refused the very first workshop of a freshly adopted Target.
	 */
	it("never counts the host's own store as the operator's uncommitted work", () => {
		const fixture = commitFixture();
		mkdirSync(join(fixture.repositoryDir, ".ahde", "projects"), { recursive: true });
		writeFileSync(join(fixture.repositoryDir, ".ahde", "projects", "focus.json"), "{}\n");
		mkdirSync(join(fixture.repositoryDir, "runs", "erun_1"), { recursive: true });
		writeFileSync(join(fixture.repositoryDir, "runs", "erun_1", "eval_run.json"), "{}\n");
		expect(git(fixture.repositoryDir, "status", "--porcelain=v1", "--untracked-files=all")).not.toBe("");

		expect(inspect(fixture.repositoryDir, fixture.gitSha).target.id).toBe("context-agent");

		// A real stray file is still a refusal, and it says which one to commit.
		writeFileSync(join(fixture.repositoryDir, "notes.md"), "operator work\n");
		try {
			inspect(fixture.repositoryDir, fixture.gitSha);
			throw new Error("expected TargetAuthoringContextError");
		} catch (error) {
			expect((error as TargetAuthoringContextError).code).toBe("TARGET_CONTEXT_DIRTY");
			expect((error as Error).message).toBe("Target has uncommitted changes: notes.md. Commit them, then author.");
		}
	});

	it("reads the named commit bytes even when a replacement ref targets another commit", () => {
		const fixture = commitFixture();
		const replacementAgents = "# Replacement instructions\n\nThese bytes must not enter the exact context.\n";
		writeFileSync(join(fixture.repositoryDir, "AGENTS.md"), replacementAgents);
		git(fixture.repositoryDir, "add", "AGENTS.md");
		git(fixture.repositoryDir, "commit", "-qm", "replacement commit");
		const replacementSha = git(fixture.repositoryDir, "rev-parse", "HEAD");
		git(fixture.repositoryDir, "reset", "--hard", fixture.gitSha);
		git(fixture.repositoryDir, "replace", fixture.gitSha, replacementSha);

		expect(git(fixture.repositoryDir, "show", `${fixture.gitSha}:AGENTS.md`)).toContain("Replacement instructions");
		const exact = inspect(fixture.repositoryDir, fixture.gitSha, "AGENTS.md");
		expect(exact.resource?.content).toBe(AGENTS);
		expect(exact.resource?.sha256).toBe(sha256(AGENTS));
	});

	it("rejects Git symlink resources without following them", () => {
		const repositoryDir = root("ahde-target-authoring-symlink-");
		git(repositoryDir, "init", "-q");
		git(repositoryDir, "config", "user.name", "Context Fixture");
		git(repositoryDir, "config", "user.email", "context@example.test");
		mkdirSync(join(repositoryDir, "evals"), { recursive: true });
		writeFileSync(join(repositoryDir, "manifest.yaml"), manifest("[]", "[]"));
		writeFileSync(join(repositoryDir, "private-instructions.txt"), "private\n");
		symlinkSync("private-instructions.txt", join(repositoryDir, "AGENTS.md"));
		git(repositoryDir, "add", ".");
		git(repositoryDir, "commit", "-qm", "symlink fixture");
		const gitSha = git(repositoryDir, "rev-parse", "HEAD");
		expectCode(() => inspect(repositoryDir, gitSha), "TARGET_RESOURCE_SYMLINK");
	});

	it("rejects malformed UTF-8 and oversized resources without truncation", () => {
		const malformed = commitFixture({ agents: Buffer.from([0xc3, 0x28]) });
		expectCode(() => inspect(malformed.repositoryDir, malformed.gitSha), "TARGET_RESOURCE_INVALID_UTF8");

		const oversized = commitFixture({ agents: Buffer.alloc((512 * 1024) + 1, 0x61) });
		expectCode(() => inspect(oversized.repositoryDir, oversized.gitSha), "TARGET_RESOURCE_TOO_LARGE");
	});

	it("rejects noncanonical declarations and non-executable declared tools", () => {
		const unsafe = commitFixture({ manifest: manifest("[../private-skill]", "[tools/search.tool.yaml]") });
		expectCode(() => inspect(unsafe.repositoryDir, unsafe.gitSha), "TARGET_CONTEXT_INVALID");

		const wrongMode = commitFixture({ executableMode: 0o644 });
		expectCode(() => inspect(wrongMode.repositoryDir, wrongMode.gitSha), "TARGET_CONTEXT_INVALID");
	});

	it("projects the same safe context through Workbench without leaking local paths", async () => {
		const fixture = commitFixture();
		const stateRoot = root("ahde-target-context-state-");
		const runsRoot = root("ahde-target-context-runs-");
		const workbench = createAhdeWorkbench({
			projectDir: fixture.repositoryDir,
			stateRoot,
			runsRoot,
			projectId: "context-agent",
		});
		const overview = await workbench.view({ aspect: "target" });
		expect(overview.detail?.content).toMatchObject({
			algorithmId: "git-manifest-context-v1",
			target: { id: "context-agent", gitSha: fixture.gitSha },
			launch: "ahde target",
		});
		expect(JSON.stringify(overview.detail)).not.toContain(fixture.repositoryDir);

		const resource = await workbench.view({ aspect: "target", resourcePath: "AGENTS.md" });
		expect(resource.detail?.aspect).toBe("target");
		expect((resource.detail?.content as { resource?: unknown }).resource).toMatchObject({ path: "AGENTS.md", content: AGENTS });
		await expect(workbench.view({ aspect: "summary", resourcePath: "AGENTS.md" })).rejects.toThrow(
			/resourcePath is valid only for the Target and dataset views/,
		);
	});
});

/**
 * The shipped command Target: a Python agent whose manifest declares
 * `harness: { files: [prompts/**] }`. Its editable surface is a prompt file,
 * not `AGENTS.md`, and until the read side learned to say so its Builder was
 * being asked to fix a file it could not open.
 */
const PYTHON_AGENT = fileURLToPath(new URL("../templates/python-agent", import.meta.url));

function commandTargetFixture(): { repositoryDir: string; gitSha: string; id: string } {
	const repositoryDir = root("ahde-declared-harness-");
	cpSync(PYTHON_AGENT, repositoryDir, { recursive: true });
	git(repositoryDir, "init", "-q");
	git(repositoryDir, "config", "user.name", "Declared Fixture");
	git(repositoryDir, "config", "user.email", "declared@example.test");
	git(repositoryDir, "add", "-A");
	git(repositoryDir, "commit", "-qm", "the shipped python agent");
	const target = loadTarget(repositoryDir);
	return { repositoryDir, gitSha: target.gitSha, id: target.manifest.id };
}

describe("a Target that declares its own harness surface", () => {
	it("exposes the declared prompt as a resource the Builder can read", () => {
		const fixture = commandTargetFixture();
		const overview = inspectTargetAuthoringContext({
			repositoryDir: fixture.repositoryDir,
			expectedTarget: { id: fixture.id, gitSha: fixture.gitSha },
		});
		expect(overview.resources.map(({ kind, path, mode }) => ({ kind, path, mode }))).toEqual([
			{ kind: "instructions", path: "AGENTS.md", mode: "100644" },
			{ kind: "tool-executable", path: "bin/create_ticket", mode: "100755" },
			{ kind: "tool-executable", path: "bin/get_account", mode: "100755" },
			{ kind: "harness-file", path: "prompts/system.md", mode: "100644" },
			{ kind: "tool-descriptor", path: "tools/create_ticket.tool.yaml", mode: "100644" },
			{ kind: "tool-descriptor", path: "tools/get_account.tool.yaml", mode: "100644" },
		]);
		// A declared file is named by its own path: the surface is declared by
		// glob, so the path is the only name it has.
		expect(overview.resources.find((resource) => resource.kind === "harness-file")?.name).toBe("prompts/system.md");
		// The overview stays shape-only; a selected KB read is not a writable resource.
		expect(overview.data.map((directory) => directory.path)).toEqual(["data/kb"]);

		const exact = inspectTargetAuthoringContext({
			repositoryDir: fixture.repositoryDir,
			expectedTarget: { id: fixture.id, gitSha: fixture.gitSha },
			resourcePath: "prompts/system.md",
		});
		expect(exact.contextHash).toBe(overview.contextHash);
		expect(exact.resource).toMatchObject({ kind: "harness-file", path: "prompts/system.md" });
		expect(exact.resource?.content).toContain("Волна");
	});

	it("still refuses the operator's own code, the evidence, and the manifest", () => {
		const fixture = commandTargetFixture();
		const read = (resourcePath: string) => () => inspectTargetAuthoringContext({
			repositoryDir: fixture.repositoryDir,
			expectedTarget: { id: fixture.id, gitSha: fixture.gitSha },
			resourcePath,
		});
		// `agent.py` is the operator's program, not the harness — that is the
		// whole point of a declared surface.
		for (const path of [
			"agent.py",
			"README.md",
			"manifest.yaml",
			"evals/development.jsonl",
			"prompts/../agent.py",
		]) expectCode(read(path), "TARGET_RESOURCE_DENIED");
	});

	it("refuses a declared file the surface cannot hold in one bounded context", () => {
		const fixture = commandTargetFixture();
		writeFileSync(join(fixture.repositoryDir, "prompts", "huge.md"), "x".repeat(513 * 1024));
		git(fixture.repositoryDir, "add", "-A");
		git(fixture.repositoryDir, "commit", "-qm", "an oversize declared file");
		const gitSha = git(fixture.repositoryDir, "rev-parse", "HEAD");
		expectCode(
			() => inspectTargetAuthoringContext({
				repositoryDir: fixture.repositoryDir,
				expectedTarget: { id: fixture.id, gitSha },
			}),
			"TARGET_RESOURCE_TOO_LARGE",
		);
	});
});

describe("read-only KB context for an open development basket", () => {
	const document = "# Refund policy\n\nThe refund window is 30 days.\n";
	const path = "data/kb/public/policy.md";
	function fixture(content: string | Buffer = document, declarations = "[data/kb/public]") {
		return commitFixture({
			manifest: `${manifest()}data: ${declarations}\n`,
			beforeCommit(repositoryDir) {
				for (const [name, bytes] of [
					[path, content],
					["data/kb/public/guide.txt", "Use the published policy.\n"],
					["data/kb/private/hidden.md", "PRIVATE-KB-SENTINEL\n"],
					["data/fixtures/world.md", "PRIVATE-WORLD-SENTINEL\n"],
				] as const) {
					mkdirSync(join(repositoryDir, name, ".."), { recursive: true });
					writeFileSync(join(repositoryDir, name), bytes);
				}
			},
		});
	}

	it("reads complete exact Git text/hash while keeping the overview and writable closure unchanged", () => {
		const { repositoryDir, gitSha } = fixture();
		const overview = inspect(repositoryDir, gitSha);
		const selected = inspect(repositoryDir, gitSha, path);
		expect(selected.resource).toEqual({
			kind: "knowledge", readOnly: true, name: null, path, mode: "100644",
			content: document, bytes: Buffer.byteLength(document), sha256: sha256(document),
		});
		expect(overview.resource).toBeUndefined();
		expect(JSON.stringify(overview)).not.toContain("The refund window");
		expect(selected.resources).toEqual(overview.resources);
		expect(selected.resources.some((resource) => resource.path.startsWith("data/"))).toBe(false);
		expect(selected.claim).toEqual(overview.claim);
		// The same classifier is used by compilation; a read cannot mint write authority.
		expect(classifyTargetAuthoringResourcePath(path, ["**"])).toBeNull();
		expect(inspect(repositoryDir, gitSha, "data/kb/public/guide.txt").resource?.content).toContain("published policy");
		expect(git(repositoryDir, "status", "--porcelain=v1")).toBe("");
		expect(git(repositoryDir, "rev-parse", "HEAD")).toBe(gitSha);
		expect(readFileSync(join(repositoryDir, path), "utf8")).toBe(document);
		for (const hidden of ["PRIVATE-KB-SENTINEL", "PRIVATE-WORLD-SENTINEL", "never-expose", "DO NOT EXPOSE"]) {
			expect(JSON.stringify(selected)).not.toContain(hidden);
		}
	});

	it("denies sibling KB, general data, hidden/eval paths and traversal even beneath a declaration", () => {
		const { repositoryDir, gitSha } = fixture();
		for (const denied of [
			"data/kb/private/hidden.md", "data/fixtures/world.md", ".env", "data/kb/public/.env",
			"evals/development.jsonl", "data/kb/public/evals/cases.md", "data/kb/public/imports/trace.txt",
			"data/kb/public/runs/state.md", "data/kb/public/.ahde/case.md", "data/kb/public/.hidden/note.md",
			"data/kb/public/manual.pdf", "data/kb/public/config.json", "data/kb/public",
			"../data/kb/public/policy.md", "data/kb/public/../private/hidden.md", "data/kb/public//policy.md",
			"data/kb/public/./policy.md", "data/kb/public/%2e%2e/policy.md", "data\\kb\\public\\policy.md",
			"data/kb/public/policy.md\0", "/etc/passwd",
		]) expectCode(() => inspect(repositoryDir, gitSha, denied), "TARGET_RESOURCE_DENIED");
		// A data/kbx or data/fixtures declaration does not activate KB reading.
		const notKb = fixture(document, "[data/fixtures]");
		expectCode(() => inspect(notKb.repositoryDir, notKb.gitSha, path), "TARGET_RESOURCE_DENIED");
	});

	it.each(["dataset", "graders"])("denies a manifest's %s file even if placed inside the declared KB", (field) => {
		const source = fixture();
		const yaml = readFileSync(join(source.repositoryDir, "manifest.yaml"), "utf8")
			.replace(new RegExp(`  ${field}: [^\\n]+`), `  ${field}: ./data/kb/public/extra/../policy.md`);
		writeFileSync(join(source.repositoryDir, "manifest.yaml"), yaml);
		git(source.repositoryDir, "add", "manifest.yaml");
		git(source.repositoryDir, "commit", "-qm", "move evaluation declaration into KB");
		expectCode(() => inspect(source.repositoryDir, git(source.repositoryDir, "rev-parse", "HEAD"), path), "TARGET_RESOURCE_DENIED");
	});

	it("rejects dirty or stale KB reads and reads commit bytes rather than ignored worktree replacements", () => {
		const source = fixture();
		writeFileSync(join(source.repositoryDir, path), "uncommitted replacement\n");
		expectCode(() => inspect(source.repositoryDir, source.gitSha, path), "TARGET_CONTEXT_DIRTY");
		git(source.repositoryDir, "add", path);
		git(source.repositoryDir, "commit", "-qm", "updated KB");
		expectCode(() => inspect(source.repositoryDir, source.gitSha, path), "TARGET_CONTEXT_STALE");
		const revision = git(source.repositoryDir, "rev-parse", "HEAD");
		// Even a worktree change hidden from status cannot change the bytes read.
		git(source.repositoryDir, "update-index", "--assume-unchanged", path);
		writeFileSync(join(source.repositoryDir, path), "not the committed document\n");
		expect(inspect(source.repositoryDir, revision, path).resource?.content).toBe("uncommitted replacement\n");
	});

	it.each(["file", "ancestor"])("rejects a KB Git symlink at the %s without following it", (kind) => {
		const source = fixture();
		const linked = "data/kb/public/link";
		symlinkSync(kind === "file" ? "../../private/hidden.md" : "../private", join(source.repositoryDir, kind === "file" ? `${linked}.md` : linked));
		git(source.repositoryDir, "add", ".");
		git(source.repositoryDir, "commit", "-qm", "KB symlink");
		expectCode(() => inspect(source.repositoryDir, git(source.repositoryDir, "rev-parse", "HEAD"),
			kind === "file" ? `${linked}.md` : `${linked}/hidden.md`), "TARGET_RESOURCE_SYMLINK");
	});

	it("refuses oversized, invalid UTF-8 and executable KB files without truncation", () => {
		const exact = fixture(`${"x".repeat(1023)}\n`.repeat(TARGET_AUTHORING_LIMITS.knowledgeBytes / 1024));
		expect(inspect(exact.repositoryDir, exact.gitSha, path).resource?.bytes).toBe(TARGET_AUTHORING_LIMITS.knowledgeBytes);
		const huge = fixture(Buffer.alloc(TARGET_AUTHORING_LIMITS.knowledgeBytes + 1, 0x61));
		expectCode(() => inspect(huge.repositoryDir, huge.gitSha, path), "TARGET_RESOURCE_TOO_LARGE");
		const longLine = fixture("x".repeat(TARGET_AUTHORING_LIMITS.knowledgeLineChars + 1));
		expectCode(() => inspect(longLine.repositoryDir, longLine.gitSha, path), "TARGET_RESOURCE_TOO_LARGE");
		const invalid = fixture(Buffer.from([0xc3, 0x28]));
		expectCode(() => inspect(invalid.repositoryDir, invalid.gitSha, path), "TARGET_RESOURCE_INVALID_UTF8");
		chmodSync(join(exact.repositoryDir, path), 0o755);
		git(exact.repositoryDir, "add", path);
		git(exact.repositoryDir, "commit", "-qm", "executable KB");
		expectCode(() => inspect(exact.repositoryDir, git(exact.repositoryDir, "rev-parse", "HEAD"), path), "TARGET_CONTEXT_INVALID");
	});

	it.each([
		"token=private-value-never-return\n", "Bearer abcdef0123456789abcdef\n",
		"-----BEGIN PRIVATE KEY-----\nprivate-value-never-return\n-----END PRIVATE KEY-----\n",
		"A leaked host credential: opaque-host-credential.\n", "\u001b]52;c;c2VjcmV0\u0007\n",
	])("refuses credential/control-bearing KB text before it crosses into a tool result", (content) => {
		vi.stubEnv("PRIVATE_MODEL_KEY", "opaque-host-credential");
		const source = fixture(content);
		expectCode(() => inspect(source.repositoryDir, source.gitSha, path), "TARGET_RESOURCE_DENIED");
	});

	it.each([
		{ role: "tool", name: "SEARCH_INDEX", value: "r8L4z2Q9m5V7x1C6" },
		{ role: "execution", name: "KB_EXECUTION_ONLY", value: "n3F6w9D2s7J4b8P5" },
		{ role: "model", name: "PRIVATE_MODEL_KEY", value: "h5T1y8A3c6R9v2M7" },
	])("refuses bare opaque $role environment values in an actual KB read without exposing the value", ({ name, value }) => {
		vi.stubEnv("SEARCH_INDEX", "r8L4z2Q9m5V7x1C6");
		vi.stubEnv("KB_EXECUTION_ONLY", "n3F6w9D2s7J4b8P5");
		vi.stubEnv("PRIVATE_MODEL_KEY", "h5T1y8A3c6R9v2M7");
		// An ambient variable that was not declared must not enter the scan.
		vi.stubEnv("KB_UNDECLARED_HOST_VALUE", document);
		const content = `A bare value: ${value}\n`;
		const source = commitFixture({
			manifest: `${manifest().replace("environmentAllowlist: [SEARCH_INDEX]", "environmentAllowlist: [SEARCH_INDEX, KB_EXECUTION_ONLY]")}data: [data/kb/public]\n`,
			beforeCommit(repositoryDir) {
				mkdirSync(join(repositoryDir, "data/kb/public"), { recursive: true });
				writeFileSync(join(repositoryDir, path), content);
				writeFileSync(join(repositoryDir, "data/kb/public/benign.md"), document);
			},
		});
		// SEARCH_INDEX is a tool dependency permitted by execution, not a model key.
		expect(process.env[name]).toBe(value);
		let refused: unknown;
		try {
			inspect(source.repositoryDir, source.gitSha, path);
		} catch (error) {
			refused = error;
		}
		expect(refused).toBeInstanceOf(TargetAuthoringContextError);
		expect(refused).toMatchObject({
			code: "TARGET_RESOURCE_DENIED",
			message: "KB text contains credential-shaped content or terminal controls; it cannot enter authoring context.",
		});
		expect(`${String(refused)} ${JSON.stringify(refused)} ${(refused as Error).stack}`).not.toContain(value);
		expect(readFileSync(join(source.repositoryDir, path), "utf8")).toBe(content);
		const benign = inspect(source.repositoryDir, source.gitSha, "data/kb/public/benign.md");
		expect(benign.resource).toMatchObject({ content: document, sha256: sha256(document), bytes: Buffer.byteLength(document) });
		expect(JSON.stringify(benign)).not.toContain(value);
	});

	it("delivers the source through registered Builder tools and saves an explicit open draft without running or publishing", async () => {
		const { repositoryDir, gitSha } = fixture();
		const stateRoot = root("ahde-kb-draft-state-");
		const runsRoot = root("ahde-kb-draft-runs-");
		const runSuite = vi.fn(() => { throw new Error("authoring must not execute the Target"); });
		const workbench = createAhdeWorkbench({ projectDir: repositoryDir, stateRoot, runsRoot, projectId: "context-agent", dependencies: { runSuite } });
		const spec = await workbench.submit({
			kind: "spec-draft",
			spec: {
				schemaVersion: 1, title: "Policy assistant", purpose: "Answer from the declared KB",
				users: ["customers"], jobs: ["Explain refund policy"], inputs: ["Questions"],
				allowedActions: ["Read KB"], successCriteria: ["State the published refund window"],
				constraints: ["Do not invent policy"], openQuestions: ["Exceptions are not documented"],
			},
		});
		await workbench.decide({ kind: "approve-spec", draftSpecId: String(spec.artifact?.id), reason: "Approve fixture requirements" }, {
			confirm: async () => ({ approved: true, actorId: "local:test" }),
			selectSealed: async () => ({ approved: false }),
		});
		const tools = createBuilderWorkbenchTools(workbench, () => "local:test");
		const view = tools.find((tool) => tool.name === "ahde_workbench_view")!;
		const submit = tools.find((tool) => tool.name === "ahde_workbench_submit")!;
		const host = {} as ExtensionContext;
		const overview = await view.execute("index", { aspect: "target" }, undefined, undefined, host);
		const index = overview.content[0];
		if (index?.type !== "text") throw new Error("expected model-facing JSON");
		const directory = JSON.parse(index.text).detail.content.data[0];
		expect(directory.entries).toContain("policy.md");
		expect(index.text).not.toContain("The refund window");
		const result = await view.execute("kb", WorkbenchViewToolSchema.prepare({ aspect: "target", resourcePath: path }), undefined, undefined, host);
		const text = result.content[0];
		if (text?.type !== "text") throw new Error("expected model-facing JSON");
		const context = JSON.parse(text.text).detail.content;
		expect(context.resource).toMatchObject({ kind: "knowledge", readOnly: true, path, content: document, sha256: sha256(document) });
		expect(context.target.gitSha).toBe(gitSha);
		for (const hidden of [repositoryDir, "PRIVATE-KB-SENTINEL", "PRIVATE-WORLD-SENTINEL", "never-expose", "DO NOT EXPOSE"]) {
			expect(text.text).not.toContain(hidden);
		}
		const expected = /window is ([^.]+)/.exec(context.resource.content)?.[1];
		expect(expected).toBe("30 days");
		const source = `${path}@${gitSha} ${context.resource.sha256}`;
		const authored = await submit.execute("draft", WorkbenchSubmitToolSchema.prepare({
			kind: "corpus-draft", name: "KB-sourced development cases",
			tasks: [{ input: "What is the refund window?", expected,
				metadata: { source, rationale: "Read the published refund window; author claim, not verified grounding" },
				graders: [{ type: "exact" }] }],
			coverageNotes: ["Synthetic question from a declared source", "Exceptions remain unresolved; no scored exception case"],
			revisionSummary: "Draft from committed KB text",
		}), undefined, undefined, host);
		const saved = authored.content[0];
		if (saved?.type !== "text") throw new Error("expected draft tool result");
		const draftId = JSON.parse(saved.text).artifact.id;
		const draft = loadBuilderCorpusDraft(stateRoot, "context-agent", draftId);
		expect(draft.tasks[0]?.expected).toBe(expected);
		expect(draft.tasks[0]?.metadata?.source).toBe(source);
		expect(draft.coverageNotes).toContain("Exceptions remain unresolved; no scored exception case");
		expect((await workbench.view()).counts).toMatchObject({ corpusDrafts: 1, developmentCorpora: 0, sealedCorpora: 0, developmentEvals: 0 });
		expect(runSuite).not.toHaveBeenCalled();
		expect(git(repositoryDir, "status", "--porcelain=v1")).toBe("");
		expect(git(repositoryDir, "rev-parse", "HEAD")).toBe(gitSha);
		expect(existsSync(join(repositoryDir, "data/kb/public/new.md"))).toBe(false);
	});
});

describe("the canonical resource rules say themselves", () => {
	it("explains every shape a refusal can be about, and only for paths that are refused", () => {
		// Each sentence names the rule the path broke. They live next to the
		// expressions that enforce them; this is the test that they say the same.
		expect(explainTargetAuthoringResourcePath("skills/bank_knowledge/SKILL.md"))
			.toBe("a skill is skills/<name>/SKILL.md with <name> in lowercase kebab-case (skills/bank-knowledge/SKILL.md), and the file is spelled exactly SKILL.md");
		expect(explainTargetAuthoringResourcePath("skills/Bank Knowledge/skill.md")).toContain("(skills/bank-knowledge/SKILL.md)");
		expect(explainTargetAuthoringResourcePath("tools/CheckDbo/tool.yaml")).toContain("<name> matches [a-z][a-z0-9_]*");
		expect(explainTargetAuthoringResourcePath("bin/Check-DBO")).toBe("a tool executable is bin/<name>, where <name> matches [a-z][a-z0-9_]*");
		expect(explainTargetAuthoringResourcePath("data/Bank Facts/notes.md")).toContain("data/<name>/…");
		expect(explainTargetAuthoringResourcePath("Agents.md")).toBe("the instructions file is spelled exactly AGENTS.md");
		expect(explainTargetAuthoringResourcePath("README.md")).toContain("a Harness holds only AGENTS.md");

		// And every path the sentences are about is one the classifier refuses.
		for (const path of [
			"skills/bank_knowledge/SKILL.md",
			"skills/Bank Knowledge/skill.md",
			"tools/CheckDbo/tool.yaml",
			"bin/Check-DBO",
			"Agents.md",
			"README.md",
		]) expect(classifyTargetAuthoringResourcePath(path)).toBeNull();
		expect(classifyTargetAuthoringResourcePath("skills/bank-knowledge/SKILL.md")).toMatchObject({ kind: "skill", name: "bank-knowledge" });
		expect(classifyTargetAuthoringResourcePath("bin/check_dbo")).toMatchObject({ kind: "tool-executable", name: "check_dbo" });
	});

	it("refuses a declared surface in the words of its own declaration", () => {
		const declared = ["prompts/**"];
		// The Pi sentence is true of the Pi layout and useless to an agent whose
		// behaviour lives in prompts/, so the refusal names what this one declares.
		expect(explainTargetAuthoringResourcePath("README.md", declared))
			.toBe("the harness declares prompts/**; a Harness also holds AGENTS.md, skills/<name>/SKILL.md, tools/<name>/…, bin/<name> and data/<name>/…");
		// A canonical shape still gets the precise canonical sentence.
		expect(explainTargetAuthoringResourcePath("bin/Check-DBO", declared))
			.toBe("a tool executable is bin/<name>, where <name> matches [a-z][a-z0-9_]*");
		// And the Pi default is byte for byte the sentence it always was.
		expect(explainTargetAuthoringResourcePath("README.md"))
			.toBe(explainTargetAuthoringResourcePath("README.md", ["AGENTS.md", "skills/**", "tools/**", "bin/**"]));
	});

	it("classifies a declared file, and only for a Target that declares one", () => {
		expect(classifyTargetAuthoringResourcePath("prompts/system.md", ["prompts/**"]))
			.toEqual({ kind: "harness-file", name: "prompts/system.md", modes: ["100644"] });
		// The Pi default adds nothing: under it, a noncanonical path stays refused.
		expect(classifyTargetAuthoringResourcePath("prompts/system.md")).toBeNull();
		expect(classifyTargetAuthoringResourcePath("skills/x/notes.md", ["AGENTS.md", "skills/**", "tools/**", "bin/**"])).toBeNull();
		// Canonical identity wins over a declaration that also covers the path.
		expect(classifyTargetAuthoringResourcePath("AGENTS.md", ["AGENTS.md", "prompts/**"]))
			.toMatchObject({ kind: "instructions", name: null });
		// Host-owned, evidence, traversal and hidden paths are never harness files.
		for (const path of ["manifest.yaml", "evals/development.jsonl", "data/kb/x.md", "prompts/../agent.py", "prompts/.env"]) {
			expect(classifyTargetAuthoringResourcePath(path, ["**"]), path).toBeNull();
		}
	});
});
