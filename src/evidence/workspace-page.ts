import type { RunRow } from "../application/run-explanation.js";
import { duration, money, percent } from "../measurement.js";
import { t, tokenLabel } from "../i18n.js";
import {
	h, graderChips, outcomeChip, renderPage, renderRagXray, renderTranscript, renderVerdict, renderWhy,
	type EvalPageModel, type RunDetailPageModel,
} from "./pages.js";
import { WORKSPACE_STYLES } from "./workspace-styles.js";

/** Every control is a normal URL: reload, history and a shared link retain the investigation. */
export function workspaceHref(model: EvalPageModel, changes: { run?: string | null; mode?: string | null; outcome?: string | null; q?: string | null } = {}): string {
	const values = { mode: model.filter.mode, outcome: model.filter.outcome, q: model.search, ...changes };
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(values)) if (value) query.set(key, value);
	return `/evals/${encodeURIComponent(model.evalRunId)}${query.size ? `?${query}` : ""}`;
}

function renderIssues(model: EvalPageModel): string {
	const all = !model.filter.mode && !model.filter.outcome && !model.search;
	return `<aside class="w-issues" aria-labelledby="issues-title">
<div class="w-panel-title"><h2 id="issues-title">${h(t("workspace.issues"))}</h2><span class="w-count">${model.modes.length}</span></div>
<a class="w-all${all ? " selected" : ""}" href="${h(workspaceHref(model, { mode: null, outcome: null, q: null }))}"${all ? ' aria-current="true"' : ""}>${h(t("workspace.allIssues"))}<span>${model.summary.total}</span></a>
<ul class="w-issue-list">${model.modes.map((mode) => `<li>
<a class="w-issue${model.filter.mode === mode.id ? " selected" : ""}" href="${h(workspaceHref(model, { mode: mode.id }))}"${model.filter.mode === mode.id ? ' aria-current="true"' : ""}>
<span class="w-issue-title">${h(mode.title)}</span>
<span class="w-issue-impact">${h(t("workspace.impact", { affected: mode.affectedTasks, total: mode.totalTasks, runs: mode.runCount }))}</span>
<span class="w-issue-rate">${h(t("workspace.reproduction", { ...mode.observations, rate: percent(mode.reproductionBps / 10_000) }))}</span>
<span class="w-issue-severity">${h(tokenLabel("mode.severity", mode.severity))} · ${h(tokenLabel("mode.scope", mode.scope))}</span>
</a></li>`).join("")}</ul>
${model.modes.length === 0 ? `<p class="w-note">${h(t("evidence.noModes"))}</p>` : ""}
<p class="w-note">${h(t("workspace.issueNote"))}</p>
${model.candidates.length ? `<div class="w-comparisons"><h3>${h(t("workspace.compare"))}</h3>${model.candidates.map((candidate) => `<a href="${h(candidate.href)}">${h(candidate.candidateId)} →</a><a class="w-secondary" href="${h(`${candidate.href}/replay`)}">${h(t("evidence.replayOpen"))} →</a>`).join("")}</div>` : ""}
</aside>`;
}

function renderRowChecks(row: RunRow): string {
	if (row.graders.length === 0) return graderChips(row);
	const failed = row.graders.filter((grader) => !grader.passed);
	const passed = row.graders.length - failed.length;
	const preview = failed.length ? graderChips({ ...row, graders: failed.slice(0, 2) }) : "";
	const remainder = failed.length > 2
		? `<span class="gchip" title="${h(t("workspace.moreFailed", { count: failed.length - 2 }))}">+${failed.length - 2}</span>`
		: "";
	return `<span class="w-check-count">${h(t("workspace.checkCount", { passed, total: row.graders.length }))}</span>${preview}${remainder}`;
}

function renderRuns(model: EvalPageModel): string {
	const selected = model.selectedRun?.run.runId;
	const mode = model.modes.find((item) => item.id === model.filter.mode);
	const rows = model.rows.map((row) => `<tr data-row data-outcome="${h(row.outcome)}" data-run="${h(row.runId)}"${row.runId === selected ? ' class="selected"' : ""}>
<td class="w-case"><a class="w-run-link" href="${h(workspaceHref(model, { run: row.runId }))}#inspector"${row.runId === selected ? ' aria-current="true"' : ""}><span>${h(row.taskId)}</span><small>${h(t("explorer.repetition", { index: row.repetitionIndex + 1 }))}</small></a><p>${h(row.inputPreview ?? t("evidence.traceUnavailable"))}</p></td>
<td class="w-outcome">${outcomeChip(row.outcome)}<span class="w-score">${percent(row.score)}</span></td>
<td class="w-graders">${renderRowChecks(row)}<small>${h(t("evidence.executedCount", { count: row.metrics.toolCalls }))}${row.metrics.toolErrors ? ` · ${h(t("evidence.errorCount", { count: row.metrics.toolErrors }))}` : ""}</small></td>
<td class="w-resource">${h(duration(row.metrics.latencyMs))}<small>${h(money(row.metrics.costUsd))}</small></td>
</tr>`).join("");
	return `<section class="w-runs" aria-labelledby="runs-title" id="runs" tabindex="-1">
<div class="w-panel-title"><h2 id="runs-title">${h(t("workspace.runs"))}</h2><span class="w-count">${h(t("workspace.shown", { shown: model.rows.length, total: model.summary.total }))}</span></div>
${mode ? `<div class="w-finding"><h3>${h(mode.title)}</h3><p>${h(mode.facts)}</p>${mode.excerpt ? `<details><summary>${h(t("workspace.observed"))}</summary><p class="mono">${h(mode.excerpt)}</p></details>` : ""}</div>` : ""}
<div class="w-run-controls"><form method="get" action="/evals/${encodeURIComponent(model.evalRunId)}" class="w-search" role="search">
${model.filter.mode ? `<input type="hidden" name="mode" value="${h(model.filter.mode)}">` : ""}${model.filter.outcome ? `<input type="hidden" name="outcome" value="${h(model.filter.outcome)}">` : ""}
<input type="search" id="filter" name="q" value="${h(model.search ?? "")}" maxlength="160" placeholder="${h(t("evidence.filterPlaceholder"))}" aria-label="${h(t("evidence.filterLabel"))}" title="${h(t("workspace.searchNote"))}"><button type="submit">${h(t("workspace.search"))}</button></form>
<nav class="w-filters" aria-label="${h(t("explorer.th.outcome"))}">${model.filterLinks.map((link) => `<a href="${h(link.href)}"${link.active ? ' aria-current="true"' : ""}>${h(link.label)}</a>`).join("")}</nav></div>
<div class="w-table-scroll"><table class="w-table"><thead><tr><th>${h(t("workspace.input"))}</th><th>${h(t("workspace.result"))}</th><th>${h(t("explorer.th.graders"))}</th><th>${h(t("explorer.th.latency"))}<br>${h(t("explorer.th.cost"))}</th></tr></thead><tbody>${rows}</tbody></table>${rows ? "" : `<p class="empty">${h(t("evidence.noRuns"))}</p>`}</div>
<p class="w-note w-keyboard">${h(t("workspace.keyboard"))}</p>
</section>`;
}

function renderSequence(model: RunDetailPageModel): string {
	const entries = model.transcript?.entries ?? [];
	if (entries.length === 0) return "";
	return `<nav class="w-sequence" aria-label="${h(t("workspace.trajectory"))}">${entries.map((entry, index) => {
		const name = entry.kind === "tool" ? entry.name : t(entry.kind === "user" ? "evidence.user" : "evidence.assistant");
		const detail = entry.kind === "tool" ? entry.evidence === "reported" ? t("evidence.reportedOnly") : duration(entry.durationMs) : "";
		return `<a href="#trace-step-${index}" class="${entry.kind === "tool" && entry.isError ? "w-step-error" : ""}"><span>${index + 1}</span>${h(name)}${detail ? `<small>${h(detail)}</small>` : ""}</a>`;
	}).join("")}</nav>`;
}

function renderInspector(model: EvalPageModel): string {
	const selected = model.selectedRun;
	if (!selected) return `<section class="w-inspector w-empty" id="inspector" tabindex="-1" aria-label="${h(t("workspace.inspector"))}"><h2>${h(t("workspace.inspector"))}</h2><p>${h(t("workspace.empty"))}</p></section>`;
	const { run } = selected;
	const position = model.rows.findIndex((row) => row.runId === run.runId);
	const previous = position > 0 ? model.rows[position - 1] : undefined;
	const next = position >= 0 ? model.rows[position + 1] : undefined;
	return `<section class="w-inspector" id="inspector" tabindex="-1" aria-labelledby="inspector-title" data-selected-run="${h(run.runId)}">
<div class="w-inspector-head"><div><p class="w-eyebrow">${h(t("workspace.inspector"))}</p><h2 id="inspector-title">${h(run.taskId)} <small>${h(t("explorer.repetition", { index: run.repetitionIndex + 1 }))}</small></h2></div>${outcomeChip(run.outcome)}</div>
<nav class="w-trace-nav" aria-label="${h(t("workspace.inspect"))}"><a href="${h(workspaceHref(model, { run: run.runId }))}#inspector">${h(t("workspace.permalink"))}</a><a href="/runs/${encodeURIComponent(run.runId)}">${h(t("workspace.complete"))} ↗</a><span class="w-run-arrows">${previous ? `<a href="${h(workspaceHref(model, { run: previous.runId }))}#inspector" aria-label="${h(t("workspace.previous"))}">←</a>` : ""}${next ? `<a href="${h(workspaceHref(model, { run: next.runId }))}#inspector" aria-label="${h(t("workspace.next"))}">→</a>` : ""}</span></nav>
${position < 0 ? `<p class="w-note">${h(t("workspace.outsideFilter"))}</p>` : ""}
<dl class="w-run-metrics"><div><dt>${h(t("explorer.th.latency"))}</dt><dd>${h(duration(run.metrics.latencyMs))}</dd></div><div><dt>${h(t("explorer.th.cost"))}</dt><dd>${h(money(run.metrics.costUsd))}</dd></div><div><dt>${h(t("explorer.th.tokens"))}</dt><dd>${run.metrics.tokens ?? "—"}</dd></div><div><dt>${h(t("evidence.executedTools"))}</dt><dd>${run.metrics.toolCalls}</dd></div></dl>
<div class="w-inspector-body">
${run.error ? `<div class="w-run-error"><h3>${h(t("explorer.h2.run-error"))}</h3><pre>${h(run.error)}</pre></div>` : ""}
<details class="w-checks"><summary>${h(t("workspace.checks"))} <span>${selected.graders.filter((grader) => grader.passed).length}/${selected.graders.length}</span></summary>${renderVerdict(selected.graders)}${renderWhy(selected.explanation, { omitSummary: true })}</details>
${selected.explanation.rag ? `<details class="w-checks"><summary>${h(t("rag.title"))}</summary>${renderRagXray(selected.explanation.rag)}</details>` : ""}
<div class="w-conversation-head"><h3>${h(t("explorer.h2.conversation"))}</h3><details><summary>${h(t("workspace.trajectory"))}</summary><p class="w-note">${h(t("workspace.trajectoryNote"))}</p></details></div>
${renderSequence(selected)}
${selected.transcript?.entries.some((entry) => entry.kind === "user") || selected.input === null ? "" : `<article class="turn"><div class="who">${h(t("evidence.caseInput"))}</div><pre>${h(selected.input)}</pre></article>`}
${renderTranscript(selected, "trace-step-")}
<p class="w-note">${h(selected.traceNotice)}</p>
<details class="w-checks"><summary>${h(t("evidence.metadata"))}</summary><pre>${h(run.runId)}\n${h(model.evalRunId)}\n${h(run.startedAt)}${run.finishedAt ? ` → ${h(run.finishedAt)}` : ""}</pre><p class="w-note">${h(t("evidence.systemUnavailable"))}</p></details>
</div></section>`;
}

const KEYBOARD = `
document.addEventListener('keydown', function(event) {
	if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
	var link = event.target.closest && event.target.closest('.w-run-link');
	if (!link || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
	var links = Array.from(document.querySelectorAll('.w-run-link'));
	var next = links[links.indexOf(link) + (event.key === 'ArrowDown' ? 1 : -1)];
	if (next) { event.preventDefault(); next.focus(); }
});
`;

export function renderEvalPage(model: EvalPageModel): string {
	const stats = [
		[t("evidence.passRate"), percent(model.summary.allPassRate)],
		[t("evidence.passed"), `${model.summary.pass}/${model.summary.total}`],
		[t("evidence.meanScore"), percent(model.meanScore)],
		[t("evidence.errors"), String(model.summary.error)],
		[t("explorer.th.cost"), money(model.costUsd)],
	].map(([label, value]) => `<div><dt>${h(label)}</dt><dd>${h(value)}</dd></div>`).join("");
	return renderPage({
		title: `${model.targetId} · ${t("workspace.title")}`,
		crumbs: [{ label: t("evidence.brand"), href: "/" }, { label: model.targetId }, { label: t("workspace.title") }],
		pageClass: "evidence-workspace", styles: WORKSPACE_STYLES, script: KEYBOARD,
		body: `<div class="w-skip"><a href="#runs">${h(t("workspace.focusRuns"))}</a><a href="#inspector">${h(t("workspace.focusTrace"))}</a></div>
<header class="w-header"><div><p class="w-eyebrow">${h(t("workspace.observed"))}</p><h1>${h(model.targetId)}</h1><p class="w-subtitle">${h(t("evidence.design", model.design))}</p></div><div class="w-context"><span>${h(model.model ?? t("metrics.not-reported"))}</span><span class="mono">${h(model.revision.slice(0, 12))}</span><span>${h(tokenLabel("evidence.visibility", model.visibility))} · ${h(model.purpose)}</span></div><dl class="w-summary">${stats}</dl></header>
<details class="w-eval-details"><summary>${h(t("workspace.more"))}</summary><p>${h(model.briefHeadline)}</p><p>${h(t(model.proposalEligible ? "evidence.proposalEligible" : "evidence.proposalBlocked"))}</p><pre>${h(model.evalRunId)} · ${h(model.startedAt)}\n${h(model.suiteId)} · ${h(model.dataset)}</pre>${model.judgeCalibration.map((line) => `<p>${h(line)}</p>`).join("")}${model.notices.map((notice) => `<p>${h(notice)}</p>`).join("")}</details>
<div class="eval-workspace">${renderIssues(model)}${renderRuns(model)}${renderInspector(model)}</div>`,
	});
}
