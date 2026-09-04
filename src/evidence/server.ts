import { percent } from "../measurement.js";
import { language } from "../i18n.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { diagnosisPath } from "../diagnosis.js";
import {
	isSealedEvalRun,
	listPublicEvalRunIndexesBounded,
	loadEvalRun,
	readEvalRunIndex,
	type EvalRunRecord,
	type PublicEvalRunIndexEntry,
} from "../eval.js";
import { collectEvalReportData } from "../report.js";
import { safeArtifactSegment } from "../storage/paths.js";
import {
	createLiveTraceHub,
	isLiveTraceId,
	renderLiveTraceHtml,
	type EvidenceLiveTrace,
	type LiveTraceFrame,
} from "./live.js";
import {
	EvidenceNotDiagnosed,
	EvidenceNotFound,
	collectComparePage,
	collectEvalPage,
	collectRunDetailPage,
} from "./model.js";
import {
	EVIDENCE_STYLESHEET,
	h,
	renderComparePage,
	renderEvalPage,
	renderRunDetailPage,
} from "./pages.js";

const LOOPBACK_HOST = "127.0.0.1";
export const EVIDENCE_INDEX_MAX_RECORDS = 100;
export const EVIDENCE_INDEX_MAX_BYTES = 128 * 1024;
const MAX_PENDING_SSE_FRAMES = 384;
const MAX_PENDING_SSE_BYTES = 1024 * 1024;

export interface EvidenceExplorerOptions {
	runsRoot: string;
	/**
	 * Where this project's human judge labels live. Without it the explorer
	 * would render "judge not calibrated" beside evidence `ahde report` shows as
	 * calibrated — the same eval run, two AHDE surfaces, opposite claims. Absent
	 * means the explorer says nothing about calibration rather than asserting
	 * the negative.
	 */
	labels?: { stateRoot: string; projectId: string };
}

export interface EvidenceExplorerAddress {
	host: typeof LOOPBACK_HOST;
	port: number;
	url: string;
	urlForEval(evalRunId: string): string;
	urlForLiveTrace(liveTraceId: string): string;
}

export interface EvidenceExplorer {
	listen(port?: number): Promise<EvidenceExplorerAddress>;
	startLiveTrace(): EvidenceLiveTrace;
	close(): Promise<void>;
}

function securityHeaders(response: ServerResponse): void {
	response.setHeader("Cache-Control", "no-store");
	response.setHeader("Content-Security-Policy", "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
	response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
	response.setHeader("Referrer-Policy", "no-referrer");
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("X-Frame-Options", "DENY");
}

const NOT_DIAGNOSED_BODY = "Evidence is not diagnosed yet; run the AHDE diagnosis operation first.\n";
const COLLECTION_FAILURE_BODY = "Evidence report failed integrity or visibility checks.\n";

function send(response: ServerResponse, status: number, type: string, body: string, headOnly = false): void {
	securityHeaders(response);
	response.statusCode = status;
	response.setHeader("Content-Type", type);
	response.setHeader("Content-Length", Buffer.byteLength(body));
	response.end(headOnly ? undefined : body);
}

function renderIndexRow(record: PublicEvalRunIndexEntry): {
	html: string;
	fieldsTruncated: boolean;
	fieldsRedacted: boolean;
} {
	const rate = percent(record.allPassRate);
	return {
		html: `<tr><td class="mono"><a href="/evals/${encodeURIComponent(record.evalRunId)}">${h(record.evalRunId)}</a></td>`
			+ `<td>${h(record.targetId)}</td><td>${h(record.label)}</td>`
			+ `<td class="mono">${h(record.startedAt)}</td><td class="num">${rate}</td></tr>`,
		fieldsTruncated: record.fieldsTruncated,
		fieldsRedacted: record.fieldsRedacted,
	};
}

function renderIndexDocument(
	rows: readonly { html: string; fieldsTruncated: boolean; fieldsRedacted: boolean }[],
	omittedPublicCount: number,
): string {
	const truncated = omittedPublicCount > 0;
	const fieldsTruncated = rows.some((row) => row.fieldsTruncated);
	const fieldsRedacted = rows.some((row) => row.fieldsRedacted);
	const status = truncated
		? `Showing the newest ${rows.length} public evaluation indexes; ${omittedPublicCount} older public evaluation(s) omitted by the bounded index.`
		: `Showing all ${rows.length} public evaluation index(es).`;
	const clipping = fieldsTruncated ? " Long public identifier fields are clipped." : "";
	const redaction = fieldsRedacted ? " Credential-shaped public identifiers are redacted." : "";
	const table = rows.length === 0
		? '<div class="scroll"><div class="empty">No development evidence yet. Run an evaluation from Builder Pi.</div></div>'
		: `<div class="scroll"><table><thead><tr><th>Eval run</th><th>Target</th><th>Label</th><th>Started</th><th>Pass rate</th></tr></thead><tbody>${rows.map((row) => row.html).join("")}</tbody></table></div>`;
	return `<!doctype html><html lang="${language()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AHDE Evidence</title><style>${EVIDENCE_STYLESHEET}</style></head><body><nav class="topbar"><span class="crumb">AHDE Evidence</span></nav><main class="wrap"><div class="head"><div><h1>AHDE Evidence</h1><div class="sub">Development and candidate evaluation indexes. Reports verify member evidence when opened. Sealed holdout traces are never exposed here.</div></div></div><p class="note" data-index-truncated="${truncated}" data-index-shown="${rows.length}" data-index-omitted-public="${omittedPublicCount}" data-index-fields-truncated="${fieldsTruncated}" data-index-fields-redacted="${fieldsRedacted}">${status}${clipping}${redaction}</p>${table}</main></body></html>`;
}

function renderIndex(records: PublicEvalRunIndexEntry[], omittedPublicCount = 0): string {
	const projected = records.map(renderIndexRow);
	const rows: { html: string; fieldsTruncated: boolean; fieldsRedacted: boolean }[] = [];
	for (const row of projected) {
		const candidate = [...rows, row];
		const candidateOmitted = omittedPublicCount + projected.length - candidate.length;
		if (Buffer.byteLength(renderIndexDocument(candidate, candidateOmitted)) > EVIDENCE_INDEX_MAX_BYTES) break;
		rows.push(row);
	}
	const finalOmitted = omittedPublicCount + projected.length - rows.length;
	const html = renderIndexDocument(rows, finalOmitted);
	if (Buffer.byteLength(html) > EVIDENCE_INDEX_MAX_BYTES) {
		throw new Error("evidence index shell exceeds its byte budget");
	}
	return html;
}

function parseEvalId(pathname: string, prefix: string, label = "eval run id"): string | null {
	if (!pathname.startsWith(prefix)) return null;
	const encoded = pathname.slice(prefix.length);
	if (!encoded || encoded.includes("/")) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(encoded);
	} catch {
		return null;
	}
	try {
		return safeArtifactSegment(decoded, label);
	} catch {
		return null;
	}
}

/**
 * How a page-collection failure becomes a status code. A missing or sealed
 * subject is indistinguishable from a subject that never existed — the response
 * body must not confirm that a sealed artifact is there.
 */
function sendCollectionFailure(response: ServerResponse, error: unknown, headOnly: boolean): void {
	if (error instanceof EvidenceNotFound) {
		send(response, 404, "text/plain; charset=utf-8", "Not found\n", headOnly);
		return;
	}
	if (error instanceof EvidenceNotDiagnosed) {
		send(response, 409, "text/plain; charset=utf-8", NOT_DIAGNOSED_BODY, headOnly);
		return;
	}
	send(response, 422, "text/plain; charset=utf-8", COLLECTION_FAILURE_BODY, headOnly);
}

/** Only the filter keys the eval page understands cross the query boundary. */
function evalPageQuery(url: URL): { outcome?: string; mode?: string } {
	const outcome = url.searchParams.get("outcome");
	const mode = url.searchParams.get("mode");
	return {
		...(outcome === "pass" || outcome === "fail" || outcome === "error" ? { outcome } : {}),
		...(mode && /^failure-mode-[0-9a-f]{24}$/.test(mode) ? { mode } : {}),
	};
}

function parseLiveTraceId(pathname: string, prefix: string): string | null {
	if (!pathname.startsWith(prefix)) return null;
	const encoded = pathname.slice(prefix.length);
	if (!encoded || encoded.includes("/")) return null;
	try {
		const decoded = decodeURIComponent(encoded);
		return isLiveTraceId(decoded) ? decoded : null;
	} catch {
		return null;
	}
}

function parseLiveTraceEventsId(pathname: string): string | null {
	const prefix = "/api/live/";
	const suffix = "/events";
	if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
	return parseLiveTraceId(pathname.slice(0, -suffix.length), prefix);
}

function allowedOrigins(address: EvidenceExplorerAddress): Set<string> {
	return new Set([
		address.url,
		`http://localhost:${address.port}`,
	]);
}

function trustedHost(incoming: IncomingMessage, address: EvidenceExplorerAddress): boolean {
	const host = incoming.headers.host?.toLowerCase();
	return host === `${address.host}:${address.port}` || host === `localhost:${address.port}`;
}

function trustedLiveRequest(incoming: IncomingMessage, address: EvidenceExplorerAddress): boolean {
	const fetchSite = incoming.headers["sec-fetch-site"];
	if (fetchSite === "cross-site") return false;
	const origin = incoming.headers.origin;
	return origin === undefined || allowedOrigins(address).has(origin);
}

function parseLastEventId(incoming: IncomingMessage): number {
	const raw = incoming.headers["last-event-id"];
	if (typeof raw !== "string" || !/^\d+$/.test(raw)) return 0;
	const value = Number(raw);
	return Number.isSafeInteger(value) ? value : 0;
}

function encodeSseFrame(frame: LiveTraceFrame): string {
	return `id: ${frame.sequence}\nevent: ${frame.event}\ndata: ${frame.data}\n\n`;
}

export function createEvidenceExplorer(options: EvidenceExplorerOptions): EvidenceExplorer {
	const runsRoot = resolve(options.runsRoot);
	const liveTraces = createLiveTraceHub();
	const liveResponses = new Set<ServerResponse>();
	let server: Server | null = null;
	let listening: EvidenceExplorerAddress | null = null;
	let listenPromise: Promise<EvidenceExplorerAddress> | null = null;

	const streamLiveTrace = (
		incoming: IncomingMessage,
		response: ServerResponse,
		liveTraceId: string,
		headOnly: boolean,
	): void => {
		if (!liveTraces.has(liveTraceId)) {
			send(response, 404, "text/plain; charset=utf-8", "Not found\n", headOnly);
			return;
		}
		if (headOnly) {
			securityHeaders(response);
			response.statusCode = 200;
			response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
			response.setHeader("Cache-Control", "no-store, no-transform");
			response.end();
			return;
		}

		type QueuedFrame = { frame: LiveTraceFrame; encoded: string; bytes: number };
		const queued: QueuedFrame[] = [];
		let queuedBytes = 0;
		let pumping = false;
		let stopped = false;
		let cleanup = (): void => undefined;
		let pump = (): Promise<void> => Promise.resolve();
		const enqueueFrame = (frame: LiveTraceFrame, schedule = true): boolean => {
			if (stopped || response.destroyed || response.writableEnded) return false;
			const encoded = encodeSseFrame(frame);
			const bytes = Buffer.byteLength(encoded);
			if (
				queued.length >= MAX_PENDING_SSE_FRAMES ||
				queuedBytes + bytes > MAX_PENDING_SSE_BYTES
			) {
				stopped = true;
				response.destroy();
				return false;
			}
			queued.push({ frame, encoded, bytes });
			queuedBytes += bytes;
			if (schedule) void pump();
			return true;
		};
		const subscription = liveTraces.subscribe(
			liveTraceId,
			parseLastEventId(incoming),
			enqueueFrame,
		);
		if (subscription.kind === "not-found") {
			send(response, 404, "text/plain; charset=utf-8", "Not found\n");
			return;
		}
		if (subscription.kind === "full") {
			send(response, 429, "text/plain; charset=utf-8", "Too many live trace viewers\n");
			return;
		}

		securityHeaders(response);
		response.statusCode = 200;
		response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
		response.setHeader("Cache-Control", "no-store, no-transform");
		response.setHeader("Connection", "keep-alive");
		response.setHeader("X-Accel-Buffering", "no");
		response.flushHeaders();
		liveResponses.add(response);
		const waitForDrain = (): Promise<boolean> => new Promise((resolveDrain) => {
			const done = (writable: boolean): void => {
				response.off("drain", onDrain);
				response.off("close", onClose);
				response.off("error", onError);
				resolveDrain(writable);
			};
			const onDrain = (): void => done(true);
			const onClose = (): void => done(false);
			const onError = (): void => done(false);
			response.once("drain", onDrain);
			response.once("close", onClose);
			response.once("error", onError);
		});
		pump = async (): Promise<void> => {
			if (pumping || stopped) return;
			pumping = true;
			try {
				if (response.writableNeedDrain && !await waitForDrain()) return;
				while (queued.length > 0 && !stopped) {
					const item = queued.shift()!;
					queuedBytes -= item.bytes;
					const writable = response.write(item.encoded);
					if (item.frame.event === "session") {
						stopped = true;
						response.end();
						return;
					}
					if (!writable && !await waitForDrain()) return;
				}
				if (!subscription.active && !response.writableEnded) response.end();
			} catch {
				stopped = true;
				response.destroy();
			} finally {
				pumping = false;
				if (!stopped && queued.length > 0) void pump();
			}
		};
		const heartbeat = setInterval(() => {
			if (stopped || response.writableNeedDrain) return;
			try {
				response.write(": keepalive\n\n");
			} catch {
				stopped = true;
				response.destroy();
			}
		}, 15_000);
		heartbeat.unref();
		cleanup = () => {
			stopped = true;
			queued.length = 0;
			queuedBytes = 0;
			clearInterval(heartbeat);
			subscription.unsubscribe();
			liveResponses.delete(response);
		};
		response.once("close", cleanup);
		response.write(": connected\n\n");
		const lastEventId = parseLastEventId(incoming);
		if (lastEventId < subscription.droppedBeforeSequence) {
			response.write(
				`event: gap\ndata: ${JSON.stringify({ droppedBeforeSequence: subscription.droppedBeforeSequence })}\n\n`,
			);
		}
		for (const frame of subscription.frames) {
			if (!enqueueFrame(frame, false)) return;
		}
		void pump();
	};

	const request = (incoming: IncomingMessage, response: ServerResponse): void => {
		void (async () => {
			const method = incoming.method ?? "GET";
			const headOnly = method === "HEAD";
			if (method !== "GET" && !headOnly) {
				response.setHeader("Allow", "GET, HEAD");
				send(response, 405, "text/plain; charset=utf-8", "Method not allowed\n");
				return;
			}
			const address = listening;
			if (!address) {
				send(response, 503, "text/plain; charset=utf-8", "Explorer is starting\n", headOnly);
				return;
			}
			if (!trustedHost(incoming, address)) {
				send(response, 421, "text/plain; charset=utf-8", "Misdirected request\n", headOnly);
				return;
			}

			let url: URL;
			try {
				url = new URL(incoming.url ?? "/", `http://${LOOPBACK_HOST}`);
			} catch {
				send(response, 400, "text/plain; charset=utf-8", "Invalid URL\n", headOnly);
				return;
			}

			if (url.pathname === "/healthz") {
				send(response, 200, "application/json; charset=utf-8", '{"ok":true}\n', headOnly);
				return;
			}
			if (url.pathname === "/") {
				let records: PublicEvalRunIndexEntry[];
				let omittedPublicCount = 0;
				try {
					const indexes = listPublicEvalRunIndexesBounded(runsRoot, EVIDENCE_INDEX_MAX_RECORDS);
					omittedPublicCount = indexes.omittedPublicCount;
					records = indexes.entries;
				} catch {
					send(response, 422, "text/plain; charset=utf-8", "Evidence metadata failed integrity checks.\n", headOnly);
					return;
				}
				send(response, 200, "text/html; charset=utf-8", renderIndex(records, omittedPublicCount), headOnly);
				return;
			}

			const liveTraceId = parseLiveTraceId(url.pathname, "/live/");
			const liveEventsId = parseLiveTraceEventsId(url.pathname);
			if (liveTraceId || liveEventsId) {
				if (!trustedLiveRequest(incoming, address)) {
					send(response, 403, "text/plain; charset=utf-8", "Cross-origin live trace request denied\n", headOnly);
					return;
				}
				const id = liveTraceId ?? liveEventsId!;
				if (!liveTraces.has(id)) {
					send(response, 404, "text/plain; charset=utf-8", "Not found\n", headOnly);
					return;
				}
				if (liveEventsId) {
					streamLiveTrace(incoming, response, id, headOnly);
					return;
				}
				send(response, 200, "text/html; charset=utf-8", renderLiveTraceHtml(), headOnly);
				return;
			}

			// One run's conversation, verdict, and host-written explanation. The
			// owning eval decides visibility; a run that cannot name one is refused.
			const runId = parseEvalId(url.pathname, "/runs/", "run id");
			if (runId) {
				try {
					send(
						response,
						200,
						"text/html; charset=utf-8",
						renderRunDetailPage(collectRunDetailPage(runsRoot, runId)),
						headOnly,
					);
				} catch (error) {
					sendCollectionFailure(response, error, headOnly);
				}
				return;
			}

			// Baseline versus candidate for one Candidate record. The sealed arm
			// contributes a verdict and a design size and nothing else.
			const candidateId = parseEvalId(url.pathname, "/candidates/", "candidate id");
			if (candidateId) {
				try {
					send(
						response,
						200,
						"text/html; charset=utf-8",
						renderComparePage(collectComparePage(runsRoot, candidateId)),
						headOnly,
					);
				} catch (error) {
					sendCollectionFailure(response, error, headOnly);
				}
				return;
			}

			const apiId = parseEvalId(url.pathname, "/api/evals/");
			const pageId = parseEvalId(url.pathname, "/evals/");
			const evalRunId = apiId ?? pageId;
			if (!evalRunId) {
				send(response, 404, "text/plain; charset=utf-8", "Not found\n", headOnly);
				return;
			}

			let preflight: EvalRunRecord;
			try {
				preflight = readEvalRunIndex(runsRoot, evalRunId);
			} catch {
				send(response, 404, "text/plain; charset=utf-8", "Not found\n", headOnly);
				return;
			}
			if (isSealedEvalRun(preflight)) {
				send(response, 404, "text/plain; charset=utf-8", "Not found\n", headOnly);
				return;
			}
			try {
				loadEvalRun(runsRoot, evalRunId);
			} catch {
				send(response, 422, "text/plain; charset=utf-8", "Evidence failed integrity checks.\n", headOnly);
				return;
			}
			// HTTP remains a read-only projection. Diagnosis must have been produced
			// by the canonical evaluation/diagnosis workflow before it can be viewed.
			if (!existsSync(diagnosisPath(runsRoot, evalRunId))) {
				send(response, 409, "text/plain; charset=utf-8", "Evidence is not diagnosed yet; run the AHDE diagnosis operation first.\n", headOnly);
				return;
			}
			if (apiId) {
				let data: ReturnType<typeof collectEvalReportData>;
				try {
					data = collectEvalReportData(runsRoot, evalRunId, undefined, {
						allowDiagnosisCreation: false,
						...(options.labels ? { labels: options.labels } : {}),
					});
				} catch {
					send(response, 422, "text/plain; charset=utf-8", "Evidence report failed integrity or visibility checks.\n", headOnly);
					return;
				}
				send(response, 200, "application/json; charset=utf-8", `${JSON.stringify(data)}\n`, headOnly);
				return;
			}
			let page: string;
			try {
				page = renderEvalPage(collectEvalPage(runsRoot, evalRunId, {
					...(options.labels ? { labels: options.labels } : {}),
					query: evalPageQuery(url),
				}));
			} catch {
				send(response, 422, "text/plain; charset=utf-8", "Evidence report failed integrity or visibility checks.\n", headOnly);
				return;
			}
			send(response, 200, "text/html; charset=utf-8", page, headOnly);
		})().catch((error: unknown) => {
			if (response.headersSent || response.writableEnded) {
				if (!response.writableEnded) response.destroy();
				return;
			}
			void error;
			send(response, 422, "text/plain; charset=utf-8", "Evidence explorer request failed.\n");
		});
	};

	return {
		async listen(port = 0): Promise<EvidenceExplorerAddress> {
			if (listening) return listening;
			if (!listenPromise) {
				const candidate = createServer(request);
				listenPromise = (async () => {
					try {
						await new Promise<void>((resolveListen, rejectListen) => {
							const onError = (error: Error): void => rejectListen(error);
							candidate.once("error", onError);
							candidate.listen(port, LOOPBACK_HOST, () => {
								candidate.off("error", onError);
								resolveListen();
							});
						});
						const address = candidate.address();
						if (!address || typeof address === "string") {
							throw new Error("evidence explorer did not bind a TCP port");
						}
						const url = `http://${LOOPBACK_HOST}:${address.port}`;
						const resolvedAddress: EvidenceExplorerAddress = {
							host: LOOPBACK_HOST,
							port: address.port,
							url,
							urlForEval(evalRunId: string): string {
								return `${url}/evals/${encodeURIComponent(safeArtifactSegment(evalRunId, "eval run id"))}`;
							},
							urlForLiveTrace(liveTraceId: string): string {
								if (!isLiveTraceId(liveTraceId)) throw new Error("invalid live trace id");
								return `${url}/live/${encodeURIComponent(liveTraceId)}`;
							},
						};
						server = candidate;
						listening = resolvedAddress;
						return resolvedAddress;
					} catch (error) {
						if (candidate.listening) {
							await new Promise<void>((resolveClose) => candidate.close(() => resolveClose()));
						}
						candidate.removeAllListeners();
						throw error;
					}
				})();
			}
			const pending = listenPromise;
			try {
				return await pending;
			} finally {
				if (listenPromise === pending) listenPromise = null;
			}
		},
		startLiveTrace(): EvidenceLiveTrace {
			return liveTraces.start();
		},
		async close(): Promise<void> {
			const pending = listenPromise;
			if (pending) {
				try {
					await pending;
				} catch {
					// A never-listened server has nothing to close.
				}
			}
			const active = server;
			server = null;
			listening = null;
			listenPromise = null;
			liveTraces.close();
			for (const response of liveResponses) response.end();
			liveResponses.clear();
			if (!active?.listening) return;
			await new Promise<void>((resolveClose, reject) => {
				active.close((error) => {
					if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
						resolveClose();
						return;
					}
					reject(error);
				});
			});
		},
	};
}
