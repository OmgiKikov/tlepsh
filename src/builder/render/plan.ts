import { plural, t, verdictLabel } from "../../i18n.js";
import type {
	WorkbenchCandidateSummary,
	WorkbenchStage,
	WorkbenchView,
} from "../../workbench/types.js";
import { joinNonEmpty, oneLine, percent } from "./format.js";
import { blockerLines } from "./view.js";
import type { Paint } from "./paint.js";
import { stageLabel } from "./stage.js";

/**
 * The cycle as a checklist.
 *
 * Everything here is a projection of one Workbench view plus facts the host
 * already holds in memory: no artifact is written, no schema is added, and no
 * sealed content is ever named — the exam contributes a readiness state and a
 * minimum size, exactly as the header already shows it.
 *
 * The plan lands twice from this one compilation: as the `/plan` panel and as
 * the sticky widget above the editor. Both are bounded; the widget is capped at
 * {@link MAX_PLAN_WIDGET_LINES} lines because Pi renders no more.
 */

export const PLAN_STEP_IDS = [
	"spec",
	"harness",
	"tests",
	"exam",
	"baseline",
	"change",
	"verification",
	"release",
] as const;

export type PlanStepId = (typeof PLAN_STEP_IDS)[number];

/** Where one step stands: done, being worked on, still ahead, or stuck. */
export type PlanMarker = "done" | "current" | "ahead" | "blocked";

export const PLAN_MARKERS: Record<PlanMarker, string> = {
	done: "✓",
	current: "▸",
	ahead: "◻",
	blocked: "!",
};

export interface PlanStep {
	id: PlanStepId;
	marker: PlanMarker;
	/** Localized step name. */
	title: string;
	/** Localized one-line state; empty when the step has nothing to say yet. */
	detail: string;
	/** Localized sub-items: an open workshop, the verdicts, a running job. */
	items: string[];
}

export interface Plan {
	stage: WorkbenchStage;
	steps: PlanStep[];
	blockers: string[];
}

/**
 * What the view alone cannot carry. Every field is optional: the widget
 * compiles from the summary view, and `/plan` enriches the same compilation
 * with the aspects it read.
 */
export interface PlanFacts {
	/** Declared harness surface, from a Target-aspect view. */
	harness?: { tools: number; skills: number } | null;
	/** Cases in the published development basket. */
	cases?: number | null;
	/** Newest development evaluation. */
	baseline?: { pass: number; total: number } | null;
	/** An open workshop, from the host's own runtime state. */
	workshop?: { files: number; tries: number } | null;
	/** A background measurement that is running right now. */
	job?: { label: string; progress: string } | null;
}

const CURRENT_STEP: Record<WorkbenchStage, PlanStepId | null> = {
	"target-setup": "harness",
	"spec-design": "spec",
	"spec-review": "spec",
	"corpus-design": "tests",
	"corpus-review": "tests",
	"ready-to-evaluate": "baseline",
	"improvement-authoring": "change",
	"proposal-review": "change",
	"candidate-verification": "verification",
	"candidate-review": "release",
	"release-decision": "release",
	"candidate-adoption": "release",
	complete: "release",
	"selection-required": null,
};

/** `Support basket · 24 tasks` — the host's own selection label, read for its count. */
function publishedCases(view: WorkbenchView): number | null {
	for (const selection of view.selections) {
		if (selection.kind !== "development-corpus") continue;
		const match = /·\s*(\d{1,6})\s+tasks?\s*$/.exec(selection.label);
		if (match?.[1]) return Number(match[1]);
	}
	return null;
}

/** `18/24 passed` — the newest development eval, as the view already labels it. */
function newestEvaluation(view: WorkbenchView): { pass: number; total: number } | null {
	if (view.detail?.aspect === "traces") {
		const summary = view.detail.content.evaluation.summary;
		return { pass: summary.pass, total: summary.total };
	}
	for (const selection of view.selections) {
		if (selection.kind !== "eval-run") continue;
		const match = /^(\d{1,6})\/(\d{1,6})\b/.exec(selection.label);
		if (match?.[1] && match[2]) return { pass: Number(match[1]), total: Number(match[2]) };
	}
	return null;
}

function candidateOf(view: WorkbenchView): WorkbenchCandidateSummary | null {
	const detail = view.detail;
	if (detail?.aspect !== "review") return null;
	if (detail.content.kind === "candidate" || detail.content.kind === "interrupted-candidate") return detail.content;
	return null;
}

/** A candidate that has a branch: the change is on it, whatever happens next. */
function appliedBranch(view: WorkbenchView): string | null {
	const candidate = candidateOf(view);
	return candidate?.candidate?.ref ?? null;
}

function specStep(view: WorkbenchView): { done: boolean; detail: string } {
	if (view.counts.approvedSpecs > 0) return { done: true, detail: t("plan.spec.approved") };
	if (view.counts.specDrafts > 0) return { done: false, detail: t("plan.spec.draft") };
	return { done: false, detail: t("plan.none") };
}

function harnessStep(view: WorkbenchView, facts: PlanFacts): { done: boolean; detail: string } {
	if (view.target.status === "missing") return { done: false, detail: t("target.missing") };
	if (view.target.status === "bootstrap-required") return { done: false, detail: t("target.model-not-chosen") };
	const surface = facts.harness
		? `${plural(facts.harness.tools, "tool")} · ${plural(facts.harness.skills, "skill")}`
		: "";
	return { done: true, detail: joinNonEmpty([t("plan.harness.configured"), surface]) };
}

function testsStep(view: WorkbenchView, facts: PlanFacts): { done: boolean; detail: string } {
	const cases = facts.cases ?? publishedCases(view);
	const count = typeof cases === "number" ? plural(cases, "case") : "";
	if (view.counts.developmentCorpora > 0) return { done: true, detail: joinNonEmpty([t("plan.tests.published"), count]) };
	if (view.counts.corpusDrafts > 0) return { done: false, detail: joinNonEmpty([t("plan.tests.draft"), count]) };
	return { done: false, detail: t("plan.none") };
}

/**
 * The exam is a count and a readiness state, never an identity. This is the
 * same projection the header already shows, kept identical on purpose.
 */
function examStep(view: WorkbenchView): { done: boolean; detail: string } {
	const readiness = view.shippingReadiness;
	if (!readiness) return { done: false, detail: t("plan.none") };
	if (readiness.sealedHoldout === "ready") return { done: true, detail: t("plan.exam.ready") };
	return {
		done: false,
		detail: readiness.sealedHoldout === "missing"
			? t("ship-gate.missing")
			: readiness.sealedHoldout === "underpowered"
				? t("ship-gate.underpowered", { minimum: readiness.minimumTasks })
				: t("ship-gate.unavailable"),
	};
}

function baselineStep(view: WorkbenchView, facts: PlanFacts): { done: boolean; detail: string } {
	const evaluation = facts.baseline ?? newestEvaluation(view);
	if (!evaluation || evaluation.total === 0) {
		return { done: view.counts.developmentEvals > 0, detail: view.counts.developmentEvals > 0 ? t("plan.baseline.recorded") : t("plan.baseline.none") };
	}
	return {
		done: true,
		detail: t("plan.baseline.rate", {
			pass: evaluation.pass,
			total: evaluation.total,
			percent: percent(evaluation.pass / evaluation.total),
		}),
	};
}

function changeStep(view: WorkbenchView, facts: PlanFacts): { done: boolean; detail: string; items: string[] } {
	const items: string[] = [];
	if (facts.workshop) {
		items.push(t("plan.workshop", {
			files: plural(facts.workshop.files, "file"),
			tries: plural(facts.workshop.tries, "try"),
		}));
	}
	const branch = appliedBranch(view);
	if (branch) return { done: true, detail: t("plan.change.applied", { branch: oneLine(branch, 60) }), items };
	if (view.counts.openProposals > 0) return { done: true, detail: t("plan.change.open"), items };
	if (view.counts.candidates > 0) return { done: true, detail: t("plan.change.applied-unknown"), items };
	return { done: false, detail: t("plan.none"), items };
}

function verificationStep(view: WorkbenchView): { done: boolean; detail: string; items: string[] } {
	const candidate = candidateOf(view);
	const development = candidate?.development?.gate?.verdict ?? null;
	const sealed = candidate?.sealedHoldout.gate?.verdict ?? null;
	const items: string[] = [];
	if (development) items.push(t("plan.verification.development", { verdict: verdictLabel(development) }));
	if (candidate?.sealedHoldout.executed) {
		items.push(t("plan.verification.sealed", {
			verdict: sealed ? verdictLabel(sealed) : verdictLabel(candidate.sealedHoldout.gatePassed ? "pass" : "fail"),
		}));
	}
	if (items.length > 0) return { done: true, detail: t("plan.verification.measured"), items };
	if (candidate) return { done: false, detail: t("plan.verification.none"), items };
	return { done: false, detail: t("plan.none"), items };
}

function releaseStep(view: WorkbenchView): { done: boolean; detail: string } {
	const candidate = candidateOf(view);
	if (candidate?.promotion) return { done: true, detail: oneLine(candidate.promotion.tag, 40) };
	if (candidate?.rejection) return { done: false, detail: t("plan.release.rejected") };
	return { done: false, detail: t("plan.release.none") };
}

/**
 * Derive the cycle from the view. Pure: the same view and facts always compile
 * to the same plan, which is what makes the widget cheap to refresh.
 */
export function compilePlan(view: WorkbenchView, facts: PlanFacts = {}): Plan {
	const current = CURRENT_STEP[view.stage] ?? null;
	const blocked = view.blockers.length > 0;
	const parts: Record<PlanStepId, { done: boolean; detail: string; items?: string[] }> = {
		spec: specStep(view),
		harness: harnessStep(view, facts),
		tests: testsStep(view, facts),
		exam: examStep(view),
		baseline: baselineStep(view, facts),
		change: changeStep(view, facts),
		verification: verificationStep(view),
		release: releaseStep(view),
	};
	const steps = PLAN_STEP_IDS.map((id): PlanStep => {
		const part = parts[id];
		const isCurrent = id === current;
		const items = [...(part.items ?? [])];
		if (isCurrent && facts.job) {
			items.push(t("plan.job", { label: oneLine(facts.job.label, 40), progress: oneLine(facts.job.progress, 40) }));
		}
		return {
			id,
			marker: isCurrent ? (blocked ? "blocked" : "current") : part.done ? "done" : "ahead",
			title: t(`plan.step.${id}`),
			detail: oneLine(part.detail, 90),
			items: items.map((item) => oneLine(item, 90)),
		};
	});
	return {
		stage: view.stage,
		steps,
		blockers: blockerLines(view).map((blocker) => oneLine(blocker, 160)),
	};
}

function paintMarker(marker: PlanMarker, paint: Paint): string {
	const glyph = PLAN_MARKERS[marker];
	switch (marker) {
		case "done": return paint.success(glyph);
		case "current": return paint.accent(glyph);
		case "blocked": return paint.warning(glyph);
		default: return paint.dim(glyph);
	}
}

/** The `/plan` panel: every step, its state, and whatever hangs under it. */
export function renderPlan(plan: Plan, paint: Paint): string[] {
	const lines: string[] = [];
	for (const step of plan.steps) {
		const title = step.marker === "ahead" ? paint.muted(step.title) : paint.bold(step.title);
		lines.push(`${paintMarker(step.marker, paint)} ${title}${step.detail ? ` ${paint.dim("·")} ${paint.dim(step.detail)}` : ""}`);
		for (const item of step.items) lines.push(`    ${paint.dim("└")} ${paint.muted(item)}`);
	}
	if (plan.blockers.length > 0) {
		lines.push(`${paint.warning(t("label.blocked"))} ${plan.blockers.join(" ")}`);
	}
	return lines;
}

/** Phases already behind the operator. */
export function planProgress(plan: Plan): { done: number; total: number } {
	return {
		done: plan.steps.filter((step) => step.marker === "done").length,
		total: plan.steps.length,
	};
}

/**
 * `Plan 3/8 · ▸ Candidate verification` — the whole cycle in the one line the
 * persistent header can afford. It is the same compilation the `/plan` panel
 * renders, folded to a count and the phase the operator is standing in.
 */
export function planHeadline(plan: Plan): string {
	const progress = planProgress(plan);
	const current = plan.steps.find((step) => step.marker === "current" || step.marker === "blocked");
	return oneLine(t("plan.header", {
		done: progress.done,
		total: progress.total,
		marker: PLAN_MARKERS[current?.marker ?? "ahead"],
		step: stageLabel(plan.stage),
	}), 90);
}
