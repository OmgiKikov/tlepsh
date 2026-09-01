import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileImprovementBrief, publicTaskId, type ImprovementBrief } from "../application/improvement-brief.js";
import { candidateRecordPath, loadCandidateRecord } from "../application/candidate-review.js";
import {
	candidateFlip,
	explainRun,
	graderFindings,
	openRunTrace,
	runScore,
	runTranscript,
	runsTable,
	traceFacts,
	type CandidateFlip,
	type RunRow,
} from "../application/run-explanation.js";
import { compareVerifiedEvalRuns, renderGateLine, type CompareResult } from "../compare.js";
import { diagnosisPath, loadDiagnosis } from "../diagnosis.js";
import type { CandidateRecord, EvaluationEvidence } from "../domain/candidate.js";
import { gateVerdictOf } from "../domain/candidate.js";
import {
	isSealedEvalRun,
	loadRun,
	loadVerifiedEvalRun,
	readEvalRunIndex,
	type EvalRunRecord,
	type VerifiedEvalRun,
} from "../eval.js";
import type { RunRecord } from "../provenance.js";
import { judgeCalibrationRows } from "../report.js";
import { resolveContainedArtifactPath, safeArtifactSegment } from "../storage/paths.js";
import type {
	ComparePageModel,
	ComparePageRow,
	EvalPageModel,
	EvalPageMode,
	RunDetailPageModel,
} from "./pages.js";

/**
 * Page models for the Evidence Explorer.
 *
 * Reading only: every function here opens artifacts that already exist, refuses
 * anything sealed before it is projected, and returns a plain object the HTML
 * layer renders. No page may be produced from evidence whose integrity was not
 * verified first, and no page may be produced from an eval whose lineage
 * touches a sealed run.
 */

/** Candidate directories inspected while looking for one that covers an eval. */
const MAX_SCANNED_CANDIDATES = 200;

export class EvidenceNotFound extends Error {}
export class EvidenceNotDiagnosed extends Error {}

/**
 * Load one eval's verified evidence, refusing sealed visibility on the eval
 * itself and on the baseline it is linked to. The second refusal is what keeps
 * a development candidate from rendering a sealed baseline's shape by proxy.
 */
function loadPublicEvalRun(runsRoot: string, evalRunId: string): VerifiedEvalRun {
	const index = readEvalRunIndex(runsRoot, evalRunId);
	if (isSealedEvalRun(index)) throw new EvidenceNotFound(`eval run ${evalRunId} is not public evidence`);
	if (index.baselineEvalRunId) {
		const baseline = readEvalRunIndex(runsRoot, index.baselineEvalRunId);
		if (isSealedEvalRun(baseline)) {
			throw new Error("cross-visibility baseline evidence is unavailable");
		}
	}
	const verified = loadVerifiedEvalRun(runsRoot, evalRunId);
	if (isSealedEvalRun(verified.record)) {
		throw new Error("evaluation visibility changed during collection");
	}
	return verified;
}

function requireDiagnosis(runsRoot: string, evalRunId: string): ImprovementBrief {
	// HTTP remains a read-only projection: a diagnosis must have been produced by
	// the canonical workflow before it can be viewed.
	if (!existsSync(diagnosisPath(runsRoot, evalRunId))) {
		throw new EvidenceNotDiagnosed(evalRunId);
	}
	return compileImprovementBrief(runsRoot, loadDiagnosis(runsRoot, evalRunId));
}

/** What one arm actually spent, judge and simulated user included. */
function armCostUsd(runs: readonly RunRecord[]): number {
	return runs.reduce(
		(total, run) =>
			total + run.metrics.costUsd + (run.metrics.judge?.costUsd ?? 0) + (run.metrics.simulatedUser?.costUsd ?? 0),
		0,
	);
}

function modelLine(record: EvalRunRecord): string | null {
	const axes = record.provenance;
	return `${axes.provider}/${axes.modelId} · thinking ${axes.thinkingLevel}`;
}

// ---------- Candidate lookup ----------

interface CandidateCoverage {
	record: CandidateRecord;
	evaluation: EvaluationEvidence;
}

function evaluatedEvidence(record: CandidateRecord): EvaluationEvidence | null {
	for (let index = record.events.length - 1; index >= 0; index -= 1) {
		const event = record.events[index];
		if (event?.type === "evaluated") return event.evaluation;
	}
	return null;
}

/** Candidate records whose development pair names this eval run, newest first. */
export function candidatesCovering(runsRoot: string, evalRunId: string): CandidateCoverage[] {
	const root = join(resolve(runsRoot), "candidates");
	let entries: string[];
	try {
		entries = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.slice(0, MAX_SCANNED_CANDIDATES);
	} catch {
		return [];
	}
	const found: CandidateCoverage[] = [];
	for (const name of entries) {
		try {
			safeArtifactSegment(name, "candidate id");
			const record = loadCandidateRecord(runsRoot, name);
			const evaluation = evaluatedEvidence(record);
			if (!evaluation) continue;
			if (
				evaluation.development.baseline.evalRunId === evalRunId ||
				evaluation.development.candidate.evalRunId === evalRunId
			) {
				found.push({ record, evaluation });
			}
		} catch {
			// A damaged candidate cannot hide an eval's own evidence.
		}
	}
	return found.sort((left, right) => right.record.createdAt.localeCompare(left.record.createdAt));
}

/**
 * How the candidate that covers this task moved it, baseline → candidate.
 *
 * Both arms must be public development evidence; a candidate whose development
 * pair somehow points at sealed evidence yields no flip rather than a redacted
 * one.
 */
function flipForTask(
	runsRoot: string,
	coverage: CandidateCoverage,
	rawTaskId: string,
): CandidateFlip | null {
	const baselineId = coverage.evaluation.development.baseline.evalRunId;
	const candidateId = coverage.evaluation.development.candidate.evalRunId;
	try {
		const baseline = loadPublicEvalRun(runsRoot, baselineId);
		const candidate = loadPublicEvalRun(runsRoot, candidateId);
		const count = (verified: VerifiedEvalRun) => {
			const runs = verified.runs.filter((run) => run.taskId === rawTaskId);
			return {
				pass: runs.filter((run) => run.evalResults?.outcome === "pass").length,
				total: runs.length,
			};
		};
		const before = count(baseline);
		const after = count(candidate);
		if (before.total === 0 && after.total === 0) return null;
		return candidateFlip({
			candidateId: coverage.record.candidateId,
			mode: coverage.evaluation.mode,
			baselineEvalRunId: baselineId,
			candidateEvalRunId: candidateId,
			baselinePass: before.pass,
			baselineTotal: before.total,
			candidatePass: after.pass,
			candidateTotal: after.total,
		});
	} catch {
		return null;
	}
}

// ---------- Eval page ----------

export interface EvalPageQuery {
	outcome?: string | undefined;
	mode?: string | undefined;
}

export interface EvalPageOptions {
	labels?: { stateRoot: string; projectId: string } | undefined;
	query?: EvalPageQuery;
}

export function collectEvalPage(
	runsRoot: string,
	evalRunId: string,
	options: EvalPageOptions = {},
): EvalPageModel {
	const verified = loadPublicEvalRun(runsRoot, evalRunId);
	const brief = requireDiagnosis(runsRoot, evalRunId);
	const record = verified.record;
	const allRows = runsTable(runsRoot, verified.runs, brief);
	const runCountByMode = new Map<string, number>();
	for (const row of allRows) {
		for (const id of row.failureModeIds) runCountByMode.set(id, (runCountByMode.get(id) ?? 0) + 1);
	}
	const modes: EvalPageMode[] = brief.modes.map((mode) => ({
		id: mode.failureModeId,
		title: mode.title,
		scope: mode.scope,
		severity: mode.severity,
		decision: mode.decision,
		hypothesis: mode.hypothesis,
		affectedTasks: mode.impact.affectedTasks,
		totalTasks: mode.impact.totalTasks,
		reproductionBps: mode.impact.reproductionBps,
		runCount: runCountByMode.get(mode.failureModeId) ?? 0,
		href: `/evals/${encodeURIComponent(evalRunId)}?mode=${encodeURIComponent(mode.failureModeId)}`,
	}));

	const outcomeFilter = options.query?.outcome ?? null;
	const modeFilter = options.query?.mode ?? null;
	const rows = allRows.filter((row) =>
		(outcomeFilter === null || row.outcome === outcomeFilter) &&
		(modeFilter === null || row.failureModeIds.includes(modeFilter)));

	const base = `/evals/${encodeURIComponent(evalRunId)}`;
	const withOutcome = (outcome: string | null): string => {
		const parts: string[] = [];
		if (outcome) parts.push(`outcome=${encodeURIComponent(outcome)}`);
		if (modeFilter) parts.push(`mode=${encodeURIComponent(modeFilter)}`);
		return parts.length > 0 ? `${base}?${parts.join("&")}` : base;
	};
	const filterLinks = [
		{ label: "all", href: withOutcome(null), active: outcomeFilter === null },
		{ label: "fail", href: withOutcome("fail"), active: outcomeFilter === "fail" },
		{ label: "error", href: withOutcome("error"), active: outcomeFilter === "error" },
		{ label: "pass", href: withOutcome("pass"), active: outcomeFilter === "pass" },
		...(modeFilter ? [{ label: "clear mode filter", href: base, active: false }] : []),
	];

	const notices: string[] = [];
	if (outcomeFilter || modeFilter) {
		notices.push(
			`Showing ${rows.length} of ${allRows.length} run(s)` +
			`${outcomeFilter ? ` with outcome ${outcomeFilter}` : ""}` +
			`${modeFilter ? ` in failure mode ${modeFilter}` : ""}.`,
		);
	}
	const missingPreviews = allRows.filter((row) => row.inputPreview === null).length;
	if (missingPreviews > 0) {
		notices.push(`${missingPreviews} run(s) have no readable trace, so their input preview is blank.`);
	}
	notices.push(
		"Inputs, answers, and traces are bounded, credential-redacted projections. " +
		"Protected canonical artifacts remain unchanged on disk.",
	);

	const meanScore = verified.runs.length === 0
		? 0
		: verified.runs.reduce((total, run) => total + runScore(run), 0) / verified.runs.length;

	return {
		evalRunId,
		targetId: record.target.id,
		revision: record.target.gitSha,
		label: record.label,
		purpose: record.purpose,
		visibility: record.evidenceVisibility ?? "development",
		suiteId: record.suiteId,
		dataset: record.dataset,
		startedAt: record.startedAt,
		model: modelLine(record),
		design: {
			tasks: new Set(verified.runs.map((run) => run.taskId)).size,
			repetitions: record.repetitions,
			runs: verified.runs.length,
		},
		summary: record.summary,
		meanScore,
		costUsd: armCostUsd(verified.runs),
		tokens: verified.runs.reduce((total, run) => total + run.metrics.tokens.total, 0),
		judgeCalibration: judgeCalibrationRows(verified.runs, null, options.labels !== undefined)
			.map((row) => `${row.line} — ${row.graderNames.join(", ")}`),
		briefStatus: brief.status,
		briefHeadline: brief.headline,
		proposalEligible: brief.proposalEligible,
		modes,
		rows,
		filter: { outcome: outcomeFilter, mode: modeFilter },
		filterLinks,
		candidates: candidatesCovering(runsRoot, evalRunId).map((coverage) => ({
			candidateId: coverage.record.candidateId,
			href: `/candidates/${encodeURIComponent(coverage.record.candidateId)}`,
			role: coverage.evaluation.development.candidate.evalRunId === evalRunId ? "candidate" : "baseline",
			verdict: gateVerdictOf(coverage.evaluation.development.comparison) ?? "no recorded verdict",
		})),
		notices,
	};
}

// ---------- Run detail page ----------

export function collectRunDetailPage(runsRoot: string, runId: string): RunDetailPageModel {
	if (!existsSync(resolveContainedArtifactPath(runsRoot, runId, "run.json"))) {
		throw new EvidenceNotFound(`run ${runId} does not exist`);
	}
	const stored = loadRun(runsRoot, runId);
	// A run whose record does not name its eval cannot be proven public, so it is
	// not served at all. Visibility is decided by the eval, never by the run.
	const evalRunId = stored.parent?.evalRunId;
	if (!evalRunId) throw new EvidenceNotFound(`run ${runId} does not name an eval run`);
	const verified = loadPublicEvalRun(runsRoot, evalRunId);
	const run = verified.runs.find((candidate) => candidate.runId === runId);
	if (!run) throw new EvidenceNotFound(`run ${runId} is not a member of ${evalRunId}`);
	const brief = requireDiagnosis(runsRoot, evalRunId);

	const rows = runsTable(runsRoot, verified.runs, brief);
	const position = rows.findIndex((row) => row.runId === runId);
	const neighbour = (offset: number): RunRow | null => rows[position + offset] ?? null;
	const link = (row: RunRow | null) =>
		row === null ? null : { runId: row.runId, taskId: row.taskId, repetitionIndex: row.repetitionIndex };

	const messages = openRunTrace(runsRoot, run);
	const facts = messages ? traceFacts(messages) : null;
	const transcript = messages ? runTranscript(messages) : null;
	const graders = graderFindings(runsRoot, run, { includeJudgeVerdicts: true });
	const modes = brief.modes.filter((mode) => mode.evidence.some((evidence) => evidence.runId === runId));
	// A real candidate experiment answers "did the change help?"; an A/A
	// calibration answers "how noisy is this suite?". Prefer the former when both
	// cover this eval, and say which one it was either way.
	const covering = candidatesCovering(runsRoot, evalRunId);
	const coverage = covering.find((entry) => entry.evaluation.mode === "candidate") ?? covering[0] ?? null;
	const flip = coverage ? flipForTask(runsRoot, coverage, run.taskId) : null;

	const traceNotice = transcript === null
		? "No trace artifact is recorded for this run."
		: `${transcript.entries.length} transcript entr(ies) rendered` +
			`${transcript.truncated ? "; bounded projection clipped longer content" : " within the projection bounds"}` +
			`${transcript.omittedCount > 0 ? `; ${transcript.omittedCount} later trace record(s) omitted` : ""}.` +
			" Credential-shaped text is redacted; the protected artifact on disk is unchanged.";

	return {
		evalRunId,
		targetId: verified.record.target.id,
		revision: verified.record.target.gitSha,
		label: verified.record.label,
		run: {
			runId: run.runId,
			taskId: publicTaskId(run.taskId),
			repetitionIndex: run.repetitionIndex,
			outcome: rows[position]?.outcome ?? "error",
			status: run.status,
			startedAt: run.startedAt,
			finishedAt: run.finishedAt,
			error: rows[position]?.error ?? null,
			metrics: {
				latencyMs: run.metrics.latencyMs,
				toolCalls: run.metrics.toolCalls,
				toolErrors: run.metrics.toolErrors,
				tokens: run.metrics.tokens.total,
				costUsd: run.metrics.costUsd,
			},
		},
		input: facts?.input ?? null,
		transcript,
		traceNotice,
		graders,
		explanation: explainRun({ run, graders, facts, modes, flip }),
		prev: link(neighbour(-1)),
		next: link(neighbour(1)),
	};
}

// ---------- Compare page ----------

function recordedReasons(evidence: EvaluationEvidence["development"]["comparison"]): string[] {
	return evidence && "reasons" in evidence ? [...evidence.reasons] : [];
}

export function collectComparePage(runsRoot: string, candidateId: string): ComparePageModel {
	if (!existsSync(candidateRecordPath(runsRoot, candidateId))) {
		throw new EvidenceNotFound(`candidate ${candidateId} does not exist`);
	}
	const record = loadCandidateRecord(runsRoot, candidateId);
	const evaluation = evaluatedEvidence(record);
	if (!evaluation) throw new EvidenceNotFound(`candidate ${candidateId} has not been evaluated`);
	const baselineId = evaluation.development.baseline.evalRunId;
	const candidateEvalId = evaluation.development.candidate.evalRunId;
	const baseline = loadPublicEvalRun(runsRoot, baselineId);
	const candidate = loadPublicEvalRun(runsRoot, candidateEvalId);
	const comparison: CompareResult = compareVerifiedEvalRuns(baseline, candidate, { mode: "exploratory" });

	const runIdFor = (verified: VerifiedEvalRun, taskId: string): string | null =>
		verified.runs.find((run) => run.taskId === taskId)?.runId ?? null;

	const rows: ComparePageRow[] = comparison.rows.map((row) => ({
		taskId: publicTaskId(row.taskId),
		flip: candidateFlip({
			candidateId,
			mode: evaluation.mode,
			baselineEvalRunId: baselineId,
			candidateEvalRunId: candidateEvalId,
			baselinePass: row.aPass,
			baselineTotal: row.aTotal,
			candidatePass: row.bPass,
			candidateTotal: row.bTotal,
		}),
		baselineScore: row.aScore,
		candidateScore: row.bScore,
		scoreDelta: row.scoreDelta,
		baselineRunId: runIdFor(baseline, row.taskId),
		candidateRunId: runIdFor(candidate, row.taskId),
	}));

	// The sealed arm contributes a verdict and a design size and nothing else:
	// no eval run id, no corpus identity, no task, no trace.
	const sealedEvidence = evaluation.sealedHoldout?.comparison;
	const sealed = sealedEvidence && "design" in sealedEvidence
		? {
			verdict: gateVerdictOf(sealedEvidence) ?? "recorded without a verdict",
			tasks: sealedEvidence.design.tasks,
			repetitions: sealedEvidence.design.repetitions,
			excludedTasks: sealedEvidence.design.excludedTasks,
		}
		: null;

	const notices: string[] = [];
	if (comparison.status !== "comparable") {
		notices.push(`Comparison status: ${comparison.status}. ${comparison.issues.join("; ")}`);
	}

	return {
		candidateId,
		targetId: record.targetId,
		status: record.events.at(-1)?.type ?? "proposed",
		developmentLine: renderGateLine(comparison),
		developmentReasons: recordedReasons(evaluation.development.comparison).length > 0
			? recordedReasons(evaluation.development.comparison)
			: comparison.gate.reasons,
		baseline: {
			evalRunId: baselineId,
			revision: baseline.record.target.gitSha,
			passRate: baseline.record.summary.allPassRate,
		},
		candidate: {
			evalRunId: candidateEvalId,
			revision: candidate.record.target.gitSha,
			passRate: candidate.record.summary.allPassRate,
		},
		resources: {
			costRatio: comparison.resources.costRatio,
			latencyRatio: comparison.resources.latencyRatio,
			tokenRatio: comparison.resources.tokenRatio,
		},
		confidence: comparison.summary.confidence95,
		sealed,
		rows,
		counts: {
			improved: comparison.summary.improved,
			regressed: comparison.summary.regressed,
			unchanged: comparison.summary.unchanged,
		},
		notices,
	};
}
