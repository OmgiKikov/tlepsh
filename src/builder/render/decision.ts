import type { WorkbenchDecisionResult, WorkbenchView } from "../../workbench/types.js";
import { oneLine, pluralize, section, shortHash, shortSha } from "./format.js";
import type { Paint } from "./paint.js";
import { nextStep, stageLabel } from "./stage.js";
import { renderCandidate, renderTraces } from "./view.js";

export interface RenderDecisionOptions {
	/** Capability-scoped live trace URL retained by the host after a run. */
	liveTraceUrl?: string | null;
}

function nextLine(view: WorkbenchView, paint: Paint): string {
	return `${paint.dim("Next")} ${nextStep(view)} ${paint.dim(`(${stageLabel(view.stage)})`)}`;
}

function runLines(result: Extract<WorkbenchDecisionResult, { kind: "run-eval" }>["result"], paint: Paint, options: RenderDecisionOptions): string[] {
	const lines = renderTraces(result, paint);
	if (options.liveTraceUrl) lines.push(`${paint.dim("Live trace")} ${paint.link(options.liveTraceUrl)} ${paint.dim("· retained for 15 minutes")}`);
	return lines;
}

function verificationLines(result: Extract<WorkbenchDecisionResult, { kind: "verify-candidate" }>["result"], paint: Paint, view: WorkbenchView): string[] {
	const lines = renderCandidate(result.candidate, paint, "Candidate verified");
	lines.push(nextLine(view, paint));
	return lines;
}

/** One human summary per consequential decision; never a JSON dump. */
export function renderDecision(result: WorkbenchDecisionResult, paint: Paint, options: RenderDecisionOptions = {}): string[] {
	const view = result.view;
	switch (result.kind) {
		case "scaffold-target":
			return [
				`${section("Target harness created", paint)} ${paint.bold(result.result.targetId)} ${paint.dim(`@ ${shortSha(result.result.targetGitSha)}`)}`,
				`${paint.dim("Receipt")} ${paint.dim(result.result.receiptId)}`,
				nextLine(view, paint),
			];
		case "configure-target": {
			const model = view.target.model;
			return [
				`${section("Target configured", paint)} ${paint.bold(result.result.targetId)} ${paint.dim(`@ ${shortSha(result.result.targetGitSha)}`)}`,
				`${paint.dim("Model")} ${model ? oneLine(`${model.provider}/${model.id}`, 80) : "—"} ${paint.dim("· credential env")} ${paint.bold(oneLine(result.result.credentialEnv, 60))} ${model?.credentialPresent ? paint.success("present") : paint.warning(`missing — export ${oneLine(result.result.credentialEnv, 60)} before running`)}`,
				nextLine(view, paint),
			];
		}
		case "approve-spec":
			return [
				`${section("Spec approved", paint)} ${paint.dim(result.result.approvedSpecId)}`,
				nextLine(view, paint),
			];
		case "publish-corpus":
			return [
				`${section("Development basket published", paint)} ${pluralize(result.result.taskCount, "case")} ${paint.dim(`· ${result.result.corpusId} · ${shortHash(result.result.corpusHash)}`)}`,
				nextLine(view, paint),
			];
		case "run-eval":
			return [...runLines(result.result, paint, options), nextLine(view, paint)];
		case "run-current":
			return result.result.resolvedAs === "run-eval"
				? [...runLines(result.result, paint, options), nextLine(view, paint)]
				: verificationLines(result.result, paint, view);
		case "verify-candidate":
			return verificationLines(result.result, paint, view);
		case "apply-proposal":
			return [
				`${section("Proposal applied", paint)} branch ${paint.bold(result.result.branch)} ${paint.dim(`· candidate ${shortSha(result.result.candidateSha)} · proposal ${shortHash(result.result.proposalHash)}`)}`,
				paint.muted("Your checkout was not switched; the candidate lives on its own branch until you adopt it."),
				nextLine(view, paint),
			];
		case "discard-proposal":
			return [`${section("Proposal discarded", paint)} ${paint.dim(result.result.runId)}`, nextLine(view, paint)];
		case "abandon-candidate":
			return [
				`${section("Interrupted candidate abandoned", paint)} ${paint.dim(`${result.result.candidateId} · stopped at ${result.result.interruptedStatus}`)}`,
				paint.muted("The applied proposal can be verified again with /run."),
				nextLine(view, paint),
			];
		case "review-candidate":
			return [...renderCandidate(result.result, paint, "Review recorded"), nextLine(view, paint)];
		case "promote-candidate":
			return [
				`${section("Candidate promoted", paint)} ${paint.success(result.result.tag)} ${paint.dim(`· ${shortSha(result.result.candidateSha)}`)}`,
				paint.muted("The tag records the exact reviewed revision. The active Target is unchanged until you /adopt."),
				nextLine(view, paint),
			];
		case "reject-candidate":
			return [...renderCandidate(result.result, paint, "Candidate rejected"), nextLine(view, paint)];
		case "adopt-candidate":
			return [
				`${section("Candidate adopted", paint)} branch ${paint.bold(result.result.branch)} ${shortSha(result.result.fromSha)} → ${paint.success(shortSha(result.result.toSha))} ${paint.dim(`· ${result.result.tag}`)}${result.result.disposition !== "adopted" ? paint.dim(` · ${result.result.disposition}`) : ""}`,
				paint.muted("The promoted harness is now the active Target for `ahde target` and the next cycle."),
				nextLine(view, paint),
			];
		case "continue-cycle":
			return [
				`${section("Cycle closed", paint)} active Target ${shortSha(result.result.activeTargetSha)} ${paint.dim(`· ${result.result.candidate.status} candidate ${result.result.candidate.candidateId}`)}`,
				nextLine(view, paint),
			];
	}
}

/** One-line headline for status bars and collapsed tool cards. */
export function decisionHeadline(result: WorkbenchDecisionResult): string {
	switch (result.kind) {
		case "run-eval":
			return `${result.result.evaluation.summary.pass}/${result.result.evaluation.summary.total} passed · ${result.result.improvementBrief.summary.failureModeCount} failure modes`;
		case "run-current":
			return result.result.resolvedAs === "run-eval"
				? `${result.result.evaluation.summary.pass}/${result.result.evaluation.summary.total} passed · ${result.result.improvementBrief.summary.failureModeCount} failure modes`
				: `candidate ${result.result.candidate.status}`;
		case "verify-candidate":
			return `candidate ${result.result.candidate.status} · development ${result.result.development.verdict} · sealed ${result.result.sealedHoldout.verdict ?? "not run"}`;
		default:
			return oneLine(result.message, 120);
	}
}
