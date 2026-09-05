type Bag = Record<string, unknown>;
function bag(value: unknown): Bag | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Bag : null;
}
function pick(value: Bag, keys: readonly string[]): Bag {
	return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));
}
function model(value: unknown): Bag | null {
	const source = bag(value);
	return source ? pick(source, ["provider", "id", "thinkingLevel", "timeoutMs"]) : null;
}
function experimentId(value: unknown): boolean {
	return typeof value === "string" && /^model-experiment-[0-9a-f]{24}$/.test(value);
}
function plan(value: Bag): Bag {
	return {
		...pick(value, ["id", "targetId", "baseSha", "headRef", "taskIds", "repetitions", "executionBudget", "plannedExecutions", "qualityTolerance", "objective"]),
		corpus: pick(bag(value.corpus) ?? {}, ["corpusId"]),
		models: Array.isArray(value.models) ? value.models.map((entry) => {
			const arm = bag(entry) ?? {};
			return { armId: arm.armId, model: model(arm.model) };
		}) : [],
	};
}

/** Runtime configuration stays host-side; recorded conversations stay verbatim. */
export function modelExperimentProjection(value: Bag): Bag | null {
	const studyPlan = bag(value.plan);
	if (studyPlan && experimentId(studyPlan.id) && Array.isArray(value.arms)) {
		return {
			...pick(value, ["id", "status", "startedAt", "finishedAt", "frontierArmIds", "recommendedArmId", "targetCostUsd", "evaluatorOverhead", "limitations"]),
			plan: plan(studyPlan),
			arms: value.arms.map((entry) => {
				const arm = bag(entry) ?? {};
				return { ...pick(arm, ["armId", "status", "evalRunId", "error", "runs", "passRate", "meanScore", "targetCostUsd", "meanLatencyMs", "meanTokens", "quality", "dominated"]), model: model(arm.model) };
			}),
		};
	}
	if (experimentId(value.id) && Array.isArray(value.models) && Array.isArray(value.taskIds)) return plan(value);
	if (experimentId(value.experimentId) && "previousModel" in value && "nextModel" in value) {
		return {
			...pick(value, ["experimentId", "armId", "baseSha", "headRef", "manifestPath"]),
			previousModel: model(value.previousModel), nextModel: model(value.nextModel),
			configurationOnly: true,
		};
	}
	return null;
}
