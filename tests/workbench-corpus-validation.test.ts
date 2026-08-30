import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAhdeWorkbench, type WorkbenchHumanGate } from "../src/workbench/index.js";
import { assertGradersRunnable } from "../src/application/corpus-target.js";
import type { AgentSpec } from "../src/spec.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) cleanup(root);
});

const spec: AgentSpec = {
	schemaVersion: 1,
	title: "Weekly competitor digest",
	purpose: "Summarise competitors for a product manager.",
	users: ["product managers"],
	jobs: ["collect pricing, releases, reviews"],
	inputs: ["competitor names"],
	allowedActions: ["read public pages"],
	successCriteria: ["every claim has a source"],
	constraints: ["never invent facts"],
	openQuestions: [],
};

const gate: WorkbenchHumanGate = {
	confirm: async () => ({ approved: true, actorId: "local:test-human" }),
	selectSealed: async () => ({ approved: false }),
};

async function approvedWorkbench() {
	const projectDir = makeTargetFixture(baseFixtureFiles({ ".gitignore": ".ahde/\nruns/\n" }));
	roots.push(projectDir);
	const workbench = createAhdeWorkbench({
		projectDir,
		stateRoot: join(projectDir, ".ahde"),
		runsRoot: join(projectDir, "runs"),
		projectId: "test-target",
	});
	const draft = await workbench.submit({ kind: "spec-draft", spec });
	await workbench.decide({ kind: "approve-spec", draftSpecId: String(draft.artifact?.id), reason: "approve" }, gate);
	return workbench;
}

describe("corpus grader validation against the current Target", () => {
	it("explains an invalid JavaScript regex before any draft is written", async () => {
		const workbench = await approvedWorkbench();
		await expect(workbench.submit({
			kind: "corpus-draft",
			name: "Digest basket",
			tasks: [{ input: "Digest for Notion", graders: [{ type: "output_matches", pattern: "(?is)цены.*релизы" }] }],
			coverageNotes: [],
			revisionSummary: "initial",
		})).rejects.toThrow(/task 1 grader 1: output_matches pattern "\(\?is\)цены\.\*релизы" is not a valid JavaScript regular expression[\s\S]*Inline flags such as \(\?i\)/);
		expect((await workbench.view()).counts.corpusDrafts).toBe(0);
	});

	it("rejects judge graders when the Target has no judge model, and accepts runnable graders", async () => {
		const workbench = await approvedWorkbench();
		await expect(workbench.submit({
			kind: "corpus-draft",
			name: "Digest basket",
			tasks: [{ input: "Digest for Notion", graders: [{ type: "judge", rubric: "Mentions pricing" }] }],
			coverageNotes: [],
			revisionSummary: "initial",
		})).rejects.toThrow(/judge graders need a judge model configured in the Target manifest/);

		const accepted = await workbench.submit({
			kind: "corpus-draft",
			name: "Digest basket",
			tasks: [{ input: "Digest for Notion", graders: [{ type: "output_matches", pattern: "[Цц]ены" }, { type: "output_contains", text: "Notion" }] }],
			coverageNotes: [],
			revisionSummary: "initial",
		});
		expect((await workbench.view()).stage).toBe("corpus-review");

		await expect(workbench.submit({
			kind: "corpus-revision",
			parentDraftId: String(accepted.artifact?.id),
			operations: [{ type: "add", task: { input: "Digest for Linear", graders: [{ type: "output_matches", pattern: "(?i)linear" }] } }],
			revisionSummary: "add a broken case",
		})).rejects.toThrow(/corpus revision cannot run on the current Target/);
		expect((await workbench.view()).counts.corpusDrafts).toBe(1);

		const published = await workbench.decide({ kind: "publish-corpus", reason: "publish" }, gate);
		expect(published.view.stage).toBe("ready-to-evaluate");
		expect(published.view.blockers).toEqual([]);
	});

	it("reports every problem with its task and grader position", () => {
		expect(() => assertGradersRunnable(
			[
				{ graders: [{ type: "output_contains", text: "ok", caseSensitive: false }] },
				{ graders: [{ type: "output_matches", pattern: "(" }, { type: "judge", rubric: "r" }] },
			],
			{ evalSuite: { id: "s", dataset: "d", graders: "g" } } as never,
			"basket",
		)).toThrow(/basket cannot run on the current Target:\n- task 2 grader 1: output_matches[\s\S]*\n- task 2 grader 2: judge graders need a judge model/);
	});

	it("refuses a reference grader on a case with no expected answer, and accepts one with it", () => {
		const manifest = { evalSuite: { id: "s", dataset: "d", graders: "g" } } as never;
		expect(() => assertGradersRunnable(
			[
				{ graders: [{ type: "exact", normalize: "lower" }] },
				{ expected: "  ", graders: [{ type: "similarity", metric: "token-f1", threshold: 0.8 }] },
			],
			manifest,
			"basket",
		)).toThrow(/task 1 grader 1: a exact grader compares[\s\S]*\n- task 2 grader 1: a similarity grader compares/);

		expect(() => assertGradersRunnable(
			[{ expected: "Ответ.", graders: [{ type: "exact", normalize: "lower" }] }],
			manifest,
			"basket",
		)).not.toThrow();
	});
});
