import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTarget } from "../src/manifest.js";
import { loadVerifiedEvalRun, runSuite } from "../src/eval.js";
import { startMockModel } from "../src/mock-model.js";
import { createTargetToolRuntime, targetFilesystemConfinement } from "../src/target/runtime.js";
import {
	AHDE_TOOL_HOME_ENVIRONMENT,
	AHDE_WORLD_ENVIRONMENT,
	buildToolEnvironment,
	toolConfinement,
} from "../src/target/tool-broker.js";
import { containerSandboxFingerprint } from "../src/target/container-backend.js";
import { validateTargetToolArguments } from "../src/target/tool-manifest.js";
import { EMPTY_PREPARED_TOOL_HOME_HASH } from "../src/target/tool-setup.js";
import { openTrace, traceToolCalls } from "../src/trace.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

const VALID_DESCRIPTOR = `schemaVersion: 1
name: echo_json
description: Return the provided input JSON.
parameters:
  type: object
  properties:
    message:
      type: string
      minLength: 1
      maxLength: 100
  required: [message]
  additionalProperties: false
command:
  argv: [bin/echo_json]
timeoutMs: 5000
maxOutputBytes: 8192
output: json
permissions:
  environment: []
  network: deny
  filesystem: read-only
`;

function manifest(options: { network?: "deny" | "allow"; sandbox?: "required" | "best-effort" | "off"; env?: string[] } = {}): string {
	return `id: tool-target
model:
  provider: test
  id: test-model
  api: openai-completions
  baseUrl: http://127.0.0.1:1/v1
  apiKeyEnv: TEST_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 1000
execution:
  tools: [read]
  environmentAllowlist: [${(options.env ?? []).join(", ")}]
  network: ${options.network ?? "deny"}
  sandbox: ${options.sandbox ?? "best-effort"}
instructions:
  agentsMd: AGENTS.md
skills: []
tools: [tools/echo_json.tool.yaml]
evalSuite:
  id: tool-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`;
}

function toolFixture(options: { descriptor?: string; executable?: string; manifest?: string } = {}): string {
	const dir = makeTargetFixture(
		baseFixtureFiles({
			"manifest.yaml": options.manifest ?? manifest(),
			"tools/echo_json.tool.yaml": options.descriptor ?? VALID_DESCRIPTOR,
			"bin/echo_json": options.executable ?? "#!/bin/sh\nIFS= read -r payload || exit 2\nprintf '%s\\n' \"$payload\"\n",
		}),
	);
	chmodSync(join(dir, "bin/echo_json"), 0o755);
		execFileSync("git", ["-C", dir, "add", "."]);
		execFileSync("git", [
		"-C",
		dir,
		"-c",
		"user.name=test",
		"-c",
		"user.email=test@test",
		"commit",
		"--amend",
		"--no-edit",
		"-q",
	]);
	return dir;
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

describe("declarative Target tool manifests", () => {
	it("loads an explicit descriptor and hashes normalized descriptor plus executable content", () => {
		const dir = toolFixture();
		try {
			const first = loadTarget(dir);
			expect(first.tools.map((tool) => tool.descriptor.name)).toEqual(["echo_json"]);
			expect(first.tools[0]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(first.tools[0]?.executableHash).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(first.toolsetHash).toMatch(/^sha256:[0-9a-f]{64}$/);

			writeFileSync(join(dir, "bin/echo_json"), "#!/bin/sh\nprintf '{\"changed\":true}\\n'\n");
			chmodSync(join(dir, "bin/echo_json"), 0o755);
			const changed = loadTarget(dir);
			expect(changed.toolsetHash).not.toBe(first.toolsetHash);
			expect(changed.tools[0]?.digest).not.toBe(first.tools[0]?.digest);
		} finally {
			cleanup(dir);
		}
	});

	it("validates arguments and rejects unknown, missing, and wrong-typed values", () => {
		const dir = toolFixture();
		try {
			const tool = loadTarget(dir).tools[0];
			if (!tool) throw new Error("fixture did not load the tool");
			expect(validateTargetToolArguments(tool, { message: "hello" })).toEqual({ message: "hello" });
			expect(() => validateTargetToolArguments(tool, {})).toThrow(/required property is missing/);
			expect(() => validateTargetToolArguments(tool, { message: 42 })).toThrow(/expected string/);
			expect(() => validateTargetToolArguments(tool, { message: "hello", surprise: true })).toThrow(/unknown property/);
		} finally {
			cleanup(dir);
		}
	});

	it("rejects unsupported schemas, reserved names, and permission escalation", () => {
		const invalidCases = [
			VALID_DESCRIPTOR.replace("additionalProperties: false", "additionalProperties: true"),
			VALID_DESCRIPTOR.replace("name: echo_json", "name: read"),
			VALID_DESCRIPTOR.replace("network: deny", "network: allow"),
			VALID_DESCRIPTOR.replace("environment: []", "environment: [TOP_SECRET]"),
		];
		for (const descriptor of invalidCases) {
			const dir = toolFixture({ descriptor });
			try {
				expect(() => loadTarget(dir)).toThrow();
			} finally {
				cleanup(dir);
			}
		}
	});

	it("requires a sandbox policy for every subprocess tool", () => {
		const dir = toolFixture({ manifest: manifest({ sandbox: "off", network: "allow" }) });
		try {
			expect(() => loadTarget(dir)).toThrow(/declarative tools require/);
		} finally {
			cleanup(dir);
		}
	});

	it("rejects executable path escape and every symlink hop", () => {
		const escaped = toolFixture({ descriptor: VALID_DESCRIPTOR.replace("bin/echo_json", "../echo_json") });
		try {
			expect(() => loadTarget(escaped)).toThrow(/bin\/ path/);
		} finally {
			cleanup(escaped);
		}

		const linked = toolFixture();
		const outside = mkdtempSync(join(tmpdir(), "ahde-target-tool-outside-"));
		writeFileSync(join(outside, "outside-tool"), "#!/bin/sh\nprintf '{}\\n'\n", { mode: 0o755 });
		try {
			unlinkSync(join(linked, "bin/echo_json"));
			symlinkSync(join(outside, "outside-tool"), join(linked, "bin/echo_json"));
			expect(() => loadTarget(linked)).toThrow(/must not traverse a symlink/);
		} finally {
			cleanup(linked);
			cleanup(outside);
		}
	});

	it("rejects descriptor symlinks even when they point to an in-repository file", () => {
		const dir = toolFixture();
		try {
			writeFileSync(join(dir, "tools/real.tool.yaml"), VALID_DESCRIPTOR);
			unlinkSync(join(dir, "tools/echo_json.tool.yaml"));
			symlinkSync("real.tool.yaml", join(dir, "tools/echo_json.tool.yaml"));
			expect(() => loadTarget(dir)).toThrow(/must not traverse a symlink/);
		} finally {
			cleanup(dir);
		}
	});
});

describe("Target tool broker and Pi registration", () => {
	it("classifies filesystem confinement honestly for API-only, process, sandboxed, and direct runs", () => {
		expect(targetFilesystemConfinement({ workspaceMode: "isolated", toolNames: ["read", "write"], sandbox: "none" }))
			.toBe("workspace-confined-v1");
		expect(targetFilesystemConfinement({ workspaceMode: "isolated", toolNames: ["bash"], sandbox: "none" }))
			.toBe("isolated-copy-unconfined-v1");
		expect(targetFilesystemConfinement({ workspaceMode: "isolated", toolNames: ["echo_json"], sandbox: "unavailable" }))
			.toBe("isolated-copy-unconfined-v1");
		expect(targetFilesystemConfinement({ workspaceMode: "isolated", toolNames: ["echo_json"], sandbox: "sandbox-exec" }))
			.toBe("workspace-confined-v1");
		expect(targetFilesystemConfinement({ workspaceMode: "direct", toolNames: ["read"], sandbox: "sandbox-exec" }))
			.toBe("direct-unconfined-v1");
		// A content-pinned container is a first-class confinement identity.
			expect(targetFilesystemConfinement({
				workspaceMode: "isolated",
				toolNames: ["echo_json"],
				sandbox: `container:docker@sha256:${"a".repeat(64)}:config:${"c".repeat(64)}`,
		})).toBe("workspace-confined-v1");
		expect(() => targetFilesystemConfinement({
			workspaceMode: "isolated",
			toolNames: ["echo_json"],
			sandbox: "container:docker@latest",
		})).toThrow();
	});

	it("carries a sandbox fingerprint beside the OS backend on every tool runtime", () => {
		const dir = toolFixture();
		const scratch = join(dir, ".ahde-test-scratch-fingerprint");
		try {
			const target = loadTarget(dir);
			let runtime;
			try {
				runtime = createTargetToolRuntime({ target, workspaceDir: dir, scratchDir: scratch });
			} catch (error) {
				expect((error as Error).message).toMatch(/No usable sandbox backend/);
				return;
			}
			// A single-file tool needs no prepared home, so no backend choice is
			// made up front; the broker's own detection is the fingerprint.
			expect(runtime.sandboxFingerprint).toBe(runtime.sandboxBackend);
			expect(runtime.sandboxFingerprint.startsWith("container:")).toBe(false);
			expect(runtime.sandboxWarnings).toEqual([]);
		} finally {
			cleanup(dir);
		}
	});

	it("selects the container backend for declared tools and never reports a host OS sandbox for one", () => {
		const dir = toolFixture({
			manifest: manifest().replace(
				"  sandbox: best-effort\n",
				`  sandbox: required\n  container:\n    runtime: docker\n    image: ahde/target@sha256:${"b".repeat(64)}\n    platform: linux/amd64\n`,
			),
		});
		const scratch = join(dir, ".ahde-test-scratch-container");
		try {
			const target = loadTarget(dir);
			const runtimeIdentity = {
				version: "27.1.0",
				os: "linux",
				arch: "amd64",
				daemonId: "test-daemon",
				kernelVersion: "6.10.0-test",
				driver: "overlay2",
				cgroupDriver: "cgroupfs",
				cgroupVersion: "2",
				securityOptionsHash: "d".repeat(64),
				contextHash: "e".repeat(64),
			};
			const runtime = createTargetToolRuntime({
				target,
				workspaceDir: dir,
				scratchDir: scratch,
				detectContainerRuntime: () => ({
					runtime: "docker",
					available: true,
					...runtimeIdentity,
				}),
			});
			const container = target.manifest.execution.container;
			if (!container) throw new Error("container policy missing from fixture");
			expect(runtime.sandboxFingerprint).toBe(containerSandboxFingerprint(container, runtimeIdentity));
			expect(runtime.sandboxBackend).toBeNull();
			expect(runtime.sandboxWarnings).toEqual([]);
		} finally {
			cleanup(dir);
		}
	});

	it("registers and executes the working JSON-stdin template tool when a sandbox backend is available", async () => {
		const dir = toolFixture();
		const scratch = join(dir, ".ahde-test-scratch");
		try {
			const target = loadTarget(dir);
			let runtime;
			try {
				runtime = createTargetToolRuntime({ target, workspaceDir: dir, scratchDir: scratch });
			} catch (error) {
				expect((error as Error).message).toMatch(/No usable sandbox backend/);
				return;
			}
			expect(runtime.toolNames).toEqual(["echo_json"]);
			expect(runtime.customTools).toHaveLength(1);
			const definition = runtime.customTools[0];
			if (!definition) throw new Error("runtime did not register echo_json");
			const result = await definition.execute(
				"call-1",
				{ message: "hello" },
				undefined,
				undefined,
				undefined as never,
			);
			expect(JSON.parse(toolText(result))).toEqual({ message: "hello" });
			expect(result.details).toMatchObject({ outputType: "json", exitCode: 0 });
		} finally {
			cleanup(dir);
		}
	});

	it("redacts the exact value of every allowlisted credential from model-facing tool output", async () => {
		const secret = "opaque-value-that-matches-no-token-pattern";
		const dir = toolFixture({
			manifest: manifest({ env: ["OPAQUE_CREDENTIAL"] }),
			descriptor: VALID_DESCRIPTOR.replace("environment: []", "environment: [OPAQUE_CREDENTIAL]"),
			executable: "#!/bin/sh\nprintf '{\"seen\":\"%s\"}\\n' \"$OPAQUE_CREDENTIAL\"\n",
		});
		const scratch = join(dir, ".ahde-test-scratch-secret-output");
		try {
			const target = loadTarget(dir);
			let runtime;
			try {
				runtime = createTargetToolRuntime({
					target,
					workspaceDir: dir,
					scratchDir: scratch,
					sourceEnvironment: { PATH: process.env.PATH, OPAQUE_CREDENTIAL: secret },
				});
			} catch (error) {
				expect((error as Error).message).toMatch(/No usable sandbox backend/);
				return;
			}
			const definition = runtime.customTools[0];
			if (!definition) throw new Error("runtime did not register echo_json");
			const result = await definition.execute(
				"call-secret",
				{ message: "hello" },
				undefined,
				undefined,
				undefined as never,
			);
			const text = toolText(result);
			expect(text).not.toContain(secret);
			expect(JSON.parse(text)).toEqual({ seen: "[REDACTED]" });
		} finally {
			cleanup(dir);
		}
	});

	it("fails closed if the executable changes between resolution and runtime construction", () => {
		const dir = toolFixture();
		try {
			const target = loadTarget(dir);
			writeFileSync(join(dir, "bin/echo_json"), "#!/bin/sh\nprintf '{}\\n'\n");
			chmodSync(join(dir, "bin/echo_json"), 0o755);
			expect(() => createTargetToolRuntime({
				target,
				workspaceDir: dir,
				scratchDir: join(dir, ".scratch"),
			})).toThrow(/changed after target resolution/);
		} finally {
			cleanup(dir);
		}
	});

	it("OS-confines the subprocess even when a target-authored static argv names a sibling secret", async () => {
		const outside = mkdtempSync(join(tmpdir(), "ahde-target-tool-secret-"));
		const secretPath = join(outside, "secret.txt");
		writeFileSync(secretPath, "must-not-leak\n");
		const descriptor = VALID_DESCRIPTOR
			.replace("argv: [bin/echo_json]", `argv: [bin/echo_json, ${JSON.stringify(secretPath)}]`)
			.replace("output: json", "output: text");
		const dir = toolFixture({
			descriptor,
			executable: "#!/bin/sh\n/bin/cat \"$1\"\n",
		});
		try {
			const target = loadTarget(dir);
			let runtime;
			try {
				runtime = createTargetToolRuntime({ target, workspaceDir: dir, scratchDir: join(dir, ".scratch") });
			} catch (error) {
				expect((error as Error).message).toMatch(/No usable sandbox backend/);
				return;
			}
			const definition = runtime.customTools[0];
			if (!definition) throw new Error("runtime did not register echo_json");
			await expect(
				definition.execute("call", { message: "hello" }, undefined, undefined, undefined as never),
			).rejects.toThrow(/exited with/);
		} finally {
			cleanup(dir);
			cleanup(outside);
		}
	});

	it("rejects malformed JSON, output overflow, and timeout when a sandbox backend is available", async () => {
		const cases = [
			{
				name: "malformed",
				descriptor: VALID_DESCRIPTOR,
				executable: "#!/bin/sh\nprintf 'not-json\\n'\n",
				error: /malformed JSON/,
			},
			{
				name: "overflow",
				descriptor: VALID_DESCRIPTOR.replace("maxOutputBytes: 8192", "maxOutputBytes: 16"),
				executable: "#!/bin/sh\nprintf '012345678901234567890123456789\\n'\n",
				error: /exceeded 16 output bytes/,
			},
			{
				name: "timeout",
				descriptor: VALID_DESCRIPTOR.replace("timeoutMs: 5000", "timeoutMs: 25"),
				executable: "#!/bin/sh\nwhile :; do :; done\n",
				error: /timed out after 25ms/,
			},
		];
		for (const testCase of cases) {
			const dir = toolFixture({ descriptor: testCase.descriptor, executable: testCase.executable });
			try {
				const target = loadTarget(dir);
				let runtime;
				try {
					runtime = createTargetToolRuntime({ target, workspaceDir: dir, scratchDir: join(dir, ".scratch") });
				} catch (error) {
					expect((error as Error).message).toMatch(/No usable sandbox backend/);
					return;
				}
				const definition = runtime.customTools[0];
				if (!definition) throw new Error(`runtime did not register ${testCase.name}`);
				await expect(
					definition.execute("call", { message: "hello" }, undefined, undefined, undefined as never),
				).rejects.toThrow(testCase.error);
			} finally {
				cleanup(dir);
			}
		}
	});

	it("lets Target Pi call a manifest tool during an eval and records the call in its trace", async () => {
		const mock = await startMockModel([
			{
				match: ({ firstUser }) => firstUser.includes("declarative echo"),
				steps: [
					{ toolCall: { name: "echo_json", arguments: { message: "from-target" } } },
					{ text: "done from-target" },
				],
			},
		]);
		const targetManifest = manifest().replace("http://127.0.0.1:1/v1", mock.url).replace("timeoutMs: 1000", "timeoutMs: 60000");
		const dir = toolFixture({
			manifest: targetManifest,
		});
		writeFileSync(
			join(dir, "evals/development.jsonl"),
			`${JSON.stringify({
				id: "tool-call",
				input: "Use declarative echo and then say done.",
				graders: [
					{ type: "tool_called", tool: "echo_json", argsContains: "from-target" },
					{ type: "output_contains", text: "done" },
				],
			})}\n`,
		);
	execFileSync("git", ["-C", dir, "add", "."]);
	execFileSync("git", [
			"-C",
			dir,
			"-c",
			"user.name=test",
			"-c",
			"user.email=test@test",
			"commit",
			"--amend",
			"--no-edit",
			"-q",
		]);
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-target-tool-runs-"));
		const probeScratch = mkdtempSync(join(tmpdir(), "ahde-target-tool-probe-"));
		process.env.TEST_MODEL_KEY = "test-key";
		try {
			const target = loadTarget(dir);
			try {
				createTargetToolRuntime({ target, workspaceDir: dir, scratchDir: probeScratch });
			} catch (error) {
				expect((error as Error).message).toMatch(/No usable sandbox backend/);
				return;
			}
			const evaluation = await runSuite(target, { runsRoot, label: "solo", repetitions: 1 });
			expect(evaluation.summary).toMatchObject({ total: 1, pass: 1, fail: 0, error: 0 });
			expect(evaluation.target.toolsetHash).toBe(target.toolsetHash);
			const runId = evaluation.runIds[0];
			if (!runId) throw new Error("evaluation did not create a run");
			const trace = openTrace(join(runsRoot, runId));
			expect(traceToolCalls(trace)).toContainEqual(
				expect.objectContaining({ name: "echo_json", arguments: { message: "from-target" } }),
			);
			const runRecord = JSON.parse(readFileSync(join(runsRoot, runId, "run.json"), "utf8"));
			expect(runRecord.target.toolsetHash).toBe(target.toolsetHash);
			// Custom tools are Harness identity (toolsetHash), not a fixed host
			// execution axis; candidates are allowed to improve the toolset.
			expect(runRecord.execution.tools).not.toContain("echo_json");
			expect(runRecord.execution.sandbox).not.toBe("none");

			const evalIndexPath = join(runsRoot, evaluation.evalRunId, "eval_run.json");
			const tamperedIndex = JSON.parse(readFileSync(evalIndexPath, "utf8"));
			tamperedIndex.target.toolsetHash = `sha256:${"f".repeat(64)}`;
			chmodSync(evalIndexPath, 0o600);
			writeFileSync(evalIndexPath, `${JSON.stringify(tamperedIndex, null, "\t")}\n`);
			expect(() => loadVerifiedEvalRun(runsRoot, evaluation.evalRunId)).toThrow(/target does not match/);
		} finally {
			delete process.env.TEST_MODEL_KEY;
			cleanup(dir);
			cleanup(runsRoot);
			cleanup(probeScratch);
			await mock.close();
		}
	}, 60_000);
});

describe("the case's world reaches a declared tool", () => {
	function toolWith(filesystem: "read-only" | "workspace-write") {
		return {
			descriptor: { name: "world_tool", permissions: { network: "deny" as const, filesystem, environment: [] } },
		} as unknown as Parameters<typeof toolConfinement>[0];
	}

	it("exports AHDE_WORLD beside AHDE_TOOL_HOME, and lets no allowlist redefine either", () => {
		const scratch = mkdtempSync(join(tmpdir(), "ahde-world-env-"));
		try {
			const withWorld = buildToolEnvironment({
				label: "world_tool",
				scratchDir: scratch,
				environmentAllowlist: [AHDE_WORLD_ENVIRONMENT, AHDE_TOOL_HOME_ENVIRONMENT, "TICKET_TOKEN"],
				sourceEnvironment: {
					PATH: "/usr/bin:/bin",
					AHDE_WORLD: "/somewhere/else/state.json",
					AHDE_TOOL_HOME: "/somewhere/else/tools",
					TICKET_TOKEN: "t-1",
				},
				worldPath: "/runs/run_1/runtime/world/state.json",
			});
			// The host's value wins: a tool that could be pointed at another run's
			// world would be reading someone else's evidence.
			expect(withWorld.environment[AHDE_WORLD_ENVIRONMENT]).toBe("/runs/run_1/runtime/world/state.json");
			expect(withWorld.environment.TICKET_TOKEN).toBe("t-1");
			expect(withWorld.names).toContain(AHDE_WORLD_ENVIRONMENT);
			// And a case with no world exports nothing at all, so an un-worlded run
			// cannot be told apart from one written before worlds existed.
			const withoutWorld = buildToolEnvironment({
				label: "world_tool",
				scratchDir: scratch,
				environmentAllowlist: [AHDE_WORLD_ENVIRONMENT],
				sourceEnvironment: { PATH: "/usr/bin:/bin", AHDE_WORLD: "/somewhere/else/state.json" },
			});
			expect(withoutWorld.environment[AHDE_WORLD_ENVIRONMENT]).toBeUndefined();
			expect(withoutWorld.names).not.toContain(AHDE_WORLD_ENVIRONMENT);
		} finally {
			cleanup(scratch);
		}
	});

	it("confines the world by the tool's own declared filesystem permission", () => {
		const world = "/runs/run_1/runtime/world";
		const readOnly = toolConfinement(toolWith("read-only"), "/ws", undefined, world);
		expect(readOnly.readRoots).toEqual([world]);
		expect(readOnly.writeRoots).toEqual([]);

		// A writable world is on BOTH lists: sandbox-exec grants read and write
		// separately, so a write root alone could not even be read back.
		const writable = toolConfinement(toolWith("workspace-write"), "/ws", undefined, world);
		expect(writable.readRoots).toEqual([world]);
		expect(writable.writeRoots).toEqual(["/ws", world]);

		// Without a world nothing changes, and the prepared tool home keeps its place.
		expect(toolConfinement(toolWith("read-only"), "/ws", "/tools")).toEqual({
			network: "deny",
			readRoots: ["/tools"],
			writeRoots: [],
		});
	});
});

// ---------- the knowledge base ----------

const KB_TARIFFS = `# Тарифы

Тариф «Река»: 500 Мбит/с, 750 рублей в месяц. Роутер в аренду — 90 рублей в месяц.

Тариф «Ручей»: 100 Мбит/с, 450 рублей в месяц.
`;

const KB_VISITS = `# Выезд мастера

Выезд бесплатный, если неисправность на стороне провайдера.

Выезд платный, если причина внутри квартиры: 600 рублей.
`;

function kbManifest(options: { declareKb: boolean; baseUrl?: string }): string {
	return `id: kb-target
model:
  provider: test
  id: test-model
  api: openai-completions
  baseUrl: ${options.baseUrl ?? "http://127.0.0.1:1/v1"}
  apiKeyEnv: TEST_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: ${options.baseUrl ? 60_000 : 1_000}
execution:
  tools: [read]
  environmentAllowlist: []
  network: deny
  sandbox: best-effort
instructions:
  agentsMd: AGENTS.md
skills: []
tools: []
${options.declareKb ? "data: [data/kb]\n" : ""}evalSuite:
  id: kb-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`;
}

function kbFixture(options: { declareKb: boolean; baseUrl?: string; tariffs?: string; dataset?: string }): string {
	return makeTargetFixture(
		baseFixtureFiles({
			"manifest.yaml": kbManifest(options),
			"data/kb/tariffs.md": options.tariffs ?? KB_TARIFFS,
			"data/kb/visits.md": KB_VISITS,
			// Not knowledge, and the tool must not pretend otherwise.
			"data/kb/notes.pdf": "%PDF-1.4 не знание",
			...(options.dataset ? { "evals/development.jsonl": options.dataset } : {}),
		}),
	);
}

describe("the knowledge base as a Target surface", () => {
	it("turns kb_search on for a declared data/kb and leaves it off otherwise", () => {
		const withKb = kbFixture({ declareKb: true });
		const withoutKb = kbFixture({ declareKb: false });
		try {
			const on = createTargetToolRuntime({
				target: loadTarget(withKb),
				workspaceDir: withKb,
				scratchDir: join(withKb, ".scratch-on"),
			});
			expect(on.toolNames).toEqual(["kb_search"]);
			expect(on.customTools.map((tool) => tool.name)).toEqual(["kb_search"]);
			expect(on.kbIndexHash).toMatch(/^sha256:[0-9a-f]{64}$/);
			// A retrieval tool starts no process, so it must not turn a confined
			// run into an unconfined one.
			expect(targetFilesystemConfinement({
				workspaceMode: "isolated",
				toolNames: on.toolNames,
				sandbox: "none",
			})).toBe("workspace-confined-v1");

			const off = createTargetToolRuntime({
				target: loadTarget(withoutKb),
				workspaceDir: withoutKb,
				scratchDir: join(withoutKb, ".scratch-off"),
			});
			expect(off.toolNames).toEqual([]);
			expect(off.customTools).toEqual([]);
			expect(off.kbIndexHash).toBeNull();
			// Absent means absent: the composed identity is byte-identical to what
			// a Target with no prepared tool home has always recorded.
			expect(off.preparedToolHomeHash).toBe(EMPTY_PREPARED_TOOL_HOME_HASH);
			expect(on.preparedToolHomeHash).not.toBe(off.preparedToolHomeHash);
		} finally {
			cleanup(withKb);
			cleanup(withoutKb);
		}
	});

	it("makes two different knowledge bases two different Targets", () => {
		const first = kbFixture({ declareKb: true });
		const second = kbFixture({
			declareKb: true,
			tariffs: KB_TARIFFS.replace("750 рублей", "770 рублей"),
		});
		try {
			const a = createTargetToolRuntime({
				target: loadTarget(first),
				workspaceDir: first,
				scratchDir: join(first, ".scratch"),
			});
			const b = createTargetToolRuntime({
				target: loadTarget(second),
				workspaceDir: second,
				scratchDir: join(second, ".scratch"),
			});
			expect(a.kbIndexHash).not.toBe(b.kbIndexHash);
			expect(a.preparedToolHomeHash).not.toBe(b.preparedToolHomeHash);
			// Two runs over the same bytes agree, so a rebuild is not a new Target.
			const again = createTargetToolRuntime({
				target: loadTarget(first),
				workspaceDir: first,
				scratchDir: join(first, ".scratch-again"),
			});
			expect(again.preparedToolHomeHash).toBe(a.preparedToolHomeHash);
		} finally {
			cleanup(first);
			cleanup(second);
		}
	});

	it("lets Target Pi search the knowledge base during an eval and records the call", async () => {
		const mock = await startMockModel([
			{
				match: ({ firstUser }) => firstUser.includes("Река"),
				steps: [
					{ toolCall: { name: "kb_search", arguments: { query: "тариф Река рублей", k: 2 } } },
					{ text: "Тариф «Река» стоит 750 рублей в месяц. Источник: tariffs.md#0" },
				],
			},
		]);
		const dir = kbFixture({
			declareKb: true,
			baseUrl: mock.url,
			dataset: `${JSON.stringify({
				id: "kb-call",
				input: "Сколько стоит тариф «Река»?",
				expected: "750 рублей в месяц",
				graders: [
					{ type: "tool_called", tool: "kb_search" },
					{ type: "cites_source", chunk: "tariffs.md#0" },
				],
			})}\n`,
		});
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-kb-runs-"));
		process.env.TEST_MODEL_KEY = "test-key";
		try {
			const target = loadTarget(dir);
			const evaluation = await runSuite(target, { runsRoot, label: "solo", repetitions: 1 });
			expect(evaluation.summary).toMatchObject({ total: 1, pass: 1, fail: 0, error: 0 });
			const runId = evaluation.runIds[0];
			if (!runId) throw new Error("evaluation did not create a run");
			const calls = traceToolCalls(openTrace(join(runsRoot, runId)));
			expect(calls).toContainEqual(
				expect.objectContaining({ name: "kb_search", arguments: { query: "тариф Река рублей", k: 2 } }),
			);
			const returned = calls.find((call) => call.name === "kb_search");
			expect(returned).toBeDefined();
			const record = JSON.parse(readFileSync(join(runsRoot, runId, "run.json"), "utf8"));
			// The index identity travels with the run, and the run's own workspace
			// copy is what the citation grader read.
			expect(record.target.preparedToolHomeHash).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(record.target.preparedToolHomeHash).not.toBe(EMPTY_PREPARED_TOOL_HOME_HASH);
			expect(readFileSync(join(runsRoot, runId, "workspace", "data", "kb", "tariffs.md"), "utf8"))
				.toContain("750 рублей");
			expect(record.evalResults.graders.map((grader: { checkCode: string }) => grader.checkCode))
				.toContain("cites-source");
		} finally {
			delete process.env.TEST_MODEL_KEY;
			cleanup(dir);
			cleanup(runsRoot);
			await mock.close();
		}
	}, 60_000);
});
