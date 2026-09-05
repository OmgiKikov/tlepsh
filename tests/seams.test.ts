import { describe, expect, it } from "vitest";
import { CorpusTaskSchema } from "../src/corpus.js";
import { BuilderCorpusDraftTaskInputSchema } from "../src/application/builder-corpus-draft.js";
import {
	DEFAULT_PI_HARNESS_FILES,
	ExecutionPolicyBlock,
	executionKindOf,
	harnessFilesOf,
	loadTarget,
	MAX_WORLD_BYTES,
	MAX_WORLD_DEPTH,
	TargetManifest,
	TaskSchema,
	WorldSchema,
} from "../src/manifest.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

/**
 * The seam commit lands three optional manifest fields and nothing that reads
 * them. These tests pin the shape four later lanes fork from: what each field
 * refuses, what the two accessors answer when a field is absent, and the guard
 * that keeps a command Target from quietly running as Pi.
 */

const MANIFEST_HEAD = `id: test-target
model:
  provider: qwen-internal
  id: qwen3.5-27b
  api: openai-completions
  baseUrl: http://127.0.0.1:9901/v1
  apiKeyEnv: TEST_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 300000
instructions:
  agentsMd: AGENTS.md
skills: [skills/check-dbo]
evalSuite:
  id: test-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`;

function issues(result: { success: boolean; error?: { issues: { message: string }[] } }): string {
	return (result.error?.issues ?? []).map((issue) => issue.message).join(" | ");
}

describe("execution.kind: the command Target seam", () => {
	it("reads an absent kind as pi, so no existing manifest changed backend", () => {
		expect(executionKindOf(ExecutionPolicyBlock.parse({}))).toBe("pi");
		const dir = makeTargetFixture(baseFixtureFiles());
		try {
			expect(executionKindOf(loadTarget(dir).manifest.execution)).toBe("pi");
		} finally {
			cleanup(dir);
		}
	});

	it("accepts a complete command block and reports its kind", () => {
		const execution = ExecutionPolicyBlock.parse({
			kind: "command",
			command: { argv: ["./bin/agent", "--serve"], protocolVersion: 1 },
		});
		expect(executionKindOf(execution)).toBe("command");
		expect(execution.command?.argv).toEqual(["./bin/agent", "--serve"]);
		expect(execution.command?.startupTimeoutMs).toBe(30_000);
	});

	it("refuses kind: command with no command block", () => {
		const result = ExecutionPolicyBlock.safeParse({ kind: "command" });
		expect(result.success).toBe(false);
		expect(issues(result)).toMatch(/requires an execution.command block/);
	});

	it("refuses a command block that no kind selects", () => {
		const result = ExecutionPolicyBlock.safeParse({
			command: { argv: ["./bin/agent"], protocolVersion: 1 },
		});
		expect(result.success).toBe(false);
		expect(issues(result)).toMatch(/only read under execution.kind: command/);
	});

	it("refuses a command Target that declares no containment", () => {
		const result = ExecutionPolicyBlock.safeParse({
			kind: "command",
			sandbox: "off",
			command: { argv: ["./bin/agent"], protocolVersion: 1 },
		});
		expect(result.success).toBe(false);
		expect(issues(result)).toMatch(/a command Target declares no containment/);
	});

	it("refuses an unknown protocol version and an empty argv", () => {
		expect(
			ExecutionPolicyBlock.safeParse({ kind: "command", command: { argv: [], protocolVersion: 1 } }).success,
		).toBe(false);
		expect(
			ExecutionPolicyBlock.safeParse({ kind: "command", command: { argv: ["a"], protocolVersion: 3 } }).success,
		).toBe(false);
	});

	// The command-adapter lane landed the backend, so this now resolves. The
	// argv[0] rule is enforced at spawn, not at load: a manifest naming an
	// executable this host does not have is still a readable manifest.
	it("loadTarget resolves a command Target now that a backend reads the block", () => {
		const dir = makeTargetFixture(
			baseFixtureFiles({
				"manifest.yaml": `${MANIFEST_HEAD}execution:
  kind: command
  command:
    argv: ["python3", "agent.py"]
    protocolVersion: 1
`,
			}),
		);
		try {
			const target = loadTarget(dir);
			expect(executionKindOf(target.manifest.execution)).toBe("command");
			expect(target.manifest.execution.command?.argv).toEqual(["python3", "agent.py"]);
			expect(target.manifest.execution.command?.startupTimeoutMs).toBe(30_000);
		} finally {
			cleanup(dir);
		}
	});
});

describe("harness: the declared editable surface", () => {
	function manifestWithHarness(files: string): unknown {
		return TargetManifest.safeParse({
			id: "t",
			model: {
				provider: "p",
				id: "m",
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1/v1",
				apiKeyEnv: "K",
				thinkingLevel: "off",
				timeoutMs: 1,
			},
			instructions: { agentsMd: "AGENTS.md" },
			evalSuite: { id: "s", dataset: "d.jsonl", graders: "g.yaml" },
			harness: { files: [files] },
		});
	}

	it("accepts relative paths and globs", () => {
		for (const glob of ["AGENTS.md", "skills/**", "prompts/*.md", "config/agent.yaml", "bin/**"]) {
			expect((manifestWithHarness(glob) as { success: boolean }).success).toBe(true);
		}
	});

	it("refuses traversal, an absolute path, and an empty declaration", () => {
		for (const glob of ["../x", "skills/../../etc", "/abs/path", ""]) {
			expect((manifestWithHarness(glob) as { success: boolean }).success).toBe(false);
		}
	});

	it("refuses a surface that reaches the dataset, the graders or the manifest", () => {
		// The fixture's dataset is `d.jsonl` and its graders `g.yaml`, at the root.
		for (const glob of ["d.jsonl", "g.yaml", "manifest.yaml", "**", "*"]) {
			const result = manifestWithHarness(glob) as { success: boolean; error?: { issues: { message: string }[] } };
			expect(result.success, glob).toBe(false);
			expect(result.error?.issues.some((issue) => /harness\.files reaches/.test(issue.message)), glob).toBe(true);
		}
		expect((manifestWithHarness("prompts/**") as { success: boolean }).success).toBe(true);
	});

	it("answers the Pi default when the manifest declares nothing", () => {
		expect(harnessFilesOf({})).toEqual(DEFAULT_PI_HARNESS_FILES);
		const dir = makeTargetFixture(baseFixtureFiles());
		try {
			const manifest = loadTarget(dir).manifest;
			expect(manifest.harness).toBeUndefined();
			expect(harnessFilesOf(manifest)).toEqual(["AGENTS.md", "skills/**", "tools/**", "bin/**"]);
		} finally {
			cleanup(dir);
		}
	});

	it("answers the declared list when the manifest has one", () => {
		const dir = makeTargetFixture(
			baseFixtureFiles({
				"manifest.yaml": `${MANIFEST_HEAD}harness:
  files:
    - prompts/system.md
    - config/**
`,
			}),
		);
		try {
			expect(harnessFilesOf(loadTarget(dir).manifest)).toEqual(["prompts/system.md", "config/**"]);
		} finally {
			cleanup(dir);
		}
	});
});

describe("world: the case-as-world seam", () => {
	it("accepts a bounded state with expectations", () => {
		const world = WorldSchema.parse({
			state: { account: { id: "42", balance: 100 } },
			expect: [
				{ path: "account.balance", op: "equals", value: 90 },
				{ path: "account.frozen", op: "exists" },
			],
		});
		expect(world.state).toEqual({ account: { id: "42", balance: 100 } });
		expect(world.expect).toHaveLength(2);
	});

	it("refuses a state over the byte bound", () => {
		const result = WorldSchema.safeParse({ state: { blob: "x".repeat(MAX_WORLD_BYTES + 1) } });
		expect(result.success).toBe(false);
		expect(issues(result)).toMatch(new RegExp(`over the ${MAX_WORLD_BYTES} byte bound`));
	});

	it("accepts state nested to the depth bound and refuses one level more", () => {
		expect(WorldSchema.safeParse({ state: { a: { b: { c: { d: { e: 1 } } } } } }).success).toBe(true);
		const result = WorldSchema.safeParse({ state: { a: { b: { c: { d: { e: { f: 1 } } } } } } });
		expect(result.success).toBe(false);
		expect(issues(result)).toMatch(new RegExp(`nests deeper than ${MAX_WORLD_DEPTH} levels`));
	});

	// JSON.parse, not an object literal: `{ __proto__: 1 }` in source sets the
	// prototype instead of creating the own property the check has to see.
	it("refuses a reserved property name at any depth", () => {
		const deep = WorldSchema.safeParse(JSON.parse('{"state":{"a":{"b":{"__proto__":1}}}}'));
		expect(deep.success).toBe(false);
		expect(issues(deep)).toMatch(/state.a.b.__proto__ is a reserved property name/);

		const flat = WorldSchema.safeParse(JSON.parse('{"state":{"__proto__":1}}'));
		expect(flat.success).toBe(false);
		expect(issues(flat)).toMatch(/__proto__ is a reserved property name/);

		expect(WorldSchema.safeParse({ state: { constructor: 1 } }).success).toBe(false);
		expect(WorldSchema.safeParse({ state: { a: { prototype: 1 } } }).success).toBe(false);
	});

	it("refuses a comparison with nothing to compare against", () => {
		for (const op of ["equals", "contains"]) {
			const result = WorldSchema.safeParse({ state: {}, expect: [{ path: "a", op }] });
			expect(result.success).toBe(false);
			expect(issues(result)).toMatch(/must carry one/);
		}
	});

	it("refuses an exists expectation that carries a value", () => {
		const result = WorldSchema.safeParse({ state: {}, expect: [{ path: "a", op: "exists", value: 1 }] });
		expect(result.success).toBe(false);
		expect(issues(result)).toMatch(/takes no value/);
	});

	it("refuses a wildcard in an expectation path", () => {
		expect(WorldSchema.safeParse({ state: {}, expect: [{ path: "a.*", op: "exists" }] }).success).toBe(false);
	});

	const CASE_WITH_WORLD = {
		input: "Списание по договору 42",
		world: {
			state: { contract: { id: 42, blocked: false } },
			expect: [{ path: "contract.blocked", op: "equals" as const, value: true }],
		},
		graders: [{ type: "output_contains" as const, text: "договор" }],
	};

	it("survives TaskSchema, CorpusTaskSchema and the Builder draft input unchanged", () => {
		const task = TaskSchema.parse({ id: "task_001", ...CASE_WITH_WORLD });
		expect(task.world).toEqual(CASE_WITH_WORLD.world);

		// CorpusTaskSchema extends TaskSchema, so it inherits the field; this test
		// is what proves the inheritance rather than a second declaration.
		const corpusTask = CorpusTaskSchema.parse({ id: "task_001", ...CASE_WITH_WORLD });
		expect(corpusTask.world).toEqual(CASE_WITH_WORLD.world);

		// The Builder draft input lists its fields explicitly, so this one is a
		// mirror that has to be maintained by hand.
		const draftTask = BuilderCorpusDraftTaskInputSchema.parse(CASE_WITH_WORLD);
		expect(draftTask.world).toEqual(CASE_WITH_WORLD.world);
	});

	it("refuses an out-of-bounds world on the Builder draft path too", () => {
		const result = BuilderCorpusDraftTaskInputSchema.safeParse({
			...CASE_WITH_WORLD,
			world: { state: { a: { b: { c: { d: { e: { f: 1 } } } } } } },
		});
		expect(result.success).toBe(false);
	});
});
