import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gradeRun, type GradedRun } from "../src/eval.js";
import { ModelBlock, type ResolvedTask, type TargetManifest } from "../src/manifest.js";
import { startMockModel, type MockModelHandle, type MockStep } from "../src/mock-model.js";
import { hashFile } from "../src/provenance.js";
import { baseRunRecord } from "./helpers/judge-fixtures.js";

const cleanupPaths: string[] = [];
const servers: MockModelHandle[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** One USD per input token, so summed juror cost is readable at a glance. */
function judgeModel(url: string): TargetManifest["model"] {
	return ModelBlock.parse({
		provider: "test",
		id: "judge-model",
		api: "openai-completions",
		baseUrl: url,
		apiKeyEnv: "TEST_JUDGE_KEY",
		thinkingLevel: "off",
		timeoutMs: 10_000,
		spec: { cost: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
	});
}

interface JuryRun {
	graded: GradedRun;
	runsRoot: string;
	calls: () => number;
}

/** Grade one judge grader against a scripted sequence of juror responses. */
async function gradeJury(grader: unknown, steps: readonly MockStep[]): Promise<JuryRun> {
	const queue = [...steps];
	let calls = 0;
	const server = await startMockModel([{
		steps: [],
		resolve: () => {
			calls += 1;
			return queue.shift() ?? { text: "{}" };
		},
	}]);
	servers.push(server);
	const runsRoot = mkdtempSync(join(tmpdir(), "ahde-judge-jury-"));
	cleanupPaths.push(runsRoot);
	const trace = `${[
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "вопрос" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "ответ" }] } },
	].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	mkdirSync(join(runsRoot, "run-a"), { recursive: true });
	writeFileSync(join(runsRoot, "run-a", "session.jsonl"), trace);
	const task = {
		id: "task-a",
		input: "вопрос",
		effectiveGraders: [grader] as ResolvedTask["effectiveGraders"],
	} as ResolvedTask;
	const graded = await gradeRun(
		task,
		baseRunRecord({ trace: { path: "session.jsonl", sessionId: null, sha256: hashFile(trace) } }),
		runsRoot,
		judgeModel(server.url),
	);
	return { graded, runsRoot, calls: () => calls };
}

function verdicts(answers: readonly ("yes" | "no" | "unknown")[], evidence = "juror"): MockStep {
	return {
		text: JSON.stringify({
			verdicts: answers.map((answer, offset) => ({
				index: offset + 1,
				answer,
				evidence: `${evidence} ${offset + 1}`,
			})),
		}),
	};
}

const TWO_ASSERTIONS = {
	type: "judge",
	assertions: ["назван срок", "назван канал"],
	jury: 3,
} as const;

describe("judge juries", () => {
	it("decides each assertion by strict majority and records the vote counts", async () => {
		const { graded, calls } = await gradeJury(TWO_ASSERTIONS, [
			verdicts(["yes", "no"], "первый"),
			verdicts(["yes", "no"], "второй"),
			verdicts(["no", "yes"], "третий"),
		]);
		const [result] = graded.graders;
		expect(calls()).toBe(3);
		// Assertion 1: 2/3 yes → decided yes. Assertion 2: 1/3 yes → decided no.
		expect(result?.passed).toBe(false);
		expect(result?.score).toBe(0.5);
		expect(result?.assertions).toEqual({ total: 2, failed: [2] });
		expect(result?.reason).toBe("assertion 2 failed (1/3 yes): первый 2");
	});

	it("says so plainly when the whole jury agrees", async () => {
		const { graded } = await gradeJury(TWO_ASSERTIONS, [
			verdicts(["yes", "yes"]),
			verdicts(["yes", "yes"]),
			verdicts(["yes", "yes"]),
		]);
		expect(graded.graders[0]?.passed).toBe(true);
		expect(graded.graders[0]?.reason).toBe("2/2 assertions passed (jury 3)");
	});

	it("fails a tie: an even jury that splits has decided nothing", async () => {
		const { graded } = await gradeJury(
			{ type: "judge", assertions: ["назван срок"], jury: 2 },
			[verdicts(["yes"], "за"), verdicts(["no"], "против")],
		);
		expect(graded.graders[0]?.passed).toBe(false);
		expect(graded.graders[0]?.reason).toBe("assertion 1 failed (1/2 yes): против 1");

		const rubricTie = await gradeJury(
			{ type: "judge", rubric: "вежливо", jury: 2 },
			[
				{ text: JSON.stringify({ passed: true, reason: "мне нравится" }) },
				{ text: JSON.stringify({ passed: false, reason: "мне не нравится" }) },
			],
		);
		expect(rubricTie.graded.graders[0]?.passed).toBe(false);
		expect(rubricTie.graded.graders[0]?.reason).toBe("jury 1/2 passed · мне не нравится");
		expect(rubricTie.graded.graders[0]?.score).toBe(0.5);
	});

	it("carries a prose rubric by majority and scores how divided the jury was", async () => {
		const { graded } = await gradeJury(
			{ type: "judge", rubric: "вежливо", jury: 3 },
			[
				{ text: JSON.stringify({ passed: true, reason: "да" }) },
				{ text: JSON.stringify({ passed: false, reason: "нет" }) },
				{ text: JSON.stringify({ passed: true, reason: "тоже да" }) },
			],
		);
		expect(graded.graders[0]?.passed).toBe(true);
		expect(graded.graders[0]?.reason).toBe("jury 2/3 passed · да");
		expect(graded.graders[0]?.score).toBeCloseTo(2 / 3, 10);
	});

	it("gives every juror its own sidecar, its own retries, and sums their metrics", async () => {
		const { graded, runsRoot, calls } = await gradeJury(TWO_ASSERTIONS, [
			verdicts(["yes", "yes"]),
			{ httpError: { status: 503, message: "gateway hiccup" } },
			verdicts(["yes", "yes"]),
			verdicts(["yes", "no"]),
		]);
		const judgeDir = join(runsRoot, "run-a", "judge");
		// Juror 1 answered first time; juror 2 needed a retry; juror 3 answered.
		expect(existsSync(join(judgeDir, "0.1.json"))).toBe(true);
		expect(existsSync(join(judgeDir, "0.2.1.json"))).toBe(true);
		expect(existsSync(join(judgeDir, "0.2.json"))).toBe(true);
		expect(existsSync(join(judgeDir, "0.3.json"))).toBe(true);
		// The historical single-judge name is never reused by a jury.
		expect(existsSync(join(judgeDir, "0.json"))).toBe(false);
		expect(calls()).toBe(4);
		expect(graded.judge).toEqual({ calls: 4, tokens: 3 * 49, costUsd: 3 * 42 });
		expect(graded.graders[0]?.passed).toBe(true);

		const verdict = JSON.parse(readFileSync(join(judgeDir, "0.verdict.json"), "utf8")) as {
			jury: { juror: number; passed: boolean; answers: string[] }[];
		};
		expect(verdict.jury.map((juror) => juror.answers)).toEqual([
			["yes", "yes"],
			["yes", "yes"],
			["yes", "no"],
		]);
	});

	it("lets a jury sample: three identical greedy calls would measure nothing", async () => {
		const { runsRoot } = await gradeJury(
			{ type: "judge", rubric: "вежливо", jury: 2 },
			[
				{ text: JSON.stringify({ passed: true, reason: "да" }) },
				{ text: JSON.stringify({ passed: true, reason: "да" }) },
			],
		);
		const juror = JSON.parse(readFileSync(join(runsRoot, "run-a", "judge", "0.1.json"), "utf8")) as {
			request: { body: Record<string, unknown> };
		};
		expect(Object.hasOwn(juror.request.body, "temperature")).toBe(false);

		const single = await gradeJury(
			{ type: "judge", rubric: "вежливо" },
			[{ text: JSON.stringify({ passed: true, reason: "да" }) }],
		);
		const alone = JSON.parse(readFileSync(join(single.runsRoot, "run-a", "judge", "0.json"), "utf8")) as {
			request: { body: { temperature?: number } };
		};
		expect(alone.request.body.temperature).toBe(0);
	});
});
