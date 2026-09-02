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
	/**
	 * Host-derived identity of the independent judge subject this comparison
	 * describes. When present, repeating the same label never manufactures a
	 * larger sample; conflicting labels for the same subject are excluded.
	 *
	 * The application layer derives this from the exact eval/run/task/grader,
	 * judge fingerprint and judge-facing subject hash. Pure arithmetic callers
	 * may omit it, in which case each input row is one independent subject.
	 */
	calibrationSubjectId?: string | undefined;
	human: "pass" | "fail";
	judge: "pass" | "fail";
	/**
	 * The checklist, when the label was collected assertion by assertion. Both
	 * sides travel together; either both are present or neither is.
	 *
	 * A pooled verdict on a twelve-assertion rubric throws away eleven twelfths
	 * of what the human actually said, and it hides WHICH check the judge gets
	 * wrong. When they are present each assertion is one comparison, so a judge
	 * that is right about eleven and wrong about one reads as 92%, not as 0%.
	 */
	assertions?: readonly ("yes" | "no" | "unknown")[] | undefined;
	judgeAssertions?: readonly ("yes" | "no" | "unknown")[] | undefined;
}

/** The 2×2 table, the rates derived from it, and how much it rests on. */
export interface JudgeAgreementStats {
	/** Unique, non-conflicting human-labelled subjects behind these numbers. */
	n: number;
	/** Binary checks behind the rates; greater than `n` for assertion rubrics. */
	nChecks: number;
	/** Exact repeated labels ignored while reducing the sample. */
	duplicateLabels: number;
	/** Subject identities excluded because their human labels conflicted. */
	conflictedSubjects: number;
	/** Share of checks where the judge and the human said the same thing. */
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
	nChecks: 0,
	duplicateLabels: 0,
	conflictedSubjects: 0,
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

/**
 * One comparison per assertion when the label carries a checklist, and one per
 * label otherwise. "unknown" counts as a fail on both sides, exactly as the
 * grader itself folds it: an assertion the judge could not decide is not one it
 * decided correctly.
 */
function comparisons(rows: readonly JudgeAgreementInput[]): { human: "pass" | "fail"; judge: "pass" | "fail" }[] {
	const pairs: { human: "pass" | "fail"; judge: "pass" | "fail" }[] = [];
	for (const row of rows) {
		if (row.assertions && row.judgeAssertions && row.assertions.length === row.judgeAssertions.length) {
			for (const [index, human] of row.assertions.entries()) {
				pairs.push({
					human: human === "yes" ? "pass" : "fail",
					judge: row.judgeAssertions[index] === "yes" ? "pass" : "fail",
				});
			}
			continue;
		}
		pairs.push({ human: row.human, judge: row.judge });
	}
	return pairs;
}

function scoringIdentity(input: JudgeAgreementInput): string {
	return JSON.stringify({
		human: input.human,
		judge: input.judge,
		assertions: input.assertions ?? null,
		judgeAssertions: input.judgeAssertions ?? null,
	});
}

/**
 * One subject contributes at most once. Identical repeats are harmless but do
 * not add confidence; contradictory human answers make that subject unusable
 * until the conflict is resolved, so the whole group is dropped fail-closed.
 */
function independentSubjects(inputs: readonly JudgeAgreementInput[]): {
	rows: JudgeAgreementInput[];
	duplicateLabels: number;
	conflictedSubjects: number;
} {
	const groups = new Map<string, { first: JudgeAgreementInput; scoring: string; rows: number; conflicted: boolean }>();
	for (const [index, input] of inputs.entries()) {
		const key = input.calibrationSubjectId ?? `unkeyed:${index}`;
		const scoring = scoringIdentity(input);
		const existing = groups.get(key);
		if (!existing) {
			groups.set(key, { first: input, scoring, rows: 1, conflicted: false });
			continue;
		}
		existing.rows += 1;
		if (existing.scoring !== scoring) existing.conflicted = true;
	}
	let duplicateLabels = 0;
	let conflictedSubjects = 0;
	const rows: JudgeAgreementInput[] = [];
	for (const group of groups.values()) {
		duplicateLabels += group.rows - 1;
		if (group.conflicted) {
			conflictedSubjects += 1;
			continue;
		}
		rows.push(group.first);
	}
	return { rows, duplicateLabels, conflictedSubjects };
}

function statsFor(inputs: readonly JudgeAgreementInput[]): JudgeAgreementStats {
	const independent = independentSubjects(inputs);
	const rows = comparisons(independent.rows);
	if (rows.length === 0) {
		return {
			...EMPTY,
			duplicateLabels: independent.duplicateLabels,
			conflictedSubjects: independent.conflictedSubjects,
		};
	}
	const truePass = rows.filter((row) => row.judge === "pass" && row.human === "pass").length;
	const trueFail = rows.filter((row) => row.judge === "fail" && row.human === "fail").length;
	const falsePass = rows.filter((row) => row.judge === "pass" && row.human === "fail").length;
	const falseFail = rows.filter((row) => row.judge === "fail" && row.human === "pass").length;
	const nChecks = rows.length;
	return {
		n: independent.rows.length,
		nChecks,
		duplicateLabels: independent.duplicateLabels,
		conflictedSubjects: independent.conflictedSubjects,
		agreement: (truePass + trueFail) / nChecks,
		kappa: cohensKappa({ n: nChecks, truePass, trueFail, falsePass, falseFail }),
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

/** What a Target may demand of its judge before promoting evidence it graded. */
export interface JudgeCalibrationRequirement {
	minAgreement: number;
	minLabels: number;
}

/**
 * Why this promotion may not proceed, or null when it may.
 *
 * Separate from the promotion path that throws it so the rule can be read,
 * tested, and quoted on a screen without a git repository in scope. Evidence
 * that no judge graded is never blocked: the policy is about an instrument,
 * and an instrument that was not used decided nothing.
 */
export function judgeCalibrationRefusal(
	requirement: JudgeCalibrationRequirement | undefined,
	evidence: {
		judgeGraderSpecs: number;
		stats: JudgeAgreementStats | null;
		/** Exact coverage for every judge grader spec used by the evidence. */
		byGraderSpec?: readonly {
			graderSpecHash: string;
			judgeFingerprintHash?: string;
			stats: JudgeAgreementStats | null;
		}[];
	},
): string | null {
	if (!requirement || evidence.judgeGraderSpecs === 0) return null;
	if (evidence.byGraderSpec) {
		const insufficient = evidence.byGraderSpec.filter(({ stats }) =>
			(stats?.n ?? 0) < requirement.minLabels || (stats?.agreement ?? 0) < requirement.minAgreement
		);
		if (insufficient.length === 0 && evidence.byGraderSpec.length === evidence.judgeGraderSpecs) return null;
		const coverage = insufficient
			.map(({ graderSpecHash, judgeFingerprintHash, stats }) =>
				`${graderSpecHash.slice(0, 15)}…${judgeFingerprintHash ? ` / judge ${judgeFingerprintHash.slice(0, 15)}…` : ""}: ` +
				`${stats?.n ?? 0} subject(s) at ${Math.round((stats?.agreement ?? 0) * 100)}%`
			)
			.join(", ");
		return `this evidence is graded by ${evidence.judgeGraderSpecs} judge grader spec(s), but each spec ` +
			`requires at least ${requirement.minLabels} independent subject(s) at ${Math.round(requirement.minAgreement * 100)}%; ` +
			`insufficient coverage: ${coverage || "unreported grader spec"}`;
	}
	const labels = evidence.stats?.n ?? 0;
	const agreement = evidence.stats?.agreement ?? 0;
	if (labels >= requirement.minLabels && agreement >= requirement.minAgreement) return null;
	return `this evidence is graded by ${evidence.judgeGraderSpecs} judge grader spec(s) ` +
		`with ${labels} human label(s) at ${Math.round(agreement * 100)}% agreement; ` +
		`the Target requires at least ${requirement.minLabels} label(s) at ${Math.round(requirement.minAgreement * 100)}%`;
}

/**
 * `84% · κ 0.62 · n=50` from the reduced projection every screen carries — the
 * three numbers, without the caveats only the full sample knows about.
 */
export function formatJudgeAgreementSummary(
	stats: { agreement: number; kappa: number | null; labels: number },
): string {
	const kappa = stats.kappa === null ? "κ n/a" : `κ ${stats.kappa.toFixed(2)}`;
	return `${Math.round(stats.agreement * 100)}% · ${kappa} · n=${stats.labels}`;
}

/** `84% · κ 0.62 · n=50`, the one line every screen shows. */
export function formatJudgeAgreement(stats: JudgeAgreementStats): string {
	const kappa = stats.kappa === null ? "κ n/a" : `κ ${stats.kappa.toFixed(2)}`;
	const checks = stats.nChecks === stats.n ? "" : ` · checks=${stats.nChecks}`;
	const duplicates = stats.duplicateLabels === 0 ? "" : ` · duplicates=${stats.duplicateLabels}`;
	const conflicts = stats.conflictedSubjects === 0 ? "" : ` · conflicts=${stats.conflictedSubjects}`;
	return `${formatJudgeAgreementSummary({ agreement: stats.agreement, kappa: stats.kappa, labels: stats.n })}` +
		`${checks}${duplicates}${conflicts}`;
}
