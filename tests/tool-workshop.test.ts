import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileHarnessAuthoringProposal, HARNESS_AUTHORING_ALLOWED_PATHS } from "../src/application/harness-authoring.js";
import { CANDIDATE_SCOPE_POLICY } from "../src/application/candidate-experiment.js";
import { inspectTargetAuthoringContext } from "../src/application/target-authoring-context.js";
import {
	describeFixtureRun,
	readToolFixtures,
	readTryToolInput,
	runToolFixtures,
	tryTool,
} from "../src/application/tool-workshop.js";
import { parseToolFixtureFile } from "../src/application/tool-authoring.js";
import { parseCliInvocation } from "../src/cli-invocation.js";
import { loadTarget } from "../src/manifest.js";
import {
	computeTargetWorkspaceHash,
	disposeTargetWorkspaceSnapshot,
	materializeTargetWorkspaceSnapshot,
	runTask,
} from "../src/runner.js";
import { createTargetToolRuntime } from "../src/target/runtime.js";
import { bwrapArguments, macosProfile } from "../src/target/tool-broker.js";
import { ToolSetupError } from "../src/target/tool-setup.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

const created: string[] = [];

afterEach(() => {
	while (created.length > 0) cleanup(created.pop() as string);
});

function commit(dir: string): void {
	execFileSync("git", ["-C", dir, "add", "-A"]);
	execFileSync("git", [
		"-C", dir, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "--amend", "--no-edit", "-q",
	]);
}

function manifestYaml(options: {
	tools?: string[];
	data?: string[];
	network?: "deny" | "allow";
} = {}): string {
	return `id: workshop-target
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
  environmentAllowlist: []
  network: ${options.network ?? "deny"}
  sandbox: best-effort
instructions:
  agentsMd: AGENTS.md
skills: []
tools: [${(options.tools ?? ["tools/lookup/tool.yaml"]).join(", ")}]
data: [${(options.data ?? []).join(", ")}]
evalSuite:
  id: workshop-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`;
}

function directoryDescriptor(extra = ""): string {
	return `schemaVersion: 1
name: lookup
description: Return the prepared answer for a term.
parameters:
  type: object
  properties:
    term:
      type: string
      minLength: 1
      maxLength: 100
  required: [term]
  additionalProperties: false
command:
  argv: [tools/lookup/run]
timeoutMs: 10000
maxOutputBytes: 8192
output: json
permissions:
  environment: []
  network: deny
  filesystem: read-only
${extra}`;
}

const RUN_SCRIPT = `#!/bin/sh
IFS= read -r payload || exit 2
. "$AHDE_TOOL_HOME/lib.sh"
count=0
if [ -f "$AHDE_TOOL_HOME/setup-count" ]; then count=$(wc -c < "$AHDE_TOOL_HOME/setup-count" | tr -d ' '); fi
printf '{"answer":"%s","setups":%s,"payload":%s}\\n' "$ANSWER" "$count" "$payload"
`;

/** A committed Target whose only tool is the multi-file tools/lookup/ directory. */
function directoryToolFixture(options: {
	descriptorExtra?: string;
	manifest?: string;
	files?: Record<string, string>;
} = {}): string {
	const dir = makeTargetFixture(baseFixtureFiles({
		"manifest.yaml": options.manifest ?? manifestYaml(),
		"tools/lookup/tool.yaml": directoryDescriptor(options.descriptorExtra ?? ""),
		"tools/lookup/run": RUN_SCRIPT,
		"tools/lookup/lib.sh": "ANSWER=authored\n",
		...(options.files ?? {}),
	}));
	created.push(dir);
	chmodSync(join(dir, "tools/lookup/run"), 0o755);
	commit(dir);
	return dir;
}

function sandboxUnavailable(error: unknown): boolean {
	return error instanceof Error && /No usable sandbox backend/.test(error.message);
}

async function freePortWithListener(): Promise<{ port: number; close: () => Promise<void> }> {
	const server = createServer((socket) => socket.end());
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (typeof address === "string" || !address) throw new Error("could not bind a loopback probe");
	return {
		port: address.port,
		close: () => new Promise<void>((done) => server.close(() => done())),
	};
}

describe("multi-file Target tools", () => {
	it("folds every file byte and mode in tools/<name>/ into the tool identity", () => {
		const dir = directoryToolFixture();
		const first = loadTarget(dir);
		expect(first.tools).toHaveLength(1);
		expect(first.tools[0]?.layout).toBe("directory");
		expect(first.tools[0]?.directoryPath).toBe("tools/lookup");
		expect(first.tools[0]?.files.map((file) => file.path)).toEqual(["lib.sh", "run", "tool.yaml"]);
		expect(first.tools[0]?.files.find((file) => file.path === "run")?.executable).toBe(true);
		expect(first.toolsetHash).toMatch(/^sha256:[0-9a-f]{64}$/);

		// One byte in a support file is a different tool.
		writeFileSync(join(dir, "tools/lookup/lib.sh"), "ANSWER=changed\n");
		const changedBytes = loadTarget(dir);
		expect(changedBytes.toolsetHash).not.toBe(first.toolsetHash);
		expect(changedBytes.tools[0]?.digest).not.toBe(first.tools[0]?.digest);

		// So is the same byte with a different mode.
		writeFileSync(join(dir, "tools/lookup/lib.sh"), "ANSWER=authored\n");
		expect(loadTarget(dir).toolsetHash).toBe(first.toolsetHash);
		chmodSync(join(dir, "tools/lookup/lib.sh"), 0o755);
		const changedMode = loadTarget(dir);
		expect(changedMode.toolsetHash).not.toBe(first.toolsetHash);
		expect(changedMode.tools[0]?.files.find((file) => file.path === "lib.sh")?.executable).toBe(true);
	});

	it("keeps the single-file tools/<name>.tool.yaml form working unchanged", () => {
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifestYaml({ tools: ["tools/echo_json.tool.yaml"] }),
			"tools/echo_json.tool.yaml": `schemaVersion: 1
name: echo_json
description: Echo the payload.
parameters:
  type: object
  properties:
    message: { type: string, minLength: 1, maxLength: 100 }
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
`,
			"bin/echo_json": "#!/bin/sh\nIFS= read -r p || exit 2\nprintf '%s\\n' \"$p\"\n",
		}));
		created.push(dir);
		chmodSync(join(dir, "bin/echo_json"), 0o755);
		commit(dir);
		const target = loadTarget(dir);
		expect(target.tools[0]?.layout).toBe("single-file");
		expect(target.tools[0]?.files).toEqual([]);
		expect(target.tools[0]?.executablePath).toBe("bin/echo_json");
		expect(loadTarget(dir).toolsetHash).toBe(target.toolsetHash);
	});

	it("fails closed on a missing run entry, a symlink, and a non-canonical entry path", () => {
		const missingRun = directoryToolFixture();
		rmSync(join(missingRun, "tools/lookup/run"));
		commit(missingRun);
		expect(() => loadTarget(missingRun)).toThrow(/run must exist and be executable/);

		const linked = directoryToolFixture();
		symlinkSync("lib.sh", join(linked, "tools/lookup/alias.sh"));
		commit(linked);
		expect(() => loadTarget(linked)).toThrow(/must not contain a symlink/);

		const escaped = directoryToolFixture({
			descriptorExtra: "",
		});
		writeFileSync(
			join(escaped, "tools/lookup/tool.yaml"),
			directoryDescriptor().replace("argv: [tools/lookup/run]", "argv: [bin/lookup]"),
		);
		commit(escaped);
		expect(() => loadTarget(escaped)).toThrow(/argv\[0\] must be tools\/lookup\/run/);
	});

	it("pins declared lockfile bytes and rejects a missing lockfile", () => {
		const dir = directoryToolFixture({
			descriptorExtra: "lockfiles: [deps.lock]\n",
			files: { "tools/lookup/deps.lock": "pinned-v1\n" },
		});
		const first = loadTarget(dir);
		expect(first.tools[0]?.descriptor.lockfiles).toEqual(["deps.lock"]);

		rmSync(join(dir, "tools/lookup/deps.lock"));
		commit(dir);
		expect(() => loadTarget(dir)).toThrow(/declared lockfile is missing/);
	});
});

describe("declared tool setup", () => {
	const SETUP = (script: string, network: "deny" | "allow" = "deny") =>
		`setup:\n  argv: ["/bin/sh", "-c", ${JSON.stringify(script)}]\n  timeoutMs: 20000\n  network: ${network}\n`;

	it("runs a declared setup once per prepared tool home and exposes its output to the tool", async () => {
		const dir = directoryToolFixture({ descriptorExtra: SETUP("printf x >> setup-count") });
		const target = loadTarget(dir);
		const toolHomeRoot = join(dir, ".ahde-test-home");
		let first;
		try {
			first = createTargetToolRuntime({
				target,
				workspaceDir: dir,
				scratchDir: join(dir, ".ahde-test-scratch-1"),
				toolHomeRoot,
			});
		} catch (error) {
			if (sandboxUnavailable(error)) return;
			throw error;
		}
		expect(first.toolSetups.map((setup) => ({ tool: setup.tool, ran: setup.ran }))).toEqual([
			{ tool: "lookup", ran: true },
		]);
		expect(readFileSync(join(toolHomeRoot, "lookup/setup-count"), "utf8")).toBe("x");

		// A second run of the same snapshot reuses the prepared home instead of
		// paying for setup again.
		const second = createTargetToolRuntime({
			target,
			workspaceDir: dir,
			scratchDir: join(dir, ".ahde-test-scratch-2"),
			toolHomeRoot,
		});
		expect(readFileSync(join(toolHomeRoot, "lookup/setup-count"), "utf8")).toBe("x");
		expect(second.toolHomeRoot).toBe(first.toolHomeRoot);

		const definition = second.customTools[0];
		if (!definition) throw new Error("runtime registered no tool");
		const result = await definition.execute("call-1", { term: "x" }, undefined, undefined, undefined as never);
		const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
		expect(JSON.parse(text)).toEqual({ answer: "authored", setups: 1, payload: { term: "x" } });

		// Setup output is derived state: it never enters the workspace the runner hashes.
		expect(existsSync(join(dir, "tools/lookup/setup-count"))).toBe(false);
	});

	it("records a failing setup as an infrastructure error for the run", async () => {
		const dir = directoryToolFixture({ descriptorExtra: SETUP("echo boom >&2; exit 9") });
		const target = loadTarget(dir);
		try {
			expect(() => createTargetToolRuntime({
				target,
				workspaceDir: dir,
				scratchDir: join(dir, ".ahde-test-scratch"),
				toolHomeRoot: join(dir, ".ahde-test-home"),
			})).toThrow(ToolSetupError);
		} catch (error) {
			if (sandboxUnavailable(error)) return;
			throw error;
		}

		const runsRoot = join(dir, ".ahde-test-runs");
		mkdirSync(runsRoot, { recursive: true });
		const record = await runTask(target, target.tasks[0]!, {
			runsRoot,
			label: "solo",
			repetitionIndex: 0,
			evalRunId: null,
			candidateOf: null,
		});
		// No model was ever contacted: the harness could not be built.
		expect(record.status).toBe("error");
		expect(record.error).toMatch(/setup exited with 9/);
		expect(record.evalResults).toBeNull();
	});

	it("denies the network to a setup step unless the descriptor and the policy both declare it", async () => {
		const escalation = directoryToolFixture({
			descriptorExtra: SETUP("true", "allow"),
			manifest: manifestYaml({ network: "deny" }),
		});
		expect(() => loadTarget(escalation)).toThrow(/setup network=allow exceeds the target execution policy/);

		// The confinement seam itself: no declaration, no network, on both backends.
		const denied = { network: "deny" as const, readRoots: [], writeRoots: [] };
		const allowed = { network: "allow" as const, readRoots: [], writeRoots: [] };
		expect(macosProfile("/w", "/s", denied)).toContain("(deny network*)");
		expect(macosProfile("/w", "/s", allowed)).toContain("(allow network*) (allow system-socket)");
		// No route to sort without a network: the route socket stays denied.
		expect(macosProfile("/w", "/s", denied)).not.toContain("system-socket");
		const bwrapDenied = bwrapArguments({
			workspaceDir: "/w", scratchDir: "/s", environment: {}, confinement: denied, cwd: "/w", argv: ["/bin/true"],
		});
		const bwrapAllowed = bwrapArguments({
			workspaceDir: "/w", scratchDir: "/s", environment: {}, confinement: allowed, cwd: "/w", argv: ["/bin/true"],
		});
		expect(bwrapDenied).toContain("--unshare-net");
		expect(bwrapAllowed).not.toContain("--unshare-net");

		if (!existsSync("/usr/bin/nc")) return;
		const probe = await freePortWithListener();
		try {
			const blocked = directoryToolFixture({
				descriptorExtra: `setup:\n  argv: ["/usr/bin/nc", "-z", "-w", "2", "127.0.0.1", "${probe.port}"]\n  timeoutMs: 20000\n  network: deny\n`,
			});
			try {
				expect(() => createTargetToolRuntime({
					target: loadTarget(blocked),
					workspaceDir: blocked,
					scratchDir: join(blocked, ".ahde-test-scratch"),
					toolHomeRoot: join(blocked, ".ahde-test-home"),
				})).toThrow(ToolSetupError);
			} catch (error) {
				if (sandboxUnavailable(error)) return;
				throw error;
			}

			const permitted = directoryToolFixture({
				manifest: manifestYaml({ network: "allow" }),
				descriptorExtra: `setup:\n  argv: ["/usr/bin/nc", "-z", "-w", "2", "127.0.0.1", "${probe.port}"]\n  timeoutMs: 20000\n  network: allow\n`,
			});
			const runtime = createTargetToolRuntime({
				target: loadTarget(permitted),
				workspaceDir: permitted,
				scratchDir: join(permitted, ".ahde-test-scratch"),
				toolHomeRoot: join(permitted, ".ahde-test-home"),
			});
			expect(runtime.toolSetups[0]?.exitCode).toBe(0);
		} finally {
			await probe.close();
		}
	});
});

describe("declared data directories", () => {
	function dataFixture(): string {
		const dir = directoryToolFixture({ manifest: manifestYaml({ data: ["data/docs"] }) });
		mkdirSync(join(dir, "data/docs"), { recursive: true });
		mkdirSync(join(dir, "data/private"), { recursive: true });
		writeFileSync(join(dir, "data/docs/policy.md"), "# Policy\nRefunds within 14 days.\n");
		writeFileSync(join(dir, "data/private/secret.md"), "undeclared\n");
		commit(dir);
		return dir;
	}

	it("copies and hashes declared data into the workspace snapshot and leaves undeclared data behind", () => {
		const dir = dataFixture();
		const target = loadTarget(dir);
		expect(target.data).toEqual([
			expect.objectContaining({ path: "data/docs", files: 1, entries: ["policy.md"], entriesTruncated: false }),
		]);

		const runsRoot = join(dir, ".ahde-test-runs");
		mkdirSync(runsRoot, { recursive: true });
		const snapshot = materializeTargetWorkspaceSnapshot(target, runsRoot);
		try {
			expect(existsSync(join(snapshot.dir, "data/docs/policy.md"))).toBe(true);
			expect(existsSync(join(snapshot.dir, "data/private/secret.md"))).toBe(false);
		} finally {
			disposeTargetWorkspaceSnapshot(snapshot);
		}

		const before = computeTargetWorkspaceHash(target, runsRoot);
		writeFileSync(join(dir, "data/docs/policy.md"), "# Policy\nRefunds within 30 days.\n");
		expect(computeTargetWorkspaceHash(loadTarget(dir), runsRoot)).not.toBe(before);
	});

	it("bounds total declared data bytes and rejects unsafe declarations", () => {
		const dir = dataFixture();
		const previous = process.env.AHDE_DATA_MAX_BYTES;
		process.env.AHDE_DATA_MAX_BYTES = "4";
		try {
			expect(() => loadTarget(dir)).toThrow(/exceeds the 4-byte workspace budget/);
		} finally {
			if (previous === undefined) delete process.env.AHDE_DATA_MAX_BYTES;
			else process.env.AHDE_DATA_MAX_BYTES = previous;
		}

		const linked = dataFixture();
		symlinkSync("policy.md", join(linked, "data/docs/alias.md"));
		commit(linked);
		expect(() => loadTarget(linked)).toThrow(/contains a symlink/);

		const missing = dataFixture();
		rmSync(join(missing, "data/docs"), { recursive: true, force: true });
		commit(missing);
		expect(() => loadTarget(missing)).toThrow(/data/);
	});

	it("shows the Builder declared data as shape only, never as content", () => {
		const dir = dataFixture();
		const target = loadTarget(dir);
		const context = inspectTargetAuthoringContext({
			repositoryDir: dir,
			expectedTarget: { id: target.manifest.id, gitSha: target.gitSha },
		});
		expect(context.data).toEqual([
			{ path: "data/docs", files: 1, bytes: expect.any(Number), entries: ["policy.md"], entriesTruncated: false },
		]);
		expect(JSON.stringify(context)).not.toContain("Refunds within");
		expect(context.resources.some((resource) => resource.path.startsWith("data/"))).toBe(false);
		// Every file of a multi-file tool stays inspectable.
		expect(context.resources.filter((resource) => resource.path.startsWith("tools/lookup/")).map((r) => r.path))
			.toEqual(["tools/lookup/lib.sh", "tools/lookup/run", "tools/lookup/tool.yaml"]);
	});
});

describe("tool and data authoring intents", () => {
	function bareFixture(): string {
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifestYaml({ tools: [] }),
		}));
		created.push(dir);
		commit(dir);
		return dir;
	}

	const DESCRIPTOR = {
		description: "Search the declared corpus.",
		parameters: {
			type: "object",
			properties: { term: { type: "string", minLength: 1, maxLength: 100 } },
			required: ["term"],
			additionalProperties: false,
		},
		timeoutMs: 10_000,
		maxOutputBytes: 8192,
		output: "json" as const,
		permissions: { environment: [], network: "deny" as const, filesystem: "read-only" as const },
	};

	it("admits data/** in both the authoring and candidate scopes", () => {
		expect(HARNESS_AUTHORING_ALLOWED_PATHS).toContain("data/**");
		expect(CANDIDATE_SCOPE_POLICY.allowed).toContain("data/**");
	});

	it("compiles a multi-file tool.upsert into exact diffs, modes, and declarations", () => {
		const dir = bareFixture();
		const proposal = compileHarnessAuthoringProposal({
			repositoryDir: dir,
			summary: "Add a multi-file search tool",
			intents: [{
				type: "tool.upsert",
				name: "search",
				descriptor: {
					...DESCRIPTOR,
					setup: { argv: ["/bin/sh", "-c", "true"], timeoutMs: 5_000, network: "deny" },
					lockfiles: ["deps.lock"],
				},
				files: [
					{ path: "run", content: "#!/bin/sh\nIFS= read -r p || exit 2\nprintf '%s\\n' \"$p\"\n" },
					{ path: "lib/index.sh", contentBase64: Buffer.from("INDEX=1\n", "utf8").toString("base64") },
					{ path: "deps.lock", content: "pinned-v1\n" },
				],
			}],
		});
		expect(proposal.decision).toBe("propose");
		expect(proposal.changes.map((change) => change.path)).toEqual([
			"manifest.yaml",
			"tools/search/deps.lock",
			"tools/search/lib/index.sh",
			"tools/search/run",
			"tools/search/tool.yaml",
		]);
		const run = proposal.changes.find((change) => change.path === "tools/search/run");
		expect(run?.unifiedDiff).toContain("new file mode 100755");
		const support = proposal.changes.find((change) => change.path === "tools/search/lib/index.sh");
		expect(support?.unifiedDiff).toContain("new file mode 100644");
		expect(support?.unifiedDiff).toContain("+INDEX=1");
		const descriptor = proposal.changes.find((change) => change.path === "tools/search/tool.yaml");
		expect(descriptor?.unifiedDiff).toContain("+    - tools/search/run");
		expect(descriptor?.unifiedDiff).toContain("+lockfiles:\n+  - deps.lock");
		expect(descriptor?.unifiedDiff).toContain("+setup:");
		expect(proposal.changes.find((change) => change.path === "manifest.yaml")?.unifiedDiff)
			.toContain("+  - tools/search/tool.yaml");
	});

	it("compiles data.upsert and data.remove with their manifest declarations", () => {
		const dir = bareFixture();
		const added = compileHarnessAuthoringProposal({
			repositoryDir: dir,
			summary: "Seed the retrieval corpus",
			intents: [
				{ type: "data.upsert", path: "data/docs/policy.md", content: "# Policy\n" },
				{ type: "data.upsert", path: "data/docs/faq.md", contentBase64: Buffer.from("# FAQ\n").toString("base64") },
			],
		});
		expect(added.changes.map((change) => change.path)).toEqual([
			"data/docs/faq.md",
			"data/docs/policy.md",
			"manifest.yaml",
		]);
		expect(added.changes.find((change) => change.path === "manifest.yaml")?.unifiedDiff)
			.toContain("+  - data/docs");
		expect(added.changes.find((change) => change.path === "data/docs/faq.md")?.unifiedDiff).toContain("+# FAQ");

		// Apply it, then remove the last file: the declaration goes with it.
		execFileSync("git", ["-C", dir, "apply", "--index", "-"], {
			input: `${added.changes.map((change) => change.unifiedDiff.trimEnd()).join("\n")}\n`,
		});
		commit(dir);
		const removed = compileHarnessAuthoringProposal({
			repositoryDir: dir,
			summary: "Drop the corpus",
			intents: [
				{ type: "data.remove", path: "data/docs/policy.md" },
				{ type: "data.remove", path: "data/docs/faq.md" },
			],
		});
		expect(removed.changes.map((change) => change.path)).toEqual([
			"data/docs/faq.md",
			"data/docs/policy.md",
			"manifest.yaml",
		]);
		expect(removed.changes.find((change) => change.path === "manifest.yaml")?.unifiedDiff)
			.not.toContain("+  - data/docs");
	});

	it("rejects every path outside the tool and data scopes", () => {
		const dir = bareFixture();
		const upsertWith = (path: string) => () => compileHarnessAuthoringProposal({
			repositoryDir: dir,
			summary: "Escape",
			intents: [{
				type: "tool.upsert",
				name: "search",
				descriptor: DESCRIPTOR,
				files: [
					{ path: "run", content: "#!/bin/sh\nexit 0\n" },
					{ path, content: "x\n" },
				],
			}],
		});
		expect(upsertWith("../../etc/passwd")).toThrow();
		expect(upsertWith("../evil")).toThrow();
		expect(upsertWith("/etc/passwd")).toThrow();
		expect(upsertWith("nested/../../escape")).toThrow();
		expect(upsertWith("tool.yaml")).toThrow(/compiled from descriptor/);

		const dataWith = (path: string) => () => compileHarnessAuthoringProposal({
			repositoryDir: dir,
			summary: "Escape",
			intents: [{ type: "data.upsert", path, content: "x\n" }],
		});
		expect(dataWith("evals/development.jsonl")).toThrow();
		expect(dataWith("data/../evals/development.jsonl")).toThrow();
		expect(dataWith("data/docs")).toThrow();
		expect(dataWith("/data/docs/a.md")).toThrow();
		expect(dataWith("data/docs/../../AGENTS.md")).toThrow();
	});

	it("refuses to author over a tool that exists in the other layout", () => {
		const dir = directoryToolFixture();
		expect(() => compileHarnessAuthoringProposal({
			repositoryDir: dir,
			summary: "Flatten",
			intents: [{
				type: "tool.upsert",
				name: "lookup",
				descriptor: DESCRIPTOR,
				executable: "#!/bin/sh\nexit 0\n",
			}],
		})).toThrow(/remove it before re-authoring/);
	});

	it("removes an entire multi-file tool directory in one reviewed diff", () => {
		const dir = directoryToolFixture();
		const proposal = compileHarnessAuthoringProposal({
			repositoryDir: dir,
			summary: "Drop the tool",
			intents: [{ type: "tool.remove", name: "lookup" }],
		});
		expect(proposal.changes.map((change) => change.path)).toEqual([
			"manifest.yaml",
			"tools/lookup/lib.sh",
			"tools/lookup/run",
			"tools/lookup/tool.yaml",
		]);
		for (const change of proposal.changes.filter((candidate) => candidate.path !== "manifest.yaml")) {
			expect(change.unifiedDiff).toContain("+++ /dev/null");
		}
	});
});

describe("tryTool", () => {
	it("runs a declared tool in a private scratch copy and never touches the operator's checkout", async () => {
		const dir = directoryToolFixture();
		let result;
		try {
			result = await tryTool({ repositoryDir: dir, tool: "lookup", input: { term: "refunds" } });
		} catch (error) {
			if (sandboxUnavailable(error)) return;
			throw error;
		}
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ answer: "authored", setups: 0, payload: { term: "refunds" } });
		expect(result.layout).toBe("directory");
		expect(result.source).toEqual({ kind: "head", ref: null, changedPaths: [] });
		expect(result.target.toolsetHash).toBe(loadTarget(dir).toolsetHash);

		// The checkout is untouched: no dirt, no leftover worktree, no run evidence.
		expect(execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
		expect(execFileSync("git", ["-C", dir, "worktree", "list"], { encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
		expect(existsSync(join(dir, "runs"))).toBe(false);
	});

	it("bounds and redacts what a tool prints", async () => {
		const dir = directoryToolFixture();
		writeFileSync(
			join(dir, "tools/lookup/run"),
			`#!/bin/sh
IFS= read -r payload || exit 2
printf 'api_key: "sk-livesecret000000000000"\\n' >&2
printf '{"token":"ghp_%s"}\\n' "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
`,
		);
		chmodSync(join(dir, "tools/lookup/run"), 0o755);
		commit(dir);
		let result;
		try {
			result = await tryTool({ repositoryDir: dir, tool: "lookup", input: { term: "x" } });
		} catch (error) {
			if (sandboxUnavailable(error)) return;
			throw error;
		}
		expect(result.stderr).not.toContain("sk-livesecret");
		expect(result.stderr).toContain("[REDACTED]");
		expect(result.stdout).not.toContain("ghp_aaaaaaaaaa");
	});

	it("returns a non-zero exit as data instead of throwing, and names undeclared tools", async () => {
		const dir = directoryToolFixture();
		writeFileSync(join(dir, "tools/lookup/run"), "#!/bin/sh\necho nope >&2\nexit 3\n");
		chmodSync(join(dir, "tools/lookup/run"), 0o755);
		commit(dir);
		let result;
		try {
			result = await tryTool({ repositoryDir: dir, tool: "lookup", input: { term: "x" } });
		} catch (error) {
			if (sandboxUnavailable(error)) return;
			throw error;
		}
		expect(result.exitCode).toBe(3);
		expect(result.stderr.trim()).toBe("nope");

		await expect(tryTool({ repositoryDir: dir, tool: "missing_tool", input: {} }))
			.rejects.toThrow(/declares no tool named missing_tool; declared: lookup/);
	});

	it("tries a tool that exists only in a proposal draft, leaving the repository clean", async () => {
		const dir = makeTargetFixture(baseFixtureFiles({ "manifest.yaml": manifestYaml({ tools: [] }) }));
		created.push(dir);
		commit(dir);
		let result;
		try {
			result = await tryTool({
				repositoryDir: dir,
				tool: "draft_tool",
				input: { term: "hello" },
				source: {
					kind: "draft",
					intents: [{
						type: "tool.upsert",
						name: "draft_tool",
						descriptor: {
							description: "Echo a term from a drafted multi-file tool.",
							parameters: {
								type: "object",
								properties: { term: { type: "string", minLength: 1, maxLength: 100 } },
								required: ["term"],
								additionalProperties: false,
							},
							timeoutMs: 10_000,
							maxOutputBytes: 8192,
							output: "json",
							permissions: { environment: [], network: "deny", filesystem: "read-only" },
						},
						files: [
							{ path: "run", content: "#!/bin/sh\nIFS= read -r p || exit 2\n. \"$AHDE_TOOL_HOME/lib.sh\"\nprintf '{\"kind\":\"%s\",\"payload\":%s}\\n' \"$KIND\" \"$p\"\n" },
							{ path: "lib.sh", content: "KIND=draft\n" },
						],
					}],
				},
			});
		} catch (error) {
			if (sandboxUnavailable(error)) return;
			throw error;
		}
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ kind: "draft", payload: { term: "hello" } });
		expect(result.source.kind).toBe("draft");
		expect(result.source.changedPaths).toEqual([
			"manifest.yaml",
			"tools/draft_tool/lib.sh",
			"tools/draft_tool/run",
			"tools/draft_tool/tool.yaml",
		]);
		expect(execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
		expect(existsSync(join(dir, "tools/draft_tool"))).toBe(false);
	});
});

describe("ahde tool try invocation", () => {
	it("parses the operator command and rejects malformed forms", () => {
		const parsed = parseCliInvocation([
			"tool", "try", "--target", "/tmp/agent", "--tool", "lookup", "--input", '{"term":"x"}', "--branch", "eg/x",
		]);
		expect(parsed).toMatchObject({
			kind: "command",
			command: "tool",
			action: "try",
			flags: { target: "/tmp/agent", tool: "lookup", input: '{"term":"x"}', branch: "eg/x" },
		});

		expect(() => parseCliInvocation(["tool"])).toThrow(/missing action for tool; expected try/);
		expect(() => parseCliInvocation(["tool", "run", "--target", "/tmp/a"])).toThrow(/unknown action "run" for tool/);
		expect(() => parseCliInvocation(["tool", "try", "--target", "/tmp/a", "--tool", "lookup"]))
			.toThrow(/tool try requires exactly one of --input <json\|@path> or --fixtures/);
		expect(() => parseCliInvocation(["tool", "try", "--target", "/tmp/a", "--tool", "lookup", "--input", "{}", "--fixtures"]))
			.toThrow(/tool try requires exactly one of --input <json\|@path> or --fixtures/);
		expect(parseCliInvocation(["tool", "try", "--target", "/tmp/agent", "--tool", "lookup", "--fixtures"])).toMatchObject({
			command: "tool",
			action: "try",
			flags: { target: "/tmp/agent", tool: "lookup", fixtures: "true" },
		});
		expect(() => parseCliInvocation(["tool", "try", "--target", "/tmp/a", "--tool", "lookup", "--input", "{}", "--project", "p"]))
			.toThrow(/unknown flag --project for tool/);
	});

	it("reads --input as inline JSON or @path and rejects anything else", () => {
		expect(readTryToolInput('{"term":"x"}')).toEqual({ term: "x" });
		const dir = makeTargetFixture([{ path: "input.json", content: '{"term":"from-file"}' }], false);
		created.push(dir);
		expect(readTryToolInput(`@${join(dir, "input.json")}`)).toEqual({ term: "from-file" });
		expect(() => readTryToolInput("not json")).toThrow(/tool input must be JSON/);
		expect(() => readTryToolInput(`@${join(dir, "missing.json")}`)).toThrow();
	});
});

describe("tool directory statistics", () => {
	it("keeps a prepared tool home private to the harness, never inside the workspace", () => {
		const dir = directoryToolFixture();
		const target = loadTarget(dir);
		const runsRoot = join(dir, ".ahde-test-runs");
		mkdirSync(runsRoot, { recursive: true });
		const snapshot = materializeTargetWorkspaceSnapshot(target, runsRoot);
		try {
			expect(snapshot.toolHomeDir).not.toContain(snapshot.dir);
			expect(statSync(snapshot.toolHomeDir).isDirectory()).toBe(true);
		} finally {
			disposeTargetWorkspaceSnapshot(snapshot);
		}
		expect(existsSync(snapshot.toolHomeDir)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Contract fixtures: a tool package carries its own tests.

const FIXTURE_RUN_SCRIPT = `#!/bin/sh
IFS= read -r payload || exit 2
. "$AHDE_TOOL_HOME/lib.sh"
case "$payload" in *'"boom"'*) printf 'no such term\\n' >&2; exit 3;; esac
printf '{"answer":"%s","payload":%s}\\n' "$ANSWER" "$payload"
`;

/** The same tool, plus the two fixtures the convention asks every package for. */
function fixtureToolFixture(extra: Record<string, string> = {}): string {
	const dir = directoryToolFixture({
		files: {
			"tools/lookup/run": FIXTURE_RUN_SCRIPT,
			"tools/lookup/fixtures/answers.json": `${JSON.stringify({
				input: { term: "refunds" },
				expect: { exitCode: 0, json: { answer: "authored" } },
			}, null, 2)}\n`,
			"tools/lookup/fixtures/rejects-unknown.json": `${JSON.stringify({
				input: { term: "boom" },
				expect: { exitCode: 3, stderrContains: "no such term" },
			}, null, 2)}\n`,
			...extra,
		},
	});
	chmodSync(join(dir, "tools/lookup/run"), 0o755);
	commit(dir);
	return dir;
}

describe("tool contract fixtures", () => {
	it("reads the small on-disk form and derives the name and what it covers", () => {
		const happy = parseToolFixtureFile("answers", '{"input":{"term":"x"},"expect":{"exitCode":0}}');
		expect(happy).toMatchObject({ name: "answers", covers: "happy-path" });
		const sad = parseToolFixtureFile("rejects-unknown", '{"input":{},"expect":{"exitCode":3}}');
		expect(sad).toMatchObject({ name: "rejects-unknown", covers: "error-handling" });
		// A file that names itself something else is a rename nobody finished.
		expect(() => parseToolFixtureFile("answers", '{"name":"other","input":{},"expect":{}}'))
			.toThrow(/fixtures\/answers.json names itself other/);
		expect(() => parseToolFixtureFile("answers", "not json")).toThrow(/is not valid JSON/);
	});

	it("joins the tool's own identity, so changing a fixture changes the tool", () => {
		const dir = fixtureToolFixture();
		const tool = loadTarget(dir).tools[0]!;
		expect(tool.files.map((file) => file.path)).toEqual([
			"fixtures/answers.json",
			"fixtures/rejects-unknown.json",
			"lib.sh",
			"run",
			"tool.yaml",
		]);
		const before = tool.digest;
		writeFileSync(
			join(dir, "tools/lookup/fixtures/answers.json"),
			'{"input":{"term":"payments"},"expect":{"exitCode":0}}\n',
		);
		commit(dir);
		expect(loadTarget(dir).tools[0]!.digest).not.toBe(before);
	});

	it("runs every fixture of one tool against an exact revision and judges it deterministically", async () => {
		const dir = fixtureToolFixture();
		expect(readToolFixtures(dir, "lookup").map((fixture) => fixture.name))
			.toEqual(["answers", "rejects-unknown"]);
		let run;
		try {
			run = await runToolFixtures({ repositoryDir: dir, tool: "lookup" });
		} catch (error) {
			if (sandboxUnavailable(error)) return;
			throw error;
		}
		expect(run).toMatchObject({ tool: "lookup", total: 2, passed: 2, allPassed: true });
		expect(describeFixtureRun(run)).toBe("✓ 2/2 fixtures");
		expect(run.fixtures.map((fixture) => [fixture.name, fixture.passed, fixture.exitCode]))
			.toEqual([["answers", true, 0], ["rejects-unknown", true, 3]]);
		// The checkout stays exactly as clean as a single try leaves it.
		expect(execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
	});

	it("names the failing fixture and what it expected, and says when there are none", async () => {
		const dir = fixtureToolFixture({
			"tools/lookup/fixtures/answers.json": `${JSON.stringify({
				input: { term: "refunds" },
				expect: { exitCode: 0, json: { answer: "rewritten" } },
			}, null, 2)}\n`,
		});
		let run;
		try {
			run = await runToolFixtures({ repositoryDir: dir, tool: "lookup" });
		} catch (error) {
			if (sandboxUnavailable(error)) return;
			throw error;
		}
		expect(run).toMatchObject({ total: 2, passed: 1, allPassed: false });
		expect(run.fixtures[0]?.failures).toEqual([
			'stdout JSON.answer is "authored", expected "rewritten"',
		]);
		expect(describeFixtureRun(run)).toBe(
			'✗ 1/2 — answers: stdout JSON.answer is "authored", expected "rewritten"',
		);

		const bare = directoryToolFixture();
		expect(readToolFixtures(bare, "lookup")).toEqual([]);
		await expect(runToolFixtures({ repositoryDir: bare, tool: "lookup" }))
			.rejects.toThrow(/tools\/lookup declares no contract fixtures/);
	});
});
