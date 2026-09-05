import { runReadingChange, type RunReading } from "../application/run-reading.js";
import { t } from "../i18n.js";
import { h } from "./pages.js";

/** Recorded meaning first; exact checks, identities and the whole transcript remain one step away. */
export function renderRunReading(reading: RunReading): string {
	const comparison = reading.comparison;
	const change = runReadingChange(reading);
	return `<section class="w-reading" aria-label="${h(t("reading.eyebrow"))}">
<p class="w-eyebrow">${h(t("reading.eyebrow"))}</p><h3>${h(reading.title)}</h3>
${reading.answerQuote ? `<blockquote><span>${h(t("reading.answer"))}</span><p>“${h(reading.answerQuote.text)}”</p>${reading.answerQuote.clipped ? `<small>${h(t("reading.quotedClip"))}</small>` : ""}</blockquote>` : ""}
${reading.observations.length ? `<div class="w-reading-observed"><h4>${h(t("reading.observed"))}</h4>${reading.observations.map((line) => `<p>${h(line)}</p>`).join("")}</div>` : ""}
${reading.expectations.length || reading.checks.length ? `<details><summary>${h(t("reading.openChecks"))}</summary>${reading.expectations.length ? `<h4>${h(t("reading.expected"))}</h4>${reading.expectations.map((line) => `<p>${h(line)}</p>`).join("")}` : ""}${reading.checks.map((check) => `<p class="w-reading-reason"><span>${h(check.name)}</span><q>${h(check.reason)}</q></p>`).join("")}</details>` : ""}
<div class="w-reading-change"><h4>${h(t("reading.change"))}</h4><p>${h(change)}${comparison ? ` <a href="/candidates/${encodeURIComponent(comparison.candidateId)}">${h(t("evidence.replayOverview"))} →</a>` : ""}</p></div>
${reading.uncertainties.length ? `<div class="w-reading-limit"><h4>${h(t("reading.uncertain"))}</h4>${reading.uncertainties.map((line) => `<p>${h(line)}</p>`).join("")}</div>` : ""}
</section>`;
}
