import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const SPEC_MD = `# Support answer agent

Отвечает на обращения клиентов банка по договорам и ДБО.

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
 * A judge that answers every passage with exactly as many distinct
 * question-and-answer pairs as the prompt asked it for.
 */
async function mockKbJudge(overrides: Record<string, string> = {}): Promise<MockModelHandle> {
	const mock = await startMockModel([{
		match: () => true,
		resolve: ({ firstUser }) => {
			const passageId = /# Passage (\S+)/.exec(firstUser)?.[1] ?? "";
			const override = overrides[passageId];
			if (override !== undefined) return { text: override };
			const asked = Number(/Write (\d+) different/.exec(firstUser)?.[1] ?? "1");
			return { text: JSON.stringify({ questions: kbPairs(passageId, asked) }) };
		},
		steps: [],
	}]);
	mocks.push(mock);
	return mock;
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

async function mockJudge(text: string): Promise<MockModelHandle> {
	const mock = await startMockModel([{ match: () => true, steps: [{ text }] }]);
	mocks.push(mock);
	return mock;
}

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
		expect(receipt.schemaVersion).toBe(3);
		expect(sealedSynthSource(receipt)).toBe("spec");
		expect(receipt.schemaVersion === 3 && receipt.kbIndexHash).toBeNull();
		expect(receipt.schemaVersion === 3 && receipt.kbChunkChars).toBeNull();
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
		const mock = await startMockModel([{
			match: ({ firstUser }) => {
				prompts.push(firstUser);
				return true;
			},
			steps: [{ text: generated(2) }],
		}]);
		mocks.push(mock);
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
		expect(rendered.stdout.join("\n")).toContain("ahde corpus import");
		expect(rendered.stdout.join("\n")).toContain("--visibility sealed");
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
		expect(receipt.schemaVersion).toBe(3);
		expect(sealedSynthSource(receipt)).toBe("kb");
		expect(receipt.schemaVersion === 3 && receipt.kbIndexHash).toMatch(/^sha256:[0-9a-f]{64}$/);
		// Three questions fit in three runtime passages, so the base was read at
		// the runtime geometry and the receipt says so.
		expect(receipt.schemaVersion === 3 && receipt.kbChunkChars).toBe(KB_CHUNK_CHARS);
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
		expect(mock.requests()).toBe(3);
		const loaded = loadCorpus({ stateRoot, projectId: "project", corpusId: result.corpus!.id });
		// Nine distinct questions, three per passage, every one citing its chunk.
		expect(new Set(loaded.tasks.map((task) => task.input)).size).toBe(9);
		const perChunk = new Map<string, number>();
		for (const task of loaded.tasks) {
			const chunk = String(task.metadata?.kbChunk);
			expect(["a.md#0", "b.md#0", "c.md#0"]).toContain(chunk);
			expect(task.graders?.[0]).toEqual({ type: "cites_source", chunk, minOverlap: 0.35 });
			perChunk.set(chunk, (perChunk.get(chunk) ?? 0) + 1);
		}
		expect([...perChunk.values()]).toEqual([3, 3, 3]);
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
		expect(receipt.schemaVersion === 3 && receipt.kbChunkChars).toBe(KB_CHUNK_CHARS / 2);
		// The index hash still describes the RUNTIME index: the finer read is the
		// generator's, and the receipt's chunk length is what makes it readable.
		expect(receipt.schemaVersion === 3 && receipt.kbIndexHash)
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
			expect(task.graders?.[0]).toEqual({ type: "cites_source", chunk, minOverlap: 0.35 });
			// The finer passage is recorded beside it: which part of the chunk the
			// question stands on is evidence, not a secret.
			expect(String(task.metadata?.kbPassage).startsWith(`${chunk}/`)).toBe(true);
		}
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
