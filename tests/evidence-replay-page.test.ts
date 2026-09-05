import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, t } from "../src/i18n.js";
import { h } from "../src/evidence/pages.js";
import { collectCandidateReplayPage, type CandidateReplayPageModel } from "../src/evidence/replay-model.js";
import { renderCandidateReplayPage } from "../src/evidence/replay-page.js";
import { createEvidenceExplorer, type EvidenceExplorer } from "../src/evidence/server.js";
import { SEALED_SENTINEL, writeExplorerFixture } from "./helpers/evidence-fixture.js";

const roots: string[] = [];
const servers: EvidenceExplorer[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	setLanguage("en");
});

function fixture() {
	setLanguage("en");
	const data = writeExplorerFixture();
	roots.push(data.runsRoot);
	return data;
}

async function serve() {
	const data = fixture();
	const server = createEvidenceExplorer({ runsRoot: data.runsRoot });
	servers.push(server);
	const address = await server.listen();
	return { ...data, url: `${address.url}/candidates/${data.candidateId}/replay` };
}

describe("replay HTTP boundary", () => {
	it("serves the exact selected pair with equivalent HEAD headers and no HEAD body", async () => {
		const data = await serve();
		const url = `${data.url}?run=run_base_1`;
		const get = await fetch(url);
		const html = await get.text();
		expect(get.status).toBe(200);
		expect(get.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(html).toContain('data-replay');
		expect(html).toContain("run_base_1");
		expect(html).toContain("run_cand_1");
		expect(html).toContain('aria-current="page"');
		for (const privateId of [SEALED_SENTINEL, data.sealedEvalRunId, data.sealedRunId]) expect(html).not.toContain(privateId);
		const head = await fetch(url, { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
		for (const header of ["content-type", "content-length", "content-security-policy", "cache-control"]) {
			expect(head.headers.get(header)).toBe(get.headers.get(header));
		}
		expect(Number(get.headers.get("content-length"))).toBe(Buffer.byteLength(html));
		const csp = get.headers.get("content-security-policy")!;
		for (const directive of ["default-src 'none'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) expect(csp).toContain(directive);
		expect(get.headers.get("cache-control")).toBe("no-store");
		expect(get.headers.get("x-content-type-options")).toBe("nosniff");
		expect(get.headers.get("referrer-policy")).toBe("no-referrer");
	});

	it.each(["?run=", "?run=run_base_0&run=run_base_1", "?run=run_base_0&run=run_base_0", "?run=run_cand_0", "?run=run_sealed_0", "?run=run_unknown"])("refuses empty, duplicate or non-baseline selector %s", async (query) => {
		const data = await serve();
		const response = await fetch(data.url + query);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("Not found\n");
		const head = await fetch(data.url + query, { method: "HEAD" });
		expect(head.status).toBe(404);
		expect(await head.text()).toBe("");
	});

	it.each(["../run_base_0", "run_base_0/secret", "\u0000", '<script>alert("x")</script>'])("refuses path-like/malicious selector without reflecting its value: %s", async (selector) => {
		const data = await serve();
		const response = await fetch(`${data.url}?run=${encodeURIComponent(selector)}`);
		expect(response.status).toBe(422);
		expect(await response.text()).toBe("Evidence report failed integrity or visibility checks.\n");
	});

	it("refuses writes and makes corrupt record failures generic while a corrupt trace remains explicitly unavailable", async () => {
		const data = await serve();
		const write = await fetch(data.url, { method: "POST", body: "not an action" });
		expect(write.status).toBe(405);
		expect(write.headers.get("allow")).toBe("GET, HEAD");
		writeFileSync(join(data.runsRoot, "run_base_0", "session.jsonl"), "PRIVATE_TAMPERED_TRACE");
		const trace = await fetch(`${data.url}?run=run_base_0`);
		expect(trace.status).toBe(200);
		const html = await trace.text();
		expect(html).toContain(h(t("evidence.replayTraceMissing")));
		expect(html).not.toContain("PRIVATE_TAMPERED_TRACE");
		writeFileSync(join(data.runsRoot, "run_base_0", "run.json"), "PRIVATE_CORRUPT_RECORD");
		const record = await fetch(data.url);
		expect(record.status).toBe(422);
		expect(await record.text()).toBe("Evidence report failed integrity or visibility checks.\n");
	});
});

describe("replay renderer", () => {
	it.each(["en", "ru"] as const)("keeps labelled controls and complete no-JavaScript evidence in %s", (language) => {
		const data = fixture();
		setLanguage(language);
		const model = collectCandidateReplayPage(data.runsRoot, data.candidateId, { runId: "run_base_0" });
		const html = renderCandidateReplayPage(model);
		expect(html).toContain(`<html lang="${language}">`);
		for (const attribute of ["data-play", "data-all"]) {
			const control = html.match(new RegExp(`<button\\b[^>]*\\b${attribute}[^>]*>[^<]+</button>`))?.[0];
			expect(control, attribute).toBeDefined();
			expect(control!.match(new RegExp(`\\b${attribute}(?=[\\s=>])`, "g"))).toHaveLength(1);
			expect(control).toMatch(new RegExp(`${attribute}="[^"]+"`));
		}
		// Progressive enhancement only hides actual transcript entries after the
		// controller starts. A blocked script must never hide the evidence.
		const entries = [...html.matchAll(/<article\b[^>]*data-step="\d+"[^>]*>/g)];
		expect(entries.length).toBe(model.selected.baseline.transcript!.entries.length + model.selected.candidate.transcript!.entries.length);
		for (const [entry] of entries) expect(entry).not.toContain("hidden");
		for (const run of [model.selected.baseline, model.selected.candidate]) {
			expect(html).toContain(`/runs/${run.runId}`);
			for (const entry of run.transcript!.entries) if (entry.kind === "user" || entry.kind === "assistant") expect(html).toContain(entry.text);
		}
	});

	it("escapes artifact text in trace, check, diff and attribute contexts without inserting it into the controller", () => {
		const data = fixture();
		const original = collectCandidateReplayPage(data.runsRoot, data.candidateId);
		const payload = '</script><img src=x onerror="alert(1)"><script>ATTACK</script>"&';
		const model: CandidateReplayPageModel = { ...original, targetId: payload, notices: [payload],
			proposal: { available: true, summary: payload, paths: [payload], diff: `+${payload}`, proposalHash: payload, redacted: false },
			navigation: { ...original.navigation, items: original.navigation.items.map((item) => ({ ...item, taskId: payload })) },
			selected: { ...original.selected, taskId: payload, baseline: { ...original.selected.baseline,
				graders: original.selected.baseline.graders.map((grader) => ({ ...grader, name: payload, reason: payload })),
				transcript: { ...original.selected.baseline.transcript!, entries: [{ kind: "user", text: payload, at: null }] },
			} },
		};
		const html = renderCandidateReplayPage(model);
		expect(html).not.toContain(payload);
		expect(html).toContain('&lt;/script&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
		expect(html.match(/<script>/g)).toHaveLength(1);
		expect(html.match(/<\/script>/g)).toHaveLength(1);
		expect(html.match(/<script>([\s\S]*?)<\/script>/)?.[1]).not.toContain("ATTACK");
		expect(html).not.toMatch(/<img\b/);
	});

	it("retains excluded/error status without portraying missing repetitions as improvement", () => {
		const data = fixture();
		const model = collectCandidateReplayPage(data.runsRoot, data.candidateId, { runId: "run_base_2" });
		expect(model.selected.exclusion).not.toBeNull();
		const html = renderCandidateReplayPage(model);
		expect(html).toContain('class="chip error"');
		const selectedCase = html.slice(html.indexOf('<div class="r-case">'), html.indexOf('<div class="r-controls'));
		expect(selectedCase).not.toContain("0% → 100%");
		expect(selectedCase).toContain(h(t("evidence.excludedNote")));
	});
});
