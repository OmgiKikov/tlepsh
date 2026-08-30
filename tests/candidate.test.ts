import { describe, expect, it } from "vitest";
import {
	CandidateRecordSchema,
	CandidateTransitionError,
	candidateStatus,
	createCandidate,
	transitionCandidate,
	type CandidateRecord,
	type CandidateTransition,
	type EvaluationEvidence,
} from "../src/domain/candidate.js";

const BASE_SHA = "1".repeat(40);
const CANDIDATE_SHA = "2".repeat(40);
const DESIGN_HASH = `sha256:${"a".repeat(64)}`;
const ARTIFACT_HASH = `sha256:${"b".repeat(64)}`;

const human = (id = "alice") => ({ kind: "human" as const, id });
const system = { kind: "system" as const, id: "candidate-experiment" };

function create(mode: "candidate" | "aa-calibration" = "candidate"): CandidateRecord {
	return createCandidate({
		candidateId: "candidate-1",
		projectId: "project-1",
		targetId: "target-1",
		specId: "spec-reviewed-1",
		proposalId: "proposal-1",
		diagnosisId: "diagnosis-1",
		mode,
		baseline: { ref: "refs/heads/main", sha: BASE_SHA },
		eventId: "event-proposed",
		at: "2026-08-26T10:00:00.000Z",
		actor: { kind: "builder", id: "builder-1" },
	});
}

function createApplied(): CandidateRecord {
	return createCandidate({
		candidateId: "candidate-applied",
		projectId: "project-1",
		targetId: "target-1",
		specId: "spec-reviewed-1",
		proposalId: "builder-1",
		diagnosisId: "diagnosis-1",
		origin: {
			kind: "applied-builder",
			builderRunId: "builder-1",
			builderRun: { path: "/evidence/builder_run.json", sha256: ARTIFACT_HASH },
			builderInput: { path: "/evidence/builder_input.txt", sha256: ARTIFACT_HASH },
			proposal: { path: "/evidence/proposal.json", sha256: ARTIFACT_HASH },
			applyReceipt: { path: "/evidence/apply_receipt.json", sha256: ARTIFACT_HASH },
			application: {
				actor: human("receipt-owner"),
				reason: "Explicitly approved apply",
				appliedAt: "2026-08-26T10:00:30.000Z",
				baseTargetSha: BASE_SHA,
				candidateSha: CANDIDATE_SHA,
				proposalSha256: ARTIFACT_HASH,
			},
			source: {
				evalRunId: "eval-source",
				evalRun: { path: "/evidence/eval_run.json", sha256: ARTIFACT_HASH },
				diagnosisId: "diagnosis-1",
				diagnosis: { path: "/evidence/diagnosis.json", sha256: ARTIFACT_HASH },
				dataset: "development",
				datasetHash: ARTIFACT_HASH,
				suiteHash: ARTIFACT_HASH,
				developmentCorpus: null,
			},
			approvedSpec: {
				specId: "spec-reviewed-1",
				projectId: "project-1",
				specContentHash: ARTIFACT_HASH,
				snapshotHash: ARTIFACT_HASH,
				artifact: { path: "/evidence/spec.json", sha256: ARTIFACT_HASH },
			},
		},
		mode: "candidate",
		baseline: { ref: "refs/heads/main", sha: BASE_SHA },
		eventId: "applied-proposed",
		at: "2026-08-26T10:00:00.000Z",
		actor: { kind: "builder", id: "builder-1" },
	});
}

function event<T extends CandidateTransition>(value: T): T {
	return value;
}

function built(record = create(), sha = CANDIDATE_SHA): CandidateRecord {
	return transitionCandidate(
		record,
		event({
			type: "built",
			eventId: "event-built",
			at: "2026-08-26T10:01:00.000Z",
			actor: record.origin.kind === "applied-builder" ? record.origin.application.actor : human(),
			candidate: { ref: "refs/heads/candidate-1", sha },
		}),
	);
}

function validated(record = built(), sha = CANDIDATE_SHA, changedFiles = ["AGENTS.md"]): CandidateRecord {
	return transitionCandidate(
		record,
		event({
			type: "validated",
			eventId: "event-validated",
			at: "2026-08-26T10:02:00.000Z",
			actor: system,
			lineage: {
				baseline: { ref: "refs/heads/main", sha: BASE_SHA },
				candidate: { ref: "refs/heads/candidate-1", sha },
				relation: record.mode === "candidate" ? "descendant" : "same",
			},
			scope: {
				policyId: "harness-only-v1",
				baselineSha: BASE_SHA,
				candidateSha: sha,
				passed: true,
				changedFiles,
				violations: [],
			},
		}),
	);
}

function evaluation(sha = CANDIDATE_SHA, holdout = true) {
	const pair = (suffix: string, sealed = false) => ({
		baseline: {
			evalRunId: `baseline-${suffix}`,
			harness: { ref: "refs/heads/main", sha: BASE_SHA },
		},
		candidate: {
			evalRunId: `candidate-${suffix}`,
			harness: { ref: "refs/heads/candidate-1", sha },
		},
		comparison: {
			schemaVersion: 3,
			algorithmId: "exact-comparison-gate-v3",
			policyId: sealed ? "sealed-guardrail-v3" : "development-ci-v3",
			surface: sealed ? "sealed" : "development",
			comparisonHash: ARTIFACT_HASH,
			evidenceHash: ARTIFACT_HASH,
			gateHash: ARTIFACT_HASH,
			summary: {
				taskCount: 15,
				baselinePassRate: 0,
				candidatePassRate: 1,
				delta: 1,
				confidence95: { low: 1, high: 1 },
				improved: 15,
				regressed: 0,
				unchanged: 0,
			},
			design: { tasks: 15, repetitions: 2, excludedTasks: 0 },
			verdict: sealed ? "pass" : "improved",
			flags: { regressedTasks: 0, improvedTasks: 15, collapsedTasks: 0 },
			reasons: ["fixture verdict"],
		},
		...(sealed ? { corpus: { id: "sealed-corpus", hash: ARTIFACT_HASH } } : {}),
	});
	return {
		experimentId: "experiment-1",
		designHash: DESIGN_HASH,
		mode: "candidate" as const,
		development: pair("development"),
		...(holdout ? { sealedHoldout: pair("holdout", true) } : {}),
		infrastructureErrors: 0,
	};
}

function evaluated(record = validated(), evidence: EvaluationEvidence = evaluation()): CandidateRecord {
	return transitionCandidate(
		record,
		event({
			type: "evaluated",
			eventId: "event-evaluated",
			at: "2026-08-26T10:03:00.000Z",
			actor: system,
			evaluation: evidence,
		}),
	);
}

function reviewed(record = evaluated(), recommendation: "promote" | "reject" = "promote"): CandidateRecord {
	return transitionCandidate(
		record,
		event({
			type: "reviewed",
			eventId: "event-reviewed",
			at: "2026-08-26T10:04:00.000Z",
			actor: human("reviewer"),
			review: { experimentId: "experiment-1", recommendation, reason: "reviewed paired evidence" },
		}),
	);
}

describe("Candidate lifecycle", () => {
	it("keeps the reviewed specification reference through transitions", () => {
		expect(create().specId).toBe("spec-reviewed-1");
		expect(built().specId).toBe("spec-reviewed-1");
	});

	it("constructs immutable identity and an initial proposed event", () => {
		const candidate = create();

		expect(candidate.schemaVersion).toBe(1);
		expect(candidate.baseline).toEqual({ ref: "refs/heads/main", sha: BASE_SHA });
		expect(candidateStatus(candidate)).toBe("proposed");
		expect(candidate.events.map((item) => item.type)).toEqual(["proposed"]);
		expect(CandidateRecordSchema.parse(candidate)).toEqual(candidate);
	});

	it("appends the complete evidence-backed happy path without mutating prior records", () => {
		const proposed = createApplied();
		const reviewedCandidate = reviewed(evaluated(validated(built(proposed))));
		const promoted = transitionCandidate(
			reviewedCandidate,
			event({
				type: "promoted",
				eventId: "event-promoted",
				at: "2026-08-26T10:05:00.000Z",
				actor: human("owner"),
				decision: {
					experimentId: "experiment-1",
					candidate: { ref: "refs/heads/candidate-1", sha: CANDIDATE_SHA },
					tag: "v1.0.0",
					reason: "positive holdout delta; promote exact evaluated SHA",
				},
			}),
		);

		expect(proposed.events).toHaveLength(1);
		expect(promoted.events.map((item) => item.type)).toEqual([
			"proposed",
			"built",
			"validated",
			"evaluated",
			"reviewed",
			"promoted",
		]);
		expect(candidateStatus(promoted)).toBe("promoted");
	});

	it("rejects skipped, reversed, and post-terminal transitions", () => {
		const validate = event({
			type: "validated",
			eventId: "invalid-validate",
			at: "2026-08-26T10:01:00.000Z",
			actor: system,
			lineage: {
				baseline: { ref: "refs/heads/main", sha: BASE_SHA },
				candidate: { ref: "refs/heads/candidate-1", sha: CANDIDATE_SHA },
				relation: "descendant",
			},
			scope: {
				policyId: "p",
				baselineSha: BASE_SHA,
				candidateSha: CANDIDATE_SHA,
				passed: true,
				changedFiles: ["AGENTS.md"],
				violations: [],
			},
		});
		expect(() => transitionCandidate(create(), validate)).toThrow(/illegal transition proposed -> validated/);

		const rejected = transitionCandidate(
			reviewed(evaluated(validated(built(create()))), "reject"),
			event({
				type: "rejected",
				eventId: "event-rejected",
				at: "2026-08-26T10:05:00.000Z",
				actor: human("owner"),
				decision: { experimentId: "experiment-1", reason: "critical regression" },
			}),
		);
		expect(candidateStatus(rejected)).toBe("rejected");
		expect(() => transitionCandidate(rejected, validate)).toThrow(/illegal transition rejected -> validated/);
	});

	it("enforces candidate and A/A revision lineage", () => {
		expect(() => built(create(), BASE_SHA)).toThrow(/candidate mode requires a revision distinct from baseline/);
		expect(() => built(create("aa-calibration"), CANDIDATE_SHA)).toThrow(/A\/A calibration requires the same snapshot SHA/);

		const aaBuilt = built(create("aa-calibration"), BASE_SHA);
		expect(candidateStatus(aaBuilt)).toBe("built");
	});

	it("binds scope and evaluation evidence to exact revisions", () => {
		expect(() => validated(built(), "3".repeat(40))).toThrow(/scope evidence has the wrong candidate SHA/);
		expect(() => validated(built(), CANDIDATE_SHA, [])).toThrow(/candidate mode requires a non-empty scoped diff/);
		const wrongLineage = event({
			type: "validated",
			eventId: "wrong-lineage",
			at: "2026-08-26T10:02:00.000Z",
			actor: system,
			lineage: {
				baseline: { ref: "refs/heads/main", sha: BASE_SHA },
				candidate: { ref: "refs/heads/candidate-1", sha: CANDIDATE_SHA },
				relation: "same",
			},
			scope: {
				policyId: "harness-only-v1",
				baselineSha: BASE_SHA,
				candidateSha: CANDIDATE_SHA,
				passed: true,
				changedFiles: ["AGENTS.md"],
				violations: [],
			},
		});
		expect(() => transitionCandidate(built(), wrongLineage)).toThrow(/candidate mode requires descendant lineage/);

		const wrongEvaluation = evaluation("3".repeat(40));
		expect(() => evaluated(validated(), wrongEvaluation)).toThrow(/evaluation candidate does not match built revision/);
		const duplicateEvalRef = evaluation();
		duplicateEvalRef.development.candidate.evalRunId = duplicateEvalRef.development.baseline.evalRunId;
		expect(() => evaluated(validated(), duplicateEvalRef)).toThrow(/baseline and candidate must reference distinct eval runs/);
		// Infrastructure errors within the gate's budget are excluded from the
		// statistics and recorded as a count; the record still reaches evaluated.
		expect(candidateStatus(evaluated(validated(), { ...evaluation(), infrastructureErrors: 1 }))).toBe("evaluated");
	});

	it("requires explicit human actors for apply, review, and terminal decisions", () => {
		expect(() =>
			transitionCandidate(
				create(),
				{
					type: "built",
					eventId: "system-build",
					at: "2026-08-26T10:01:00.000Z",
					actor: system,
					candidate: { ref: "refs/heads/candidate-1", sha: CANDIDATE_SHA },
				} as unknown as CandidateTransition,
			),
		).toThrow(/invalid transition evidence/);

		expect(() =>
			transitionCandidate(
				evaluated(),
				{
					type: "reviewed",
					eventId: "system-review",
					at: "2026-08-26T10:04:00.000Z",
					actor: system,
					review: { experimentId: "experiment-1", recommendation: "promote", reason: "not human" },
				} as unknown as CandidateTransition,
			),
		).toThrow(/invalid transition evidence/);

		expect(() =>
			transitionCandidate(
				reviewed(),
				{
					type: "promoted",
					eventId: "system-promotion",
					at: "2026-08-26T10:05:00.000Z",
					actor: system,
					decision: {
						experimentId: "experiment-1",
						candidate: { ref: "refs/heads/candidate-1", sha: CANDIDATE_SHA },
						tag: "v1.0.0",
						reason: "not human",
					},
				} as unknown as CandidateTransition,
			),
		).toThrow(/invalid transition evidence/);
	});

	it("binds the built revision and human attribution to the exact apply receipt", () => {
		const record = createApplied();
		expect(() =>
			transitionCandidate(record, {
				type: "built",
				eventId: "misattributed-build",
				at: "2026-08-26T10:01:00.000Z",
				actor: human("another-human"),
				candidate: { ref: "refs/heads/candidate-1", sha: CANDIDATE_SHA },
			}),
		).toThrow(/built actor must be the exact apply-receipt human/);
		expect(() =>
			transitionCandidate(record, {
				type: "built",
				eventId: "wrong-revision-build",
				at: "2026-08-26T10:01:00.000Z",
				actor: human("receipt-owner"),
				candidate: { ref: "refs/heads/candidate-1", sha: "3".repeat(40) },
			}),
		).toThrow(/built revision must match the apply receipt/);
	});

	it("requires review and promotion to reference the evaluated experiment and exact SHA", () => {
		const evalRecord = evaluated();
		expect(() =>
			transitionCandidate(
				evalRecord,
				event({
					type: "reviewed",
					eventId: "bad-review",
					at: "2026-08-26T10:04:00.000Z",
					actor: human(),
					review: { experimentId: "other-experiment", recommendation: "promote", reason: "wrong" },
				}),
			),
		).toThrow(/review does not reference the evaluated experiment/);

		const reviewedCandidate = reviewed(evalRecord);
		expect(() =>
			transitionCandidate(
				reviewedCandidate,
				event({
					type: "promoted",
					eventId: "bad-promotion",
					at: "2026-08-26T10:05:00.000Z",
					actor: human(),
					decision: {
						experimentId: "experiment-1",
						candidate: { ref: "refs/heads/candidate-1", sha: "3".repeat(40) },
						tag: "v1.0.0",
						reason: "wrong SHA",
					},
				}),
			),
		).toThrow(/promotion does not target the exact evaluated candidate revision/);
	});

	it("requires sealed holdout and a promote recommendation for promotion", () => {
		const noHoldout = reviewed(evaluated(validated(), evaluation(CANDIDATE_SHA, false)));
		const promote = event({
			type: "promoted",
			eventId: "event-promoted",
			at: "2026-08-26T10:05:00.000Z",
			actor: human(),
			decision: {
				experimentId: "experiment-1",
				candidate: { ref: "refs/heads/candidate-1", sha: CANDIDATE_SHA },
				tag: "v1.0.0",
				reason: "promote",
			},
		});
		expect(() => transitionCandidate(noHoldout, promote)).toThrow(/promotion requires sealed-holdout evidence/);
		expect(() => transitionCandidate(reviewed(evaluated(), "reject"), promote)).toThrow(/human promote recommendation/);
	});

	it("never permits A/A calibration to become promotion evidence", () => {
		const aa = create("aa-calibration");
		const aaBuilt = built(aa, BASE_SHA);
		const aaValidated = validated(aaBuilt, BASE_SHA, []);
		const aaEvidence = {
			...evaluation(BASE_SHA),
			mode: "aa-calibration" as const,
			development: {
				baseline: { evalRunId: "aa-1", harness: { ref: "refs/heads/main", sha: BASE_SHA } },
				candidate: { evalRunId: "aa-2", harness: { ref: "refs/heads/candidate-1", sha: BASE_SHA } },
			},
			sealedHoldout: {
				baseline: { evalRunId: "aa-holdout-1", harness: { ref: "refs/heads/main", sha: BASE_SHA } },
				candidate: { evalRunId: "aa-holdout-2", harness: { ref: "refs/heads/candidate-1", sha: BASE_SHA } },
			},
		};
		const aaReviewed = reviewed(evaluated(aaValidated, aaEvidence));
		const promote = event({
			type: "promoted",
			eventId: "aa-promote",
			at: "2026-08-26T10:05:00.000Z",
			actor: human(),
			decision: {
				experimentId: "experiment-1",
				candidate: { ref: "refs/heads/candidate-1", sha: BASE_SHA },
				tag: "v-aa",
				reason: "must fail",
			},
		});

		expect(() => transitionCandidate(aaReviewed, promote)).toThrow(/A\/A calibration can never be promoted/);
	});

	it("validates append-only ordering and unique event ids on artifact reads", () => {
		const record = built();
		const tamperedOrder = {
			...record,
			events: [record.events[1], record.events[0]],
		};
		expect(() => CandidateRecordSchema.parse(tamperedOrder)).toThrow(/first candidate event must be proposed/);

		const duplicateId = {
			...record,
			events: [record.events[0], { ...record.events[1], eventId: record.events[0]?.eventId }],
		};
		expect(() => CandidateRecordSchema.parse(duplicateId)).toThrow(/eventId must be unique/);
	});

	it("surfaces a stable domain error for transition failures", () => {
		try {
			transitionCandidate(create(), {
				type: "built",
				eventId: "bad",
				at: "not-a-time",
				actor: human(),
				candidate: { ref: "candidate", sha: CANDIDATE_SHA },
			} as CandidateTransition);
			expect.fail("expected transition to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(CandidateTransitionError);
			expect((error as Error).message).toMatch(/candidate-1.*invalid transition evidence/);
		}
	});
});
