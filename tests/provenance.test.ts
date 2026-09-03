import { describe, expect, it } from "vitest";
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
