import { compileAgentLog } from "../application/agent-log.js";
import { SEALED_GATE_POLICY } from "../domain/comparison-gate.js";
import { t } from "../i18n.js";
import type { WorkbenchDecisionResult, WorkbenchStartTestingResult, WorkbenchVerifyCandidateResult } from "../workbench/types.js";
import type { AhdeWorkbench } from "../workbench/workbench.js";
import { compileBuilderPassport } from "./passport-presentation.js";
import { renderAgentLogChart } from "./render/agent-log.js";
import { decisionHeadline, renderDecision, type RenderDecisionOptions } from "./render/decision.js";
import { collectEvalPage } from "../evidence/model.js";
import type { EvalPageModel } from "../evidence/pages.js";
import { oneLine } from "./render/format.js";
import { handoffLines } from "./render/handoff.js";
import { renderVersionPassport } from "./render/passport.js";
import { renderReceipt } from "./render/receipt.js";
import { renderExecutiveVersionCard } from "./render/version-card.js";
import type { BuilderSpendReader } from "./spend.js";
import { markerPaint, type TranscriptTone } from "./transcript.js";

function startTestingTitle(result: WorkbenchStartTestingResult): { title: string; tone: TranscriptTone } {
	if (!result.evaluation) return { title: t("panel.ready-next"), tone: "info" };
	return { title: t("panel.run-complete"), tone: result.evaluation.evaluation.summary.error > 0 ? "warning" : "success" };
}

function verifyTitle(result: WorkbenchVerifyCandidateResult): { title: string; tone: TranscriptTone } {
	if (result.outcome === "stopped-by-screen") return { title: t("panel.cheap-check-nothing"), tone: "info" };
	if (!result.sealedHoldout.executed) {
		return { title: t("panel.candidate-checked"), tone: result.development.verdict === "regressed" ? "warning" : "success" };
	}
	return { title: t("panel.candidate-verified"), tone: "success" };
}

function decisionTitle(result: WorkbenchDecisionResult): { title: string; tone: TranscriptTone } {
	switch (result.kind) {
		case "run-eval": return { title: t("panel.run-complete"), tone: result.result.evaluation.summary.error > 0 ? "warning" : "success" };
		case "run-current":
			if (result.result.resolvedAs === "run-eval") {
				return { title: t("panel.run-complete"), tone: result.result.evaluation.summary.error > 0 ? "warning" : "success" };
			}
			if (result.result.resolvedAs === "start-testing") return startTestingTitle(result.result);
			return verifyTitle(result.result);
		case "start-testing": return startTestingTitle(result.result);
		case "ship": return { title: t("panel.shipped"), tone: "success" };
		case "verify-candidate": return verifyTitle(result.result);
		case "improve":
			return {
				title: t("panel.improvement-complete"),
				tone: result.result.candidateId ? "success" : "info",
			};
		case "calibrate":
			return {
				title: t("panel.noise-calibrated"),
				tone: result.result.calibration.verdict === "inconclusive" ? "success" : "warning",
			};
		// A re-score that moved nothing is a real answer, not a failure: the
		// rubric the operator rewrote turned out to say the same thing.
		case "regrade":
			return {
				title: t("panel.regraded"),
				tone: result.result.nowPassing + result.result.nowFailing > 0 ? "success" : "info",
			};
		// The critic's reading of the cases: invalid cases are a warning about the
		// test, never a failure of the agent.
		case "critique-corpus":
			return { title: t("panel.critic"), tone: result.result.counts.invalid > 0 ? "warning" : "success" };
		case "scaffold-target": return { title: t("panel.target-created"), tone: "success" };
		case "wrap-target": return { title: t("panel.agent-wrapped"), tone: "success" };
		case "configure-target": return { title: t("panel.target-configured"), tone: "success" };
		case "configure-evaluators":
			return {
				title: t("panel.evaluators-configured"),
				// A configured judge whose key is not exported fails at the first
				// graded case, so the line is a warning until the shell has it.
				tone: "success",
			};
		case "approve-spec": return { title: t("panel.spec-approved"), tone: "success" };
		case "publish-corpus": return { title: t("panel.basket-published"), tone: "success" };
		case "import-dataset": return { title: t("panel.dataset-imported"), tone: "success" };
		case "generate-holdout":
			return {
				// A draft is not an exam yet: somebody still has to read it.
				title: t(result.result.reviewPath ? "panel.holdout-drafted" : "panel.holdout-generated"),
				tone: result.result.reviewPath || result.result.cases < SEALED_GATE_POLICY.minTasks ? "warning" : "success",
			};
		case "apply-proposal":
			return { title: t(result.result.firstBuild ? "panel.agent-built" : "panel.proposal-applied"), tone: "success" };
		case "discard-proposal": return { title: t("panel.proposal-discarded"), tone: "info" };
		case "abandon-candidate": return { title: t("panel.attempt-abandoned"), tone: "info" };
		case "review-candidate": return { title: t("panel.review-recorded"), tone: "info" };
		case "promote-candidate": return { title: t("panel.candidate-promoted"), tone: "success" };
		case "reject-candidate": return { title: t("panel.candidate-rejected"), tone: "warning" };
		case "adopt-candidate": return { title: t("panel.candidate-adopted"), tone: "success" };
		case "continue-cycle": return { title: t("panel.next-cycle"), tone: "success" };
	}
}

/** The evaluation a decision just produced, if it produced one. */
function decisionEvalRunId(result: WorkbenchDecisionResult): string | null {
	switch (result.kind) {
		case "run-eval": return result.result.evaluation.evalRunId;
		case "run-current": return result.result.resolvedAs === "run-eval"
			? result.result.evaluation.evalRunId
			: result.result.resolvedAs === "start-testing" ? result.result.evaluation?.evaluation.evalRunId ?? null : null;
		case "start-testing": return result.result.evaluation?.evaluation.evalRunId ?? null;
		default: return null;
	}
}

/**
 * The case table a run result carries. Read through the Explorer's own page
 * model so the panel and the browser agree cell for cell; unreadable rows
 * leave the table off, never the result.
 */
function decisionRuns(result: WorkbenchDecisionResult, runsRoot: string, evalPage: (runsRoot: string, evalRunId: string) => EvalPageModel): RenderDecisionOptions["runs"] {
	const evalRunId = decisionEvalRunId(result);
	if (!evalRunId) return null;
	try {
		const page = evalPage(runsRoot, evalRunId);
		return { rows: page.rows, modes: page.modes };
	} catch {
		return null;
	}
}

/** One human result for both conversational decisions and shortcuts. */
export async function builderDecisionPresentation(result: WorkbenchDecisionResult, options: {
	workbench: Pick<AhdeWorkbench, "runsRoot" | "stateRoot" | "projectId" | "projectDir" | "view">;
	source: string;
	liveTraceUrl?: string | null;
	spend?: BuilderSpendReader | null;
	/** Explorer page loader; a test injects page models here. */
	evalPage?: (runsRoot: string, evalRunId: string) => EvalPageModel;
}) {
	const { liveTraceUrl, source: command, workbench, spend: spendReader } = options;
	// Presentation is downstream of the durable decision: a rendering fault
	// degrades to the Workbench message instead of masking a completed step.
	let title = `/${command} completed`;
	let tone: TranscriptTone = "success";
	let lines: string[];
	let headline: string;
	try {
		({ title, tone } = decisionTitle(result));
		const runs = decisionRuns(result, workbench.runsRoot, options.evalPage ?? collectEvalPage);
		lines = renderDecision(result, markerPaint, { liveTraceUrl, runs });
		if (result.kind === "ship") {
			try {
				const { passport, card, reportWritten } = await compileBuilderPassport(workbench, { view: result.view, save: true });
				lines.push(
					"",
					...renderExecutiveVersionCard(card, markerPaint),
					reportWritten ? t("release.html.saved", { path: markerPaint.link(reportWritten) }) : markerPaint.warning(t("release.html.not-saved")),
					"",
					...renderVersionPassport(passport, markerPaint),
				);
			} catch (error) {
				lines.push("", markerPaint.warning(t("result.passport-unavailable", { reason: oneLine(error instanceof Error ? error.message : String(error), 180) })));
			}
			try {
				lines.push("", ...renderAgentLogChart(compileAgentLog({
					runsRoot: workbench.runsRoot,
					projectId: workbench.projectId,
					...(result.view.target.id ? { targetId: result.view.target.id } : {}),
				}), markerPaint));
			} catch {
				// The growth line is a second look at the same evidence.
			}
		}
		// The same hand-off the conversational path ends with: a shortcut is not
		// a reason to be told less.
		lines.push(...handoffLines(result, markerPaint));
		headline = decisionHeadline(result);
	} catch {
		lines = [oneLine(result.message, 600), ...(liveTraceUrl ? [t("card.live-trace-retained", { url: markerPaint.link(liveTraceUrl) })] : [])];
		headline = oneLine(result.message, 200);
	}
	// What it cost, from the records the measurement wrote. A decision that
	// spent nothing, or whose records cannot be read, simply has no receipt.
	const receipt = spendReader ? renderReceipt(result, markerPaint, spendReader) : null;
	if (receipt) lines.push(receipt);
	return { block: { title, tone, lines }, headline };
}
