import type {
	WorkbenchCheapCheckProjection,
	WorkbenchDecisionResult,
	WorkbenchImproveResult,
	WorkbenchShipResult,
	WorkbenchStartTestingResult,
	WorkbenchVerifyCandidateResult,
	WorkbenchView,
} from "../../workbench/types.js";
import { SEALED_GATE_POLICY } from "../../domain/comparison-gate.js";
import { candidateStatusLabel, plural, t, verdictLabel } from "../../i18n.js";
import { formatFlipRate, formatNoiseBand, renderCalibration } from "./calibration.js";
import { regradeHeadline, renderRegrade } from "./regrade.js";
import { oneLine, section, shortHash, shortSha, wrap } from "./format.js";
import { blockedReasonText } from "../../workbench/errors.js";
import type { Paint } from "./paint.js";
import { nextStep, stageLabel } from "./stage.js";
import { renderCandidate, renderTraces } from "./view.js";

export interface RenderDecisionOptions {
	/** Capability-scoped live trace URL retained by the host after a run. */
	liveTraceUrl?: string | null;
}

function nextLine(view: WorkbenchView, paint: Paint): string {
	return `${paint.dim(t("label.next"))} ${nextStep(view)} ${paint.dim(`(${stageLabel(view.stage)})`)}`;
}

function runLines(result: Extract<WorkbenchDecisionResult, { kind: "run-eval" }>["result"], paint: Paint, options: RenderDecisionOptions): string[] {
	// One `Next` per screen: `renderDecision` closes with the stage's own.
	const lines = renderTraces(result, paint, { next: false });
	if (options.liveTraceUrl) lines.push(`${paint.dim(t("label.live-trace"))} ${paint.link(options.liveTraceUrl)} ${paint.dim(t("result.retained"))}`);
	return lines;
}

/**
 * The screen in one line: what it cost, what it found, what it is not.
 *
 * “Inconclusive” is said once. The line used to carry both `3 неубедительно`
 * and `превышен бюджет инфраструктурных ошибок, поэтому неубедительно`, which
 * is the same verdict twice with the count and the reason split across it. When
 * there is a count, the reason joins it; when there is none, the reason carries
 * the word alone.
 */
function screenLine(screen: WorkbenchCheapCheckProjection, paint: Paint): string {
	const overBudget = !screen.withinErrorBudget;
	const detail = t("result.screen-detail", { improved: screen.improved, unchanged: screen.unchanged, regressed: screen.regressed }) +
		(screen.inconclusive > 0
			? ` ${t(overBudget ? "result.screen-inconclusive-over-budget" : "result.screen-inconclusive", { count: screen.inconclusive })}`
			: "");
	return `${paint.dim(t("label.cheap-check"))} ${screen.verdict === "promising" ? paint.success(verdictLabel("promising")) : paint.muted(verdictLabel("flat"))} ` +
		`${paint.dim(t("result.screen-shape", { cases: plural(screen.tasks, "previously failing case"), detail }))}` +
		(overBudget && screen.inconclusive === 0 ? ` ${paint.muted(t("result.screen-over-budget"))}` : "");
}

function verificationLines(result: WorkbenchVerifyCandidateResult, paint: Paint, view: WorkbenchView): string[] {
	if (result.outcome === "stopped-by-screen") {
		return [
			screenLine(result.screen, paint),
			paint.muted(t("result.nothing-measured", { executions: result.spared.executions })),
			nextLine(view, paint),
		];
	}
	const lines: string[] = [];
	if (result.screen) lines.push(screenLine(result.screen, paint));
	lines.push(...renderCandidate(result.candidate, paint, t("candidate.verified")));
	lines.push(nextLine(view, paint));
	return lines;
}

function improveLines(result: WorkbenchImproveResult, paint: Paint, view: WorkbenchView): string[] {
	const lines = [
		`${section(t("result.improvement-cycles"), paint)} ${plural(result.cycles.length, "cycle")} ` +
			`${paint.dim(t("result.pass-rate", { executions: plural(result.executions, "execution"), rate: Math.round(result.finalPassRate * 100) }))}`,
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
	lines.push(paint.muted(t("result.stopped", { reason: result.stopMessage })));
	if (result.candidateId) {
		lines.push(paint.muted(t("result.promotion-yours")));
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
			lines.push(`${section(t("result.spec-approved"), paint)} ${paint.dim(result.approvedSpecId ?? "")}`);
		}
		// The judge the operator approved inside this same dialog, named with the
		// variable its key came from: what was configured, not that something was.
		const configured = view.target.evaluators?.judge;
		if (step.kind === "configure-evaluators" && configured) {
			const judge = configured;
			lines.push(`${section(t("result.evaluators-configured"), paint)} ${paint.dim(t("label.judge"))} ` +
				`${oneLine(`${judge.provider}/${judge.id}`, 60)} ${paint.dim(`· ${judge.apiKeyEnv}`)}`);
		}
		if (step.kind === "publish-corpus" && result.developmentCorpus) {
			lines.push(`${section(t("result.tests-published"), paint)} ${plural(result.developmentCorpus.taskCount, "case")} ${paint.dim(`· ${result.developmentCorpus.id}`)}`);
		}
	}
	if (result.evaluation) lines.push(...runLines(result.evaluation, paint, options));
	else if (result.pending) lines.push(paint.muted(t("result.still-needed", { pending: result.pending })));
	lines.push(nextLine(view, paint));
	return lines;
}

function shipLines(result: WorkbenchShipResult, paint: Paint, view: WorkbenchView): string[] {
	const lines = [
		`${section(t("result.shipped"), paint)} ${result.tag ? paint.success(result.tag) : paint.muted(t("result.already-tagged"))}` +
			(result.adoption
				? ` ${paint.dim("·")} ${paint.bold(result.adoption.branch)} ${shortSha(result.adoption.fromSha)} → ${paint.success(shortSha(result.adoption.toSha))}`
				: ""),
		...renderCandidate(result.candidate, paint, t("candidate.title")),
	];
	if (result.adoption) {
		lines.push(paint.muted(t("result.active-target")));
	}
	if (result.continuation) {
		lines.push(paint.muted(t("result.next-cycle", { stage: stageLabel(result.continuation.nextStage) })));
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
				`${section(t("result.target-created"), paint)} ${paint.bold(result.result.targetId)} ${paint.dim(`@ ${shortSha(result.result.targetGitSha)}`)}`,
				`${paint.dim(t("label.receipt"))} ${paint.dim(result.result.receiptId)}`,
				nextLine(view, paint),
			];
		case "wrap-target":
			return [
				`${section(t("result.target-wrapped"), paint)} ${paint.bold(result.result.targetId)} ${paint.dim(`@ ${shortSha(result.result.targetGitSha)}`)}`,
				`${paint.dim(t("result.agent-entry"))} ${oneLine(result.result.entry, 80)}`,
				`${paint.dim(t("label.receipt"))} ${paint.dim(result.result.receiptId)}`,
				nextLine(view, paint),
			];
		case "configure-target": {
			const model = view.target.model;
			return [
				`${section(t("result.target-configured"), paint)} ${paint.bold(result.result.targetId)} ${paint.dim(`@ ${shortSha(result.result.targetGitSha)}`)}`,
				`${paint.dim(t("label.model"))} ${model ? oneLine(`${model.provider}/${model.id}`, 80) : "—"} ${paint.dim(`· ${t("label.credential-env")}`)} ${paint.bold(oneLine(result.result.credentialEnv, 60))} ${model?.credentialPresent ? paint.success(t("result.credential-present")) : paint.warning(t("result.credential-missing", { env: oneLine(result.result.credentialEnv, 60) }))}`,
				nextLine(view, paint),
			];
		}
		case "configure-evaluators": {
			const lines = [
				`${section(t("result.evaluators-configured"), paint)} ${paint.dim(`@ ${shortSha(result.result.targetGitSha)}`)}`,
			];
			for (const entry of result.result.configured) {
				const present = Boolean(process.env[entry.credentialEnv]?.trim());
				lines.push(
					`${paint.dim(entry.role === "judge" ? t("label.judge-instrument") : t("result.simulated-user"))} ${oneLine(entry.model, 60)} ` +
						`${paint.dim(`· ${t("label.credential-env")}`)} ${paint.bold(oneLine(entry.credentialEnv, 60))} ` +
						`${present ? paint.success(t("result.credential-present")) : paint.warning(t("result.credential-missing", { env: oneLine(entry.credentialEnv, 60) }))}`,
				);
			}
			lines.push(nextLine(view, paint));
			return lines;
		}
		case "approve-spec":
			return [
				`${section(t("result.spec-approved"), paint)} ${paint.dim(result.result.approvedSpecId)}`,
				nextLine(view, paint),
			];
		case "publish-corpus":
			return [
				`${section(t("result.basket-published"), paint)} ${plural(result.result.taskCount, "case")} ${paint.dim(`· ${result.result.corpusId} · ${shortHash(result.result.corpusHash)}`)}`,
				nextLine(view, paint),
			];
		/**
		 * A count, a model, and — on the draft path — a path to open. The corpus
		 * id is deliberately absent even though the result carries it: an id here
		 * is one more thing to copy out of a terminal, and nothing an operator
		 * does with this exam needs it.
		 */
		case "generate-holdout": {
			const cases = result.result.cases;
			const lines = [
				`${section(t(result.result.reviewPath ? "panel.holdout-drafted" : "panel.holdout-generated"), paint)} ${
					// An exam written from the agent's own documents is a different
					// claim from one written from its description; the one line says
					// which, because the operator paid for one of the two.
					paint.bold(t(result.result.source === "kb" ? "generate-holdout.by-judge-kb" : "generate-holdout.by-judge", {
						cases: plural(cases, "case"),
						generator: oneLine(result.result.generator, 60),
					}))
				}`,
			];
			// An exam that came back short says so on the panel, with what was
			// dropped and why: "20 cases" for 19 delivered is the lie this fixes.
			if (cases < result.result.requested) {
				const dropped = result.result.dropped;
				lines.push(`${paint.dim(t("label.exam"))} ${paint.warning(t("exam.of-requested", {
					cases,
					requested: result.result.requested,
				}))}${
					dropped.duplicate > 0
						? ` ${paint.dim("·")} ${paint.dim(t("exam.dropped-duplicate", { count: dropped.duplicate, dropped: plural(dropped.duplicate, "duplicate") }))}`
						: ""
				}${
					dropped.malformed > 0
						? ` ${paint.dim("·")} ${paint.dim(t("exam.dropped-malformed", { count: dropped.malformed, dropped: plural(dropped.malformed, "malformed case") }))}`
						: ""
				}`);
			}
			if (result.result.reviewPath) {
				lines.push(
					// The one line here that has to survive being copied out of a
					// terminal, so it gets the wider bound blockers get.
					`${paint.dim(t("label.draft"))} ${oneLine(result.result.reviewPath, 200)}`,
					paint.muted(t("generate-holdout.draft-next")),
				);
			} else {
				lines.push(paint.muted(t("generate-holdout.sealed-note")));
			}
			if (cases < SEALED_GATE_POLICY.minTasks) {
				lines.push(paint.warning(t("generate-holdout.underpowered", {
					cases: plural(cases, "case"),
					minimum: SEALED_GATE_POLICY.minTasks,
					missing: SEALED_GATE_POLICY.minTasks - cases,
				})));
			}
			lines.push(nextLine(view, paint));
			return lines;
		}
		case "import-dataset": {
			const lines = [
				`${section(t("result.dataset-imported"), paint)} ${plural(result.result.taskCount, "case")} ${paint.dim(`from ${oneLine(result.result.sourcePath, 60)}`)}`,
				result.result.sealedCount > 0
					? `${paint.dim(t("label.sealed"))} ${paint.bold(plural(result.result.sealedCount, "case"))} ${t("result.sealed-held-out")} ${paint.dim(t("result.sealed-exam"))}`
					: `${paint.dim(t("label.sealed"))} ${paint.warning(t("result.sealed-none"))} ${paint.dim(t("result.sealed-no-exam"))}`,
			];
			if (result.result.skippedRows > 0) {
				lines.push(`${paint.dim(t("label.skipped"))} ${plural(result.result.skippedRows, "row")} ${paint.dim(t("result.skipped-rows"))}`);
			}
			lines.push(paint.muted(t("result.draft-landed")), nextLine(view, paint));
			return lines;
		}
		case "run-eval":
			return [...runLines(result.result, paint, options), nextLine(view, paint)];
		case "calibrate": {
			const lines = [
				`${section(t("result.noise-calibrated"), paint)} ${paint.dim(result.result.candidateId)}`,
				...renderCalibration(result.result.calibration, paint),
			];
			if (options.liveTraceUrl) lines.push(`${paint.dim(t("label.live-trace"))} ${paint.link(options.liveTraceUrl)} ${paint.dim(t("result.retained"))}`);
			lines.push(nextLine(view, paint));
			return lines;
		}
		case "regrade":
			return [...renderRegrade(result.result, paint), nextLine(view, paint)];
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
		case "apply-proposal": {
			const lines = [
				`${section(t("result.proposal-applied"), paint)} ${t("result.branch")} ${paint.bold(result.result.branch)} ${paint.dim(`· ${t("result.candidate-word")} ${shortSha(result.result.candidateSha)} · ${t("result.proposal-word")} ${shortHash(result.result.proposalHash)}`)}`,
				paint.muted(t("result.checkout-unchanged")),
			];
			// A tool arrived with an executable contract nobody has measured yet.
			// The draft is named here, once, with the one thing to do about it.
			for (const drafted of result.result.contractCases ?? []) {
				lines.push(paint.muted(t("result.contract-cases", {
					count: drafted.cases,
					tool: drafted.tool,
				})));
			}
			const verification = result.result.verification;
			if (verification?.outcome === "blocked") {
				// Whole, wrapped, and in the operator's language where the refusal
				// carries a code: this is the only account they get of why the
				// verification the same confirmation funded did not run. A typed
				// refusal opens by saying verification did not start, so the label
				// belongs only to the raw sentence, which says only what is missing.
				const reason = wrap(blockedReasonText(verification), 120, "  ");
				const head = reason[0]?.trim() ?? "";
				lines.push(
					verification.reasonCode
						? paint.warning(head)
						: `${paint.warning(t("result.verification-blocked"))} ${head}`,
					...reason.slice(1),
					nextLine(view, paint),
				);
				return lines;
			}
			if (verification) {
				lines.push("", ...verificationLines(verification, paint, view));
				return lines;
			}
			lines.push(nextLine(view, paint));
			return lines;
		}
		case "discard-proposal":
			return [`${section(t("result.proposal-discarded"), paint)} ${paint.dim(result.result.runId)}`, nextLine(view, paint)];
		case "abandon-candidate":
			return [
				`${section(t("result.candidate-abandoned"), paint)} ${paint.dim(t("result.stopped-at", { candidate: result.result.candidateId, status: result.result.interruptedStatus }))}`,
				paint.muted(t("result.verify-again")),
				nextLine(view, paint),
			];
		case "review-candidate":
			return [...renderCandidate(result.result, paint, t("candidate.review-recorded")), nextLine(view, paint)];
		case "promote-candidate":
			return [
				`${section(t("result.candidate-promoted"), paint)} ${paint.success(result.result.tag)} ${paint.dim(`· ${shortSha(result.result.candidateSha)}`)}`,
				paint.muted(t("result.tag-records")),
				nextLine(view, paint),
			];
		case "reject-candidate":
			return [...renderCandidate(result.result, paint, t("candidate.rejected")), nextLine(view, paint)];
		case "adopt-candidate":
			return [
				`${section(t("result.candidate-adopted"), paint)} ${t("result.branch")} ${paint.bold(result.result.branch)} ${shortSha(result.result.fromSha)} → ${paint.success(shortSha(result.result.toSha))} ${paint.dim(`· ${result.result.tag}`)}${result.result.disposition !== "adopted" ? paint.dim(` · ${result.result.disposition}`) : ""}`,
				paint.muted(t("result.active-target")),
				nextLine(view, paint),
			];
		case "continue-cycle":
			return [
				`${section(t("result.cycle-closed"), paint)} ${t("result.active-target-line")} ${shortSha(result.result.activeTargetSha)} ${paint.dim(`· ${result.result.candidate.status} candidate ${result.result.candidate.candidateId}`)}`,
				nextLine(view, paint),
			];
	}
}

// The headline the host composed, not a second summary of the same numbers —
// the same rule the candidate verdict has followed since the one-number lane.
function runHeadline(result: { headline: string }): string {
	return result.headline;
}

function startTestingHeadline(result: WorkbenchStartTestingResult): string {
	if (result.headline) return result.headline;
	return result.steps.map((step) => step.kind.replace(/-/g, " ")).join(" · ") || t("headline.nothing-to-do");
}

function verifyHeadline(result: WorkbenchVerifyCandidateResult): string {
	if (result.outcome === "stopped-by-screen") {
		return t("headline.cheap-check-shape", { improved: result.screen.improved, tasks: result.screen.tasks });
	}
	// The headline the host composed, not a second summary of the same numbers:
	// a status bar that rounds differently from the panel under it is the whole
	// defect this lane exists to remove.
	return t("headline.verify", {
		status: candidateStatusLabel(result.candidate.status),
		measurement: result.headline,
	});
}

/** One-line headline for status bars and collapsed tool cards. */
export function decisionHeadline(result: WorkbenchDecisionResult): string {
	switch (result.kind) {
		case "run-eval":
			return runHeadline(result.result);
		case "run-current":
			if (result.result.resolvedAs === "run-eval") return runHeadline(result.result);
			if (result.result.resolvedAs === "start-testing") return startTestingHeadline(result.result);
			// A verification reached through /test is the same verification, and
			// says the same numbers, as one reached through /run.
			return result.result.outcome === "stopped-by-screen"
				? t("headline.cheap-check-flat")
				: verifyHeadline(result.result);
		case "start-testing":
			return startTestingHeadline(result.result);
		case "ship":
			return `${result.result.tag ?? t("headline.no-new-tag")}${
				result.result.adoption ? ` · ${t("headline.fast-forwarded", { branch: result.result.adoption.branch })}` : ""
			}${
				result.result.continuation ? ` · ${t("headline.next-stage", { stage: stageLabel(result.result.continuation.nextStage) })}` : ""
			}`;
		case "verify-candidate":
			return verifyHeadline(result.result);
		case "improve":
			return t("headline.improve", {
				cycles: plural(result.result.cycles.length, "cycle"),
				rate: Math.round(result.result.finalPassRate * 100),
				reason: result.result.stopReason,
			});
		case "calibrate": {
			const calibration = result.result.calibration;
			// The noise, and the one thing it decides that the operator cannot
			// otherwise know: how big an exam has to be to see past it.
			const exam = calibration.recommendedExamCases === null
				? ""
				: ` ${t("headline.calibrate-exam", { cases: plural(calibration.recommendedExamCases, "case") })}`;
			return t("headline.calibrate", {
				verdict: verdictLabel(calibration.verdict),
				band: formatNoiseBand(calibration),
				flip: formatFlipRate(calibration),
				reps: plural(calibration.recommendedRepetitions, "repetition"),
			}) + exam;
		}
		case "regrade":
			return regradeHeadline(result.result);
		default:
			return oneLine(result.message, 120);
	}
}
