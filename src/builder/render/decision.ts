import type {
	WorkbenchCheapCheckProjection,
	WorkbenchDecisionResult,
	WorkbenchImproveResult,
	WorkbenchShipResult,
	WorkbenchStartTestingResult,
	WorkbenchVerifyCandidateResult,
	WorkbenchView,
} from "../../workbench/types.js";
import { formatFlipRate, formatNoiseBand, renderCalibration } from "./calibration.js";
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

/** The screen in one line: what it cost, what it found, what it is not. */
function screenLine(screen: WorkbenchCheapCheckProjection, paint: Paint): string {
	const detail = `${screen.improved} improved · ${screen.unchanged} unchanged · ${screen.regressed} regressed` +
		(screen.inconclusive > 0 ? ` · ${screen.inconclusive} inconclusive` : "");
	return `${paint.dim("Cheap check")} ${screen.verdict === "promising" ? paint.success("promising") : paint.muted("flat")} ` +
		`${paint.dim(`· ${pluralize(screen.tasks, "previously failing case")} × 1 · ${detail}`)}` +
		(screen.withinErrorBudget ? "" : ` ${paint.muted("· over the infrastructure error budget, so inconclusive")}`);
}

function verificationLines(result: WorkbenchVerifyCandidateResult, paint: Paint, view: WorkbenchView): string[] {
	if (result.outcome === "stopped-by-screen") {
		return [
			screenLine(result.screen, paint),
			paint.muted(
				`Nothing was measured: the ${result.spared.executions}-execution verification was not spent. ` +
				"A screen is not a verdict — author another change, or verify anyway with force.",
			),
			nextLine(view, paint),
		];
	}
	const lines: string[] = [];
	if (result.screen) lines.push(screenLine(result.screen, paint));
	lines.push(...renderCandidate(result.candidate, paint, "Candidate verified"));
	lines.push(nextLine(view, paint));
	return lines;
}

function improveLines(result: WorkbenchImproveResult, paint: Paint, view: WorkbenchView): string[] {
	const lines = [
		`${section("Improvement cycles", paint)} ${pluralize(result.cycles.length, "cycle")} ` +
			`${paint.dim(`· ${result.executions} Target executions · ${Math.round(result.finalPassRate * 100)}% pass rate`)}`,
	];
	for (const cycle of result.cycles) {
		const screen = cycle.screen ? `screen ${cycle.screen.verdict} ${cycle.screen.improved}/${cycle.screen.tasks}` : "no screen";
		const verification = cycle.verification
			? `verify ${cycle.verification.verdict} ${cycle.verification.scoreDelta >= 0 ? "+" : ""}${(cycle.verification.scoreDelta * 100).toFixed(1)}pp`
			: "no verification";
		lines.push(paint.dim(
			`  ${cycle.cycle}. ${cycle.pass}/${cycle.total} · ${screen} · ${verification} · ${cycle.note}`,
		));
	}
	lines.push(paint.muted(`Stopped: ${result.stopMessage}.`));
	if (result.candidateId) {
		lines.push(paint.muted("Promotion is yours: say “ship it” to run the sealed guardrail and release."));
	}
	lines.push(nextLine(view, paint));
	return lines;
}

/**
 * One composite reads as the work it did, not as the four decisions it is made
 * of: what was approved and published, then the run itself.
 */
function startTestingLines(
	result: WorkbenchStartTestingResult,
	paint: Paint,
	view: WorkbenchView,
	options: RenderDecisionOptions,
): string[] {
	const lines: string[] = [];
	for (const step of result.steps) {
		if (step.kind === "approve-spec") {
			lines.push(`${section("Spec approved", paint)} ${paint.dim(result.approvedSpecId ?? "")}`);
		}
		if (step.kind === "publish-corpus" && result.developmentCorpus) {
			lines.push(`${section("Tests published", paint)} ${pluralize(result.developmentCorpus.taskCount, "case")} ${paint.dim(`· ${result.developmentCorpus.id}`)}`);
		}
	}
	if (result.evaluation) lines.push(...runLines(result.evaluation, paint, options));
	else if (result.pending) lines.push(paint.muted(`Still needed: ${result.pending}`));
	lines.push(nextLine(view, paint));
	return lines;
}

function shipLines(result: WorkbenchShipResult, paint: Paint, view: WorkbenchView): string[] {
	const lines = [
		`${section("Shipped", paint)} ${result.tag ? paint.success(result.tag) : paint.muted("already tagged")}` +
			(result.adoption
				? ` ${paint.dim("·")} ${paint.bold(result.adoption.branch)} ${shortSha(result.adoption.fromSha)} → ${paint.success(shortSha(result.adoption.toSha))}`
				: ""),
		...renderCandidate(result.candidate, paint, "Candidate"),
	];
	if (result.adoption) {
		lines.push(paint.muted("The promoted harness is now the active Target for `ahde target` and the next cycle."));
	}
	if (result.continuation) {
		lines.push(paint.muted(`Cycle closed · next: ${stageLabel(result.continuation.nextStage)}.`));
	}
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
		case "import-dataset": {
			const lines = [
				`${section("Dataset imported", paint)} ${pluralize(result.result.taskCount, "case")} ${paint.dim(`from ${oneLine(result.result.sourcePath, 60)}`)}`,
				result.result.sealedCount > 0
					? `${paint.dim("Sealed")} ${paint.bold(pluralize(result.result.sealedCount, "case"))} held out ${paint.dim("· the exam; nobody develops against it")}`
					: `${paint.dim("Sealed")} ${paint.warning("nothing held out")} ${paint.dim("· there is no exam for this file")}`,
			];
			if (result.result.skippedRows > 0) {
				lines.push(`${paint.dim("Skipped")} ${pluralize(result.result.skippedRows, "row")} ${paint.dim("did not map to a case")}`);
			}
			lines.push(paint.muted("The cases landed in an editable draft; review them, then publish."), nextLine(view, paint));
			return lines;
		}
		case "run-eval":
			return [...runLines(result.result, paint, options), nextLine(view, paint)];
		case "calibrate": {
			const lines = [
				`${section("Noise calibrated", paint)} ${paint.dim(result.result.candidateId)}`,
				...renderCalibration(result.result.calibration, paint),
			];
			if (options.liveTraceUrl) lines.push(`${paint.dim("Live trace")} ${paint.link(options.liveTraceUrl)} ${paint.dim("· retained for 15 minutes")}`);
			lines.push(nextLine(view, paint));
			return lines;
		}
		case "run-current":
			if (result.result.resolvedAs === "run-eval") return [...runLines(result.result, paint, options), nextLine(view, paint)];
			if (result.result.resolvedAs === "start-testing") return startTestingLines(result.result, paint, view, options);
			return verificationLines(result.result, paint, view);
		case "start-testing":
			return startTestingLines(result.result, paint, view, options);
		case "ship":
			return shipLines(result.result, paint, view);
		case "verify-candidate":
			return verificationLines(result.result, paint, view);
		case "improve":
			return improveLines(result.result, paint, view);
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

function startTestingHeadline(result: WorkbenchStartTestingResult): string {
	if (result.evaluation) {
		return `${result.evaluation.evaluation.summary.pass}/${result.evaluation.evaluation.summary.total} passed · ` +
			`${result.evaluation.improvementBrief.summary.failureModeCount} failure modes`;
	}
	return result.steps.map((step) => step.kind.replace(/-/g, " ")).join(" · ") || "nothing to do";
}

function verifyHeadline(result: WorkbenchVerifyCandidateResult): string {
	if (result.outcome === "stopped-by-screen") {
		return `cheap check flat · ${result.screen.improved}/${result.screen.tasks} improved · verification not spent`;
	}
	return `candidate ${result.candidate.status} · development ${result.development.verdict} · ` +
		`sealed ${result.sealedHoldout.verdict ?? "not run"}`;
}

/** One-line headline for status bars and collapsed tool cards. */
export function decisionHeadline(result: WorkbenchDecisionResult): string {
	switch (result.kind) {
		case "run-eval":
			return `${result.result.evaluation.summary.pass}/${result.result.evaluation.summary.total} passed · ${result.result.improvementBrief.summary.failureModeCount} failure modes`;
		case "run-current":
			if (result.result.resolvedAs === "run-eval") {
				return `${result.result.evaluation.summary.pass}/${result.result.evaluation.summary.total} passed · ${result.result.improvementBrief.summary.failureModeCount} failure modes`;
			}
			if (result.result.resolvedAs === "start-testing") return startTestingHeadline(result.result);
			return result.result.outcome === "stopped-by-screen"
				? "cheap check flat · verification not spent"
				: `candidate ${result.result.candidate.status}`;
		case "start-testing":
			return startTestingHeadline(result.result);
		case "ship":
			return `${result.result.tag ?? "no new tag"}${result.result.adoption ? ` · ${result.result.adoption.branch} fast-forwarded` : ""}` +
				`${result.result.continuation ? ` · next ${result.result.continuation.nextStage}` : ""}`;
		case "verify-candidate":
			return verifyHeadline(result.result);
		case "improve":
			return `${result.result.cycles.length} cycle(s) · ${Math.round(result.result.finalPassRate * 100)}% · stopped: ${result.result.stopReason}`;
		case "calibrate": {
			const calibration = result.result.calibration;
			return `A/A ${calibration.verdict} · ${formatNoiseBand(calibration)} · flip ${formatFlipRate(calibration)} · ` +
				`${calibration.recommendedRepetitions} reps recommended`;
		}
		default:
			return oneLine(result.message, 120);
	}
}
