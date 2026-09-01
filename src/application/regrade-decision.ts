import {
	isSealedEvalRun,
	listEvalRunIndexesLenient,
	loadEvalRun,
	loadRun,
	type EvalRunRecord,
} from "../eval.js";
import {
	GraderSpec,
	type ResolvedTarget,
	type ResolvedTask,
	suiteHashOf,
	type Task,
} from "../manifest.js";
import { canonicalJson, modelFingerprint, type ModelFingerprint, type RunRecord } from "../provenance.js";
import type { RegradeResult } from "../regrade.js";
import { redactTraceText } from "../trace.js";
import { runOutcome, runScore, type RunOutcome } from "./run-explanation.js";

/**
 * Re-scoring recorded answers with a rubric the operator just changed.
 *
 * The engine (`src/regrade.ts`) already knows how to grade a recorded trace
 * again without calling the Target. What it deliberately refuses is a *case*
 * it never saw: the resolved dataset must hash-match the source EvalRun, and
 * that hash covers each case's own graders. On the manifest dataset that is no
 * obstacle — the graders live in `evals/graders.yaml` and the cases carry none
 * — but a published corpus carries an explicit rubric per case, so every
 * grader edit moves the corpus hash and the engine's own rule refuses it.
 *
 * That rule protects one thing: a trace must never be re-scored against a
 * question it never answered. A rubric is not a question. So this module
 * separates the two halves of a case:
 *
 *  - the QUESTION — input, reference answer, seeded dialogue, simulated-user
 *    plan, metadata. It must be byte-identical, and the pairing below refuses
 *    the whole regrade when it is not, in the operator's words rather than as
 *    a hash mismatch.
 *  - the RUBRIC — the graders. This is exactly what a regrade exists to change.
 *
 * A revised case set therefore re-scores under the source's own dataset
 * identity (the questions are the source's, and the derived EvalRun records
 * the source `datasetHash` regardless) while its suite identity is minted from
 * the graders that actually decided. That keeps invariant 15 honest in the
 * direction that matters: a regrade whose rubric changed is comparable only to
 * evidence scored the same way, and it can never stand in for the basket it
 * came from.
 */

/** Where the graders that decide the new verdict come from. */
export type RegradeGraderSource = "draft" | "target";

/** Flipped members named in one result. The panel shows fewer. */
const MAX_FLIPS = 50;
/** Cases whose rubric changed, named in one result. */
const MAX_CHANGED_GRADERS = 50;
/** Eval runs sampled to price the judge, newest first. */
const ESTIMATE_EVAL_RUNS = 3;
/** Member runs opened in total; the estimate is a mean, not an audit. */
const ESTIMATE_RUNS = 60;
/** Characters of any rendered grader spec. */
const MAX_GRADER_CHARS = 80;

export class RegradeRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RegradeRefused";
	}
}

/** One case whose rubric the revision rewrote, as a human reads it. */
export interface RegradeGraderChange {
	taskId: string;
	before: string[];
	after: string[];
}

/** One member run whose verdict the new rubric moved. */
export interface RegradeCaseFlip {
	taskId: string;
	repetitionIndex: number;
	from: RunOutcome;
	to: RunOutcome;
	/** The grader whose own verdict moved with it, when exactly one did. */
	grader: { name: string; type: string } | null;
	/** Assertion indexes of a rubric whose answers moved, and where they moved to. */
	assertions: { index: number; to: "yes" | "no" }[];
}

/** Everything one regrade says about itself. Sealed sources say far less. */
export interface RegradeDiff {
	evalRunId: string;
	sourceEvalRunId: string;
	graders: RegradeGraderSource;
	/** Distinct cases re-scored; `total` counts every recorded repetition. */
	cases: number;
	total: number;
	passBefore: number;
	passAfter: number;
	passRateBefore: number;
	passRateAfter: number;
	meanScoreBefore: number;
	meanScoreAfter: number;
	nowPassing: number;
	nowFailing: number;
	unchanged: number;
	flips: RegradeCaseFlip[];
	changedGraders: RegradeGraderChange[];
	/** Cases whose rubric changed in total; `changedGraders` is bounded. */
	changedGraderCount: number;
	judge: { calls: number; tokens: number; costUsd: number };
	/** Zero by construction: a regrade re-scores what is already recorded. */
	targetExecutions: 0;
	sealed: boolean;
}

/** What a regrade is expected to cost. Only the judge is ever billed. */
export interface RegradeJudgeEstimate {
	/**
	 * Gradings this regrade will run — never a Target execution. It is the
	 * routine cost guard's unit of work, and the confirmation says in words
	 * that the Target is not called.
	 */
	executions: number;
	sampledRuns: number;
	costUsd: number | null;
	minutes: number | null;
}

// ---------------------------------------------------------------------------
// Pairing a revised case set to the one the traces answered.

/** Everything about a case except the rubric that scores it. */
function questionIdentity(task: Pick<Task, "input" | "expected" | "messages" | "simulatedUser" | "metadata">): string {
	return canonicalJson({
		input: task.input,
		expected: task.expected,
		messages: task.messages,
		simulatedUser: task.simulatedUser,
		metadata: task.metadata,
	});
}

function graderIdentity(graders: readonly GraderSpec[]): string {
	return canonicalJson(graders);
}

/** One grader spec on one line: its type and the part an operator recognises. */
export function describeGrader(spec: GraderSpec): string {
	const detail = ((): string => {
		switch (spec.type) {
			case "tool_called": return spec.tool;
			case "output_contains": return spec.text;
			case "output_matches": return `/${spec.pattern}/`;
			case "judge": return spec.assertions ? spec.assertions.join(" · ") : spec.rubric ?? "";
			case "no_secret": return "redaction";
			case "exact": return spec.normalize;
			case "similarity": return `${spec.metric} >= ${spec.threshold}`;
			case "turn_budget": return `<= ${spec.max} turns`;
		}
	})();
	const text = redactTraceText(detail).replace(/\s+/gu, " ").trim();
	const bounded = [...text].length > MAX_GRADER_CHARS
		? `${[...text].slice(0, MAX_GRADER_CHARS - 1).join("")}…`
		: text;
	return bounded ? `${spec.type}: ${bounded}` : spec.type;
}

export interface RegradeGraderPlan {
	/** The Target the engine re-scores with: the source's questions, the new rubrics. */
	target: ResolvedTarget;
	changed: RegradeGraderChange[];
}

/** One case of a revised basket: its question, and the rubric that now scores it. */
export type RevisedCase = Pick<Task, "input" | "expected" | "messages" | "simulatedUser" | "metadata"> & {
	graders: readonly GraderSpec[];
};

/**
 * Bind a revised rubric set to the exact cases a recorded EvalRun scored.
 *
 * `revised` is `null` for the `target` source: the graders the basket already
 * carries, which re-runs the judge under today's rubric and is meaningful only
 * when the judge model itself moved. Anything else is refused as a no-op
 * rather than billed.
 */
export function planRegradeGraders(input: {
	/** The exact cases the recorded traces answered. */
	scored: ResolvedTarget;
	/** The revised cases, or null to keep the ones the basket carries. */
	revised: readonly RevisedCase[] | null;
	/** The judge the source evidence was scored by, for the no-op refusal. */
	sourceJudge: ModelFingerprint | null;
}): RegradeGraderPlan {
	const scored = input.scored;
	const currentJudge = scored.manifest.evalSuite.judge;
	// The one thing besides the rubric that can move a judged verdict: the model
	// reading it. Same fingerprint the derived EvalRun records as its judge axis,
	// so "nothing changed" here means exactly what the provenance will say.
	const judgeMoved = canonicalJson(input.sourceJudge ?? null) !==
		canonicalJson(currentJudge ? modelFingerprint(currentJudge) : null);

	if (!input.revised) {
		if (!judgeMoved) {
			throw new RegradeRefused(
				"these are the graders that already scored this run, and the judge behind them has not changed: " +
				"there is nothing to re-score. Revise the rubric first, then re-score the draft.",
			);
		}
		return { target: scored, changed: [] };
	}

	const revised = input.revised;
	if (revised.length !== scored.tasks.length) {
		throw new RegradeRefused(
			`the draft has ${revised.length} case(s) and the recorded answers cover ${scored.tasks.length}: ` +
			"a re-score can change the graders, never the questions. Publish the revised cases and run them instead.",
		);
	}

	const byQuestion = new Map<string, RevisedCase>();
	for (const task of revised) {
		const identity = questionIdentity(task);
		if (byQuestion.has(identity)) {
			throw new RegradeRefused("the draft has two cases asking the same question; re-scoring cannot tell them apart");
		}
		byQuestion.set(identity, task);
	}

	const tasks: ResolvedTask[] = [];
	const changed: RegradeGraderChange[] = [];
	for (const task of scored.tasks) {
		const twin = byQuestion.get(questionIdentity(task));
		if (!twin) {
			throw new RegradeRefused(
				"the draft changed what the cases ask, not only how they are graded: " +
				"the recorded answers answered different questions. Publish the revised cases and run them instead.",
			);
		}
		// Normalized before it is compared or used: a rubric typed into a draft
		// omits the schema's own defaults, and an omitted default is not a change.
		const graders = twin.graders.map((grader) => GraderSpec.parse(grader));
		if (graderIdentity(task.effectiveGraders) !== graderIdentity(graders)) {
			changed.push({
				taskId: task.id,
				before: task.effectiveGraders.map(describeGrader),
				after: graders.map(describeGrader),
			});
		}
		tasks.push({ ...task, graders, effectiveGraders: graders.map((grader) => ({ ...grader })) });
	}

	if (changed.length === 0 && !judgeMoved) {
		throw new RegradeRefused(
			"the draft's graders are the ones that already scored this run: there is nothing to re-score.",
		);
	}

	// The questions are the source's, so the dataset identity is too. The suite
	// identity is minted from the rubrics that actually decided, which is what
	// keeps this derived evidence out of every comparison it does not belong in.
	const suiteHash = suiteHashOf(
		tasks,
		scored.graderDefaults,
		scored.manifest.evalSuite.judge ?? null,
		scored.manifest.evalSuite.simulatedUser ?? null,
	);
	return {
		target: { ...scored, tasks, suiteHash, suiteIdentity: "manifest" },
		changed: changed.slice(0, MAX_CHANGED_GRADERS),
	};
}

// ---------------------------------------------------------------------------
// Which recorded evaluation is being re-scored.

/**
 * The evidence a re-score is about: the one the operator named, or the newest
 * *measured* development evaluation — a regrade of a regrade is a legal thing
 * to ask for by name, but it is never what “re-score the run I just read”
 * means.
 *
 * Sealed evidence is never re-scored here, and the refusal says so rather than
 * pretending the id does not exist. What stays hidden about an exam is its
 * content; the caller already held the id.
 *
 * Returns null when the named id is neither development evidence nor an exam:
 * the caller owns the “which one did you mean” question.
 */
export function resolveRegradeSource(input: {
	/** The project's development evidence, newest first. */
	evals: readonly EvalRunSource[];
	explicitId?: string;
	/** Reads one eval run index by id, or throws. Used only to classify a miss. */
	readIndex: (evalRunId: string) => EvalRunSource;
}): EvalRunSource | null {
	const measured = input.evals.filter((run) => run.regradeOf === undefined);
	if (input.explicitId) {
		const exact = input.evals.find((run) => run.evalRunId === input.explicitId);
		if (exact) return exact;
		let index: EvalRunSource | null = null;
		try {
			index = input.readIndex(input.explicitId);
		} catch {
			index = null;
		}
		if (index && isSealedEvalRun(index)) {
			throw new RegradeRefused(
				`eval run ${input.explicitId} measured the sealed exam; a sealed verdict is never re-scored in the conversation.`,
			);
		}
		return null;
	}
	const newest = measured[0];
	if (!newest) {
		throw new RegradeRefused("there is no recorded development evaluation to re-score yet; run the basket first");
	}
	return newest;
}

/** The little of an EvalRun this module needs to choose and price one. */
export type EvalRunSource = Pick<
	EvalRunRecord,
	"evalRunId" | "dataset" | "datasetHash" | "evidenceVisibility" | "regradeOf" | "runIds"
>;

// ---------------------------------------------------------------------------
// What the judge is about to cost.

/**
 * What re-scoring these recorded answers is expected to cost.
 *
 * The two halves come from two different artifacts, because the records hold
 * them in two different places:
 *
 *  - MONEY is the mean recorded judge spend of a graded run on this Target,
 *    times the runs this regrade will grade again. A judge bill is per run and
 *    it is written on the run.
 *  - WALL CLOCK is the mean seconds per graded run of the regrades that have
 *    already finished on this Target. A judge call records no latency of its
 *    own, and a full run's elapsed time is mostly the Target's — which a
 *    regrade never pays. Until one regrade has finished, the honest answer is
 *    that the duration is unknown, and the cost guard asks once.
 */
export function estimateRegradeJudgeSpend(input: {
	runsRoot: string;
	targetId: string;
	/** Recorded member runs this regrade will grade again. */
	gradings: number;
}): RegradeJudgeEstimate {
	const executions = Math.max(0, Math.trunc(input.gradings));
	let indexes: ReturnType<typeof listEvalRunIndexesLenient>["records"];
	try {
		indexes = listEvalRunIndexesLenient(input.runsRoot).records;
	} catch {
		return { executions, sampledRuns: 0, costUsd: null, minutes: null };
	}
	const mine = indexes.filter((record) => record.target.id === input.targetId && !isSealedEvalRun(record));

	let sampled = 0;
	let costUsd = 0;
	for (const record of mine.slice(0, ESTIMATE_EVAL_RUNS)) {
		for (const runId of record.runIds) {
			if (sampled >= ESTIMATE_RUNS) break;
			let run: RunRecord;
			try {
				run = loadRun(input.runsRoot, runId);
			} catch {
				continue;
			}
			// Only a graded run prices a grading: a run whose judge never ran says
			// nothing about what asking the judge again will cost.
			const judge = run.metrics.judge;
			if (run.status !== "completed" || !judge || judge.calls === 0) continue;
			sampled += 1;
			costUsd += judge.costUsd;
		}
	}

	let regrades = 0;
	let millisecondsPerRun = 0;
	for (const record of mine.filter((item) => item.regradeOf !== null).slice(0, ESTIMATE_EVAL_RUNS)) {
		const started = Date.parse(record.startedAt);
		const finished = Date.parse(record.finishedAt);
		if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) continue;
		if (record.runIds.length === 0) continue;
		regrades += 1;
		millisecondsPerRun += (finished - started) / record.runIds.length;
	}

	return {
		executions,
		sampledRuns: sampled,
		costUsd: sampled === 0 ? null : (costUsd / sampled) * executions,
		// A finished regrade already graded its runs concurrently, so its
		// per-run mean is wall clock and is never divided by jobs again.
		minutes: regrades === 0 ? null : ((millisecondsPerRun / regrades) * executions) / 60_000,
	};
}

// ---------------------------------------------------------------------------
// What changed.

/**
 * The grader whose own verdict moved with the case, and how.
 *
 * Graders are paired by POSITION, not by name: a grader's name is derived from
 * its own specification, so the one thing a regrade always changes is exactly
 * the key a by-name pairing would need. Position is what a rewritten rubric
 * keeps — case N's second check is still case N's second check.
 *
 * When the rubric changed shape (a grader was added or removed) there is no
 * pairing to make, and a new failure is attributed to the grader that actually
 * refused: the first failing check in the derived run.
 */
function decidingGrader(before: RunRecord, after: RunRecord): Pick<RegradeCaseFlip, "grader" | "assertions"> {
	const previous = before.evalResults?.graders ?? [];
	const current = after.evalResults?.graders ?? [];
	const named = (grader: { name: string; type: string }): RegradeCaseFlip["grader"] => ({
		name: redactTraceText(grader.name).slice(0, 200),
		type: grader.type,
	});

	const movedIndex = current.findIndex((grader, index) => {
		const was = previous[index];
		return was !== undefined && was.passed !== grader.passed;
	});
	if (movedIndex < 0) {
		const refused = current.find((grader) => !grader.passed);
		return refused ? { grader: named(refused), assertions: [] } : { grader: null, assertions: [] };
	}

	const decided = current[movedIndex]!;
	const was = previous[movedIndex]!;
	const assertions: { index: number; to: "yes" | "no" }[] = [];
	if (decided.assertions && was.assertions) {
		const wasFailed = new Set(was.assertions.failed);
		const nowFailed = new Set(decided.assertions.failed);
		for (let index = 1; index <= decided.assertions.total; index += 1) {
			if (wasFailed.has(index) && !nowFailed.has(index)) assertions.push({ index, to: "yes" });
			else if (!wasFailed.has(index) && nowFailed.has(index)) assertions.push({ index, to: "no" });
		}
	}
	return { grader: named(decided), assertions: assertions.slice(0, 8) };
}

/**
 * The regrade as a difference, read back from the two immutable EvalRuns.
 *
 * Sealed evidence carries counts only: which case changed verdict is itself
 * holdout information, and so is the rubric that decided it.
 */
export function compileRegradeDiff(input: {
	runsRoot: string;
	result: RegradeResult;
	graders: RegradeGraderSource;
	changed: readonly RegradeGraderChange[];
}): RegradeDiff {
	const { result } = input;
	const after = loadEvalRun(input.runsRoot, result.record.evalRunId);
	const derived = after.runIds.map((runId) => loadRun(input.runsRoot, runId));
	const sources = new Map<string, RunRecord>();
	for (const run of derived) {
		const from = run.derivedFrom;
		if (!from) continue;
		try {
			sources.set(run.runId, loadRun(input.runsRoot, from.runId));
		} catch {
			// A source whose record cannot be re-read narrows the diff; the
			// aggregate summaries below still come from the two indexes.
		}
	}

	const total = derived.length;
	const flips: RegradeCaseFlip[] = [];
	let nowPassing = 0;
	let nowFailing = 0;
	let unchanged = 0;
	let scoreBefore = 0;
	let scoreAfter = 0;
	let scored = 0;
	for (const run of derived) {
		const source = sources.get(run.runId);
		if (!source) continue;
		scored += 1;
		scoreBefore += runScore(source);
		scoreAfter += runScore(run);
		const from = runOutcome(source);
		const to = runOutcome(run);
		if (from === to) {
			unchanged += 1;
			continue;
		}
		if (to === "pass") nowPassing += 1;
		else if (from === "pass") nowFailing += 1;
		if (flips.length < MAX_FLIPS) {
			flips.push({
				taskId: redactTraceText(run.taskId).slice(0, 200),
				repetitionIndex: run.repetitionIndex,
				from,
				to,
				...decidingGrader(source, run),
			});
		}
	}

	const sealed = result.sealed;
	return {
		evalRunId: result.record.evalRunId,
		sourceEvalRunId: result.source.evalRunId,
		graders: input.graders,
		cases: (result.record.taskIds ?? [...new Set(derived.map((run) => run.taskId))]).length,
		total,
		passBefore: result.source.summary.pass,
		passAfter: result.record.summary.pass,
		passRateBefore: result.source.summary.allPassRate,
		passRateAfter: result.record.summary.allPassRate,
		meanScoreBefore: scored === 0 ? 0 : scoreBefore / scored,
		meanScoreAfter: scored === 0 ? 0 : scoreAfter / scored,
		nowPassing,
		nowFailing,
		unchanged,
		// Which case moved, and which rubric moved it, is holdout content.
		flips: sealed ? [] : flips,
		changedGraders: sealed ? [] : [...input.changed].slice(0, MAX_CHANGED_GRADERS),
		changedGraderCount: input.changed.length,
		judge: { calls: result.judge.calls, tokens: result.judge.tokens, costUsd: result.judge.costUsd },
		targetExecutions: 0,
		sealed,
	};
}
