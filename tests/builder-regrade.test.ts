import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	compileRegradeDiff,
	planRegradeGraders,
	RegradeRefused,
	resolveRegradeSource,
	type EvalRunSource,
	type RegradeDiff,
	type RevisedCase,
} from "../src/application/regrade-decision.js";
import { AHDE_BUILDER_COMMAND_NAMES, parseRegrade } from "../src/builder/commands.js";
import { createBuilderJobs } from "../src/builder/jobs.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { receiptFacts, receiptSubject } from "../src/builder/render/receipt.js";
import { renderRegrade, renderRegradeFlip } from "../src/builder/render/regrade.js";
import { runSuite, type EvalRunRecord } from "../src/eval.js";
import { setLanguage } from "../src/i18n.js";
import { loadTarget, type GraderSpec } from "../src/manifest.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import { regradeEvalRun } from "../src/regrade.js";
import {
	assertWorkbenchDecisionStage,
	workbenchDecisionStages,
	workbenchGateClass,
} from "../src/workbench/transition-policy.js";
import type { WorkbenchDecisionResult } from "../src/workbench/types.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

/**
 * «Судья слишком строгий» → the rubric changes → the recorded answers are
 * scored again → the operator sees exactly what moved.
 *
 * The whole point is that the second number is free of Target money, so every
 * test that regrades also asserts the mock model was never asked anything.
 */

const SUITE_TIMEOUT_MS = 180_000;

/** Four cases whose answers are fixed, so only the rubric can move a verdict. */
const CASES: { id: string; input: string; text: string }[] = [
	{ id: "task_alpha", input: "alpha request", text: "ответ alpha" },
	{ id: "task_beta", input: "beta request", text: "ответ beta" },
	{ id: "task_gamma", input: "gamma request", text: "ответ gamma" },
	{ id: "task_delta", input: "delta request", text: "ответ delta" },
];

/** The rubric the basket was measured with: beta and gamma fail it. */
const MEASURED: Record<string, string> = {
	task_alpha: "ответ alpha",
	task_beta: "НЕТУ",
	task_gamma: "НЕТУ",
	task_delta: "ответ delta",
};

/** The revised rubric: beta and gamma now pass, delta now fails. */
const REVISED: Record<string, string> = {
	task_alpha: "ответ alpha",
	task_beta: "ответ beta",
	task_gamma: "ответ gamma",
	task_delta: "НЕТУ",
};

function contains(text: string): GraderSpec[] {
	return [{ type: "output_contains", text, caseSensitive: false }];
}

function dataset(rubric: Record<string, string>): string {
	return CASES
		.map((task) => JSON.stringify({ id: task.id, input: task.input, graders: contains(rubric[task.id]!) }))
		.join("\n");
}

function revisedCases(rubric: Record<string, string>): RevisedCase[] {
	return CASES.map((task) => ({ input: task.input, graders: contains(rubric[task.id]!) }));
}

function fixture(mockUrl: string): string {
	return makeTargetFixture(baseFixtureFiles({
		"manifest.yaml": `id: regrade-decision-target
model:
  provider: qwen-mock
  id: mock
  api: openai-completions
  baseUrl: ${mockUrl}
  apiKeyEnv: MOCK_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 60000
instructions:
  agentsMd: AGENTS.md
skills: []
evalSuite:
  id: regrade-decision-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`,
		"evals/development.jsonl": dataset(MEASURED),
		"evals/graders.yaml": "defaults:\n  - type: output_contains\n    text: \"ответ\"\n",
	}));
}

describe("re-scoring recorded answers with a revised rubric", () => {
	let mock: MockModelHandle;
	let targetDir: string;
	let runsRoot: string;
	let source: EvalRunRecord;
	let diff: RegradeDiff;

	beforeAll(async () => {
		process.env.MOCK_MODEL_KEY = "test-key";
		mock = await startMockModel(
			CASES.map((task) => ({
				match: ({ firstUser }: { firstUser: string }) => firstUser.includes(task.input),
				steps: [{ text: task.text }],
			})),
		);
		targetDir = fixture(mock.url);
		runsRoot = join(targetDir, "..", `regrade-decision-runs-${Date.now()}`);
		const target = loadTarget(targetDir);
		source = await runSuite(target, { runsRoot, label: "solo", repetitions: 1 });

		const plan = planRegradeGraders({
			scored: target,
			revised: revisedCases(REVISED),
			sourceJudge: source.provenance.judge,
		});
		const spent = mock.requests();
		const result = await regradeEvalRun({ runsRoot, evalRunId: source.evalRunId, target: plan.target });
		expect(mock.requests()).toBe(spent);
		diff = compileRegradeDiff({ runsRoot, result, graders: "draft", changed: plan.changed });
	}, SUITE_TIMEOUT_MS);

	afterAll(async () => {
		cleanup(targetDir);
		cleanup(runsRoot);
		await mock.close();
	});

	it("keeps the questions the traces answered and mints a new scoring identity", () => {
		const target = loadTarget(targetDir);
		const plan = planRegradeGraders({
			scored: target,
			revised: revisedCases(REVISED),
			sourceJudge: source.provenance.judge,
		});
		// The cases are the source's, byte for byte — that is what lets the
		// engine's own rule admit the regrade at all.
		expect(plan.target.datasetHash).toBe(source.datasetHash);
		expect(plan.target.tasks.map((task) => task.id)).toEqual(CASES.map((task) => task.id));
		// The rubric is not, and the suite hash says so: derived evidence scored
		// differently is never comparable with the basket it came from.
		expect(plan.target.suiteHash).not.toBe(target.suiteHash);
		expect(plan.target.suiteIdentity).toBe("manifest");
		expect(plan.changed).toEqual([
			{ taskId: "task_beta", before: ["output_contains: НЕТУ"], after: ["output_contains: ответ beta"] },
			{ taskId: "task_gamma", before: ["output_contains: НЕТУ"], after: ["output_contains: ответ gamma"] },
			{ taskId: "task_delta", before: ["output_contains: ответ delta"], after: ["output_contains: НЕТУ"] },
		]);
	});

	it("counts what moved, in both directions, and never a Target execution", () => {
		expect(diff).toMatchObject({
			sourceEvalRunId: source.evalRunId,
			graders: "draft",
			cases: 4,
			total: 4,
			passBefore: 2,
			passAfter: 3,
			passRateBefore: 0.5,
			passRateAfter: 0.75,
			nowPassing: 2,
			nowFailing: 1,
			unchanged: 1,
			changedGraderCount: 3,
			targetExecutions: 0,
			sealed: false,
		});
		expect(diff.meanScoreBefore).toBeCloseTo(0.5, 6);
		expect(diff.meanScoreAfter).toBeCloseTo(0.75, 6);
		// No judge grader ran, so the judge's bill is exactly zero rather than
		// unknown: a regrade pays the judge and nothing else.
		expect(diff.judge).toEqual({ calls: 0, tokens: 0, costUsd: 0 });
	});

	it("names the grader that decided each flipped answer", () => {
		expect(diff.flips.map((flip) => ({ taskId: flip.taskId, from: flip.from, to: flip.to, type: flip.grader?.type })))
			.toEqual([
				{ taskId: "task_beta", from: "fail", to: "pass", type: "output_contains" },
				{ taskId: "task_gamma", from: "fail", to: "pass", type: "output_contains" },
				{ taskId: "task_delta", from: "pass", to: "fail", type: "output_contains" },
			]);
		expect(diff.flips.every((flip) => flip.assertions.length === 0)).toBe(true);
	});

	it("draws the panel in the operator's language", () => {
		try {
			setLanguage("ru");
			expect(renderRegrade(diff, plainPaint)).toEqual([
				"Пересчёт было 50% → стало 75% · 4 кейса · Target не вызывался · судья $0.00",
				"↑ теперь проходят: 2 · ↓ теперь падают: 1 · = без изменений: 1 · балл 0.50 → 0.75",
				"переписаны рубрики: 3",
				"  task_beta#0 ✗→✓ · output_contains: теперь проходит",
				"  task_gamma#0 ✗→✓ · output_contains: теперь проходит",
				"  task_delta#0 ✓→✗ · output_contains: теперь падает",
				"Это пересчёт, не новая база: чтобы измерить кандидата на новых грейдерах, пересчитай и базу тем же набором.",
			]);
			setLanguage("en");
			expect(renderRegrade(diff, plainPaint)).toEqual([
				"Re-scored was 50% → now 75% · 4 cases · the Target was not called · judge $0.00",
				"↑ now passing: 2 · ↓ now failing: 1 · = unchanged: 1 · score 0.50 → 0.75",
				"rubrics rewritten: 3",
				"  task_beta#0 ✗→✓ · output_contains: now passes",
				"  task_gamma#0 ✗→✓ · output_contains: now passes",
				"  task_delta#0 ✓→✗ · output_contains: now fails",
				"This is a re-score, not a new baseline: to measure a candidate on the new graders, re-score the baseline with the same set.",
			]);
		} finally {
			setLanguage(null);
		}
	});

	it("says which assertion the rewritten rubric answered differently", () => {
		const flip = {
			taskId: "task_006",
			repetitionIndex: 0,
			from: "fail" as const,
			to: "pass" as const,
			grader: { name: "task_006#0:judge", type: "judge" },
			assertions: [{ index: 2, to: "yes" as const }],
		};
		try {
			setLanguage("ru");
			expect(renderRegradeFlip(flip, plainPaint)).toBe("task_006#0 ✗→✓ · judge: утверждение 2 теперь да");
			setLanguage("en");
			expect(renderRegradeFlip(flip, plainPaint)).toBe("task_006#0 ✗→✓ · judge: assertion 2 now yes");
		} finally {
			setLanguage(null);
		}
	});

	it("refuses a revision that changed the questions rather than the graders", () => {
		const target = loadTarget(targetDir);
		const moved = revisedCases(REVISED).map((task, index) =>
			index === 0 ? { ...task, input: "a different question entirely" } : task
		);
		expect(() => planRegradeGraders({ scored: target, revised: moved, sourceJudge: source.provenance.judge }))
			.toThrow(/changed what the cases ask, not only how they are graded/);
		// The same refusal when the basket simply grew: a recorded answer set
		// cannot cover a case that never ran.
		expect(() => planRegradeGraders({
			scored: target,
			revised: [...revisedCases(REVISED), { input: "a fifth question", graders: contains("x") }],
			sourceJudge: source.provenance.judge,
		})).toThrow(/a re-score can change the graders, never the questions/);
	});

	it("refuses a re-score that would decide nothing", () => {
		const target = loadTarget(targetDir);
		// Same rubric, same judge: the verdicts are already on disk.
		expect(() => planRegradeGraders({
			scored: target,
			revised: revisedCases(MEASURED),
			sourceJudge: source.provenance.judge,
		})).toThrow(/already scored this run/);
		// And the `target` source, which is exactly "today's rubric".
		expect(() => planRegradeGraders({ scored: target, revised: null, sourceJudge: source.provenance.judge }))
			.toThrow(RegradeRefused);
		// Unless the judge behind that rubric moved, which is the one thing
		// re-running today's graders can still discover.
		const movedJudge = planRegradeGraders({
			scored: target,
			revised: null,
			sourceJudge: { provider: "other", id: "old-judge", api: "openai-completions", baseUrl: "http://x", apiKeyEnv: "K", thinkingLevel: "off", params: {}, spec: {} } as never,
		});
		expect(movedJudge.changed).toEqual([]);
		expect(movedJudge.target.suiteHash).toBe(target.suiteHash);
	});
});

describe("choosing the evidence to re-score", () => {
	const evals: EvalRunSource[] = [
		{ evalRunId: "erun_new", dataset: "development", datasetHash: "sha256:a", evidenceVisibility: "development", regradeOf: "erun_old", runIds: ["r1"] },
		{ evalRunId: "erun_measured", dataset: "development", datasetHash: "sha256:a", evidenceVisibility: "development", regradeOf: undefined, runIds: ["r2", "r3"] },
	];
	const missing = (): EvalRunSource => {
		throw new Error("no such eval run");
	};

	it("defaults to the newest measured evidence, never to another re-score", () => {
		expect(resolveRegradeSource({ evals, readIndex: missing })?.evalRunId).toBe("erun_measured");
	});

	it("re-scores a named re-score, because that is still only judge money", () => {
		expect(resolveRegradeSource({ evals, explicitId: "erun_new", readIndex: missing })?.evalRunId).toBe("erun_new");
	});

	it("never re-scores the sealed exam", () => {
		expect(() => resolveRegradeSource({
			evals,
			explicitId: "erun_sealed",
			readIndex: () => ({
				evalRunId: "erun_sealed",
				dataset: "sealed-corpus-x",
				datasetHash: "sha256:b",
				evidenceVisibility: "sealed",
				regradeOf: undefined,
				runIds: ["r9"],
			}),
		})).toThrow(/sealed verdict is never re-scored/);
	});

	it("leaves an unknown id to the caller, and says when there is nothing to re-score", () => {
		expect(resolveRegradeSource({ evals, explicitId: "erun_nope", readIndex: missing })).toBeNull();
		expect(() => resolveRegradeSource({ evals: [], readIndex: missing })).toThrow(/run the basket first/);
	});
});

describe("the re-score as a Builder decision", () => {
	it("is routine measurement, legal wherever a rubric and a recorded run meet", () => {
		expect(workbenchGateClass("regrade")).toBe("routine");
		expect(workbenchDecisionStages("regrade")).toEqual([
			"corpus-review",
			"ready-to-evaluate",
			"improvement-authoring",
		]);
		expect(() => assertWorkbenchDecisionStage("regrade", "corpus-review")).not.toThrow();
		expect(() => assertWorkbenchDecisionStage("regrade", "candidate-review")).toThrow(/not legal during/);
	});

	it("reads /regrade the way an operator types it", () => {
		expect(AHDE_BUILDER_COMMAND_NAMES).toContain("regrade");
		expect(parseRegrade("")).toEqual({
			evalRunId: null,
			graders: "draft",
			reason: "Requested interactively via /regrade",
		});
		expect(parseRegrade("erun_abc123")).toMatchObject({ evalRunId: "erun_abc123", graders: "draft" });
		expect(parseRegrade("erun_abc123 target судья был слишком строгий")).toEqual({
			evalRunId: "erun_abc123",
			graders: "target",
			reason: "судья был слишком строгий",
		});
		expect(parseRegrade("судья слишком строгий")).toEqual({
			evalRunId: null,
			graders: "draft",
			reason: "судья слишком строгий",
		});
	});

	it("bills the receipt for the judge alone, never for answers already bought", () => {
		const result = {
			kind: "regrade",
			message: "",
			result: { evalRunId: "erun_derived" } as RegradeDiff,
			view: {} as never,
		} as WorkbenchDecisionResult;
		const wanted = receiptSubject(result);
		expect(wanted).toEqual({ evalRunIds: ["erun_derived"], candidateIds: [], judgeOnly: true });
		const facts = receiptFacts(
			[{
				evalRunId: "erun_derived",
				runs: 42,
				costUsd: 1.2,
				judgeCostUsd: 0.04,
				startedAt: "2026-09-01T10:00:00.000Z",
				finishedAt: "2026-09-01T10:00:20.000Z",
			}],
			{ judgeOnly: true },
		);
		// The Target's recorded spend belongs to the run that earned it.
		expect(facts).toMatchObject({ runs: 0, costUsd: null, judgeCostUsd: 0.04, durationMs: 20_000 });
	});

	it("sends a re-score longer than a minute to the background", async () => {
		const shown: string[] = [];
		const jobs = createBuilderJobs({
			host: {
				setStatus: () => undefined,
				show: (block) => shown.push(block.lines.join(" ")),
				note: () => undefined,
				waitForIdle: async () => undefined,
			},
			env: {},
			setInterval: () => ({ unref: () => undefined }),
			clearInterval: () => undefined,
		});
		let finished = false;
		await jobs.start({
			command: "regrade",
			label: () => "the re-score",
			async run({ authorized }) {
				authorized({
					kind: "regrade",
					estimate: { executions: 400, sampledRuns: 60, costUsd: 0.4, minutes: 3 },
				});
				await new Promise((resolve) => setTimeout(resolve, 5));
				finished = true;
				return null;
			},
			present: async () => "",
		});
		// The command returned while the measurement was still running.
		expect(finished).toBe(false);
		expect(shown.join("\n")).toContain("the re-score");
		jobs.dispose();
	});
});

describe("the persona knows what to do when the judge is disputed", () => {
	const persona = readFileSync(new URL("../builders/ahde/AGENTS.md", import.meta.url), "utf8");
	const evals = readFileSync(new URL("../builders/ahde/skills/design-evals/SKILL.md", import.meta.url), "utf8");

	it("fixes the rubric and re-scores instead of re-running the agent", () => {
		const loop = persona.split("## Typical loop")[1] ?? "";
		expect(loop).toContain("says the judge is too strict or too\n   lenient");
		expect(loop).toContain("the answer is\n   never a new run");
		expect(loop).toContain("request `regrade`");
		expect(loop).toContain("the agent was not called again and only the\n   judge was paid");
		expect(loop).toContain("ask whether to publish the\n   revised graders");
		expect(loop).toContain("Never present a re-score as a new baseline");
		expect(evals).toContain("kind: regrade");
		expect(evals).toContain("fix the rubric, do not re-run the\n   agent");
		expect(evals).toContain("A re-score is never a new baseline");
	});

	it("gives the operator a word for it", () => {
		const table = persona.split("## Vocabulary")[1]?.split("\n## ")[0] ?? "";
		expect(table).toContain("| пересчитать · re-score |");
		expect(table).toContain("no agent call, only the judge, and never a new baseline");
	});
});
