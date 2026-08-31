import { describe, expect, it } from "vitest";
import { WorkbenchSubmitInputSchema, WorkbenchViewQuerySchema } from "../src/workbench/types.js";

const authoringContext = {
	algorithmId: "git-manifest-context-v1" as const,
	targetId: "test-target",
	targetGitSha: "a".repeat(40),
	contextHash: `sha256:${"c".repeat(64)}`,
};

const spec = {
	schemaVersion: 1 as const,
	title: "Support agent",
	purpose: "Answer support questions from approved evidence.",
	users: ["Support operators"],
	jobs: ["Answer a question"],
	inputs: ["Question"],
	allowedActions: ["Read approved evidence"],
	successCriteria: ["Answer cites applicable evidence"],
	constraints: ["Do not invent evidence"],
	openQuestions: [],
};

describe("Workbench canonical input contract", () => {
	const proposalSource = {
		algorithmId: "exact-eval-signals-v1" as const,
		evalRunId: "erun-test",
		diagnosisId: "diagnosis-test",
		briefId: `brief-${"a".repeat(24)}`,
	};
	const failureModeId = `failure-mode-${"b".repeat(24)}`;

	it("allows exact resource reads only through the Target view", () => {
		expect(WorkbenchViewQuerySchema.parse({ aspect: "target", resourcePath: "AGENTS.md" })).toEqual({
			aspect: "target",
			resourcePath: "AGENTS.md",
		});
		expect(() => WorkbenchViewQuerySchema.parse({ aspect: "traces", resourcePath: "AGENTS.md" })).toThrow();
		expect(() => WorkbenchViewQuerySchema.parse({ aspect: "target", resourcePath: "x".repeat(501) })).toThrow();
	});

	it("uses the canonical typed grader schema", () => {
		expect(() => WorkbenchSubmitInputSchema.parse({
			kind: "corpus-draft",
			name: "Development",
			tasks: [{ input: "Question", graders: [{ type: "made_up_grader" }] }],
			coverageNotes: [],
			revisionSummary: "Initial",
		})).toThrow();

		expect(WorkbenchSubmitInputSchema.parse({
			kind: "corpus-draft",
			name: "Development",
			tasks: [{ input: "Question", graders: [{ type: "output_contains", text: "answer" }] }],
			coverageNotes: [],
			revisionSummary: "Initial",
		})).toMatchObject({ kind: "corpus-draft" });
	});

	it("shares canonical corpus and harness-authoring limits", () => {
		expect(() => WorkbenchSubmitInputSchema.parse({
			kind: "corpus-draft",
			name: "Development",
			tasks: [{ input: "Question", graders: [{ type: "output_contains", text: "answer" }] }],
			coverageNotes: ["x".repeat(1_001)],
			revisionSummary: "Initial",
		})).toThrow();

		expect(() => WorkbenchSubmitInputSchema.parse({
			kind: "structured-proposal",
			authoringContext,
			source: {
				algorithmId: "exact-eval-signals-v1",
				evalRunId: "erun-test",
				diagnosisId: "diagnosis-test",
				briefId: `brief-${"a".repeat(24)}`,
			},
			failureModeIds: [`failure-mode-${"b".repeat(24)}`],
			summary: "Too many intents",
			intents: Array.from({ length: 33 }, () => ({
				type: "instructions.replace",
				content: "# Instructions\n",
			})),
			risks: [],
			validationPlan: ["Run development eval"],
		})).toThrow();
	});

	it("accepts only exact failure-mode handles and rejects model-authored evidence", () => {
		const exact = {
			kind: "structured-proposal" as const,
			authoringContext,
			source: proposalSource,
			failureModeIds: [failureModeId],
			summary: "Address the selected failure mode",
			intents: [{ type: "instructions.replace" as const, content: "# Exact instructions\n" }],
			validationPlan: ["Re-run the exact development eval"],
		};
		expect(WorkbenchSubmitInputSchema.parse(exact)).toMatchObject(exact);
		expect(() => WorkbenchSubmitInputSchema.parse({ ...exact, authoringContext: undefined })).toThrow();
		expect(() => WorkbenchSubmitInputSchema.parse({
			...exact,
			authoringContext: { ...authoringContext, contextHash: "sha256:not-a-hash" },
		})).toThrow();
		expect(() => WorkbenchSubmitInputSchema.parse({
			...exact,
			diagnoses: [{ failureIds: ["forged"], evidence: ["forged"], rootCause: "forged" }],
		})).toThrow();
		expect(() => WorkbenchSubmitInputSchema.parse({
			...exact,
			failureModeIds: [failureModeId, failureModeId],
		})).toThrow();
		expect(() => WorkbenchSubmitInputSchema.parse({
			...exact,
			source: { ...proposalSource, briefId: `brief-${"z".repeat(24)}` },
		})).toThrow();

		const construction = {
			kind: "structured-proposal" as const,
			authoringContext,
			summary: "Construct the approved Spec without inventing evidence",
			intents: [{ type: "execution.configure" as const, execution: { network: "allow" as const } }],
			validationPlan: ["Run the first development eval after apply"],
		};
		expect(WorkbenchSubmitInputSchema.parse(construction)).toMatchObject(construction);
		expect(() => WorkbenchSubmitInputSchema.parse({ ...construction, source: proposalSource }))
			.toThrow(/both source and failureModeIds, or neither/);
		expect(() => WorkbenchSubmitInputSchema.parse({ ...construction, failureModeIds: [failureModeId] }))
			.toThrow(/both source and failureModeIds, or neither/);
	});

	it("keeps the Spec boundary strict while accepting canonical data", () => {
		expect(WorkbenchSubmitInputSchema.parse({ kind: "spec-draft", spec }))
			.toEqual({ kind: "spec-draft", spec });
		expect(() => WorkbenchSubmitInputSchema.parse({
			kind: "spec-draft",
			spec: { ...spec, unexpected: true },
		})).toThrow();
	});

	it("accepts bounded import, grader, and evidence-derived corpus authoring inputs", () => {
		expect(WorkbenchSubmitInputSchema.parse({
			kind: "corpus-import",
			sourcePath: "imports/reviewed-examples.jsonl",
			name: "Imported examples",
			coverageNotes: [],
			revisionSummary: "Import exact operator examples",
		})).toMatchObject({ kind: "corpus-import" });
		expect(() => WorkbenchSubmitInputSchema.parse({
			kind: "corpus-import",
			sourcePath: "evals/sealed.jsonl",
			name: "Unsafe",
			revisionSummary: "Must fail",
		})).toThrow();

		const taskId = `task-${"a".repeat(64)}`;
		expect(WorkbenchSubmitInputSchema.parse({
			kind: "corpus-revision",
			operations: [
				{ type: "set-graders", taskId, graders: [{ type: "output_matches", pattern: "answer" }] },
				{ type: "grader.add", taskId, grader: { type: "output_contains", text: "citation" } },
				{
					type: "grader.update",
					taskId,
					graderIndex: 0,
					grader: { type: "output_contains", text: "verified answer" },
				},
				{ type: "grader.remove", taskId, graderIndex: 1 },
				{
					type: "add-case-from-run",
					evalRunId: "erun_verified",
					runId: "run_verified",
					task: { input: "A neighboring regression case", graders: [{ type: "output_contains", text: "answer" }] },
				},
			],
			revisionSummary: "Strengthen the reviewed basket",
		})).toMatchObject({ kind: "corpus-revision" });
	});
});
