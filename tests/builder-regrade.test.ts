import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listBuilderCorpusDrafts } from "../src/application/builder-corpus-draft.js";
import {
	compileRegradeDiff,
	planRegradeGraders,
	projectCandidateRegrade,
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
import { renderCandidate } from "../src/builder/render/view.js";
import { loadEvalRun, loadRun, runSuite, writeEvalRun, type EvalRunRecord } from "../src/eval.js";
import { setLanguage } from "../src/i18n.js";
import { loadTarget, type GraderSpec } from "../src/manifest.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import { hashValue, RunRecordSchema, type RunRecord } from "../src/provenance.js";
import { regradeEvalRun } from "../src/regrade.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";
import type { AhdeWorkbench } from "../src/workbench/index.js";
import {
	assertWorkbenchDecisionStage,
	workbenchDecisionStages,
	workbenchGateClass,
} from "../src/workbench/transition-policy.js";
import type { WorkbenchDecisionResult } from "../src/workbench/types.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";
import {
	cleanupPaths,
	DEVELOPMENT_BASELINE_EVAL,
	DEVELOPMENT_CANDIDATE_EVAL,
	gate,
	PROJECT_ID,
	terminalCandidateFixture,
	type CycleFixture,
} from "./helpers/cycle-fixtures.js";

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

	it("draws a candidate's whole comparison when both arms were re-scored", () => {
		const baseline: RegradeDiff = { ...diff, passRateBefore: 0.25, passRateAfter: 0.5, nowPassing: 1, nowFailing: 0, unchanged: 3 };
		const paired: RegradeDiff = { ...diff, pairedBaseline: baseline };
		try {
			setLanguage("en");
			// The recorded comparison, then the same comparison under the new
			// rubric, then what moved across both arms — never one arm alone.
			expect(renderRegrade(paired, plainPaint)).toContain(
				"On the new rubric development 25% → 50% became 50% → 75% (↑3 ↓1 =4) · exam unchanged",
			);
			setLanguage("ru");
			expect(renderRegrade(paired, plainPaint)).toContain(
				"На новой рубрике разработка 25% → 50% стало 50% → 75% (↑3 ↓1 =4) · экзамен без изменений",
			);
		} finally {
			setLanguage(null);
		}
		// A single-arm re-score keeps exactly the panel it had.
		expect(renderRegrade(diff, plainPaint).some((line) => line.includes("became"))).toBe(false);
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

describe("reading a candidate's arms back after a re-score", () => {
	const derived = (evalRunId: string, regradeOf: string, suiteHash: string, finishedAt: string, pass: number) => ({
		evalRunId,
		regradeOf,
		suiteHash,
		finishedAt,
		runIds: [],
		summary: { total: 1, pass, fail: 1 - pass, error: 0, allPassRate: pass },
	});
	const runsRoot = "/nowhere";
	const arms = { baselineEvalRunId: "erun_base", candidateEvalRunId: "erun_cand" };

	it("takes the newest re-score of each arm", () => {
		expect(projectCandidateRegrade({
			runsRoot,
			evals: [
				derived("erun_r1", "erun_base", "sha256:x", "2026-09-01T10:00:00.000Z", 0),
				derived("erun_r2", "erun_base", "sha256:x", "2026-09-01T11:00:00.000Z", 1),
				derived("erun_r3", "erun_cand", "sha256:x", "2026-09-01T11:00:00.000Z", 0),
			],
			...arms,
		})).toMatchObject({
			baselineEvalRunId: "erun_r2",
			candidateEvalRunId: "erun_r3",
			baselinePassRate: 1,
			candidatePassRate: 0,
		});
	});

	it("shows nothing when one arm is missing or the two were scored differently", () => {
		// One arm alone is not a comparison.
		expect(projectCandidateRegrade({
			runsRoot,
			evals: [derived("erun_r1", "erun_cand", "sha256:x", "2026-09-01T10:00:00.000Z", 0)],
			...arms,
		})).toBeNull();
		// Two arms under two rubrics are not one either.
		expect(projectCandidateRegrade({
			runsRoot,
			evals: [
				derived("erun_r1", "erun_base", "sha256:x", "2026-09-01T10:00:00.000Z", 0),
				derived("erun_r2", "erun_cand", "sha256:y", "2026-09-01T10:00:00.000Z", 0),
			],
			...arms,
		})).toBeNull();
	});
});

describe("the re-score as a Builder decision", () => {
	it("is routine measurement, legal wherever a rubric and a recorded run meet", () => {
		expect(workbenchGateClass("regrade")).toBe("routine");
		expect(workbenchDecisionStages("regrade")).toEqual([
			"corpus-review",
			"ready-to-evaluate",
			"improvement-authoring",
			// Where the operator argues with the judge in front of a verdict.
			"candidate-review",
		]);
		expect(() => assertWorkbenchDecisionStage("regrade", "corpus-review")).not.toThrow();
		expect(() => assertWorkbenchDecisionStage("regrade", "candidate-review")).not.toThrow();
		expect(() => assertWorkbenchDecisionStage("regrade", "target-setup")).toThrow(/not legal during/);
	});

	it("refuses to publish a revision at candidate-review by naming the door instead", () => {
		expect(() => assertWorkbenchDecisionStage("publish-corpus", "candidate-review"))
			.toThrow(/publish-corpus is not legal during candidate-review\./);
		// Not the stage machine's generic “read the evidence, then say ship it”:
		// the operator revising a rubric needs the one action that reads it.
		try {
			setLanguage("en");
			expect(() => assertWorkbenchDecisionStage("publish-corpus", "candidate-review")).toThrow(
				"Revised graders are read here by re-scoring, not by publishing: request `regrade`, " +
				"which re-scores the recorded answers of both development arms with them and pays only the judge. " +
				"Publishing waits until this candidate is shipped or rejected; the revised draft survives that.",
			);
			setLanguage("ru");
			expect(() => assertWorkbenchDecisionStage("publish-corpus", "candidate-review"))
				.toThrow(/попроси `regrade`/);
		} finally {
			setLanguage(null);
		}
		// Every other stage keeps the plain rule and its unblocking action.
		expect(() => assertWorkbenchDecisionStage("publish-corpus", "target-setup"))
			.toThrow(/expected corpus-review or candidate-verification\. Do this first:/);
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

	it("fixes the rubric and re-scores instead of re-running the agent", () => {
		const loop = persona.split("## Typical loop")[1] ?? "";
		expect(loop).toContain("says the judge is too strict or too\n   lenient");
		expect(loop).toContain("the answer is\n   never a new run");
		expect(loop).toContain("request `regrade`");
		expect(loop).toContain("the agent was not called again and only the\n   judge was paid");
		expect(loop).toContain("ask whether to publish the\n   revised graders");
		expect(loop).toContain("Never present a re-score as a new baseline");
		expect(loop).toContain('`kind: "regrade", graders: "draft"`');
	});

	it("gives the operator a word for it", () => {
		const table = persona.split("## Vocabulary")[1]?.split("\n## ")[0] ?? "";
		expect(table).toContain("| пересчитать · re-score |");
		expect(table).toContain("no agent call, only the judge, and never a new baseline");
		// Whose decision it is, and where `/regrade` lives — the two things the
		// Builder guessed wrong in front of a real operator.
		expect(table).toContain("a decision you submit (`ahde_workbench_decide`, `kind: \"regrade\"`)");
		expect(table).toContain("the operator's `/regrade` in this same TUI");
	});

	it("knows the re-score is its own to submit, and that a candidate needs both arms", () => {
		const loop = persona.split("## Typical loop")[1] ?? "";
		expect(loop).toContain("`kind: \"regrade\", graders: \"draft\"`");
		expect(loop).toContain("It is never “outside Builder Pi”.");
		expect(loop).toContain("re-scores both\n   development arms with the one revised rubric");
		expect(loop).toContain("the sealed exam is untouched");
		expect(loop).toContain("Never reject a candidate to unblock\n   a re-score, and never publish in order to read one");
	});
});

/**
 * A regrade engine that never grades. It copies each recorded run into a
 * derived EvalRun and fails it — which is what a hardened rubric does — and
 * writes real artifacts, because the diff, the panel and the review line all
 * read the two immutable EvalRuns rather than this return value.
 */
function failingRegrade(calls: { evalRunId: string; suiteHash: string }[]): typeof regradeEvalRun {
	return async ({ runsRoot, evalRunId, target }) => {
		calls.push({ evalRunId, suiteHash: target.suiteHash });
		const source = loadEvalRun(runsRoot, evalRunId);
		const derivedEvalRunId = `erun_regrade_${calls.length}`;
		const derivedRuns = source.runIds.map((sourceRunId) => {
			const before = loadRun(runsRoot, sourceRunId);
			const runId = `run-${derivedEvalRunId}-${sourceRunId}`;
			const after: RunRecord = {
				...before,
				runId,
				label: "regrade",
				eval: { ...before.eval, suiteHash: target.suiteHash },
				evalResults: {
					outcome: "fail",
					graders: (before.evalResults?.graders ?? []).map((grader) => ({
						...grader,
						passed: false,
						score: 0,
						reason: "the hardened rubric refused it",
					})),
				},
				parent: { evalRunId: derivedEvalRunId, candidateOf: null },
				derivedFrom: { evalRunId: source.evalRunId, runId: sourceRunId },
			};
			mkdirSync(join(runsRoot, runId), { recursive: true });
			copyFileSync(join(runsRoot, sourceRunId, "session.jsonl"), join(runsRoot, runId, "session.jsonl"));
			writeJsonArtifact(join(runsRoot, runId, "run.json"), RunRecordSchema, after);
			return after;
		});
		const provenance = { ...source.provenance, suiteHash: target.suiteHash };
		const record: EvalRunRecord = {
			...source,
			evalRunId: derivedEvalRunId,
			label: "regrade",
			regradeOf: source.evalRunId,
			suiteHash: target.suiteHash,
			provenance,
			provenanceKey: hashValue(provenance),
			runIds: derivedRuns.map((run) => run.runId),
			runArtifacts: derivedRuns.map((run) => ({ runId: run.runId, sha256: hashValue(run) })),
			summary: {
				total: derivedRuns.length,
				pass: 0,
				fail: derivedRuns.length,
				error: 0,
				allPassRate: 0,
			},
		};
		writeEvalRun(runsRoot, record);
		return { record, source, flips: [], judge: { calls: 0, tokens: 0, costUsd: 0 }, sealed: false };
	};
}

/**
 * The re-score where it was impossible: a candidate is on screen, its verdict
 * rests on a judge the operator has just called too lenient, and the rubric
 * they rewrote has to be read against answers that are already paid for.
 *
 * Both arms or nothing: re-scoring only the candidate would compare it against
 * a baseline that never faced the new rule.
 */
describe("re-scoring what a candidate is being judged on", () => {
	let fixture: CycleFixture | undefined;
	/** Every call the Workbench made to the regrade engine, in order. */
	const calls: { evalRunId: string; suiteHash: string }[] = [];
	const reviewGate = gate();
	let revision: Awaited<ReturnType<AhdeWorkbench["submit"]>>;
	let regraded: Extract<WorkbenchDecisionResult, { kind: "regrade" }>;

	/** The rubric the operator hardened after reading the candidate's evidence. */
	const HARDENED: GraderSpec[] = [{ type: "output_matches", pattern: "^30 calendar days$" }];

	beforeAll(async () => {
		fixture = await terminalCandidateFixture(
			"evaluated",
			{ regradeEvalRun: failingRegrade(calls) },
			// The recorded comparison the operator is arguing with: the baseline
			// failed the one case and the candidate passed it.
			{ baseline: "fail", candidate: "pass" },
		);
		const draft = listBuilderCorpusDrafts(fixture.stateRoot, PROJECT_ID)[0]!;
		revision = await fixture.workbench.submit({
			kind: "corpus-revision",
			operations: [{ type: "set-graders", taskId: draft.tasks[0]!.id, graders: HARDENED }],
			revisionSummary: "The judge was too lenient: demand the exact policy wording",
		});
		const decision = await fixture.workbench.decide(
			{ kind: "regrade", graders: "draft", reason: "Re-score the recorded answers on the hardened rubric" },
			reviewGate,
		);
		if (decision.kind !== "regrade") throw new Error("expected a regrade decision");
		regraded = decision;
	}, SUITE_TIMEOUT_MS);

	afterAll(() => {
		cleanupPaths(fixture);
	});

	it("says what the revision is for, right where publishing is impossible", () => {
		expect(revision.view.stage).toBe("candidate-review");
		expect(revision.message).toBe(
			"New immutable corpus-draft revision saved. " +
			"A candidate is under review, so this revision is not published yet: request `regrade` to re-score " +
			"the recorded answers of both arms (judge only). " +
			"Publishing waits until the candidate is shipped or rejected.",
		);
	});

	it("re-scores both arms with one rubric, in comparison order", () => {
		expect(calls.map((call) => call.evalRunId)).toEqual([
			DEVELOPMENT_BASELINE_EVAL,
			DEVELOPMENT_CANDIDATE_EVAL,
		]);
		// One plan, one scoring identity: that is what keeps the two arms
		// comparable with each other and out of the basket they came from.
		expect(new Set(calls.map((call) => call.suiteHash)).size).toBe(1);
	});

	it("prices both arms in the one question it asks", () => {
		const confirmation = reviewGate.confirm.mock.calls[0]?.[0];
		expect(confirmation?.kind).toBe("regrade");
		expect(confirmation?.subject).toMatchObject({
			operation: "regrade",
			graders: "draft",
			changedGraders: 1,
			targetExecutions: 0,
			sources: [
				{ evalRunId: DEVELOPMENT_BASELINE_EVAL, runs: 1 },
				{ evalRunId: DEVELOPMENT_CANDIDATE_EVAL, runs: 1 },
			],
		});
		expect(confirmation?.question).toContain("2 recorded answers");
		expect(confirmation?.estimate?.executions).toBe(2);
	});

	it("reports the comparison before and after, and says the exam did not move", () => {
		expect(regraded.message).toBe(
			"Re-scored 2 recorded answers across both development arms with the revised graders: " +
			"development 0% → 100% became 0% → 0%. The Target was not called; only the judge was paid. " +
			"Both development arms were re-scored with the same revised graders, so they still compare; " +
			"the sealed exam is untouched, because its graders belong to the judge and stay evaluator-only. " +
			"This is a re-score, not a new baseline.",
		);
		// The result is the candidate arm, carrying the arm it is measured against.
		expect(regraded.result.sourceEvalRunId).toBe(DEVELOPMENT_CANDIDATE_EVAL);
		expect(regraded.result.passRateBefore).toBe(1);
		expect(regraded.result.passRateAfter).toBe(0);
		expect(regraded.result.pairedBaseline).toMatchObject({
			sourceEvalRunId: DEVELOPMENT_BASELINE_EVAL,
			passRateBefore: 0,
			passRateAfter: 0,
			nowPassing: 0,
			nowFailing: 0,
			unchanged: 1,
		});
		expect(regraded.result.nowFailing).toBe(1);
		expect(regraded.result.targetExecutions).toBe(0);
		expect(regraded.view.stage).toBe("candidate-review");
	});

	it("carries the re-score onto the candidate review, in both languages", async () => {
		const view = await fixture!.workbench.view({ aspect: "review" });
		if (view.detail?.aspect !== "review" || view.detail.content.kind !== "candidate") {
			throw new Error("expected the candidate review");
		}
		const content = view.detail.content;
		expect(content.regraded).toMatchObject({
			baselineEvalRunId: expect.stringContaining("erun_regrade_"),
			candidateEvalRunId: expect.stringContaining("erun_regrade_"),
			baselinePassRate: 0,
			candidatePassRate: 0,
			nowPassing: 0,
			nowFailing: 1,
			unchanged: 1,
		});
		try {
			setLanguage("en");
			const english = renderCandidate(content, plainPaint);
			// Beside the recorded verdict, never instead of it.
			expect(english.join("\n")).toContain("Development improved · score 0% → 100% (+100 pts, 95% CI +100 … +100) on 15 cases × 2 · pass rate 0% → 100%");
			expect(english).toContain("On the new rubric development 0% → 100% became 0% → 0% (↑0 ↓1 =1) · exam unchanged");
			setLanguage("ru");
			expect(renderCandidate(content, plainPaint)).toContain(
				"На новой рубрике разработка 0% → 100% стало 0% → 0% (↑0 ↓1 =1) · экзамен без изменений",
			);
		} finally {
			setLanguage(null);
		}
	});

	it("re-scores one run when the operator names one that is not an arm", async () => {
		const before = calls.length;
		const named = await fixture!.workbench.decide(
			{ kind: "regrade", graders: "draft", evalRunId: fixture!.evalRunId, reason: "Re-score that other run" },
			gate(),
		);
		if (named.kind !== "regrade") throw new Error("expected a regrade decision");
		expect(calls.slice(before).map((call) => call.evalRunId)).toEqual([fixture!.evalRunId]);
		expect(named.result.pairedBaseline).toBeUndefined();
		expect(named.message).toContain("Re-scored 1 recorded answer with the revised graders");
	});

	it("refuses to publish the revision here, and names the door", async () => {
		await expect(fixture!.workbench.decide(
			{ kind: "publish-corpus", reason: "Publish the hardened basket" },
			gate(),
		)).rejects.toThrow(/request `regrade`, which re-scores the recorded answers of both development arms/);
	});
});
