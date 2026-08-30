import { z } from "zod";
import {
	DiagnosisCategorySchema,
	type DiagnosisRecord,
} from "../diagnosis.js";
import { isSealedEvalRun, loadVerifiedEvalRun, readEvalRunIndex } from "../eval.js";
import {
	GraderCheckCodeSchema,
	HashSchema,
	canonicalJson,
	hashValue,
	type GraderCheckCode,
	type GraderResult,
	type RunRecord,
} from "../provenance.js";
import { redactTraceText } from "../trace.js";

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
});

export const FailureModeIdSchema = z.string().regex(/^failure-mode-[0-9a-f]{24}$/);

export const FailureModeSchema = z.strictObject({
	failureModeId: FailureModeIdSchema,
	signature: z.strictObject({
		kind: z.enum(["grader-check", "outcome-instability", "infrastructure-error"]),
		checkCode: GraderCheckCodeSchema.nullable(),
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
	title: z.string().min(1).max(500),
	summary: z.string().min(1).max(1_000),
	hypothesis: z.string().min(1).max(1_000),
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
};

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
 * What a failed check says about the harness. An exact match against a
 * reference answer is a contract on the output; a similarity threshold and a
 * rubric are both statements about how good the answer was.
 */
const GRADER_CHECK_CATEGORIES: Record<GraderCheckCode, FailureModeCategory> = {
	"required-tool": "tool-selection",
	"output-contains": "output-contract",
	"output-matches": "output-contract",
	"reference-exact": "output-contract",
	"semantic-rubric": "answer-quality",
	"reference-similarity": "answer-quality",
};

/** Title of an exact (non-legacy) grader failure mode. */
const GRADER_CHECK_TITLES: Record<GraderCheckCode, string> = {
	"required-tool": "Required tool check failed",
	"output-contains": "Output contract check failed",
	"output-matches": "Output contract check failed",
	"reference-exact": "Exact reference-answer check failed",
	"semantic-rubric": "Semantic rubric check failed",
	"reference-similarity": "Reference similarity check failed",
};

function categoryForGrader(grader: DiagnosticGraderResult): FailureModeCategory {
	const known = grader.checkCode ? GRADER_CHECK_CATEGORIES[grader.checkCode] : undefined;
	if (known) return known;
	if (grader.type === "tool_called") return "tool-selection";
	if (grader.type === "output_contains" || grader.type === "output_matches" || grader.type === "exact") {
		return "output-contract";
	}
	return "answer-quality";
}

function graderModeDescriptor(
	taskId: string,
	grader: DiagnosticGraderResult,
): Pick<ModeAccumulator, "identity" | "signature" | "category" | "legacy"> {
	const exact =
		typeof grader.checkCode === "string" && grader.checkCode.length > 0 && grader.checkCode.length <= 200 &&
		typeof grader.specHash === "string" && HASH_PATTERN.test(grader.specHash);
	const identity = exact
		? { kind: "grader-check", checkCode: grader.checkCode, specHash: grader.specHash }
		: { kind: "grader-check", legacy: true, taskId, type: grader.type, name: grader.name };
	return {
		identity,
		signature: {
			kind: "grader-check",
			checkCode: exact ? grader.checkCode! : null,
			discriminatorHash: hashValue(exact
				? { checkCode: grader.checkCode, specHash: grader.specHash }
				: { legacy: true, taskId, type: grader.type, name: grader.name }),
		},
		category: categoryForGrader(grader),
		legacy: !exact,
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

function publicEvidence(observation: Observation): BriefEvidence {
	const { notes: _notes, rawTaskId: _rawTaskId, ...evidence } = observation;
	return evidence;
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

function modeWords(mode: ModeAccumulator, scope: FailureMode["scope"]): {
	title: string;
	hypothesis: string;
} {
	if (mode.signature.kind === "outcome-instability") {
		return {
			title: "Task outcome instability",
			hypothesis: "The same task both passed and behaviorally failed under matched repetitions. This is observed instability, not a proven harness root cause.",
		};
	}
	if (mode.signature.kind === "infrastructure-error") {
		return {
			title: "Task-local evidence-path failure",
			hypothesis: "Execution ended before comparable behavioral grading. The error is evidence about the evaluation path, not about Target behavior.",
		};
	}
	if (mode.legacy) {
		return {
			title: "Task-local legacy grader failure",
			hypothesis: "A grader predicate failed, but the legacy result lacks an exact check code and spec fingerprint. Cross-task attribution would be unsafe.",
		};
	}
	const checkCode = mode.signature.kind === "grader-check" ? mode.signature.checkCode : null;
	const exactTitle = (checkCode ? GRADER_CHECK_TITLES[checkCode] : undefined) ??
		(mode.category === "tool-selection"
			? "Required tool check failed"
			: mode.category === "output-contract"
				? "Output contract check failed"
				: "Semantic rubric check failed");
	return {
		title: scope === "systemic" ? `${exactTitle} across tasks` : exactTitle,
		hypothesis: "The same deterministic grader predicate was unsatisfied in the cited runs. This identifies the failed predicate, not why the harness missed it.",
	};
}

function finalizeMode(mode: ModeAccumulator, totalTasks: number): FailureMode {
	const failures = sortedObservations(mode.failures.values());
	const passes = sortedObservations(mode.passes.values());
	const affectedTaskIds = [...new Set(failures.map((item) => item.rawTaskId))].sort();
	const scope: FailureMode["scope"] = affectedTaskIds.length >= 2 ? "systemic" : "task-local";
	const failedOccurrences = failures.length;
	const passedOccurrences = passes.length;
	const occurrenceTotal = failedOccurrences + passedOccurrences;
	const selectedEvidence = selectRepresentatives(failures, MAX_EVIDENCE);
	const selectedCounterEvidence = selectRepresentatives(passes, MAX_COUNTER_EVIDENCE);
	const words = modeWords(mode, scope);
	// A mode is a proposal target when it reproduces often enough that a
	// harness change can plausibly move it. Counter-evidence (passes of the same
	// exact signature) is kept and shown as the reproduction rate; it no longer
	// vetoes the mode, because on a noisy agent with repetitions almost every
	// real weakness passes sometimes. Below the floor the honest advice is more
	// repetitions or calibration, not a harness change.
	const reproductionBps = occurrenceTotal === 0 ? 0 : Math.floor(failedOccurrences * 10_000 / occurrenceTotal);
	const decision: FailureModeDecision = mode.signature.kind === "infrastructure-error"
		? "repair-evidence-path"
		: mode.signature.kind === "outcome-instability" || mode.legacy || reproductionBps < PROPOSAL_REPRODUCTION_FLOOR_BPS
			? "stabilize-and-rerun"
			: "propose-harness-change";
	return FailureModeSchema.parse({
		failureModeId: shortHashId("failure-mode", {
			algorithmId: IMPROVEMENT_BRIEF_ALGORITHM_ID,
			signature: mode.identity,
		}),
		signature: mode.signature,
		category: mode.category,
		scope,
		severity: mode.signature.kind === "infrastructure-error" ? "blocking" : scope === "systemic" ? "major" : "minor",
		evidenceStrength: evidenceStrength(scope, failedOccurrences, passedOccurrences),
		decision,
		title: words.title,
		summary:
			`${affectedTaskIds.length}/${totalTasks} task(s) affected; ` +
			`${failedOccurrences}/${occurrenceTotal} matching observation(s) failed.`,
		hypothesis: words.hypothesis,
		suggestions: suggestionsFor(mode.category, mode.legacy).slice(0, MAX_SUGGESTIONS),
		impact: {
			affectedTasks: affectedTaskIds.length,
			totalTasks,
			taskCoverageBps: totalTasks === 0 ? 0 : Math.floor(affectedTaskIds.length * 10_000 / totalTasks),
			failedOccurrences,
			passedOccurrences,
			reproductionBps: Math.floor(failedOccurrences * 10_000 / occurrenceTotal),
		},
		taskIds: affectedTaskIds.slice(0, MAX_TASK_IDS).map(publicTaskId),
		evidence: selectedEvidence.map(publicEvidence),
		counterEvidence: selectedCounterEvidence.map(publicEvidence),
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

function compareModes(a: FailureMode, b: FailureMode): number {
	return modeRank(a) - modeRank(b) ||
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
	for (const [taskId, outcomes] of [...outcomesByTask.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		if (outcomes.pass.length === 0 || outcomes.fail.length === 0) continue;
		const identity = { kind: "outcome-instability", taskId };
		const mode = accumulatorFor(modes, {
			identity,
			signature: {
				kind: "outcome-instability",
				checkCode: null,
				discriminatorHash: hashValue({ taskId }),
			},
			category: "flaky-behavior",
			legacy: false,
		});
		for (const run of outcomes.fail) mode.failures.set(run.runId, evidenceForRun(run));
		for (const run of outcomes.pass) mode.passes.set(run.runId, evidenceForRun(run));
	}
}

function addInfrastructureModes(
	modes: Map<string, ModeAccumulator>,
	outcomesByTask: ReadonlyMap<string, TaskOutcomes>,
): void {
	for (const [taskId, outcomes] of [...outcomesByTask.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		if (outcomes.error.length === 0) continue;
		// RunRecord currently has no stable structured infrastructure code. Keep
		// unknown failures task-local instead of merging unrelated errors.
		const identity = { kind: "infrastructure-error", code: "unknown", taskId };
		const mode = accumulatorFor(modes, {
			identity,
			signature: {
				kind: "infrastructure-error",
				checkCode: null,
				discriminatorHash: hashValue({ code: "unknown", taskId }),
			},
			category: "infrastructure",
			legacy: false,
		});
		for (const run of outcomes.error) {
			mode.failures.set(run.runId, evidenceForRun(run, [], run.error ? [run.error] : []));
		}
		for (const run of [...outcomes.pass, ...outcomes.fail]) {
			mode.passes.set(run.runId, evidenceForRun(run));
		}
	}
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
		throw new Error("improvement evidence is not eligible for a harness proposal");
	}

	const requested = new Set(selection.failureModeIds);
	const selected = brief.modes.filter((mode) => requested.has(mode.failureModeId));
	if (selected.length !== requested.size) {
		throw new Error("one or more selected failure modes are absent from the exact improvement brief");
	}
	for (const mode of selected) {
		if (mode.decision !== "propose-harness-change") {
			throw new Error(`failure mode ${mode.failureModeId} is not eligible for a harness proposal`);
		}
	}

	const diagnoses = selected.map((mode): EvidenceLinkedProposalDiagnosis => ({
		failureIds: [mode.failureModeId],
		evidence: mode.evidence.map((item) => `eval:${brief.evalRunId}/run:${item.runId}`),
		rootCause: `Host-derived hypothesis (not proven): ${mode.hypothesis}`,
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
	* model or network calls and never reads trace content.
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
	const accumulators = new Map<string, ModeAccumulator>();
	for (const run of verified.runs) {
		if (run.status === "error") continue;
		for (const grader of run.evalResults?.graders ?? []) {
			const diagnosticGrader = grader as DiagnosticGraderResult;
			const descriptor = graderModeDescriptor(run.taskId, diagnosticGrader);
			const mode = accumulatorFor(accumulators, descriptor);
			recordObservation(mode, run, diagnosticGrader);
		}
	}
	addFlakyModes(accumulators, outcomesByTask);
	addInfrastructureModes(accumulators, outcomesByTask);

	const allModes = [...accumulators.values()]
		.filter((mode) => mode.failures.size > 0)
		.map((mode) => finalizeMode(mode, tasks.length))
		.sort(compareModes);
	const infrastructureErrors = verified.runs.filter((run) => run.status === "error").length;
	const derivedStatus: ImprovementBrief["status"] = infrastructureErrors > 0
		? "inconclusive"
		: allModes.length > 0 ? "actionable" : "healthy";
	if (diagnosis.status !== derivedStatus) {
		throw new Error("diagnosis does not match the verified evaluation evidence");
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
