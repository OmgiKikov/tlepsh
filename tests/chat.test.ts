import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInteractiveSession } from "../src/runner.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";

/**
 * `ahde chat`: a live multi-turn companion session on the same Pi runtime.
 * The mock routes by last user message, so each conversation turn gets its
 * own canned reply — proving repeated prompt() calls (the "talk" part).
 */

let mock: MockModelHandle;
let runsRoot: string;

beforeAll(async () => {
	mock = await startMockModel([
		{
			match: ({ lastUser }) => lastUser.includes("агент для тикетов"),
			steps: [{ text: "Соберу: запускаю ahde init my-agent и правлю манифест под классификацию тикетов." }],
		},
		{
			match: ({ lastUser }) => lastUser.includes("baseline"),
			steps: [{ text: "Готово: baseline 6/10, bundle лежит в runs/. Дальше — builder?" }],
		},
		{
			match: ({ lastUser }) => lastUser.includes("привет"),
			steps: [{ text: "Привет! Я оператор AHDE. Соберём агента, прогоним бенчмарк?" }],
		},
	]);
	runsRoot = join(tmpdir(), `ahde-chat-runs-${Date.now()}`);
	process.env.MOCK_MODEL_KEY = "test";
});

afterAll(async () => {
	rmSync(runsRoot, { recursive: true, force: true });
	await mock.close();
});

const COMPANION_MODEL = {
	provider: "companion-mock",
	id: "mock",
	api: "openai-completions",
	baseUrl: "", // set in the test (mock port is dynamic)
	apiKeyEnv: "MOCK_MODEL_KEY",
	thinkingLevel: "off",
	timeoutMs: 60000,
	params: {},
	spec: { reasoning: false, contextWindow: 131072, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: {} },
} as const;

describe("ahde chat (interactive companion session)", () => {
	it("holds a multi-turn conversation and writes the full transcript to the run dir", async () => {
		const { session, sessionManager, runDir } = await createInteractiveSession({
			runsRoot,
			model: { ...COMPANION_MODEL, baseUrl: mock.url },
			agentsMdContent: "# Companion\nТы оператор AHDE.\n",
			cwd: runsRoot,
		});
		try {
			await session.prompt("привет");
			expect(session.getLastAssistantText()).toContain("оператор AHDE");

			await session.prompt("собери агент для тикетов");
			expect(session.getLastAssistantText()).toContain("ahde init");

			await session.prompt("прогони baseline");
			expect(session.getLastAssistantText()).toContain("6/10");

			// Same conversation: earlier turns are still in context.
			expect(session.messages.filter((m) => m.role === "user")).toHaveLength(3);

			const sessionFile = sessionManager.getSessionFile();
			expect(sessionFile).toBeTruthy();
			const transcript = readFileSync(sessionFile ?? "", "utf8");
			expect(transcript).toContain("привет");
			expect(transcript).toContain("оператор AHDE");
		} finally {
			session.dispose();
		}
	}, 60_000);
});
