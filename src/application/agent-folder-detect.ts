import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * "There is already an agent in this folder."
 *
 * `ahde` used to have exactly one answer for a directory that was not empty:
 * refuse. That is the wrong answer for the only case that matters — the
 * operator's agent already exists, and asking them to move it into an empty
 * folder is asking them to distrust the tool before it has done anything.
 *
 * This module is what lets the first screen say "Вижу агента (agent.py, 2
 * тула). Принять?" instead. It is pure, read-only, bounded, and it never
 * executes a line of what it finds: a detector that ran the operator's code to
 * decide what the operator's code is would be a much worse trade than a
 * heuristic that is sometimes wrong and always cheap.
 */

/** A folder bigger than this is not a single agent; it is a monorepo. */
export const MAX_SCANNED_FILES = 2_000;
/** Files larger than this are not read. An entry point is not a megabyte. */
export const MAX_SCANNED_FILE_BYTES = 1024 * 1024;

/** Directories that are never anybody's agent, and are expensive to walk. */
const SKIPPED_DIRECTORIES = new Set([
	".git",
	".ahde",
	"runs",
	"imports",
	"node_modules",
	"__pycache__",
	".venv",
	"venv",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	"dist",
	"build",
	".idea",
	".vscode",
]);

/**
 * The entry points worth guessing, best first. Order is the whole heuristic:
 * a folder with both `agent.py` and `main.py` means the first one.
 */
const ENTRY_CANDIDATES = ["agent.py", "main.py", "app.py", join("src", "agent.py")] as const;

/** Imports that say "this file talks to a model", rather than "this is Python". */
const MODEL_IMPORT = /^\s*(?:from|import)\s+(openai|anthropic|httpx|requests)\b/m;

/** Shapes that read as "a tool the agent can call". Counted for a sentence, never for a decision. */
const TOOL_SHAPES = [/^\s*@\w*\.?tool\b/gm, /^\s*(?:TOOLS|tools)\s*=\s*\[/gm, /^\s*def\s+tool_\w+/gm];

export interface DetectedAgentFolder {
	/** Repository-relative path of the entry point, with `/` separators. */
	entry: string;
	language: "python";
	/** How many tool-ish declarations were seen. For the sentence, not the decision. */
	toolCount: number;
	filesScanned: number;
}

function readIfSmall(path: string): string | null {
	try {
		const entry = lstatSync(path);
		if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_SCANNED_FILE_BYTES) return null;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Every regular file under `root`, bounded, with the noise directories skipped. */
function scan(root: string): { files: string[]; truncated: boolean } {
	const files: string[] = [];
	let truncated = false;
	const walk = (directory: string): void => {
		if (truncated) return;
		let entries;
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (truncated) return;
			if (entry.isSymbolicLink()) continue;
			const absolute = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(absolute);
				continue;
			}
			if (!entry.isFile()) continue;
			files.push(relative(root, absolute).split(sep).join("/"));
			if (files.length > MAX_SCANNED_FILES) {
				truncated = true;
				return;
			}
		}
	};
	walk(root);
	return { files, truncated };
}

function countTools(source: string): number {
	let total = 0;
	for (const shape of TOOL_SHAPES) total += source.match(shape)?.length ?? 0;
	return total;
}

/**
 * What is in this folder, if anything AHDE can adopt.
 *
 * Returns null — never throws — for every folder that is not one: a Target
 * that already has a `manifest.yaml` (it is already a Target), a folder with no
 * plausible Python entry point, a tree too large to be one agent. A null here
 * means the operator gets the ordinary "create a new agent" path, which is what
 * they got before this existed.
 */
export function detectAgentFolder(directory: string): DetectedAgentFolder | null {
	const root = resolve(directory);
	try {
		const entry = lstatSync(root);
		if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
	} catch {
		return null;
	}
	// A folder that already declares a Target is not a folder to adopt. Wrapping
	// it would write a second manifest over a Target that already has one.
	if (readIfSmall(join(root, "manifest.yaml")) !== null) return null;

	const { files, truncated } = scan(root);
	if (truncated) return null;

	const python = new Set(files.filter((file) => file.endsWith(".py")));
	if (python.size === 0) return null;

	let entry: string | undefined;
	for (const candidate of ENTRY_CANDIDATES) {
		const normalized = candidate.split(sep).join("/");
		if (python.has(normalized)) {
			entry = normalized;
			break;
		}
	}
	if (!entry) {
		// The fallback: exactly one top-level Python file that reaches for a model
		// client. "Exactly one" is doing the work — two candidates is a guess, and
		// a wrong guess writes the wrong `argv` into a manifest.
		const topLevel = [...python].filter((file) => !file.includes("/"));
		const reaching = topLevel.filter((file) => {
			const source = readIfSmall(join(root, file));
			return source !== null && MODEL_IMPORT.test(source);
		});
		if (reaching.length !== 1) return null;
		entry = reaching[0] as string;
	}

	const source = readIfSmall(join(root, entry));
	if (source === null) return null;
	let toolCount = countTools(source);
	// Tools commonly live beside the entry point rather than inside it.
	for (const file of python) {
		if (file === entry) continue;
		const body = readIfSmall(join(root, file));
		if (body !== null) toolCount += countTools(body);
	}
	return { entry, language: "python", toolCount, filesScanned: files.length };
}
