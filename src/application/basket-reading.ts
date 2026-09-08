/**
 * Reading the basket after a run.
 *
 * The rule above every line of this module: **a case is never removed, ranked
 * down or recommended for removal because the agent failed it.** A correct case
 * that fails every repetition is capability work — it stays, its cause is
 * analysed, the agent is fixed. A case the critic doubts is a question about the
 * test's own criteria and conditions, and the answer is a repair or an exclusion
 * that names its reason — never a deletion for a low pass rate. A case that
 * passes every time stays as a regression check and the next wave is written
 * harder. Selection must not improve the metrics by deleting hard tasks, so
 * nothing here returns a "drop", a "worst cases" list or an order that would be
 * read as one.
 *
 * What it does return is four readings of the same basket, from facts that are
 * already recorded: how each case stood in this run, what the critic said about
 * the case itself, where the case came from, and what the wave added. The
 * comparison between synthetic and real cases is deliberately narrow — only
 * cells with the same job, difficulty and world state, because a synthetic
 * basket may hold harder scenarios on purpose and a raw pass-rate gap between
 * the two would say nothing.
 */
import { stableTasks, type TaskRun } from "../compare.js";
import { CASE_DIFFICULTIES, caseOrigin, coverageDensity } from "../domain/case-coverage.js";
import { compareUtf8 } from "../domain/comparison-gate.js";
import type { CorpusTask } from "../corpus.js";
import type { CaseDifficulty } from "../manifest.js";
import type { CriticReceipt } from "./case-critic.js";
import type {
	WorkbenchBasketCase,
	WorkbenchBasketOriginCell,
	WorkbenchBasketReading,
	WorkbenchBasketStanding,
	WorkbenchBasketValidity,
} from "../workbench/types.js";

/** A pass-rate gap is reported in points, the unit the gate's own deltas use. */
const POINTS_PER_UNIT = 100;

export interface ReadBasketInput {
	evalRunId: string;
	/** The design this run used; what a case's `pass/total` was measured against. */
	repetitions: number;
	/** Every run of the eval, all repetitions. */
	runs: readonly TaskRun[];
	/** The published corpus the run measured; coverage and source may be absent. */
	tasks: readonly CorpusTask[];
	/** The approved Spec's jobs, in Spec order. */
	jobs: readonly string[];
	/** Task ids of the previous published corpus of this lineage; null when there is none. */
	previousTaskIds: readonly string[] | null;
	/** The critic's receipt for this corpus, when it has read it. */
	critic: CriticReceipt | null;
	/** Titles of the failure modes still failing on this run. */
	unresolvedModes: readonly string[];
}

/** Repetitions that produced a verdict, and how many of them the agent passed. */
interface Measured {
	pass: number;
	total: number;
}

/**
 * How each case stood, over the repetitions that actually decided something.
 *
 * The pass count comes from the comparison's own per-task aggregate, so "passed"
 * here means exactly what it means on every other screen. The errored
 * repetitions are then taken out of the denominator: a repetition the engine
 * lost is the harness's answer, not the agent's, and counting it as a failure
 * would file an infrastructure outage under the agent's capability. A case that
 * lost every repetition has no standing at all rather than a standing of zero.
 */
function measuredRepetitions(runs: readonly TaskRun[]): Map<string, Measured> {
	const errors = new Map<string, number>();
	for (const run of runs) if (run.status === "error") errors.set(run.taskId, (errors.get(run.taskId) ?? 0) + 1);
	const measured = new Map<string, Measured>();
	for (const row of stableTasks(runs).perTask) {
		measured.set(row.taskId, { pass: row.pass, total: Math.max(0, row.total - (errors.get(row.taskId) ?? 0)) });
	}
	return measured;
}

/** Saturated is every decided repetition passed; failing is none of them did. */
function standingOf(measured: Measured): WorkbenchBasketStanding {
	if (measured.total === 0) return "unstable";
	if (measured.pass === measured.total) return "saturated";
	if (measured.pass === 0) return "failing";
	return "unstable";
}

/** A cell of the origin comparison while it is still being counted. */
interface CellTally {
	job: string;
	difficulty: CaseDifficulty;
	state: string | null;
	real: { cases: number; pass: number; total: number };
	synthetic: { cases: number; pass: number; total: number };
}

/** `job × difficulty × state`, joined on a character no label may contain. */
function cellKey(job: string, difficulty: CaseDifficulty, state: string | null): string {
	return [job, difficulty, state ?? ""].join("\u0000");
}

function difficultyOrder(difficulty: CaseDifficulty): number {
	return CASE_DIFFICULTIES.indexOf(difficulty);
}

/**
 * Synthetic against real, in the only comparison that carries information: the
 * same job, the same difficulty, the same world state.
 *
 * Realism and difficulty are two different questions. A synthetic basket is
 * allowed to hold the harder scenarios on purpose, so a gap between the two
 * origins over the whole basket compares nothing; inside one cell it is a fact
 * about the cases, and it is reported as information, never as a verdict on
 * either origin and never as a reason to regenerate anything.
 *
 * Only a case with a decided standing counts: a case whose every repetition
 * errored has no pass rate to average, and lending it a zero would move the
 * cell by a number nobody measured.
 */
function comparableCells(cases: readonly WorkbenchBasketCase[]): WorkbenchBasketOriginCell[] {
	const tallies = new Map<string, CellTally>();
	for (const item of cases) {
		if (!item.coverage || item.total === 0) continue;
		if (item.origin !== "real" && item.origin !== "synthetic") continue;
		const state = item.coverage.state ?? null;
		const key = cellKey(item.coverage.job, item.coverage.difficulty, state);
		const tally = tallies.get(key) ?? {
			job: item.coverage.job,
			difficulty: item.coverage.difficulty,
			state,
			real: { cases: 0, pass: 0, total: 0 },
			synthetic: { cases: 0, pass: 0, total: 0 },
		};
		const side = tally[item.origin];
		side.cases += 1;
		side.pass += item.pass;
		side.total += item.total;
		tallies.set(key, tally);
	}
	return [...tallies.values()]
		.filter((tally) => tally.real.cases > 0 && tally.synthetic.cases > 0)
		.map((tally) => {
			const realRate = tally.real.pass / tally.real.total;
			const syntheticRate = tally.synthetic.pass / tally.synthetic.total;
			return {
				job: tally.job,
				difficulty: tally.difficulty,
				state: tally.state,
				real: { cases: tally.real.cases, passRate: realRate },
				synthetic: { cases: tally.synthetic.cases, passRate: syntheticRate },
				gapPoints: Math.round((syntheticRate - realRate) * POINTS_PER_UNIT),
			};
		})
		.sort((left, right) =>
			compareUtf8(left.job, right.job) ||
			difficultyOrder(left.difficulty) - difficultyOrder(right.difficulty) ||
			compareUtf8(left.state ?? "", right.state ?? "")
		);
}

/**
 * The basket, read once, from the run that measured it.
 *
 * Nothing in the returned reading removes a case or asks for one to be removed:
 * `failingValid` is capability work on the agent, `failingDoubtful` is a review
 * of the test's own criteria, `saturated` is a regression check kept forever,
 * and the next wave is aimed at the cells nobody has written a case for.
 */
export function readBasket(input: ReadBasketInput): WorkbenchBasketReading {
	const measured = measuredRepetitions(input.runs);
	const verdicts = new Map<string, WorkbenchBasketValidity>(
		(input.critic?.findings ?? []).map((finding) => [finding.taskId, finding.verdict]),
	);
	// A wave exists only against a previous publication of this lineage. With no
	// previous corpus every case is as old as the basket itself, so nothing is
	// "new" and the wave is absent rather than claiming the whole basket is one.
	const previous = input.previousTaskIds === null ? null : new Set(input.previousTaskIds);
	const caseOf = (taskId: string, task: CorpusTask | null): WorkbenchBasketCase => {
		const stats = measured.get(taskId) ?? { pass: 0, total: 0 };
		return {
			taskId,
			standing: standingOf(stats),
			pass: stats.pass,
			total: stats.total,
			validity: verdicts.get(taskId) ?? "unreviewed",
			origin: caseOrigin(task ?? {}),
			coverage: task?.coverage ?? null,
			newInWave: previous !== null && !previous.has(taskId),
		};
	};
	const cases = input.tasks.map((task) => caseOf(task.id, task));
	// A case the run measured that the corpus no longer lists is still reported,
	// with what is known about it. Silently leaving a measured case out of the
	// reading would be exactly the deletion this module refuses.
	const listed = new Set(cases.map((item) => item.taskId));
	for (const taskId of [...measured.keys()].filter((id) => !listed.has(id)).sort(compareUtf8)) {
		cases.push(caseOf(taskId, null));
	}

	const standing = (value: WorkbenchBasketStanding): WorkbenchBasketCase[] => cases.filter((item) => item.standing === value);
	const failing = standing("failing");
	const newCases = cases.filter((item) => item.newInWave);
	// Origins are counted off the cases this reading names, so the numbers on the
	// panel always add up to the list underneath them.
	const origins = { real: 0, synthetic: 0, unknown: 0 };
	for (const item of cases) origins[item.origin] += 1;
	const comparable = comparableCells(cases);
	const density = coverageDensity(input.tasks, input.jobs);
	return {
		evalRunId: input.evalRunId,
		cases,
		counts: {
			saturated: standing("saturated").length,
			failing: failing.length,
			unstable: standing("unstable").length,
			failingValid: failing.filter((item) => item.validity === "valid").length,
			failingDoubtful: failing.filter((item) => item.validity === "repair" || item.validity === "invalid").length,
			failingUnreviewed: failing.filter((item) => item.validity === "unreviewed").length,
		},
		wave: previous === null ? null : {
			newCases: newCases.length,
			newFailing: newCases.filter((item) => item.standing === "failing").length,
			// The whole wave passing is saturation: the cases were too easy for the
			// agent as it already is, and the next wave has to be harder.
			saturated: newCases.length > 0 && newCases.every((item) => item.standing === "saturated"),
		},
		origins: {
			...origins,
			comparable,
			// Until a real case sits in the same cell as a synthetic one, nothing
			// has compared the simulator with a person and the reading says so.
			realism: comparable.length > 0 ? "compared" : "unverified",
		},
		nextWave: {
			emptyCells: density.missing,
			targetModes: [...input.unresolvedModes],
			// A job the agent already passes everywhere is where the next wave gets
			// harder — not where its cases get thrown away.
			harderJobs: input.jobs.filter((job) => {
				const labelled = cases.filter((item) => item.coverage?.job === job);
				return labelled.length > 0 && labelled.every((item) => item.standing === "saturated");
			}),
		},
	};
}
