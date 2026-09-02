import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AHDE_BUILDER_BUILTIN_COMMANDS,
	AHDE_BUILDER_PREFERRED_EXTENSION_COMMANDS,
	buildBuilderPiArgs,
	launchBuilderPi,
	resolveBuilderAssets,
	resolveBuilderHome,
	validateBuilderPiArgs,
} from "../src/builder/runtime.js";
import { baseFixtureFiles, makeTargetFixture } from "./fixtures.js";

const roots: string[] = [];

function root(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	roots.push(path);
	return path;
}

/** Scope one environment variable to a callback so no test can leak it into the real ~/.ahde. */
async function withEnv(name: string, value: string | undefined, run: () => Promise<void> | void): Promise<void> {
	const previous = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		await run();
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}

const silentMain = async (): Promise<void> => {};

afterEach(() => {
	vi.restoreAllMocks();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Builder Pi runtime", () => {
	it("uses only the packaged prompt: one persona file, no separate skills", () => {
		const assets = resolveBuilderAssets();
		expect(assets.systemPrompt).toContain("Builder Pi and Target Pi are separate trust domains");
		expect(assets.systemPrompt).toContain("## Typical loop");
		expect(assets.systemPrompt).not.toContain("# Workflow skills");
		expect(assets.skillPaths).toHaveLength(0);
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
		expect(args.filter((value) => value === "--skill")).toHaveLength(0);
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

	it("launches Pi main with a user-level config home, per-project sessions, and one inline trusted extension", async () => {
		const projectDir = root("ahde-builder-launch-");
		const stateRoot = join(projectDir, ".private-ahde");
		const builderHome = join(projectDir, "builder-home");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		const previousSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
		const previousCwd = process.cwd();
		const observed: Record<string, unknown> = {};
		const main = vi.fn(async (args, options) => {
			observed.args = args;
			observed.options = options;
			observed.cwd = process.cwd();
			observed.agentDir = process.env.PI_CODING_AGENT_DIR;
			observed.sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
			observed.skipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
		});

		await launchBuilderPi({
			projectDir,
			stateRoot,
			builderHome,
			runsRoot: join(projectDir, "evidence"),
			projectId: "demo",
			piArgs: ["--thinking", "medium"],
			main,
		});

		expect(observed.cwd).toBe(realpathSync(projectDir));
		expect(observed.agentDir).toBe(realpathSync(resolve(builderHome, "config")));
		expect(observed.sessionDir).toBe(realpathSync(resolve(stateRoot, "builder-pi", "sessions")));
		expect(observed.skipVersionCheck).toBe("1");
		expect(existsSync(observed.agentDir as string)).toBe(true);
		expect(existsSync(observed.sessionDir as string)).toBe(true);
		expect(existsSync(resolve(stateRoot, "builder-pi", "config"))).toBe(false);
		expect(statSync(builderHome).mode & 0o777).toBe(0o700);
		expect(statSync(observed.agentDir as string).mode & 0o777).toBe(0o700);
		expect(observed.args).toEqual(expect.arrayContaining(["--no-builtin-tools", "--no-extensions", "--no-skills"]));
		const mainOptions = observed.options as {
			extensionFactories: { name: string; factory: unknown }[];
			allowedBuiltinCommands: readonly string[];
			preferredExtensionCommands: readonly string[];
			allowBash: boolean;
			resumeHint: string | false;
			modelFallbackHint: string | false;
		};
		const factories = mainOptions.extensionFactories;
		expect(factories).toHaveLength(1);
		expect(factories[0]).toMatchObject({ name: "ahde-builder" });
		expect(typeof factories[0]?.factory).toBe("function");
		expect(mainOptions.allowedBuiltinCommands).toEqual(AHDE_BUILDER_BUILTIN_COMMANDS);
		expect(mainOptions.preferredExtensionCommands).toEqual(AHDE_BUILDER_PREFERRED_EXTENSION_COMMANDS);
		expect(mainOptions.allowBash).toBe(false);
		expect(mainOptions.resumeHint).toBe(false);
		// AHDE's onboarding selector replaces Pi's own "No models available" notice.
		expect(mainOptions.modelFallbackHint).toBe(false);

		expect(process.cwd()).toBe(previousCwd);
		expect(process.env.PI_CODING_AGENT_DIR).toBe(previousAgentDir);
		expect(process.env.PI_CODING_AGENT_SESSION_DIR).toBe(previousSessionDir);
		expect(process.env.PI_SKIP_VERSION_CHECK).toBe(previousSkipVersionCheck);
	});

	/**
	 * The Builder creates `.ahde/` and `runs/` inside the operator's checkout.
	 * A Target that reached the Builder any way other than `ahde init` used to
	 * arrive with neither ignored, so its very first workshop was refused for
	 * "uncommitted changes" the host had made itself.
	 */
	it("ignores its own store in the Target before it writes one", async () => {
		const projectDir = root("ahde-builder-hygiene-");
		const builderHome = root("ahde-builder-hygiene-home-");
		await launchBuilderPi({
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			builderHome,
			projectId: "demo",
			main: silentMain,
		});

		const ignores = readFileSync(join(projectDir, ".gitignore"), "utf8");
		for (const rule of ["/.ahde/", "/runs/", "/imports/", "/.env", "!/.env.example"]) {
			expect(ignores).toContain(rule);
		}
		// Idempotent: a second launch tops up nothing.
		await launchBuilderPi({
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			builderHome,
			projectId: "demo",
			main: silentMain,
		});
		expect(readFileSync(join(projectDir, ".gitignore"), "utf8")).toBe(ignores);
	});

	it("resolves the Builder home from an explicit path, AHDE_HOME, or the user home", async () => {
		const home = root("ahde-home-");
		await withEnv("AHDE_HOME", home, () => {
			expect(resolveBuilderHome(join(home, "explicit"))).toBe(join(home, "explicit"));
			expect(resolveBuilderHome()).toBe(join(home, "builder-pi"));
		});
		await withEnv("AHDE_HOME", "   ", () => {
			expect(resolveBuilderHome()).toBe(join(homedir(), ".ahde", "builder-pi"));
		});
		await withEnv("AHDE_HOME", undefined, () => {
			expect(resolveBuilderHome()).toBe(join(homedir(), ".ahde", "builder-pi"));
		});
	});

	it("honors AHDE_HOME at launch while sessions stay under the project state root", async () => {
		const projectDir = root("ahde-builder-env-home-");
		const home = root("ahde-home-");
		const observed: Record<string, string | undefined> = {};
		await withEnv("AHDE_HOME", home, async () => {
			await launchBuilderPi({
				projectDir,
				main: async () => {
					observed.agentDir = process.env.PI_CODING_AGENT_DIR;
					observed.sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
				},
			});
		});
		expect(observed.agentDir).toBe(realpathSync(join(home, "builder-pi", "config")));
		expect(observed.sessionDir).toBe(realpathSync(join(projectDir, ".ahde", "builder-pi", "sessions")));
	});

	it("migrates legacy per-project credentials into the user-level home once and never overwrites them", async () => {
		const projectDir = root("ahde-builder-migrate-");
		const stateRoot = join(projectDir, ".ahde");
		const builderHome = join(projectDir, "builder-home");
		const legacyConfig = join(stateRoot, "builder-pi", "config");
		const userAuth = join(builderHome, "config", "auth.json");
		const userModels = join(builderHome, "config", "models.json");
		const auth = '{"anthropic":{"type":"api_key","key":"legacy"}}\n';
		const models = '{"providers":{}}\n';
		mkdirSync(legacyConfig, { recursive: true, mode: 0o700 });
		writeFileSync(join(legacyConfig, "auth.json"), auth, { mode: 0o600 });
		writeFileSync(join(legacyConfig, "models.json"), models, { mode: 0o600 });

		await launchBuilderPi({ projectDir, stateRoot, builderHome, main: silentMain });
		expect(readFileSync(userAuth, "utf8")).toBe(auth);
		expect(readFileSync(userModels, "utf8")).toBe(models);
		expect(statSync(userAuth).mode & 0o777).toBe(0o600);
		expect(statSync(userModels).mode & 0o777).toBe(0o600);
		expect(readFileSync(join(legacyConfig, "auth.json"), "utf8")).toBe(auth);

		writeFileSync(join(legacyConfig, "auth.json"), '{"rotated":true}\n');
		writeFileSync(join(legacyConfig, "models.json"), '{"rotated":true}\n');
		await launchBuilderPi({ projectDir, stateRoot, builderHome, main: silentMain });
		expect(readFileSync(userAuth, "utf8")).toBe(auth);
		expect(readFileSync(userModels, "utf8")).toBe(models);
	});

	it("copies only regular legacy files and keeps existing user-level companions", async () => {
		const projectDir = root("ahde-builder-migrate-guard-");
		const stateRoot = join(projectDir, ".ahde");
		const builderHome = join(projectDir, "builder-home");
		const legacyConfig = join(stateRoot, "builder-pi", "config");
		const userConfig = join(builderHome, "config");
		mkdirSync(legacyConfig, { recursive: true, mode: 0o700 });
		mkdirSync(userConfig, { recursive: true, mode: 0o700 });
		writeFileSync(join(projectDir, "outside-auth.json"), '{"outside":true}\n');
		symlinkSync(join(projectDir, "outside-auth.json"), join(legacyConfig, "auth.json"));
		writeFileSync(join(legacyConfig, "models.json"), '{"legacy":true}\n');

		await launchBuilderPi({ projectDir, stateRoot, builderHome, main: silentMain });
		expect(existsSync(join(userConfig, "auth.json"))).toBe(false);
		expect(existsSync(join(userConfig, "models.json"))).toBe(false);

		rmSync(join(legacyConfig, "auth.json"));
		writeFileSync(join(legacyConfig, "auth.json"), '{"legacy":true}\n', { mode: 0o600 });
		writeFileSync(join(userConfig, "models.json"), '{"mine":true}\n', { mode: 0o600 });
		await launchBuilderPi({ projectDir, stateRoot, builderHome, main: silentMain });
		expect(readFileSync(join(userConfig, "auth.json"), "utf8")).toBe('{"legacy":true}\n');
		expect(readFileSync(join(userConfig, "models.json"), "utf8")).toBe('{"mine":true}\n');
	});

	it("seeds Pi settings for a quiet embedded startup without clobbering user choices", async () => {
		expect(PI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
		const projectDir = root("ahde-builder-settings-");
		const builderHome = join(projectDir, "builder-home");
		const settingsPath = join(builderHome, "config", "settings.json");

		await launchBuilderPi({ projectDir, builderHome, main: silentMain });
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
			quietStartup: true,
			lastChangelogVersion: PI_VERSION,
		});
		expect(statSync(settingsPath).mode & 0o777).toBe(0o600);

		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", quietStartup: false, lastChangelogVersion: "0.0.1" }));
		await launchBuilderPi({ projectDir, builderHome, main: silentMain });
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
			theme: "dark",
			quietStartup: false,
			lastChangelogVersion: PI_VERSION,
		});

		writeFileSync(settingsPath, JSON.stringify({ theme: "light" }));
		await launchBuilderPi({ projectDir, builderHome, main: silentMain });
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
			theme: "light",
			quietStartup: true,
			lastChangelogVersion: PI_VERSION,
		});

		writeFileSync(settingsPath, "{ not json");
		await launchBuilderPi({ projectDir, builderHome, main: silentMain });
		expect(readFileSync(settingsPath, "utf8")).toBe("{ not json");
	});

	it("opens Runtime Pi from free text and returns to the same Builder session", async () => {
		const projectDir = makeTargetFixture(baseFixtureFiles());
		roots.push(projectDir);
		const stateRoot = root("ahde-builder-handoff-state-");
		const runsRoot = root("ahde-builder-handoff-runs-");
		const builderHome = root("ahde-builder-handoff-home-");
		const targetRunner = vi.fn(async (target: { manifest: { id: string } }) => {
			expect(target.manifest.id).toBe("test-target");
		});
		let invocation = 0;
		const main = vi.fn(async (_args, options) => {
			invocation += 1;
			if (invocation !== 1) return;
			const registered: { name: string; execute?: (...args: unknown[]) => Promise<unknown> }[] = [];
			const methods: Record<string, unknown> = {
				registerTool: (tool: { name: string }) => registered.push(tool),
				registerCommand: vi.fn(),
				on: vi.fn(),
				setActiveTools: vi.fn(),
				registerEntryRenderer: vi.fn(),
				registerMessageRenderer: vi.fn(),
				appendEntry: vi.fn(),
			};
			const pi = new Proxy(methods, {
				get(target, property) {
					if (property in target) return target[property as string];
					const fallback = vi.fn();
					target[property as string] = fallback;
					return fallback;
				},
			});
			await options!.extensionFactories![0]!.factory(pi as never);
			const tool = registered.find((candidate) => candidate.name === "ahde_workbench_decide")!;
			await tool.execute!(
				"handoff",
				{ kind: "talk-to-agent", reason: "Try the agent" } as never,
				undefined as never,
				(() => undefined) as never,
				{
					hasUI: true,
					mode: "tui",
					shutdown: vi.fn(),
					ui: { notify: vi.fn() },
				} as never,
			);
		});
		const previous = process.env.TEST_MODEL_KEY;
		process.env.TEST_MODEL_KEY = "test-only";
		try {
			await launchBuilderPi({
				projectDir,
				stateRoot,
				runsRoot,
				builderHome,
				projectId: "test-target",
				main,
				targetRunner: targetRunner as never,
			});
		} finally {
			if (previous === undefined) delete process.env.TEST_MODEL_KEY;
			else process.env.TEST_MODEL_KEY = previous;
		}
		expect(targetRunner).toHaveBeenCalledOnce();
		expect(main).toHaveBeenCalledTimes(2);
		expect(main.mock.calls[1]?.[0]).toContain("--continue");
	});
});
