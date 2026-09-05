import { basename, dirname } from "node:path";
import {
	graderFindings,
	runOutcome,
	runTranscript,
	type GraderFinding,
	type RunOutcome,
	type TranscriptEntry,
} from "../application/run-explanation.js";
import type { VerifiedEvalRun } from "../eval.js";
import type { RunRecord } from "../provenance.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";
import { openTrace } from "../trace.js";

export const RUN_INSPECTION_LIMITS = { entries: 96, textChars: 24_000, checks: 32 } as const;

/** Observable dialogue only: hidden reasoning is never part of this tool. */
export type InspectedTranscriptEntry = Exclude<TranscriptEntry, { kind: "assistant" }>
	| Omit<Extract<TranscriptEntry, { kind: "assistant" }>, "thinking">;

export interface WorkbenchRunInspection {
	evalRunId: string;
	runId: string;
	taskId: string;
	repetitionIndex: number;
	target: { id: string; gitSha: string };
	status: RunRecord["status"];
	outcome: RunOutcome;
	transcript: { entries: InspectedTranscriptEntry[]; truncated: boolean; omittedCount: number } | null;
	checks: Array<Pick<GraderFinding, "name" | "type" | "checkCode" | "checkSubject" | "passed" | "score" | "reason" | "abstained">>;
	limitations: {
		recordedDataOnly: true;
		reasoningOmitted: true;
		traceAvailable: boolean;
		omittedChecks: number;
		checkTextClipped: boolean;
		limits: typeof RUN_INSPECTION_LIMITS;
	};
}

function inspectTranscript(runsRoot: string, run: RunRecord): WorkbenchRunInspection["transcript"] {
	if (!run.trace.sha256) return null;
	const path = resolveContainedArtifactPath(runsRoot, run.runId, run.trace.path);
	// Unlike the optional web preview, an explicit exact read must refuse a
	// missing or altered pinned trace, rather than silently describe no trace.
	const messages = openTrace(dirname(path), basename(path), run.trace.sha256);
	const canonical = runTranscript(messages.map(({ thinking: _reasoning, ...message }) => message));
	let remaining = RUN_INSPECTION_LIMITS.textChars as number;
	let clipped = canonical.truncated;
	const text = (value: string, maximum: number): string => {
		const limit = Math.max(0, Math.min(maximum, remaining));
		const result = value.slice(0, limit);
		remaining -= result.length;
		clipped ||= result.length < value.length;
		return result;
	};
	const entries: InspectedTranscriptEntry[] = [];
	for (const entry of canonical.entries) {
		if (entries.length >= RUN_INSPECTION_LIMITS.entries || remaining === 0) break;
		if (entry.kind === "tool") {
			entries.push({ ...entry, name: text(entry.name, 200), args: text(entry.args, 2_000), result: entry.result === null ? null : text(entry.result, 4_000) });
		} else if (entry.kind === "assistant") {
			const { thinking: _reasoning, ...observable } = entry;
			entries.push({ ...observable, text: text(entry.text, 4_000) });
		} else {
			entries.push({ ...entry, text: text(entry.text, 4_000) });
		}
	}
	const omittedCount = canonical.omittedCount + canonical.entries.length - entries.length;
	return { entries, truncated: clipped || omittedCount > 0, omittedCount };
}

interface InspectionOptions {
	runsRoot: string;
	evaluation: VerifiedEvalRun;
	targetId: string;
	runId: string;
}

/** The caller supplies only the Workbench's selected, verified development eval. */
export function inspectSelectedDevelopmentRun(options: InspectionOptions): WorkbenchRunInspection {
	return inspectVerifiedRun(options, "evidence");
}

/** The caller has verified exact experiment/arm membership through loadModelExperimentEval. */
export function inspectModelExperimentRun(options: InspectionOptions): WorkbenchRunInspection {
	return inspectVerifiedRun(options, "model-experiment");
}

function inspectVerifiedRun(options: InspectionOptions, purpose: "evidence" | "model-experiment"): WorkbenchRunInspection {
	const { evaluation, runId } = options;
	if (evaluation.record.evidenceVisibility !== "development" || evaluation.record.purpose !== purpose ||
		evaluation.record.target.id !== options.targetId || !evaluation.hasRunHashes) {
		throw new Error("Exact run inspection requires a hash-pinned development evaluation of the current Target");
	}
	const run = evaluation.runs.find((record) => record.runId === runId);
	if (!run) throw new Error("The requested run does not belong to the selected development evaluation");
	const findings = graderFindings(run);
	let checkTextClipped = false;
	const checks = findings.slice(0, RUN_INSPECTION_LIMITS.checks).map((finding) => {
		const { name, type, checkCode, checkSubject, passed, score, abstained } = finding;
		checkTextClipped ||= finding.reason.length > 512;
		return { name, type, checkCode, checkSubject, passed, score, abstained, reason: finding.reason.slice(0, 512) };
	});
	const transcript = inspectTranscript(options.runsRoot, run);
	return {
		evalRunId: evaluation.record.evalRunId, runId, taskId: run.taskId,
		repetitionIndex: run.repetitionIndex, target: { id: run.target.id, gitSha: run.target.gitSha },
		status: run.status, outcome: runOutcome(run), transcript, checks,
		limitations: { recordedDataOnly: true, reasoningOmitted: true, traceAvailable: transcript !== null,
			omittedChecks: Math.max(0, findings.length - checks.length), checkTextClipped, limits: RUN_INSPECTION_LIMITS },
	};
}
