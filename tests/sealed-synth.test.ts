import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCorpus, listCorpora, CorpusTaskSchema } from "../src/corpus.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import {
	listSealedSynthReceipts,
	renderSealedSynthOutput,
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

function manifestYaml(judge: { provider: string; id: string; baseUrl: string } | null): string {
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
evalSuite:
  id: test-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
${judgeBlock}`;
}

interface Fixture {
	targetDir: string;
	stateRoot: string;
	outside: string;
}

/** A Target whose judge is the mock, plus a private state root and a scratch dir. */
function fixture(options: { judge?: { provider: string; id: string; baseUrl: string } | null; spec?: boolean } = {}): Fixture {
	const targetDir = makeTargetFixture(
		baseFixtureFiles({
			"manifest.yaml": manifestYaml(options.judge === undefined ? null : options.judge),
			"evals/development.jsonl": `${DEV_CASES.map((task) => JSON.stringify(task)).join("\n")}\n`,
			...(options.spec === false ? {} : { "spec.md": SPEC_MD }),
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
		expect(receipt.schemaVersion).toBe(2);
		expect(sealedSynthSource(receipt)).toBe("spec");
		expect(receipt.schemaVersion === 2 && receipt.kbIndexHash).toBeNull();
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
