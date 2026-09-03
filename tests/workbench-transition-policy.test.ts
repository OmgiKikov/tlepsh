import { describe, expect, it } from "vitest";
import { assertWorkbenchDecisionStage } from "../src/workbench/transition-policy.js";

describe("Workbench transition policy", () => {
	it("admits every consequential decision only at its declared stage", () => {
		for (const [kind, stages] of [
			["approve-spec", ["spec-review"]],
			// An applied proposal that was never measured invalidates nothing, so
			// the basket it will be measured on can still be published there.
			["publish-corpus", ["corpus-review", "candidate-verification"]],
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
			// The composites are legal exactly where a step of them is pending.
			["start-testing", ["spec-review", "corpus-review"]],
			["ship", ["candidate-review", "release-decision", "candidate-adoption", "complete"]],
		] as const) {
			for (const stage of stages) expect(() => assertWorkbenchDecisionStage(kind, stage)).not.toThrow();
		}
	});

	it("admits adoption exactly where a scaffold is admitted, and nowhere else", () => {
		expect(() => assertWorkbenchDecisionStage("wrap-target", "target-setup")).not.toThrow();
		expect(() => assertWorkbenchDecisionStage("scaffold-target", "target-setup")).not.toThrow();
		// The same one-way door as a scaffold: after it, there is a Target.
		expect(() => assertWorkbenchDecisionStage("wrap-target", "spec-design"))
			.toThrow(/wrap-target is not legal during spec-design/);
		expect(() => assertWorkbenchDecisionStage("wrap-target", "candidate-review"))
			.toThrow(/wrap-target is not legal during candidate-review/);
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
		expect(() => assertWorkbenchDecisionStage("start-testing", "ready-to-evaluate"))
			.toThrow(/start-testing is not legal during ready-to-evaluate/);
		expect(() => assertWorkbenchDecisionStage("ship", "candidate-verification"))
			.toThrow(/ship is not legal during candidate-verification/);
	});

	it("names the single unblocking action instead of the rule that blocked it", () => {
		expect(() => assertWorkbenchDecisionStage("ship", "improvement-authoring"))
			.toThrow(/Do this first: look at the failures, then say “fix it”\./);
		expect(() => assertWorkbenchDecisionStage("apply-proposal", "corpus-design"))
			.toThrow(/Do this first: ask the Builder for test cases\./);
	});
});
