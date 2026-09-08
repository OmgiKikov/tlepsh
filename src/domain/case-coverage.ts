/**
 * The basket as a matrix, and where each case came from.
 *
 * A basket is not a pile of cases: it is the Spec's jobs crossed with how hard
 * a case is, and — for conversations — how the person behaves and what state
 * the world starts in. Density is what tells the author which cells are empty,
 * and origin is what keeps a synthetic case from being mistaken for a real one.
 *
 * Nothing here removes or ranks a case. The matrix reports; the author decides.
 */
import {
	CaseDifficultySchema,
	SimulatedUserBehaviorSchema,
	type CaseCoverage,
	type CaseDifficulty,
	type CaseSource,
	type SimulatedUserBehavior,
} from "../manifest.js";

export const CASE_DIFFICULTIES: readonly CaseDifficulty[] = CaseDifficultySchema.options;
export const SIMULATED_USER_BEHAVIORS: readonly SimulatedUserBehavior[] = SimulatedUserBehaviorSchema.options;

/** Real = a person actually said it; synthetic = a model wrote it from a source; unknown = nobody said. */
export type CaseOrigin = "real" | "synthetic" | "unknown";

export function caseOrigin(task: { source?: CaseSource | undefined }): CaseOrigin {
	switch (task.source?.kind) {
		case "import":
		case "feedback":
		case "production":
			return "real";
		case "kb":
		case "spec":
		case "generated":
			return "synthetic";
		default:
			return "unknown";
	}
}

export interface CoverageJobRow {
	job: string;
	/** Whether the approved Spec lists this job; an unknown job is the author's own label. */
	known: boolean;
	byDifficulty: Record<CaseDifficulty, number>;
	total: number;
}

export interface CoverageDensity {
	jobs: CoverageJobRow[];
	/** Cases that carry no coverage label at all. */
	unlabelled: number;
	behaviors: Partial<Record<SimulatedUserBehavior, number>>;
	/** Distinct world-state labels the cases start in. */
	states: string[];
	/** Spec jobs × difficulties nobody wrote a case for, in Spec order. */
	missing: { job: string; difficulty: CaseDifficulty }[];
	/** Spec jobs with no case at all. */
	uncoveredJobs: string[];
	byOrigin: Record<CaseOrigin, number>;
}

function emptyRow(job: string, known: boolean): CoverageJobRow {
	const byDifficulty = Object.fromEntries(CASE_DIFFICULTIES.map((difficulty) => [difficulty, 0])) as Record<CaseDifficulty, number>;
	return { job, known, byDifficulty, total: 0 };
}

/**
 * Count the cases per cell. `jobs` is the approved Spec's list; a case whose
 * job is not on it still counts, under its own label, so an author's wording
 * never disappears — it is reported as unknown instead.
 */
export function coverageDensity(
	tasks: readonly { coverage?: CaseCoverage | undefined; source?: CaseSource | undefined }[],
	jobs: readonly string[],
): CoverageDensity {
	const rows = new Map<string, CoverageJobRow>();
	for (const job of jobs) rows.set(job, emptyRow(job, true));
	const behaviors: Partial<Record<SimulatedUserBehavior, number>> = {};
	const states = new Set<string>();
	const byOrigin: Record<CaseOrigin, number> = { real: 0, synthetic: 0, unknown: 0 };
	let unlabelled = 0;
	for (const task of tasks) {
		byOrigin[caseOrigin(task)] += 1;
		const coverage = task.coverage;
		if (!coverage) {
			unlabelled += 1;
			continue;
		}
		let row = rows.get(coverage.job);
		if (!row) {
			row = emptyRow(coverage.job, false);
			rows.set(coverage.job, row);
		}
		row.byDifficulty[coverage.difficulty] += 1;
		row.total += 1;
		if (coverage.behavior) behaviors[coverage.behavior] = (behaviors[coverage.behavior] ?? 0) + 1;
		if (coverage.state) states.add(coverage.state);
	}
	const missing: { job: string; difficulty: CaseDifficulty }[] = [];
	const uncoveredJobs: string[] = [];
	for (const job of jobs) {
		const row = rows.get(job)!;
		if (row.total === 0) uncoveredJobs.push(job);
		for (const difficulty of CASE_DIFFICULTIES) {
			if (row.byDifficulty[difficulty] === 0) missing.push({ job, difficulty });
		}
	}
	return {
		jobs: [...rows.values()],
		unlabelled,
		behaviors,
		states: [...states].sort(),
		missing,
		uncoveredJobs,
		byOrigin,
	};
}

/** `job × difficulty` cells, the way `next` and the panel name them. */
export function coverageCellLabel(cell: { job: string; difficulty: CaseDifficulty }): string {
	return `${cell.job} × ${cell.difficulty}`;
}
