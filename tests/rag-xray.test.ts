import { describe, expect, it } from "vitest";
import {
	compareRagXray,
	MAX_RAG_XRAY_SEARCHES,
	projectRagRunXray,
	summarizeRagXray,
} from "../src/application/rag-xray.js";
import { explainRun } from "../src/application/run-explanation.js";
import type { RunRecord } from "../src/provenance.js";
import type { TraceMessage } from "../src/trace.js";

const HASH = `sha256:${"a".repeat(64)}`;

function runWithSource(
	source: string | null,
	passed = true,
): Pick<RunRecord, "evalResults"> {
	return {
		evalResults: {
			outcome: passed ? "pass" : "fail",
			graders: [{
				name: "source",
				type: "cites_source",
				passed,
				score: passed ? 1 : 0,
				reason: passed ? "source used" : "source missing",
				specHash: HASH,
				checkCode: "cites-source",
				...(source === null ? {} : { checkSubject: source }),
			}],
		},
	};
}

function searchTrace(options: {
	payload: string;
	answer?: string;
	query?: string;
	k?: number;
	evidence?: "reported";
	isError?: boolean;
}): TraceMessage[] {
	return [
		{ role: "user", text: "Когда восстановят доступ?", timestamp: 1_000 },
		{
			role: "assistant",
			text: "",
			toolCalls: [{
				id: "search-1",
				name: "kb_search",
				arguments: { query: options.query ?? "пополнение восстановление минут", k: options.k ?? 3 },
				...(options.evidence ? { evidence: options.evidence } : {}),
			}],
			timestamp: 1_100,
		},
		{
			role: "toolResult",
			text: options.payload,
			toolResult: {
				toolCallId: "search-1",
				toolName: "kb_search",
				text: options.payload,
				isError: options.isError ?? false,
			},
			timestamp: 1_150,
		},
		{ role: "assistant", text: options.answer ?? "В течение 15 минут.", timestamp: 1_200 },
	];
}

describe("the RAG X-ray projection", () => {
	it("travels with the shared run explanation only when verified messages are supplied", () => {
		const run = {
			...runWithSource("blocking.md#0"),
			runId: "run-rag",
			taskId: "task-rag",
			repetitionIndex: 0,
			status: "completed",
			error: null,
		} as RunRecord;
		const messages = searchTrace({
			payload: JSON.stringify({
				schemaVersion: 1,
				chunks: [{ rank: 1, id: "blocking.md#0", path: "blocking.md", score: 2, text: "15 минут" }],
			}),
			answer: "15 минут, источник blocking.md#0",
		});
		const withoutTrace = explainRun({ run, graders: [], facts: null, modes: [], flip: null });
		const withTrace = explainRun({ run, graders: [], facts: null, messages, modes: [], flip: null });
		expect(withoutTrace.rag).toBeNull();
		expect(withTrace.rag).toMatchObject({ diagnosis: "retrieved-and-cited", hitAtK: 1, mrr: 1 });
	});

	it("shows the query, recorded rank/score, expected-source MRR, citation, overlap, latency and cost", () => {
		const payload = JSON.stringify({
			schemaVersion: 1,
			chunks: [
				{ rank: 1, id: "tariffs.md#0", path: "tariffs.md", score: 4.2, text: "Тариф стоит 500 рублей." },
				{ rank: 2, id: "blocking.md#0", path: "blocking.md", score: 3.1, text: "После пополнения доступ восстановится в течение 15 минут." },
			],
		});
		const xray = projectRagRunXray(
			runWithSource("blocking.md#0"),
			searchTrace({ payload, answer: "Доступ восстановится в течение 15 минут. Источник: blocking.md#0" }),
		);
		expect(xray).not.toBeNull();
		expect(xray).toMatchObject({
			labelStatus: "available",
			expectedChunkIds: ["blocking.md#0"],
			searchCount: 1,
			hitAtK: 1,
			mrr: 0.5,
			citationRate: 1,
			groundingPassRate: 1,
			retrievalLatencyMs: 50,
			retrievalCostUsd: 0,
			scoreCoverage: 1,
			diagnosis: "retrieved-and-cited",
			faithfulness: "not-measured",
		});
		expect(xray?.searches[0]).toMatchObject({
			query: "пополнение восстановление минут",
			requestedK: 3,
			status: "ok",
			hitAtK: 1,
			reciprocalRank: 0.5,
		});
		expect(xray?.searches[0]?.hits[1]).toMatchObject({
			rank: 2,
			chunkId: "blocking.md#0",
			score: 3.1,
			expected: true,
			cited: true,
		});
		expect(xray?.searches[0]?.hits[1]?.answerOverlap).toBeGreaterThan(0);
	});

	it("keeps legacy result order while rendering missing scores as unknown", () => {
		const payload = JSON.stringify({
			chunks: [{ id: "blocking.md#0", path: "blocking.md", text: "Доступ восстановится за 15 минут." }],
		});
		const xray = projectRagRunXray({ evalResults: null }, searchTrace({ payload }));
		expect(xray).toMatchObject({
			labelStatus: "missing",
			hitAtK: null,
			mrr: null,
			scoreCoverage: 0,
			diagnosis: "unlabelled",
		});
		expect(xray?.searches[0]?.hits[0]).toMatchObject({ rank: 1, score: null });
	});

	it("counts a labelled no-search run as a bypass, without inventing latency or cost", () => {
		const xray = projectRagRunXray(
			runWithSource("blocking.md#0", false),
			[
				{ role: "user", text: "Когда восстановят доступ?", timestamp: 1_000 },
				{ role: "assistant", text: "Не знаю.", timestamp: 1_100 },
			],
		);
		expect(xray).toMatchObject({
			searchCount: 0,
			hitAtK: 0,
			mrr: 0,
			retrievalLatencyMs: null,
			retrievalCostUsd: null,
			diagnosis: "retrieval-bypassed",
		});
	});

	it("does not turn an unreadable or agent-reported result into measured retrieval evidence", () => {
		const unreadable = projectRagRunXray(
			runWithSource("blocking.md#0", false),
			searchTrace({ payload: "not json" }),
		);
		expect(unreadable).toMatchObject({
			searchCount: 1,
			hitAtK: null,
			mrr: null,
			diagnosis: "retrieval-unknown",
		});
		expect(unreadable?.searches[0]?.status).toBe("unreadable");

		const reported = projectRagRunXray(
			runWithSource("blocking.md#0", false),
			searchTrace({ payload: JSON.stringify({ chunks: [] }), evidence: "reported" }),
		);
		expect(reported).toMatchObject({ searchCount: 0, diagnosis: "retrieval-bypassed" });
	});

	it("bounds detail rows while keeping exact aggregate counts", () => {
		const messages: TraceMessage[] = [];
		for (let index = 0; index < MAX_RAG_XRAY_SEARCHES + 3; index += 1) {
			messages.push({
				role: "assistant",
				text: "",
				toolCalls: [{ id: `call-${index}`, name: "kb_search", arguments: { query: `q${index}` } }],
				timestamp: index * 10,
			});
			const payload = JSON.stringify({ schemaVersion: 1, chunks: [] });
			messages.push({
				role: "toolResult",
				text: payload,
				toolResult: { toolCallId: `call-${index}`, toolName: "kb_search", text: payload, isError: false },
				timestamp: index * 10 + 1,
			});
		}
		const xray = projectRagRunXray({ evalResults: null }, messages);
		expect(xray?.searchCount).toBe(MAX_RAG_XRAY_SEARCHES + 3);
		expect(xray?.searches).toHaveLength(MAX_RAG_XRAY_SEARCHES);
		expect(xray?.omittedSearchCount).toBe(3);
		expect(xray?.measurement.measuredSearchLatencies).toBe(MAX_RAG_XRAY_SEARCHES + 3);
	});

	it("aggregates exact counts and projects baseline-to-candidate deltas", () => {
		const baseline = projectRagRunXray(
			runWithSource("blocking.md#0", false),
			[{ role: "assistant", text: "Не знаю." }],
		);
		const candidate = projectRagRunXray(
			runWithSource("blocking.md#0"),
			searchTrace({
				payload: JSON.stringify({
					schemaVersion: 1,
					chunks: [{ rank: 1, id: "blocking.md#0", path: "blocking.md", score: 2, text: "15 минут" }],
				}),
				answer: "15 минут, источник blocking.md#0",
			}),
		);
		const summary = summarizeRagXray([baseline, candidate]);
		expect(summary).toMatchObject({
			applicableRuns: 2,
			labelledRuns: 2,
			evaluatedSearches: 2,
			hitAtK: 0.5,
			mrr: 0.5,
			citationRate: 0.5,
			groundingPassRate: 0.5,
		});
		const comparison = compareRagXray([baseline], [candidate]);
		expect(comparison?.delta).toMatchObject({
			hitAtK: 1,
			mrr: 1,
			citationRate: 1,
			groundingPassRate: 1,
		});
	});
});
