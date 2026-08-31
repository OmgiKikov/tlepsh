import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	compactExperimentHistory,
	compileExperimentHistory,
	experimentSignature,
	losingExperimentSignatures,
	MAX_AUTHORING_HISTORY_ATTEMPTS,
	MAX_HISTORY_ATTEMPTS,
	renderExperimentHistory,
} from "../src/application/experiment-history.js";

/**
 * The proposer's memory. Every fact here is already durable on disk; the point
 * of these tests is that reading it back stays bounded, ordered, and silent
 * about sealed content.
 */

const paths: string[] = [];

afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function runsRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "ahde-history-"));
	paths.push(root);
	mkdirSync(join(root, "candidates"), { recursive: true });
	return root;
}

const SHA_A = "1".repeat(40);
const SHA_B = "2".repeat(40);
const REV_A = { ref: "main", sha: SHA_A };
const REV_B = { ref: "candidate/fixture", sha: SHA_B };

const FINGERPRINT = `sha256:${"e".repeat(64)}`;
const artifact = (path: string) => ({ path, sha256: FINGERPRINT });

/**
 * A promotion is only legal on a candidate with a reconstructable
 * applied-Builder chain (invariant 14), so a promoted fixture must carry one.
 */
function appliedBuilderOrigin(id: string, at: string, projectId: string) {
	return {
		kind: "applied-builder" as const,
		builderRunId: `${id}-proposal`,
		builderRun: artifact(`builders/${id}/run.json`),
		builderInput: artifact(`builders/${id}/input.json`),
		proposal: artifact(`builders/${id}/proposal.json`),
		applyReceipt: artifact(`builders/${id}/apply.json`),
		application: {
			actor: { kind: "human" as const, id: "local:test" },
			reason: "apply the reviewed proposal",
			appliedAt: at,
			baseTargetSha: SHA_A,
			candidateSha: SHA_B,
			proposalSha256: FINGERPRINT,
		},
		source: {
			evalRunId: "erun_source",
			evalRun: artifact("erun_source/eval_run.json"),
			diagnosisId: `${id}-diagnosis`,
			diagnosis: artifact("erun_source/diagnosis.json"),
			dataset: "development",
			datasetHash: FINGERPRINT,
			suiteHash: FINGERPRINT,
			developmentCorpus: null,
		},
		approvedSpec: {
			specId: `${id}-spec`,
			projectId,
			specContentHash: FINGERPRINT,
			snapshotHash: FINGERPRINT,
			artifact: artifact(`specs/${id}-spec.json`),
		},
	};
}

function gate(surface: "development" | "sealed", verdict: string, scoreDelta: number, tasks: number) {
	return {
		schemaVersion: 4,
		algorithmId: "exact-comparison-gate-v4",
		policyId: surface === "sealed" ? "sealed-guardrail-v4" : "development-ci-v4",
		surface,
		comparisonHash: `sha256:${"a".repeat(64)}`,
		evidenceHash: `sha256:${"b".repeat(64)}`,
		gateHash: `sha256:${"c".repeat(64)}`,
		summary: {
			taskCount: tasks,
			baselinePassRate: 0.4,
			candidatePassRate: 0.9,
			delta: 0.5,
			baselineScore: 0.4,
			candidateScore: 0.4 + scoreDelta,
			scoreDelta,
			confidence95: { low: scoreDelta - 0.1, high: scoreDelta + 0.1 },
			improved: tasks,
			regressed: 0,
			unchanged: 0,
		},
		design: { tasks, repetitions: 3, excludedTasks: 0 },
		verdict,
		flags: { regressedTasks: 0, improvedTasks: tasks, collapsedTasks: 0 },
		reasons: [`${verdict} on ${tasks} tasks × 3 repetitions`],
		resources: {
			baseline: { runs: tasks * 3, costUsd: 0.1, meanLatencyMs: 100, meanTokens: 10 },
			candidate: { runs: tasks * 3, costUsd: 0.1, meanLatencyMs: 100, meanTokens: 10 },
			costRatio: 1,
			latencyRatio: 1,
			tokenRatio: 1,
		},
	};
}

function writeCandidate(root: string, id: string, options: {
	at: string;
	targetId?: string;
	projectId?: string;
	outcome: "promoted" | "rejected" | "evaluated";
	scoreDelta?: number;
	sealedVerdict?: string;
	reason?: string;
	changedFiles?: string[];
}): void {
	const at = options.at;
	const events: unknown[] = [
		{ type: "proposed", eventId: `${id}-1`, at, actor: { kind: "builder", id: "builder" } },
		{ type: "built", eventId: `${id}-2`, at, actor: { kind: "human", id: "local:test" }, candidate: REV_B },
		{
			type: "validated",
			eventId: `${id}-2b`,
			at,
			actor: { kind: "system", id: "validator" },
			lineage: { baseline: REV_A, candidate: REV_B, relation: "descendant" },
			scope: {
				policyId: "harness-scope-v1",
				baselineSha: SHA_A,
				candidateSha: SHA_B,
				passed: true,
				changedFiles: options.changedFiles ?? ["AGENTS.md", "skills/check-dbo/SKILL.md"],
				violations: [],
			},
		},
		{
			type: "evaluated",
			eventId: `${id}-3`,
			at,
			actor: { kind: "system", id: "evaluator" },
			evaluation: {
				experimentId: `${id}-exp`,
				designHash: `sha256:${"d".repeat(64)}`,
				mode: "candidate",
				development: {
					baseline: { evalRunId: "erun_base", harness: REV_A },
					candidate: { evalRunId: "erun_cand", harness: REV_B },
					comparison: gate("development", "improved", options.scoreDelta ?? 0.5, 30),
				},
				...(options.sealedVerdict
					? {
						sealedHoldout: {
							baseline: { evalRunId: "erun_sealed_base", harness: REV_A },
							candidate: { evalRunId: "erun_sealed_cand", harness: REV_B },
							// An applied-Builder holdout must name its exact corpus; the
							// projection must still refuse to pass that identity on.
							corpus: { id: "sealed-corpus-1", hash: FINGERPRINT },
							comparison: gate("sealed", options.sealedVerdict, 0.4, 15),
						},
					}
					: {}),
				infrastructureErrors: 0,
			},
		},
	];
	if (options.outcome === "promoted") {
		events.push({
			type: "reviewed",
			eventId: `${id}-4`,
			at,
			actor: { kind: "human", id: "local:test" },
			review: { experimentId: `${id}-exp`, recommendation: "promote", reason: options.reason ?? "ship it" },
		});
		events.push({
			type: "promoted",
			eventId: `${id}-5`,
			at,
			actor: { kind: "human", id: "local:test" },
			decision: { experimentId: `${id}-exp`, candidate: REV_B, tag: "v0.2.0", reason: options.reason ?? "ship it" },
		});
	}
	if (options.outcome === "rejected") {
		events.push({
			type: "reviewed",
			eventId: `${id}-4`,
			at,
			actor: { kind: "human", id: "local:test" },
			review: { experimentId: `${id}-exp`, recommendation: "reject", reason: options.reason ?? "too slow" },
		});
		events.push({
			type: "rejected",
			eventId: `${id}-5`,
			at,
			actor: { kind: "human", id: "local:test" },
			decision: { experimentId: `${id}-exp`, reason: options.reason ?? "too slow" },
		});
	}
	const projectId = options.projectId ?? "project-1";
	const promoted = options.outcome === "promoted";
	const record = {
		schemaVersion: 1,
		candidateId: id,
		projectId,
		targetId: options.targetId ?? "agent-1",
		specId: promoted ? `${id}-spec` : null,
		proposalId: `${id}-proposal`,
		diagnosisId: promoted ? `${id}-diagnosis` : null,
		origin: promoted
			? appliedBuilderOrigin(id, at, projectId)
			: { kind: "manual", reason: "fixture candidate" },
		mode: "candidate",
		baseline: REV_A,
		createdAt: at,
		events,
	};
	const dir = join(root, "candidates", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "candidate.json"), `${JSON.stringify(record, null, "\t")}\n`);
}

it("answers what was already tried, newest first, with the human's own words", () => {
	const root = runsRoot();
	writeCandidate(root, "cand-old", { at: "2026-08-01T10:00:00.000Z", outcome: "rejected", reason: "3× the cost for +2pp" });
	writeCandidate(root, "cand-new", { at: "2026-08-20T10:00:00.000Z", outcome: "promoted", scoreDelta: 0.56, sealedVerdict: "pass", reason: "big win on tool calls" });

	const history = compileExperimentHistory({ runsRoot: root, targetId: "agent-1" });

	expect(history.attempts.map((attempt) => attempt.candidateId)).toEqual(["cand-new", "cand-old"]);
	expect(history.attempts[0]).toMatchObject({
		outcome: "promoted",
		baseline: SHA_A.slice(0, 12),
		candidate: SHA_B.slice(0, 12),
		reason: "big win on tool calls",
	});
	expect(history.attempts[0]?.development).toMatchObject({ verdict: "improved", scoreDelta: 0.56, tasks: 30, repetitions: 3 });
	// What changed comes from the scope validation the host enforced, not a guess.
	expect(history.attempts[0]?.changedPaths).toEqual(["AGENTS.md", "skills/check-dbo/SKILL.md"]);
	expect(history.attempts[1]).toMatchObject({ outcome: "rejected", reason: "3× the cost for +2pp" });
	expect(history.omitted).toBe(0);
	expect(history.unreadable).toBe(0);
});

it("carries the sealed verdict and its size, and nothing else about the sealed set", () => {
	const root = runsRoot();
	writeCandidate(root, "cand-1", { at: "2026-08-20T10:00:00.000Z", outcome: "promoted", sealedVerdict: "pass" });

	const history = compileExperimentHistory({ runsRoot: root });
	const sealed = history.attempts[0]?.sealed;

	expect(sealed).toEqual({ verdict: "pass", scoreDelta: 0.4, confidence95: { low: 0.30000000000000004, high: 0.5 }, tasks: 15, repetitions: 3 });
	// The projection is Builder-visible: no ids, no corpus identity, no content.
	const serialized = JSON.stringify(history);
	expect(serialized).not.toContain("erun_sealed_base");
	expect(serialized).not.toContain("erun_sealed_cand");
	expect(serialized).not.toContain("sha256:");
	expect(serialized).not.toContain("candidate/fixture");
	expect(serialized).not.toContain("sealed-corpus-1");
});

it("separates Targets and projects, and counts what it could not read", () => {
	const root = runsRoot();
	writeCandidate(root, "cand-mine", { at: "2026-08-20T10:00:00.000Z", outcome: "evaluated" });
	writeCandidate(root, "cand-other-target", { at: "2026-08-21T10:00:00.000Z", outcome: "evaluated", targetId: "agent-2" });
	writeCandidate(root, "cand-other-project", { at: "2026-08-22T10:00:00.000Z", outcome: "evaluated", projectId: "project-2" });
	mkdirSync(join(root, "candidates", "cand-broken"), { recursive: true });
	writeFileSync(join(root, "candidates", "cand-broken", "candidate.json"), "{ not json");

	const mine = compileExperimentHistory({ runsRoot: root, targetId: "agent-1", projectId: "project-1" });

	expect(mine.attempts.map((attempt) => attempt.candidateId)).toEqual(["cand-mine"]);
	expect(mine.unreadable).toBe(1);
});

it("caps a long project and says how much it left out", () => {
	const root = runsRoot();
	for (let index = 0; index < MAX_HISTORY_ATTEMPTS + 5; index += 1) {
		const day = String(index + 1).padStart(2, "0");
		writeCandidate(root, `cand-${day}`, { at: `2026-08-${day}T10:00:00.000Z`, outcome: "evaluated" });
	}

	const history = compileExperimentHistory({ runsRoot: root, limit: 5 });

	expect(history.attempts).toHaveLength(5);
	expect(history.omitted).toBe(MAX_HISTORY_ATTEMPTS);
	expect(renderExperimentHistory(history).at(-1)).toBe(`… and ${MAX_HISTORY_ATTEMPTS} earlier attempts`);
});

it("leaves the targeted failure modes empty when the Builder run cannot be read", () => {
	const root = runsRoot();
	// The promoted fixture carries an applied-Builder origin whose Builder run
	// was never written. Memory is an aid: one pruned run narrows a row, it does
	// not make the memory unreadable.
	writeCandidate(root, "cand-1", { at: "2026-08-20T10:00:00.000Z", outcome: "promoted", sealedVerdict: "pass" });

	const history = compileExperimentHistory({ runsRoot: root });

	expect(history.attempts[0]?.candidateId).toBe("cand-1");
	expect(history.attempts[0]?.failureModeIds).toEqual([]);
	expect(history.unreadable).toBe(0);
});

it("compacts to the newest attempts that fit, and counts every one it dropped", () => {
	const root = runsRoot();
	for (let index = 0; index < MAX_AUTHORING_HISTORY_ATTEMPTS + 4; index += 1) {
		const day = String(index + 1).padStart(2, "0");
		writeCandidate(root, `cand-${day}`, {
			at: `2026-08-${day}T10:00:00.000Z`,
			outcome: "rejected",
			reason: `attempt ${day} cost too much`,
		});
	}
	const history = compileExperimentHistory({ runsRoot: root });
	expect(history.attempts).toHaveLength(MAX_AUTHORING_HISTORY_ATTEMPTS + 4);

	const compact = compactExperimentHistory(history);

	expect(compact.attempts).toHaveLength(MAX_AUTHORING_HISTORY_ATTEMPTS);
	// Newest first, and the four that did not fit are counted, never dropped
	// silently: a Builder shown eight of twelve is told it is eight of twelve.
	expect(compact.attempts[0]?.at).toBe("2026-08-12T10:00:00.000Z");
	expect(compact.omitted).toBe(4);
	expect(compact.attempts[0]).toMatchObject({
		outcome: "rejected",
		development: "improved +50.0pp",
		reason: "attempt 12 cost too much",
		changedPaths: ["AGENTS.md", "skills/check-dbo/SKILL.md"],
	});
	// A byte budget bites before the count does, and says so the same way.
	const tiny = compactExperimentHistory(history, { maxBytes: 400 });
	expect(tiny.attempts.length).toBeLessThan(MAX_AUTHORING_HISTORY_ATTEMPTS);
	expect(tiny.omitted).toBe(history.attempts.length - tiny.attempts.length);
	expect(JSON.stringify(tiny)).not.toContain("sha256:");
	// Nothing at all still fits, and still reports honestly.
	const none = compactExperimentHistory(history, { maxBytes: 0 });
	expect(none.attempts).toEqual([]);
	expect(none.omitted).toBe(history.attempts.length);
});

it("recognises a losing experiment by its changed files and the mode it aimed at", () => {
	const attempt = (overrides: Record<string, unknown>) => ({
		candidateId: "c",
		at: "2026-08-20T10:00:00.000Z",
		baseline: "abc",
		candidate: "def",
		mode: "candidate",
		changedPaths: ["AGENTS.md"],
		failureModeIds: [`failure-mode-${"a".repeat(24)}`],
		development: { verdict: "improved", scoreDelta: 0.5, confidence95: null, tasks: 4, repetitions: 3 },
		sealed: null,
		outcome: "evaluated",
		reason: null,
		...overrides,
	});
	const history = {
		attempts: [
			// Improved and never rejected: still a live answer, not a dead end.
			attempt({}),
			// Rejected by a human even though the numbers moved.
			attempt({ candidateId: "c2", outcome: "rejected", changedPaths: ["skills/a/SKILL.md"] }),
			// Measured and did not improve.
			attempt({
				candidateId: "c3",
				changedPaths: ["bin/tool"],
				development: { verdict: "inconclusive", scoreDelta: 0, confidence95: null, tasks: 4, repetitions: 3 },
			}),
			// Lost, but nobody recorded what it changed: nothing to recognise.
			attempt({ candidateId: "c4", outcome: "rejected", changedPaths: [] }),
		],
		omitted: 0,
		unreadable: 0,
	} as unknown as Parameters<typeof losingExperimentSignatures>[0];

	const losing = losingExperimentSignatures(history);
	const mode = `failure-mode-${"a".repeat(24)}`;

	expect(losing.has(experimentSignature(["skills/a/SKILL.md"], mode))).toBe(true);
	expect(losing.has(experimentSignature(["bin/tool"], mode))).toBe(true);
	expect(losing.has(experimentSignature(["AGENTS.md"], mode))).toBe(false);
	expect(losing.size).toBe(2);
	// Path order is not part of the identity; the failure mode is.
	expect(experimentSignature(["b", "a"], mode)).toBe(experimentSignature(["a", "b"], mode));
	expect(losing.has(experimentSignature(["skills/a/SKILL.md"], `failure-mode-${"b".repeat(24)}`))).toBe(false);
});

it("renders one readable line per attempt and says so when there is nothing yet", () => {
	const root = runsRoot();
	expect(renderExperimentHistory(compileExperimentHistory({ runsRoot: root }))).toEqual([
		"No earlier attempts on this Target.",
	]);

	writeCandidate(root, "cand-1", { at: "2026-08-20T10:00:00.000Z", outcome: "rejected", scoreDelta: -0.1, reason: "regressed the refund flow" });
	const lines = renderExperimentHistory(compileExperimentHistory({ runsRoot: root }));

	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain("rejected");
	expect(lines[0]).toContain("improved -10.0pp");
	expect(lines[0]).toContain("“regressed the refund flow”");
});
