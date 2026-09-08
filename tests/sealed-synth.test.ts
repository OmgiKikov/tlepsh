import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCorpus, listCorpora, CorpusTaskSchema } from "../src/corpus.js";
import { chunkKnowledge, kbIndexHash, KB_CHUNK_CHARS } from "../src/domain/kb.js";
import { setLanguage } from "../src/i18n.js";
import { loadTarget } from "../src/manifest.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import {
	listSealedSynthReceipts,
	maxKbExamQuestions,
	normalizedCaseInput,
	planSealedSynthesis,
	renderSealedSynthOutput,
	sealedExamGeneration,
	sealedExamOrigin,
	SealedSynthRefusal,
	sealedSynthSource,
	synthesizeSealedCorpus,
} from "../src/application/sealed-synth.js";
import { baseFixtureFiles, makeTargetFixture } from "./fixtures.js";

/**
 * Everything the generator writes carries this. It must never appear in
 * anything an operator reads, in the receipt, or in any returned value — only
 * inside the sealed corpus content itself.
 */
const SENTINEL = "ZZ-SEALED-SENTINEL-ZZ";
const at = "2026-09-01T10:00:00.000Z";
const roots: string[] = [];
const mocks: MockModelHandle[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	for (const mock of mocks.splice(0)) await mock.close();
});

const DEV_CASES = [
	{ id: "dev-1", input: "Проверь договор 42 и ограничения ДБО.", graders: [{ type: "output_contains", text: "договор" }] },
	{ id: "dev-2", input: "Классифицируй обращение: жалоба на списание.", graders: [{ type: "output_contains", text: "жалоба" }] },
	{ id: "dev-3", input: "Составь ответ по заявлению на возврат.", graders: [{ type: "output_contains", text: "возврат" }] },
	{ id: "dev-4", input: "Объясни клиенту сроки рассмотрения.", graders: [{ type: "output_contains", text: "срок" }] },
];

/** The Spec's jobs are the rows of the coverage matrix, so the fixture has some. */
const SPEC_JOBS = ["Ответить по договору", "Классифицировать обращение"];

const SPEC_MD = `# Support answer agent

Отвечает на обращения клиентов банка по договорам и ДБО.

## Jobs
${SPEC_JOBS.map((job) => `- ${job}`).join("\n")}

## Success criteria
- ответ содержит срок
- ответ вежлив
`;

function manifestYaml(
	judge: { provider: string; id: string; baseUrl: string } | null,
	declareKb = false,
): string {
	const judgeBlock = judge
		? `  judge:
    provider: ${judge.provider}
    id: ${judge.id}
    api: openai-completions
    baseUrl: ${judge.baseUrl}
    apiKeyEnv: TEST_JUDGE_KEY
    thinkingLevel: "off"
    timeoutMs: 300000
`
		: "";
	return `id: test-target
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
${judgeBlock}`;
}

/**
 * Three short documents, each one paragraph past its heading, so every file is
 * exactly one chunk and the ids a test asserts on are readable: `a.md#0`.
 */
const KB_DOCS: Record<string, string> = {
	"data/kb/a.md": "# Тарифы\n\nТариф «Река» стоит 750 рублей в месяц.\n",
	"data/kb/b.md": "# Блокировка\n\nДоступ приостанавливается на пятые сутки после появления задолженности.\n",
	"data/kb/c.md": "# Мастер\n\nВыезд мастера стоит 600 рублей, если причина внутри квартиры.\n",
};

const KB_ANSWERS: Record<string, { question: string; answer: string }> = {
	"a.md#0": { question: "Сколько стоит тариф «Река»?", answer: "750 рублей в месяц" },
	"b.md#0": { question: "Когда отключат интернет за долг?", answer: "На пятые сутки после появления задолженности" },
	"c.md#0": { question: "Сколько стоит выезд мастера?", answer: "600 рублей, если причина внутри квартиры" },
};

/**
 * Three documents of two long paragraphs each: one runtime chunk apiece at the
 * 800-character geometry, two passages apiece once the generator halves it.
 * Six passages carry the guardrail's fifteen questions; three cannot.
 */
const LONG_KB_DOCS: Record<string, string> = Object.fromEntries(
	["a", "b", "c"].map((name) => [
		`data/kb/${name}.md`,
		`# Раздел ${name}\n\n${`Первый пункт раздела ${name}: ${"слово ".repeat(50)}`.trim()}\n\n` +
			`${`Второй пункт раздела ${name}: ${"буква ".repeat(50)}`.trim()}\n`,
	]),
);

/** What the judge answers for one passage when it is asked for `asked` questions. */
function kbPairs(passageId: string, asked: number): { question: string; answer: string }[] {
	const known = KB_ANSWERS[passageId];
	return Array.from({ length: asked }, (_value, index) =>
		index === 0 && known ? known : {
			question: `Что ещё сказано в отрывке ${passageId}? Факт ${index}.`,
			answer: `Факт ${index} отрывка ${passageId}`,
		});
}

/**
 * One judge answers two questions now: it writes the exam, and then it reviews
 * what it wrote. The two are told apart by the system prompt — the critic's
 * begins with the sentence below — because that is the only thing the host
 * varies between them.
 */
const CRITIC_SYSTEM_MARK = "You review evaluation cases";

interface MockVerdict {
	verdict: "valid" | "repair" | "invalid";
	reasons?: string[];
}
/** What the mock critic says about one case, by the case's own request text. */
type CriticRule = (input: string) => MockVerdict | undefined;

/** The cases one critic prompt carries, in prompt order. */
function criticPromptCases(user: string): { index: number; input: string }[] {
	const block = /# Case (\d+) \(id [^)]*\)\n(?:coverage: [^\n]*\n)?input: ([^\n]*)/gu;
	return [...user.matchAll(block)].map((match) => ({ index: Number(match[1]), input: match[2] ?? "" }));
}

/** One finding per case in the batch; `valid` unless the rule says otherwise. */
function criticReply(user: string, rule: CriticRule | undefined): string {
	return JSON.stringify({
		findings: criticPromptCases(user).map(({ index, input }) => {
			const decided = rule?.(input) ?? { verdict: "valid" as const };
			return { case: index, verdict: decided.verdict, reasons: decided.reasons ?? [] };
		}),
	});
}

/** The mock as this file uses it: an endpoint, and what it was asked for. */
interface JudgeMock {
	url: string;
	/** Every request, generation and critic alike. */
	requests: () => number;
	/** Generation requests only — the critic asks once per batch of eight. */
	generations: () => number;
}

async function mockJudgeModel(options: {
	generate: (firstUser: string) => string;
	critic?: CriticRule;
}): Promise<JudgeMock> {
	let generations = 0;
	const mock = await startMockModel([{
		match: () => true,
		resolve: ({ system, firstUser }) => {
			if (system.startsWith(CRITIC_SYSTEM_MARK)) return { text: criticReply(firstUser, options.critic) };
			generations += 1;
			return { text: options.generate(firstUser) };
		},
		steps: [],
	}]);
	mocks.push(mock);
	return { url: mock.url, requests: () => mock.requests(), generations: () => generations };
}

/**
 * A judge that answers every passage with exactly as many distinct
 * question-and-answer pairs as the prompt asked it for, plus the no-answer
 * question when the prompt asks for one.
 */
async function mockKbJudge(overrides: Record<string, string> = {}, critic?: CriticRule): Promise<JudgeMock> {
	return mockJudgeModel({
		generate: (firstUser) => {
			const passageId = /# Passage (\S+)/.exec(firstUser)?.[1] ?? "";
			const override = overrides[passageId];
			if (override !== undefined) return override;
			const asked = Number(/Write (\d+) different/.exec(firstUser)?.[1] ?? "1");
			return JSON.stringify({
				questions: kbPairs(passageId, asked),
				...(firstUser.includes("no-answer question")
					? {
						noAnswer: {
							question: `${SENTINEL} Сколько стоит доставка по отрывку ${passageId}?`,
							invented: `${SENTINEL} 1234 рубля за ${passageId}`,
						},
					}
					: {}),
			});
		},
		...(critic ? { critic } : {}),
	});
}

interface Fixture {
	targetDir: string;
	stateRoot: string;
	outside: string;
}

/** A Target whose judge is the mock, plus a private state root and a scratch dir. */
function fixture(
	options: {
		judge?: { provider: string; id: string; baseUrl: string } | null;
		spec?: boolean;
		cases?: readonly unknown[];
		/**
		 * `true` declares and populates data/kb with three one-line documents;
		 * `"long"` with three that split when the geometry is halved; `"empty"`
		 * declares one holding nothing readable.
		 */
		kb?: boolean | "empty" | "long";
	} = {},
): Fixture {
	const targetDir = makeTargetFixture(
		baseFixtureFiles({
			"manifest.yaml": manifestYaml(options.judge === undefined ? null : options.judge, Boolean(options.kb)),
			"evals/development.jsonl": `${(options.cases ?? DEV_CASES).map((task) => JSON.stringify(task)).join("\n")}\n`,
			...(options.spec === false ? {} : { "spec.md": SPEC_MD }),
			...(options.kb === true ? KB_DOCS : {}),
			...(options.kb === "long" ? LONG_KB_DOCS : {}),
			...(options.kb === "empty" ? { "data/kb/README.pdf": "%PDF-1.4 не знание" } : {}),
		}),
	);
	const stateRoot = mkdtempSync(join(tmpdir(), "ahde-synth-state-"));
	const outside = mkdtempSync(join(tmpdir(), "ahde-synth-out-"));
	roots.push(targetDir, stateRoot, outside);
	return { targetDir, stateRoot, outside };
}

/** `count` distinct generated cases, every one carrying the sentinel. */
function generated(count: number, extra: readonly unknown[] = []): string {
	const cases = Array.from({ length: count }, (_unused, index) => ({
		// An id the host must ignore: a model never names a case.
		id: `model-chosen-${index}`,
		input: `${SENTINEL} синтетический запрос ${index + 1}`,
		graders: [{ type: "output_contains", text: "срок" }],
	}));
	return JSON.stringify({ cases: [...cases, ...extra] });
}

/** A judge that answers every generation with the same text. */
async function mockJudge(text: string, critic?: CriticRule): Promise<JudgeMock> {
	return mockJudgeModel({ generate: () => text, ...(critic ? { critic } : {}) });
}

/** One deterministic check, the shape the development suite already uses. */
const DETERMINISTIC = [{ type: "output_contains", text: "срок" }];

describe("sealed synthetic generation", () => {
	it("seals N generated cases and prints nothing about them", async () => {
		const mock = await mockJudge(generated(16));
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});

		const result = await synthesizeSealedCorpus({
			targetDir,
			stateRoot,
			projectId: "project",
			name: "Sealed exam v1",
			count: 16,
			seed: "s1",
			now: () => at,
		});

		expect(result.corpus?.visibility).toBe("sealed");
		expect(result.corpus?.taskCount).toBe(16);
		expect(result.accepted).toBe(16);
		expect(result.droppedMalformed).toBe(0);
		expect(result.droppedDuplicate).toBe(0);
		expect(result.generatorModel).toBe("fixture-provider/fixture-judge");
		expect(result.promptSha256).toMatch(/^sha256:[0-9a-f]{64}$/);

		// The corpus really holds the cases, with host-derived ids.
		const loaded = loadCorpus({ stateRoot, projectId: "project", corpusId: result.corpus!.id });
		expect(loaded.tasks).toHaveLength(16);
		expect(loaded.tasks.every((task) => /^synth-[0-9a-f]{24}$/.test(task.id))).toBe(true);
		expect(loaded.tasks.every((task) => task.input.includes(SENTINEL))).toBe(true);

		// Nothing an operator, a log, or a receipt can read mentions a case.
		const rendered = renderSealedSynthOutput(result);
		const visible = [...rendered.stdout, ...rendered.warnings].join("\n");
		expect(visible).not.toContain(SENTINEL);
		expect(visible).toContain(result.corpus!.id);
		expect(visible).toContain("fixture-provider/fixture-judge");
		expect(visible).toContain(result.promptSha256);
		expect(JSON.stringify(result.receipt)).not.toContain(SENTINEL);
		expect(readFileSync(result.receiptPath, "utf8")).not.toContain(SENTINEL);
		// Sixteen cases clear the guardrail, so nothing warns about it.
		expect(rendered.warnings.join("\n")).not.toContain("underpowered");
	});

	it("records a receipt with hashes, ids and counts, and no case content", async () => {
		const mock = await mockJudge(generated(3));
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});

		const result = await synthesizeSealedCorpus({
			targetDir,
			stateRoot,
			projectId: "project",
			name: "Sealed exam v1",
			count: 3,
			seed: "s1",
			examples: 2,
			now: () => at,
		});

		const receipt = result.receipt;
		expect(receipt.schemaVersion).toBe(4);
		expect(sealedSynthSource(receipt)).toBe("spec");
		expect(receipt.schemaVersion === 4 && receipt.kbIndexHash).toBeNull();
		expect(receipt.schemaVersion === 4 && receipt.kbChunkChars).toBeNull();
		expect(receipt.targetId).toBe("test-target");
		expect(receipt.generator.provider).toBe("fixture-provider");
		expect(receipt.generator.id).toBe("fixture-judge");
		expect(receipt.generatorHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(receipt.promptSha256).toBe(result.promptSha256);
		expect(receipt.specSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(receipt.specSource).toBe("target-spec-md");
		expect(receipt.developmentExampleIds).toHaveLength(2);
		expect(receipt.developmentExampleIds.every((id) => DEV_CASES.some((task) => task.id === id))).toBe(true);
		expect(receipt.requested).toBe(3);
		expect(receipt.seed).toBe("s1");
		expect(receipt.at).toBe(at);
		expect(receipt.outcome).toEqual({
			kind: "sealed",
			corpusId: result.corpus!.id,
			corpusHash: result.corpus!.hash,
			taskCount: 3,
		});

		// The receipt is on disk, content-addressed, and re-readable.
		expect(listSealedSynthReceipts(stateRoot, "project")).toEqual([receipt]);

		// Three cases can never produce a sealed verdict, and the command says so.
		expect(renderSealedSynthOutput(result).warnings.join("\n")).toContain("underpowered");
	});

	it("draws the same format examples for the same seed and different ones for another", async () => {
		const first = await mockJudge(generated(2));
		const fixtureA = fixture({ judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: first.url } });
		const runOne = await synthesizeSealedCorpus({
			targetDir: fixtureA.targetDir,
			stateRoot: fixtureA.stateRoot,
			projectId: "project",
			name: "exam a",
			count: 2,
			seed: "s1",
			examples: 2,
			now: () => at,
		});

		const second = await mockJudge(generated(2));
		const fixtureB = fixture({ judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: second.url } });
		const runTwo = await synthesizeSealedCorpus({
			targetDir: fixtureB.targetDir,
			stateRoot: fixtureB.stateRoot,
			projectId: "project",
			name: "exam a",
			count: 2,
			seed: "s1",
			examples: 2,
			now: () => at,
		});
		expect(runTwo.receipt.developmentExampleIds).toEqual(runOne.receipt.developmentExampleIds);

		const third = await mockJudge(generated(2));
		const fixtureC = fixture({ judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: third.url } });
		const runThree = await synthesizeSealedCorpus({
			targetDir: fixtureC.targetDir,
			stateRoot: fixtureC.stateRoot,
			projectId: "project",
			name: "exam a",
			count: 2,
			seed: "another-seed",
			examples: 2,
			now: () => at,
		});
		expect(runThree.receipt.developmentExampleIds).not.toEqual(runOne.receipt.developmentExampleIds);
	});

	it("shows the generator the world a development case happens in, and states it once", async () => {
		const prompts: string[] = [];
		const mock = await mockJudgeModel({
			generate: (firstUser) => {
				prompts.push(firstUser);
				return generated(2);
			},
		});
		const worlded = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
			cases: [
				...DEV_CASES,
				{
					id: "dev-world",
					input: "Заблокируй договор 42.",
					world: {
						state: { accounts: { "42": { status: "ok" } } },
						expect: [{ path: "accounts.42.status", op: "equals", value: "frozen" }],
					},
					graders: [{ type: "output_contains", text: "готово" }],
				},
			],
		});
		await synthesizeSealedCorpus({
			targetDir: worlded.targetDir,
			stateRoot: worlded.stateRoot,
			projectId: "project",
			name: "exam with a world",
			count: 2,
			seed: "s1",
			examples: 5,
			now: () => at,
		});

		const prompt = prompts[0] ?? "";
		// Without this the exam would be written against a case shape the
		// development suite does not have.
		expect(prompt).toContain('"world"');
		expect(prompt).toContain('"accounts"');
		expect(prompt).toContain('"frozen"');
		// The expectation and the grader it desugars into are one statement; an
		// example that showed both would teach the generator to write it twice.
		expect(prompt).not.toContain("world_state");
	});

	it("drops generated copies of development inputs and counts them", async () => {
		const mock = await mockJudge(
			JSON.stringify({
				cases: [
					// Byte-identical to a development case.
					{ input: DEV_CASES[0]!.input, graders: [{ type: "output_contains", text: "договор" }] },
					// The same question in different typography: still the same case.
					{
						input: `  ${DEV_CASES[1]!.input.toUpperCase()}  `,
						graders: [{ type: "output_contains", text: "жалоба" }],
					},
					{ input: `${SENTINEL} новый запрос`, graders: [{ type: "output_contains", text: "срок" }] },
					// Malformed: no grader at all.
					{ input: `${SENTINEL} без грейдера` },
					// Malformed: not an object.
					"обращение",
				],
			}),
		);
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});

		const result = await synthesizeSealedCorpus({
			targetDir,
			stateRoot,
			projectId: "project",
			name: "dedupe exam",
			count: 5,
			now: () => at,
		});

		expect(result.accepted).toBe(1);
		expect(result.droppedDuplicate).toBe(2);
		expect(result.droppedMalformed).toBe(2);
		expect(result.corpus?.taskCount).toBe(1);
		// The exam ran smaller than it was ordered, and the receipt is the only
		// place that difference is written down. Every screen that explains it
		// reads it from here rather than inferring it from a count.
		expect(sealedExamGeneration(stateRoot, "project", result.corpus!.id))
			.toEqual({ requested: 5, accepted: 1, droppedDuplicate: 2, droppedMalformed: 2 });
		// An exam the operator brought has no receipt here, and no answer.
		expect(sealedExamGeneration(stateRoot, "project", `corpus-${"f".repeat(64)}`)).toBeNull();
		expect(sealedExamGeneration(stateRoot, "project", null)).toBeNull();
		const warnings = renderSealedSynthOutput(result).warnings.join("\n");
		expect(warnings).toContain("2 generated case(s) repeated a development input");
		expect(warnings).toContain("2 generated case(s) did not match the case schema");
		expect(warnings).not.toContain(SENTINEL);
	});

	it("drops a generated copy of another generated case", async () => {
		const mock = await mockJudge(
			JSON.stringify({
				cases: [
					{ input: `${SENTINEL} один`, graders: [{ type: "output_contains", text: "срок" }] },
					{ input: `${SENTINEL}   ОДИН `, graders: [{ type: "output_contains", text: "срок" }] },
				],
			}),
		);
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		const result = await synthesizeSealedCorpus({
			targetDir,
			stateRoot,
			projectId: "project",
			name: "self dedupe",
			count: 2,
			now: () => at,
		});
		expect(result.accepted).toBe(1);
		expect(result.droppedDuplicate).toBe(1);
	});

	it("refuses when no judge is configured", async () => {
		const { targetDir, stateRoot } = fixture({ judge: null });
		await expect(
			synthesizeSealedCorpus({ targetDir, stateRoot, projectId: "project", name: "exam", count: 3, now: () => at }),
		).rejects.toMatchObject({
			name: "SealedSynthRefusal",
			message: expect.stringContaining("no judge configured"),
			next: expect.stringContaining("evaluator setup"),
		});
		expect(listCorpora({ stateRoot, projectId: "project" })).toEqual([]);
	});

	it("refuses a judge equal to the Target model", async () => {
		const mock = await mockJudge(generated(3));
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "qwen-internal", id: "qwen3.5-27b", baseUrl: mock.url },
		});
		await expect(
			synthesizeSealedCorpus({ targetDir, stateRoot, projectId: "project", name: "exam", count: 3, now: () => at }),
		).rejects.toMatchObject({
			name: "SealedSynthRefusal",
			message: expect.stringContaining("the Target's own model"),
		});
		// The refusal is a decision, not a wasted call: nothing was generated.
		expect(mock.requests()).toBe(0);
		expect(listCorpora({ stateRoot, projectId: "project" })).toEqual([]);
	});

	it("refuses when there is no Spec to write an exam from", async () => {
		const mock = await mockJudge(generated(3));
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
			spec: false,
		});
		await expect(
			synthesizeSealedCorpus({ targetDir, stateRoot, projectId: "project", name: "exam", count: 3, now: () => at }),
		).rejects.toMatchObject({
			name: "SealedSynthRefusal",
			next: expect.stringContaining("--from"),
		});
		expect(mock.requests()).toBe(0);
	});

	it("writes a review file outside the Target instead of sealing", async () => {
		const mock = await mockJudge(generated(3));
		const { targetDir, stateRoot, outside } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		const reviewPath = join(outside, "review.jsonl");

		const result = await synthesizeSealedCorpus({
			targetDir,
			stateRoot,
			projectId: "project",
			name: "review exam",
			count: 3,
			reviewPath,
			now: () => at,
		});

		expect(result.corpus).toBeNull();
		expect(result.reviewPath).toBe(reviewPath);
		// Nothing was sealed: the human seals it.
		expect(listCorpora({ stateRoot, projectId: "project" })).toEqual([]);
		expect(statSync(reviewPath).mode & 0o777).toBe(0o600);

		const lines = readFileSync(reviewPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(3);
		for (const line of lines) expect(() => CorpusTaskSchema.parse(JSON.parse(line))).not.toThrow();

		const rendered = renderSealedSynthOutput(result);
		expect(rendered.stdout.join("\n")).not.toContain(SENTINEL);
		expect(rendered.stdout.join("\n")).toContain(reviewPath);
		expect(rendered.stdout.join("\n")).toContain("/holdout");
		expect(result.receipt.outcome).toEqual({ kind: "review", reviewPath, caseCount: 3 });
	});

	it("refuses a review path inside the Target tree", async () => {
		const mock = await mockJudge(generated(3));
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		await expect(
			synthesizeSealedCorpus({
				targetDir,
				stateRoot,
				projectId: "project",
				name: "exam",
				count: 3,
				reviewPath: join(targetDir, "evals", "review.jsonl"),
				now: () => at,
			}),
		).rejects.toBeInstanceOf(SealedSynthRefusal);
		expect(mock.requests()).toBe(0);
	});

	it("refuses to overwrite an existing review file", async () => {
		const mock = await mockJudge(generated(3));
		const { targetDir, stateRoot, outside } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		const reviewPath = join(outside, "already-edited.jsonl");
		writeFileSync(reviewPath, "{}\n");
		await expect(
			synthesizeSealedCorpus({
				targetDir,
				stateRoot,
				projectId: "project",
				name: "exam",
				count: 3,
				reviewPath,
				now: () => at,
			}),
		).rejects.toMatchObject({ name: "SealedSynthRefusal", message: expect.stringContaining("already exists") });
		expect(readFileSync(reviewPath, "utf8")).toBe("{}\n");

		// The critic's verdicts land beside the draft and are written the same
		// immutable way, so a leftover one is refused before anything is spent
		// rather than after the draft is on disk and its receipt is not.
		const fresh = join(outside, "fresh.jsonl");
		writeFileSync(`${fresh}.critic.jsonl`, "{}\n");
		await expect(
			synthesizeSealedCorpus({
				targetDir,
				stateRoot,
				projectId: "project",
				name: "exam",
				count: 3,
				reviewPath: fresh,
				now: () => at,
			}),
		).rejects.toMatchObject({ name: "SealedSynthRefusal", message: expect.stringContaining("critic verdicts") });
		expect(existsSync(fresh)).toBe(false);
	});

	it("fails without sealing when the generator returns nothing usable", async () => {
		const mock = await mockJudge("I cannot help with that.");
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		await expect(
			synthesizeSealedCorpus({ targetDir, stateRoot, projectId: "project", name: "exam", count: 3, now: () => at }),
		).rejects.toThrow(/did not return a JSON object/);
		expect(listCorpora({ stateRoot, projectId: "project" })).toEqual([]);
		expect(listSealedSynthReceipts(stateRoot, "project")).toEqual([]);
	});
});

describe("sealed synthetic generation cleanup", () => {
	it("keeps no copy of the generated exam beside the receipt", async () => {
		const mock = await mockJudge(generated(3));
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		await synthesizeSealedCorpus({
			targetDir,
			stateRoot,
			projectId: "project",
			name: "exam",
			count: 3,
			now: () => at,
		});
		// Everything the sealed-synth directory holds is a receipt; the raw
		// generator exchange that produced the cases is gone once they had a home.
		const synthRoot = join(stateRoot, "projects", "project", "sealed-synth");
		const entries = readdirSync(synthRoot, { withFileTypes: true });
		expect(entries).not.toHaveLength(0);
		expect(entries.every((entry) => entry.isFile() && /^[0-9a-f]{64}\.json$/.test(entry.name))).toBe(true);
	});

	it("writes the receipt before the exchange is deleted, so a sealed exam always has one", async () => {
		// Deleting the exchange is made to fail by holding one of its files in a
		// directory nothing may unlink from. Root ignores the mode, so a run as
		// root would prove nothing.
		if (process.getuid?.() === 0) return;
		const mock = await mockJudge(generated(3));
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		const request = { targetDir, stateRoot, projectId: "project", name: "exam", count: 3 };
		// The exchange directory is a pure function of the prompt hash, which the
		// plan states before a token is spent.
		const promptSha256 = planSealedSynthesis(request).promptSha256;
		const exchangeDir = join(
			stateRoot,
			"projects",
			"project",
			"sealed-synth",
			"exchanges",
			promptSha256.slice("sha256:".length, "sha256:".length + 16),
		);
		const held = join(exchangeDir, "held");
		mkdirSync(held, { recursive: true });
		writeFileSync(join(held, "exchange.json"), "{}\n");
		chmodSync(held, 0o500);

		try {
			const result = await synthesizeSealedCorpus({ ...request, now: () => at });
			// The exam is sealed AND its origin is written down, which is the whole
			// point of the order: a corpus with no receipt reads as operator-supplied
			// on the passport, and the exchange that would prove otherwise is gone.
			expect(result.corpus?.taskCount).toBe(3);
			expect(existsSync(result.receiptPath)).toBe(true);
			expect(listSealedSynthReceipts(stateRoot, "project")).toEqual([result.receipt]);
			// And the copy that could not be removed is named rather than hidden.
			expect(result.exchangeRetained).toBe(exchangeDir);
			expect(renderSealedSynthOutput(result).warnings.join("\n"))
				.toContain("the raw generator exchange could not be removed");
		} finally {
			chmodSync(held, 0o700);
		}
	});
});

describe("an exam written from the knowledge base", () => {
	it("asks one question per passage and nails each answer to the passage it came from", async () => {
		const mock = await mockKbJudge();
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
			kb: true,
		});

		const result = await synthesizeSealedCorpus({
			targetDir,
			stateRoot,
			projectId: "project",
			name: "KB exam",
			// Three asked for over three passages: one question each, and the ids
			// a test can read.
			count: 3,
			source: "kb",
			seed: "s1",
			now: () => at,
		});

		expect(result.source).toBe("kb");
		expect(result.requested).toBe(3);
		expect(result.accepted).toBe(3);
		expect(result.corpus?.taskCount).toBe(3);

		const loaded = loadCorpus({ stateRoot, projectId: "project", corpusId: result.corpus!.id });
		expect(loaded.tasks).toHaveLength(3);
		const byChunk = new Map(loaded.tasks.map((task) => [task.metadata?.kbChunk, task]));
		expect([...byChunk.keys()].sort()).toEqual(["a.md#0", "b.md#0", "c.md#0"]);
		for (const [chunkId, task] of byChunk) {
			const pair = KB_ANSWERS[String(chunkId)]!;
			expect(task.input).toBe(pair.question);
			expect(task.expected).toBe(pair.answer);
			// Ids are still derived host-side; the judge never names a case.
			expect(task.id).toMatch(/^synth-[0-9a-f]{24}$/);
			expect(task.graders).toEqual([
				{ type: "cites_source", chunk: chunkId, minOverlap: 0.35 },
				{ type: "similarity", metric: "token-f1", threshold: 0.5 },
			]);
			// No judge grader: the model that wrote the question and the reference
			// answer does not also mark the paper.
			expect(task.graders?.some((grader) => grader.type === "judge")).toBe(false);
		}

		const receipt = result.receipt;
		expect(receipt.schemaVersion).toBe(4);
		expect(sealedSynthSource(receipt)).toBe("kb");
		expect(receipt.schemaVersion === 4 && receipt.kbIndexHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		// Three questions fit in three runtime passages, so the base was read at
		// the runtime geometry and the receipt says so.
		expect(receipt.schemaVersion === 4 && receipt.kbChunkChars).toBe(KB_CHUNK_CHARS);
		expect(receipt.requested).toBe(3);
		// Nothing about a case reaches the receipt or anything an operator reads.
		const visible = JSON.stringify(receipt) + renderSealedSynthOutput(result).stdout.join("\n");
		for (const pair of Object.values(KB_ANSWERS)) {
			expect(visible).not.toContain(pair.question);
			expect(visible).not.toContain(pair.answer);
		}
		expect(renderSealedSynthOutput(result).stdout.join("\n")).toContain("source        kb");

		expect(sealedExamOrigin(stateRoot, "project", result.corpus!.id)).toBe("judge-generated-kb");
	});

	it("draws the same passages for the same seed, and different ones for another", async () => {
		const first = await mockKbJudge();
		const alpha = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: first.url },
			kb: true,
		});
		const plan = (seed: string, count: number) =>
			planSealedSynthesis({
				targetDir: alpha.targetDir,
				stateRoot: alpha.stateRoot,
				projectId: "project",
				name: "KB exam",
				count,
				source: "kb",
				seed,
			});
		expect(plan("s1", 2).kbChunkIds).toEqual(plan("s1", 2).kbChunkIds);
		expect(plan("s1", 2).kbChunkIds).toHaveLength(2);
		expect(plan("s1", 3).kbIndexHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		// Two different seeds over three passages must not always agree on two.
		const seeds = ["s1", "s2", "s3", "s4"].map((seed) => plan(seed, 2).kbChunkIds.join(","));
		expect(new Set(seeds).size).toBeGreaterThan(1);
		// The whole corpus is drawn whatever the seed, once the count reaches it.
		expect(plan("s9", 9).kbChunkIds.sort()).toEqual(["a.md#0", "b.md#0", "c.md#0"]);
	});

	it("refuses before a token is spent when there is no knowledge base to write from", async () => {
		const mock = await mockKbJudge();
		const undeclared = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		const request = {
			stateRoot: undeclared.stateRoot,
			projectId: "project",
			name: "KB exam",
			count: 3,
			source: "kb" as const,
		};
		expect(() => planSealedSynthesis({ ...request, targetDir: undeclared.targetDir }))
			.toThrow(/declares no knowledge base/);
		await expect(synthesizeSealedCorpus({ ...request, targetDir: undeclared.targetDir, now: () => at }))
			.rejects.toMatchObject({ name: "SealedSynthRefusal" });
		expect(listCorpora({ stateRoot: undeclared.stateRoot, projectId: "project" })).toEqual([]);
		expect(listSealedSynthReceipts(undeclared.stateRoot, "project")).toEqual([]);

		const empty = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
			kb: "empty",
		});
		expect(() =>
			planSealedSynthesis({
				...request,
				targetDir: empty.targetDir,
				stateRoot: empty.stateRoot,
			})
		).toThrow(/no readable \.md or \.txt document/);

		// The Spec source over the same Target is untouched by any of this.
		const spec = planSealedSynthesis({
			targetDir: undeclared.targetDir,
			stateRoot: undeclared.stateRoot,
			projectId: "project",
			name: "exam",
			count: 3,
		});
		expect(spec.source).toBe("spec");
		expect(spec.kbIndexHash).toBeNull();
		expect(spec.kbChunkIds).toEqual([]);
	});

	it("counts a passage whose answer did not parse as a case that never existed", async () => {
		const mock = await mockKbJudge({ "b.md#0": "I cannot help with that." });
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
			kb: true,
		});
		const result = await synthesizeSealedCorpus({
			targetDir,
			stateRoot,
			projectId: "project",
			name: "KB exam",
			count: 3,
			source: "kb",
			now: () => at,
		});
		expect(result.requested).toBe(3);
		expect(result.accepted).toBe(2);
		expect(result.droppedMalformed).toBe(1);
		expect(renderSealedSynthOutput(result).warnings.join("\n"))
			.toContain("1 generated case(s) did not match the case schema");
	});

	it("asks one passage for up to three questions, and never a fourth", async () => {
		const mock = await mockKbJudge();
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
			kb: true,
		});
		const plan = planSealedSynthesis({
			targetDir,
			stateRoot,
			projectId: "project",
			name: "KB exam",
			count: 9,
			source: "kb",
			seed: "s1",
		});
		// Three passages, three questions each: the ceiling, and one call per
		// passage rather than one per question.
		expect(plan.kbChunkIds.sort()).toEqual(["a.md#0", "b.md#0", "c.md#0"]);
		expect(plan.requested).toBe(9);
		expect(plan.kbChunkChars).toBe(KB_CHUNK_CHARS);

		const result = await synthesizeSealedCorpus({
			targetDir,
			stateRoot,
			projectId: "project",
			name: "KB exam",
			count: 9,
			source: "kb",
			seed: "s1",
			now: () => at,
		});
		expect(result.accepted).toBe(9);
		// One call per passage rather than one per question; the critic's own two
		// calls are not generation.
		expect(mock.generations()).toBe(3);
		const loaded = loadCorpus({ stateRoot, projectId: "project", corpusId: result.corpus!.id });
		// Nine distinct questions, three per passage, every one written from its chunk.
		expect(new Set(loaded.tasks.map((task) => task.input)).size).toBe(9);
		const perChunk = new Map<string, number>();
		for (const task of loaded.tasks) {
			const chunk = String(task.metadata?.kbChunk);
			expect(["a.md#0", "b.md#0", "c.md#0"]).toContain(chunk);
			// Every third passage spends one question on a fact it does not state,
			// and that one is checked by what the answer must NOT say.
			expect(task.graders?.[0]).toEqual(
				task.expected === undefined
					? { type: "output_excludes", text: expect.stringContaining("1234 рубля"), caseSensitive: false }
					: { type: "cites_source", chunk, minOverlap: 0.35 },
			);
			perChunk.set(chunk, (perChunk.get(chunk) ?? 0) + 1);
		}
		expect([...perChunk.values()]).toEqual([3, 3, 3]);
		// Exactly one trap in a three-passage exam, and it is labelled as one.
		const traps = loaded.tasks.filter((task) => task.expected === undefined);
		expect(traps).toHaveLength(1);
		expect(traps[0]?.coverage).toEqual({ job: SPEC_JOBS[0], difficulty: "no-answer" });
	});

	it("reads a base too small for the exam at a finer geometry, and records the length", async () => {
		const mock = await mockKbJudge();
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
			kb: "long",
		});
		const result = await synthesizeSealedCorpus({
			targetDir,
			stateRoot,
			projectId: "project",
			name: "KB exam",
			// Three documents, three runtime chunks: nine questions at the runtime
			// geometry, and the sealed guardrail needs fifteen.
			count: 15,
			source: "kb",
			seed: "s1",
			now: () => at,
		});
		expect(result.accepted).toBe(15);
		expect(result.droppedDuplicate).toBe(0);
		expect(result.droppedMalformed).toBe(0);

		const receipt = result.receipt;
		expect(receipt.schemaVersion === 4 && receipt.kbChunkChars).toBe(KB_CHUNK_CHARS / 2);
		// The index hash still describes the RUNTIME index: the finer read is the
		// generator's, and the receipt's chunk length is what makes it readable.
		expect(receipt.schemaVersion === 4 && receipt.kbIndexHash)
			.toBe(kbIndexHash(chunkKnowledge(
				Object.entries(LONG_KB_DOCS).map(([path, text]) => ({ path: path.slice("data/kb/".length), text })),
			)));

		const loaded = loadCorpus({ stateRoot, projectId: "project", corpusId: result.corpus!.id });
		expect(loaded.tasks).toHaveLength(15);
		// Fifteen different questions, and every citation is a chunk id the
		// runtime `kb_search` can actually hand the agent.
		expect(new Set(loaded.tasks.map((task) => normalizedCaseInput(task.input))).size).toBe(15);
		const runtimeIds = new Set(
			chunkKnowledge(Object.entries(LONG_KB_DOCS).map(([path, text]) => ({ path: path.slice("data/kb/".length), text })))
				.map((chunk) => chunk.id),
		);
		for (const task of loaded.tasks) {
			const chunk = String(task.metadata?.kbChunk);
			expect(runtimeIds.has(chunk)).toBe(true);
			// A question the passage answers cites it; the no-answer trap cannot,
			// because the whole case is that the passage does not hold the answer.
			if (task.expected !== undefined) {
				expect(task.graders?.[0]).toEqual({ type: "cites_source", chunk, minOverlap: 0.35 });
			} else {
				expect(task.graders?.[0]?.type).toBe("output_excludes");
			}
			// The finer passage is recorded beside it: which part of the chunk the
			// question stands on is evidence, not a secret.
			expect(String(task.metadata?.kbPassage).startsWith(`${chunk}/`)).toBe(true);
		}
		// Six passages, so two of them are asked for the trap.
		expect(loaded.tasks.filter((task) => task.expected === undefined)).toHaveLength(2);
	});

	it("refuses a base that cannot reach the exam, naming the maximum, before any spend", async () => {
		const mock = await mockKbJudge();
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
			kb: true,
		});
		const request = {
			targetDir,
			stateRoot,
			projectId: "project",
			name: "KB exam",
			count: 20,
			source: "kb" as const,
		};
		// Three one-line documents do not split further, whatever the geometry:
		// nine questions is everything this base has.
		expect(maxKbExamQuestions(loadTarget(targetDir))).toBe(9);
		expect(() => planSealedSynthesis(request)).toThrow(SealedSynthRefusal);
		expect(() => planSealedSynthesis(request)).toThrow(
			/The knowledge base holds 3 passages — no more than 9 questions come out of it, and the exam needs 15 cases\. I can write the exam from the description instead \(20 cases\) — shall I\?/,
		);
		await expect(synthesizeSealedCorpus({ ...request, now: () => at })).rejects.toMatchObject({
			name: "SealedSynthRefusal",
			next: expect.stringContaining("data/kb"),
		});
		// A refusal is a decision, not a wasted call.
		expect(mock.requests()).toBe(0);
		expect(listCorpora({ stateRoot, projectId: "project" })).toEqual([]);
		expect(listSealedSynthReceipts(stateRoot, "project")).toEqual([]);

		setLanguage("ru");
		try {
			expect(() => planSealedSynthesis(request)).toThrow(
				/В базе 3 фрагмента — из неё выходит не больше 9 вопросов, экзамену нужно 15 кейсов\. Могу написать экзамен из описания \(20 кейсов\) — делаем\?/,
			);
		} finally {
			setLanguage("en");
		}
	});

	it("writes the same exam twice for the same dataset hash and seed", async () => {
		const runs = [];
		for (const seed of ["s1", "s1", "s2"]) {
			const mock = await mockKbJudge();
			const { targetDir, stateRoot } = fixture({
				judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
				kb: "long",
			});
			const result = await synthesizeSealedCorpus({
				targetDir,
				stateRoot,
				projectId: "project",
				name: "KB exam",
				count: 15,
				source: "kb",
				seed,
				now: () => at,
			});
			runs.push(loadCorpus({ stateRoot, projectId: "project", corpusId: result.corpus!.id }).tasks.map((task) => task.id));
		}
		// Same dataset hash, same seed, same questions — down to the host-derived
		// case ids, which are a function of the Spec hash and the question.
		expect(runs[1]).toEqual(runs[0]);
		expect(runs[2]).not.toEqual(runs[0]);
	});

	it("drops a passage that asks the question another passage already asked", async () => {
		const mock = await mockKbJudge({ "c.md#0": JSON.stringify(KB_ANSWERS["a.md#0"]) });
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
			kb: true,
		});
		const result = await synthesizeSealedCorpus({
			targetDir,
			stateRoot,
			projectId: "project",
			name: "KB exam",
			count: 3,
			source: "kb",
			now: () => at,
		});
		expect(result.accepted).toBe(2);
		expect(result.droppedDuplicate).toBe(1);
	});
});

describe("the coverage matrix, checks first, and the critic", () => {
	it("asks for the Spec's cells and records the plan beside what it achieved", async () => {
		const prompts: string[] = [];
		const mock = await mockJudgeModel({
			generate: (firstUser) => {
				prompts.push(firstUser);
				return JSON.stringify({
					cases: [
						{
							coverage: { job: SPEC_JOBS[0], difficulty: "direct" },
							checks: { graders: DETERMINISTIC },
							input: `${SENTINEL} прямой вопрос`,
						},
						{
							coverage: { job: SPEC_JOBS[1], difficulty: "policy-trap" },
							checks: {
								graders: [
									{ type: "output_contains", text: "30 дней" },
									{ type: "output_excludes", text: "60 дней" },
								],
							},
							input: `${SENTINEL} у вас же всегда возврат за 60 дней`,
						},
						// An honest case wearing a job the Spec never listed.
						{
							coverage: { job: "Работа, которой нет в Спеке", difficulty: "direct" },
							graders: DETERMINISTIC,
							input: `${SENTINEL} чужая работа`,
						},
						// And one wearing a difficulty nobody defined.
						{
							coverage: { job: SPEC_JOBS[0], difficulty: "невозможная" },
							graders: DETERMINISTIC,
							input: `${SENTINEL} чужая сложность`,
						},
						{ graders: DETERMINISTIC, input: `${SENTINEL} без ярлыка` },
					],
				});
			},
		});
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		const request = { targetDir, stateRoot, projectId: "project", name: "covered exam", count: 5 };

		// The plan states the cells before a token is spent, and the walk is a
		// diagonal: five cases over two jobs already touch five difficulties.
		const plan = planSealedSynthesis(request);
		expect(plan.coverageJobs).toEqual(SPEC_JOBS);
		expect(plan.coverageCells).toEqual([
			{ job: SPEC_JOBS[0], difficulty: "direct", cases: 1 },
			{ job: SPEC_JOBS[1], difficulty: "clarify", cases: 1 },
			{ job: SPEC_JOBS[0], difficulty: "tool", cases: 1 },
			{ job: SPEC_JOBS[1], difficulty: "policy-trap", cases: 1 },
			{ job: SPEC_JOBS[0], difficulty: "out-of-scope", cases: 1 },
		]);
		expect(plan.criticCalls).toBe(1);

		const result = await synthesizeSealedCorpus({ ...request, now: () => at });
		// Every case is kept: a label nobody declared costs the label, not the case.
		expect(result.accepted).toBe(5);
		expect(result.coverage.jobs).toEqual(SPEC_JOBS);
		expect(result.coverage.plan).toEqual(plan.coverageCells);
		expect(result.coverage.achieved).toEqual([
			{ job: SPEC_JOBS[0], difficulty: "direct", cases: 1 },
			{ job: SPEC_JOBS[1], difficulty: "policy-trap", cases: 1 },
		]);
		expect(result.coverage.unlabelled).toBe(3);
		expect(result.coverage.droppedLabel).toBe(2);
		expect(result.receipt.schemaVersion === 4 && result.receipt.coverage).toEqual(result.coverage);

		// The generator was told the rows, the cells and the traps.
		const prompt = prompts[0] ?? "";
		for (const job of SPEC_JOBS) expect(prompt).toContain(`- ${job}`);
		expect(prompt).toContain(`- ${SPEC_JOBS[1]} × policy-trap: 1`);
		expect(prompt).toContain("Checks first, then the request.");
		// `output_excludes` is offered whether or not the suite already uses it;
		// a trap the prompt forbids the shape of is not a trap.
		expect(prompt).toContain("\"type\":\"output_excludes\"");

		// The cells reached the cases themselves, and nothing else did.
		const loaded = loadCorpus({ stateRoot, projectId: "project", corpusId: result.corpus!.id });
		const labelled = loaded.tasks.filter((task) => task.coverage !== undefined);
		expect(labelled).toHaveLength(2);
		expect(labelled.every((task) => SPEC_JOBS.includes(task.coverage!.job))).toBe(true);
		// Every generated case says where it came from, and the host stamped it.
		expect(loaded.tasks.every((task) =>
			task.source?.kind === "generated" && task.source.generator === "judge"
		)).toBe(true);
		const visible = [...renderSealedSynthOutput(result).stdout, ...renderSealedSynthOutput(result).warnings].join("\n");
		expect(visible).not.toContain(SENTINEL);
		expect(JSON.stringify(result.receipt)).not.toContain(SENTINEL);
	});

	it("reads the checks-first shape and the flat shape alike", async () => {
		const mock = await mockJudge(JSON.stringify({
			cases: [
				{
					coverage: { job: SPEC_JOBS[0], difficulty: "tool" },
					checks: {
						graders: [{ type: "output_contains", text: "заморожен" }],
						world: {
							state: { accounts: { "42": { status: "ok" } } },
							expect: [{ path: "accounts.42.status", op: "equals", value: "frozen" }],
						},
						expected: "Договор 42 заморожен",
					},
					input: `${SENTINEL} заморозь договор 42`,
				},
				// The older flat shape is still a correct answer, and still admitted.
				{ input: `${SENTINEL} плоская форма`, expected: "срок 30 дней", graders: DETERMINISTIC },
			],
		}));
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		const result = await synthesizeSealedCorpus({
			targetDir,
			stateRoot,
			projectId: "project",
			name: "checks first",
			count: 2,
			now: () => at,
		});
		expect(result.accepted).toBe(2);
		expect(result.droppedMalformed).toBe(0);

		const loaded = loadCorpus({ stateRoot, projectId: "project", corpusId: result.corpus!.id });
		const worlded = loaded.tasks.find((task) => task.world !== undefined)!;
		// The checks came out of `checks` and onto the case, all three of them.
		expect(worlded.graders).toEqual([{ type: "output_contains", text: "заморожен", caseSensitive: false }]);
		expect(worlded.expected).toBe("Договор 42 заморожен");
		expect(worlded.world?.expect).toEqual([{ path: "accounts.42.status", op: "equals", value: "frozen" }]);
		expect(worlded.coverage).toEqual({ job: SPEC_JOBS[0], difficulty: "tool" });
		const flat = loaded.tasks.find((task) => task.world === undefined)!;
		expect(flat.expected).toBe("срок 30 дней");
		expect(flat.graders?.[0]?.type).toBe("output_contains");
	});

	it("drops a case only a model could mark, and keeps one a world decides", async () => {
		const mock = await mockJudge(JSON.stringify({
			cases: [
				{ input: `${SENTINEL} проверяемый`, graders: DETERMINISTIC },
				// Nothing but an opinion behind it: dropped before the critic is asked.
				{ input: `${SENTINEL} только судья`, graders: [{ type: "judge", rubric: "вежливо ли" }] },
				// A judge grader is fine beside a world the run can check.
				{
					input: `${SENTINEL} судья и мир`,
					graders: [{ type: "judge", rubric: "вежливо ли" }],
					world: {
						state: { orders: { "7": { status: "new" } } },
						expect: [{ path: "orders.7.status", op: "equals", value: "shipped" }],
					},
				},
			],
		}));
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		const result = await synthesizeSealedCorpus({
			targetDir,
			stateRoot,
			projectId: "project",
			name: "judge only",
			count: 3,
			now: () => at,
		});
		expect(result.accepted).toBe(2);
		expect(result.critic?.dropped).toBe(1);
		expect(result.critic?.byCategory["judge-only"]).toBe(1);
		expect(result.receipt.schemaVersion === 4 && result.receipt.critic?.byCategory["judge-only"]).toBe(1);
		const warnings = renderSealedSynthOutput(result).warnings.join("\n");
		expect(warnings).toContain("1 generated case(s) failed the critic and were not sealed: judge-only 1");
		expect(warnings).not.toContain(SENTINEL);
	});

	it("drops what the critic rejects when sealing, in categories and never in its words", async () => {
		const mock = await mockJudge(
			JSON.stringify({
				cases: [
					{ input: `${SENTINEL} годный кейс`, graders: DETERMINISTIC },
					{ input: `${SENTINEL} безответный кейс`, graders: DETERMINISTIC },
					{ input: `${SENTINEL} повторный кейс`, graders: DETERMINISTIC },
					{ input: `${SENTINEL} кривая проверка`, graders: DETERMINISTIC },
				],
			}),
			(input) => {
				// The critic quotes the case it is talking about — which is exactly
				// why none of this text may reach a receipt or a warning.
				if (input.includes("безответный")) {
					return { verdict: "invalid", reasons: [`the specification does not state a window for ${input}`] };
				}
				if (input.includes("повторный")) {
					return { verdict: "invalid", reasons: [`duplicates another case: ${input}`] };
				}
				if (input.includes("кривая")) {
					return { verdict: "repair", reasons: [`the grader compares against the wrong reference in ${input}`] };
				}
				return undefined;
			},
		);
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		const result = await synthesizeSealedCorpus({
			targetDir,
			stateRoot,
			projectId: "project",
			name: "critic exam",
			count: 4,
			now: () => at,
		});

		// A sealed exam is never patched by a model nobody reads, so `repair` goes
		// with `invalid`.
		expect(result.accepted).toBe(1);
		expect(result.corpus?.taskCount).toBe(1);
		expect(result.critic).toMatchObject({ reviewed: 4, dropped: 3 });
		expect(result.critic?.byCategory).toMatchObject({
			unanswerable: 1,
			duplicate: 1,
			"wrong-check": 1,
			"judge-only": 0,
			other: 0,
		});
		expect(result.critic?.spend.calls).toBeGreaterThan(0);

		const rendered = renderSealedSynthOutput(result);
		const visible = [...rendered.stdout, ...rendered.warnings].join("\n");
		expect(visible).toContain(
			"3 generated case(s) failed the critic and were not sealed: unanswerable 1, wrong-check 1, duplicate 1",
		);
		// Not the critic's prose, not the case, not one word of either.
		expect(visible).not.toContain(SENTINEL);
		expect(visible).not.toContain("does not state a window");
		expect(JSON.stringify(result.receipt)).not.toContain(SENTINEL);
		expect(readFileSync(result.receiptPath, "utf8")).not.toContain("wrong reference");
	});

	it("keeps every case on the review path and writes the verdicts beside them", async () => {
		const mock = await mockJudge(
			JSON.stringify({
				cases: [
					{ input: `${SENTINEL} годный кейс`, graders: DETERMINISTIC },
					{ input: `${SENTINEL} безответный кейс`, graders: DETERMINISTIC },
					{ input: `${SENTINEL} кривая проверка`, graders: DETERMINISTIC },
				],
			}),
			(input) => {
				if (input.includes("безответный")) {
					return { verdict: "invalid", reasons: [`the specification does not state it: ${input}`] };
				}
				if (input.includes("кривая")) {
					return { verdict: "repair", reasons: [`the grader is wrong: ${input}`] };
				}
				return undefined;
			},
		);
		const { targetDir, stateRoot, outside } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		const reviewPath = join(outside, "draft.jsonl");
		const result = await synthesizeSealedCorpus({
			targetDir,
			stateRoot,
			projectId: "project",
			name: "reviewed exam",
			count: 3,
			reviewPath,
			now: () => at,
		});

		// Nothing is dropped: the human is the reader, and they decide.
		expect(result.accepted).toBe(3);
		expect(result.critic).toMatchObject({ reviewed: 3, dropped: 0 });
		expect(readFileSync(reviewPath, "utf8").trim().split("\n")).toHaveLength(3);

		const annotations = `${reviewPath}.critic.jsonl`;
		expect(result.criticAnnotationsPath).toBe(annotations);
		// The operator is told the second file exists; it is a path, not a case.
		expect(renderSealedSynthOutput(result).warnings.join("\n")).toContain(`critic verdicts ${annotations}`);
		expect(existsSync(annotations)).toBe(true);
		expect(statSync(annotations).mode & 0o777).toBe(0o600);
		const flagged = readFileSync(annotations, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(flagged).toHaveLength(2);
		expect(flagged.map((finding) => finding.verdict).sort()).toEqual(["invalid", "repair"]);
		expect(flagged.map((finding) => finding.category).sort()).toEqual(["unanswerable", "wrong-check"]);
		for (const finding of flagged) expect(finding.taskId).toMatch(/^synth-[0-9a-f]{24}$/);
		// The verdicts name the case by id and say nothing the critic wrote: the
		// draft beside them holds the cases, and this file holds no second copy.
		const written = readFileSync(annotations, "utf8");
		expect(written).not.toContain(SENTINEL);
		expect(written).not.toContain("the grader is wrong");
		// Nothing was dropped, so nothing warns about the critic.
		expect(renderSealedSynthOutput(result).warnings.join("\n")).not.toContain("failed the critic");
	});

	it("prices the critic's calls in the plan", async () => {
		const mock = await mockJudge(generated(20));
		const { targetDir, stateRoot } = fixture({
			judge: { provider: "fixture-provider", id: "fixture-judge", baseUrl: mock.url },
		});
		const plan = planSealedSynthesis({
			targetDir,
			stateRoot,
			projectId: "project",
			name: "priced exam",
			count: 20,
		});
		// One critic call per batch of eight, and the batches are the run's own.
		expect(plan.criticCalls).toBe(3);
		expect(plan.estimatedCostUsd).toBeGreaterThanOrEqual(0);
	});
});
