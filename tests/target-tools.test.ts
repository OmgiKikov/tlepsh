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
import { containerSandboxFingerprint } from "../src/target/container-backend.js";
import { validateTargetToolArguments } from "../src/target/tool-manifest.js";
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
			const runtime = createTargetToolRuntime({
				target,
				workspaceDir: dir,
				scratchDir: scratch,
				detectContainerRuntime: () => ({
					runtime: "docker",
					available: true,
					version: "27.1.0",
					os: "linux",
					arch: "amd64",
				}),
			});
			const container = target.manifest.execution.container;
			if (!container) throw new Error("container policy missing from fixture");
			expect(runtime.sandboxFingerprint).toBe(containerSandboxFingerprint(container, {
				version: "27.1.0",
				os: "linux",
				arch: "amd64",
			}));
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
