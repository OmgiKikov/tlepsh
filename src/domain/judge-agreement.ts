/**
 * How well a judge agrees with the humans who checked it.
 *
 * A judge grader is an instrument, and an instrument nobody has ever compared
 * against a human is an opinion with a cost. `ahde label` collects the human
 * side; this module is the arithmetic, and nothing else: no I/O, no clock, no
 * evidence loading, so the numbers on a report and the numbers behind a
 * promotion refusal are computed by exactly one function.
 */

/** One human verdict placed beside the judge's verdict for the same check. */
export interface JudgeAgreementInput {
	/** Identity of the exact normalized grader spec the judge ran. */
	graderSpecHash: string;
	human: "pass" | "fail";
	judge: "pass" | "fail";
}

/** The 2×2 table, the rates derived from it, and how much it rests on. */
export interface JudgeAgreementStats {
	/** Labels behind these numbers. */
	n: number;
	/** Share of labels where the judge and the human said the same thing. */
	agreement: number;
	/**
	 * Cohen's κ, or null when it is undefined: agreement corrected for the
	 * agreement two indifferent raters would reach by chance alone.
	 */
	kappa: number | null;
	/** Judge said pass, human said fail: the failures the judge waves through. */
	falsePass: number;
	/** Judge said fail, human said pass: the work the judge invents. */
	falseFail: number;
	/** Both said pass. */
	truePass: number;
	/** Both said fail. */
	trueFail: number;
}

export interface JudgeAgreementReport {
	/** Per grader spec hash, sorted by hash so the report is stable. */
	byGrader: Array<{ graderSpecHash: string } & JudgeAgreementStats>;
	/** Every label together. Meaningful as a project-level health number only. */
	pooled: JudgeAgreementStats;
}

const EMPTY: JudgeAgreementStats = {
	n: 0,
	agreement: 0,
	kappa: null,
	falsePass: 0,
	falseFail: 0,
	truePass: 0,
	trueFail: 0,
};

/**
 * Cohen's κ over the 2×2 table:
 *
 *   po = (truePass + trueFail) / n
 *   pe = (rowPass·colPass + rowFail·colFail) / n²
 *   κ  = (po − pe) / (1 − pe)
 *
 * κ is undefined when pe = 1 — every rater used one label for everything, so
 * chance alone explains the whole table and there is nothing left to correct.
 * That case returns null rather than a made-up 0 or 1: "the labels cannot say"
 * is a different statement from "the judge agrees by chance".
 */
function cohensKappa(table: {
	n: number;
	truePass: number;
	trueFail: number;
	falsePass: number;
	falseFail: number;
}): number | null {
	if (table.n === 0) return null;
	const observed = (table.truePass + table.trueFail) / table.n;
	const judgePass = (table.truePass + table.falsePass) / table.n;
	const humanPass = (table.truePass + table.falseFail) / table.n;
	const expected = judgePass * humanPass + (1 - judgePass) * (1 - humanPass);
	if (expected >= 1) return null;
	return (observed - expected) / (1 - expected);
}

function statsFor(rows: readonly JudgeAgreementInput[]): JudgeAgreementStats {
	if (rows.length === 0) return { ...EMPTY };
	const truePass = rows.filter((row) => row.judge === "pass" && row.human === "pass").length;
	const trueFail = rows.filter((row) => row.judge === "fail" && row.human === "fail").length;
	const falsePass = rows.filter((row) => row.judge === "pass" && row.human === "fail").length;
	const falseFail = rows.filter((row) => row.judge === "fail" && row.human === "pass").length;
	const n = rows.length;
	return {
		n,
		agreement: (truePass + trueFail) / n,
		kappa: cohensKappa({ n, truePass, trueFail, falsePass, falseFail }),
		falsePass,
		falseFail,
		truePass,
		trueFail,
	};
}

/** Per-grader and pooled agreement over one set of labels. */
export function judgeAgreement(rows: readonly JudgeAgreementInput[]): JudgeAgreementReport {
	const byHash = new Map<string, JudgeAgreementInput[]>();
	for (const row of rows) {
		const bucket = byHash.get(row.graderSpecHash) ?? [];
		bucket.push(row);
		byHash.set(row.graderSpecHash, bucket);
	}
	return {
		byGrader: [...byHash.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([graderSpecHash, bucket]) => ({ graderSpecHash, ...statsFor(bucket) })),
		pooled: statsFor(rows),
	};
}

/** `84% · κ 0.62 · n=50`, the one line every screen shows. */
export function formatJudgeAgreement(stats: JudgeAgreementStats): string {
	const kappa = stats.kappa === null ? "κ n/a" : `κ ${stats.kappa.toFixed(2)}`;
	return `${Math.round(stats.agreement * 100)}% · ${kappa} · n=${stats.n}`;
}
