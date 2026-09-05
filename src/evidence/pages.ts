import { percent, points, ratio } from "../measurement.js";
import { candidateStatusLabel, language, plural, t, tokenLabel, verdictLabel } from "../i18n.js";
import { sealedOutcomeLabel, type SealedOutcome, type ExcludedTask } from "../domain/comparison-gate.js";

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
	renderRunExplanationText,
	type CandidateFlip,
	type GraderFinding,
	type RunExplanation,
	type RunReceipt,
	type RunRow,
	type Transcript,
} from "../application/run-explanation.js";
import type { RagRunXray } from "../application/rag-xray.js";

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
		--accent:#176849;--accent-soft:#eaf4eb;
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
.scroll table{border-collapse:separate;border-spacing:0;width:100%;font-size:14px}
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
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 var(--sans)}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
a:focus-visible,summary:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
code,kbd,pre,.mono{font-family:var(--mono)}
h1{font-size:clamp(28px,4vw,44px);line-height:1.18;letter-spacing:-.035em;margin:0 0 10px;overflow-wrap:anywhere}
h2{font-size:17px;line-height:1.3;margin:0 0 10px;letter-spacing:-.01em}
h3{font-size:14px;margin:0 0 6px}
p{margin:0 0 10px}
.topbar{position:sticky;top:0;z-index:5;background:var(--surface);border-bottom:1px solid var(--line);padding:10px 20px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px}
.topbar .crumb{color:var(--muted)}
.topbar .sep{color:var(--faint)}
.wrap{max-width:1280px;margin:0 auto;padding:36px 28px 72px}
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
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:12px}
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
.turn .spoken{font:15px/1.75 var(--sans);padding:18px 20px}
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
.note{color:var(--muted);font-size:12px;margin:9px 0 0;max-width:78ch;overflow-wrap:anywhere}
.nav{display:flex;gap:10px;justify-content:space-between;margin:16px 0 0;font-size:12.5px}
.metadata{margin:14px 0 24px;color:var(--muted);font-size:12px}
.metadata pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 var(--mono);padding:10px 14px;margin:0}
.lead{font-size:17px;max-width:72ch;color:var(--muted);overflow-wrap:anywhere}
.examples{display:grid;gap:22px}
.example{border:1px solid var(--line);border-radius:14px;background:var(--surface);overflow:hidden}
.example-header{padding:18px 22px;background:var(--surface2)}
.example-header h3{font-size:15px;overflow-wrap:anywhere}
.example-header p{margin:8px 0 0;font-size:16px;overflow-wrap:anywhere}
.pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.pair-arm{min-width:0;padding:22px}
.pair-arm+.pair-arm{border-left:1px solid var(--line)}
.arm-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}
.arm-head h4{font-size:16px;margin:0}
.answer{white-space:pre-wrap;overflow-wrap:anywhere;font:16px/1.8 var(--sans);margin:14px 0 18px}
.sample-facts{padding-top:12px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
.sample-facts p{margin:5px 0}
.sample-checks{list-style:none;padding:0;margin:10px 0;display:grid;gap:10px}
.sample-checks li{overflow-wrap:anywhere;font-size:13px}
.sample-checks p{font-size:12px;margin:4px 0 0;color:var(--muted)}
.sample-link{display:inline-block;margin-top:12px;font-size:13px;font-weight:600}
.replay-link{display:inline-flex;align-items:center;gap:10px;padding:11px 16px;border:1px solid var(--accent);border-radius:8px;background:var(--accent-soft);color:var(--accent);font-size:14px;font-weight:650;margin:12px 0;text-decoration:none}
.replay-link:hover{filter:brightness(1.08);text-decoration:none}
.finding{padding:18px 22px;border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:10px;background:var(--surface);font-size:17px;margin-bottom:14px}
.finding p:last-child{margin-bottom:0}
.section-head{display:flex;justify-content:space-between;gap:16px;align-items:baseline;margin-bottom:12px}
.no-sample{padding:22px;color:var(--muted)}
@media (max-width:720px){.wrap{padding:24px 16px 40px}.stat b{font-size:20px}.pair{grid-template-columns:1fr}.pair-arm+.pair-arm{border-left:0;border-top:1px solid var(--line)}.pair-arm,.example-header{padding:18px}.topbar{padding:10px 16px}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.nav{flex-wrap:wrap}}
@media print{.topbar{position:static}.wrap{max-width:none;padding:20px 0}.filters{display:none}.scroll{max-height:none;overflow:visible}.example,.turn,.card{break-inside:avoid}}
`.trim();

export interface PageOptions {
	title: string;
	/** Breadcrumb links, rendered left to right in the top bar. */
	crumbs: Array<{ label: string; href?: string }>;
	body: string;
	/** Inline script body. Rendered verbatim inside a <script> element. */
	script?: string;
	/** Trusted, page-specific stylesheet. */
	styles?: string;
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
<style>${EVIDENCE_STYLESHEET}${options.styles ?? ""}</style>
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
	return `<span class="chip ${outcome}">${h(t(`evidence.${outcome}`))}</span>`;
}

function scoreCell(row: RunRow): string {
	return percent(row.score);
}

function graderChips(row: RunRow): string {
	if (row.graders.length === 0) return `<span class="gchip">${h(t("evidence.noGraders"))}</span>`;
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
		return `<div class="scroll"><div class="empty">${h(t("evidence.noRuns"))}</div></div>`;
	}
	const body = rows.map((row) => `<tr data-row${options.dataRun ? ` data-run="${h(row.runId)}"` : ""} data-outcome="${h(row.outcome)}" data-modes="${h(row.failureModeIds.join(" "))}" data-text="${h(`${row.taskId} ${row.runId} ${row.inputPreview ?? ""}`.toLowerCase())}">`
		+ `<td class="mono"><a href="${h(options.hrefForRun(row.runId))}">${h(row.taskId)}</a></td>`
		+ `<td class="num">${row.repetitionIndex}</td>`
		+ `<td class="wrapcell">${row.inputPreview === null ? `<span class="same">${h(t("evidence.traceUnavailable"))}</span>` : h(row.inputPreview)}</td>`
		+ `<td>${outcomeChip(row.outcome)}</td>`
		+ `<td class="num">${scoreCell(row)}</td>`
		+ `<td class="wrapcell">${graderChips(row)}</td>`
		+ `<td class="wrapcell">${modeCell(row, options)}</td>`
		+ `<td class="num">${h(t("evidence.executedCount", { count: row.metrics.toolCalls }))}${row.metrics.reportedToolCalls > 0 ? ` / ${h(t("evidence.reportedCount", { count: row.metrics.reportedToolCalls }))}` : ""}${row.metrics.toolErrors > 0 ? ` / ${h(t("evidence.errorCount", { count: row.metrics.toolErrors }))}` : ""}</td>`
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
		if(count)count.textContent=(count.getAttribute('data-template')||'{shown} of {total} rows').replace('{shown}',String(shown)).replace('{total}',String(rows.length));
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
	costUsd: number | null;
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
		[t("evidence.passRate"), percent(model.summary.allPassRate)],
		[t("evidence.passed"), `${model.summary.pass}/${model.summary.total}`],
		[t("evidence.meanScore"), percent(model.meanScore)],
		[t("evidence.errors"), String(model.summary.error)],
		[t("evidence.failureModes"), String(model.modes.length)],
		[t("explorer.th.cost"), money(model.costUsd, 4)],
	].map(([label, value]) => `<div class="stat"><b>${h(value)}</b><span>${h(label)}</span></div>`).join("");

	const modes = model.modes.length === 0
		? `<div class="card">${h(t("evidence.noModes"))}</div>`
		: `<ul class="modes">${model.modes.map((mode) => `<li>
<div class="row"><h3><a href="${h(mode.href)}">${h(mode.title)}</a></h3><span class="count">${h(t("explorer.mode-count", { runs: mode.runCount, affected: mode.affectedTasks, total: mode.totalTasks, reproduction: Math.round(mode.reproductionBps / 100) }))}</span></div>
<div class="pills"><span class="pill">${h(tokenLabel("mode.scope", mode.scope))}</span><span class="pill">${h(tokenLabel("mode.severity", mode.severity))}</span><span class="pill">${h(tokenLabel("mode.decision", mode.decision))}</span></div>
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
		<div class="sub">${h(t("evidence.design", model.design))} · ${h(model.startedAt)}</div>
		${model.model ? `<div class="sub">${h(t("evidence.model"))}: ${h(model.model)}</div>` : ""}
	</div>
	<div class="pills">
		<span class="tag">${h(model.visibility)}</span>
		<span class="tag">${h(model.purpose)}</span>
		<span class="tag mono">${h(model.revision.slice(0, 12))}</span>
		<span class="tag">${h(model.briefStatus)}</span>
	</div>
</div>
<details class="metadata"><summary>${h(t("evidence.metadata"))}</summary><pre>${h(model.evalRunId)} · ${h(model.label)}
${h(model.suiteId)} · ${h(t("evidence.dataset"))}: ${h(model.dataset)}</pre></details>
<div class="stats">${stats}</div>
<section class="prose">
	<p>${h(model.briefHeadline)}</p>
	<p class="note">${model.proposalEligible
		? h(t("evidence.proposalEligible"))
		: h(t("evidence.proposalBlocked"))}</p>
	${model.judgeCalibration.map((line) => `<p class="note">${h(line)}</p>`).join("")}
</section>
<section><h2>${h(t("explorer.h2.failure-modes"))}</h2>${modes}</section>
${candidates}
<section>
	<h2>${h(t("explorer.h2.runs"))}</h2>
	<div class="filters">
		<input id="filter" type="search" placeholder="${h(t("evidence.filterPlaceholder"))}" aria-label="${h(t("evidence.filterLabel"))}">
		<span class="count" id="filter-count" data-template="${h(t("evidence.filterCount"))}"></span>
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
			{ label: t("evidence.brand"), href: "/" },
			{ label: model.targetId },
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
		return `<div class="card">${h(t("evidence.noTrace"))}</div>`;
	}
	const entries = model.transcript.entries.map((entry) => {
		if (entry.kind === "user") {
			return `<article class="turn"><div class="who"><span>${h(t("evidence.user"))}</span></div><pre class="spoken">${h(entry.text)}</pre></article>`;
		}
		if (entry.kind === "assistant") {
			const thinking = entry.thinking
				? `<details><summary>${h(t("evidence.thinking"))}</summary><pre>${h(entry.thinking)}</pre></details>`
				: "";
			return `<article class="turn${entry.final ? " final" : ""}"><div class="who"><span>${h(t("evidence.assistant"))}${entry.final ? ` · ${h(t("evidence.finalAnswer"))}` : ""}</span></div>`
				+ (entry.text ? `<pre class="spoken">${h(entry.text)}</pre>` : "")
				+ thinking
				+ `</article>`;
		}
		const duration = entry.durationMs === null ? "" : ` · ${(entry.durationMs / 1000).toFixed(2)}s`;
		const status = entry.evidence === "reported" ? t("evidence.reportedOnly")
			: entry.result === null ? t("evidence.noResult") : entry.isError ? t("evidence.error") : t("evidence.ok");
		return `<article class="turn${entry.isError ? " toolerr" : ""}"><div class="who"><span>${h(t("evidence.tool"))} · ${h(entry.name)}</span><span>${h(status)}${h(duration)}</span></div>`
			+ `<details><summary>${h(t("evidence.arguments"))}</summary><pre>${h(entry.args)}</pre></details>`
			+ (entry.result === null
				? ""
				: `<details><summary>${h(t("evidence.result"))}${entry.resultTruncated ? ` (${h(t("evidence.clipped"))})` : ""}</summary><pre>${h(entry.result)}</pre></details>`)
			+ `</article>`;
	}).join("");
	return entries || `<div class="card">${h(t("evidence.noTurns"))}</div>`;
}

function renderVerdict(graders: readonly GraderFinding[]): string {
	if (graders.length === 0) return `<div class="card">${h(t("evidence.noGraderResults"))}</div>`;
	return graders.map((grader) => {
		const assertions = grader.assertionVerdicts
			? `<div class="scroll"><table><thead><tr><th>${h(t("explorer.th.index"))}</th><th>${h(t("explorer.th.answer"))}</th><th>${h(t("explorer.th.judge-evidence"))}</th></tr></thead><tbody>${grader.assertionVerdicts.map((assertion) => `<tr><td class="num">${assertion.index}</td><td><span class="chip ${assertion.answer === "yes" ? "pass" : assertion.answer === "no" ? "fail" : "error"}">${h(assertion.answer)}</span></td><td class="wrapcell">${h(assertion.evidence)}</td></tr>`).join("")}</tbody></table></div>`
			: grader.assertions
				? `<p class="note">${h(t("evidence.assertionsSummary", { passed: grader.assertions.passed, total: grader.assertions.total }))}</p>`
				: "";
		const jury = grader.jury
			? `<p class="note">${h(t("evidence.jury"))}: ${h(grader.jury.map((vote) => `${t("evidence.juror")} ${vote.juror} ${t(vote.passed ? "evidence.pass" : "evidence.fail")}${vote.choice ? ` (${vote.choice})` : ""}${vote.answers ? ` [${vote.answers.map((answer) => tokenLabel("assertion.answer", answer)).join(", ")}]` : ""}`).join(" · "))}</p>`
			: "";
		return `<div class="card">
<div class="rowline">
	<h3 class="mono">${h(grader.name)}</h3>
	<span>${outcomeChip(grader.passed ? "pass" : "fail")} <span class="gchip">${h(grader.type)} ${h(grader.chip)}</span> <span class="gchip">${h(t("explorer.th.score"))} ${grader.score.toFixed(2)}</span>${grader.choice ? ` <span class="gchip">${h(t("evidence.choice"))} ${h(grader.choice)}</span>` : ""}</span>
</div>
<p class="sub">${h(grader.reason)}</p>
${assertions}${jury}
</div>`;
	}).join("");
}

function renderWhy(explanation: RunExplanation): string {
	return `<div class="why">${renderRunExplanationText(explanation).map((sentence) => `<p>${h(sentence)}</p>`).join("")}
<p class="note">${h(t("evidence.hostNote"))}</p></div>`;
}

const MAX_RENDERED_RAG_SEARCHES = 8;
const MAX_RENDERED_RAG_HITS = 5;
const MAX_RENDERED_RAG_SOURCE_IDS = 8;

function ragRate(value: number | null): string {
	return value === null ? t("metrics.not-reported") : percent(value);
}

function ragSources(ids: readonly string[]): string {
	if (ids.length === 0) return t("rag.none");
	const shown = ids.slice(0, MAX_RENDERED_RAG_SOURCE_IDS).map((id) => `<span class="tag mono">${h(id)}</span>`);
	if (ids.length > shown.length) shown.push(`<span class="sub">${h(t("rag.more", { count: ids.length - shown.length }))}</span>`);
	return shown.join(" ");
}

/** Compact, text-free retrieval evidence for a verified run. */
export function renderRagXray(rag: RagRunXray): string {
	const searches = rag.searches.slice(0, MAX_RENDERED_RAG_SEARCHES).map((search, index) => {
		const hits = search.hits.slice(0, MAX_RENDERED_RAG_HITS);
		const rows = hits.map((hit) => `<tr>
	<td class="num">${hit.rank}</td>
	<td class="mono wrapcell">${h(hit.chunkId)}</td>
	<td class="mono wrapcell">${h(hit.path ?? t("rag.path-missing"))}</td>
	<td class="num">${hit.score === null ? h(t("metrics.not-reported")) : hit.score.toFixed(3)}</td>
	<td>${h(t(hit.expected ? "regrade.yes" : "regrade.no"))}</td>
	<td>${h(t(hit.cited ? "regrade.yes" : "regrade.no"))}</td>
	<td class="num">${ragRate(hit.answerOverlap)}</td>
</tr>`).join("");
		const hitNote = search.hits.length > hits.length
			? `<p class="note">${h(t("rag.hits-omitted", { count: search.hits.length - hits.length }))}</p>`
			: "";
		const hitTable = rows.length === 0
			? `<p class="note">${h(t("rag.no-readable-chunks"))}</p>`
			: `<div class="scroll"><table><thead><tr><th>${h(t("explorer.th.index"))}</th><th>${h(t("rag.table.chunk"))}</th><th>${h(t("rag.table.path"))}</th><th>${h(t("rag.table.score"))}</th><th>${h(t("rag.table.expected"))}</th><th>${h(t("rag.table.cited"))}</th><th>${h(t("rag.table.overlap"))}</th></tr></thead><tbody>${rows}</tbody></table></div>${hitNote}`;
		return `<details class="turn"${index === 0 ? " open" : ""}><summary>${h(t("rag.search-summary", {
			index: index + 1,
			status: tokenLabel("rag.search-status", search.status),
			k: search.requestedK ?? t("metrics.not-reported"),
			duration: search.durationMs === null ? t("metrics.not-reported") : `${Math.round(search.durationMs)}ms`,
		}))}</summary>
	<p><b>${h(t("rag.query"))}:</b> <span class="mono">${h(search.query ?? t("rag.query-not-recorded"))}</span></p>
	<p class="sub">${h(t("rag.search-metrics", {
		hitAtK: ragRate(search.hitAtK),
		rank: search.reciprocalRank === null ? t("metrics.not-reported") : search.reciprocalRank.toFixed(3),
	}))}</p>
	${hitTable}
</details>`;
	}).join("");
	const hiddenSearches = Math.max(0, rag.searchCount - Math.min(rag.searches.length, MAX_RENDERED_RAG_SEARCHES));
	return `<div class="card">
	<div class="rowline"><h3>${h(t("rag.diagnosis-line", { diagnosis: tokenLabel("rag.diagnosis", rag.diagnosis) }))}</h3><span class="chip ${rag.diagnosis === "retrieved-and-cited" || rag.diagnosis === "retrieved-and-supported" ? "pass" : rag.diagnosis === "unlabelled" || rag.diagnosis === "retrieval-unknown" ? "error" : "fail"}">${h(tokenLabel("rag.label-status", rag.labelStatus))}</span></div>
	<p class="sub">${h(t("rag.summary", {
		searches: plural(rag.searchCount, "search"),
		hitAtK: ragRate(rag.hitAtK),
		mrr: rag.mrr === null ? t("metrics.not-reported") : rag.mrr.toFixed(3),
		citation: ragRate(rag.citationRate),
		grounding: ragRate(rag.groundingPassRate),
	}))} · ${h(t("rag.resources", {
		latency: rag.retrievalLatencyMs === null ? t("metrics.not-reported") : `${Math.round(rag.retrievalLatencyMs)}ms`,
		cost: rag.retrievalCostUsd === null ? t("metrics.not-reported") : "$0.00",
		coverage: ragRate(rag.scoreCoverage),
	}))}</p>
	<p><b>${h(t("rag.source.expected"))}:</b> ${ragSources(rag.expectedChunkIds)}</p>
	<p><b>${h(t("rag.source.retrieved"))}:</b> ${ragSources(rag.retrievedChunkIds)}</p>
	<p><b>${h(t("rag.source.cited"))}:</b> ${ragSources(rag.citedChunkIds)}</p>
	<p class="note">${h(t("rag.faithfulness-note"))}</p>
	${searches || `<p class="note">${h(t("rag.no-search"))}</p>`}
	${hiddenSearches > 0 ? `<p class="note">${h(t("rag.searches-omitted", { searches: plural(hiddenSearches, "search") }))}</p>` : ""}
</div>`;
}

export function renderRunDetailPage(model: RunDetailPageModel): string {
	const run = model.run;
	const body = `
<div class="head">
	<div>
		<h1>${h(run.taskId)} <span class="sub">${h(t("explorer.repetition", { index: run.repetitionIndex }))}</span></h1>
		<p class="lead">${h(model.input === null ? t("evidence.noInput") : model.input.slice(0, 220) + (model.input.length > 220 ? "…" : ""))}</p>
	</div>
	<div class="pills">
		${outcomeChip(run.outcome)}
		<span class="tag mono">${h(model.revision.slice(0, 12))}</span>
	</div>
</div>
<div class="stats">
	<div class="stat"><b>${(run.metrics.latencyMs / 1000).toFixed(1)}${h(t("unit.second-short"))}</b><span>${h(t("explorer.th.latency"))}</span></div>
	<div class="stat"><b>${run.metrics.toolCalls}</b><span>${h(t("evidence.executedTools"))}</span></div>
	${run.metrics.reportedToolCalls > 0 ? `<div class="stat"><b>${run.metrics.reportedToolCalls}</b><span>${h(t("evidence.reportedTools"))}</span></div>` : ""}
	<div class="stat"><b>${run.metrics.toolErrors}</b><span>${h(t("evidence.toolErrors"))}</span></div>
	<div class="stat"><b>${count(run.metrics.tokens)}</b><span>${h(t("explorer.th.tokens"))}</span></div>
	<div class="stat"><b>${money(run.metrics.costUsd, 5)}</b><span>${h(t("explorer.th.cost"))}</span></div>
</div>
<details class="metadata"><summary>${h(t("evidence.metadata"))}</summary><pre>${h(run.runId)} · ${h(model.evalRunId)} · ${h(model.label)}
${h(run.startedAt)}${run.finishedAt ? ` → ${h(run.finishedAt)}` : ""}</pre></details>
<section><h2>${h(t("explorer.h2.why"))}</h2>${renderWhy(model.explanation)}</section>
${model.explanation.rag ? `<section><h2>${h(t("rag.title"))}</h2>${renderRagXray(model.explanation.rag)}</section>` : ""}
${run.error ? `<section><h2>${h(t("explorer.h2.run-error"))}</h2><div class="card"><pre class="errpre">${h(run.error)}</pre></div></section>` : ""}
<section><h2>${h(t("explorer.h2.verdict"))}</h2><div class="cards">${renderVerdict(model.graders)}</div></section>
<section>
	<h2>${h(t("explorer.h2.conversation"))}</h2>
	<details class="turn"><summary>${h(t("evidence.systemInstructions"))}</summary><pre>${h(t("evidence.systemUnavailable"))}</pre></details>
	${model.input === null ? "" : `<details class="turn" open><summary>${h(t("evidence.caseInput"))}</summary><pre>${h(model.input)}</pre></details>`}
	${renderTranscript(model)}
	<p class="note">${h(model.traceNotice)}</p>
</section>
<nav class="nav">
	<span>${model.prev ? `<a href="/runs/${encodeURIComponent(model.prev.runId)}">← ${h(model.prev.taskId)} ${h(t("explorer.repetition", { index: model.prev.repetitionIndex }))}</a>` : ""}</span>
	<span><a href="/evals/${encodeURIComponent(model.evalRunId)}">${h(t("evidence.allRuns"))}</a></span>
	<span>${model.next ? `<a href="/runs/${encodeURIComponent(model.next.runId)}">${h(model.next.taskId)} ${h(t("explorer.repetition", { index: model.next.repetitionIndex }))} →</a>` : ""}</span>
</nav>`;
	return renderPage({
		title: `${run.taskId} · ${run.runId}`,
		crumbs: [
			{ label: t("evidence.brand"), href: "/" },
			{ label: model.evalRunId, href: `/evals/${encodeURIComponent(model.evalRunId)}` },
			{ label: run.runId },
		],
		body,
	});
}

// ---------- Compare page ----------

export interface ComparePageRow {
	taskId: string;
	exclusion: ExcludedTask["reason"] | null;
	flip: CandidateFlip;
	baselineScore: number;
	candidateScore: number;
	scoreDelta: number;
	baselineRunId: string | null;
	candidateRunId: string | null;
}

/** A bounded excerpt of one verified, public recorded repetition. */
export interface CompareRunPreview {
	runId: string;
	repetitionIndex: number;
	outcome: RunRow["outcome"];
	input: string | null;
	answer: string | null;
	toolCalls: number;
	reportedToolCalls: number;
	toolNames: string[];
	checks: Array<{ name: string; passed: boolean; reason: string }>;
	omittedChecks: number;
}

export interface CompareCasePreview {
	taskId: string;
	exclusion: ExcludedTask["reason"] | null;
	baselineScore: number;
	candidateScore: number;
	scoreDelta: number;
	baseline: CompareRunPreview | null;
	candidate: CompareRunPreview | null;
}

export interface ComparePageModel {
	comparability: "comparable" | "invalid" | "inconclusive";
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
	sealed: { verdict: string; outcome: SealedOutcome | null; tasks: number; repetitions: number; excludedTasks: number } | null;
	rows: ComparePageRow[];
	examples: CompareCasePreview[];
	counts: { improved: number; regressed: number; unchanged: number };
	notices: string[];
}

function renderCompareArm(preview: CompareRunPreview | null, label: string): string {
	if (!preview) return `<div class="pair-arm"><h4>${h(label)}</h4><p class="no-sample">${h(t("evidence.noSample"))}</p></div>`;
	const tools = preview.toolCalls > 0
		? `${t("evidence.executedTools")}: ${preview.toolCalls} · ${preview.toolNames.join(", ") || t("evidence.noToolsTrace")}`
		: t("evidence.noTools");
	return `<div class="pair-arm">
<div class="arm-head"><h4>${h(label)}</h4>${outcomeChip(preview.outcome)}</div>
<p class="answer">${h(preview.answer ?? t("evidence.noAnswer"))}</p>
<div class="sample-facts"><p>${h(tools)}</p>${preview.reportedToolCalls > 0 ? `<p>${h(t("evidence.reportedTools"))}: ${preview.reportedToolCalls}</p>` : ""}</div>
${preview.checks.length > 0 ? `<details><summary>${h(t("evidence.checks"))}</summary><ul class="sample-checks">${preview.checks.map((check) => `<li>${outcomeChip(check.passed ? "pass" : "fail")} <b>${h(check.name)}</b><p>${h(check.reason)}</p></li>`).join("")}</ul></details>` : ""}
${preview.omittedChecks > 0 ? `<p class="note">${h(t("evidence.moreChecks", { count: preview.omittedChecks }))}</p>` : ""}
<a class="sample-link" href="/runs/${encodeURIComponent(preview.runId)}">${h(t("evidence.openRun"))} →</a>
</div>`;
}

function scoreDirection(delta: number): "regressed" | "improved" | "unchanged" {
	return delta < 0 ? "regressed" : delta > 0 ? "improved" : "unchanged";
}

function renderCompareExamples(model: ComparePageModel): string {
	if (model.examples.length === 0) return "";
	return `<section aria-labelledby="examples-title">
<div class="section-head"><h2 id="examples-title">${h(t("evidence.examples"))}</h2></div>
<p class="note">${h(t("evidence.exampleNote", { shown: model.examples.length, total: model.rows.length }))}</p>
<div class="examples">${model.examples.map((example) => {
		const invalid = model.comparability === "invalid";
		const direction = scoreDirection(example.scoreDelta);
		return `<article class="example">
<div class="example-header"><div class="rowline"><h3>${h(example.taskId)}</h3><span class="${invalid || example.exclusion ? "same" : direction === "regressed" ? "down" : direction === "improved" ? "up" : "same"}">${invalid ? h(t("evidence.notComparable")) : example.exclusion ? h(t(`evidence.excluded-${example.exclusion}`)) : `${h(t(`evidence.${direction}`))} · ${h(points(example.scoreDelta))}`}</span></div>
<p>${h(example.baseline?.input ?? example.candidate?.input ?? t("evidence.noInput"))}</p>
${example.baseline && example.candidate ? `<a class="replay-link" href="/candidates/${encodeURIComponent(model.candidateId)}/replay?run=${encodeURIComponent(example.baseline.runId)}">${h(t("evidence.replayOpen"))} →</a>` : ""}
<div class="sub">${invalid ? h(t("evidence.invalidComparison")) : example.exclusion ? h(t("evidence.excludedNote")) : `${h(t("evidence.changedScore"))}: ${percent(example.baselineScore)} → ${percent(example.candidateScore)}`}</div></div>
<div class="pair">${renderCompareArm(example.baseline, t("evidence.baseline"))}${renderCompareArm(example.candidate, t("evidence.candidate"))}</div>
</article>`;
	}).join("")}</div></section>`;
}

export function renderComparePage(model: ComparePageModel): string {
	const invalid = model.comparability === "invalid";
	const rows = model.rows.map((row) => `<tr>
<td class="mono">${h(row.taskId)}</td>
<td>${row.baselineRunId ? `<a href="/runs/${encodeURIComponent(row.baselineRunId)}">${h(row.flip.before)}</a>` : h(row.flip.before)} <span class="count">${row.flip.baselinePass}/${row.flip.baselineTotal}</span></td>
<td>${row.candidateRunId ? `<a href="/runs/${encodeURIComponent(row.candidateRunId)}">${h(row.flip.after)}</a>` : h(row.flip.after)} <span class="count">${row.flip.candidatePass}/${row.flip.candidateTotal}</span></td>
<td class="num">${invalid || row.exclusion ? "—" : `${percent(row.baselineScore)} → ${percent(row.candidateScore)}`}</td>
<td class="num ${row.scoreDelta > 0 ? "up" : row.scoreDelta < 0 ? "down" : "same"}">${invalid || row.exclusion ? "—" : h(points(row.scoreDelta))}</td>
<td class="${invalid || row.exclusion ? "same" : row.scoreDelta > 0 ? "up" : row.scoreDelta < 0 ? "down" : "same"}">${invalid ? h(t("evidence.notComparable")) : row.exclusion ? h(t(`evidence.excluded-${row.exclusion}`)) : `${row.scoreDelta > 0 ? "↑" : row.scoreDelta < 0 ? "↓" : "="} ${h(t(`evidence.${scoreDirection(row.scoreDelta)}`))}`}</td>
</tr>`).join("");
	const body = `
<div class="head">
	<div>
		<div class="sub">${h(model.targetId)}</div>
		<h1>${h(t("evidence.comparison"))}</h1>
		<p class="lead">${h(t("evidence.comparisonIntro"))}</p>
		${model.examples.some(example => example.baseline && example.candidate) ? `<a class="replay-link" href="/candidates/${encodeURIComponent(model.candidateId)}/replay">${h(t("evidence.replayOpen"))} →</a>` : ""}
	</div>
	<div class="pills"><span class="tag">${h(candidateStatusLabel(model.status))}</span></div>
</div>
<div class="finding"><p>${h(model.developmentLine)}</p>${invalid ? model.notices.map(notice => `<p class="note">${h(notice)}</p>`).join("") : ""}</div>
<div class="stats">
	<div class="stat"><b>${percent(model.baseline.passRate)} → ${percent(model.candidate.passRate)}</b><span>${h(t("evidence.allPassRate"))}</span></div>
	<div class="stat"><b>${invalid ? "—" : `${model.counts.improved} ↑ / ${model.counts.regressed} ↓ / ${model.counts.unchanged} =`}</b><span>${h(t("evidence.taskFlips"))}</span></div>
	<div class="stat"><b>${ratio(invalid ? null : model.resources.costRatio)}</b><span>${h(t("evidence.costRatio"))}</span></div>
	<div class="stat"><b>${ratio(invalid ? null : model.resources.latencyRatio)}</b><span>${h(t("evidence.latencyRatio"))}</span></div>
	<div class="stat"><b>${ratio(invalid ? null : model.resources.tokenRatio)}</b><span>${h(t("evidence.tokenRatio"))}</span></div>
</div>
<section>
	${model.sealed
		? `<p><b>${h(t("evidence.sealed"))}: ${h(verdictLabel(model.sealed.verdict))}</b>${model.sealed.outcome ? ` · ${h(sealedOutcomeLabel(model.sealed.outcome))}` : model.sealed.verdict === "pass" ? ` · ${h(t("evidence.sealedUnknown"))}` : ""} · ${h(t("evidence.sealedDesign", { tasks: model.sealed.tasks, repetitions: model.sealed.repetitions }))}${model.sealed.excludedTasks > 0 ? ` · ${h(t("evidence.sealedExcluded", { count: model.sealed.excludedTasks }))}` : ""}</p><p class="note">${h(t("evidence.sealedNote"))}</p>`
		: `<p class="note">${h(t("evidence.noSealed"))}</p>`}
</section>
<details class="metadata"><summary>${h(t("evidence.metadata"))}</summary><pre>${h(model.candidateId)}
${h(model.baseline.evalRunId)} (${h(model.baseline.revision.slice(0, 12))}) → ${h(model.candidate.evalRunId)} (${h(model.candidate.revision.slice(0, 12))})</pre><p class="note">${h(t("evidence.recordedReasons"))}</p>${model.developmentReasons.map((reason) => `<p class="note">${h(reason)}</p>`).join("")}</details>
${renderCompareExamples(model)}
<section>
	<h2>${h(t("explorer.h2.per-task"))}</h2>
	<div class="scroll"><table><thead><tr><th>${h(t("explorer.th.task"))}</th><th>${h(t("explorer.th.baseline"))}</th><th>${h(t("explorer.th.candidate"))}</th><th>${h(t("explorer.th.score"))}</th><th>${h(t("explorer.th.delta"))}</th><th>${h(t("explorer.th.flip"))}</th></tr></thead><tbody>${rows}</tbody></table></div>
	${model.notices.length > 0 ? `<details class="metadata"><summary>${h(t("evidence.comparisonNotices", { count: model.notices.length }))}</summary>${model.notices.map((notice) => `<p class="note">${h(notice)}</p>`).join("")}</details>` : ""}
	<p class="note">${h(t("evidence.flipNote"))}</p>
</section>`;
	return renderPage({
		title: `${model.targetId} · ${model.candidateId}`,
		crumbs: [
			{ label: t("evidence.brand"), href: "/" },
			{ label: model.candidateId },
		],
		body,
	});
}
