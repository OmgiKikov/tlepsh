import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEvidenceExplorer, type EvidenceExplorer } from "../src/evidence/server.js";

const roots: string[] = [];
const explorers: EvidenceExplorer[] = [];

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
		const address = await explorer.listen();

		expect(address.host).toBe("127.0.0.1");
		expect(address.url).toBe(`http://127.0.0.1:${address.port}`);
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
});
