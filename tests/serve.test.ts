import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPolicyAwareGate } from "../src/builder/workbench-adapter.js";
import { createCorpus } from "../src/corpus.js";
import { loadTarget } from "../src/manifest.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import { hashValue } from "../src/provenance.js";
import { createServeConfirmationRegistry } from "../src/serve/confirmations.js";
import { createAhdeServeApi, findAuthorityField, type AhdeServeApi } from "../src/serve/server.js";
import { acquireServeSessionLock, ServeSessionConflictError } from "../src/serve/session-lock.js";
import {
	createAhdeWorkbench,
	type AhdeWorkbench,
	type AhdeWorkbenchDependencies,
	type WorkbenchHumanGate,
} from "../src/workbench/index.js";
import { recordBuilderAuthoredProposal } from "../src/application/builder-authoring.js";
import { createHostContext } from "./helpers/builder-tools.js";
import {
	NOW,
	PROJECT_ID,
	spec,
	targetPaths,
	task,
	writeDevelopmentEval,
	type FixturePaths,
} from "./helpers/cycle-fixtures.js";
import { SEALED_VERIFICATION_REPETITIONS, sealedHoldoutTasks } from "./helpers/sealed-holdout.js";
import { cleanup } from "./fixtures.js";

/**
 * `ahde serve`: the Workbench behind a loopback HTTP/JSON API whose human gate
 * is the platform's. Every test here exists to prove one thing — the transport
 * moved, the trust model did not.
 */

const ACTOR = "local:test-human";
const ZERO_HASH = `sha256:${"0".repeat(64)}`;

// ---------------------------------------------------------------------------
// A raw HTTP client. `fetch` cannot forge a Host header, and these tests must.

interface RawResponse {
	status: number;
	headers: IncomingHttpHeaders;
	body: string;
}

interface CallOptions {
	method?: string;
	token?: string | null;
	body?: unknown;
	rawBody?: string;
	headers?: Record<string, string>;
}

function call(url: string, path: string, options: CallOptions = {}): Promise<RawResponse> {
	const target = new URL(path, url);
	const method = options.method ?? "GET";
	const payload = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
	const headers: Record<string, string> = { ...options.headers };
	if (options.token !== null) headers.authorization = `Bearer ${options.token ?? ""}`;
	if (payload !== undefined) {
		headers["content-type"] = "application/json";
		headers["content-length"] = String(Buffer.byteLength(payload));
	}
	return new Promise((resolveCall, rejectCall) => {
		const outgoing = httpRequest(
			{
				host: target.hostname,
				port: target.port,
				path: `${target.pathname}${target.search}`,
				method,
				headers,
			},
			(incoming) => {
				const chunks: Buffer[] = [];
				incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
				incoming.on("end", () => resolveCall({
					status: incoming.statusCode ?? 0,
					headers: incoming.headers,
					body: Buffer.concat(chunks).toString("utf8"),
				}));
			},
		);
		outgoing.on("error", rejectCall);
		if (payload !== undefined) outgoing.write(payload);
		outgoing.end();
	});
}

function json(response: RawResponse): Record<string, any> {
	return JSON.parse(response.body) as Record<string, any>;
}

interface EventStream {
	text(): string;
	waitFor(needle: string, timeoutMs?: number): Promise<void>;
	close(): void;
}

function openEventStream(url: string, token: string): Promise<EventStream> {
	const target = new URL("/v1/events", url);
	return new Promise((resolveStream, rejectStream) => {
		let received = "";
		const outgoing = httpRequest(
			{
				host: target.hostname,
				port: target.port,
				path: target.pathname,
				method: "GET",
				headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
			},
			(incoming) => {
				incoming.setEncoding("utf8");
				incoming.on("data", (chunk: string) => { received += chunk; });
				incoming.on("error", () => undefined);
				resolveStream({
					text: () => received,
					// Iteration-counted, not clock-counted: some tests freeze Date.
					async waitFor(needle, timeoutMs = 5_000) {
						for (let waited = 0; waited < timeoutMs; waited += 10) {
							if (received.includes(needle)) return;
							await new Promise((tick) => setTimeout(tick, 10));
						}
						if (!received.includes(needle)) {
							throw new Error(`event stream never carried ${needle}; saw:\n${received}`);
						}
					},
					close() {
						incoming.destroy();
						outgoing.destroy();
					},
				});
			},
		);
		outgoing.on("error", rejectStream);
		outgoing.end();
	});
}

// ---------------------------------------------------------------------------
// Fixtures.

const openServers: AhdeServeApi[] = [];
const openRoots: string[] = [];

async function closeServers(): Promise<void> {
	while (openServers.length > 0) await openServers.pop()!.close();
}

afterEach(async () => {
	await closeServers();
	while (openRoots.length > 0) cleanup(openRoots.pop()!);
});

interface StartedServer {
	api: AhdeServeApi;
	url: string;
	token: string;
	paths: FixturePaths;
	workbench: AhdeWorkbench;
}

/**
 * A real Workbench over a real Target fixture, served over loopback. Nothing is
 * stubbed on the gate side: the API's own confirmation registry is the gate.
 */
async function startServer(options: {
	paths?: FixturePaths;
	dependencies?: Partial<AhdeWorkbenchDependencies>;
	confirmationTimeoutSeconds?: number;
	allowConcurrent?: boolean;
	tokenFile?: string;
} = {}): Promise<StartedServer> {
	const paths = options.paths ?? targetPaths();
	if (!options.paths) openRoots.push(paths.projectDir);
	const workbench = createAhdeWorkbench({
		...paths,
		projectId: PROJECT_ID,
		dependencies: { now: () => NOW, ...options.dependencies },
	});
	const api = createAhdeServeApi({
		...paths,
		projectId: PROJECT_ID,
		actorId: ACTOR,
		workbench,
		...(options.confirmationTimeoutSeconds === undefined
			? {}
			: { confirmationTimeoutSeconds: options.confirmationTimeoutSeconds }),
		...(options.allowConcurrent ? { allowConcurrent: true } : {}),
		...(options.tokenFile ? { tokenFile: options.tokenFile } : {}),
	});
	openServers.push(api);
	const address = await api.listen();
	return { api, url: address.url, token: api.token, paths, workbench };
}

/** Put one reviewable Spec draft in front of the gate. */
async function seedSpecDraft(started: StartedServer): Promise<void> {
	const saved = await call(started.url, "/v1/submit", {
		method: "POST",
		token: started.token,
		body: { kind: "spec-draft", spec: spec() },
	});
	expect(saved.status).toBe(200);
}

const APPROVE = { kind: "approve-spec", reason: "Approve the exact served Spec" } as const;

// ---------------------------------------------------------------------------

describe("serve transport", () => {
	it("binds loopback, answers health for the minted token, and never leaks it", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		try {
			const started = await startServer();
			expect(started.url).toBe(`http://127.0.0.1:${started.api.address()?.port}`);
			const health = await call(started.url, "/v1/health", { token: started.token });
			expect(health.status).toBe(200);
			expect(json(health)).toMatchObject({ ok: true, projectId: PROJECT_ID, pendingConfirmations: 0 });
			expect(health.headers["cache-control"]).toBe("no-store");
			expect(health.headers["access-control-allow-origin"]).toBeUndefined();
			expect(health.headers["x-content-type-options"]).toBe("nosniff");

			await seedSpecDraft(started);
			const view = await call(started.url, "/v1/view", { token: started.token });
			const responses = [health, view];
			for (const response of responses) {
				expect(response.body).not.toContain(started.token);
				expect(JSON.stringify(response.headers)).not.toContain(started.token);
			}
			// The server writes no log line at all; the CLI prints the token once.
			for (const [written] of stderr.mock.calls) {
				expect(String(written)).not.toContain(started.token);
			}
		} finally {
			stderr.mockRestore();
		}
	});

	it("refuses a missing token, a wrong token, a foreign Host, and a foreign Origin", async () => {
		const started = await startServer();
		const missing = await call(started.url, "/v1/health", { token: null });
		expect(missing.status).toBe(401);
		expect(missing.headers["www-authenticate"]).toBe("Bearer");

		const wrong = await call(started.url, "/v1/health", { token: "not-the-minted-token" });
		expect(wrong.status).toBe(401);

		const foreignHost = await call(started.url, "/v1/health", {
			token: started.token,
			headers: { host: "ahde.example.com" },
		});
		expect(foreignHost.status).toBe(421);

		const foreignOrigin = await call(started.url, "/v1/health", {
			token: started.token,
			headers: { origin: "https://evil.example" },
		});
		expect(foreignOrigin.status).toBe(403);

		const crossSite = await call(started.url, "/v1/health", {
			token: started.token,
			headers: { "sec-fetch-site": "cross-site" },
		});
		expect(crossSite.status).toBe(403);

		const sameOrigin = await call(started.url, "/v1/health", {
			token: started.token,
			headers: { origin: started.url },
		});
		expect(sameOrigin.status).toBe(200);
	});

	it("allows only the declared method on each route and refuses an unknown one", async () => {
		const started = await startServer();
		const wrongMethod = await call(started.url, "/v1/view", { method: "POST", token: started.token, body: {} });
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.allow).toBe("GET");

		const wrongOnDecide = await call(started.url, "/v1/decide", { method: "GET", token: started.token });
		expect(wrongOnDecide.status).toBe(405);
		expect(wrongOnDecide.headers.allow).toBe("POST");

		const deleteAttempt = await call(started.url, "/v1/confirmations", { method: "DELETE", token: started.token });
		expect(deleteAttempt.status).toBe(405);

		const unknown = await call(started.url, "/v1/promote", { token: started.token });
		expect(unknown.status).toBe(404);
	});

	it("bounds every request body", async () => {
		const started = await startServer();
		const huge = await call(started.url, "/v1/decide", {
			method: "POST",
			token: started.token,
			rawBody: JSON.stringify({ kind: "approve-spec", reason: "x".repeat(200_000) }),
		});
		expect(huge.status).toBe(413);
		expect(json(huge).error).toMatch(/exceeds the \d+-byte bound/);

		const notJson = await call(started.url, "/v1/decide", {
			method: "POST",
			token: started.token,
			rawBody: "{",
		});
		expect(notJson.status).toBe(400);

		const badQuery = await call(started.url, "/v1/view?aspect=everything", { token: started.token });
		expect(badQuery.status).toBe(400);
		expect(json(badQuery).error).toMatch(/invalid view query/);
		const badInclude = await call(started.url, "/v1/view?include=sealed", { token: started.token });
		expect(badInclude.status).toBe(400);
	});

	it("writes the token to --token-file with owner-only bytes and removes it on close", async () => {
		const root = mkdtempSync(join(tmpdir(), "ahde-serve-token-"));
		try {
			const tokenFile = join(root, "serve.token");
			const started = await startServer({ tokenFile });
			expect(readFileSync(tokenFile, "utf8").trim()).toBe(started.token);
			await started.api.close();
			openServers.length = 0;
			expect(() => readFileSync(tokenFile, "utf8")).toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("serve authority", () => {
	it("refuses a client-supplied actor, approval, or confirmation inside a decision", async () => {
		const started = await startServer();
		await seedSpecDraft(started);
		for (const forged of [
			{ ...APPROVE, actor: "local:someone-else" },
			{ ...APPROVE, actorId: "local:someone-else" },
			{ ...APPROVE, approved: true },
			{ ...APPROVE, confirmed: true },
			{ kind: "spec-draft", spec: { ...spec(), approved: true } },
		]) {
			const path = forged.kind === "spec-draft" ? "/v1/submit" : "/v1/decide";
			const refused = await call(started.url, path, { method: "POST", token: started.token, body: forged });
			expect(refused.status).toBe(400);
			expect(json(refused).error).toMatch(/host-owned authority is never accepted/);
		}
		// Nothing durable moved: the draft is still a draft awaiting review.
		const view = await call(started.url, "/v1/view", { token: started.token });
		expect(json(view).stage).toBe("spec-review");
		expect((await started.workbench.view()).counts.approvedSpecs).toBe(0);
		expect(await call(started.url, "/v1/confirmations", { token: started.token })
			.then((response) => json(response).confirmations)).toEqual([]);
	});

	it("finds a forged authority field at any depth", () => {
		expect(findAuthorityField({ kind: "x", nested: [{ deep: { approved: true } }] }))
			.toBe("nested.0.deep.approved");
		expect(findAuthorityField({ approvedSpecId: "spec-1", reason: "ok" })).toBeNull();
	});
});

describe("serve gate", () => {
	it("blocks a consequential decision until the exact subject hash is approved", async () => {
		const started = await startServer();
		await seedSpecDraft(started);

		const decided = await call(started.url, "/v1/decide", {
			method: "POST",
			token: started.token,
			body: APPROVE,
		});
		expect(decided.status).toBe(202);
		const pending = json(decided);
		expect(pending).toMatchObject({
			status: "awaiting-confirmation",
			kind: "approve-spec",
			title: "Approve exact Spec draft",
			policy: "consequential",
		});
		expect(pending.confirmationId).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(pending.subjectHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(hashValue(pending.subject)).toBe(pending.subjectHash);
		expect(pending.question).toContain("Approve exact Spec draft");
		// Nothing has happened yet: the operation is blocked, not performed.
		expect((await started.workbench.view()).counts.approvedSpecs).toBe(0);

		const listed = await call(started.url, "/v1/confirmations", { token: started.token });
		expect(json(listed).confirmations).toHaveLength(1);
		expect(json(listed).confirmations[0].confirmationId).toBe(pending.confirmationId);

		const answered = await call(started.url, `/v1/confirmations/${pending.confirmationId}`, {
			method: "POST",
			token: started.token,
			body: { approved: true, subjectHash: pending.subjectHash },
		});
		expect(answered.status).toBe(200);
		expect(json(answered)).toMatchObject({ kind: "approve-spec" });
		expect(json(answered).result.approvedSpecId).toBeTruthy();
		expect((await started.workbench.view()).counts.approvedSpecs).toBe(1);
		expect(json(await call(started.url, "/v1/confirmations", { token: started.token })).confirmations)
			.toEqual([]);
	});

	it("fails closed on a wrong subject hash and leaves durable state untouched", async () => {
		const started = await startServer();
		await seedSpecDraft(started);
		const pending = json(await call(started.url, "/v1/decide", {
			method: "POST",
			token: started.token,
			body: APPROVE,
		}));
		const mismatched = await call(started.url, `/v1/confirmations/${pending.confirmationId}`, {
			method: "POST",
			token: started.token,
			body: { approved: true, subjectHash: ZERO_HASH },
		});
		expect(mismatched.status).toBe(409);
		expect(json(mismatched).error).toMatch(/does not bind the exact subject/);
		expect((await started.workbench.view()).counts.approvedSpecs).toBe(0);
		// The refusal is terminal: the right hash cannot rescue the same id.
		const retried = await call(started.url, `/v1/confirmations/${pending.confirmationId}`, {
			method: "POST",
			token: started.token,
			body: { approved: true, subjectHash: pending.subjectHash },
		});
		expect(retried.status).toBe(409);
		expect(json(retried).error).toMatch(/already subject-changed/);
		expect((await started.workbench.view()).counts.approvedSpecs).toBe(0);
	});

	it("fails closed on an unknown id and on a replay of an answered one", async () => {
		const started = await startServer();
		await seedSpecDraft(started);
		const unknown = await call(started.url, `/v1/confirmations/${"a".repeat(32)}`, {
			method: "POST",
			token: started.token,
			body: { approved: true, subjectHash: ZERO_HASH },
		});
		expect(unknown.status).toBe(404);
		const malformed = await call(started.url, "/v1/confirmations/not-an-id", {
			method: "POST",
			token: started.token,
			body: { approved: true, subjectHash: ZERO_HASH },
		});
		expect(malformed.status).toBe(404);

		const pending = json(await call(started.url, "/v1/decide", {
			method: "POST",
			token: started.token,
			body: APPROVE,
		}));
		const answer = { approved: true, subjectHash: pending.subjectHash };
		const first = await call(started.url, `/v1/confirmations/${pending.confirmationId}`, {
			method: "POST",
			token: started.token,
			body: answer,
		});
		expect(first.status).toBe(200);
		const replay = await call(started.url, `/v1/confirmations/${pending.confirmationId}`, {
			method: "POST",
			token: started.token,
			body: answer,
		});
		expect(replay.status).toBe(409);
		expect(json(replay).error).toMatch(/already approved; a second answer is refused/);
		// The replay approved nothing a second time.
		expect((await started.workbench.view()).counts.approvedSpecs).toBe(1);
	});

	it("treats an expired confirmation as a refusal, never an approval", async () => {
		const started = await startServer({ confirmationTimeoutSeconds: 1 });
		await seedSpecDraft(started);
		const pending = json(await call(started.url, "/v1/decide", {
			method: "POST",
			token: started.token,
			body: APPROVE,
		}));
		expect(Date.parse(pending.expiresAt) - Date.parse(pending.openedAt)).toBe(1_000);
		await new Promise((tick) => setTimeout(tick, 1_400));
		expect(json(await call(started.url, "/v1/confirmations", { token: started.token })).confirmations)
			.toEqual([]);
		const late = await call(started.url, `/v1/confirmations/${pending.confirmationId}`, {
			method: "POST",
			token: started.token,
			body: { approved: true, subjectHash: pending.subjectHash },
		});
		expect(late.status).toBe(409);
		expect(json(late).error).toMatch(/already expired/);
		expect((await started.workbench.view()).counts.approvedSpecs).toBe(0);
	});

	it("returns the same refusal the TUI path produces when the operator declines", async () => {
		const served = await startServer();
		await seedSpecDraft(served);
		const pending = json(await call(served.url, "/v1/decide", {
			method: "POST",
			token: served.token,
			body: APPROVE,
		}));
		const declined = await call(served.url, `/v1/confirmations/${pending.confirmationId}`, {
			method: "POST",
			token: served.token,
			body: { approved: false, subjectHash: pending.subjectHash },
		});
		expect(declined.status).toBe(409);
		expect(json(declined)).toMatchObject({ status: "declined", kind: "approve-spec" });

		// The exact same decision through the production TUI gate, declined.
		const twin = targetPaths();
		openRoots.push(twin.projectDir);
		const local = createAhdeWorkbench({ ...twin, projectId: PROJECT_ID, dependencies: { now: () => NOW } });
		await local.submit({ kind: "spec-draft", spec: spec() });
		const host = createHostContext({ confirm: false });
		const tuiGate = createPolicyAwareGate(host.ctx, () => ACTOR, () => undefined);
		const tuiRefusal = await local.decide(APPROVE, tuiGate).catch((error: unknown) => error as Error);
		expect(json(declined).error).toBe((tuiRefusal as Error).message);
		expect((await served.workbench.view()).counts.approvedSpecs).toBe(0);
	});

	it("refuses a second decision while one is waiting on its confirmation", async () => {
		const started = await startServer();
		await seedSpecDraft(started);
		const pending = json(await call(started.url, "/v1/decide", {
			method: "POST",
			token: started.token,
			body: APPROVE,
		}));
		expect(pending.status).toBe("awaiting-confirmation");
		const second = await call(started.url, "/v1/decide", {
			method: "POST",
			token: started.token,
			body: { kind: "run-eval", repetitions: 1, reason: "Sneak a second decision in" },
		});
		expect(second.status).toBe(409);
		expect(json(second).error).toMatch(/another decision is already in flight/);
	});

	it("opens a pending selection when more than one sealed holdout could be measured", async () => {
		const opened: string[] = [];
		const registry = createServeConfirmationRegistry({
			actorId: ACTOR,
			onOpened: (confirmation) => opened.push(confirmation.confirmationId),
		});
		const operation = registry.beginOperation();
		const options = [
			{ label: "holdout A", taskCount: 15 },
			{ label: "holdout B", taskCount: 20 },
		];
		const choice = operation.gate.selectSealed({ title: "Choose the sealed holdout", options });
		await new Promise((tick) => setTimeout(tick, 0));
		const [confirmationId] = opened;
		const listed = registry.find(confirmationId!)!;
		expect(listed.kind).toBe("select-sealed");
		expect(listed.options).toEqual(options);
		expect(listed.subjectHash).toBe(hashValue({ title: "Choose the sealed holdout", options }));
		// An approval still has to name which holdout, and the index is bounded.
		expect(registry.answer(confirmationId!, { approved: true, subjectHash: listed.subjectHash }).outcome)
			.toBe("invalid");
		expect(registry.answer(confirmationId!, {
			approved: true,
			subjectHash: listed.subjectHash,
			selectedIndex: 7,
		}).outcome).toBe("invalid");
		expect(registry.answer(confirmationId!, {
			approved: true,
			subjectHash: listed.subjectHash,
			selectedIndex: 1,
		}).outcome).toBe("recorded");
		expect(await choice).toEqual({ approved: true, actorId: ACTOR, selectedIndex: 1 });
		// A single holdout needs no picker, exactly as in the TUI.
		const solo = registry.beginOperation();
		expect(await solo.gate.selectSealed({ title: "one", options: [options[0]!] }))
			.toEqual({ approved: true, actorId: ACTOR, selectedIndex: 0 });
	});

	it("shuts down into a refusal rather than an approval", async () => {
		const started = await startServer();
		await seedSpecDraft(started);
		const pending = json(await call(started.url, "/v1/decide", {
			method: "POST",
			token: started.token,
			body: APPROVE,
		}));
		expect(pending.status).toBe("awaiting-confirmation");
		await started.api.close();
		openServers.length = 0;
		expect((await started.workbench.view()).counts.approvedSpecs).toBe(0);
	});
});

describe("serve routine work", () => {
	/** Publish a basket so `run-eval` is the legal next decision. */
	async function readyToEvaluate(started: StartedServer): Promise<void> {
		await seedSpecDraft(started);
		const approval = json(await call(started.url, "/v1/decide", {
			method: "POST",
			token: started.token,
			body: APPROVE,
		}));
		await call(started.url, `/v1/confirmations/${approval.confirmationId}`, {
			method: "POST",
			token: started.token,
			body: { approved: true, subjectHash: approval.subjectHash },
		});
		const draft = await call(started.url, "/v1/submit", {
			method: "POST",
			token: started.token,
			body: {
				kind: "corpus-draft",
				name: "Served development basket",
				tasks: [task()],
				coverageNotes: ["Known refund policy"],
				revisionSummary: "Initial served basket",
			},
		});
		expect(draft.status).toBe(200);
		const publication = json(await call(started.url, "/v1/decide", {
			method: "POST",
			token: started.token,
			body: { kind: "publish-corpus", reason: "Publish the exact served basket" },
		}));
		expect(publication.kind).toBe("publish-corpus");
		const published = await call(started.url, `/v1/confirmations/${publication.confirmationId}`, {
			method: "POST",
			token: started.token,
			body: { approved: true, subjectHash: publication.subjectHash },
		});
		expect(published.status).toBe(200);
	}

	it("escalates an unknown-cost routine run and runs the next one with no question", async () => {
		let evalRuns = 0;
		let corpusId = "";
		const paths = targetPaths();
		openRoots.push(paths.projectDir);
		const started = await startServer({
			paths,
			dependencies: {
				runSuite: async (_target, options) => {
					evalRuns += 1;
					options.onRunEvent?.({
						type: "run_started",
						at: NOW,
						run: {
							evalRunId: `erun_serve_${evalRuns}`,
							runId: `run_serve_${evalRuns}`,
							taskId: "task-served",
							repetitionIndex: 0,
							ordinal: 1,
							total: 1,
						},
					});
					return writeDevelopmentEval(paths, corpusId, `erun_serve_${evalRuns}`);
				},
			},
		});
		await readyToEvaluate(started);
		expect((await started.workbench.view()).counts.developmentCorpora).toBe(1);
		corpusId = (await started.workbench.view()).focus["development-corpus"]!;

		// Nothing comparable has finished, so the cost guard turns the routine run
		// into one question — a pending confirmation like any other.
		const guarded = json(await call(started.url, "/v1/decide", {
			method: "POST",
			token: started.token,
			body: { kind: "run-eval", repetitions: 1, reason: "Measure the served basket" },
		}));
		expect(guarded).toMatchObject({ status: "awaiting-confirmation", kind: "run-eval", policy: "one-question" });
		expect(guarded.question).toMatch(/cannot be priced up front/);
		expect(guarded.estimate).toMatchObject({ sampledRuns: 0 });
		expect(evalRuns).toBe(0);
		const ran = await call(started.url, `/v1/confirmations/${guarded.confirmationId}`, {
			method: "POST",
			token: started.token,
			body: { approved: true, subjectHash: guarded.subjectHash },
		});
		expect(ran.status).toBe(200);
		expect(evalRuns).toBe(1);

		// A comparable run has now finished and it was cheap: no question at all.
		const routine = await call(started.url, "/v1/decide", {
			method: "POST",
			token: started.token,
			body: { kind: "run-eval", repetitions: 1, reason: "Measure it again" },
		});
		expect(routine.status).toBe(200);
		expect(json(routine).kind).toBe("run-eval");
		expect(evalRuns).toBe(2);
		expect(json(await call(started.url, "/v1/confirmations", { token: started.token })).confirmations)
			.toEqual([]);
	});

	it("streams bounded progress and never a credential or sealed content", async () => {
		const SEALED_CANARY = "PRIVATE_SEALED_HOLDOUT_TEXT";
		let evalRuns = 0;
		let corpusId = "";
		const paths = targetPaths();
		openRoots.push(paths.projectDir);
		const started = await startServer({
			paths,
			dependencies: {
				runSuite: async (_target, options) => {
					evalRuns += 1;
					options.onRunEvent?.({
						type: "assistant_delta",
						at: NOW,
						run: {
							evalRunId: `erun_serve_stream_${evalRuns}`,
							runId: `run_serve_stream_${evalRuns}`,
							taskId: "task-served",
							repetitionIndex: 0,
							ordinal: 1,
							total: 1,
						},
						delta: "SERVE_PROGRESS_CANARY",
						truncated: false,
					});
					return writeDevelopmentEval(paths, corpusId, `erun_serve_stream_${evalRuns}`);
				},
			},
		});
		const stream = await openEventStream(started.url, started.token);
		try {
			await readyToEvaluate(started);
			corpusId = (await started.workbench.view()).focus["development-corpus"]!;
			const guarded = json(await call(started.url, "/v1/decide", {
				method: "POST",
				token: started.token,
				body: { kind: "run-eval", repetitions: 1, reason: "Measure with a viewer attached" },
			}));
			await stream.waitFor("confirmation-opened");
			await call(started.url, `/v1/confirmations/${guarded.confirmationId}`, {
				method: "POST",
				token: started.token,
				body: { approved: true, subjectHash: guarded.subjectHash },
			});
			await stream.waitFor("SERVE_PROGRESS_CANARY");
			await stream.waitFor("workbench-changed");
			const text = stream.text();
			expect(text).toContain("event: confirmation-closed");
			expect(text).toContain("event: run-progress");
			expect(text).toContain("event: operation-settled");
			expect(text).not.toContain(started.token);
			expect(text).not.toContain(SEALED_CANARY);
		} finally {
			stream.close();
		}
	});
});

describe("serve sessions", () => {
	it("refuses a second server on one project unless the operator allows it", async () => {
		const paths = targetPaths();
		openRoots.push(paths.projectDir);
		const first = await startServer({ paths });
		const second = createAhdeServeApi({ ...paths, projectId: PROJECT_ID, actorId: ACTOR });
		openServers.push(second);
		await expect(second.listen()).rejects.toThrow(/already holds this project/);
		expect(second.address()).toBeNull();

		const concurrent = createAhdeServeApi({
			...paths,
			projectId: PROJECT_ID,
			actorId: ACTOR,
			allowConcurrent: true,
		});
		openServers.push(concurrent);
		const address = await concurrent.listen();
		expect(address.host).toBe("127.0.0.1");
		expect(address.port).not.toBe(first.api.address()?.port);
	});

	it("takes over a lock whose process is gone and refuses one that is alive", () => {
		const paths = targetPaths();
		openRoots.push(paths.projectDir);
		const held = acquireServeSessionLock({
			stateRoot: paths.stateRoot,
			projectId: PROJECT_ID,
			host: "127.0.0.1",
			port: 1,
		});
		expect(() => acquireServeSessionLock({
			stateRoot: paths.stateRoot,
			projectId: PROJECT_ID,
			host: "127.0.0.1",
			port: 2,
		})).toThrow(ServeSessionConflictError);
		// A lock left by a process that no longer exists is stale, not fatal.
		writeFileSync(held.path, JSON.stringify({ pid: 2 ** 22, startedAt: NOW, host: "127.0.0.1", port: 1 }));
		const takenOver = acquireServeSessionLock({
			stateRoot: paths.stateRoot,
			projectId: PROJECT_ID,
			host: "127.0.0.1",
			port: 3,
		});
		takenOver.release();
		held.release();
	});

	it("refuses to bind anything but loopback", () => {
		const paths = targetPaths();
		openRoots.push(paths.projectDir);
		expect(() => createAhdeServeApi({ ...paths, projectId: PROJECT_ID, host: "0.0.0.0" }))
			.toThrow(/binds loopback only/);
	});
});

// ---------------------------------------------------------------------------
// One complete cycle over HTTP against a scripted model, plus the proof that
// the transport changed nothing that reaches disk.

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OLD_INSTRUCTIONS = "# Serve agent\n\nReturn the word pending.\n";
const NEW_INSTRUCTIONS = "# Serve agent\n\nReturn the exact uppercase word READY.\n";
const CYCLE_PROJECT = "serve-cycle";
const CYCLE_SPEC = {
	schemaVersion: 1 as const,
	title: "Served answer agent",
	purpose: "Return a deterministic reviewed answer.",
	users: ["platform operator"],
	jobs: ["answer the request"],
	inputs: ["one text request"],
	allowedActions: ["return text"],
	successCriteria: ["answer contains READY"],
	constraints: ["no network"],
	openQuestions: [],
};
const CYCLE_TASKS = [
	{ input: "Answer served case one.", graders: [{ type: "output_contains" as const, text: "READY" }] },
	{ input: "Answer served case two.", graders: [{ type: "output_contains" as const, text: "READY" }] },
];

interface CycleRoot {
	root: string;
	projectDir: string;
	stateRoot: string;
	runsRoot: string;
}

function cycleRootPaths(root: string): CycleRoot {
	return {
		root,
		projectDir: join(root, "target"),
		stateRoot: join(root, "state"),
		runsRoot: join(root, "runs"),
	};
}

/**
 * The same dependency wiring for both drivers, so only the gate differs. The
 * clock stays the ambient one — frozen by the test around the two phases whose
 * receipts are compared, real while a candidate's events are being appended.
 * The proposal run id is the one host-minted value in these receipts that is
 * neither content-derived nor time-derived, so it is pinned here.
 */
function cycleDependencies(): Partial<AhdeWorkbenchDependencies> {
	return {
		recordProposal: (input) => recordBuilderAuthoredProposal({ ...input, runId: "builder-serve-cycle" }),
	};
}

let cycleMock: MockModelHandle;
let cycleBase: string;

function gitIn(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

describe("serve full cycle", () => {
	beforeAll(async () => {
		cycleMock = await startMockModel([
			{
				match: ({ system }) => system.includes("Return the exact uppercase word READY."),
				steps: [{ text: "READY" }],
			},
			{ match: () => true, steps: [{ text: "pending" }] },
		]);
		process.env.AHDE_SERVE_CYCLE_KEY = "fixture";
		cycleBase = mkdtempSync(join(tmpdir(), "ahde-serve-cycle-"));
		const paths = cycleRootPaths(cycleBase);
		cpSync(join(REPO_ROOT, "templates", "basic-agent"), paths.projectDir, { recursive: true });
		writeFileSync(join(paths.projectDir, "AGENTS.md"), OLD_INSTRUCTIONS);
		const manifestPath = join(paths.projectDir, "manifest.yaml");
		writeFileSync(
			manifestPath,
			readFileSync(manifestPath, "utf8")
				.replace("id: my-agent", `id: ${CYCLE_PROJECT}`)
				.replace("id: replace-with-model-id", "id: serve-cycle-model")
				.replace("baseUrl: http://127.0.0.1:1234/v1", `baseUrl: ${cycleMock.url}`)
				.replace("apiKeyEnv: AHDE_MODEL_API_KEY", "apiKeyEnv: AHDE_SERVE_CYCLE_KEY")
				.replace("timeoutMs: 300000", "timeoutMs: 30000"),
		);
		gitIn(paths.projectDir, "init", "-b", "main");
		gitIn(paths.projectDir, "config", "user.name", "AHDE serve fixture");
		gitIn(paths.projectDir, "config", "user.email", "serve@ahde.local");
		gitIn(paths.projectDir, "add", ".");
		gitIn(paths.projectDir, "commit", "-q", "-m", "baseline");
	});

	afterAll(async () => {
		vi.useRealTimers();
		delete process.env.AHDE_SERVE_CYCLE_KEY;
		await cycleMock.close();
		rmSync(cycleBase, { recursive: true, force: true });
	});

	it("drives spec → tests → run → propose → apply → verify → ship over HTTP and writes the TUI's receipts", async () => {
		const forks: string[] = [];
		const fork = (label: string): CycleRoot => {
			const root = mkdtempSync(join(tmpdir(), `ahde-serve-${label}-`));
			forks.push(root);
			rmSync(root, { recursive: true, force: true });
			cpSync(cycleBase, root, { recursive: true });
			return cycleRootPaths(root);
		};
		const forkOf = (source: CycleRoot, label: string): CycleRoot => {
			const root = mkdtempSync(join(tmpdir(), `ahde-serve-${label}-`));
			forks.push(root);
			rmSync(root, { recursive: true, force: true });
			cpSync(source.root, root, { recursive: true });
			return cycleRootPaths(root);
		};

		// Corpus metadata and Builder run records stamp themselves from the wall
		// clock. Freezing Date (never the timers) around the two phases whose
		// receipts are compared is what makes a byte comparison meaningful; the
		// long measured phases keep a real clock, and run ids stay unique because
		// they also draw on Math.random.
		const freeze = (): void => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(Date.parse(NOW));
		};
		const thaw = (): void => { vi.useRealTimers(); };

		const served = fork("api");
		const twin = fork("tui");
		const api = createAhdeServeApi({
			projectDir: served.projectDir,
			stateRoot: served.stateRoot,
			runsRoot: served.runsRoot,
			projectId: CYCLE_PROJECT,
			actorId: ACTOR,
			dependencies: cycleDependencies(),
		});
		openServers.push(api);
		const address = await api.listen();
		const url = address.url;
		const token = api.token;

		/** POST a decision and answer whatever confirmation it opens. */
		const decide = async (body: Record<string, unknown>): Promise<Record<string, any>> => {
			let response = await call(url, "/v1/decide", { method: "POST", token, body });
			for (let guard = 0; guard < 8; guard += 1) {
				if (response.status !== 202) break;
				const pending = json(response);
				expect(pending.status).toBe("awaiting-confirmation");
				expect(hashValue(pending.subject)).toBe(pending.subjectHash);
				response = await call(url, `/v1/confirmations/${pending.confirmationId}`, {
					method: "POST",
					token,
					body: { approved: true, subjectHash: pending.subjectHash },
				});
			}
			if (response.status !== 200) throw new Error(`decision failed: ${response.status} ${response.body}`);
			return json(response);
		};
		const submit = async (body: Record<string, unknown>): Promise<Record<string, any>> => {
			const response = await call(url, "/v1/submit", { method: "POST", token, body });
			if (response.status !== 200) throw new Error(`submission failed: ${response.status} ${response.body}`);
			return json(response);
		};

		/** The same operations through the production TUI gate, on a twin. */
		const tuiWorkbench = (paths: CycleRoot): { workbench: AhdeWorkbench; gate: WorkbenchHumanGate } => {
			const workbench = createAhdeWorkbench({
				projectDir: paths.projectDir,
				stateRoot: paths.stateRoot,
				runsRoot: paths.runsRoot,
				projectId: CYCLE_PROJECT,
				dependencies: cycleDependencies(),
			});
			const host = createHostContext({ confirm: true });
			return { workbench, gate: createPolicyAwareGate(host.ctx, () => ACTOR, () => undefined) };
		};

		try {
			// --- spec ------------------------------------------------------------
			freeze();
			await submit({ kind: "spec-draft", spec: CYCLE_SPEC });
			const approved = await decide({ kind: "approve-spec", reason: "Approve the served contract" });
			expect(approved.result.approvedSpecId).toBeTruthy();

			// --- tests -----------------------------------------------------------
			await submit({
				kind: "corpus-draft",
				name: "Served development basket",
				tasks: CYCLE_TASKS,
				coverageNotes: ["The reviewed answer contract"],
				revisionSummary: "Initial served basket",
			});
			const published = await decide({ kind: "publish-corpus", reason: "Publish the served basket" });
			expect(published.result.taskCount).toBe(2);

			// The same two decisions through the TUI gate on the pre-decision twin.
			const local = tuiWorkbench(twin);
			await local.workbench.submit({ kind: "spec-draft", spec: CYCLE_SPEC });
			await local.workbench.decide({ kind: "approve-spec", reason: "Approve the served contract" }, local.gate);
			await local.workbench.submit({
				kind: "corpus-draft",
				name: "Served development basket",
				tasks: CYCLE_TASKS,
				coverageNotes: ["The reviewed answer contract"],
				revisionSummary: "Initial served basket",
			});
			await local.workbench.decide({ kind: "publish-corpus", reason: "Publish the served basket" }, local.gate);

			const receiptRoot = (paths: CycleRoot, ...rest: string[]): string =>
				join(paths.stateRoot, "projects", CYCLE_PROJECT, ...rest);
			const specReceipts = (paths: CycleRoot): string[] =>
				execFileSync("find", [receiptRoot(paths), "-name", "*.json", "-type", "f"], { encoding: "utf8" })
					.split("\n")
					.filter(Boolean)
					.map((path) => path.slice(receiptRoot(paths).length))
					.sort();
			expect(specReceipts(served)).toEqual(specReceipts(twin));
			for (const relative of specReceipts(served)) {
				expect(readFileSync(join(receiptRoot(served), relative)))
					.toEqual(readFileSync(join(receiptRoot(twin), relative)));
			}

			// --- run (a real clock: this phase is measured, not compared) --------
			thaw();
			const measured = await decide({
				kind: "run-eval",
				repetitions: SEALED_VERIFICATION_REPETITIONS,
				reason: "Measure the served basket",
			});
			expect(measured.result.evaluation.summary).toMatchObject({ pass: 0, fail: 4 });
			const brief = measured.result.improvementBrief;
			const failureMode = brief.modes.find((mode: { decision: string }) =>
				mode.decision === "propose-harness-change");
			expect(failureMode).toBeTruthy();

			// --- propose (a post-measurement twin shares every minted run id) -----
			const proposalTwin = forkOf(served, "propose");
			freeze();
			const targetView = json(await call(url, "/v1/view?aspect=target", { token }));
			const authoringContext = targetView.detail.content.claim;
			expect(authoringContext).toBeTruthy();
			const proposalInput = {
				kind: "structured-proposal",
				authoringContext,
				source: {
					algorithmId: brief.algorithmId,
					evalRunId: brief.evalRunId,
					diagnosisId: brief.diagnosisId,
					briefId: brief.briefId,
				},
				failureModeIds: [failureMode.failureModeId],
				summary: "Make the answer contract explicit.",
				intents: [{ type: "instructions.replace", content: NEW_INSTRUCTIONS }],
				risks: ["The contract is intentionally narrow for this fixture."],
				validationPlan: ["Run the matched development and sealed corpora."],
			};
			const proposed = await submit(proposalInput);
			expect(proposed.artifact.runId).toBe("builder-serve-cycle");

			// --- apply -----------------------------------------------------------
			const applyInput = {
				kind: "apply-proposal" as const,
				branch: "candidate/serve-cycle",
				reason: "The proposal matches the diagnosed failure and allowed scope.",
			};
			const headBefore = gitIn(served.projectDir, "rev-parse", "HEAD");
			const applied = await decide(applyInput);
			expect(applied.result.candidateSha).not.toBe(headBefore);
			expect(gitIn(served.projectDir, "rev-parse", "HEAD")).toBe(headBefore);
			expect(gitIn(served.projectDir, "status", "--porcelain=v1", "-uall")).toBe("");

			// The identical author-and-apply pair through the production TUI gate.
			const twinAfterRun = tuiWorkbench(proposalTwin);
			await twinAfterRun.workbench.submit(proposalInput as never);
			await twinAfterRun.workbench.decide(applyInput, twinAfterRun.gate);

			const builderDir = (paths: CycleRoot): string =>
				join(paths.runsRoot, "builders", "builder-serve-cycle");
			for (const file of ["proposal.json", "builder_run.json", "apply_receipt.json", "builder_input.txt"]) {
				expect(readFileSync(join(builderDir(served), file)))
					.toEqual(readFileSync(join(builderDir(proposalTwin), file)));
			}
			expect(JSON.parse(readFileSync(join(builderDir(served), "apply_receipt.json"), "utf8")))
				.toMatchObject({ actor: { kind: "human", id: ACTOR }, appliedAt: NOW });

			// --- verify (a real clock again) --------------------------------------
			thaw();
			const sealed = createCorpus({
				stateRoot: served.stateRoot,
				projectId: CYCLE_PROJECT,
				name: "Evaluator-only served holdout",
				visibility: "sealed",
				tasks: sealedHoldoutTasks("PRIVATE_SERVE_HOLDOUT"),
			});
			expect(sealed.taskCount).toBeGreaterThanOrEqual(15);
			const stream = await openEventStream(url, token);
			let verified: Record<string, any>;
			try {
				verified = await decide({
					kind: "verify-candidate",
					repetitions: SEALED_VERIFICATION_REPETITIONS,
					force: true,
					reason: "Verify the applied candidate",
				});
				expect(stream.text()).not.toContain("PRIVATE_SERVE_HOLDOUT");
				expect(stream.text()).not.toContain(token);
			} finally {
				stream.close();
			}
			expect(verified.result.outcome).toBe("verified");
			expect(verified.result.development.verdict).toBe("improved");
			expect(verified.result.sealedHoldout).toMatchObject({ executed: true, gatePassed: true });

			// --- ship ------------------------------------------------------------
			const shipped = await decide({ kind: "ship", version: "1.0.0", reason: "Ship the verified candidate" });
			expect(shipped.result.tag).toBe("v1.0.0");
			expect(shipped.result.steps.map((step: { kind: string }) => step.kind))
				.toEqual(["review-candidate", "promote-candidate", "adopt-candidate", "continue-cycle"]);
			expect(gitIn(served.projectDir, "rev-list", "-n", "1", "v1.0.0")).toBe(applied.result.candidateSha);
			expect(gitIn(served.projectDir, "rev-parse", "HEAD")).toBe(applied.result.candidateSha);
			expect(gitIn(served.projectDir, "status", "--porcelain=v1", "-uall")).toBe("");
			expect(readFileSync(join(served.projectDir, "AGENTS.md"), "utf8")).toBe(NEW_INSTRUCTIONS);

			expect(shipped.result.continuation.receiptId).toBeTruthy();
			const finalView = json(await call(url, "/v1/view", { token }));
			// The cycle closed: the next stage is derived from artifacts alone.
			expect(finalView.stage).toBe(shipped.result.continuation.nextStage);
			expect(json(await call(url, "/v1/confirmations", { token })).confirmations).toEqual([]);
			expect(loadTarget(served.projectDir).gitSha).toBe(applied.result.candidateSha);
		} finally {
			thaw();
			await api.close();
			openServers.length = 0;
			for (const root of forks) rmSync(root, { recursive: true, force: true });
		}
	}, 180_000);
});
