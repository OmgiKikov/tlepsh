import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateWorldExpectation, readWorldStateFile, resolveWorldPath } from "../src/domain/world.js";
import { setLanguage } from "../src/i18n.js";
import {
	GraderSpec,
	loadTarget,
	MAX_WORLD_BYTES,
	resolveTaskGraders,
	worldExpectationGraders,
	WorldSchema,
	type Task,
} from "../src/manifest.js";
import { CorpusTaskSchema } from "../src/corpus.js";
import { datasetCasePreview } from "../src/workbench/workbench.js";
import { worldCardLines } from "../src/builder/render/view.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { worldStatePath } from "../src/target/world-state.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

const roots: string[] = [];
const fixtures: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "ahde-world-"));
	roots.push(dir);
	return dir;
}

afterEach(() => {
	setLanguage(null);
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
	for (const path of fixtures.splice(0)) cleanup(path);
});

const STATE = {
	client: { name: "Иван Петров", tags: ["premium", "vip"] },
	accounts: { "42": { status: "ok", limits: null } },
	tickets: [{ id: "t-1", state: "open" }],
};

describe("resolveWorldPath", () => {
	it("walks objects, arrays and numeric indices, and separates absent from null", () => {
		expect(resolveWorldPath(STATE, "client.name")).toEqual({ found: true, value: "Иван Петров" });
		expect(resolveWorldPath(STATE, "client.tags.1")).toEqual({ found: true, value: "vip" });
		expect(resolveWorldPath(STATE, "tickets.0.state")).toEqual({ found: true, value: "open" });
		expect(resolveWorldPath(STATE, "accounts.42.status")).toEqual({ found: true, value: "ok" });
		// Present and null is not the same as absent: `exists` reads them alike,
		// `equals` does not.
		expect(resolveWorldPath(STATE, "accounts.42.limits")).toEqual({ found: true, value: null });
		expect(resolveWorldPath(STATE, "accounts.7")).toEqual({ found: false, value: undefined });
		expect(resolveWorldPath(STATE, "client.tags.9")).toEqual({ found: false, value: undefined });
		expect(resolveWorldPath(STATE, "client.name.length")).toEqual({ found: false, value: undefined });
	});

	it("refuses a reserved property name at lookup, at any depth", () => {
		// The manifest's path regex admits these as spellings; the lookup is where
		// they are refused, so no walk can ever return Object.prototype.
		for (const path of ["__proto__", "client.__proto__", "constructor", "client.prototype.x"]) {
			expect(() => resolveWorldPath(STATE, path), path).toThrow(/reserved property/);
		}
	});

	it("refuses a path that is not a dotted path of plain segments", () => {
		for (const path of ["client.*", "client..name", "client name", ""]) {
			expect(() => resolveWorldPath(STATE, path), JSON.stringify(path)).toThrow(/dotted path/);
		}
	});
});

describe("evaluateWorldExpectation", () => {
	it("equals compares canonical JSON, so key order is not a difference", () => {
		const state = { order: { total: 10, currency: "RUB" } };
		expect(evaluateWorldExpectation(state, {
			path: "order",
			op: "equals",
			value: { currency: "RUB", total: 10 },
		}).passed).toBe(true);
		// A number and its string spelling are two different values.
		expect(evaluateWorldExpectation(state, { path: "order.total", op: "equals", value: "10" }))
			.toEqual({ passed: false, reason: 'world at order.total is 10, expected "10"' });
		expect(evaluateWorldExpectation(state, { path: "order.paid", op: "equals", value: true }))
			.toEqual({ passed: false, reason: "world at order.paid is not set, expected equals true" });
	});

	it("exists is defined and not null", () => {
		expect(evaluateWorldExpectation(STATE, { path: "client.name", op: "exists" }))
			.toEqual({ passed: true, reason: "world at client.name is set" });
		expect(evaluateWorldExpectation(STATE, { path: "accounts.42.limits", op: "exists" }))
			.toEqual({ passed: false, reason: "world at accounts.42.limits is not set" });
		expect(evaluateWorldExpectation(STATE, { path: "accounts.7", op: "exists" }).passed).toBe(false);
	});

	it("contains is substring, array membership, or object key — and says so when it is none of them", () => {
		expect(evaluateWorldExpectation(STATE, { path: "client.name", op: "contains", value: "Петров" }).passed).toBe(true);
		expect(evaluateWorldExpectation(STATE, { path: "client.tags", op: "contains", value: "vip" }).passed).toBe(true);
		expect(evaluateWorldExpectation(STATE, { path: "accounts", op: "contains", value: "42" }).passed).toBe(true);
		expect(evaluateWorldExpectation(STATE, { path: "client.tags", op: "contains", value: "gold" }))
			.toEqual({ passed: false, reason: 'world at client.tags does not contain "gold"' });
		expect(evaluateWorldExpectation(STATE, { path: "tickets.0.id", op: "contains", value: 1 }))
			.toEqual({ passed: false, reason: 'world at tickets.0.id is "t-1", which cannot contain 1' });
	});
});

describe("readWorldStateFile", () => {
	function write(name: string, content: string): string {
		const dir = scratch();
		const path = join(dir, name);
		writeFileSync(path, content, "utf8");
		return path;
	}

	it("reads a bounded JSON object back as a world state", () => {
		expect(readWorldStateFile(write("state.json", JSON.stringify(STATE)))).toEqual(STATE);
	});

	it("refuses a file that is not a regular non-symlink file", () => {
		const dir = scratch();
		const real = join(dir, "real.json");
		writeFileSync(real, JSON.stringify({ a: 1 }), "utf8");
		const link = join(dir, "link.json");
		symlinkSync(real, link);
		expect(() => readWorldStateFile(link)).toThrow(/regular non-symlink file/);
		mkdirSync(join(dir, "adirectory"));
		expect(() => readWorldStateFile(join(dir, "adirectory"))).toThrow(/regular non-symlink file/);
		expect(() => readWorldStateFile(join(dir, "nothing.json"))).toThrow(/cannot be read/);
	});

	it("refuses a world over the manifest's byte bound", () => {
		const big = { padding: "x".repeat(MAX_WORLD_BYTES + 100) };
		expect(() => readWorldStateFile(write("big.json", JSON.stringify(big))))
			.toThrow(new RegExp(`over the ${MAX_WORLD_BYTES} byte bound`));
	});

	it("refuses anything that is not a JSON object, and anything the manifest would refuse", () => {
		expect(() => readWorldStateFile(write("broken.json", "{ not json"))).toThrow(/is not JSON/);
		expect(() => readWorldStateFile(write("array.json", "[1,2,3]"))).toThrow(/must be a JSON object/);
		expect(() => readWorldStateFile(write("scalar.json", '"just a string"'))).toThrow(/must be a JSON object/);
		// The bounds are the manifest's own, re-applied: nesting depth and the
		// three reserved property names, at any depth.
		const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
		expect(() => readWorldStateFile(write("deep.json", JSON.stringify(deep)))).toThrow(/nests deeper than/);
		expect(() => readWorldStateFile(write("proto.json", '{"__proto__":{"x":1}}'))).toThrow(/reserved property name/);
		expect(() => readWorldStateFile(write("nested-proto.json", '{"a":{"constructor":1}}')))
			.toThrow(/reserved property name/);
	});
});

describe("world.expect is sugar for graders", () => {
	const worlded: Task = {
		id: "task_w",
		input: "заблокируй договор 42",
		world: WorldSchema.parse({
			state: { accounts: { "42": { status: "ok" } } },
			expect: [
				{ path: "accounts.42.status", op: "equals", value: "frozen" },
				{ path: "accounts.42.frozenAt", op: "exists" },
			],
		}),
		graders: [{ type: "output_contains", text: "готово", caseSensitive: false }],
	};

	it("appends one world_state grader per expectation, after the case's own graders", () => {
		const [resolved] = resolveTaskGraders([worlded], [], false);
		expect(resolved?.effectiveGraders).toEqual([
			{ type: "output_contains", text: "готово", caseSensitive: false },
			{ type: "world_state", path: "accounts.42.status", op: "equals", value: "frozen" },
			{ type: "world_state", path: "accounts.42.frozenAt", op: "exists" },
		]);
		// An `exists` expectation carries no value, so the grader it desugars into
		// carries none either — canonical JSON would otherwise gain a key.
		expect(Object.hasOwn(worldExpectationGraders(worlded)[1] as object, "value")).toBe(false);
	});

	it("makes a case whose only statement is its world a scored case, not an empty one", () => {
		const [resolved] = resolveTaskGraders([{ ...worlded, graders: undefined }], [], false);
		expect(resolved?.effectiveGraders.map((grader) => grader.type)).toEqual(["world_state", "world_state"]);
	});

	it("says nothing about a case with no world", () => {
		expect(worldExpectationGraders({})).toEqual([]);
		expect(worldExpectationGraders({ world: WorldSchema.parse({ state: { a: 1 } }) })).toEqual([]);
	});

	it("carries the whole chain through loadTarget", () => {
		const dir = makeTargetFixture(baseFixtureFiles({
			"evals/development.jsonl": `${JSON.stringify({
				id: "task_001",
				input: "заблокируй договор 42",
				world: { state: { accounts: { "42": { status: "ok" } } }, expect: [{ path: "accounts.42.status", op: "equals", value: "frozen" }] },
				graders: [{ type: "output_contains", text: "готово" }],
			})}\n`,
		}));
		fixtures.push(dir);
		const target = loadTarget(dir);
		expect(target.tasks[0]?.world?.state).toEqual({ accounts: { "42": { status: "ok" } } });
		expect(target.tasks[0]?.effectiveGraders.at(-1))
			.toEqual({ type: "world_state", path: "accounts.42.status", op: "equals", value: "frozen" });
	});
});

describe("a world is part of the dataset's identity, and only of a worlded dataset's", () => {
	// The literal from tests/manifest.test.ts, computed on 50bca3c — before any
	// of this existed. A dataset with no world must still hash to it.
	const BASE_DATASET_HASH = "sha256:66fb1c48a43a21da97f828c7194c8e3eb4d767753b038a204d4ed360eab8a8fc";

	it("leaves a dataset without a world exactly where it was", () => {
		const dir = makeTargetFixture(baseFixtureFiles());
		fixtures.push(dir);
		expect(loadTarget(dir).datasetHash).toBe(BASE_DATASET_HASH);
	});

	it("moves the hash when the same cases happen in a different world", () => {
		const base = { id: "task_001", input: "x", graders: [{ type: "output_contains", text: "ok" }] };
		const one = makeTargetFixture(baseFixtureFiles({
			"evals/development.jsonl": `${JSON.stringify({ ...base, world: { state: { status: "open" } } })}\n`,
		}));
		const other = makeTargetFixture(baseFixtureFiles({
			"evals/development.jsonl": `${JSON.stringify({ ...base, world: { state: { status: "closed" } } })}\n`,
		}));
		fixtures.push(one, other);
		expect(loadTarget(one).datasetHash).not.toBe(loadTarget(other).datasetHash);
		expect(loadTarget(one).datasetHash).not.toBe(BASE_DATASET_HASH);
	});
});

describe("worldStatePath", () => {
	it("names one place under runtime/, never inside the workspace", () => {
		expect(worldStatePath("/runs/run_1")).toBe("/runs/run_1/runtime/world/state.json");
	});
});

describe("the four-line card", () => {
	function card(task: Record<string, unknown>): string[] {
		return worldCardLines(datasetCasePreview(CorpusTaskSchema.parse(task)), plainPaint);
	}

	it("reads a worlded case as who / has / wants / must", () => {
		setLanguage("ru");
		const lines = card({
			id: "task_001",
			input: "Обращение: заблокируйте договор 42.",
			world: {
				state: { accounts: { "42": { status: "ok", limits: "none" } }, client: { name: "Иван Петров" } },
				expect: [{ path: "accounts.42.status", op: "equals", value: "frozen" }],
			},
			simulatedUser: { goal: "добиться блокировки договора", maxTurns: 4 },
			graders: [{ type: "tool_called", tool: "check_account" }],
		});
		expect(lines).toHaveLength(4);
		expect(lines[0]).toBe("кто: Иван Петров");
		// Canonical order, so the facts a card shows never depend on how the JSON
		// happened to be written.
		expect(lines[1]).toBe("      что есть: accounts.42.limits=none · accounts.42.status=ok · client.name=Иван Петров");
		expect(lines[2]).toBe("      что хочет: добиться блокировки договора");
		expect(lines[3]).toBe('      что должно: accounts.42.status equals "frozen" · tool check_account');
	});

	it("falls back to the persona and to the case input, and says English the same way", () => {
		setLanguage("en");
		const lines = card({
			id: "task_002",
			input: "Freeze account 42 please.",
			world: { state: { accounts: { "42": { status: "ok" } } } },
			graders: [{ type: "world_state", path: "accounts.42.status", op: "exists" }],
		});
		expect(lines[0]).toBe("who: —");
		expect(lines[2]).toBe("      wants: Freeze account 42 please.");
		expect(lines[3]).toBe("      must: accounts.42.status exists");
	});

	it("states an expectation once, even when its grader is written out beside it", () => {
		setLanguage("en");
		const lines = card({
			id: "task_003",
			input: "close it",
			world: { state: { status: "open" }, expect: [{ path: "status", op: "equals", value: "closed" }] },
			graders: [{ type: "world_state", path: "status", op: "equals", value: "closed" }],
		});
		expect(lines[3]).toBe('      must: status equals "closed"');
	});

	it("renders a case without a world exactly as it always has", () => {
		setLanguage("en");
		const plain = datasetCasePreview(CorpusTaskSchema.parse({
			id: "task_004",
			input: "Классифицируй обращение.",
			expected: "жалоба",
			metadata: { source: "zendesk" },
			simulatedUser: { goal: "получить ответ", persona: "торопится", maxTurns: 3 },
			graders: [{ type: "output_contains", text: "жалоба" }],
		}));
		expect(worldCardLines(plain, plainPaint)).toEqual([
			"Классифицируй обращение.",
			"      expected: жалоба",
			"      live user: получить ответ as торопится · up to 3 turns",
			"      metadata: source=zendesk",
			"      graders: contains “жалоба”",
		]);
	});
});

describe("a world_state grader carries its own spec", () => {
	it("takes the same value rule an expectation does, and the same path shape", () => {
		expect(GraderSpec.parse({ type: "world_state", path: "a.b", op: "exists" }))
			.toEqual({ type: "world_state", path: "a.b", op: "exists" });
		expect(() => GraderSpec.parse({ type: "world_state", path: "a", op: "exists", value: 1 }))
			.toThrow(/takes no value/);
		expect(() => GraderSpec.parse({ type: "world_state", path: "a", op: "equals" }))
			.toThrow(/must carry one/);
		expect(() => GraderSpec.parse({ type: "world_state", path: "a.*", op: "exists" }))
			.toThrow(/dotted path/);
	});
});
