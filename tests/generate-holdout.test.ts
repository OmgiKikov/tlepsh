import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderConfirmation } from "../src/builder/render/confirmation.js";
import { renderDecision } from "../src/builder/render/decision.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { renderHeader } from "../src/builder/render/view.js";
import { importCorpus, listCorpora, loadCorpus } from "../src/corpus.js";
import { setLanguage } from "../src/i18n.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import { readKnowledgeBase } from "../src/target/kb-tool.js";
import {
	listSealedSynthReceipts,
	normalizedCaseInput,
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

/**
 * Sixteen one-paragraph documents, so every file is exactly one passage and a
 * decision can ask for the guardrail's minimum without the draw capping it.
 */
const KB_PRICES = [450, 470, 490, 510, 530, 550, 570, 590, 610, 630, 650, 670, 690, 710, 730, 750];
const KB_DOCS: Record<string, string> = Object.fromEntries(
	KB_PRICES.map((price, index) => [
		`data/kb/doc-${String(index).padStart(2, "0")}.md`,
		`# Тариф ${index}\n\nТариф номер ${index} стоит ${price} рублей в месяц.\n`,
	]),
);
const KB_CHUNK_IDS = KB_PRICES.map((_price, index) => `doc-${String(index).padStart(2, "0")}.md#0`);

/**
 * Three documents of two long paragraphs each — the shape of a real template's
 * knowledge base. One runtime chunk apiece; two passages apiece once the exam
 * generator halves the geometry, which is what turns three questions into the
 * fifteen the ship gate needs.
 */
const SMALL_KB_DOCS: Record<string, string> = Object.fromEntries(
	["tariffs", "blocking", "visits"].map((name) => [
		`data/kb/${name}.md`,
		`# Раздел ${name}\n\n${`Первый пункт раздела ${name}: ${"слово ".repeat(50)}`.trim()}\n\n` +
			`${`Второй пункт раздела ${name}: ${"буква ".repeat(50)}`.trim()}\n`,
	]),
);

/** One document, one short line: a base nothing can turn into an exam. */
const TINY_KB_DOCS: Record<string, string> = { "data/kb/one.md": "# Тариф\n\nТариф «Река» стоит 750 рублей.\n" };

/**
 * A judge that answers every passage with as many distinct pairs as the prompt
 * asked it for, each carrying the sentinel.
 */
async function mockKbJudge(): Promise<MockModelHandle> {
	const mock = await startMockModel([{
		match: () => true,
		resolve: ({ firstUser }) => {
			const passageId = /# Passage (\S+)/.exec(firstUser)?.[1] ?? "";
			const asked = Number(/Write (\d+) different/.exec(firstUser)?.[1] ?? "1");
			const index = KB_CHUNK_IDS.indexOf(passageId);
			const questions = Array.from({ length: asked }, (_value, question) => ({
				question: index >= 0 && question === 0
					? `${SENTINEL} Сколько стоит тариф номер ${index}?`
					: `${SENTINEL} Что сказано в отрывке ${passageId}? Факт ${question}.`,
				answer: index >= 0 && question === 0
					? `${KB_PRICES[index]} рублей в месяц`
					: `Факт ${question} отрывка ${passageId}`,
			}));
			return { text: JSON.stringify({ questions }) };
		},
		steps: [],
	}]);
	mocks.push(mock);
	return mock;
}

function manifest(judge: { provider: string; id: string; baseUrl: string } | null, declareKb = false): string {
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
${declareKb ? "data: [data/kb]\n" : ""}evalSuite:
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
	/** `true` is sixteen one-paragraph documents; `"small"` three; `"tiny"` one line. */
	kb?: boolean | "small" | "tiny";
} = {}): Promise<Project> {
	const projectDir = makeTargetFixture(baseFixtureFiles({
		"manifest.yaml": manifest(options.judge ?? null, options.kb !== undefined && options.kb !== false),
		"evals/development.jsonl": `${DEV_CASES.map((task) => JSON.stringify(task)).join("\n")}\n`,
		".gitignore": ".ahde/\nruns/\n",
		...(options.kb === true ? KB_DOCS : {}),
		...(options.kb === "small" ? SMALL_KB_DOCS : {}),
		...(options.kb === "tiny" ? TINY_KB_DOCS : {}),
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
			"Source the agent's description alone (no examples)",
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
			"Источник только описание агента (без примеров)",
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
		expect(russian[1]).toBe("Экзамен 18 из 20 запрошенных · отброшено: 1 дубликат · отброшено: 1 кейс с ошибкой формы");
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
						source: options.source ?? ("spec" as const),
						kbIndexHash: null,
						kbChunkChars: null,
						kbChunkIds: [],
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

describe("generate-holdout: the exam the judge writes from the knowledge base", () => {
	it("seals a knowledge-base exam, names the source, and says so on every surface", async () => {
		const mock = await mockKbJudge();
		const { workbench, stateRoot } = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
			kb: true,
		});
		const human = gate();

		const result = await workbench.decide(
			{ kind: "generate-holdout", cases: 16, mode: "seal", source: "kb", reason: "the agent answers from documents" },
			human,
		);
		if (result.kind !== "generate-holdout") throw new Error("wrong kind");
		expect(result.result.source).toBe("kb");
		expect(result.result.cases).toBe(16);
		expect(result.result.corpusId).toMatch(/^corpus-[0-9a-f]{64}$/);
		expect(result.message).toContain("from the knowledge base");
		expect(result.message).not.toContain(SENTINEL);

		// The confirmation priced the knowledge base, and named nothing else.
		const subject = human.confirmations[0]!.subject as Record<string, unknown>;
		expect(subject.source).toBe("kb");
		expect(subject.kbIndexHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(subject.kbChunkIds).toHaveLength(16);
		const dialog = renderConfirmation(human.confirmations[0]!, plainPaint).join("\n");
		expect(dialog).toContain("the knowledge base — 16 passages");
		expect(dialog).not.toContain(SENTINEL);

		const panel = renderDecision(result, plainPaint).join("\n");
		expect(panel).toContain("16 cases from the knowledge base");
		expect(panel).not.toContain(SENTINEL);

		// The exam is sealed, holds one case per passage, and every case carries
		// the passage it was written from.
		const sealed = listCorpora({ stateRoot, projectId: PROJECT }).filter((corpus) => corpus.visibility === "sealed");
		expect(sealed).toHaveLength(1);
		const loaded = loadCorpus({ stateRoot, projectId: PROJECT, corpusId: sealed[0]!.id });
		expect(loaded.tasks).toHaveLength(16);
		expect(new Set(loaded.tasks.map((task) => task.metadata?.kbChunk)).size).toBe(16);
		for (const task of loaded.tasks) {
			expect(KB_CHUNK_IDS).toContain(task.metadata?.kbChunk);
			expect(task.expected).toMatch(/\d+ рублей в месяц/);
			expect(task.graders?.[0]).toEqual({
				type: "cites_source",
				chunk: task.metadata!.kbChunk,
				minOverlap: 0.35,
			});
		}

		// The passport's one word about the exam's provenance.
		expect(sealedExamOrigin(stateRoot, PROJECT, sealed[0]!.id)).toBe("judge-generated-kb");
		const receipt = listSealedSynthReceipts(stateRoot, PROJECT)[0]!;
		expect(receipt.schemaVersion).toBe(3);
		expect(receipt.schemaVersion === 3 && receipt.source).toBe("kb");
		expect(JSON.stringify(receipt)).not.toContain(SENTINEL);
	});

	it("refuses the knowledge-base source on a Target that declares none, before any spend", async () => {
		const mock = await mockKbJudge();
		const { workbench, stateRoot } = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		const human = gate();
		await expect(workbench.decide(
			{ kind: "generate-holdout", cases: 16, mode: "seal", source: "kb", reason: "no documents here" },
			human,
		)).rejects.toThrow(/declares no knowledge base/);
		// The refusal happens in the plan, so the human was never asked and no
		// corpus or receipt exists.
		expect(human.confirmations).toHaveLength(0);
		expect(listCorpora({ stateRoot, projectId: PROJECT })).toEqual([]);
		expect(listSealedSynthReceipts(stateRoot, PROJECT)).toEqual([]);
	});

	it("turns a base of three documents into a full exam, every case citing its own chunk", async () => {
		const mock = await mockKbJudge();
		const { workbench, projectDir, stateRoot } = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
			kb: "small",
		});
		const human = gate();

		// The exact shape session 8 gave up on: three documents, three passages,
		// three questions — and a ship gate that needs fifteen.
		const result = await workbench.decide(
			{ kind: "generate-holdout", cases: 15, mode: "seal", source: "kb", reason: "агент отвечает по документам" },
			human,
		);
		if (result.kind !== "generate-holdout") throw new Error("wrong kind");
		expect(result.result.cases).toBe(15);
		expect(result.result.source).toBe("kb");
		expect(result.result.dropped).toEqual({ malformed: 0, duplicate: 0 });

		const sealed = listCorpora({ stateRoot, projectId: PROJECT }).filter((corpus) => corpus.visibility === "sealed");
		const loaded = loadCorpus({ stateRoot, projectId: PROJECT, corpusId: sealed[0]!.id });
		expect(loaded.tasks).toHaveLength(15);
		// Fifteen different questions: an exam of one question asked fifteen times
		// measures nothing, so the admission dedup is the load-bearing assertion.
		expect(new Set(loaded.tasks.map((task) => normalizedCaseInput(task.input))).size).toBe(15);

		// Every case cites a chunk the RUNTIME index really serves — the only ids
		// `kb_search` can hand the agent, and the only ones `cites_source` checks.
		const runtimeIds = new Set(readKnowledgeBase(projectDir).map((chunk) => chunk.id));
		expect(runtimeIds.size).toBe(3);
		const perChunk = new Map<string, number>();
		for (const task of loaded.tasks) {
			const chunk = String(task.metadata?.kbChunk);
			expect(runtimeIds.has(chunk)).toBe(true);
			expect(task.graders?.[0]).toEqual({ type: "cites_source", chunk, minOverlap: 0.35 });
			perChunk.set(chunk, (perChunk.get(chunk) ?? 0) + 1);
		}
		// Three chunks, six finer passages, at most three questions each.
		expect([...perChunk.values()].sort()).toEqual([5, 5, 5]);
		expect(new Set(loaded.tasks.map((task) => task.metadata?.kbPassage)).size).toBe(6);
		expect(JSON.stringify(result)).not.toContain(SENTINEL);

		// The same seed over the same base writes the same exam.
		const twin = await mockKbJudge();
		const second = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: twin.url },
			kb: "small",
		});
		const again = await second.workbench.decide(
			{ kind: "generate-holdout", cases: 15, mode: "seal", source: "kb", reason: "тот же экзамен" },
			gate(),
		);
		if (again.kind !== "generate-holdout") throw new Error("wrong kind");
		const twinTasks = loadCorpus({
			stateRoot: second.stateRoot,
			projectId: PROJECT,
			corpusId: again.result.corpusId!,
		}).tasks;
		expect(twinTasks.map((task) => task.id)).toEqual(loaded.tasks.map((task) => task.id));
	});

	it("refuses a base that cannot fill the exam, in Russian, with the number and the alternative", async () => {
		const mock = await mockKbJudge();
		const { workbench, stateRoot } = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
			kb: "tiny",
		});
		const human = gate();
		setLanguage("ru");

		await expect(workbench.decide(
			{ kind: "generate-holdout", cases: 15, mode: "seal", source: "kb", reason: "по документам" },
			human,
		)).rejects.toThrow(
			"В базе 1 фрагмент — из неё выходит не больше 3 вопроса, экзамену нужно 15 кейсов. " +
				"Могу написать экзамен из описания (15 кейсов) — делаем?",
		);
		// Refused before the human was asked anything and before a token was spent.
		expect(human.confirmations).toEqual([]);
		expect(mock.requests()).toBe(0);
		expect(listCorpora({ stateRoot, projectId: PROJECT })).toEqual([]);
		expect(listSealedSynthReceipts(stateRoot, PROJECT)).toEqual([]);
	});

	it("tells the Builder the ceiling the knowledge base puts on an exam", async () => {
		const mock = await mockKbJudge();
		const small = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
			kb: "small",
		});
		// Three documents, six passages at the finest cut, three questions each.
		expect((await small.workbench.view()).shippingReadiness?.maxKbQuestions).toBe(18);

		const tiny = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
			kb: "tiny",
		});
		expect((await tiny.workbench.view()).shippingReadiness?.maxKbQuestions).toBe(3);

		// No knowledge base, no ceiling: an absent key is "the question does not
		// apply", which is a different claim from a number.
		const none = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		const view = await none.workbench.view();
		expect(view.shippingReadiness?.maxKbQuestions).toBeUndefined();

		// And the operator reads it on the same line that offers the exam.
		setLanguage("ru");
		const header = renderHeader({
			view: {
				...view,
				counts: { ...view.counts, approvedSpecs: 1 },
				shippingReadiness: { sealedHoldout: "missing", minimumTasks: 15, sealedCases: null, maxKbQuestions: 18 },
			},
			builderModel: { label: "anthropic/claude-opus", credentialPresent: true },
		}, plainPaint).join("\n");
		expect(header).toContain("база знаний даёт не больше 18 вопросов");
	});

	it("says «по базе знаний» in Russian", async () => {
		const mock = await mockKbJudge();
		const { workbench } = await project({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
			kb: true,
		});
		const human = gate();
		setLanguage("ru");
		const result = await workbench.decide(
			{ kind: "generate-holdout", cases: 16, mode: "seal", source: "kb", reason: "агент отвечает по документам" },
			human,
		);
		if (result.kind !== "generate-holdout") throw new Error("wrong kind");
		expect(result.message).toContain("по базе знаний");
		expect(renderConfirmation(human.confirmations[0]!, plainPaint).join("\n"))
			.toContain("база знаний — 16 фрагментов");
		expect(renderDecision(result, plainPaint).join("\n")).toContain("16 кейсов по базе знаний");
	});
});
