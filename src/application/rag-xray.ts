import { DEFAULT_KB_SEARCH_RESULTS, MAX_KB_SEARCH_RESULTS } from "../domain/kb.js";
import { tokenF1 } from "../domain/tokens.js";
import type { RunRecord } from "../provenance.js";
import {
	lastAssistantText,
	redactTraceText,
	type TraceMessage,
	type TraceToolCall,
} from "../trace.js";

/** The host tool whose result shape this projection understands. */
export const RAG_XRAY_TOOL = "kb_search";
/** Keep a run detail useful without letting a pathological trace make a huge report DTO. */
export const MAX_RAG_XRAY_SEARCHES = 32;
export const MAX_RAG_XRAY_CHUNK_IDS = 128;

const MAX_QUERY_CHARS = 1_000;
const MAX_CHUNK_ID_CHARS = 300;
const MAX_PATH_CHARS = 500;
const MAX_RAW_ID_CHARS = 4_096;

export type RagSearchStatus = "ok" | "error" | "missing-result" | "unreadable";
export type RagDiagnosis =
	| "unlabelled"
	| "retrieval-bypassed"
	| "retrieval-unknown"
	| "retrieval-miss"
	| "answer-grounding-miss"
	| "retrieved-and-supported"
	| "retrieved-and-cited"
	| "mixed";

export interface RagXrayHit {
	rank: number;
	chunkId: string;
	path: string | null;
	/** BM25 score recorded by current kb_search; null for legacy result payloads. */
	score: number | null;
	expected: boolean;
	/** The final answer names this exact stable chunk id. */
	cited: boolean;
	/** Deterministic token overlap, useful as support evidence but not an entailment claim. */
	answerOverlap: number | null;
}

export interface RagSearchXray {
	callId: string;
	query: string | null;
	requestedK: number | null;
	status: RagSearchStatus;
	durationMs: number | null;
	hits: RagXrayHit[];
	/** One when at least one expected source was returned, null without a source label. */
	hitAtK: number | null;
	/** Reciprocal rank of the first expected source, null without a source label. */
	reciprocalRank: number | null;
}

interface RagMeasurementCounts {
	evaluatedSearches: number;
	hitSearches: number;
	reciprocalRankSum: number;
	expectedSources: number;
	citedExpectedSources: number;
	groundingGraders: number;
	groundingPasses: number;
	measuredSearchLatencies: number;
	searchLatencyMs: number;
	scoredHits: number;
	totalHits: number;
}

export interface RagRunXray {
	labelStatus: "available" | "missing";
	expectedChunkIds: string[];
	searchCount: number;
	omittedSearchCount: number;
	searches: RagSearchXray[];
	retrievedChunkIds: string[];
	/** Explicit use only: ids the final answer actually names. */
	citedChunkIds: string[];
	hitAtK: number | null;
	mrr: number | null;
	citationRate: number | null;
	groundingPassRate: number | null;
	retrievalLatencyMs: number | null;
	retrievalCostUsd: 0 | null;
	scoreCoverage: number | null;
	diagnosis: RagDiagnosis;
	/** cites_source proves citation/overlap, not claim-level entailment. */
	faithfulness: "not-measured";
	/** Exact additive counts from which eval summaries are derived. */
	measurement: RagMeasurementCounts;
}

export interface RagEvalXray {
	applicableRuns: number;
	labelledRuns: number;
	searchCount: number;
	omittedSearchCount: number;
	evaluatedSearches: number;
	hitAtK: number | null;
	mrr: number | null;
	citationRate: number | null;
	groundingPassRate: number | null;
	meanSearchLatencyMs: number | null;
	retrievalCostUsd: 0 | null;
	scoreCoverage: number | null;
	diagnoses: Partial<Record<RagDiagnosis, number>>;
	faithfulness: "not-measured";
}

export interface RagXrayComparison {
	baseline: RagEvalXray;
	candidate: RagEvalXray;
	delta: {
		hitAtK: number | null;
		mrr: number | null;
		citationRate: number | null;
		groundingPassRate: number | null;
		meanSearchLatencyMs: number | null;
		scoreCoverage: number | null;
	};
}

interface ParsedHit {
	id: string;
	path: string | null;
	score: number | null;
	text: string | null;
}

function boundedText(value: string, max: number): string {
	return redactTraceText(value).slice(0, max);
}

function parseHits(text: string): ParsedHit[] | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const envelope = value as { schemaVersion?: unknown; chunks?: unknown };
	if (envelope.schemaVersion !== undefined && envelope.schemaVersion !== 1) return null;
	const chunks = envelope.chunks;
	if (!Array.isArray(chunks) || chunks.length > MAX_KB_SEARCH_RESULTS) return null;
	const hits: ParsedHit[] = [];
	const ids = new Set<string>();
	for (const [index, chunk] of chunks.entries()) {
		if (typeof chunk !== "object" || chunk === null || Array.isArray(chunk)) return null;
		const bag = chunk as { rank?: unknown; id?: unknown; path?: unknown; score?: unknown; text?: unknown };
		if (bag.rank !== undefined && bag.rank !== index + 1) return null;
		if (typeof bag.id !== "string" || bag.id.length === 0 || bag.id.length > MAX_RAW_ID_CHARS) return null;
		if (ids.has(bag.id)) return null;
		ids.add(bag.id);
		if (bag.path !== undefined && typeof bag.path !== "string") return null;
		if (bag.score !== undefined &&
			(typeof bag.score !== "number" || !Number.isFinite(bag.score) || bag.score < 0)) return null;
		if (bag.text !== undefined && typeof bag.text !== "string") return null;
		hits.push({
			id: bag.id,
			path: typeof bag.path === "string" ? bag.path : null,
			score: typeof bag.score === "number" ? bag.score : null,
			text: typeof bag.text === "string" ? bag.text : null,
		});
	}
	return hits;
}

function resultMessages(messages: readonly TraceMessage[]): Map<string, TraceMessage> {
	const results = new Map<string, TraceMessage>();
	for (const message of messages) {
		const result = message.toolResult;
		if (message.role !== "toolResult" || !result || results.has(result.toolCallId)) continue;
		results.set(result.toolCallId, message);
	}
	return results;
}

function calls(messages: readonly TraceMessage[]): Array<{ call: TraceToolCall; at: number | null }> {
	const found: Array<{ call: TraceToolCall; at: number | null }> = [];
	for (const message of messages) {
		for (const call of message.toolCalls ?? []) {
			// Agent-reported notes are context, never proof that retrieval happened.
			if (call.name === RAG_XRAY_TOOL && call.evidence !== "reported") {
				found.push({ call, at: message.timestamp ?? null });
			}
		}
	}
	return found;
}

function requestedK(call: TraceToolCall): number | null {
	const value = call.arguments.k;
	if (value === undefined) return DEFAULT_KB_SEARCH_RESULTS;
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_KB_SEARCH_RESULTS
		? value
		: null;
}

function diagnosis(input: {
	labelled: boolean;
	searchCount: number;
	evaluatedSearches: number;
	hitSearches: number;
	citationRate: number | null;
	groundingPassRate: number | null;
}): RagDiagnosis {
	if (!input.labelled) return "unlabelled";
	if (input.searchCount === 0) return "retrieval-bypassed";
	if (input.evaluatedSearches === 0) return "retrieval-unknown";
	if (input.hitSearches === 0) return "retrieval-miss";
	if (input.groundingPassRate === 0) return "answer-grounding-miss";
	if (input.hitSearches < input.evaluatedSearches ||
		(input.groundingPassRate !== null && input.groundingPassRate < 1)) return "mixed";
	if (input.citationRate === 1) return "retrieved-and-cited";
	if (input.groundingPassRate === 1) return "retrieved-and-supported";
	return "mixed";
}

/**
 * Project retrieval evidence from one already-verified Run and its canonical trace.
 *
 * The interface returns only bounded/redacted ids, queries and numbers. Chunk text
 * is used transiently to calculate answer overlap and never crosses the seam.
 * Derived metrics are not persisted: the trace and grader result remain the evidence.
 */
export function projectRagRunXray(
	run: Pick<RunRecord, "evalResults">,
	messages: readonly TraceMessage[],
): RagRunXray | null {
	const graders = run.evalResults?.graders ?? [];
	const citesSource = graders.filter((grader) => grader.checkCode === "cites-source");
	const labelledGraders = citesSource.filter(
		(grader): grader is typeof grader & { checkSubject: string } => typeof grader.checkSubject === "string",
	);
	const rawExpected = [...new Set(labelledGraders.map((grader) => grader.checkSubject))];
	const labelled = rawExpected.length > 0;
	const expected = new Set(rawExpected);
	const allCalls = calls(messages);
	if (allCalls.length === 0 && citesSource.length === 0) return null;

	const answer = lastAssistantText(messages.slice()) ?? null;
	const results = resultMessages(messages);
	const searches: RagSearchXray[] = [];
	const retrieved = new Set<string>();
	const cited = new Set<string>();
	let evaluatedSearches = 0;
	let hitSearches = 0;
	let reciprocalRankSum = 0;
	let measuredSearchLatencies = 0;
	let searchLatencyMs = 0;
	let scoredHits = 0;
	let totalHits = 0;

	for (const { call, at } of allCalls) {
		const resultMessage = results.get(call.id);
		const result = resultMessage?.toolResult;
		let status: RagSearchStatus;
		let parsed: ParsedHit[] | null = null;
		if (!result || result.toolName !== RAG_XRAY_TOOL) status = "missing-result";
		else if (result.isError) status = "error";
		else {
			parsed = parseHits(result.text);
			status = parsed === null ? "unreadable" : "ok";
		}
		const durationMs = resultMessage?.timestamp !== undefined && at !== null
			? Math.max(0, resultMessage.timestamp - at)
			: null;
		if (durationMs !== null) {
			measuredSearchLatencies += 1;
			searchLatencyMs += durationMs;
		}

		let firstExpectedRank: number | null = null;
		const hits = (parsed ?? []).map((hit, index): RagXrayHit => {
			const rank = index + 1; // array order is canonical even for legacy payloads
			const isExpected = expected.has(hit.id);
			if (isExpected && firstExpectedRank === null) firstExpectedRank = rank;
			if (retrieved.size < MAX_RAG_XRAY_CHUNK_IDS) retrieved.add(hit.id);
			const isCited = answer?.includes(hit.id) ?? false;
			if (isCited && cited.size < MAX_RAG_XRAY_CHUNK_IDS) cited.add(hit.id);
			totalHits += 1;
			if (hit.score !== null) scoredHits += 1;
			return {
				rank,
				chunkId: boundedText(hit.id, MAX_CHUNK_ID_CHARS),
				path: hit.path === null ? null : boundedText(hit.path, MAX_PATH_CHARS),
				score: hit.score,
				expected: isExpected,
				cited: isCited,
				answerOverlap: answer === null || hit.text === null ? null : tokenF1(answer, hit.text),
			};
		});
		const hitAtK = labelled && status === "ok" ? (firstExpectedRank === null ? 0 : 1) : null;
		const reciprocalRank = labelled && status === "ok"
			? (firstExpectedRank === null ? 0 : 1 / firstExpectedRank)
			: null;
		if (hitAtK !== null && reciprocalRank !== null) {
			evaluatedSearches += 1;
			hitSearches += hitAtK;
			reciprocalRankSum += reciprocalRank;
		}
		if (searches.length < MAX_RAG_XRAY_SEARCHES) {
			const query = typeof call.arguments.query === "string"
				? boundedText(call.arguments.query, MAX_QUERY_CHARS)
				: null;
			searches.push({
				callId: boundedText(call.id, 200),
				query,
				requestedK: requestedK(call),
				status,
				durationMs,
				hits,
				hitAtK,
				reciprocalRank,
			});
		}
	}

	// A labelled run that never searched is a measured retrieval bypass, not an
	// absent metric. A call whose result is missing/unreadable stays unknown.
	if (labelled && allCalls.length === 0) evaluatedSearches = 1;
	const citedExpected = rawExpected.filter((id) => answer?.includes(id) ?? false);
	for (const id of citedExpected) {
		if (cited.size < MAX_RAG_XRAY_CHUNK_IDS) cited.add(id);
	}
	const groundingPasses = labelledGraders.filter((grader) => grader.passed).length;
	const citationRate = labelled ? citedExpected.length / rawExpected.length : null;
	const groundingPassRate = labelled ? groundingPasses / labelledGraders.length : null;
	const measurement: RagMeasurementCounts = {
		evaluatedSearches,
		hitSearches,
		reciprocalRankSum,
		expectedSources: rawExpected.length,
		citedExpectedSources: citedExpected.length,
		groundingGraders: labelledGraders.length,
		groundingPasses,
		measuredSearchLatencies,
		searchLatencyMs,
		scoredHits,
		totalHits,
	};
	return {
		labelStatus: labelled ? "available" : "missing",
		expectedChunkIds: rawExpected.slice(0, MAX_RAG_XRAY_CHUNK_IDS)
			.map((id) => boundedText(id, MAX_CHUNK_ID_CHARS)),
		searchCount: allCalls.length,
		omittedSearchCount: Math.max(0, allCalls.length - searches.length),
		searches,
		retrievedChunkIds: [...retrieved].slice(0, MAX_RAG_XRAY_CHUNK_IDS)
			.map((id) => boundedText(id, MAX_CHUNK_ID_CHARS)),
		citedChunkIds: [...cited].slice(0, MAX_RAG_XRAY_CHUNK_IDS)
			.map((id) => boundedText(id, MAX_CHUNK_ID_CHARS)),
		hitAtK: labelled && evaluatedSearches > 0 ? hitSearches / evaluatedSearches : null,
		mrr: labelled && evaluatedSearches > 0 ? reciprocalRankSum / evaluatedSearches : null,
		citationRate,
		groundingPassRate,
		retrievalLatencyMs: allCalls.length > 0 && measuredSearchLatencies === allCalls.length
			? searchLatencyMs
			: null,
		retrievalCostUsd: allCalls.length > 0 ? 0 : null,
		scoreCoverage: totalHits > 0 ? scoredHits / totalHits : null,
		diagnosis: diagnosis({
			labelled,
			searchCount: allCalls.length,
			evaluatedSearches,
			hitSearches,
			citationRate,
			groundingPassRate,
		}),
		faithfulness: "not-measured",
		measurement,
	};
}

/** Aggregate only the additive counts; averaging already-averaged runs would bias small runs. */
export function summarizeRagXray(runs: readonly (RagRunXray | null)[]): RagEvalXray | null {
	const applicable = runs.filter((run): run is RagRunXray => run !== null);
	if (applicable.length === 0) return null;
	const totals = applicable.reduce((sum, run) => ({
		evaluatedSearches: sum.evaluatedSearches + run.measurement.evaluatedSearches,
		hitSearches: sum.hitSearches + run.measurement.hitSearches,
		reciprocalRankSum: sum.reciprocalRankSum + run.measurement.reciprocalRankSum,
		expectedSources: sum.expectedSources + run.measurement.expectedSources,
		citedExpectedSources: sum.citedExpectedSources + run.measurement.citedExpectedSources,
		groundingGraders: sum.groundingGraders + run.measurement.groundingGraders,
		groundingPasses: sum.groundingPasses + run.measurement.groundingPasses,
		measuredSearchLatencies: sum.measuredSearchLatencies + run.measurement.measuredSearchLatencies,
		searchLatencyMs: sum.searchLatencyMs + run.measurement.searchLatencyMs,
		scoredHits: sum.scoredHits + run.measurement.scoredHits,
		totalHits: sum.totalHits + run.measurement.totalHits,
	}), {
		evaluatedSearches: 0,
		hitSearches: 0,
		reciprocalRankSum: 0,
		expectedSources: 0,
		citedExpectedSources: 0,
		groundingGraders: 0,
		groundingPasses: 0,
		measuredSearchLatencies: 0,
		searchLatencyMs: 0,
		scoredHits: 0,
		totalHits: 0,
	});
	const searchCount = applicable.reduce((sum, run) => sum + run.searchCount, 0);
	const diagnoses: Partial<Record<RagDiagnosis, number>> = {};
	for (const run of applicable) diagnoses[run.diagnosis] = (diagnoses[run.diagnosis] ?? 0) + 1;
	return {
		applicableRuns: applicable.length,
		labelledRuns: applicable.filter((run) => run.labelStatus === "available").length,
		searchCount,
		omittedSearchCount: applicable.reduce((sum, run) => sum + run.omittedSearchCount, 0),
		evaluatedSearches: totals.evaluatedSearches,
		hitAtK: totals.evaluatedSearches > 0 ? totals.hitSearches / totals.evaluatedSearches : null,
		mrr: totals.evaluatedSearches > 0 ? totals.reciprocalRankSum / totals.evaluatedSearches : null,
		citationRate: totals.expectedSources > 0 ? totals.citedExpectedSources / totals.expectedSources : null,
		groundingPassRate: totals.groundingGraders > 0 ? totals.groundingPasses / totals.groundingGraders : null,
		meanSearchLatencyMs: totals.measuredSearchLatencies > 0
			? totals.searchLatencyMs / totals.measuredSearchLatencies
			: null,
		retrievalCostUsd: searchCount > 0 ? 0 : null,
		scoreCoverage: totals.totalHits > 0 ? totals.scoredHits / totals.totalHits : null,
		diagnoses,
		faithfulness: "not-measured",
	};
}

function delta(before: number | null, after: number | null): number | null {
	return before === null || after === null ? null : after - before;
}

/** Matchedness is enforced by the caller's canonical comparison; this only projects deltas. */
export function compareRagXray(
	baselineRuns: readonly (RagRunXray | null)[],
	candidateRuns: readonly (RagRunXray | null)[],
): RagXrayComparison | null {
	const baseline = summarizeRagXray(baselineRuns);
	const candidate = summarizeRagXray(candidateRuns);
	if (!baseline || !candidate) return null;
	return {
		baseline,
		candidate,
		delta: {
			hitAtK: delta(baseline.hitAtK, candidate.hitAtK),
			mrr: delta(baseline.mrr, candidate.mrr),
			citationRate: delta(baseline.citationRate, candidate.citationRate),
			groundingPassRate: delta(baseline.groundingPassRate, candidate.groundingPassRate),
			meanSearchLatencyMs: delta(baseline.meanSearchLatencyMs, candidate.meanSearchLatencyMs),
			scoreCoverage: delta(baseline.scoreCoverage, candidate.scoreCoverage),
		},
	};
}
