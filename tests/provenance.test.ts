import { describe, expect, it } from "vitest";
import {
	axisDifferences,
	canonicalJson,
	comparable,
	hashValue,
	provenanceAxes,
	provenanceKey,
	type RunRecord,
} from "../src/provenance.js";

function record(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		schemaVersion: 1,
		runId: "run_test",
		taskId: "task_001",
		repetitionIndex: 0,
		label: "baseline",
		status: "pass",
		error: null,
		startedAt: "2026-08-25T10:00:00Z",
		finishedAt: "2026-08-25T10:00:05Z",
		target: { id: "ombudsman", gitSha: "aaa111" },
		runtime: { piVersion: "0.84.3", piSha: "sha-abc" },
		model: { provider: "qwen-internal", id: "qwen3.5-27b", thinkingLevel: "off", params: {} },
		eval: { suiteId: "s", suiteHash: "sha256:1", dataset: "development", datasetHash: "sha256:2" },
		trace: { path: "session.jsonl", sessionId: null, sha256: null },
		metrics: {
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			costUsd: 0,
			latencyMs: 0,
			toolCalls: 0,
			toolErrors: 0,
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
		const other = record({ status: "fail", metrics: { ...record().metrics, toolCalls: 99 } });
		expect(axisDifferences(provenanceAxes(record()), provenanceAxes(other))).toEqual([]);
	});
});

describe("axisDifferences (table-driven: each axis must be caught)", () => {
	const cases: Array<{ axis: string; mutate: () => RunRecord }> = [
		{ axis: "runtime.piVersion", mutate: () => record({ runtime: { piVersion: "0.85.0", piSha: "sha-abc" } }) },
		{ axis: "runtime.piSha", mutate: () => record({ runtime: { piVersion: "0.84.3", piSha: "sha-xyz" } }) },
		{ axis: "model.provider", mutate: () => record({ model: { ...record().model, provider: "other" } }) },
		{ axis: "model.id", mutate: () => record({ model: { ...record().model, id: "qwen-99b" } }) },
		{
			axis: "model.thinkingLevel",
			mutate: () => record({ model: { ...record().model, thinkingLevel: "low" } }),
		},
		{
			axis: "model.params",
			mutate: () => record({ model: { ...record().model, params: { temperature: 0.2 } } }),
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

	it("reports multiple differing axes", () => {
		const other = record({
			runtime: { piVersion: "0.85.0", piSha: "sha-xyz" },
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
