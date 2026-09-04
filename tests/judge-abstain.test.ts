import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gradeRun, judgePromptsFor, JUDGE_ABSTAIN_EVALUATOR_ID, judgeVerdictUnreadable } from "../src/eval.js";
import { ModelBlock, type ResolvedTask, type TargetManifest } from "../src/manifest.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import {
	AHDE_EVALUATOR_ID,
	GraderResultSchema,
	hashFile,
	hashValue,
	RunRecordSchema,
	type GraderResult,
	type RunRecord,
} from "../src/provenance.js";
import { baseRunRecord } from "./helpers/judge-fixtures.js";

const cleanupPaths: string[] = [];
const servers: MockModelHandle[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function judgeModel(url: string): TargetManifest["model"] {
	return ModelBlock.parse({
		provider: "test",
		id: "judge-model",
		api: "openai-completions",
		baseUrl: url,
		apiKeyEnv: "TEST_JUDGE_KEY",
		thinkingLevel: "off",
		timeoutMs: 10_000,
	});
}

/** Grade one answer through the real trace path, with a scripted judge. */
async function grade(
	graders: unknown[],
	answer: string,
	replies: readonly string[],
	task: Partial<ResolvedTask> = {},
): Promise<{ results: GraderResult[]; runsRoot: string }> {
	const queue = [...replies];
	const server = await startMockModel([{ steps: [], resolve: () => ({ text: queue.shift() ?? "{}" }) }]);
	servers.push(server);
	const runsRoot = mkdtempSync(join(tmpdir(), "ahde-judge-abstain-"));
	cleanupPaths.push(runsRoot);
	const trace = `${[
		{ role: "user", text: "вопрос" },
		{ role: "assistant", text: answer },
	].map((turn) => JSON.stringify({
		type: "message",
		message: { role: turn.role, content: [{ type: "text", text: turn.text }] },
	})).join("\n")}\n`;
	mkdirSync(join(runsRoot, "run-a"), { recursive: true });
	writeFileSync(join(runsRoot, "run-a", "session.jsonl"), trace);
	const resolved = {
		id: "task-a",
		input: "вопрос",
		...task,
		effectiveGraders: graders as ResolvedTask["effectiveGraders"],
	} as ResolvedTask;
	const record: RunRecord = baseRunRecord({
		trace: { path: "session.jsonl", sessionId: null, sha256: hashFile(trace) },
	});
	const graded = await gradeRun(resolved, record, runsRoot, judgeModel(server.url));
	return { results: graded.graders, runsRoot };
}

const RUBRIC = { type: "judge", rubric: "Ответ полный и вежливый" } as const;
const ASSERTIONS = {
	type: "judge",
	assertions: ["назван срок", "назван канал подачи"],
} as const;

/**
 * The three protocols, under the id that offers the third answer. An abstention
 * is always a failure scored 0: an unanswered check has not been passed, so
 * guessing buys the answer nothing.
 */
describe("every judge protocol can say it does not know", () => {
	it("records a rubric-only abstention as a failure the judge did not decide", async () => {
		const { results } = await grade(
			[RUBRIC],
			"…",
			[JSON.stringify({ passed: "unknown", reason: "ответ пустой, судить не о чем" })],
		);
		expect(results[0]).toMatchObject({
			passed: false,
			score: 0,
			abstained: true,
			reason: "ответ пустой, судить не о чем",
		});
	});

	it("records the reference protocol's U as an abstention, failing and scored 0", async () => {
		const { results } = await grade(
			[{ ...RUBRIC, withReference: true }],
			"Не знаю",
			[JSON.stringify({ choice: "U", reason: "нечего сравнивать" })],
			{ expected: "30 дней" },
		);
		expect(results[0]).toMatchObject({ passed: false, score: 0, abstained: true });
		expect(results[0]?.reason).toBe("U: нечего сравнивать");
	});

	it("marks an assertion rubric abstained when any single assertion is unknown", async () => {
		const { results } = await grade(
			[ASSERTIONS],
			"Срок 30 дней.",
			[JSON.stringify({
				verdicts: [
					{ index: 1, answer: "yes", evidence: "«30 дней»" },
					{ index: 2, answer: "unknown", evidence: "канал не упомянут вовсе" },
				],
			})],
		);
		expect(results[0]).toMatchObject({ passed: false, abstained: true });
		expect(results[0]?.score).toBeCloseTo(0.5, 10);
	});

	it("leaves a decided verdict with no abstention key at all", async () => {
		const { results } = await grade([RUBRIC], "Ответ", [JSON.stringify({ passed: true, reason: "ок" })]);
		expect(results[0]?.passed).toBe(true);
		expect(Object.hasOwn(results[0]!, "abstained")).toBe(false);
	});

	it("still refuses a verdict that is neither a boolean nor the abstention", async () => {
		await expect(grade([RUBRIC], "Ответ", [JSON.stringify({ passed: "maybe", reason: "?" })]))
			.rejects.toThrow(/judge verdict missing boolean passed/);
	});
});

/**
 * The whole fence. Every verdict on disk was produced by the v2 strings, so
 * they are pinned by hash: a refactor that moves one byte of them makes old
 * evidence silently incomparable, which is the failure this id exists to stop.
 */
describe("the evaluator id decides which question the judge is asked", () => {
	const V2_PROMPT_HASHES = {
		rubric: "sha256:c940ecdb7beebf4c161684bd89b33c1df1af30b92220fdc3d6441846e3035edb",
		reference: "sha256:9f94aac5250eadddd386c081497007b0d4b4d12a408da28b19b578e6b73a466c",
		assertions: "sha256:e9ecb596be59cd5c35acf9cad2506cc0b053e5d127527a1be178d346ac1ba3d5",
	};

	it("keeps the v2 prompts byte-identical under the previous id", () => {
		const previous = judgePromptsFor("ahde-evaluator-v2");
		expect(previous.abstain).toBe(false);
		expect(hashValue(previous.rubric)).toBe(V2_PROMPT_HASHES.rubric);
		expect(hashValue(previous.reference)).toBe(V2_PROMPT_HASHES.reference);
		expect(hashValue(previous.assertions)).toBe(V2_PROMPT_HASHES.assertions);
		// The frozen pair says pass or fail, and nothing else.
		expect(previous.rubric).not.toContain("unknown");
		expect(previous.reference).not.toContain('"U"');
	});

	it("offers the third answer only under the id that introduced it", () => {
		expect(judgePromptsFor(AHDE_EVALUATOR_ID)).toEqual(judgePromptsFor(JUDGE_ABSTAIN_EVALUATOR_ID));
		const current = judgePromptsFor(AHDE_EVALUATOR_ID);
		expect(current.abstain).toBe(true);
		expect(current.rubric).toContain('"unknown"');
		expect(current.reference).toContain('"U"');
		// An unknown id is not a licence to invent a protocol: it gets the frozen
		// pair, because evidence under an id this build does not know is old.
		expect(judgePromptsFor("ahde-evaluator-v1")).toEqual(judgePromptsFor("ahde-evaluator-v2"));
	});
});

describe("the persisted signal", () => {
	it("refuses an abstained verdict that claims to have passed", () => {
		const decided = {
			name: "rubric",
			type: "judge",
			passed: false,
			score: 0,
			reason: "не смог решить",
			abstained: true,
		};
		expect(GraderResultSchema.parse(decided).abstained).toBe(true);
		expect(() => GraderResultSchema.parse({ ...decided, passed: true, score: 1 }))
			.toThrow(/an abstained judge verdict cannot pass/);
	});

	it("re-validates a run.json written before abstention existed, byte for byte", () => {
		const legacy = JSON.parse(readFileSync(
			join(import.meta.dirname, "fixtures", "legacy-judge-run.json"),
			"utf8",
		)) as unknown;
		const parsed = RunRecordSchema.parse(legacy);
		expect(hashValue(parsed)).toBe(hashValue(legacy));
		expect(Object.hasOwn(parsed.evalResults!.graders[0]!, "abstained")).toBe(false);
	});
});

describe("reading a run error", () => {
	it("recognizes every unreadable-verdict message and nothing else", () => {
		expect(judgeVerdictUnreadable("evaluation infrastructure: judge returned unparseable verdict: {")).toBe(true);
		expect(judgeVerdictUnreadable("evaluation infrastructure: judge verdict missing boolean passed: x")).toBe(true);
		expect(judgeVerdictUnreadable("evaluation infrastructure: judge verdict missing a verdicts array: x")).toBe(true);
		expect(judgeVerdictUnreadable("evaluation infrastructure: judge verdict missing an A–E choice: x")).toBe(true);
		expect(judgeVerdictUnreadable("judge request failed: 503")).toBe(false);
		expect(judgeVerdictUnreadable(null)).toBe(false);
	});
});
