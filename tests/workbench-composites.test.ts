import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listCorpora } from "../src/corpus.js";
import { loadTarget, ModelBlock } from "../src/manifest.js";
import { loadTargetAdoptionReceipt } from "../src/application/target-adoption.js";
import { loadCycleContinuationReceipt } from "../src/workbench/cycle-continuation.js";
import {
	WorkbenchDecisionDeclinedError,
	WorkbenchStaleDecisionError,
	createAhdeWorkbench,
	type AhdeWorkbench,
	type AhdeWorkbenchDependencies,
} from "../src/workbench/index.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";
import {
	ACTOR_ID,
	NOW,
	PROJECT_ID,
	cleanupPaths,
	gate,
	git,
	terminalCandidateFixture,
	writeDevelopmentEval,
	type CycleFixture,
	type FixturePaths,
	type RecordingGate,
} from "./helpers/cycle-fixtures.js";

const REASON = "Start testing this agent";
const SHIP_REASON = "Ship the reviewed candidate";
const EVAL_RUN_ID = "erun_composite_fixture";

const SPEC = {
	schemaVersion: 1 as const,
	title: "Support policy assistant",
	purpose: "Answer support policy questions from approved local evidence.",
	users: ["Support operators"],
	jobs: ["Answer one policy question"],
	inputs: ["A policy question"],
	allowedActions: ["Read approved local policy"],
	successCriteria: ["Answer contains the applicable policy"],
	constraints: ["Never invent policy"],
	openQuestions: [],
};

/** A basket that cannot be published, let alone run, without a judge. */
const JUDGE_TASKS = [
	{ input: "What is the refund window?", graders: [{ type: "judge" as const, rubric: "Names the 30-day window" }] },
	{ input: "When does the warranty start?", graders: [{ type: "output_contains" as const, text: "delivery" }] },
];

/** A basket that needs both: one case is judged, two are conversations. */
const BOTH_EVALUATOR_TASKS = [
	{ input: "What is the refund window?", graders: [{ type: "judge" as const, rubric: "Names the 30-day window" }] },
	{
		input: "Something is wrong with my order.",
		simulatedUser: { goal: "get the order replaced", maxTurns: 3 },
		graders: [{ type: "turn_budget" as const, max: 3 }],
	},
	{
		input: "I was charged twice.",
		simulatedUser: { goal: "get the second charge refunded", maxTurns: 3 },
		graders: [{ type: "turn_budget" as const, max: 3 }],
	},
];

/** Both evaluator blocks already written, as a reviewed commit would leave them. */
const CONFIGURED_EVALUATORS = `  judge:
    provider: openrouter
    id: glm-5.3
    api: openai-completions
    baseUrl: https://openrouter.invalid/api/v1
    apiKeyEnv: OPENROUTER_API_KEY
    thinkingLevel: "off"
    timeoutMs: 300000
  simulatedUser:
    provider: openrouter
    id: glm-5.3
    api: openai-completions
    baseUrl: https://openrouter.invalid/api/v1
    apiKeyEnv: OPENROUTER_API_KEY
    thinkingLevel: "off"
    timeoutMs: 300000
`;

/** What the host would pre-fill: a catalog model that is not the agent's own. */
const HOST_JUDGE = {
	selection: { provider: "openrouter", modelId: "glm-5.3" },
	model: ModelBlock.parse({
		provider: "openrouter",
		id: "glm-5.3",
		api: "openai-completions",
		baseUrl: "https://openrouter.invalid/api/v1",
		apiKeyEnv: "OPENROUTER_API_KEY",
		thinkingLevel: "off",
		timeoutMs: 300_000,
	}),
};

const TASKS = [
	{ input: "What is the refund window?", graders: [{ type: "output_contains" as const, text: "30 days" }] },
	{ input: "When does the warranty start?", graders: [{ type: "output_contains" as const, text: "delivery" }] },
];

function paths(options: { evaluators?: boolean } = {}): FixturePaths {
	const files = baseFixtureFiles({ ".gitignore": ".ahde/\nruns/\n" });
	if (options.evaluators) {
		const manifest = files.find((file) => file.path === "manifest.yaml");
		if (!manifest) throw new Error("fixture manifest missing");
		manifest.content = manifest.content.replace(
			"  graders: evals/graders.yaml\n",
			`  graders: evals/graders.yaml\n${CONFIGURED_EVALUATORS}`,
		);
	}
	const projectDir = makeTargetFixture(files);
	return { projectDir, stateRoot: join(projectDir, ".ahde"), runsRoot: join(projectDir, "runs") };
}

/** Every durable file under one root, as `relative path → exact contents`. */
function tree(root: string, replace: readonly (readonly [string, string])[] = []): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory).sort()) {
			const full = join(directory, entry);
			if (statSync(full).isDirectory()) {
				walk(full);
				continue;
			}
			let content = readFileSync(full, "utf8");
			for (const [from, to] of replace) content = content.split(from).join(to);
			files[relative(root, full)] = content;
		}
	};
	walk(root);
	return files;
}

const FOCUS_FILE = join("projects", PROJECT_ID, "workbench", "focus.json");

/** Every durable receipt: the state tree without the mutable focus selection. */
function receipts(fixture: FixturePaths): Record<string, string> {
	const files = tree(fixture.stateRoot, [[fixture.projectDir, "<project>"]]);
	delete files[FOCUS_FILE];
	return files;
}

/** What focus points at, without the hashes that bind it to one repository. */
function focusIds(fixture: FixturePaths): Record<string, string> {
	const focus = JSON.parse(readFileSync(join(fixture.stateRoot, FOCUS_FILE), "utf8")) as {
		selections: Record<string, { id: string }>;
	};
	return Object.fromEntries(
		Object.entries(focus.selections).map(([kind, selection]) => [kind, selection.id]),
	);
}

function workbenchFor(
	fixture: FixturePaths,
	dependencies: Partial<AhdeWorkbenchDependencies> = {},
): AhdeWorkbench {
	return createAhdeWorkbench({
		...fixture,
		projectId: PROJECT_ID,
		dependencies: {
			now: () => NOW,
			// A real EvalRun on disk, so the diagnosis and brief downstream of the
			// run are the production ones rather than another stub.
			runSuite: (async () => {
				const corpus = listCorpora({ stateRoot: fixture.stateRoot, projectId: PROJECT_ID })
					.find((candidate) => candidate.visibility === "development");
				if (!corpus) throw new Error("no development corpus was published before the run");
				return writeDevelopmentEval(fixture, corpus.id, EVAL_RUN_ID);
			}) as AhdeWorkbenchDependencies["runSuite"],
			...dependencies,
		},
	});
}

/** Spec draft + Spec-bound corpus draft: the state “start testing” acts on. */
async function drafted(
	fixture: FixturePaths,
	dependencies: Partial<AhdeWorkbenchDependencies> = {},
): Promise<AhdeWorkbench> {
	const workbench = workbenchFor(fixture, dependencies);
	await workbench.submit({ kind: "spec-draft", spec: SPEC });
	return workbench;
}

async function addCorpusDraft(
	workbench: AhdeWorkbench,
	tasks: typeof TASKS | typeof JUDGE_TASKS | typeof BOTH_EVALUATOR_TASKS = TASKS,
): Promise<void> {
	await workbench.submit({
		kind: "corpus-draft",
		name: "Reviewed development basket",
		tasks,
		coverageNotes: ["Two independent policy questions."],
		revisionSummary: "Initial development basket",
	});
}

describe("start-testing composite", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * Two independent projects, one frozen clock. Corpus metadata stamps its own
	 * `createdAt`, so without this the two publications would differ by
	 * milliseconds and every receipt digest under them with it.
	 */
	function freezeClock(): void {
		vi.useFakeTimers({ toFake: ["Date"], now: new Date(NOW) });
	}

	it("writes exactly the receipts approve-spec + publish-corpus + run-eval write, in the same order", async () => {
		const composite = paths();
		const separate = paths();
		freezeClock();
		try {
			// One dialog.
			const first = await drafted(composite);
			const compositeGate = gate();
			const approved = await first.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, compositeGate);
			expect(approved.result.steps.map((step) => step.kind)).toEqual(["approve-spec"]);
			await addCorpusDraft(first);
			const ran = await first.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, compositeGate);
			expect(ran.result.steps.map((step) => step.kind)).toEqual(["publish-corpus", "run-eval"]);
			expect(ran.result.evaluation?.evaluation.evalRunId).toBe(EVAL_RUN_ID);
			expect(compositeGate.confirm).toHaveBeenCalledTimes(2);

			// The same work as three separate host-confirmed decisions.
			const second = await drafted(separate);
			const stepGate = gate();
			await second.decide({ kind: "approve-spec", reason: REASON }, stepGate);
			await addCorpusDraft(second);
			await second.decide({ kind: "publish-corpus", reason: REASON }, stepGate);
			await second.decide({ kind: "run-eval", repetitions: 1, reason: REASON }, stepGate);
			expect(stepGate.confirm).toHaveBeenCalledTimes(3);

			// Byte-identical durable state: the same approval receipt, the same
			// corpus, the same publication receipt and the same Workbench lineage.
			// Focus is compared separately: it is selection, never authority, and
			// it records the hash of an EvalRun that carries each fixture's own
			// Git revision.
			expect(receipts(composite)).toEqual(receipts(separate));
			expect(focusIds(composite)).toEqual(focusIds(separate));
			expect((await first.view()).stage).toBe((await second.view()).stage);
		} finally {
			cleanup(composite.projectDir);
			cleanup(separate.projectDir);
		}
	});

	it.each(["spec", "corpus"] as const)("refuses changed exact %s draft bytes during the composite dialog", async (kind) => {
		const fixture = paths();
		try {
			const workbench = await drafted(fixture);
			if (kind === "corpus") {
				await workbench.decide({ kind: "approve-spec", reason: REASON }, gate());
				await addCorpusDraft(workbench);
			}
			const before = receipts(fixture);
			const human = gate();
			human.confirm.mockImplementationOnce(async () => {
				const entry = Object.entries(tree(fixture.stateRoot)).find(([, content]) => {
					const record = JSON.parse(content);
					return kind === "spec" ? record.status === "draft" && record.spec : record.kind === "builder-corpus-draft";
				});
				if (!entry) throw new Error("draft fixture missing");
				const record = JSON.parse(entry[1]);
				// createdAt is outside the content-derived ID but inside the exact reviewed snapshot hash.
				record.createdAt = "2026-09-05T12:00:00.000Z";
				writeFileSync(join(fixture.stateRoot, entry[0]), JSON.stringify(record));
				return { approved: true, actorId: ACTOR_ID };
			});
			await expect(workbench.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, human))
				.rejects.toBeInstanceOf(WorkbenchStaleDecisionError);
			expect(human.confirm).toHaveBeenCalledOnce();
			expect(Object.keys(receipts(fixture))).toEqual(Object.keys(before));
			expect(listCorpora({ stateRoot: fixture.stateRoot, projectId: PROJECT_ID })).toEqual([]);
			expect(existsSync(fixture.runsRoot)).toBe(false);
		} finally { cleanup(fixture.projectDir); }
	});

	it("shows the Spec, the case count and the run estimate in its one dialog", async () => {
		const fixture = paths();
		try {
			const workbench = await drafted(fixture);
			const human = gate();
			await workbench.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, human);
			await addCorpusDraft(workbench);
			await workbench.decide({ kind: "start-testing", repetitions: 3, reason: REASON }, human);

			const confirmation = human.confirm.mock.calls[1]?.[0];
			expect(confirmation).toMatchObject({
				kind: "start-testing",
				policy: "consequential",
				title: "Start testing — publish the eval basket (2 cases), run 6 Target executions",
				subject: {
					operation: "start-testing",
					steps: ["publish-corpus", "run-eval"],
					spec: "Support policy assistant — already approved",
					basket: "Reviewed development basket · 2 cases",
					run: "2 × 3 = 6 Target executions",
					estimatedCost: "unknown · nothing comparable has run yet",
					estimatedTime: "unknown · nothing comparable has run yet",
				},
			});
			expect(confirmation?.subjectHash).toMatch(/^sha256:[0-9a-f]{64}$/);
			// The sub-decisions never reach the human: one intent, one question.
			expect(human.confirm).toHaveBeenCalledTimes(2);
		} finally {
			cleanup(fixture.projectDir);
		}
	});

	it("stops at the first step that fails and leaves what the separate decisions leave", async () => {
		const composite = paths();
		const separate = paths();
		const failure = (): never => {
			throw new Error("publication is unavailable in this fixture");
		};
		freezeClock();
		try {
			const first = await drafted(composite, { publishDevelopmentCorpus: failure });
			const compositeGate = gate();
			await first.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, compositeGate);
			await addCorpusDraft(first);
			await expect(first.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, compositeGate))
				.rejects.toThrow(/publication is unavailable/);

			const second = await drafted(separate, { publishDevelopmentCorpus: failure });
			const stepGate = gate();
			await second.decide({ kind: "approve-spec", reason: REASON }, stepGate);
			await addCorpusDraft(second);
			await expect(second.decide({ kind: "publish-corpus", reason: REASON }, stepGate))
				.rejects.toThrow(/publication is unavailable/);

			expect(receipts(composite)).toEqual(receipts(separate));
			// The approval stands, the publication does not, and nothing ran.
			expect((await first.view()).stage).toBe("corpus-review");
			expect(listCorpora({ stateRoot: composite.stateRoot, projectId: PROJECT_ID })).toEqual([]);
			expect(existsSync(composite.runsRoot)).toBe(false);
		} finally {
			cleanup(composite.projectDir);
			cleanup(separate.projectDir);
		}
	});

	/**
	 * A basket that grades with a judge needs one before it can be published.
	 * Asking for that in a second dialog is two questions for one intention, so
	 * the host pre-fills the answer and the operator reads it in the question
	 * they already have — with the model named, and the variable its key comes
	 * from, because that is the part they are approving.
	 */
	it("chooses the judge inside the one dialog when the basket needs one", async () => {
		const fixture = paths();
		try {
			const workbench = await drafted(fixture);
			const human = gate();
			await workbench.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, human);
			await addCorpusDraft(workbench, JUDGE_TASKS);
			const ran = await workbench.decide(
				{ kind: "start-testing", repetitions: 1, reason: REASON },
				human,
				{ defaultJudge: () => HOST_JUDGE },
			);

			expect(ran.result.steps.map((step) => step.kind))
				.toEqual(["configure-evaluators", "publish-corpus", "run-eval"]);
			// One question, not two: the sub-decisions never reach the human.
			expect(human.confirm).toHaveBeenCalledTimes(2);
			const subject = human.confirm.mock.calls[1]?.[0]?.subject as { judge?: string; steps?: string[] };
			expect(subject.judge).toBe("openrouter/glm-5.3 (not the agent's model) · key OPENROUTER_API_KEY");
			expect(subject.steps?.[0]).toBe("configure-evaluators");
			// And it is a reviewed commit on manifest.yaml like any other.
			expect(loadTarget(fixture.projectDir).manifest.evalSuite.judge).toMatchObject({
				provider: "openrouter",
				id: "glm-5.3",
				apiKeyEnv: "OPENROUTER_API_KEY",
			});
			expect(ran.result.evaluation?.evaluation.evalRunId).toBe(EVAL_RUN_ID);
		} finally {
			cleanup(fixture.projectDir);
		}
	});

	/**
	 * A basket that grades with a judge AND holds conversations needs two models
	 * that are not the agent's own. Both are pre-filled in the same dialog and
	 * written by the same reviewed commit: one intention, one question, one
	 * change to manifest.yaml.
	 */
	it("chooses the judge and the client's model in the one dialog when the basket needs both", async () => {
		const fixture = paths();
		try {
			const workbench = await drafted(fixture);
			const human = gate();
			await workbench.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, human);
			await addCorpusDraft(workbench, BOTH_EVALUATOR_TASKS);
			const ran = await workbench.decide(
				{ kind: "start-testing", repetitions: 1, reason: REASON },
				human,
				{ defaultJudge: () => HOST_JUDGE },
			);

			expect(ran.result.steps.map((step) => step.kind))
				.toEqual(["configure-evaluators", "publish-corpus", "run-eval"]);
			expect(human.confirm).toHaveBeenCalledTimes(2);
			const subject = human.confirm.mock.calls[1]?.[0]?.subject as {
				judge?: string;
				user?: string;
				steps?: string[];
			};
			expect(subject.judge).toBe("openrouter/glm-5.3 (not the agent's model) · key OPENROUTER_API_KEY");
			// The client's line carries no independence note: playing the customer
			// is casting, not grading, so the same model may do both.
			expect(subject.user).toBe("openrouter/glm-5.3 · key OPENROUTER_API_KEY");
			expect(subject.steps?.[0]).toBe("configure-evaluators");
			expect(human.confirm.mock.calls[1]?.[0]?.title)
				.toContain("choose the judge, choose the client's model");

			// One reviewed commit on manifest.yaml carries both blocks.
			const manifest = loadTarget(fixture.projectDir).manifest;
			expect(manifest.evalSuite.judge).toMatchObject({ provider: "openrouter", id: "glm-5.3", apiKeyEnv: "OPENROUTER_API_KEY" });
			expect(manifest.evalSuite.simulatedUser).toMatchObject({ provider: "openrouter", id: "glm-5.3", apiKeyEnv: "OPENROUTER_API_KEY" });
			expect(ran.result.evaluation?.evaluation.evalRunId).toBe(EVAL_RUN_ID);
		} finally {
			cleanup(fixture.projectDir);
		}
	});

	it("carries both pre-filled evaluators through run-current, which resolves here", async () => {
		const fixture = paths();
		try {
			const workbench = await drafted(fixture);
			const human = gate();
			await workbench.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, human);
			await addCorpusDraft(workbench, BOTH_EVALUATOR_TASKS);
			const ran = await workbench.decide(
				{ kind: "run-current", repetitions: 1, reason: REASON },
				human,
				{ defaultJudge: () => HOST_JUDGE },
			);
			const resolved = ran.result as { resolvedAs: string; steps: { kind: string }[] };
			expect(resolved.resolvedAs).toBe("start-testing");
			expect(resolved.steps.map((step) => step.kind))
				.toEqual(["configure-evaluators", "publish-corpus", "run-eval"]);
			const manifest = loadTarget(fixture.projectDir).manifest;
			expect(manifest.evalSuite.judge?.id).toBe("glm-5.3");
			expect(manifest.evalSuite.simulatedUser?.id).toBe("glm-5.3");
		} finally {
			cleanup(fixture.projectDir);
		}
	});

	it("asks for neither evaluator when the Target already carries both", async () => {
		const fixture = paths({ evaluators: true });
		try {
			const workbench = await drafted(fixture);
			const human = gate();
			await workbench.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, human);
			await addCorpusDraft(workbench, BOTH_EVALUATOR_TASKS);
			const ran = await workbench.decide(
				{ kind: "start-testing", repetitions: 1, reason: REASON },
				human,
				{ defaultJudge: () => HOST_JUDGE },
			);
			expect(ran.result.steps.map((step) => step.kind)).toEqual(["publish-corpus", "run-eval"]);
			const subject = human.confirm.mock.calls[1]?.[0]?.subject as { judge?: string; user?: string };
			expect(subject.judge).toBeUndefined();
			expect(subject.user).toBeUndefined();
			// And nothing rewrote the manifest the operator already reviewed.
			const manifest = loadTarget(fixture.projectDir).manifest;
			expect(manifest.evalSuite.judge?.apiKeyEnv).toBe("OPENROUTER_API_KEY");
			expect(manifest.evalSuite.simulatedUser?.apiKeyEnv).toBe("OPENROUTER_API_KEY");
		} finally {
			cleanup(fixture.projectDir);
		}
	});

	it("leaves the plan alone when no case is graded by a judge", async () => {
		const fixture = paths();
		try {
			const workbench = await drafted(fixture);
			const human = gate();
			await workbench.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, human);
			await addCorpusDraft(workbench);
			const ran = await workbench.decide(
				{ kind: "start-testing", repetitions: 1, reason: REASON },
				human,
				{ defaultJudge: () => HOST_JUDGE },
			);
			expect(ran.result.steps.map((step) => step.kind)).toEqual(["publish-corpus", "run-eval"]);
			expect((human.confirm.mock.calls[1]?.[0]?.subject as { judge?: string }).judge).toBeUndefined();
			expect(loadTarget(fixture.projectDir).manifest.evalSuite.judge).toBeUndefined();
		} finally {
			cleanup(fixture.projectDir);
		}
	});

	it("carries the pre-filled judge through run-current, which resolves here", async () => {
		const fixture = paths();
		try {
			const workbench = await drafted(fixture);
			const human = gate();
			await workbench.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, human);
			await addCorpusDraft(workbench, JUDGE_TASKS);
			const ran = await workbench.decide(
				{ kind: "run-current", repetitions: 1, reason: REASON },
				human,
				{ defaultJudge: () => HOST_JUDGE },
			);
			expect(ran.kind).toBe("run-current");
			const resolved = ran.result as { resolvedAs: string; steps: { kind: string }[] };
			expect(resolved.resolvedAs).toBe("start-testing");
			expect(resolved.steps.map((step) => step.kind))
				.toEqual(["configure-evaluators", "publish-corpus", "run-eval"]);
			expect(loadTarget(fixture.projectDir).manifest.evalSuite.judge?.id).toBe("glm-5.3");
		} finally {
			cleanup(fixture.projectDir);
		}
	});

	it("writes nothing at all when the one dialog is declined", async () => {
		const fixture = paths();
		try {
			const workbench = await drafted(fixture);
			const before = tree(fixture.stateRoot);
			const declined = gate(false);
			await expect(workbench.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, declined))
				.rejects.toBeInstanceOf(WorkbenchDecisionDeclinedError);
			expect(declined.confirm).toHaveBeenCalledOnce();
			expect(tree(fixture.stateRoot)).toEqual(before);
			expect((await workbench.view()).stage).toBe("spec-review");
		} finally {
			cleanup(fixture.projectDir);
		}
	});
});

/** The values two independently created repositories cannot share. */
function shipReplacements(fixture: CycleFixture): (readonly [string, string])[] {
	return [
		[fixture.projectDir, "<project>"],
		[fixture.baselineSha, "<baseline>"],
		[fixture.candidateSha, "<candidate>"],
	];
}

/**
 * Receipt ids are digests over subjects that carry those revisions, and the
 * Builder run id is a UUID. Everything else — actors, reasons, timestamps,
 * branches, tags, verdicts, dispositions, file names — still compares exactly.
 */
function withoutDigests(files: Record<string, string>): Record<string, string> {
	const mask = (content: string): string => content
		.replace(/[0-9a-f]{64}/g, "<digest>")
		.replace(/[0-9a-f]{40}/g, "<sha>")
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
		// Corpus metadata stamps its own wall clock; every decision timestamp in
		// these fixtures is the injected NOW and still compares exactly.
		.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, (stamp) => (stamp === NOW ? stamp : "<clock>"));
	return Object.fromEntries(Object.entries(files).map(([path, content]) => [mask(path), mask(content)]));
}

describe("ship composite", () => {
	it("refuses a branch changed while Ship waits for approval, before adoption or continuation", async () => {
		const fixture = await terminalCandidateFixture("promoted");
		try {
			const human = gate();
			human.confirm.mockImplementationOnce(async (confirmation) => {
				expect(confirmation.kind).toBe("ship");
				expect(confirmation.subject).toMatchObject({ fastForward: expect.stringContaining(fixture.branch) });
				git(fixture.projectDir, "checkout", "-b", "unapproved-branch");
				return { approved: true, actorId: ACTOR_ID };
			});
			await expect(fixture.workbench.decide({ kind: "ship", reason: SHIP_REASON }, human))
				.rejects.toBeInstanceOf(WorkbenchStaleDecisionError);
			expect(human.confirm).toHaveBeenCalledOnce();
			expect(git(fixture.projectDir, "rev-parse", fixture.branch)).toBe(fixture.baselineSha);
			expect(git(fixture.projectDir, "rev-parse", "unapproved-branch")).toBe(fixture.baselineSha);
			expect(existsSync(join(fixture.stateRoot, "target-adoptions", fixture.candidateId, "receipt.json"))).toBe(false);
			expect(existsSync(join(fixture.stateRoot, "projects", fixture.projectId, "workbench", "cycle-continuations", fixture.candidateId, "receipt.json"))).toBe(false);
		} finally { cleanupPaths(fixture); }
	});

	it("writes the same adoption and continuation receipts as the separate decisions", async () => {
		let composite: CycleFixture | undefined;
		let separate: CycleFixture | undefined;
		try {
			composite = await terminalCandidateFixture("promoted");
			separate = await terminalCandidateFixture("promoted");

			expect((await composite.workbench.view()).guidance?.decide.some((item) => item.kind === "ship")).toBe(true);
			const compositeGate = gate();
			const shipped = await composite.workbench.decide({ kind: "ship", reason: SHIP_REASON }, compositeGate);
			expect(compositeGate.confirm).toHaveBeenCalledOnce();
			expect(shipped.result.steps.map((step) => step.kind)).toEqual(["adopt-candidate", "continue-cycle"]);

			const stepGate = gate();
			await separate.workbench.decide({ kind: "adopt-candidate", reason: SHIP_REASON }, stepGate);
			await separate.workbench.decide({ kind: "continue-cycle", reason: SHIP_REASON }, stepGate);
			expect(stepGate.confirm).toHaveBeenCalledTimes(2);

			expect(withoutDigests(tree(composite.stateRoot, shipReplacements(composite))))
				.toEqual(withoutDigests(tree(separate.stateRoot, shipReplacements(separate))));

			// The receipts themselves, read back through their loaders.
			const adopted = loadTargetAdoptionReceipt(composite.stateRoot, composite.candidateId);
			expect(adopted).toMatchObject({
				previousHead: composite.baselineSha,
				adoptedHead: composite.candidateSha,
				branchRef: `refs/heads/${composite.branch}`,
				adoptedAt: NOW,
				intent: { actor: { kind: "human", id: ACTOR_ID }, reason: SHIP_REASON },
			});
			expect(loadCycleContinuationReceipt(composite.stateRoot, composite.projectId, composite.candidateId))
				.toMatchObject({ continuedAt: NOW, actor: { kind: "human", id: ACTOR_ID }, reason: SHIP_REASON });
			expect(shipped.result.adoption).toEqual({
				branch: composite.branch,
				fromSha: composite.baselineSha,
				toSha: composite.candidateSha,
			});
			expect(shipped.result.continuation?.nextStage).toBe("ready-to-evaluate");
			expect(git(composite.projectDir, "rev-parse", "HEAD")).toBe(composite.candidateSha);
			expect(shipped.view.stage).toBe("ready-to-evaluate");
		} finally {
			cleanupPaths(composite);
			cleanupPaths(separate);
		}
	});

	it("shows both verdicts, the tag and the fast-forward before anything moves", async () => {
		let fixture: CycleFixture | undefined;
		try {
			fixture = await terminalCandidateFixture("promoted");
			const human = gate();
			await fixture.workbench.decide({ kind: "ship", reason: SHIP_REASON }, human);
			expect(human.confirm.mock.calls[0]?.[0]).toMatchObject({
				kind: "ship",
				policy: "consequential",
				title: "Ship this candidate",
				subject: {
					operation: "ship",
					steps: ["adopt-candidate", "continue-cycle"],
					candidateId: fixture.candidateId,
					// The exact sentence the panel showed, not a digest of it.
					development: "improved · score 0% → 100% (+100 pts, 95% CI +100 … +100) on 15 cases × 2 · pass rate 0% → 100%",
					sealed: "pass · 15 × 2",
					fastForward: `${fixture.branch} ${fixture.baselineSha.slice(0, 10)} → ${fixture.candidateSha.slice(0, 10)}`,
					candidate: { candidateId: fixture.candidateId, status: "promoted" },
				},
			});
		} finally {
			cleanupPaths(fixture);
		}
	});

	it("stops at the first step that fails, and writes nothing when declined", async () => {
		let failing: CycleFixture | undefined;
		let declining: CycleFixture | undefined;
		try {
			declining = await terminalCandidateFixture("promoted");
			const before = tree(declining.stateRoot);
			const declined = gate(false);
			await expect(declining.workbench.decide({ kind: "ship", reason: SHIP_REASON }, declined))
				.rejects.toBeInstanceOf(WorkbenchDecisionDeclinedError);
			expect(declined.confirm).toHaveBeenCalledOnce();
			expect(tree(declining.stateRoot)).toEqual(before);
			expect(git(declining.projectDir, "rev-parse", "HEAD")).toBe(declining.baselineSha);
			expect((await declining.workbench.view()).stage).toBe("candidate-adoption");

			// A failing adoption leaves the cycle open: no continuation receipt.
			const recordCycleContinuation = vi.fn();
			failing = await terminalCandidateFixture("promoted", {
				adoptTargetCandidate: () => {
					throw new Error("worktree moved under the adoption");
				},
				recordCycleContinuation: recordCycleContinuation as never,
			});
			await expect(failing.workbench.decide({ kind: "ship", reason: SHIP_REASON }, gate()))
				.rejects.toThrow(/worktree moved under the adoption/);
			expect(recordCycleContinuation).not.toHaveBeenCalled();
			expect(git(failing.projectDir, "rev-parse", "HEAD")).toBe(failing.baselineSha);
			expect((await failing.workbench.view()).stage).toBe("candidate-adoption");
		} finally {
			cleanupPaths(failing);
			cleanupPaths(declining);
		}
	});

	it("refuses to ship a rejected candidate and names the cycle instead", async () => {
		let fixture: CycleFixture | undefined;
		try {
			fixture = await terminalCandidateFixture("rejected");
			const human: RecordingGate = gate();
			await expect(fixture.workbench.decide({ kind: "ship", reason: SHIP_REASON }, human))
				.rejects.toThrow(/was rejected; there is nothing to ship/);
			expect(human.confirm).not.toHaveBeenCalled();
		} finally {
			cleanupPaths(fixture);
		}
	});
});
