import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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

	it("rejects simulated-user drafts without a user model", async () => {
		const workbench = await approvedWorkbench();
		await expect(workbench.submit({
			kind: "corpus-draft",
			name: "Conversation basket",
			tasks: [{
				input: "I need to change my subscription.",
				simulatedUser: { goal: "change the subscription", maxTurns: 3 },
				graders: [{ type: "turn_budget", max: 3 }],
			}],
			coverageNotes: [],
			revisionSummary: "initial",
		})).rejects.toThrow(/task 1: simulated-user cases need a user model configured in the Target manifest/);
		expect((await workbench.view()).counts.corpusDrafts).toBe(0);
	});

	it("never reports a published simulated-user basket as ready after its user model is removed", async () => {
		const files = baseFixtureFiles({ ".gitignore": ".ahde/\nruns/\n" });
		const manifest = files.find((file) => file.path === "manifest.yaml");
		if (!manifest) throw new Error("fixture manifest missing");
		manifest.content = manifest.content.replace(
			"  graders: evals/graders.yaml\n",
			`  graders: evals/graders.yaml
  simulatedUser:
    provider: qwen-mock
    id: mock-user
    api: openai-completions
    baseUrl: http://127.0.0.1:9902/v1
    apiKeyEnv: TEST_USER_KEY
    thinkingLevel: "off"
    timeoutMs: 60000
`,
		);
		const projectDir = makeTargetFixture(files);
		roots.push(projectDir);
		const options = {
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			projectId: "test-target",
		};
		const workbench = createAhdeWorkbench(options);
		const draft = await workbench.submit({ kind: "spec-draft", spec });
		await workbench.decide({ kind: "approve-spec", draftSpecId: String(draft.artifact?.id), reason: "approve" }, gate);
		await workbench.submit({
			kind: "corpus-draft",
			name: "Conversation basket",
			tasks: [{
				input: "I need to change my subscription.",
				simulatedUser: { goal: "change the subscription", maxTurns: 3 },
				graders: [{ type: "turn_budget", max: 3 }],
			}],
			coverageNotes: [],
			revisionSummary: "initial",
		});
		const published = await workbench.decide({ kind: "publish-corpus", reason: "publish" }, gate);
		expect(published.view.stage).toBe("ready-to-evaluate");
		expect(published.view.target.evaluatorRequirements).toEqual({ judge: false, simulatedUser: true });

		const manifestPath = join(projectDir, "manifest.yaml");
		const withoutUser = readFileSync(manifestPath, "utf8").replace(
			/  simulatedUser:\n(?:    .*\n){7}/,
			"",
		);
		writeFileSync(manifestPath, withoutUser, "utf8");
		execFileSync("git", ["-C", projectDir, "add", "manifest.yaml"]);
		execFileSync("git", ["-C", projectDir, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "remove user model"]);

		const view = await createAhdeWorkbench(options).view();
		expect(view.stage).toBe("corpus-design");
		expect(view.stage).not.toBe("ready-to-evaluate");
		expect(view.actions).toContain("configure-evaluators");
		expect(view.blockers).toContain("The selected development basket is not runnable on the current Target.");
		expect(view.target.evaluatorRequirements).toEqual({ judge: false, simulatedUser: true });
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
		)).toThrow(/task 1 grader 1: exact graders compare[\s\S]*\n- task 2 grader 1: similarity graders compare/);

		expect(() => assertGradersRunnable(
			[{ expected: "Ответ.", graders: [{ type: "exact", normalize: "lower" }] }],
			manifest,
			"basket",
		)).not.toThrow();
	});
});
