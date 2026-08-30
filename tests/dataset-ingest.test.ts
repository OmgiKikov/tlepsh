import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	compileDatasetCases,
	compileSealedSlice,
	holdOutSealedSlice,
	ingestDataset,
	inspectDatasetFile,
	loadDatasetIngestReceipt,
	MAX_DATASET_SOURCE_BYTES,
	MAX_PREVIEW_CELL_CHARS,
	MAX_PREVIEW_ROWS,
	type DatasetMappingRecipe,
} from "../src/application/dataset-ingest.js";
import { createCorpus, loadCorpus } from "../src/corpus.js";
import {
	appendTargetFeedbackMark,
	TARGET_FEEDBACK_PATH,
	type TargetFeedbackMark,
} from "../src/application/target-feedback.js";

const NOW = "2026-08-29T09:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function project(files: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "ahde-dataset-"));
	roots.push(dir);
	const root = realpathSync(dir);
	mkdirSync(join(root, "imports"), { recursive: true });
	for (const [path, content] of Object.entries(files)) {
		const full = join(root, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf8");
	}
	return root;
}

function recipe(overrides: Partial<DatasetMappingRecipe> = {}): DatasetMappingRecipe {
	return {
		schemaVersion: 1,
		input: { column: "question" },
		graders: [{ type: "output_contains", text: "ok", caseSensitive: false }],
		...overrides,
	} as DatasetMappingRecipe;
}

function csvRows(count: number, tierOf: (index: number) => string = () => "gold"): string {
	const lines = ["id,question,answer,tier"];
	for (let index = 1; index <= count; index += 1) {
		lines.push(`row-${index},Question ${index}?,Answer ${index},${tierOf(index)}`);
	}
	return `${lines.join("\n")}\n`;
}

describe("dataset parsers", () => {
	it("reads RFC 4180 CSV: quotes, doubled quotes, newlines in cells, CRLF", () => {
		const dir = project({
			"imports/basket.csv":
				'question,answer,tier\r\n"What is the ""refund"" window?","30 days,\r\nno exceptions",gold\r\nWho approves it?,A manager,silver\r\n',
		});
		const preview = inspectDatasetFile({ projectDir: dir, sourcePath: "imports/basket.csv" });

		expect(preview.format).toBe("csv");
		expect(preview.columns.map((column) => column.name)).toEqual(["question", "answer", "tier"]);
		expect(preview.rowCount).toBe(2);
		expect(preview.sampleRows[0]).toEqual({
			question: 'What is the "refund" window?',
			answer: "30 days,\nno exceptions",
			tier: "gold",
		});
		expect(preview.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(preview.bytes).toBeGreaterThan(0);
	});

	it("sniffs the delimiter between comma, semicolon and tab", () => {
		const dir = project({
			"imports/semicolon.csv": "question;answer\nWhat?;This\nWhen?;Now\n",
			"imports/tabbed.csv": "question\tanswer\nWhat?\tThis\n",
		});

		expect(inspectDatasetFile({ projectDir: dir, sourcePath: "imports/semicolon.csv" }).columns.map((c) => c.name))
			.toEqual(["question", "answer"]);
		expect(inspectDatasetFile({ projectDir: dir, sourcePath: "imports/tabbed.csv" }).sampleRows[0])
			.toEqual({ question: "What?", answer: "This" });
	});

	it("reads TSV", () => {
		const dir = project({ "imports/basket.tsv": "question\tanswer\nWhat?\tThis, that\n" });
		const preview = inspectDatasetFile({ projectDir: dir, sourcePath: "imports/basket.tsv" });
		expect(preview.format).toBe("tsv");
		expect(preview.sampleRows[0]).toEqual({ question: "What?", answer: "This, that" });
	});

	it("flattens nested JSON objects into dot paths and keeps arrays as JSON cells", () => {
		const dir = project({
			"imports/basket.json": JSON.stringify([
				{ id: 1, user: { name: "Ann", tier: "gold" }, tags: ["a", "b"], ok: true },
				{ id: 2, user: { name: "Bo", tier: "silver" }, tags: [], ok: false },
			]),
		});
		const preview = inspectDatasetFile({ projectDir: dir, sourcePath: "imports/basket.json" });

		expect(preview.format).toBe("json");
		expect(preview.columns.map((column) => column.name)).toEqual(["id", "user.name", "user.tier", "tags", "ok"]);
		expect(preview.columns.find((column) => column.name === "id")?.inferredType).toBe("number");
		expect(preview.columns.find((column) => column.name === "ok")?.inferredType).toBe("boolean");
		expect(preview.columns.find((column) => column.name === "tags")?.inferredType).toBe("json");
		expect(preview.sampleRows[0]?.["user.name"]).toBe("Ann");
	});

	it("reads the one array field of a JSON wrapper object", () => {
		const dir = project({ "imports/basket.json": JSON.stringify({ rows: [{ q: "one" }, { q: "two" }] }) });
		const preview = inspectDatasetFile({ projectDir: dir, sourcePath: "imports/basket.json" });
		expect(preview.rowCount).toBe(2);
		expect(preview.columns.map((column) => column.name)).toEqual(["q"]);
	});

	it("reads JSONL of any object shape", () => {
		const dir = project({
			"imports/basket.jsonl": `${JSON.stringify({ q: "one", meta: { source: "logs" } })}\n\n${JSON.stringify({ q: "two", meta: { source: "chat" } })}\n`,
		});
		const preview = inspectDatasetFile({ projectDir: dir, sourcePath: "imports/basket.jsonl" });
		expect(preview.format).toBe("jsonl");
		expect(preview.columns.map((column) => column.name)).toEqual(["q", "meta.source"]);
		expect(preview.rowCount).toBe(2);
	});

	it("reads a Markdown table, escaped pipes and all", () => {
		const dir = project({
			"imports/basket.md": "# Basket\n\nSome prose.\n\n| question | answer |\n| --- | :---: |\n| What \\| when? | Both |\n| Who? | A manager |\n\nMore prose.\n",
		});
		const preview = inspectDatasetFile({ projectDir: dir, sourcePath: "imports/basket.md" });
		expect(preview.format).toBe("markdown-table");
		expect(preview.rowCount).toBe(2);
		expect(preview.sampleRows[0]).toEqual({ question: "What | when?", answer: "Both" });
	});

	it("reads plain text one case per line, or per blank-line block", () => {
		const dir = project({
			"imports/lines.txt": "first\nsecond\nthird\n",
			"imports/blocks.txt": "first\ncontinued\n\nsecond\n",
		});
		expect(inspectDatasetFile({ projectDir: dir, sourcePath: "imports/lines.txt" }).rowCount).toBe(3);
		const blocks = inspectDatasetFile({ projectDir: dir, sourcePath: "imports/blocks.txt" });
		expect(blocks.format).toBe("text-lines");
		expect(blocks.rowCount).toBe(2);
		expect(blocks.sampleRows[0]).toEqual({ text: "first\ncontinued" });
	});

	it("reads a ChatGPT conversations export", () => {
		const dir = project({
			"imports/conversations.json": JSON.stringify([
				{
					title: "Refunds",
					mapping: {
						b: { message: { author: { role: "assistant" }, content: { parts: ["Thirty days."] }, create_time: 2 } },
						a: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["How long?"] }, create_time: 1 } },
						c: { message: { author: { role: "user" }, content: { parts: ["And for gold?"] }, create_time: 3 } },
					},
				},
			]),
		});
		const preview = inspectDatasetFile({ projectDir: dir, sourcePath: "imports/conversations.json" });

		expect(preview.format).toBe("chat-export");
		expect(preview.columns.map((column) => column.name)).toEqual([
			"messages",
			"first_user",
			"last_user",
			"last_assistant",
			"title",
			"message_count",
		]);
		expect(preview.sampleRows[0]).toMatchObject({
			first_user: "How long?",
			last_user: "And for gold?",
			last_assistant: "Thirty days.",
			title: "Refunds",
			message_count: "3",
		});
	});

	it("reads a Claude export", () => {
		const dir = project({
			"imports/claude.json": JSON.stringify([
				{
					name: "Policy",
					chat_messages: [
						{ sender: "human", text: "Which policy applies?" },
						{ sender: "assistant", content: [{ type: "text", text: "Policy 4." }] },
					],
				},
			]),
		});
		const preview = inspectDatasetFile({ projectDir: dir, sourcePath: "imports/claude.json" });
		expect(preview.format).toBe("chat-export");
		expect(preview.sampleRows[0]).toMatchObject({ last_user: "Which policy applies?", last_assistant: "Policy 4." });
	});

	it("reads a Telegram export, reading the opening sender as the user", () => {
		const dir = project({
			"imports/telegram.json": JSON.stringify({
				chats: {
					list: [
						{
							name: "Support",
							type: "personal_chat",
							messages: [
								{ id: 1, type: "message", from: "Ann", from_id: "user1", text: "Where is my refund?" },
								{ id: 2, type: "service", from: "Ann", from_id: "user1", text: "joined" },
								{ id: 3, type: "message", from: "Bot", from_id: "bot1", text: [{ type: "plain", text: "In three days." }] },
							],
						},
					],
				},
			}),
		});
		const preview = inspectDatasetFile({ projectDir: dir, sourcePath: "imports/telegram.json" });
		expect(preview.format).toBe("chat-export");
		expect(preview.sampleRows[0]).toMatchObject({
			last_user: "Where is my refund?",
			last_assistant: "In three days.",
			message_count: "2",
		});
	});

	it("reads the generic role/content shapes", () => {
		const dir = project({
			"imports/bare.json": JSON.stringify([
				{ role: "user", content: "One?" },
				{ role: "system", content: "ignored" },
				{ role: "assistant", content: "Two." },
			]),
			"imports/wrapped.jsonl": `${JSON.stringify({ messages: [{ role: "user", content: "A?" }] })}\n${JSON.stringify({ messages: [{ role: "user", content: "B?" }] })}\n`,
		});
		const bare = inspectDatasetFile({ projectDir: dir, sourcePath: "imports/bare.json" });
		expect(bare.format).toBe("chat-export");
		expect(bare.rowCount).toBe(1);
		expect(bare.sampleRows[0]?.message_count).toBe("2");

		const wrapped = inspectDatasetFile({ projectDir: dir, sourcePath: "imports/wrapped.jsonl" });
		expect(wrapped.format).toBe("chat-export");
		expect(wrapped.rowCount).toBe(2);
	});

	it("keeps a dataset row with a messages cell as a row, not a conversation", () => {
		const dir = project({
			"imports/rows.jsonl": `${JSON.stringify({ question: "A?", messages: [{ role: "user", content: "A?" }] })}\n`,
		});
		const preview = inspectDatasetFile({ projectDir: dir, sourcePath: "imports/rows.jsonl" });
		expect(preview.format).toBe("jsonl");
		expect(preview.columns.map((column) => column.name)).toEqual(["question", "messages"]);
	});

	it("refuses a delimited file whose rows carry more fields than the header", () => {
		const dir = project({ "imports/ragged.csv": "a,b\n1,2\n3,4,5\n" });
		expect(() => inspectDatasetFile({ projectDir: dir, sourcePath: "imports/ragged.csv" }))
			.toThrow(/1 rows carry more fields than the 2-column header, starting at row 3/);
	});
});

describe("dataset preview", () => {
	it("bounds rows and cells and redacts credentials", () => {
		const long = "x".repeat(500);
		const rows = ["id,note,secret"];
		for (let index = 1; index <= 60; index += 1) {
			rows.push(`row-${index},${long},api_key: sk-abcdefghijklmnopq`);
		}
		const dir = project({ "imports/wide.csv": `${rows.join("\n")}\n` });
		const preview = inspectDatasetFile({ projectDir: dir, sourcePath: "imports/wide.csv" });

		expect(preview.rowCount).toBe(60);
		expect(preview.sampleRows).toHaveLength(MAX_PREVIEW_ROWS);
		for (const row of preview.sampleRows) {
			for (const value of Object.values(row)) expect(value.length).toBeLessThanOrEqual(MAX_PREVIEW_CELL_CHARS);
		}
		expect(preview.sampleRows[0]?.secret).toContain("[REDACTED]");
		expect(preview.sampleRows[0]?.secret).not.toContain("sk-abcdefghijklmnopq");
		expect(preview.columns.find((column) => column.name === "note")?.samples[0]?.length)
			.toBeLessThanOrEqual(MAX_PREVIEW_CELL_CHARS);
		expect(preview.columns.find((column) => column.name === "id")?.samples).toHaveLength(3);
	});

	it("never shows a row the sealed slice reserved", () => {
		const dir = project({ "imports/basket.csv": csvRows(100) });
		const holdout = { count: 20, seed: "exam-1" };
		const split = holdOutSealedSlice({ projectDir: dir, sourcePath: "imports/basket.csv", ...holdout });
		const preview = inspectDatasetFile({ projectDir: dir, sourcePath: "imports/basket.csv", holdout });

		expect(preview.rowCount).toBe(80);
		expect(preview.holdout).toEqual({ reserved: 20, seed: "exam-1" });
		const sealedIds = new Set(split.sealedRowIndexes.map((index) => `row-${index}`));
		for (const row of preview.sampleRows) expect(sealedIds.has(row.id ?? "")).toBe(false);
	});
});

describe("sealed slice", () => {
	it("is deterministic from the file hash, seed and count", () => {
		const dir = project({ "imports/basket.csv": csvRows(100) });
		const first = holdOutSealedSlice({ projectDir: dir, sourcePath: "imports/basket.csv", count: 20, seed: "exam-1" });
		const again = holdOutSealedSlice({ projectDir: dir, sourcePath: "imports/basket.csv", count: 20, seed: "exam-1" });
		const other = holdOutSealedSlice({ projectDir: dir, sourcePath: "imports/basket.csv", count: 20, seed: "exam-2" });

		expect(first.sealedRowIndexes).toEqual(again.sealedRowIndexes);
		expect(first.sealedRowIndexes).toHaveLength(20);
		expect(first.remainingRowIndexes).toHaveLength(80);
		expect([...first.sealedRowIndexes].sort((a, b) => a - b)).toEqual(first.sealedRowIndexes);
		expect(first.sealedRowIndexes).not.toEqual(other.sealedRowIndexes);
		expect(first.sealedRowIndexes.some((index) => first.remainingRowIndexes.includes(index))).toBe(false);
	});

	it("keeps each stratum's share of the whole", () => {
		const dir = project({ "imports/basket.csv": csvRows(100, (index) => (index <= 60 ? "gold" : "silver")) });
		const split = holdOutSealedSlice({
			projectDir: dir,
			sourcePath: "imports/basket.csv",
			count: 10,
			seed: "exam-1",
			stratifyBy: "tier",
		});
		const gold = split.sealedRowIndexes.filter((index) => index <= 60).length;
		expect(gold).toBe(6);
		expect(split.sealedRowIndexes.length - gold).toBe(4);
	});

	it("refuses a slice that would leave nothing to develop against", () => {
		const dir = project({ "imports/basket.csv": csvRows(5) });
		expect(() => holdOutSealedSlice({ projectDir: dir, sourcePath: "imports/basket.csv", count: 5, seed: "s" }))
			.toThrow(/the dataset has 5 rows; a sealed slice of 5 would leave nothing/);
	});

	it("stratifies only by a column the dataset has", () => {
		const dir = project({ "imports/basket.csv": csvRows(10) });
		expect(() => holdOutSealedSlice({ projectDir: dir, sourcePath: "imports/basket.csv", count: 2, seed: "s", stratifyBy: "grade" }))
			.toThrow(/no column named "grade"/);
	});
});

describe("mapping recipe", () => {
	it("rejects a recipe that names a column the dataset does not have", () => {
		const dir = project({ "imports/basket.csv": csvRows(4) });
		expect(() => compileDatasetCases({
			projectDir: dir,
			sourcePath: "imports/basket.csv",
			recipe: recipe({ input: { column: "prompt" }, expected: { column: "reference" } }),
		})).toThrow(/names columns the dataset does not have: prompt, reference/);
	});

	it("rejects a placeholder that names no column, before any row is mapped", () => {
		const dir = project({ "imports/basket.csv": csvRows(4) });
		expect(() => compileDatasetCases({
			projectDir: dir,
			sourcePath: "imports/basket.csv",
			recipe: recipe({ graders: [{ type: "output_contains", text: "{{reference}}", caseSensitive: false }] }),
		})).toThrow(/names columns the dataset does not have: reference/);
	});

	it("rejects a filter regex that does not compile", () => {
		const dir = project({ "imports/basket.csv": csvRows(4) });
		expect(() => compileDatasetCases({
			projectDir: dir,
			sourcePath: "imports/basket.csv",
			recipe: recipe({ filters: [{ column: "tier", matches: "gold(" }] }),
		})).toThrow(/the mapping recipe is invalid: matches must be a valid regular expression/);
	});

	it("rejects a recipe that maps neither an input nor a dialogue", () => {
		const dir = project({ "imports/basket.csv": csvRows(4) });
		expect(() => compileDatasetCases({
			projectDir: dir,
			sourcePath: "imports/basket.csv",
			recipe: { schemaVersion: 1, graders: [{ type: "output_contains", text: "ok" }] },
		})).toThrow(/a recipe needs an input mapping, a dialogue column, or both/);
	});

	it("fills {{column}} and {{expected}} placeholders in the input template and the graders", () => {
		const dir = project({ "imports/basket.csv": "question,answer,tier\nHow long?,30 days,gold\n" });
		const compiled = compileDatasetCases({
			projectDir: dir,
			sourcePath: "imports/basket.csv",
			recipe: recipe({
				input: { template: "Customer ({{tier}}) asks: {{question}}" },
				expected: { column: "answer" },
				graders: [
					{ type: "output_contains", text: "{{answer}}", caseSensitive: false },
					{ type: "judge", rubric: "The reply matches the reference: {{expected}}" },
				],
			}),
		});

		expect(compiled.tasks).toHaveLength(1);
		expect(compiled.tasks[0]?.input).toBe("Customer (gold) asks: How long?");
		expect(compiled.tasks[0]?.expected).toBe("30 days");
		expect(compiled.tasks[0]?.graders).toEqual([
			{ type: "output_contains", text: "30 days", caseSensitive: false },
			{ type: "judge", rubric: "The reply matches the reference: 30 days" },
		]);
	});
});

describe("compiling cases", () => {
	it("is deterministic, derives ids, and never trusts one from the file", () => {
		const dir = project({ "imports/basket.csv": csvRows(6) });
		const options = { projectDir: dir, sourcePath: "imports/basket.csv", recipe: recipe({ metadata: ["id"] }) };
		const first = compileDatasetCases(options);
		const again = compileDatasetCases(options);

		expect(first.tasks).toEqual(again.tasks);
		expect(first.rowsSeen).toBe(6);
		expect(first.tasks).toHaveLength(6);
		expect(first.tasks.map((task) => task.input)).toEqual([
			"Question 1?", "Question 2?", "Question 3?", "Question 4?", "Question 5?", "Question 6?",
		]);
		for (const task of first.tasks) expect(task.id).toMatch(/^task-[0-9a-f]{64}$/);
		expect(first.tasks[0]?.metadata).toEqual({ id: "row-1" });
		expect(first.sourceSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(first.recipeSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it("applies filters, excludes the sealed rows, and samples with a seed", () => {
		const dir = project({ "imports/basket.csv": csvRows(100, (index) => (index % 2 === 0 ? "gold" : "silver")) });
		const holdout = { count: 10, seed: "exam-1" };
		const sealed = holdOutSealedSlice({ projectDir: dir, sourcePath: "imports/basket.csv", ...holdout });
		const compiled = compileDatasetCases({
			projectDir: dir,
			sourcePath: "imports/basket.csv",
			holdout,
			recipe: recipe({
				metadata: ["id"],
				filters: [{ column: "tier", equals: "gold" }],
				sample: { limit: 12, seed: "sample-1" },
			}),
		});

		expect(compiled.tasks).toHaveLength(12);
		const chosen = new Set(compiled.tasks.map((task) => task.metadata?.id));
		for (const index of sealed.sealedRowIndexes) expect(chosen.has(`row-${index}`)).toBe(false);
		for (const task of compiled.tasks) expect(Number(task.metadata?.id?.replace("row-", "")) % 2).toBe(0);
		expect(compileDatasetCases({
			projectDir: dir,
			sourcePath: "imports/basket.csv",
			holdout,
			recipe: recipe({
				metadata: ["id"],
				filters: [{ column: "tier", equals: "gold" }],
				sample: { limit: 12, seed: "sample-2" },
			}),
		}).tasks.map((task) => task.id)).not.toEqual(compiled.tasks.map((task) => task.id));
	});

	it("compiles the sealed rows alone, with the same recipe and no sampling", () => {
		const dir = project({ "imports/basket.csv": csvRows(40) });
		const holdout = { count: 8, seed: "exam-1" };
		const split = holdOutSealedSlice({ projectDir: dir, sourcePath: "imports/basket.csv", ...holdout });
		const sealed = compileSealedSlice({
			projectDir: dir,
			sourcePath: "imports/basket.csv",
			holdout,
			recipe: recipe({ metadata: ["id"], sample: { limit: 2, seed: "sample-1" } }),
		});

		expect(sealed.tasks).toHaveLength(8);
		expect(sealed.tasks.map((task) => task.metadata?.id))
			.toEqual(split.sealedRowIndexes.map((index) => `row-${index}`));
	});

	it("skips rows it cannot map and reports the row number only", () => {
		const dir = project({ "imports/basket.csv": "question,answer\nFirst?,One\n,Two\nThird?,Three\n" });
		const compiled = compileDatasetCases({
			projectDir: dir,
			sourcePath: "imports/basket.csv",
			recipe: recipe(),
		});

		expect(compiled.tasks).toHaveLength(2);
		expect(compiled.skipped).toEqual([{ row: 2, reason: "the mapped input is empty" }]);
	});

	it("turns a chat export into dialogue cases whose input is the last user turn", () => {
		const dir = project({
			"imports/chats.jsonl": [
				JSON.stringify({ messages: [
					{ role: "user", content: "How long is the window?" },
					{ role: "assistant", content: "Thirty days." },
					{ role: "user", content: "And for gold customers?" },
				] }),
				JSON.stringify({ messages: [{ role: "assistant", content: "Nothing was asked." }] }),
			].join("\n"),
		});
		const compiled = compileDatasetCases({
			projectDir: dir,
			sourcePath: "imports/chats.jsonl",
			recipe: {
				schemaVersion: 1,
				dialogue: { column: "messages" },
				graders: [{ type: "output_contains", text: "gold" }],
			},
		});

		expect(compiled.tasks).toHaveLength(1);
		expect(compiled.tasks[0]?.input).toBe("And for gold customers?");
		expect(compiled.tasks[0]?.messages).toEqual([
			{ role: "user", content: "How long is the window?" },
			{ role: "assistant", content: "Thirty days." },
			{ role: "user", content: "And for gold customers?" },
		]);
		expect(compiled.skipped).toEqual([{ row: 2, reason: "the dialogue carries no user turn" }]);
	});

	it("appends the mapped input as the closing user turn when both are mapped", () => {
		const dir = project({
			"imports/basket.jsonl": `${JSON.stringify({
				history: [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi" }],
				question: "What is the window?",
			})}\n`,
		});
		const compiled = compileDatasetCases({
			projectDir: dir,
			sourcePath: "imports/basket.jsonl",
			recipe: {
				schemaVersion: 1,
				input: { column: "question" },
				dialogue: { column: "history" },
				graders: [{ type: "output_contains", text: "days" }],
			},
		});

		expect(compiled.tasks[0]?.input).toBe("What is the window?");
		expect(compiled.tasks[0]?.messages).toHaveLength(3);
		expect(compiled.tasks[0]?.messages?.at(-1)).toEqual({ role: "user", content: "What is the window?" });
	});

	it("round-trips expected, messages and metadata through a corpus", () => {
		const dir = project({
			"imports/basket.csv": "question,answer,tier\nHow long?,30 days,gold\nWho approves?,A manager,silver\n",
		});
		const compiled = compileDatasetCases({
			projectDir: dir,
			sourcePath: "imports/basket.csv",
			recipe: recipe({ expected: { column: "answer" }, metadata: ["tier"] }),
		});
		const stateRoot = join(dir, ".ahde");
		const metadata = createCorpus({
			stateRoot,
			projectId: "policy",
			name: "Development basket",
			visibility: "development",
			tasks: compiled.tasks,
		});
		const loaded = loadCorpus({ stateRoot, projectId: "policy", corpusId: metadata.id });

		expect(loaded.tasks).toEqual(compiled.tasks);
		expect(loaded.tasks[0]?.expected).toBe("30 days");
		expect(loaded.tasks[0]?.metadata).toEqual({ tier: "gold" });
	});
});

describe("inbox confinement", () => {
	it("refuses a path outside the imports inbox", () => {
		const dir = project({ "basket.csv": csvRows(2) });
		expect(() => inspectDatasetFile({ projectDir: dir, sourcePath: "basket.csv" }))
			.toThrow(/imports\/ inbox/);
		expect(() => inspectDatasetFile({ projectDir: dir, sourcePath: "/etc/passwd" }))
			.toThrow(/normalized project-relative path/);
		expect(() => inspectDatasetFile({ projectDir: dir, sourcePath: "imports/../basket.csv" }))
			.toThrow(/forbidden path segment/);
	});

	it("refuses a symlinked dataset", () => {
		const dir = project({ "secret.csv": csvRows(2) });
		symlinkSync(join(dir, "secret.csv"), join(dir, "imports", "linked.csv"));
		expect(() => inspectDatasetFile({ projectDir: dir, sourcePath: "imports/linked.csv" }))
			.toThrow(/may not contain symlink components/);
	});

	it("refuses a file over the dataset byte bound", () => {
		const dir = project();
		writeFileSync(join(dir, "imports", "huge.csv"), Buffer.alloc(MAX_DATASET_SOURCE_BYTES + 1, 0x61));
		expect(() => inspectDatasetFile({ projectDir: dir, sourcePath: "imports/huge.csv" }))
			.toThrow(new RegExp(`exceeds ${MAX_DATASET_SOURCE_BYTES} bytes`));
	});

	it("refuses an extension it cannot parse", () => {
		const dir = project({ "imports/sheet.xlsx": "binary" });
		expect(() => inspectDatasetFile({ projectDir: dir, sourcePath: "imports/sheet.xlsx" }))
			.toThrow(/must name a file ending in/);
	});
});

describe("ingest", () => {
	it("seals the holdout first, returns unpublished development cases, and writes a receipt", () => {
		const dir = project({ "imports/basket.csv": csvRows(50) });
		const stateRoot = join(dir, ".ahde");
		const result = ingestDataset({
			projectDir: dir,
			stateRoot,
			projectId: "policy",
			sourcePath: "imports/basket.csv",
			recipe: recipe({ expected: { column: "answer" }, metadata: ["id"] }),
			holdout: { count: 10, seed: "exam-1" },
			developmentName: "Refund basket",
			now: () => NOW,
		});

		expect(result.tasks).toHaveLength(40);
		expect(result.sealedCorpus?.visibility).toBe("sealed");
		expect(result.sealedCorpus?.taskCount).toBe(10);
		expect(result.sealedCorpus?.name).toBe("Refund basket (sealed)");
		expect(result.receipt).toEqual({
			schemaVersion: 1,
			sourcePath: "imports/basket.csv",
			sourceSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown as string,
			recipeSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) as unknown as string,
			format: "csv",
			rowsSeen: 50,
			developmentCount: 40,
			sealed: { corpusId: result.sealedCorpus?.id ?? "", count: 10, seed: "exam-1" },
			at: NOW,
		});

		const sha = result.receiptPath.split("/").at(-1)?.replace(".json", "") ?? "";
		expect(loadDatasetIngestReceipt(stateRoot, "policy", sha)).toEqual(result.receipt);

		const sealed = loadCorpus({ stateRoot, projectId: "policy", corpusId: result.sealedCorpus?.id ?? "" });
		const development = new Set(result.tasks.map((task) => task.metadata?.id));
		for (const task of sealed.tasks) expect(development.has(task.metadata?.id)).toBe(false);
	});

	it("repeats without republishing when the same file, recipe and holdout come back", () => {
		const dir = project({ "imports/basket.csv": csvRows(30) });
		const options = {
			projectDir: dir,
			stateRoot: join(dir, ".ahde"),
			projectId: "policy",
			sourcePath: "imports/basket.csv",
			recipe: recipe(),
			holdout: { count: 5, seed: "exam-1" },
			developmentName: "Refund basket",
			now: () => NOW,
		};
		const first = ingestDataset(options);
		const again = ingestDataset(options);

		expect(again.receipt).toEqual(first.receipt);
		expect(again.receiptPath).toBe(first.receiptPath);
		expect(again.sealedCorpus?.id).toBe(first.sealedCorpus?.id);
		expect(again.tasks).toEqual(first.tasks);
	});

	it("keeps a preview free of the sealed corpus and of its rows", () => {
		const dir = project({ "imports/basket.csv": csvRows(30) });
		const holdout = { count: 5, seed: "exam-1" };
		ingestDataset({
			projectDir: dir,
			stateRoot: join(dir, ".ahde"),
			projectId: "policy",
			sourcePath: "imports/basket.csv",
			recipe: recipe(),
			holdout,
			developmentName: "Refund basket",
			now: () => NOW,
		});
		const preview = inspectDatasetFile({ projectDir: dir, sourcePath: "imports/basket.csv", holdout });

		expect(JSON.stringify(preview)).not.toMatch(/corpus-[0-9a-f]{64}/);
		expect(preview.rowCount).toBe(25);
	});
});

describe("the ahde target feedback inbox as a dataset", () => {
	function markedProject(): string {
		const dir = project();
		for (const mark of [
			{
				messages: [
					{ role: "user", content: "Проверь договор 42 и ограничения ДБО." },
					{ role: "assistant", content: "Ограничений нет." },
				],
				verdict: "bad",
				note: "не вызвал check_dbo",
				at: "2026-08-30T07:00:00.000Z",
				target: { id: "my-agent", gitSha: "abc123" },
			},
			{
				messages: [
					{ role: "user", content: "Кто утверждает возврат?" },
					{ role: "assistant", content: "Менеджер." },
					{ role: "user", content: "А если сумма больше лимита?" },
					{ role: "assistant", content: "Тогда директор." },
				],
				verdict: "good",
				at: "2026-08-30T07:05:00.000Z",
				target: { id: "my-agent", gitSha: "abc123" },
			},
		]) {
			appendTargetFeedbackMark(dir, mark as TargetFeedbackMark);
		}
		return dir;
	}

	it("previews as bounded JSONL with the verdict and note as their own columns", () => {
		const preview = inspectDatasetFile({ projectDir: markedProject(), sourcePath: TARGET_FEEDBACK_PATH });

		// A row that carries siblings beside its turns is a dataset row with a
		// messages cell, not a bare chat export — which is exactly what makes
		// `verdict` and `note` addressable columns.
		expect(preview.format).toBe("jsonl");
		expect(preview.columns.map((column) => column.name)).toEqual([
			"messages",
			"verdict",
			"note",
			"at",
			"target.id",
			"target.gitSha",
		]);
		expect(preview.columns.find((column) => column.name === "messages")?.inferredType).toBe("json");
		expect(preview.rowCount).toBe(2);
	});

	it("compiles marked dialogues into dialogue cases that keep verdict and note as metadata", () => {
		const dir = markedProject();

		const compiled = compileDatasetCases({
			projectDir: dir,
			sourcePath: TARGET_FEEDBACK_PATH,
			recipe: {
				schemaVersion: 1,
				dialogue: { column: "messages" },
				metadata: ["verdict", "note"],
				graders: [{ type: "output_contains", text: "договор" }],
			},
		});

		expect(compiled.skipped).toEqual([]);
		expect(compiled.tasks).toHaveLength(2);
		const [bad, good] = compiled.tasks;
		// The marked assistant reply is popped: a case re-asks the question that
		// produced it, and the grader judges the next reply.
		expect(bad?.input).toBe("Проверь договор 42 и ограничения ДБО.");
		expect(bad?.messages).toEqual([{ role: "user", content: "Проверь договор 42 и ограничения ДБО." }]);
		expect(bad?.metadata).toEqual({ verdict: "bad", note: "не вызвал check_dbo" });
		expect(good?.input).toBe("А если сумма больше лимита?");
		expect(good?.messages).toEqual([
			{ role: "user", content: "Кто утверждает возврат?" },
			{ role: "assistant", content: "Менеджер." },
			{ role: "user", content: "А если сумма больше лимита?" },
		]);
		// A `good` mark carries no note; the column is simply absent.
		expect(good?.metadata).toEqual({ verdict: "good" });
	});

	it("selects only the bad marks when a recipe filters on the verdict column", () => {
		const compiled = compileDatasetCases({
			projectDir: markedProject(),
			sourcePath: TARGET_FEEDBACK_PATH,
			recipe: {
				schemaVersion: 1,
				dialogue: { column: "messages" },
				metadata: ["verdict", "note"],
				filters: [{ column: "verdict", equals: "bad" }],
				graders: [{ type: "judge", rubric: "The reply must check the contract before answering." }],
			},
		});

		expect(compiled.tasks).toHaveLength(1);
		expect(compiled.tasks[0]?.metadata?.verdict).toBe("bad");
	});
});

describe("hash stability", () => {
	it("hashes a corpus of plain cases exactly as it did before the new fields existed", () => {
		const dir = project();
		const metadata = createCorpus({
			stateRoot: join(dir, "state"),
			projectId: "probe",
			name: "Probe basket",
			visibility: "development",
			tasks: [
				{ id: "task_001", input: "What is the refund window?", graders: [{ type: "output_contains", text: "30 days" }] },
				{ id: "task_002", input: "Who approves a refund?", graders: [{ type: "output_matches", pattern: "manager" }] },
			],
		});

		expect(metadata.hash).toBe("sha256:868835065b85ca5c84b2a019211a558e77c3a74a3cefb1acefee8abe60ff4d57");
		expect(metadata.id).toBe("corpus-36bb31c3f408987959f1863ee75d2a86590fe338358502533ed1803bd5e6b9c4");
	});
});
