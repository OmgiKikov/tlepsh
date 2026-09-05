import { percent, points } from "../measurement.js";
import type { ExecutiveVersionCard, VersionCardFact, VersionCardArtifactInput } from "../application/executive-version-card.js";
import { language, plural, t, tokenLabel } from "../i18n.js";
import { h } from "./pages.js";

const money = (value: number | null) => value === null ? t("metrics.not-reported") : `$${value.toFixed(4)}`;
const ratio = (value: number | null) => value === null ? t("metrics.not-reported") : `${value.toFixed(2)}×`;
const missing = (fact: { reason: string }) => `<p class="muted">${h(t("version-card.unknown", { reason: fact.reason }))}</p>`;

function metric(label: string, value: string): string {
	return `<div class="metric"><span>${h(label)}</span><strong>${h(value)}</strong></div>`;
}

function validation(card: ExecutiveVersionCard): string {
	if (card.validation.status === "unknown") return missing(card.validation);
	const value = card.validation.value;
	const surface = value.context.status === "known"
		? tokenLabel("version-card.surface", value.context.value.surface)
		: t("version-card.surface.unknown");
	return `<p class="eyebrow">${h(surface)} · ${h(plural(value.design.tasks, "case"))} × ${value.design.repetitions}</p>
	<div class="metrics">${metric(t("release.html.before"), percent(value.baseline.score))}${metric(t("release.html.after"), percent(value.candidate.score))}${metric(t("release.html.delta"), points(value.scoreDelta))}</div>
	<p class="muted">${h(t("release.html.confidence"))}: ${h(points(value.confidence95.low))} … ${h(points(value.confidence95.high))}</p>
	<p>${h(t("version-card.pass-rate"))}: <b>${percent(value.baseline.passRate)} → ${percent(value.candidate.passRate)}</b>${value.design.excludedTasks ? ` · ${h(t("version-card.excluded", { count: value.design.excludedTasks }))}` : ""}</p>`;
}

function sealed(card: ExecutiveVersionCard): string {
	if (card.sealed.status === "unknown") return missing(card.sealed);
	const value = card.sealed.value;
	const result = value.outcome === "improved" ? t("version-card.sealed.improved")
		: value.outcome === "no-regression" ? t("version-card.sealed.no-regression") : tokenLabel("verdict", value.verdict);
	return `<p class="finding">${h(result)}</p><p>${h(plural(value.design.tasks, "case"))} × ${value.design.repetitions}</p>
	<p class="muted">${h(t("release.html.sealed-note"))}</p>`;
}

function regressions(card: ExecutiveVersionCard): string {
	if (card.regressions.status === "unknown") return missing(card.regressions);
	const value = card.regressions.value;
	return `<div class="metrics">${metric(t("release.html.regressed-cases"), String(value.tasks))}${metric(t("release.html.new-failures"), String(value.newFailureModes))}${metric(t("release.html.unresolved"), String(value.targetedUnresolved))}</div>
	<p class="muted">${h(t("release.html.worsened", { count: value.worsenedFailureModes }))}</p>`;
}

function capabilities(card: ExecutiveVersionCard): string {
	if (card.capabilities.status === "unknown") return missing(card.capabilities);
	const value = card.capabilities.value;
	if (value.rows.length === 0) return `<p class="muted">${h(t("version-card.none-measured"))}</p>`;
	return `<div class="scroll"><table><thead><tr><th>${h(t("version-card.capabilities"))}</th><th>${h(t("release.html.before"))}</th><th>${h(t("release.html.after"))}</th></tr></thead><tbody>${value.rows.map(row => `<tr><td>${h(tokenLabel("version-card.check", row.check))}${row.subject ? ` <code>${h(row.subject)}</code>` : ""}</td><td>${row.baselinePassed}/${row.tasks}</td><td>${row.candidatePassed}/${row.tasks}</td></tr>`).join("")}</tbody></table></div>${value.omitted ? `<p class="muted">${h(t("version-card.more", { count: value.omitted }))}</p>` : ""}`;
}

function resources(card: ExecutiveVersionCard): string {
	const { arms, ratios } = card.resources;
	const absolute = arms.status === "known"
		? `<div class="metrics resource-metrics">${metric(t("release.html.total-cost"), `${money(arms.value.baseline.costUsd)} → ${money(arms.value.candidate.costUsd)}`)}${metric(t("release.html.mean-latency"), `${Math.round(arms.value.baseline.meanLatencyMs)} → ${Math.round(arms.value.candidate.meanLatencyMs)} ms`)}</div>`
		: missing(arms);
	return absolute + (ratios.status === "known" ? `<p class="muted">${h(t("release.html.per-answer"))}: ${h(t("version-card.cost"))} ${h(ratio(ratios.value.cost))} · ${h(t("version-card.latency"))} ${h(ratio(ratios.value.latency))} · ${h(t("version-card.tokens"))} ${h(ratio(ratios.value.tokens))}</p>` : missing(ratios));
}

function change(card: ExecutiveVersionCard): string {
	if (card.change.status === "unknown") return missing(card.change);
	const value = card.change.value;
	return `<p class="finding">${h(value.summary)}</p><p class="muted">${h(plural(value.files, "file"))} · +${value.addedLines} / −${value.removedLines}</p>
	<details><summary>${h(t("release.html.exact-diff"))}</summary><pre>${h(value.exactDiff)}</pre></details>`;
}

function artifact(label: string, fact: VersionCardFact<VersionCardArtifactInput>): string {
	if (fact.status === "unknown") return `<div><h3>${h(label)}</h3>${missing(fact)}</div>`;
	const value = fact.value;
	// Reports live in exports/. Links may only name sibling project artifacts,
	// never a URL, an absolute path, or traversal supplied as display metadata.
	const parts = value.path.split("/");
	const safe = parts.every(part => part.length > 0 && part !== "." && part !== "..") && !/[\\:\u0000-\u001f]/u.test(value.path);
	const name = safe ? `<a download href="../${h(parts.map(encodeURIComponent).join("/"))}">${h(label)} ↗</a>` : h(label);
	return `<div><h3>${name}</h3><p class="muted">${h(value.path)} · ${value.bytes.toLocaleString("en-US")} B</p><code class="hash">${h(value.sha256)}</code></div>`;
}

/** A portable, offline release report built only from the verified card projection. */
export function renderVersionCardHtml(card: ExecutiveVersionCard): string {
	const good = card.decision.code === "improvement-proved" || card.decision.code === "no-regression-proved";
	const tone = good ? "good" : card.decision.code === "sealed-failed" ? "bad" : "caution";
	const title = t("version-card.title", { agent: card.release.agent, version: card.release.version });
	return `<!doctype html>
<html lang="${language()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${h(title)}</title><style>
:root{color-scheme:light;--ink:#182e2b;--muted:#576b66;--line:#d9e2dc;--paper:#fafbf8;--accent:#176849}

*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1120px;margin:auto;padding:42px 36px 72px}
header{display:flex;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:20px;gap:16px;font-size:13px}
.brand{font-weight:800;letter-spacing:.18em}
.muted,small{color:var(--muted)}
.hero{padding:52px 0 38px}
.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
h1{font-size:clamp(34px,5vw,60px);letter-spacing:-.045em;line-height:1.12;margin:16px 0 24px;font-weight:650;max-width:900px}
h2{font-size:18px;margin:0 0 22px}
h3{font-size:16px;margin:0 0 8px}
p{margin:12px 0}
.badge{display:inline-block;border:1px solid;border-radius:5px;padding:7px 13px;font-size:14px}
.good{color:#176849;background:#eaf4eb;border-color:#a7cbb3}
.caution{color:#76551a;background:#fff6df;border-color:#dfc784}
.bad{color:#9a3434;background:#fff0ec;border-color:#e2b3a8}
.grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:20px}
.panel{min-width:0;border:1px solid var(--line);border-radius:10px;padding:28px;background:white}
.wide{grid-column:1/-1}
.metrics{display:flex;flex-wrap:wrap;gap:20px 32px}
.metric{flex:1;min-width:90px}
.metric span,.metric small{display:block;font-size:13px;color:var(--muted)}
.metric strong{display:block;font-size:clamp(24px,3vw,38px);font-weight:550;letter-spacing:-.04em;font-variant-numeric:tabular-nums;line-height:1.3;margin-top:8px}
.resource-metrics{display:grid;gap:18px}
.resource-metrics .metric strong{font-size:24px}
.finding{font-size:23px;line-height:1.4;letter-spacing:-.02em}
a{color:var(--accent);text-underline-offset:4px}
a:focus-visible,summary:focus-visible{outline:3px solid #176849;outline-offset:5px}
summary{cursor:pointer;color:var(--accent);font-weight:600;padding:12px 0}
details{border-top:1px solid var(--line);margin-top:22px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.7;background:#f3f6f2;padding:20px;border-radius:6px}
code{font:12px/1.6 ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere}
.hash{display:block;color:var(--muted)}
.scroll{overflow:auto}
table{width:100%;border-collapse:collapse;text-align:left;font-size:14px}
th{color:var(--muted);font-size:12px;font-weight:500}
th,td{padding:12px 8px;border-bottom:1px solid var(--line)}
td:first-child{overflow-wrap:anywhere}
th:not(:first-child),td:not(:first-child){text-align:right;white-space:nowrap}
.artifacts{display:grid;grid-template-columns:1fr 1fr;gap:28px}
.artifacts>div{min-width:0;overflow-wrap:anywhere}
footer{padding-top:30px;font-size:12px;color:var(--muted)}
footer code{display:block}
li{margin:8px 0}

@media(max-width:720px){main{padding:24px 18px 40px}
.hero{padding:34px 0}
.grid,.artifacts{grid-template-columns:1fr}
.panel{padding:22px}
.wide{grid-column:auto}
.metric strong{font-size:27px}
header{flex-wrap:wrap}
.finding{font-size:20px}
}

@media print{body{background:white}
main{max-width:none;padding:0}
.hero{padding:24px 0}
h1{font-size:32px}
.panel{break-inside:avoid;padding:18px}
.grid{gap:12px}
a{color:inherit}
footer{break-inside:avoid}
}

</style></head><body><main>
<header><span class="brand">AHDE / ${h(t("release.html.report"))}</span><span class="muted">${h(card.release.at.slice(0, 10))}</span></header>
<section class="hero"><div class="eyebrow">${h(card.release.agent)} · ${h(card.release.version)}</div><h1>${h(tokenLabel("version-card.decision", card.decision.code))}</h1><span class="badge ${tone}">${h(t("release.html.evidence-bound"))}</span></section>
<div class="grid">
<section class="panel"><h2>01 / ${h(t("version-card.validation"))}</h2>${validation(card)}</section>
<section class="panel"><h2>02 / ${h(t("version-card.sealed"))}</h2>${sealed(card)}</section>
<section class="panel"><h2>03 / ${h(t("version-card.change"))}</h2>${change(card)}</section>
<section class="panel"><h2>04 / ${h(t("version-card.regressions"))}</h2>${regressions(card)}</section>
<section class="panel"><h2>05 / ${h(t("version-card.capabilities"))}</h2>${capabilities(card)}</section>
<section class="panel"><h2>06 / ${h(t("version-card.resources"))}</h2>${resources(card)}</section>
${card.warnings.length ? `<section class="panel wide"><h2>${h(t("version-card.warnings"))}</h2><ul>${card.warnings.map(item => `<li>${h(item)}</li>`).join("")}</ul></section>` : ""}
<section class="panel wide"><h2>${h(t("version-card.artifacts"))}</h2><div class="artifacts">${artifact(t("version-card.passport"), card.artifacts.passport)}${artifact(t("version-card.dataset"), card.artifacts.dataset)}</div><p class="muted">${h(t("release.html.artifacts-note"))}</p></section>
</div><footer>${h(t("release.html.revisions"))}<code>${h(card.release.baselineSha)} → ${h(card.release.candidateSha)}</code><p>${h(t("release.html.offline"))}</p></footer>
</main></body></html>`;
}
