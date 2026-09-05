import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup } from "./fixtures.js";
import { gate, git, spec, targetPaths, task, PROJECT_ID } from "./helpers/cycle-fixtures.js";
import { createAhdeWorkbench, type AhdeWorkbenchDependencies } from "../src/workbench/workbench.js";
import { WorkbenchDecisionInputSchema, WorkbenchViewQuerySchema } from "../src/workbench/types.js";
import { loadTarget } from "../src/manifest.js";
import { assertWorkbenchDecisionStage } from "../src/workbench/transition-policy.js";

const created: string[] = [];
afterEach(() => { created.splice(0).forEach(cleanup); vi.unstubAllEnvs(); });
const input = {
	kind: "model-experiment" as const,
	models: [{ provider: "qwen-internal", modelId: "alternative" }],
	repetitions: 2, executionBudget: 4, qualityTolerance: 0.02,
	objective: "cost" as const, reason: "Measure cheaper models on the same approved cases",
};

async function ready() {
	vi.stubEnv("TEST_MODEL_KEY", "local-fixture-key");
	const paths = targetPaths(); created.push(paths.projectDir);
	const run = vi.fn<AhdeWorkbenchDependencies["runModelExperiment"]>(async () => { throw new Error("execution reached"); });
	const workbench = createAhdeWorkbench({ ...paths, projectId: PROJECT_ID, dependencies: { runModelExperiment: run } });
	await workbench.submit({ kind: "spec-draft", spec: spec() });
	await workbench.decide({ kind: "approve-spec", reason: "Approve intent" }, gate());
	await workbench.submit({ kind: "corpus-draft", name: "Reviewed basket", tasks: [task()], revisionSummary: "First cases" });
	await workbench.decide({ kind: "publish-corpus", reason: "Approve cases" }, gate());
	const resolveTargetModel = () => ({ ...loadTarget(paths.projectDir).manifest.model, id: "alternative" });
	return { ...paths, workbench, run, resolveTargetModel };
}

describe("model experiment operator boundary", () => {
	it("rejects credentials, endpoint overrides, unbounded alternatives and invented result input", () => {
		expect(WorkbenchDecisionInputSchema.parse(input)).toEqual(input);
		for (const altered of [
			{ ...input, models: [{ ...input.models[0], apiKeyEnv: "STOLEN_KEY" }] },
			{ ...input, models: [{ ...input.models[0], baseUrl: "https://unreviewed.invalid" }] },
			{ ...input, models: [...input.models, ...input.models, ...input.models] },
			{ ...input, executionBudget: 0 }, { ...input, qualityTolerance: -0.1 },
			{ ...input, qualityTolerance: 0.9 }, { ...input, recommendedArmId: "model-1" },
		]) expect(() => WorkbenchDecisionInputSchema.parse(altered)).toThrow();
		expect(() => WorkbenchViewQuerySchema.parse({ aspect: "target", experimentId: "foreign" })).toThrow();
	});

	it("cannot fund an experiment before the Spec and cases are reviewed", () => {
		for (const stage of ["target-setup", "spec-review", "corpus-review", "candidate-review", "complete"] as const) {
			expect(() => assertWorkbenchDecisionStage("model-experiment", stage)).toThrow();
			expect(() => assertWorkbenchDecisionStage("accept-model", stage)).toThrow();
		}
	});

	it("declining spends nothing and does not change the active agent", async () => {
		const fixture = await ready(); const approval = gate(false);
		const before = git(fixture.projectDir, "rev-parse", "HEAD");
		await expect(fixture.workbench.decide(input, approval, { resolveTargetModel: fixture.resolveTargetModel })).rejects.toThrow(/declin/i);
		expect(fixture.run).not.toHaveBeenCalled();
		expect(git(fixture.projectDir, "rev-parse", "HEAD")).toBe(before);
		expect((await fixture.workbench.view()).stage).toBe("ready-to-evaluate");
		const confirmation = approval.confirm.mock.calls[0]![0];
		expect(confirmation).toMatchObject({ kind: "model-experiment", policy: "consequential", estimate: { executions: 4, costUsd: null } });
		expect(confirmation.subject).toMatchObject({ plan: { baseSha: before, plannedExecutions: 4, qualityTolerance: 0.02, objective: "cost" } });
	});

	it("rejects an insufficient execution budget before asking or running", async () => {
		const fixture = await ready(); const approval = gate();
		await expect(fixture.workbench.decide({ ...input, executionBudget: 3 }, approval, { resolveTargetModel: fixture.resolveTargetModel })).rejects.toThrow(/budget|execution/i);
		expect(approval.confirm).not.toHaveBeenCalled(); expect(fixture.run).not.toHaveBeenCalled();
	});

	it("requires the host catalog before any authority or execution", async () => {
		const fixture = await ready(); const approval = gate();
		await expect(fixture.workbench.decide(input, approval)).rejects.toThrow(/trusted host model catalog/);
		expect(approval.confirm).not.toHaveBeenCalled(); expect(fixture.run).not.toHaveBeenCalled();
	});

	it("refuses a branch change even when the commit and files stayed identical", async () => {
		const fixture = await ready(); const approval = gate();
		approval.confirm.mockImplementation(async () => {
			git(fixture.projectDir, "checkout", "-qb", "same-files-other-authority");
			return { approved: true, actorId: "local:test" };
		});
		await expect(fixture.workbench.decide(input, approval, { resolveTargetModel: fixture.resolveTargetModel })).rejects.toThrow(/stale|changed/i);
		expect(fixture.run).not.toHaveBeenCalled();
	});

	it("refuses edited instructions while a dialog is open", async () => {
		const fixture = await ready(); const approval = gate();
		approval.confirm.mockImplementation(async () => {
			appendFileSync(join(fixture.projectDir, "AGENTS.md"), "\nChanged during review\n");
			return { approved: true, actorId: "local:test" };
		});
		await expect(fixture.workbench.decide(input, approval, { resolveTargetModel: fixture.resolveTargetModel })).rejects.toThrow(/clean|dirty|stale/i);
		expect(fixture.run).not.toHaveBeenCalled();
	});

	it("hands exactly the reviewed design and host actor to execution", async () => {
		const fixture = await ready(); const approval = gate();
		await expect(fixture.workbench.decide(input, approval, { resolveTargetModel: fixture.resolveTargetModel })).rejects.toThrow("execution reached");
		expect(approval.confirm).toHaveBeenCalledTimes(1);
		expect(fixture.run).toHaveBeenCalledTimes(1);
		const approvedPlan = (approval.confirm.mock.calls[0]![0].subject as { plan: unknown }).plan;
		expect(fixture.run.mock.calls[0]![0]).toMatchObject({ plan: approvedPlan, actorId: "local:test-human" });
	});
});
