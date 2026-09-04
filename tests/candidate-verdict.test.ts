import { describe, expect, it } from "vitest";
import {
	candidateVerdicts,
	renderCandidateVerdictLines,
} from "../src/application/candidate-verdict.js";
import { CandidateRecordSchema, type CandidateRecord } from "../src/domain/candidate.js";

/**
 * The two lines `ahde candidate` prints, and the only two an agent may quote
 * for the ship gate. The sealed guardrail decides whether a candidate may ship,
 * so it has to be sayable — but a sealed line may carry a verdict and a design
 * size and nothing that identifies the exam.
 */

const SHA_A = "1".repeat(40);
const SHA_B = "2".repeat(40);
const REV_A = { ref: "main", sha: SHA_A };
const REV_B = { ref: "candidate/fixture", sha: SHA_B };
const FINGERPRINT = `sha256:${"e".repeat(64)}`;
const AT = "2026-08-20T10:00:00.000Z";

const SEALED_CORPUS_ID = "sealed-corpus-secret";
const SEALED_TASK_ID = "PRIVATE HOLDOUT TASK";

function gate(options: {
	surface: "development" | "sealed";
	verdict: string;
	scoreDelta: number;
	tasks: number;
	repetitions: number;
	reasons: string[];
	confidence95?: { low: number; high: number } | null;
}) {
	return {
		schemaVersion: 4,
		algorithmId: "exact-comparison-gate-v4",
		policyId: options.surface === "sealed" ? "sealed-guardrail-v4" : "development-ci-v4",
		surface: options.surface,
		comparisonHash: `sha256:${"a".repeat(64)}`,
		evidenceHash: `sha256:${"b".repeat(64)}`,
		gateHash: `sha256:${"c".repeat(64)}`,
		summary: {
			taskCount: options.tasks,
			baselinePassRate: 0,
			candidatePassRate: 1,
			delta: options.scoreDelta,
			baselineScore: 0,
			candidateScore: options.scoreDelta,
			scoreDelta: options.scoreDelta,
			...(options.confidence95 === undefined
				? { confidence95: { low: options.scoreDelta - 0.1, high: options.scoreDelta } }
				: options.confidence95 === null ? {} : { confidence95: options.confidence95 }),
			improved: options.tasks,
			regressed: 0,
			unchanged: 0,
		},
		design: { tasks: options.tasks, repetitions: options.repetitions, excludedTasks: 0 },
		verdict: options.verdict,
		flags: { regressedTasks: 0, improvedTasks: options.tasks, collapsedTasks: 0 },
		reasons: options.reasons,
		resources: {
			baseline: { runs: options.tasks, costUsd: 0.1, meanLatencyMs: 100, meanTokens: 10 },
			candidate: { runs: options.tasks, costUsd: 0.1, meanLatencyMs: 100, meanTokens: 10 },
			costRatio: 1,
			latencyRatio: 1,
			tokenRatio: 1,
		},
	};
}

/** An evaluated candidate record, with or without the sealed arm. */
function evaluatedRecord(sealed: boolean): CandidateRecord {
	return CandidateRecordSchema.parse({
		schemaVersion: 1,
		candidateId: "candidate-verdict-1",
		projectId: "project-1",
		targetId: "agent-1",
		specId: null,
		proposalId: "proposal-1",
		diagnosisId: null,
		origin: { kind: "manual", reason: "fixture candidate" },
		mode: "candidate",
		baseline: REV_A,
		createdAt: AT,
		events: [
			{ type: "proposed", eventId: "e1", at: AT, actor: { kind: "builder", id: "builder" } },
			{ type: "built", eventId: "e2", at: AT, actor: { kind: "human", id: "local:test" }, candidate: REV_B },
			{
				type: "validated",
				eventId: "e2b",
				at: AT,
				actor: { kind: "system", id: "validator" },
				lineage: { baseline: REV_A, candidate: REV_B, relation: "descendant" },
				scope: {
					policyId: "harness-scope-v1",
					baselineSha: SHA_A,
					candidateSha: SHA_B,
					passed: true,
					changedFiles: ["AGENTS.md"],
					violations: [],
				},
			},
			{
				type: "evaluated",
				eventId: "e3",
				at: AT,
				actor: { kind: "system", id: "evaluator" },
				evaluation: {
					experimentId: "exp-1",
					designHash: `sha256:${"d".repeat(64)}`,
					mode: "candidate",
					development: {
						baseline: { evalRunId: "erun_base", harness: REV_A },
						candidate: { evalRunId: "erun_cand", harness: REV_B },
						comparison: gate({
							surface: "development",
							verdict: "improved",
							scoreDelta: 1,
							tasks: 2,
							repetitions: 2,
							reasons: ["improved on 2 tasks × 2 repetitions"],
						}),
					},
					...(sealed
						? {
							sealedHoldout: {
								baseline: { evalRunId: "erun_sealed_base", harness: REV_A },
								candidate: { evalRunId: "erun_sealed_cand", harness: REV_B },
								corpus: { id: SEALED_CORPUS_ID, hash: FINGERPRINT },
								comparison: gate({
									surface: "sealed",
									verdict: "pass",
									scoreDelta: 0.4,
									tasks: 15,
									repetitions: 2,
									reasons: ["no regression: 0 of 15 tasks regressed"],
								}),
							},
						}
						: {}),
					infrastructureErrors: 0,
				},
			},
		],
	});
}

describe("renderCandidateVerdictLines", () => {
	it("says both verdicts with their design, and the gate's own first reason", () => {
		const lines = renderCandidateVerdictLines(evaluatedRecord(true));
		expect(lines).toEqual([
			// The unit belongs to the delta the interval brackets, and is printed
			// once: `+100.0pp (95% CI +90.0pp … +100.0pp)` said "points" three
			// times about one measurement.
			"development verdict: improved +100.0pp (95% CI +90.0 … +100.0) on 2 tasks × 2 repetitions",
			"sealed guardrail: pass · improved on 15 tasks × 2 repetitions — no regression: 0 of 15 tasks regressed",
		]);
	});

	it("never lets the sealed line carry the exam's identity or its content", () => {
		for (const line of renderCandidateVerdictLines(evaluatedRecord(true))) {
			expect(line).not.toContain(SEALED_CORPUS_ID);
			expect(line).not.toContain(SEALED_TASK_ID);
			expect(line).not.toContain(FINGERPRINT);
		}
	});

	it("says promotion stays locked when the sealed arm was never run", () => {
		const record = evaluatedRecord(false);
		expect(candidateVerdicts(record).sealed).toBeNull();
		expect(renderCandidateVerdictLines(record)[1]).toBe(
			"sealed guardrail: not run (promotion stays locked)",
		);
	});

	it("reports an unevaluated candidate as having no verdict rather than inventing one", () => {
		const record = evaluatedRecord(true);
		const unevaluated = { ...record, events: record.events.filter((event) => event.type !== "evaluated") };
		expect(candidateVerdicts(unevaluated)).toEqual({ development: null, sealed: null });
		expect(renderCandidateVerdictLines(unevaluated)).toEqual([
			"development verdict: none recorded",
			"sealed guardrail: not run (promotion stays locked)",
		]);
	});
});
