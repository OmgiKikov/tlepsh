import { describe, expect, it } from "vitest";
import { WorkbenchSubmitInputSchema } from "../src/workbench/types.js";

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
			summary: "Too many intents",
			diagnoses: [],
			intents: Array.from({ length: 33 }, () => ({
				type: "instructions.replace",
				content: "# Instructions\n",
			})),
			risks: [],
			validationPlan: ["Run development eval"],
		})).toThrow();
	});

	it("keeps the Spec boundary strict while accepting canonical data", () => {
		expect(WorkbenchSubmitInputSchema.parse({ kind: "spec-draft", spec }))
			.toEqual({ kind: "spec-draft", spec });
		expect(() => WorkbenchSubmitInputSchema.parse({
			kind: "spec-draft",
			spec: { ...spec, unexpected: true },
		})).toThrow();
	});
});
