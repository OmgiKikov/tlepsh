import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { projectForModel } from "../builder/workbench-adapter.js";
import type { BuilderProjectContext } from "../builder/project-context.js";
import { resolveBuilderProjectId } from "../builder/project-context.js";
import type { RunEvent, RunEventListener } from "../run-events.js";
import { redactTraceText } from "../trace.js";
import { WorkbenchDecisionDeclinedError } from "../workbench/errors.js";
import {
	WorkbenchDecisionInputSchema,
	WorkbenchSubmitInputSchema,
	WorkbenchViewIncludeSchema,
	WorkbenchViewQuerySchema,
	type WorkbenchDecisionInput,
	type WorkbenchViewInclude,
	type WorkbenchViewQuery,
} from "../workbench/types.js";
import {
	createAhdeWorkbench,
	type AhdeWorkbench,
	type AhdeWorkbenchDependencies,
} from "../workbench/workbench.js";
import {
	createServeConfirmationRegistry,
	isServeConfirmationId,
	serveWorkbenchActorId,
	type ServeConfirmationProjection,
	type ServeConfirmationRegistry,
	type ServeOperation,
} from "./confirmations.js";
import { createServeEventHub, type ServeEventHub } from "./events.js";
import { acquireServeSessionLock, type ServeSessionLock } from "./session-lock.js";

/**
 * `ahde serve` — the Workbench behind a local HTTP/JSON API whose human gate is
 * the platform's confirmation UI.
 *
 * Nothing about the trust model moves. The API is a transport for the same
 * `WorkbenchHumanGate` the TUI implements: a consequential decision still
 * blocks on a human answering the exact host-minted subject hash, authority
 * (actor identity, sealed-holdout selection) stays host-side and is never read
 * from a request body, and the same receipts are written by the same
 * application services. The only thing this file adds is a socket: 127.0.0.1
 * only, one bearer token minted at startup, Host/Origin checks, a route and
 * method allowlist, bounded bodies, and one session per project.
 */

const LOOPBACK_HOST = "127.0.0.1";
/** The only host names an operator may name; both bind the loopback interface. */
export const SERVE_ALLOWED_HOSTS = ["127.0.0.1", "localhost"] as const;

/** Bodies. A submission may carry a whole corpus draft; a decision may not. */
export const SERVE_MAX_SUBMIT_BODY_BYTES = 1024 * 1024;
export const SERVE_MAX_DECISION_BODY_BYTES = 64 * 1024;
/** Aggregate cap on the pending-confirmation listing; older ones are counted, not sent. */
const MAX_CONFIRMATION_LIST_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_SSE_FRAMES = 256;
const MAX_PENDING_SSE_BYTES = 512 * 1024;
const MAX_EVENT_ERROR_CHARS = 500;

/** Fields the API never accepts inside a submission or a decision (invariant 16). */
const FORBIDDEN_AUTHORITY_KEYS = new Set(["actor", "actorId", "approved", "confirmed"]);

export interface AhdeServeOptions extends BuilderProjectContext {
	/** Loopback host name the operator asked for; binding is always 127.0.0.1. */
	host?: string;
	confirmationTimeoutSeconds?: number;
	/** Skip the one-session-per-project lock. The operator has to ask for this. */
	allowConcurrent?: boolean;
	templateDir?: string;
	dependencies?: Partial<AhdeWorkbenchDependencies>;
	/** Pre-built Workbench (tests and embedding hosts); one is constructed otherwise. */
	workbench?: AhdeWorkbench;
	/** Host-owned operator identity; derived from the OS account otherwise. */
	actorId?: string;
	/** Also write the minted token here, 0600. Removed when the server closes. */
	tokenFile?: string;
	now?: () => string;
}

export interface AhdeServeAddress {
	host: typeof LOOPBACK_HOST;
	port: number;
	url: string;
}

export interface AhdeServeApi {
	/** The bearer token, minted once. Printed by the host; never in a response. */
	readonly token: string;
	readonly projectId: string;
	readonly actorId: string;
	listen(port?: number): Promise<AhdeServeAddress>;
	address(): AhdeServeAddress | null;
	close(): Promise<void>;
}

interface DecisionEnvelope {
	status: number;
	body: unknown;
}

interface OperationEntry {
	operation: ServeOperation;
	settled: Promise<DecisionEnvelope>;
}

function securityHeaders(response: ServerResponse): void {
	response.setHeader("Cache-Control", "no-store");
	response.setHeader(
		"Content-Security-Policy",
		"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	);
	response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
	response.setHeader("Referrer-Policy", "no-referrer");
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
	const body = `${JSON.stringify(payload)}\n`;
	securityHeaders(response);
	response.statusCode = status;
	response.setHeader("Content-Type", "application/json; charset=utf-8");
	response.setHeader("Content-Length", Buffer.byteLength(body));
	response.end(body);
}

function sendError(response: ServerResponse, status: number, error: string): void {
	sendJson(response, status, { status: "error", error });
}

/** The first model- or client-supplied authority field, by path, or null. */
export function findAuthorityField(value: unknown, path: readonly string[] = []): string | null {
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			const found = findAuthorityField(item, [...path, String(index)]);
			if (found) return found;
		}
		return null;
	}
	if (typeof value !== "object" || value === null) return null;
	for (const [key, item] of Object.entries(value)) {
		if (FORBIDDEN_AUTHORITY_KEYS.has(key)) return [...path, key].join(".");
		const found = findAuthorityField(item, [...path, key]);
		if (found) return found;
	}
	return null;
}

function boundedErrorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return redactTraceText(message).slice(0, MAX_EVENT_ERROR_CHARS);
}

function encodeSseFrame(frame: { sequence: number; event: string; data: string }): string {
	return `id: ${frame.sequence}\nevent: ${frame.event}\ndata: ${frame.data}\n\n`;
}

function parseLastEventId(incoming: IncomingMessage): number {
	const raw = incoming.headers["last-event-id"];
	if (typeof raw !== "string" || !/^\d+$/.test(raw)) return 0;
	const value = Number(raw);
	return Number.isSafeInteger(value) ? value : 0;
}

function writeTokenFile(path: string, token: string): void {
	// `wx` refuses an existing file, so a symlink or a leftover token is never followed.
	let handle: number;
	try {
		handle = openSync(path, "wx", 0o600);
	} catch (error) {
		throw new Error(
			`--token-file ${path} must not already exist; remove it or choose another path`,
			{ cause: error },
		);
	}
	try {
		writeSync(handle, `${token}\n`);
	} finally {
		closeSync(handle);
	}
}

export function createAhdeServeApi(options: AhdeServeOptions): AhdeServeApi {
	const projectId = resolveBuilderProjectId(options);
	const actorId = options.actorId ?? serveWorkbenchActorId();
	const requestedHost = (options.host ?? LOOPBACK_HOST).toLowerCase();
	if (!(SERVE_ALLOWED_HOSTS as readonly string[]).includes(requestedHost)) {
		throw new Error(
			`ahde serve binds loopback only; --host must be one of ${SERVE_ALLOWED_HOSTS.join(", ")}`,
		);
	}
	const workbench = options.workbench ?? createAhdeWorkbench({
		projectDir: options.projectDir,
		stateRoot: options.stateRoot,
		runsRoot: options.runsRoot,
		projectId,
		...(options.templateDir ? { templateDir: options.templateDir } : {}),
		...(options.dependencies ? { dependencies: options.dependencies } : {}),
	});
	const token = randomBytes(32).toString("base64url");
	const tokenDigest = createHash("sha256").update(token).digest();
	const tokenFile = options.tokenFile ? resolve(options.tokenFile) : null;

	const events: ServeEventHub = createServeEventHub();
	const registry: ServeConfirmationRegistry = createServeConfirmationRegistry({
		actorId,
		...(options.confirmationTimeoutSeconds !== undefined
			? { timeoutSeconds: options.confirmationTimeoutSeconds }
			: {}),
		...(options.now ? { now: options.now } : {}),
		onOpened: (confirmation) => events.publish("confirmation-opened", {
			confirmationId: confirmation.confirmationId,
			operationId: confirmation.operationId,
			kind: confirmation.kind,
			title: confirmation.title,
			policy: confirmation.policy,
			subjectHash: confirmation.subjectHash,
			expiresAt: confirmation.expiresAt,
		}),
		onClosed: (confirmation, settlement) => events.publish("confirmation-closed", {
			confirmationId: confirmation.confirmationId,
			operationId: confirmation.operationId,
			kind: confirmation.kind,
			settlement,
		}),
	});
	const operations = new Map<string, OperationEntry>();
	const sseResponses = new Set<ServerResponse>();

	let server: Server | null = null;
	let listening: AhdeServeAddress | null = null;
	let listenPromise: Promise<AhdeServeAddress> | null = null;
	let lock: ServeSessionLock | null = null;
	let tokenFileWritten = false;

	const runEventListener: RunEventListener = (event: RunEvent) => {
		// Already bounded and credential-redacted by the run-events seam, and
		// never attached to a sealed arm by the candidate experiment.
		events.publish("run-progress", event);
	};

	const publishChanged = (cause: string, view: { stage: string; headline: string }): void => {
		events.publish("workbench-changed", { cause, stage: view.stage, headline: view.headline });
	};

	/** One decide call, start to finish. It never rejects: refusals are envelopes. */
	const runDecision = async (
		operation: ServeOperation,
		input: WorkbenchDecisionInput,
	): Promise<DecisionEnvelope> => {
		try {
			const result = await workbench.decide(input, operation.gate, { onRunEvent: runEventListener });
			publishChanged(input.kind, result.view);
			events.publish("operation-settled", {
				operationId: operation.operationId,
				kind: input.kind,
				status: "completed",
			});
			return { status: 200, body: projectForModel(result) };
		} catch (error) {
			const declined = error instanceof WorkbenchDecisionDeclinedError;
			events.publish("operation-settled", {
				operationId: operation.operationId,
				kind: input.kind,
				status: declined ? "declined" : "failed",
				error: boundedErrorText(error),
			});
			return {
				status: declined ? 409 : 422,
				body: {
					status: declined ? "declined" : "failed",
					kind: input.kind,
					error: error instanceof Error ? error.message : String(error),
				},
			};
		} finally {
			operation.dispose();
			operations.delete(operation.operationId);
		}
	};

	const awaitingBody = (confirmation: ServeConfirmationProjection): unknown => ({
		status: "awaiting-confirmation",
		confirmationId: confirmation.confirmationId,
		operationId: confirmation.operationId,
		kind: confirmation.kind,
		title: confirmation.title,
		question: confirmation.question,
		reason: confirmation.reason,
		subject: confirmation.subject,
		subjectHash: confirmation.subjectHash,
		policy: confirmation.policy,
		...(confirmation.estimate ? { estimate: confirmation.estimate } : {}),
		...(confirmation.options ? { options: confirmation.options } : {}),
		openedAt: confirmation.openedAt,
		expiresAt: confirmation.expiresAt,
	});

	/**
	 * Wait for whichever comes first: the operation finishing, or it opening its
	 * next confirmation. A composite that asks twice therefore hands the operator
	 * the second question the moment they answered the first.
	 */
	const awaitOperation = async (entry: OperationEntry, seen: number): Promise<DecisionEnvelope> => {
		const settledTag = entry.settled.then((result) => ({ tag: "settled" as const, result }));
		const nextTag = entry.operation.nextConfirmation(seen, entry.settled)
			.then((confirmation) => ({ tag: "confirmation" as const, confirmation }));
		const raced = await Promise.race([settledTag, nextTag]);
		if (raced.tag === "confirmation" && raced.confirmation) {
			return { status: 202, body: awaitingBody(raced.confirmation) };
		}
		return entry.settled;
	};

	const handleDecide = async (body: unknown): Promise<DecisionEnvelope> => {
		const parsed = WorkbenchDecisionInputSchema.safeParse(body);
		if (!parsed.success) {
			return { status: 400, body: { status: "error", error: `invalid decision: ${parsed.error.message}` } };
		}
		// One operator, one decision at a time — the same shape as the TUI, and
		// the reason two decisions can never race each other's durable writes.
		if (operations.size > 0) {
			return {
				status: 409,
				body: {
					status: "error",
					error: "another decision is already in flight; answer its confirmation or wait for it to finish",
				},
			};
		}
		const operation = registry.beginOperation();
		const entry: OperationEntry = {
			operation,
			settled: runDecision(operation, parsed.data),
		};
		operations.set(operation.operationId, entry);
		return awaitOperation(entry, 0);
	};

	/** Submissions are short and non-consequential, but they still write; queue them. */
	let submissions: Promise<unknown> = Promise.resolve();

	const handleSubmit = async (body: unknown): Promise<DecisionEnvelope> => {
		const parsed = WorkbenchSubmitInputSchema.safeParse(body);
		if (!parsed.success) {
			return { status: 400, body: { status: "error", error: `invalid submission: ${parsed.error.message}` } };
		}
		const queued = submissions.then(async (): Promise<DecisionEnvelope> => {
			try {
				const turn = await workbench.submit(parsed.data);
				publishChanged(turn.kind, turn.view);
				return { status: 200, body: projectForModel(turn) };
			} catch (error) {
				return {
					status: 422,
					body: { status: "failed", error: error instanceof Error ? error.message : String(error) },
				};
			}
		});
		submissions = queued.catch(() => undefined);
		return queued;
	};

	const handleConfirmationAnswer = async (
		confirmationId: string,
		body: unknown,
	): Promise<DecisionEnvelope> => {
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return { status: 400, body: { status: "error", error: "a confirmation answer is a JSON object" } };
		}
		const record = body as Record<string, unknown>;
		const approved = record.approved;
		const subjectHash = record.subjectHash;
		if (typeof approved !== "boolean") {
			return { status: 400, body: { status: "error", error: "approved must be a boolean" } };
		}
		if (typeof subjectHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(subjectHash)) {
			return {
				status: 400,
				body: { status: "error", error: "subjectHash must be the exact sha256 digest the confirmation carried" },
			};
		}
		const selectedIndexRaw = record.selectedIndex;
		if (selectedIndexRaw !== undefined && typeof selectedIndexRaw !== "number") {
			return { status: 400, body: { status: "error", error: "selectedIndex must be a number" } };
		}
		for (const key of Object.keys(record)) {
			if (!["approved", "subjectHash", "selectedIndex"].includes(key)) {
				return { status: 400, body: { status: "error", error: `unknown confirmation answer field ${key}` } };
			}
		}
		const answered = registry.answer(confirmationId, {
			approved,
			subjectHash,
			...(selectedIndexRaw === undefined ? {} : { selectedIndex: selectedIndexRaw }),
		});
		if (answered.outcome === "unknown") {
			return { status: 404, body: { status: "error", error: "no such pending confirmation" } };
		}
		if (answered.outcome === "already-settled") {
			return {
				status: 409,
				body: {
					status: "error",
					error: `that confirmation was already ${answered.settlement}; a second answer is refused`,
				},
			};
		}
		if (answered.outcome === "subject-changed") {
			return {
				status: 409,
				body: {
					status: "error",
					error: "subjectHash does not bind the exact subject this confirmation carries; the decision was refused",
				},
			};
		}
		if (answered.outcome === "invalid") {
			return { status: 400, body: { status: "error", error: answered.message } };
		}
		const entry = operations.get(answered.confirmation.operationId);
		if (!entry) {
			return {
				status: 409,
				body: { status: "error", error: "the operation behind that confirmation is no longer running" },
			};
		}
		return awaitOperation(entry, entry.operation.openedCount());
	};

	const handleView = async (url: URL): Promise<DecisionEnvelope> => {
		const includes: WorkbenchViewInclude[] = [];
		for (const raw of url.searchParams.getAll("include")) {
			for (const item of raw.split(",")) {
				const value = item.trim();
				if (value === "") continue;
				const parsed = WorkbenchViewIncludeSchema.safeParse(value);
				if (!parsed.success) {
					return { status: 400, body: { status: "error", error: `unknown include ${JSON.stringify(value)}` } };
				}
				includes.push(parsed.data);
			}
		}
		const aspect = url.searchParams.get("aspect");
		const resourcePath = url.searchParams.get("resourcePath");
		const parsedQuery = WorkbenchViewQuerySchema.safeParse({
			...(aspect === null ? {} : { aspect }),
			...(resourcePath === null ? {} : { resourcePath }),
		});
		if (!parsedQuery.success) {
			return { status: 400, body: { status: "error", error: `invalid view query: ${parsedQuery.error.message}` } };
		}
		const query: WorkbenchViewQuery = parsedQuery.data;
		try {
			const view = await workbench.view(query);
			return { status: 200, body: projectForModel(view, { include: includes }) };
		} catch (error) {
			return {
				status: 422,
				body: { status: "failed", error: error instanceof Error ? error.message : String(error) },
			};
		}
	};

	const handleConfirmationList = (): DecisionEnvelope => {
		const all = registry.pending().map(awaitingBody);
		const kept: unknown[] = [];
		let bytes = 0;
		for (const item of all) {
			const size = Buffer.byteLength(JSON.stringify(item), "utf8");
			if (kept.length > 0 && bytes + size > MAX_CONFIRMATION_LIST_BYTES) break;
			kept.push(item);
			bytes += size;
		}
		return {
			status: 200,
			body: { schemaVersion: 1, confirmations: kept, omitted: all.length - kept.length },
		};
	};

	const handleHealth = async (): Promise<DecisionEnvelope> => {
		let stage: string | null = null;
		let headline: string | null = null;
		try {
			const view = await workbench.view();
			stage = view.stage;
			headline = view.headline;
		} catch {
			// A project that cannot be read yet is still a healthy server.
		}
		return {
			status: 200,
			body: {
				ok: true,
				schemaVersion: 1,
				projectId,
				stage,
				headline,
				pendingConfirmations: registry.pending().length,
			},
		};
	};

	const streamEvents = (incoming: IncomingMessage, response: ServerResponse): void => {
		type Queued = { encoded: string; bytes: number };
		const queued: Queued[] = [];
		let queuedBytes = 0;
		let pumping = false;
		let stopped = false;

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

		const pump = async (): Promise<void> => {
			if (pumping || stopped) return;
			pumping = true;
			try {
				if (response.writableNeedDrain && !await waitForDrain()) return;
				while (queued.length > 0 && !stopped) {
					const item = queued.shift()!;
					queuedBytes -= item.bytes;
					if (!response.write(item.encoded) && !await waitForDrain()) return;
				}
			} catch {
				stopped = true;
				response.destroy();
			} finally {
				pumping = false;
				if (!stopped && queued.length > 0) void pump();
			}
		};

		const enqueue = (frame: { sequence: number; event: string; data: string }, schedule = true): boolean => {
			if (stopped || response.destroyed || response.writableEnded) return false;
			const encoded = encodeSseFrame(frame);
			const bytes = Buffer.byteLength(encoded);
			if (queued.length >= MAX_PENDING_SSE_FRAMES || queuedBytes + bytes > MAX_PENDING_SSE_BYTES) {
				stopped = true;
				response.destroy();
				return false;
			}
			queued.push({ encoded, bytes });
			queuedBytes += bytes;
			if (schedule) void pump();
			return true;
		};

		const subscription = events.subscribe(parseLastEventId(incoming), enqueue);
		if (subscription.kind === "full") {
			sendError(response, 429, "too many event stream viewers");
			return;
		}

		securityHeaders(response);
		response.statusCode = 200;
		response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
		response.setHeader("Cache-Control", "no-store, no-transform");
		response.setHeader("Connection", "keep-alive");
		response.setHeader("X-Accel-Buffering", "no");
		response.flushHeaders();
		sseResponses.add(response);

		const heartbeat = setInterval(() => {
			if (stopped || response.writableNeedDrain) return;
			try {
				response.write(": keepalive\n\n");
			} catch {
				stopped = true;
				response.destroy();
			}
		}, 15_000);
		heartbeat.unref?.();
		response.once("close", () => {
			stopped = true;
			queued.length = 0;
			queuedBytes = 0;
			clearInterval(heartbeat);
			subscription.unsubscribe();
			sseResponses.delete(response);
		});

		response.write(": connected\n\n");
		if (parseLastEventId(incoming) < subscription.droppedBeforeSequence) {
			response.write(
				`event: gap\ndata: ${JSON.stringify({ droppedBeforeSequence: subscription.droppedBeforeSequence })}\n\n`,
			);
		}
		for (const frame of subscription.frames) {
			if (!enqueue(frame, false)) return;
		}
		void pump();
	};

	/**
	 * Bounded body read. Nothing over `limit` is ever buffered or parsed. A body
	 * modestly over the bound is still drained (up to a hard cap) so the operator
	 * gets an honest 413 instead of a reset connection; anything past that cap is
	 * dropped on the floor.
	 */
	const readBody = (
		incoming: IncomingMessage,
		limit: number,
	): Promise<{ ok: true; text: string } | { ok: false }> => new Promise((resolveBody) => {
		const hardCap = limit * 8;
		const declared = Number(incoming.headers["content-length"] ?? "");
		let done = false;
		const finish = (result: { ok: true; text: string } | { ok: false }): void => {
			if (done) return;
			done = true;
			resolveBody(result);
		};
		if (Number.isFinite(declared) && declared > hardCap) {
			incoming.destroy();
			finish({ ok: false });
			return;
		}
		const chunks: Buffer[] = [];
		let bytes = 0;
		let overflow = false;
		incoming.on("data", (chunk: Buffer) => {
			bytes += chunk.byteLength;
			if (bytes > limit) {
				overflow = true;
				chunks.length = 0;
				if (bytes > hardCap) {
					incoming.destroy();
					finish({ ok: false });
				}
				return;
			}
			chunks.push(Buffer.from(chunk));
		});
		incoming.on("end", () => finish(
			overflow ? { ok: false } : { ok: true, text: Buffer.concat(chunks).toString("utf8") },
		));
		incoming.on("error", () => finish({ ok: false }));
		incoming.on("aborted", () => finish({ ok: false }));
	});

	const trustedHost = (incoming: IncomingMessage, address: AhdeServeAddress): boolean => {
		const host = incoming.headers.host?.toLowerCase();
		return host === `${LOOPBACK_HOST}:${address.port}` || host === `localhost:${address.port}`;
	};

	const trustedOrigin = (incoming: IncomingMessage, address: AhdeServeAddress): boolean => {
		if (incoming.headers["sec-fetch-site"] === "cross-site") return false;
		const origin = incoming.headers.origin;
		if (origin === undefined) return true;
		return origin === address.url || origin === `http://localhost:${address.port}`;
	};

	const authorized = (incoming: IncomingMessage): boolean => {
		const header = incoming.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(\S+)$/.exec(header.trim());
		if (!match) return false;
		const presented = createHash("sha256").update(match[1]!).digest();
		return timingSafeEqual(presented, tokenDigest);
	};

	const request = (incoming: IncomingMessage, response: ServerResponse): void => {
		void (async () => {
			const method = incoming.method ?? "GET";
			const address = listening;
			if (!address) {
				sendError(response, 503, "server is starting");
				return;
			}
			if (!trustedHost(incoming, address)) {
				sendError(response, 421, "misdirected request");
				return;
			}
			if (!trustedOrigin(incoming, address)) {
				sendError(response, 403, "cross-origin request denied");
				return;
			}
			if (!authorized(incoming)) {
				securityHeaders(response);
				response.setHeader("WWW-Authenticate", "Bearer");
				sendError(response, 401, "a bearer token minted by this server is required");
				return;
			}

			let url: URL;
			try {
				url = new URL(incoming.url ?? "/", `http://${LOOPBACK_HOST}`);
			} catch {
				sendError(response, 400, "invalid URL");
				return;
			}
			const path = url.pathname;

			const answerId = path.startsWith("/v1/confirmations/") ? path.slice("/v1/confirmations/".length) : null;
			const routes: Readonly<Record<string, readonly string[]>> = {
				"/v1/health": ["GET"],
				"/v1/view": ["GET"],
				"/v1/submit": ["POST"],
				"/v1/decide": ["POST"],
				"/v1/confirmations": ["GET"],
				"/v1/events": ["GET"],
			};
			const allowed = answerId !== null ? ["POST"] : routes[path];
			if (!allowed) {
				sendError(response, 404, "no such route");
				return;
			}
			if (!allowed.includes(method)) {
				securityHeaders(response);
				response.setHeader("Allow", allowed.join(", "));
				sendError(response, 405, `method not allowed; use ${allowed.join(", ")}`);
				return;
			}

			if (path === "/v1/events") {
				streamEvents(incoming, response);
				return;
			}
			if (path === "/v1/health") {
				const envelope = await handleHealth();
				sendJson(response, envelope.status, envelope.body);
				return;
			}
			if (path === "/v1/view") {
				const envelope = await handleView(url);
				sendJson(response, envelope.status, envelope.body);
				return;
			}
			if (path === "/v1/confirmations" && method === "GET") {
				const envelope = handleConfirmationList();
				sendJson(response, envelope.status, envelope.body);
				return;
			}

			const limit = path === "/v1/submit" ? SERVE_MAX_SUBMIT_BODY_BYTES : SERVE_MAX_DECISION_BODY_BYTES;
			const raw = await readBody(incoming, limit);
			if (!raw.ok) {
				sendError(response, 413, `request body exceeds the ${limit}-byte bound`);
				return;
			}
			let parsed: unknown;
			try {
				parsed = raw.text.trim() === "" ? {} : JSON.parse(raw.text);
			} catch {
				sendError(response, 400, "request body must be JSON");
				return;
			}

			if (answerId !== null) {
				if (!isServeConfirmationId(answerId)) {
					sendError(response, 404, "no such pending confirmation");
					return;
				}
				const envelope = await handleConfirmationAnswer(answerId, parsed);
				sendJson(response, envelope.status, envelope.body);
				return;
			}

			// Authority is host-side. A decision or submission that even mentions an
			// actor, an approval, or a confirmation is refused rather than sanitized.
			const authority = findAuthorityField(parsed);
			if (authority) {
				sendError(
					response,
					400,
					`host-owned authority is never accepted from a client: remove ${authority}`,
				);
				return;
			}
			const envelope = path === "/v1/submit" ? await handleSubmit(parsed) : await handleDecide(parsed);
			sendJson(response, envelope.status, envelope.body);
		})().catch((error: unknown) => {
			void error;
			if (response.headersSent || response.writableEnded) {
				if (!response.writableEnded) response.destroy();
				return;
			}
			sendError(response, 500, "serve API request failed");
		});
	};

	return {
		token,
		projectId,
		actorId,
		async listen(port = 0): Promise<AhdeServeAddress> {
			if (listening) return listening;
			if (!listenPromise) {
				const candidate = createServer(request);
				// A decision may hold its response open for a whole evaluation; only
				// the time to *receive* a request is bounded.
				candidate.headersTimeout = 60_000;
				candidate.requestTimeout = 300_000;
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
						const bound = candidate.address();
						if (!bound || typeof bound === "string") throw new Error("ahde serve did not bind a TCP port");
						const resolved: AhdeServeAddress = {
							host: LOOPBACK_HOST,
							port: bound.port,
							url: `http://${LOOPBACK_HOST}:${bound.port}`,
						};
						if (!options.allowConcurrent) {
							lock = acquireServeSessionLock({
								stateRoot: options.stateRoot,
								projectId,
								host: LOOPBACK_HOST,
								port: resolved.port,
								...(options.now ? { now: options.now } : {}),
							});
						}
						if (tokenFile) {
							writeTokenFile(tokenFile, token);
							tokenFileWritten = true;
						}
						server = candidate;
						listening = resolved;
						return resolved;
					} catch (error) {
						lock?.release();
						lock = null;
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
		address: () => listening,
		async close(): Promise<void> {
			const pendingListen = listenPromise;
			if (pendingListen) {
				try {
					await pendingListen;
				} catch {
					// A server that never listened has nothing to close.
				}
			}
			const active = server;
			server = null;
			listening = null;
			listenPromise = null;
			// Shutting down refuses every pending confirmation; it approves none.
			registry.close();
			events.close();
			for (const response of sseResponses) response.end();
			sseResponses.clear();
			lock?.release();
			lock = null;
			// Only ever remove a token file this server created.
			if (tokenFile && tokenFileWritten) {
				tokenFileWritten = false;
				rmSync(tokenFile, { force: true });
			}
			if (!active?.listening) return;
			await new Promise<void>((resolveClose, rejectClose) => {
				active.close((error) => {
					if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
						resolveClose();
						return;
					}
					rejectClose(error);
				});
			});
		},
	};
}
