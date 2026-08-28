import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { compareEvalRuns } from "./compare.js";
import { diagnoseEvalRun, loadDiagnosis, type DiagnosisRecord } from "./diagnosis.js";
import { loadEvalRun, loadRun, type EvalRunRecord } from "./eval.js";
import type { RunRecord } from "./provenance.js";
import { openTrace, redactTraceText, type TraceMessage } from "./trace.js";
import { writeTextArtifact } from "./storage/artifacts.js";
import { resolveContainedArtifactPath } from "./storage/paths.js";

const MAX_MESSAGE_CHARS = 20_000;
const MAX_TRACE_MESSAGES = 500;
export const MAX_DETAIL_RUNS = 50;
export const MAX_NORMALIZED_TRACE_CHARS = 250_000;

export const EvalReportProjectionSchema = z.strictObject({
	selection: z.literal("failures-errors-then-passes-source-order"),
	sourceRunCount: z.number().int().nonnegative(),
	includedRunCount: z.number().int().nonnegative().max(MAX_DETAIL_RUNS),
	includedRunIds: z.array(z.string().min(1)).max(MAX_DETAIL_RUNS),
	omittedRunCount: z.number().int().nonnegative(),
	traceCharactersIncluded: z.number().int().nonnegative().max(MAX_NORMALIZED_TRACE_CHARS),
	traceTruncated: z.boolean(),
	truncatedTraceRunIds: z.array(z.string().min(1)).max(MAX_DETAIL_RUNS),
	limits: z.strictObject({
		detailRuns: z.literal(MAX_DETAIL_RUNS),
		traceCharacters: z.literal(MAX_NORMALIZED_TRACE_CHARS),
	}),
}).superRefine((projection, context) => {
	if (projection.includedRunCount !== projection.includedRunIds.length) {
		context.addIssue({
			code: "custom",
			path: ["includedRunCount"],
			message: "must equal includedRunIds.length",
		});
	}
	if (projection.sourceRunCount !== projection.includedRunCount + projection.omittedRunCount) {
		context.addIssue({
			code: "custom",
			path: ["sourceRunCount"],
			message: "must equal includedRunCount + omittedRunCount",
		});
	}
	if (new Set(projection.includedRunIds).size !== projection.includedRunIds.length) {
		context.addIssue({ code: "custom", path: ["includedRunIds"], message: "must be unique" });
	}
	if (new Set(projection.truncatedTraceRunIds).size !== projection.truncatedTraceRunIds.length) {
		context.addIssue({ code: "custom", path: ["truncatedTraceRunIds"], message: "must be unique" });
	}
	const included = new Set(projection.includedRunIds);
	if (projection.truncatedTraceRunIds.some((runId) => !included.has(runId))) {
		context.addIssue({
			code: "custom",
			path: ["truncatedTraceRunIds"],
			message: "must be a subset of includedRunIds",
		});
	}
	if (projection.traceTruncated !== (projection.truncatedTraceRunIds.length > 0)) {
		context.addIssue({
			code: "custom",
			path: ["traceTruncated"],
			message: "must reflect truncatedTraceRunIds",
		});
	}
});
export type EvalReportProjection = z.infer<typeof EvalReportProjectionSchema>;

export interface ReportTraceMessage {
	role: TraceMessage["role"];
	text: string;
	toolCalls: Array<{ name: string; arguments: string }>;
	toolResult: { name: string; text: string; isError: boolean } | null;
}

export interface ReportRun {
	runId: string;
	taskId: string;
	repetitionIndex: number;
	status: string;
	outcome: string;
	error: string | null;
	graders: Array<{ name: string; type: string; passed: boolean; reason: string }>;
	metrics: { latencyMs: number; toolCalls: number; toolErrors: number; tokens: number; costUsd: number };
	trace: ReportTraceMessage[];
}

export interface EvalReportData {
	generatedAt: string;
	evalRun: EvalRunRecord;
	diagnosis: DiagnosisRecord;
	comparison: ReturnType<typeof compareEvalRuns> | null;
	runs: ReportRun[];
	projection: EvalReportProjection;
	redactionNotice: string;
}

interface TraceCharacterBudget {
	remaining: number;
	included: number;
}

interface ProjectedTraceText {
	text: string;
	truncated: boolean;
	budgetTruncated: boolean;
}

function projectTraceText(text: string, budget: TraceCharacterBudget): ProjectedTraceText {
	const redacted = redactTraceText(text);
	const messageBounded = redacted.slice(0, MAX_MESSAGE_CHARS);
	const includedLength = Math.min(messageBounded.length, budget.remaining);
	const projected = messageBounded.slice(0, includedLength);
	budget.remaining -= includedLength;
	budget.included += includedLength;
	return {
		text: projected,
		truncated: projected.length < redacted.length,
		budgetTruncated: projected.length < messageBounded.length,
	};
}

function reportTrace(
	messages: TraceMessage[],
	budget: TraceCharacterBudget,
): { trace: ReportTraceMessage[]; truncated: boolean } {
	const trace: ReportTraceMessage[] = [];
	let truncated = messages.length > MAX_TRACE_MESSAGES;
	const boundedMessages = messages.slice(0, MAX_TRACE_MESSAGES);

	for (const message of boundedMessages) {
		if (budget.remaining === 0) {
			truncated = true;
			break;
		}

		const text = projectTraceText(message.text, budget);
		truncated ||= text.truncated;
		const projected: ReportTraceMessage = {
			role: message.role,
			text: text.text,
			toolCalls: [],
			toolResult: null,
		};
		if (text.budgetTruncated) {
			trace.push(projected);
			break;
		}

		for (const call of message.toolCalls ?? []) {
			if (budget.remaining === 0) {
				truncated = true;
				break;
			}
			const name = projectTraceText(call.name, budget);
			const argumentsText = name.budgetTruncated
				? { text: "", truncated: true, budgetTruncated: true }
				: projectTraceText(JSON.stringify(call.arguments, null, 2), budget);
			truncated ||= name.truncated || argumentsText.truncated;
			projected.toolCalls.push({ name: name.text, arguments: argumentsText.text });
			if (name.budgetTruncated || argumentsText.budgetTruncated) break;
		}
		if (budget.remaining === 0 && (message.toolCalls?.length ?? 0) > projected.toolCalls.length) {
			truncated = true;
		}

		if (message.toolResult) {
			if (budget.remaining === 0) {
				truncated = true;
			} else {
				const name = projectTraceText(message.toolResult.toolName, budget);
				const resultText = name.budgetTruncated
					? { text: "", truncated: true, budgetTruncated: true }
					: projectTraceText(message.toolResult.text, budget);
				truncated ||= name.truncated || resultText.truncated;
				projected.toolResult = {
					name: name.text,
					text: resultText.text,
					isError: message.toolResult.isError,
				};
			}
		}

		trace.push(projected);
	}
	return { trace, truncated };
}

function reportOutcome(run: RunRecord): string {
	return run.status === "completed" ? (run.evalResults?.outcome ?? "error") : "error";
}

export function collectEvalReportData(
	runsRoot: string,
	evalRunId: string,
	now = () => new Date().toISOString(),
	options: { allowDiagnosisCreation?: boolean } = {},
): EvalReportData {
	resolveContainedArtifactPath(runsRoot, evalRunId, "eval_run.json");
	const evalRun = loadEvalRun(runsRoot, evalRunId);
	const diagnosis = options.allowDiagnosisCreation === false
		? loadDiagnosis(runsRoot, evalRunId)
		: diagnoseEvalRun(runsRoot, evalRunId, now);
	let comparison: ReturnType<typeof compareEvalRuns> | null = null;
	if (evalRun.baselineEvalRunId) {
		resolveContainedArtifactPath(runsRoot, evalRun.baselineEvalRunId, "eval_run.json");
		comparison = compareEvalRuns(runsRoot, evalRun.baselineEvalRunId, evalRun.evalRunId);
	}
	const sourceRuns = evalRun.runIds.map((runId) => {
		resolveContainedArtifactPath(runsRoot, runId, "run.json");
		return { runId, run: loadRun(runsRoot, runId) };
	});
	const prioritizedRuns = [
		...sourceRuns.filter(({ run }) => reportOutcome(run) !== "pass"),
		...sourceRuns.filter(({ run }) => reportOutcome(run) === "pass"),
	];
	const includedRuns = prioritizedRuns.slice(0, MAX_DETAIL_RUNS);
	const traceBudget: TraceCharacterBudget = {
		remaining: MAX_NORMALIZED_TRACE_CHARS,
		included: 0,
	};
	const truncatedTraceRunIds: string[] = [];
	const runs = includedRuns.map(({ runId, run }): ReportRun => {
		let trace: ReportTraceMessage[] = [];
		if (run.trace.sha256) {
			if (traceBudget.remaining === 0) {
				truncatedTraceRunIds.push(runId);
			} else {
				const traceArtifact = resolveContainedArtifactPath(runsRoot, runId, run.trace.path);
				const projected = reportTrace(
					openTrace(dirname(traceArtifact), basename(traceArtifact), run.trace.sha256),
					traceBudget,
				);
				trace = projected.trace;
				if (projected.truncated) truncatedTraceRunIds.push(runId);
			}
		}
		return {
			runId,
			taskId: run.taskId,
			repetitionIndex: run.repetitionIndex,
			status: run.status,
			outcome: reportOutcome(run),
			error: run.error,
			graders: run.evalResults?.graders ?? [],
			metrics: {
				latencyMs: run.metrics.latencyMs,
				toolCalls: run.metrics.toolCalls,
				toolErrors: run.metrics.toolErrors,
				tokens: run.metrics.tokens.total,
				costUsd: run.metrics.costUsd,
			},
			trace,
		};
	});
	const projection = EvalReportProjectionSchema.parse({
		selection: "failures-errors-then-passes-source-order",
		sourceRunCount: sourceRuns.length,
		includedRunCount: runs.length,
		includedRunIds: runs.map((run) => run.runId),
		omittedRunCount: sourceRuns.length - runs.length,
		traceCharactersIncluded: traceBudget.included,
		traceTruncated: truncatedTraceRunIds.length > 0,
		truncatedTraceRunIds,
		limits: {
			detailRuns: MAX_DETAIL_RUNS,
			traceCharacters: MAX_NORMALIZED_TRACE_CHARS,
		},
	});
	return {
		generatedAt: now(),
		evalRun,
		diagnosis,
		comparison,
		runs,
		projection,
		redactionNotice:
			"This report contains a normalized, size-bounded, credential-redacted trace view. Protected raw JSONL remains in the run directory.",
	};
}

function embeddedJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function htmlText(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	})[character] ?? character);
}

function projectionNotice(projection: EvalReportProjection): string {
	const runNotice = projection.omittedRunCount > 0
		? `Detail projection includes ${projection.includedRunCount} of ${projection.sourceRunCount} runs; ${projection.omittedRunCount} runs omitted.`
		: `Detail projection includes all ${projection.includedRunCount} runs.`;
	const traceNotice = projection.traceTruncated
		? ` Normalized traces were truncated for ${projection.truncatedTraceRunIds.length} included runs at the ${projection.limits.traceCharacters.toLocaleString("en-US")}-character global budget.`
		: ` Normalized traces fit within the ${projection.limits.traceCharacters.toLocaleString("en-US")}-character global budget.`;
	return `${runNotice}${traceNotice}`;
}

export function renderEvalReportHtml(data: EvalReportData): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AHDE Evidence Report</title>
<style>
:root{color-scheme:dark;--bg:#090b10;--panel:#10131b;--panel2:#151a24;--line:#252b38;--text:#edf0f7;--muted:#929bae;--blue:#6d7cff;--green:#43d17b;--red:#ff667a;--amber:#f2b84b;--radius:14px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% -10%,#1b2140 0,transparent 35%),var(--bg);color:var(--text)}button{font:inherit}.shell{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:100vh}.side{position:sticky;top:0;height:100vh;border-right:1px solid var(--line);padding:22px 16px;background:rgba(9,11,16,.88);backdrop-filter:blur(16px);overflow:auto}.brand{display:flex;gap:10px;align-items:center;font-weight:750;letter-spacing:.02em;margin:0 8px 24px}.mark{width:28px;height:28px;border-radius:9px;background:linear-gradient(135deg,#8590ff,#4b57e8);box-shadow:0 0 24px #6070ff77}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:11px;color:var(--muted);margin:20px 8px 8px}.run-link{display:block;width:100%;border:0;background:transparent;color:var(--muted);padding:9px 10px;border-radius:9px;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.run-link:hover,.run-link.active{background:var(--panel2);color:var(--text)}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:8px;background:var(--red)}.dot.pass{background:var(--green)}main{padding:36px clamp(24px,4vw,64px);max-width:1500px;width:100%}.top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:30px}.top h1{font-size:clamp(28px,4vw,48px);line-height:1.05;margin:7px 0 10px;letter-spacing:-.04em}.sub{color:var(--muted);font-size:14px}.badge{display:inline-flex;align-items:center;padding:7px 10px;border:1px solid var(--line);border-radius:999px;background:var(--panel);font-size:12px;color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:22px 0 30px}.stat{background:linear-gradient(145deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:var(--radius);padding:18px}.stat strong{font-size:30px;letter-spacing:-.04em;display:block}.stat span{font-size:12px;color:var(--muted)}section{margin:30px 0}.section-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.section-title h2{font-size:18px;margin:0}.issues{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.issue{border:1px solid var(--line);background:var(--panel);border-radius:var(--radius);padding:18px}.issue-head{display:flex;justify-content:space-between;gap:10px}.issue h3{font-size:15px;margin:0 0 8px}.pill{font-size:10px;text-transform:uppercase;letter-spacing:.09em;border-radius:999px;padding:5px 8px;background:#252b3b;color:#c9d0e1}.pill.blocking{background:#481d29;color:#ff9aaa}.issue p{color:var(--muted);font-size:13px;line-height:1.55}.issue ul{padding-left:18px;color:#cbd1df;font-size:13px;line-height:1.55}.table-wrap{border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;background:var(--panel)}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:13px 14px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--muted);font-weight:550;background:#121620}tr:last-child td{border-bottom:0}tr[data-run]{cursor:pointer}tr[data-run]:hover{background:var(--panel2)}.outcome{font-weight:700}.outcome.pass{color:var(--green)}.outcome.fail,.outcome.error{color:var(--red)}.trace{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);min-height:220px}.trace-empty{padding:44px;text-align:center;color:var(--muted)}.trace-head{padding:16px 18px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between}.message{padding:18px;border-bottom:1px solid var(--line)}.message:last-child{border-bottom:0}.message-label{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--blue);margin-bottom:9px}.message pre{white-space:pre-wrap;word-break:break-word;margin:0;color:#dce1ec;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.tool{margin-top:10px;background:#0b0e14;border:1px solid #262d3c;border-radius:10px;padding:12px}.tool.error{border-color:#632a36}.notice{font-size:12px;color:var(--muted);border-left:2px solid var(--blue);padding:8px 12px}.delta{color:var(--green)}@media(max-width:900px){.shell{grid-template-columns:1fr}.side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}.grid{grid-template-columns:repeat(2,1fr)}.issues{grid-template-columns:1fr}}@media(max-width:520px){.grid{grid-template-columns:1fr}.top{display:block}}
</style>
</head>
<body>
<div class="shell"><aside class="side"><div class="brand"><span class="mark"></span> AHDE Evidence</div><div class="eyebrow">Runs</div><div id="run-nav"></div></aside><main>
<header class="top"><div><span class="badge" id="status-badge"></span><h1 id="title"></h1><div class="sub" id="subtitle"></div></div><span class="badge" id="revision"></span></header>
<div class="grid" id="stats"></div>
<section><div class="section-title"><h2>Diagnosis</h2><span class="badge" id="diagnosis-status"></span></div><div class="issues" id="issues"></div></section>
<section id="comparison-section" hidden><div class="section-title"><h2>Matched comparison</h2></div><div class="table-wrap"><table><thead><tr><th>Task</th><th>Baseline</th><th>Candidate</th><th>Delta</th></tr></thead><tbody id="comparison"></tbody></table></div></section>
<section><div class="section-title"><h2>Run evidence</h2></div><p class="notice" id="projection-notice">${htmlText(projectionNotice(data.projection))}</p><div class="table-wrap"><table><thead><tr><th>Task</th><th>Rep</th><th>Outcome</th><th>Latency</th><th>Tools</th><th>Tokens</th></tr></thead><tbody id="runs"></tbody></table></div></section>
<section><div class="section-title"><h2>Trace inspector</h2><span class="badge" id="trace-id">Select a run</span></div><div class="trace" id="trace"><div class="trace-empty">Choose a run to inspect its normalized trace.</div></div></section>
<p class="notice" id="notice"></p>
</main></div>
<script>const DATA=${embeddedJson(data)};
const q=(s)=>document.querySelector(s), esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const e=DATA.evalRun,d=DATA.diagnosis;q('#title').textContent=e.target.id;q('#subtitle').textContent=e.evalRunId+' · '+e.label+' · '+e.startedAt;q('#revision').textContent=e.target.gitSha.slice(0,12);q('#status-badge').textContent=d.status;q('#diagnosis-status').textContent=d.summary.issueCount+' issues';q('#notice').textContent=DATA.redactionNotice;
const pct=Math.round(e.summary.allPassRate*100);q('#stats').innerHTML=[['Pass rate',pct+'%'],['Passed',e.summary.pass+'/'+e.summary.total],['Errors',e.summary.error],['Issues',d.summary.issueCount]].map(([l,v])=>'<div class="stat"><strong>'+esc(v)+'</strong><span>'+esc(l)+'</span></div>').join('');
q('#issues').innerHTML=d.issues.length?d.issues.map(i=>'<article class="issue"><div class="issue-head"><div><h3>'+esc(i.taskId)+' · '+esc(i.category)+'</h3><span class="pill '+esc(i.severity)+'">'+esc(i.confidence)+' confidence</span></div><span class="pill '+esc(i.severity)+'">'+esc(i.severity)+'</span></div><p>'+esc(i.rootCause)+'</p><ul>'+i.suggestions.map(s=>'<li>'+esc(s)+'</li>').join('')+'</ul></article>').join(''):'<article class="issue"><h3>No actionable failures</h3><p>All recorded tasks completed and passed.</p></article>';
const runRows=DATA.runs.map(r=>'<tr data-run="'+esc(r.runId)+'"><td>'+esc(r.taskId)+'</td><td>'+r.repetitionIndex+'</td><td class="outcome '+esc(r.outcome)+'">'+esc(r.outcome)+'</td><td>'+r.metrics.latencyMs+' ms</td><td>'+r.metrics.toolCalls+(r.metrics.toolErrors?' / '+r.metrics.toolErrors+' errors':'')+'</td><td>'+r.metrics.tokens+'</td></tr>').join('');q('#runs').innerHTML=runRows;
q('#run-nav').innerHTML=DATA.runs.map(r=>'<button class="run-link" data-run="'+esc(r.runId)+'"><span class="dot '+(r.outcome==='pass'?'pass':'')+'"></span>'+esc(r.taskId)+' · '+r.repetitionIndex+'</button>').join('');
if(DATA.comparison&&DATA.comparison.status==='comparable'){q('#comparison-section').hidden=false;q('#comparison').innerHTML=DATA.comparison.rows.map(r=>'<tr><td>'+esc(r.taskId)+'</td><td>'+r.aPass+'/'+r.aTotal+'</td><td>'+r.bPass+'/'+r.bTotal+'</td><td class="'+(r.delta>0?'delta':'')+'">'+(r.delta>0?'+':'')+Math.round(r.delta*100)+' pp</td></tr>').join('')}
function showRun(id){const r=DATA.runs.find(x=>x.runId===id);if(!r)return;document.querySelectorAll('[data-run]').forEach(n=>n.classList.toggle('active',n.dataset.run===id));q('#trace-id').textContent=r.runId;const grader='<div class="message"><div class="message-label">Graders</div>'+r.graders.map(g=>'<div class="tool '+(g.passed?'':'error')+'"><strong>'+esc(g.passed?'PASS':'FAIL')+' · '+esc(g.name)+'</strong><pre>'+esc(g.reason)+'</pre></div>').join('')+'</div>';q('#trace').innerHTML=(r.error?'<div class="message"><div class="message-label">Run error</div><pre>'+esc(r.error)+'</pre></div>':'')+r.trace.map(m=>'<div class="message"><div class="message-label">'+esc(m.role)+'</div>'+(m.text?'<pre>'+esc(m.text)+'</pre>':'')+m.toolCalls.map(t=>'<div class="tool"><strong>call · '+esc(t.name)+'</strong><pre>'+esc(t.arguments)+'</pre></div>').join('')+(m.toolResult?'<div class="tool '+(m.toolResult.isError?'error':'')+'"><strong>result · '+esc(m.toolResult.name)+'</strong><pre>'+esc(m.toolResult.text)+'</pre></div>':'')+'</div>').join('')+grader;q('#trace').scrollIntoView({behavior:'smooth',block:'start'})}
document.addEventListener('click',ev=>{const node=ev.target.closest('[data-run]');if(node)showRun(node.dataset.run)});if(DATA.runs.length)showRun(DATA.runs[0].runId);
</script></body></html>`;
}

export function reportPath(runsRoot: string, evalRunId: string): string {
	return resolveContainedArtifactPath(runsRoot, evalRunId, "report.html");
}

export function buildEvalReport(
	runsRoot: string,
	evalRunId: string,
	outPath?: string,
): string {
	const data = collectEvalReportData(runsRoot, evalRunId);
	const outputPath = outPath === undefined ? reportPath(runsRoot, evalRunId) : resolve(outPath);
	writeTextArtifact(outputPath, renderEvalReportHtml(data));
	return outputPath;
}
