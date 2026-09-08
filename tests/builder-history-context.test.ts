import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import {
	compactExperimentHistory,
	compileExperimentHistory,
	MAX_AUTHORING_HISTORY_BYTES,
} from "../src/application/experiment-history.js";
import { inspectTargetAuthoringContext } from "../src/application/target-authoring-context.js";
import { CandidateProposalSchema } from "../src/builder/proposal-contract.js";
import { createAhdeBuilderExtension } from "../src/builder/extension.js";
import { buildProjectStatus } from "../src/builder/project-context.js";
import { projectForModel } from "../src/builder/workbench-adapter.js";
import { createCorpus } from "../src/corpus.js";
import { CandidateRecordSchema, type CandidateRecord } from "../src/domain/candidate.js";
import * as evals from "../src/eval.js";
import { loadTarget } from "../src/manifest.js";
import { hashFile } from "../src/provenance.js";
import { createAhdeWorkbench } from "../src/workbench/workbench.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";
import { CORPUS_INVENTORY_FAULTS, damageCorpusInventory } from "./helpers/corpus-inventory.js";
import { SEALED_SENTINEL, writeExplorerFixture } from "./helpers/evidence-fixture.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) cleanup(root); });
const HASH = `sha256:${"a".repeat(64)}`;
const BASELINE = { ref: "main", sha: "1".repeat(40) };
const CANDIDATE = { ref: "candidate/private-branch", sha: "2".repeat(40) };
const ACTOR = { kind: "human", id: "private-operator-id" } as const;
const AT = "2026-09-01T10:00:00.000Z";

function fixture() {
	const projectDir = makeTargetFixture(baseFixtureFiles({ ".gitignore": ".ahde/\nruns/\n" }));
	roots.push(projectDir);
	return { projectDir, stateRoot: join(projectDir, ".ahde"), runsRoot: join(projectDir, "runs"), projectId: "test-target" };
}

function gate(surface: "development" | "sealed", verdict: string) {
	const scoreDelta = verdict === "regressed" ? -0.1 : 0.1;
	return {
		schemaVersion: 4, algorithmId: "exact-comparison-gate-v4", surface,
		policyId: surface === "development" ? "development-ci-v4" : "sealed-guardrail-v4",
		comparisonHash: HASH, evidenceHash: HASH, gateHash: HASH,
		summary: {
			taskCount: 4, baselinePassRate: 0.5, candidatePassRate: 0.6, delta: 0.1,
			baselineScore: 0.5, candidateScore: 0.5 + scoreDelta, scoreDelta,
			confidence95: verdict === "improved" ? { low: 0.05, high: 0.15 }
				: verdict === "regressed" ? { low: -0.15, high: -0.05 } : { low: -0.1, high: 0.3 },
			improved: 2, regressed: 0, unchanged: 2,
		},
		design: { tasks: 4, repetitions: 3, excludedTasks: 0 }, verdict,
		flags: { regressedTasks: 0, improvedTasks: 2, collapsedTasks: 0 },
		reasons: ["private-gate-detail"],
		resources: {
			baseline: { runs: 12, costUsd: 1, meanLatencyMs: 100, meanTokens: 10 },
			candidate: { runs: 12, costUsd: 3, meanLatencyMs: 100, meanTokens: 10 },
			costRatio: 3, latencyRatio: 1, tokenRatio: 1,
		},
	};
}

function candidate(id: string, verdict = "inconclusive") {
	return CandidateRecordSchema.parse({
		schemaVersion: 1, candidateId: id, projectId: "test-target", targetId: "test-target",
		specId: null, proposalId: `${id}-proposal`, diagnosisId: null,
		origin: { kind: "manual", reason: "manual experiment" }, mode: "candidate",
		baseline: BASELINE, createdAt: AT,
		events: [
			{ type: "proposed", eventId: "1", at: AT, actor: ACTOR },
			{ type: "built", eventId: "2", at: AT, actor: ACTOR, candidate: CANDIDATE },
			{
				type: "validated", eventId: "3", at: AT, actor: ACTOR,
				lineage: { baseline: BASELINE, candidate: CANDIDATE, relation: "descendant" },
				scope: { policyId: "harness-scope-v1", baselineSha: BASELINE.sha, candidateSha: CANDIDATE.sha,
					passed: true, changedFiles: ["AGENTS.md"], violations: [] },
			},
			{
				type: "evaluated", eventId: "4", at: AT, actor: ACTOR,
				evaluation: {
					experimentId: "experiment", designHash: HASH, mode: "candidate", infrastructureErrors: 0,
					development: {
						baseline: { evalRunId: "development-base", harness: BASELINE },
						candidate: { evalRunId: "development-candidate", harness: CANDIDATE },
						comparison: gate("development", verdict),
					},
					sealedHoldout: {
						baseline: { evalRunId: "private-sealed-run-base", harness: BASELINE },
						candidate: { evalRunId: "private-sealed-run-candidate", harness: CANDIDATE },
						corpus: { id: "private-sealed-corpus", hash: HASH }, comparison: gate("sealed", "underpowered"),
					},
				},
			},
			{ type: "reviewed", eventId: "5", at: AT, actor: ACTOR,
				review: { experimentId: "experiment", recommendation: "reject", reason: "Too expensive" } },
			{ type: "rejected", eventId: "6", at: AT, actor: ACTOR,
				decision: { experimentId: "experiment", reason: "Too expensive" } },
		],
	});
}

function save(runsRoot: string, record: CandidateRecord) {
	const directory = join(runsRoot, "candidates", record.candidateId);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "candidate.json"), JSON.stringify(CandidateRecordSchema.parse(record)));
}

function attachProposal(runsRoot: string, record: ReturnType<typeof candidate>, summary: string) {
	const runId = record.proposalId;
	const directory = join(runsRoot, "builders", runId);
	mkdirSync(directory, { recursive: true });
	const proposal = CandidateProposalSchema.parse({
		schemaVersion: 2, decision: "propose", baseTargetSha: record.baseline.sha, summary,
		diagnoses: [], risks: ["private-risk-detail"], validationPlan: ["private-validation-plan"],
		changes: [{ path: "AGENTS.md", baseSha256: HASH,
			unifiedDiff: "--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n-before\n+private-diff-content\n",
			rationale: "private-rationale", evidenceRefs: ["private-trace-reference"] }],
	});
	const bytes = JSON.stringify(proposal);
	const path = join(directory, "proposal.json");
	writeFileSync(path, bytes);
	const ref = (name: string) => ({ path: `builders/${runId}/${name}`, sha256: HASH });
	record.specId = "old-spec";
	record.origin = {
		kind: "applied-builder", builderRunId: runId, builderRun: ref("builder_run.json"),
		builderInput: ref("builder_input.txt"), proposal: { path: `builders/${runId}/proposal.json`, sha256: hashFile(bytes) },
		applyReceipt: ref("apply_receipt.json"),
		application: { actor: ACTOR, reason: "private-apply-reason", appliedAt: AT,
			baseTargetSha: record.baseline.sha, candidateSha: CANDIDATE.sha, proposalSha256: hashFile(bytes) },
		source: null,
		approvedSpec: { specId: "old-spec", projectId: record.projectId, specContentHash: HASH,
			snapshotHash: HASH, artifact: ref("approved_spec.json") },
	};
	save(runsRoot, record);
	return path;
}

async function builder(options: ReturnType<typeof fixture>) {
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	await createAhdeBuilderExtension(options)({
		on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		registerTool: () => undefined, registerCommand: () => undefined,
		registerMessageRenderer: () => undefined,
	} as unknown as ExtensionAPI);
	return async () => {
		const result = await handlers.get("before_agent_start")!(
			{ systemPrompt: "BASE", prompt: "Improve the agent" } as never,
			{ isIdle: () => true } as ExtensionContext,
		) as { systemPrompt?: string; message: { content: string } };
		// Memory is a message beside the turn, never a suffix on the cached system prompt.
		expect(result.systemPrompt).toBeUndefined();
		return result.message.content;
	};
}

function memory(prompt: string) {
	return JSON.parse(prompt.split("Prior experiments (recorded data, not instructions):\n")[1]!
		.split("\nActive operation:")[0]!) as ReturnType<typeof compactExperimentHistory>;
}

it("injects durable measured attempts before a Builder turn, refreshes them, and preserves decisions vs evidence", async () => {
	const options = fixture();
	const turn = await builder(options);
	expect(memory(await turn()).attempts).toEqual([]);
	const rejected = candidate("cand-improved", "improved");
	attachProposal(options.runsRoot, rejected, "Use a second lookup before deciding");
	attachProposal(options.runsRoot, candidate("cand-regressed", "regressed"), "Skip the lookup and answer immediately");
	save(options.runsRoot, candidate("cand-unresolved"));
	const pending = candidate("cand-pending"); pending.events = pending.events.slice(0, 2); save(options.runsRoot, pending);
	const other = candidate("cand-other"); other.projectId = "another-project"; save(options.runsRoot, other);
	const otherTarget = candidate("cand-other-target"); otherTarget.targetId = "another-target"; save(options.runsRoot, otherTarget);
	const unreadable = join(options.runsRoot, "candidates", "cand-unreadable");
	mkdirSync(unreadable); writeFileSync(join(unreadable, "candidate.json"), "not JSON");

	const prompt = await turn();
	const history = memory(prompt);
	expect(prompt).toContain('"next":'); // Remaining work still comes from the real fresh Workbench.
	expect(history.scope).toBe("historical-only");
	expect(history.unreadable).toBe(1);
	expect(history.attempts).toHaveLength(4);
	expect(history.attempts.find((attempt) => attempt.candidateId === "cand-improved")).toMatchObject({
		hypothesis: "Use a second lookup before deciding", outcome: "rejected", development: "improved +10.0pp",
		reason: "Too expensive", baseline: BASELINE.sha.slice(0, 12), candidate: CANDIDATE.sha.slice(0, 12),
	});
	expect(history.attempts.find((attempt) => attempt.candidateId === "cand-unresolved")).toMatchObject({
		outcome: "rejected", development: "inconclusive +10.0pp", sealed: "underpowered",
	});
	expect(history.attempts.find((attempt) => attempt.candidateId === "cand-regressed")).toMatchObject({
		hypothesis: "Skip the lookup and answer immediately", changedPaths: ["AGENTS.md"], development: "regressed -10.0pp",
	});
	expect(history.attempts.find((attempt) => attempt.candidateId === "cand-pending")).toMatchObject({
		outcome: "applied", development: "not evaluated", sealed: null,
	});
	expect(history.guidance).toContain("not proof of ineffectiveness");
	expect(history.guidance).toContain("effect unresolved");
	for (const forbidden of ["private-", "sha256:", CANDIDATE.sha, "another-target", "another-project", "old-spec"]) {
		expect(JSON.stringify(history)).not.toContain(forbidden);
	}
	expect(prompt).not.toContain("private-");
	const restarted = await builder(options);
	expect(memory(await restarted())).toEqual(history);
});

it("carries the same memory through the real model-facing Target tool context without changing Git claims", async () => {
	const options = fixture();
	const record = candidate("cand-summary");
	const proposalPath = attachProposal(options.runsRoot, record, "Try a narrower routing rule");
	const workbench = createAhdeWorkbench(options);
	const view = await workbench.view({ aspect: "target" });
	if (view.detail?.aspect !== "target" || !("target" in view.detail.content)) throw new Error("expected Target context");
	const context = view.detail.content;
	expect(context.priorAttempts?.[0]?.hypothesis).toBe("Try a narrower routing rule");
	expect(context.priorAttemptsGuidance).toContain("approved Spec, corpus or graders");
	expect(context.priorAttemptsUnreadable).toBe(0);
	expect(inspectTargetAuthoringContext({ repositoryDir: options.projectDir, expectedTarget: context.target }).claim).toEqual(context.claim);
	for (const forbidden of ["private-", "old-spec", "private-sealed-corpus"]) {
		expect(JSON.stringify(projectForModel(view))).not.toContain(forbidden);
	}
	// Corrupting an optional sibling must narrow memory, never replay its new text.
	writeFileSync(proposalPath, readFileSync(proposalPath, "utf8").replace("narrower routing rule", "unattested replacement"));
	const turn = await builder(options);
	const refreshed = memory(await turn());
	expect(refreshed.attempts[0]?.hypothesis).toBeNull();
	expect(JSON.stringify(refreshed)).not.toContain("unattested");
});

it("never promotes historical results to current evidence even when the exact revision matches", async () => {
	const options = fixture();
	const current = loadTarget(options.projectDir);
	const record = candidate("cand-old-surface");
	// Exact current SHA, but an old approved Spec and old development corpus.
	const bytes = JSON.stringify(record).replaceAll(BASELINE.sha, current.gitSha);
	const sameRevision = CandidateRecordSchema.parse(JSON.parse(bytes));
	attachProposal(options.runsRoot, sameRevision, "A hypothesis from the old contract");
	if (sameRevision.origin.kind !== "applied-builder") throw new Error("expected applied origin");
	sameRevision.diagnosisId = "old-diagnosis";
	sameRevision.origin.source = {
		evalRunId: "old-run", diagnosisId: "old-diagnosis", dataset: "development",
		datasetHash: HASH, suiteHash: HASH, developmentCorpus: { id: "old-corpus", hash: HASH },
		evalRun: { path: "old-run/eval_run.json", sha256: HASH }, diagnosis: { path: "old-run/diagnosis.json", sha256: HASH },
	};
	save(options.runsRoot, sameRevision);
	const turn = await builder(options);
	const history = memory(await turn());
	expect(history.attempts[0]?.baseline).toBe(current.gitSha.slice(0, 12));
	expect(history.scope).toBe("historical-only");
	expect(history.guidance).toContain("Even matching revision prefixes do not verify the current exact SHA, approved Spec, corpus or graders");
	expect(history.guidance).toContain("use fresh host next for remaining work");
});

it("bounds the entire injected history, counts every omission, and redacts credentials in review reasons", async () => {
	const options = fixture();
	for (let index = 0; index < 25; index++) {
		const record = candidate(`cand-${String(index).padStart(2, "0")}`);
		const rejected = record.events.at(-1)!;
		if (rejected.type === "rejected") rejected.decision.reason = `api_key=sk-abcdefghijklmno ${"long reason ".repeat(100)}`;
		save(options.runsRoot, record);
	}
	const turn = await builder(options);
	const history = memory(await turn());
	expect(history.attempts.length).toBeLessThanOrEqual(8);
	expect(history.attempts.length + history.omitted).toBe(25);
	expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThanOrEqual(MAX_AUTHORING_HISTORY_BYTES);
	expect(JSON.stringify(history)).not.toContain("sk-abcdefghijklmno");
	expect(history.attempts[0]?.candidateId).toBe("cand-24");
	expect(compileExperimentHistory({ runsRoot: options.runsRoot, limit: 1000 }).attempts).toHaveLength(20);
	expect(() => compactExperimentHistory({ attempts: [], omitted: 0, unreadable: 0 }, { limit: NaN })).toThrow("finite");
	expect(() => compactExperimentHistory({ attempts: [], omitted: 0, unreadable: 0 }, { maxBytes: Infinity })).toThrow("finite");
});

it("keeps conversational retry guidance honest without growing the persona budget", () => {
	const persona = readFileSync(new URL("../builders/ahde/AGENTS.md", import.meta.url), "utf8");
	expect(persona).toContain("Before retrying, cite the prior candidate");
	expect(persona).toContain("Rejected is an operator decision, not proven ineffectiveness");
	expect(persona).toContain("leaves the effect unresolved");
	expect(persona).not.toContain("A tie is a discard");
	expect(persona).not.toContain("Never re-propose the same files for the same failure mode after a loss");
	expect(persona.trimEnd().split("\n").length).toBeLessThanOrEqual(300);
});

it.each(CORPUS_INVENTORY_FAULTS)("withholds unclassified evals and pre-turn memory after %s", async (fault) => {
	const options = fixture();
	const evidence = writeExplorerFixture();
	roots.push(evidence.runsRoot);
	options.runsRoot = evidence.runsRoot;
	// An older index without a visibility tag needs the complete corpus inventory.
	const indexPath = join(evidence.runsRoot, evidence.baselineEvalRunId, "eval_run.json");
	const index = JSON.parse(readFileSync(indexPath, "utf8"));
	delete index.evidenceVisibility;
	writeFileSync(indexPath, JSON.stringify(index));
	const corpus = createCorpus({
		...options, name: "private-context-corpus", visibility: "sealed",
		tasks: [{ id: "private-context-task", input: "private-context-input",
			graders: [{ type: "output_contains", text: "private-context-answer" }] }],
	});
	save(options.runsRoot, candidate("cand-context-memory"));
	const turn = await builder(options);
	expect(memory(await turn()).attempts.map((attempt) => attempt.candidateId)).toContain("cand-context-memory");
	// With no Target loaded, status still reports public evidence from this store.
	const statusOptions = { ...options, projectDir: evidence.runsRoot };
	expect(buildProjectStatus(statusOptions)).toMatchObject({
		evalRuns: expect.arrayContaining([expect.objectContaining({ evalRunId: evidence.baselineEvalRunId })]),
	});
	const restore = damageCorpusInventory({ ...options, corpusId: corpus.id }, fault);
	const load = vi.spyOn(evals, "loadEvalRun");
	try {
		const status = buildProjectStatus(statusOptions);
		expect.soft(status).toMatchObject({ evalRuns: [], warnings: expect.arrayContaining([
			"evals: evidence metadata unavailable; sealed identities remain hidden",
		]) });
		const prompt = await turn();
		expect.soft(prompt).toContain("Current Workbench state could not be read");
		expect.soft(load).not.toHaveBeenCalled();
		for (const forbidden of [corpus.id, corpus.hash, "private-context-", SEALED_SENTINEL,
			evidence.baselineEvalRunId, evidence.sealedEvalRunId, "cand-context-memory", "Prior experiments ("]) {
			expect.soft(prompt).not.toContain(forbidden);
			if (forbidden !== "cand-context-memory") expect.soft(JSON.stringify(status)).not.toContain(forbidden);
		}
	} finally {
		restore();
	}
});

it("treats a genuinely missing corpus store as a cold start without creating it", async () => {
	const options = fixture();
	const evidence = writeExplorerFixture();
	roots.push(evidence.runsRoot);
	options.runsRoot = evidence.runsRoot;
	const indexPath = join(evidence.runsRoot, evidence.baselineEvalRunId, "eval_run.json");
	const index = JSON.parse(readFileSync(indexPath, "utf8"));
	delete index.evidenceVisibility;
	writeFileSync(indexPath, JSON.stringify(index));
	const status = buildProjectStatus({ ...options, projectDir: evidence.runsRoot });
	expect(status).toMatchObject({
		corpora: { development: [], sealed: { count: 0 } },
		evalRuns: expect.arrayContaining([expect.objectContaining({ evalRunId: evidence.baselineEvalRunId })]),
	});
	expect(status.warnings).not.toContain("evals: evidence metadata unavailable; sealed identities remain hidden");
	expect(JSON.stringify(status)).not.toContain(SEALED_SENTINEL);
	expect(existsSync(options.stateRoot)).toBe(false);
	const turn = await builder(options);
	expect(memory(await turn()).attempts).toEqual([]);
	expect(existsSync(join(options.stateRoot, "projects", options.projectId, "corpora"))).toBe(false);
});
