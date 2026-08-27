import { describe, expect, it } from "vitest";
import { assertWorkbenchDecisionStage } from "../src/workbench/transition-policy.js";

describe("Workbench transition policy", () => {
	it("admits every consequential decision only at its declared stage", () => {
		for (const [kind, stages] of [
			["approve-spec", ["spec-review"]],
			["publish-corpus", ["corpus-review"]],
			["run-eval", ["ready-to-evaluate", "improvement-authoring"]],
			["apply-proposal", ["proposal-review"]],
			["discard-proposal", ["proposal-review"]],
			["verify-candidate", ["candidate-verification"]],
			["abandon-candidate", ["candidate-verification"]],
			["review-candidate", ["candidate-review"]],
			["promote-candidate", ["release-decision"]],
			["reject-candidate", ["release-decision"]],
		] as const) {
			for (const stage of stages) expect(() => assertWorkbenchDecisionStage(kind, stage)).not.toThrow();
		}
	});

	it("fails closed before a decision handler can run at another stage", () => {
		expect(() => assertWorkbenchDecisionStage("apply-proposal", "spec-review"))
			.toThrow(/apply-proposal is not legal during spec-review/);
		expect(() => assertWorkbenchDecisionStage("promote-candidate", "candidate-verification"))
			.toThrow(/promote-candidate is not legal during candidate-verification/);
	});
});
