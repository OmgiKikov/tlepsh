/**
 * The one tokenization.
 *
 * `similarity(token-f1)`, `cites_source` and the knowledge base's BM25 ranking
 * all have to agree on what a word is, or an answer can overlap a chunk by one
 * measure and miss it by another. These two functions used to live in
 * `eval.ts`; they moved here — a leaf module with no imports — so the target
 * runtime can reach them without `eval.ts` reaching back. `eval.ts` re-exports
 * both, so every existing caller is unchanged.
 */

/** Unicode word tokens: runs of letters or digits, case-folded. */
export function answerTokens(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Multiset token F1, the standard span-answer overlap score. */
export function tokenF1(a: string, b: string): number {
	const left = answerTokens(a);
	const right = answerTokens(b);
	if (left.length === 0 && right.length === 0) return 1;
	if (left.length === 0 || right.length === 0) return 0;
	const remaining = new Map<string, number>();
	for (const token of left) remaining.set(token, (remaining.get(token) ?? 0) + 1);
	let overlap = 0;
	for (const token of right) {
		const available = remaining.get(token) ?? 0;
		if (available > 0) {
			remaining.set(token, available - 1);
			overlap += 1;
		}
	}
	if (overlap === 0) return 0;
	const precision = overlap / left.length;
	const recall = overlap / right.length;
	return (2 * precision * recall) / (precision + recall);
}
