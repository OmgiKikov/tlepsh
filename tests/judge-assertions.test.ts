import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gradeRun } from "../src/eval.js";
import { GraderSpec, ModelBlock, type ResolvedTask, type TargetManifest } from "../src/manifest.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import { GraderResultSchema, hashFile, hashValue, type GraderResult, type RunRecord } from "../src/provenance.js";
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
): Promise<{ results: GraderResult[]; runsRoot: string; requests: () => number }> {
	const queue = [...replies];
	const server = await startMockModel([{ steps: [], resolve: () => ({ text: queue.shift() ?? "{}" }) }]);
	servers.push(server);
	const runsRoot = mkdtempSync(join(tmpdir(), "ahde-judge-assertions-"));
	cleanupPaths.push(runsRoot);
	const trace = `${[
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "вопрос" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: answer }] } },
	].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	mkdirSync(join(runsRoot, "run-a"), { recursive: true });
	writeFileSync(join(runsRoot, "run-a", "session.jsonl"), trace);
	const task = {
		id: "task-a",
		input: "вопрос",
		effectiveGraders: graders as ResolvedTask["effectiveGraders"],
	} as ResolvedTask;
	const record: RunRecord = baseRunRecord({
		trace: { path: "session.jsonl", sessionId: null, sha256: hashFile(trace) },
	});
	const graded = await gradeRun(task, record, runsRoot, judgeModel(server.url));
	return { results: graded.graders, runsRoot, requests: server.requests };
}

const RUBRIC = { type: "judge", rubric: "Ответ полный и вежливый" } as const;
const ASSERTIONS = {
	type: "judge",
	assertions: ["назван срок", "назван канал подачи", "нет обещаний, которых банк не даёт"],
} as const;

describe("assertion rubrics", () => {
	it("scores yes/no/unknown as yes over total and passes only on all yes", async () => {
		const { results } = await grade(
			[ASSERTIONS],
			"Срок 30 дней.",
			[JSON.stringify({
				verdicts: [
					{ index: 1, answer: "yes", evidence: "«Срок 30 дней»" },
					{ index: 2, answer: "no", evidence: "канал не назван" },
					{ index: 3, answer: "unknown", evidence: "ответ слишком короткий" },
				],
			})],
		);
		const [result] = results;
		expect(result?.passed).toBe(false);
		expect(result?.score).toBeCloseTo(1 / 3, 10);
		expect(result?.reason).toBe(
			"assertion 2 failed: канал не назван; assertion 3 unknown: ответ слишком короткий",
		);
		expect(result?.assertions).toEqual({ total: 3, failed: [2, 3] });
		expect(result?.checkCode).toBe("semantic-rubric");
	});

	it("passes only when every assertion is yes, and says so deterministically", async () => {
		const { results } = await grade(
			[ASSERTIONS],
			"Срок 30 дней, подайте через приложение.",
			[JSON.stringify({
				verdicts: [1, 2, 3].map((index) => ({ index, answer: "yes", evidence: `цитата ${index}` })),
			})],
		);
		expect(results[0]?.passed).toBe(true);
		expect(results[0]?.score).toBe(1);
		expect(results[0]?.reason).toBe("3/3 assertions passed");
		expect(results[0]?.assertions).toEqual({ total: 3, failed: [] });
	});

	it("treats a skipped, duplicated, or unparseable assertion as unknown, never as a pass", async () => {
		const { results } = await grade(
			[ASSERTIONS],
			"Ответ",
			[JSON.stringify({
				verdicts: [
					{ index: 1, answer: "yes", evidence: "ок" },
					{ index: 1, answer: "no", evidence: "дубликат игнорируется" },
					{ index: 7, answer: "yes", evidence: "несуществующее утверждение" },
					{ index: 2, answer: "maybe", evidence: "не тот ответ" },
				],
			})],
		);
		expect(results[0]?.passed).toBe(false);
		expect(results[0]?.assertions).toEqual({ total: 3, failed: [2, 3] });
		expect(results[0]?.reason).toContain("assertion 2 unknown: judge returned no verdict for this assertion");
	});

	it("fails the run loudly when the envelope itself is not a verdicts array", async () => {
		await expect(grade([ASSERTIONS], "Ответ", [JSON.stringify({ passed: true })]))
			.rejects.toThrow(/missing a verdicts array/);
	});

	it("keeps the failure fingerprint on the grader spec, never on the judge's prose", async () => {
		const first = await grade(
			[ASSERTIONS],
			"Ответ",
			[JSON.stringify({
				verdicts: [
					{ index: 1, answer: "yes", evidence: "первая формулировка" },
					{ index: 2, answer: "no", evidence: "судья написал так" },
					{ index: 3, answer: "yes", evidence: "ещё одна" },
				],
			})],
		);
		const second = await grade(
			[ASSERTIONS],
			"Совсем другой ответ",
			[JSON.stringify({
				verdicts: [
					{ index: 1, answer: "yes", evidence: "совершенно иная цитата" },
					{ index: 2, answer: "no", evidence: "и обоснование другое" },
					{ index: 3, answer: "yes", evidence: "третья" },
				],
			})],
		);
		const [a] = first.results;
		const [b] = second.results;
		// Free-text evidence differs...
		expect(a?.reason).not.toBe(b?.reason);
		// ...and nothing that enters a failure-mode signature does. This is the
		// exact pair improvement-brief.ts hashes into its discriminator.
		expect(a?.specHash).toBe(b?.specHash);
		expect(a?.checkCode).toBe(b?.checkCode);
		expect(hashValue({ checkCode: a?.checkCode, specHash: a?.specHash }))
			.toBe(hashValue({ checkCode: b?.checkCode, specHash: b?.specHash }));
		// The structure that survives is the assertion index, not the wording.
		expect(a?.assertions).toEqual({ total: 3, failed: [2] });
		expect(a?.assertions).toEqual(b?.assertions);
	});

	it("asks for one verdict per assertion and stores the exchange it graded on", async () => {
		const { runsRoot } = await grade(
			[ASSERTIONS],
			"Ответ",
			[JSON.stringify({ verdicts: [{ index: 1, answer: "yes", evidence: "ок" }] })],
		);
		const sidecar = JSON.parse(readFileSync(join(runsRoot, "run-a", "judge", "0.json"), "utf8")) as {
			request: { body: { messages: { role: string; content: string }[]; temperature?: number } };
		};
		const prompt = sidecar.request.body.messages[1]!.content;
		expect(sidecar.request.body.messages[0]!.content).toContain('"verdicts"');
		expect(prompt).toContain("1. назван срок");
		expect(prompt).toContain("3. нет обещаний, которых банк не даёт");
		expect(prompt).toContain("<ответ агента>");
		// One judge is still a grader, not a sampler.
		expect(sidecar.request.body.temperature).toBe(0);
		const verdict = JSON.parse(readFileSync(join(runsRoot, "run-a", "judge", "0.verdict.json"), "utf8")) as {
			assertions: { index: number; answer: string }[];
		};
		expect(verdict.assertions.map((entry) => entry.answer)).toEqual(["yes", "unknown", "unknown"]);
	});

	it("leaves a rubric-only judge byte-identical: same prompt, same names, no verdict sidecar", async () => {
		const { results, runsRoot } = await grade(
			[RUBRIC],
			"Ответ",
			[JSON.stringify({ passed: true, reason: "всё хорошо" })],
		);
		expect(results[0]).toMatchObject({ passed: true, score: 1, reason: "всё хорошо" });
		expect(results[0]?.assertions).toBeUndefined();
		const sidecar = JSON.parse(readFileSync(join(runsRoot, "run-a", "judge", "0.json"), "utf8")) as {
			request: { body: { messages: { content: string }[]; temperature?: number } };
		};
		expect(sidecar.request.body.messages[1]!.content)
			.toBe("Критерий: Ответ полный и вежливый\n\nОбращение: вопрос\n\nОтвет агента: Ответ");
		expect(sidecar.request.body.temperature).toBe(0);
		expect(() => readFileSync(join(runsRoot, "run-a", "judge", "0.verdict.json"), "utf8")).toThrow();
	});
});

describe("assertion rubric schema", () => {
	it("accepts a rubric, assertions, or both, and a bounded jury", () => {
		expect(GraderSpec.safeParse(RUBRIC).success).toBe(true);
		expect(GraderSpec.safeParse(ASSERTIONS).success).toBe(true);
		expect(GraderSpec.safeParse({ ...ASSERTIONS, rubric: "и общий критерий" }).success).toBe(true);
		expect(GraderSpec.safeParse({ ...ASSERTIONS, jury: 3 }).success).toBe(true);
		expect(GraderSpec.safeParse({ ...RUBRIC, jury: 5 }).success).toBe(true);
	});

	it("rejects an empty judge, an oversized or duplicated list, and a jury out of range", () => {
		expect(GraderSpec.safeParse({ type: "judge" }).success).toBe(false);
		expect(GraderSpec.safeParse({ type: "judge", assertions: [] }).success).toBe(false);
		expect(GraderSpec.safeParse({ type: "judge", assertions: ["a", "a"] }).success).toBe(false);
		expect(GraderSpec.safeParse({
			type: "judge",
			assertions: Array.from({ length: 13 }, (_unused, index) => `check ${index}`),
		}).success).toBe(false);
		expect(GraderSpec.safeParse({ ...RUBRIC, jury: 0 }).success).toBe(false);
		expect(GraderSpec.safeParse({ ...RUBRIC, jury: 6 }).success).toBe(false);
		expect(GraderSpec.safeParse({ ...RUBRIC, jury: 2.5 }).success).toBe(false);
		// The A–E factuality rubric is one protocol with one answer.
		expect(GraderSpec.safeParse({ ...ASSERTIONS, withReference: true }).success).toBe(false);
	});

	it("keeps every pre-assertion judge spec hash exactly where it was", () => {
		// Canonical JSON drops absent fields, so evidence graded before assertions
		// existed still hashes to the same grader identity.
		expect(hashValue(GraderSpec.parse(RUBRIC)))
			.toBe(hashValue({ type: "judge", rubric: "Ответ полный и вежливый" }));
		expect(hashValue(GraderSpec.parse({ ...RUBRIC, withReference: true })))
			.toBe(hashValue({ type: "judge", rubric: "Ответ полный и вежливый", withReference: true }));
	});

	it("records per-assertion outcomes only as a consistent, ascending, unique index list", () => {
		const base = { name: "n", type: "judge", passed: false, score: 0, reason: "r" };
		expect(GraderResultSchema.safeParse({ ...base, assertions: { total: 3, failed: [1, 3] } }).success).toBe(true);
		expect(GraderResultSchema.safeParse({ ...base, assertions: { total: 3, failed: [3, 1] } }).success).toBe(false);
		expect(GraderResultSchema.safeParse({ ...base, assertions: { total: 3, failed: [1, 1] } }).success).toBe(false);
		expect(GraderResultSchema.safeParse({ ...base, assertions: { total: 3, failed: [4] } }).success).toBe(false);
		// passed must reflect the list: no silently passing failure.
		expect(GraderResultSchema.safeParse({ ...base, assertions: { total: 3, failed: [] } }).success).toBe(false);
		expect(GraderResultSchema.safeParse({
			...base,
			passed: true,
			score: 1,
			assertions: { total: 3, failed: [] },
		}).success).toBe(true);
	});
});
