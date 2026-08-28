import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEvidenceExplorer, type EvidenceExplorer } from "../src/evidence/server.js";
import type { RunEvent } from "../src/run-events.js";

const roots: string[] = [];
const explorers: EvidenceExplorer[] = [];

const liveEvent: RunEvent = {
	type: "assistant_delta",
	at: "2026-08-28T12:00:00.000Z",
	run: {
		evalRunId: "erun_live_web",
		runId: "run_live_web",
		taskId: "task-live-web",
		repetitionIndex: 0,
		ordinal: 1,
		total: 1,
	},
	delta: "LIVE_WEB_CANARY </script><script>never()</script>",
	truncated: false,
};

function requestStatus(options: {
	port: number;
	path: string;
	hostHeader: string;
}): Promise<number> {
	return new Promise((resolveStatus, reject) => {
		const request = httpRequest({
			host: "127.0.0.1",
			port: options.port,
			path: options.path,
			headers: { Host: options.hostHeader },
		}, (response) => {
			response.resume();
			response.once("end", () => resolveStatus(response.statusCode ?? 0));
		});
		request.once("error", reject);
		request.end();
	});
}

afterEach(async () => {
	for (const explorer of explorers.splice(0)) await explorer.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("read-only evidence explorer", () => {
	it("binds only to loopback and serves a safe empty index", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-evidence-"));
		roots.push(runsRoot);
		const explorer = createEvidenceExplorer({ runsRoot });
		explorers.push(explorer);
		const [address, concurrentAddress] = await Promise.all([
			explorer.listen(),
			explorer.listen(),
		]);

		expect(address.host).toBe("127.0.0.1");
		expect(address.url).toBe(`http://127.0.0.1:${address.port}`);
		expect(concurrentAddress).toEqual(address);
		const health = await fetch(`${address.url}/healthz`);
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ ok: true });

		const index = await fetch(address.url);
		expect(index.status).toBe(200);
		const html = await index.text();
		expect(html).toContain("AHDE Evidence");
		expect(html).toContain("Sealed holdout traces are never exposed");
		expect(index.headers.get("content-security-policy")).toContain("default-src 'none'");
	});

	it("rejects mutation methods and unsafe or missing artifact paths", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-evidence-"));
		roots.push(runsRoot);
		const explorer = createEvidenceExplorer({ runsRoot });
		explorers.push(explorer);
		const address = await explorer.listen();

		const mutation = await fetch(address.url, { method: "POST", body: "mutate" });
		expect(mutation.status).toBe(405);
		expect(mutation.headers.get("allow")).toBe("GET, HEAD");

		const traversal = await fetch(`${address.url}/evals/%2e%2e%2fsecret`);
		expect(traversal.status).toBe(404);
		const missing = await fetch(`${address.url}/evals/erun_missing`);
		expect(missing.status).toBe(404);
	});

	it("streams one capability-scoped live view and retains it after completion", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-evidence-"));
		roots.push(runsRoot);
		const explorer = createEvidenceExplorer({ runsRoot });
		explorers.push(explorer);
		const address = await explorer.listen();
		const live = explorer.startLiveTrace();
		const liveUrl = address.urlForLiveTrace(live.id);

		const index = await fetch(address.url);
		expect(await index.text()).not.toContain(live.id);
		const page = await fetch(liveUrl);
		expect(page.status).toBe(200);
		const html = await page.text();
		expect(html).toContain("AHDE Live Trace");
		expect(html).toContain("textContent");
		expect(html).toContain("Provisional eval");
		expect(html).toContain("MAX_RENDERED_EVENTS=300");
		expect(html).not.toContain("innerHTML");
		expect(html).not.toContain("Verified report ·");
		expect(html).not.toContain("LIVE_WEB_CANARY");
		const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
		expect(script).toBeDefined();
		expect(() => Function(script!)).not.toThrow();
		expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
		expect(page.headers.get("cross-origin-resource-policy")).toBe("same-origin");

		const eventsUrl = `${address.url}/api/live/${live.id}/events`;
		const head = await fetch(eventsUrl, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
		const stream = await fetch(eventsUrl);
		expect(stream.status).toBe(200);
		expect(stream.headers.get("content-type")).toContain("text/event-stream");
		live.onRunEvent(liveEvent);
		live.finish("completed");
		const body = await stream.text();
		expect(body).toContain("event: run");
		expect(body).toContain("LIVE_WEB_CANARY");
		expect(body).toContain("event: session");
		expect(body).toContain('"status":"completed"');

		const retained = await fetch(liveUrl);
		expect(retained.status).toBe(200);
		const replay = await fetch(`${address.url}/api/live/${live.id}/events`);
		expect(await replay.text()).toContain("LIVE_WEB_CANARY");
	});

	it("drains a retained replay larger than the HTTP response high-water mark", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-evidence-"));
		roots.push(runsRoot);
		const explorer = createEvidenceExplorer({ runsRoot });
		explorers.push(explorer);
		const address = await explorer.listen();
		const live = explorer.startLiveTrace();
		for (let index = 0; index < 40; index += 1) {
			live.onRunEvent({
				...liveEvent,
				delta: `${index}:${"x".repeat(4_096)}`,
			});
		}
		live.finish("completed");

		const replay = await fetch(`${address.url}/api/live/${live.id}/events`);
		expect(replay.status).toBe(200);
		const body = await replay.text();
		expect(body.match(/event: run/g)).toHaveLength(40);
		expect(body).toContain("event: session");
		expect(body).toContain('"status":"completed"');
	});

	it("rejects cross-origin, rebinding, mutation, and unknown live requests", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-evidence-"));
		roots.push(runsRoot);
		const explorer = createEvidenceExplorer({ runsRoot });
		explorers.push(explorer);
		const address = await explorer.listen();
		const live = explorer.startLiveTrace();
		const eventsUrl = `${address.url}/api/live/${live.id}/events`;

		expect((await fetch(eventsUrl, { method: "POST" })).status).toBe(405);
		expect((await fetch(eventsUrl, { headers: { Origin: "http://attacker.invalid" } })).status).toBe(403);
		expect(await requestStatus({
			port: address.port,
			path: `/live/${live.id}`,
			hostHeader: "attacker.invalid",
		})).toBe(421);
		expect((await fetch(`${address.url}/live/${"x".repeat(32)}`)).status).toBe(404);
		expect((await fetch(`${address.url}/api/live/not-a-capability/events`)).status).toBe(404);
	});

	it("closes promptly with an active SSE viewer", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-evidence-"));
		roots.push(runsRoot);
		const explorer = createEvidenceExplorer({ runsRoot });
		explorers.push(explorer);
		const address = await explorer.listen();
		const live = explorer.startLiveTrace();
		const stream = await fetch(`${address.url}/api/live/${live.id}/events`);
		expect(stream.status).toBe(200);

		await expect(Promise.race([
			explorer.close().then(() => "closed"),
			new Promise<string>((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 2_000)),
		])).resolves.toBe("closed");
		expect(await stream.text()).toContain("connected");
	});

	it("fails cleanly on a busy port and can listen after the port is released", async () => {
		const blocker = createServer((_request, response) => response.end("busy"));
		await new Promise<void>((resolveListen, rejectListen) => {
			blocker.once("error", rejectListen);
			blocker.listen(0, "127.0.0.1", resolveListen);
		});
		const bound = blocker.address();
		if (!bound || typeof bound === "string") throw new Error("test blocker did not bind");

		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-evidence-"));
		roots.push(runsRoot);
		const explorer = createEvidenceExplorer({ runsRoot });
		explorers.push(explorer);
		await expect(explorer.listen(bound.port)).rejects.toMatchObject({ code: "EADDRINUSE" });
		await expect(explorer.close()).resolves.toBeUndefined();
		await new Promise<void>((resolveClose, rejectClose) => {
			blocker.close((error) => error ? rejectClose(error) : resolveClose());
		});

		const address = await explorer.listen(bound.port);
		expect(address.port).toBe(bound.port);
		expect((await fetch(`${address.url}/healthz`)).status).toBe(200);
	});
});
