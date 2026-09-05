import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeExplorerFixture, SEALED_SENTINEL } from "./helpers/evidence-fixture.js";
import { collectEvalPage, EvidenceNotFound } from "../src/evidence/model.js";
import { renderEvalPage } from "../src/evidence/workspace-page.js";
import { createEvidenceExplorer, type EvidenceExplorer } from "../src/evidence/server.js";
import { setLanguage } from "../src/i18n.js";

const roots: string[] = [];
const servers: EvidenceExplorer[] = [];
function fixture() {
	const value = writeExplorerFixture();
	roots.push(value.runsRoot);
	return value;
}
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	setLanguage("en");
});

describe("evaluation workspace", () => {
	it("permits its same-origin GET search while other pages keep forms disabled", async () => {
		const f = fixture();
		const server = createEvidenceExplorer({ runsRoot: f.runsRoot }); servers.push(server);
		const address = await server.listen();
		const response = await fetch(`${address.url}/evals/${f.baselineEvalRunId}?q=task_001`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
		expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
		const html = await response.text();
		expect([...html.matchAll(/data-row /g)]).toHaveLength(1);
		expect(html).toContain('name="q" value="task_001"');
		for (const path of ["/", `/runs/${f.failingRunId}`, `/candidates/${f.candidateId}`, `/candidates/${f.candidateId}/replay`]) {
			const other = await fetch(`${address.url}${path}`);
			expect(other.headers.get("content-security-policy")).toContain("form-action 'none'");
		}
	});

	it("opens the exact selected development trace and retains filters in navigable links", () => {
		const f = fixture();
		const page = collectEvalPage(f.runsRoot, f.baselineEvalRunId, { query: { outcome: "fail", run: f.failingRunId } });
		expect(page.selectedRun?.run.runId).toBe(f.failingRunId);
		expect(page.selectedRun?.transcript?.entries).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "assistant", text: "Ответ без проверки." })]));
		const html = renderEvalPage(page);
		expect(html).toContain(`data-selected-run="${f.failingRunId}"`);
		expect(html).toContain(`outcome=fail&amp;run=${f.failingRunId}#inspector`);
		expect(html).toContain(`href="/runs/${f.failingRunId}"`);
		expect(html).toContain(`href="/candidates/${f.candidateId}/replay"`);
		expect(html).toContain('id="trace-step-0" tabindex="-1"');
		expect(html).toContain('href="#trace-step-0"');
		expect(html).toContain('method="get"');
		expect(html).toContain('name="outcome" value="fail"');
		expect(html).toContain('aria-current="true"');
		expect(html).toContain("repetition 1");
		expect(html).not.toContain("task_001 repetition 0 failed:");
		expect(html).toContain("never called");
		expect(html).not.toContain(SEALED_SENTINEL);
		expect(() => Function(html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "throw new Error('missing script')")).not.toThrow();
	});

	it("filters affected runs by the actual diagnosis and preserves a linked run outside filters explicitly", () => {
		const f = fixture();
		const all = collectEvalPage(f.runsRoot, f.baselineEvalRunId);
		const mode = all.modes.find((mode) => all.rows.find((row) => row.runId === f.failingRunId)?.failureModeIds.includes(mode.id))!;
		const filtered = collectEvalPage(f.runsRoot, f.baselineEvalRunId, { query: { mode: mode.id } });
		expect(filtered.rows.every((row) => row.failureModeIds.includes(mode.id))).toBe(true);
		expect(renderEvalPage(filtered)).toContain(mode.facts);
		const linked = collectEvalPage(f.runsRoot, f.baselineEvalRunId, { query: { q: "no matches", run: f.failingRunId } });
		expect(linked.rows).toEqual([]);
		expect(linked.selectedRun?.run.runId).toBe(f.failingRunId);
		expect(renderEvalPage(linked)).toContain("outside the current filters");
		const empty = collectEvalPage(f.runsRoot, f.baselineEvalRunId, { query: { q: "no matches" } });
		expect(empty.selectedRun).toBeNull();
		expect(renderEvalPage(empty)).toContain("No runs match this filter");
	});

	it("navigates all affected runs beyond the brief's twelve representative excerpts", () => {
		const f = writeExplorerFixture(() => Array.from({ length: 21 }, (_, repetitionIndex) => ({
			taskId: "repeated-case", repetitionIndex, input: "Check every repetition", answer: `answer ${repetitionIndex}`,
			calledTool: false,
			graders: [{ name: "required-answer", type: "output_contains", passed: repetitionIndex === 20, score: repetitionIndex === 20 ? 1 : 0, reason: "Required answer missing" }],
		})));
		roots.push(f.runsRoot);
		const all = collectEvalPage(f.runsRoot, f.baselineEvalRunId);
		const modes = all.modes.filter((mode) => mode.observations.failed === 20);
		expect(modes.length).toBeGreaterThanOrEqual(2); // Exact legacy check and observed outcome instability.
		for (const mode of modes) {
			expect(mode.runCount).toBe(20);
			expect(mode.observations).toEqual({ failed: 20, total: 21 });
			const filtered = collectEvalPage(f.runsRoot, f.baselineEvalRunId, { query: { mode: mode.id, run: "run_base_19" } });
			expect(filtered.rows).toHaveLength(20);
			expect(filtered.rows.some((row) => row.runId === "run_base_19")).toBe(true);
			expect(filtered.rows.some((row) => row.runId === "run_base_20")).toBe(false);
			expect(filtered.selectedRun?.run.runId).toBe("run_base_19");
		}
	});

	it("rejects foreign, sealed, and malformed selectors identically before opening requested artifacts", async () => {
		const f = fixture();
		// The foreign run is corrupt: opening it would produce an integrity error rather than a not-found result.
		writeFileSync(join(f.runsRoot, f.passingRunId, "run.json"), "corrupt foreign artifact");
		for (const run of [f.passingRunId, f.sealedRunId, "does-not-exist", "../private"]) {
			expect(() => collectEvalPage(f.runsRoot, f.baselineEvalRunId, { query: { run } })).toThrow(EvidenceNotFound);
		}
		const server = createEvidenceExplorer({ runsRoot: f.runsRoot }); servers.push(server);
		const address = await server.listen();
		for (const query of [`run=${f.passingRunId}`, `run=${f.sealedRunId}`, "run=does-not-exist", "run=..%2Fprivate", "run=", `run=${f.failingRunId}&run=${f.sealedRunId}`]) {
			const response = await fetch(`${address.url}/evals/${f.baselineEvalRunId}?${query}`);
			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Not found\n");
		}
	});

	it("does not render changed trace bytes and retains the verified recorded checks", () => {
		const f = fixture();
		const tracePath = join(f.runsRoot, f.failingRunId, "session.jsonl");
		writeFileSync(tracePath, readFileSync(tracePath, "utf8").replace("Ответ без проверки.", "TAMPERED-ANSWER-SENTINEL"));
		const model = collectEvalPage(f.runsRoot, f.baselineEvalRunId, { query: { run: f.failingRunId } });
		expect(model.selectedRun?.transcript).toBeNull();
		expect(model.selectedRun?.graders.length).toBeGreaterThan(0);
		const html = renderEvalPage(model);
		expect(html).not.toContain("TAMPERED-ANSWER-SENTINEL");
		expect(html).toContain("No trace is recorded");
		expect(html).toContain("tool_called");
	});

	it("redacts credential-shaped recorded text through the verified trace projection", () => {
		const credential = `sk-proj-${"a".repeat(48)}`;
		const f = writeExplorerFixture(() => [{
			taskId: "credential-case", input: `Inspect this key: ${credential}`, answer: `I saw ${credential}`,
			calledTool: false, graders: [{ name: "answer", type: "output_contains", passed: true, score: 1, reason: "answer recorded" }],
		}]);
		roots.push(f.runsRoot);
		const model = collectEvalPage(f.runsRoot, f.baselineEvalRunId, { query: { run: f.failingRunId } });
		expect(model.selectedRun?.transcript?.entries.length).toBeGreaterThan(0);
		expect(JSON.stringify(model)).not.toContain(credential);
		expect(renderEvalPage(model)).not.toContain(credential);
		expect(readFileSync(join(f.runsRoot, f.failingRunId, "session.jsonl"), "utf8")).toContain(credential);
	});

	it("keeps a one-millisecond tool duration legible in both sequence and conversation", () => {
		const f = fixture();
		const model = collectEvalPage(f.runsRoot, f.candidateEvalRunId, { query: { run: f.passingRunId } });
		const tool = model.selectedRun!.transcript!.entries.find((entry) => entry.kind === "tool")!;
		if (tool.kind !== "tool") throw new Error("fixture tool missing");
		tool.durationMs = 1;
		const html = renderEvalPage(model);
		expect(html).toContain("ok · 1ms");
		expect(html).toContain("<small>1ms</small>");
		expect(html).not.toContain("0.00s");
	});

	it("escapes trace, issue, and query content while keeping all data out of executable script", () => {
		const f = fixture();
		const model = collectEvalPage(f.runsRoot, f.baselineEvalRunId, { query: { run: f.failingRunId } });
		const payload = '</script><img src=x onerror="alert(1)">';
		model.modes[0]!.title = payload;
		model.search = payload;
		model.selectedRun!.transcript!.entries.push({ kind: "user", text: payload, at: null });
		const html = renderEvalPage(model);
		expect(html).not.toContain(payload);
		expect(html).toContain('&lt;/script&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
		expect(html.match(/<script>([\s\S]*?)<\/script>/)?.[1]).not.toContain("alert(1)");
		expect(html).not.toContain("innerHTML");
		setLanguage("ru");
		const russian = renderEvalPage(model);
		expect(russian).toContain("Разбор разговора");
		expect(russian).toContain("Проблемы");
	});
});
