import type {
	WorkbenchCandidateSummary,
	WorkbenchImprovementBriefProjection,
	WorkbenchReviewDetail,
	WorkbenchTargetDetail,
	WorkbenchTracesDetail,
	WorkbenchView,
} from "../../workbench/types.js";
import { diffStats, renderUnifiedDiff } from "./diff.js";
import {
	bar,
	bullets,
	bytes,
	clean,
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
import type { Paint } from "./paint.js";
import { nextStep, stageLabel } from "./stage.js";

export interface RenderReviewOptions {
	maxDiffLines?: number;
	/** Task rows shown for a corpus draft before the list is folded. */
	maxTasks?: number;
}

function targetLine(view: WorkbenchView, paint: Paint): string {
	if (view.target.status === "missing") return `${paint.dim("Target")} ${paint.muted("not created yet")}`;
	const model = view.target.model;
	const modelText = view.target.status === "bootstrap-required" || !model
		? paint.warning("model not chosen")
		: `${oneLine(`${model.provider}/${model.id}`, 60)} ${model.credentialPresent ? paint.success("✓") : paint.warning(`(${oneLine(model.apiKeyEnv, 40)} missing)`)}`;
	return `${paint.dim("Target")} ${paint.bold(oneLine(view.target.id ?? "—", 60))} ${paint.dim(`@ ${shortSha(view.target.gitSha)}`)} ${paint.dim("·")} ${modelText}`;
}

function evidenceLine(view: WorkbenchView, paint: Paint): string {
	const counts = view.counts;
	return `${paint.dim("Evidence")} ${joinNonEmpty([
		pluralize(counts.developmentEvals, "eval run"),
		pluralize(counts.openProposals, "open proposal"),
		pluralize(counts.candidates, "candidate"),
		counts.sealedCorpora > 0 ? pluralize(counts.sealedCorpora, "sealed holdout") : null,
	])}`;
}

/** Compact status block used by /status and as the fallback for every panel. */
export function renderStatus(view: WorkbenchView, paint: Paint): string[] {
	const lines = [
		`${paint.accent(paint.bold("AHDE"))} ${paint.dim("·")} ${paint.bold(stageLabel(view.stage))}`,
		targetLine(view, paint),
		evidenceLine(view, paint),
		`${paint.dim("Next")} ${nextStep(view)}`,
	];
	if (view.blockers.length > 0) lines.push(`${paint.warning("Blocked")} ${view.blockers.map((item) => oneLine(item, 200)).join(" ")}`);
	if (view.warnings.length > 0) {
		lines.push(`${paint.warning("Warnings")}`);
		lines.push(...bullets(view.warnings, paint, { limit: 6, max: 200 }));
	}
	const selected = view.selections.filter((item) => item.selected);
	if (selected.length > 0) {
		lines.push(`${paint.dim("Selected")} ${selected.map((item) => `${item.kind} ${oneLine(item.label, 40)}`).join(paint.dim(" · "))}`);
	}
	return lines;
}

export interface HeaderState {
	view: WorkbenchView | null;
	builderModel: { label: string | null; credentialPresent: boolean };
	error?: string | null;
	previousSessions?: number;
}

/** Persistent header: identity, live stage, next step, evidence, and readiness. */
export function renderHeader(state: HeaderState, paint: Paint): string[] {
	const builder = state.builderModel.label
		? `${state.builderModel.label} ${state.builderModel.credentialPresent ? paint.success("✓") : paint.warning("· not connected — /login")}`
		: paint.warning("not connected — /login");
	const lines = ["", `${paint.accent(paint.bold("AHDE Builder"))} ${paint.dim("· build, evaluate, and improve another agent through evidence")}`];
	if (state.error) {
		lines.push(`${paint.error("Project state unavailable")} ${oneLine(state.error, 160)}`);
		lines.push(`${paint.dim("Builder model")} ${builder} ${paint.dim("· /doctor for recovery")}`);
		lines.push("");
		return lines;
	}
	const view = state.view;
	if (!view) {
		lines.push(`${paint.dim("Builder model")} ${builder}`, "");
		return lines;
	}
	lines.push(targetLine(view, paint));
	lines.push(`${paint.dim("Stage")} ${paint.bold(stageLabel(view.stage))} ${paint.dim("·")} ${paint.dim("Next")} ${nextStep(view)}`);
	lines.push(`${evidenceLine(view, paint)} ${paint.dim("·")} ${paint.dim("Builder model")} ${builder}`);
	if (view.blockers.length > 0 && view.stage !== "target-setup") {
		lines.push(`${paint.warning("Blocked")} ${oneLine(view.blockers.join(" "), 200)}`);
	}
	lines.push(paint.dim("Describe what you want in plain language · /help for shortcuts"));
	lines.push("");
	return lines;
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

function gateLine(gate: NonNullable<NonNullable<WorkbenchCandidateSummary["development"]>["gate"]>, paint: Paint): string {
	const tone = verdictTone(gate.verdict, paint);
	return `  ${paint.dim("Verdict")} ${tone(gate.verdict)} ${paint.dim("·")} ${points(gate.delta)} ${paint.dim(`(95% CI ${points(gate.confidence95.low)} … ${points(gate.confidence95.high)})`)} ${paint.dim(`· ${gate.tasks} × ${gate.repetitions}`)}` +
		(gate.flags.collapsedTasks > 0 ? ` ${paint.error(`· ${pluralize(gate.flags.collapsedTasks, "task")} collapsed`)}` : "");
}

function comparisonLines(
	summary: NonNullable<NonNullable<WorkbenchCandidateSummary["development"]>["comparison"]>,
	gate: NonNullable<WorkbenchCandidateSummary["development"]>["gate"],
	paint: Paint,
): string[] {
	const delta = summary.delta;
	const tone = delta > 0 ? paint.success : delta < 0 ? paint.error : paint.muted;
	const lines = [
		`${paint.dim("Development")} baseline ${percent(summary.baselinePassRate)} → candidate ${percent(summary.candidatePassRate)} ${tone(`(${points(delta)})`)} ${paint.dim(`on ${pluralize(summary.taskCount, "task")}`)}`,
		`  ${paint.success(`↑ ${summary.improved} improved`)} ${paint.dim("·")} ${summary.regressed > 0 ? paint.warning(`↓ ${summary.regressed} lower`) : paint.muted("↓ 0 lower")} ${paint.dim("·")} ${paint.muted(`= ${summary.unchanged} unchanged`)} ${paint.dim(`· 95% CI ${points(summary.confidence95.low)} … ${points(summary.confidence95.high)}`)}`,
	];
	if (gate) lines.push(gateLine(gate, paint));
	return lines;
}

export function renderCandidate(
	candidate: WorkbenchCandidateSummary & {
		adoption?: { receiptId: string; adoptedAt: string; branch: string } | null;
		continuation?: { receiptId: string; continuedAt: string } | null;
		impact?: Parameters<typeof renderImpact>[0];
	},
	paint: Paint,
	title = "Candidate",
): string[] {
	const statusTone = candidate.status === "promoted"
		? paint.success
		: candidate.status === "rejected" ? paint.error : paint.accent;
	const lines = [
		`${section(title, paint)} ${paint.dim(candidate.candidateId)} ${paint.dim("·")} ${statusTone(candidate.status)}`,
		`${paint.dim("Revision")} ${candidate.baseline.ref}@${shortSha(candidate.baseline.sha)} → ${candidate.candidate ? `${candidate.candidate.ref}@${shortSha(candidate.candidate.sha)}` : paint.muted("not built")}`,
	];
	if (candidate.development?.comparison) lines.push(...comparisonLines(candidate.development.comparison, candidate.development.gate, paint));
	else if (candidate.development) lines.push(`${paint.dim("Development")} ${paint.muted("comparison not reconstructable")}`);
	else lines.push(`${paint.dim("Development")} ${paint.muted("not evaluated yet")}`);
	const sealedGate = candidate.sealedHoldout.gate;
	lines.push(`${paint.dim("Sealed holdout")} ${candidate.sealedHoldout.executed
		? (sealedGate
			? `${verdictTone(sealedGate.verdict, paint)(sealedGate.verdict)} ${paint.dim("·")} ${points(sealedGate.delta)} ${paint.dim(`(95% CI ${points(sealedGate.confidence95.low)} … ${points(sealedGate.confidence95.high)}) · ${sealedGate.tasks} × ${sealedGate.repetitions}`)}`
			: (candidate.sealedHoldout.gatePassed ? paint.success("gate passed") : paint.error("legacy evidence — not promotable")))
		: paint.muted("not executed")}`);
	if (sealedGate && sealedGate.verdict !== "pass") lines.push(`  ${paint.muted(oneLine(sealedGate.reasons[0] ?? "", 160))}`);
	lines.push(...renderImpact(candidate.impact ?? null, paint));
	if (candidate.review) {
		const tone = candidate.review.recommendation === "promote" ? paint.success : paint.error;
		lines.push(`${paint.dim("Review")} ${tone(candidate.review.recommendation)} ${paint.dim("—")} ${oneLine(candidate.review.reason, 160)}`);
	}
	if (candidate.promotion) lines.push(`${paint.dim("Promoted")} ${paint.success(candidate.promotion.tag)} ${paint.dim(when(candidate.promotion.at))} ${paint.dim("—")} ${oneLine(candidate.promotion.reason, 120)}`);
	if (candidate.rejection) lines.push(`${paint.dim("Rejected")} ${paint.dim(when(candidate.rejection.at))} ${paint.dim("—")} ${oneLine(candidate.rejection.reason, 120)}`);
	if (candidate.adoption) lines.push(`${paint.dim("Adopted")} branch ${paint.bold(candidate.adoption.branch)} ${paint.dim(when(candidate.adoption.adoptedAt))}`);
	else if (candidate.status === "promoted") lines.push(`${paint.dim("Adopted")} ${paint.warning("not yet — /adopt fast-forwards the current branch")}`);
	if (candidate.continuation) lines.push(`${paint.dim("Cycle")} closed ${paint.dim(when(candidate.continuation.continuedAt))}`);
	return lines;
}

function renderSpec(content: Extract<WorkbenchReviewDetail, { kind: "spec-draft" }>, paint: Paint): string[] {
	const spec = content.spec;
	const list = (label: string, items: string[]): string[] => items.length === 0
		? [`${paint.dim(label.padEnd(15))} ${paint.muted("—")}`]
		: [paint.dim(label), ...bullets(items, paint, { limit: 10, max: 140 })];
	const lines = [
		`${section("Spec draft", paint)} ${paint.dim(content.id)}`,
		labeled(paint.dim("Title"), paint.bold(oneLine(spec.title, 120)), 15),
		paint.dim("Purpose"),
		...wrap(spec.purpose, 96, "  "),
		...list("Users", spec.users),
		...list("Jobs", spec.jobs),
		...list("Inputs", spec.inputs),
		...list("Allowed actions", spec.allowedActions),
		...list("Success criteria", spec.successCriteria),
		...list("Constraints", spec.constraints),
	];
	if (spec.openQuestions.length > 0) lines.push(paint.warning("Open questions"), ...bullets(spec.openQuestions, paint, { limit: 10, max: 140 }));
	lines.push(`${paint.dim("Snapshot")} ${paint.dim(shortHash(content.snapshotHash))}`);
	return lines;
}

function graderLabel(grader: { type: string } & Record<string, unknown>): string {
	switch (grader.type) {
		case "tool_called": return `tool ${String(grader.tool ?? grader.name ?? "?")}${grader.argsContains ? ` ∋ “${oneLine(String(grader.argsContains), 30)}”` : ""}`;
		case "output_contains": return `contains “${oneLine(String(grader.text ?? ""), 30)}”`;
		case "output_matches": return `matches /${oneLine(String(grader.pattern ?? ""), 30)}/`;
		case "judge": return `judge “${oneLine(String(grader.rubric ?? ""), 40)}”`;
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
		`${section("Eval basket draft", paint)} ${paint.bold(oneLine(content.name, 80))} ${paint.dim("·")} ${pluralize(content.tasks.length, "case")} ${paint.dim(`· ${content.id}`)}`,
	];
	if (content.importSource) lines.push(`${paint.dim("Imported from")} ${oneLine(String((content.importSource as { path?: unknown }).path ?? "imports/"), 120)}`);
	content.tasks.slice(0, maxTasks).forEach((task, index) => {
		const graders = (task.graders as ({ type: string } & Record<string, unknown>)[]).map(graderLabel).join(paint.dim(" · "));
		lines.push(`  ${paint.dim(`${String(index + 1).padStart(2)}.`)} ${oneLine(task.input, 96)}`);
		lines.push(`      ${paint.dim("graders:")} ${graders}`);
	});
	if (content.tasks.length > maxTasks) lines.push(`  ${paint.dim(`… +${content.tasks.length - maxTasks} more cases`)}`);
	if (content.coverageNotes.length > 0) lines.push(paint.dim("Coverage notes"), ...bullets(content.coverageNotes, paint, { limit: 8, max: 140 }));
	if (content.taskProvenance.length > 0) lines.push(`${paint.dim("Provenance")} ${pluralize(content.taskProvenance.length, "case")} bound to verified development failures`);
	lines.push(`${paint.dim("Draft")} ${paint.dim(shortHash(content.draftHash))} ${paint.dim("· Spec")} ${paint.dim(content.approvedSpec.specId)}`);
	return lines;
}

function renderProposal(
	content: Extract<WorkbenchReviewDetail, { kind: "proposal" | "applied-proposal" }>,
	paint: Paint,
	options: RenderReviewOptions,
): string[] {
	const stats = diffStats(content.exactDiff);
	const lines = [
		`${section(content.kind === "applied-proposal" ? "Applied proposal" : "Proposal", paint)} ${paint.dim(content.runId)}`,
		...wrap(content.summary, 96, "  "),
		`${paint.dim("Changes")} ${content.paths.map((path) => paint.bold(oneLine(path, 80))).join(paint.dim(", "))} ${paint.dim(`(${paint.added(`+${stats.added}`)} ${paint.removed(`-${stats.removed}`)})`)}`,
		`${paint.dim("Base")} ${shortSha(content.baseTargetSha)} ${paint.dim("· proposal")} ${paint.dim(shortHash(content.proposalHash))}`,
	];
	if (content.evidenceBasis) {
		lines.push(`${paint.dim("Evidence")} eval ${content.evidenceBasis.evalRunId} ${paint.dim("·")} ${pluralize(content.evidenceBasis.failureModes.length, "targeted failure mode")} ${paint.dim(`· ${pluralize(content.evidenceBasis.runRefs.length, "run reference")}`)}`);
	} else {
		lines.push(`${paint.dim("Evidence")} ${paint.muted("none linked (spec-only proposal)")}`);
	}
	if (content.risks.length > 0) lines.push(paint.warning("Risks"), ...bullets(content.risks, paint, { limit: 6, max: 160 }));
	if (content.validationPlan.length > 0) lines.push(paint.dim("Validation plan"), ...bullets(content.validationPlan, paint, { limit: 6, max: 160 }));
	if (content.kind === "applied-proposal") {
		lines.push(`${paint.dim("Applied")} branch ${paint.bold(content.application.branch)} ${paint.dim("·")} ${shortSha(content.application.baseTargetSha)} → ${shortSha(content.application.candidateSha)} ${paint.dim(when(content.application.appliedAt))}`);
	}
	lines.push(paint.dim("Diff"));
	lines.push(...renderUnifiedDiff(content.exactDiff, paint, { maxLines: options.maxDiffLines }));
	return lines;
}

/** Human rendering of the exact artifact under review. Never prints raw JSON. */
export function renderReview(content: WorkbenchReviewDetail, paint: Paint, options: RenderReviewOptions = {}): string[] {
	switch (content.kind) {
		case "spec-draft": return renderSpec(content, paint);
		case "corpus-draft": return renderCorpusDraft(content, paint, options);
		case "proposal":
		case "applied-proposal": return renderProposal(content, paint, options);
		case "candidate": return renderCandidate(content, paint);
		case "interrupted-candidate": return [
			...renderCandidate(content, paint, "Interrupted candidate"),
			paint.warning("Verification stopped before evidence was complete. /discard abandons this attempt so the applied proposal can be retried."),
		];
		case "workflow": return [`${section(stageLabel(content.stage), paint)}`, ...wrap(content.headline, 96, "  ")];
	}
}

function modeLines(brief: WorkbenchImprovementBriefProjection, paint: Paint): string[] {
	const lines: string[] = [];
	for (const mode of brief.modes) {
		const scope = mode.scope === "systemic" ? paint.warning("systemic") : paint.muted("task-local");
		const decision = mode.decision === "propose-harness-change"
			? (mode.selectableForProposal ? paint.success("→ propose fix") : paint.muted("→ not selectable"))
			: mode.decision === "stabilize-and-rerun" ? paint.warning("→ rerun to stabilize") : paint.error("→ repair evidence path");
		lines.push(`  ${paint.bold(`${mode.ordinal}.`)} ${paint.bold(oneLine(mode.title, 90))} ${paint.dim("—")} ${pluralize(mode.impact.affectedTasks, "task")} ${paint.dim(`(${Math.round(mode.impact.taskCoverageBps / 100)}% · reproduces ${Math.round(mode.impact.reproductionBps / 100)}%)`)}`);
		lines.push(`     ${scope} ${paint.dim("·")} ${mode.severity} ${paint.dim("·")} evidence ${mode.evidenceStrength} ${paint.dim("·")} ${decision}`);
		lines.push(...wrap(`Hypothesis: ${mode.hypothesis}`, 92, "     "));
		if (mode.suggestions[0]) lines.push(`     ${paint.dim("suggest:")} ${oneLine(mode.suggestions[0], 120)}`);
	}
	const hidden = brief.conversationProjection.omittedModes;
	if (hidden > 0) lines.push(`  ${paint.dim(`… +${hidden} more modes in the Evidence Explorer`)}`);
	return lines;
}

export function renderEvaluationSummary(
	evaluation: WorkbenchTracesDetail["evaluation"],
	paint: Paint,
): string {
	const summary = evaluation.summary;
	const tone = summary.error > 0 ? paint.warning : summary.fail === 0 ? paint.success : paint.accent;
	return `${tone(paint.bold(`${summary.pass}/${summary.total} passed`))} ${paint.dim(bar(summary.allPassRate, 16))} ${paint.dim(percent(summary.allPassRate))} ${paint.dim("·")} ${summary.fail > 0 ? paint.error(`${summary.fail} failed`) : paint.muted("0 failed")} ${paint.dim("·")} ${summary.error > 0 ? paint.warning(`${summary.error} errors`) : paint.muted("0 errors")} ${paint.dim(`· ${pluralize(evaluation.repetitions, "repetition")} · ${evaluation.evalRunId}`)}`;
}

/** Diagnosis screen shared by /traces and the post-run summary. */
export function renderTraces(content: WorkbenchTracesDetail, paint: Paint): string[] {
	const brief = content.improvementBrief;
	const lines = [
		`${section("Evaluation", paint)} ${renderEvaluationSummary(content.evaluation, paint)}`,
	];
	const status = brief.status === "actionable"
		? paint.success("actionable")
		: brief.status === "healthy" ? paint.success("healthy") : paint.warning("inconclusive");
	lines.push(`${paint.dim("Diagnosis")} ${status} ${paint.dim("·")} ${oneLine(brief.headline, 140)}`);
	if (brief.modes.length > 0) {
		lines.push(`${paint.dim("Failure modes")} ${paint.dim(`${brief.summary.systemicFailureModeCount} systemic · ${brief.summary.taskLocalFailureModeCount} task-local`)}`);
		lines.push(...modeLines(brief, paint));
	} else if (brief.summary.infrastructureErrors > 0) {
		lines.push(paint.warning(`  ${pluralize(brief.summary.infrastructureErrors, "infrastructure error")} made this run inconclusive; repair the evidence path and rerun.`));
	} else {
		lines.push(paint.success("  No failure modes: every development case passed."));
	}
	lines.push(`${paint.dim("Evidence")} ${content.evidence.available ? paint.link(content.evidence.url) : paint.muted("explorer link unavailable")}`);
	if (brief.proposalEligible) lines.push(`${paint.dim("Next")} say “fix the first problem” (or name a mode) to prepare an exact proposal`);
	else if (brief.status === "healthy") lines.push(`${paint.dim("Next")} add harder cases, or /run again to measure stability`);
	else lines.push(`${paint.dim("Next")} repair the inconclusive evidence path, then /run again`);
	return lines;
}

function resourceKind(kind: string): string {
	switch (kind) {
		case "instructions": return "instructions";
		case "skill": return "skill";
		case "tool-descriptor": return "tool descriptor";
		case "tool-executable": return "tool executable";
		default: return kind;
	}
}

/** Exact committed Target context: identity, execution policy, declared resources. */
export function renderTarget(content: WorkbenchTargetDetail, paint: Paint): string[] {
	if (!("target" in content)) {
		return [`${section("Target", paint)} ${paint.muted("not created yet")}`, `${paint.dim("Next")} describe the agent; the Builder scaffolds it (or run ${paint.bold(content.launch)})`];
	}
	const execution = content.target.execution;
	const lines = [
		`${section("Target", paint)} ${paint.bold(oneLine(content.target.id, 60))} ${paint.dim(`@ ${shortSha(content.target.gitSha)}`)}`,
		`${paint.dim("Model")} ${oneLine(`${content.target.model.provider}/${content.target.model.id}`, 80)} ${paint.dim(`· thinking ${oneLine(content.target.model.thinkingLevel, 20)}`)}`,
		`${paint.dim("Execution")} tools ${oneLine(execution.tools.join(", "), 60) || "none"} ${paint.dim("·")} network ${oneLine(execution.network, 10)} ${paint.dim("·")} sandbox ${oneLine(execution.sandbox, 20)} ${paint.dim("·")} env ${oneLine(execution.environmentAllowlist.join(", "), 80) || "none"}`,
		paint.dim("Resources"),
	];
	for (const resource of content.resources) {
		lines.push(`  ${paint.bold(oneLine(resource.path, 60).padEnd(40))} ${resourceKind(resource.kind).padEnd(16)} ${paint.dim(bytes(resource.bytes))}${resource.mode === "100755" ? paint.dim(" · executable") : ""}`);
	}
	if (content.resource) {
		lines.push("", `${section(content.resource.path, paint)} ${paint.dim(`${resourceKind(content.resource.kind)} · ${bytes(content.resource.bytes)} · ${shortHash(content.resource.sha256)}`)}`);
		lines.push(...clean(content.resource.content).split("\n").map((line) => `  ${line}`));
	}
	lines.push(`${paint.dim("Launch")} ${paint.bold(content.launch)} ${paint.dim("· talk to the built agent in its own isolated Pi")}`);
	return lines;
}

/** Status plus whichever exact detail the view carries. */
export function renderView(view: WorkbenchView, paint: Paint, options: RenderReviewOptions = {}): string[] {
	const status = renderStatus(view, paint);
	if (!view.detail) return status;
	const detail = view.detail.aspect === "review"
		? renderReview(view.detail.content, paint, options)
		: view.detail.aspect === "traces"
		? renderTraces(view.detail.content, paint)
		: renderTarget(view.detail.content, paint);
	return [...status, "", ...detail];
}

/** Title used by panels and tool cards for a detailed view. */
export function viewTitle(view: WorkbenchView): string {
	if (!view.detail) return `AHDE · ${stageLabel(view.stage)}`;
	if (view.detail.aspect === "traces") return "AHDE · Diagnosis";
	if (view.detail.aspect === "target") return "AHDE · Target";
	switch (view.detail.content.kind) {
		case "spec-draft": return "AHDE · Spec review";
		case "corpus-draft": return "AHDE · Eval basket review";
		case "proposal": return "AHDE · Proposal review";
		case "applied-proposal": return "AHDE · Applied proposal";
		case "candidate": return "AHDE · Candidate review";
		case "interrupted-candidate": return "AHDE · Interrupted candidate";
		case "workflow": return `AHDE · ${stageLabel(view.stage)}`;
	}
}
