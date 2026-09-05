import {
	MODEL_EXPERIMENT_MIN_TASKS,
	MODEL_EXPERIMENT_MIN_REPETITIONS,
	ModelChangeSubjectSchema,
	ModelExperimentPlanSchema,
	type ModelChangeReceipt,
	type ModelExperimentArm,
	type ModelExperimentPlan,
	type ModelExperimentRecord,
} from "../../application/model-experiment-types.js";
import { t } from "../../i18n.js";
import { money, oneLine, percent, points, shortSha, wrap } from "./format.js";
import { renderUnifiedDiff } from "./diff.js";
import type { Paint } from "./paint.js";
import type { WorkbenchRunInspection } from "../../workbench/run-inspection.js";
import { renderRunInspection } from "./run-inspection.js";

function modelName(model: { provider: string; id: string }): string {
	return oneLine(`${model.provider}/${model.id}`, 90);
}

function minimumEvidence(): string {
	return t("models.minimum", { cases: MODEL_EXPERIMENT_MIN_TASKS, repetitions: MODEL_EXPERIMENT_MIN_REPETITIONS });
}

function designLines(plan: ModelExperimentPlan, paint: Paint): string[] {
	return [
		paint.bold(t(`models.objective.${plan.objective}`)),
		t("models.design", { models: plan.models.length, cases: plan.taskIds.length, repetitions: plan.repetitions, executions: plan.plannedExecutions }),
		t("models.tolerance", { loss: points(-plan.qualityTolerance) }),
		paint.dim(`${oneLine(plan.targetId, 60)} @ ${shortSha(plan.baseSha)} · ${oneLine(plan.corpus.corpusId, 80)}`),
	];
}

function armLines(arm: ModelExperimentArm, paint: Paint): string[] {
	const label = arm.armId === "baseline" ? t("models.baseline") : t("models.alternative", { id: arm.armId });
	const lines = [
		`${paint.bold(label)} · ${modelName(arm.model)} · ${t(`models.status.${arm.status}`)}`,
		...wrap(`${t("models.quality", { score: arm.meanScore === null ? "—" : percent(arm.meanScore), rate: arm.passRate === null ? "—" : percent(arm.passRate) })} · ${t("models.resources", { cost: money(arm.targetCostUsd), latency: arm.meanLatencyMs === null ? "—" : t("models.seconds", { seconds: (arm.meanLatencyMs / 1_000).toFixed(2) }) })}`, 110, "  "),
	];
	if (arm.quality) {
		const { scoreDelta, confidence95 } = arm.quality.summary;
		lines.push(`  ${t("models.interval", { delta: points(scoreDelta), low: points(confidence95.low), high: points(confidence95.high) })}`);
		lines.push(`  ${arm.quality.withinTolerance ? paint.success(t("models.within")) : paint.warning(t("models.outside"))}`);
		for (const regression of arm.quality.regressions.slice(0, 5)) {
			lines.push(...wrap(t("models.regression", { task: oneLine(regression.taskId, 60), delta: points(regression.scoreDelta), before: oneLine(regression.baselineRunId, 48), after: oneLine(regression.candidateRunId, 48) }), 100, "  "));
		}
		const omitted = Math.max(0, arm.quality.regressions.length - 5) + arm.quality.omittedRegressions;
		if (omitted > 0) lines.push(`  ${paint.dim(t("models.more-regressions", { count: omitted }))}`);
	}
	if (arm.dominated !== null) lines.push(`  ${paint.dim(t(arm.dominated ? "models.dominated" : "models.frontier"))}`);
	if (arm.error) lines.push(...wrap(oneLine(arm.error, 400), 100, "  ").map((line) => paint.warning(line)));
	return lines;
}

export function modelExperimentHeadline(experiment: ModelExperimentRecord): string {
	const recommended = experiment.arms.find((arm) => arm.armId === experiment.recommendedArmId);
	return recommended
		? recommended.armId === "baseline"
			? t("models.keep", { model: modelName(recommended.model) })
			: t("models.recommend", { model: modelName(recommended.model), arm: recommended.armId })
		: `${t("models.title")} · ${t(`models.status.${experiment.status}`)}`;
}

/** Recorded Target resources are never presented as the experiment's whole bill. */
export function renderModelExperiment(experiment: ModelExperimentRecord, paint: Paint, options: { detailed?: boolean } = {}): string[] {
	const lines = [paint.bold(`${t("models.title")} · ${t(`models.status.${experiment.status}`)}`), ...designLines(experiment.plan, paint)];
	const baseline = experiment.arms.find((arm) => arm.armId === "baseline");
	for (const arm of experiment.arms) {
		lines.push("", ...armLines(arm, paint));
		const before = experiment.plan.objective === "cost" ? baseline?.targetCostUsd : baseline?.meanLatencyMs;
		const after = experiment.plan.objective === "cost" ? arm.targetCostUsd : arm.meanLatencyMs;
		if (arm.armId !== "baseline" && arm.status === "completed" && baseline?.status === "completed" && arm.meanScore !== null && baseline.meanScore !== null && typeof before === "number" && before > 0 && after !== null) {
			const change = (after / before - 1) * 100;
			lines.push(`  ${t(experiment.plan.objective === "cost" ? "models.cost-change" : "models.latency-change", { change: `${change > 0 ? "+" : ""}${change.toFixed(1)}%` })}`);
		}
	}
	const recommended = experiment.arms.find((arm) => arm.armId === experiment.recommendedArmId);
	lines.push("", recommended
		? paint.success(modelExperimentHeadline(experiment))
		: paint.muted(t(experiment.status === "completed" ? "models.no-recommendation" : "models.incomplete")),
		t("models.total", { cost: money(experiment.targetCostUsd) }),
		...(experiment.evaluatorOverhead === "none" ? [] : [paint.muted(t("models.overhead"))]),
		...(experiment.plan.taskIds.length < MODEL_EXPERIMENT_MIN_TASKS || experiment.plan.repetitions < MODEL_EXPERIMENT_MIN_REPETITIONS ? wrap(minimumEvidence(), 100).map((line) => paint.muted(line)) : []),
		...wrap(t("models.brief-limit"), 110).map((line) => paint.muted(line)),
		...(options.detailed ? [
			...(["models.selection-limit", "models.latency-limit", "models.rates-limit"] as const).flatMap((key) => wrap(t(key), 100).map((line) => paint.muted(line))),
			...(experiment.arms.some((arm) => arm.targetCostUsd === null) ? wrap(t("models.zero-rates"), 100).map((line) => paint.muted(line)) : []),
			...wrap(t("models.exploratory"), 100).map((line) => paint.muted(line)),
		] : []),
		paint.dim(experiment.id),
	);
	return lines;
}

export function renderModelExperiments(detail: { experiments: ModelExperimentRecord[]; selected: ModelExperimentRecord | null; selectedRun?: WorkbenchRunInspection }, paint: Paint): string[] {
	if (!detail.selected) return [paint.muted(t("models.empty"))];
	const lines = renderModelExperiment(detail.selected, paint, { detailed: true });
	if (detail.selectedRun) lines.push("", ...renderRunInspection(detail.selectedRun, paint));
	for (const experiment of detail.experiments) {
		if (experiment.id !== detail.selected.id) lines.push(paint.dim(`${experiment.id} · ${t(`models.status.${experiment.status}`)}`));
	}
	return lines;
}

export function renderModelAcceptance(receipt: ModelChangeReceipt, paint: Paint): string[] {
	return [
		paint.bold(t("models.accepted")),
		t("models.change", { before: modelName(receipt.subject.previousModel), after: modelName(receipt.subject.nextModel) }),
		paint.dim(`@ ${shortSha(receipt.configuredTargetSha)} · ${receipt.subject.experimentId} · ${receipt.subject.armId}`),
		...wrap(t("models.accept-next"), 100).map((line) => paint.muted(line)),
	];
}

export function renderModelExperimentConfirmation(subject: unknown, paint: Paint): string[] {
	const parsed = ModelExperimentPlanSchema.safeParse(subject);
	if (!parsed.success) return [paint.error(t("models.invalid-subject"))];
	const plan = parsed.data;
	return [
		...designLines(plan, paint),
		...plan.models.flatMap((arm) => [
			`${paint.bold(arm.armId === "baseline" ? t("models.baseline") : t("models.alternative", { id: arm.armId }))} · ${modelName(arm.model)}`,
			`  ${t("models.configuration", { thinking: arm.model.thinkingLevel, seconds: arm.model.timeoutMs / 1000 })}${Object.keys(arm.model.params).length > 0 ? ` · ${oneLine(JSON.stringify(arm.model.params), 1000)}` : ""}`,
			`  ${t("label.credential-env")} ${oneLine(arm.model.apiKeyEnv, 100)} · ${oneLine(arm.model.baseUrl, 160)}`,
		]),
		t("models.budget", { executions: plan.executionBudget }),
		...wrap(minimumEvidence(), 100).map((line) => paint.muted(line)),
		paint.muted(t("models.overhead")),
		...wrap(t("models.exploratory"), 100).map((line) => paint.muted(line)),
		paint.muted(t("models.no-switch")),
	];
}

export function renderModelAcceptanceConfirmation(subject: unknown, paint: Paint): string[] {
	const parsed = ModelChangeSubjectSchema.safeParse(subject);
	if (!parsed.success) return [paint.error(t("models.invalid-subject"))];
	const value = parsed.data;
	return [
		t("models.change", { before: modelName(value.previousModel), after: modelName(value.nextModel) }),
		paint.dim(`${oneLine(value.headRef, 100)} @ ${shortSha(value.baseSha)} · ${value.experimentId}`),
		...renderUnifiedDiff(value.diff, paint, { maxLines: 120, remainder: t("confirm.apply-remainder") }),
		...wrap(t("models.accept-note"), 100).map((line) => paint.warning(line)),
	];
}
