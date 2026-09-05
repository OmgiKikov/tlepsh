import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadVerifiedEvalRun, runSuite } from "../src/eval.js";
import { hashValue } from "../src/provenance.js";
import { regradeEvalRun } from "../src/regrade.js";
import { classifyRunError, runTranscript } from "../src/application/run-explanation.js";
import { loadTarget } from "../src/manifest.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import { openTrace } from "../src/trace.js";
import { createTargetToolRuntime } from "../src/target/runtime.js";
import { createCommandTargetSession } from "../src/target/session-command.js";
import { cleanup, makeTargetFixture, type FixtureFile } from "./fixtures.js";

/**
 * The command Target, end to end, through the real `runTask`: a child process
 * that speaks protocol v1, a host-brokered tool call, a canonical trace, and
 * every way the wire can fail.
 *
 * The agent is `tests/fixtures/command-agent.mjs` — deterministic, offline, and
 * driven entirely by `FAKE_AGENT_MODE`, so a failure here is a failure of the
 * adapter and never of a model.
 */

const AGENT_SOURCE = readFileSync(new URL("./fixtures/command-agent.mjs", import.meta.url), "utf8");
/** An absolute argv[0]: the exact interpreter this test process is running on. */
const NODE = process.execPath;

const TOOL_DESCRIPTOR = `schemaVersion: 1
name: check_dbo
description: Проверка ограничений по договору.
parameters:
  type: object
  properties:
    id: { type: string, minLength: 1, maxLength: 64 }
  required: [id]
  additionalProperties: false
command:
  argv: [bin/check_dbo]
timeoutMs: 5000
maxOutputBytes: 8192
output: text
permissions:
  environment: []
  network: deny
  filesystem: read-only
`;

interface TargetOptions {
	agentSource?: string;
	argv?: string[];
	timeoutMs?: number;
	startupTimeoutMs?: number;
	dataset?: string;
	simulatedUserUrl?: string;
}

function manifestYaml(options: TargetOptions): string {
	const argv = options.argv ?? [NODE, "agent.mjs"];
	return `id: cmd-target
model:
  provider: openai-compatible
  id: fake-model
  api: openai-completions
  baseUrl: http://127.0.0.1:9/v1
  apiKeyEnv: MOCK_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: ${options.timeoutMs ?? 20000}
execution:
  kind: command
  command:
    argv: [${argv.map((part) => JSON.stringify(part)).join(", ")}]
    protocolVersion: 1
    startupTimeoutMs: ${options.startupTimeoutMs ?? 10000}
  tools: [read, bash]
  environmentAllowlist: [FAKE_AGENT_MODE]
  network: deny
  sandbox: best-effort
instructions:
  agentsMd: AGENTS.md
skills: []
tools: [tools/check_dbo.tool.yaml]
evalSuite:
  id: cmd-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
${options.simulatedUserUrl
	? `  simulatedUser:
    provider: openai-compatible
    id: user-model
    api: openai-completions
    baseUrl: ${options.simulatedUserUrl}
    apiKeyEnv: MOCK_MODEL_KEY
    thinkingLevel: "off"
    timeoutMs: 30000
`
	: ""}`;
}

const ONE_TASK = JSON.stringify({
	id: "task_001",
	input: "Сколько стоит тариф?",
	graders: [{ type: "output_contains", text: "" }],
});

function commandFixture(options: TargetOptions = {}): { targetDir: string; runsRoot: string } {
	const files: FixtureFile[] = [
		{ path: "manifest.yaml", content: manifestYaml(options) },
		{ path: "AGENTS.md", content: "# Command agent\n\nОтвечай кратко.\n" },
		{ path: "agent.mjs", content: options.agentSource ?? AGENT_SOURCE },
		{ path: "tools/check_dbo.tool.yaml", content: TOOL_DESCRIPTOR },
		{ path: "bin/check_dbo", content: "#!/bin/sh\necho 'limits: none'\n" },
		{ path: "evals/development.jsonl", content: options.dataset ?? ONE_TASK },
		{ path: "evals/graders.yaml", content: "defaults: []\n" },
	];
	const targetDir = makeTargetFixture(files);
	return { targetDir, runsRoot: join(targetDir, "..", `cmd-runs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) };
}

/**
 * The other end of a simulated conversation. Only the USER model is mocked
 * here: the Target is the child process, which is the whole point.
 */
let userModel: MockModelHandle;

beforeAll(async () => {
	userModel = await startMockModel([
		{
			match: () => true,
			steps: [{ text: JSON.stringify({ done: false, message: "А что с блокировкой?" }) }],
		},
	]);
});

afterAll(() => {
	void userModel.close();
});

const created: string[] = [];

function fixture(options: TargetOptions = {}) {
	const made = commandFixture(options);
	created.push(made.targetDir, made.runsRoot);
	return made;
}

afterEach(() => {
	while (created.length > 0) cleanup(created.pop() as string);
	delete process.env.FAKE_AGENT_MODE;
});

async function runOnce(mode: string, options: TargetOptions = {}) {
	process.env.FAKE_AGENT_MODE = mode;
	process.env.MOCK_MODEL_KEY = "test-key";
	const { targetDir, runsRoot } = fixture(options);
	// `bin/check_dbo` must be executable in the workspace copy the child sees.
	const { chmodSync } = await import("node:fs");
	chmodSync(join(targetDir, "bin", "check_dbo"), 0o755);
	const target = loadTarget(targetDir);
	const evalRun = await runSuite(target, { runsRoot, label: "solo", repetitions: 1, jobs: 1 });
	const runId = evalRun.runIds[0] as string;
	const record = JSON.parse(readFileSync(join(runsRoot, runId, "run.json"), "utf8"));
	return { record, runDir: join(runsRoot, runId), evalRun, targetDir, runsRoot };
}

describe("a command Target speaks protocol v1", () => {
	it("runs through aliased workspace, scratch and world paths with the same sandbox boundaries", async () => {
		const { targetDir, runsRoot } = fixture({ agentSource: `
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
let hello;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "hello") { hello = message; return; }
  if (message.type === "cancel") process.exit(0);
  if (message.type !== "user") return;
  writeFileSync(join(process.env.HOME, "home-probe"), "home works");
  writeFileSync(join(process.env.TMPDIR, "tmp-probe"), "tmp works");
  let readOnly = false;
  try { writeFileSync(join(hello.workspace, "forbidden-write"), "must fail"); }
  catch (error) { if (!["EACCES", "EPERM", "EROFS"].includes(error.code)) throw error; readOnly = true; }
  const text = JSON.stringify({
    workspace: hello.workspace, cwd: process.cwd(), world: hello.world,
    worldEnv: process.env.AHDE_WORLD, home: process.env.HOME, tmp: process.env.TMPDIR,
    instructions: readFileSync(join(hello.workspace, "AGENTS.md"), "utf8"),
    worldState: JSON.parse(readFileSync(hello.world, "utf8")), readOnly,
    canonicalHome: realpathSync(process.env.HOME), canonicalTmp: realpathSync(process.env.TMPDIR),
  });
  process.stdout.write(JSON.stringify({ v: 1, type: "assistant", turn: message.turn, text }) + "\\n");
});
` });
		const scratchDir = join(runsRoot, "scratch");
		const runDir = join(runsRoot, "run");
		mkdirSync(scratchDir, { recursive: true });
		mkdirSync(runDir);
		writeFileSync(join(scratchDir, "world.json"), JSON.stringify({ account: "sandbox-fixture" }));
		chmodSync(join(targetDir, "bin", "check_dbo"), 0o755);
		const workspaceAlias = join(runsRoot, "workspace-alias");
		const scratchAlias = join(runsRoot, "scratch-alias");
		symlinkSync(targetDir, workspaceAlias, "dir");
		symlinkSync(scratchDir, scratchAlias, "dir");
		expect(workspaceAlias).not.toBe(realpathSync(workspaceAlias));
		const target = loadTarget(targetDir);
		const targetTools = createTargetToolRuntime({ target, workspaceDir: targetDir, scratchDir });
		const { session } = await createCommandTargetSession({
			target, workspaceDir: workspaceAlias, scratchDir: scratchAlias, runDir, targetTools,
			worldPath: join(scratchAlias, "world.json"), apiKey: "offline-fixture-key", timeoutMs: 10_000,
		});
		try {
			const { text } = await session.takeTurn("Check the mounted paths.");
			const home = join(realpathSync(scratchDir), "tool-home", "agent");
			const tmp = join(realpathSync(scratchDir), "tool-tmp", "agent");
			expect(JSON.parse(text)).toEqual({
				workspace: realpathSync(targetDir), cwd: realpathSync(targetDir),
				world: realpathSync(join(scratchDir, "world.json")), worldEnv: realpathSync(join(scratchDir, "world.json")),
				home, tmp, canonicalHome: home, canonicalTmp: tmp,
				instructions: readFileSync(join(targetDir, "AGENTS.md"), "utf8"),
				worldState: { account: "sandbox-fixture" }, readOnly: true,
			});
			expect(readFileSync(join(home, "home-probe"), "utf8")).toBe("home works");
			expect(readFileSync(join(tmp, "tmp-probe"), "utf8")).toBe("tmp works");
		} finally {
			await session.close();
		}
	});

	it("adds every model request within a turn, including tool selection", async () => {
		const { record } = await runOnce("two-usage");
		expect(record.status).toBe("completed");
		expect(record.metrics.tokens.total).toBe(36);
		expect(record.metrics.costUsd).toBeCloseTo(0.5);
	});

	it("preserves a Cyrillic character split across stdout chunks", async () => {
		const { record, runDir } = await runOnce("split-utf8");
		expect(record.status).toBe("completed");
		expect(openTrace(runDir)[1]?.text).toBe("Привет 👋");
	});

	it.each(["invalid-utf8", "wrong-turn", "wrong-usage-turn"])("rejects %s as infrastructure, not an answer", async (mode) => {
		const { record } = await runOnce(mode);
		expect(record.status).toBe("error");
	});

	it("does not pass a silent agent merely because it leaked no secret", async () => {
		const { record } = await runOnce("empty", {
			dataset: JSON.stringify({ id: "silent", input: "Ответь", graders: [{ type: "no_secret" }] }),
		});
		expect(record.status).toBe("completed");
		expect(record.metrics.finalAnswer).toBe("silent");
		expect(record.evalResults.outcome).toBe("fail");
	});

	it("answers a plain question, records usage, and writes a canonical trace", async () => {
		const { record, runDir } = await runOnce("plain");
		expect(record.status).toBe("completed");
		expect(record.error).toBeNull();
		expect(record.metrics.tokens.total).toBe(18);
		expect(record.metrics.costUsd).toBeCloseTo(0.25, 6);
		expect(record.trace.sessionId).toBeNull();
		// The trace is parsed by the ONE canonical parser, exactly as a Pi run is.
		const messages = openTrace(runDir);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(messages[1]?.text).toContain("500 рублей");
	});

	it("brokers a declared tool call through the sandbox and records it as a Pi run would", async () => {
		const { record, runDir } = await runOnce("tool");
		expect(record.status).toBe("completed");
		expect(record.metrics.toolCalls).toBe(1);
		expect(record.metrics.toolErrors).toBe(0);
		const messages = openTrace(runDir);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		expect(messages[1]?.toolCalls).toEqual([{ id: "call-1", name: "check_dbo", arguments: { id: "42" } }]);
		expect(messages[2]?.toolResult?.toolName).toBe("check_dbo");
		expect(messages[2]?.toolResult?.text).toContain("limits: none");
		expect(messages[3]?.text).toContain("limits: none");
	});

	it("keeps a tool_note visible but never treats it as host-verified execution", async () => {
		const { record, runDir } = await runOnce("note", {
			dataset: JSON.stringify({ id: "reported", input: "Проверь", graders: [{ type: "tool_called", tool: "internal_lookup" }] }),
		});
		expect(record.status).toBe("completed");
		// Keep reported activity separate; only a brokered call is execution proof.
		expect(record.metrics.toolCalls).toBe(0);
		expect(record.metrics.reportedToolCalls).toBe(1);
		const messages = openTrace(runDir);
		expect(messages[1]?.toolCalls?.[0]?.name).toBe("internal_lookup");
		expect(messages[1]?.toolCalls?.[0]?.evidence).toBe("reported");
		expect(runTranscript(messages).entries.find((entry) => entry.kind === "tool")).toMatchObject({ evidence: "reported" });
		expect(record.evalResults.outcome).toBe("fail");
		expect(messages[2]?.toolResult?.text).toBe("limits: none");
		expect(messages[2]?.toolResult?.isError).toBe(false);
	});

	it("counts reported and host-executed tools independently in a mixed run", async () => {
		const { record, runDir } = await runOnce("mixed-tools");
		expect(record.status).toBe("completed");
		expect(record.metrics.toolCalls).toBe(1);
		expect(record.metrics.reportedToolCalls).toBe(2);
		expect(record.metrics.toolErrors).toBe(0);
		const calls = openTrace(runDir).flatMap((message) => message.toolCalls ?? []);
		expect(calls.filter((call) => call.evidence === "reported").map((call) => call.name))
			.toEqual(["memory_lookup", "policy_lookup"]);
		expect(calls.filter((call) => call.evidence !== "reported").map((call) => call.name))
			.toEqual(["check_dbo"]);
	});

	it("records usage as ABSENT when the agent reported none", async () => {
		const { record } = await runOnce("no-usage");
		expect(record.status).toBe("completed");
		expect(record.metrics.tokens).toBeUndefined();
		expect(record.metrics.costUsd).toBeUndefined();
	});

	it("asks once more for a final answer when the first one is empty", async () => {
		const { record, runDir } = await runOnce("empty-then-recover");
		expect(record.status).toBe("completed");
		expect(record.metrics.recoveryAttempts).toBe(1);
		const messages = openTrace(runDir);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(messages[3]?.text).toContain("действующий");
	});

	it("passes AHDE_PROTOCOL and the credential by the manifest's own env name", async () => {
		const { record, runDir } = await runOnce("protocol");
		expect(record.status).toBe("completed");
		expect(openTrace(runDir)[1]?.text).toBe("protocol=1 key=test-key");
	});

	it("passes AHDE_WORLD only when the case declares a world", async () => {
		const withWorld = JSON.stringify({
			id: "task_world",
			input: "Что в мире?",
			world: { state: { balance: 100 } },
			graders: [{ type: "output_contains", text: "world=" }],
		});
		const withoutWorld = JSON.stringify({
			id: "task_plain",
			input: "Что в мире?",
			graders: [{ type: "output_contains", text: "world=none" }],
		});
		const present = await runOnce("world", { dataset: withWorld });
		expect(present.record.status).toBe("completed");
		const said = openTrace(present.runDir)[1]?.text ?? "";
		expect(said).toMatch(/world=\S*runtime\/world\/state\.json/);
		// The path the child is told and the path `hello` carries are one path.
		expect(said.split("hello=")[1]).toBe(said.slice("world=".length).split(" ")[0]);

		const absent = await runOnce("world", { dataset: withoutWorld });
		expect(openTrace(absent.runDir)[1]?.text).toBe("world=none hello=none");
	});

	it("pins the final world and copies it into a regrade without launching the agent", async () => {
		const source = await runOnce("world", { dataset: JSON.stringify({
			id: "task_world", input: "Что в мире?", world: { state: { balance: 100 } },
			graders: [{ type: "world_state", path: "balance", op: "equals", value: 100 }],
		}) });
		expect(source.record.evidenceArtifacts).toEqual({ world: hashValue({ balance: 100 }), judge: {} });
		process.env.FAKE_AGENT_MODE = "crash";
		const target = loadTarget(source.targetDir);
		const result = await regradeEvalRun({ runsRoot: source.runsRoot, evalRunId: source.evalRun.evalRunId, target });
		expect(result.record.summary).toMatchObject({ pass: 1, error: 0 });
		const derived = loadVerifiedEvalRun(source.runsRoot, result.record.evalRunId).runs[0]!;
		expect(derived.evidenceArtifacts).toEqual(source.record.evidenceArtifacts);
		writeFileSync(join(source.runDir, "runtime/world/state.json"), JSON.stringify({ balance: 0 }));
		expect(() => loadVerifiedEvalRun(source.runsRoot, source.evalRun.evalRunId)).toThrow(/world artifact hash mismatch/);
		await expect(regradeEvalRun({ runsRoot: source.runsRoot, evalRunId: source.evalRun.evalRunId, target })).rejects.toThrow(/world artifact hash mismatch/);
	});

	it("does not relabel legacy completion evidence as evaluator v4 through regrading", async () => {
		const source = await runOnce("answer");
		delete source.record.metrics.finalAnswer;
		writeFileSync(join(source.runDir, "run.json"), JSON.stringify(source.record));
		const index = { ...source.evalRun, runArtifacts: [{ runId: source.record.runId, sha256: hashValue(source.record) }] };
		writeFileSync(join(source.runsRoot, index.evalRunId, "eval_run.json"), JSON.stringify(index));
		await expect(regradeEvalRun({ runsRoot: source.runsRoot, evalRunId: index.evalRunId, target: loadTarget(source.targetDir) }))
			.rejects.toThrow(/predates host-observed completion/);
	});

	it("holds up its end of a simulated conversation, one Run and one trace", async () => {
		const dialogue = JSON.stringify({
			id: "task_multi",
			input: "Сколько стоит тариф?",
			simulatedUser: { goal: "Понять тариф и блокировку", persona: "Клиент", maxTurns: 3 },
			graders: [{ type: "output_contains", text: "Ход 3" }],
		});
		const { record, runDir } = await runOnce("multi", {
			dataset: dialogue,
			simulatedUserUrl: userModel.url,
		});
		expect(record.status).toBe("completed");
		expect(record.metrics.conversationTurns).toBe(3);
		expect(record.metrics.tokens).toEqual({ input: 33, output: 21, cacheRead: 0, cacheWrite: 0, total: 54 });
		expect(record.metrics.costUsd).toBeCloseTo(0.75);
		expect(record.metrics.conversationStop).toBe("max-turns");
		const messages = openTrace(runDir);
		expect(messages.map((message) => message.role)).toEqual([
			"user", "assistant", "user", "assistant", "user", "assistant",
		]);
		expect(messages[5]?.text).toContain("Ход 3");
	});

	/**
	 * Session 7, defect 19: the receipt listed `["HOME", "LANG", "PATH",
	 * "TMPDIR"]` while the child had also been handed `AHDE_WORLD`,
	 * `AHDE_PROTOCOL` and the credential name — four names out of seven, from a
	 * record whose whole job is to say what the agent was given. The child
	 * itself is the witness here.
	 */
	it("records every environment name the child actually received, and nothing else", async () => {
		const withWorld = JSON.stringify({
			id: "task_env",
			input: "Что в окружении?",
			world: { state: { balance: 100 } },
			graders: [{ type: "output_contains", text: "env=" }],
		});
		const { record, runDir } = await runOnce("env", { dataset: withWorld });
		expect(record.status).toBe("completed");
		expect(record.execution.agent).toBe("command-v1");
		expect(record.execution.environment).toEqual([
			"AHDE_PROTOCOL",
			"AHDE_WORLD",
			"FAKE_AGENT_MODE",
			"HOME",
			"LANG",
			"MOCK_MODEL_KEY",
			"PATH",
			"TMPDIR",
		]);
		// And every recorded name is one the child confirms it was handed.
		const reported = (openTrace(runDir)[1]?.text ?? "").replace(/^env=/, "").split(",");
		for (const name of record.execution.environment) expect(reported, name).toContain(name);
	});

	it("lists AHDE_WORLD for a case without a world too: the fingerprint is the run's, not the case's", async () => {
		// Live session 8: a worlded and a worldless case in one eval run produced
		// two execution fingerprints, and runSuite refused the run as "execution
		// policy changed within one eval run". The name is what the child MAY
		// receive; whether this case hands it a world is dataset identity.
		const withWorld = JSON.stringify({
			id: "task_env",
			input: "Что в окружении?",
			world: { state: { balance: 100 } },
			graders: [{ type: "output_contains", text: "env=" }],
		});
		const worlded = await runOnce("env", { dataset: withWorld });
		const worldless = await runOnce("env");
		expect(worldless.record.execution.environment).toEqual([
			"AHDE_PROTOCOL",
			"AHDE_WORLD",
			"FAKE_AGENT_MODE",
			"HOME",
			"LANG",
			"MOCK_MODEL_KEY",
			"PATH",
			"TMPDIR",
		]);
		expect(worldless.record.execution).toEqual(worlded.record.execution);
	});

	it("binds the entry executable's bytes to the run, and a different argv[0] is a different hash", async () => {
		const direct = await runOnce("plain");
		expect(direct.record.target.agentEntryHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		const viaEnv = await runOnce("plain", { argv: ["/usr/bin/env", NODE, "agent.mjs"] });
		expect(viaEnv.record.target.agentEntryHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(viaEnv.record.target.agentEntryHash).not.toBe(direct.record.target.agentEntryHash);
	});
});

describe("every way the wire can fail is infrastructure, never a behavioural failure", () => {
	const errorCase = async (mode: string, stem: RegExp, options: TargetOptions = {}) => {
		const { record } = await runOnce(mode, options);
		expect(record.status).toBe("error");
		expect(record.error).toMatch(stem);
		expect(record.evalResults?.outcome ?? "error").toBe("error");
	};

	it("refuses a child that exits before it ever speaks", async () => {
		await errorCase("exit-before-hello", /command Target (?:did not start within \d+ms|exited before its first protocol message with 7)/, { startupTimeoutMs: 3000 });
	});

	it("refuses a child that takes the handshake and dies without a word", async () => {
		await errorCase("exit-after-hello", /command Target exited before its first protocol message with 7$/, { startupTimeoutMs: 3000 });
	});

	it("records an early crash's exit code and bounded redacted stderr without inventing a timeout", async () => {
		const { record, runDir } = await runOnce("unused", { agentSource: `
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  if (JSON.parse(line).type !== "hello") return;
  process.stderr.write("agent bootstrap failed; credential=" + process.env.MOCK_MODEL_KEY + " " + "x".repeat(10_000) + "UNRECORDED_TAIL", () => process.exit(7));
});
` });
		expect(record.status).toBe("error");
		expect(record.error).toMatch(/^command Target exited before its first protocol message with 7: agent bootstrap failed;/);
		expect(record.error).not.toContain("test-key");
		expect(record.error).not.toContain("UNRECORDED_TAIL");
		expect(record.error.length).toBeLessThan(8400);
		expect(classifyRunError(record.error)).toBe("startup");
		expect(record.error).not.toMatch(/timed out|did not start within/);
		expect(record.evalResults?.outcome ?? "error").toBe("error");
		expect(readFileSync(join(runDir, "session.jsonl"), "utf8")).not.toContain("test-key");
	});

	it("times out a turn with no assistant, in the runner's own words", async () => {
		await errorCase("silent", /run timed out after 3000ms/, { timeoutMs: 3000 });
	});

	it("reports a non-zero exit mid-dialogue with the child's bounded stderr", async () => {
		await errorCase("die-after-tool", /command Target exited with 3: agent gave up/);
	});

	/**
	 * Session 7, defect 7: `metrics.toolCalls` stayed at the zero the record was
	 * born with whenever the run ended in an error, so `/traces`, the trace
	 * header and `run.json` all read `0` about a run whose trace — on the same
	 * screen — showed `get_account · 930ms · ok`. A run that brokered a call
	 * brokered it, however the run then ended.
	 */
	it("counts the tool calls a run made before it failed", async () => {
		const { record, runDir } = await runOnce("die-after-tool");
		expect(record.status).toBe("error");
		expect(record.metrics.toolCalls).toBe(1);
		// And the trace it is counting agrees: one call, answered without error.
		const messages = openTrace(runDir);
		expect(messages[1]?.toolCalls?.[0]?.name).toBe("check_dbo");
		expect(messages[2]?.toolResult?.isError).toBe(false);
	});

	it("names the line of a protocol violation and never quotes its body", async () => {
		const { record } = await runOnce("invalid-json");
		expect(record.status).toBe("error");
		expect(record.error).toMatch(/command Target protocol violation at line \d+/);
		expect(record.error).not.toContain("not json at all");
	});

	it("refuses a message type nobody declared", async () => {
		await errorCase("unknown-type", /command Target protocol violation at line \d+/);
	});

	it("refuses a message from another protocol version", async () => {
		await errorCase("bad-version", /command Target protocol violation at line \d+/);
	});

	it("blocks an undeclared tool exactly as the Pi guard does, and ends the run", async () => {
		const { record, runDir } = await runOnce("undeclared");
		expect(record.status).toBe("error");
		expect(record.error).toMatch(/AHDE Target blocked undeclared tool "definitely_not_declared"/);
		// The agent was told before the run ended, so the refusal is in the trace.
		const messages = openTrace(runDir);
		expect(messages.at(-1)?.toolResult?.isError).toBe(true);
	});

	it("surfaces an error the agent reported about itself", async () => {
		await errorCase("agent-error", /command Target reported an error: внутренняя ошибка агента/);
	});

	it("refuses output past the trace artifact bound", async () => {
		await errorCase("overflow", /command Target (exceeded \d+ output bytes|protocol violation at line \d+)/);
	});

	it("refuses more than 64 tool calls in one turn", async () => {
		await errorCase("too-many-tools", /command Target made more than 64 tool calls in one turn/);
	});
});

describe("an agent that answers nothing", () => {
	/**
	 * Live session 8: a 9B model went quiet after two tool calls, three times
	 * across two verifications, and each time the host called it an
	 * infrastructure error and stopped the comparison as "inconclusive". The
	 * silence is the agent's answer: the run completes, the graders read an
	 * empty reply and fail it, and the recovery prompt is counted once.
	 */
	it("completes the run with an empty answer that the graders fail, never an error", async () => {
		const silentCase = JSON.stringify({
			id: "task_silent",
			input: "Какой у меня тариф?",
			graders: [{ type: "output_contains", text: "Тариф" }],
		});
		const { record, runDir } = await runOnce("empty", { dataset: silentCase });
		expect(record.status).toBe("completed");
		expect(record.error).toBeNull();
		expect(record.metrics.recoveryAttempts).toBe(1);
		expect(record.evalResults?.outcome).toBe("fail");
		const trace = openTrace(runDir);
		const lastAssistant = [...trace].reverse().find((message) => message.role === "assistant");
		expect(lastAssistant?.text ?? "").toBe("");
	});
});
