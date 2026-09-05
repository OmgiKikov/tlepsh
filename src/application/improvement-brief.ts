import { z } from "zod";
import { categoryForGrader, DiagnosisClassificationMismatch } from "./diagnosis-category.js";
import {
	DiagnosisCategorySchema,
	RunExcerptSchema,
	TraceObservationSchema,
	type DiagnosisRecord,
	type RunExcerpt,
	type TraceObservation,
} from "../diagnosis.js";
import { isSealedEvalRun, loadVerifiedEvalRun, readEvalRunIndex } from "../eval.js";
import {
	GraderCheckCodeSchema,
	HashSchema,
	MAX_CHECK_SUBJECT_CHARS,
	canonicalJson,
	hashValue,
	type GraderCheckCode,
	type GraderResult,
	type RunRecord,
} from "../provenance.js";
import { redactTraceText } from "../trace.js";
import { classifyRunError, type RunErrorClass } from "./run-error.js";

export const IMPROVEMENT_BRIEF_ALGORITHM_ID = "exact-eval-signals-v1" as const;
/** Failure share (basis points) below which a mode is noise to stabilize, not a harness defect to fix. */
export const PROPOSAL_REPRODUCTION_FLOOR_BPS = 2_500;
const MAX_FAILURE_MODES = 30;
const MAX_TASK_IDS = 100;
const MAX_EVIDENCE = 12;
const MAX_COUNTER_EVIDENCE = 4;
const MAX_EVIDENCE_NOTES = 3;
const MAX_EVIDENCE_NOTE_CHARS = 500;
const MAX_SUGGESTIONS = 4;
const MAX_SUGGESTION_CHARS = 500;
const MAX_GRADER_NAMES = 20;
const MAX_GRADER_NAME_CHARS = 200;
const MAX_ARTIFACT_ID_CHARS = 200;
const MAX_BRIEF_BYTES = 256 * 1024;
const HASH_HEX_OFFSET = "sha256:".length;
const HASH_ID_CHARS = 24;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

const EvidenceSchema = z.strictObject({
	runId: z.string().min(1).max(MAX_ARTIFACT_ID_CHARS),
	taskId: z.string().min(1).max(MAX_ARTIFACT_ID_CHARS),
	traceAvailable: z.boolean(),
	graderNames: z.array(z.string().min(1).max(MAX_GRADER_NAME_CHARS)).max(MAX_GRADER_NAMES),
	/**
	 * The raw trace, bounded: what the Target actually called and actually said.
	 * Null where the diagnosis read no trace for this run — an older diagnosis,
	 * or a run that never produced one.
	 */
	excerpt: RunExcerptSchema.nullable().default(null),
});

export const FailureModeIdSchema = z.string().regex(/^failure-mode-[0-9a-f]{24}$/);

export const FailureModeSchema = z.strictObject({
	failureModeId: FailureModeIdSchema,
	signature: z.strictObject({
		kind: z.enum(["grader-check", "outcome-instability", "infrastructure-error"]),
		checkCode: GraderCheckCodeSchema.nullable(),
		/** The tool a required-tool family names; null everywhere else. */
		subject: z.string().min(1).max(MAX_CHECK_SUBJECT_CHARS).nullable().default(null),
		discriminatorHash: HashSchema,
	}),
	category: DiagnosisCategorySchema,
	scope: z.enum(["systemic", "task-local"]),
	severity: z.enum(["blocking", "major", "minor"]),
	evidenceStrength: z.enum(["high", "medium", "low"]),
	decision: z.enum([
		"propose-harness-change",
		"stabilize-and-rerun",
		"repair-evidence-path",
	]),
	/**
	 * Every failure in this family was a judge that said it could not tell.
	 * The family is unchanged — invariant 29 clusters by the exact typed grader
	 * family and nothing else — but the reading is: there is no observed agent
	 * behaviour here to propose a change against, only an unsure instrument.
	 * Absent, never `false`, so a brief with no abstention hashes as before.
	 */
	abstained: z.boolean().optional(),
	title: z.string().min(1).max(500),
	summary: z.string().min(1).max(1_000),
	/**
	 * What the cited traces show, in one sentence. Not a hypothesis: every
	 * clause is a count of a predicate over trace bytes, so a reader can check
	 * it against the excerpts below it.
	 */
	facts: z.string().min(1).max(1_000),
	/** The same sentence as structure, so a screen can say it in its own language. */
	observations: z.array(z.strictObject({
		code: TraceObservationSchema,
		runs: z.number().int().positive(),
	})).max(5),
	/** Failing runs of this mode whose trace the diagnosis actually read. */
	observedRuns: z.number().int().nonnegative(),
	suggestions: z.array(z.string().min(1).max(MAX_SUGGESTION_CHARS)).min(1).max(MAX_SUGGESTIONS),
	impact: z.strictObject({
		affectedTasks: z.number().int().positive(),
		totalTasks: z.number().int().nonnegative(),
		taskCoverageBps: z.number().int().min(0).max(10_000),
		failedOccurrences: z.number().int().positive(),
		passedOccurrences: z.number().int().nonnegative(),
		reproductionBps: z.number().int().min(0).max(10_000),
	}),
	taskIds: z.array(z.string().min(1).max(MAX_ARTIFACT_ID_CHARS)).min(1).max(MAX_TASK_IDS),
	evidence: z.array(EvidenceSchema).min(1).max(MAX_EVIDENCE),
	counterEvidence: z.array(EvidenceSchema).max(MAX_COUNTER_EVIDENCE),
	evidenceNotes: z.array(z.string().min(1).max(MAX_EVIDENCE_NOTE_CHARS)).max(MAX_EVIDENCE_NOTES),
	omittedEvidenceCount: z.number().int().nonnegative(),
}).superRefine((mode, context) => {
	if (mode.scope === "systemic" && mode.impact.affectedTasks < 2) {
		context.addIssue({ code: "custom", path: ["scope"], message: "systemic modes require at least two affected tasks" });
	}
	if (mode.scope === "task-local" && mode.impact.affectedTasks !== 1) {
		context.addIssue({ code: "custom", path: ["scope"], message: "task-local modes require exactly one affected task" });
	}
	if (mode.taskIds.length > mode.impact.affectedTasks) {
		context.addIssue({ code: "custom", path: ["taskIds"], message: "cannot exceed affectedTasks" });
	}
	const expectedCoverage = mode.impact.totalTasks === 0
		? 0
		: Math.floor(mode.impact.affectedTasks * 10_000 / mode.impact.totalTasks);
	if (mode.impact.taskCoverageBps !== expectedCoverage) {
		context.addIssue({ code: "custom", path: ["impact", "taskCoverageBps"], message: "does not match affectedTasks / totalTasks" });
	}
	const occurrenceTotal = mode.impact.failedOccurrences + mode.impact.passedOccurrences;
	const expectedReproduction = Math.floor(mode.impact.failedOccurrences * 10_000 / occurrenceTotal);
	if (mode.impact.reproductionBps !== expectedReproduction) {
		context.addIssue({ code: "custom", path: ["impact", "reproductionBps"], message: "does not match failed / total occurrences" });
	}
});

export const ImprovementBriefSchema = z.strictObject({
	schemaVersion: z.literal(1),
	algorithmId: z.literal(IMPROVEMENT_BRIEF_ALGORITHM_ID),
	briefId: z.string().regex(/^brief-[0-9a-f]{24}$/),
	evalRunId: z.string().min(1).max(MAX_ARTIFACT_ID_CHARS),
	diagnosisId: z.string().min(1).max(MAX_ARTIFACT_ID_CHARS),
	status: z.enum(["healthy", "actionable", "inconclusive"]),
	proposalEligible: z.boolean(),
	headline: z.string().min(1).max(1_000),
	summary: z.strictObject({
		tasks: z.number().int().nonnegative(),
		failedTasks: z.number().int().nonnegative(),
		infrastructureErrors: z.number().int().nonnegative(),
		failureModeCount: z.number().int().nonnegative(),
		systemicFailureModeCount: z.number().int().nonnegative(),
		taskLocalFailureModeCount: z.number().int().nonnegative(),
		omittedFailureModeCount: z.number().int().nonnegative(),
	}),
	modes: z.array(FailureModeSchema).max(MAX_FAILURE_MODES),
}).superRefine((brief, context) => {
	const failureModeIds = brief.modes.map((mode) => mode.failureModeId);
	if (new Set(failureModeIds).size !== failureModeIds.length) {
		context.addIssue({ code: "custom", path: ["modes"], message: "failure mode ids must be unique" });
	}
	if (brief.status === "inconclusive" && brief.proposalEligible) {
		context.addIssue({ code: "custom", path: ["proposalEligible"], message: "inconclusive evidence cannot seed a proposal" });
	}
	if (brief.proposalEligible && brief.status !== "actionable") {
		context.addIssue({ code: "custom", path: ["proposalEligible"], message: "only actionable diagnosed evidence can seed a proposal" });
	}
	if (brief.proposalEligible && !brief.modes.some((mode) => mode.decision === "propose-harness-change")) {
		context.addIssue({ code: "custom", path: ["proposalEligible"], message: "requires one projected proposal mode" });
	}
	if (
		brief.summary.failureModeCount !==
		brief.summary.systemicFailureModeCount + brief.summary.taskLocalFailureModeCount
	) {
		context.addIssue({ code: "custom", path: ["summary", "failureModeCount"], message: "must equal systemic + task-local modes" });
	}
	if (brief.modes.length + brief.summary.omittedFailureModeCount !== brief.summary.failureModeCount) {
		context.addIssue({ code: "custom", path: ["modes"], message: "mode projection does not match summary counts" });
	}
	if (Buffer.byteLength(canonicalJson(brief), "utf8") > MAX_BRIEF_BYTES) {
		context.addIssue({ code: "custom", path: ["modes"], message: `brief exceeds ${MAX_BRIEF_BYTES} bytes` });
	}
});
export type ImprovementBrief = z.infer<typeof ImprovementBriefSchema>;
export type FailureMode = z.infer<typeof FailureModeSchema>;

const MAX_PROPOSAL_FAILURE_MODES = 8;

export const ProposalBasisSelectionSchema = z.strictObject({
	algorithmId: z.literal(IMPROVEMENT_BRIEF_ALGORITHM_ID),
	evalRunId: z.string().min(1).max(MAX_ARTIFACT_ID_CHARS),
	diagnosisId: z.string().min(1).max(MAX_ARTIFACT_ID_CHARS),
	briefId: z.string().regex(/^brief-[0-9a-f]{24}$/),
	failureModeIds: z.array(FailureModeIdSchema)
		.min(1)
		.max(MAX_PROPOSAL_FAILURE_MODES)
		.refine((ids) => new Set(ids).size === ids.length, "failure mode ids must be unique"),
});
export type ProposalBasisSelection = z.infer<typeof ProposalBasisSelectionSchema>;

export const ProposalBasisAttestationSchema = z.strictObject({
	schemaVersion: z.literal(1),
	algorithmId: z.literal(IMPROVEMENT_BRIEF_ALGORITHM_ID),
	evalRunId: z.string().min(1).max(MAX_ARTIFACT_ID_CHARS),
	diagnosisId: z.string().min(1).max(MAX_ARTIFACT_ID_CHARS),
	briefId: z.string().regex(/^brief-[0-9a-f]{24}$/),
	briefSha256: HashSchema,
	failureModes: z.array(z.strictObject({
		failureModeId: FailureModeIdSchema,
		modeSha256: HashSchema,
	})).min(1).max(MAX_PROPOSAL_FAILURE_MODES)
		.refine(
			(modes) => new Set(modes.map((mode) => mode.failureModeId)).size === modes.length,
			"attested failure mode ids must be unique",
		),
});
export type ProposalBasisAttestation = z.infer<typeof ProposalBasisAttestationSchema>;

export interface EvidenceLinkedProposalDiagnosis {
	failureIds: string[];
	evidence: string[];
	rootCause: string;
}

export interface EvidenceLinkedProposalSelection {
	basis: ProposalBasisAttestation;
	diagnoses: EvidenceLinkedProposalDiagnosis[];
}

type BriefEvidence = z.infer<typeof EvidenceSchema>;
type FailureModeCategory = FailureMode["category"];
type FailureModeDecision = FailureMode["decision"];

type DiagnosticGraderResult = GraderResult & {
	checkCode?: GraderCheckCode;
	specHash?: string;
	checkSubject?: string;
};

/** Trace excerpts the diagnosis already read, by run id. */
type RunExcerpts = ReadonlyMap<string, RunExcerpt>;

type DiagnosticEvalRecord = ReturnType<typeof loadVerifiedEvalRun>["record"] & {
	evidenceVisibility?: "development" | "sealed";
	taskIds?: string[];
};

interface Observation extends BriefEvidence {
	rawTaskId: string;
	notes: string[];
}

interface ModeAccumulator {
	identity: Record<string, unknown>;
	signature: FailureMode["signature"];
	category: FailureModeCategory;
	legacy: boolean;
	failures: Map<string, Observation>;
	passes: Map<string, Observation>;
	/**
	 * Per failing run: whether EVERY matching grader that failed it was an
	 * abstention. One decided failure in the same run is enough to make the run
	 * evidence about the agent again.
	 */
	abstained: Map<string, boolean>;
}

interface TaskOutcomes {
	pass: RunRecord[];
	fail: RunRecord[];
	error: RunRecord[];
}

function shortHashId(prefix: "brief" | "failure-mode", value: unknown): string {
	const hash = hashValue(value);
	return `${prefix}-${hash.slice(HASH_HEX_OFFSET, HASH_HEX_OFFSET + HASH_ID_CHARS)}`;
}

function boundedRedacted(value: string, maxChars: number): string {
	return redactTraceText(value).slice(0, maxChars);
}

/** Stable display identifier that never exposes a credential-shaped or oversized task id. */
export function publicTaskId(value: string): string {
	const redacted = redactTraceText(value);
	if (redacted === value && value.length <= MAX_ARTIFACT_ID_CHARS) return value;
	const suffix = `~${hashValue(value).slice(HASH_HEX_OFFSET, HASH_HEX_OFFSET + 12)}`;
	return `${redacted.slice(0, MAX_ARTIFACT_ID_CHARS - suffix.length)}${suffix}`;
}

function safeGraderName(value: string): string {
	return boundedRedacted(value, MAX_GRADER_NAME_CHARS).trim() || "unnamed-grader";
}

function evidenceForRun(run: RunRecord, graderNames: string[] = [], notes: string[] = []): Observation {
	return {
		runId: run.runId,
		taskId: publicTaskId(run.taskId),
		rawTaskId: run.taskId,
		traceAvailable: run.trace.sha256 !== null,
		graderNames: [...new Set(graderNames.map(safeGraderName))].sort().slice(0, MAX_GRADER_NAMES),
		// Attached once, at projection, from what the diagnosis already read.
		excerpt: null,
		notes: notes
			.map((note) => boundedRedacted(note, MAX_EVIDENCE_NOTE_CHARS).trim())
			.filter(Boolean),
	};
}

function mergeObservation(existing: Observation | undefined, incoming: Observation): Observation {
	if (!existing) return incoming;
	return {
		...existing,
		rawTaskId: existing.rawTaskId,
		traceAvailable: existing.traceAvailable || incoming.traceAvailable,
		graderNames: [...new Set([...existing.graderNames, ...incoming.graderNames])]
			.sort()
			.slice(0, MAX_GRADER_NAMES),
		notes: [...new Set([...existing.notes, ...incoming.notes])].sort(),
	};
}

/**
 * The canonical English name of one infrastructure cause. It is hashed into
 * proposals and read by scripts, so it never bends to the operator's language;
 * `run-error.ts` owns the sentence a screen says instead.
 */
const INFRASTRUCTURE_CAUSE_TITLES: Record<RunErrorClass, string> = {
	timeout: "model timeout",
	exit: "the agent process ended",
	protocol: "protocol violation",
	startup: "the agent did not start",
	evaluation: "the evaluation path",
	other: "an interrupted run",
};

/** Title of an exact (non-legacy) grader failure mode. */
const GRADER_CHECK_TITLES: Record<GraderCheckCode, string> = {
	"required-tool": "Required tool check failed",
	"output-contains": "Output contract check failed",
	"output-matches": "Output contract check failed",
	"no-secret": "The answer leaked something shaped like a credential",
	"reference-exact": "Exact reference-answer check failed",
	"semantic-rubric": "Semantic rubric check failed",
	"reference-similarity": "Reference similarity check failed",
	"turn-budget": "Turn budget check failed",
	"world-state": "World state check failed",
	"final-answer": "The agent returned no final answer after recovery",
	"cites-source": "The answer did not stand on the cited source",
};

/**
 * What makes two tasks' failures one failure.
 *
 * The key used to be the exact grader spec, so `check_dbo("ДБО-2345-678")` and
 * `check_dbo("ДБО-1111-222")` were two unrelated defects, and a six-task corpus
 * reported sixteen task-local modes for three causes. The literal a case
 * happens to carry — the contract number, the keyword, the rubric prose — is
 * the task. What repeats across tasks is the family: the check, plus the thing
 * the check names when it names one.
 */
export interface GraderFamily {
	checkCode: GraderCheckCode;
	subject: string | null;
}

/** The family of an exact grader result, or null when the result is legacy. */
export function graderFamilyOf(grader: {
	checkCode?: GraderCheckCode;
	specHash?: string;
	checkSubject?: string;
}): GraderFamily | null {
	const exact = typeof grader.checkCode === "string" && grader.checkCode.length > 0 &&
		typeof grader.specHash === "string" && HASH_PATTERN.test(grader.specHash);
	if (!exact) return null;
	const subject = grader.checkSubject;
	return {
		checkCode: grader.checkCode!,
		subject: typeof subject === "string" && subject.length > 0 && subject.length <= MAX_CHECK_SUBJECT_CHARS
			? subject
			: null,
	};
}

/** Canonical identity of one family; the same shape the mode id is hashed from. */
function familyIdentity(family: GraderFamily): Record<string, unknown> {
	return { kind: "grader-check", checkCode: family.checkCode, subject: family.subject };
}

export function graderFamilyDiscriminator(family: GraderFamily): string {
	return hashValue({ checkCode: family.checkCode, subject: family.subject });
}

/**
 * The failure-mode id one family always gets. Proposals hash these, so every
 * reader — brief, impact, explorer — must derive them from this one function.
 */
export function graderFamilyModeId(family: GraderFamily): string {
	return failureModeId(familyIdentity(family));
}

function failureModeId(identity: Record<string, unknown>): string {
	return shortHashId("failure-mode", { algorithmId: IMPROVEMENT_BRIEF_ALGORITHM_ID, signature: identity });
}

function graderModeDescriptor(
	taskId: string,
	grader: DiagnosticGraderResult,
): Pick<ModeAccumulator, "identity" | "signature" | "category" | "legacy"> {
	const family = graderFamilyOf(grader);
	const legacyIdentity = { kind: "grader-check", legacy: true, taskId, type: grader.type, name: grader.name };
	return {
		identity: family ? familyIdentity(family) : legacyIdentity,
		signature: {
			kind: "grader-check",
			checkCode: family ? family.checkCode : null,
			subject: family ? family.subject : null,
			discriminatorHash: family ? graderFamilyDiscriminator(family) : hashValue(legacyIdentity),
		},
		category: categoryForGrader(grader),
		legacy: family === null,
	};
}

function accumulatorFor(
	modes: Map<string, ModeAccumulator>,
	descriptor: Pick<ModeAccumulator, "identity" | "signature" | "category" | "legacy">,
): ModeAccumulator {
	const key = hashValue({ algorithmId: IMPROVEMENT_BRIEF_ALGORITHM_ID, signature: descriptor.identity });
	const existing = modes.get(key);
	if (existing) {
		if (existing.category !== descriptor.category) {
			throw new Error("verified grader signals contain inconsistent metadata");
		}
		return existing;
	}
	const created: ModeAccumulator = {
		...descriptor,
		failures: new Map(),
		passes: new Map(),
		abstained: new Map(),
	};
	modes.set(key, created);
	return created;
}

function recordObservation(mode: ModeAccumulator, run: RunRecord, grader: DiagnosticGraderResult): void {
	const observation = evidenceForRun(run, [grader.name], grader.passed ? [] : [grader.reason]);
	if (grader.passed) {
		if (!mode.failures.has(run.runId)) {
			mode.passes.set(run.runId, mergeObservation(mode.passes.get(run.runId), observation));
		}
		return;
	}
	mode.passes.delete(run.runId);
	mode.abstained.set(run.runId, (mode.abstained.get(run.runId) ?? true) && grader.abstained === true);
	mode.failures.set(run.runId, mergeObservation(mode.failures.get(run.runId), observation));
}

function sortedObservations(values: Iterable<Observation>): Observation[] {
	return [...values].sort((a, b) =>
		a.rawTaskId.localeCompare(b.rawTaskId) || a.runId.localeCompare(b.runId));
}

function selectRepresentatives(values: Iterable<Observation>, limit: number): Observation[] {
	const sorted = sortedObservations(values);
	const selected: Observation[] = [];
	const selectedRuns = new Set<string>();
	const selectedTasks = new Set<string>();
	for (const observation of sorted) {
		if (selected.length >= limit) break;
		if (selectedTasks.has(observation.rawTaskId)) continue;
		selected.push(observation);
		selectedRuns.add(observation.runId);
		selectedTasks.add(observation.rawTaskId);
	}
	for (const observation of sorted) {
		if (selected.length >= limit) break;
		if (selectedRuns.has(observation.runId)) continue;
		selected.push(observation);
		selectedRuns.add(observation.runId);
	}
	return selected;
}

function publicEvidence(observation: Observation, excerpts: RunExcerpts): BriefEvidence {
	const { notes: _notes, rawTaskId: _rawTaskId, ...evidence } = observation;
	return { ...evidence, excerpt: excerpts.get(observation.runId) ?? null };
}

function evidenceNotes(mode: ModeAccumulator): string[] {
	return [...new Set(sortedObservations(mode.failures.values()).flatMap((item) => item.notes))]
		.sort()
		.slice(0, MAX_EVIDENCE_NOTES);
}

function evidenceStrength(scope: FailureMode["scope"], failed: number, passed: number): FailureMode["evidenceStrength"] {
	if (scope === "systemic" && passed === 0) return "high";
	if (scope === "systemic" || (failed >= 2 && passed === 0)) return "medium";
	return "low";
}

function suggestionsFor(category: FailureModeCategory, legacy: boolean): string[] {
	if (legacy) {
		return [
			"Re-run with structured grader fingerprints before attributing this failure across tasks.",
			"Inspect the exact failed run and grader evidence before changing the harness.",
		];
	}
	switch (category) {
		case "tool-selection":
			return [
				"Review whether the relevant skill description states observable activation conditions.",
				"Prefer one explicit tool-selection rule over task-specific benchmark wording.",
			];
		case "output-contract":
			return [
				"Review whether the required answer structure is explicit in the harness.",
				"Add a general pre-answer completeness check without copying eval answers into instructions.",
			];
		case "answer-quality":
			return [
				"Inspect representative evidence to identify the missing reasoning capability.",
				"Verify that the semantic rubric is stable before changing the harness.",
			];
		case "flaky-behavior":
			return [
				"Increase matched repetitions or run A/A calibration before attributing an improvement.",
				"Prefer a deterministic decision procedure over additional soft prose.",
			];
		case "infrastructure":
			return [
				"Repair the runtime, sandbox, trace, timeout, or grader path before changing the harness.",
				"Re-run the same immutable revision to restore comparable evidence.",
			];
	}
}

/**
 * The English title of a mode. The subject of a required-tool family is part
 * of the name, because "the agent never calls check_dbo" and "the agent never
 * calls search" are two different defects even under one check code.
 */
function modeTitle(mode: ModeAccumulator, scope: FailureMode["scope"]): string {
	if (mode.signature.kind === "outcome-instability") return "Task outcome instability";
	if (mode.signature.kind === "infrastructure-error") {
		const cause = INFRASTRUCTURE_CAUSE_TITLES[(mode.signature.subject ?? "other") as RunErrorClass] ??
			INFRASTRUCTURE_CAUSE_TITLES.other;
		return `Evidence-path failure: ${cause}`;
	}
	if (mode.legacy) return "Task-local legacy grader failure";
	const checkCode = mode.signature.checkCode;
	const base = (checkCode ? GRADER_CHECK_TITLES[checkCode] : undefined) ??
		(mode.category === "tool-selection"
			? "Required tool check failed"
			: mode.category === "output-contract"
				? "Output contract check failed"
				: "Semantic rubric check failed");
	// A tool name is authored outside this module; it is redacted before it
	// becomes prose, exactly as a task id is.
	const subject = mode.signature.subject
		? boundedRedacted(mode.signature.subject, MAX_CHECK_SUBJECT_CHARS).trim()
		: "";
	const named = subject ? `${base}: ${subject}` : base;
	return scope === "systemic" ? `${named} across tasks` : named;
}

/** One clause per observation, always in this order, always with its count. */
const OBSERVATION_ORDER: readonly TraceObservation[] = [
	"no-tool-call",
	"tool-call-as-text",
	"asks-a-question",
	"mixed-script",
	"empty-reply",
];

const OBSERVATION_CLAUSES: Record<TraceObservation, string> = {
	"no-tool-call": "no tool was called in {runs} of {observed} failing {runNoun}",
	"tool-call-as-text": "{runs} {replyNoun} printed a tool call as text instead of making one",
	"asks-a-question": "{runs} {replyNoun} asked the user a question instead of answering",
	"mixed-script": "{runs} {replyNoun} mixed writing systems",
	"empty-reply": "{runs} of {observed} failing {runNoun} ended with no reply at all",
};

/** Counts of every observation across the failing runs whose trace was read. */
function modeObservations(
	failures: readonly Observation[],
	excerpts: RunExcerpts,
): { observations: { code: TraceObservation; runs: number }[]; observedRuns: number } {
	const counts = new Map<TraceObservation, number>();
	let observedRuns = 0;
	for (const failure of failures) {
		const excerpt = excerpts.get(failure.runId);
		if (!excerpt) continue;
		observedRuns += 1;
		for (const code of excerpt.observations) counts.set(code, (counts.get(code) ?? 0) + 1);
	}
	return {
		observations: OBSERVATION_ORDER
			.filter((code) => (counts.get(code) ?? 0) > 0)
			.map((code) => ({ code, runs: counts.get(code)! })),
		observedRuns,
	};
}

/**
 * What the traces show, as a sentence. Every clause is a count of a predicate
 * over trace bytes; when no trace was read there is nothing to say and the
 * mode says exactly that instead of inventing a cause.
 */
function factsFor(
	mode: ModeAccumulator,
	observations: readonly { code: TraceObservation; runs: number }[],
	observedRuns: number,
	failedOccurrences: number,
	totalOccurrences: number,
): string {
	if (mode.signature.kind === "infrastructure-error") {
		const cause = INFRASTRUCTURE_CAUSE_TITLES[(mode.signature.subject ?? "other") as RunErrorClass] ??
			INFRASTRUCTURE_CAUSE_TITLES.other;
		// The cause and the rate, not the trace: the runs counted here never
		// produced a graded answer, so nothing in their traces explains the end.
		return `${failedOccurrences} of ${totalOccurrences} run(s) ended at ${cause}; ` +
			"this is evidence about the evaluation path, not about Target behavior.";
	}
	if (observedRuns === 0 || observations.length === 0) {
		const suffix = observedRuns === 0
			? "no trace was read for them, so nothing beyond the failed check is known"
			: "their traces show nothing else the host can read deterministically";
		return `${failedOccurrences} matching observation(s) failed; ${suffix}.`;
	}
	const clauses = observations.map((item) =>
		OBSERVATION_CLAUSES[item.code]
			.replace("{runs}", String(item.runs))
			.replace("{observed}", String(observedRuns))
			.replace("{runNoun}", observedRuns === 1 ? "run" : "runs")
			.replace("{replyNoun}", item.runs === 1 ? "reply" : "replies"));
	const sentence = `${clauses[0]!.charAt(0).toUpperCase()}${clauses[0]!.slice(1)}`;
	return `${[sentence, ...clauses.slice(1)].join("; ")}.`;
}

function finalizeMode(mode: ModeAccumulator, totalTasks: number, excerpts: RunExcerpts): FailureMode {
	const failures = sortedObservations(mode.failures.values());
	const passes = sortedObservations(mode.passes.values());
	const affectedTaskIds = [...new Set(failures.map((item) => item.rawTaskId))].sort();
	const coverageBps = totalTasks === 0 ? 0 : Math.floor(affectedTaskIds.length * 10_000 / totalTasks);
	const scope: FailureMode["scope"] = affectedTaskIds.length >= 2 ? "systemic" : "task-local";
	const failedOccurrences = failures.length;
	const passedOccurrences = passes.length;
	const occurrenceTotal = failedOccurrences + passedOccurrences;
	const selectedEvidence = selectRepresentatives(failures, MAX_EVIDENCE);
	const selectedCounterEvidence = selectRepresentatives(passes, MAX_COUNTER_EVIDENCE);
	const { observations, observedRuns } = modeObservations(failures, excerpts);
	// A mode is a proposal target when it reproduces often enough that a
	// harness change can plausibly move it. Counter-evidence (passes of the same
	// exact signature) is kept and shown as the reproduction rate; it no longer
	// vetoes the mode, because on a noisy agent with repetitions almost every
	// real weakness passes sometimes. Below the floor the honest advice is more
	// repetitions or calibration, not a harness change.
	const reproductionBps = occurrenceTotal === 0 ? 0 : Math.floor(failedOccurrences * 10_000 / occurrenceTotal);
	// Every failure here is a judge that declined to decide. There is no agent
	// behaviour under it to change, so the honest move is a steadier instrument
	// or another run — never a harness proposal aimed at a shrug.
	const abstained = failures.length > 0 && failures.every((item) => mode.abstained.get(item.runId) === true);
	const decision: FailureModeDecision = mode.signature.kind === "infrastructure-error"
		? "repair-evidence-path"
		: mode.signature.kind === "outcome-instability" || mode.legacy || abstained ||
				reproductionBps < PROPOSAL_REPRODUCTION_FLOOR_BPS
			? "stabilize-and-rerun"
			: "propose-harness-change";
	return FailureModeSchema.parse({
		failureModeId: failureModeId(mode.identity),
		signature: mode.signature,
		category: mode.category,
		scope,
		severity: mode.signature.kind === "infrastructure-error" ? "blocking" : scope === "systemic" ? "major" : "minor",
		evidenceStrength: evidenceStrength(scope, failedOccurrences, passedOccurrences),
		decision,
		...(abstained ? { abstained: true } : {}),
		title: modeTitle(mode, scope),
		summary:
			`${affectedTaskIds.length}/${totalTasks} task(s) affected; ` +
			`${failedOccurrences}/${occurrenceTotal} matching observation(s) failed.`,
		facts: factsFor(mode, observations, observedRuns, failedOccurrences, occurrenceTotal),
		observations,
		observedRuns,
		suggestions: suggestionsFor(mode.category, mode.legacy).slice(0, MAX_SUGGESTIONS),
		impact: {
			affectedTasks: affectedTaskIds.length,
			totalTasks,
			taskCoverageBps: coverageBps,
			failedOccurrences,
			passedOccurrences,
			reproductionBps: Math.floor(failedOccurrences * 10_000 / occurrenceTotal),
		},
		taskIds: affectedTaskIds.slice(0, MAX_TASK_IDS).map(publicTaskId),
		// Only the failing side carries an excerpt: a reader opens the raw trace
		// of a failure, never of a pass that is only there for the rate.
		evidence: selectedEvidence.map((item) => publicEvidence(item, excerpts)),
		counterEvidence: selectedCounterEvidence.map((item) => publicEvidence(item, new Map())),
		evidenceNotes: evidenceNotes(mode),
		omittedEvidenceCount:
			failures.length - selectedEvidence.length + passes.length - selectedCounterEvidence.length,
	});
}

function modeRank(mode: FailureMode): number {
	if (mode.severity === "blocking") return 0;
	if (mode.scope === "systemic") return 1;
	return 2;
}

/**
 * A mode a proposal can address comes before every reading that only says
 * "run it again": «чини первую» must land on something a harness change can
 * fix. Live session 8: the one proposal-eligible mode (the world left wrong,
 * reproduced 67%) sat fourth behind three stabilize-and-rerun readings, past
 * the model's projection, and the Builder could not bind its edit to it.
 */
function decisionRank(mode: FailureMode): number {
	if (mode.decision === "propose-harness-change") return 0;
	if (mode.decision === "stabilize-and-rerun") return 1;
	return 2;
}

function compareModes(a: FailureMode, b: FailureMode): number {
	return decisionRank(a) - decisionRank(b) ||
		modeRank(a) - modeRank(b) ||
		b.impact.affectedTasks - a.impact.affectedTasks ||
		b.impact.failedOccurrences - a.impact.failedOccurrences ||
		b.impact.reproductionBps - a.impact.reproductionBps ||
		a.failureModeId.localeCompare(b.failureModeId);
}

function taskUniverse(record: DiagnosticEvalRecord, runs: readonly RunRecord[]): string[] {
	const observed = [...new Set(runs.map((run) => run.taskId))].sort();
	if (!record.taskIds) return observed;
	const formal = [...new Set(record.taskIds)].sort();
	const formalSet = new Set(formal);
	if (observed.some((taskId) => !formalSet.has(taskId))) {
		throw new Error("verified evaluation task inventory is inconsistent");
	}
	return formal;
}

function taskOutcomes(runs: readonly RunRecord[]): Map<string, TaskOutcomes> {
	const tasks = new Map<string, TaskOutcomes>();
	for (const run of runs) {
		const outcomes = tasks.get(run.taskId) ?? { pass: [], fail: [], error: [] };
		if (run.status === "error") outcomes.error.push(run);
		else if (run.evalResults?.outcome === "pass") outcomes.pass.push(run);
		else outcomes.fail.push(run);
		tasks.set(run.taskId, outcomes);
	}
	return tasks;
}

function addFlakyModes(
	modes: Map<string, ModeAccumulator>,
	outcomesByTask: ReadonlyMap<string, TaskOutcomes>,
): void {
	for (const [, outcomes] of [...outcomesByTask.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		if (outcomes.pass.length === 0 || outcomes.fail.length === 0) continue;
		// One mode, however many cases flip. A flip has one cause worth naming —
		// the same revision does not decide the same case the same way twice —
		// and three identical task-local rows say that three times instead of
		// once, which is the noise this brief exists to remove.
		const identity = { kind: "outcome-instability" };
		const mode = accumulatorFor(modes, {
			identity,
			signature: {
				kind: "outcome-instability",
				checkCode: null,
				subject: null,
				discriminatorHash: hashValue(identity),
			},
			category: "flaky-behavior",
			legacy: false,
		});
		for (const run of outcomes.fail) mode.failures.set(run.runId, evidenceForRun(run));
		for (const run of outcomes.pass) mode.passes.set(run.runId, evidenceForRun(run));
	}
}

/**
 * One infrastructure mode per CAUSE, never one per task.
 *
 * Session 7 printed `7 типов сбоя` over seven identical sentences that
 * differed only by a run id: one hung network read, split into seven rows,
 * read as seven problems. The cause is typed — `run timed out after …`,
 * `command Target exited with …` — so runs that ended the same way are one
 * mode with the tasks it hit listed inside it.
 *
 * Invariant 29 is untouched: it clusters BEHAVIOURAL modes by exact typed
 * grader family, and an infrastructure mode has no grader family at all. The
 * counter-evidence is every non-error run of the whole evaluation, because
 * "the run timed out in 21 of 24 executions" is the rate a reader needs — a
 * per-task denominator made every fully-failed task reproduce at 100%.
 */
function addInfrastructureModes(
	modes: Map<string, ModeAccumulator>,
	outcomesByTask: ReadonlyMap<string, TaskOutcomes>,
): void {
	const byCause = new Map<RunErrorClass, RunRecord[]>();
	const survivors: RunRecord[] = [];
	for (const [, outcomes] of [...outcomesByTask.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		for (const run of outcomes.error) {
			const cause = classifyRunError(run.error);
			const bucket = byCause.get(cause) ?? [];
			bucket.push(run);
			byCause.set(cause, bucket);
		}
		survivors.push(...outcomes.pass, ...outcomes.fail);
	}
	for (const cause of [...byCause.keys()].sort()) {
		const errors = byCause.get(cause)!;
		const identity = { kind: "infrastructure-error", code: cause };
		const mode = accumulatorFor(modes, {
			identity,
			signature: {
				kind: "infrastructure-error",
				checkCode: null,
				// The cause is the thing this family names, exactly as a tool name is
				// the thing a required-tool family names.
				subject: cause,
				discriminatorHash: hashValue({ code: cause }),
			},
			category: "infrastructure",
			legacy: false,
		});
		for (const run of errors) {
			mode.failures.set(run.runId, evidenceForRun(run, [], run.error ? [run.error] : []));
		}
		for (const run of survivors) mode.passes.set(run.runId, evidenceForRun(run));
	}
}

/** One canonical grouping pass, used both by the bounded brief and complete run navigation. */
function collectModeObservations(
	runs: readonly RunRecord[],
	outcomesByTask: ReadonlyMap<string, TaskOutcomes> = taskOutcomes(runs),
): Map<string, ModeAccumulator> {
	const modes = new Map<string, ModeAccumulator>();
	for (const run of runs) {
		if (run.status === "error") continue;
		for (const grader of run.evalResults?.graders ?? []) {
			const diagnosticGrader = grader as DiagnosticGraderResult;
			recordObservation(accumulatorFor(modes, graderModeDescriptor(run.taskId, diagnosticGrader)), run, diagnosticGrader);
		}
	}
	addFlakyModes(modes, outcomesByTask);
	addInfrastructureModes(modes, outcomesByTask);
	return modes;
}

/**
 * Full failing-run membership for the selected canonical modes, not the brief's
 * capped representative excerpts. Callers supply the same verified runs that
 * produced the brief. Grader families, legacy checks, instability and execution
 * errors all use the compilation matcher; this adds no alternative classifier.
 */
export function failureModeRunMembership(runs: readonly RunRecord[], modeIds: ReadonlySet<string>): Map<string, string[]> {
	const membership = new Map<string, string[]>();
	for (const mode of collectModeObservations(runs).values()) {
		const id = failureModeId(mode.identity);
		if (!modeIds.has(id)) continue;
		for (const runId of mode.failures.keys()) {
			const ids = membership.get(runId) ?? [];
			ids.push(id);
			membership.set(runId, ids);
		}
	}
	return membership;
}

function headlineFor(
	status: ImprovementBrief["status"],
	passed: number,
	total: number,
	failureModeCount: number,
	systemicFailureModeCount: number,
	infrastructureErrors: number,
): string {
	if (status === "inconclusive") {
		return `${passed}/${total} passed. Evidence is inconclusive: ${infrastructureErrors} infrastructure error(s) must be repaired before proposing a harness change.`;
	}
	if (status === "healthy") return `${passed}/${total} passed. No diagnosed behavioral failure modes were found.`;
	return `${passed}/${total} passed. Found ${failureModeCount} diagnosed failure mode(s); ${systemicFailureModeCount} repeat across tasks.`;
}

/**
 * A refusal about what a harness change can and cannot answer.
 *
 * Minted twice, the way every refusal a person is meant to act on is: the
 * English `message` is what the model reads and what scripts match on, and
 * `reason` is the pair the host draws in the operator's language. Session 8
 * met the earlier plain `Error` verbatim on the transcript, could not parse
 * it, and asked the operator to "открыть пункт в панели" — which is not a
 * thing this product has.
 */
export class ProposalIneligibleError extends Error {
	readonly reason: { code: string; detail?: string };

	constructor(message: string, reason: { code: string; detail?: string }) {
		super(message);
		this.name = "ProposalIneligibleError";
		this.reason = reason;
	}
}

/**
 * Resolve model-selected failure-mode handles inside one exact canonical brief.
 * The returned diagnoses are entirely host-derived; callers can select modes
 * but cannot author failure identity, evidence references, or causal claims.
 */
export function deriveEvidenceLinkedProposalSelection(
	briefValue: ImprovementBrief,
	selectionValue: ProposalBasisSelection,
): EvidenceLinkedProposalSelection {
	const brief = ImprovementBriefSchema.parse(briefValue);
	const selection = ProposalBasisSelectionSchema.parse(selectionValue);
	if (
		selection.algorithmId !== brief.algorithmId ||
		selection.evalRunId !== brief.evalRunId ||
		selection.diagnosisId !== brief.diagnosisId ||
		selection.briefId !== brief.briefId
	) {
		throw new Error("proposal basis does not match the exact improvement brief");
	}
	if (brief.status !== "actionable" || !brief.proposalEligible) {
		throw new ProposalIneligibleError(
			"improvement evidence is not eligible for a harness proposal",
			{ code: "refusal.brief-not-proposable" },
		);
	}

	const requested = new Set(selection.failureModeIds);
	const selected = brief.modes.filter((mode) => requested.has(mode.failureModeId));
	if (selected.length !== requested.size) {
		throw new Error("one or more selected failure modes are absent from the exact improvement brief");
	}
	for (const mode of selected) {
		if (mode.decision !== "propose-harness-change") {
			throw new ProposalIneligibleError(
				`failure mode ${mode.failureModeId} is not eligible for a harness proposal`,
				{ code: "refusal.mode-not-proposable", detail: mode.failureModeId },
			);
		}
	}

	const diagnoses = selected.map((mode): EvidenceLinkedProposalDiagnosis => ({
		failureIds: [mode.failureModeId],
		evidence: mode.evidence.map((item) => `eval:${brief.evalRunId}/run:${item.runId}`),
		rootCause: `Host-derived from the cited traces (what happened, not why): ${mode.facts}`,
	}));
	return {
		basis: ProposalBasisAttestationSchema.parse({
			schemaVersion: 1,
			algorithmId: brief.algorithmId,
			evalRunId: brief.evalRunId,
			diagnosisId: brief.diagnosisId,
			briefId: brief.briefId,
			briefSha256: hashValue(brief),
			failureModes: selected.map((mode) => ({
				failureModeId: mode.failureModeId,
				modeSha256: hashValue(mode),
			})),
		}),
		diagnoses,
	};
}

/**
	* Compile a bounded, deterministic improvement brief from one already-final
	* diagnosis and its re-verified immutable EvalRun evidence. This performs no
	* model or network calls and opens no trace: the raw excerpts every mode
	* carries were read once, by the diagnosis, and are quoted from it.
	*/
export function compileImprovementBrief(
	runsRoot: string,
	diagnosis: DiagnosisRecord,
): ImprovementBrief {
	const preflight = readEvalRunIndex(runsRoot, diagnosis.evalRunId);
	if (isSealedEvalRun(preflight)) {
		throw new Error("improvement brief is unavailable for this evaluation");
	}
	const verified = loadVerifiedEvalRun(runsRoot, diagnosis.evalRunId);
	const record = verified.record as DiagnosticEvalRecord;
	if (isSealedEvalRun(record)) {
		throw new Error("improvement brief is unavailable for this evaluation");
	}
	const inputHash = hashValue({ evalRun: verified.record, runs: verified.runs });
	const expectedDiagnosisId = `diagnosis-${inputHash.slice(HASH_HEX_OFFSET, HASH_HEX_OFFSET + 20)}`;
	if (
		diagnosis.evalRunId !== verified.record.evalRunId ||
		diagnosis.targetId !== verified.record.target.id ||
		diagnosis.targetRevision !== verified.record.target.gitSha ||
		diagnosis.inputHash !== inputHash ||
		diagnosis.diagnosisId !== expectedDiagnosisId
	) {
		throw new Error("diagnosis does not match the verified evaluation evidence");
	}

	const tasks = taskUniverse(record, verified.runs);
	const outcomesByTask = taskOutcomes(verified.runs);
	const accumulators = collectModeObservations(verified.runs, outcomesByTask);

	const excerpts: RunExcerpts = new Map(
		(diagnosis.runEvidence ?? []).map((item) => [
			item.runId,
			{ toolNames: item.toolNames, reply: item.reply, observations: item.observations },
		]),
	);
	const allModes = [...accumulators.values()]
		.filter((mode) => mode.failures.size > 0)
		.map((mode) => finalizeMode(mode, tasks.length, excerpts))
		.sort(compareModes);
	const infrastructureErrors = verified.runs.filter((run) => run.status === "error").length;
	const derivedStatus: ImprovementBrief["status"] = infrastructureErrors > 0
		? "inconclusive"
		: allModes.length > 0 ? "actionable" : "healthy";
	if (diagnosis.status !== derivedStatus) {
		throw new DiagnosisClassificationMismatch();
	}
	const failedTasks = [...outcomesByTask.values()]
		.filter((outcomes) => outcomes.fail.length > 0 || outcomes.error.length > 0)
		.length;
	const systemicFailureModeCount = allModes.filter((mode) => mode.scope === "systemic").length;
	const taskLocalFailureModeCount = allModes.length - systemicFailureModeCount;
	const hasEligibleDiagnosis =
		derivedStatus === "actionable" &&
		infrastructureErrors === 0;

	let modes = allModes.slice(0, MAX_FAILURE_MODES);
	for (;;) {
		const candidate = {
			schemaVersion: 1 as const,
			algorithmId: IMPROVEMENT_BRIEF_ALGORITHM_ID,
			briefId: shortHashId("brief", {
				algorithmId: IMPROVEMENT_BRIEF_ALGORITHM_ID,
				diagnosisInputHash: diagnosis.inputHash,
			}),
			evalRunId: verified.record.evalRunId,
			diagnosisId: diagnosis.diagnosisId,
			status: derivedStatus,
			proposalEligible:
				hasEligibleDiagnosis && modes.some((mode) => mode.decision === "propose-harness-change"),
			headline: headlineFor(
				derivedStatus,
				verified.record.summary.pass,
				verified.record.summary.total,
				allModes.length,
				systemicFailureModeCount,
				infrastructureErrors,
			),
			summary: {
				tasks: tasks.length,
				failedTasks,
				infrastructureErrors,
				failureModeCount: allModes.length,
				systemicFailureModeCount,
				taskLocalFailureModeCount,
				omittedFailureModeCount: allModes.length - modes.length,
			},
			modes,
		};
		const parsed = ImprovementBriefSchema.safeParse(candidate);
		if (parsed.success) return parsed.data;
		if (Buffer.byteLength(canonicalJson(candidate), "utf8") <= MAX_BRIEF_BYTES || modes.length === 0) {
			return ImprovementBriefSchema.parse(candidate);
		}
		// Modes are already highest-priority first. Remove the lowest-ranked
		// projection until the complete canonical brief fits the hard byte cap.
		modes = modes.slice(0, -1);
	}
}
