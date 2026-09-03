import { describe, expect, it } from "vitest";
import { commandTargetEnvironmentNames } from "../src/target/session-command.js";
import {
	AHDE_EVALUATOR_ID,
	axisDifferences,
	canonicalJson,
	comparable,
	hashValue,
	provenanceAxes,
	provenanceKey,
	ProvenanceAxesSchema,
	RunRecordSchema,
	type RunRecord,
} from "../src/provenance.js";

function record(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		schemaVersion: 1,
		runId: "run_test",
		taskId: "task_001",
		repetitionIndex: 0,
		label: "baseline",
		status: "completed",
		error: null,
		startedAt: "2026-08-25T10:00:00Z",
		finishedAt: "2026-08-25T10:00:05Z",
		target: { id: "ombudsman", gitSha: "aaa111" },
		runtime: { piVersion: "0.84.3", piSha: "sha-abc", ahdeVersion: "0.1.0", ahdeCodeHash: "sha256:code-a" },
		model: {
			provider: "qwen-internal",
			id: "qwen3.5-27b",
			api: "openai-completions",
			baseUrl: "http://mock/v1",
			apiKeyEnv: "TEST_KEY",
			thinkingLevel: "off",
			params: {},
			spec: {},
		},
		execution: {
			workspace: "isolated-copy-v1",
			tools: ["read", "bash", "edit", "write"],
			environment: ["process-env"],
			sandbox: "none",
			network: "allow",
			filesystem: "workspace-confined-v1",
			resources: {
				contextFiles: "disabled",
				extensions: "disabled",
				promptTemplates: "disabled",
				skills: "manifest-only",
			},
		},
		eval: { suiteId: "s", suiteHash: "sha256:1", dataset: "development", datasetHash: "sha256:2" },
		trace: { path: "session.jsonl", sessionId: null, sha256: null },
		metrics: {
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			costUsd: 0,
			latencyMs: 0,
			toolCalls: 0,
			toolErrors: 0,
			recoveryAttempts: 0,
		},
		evalResults: null,
		parent: null,
		...overrides,
	};
}

describe("canonicalJson", () => {
	it("sorts object keys recursively", () => {
		expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
	});

	it("preserves array order", () => {
		expect(canonicalJson({ x: [3, 1, 2] })).toBe('{"x":[3,1,2]}');
	});

	it("drops undefined values", () => {
		expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
	});

	it("is stable across key insertion order", () => {
		expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
	});
});

describe("provenanceKey", () => {
	it("is deterministic for identical axes", () => {
		expect(provenanceKey(record())).toBe(provenanceKey(record()));
	});

	it("ignores target git sha (baseline vs candidate must be comparable)", () => {
		const candidate = record({ target: { id: "ombudsman", gitSha: "bbb222" }, label: "candidate" });
		expect(comparable(provenanceAxes(record()), provenanceAxes(candidate))).toBe(true);
	});

	it("ignores run-level data like metrics and status", () => {
		const other = record({ status: "error", metrics: { ...record().metrics, toolCalls: 99 } });
		expect(axisDifferences(provenanceAxes(record()), provenanceAxes(other))).toEqual([]);
	});
});

describe("axisDifferences (table-driven: each axis must be caught)", () => {
	const cases: Array<{ axis: string; mutate: () => RunRecord }> = [
		{
			axis: "runtime.piVersion",
			mutate: () => record({ runtime: { ...record().runtime, piVersion: "0.85.0" } }),
		},
		{ axis: "runtime.piSha", mutate: () => record({ runtime: { ...record().runtime, piSha: "sha-xyz" } }) },
		{
			axis: "runtime.ahdeVersion",
			mutate: () => record({ runtime: { ...record().runtime, ahdeVersion: "0.2.0" } }),
		},
		{ axis: "model.provider", mutate: () => record({ model: { ...record().model, provider: "other" } }) },
		{ axis: "model.id", mutate: () => record({ model: { ...record().model, id: "qwen-99b" } }) },
		{ axis: "model.api", mutate: () => record({ model: { ...record().model, api: "openai-responses" } }) },
		{ axis: "model.baseUrl", mutate: () => record({ model: { ...record().model, baseUrl: "http://other/v1" } }) },
		{ axis: "model.spec", mutate: () => record({ model: { ...record().model, spec: { maxTokens: 10 } } }) },
		{
			axis: "model.thinkingLevel",
			mutate: () => record({ model: { ...record().model, thinkingLevel: "low" } }),
		},
		{
			axis: "model.params",
			mutate: () => record({ model: { ...record().model, params: { temperature: 0.2 } } }),
		},
		{
			axis: "execution",
			mutate: () => record({ execution: { ...record().execution, tools: ["read"] } }),
		},
		{
			axis: "eval.suiteHash",
			mutate: () => record({ eval: { ...record().eval, suiteHash: "sha256:changed" } }),
		},
		{
			axis: "eval.datasetHash",
			mutate: () => record({ eval: { ...record().eval, datasetHash: "sha256:changed" } }),
		},
	];

	for (const { axis, mutate } of cases) {
		it(`catches changed ${axis}`, () => {
			const diffs = axisDifferences(provenanceAxes(record()), provenanceAxes(mutate()));
			expect(diffs).toEqual([axis]);
			expect(comparable(provenanceAxes(record()), provenanceAxes(mutate()))).toBe(false);
		});
	}

	it("evaluatorId is an axis, ahdeCodeHash is not", () => {
		const axes = provenanceAxes(record());
		expect(axes.evaluatorId).toBe(AHDE_EVALUATOR_ID);
		expect(Object.keys(axes)).toContain("evaluatorId");
		expect(Object.keys(axes)).not.toContain("ahdeCodeHash");
		expect(Object.keys(ProvenanceAxesSchema.shape)).toContain("evaluatorId");
		expect(Object.keys(ProvenanceAxesSchema.shape)).not.toContain("ahdeCodeHash");

		// An unrelated AHDE source edit no longer invalidates every baseline…
		const rehashed = record({ runtime: { ...record().runtime, ahdeCodeHash: "sha256:code-b" } });
		expect(axisDifferences(axes, provenanceAxes(rehashed))).toEqual([]);
		// …while a deliberate evaluator bump makes older evidence incomparable.
		expect(axisDifferences(axes, { ...axes, evaluatorId: `${AHDE_EVALUATOR_ID}-next` }))
			.toEqual(["runtime.evaluatorId"]);
	});

	it("names the exact evaluator generation, so an abstaining judge is a new axis value", () => {
		// The prompts moved when the judge learned to say "I cannot tell", so the
		// id had to move with them. Pinned by value: a silent bump would make old
		// evidence comparable with evidence answering a different question.
		expect(AHDE_EVALUATOR_ID).toBe("ahde-evaluator-v3");
	});

	it("catches changed judge configuration", () => {
		const base = provenanceAxes(record());
		const changed = provenanceAxes({
			...record(),
			judge: { ...record().model, id: "judge-v2" },
		});
		expect(axisDifferences(base, changed)).toEqual(["eval.judge"]);
	});

	it("reports multiple differing axes", () => {
		const other = record({
			runtime: { ...record().runtime, piVersion: "0.85.0", piSha: "sha-xyz" },
			model: { ...record().model, id: "other" },
		});
		expect(axisDifferences(provenanceAxes(record()), provenanceAxes(other)).sort()).toEqual(["model.id", "runtime.piSha", "runtime.piVersion"]);
	});
});

describe("hashValue", () => {
	it("produces sha256-prefixed stable hashes", () => {
		const h = hashValue({ a: 1 });
		expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(h).toBe(hashValue({ a: 1 }));
	});
});

describe("RunRecordSchema artifact paths", () => {
	function persistedRecord(): RunRecord {
		const value = record({
			target: { id: "ombudsman", gitSha: "a".repeat(40) },
			runtime: {
				...record().runtime,
				piSha: "b".repeat(40),
				ahdeCodeHash: `sha256:${"c".repeat(64)}`,
			},
			eval: {
				...record().eval,
				suiteHash: `sha256:${"d".repeat(64)}`,
				datasetHash: `sha256:${"e".repeat(64)}`,
			},
		});
		return RunRecordSchema.parse(value);
	}

	it("rejects traversal in the run id and fixed trace path", () => {
		const base = persistedRecord();
		expect(() => RunRecordSchema.parse({ ...base, runId: "../../outside" })).toThrow();
		expect(() => RunRecordSchema.parse({
			...base,
			trace: { ...base.trace, path: "../session.jsonl" },
		})).toThrow();
	});
});

/**
 * The three facts that stopped being universally true when a Target could be a
 * child process: which agent answered, what its entry bytes were, and whether
 * it reported any spend at all.
 */
describe("a run whose agent is not Pi", () => {
	/** A record the schema actually admits, unlike the axis-only fixture above. */
	function valid(overrides: Partial<RunRecord> = {}): RunRecord {
		const base = record();
		return {
			...base,
			runId: "run_0001",
			target: { id: "ombudsman", gitSha: "a".repeat(40) },
			runtime: { ...base.runtime, piSha: "b".repeat(40), ahdeCodeHash: hashValue("code") },
			eval: { ...base.eval, suiteHash: hashValue("suite"), datasetHash: hashValue("dataset") },
			trace: { path: "session.jsonl", sessionId: null, sha256: null },
			...overrides,
		};
	}

	it("leaves every record written before the field existed byte-for-byte valid", () => {
		// The exact shape a run.json on disk has today: no `agent`, no
		// `agentEntryHash`. A default on either would have moved every
		// provenanceKey in every runs store.
		const legacy = valid();
		expect(legacy.execution.agent).toBeUndefined();
		expect(canonicalJson(RunRecordSchema.parse(legacy))).toBe(canonicalJson(legacy));
		expect(canonicalJson(legacy.execution)).not.toContain("agent");
		expect(canonicalJson(legacy.target)).not.toContain("agentEntryHash");
	});

	it("records absent usage only for a command-v1 agent", () => {
		const { tokens: _tokens, costUsd: _costUsd, ...spentNothing } = valid().metrics;
		const command = valid({
			execution: { ...valid().execution, agent: "command-v1" },
			target: { ...valid().target, agentEntryHash: hashValue("python3") },
			metrics: spentNothing,
		});
		const parsed = RunRecordSchema.parse(command);
		expect(parsed.metrics.tokens).toBeUndefined();
		expect(parsed.metrics.costUsd).toBeUndefined();
		expect(parsed.target.agentEntryHash).toMatch(/^sha256:[0-9a-f]{64}$/);

		// Every other backend reports usage; a missing number there is a lost
		// one, not an honest absence.
		for (const agent of [undefined, "pi-v1"] as const) {
			const result = RunRecordSchema.safeParse(valid({
				execution: { ...valid().execution, ...(agent ? { agent } : {}) },
				metrics: spentNothing,
			}));
			expect(result.success).toBe(false);
			expect(JSON.stringify(result.error?.issues)).toContain("only a command-v1 agent may record absent usage");
		}
	});

	it("makes a Pi arm and a command arm incomparable, which is the point", () => {
		const base = valid();
		const armOf = (agent: "pi-v1" | "command-v1") => provenanceAxes({
			runtime: base.runtime,
			model: base.model,
			judge: null,
			execution: { ...base.execution, agent },
			eval: { suiteHash: base.eval.suiteHash, datasetHash: base.eval.datasetHash },
		});
		const pi = armOf("pi-v1");
		const command = armOf("command-v1");
		expect(comparable(pi, command)).toBe(false);
		expect(axisDifferences(pi, command)).toEqual(["execution"]);
		expect(hashValue(pi)).not.toBe(hashValue(command));
	});
});

/**
 * Session 7, defect 19: the receipt of a command run listed `["HOME", "LANG",
 * "PATH", "TMPDIR"]` — the Pi execution policy's environment, which belongs to
 * a different process entirely — while the child had also been handed
 * `AHDE_WORLD`, `AHDE_PROTOCOL` and the credential name. A receipt that
 * under-reports what was given is the one thing a receipt may not do.
 */
describe("the environment a command Target's child receives", () => {
	const source = { PATH: "/usr/bin", LANG: "C.UTF-8", KEEP: "yes", ALSO: "yes" };

	it("lists the fixed four, the readable allowlist, the credential, the protocol, and the world", () => {
		expect(commandTargetEnvironmentNames({
			environmentAllowlist: ["KEEP", "ALSO"],
			apiKeyEnv: "OPENROUTER_API_KEY",
			sourceEnvironment: source,
		})).toEqual([
			"AHDE_PROTOCOL",
			"AHDE_WORLD",
			"ALSO",
			"HOME",
			"KEEP",
			"LANG",
			"OPENROUTER_API_KEY",
			"PATH",
			"TMPDIR",
		]);
	});

	it("drops a name the host cannot read, and never depends on the case", () => {
		// The fingerprint is the eval run's execution policy: a worlded and a
		// worldless case in one run share it, so AHDE_WORLD is always listed
		// (live session 8: listing it per case split one eval run in two).
		expect(commandTargetEnvironmentNames({
			environmentAllowlist: ["KEEP", "NEVER_SET"],
			apiKeyEnv: "OPENROUTER_API_KEY",
			sourceEnvironment: source,
		})).toEqual(["AHDE_PROTOCOL", "AHDE_WORLD", "HOME", "KEEP", "LANG", "OPENROUTER_API_KEY", "PATH", "TMPDIR"]);
	});

	it("never lets an allowlist duplicate a host-owned name into the receipt twice", () => {
		const names = commandTargetEnvironmentNames({
			environmentAllowlist: ["PATH", "AHDE_WORLD", "AHDE_TOOL_HOME", "OPENROUTER_API_KEY"],
			apiKeyEnv: "OPENROUTER_API_KEY",
			sourceEnvironment: { ...source, AHDE_WORLD: "/x", AHDE_TOOL_HOME: "/y", OPENROUTER_API_KEY: "k" },
		});
		expect(names).toEqual([...new Set(names)]);
		// The tool-home variable belongs to a declared tool's process, not the agent's.
		expect(names).not.toContain("AHDE_TOOL_HOME");
	});
});
