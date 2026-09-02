import { describe, expect, it } from "vitest";
import {
	formatJudgeAgreement,
	formatJudgeAgreementSummary,
	judgeAgreement,
	type JudgeAgreementInput,
} from "../src/domain/judge-agreement.js";

const SPEC_A = `sha256:${"a".repeat(64)}`;
const SPEC_B = `sha256:${"b".repeat(64)}`;

/** `n` labels of one cell of the 2×2 table. */
function cell(
	graderSpecHash: string,
	judge: "pass" | "fail",
	human: "pass" | "fail",
	count: number,
): JudgeAgreementInput[] {
	return Array.from({ length: count }, () => ({ graderSpecHash, judge, human }));
}

describe("Cohen's κ", () => {
	it("matches the hand-computed value on the textbook 2×2 table", () => {
		// judge pass/human pass 20, judge pass/human fail 5,
		// judge fail/human pass 10, judge fail/human fail 15.  n = 50
		//   po = (20 + 15) / 50                         = 0.70
		//   judge pass = 25/50 = 0.5, human pass = 30/50 = 0.6
		//   pe = 0.5·0.6 + 0.5·0.4                      = 0.50
		//   κ  = (0.70 − 0.50) / (1 − 0.50)             = 0.40
		const report = judgeAgreement([
			...cell(SPEC_A, "pass", "pass", 20),
			...cell(SPEC_A, "pass", "fail", 5),
			...cell(SPEC_A, "fail", "pass", 10),
			...cell(SPEC_A, "fail", "fail", 15),
		]);
		expect(report.pooled.n).toBe(50);
		expect(report.pooled.agreement).toBeCloseTo(0.7, 12);
		expect(report.pooled.kappa).toBeCloseTo(0.4, 12);
		expect(report.pooled.falsePass).toBe(5);
		expect(report.pooled.falseFail).toBe(10);
	});

	it("is 1 on perfect agreement and 0 when agreement is exactly chance", () => {
		expect(judgeAgreement([
			...cell(SPEC_A, "pass", "pass", 10),
			...cell(SPEC_A, "fail", "fail", 10),
		]).pooled.kappa).toBe(1);

		// Each rater says pass half the time and they line up no better than
		// two coins: po = 0.5, pe = 0.5, κ = 0.
		expect(judgeAgreement([
			...cell(SPEC_A, "pass", "pass", 25),
			...cell(SPEC_A, "pass", "fail", 25),
			...cell(SPEC_A, "fail", "pass", 25),
			...cell(SPEC_A, "fail", "fail", 25),
		]).pooled.kappa).toBeCloseTo(0, 12);
	});

	it("goes negative when the judge disagrees worse than chance", () => {
		// po = 0, pe = 0.5, κ = −1: the judge is an inverted oracle.
		expect(judgeAgreement([
			...cell(SPEC_A, "pass", "fail", 10),
			...cell(SPEC_A, "fail", "pass", 10),
		]).pooled.kappa).toBeCloseTo(-1, 12);
	});

	it("returns null rather than inventing a κ nobody can compute", () => {
		// Every label is pass/pass: pe = 1, so (po − pe)/(1 − pe) is 0/0. The
		// agreement is still a perfect 100% — the two facts are different.
		const constant = judgeAgreement(cell(SPEC_A, "pass", "pass", 30)).pooled;
		expect(constant.agreement).toBe(1);
		expect(constant.kappa).toBeNull();
		expect(constant.n).toBe(30);

		// κ is undefined only when both raters are degenerate. Here the judge
		// says pass to everything but the human does not, so pe = 0.5·1 + 0.5·0
		// = 0.5 = po: κ exists and is exactly 0. A judge that always says pass
		// still scores 50% raw agreement, and κ is what refuses to be impressed.
		const oneSided = judgeAgreement([
			...cell(SPEC_A, "pass", "pass", 15),
			...cell(SPEC_A, "pass", "fail", 15),
		]).pooled;
		expect(oneSided.agreement).toBe(0.5);
		expect(oneSided.kappa).toBeCloseTo(0, 12);

		// No labels at all: no rate, no κ.
		expect(judgeAgreement([]).pooled).toMatchObject({ n: 0, agreement: 0, kappa: null });
	});
});

describe("per-grader agreement", () => {
	it("counts one independent subject once and excludes conflicting re-labels", () => {
		const same = {
			graderSpecHash: SPEC_A,
			calibrationSubjectId: "subject-1",
			judge: "pass" as const,
			human: "pass" as const,
		};
		const duplicates = judgeAgreement([same, same, same]).pooled;
		expect(duplicates).toMatchObject({
			n: 1,
			nChecks: 1,
			duplicateLabels: 2,
			conflictedSubjects: 0,
			agreement: 1,
		});
		expect(formatJudgeAgreement(duplicates)).toContain("duplicates=2");

		const conflicted = judgeAgreement([
			same,
			{ ...same, human: "fail" as const },
			{ ...same, calibrationSubjectId: "subject-2" },
		]).pooled;
		expect(conflicted).toMatchObject({
			n: 1,
			nChecks: 1,
			duplicateLabels: 1,
			conflictedSubjects: 1,
			agreement: 1,
		});
		expect(formatJudgeAgreement(conflicted)).toContain("conflicts=1");
	});

	it("separates independent subjects from assertion-level checks", () => {
		const stats = judgeAgreement([{
			graderSpecHash: SPEC_A,
			calibrationSubjectId: "checklist-1",
			human: "fail",
			judge: "fail",
			assertions: ["yes", "no", "yes"],
			judgeAssertions: ["yes", "no", "no"],
		}]).pooled;
		expect(stats).toMatchObject({ n: 1, nChecks: 3, agreement: 2 / 3 });
		expect(formatJudgeAgreement(stats)).toContain("n=1 · checks=3");
	});

	it("keeps each grader spec on its own row and sorts them stably", () => {
		const report = judgeAgreement([
			...cell(SPEC_B, "pass", "fail", 3),
			...cell(SPEC_A, "pass", "pass", 4),
			...cell(SPEC_A, "fail", "fail", 4),
			...cell(SPEC_B, "fail", "pass", 1),
		]);
		expect(report.byGrader.map((row) => row.graderSpecHash)).toEqual([SPEC_A, SPEC_B]);
		expect(report.byGrader[0]).toMatchObject({ n: 8, agreement: 1, kappa: 1, falsePass: 0, falseFail: 0 });
		// A judge that agrees with nobody: 3 waved-through failures, 1 invented one.
		expect(report.byGrader[1]).toMatchObject({ n: 4, agreement: 0, falsePass: 3, falseFail: 1 });
		expect(report.pooled.n).toBe(12);
		expect(report.pooled.falsePass).toBe(3);
		expect(report.pooled.falseFail).toBe(1);
	});

	it("renders the one line every screen shows", () => {
		const report = judgeAgreement([
			...cell(SPEC_A, "pass", "pass", 20),
			...cell(SPEC_A, "pass", "fail", 5),
			...cell(SPEC_A, "fail", "pass", 10),
			...cell(SPEC_A, "fail", "fail", 15),
		]);
		expect(formatJudgeAgreement(report.pooled)).toBe("70% · κ 0.40 · n=50");
		expect(formatJudgeAgreement(judgeAgreement(cell(SPEC_A, "pass", "pass", 4)).pooled))
			.toBe("100% · κ n/a · n=4");
	});
});

/**
 * Every judge screen prints the same three numbers, whether it holds the whole
 * sample or the reduced projection a view carries. Two formatters that could
 * round differently would be two answers to one question.
 */
describe("one agreement line, two carriers", () => {
	it("says the same three numbers from the full stats and from the projection", () => {
		const stats = judgeAgreement([
			...cell(SPEC_A, "pass", "pass", 8),
			...cell(SPEC_A, "fail", "fail", 2),
			...cell(SPEC_A, "pass", "fail", 2),
		]).pooled;
		expect(formatJudgeAgreement(stats)).toBe("83% · κ 0.57 · n=12");
		expect(formatJudgeAgreementSummary({ agreement: stats.agreement, kappa: stats.kappa, labels: stats.n }))
			.toBe("83% · κ 0.57 · n=12");
	});

	it("says κ n/a rather than inventing one when it is undefined", () => {
		expect(formatJudgeAgreementSummary({ agreement: 1, kappa: null, labels: 4 })).toBe("100% · κ n/a · n=4");
	});
});
