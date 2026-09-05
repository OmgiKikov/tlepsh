import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { targetWithSealedCorpus } from "../src/application/corpus-target.js";
import { decisionReplayUrl } from "../src/builder/decision-presentation.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { MAX_RUN_INSPECTION_LINES, renderRunInspection } from "../src/builder/render/run-inspection.js";
import { WorkbenchViewToolSchema } from "../src/builder/workbench-transport.js";
import { loadCorpus } from "../src/corpus.js";
import { loadVerifiedEvalRun, runSuite } from "../src/eval.js";
import { loadTarget } from "../src/manifest.js";
import { hashFile, hashValue } from "../src/provenance.js";
import { inspectSelectedDevelopmentRun } from "../src/workbench/run-inspection.js";
import type { WorkbenchDecisionResult } from "../src/workbench/types.js";
import { createHostContext, invokeTool, productionTools } from "./helpers/builder-tools.js";
import { approvingGate, improveFixture, type ImproveFixture } from "./helpers/improve-fixtures.js";

const fixtures: ImproveFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture() {
	const result = await improveFixture({}, { repetitions: 1 });
	fixtures.push(result);
	return result;
}

it("reads one actual recorded development answer through the existing Builder tool without running or asking", async () => {
	const project = await fixture();
	const evaluation = loadVerifiedEvalRun(project.runsRoot, project.evalRunId);
	const run = evaluation.runs[0]!;
	const requests = project.mock.requests();
	const host = createHostContext({ hasUI: false });
	const result = await invokeTool(productionTools(project), "ahde_workbench_view", { aspect: "traces", runId: run.runId }, host.ctx);
	expect(result.detail.content.selectedRun).toMatchObject({
		evalRunId: project.evalRunId, runId: run.runId, taskId: run.taskId,
		repetitionIndex: 0, status: "completed", outcome: "fail",
		checks: [{ type: "output_contains", passed: false }, { type: "final_answer", passed: true }],
		transcript: { truncated: false, omittedCount: 0, entries: [
			{ kind: "user", text: "Answer reviewed request 1." },
			{ kind: "assistant", text: "pending", final: true },
		] },
	});
	expect(JSON.stringify(result.detail.content.selectedRun)).not.toContain('"thinking"');
	expect(host.confirmations).toHaveLength(0);
	expect(project.mock.requests()).toBe(requests);
});

it("rejects malformed scope, runs outside the selected eval, and a real sealed run", async () => {
	expect(WorkbenchViewToolSchema.prepare({ aspect: "traces", runId: "run-1" })).toEqual({ aspect: "traces", runId: "run-1" });
	for (const input of [{ runId: "run-1" }, { aspect: "target", runId: "run-1" }, { aspect: "traces", runId: "../private/run" }]) {
		expect(() => WorkbenchViewToolSchema.prepare(input)).toThrow();
	}
	const project = await fixture();
	const oldRun = loadVerifiedEvalRun(project.runsRoot, project.evalRunId).runs[0]!;
	await project.workbench.decide({ kind: "run-eval", repetitions: 1, reason: "A new current measurement" }, approvingGate());
	await expect(project.workbench.view({ aspect: "traces", runId: oldRun.runId })).rejects.toThrow(/does not belong/);
	await expect(project.workbench.view({ aspect: "traces", runId: "foreign-target-run" })).rejects.toThrow(/does not belong/);
	const target = loadTarget(project.projectDir);
	const sealed = targetWithSealedCorpus(target, loadCorpus({ stateRoot: project.stateRoot, projectId: project.projectId, corpusId: project.sealedCorpusId }));
	const privateRun = await runSuite({ ...sealed, tasks: sealed.tasks.slice(0, 1) }, {
		runsRoot: project.runsRoot, label: "solo", repetitions: 1, evidenceVisibility: "sealed",
	});
	await expect(project.workbench.view({ aspect: "traces", runId: privateRun.runIds[0]! })).rejects.toThrow(/does not belong/);
	const privateEvaluation = loadVerifiedEvalRun(project.runsRoot, privateRun.evalRunId);
	expect(() => inspectSelectedDevelopmentRun({ runsRoot: project.runsRoot, evaluation: privateEvaluation, targetId: target.manifest.id, runId: privateRun.runIds[0]! })).toThrow(/hash-pinned development/);
});

it("refuses altered pinned trace bytes and altered run records", async () => {
	const project = await fixture();
	const run = loadVerifiedEvalRun(project.runsRoot, project.evalRunId).runs[0]!;
	const tracePath = join(project.runsRoot, run.runId, run.trace.path);
	const original = readFileSync(tracePath, "utf8");
	writeFileSync(tracePath, `${original}\n`);
	await expect(project.workbench.view({ aspect: "traces", runId: run.runId })).rejects.toThrow(/trace SHA mismatch/i);
	writeFileSync(tracePath, original);
	writeFileSync(join(project.runsRoot, run.runId, "run.json"), JSON.stringify({ ...run, metrics: { ...run.metrics, latencyMs: run.metrics.latencyMs + 1 } }));
	await expect(project.workbench.view({ aspect: "traces", runId: run.runId })).rejects.toThrow();
});

it("redacts tools and checks, omits reasoning, and declares both model and terminal clipping", async () => {
	const project = await fixture();
	const evaluation = loadVerifiedEvalRun(project.runsRoot, project.evalRunId);
	const run = evaluation.runs[0]!;
	const trace = [
		{ role: "user", content: 'api_key="secret-user-canary"' },
		{ role: "assistant", content: [
			{ type: "thinking", thinking: "hidden-reasoning-canary" },
			{ type: "toolCall", id: "lookup-1", name: "lookup", arguments: { token: "secret-args-canary" } },
		] },
		{ role: "toolResult", toolCallId: "lookup-1", toolName: "lookup", isError: false, content: 'password="secret-result-canary"' },
		...Array.from({ length: 120 }, (_, index) => ({ role: index % 2 === 0 ? "user" : "assistant", content: `${index}: ${"long recorded content ".repeat(300)}` })),
	].map((message) => JSON.stringify({ type: "message", message })).join("\n") + "\n";
	// A trusted fixture writer pins the content before the ordinary reader sees
	// it; the previous test separately proves that unpinned modification fails.
	writeFileSync(join(project.runsRoot, run.runId, run.trace.path), trace);
	run.trace.sha256 = hashFile(trace);
	run.evalResults!.graders[0]!.reason = 'api_key="secret-check-canary" ' + "recorded reason ".repeat(100);
	writeFileSync(join(project.runsRoot, run.runId, "run.json"), JSON.stringify(run));
	evaluation.record.runArtifacts!.find((artifact) => artifact.runId === run.runId)!.sha256 = hashValue(run);
	writeFileSync(join(project.runsRoot, project.evalRunId, "eval_run.json"), JSON.stringify(evaluation.record));
	// Inspect the newly pinned fixture through the canonical reader. Reusing the
	// earlier diagnosis would correctly refuse these changed fixture artifacts.
	const inspected = inspectSelectedDevelopmentRun({
		runsRoot: project.runsRoot, evaluation: loadVerifiedEvalRun(project.runsRoot, project.evalRunId), targetId: run.target.id, runId: run.runId,
	});
	const serialized = JSON.stringify(inspected);
	expect(serialized).not.toMatch(/secret-(user|args|result|check)-canary|hidden-reasoning-canary|"thinking"/);
	expect(serialized).toContain("REDACTED");
	expect(serialized.length).toBeLessThan(48_000);
	expect(inspected.transcript).toMatchObject({ truncated: true, omittedCount: expect.any(Number) });
	expect(inspected.transcript!.omittedCount).toBeGreaterThan(0);
	expect(inspected.transcript!.entries.find((entry) => entry.kind === "tool")).toMatchObject({ name: "lookup", result: expect.stringContaining("REDACTED") });
	expect(inspected.limitations.checkTextClipped).toBe(true);
	const lines = renderRunInspection(inspected, plainPaint);
	expect(lines).toHaveLength(MAX_RUN_INSPECTION_LINES);
	expect(lines.at(-1)).toContain("omitted");
});

it("links completed verification to replay on the existing loopback host and never links an unmeasured screen", () => {
	const verified = { kind: "verify-candidate", result: { outcome: "verified", candidate: { candidateId: "candidate-1" } } } as WorkbenchDecisionResult;
	expect(decisionReplayUrl(verified, "http://127.0.0.1:4123/live/scope")).toBe("http://127.0.0.1:4123/candidates/candidate-1/replay");
	for (const url of [undefined, "https://remote.invalid/live", "http://user:secret@localhost/live"]) expect(decisionReplayUrl(verified, url)).toBeNull();
	expect(decisionReplayUrl({ kind: "verify-candidate", result: { outcome: "stopped-by-screen" } } as WorkbenchDecisionResult, "http://localhost:4123/live/scope")).toBeNull();
});
