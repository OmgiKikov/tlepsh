import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderConfirmation } from "../src/builder/render/confirmation.js";
import { renderDecision } from "../src/builder/render/decision.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { importCorpus, listCorpora, loadCorpus } from "../src/corpus.js";
import { setLanguage } from "../src/i18n.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import {
	listSealedSynthReceipts,
	recordSealedSynthReviewImport,
	sealedExamOrigin,
} from "../src/application/sealed-synth.js";
import type { AgentSpec } from "../src/spec.js";
import {
	createAhdeWorkbench,
	type AhdeWorkbench,
	type WorkbenchConfirmation,
	type WorkbenchHumanGate,
} from "../src/workbench/index.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

const NOW = "2026-09-01T09:00:00.000Z";
const PROJECT = "test-target";
/**
 * Every generated case carries this. It must reach exactly one place — the
 * sealed corpus content — and nothing else: not the decision result, not the
 * panel, not the model note, not the confirmation, not the passport.
 */
const SENTINEL = "ZZ-GENERATED-CASE-SENTINEL-ZZ";
const roots: string[] = [];
const mocks: MockModelHandle[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	setLanguage("en");
	for (const root of roots.splice(0)) cleanup(root);
	for (const mock of mocks.splice(0)) await mock.close();
});

function spec(): AgentSpec {
	return {
		schemaVersion: 1,
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
}

interface RecordingGate extends WorkbenchHumanGate {
	confirmations: WorkbenchConfirmation[];
}

function gate(approved = true): RecordingGate {
	const confirmations: WorkbenchConfirmation[] = [];
	return {
		confirmations,
		confirm: async (confirmation) => {
			confirmations.push(confirmation);
			return { approved, ...(approved ? { actorId: "local:test-human" } : {}) };
		},
		selectSealed: async () => ({ approved: false }),
	};
}

const DEV_CASES = [
	{ id: "task_001", input: "Проверь договор 42 и ограничения ДБО.", graders: [{ type: "output_contains", text: "договор" }] },
	{ id: "task_002", input: "Классифицируй обращение: жалоба на списание.", graders: [{ type: "output_contains", text: "жалоба" }] },
	{ id: "task_003", input: "Объясни клиенту сроки рассмотрения.", graders: [{ type: "output_contains", text: "срок" }] },
];

function manifest(judge: { provider: string; id: string; baseUrl: string } | null): string {
	return `id: ${PROJECT}
model:
  provider: qwen-internal
  id: qwen3.5-27b
  api: openai-completions
  baseUrl: http://127.0.0.1:9901/v1
  apiKeyEnv: TEST_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 300000
instructions:
  agentsMd: AGENTS.md
skills: [skills/check-dbo]
evalSuite:
  id: test-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
${judge
		? `  judge:
    provider: ${judge.provider}
    id: ${judge.id}
    api: openai-completions
    baseUrl: ${judge.baseUrl}
    apiKeyEnv: TEST_JUDGE_KEY
    thinkingLevel: "off"
    timeoutMs: 300000
    spec:
      cost:
        input: 3
        output: 15
`
		: ""}`;
}

/** `count` distinct generated cases, every one carrying the sentinel. */
function generated(count: number): string {
	return JSON.stringify({
		cases: Array.from({ length: count }, (_unused, index) => ({
			// An id the host must ignore: a model never names a case.
			id: `model-chosen-${index}`,
			input: `${SENTINEL} синтетический запрос ${index + 1}`,
			graders: [{ type: "output_contains", text: "срок" }],
		})),
	});
}

/**
 * A judge that answers the count it was asked for, but loses cases on the way
 * in: one repeats a development input, one has no input at all.
 */
function generatedWithLosses(count: number): string {
	const cases: unknown[] = [
		{ id: "dup", input: DEV_CASES[0]!.input, graders: [{ type: "output_contains", text: "срок" }] },
		{ id: "broken", graders: [{ type: "output_contains", text: "срок" }] },
	];
	const good = count - cases.length;
	for (let index = 0; index < good; index += 1) {
		cases.push({
			id: `model-chosen-${index}`,
			input: `${SENTINEL} синтетический запрос ${index + 1}`,
			graders: [{ type: "output_contains", text: "срок" }],
		});
	}
	return JSON.stringify({ cases });
}

async function mockJudge(text: string): Promise<MockModelHandle> {
	const mock = await startMockModel([{ match: () => true, steps: [{ text }] }]);
	mocks.push(mock);
	return mock;
}

interface Project {
	workbench: AhdeWorkbench;
	projectDir: string;
	stateRoot: string;
	runsRoot: string;
}

async function project(options: {
	judge?: { provider: string; id: string; baseUrl: string } | null;
	approveSpec?: boolean;
} = {}): Promise<Project> {
	const projectDir = makeTargetFixture(baseFixtureFiles({
		"manifest.yaml": manifest(options.judge ?? null),
		"evals/development.jsonl": `${DEV_CASES.map((task) => JSON.stringify(task)).join("\n")}\n`,
		".gitignore": ".ahde/\nruns/\n",
	}));
	roots.push(projectDir);
	const paths = { projectDir, stateRoot: join(projectDir, ".ahde"), runsRoot: join(projectDir, "runs") };
	const workbench = createAhdeWorkbench({ ...paths, projectId: PROJECT, dependencies: { now: () => NOW } });
	if (options.approveSpec !== false) {
		await workbench.submit({ kind: "spec-draft", spec: spec() });
		await workbench.decide({ kind: "approve-spec", reason: "Approve the exact contract" }, gate());
	}
	return { workbench, ...paths };
}

describe("generate-holdout: the exam the judge writes", () => {
	it("seals the generated cases and hands back a count, a model and a hash", async () => {
		const mock = await mockJudge(generated(18));
		const { workbench, stateRoot } = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		const human = gate();

		const result = await workbench.decide(
			{ kind: "generate-holdout", cases: 18, mode: "seal", reason: "no data to hold out" },
			human,
		);

		expect(result.kind).toBe("generate-holdout");
		if (result.kind !== "generate-holdout") throw new Error("wrong kind");
		expect(result.result.cases).toBe(18);
		expect(result.result.generator).toBe("fixture-provider/fixture-judge");
		expect(result.result.promptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(result.result.reviewPath).toBeUndefined();
		expect(result.result.corpusId).toMatch(/^corpus-[0-9a-f]{64}$/);

		// The exam exists, is sealed, and holds exactly what was generated.
		const sealed = listCorpora({ stateRoot, projectId: PROJECT }).filter((c) => c.visibility === "sealed");
		expect(sealed).toHaveLength(1);
		expect(sealed[0]?.name).toBe("Sealed exam (written by the judge)");
		const loaded = loadCorpus({ stateRoot, projectId: PROJECT, corpusId: sealed[0]!.id });
		expect(loaded.tasks).toHaveLength(18);
		// Ids are host-derived: the model's own are discarded on sight.
		for (const task of loaded.tasks) expect(task.id).toMatch(/^synth-[0-9a-f]{24}$/);

		// The receipt records the shape of the run and none of its content.
		const receipts = listSealedSynthReceipts(stateRoot, PROJECT);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]?.outcome).toMatchObject({ kind: "sealed", corpusId: sealed[0]!.id, taskCount: 18 });
		expect(JSON.stringify(receipts[0])).not.toContain(SENTINEL);
	});

	it("writes a draft outside the Target's own tree, 0600, and seals nothing", async () => {
		const mock = await mockJudge(generated(16));
		const { workbench, projectDir, stateRoot } = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});

		const result = await workbench.decide(
			{ kind: "generate-holdout", cases: 16, mode: "review", reason: "let me read them first" },
			gate(),
		);
		if (result.kind !== "generate-holdout") throw new Error("wrong kind");

		const path = result.result.reviewPath;
		expect(path).toBeDefined();
		expect(result.result.corpusId).toBeUndefined();
		expect(result.result.cases).toBe(16);
		// Private state, not the Target proper: a Harness snapshot carries the
		// declared resources, and `.ahde` is neither declared nor committed.
		expect(path!.startsWith(join(stateRoot, "projects", PROJECT, "sealed-synth"))).toBe(true);
		expect(path!.startsWith(join(projectDir, "evals"))).toBe(false);
		expect(statSync(path!).mode & 0o777).toBe(0o600);
		const drafted = readFileSync(path!, "utf8").trim().split("\n");
		expect(drafted).toHaveLength(16);
		// Nothing was sealed: the operator has not vouched for these yet.
		expect(listCorpora({ stateRoot, projectId: PROJECT }).filter((c) => c.visibility === "sealed")).toEqual([]);
		expect(listSealedSynthReceipts(stateRoot, PROJECT)[0]?.outcome).toMatchObject({ kind: "review", caseCount: 16 });
	});

	it("refuses before a token is spent when there is no judge, or the judge is the Target's own model", async () => {
		const noJudge = await project({ judge: null });
		await expect(noJudge.workbench.decide(
			{ kind: "generate-holdout", cases: 20, mode: "seal", reason: "try it" },
			gate(),
		)).rejects.toThrow(/no judge configured, and the judge is the generator/);

		const twin = await project({
			// Same provider and id as the Target's own model, on any endpoint.
			judge: { provider: "qwen-internal", id: "qwen3.5-27b", baseUrl: "http://127.0.0.1:9902/v1" },
		});
		await expect(twin.workbench.decide(
			{ kind: "generate-holdout", cases: 20, mode: "seal", reason: "try it" },
			gate(),
		)).rejects.toThrow(/is the Target's own model/);

		// Neither one asked the human anything: a refusal is not a question.
		const human = gate();
		await expect(noJudge.workbench.decide(
			{ kind: "generate-holdout", cases: 20, mode: "seal", reason: "try it" },
			human,
		)).rejects.toThrow();
		expect(human.confirmations).toEqual([]);
	});

	it("refuses an exam too small to produce a verdict, and one with no Spec to write from", async () => {
		const mock = await mockJudge(generated(20));
		const small = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		// 15 is the sealed guardrail's floor; below it the exam can only ever say
		// `underpowered`, so the schema refuses it rather than spending on it.
		await expect(small.workbench.decide(
			{ kind: "generate-holdout", cases: 14, mode: "seal", reason: "just a few" },
			gate(),
		)).rejects.toThrow();
		await expect(small.workbench.decide(
			{ kind: "generate-holdout", cases: 201, mode: "seal", reason: "all of them" },
			gate(),
		)).rejects.toThrow();

		const unspecified = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
			approveSpec: false,
		});
		await expect(unspecified.workbench.decide(
			{ kind: "generate-holdout", cases: 20, mode: "seal", reason: "no contract yet" },
			gate(),
		)).rejects.toThrow(/no Spec to write an exam from|not legal during/);
	});

	it("puts the model, the source, the blindness and the price in the dialog, and no case anywhere", async () => {
		const mock = await mockJudge(generated(20));
		const { workbench } = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		const human = gate();

		const result = await workbench.decide(
			{ kind: "generate-holdout", cases: 20, mode: "seal", reason: "no data to hold out" },
			human,
		);

		expect(human.confirmations).toHaveLength(1);
		const confirmation = human.confirmations[0]!;
		expect(confirmation.policy).toBe("consequential");
		expect(confirmation.title).toBe("Have the judge write a sealed exam");
		const body = renderConfirmation(confirmation, plainPaint);
		expect(body.slice(0, 4)).toEqual([
			"Exam 20 cases · written by the judge fixture-provider/fixture-judge",
			"Source the agent's description + 3 examples from the tests (shape only)",
			"The Builder never sees the content; only the case count reaches the conversation",
			expect.stringMatching(/^Cost (~\$\d+\.\d\d|<\$0\.01)$/),
		]);
		expect(body).toContain("Reason no data to hold out");
		expect(body.at(-1)).toBe(`Exact subject ${confirmation.subjectHash}`);
		// The subject is the plan, and a plan has no cases in it.
		expect(JSON.stringify(confirmation.subject)).not.toContain(SENTINEL);

		if (result.kind !== "generate-holdout") throw new Error("wrong kind");
		const panel = renderDecision(result, plainPaint);
		expect(panel[0]).toBe("Exam created 20 cases · written by the judge fixture-provider/fixture-judge");
		expect(panel[1]).toBe("Nobody in the improvement loop reads these cases; the exam stays evaluator-only.");
		expect(panel.join("\n")).not.toContain(SENTINEL);
		expect(result.message).not.toContain(SENTINEL);
		expect(JSON.stringify(result)).not.toContain(SENTINEL);
	});

	it("speaks Russian in the dialog and in the panel, with the same four facts", async () => {
		const mock = await mockJudge(generated(20));
		const { workbench } = await project({
			judge: { provider: "openrouter", id: "anthropic/claude-sonnet-4.5", baseUrl: mock.url },
		});
		const human = gate();
		setLanguage("ru");

		const result = await workbench.decide(
			{ kind: "generate-holdout", cases: 20, mode: "review", reason: "нет данных для экзамена" },
			human,
		);

		const body = renderConfirmation(human.confirmations[0]!, plainPaint);
		expect(body.slice(0, 3)).toEqual([
			"Экзамен 20 кейсов · генерирует судья openrouter/anthropic/claude-sonnet-4.5",
			"Источник описание агента + 3 примера из тестов (только форма)",
			"Builder содержимого не увидит; в разговор попадёт только число кейсов",
		]);
		expect(body[3]).toMatch(/^Стоимость (~\$\d+\.\d\d|<\$0\.01)$/);
		// The draft path gets one more line, because it changes what happens next.
		expect(body[4]).toBe("Черновик — в файл вне репо; правишь и загружаешь командой /holdout <путь>");
		expect(body).toContain("Причина нет данных для экзамена");

		if (result.kind !== "generate-holdout") throw new Error("wrong kind");
		const panel = renderDecision(result, plainPaint);
		expect(panel[0]).toBe("Черновик экзамена готов 20 кейсов · генерирует судья openrouter/anthropic/claude-sonnet-4.5");
		// The path is the point of the line, so it is printed whole.
		expect(panel[1]).toBe(`Черновик ${result.result.reviewPath}`);
		expect(panel[1]).not.toContain(SENTINEL);
		expect(panel[2]).toBe("Прочитай, вычисти лишнее, потом /holdout <путь к этому файлу> закроет его.");
		expect(panel.join("\n")).not.toContain(SENTINEL);
	});

	it("says on the panel how many cases came back and what was dropped", async () => {
		const mock = await mockJudge(generatedWithLosses(20));
		const { workbench } = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});

		const result = await workbench.decide(
			{ kind: "generate-holdout", cases: 20, mode: "seal", reason: "no data to hold out" },
			gate(),
		);
		if (result.kind !== "generate-holdout") throw new Error("wrong kind");

		// 20 asked for, two lost: an exam of 18 that must not read as "wrote 18".
		expect(result.result).toMatchObject({ cases: 18, requested: 20, dropped: { malformed: 1, duplicate: 1 } });
		const panel = renderDecision(result, plainPaint);
		expect(panel[0]).toBe("Exam created 18 cases · written by the judge fixture-provider/fixture-judge");
		expect(panel[1]).toBe("Exam 18 of 20 requested · 1 duplicate dropped · 1 malformed case dropped");
		// The Builder reads the same arithmetic, never a rounder number.
		expect(result.message).toContain("20 were asked for; 2 did not survive validation");
		expect(panel.join("\n")).not.toContain(SENTINEL);

		setLanguage("ru");
		const russian = renderDecision(result, plainPaint);
		expect(russian[1]).toBe("Экзамен 18 из 20 запрошенных · отброшено дубликатов: 1 · отброшено с ошибкой формы: 1");
	});

	it("records how the exam came to exist, and tells a sealed one from a reviewed one", async () => {
		const sealMock = await mockJudge(generated(18));
		const sealed = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: sealMock.url },
		});
		const straight = await sealed.workbench.decide(
			{ kind: "generate-holdout", cases: 18, mode: "seal", reason: "no data" },
			gate(),
		);
		if (straight.kind !== "generate-holdout") throw new Error("wrong kind");
		expect(sealedExamOrigin(sealed.stateRoot, PROJECT, straight.result.corpusId!)).toBe("judge-generated");
		// An exam the operator brought is theirs; this module says nothing about it.
		expect(sealedExamOrigin(sealed.stateRoot, PROJECT, `corpus-${"f".repeat(64)}`)).toBeNull();
		expect(sealedExamOrigin(sealed.stateRoot, PROJECT, null)).toBeNull();

		// The draft path, followed all the way: a human reads the file and seals
		// it, and that is a different sentence on the passport.
		const draftMock = await mockJudge(generated(16));
		const drafted = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: draftMock.url },
		});
		const draft = await drafted.workbench.decide(
			{ kind: "generate-holdout", cases: 16, mode: "review", reason: "let me read them" },
			gate(),
		);
		if (draft.kind !== "generate-holdout") throw new Error("wrong kind");
		const imported = importCorpus({
			stateRoot: drafted.stateRoot,
			projectId: PROJECT,
			name: "Promotion holdout",
			visibility: "sealed",
			sourcePath: draft.result.reviewPath!,
		});
		expect(sealedExamOrigin(drafted.stateRoot, PROJECT, imported.id)).toBeNull();
		recordSealedSynthReviewImport({
			stateRoot: drafted.stateRoot,
			projectId: PROJECT,
			sourcePath: draft.result.reviewPath!,
			corpus: imported,
		});
		expect(sealedExamOrigin(drafted.stateRoot, PROJECT, imported.id)).toBe("judge-generated-reviewed");
		// Recording it twice is the same immutable fact, not two of them.
		recordSealedSynthReviewImport({
			stateRoot: drafted.stateRoot,
			projectId: PROJECT,
			sourcePath: draft.result.reviewPath!,
			corpus: imported,
			now: () => NOW,
		});
		expect(listSealedSynthReceipts(drafted.stateRoot, PROJECT)).toHaveLength(2);

		// A file nobody generated records nothing at all.
		expect(recordSealedSynthReviewImport({
			stateRoot: drafted.stateRoot,
			projectId: PROJECT,
			sourcePath: join(drafted.projectDir, "evals", "development.jsonl"),
			corpus: imported,
		})).toBeNull();

		// Whatever else these receipts hold, it is never a case.
		const everything = JSON.stringify([
			listSealedSynthReceipts(sealed.stateRoot, PROJECT),
			listSealedSynthReceipts(drafted.stateRoot, PROJECT),
		]);
		expect(everything).not.toContain(SENTINEL);
	});

	it("refuses a declined dialog and a subject that moved while the human read it", async () => {
		const mock = await mockJudge(generated(20));
		const declined = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		await expect(declined.workbench.decide(
			{ kind: "generate-holdout", cases: 20, mode: "seal", reason: "no data" },
			gate(false),
		)).rejects.toThrow(/declined/i);
		expect(listCorpora({ stateRoot: declined.stateRoot, projectId: PROJECT })).toEqual([]);

		// The plan is re-read after the dialog: a Spec that changed underneath it
		// would ask the generator a question nobody approved.
		const moved = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		let calls = 0;
		const workbench = createAhdeWorkbench({
			projectDir: moved.projectDir,
			stateRoot: moved.stateRoot,
			runsRoot: moved.runsRoot,
			projectId: PROJECT,
			dependencies: {
				now: () => NOW,
				planSealedSynthesis: (options) => {
					calls += 1;
					return {
						generatorModel: "fixture-provider/fixture-judge",
						generatorHash: "sha256:".padEnd(71, "a"),
						promptSha256: `sha256:${String(calls).padEnd(64, "b")}`,
						promptBytes: 1_000,
						specSource: "approved-spec" as const,
						specId: null,
						specSha256: "sha256:".padEnd(71, "c"),
						examples: 3,
						developmentExampleIds: ["task_001"],
						requested: options.count,
						seed: null,
						reviewPath: null,
						estimatedCostUsd: 0.12,
					};
				},
			},
		});
		await expect(workbench.decide(
			{ kind: "generate-holdout", cases: 20, mode: "seal", reason: "no data" },
			gate(),
		)).rejects.toThrow(/changed|stale/i);
		expect(calls).toBe(2);
	});
});
