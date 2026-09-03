import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSuite } from "../src/eval.js";
import { loadTarget } from "../src/manifest.js";
import { startMockModel } from "../src/mock-model.js";
import { createTargetToolRuntime } from "../src/target/runtime.js";
import { readFinalWorldState, worldStatePath } from "../src/target/world-state.js";
import { openTrace, traceToolCalls } from "../src/trace.js";
import type { RunRecord } from "../src/provenance.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

/**
 * The world through the real runner: one declared tool reads `AHDE_WORLD`,
 * another rewrites it, and the `world_state` grader reads what the
 * conversation left behind.
 *
 * Everything here is POSIX `sh`, `sed` and `mv` on purpose. The tools run
 * inside the OS sandbox, whose read roots are system directories; a helper
 * installed under a user's home — a version-managed `node`, for one — is not
 * reachable from in there, and a test that needed one would fail for a reason
 * that has nothing to do with worlds.
 */

const PEEK = `#!/bin/sh
set -eu
IFS= read -r _payload || exit 2
[ -n "\${AHDE_WORLD:-}" ] || { echo "AHDE_WORLD is unset" >&2; exit 2; }
cat "$AHDE_WORLD"
`;

const CLOSE = `#!/bin/sh
set -eu
IFS= read -r _payload || exit 2
[ -n "\${AHDE_WORLD:-}" ] || { echo "AHDE_WORLD is unset" >&2; exit 2; }
sed 's/"open"/"closed"/' "$AHDE_WORLD" > "$AHDE_WORLD.tmp"
mv "$AHDE_WORLD.tmp" "$AHDE_WORLD"
echo closed
`;

const BREAK = `#!/bin/sh
set -eu
IFS= read -r _payload || exit 2
[ -n "\${AHDE_WORLD:-}" ] || { echo "AHDE_WORLD is unset" >&2; exit 2; }
printf '%s' '{ this is not json' > "$AHDE_WORLD.tmp"
mv "$AHDE_WORLD.tmp" "$AHDE_WORLD"
echo broken
`;

function descriptor(name: string, filesystem: "read-only" | "workspace-write"): string {
	return `schemaVersion: 1
name: ${name}
description: Act on the case's world.
parameters:
  type: object
  properties:
    note:
      type: string
      minLength: 1
      maxLength: 100
  required: [note]
  additionalProperties: false
command:
  argv: [bin/${name}]
timeoutMs: 10000
maxOutputBytes: 8192
output: text
permissions:
  environment: []
  network: deny
  filesystem: ${filesystem}
`;
}

function manifest(baseUrl: string, tools: readonly string[]): string {
	return `id: world-target
model:
  provider: test
  id: test-model
  api: openai-completions
  baseUrl: ${baseUrl}
  apiKeyEnv: TEST_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 60000
execution:
  tools: [read]
  environmentAllowlist: []
  network: deny
  sandbox: best-effort
instructions:
  agentsMd: AGENTS.md
skills: []
tools: [${tools.map((tool) => `tools/${tool}.tool.yaml`).join(", ")}]
evalSuite:
  id: world-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`;
}

const fixtures: string[] = [];
const roots: string[] = [];

afterEach(() => {
	for (const dir of fixtures.splice(0)) cleanup(dir);
	for (const dir of roots.splice(0)) cleanup(dir);
});

function worldFixture(options: {
	baseUrl: string;
	tools: { name: string; body: string; filesystem: "read-only" | "workspace-write" }[];
	dataset: string;
}): string {
	const files: Record<string, string> = { "manifest.yaml": manifest(options.baseUrl, options.tools.map((tool) => tool.name)) };
	for (const tool of options.tools) {
		files[`tools/${tool.name}.tool.yaml`] = descriptor(tool.name, tool.filesystem);
		files[`bin/${tool.name}`] = tool.body;
	}
	files["evals/development.jsonl"] = options.dataset;
	const dir = makeTargetFixture(baseFixtureFiles(files));
	fixtures.push(dir);
	for (const tool of options.tools) chmodSync(join(dir, "bin", tool.name), 0o755);
	execFileSync("git", ["-C", dir, "add", "."]);
	execFileSync("git", [
		"-C", dir, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "--amend", "--no-edit", "-q",
	]);
	return dir;
}

function runsRootDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ahde-world-runs-"));
	roots.push(dir);
	return dir;
}

/** The declared-tool sandbox is a hard requirement; on a host without one, say so and stop. */
function sandboxAvailable(dir: string): boolean {
	const probe = mkdtempSync(join(tmpdir(), "ahde-world-probe-"));
	roots.push(probe);
	try {
		createTargetToolRuntime({ target: loadTarget(dir), workspaceDir: dir, scratchDir: probe });
		return true;
	} catch (error) {
		expect((error as Error).message).toMatch(/No usable sandbox backend/);
		return false;
	}
}

function recordOf(runsRoot: string, runId: string): RunRecord {
	return JSON.parse(readFileSync(join(runsRoot, runId, "run.json"), "utf8")) as RunRecord;
}

describe("a case's world, through the real runner", () => {
	it("hands the world to sandboxed tools, keeps it out of the workspace, and grades what they left", async () => {
		const mock = await startMockModel([
			{
				match: ({ firstUser }) => firstUser.includes("close the case"),
				steps: [
					{ toolCall: { name: "world_peek", arguments: { note: "look" } } },
					{ toolCall: { name: "world_close", arguments: { note: "act" } } },
					{ text: "ok, closed" },
				],
			},
			{
				match: ({ firstUser }) => firstUser.includes("just answer"),
				steps: [{ text: "ok" }],
			},
		]);
		const dataset = [
			JSON.stringify({
				id: "worlded",
				input: "close the case",
				world: { state: { status: "open" }, expect: [{ path: "status", op: "equals", value: "closed" }] },
				graders: [{ type: "tool_called", tool: "world_close" }],
			}),
			JSON.stringify({
				id: "plain",
				input: "just answer",
				graders: [{ type: "output_contains", text: "ok" }],
			}),
		].join("\n");
		const dir = worldFixture({
			baseUrl: mock.url,
			tools: [
				{ name: "world_peek", body: PEEK, filesystem: "read-only" },
				{ name: "world_close", body: CLOSE, filesystem: "workspace-write" },
			],
			dataset,
		});
		process.env.TEST_MODEL_KEY = "test-key";
		try {
			if (!sandboxAvailable(dir)) return;
			const runsRoot = runsRootDir();
			const evaluation = await runSuite(loadTarget(dir), { runsRoot, label: "solo", repetitions: 1 });
			expect(evaluation.summary).toMatchObject({ total: 2, pass: 2, fail: 0, error: 0 });

			const records = evaluation.runIds.map((runId) => recordOf(runsRoot, runId));
			const worlded = records.find((record) => record.taskId === "worlded");
			const plain = records.find((record) => record.taskId === "plain");
			if (!worlded || !plain) throw new Error("the suite did not run both cases");

			// Invariant 19: the world is not part of the Target's identity, so two
			// cases in one EvalRun still materialize the same hash-checked snapshot.
			expect(worlded.target.workspaceHash).toBe(plain.target.workspaceHash);
			expect(worlded.target.workspaceHash).toMatch(/^sha256:[0-9a-f]{64}$/);

			const worldedDir = join(runsRoot, worlded.runId);
			// It lives beside the workspace, never inside it.
			expect(worldStatePath(worldedDir)).toBe(join(worldedDir, "runtime", "world", "state.json"));
			expect(existsSync(join(worldedDir, "workspace", "runtime"))).toBe(false);

			// A read-only tool read it, a workspace-write tool rewrote it, and the
			// grader read what the conversation left behind.
			const trace = openTrace(worldedDir);
			expect(traceToolCalls(trace).map((call) => call.name)).toEqual(["world_peek", "world_close"]);
			const peeked = trace.find((message) => message.role === "toolResult" && message.text.includes("status"));
			expect(peeked?.text).toContain("open");
			expect(readFinalWorldState(worldedDir)).toEqual({ status: "closed" });
			expect(readFinalWorldState(join(runsRoot, plain.runId))).toBeNull();

			const world = worlded.evalResults?.graders.find((grader) => grader.checkCode === "world-state");
			expect(world).toMatchObject({ type: "world_state", passed: true, reason: 'world at status equals "closed"' });
			// The un-worlded case is graded exactly as it always was.
			expect(plain.evalResults?.graders.map((grader) => grader.checkCode)).toEqual(["output-contains"]);
		} finally {
			await mock.close();
		}
	});

	it("turns a world nobody can read back into an infrastructure error, not a verdict", async () => {
		const mock = await startMockModel([
			{
				match: ({ firstUser }) => firstUser.includes("break it"),
				steps: [
					{ toolCall: { name: "world_break", arguments: { note: "act" } } },
					{ text: "done" },
				],
			},
		]);
		const dataset = `${JSON.stringify({
			id: "corrupted",
			input: "break it",
			world: { state: { status: "open" }, expect: [{ path: "status", op: "equals", value: "closed" }] },
			graders: [{ type: "tool_called", tool: "world_break" }],
		})}\n`;
		const dir = worldFixture({
			baseUrl: mock.url,
			tools: [{ name: "world_break", body: BREAK, filesystem: "workspace-write" }],
			dataset,
		});
		process.env.TEST_MODEL_KEY = "test-key";
		try {
			if (!sandboxAvailable(dir)) return;
			const runsRoot = runsRootDir();
			const evaluation = await runSuite(loadTarget(dir), { runsRoot, label: "solo", repetitions: 1 });
			expect(evaluation.summary).toMatchObject({ total: 1, pass: 0, fail: 0, error: 1 });

			const runId = evaluation.runIds[0];
			if (!runId) throw new Error("the suite created no run");
			const record = recordOf(runsRoot, runId);
			// Invariant 9: a corrupted world says nothing about the agent, so the
			// run carries no outcome at all — not a failing one.
			expect(record.status).toBe("error");
			expect(record.evalResults).toBeNull();
			expect(record.error).toMatch(/evaluation infrastructure: world state file is not JSON/);
			// The bytes the tool left are still on disk, exactly as evidence.
			expect(readFileSync(worldStatePath(join(runsRoot, runId)), "utf8")).toBe("{ this is not json");
		} finally {
			await mock.close();
		}
	});

	it("writes the world before the agent's first turn, private, and never into an un-worlded run", async () => {
		const mock = await startMockModel([{ steps: [{ text: "ok" }] }]);
		const dataset = [
			JSON.stringify({
				id: "worlded",
				input: "just answer",
				world: { state: { client: { name: "Иван" }, status: "open" } },
				graders: [{ type: "output_contains", text: "ok" }],
			}),
			JSON.stringify({ id: "plain", input: "just answer too", graders: [{ type: "output_contains", text: "ok" }] }),
		].join("\n");
		const dir = worldFixture({
			baseUrl: mock.url,
			tools: [{ name: "world_peek", body: PEEK, filesystem: "read-only" }],
			dataset,
		});
		process.env.TEST_MODEL_KEY = "test-key";
		try {
			if (!sandboxAvailable(dir)) return;
			const runsRoot = runsRootDir();
			const evaluation = await runSuite(loadTarget(dir), { runsRoot, label: "solo", repetitions: 1 });
			expect(evaluation.summary).toMatchObject({ total: 2, pass: 2, error: 0 });
			const records = evaluation.runIds.map((runId) => recordOf(runsRoot, runId));
			const worlded = records.find((record) => record.taskId === "worlded");
			const plain = records.find((record) => record.taskId === "plain");
			if (!worlded || !plain) throw new Error("the suite did not run both cases");

			// Untouched by any tool: the state the case declared, byte for byte.
			expect(readFinalWorldState(join(runsRoot, worlded.runId))).toEqual({ client: { name: "Иван" }, status: "open" });
			expect(existsSync(worldStatePath(join(runsRoot, plain.runId)))).toBe(false);
			// A case with no world declares no world state grader either, so the two
			// runs still grade to the same shape.
			expect(worlded.evalResults?.graders.map((grader) => grader.checkCode))
				.toEqual(plain.evalResults?.graders.map((grader) => grader.checkCode));
		} finally {
			await mock.close();
		}
	});
});

/** A dataset the runner must leave alone: writing a world it did not ask for. */
describe("an un-worlded suite", () => {
	it("creates no world directory at all", async () => {
		const mock = await startMockModel([{ steps: [{ text: "ok" }] }]);
		const dir = worldFixture({
			baseUrl: mock.url,
			tools: [{ name: "world_peek", body: PEEK, filesystem: "read-only" }],
			dataset: `${JSON.stringify({ id: "plain", input: "hello", graders: [{ type: "output_contains", text: "ok" }] })}\n`,
		});
		// The peek tool would fail without AHDE_WORLD; nothing calls it here, and
		// its mere presence must not make the runner write a world.
		writeFileSync(join(dir, "AGENTS.md"), readFileSync(join(dir, "AGENTS.md"), "utf8"), "utf8");
		process.env.TEST_MODEL_KEY = "test-key";
		try {
			if (!sandboxAvailable(dir)) return;
			const runsRoot = runsRootDir();
			const evaluation = await runSuite(loadTarget(dir), { runsRoot, label: "solo", repetitions: 1 });
			const runId = evaluation.runIds[0];
			if (!runId) throw new Error("the suite created no run");
			expect(existsSync(join(runsRoot, runId, "runtime", "world"))).toBe(false);
		} finally {
			await mock.close();
		}
	});
});
