import type { RunReading } from "../application/run-reading.js";
import { t } from "../i18n.js";
import { redactTraceText } from "../trace.js";
import { h } from "./pages.js";

/** A title is a bounded quotation of a verified input, never an invented case name. */
export function conversationTitle(input: string | null | undefined, fallback: string): string {
	const text = redactTraceText(input?.trim().replace(/\s+/g, " ") || fallback);
	return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** Historical facts remain readable; these commands create separate records in the terminal. */
export function renderHistoricalEvaluation(
	history: { evaluatorId: string; currentEvaluatorId: string } | undefined,
	evalRunIds: readonly string[],
): string {
	if (!history) return "";
	return `<aside class="finding historical" aria-label="${h(t("conversation.historical"))}"><h2>${h(t("conversation.historical"))}</h2><p>${h(t("conversation.historicalMeaning"))}</p><details><summary>${h(t("conversation.historicalAction"))}</summary><p>${h(t("conversation.historicalRules", { before: history.evaluatorId, after: history.currentEvaluatorId }))}</p>${evalRunIds.map((id) => `<pre><code>${h(`/regrade ${id} target`)}</code></pre>`).join("")}<p class="note">${h(t("conversation.historicalLimit"))}</p></details></aside>`;
}

export function renderCaseExpectation(...readings: Array<RunReading | undefined>): string {
	const expectations = [...new Set(readings.flatMap((reading) => reading?.expectations ?? []))].slice(0, 3);
	return `<div class="case-expectation"><h3>${h(t("conversation.expected"))}</h3>${expectations.length
		? expectations.map((line) => `<p>${h(line)}</p>`).join("") : `<p class="note">${h(t("conversation.expectedDetails"))}</p>`}</div>`;
}

export function renderReadingObservations(reading: RunReading | undefined): string {
	if (!reading) return "";
	return `<div class="case-observation"><p><b>${h(reading.title)}</b></p>${reading.observations.map((line) => `<p>${h(line)}</p>`).join("")}</div>`;
}

/** Both meanings come from the same canonical facts used by the terminal. */
export function renderPairReading(before: RunReading | undefined, after: RunReading | undefined): string {
	if (!before && !after) return "";
	const arm = (reading: RunReading | undefined, label: string) => `<div class="card"><h3>${h(label)}</h3>${renderReadingObservations(reading)}${reading?.answerQuote
		? `<blockquote><p class="answer">${h(reading.answerQuote.text)}</p>${reading.answerQuote.clipped ? `<p class="note">${h(t("reading.quotedClip"))}</p>` : ""}</blockquote>` : ""}</div>`;
	const limits = [...new Set([...(before?.uncertainties ?? []), ...(after?.uncertainties ?? [])])];
	return `<section class="case-story" aria-label="${h(t("conversation.story"))}">${renderCaseExpectation(before, after)}<div class="pair">${arm(before, t("conversation.before"))}${arm(after, t("conversation.after"))}</div><details class="metadata"><summary>${h(t("reading.uncertain"))}</summary>${limits.map((line) => `<p class="note">${h(line)}</p>`).join("")}</details></section>`;
}
