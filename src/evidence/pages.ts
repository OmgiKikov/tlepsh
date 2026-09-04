import { bareDelta, percent, points, ratio } from "../measurement.js";
import { language, t } from "../i18n.js";

/**
 * A number the Target never reported renders as a dash, never as zero. `$0.00`
 * beside a run that measured nothing is a claim; the dash is the truth.
 */
function money(value: number | null, digits: number): string {
	return value === null ? t("metrics.not-reported") : `$${value.toFixed(digits)}`;
}

function count(value: number | null): string {
	return value === null ? t("metrics.not-reported") : value.toLocaleString("en-US");
}
import {
	flipSubject,
	type CandidateFlip,
	type GraderFinding,
	type RunExplanation,
	type RunReceipt,
	type RunRow,
	type Transcript,
} from "../application/run-explanation.js";

/**
 * Every human-facing Evidence page, in one place.
 *
 * The explorer serves these; the static `report.html` embeds the same runs
 * table, so the offline artifact and the live surface cannot render the same
 * evidence differently. There are no external resources of any kind: one inline
 * stylesheet, one optional inline filter script, and nothing the Content
 * Security Policy of the explorer does not already allow.
 */

export function h(value: unknown): string {
	return String(value ?? "").replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	})[character] ?? character);
}

/** Dark palette values, shared by the explorer's dark mode and the static report. */
const DARK_TOKENS = `
	--bg:#0c0e13;--surface:#12151c;--surface2:#171b24;--sunken:#0e1117;
	--line:#242a36;--line-strong:#333b4b;
	--text:#e9edf5;--muted:#9aa3b4;--faint:#7a8496;
	--accent:#8b98ff;--accent-soft:#1b2140;
	--pass:#4fce8b;--pass-soft:#0f2a1d;
	--fail:#ff7d90;--fail-soft:#2d151b;
	--error:#f0b34e;--error-soft:#2c2110;
`;

const FONT_TOKENS = `
	--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif;
	--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
	--radius:10px;
`;

/**
 * Design tokens, light by default and dark when the viewer asks for dark.
 * Colour never carries meaning alone: every status chip prints its word, every
 * delta prints its sign.
 */
export const EVIDENCE_TOKENS = `
:root{
	color-scheme:light dark;${FONT_TOKENS}
	--bg:#f7f8fa;--surface:#fff;--surface2:#f0f2f6;--sunken:#eef0f5;
	--line:#dfe3ea;--line-strong:#c4cad6;
	--text:#12151c;--muted:#5d6675;--faint:#828b9b;
	--accent:#3a4ee0;--accent-soft:#e8ebfd;
	--pass:#0f7a45;--pass-soft:#e2f5ea;
	--fail:#b3243b;--fail-soft:#fdeaed;
	--error:#a05407;--error-soft:#fdf0dd;
}
@media (prefers-color-scheme:dark){:root{${DARK_TOKENS}}}
`.trim();

/**
 * The same tokens pinned dark. The static `report.html` is a dark artifact by
 * design, so it takes these and the table rules below rather than re-inventing
 * a second table that could drift from the explorer's.
 */
export const EVIDENCE_TOKENS_DARK = `:root{color-scheme:dark;${FONT_TOKENS}${DARK_TOKENS}}`;

/** The runs table and its chips. Shared verbatim by the explorer and the report. */
export const EVIDENCE_TABLE_CSS = `
.scroll{overflow:auto;max-height:78vh;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius)}
.scroll table{border-collapse:separate;border-spacing:0;width:100%;font-size:12.5px}
.scroll th,.scroll td{padding:8px 11px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top;white-space:nowrap;color:var(--text)}
.scroll thead th{position:sticky;top:0;z-index:2;background:var(--surface2);color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--line-strong)}
.scroll tbody tr:nth-child(even){background:var(--sunken)}
.scroll tbody tr:hover{background:var(--accent-soft)}
.scroll tbody tr:last-child td{border-bottom:0}
.scroll td.num{text-align:right;font-variant-numeric:tabular-nums;font-family:var(--mono)}
.scroll td.wrapcell{white-space:normal;min-width:260px;max-width:420px}
.chip{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:650;letter-spacing:.02em;border:1px solid transparent}
.chip.pass{background:var(--pass-soft);color:var(--pass);border-color:var(--pass)}
.chip.fail{background:var(--fail-soft);color:var(--fail);border-color:var(--fail)}
.chip.error{background:var(--error-soft);color:var(--error);border-color:var(--error)}
.gchip{display:inline-block;margin:0 4px 2px 0;padding:1px 6px;border:1px solid var(--line-strong);border-radius:6px;font-size:11px;font-family:var(--mono);color:var(--muted);background:var(--surface)}
.gchip.ok{border-color:var(--pass);color:var(--pass)}
.gchip.no{border-color:var(--fail);color:var(--fail)}
.count{font-variant-numeric:tabular-nums;color:var(--muted);font-size:12px;white-space:nowrap}
.filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 10px;font-size:12.5px}
.filters input{font:inherit;padding:6px 9px;border:1px solid var(--line-strong);border-radius:7px;background:var(--surface);color:var(--text);min-width:230px}
.pills{display:flex;gap:5px;flex-wrap:wrap}
.pill{display:inline-block;padding:4px 9px;border:1px solid var(--line-strong);border-radius:999px;font-size:11.5px;color:var(--muted);background:var(--surface)}
.pill.on{background:var(--accent-soft);border-color:var(--accent);color:var(--accent);font-weight:600}
.up{color:var(--pass);font-weight:650}
.down{color:var(--fail);font-weight:650}
.same{color:var(--muted)}
.empty{padding:26px;text-align:center;color:var(--muted)}
.mono{font-family:var(--mono)}
`.trim();

/** The whole explorer stylesheet: tokens, base typography, table, and pages. */
export const EVIDENCE_STYLESHEET = `
${EVIDENCE_TOKENS}
${EVIDENCE_TABLE_CSS}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 var(--sans)}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
a:focus-visible,summary:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
code,kbd,pre,.mono{font-family:var(--mono)}
h1{font-size:26px;line-height:1.2;letter-spacing:-.02em;margin:0 0 4px}
h2{font-size:17px;line-height:1.3;margin:0 0 10px;letter-spacing:-.01em}
h3{font-size:14px;margin:0 0 6px}
p{margin:0 0 10px}
.topbar{position:sticky;top:0;z-index:5;background:var(--surface);border-bottom:1px solid var(--line);padding:10px 20px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px}
.topbar .crumb{color:var(--muted)}
.topbar .sep{color:var(--faint)}
.wrap{max-width:1440px;margin:0 auto;padding:22px 20px 60px}
.prose{max-width:78ch}
.head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;flex-wrap:wrap;margin-bottom:18px}
.sub{color:var(--muted);font-size:12.5px}
.tag{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line-strong);border-radius:999px;padding:3px 9px;font-size:11.5px;color:var(--muted);background:var(--surface)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:0 0 22px}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px}
.stat b{display:block;font-size:22px;line-height:1.15;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat span{display:block;margin-top:3px;font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
section{margin:0 0 26px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:10px}
.hyp{border-left:3px solid var(--error);background:var(--error-soft);padding:8px 11px;border-radius:0 6px 6px 0;margin:8px 0 0;font-size:12.5px}
.hyp b{color:var(--error)}
.modes{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.modes li{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:11px 13px}
.modes .excerpt{color:var(--muted);margin:6px 0 0;font-size:12px;word-break:break-word}
.modes .row,.rowline{display:flex;gap:10px;align-items:baseline;justify-content:space-between;flex-wrap:wrap}
.errpre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.6 var(--mono)}
.turn{border:1px solid var(--line);border-radius:var(--radius);margin:0 0 9px;background:var(--surface);overflow:hidden}
.turn>.who{font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);padding:7px 13px;background:var(--surface2);border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:10px}
.turn pre{margin:0;padding:11px 13px;white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.6 var(--mono)}
.turn.final{border-color:var(--pass)}
.turn.final>.who{background:var(--pass-soft);color:var(--pass)}
.turn.toolerr{border-color:var(--fail)}
details{border-top:1px solid var(--line)}
details>summary{cursor:pointer;padding:7px 13px;font-size:11.5px;color:var(--muted);list-style:none}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"▸ ";color:var(--faint)}
details[open]>summary::before{content:"▾ "}
.kv{display:grid;grid-template-columns:auto 1fr;gap:3px 14px;font-size:12.5px;margin:0}
.kv dt{color:var(--muted)}
.kv dd{margin:0;font-family:var(--mono);overflow-wrap:anywhere}
.why{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:0 var(--radius) var(--radius) 0;padding:13px 16px}
.why p{margin:0 0 8px;max-width:78ch}
.why p:last-child{margin:0}
.note{color:var(--muted);font-size:12px;margin:9px 0 0;max-width:78ch}
.nav{display:flex;gap:10px;justify-content:space-between;margin:16px 0 0;font-size:12.5px}
@media (max-width:640px){.wrap{padding:16px 12px 40px}h1{font-size:21px}.stat b{font-size:18px}}
`.trim();

export interface PageOptions {
	title: string;
	/** Breadcrumb links, rendered left to right in the top bar. */
	crumbs: Array<{ label: string; href?: string }>;
	body: string;
	/** Inline script body. Rendered verbatim inside a <script> element. */
	script?: string;
}

export function renderPage(options: PageOptions): string {
	const crumbs = options.crumbs
		.map((crumb) => crumb.href
			? `<a href="${h(crumb.href)}">${h(crumb.label)}</a>`
			: `<span class="crumb">${h(crumb.label)}</span>`)
		.join('<span class="sep">/</span>');
	return `<!doctype html>
<html lang="${language()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(options.title)}</title>
<style>${EVIDENCE_STYLESHEET}</style>
</head><body>
<nav class="topbar">${crumbs}</nav>
<main class="wrap">${options.body}</main>
${options.script ? `<script>${options.script}</script>` : ""}
</body></html>`;
}

// ---------- Runs table ----------

export interface RunsTableOptions {
	/** Where a row links. The explorer points at /runs/<id>; the report at #run=<id>. */
	hrefForRun: (runId: string) => string;
	/** Where a failure-mode chip links, when the surface has a filtered view. */
	hrefForMode?: (failureModeId: string) => string;
	/** Short display labels for failure mode ids, when known. */
	modeLabels?: Map<string, string>;
	/**
	 * Also stamp `data-run` on each row. The static report's in-page trace
	 * inspector selects rows with it; the explorer navigates instead.
	 */
	dataRun?: boolean;
}

function outcomeChip(outcome: RunRow["outcome"]): string {
	return `<span class="chip ${outcome}">${outcome}</span>`;
}

function scoreCell(row: RunRow): string {
	return percent(row.score);
}

function graderChips(row: RunRow): string {
	if (row.graders.length === 0) return '<span class="gchip">no graders</span>';
	return row.graders
		.map((grader) =>
			`<span class="gchip ${grader.passed ? "ok" : "no"}" title="${h(grader.name)}">${h(grader.type)} ${h(grader.chip)}</span>`)
		.join("");
}

function modeCell(row: RunRow, options: RunsTableOptions): string {
	if (row.failureModeIds.length === 0) return '<span class="same">—</span>';
	return row.failureModeIds
		.map((id) => {
			const label = options.modeLabels?.get(id) ?? id;
			return options.hrefForMode
				? `<a class="gchip no" href="${h(options.hrefForMode(id))}">${h(label)}</a>`
				: `<span class="gchip no">${h(label)}</span>`;
		})
		.join(" ");
}

/**
 * One row per case × repetition. `data-` attributes carry the exact filter keys
 * so the inline filter never has to re-derive a cell it is hiding.
 */
export function renderRunsTable(rows: readonly RunRow[], options: RunsTableOptions): string {
	if (rows.length === 0) {
		return '<div class="scroll"><div class="empty">No runs match this filter.</div></div>';
	}
	const body = rows.map((row) => `<tr data-row${options.dataRun ? ` data-run="${h(row.runId)}"` : ""} data-outcome="${h(row.outcome)}" data-modes="${h(row.failureModeIds.join(" "))}" data-text="${h(`${row.taskId} ${row.runId} ${row.inputPreview ?? ""}`.toLowerCase())}">`
		+ `<td class="mono"><a href="${h(options.hrefForRun(row.runId))}">${h(row.taskId)}</a></td>`
		+ `<td class="num">${row.repetitionIndex}</td>`
		+ `<td class="wrapcell">${row.inputPreview === null ? '<span class="same">trace unavailable</span>' : h(row.inputPreview)}</td>`
		+ `<td>${outcomeChip(row.outcome)}</td>`
		+ `<td class="num">${scoreCell(row)}</td>`
		+ `<td class="wrapcell">${graderChips(row)}</td>`
		+ `<td class="wrapcell">${modeCell(row, options)}</td>`
		+ `<td class="num">${row.metrics.toolCalls} executed${row.metrics.reportedToolCalls > 0 ? ` / ${row.metrics.reportedToolCalls} reported` : ""}${row.metrics.toolErrors > 0 ? ` / ${row.metrics.toolErrors} err` : ""}</td>`
		+ `<td class="num">${(row.metrics.latencyMs / 1000).toFixed(1)}s</td>`
		+ `<td class="num">${money(row.metrics.costUsd, 5)}</td>`
		+ `<td class="num">${count(row.metrics.tokens)}</td>`
		+ `</tr>`).join("");
	return `<div class="scroll"><table><thead><tr>`
		+ `<th>${h(t("explorer.th.task"))}</th><th>${h(t("explorer.th.rep"))}</th><th>${h(t("explorer.th.input"))}</th>`
		+ `<th>${h(t("explorer.th.outcome"))}</th><th>${h(t("explorer.th.score"))}</th><th>${h(t("explorer.th.graders"))}</th>`
		+ `<th>${h(t("explorer.th.failure-mode"))}</th><th>${h(t("explorer.th.tools"))}</th><th>${h(t("explorer.th.latency"))}</th>`
		+ `<th>${h(t("explorer.th.cost"))}</th><th>${h(t("explorer.th.tokens"))}</th>`
		+ `</tr></thead><tbody>${body}</tbody></table></div>`;
}

/**
 * The filter box. Query-parameter links already decided outcome and mode
 * server-side; this only narrows what is on the page by free text, and says how
 * many rows survive.
 */
export const RUNS_TABLE_FILTER_SCRIPT = `
(function(){
var box=document.getElementById('filter'),count=document.getElementById('filter-count');
if(!box)return;
var rows=Array.prototype.slice.call(document.querySelectorAll('tr[data-row]'));
function apply(){
	var q=box.value.trim().toLowerCase(),shown=0;
	for(var i=0;i<rows.length;i++){
		var hit=q===''||(rows[i].getAttribute('data-text')||'').indexOf(q)>=0;
		rows[i].hidden=!hit;
		if(hit)shown++;
	}
	if(count)count.textContent=shown+' of '+rows.length+' rows';
}
box.addEventListener('input',apply);
apply();
})();
`.trim();

// ---------- Eval page ----------

export interface EvalPageMode {
	id: string;
	title: string;
	scope: string;
	severity: string;
	decision: string;
	/** What the cited traces show, in the operator's language. */
	facts: string;
	/** One raw excerpt behind the mode: what was called, and what was said. */
	excerpt: string | null;
	affectedTasks: number;
	totalTasks: number;
	reproductionBps: number;
	runCount: number;
	href: string;
}

export interface EvalPageModel {
	evalRunId: string;
	targetId: string;
	revision: string;
	label: string;
	purpose: string;
	visibility: string;
	suiteId: string;
	dataset: string;
	startedAt: string;
	model: string | null;
	design: { tasks: number; repetitions: number; runs: number };
	summary: { total: number; pass: number; fail: number; error: number; allPassRate: number };
	meanScore: number;
	costUsd: number;
	tokens: number;
	judgeCalibration: string[];
	briefStatus: string;
	briefHeadline: string;
	proposalEligible: boolean;
	modes: EvalPageMode[];
	rows: RunRow[];
	filter: { outcome: string | null; mode: string | null };
	filterLinks: Array<{ label: string; href: string; active: boolean }>;
	candidates: Array<{ candidateId: string; href: string; role: string; verdict: string }>;
	notices: string[];
}

export function renderEvalPage(model: EvalPageModel): string {
	const modeLabels = new Map(model.modes.map((mode) => [mode.id, mode.title]));
	const stats = [
		["Pass rate", percent(model.summary.allPassRate)],
		["Passed", `${model.summary.pass}/${model.summary.total}`],
		["Mean score", percent(model.meanScore)],
		["Errors", String(model.summary.error)],
		["Failure modes", String(model.modes.length)],
		["Cost", `$${model.costUsd.toFixed(4)}`],
	].map(([label, value]) => `<div class="stat"><b>${h(value)}</b><span>${h(label)}</span></div>`).join("");

	const modes = model.modes.length === 0
		? '<div class="card">No failure modes: the verified diagnosis found nothing to group.</div>'
		: `<ul class="modes">${model.modes.map((mode) => `<li>
<div class="row"><h3><a href="${h(mode.href)}">${h(mode.title)}</a></h3><span class="count">${h(t("explorer.mode-count", { runs: mode.runCount, affected: mode.affectedTasks, total: mode.totalTasks, reproduction: Math.round(mode.reproductionBps / 100) }))}</span></div>
<div class="pills"><span class="pill">${h(mode.scope)}</span><span class="pill">${h(mode.severity)}</span><span class="pill">${h(mode.decision)}</span></div>
<p class="hyp">${h(mode.facts)}</p>
${mode.excerpt ? `<p class="excerpt mono">${h(mode.excerpt)}</p>` : ""}
</li>`).join("")}</ul>`;

	const candidates = model.candidates.length === 0
		? ""
		: `<section><h2>${h(t("explorer.h2.candidates"))}</h2><div class="cards">${model.candidates.map((candidate) => `<div class="card"><h3><a href="${h(candidate.href)}">${h(candidate.candidateId)}</a></h3><p class="sub">${h(t("explorer.eval-arm", { role: candidate.role, verdict: candidate.verdict }))}</p></div>`).join("")}</div></section>`;

	const body = `
<div class="head">
	<div>
		<h1>${h(model.targetId)}</h1>
		<div class="sub mono">${h(model.evalRunId)} · ${h(model.label)} · ${h(model.startedAt)}</div>
		<div class="sub">${h(model.suiteId)} · dataset ${h(model.dataset)} · ${h(model.design.tasks)} tasks × ${h(model.design.repetitions)} repetition(s) · ${h(model.design.runs)} runs</div>
		${model.model ? `<div class="sub">model ${h(model.model)}</div>` : ""}
	</div>
	<div class="pills">
		<span class="tag">${h(model.visibility)}</span>
		<span class="tag">${h(model.purpose)}</span>
		<span class="tag mono">${h(model.revision.slice(0, 12))}</span>
		<span class="tag">${h(model.briefStatus)}</span>
	</div>
</div>
<div class="stats">${stats}</div>
<section class="prose">
	<p>${h(model.briefHeadline)}</p>
	<p class="note">${model.proposalEligible
		? "Proposal gate: eligible for an exact human-reviewed harness proposal."
		: "Proposal gate: blocked. Mode-level suggestions are diagnostic guidance only until the global evidence gate is satisfied."}</p>
	${model.judgeCalibration.map((line) => `<p class="note">${h(line)}</p>`).join("")}
</section>
<section><h2>${h(t("explorer.h2.failure-modes"))}</h2>${modes}</section>
${candidates}
<section>
	<h2>${h(t("explorer.h2.runs"))}</h2>
	<div class="filters">
		<input id="filter" type="search" placeholder="Filter by task id or input text" aria-label="Filter runs">
		<span class="count" id="filter-count"></span>
		<span class="pills">${model.filterLinks.map((link) => `<a class="pill${link.active ? " on" : ""}" href="${h(link.href)}">${h(link.label)}</a>`).join("")}</span>
	</div>
	${renderRunsTable(model.rows, {
		hrefForRun: (runId) => `/runs/${encodeURIComponent(runId)}`,
		hrefForMode: (id) => `/evals/${encodeURIComponent(model.evalRunId)}?mode=${encodeURIComponent(id)}`,
		modeLabels,
	})}
	${model.notices.map((notice) => `<p class="note">${h(notice)}</p>`).join("")}
</section>`;

	return renderPage({
		title: `${model.targetId} · ${model.evalRunId}`,
		crumbs: [
			{ label: "AHDE Evidence", href: "/" },
			{ label: model.evalRunId },
		],
		body,
		script: RUNS_TABLE_FILTER_SCRIPT,
	});
}

// ---------- Run detail page ----------

export interface RunDetailPageModel {
	evalRunId: string;
	targetId: string;
	revision: string;
	label: string;
	run: {
		runId: string;
		taskId: string;
		repetitionIndex: number;
		outcome: RunRow["outcome"];
		status: string;
		startedAt: string;
		finishedAt: string | null;
		error: string | null;
		metrics: RunRow["metrics"];
	};
	input: string | null;
	/** What this run was given and what it spent, each said as its own fact. */
	receipt: RunReceipt;
	transcript: Transcript | null;
	traceNotice: string;
	graders: GraderFinding[];
	explanation: RunExplanation;
	prev: { runId: string; taskId: string; repetitionIndex: number } | null;
	next: { runId: string; taskId: string; repetitionIndex: number } | null;
}

function renderTranscript(model: RunDetailPageModel): string {
	if (!model.transcript) {
		return `<div class="card">No trace is recorded for this run.</div>`;
	}
	const entries = model.transcript.entries.map((entry) => {
		if (entry.kind === "user") {
			return `<article class="turn"><div class="who"><span>user</span></div><pre>${h(entry.text)}</pre></article>`;
		}
		if (entry.kind === "assistant") {
			const thinking = entry.thinking
				? `<details><summary>thinking</summary><pre>${h(entry.thinking)}</pre></details>`
				: "";
			return `<article class="turn${entry.final ? " final" : ""}"><div class="who"><span>assistant${entry.final ? " · final answer" : ""}</span></div>`
				+ (entry.text ? `<pre>${h(entry.text)}</pre>` : "")
				+ thinking
				+ `</article>`;
		}
		const duration = entry.durationMs === null ? "" : ` · ${(entry.durationMs / 1000).toFixed(2)}s`;
		const status = entry.evidence === "reported" ? "agent-reported, not host-verified"
			: entry.result === null ? "no result recorded" : entry.isError ? "error" : "ok";
		return `<article class="turn${entry.isError ? " toolerr" : ""}"><div class="who"><span>tool · ${h(entry.name)}</span><span>${h(status)}${h(duration)}</span></div>`
			+ `<details><summary>arguments</summary><pre>${h(entry.args)}</pre></details>`
			+ (entry.result === null
				? ""
				: `<details><summary>result${entry.resultTruncated ? " (clipped)" : ""}</summary><pre>${h(entry.result)}</pre></details>`)
			+ `</article>`;
	}).join("");
	return entries || '<div class="card">The recorded trace holds no renderable turns.</div>';
}

function renderVerdict(graders: readonly GraderFinding[]): string {
	if (graders.length === 0) return '<div class="card">This run recorded no grader results.</div>';
	return graders.map((grader) => {
		const assertions = grader.assertionVerdicts
			? `<div class="scroll"><table><thead><tr><th>${h(t("explorer.th.index"))}</th><th>${h(t("explorer.th.answer"))}</th><th>${h(t("explorer.th.judge-evidence"))}</th></tr></thead><tbody>${grader.assertionVerdicts.map((assertion) => `<tr><td class="num">${assertion.index}</td><td><span class="chip ${assertion.answer === "yes" ? "pass" : assertion.answer === "no" ? "fail" : "error"}">${h(assertion.answer)}</span></td><td class="wrapcell">${h(assertion.evidence)}</td></tr>`).join("")}</tbody></table></div>`
			: grader.assertions
				? `<p class="note">The record keeps ${grader.assertions.passed}/${grader.assertions.total} assertions; per-assertion evidence is not available for this run.</p>`
				: "";
		const jury = grader.jury
			? `<p class="note">Jury: ${grader.jury.map((vote) => `juror ${vote.juror} ${vote.passed ? "pass" : "fail"}${vote.choice ? ` (${vote.choice})` : ""}${vote.answers ? ` [${vote.answers.join(", ")}]` : ""}`).join(" · ")}</p>`
			: "";
		return `<div class="card">
<div class="rowline">
	<h3 class="mono">${h(grader.name)}</h3>
	<span><span class="chip ${grader.passed ? "pass" : "fail"}">${grader.passed ? "pass" : "fail"}</span> <span class="gchip">${h(grader.type)} ${h(grader.chip)}</span> <span class="gchip">score ${grader.score.toFixed(2)}</span>${grader.choice ? ` <span class="gchip">choice ${h(grader.choice)}</span>` : ""}</span>
</div>
<p class="sub">${h(grader.reason)}</p>
${assertions}${jury}
</div>`;
	}).join("");
}

function renderWhy(explanation: RunExplanation): string {
	const graders = explanation.graders.map((grader) => {
		const head = grader.expected
			? `<b class="mono">${h(grader.graderName)}</b> (${h(grader.graderType)}) ${h(grader.expected)}; ${h(grader.actual)}.`
			: `<b class="mono">${h(grader.graderName)}</b> (${h(grader.graderType)}): ${h(grader.actual)}.`;
		const assertions = grader.assertions
			.map((assertion) => `<p>Assertion ${assertion.index} was answered “${h(assertion.answer)}”; the judge's evidence: “${h(assertion.evidence)}”.</p>`)
			.join("");
		return `<p>${head}</p><p>The grader recorded: “${h(grader.reason)}”.</p>${assertions}`;
	}).join("");
	const modes = explanation.failureModes.map((mode) =>
		`<p>This run is evidence for the failure mode “${h(mode.title)}” (${h(mode.scope)}, ${h(mode.severity)}, ${mode.affectedTasks} of ${mode.totalTasks} task(s), ${Math.round(mode.reproductionBps / 100)}% reproduction).</p>`
		+ `<p class="hyp">${h(t("why.facts", { facts: mode.facts }))}</p>`).join("");
	const flip = explanation.flip
		? `<p>${h(flipSubject(explanation.flip))} <span class="mono">${h(explanation.flip.candidateId)}</span> re-ran this task: <span class="${explanation.flip.direction === "improved" ? "up" : explanation.flip.direction === "regressed" ? "down" : "same"}">${h(explanation.flip.badge)} ${h(explanation.flip.before)} → ${h(explanation.flip.after)}</span> (${h(explanation.flip.direction)}; baseline ${explanation.flip.baselinePass}/${explanation.flip.baselineTotal}, candidate ${explanation.flip.candidatePass}/${explanation.flip.candidateTotal}).</p>`
		: "";
	return `<div class="why"><p>${h(explanation.headline)}</p>${graders}${modes}${flip}
<p class="note">Every sentence above is assembled by the host from recorded fields — the grader results, the bounded trace, the stored diagnosis, and a Candidate's own comparison. No model wrote it.</p></div>`;
}

export function renderRunDetailPage(model: RunDetailPageModel): string {
	const run = model.run;
	const body = `
<div class="head">
	<div>
		<h1>${h(run.taskId)} <span class="sub">${h(t("explorer.repetition", { index: run.repetitionIndex }))}</span></h1>
		<div class="sub mono">${h(run.runId)} · ${h(model.evalRunId)} · ${h(model.label)}</div>
		<div class="sub">${h(run.startedAt)}${run.finishedAt ? ` → ${h(run.finishedAt)}` : ""}</div>
	</div>
	<div class="pills">
		<span class="chip ${run.outcome}">${run.outcome}</span>
		<span class="tag mono">${h(model.revision.slice(0, 12))}</span>
	</div>
</div>
<div class="stats">
	<div class="stat"><b>${(run.metrics.latencyMs / 1000).toFixed(1)}s</b><span>Latency</span></div>
	<div class="stat"><b>${run.metrics.toolCalls}</b><span>Executed tools</span></div>
	${run.metrics.reportedToolCalls > 0 ? `<div class="stat"><b>${run.metrics.reportedToolCalls}</b><span>Agent-reported tools</span></div>` : ""}
	<div class="stat"><b>${run.metrics.toolErrors}</b><span>Tool errors</span></div>
	<div class="stat"><b>${count(run.metrics.tokens)}</b><span>Tokens</span></div>
	<div class="stat"><b>${money(run.metrics.costUsd, 5)}</b><span>Cost</span></div>
</div>
<section><h2>${h(t("explorer.h2.why"))}</h2>${renderWhy(model.explanation)}</section>
${run.error ? `<section><h2>${h(t("explorer.h2.run-error"))}</h2><div class="card"><pre class="errpre">${h(run.error)}</pre></div></section>` : ""}
<section><h2>${h(t("explorer.h2.verdict"))}</h2><div class="cards">${renderVerdict(model.graders)}</div></section>
<section>
	<h2>${h(t("explorer.h2.conversation"))}</h2>
	<details class="turn"><summary>System instructions</summary><pre>The Target's system instructions are not recorded in session.jsonl; this transcript starts at the case input.</pre></details>
	${model.input === null ? "" : `<details class="turn" open><summary>Case input</summary><pre>${h(model.input)}</pre></details>`}
	${renderTranscript(model)}
	<p class="note">${h(model.traceNotice)}</p>
</section>
<nav class="nav">
	<span>${model.prev ? `<a href="/runs/${encodeURIComponent(model.prev.runId)}">← ${h(model.prev.taskId)} rep ${model.prev.repetitionIndex}</a>` : ""}</span>
	<span><a href="/evals/${encodeURIComponent(model.evalRunId)}">all runs</a></span>
	<span>${model.next ? `<a href="/runs/${encodeURIComponent(model.next.runId)}">${h(model.next.taskId)} rep ${model.next.repetitionIndex} →</a>` : ""}</span>
</nav>`;
	return renderPage({
		title: `${run.taskId} · ${run.runId}`,
		crumbs: [
			{ label: "AHDE Evidence", href: "/" },
			{ label: model.evalRunId, href: `/evals/${encodeURIComponent(model.evalRunId)}` },
			{ label: run.runId },
		],
		body,
	});
}

// ---------- Compare page ----------

export interface ComparePageRow {
	taskId: string;
	flip: CandidateFlip;
	baselineScore: number;
	candidateScore: number;
	scoreDelta: number;
	baselineRunId: string | null;
	candidateRunId: string | null;
}

export interface ComparePageModel {
	candidateId: string;
	targetId: string;
	status: string;
	developmentLine: string;
	developmentReasons: string[];
	baseline: { evalRunId: string; revision: string; passRate: number };
	candidate: { evalRunId: string; revision: string; passRate: number };
	resources: { costRatio: number | null; latencyRatio: number | null; tokenRatio: number | null };
	confidence: { low: number; high: number } | null;
	/** Verdict and design size only. Sealed identity and content never appear. */
	sealed: { verdict: string; tasks: number; repetitions: number; excludedTasks: number } | null;
	rows: ComparePageRow[];
	counts: { improved: number; regressed: number; unchanged: number };
	notices: string[];
}

export function renderComparePage(model: ComparePageModel): string {
	const rows = model.rows.map((row) => `<tr>
<td class="mono">${h(row.taskId)}</td>
<td>${row.baselineRunId ? `<a href="/runs/${encodeURIComponent(row.baselineRunId)}">${h(row.flip.before)}</a>` : h(row.flip.before)} <span class="count">${row.flip.baselinePass}/${row.flip.baselineTotal}</span></td>
<td>${row.candidateRunId ? `<a href="/runs/${encodeURIComponent(row.candidateRunId)}">${h(row.flip.after)}</a>` : h(row.flip.after)} <span class="count">${row.flip.candidatePass}/${row.flip.candidateTotal}</span></td>
<td class="num">${percent(row.baselineScore)} → ${percent(row.candidateScore)}</td>
<td class="num ${row.scoreDelta > 0 ? "up" : row.scoreDelta < 0 ? "down" : "same"}">${h(points(row.scoreDelta))}</td>
<td class="${row.flip.direction === "improved" ? "up" : row.flip.direction === "regressed" ? "down" : "same"}">${h(row.flip.badge)} ${h(row.flip.direction)}</td>
</tr>`).join("");
	const body = `
<div class="head">
	<div>
		<h1>${h(model.targetId)} ${h(t("explorer.candidate-suffix"))}</h1>
		<div class="sub mono">${h(model.candidateId)}</div>
		<div class="sub mono">${h(model.baseline.evalRunId)} (${h(model.baseline.revision.slice(0, 12))}) → ${h(model.candidate.evalRunId)} (${h(model.candidate.revision.slice(0, 12))})</div>
	</div>
	<div class="pills"><span class="tag">${h(model.status)}</span></div>
</div>
<div class="stats">
	<div class="stat"><b>${percent(model.baseline.passRate)} → ${percent(model.candidate.passRate)}</b><span>All-pass rate</span></div>
	<div class="stat"><b>${model.counts.improved} ↑ / ${model.counts.regressed} ↓ / ${model.counts.unchanged} =</b><span>Task flips</span></div>
	<div class="stat"><b>${ratio(model.resources.costRatio)}</b><span>Cost ratio</span></div>
	<div class="stat"><b>${ratio(model.resources.latencyRatio)}</b><span>Latency ratio</span></div>
	<div class="stat"><b>${ratio(model.resources.tokenRatio)}</b><span>Token ratio</span></div>
</div>
<section class="prose">
	<p class="why">${h(model.developmentLine)}</p>
	${model.confidence ? `<p class="note">${h(t("unit.ci"))} ${bareDelta(model.confidence.low)} … ${bareDelta(model.confidence.high)}</p>` : ""}
	${model.developmentReasons.map((reason) => `<p class="note">${h(reason)}</p>`).join("")}
	${model.sealed
		? `<p class="why">Sealed verdict: <b>${h(model.sealed.verdict)}</b> on ${model.sealed.tasks} × ${model.sealed.repetitions}${model.sealed.excludedTasks > 0 ? ` · ${model.sealed.excludedTasks} excluded` : ""}. Sealed cases, identifiers, and traces are never rendered here.</p>`
		: `<p class="note">No sealed holdout comparison is recorded for this candidate.</p>`}
</section>
<section>
	<h2>${h(t("explorer.h2.per-task"))}</h2>
	<div class="scroll"><table><thead><tr><th>${h(t("explorer.th.task"))}</th><th>${h(t("explorer.th.baseline"))}</th><th>${h(t("explorer.th.candidate"))}</th><th>${h(t("explorer.th.score"))}</th><th>${h(t("explorer.th.delta"))}</th><th>${h(t("explorer.th.flip"))}</th></tr></thead><tbody>${rows}</tbody></table></div>
	${model.notices.map((notice) => `<p class="note">${h(notice)}</p>`).join("")}
	<p class="note">Per-task flips are flags for review; the verdict above comes only from the paired interval.</p>
</section>`;
	return renderPage({
		title: `${model.targetId} · ${model.candidateId}`,
		crumbs: [
			{ label: "AHDE Evidence", href: "/" },
			{ label: model.candidateId },
		],
		body,
	});
}
