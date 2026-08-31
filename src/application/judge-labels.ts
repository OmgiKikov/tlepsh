/**
 * Human labels for judge-graded checks, and the calibration they support.
 *
 * A label is one human's pass/fail on the same answer a judge graded, written
 * down before that human is shown what the judge said. Labels are notes about
 * an instrument, not evidence about a Target: they are never a receipt, they
 * never enter a provenance axis, and they never change a recorded verdict.
 * What they do is let every judge screen say how far the instrument has been
 * trusted — and, when a project asks for it, refuse a promotion that leans on
 * a judge nobody has ever checked.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
	judgeAgreement,
	type JudgeAgreementInput,
	type JudgeAgreementStats,
} from "../domain/judge-agreement.js";
import { isSealedEvalRun, judgeSubjectFor, loadVerifiedEvalRun, readEvalRunIndex } from "../eval.js";
import { GraderSpec, type ResolvedTask } from "../manifest.js";
import { hashValue, type RunRecord } from "../provenance.js";
import { appendJsonlArtifact, readJsonlArtifact } from "../storage/artifacts.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";
import { lastAssistantText, openTrace, redactTraceText } from "../trace.js";

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** A label file is small by construction; this is the guard, not the target. */
const MAX_LABEL_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LABEL_RECORDS = 20_000;
export const MAX_LABEL_NOTE_CHARS = 500;
/** How much of the task and the answer a labelling screen shows. */
export const MAX_LABEL_SUBJECT_CHARS = 2_000;

/** One assertion, as the human ticked it and as the judge answered it. */
export const AssertionAnswerSchema = z.enum(["yes", "no", "unknown"]);
export type LabelAssertionAnswer = z.infer<typeof AssertionAnswerSchema>;

const JudgeLabelRowShape = z.strictObject({
	/** The exact run whose answer was read. */
	runId: z.string().regex(ARTIFACT_ID_PATTERN),
	taskId: z.string().min(1).max(200),
	/** Position of the judge grader within the case's effective graders. */
	graderIndex: z.number().int().nonnegative().max(63),
	/** Identity of the normalized grader spec, so a label survives a re-run. */
	graderSpecHash: z.string().regex(HASH_PATTERN),
	/**
	 * Which judge this human actually checked. The rubric alone is not the
	 * instrument: swap the judge model and the spec hash is unchanged, so labels
	 * keyed on the spec alone would vouch for a judge nobody has ever read.
	 * Absent on labels written before this was recorded — those certify nothing.
	 */
	judgeFingerprintHash: z.string().regex(HASH_PATTERN).optional(),
	/**
	 * What the human was actually shown. `judge-facing` means the screen carried
	 * the exact subject the judge was given — the same context, the same answer
	 * or transcript, the same rubric or assertion list, the same reference
	 * answer — identified by `subjectHash`. Absent means the label was written
	 * under the old screen, which showed the first user turn and the last
	 * assistant reply and never the question the judge was asked: a different
	 * object, so it certifies nothing about this judge unless a project opts in.
	 */
	subject: z.enum(["judge-facing"]).optional(),
	/** Identity of that exact judge subject. Present only with `subject`. */
	subjectHash: z.string().regex(HASH_PATTERN).optional(),
	/**
	 * The human's tick per assertion, in the grader's own order. Present only on
	 * an assertion rubric graded through the checklist screen; agreement is then
	 * measured assertion by assertion instead of on the pooled verdict.
	 */
	assertions: z.array(AssertionAnswerSchema).min(1).max(64).optional(),
	/** What the judge answered per assertion, from the recorded grader result. */
	judgeAssertions: z.array(AssertionAnswerSchema).min(1).max(64).optional(),
	human: z.enum(["pass", "fail"]),
	judge: z.enum(["pass", "fail"]),
	note: z.string().min(1).max(MAX_LABEL_NOTE_CHARS).optional(),
	at: z.iso.datetime({ offset: true }),
});

export const JudgeLabelRowSchema = JudgeLabelRowShape.superRefine((row, context) => {
	if ((row.subjectHash === undefined) !== (row.subject === undefined)) {
		context.addIssue({
			code: "custom",
			path: ["subjectHash"],
			message: "subject and subjectHash are recorded together or not at all",
		});
	}
	if ((row.assertions === undefined) !== (row.judgeAssertions === undefined)) {
		context.addIssue({
			code: "custom",
			path: ["judgeAssertions"],
			message: "a per-assertion label records both sides of the checklist",
		});
	}
	if (row.assertions && row.judgeAssertions && row.assertions.length !== row.judgeAssertions.length) {
		context.addIssue({
			code: "custom",
			path: ["judgeAssertions"],
			message: "the human and the judge must answer the same number of assertions",
		});
	}
	// A checklist passes only when every assertion is yes, on both sides. A row
	// whose summary disagrees with its own ticks would make the pooled and the
	// per-assertion readings of the same labels contradict each other.
	if (row.assertions && row.human !== (row.assertions.every((answer) => answer === "yes") ? "pass" : "fail")) {
		context.addIssue({ code: "custom", path: ["human"], message: "must reflect the ticked assertions" });
	}
	if (row.judgeAssertions && row.judge !== (row.judgeAssertions.every((answer) => answer === "yes") ? "pass" : "fail")) {
		context.addIssue({ code: "custom", path: ["judge"], message: "must reflect the judge's assertions" });
	}
});
export type JudgeLabelRow = z.infer<typeof JudgeLabelRowSchema>;

/** A label written under the old screen: valid, but about a different object. */
export function isLegacyJudgeLabel(row: Pick<JudgeLabelRow, "subject">): boolean {
	return row.subject === undefined;
}

const ProjectIdSchema = z.string().regex(PROJECT_ID_PATTERN, "projectId must be one safe path segment");
const EvalRunIdSchema = z.string().regex(ARTIFACT_ID_PATTERN, "evalRunId must be one safe path segment");

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** `<state-root>/projects/<project-id>/labels`, created only when writing. */
function labelsRoot(stateRoot: string, projectId: string, create: boolean): string | null {
	const root = resolve(stateRoot);
	if (!existsSync(root)) {
		if (!create) return null;
		mkdirSync(root, { recursive: true, mode: 0o700 });
	}
	const rootEntry = lstatSync(root);
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
		throw new Error(`label stateRoot must be a regular directory: ${root}`);
	}
	const canonicalRoot = realpathSync(root);
	let current = root;
	for (const segment of ["projects", ProjectIdSchema.parse(projectId), "labels"]) {
		const next = join(current, segment);
		if (!existsSync(next)) {
			if (!create) return null;
			mkdirSync(next, { mode: 0o700 });
		}
		const entry = lstatSync(next);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`label state component must be a regular directory: ${next}`);
		}
		if (!contained(canonicalRoot, realpathSync(next))) throw new Error("label state path escaped stateRoot");
		current = next;
	}
	return current;
}

export function judgeLabelFilePath(stateRoot: string, projectId: string, evalRunId: string): string {
	const root = labelsRoot(stateRoot, projectId, true);
	if (!root) throw new Error("failed to create the label state layout");
	return join(root, `${EvalRunIdSchema.parse(evalRunId)}.jsonl`);
}

/** Append labels for one eval run. Rows are validated before the file is opened. */
export function appendJudgeLabels(
	stateRoot: string,
	projectId: string,
	evalRunId: string,
	rows: readonly JudgeLabelRow[],
): void {
	appendJsonlArtifact(
		judgeLabelFilePath(stateRoot, projectId, evalRunId),
		JudgeLabelRowSchema,
		rows.map((row) => JudgeLabelRowSchema.parse(row)),
	);
}

/** Every label this project has collected, across eval runs, in file order. */
export function readProjectJudgeLabels(stateRoot: string, projectId: string): JudgeLabelRow[] {
	const root = labelsRoot(stateRoot, projectId, false);
	if (!root) return [];
	const rows: JudgeLabelRow[] = [];
	for (const entry of readdirSync(root).sort()) {
		if (!entry.endsWith(".jsonl")) continue;
		rows.push(...readJsonlArtifact(join(root, entry), JudgeLabelRowSchema, {
			maxBytes: MAX_LABEL_FILE_BYTES,
			maxRecords: MAX_LABEL_RECORDS,
		}));
	}
	return rows;
}

export interface JudgeCalibration {
	/** Agreement per grader spec hash; absent means this judge has no labels. */
	byGraderSpecHash: Map<string, JudgeAgreementStats>;
	pooled: JudgeAgreementStats;
	totalLabels: number;
}

/** Read this project's labels and reduce them to per-grader agreement. */
export function loadJudgeCalibration(stateRoot: string, projectId: string): JudgeCalibration {
	const rows: JudgeAgreementInput[] = readProjectJudgeLabels(stateRoot, projectId);
	const report = judgeAgreement(rows);
	return {
		byGraderSpecHash: new Map(report.byGrader.map((entry) => [entry.graderSpecHash, entry])),
		pooled: report.pooled,
		totalLabels: rows.length,
	};
}

/** Judge grader specs that actually graded one eval run's runs. */
/**
 * Hash of the judge model an eval run was graded by, or null when it used none.
 * This is the second half of a label's identity: the rubric says what was
 * asked, this says who answered.
 */
export function judgeFingerprintHashOf(runsRoot: string, evalRunId: string): string | null {
	const judge = loadVerifiedEvalRun(runsRoot, EvalRunIdSchema.parse(evalRunId)).record.provenance.judge;
	return judge ? hashValue(judge) : null;
}

export function judgeGraderSpecHashes(runsRoot: string, evalRunId: string): string[] {
	const hashes = new Set<string>();
	for (const run of loadVerifiedEvalRun(runsRoot, EvalRunIdSchema.parse(evalRunId)).runs) {
		for (const grader of run.evalResults?.graders ?? []) {
			if (grader.checkCode === "semantic-rubric" && grader.specHash) hashes.add(grader.specHash);
		}
	}
	return [...hashes].sort();
}

export interface JudgeEvidenceCalibration {
	/** Judge grader specs this evidence rests on. Empty means no judge graded it. */
	specHashes: string[];
	/** Agreement over the labels covering exactly those specs; null when none exist. */
	stats: JudgeAgreementStats | null;
	/**
	 * Labels for these specs that were written under the old screen. Counted
	 * whether or not they were included, so a screen can say why the number it
	 * shows is smaller than the number of labels on disk.
	 */
	legacyLabels: number;
}

/**
 * The one question every judge screen and the promotion gate ask: does this
 * evidence lean on a judge, and how far has that judge been checked? Pooling
 * only the labels for the specs that actually graded keeps an unrelated,
 * well-labelled judge elsewhere in the project from vouching for this one.
 */
export function judgeEvidenceCalibration(options: {
	runsRoot: string;
	stateRoot: string;
	projectId: string;
	evalRunIds: readonly string[];
	/**
	 * Count labels written under the old screen. Screens pass true so the
	 * project keeps seeing every label it has collected; the promotion gate
	 * passes the manifest's `allowLegacyLabels`, which defaults to false.
	 */
	includeLegacyLabels?: boolean;
}): JudgeEvidenceCalibration {
	const specHashes = [...new Set(
		options.evalRunIds.flatMap((evalRunId) => judgeGraderSpecHashes(options.runsRoot, evalRunId)),
	)].sort();
	if (specHashes.length === 0) return { specHashes, stats: null, legacyLabels: 0 };
	const wanted = new Set(specHashes);
	// A label certifies one rubric AS ANSWERED BY ONE JUDGE. Evidence graded by a
	// judge nobody labelled is uncalibrated even when the rubric is old and
	// well-labelled — that is the whole point of measuring the instrument.
	const judges = new Set(
		options.evalRunIds
			.map((evalRunId) => judgeFingerprintHashOf(options.runsRoot, evalRunId))
			.filter((hash): hash is string => hash !== null),
	);
	const matching = readProjectJudgeLabels(options.stateRoot, options.projectId)
		.filter((row) => wanted.has(row.graderSpecHash))
		.filter((row) => row.judgeFingerprintHash !== undefined && judges.has(row.judgeFingerprintHash));
	const legacyLabels = matching.filter(isLegacyJudgeLabel).length;
	const rows = options.includeLegacyLabels === false
		? matching.filter((row) => !isLegacyJudgeLabel(row))
		: matching;
	return {
		specHashes,
		stats: rows.length === 0 ? null : judgeAgreement(rows).pooled,
		legacyLabels,
	};
}

// ---------- Labelling subjects ----------

/**
 * One judge check a human is asked to grade blind.
 *
 * `subject: "judge-facing"` means every field below was derived by
 * `judgeSubjectFor` from the same run and the same grader spec the judge was
 * given, so `subjectHash` is literally the identity of the judge's own input.
 * `subject: "legacy"` is the fallback when the suite that produced the
 * evidence is not in scope: the screen then shows the first user turn and the
 * last assistant reply, which is a different object, and the labels it
 * collects say so.
 */
export interface JudgeLabelSubject {
	runId: string;
	taskId: string;
	graderIndex: number;
	graderSpecHash: string;
	graderName: string;
	/** What the judge decided. Never shown before the human has answered. */
	judge: "pass" | "fail";
	judgeReason: string;
	/** Which object this screen shows. */
	subject: "judge-facing" | "legacy";
	/** Identity of the exact judge subject; null on a legacy screen. */
	subjectHash: string | null;
	/** `dialogue` when the judge read the conversation, not one reply. */
	kind: "single-turn" | "dialogue";
	/**
	 * Bounded, credential-redacted. `input` is what the person wanted — the
	 * request, or the goal on a dialogue case — and `answer` is the final reply
	 * or the whole transcript, exactly as the judge saw it.
	 */
	input: string;
	answer: string;
	/** The criterion the judge was asked, bounded; null when there was none. */
	rubric: string | null;
	/** The checklist the judge answered one by one; null when there is none. */
	assertions: readonly string[] | null;
	/** What the judge answered per assertion, in the same order. */
	judgeAssertions: readonly LabelAssertionAnswer[] | null;
	/** The reference answer, only when this grader showed the judge one. */
	reference: string | null;
}

function boundedSubjectText(value: string): string {
	const redacted = redactTraceText(value);
	return redacted.length <= MAX_LABEL_SUBJECT_CHARS
		? redacted
		: `${redacted.slice(0, MAX_LABEL_SUBJECT_CHARS - 1)}…`;
}

function firstUserText(messages: ReturnType<typeof openTrace>): string {
	return messages.find((message) => message.role === "user")?.text ?? "";
}

/**
 * The suite that produced the evidence being labelled. Without it the screen
 * cannot know what the judge was asked, only what the agent answered — so it
 * falls back to the legacy subject and marks every label it collects.
 */
export interface JudgeLabelSuite {
	datasetHash: string;
	suiteHash: string;
	tasks: readonly ResolvedTask[];
}

export interface CollectJudgeLabelSubjectsOptions {
	runsRoot: string;
	evalRunId: string;
	/** How many subjects to draw. Absent means every judge-graded check. */
	sample?: number;
	/** Seed for the draw. The same seed always draws the same subjects. */
	seed?: string;
	/** Sealed corpus hashes, so a legacy sealed eval run is refused too. */
	sealedDatasetHashes?: ReadonlySet<string>;
	/** The exact suite the evidence was graded under. */
	suite?: JudgeLabelSuite;
}

/**
 * Every judge-graded check in one development eval run, optionally reduced to a
 * deterministic seeded sample.
 *
 * The draw is a sort by `hash(seed, runId, graderIndex)` rather than a shuffle:
 * no PRNG state, no dependence on iteration order, and the same seed reproduces
 * the same sample on any machine — which is what makes two humans' labels of
 * "the same 30 cases" actually the same 30 cases.
 */
export function collectJudgeLabelSubjects(
	options: CollectJudgeLabelSubjectsOptions,
): JudgeLabelSubject[] {
	const evalRunId = EvalRunIdSchema.parse(options.evalRunId);
	const preflight = readEvalRunIndex(options.runsRoot, evalRunId);
	if (isSealedEvalRun(preflight, options.sealedDatasetHashes)) {
		throw new Error("sealed holdout evidence is never labelled: its content must stay unread");
	}
	const verified = loadVerifiedEvalRun(options.runsRoot, evalRunId);
	if (isSealedEvalRun(verified.record, options.sealedDatasetHashes)) {
		throw new Error("sealed holdout evidence is never labelled: its content must stay unread");
	}
	// The suite is only usable when it is the one that graded this evidence.
	// A drifted dataset would render a different rubric beside the same run,
	// which is exactly the confusion the judge-facing subject exists to end.
	const suite = options.suite &&
			options.suite.datasetHash === verified.record.datasetHash &&
			options.suite.suiteHash === verified.record.suiteHash
		? new Map(options.suite.tasks.map((task) => [task.id, task]))
		: null;
	const subjects: JudgeLabelSubject[] = [];
	for (const run of verified.runs) {
		if (run.status !== "completed" || !run.evalResults) continue;
		const judged = run.evalResults.graders
			.map((grader, graderIndex) => ({ grader, graderIndex }))
			.filter((entry) => entry.grader.checkCode === "semantic-rubric" && entry.grader.specHash);
		if (judged.length === 0) continue;
		const legacy = runTexts(options.runsRoot, run);
		const messages = suite ? runTrace(options.runsRoot, run) : [];
		const task = suite?.get(run.taskId);
		for (const entry of judged) {
			const spec = task?.effectiveGraders[entry.graderIndex];
			// Belt and braces: the spec must hash to the identity the run recorded,
			// or it is not the grader that produced this verdict.
			const graderSpec = spec && spec.type === "judge" && hashValue(GraderSpec.parse(spec)) === entry.grader.specHash
				? spec
				: null;
			const judgeSubject = task && graderSpec
				? judgeSubjectFor(
					{
						input: task.input,
						messages,
						simulatedUser: task.simulatedUser,
						expected: task.expected,
					},
					graderSpec,
				)
				: null;
			const judgeAssertions = judgeSubject?.assertions
				? judgeAssertionAnswers(judgeSubject.assertions.length, entry.grader.assertions)
				: null;
			subjects.push({
				runId: run.runId,
				taskId: run.taskId,
				graderIndex: entry.graderIndex,
				graderSpecHash: entry.grader.specHash!,
				graderName: entry.grader.name,
				judge: entry.grader.passed ? "pass" : "fail",
				judgeReason: boundedSubjectText(entry.grader.reason),
				...(judgeSubject
					? {
						subject: "judge-facing" as const,
						subjectHash: hashValue(judgeSubject),
						kind: judgeSubject.kind,
						input: boundedSubjectText(judgeSubject.context),
						answer: boundedSubjectText(judgeSubject.answer),
						rubric: judgeSubject.rubric === null ? null : boundedSubjectText(judgeSubject.rubric),
						assertions: judgeSubject.assertions
							? judgeSubject.assertions.map(boundedSubjectText)
							: null,
						judgeAssertions,
						reference: judgeSubject.reference === null ? null : boundedSubjectText(judgeSubject.reference),
					}
					: {
						subject: "legacy" as const,
						subjectHash: null,
						kind: "single-turn" as const,
						input: legacy.input,
						answer: legacy.answer,
						rubric: null,
						assertions: null,
						judgeAssertions: null,
						reference: null,
					}),
			});
		}
	}
	if (options.sample === undefined || options.sample >= subjects.length) return subjects;
	if (!Number.isInteger(options.sample) || options.sample < 1) {
		throw new Error(`--sample must be a positive integer, got ${options.sample}`);
	}
	const seed = options.seed ?? "";
	return subjects
		.map((subject) => ({
			subject,
			key: hashValue({ seed, runId: subject.runId, graderIndex: subject.graderIndex }),
		}))
		.sort((left, right) => left.key.localeCompare(right.key))
		.slice(0, options.sample)
		.map((entry) => entry.subject);
}

function runTrace(runsRoot: string, run: RunRecord): ReturnType<typeof openTrace> {
	if (!run.trace.sha256) return [];
	return openTrace(resolveContainedArtifactPath(runsRoot, run.runId), run.trace.path, run.trace.sha256);
}

function runTexts(runsRoot: string, run: RunRecord): { input: string; answer: string } {
	const messages = runTrace(runsRoot, run);
	return {
		input: boundedSubjectText(firstUserText(messages)),
		answer: boundedSubjectText(lastAssistantText(messages) ?? ""),
	};
}

/**
 * What the judge answered for each assertion, recovered from the recorded
 * grader result. The evidence keeps only the failed indexes and cannot tell
 * "no" from "unknown" apart after the fold, so a failed assertion is reported
 * as `no`: the pass/fail arithmetic is identical either way, and inventing the
 * distinction would put a verdict in the judge's mouth.
 */
function judgeAssertionAnswers(
	total: number,
	recorded: { total: number; failed: number[] } | undefined,
): LabelAssertionAnswer[] | null {
	if (!recorded || recorded.total !== total) return null;
	const failed = new Set(recorded.failed);
	return Array.from({ length: total }, (_unused, index) => failed.has(index + 1) ? "no" : "yes");
}

/**
 * What a written label records about the object it graded. A judge-facing
 * screen stamps the exact subject identity; a legacy screen stamps nothing,
 * and the row is then excluded from `requireCalibration` by default.
 *
 * The per-assertion pair travels together or not at all: half a checklist
 * cannot be scored.
 */
function labelSubjectFields(
	subject: JudgeLabelSubject,
	assertions: readonly LabelAssertionAnswer[] | undefined,
): Record<string, unknown> {
	const ticked = assertions && subject.judgeAssertions
		? { assertions: [...assertions], judgeAssertions: [...subject.judgeAssertions] }
		: {};
	return subject.subject === "judge-facing" && subject.subjectHash !== null
		? { subject: "judge-facing", subjectHash: subject.subjectHash, ...ticked }
		: ticked;
}

// ---------- Non-interactive import ----------

/**
 * One imported row: everything except what the host stamps from the evidence —
 * the timestamp, the judge's verdicts, and the identity of the subject the
 * human was shown. A file cannot claim it graded the judge-facing subject.
 */
export const JudgeLabelImportRowSchema = JudgeLabelRowShape
	.omit({ at: true, judge: true, judgeAssertions: true, subject: true, subjectHash: true })
	.extend({
		at: JudgeLabelRowShape.shape.at.optional(),
		judge: JudgeLabelRowShape.shape.judge.optional(),
	});
export type JudgeLabelImportRow = z.infer<typeof JudgeLabelImportRowSchema>;

export interface ImportJudgeLabelsOptions {
	runsRoot: string;
	stateRoot: string;
	projectId: string;
	evalRunId: string;
	filePath: string;
	sealedDatasetHashes?: ReadonlySet<string>;
	/** The exact suite the evidence was graded under, when it is in scope. */
	suite?: JudgeLabelSuite;
	now?: () => string;
}

/**
 * Import labels from a JSONL file, checked against the evidence they claim to
 * label: an unknown run, an unknown grader, or a judge verdict that disagrees
 * with what the run actually recorded is refused. A label file is a human
 * artifact, and the one thing it must not do is quietly redefine the evidence.
 */
export function importJudgeLabels(options: ImportJudgeLabelsOptions): JudgeLabelRow[] {
	const subjects = collectJudgeLabelSubjects({
		runsRoot: options.runsRoot,
		evalRunId: options.evalRunId,
		...(options.sealedDatasetHashes ? { sealedDatasetHashes: options.sealedDatasetHashes } : {}),
		...(options.suite ? { suite: options.suite } : {}),
	});
	const byKey = new Map(subjects.map((subject) => [`${subject.runId} ${subject.graderIndex}`, subject]));
	const judgeFingerprint = judgeFingerprintHashOf(options.runsRoot, options.evalRunId);
	const parsed = readJsonlArtifact(resolve(options.filePath), JudgeLabelImportRowSchema, {
		maxBytes: MAX_LABEL_FILE_BYTES,
		maxRecords: MAX_LABEL_RECORDS,
	});
	const at = (options.now ?? (() => new Date().toISOString()))();
	const seen = new Set<string>();
	const rows = parsed.map((row, index) => {
		const key = `${row.runId} ${row.graderIndex}`;
		const subject = byKey.get(key);
		if (!subject) {
			throw new Error(
				`label ${index + 1}: run ${row.runId} grader ${row.graderIndex} is not a judge check of eval run ${options.evalRunId}`,
			);
		}
		if (seen.has(key)) throw new Error(`label ${index + 1}: duplicate label for ${row.runId} grader ${row.graderIndex}`);
		seen.add(key);
		if (row.graderSpecHash !== subject.graderSpecHash) {
			throw new Error(`label ${index + 1}: graderSpecHash does not match the recorded grader`);
		}
		if (row.taskId !== subject.taskId) {
			throw new Error(`label ${index + 1}: taskId does not match run ${row.runId}`);
		}
		if (row.judge !== undefined && row.judge !== subject.judge) {
			throw new Error(`label ${index + 1}: judge verdict contradicts the recorded grade (${subject.judge})`);
		}
		if (row.assertions && !subject.assertions) {
			throw new Error(`label ${index + 1}: run ${row.runId} grader ${row.graderIndex} is not an assertion checklist`);
		}
		if (row.assertions && subject.assertions && row.assertions.length !== subject.assertions.length) {
			throw new Error(
				`label ${index + 1}: expected ${subject.assertions.length} assertion answer(s), got ${row.assertions.length}`,
			);
		}
		return JudgeLabelRowSchema.parse({
			runId: row.runId,
			taskId: row.taskId,
			graderIndex: row.graderIndex,
			graderSpecHash: row.graderSpecHash,
			...(judgeFingerprint === null ? {} : { judgeFingerprintHash: judgeFingerprint }),
			...labelSubjectFields(subject, row.assertions),
			human: row.human,
			judge: subject.judge,
			...(row.note ? { note: row.note } : {}),
			at: row.at ?? at,
		});
	});
	appendJudgeLabels(options.stateRoot, options.projectId, options.evalRunId, rows);
	return rows;
}

// ---------- Interactive labelling ----------

export type JudgeLabelAnswer = "pass" | "fail" | "skip";

export interface JudgeLabelPrompt {
	/** Show one subject and collect the human's verdict, blind to the judge. */
	ask: (subject: JudgeLabelSubject, ordinal: number, total: number) => Promise<{
		answer: JudgeLabelAnswer;
		note?: string;
		/**
		 * One tick per assertion, in the grader's own order, when the screen
		 * showed a checklist. The overall verdict must follow from them: a
		 * checklist passes only when every assertion is yes.
		 */
		assertions?: readonly LabelAssertionAnswer[];
	}>;
	/** Called after the answer, with the verdict the judge had recorded. */
	reveal: (subject: JudgeLabelSubject, answer: JudgeLabelAnswer) => void;
}

export interface RunJudgeLabelSessionOptions extends ImportJudgeLabelsOptions {
	sample?: number;
	seed?: string;
	prompt: JudgeLabelPrompt;
}

/**
 * Walk a sample, asking for a blind verdict on each subject and revealing the
 * judge's only after the human has committed. Each answer is appended before
 * the next question, so an interrupted session keeps every label it collected.
 */
export async function runJudgeLabelSession(
	options: Omit<RunJudgeLabelSessionOptions, "filePath">,
): Promise<{ labelled: number; skipped: number; rows: JudgeLabelRow[] }> {
	const subjects = collectJudgeLabelSubjects({
		runsRoot: options.runsRoot,
		evalRunId: options.evalRunId,
		...(options.sample === undefined ? {} : { sample: options.sample }),
		...(options.seed === undefined ? {} : { seed: options.seed }),
		...(options.sealedDatasetHashes ? { sealedDatasetHashes: options.sealedDatasetHashes } : {}),
		...(options.suite ? { suite: options.suite } : {}),
	});
	const now = options.now ?? (() => new Date().toISOString());
	const judgeFingerprint = judgeFingerprintHashOf(options.runsRoot, options.evalRunId);
	const rows: JudgeLabelRow[] = [];
	let skipped = 0;
	for (const [offset, subject] of subjects.entries()) {
		const answer = await options.prompt.ask(subject, offset + 1, subjects.length);
		options.prompt.reveal(subject, answer.answer);
		if (answer.answer === "skip") {
			skipped += 1;
			continue;
		}
		const ticked = answer.assertions && subject.assertions &&
				answer.assertions.length === subject.assertions.length
			? answer.assertions
			: undefined;
		const row = JudgeLabelRowSchema.parse({
			runId: subject.runId,
			taskId: subject.taskId,
			graderIndex: subject.graderIndex,
			graderSpecHash: subject.graderSpecHash,
			...(judgeFingerprint === null ? {} : { judgeFingerprintHash: judgeFingerprint }),
			...labelSubjectFields(subject, ticked),
			human: answer.answer,
			judge: subject.judge,
			...(answer.note?.trim() ? { note: answer.note.trim().slice(0, MAX_LABEL_NOTE_CHARS) } : {}),
			at: now(),
		});
		appendJudgeLabels(options.stateRoot, options.projectId, options.evalRunId, [row]);
		rows.push(row);
	}
	return { labelled: rows.length, skipped, rows };
}
