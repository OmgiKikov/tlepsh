import {
	closeSync,
	constants,
	chmodSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
	DialogueMessageSchema,
	MAX_TASK_MESSAGES,
	MAX_TASK_TEXT_BYTES,
	type DialogueMessage,
} from "../manifest.js";
import { redactTraceText } from "../trace.js";
import { BUILDER_CORPUS_IMPORT_ROOT } from "./builder-corpus-import-contract.js";
import { MAX_DATASET_SOURCE_BYTES } from "./dataset-source.js";

/**
 * `ahde target` writes 👍/👎 marks here, one JSON row per mark, in exactly the
 * `{ messages: [...] }` shape the dataset parsers already read as a chat
 * export. The inbox is git-ignored by the scaffold and excluded from every
 * Target and eval workspace (`isPrivateWorkspacePath` in `runner.ts`), so a
 * marked dialogue never becomes ambient context for the agent it judges.
 */
export const TARGET_FEEDBACK_FILE = "feedback.jsonl";
export const TARGET_FEEDBACK_PATH = `${BUILDER_CORPUS_IMPORT_ROOT}/${TARGET_FEEDBACK_FILE}`;

/** Same bound the dataset compiler truncates a metadata value at, so `note` round-trips. */
export const MAX_TARGET_FEEDBACK_NOTE_CHARS = 500;
/** How many recent marks `ahde feedback list` shows, and how wide one preview line is. */
export const TARGET_FEEDBACK_LIST_LIMIT = 5;
export const MAX_TARGET_FEEDBACK_PREVIEW_CHARS = 100;

export const TargetFeedbackVerdictSchema = z.enum(["good", "bad"]);
export type TargetFeedbackVerdict = z.infer<typeof TargetFeedbackVerdictSchema>;

/** The child-authored half of a mark: the bounded dialogue and the human's verdict. */
export const TargetFeedbackDraftSchema = z.strictObject({
	verdict: TargetFeedbackVerdictSchema,
	note: z.string().min(1).max(MAX_TARGET_FEEDBACK_NOTE_CHARS).optional(),
	messages: z.array(DialogueMessageSchema).min(1).max(MAX_TASK_MESSAGES),
});
export type TargetFeedbackDraft = z.infer<typeof TargetFeedbackDraftSchema>;

/** One stored row. `at` and `target` are stamped by the host, never by the child. */
export const TargetFeedbackMarkSchema = z.strictObject({
	messages: z.array(DialogueMessageSchema).min(1).max(MAX_TASK_MESSAGES),
	verdict: TargetFeedbackVerdictSchema,
	note: z.string().min(1).max(MAX_TARGET_FEEDBACK_NOTE_CHARS).optional(),
	at: z.iso.datetime({ offset: true }),
	target: z.strictObject({ id: z.string().min(1).max(200), gitSha: z.string().min(1).max(200) }),
});
export type TargetFeedbackMark = z.infer<typeof TargetFeedbackMarkSchema>;

/** Cut UTF-8 text to a byte budget without splitting a code point. */
function truncateBytes(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const ellipsis = "…";
	const budget = maxBytes - Buffer.byteLength(ellipsis, "utf8");
	const buffer = Buffer.from(value, "utf8").subarray(0, Math.max(0, budget));
	return `${new TextDecoder("utf-8").decode(buffer).replace(/�$/, "")}${ellipsis}`;
}

/**
 * Bound and redact turns before they leave the Target session. Marks carry the
 * same limits as a dialogue case (`≤ 40` turns, `≤ 8 KiB` each), so a mark that
 * the file accepts is a mark the compiler can map without dropping the row.
 */
export function boundTargetFeedbackDialogue(
	messages: readonly DialogueMessage[],
): DialogueMessage[] {
	const bounded: DialogueMessage[] = [];
	for (const message of messages) {
		const content = truncateBytes(redactTraceText(message.content).trim(), MAX_TASK_TEXT_BYTES);
		if (content.length === 0) continue;
		bounded.push({ role: message.role, content });
	}
	// A dialogue case is judged on the reply that follows the history it keeps,
	// so the oldest turns are the ones a bound drops.
	return bounded.length > MAX_TASK_MESSAGES ? bounded.slice(bounded.length - MAX_TASK_MESSAGES) : bounded;
}

/** Bound one operator note the same way the compiler bounds a metadata value. */
export function boundTargetFeedbackNote(note: string | undefined): string | undefined {
	if (note === undefined) return undefined;
	const redacted = redactTraceText(note).trim().replace(/\s+/g, " ");
	if (redacted.length === 0) return undefined;
	return redacted.length <= MAX_TARGET_FEEDBACK_NOTE_CHARS
		? redacted
		: `${redacted.slice(0, MAX_TARGET_FEEDBACK_NOTE_CHARS - 1)}…`;
}

function feedbackInbox(projectDir: string): string {
	const root = resolve(projectDir);
	const entry = lstatSync(root);
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new Error(`feedback project root must be a regular non-symlink directory: ${root}`);
	}
	return join(root, BUILDER_CORPUS_IMPORT_ROOT);
}

function feedbackFile(projectDir: string): string {
	return join(feedbackInbox(projectDir), TARGET_FEEDBACK_FILE);
}

function assertRegularFile(path: string): void {
	const entry = lstatSync(path);
	if (entry.isSymbolicLink() || !entry.isFile()) {
		throw new Error(`${TARGET_FEEDBACK_PATH} must be a regular non-symlink file`);
	}
}

export interface TargetFeedbackAppendResult {
	/** Project-relative path, the same spelling a dataset recipe names. */
	path: string;
	/** Marks in the file after this append, malformed lines excluded. */
	total: number;
}

/**
 * Append one mark. The file is the host's: the interactive Target child sends
 * a draft over IPC and never opens this path itself.
 */
export function appendTargetFeedbackMark(
	projectDir: string,
	mark: TargetFeedbackMark,
): TargetFeedbackAppendResult {
	const parsed = TargetFeedbackMarkSchema.parse(mark);
	const inbox = feedbackInbox(projectDir);
	mkdirSync(inbox, { recursive: true, mode: 0o700 });
	const path = join(inbox, TARGET_FEEDBACK_FILE);
	if (existsSync(path)) assertRegularFile(path);

	const line = `${JSON.stringify(parsed)}\n`;
	const descriptor = openSync(
		path,
		constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		const before = fstatSync(descriptor);
		if (!before.isFile()) throw new Error(`${TARGET_FEEDBACK_PATH} must be a regular file`);
		if (before.size + Buffer.byteLength(line, "utf8") > MAX_DATASET_SOURCE_BYTES) {
			throw new Error(
				`${TARGET_FEEDBACK_PATH} would exceed the ${MAX_DATASET_SOURCE_BYTES}-byte inbox bound; run \`ahde feedback clear\``,
			);
		}
		// A previously written file keeps its mode; a file created here is private.
		if (before.size === 0) chmodSync(path, 0o600);
		writeSync(descriptor, line);
	} finally {
		closeSync(descriptor);
	}
	return { path: TARGET_FEEDBACK_PATH, total: readTargetFeedback(projectDir).marks.length };
}

export interface TargetFeedbackSummary {
	path: string;
	exists: boolean;
	marks: TargetFeedbackMark[];
	/** Hand-edited or truncated rows, counted but never guessed at. */
	malformed: number;
}

/** Read the inbox file. Malformed rows are counted, not repaired and not thrown on. */
export function readTargetFeedback(projectDir: string): TargetFeedbackSummary {
	const path = feedbackFile(projectDir);
	if (!existsSync(path)) return { path: TARGET_FEEDBACK_PATH, exists: false, marks: [], malformed: 0 };
	assertRegularFile(path);
	if (lstatSync(path).size > MAX_DATASET_SOURCE_BYTES) {
		throw new Error(`${TARGET_FEEDBACK_PATH} exceeds the ${MAX_DATASET_SOURCE_BYTES}-byte inbox bound`);
	}
	const marks: TargetFeedbackMark[] = [];
	let malformed = 0;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line) as unknown;
		} catch {
			malformed += 1;
			continue;
		}
		const parsed = TargetFeedbackMarkSchema.safeParse(value);
		if (parsed.success) marks.push(parsed.data);
		else malformed += 1;
	}
	return { path: TARGET_FEEDBACK_PATH, exists: true, marks, malformed };
}

/** Timestamp component for an archive name: filename-safe and still sortable. */
function archiveStamp(at: string): string {
	return at.replace(/[:.]/g, "-").replace(/\+/g, "-");
}

export interface TargetFeedbackClearResult {
	from: string;
	/** Project-relative archive path; still a `.jsonl` file the dataset flow can read. */
	to: string;
	marks: number;
}

/**
 * Move the inbox file aside. Nothing is deleted: the archive keeps the same
 * extension, so an operator who cleared too early can still import it.
 */
export function clearTargetFeedback(
	projectDir: string,
	now: () => string = () => new Date().toISOString(),
): TargetFeedbackClearResult | null {
	const summary = readTargetFeedback(projectDir);
	if (!summary.exists) return null;
	const inbox = feedbackInbox(projectDir);
	const stamp = archiveStamp(now());
	const name = `feedback.${stamp}.jsonl`;
	const destination = join(inbox, name);
	if (existsSync(destination)) {
		throw new Error(`feedback archive already exists: ${BUILDER_CORPUS_IMPORT_ROOT}/${name}`);
	}
	renameSync(join(inbox, TARGET_FEEDBACK_FILE), destination);
	return {
		from: TARGET_FEEDBACK_PATH,
		to: `${BUILDER_CORPUS_IMPORT_ROOT}/${name}`,
		marks: summary.marks.length,
	};
}

function previewLine(mark: TargetFeedbackMark): string {
	const firstUser = mark.messages.find((message) => message.role === "user");
	const text = redactTraceText(firstUser?.content ?? "").replace(/\s+/g, " ").trim();
	if (text.length === 0) return "(no user turn)";
	return text.length <= MAX_TARGET_FEEDBACK_PREVIEW_CHARS
		? text
		: `${text.slice(0, MAX_TARGET_FEEDBACK_PREVIEW_CHARS - 1)}…`;
}

/**
 * Counts plus the first user turn of the most recent marks. Transcripts stay in
 * the file: the list is for deciding whether there is enough to import, not for
 * reading conversations back in a terminal.
 */
export function renderTargetFeedbackList(summary: TargetFeedbackSummary): string[] {
	if (!summary.exists) {
		return [
			`no ${TARGET_FEEDBACK_PATH} yet`,
			"next: run `ahde target`, then mark a reply with /good, /bad [note], alt+g or alt+x",
		];
	}
	const good = summary.marks.filter((mark) => mark.verdict === "good").length;
	const bad = summary.marks.length - good;
	const lines = [`${summary.path}  ${summary.marks.length} marks (${good} good, ${bad} bad)`];
	if (summary.malformed > 0) lines.push(`${summary.malformed} unreadable line(s) skipped`);
	const recent = summary.marks.slice(-TARGET_FEEDBACK_LIST_LIMIT).reverse();
	if (recent.length > 0) lines.push(`last ${recent.length}:`);
	for (const mark of recent) {
		const note = mark.note ? `  · ${previewNote(mark.note)}` : "";
		lines.push(`  ${mark.verdict.padEnd(4)}  ${mark.at}  ${previewLine(mark)}${note}`);
	}
	if (summary.marks.length > 0) {
		lines.push(
			`next: open \`ahde\` and ask to build cases from ${summary.path}; the dataset flow previews it and compiles the dialogues.`,
		);
	}
	return lines;
}

/**
 * The whole body of `ahde feedback <action>`: the CLI only prints these lines.
 * Keeping it here means the command is testable without a built binary.
 */
export function runTargetFeedbackCommand(options: {
	projectDir: string;
	action: string | undefined;
	now?: () => string;
}): string[] {
	if (options.action === "list") {
		return renderTargetFeedbackList(readTargetFeedback(options.projectDir));
	}
	if (options.action === "clear") {
		const cleared = options.now
			? clearTargetFeedback(options.projectDir, options.now)
			: clearTargetFeedback(options.projectDir);
		return cleared
			? [`moved ${cleared.from} → ${cleared.to} (${cleared.marks} marks)`]
			: [`no ${TARGET_FEEDBACK_PATH} to clear`];
	}
	throw new Error("usage: ahde feedback list|clear [--target <dir>]");
}

function previewNote(note: string): string {
	const text = note.replace(/\s+/g, " ").trim();
	return text.length <= MAX_TARGET_FEEDBACK_PREVIEW_CHARS
		? text
		: `${text.slice(0, MAX_TARGET_FEEDBACK_PREVIEW_CHARS - 1)}…`;
}
