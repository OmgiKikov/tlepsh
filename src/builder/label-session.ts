/**
 * `/label` — checking the judge, as a ten-minute exercise inside the
 * conversation instead of a second terminal.
 *
 * The operator grades a sample of the answers a judge already graded, blind,
 * one at a time, and only then sees what the judge said. What comes out is a
 * number about the instrument: how far the judge and this human agree, and
 * which way it errs when they do not.
 *
 * Everything durable goes through `runJudgeLabelSession`, so a label written
 * here is byte-identical to one written by `ahde label`: the same file, the
 * same lineage receipt, the same judge-fingerprint binding, appended before the
 * next question so leaving mid-way keeps every answer already given.
 */

import { t } from "../i18n.js";
import { listCorpora } from "../corpus.js";
import { isSealedEvalRun, listEvalRunIndexesLenient, type EvalRunRecord } from "../eval.js";
import { loadTarget } from "../manifest.js";
import { resolveDevelopmentTargetForEval } from "../application/corpus-target.js";
import {
	collectJudgeLabelSubjects,
	judgeEvidenceCalibration,
	judgeGraderSpecHashes,
	labelledJudgeSubjectKeys,
	type JudgeLabelSubject,
	type JudgeLabelSuite,
	type LabelAssertionAnswer,
	runJudgeLabelSession,
} from "../application/judge-labels.js";
import type { JudgeAgreementStats } from "../domain/judge-agreement.js";
import type { TranscriptTone } from "./transcript.js";
import type { Paint } from "./render/paint.js";
import {
	labelDonePanelTitle,
	labelPanelTitle,
	renderLabelReveal,
	renderLabelSubject,
	renderLabelSummary,
	type LabelSummary,
} from "./render/label.js";

/** Twenty is the operator's own number: ten minutes of reading. */
export const DEFAULT_LABEL_SAMPLE = 20;
/** Beyond fifty this stops being an exercise and becomes a second job. */
export const MAX_LABEL_SAMPLE = 50;
/** How far back to look for a judged run before giving up. */
const MAX_EVAL_RUNS_SCANNED = 12;

/** The screen this exercise draws on. One shape for the TUI and for a test. */
export interface LabelScreen {
	show(block: { title: string; tone: TranscriptTone; lines: string[] }): void;
	select(title: string, choices: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, tone: "info" | "warning"): void;
}

export interface LabelSessionOptions {
	runsRoot: string;
	stateRoot: string;
	projectId: string;
	/** The Target checkout, used only to recover the suite that graded a run. */
	targetDir: string;
	/** Whose evidence this is; null labels whatever development evidence exists. */
	targetId?: string | null;
	sample?: number;
	screen: LabelScreen;
	paint: Paint;
	now?: () => string;
	/**
	 * How the exercise recovers the exact suite an eval run was graded under.
	 * Injected so the panel can be exercised without a Git checkout; the default
	 * reads the committed Target and the published corpus it evaluated.
	 */
	suiteFor?: (evalRun: EvalRunRecord) => JudgeLabelSuite | null;
}

export interface LabelSessionResult {
	evalRunId: string;
	labelled: number;
	skipped: number;
	stopped: boolean;
	/** How many questions the draw actually produced. */
	total: number;
	/** Null only when nothing at all has been labelled for this lineage. */
	stats: JudgeAgreementStats | null;
}

/** `/label` refused: there is no judged evidence to check the judge against. */
export class NoJudgedEvidence extends Error {
	constructor() {
		super(t("label.no-judge"));
		this.name = "NoJudgedEvidence";
	}
}

/** Sealed corpus content hashes, so a legacy sealed eval run is refused too. */
function sealedCorpusHashes(stateRoot: string, projectId: string): Set<string> {
	try {
		return new Set(
			listCorpora({ stateRoot, projectId })
				.filter((corpus) => corpus.visibility === "sealed")
				.map((corpus) => corpus.hash),
		);
	} catch {
		return new Set();
	}
}

/**
 * The newest development eval run of this Target that a judge actually graded.
 *
 * Newest first, and the first one with a judge grader wins: an older run is
 * still perfectly labellable evidence, but the operator asked to check the
 * judge they are working with now.
 */
export function newestJudgedEvalRun(options: {
	runsRoot: string;
	stateRoot: string;
	projectId: string;
	targetId?: string | null;
}): EvalRunRecord | null {
	const sealed = sealedCorpusHashes(options.stateRoot, options.projectId);
	const candidates = listEvalRunIndexesLenient(options.runsRoot).records
		.filter((run) => !isSealedEvalRun(run, sealed))
		// A cheap check is a one-arm re-run of what already failed; it is not the
		// evidence anything is decided on, so it is not what a judge is checked on.
		.filter((run) => run.purpose === "evidence")
		.filter((run) => !options.targetId || run.target.id === options.targetId)
		.sort((left, right) =>
			right.startedAt.localeCompare(left.startedAt) || right.evalRunId.localeCompare(left.evalRunId)
		)
		.slice(0, MAX_EVAL_RUNS_SCANNED);
	for (const run of candidates) {
		try {
			if (judgeGraderSpecHashes(options.runsRoot, run.evalRunId).length > 0) return run;
		} catch {
			// An unreadable run is not evidence about a judge; keep looking.
		}
	}
	return null;
}

/**
 * The exact suite that graded one eval run: the committed Target when its own
 * basket is the one that ran, otherwise the published development corpus whose
 * hashes match. Failure is not fatal — the screen falls back to the legacy
 * subject and says so — because a judge check on a reachable subject beats a
 * refusal on an unreachable one.
 */
function defaultSuiteFor(options: {
	runsRoot: string;
	stateRoot: string;
	projectId: string;
	targetDir: string;
}): (evalRun: EvalRunRecord) => JudgeLabelSuite | null {
	return (evalRun) => {
		try {
			const { target } = resolveDevelopmentTargetForEval({
				target: loadTarget(options.targetDir),
				evalRun,
				stateRoot: options.stateRoot,
				projectId: options.projectId,
			});
			return { datasetHash: target.datasetHash, suiteHash: target.suiteHash, tasks: target.tasks };
		} catch {
			return null;
		}
	};
}

function clampSample(requested: number | undefined): number {
	if (requested === undefined) return DEFAULT_LABEL_SAMPLE;
	if (!Number.isInteger(requested) || requested < 1 || requested > MAX_LABEL_SAMPLE) {
		throw new Error(`/label takes how many answers to grade, 1 to ${MAX_LABEL_SAMPLE}`);
	}
	return requested;
}

/** Per grader spec: its human names, so the split reads as rubrics, not hashes. */
function graderNames(subjects: readonly JudgeLabelSubject[]): Map<string, string[]> {
	const names = new Map<string, Set<string>>();
	for (const subject of subjects) {
		const bucket = names.get(subject.graderSpecHash) ?? new Set<string>();
		bucket.add(subject.graderName);
		names.set(subject.graderSpecHash, bucket);
	}
	return new Map([...names].map(([hash, bucket]) => [hash, [...bucket].sort()]));
}

/**
 * The arithmetic behind the end panel, read back from the labels that were just
 * written. `judgeEvidenceCalibration` is the same function the promotion gate
 * and `ahde judge-agreement` use, so the number on this screen is never a
 * second, friendlier computation of the same thing.
 */
export function labelSummaryFor(options: {
	runsRoot: string;
	stateRoot: string;
	projectId: string;
	evalRunId: string;
	subjects: readonly JudgeLabelSubject[];
}): LabelSummary | null {
	const calibration = judgeEvidenceCalibration({
		runsRoot: options.runsRoot,
		stateRoot: options.stateRoot,
		projectId: options.projectId,
		evalRunIds: [options.evalRunId],
	});
	if (!calibration.stats) return null;
	const names = graderNames(options.subjects);
	return {
		pooled: calibration.stats,
		byGrader: [...calibration.byGraderSpecHash.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([graderSpecHash, stats]) => ({
				graderSpecHash,
				graderNames: names.get(graderSpecHash) ?? [],
				stats,
			})),
	};
}

/**
 * Walk the sample. Every screen the operator sees is drawn here; every durable
 * effect goes through `runJudgeLabelSession`.
 */
export async function runBuilderLabelSession(
	options: LabelSessionOptions,
): Promise<LabelSessionResult> {
	const sample = clampSample(options.sample);
	const evalRun = newestJudgedEvalRun(options);
	if (!evalRun) throw new NoJudgedEvidence();
	const suiteFor = options.suiteFor ?? defaultSuiteFor(options);
	const suite = suiteFor(evalRun);
	const sealedDatasetHashes = sealedCorpusHashes(options.stateRoot, options.projectId);
	const context = {
		runsRoot: options.runsRoot,
		stateRoot: options.stateRoot,
		projectId: options.projectId,
		evalRunId: evalRun.evalRunId,
		sealedDatasetHashes,
		...(suite ? { suite } : {}),
	};
	// Already-answered checks are dropped before the draw, so "twenty answers"
	// is a promise about twenty questions this operator has not seen.
	const answered = labelledJudgeSubjectKeys(options.stateRoot, options.projectId, evalRun.evalRunId);
	// The seed is the eval run: the same exercise on the same evidence draws the
	// same cases on any machine, which is what makes two operators' numbers
	// comparable at all.
	const drawn = collectJudgeLabelSubjects({
		...context,
		sample,
		seed: evalRun.evalRunId,
		skipSubjects: answered,
	});
	if (drawn.length === 0) {
		options.screen.notify(t("label.all-labelled"), "info");
		const summary = labelSummaryFor({ ...context, subjects: [] });
		if (summary) {
			options.screen.show({ title: labelDonePanelTitle(), tone: "info", lines: renderLabelSummary(summary, options.paint) });
		}
		return {
			evalRunId: evalRun.evalRunId,
			labelled: 0,
			skipped: 0,
			stopped: false,
			total: 0,
			stats: summary?.pooled ?? null,
		};
	}

	const paint = options.paint;
	const GOOD = t("label.choice.good");
	const BAD = t("label.choice.bad");
	const SKIP = t("label.choice.skip");
	const STOP = t("label.choice.stop");
	const YES = t("label.choice.yes");
	const NO = t("label.choice.no");
	const UNKNOWN = t("label.choice.unknown");

	/** One tick per assertion; `stop` is offered on the first one only. */
	const askChecklist = async (
		assertions: readonly string[],
	): Promise<readonly LabelAssertionAnswer[] | "stop"> => {
		const ticked: LabelAssertionAnswer[] = [];
		for (const [index, assertion] of assertions.entries()) {
			const choices = index === 0 ? [YES, NO, UNKNOWN, STOP] : [YES, NO, UNKNOWN];
			const chosen = await options.screen.select(
				t("label.ask-assertion", { index: index + 1, total: assertions.length, assertion }),
				choices,
			);
			// A cancelled dialog is the operator leaving, not an "unknown": guessing
			// a verdict out of a dismissed question is exactly what this exercise
			// exists to stop the judge from doing.
			if (chosen === undefined || chosen === STOP) return "stop";
			ticked.push(chosen === YES ? "yes" : chosen === NO ? "no" : "unknown");
		}
		return ticked;
	};

	// The reveal belongs to the question that was just asked: same panel title,
	// same ticks, so the two halves of one subject cannot drift apart.
	let asked: { ordinal: number; total: number; assertions?: readonly LabelAssertionAnswer[] } =
		{ ordinal: 1, total: drawn.length };

	const session = await runJudgeLabelSession({
		...context,
		sample,
		seed: evalRun.evalRunId,
		skipSubjects: answered,
		...(options.now ? { now: options.now } : {}),
		prompt: {
			ask: async (subject, ordinal, total) => {
				asked = { ordinal, total };
				options.screen.show({
					title: labelPanelTitle(ordinal, total),
					tone: "info",
					lines: renderLabelSubject(subject, paint),
				});
				if (subject.assertions) {
					// The checklist IS the verdict: a rubric of independent checks passes
					// only when every one of them holds, so asking for a pooled pass/fail
					// as well would invite the two answers to disagree.
					const ticked = await askChecklist(subject.assertions);
					if (ticked === "stop") return { answer: "stop" as const };
					asked = { ...asked, assertions: ticked };
					const failed = ticked.some((entry) => entry !== "yes");
					const note = failed ? await options.screen.input(t("label.ask-note")) : undefined;
					return {
						answer: failed ? "fail" as const : "pass" as const,
						assertions: ticked,
						...(note?.trim() ? { note: note.trim() } : {}),
					};
				}
				const chosen = await options.screen.select(t("label.ask"), [GOOD, BAD, SKIP, STOP]);
				if (chosen === undefined || chosen === STOP) return { answer: "stop" as const };
				if (chosen === SKIP) return { answer: "skip" as const };
				if (chosen === GOOD) return { answer: "pass" as const };
				const note = await options.screen.input(t("label.ask-note"));
				return { answer: "fail" as const, ...(note?.trim() ? { note: note.trim() } : {}) };
			},
			reveal: (subject, answer) => {
				if (answer === "stop") return;
				options.screen.show({
					title: labelPanelTitle(asked.ordinal, asked.total),
					tone: "info",
					lines: renderLabelReveal(subject, answer, asked.assertions, paint),
				});
			},
		},
	});

	const summary = labelSummaryFor({ ...context, subjects: drawn });
	if (session.stopped) {
		options.screen.notify(
			session.labelled === 0
				? t("label.nothing")
				: t("label.stopped", { labelled: session.labelled, left: drawn.length - session.labelled - session.skipped }),
			"info",
		);
	}
	if (summary) {
		options.screen.show({ title: labelDonePanelTitle(), tone: "info", lines: renderLabelSummary(summary, paint) });
	}
	return {
		evalRunId: evalRun.evalRunId,
		labelled: session.labelled,
		skipped: session.skipped,
		stopped: session.stopped,
		total: drawn.length,
		stats: summary?.pooled ?? null,
	};
}
