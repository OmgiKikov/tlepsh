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

	it("coerces numeric and boolean strings where the schema expects them", () => {
		const run = prepareWorkbenchArguments(WorkbenchDecisionParameters, { kind: "run-current", repetitions: "1", reason: "first run" }) as { repetitions: unknown };
		expect(run.repetitions).toBe(1);
		expect(Check(WorkbenchDecisionParameters, run)).toBe(true);
		const draft = prepareWorkbenchArguments(WorkbenchSubmitParameters, {
			kind: "corpus-draft",
			name: "Basket",
			revisionSummary: "Initial",
			tasks: [{ input: "Digest", graders: [{ type: "output_contains", text: "Notion", caseSensitive: "false" }] }],
		}) as { tasks: { graders: { caseSensitive: unknown }[] }[] };
		expect(draft.tasks[0]?.graders[0]?.caseSensitive).toBe(false);
		expect(Check(WorkbenchSubmitParameters, draft)).toBe(true);
		expect(() => prepareWorkbenchArguments(WorkbenchDecisionParameters, { kind: "run-current", repetitions: "many", reason: "r" }))
			.toThrow(/run-current is invalid — \/repetitions: must be integer/);
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
			.toThrow(/^spec-draft is invalid — \/spec: missing required "purpose", "users", "jobs".*Nested objects and arrays must be JSON values, not strings\.$/);
		expect(() => prepareWorkbenchArguments(WorkbenchSubmitParameters, { kind: "spec-draft", spec, extra: true }))
			.toThrow(/spec-draft is invalid — \/: unknown property "extra" \(allowed: kind, spec, sourceText\)/);
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
			.toThrow(/spec-draft is invalid — \/spec: must be an object \(received a string\)/);
	});
});

describe("model-readable validation problems", () => {
	it("names the allowed grader types and task fields when a model guesses", () => {
		expect(() => prepareWorkbenchArguments(WorkbenchSubmitParameters, {
			kind: "corpus-draft",
			name: "Basket",
			revisionSummary: "6 cases",
			tasks: [{ id: "c1", input: "Digest for Notion", notes: "basic", graders: [{ type: "llm", prompt: "Check sections" }] }],
		})).toThrow(
			/\/tasks\/0: unknown property "id" \(allowed: input, graders\); \/tasks\/0: unknown property "notes" \(allowed: input, graders\); \/tasks\/0\/graders\/0: type "llm" is not supported; use one of: "tool_called" \{name\?, tool, argsContains\?\}, "output_contains" \{name\?, text, caseSensitive\?\}, "output_matches" \{name\?, pattern\}, "judge" \{name\?, rubric\}/,
		);
	});

	it("suggests the field a model probably meant and lists what is missing", () => {
		expect(() => prepareWorkbenchArguments(WorkbenchSubmitParameters, {
			kind: "corpus-draft",
			spec: "spec-1",
			tasks: [{ input: "Digest", graders: [] }],
		})).toThrow(/\/: missing required "name", "revisionSummary"; \/: unknown property "spec" — did you mean "approvedSpecId"\?; \/tasks\/0\/graders: must not have fewer than 1 items/);
		expect(() => prepareWorkbenchArguments(WorkbenchDecisionParameters, { kind: "approve-spec" }))
			.toThrow(/approve-spec is invalid — \/: missing required "reason"/);
	});

	it("explains nested revision operations and intents the same way", () => {
		expect(() => prepareWorkbenchArguments(WorkbenchSubmitParameters, {
			kind: "corpus-revision",
			revisionSummary: "add",
			operations: [{ op: "add", task: { input: "x", graders: [{ type: "output_contains", text: "x" }] } }],
		})).toThrow(/\/operations\/0: type is missing; use one of: "add" \{task\}, "replace" \{taskId, task\}/);
		expect(() => prepareWorkbenchArguments(WorkbenchSubmitParameters, {
			kind: "structured-proposal",
			authoringContext: { algorithmId: "git-manifest-context-v1", targetId: "agent", targetGitSha: "a".repeat(40), contextHash: `sha256:${"b".repeat(64)}` },
			source: { algorithmId: "exact-eval-signals-v1", evalRunId: "erun", diagnosisId: "diag", briefId: `brief-${"c".repeat(24)}` },
			failureModeIds: [`failure-mode-${"d".repeat(24)}`],
			summary: "Add a tool",
			intents: [{ type: "tool.create", name: "lookup" }],
			validationPlan: ["rerun"],
		})).toThrow(/\/intents\/0: type "tool.create" is not supported; use one of: "instructions.replace" \{content\}, "execution.configure" \{execution\}, "skill.upsert" \{name, description, body, disableModelInvocation\?\}, "skill.remove" \{name\}, "tool.upsert" \{name, descriptor, executable\}, "tool.remove" \{name\}/);
	});
});
