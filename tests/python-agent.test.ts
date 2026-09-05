import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The shipped `templates/python-agent/agent.py`, against a stub
 * OpenAI-compatible endpoint the test starts.
 *
 * `src/mock-model.ts` answers the streaming path and never emits `tool_calls`,
 * which is exactly the half this agent needs — so the stub below is deliberate
 * and small: sixty lines that speak the two shapes `agent.py` parses.
 */

const TEMPLATE_DIR = fileURLToPath(new URL("../templates/python-agent", import.meta.url));
const PYTHON = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

interface StubHandle {
	url: string;
	close: () => Promise<void>;
	requests: () => number;
}

/** The two replies `agent.py` knows how to read: a tool call, and an answer. */
function startStub(cost?: unknown): Promise<StubHandle> {
	let requests = 0;
	const server: Server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			if (!(request.url ?? "").includes("/chat/completions")) return void response.writeHead(404).end();
			requests += 1;
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
				messages: { role: string; content?: string }[];
				tools?: unknown[];
			};
			const answered = body.messages.some((message) => message.role === "tool");
			const asksAboutAccount = body.messages.some(
				(message) => message.role === "user" && (message.content ?? "").includes("4412"),
			);
			const message = answered || !asksAboutAccount
				? { role: "assistant", content: answered ? "Ваш тариф «Скоростной», 800 рублей в месяц." : "Самый дешёвый тариф — «Домашний», 500 рублей." }
				: {
					role: "assistant",
					content: "",
					tool_calls: [{
						id: "call_1",
						type: "function",
						function: { name: "get_account", arguments: JSON.stringify({ account: "4412" }) },
					}],
				};
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({
				id: "chatcmpl-stub",
				object: "chat.completion",
				model: "stub",
				choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
				usage: { prompt_tokens: 31, completion_tokens: 9, total_tokens: 40, ...(cost === undefined ? {} : { cost }) },
			}));
		});
	});
	return new Promise((resolvePromise) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") throw new Error("no port");
			resolvePromise({
				url: `http://127.0.0.1:${address.port}/v1`,
				requests: () => requests,
				close: () => new Promise<void>((done) => server.close(() => done())),
			});
		});
	});
}

/** One live `agent.py`, driven by the host half of protocol v2. */
class Agent {
	private readonly lines: string[] = [];
	private buffer = "";
	private wake: (() => void) | undefined;
	readonly stderr: string[] = [];

	constructor(private readonly child: ChildProcess) {
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			this.buffer += chunk;
			let newline = this.buffer.indexOf("\n");
			while (newline >= 0) {
				const line = this.buffer.slice(0, newline).trim();
				this.buffer = this.buffer.slice(newline + 1);
				newline = this.buffer.indexOf("\n");
				if (line) this.lines.push(line);
			}
			this.wake?.();
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => this.stderr.push(chunk));
	}

	send(message: unknown): void {
		this.child.stdin?.write(`${JSON.stringify(message)}\n`);
	}

	async next(): Promise<Record<string, unknown>> {
		const deadline = Date.now() + 30_000;
		for (;;) {
			const line = this.lines.shift();
			if (line) return JSON.parse(line) as Record<string, unknown>;
			if (Date.now() > deadline) throw new Error(`agent.py said nothing; stderr: ${this.stderr.join("")}`);
			await new Promise<void>((done) => {
				const timer = setTimeout(done, 50);
				this.wake = () => {
					clearTimeout(timer);
					done();
				};
			});
		}
	}

	close(): void {
		this.child.kill("SIGKILL");
	}
}

function start(url: string): Agent {
	const child = spawn("python3", ["agent.py"], {
		cwd: TEMPLATE_DIR,
		env: { ...process.env, AHDE_MODEL_API_KEY: "stub-key", AHDE_PROTOCOL: "2" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const agent = new Agent(child);
	agent.send({
		v: 2,
		type: "hello",
		tools: [{
			name: "get_account",
			description: "Тариф, баланс и статус абонента.",
			parameters: { type: "object", properties: { account: { type: "string" } }, required: ["account"] },
		}],
		model: { provider: "openai-compatible", id: "stub", baseUrl: url, apiKeyEnv: "AHDE_MODEL_API_KEY" },
		workspace: TEMPLATE_DIR,
		world: null,
	});
	return agent;
}

let stub: StubHandle;

beforeAll(async () => {
	if (PYTHON) stub = await startStub();
});

afterAll(async () => {
	if (stub) await stub.close();
});

describe.skipIf(!PYTHON)("the shipped python-agent template", () => {
	it.each([
		{ cost: 0.00125, expected: 0.00125 },
		{ cost: 0, expected: 0 },
		{ cost: undefined, expected: undefined },
		{ cost: -0.01, expected: undefined },
		{ cost: "0.01", expected: undefined },
		{ cost: true, expected: undefined },
		{ cost: null, expected: undefined },
	])("reports only a provider's finite nonnegative numeric request cost: $cost", async ({ cost, expected }) => {
		const endpoint = await startStub(cost);
		const agent = start(endpoint.url);
		try {
			agent.send({ v: 2, type: "user", turn: 1, text: "Сколько стоит самый дешёвый тариф?" });
			const usage = await agent.next();
			expect(usage.type).toBe("usage");
			expect(usage.costUsd).toBe(expected);
			expect((await agent.next()).type).toBe("assistant");
		} finally {
			agent.close();
			await endpoint.close();
		}
	});

	it("does not emit non-finite provider prices onto the strict JSON wire", () => {
		const checked = spawnSync("python3", ["-c", [
			"from agent import usage_of",
			"for cost in [float('nan'), float('inf'), float('-inf')]:",
			"    usage = usage_of({'usage': {'prompt_tokens': 1, 'cost': cost}}, 1)",
			"    assert 'costUsd' not in usage",
		].join("\n")], { cwd: TEMPLATE_DIR, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
		expect(checked.status, checked.stderr).toBe(0);
	});

	it("answers a plain question and reports what the endpoint billed", async () => {
		const agent = start(stub.url);
		try {
			agent.send({ v: 2, type: "user", turn: 1, text: "Сколько стоит самый дешёвый тариф?" });
			const usage = await agent.next();
			expect(usage.type).toBe("usage");
			expect(usage.tokens).toEqual({ input: 31, output: 9, cacheRead: 0, cacheWrite: 0, total: 40 });
			// No costUsd: the endpoint published no rates, and inventing one would
			// be a number nobody measured.
			expect(usage.costUsd).toBeUndefined();
			const answer = await agent.next();
			expect(answer.type).toBe("assistant");
			expect(answer.turn).toBe(1);
			expect(String(answer.text)).toContain("500");
		} finally {
			agent.close();
		}
	});

	it("asks the host to run a declared tool and answers from its result", async () => {
		const agent = start(stub.url);
		try {
			agent.send({ v: 2, type: "user", turn: 1, text: "Договор 4412, какой у меня тариф?" });
			const toolSelectionUsage = await agent.next();
			expect(toolSelectionUsage.type).toBe("usage");
			expect(toolSelectionUsage.tokens).toEqual({ input: 31, output: 9, cacheRead: 0, cacheWrite: 0, total: 40 });
			const call = await agent.next();
			expect(call.type).toBe("tool_call");
			expect(call.name).toBe("get_account");
			expect(call.arguments).toEqual({ account: "4412" });
			agent.send({
				v: 2,
				type: "tool_result",
				id: call.id,
				name: "get_account",
				text: JSON.stringify({ account: "4412", tariff: "Скоростной", monthly: 800 }),
				isError: false,
			});
			const usage = await agent.next();
			expect(usage.type).toBe("usage");
			const answer = await agent.next();
			expect(answer.type).toBe("assistant");
			expect(String(answer.text)).toContain("800");
		} finally {
			agent.close();
		}
	});

	it("prints protocol on stdout and diagnostics on stderr, never the other way round", async () => {
		const agent = start(stub.url);
		try {
			agent.send({ v: 2, type: "user", turn: 1, text: "Сколько стоит самый дешёвый тариф?" });
			await agent.next();
			await agent.next();
			// The readiness line the template logs went to stderr, where it belongs.
			expect(agent.stderr.join("")).toContain("готов");
		} finally {
			agent.close();
		}
	});
});
