import type {
	WorkbenchCandidateSummary,
	WorkbenchDatasetCase,
	WorkbenchDatasetDetail,
	WorkbenchGateProjection,
	WorkbenchHistoryDetail,
	WorkbenchImprovementBriefProjection,
	WorkbenchProposalReview,
	WorkbenchReviewDetail,
	WorkbenchSelectionSummary,
	WorkbenchTargetDetail,
	WorkbenchTracesDetail,
	WorkbenchView,
} from "../../workbench/types.js";
import { failureModeExcerpt, failureModeReading } from "../../application/run-explanation.js";
import type { TargetAuthoringResource } from "../../application/target-authoring-context.js";
import { formatResourceFragment } from "../../domain/comparison-gate.js";
import { resolveWorldPath } from "../../domain/world.js";
import { candidateStatusLabel, hasMessage, plural, t, verdictLabel } from "../../i18n.js";
import { formatFlipRate, formatNoiseBand } from "./calibration.js";
import { diffStats, renderUnifiedDiff } from "./diff.js";
import {
	bar,
	bullets,
	bytes,
	clean,
	examShortfall,
	joinNonEmpty,
	labeled,
	numbered,
	oneLine,
	percent,
	pluralize,
	points,
	section,
	shortHash,
	shortSha,
	when,
	wrap,
} from "./format.js";
import { renderImpact } from "./impact.js";
import { regradedDevelopmentLine } from "./regrade.js";
import { toolPermissionsFromDiff } from "./tool-permissions.js";
import {
	predictionAbsentLine,
	predictionNoteLine,
	predictionPromiseLine,
} from "./prediction.js";
import { measurementOf } from "../../application/prediction.js";
import { examLine, measurementLine, measurementSurface } from "../../application/measurement-line.js";
import type { Paint } from "./paint.js";
import { planProgress, type Plan } from "./plan.js";
import { nextStep, stageLabel, stageNextStep } from "./stage.js";

export interface RenderReviewOptions {
	maxDiffLines?: number;
	/** Task rows shown for a corpus draft before the list is folded. */
	maxTasks?: number;
}

function targetLine(view: WorkbenchView, paint: Paint): string {
	if (view.target.status === "missing") return `${paint.dim(t("label.target"))} ${paint.muted(t("target.missing"))}`;
	const model = view.target.model;
	const modelText = view.target.status === "bootstrap-required" || !model
		? paint.warning(t("target.model-not-chosen"))
		: `${oneLine(`${model.provider}/${model.id}`, 60)} ${model.credentialPresent ? paint.success("✓") : paint.warning(t("target.credential-missing", { env: oneLine(model.apiKeyEnv, 40) }))}`;
	return `${paint.dim(t("label.target"))} ${paint.bold(oneLine(view.target.id ?? "—", 60))} ${paint.dim(`@ ${shortSha(view.target.gitSha)}`)} ${paint.dim("·")} ${modelText}`;
}

/**
 * What this suite measures WITH, when it has been chosen. Silent on a Target
 * that configures neither, because a basket of plain checks needs neither; a
 * configured model whose key is not exported gets said out loud, because it
 * fails at the first graded case and nowhere earlier.
 */
function evaluatorLine(view: WorkbenchView, paint: Paint): string | null {
	const evaluators = view.target.evaluators;
	if (!evaluators) return null;
	const parts: string[] = [];
	for (const [role, labelKey] of [["judge", "label.judge"], ["simulatedUser", "label.user-model"]] as const) {
		const model = evaluators[role];
		if (!model) continue;
		parts.push(
			`${paint.dim(t(labelKey))} ${oneLine(`${model.provider}/${model.id}`, 40)} ${
				model.credentialPresent ? paint.success("✓") : paint.warning(t("target.credential-missing", { env: oneLine(model.apiKeyEnv, 40) }))
			}`,
		);
	}
	return parts.length === 0 ? null : `${paint.dim(t("label.evaluators"))} ${parts.join(paint.dim(" · "))}`;
}

/**
 * What this project already holds. Silent while it holds nothing: a first
 * screen reading `0 runs · 0 open changes · 0 candidates` is a row of zeroes
 * about words the operator has not met yet, and the next-step line above it
 * already says the only thing there is to do.
 */
function evidenceLine(view: WorkbenchView, paint: Paint): string | null {
	const counts = view.counts;
	if (
		counts.developmentEvals === 0 && counts.openProposals === 0 &&
		counts.candidates === 0 && counts.sealedCorpora === 0
	) return null;
	return `${paint.dim(t("label.evidence"))} ${joinNonEmpty([
		plural(counts.developmentEvals, "eval run"),
		plural(counts.openProposals, "open proposal"),
		plural(counts.candidates, "candidate"),
		counts.sealedCorpora > 0 ? plural(counts.sealedCorpora, "sealed holdout") : null,
	])}`;
}

/**
 * The blockers in the operator's language. The Workbench mints each one twice
 * — an English sentence for the model and scripts, and a typed reason — so the
 * host renders the reason and falls back to the sentence only for a view that
 * predates the reasons.
 */
export function blockerLines(view: Pick<WorkbenchView, "blockers" | "blockerReasons">): string[] {
	const reasons = view.blockerReasons;
	if (!reasons || reasons.length !== view.blockers.length) {
		return view.blockers.map((item) => oneLine(item, 200));
	}
	return reasons.map((reason, index) => {
		if (!hasMessage(reason.code)) return oneLine(view.blockers[index] ?? "", 200);
		const text = t(reason.code, reason.params);
		return oneLine(reason.detail ? `${text} ${reason.detail}` : text, 200);
	});
}

/**
 * The development loop remains usable without an exam, but applying a change
 * before one exists creates a late, expensive dead end. Keep that future ship
 * blocker in the persistent product surface from the first session onward.
 */
function shippingReadinessLine(view: WorkbenchView, paint: Paint): string | null {
	const readiness = view.shippingReadiness;
	if (!readiness || view.counts.approvedSpecs === 0) return null;
	// An exam over the minimum still answers nothing if this Target's own noise
	// is wider than the difference it is meant to see. Muted, and never a
	// blocker: it is advice about the next exam, not a refusal of this one.
	const needed = view.calibration?.recommendedExamCases ?? null;
	const cases = readiness.sealedCases;
	const undersized = needed !== null && cases !== null && cases < needed
		? t("exam.size-hint", { cases: plural(cases, "case"), needed: plural(needed, "case") })
		: null;
	if (readiness.sealedHoldout === "ready") {
		return undersized === null ? null : `${paint.dim(t("label.ship-gate"))} ${paint.muted(undersized)}`;
	}
	const state = readiness.sealedHoldout === "missing"
		? t("ship-gate.missing")
		: readiness.sealedHoldout === "underpowered"
			? t("ship-gate.underpowered", examShortfall(readiness))
			: t("ship-gate.unavailable");
	// With no exam at all the operator has two ways out and both are named; with
	// a broken or too-small one they have exactly one, and it is not the judge.
	const hint = readiness.sealedHoldout === "missing" ? "ship-gate.hint-none" : "ship-gate.hint";
	return `${paint.dim(t("label.ship-gate"))} ${paint.warning(state)} ${paint.dim(t(hint, { minimum: readiness.minimumTasks }))}${
		undersized === null ? "" : ` ${paint.muted(`· ${undersized}`)}`
	}`;
}

/** Stages where an uncalibrated Target is worth one nudge, not a blocker. */
const CALIBRATION_STAGES = new Set<WorkbenchView["stage"]>(["ready-to-evaluate", "improvement-authoring"]);

/**
 * How much this Target disagrees with itself, in one line. Without a
 * calibration of the current revision the line offers to measure it; it stays
 * silent everywhere the operator has nothing to do about it.
 */
function calibrationLine(view: WorkbenchView, paint: Paint): string | null {
	const calibration = view.calibration;
	if (calibration) {
		const verdict = oneLine(verdictLabel(calibration.verdict), 20);
		return `${paint.dim(t("label.noise"))} A/A ${calibration.verdict === "inconclusive" ? verdict : paint.warning(verdict)} ${paint.dim("·")} ` +
			`${formatNoiseBand(calibration)} ${paint.dim("·")} ${t("noise.flip")} ${formatFlipRate(calibration)} ${paint.dim("·")} ` +
			`${t("noise.reps", { count: calibration.recommendedRepetitions })}`;
	}
	if (!CALIBRATION_STAGES.has(view.stage)) return null;
	return `${paint.dim(t("label.noise"))} ${paint.muted(t("noise.not-calibrated"))} ${paint.dim(t("noise.hint"))}`;
}

/**
 * One focused artifact, as a noun rather than as its schema name.
 *
 * The eval run is named, never measured. The focus IS the baseline: it is the
 * run an improvement is written against, and choosing another one clears the
 * proposal and the candidate beneath it. Its own pass count is therefore not
 * the current measurement, and printing it here put a stale `0/24 passed`
 * three lines under a live `45 % → 67 %`. The panel says the measurement; this
 * line says which artifact the next decision will act on.
 */
function selectionLabel(item: WorkbenchSelectionSummary, paint: Paint): string {
	const key = `selection.${item.kind}`;
	const kind = hasMessage(key) ? t(key) : item.kind;
	return `${paint.dim(kind)} ${oneLine(item.kind === "eval-run" ? item.id : item.label, 40)}`;
}

export interface RenderStatusOptions {
	/**
	 * Draw the `AHDE · stage` heading. Off for a caller that prints its own
	 * title over the block — the panel did, and the operator read the same
	 * words twice, once with a `◆` and once without.
	 */
	heading?: boolean;
}

/** Compact status block used by /status and as the fallback for every panel. */
export function renderStatus(view: WorkbenchView, paint: Paint, options: RenderStatusOptions = {}): string[] {
	const noise = calibrationLine(view, paint);
	const evaluators = evaluatorLine(view, paint);
	const evidence = evidenceLine(view, paint);
	const shipping = shippingReadinessLine(view, paint);
	const lines = [
		...(options.heading === false
			? []
			: [`${paint.accent(paint.bold("AHDE"))} ${paint.dim("·")} ${paint.bold(stageLabel(view.stage))}`]),
		targetLine(view, paint),
		...(evaluators ? [evaluators] : []),
		...(evidence ? [evidence] : []),
		...(shipping ? [shipping] : []),
		...(noise ? [noise] : []),
		`${paint.dim(t("label.next"))} ${nextStep(view)}`,
	];
	if (view.blockers.length > 0) lines.push(`${paint.warning(t("label.blocked"))} ${blockerLines(view).join(" ")}`);
	if (view.warnings.length > 0) {
		lines.push(`${paint.warning(t("label.warnings"))}`);
		lines.push(...bullets(view.warnings, paint, { limit: 6, max: 200 }));
	}
	const selected = view.selections.filter((item) => item.selected);
	if (selected.length > 0) {
		lines.push(`${paint.dim(t("label.selected"))} ${selected.map((item) => selectionLabel(item, paint)).join(paint.dim(" · "))}`);
	}
	return lines;
}

export interface HeaderState {
	view: WorkbenchView | null;
	builderModel: { label: string | null; credentialPresent: boolean };
	error?: string | null;
	previousSessions?: number;
	/** The cycle as a checklist, folded to one line under the stage. */
	plan?: Plan | null;
	/**
	 * How far this project's judge has been checked against this operator's own
	 * eyes. Undefined means no judge grades anything here, so the header stays
	 * silent; null means one does and nobody has checked it.
	 */
	judge?: { agreement: number; kappa: number | null; labels: number } | null | undefined;
	/**
	 * The sentence the shell has already put in front of the operator as the
	 * hint under the transcript. When it is the same sentence the stage line
	 * would print after `Next`, the stage line has nothing left to add — see
	 * {@link renderHeader}.
	 */
	hint?: string | null;
}

/**
 * The instrument line in the header: `Judge agrees with you 84% · κ 0.62 · n=20`.
 *
 * Separate from {@link judgeAgreementLine}, which speaks about one candidate's
 * evidence. This one speaks about the judge the operator is working with, in the
 * second person, because they are the other half of the number.
 */
function headerJudgeLine(state: HeaderState, paint: Paint): string | null {
	if (state.judge === undefined) return null;
	if (state.judge === null) {
		return `${paint.dim(t("label.judge-instrument"))} ${paint.warning(t("judge.not-calibrated"))} ${paint.dim(t("judge.label-hint"))}`;
	}
	const kappa = state.judge.kappa === null ? "κ n/a" : `κ ${state.judge.kappa.toFixed(2)}`;
	return `${paint.dim(t("label.judge-instrument"))} ${t("judge.agrees-with-you", { rate: percent(state.judge.agreement) })} ` +
		`${paint.dim("·")} ${kappa} ${paint.dim(`· n=${state.judge.labels}`)}`;
}

/** Persistent header: identity, live stage, next step, evidence, and readiness. */
export function renderHeader(state: HeaderState, paint: Paint): string[] {
	const builder = state.builderModel.label
		? `${state.builderModel.label} ${state.builderModel.credentialPresent ? paint.success("✓") : paint.warning(t("header.not-connected-suffix"))}`
		: paint.warning(t("header.not-connected"));
	const lines = ["", `${paint.accent(paint.bold(t("header.title")))} ${paint.dim(t("header.tagline"))}`];
	if (state.error) {
		lines.push(`${paint.error(t("header.state-unavailable"))} ${oneLine(state.error, 160)}`);
		lines.push(`${paint.dim(t("label.builder-model"))} ${builder}`);
		lines.push("");
		return lines;
	}
	const view = state.view;
	if (!view) {
		lines.push(`${paint.dim(t("label.builder-model"))} ${builder}`, "");
		return lines;
	}
	lines.push(targetLine(view, paint));
	// The stage, the cycle progress and the next step are one line, not three.
	// `План 1/8 · ▸ Описание агента` said the stage a second time under a line
	// that had just said it, and `Дальше <шаг>` said, word for word, the hint
	// the shell had put two lines lower. What survives here is what the other
	// two do not already carry — and when the next step is that same hint,
	// nothing does: the line is the stage's own name and a count `/plan` opens
	// in full, so it is not drawn at all.
	const next = nextStep(view);
	const duplicated = typeof state.hint === "string" && state.hint === next;
	if (!duplicated) {
		const progress = state.plan ? planProgress(state.plan) : null;
		lines.push(joinNonEmpty([
			`${paint.dim(t("label.stage"))} ${paint.bold(stageLabel(view.stage))}`,
			progress ? paint.dim(t("plan.progress", { done: progress.done, total: progress.total })) : null,
			`${paint.dim(t("label.next"))} ${next}`,
		], ` ${paint.dim("·")} `));
	}
	const evidence = evidenceLine(view, paint);
	lines.push(joinNonEmpty([evidence, `${paint.dim(t("label.builder-model"))} ${builder}`], ` ${paint.dim("·")} `));
	const shipping = shippingReadinessLine(view, paint);
	if (shipping) lines.push(shipping);
	const noise = calibrationLine(view, paint);
	if (noise) lines.push(noise);
	const judge = headerJudgeLine(state, paint);
	if (judge) lines.push(judge);
	const keys = toolCredentialLine(view, paint);
	if (keys) lines.push(keys);
	if (view.blockers.length > 0 && view.stage !== "target-setup") {
		lines.push(`${paint.warning(t("label.blocked"))} ${oneLine(blockerLines(view).join(" "), 200)}`);
	}
	lines.push(paint.dim(t("header.help")));
	lines.push("");
	return lines;
}

/**
 * A tool that declares a key nobody exported is one line, before it becomes a
 * confusing failure inside a sandbox. The whole recovery is in the line.
 */
function toolCredentialLine(view: WorkbenchView, paint: Paint): string | null {
	const missing = (view.target.toolCredentials ?? []).filter((entry) => !entry.present);
	if (missing.length === 0) return null;
	const names = [...new Set(missing.map((entry) => entry.environment))];
	const tools = [...new Set(missing.map((entry) => entry.tool))];
	return `${paint.warning(t("label.tool-key"))} ${t("tool-key.missing", {
		tools: tools.join(", "),
		names: names.join(", "),
	})}`;
}

function verdictTone(verdict: string, paint: Paint): (text: string) => string {
	switch (verdict) {
		case "improved":
		case "pass":
			return paint.success;
		case "regressed":
		case "fail":
			return paint.error;
		default:
			return paint.warning;
	}
}

/** `cost ×1.4 · latency ×0.9`, dimmed and prefixed, or nothing when unmeasured. */
function resourceSuffix(gate: { resources: WorkbenchGateProjection["resources"] }, paint: Paint): string {
	const fragment = formatResourceFragment(gate.resources);
	return fragment ? ` ${paint.dim(`· ${fragment}`)}` : "";
}

/**
 * The verification, in the one sentence the whole system prints, painted.
 *
 * The parts come from the composer, never from arithmetic here: the delta and
 * its interval are both about the mean grader score the gate decided on, and
 * the pass rate follows them named. Under it go the per-task counts, what the
 * two arms cost, and — on a basket too small for the interval to settle
 * anything — one muted line saying so.
 */
function comparisonLines(
	summary: NonNullable<NonNullable<WorkbenchCandidateSummary["development"]>["comparison"]>,
	gate: NonNullable<WorkbenchCandidateSummary["development"]>["gate"],
	paint: Paint,
): string[] {
	const line = measurementLine({ development: measurementSurface({ ...summary, ...gate }) });
	const shown = gate ? gate.scoreDelta : summary.delta;
	const tone = shown > 0 ? paint.success : shown < 0 ? paint.error : paint.muted;
	const verdict = line.verdict ? `${verdictTone(gate?.verdict ?? "", paint)(line.verdict)} ${paint.dim("·")} ` : "";
	const lines = [
		`${paint.dim(t("label.development"))} ${verdict}${line.metric} ${tone(line.delta)} ${paint.dim(line.design)}` +
			(line.passRate ? ` ${paint.dim(`· ${line.passRate}`)}` : ""),
		`  ${paint.success(t("development.improved", { count: summary.improved }))} ${paint.dim("·")} ${summary.regressed > 0 ? paint.warning(t("development.lower", { count: summary.regressed })) : paint.muted(t("development.lower", { count: 0 }))} ${paint.dim("·")} ${paint.muted(t("development.unchanged", { count: summary.unchanged }))}` +
			(gate ? resourceSuffix(gate, paint) : "") +
			(gate && gate.flags.collapsedTasks > 0
				? ` ${paint.error(t("development.collapsed", { tasks: plural(gate.flags.collapsedTasks, "task") }))}`
				: ""),
	];
	if (line.smallBasket) lines.push(`  ${paint.muted(line.smallBasket)}`);
	return lines;
}

/** One line about the instrument: how far this judge matches a human's eyes. */
export function judgeAgreementLine(
	calibration: NonNullable<WorkbenchCandidateSummary["judgeAgreement"]> | null,
	paint: Paint,
): string {
	if (!calibration) return `${paint.dim(t("label.judge-instrument"))} ${paint.warning(t("judge.not-calibrated"))} ${paint.dim(t("judge.label-hint"))}`;
	const kappa = calibration.kappa === null ? "κ n/a" : `κ ${calibration.kappa.toFixed(2)}`;
	return `${paint.dim(t("label.judge-instrument"))} ${t("judge.agreement", { rate: percent(calibration.agreement) })} ${paint.dim("·")} ${kappa} ${paint.dim(`· n=${calibration.labels}`)}`;
}

export function renderCandidate(
	candidate: WorkbenchCandidateSummary & {
		proposal?: WorkbenchProposalReview | null;
		proposalError?: string | null;
		adoption?: { receiptId: string; adoptedAt: string; branch: string } | null;
		continuation?: { receiptId: string; continuedAt: string } | null;
		impact?: Parameters<typeof renderImpact>[0];
	},
	paint: Paint,
	title = t("candidate.title"),
	maxDiffLines = Number.MAX_SAFE_INTEGER,
): string[] {
	const statusTone = candidate.status === "promoted"
		? paint.success
		: candidate.status === "rejected" ? paint.error : paint.accent;
	const lines = [
		`${section(title, paint)} ${paint.dim(candidate.candidateId)} ${paint.dim("·")} ${statusTone(candidateStatusLabel(candidate.status))}`,
		`${paint.dim(t("label.revision"))} ${candidate.baseline.ref}@${shortSha(candidate.baseline.sha)} → ${candidate.candidate ? `${candidate.candidate.ref}@${shortSha(candidate.candidate.sha)}` : paint.muted(t("candidate.not-built"))}`,
	];
	// A loop apply is not a reviewed apply. The candidate says which it was, here
	// and in the ship dialog, so nobody has to infer it from the branch name.
	const applied = candidate.appliedBy;
	if (applied) {
		lines.push(applied.via
			? `${paint.dim(t("label.applied"))} ${paint.warning(t(applied.via === "improvement-loop" ? "candidate.applied-by-loop" : "candidate.applied-by-search"))} ` +
				`${paint.dim(t("candidate.applied-automated", { actor: applied.actorId }))}`
			: `${paint.dim(t("label.applied"))} ${paint.dim(t("candidate.applied-reviewed", { actor: applied.actorId }))}`);
		if (applied.paths.length > 0) {
			lines.push(`${paint.dim(t("label.diff"))} ${oneLine(applied.paths.join(", "), 120)} ${paint.dim(`(${plural(applied.paths.length, "file")})`)}`);
		}
		if (candidate.proposal) {
			const stats = diffStats(candidate.proposal.exactDiff);
			lines.push(`${paint.dim(t("label.exact-proposal"))} ${paint.dim(shortHash(candidate.proposal.proposalHash))} ${paint.dim(`(${paint.added(`+${stats.added}`)} ${paint.removed(`-${stats.removed}`)})`)}`);
			lines.push(...renderUnifiedDiff(candidate.proposal.exactDiff, paint, { maxLines: maxDiffLines }));
		}
		if (candidate.proposalError) {
			lines.push(paint.error(`Exact proposal unavailable — ${oneLine(candidate.proposalError, 180)}`));
			lines.push(paint.muted(t("view.promotion-blocked")));
		}
	}
	if (candidate.development?.comparison) lines.push(...comparisonLines(candidate.development.comparison, candidate.development.gate, paint));
	else if (candidate.development) lines.push(`${paint.dim(t("label.development"))} ${paint.muted(t("candidate.not-reconstructable"))}`);
	else lines.push(`${paint.dim(t("label.development"))} ${paint.muted(t("candidate.not-evaluated"))}`);
	// The rubric moved after this candidate was decided, and both arms were
	// re-scored under it. One extra line, never a rewrite of the verdict above.
	if (candidate.regraded && candidate.development?.comparison) {
		lines.push(regradedDevelopmentLine(candidate.development.comparison, candidate.regraded, paint));
	}
	const sealedGate = candidate.sealedHoldout.gate;
	// The gate says what the exam decided; the receipt behind it says why it was
	// the size it was — 19 cases for the 20 that were ordered.
	const exam = examLine(sealedGate && { ...sealedGate, generation: candidate.sealedHoldout.generation ?? null });
	lines.push(`${paint.dim(t("label.sealed-holdout"))} ${candidate.sealedHoldout.executed
		? (sealedGate && exam
			? `${verdictTone(sealedGate.verdict, paint)(exam.verdict)} ${exam.delta} ${paint.dim(exam.design)}${
				exam.shortfall ? ` ${paint.muted(exam.shortfall)}` : ""
			}${resourceSuffix(sealedGate, paint)}`
			: (candidate.sealedHoldout.gatePassed ? paint.success(t("sealed.gate-passed")) : paint.error(t("sealed.legacy"))))
		: paint.muted(t("sealed.not-executed"))}`);
	if (sealedGate && sealedGate.verdict !== "pass") lines.push(`  ${paint.muted(oneLine(sealedGate.reasons[0] ?? "", 160))}`);
	if (candidate.judgeAgreement !== undefined) lines.push(judgeAgreementLine(candidate.judgeAgreement, paint));
	// The verdict is read beside the questions the tool cases answer, so the
	// gate's "better" is never mistaken for "it calls the tool correctly", and
	// beside the promise the proposal made, so "better" is never mistaken for
	// "as much better as it said".
	lines.push(...renderImpact(candidate.impact ?? null, paint, {
		tools: toolPermissionsFromDiff(candidate.proposal?.exactDiff ?? "").filter((entry) => !entry.removed).map((entry) => entry.tool),
		prediction: candidate.proposal?.prediction ?? null,
		// The gate this candidate was decided on is the only measured side a
		// prediction may be read against; without one, the paired summary still
		// carries the pass rate a pass-rate promise is about.
		measurement: measurementOf(candidate.development?.gate ?? candidate.development?.comparison ?? null),
	}));
	if (candidate.review) {
		const tone = candidate.review.recommendation === "promote" ? paint.success : paint.error;
		lines.push(`${paint.dim(t("label.review"))} ${tone(candidate.review.recommendation)} ${paint.dim("—")} ${oneLine(candidate.review.reason, 160)}`);
	}
	if (candidate.promotion) lines.push(`${paint.dim(t("label.promoted"))} ${paint.success(candidate.promotion.tag)} ${paint.dim(when(candidate.promotion.at))} ${paint.dim("—")} ${oneLine(candidate.promotion.reason, 120)}`);
	if (candidate.rejection) lines.push(`${paint.dim(t("label.rejected"))} ${paint.dim(when(candidate.rejection.at))} ${paint.dim("—")} ${oneLine(candidate.rejection.reason, 120)}`);
	if (candidate.adoption) lines.push(`${paint.dim(t("label.adopted"))} ${t("result.branch")} ${paint.bold(candidate.adoption.branch)} ${paint.dim(when(candidate.adoption.adoptedAt))}`);
	else if (candidate.status === "promoted") lines.push(`${paint.dim(t("label.adopted"))} ${paint.warning(t("candidate.not-adopted"))}`);
	if (candidate.continuation) lines.push(`${paint.dim(t("label.cycle"))} ${t("candidate.cycle-closed", { when: paint.dim(when(candidate.continuation.continuedAt)) })}`);
	return lines;
}

function renderSpec(content: Extract<WorkbenchReviewDetail, { kind: "spec-draft" }>, paint: Paint): string[] {
	const spec = content.spec;
	const list = (label: string, items: string[]): string[] => items.length === 0
		? [`${paint.dim(label.padEnd(15))} ${paint.muted("—")}`]
		: [paint.dim(label), ...bullets(items, paint, { limit: 10, max: 140 })];
	const lines = [
		`${section(t("section.spec-draft"), paint)} ${paint.dim(content.id)}`,
		labeled(paint.dim(t("dialog.title")), paint.bold(oneLine(spec.title, 120)), 15),
		paint.dim(t("view.purpose")),
		...wrap(spec.purpose, 96, "  "),
		...list(t("dialog.users"), spec.users),
		...list(t("dialog.jobs"), spec.jobs),
		...list(t("view.inputs"), spec.inputs),
		...list(t("view.allowed-actions"), spec.allowedActions),
		...list(t("passport.success-criteria"), spec.successCriteria),
		...list(t("passport.constraints"), spec.constraints),
	];
	if (spec.openQuestions.length > 0) lines.push(paint.warning(t("view.open-questions")), ...bullets(spec.openQuestions, paint, { limit: 10, max: 140 }));
	lines.push(`${paint.dim(t("view.snapshot"))} ${paint.dim(shortHash(content.snapshotHash))}`);
	return lines;
}

function graderLabel(grader: { type: string } & Record<string, unknown>): string {
	switch (grader.type) {
		case "tool_called": return `tool ${String(grader.tool ?? grader.name ?? "?")}${grader.argsContains ? ` ∋ “${oneLine(String(grader.argsContains), 30)}”` : ""}`;
		case "output_contains": return `contains “${oneLine(String(grader.text ?? ""), 30)}”`;
		case "output_matches": return `matches /${oneLine(String(grader.pattern ?? ""), 30)}/`;
		case "no_secret": return t("grader.no-secret");
		case "judge": {
			// A judge may now carry assertions instead of a rubric; showing an empty
			// quote for the whole check is worse than showing the checks themselves.
			const assertions = Array.isArray(grader.assertions) ? grader.assertions.map(String) : [];
			const body = grader.rubric
				? `“${oneLine(String(grader.rubric), 40)}”`
				: assertions.length > 0
					? `“${oneLine(assertions.join(" · "), 40)}”`
					: "“”";
			const jury = typeof grader.jury === "number" && grader.jury > 1 ? ` · jury ${grader.jury}` : "";
			const checks = grader.rubric && assertions.length > 0 ? ` +${assertions.length} assertions` : "";
			const reference = grader.withReference ? " · with reference" : "";
			return `judge ${body}${checks}${jury}${reference}`;
		}
		default: return grader.type;
	}
}

function renderCorpusDraft(
	content: Extract<WorkbenchReviewDetail, { kind: "corpus-draft" }>,
	paint: Paint,
	options: RenderReviewOptions,
): string[] {
	const maxTasks = options.maxTasks ?? 25;
	const lines = [
		`${section(t("section.basket-draft"), paint)} ${paint.bold(oneLine(content.name, 80))} ${paint.dim("·")} ${plural(content.tasks.length, "case")} ${paint.dim(`· ${content.id}`)}`,
	];
	if (content.importSource) lines.push(`${paint.dim(t("view.imported-from"))} ${oneLine(String((content.importSource as { path?: unknown }).path ?? "imports/"), 120)}`);
	content.tasks.slice(0, maxTasks).forEach((task, index) => {
		const graders = (task.graders as ({ type: string } & Record<string, unknown>)[]).map(graderLabel).join(paint.dim(" · "));
		lines.push(`  ${paint.dim(`${String(index + 1).padStart(2)}.`)} ${oneLine(task.input, 96)}`);
		lines.push(`      ${paint.dim(t("view.graders"))} ${graders}`);
	});
	if (content.tasks.length > maxTasks) lines.push(`  ${paint.dim(t("view.more-cases", { count: content.tasks.length - maxTasks }))}`);
	if (content.coverageNotes.length > 0) lines.push(paint.dim(t("view.coverage-notes")), ...bullets(content.coverageNotes, paint, { limit: 8, max: 140 }));
	if (content.taskProvenance.length > 0) lines.push(`${paint.dim(t("view.provenance"))} ${t("view.provenance-bound", { cases: plural(content.taskProvenance.length, "case") })}`);
	lines.push(`${paint.dim(t("label.draft"))} ${paint.dim(shortHash(content.draftHash))} ${paint.dim(`· ${t("label.spec")}`)} ${paint.dim(content.approvedSpec.specId)}`);
	return lines;
}

function renderProposal(
	content: Extract<WorkbenchReviewDetail, { kind: "proposal" | "applied-proposal" }>,
	paint: Paint,
	options: RenderReviewOptions,
): string[] {
	const stats = diffStats(content.exactDiff);
	const lines = [
		`${section(t(content.kind === "applied-proposal" ? "panel.applied-proposal" : "section.proposal"), paint)} ${paint.dim(content.runId)}`,
		...wrap(content.summary, 96, "  "),
		`${paint.dim(t("label.changes"))} ${content.paths.map((path) => paint.bold(oneLine(path, 80))).join(paint.dim(", "))} ${paint.dim(`(${paint.added(`+${stats.added}`)} ${paint.removed(`-${stats.removed}`)})`)}`,
		`${paint.dim(t("label.base-revision"))} ${shortSha(content.baseTargetSha)} ${paint.dim(`· ${t("result.proposal-word")}`)} ${paint.dim(shortHash(content.proposalHash))}`,
	];
	if (content.evidenceBasis) {
		lines.push(`${paint.dim(t("label.evidence"))} ${t("review.evidence", {
			run: content.evidenceBasis.evalRunId,
			modes: plural(content.evidenceBasis.failureModes.length, "failure mode"),
			refs: plural(content.evidenceBasis.runRefs.length, "run reference"),
		})}`);
	} else {
		lines.push(`${paint.dim(t("label.evidence"))} ${paint.muted(t("review.evidence-none"))}`);
	}
	// The promise, on the same screen as the diff it is a promise about — and in
	// the same words the diagnosis used, when the brief behind it could be read.
	const modeTitles = new Map((content.targetedModes ?? []).map((mode) => [mode.failureModeId, mode.title]));
	lines.push(predictionPromiseLine(content.prediction, paint, modeTitles) ?? predictionAbsentLine(paint));
	const predictionNote = predictionNoteLine(content.prediction, paint);
	if (predictionNote) lines.push(predictionNote);
	if (content.risks.length > 0) lines.push(paint.warning(t("label.risks")), ...bullets(content.risks, paint, { limit: 6, max: 160 }));
	if (content.validationPlan.length > 0) lines.push(paint.dim(t("label.validation-plan")), ...bullets(content.validationPlan, paint, { limit: 6, max: 160 }));
	if (content.kind === "applied-proposal") {
		lines.push(`${paint.dim(t("label.applied"))} ${t("result.branch")} ${paint.bold(content.application.branch)} ${paint.dim("·")} ${shortSha(content.application.baseTargetSha)} → ${shortSha(content.application.candidateSha)} ${paint.dim(when(content.application.appliedAt))}`);
	}
	lines.push(paint.dim(t("label.diff")));
	lines.push(...renderUnifiedDiff(content.exactDiff, paint, {
		maxLines: options.maxDiffLines ?? Number.MAX_SAFE_INTEGER,
	}));
	return lines;
}

/** Human rendering of the exact artifact under review. Never prints raw JSON. */
export function renderReview(content: WorkbenchReviewDetail, paint: Paint, options: RenderReviewOptions = {}): string[] {
	switch (content.kind) {
		case "spec-draft": return renderSpec(content, paint);
		case "corpus-draft": return renderCorpusDraft(content, paint, options);
		case "proposal":
		case "applied-proposal": return renderProposal(content, paint, options);
		case "candidate": return renderCandidate(content, paint, t("candidate.title"), options.maxDiffLines ?? Number.MAX_SAFE_INTEGER);
		case "interrupted-candidate": return [
			...renderCandidate(content, paint, t("candidate.interrupted")),
			paint.warning(t("review.interrupted-warning")),
		];
		// The headline is the model's sentence about this stage, in English by
		// design. The operator gets the same fact in their own language, which is
		// exactly what the next-step line already says.
		case "workflow": return [`${section(stageLabel(content.stage), paint)}`, ...wrap(stageNextStep(content.stage, content.headline), 96, "  ")];
	}
}

/**
 * One mode as the operator reads it: what it is, how much of the corpus it
 * covers, what the traces show, and one raw excerpt underneath it. The
 * suggestion is gone from the panel — it was the same two sentences under every
 * mode; the excerpt is the thing a person can act on.
 */
function modeLines(brief: WorkbenchImprovementBriefProjection, paint: Paint): string[] {
	const lines: string[] = [];
	for (const mode of brief.modes) {
		const reading = failureModeReading(mode);
		const scope = mode.scope === "systemic" ? paint.warning(t("mode.scope.systemic")) : paint.muted(t("mode.scope.task-local"));
		const decision = mode.decision === "propose-harness-change"
			? (mode.selectableForProposal ? paint.success(t("mode.decision.propose")) : paint.muted(t("mode.decision.not-selectable")))
			: mode.decision === "stabilize-and-rerun" ? paint.warning(t("mode.decision.stabilize")) : paint.error(t("mode.decision.repair"));
		lines.push(`  ${paint.bold(`${mode.ordinal}.`)} ${paint.bold(oneLine(reading.title, 90))} ${paint.dim("—")} ${t("mode.tasks-affected", { affected: mode.impact.affectedTasks, total: mode.impact.totalTasks })} ${paint.dim(`(${t("mode.reproduces", { percent: Math.round(mode.impact.reproductionBps / 100) })})`)}`);
		lines.push(`     ${scope} ${paint.dim("·")} ${decision}`);
		lines.push(...wrap(reading.facts, 92, "     "));
		const excerpt = mode.evidence[0];
		const quoted = excerpt ? failureModeExcerpt(excerpt) : null;
		if (excerpt && quoted) {
			lines.push(...wrap(`${excerpt.runId} ${paint.dim("·")} ${quoted}`, 92, "       "));
		}
	}
	const hidden = brief.conversationProjection.omittedModes;
	if (hidden > 0) lines.push(`  ${paint.dim(t("mode.more-in-explorer", { count: hidden }))}`);
	return lines;
}

/**
 * The instrument beside the run it graded: the agreement, or the one sentence
 * the ship dialog also puts in its subject. Never a blocker — an uncalibrated
 * judge is a fact about what the numbers above are worth, not a refusal.
 */
export function judgeRunAgreementLine(
	calibration: NonNullable<WorkbenchCandidateSummary["judgeAgreement"]> | null,
	paint: Paint,
): string {
	return calibration ? judgeAgreementLine(calibration, paint) : paint.warning(t("judge.uncalibrated"));
}

export function renderEvaluationSummary(
	evaluation: WorkbenchTracesDetail["evaluation"],
	paint: Paint,
): string {
	const summary = evaluation.summary;
	const tone = summary.error > 0 ? paint.warning : summary.fail === 0 ? paint.success : paint.accent;
	const failed = t("run.failed", { count: summary.fail });
	const errors = plural(summary.error, "error");
	return `${tone(paint.bold(t("run.passed", { pass: summary.pass, total: summary.total })))} ${paint.dim(bar(summary.allPassRate, 16))} ${paint.dim(percent(summary.allPassRate))} ${paint.dim("·")} ${summary.fail > 0 ? paint.error(failed) : paint.muted(failed)} ${paint.dim("·")} ${summary.error > 0 ? paint.warning(errors) : paint.muted(errors)} ${paint.dim(`· ${plural(evaluation.repetitions, "repetition")} · ${evaluation.evalRunId}`)}`;
}

/** Diagnosis screen shared by /traces and the post-run summary. */
export interface RenderTracesOptions {
	/**
	 * Whether the panel closes with its own `Next` line.
	 *
	 * False wherever the surface around it already prints one: a decision ends
	 * with the stage's next step, and `renderView` puts the status block above
	 * this one. Session 6 showed both at once — `Дальше скажи «исправь первую
	 * проблему» (или назови режим) — подготовлю точную правку` and, two lines
	 * later, `Дальше Скажи «исправь первую проблему» (Разбор)`.
	 */
	next?: boolean;
}

export function renderTraces(content: WorkbenchTracesDetail, paint: Paint, options: RenderTracesOptions = {}): string[] {
	const brief = content.improvementBrief;
	const evaluation = content.evaluation;
	const lines = [
		`${section(t("section.evaluation"), paint)} ${renderEvaluationSummary(evaluation, paint)}` +
			// A count of checks the judge would not decide, beside the pass/fail line
			// it is already inside: those failures are the instrument's, not the
			// agent's, and one number is what keeps them from reading as the agent's.
			(content.judgeAbstained ? ` ${paint.dim("·")} ${paint.warning(t("judge.abstained", { count: content.judgeAbstained }))}` : ""),
		// Which run this is. The Target moves under the operator, so a screen that
		// only said "the diagnosis" left them guessing which measurement they read.
		`${paint.dim(t("traces.showing"))} ${paint.bold(evaluation.evalRunId)} ${paint.dim(
			`· ${when(evaluation.finishedAt)} · ${t("label.revision").toLowerCase()} ${shortSha(evaluation.targetGitSha)} · ${
				evaluation.corpus
					? `${oneLine(evaluation.corpus.name, 50)} · ${plural(evaluation.corpus.taskCount, "case")}`
					: t("traces.basketGone")
			}`,
		)}`,
	];
	const status = brief.status === "actionable"
		? paint.success(t("diagnosis.status.actionable"))
		: brief.status === "healthy" ? paint.success(t("diagnosis.status.healthy")) : paint.warning(t("diagnosis.status.inconclusive"));
	lines.push(`${paint.dim(t("label.diagnosis"))} ${status} ${paint.dim("·")} ${t("diagnosis.headline", {
		pass: content.evaluation.summary.pass,
		total: content.evaluation.summary.total,
		modes: brief.summary.failureModeCount,
		systemic: brief.summary.systemicFailureModeCount,
	})}`);
	// How far the judge behind those verdicts has been checked, whenever one
	// graded this run. Undefined means none did, so the panel stays silent.
	if (content.judgeAgreement !== undefined) lines.push(judgeRunAgreementLine(content.judgeAgreement, paint));
	if (brief.modes.length > 0) {
		lines.push(...modeLines(brief, paint));
	} else if (brief.summary.infrastructureErrors > 0) {
		lines.push(paint.warning(`  ${t("diagnosis.infrastructure", { errors: brief.summary.infrastructureErrors })}`));
	} else {
		lines.push(paint.success(`  ${t("diagnosis.healthy")}`));
	}
	lines.push(`${paint.dim(t("label.evidence"))} ${content.evidence.available ? paint.link(content.evidence.url) : paint.muted(t("diagnosis.no-explorer"))}`);
	if (options.next !== false) {
		const next = brief.proposalEligible
			? "diagnosis.next.fix"
			: brief.status === "healthy" ? "diagnosis.next.harder" : "diagnosis.next.repair";
		lines.push(`${paint.dim(t("label.next"))} ${t(next)}`);
	}
	return lines;
}

function resourceKind(kind: string): string {
	const key = `view.resource.${kind}`;
	return hasMessage(key) ? t(key) : kind;
}

/** Exact committed Target context: identity, execution policy, declared resources. */
export function renderTarget(content: WorkbenchTargetDetail, paint: Paint): string[] {
	if (!("target" in content)) {
		return [
			`${section(t("section.target"), paint)} ${paint.muted(t("view.target-missing"))}`,
			`${paint.dim(t("label.next"))} ${t("view.target-missing-next")}`,
		];
	}
	const execution = content.target.execution;
	const lines = [
		`${section(t("section.target"), paint)} ${paint.bold(oneLine(content.target.id, 60))} ${paint.dim(`@ ${shortSha(content.target.gitSha)}`)}`,
		`${paint.dim(t("label.model"))} ${oneLine(`${content.target.model.provider}/${content.target.model.id}`, 80)} ${paint.dim(`· ${t("view.thinking", { level: oneLine(content.target.model.thinkingLevel, 20) })}`)}`,
		`${paint.dim(t("view.execution"))} ${t("view.execution-shape", {
			tools: oneLine(execution.tools.join(", "), 60) || t("view.none"),
			network: oneLine(execution.network, 10),
			sandbox: oneLine(execution.sandbox, 20),
			env: oneLine(execution.environmentAllowlist.join(", "), 80) || t("view.none"),
		})}`,
		paint.dim(t("passport.resources")),
	];
	// The kind column is as wide as the widest word in the operator's language,
	// never a number chosen for English: a translated label that overflows a
	// fixed pad shifts every size on the screen one row at a time.
	const kindWidth = Math.max(
		16,
		...content.resources.map((resource) => resourceKind(resource.kind).length),
	);
	const resourceLine = (resource: TargetAuthoringResource): string =>
		`  ${paint.bold(oneLine(resource.path, 60).padEnd(40))} ${resourceKind(resource.kind).padEnd(kindWidth)} ${paint.dim(bytes(resource.bytes))}${resource.mode === "100755" ? paint.dim(t("view.executable")) : ""}`;
	for (const resource of content.resources) {
		if (resource.kind === "harness-file") continue;
		lines.push(resourceLine(resource));
	}
	// The files the manifest declares as the editable surface get their own
	// group: for a command Target they ARE the harness, and reading them mixed
	// into the canonical list left the Builder guessing which file it may edit.
	const harnessFiles = content.resources.filter((resource) => resource.kind === "harness-file");
	if (harnessFiles.length > 0) {
		lines.push(paint.dim(t("view.target.harness-files")));
		for (const resource of harnessFiles) lines.push(resourceLine(resource));
	}
	if (content.resource) {
		lines.push("", `${section(content.resource.path, paint)} ${paint.dim(`${resourceKind(content.resource.kind)} · ${bytes(content.resource.bytes)} · ${shortHash(content.resource.sha256)}`)}`);
		lines.push(...clean(content.resource.content).split("\n").map((line) => `  ${line}`));
	}
	if (content.priorAttempts && content.priorAttempts.length > 0) {
		lines.push("", paint.dim(t("section.already-tried")));
		for (const attempt of content.priorAttempts) {
			lines.push(`  ${attemptLine(attempt.outcome, attempt.changedPaths, attempt.development, attempt.sealed, attempt.reason, paint)}`);
		}
		if (content.priorAttemptsOmitted) {
			lines.push(`  ${paint.muted(t("view.attempts-not-shown", { attempts: plural(content.priorAttemptsOmitted, "earlier attempt") }))}`);
		}
	}
	lines.push(`${paint.dim(t("view.launch"))} ${paint.bold(content.launch)} ${paint.dim(t("view.launch-hint"))}`);
	return lines;
}

/** `rejected · AGENTS.md · improved -2.0pp · sealed fail · “3× the cost”`. */
function attemptLine(
	outcome: string,
	changedPaths: readonly string[],
	development: string,
	sealed: string | null,
	reason: string | null,
	paint: Paint,
): string {
	const tone = outcome === "promoted"
		? paint.success(outcome)
		: outcome === "rejected"
			? paint.warning(outcome)
			: paint.muted(outcome);
	const change = changedPaths.length > 0 ? oneLine(changedPaths.join(", "), 60) : "—";
	return joinNonEmpty([
		tone,
		change,
		oneLine(development, 40),
		sealed ? t("view.sealed-word", { verdict: oneLine(sealed, 20) }) : null,
		reason ? paint.dim(`“${oneLine(reason, 90)}”`) : null,
	], paint.dim(" · "));
}

/**
 * What was already tried on this Target, newest first. Reading it is how a
 * proposer stops re-running an experiment that has already lost.
 */
export function renderHistory(content: WorkbenchHistoryDetail, paint: Paint): string[] {
	if (content.attempts.length === 0) {
		return [
			`${section(t("section.already-tried"), paint)} ${paint.muted(t("view.history-empty"))}`,
		];
	}
	const lines = [
		`${section(t("section.already-tried"), paint)} ${plural(content.attempts.length, "attempt")}` +
			(content.omitted > 0 ? paint.dim(` ${t("view.older-not-shown", { count: content.omitted })}`) : "") +
			(content.unreadable > 0 ? paint.warning(` ${t("view.records-unreadable", { records: plural(content.unreadable, "record") })}`) : ""),
	];
	for (const attempt of content.attempts) {
		const development = attempt.development
			? `${attempt.development.verdict}${attempt.development.scoreDelta === null ? "" : ` ${points(attempt.development.scoreDelta)}`}`
			: t("growth.not-evaluated");
		lines.push(`  ${paint.dim(attempt.at.slice(0, 10))} ${attemptLine(attempt.outcome, attempt.changedPaths, development, attempt.sealed?.verdict ?? null, attempt.reason, paint)}`);
		if (attempt.failureModeIds.length > 0) {
			lines.push(`      ${paint.dim(t("view.aimed-at"))} ${oneLine(attempt.failureModeIds.join(", "), 90)}`);
		}
	}
	lines.push(paint.dim(t("view.never-rerun")));
	return lines;
}

/** One inbox file as the host reads it: shape first, then the rows it will map. */
export function renderDataset(content: WorkbenchDatasetDetail, paint: Paint): string[] {
	const preview = content.preview;
	const lines = [
		`${section(t("section.dataset"), paint)} ${paint.bold(oneLine(content.sourcePath, 56))} ${paint.dim("·")} ${oneLine(preview.format, 16)} ${paint.dim(`· ${bytes(preview.bytes)}`)}`,
		`${paint.dim(t("view.rows"))} ${plural(preview.rowCount, "row")} ${paint.dim("·")} ${plural(preview.columns.length, "column")}` +
			(preview.holdout
				? ` ${paint.dim("·")} ${paint.warning(t("view.reserved", { count: preview.holdout.reserved }))}`
				: ` ${paint.dim(t("view.nothing-sealed"))}`),
		paint.dim(t("view.columns")),
	];
	for (const column of preview.columns) {
		const samples = oneLine(column.samples.map((sample) => oneLine(sample, 22)).join(" · "), 72);
		lines.push(`  ${paint.bold(oneLine(column.name, 24).padEnd(24))} ${column.inferredType.padEnd(9)} ${samples || paint.muted("—")}`);
	}
	lines.push(paint.dim(t("view.propose-recipe")));
	return lines;
}

/** Leaf facts one card shows, and how wide a card line may get. */
const MAX_WORLD_FACTS = 3;
const WORLD_LINE_COLUMNS = 88;

/**
 * The world's state as an object again. `datasetCasePreview` hands it over as
 * bounded, redacted canonical JSON — a string, deliberately, because that is
 * what a human is shown — so a truncated one simply has no facts to read, and
 * the card says so instead of throwing at render time.
 */
function worldStateOf(sample: WorkbenchDatasetCase): Record<string, unknown> | null {
	if (!sample.world) return null;
	try {
		const parsed: unknown = JSON.parse(sample.world.state);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** `dotted.path=value` for the first few leaves, in the state's canonical order. */
function worldFacts(state: Record<string, unknown>): string[] {
	const facts: string[] = [];
	const walk = (value: unknown, path: string): void => {
		if (facts.length >= MAX_WORLD_FACTS) return;
		if (value !== null && typeof value === "object") {
			const entries: [string, unknown][] = Array.isArray(value)
				? value.map((item, index) => [String(index), item])
				: Object.entries(value);
			for (const [key, child] of entries) walk(child, path ? `${path}.${key}` : key);
			return;
		}
		facts.push(`${path}=${typeof value === "string" ? value : JSON.stringify(value)}`);
	};
	walk(state, "");
	return facts;
}

/** One expectation as a clause: `accounts.42.status equals "frozen"`. */
function worldClause(path: string, op: string, value: string | null): string {
	return op === "exists" ? `${path} exists` : `${path} ${op} ${value ?? "—"}`;
}

/**
 * One case as four lines: who is in the world, what is already true of it, what
 * they want, and what must be true when the conversation ends.
 *
 * A case without a world keeps exactly the lines it has always had — the world
 * card is a different reading of a different kind of case, not a redesign of
 * the old one. The first line carries no indent: `renderDatasetCases` puts the
 * case number in front of it.
 */
export function worldCardLines(sample: WorkbenchDatasetCase, paint: Paint): string[] {
	if (!sample.world) {
		const lines = [oneLine(sample.input, 92)];
		if (sample.expected !== null) lines.push(`      ${paint.dim(t("view.expected"))} ${oneLine(sample.expected, 88)}`);
		if (sample.messages) {
			const last = sample.messages[sample.messages.length - 1]?.content ?? "";
			lines.push(`      ${paint.dim(t("view.dialogue"))} ${plural(sample.messages.length, "turn")} ${paint.dim(t("view.dialogue-ending", { last: oneLine(last, 50) }))}`);
		}
		if (sample.simulatedUser) {
			const persona = sample.simulatedUser.persona ? t("view.live-user-as", { persona: oneLine(sample.simulatedUser.persona, 40) }) : "";
			lines.push(
				`      ${paint.dim(t("view.live-user"))} ${oneLine(sample.simulatedUser.goal, 60)}${persona} ` +
					paint.dim(t("view.live-user-turns", { turns: plural(sample.simulatedUser.maxTurns, "turn") })),
			);
		}
		if (sample.metadata) {
			const pairs = Object.entries(sample.metadata).slice(0, 4).map(([key, value]) => `${oneLine(key, 20)}=${oneLine(value, 24)}`);
			lines.push(`      ${paint.dim(t("view.metadata"))} ${oneLine(pairs.join(" · "), 88)}`);
		}
		lines.push(`      ${paint.dim(t("view.graders"))} ${oneLine(sample.graders.map(graderLabel).join(" · "), 89)}`);
		return lines;
	}
	const state = worldStateOf(sample);
	// The person in the world, then the person the case describes, then nobody.
	const named = state ? resolveWorldPath(state, "client.name") : { found: false, value: undefined };
	const who = typeof named.value === "string" && named.value.trim().length > 0
		? named.value
		: sample.simulatedUser?.persona ?? "—";
	const facts = state ? worldFacts(state) : [];
	const has = facts.length > 0 ? facts.join(" · ") : oneLine(sample.world.state, WORLD_LINE_COLUMNS);
	const wants = sample.simulatedUser?.goal ?? sample.input;
	// An expectation and the `world_state` grader it desugars into are the same
	// statement, so the card states each once, expectations first.
	const stated = new Set<string>();
	const must: string[] = [];
	for (const expectation of sample.world.expect ?? []) {
		const clause = worldClause(expectation.path, expectation.op, expectation.value);
		if (stated.has(clause)) continue;
		stated.add(clause);
		must.push(clause);
	}
	for (const grader of sample.graders) {
		if (grader.type !== "world_state") continue;
		const clause = worldClause(
			grader.path,
			grader.op,
			grader.value === undefined ? null : oneLine(JSON.stringify(grader.value) ?? "", 40),
		);
		if (stated.has(clause)) continue;
		stated.add(clause);
		must.push(clause);
	}
	for (const grader of sample.graders) {
		if (grader.type !== "world_state") must.push(graderLabel(grader));
	}
	return [
		`${paint.dim(t("view.world.who"))} ${oneLine(who, WORLD_LINE_COLUMNS)}`,
		`      ${paint.dim(t("view.world.has"))} ${oneLine(has, WORLD_LINE_COLUMNS)}`,
		`      ${paint.dim(t("view.world.wants"))} ${oneLine(wants, WORLD_LINE_COLUMNS)}`,
		`      ${paint.dim(t("view.world.must"))} ${oneLine(must.join(" · "), WORLD_LINE_COLUMNS)}`,
	];
}

/** The cases one proposed recipe produces, so a human argues with cases, not JSON. */
export function renderDatasetCases(cases: readonly WorkbenchDatasetCase[], paint: Paint): string[] {
	const lines: string[] = [];
	cases.forEach((sample, index) => {
		const [first, ...rest] = worldCardLines(sample, paint);
		lines.push(`  ${paint.dim(`${String(index + 1).padStart(2)}.`)} ${first ?? ""}`);
		lines.push(...rest);
	});
	return lines;
}

/** Status plus whichever exact detail the view carries. */
export function renderView(view: WorkbenchView, paint: Paint, options: RenderReviewOptions = {}): string[] {
	const status = renderStatus(view, paint);
	if (!view.detail) return status;
	const detail = view.detail.aspect === "review"
		? renderReview(view.detail.content, paint, options)
		: view.detail.aspect === "traces"
		// The status block above already ends with the next step.
		? renderTraces(view.detail.content, paint, { next: false })
		: view.detail.aspect === "dataset"
		? renderDataset(view.detail.content, paint)
		: view.detail.aspect === "history"
		? renderHistory(view.detail.content, paint)
		: renderTarget(view.detail.content, paint);
	return [...status, "", ...detail];
}

/** Title used by panels and tool cards for a detailed view. */
export function viewTitle(view: WorkbenchView): string {
	const panel = (detail: string): string => t("panel.title", { detail });
	if (!view.detail) return panel(stageLabel(view.stage));
	if (view.detail.aspect === "traces") return panel(t("panel.diagnosis"));
	if (view.detail.aspect === "target") return panel(t("panel.target"));
	if (view.detail.aspect === "history") return panel(t("panel.history"));
	if (view.detail.aspect === "dataset") return panel(t("panel.dataset"));
	switch (view.detail.content.kind) {
		case "spec-draft": return panel(t("panel.spec-review"));
		case "corpus-draft": return panel(t("panel.basket-review"));
		case "proposal": return panel(t("panel.proposal-review"));
		case "applied-proposal": return panel(t("panel.applied-proposal"));
		case "candidate": return panel(t("panel.candidate-review"));
		case "interrupted-candidate": return panel(t("panel.interrupted-candidate"));
		case "workflow": return panel(stageLabel(view.stage));
	}
}
