import { describe, expect, it } from "vitest";
import { EXACT_COMPARISON_GATE_ALGORITHM_ID_V3 } from "../src/domain/comparison-gate.js";
import {
	createCandidate,
	transitionCandidate,
	type CandidateRecord,
	type ExperimentMode,
} from "../src/domain/candidate.js";
import {
	DEFAULT_REPETITIONS,
	calibrationProjection,
	recommendedRepetitions,
} from "../src/workbench/calibration.js";

const NOW = "2026-08-29T09:00:00.000Z";
const LATER = "2026-08-29T09:30:00.000Z";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const HASH = `sha256:${"c".repeat(64)}`;

interface EvidenceOptions {
	taskCount?: number;
	repetitions?: number;
	baselinePassRate?: number;
	improved?: number;
	regressed?: number;
	delta?: number;
	confidence95?: { low: number; high: number };
	verdict?: "improved" | "inconclusive" | "regressed";
}

function developmentEvidence(options: EvidenceOptions = {}) {
	const taskCount = options.taskCount ?? 30;
	const improved = options.improved ?? 2;
	const regressed = options.regressed ?? 1;
	return {
		schemaVersion: 3 as const,
		algorithmId: EXACT_COMPARISON_GATE_ALGORITHM_ID_V3,
		policyId: "development-ci-v3" as const,
		surface: "development" as const,
		comparisonHash: HASH,
		evidenceHash: HASH,
		gateHash: HASH,
		summary: {
			taskCount,
			baselinePassRate: options.baselinePassRate ?? 0.9,
			candidatePassRate: options.baselinePassRate ?? 0.9,
			delta: options.delta ?? 0,
			confidence95: options.confidence95 ?? { low: -0.06, high: 0.06 },
			improved,
			regressed,
			unchanged: taskCount - improved - regressed,
		},
		design: { tasks: taskCount, repetitions: options.repetitions ?? 3, excludedTasks: 0 },
		verdict: options.verdict ?? ("inconclusive" as const),
		flags: { regressedTasks: regressed, improvedTasks: improved, collapsedTasks: 0 },
		reasons: ["95% CI -6.0pp … +6.0pp spans zero on 30 tasks × 3 repetitions"],
	};
}

function calibrationRecord(
	options: EvidenceOptions & { mode?: ExperimentMode; comparison?: unknown } = {},
): CandidateRecord {
	const actor = { kind: "human" as const, id: "local:test-human" };
	const system = { kind: "system" as const, id: "candidate-experiment" };
	const mode = options.mode ?? "aa-calibration";
	const revision = { ref: "refs/heads/master", sha: SHA };
	const built = mode === "candidate" ? { ref: "refs/heads/candidate", sha: OTHER_SHA } : revision;
	let record = createCandidate({
		candidateId: "calibration-1",
		projectId: "proj",
		targetId: "support-bot",
		specId: "spec-1",
		proposalId: "proposal-unspecified",
		diagnosisId: null,
		origin: { kind: "manual", reason: "A/A calibration" },
		mode,
		baseline: revision,
		eventId: "calibration-1:proposed",
		at: NOW,
		actor,
	});
	record = transitionCandidate(record, {
		type: "built",
		eventId: "calibration-1:built",
		at: NOW,
		actor,
		candidate: built,
	});
	record = transitionCandidate(record, {
		type: "validated",
		eventId: "calibration-1:validated",
		at: NOW,
		actor: system,
		lineage: {
			baseline: revision,
			candidate: built,
			relation: mode === "candidate" ? "descendant" : "same",
		},
		scope: {
			policyId: "candidate-harness-resources-v2",
			baselineSha: SHA,
			candidateSha: built.sha,
			passed: true,
			changedFiles: mode === "candidate" ? ["AGENTS.md"] : [],
			violations: [],
		},
	});
	return transitionCandidate(record, {
		type: "evaluated",
		eventId: "calibration-1:evaluated",
		at: LATER,
		actor: system,
		evaluation: {
			experimentId: "calibration-1",
			designHash: HASH,
			mode,
			development: {
				corpus: { id: "corpus-1", hash: HASH },
				baseline: { evalRunId: "erun-a", harness: revision },
				candidate: { evalRunId: "erun-b", harness: built },
				comparison: "comparison" in options
					? (options.comparison as never)
					: (developmentEvidence(options) as never),
			},
			infrastructureErrors: 0,
		},
	});
}

describe("calibration projection", () => {
	it("projects an A/A record into the one line a human needs", () => {
		const projection = calibrationProjection(calibrationRecord());

		expect(projection).toEqual({
			candidateId: "calibration-1",
			targetSha: SHA,
			taskCount: 30,
			repetitions: 3,
			aaPassRate: 0.9,
			delta: 0,
			confidence95: { low: -0.06, high: 0.06 },
			flipRate: 3 / 30,
			recommendedRepetitions: 3,
			verdict: "inconclusive",
			at: LATER,
		});
	});

	it("refuses anything that is not finished A/A evidence with a verdict", () => {
		expect(calibrationProjection(calibrationRecord({ mode: "candidate" }))).toBeNull();
		expect(calibrationProjection(calibrationRecord({ comparison: null }))).toBeNull();
		// Legacy v1 evidence parses but carries no verdict, so it projects to null.
		expect(calibrationProjection(calibrationRecord({
			comparison: {
				policyId: "exact-comparison-gate-v1",
				comparisonHash: HASH,
				gateHash: HASH,
				summary: {
					taskCount: 1,
					baselinePassRate: 1,
					candidatePassRate: 1,
					delta: 0,
					confidence95: { low: 0, high: 0 },
					improved: 0,
					regressed: 0,
					unchanged: 1,
				},
			},
		}))).toBeNull();
	});

	it("recommends the cheapest design whose noise band fits inside ten points", () => {
		// 1.96·√(2·0.9·0.1/(k·30)) ≤ 0.10 first holds at k = 3.
		expect(recommendedRepetitions(0.9, 30)).toBe(3);
		// A wide basket needs no repetition; a 50/50 Target needs the whole budget.
		expect(recommendedRepetitions(0.5, 200)).toBe(1);
		expect(recommendedRepetitions(0.5, 100)).toBe(2);
		expect(recommendedRepetitions(0.3, 60)).toBe(3);
		// A deterministic Target has no variance at all: one repetition is enough.
		expect(recommendedRepetitions(1, 5)).toBe(1);
		expect(recommendedRepetitions(0, 5)).toBe(1);
		// Small, noisy baskets exhaust the cap instead of promising precision.
		expect(recommendedRepetitions(0.5, 30)).toBe(5);
		expect(recommendedRepetitions(0.5, 0)).toBe(5);
		for (const [passRate, taskCount] of [[0.5, 100], [0.7, 12], [0.3, 60], [0.9, 30]] as const) {
			const k = recommendedRepetitions(passRate, taskCount);
			const band = 1.96 * Math.sqrt((2 * passRate * (1 - passRate)) / (k * taskCount));
			expect(k === 5 || band <= 0.1).toBe(true);
			if (k > 1) {
				const previous = 1.96 * Math.sqrt((2 * passRate * (1 - passRate)) / ((k - 1) * taskCount));
				expect(previous).toBeGreaterThan(0.1);
			}
		}
	});

	it("defaults human runs to three repetitions", () => {
		expect(DEFAULT_REPETITIONS).toBe(3);
	});
});
