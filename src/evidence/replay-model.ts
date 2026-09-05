import { lstatSync } from "node:fs";
import { loadCandidateRecord } from "../application/candidate-review.js";
import { publicTaskId } from "../application/improvement-brief.js";
import { exclusionReasonOf, measurementLine, measurementSurface } from "../application/measurement-line.js";
import {
	graderFindings, openRunTrace, runOutcome, runReceipt, runTranscript,
	type GraderFinding, type RunReceipt, type Transcript,
} from "../application/run-explanation.js";
import { compareVerifiedEvalRuns, type CompareResult } from "../compare.js";
import { compareUtf8, type CompareRow, type ExcludedTask } from "../domain/comparison-gate.js";
import type { CandidateRecord } from "../domain/candidate.js";
import type { VerifiedEvalRun } from "../eval.js";
import type { RunRecord } from "../provenance.js";
import { resolveContainedArtifactPath, safeArtifactSegment } from "../storage/paths.js";
import { redactTraceText } from "../trace.js";
import { candidateProposalReview } from "../workbench/resolution.js";
import { EvidenceNotFound, loadPublicEvalRun, orderedComparisonRows } from "./model.js";

/** Only the selected pair opens traces. Navigation is a bounded metadata projection. */
export const MAX_REPLAY_NAV_ITEMS = 100;
const MAX_REPLAY_DIFF_BYTES = 64 * 1024;
const MAX_REPLAY_GRADERS = 64;
const MAX_REPLAY_REASONS = 12;

/** Display identity for one exact matched task/repetition; selection uses the baseline run id. */
export interface ReplaySelection {
	baselineRunId: string;
	candidateRunId: string;
	taskId: string;
	repetitionIndex: number;
	scoreDelta: number;
	exclusion: ExcludedTask["reason"] | null;
}

export interface ReplayRun {
	runId: string;
	evalRunId: string;
	revision: string;
	outcome: "pass" | "fail" | "error";
	status: string;
	error: string | null;
	receipt: RunReceipt;
	graders: GraderFinding[];
	omittedGraders: number;
	transcript: Transcript | null;
}

export interface CandidateReplayPageModel {
	candidateId: string;
	targetId: string;
	status: string;
	/** Whole development comparison, never recalculated from the selected repetition. */
	comparison: {
		status: CompareResult["status"];
		line: string;
		verdict: CompareResult["gate"]["verdict"];
		policyId: string;
		reasons: string[];
		omittedReasons: number;
		summary: CompareResult["summary"];
		design: CompareResult["design"];
		resources: CompareResult["resources"];
	};
	navigation: {
		items: ReplaySelection[];
		total: number;
		omittedCount: number;
		selectedRunId: string;
	};
	selected: {
		taskId: string;
		repetitionIndex: number;
		/** All repetitions of this task, directly from the canonical comparison row. */
		stats: Omit<CompareRow, "taskId">;
		exclusion: ExcludedTask["reason"] | null;
		baseline: ReplayRun;
		candidate: ReplayRun;
	};
	proposal:
		| { available: false; reason: string }
		| { available: true; proposalHash: string; summary: string; paths: string[]; diff: string; redacted: boolean };
	notices: string[];
}

function display(value: string, limit = 2_000): string {
	return redactTraceText(value).slice(0, limit);
}

/** URLs require exact ids. Refuse credential-bearing ids rather than putting them in a link. */
function publicExactId(value: string): string {
	if (value.length > 200 || redactTraceText(value) !== value) throw new EvidenceNotFound("Replay identity is unavailable");
	return safeArtifactSegment(value);
}

interface MatchedReplay {
	row: CompareRow;
	baseline: RunRecord;
	candidate: RunRecord;
	exclusion: ExcludedTask["reason"] | null;
}

function matchedReplays(baseline: VerifiedEvalRun, candidate: VerifiedEvalRun, comparison: CompareResult): MatchedReplay[] {
	const exclusions = new Map(comparison.excluded.map((task) => [task.taskId, task.reason]));
	const key = (run: RunRecord): string => JSON.stringify([run.taskId, run.repetitionIndex]);
	const after = new Map(candidate.runs.map((run) => [key(run), run]));
	const before = new Map(baseline.runs.map((run) => [key(run), run]));
	if (after.size !== candidate.runs.length || before.size !== baseline.runs.length) {
		throw new Error("Replay evidence contains ambiguous task repetitions");
	}
	const byTask = new Map<string, RunRecord[]>();
	for (const run of baseline.runs) byTask.set(run.taskId, [...(byTask.get(run.taskId) ?? []), run]);
	return orderedComparisonRows(comparison)
		.flatMap((row) => (byTask.get(row.taskId) ?? [])
			.sort((a, b) => a.repetitionIndex - b.repetitionIndex || compareUtf8(a.runId, b.runId))
			.flatMap((run): MatchedReplay[] => {
				const match = after.get(key(run));
				return match ? [{ row, baseline: run, candidate: match, exclusion: exclusions.get(row.taskId) ?? null }] : [];
			}));
}

function selection(pair: MatchedReplay): ReplaySelection {
	return {
		baselineRunId: publicExactId(pair.baseline.runId),
		candidateRunId: publicExactId(pair.candidate.runId),
		taskId: publicTaskId(pair.row.taskId),
		repetitionIndex: pair.baseline.repetitionIndex,
		scoreDelta: pair.row.scoreDelta,
		exclusion: pair.exclusion,
	};
}

function replayRun(runsRoot: string, snapshot: VerifiedEvalRun, run: RunRecord): ReplayRun {
	const messages = openRunTrace(runsRoot, run)?.map(({ thinking: _thinking, ...message }) => message);
	const artifacts = snapshot.artifacts.get(run.runId);
	const graders = graderFindings(run);
	return {
		runId: publicExactId(run.runId),
		evalRunId: publicExactId(snapshot.record.evalRunId),
		revision: snapshot.record.target.gitSha,
		outcome: runOutcome(run),
		status: run.status,
		error: run.error === null ? null : display(run.error),
		receipt: runReceipt(run, artifacts),
		graders: graders.slice(0, MAX_REPLAY_GRADERS),
		omittedGraders: Math.max(0, graders.length - MAX_REPLAY_GRADERS),
		transcript: messages ? runTranscript(messages) : null,
	};
}

function proposalDiff(runsRoot: string, record: CandidateRecord): CandidateReplayPageModel["proposal"] {
	try {
		if (record.origin.kind === "applied-builder") {
			// The reused exact reviewer hashes its source bytes. Bound those reads
			// before invoking it; only canonical paths below this evidence root.
			for (const file of ["builder_run.json", "proposal.json"]) {
				const path = resolveContainedArtifactPath(runsRoot, "builders", record.origin.builderRunId, file);
				if (lstatSync(path).size > 16 * 1024 * 1024) throw new Error("Proposal source exceeds replay verification bounds");
			}
		}
		const proposal = candidateProposalReview(runsRoot, record);
		if (!proposal) return { available: false, reason: "No attested Builder proposal is recorded for this candidate." };
		const built = record.events.find((event) => event.type === "built");
		if (record.origin.kind !== "applied-builder" || proposal.baseTargetSha !== record.baseline.sha ||
			record.origin.application.baseTargetSha !== record.baseline.sha || built?.type !== "built" ||
			record.origin.application.candidateSha !== built.candidate.sha) {
			throw new Error("Proposal application does not belong to the replayed revisions");
		}
		if (Buffer.byteLength(proposal.exactDiff, "utf8") > MAX_REPLAY_DIFF_BYTES || proposal.paths.length > 100) {
			return { available: false, reason: "The exact proposal exceeds this replay's display limit; inspect the proposal in Builder." };
		}
		const diff = redactTraceText(proposal.exactDiff);
		if (Buffer.byteLength(diff, "utf8") > MAX_REPLAY_DIFF_BYTES) {
			return { available: false, reason: "The redacted proposal exceeds this replay's display limit; inspect the proposal in Builder." };
		}
		return {
			available: true,
			proposalHash: proposal.proposalHash,
			summary: display(proposal.summary),
			paths: proposal.paths.map((path) => display(path, 500)),
			diff,
			redacted: diff !== proposal.exactDiff,
		};
	} catch {
		// Existing evidence stays useful, but changed/unattested bytes are never a diff.
		return { available: false, reason: "The recorded proposal could not be verified; no diff is shown." };
	}
}

/**
 * A view of two recorded development runs. No execution, diagnosis, grading,
 * persisted playback state, or interpretation of intermediate world state.
 */
export function collectCandidateReplayPage(
	runsRoot: string,
	candidateId: string,
	options: { runId?: string } = {},
): CandidateReplayPageModel {
	publicExactId(candidateId);
	if (options.runId !== undefined) publicExactId(options.runId);
	const record = loadCandidateRecord(runsRoot, candidateId);
	const evaluated = record.events.findLast((event) => event.type === "evaluated");
	const built = record.events.find((event) => event.type === "built");
	if (evaluated?.type !== "evaluated" || built?.type !== "built") throw new EvidenceNotFound("Candidate has no recorded comparison to replay");
	const pair = evaluated.evaluation.development;
	if (pair.baseline.evalRunId === pair.candidate.evalRunId) throw new Error("Replay requires two distinct evaluation arms");
	const baseline = loadPublicEvalRun(runsRoot, pair.baseline.evalRunId);
	const candidate = loadPublicEvalRun(runsRoot, pair.candidate.evalRunId);
	if (baseline.record.target.id !== record.targetId || candidate.record.target.id !== record.targetId ||
		baseline.record.target.gitSha !== pair.baseline.harness.sha || baseline.record.target.gitSha !== record.baseline.sha ||
		candidate.record.target.gitSha !== pair.candidate.harness.sha || candidate.record.target.gitSha !== built.candidate.sha) {
		throw new Error("Replay evaluation arms do not match the Candidate's recorded revisions");
	}
	const comparison = compareVerifiedEvalRuns(baseline, candidate, { mode: record.mode, surface: "development" });
	if (comparison.status === "invalid") throw new Error("Replay comparison failed identity or comparability checks");
	const pairs = matchedReplays(baseline, candidate, comparison);
	const selected = options.runId === undefined ? pairs[0] : pairs.find((pair) => pair.baseline.runId === options.runId);
	if (!selected) throw new EvidenceNotFound("No matched baseline repetition is available for this replay selection");
	const selectedIndex = pairs.indexOf(selected);
	const shown = pairs.slice(0, MAX_REPLAY_NAV_ITEMS);
	if (selectedIndex >= MAX_REPLAY_NAV_ITEMS) shown[shown.length - 1] = selected;
	const { taskId, ...stats } = selected.row;
	const before = replayRun(runsRoot, baseline, selected.baseline);
	const after = replayRun(runsRoot, candidate, selected.candidate);
	const reasons = [...comparison.gate.reasons, ...comparison.issues];
	const notices = ["Recorded interactions, not a rerun. Playback does not establish which change caused an outcome.",
		"The final recorded checks describe the outcome; intermediate world changes were not recorded."];
	if (comparison.status === "inconclusive") notices.push("The whole comparison remains inconclusive; this selected repetition does not override it.");
	if (!before.transcript || !after.transcript) notices.push("One or both traces are unavailable or failed trace integrity checks. No steps are reconstructed.");
	if (before.transcript?.truncated || after.transcript?.truncated) notices.push("The recorded transcript exceeds display bounds; some content is omitted.");
	return {
		candidateId,
		targetId: publicTaskId(record.targetId),
		status: record.events.at(-1)?.type ?? "proposed",
		comparison: {
			status: comparison.status,
			line: measurementLine({ development: measurementSurface({
				...comparison.summary, verdict: comparison.gate.verdict,
				tasks: comparison.design.tasks, repetitions: comparison.design.repetitions,
				excludedTasks: comparison.design.excludedTasks, excludedReason: exclusionReasonOf(comparison.excluded),
			}) }).text,
			verdict: comparison.gate.verdict,
			policyId: comparison.gate.policyId,
			reasons: reasons.slice(0, MAX_REPLAY_REASONS).map((reason) => display(reason)),
			omittedReasons: Math.max(0, reasons.length - MAX_REPLAY_REASONS),
			summary: comparison.summary,
			design: comparison.design,
			resources: comparison.resources,
		},
		navigation: { items: shown.map(selection), total: pairs.length, omittedCount: pairs.length - shown.length, selectedRunId: publicExactId(selected.baseline.runId) },
		selected: { taskId: publicTaskId(taskId), repetitionIndex: selected.baseline.repetitionIndex, stats, exclusion: selected.exclusion, baseline: before, candidate: after },
		proposal: proposalDiff(runsRoot, record),
		notices,
	};
}
