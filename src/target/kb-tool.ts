/**
 * `kb_search`: the tool a declared knowledge base turns on.
 *
 * One fact decides it — `manifest.data` declares `data/kb` — so there is no new
 * manifest key to keep in sync with the directory that already exists. The
 * declaration is what copies those documents into the workspace snapshot and
 * hashes them into `workspaceHash`; this module is what lets the Target read
 * them the way a retrieval agent actually does.
 *
 * It is a *host* tool, not a declared one: it runs in this process, it takes no
 * arguments that name a path, and the only bytes it can reach are the ones the
 * run's own workspace already contains. There is nothing for a sandbox to
 * confine, so it does not claim one — the search reads the snapshot it was
 * built from and nothing else.
 */

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	bm25Search,
	chunkKnowledge,
	DEFAULT_KB_SEARCH_RESULTS,
	KnowledgeBaseError,
	MAX_KB_FILES,
	MAX_KB_SEARCH_RESULTS,
	type KbChunk,
} from "../domain/kb.js";

export const KB_SEARCH_TOOL_NAME = "kb_search";

/** The one declared directory that means "this agent answers from documents". */
export const KB_DATA_DECLARATION = "data/kb";

/** Documents this build understands. PDF and HTML are not knowledge yet. */
const KB_EXTENSIONS = [".md", ".txt"];

/** How deep a knowledge base may nest, matching the declared-data bound. */
const MAX_KB_DEPTH = 16;

/**
 * Whether a manifest's declared data turns the tool on: `data/kb` itself, or a
 * directory beneath it. Anything else — `data/kbx`, `data/fixtures` — does not.
 */
export function knowledgeBaseDeclared(declarations: readonly string[]): boolean {
	return declarations.some((declaration) =>
		declaration === KB_DATA_DECLARATION || declaration.startsWith(`${KB_DATA_DECLARATION}/`)
	);
}

function knowledgeFiles(root: string): { path: string; text: string }[] {
	const files: { path: string; text: string }[] = [];
	const walk = (absolute: string, depth: number): void => {
		if (depth > MAX_KB_DEPTH) {
			throw new KnowledgeBaseError(`the knowledge base nests deeper than ${MAX_KB_DEPTH} levels`);
		}
		for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const child = join(absolute, entry.name);
			const stat = lstatSync(child);
			// The snapshot copier already refuses symlinks; refusing again here is
			// what keeps this module honest when it is pointed at a directory the
			// copier never touched, such as a test fixture.
			if (stat.isSymbolicLink()) {
				throw new KnowledgeBaseError(`the knowledge base contains a symlink: ${relative(root, child)}`);
			}
			if (stat.isDirectory()) {
				walk(child, depth + 1);
				continue;
			}
			if (!stat.isFile()) continue;
			if (!KB_EXTENSIONS.some((extension) => entry.name.toLowerCase().endsWith(extension))) continue;
			if (files.length >= MAX_KB_FILES) {
				throw new KnowledgeBaseError(`the knowledge base holds more than ${MAX_KB_FILES} readable files`);
			}
			files.push({ path: relative(root, child).split(sep).join("/"), text: readFileSync(child, "utf8") });
		}
	};
	walk(root, 1);
	return files;
}

/**
 * The chunk list one workspace serves, or an empty list when the workspace
 * carries no `data/kb` at all. Paths in a chunk id are relative to the
 * knowledge-base root, so an id reads as `tariffs.md#2` and stays short enough
 * to survive being quoted in an answer.
 */
export function readKnowledgeBase(workspaceDir: string): KbChunk[] {
	const root = resolve(workspaceDir, KB_DATA_DECLARATION);
	let stat;
	try {
		stat = lstatSync(root);
	} catch {
		return [];
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
	return chunkKnowledge(knowledgeFiles(root));
}

/**
 * The exact text behind one chunk id, rebuilt from the workspace that served
 * it. Same chunker, same bytes, same id — which is what makes a citation
 * checkable long after the run that produced it.
 */
export function findKbChunk(workspaceDir: string, chunkId: string): KbChunk | null {
	return readKnowledgeBase(workspaceDir).find((chunk) => chunk.id === chunkId) ?? null;
}

const KB_SEARCH_DESCRIPTION =
	"Search the agent's knowledge base and return the passages that best match the query. " +
	"Each result carries a stable id; cite the id of any passage you answer from.";

/**
 * The declarative surface an adapter has to be able to describe: one required
 * string, one optional bounded integer, and no path anywhere.
 */
export const KB_SEARCH_PARAMETERS: Record<string, unknown> = {
	type: "object",
	properties: {
		query: { type: "string", description: "What to look for, in the language of the documents." },
		k: {
			type: "integer",
			minimum: 1,
			maximum: MAX_KB_SEARCH_RESULTS,
			description: `How many passages to return (default ${DEFAULT_KB_SEARCH_RESULTS}).`,
		},
	},
	required: ["query"],
	additionalProperties: false,
};

/**
 * The in-process tool definition. The chunk list is captured once, when the
 * runtime is created, so every call in a run searches exactly the index whose
 * hash that run recorded.
 */
export function createKbSearchTool(chunks: readonly KbChunk[]): ToolDefinition<any, any, any> {
	return {
		name: KB_SEARCH_TOOL_NAME,
		label: KB_SEARCH_TOOL_NAME,
		description: KB_SEARCH_DESCRIPTION,
		promptSnippet: KB_SEARCH_DESCRIPTION,
		parameters: KB_SEARCH_PARAMETERS as any,
		// Retrieval reads a frozen in-memory index and mutates nothing, so two
		// searches in one turn may run together.
		executionMode: "parallel",
		async execute(_toolCallId: string, params: unknown) {
			const bag = (params ?? {}) as { query?: unknown; k?: unknown };
			const refuse = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: { matches: 0, indexed: chunks.length, refused: text },
			});
			if (typeof bag.query !== "string" || bag.query.trim().length === 0) {
				return refuse("kb_search requires a non-empty `query` string.");
			}
			if (bag.k !== undefined && (typeof bag.k !== "number" || !Number.isInteger(bag.k) || bag.k < 1)) {
				return refuse(`kb_search \`k\` must be an integer between 1 and ${MAX_KB_SEARCH_RESULTS}.`);
			}
			const hits = bm25Search(chunks, bag.query, typeof bag.k === "number" ? bag.k : DEFAULT_KB_SEARCH_RESULTS);
			const text = JSON.stringify({
				chunks: hits.map((hit) => ({ id: hit.chunk.id, path: hit.chunk.path, text: hit.chunk.text })),
			});
			return {
				content: [{ type: "text" as const, text }],
				details: { matches: hits.length, indexed: chunks.length },
			};
		},
	};
}
