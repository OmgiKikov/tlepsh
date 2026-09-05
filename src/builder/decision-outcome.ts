import type { WorkbenchDecisionResult } from "../workbench/types.js";

/** Some operations return durable partial results instead of throwing on stop/failure. */
export function decisionExecutionOutcome(result: WorkbenchDecisionResult | null): "completed" | "stopped" | "failed" {
	if (!result) return "stopped";
	if (result.kind !== "model-experiment") return "completed";
	const status = result.result.experiment.status;
	return status === "running" ? "failed" : status;
}
