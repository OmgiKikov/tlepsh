import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	designPhrase,
	examLine,
	exclusionReasonOf,
	measurementLine,
	measurementSurface,
	smallBasketNote,
	trimSeparator,
	SMALL_BASKET_CASES,
} from "../src/application/measurement-line.js";
import {
	band,
	bar,
	bareDelta,
	coarseElapsed,
	duration,
	elapsed,
	interval,
	isSubCent,
	kappa,
	kappaValue,
	money,
	percent,
	points,
	ratio,
} from "../src/measurement.js";
import type { AgentLog } from "../src/application/agent-log.js";
import { formatJudgeAgreementSummary } from "../src/domain/judge-agreement.js";
import { renderCalibration } from "../src/builder/render/calibration.js";
import { judgeAgreementSummary } from "../src/builder/render/label.js";
import { developmentSummaryLine, type VersionPassportDevelopment } from "../src/application/version-passport.js";
import { renderAgentLog } from "../src/builder/render/agent-log.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { renderCandidate, renderHeader } from "../src/builder/render/view.js";
import { candidateHeadline } from "../src/workbench/resolution.js";
import { setLanguage } from "../src/i18n.js";
import type {
	WorkbenchCalibrationProjection,
	WorkbenchCandidateSummary,
	WorkbenchGateProjection,
} from "../src/workbench/types.js";

/** The A/A noise the calibration panel, the status line and the headline share. */
function makeCalibrationProjection(): WorkbenchCalibrationProjection {
	return {
		candidateId: "calibration-1",
		targetSha: SHA_A,
		taskCount: 30,
		repetitions: 3,
		aaPassRate: 0.7,
		delta: 0,
		confidence95: { low: -0.06, high: 0.06 },
		flipRate: 0.1,
		recommendedRepetitions: 3,
		recommendedExamCases: 15,
		verdict: "inconclusive",
		at: "2026-09-02T10:00:00.000Z",
	};
}

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

	it("says why a generated exam is smaller than the one that was ordered", () => {
		// Session 6 ordered 20 cases and the exam ran on 19; no screen said why.
		const short = {
			...EXAM,
			tasks: 19,
			generation: { requested: 20, accepted: 19, droppedDuplicate: 1, droppedMalformed: 0 },
		};
		expect(examLine(short)!.text)
			.toBe("pass (+30.3 pts, 95% CI +12 … +48) on 19 cases × 3 (1 duplicate dropped when it was generated)");
		expect(examLine(short)!.shortfall).toBe("(1 duplicate dropped when it was generated)");
		setLanguage("ru");
		expect(examLine(short)!.text).toContain("на 19 кейсах × 3 (при генерации отброшено: 1 дубликат)");
		setLanguage(null);
		// Both reasons, when both dropped something.
		expect(examLine({ ...short, tasks: 17, generation: { requested: 20, accepted: 17, droppedDuplicate: 1, droppedMalformed: 2 } })!.shortfall)
			.toBe("(1 duplicate, 2 malformed cases dropped when it was generated)");
		// A short exam whose receipt blames nothing still admits the shortfall.
		expect(examLine({ ...short, generation: { requested: 20, accepted: 19, droppedDuplicate: 0, droppedMalformed: 0 } })!.shortfall)
			.toBe("(short of the 20 that were ordered)");
		// An exam that delivered what was ordered, and one the operator brought,
		// say nothing at all.
		expect(examLine({ ...EXAM, generation: { requested: 20, accepted: 20, droppedDuplicate: 0, droppedMalformed: 0 } })!.shortfall).toBe("");
		expect(examLine(EXAM)!.shortfall).toBe("");
		expect(examLine(EXAM)!.text).toBe("pass (+30.3 pts, 95% CI +12 … +48) on 20 cases × 3");
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

	it("says how many cases were excluded and why, not only how many were measured", () => {
		// Session 8 read `на 14 кейсах × 5` for a basket designed as fifteen and
		// no line said where the fifteenth went. The size now carries its own
		// provenance: what was designed, what was measured, and what became of
		// the difference.
		const lost = measurementSurface({ ...SUMMARY, ...GATE, tasks: 14, repetitions: 5, excludedTasks: 1 });
		expect(designPhrase({ tasks: 14, repetitions: 5, excludedTasks: 1 }))
			.toBe("on 14 of 15 cases × 5 · 1 excluded for infrastructure");
		expect(measurementLine({ development: lost }).design)
			.toBe("on 14 of 15 cases × 5 · 1 excluded for infrastructure");
		expect(measurementLine({ development: lost }).text).toContain("on 14 of 15 cases × 5 · 1 excluded for infrastructure");
		setLanguage("ru");
		expect(measurementLine({ development: lost }).design).toBe("на 14 из 15 кейсов × 5 · 1 исключён: инфраструктура");
		// The participle bends to the count, and «из 2 кейсов» is genitive.
		expect(designPhrase({ tasks: 1, repetitions: 5, excludedTasks: 2 })).toBe("на 1 из 3 кейсов × 5 · 2 исключены: инфраструктура");
		// The narrower reason, when the exclusions know it.
		expect(designPhrase({ tasks: 14, repetitions: 5, excludedTasks: 1, excludedReason: "incomplete" }))
			.toBe("на 14 из 15 кейсов × 5 · 1 исключён: неполные повторы");
		expect(designPhrase({ tasks: 14, repetitions: 5, excludedTasks: 2, excludedReason: "mixed" }))
			.toBe("на 14 из 16 кейсов × 5 · 2 исключены: инфраструктура, неполные повторы");
		setLanguage(null);
		// A whole basket says none of it: nothing was lost, so nothing is named.
		expect(measurementLine({ development: measurementSurface({ ...SUMMARY, ...GATE }) }).design).toBe("on 7 cases × 3");
	});

	it("collapses per-task exclusion reasons into the one word the line prints", () => {
		expect(exclusionReasonOf([])).toBe("infrastructure");
		expect(exclusionReasonOf([{ reason: "infrastructure" }])).toBe("infrastructure");
		expect(exclusionReasonOf([{ reason: "incomplete" }, { reason: "incomplete" }])).toBe("incomplete");
		expect(exclusionReasonOf([{ reason: "incomplete" }, { reason: "infrastructure" }])).toBe("mixed");
	});

	it("carries the exam's origin, and says nothing when nobody read the receipt", () => {
		// `pass` is worth what the exam is worth. "The judge wrote it from the
		// documents" and "the operator brought it" are different claims about
		// the same word, so the exam line makes the claim it can support.
		expect(examLine({ ...EXAM, origin: "judge-generated-kb" })!.text)
			.toBe("pass (+30.3 pts, 95% CI +12 … +48) on 20 cases × 3 · written by the judge from the knowledge base");
		expect(examLine({ ...EXAM, origin: "judge-generated-kb-reviewed" })!.origin)
			.toBe("written by the judge from the knowledge base");
		expect(examLine({ ...EXAM, origin: "judge-generated" })!.origin).toBe("written by the judge from the description");
		expect(examLine({ ...EXAM, origin: "judge-generated-reviewed" })!.origin)
			.toBe("written by the judge from the description");
		// `null` is a finding — the receipts were read and none claims this exam.
		expect(examLine({ ...EXAM, origin: null })!.origin).toBe("brought by the operator");
		// An absent field is not a finding, and crediting the operator with an
		// exam the judge may have written would be inventing one.
		expect(examLine(EXAM)!.origin).toBe("");
		expect(examLine(EXAM)!.text).toBe("pass (+30.3 pts, 95% CI +12 … +48) on 20 cases × 3");
		setLanguage("ru");
		expect(examLine({ ...EXAM, origin: "judge-generated-kb" })!.text)
			.toContain("на 20 кейсах × 3 · написан судьёй по базе знаний");
		expect(examLine({ ...EXAM, origin: "judge-generated" })!.origin).toBe("написан судьёй из описания");
		expect(examLine({ ...EXAM, origin: null })!.origin).toBe("загружен оператором");
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

// ---------------------------------------------------------------------------
// No separator with nothing after it. The `◆` headline is this sentence cut to
// the width a title has, and the cut used to land on the ` · ` before the
// small-basket caveat — a dot at the end of the line, pointing at nothing.
// ---------------------------------------------------------------------------

describe("the joiner never leaves a dangling separator", () => {
	it("ends the sentence, the exam line and the numbers on a word", () => {
		for (const language of ["en", "ru"] as const) {
			setLanguage(language);
			const line = measurementLine({
				development: measurementSurface({ ...SUMMARY, ...GATE }),
				exam: { verdict: "pass", scoreDelta: 0.303, confidence95: { low: 0.12, high: 0.48 }, tasks: 19, repetitions: 3 },
			});
			for (const part of [line.text, line.numbers, line.development, line.exam!]) {
				expect(part).not.toMatch(/[\s·,;:—–-]$/);
			}
			expect(examLine({ verdict: "pass", scoreDelta: null, confidence95: null, tasks: 19, repetitions: 3 })!.text)
				.not.toMatch(/[\s·,;:—–-]$/);
		}
	});

	it("trims a separator a caller's own cut orphaned", () => {
		expect(trimSeparator("score 45% → 67% on 19 cases × 3 · ")).toBe("score 45% → 67% on 19 cases × 3");
		expect(trimSeparator("nothing to trim")).toBe("nothing to trim");
		expect(trimSeparator("")).toBe("");
	});
});

// ---------------------------------------------------------------------------
// One module writes every number.
//
// The composer above was already the one sentence; the numbers inside it were
// not. A percentage was whole in the composer, carried one decimal on the
// passport panel and was re-clamped in the trace; the same delta was `+3.1 pts`
// in the sentence and `+3.1pp` in the four files that formatted it themselves,
// so a Russian screen printed an English unit; a spend under a cent was
// `<$0.01` on one screen and `$0.00` on two others; and κ with nothing behind
// it had three different words for the same absence.
// ---------------------------------------------------------------------------

describe("one module, one number", () => {
	it("gives each quantity one precision and one word for what was never measured", () => {
		expect(percent(0.315)).toBe("32%");
		expect(percent(0.315, { digits: 1 })).toBe("31.5%");
		// A rate outside [0,1] is not a rate: `140%` on a screen is worth less
		// than the bug it hides.
		expect(percent(1.4)).toBe("100%");
		expect(percent(null)).toBe("—");
		expect(points(0.031)).toBe("+3.1 pts");
		expect(points(0.03)).toBe("+3 pts");
		expect(points(-0.031)).toBe("-3.1 pts");
		expect(points(Number.NaN)).toBe("—");
		expect(bareDelta(0.031)).toBe("+3.1");
		expect(band(-0.06)).toBe("±6 pts");
		expect(ratio(1.44)).toBe("×1.4");
		expect(ratio(12.4)).toBe("×12");
		expect(ratio(null)).toBe("—");
		expect(kappa(0.618)).toBe("κ 0.62");
		expect(kappa(null)).toBe("κ —");
		expect(kappaValue(null)).toBe("—");
		expect(duration(1_440)).toBe("1.4s");
		expect(duration(340)).toBe("340ms");
		expect(duration(null)).toBe("—");
		expect(elapsed(252_000)).toBe("4m12s");
		expect(coarseElapsed(252_000)).toBe("4m");
		expect(bar(0.5, 4)).toBe("██░░");
	});

	it("prints the unit once: on the delta, never on both ends of its interval", () => {
		expect(interval(0.09, 0.41)).toBe("95% CI +9 … +41");
		// The one shape that stands alone in a sentence names the quantity
		// behind the high end, and still only once.
		expect(interval(0.05, 0.35, { form: "machine", unit: "after" })).toBe("95% CI +5.0 … +35.0pp");
		const spread = renderCalibration(makeCalibrationProjection(), plainPaint).join("\n");
		expect(spread).toContain("Spread ±6 pts (95% CI -6 … +6)");
		expect(spread).not.toMatch(/-6 pts … \+6 pts/);
	});

	it("names the unit from the dictionary, so a Russian screen never says pp", () => {
		setLanguage("ru");
		expect(points(0.031)).toBe("+3.1 п.п.");
		expect(band(0.06)).toBe("±6 п.п.");
		const panel = renderCalibration(makeCalibrationProjection(), plainPaint).join("\n");
		expect(panel).toContain("±6 п.п.");
		expect(panel).not.toMatch(/\dpp\b/);
		expect(measurementLine({ development: measurementSurface({ ...SUMMARY, ...GATE }) }).text)
			.not.toMatch(/\dpp\b/);
		// English by design, and only there: the machine form is what the
		// markdown report and the Builder's own compact history are read as.
		expect(points(0.031, "machine")).toBe("+3.1pp");
	});

	it("never rounds a bill under half a cent down to $0.00", () => {
		expect(money(null)).toBe("—");
		expect(money(undefined)).toBe("—");
		expect(money(0)).toBe("$0.00");
		expect(money(0.0015)).toBe("<$0.01");
		expect(money(0.005)).toBe("$0.01");
		expect(money(1.404)).toBe("$1.40");
		expect(isSubCent(0.004999)).toBe(true);
		expect(isSubCent(0.005)).toBe(false);
	});
});

describe("four surfaces, one κ", () => {
	it("says the same thing about a judge nobody has checked, on every screen that shows one", () => {
		const uncalibrated = { agreement: 1, kappa: null, labels: 4 };
		const panel = renderCandidate(
			{ ...candidate(), judgeAgreement: uncalibrated },
			plainPaint,
		).join("\n");
		const header = renderHeader({
			view: null,
			builderModel: { label: "x", credentialPresent: true },
		}, plainPaint).join("\n");
		const surfaces = [
			panel,
			judgeAgreementSummary({
				...uncalibrated,
				n: 4,
				nChecks: 4,
				duplicateLabels: 0,
				conflictedSubjects: 0,
				falsePass: 0,
				falseFail: 0,
				truePass: 4,
				trueFail: 0,
			}),
			formatJudgeAgreementSummary(uncalibrated),
		];
		for (const surface of surfaces) {
			expect(surface).toContain("κ —");
			expect(surface).not.toContain("n/a");
		}
		expect(header).not.toContain("n/a");
	});
});

/**
 * Copy twenty-six cannot land.
 *
 * The canonical module existed before this lane and was bypassed roughly
 * twenty-five times, because nothing stopped a renderer from spelling `pp`
 * itself. This is what stops it: one module owns the units, and every other
 * file under `src/` has to call it.
 */
describe("only one module spells a measurement unit", () => {
	const FORBIDDEN: readonly { name: string; pattern: RegExp; instead: string }[] = [
		{ name: "a unit welded onto a template", pattern: /\}\s*(?:pp|pts)\b/, instead: "points()" },
		{ name: "a bare unit literal", pattern: /["'`](?:pp|pts)["'`]/, instead: "t(\"unit.points\") through points()" },
		{ name: "an inline percentage", pattern: /Math\.round\((?:[^()]|\([^()]*\))*\*\s*100\s*\)/, instead: "percent()" },
		{ name: "an inline percentage", pattern: /\*\s*100\s*\)\s*\.toFixed\(/, instead: "percent()" },
		{ name: "a second word for an unmeasured κ", pattern: /κ\s*n\/a/, instead: "kappa()" },
		{ name: "a second sub-cent threshold", pattern: /<\$0\.01/, instead: "money()" },
	];

	/** Code only: prose is allowed to name a unit, and does. */
	function code(source: string): { line: number; text: string }[] {
		const rows: { line: number; text: string }[] = [];
		let inBlock = false;
		source.split("\n").forEach((raw, index) => {
			const trimmed = raw.trim();
			if (inBlock) {
				if (trimmed.includes("*/")) inBlock = false;
				return;
			}
			if (trimmed.startsWith("/*")) {
				if (!trimmed.includes("*/")) inBlock = true;
				return;
			}
			if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
			rows.push({ line: index + 1, text: raw.replace(/\/\/.*$/, "") });
		});
		return rows;
	}

	function sources(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const path = join(dir, entry.name);
			return entry.isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
		});
	}

	it("finds no unit, no inline percentage and no second threshold outside src/measurement.ts", () => {
		// `i18n.ts` is where a unit is *defined*: `pts`, `п.п.` and `<$0.01` are
		// dictionary values, and the module above reads them from there.
		const exempt = new Set(["src/measurement.ts", "src/i18n.ts"]);
		const offences: string[] = [];
		for (const file of sources("src")) {
			if (exempt.has(file)) continue;
			for (const { line, text } of code(readFileSync(file, "utf8"))) {
				for (const rule of FORBIDDEN) {
					if (rule.pattern.test(text)) offences.push(`${file}:${line} — ${rule.name}; call ${rule.instead}`);
				}
			}
		}
		expect(offences).toEqual([]);
	});
});
