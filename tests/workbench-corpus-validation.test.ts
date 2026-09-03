import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAhdeWorkbench, type WorkbenchHumanGate } from "../src/workbench/index.js";
import { assertGradersRunnable } from "../src/application/corpus-target.js";
import { deriveWorkbenchView, loadWorkbenchInventory } from "../src/workbench/inventory.js";
import { writeEvalRun } from "../src/eval.js";
import { hashValue, modelFingerprint, provenanceAxes, RunRecordSchema } from "../src/provenance.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";
import { baseRunRecord } from "./helpers/judge-fixtures.js";
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

	it("takes a judge grader into a draft and refuses it at publication, where the judge is chosen", async () => {
		const workbench = await approvedWorkbench();
		// Authoring a case that needs a judge is HOW the host learns one is
		// needed: `start-testing` pre-fills an independent model inside the same
		// dialog that publishes and runs the basket.
		const judged = await workbench.submit({
			kind: "corpus-draft",
			name: "Digest basket",
			tasks: [{ input: "Digest for Notion", graders: [{ type: "judge", rubric: "Mentions pricing" }] }],
			coverageNotes: [],
			revisionSummary: "initial",
		});
		// Nothing runs against a judge that does not exist: publication is strict.
		await expect(workbench.decide(
			{ kind: "publish-corpus", draftId: String(judged.artifact?.id), reason: "publish" },
			gate,
		)).rejects.toThrow(/judge graders need a judge model configured in the Target manifest/);

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
		// The judge-graded draft and the runnable one; the broken revision wrote
		// nothing, which is the whole point of validating before persisting.
		expect((await workbench.view()).counts.corpusDrafts).toBe(2);

		const published = await workbench.decide(
			{ kind: "publish-corpus", draftId: String(accepted.artifact?.id), reason: "publish" },
			gate,
		);
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

/**
 * The judge is an instrument, and an instrument can be missing, dependent,
 * keyless or unreadable. Each of those is one typed blocker with its own
 * sentence, at the stages where it is the answer to "why can nothing move".
 */
describe("typed blockers for the judge", () => {
	const JUDGE_TASK = {
		input: "Digest for Notion",
		graders: [{ type: "judge" as const, rubric: "Mentions pricing" }],
	};

	/** A fixture whose manifest carries the given judge block, if any. */
	function judgeManifest(judge: { provider: string; id: string; apiKeyEnv: string } | null) {
		const files = baseFixtureFiles({ ".gitignore": ".ahde/\nruns/\n" });
		const manifest = files.find((file) => file.path === "manifest.yaml");
		if (!manifest) throw new Error("fixture manifest missing");
		if (judge) {
			manifest.content = manifest.content.replace(
				"  graders: evals/graders.yaml\n",
				`  graders: evals/graders.yaml
  judge:
    provider: ${judge.provider}
    id: ${judge.id}
    api: openai-completions
    baseUrl: http://127.0.0.1:9903/v1
    apiKeyEnv: ${judge.apiKeyEnv}
    thinkingLevel: "off"
    timeoutMs: 60000
`,
			);
		}
		const projectDir = makeTargetFixture(files);
		roots.push(projectDir);
		return {
			projectDir,
			options: {
				projectDir,
				stateRoot: join(projectDir, ".ahde"),
				runsRoot: join(projectDir, "runs"),
				projectId: "test-target",
			},
		};
	}

	/** Approve the Spec, draft one judge-graded case, and publish it. */
	async function publishedJudgeBasket(options: {
		projectDir: string;
		stateRoot: string;
		runsRoot: string;
		projectId: string;
	}): Promise<void> {
		const workbench = createAhdeWorkbench(options);
		const draft = await workbench.submit({ kind: "spec-draft", spec });
		await workbench.decide({ kind: "approve-spec", draftSpecId: String(draft.artifact?.id), reason: "approve" }, gate);
		await workbench.submit({
			kind: "corpus-draft",
			name: "Digest basket",
			tasks: [JUDGE_TASK],
			coverageNotes: [],
			revisionSummary: "initial",
		});
		await workbench.decide({ kind: "publish-corpus", reason: "publish" }, gate);
	}

	function reasons(
		options: { projectDir: string; stateRoot: string; runsRoot: string; projectId: string },
		env: NodeJS.ProcessEnv,
	) {
		const view = deriveWorkbenchView(loadWorkbenchInventory(options), env);
		return { stage: view.stage, codes: (view.blockerReasons ?? []).map((reason) => reason.code), view };
	}

	it("says the judge is the agent's own model, and names it", async () => {
		// The manifest can only reach this state by hand — `configure-evaluators`
		// refuses it — which is exactly why the view has to read it.
		const { options } = judgeManifest({
			provider: "qwen-internal",
			id: "qwen3.5-27b",
			apiKeyEnv: "TEST_JUDGE_KEY",
		});
		await publishedJudgeBasket(options);
		const { stage, codes, view } = reasons(options, { TEST_JUDGE_KEY: "sk-live" });
		expect(stage).toBe("ready-to-evaluate");
		expect(codes).toEqual(["blocker.judge-not-independent"]);
		expect(view.blockerReasons?.[0]?.params).toEqual({ model: "qwen-internal/qwen3.5-27b" });
	});

	it("says which variable the judge's key is missing from", async () => {
		const { options } = judgeManifest({ provider: "openrouter", id: "glm-5.3", apiKeyEnv: "TEST_JUDGE_KEY" });
		await publishedJudgeBasket(options);
		expect(reasons(options, {}).codes).toEqual(["blocker.judge-credential-missing"]);
		expect(reasons(options, {}).view.blockerReasons?.[0]?.params).toEqual({ env: "TEST_JUDGE_KEY" });
		// With the key exported there is nothing wrong with the instrument.
		expect(reasons(options, { TEST_JUDGE_KEY: "sk-live" }).codes).toEqual([]);
	});

	it("says a judge is needed once the configured one is gone, instead of “not runnable”", async () => {
		const { projectDir, options } = judgeManifest({
			provider: "openrouter",
			id: "glm-5.3",
			apiKeyEnv: "TEST_JUDGE_KEY",
		});
		await publishedJudgeBasket(options);
		const manifestPath = join(projectDir, "manifest.yaml");
		writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace(/ {2}judge:\n(?: {4}.*\n){7}/, ""), "utf8");
		execFileSync("git", ["-C", projectDir, "add", "manifest.yaml"]);
		execFileSync("git", [
			"-C",
			projectDir,
			"-c",
			"user.name=test",
			"-c",
			"user.email=test@test",
			"commit",
			"-qm",
			"remove judge",
		]);

		const { stage, codes } = reasons(options, { TEST_JUDGE_KEY: "sk-live" });
		expect(stage).toBe("corpus-design");
		// The typed reading replaces the generic sentence, which said only that
		// something about a reviewed basket no longer worked.
		expect(codes).toEqual(["blocker.judge-missing"]);
	});

	/**
	 * Parse failures already became infrastructure errors when the run was
	 * graded; this writes that evidence and asks the view to read it.
	 */
	function evidenceWithUnreadableVerdicts(
		runsRoot: string,
		evalRunId: string,
		unreadable: number,
		total: number,
	): void {
		const runs = Array.from({ length: total }, (_unused, index) => baseRunRecord({
			runId: `${evalRunId}-run-${index}`,
			taskId: `task-${index}`,
			label: "solo",
			parent: { evalRunId, candidateOf: null },
			...(index < unreadable
				? {
					status: "error" as const,
					error: "evaluation infrastructure: judge returned unparseable verdict: не JSON",
					evalResults: null,
				}
				: {}),
		}));
		for (const run of runs) writeJsonArtifact(join(runsRoot, run.runId, "run.json"), RunRecordSchema, run);
		const first = runs[0]!;
		const provenance = provenanceAxes({
			runtime: first.runtime,
			model: first.model,
			judge: modelFingerprint({
				provider: "openrouter",
				id: "glm-5.3",
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:9903/v1",
				apiKeyEnv: "TEST_JUDGE_KEY",
				thinkingLevel: "off",
				params: {},
				spec: {},
			}),
			execution: first.execution,
			eval: first.eval,
		});
		const pass = total - unreadable;
		writeEvalRun(runsRoot, {
			schemaVersion: 3,
			purpose: "evidence",
			evalRunId,
			target: first.target,
			label: "solo",
			baselineEvalRunId: null,
			provenance,
			provenanceKey: hashValue(provenance),
			suiteId: first.eval.suiteId,
			suiteHash: first.eval.suiteHash,
			dataset: first.eval.dataset,
			datasetHash: first.eval.datasetHash,
			evidenceVisibility: "development",
			taskIds: runs.map((run) => run.taskId),
			repetitions: 1,
			runIds: runs.map((run) => run.runId),
			runArtifacts: runs.map((run) => ({ runId: run.runId, sha256: hashValue(run) })),
			startedAt: `2026-08-30T10:00:0${unreadable}.000Z`,
			finishedAt: `2026-08-30T10:00:0${unreadable}.000Z`,
			summary: { total, pass, fail: 0, error: unreadable, allPassRate: pass / total },
		});
	}

	it("reads unreadable judge verdicts off the last run, with the count in the sentence", async () => {
		const { options } = judgeManifest({ provider: "openrouter", id: "glm-5.3", apiKeyEnv: "TEST_JUDGE_KEY" });
		await publishedJudgeBasket(options);
		const env = { TEST_JUDGE_KEY: "sk-live" };
		// Within the infrastructure error budget the run is still a measurement.
		evidenceWithUnreadableVerdicts(options.runsRoot, "erun_judge_ok", 1, 10);
		expect(reasons(options, env).codes).toEqual([]);

		// Newer evidence, over the budget: the newest run is the one that is read.
		evidenceWithUnreadableVerdicts(options.runsRoot, "erun_judge_unreadable", 3, 10);
		const { codes, view } = reasons(options, env);
		expect(codes).toEqual(["blocker.judge-unreadable"]);
		expect(view.blockerReasons?.[0]?.params).toEqual({ count: 3, total: 10 });
	});

	it("stays silent at corpus-review, where the one question pre-fills a judge", async () => {
		const { options } = judgeManifest(null);
		const workbench = createAhdeWorkbench(options);
		const draft = await workbench.submit({ kind: "spec-draft", spec });
		await workbench.decide({ kind: "approve-spec", draftSpecId: String(draft.artifact?.id), reason: "approve" }, gate);
		await workbench.submit({
			kind: "corpus-draft",
			name: "Digest basket",
			tasks: [JUDGE_TASK],
			coverageNotes: [],
			revisionSummary: "initial",
		});
		const { stage, codes } = reasons(options, {});
		expect(stage).toBe("corpus-review");
		expect(codes).toEqual([]);
	});
});
