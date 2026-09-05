import { SEALED_SENTINEL, writeExplorerFixture as createExplorerFixture } from "./helpers/evidence-fixture.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	EVIDENCE_INDEX_MAX_BYTES,
	createEvidenceExplorer,
	type EvidenceExplorer,
} from "../src/evidence/server.js";
import { writeEvalRun, type EvalRunRecord } from "../src/eval.js";
import { diagnoseEvalRun } from "../src/diagnosis.js";
import {
	RunRecordSchema,
	executionFingerprint,
	hashFile,
	hashValue,
	modelFingerprint,
	provenanceAxes,
	provenanceKey,
	type GraderResult,
	type RunRecord,
} from "../src/provenance.js";
import type { RunEvent } from "../src/run-events.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";

const roots: string[] = [];
const explorers: EvidenceExplorer[] = [];

function writeExplorerFixture() {
	const fixture = createExplorerFixture();
	roots.push(fixture.runsRoot);
	return fixture;
}

function writeCorruptFormalSealedIndex(runsRoot: string): EvalRunRecord {
	const runtime = {
		piVersion: "0.84.3",
		piSha: "b".repeat(40),
		ahdeVersion: "0.1.0",
		ahdeCodeHash: `sha256:${"c".repeat(64)}`,
	};
	const model = modelFingerprint({
		provider: "mock",
		id: "model",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1/v1",
		apiKeyEnv: "TEST_KEY",
		thinkingLevel: "off",
		params: {},
		spec: {},
	});
	const execution = executionFingerprint("isolated");
	const evaluation = {
		suiteId: "sealed-suite",
		suiteHash: `sha256:${"d".repeat(64)}`,
		dataset: "ordinary-private-dataset",
		datasetHash: `sha256:${"e".repeat(64)}`,
	};
	const evidence = { runtime, model, judge: null, execution, eval: evaluation };
	const record: EvalRunRecord = {
		schemaVersion: 3,
		purpose: "evidence" as const,
		evalRunId: "erun_formal_private",
		target: { id: "private-target", gitSha: "a".repeat(40) },
		label: "solo",
		baselineEvalRunId: null,
		provenance: provenanceAxes(evidence),
		provenanceKey: provenanceKey(evidence),
		suiteId: evaluation.suiteId,
		suiteHash: evaluation.suiteHash,
		dataset: evaluation.dataset,
		datasetHash: evaluation.datasetHash,
		evidenceVisibility: "sealed",
		taskIds: ["task-super-secret"],
		repetitions: 1,
		runIds: ["run-super-secret"],
		startedAt: "2026-08-28T10:00:00.000Z",
		finishedAt: "2026-08-28T10:00:01.000Z",
		summary: { total: 1, pass: 0, fail: 1, error: 0, allPassRate: 0 },
	};
	writeEvalRun(runsRoot, record);
	return record;
}

function writeDevelopmentCandidateWithSealedBaseline(runsRoot: string, targetId = "public-target"): {
	candidate: EvalRunRecord;
	sealed: EvalRunRecord;
	run: RunRecord;
} {
	const runtime = {
		piVersion: "0.84.3",
		piSha: "b".repeat(40),
		ahdeVersion: "0.1.0",
		ahdeCodeHash: `sha256:${"c".repeat(64)}`,
	};
	const model = modelFingerprint({
		provider: "mock",
		id: "model",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1/v1",
		apiKeyEnv: "TEST_KEY",
		thinkingLevel: "off",
		params: {},
		spec: {},
	});
	const execution = executionFingerprint("isolated");
	const evaluation = {
		suiteId: "development-suite",
		suiteHash: `sha256:${"d".repeat(64)}`,
		dataset: "ordinary-development-dataset",
		datasetHash: `sha256:${"e".repeat(64)}`,
	};
	const candidateId = "erun_public_candidate";
	const sealedId = "erun_formal_sealed_baseline";
	const baselineRevision = "f".repeat(40);
	const run: RunRecord = RunRecordSchema.parse({
		schemaVersion: 1,
		runId: "run-public-candidate",
		taskId: "task-public-candidate",
		repetitionIndex: 0,
		label: "candidate",
		status: "completed",
		error: null,
		startedAt: "2026-08-28T10:00:00.000Z",
		finishedAt: "2026-08-28T10:00:01.000Z",
		target: { id: targetId, gitSha: "a".repeat(40) },
		runtime,
		model,
		execution,
		eval: evaluation,
		trace: { path: "session.jsonl", sessionId: null, sha256: null },
		metrics: {
			tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
			costUsd: 0,
			latencyMs: 1,
			toolCalls: 0,
			toolErrors: 0,
			recoveryAttempts: 0,
		},
		evalResults: {
			outcome: "fail",
			graders: [{
				name: "answer",
				type: "output_contains",
				passed: false,
				score: 0,
				reason: "missing answer",
			}],
		},
		parent: { evalRunId: candidateId, candidateOf: baselineRevision },
	});
	mkdirSync(join(runsRoot, run.runId), { recursive: true });
	writeJsonArtifact(join(runsRoot, run.runId, "run.json"), RunRecordSchema, run);
	const evidence = { runtime, model, judge: null, execution, eval: evaluation };
	const candidate: EvalRunRecord = {
		schemaVersion: 3,
		purpose: "evidence" as const,
		evalRunId: candidateId,
		target: run.target,
		label: "candidate",
		baselineEvalRunId: sealedId,
		provenance: provenanceAxes(evidence),
		provenanceKey: provenanceKey(evidence),
		suiteId: evaluation.suiteId,
		suiteHash: evaluation.suiteHash,
		dataset: evaluation.dataset,
		datasetHash: evaluation.datasetHash,
		evidenceVisibility: "development",
		taskIds: [run.taskId],
		repetitions: 1,
		runIds: [run.runId],
		runArtifacts: [{ runId: run.runId, sha256: hashValue(run) }],
		startedAt: run.startedAt,
		finishedAt: run.finishedAt!,
		summary: { total: 1, pass: 0, fail: 1, error: 0, allPassRate: 0 },
	};
	writeEvalRun(runsRoot, candidate);
	const sealed: EvalRunRecord = {
		...candidate,
		evalRunId: sealedId,
		target: { id: run.target.id, gitSha: baselineRevision },
		label: "baseline",
		baselineEvalRunId: null,
		evidenceVisibility: "sealed",
		taskIds: ["task-super-secret-baseline"],
		runIds: ["run-super-secret-baseline"],
		runArtifacts: undefined,
	};
	writeEvalRun(runsRoot, sealed);
	diagnoseEvalRun(runsRoot, candidate.evalRunId, () => "2026-08-28T10:01:00.000Z");
	return { candidate, sealed, run };
}

const LIVE_TASK_ID_SECRET = "sk-livewebtasksecret1234567890";

const liveEvent: RunEvent = {
	type: "assistant_delta",
	at: "2026-08-28T12:00:00.000Z",
	run: {
		evalRunId: "erun_live_web",
		runId: "run_live_web",
		taskId: LIVE_TASK_ID_SECRET,
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

	it("filters formal sealed indexes before opening corrupt member evidence", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-evidence-"));
		roots.push(runsRoot);
		const sealed = writeCorruptFormalSealedIndex(runsRoot);
		const explorer = createEvidenceExplorer({ runsRoot });
		explorers.push(explorer);
		const address = await explorer.listen();

		const index = await fetch(address.url);
		expect(index.status).toBe(200);
		const indexBody = await index.text();
		expect(indexBody).not.toContain(sealed.evalRunId);
		expect(indexBody).not.toContain("super-secret");

		for (const prefix of ["/evals/", "/api/evals/"]) {
			const response = await fetch(`${address.url}${prefix}${sealed.evalRunId}`);
			expect(response.status).toBe(404);
			const body = await response.text();
			expect(body).toBe("Not found\n");
			expect(body).not.toContain("task-super-secret");
			expect(body).not.toContain("run-super-secret");
		}
	});

	it("rejects a public candidate that transitively references a sealed baseline", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-evidence-"));
		roots.push(runsRoot);
		const { candidate, sealed } = writeDevelopmentCandidateWithSealedBaseline(runsRoot);
		const explorer = createEvidenceExplorer({ runsRoot });
		explorers.push(explorer);
		const address = await explorer.listen();

		const index = await fetch(address.url);
		const indexBody = await index.text();
		expect(index.status).toBe(200);
		expect(indexBody).toContain(candidate.evalRunId);
		expect(indexBody).not.toContain(sealed.evalRunId);
		expect(indexBody).not.toContain("super-secret");

		for (const prefix of ["/evals/", "/api/evals/"]) {
			const response = await fetch(`${address.url}${prefix}${candidate.evalRunId}`);
			expect(response.status).toBe(422);
			const body = await response.text();
			expect(body).toBe("Evidence report failed integrity or visibility checks.\n");
			expect(body).not.toContain(sealed.evalRunId);
			expect(body).not.toContain("super-secret");
		}
	});

	it("caps the public index with honest public-only truncation and bounded field projection", async () => {
		const runsRoot = mkdtempSync(join(tmpdir(), "ahde-evidence-"));
		roots.push(runsRoot);
		const publicCredential = "PUBLIC_INDEX_CREDENTIAL_MUST_BE_REDACTED";
		const publicFieldTail = "PUBLIC_FIELD_TAIL_MUST_BE_CLIPPED";
		const { candidate, sealed, run } = writeDevelopmentCandidateWithSealedBaseline(
			runsRoot,
			`api_key="${publicCredential}" ${"<&".repeat(100_000)}${publicFieldTail}`,
		);
		for (let index = 0; index < 101; index += 1) {
			const suffix = String(index).padStart(3, "0");
			const evalRunId = `erun_public_index_${suffix}`;
			const runId = `run_public_index_${suffix}`;
			const taskId = `task-public-index-${suffix}`;
			const startedAt = new Date(Date.UTC(2026, 7, 27, 0, 0, index)).toISOString();
			const finishedAt = new Date(Date.UTC(2026, 7, 27, 0, 0, index, 1)).toISOString();
			const clonedRun = RunRecordSchema.parse({
				...run,
				runId,
				taskId,
				startedAt,
				finishedAt,
				target: { ...run.target, id: `public-target-${suffix}` },
				parent: { ...run.parent, evalRunId },
			});
			// Index rendering must never open member Runs; these intentionally remain absent.
			writeEvalRun(runsRoot, {
				...candidate,
				evalRunId,
				target: clonedRun.target,
				taskIds: [taskId],
				runIds: [runId],
				runArtifacts: [{ runId, sha256: hashValue(clonedRun) }],
				startedAt,
				finishedAt,
			});
		}
		const explorer = createEvidenceExplorer({ runsRoot });
		explorers.push(explorer);
		const address = await explorer.listen();

		const response = await fetch(address.url);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(Buffer.byteLength(html)).toBeLessThanOrEqual(EVIDENCE_INDEX_MAX_BYTES);
		expect(html).toContain('data-index-truncated="true"');
		expect(html).toContain('data-index-shown="100"');
		expect(html).toContain('data-index-omitted-public="2"');
		expect(html).toContain('data-index-fields-truncated="true"');
		expect(html).toContain('data-index-fields-redacted="true"');
		expect(html).toContain(candidate.evalRunId);
		expect(html).not.toContain(publicCredential);
		expect(html).not.toContain(publicFieldTail);
		expect(html).not.toContain(sealed.evalRunId);
		expect(html).not.toContain("task-super-secret-baseline");
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
		expect(body).not.toContain(LIVE_TASK_ID_SECRET);
		expect(body).toContain("[REDACTED_API_KEY]");
		expect(body).toContain("event: session");
		expect(body).toContain('"status":"completed"');

		const retained = await fetch(liveUrl);
		expect(retained.status).toBe(200);
		const replay = await fetch(`${address.url}/api/live/${live.id}/events`);
		const replayBody = await replay.text();
		expect(replayBody).toContain("LIVE_WEB_CANARY");
		expect(replayBody).not.toContain(LIVE_TASK_ID_SECRET);
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

	it("renders a runs table with one row per case and repetition, failures first", async () => {
		const fixture = writeExplorerFixture();
		const explorer = createEvidenceExplorer({ runsRoot: fixture.runsRoot });
		explorers.push(explorer);
		const address = await explorer.listen();

		const response = await fetch(`${address.url}/evals/${fixture.baselineEvalRunId}`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
		const html = await response.text();

		expect(html).toContain('<meta charset="utf-8">');
		expect(html).toContain(
			"<thead><tr><th>Case and input</th><th>Result</th><th>Graders</th><th>Latency<br>Cost</th></tr></thead>",
		);
		// Russian survives the projection byte for byte.
		expect(html).toContain("Обращение: проверь договор №42 и ограничения ДБО по нему.");
		// Status is a word, never a colour alone.
		expect(html).toContain('<span class="chip fail">fail</span>');
		expect(html).toContain('<span class="chip error">error</span>');
		// Errors first, then failures, then passes.
		const order = [...html.matchAll(/data-outcome="(pass|fail|error)"/g)].map((match) => match[1]);
		expect(order).toEqual(["error", "fail", "fail"]);
		// Grader chips carry the type and a pass mark.
		expect(html).toContain("tool_called ✗");
		expect(html).toContain("output_contains ✗");
		// Summary, failure modes and the filter box sit above the table.
		expect(html).toContain("Pass rate");
		// The mode says what the traces show, and quotes one of them.
		expect(html).toContain("failing run");
		expect(html).toContain("no tool call");
		expect(html).toContain('id="filter"');
		// No external resource of any kind.
		expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);
		expect(html).toContain(`/runs/${fixture.failingRunId}`);
	});

	it("filters the runs table by outcome and by failure mode", async () => {
		const fixture = writeExplorerFixture();
		const explorer = createEvidenceExplorer({ runsRoot: fixture.runsRoot });
		explorers.push(explorer);
		const address = await explorer.listen();
		const base = `${address.url}/evals/${fixture.baselineEvalRunId}`;

		const all = await (await fetch(base)).text();
		const modeId = /mode=(failure-mode-[0-9a-f]{24})/.exec(all)?.[1];
		expect(modeId).toBeDefined();

		const failures = await fetch(`${base}?outcome=fail`);
		expect(failures.status).toBe(200);
		const failuresHtml = await failures.text();
		expect([...failuresHtml.matchAll(/data-outcome="(pass|fail|error)"/g)].map((m) => m[1])).toEqual(["fail", "fail"]);
		expect(failuresHtml).toContain("Showing 2 of 3 run(s) with outcome fail.");

		const byMode = await fetch(`${base}?mode=${modeId}`);
		expect(byMode.status).toBe(200);
		const byModeHtml = await byMode.text();
		expect(byModeHtml).toContain(`in failure mode ${modeId}`);
		expect([...byModeHtml.matchAll(/data-outcome=/g)].length).toBeGreaterThan(0);

		// An unknown filter key is ignored rather than obeyed.
		const bogus = await fetch(`${base}?outcome=../../etc&mode=not-a-mode`);
		expect(bogus.status).toBe(200);
		expect([...(await bogus.text()).matchAll(/data-outcome=/g)].length).toBe(3);
	});

	it("renders one run's conversation, verdict, and host-written explanation", async () => {
		const fixture = writeExplorerFixture();
		const explorer = createEvidenceExplorer({ runsRoot: fixture.runsRoot });
		explorers.push(explorer);
		const address = await explorer.listen();

		const response = await fetch(`${address.url}/runs/${fixture.failingRunId}`);
		expect(response.status).toBe(200);
		const html = await response.text();

		// Why: expectation, observation, the grader's own words, and the counted facts.
		expect(html).toContain("task_001 repetition 0 failed: 1 of 1 grader(s) did not pass.");
		expect(html).toContain(
			"expected a call to bash with arguments containing “check_dbo”; the agent made no tool calls and answered directly.",
		);
		expect(html).toContain("The grader recorded: “never called bash with args containing &quot;check_dbo&quot;”.");
		expect(html).toContain("What the traces show:");
		expect(html).toContain("No model wrote it.");
		// Verdict: every grader with its outcome and reason.
		expect(html).toContain("task_001#0:tool_called:bash(check_dbo)");
		// Conversation: the case input, the turns, and an honest note about the system prompt.
		expect(html).toContain("System instructions");
		expect(html).toContain("not recorded in session.jsonl");
		expect(html).toContain("Обращение: проверь договор №42 и ограничения ДБО по нему.");
		expect(html).toContain("assistant · final answer");
		// Walking the failures.
		expect(html).toContain(`/evals/${fixture.baselineEvalRunId}`);
		expect(html).toMatch(/href="\/runs\/run_base_\d"/);

		// A passing run in the candidate arm still renders, and says so.
		const passing = await fetch(`${address.url}/runs/${fixture.passingRunId}`);
		expect(passing.status).toBe(200);
		expect(await passing.text()).toContain("passed: all 1 grader(s) were satisfied.");

		// An infrastructure error is inconclusive, not a behavioural failure.
		const errored = await fetch(`${address.url}/runs/${fixture.erroredRunId}`);
		expect(errored.status).toBe(200);
		expect(await errored.text()).toContain("inconclusive rather than a behavioural failure");

		expect((await fetch(`${address.url}/runs/run_missing`)).status).toBe(404);
	});

	it("compares a candidate against its baseline per task", async () => {
		const fixture = writeExplorerFixture();
		const explorer = createEvidenceExplorer({ runsRoot: fixture.runsRoot });
		explorers.push(explorer);
		const address = await explorer.listen();

		const response = await fetch(`${address.url}/candidates/${fixture.candidateId}`);
		expect(response.status).toBe(200);
		const html = await response.text();

		expect(html).toContain("<th>Task</th><th>Baseline</th><th>Candidate</th><th>Score</th><th>Delta</th><th>Flip</th>");
		expect(html).toContain("↑ improved");
		expect(html).toContain("Cost ratio");
		// The compare page prints the same sentence the panel and the passport do —
		// and the sentence now says where the third case went instead of quietly
		// measuring two.
		expect(html).toContain(
			"inconclusive · score 0% → 100% (+100 pts, 95% CI +100 … +100) on 2 of 3 cases × 1 · " +
				"1 excluded for infrastructure · pass rate 0% → 100%",
		);
		// The sealed arm contributes a verdict and a design size and nothing else.
		expect(html).toContain("Sealed verdict: pass</b> · improved · 2 cases × 1 repetitions");
		expect(html).toContain("Sealed cases, identifiers, and traces are never rendered here.");
		expect(html).toContain(`/runs/${fixture.failingRunId}`);

		expect((await fetch(`${address.url}/candidates/candidate-missing`)).status).toBe(404);
	});

	it("never renders sealed runs, sealed corpus identity, or sealed case content", async () => {
		const fixture = writeExplorerFixture();
		const explorer = createEvidenceExplorer({ runsRoot: fixture.runsRoot });
		explorers.push(explorer);
		const address = await explorer.listen();

		for (const path of [
			"/",
			`/evals/${fixture.baselineEvalRunId}`,
			`/evals/${fixture.candidateEvalRunId}`,
			`/evals/${fixture.baselineEvalRunId}?outcome=fail`,
			`/runs/${fixture.failingRunId}`,
			`/runs/${fixture.passingRunId}`,
			`/candidates/${fixture.candidateId}`,
		]) {
			const response = await fetch(`${address.url}${path}`);
			expect(response.status).toBe(200);
			const body = await response.text();
			expect(body, `${path} leaked the sealed sentinel`).not.toContain(SEALED_SENTINEL);
			expect(body, `${path} leaked the sealed eval run id`).not.toContain(fixture.sealedEvalRunId);
			expect(body, `${path} leaked the sealed candidate arm`).not.toContain(`${fixture.sealedEvalRunId}_candidate`);
			expect(body, `${path} leaked the sealed run id`).not.toContain(fixture.sealedRunId);
		}

		// The sealed eval, its API projection, and its member run are all absent.
		for (const path of [
			`/evals/${fixture.sealedEvalRunId}`,
			`/api/evals/${fixture.sealedEvalRunId}`,
			`/runs/${fixture.sealedRunId}`,
		]) {
			const response = await fetch(`${address.url}${path}`);
			expect(response.status, path).toBe(404);
			const body = await response.text();
			expect(body).toBe("Not found\n");
			expect(body).not.toContain(SEALED_SENTINEL);
		}
	});

	it("refuses an undiagnosed eval and its runs without creating a diagnosis", async () => {
		const fixture = writeExplorerFixture();
		rmSync(join(fixture.runsRoot, fixture.baselineEvalRunId, "diagnosis.json"));
		const explorer = createEvidenceExplorer({ runsRoot: fixture.runsRoot });
		explorers.push(explorer);
		const address = await explorer.listen();

		for (const path of [`/evals/${fixture.baselineEvalRunId}`, `/runs/${fixture.failingRunId}`]) {
			const response = await fetch(`${address.url}${path}`);
			expect(response.status, path).toBe(409);
			expect(await response.text()).toBe(
				"Evidence is not diagnosed yet; run the AHDE diagnosis operation first.\n",
			);
		}
		expect(existsSync(join(fixture.runsRoot, fixture.baselineEvalRunId, "diagnosis.json"))).toBe(false);
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
