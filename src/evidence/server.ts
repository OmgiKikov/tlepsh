import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { diagnosisPath } from "../diagnosis.js";
import { listEvalRuns, loadEvalRun, type EvalRunRecord } from "../eval.js";
import { collectEvalReportData, renderEvalReportHtml } from "../report.js";
import { safeArtifactSegment } from "../storage/paths.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_ERROR_CHARS = 2_000;

export interface EvidenceExplorerOptions {
	runsRoot: string;
}

export interface EvidenceExplorerAddress {
	host: typeof LOOPBACK_HOST;
	port: number;
	url: string;
	urlForEval(evalRunId: string): string;
}

export interface EvidenceExplorer {
	listen(port?: number): Promise<EvidenceExplorerAddress>;
	close(): Promise<void>;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	})[character] ?? character);
}

function isSealed(record: Pick<EvalRunRecord, "dataset">): boolean {
	return record.dataset.startsWith("sealed-");
}

function securityHeaders(response: ServerResponse): void {
	response.setHeader("Cache-Control", "no-store");
	response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
	response.setHeader("Referrer-Policy", "no-referrer");
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("X-Frame-Options", "DENY");
}

function send(response: ServerResponse, status: number, type: string, body: string, headOnly = false): void {
	securityHeaders(response);
	response.statusCode = status;
	response.setHeader("Content-Type", type);
	response.setHeader("Content-Length", Buffer.byteLength(body));
	response.end(headOnly ? undefined : body);
}

function renderIndex(records: EvalRunRecord[]): string {
	const rows = records.map((record) => {
		const rate = Math.round(record.summary.allPassRate * 100);
		return `<a class="run" href="/evals/${encodeURIComponent(record.evalRunId)}"><span><strong>${escapeHtml(record.target.id)}</strong><small>${escapeHtml(record.evalRunId)} · ${escapeHtml(record.label)} · ${escapeHtml(record.startedAt)}</small></span><b>${rate}%</b></a>`;
	}).join("");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AHDE Evidence</title><style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#090b10;color:#edf0f7}*{box-sizing:border-box}body{max-width:980px;margin:0 auto;padding:48px 24px}h1{font-size:42px;letter-spacing:-.04em;margin:0 0 8px}p{color:#929bae;margin:0 0 32px}.run{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:18px;margin:10px 0;color:inherit;text-decoration:none;border:1px solid #252b38;border-radius:14px;background:#10131b}.run:hover{border-color:#6d7cff;background:#151a24}.run span{min-width:0}.run strong,.run small{display:block}.run small{margin-top:6px;color:#929bae;overflow:hidden;text-overflow:ellipsis}.run b{font-size:24px;color:#8d98ff}.empty{padding:30px;border:1px dashed #303746;border-radius:14px;color:#929bae}</style></head><body><h1>AHDE Evidence</h1><p>Verified development and candidate evaluations. Sealed holdout traces are never exposed here.</p>${rows || '<div class="empty">No development evidence yet. Run an evaluation from Builder Pi.</div>'}</body></html>`;
}

function parseEvalId(pathname: string, prefix: string): string | null {
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
		return safeArtifactSegment(decoded, "eval run id");
	} catch {
		return null;
	}
}

export function createEvidenceExplorer(options: EvidenceExplorerOptions): EvidenceExplorer {
	const runsRoot = resolve(options.runsRoot);
	let server: Server | null = null;
	let listening: EvidenceExplorerAddress | null = null;

	const request = (incoming: IncomingMessage, response: ServerResponse): void => {
		void (async () => {
			const method = incoming.method ?? "GET";
			const headOnly = method === "HEAD";
			if (method !== "GET" && !headOnly) {
				response.setHeader("Allow", "GET, HEAD");
				send(response, 405, "text/plain; charset=utf-8", "Method not allowed\n");
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
				const records = listEvalRuns(runsRoot).filter((record) => !isSealed(record));
				send(response, 200, "text/html; charset=utf-8", renderIndex(records), headOnly);
				return;
			}

			const apiId = parseEvalId(url.pathname, "/api/evals/");
			const pageId = parseEvalId(url.pathname, "/evals/");
			const evalRunId = apiId ?? pageId;
			if (!evalRunId) {
				send(response, 404, "text/plain; charset=utf-8", "Not found\n", headOnly);
				return;
			}

			const record = loadEvalRun(runsRoot, evalRunId);
			if (isSealed(record)) {
				send(response, 404, "text/plain; charset=utf-8", "Not found\n", headOnly);
				return;
			}
			// HTTP remains a read-only projection. Diagnosis must have been produced
			// by the canonical evaluation/diagnosis workflow before it can be viewed.
			if (!existsSync(diagnosisPath(runsRoot, evalRunId))) {
				send(response, 409, "text/plain; charset=utf-8", "Evidence is not diagnosed yet; run the AHDE diagnosis operation first.\n", headOnly);
				return;
			}
			const data = collectEvalReportData(runsRoot, evalRunId, undefined, {
				allowDiagnosisCreation: false,
			});
			if (apiId) {
				const body = `${JSON.stringify(data)}\n`;
				send(response, 200, "application/json; charset=utf-8", body, headOnly);
				return;
			}
			send(response, 200, "text/html; charset=utf-8", renderEvalReportHtml(data), headOnly);
		})().catch((error: unknown) => {
			const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARS);
			const missing = /ENOENT|cannot be inspected|no such file/i.test(message);
			send(response, missing ? 404 : 422, "text/plain; charset=utf-8", `${message}\n`);
		});
	};

	return {
		async listen(port = 0): Promise<EvidenceExplorerAddress> {
			if (listening) return listening;
			server = createServer(request);
			await new Promise<void>((resolveListen, reject) => {
				server?.once("error", reject);
				server?.listen(port, LOOPBACK_HOST, () => {
					server?.off("error", reject);
					resolveListen();
				});
			});
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("evidence explorer did not bind a TCP port");
			const url = `http://${LOOPBACK_HOST}:${address.port}`;
			listening = {
				host: LOOPBACK_HOST,
				port: address.port,
				url,
				urlForEval(evalRunId: string): string {
					return `${url}/evals/${encodeURIComponent(safeArtifactSegment(evalRunId, "eval run id"))}`;
				},
			};
			return listening;
		},
		async close(): Promise<void> {
			const active = server;
			server = null;
			listening = null;
			if (!active) return;
			await new Promise<void>((resolveClose, reject) => {
				active.close((error) => error ? reject(error) : resolveClose());
			});
		},
	};
}
