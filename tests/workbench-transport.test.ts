import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	WorkbenchDecisionToolSchema,
	WorkbenchSubmitToolSchema,
	WorkbenchViewToolSchema,
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
		const prepared = WorkbenchSubmitToolSchema.prepare({
			kind: "spec-draft",
			spec: JSON.stringify({ ...spec, users: JSON.stringify(spec.users) }),
			sourceText: "Хочу агента для сводки по конкурентам",
		}) as unknown as { spec: typeof spec };
		expect(prepared.spec.title).toBe(spec.title);
		expect(prepared.spec.users).toEqual(["product managers"]);
		expect(Check(WorkbenchSubmitToolSchema.parameters, prepared)).toBe(true);
	});

	it("coerces numeric and boolean strings where the schema expects them", () => {
		const run = WorkbenchDecisionToolSchema.prepare({ kind: "run-current", repetitions: "1", reason: "first run" });
		expect(run).toMatchObject({ repetitions: 1 });
		expect(Check(WorkbenchDecisionToolSchema.parameters, run)).toBe(true);
		const draft = WorkbenchSubmitToolSchema.prepare({
			kind: "corpus-draft",
			name: "Basket",
			revisionSummary: "Initial",
			tasks: [{ input: "Digest", graders: [{ type: "output_contains", text: "Notion", caseSensitive: "false" }] }],
		}) as unknown as { tasks: { graders: { caseSensitive: unknown }[] }[] };
		expect(draft.tasks[0]?.graders[0]?.caseSensitive).toBe(false);
		expect(Check(WorkbenchSubmitToolSchema.parameters, draft)).toBe(true);
		expect(() => WorkbenchDecisionToolSchema.prepare({ kind: "run-current", repetitions: "many", reason: "r" }))
			.toThrow(/run-current is invalid — \/repetitions: must be a number \(received a string\)/);
	});

	it("parses a whole argument object sent as one JSON string", () => {
		const prepared = WorkbenchSubmitToolSchema.prepare(JSON.stringify({ kind: "spec-draft", spec }));
		expect(Check(WorkbenchSubmitToolSchema.parameters, prepared)).toBe(true);
	});

	it("parses stringified task arrays, per-task graders, and decision model selections", () => {
		const tasks = [{ input: "Digest for Notion", graders: JSON.stringify([{ type: "output_contains", text: "Notion" }]) }];
		const corpus = WorkbenchSubmitToolSchema.prepare({
			kind: "corpus-draft",
			name: "Development basket",
			tasks: JSON.stringify(tasks),
			revisionSummary: "Initial six cases",
		});
		expect(Check(WorkbenchSubmitToolSchema.parameters, corpus)).toBe(true);
		const decision = WorkbenchDecisionToolSchema.prepare({
			kind: "configure-target",
			targetId: "competitor-research",
			model: JSON.stringify({ provider: "openrouter", modelId: "qwen/qwen3.5-9b", params: JSON.stringify({ temperature: 0 }) }),
			reason: "Model chosen by the operator",
		}) as unknown as { model: { params: Record<string, unknown> } };
		expect(decision.model.params).toEqual({ temperature: 0 });
		expect(Check(WorkbenchDecisionToolSchema.parameters, decision)).toBe(true);
	});

	it("reports only the chosen branch's errors, in model-readable form", () => {
		expect(() => WorkbenchSubmitToolSchema.prepare({ kind: "spec-draft", spec: { title: "x" } }))
			.toThrow(/^spec-draft is invalid — \/spec: missing required "purpose", "users", "jobs".*Nested objects and arrays must be JSON values, not strings\.$/);
		expect(() => WorkbenchSubmitToolSchema.prepare({ kind: "spec-draft", spec, extra: true }))
			.toThrow(/spec-draft is invalid — \/: unknown property "extra" \(allowed: kind, spec, sourceText\)/);
		expect(() => WorkbenchSubmitToolSchema.prepare({ kind: "spec-brief", spec }))
			.toThrow(/kind "spec-brief" is not supported; use one of: select, spec-draft, corpus-draft/);
		expect(() => WorkbenchDecisionToolSchema.prepare({ reason: "no kind" }))
			.toThrow(/kind is required; use one of: scaffold-target, configure-target/);
	});

	it("keeps the view query small and rejects a resourcePath outside the Target view", () => {
		expect(WorkbenchViewToolSchema.prepare({ aspect: "target", resourcePath: "AGENTS.md" }))
			.toEqual({ aspect: "target", resourcePath: "AGENTS.md" });
		expect(WorkbenchViewToolSchema.prepare({})).toEqual({});
		expect(WorkbenchViewToolSchema.prepare({ aspect: "traces" })).toEqual({ aspect: "traces" });
		expect(WorkbenchViewToolSchema.prepare({ include: ["selections"] })).toEqual({ include: ["selections"] });
		expect(() => WorkbenchViewToolSchema.prepare({ aspect: "summary", resourcePath: "AGENTS.md" }))
			.toThrow(/summary is invalid — \/resourcePath: resourcePath is valid only for the Target view/);
		expect(() => WorkbenchViewToolSchema.prepare({ include: ["diff"] })).toThrow(/aspect is invalid — \/include\/0:/);
	});

	it("names the kinds when the arguments are not a usable object", () => {
		expect(() => WorkbenchSubmitToolSchema.prepare("not json")).toThrow(/kind is required; use one of: select, spec-draft/);
		expect(() => WorkbenchSubmitToolSchema.prepare(42)).toThrow(/kind is required; use one of: select, spec-draft/);
		expect(() => WorkbenchSubmitToolSchema.prepare({ kind: "spec-draft", spec: "{not json" }))
			.toThrow(/spec-draft is invalid — \/spec: must be an object \(received a string\)/);
	});
});

describe("model-readable validation problems", () => {
	it("names the allowed grader types and task fields when a model guesses", () => {
		expect(() => WorkbenchSubmitToolSchema.prepare({
			kind: "corpus-draft",
			name: "Basket",
			revisionSummary: "6 cases",
			tasks: [{ id: "c1", input: "Digest for Notion", notes: "basic", graders: [{ type: "llm", prompt: "Check sections" }] }],
		})).toThrow(
			/\/tasks\/0: unknown property "id" \(allowed: input, graders\); \/tasks\/0: unknown property "notes" \(allowed: input, graders\); \/tasks\/0\/graders\/0: type "llm" is not supported; use one of: "tool_called" \{name\?, tool, argsContains\?\}, "output_contains" \{name\?, text, caseSensitive\?\}, "output_matches" \{name\?, pattern\}, "judge" \{name\?, rubric\}/,
		);
	});

	it("suggests the field a model probably meant and lists what is missing", () => {
		expect(() => WorkbenchSubmitToolSchema.prepare({
			kind: "corpus-draft",
			spec: "spec-1",
			tasks: [{ input: "Digest", graders: [] }],
		})).toThrow(/\/: missing required "name", "revisionSummary"; \/: unknown property "spec" — did you mean "approvedSpecId"\?; \/tasks\/0\/graders:/);
		expect(() => WorkbenchDecisionToolSchema.prepare({ kind: "approve-spec" }))
			.toThrow(/approve-spec is invalid — \/: missing required "reason"/);
	});

	it("explains nested revision operations and intents the same way", () => {
		expect(() => WorkbenchSubmitToolSchema.prepare({
			kind: "corpus-revision",
			revisionSummary: "add",
			operations: [{ op: "add", task: { input: "x", graders: [{ type: "output_contains", text: "x" }] } }],
		})).toThrow(/\/operations\/0: type is missing; use one of: "add" \{task\}, "replace" \{taskId, task\}/);
		expect(() => WorkbenchSubmitToolSchema.prepare({
			kind: "structured-proposal",
			authoringContext: { algorithmId: "git-manifest-context-v1", targetId: "agent", targetGitSha: "a".repeat(40), contextHash: `sha256:${"b".repeat(64)}` },
			source: { algorithmId: "exact-eval-signals-v1", evalRunId: "erun", diagnosisId: "diag", briefId: `brief-${"c".repeat(24)}` },
			failureModeIds: [`failure-mode-${"d".repeat(24)}`],
			summary: "Add a tool",
			intents: [{ type: "tool.create", name: "lookup" }],
			validationPlan: ["rerun"],
		})).toThrow(/\/intents\/0: type "tool.create" is not supported; use one of: "instructions.replace" \{content\}, "execution.configure" \{execution\}, "skill.upsert" \{name, description, body, disableModelInvocation\?\}, "skill.remove" \{name\}, "tool.upsert" \{name, descriptor, executable\?, files\?\}, "tool.remove" \{name\}, "data.upsert" \{content\?, contentBase64\?, path\}, "data.remove" \{path\}/);
	});
});

describe("generated tool schemas", () => {
	it("defines each repeated union once and keeps the model-authored surface strict", () => {
		const submit = WorkbenchSubmitToolSchema.parameters as unknown as {
			anyOf: { properties: Record<string, unknown>; additionalProperties: boolean }[];
			$defs: Record<string, unknown>;
		};
		expect(Object.keys(submit.$defs)).toEqual(["grader", "corpusOperation", "harnessIntent"]);
		expect(JSON.stringify(submit).split('"tool_called"')).toHaveLength(2);
		for (const branch of submit.anyOf) {
			expect(branch.additionalProperties).toBe(false);
			expect(Object.keys(branch.properties)).not.toEqual(expect.arrayContaining(["actor", "approved", "confirmed"]));
		}
		// A Spec draft is authored without the host-owned schema version.
		const draft = submit.anyOf.find((branch) => (branch.properties.kind as { const?: string }).const === "spec-draft");
		expect((draft?.properties.spec as { required: string[] }).required).not.toContain("schemaVersion");
	});
});
