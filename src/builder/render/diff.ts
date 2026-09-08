import { t } from "../../i18n.js";
import { clean, visibleLength } from "./format.js";
import type { Paint } from "./paint.js";

const DEFAULT_MAX_DIFF_LINES = 400;
/** Unchanged lines a hunk may show in a row before the middle folds. */
const MAX_CONTEXT_RUN = 6;
const MIN_GUTTER = 3;

type RowKind = "context" | "added" | "removed" | "metadata";

interface Row {
	kind: RowKind;
	oldLine: number | null;
	newLine: number | null;
	text: string;
}

interface FileDiff {
	path: string;
	status: "modified" | "new" | "deleted" | "renamed";
	from?: string;
	binary: boolean;
	metadata: string[];
	raw: string[];
	fallback: boolean;
	hunks: Row[][];
	added: number;
	removed: number;
}

function stripPrefix(path: string): string {
	return path.replace(/^[ab]\//, "");
}

/**
 * Number ordinary unified hunks only. Keep the source for a raw fallback if
 * the format or hunk lengths cannot be represented faithfully.
 */
export function parseUnifiedDiff(diff: string): FileDiff[] {
	const files: FileDiff[] = [];
	let file: FileDiff | null = null;
	let hunk: Row[] | null = null;
	let oldLine = 0;
	let newLine = 0;
	let oldLeft = 0;
	let newLeft = 0;
	const finish = (): void => {
		if (file && (oldLeft !== 0 || newLeft !== 0)) file.fallback = true;
	};
	const lines = clean(diff).split("\n");
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	for (const [index, line] of lines.entries()) {
		const inHunk = hunk !== null && (oldLeft > 0 || newLeft > 0);
		const fileHeaders = line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ");
		if (!file || line.startsWith("diff --git ") || (!inHunk && hunk && fileHeaders)) {
			finish();
			file = { path: "", status: "modified", binary: false, metadata: [], raw: [], fallback: false, hunks: [], added: 0, removed: 0 };
			files.push(file);
			hunk = null;
			oldLeft = newLeft = 0;
		}
		file.raw.push(line);
		if (line === "\\ No newline at end of file" && hunk?.length) {
			hunk.push({ kind: "metadata", oldLine: null, newLine: null, text: line });
			continue;
		}
		// Hunk counts, not header-shaped text, determine where content ends.
		if (hunk && (oldLeft > 0 || newLeft > 0) && /^[ +\-]/.test(line)) {
			const kind = line[0] === "+" ? "added" : line[0] === "-" ? "removed" : "context";
			hunk.push({ kind, oldLine: kind === "added" ? null : oldLine++, newLine: kind === "removed" ? null : newLine++, text: line.slice(1) });
			if (kind !== "added") oldLeft -= 1;
			if (kind !== "removed") newLeft -= 1;
			if (kind === "added") file.added += 1;
			if (kind === "removed") file.removed += 1;
			if (oldLeft < 0 || newLeft < 0) file.fallback = true;
			continue;
		}
		if (hunk && (oldLeft !== 0 || newLeft !== 0)) file.fallback = true;
		if (line.startsWith("diff --git ")) {
			const match = /^diff --git (a\/[^\s"\\]+) (b\/[^\s"\\]+)$/.exec(line);
			if (match) file.path = stripPrefix(match[2]!);
			else file.fallback = true;
			continue;
		}
		if (/^(?:new file mode|deleted file mode|old mode|new mode) \d+$/.test(line)) {
			file.metadata.push(line);
			if (line.startsWith("new file")) file.status = "new";
			if (line.startsWith("deleted file")) file.status = "deleted";
			continue;
		}
		if (line.startsWith("rename from ")) { file.status = "renamed"; file.from = line.slice(12); file.metadata.push(line); continue; }
		if (line.startsWith("rename to ")) { file.path = line.slice(10); file.metadata.push(line); continue; }
		if (line.startsWith("Binary files") || line === "GIT binary patch") { file.binary = true; file.fallback = true; continue; }
		if (/^index [0-9a-f]+\.\.[0-9a-f]+(?: \d+)?$/.test(line)) continue;
		if (/^(?:dis)?similarity index \d+%$/.test(line)) { file.metadata.push(line); continue; }
		if (line.startsWith("--- ")) {
			if (!fileHeaders) file.fallback = true;
			if (line === "--- /dev/null") file.status = "new";
			else file.path = stripPrefix(line.slice(4));
			continue;
		}
		if (line.startsWith("+++ ")) {
			if (!lines[index - 1]?.startsWith("--- ")) file.fallback = true;
			if (line === "+++ /dev/null") file.status = "deleted";
			else {
				const path = stripPrefix(line.slice(4));
				if (file.status === "modified" && file.path && file.path !== path) file.fallback = true;
				file.path = path;
			}
			continue;
		}
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
		if (header) {
			finish();
			oldLine = Number(header[1]);
			oldLeft = Number(header[2] ?? 1);
			newLine = Number(header[3]);
			newLeft = Number(header[4] ?? 1);
			if (![oldLine, oldLeft, newLine, newLeft, oldLine + oldLeft, newLine + newLeft].every(Number.isSafeInteger)) file.fallback = true;
			hunk = [];
			file.hunks.push(hunk);
			continue;
		}
		file.fallback = true;
	}
	finish();
	for (const file of files) {
		if (file.hunks.length === 0 && file.metadata.length === 0) file.fallback = true;
	}
	return files;
}

/** Long runs of unchanged lines in the middle of a hunk fold to one marker. */
function foldContext(rows: readonly Row[]): (Row | { fold: number })[] {
	const out: (Row | { fold: number })[] = [];
	let index = 0;
	while (index < rows.length) {
		const row = rows[index]!;
		if (row.kind !== "context") { out.push(row); index += 1; continue; }
		let end = index;
		while (end < rows.length && rows[end]!.kind === "context") end += 1;
		const run = end - index;
		const atEdge = index === 0 || end === rows.length;
		if (run > MAX_CONTEXT_RUN && !atEdge) {
			const keep = Math.floor(MAX_CONTEXT_RUN / 2);
			out.push(...rows.slice(index, index + keep), { fold: run - 2 * keep }, ...rows.slice(end - keep, end));
		} else {
			for (let i = index; i < end; i++) out.push(rows[i]!);
		}
		index = end;
	}
	return out;
}

function gutterWidth(files: readonly FileDiff[]): number {
	let max = 0;
	for (const file of files) {
		for (const hunk of file.hunks) {
			for (const row of hunk) max = Math.max(max, row.oldLine ?? 0, row.newLine ?? 0);
		}
	}
	return Math.max(MIN_GUTTER, String(max).length);
}

function fileHeader(file: FileDiff, paint: Paint): string {
	const status = file.status === "new"
		? ` ${t("diff.new-file")}`
		: file.status === "deleted"
			? ` ${t("diff.deleted")}`
			: file.status === "renamed" && file.from ? ` ${t("diff.renamed-from", { path: stripPrefix(file.from) })}` : "";
	const stats = [file.added > 0 ? paint.added(`+${file.added}`) : "", file.removed > 0 ? paint.removed(`-${file.removed}`) : ""].filter(Boolean).join(" ");
	return `${paint.bold(file.path)}${status ? paint.dim(status) : ""}${stats ? `  ${stats}` : ""}`;
}

/**
 * A unified diff the way an editor shows one: the file on top with its `+n -m`,
 * then every line with its old and new number in a gutter, `+` and `-` painted
 * across the whole row, long unchanged runs folded to `⋯ n unchanged lines`,
 * and a `⋯` between hunks. Long diffs are cut with an explicit marker.
 *
 * `maxLines` bounds the rows printed, not the diff parsed: a cut diff still
 * shows its file headers and correct numbers up to the cut.
 */
export function renderUnifiedDiff(
	diff: string,
	paint: Paint,
	options: { maxLines?: number; remainder?: string } = {},
): string[] {
	const maxLines = options.maxLines ?? DEFAULT_MAX_DIFF_LINES;
	const files = parseUnifiedDiff(diff);
	if (files.length === 0) return [];
	const width = gutterWidth(files);
	const blank = " ".repeat(width);
	const gutter = (left: number | null, right: number | null): string =>
		`${left === null ? blank : String(left).padStart(width)} ${right === null ? blank : String(right).padStart(width)}`;
	const out: string[] = [];
	let total = 0;
	let cut = false;
	const push = (line: string): void => {
		total += 1;
		if (total > maxLines) { cut = true; return; }
		out.push(line);
	};
	files.forEach((file, fileIndex) => {
		if (fileIndex > 0) push("");
		if (file.fallback) { file.raw.forEach(push); return; }
		if (file.path.length > 0) push(fileHeader(file, paint));
		file.metadata.forEach((line) => push(paint.dim(line)));
		file.hunks.forEach((hunk, hunkIndex) => {
			if (hunkIndex > 0) push(paint.dim(`${blank} ${blank}   ⋯`));
			for (const row of foldContext(hunk)) {
				if ("fold" in row) { push(paint.dim(`${blank} ${blank}   ⋯ ${t("diff.unchanged", { n: row.fold })}`)); continue; }
				const text = row.text;
				if (row.kind === "added") push(paint.added(`${gutter(null, row.newLine)} + ${text}`));
				else if (row.kind === "removed") push(paint.removed(`${gutter(row.oldLine, null)} - ${text}`));
				else if (row.kind === "metadata") push(paint.dim(`${blank} ${blank}   ${text}`));
				else push(`${paint.dim(gutter(row.oldLine, row.newLine))}   ${text}`);
			}
		});
	});
	if (cut) {
		const remainder = options.remainder ?? "open the full proposal artifact for the exact remainder";
		out.push(paint.warning(`… ${total - maxLines} more diff lines; ${remainder}`));
	}
	return out;
}

/** The width of the gutter a rendered row carries, so a wrap can keep it. */
export function diffRowGutter(line: string): { prefix: string; marker: "+" | "-" } | null {
	const match = /^([ \d]+ [ \d]+) ([+-]) /.exec(line);
	if (!match) return null;
	return { prefix: " ".repeat(visibleLength(match[1]!)), marker: match[2] as "+" | "-" };
}

export function diffStats(diff: string): { files: number; added: number; removed: number } {
	const files = parseUnifiedDiff(diff);
	return { files: files.length, added: files.reduce((sum, file) => sum + file.added, 0), removed: files.reduce((sum, file) => sum + file.removed, 0) };
}
