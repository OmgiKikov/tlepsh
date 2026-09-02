/**
 * A knowledge base an agent answers from, as a deterministic function of bytes.
 *
 * Most agents worth evaluating answer from documents, and until now the engine
 * had nothing to say about them: a generated exam for a retrieval agent was
 * questions about nothing, and a grader could not tell an answer that stood on
 * a source from one that did not. This module is the whole retrieval story, and
 * it is deliberately small:
 *
 *  - chunking is pure and deterministic, so a chunk id is *evidence*. The same
 *    documents always produce the same ids, which is what lets a sealed case
 *    name the source it was written from and a grader find that source again in
 *    the run's own workspace months later.
 *  - ranking is lexical BM25 over {@link answerTokens} — the same tokenizer the
 *    similarity grader compares with. No embeddings, no model call, no
 *    dependency, nothing that drifts behind an unchanged version number.
 *
 * Everything here is bounded and fails closed. A knowledge base larger than the
 * bounds is refused with the number that broke, never silently truncated: an
 * exam written from half a corpus is an exam about a corpus that does not
 * exist.
 */

import { hashValue, sha256Hex } from "../provenance.js";
import { answerTokens } from "./tokens.js";

/** One retrievable passage. `id` is stable evidence, not a cursor. */
export interface KbChunk {
	/** `<path>#<ordinal>`: the document, and which passage of it. */
	id: string;
	/** Document path relative to the knowledge-base root, `/`-separated. */
	path: string;
	/** Zero-based position of this chunk within its document. */
	ordinal: number;
	text: string;
}

/**
 * Chunk geometry. It is part of the index hash on purpose: the same bytes cut
 * differently are a different tool, and a Target whose retrieval changed must
 * not reuse evidence produced before it changed.
 */
export const KB_CHUNK_CHARS = 800;
export const KB_CHUNK_OVERLAP_CHARS = 100;

/** Bounds. A knowledge base is a corpus an operator can still reason about. */
export const MAX_KB_FILES = 2_000;
export const MAX_KB_TEXT_BYTES = 8 * 1024 * 1024;
export const MAX_KB_CHUNKS = 20_000;

/** BM25 saturation and length-normalization, at their standard values. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** The largest number of chunks one search may return. */
export const MAX_KB_SEARCH_RESULTS = 8;
export const DEFAULT_KB_SEARCH_RESULTS = 4;

export class KnowledgeBaseError extends Error {
	readonly name = "KnowledgeBaseError";
}

/** Codepoint order, so a chunk id never depends on the machine's locale. */
function byCodepoint(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Paragraphs, in document order. A blank line is the one boundary every
 * document format in scope (`.md`, `.txt`) agrees on, and it is a boundary an
 * author chose, which is why the split is on it and not on a character count.
 */
function paragraphsOf(text: string): string[] {
	return text
		.replace(/\r\n?/g, "\n")
		.split(/\n[ \t]*\n+/)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph.length > 0);
}

/**
 * The tail carried into the next chunk. Exactly {@link KB_CHUNK_OVERLAP_CHARS}
 * characters, advanced to the next whitespace so the overlap starts at a word
 * — deterministic either way, and readable when a citation quotes it.
 */
function overlapTail(chunk: string): string {
	if (chunk.length <= KB_CHUNK_OVERLAP_CHARS) return chunk;
	const tail = chunk.slice(chunk.length - KB_CHUNK_OVERLAP_CHARS);
	const boundary = tail.search(/\s/);
	return (boundary === -1 ? tail : tail.slice(boundary + 1)).trim();
}

/** One oversized paragraph, cut into overlapping windows. */
function windows(paragraph: string): string[] {
	const step = KB_CHUNK_CHARS - KB_CHUNK_OVERLAP_CHARS;
	const parts: string[] = [];
	for (let start = 0; start < paragraph.length; start += step) {
		const part = paragraph.slice(start, start + KB_CHUNK_CHARS).trim();
		if (part.length > 0) parts.push(part);
		if (start + KB_CHUNK_CHARS >= paragraph.length) break;
	}
	return parts;
}

/** The passages of one document, in order. */
function chunkDocument(text: string): string[] {
	const chunks: string[] = [];
	let buffer = "";
	for (const paragraph of paragraphsOf(text)) {
		if (paragraph.length > KB_CHUNK_CHARS) {
			// A paragraph nobody broke up is cut into overlapping windows. It
			// already carries its own overlap, so the next paragraph starts clean
			// rather than inheriting a second, differently sized one.
			if (buffer.length > 0) chunks.push(buffer);
			buffer = "";
			for (const part of windows(paragraph)) chunks.push(part);
			continue;
		}
		const candidate = buffer.length === 0 ? paragraph : `${buffer}\n\n${paragraph}`;
		if (candidate.length <= KB_CHUNK_CHARS) {
			buffer = candidate;
			continue;
		}
		// `buffer` is non-empty here: an empty one makes `candidate` the paragraph,
		// which this branch has already ruled out as over the bound.
		chunks.push(buffer);
		const tail = overlapTail(buffer);
		const next = tail.length === 0 ? paragraph : `${tail}\n\n${paragraph}`;
		// The overlap must never push a chunk past the bound it exists to respect,
		// so a tail that no longer fits beside this paragraph is dropped.
		buffer = next.length <= KB_CHUNK_CHARS ? next : paragraph;
	}
	if (buffer.length > 0) chunks.push(buffer);
	return chunks;
}

/**
 * Split declared documents into retrievable passages. Files are sorted by path
 * first, so the chunk list — and therefore the index hash — depends on the
 * bytes and nothing else.
 */
export function chunkKnowledge(files: readonly { path: string; text: string }[]): KbChunk[] {
	if (files.length > MAX_KB_FILES) {
		throw new KnowledgeBaseError(
			`the knowledge base holds ${files.length} files, over the ${MAX_KB_FILES} file bound`,
		);
	}
	let bytes = 0;
	for (const file of files) bytes += Buffer.byteLength(file.text, "utf8");
	if (bytes > MAX_KB_TEXT_BYTES) {
		throw new KnowledgeBaseError(
			`the knowledge base holds ${bytes} bytes of text, over the ${MAX_KB_TEXT_BYTES} byte bound`,
		);
	}
	const seen = new Set<string>();
	for (const file of files) {
		if (seen.has(file.path)) {
			throw new KnowledgeBaseError(`the knowledge base declares ${file.path} twice`);
		}
		seen.add(file.path);
	}
	const ordered = [...files].sort((left, right) => byCodepoint(left.path, right.path));
	const chunks: KbChunk[] = [];
	for (const file of ordered) {
		for (const [ordinal, text] of chunkDocument(file.text).entries()) {
			chunks.push({ id: `${file.path}#${ordinal}`, path: file.path, ordinal, text });
		}
		if (chunks.length > MAX_KB_CHUNKS) {
			throw new KnowledgeBaseError(
				`the knowledge base splits into more than ${MAX_KB_CHUNKS} chunks`,
			);
		}
	}
	return chunks;
}

/**
 * The identity of one built index: the chunk geometry, and every chunk's id and
 * content. Two knowledge bases with the same bytes cut the same way hash the
 * same; changing either the documents or the chunker changes the hash, which is
 * exactly what the Target identity needs it to do.
 */
export function kbIndexHash(chunks: readonly KbChunk[]): string {
	return hashValue({
		schemaVersion: 1,
		chunker: { chars: KB_CHUNK_CHARS, overlap: KB_CHUNK_OVERLAP_CHARS },
		chunks: chunks.map((chunk) => ({ id: chunk.id, sha256: sha256Hex(chunk.text) })),
	});
}

interface Bm25Index {
	documentTokens: string[][];
	documentFrequency: Map<string, number>;
	averageLength: number;
}

// Tokenizing 20 000 chunks on every tool call would make retrieval the slowest
// thing in a run. The index is derived from the chunk array and nothing else,
// so it is cached against that array's identity and dies with it.
const INDEX_CACHE = new WeakMap<readonly KbChunk[], Bm25Index>();

function indexOf(chunks: readonly KbChunk[]): Bm25Index {
	const cached = INDEX_CACHE.get(chunks);
	if (cached) return cached;
	const documentTokens = chunks.map((chunk) => answerTokens(chunk.text));
	const documentFrequency = new Map<string, number>();
	let total = 0;
	for (const tokens of documentTokens) {
		total += tokens.length;
		for (const token of new Set(tokens)) {
			documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
		}
	}
	const index: Bm25Index = {
		documentTokens,
		documentFrequency,
		averageLength: documentTokens.length === 0 ? 0 : total / documentTokens.length,
	};
	INDEX_CACHE.set(chunks, index);
	return index;
}

export interface KbSearchHit {
	chunk: KbChunk;
	score: number;
}

/**
 * Okapi BM25 over the chunk list, ranked and truncated to `k`.
 *
 * Ties break by chunk id, ascending, so two equally relevant passages always
 * come back in the same order — the difference between a reproducible run and
 * one that depends on which document was read first.
 */
export function bm25Search(
	chunks: readonly KbChunk[],
	query: string,
	k: number = DEFAULT_KB_SEARCH_RESULTS,
): KbSearchHit[] {
	const limit = Math.min(Math.max(Math.trunc(k) || DEFAULT_KB_SEARCH_RESULTS, 1), MAX_KB_SEARCH_RESULTS);
	const queryTokens = answerTokens(query);
	if (chunks.length === 0 || queryTokens.length === 0) return [];
	const index = indexOf(chunks);
	const total = chunks.length;
	const scored: KbSearchHit[] = [];
	for (const [position, chunk] of chunks.entries()) {
		const tokens = index.documentTokens[position] ?? [];
		if (tokens.length === 0) continue;
		const counts = new Map<string, number>();
		for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
		let score = 0;
		for (const token of new Set(queryTokens)) {
			const frequency = counts.get(token);
			if (!frequency) continue;
			const df = index.documentFrequency.get(token) ?? 0;
			const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
			const normalization = 1 - BM25_B + (BM25_B * tokens.length) / (index.averageLength || 1);
			score += idf * ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * normalization));
		}
		if (score > 0) scored.push({ chunk, score });
	}
	scored.sort((left, right) =>
		left.score === right.score ? byCodepoint(left.chunk.id, right.chunk.id) : right.score - left.score
	);
	return scored.slice(0, limit);
}
