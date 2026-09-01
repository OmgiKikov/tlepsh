import { language } from "../i18n.js";
import { randomBytes } from "node:crypto";
import { projectRunEventIdentity, type RunEvent, type RunEventListener } from "../run-events.js";

const LIVE_TRACE_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const MAX_SESSIONS = 4;
const MAX_FRAMES_PER_SESSION = 256;
const MAX_SESSION_BYTES = 512 * 1024;
const MAX_FRAME_BYTES = 24 * 1024;
const MAX_SUBSCRIBERS_PER_SESSION = 4;
const FINISHED_SESSION_TTL_MS = 15 * 60 * 1_000;

export type LiveTraceOutcome = "completed" | "error" | "aborted";
type StoredLiveTraceOutcome = LiveTraceOutcome | "expired";

export interface EvidenceLiveTrace {
	id: string;
	onRunEvent: RunEventListener;
	finish(outcome: LiveTraceOutcome): void;
}

export interface LiveTraceFrame {
	sequence: number;
	event: "run" | "session";
	data: string;
}

type LiveTraceSubscriber = (frame: LiveTraceFrame) => boolean;

interface LiveTraceRecord {
	id: string;
	frames: LiveTraceFrame[];
	frameBytes: number;
	nextSequence: number;
	droppedBeforeSequence: number;
	finished: boolean;
	expiration?: ReturnType<typeof setTimeout>;
	subscribers: Set<LiveTraceSubscriber>;
}

export type LiveTraceSubscription =
	| { kind: "not-found" }
	| { kind: "full" }
	| {
		kind: "subscribed";
		frames: readonly LiveTraceFrame[];
		droppedBeforeSequence: number;
		active: boolean;
		unsubscribe(): void;
	};

export interface LiveTraceHub {
	start(): EvidenceLiveTrace;
	has(id: string): boolean;
	subscribe(id: string, afterSequence: number, subscriber: LiveTraceSubscriber): LiveTraceSubscription;
	close(): void;
}

export function isLiveTraceId(value: string): boolean {
	return LIVE_TRACE_ID_PATTERN.test(value);
}

function createLiveTraceId(records: ReadonlyMap<string, LiveTraceRecord>): string {
	for (;;) {
		const id = randomBytes(24).toString("base64url");
		if (!records.has(id)) return id;
	}
}

function frameBytes(frame: LiveTraceFrame): number {
	return Buffer.byteLength(frame.data, "utf8") + 32;
}

/**
 * Restart-ephemeral, bounded fan-out for already-redacted RunEvents. This is a
 * presentation cache only; it never reads or writes canonical evidence.
 */
export function createLiveTraceHub(): LiveTraceHub {
	const records = new Map<string, LiveTraceRecord>();

	const append = (record: LiveTraceRecord, event: LiveTraceFrame["event"], data: string): void => {
		if (Buffer.byteLength(data, "utf8") > MAX_FRAME_BYTES) return;
		const frame: LiveTraceFrame = {
			sequence: record.nextSequence,
			event,
			data,
		};
		record.nextSequence += 1;
		record.frames.push(frame);
		record.frameBytes += frameBytes(frame);
		while (
			record.frames.length > MAX_FRAMES_PER_SESSION ||
			record.frameBytes > MAX_SESSION_BYTES
		) {
			const removed = record.frames.shift();
			if (!removed) break;
			record.frameBytes -= frameBytes(removed);
			record.droppedBeforeSequence = removed.sequence;
		}
		for (const subscriber of [...record.subscribers]) {
			let keep = false;
			try {
				keep = subscriber(frame);
			} catch {
				keep = false;
			}
			if (!keep) record.subscribers.delete(subscriber);
		}
	};

	const remove = (record: LiveTraceRecord): void => {
		if (record.expiration) clearTimeout(record.expiration);
		records.delete(record.id);
	};

	const finish = (record: LiveTraceRecord, outcome: StoredLiveTraceOutcome): void => {
		if (record.finished) return;
		record.finished = true;
		append(record, "session", JSON.stringify({ status: outcome }));
		record.subscribers.clear();
		if (outcome !== "expired") {
			record.expiration = setTimeout(() => remove(record), FINISHED_SESSION_TTL_MS);
			record.expiration.unref();
		}
	};

	const evictFinished = (): boolean => {
		const finished = [...records.values()].find((record) => record.finished);
		if (!finished) return false;
		remove(finished);
		return true;
	};

	return {
		start(): EvidenceLiveTrace {
			while (records.size >= MAX_SESSIONS && evictFinished()) {
				// Prefer a retained completed view over disturbing an active run.
			}
			if (records.size >= MAX_SESSIONS) {
				throw new Error("live trace capacity is full; evaluation can continue without web observation");
			}
			const id = createLiveTraceId(records);
			const record: LiveTraceRecord = {
				id,
				frames: [],
				frameBytes: 0,
				nextSequence: 1,
				droppedBeforeSequence: 0,
				finished: false,
				subscribers: new Set(),
			};
			records.set(id, record);
			return {
				id,
				onRunEvent(event) {
					if (record.finished) return;
					try {
						append(record, "run", JSON.stringify({
							...event,
							run: projectRunEventIdentity(event.run),
						}));
					} catch {
						// Live observation cannot affect an evaluation.
					}
				},
				finish(outcome) {
					finish(record, outcome);
				},
			};
		},
		has(id) {
			return isLiveTraceId(id) && records.has(id);
		},
		subscribe(id, afterSequence, subscriber) {
			const record = isLiveTraceId(id) ? records.get(id) : undefined;
			if (!record) return { kind: "not-found" };
			if (!record.finished && record.subscribers.size >= MAX_SUBSCRIBERS_PER_SESSION) {
				return { kind: "full" };
			}
			if (!record.finished) record.subscribers.add(subscriber);
			return {
				kind: "subscribed",
				frames: record.frames.filter((frame) => frame.sequence > afterSequence),
				droppedBeforeSequence: record.droppedBeforeSequence,
				active: !record.finished,
				unsubscribe() {
					record.subscribers.delete(subscriber);
				},
			};
		},
		close() {
			for (const record of records.values()) {
				finish(record, "expired");
				if (record.expiration) clearTimeout(record.expiration);
			}
			records.clear();
		},
	};
}

/** Static shell: all event text is inserted with textContent, never HTML. */
export function renderLiveTraceHtml(): string {
	return `<!doctype html>
<html lang="${language()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AHDE Live Trace</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#080a0f;color:#eef1f8}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0,#161a35 0,transparent 35%),#080a0f}.shell{display:grid;grid-template-columns:280px minmax(0,1fr);min-height:100vh}.side{position:sticky;top:0;height:100vh;padding:28px 22px;border-right:1px solid #242938;background:#0d1018cc;backdrop-filter:blur(18px)}.brand{font-size:20px;font-weight:750;letter-spacing:-.03em}.mark{display:inline-block;width:10px;height:10px;margin-right:9px;border-radius:3px;background:#6273ff;box-shadow:0 0 24px #6273ff}.eyebrow{margin-top:40px;color:#747e94;font-size:11px;font-weight:750;letter-spacing:.12em;text-transform:uppercase}.state{margin-top:10px;font-size:26px;font-weight:720;letter-spacing:-.04em}.meta{margin-top:10px;color:#8e97aa;font-size:13px;line-height:1.55}.reports{display:grid;gap:8px;margin-top:18px}.reports span{color:#b9c0ff;overflow:hidden;text-overflow:ellipsis}.main{width:min(1080px,100%);padding:46px 44px 100px}.title{font-size:44px;line-height:1;letter-spacing:-.055em;margin:0}.subtitle{margin:12px 0 34px;color:#8e97aa}.gap{margin:0 0 18px;padding:12px 14px;border:1px solid #4c456e;border-radius:12px;background:#171528;color:#bbb8dc;font-size:13px}.empty{padding:30px;border:1px dashed #303748;border-radius:16px;color:#8e97aa}.run{margin:0 0 22px;border:1px solid #252b3a;border-radius:18px;overflow:hidden;background:#0e121b}.run-head{display:flex;justify-content:space-between;gap:18px;padding:15px 18px;border-bottom:1px solid #252b3a;color:#aab2c5}.run-head strong{color:#f1f3fa}.events{padding:8px 18px}.event{display:grid;grid-template-columns:115px minmax(0,1fr);gap:16px;padding:13px 0;border-bottom:1px solid #1d2230}.event:last-child{border:0}.kind{color:#7f8bff;font-size:12px;font-weight:750;text-transform:uppercase}.body{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;color:#d9deeb}.error .kind,.fail .kind{color:#ff7f95}.pass .kind{color:#61d6a2}@media(max-width:760px){.shell{display:block}.side{position:static;height:auto;border-right:0;border-bottom:1px solid #242938}.main{padding:30px 18px}.event{grid-template-columns:1fr;gap:7px}.title{font-size:36px}}
</style></head><body><div class="shell"><aside class="side"><div class="brand"><span class="mark"></span>AHDE</div><div class="eyebrow">Live development trace</div><div class="state" id="state">Connecting</div><div class="meta" id="meta">Provisional, redacted, and restart-ephemeral. Canonical evidence appears only after grading.</div><div class="reports" id="reports"></div></aside><main class="main"><h1 class="title">Target runs</h1><p class="subtitle">Assistant output, tool calls, and grader outcomes as they happen.</p><div class="gap" id="gap" hidden></div><div class="empty" id="empty">Waiting for the first development run…</div><div id="runs"></div></main></div>
<script>
(function(){
  'use strict';
  var state=document.getElementById('state');var meta=document.getElementById('meta');var reports=document.getElementById('reports');var runsRoot=document.getElementById('runs');var empty=document.getElementById('empty');var gap=document.getElementById('gap');
  var token=decodeURIComponent(location.pathname.slice('/live/'.length));var runs=new Map();var evalIds=[];var rendered=[];var renderedChars=0;var clientDropped=0;var graded=0;var MAX_RENDERED_EVENTS=300;var MAX_RENDERED_CHARS=524288;
  function node(tag,className,text){var element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element}
  function showGap(text){gap.hidden=false;gap.textContent=text}
  function rememberEvalId(id){if(!id||evalIds.some(function(item){return item.id===id}))return;var label=node('span','','Provisional eval · '+id);reports.append(label);evalIds.push({id:id,node:label});if(evalIds.length>20){var removed=evalIds.shift();removed.node.remove()}}
  function ensureRun(frame){var key=frame.run.runId;var found=runs.get(key);if(found)return found;empty.hidden=true;var card=node('section','run');var head=node('div','run-head');var title=node('strong','',frame.run.taskId);var position=node('span','',String(frame.run.ordinal)+'/'+String(frame.run.total));head.append(title,position);var events=node('div','events');card.append(head,events);runsRoot.append(card);found={key:key,card:card,events:events,count:0};runs.set(key,found);rememberEvalId(frame.run.evalRunId);return found}
  function prune(){while(rendered.length>MAX_RENDERED_EVENTS||renderedChars>MAX_RENDERED_CHARS){var old=rendered.shift();renderedChars-=old.chars;old.node.remove();old.run.count-=1;if(old.run.count===0){old.run.card.remove();runs.delete(old.run.key)}clientDropped+=1}if(clientDropped>0)showGap(String(clientDropped)+' older live rows omitted to keep this page responsive. Canonical evidence remains complete.')}
  function add(frame){var run=ensureRun(frame);var row=node('div','event '+(frame.outcome||frame.status||''));var kind=node('div','kind',frame.type.replaceAll('_',' '));var text='';if(frame.type==='run_started')text='Execution started';else if(frame.type==='assistant_delta')text=frame.delta+(frame.truncated?' …[truncated]':'');else if(frame.type==='tool_started')text=frame.toolName+'\\n'+frame.arguments+(frame.truncated?' …[truncated]':'');else if(frame.type==='tool_finished')text=frame.toolName+' · '+(frame.isError?'error':'done')+'\\n'+frame.output+(frame.truncated?' …[truncated]':'');else if(frame.type==='execution_finished')text=frame.status+(frame.error?' · '+frame.error:'');else if(frame.type==='run_graded'){text=frame.outcome+' · '+frame.passedGraders+'/'+frame.totalGraders+' graders';graded+=1;state.textContent='Graded '+graded}row.append(kind,node('div','body',text));run.events.append(row);run.count+=1;var chars=text.length+kind.textContent.length;rendered.push({node:row,run:run,chars:chars});renderedChars+=chars;prune()}
  var source=new EventSource('/api/live/'+encodeURIComponent(token)+'/events');
  source.addEventListener('open',function(){state.textContent='Live';meta.textContent='Receiving bounded development-only events.'});
  source.addEventListener('gap',function(message){var value={droppedBeforeSequence:0};try{value=JSON.parse(message.data)}catch(_error){}showGap('Older provisional frames were dropped before sequence '+String(value.droppedBeforeSequence)+'. Canonical evidence remains complete.')});
  source.addEventListener('run',function(message){try{add(JSON.parse(message.data))}catch(_error){state.textContent='Invalid frame'}});
  source.addEventListener('session',function(message){var value={status:'completed'};try{value=JSON.parse(message.data)}catch(_error){}state.textContent=value.status==='completed'?'Complete':value.status;meta.textContent=value.status==='completed'?'Run finished. Open a verified report after diagnosis is ready.':'Live observation ended; canonical evidence remains on disk.';source.close()});
  source.onerror=function(){if(source.readyState!==EventSource.CLOSED)state.textContent='Reconnecting'};
}());
</script></body></html>`;
}
