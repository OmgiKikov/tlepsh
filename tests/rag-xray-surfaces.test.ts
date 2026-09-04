import { afterEach, describe, expect, it } from "vitest";
import { projectRagRunXray } from "../src/application/rag-xray.js";
import { renderRagXrayLines, renderTracePanel } from "../src/builder/render/trace.js";
import { stripMarkers } from "../src/builder/render/markers.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { renderRagXray, renderRunDetailPage, type RunDetailPageModel } from "../src/evidence/pages.js";
import type { RunRecord } from "../src/provenance.js";
import type { TraceMessage } from "../src/trace.js";
import { setLanguage, tokenLabel } from "../src/i18n.js";

const CHUNK_BODY = "NEVER_RENDER_THE_CHUNK_BODY";
const SOURCE = "blocking.md#0";

afterEach(() => setLanguage(null));

function xray() {
	const payload = JSON.stringify({
		schemaVersion: 1,
		chunks: [{
			rank: 1,
			id: SOURCE,
			path: "kb/<script>alert(1)</script>.md",
			score: 4.25,
			text: CHUNK_BODY,
		}],
	});
	const messages: TraceMessage[] = [
		{ role: "assistant", text: "", toolCalls: [{ id: "search-1", name: "kb_search", arguments: { query: "when is access restored", k: 3 } }], timestamp: 100 },
		{ role: "toolResult", text: payload, toolResult: { toolCallId: "search-1", toolName: "kb_search", text: payload, isError: false }, timestamp: 125 },
		{ role: "assistant", text: `15 minutes. Source: ${SOURCE}`, timestamp: 140 },
	];
	return projectRagRunXray({
		evalResults: {
			outcome: "pass",
			graders: [{
				name: "source",
				type: "cites_source",
				passed: true,
				score: 1,
				reason: "source cited",
				specHash: `sha256:${"a".repeat(64)}`,
				checkCode: "cites-source",
				checkSubject: SOURCE,
			}],
		},
	} satisfies Pick<RunRecord, "evalResults">, messages)!;
}

function detail(rag = xray()): RunDetailPageModel {
	return {
		evalRunId: "erun-rag",
		targetId: "rag-agent",
		revision: "a".repeat(40),
		label: "candidate",
		run: {
			runId: "run-rag",
			taskId: "task-rag",
			repetitionIndex: 0,
			outcome: "pass",
			status: "completed",
			startedAt: "2026-09-04T10:00:00.000Z",
			finishedAt: "2026-09-04T10:00:00.140Z",
			error: null,
			metrics: { latencyMs: 140, toolCalls: 1, reportedToolCalls: 0, toolErrors: 0, tokens: 20, costUsd: 0 },
		},
		input: "When is access restored?",
		receipt: { worldKeys: null, judge: null, simulatedUser: null, tokens: 20, costUsd: 0, incomplete: false },
		transcript: null,
		traceNotice: "Trace intentionally omitted from this surface fixture.",
		graders: [],
		explanation: {
			runId: "run-rag",
			taskId: "task-rag",
			repetitionIndex: 0,
			outcome: "pass",
			headline: "task-rag passed.",
			error: null,
			graders: [],
			failureModes: [],
			judgeAbstained: 0,
			flip: null,
			rag,
			sentences: ["task-rag passed."],
		},
		prev: null,
		next: null,
	};
}

describe("RAG X-ray surfaces", () => {
	it("renders a compact escaped Evidence Explorer panel without chunk bodies", () => {
		setLanguage("en");
		const html = renderRagXray(xray());
		expect(html).toContain("Retrieval diagnosis: retrieved and cited");
		expect(html).toContain("Hit@k 100%");
		expect(html).toContain("when is access restored");
		expect(html).toContain(SOURCE);
		expect(html).toContain("kb/&lt;script&gt;alert(1)&lt;/script&gt;.md");
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).not.toContain(CHUNK_BODY);

		const page = renderRunDetailPage(detail());
		expect(page).toContain("<h2>RAG X-ray</h2>");
		expect(page).toContain("Faithfulness: not measured");
		expect(page).not.toContain(CHUNK_BODY);
	});

	it("renders the same evidence in Builder /trace and keeps legacy runs unchanged", () => {
		setLanguage("en");
		const lines = renderRagXrayLines(xray(), plainPaint).map(stripMarkers);
		const text = lines.join("\n");
		expect(text).toContain("RAG X-ray");
		expect(text).toContain("retrieved and cited");
		expect(text).toContain("Hit@k 100%");
		expect(text).toContain(SOURCE);
		expect(text).not.toContain(CHUNK_BODY);
		for (const line of lines) expect([...line].length).toBeLessThanOrEqual(120);

		const panel = renderTracePanel(detail(), plainPaint).map(stripMarkers).join("\n");
		expect(panel).toContain("RAG X-ray");
		const legacy = detail();
		legacy.explanation.rag = null;
		expect(renderTracePanel(legacy, plainPaint).map(stripMarkers).join("\n")).not.toContain("RAG X-ray");
	});

	it("renders every RAG label and diagnosis in Russian on both surfaces", () => {
		setLanguage("ru");
		const html = renderRagXray(xray());
		expect(html).toContain("Диагноз поиска: источник найден и указан");
		expect(html).toContain("1 поиск");
		expect(html).toContain("цитирование 100%");
		expect(html).toContain("Ожидались");
		expect(html).toContain("Найдены");
		expect(html).toContain("Упомянуты");
		expect(html).toContain("Поиск 1 · готово");
		expect(html).toContain("Запрос");
		expect(html).toContain("Фрагмент");
		expect(html).toContain("Пересечение с ответом");
		for (const english of ["Retrieval diagnosis", "Expected", "Retrieved", "Cited", "Search 1", "Query", "Chunk", "Answer overlap", "Faithfulness"]) {
			expect(html).not.toContain(english);
		}

		const terminal = renderRagXrayLines(xray(), plainPaint).map(stripMarkers).join("\n");
		expect(terminal).toContain("RAG: рентген поиска");
		expect(terminal).toContain("Диагноз поиска: источник найден и указан");
		expect(terminal).toContain("Поиск 1 · готово");
		expect(terminal).toContain("Запрос: when is access restored");
		expect(terminal).toContain("оценка 4.250");
		expect(terminal).toContain("ожидался,указан");
		expect(terminal).not.toContain("retrieved-and-cited");
		expect(terminal).not.toContain("search(es)");

		for (const diagnosis of [
			"unlabelled",
			"retrieval-bypassed",
			"retrieval-unknown",
			"retrieval-miss",
			"answer-grounding-miss",
			"retrieved-and-supported",
			"retrieved-and-cited",
			"mixed",
		]) expect(tokenLabel("rag.diagnosis", diagnosis)).not.toBe(diagnosis);
		for (const status of ["ok", "error", "missing-result", "unreadable"]) {
			expect(tokenLabel("rag.search-status", status)).not.toBe(status);
		}
	});
});
