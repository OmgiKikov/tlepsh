import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	classifyTargetAuthoringResourcePath,
	explainTargetAuthoringResourcePath,
	inspectTargetAuthoringContext,
	TargetAuthoringContextError,
	type TargetAuthoringContextErrorCode,
} from "../src/application/target-authoring-context.js";
import { createAhdeWorkbench } from "../src/workbench/workbench.js";
import { loadTarget } from "../src/manifest.js";

const roots: string[] = [];
const CONTAINER_DIGEST = "a".repeat(64);
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

	it("projects and hashes the complete non-secret pinned container policy", () => {
		const withContainer = manifest().replace(
			"  sandbox: best-effort\n",
			`  sandbox: required
  container:
    runtime: docker
    image: ahde/context@sha256:${CONTAINER_DIGEST}
    platform: linux/amd64
    memoryMb: 1536
    cpus: 1.25
    pidsLimit: 96
    readOnlyRootfs: true
`,
		);
		const fixture = commitFixture({ manifest: withContainer });
		const overview = inspect(fixture.repositoryDir, fixture.gitSha);
		expect(overview.target.execution).toEqual({
			tools: ["read"],
			environmentAllowlist: ["SEARCH_INDEX"],
			network: "deny",
			sandbox: "required",
			container: {
				runtime: "docker",
				image: `ahde/context@sha256:${CONTAINER_DIGEST}`,
				platform: "linux/amd64",
				memoryMb: 1536,
				cpus: 1.25,
				pidsLimit: 96,
				readOnlyRootfs: true,
			},
		});

		const changed = commitFixture({ manifest: withContainer.replace("memoryMb: 1536", "memoryMb: 2048") });
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
		// Declared data stays shape-only, exactly as for a Pi Target.
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
			"data/kb/tariffs.md",
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
