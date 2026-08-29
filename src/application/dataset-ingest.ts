import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
	createCorpus,
	listCorpora,
	CorpusError,
	CorpusTaskSchema,
	type CorpusMetadata,
	type CorpusTask,
} from "../corpus.js";
import {
	GraderSpec,
	MAX_TASK_MESSAGES,
	MAX_TASK_METADATA_KEY_CHARS,
	MAX_TASK_METADATA_KEYS,
	MAX_TASK_METADATA_VALUE_CHARS,
	MAX_TASK_TEXT_BYTES,
	taskDialogueIssue,
	type DialogueMessage,
} from "../manifest.js";
import { canonicalJson, HashSchema, hashValue } from "../provenance.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import { redactTraceText } from "../trace.js";
import {
	DATASET_FORMATS,
	inferColumnType,
	MAX_DATASET_ROWS,
	parseDataset,
	parseDialogueCell,
	type DatasetColumnType,
	type DatasetFormat,
	type DatasetRow,
	type ParsedDataset,
} from "./dataset-parse.js";
import { DatasetSourcePathSchema, readDatasetSource, type DatasetSourceFile } from "./dataset-source.js";

export {
	DATASET_FORMATS,
	MAX_DATASET_COLUMNS,
	MAX_DATASET_ROWS,
	type DatasetColumnType,
	type DatasetFormat,
} from "./dataset-parse.js";
export { DatasetSourcePathSchema, MAX_DATASET_SOURCE_BYTES } from "./dataset-source.js";

/** A preview stays small enough for a human to read and a model to hold. */
export const MAX_PREVIEW_ROWS = 20;
export const MAX_PREVIEW_CELL_CHARS = 200;
export const MAX_PREVIEW_COLUMN_SAMPLES = 3;
export const MAX_COMPILE_SKIPPED = 100;
export const MAX_CASE_INPUT_CHARS = 32_000;
export const MAX_RECIPE_SAMPLE_LIMIT = 1_000;

const ProjectIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const CorpusIdSchema = z.string().regex(/^corpus-[0-9a-f]{64}$/);
const ReceiptShaSchema = z.string().regex(/^[0-9a-f]{64}$/);
const SeedSchema = z.string().min(1).max(200);
const ColumnNameSchema = z.string().min(1).max(200);
const PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g;
const EXPECTED_PLACEHOLDER = "expected";

// ---------- preview ----------

export interface DatasetHoldoutSpec {
	count: number;
	seed: string;
	stratifyBy?: string;
}

export interface DatasetColumnPreview {
	name: string;
	inferredType: DatasetColumnType;
	samples: string[];
}

export interface DatasetPreview {
	format: DatasetFormat;
	columns: DatasetColumnPreview[];
	/** Rows the Builder may see: everything the sealed slice did not take. */
	rowCount: number;
	sampleRows: Record<string, string>[];
	sha256: string;
	bytes: number;
	holdout: { reserved: number; seed: string } | null;
}

export interface InspectDatasetFileOptions {
	projectDir: string;
	sourcePath: string;
	holdout?: DatasetHoldoutSpec | null;
}

// ---------- mapping recipe ----------

const RegexSchema = z.string().min(1).max(1_000).refine((pattern) => {
	try {
		new RegExp(pattern);
		return true;
	} catch {
		return false;
	}
}, "matches must be a valid regular expression");

const DatasetFilterSchema = z.strictObject({
	column: ColumnNameSchema,
	equals: z.string().max(1_000).optional(),
	matches: RegexSchema.optional(),
}).superRefine((filter, context) => {
	const given = [filter.equals, filter.matches].filter((value) => value !== undefined).length;
	if (given !== 1) {
		context.addIssue({ code: "custom", message: "a filter must carry exactly one of equals or matches" });
	}
});

const InputTemplateSchema = z.string().min(1).max(MAX_CASE_INPUT_CHARS).refine(
	(template) => placeholderNames(template).length > 0,
	"an input template must reference at least one column",
);

export const DatasetMappingRecipeSchema = z.strictObject({
	schemaVersion: z.literal(1),
	input: z.union([
		z.strictObject({ column: ColumnNameSchema }),
		z.strictObject({ template: InputTemplateSchema }),
	]).optional(),
	expected: z.strictObject({ column: ColumnNameSchema }).optional(),
	/** A messages column; its last user turn becomes the case input. */
	dialogue: z.strictObject({ column: ColumnNameSchema }).optional(),
	metadata: z.array(ColumnNameSchema).min(1).max(MAX_TASK_METADATA_KEYS).optional(),
	filters: z.array(DatasetFilterSchema).max(16).optional(),
	sample: z.strictObject({
		limit: z.number().int().min(1).max(MAX_RECIPE_SAMPLE_LIMIT),
		stratifyBy: ColumnNameSchema.optional(),
		seed: SeedSchema,
	}).optional(),
	graders: z.array(GraderSpec).min(1).max(16),
	idPrefix: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).optional(),
}).superRefine((recipe, context) => {
	if (!recipe.input && !recipe.dialogue) {
		context.addIssue({
			code: "custom",
			path: ["input"],
			message: "a recipe needs an input mapping, a dialogue column, or both",
		});
	}
});
export type DatasetMappingRecipe = z.infer<typeof DatasetMappingRecipeSchema>;

// ---------- compilation ----------

export interface DatasetSkippedRow {
	row: number;
	reason: string;
}

export interface CompiledDatasetCases {
	tasks: CorpusTask[];
	sourceSha256: string;
	recipeSha256: string;
	skipped: DatasetSkippedRow[];
	/** Rows parsed out of the file, before filters, sealing or sampling. */
	rowsSeen: number;
}

export interface CompileDatasetCasesOptions {
	projectDir: string;
	sourcePath: string;
	recipe: unknown;
	holdout?: DatasetHoldoutSpec | null;
}

export interface CompileSealedSliceOptions {
	projectDir: string;
	sourcePath: string;
	recipe: unknown;
	holdout: DatasetHoldoutSpec;
}

export interface HoldOutSealedSliceOptions {
	projectDir: string;
	sourcePath: string;
	count: number;
	seed: string;
	stratifyBy?: string;
}

export interface SealedSliceSplit {
	sealedRowIndexes: number[];
	remainingRowIndexes: number[];
}

// ---------- receipt ----------

export const DatasetIngestReceiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	sourcePath: DatasetSourcePathSchema,
	sourceSha256: HashSchema,
	recipeSha256: HashSchema,
	format: z.enum(DATASET_FORMATS),
	rowsSeen: z.number().int().nonnegative().max(MAX_DATASET_ROWS),
	developmentCount: z.number().int().nonnegative(),
	sealed: z.strictObject({
		corpusId: CorpusIdSchema,
		count: z.number().int().positive(),
		seed: SeedSchema,
	}).nullable(),
	at: z.iso.datetime({ offset: true }),
});
export type DatasetIngestReceipt = z.infer<typeof DatasetIngestReceiptSchema>;

export interface IngestDatasetOptions {
	projectDir: string;
	stateRoot: string;
	projectId: string;
	sourcePath: string;
	recipe: unknown;
	holdout: DatasetHoldoutSpec | null;
	developmentName: string;
	sealedName?: string;
	now?: () => string;
}

export interface DatasetIngestResult {
	receipt: DatasetIngestReceipt;
	receiptPath: string;
	/** Development cases, deliberately unpublished: the draft flow owns publication. */
	tasks: CorpusTask[];
	developmentName: string;
	skipped: DatasetSkippedRow[];
	sealedCorpus: CorpusMetadata | null;
}

// ---------- placeholders ----------

function placeholderNames(text: string): string[] {
	const names: string[] = [];
	for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
		names.push((match[1] ?? "").trim());
	}
	return names;
}

function graderTexts(grader: GraderSpec): string[] {
	const texts: string[] = [];
	if (grader.name !== undefined) texts.push(grader.name);
	switch (grader.type) {
		case "tool_called":
			texts.push(grader.tool);
			if (grader.argsContains !== undefined) texts.push(grader.argsContains);
			break;
		case "output_contains":
			texts.push(grader.text);
			break;
		case "output_matches":
			texts.push(grader.pattern);
			break;
		case "judge":
			texts.push(grader.rubric);
			break;
	}
	return texts;
}

function substituteGrader(grader: GraderSpec, resolve: (name: string) => string): GraderSpec {
	const substituted = (text: string): string => text.replace(PLACEHOLDER_PATTERN, (_match, name: string) => resolve(name.trim()));
	const named = grader.name !== undefined ? { name: substituted(grader.name) } : {};
	switch (grader.type) {
		case "tool_called":
			return {
				...grader,
				...named,
				tool: substituted(grader.tool),
				...(grader.argsContains !== undefined ? { argsContains: substituted(grader.argsContains) } : {}),
			};
		case "output_contains":
			return { ...grader, ...named, text: substituted(grader.text) };
		case "output_matches":
			return { ...grader, ...named, pattern: substituted(grader.pattern) };
		case "judge":
			return { ...grader, ...named, rubric: substituted(grader.rubric) };
	}
}

/** Every column a recipe names, so a missing one fails before any row is mapped. */
function recipeColumnIssues(recipe: DatasetMappingRecipe, columns: readonly string[]): string[] {
	const known = new Set(columns);
	const missing = new Set<string>();
	const require = (name: string): void => {
		if (!known.has(name)) missing.add(name);
	};
	if (recipe.input && "column" in recipe.input) require(recipe.input.column);
	if (recipe.expected) require(recipe.expected.column);
	if (recipe.dialogue) require(recipe.dialogue.column);
	for (const column of recipe.metadata ?? []) require(column);
	for (const filter of recipe.filters ?? []) require(filter.column);
	if (recipe.sample?.stratifyBy) require(recipe.sample.stratifyBy);

	const placeholders: string[] = [];
	if (recipe.input && "template" in recipe.input) placeholders.push(...placeholderNames(recipe.input.template));
	for (const grader of recipe.graders) {
		for (const text of graderTexts(grader)) placeholders.push(...placeholderNames(text));
	}
	const issues: string[] = [];
	for (const name of placeholders) {
		if (name.length === 0) {
			issues.push("the recipe carries an empty {{}} placeholder");
			continue;
		}
		if (name === EXPECTED_PLACEHOLDER && recipe.expected) continue;
		require(name);
	}
	if (missing.size > 0) {
		const names = [...missing].sort().slice(0, 10).join(", ");
		issues.push(`the recipe names columns the dataset does not have: ${names}`);
	}
	for (const column of recipe.metadata ?? []) {
		if (column.length > MAX_TASK_METADATA_KEY_CHARS) {
			issues.push(`metadata column names must be at most ${MAX_TASK_METADATA_KEY_CHARS} characters`);
			break;
		}
	}
	return issues;
}

function parseRecipe(value: unknown, columns: readonly string[]): DatasetMappingRecipe {
	const parsed = DatasetMappingRecipeSchema.safeParse(value);
	if (!parsed.success) {
		const detail = parsed.error.issues.map((issue) => issue.message).slice(0, 5).join("; ");
		throw new Error(`the mapping recipe is invalid: ${detail}`);
	}
	const issues = recipeColumnIssues(parsed.data, columns);
	if (issues.length > 0) throw new Error(issues.join("; "));
	return parsed.data;
}

// ---------- deterministic selection ----------

function selectionKey(sourceSha256: string, scope: string, seed: string, rowIndex: number): string {
	return createHash("sha256").update(`${sourceSha256} ${scope} ${seed} ${rowIndex}`).digest("hex");
}

/**
 * Largest-remainder allocation, so a stratified draw keeps each group's share
 * of the whole and never depends on iteration order.
 */
function allocate(groups: readonly { key: string; size: number }[], count: number): Map<string, number> {
	const total = groups.reduce((sum, group) => sum + group.size, 0);
	const allocation = new Map<string, number>();
	if (total === 0) return allocation;
	const remainders: { key: string; remainder: number }[] = [];
	let assigned = 0;
	for (const group of groups) {
		const exact = (count * group.size) / total;
		const floor = Math.min(group.size, Math.floor(exact));
		allocation.set(group.key, floor);
		assigned += floor;
		remainders.push({ key: group.key, remainder: exact - floor });
	}
	const ordered = [...remainders].sort((a, b) =>
		a.remainder === b.remainder ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : b.remainder - a.remainder,
	);
	const capacity = new Map(groups.map((group) => [group.key, group.size]));
	for (let pass = 0; pass < 2 && assigned < count; pass += 1) {
		for (const entry of ordered) {
			if (assigned >= count) break;
			const current = allocation.get(entry.key) ?? 0;
			if (current >= (capacity.get(entry.key) ?? 0)) continue;
			allocation.set(entry.key, current + 1);
			assigned += 1;
		}
	}
	return allocation;
}

function selectRowIndexes(
	rows: readonly DatasetRow[],
	count: number,
	keyOf: (row: DatasetRow) => string,
	stratifyBy: string | null,
): number[] {
	if (count >= rows.length) return rows.map((row) => row.index);
	const byKey = (a: DatasetRow, b: DatasetRow): number => {
		const left = keyOf(a);
		const right = keyOf(b);
		return left === right ? a.index - b.index : left < right ? -1 : 1;
	};
	if (!stratifyBy) {
		return [...rows].sort(byKey).slice(0, count).map((row) => row.index).sort((a, b) => a - b);
	}
	const groups = new Map<string, DatasetRow[]>();
	for (const row of rows) {
		const key = row.cells[stratifyBy] ?? "";
		const group = groups.get(key);
		if (group) group.push(row);
		else groups.set(key, [row]);
	}
	const ordered = [...groups.entries()]
		.map(([key, members]) => ({ key, size: members.length }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const allocation = allocate(ordered, count);
	const selected: number[] = [];
	for (const group of ordered) {
		const members = groups.get(group.key) ?? [];
		const take = allocation.get(group.key) ?? 0;
		for (const row of [...members].sort(byKey).slice(0, take)) selected.push(row.index);
	}
	return selected.sort((a, b) => a - b);
}

// ---------- reading ----------

interface LoadedDataset {
	source: DatasetSourceFile;
	parsed: ParsedDataset;
}

function loadDataset(projectDir: string, sourcePath: string, protectedRoots?: readonly string[]): LoadedDataset {
	const source = readDatasetSource({
		projectDir,
		sourcePath,
		...(protectedRoots ? { protectedRoots } : {}),
	});
	return { source, parsed: parseDataset(source) };
}

function sealedIndexes(loaded: LoadedDataset, holdout: DatasetHoldoutSpec | null | undefined): Set<number> {
	if (!holdout) return new Set();
	return new Set(sealedSplit(loaded, holdout).sealedRowIndexes);
}

function sealedSplit(loaded: LoadedDataset, holdout: DatasetHoldoutSpec): SealedSliceSplit {
	const rows = loaded.parsed.rows;
	const count = Math.trunc(holdout.count);
	if (!Number.isSafeInteger(count) || count < 1) throw new Error("a sealed slice must reserve at least one row");
	if (count >= rows.length) {
		throw new Error(`the dataset has ${rows.length} rows; a sealed slice of ${count} would leave nothing to develop against`);
	}
	const seed = SeedSchema.parse(holdout.seed);
	const stratifyBy = holdout.stratifyBy ?? null;
	if (stratifyBy !== null && !loaded.parsed.columns.includes(stratifyBy)) {
		throw new Error(`the dataset has no column named ${JSON.stringify(stratifyBy)} to stratify the sealed slice by`);
	}
	const sealed = selectRowIndexes(
		rows,
		count,
		(row) => selectionKey(loaded.source.sha256, "sealed", seed, row.index),
		stratifyBy,
	);
	const reserved = new Set(sealed);
	return {
		sealedRowIndexes: sealed,
		remainingRowIndexes: rows.map((row) => row.index).filter((index) => !reserved.has(index)),
	};
}

/**
 * Reserve rows deterministically from (file sha256, seed, count, stratifyBy).
 * The split is recomputed on demand and never persisted, so the sealed rows
 * cannot be read back out of AHDE state.
 */
export function holdOutSealedSlice(options: HoldOutSealedSliceOptions): SealedSliceSplit {
	const loaded = loadDataset(options.projectDir, options.sourcePath);
	return sealedSplit(loaded, {
		count: options.count,
		seed: options.seed,
		...(options.stratifyBy !== undefined ? { stratifyBy: options.stratifyBy } : {}),
	});
}

function previewCell(value: string): string {
	const redacted = redactTraceText(value);
	return redacted.length <= MAX_PREVIEW_CELL_CHARS
		? redacted
		: `${redacted.slice(0, MAX_PREVIEW_CELL_CHARS - 1)}…`;
}

/**
 * A bounded, credential-redacted look at the rows the Builder is allowed to
 * see. Rows reserved by the sealed slice are removed before anything here is
 * computed, so neither the samples nor the inferred types describe them.
 */
export function inspectDatasetFile(options: InspectDatasetFileOptions): DatasetPreview {
	const loaded = loadDataset(options.projectDir, options.sourcePath);
	const reserved = sealedIndexes(loaded, options.holdout);
	const visible = loaded.parsed.rows.filter((row) => !reserved.has(row.index));
	if (visible.length === 0) throw new Error("the sealed slice reserved every row; nothing is left to preview");

	const columns = loaded.parsed.columns.map((name) => {
		const values = visible.map((row) => row.cells[name] ?? "");
		const samples: string[] = [];
		const seen = new Set<string>();
		for (const value of values) {
			if (samples.length >= MAX_PREVIEW_COLUMN_SAMPLES) break;
			if (value.trim().length === 0 || seen.has(value)) continue;
			seen.add(value);
			samples.push(previewCell(value));
		}
		return { name, inferredType: inferColumnType(values), samples };
	});

	const stride = Math.max(1, Math.floor(visible.length / MAX_PREVIEW_ROWS));
	const sampleRows: Record<string, string>[] = [];
	for (let index = 0; index < visible.length && sampleRows.length < MAX_PREVIEW_ROWS; index += stride) {
		const row = visible[index];
		if (!row) break;
		const cells: Record<string, string> = {};
		for (const name of loaded.parsed.columns) cells[name] = previewCell(row.cells[name] ?? "");
		sampleRows.push(cells);
	}

	return {
		format: loaded.parsed.format,
		columns,
		rowCount: visible.length,
		sampleRows,
		sha256: loaded.source.sha256,
		bytes: loaded.source.bytes,
		holdout: options.holdout ? { reserved: reserved.size, seed: options.holdout.seed } : null,
	};
}

// ---------- mapping rows to cases ----------

function matchesFilters(row: DatasetRow, recipe: DatasetMappingRecipe): boolean {
	for (const filter of recipe.filters ?? []) {
		const value = row.cells[filter.column] ?? "";
		if (filter.equals !== undefined && value !== filter.equals) return false;
		if (filter.matches !== undefined && !new RegExp(filter.matches).test(value)) return false;
	}
	return true;
}

function metadataFor(row: DatasetRow, recipe: DatasetMappingRecipe): Record<string, string> | undefined {
	if (!recipe.metadata) return undefined;
	const metadata: Record<string, string> = {};
	for (const column of recipe.metadata) {
		const value = (row.cells[column] ?? "").trim();
		if (value.length === 0) continue;
		metadata[column] = value.length <= MAX_TASK_METADATA_VALUE_CHARS
			? value
			: `${value.slice(0, MAX_TASK_METADATA_VALUE_CHARS - 1)}…`;
	}
	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function datasetTaskId(
	prefix: string,
	sourceSha256: string,
	recipeSha256: string,
	rowIndex: number,
	task: Omit<CorpusTask, "id">,
): string {
	const identity = hashValue({ schemaVersion: 1, kind: "dataset-case", sourceSha256, recipeSha256, row: rowIndex, task });
	return `${prefix}-${identity.slice("sha256:".length)}`;
}

type MappedRow = { task: CorpusTask } | { reason: string };

function mapRow(
	row: DatasetRow,
	recipe: DatasetMappingRecipe,
	sourceSha256: string,
	recipeSha256: string,
): MappedRow {
	const expectedValue = recipe.expected ? (row.cells[recipe.expected.column] ?? "").trim() : "";
	const resolve = (name: string): string => {
		if (name === EXPECTED_PLACEHOLDER && recipe.expected) return expectedValue;
		return row.cells[name] ?? "";
	};

	let messages: DialogueMessage[] | undefined;
	if (recipe.dialogue) {
		const parsed = parseDialogueCell(row.cells[recipe.dialogue.column] ?? "");
		if ("reason" in parsed) return { reason: parsed.reason };
		messages = parsed.messages;
	}

	let input: string;
	if (recipe.input) {
		input = ("column" in recipe.input
			? row.cells[recipe.input.column] ?? ""
			: recipe.input.template.replace(PLACEHOLDER_PATTERN, (_match, name: string) => resolve(name.trim()))
		).trim();
		if (messages) messages = [...messages, { role: "user", content: input }];
	} else {
		if (!messages) return { reason: "the recipe maps neither an input nor a dialogue" };
		while (messages.length > 0 && messages[messages.length - 1]?.role !== "user") messages.pop();
		const last = messages[messages.length - 1];
		if (!last) return { reason: "the dialogue carries no user turn" };
		input = last.content;
	}
	if (input.length === 0) return { reason: "the mapped input is empty" };
	if (input.length > MAX_CASE_INPUT_CHARS) {
		return { reason: `the mapped input exceeds ${MAX_CASE_INPUT_CHARS} characters` };
	}
	if (messages) {
		// Keep the most recent turns: a dialogue case is judged on the next
		// reply, and older history is what a context window drops first.
		if (messages.length > MAX_TASK_MESSAGES) messages = messages.slice(messages.length - MAX_TASK_MESSAGES);
		if (messages.some((message) => Buffer.byteLength(message.content, "utf8") > MAX_TASK_TEXT_BYTES)) {
			return { reason: `a dialogue turn exceeds ${MAX_TASK_TEXT_BYTES} bytes` };
		}
	}
	if (recipe.expected && expectedValue.length === 0) return { reason: "the reference answer is empty" };
	if (Buffer.byteLength(expectedValue, "utf8") > MAX_TASK_TEXT_BYTES) {
		return { reason: `the reference answer exceeds ${MAX_TASK_TEXT_BYTES} bytes` };
	}

	const graders: GraderSpec[] = [];
	for (const grader of recipe.graders) {
		const substituted = substituteGrader(grader, resolve);
		const parsed = GraderSpec.safeParse(substituted);
		if (!parsed.success) return { reason: "a grader is empty once its placeholders are filled" };
		if (parsed.data.type === "output_matches") {
			try {
				new RegExp(parsed.data.pattern);
			} catch {
				return { reason: "a grader pattern is not a valid regular expression once filled" };
			}
		}
		graders.push(parsed.data);
	}

	const metadata = metadataFor(row, recipe);
	const body = {
		input,
		...(recipe.expected ? { expected: expectedValue } : {}),
		...(messages ? { messages } : {}),
		...(metadata ? { metadata } : {}),
		graders,
	};
	const dialogueIssue = taskDialogueIssue(body);
	if (dialogueIssue) return { reason: dialogueIssue };
	const id = datasetTaskId(recipe.idPrefix ?? "task", sourceSha256, recipeSha256, row.index, body);
	const task = CorpusTaskSchema.safeParse({ id, ...body });
	if (!task.success) return { reason: "the mapped case does not satisfy the case schema" };
	return { task: task.data };
}

function compile(
	loaded: LoadedDataset,
	recipeValue: unknown,
	holdout: DatasetHoldoutSpec | null | undefined,
	scope: "development" | "sealed",
): CompiledDatasetCases {
	const recipe = parseRecipe(recipeValue, loaded.parsed.columns);
	const recipeSha256 = hashValue(recipe);
	const reserved = sealedIndexes(loaded, holdout);
	if (scope === "sealed" && reserved.size === 0) throw new Error("a sealed compile needs a holdout specification");

	const eligible = loaded.parsed.rows
		.filter((row) => (scope === "sealed" ? reserved.has(row.index) : !reserved.has(row.index)))
		.filter((row) => matchesFilters(row, recipe));

	// The sealed slice is the exam; recipe sampling only ever thins the textbook.
	const chosen = scope === "development" && recipe.sample
		? new Set(selectRowIndexes(
			eligible,
			recipe.sample.limit,
			(row) => selectionKey(loaded.source.sha256, "sample", recipe.sample?.seed ?? "", row.index),
			recipe.sample.stratifyBy ?? null,
		))
		: null;

	const tasks: CorpusTask[] = [];
	const skipped: DatasetSkippedRow[] = [];
	const ids = new Set<string>();
	for (const row of eligible) {
		if (chosen && !chosen.has(row.index)) continue;
		const mapped = mapRow(row, recipe, loaded.source.sha256, recipeSha256);
		if (!("task" in mapped)) {
			if (skipped.length < MAX_COMPILE_SKIPPED) skipped.push({ row: row.index, reason: mapped.reason });
			continue;
		}
		if (ids.has(mapped.task.id)) {
			if (skipped.length < MAX_COMPILE_SKIPPED) skipped.push({ row: row.index, reason: "the derived case id repeats" });
			continue;
		}
		ids.add(mapped.task.id);
		tasks.push(mapped.task);
	}

	return {
		tasks,
		sourceSha256: loaded.source.sha256,
		recipeSha256,
		skipped,
		rowsSeen: loaded.parsed.rows.length,
	};
}

/** Compile the development cases: everything the sealed slice left behind. */
export function compileDatasetCases(options: CompileDatasetCasesOptions): CompiledDatasetCases {
	const loaded = loadDataset(options.projectDir, options.sourcePath);
	return compile(loaded, options.recipe, options.holdout, "development");
}

/**
 * Compile only the reserved rows, with the same recipe, so a caller can seal
 * them without their contents ever crossing a model-visible path.
 */
export function compileSealedSlice(options: CompileSealedSliceOptions): CompiledDatasetCases {
	const loaded = loadDataset(options.projectDir, options.sourcePath);
	return compile(loaded, options.recipe, options.holdout, "sealed");
}

// ---------- ingest ----------

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function receiptsRoot(stateRoot: string, projectIdInput: string, create: boolean): string | null {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const root = resolve(stateRoot);
	if (!existsSync(root)) {
		if (!create) return null;
		mkdirSync(root, { recursive: true, mode: 0o700 });
	}
	const rootEntry = lstatSync(root);
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
		throw new Error(`dataset ingest stateRoot must be a regular non-symlink directory: ${root}`);
	}
	const canonicalRoot = realpathSync(root);
	let current = root;
	for (const segment of ["projects", projectId, "dataset-ingests"]) {
		const next = join(current, segment);
		if (!existsSync(next)) {
			if (!create) return null;
			mkdirSync(next, { mode: 0o700 });
		}
		const entry = lstatSync(next);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`dataset ingest state component must be a regular non-symlink directory: ${next}`);
		}
		if (!contained(canonicalRoot, realpathSync(next))) {
			throw new Error("dataset ingest state path escaped stateRoot");
		}
		current = next;
	}
	return current;
}

function receiptSha(receipt: DatasetIngestReceipt): string {
	const { at: _at, ...identity } = receipt;
	return hashValue(identity).slice("sha256:".length);
}

/**
 * Publish the sealed corpus first, then hand back the development cases. The
 * sealed corpus id lives only in the receipt; nothing development-facing
 * carries it.
 */
export function ingestDataset(options: IngestDatasetOptions): DatasetIngestResult {
	const loaded = loadDataset(options.projectDir, options.sourcePath, [options.stateRoot]);
	const now = options.now ?? (() => new Date().toISOString());

	let sealedCorpus: CorpusMetadata | null = null;
	if (options.holdout) {
		const sealed = compile(loaded, options.recipe, options.holdout, "sealed");
		if (sealed.tasks.length === 0) throw new Error("the sealed slice compiled no cases");
		sealedCorpus = publishSealedCorpus(options, sealed.tasks);
	}

	const development = compile(loaded, options.recipe, options.holdout, "development");
	if (development.tasks.length === 0) throw new Error("the recipe compiled no development cases");

	const receipt = DatasetIngestReceiptSchema.parse({
		schemaVersion: 1,
		sourcePath: loaded.source.path,
		sourceSha256: development.sourceSha256,
		recipeSha256: development.recipeSha256,
		format: loaded.parsed.format,
		rowsSeen: development.rowsSeen,
		developmentCount: development.tasks.length,
		sealed: sealedCorpus && options.holdout
			? { corpusId: sealedCorpus.id, count: sealedCorpus.taskCount, seed: options.holdout.seed }
			: null,
		at: now(),
	});
	const published = writeReceipt(options.stateRoot, options.projectId, receipt);

	return {
		receipt: published.receipt,
		receiptPath: published.path,
		tasks: development.tasks,
		developmentName: options.developmentName,
		skipped: development.skipped,
		sealedCorpus,
	};
}

function publishSealedCorpus(options: IngestDatasetOptions, tasks: readonly CorpusTask[]): CorpusMetadata {
	const name = options.sealedName ?? `${options.developmentName} (sealed)`;
	try {
		return createCorpus({
			stateRoot: options.stateRoot,
			projectId: options.projectId,
			name,
			visibility: "sealed",
			tasks: [...tasks],
		});
	} catch (error) {
		if (!(error instanceof CorpusError) || !/already exists/.test(error.message)) throw error;
		const hash = hashValue(tasks);
		const existing = listCorpora({ stateRoot: options.stateRoot, projectId: options.projectId })
			.find((metadata) => metadata.visibility === "sealed" && metadata.name === name && metadata.hash === hash);
		if (!existing) throw error;
		return existing;
	}
}

function writeReceipt(
	stateRoot: string,
	projectId: string,
	receipt: DatasetIngestReceipt,
): { receipt: DatasetIngestReceipt; path: string } {
	const root = receiptsRoot(stateRoot, projectId, true);
	if (!root) throw new Error("failed to create the dataset ingest receipt directory");
	const path = join(root, `${receiptSha(receipt)}.json`);
	if (existsSync(path)) {
		const existing = readJsonArtifact(path, DatasetIngestReceiptSchema);
		if (receiptSha(existing) !== receiptSha(receipt)) {
			throw new Error("content-address collision for a dataset ingest receipt");
		}
		return { receipt: existing, path };
	}
	try {
		writeJsonArtifact(path, DatasetIngestReceiptSchema, receipt, { immutable: true });
	} catch (error) {
		if (!existsSync(path)) throw error;
		const existing = readJsonArtifact(path, DatasetIngestReceiptSchema);
		const { at: _existingAt, ...existingIdentity } = existing;
		const { at: _receiptAt, ...receiptIdentity } = receipt;
		if (canonicalJson(existingIdentity) !== canonicalJson(receiptIdentity)) throw error;
		return { receipt: existing, path };
	}
	return { receipt, path };
}

/** Reload one receipt, schema-validated and re-checked against its content address. */
export function loadDatasetIngestReceipt(stateRoot: string, projectIdInput: string, shaInput: string): DatasetIngestReceipt {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const sha = ReceiptShaSchema.parse(shaInput);
	const root = receiptsRoot(stateRoot, projectId, false);
	if (!root) throw new Error(`project ${projectId} has no dataset ingests`);
	const receipt = readJsonArtifact(join(root, `${sha}.json`), DatasetIngestReceiptSchema);
	if (receiptSha(receipt) !== sha) throw new Error("the dataset ingest receipt does not match its content address");
	return receipt;
}
