import { describe, expect, it } from "vitest";
import { assertWorkbenchDecisionStage } from "../src/workbench/transition-policy.js";

describe("Workbench transition policy", () => {
	it("admits every consequential decision only at its declared stage", () => {
		for (const [kind, stages] of [
			["approve-spec", ["spec-review"]],
			["publish-corpus", ["corpus-review"]],
			["run-eval", ["ready-to-evaluate", "improvement-authoring"]],
			["calibrate", ["ready-to-evaluate", "improvement-authoring"]],
			["apply-proposal", ["proposal-review"]],
			["discard-proposal", ["proposal-review"]],
			["verify-candidate", ["candidate-verification"]],
			["abandon-candidate", ["candidate-verification"]],
			["review-candidate", ["candidate-review"]],
			["promote-candidate", ["release-decision"]],
			["reject-candidate", ["release-decision"]],
			["adopt-candidate", ["candidate-adoption"]],
			["continue-cycle", ["complete"]],
		] as const) {
			for (const stage of stages) expect(() => assertWorkbenchDecisionStage(kind, stage)).not.toThrow();
		}
	});

	it("fails closed before a decision handler can run at another stage", () => {
		expect(() => assertWorkbenchDecisionStage("apply-proposal", "spec-review"))
			.toThrow(/apply-proposal is not legal during spec-review/);
		expect(() => assertWorkbenchDecisionStage("promote-candidate", "candidate-verification"))
			.toThrow(/promote-candidate is not legal during candidate-verification/);
		expect(() => assertWorkbenchDecisionStage("adopt-candidate", "release-decision"))
			.toThrow(/adopt-candidate is not legal during release-decision/);
		expect(() => assertWorkbenchDecisionStage("continue-cycle", "candidate-adoption"))
			.toThrow(/continue-cycle is not legal during candidate-adoption/);
		expect(() => assertWorkbenchDecisionStage("calibrate", "candidate-verification"))
			.toThrow(/calibrate is not legal during candidate-verification/);
	});
});
