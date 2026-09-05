import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTargetModelSelection } from "../src/application/target-model-selection.js";
import { ModelExperimentPlanSchema, ModelChangeSubjectSchema, type ModelExperimentRecord } from "../src/application/model-experiment-types.js";
import { modelExperimentCatalog, modelExperimentResolver } from "../src/builder/model-experiment-models.js";
import { createBuilderWorkbenchTools, projectForModel } from "../src/builder/workbench-adapter.js";
import { renderModelExperiment, renderModelAcceptance } from "../src/builder/render/model-experiment.js";
import { renderConfirmation } from "../src/builder/render/confirmation.js";
import { renderDecision } from "../src/builder/render/decision.js";
import { renderView, viewTitle } from "../src/builder/render/view.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { builderDecisionPresentation } from "../src/builder/decision-presentation.js";
import { judgeComparison } from "../src/domain/comparison-gate.js";
import { setLanguage } from "../src/i18n.js";
import { hashValue } from "../src/provenance.js";
import type { AhdeWorkbench } from "../src/workbench/workbench.js";
import type { WorkbenchView } from "../src/workbench/types.js";
import { RUN_INSPECTION_LIMITS } from "../src/workbench/run-inspection.js";

const PROVIDER = "experiment-fixture";
const ENV = "MODEL_EXPERIMENT_FIXTURE_KEY";
const selection = (modelId: string) => ({ provider: PROVIDER, modelId });
function catalogModel(id = "current"): Model<Api> {
	return { provider: PROVIDER, id, name: id, api: "openai-completions", baseUrl: "http://127.0.0.1:43199/v1", reasoning: false, input: ["text"], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 4096 };
}
function host(input = vi.fn(async () => ENV)) {
	return {
		hasUI: true, mode: "tui", ui: { input, confirm: vi.fn(async () => true), notify: vi.fn() },
		modelRegistry: { find: vi.fn((_provider: string, id: string) => catalogModel(id)), getAvailable: vi.fn(() => [catalogModel("cheap")]), hasConfiguredAuth: vi.fn(() => true) },
	} as unknown as ExtensionContext;
}
function record(): ModelExperimentRecord {
	const models = ["current", "cheap"].map((id, index) => {
		const model = resolveTargetModelSelection(selection(id), catalogModel(id), { apiKeyEnv: ENV });
		return { armId: index === 0 ? "baseline" : "model-1", model, modelHash: hashValue(model) };
	});
	const identity = { schemaVersion: 1, id: `model-experiment-${"a".repeat(24)}`, targetDir: "/tmp/agent", targetId: "agent", baseSha: "a".repeat(40), headRef: "refs/heads/main", manifestHash: hashValue("manifest"), harnessHash: hashValue("harness"), corpus: { stateRoot: "/tmp/state", projectId: "project", corpusId: "cases" }, corpusHash: hashValue("corpus"), datasetHash: hashValue("dataset"), suiteHash: hashValue("suite"), taskIds: ["case-1", "case-2"], models, repetitions: 3, executionBudget: 12, plannedExecutions: 12, qualityTolerance: 0.02, objective: "cost" };
	const bound = { ...identity, runsRoot: "/tmp/runs" };
	const plan = ModelExperimentPlanSchema.parse({ ...bound, planHash: hashValue(bound) });
	const compared = judgeComparison([{ taskId: "case-1", aPassRate: 1, bPassRate: 0, delta: -1, aScore: 1, bScore: 0, scoreDelta: -1, aStatus: "ok", bStatus: "ok", aPass: 3, aTotal: 3, bPass: 0, bTotal: 3 }], { surface: "development", repetitions: 3, seed: "fixture" });
	return {
		id: plan.id, plan, status: "completed", startedAt: "2026-09-05T00:00:00Z", finishedAt: "2026-09-05T00:01:00Z",
		arms: plan.models.map((arm, index) => ({ ...arm, status: "completed", evalRunId: `eval-${index}`, error: null, runs: 6, passRate: index === 0 ? 1 : 0.5, meanScore: index === 0 ? 1 : 0.5, targetCostUsd: index === 0 ? 0.12 : null, meanLatencyMs: index === 0 ? 2000 : 1000, meanTokens: 100, quality: index === 0 ? null : { verdict: "regressed", summary: compared.summary, design: compared.design, withinTolerance: false, regressions: [], omittedRegressions: 0 }, dominated: null })),
		frontierArmIds: [], recommendedArmId: null, targetCostUsd: null, evaluatorOverhead: "unverified", limitations: [],
	};
}
function view(experiment = record()): WorkbenchView {
	return {
		schemaVersion: 1, project: { id: "project", directory: "/tmp/project" }, stage: "ready-to-evaluate", headline: "Ready",
		target: { status: "ready", id: "agent", gitSha: "a".repeat(40), model: { provider: PROVIDER, id: "current", apiKeyEnv: ENV, credentialPresent: true } },
		focus: {}, selections: [], actions: [], blockers: [], warnings: [], calibration: null,
		counts: { specDrafts: 0, approvedSpecs: 1, corpusDrafts: 0, developmentCorpora: 1, sealedCorpora: 0, developmentEvals: 0, openProposals: 0, candidates: 0, calibrations: 0 },
		detail: { aspect: "models", content: { experiments: [experiment], selected: experiment } },
	};
}
afterEach(() => { delete process.env[ENV]; delete process.env.EXPERIMENT_FIXTURE_API_KEY; setLanguage(null); });

describe("model experiments in the terminal", () => {
	it("shows exact measurements, failed tolerance and unknown cost without inventing savings, in both languages", () => {
		for (const language of ["en", "ru"] as const) {
			setLanguage(language);
			const experiment = record();
			const rendered = renderModelExperiment(experiment, plainPaint).join("\n");
			expect(rendered).toContain(`${PROVIDER}/cheap`);
			expect(rendered).toContain("$0.12");
			expect(rendered).not.toContain("$0.00");
			expect(rendered).toContain("95%");
			expect(rendered).toMatch(language === "en" ? /does not establish the declared tolerance/ : /недостаточно, чтобы подтвердить заданный допуск/);
			expect(rendered).toMatch(language === "en" ? /additional and not fully verified/ : /дополнительно и здесь проверены не полностью/);
			expect(rendered).not.toContain(ENV);
			expect(renderView(view(experiment), plainPaint).join("\n")).toContain("95%");
			expect(viewTitle(view(experiment))).toContain(language === "en" ? "Compare agent models" : "Сравнение моделей агента");
		}
	});

	it("renders the exact bounded experiment in the host confirmation and preserves its no-switch result", () => {
		const experiment = record();
		const lines = renderConfirmation({ kind: "model-experiment", title: "Compare", reason: "Lower cost", subject: { plan: experiment.plan }, subjectHash: hashValue(experiment.plan), policy: "consequential", question: "Run?" }, plainPaint).join("\n");
		expect(lines).toContain("2 models × 2 cases × 3 repetitions = 12 executions");
		expect(lines).toContain("Allowed score change: ≥ -2 pts");
		expect(lines).toContain("Execution limit: 12; this is not a dollar cap");
		expect(lines).toContain(ENV);
		const result = { kind: "model-experiment" as const, result: { experiment }, view: view(experiment), message: "Measured" };
		expect(renderDecision(result, plainPaint).join("\n")).toContain("active agent model has not changed");
		expect(JSON.stringify(projectForModel(result))).not.toMatch(/apiKeyEnv|MODEL_EXPERIMENT_FIXTURE_KEY/);
	});

	it("keeps a winning baseline, unfinished experiments and regression evidence distinct", () => {
		const experiment = record();
		experiment.recommendedArmId = "baseline";
		expect(renderModelExperiment(experiment, plainPaint).join("\n")).toContain("Keep the current model");
		experiment.recommendedArmId = null;
		experiment.status = "stopped";
		expect(renderModelExperiment(experiment, plainPaint).join("\n")).toContain("experiment is unfinished");
		const alternative = experiment.arms[1]!;
		alternative.quality!.regressions = [{ taskId: "case-1", scoreDelta: -0.5, baselineRunId: "baseline-answer", candidateRunId: "alternative-answer" }];
		alternative.quality!.omittedRegressions = 2;
		const details = view(experiment);
		if (details.detail?.aspect !== "models") throw new Error("expected model view");
		details.detail.content.selectedRun = {
			evalRunId: "eval-1", runId: "alternative-answer", taskId: "case-1", repetitionIndex: 0,
			target: { id: "agent", gitSha: "a".repeat(40) }, status: "completed", outcome: "fail",
			transcript: { entries: [{ kind: "user", text: "Read this exact request", at: null }], truncated: false, omittedCount: 0 }, checks: [],
			limitations: { recordedDataOnly: true, reasoningOmitted: true, traceAvailable: true, omittedChecks: 0, checkTextClipped: false, limits: RUN_INSPECTION_LIMITS },
		};
		const rendered = renderView(details, plainPaint).join("\n");
		expect(rendered).toContain("baseline-answer → alternative-answer");
		expect(rendered).toContain("2 additional regressions");
		expect(rendered).toContain("Read this exact request");
	});

	it("reports measured objective savings, omits absent evaluator overhead and avoids savings from partial arms", () => {
		const experiment = record();
		experiment.plan.taskIds = Array.from({ length: 15 }, (_, index) => `case-${index}`);
		experiment.arms[1]!.targetCostUsd = 0.06;
		experiment.evaluatorOverhead = "none";
		const measured = renderModelExperiment(experiment, plainPaint).join("\n");
		expect(measured).toContain("Observed Target cost vs current: -50.0%");
		expect(measured).not.toContain("costs are additional");
		expect(measured).not.toContain("A recommendation needs at least");
		expect(measured).toContain("no independent confirmation or release");
		experiment.arms[1]!.meanScore = null;
		expect(renderModelExperiment(experiment, plainPaint).join("\n")).not.toContain("Observed Target cost vs current");
	});

	it.each([ ["stopped", "warning", "■"], ["failed", "error", "✗"] ] as const)("presents retained %s results without a success card", async (status, tone, marker) => {
		const experiment = record();
		experiment.status = status;
		const current = view(experiment);
		const workbench = { view: async () => current } as unknown as AhdeWorkbench;
		const result = { kind: "model-experiment" as const, result: { experiment }, view: current, message: "Saved partial results" };
		const presentation = await builderDecisionPresentation(result, { workbench, source: "model-experiment" });
		expect(presentation.block.tone).toBe(tone);
		expect(presentation.block.lines.join("\n")).toContain("experiment is unfinished");
		const tool = createBuilderWorkbenchTools(workbench, () => "local:operator").find((entry) => entry.name === "ahde_workbench_decide")!;
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const card = tool.renderResult!({ content: [], details: result }, { expanded: false, isPartial: false }, theme as never, { isError: false } as never);
		expect(card.render(120).join("\n")).toContain(marker);
		expect(card.render(120).join("\n")).not.toContain("✓");
	});

	it("shows the exact acceptance diff, active revision and release qualification", () => {
		const experiment = record();
		const identity = { schemaVersion: 1, experimentId: experiment.id, armId: "model-1", experimentHash: hashValue(experiment), targetDir: "/tmp/agent", baseSha: "a".repeat(40), headRef: "refs/heads/main", manifestPath: "manifest.yaml", beforeManifestHash: hashValue("before"), afterManifestHash: hashValue("after"), previousModel: experiment.plan.models[0]!.model, nextModel: experiment.plan.models[1]!.model, diff: "--- a/manifest.yaml\n+++ b/manifest.yaml\n@@ -1 +1 @@\n-id: current\n+id: cheap\n" };
		const subject = ModelChangeSubjectSchema.parse({ ...identity, subjectHash: hashValue(identity) });
		const receipt = { schemaVersion: 1 as const, id: "change-1", subject, configuredTargetSha: "b".repeat(40), actorId: "local:operator", reason: "Lower cost", configuredAt: "2026-09-05T00:02:00Z" };
		const confirmation = renderConfirmation({ kind: "accept-model", title: "Change", reason: receipt.reason, subject, subjectHash: subject.subjectHash, policy: "consequential", question: "Change?" }, plainPaint).join("\n");
		expect(confirmation).toContain("-id: current");
		expect(confirmation).toContain("+id: cheap");
		expect(confirmation).toContain("not a validated release");
		expect(renderModelAcceptance(receipt, plainPaint).join("\n")).toContain("bbbbbbb");
		expect(JSON.stringify(projectForModel(receipt))).not.toContain("-id: current");
	});

	it("keeps legacy runtime metadata out of model context without erasing actual run evidence or human details", () => {
		const experiment = record();
		const current = experiment.plan.models[0]!.model;
		current.params = { nested: { legacyCredential: "opaque-runtime-secret" } };
		current.baseUrl = "https://example.test/private-endpoint";
		const original = JSON.stringify(experiment);
		experiment.arms[1]!.quality!.regressions = [{ taskId: "case-1", scoreDelta: -0.5, baselineRunId: "recorded-before", candidateRunId: "recorded-after" }];
		const selectedRun = { transcript: { entries: [{ kind: "user", text: "Actual observable statement" }] } };
		const projected = JSON.stringify(projectForModel({ experiment, selectedRun }));
		expect(projected).not.toMatch(/opaque-runtime-secret|private-endpoint|apiKeyEnv|"params"|"spec"/);
		expect(projected).toContain("recorded-after");
		expect(projected).toContain("Actual observable statement");
		expect(JSON.stringify(experiment)).toContain("opaque-runtime-secret");
		expect(original).toContain("private-endpoint");
	});

	it("asks once per provider, freezes host metadata, and refuses unrequested selections", async () => {
		const first = catalogModel("cheap");
		const second = catalogModel("fast");
		const input = vi.fn(async () => { first.cost.input = 999; return ENV; });
		const ctx = host(input);
		vi.mocked(ctx.modelRegistry.find).mockImplementation((_provider, id) => id === "cheap" ? first : second);
		const resolve = await modelExperimentResolver(ctx, [selection("cheap"), selection("fast")], null);
		expect(input).toHaveBeenCalledTimes(1);
		expect(resolve(selection("cheap"))).toMatchObject({ apiKeyEnv: ENV, spec: { cost: { input: 1 } } });
		expect(resolve(selection("fast"))).toMatchObject({ apiKeyEnv: ENV, id: "fast" });
		expect(() => resolve(selection("other"))).toThrow("did not resolve this selection");
	});

	it("reuses only the current provider's exported host binding; missing catalog models ask nothing", async () => {
		process.env[ENV] = "local-fixture-value";
		const ctx = host();
		const resolve = await modelExperimentResolver(ctx, [selection("cheap")], { provider: PROVIDER, apiKeyEnv: ENV });
		expect(ctx.ui.input).not.toHaveBeenCalled();
		expect(resolve(selection("cheap"))).toMatchObject({ apiKeyEnv: ENV });
		vi.mocked(ctx.modelRegistry.find).mockReturnValue(undefined);
		await expect(modelExperimentResolver(ctx, [selection("absent")], null)).rejects.toThrow("trusted host catalog");
		expect(ctx.ui.input).not.toHaveBeenCalled();
	});

	it("cancels the private credential dialog with the model turn", async () => {
		const controller = new AbortController();
		const ctx = host();
		vi.mocked(ctx.ui.input).mockImplementation(async (_title, _placeholder, options) => {
			expect(options?.signal).toBe(controller.signal);
			controller.abort();
			return ENV;
		});
		await expect(modelExperimentResolver(ctx, [selection("cheap")], null, controller.signal)).rejects.toThrow();
	});

	it("makes the host catalog discoverable on models and delivers resolved models without exposing credentials", async () => {
		const experiment = record();
		const current = view(experiment);
		process.env[ENV] = "local-fixture-value";
		const decide = vi.fn(async (decision, _gate, execution) => {
			expect(decision).not.toHaveProperty("apiKeyEnv");
			expect(execution.resolveTargetModel(decision.models[0])).toMatchObject({ id: "cheap", apiKeyEnv: ENV });
			return { kind: "model-experiment", message: "Measured", result: { experiment }, view: current };
		});
		const tools = createBuilderWorkbenchTools({ view: async () => current, decide } as unknown as AhdeWorkbench, () => "local:operator");
		const inspect = tools.find((tool) => tool.name === "ahde_workbench_view")!;
		const decision = tools.find((tool) => tool.name === "ahde_workbench_decide")!;
		const ctx = host();
		const catalog = await inspect.execute("models", { aspect: "models" }, undefined, undefined, ctx);
		expect(JSON.stringify(catalog.content)).toContain("hostModelCatalog");
		expect(JSON.stringify(catalog.content)).toContain("cheap");
		expect(JSON.stringify(catalog.content)).toContain("declaredCostUsdPerMillionTokens");
		const result = await decision.execute("compare", { kind: "model-experiment", models: [selection("cheap")], repetitions: 3, executionBudget: 12, qualityTolerance: 0.02, objective: "cost", reason: "Make it cheaper" }, undefined, undefined, ctx);
		expect(decide).toHaveBeenCalledOnce();
		expect(JSON.stringify(result.content)).not.toMatch(/apiKeyEnv|MODEL_EXPERIMENT_FIXTURE_KEY|local-fixture-value/);
	});

	it("bounds safe catalog rates, preserves unknown zero prices and counts every omitted model", () => {
		const ctx = host();
		const catalog = Array.from({ length: 45 }, (_, index) => ({ ...catalogModel(`choice-${index}`), cost: { input: index, output: index, cacheRead: 0, cacheWrite: 0 } }));
		vi.mocked(ctx.modelRegistry.getAvailable).mockReturnValue(catalog);
		vi.mocked(ctx.modelRegistry.find).mockImplementation((_provider, id) => catalog.find((model) => model.id === id));
		const result = modelExperimentCatalog(ctx, PROVIDER);
		expect(result.models).toHaveLength(40);
		expect(result.omittedModels).toBe(5);
		expect(JSON.stringify(result)).not.toMatch(/baseUrl|apiKeyEnv|43199/);
		vi.mocked(ctx.modelRegistry.getAvailable).mockReturnValue([catalog[0]!]);
		expect(modelExperimentCatalog(ctx).models[0]).toMatchObject({ declaredCostUsdPerMillionTokens: null, pricing: "unknown-or-ambiguous-zero" });
	});

	it.each(["rpc", "print"])("refuses model spend and configuration authority on a %s host before asking for credentials", async (mode) => {
		const decide = vi.fn();
		const read = vi.fn();
		const tool = createBuilderWorkbenchTools({ view: read, decide } as unknown as AhdeWorkbench, () => "local:operator").find((entry) => entry.name === "ahde_workbench_decide")!;
		const ctx = { ...host(), mode, hasUI: false } as ExtensionContext;
		for (const input of [
			{ kind: "model-experiment", models: [selection("cheap")], repetitions: 3, executionBudget: 12, qualityTolerance: 0.02, objective: "cost", reason: "Make it cheaper" },
			{ kind: "accept-model", experimentId: record().id, armId: "model-1", reason: "Use this model" },
		]) await expect(tool.execute("authority", input as never, undefined, undefined, ctx)).rejects.toThrow("local TUI host confirmation");
		expect(ctx.ui.input).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
		expect(decide).not.toHaveBeenCalled();
	});
});
