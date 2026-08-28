import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTarget } from "../src/manifest.js";
import {
	disposeTargetWorkspaceSnapshot,
	materializeTargetWorkspaceSnapshot,
} from "../src/runner.js";
import {
	assertInteractiveTargetIdentity,
	assertInteractiveTargetWorkspaceSnapshot,
	interactiveTargetIdentity,
	interactiveTargetProcessLaunch,
	runInteractiveTargetProcess,
	targetInteractiveBootstrapEnvironment,
	type TargetInteractiveModeFactory,
} from "../src/target/interactive.js";
import { loadTargetResourceBundle } from "../src/target/runtime.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

const cleanupPaths: string[] = [];

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function targetManifest(baseUrl: string): string {
	return `id: interactive-target
model:
  provider: interactive-provider
  id: interactive-model
  api: openai-completions
  baseUrl: ${baseUrl}
  apiKeyEnv: INTERACTIVE_TARGET_KEY
  thinkingLevel: "off"
  timeoutMs: 60000
  params:
    seed: 314
execution:
  tools: [read, write]
  environmentAllowlist: [TARGET_VISIBLE]
  network: deny
  sandbox: best-effort
instructions:
  agentsMd: AGENTS.md
skills: [skills/only-target]
tools: []
evalSuite:
  id: interactive-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`;
}

interface ModelProbe {
	server: Server;
	url: string;
	authorizations: string[];
	bodies: Array<Record<string, unknown>>;
	close(): Promise<void>;
}

function startModelProbe(): Promise<ModelProbe> {
	const authorizations: string[] = [];
	const bodies: Array<Record<string, unknown>> = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			authorizations.push(request.headers.authorization ?? "");
			bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
			const base = {
				id: "chatcmpl-interactive",
				object: "chat.completion.chunk",
				created: 1,
				model: "interactive-model",
			};
			const first = {
				...base,
				choices: [{ index: 0, delta: { role: "assistant", content: "interactive-ok" }, finish_reason: null }],
			};
			const last = {
				...base,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
			};
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
			});
			response.end(`data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`);
		});
	});
	return new Promise((resolvePromise) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("model probe did not bind a TCP port");
			resolvePromise({
				server,
				url: `http://127.0.0.1:${address.port}/v1`,
				authorizations,
				bodies,
				close: () => new Promise<void>((done) => server.close(() => done())),
			});
		});
	});
}

function regularFiles(root: string, directory = root): string[] {
	const result: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...regularFiles(root, path));
		else if (entry.isFile()) result.push(relative(root, path));
	}
	return result.sort();
}

describe("interactive Target Pi", () => {
	it("runs the exact Target in a private isolated workspace and leaves no evidence artifacts", async () => {
		const probe = await startModelProbe();
		const targetDir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": targetManifest(probe.url),
			"AGENTS.md": "TARGET_INSTRUCTIONS_ONLY\n",
			"skills/check-dbo/SKILL.md": "---\nname: ambient-unused\ndescription: must not load\n---\n",
			"skills/only-target/SKILL.md": "---\nname: only-target\ndescription: exact target skill\n---\n\nTARGET_SKILL_ONLY\n",
			"skills/only-target/references/guide.md": "REFERENCE_ONLY\n",
			"skills/only-target/scripts/check.sh": "#!/bin/sh\necho SNAPSHOT_SCRIPT\n",
			"skills/only-target/assets/template.txt": "ASSET_ONLY\n",
			"public.txt": "source-public\n",
			"src/imports/helper.txt": "NESTED_IMPORT_MODULE_VISIBLE\n",
			".gitignore": ".env\n.ahde/\nruns/\n",
		}));
		cleanupPaths.push(targetDir);
		writeFileSync(join(targetDir, "visible-draft.txt"), "git-visible untracked file\n");
		writeFileSync(join(targetDir, ".env"), "PRIVATE_CHECKOUT_SECRET=hidden\n");
		mkdirSync(join(targetDir, ".ahde"), { recursive: true });
		writeFileSync(join(targetDir, ".ahde", "builder.json"), "BUILDER_PRIVATE_SENTINEL\n");
		mkdirSync(join(targetDir, "runs", "candidates"), { recursive: true });
		writeFileSync(join(targetDir, "runs", "candidates", "promotion.json"), "PROMOTION_SENTINEL\n");
		mkdirSync(join(targetDir, "imports"), { recursive: true });
		writeFileSync(join(targetDir, "imports", "builder.jsonl"), "BUILDER_IMPORT_SENTINEL\n");

		const ambientAgentDir = mkdtempSync(join(tmpdir(), "ahde-ambient-agent-"));
		cleanupPaths.push(ambientAgentDir);
		writeFileSync(join(ambientAgentDir, "AGENTS.md"), "AMBIENT_AGENT_SENTINEL\n");
		const invocationCwd = process.cwd();
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
		const previousOffline = process.env.PI_OFFLINE;
		const previousSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
		process.env.PI_CODING_AGENT_DIR = ambientAgentDir;
		delete process.env.PI_CODING_AGENT_SESSION_DIR;
		delete process.env.PI_OFFLINE;
		delete process.env.PI_SKIP_VERSION_CHECK;

		const target = loadTarget(targetDir);
		const sourceStatus = git(targetDir, "status", "--porcelain=v1", "--untracked-files=all");
		let workspaceDir = "";
		let privateRoot = "";
		let stopCalled = false;
		const secret = "interactive-memory-secret";
		const modeFactory: TargetInteractiveModeFactory = (runtime, interactiveOptions) => ({
			async run() {
				workspaceDir = runtime.cwd;
				privateRoot = dirname(runtime.services.agentDir);
				const modelsPath = join(privateRoot, "models.json");
				const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
				if (!sessionDir) throw new Error("private Target session directory is missing");

				expect(interactiveOptions.initialMessage).toBe("hello interactive Target");
				expect(interactiveOptions.startupDiagnostics).toEqual(runtime.diagnostics);
				expect(process.cwd()).toBe(workspaceDir);
				expect(process.env.PI_CODING_AGENT_DIR).toBe(runtime.services.agentDir);
				expect(process.env.PI_CODING_AGENT_SESSION_DIR).toBe(sessionDir);
				expect(process.env.PI_OFFLINE).toBe("1");
				expect(process.env.PI_SKIP_VERSION_CHECK).toBe("1");

				expect(statSync(privateRoot).mode & 0o777).toBe(0o700);
				expect(statSync(runtime.services.agentDir).mode & 0o777).toBe(0o700);
				expect(statSync(sessionDir).mode & 0o777).toBe(0o700);
				expect(runtime.session.sessionManager.isPersisted()).toBe(false);
				expect(runtime.session.sessionManager.getSessionFile()).toBeUndefined();
				expect(statSync(modelsPath).mode & 0o777).toBe(0o600);
				expect(workspaceDir.startsWith(privateRoot)).toBe(false);

				const modelsContent = readFileSync(modelsPath, "utf8");
				expect(modelsContent).toContain("interactive-provider");
				expect(modelsContent).toContain("interactive-model");
				expect(modelsContent).not.toContain(secret);
				expect(modelsContent).not.toContain("INTERACTIVE_TARGET_KEY");
				expect(await runtime.services.modelRuntime.listCredentials()).toEqual([
					{ providerId: "interactive-provider", type: "api_key" },
				]);

				expect(runtime.services.resourceLoader.getAgentsFiles().agentsFiles).toEqual([
					{ path: "AGENTS.md", content: "TARGET_INSTRUCTIONS_ONLY\n" },
				]);
				expect(runtime.services.resourceLoader.getSkills().skills.map((skill) => skill.name)).toEqual(["only-target"]);
				const extensions = runtime.services.resourceLoader.getExtensions().extensions;
				expect(extensions).toHaveLength(1);
				expect(extensions[0]).toMatchObject({ hidden: true });
				expect(runtime.services.resourceLoader.getPrompts().prompts).toEqual([]);
				expect(runtime.services.resourceLoader.getThemes().themes).toEqual([]);
				expect(runtime.session.systemPrompt).toContain("TARGET_INSTRUCTIONS_ONLY");
				expect(runtime.session.systemPrompt).not.toContain("AMBIENT_AGENT_SENTINEL");
				expect(runtime.session.agent.state.tools.map((tool) => tool.name).sort()).toEqual(["read", "write"]);
				expect(runtime.session.model).toMatchObject({
					provider: "interactive-provider",
					id: "interactive-model",
				});
				expect(runtime.session.scopedModels.map(({ model }) => `${model.provider}/${model.id}`)).toEqual([
					"interactive-provider/interactive-model",
				]);
				expect(runtime.session.thinkingLevel).toBe("off");

				const deniedShell = await runtime.session.extensionRunner.emitUserBash({
					type: "user_bash",
					command: `cat ${join(targetDir, ".env")}`,
					excludeFromContext: false,
					cwd: workspaceDir,
				});
				expect(deniedShell?.result).toMatchObject({ exitCode: 126, cancelled: false });
				expect(deniedShell?.result?.output).toContain("disables interactive shell commands");
				expect(deniedShell?.result?.output).not.toContain("PRIVATE_CHECKOUT_SECRET");
				expect(await runtime.session.extensionRunner.emitToolCall({
					type: "tool_call",
					toolCallId: "undeclared-call",
					toolName: "ambient_tool",
					input: {},
				})).toMatchObject({ block: true, terminate: true });
				expect(await runtime.session.extensionRunner.emit({
					type: "session_before_switch",
					reason: "resume",
					targetSessionFile: join(targetDir, "ambient-session.jsonl"),
				})).toEqual({ cancel: true });

				expect(existsSync(join(workspaceDir, "manifest.yaml"))).toBe(true);
				expect(existsSync(join(workspaceDir, "public.txt"))).toBe(true);
				expect(readFileSync(join(workspaceDir, "src", "imports", "helper.txt"), "utf8"))
					.toBe("NESTED_IMPORT_MODULE_VISIBLE\n");
				expect(existsSync(join(workspaceDir, "visible-draft.txt"))).toBe(true);
				for (const privatePath of [".git", ".env", ".ahde", "runs", "evals", "imports"]) {
					expect(existsSync(join(workspaceDir, privatePath))).toBe(false);
				}
				writeFileSync(join(workspaceDir, "public.txt"), "interactive-only mutation\n");
				writeFileSync(join(workspaceDir, "AGENTS.md"), "SELF_MODIFIED_INSTRUCTIONS\n");
				writeFileSync(
					join(workspaceDir, "skills/only-target/SKILL.md"),
					"---\nname: only-target\ndescription: modified\n---\n\nSELF_MODIFIED_SKILL\n",
				);
				writeFileSync(join(workspaceDir, "skills/only-target/references/guide.md"), "SELF_MODIFIED_REFERENCE\n");
				expect(await runtime.newSession()).toEqual({ cancelled: false });
				expect(runtime.session.systemPrompt).toContain("TARGET_INSTRUCTIONS_ONLY");
				expect(runtime.session.systemPrompt).not.toContain("SELF_MODIFIED_INSTRUCTIONS");
				const immutableSkill = runtime.services.resourceLoader.getSkills().skills[0];
				expect(immutableSkill).toBeDefined();
				expect(readFileSync(immutableSkill!.filePath, "utf8")).toContain("TARGET_SKILL_ONLY");
				expect(readFileSync(immutableSkill!.filePath, "utf8")).not.toContain("SELF_MODIFIED_SKILL");
				expect(readFileSync(join(immutableSkill!.baseDir, "references/guide.md"), "utf8")).toBe("REFERENCE_ONLY\n");
				expect(readFileSync(join(immutableSkill!.baseDir, "scripts/check.sh"), "utf8")).toContain("SNAPSHOT_SCRIPT");
				expect(readFileSync(join(immutableSkill!.baseDir, "assets/template.txt"), "utf8")).toBe("ASSET_ONLY\n");
				for (const immutablePath of [
					immutableSkill!.baseDir,
					immutableSkill!.filePath,
					join(immutableSkill!.baseDir, "references"),
					join(immutableSkill!.baseDir, "references/guide.md"),
				]) {
					expect(statSync(immutablePath).mode & 0o222).toBe(0);
				}

				await runtime.session.prompt("hello interactive Target");
				expect(runtime.session.getLastAssistantText()).toBe("interactive-ok");
				const privateFiles = regularFiles(privateRoot);
				expect(privateFiles).not.toContain("run.json");
				expect(privateFiles).not.toContain("eval_run.json");
				expect(privateFiles.some((path) => path.endsWith("candidate.json"))).toBe(false);
				for (const path of privateFiles) {
					const entry = join(privateRoot, path);
					if (lstatSync(entry).isFile()) expect(readFileSync(entry, "utf8")).not.toContain(secret);
				}
			},
			stop() {
				stopCalled = true;
			},
		});

		try {
			await runInteractiveTargetProcess(target, {
				initialMessage: "hello interactive Target",
				environment: {
					PATH: process.env.PATH,
					LANG: "C.UTF-8",
					INTERACTIVE_TARGET_KEY: secret,
					TARGET_VISIBLE: "declared-value",
				},
				modeFactory,
				tty: { stdinIsTTY: () => true, stdoutIsTTY: () => true },
			});
			expect(process.cwd()).toBe(invocationCwd);
			expect(process.env.PI_CODING_AGENT_DIR).toBe(ambientAgentDir);
			expect(process.env.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
			expect(process.env.PI_OFFLINE).toBeUndefined();
			expect(process.env.PI_SKIP_VERSION_CHECK).toBeUndefined();
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
			else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
			if (previousOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previousOffline;
			if (previousSkipVersionCheck === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
			else process.env.PI_SKIP_VERSION_CHECK = previousSkipVersionCheck;
			await probe.close();
		}

		expect(stopCalled).toBe(true);
		expect(probe.authorizations).toEqual([`Bearer ${secret}`]);
		expect(probe.bodies[0]).toMatchObject({ model: "interactive-model", seed: 314 });
		expect(existsSync(workspaceDir)).toBe(false);
		expect(existsSync(privateRoot)).toBe(false);
		expect(readFileSync(join(targetDir, "public.txt"), "utf8")).toBe("source-public\n");
		expect(readFileSync(join(targetDir, ".env"), "utf8")).toContain("PRIVATE_CHECKOUT_SECRET");
		expect(readFileSync(join(targetDir, ".ahde", "builder.json"), "utf8")).toContain("BUILDER_PRIVATE_SENTINEL");
		expect(readFileSync(join(targetDir, "runs", "candidates", "promotion.json"), "utf8")).toContain("PROMOTION_SENTINEL");
		expect(git(targetDir, "status", "--porcelain=v1", "--untracked-files=all")).toBe(sourceStatus);
	});

	it("fails closed without a real TTY or the manifest-selected credential", async () => {
		const targetDir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": targetManifest("http://127.0.0.1:1/v1"),
			"skills/only-target/SKILL.md": "---\nname: only-target\ndescription: exact target skill\n---\n",
		}));
		cleanupPaths.push(targetDir);
		const target = loadTarget(targetDir);
		let factoryCalls = 0;
		const modeFactory: TargetInteractiveModeFactory = () => {
			factoryCalls += 1;
			return { run: async () => undefined };
		};

		await expect(runInteractiveTargetProcess(target, {
			environment: { INTERACTIVE_TARGET_KEY: "present" },
			modeFactory,
			tty: { stdinIsTTY: () => false, stdoutIsTTY: () => true },
		})).rejects.toThrow(/requires TTY stdin and stdout/);
		await expect(runInteractiveTargetProcess(target, {
			environment: {},
			modeFactory,
			tty: { stdinIsTTY: () => true, stdoutIsTTY: () => true },
		})).rejects.toThrow(/missing Target model credential INTERACTIVE_TARGET_KEY/);
		expect(factoryCalls).toBe(0);
	});

	it("keeps Target credentials and loader variables out of the Node bootstrap environment", () => {
		const manifest = targetManifest("http://127.0.0.1:1/v1").replace(
			"environmentAllowlist: [TARGET_VISIBLE]",
			"environmentAllowlist: [TARGET_VISIBLE, NODE_OPTIONS, LD_PRELOAD, DYLD_INSERT_LIBRARIES]",
		);
		const targetDir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifest,
			"skills/only-target/SKILL.md": "---\nname: only-target\ndescription: exact target skill\n---\n",
		}));
		cleanupPaths.push(targetDir);
		const target = loadTarget(targetDir);
		const launch = interactiveTargetProcessLaunch(
			target,
			{ dir: targetDir, sha256: "sha256:" + "0".repeat(64) },
			{
				initialMessage: "private first turn",
				environment: {
					INTERACTIVE_TARGET_KEY: "credential-over-ipc",
					TARGET_VISIBLE: "declared-value",
					NODE_OPTIONS: "--import=/tmp/target-loader.mjs",
					LD_PRELOAD: "/tmp/target-loader.so",
					DYLD_INSERT_LIBRARIES: "/tmp/target-loader.dylib",
				},
			},
		);

		expect(Object.keys(targetInteractiveBootstrapEnvironment())).toEqual([]);
		expect(launch).toMatchObject({
			protocol: 1,
			initialMessage: "private first turn",
			environment: {
				INTERACTIVE_TARGET_KEY: "credential-over-ipc",
				TARGET_VISIBLE: "declared-value",
				NODE_OPTIONS: "--import=/tmp/target-loader.mjs",
				LD_PRELOAD: "/tmp/target-loader.so",
				DYLD_INSERT_LIBRARIES: "/tmp/target-loader.dylib",
			},
		});
	});

	it("binds display variables only after startup without binding loader options", async () => {
		const manifest = targetManifest("http://127.0.0.1:1/v1").replace(
			"environmentAllowlist: [TARGET_VISIBLE]",
			"environmentAllowlist: [TARGET_VISIBLE, NODE_OPTIONS]",
		);
		const targetDir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifest,
			"skills/only-target/SKILL.md": "---\nname: only-target\ndescription: exact target skill\n---\n",
		}));
		cleanupPaths.push(targetDir);
		const target = loadTarget(targetDir);
		const previousTerm = process.env.TERM;
		const previousColorTerm = process.env.COLORTERM;
		const previousNodeOptions = process.env.NODE_OPTIONS;

		await runInteractiveTargetProcess(target, {
			environment: {
				INTERACTIVE_TARGET_KEY: "present",
				TERM: "xterm-ahde-test",
				COLORTERM: "truecolor",
				NODE_OPTIONS: "--import=/tmp/must-not-bind.mjs",
			},
			modeFactory: () => ({
				async run() {
					expect(process.env.TERM).toBe("xterm-ahde-test");
					expect(process.env.COLORTERM).toBe("truecolor");
					expect(process.env.NODE_OPTIONS).toBe(previousNodeOptions);
				},
			}),
			tty: { stdinIsTTY: () => true, stdoutIsTTY: () => true },
		});

		expect(process.env.TERM).toBe(previousTerm);
		expect(process.env.COLORTERM).toBe(previousColorTerm);
		expect(process.env.NODE_OPTIONS).toBe(previousNodeOptions);
	});

	it("rejects child re-resolution or workspace bytes that differ from the parent selection", () => {
		const targetDir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": targetManifest("http://127.0.0.1:1/v1"),
			"skills/only-target/SKILL.md": "---\nname: only-target\ndescription: exact target skill\n---\n",
			"public.txt": "parent-selected\n",
		}));
		cleanupPaths.push(targetDir);
		const target = loadTarget(targetDir);
		const expected = interactiveTargetIdentity(target);
		for (const changed of [
			{ ...target, gitSha: `${target.gitSha}-changed` },
			{ ...target, toolsetHash: "sha256:" + "1".repeat(64) },
			{ ...target, datasetHash: "sha256:" + "2".repeat(64) },
			{ ...target, suiteHash: "sha256:" + "3".repeat(64) },
			{ ...target, manifest: { ...target.manifest, id: "different-target" } },
		]) {
			expect(() => assertInteractiveTargetIdentity(expected, changed)).toThrow(/identity changed/);
		}

		const workspace = materializeTargetWorkspaceSnapshot(target, tmpdir());
		try {
			expect(assertInteractiveTargetWorkspaceSnapshot(workspace)).toBe(workspace.dir);
			writeFileSync(join(workspace.dir, "public.txt"), "changed-after-parent-snapshot\n");
			expect(() => assertInteractiveTargetWorkspaceSnapshot(workspace)).toThrow(/snapshot changed/);
		} finally {
			disposeTargetWorkspaceSnapshot(workspace);
		}
	});

	it("refuses symlinks while snapshotting complete skill directories", () => {
		const targetDir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": targetManifest("http://127.0.0.1:1/v1"),
			"skills/only-target/SKILL.md": "---\nname: only-target\ndescription: exact target skill\n---\n",
		}));
		cleanupPaths.push(targetDir);
		const target = loadTarget(targetDir);
		const outsideDir = mkdtempSync(join(tmpdir(), "ahde-skill-outside-"));
		const snapshotDir = mkdtempSync(join(tmpdir(), "ahde-skill-snapshot-"));
		cleanupPaths.push(outsideDir, snapshotDir);
		writeFileSync(join(outsideDir, "secret.txt"), "OUTSIDE_SECRET\n");
		mkdirSync(join(targetDir, "skills/only-target/references"), { recursive: true });
		symlinkSync(join(outsideDir, "secret.txt"), join(targetDir, "skills/only-target/references/leak.txt"));

		expect(() => loadTargetResourceBundle({ target, cwd: targetDir, snapshotDir }))
			.toThrow(/snapshot refuses symlink/);
	});

	it("restores the manifest-selected thinking level before another turn", async () => {
		const manifest = targetManifest("http://127.0.0.1:1/v1").replace(
			'thinkingLevel: "off"',
			'thinkingLevel: "high"\n  spec:\n    reasoning: true',
		);
		const targetDir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifest,
			"skills/only-target/SKILL.md": "---\nname: only-target\ndescription: exact target skill\n---\n",
		}));
		cleanupPaths.push(targetDir);
		const target = loadTarget(targetDir);

		await runInteractiveTargetProcess(target, {
			environment: {
				PATH: process.env.PATH,
				INTERACTIVE_TARGET_KEY: "present",
			},
			modeFactory: (runtime) => ({
				async run() {
					expect(runtime.session.thinkingLevel).toBe("high");
					runtime.session.setThinkingLevel("low");
					await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
					expect(runtime.session.thinkingLevel).toBe("high");
				},
			}),
			tty: { stdinIsTTY: () => true, stdoutIsTTY: () => true },
		});
	});
});
