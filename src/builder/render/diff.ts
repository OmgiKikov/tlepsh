import { clean } from "./format.js";
import type { Paint } from "./paint.js";

export const DEFAULT_MAX_DIFF_LINES = 400;

/** Colorize one unified diff; long diffs are cut with an explicit marker. */
export function renderUnifiedDiff(
	diff: string,
	paint: Paint,
	options: { maxLines?: number } = {},
): string[] {
	const maxLines = options.maxLines ?? DEFAULT_MAX_DIFF_LINES;
	const lines = clean(diff).split("\n");
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const shown = lines.slice(0, maxLines).map((line) => {
		if (line.startsWith("diff --git ") || line.startsWith("index ")) return paint.dim(line);
		if (line.startsWith("+++ ") || line.startsWith("--- ")) return paint.bold(line);
		if (line.startsWith("@@")) return paint.accent(line);
		if (line.startsWith("+")) return paint.added(line);
		if (line.startsWith("-")) return paint.removed(line);
		return line;
	});
	if (lines.length > maxLines) {
		shown.push(paint.warning(`… ${lines.length - maxLines} more diff lines; open the full proposal artifact for the exact remainder`));
	}
	return shown;
}

export function diffStats(diff: string): { files: number; added: number; removed: number } {
	let files = 0;
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) files += 1;
		else if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
		else if (line.startsWith("+")) added += 1;
		else if (line.startsWith("-")) removed += 1;
	}
	return { files, added, removed };
}
