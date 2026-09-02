import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CANDIDATE_PROPOSAL_SCHEMA_VERSION,
	CandidateProposalSchema,
	ProposalPredictionSchema,
	type CandidateProposal,
	type ProposalPrediction,
} from "../src/builders/adapters.js";
import { compileAgentLog } from "../src/application/agent-log.js";
import type { CandidateImpact, TargetedModeImpact } from "../src/application/candidate-impact.js";
import { compileExperimentHistory } from "../src/application/experiment-history.js";
import {
	assertPredictionScope,
	calibrationStrip,
	compilePredictionCalibration,
	measurementOf,
	predictedVersusActual,
	scorePredictedModes,
	scorePredictedOverall,
	scorePrediction,
} from "../src/application/prediction.js";
import { compileVersionPassport } from "../src/application/version-passport.js";
import { renderAgentLog } from "../src/builder/render/agent-log.js";
import { renderConfirmation } from "../src/builder/render/confirmation.js";
import { renderImpact } from "../src/builder/render/impact.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { renderVersionPassport } from "../src/builder/render/passport.js";
import { renderReview } from "../src/builder/render/view.js";
import { setLanguage } from "../src/i18n.js";
import { canonicalJson, hashValue } from "../src/provenance.js";
import type { WorkbenchConfirmation, WorkbenchReviewDetail } from "../src/workbench/types.js";

/**
 * Predicted impact.
 *
 * The point of this lane is one sentence the Builder can be held to: "mode X
 * 26/26 → ≤3/26, overall +40 points". These tests pin the contract that
 * carries it, the refusals that keep it about this proposal, the arithmetic
 * that scores it, and the exact lines an operator reads in both languages.
 */

const SHA_A = "1".repeat(40);
const SHA_B = "2".repeat(40);
const HASH = `sha256:${"a".repeat(64)}`;
const MODE_A = `failure-mode-${"a".repeat(24)}`;
const MODE_B = `failure-mode-${"b".repeat(24)}`;

const paths: string[] = [];

afterEach(() => {
	setLanguage(null);
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const DIFF = [
	"diff --git a/AGENTS.md b/AGENTS.md",
	"index 1111111..2222222 100644",
	"--- a/AGENTS.md",
	"+++ b/AGENTS.md",
	"@@ -1,2 +1,3 @@",
	" Existing line",
	"-Old guidance",
	"+Use the lookup tool first",
	"",
].join("\n");

function prediction(overrides: Partial<ProposalPrediction> = {}): ProposalPrediction {
	return ProposalPredictionSchema.parse({
		modes: [{ failureModeId: MODE_A, expectedFailingTasks: 3, ofTasks: 26 }],
		expectedScoreDeltaPp: 40,
		...overrides,
	});
}

function proposalValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: CANDIDATE_PROPOSAL_SCHEMA_VERSION,
		decision: "propose",
		baseTargetSha: SHA_A,
		summary: "Tell the agent to call lookup before answering.",
		diagnoses: [],
		changes: [{
			path: "AGENTS.md",
			baseSha256: HASH,
			unifiedDiff: DIFF,
			rationale: "Change AGENTS.md",
			evidenceRefs: [],
		}],
		risks: [],
		validationPlan: ["Re-run the development basket"],
		...overrides,
	};
}

// ---------------------------------------------------------------------------

describe("the contract", () => {
	it("carries the prediction, and reads a pre-v2 proposal as promising nothing", () => {
		const withPrediction = CandidateProposalSchema.parse(proposalValue({ prediction: prediction() }));
		expect(withPrediction.prediction).toEqual({
			modes: [{ failureModeId: MODE_A, expectedFailingTasks: 3, ofTasks: 26 }],
			expectedPassRateDeltaPp: null,
			expectedScoreDeltaPp: 40,
			note: null,
		});
		// The exact JSON an old run wrote, without the field at all.
		const legacy = CandidateProposalSchema.parse(proposalValue({ schemaVersion: 1 }));
		expect(legacy.prediction).toBeNull();
		// Round-trips through the durable form unchanged, both ways.
		expect(CandidateProposalSchema.parse(JSON.parse(JSON.stringify(withPrediction)))).toEqual(withPrediction);
		expect(CandidateProposalSchema.parse(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);
	});

	it("refuses a promise that is not arithmetic", () => {
		const refuse = (value: Record<string, unknown>): string =>
			CandidateProposalSchema.safeParse(proposalValue({ prediction: value })).error?.issues
				.map((issue) => issue.message).join(" | ") ?? "accepted";

		expect(refuse({ modes: [{ failureModeId: MODE_A, expectedFailingTasks: 27, ofTasks: 26 }] }))
			.toContain("expectedFailingTasks cannot exceed ofTasks");
		expect(refuse({ modes: [], expectedScoreDeltaPp: 140 })).toMatch(/100/);
		expect(refuse({ modes: [], expectedScoreDeltaPp: -140 })).toMatch(/100/);
		expect(refuse({
			modes: [
				{ failureModeId: MODE_A, expectedFailingTasks: 1, ofTasks: 26 },
				{ failureModeId: MODE_A, expectedFailingTasks: 2, ofTasks: 26 },
			],
		})).toContain("predicted failure mode ids must be unique");
		expect(refuse({ modes: [] })).toContain("a prediction must promise at least one number");
	});

	it("keeps a prediction out of a v1 proposal and out of a no-change result", () => {
		expect(CandidateProposalSchema.safeParse(proposalValue({ schemaVersion: 1, prediction: prediction() }))
			.error?.issues.map((issue) => issue.message))
			.toContain(`a prediction requires proposal schemaVersion ${CANDIDATE_PROPOSAL_SCHEMA_VERSION}`);
		expect(CandidateProposalSchema.safeParse(proposalValue({
			decision: "no-change",
			changes: [],
			prediction: prediction(),
		})).error?.issues.map((issue) => issue.message)).toContain("no-change cannot promise an impact");
	});

	it("is part of the proposal's identity: changing the promise changes the hash", () => {
		const base = CandidateProposalSchema.parse(proposalValue({ prediction: prediction() }));
		const bolder = CandidateProposalSchema.parse(proposalValue({
			prediction: prediction({ modes: [{ failureModeId: MODE_A, expectedFailingTasks: 0, ofTasks: 26 }] }),
		}));
		const silent = CandidateProposalSchema.parse(proposalValue());
		expect(hashValue(base)).not.toBe(hashValue(bolder));
		expect(hashValue(base)).not.toBe(hashValue(silent));
		// And through the exact bytes the artifact is written as, not only the object.
		expect(canonicalJson(base)).not.toBe(canonicalJson(bolder));
	});
});

describe("what a prediction may name", () => {
	it("refuses a mode this proposal is not aiming at", () => {
		expect(() => assertPredictionScope(prediction(), { failureModeIds: [MODE_B], basis: "improvement" }))
			.toThrow(/is not among the failure modes this proposal targets/);
		expect(() => assertPredictionScope(prediction(), { failureModeIds: [MODE_A], basis: "improvement" }))
			.not.toThrow();
	});

	it("refuses a per-mode promise from a construction proposal, and allows its delta", () => {
		expect(() => assertPredictionScope(prediction(), { failureModeIds: [], basis: "construction" }))
			.toThrow(/no measured failure mode to predict/);
		expect(() => assertPredictionScope(
			prediction({ modes: [], expectedScoreDeltaPp: 10 }),
			{ failureModeIds: [], basis: "construction" },
		)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------

describe("scoring a promise against the evidence", () => {
	const measured = [
		{ failureModeId: MODE_A, candidateAffectedTasks: 1, sourceAffectedTasks: 26 },
		{ failureModeId: MODE_B, candidateAffectedTasks: 4, sourceAffectedTasks: 8 },
	];

	it("keeps a mode promise it met, misses one it did not, and stays silent where none was made", () => {
		expect(scorePredictedModes(prediction(), measured).map((mode) => mode.verdict))
			.toEqual(["hit", "unpredicted"]);
		expect(scorePredictedModes(
			prediction({ modes: [{ failureModeId: MODE_A, expectedFailingTasks: 0, ofTasks: 26 }] }),
			measured,
		)[0]?.verdict).toBe("miss");
	});

	it("reads the whole-basket promise against the interval, not the point", () => {
		const inside = scorePredictedOverall(prediction(), {
			scoreDeltaPp: 50,
			confidence95Pp: { low: 35, high: 64 },
			passRateDeltaPp: 50,
		});
		expect(inside).toMatchObject({ kind: "score", predictedPp: 40, actualPp: 50, verdict: "hit", errorPp: 10 });
		// The candidate beat the promise outright: still kept.
		expect(scorePredictedOverall(prediction(), {
			scoreDeltaPp: 70,
			confidence95Pp: { low: 60, high: 80 },
			passRateDeltaPp: 70,
		})?.verdict).toBe("hit");
		// The interval lies entirely below what was promised: missed.
		expect(scorePredictedOverall(prediction(), {
			scoreDeltaPp: 12,
			confidence95Pp: { low: 4, high: 20 },
			passRateDeltaPp: 12,
		})?.verdict).toBe("miss");
		// Nothing measured yet is not a miss.
		expect(scorePredictedOverall(prediction(), null)?.verdict).toBe("unpredicted");
		expect(scorePredictedOverall(null, { scoreDeltaPp: 50, confidence95Pp: null, passRateDeltaPp: 50 })).toBeNull();
	});

	it("compares a pass-rate promise as a point, because no interval brackets it", () => {
		const passRate = prediction({ modes: [], expectedScoreDeltaPp: null, expectedPassRateDeltaPp: 20 });
		expect(scorePredictedOverall(passRate, { scoreDeltaPp: null, confidence95Pp: null, passRateDeltaPp: 25 }))
			.toMatchObject({ kind: "pass-rate", actualPp: 25, confidence95Pp: null, verdict: "hit" });
		expect(scorePredictedOverall(passRate, { scoreDeltaPp: null, confidence95Pp: null, passRateDeltaPp: 5 })?.verdict)
			.toBe("miss");
	});

	it("converts a comparison surface into points without inventing a pass rate", () => {
		expect(measurementOf({ scoreDelta: 0.5, confidence95: { low: 0.35, high: 0.64 }, delta: 0.2 }))
			.toEqual({ scoreDeltaPp: 50, confidence95Pp: { low: 35, high: 64 }, passRateDeltaPp: 20 });
		// An agent-log surface knows scores, not pass rates: the pass rate stays null.
		expect(measurementOf({ scoreDelta: 0.5, confidence95: null, baselineScore: 0.4, candidateScore: 0.9 }))
			.toEqual({ scoreDeltaPp: 50, confidence95Pp: null, passRateDeltaPp: null });
		expect(measurementOf(null)).toBeNull();
	});

	it("scores modes and total in one pass", () => {
		const outcome = scorePrediction(prediction(), {
			measured,
			measurement: { scoreDeltaPp: 50, confidence95Pp: { low: 35, high: 64 }, passRateDeltaPp: 50 },
		});
		expect(outcome.modes).toHaveLength(2);
		expect(outcome.overall?.verdict).toBe("hit");
	});
});

describe("calibration over decided candidates", () => {
	/** Five decided attempts: four kept promises, one missed, oldest first. */
	const entries = [
		{ at: "2026-08-01T00:00:00.000Z", predictedPp: 10, actualPp: 12 },
		{ at: "2026-08-02T00:00:00.000Z", predictedPp: 20, actualPp: 30 },
		{ at: "2026-08-03T00:00:00.000Z", predictedPp: 40, actualPp: 10 },
		{ at: "2026-08-04T00:00:00.000Z", predictedPp: 15, actualPp: 15 },
		{ at: "2026-08-05T00:00:00.000Z", predictedPp: 5, actualPp: 9 },
	].map((entry, index) => ({
		candidateId: `cand-${index}`,
		at: entry.at,
		prediction: prediction({ modes: [], expectedScoreDeltaPp: entry.predictedPp }),
		measurement: {
			scoreDeltaPp: entry.actualPp,
			confidence95Pp: { low: entry.actualPp - 3, high: entry.actualPp + 3 },
			passRateDeltaPp: entry.actualPp,
		},
	}));

	it("counts hits, mean absolute error and the last five, newest on the right", () => {
		// Shuffled in: the projection orders by the decision, never by the caller.
		const calibration = compilePredictionCalibration([entries[2]!, entries[0]!, entries[4]!, entries[3]!, entries[1]!]);
		expect(calibration).toMatchObject({ scored: 5, hits: 4, unpredicted: 0 });
		// |12−10| + |30−20| + |10−40| + |15−15| + |9−5| = 2+10+30+0+4 = 46 → 9.2
		expect(calibration.meanAbsoluteErrorPp).toBe(9.2);
		expect(calibrationStrip(calibration)).toBe("✓✓✗✓✓");
	});

	it("keeps only the newest five in the strip and counts silent attempts apart", () => {
		const older = { ...entries[0]!, candidateId: "cand-older", at: "2026-07-01T00:00:00.000Z" };
		const silent = { candidateId: "cand-silent", at: "2026-08-06T00:00:00.000Z", prediction: null, measurement: null };
		const calibration = compilePredictionCalibration([...entries, older, silent]);
		expect(calibration.scored).toBe(6);
		expect(calibration.strip).toHaveLength(5);
		expect(calibrationStrip(calibration)).toBe("✓✓✗✓✓");
		expect(calibration.unpredicted).toBe(1);
	});

	it("says nothing rather than claiming a perfect record of nothing", () => {
		const empty = compilePredictionCalibration([]);
		expect(empty).toMatchObject({ scored: 0, hits: 0, meanAbsoluteErrorPp: null, strip: [] });
		expect(calibrationStrip(empty)).toBe("");
	});

	it("spells one attempt as the proposer reads it back", () => {
		expect(predictedVersusActual(scorePredictedOverall(prediction(), {
			scoreDeltaPp: 50,
			confidence95Pp: { low: 35, high: 64 },
			passRateDeltaPp: 50,
		}))).toBe("aimed +40.0pp, got +50.0pp");
		expect(predictedVersusActual(scorePredictedOverall(prediction(), null))).toBe("aimed +40.0pp");
		expect(predictedVersusActual(null)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// What the operator actually reads.

function proposalReview(overrides: Partial<Extract<WorkbenchReviewDetail, { kind: "proposal" }>> = {}) {
	return {
		kind: "proposal" as const,
		runId: "run-1",
		proposalHash: HASH,
		baseTargetSha: SHA_A,
		summary: "Tell the agent to call lookup before answering.",
		paths: ["AGENTS.md"],
		risks: [],
		validationPlan: ["Re-run the development basket"],
		prediction: prediction(),
		authoringContext: null,
		evidenceBasis: null,
		exactDiff: DIFF,
		...overrides,
	};
}

function applyConfirmation(predicted: unknown): WorkbenchConfirmation {
	return {
		kind: "apply-proposal",
		title: "Apply exact Builder proposal",
		reason: "Reviewed the exact subject",
		subject: {
			operation: "apply-proposal",
			branch: "ahde/candidate-1",
			baseTargetSha: SHA_A,
			summary: "Tell the agent to call lookup before answering.",
			paths: ["AGENTS.md"],
			risks: [],
			prediction: predicted,
			exactDiff: DIFF,
		},
		subjectHash: "c".repeat(64),
		policy: "consequential",
		question: "Apply exact Builder proposal?",
	};
}

describe("the promise on screen", () => {
	it("states it on the review panel, in English and in Russian", () => {
		const english = renderReview(proposalReview(), plainPaint);
		expect(english).toContain("Prediction Expecting failure mode «aaaaaaaa» 26/26 → ≤3/26 · overall +40 pts");
		setLanguage("ru");
		const russian = renderReview(proposalReview(), plainPaint);
		expect(russian).toContain("Прогноз Ожидаю тип сбоя «aaaaaaaa» 26/26 → ≤3/26 · итог +40 п.п.");
	});

	it("says so plainly when a proposal promised nothing, and quotes the reason when it gave one", () => {
		expect(renderReview(proposalReview({ prediction: null }), plainPaint))
			.toContain("Prediction not stated");
		expect(renderReview(
			proposalReview({ prediction: prediction({ note: "only two tasks reproduce it, so a number would be noise" }) }),
			plainPaint,
		)).toContain("  only two tasks reproduce it, so a number would be noise");
	});

	it("shows the promise on the screen where the operator says yes", () => {
		const english = renderConfirmation(applyConfirmation(prediction()), plainPaint);
		expect(english[3]).toBe("Prediction Expecting failure mode «aaaaaaaa» 26/26 → ≤3/26 · overall +40 pts");
		setLanguage("ru");
		const russian = renderConfirmation(applyConfirmation(prediction()), plainPaint);
		expect(russian[3]).toBe("Прогноз Ожидаю тип сбоя «aaaaaaaa» 26/26 → ≤3/26 · итог +40 п.п.");
		// A subject that carries something the schema will not accept renders as silence.
		expect(renderConfirmation(applyConfirmation({ modes: "everything" }), plainPaint)[3])
			.toBe("Прогноз не заявлен");
	});
});

function targetedMode(overrides: Partial<TargetedModeImpact> = {}): TargetedModeImpact {
	return {
		failureModeId: MODE_A,
		modeSha256: HASH,
		signature: { kind: "grader-check", checkCode: "required-tool", subject: "lookup", discriminatorHash: HASH },
		category: "tool-selection",
		outcome: "improved",
		baseline: { failedOccurrences: 26, totalOccurrences: 26, failureRateBps: 10_000 },
		candidate: { failedOccurrences: 1, totalOccurrences: 26, failureRateBps: 384 },
		sourceAffectedTasks: 26,
		candidateAffectedTasks: 1,
		sourceTaskIds: [],
		candidateAffectedTaskIds: [],
		evidence: [],
		...overrides,
	};
}

function impactOf(modes: TargetedModeImpact[]): CandidateImpact {
	return {
		schemaVersion: 1,
		algorithmId: "exact-candidate-impact-v1",
		candidateId: "candidate-1",
		targetId: "support-bot",
		candidateHash: HASH,
		verdict: "improved",
		inconclusiveReasons: [],
		development: {
			pair: {
				baseline: { evalRunId: "eval-base", harnessSha: SHA_A, evalRunHash: HASH },
				candidate: { evalRunId: "eval-cand", harnessSha: SHA_B, evalRunHash: HASH },
			},
			comparison: {
				algorithmId: null,
				policyId: "development-gate",
				comparisonHash: HASH,
				evidenceHash: null,
				gateHash: HASH,
				verified: true,
				verdict: null,
			},
			summary: {
				taskCount: 10,
				baselinePassRate: 0.4,
				candidatePassRate: 0.9,
				delta: 0.5,
				confidence95: { low: 0.35, high: 0.64 },
				improved: 5,
				regressed: 0,
				unchanged: 5,
			},
			resources: { costRatio: 1, latencyRatio: 1, tokenRatio: 1 },
		},
		proposalBasis: {
			algorithmId: "exact-eval-signals-v1",
			evalRunId: "eval-1",
			diagnosisId: "diag-1",
			briefId: `brief-${"1".repeat(24)}`,
			briefSha256: HASH,
			basisSha256: HASH,
			targetedFailureModes: modes,
		},
		families: [],
		omittedFamilyCount: 0,
		newFailureModes: [],
		omittedNewFailureModeCount: 0,
		worsenedFailureModes: [],
		omittedWorsenedFailureModeCount: 0,
		taskRegressions: [],
		omittedTaskRegressionCount: 0,
		sealedHoldout: { executed: true, gatePassed: true, verdict: "pass" },
		focus: { kind: "summary" },
		subjectHash: HASH,
	} as CandidateImpact;
}

describe("the promise beside the result", () => {
	const measurement = { scoreDeltaPp: 50, confidence95Pp: { low: 35, high: 64 }, passRateDeltaPp: 50 };

	it("puts predicted against measured, per mode and overall, in Russian", () => {
		setLanguage("ru");
		const lines = renderImpact(
			{ available: true, impact: impactOf([targetedMode(), targetedMode({ failureModeId: MODE_B })]) },
			plainPaint,
			{ prediction: prediction(), measurement },
		);
		expect(lines).toContain("  Прогноз предсказано +40 п.п. · получено +50 п.п. (ДИ +35 … +64) ✓");
		expect(lines).toContain("      предсказано ≤3/26 · получено 1/26 ✓");
		// A targeted mode nobody promised anything about reads as neither win nor loss.
		expect(lines).toContain("      без прогноза · получено 1/26 ~");
	});

	it("marks a missed mode and a missed total, in English", () => {
		const lines = renderImpact(
			{ available: true, impact: impactOf([targetedMode({ candidateAffectedTasks: 9 })]) },
			plainPaint,
			{
				prediction: prediction(),
				measurement: { scoreDeltaPp: 12, confidence95Pp: { low: 4, high: 20 }, passRateDeltaPp: 12 },
			},
		);
		expect(lines).toContain("  Prediction predicted +40 pts · got +12 pts (CI +4 … +20) ✗");
		expect(lines).toContain("      predicted ≤3/26 · got 9/26 ✗");
	});

	it("says nothing at all when the proposal made no promise", () => {
		const lines = renderImpact({ available: true, impact: impactOf([targetedMode()]) }, plainPaint, {
			prediction: null,
			measurement,
		});
		expect(lines.some((line) => line.includes("predicted"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// The durable read: candidate records with real Builder runs behind them.

function runsRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "ahde-prediction-"));
	paths.push(root);
	mkdirSync(join(root, "candidates"), { recursive: true });
	mkdirSync(join(root, "builders"), { recursive: true });
	return root;
}

function sha256(text: string): string {
	return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

const artifact = (path: string) => ({ path, sha256: HASH });

const CAPABILITIES = {
	eventStream: false,
	structuredOutput: true,
	usage: false,
	cost: false,
	sessionId: false,
	cancellation: true,
	isolation: "tool-free-executor" as const,
};

/** One immutable Builder run whose proposal carries (or withholds) a promise. */
function writeBuilderRun(root: string, runId: string, promise: ProposalPrediction | null): void {
	const proposal: CandidateProposal = CandidateProposalSchema.parse(
		proposalValue({ prediction: promise, changes: [{
			path: "AGENTS.md",
			baseSha256: HASH,
			unifiedDiff: DIFF,
			rationale: "Change AGENTS.md in the Builder workshop",
			evidenceRefs: [],
		}] }),
	);
	const input = "builder input";
	const record = {
		schemaVersion: 1,
		runId,
		request: {
			baseTargetSha: SHA_A,
			allowedPaths: ["AGENTS.md", "skills/**"],
			manifestChangePolicy: "resources-only",
			approvedSpec: null,
			source: null,
			provenanceMode: "unverified",
			sourceAttestation: null,
			proposalBasis: null,
			proposalDiagnoses: null,
			authoringContext: null,
			failureBundleSha256: null,
			failureBundleBytes: 0,
			builderInputSha256: sha256(input),
			builderInputBytes: Buffer.byteLength(input, "utf8"),
			timeoutMs: 30_000,
		},
		probe: { backend: "pi", available: true, version: "0.84.3", capabilities: CAPABILITIES, error: null },
		result: {
			schemaVersion: 1,
			runId,
			backend: "pi",
			backendVersion: "0.84.3",
			capabilities: CAPABILITIES,
			baseTargetSha: SHA_A,
			startedAt: "2026-08-01T00:00:00.000Z",
			finishedAt: "2026-08-01T00:00:10.000Z",
			status: "completed",
			proposal,
			model: null,
			sessionId: null,
			usage: null,
			costUsd: null,
			traceLevel: "final-only",
			rawEvents: [],
			error: null,
		},
		artifacts: {
			input: { path: "builder_input.txt", sha256: sha256(input), bytes: Buffer.byteLength(input, "utf8") },
			events: { path: "events.jsonl", sha256: sha256(""), bytes: 0 },
			proposal: { path: "proposal.json", sha256: HASH, bytes: 100 },
		},
	};
	const dir = join(root, "builders", runId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "builder_run.json"), `${JSON.stringify(record, null, "\t")}\n`);
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
			confidence95: { low: scoreDelta - 0.05, high: scoreDelta + 0.05 },
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
	outcome: "promoted" | "rejected";
	scoreDelta: number;
	prediction: ProposalPrediction | null;
	tag?: string;
}): void {
	const at = options.at;
	const runId = `${id}-proposal`;
	writeBuilderRun(root, runId, options.prediction);
	const rev = { ref: "main", sha: SHA_A };
	const candidateRev = { ref: `candidate/${id}`, sha: SHA_B };
	const events: unknown[] = [
		{ type: "proposed", eventId: `${id}-1`, at, actor: { kind: "builder", id: "builder" } },
		{ type: "built", eventId: `${id}-2`, at, actor: { kind: "human", id: "local:test" }, candidate: candidateRev },
		{
			type: "validated",
			eventId: `${id}-2b`,
			at,
			actor: { kind: "system", id: "validator" },
			lineage: { baseline: rev, candidate: candidateRev, relation: "descendant" },
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
			eventId: `${id}-3`,
			at,
			actor: { kind: "system", id: "evaluator" },
			evaluation: {
				experimentId: `${id}-exp`,
				designHash: `sha256:${"d".repeat(64)}`,
				mode: "candidate",
				development: {
					baseline: { evalRunId: "erun_base", harness: rev },
					candidate: { evalRunId: "erun_cand", harness: candidateRev },
					comparison: gate("development", "improved", options.scoreDelta, 30),
				},
				sealedHoldout: {
					baseline: { evalRunId: "erun_sealed_base", harness: rev },
					candidate: { evalRunId: "erun_sealed_cand", harness: candidateRev },
					corpus: { id: "sealed-corpus-1", hash: HASH },
					comparison: gate("sealed", "pass", 0.4, 15),
				},
				infrastructureErrors: 0,
			},
		},
		{
			type: "reviewed",
			eventId: `${id}-4`,
			at,
			actor: { kind: "human", id: "local:test" },
			review: {
				experimentId: `${id}-exp`,
				recommendation: options.outcome === "promoted" ? "promote" : "reject",
				reason: "decided",
			},
		},
		options.outcome === "promoted"
			? {
				type: "promoted",
				eventId: `${id}-5`,
				at,
				actor: { kind: "human", id: "local:test" },
				decision: {
					experimentId: `${id}-exp`,
					candidate: candidateRev,
					tag: options.tag ?? "v0.2.0",
					reason: "decided",
				},
			}
			: {
				type: "rejected",
				eventId: `${id}-5`,
				at,
				actor: { kind: "human", id: "local:test" },
				decision: { experimentId: `${id}-exp`, reason: "decided" },
			},
	];
	const record = {
		schemaVersion: 1,
		candidateId: id,
		projectId: "project-1",
		targetId: "agent-1",
		specId: `${id}-spec`,
		proposalId: runId,
		diagnosisId: `${id}-diagnosis`,
		origin: {
			kind: "applied-builder",
			builderRunId: runId,
			builderRun: artifact(`builders/${runId}/run.json`),
			builderInput: artifact(`builders/${runId}/input.json`),
			proposal: artifact(`builders/${runId}/proposal.json`),
			applyReceipt: artifact(`builders/${runId}/apply.json`),
			application: {
				actor: { kind: "human", id: "local:test" },
				reason: "apply the reviewed proposal",
				appliedAt: at,
				baseTargetSha: SHA_A,
				candidateSha: SHA_B,
				proposalSha256: HASH,
			},
			source: {
				evalRunId: "erun_source",
				evalRun: artifact("erun_source/eval_run.json"),
				diagnosisId: `${id}-diagnosis`,
				diagnosis: artifact("erun_source/diagnosis.json"),
				dataset: "development",
				datasetHash: HASH,
				suiteHash: HASH,
				developmentCorpus: null,
			},
			approvedSpec: {
				specId: `${id}-spec`,
				projectId: "project-1",
				specContentHash: HASH,
				snapshotHash: HASH,
				artifact: artifact(`specs/${id}-spec.json`),
			},
		},
		mode: "candidate",
		baseline: rev,
		createdAt: at,
		events,
	};
	const dir = join(root, "candidates", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "candidate.json"), `${JSON.stringify(record, null, "\t")}\n`);
}

/** Five decided attempts: four kept their promise, the middle one did not. */
function fiveDecided(root: string): void {
	const promised = [10, 20, 40, 15, 5];
	const measured = [0.12, 0.30, 0.10, 0.15, 0.09];
	promised.forEach((pp, index) => {
		writeCandidate(root, `cand-${index}`, {
			at: `2026-08-0${index + 1}T00:00:00.000Z`,
			outcome: index === 2 ? "rejected" : "promoted",
			scoreDelta: measured[index]!,
			prediction: prediction({ modes: [], expectedScoreDeltaPp: pp }),
			tag: `v0.${index + 1}.0`,
		});
	});
}

describe("the durable record", () => {
	it("reads its own track record back into /log, hits and misses alike", () => {
		const root = runsRoot();
		fiveDecided(root);
		const log = compileAgentLog({ runsRoot: root, targetId: "agent-1", projectId: "project-1" });
		expect(log.calibration).toMatchObject({ scored: 5, hits: 4, meanAbsoluteErrorPp: 9.2 });
		expect(calibrationStrip(log.calibration)).toBe("✓✓✗✓✓");
		setLanguage("ru");
		expect(renderAgentLog(log, plainPaint).at(-1))
			.toBe("Builder предсказывает: попаданий 4/5 · ошибка ±9.2 п.п. · ✓✓✗✓✓");
		setLanguage("en");
		expect(renderAgentLog(log, plainPaint).at(-1))
			.toBe("Builder predicts: 4/5 hit · error ±9.2 pts · ✓✓✗✓✓");
	});

	it("says so when nothing decided has carried a promise", () => {
		const root = runsRoot();
		writeCandidate(root, "cand-silent", {
			at: "2026-08-01T00:00:00.000Z",
			outcome: "promoted",
			scoreDelta: 0.5,
			prediction: null,
		});
		const log = compileAgentLog({ runsRoot: root, targetId: "agent-1", projectId: "project-1" });
		expect(log.calibration.scored).toBe(0);
		expect(renderAgentLog(log, plainPaint).at(-1))
			.toBe("Builder predicts: nothing decided has carried a prediction yet");
	});

	it("gives the proposer its own aim beside its own result, in history", () => {
		const root = runsRoot();
		fiveDecided(root);
		const history = compileExperimentHistory({ runsRoot: root, targetId: "agent-1" });
		expect(history.attempts[0]?.prediction).toBe("aimed +5.0pp, got +9.0pp");
		expect(history.attempts.map((attempt) => attempt.prediction)).toEqual([
			"aimed +5.0pp, got +9.0pp",
			"aimed +15.0pp, got +15.0pp",
			"aimed +40.0pp, got +10.0pp",
			"aimed +20.0pp, got +30.0pp",
			"aimed +10.0pp, got +12.0pp",
		]);
	});

	it("prints the promise under Measured and the record under Provenance on the passport", () => {
		const root = runsRoot();
		fiveDecided(root);
		const passport = compileVersionPassport(
			{ runsRoot: root, stateRoot: join(root, "state"), projectId: "project-1", version: "v0.5.0" },
			{},
		);
		expect(passport.measured.predicted).toMatchObject({ predictedPp: 5, actualPp: 9, verdict: "hit" });
		expect(passport.provenance.predictionCalibration).toMatchObject({ scored: 5, hits: 4 });
		setLanguage("ru");
		const lines = renderVersionPassport(passport, plainPaint);
		expect(lines).toContain("Обещано +5 п.п. · получено +9 п.п. ✓");
		expect(lines).toContain("Builder предсказывает: попаданий 4/5 · ошибка ±9.2 п.п. · ✓✓✗✓✓");
	});
});

/**
 * The live session closed a construction workshop with no prediction, so the
 * review panel read «прогноз не заявлен» on the path the Builder takes first.
 * The schema always allowed it; only the persona never asked.
 */
describe("the persona predicts on the construction path too", () => {
	const persona = readFileSync(new URL("../builders/ahde/AGENTS.md", import.meta.url), "utf8");

	it("asks for the families and the delta when the first harness is closed", () => {
		const loop = persona.split("## Typical loop")[1] ?? "";
		expect(loop).toContain("State the prediction when you close a construction workshop too");
		expect(loop).toContain("it is still a promise, so it\n   still carries `prediction`");
		expect(loop).toContain("expectedPassRateDeltaPp");
		expect(loop).toContain("A construction proposal names no mode; it may still state the delta");
	});

	it("accepts exactly that prediction: a delta, no mode", () => {
		const prediction = ProposalPredictionSchema.parse({
			modes: [],
			expectedPassRateDeltaPp: 35,
			note: "check_dbo 0/3 → 3/3 tasks, classification 1/6 → 5/6",
		});
		expect(() => assertPredictionScope(prediction, { failureModeIds: [], basis: "construction" })).not.toThrow();
		expect(scorePredictedOverall(prediction, measurementOf({ delta: 0.4 })))
			.toMatchObject({ kind: "pass-rate", predictedPp: 35, actualPp: 40, verdict: "hit" });
	});
});
