import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	WorkbenchDecisionParameters,
	WorkbenchSubmitParameters,
	WorkbenchViewParameters,
	prepareWorkbenchArguments,
} from "../src/builder/workbench-transport.js";

const spec = {
	title: "Weekly competitor digest",
	purpose: "Summarise 3–5 competitors for a B2B SaaS product manager every week.",
	users: ["product managers"],
	jobs: ["collect pricing, releases, reviews"],
	inputs: ["competitor names and sites"],
	allowedActions: ["read public pages"],
	successCriteria: ["every claim has a source link"],
	constraints: ["never invent facts"],
	openQuestions: [],
};

describe("Workbench tool argument preparation", () => {
	it("parses nested objects and arrays that a model sent as JSON strings", () => {
		const prepared = prepareWorkbenchArguments(WorkbenchSubmitParameters, {
			kind: "spec-draft",
			spec: JSON.stringify({ ...spec, users: JSON.stringify(spec.users) }),
			sourceText: "Хочу агента для сводки по конкурентам",
		}) as { spec: typeof spec };
		expect(prepared.spec.title).toBe(spec.title);
		expect(prepared.spec.users).toEqual(["product managers"]);
		expect(Check(WorkbenchSubmitParameters, prepared)).toBe(true);
	});

	it("parses a whole argument object sent as one JSON string", () => {
		const prepared = prepareWorkbenchArguments(WorkbenchSubmitParameters, JSON.stringify({ kind: "spec-draft", spec }));
		expect(Check(WorkbenchSubmitParameters, prepared)).toBe(true);
	});

	it("parses stringified task arrays, per-task graders, and decision model selections", () => {
		const tasks = [{ input: "Digest for Notion", graders: JSON.stringify([{ type: "output_contains", text: "Notion" }]) }];
		const corpus = prepareWorkbenchArguments(WorkbenchSubmitParameters, {
			kind: "corpus-draft",
			name: "Development basket",
			tasks: JSON.stringify(tasks),
			revisionSummary: "Initial six cases",
		});
		expect(Check(WorkbenchSubmitParameters, corpus)).toBe(true);
		const decision = prepareWorkbenchArguments(WorkbenchDecisionParameters, {
			kind: "configure-target",
			targetId: "competitor-research",
			model: JSON.stringify({ provider: "openrouter", modelId: "qwen/qwen3.5-9b", params: JSON.stringify({ temperature: 0 }) }),
			reason: "Model chosen by the operator",
		}) as { model: { params: Record<string, unknown> } };
		expect(decision.model.params).toEqual({ temperature: 0 });
		expect(Check(WorkbenchDecisionParameters, decision)).toBe(true);
	});

	it("reports only the chosen branch's errors, in model-readable form", () => {
		expect(() => prepareWorkbenchArguments(WorkbenchSubmitParameters, { kind: "spec-draft", spec: { title: "x" } }))
			.toThrow(/^spec-draft is invalid — \/spec must have required properties .*Nested objects and arrays must be JSON values, not strings\.$/);
		expect(() => prepareWorkbenchArguments(WorkbenchSubmitParameters, { kind: "spec-draft", spec, extra: true }))
			.toThrow(/spec-draft is invalid — \/ must not have additional properties/);
		expect(() => prepareWorkbenchArguments(WorkbenchSubmitParameters, { kind: "spec-brief", spec }))
			.toThrow(/kind "spec-brief" is not supported; use one of: select, spec-draft, corpus-draft/);
		expect(() => prepareWorkbenchArguments(WorkbenchDecisionParameters, { reason: "no kind" }))
			.toThrow(/kind is required; use one of: scaffold-target, configure-target/);
	});

	it("selects the view branch by aspect and keeps unrelated values untouched", () => {
		expect(prepareWorkbenchArguments(WorkbenchViewParameters, { aspect: "target", resourcePath: "AGENTS.md" }, "aspect"))
			.toEqual({ aspect: "target", resourcePath: "AGENTS.md" });
		expect(prepareWorkbenchArguments(WorkbenchViewParameters, {}, "aspect")).toEqual({});
		expect(prepareWorkbenchArguments(WorkbenchViewParameters, { aspect: "traces" }, "aspect")).toEqual({ aspect: "traces" });
		expect(() => prepareWorkbenchArguments(WorkbenchViewParameters, { aspect: "summary", resourcePath: "AGENTS.md" }, "aspect"))
			.toThrow(/summary is invalid/);
	});

	it("leaves non-object arguments and unparseable strings to the strict schema", () => {
		expect(prepareWorkbenchArguments(WorkbenchSubmitParameters, "not json")).toBe("not json");
		expect(prepareWorkbenchArguments(WorkbenchSubmitParameters, 42)).toBe(42);
		expect(() => prepareWorkbenchArguments(WorkbenchSubmitParameters, { kind: "spec-draft", spec: "{not json" }))
			.toThrow(/spec-draft is invalid — \/spec must be object/);
	});
});
