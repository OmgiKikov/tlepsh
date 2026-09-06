import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	bm25Search,
	chunkKnowledge,
	finerGeometry,
	kbIndexHash,
	kbPassages,
	KB_CHUNK_CHARS,
	KB_CHUNK_OVERLAP_CHARS,
	KB_GEOMETRY,
	KnowledgeBaseError,
	MAX_KB_FILES,
	MAX_KB_SEARCH_RESULTS,
	MIN_KB_CHUNK_CHARS,
	type KbGeometry,
} from "../src/domain/kb.js";
import { answerTokens, tokenF1 } from "../src/domain/tokens.js";
import {
	createKbSearchTool,
	findKbChunk,
	knowledgeBaseDeclared,
	readKnowledgeBase,
	KB_SEARCH_TOOL_NAME,
} from "../src/target/kb-tool.js";
import { GraderSpec } from "../src/manifest.js";
import { gradeRun } from "../src/eval.js";
import type { RunRecord } from "../src/provenance.js";

const FIXTURE_KB = resolve(import.meta.dirname, "fixtures", "kb");

function fixtureFiles(): { path: string; text: string }[] {
	return ["blocking.md", "tariffs.md", "visits.md"].map((name) => ({
		path: name,
		text: readFileSync(join(FIXTURE_KB, name), "utf8"),
	}));
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

async function callKbSearch(
	chunks: ReturnType<typeof chunkKnowledge>,
	params: unknown,
): Promise<{
	text: string;
	schemaVersion: number | null;
	chunks: { rank: number; id: string; path: string; score: number; text: string }[] | null;
}> {
	const tool = createKbSearchTool(chunks);
	const result = await tool.execute("call-1", params, undefined, undefined, undefined as never);
	const text = toolText(result);
	try {
		const parsed = JSON.parse(text) as {
			schemaVersion?: number;
			chunks: { rank: number; id: string; path: string; score: number; text: string }[];
		};
		return { text, schemaVersion: parsed.schemaVersion ?? null, chunks: parsed.chunks };
	} catch {
		return { text, schemaVersion: null, chunks: null };
	}
}

describe("knowledge-base chunking", () => {
	it("is a pure function of the bytes: same documents, same ids, same order", () => {
		const first = chunkKnowledge(fixtureFiles());
		// Reversed input order must not change a single id: the chunker sorts.
		const second = chunkKnowledge([...fixtureFiles()].reverse());
		expect(second).toEqual(first);
		expect(first.length).toBeGreaterThan(3);
		expect(new Set(first.map((chunk) => chunk.id)).size).toBe(first.length);
		// Documents appear in path order, whatever order they were handed over in.
		expect([...new Set(first.map((chunk) => chunk.path))]).toEqual(["blocking.md", "tariffs.md", "visits.md"]);
		expect(first[0]?.id).toBe("blocking.md#0");
		for (const chunk of first) {
			expect(chunk.id).toBe(`${chunk.path}#${chunk.ordinal}`);
			expect(chunk.text.length).toBeLessThanOrEqual(KB_CHUNK_CHARS);
			expect(chunk.text.trim()).toBe(chunk.text);
		}
		// Every document is represented, and each one's ordinals start at 0 and
		// run without a gap — an id is a position, not a counter.
		for (const path of ["blocking.md", "tariffs.md", "visits.md"]) {
			const ordinals = first.filter((chunk) => chunk.path === path).map((chunk) => chunk.ordinal);
			expect(ordinals).toEqual(ordinals.map((_value, index) => index));
			expect(ordinals.length).toBeGreaterThan(0);
		}
	});

	it("carries an overlap between consecutive chunks of one document", () => {
		// Six paragraphs of ~300 characters each: too long for one chunk, short
		// enough that the packer never has to window a single paragraph.
		const paragraph = (marker: string): string => `${marker} ${"словоформа ".repeat(25)}`.trim();
		const text = [0, 1, 2, 3, 4, 5].map((index) => paragraph(`п${index}`)).join("\n\n");
		const chunks = chunkKnowledge([{ path: "long.md", text }]);
		expect(chunks.length).toBeGreaterThan(1);
		for (const [index, chunk] of chunks.entries()) {
			expect(chunk.text.length).toBeLessThanOrEqual(KB_CHUNK_CHARS);
			if (index === 0) continue;
			const previous = chunks[index - 1]!.text;
			const tail = previous.slice(previous.length - KB_CHUNK_OVERLAP_CHARS);
			// The overlap starts at a word boundary inside that tail, so the head of
			// this chunk is a suffix of the previous one.
			expect(tail.includes(chunk.text.slice(0, 20))).toBe(true);
		}
	});

	it("windows a single paragraph nobody broke up", () => {
		const text = "а".repeat(KB_CHUNK_CHARS * 3);
		const chunks = chunkKnowledge([{ path: "wall.txt", text }]);
		expect(chunks.length).toBeGreaterThan(2);
		for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(KB_CHUNK_CHARS);
		const step = KB_CHUNK_CHARS - KB_CHUNK_OVERLAP_CHARS;
		expect(chunks.length).toBe(Math.ceil(text.length / step));
	});

	it("refuses a knowledge base past its bounds, naming the number that broke", () => {
		const tooMany = Array.from({ length: MAX_KB_FILES + 1 }, (_value, index) => ({
			path: `doc-${index}.md`,
			text: "текст",
		}));
		expect(() => chunkKnowledge(tooMany)).toThrow(KnowledgeBaseError);
		expect(() => chunkKnowledge(tooMany)).toThrow(/2001 files, over the 2000 file bound/);

		expect(() => chunkKnowledge([
			{ path: "a.md", text: "x".repeat(5 * 1024 * 1024) },
			{ path: "b.md", text: "y".repeat(4 * 1024 * 1024) },
		])).toThrow(/over the 8388608 byte bound/);

		expect(() => chunkKnowledge([{ path: "a.md", text: "x" }, { path: "a.md", text: "y" }]))
			.toThrow(/declares a.md twice/);
	});

	it("changes the index hash when a document changes, and not otherwise", () => {
		const files = fixtureFiles();
		const base = kbIndexHash(chunkKnowledge(files));
		expect(base).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(kbIndexHash(chunkKnowledge([...files].reverse()))).toBe(base);

		const edited = files.map((file) =>
			file.path === "tariffs.md"
				? { ...file, text: file.text.replace("450 рублей", "470 рублей") }
				: file
		);
		expect(kbIndexHash(chunkKnowledge(edited))).not.toBe(base);
	});
});

describe("the passages an exam is written from", () => {
	it("is every runtime chunk, unchanged, at the runtime geometry", () => {
		const chunks = chunkKnowledge(fixtureFiles());
		const passages = kbPassages(chunks);
		expect(passages).toEqual(chunks.map((chunk) => ({ id: chunk.id, source: chunk.id, text: chunk.text })));
		// The default is the runtime geometry, and it is the one the index hash
		// and the prepared-home identity are built from.
		expect(kbPassages(chunks, KB_GEOMETRY)).toEqual(passages);
	});

	it("cuts finer on demand, deterministically, and never past the floor", () => {
		const chunks = chunkKnowledge(fixtureFiles());
		const half = finerGeometry(KB_GEOMETRY)!;
		expect(half).toEqual({ chars: KB_CHUNK_CHARS / 2, overlap: KB_CHUNK_OVERLAP_CHARS / 2 });

		const finer = kbPassages(chunks, half);
		// Same bytes, same geometry, same passages — down to the id.
		expect(kbPassages(chunks, half)).toEqual(finer);
		expect(finer.length).toBeGreaterThan(chunks.length);
		const runtimeIds = new Set(chunks.map((chunk) => chunk.id));
		for (const passage of finer) {
			expect(passage.text.length).toBeLessThanOrEqual(half.chars);
			// The citation is always a chunk the runtime index really serves: a
			// finer passage is read from its source, never instead of it.
			expect(runtimeIds.has(passage.source)).toBe(true);
			expect(passage.id === passage.source || passage.id.startsWith(`${passage.source}/`)).toBe(true);
		}
		// Every source is still represented, and no passage id is used twice.
		expect(new Set(finer.map((passage) => passage.source))).toEqual(runtimeIds);
		expect(new Set(finer.map((passage) => passage.id)).size).toBe(finer.length);

		// Halving stops at the floor rather than shredding a document into words.
		let geometry: KbGeometry | null = KB_GEOMETRY;
		const seen: number[] = [];
		while (geometry) {
			seen.push(geometry.chars);
			geometry = finerGeometry(geometry);
		}
		expect(seen).toEqual([800, 400, 200]);
		expect(seen.at(-1)).toBe(MIN_KB_CHUNK_CHARS);
	});

	it("leaves the runtime index hash alone however finely a generator reads it", () => {
		const chunks = chunkKnowledge(fixtureFiles());
		const before = kbIndexHash(chunks);
		kbPassages(chunks, finerGeometry(KB_GEOMETRY)!);
		kbPassages(chunks, { chars: MIN_KB_CHUNK_CHARS, overlap: 25 });
		// The prepared-home identity is a fact about the Target's retrieval, and
		// the exam generator is not allowed to be one of its inputs.
		expect(kbIndexHash(chunks)).toBe(before);
		expect(chunkKnowledge(fixtureFiles())).toEqual(chunks);
	});
});

describe("BM25 retrieval", () => {
	it("ranks the passage that answers the question first", () => {
		const chunks = chunkKnowledge(fixtureFiles());
		const tariff = bm25Search(chunks, "сколько стоит тариф Река в месяц", 3);
		expect(tariff.length).toBeGreaterThan(0);
		expect(tariff[0]?.chunk.path).toBe("tariffs.md");
		expect(tariff[0]?.chunk.text).toContain("750");

		const master = bm25Search(chunks, "когда выезд мастера бесплатный", 3);
		expect(master[0]?.chunk.path).toBe("visits.md");
		expect(master[0]?.chunk.text).toContain("бесплатн");

		const debt = bm25Search(chunks, "через сколько суток отключат интернет за неоплату", 3);
		expect(debt[0]?.chunk.path).toBe("blocking.md");
	});

	it("is deterministic, bounded by k, and empty when nothing can match", () => {
		const chunks = chunkKnowledge(fixtureFiles());
		const query = "тариф роутер аренда";
		expect(bm25Search(chunks, query, 3)).toEqual(bm25Search(chunks, query, 3));
		expect(bm25Search(chunks, query, 2).length).toBeLessThanOrEqual(2);
		// k is clamped, never trusted: a model asking for a thousand passages gets
		// the bound, not the corpus.
		expect(bm25Search(chunks, query, 1_000).length).toBeLessThanOrEqual(MAX_KB_SEARCH_RESULTS);
		expect(bm25Search(chunks, "   ", 3)).toEqual([]);
		expect(bm25Search(chunks, "квазиморфологический флогистон", 3)).toEqual([]);
		expect(bm25Search([], query, 3)).toEqual([]);
		// Scores are non-increasing, and equal scores break by id.
		const ranked = bm25Search(chunks, "рублей", MAX_KB_SEARCH_RESULTS);
		for (const [index, hit] of ranked.entries()) {
			if (index === 0) continue;
			const previous = ranked[index - 1]!;
			expect(previous.score).toBeGreaterThanOrEqual(hit.score);
			if (previous.score === hit.score) expect(previous.chunk.id < hit.chunk.id).toBe(true);
		}
	});

	it("uses the one tokenization the graders use", () => {
		expect(answerTokens("Тариф «Река» — 750 руб.")).toEqual(["тариф", "река", "750", "руб"]);
		expect(tokenF1("тариф река 750", "тариф река 750")).toBe(1);
	});
});

describe("the kb_search host tool", () => {
	it("is turned on by the declaration and by nothing else", () => {
		expect(knowledgeBaseDeclared(["data/kb"])).toBe(true);
		expect(knowledgeBaseDeclared(["data/kb/policies"])).toBe(true);
		expect(knowledgeBaseDeclared(["data/fixtures", "data/kb"])).toBe(true);
		expect(knowledgeBaseDeclared([])).toBe(false);
		expect(knowledgeBaseDeclared(["data/kbase"])).toBe(false);
		expect(knowledgeBaseDeclared(["data/fixtures"])).toBe(false);
	});

	it("reads only data/kb, only .md and .txt, and returns chunks as JSON", async () => {
		const workspace = mkdtempSync(join(tmpdir(), "ahde-kb-workspace-"));
		try {
			mkdirSync(join(workspace, "data", "kb"), { recursive: true });
			for (const file of fixtureFiles()) {
				writeFileSync(join(workspace, "data", "kb", file.path), file.text);
			}
			writeFileSync(join(workspace, "data", "kb", "ignored.pdf"), "%PDF-1.4 не знание");
			writeFileSync(join(workspace, "AGENTS.md"), "не база знаний");

			const chunks = readKnowledgeBase(workspace);
			expect(chunks.every((chunk) => chunk.path.endsWith(".md"))).toBe(true);
			expect(chunks).toEqual(chunkKnowledge(fixtureFiles()));

			const tool = createKbSearchTool(chunks);
			expect(tool.name).toBe(KB_SEARCH_TOOL_NAME);
			// Lexical, not stemmed: the query has to use the documents' own word
			// forms, which is exactly the contract `answerTokens` states.
			const hit = await callKbSearch(chunks, { query: "роутер в аренду", k: 2 });
			expect(hit.schemaVersion).toBe(1);
			expect(hit.chunks).not.toBeNull();
			expect(hit.chunks!.length).toBeGreaterThan(0);
			expect(hit.chunks!.length).toBeLessThanOrEqual(2);
			for (const [index, chunk] of hit.chunks!.entries()) {
				expect(Object.keys(chunk).sort()).toEqual(["id", "path", "rank", "score", "text"]);
				expect(chunk.rank).toBe(index + 1);
				expect(chunk.score).toBeGreaterThan(0);
				expect(findKbChunk(workspace, chunk.id)?.text).toBe(chunk.text);
			}

			// A workspace with no knowledge base is an empty index, not a crash.
			const empty = mkdtempSync(join(tmpdir(), "ahde-kb-empty-"));
			try {
				expect(readKnowledgeBase(empty)).toEqual([]);
				expect(findKbChunk(empty, "tariffs.md#0")).toBeNull();
			} finally {
				rmSync(empty, { recursive: true, force: true });
			}
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("refuses a call it cannot answer instead of guessing", async () => {
		const chunks = chunkKnowledge(fixtureFiles());
		expect((await callKbSearch(chunks, {})).text).toMatch(/non-empty `query`/);
		expect((await callKbSearch(chunks, { query: "   " })).text).toMatch(/non-empty `query`/);
		expect((await callKbSearch(chunks, { query: "тариф", k: 0 })).text).toMatch(/`k` must be an integer/);
		expect((await callKbSearch(chunks, { query: "тариф", k: 1.5 })).text).toMatch(/`k` must be an integer/);
	});
});

// ---------- cites_source ----------

const RUN_ID = "run-kb-1";

function writeGradedRun(
	runsRoot: string,
	answer: string,
	options: { withWorkspace?: boolean; kbFiles?: { path: string; text: string }[] } = {},
): RunRecord {
	const runDir = join(runsRoot, RUN_ID);
	mkdirSync(runDir, { recursive: true });
	if (options.withWorkspace !== false) {
		mkdirSync(join(runDir, "workspace", "data", "kb"), { recursive: true });
		for (const file of options.kbFiles ?? fixtureFiles()) {
			writeFileSync(join(runDir, "workspace", "data", "kb", file.path), file.text);
		}
	}
	const trace = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "Сколько стоит тариф «Река»?" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: answer }] } },
	].map((entry) => JSON.stringify(entry)).join("\n");
	writeFileSync(join(runDir, "session.jsonl"), `${trace}\n`);
	return {
		schemaVersion: 1,
		runId: RUN_ID,
		taskId: "kb-case",
		repetitionIndex: 0,
		label: "solo",
		status: "completed",
		error: null,
		startedAt: "2026-09-03T00:00:00.000Z",
		finishedAt: "2026-09-03T00:00:01.000Z",
		target: { id: "kb-target", gitSha: "a".repeat(40) },
		runtime: { piVersion: "0", piSha: "0", ahdeVersion: "0", ahdeCodeHash: `sha256:${"0".repeat(64)}` },
		model: { provider: "test", id: "test", api: "openai-completions", thinkingLevel: "off", params: {} },
		execution: {
			workspace: "isolated",
			tools: [],
			environment: [],
			sandbox: "none",
			network: "deny",
			filesystem: "workspace-confined-v1",
		},
		eval: { suiteId: "s", suiteHash: `sha256:${"0".repeat(64)}`, dataset: "d", datasetHash: `sha256:${"0".repeat(64)}` },
		trace: { path: "session.jsonl", sessionId: null, sha256: null },
		metrics: {
			durationMs: 1,
			toolCalls: 0,
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			costUsd: 0,
			turns: 1,
		},
		evalResults: null,
	} as unknown as RunRecord;
}

async function citesSourceResult(
	runsRoot: string,
	answer: string,
	spec: Record<string, unknown>,
	options: { withWorkspace?: boolean; kbFiles?: { path: string; text: string }[] } = {},
): Promise<{ passed: boolean; reason: string; checkCode?: string; checkSubject?: string }> {
	const record = writeGradedRun(runsRoot, answer, options);
	const graded = await gradeRun(
		{
			id: "kb-case",
			input: "Сколько стоит тариф «Река»?",
			effectiveGraders: [GraderSpec.parse(spec)],
		} as never,
		record,
		runsRoot,
	);
	const result = graded.graders[0]!;
	return {
		passed: result.passed,
		reason: result.reason,
		...(result.checkCode ? { checkCode: result.checkCode } : {}),
		...(result.checkSubject ? { checkSubject: result.checkSubject } : {}),
	};
}

describe("the cites_source grader", () => {
	const chunkId = "tariffs.md#0";

	it("passes on the chunk id said out loud", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-kb-runs-"));
		try {
			const result = await citesSourceResult(
				runsRoot,
				`Тариф «Река» — 750 рублей в месяц. Источник: ${chunkId}`,
				{ type: "cites_source", chunk: chunkId },
			);
			expect(result.passed).toBe(true);
			expect(result.reason).toContain("cites tariffs.md#0 by id");
			expect(result.checkCode).toBe("cites-source");
			expect(result.checkSubject).toBe(chunkId);
		} finally {
			rmSync(runsRoot, { recursive: true, force: true });
		}
	});

	it("rejects the actual live tariff answer whose overlap passed without any citation", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-kb-live-regression-"));
		try {
			// Public development run run_mtols4rw5dhc8lp, 2026-09-05.
			// v4 passed this at token-F1 0.38805970149253727, threshold 0.35.
			const answer = "Тариф «Скоростной» (500 Мбит/с) стоит **800 ₽/месяц**, а тариф «Гигабит» (1 Гбит/с) — **1200 ₽/месяц**.";
			const text = "# Тарифы\n\n| Тариф | Скорость | Цена в месяц |\n|---|---|---|\n| Домашний | 100 Мбит/с | 500 ₽ |\n| Скоростной | 500 Мбит/с | 800 ₽ |\n| Гигабит | 1 Гбит/с | 1200 ₽ |\n\nСмена тарифа — с первого числа следующего месяца, заявка через чат или личный\nкабинет. Плата за смену не берётся. Переход на более дорогой тариф действует\nсразу, если на счету хватает средств.\n\n";
			expect(tokenF1(answer.toLowerCase(), text.toLowerCase())).toBeCloseTo(0.38805970149253727);
			const result = await citesSourceResult(runsRoot, answer, { type: "cites_source", chunk: chunkId }, {
				kbFiles: [{ path: "tariffs.md", text }],
			});
			expect(result.passed).toBe(false);
			expect(result.reason).toContain("does not explicitly cite tariffs.md#0");
		} finally {
			rmSync(runsRoot, { recursive: true, force: true });
		}
	});

	it("leaves an overlong source label absent instead of truncating its identity", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-kb-runs-"));
		const chunk = `${"nested/".repeat(29)}source.md#0`;
		expect(chunk.length).toBeGreaterThan(200);
		try {
			const result = await citesSourceResult(
				runsRoot,
				"Ответ без источника.",
				{ type: "cites_source", chunk },
			);
			expect(result.checkCode).toBe("cites-source");
			expect(result.checkSubject).toBeUndefined();
		} finally {
			rmSync(runsRoot, { recursive: true, force: true });
		}
	});

	it("rejects even verbatim source text without a citation, regardless of legacy minOverlap", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-kb-runs-"));
		try {
			const chunk = chunkKnowledge(fixtureFiles()).find((entry) => entry.id === chunkId);
			if (!chunk) throw new Error("fixture chunk is missing");
			const result = await citesSourceResult(
				runsRoot,
				chunk.text,
				{ type: "cites_source", chunk: chunkId, minOverlap: 0.6 },
			);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain("does not explicitly cite tariffs.md#0");
		} finally {
			rmSync(runsRoot, { recursive: true, force: true });
		}
	});

	it("fails an answer that stands on nothing, and says what it wanted", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-kb-runs-"));
		try {
			const result = await citesSourceResult(
				runsRoot,
				"Не знаю, уточните у оператора.",
				{ type: "cites_source", chunk: chunkId },
			);
			expect(result.passed).toBe(false);
			expect(result.reason).toContain("does not explicitly cite tariffs.md#0");
		} finally {
			rmSync(runsRoot, { recursive: true, force: true });
		}
	});

	it("refuses a replaced data ancestor instead of citing a chunk outside the saved workspace", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-kb-ancestor-"));
		const foreign = mkdtempSync(join(tmpdir(), "ahde-kb-foreign-"));
		try {
			const record = writeGradedRun(runsRoot, `Source: ${chunkId}`, { withWorkspace: false });
			mkdirSync(join(runsRoot, RUN_ID, "workspace"));
			mkdirSync(join(foreign, "kb")); writeFileSync(join(foreign, "kb", "tariffs.md"), "Outside source");
			symlinkSync(foreign, join(runsRoot, RUN_ID, "workspace", "data"));
			const result = await gradeRun({ id: "kb-case", input: "?", effectiveGraders: [GraderSpec.parse({ type: "cites_source", chunk: chunkId })] } as never, record, runsRoot);
			expect(result.graders[0]?.passed).toBe(false);
			expect(result.graders[0]?.reason).toContain("symlink");
		} finally { rmSync(runsRoot, { recursive: true, force: true }); rmSync(foreign, { recursive: true, force: true }); }
	});

	it("fails loudly, never vacuously, when the run's workspace cannot answer for the chunk", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-kb-runs-"));
		try {
			const missingChunk = await citesSourceResult(
				runsRoot,
				"Источник: tariffs.md#999",
				{ type: "cites_source", chunk: "tariffs.md#999" },
			);
			expect(missingChunk.passed).toBe(false);
			expect(missingChunk.reason).toMatch(/carries no knowledge-base chunk tariffs\.md#999/);
		} finally {
			rmSync(runsRoot, { recursive: true, force: true });
		}

		const bare = mkdtempSync(join(tmpdir(), "ahde-kb-runs-"));
		try {
			const noWorkspace = await citesSourceResult(
				bare,
				`Источник: ${chunkId}`,
				{ type: "cites_source", chunk: chunkId },
				{ withWorkspace: false },
			);
			expect(noWorkspace.passed).toBe(false);
			expect(noWorkspace.reason).toMatch(/carries no knowledge-base chunk/);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	it.each([
		["Источник: tariffs.md#0", true],
		["[tariffs.md#0]", true],
		["[Источник](tariffs.md#0)", true],
		["Источник: tariffs.md#0.", true],
		["Источник: tariffs.md#01", false],
		["Источник: old-tariffs.md#0", false],
		["Источник: nested/tariffs.md#0", false],
		["Источник: tariffs.md#0.extra", false],
		["Источник: tariffs.md#0/extra", false],
		["Источник: Tariffs.md#0", false],
	])("recognizes the exact source identity in %s", async (answer, passed) => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-kb-boundary-"));
		try {
			expect((await citesSourceResult(runsRoot, answer, { type: "cites_source", chunk: chunkId })).passed).toBe(passed);
		} finally { rmSync(runsRoot, { recursive: true, force: true }); }
	});

	it("checks citation only: a cited but wrong fact still needs an independent accuracy check", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-kb-citation-only-"));
		try {
			const result = await citesSourceResult(runsRoot, `Тариф «Река» стоит 7 рублей. Источник: ${chunkId}`, {
				type: "cites_source", chunk: chunkId, minOverlap: 1,
			});
			expect(result.passed).toBe(true);
			expect(result.reason).toBe("the answer cites tariffs.md#0 by id");
		} finally { rmSync(runsRoot, { recursive: true, force: true }); }
	});

});
