import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AHDE_BUILDER_BUILTIN_COMMANDS,
	AHDE_BUILDER_PREFERRED_EXTENSION_COMMANDS,
	buildBuilderPiArgs,
	launchBuilderPi,
	resolveBuilderAssets,
	validateBuilderPiArgs,
} from "../src/builder/runtime.js";

const roots: string[] = [];

function root(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	roots.push(path);
	return path;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Builder Pi runtime", () => {
	it("uses only the packaged prompt and four explicit Builder skills", () => {
		const assets = resolveBuilderAssets();
		expect(assets.systemPrompt).toContain("Builder Pi and Target Pi are separate trust domains");
		expect(assets.skillPaths).toHaveLength(4);
		expect(assets.skillPaths.map((path) => path.split("/").at(-2))).toEqual([
			"design-agent",
			"design-evals",
			"run-diagnose",
			"improve-harness",
		]);
		const args = buildBuilderPiArgs({ assets, sessionDir: "/private/sessions", piArgs: ["--thinking", "high"] });
		expect(args).toEqual(expect.arrayContaining([
			"--no-builtin-tools",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--no-prompt-templates",
			"--no-themes",
			"--system-prompt",
			"--thinking",
			"high",
		]));
		expect(args.filter((value) => value === "--skill")).toHaveLength(4);
		expect(args).not.toEqual(expect.arrayContaining(["bash", "edit", "write", "read"]));
	});

	it("rejects arguments that could reopen ambient resources or arbitrary files", () => {
		for (const args of [
			["--extension", "/tmp/evil.ts"],
			["--skill=/tmp/evil"],
			["--system-prompt", "replace"],
			["--tools", "bash"],
			["--session", "/tmp/ambient.jsonl"],
			["--continue"],
			["--resume", "old-session"],
			["--fork", "old-session"],
			["--models"],
			["--export", "/tmp/export.html"],
			["--approve"],
			["@.env"],
		]) {
			expect(() => validateBuilderPiArgs(args)).toThrow();
		}
		expect(validateBuilderPiArgs(["--model", "provider/model", "hello"])).toEqual([
			"--model",
			"provider/model",
			"hello",
		]);
	});

	it("adds resume only through the host-controlled private session mode", () => {
		const assets = resolveBuilderAssets();
		const resumed = buildBuilderPiArgs({
			assets,
			sessionDir: "/private/sessions",
			sessionMode: "resume",
		});
		expect(resumed).toContain("--resume");
		expect(() => buildBuilderPiArgs({
			assets,
			sessionDir: "/private/sessions",
			piArgs: ["--resume"],
		})).toThrow(/controlled by AHDE/);
	});

	it("launches Pi main with isolated config/session roots and one inline trusted extension", async () => {
		const projectDir = root("ahde-builder-launch-");
		const stateRoot = join(projectDir, ".private-ahde");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		const previousCwd = process.cwd();
		const observed: Record<string, unknown> = {};
		const main = vi.fn(async (args, options) => {
			observed.args = args;
			observed.options = options;
			observed.cwd = process.cwd();
			observed.agentDir = process.env.PI_CODING_AGENT_DIR;
			observed.sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		});

		await launchBuilderPi({
			projectDir,
			stateRoot,
			runsRoot: join(projectDir, "evidence"),
			projectId: "demo",
			piArgs: ["--thinking", "medium"],
			main,
		});

		expect(observed.cwd).toBe(realpathSync(projectDir));
		expect(observed.agentDir).toBe(realpathSync(resolve(stateRoot, "builder-pi", "config")));
		expect(observed.sessionDir).toBe(realpathSync(resolve(stateRoot, "builder-pi", "sessions")));
		expect(existsSync(observed.agentDir as string)).toBe(true);
		expect(existsSync(observed.sessionDir as string)).toBe(true);
		expect(observed.args).toEqual(expect.arrayContaining(["--no-builtin-tools", "--no-extensions", "--no-skills"]));
		const mainOptions = observed.options as {
			extensionFactories: { name: string; factory: unknown }[];
			allowedBuiltinCommands: readonly string[];
			preferredExtensionCommands: readonly string[];
			allowBash: boolean;
			resumeHint: string | false;
		};
		const factories = mainOptions.extensionFactories;
		expect(factories).toHaveLength(1);
		expect(factories[0]).toMatchObject({ name: "ahde-builder" });
		expect(typeof factories[0]?.factory).toBe("function");
		expect(mainOptions.allowedBuiltinCommands).toEqual(AHDE_BUILDER_BUILTIN_COMMANDS);
		expect(mainOptions.preferredExtensionCommands).toEqual(AHDE_BUILDER_PREFERRED_EXTENSION_COMMANDS);
		expect(mainOptions.allowBash).toBe(false);
		expect(mainOptions.resumeHint).toBe(false);

		expect(process.cwd()).toBe(previousCwd);
		expect(process.env.PI_CODING_AGENT_DIR).toBe(previousAgentDir);
		expect(process.env.PI_CODING_AGENT_SESSION_DIR).toBe(previousSessionDir);
	});
});
