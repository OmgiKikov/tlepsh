import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	inspectTargetAuthoringContext,
	TargetAuthoringContextError,
	type TargetAuthoringContextErrorCode,
} from "../src/application/target-authoring-context.js";
import { createAhdeWorkbench } from "../src/workbench/workbench.js";

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
