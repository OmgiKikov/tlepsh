import type { TranscriptEntry } from "../application/run-explanation.js";
import { percent } from "../measurement.js";
import { t } from "../i18n.js";
import { h, renderPage } from "./pages.js";
import type { CandidateReplayPageModel, ReplayRun } from "./replay-model.js";

const STYLES = `
.replay{--lane-height:360px}
.replay [hidden]{display:none!important}
.replay button,.replay input{font:inherit}
.replay button,.replay .r-link{border:1px solid var(--line-strong);border-radius:8px;padding:9px 13px;background:var(--surface);color:var(--text);cursor:pointer;font-size:13px;line-height:1.35}
.replay button:hover,.replay .r-link:hover{background:var(--accent-soft);border-color:var(--accent);text-decoration:none}
.replay button:focus-visible,.replay a:focus-visible,.replay:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.replay button:disabled{opacity:.4;cursor:default}
.replay .r-primary{background:var(--accent);border-color:var(--accent);color:var(--bg);font-weight:650}
.r-eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--accent);font-weight:700;margin:0 0 14px}
.r-hero{padding:16px 0 22px;max-width:900px}
.r-hero h1{font-size:clamp(32px,4.8vw,58px);letter-spacing:-.045em;max-width:900px}
.r-hero .lead{font-size:18px;margin-top:16px}
.r-suite{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:26px;align-items:center;border:1px solid var(--line);border-radius:14px;padding:20px 24px;margin:0 0 26px;background:var(--surface)}
.r-suite p{margin:4px 0 0;font-size:14px;overflow-wrap:anywhere}
.r-suite .r-summary{font-size:13px;color:var(--muted);max-width:84ch}
.r-regressions{text-align:right;min-width:100px}
.r-regressions strong{display:block;font-size:32px;line-height:1.2;font-weight:600}
.r-regressions small{font-size:11px}
.r-pick{position:relative;border:1px solid var(--line-strong);border-radius:10px;margin:0 0 24px;background:var(--surface)}
.r-pick>summary{padding:13px 17px;font-size:14px;color:var(--text)}
.r-pick input{display:block;width:calc(100% - 32px);margin:4px 16px 12px;border:1px solid var(--line);border-radius:7px;padding:10px;background:var(--bg);color:var(--text)}
.r-choices{margin:0;padding:0 12px 12px;list-style:none;max-height:300px;overflow:auto;display:grid;gap:3px}
.r-choices a{display:flex;justify-content:space-between;gap:20px;padding:9px 12px;color:var(--text);border-radius:6px;font-size:13px;overflow-wrap:anywhere}
.r-choices a:hover,.r-choices a[aria-current]{background:var(--accent-soft);text-decoration:none}
.r-choices small{flex-shrink:0;color:var(--muted)}
.r-case{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;margin:30px 0 18px;flex-wrap:wrap}
.r-case h2{font-size:23px;letter-spacing:-.02em;overflow-wrap:anywhere}
.r-case p{margin:6px 0 0}
.r-repeat{font-size:12px;color:var(--muted)}
.r-input{font-size:19px;white-space:pre-wrap;overflow-wrap:anywhere;max-width:84ch;padding:0 0 22px;line-height:1.6}
.r-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.r-controls .r-link{margin-left:auto}
.r-help{font-size:12px;color:var(--muted);margin:12px 0;max-width:100ch}
.r-lanes{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start}
.r-lane{min-width:0;border:1px solid var(--line);border-radius:14px;background:var(--surface);overflow:hidden}
.r-lane-header{padding:19px 22px 15px;display:flex;justify-content:space-between;gap:12px;align-items:center;background:var(--surface2)}
.r-lane-header h3{font-size:19px;margin:0;font-weight:600}
.r-track{padding:12px 14px;display:flex;gap:5px;overflow:auto;border-bottom:1px solid var(--line);scrollbar-width:thin}
.r-track button{flex:0 0 auto;padding:6px 10px;border:0;font-size:11px;color:var(--muted)}
.r-track button[aria-current]{background:var(--accent-soft);color:var(--accent);outline:1px solid var(--accent)}
.r-stage{padding:24px 24px 18px}
.replay[data-enhanced] .r-stage{min-height:var(--lane-height)}
.r-step{animation:r-appear .16s ease-out}
.r-step+.r-step{margin-top:28px;padding-top:22px;border-top:1px solid var(--line)}
.replay[data-mode=steps] .r-step+.r-step{margin:0;padding:0;border:0}
.r-step-head{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:17px}
.r-step-head .chip{letter-spacing:0;text-transform:none}
.r-spoken{white-space:pre-wrap;overflow-wrap:anywhere;font:18px/1.75 var(--sans);margin:0}
.r-step[data-kind=tool] .r-spoken{font-family:var(--mono);font-size:12px}
.r-tool-name{font:600 19px/1.5 var(--mono);overflow-wrap:anywhere;margin:0 0 16px}
.r-tool-result{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 var(--mono);background:var(--sunken);border:1px solid var(--line);padding:14px;border-radius:8px;max-height:280px;overflow:auto;margin:10px 0}
.r-tool-details{border:0;margin-top:10px}
.r-tool-details>summary{padding:6px 0;font-size:12px}
.r-terminal{color:var(--muted);padding:30px 0}
.r-lane-footer{border-top:1px solid var(--line);padding:12px 18px;display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12px;color:var(--muted)}
.r-lane-footer button{padding:5px 10px;font-size:14px}
.r-lane-meta{font-size:11px;padding:12px 20px;color:var(--muted);overflow-wrap:anywhere}
.r-lane-meta a{display:inline-block;margin-top:7px}
.r-check-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;margin-top:16px}
.r-checks{list-style:none;padding:0;margin:0;display:grid;gap:10px}
.r-checks li{padding:14px 16px;border:1px solid var(--line);border-radius:9px;overflow-wrap:anywhere;background:var(--surface);font-size:13px}
.r-checks p{font-size:12px;color:var(--muted);margin:7px 0 0}
.r-proof{margin-top:32px}
.r-proof h2{font-size:20px;margin-bottom:12px}
.r-diff{border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:16px 20px}
.r-diff summary{padding:4px 0 14px;color:var(--text);font-size:14px}
.r-diff pre{margin:0;max-height:480px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.75 var(--mono)}
.r-diff .add{color:var(--pass)}
.r-diff .remove{color:var(--fail)}
.r-js{display:none!important}
.replay[data-enhanced] .r-js{display:flex!important}
.replay[data-enhanced] .r-track{display:flex!important}
.r-trace-note{margin:0;padding:12px 20px;color:var(--error);font-size:12px}
@keyframes r-appear{from{opacity:.45;transform:translateY(3px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.r-step{animation:none}}
@media(max-width:720px){.r-lanes,.r-check-grid{grid-template-columns:1fr}.r-suite{padding:17px;gap:14px;grid-template-columns:1fr}.r-regressions{display:flex;align-items:baseline;gap:8px;text-align:left}.r-regressions strong{font-size:26px}.r-hero{padding-top:4px}.r-controls .r-link{margin-left:0}.r-stage{padding:20px}.r-spoken{font-size:17px}.replay[data-enhanced] .r-stage{min-height:230px}.r-case{margin-top:24px;gap:10px}.r-lane-header{padding:16px 20px}}
@media print{.r-js,.r-pick{display:none!important}.replay [data-step][hidden]{display:block!important}.r-lanes{display:block}.r-lane{margin-bottom:20px}.r-step{break-inside:avoid}.r-stage{min-height:0!important}}
`;

function kind(entry: TranscriptEntry): string {
	if (entry.kind === "assistant") return t(entry.final ? "evidence.finalAnswer" : "evidence.assistant");
	return t(entry.kind === "user" ? "evidence.user" : "evidence.tool");
}

function chip(outcome: "pass" | "fail" | "error"): string {
	return `<span class="chip ${outcome}">${h(t(`evidence.${outcome}`))}</span>`;
}

/** Compare visible recorded content, not timestamps or private reasoning. This is not causal alignment. */
function visibleEntry(entry: TranscriptEntry): string {
	if (entry.kind === "tool") return JSON.stringify([entry.kind, entry.name, entry.args, entry.result, entry.evidence ?? "executed", entry.isError]);
	return JSON.stringify([entry.kind, entry.text]);
}

function firstDifference(model: CandidateReplayPageModel): number | null {
	const before = model.selected.baseline.transcript;
	const after = model.selected.candidate.transcript;
	if (!before || !after) return null;
	const size = Math.max(before.entries.length, after.entries.length);
	for (let i = 0; i < size; i++) {
		if (!before.entries[i] || !after.entries[i] || visibleEntry(before.entries[i]!) !== visibleEntry(after.entries[i]!)) return i;
	}
	return null;
}

function entryHtml(entry: TranscriptEntry, index: number): string {
	let content: string;
	if (entry.kind === "tool") {
		const state = entry.evidence === "reported" ? t("evidence.reportedOnly")
			: entry.result === null ? t("evidence.noResult") : t(entry.isError ? "evidence.error" : "evidence.ok");
		content = `<h4 class="r-tool-name">${h(entry.name)}</h4><p class="note">${h(state)}</p>
<details class="r-tool-details"><summary>${h(t("evidence.arguments"))}</summary><pre class="r-tool-result">${h(entry.args)}</pre></details>
${entry.result === null ? "" : `<details class="r-tool-details" open><summary>${h(t("evidence.result"))}${entry.resultTruncated ? ` · ${h(t("evidence.clipped"))}` : ""}</summary><pre class="r-tool-result">${h(entry.result)}</pre></details>`}`;
	} else content = `<p class="r-spoken">${h(entry.text)}</p>`;
	return `<article class="r-step" data-step="${index}" data-kind="${entry.kind}"><div class="r-step-head"><span>${String(index + 1).padStart(2, "0")}</span><span>${h(kind(entry))}</span></div>${content}</article>`;
}

function lane(run: ReplayRun, side: "before" | "after", label: string): string {
	const entries = run.transcript?.entries ?? [];
	const controls = entries.map((entry, index) => `<button type="button" data-index="${index}" aria-label="${h(t("evidence.replayStep", { number: index + 1, total: entries.length }))}: ${h(kind(entry))}">${String(index + 1).padStart(2, "0")} ${h(entry.kind === "tool" ? entry.name.slice(0, 26) : kind(entry))}</button>`).join("");
	const traceNote = run.transcript?.truncated ? `<p class="r-trace-note">${h(t("evidence.replayTraceLimit", { omitted: run.transcript.omittedCount }))}</p>` : "";
	const cost = run.receipt.costUsd === null ? t("metrics.not-reported") : `$${run.receipt.costUsd.toFixed(5)}`;
	return `<section class="r-lane" data-lane="${side}" data-count="${entries.length}" aria-label="${h(label)}">
<header class="r-lane-header"><h3>${h(label)}</h3>${chip(run.outcome)}</header>
${traceNote}
<nav class="r-track r-js" aria-label="${h(label)}: ${h(t("evidence.replayEyebrow"))}">${controls}${entries.length ? `<button type="button" data-index="${entries.length}" aria-label="${h(t("evidence.replayEnd"))}">■</button>` : ""}</nav>
<div class="r-stage">${run.transcript ? entries.map(entryHtml).join("") || `<p class="r-terminal">${h(t("evidence.noTurns"))}</p>` : `<p class="r-terminal">${h(t("evidence.replayTraceMissing"))}</p>`}
${entries.length ? `<div class="r-terminal" data-end hidden>${h(t("evidence.replayEnd"))}</div>` : ""}</div>
<div class="r-lane-footer r-js"><button type="button" data-back aria-label="${h(label)}: ${h(t("evidence.replayPrevious"))}">←</button><span data-counter aria-live="polite"></span><button type="button" data-forward aria-label="${h(label)}: ${h(t("evidence.replayNext"))}">→</button></div>
<div class="r-lane-meta">${h(t("evidence.replayResources"))}: ${h(cost)} · ${h(run.receipt.tokens === null ? t("metrics.not-reported") : run.receipt.tokens)} ${h(t("explorer.th.tokens"))}<br><a href="/runs/${encodeURIComponent(run.runId)}">${h(t("evidence.openRun"))} →</a></div>
</section>`;
}

function checks(run: ReplayRun, label: string): string {
	return `<div><h3>${h(label)}</h3><ul class="r-checks">${run.graders.map(check => `<li>${chip(check.passed ? "pass" : "fail")} <b>${h(check.name)}</b><p>${h(check.reason)}</p></li>`).join("") || `<li>${h(t("evidence.noGraderResults"))}</li>`}</ul>${run.omittedGraders > 0 ? `<p class="note">${h(t("evidence.moreChecks", { count: run.omittedGraders }))}</p>` : ""}</div>`;
}

/** No artifact text is inserted into JavaScript; the controller only reads escaped SSR DOM. */
const SCRIPT = `(() => {
const root = document.querySelector('[data-replay]'); if (!root) return;
const lanes = Array.from(root.querySelectorAll('[data-lane]')).map(el => ({el, count:Number(el.dataset.count), at:0}));
const play = root.querySelector('[data-play]'), all = root.querySelector('[data-all]'), jump = root.querySelector('[data-difference]'), link = root.querySelector('[data-permalink]');
const permalinkBase = link.getAttribute('href');
let timer = null, full = false;
const clamp = (value, lane) => Math.max(0, Math.min(Number.isSafeInteger(value) ? value : 0, lane.count));
const stop = () => { if(timer !== null) clearInterval(timer); timer = null; play.textContent = play.dataset.play; play.setAttribute('aria-pressed','false'); };
function draw() {
 root.dataset.mode = full ? 'all' : 'steps'; all.textContent = full ? all.dataset.steps : all.dataset.all; all.setAttribute('aria-pressed',String(full));
 for(const lane of lanes) {
  const {el,at,count} = lane;
  el.querySelectorAll('[data-step]').forEach(step => { step.hidden = !full && Number(step.dataset.step) !== at; });
  const end=el.querySelector('[data-end]'); if(end) end.hidden = full || at !== count;
  el.querySelectorAll('[data-index]').forEach(button => { if(Number(button.dataset.index)===at && !full) button.setAttribute('aria-current','step'); else button.removeAttribute('aria-current'); });
  el.querySelector('[data-back]').disabled = full || at===0 || count===0;
  el.querySelector('[data-forward]').disabled = full || at===count || count===0;
  el.querySelector('[data-counter]').textContent = at===count ? root.dataset.end : root.dataset.step.replace('{number}',String(at+1)).replace('{total}',String(count));
 }
 play.disabled = full || lanes.every(lane => lane.count===0);
 link.href = permalinkBase + '#before=' + lanes[0].at + '&after=' + lanes[1].at;
}
function move(delta) { for(const lane of lanes) lane.at=clamp(lane.at+delta,lane); draw(); }
function restoreHash() {
 const hash = new URLSearchParams(location.hash.slice(1));
 if(hash.has('before') || hash.has('after')) lanes.forEach(lane => { const raw=hash.get(lane.el.dataset.lane); if(raw!==null && /^\\d{1,6}$/.test(raw)) lane.at=clamp(Number(raw),lane); });
}
for(const lane of lanes) {
 lane.el.querySelectorAll('[data-index]').forEach(button => button.addEventListener('click',()=>{stop();full=false;lane.at=clamp(Number(button.dataset.index),lane);draw();}));
 lane.el.querySelector('[data-back]').addEventListener('click',()=>{stop();lane.at=clamp(lane.at-1,lane);draw();});
 lane.el.querySelector('[data-forward]').addEventListener('click',()=>{stop();lane.at=clamp(lane.at+1,lane);draw();});
}
play.addEventListener('click',()=>{
 if(timer!==null){stop();return;}
 if(lanes.every(lane => lane.at===lane.count)) lanes.forEach(lane=>lane.at=0);
 full=false;draw();play.textContent=play.dataset.pause;play.setAttribute('aria-pressed','true');
 timer=setInterval(()=>{move(1);if(lanes.every(lane=>lane.at===lane.count))stop();},2500);
});
all.addEventListener('click',()=>{stop();full=!full;draw();});
jump?.addEventListener('click',()=>{stop();full=false;lanes.forEach(lane=>lane.at=clamp(Number(root.dataset.difference),lane));draw();});
root.addEventListener('keydown',event=>{
 if(event.key==='Escape'){stop();return;}
 if(event.target instanceof Element && event.target.closest('input,textarea,select,button,a,summary'))return;
 if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();stop();full=false;move(event.key==='ArrowRight'?1:-1);}
});
const search=root.querySelector('[data-search]'); search?.addEventListener('input',()=>{
 const query=search.value.trim().toLocaleLowerCase();let shown=0;root.querySelectorAll('[data-choice]').forEach(item=>{item.hidden=!item.textContent.toLocaleLowerCase().includes(query);if(!item.hidden)shown++;});
 root.querySelector('[data-no-matches]').hidden=shown!==0;
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
window.addEventListener('pagehide',stop);
window.addEventListener('hashchange',()=>{stop();full=false;restoreHash();draw();});
root.dataset.enhanced='true';
if(root.dataset.difference!=='')lanes.forEach(lane=>lane.at=clamp(Number(root.dataset.difference),lane));
restoreHash();draw();
})();`;

export function renderCandidateReplayPage(model: CandidateReplayPageModel): string {
	const { selected, comparison, navigation } = model;
	const base = `/candidates/${encodeURIComponent(model.candidateId)}`;
	const selectedPath = `${base}/replay?run=${encodeURIComponent(selected.baseline.runId)}`;
	const difference = firstDifference(model);
	const input = selected.baseline.transcript?.entries.find(entry => entry.kind === "user");
	const invalid = comparison.status === "invalid";
	const limited = invalid || selected.exclusion !== null;
	const stats = selected.stats;
	const selectedNote = invalid ? t("evidence.invalidComparison") : selected.exclusion ? t("evidence.excludedNote") : t("evidence.replayPassedRepeats", { before: stats.aPass, beforeTotal: stats.aTotal, after: stats.bPass, afterTotal: stats.bTotal });
	const choice = navigation.items.map(item => `<li data-choice><a href="${base}/replay?run=${encodeURIComponent(item.baselineRunId)}"${item.baselineRunId === navigation.selectedRunId ? ' aria-current="page"' : ""}><span>${h(item.taskId)} ${invalid ? "" : item.exclusion ? `· ${h(t(`evidence.excluded-${item.exclusion}`))}` : item.scoreDelta < 0 ? `· ${h(t("evidence.regressed"))}` : ""}</span><small>${h(t("evidence.replayRepeat", { number: item.repetitionIndex + 1 }))}</small></a></li>`).join("");
	const diff = model.proposal.available ? `<details class="r-diff"><summary>${h(model.proposal.summary)}</summary><p class="note">${model.proposal.paths.map(h).join(" · ")}</p>${model.proposal.redacted ? `<p class="note">${h(t("evidence.replayDiffRedacted"))}</p>` : ""}<pre>${model.proposal.diff.split("\n").map(line => `<span${line.startsWith("+") && !line.startsWith("+++") ? ' class="add"' : line.startsWith("-") && !line.startsWith("---") ? ' class="remove"' : ""}>${h(line)}</span>`).join("\n")}</pre><p class="note mono">${h(model.proposal.proposalHash)}</p></details>`
		: `<p class="note">${h(t("evidence.replayDiffUnavailable"))}: ${h(model.proposal.reason)}</p>`;
	const body = `<div class="replay" data-replay data-difference="${difference ?? ""}" data-step="${h(t("evidence.replayStep", { number: "{number}", total: "{total}" }))}" data-end="${h(t("evidence.replayEnd"))}" tabindex="0">
<header class="r-hero"><p class="r-eyebrow">${h(t("evidence.replayEyebrow"))} · ${h(model.targetId)}</p><h1>${h(t("evidence.replayTitle"))}</h1><p class="lead">${h(t("evidence.replayIntro"))}</p></header>
<div class="r-suite"><div><span class="r-eyebrow">${h(t("evidence.replaySuite"))}</span><p>${h(invalid ? t("evidence.invalidComparison") : comparison.line)}</p><p class="r-summary">${h(t("evidence.replayNotCausal"))}</p></div><div class="r-regressions"><strong class="${!invalid && comparison.summary.regressed > 0 ? "down" : "same"}">${invalid ? "—" : comparison.summary.regressed}</strong><small>${h(t("evidence.replayRegressions"))}</small></div></div>
<details class="r-pick"><summary>${h(t("evidence.replayPick"))} · ${h(selected.taskId)} · ${h(t("evidence.replayRepeat", { number: selected.repetitionIndex + 1 }))}</summary><input class="r-js" data-search aria-label="${h(t("evidence.replaySearch"))}" placeholder="${h(t("evidence.replaySearch"))}"><p class="r-help" style="padding:0 16px" data-no-matches role="status" hidden>${h(t("evidence.replayNoMatches"))}</p><ul class="r-choices">${choice}</ul>${navigation.omittedCount > 0 ? `<p class="note">${h(t("evidence.replayNavLimit", { shown: navigation.items.length, total: navigation.total }))}</p>` : ""}</details>
<div class="r-case"><div><h2>${h(selected.taskId)}</h2><span class="r-repeat">${h(t("evidence.replayRepeat", { number: selected.repetitionIndex + 1 }))}</span></div><div><span class="r-repeat">${h(t("evidence.replayAllRepeats"))}</span><p>${h(selectedNote)}${limited ? "" : ` · ${percent(stats.aScore)} → ${percent(stats.bScore)}`}</p></div></div>
${input ? `<p class="r-input">${h(input.text)}</p>` : ""}
<div class="r-controls r-js"><button class="r-primary" type="button" data-play="${h(t("evidence.replayPlay"))}" data-pause="${h(t("evidence.replayPause"))}" aria-pressed="false">${h(t("evidence.replayPlay"))}</button>${difference !== null ? `<button type="button" data-difference>${h(t("evidence.replayDifferent"))}</button>` : ""}<button type="button" data-all="${h(t("evidence.replayAll"))}" data-steps="${h(t("evidence.replaySteps"))}" aria-pressed="false">${h(t("evidence.replayAll"))}</button><a class="r-link" data-permalink href="${selectedPath}">${h(t("evidence.replayPermalink"))} ↗</a></div>
<p class="r-help">${h(t("evidence.replayRecorded"))}</p>
<div class="r-lanes">${lane(selected.baseline, "before", t("evidence.baseline"))}${lane(selected.candidate, "after", t("evidence.candidate"))}</div>
<p class="r-help">${h(difference === null && selected.baseline.transcript && selected.candidate.transcript ? t("evidence.replaySame") : t("evidence.replayDifferenceNote"))}</p><p class="r-help r-js">${h(t("evidence.replayKeyboard"))}</p>
<section class="r-proof"><h2>${h(t("evidence.replayDiff"))}</h2>${diff}</section>
<section class="r-proof"><h2>${h(t("evidence.replayChecks"))}</h2><p class="note">${h(t("evidence.replayChecksNote"))}</p><div class="r-check-grid">${checks(selected.baseline, t("evidence.baseline"))}${checks(selected.candidate, t("evidence.candidate"))}</div></section>
<details class="metadata"><summary>${h(t("evidence.metadata"))}</summary><pre>${h(selected.baseline.runId)} · ${h(selected.baseline.revision)}
→ ${h(selected.candidate.runId)} · ${h(selected.candidate.revision)}</pre>${model.notices.map(notice => `<p class="note">${h(notice)}</p>`).join("")}</details>
<a class="r-link" href="${base}">← ${h(t("evidence.replayOverview"))}</a></div>`;
	return renderPage({ title: `${t("evidence.replayEyebrow")} · ${model.targetId}`, crumbs: [{ label: t("evidence.brand"), href: "/" }, { label: model.candidateId, href: base }, { label: t("evidence.replayEyebrow") }], body, styles: STYLES, script: SCRIPT });
}
