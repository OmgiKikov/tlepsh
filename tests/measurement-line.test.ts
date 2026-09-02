import { afterEach, describe, expect, it } from "vitest";
import {
	examLine,
	measurementLine,
	measurementSurface,
	smallBasketNote,
	SMALL_BASKET_CASES,
} from "../src/application/measurement-line.js";
import type { AgentLog } from "../src/application/agent-log.js";
import { developmentSummaryLine, type VersionPassportDevelopment } from "../src/application/version-passport.js";
import { renderAgentLog } from "../src/builder/render/agent-log.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { renderCandidate } from "../src/builder/render/view.js";
import { candidateHeadline } from "../src/workbench/resolution.js";
import { setLanguage } from "../src/i18n.js";
import type { WorkbenchCandidateSummary, WorkbenchGateProjection } from "../src/workbench/types.js";

/**
 * One number, everywhere.
 *
 * The gate decides on the mean paired grader score and its bootstrap interval
 * brackets that score. The panel used to lead with the pass-rate delta beside
 * that interval, `/log` with the score delta, the passport with both inside one
 * pair of brackets — and the Builder, asked to restate any of them, invented a
 * fourth number. These tests pin the composed sentence, and pin that the four
 * surfaces which print it print the same digits.
 */

const SHA_A = "1".repeat(40);
const SHA_B = "2".repeat(40);

afterEach(() => {
	setLanguage(null);
});

const SUMMARY = {
	taskCount: 7,
	baselinePassRate: 1 / 6,
	candidatePassRate: 7 / 12,
	delta: 5 / 12,
	confidence95: { low: 0.09, high: 0.41 },
	improved: 6,
	regressed: 1,
	unchanged: 0,
};

const GATE: WorkbenchGateProjection = {
	verdict: "improved",
	surface: "development",
	delta: 5 / 12,
	baselineScore: 0.31,
	candidateScore: 0.62,
	scoreDelta: 0.31,
	confidence95: { low: 0.09, high: 0.41 },
	tasks: 7,
	repetitions: 3,
	excludedTasks: 0,
	flags: { regressedTasks: 1, improvedTasks: 6, collapsedTasks: 0 },
	resources: { costRatio: null, latencyRatio: null, tokenRatio: null },
	reasons: [],
};

const EXAM: WorkbenchGateProjection = {
	...GATE,
	verdict: "pass",
	surface: "sealed",
	scoreDelta: 0.303,
	confidence95: { low: 0.12, high: 0.48 },
	tasks: 20,
};

describe("the composed sentence", () => {
	it("leads with the score the gate decided on and names the pass rate behind it", () => {
		const line = measurementLine({ development: measurementSurface({ ...SUMMARY, ...GATE }) });
		expect(line.text).toBe(
			"improved · score 31% → 62% (+31 pts, 95% CI +9 … +41) on 7 cases × 3 · pass rate 17% → 58% · " +
				"7 cases is a small basket: read the interval as indicative, not decisive",
		);
		expect(line.numbers).toBe(
			"improved · score 31% → 62% (+31 pts, 95% CI +9 … +41) on 7 cases × 3 · pass rate 17% → 58%",
		);
		setLanguage("ru");
		expect(measurementLine({ development: measurementSurface({ ...SUMMARY, ...GATE }) }).numbers).toBe(
			"стало лучше · балл 31% → 62% (+31 п.п., 95% ДИ +9 … +41) на 7 кейсах × 3 · пасс-рейт 17% → 58%",
		);
	});

	it("appends the sealed exam as a verdict, a delta and a size, and nothing else", () => {
		const line = measurementLine({ development: measurementSurface({ ...SUMMARY, ...GATE }), exam: EXAM });
		expect(line.exam).toBe("exam: pass (+30.3 pts, 95% CI +12 … +48) on 20 cases × 3");
		expect(line.text).toContain(" · exam: pass (+30.3 pts, 95% CI +12 … +48) on 20 cases × 3 · ");
		expect(examLine(null)).toBeNull();
		expect(measurementLine({ development: measurementSurface({ ...SUMMARY, ...GATE }) }).exam).toBeNull();
	});

	it("names the pass rate as the metric when pre-v4 evidence recorded no score", () => {
		const line = measurementLine({ development: measurementSurface({ ...SUMMARY, tasks: 7, repetitions: 3 }) });
		// The interval on legacy evidence brackets the pass-rate delta, and that
		// is the delta printed beside it. A score is never invented.
		expect(line.numbers).toBe("pass rate 17% → 58% (+41.7 pts, 95% CI +9 … +41) on 7 cases × 3");
		expect(line.passRate).toBeNull();
		expect(line.verdict).toBeNull();
	});

	it("says so when a candidate carries no development evidence at all", () => {
		expect(measurementLine({ development: null }).text).toBe("no development evidence on this candidate");
		expect(measurementLine({ development: null, exam: EXAM }).text)
			.toBe("no development evidence on this candidate · exam: pass (+30.3 pts, 95% CI +12 … +48) on 20 cases × 3");
	});

	it("calls a basket small below ten included cases, and never above", () => {
		expect(SMALL_BASKET_CASES).toBe(10);
		expect(smallBasketNote(6)).toBe("6 cases is a small basket: read the interval as indicative, not decisive");
		expect(smallBasketNote(10)).toBeNull();
		expect(smallBasketNote(0)).toBeNull();
		setLanguage("ru");
		expect(smallBasketNote(6)).toBe("6 кейсов — маленькая корзина: интервал ориентировочный, не решающий");
	});
});

function candidate(): WorkbenchCandidateSummary {
	const development = {
		baselineEvalRunId: "erun-base",
		candidateEvalRunId: "erun-cand",
		comparison: SUMMARY,
		gate: GATE,
	};
	const sealedHoldout = { executed: true, gatePassed: true, gate: EXAM };
	return {
		candidateId: "cand-1",
		status: "evaluated",
		projectId: "proj",
		targetId: "agent-1",
		specId: "spec-1",
		proposalId: "run-1",
		baseline: { ref: "main", sha: SHA_A },
		candidate: { ref: "ahde/cand-1", sha: SHA_B },
		headline: candidateHeadline(development, sealedHoldout),
		development,
		sealedHoldout,
		review: null,
		promotion: null,
		rejection: null,
	};
}

function log(): AgentLog {
	return {
		targetId: "agent-1",
		projectId: "proj",
		rows: [{
			candidateId: "cand-1",
			outcome: "promoted",
			at: "2026-09-02T10:00:00.000Z",
			tag: "v0.1.0",
			baseline: SHA_A.slice(0, 12),
			candidate: SHA_B.slice(0, 12),
			development: {
				verdict: GATE.verdict,
				baselineScore: GATE.baselineScore,
				candidateScore: GATE.candidateScore,
				scoreDelta: GATE.scoreDelta,
				confidence95: GATE.confidence95,
				baselinePassRate: SUMMARY.baselinePassRate,
				candidatePassRate: SUMMARY.candidatePassRate,
				tasks: GATE.tasks,
				repetitions: GATE.repetitions,
			},
			sealed: { verdict: "pass", tasks: 20, repetitions: 3 },
			costRatio: null,
			costUsd: 0.4,
			resolvedModes: { count: 0, examples: [], omitted: 0, flippedTasks: 0 },
			reason: "shipped",
			appliedByImprovementLoop: false,
			prediction: null,
		}],
		omitted: 0,
		unreadable: 0,
		versions: [{ tag: "v0.1.0", at: "2026-09-02T10:00:00.000Z", score: 0.62 }],
		cumulativeCostUsd: 0.4,
		calibration: { scored: 0, hits: 0, meanAbsoluteErrorPp: null, strip: [], unpredicted: 0 },
	};
}

const PASSPORT: VersionPassportDevelopment = {
	verdict: "improved",
	tasks: 7,
	repetitions: 3,
	excludedTasks: 0,
	baselinePassRate: SUMMARY.baselinePassRate,
	candidatePassRate: SUMMARY.candidatePassRate,
	baselineScore: GATE.baselineScore,
	candidateScore: GATE.candidateScore,
	scoreDelta: GATE.scoreDelta,
	confidence95: GATE.confidence95,
};

describe("four surfaces, one number", () => {
	it("prints the same score delta and the same interval on panel, log, passport and headline", () => {
		const summary = candidate();
		const panel = renderCandidate(summary, plainPaint).join("\n");
		const rows = renderAgentLog(log(), plainPaint).join("\n");
		const passport = `- Development: ${developmentSummaryLine(PASSPORT)}`;
		const delta = "score 31% → 62% (+31 pts, 95% CI +9 … +41)";
		for (const surface of [panel, rows, passport, summary.headline]) {
			expect(surface).toContain(delta);
			expect(surface).toContain("pass rate 17% → 58%");
		}
		// And the pass-rate delta the panel used to lead with is nowhere near
		// the interval any more: the only delta on any of them is the score's.
		for (const surface of [panel, rows, passport, summary.headline]) {
			expect(surface).not.toContain("+41.7");
		}
	});

	it("carries the small-basket caveat into the headline and under the panel numbers", () => {
		const summary = candidate();
		const caveat = "7 cases is a small basket: read the interval as indicative, not decisive";
		expect(summary.headline).toContain(` · ${caveat}`);
		expect(renderCandidate(summary, plainPaint)).toContain(`  ${caveat}`);
		expect(renderAgentLog(log(), plainPaint).join("\n")).toContain(caveat);
	});
});
