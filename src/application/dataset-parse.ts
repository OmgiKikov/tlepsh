import type { DialogueMessage } from "../manifest.js";

/**
 * Every supported inbox shape reduces to the same thing: an ordered list of
 * rows whose cells are strings. Mapping recipes, sampling and the sealed slice
 * all work on that one representation, so a new format only has to produce it.
 */
export const DATASET_FORMATS = [
	"csv",
	"tsv",
	"json",
	"jsonl",
	"markdown-table",
	"text-lines",
	"chat-export",
] as const;
export type DatasetFormat = (typeof DATASET_FORMATS)[number];

export const DATASET_COLUMN_TYPES = ["text", "number", "boolean", "json", "empty"] as const;
export type DatasetColumnType = (typeof DATASET_COLUMN_TYPES)[number];

export const MAX_DATASET_ROWS = 50_000;
export const MAX_DATASET_COLUMNS = 128;
/** Chat exports collapse to these columns whatever the vendor shape was. */
export const CHAT_EXPORT_COLUMNS = [
	"messages",
	"first_user",
	"last_user",
	"last_assistant",
	"title",
	"message_count",
] as const;

const MAX_FLATTEN_DEPTH = 4;
const SNIFF_CHARS = 64 * 1024;
const TYPE_SAMPLE_LIMIT = 200;
const DELIMITERS = [",", ";", "\t"] as const;

export interface DatasetRow {
	/** 1-based position among parsed rows. Stable for a given file. */
	index: number;
	cells: Record<string, string>;
}

export interface ParsedDataset {
	format: DatasetFormat;
	columns: string[];
	rows: DatasetRow[];
}

export class DatasetParseError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DatasetParseError";
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** One newline convention and no byte-order mark, so every parser sees the same text. */
function normalizeText(text: string): string {
	const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	return withoutBom.replace(/\r\n?/g, "\n");
}

// ---------- shared row assembly ----------

function assemble(format: DatasetFormat, columns: readonly string[], cells: readonly Record<string, string>[]): ParsedDataset {
	if (columns.length === 0) throw new DatasetParseError("the dataset has no columns");
	if (columns.length > MAX_DATASET_COLUMNS) {
		throw new DatasetParseError(`the dataset has ${columns.length} columns, over the ${MAX_DATASET_COLUMNS} column bound`);
	}
	if (cells.length === 0) throw new DatasetParseError("the dataset has no rows");
	if (cells.length > MAX_DATASET_ROWS) {
		throw new DatasetParseError(`the dataset has ${cells.length} rows, over the ${MAX_DATASET_ROWS} row bound`);
	}
	const rows = cells.map((row, index) => {
		const filled: Record<string, string> = {};
		for (const column of columns) filled[column] = row[column] ?? "";
		return { index: index + 1, cells: filled };
	});
	return { format, columns: [...columns], rows };
}

function columnOrder(records: readonly Record<string, string>[]): string[] {
	const columns: string[] = [];
	const seen = new Set<string>();
	for (const record of records) {
		for (const key of Object.keys(record)) {
			if (seen.has(key)) continue;
			seen.add(key);
			columns.push(key);
			if (columns.length > MAX_DATASET_COLUMNS) {
				throw new DatasetParseError(`the dataset has more than ${MAX_DATASET_COLUMNS} columns`);
			}
		}
	}
	return columns;
}

// ---------- delimited text (RFC 4180) ----------

/** Split RFC 4180 text: quoted fields, doubled quotes, newlines inside cells. */
function splitDelimited(text: string, delimiter: string): string[][] {
	const records: string[][] = [];
	let record: string[] = [];
	let field = "";
	let quoted = false;
	let open = false;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index]!;
		if (quoted) {
			if (character !== '"') {
				field += character;
				continue;
			}
			if (text[index + 1] === '"') {
				field += '"';
				index += 1;
				continue;
			}
			quoted = false;
			continue;
		}
		if (character === '"' && field.length === 0 && !open) {
			quoted = true;
			open = true;
			continue;
		}
		if (character === delimiter) {
			record.push(field);
			field = "";
			open = false;
			continue;
		}
		if (character === "\n") {
			record.push(field);
			records.push(record);
			record = [];
			field = "";
			open = false;
			continue;
		}
		field += character;
		open = true;
	}
	if (field.length > 0 || record.length > 0) {
		record.push(field);
		records.push(record);
	}
	return records.filter((entry) => entry.length > 1 || (entry[0] ?? "").length > 0);
}

/** Pick the delimiter that yields the most consistent field count above one. */
function sniffDelimiter(text: string): string {
	const head = text.slice(0, SNIFF_CHARS);
	let best: { delimiter: string; score: number } = { delimiter: ",", score: 0 };
	for (const delimiter of DELIMITERS) {
		const records = splitDelimited(head, delimiter).slice(0, 20);
		const header = records[0];
		if (!header || header.length < 2) continue;
		const consistent = records.filter((record) => record.length === header.length).length;
		const score = consistent * header.length;
		if (score > best.score) best = { delimiter, score };
	}
	return best.delimiter;
}

function normalizeHeader(header: readonly string[]): string[] {
	const names: string[] = [];
	const used = new Map<string, number>();
	for (const [index, raw] of header.entries()) {
		const base = raw.trim() || `column_${index + 1}`;
		const seen = used.get(base) ?? 0;
		used.set(base, seen + 1);
		names.push(seen === 0 ? base : `${base}_${seen + 1}`);
	}
	return names;
}

function parseDelimited(text: string, delimiter: string, format: DatasetFormat): ParsedDataset {
	const records = splitDelimited(text, delimiter);
	const header = records[0];
	if (!header) throw new DatasetParseError("the dataset has no header row");
	const columns = normalizeHeader(header);
	const overlong: number[] = [];
	const cells: Record<string, string>[] = [];
	for (const [index, record] of records.slice(1).entries()) {
		if (record.length > columns.length) {
			overlong.push(index + 2);
			continue;
		}
		const row: Record<string, string> = {};
		for (const [position, column] of columns.entries()) row[column] = record[position] ?? "";
		cells.push(row);
	}
	if (overlong.length > 0) {
		throw new DatasetParseError(
			`${overlong.length} rows carry more fields than the ${columns.length}-column header, starting at row ${overlong[0]}`,
		);
	}
	return assemble(format, columns, cells);
}

// ---------- markdown tables ----------

function splitMarkdownCells(line: string): string[] {
	const cells: string[] = [];
	let cell = "";
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index]!;
		if (character === "\\" && line[index + 1] === "|") {
			cell += "|";
			index += 1;
			continue;
		}
		if (character === "|") {
			cells.push(cell);
			cell = "";
			continue;
		}
		cell += character;
	}
	cells.push(cell);
	if ((cells[0] ?? "").trim() === "") cells.shift();
	if (cells.length > 0 && (cells[cells.length - 1] ?? "").trim() === "") cells.pop();
	return cells.map((value) => value.trim());
}

function isMarkdownSeparator(line: string): boolean {
	const cells = splitMarkdownCells(line);
	return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

function findMarkdownTable(lines: readonly string[]): number {
	for (let index = 0; index + 1 < lines.length; index += 1) {
		const header = lines[index] ?? "";
		const separator = lines[index + 1] ?? "";
		if (!header.includes("|") || !separator.includes("-")) continue;
		if (isMarkdownSeparator(separator) && splitMarkdownCells(header).length >= 1) return index;
	}
	return -1;
}

function parseMarkdownTable(lines: readonly string[], start: number): ParsedDataset {
	const headerLine = lines[start] ?? "";
	const columns = normalizeHeader(splitMarkdownCells(headerLine));
	const cells: Record<string, string>[] = [];
	for (let index = start + 2; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (!line.includes("|")) break;
		const values = splitMarkdownCells(line);
		if (values.length === 0) break;
		const row: Record<string, string> = {};
		for (const [position, column] of columns.entries()) row[column] = values[position] ?? "";
		cells.push(row);
	}
	return assemble("markdown-table", columns, cells);
}

// ---------- plain text ----------

/**
 * A file with a blank line in it reads as blank-line-separated blocks;
 * otherwise every non-empty line is one case.
 */
function parseTextDocument(text: string): ParsedDataset {
	const blocks = /\n[ \t]*\n/.test(text)
		? text.split(/\n[ \t]*\n+/).map((block) => block.trim()).filter((block) => block.length > 0)
		: text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
	return assemble("text-lines", ["text"], blocks.map((value) => ({ text: value })));
}

// ---------- JSON ----------

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function scalarText(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	if (value === null || value === undefined) return "";
	return null;
}

function flatten(value: unknown, prefix: string, depth: number, into: Record<string, string>): void {
	const scalar = scalarText(value);
	if (scalar !== null) {
		into[prefix] = scalar;
		return;
	}
	const record = asRecord(value);
	if (!record || depth >= MAX_FLATTEN_DEPTH) {
		into[prefix] = JSON.stringify(value);
		return;
	}
	const keys = Object.keys(record);
	if (keys.length === 0) {
		into[prefix] = "{}";
		return;
	}
	for (const key of keys) flatten(record[key], prefix ? `${prefix}.${key}` : key, depth + 1, into);
}

function flattenRecord(value: unknown, rowNumber: number): Record<string, string> {
	const record = asRecord(value);
	if (!record) {
		const scalar = scalarText(value);
		if (scalar === null) return { value: JSON.stringify(value) };
		return { value: scalar };
	}
	const cells: Record<string, string> = {};
	for (const key of Object.keys(record)) flatten(record[key], key, 1, cells);
	if (Object.keys(cells).length === 0) {
		throw new DatasetParseError(`row ${rowNumber} carries no fields`);
	}
	return cells;
}

const ARRAY_FIELD_NAMES = ["data", "rows", "items", "records", "examples", "cases", "questions"];

/** An array of objects, or the one array field of a wrapper object. */
function jsonRowSource(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	const record = asRecord(value);
	if (record) {
		const arrays = Object.entries(record).filter(([, entry]) => Array.isArray(entry));
		if (arrays.length === 1) return arrays[0]![1] as unknown[];
		for (const name of ARRAY_FIELD_NAMES) {
			const candidate = record[name];
			if (Array.isArray(candidate)) return candidate;
		}
	}
	throw new DatasetParseError("the JSON document has no single array of rows to read");
}

// ---------- chat exports ----------

interface ChatConversation {
	title: string;
	messages: DialogueMessage[];
}

const CONVERSATION_FIELDS = ["messages", "conversation", "turns", "dialogue"] as const;
/** Keys a conversation object may carry beside its turns and still be one. */
const CONVERSATION_SIBLINGS = new Set([
	"title",
	"name",
	"id",
	"uuid",
	"conversation_id",
	"model",
	"account",
	"source",
	"type",
	"created_at",
	"create_time",
	"updated_at",
	"update_time",
]);

const USER_ROLES = new Set(["user", "human", "customer", "client", "prompt"]);
const ASSISTANT_ROLES = new Set(["assistant", "ai", "bot", "model", "gpt", "claude", "completion", "answer"]);

function normalizeRole(value: unknown): DialogueMessage["role"] | null {
	if (typeof value !== "string") return null;
	const role = value.trim().toLowerCase();
	if (USER_ROLES.has(role)) return "user";
	if (ASSISTANT_ROLES.has(role)) return "assistant";
	return null;
}

/** Vendors write message text as a string, a parts array, or a content block list. */
function messageText(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		return value
			.map((part) => {
				if (typeof part === "string") return part;
				const record = asRecord(part);
				if (!record) return "";
				return typeof record.text === "string" ? record.text : "";
			})
			.filter((part) => part.length > 0)
			.join("\n");
	}
	const record = asRecord(value);
	if (!record) return "";
	if (typeof record.text === "string") return record.text;
	if (Array.isArray(record.parts)) return messageText(record.parts);
	if (record.content !== undefined) return messageText(record.content);
	return "";
}

function pushMessage(messages: DialogueMessage[], role: DialogueMessage["role"] | null, text: string): void {
	const content = text.trim();
	if (!role || content.length === 0) return;
	messages.push({ role, content });
}

function genericConversation(value: unknown): ChatConversation | null {
	if (Array.isArray(value)) {
		if (value.length === 0) return null;
		const messages: DialogueMessage[] = [];
		for (const entry of value) {
			const record = asRecord(entry);
			if (!record || record.role === undefined || record.content === undefined) return null;
			pushMessage(messages, normalizeRole(record.role), messageText(record.content));
		}
		return messages.length > 0 ? { title: "", messages } : null;
	}
	const record = asRecord(value);
	if (!record) return null;
	for (const field of CONVERSATION_FIELDS) {
		const candidate = record[field];
		if (!Array.isArray(candidate)) continue;
		// A row that carries its own columns beside the turns is a dataset row
		// with a messages cell, not a conversation. Declining here costs
		// nothing: the array survives flattening as a JSON cell a recipe can
		// still name as its dialogue column.
		if (Object.keys(record).some((key) => key !== field && !CONVERSATION_SIBLINGS.has(key))) return null;
		const inner = genericConversation(candidate);
		if (!inner) return null;
		const title = typeof record.title === "string" ? record.title : typeof record.name === "string" ? record.name : "";
		return { title, messages: inner.messages };
	}
	return null;
}

function chatGptConversation(value: unknown): ChatConversation | null {
	const record = asRecord(value);
	const mapping = record ? asRecord(record.mapping) : null;
	if (!record || !mapping) return null;
	const nodes: { order: number; time: number; message: Record<string, unknown> }[] = [];
	for (const [order, key] of Object.keys(mapping).entries()) {
		const node = asRecord(mapping[key]);
		const message = node ? asRecord(node.message) : null;
		if (!message) continue;
		const time = typeof message.create_time === "number" ? message.create_time : Number.NaN;
		nodes.push({ order, time, message });
	}
	if (nodes.length === 0) return null;
	const timed = nodes.every((node) => Number.isFinite(node.time));
	const ordered = timed ? [...nodes].sort((a, b) => (a.time === b.time ? a.order - b.order : a.time - b.time)) : nodes;
	const messages: DialogueMessage[] = [];
	for (const node of ordered) {
		const author = asRecord(node.message.author);
		pushMessage(messages, normalizeRole(author?.role), messageText(node.message.content));
	}
	if (messages.length === 0) return null;
	return { title: typeof record.title === "string" ? record.title : "", messages };
}

function claudeConversation(value: unknown): ChatConversation | null {
	const record = asRecord(value);
	if (!record || !Array.isArray(record.chat_messages)) return null;
	const messages: DialogueMessage[] = [];
	for (const entry of record.chat_messages) {
		const message = asRecord(entry);
		if (!message) continue;
		const text = typeof message.text === "string" && message.text.length > 0
			? message.text
			: messageText(message.content);
		pushMessage(messages, normalizeRole(message.sender ?? message.role), text);
	}
	if (messages.length === 0) return null;
	return { title: typeof record.name === "string" ? record.name : "", messages };
}

/**
 * Telegram exports carry senders, not roles. The sender who opens the chat is
 * read as the user and every other sender as the assistant.
 */
function telegramConversation(value: unknown): ChatConversation | null {
	const record = asRecord(value);
	if (!record || !Array.isArray(record.messages)) return null;
	const entries = record.messages.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null);
	const looksTelegram = entries.some((entry) => typeof entry.type === "string" && (entry.from !== undefined || entry.from_id !== undefined));
	if (!looksTelegram) return null;
	const messages: DialogueMessage[] = [];
	let firstSender: string | null = null;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const sender = scalarText(entry.from_id) || scalarText(entry.from) || "";
		const text = messageText(entry.text);
		if (text.trim().length === 0) continue;
		if (firstSender === null) firstSender = sender;
		pushMessage(messages, sender === firstSender ? "user" : "assistant", text);
	}
	if (messages.length === 0) return null;
	return { title: typeof record.name === "string" ? record.name : "", messages };
}

function conversationOf(value: unknown): ChatConversation | null {
	return telegramConversation(value) ??
		chatGptConversation(value) ??
		claudeConversation(value) ??
		genericConversation(value);
}

/** Recognize a whole document as a chat export, or decline and let JSON rules apply. */
function chatConversations(value: unknown): ChatConversation[] | null {
	const record = asRecord(value);
	const telegramList = record ? asRecord(record.chats) : null;
	if (telegramList && Array.isArray(telegramList.list)) {
		const conversations = telegramList.list
			.map((chat) => telegramConversation(chat))
			.filter((chat): chat is ChatConversation => chat !== null);
		return conversations.length > 0 ? conversations : null;
	}
	if (Array.isArray(value)) {
		const single = genericConversation(value);
		if (single) return [single];
		const conversations: ChatConversation[] = [];
		for (const entry of value) {
			const conversation = conversationOf(entry);
			if (!conversation) return null;
			conversations.push(conversation);
		}
		return conversations.length > 0 ? conversations : null;
	}
	const conversation = conversationOf(value);
	return conversation ? [conversation] : null;
}

function chatRows(conversations: readonly ChatConversation[]): ParsedDataset {
	const cells = conversations.map((conversation) => {
		const users = conversation.messages.filter((message) => message.role === "user");
		const assistants = conversation.messages.filter((message) => message.role === "assistant");
		return {
			messages: JSON.stringify(conversation.messages),
			first_user: users[0]?.content ?? "",
			last_user: users[users.length - 1]?.content ?? "",
			last_assistant: assistants[assistants.length - 1]?.content ?? "",
			title: conversation.title,
			message_count: String(conversation.messages.length),
		};
	});
	return assemble("chat-export", [...CHAT_EXPORT_COLUMNS], cells);
}

// ---------- entry points ----------

function parseJsonDocument(text: string): ParsedDataset {
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch (error) {
		throw new DatasetParseError(`the JSON document is invalid: ${errorMessage(error)}`, { cause: error });
	}
	const conversations = chatConversations(value);
	if (conversations) return chatRows(conversations);
	const records = jsonRowSource(value);
	const cells = records.map((record, index) => flattenRecord(record, index + 1));
	return assemble("json", columnOrder(cells), cells);
}

function parseJsonLines(text: string): ParsedDataset {
	const values: unknown[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (!line.trim()) continue;
		if (values.length >= MAX_DATASET_ROWS) {
			throw new DatasetParseError(`the dataset has more than ${MAX_DATASET_ROWS} rows`);
		}
		try {
			values.push(JSON.parse(line) as unknown);
		} catch (error) {
			throw new DatasetParseError(`line ${index + 1} is not valid JSON`, { cause: error });
		}
	}
	if (values.length === 0) throw new DatasetParseError("the dataset has no rows");
	const conversations: ChatConversation[] = [];
	for (const value of values) {
		const conversation = conversationOf(value);
		if (!conversation) {
			conversations.length = 0;
			break;
		}
		conversations.push(conversation);
	}
	if (conversations.length === values.length) return chatRows(conversations);
	const cells = values.map((value, index) => flattenRecord(value, index + 1));
	return assemble("jsonl", columnOrder(cells), cells);
}

function parseMarkdownDocument(text: string): ParsedDataset {
	const lines = text.split("\n");
	const start = findMarkdownTable(lines);
	return start < 0 ? parseTextDocument(text) : parseMarkdownTable(lines, start);
}

/** Parse one inbox file into rows. The extension chooses the family; content decides the rest. */
export function parseDataset(source: { text: string; extension: string }): ParsedDataset {
	const text = normalizeText(source.text);
	if (text.trim().length === 0) throw new DatasetParseError("the dataset has no rows");
	switch (source.extension) {
		case ".csv":
			return parseDelimited(text, sniffDelimiter(text), "csv");
		case ".tsv":
			return parseDelimited(text, "\t", "tsv");
		case ".json":
			return parseJsonDocument(text);
		case ".jsonl":
		case ".ndjson":
			return parseJsonLines(text);
		case ".md":
		case ".markdown":
			return parseMarkdownDocument(text);
		default:
			return parseTextDocument(text);
	}
}

const BOOLEAN_VALUES = new Set(["true", "false", "yes", "no"]);

/** Infer one column's type from a bounded sample of its non-empty values. */
export function inferColumnType(values: readonly string[]): DatasetColumnType {
	const sample = values.filter((value) => value.trim().length > 0).slice(0, TYPE_SAMPLE_LIMIT);
	if (sample.length === 0) return "empty";
	if (sample.every((value) => Number.isFinite(Number(value.trim())))) return "number";
	if (sample.every((value) => BOOLEAN_VALUES.has(value.trim().toLowerCase()))) return "boolean";
	if (sample.every((value) => {
		const trimmed = value.trim();
		if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
		try {
			JSON.parse(trimmed);
			return true;
		} catch {
			return false;
		}
	})) {
		return "json";
	}
	return "text";
}

/** Parse a `messages` cell into normalized dialogue turns, or explain why it cannot be. */
export function parseDialogueCell(value: string): { messages: DialogueMessage[] } | { reason: string } {
	const trimmed = value.trim();
	if (trimmed.length === 0) return { reason: "the dialogue column is empty" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed) as unknown;
	} catch {
		return { reason: "the dialogue column is not valid JSON" };
	}
	const conversation = conversationOf(parsed);
	if (!conversation) return { reason: "the dialogue column carries no recognizable turns" };
	return { messages: conversation.messages };
}
