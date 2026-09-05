import { createServer, type Server } from "node:http";

/**
 * Scriptable OpenAI-compatible chat-completions server for tests and demos.
 *
 * The mock simulates a target model whose behavior depends on its context.
 * It is STATELESS: each response is chosen by
 *   script   = first script whose `match(system, firstUser)` returns true
 *   step     = number of tool-result messages already in the request
 * so identical inputs always produce identical outputs — which is exactly
 * what an improvement loop needs (patch the harness → the routed script
 * changes → behavior changes; re-running a scenario replays it).
 *
 * The Pi harness around the mock (skills, tools, session, tracing) is fully
 * real — only the model is canned.
 */

export interface MockToolCall {
	id?: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface MockStep {
	/** Final text answer (ends the turn). */
	text?: string;
	/** Emit a tool call; the real harness executes it and sends the result back. */
	toolCall?: MockToolCall;
	/** Respond with an HTTP error (simulates provider failure). */
	httpError?: { status: number; message: string };
	/**
	 * Hold the response for this long before answering (simulates provider
	 * latency). Concurrency tests need one slow task to overlap fast ones.
	 */
	delayMs?: number;
}

export interface MockScript {
	/** Router: inspect the system prompt and first user message of each request. */
	match?: (body: { system: string; firstUser: string; lastUser: string; toolCount: number }) => boolean;
	/**
	 * Optional deterministic request resolver for agentic acceptance tests whose
	 * next tool arguments depend on prior tool results. When present it replaces
	 * static `steps` lookup, while the complete conversation remains the source
	 * of truth (the server itself still keeps no session state).
	 */
	resolve?: (body: MockRequestContext) => MockStep;
	steps: MockStep[];
}

export interface MockRequestContext {
	system: string;
	firstUser: string;
	lastUser: string;
	toolCount: number;
	toolResults: string[];
	/** Every conversation message in request order, so a test can assert on seeded history. */
	messages: { role: string; text: string }[];
}

export interface MockModelHandle {
	server: Server;
	url: string;
	port: number;
	requests: () => number;
	close: () => Promise<void>;
}

interface ChatMessage {
	role: string;
	content: unknown;
}

interface ChatRequest {
	model?: string;
	messages?: ChatMessage[];
	system?: string | ChatMessage[];
	tools?: unknown[];
	stream?: boolean;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : ""))
			.join("");
	}
	return "";
}

function sseChunk(payload: Record<string, unknown>): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function stepToSse(model: string, step: MockStep): string {
	const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;
	const created = Math.floor(Date.now() / 1000);
	const base = { id, object: "chat.completion.chunk", created, model };
	const usage = { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 };

	if (step.toolCall) {
		const call = {
			index: 0,
			id: step.toolCall.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
			type: "function",
			function: {
				name: step.toolCall.name,
				arguments: JSON.stringify(step.toolCall.arguments),
			},
		};
		return (
			sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] }) +
			sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage }) +
			"data: [DONE]\n\n"
		);
	}

	const text = step.text ?? "";
	return (
		sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }) +
		sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }) +
		"data: [DONE]\n\n"
	);
}

export function startMockModel(scripts: MockScript[], fallback?: MockScript): Promise<MockModelHandle> {
	if (scripts.length === 0) throw new Error("mock model needs at least one script");
	const defaultScript = fallback ?? scripts[scripts.length - 1];
	if (!defaultScript) throw new Error("unreachable");
	let requestCount = 0;

	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const url = req.url ?? "";
			if (!url.includes("/chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			let body: ChatRequest;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
			} catch {
				res.writeHead(400).end("invalid json");
				return;
			}
			requestCount += 1;
			const messages = body.messages ?? [];
			const firstUser = messages.find((m) => m.role === "user");
			const lastUser = [...messages].reverse().find((m) => m.role === "user");
			const system =
				typeof body.system === "string"
					? body.system
					: Array.isArray(body.system)
						? contentText(body.system)
						: contentText(messages.find((m) => m.role === "system")?.content);
			const model = body.model ?? "mock-model";

			const contextBase = {
				system,
				firstUser: contentText(firstUser?.content),
				lastUser: contentText(lastUser?.content),
				toolCount: body.tools?.length ?? 0,
			};
			const script =
				scripts.find((s) =>
					s.match?.(contextBase),
				) ?? defaultScript;
			// Stateless step selection: how many tool results has the harness sent back so far.
			const toolResults = messages.filter((m) => m.role === "tool").map((message) => contentText(message.content));
			const step = script.resolve?.({
				...contextBase,
				toolResults,
				messages: messages.map((message) => ({ role: message.role, text: contentText(message.content) })),
			}) ?? script.steps[toolResults.length];
			if (!step) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						error: { message: `mock script exhausted at step ${toolResults.length} (${script.steps.length} steps)` },
					}),
				);
				return;
			}
			const respond = (): void => {
			if (step.httpError) {
				res.writeHead(step.httpError.status, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: step.httpError.message } }));
				return;
			}
			if (body.stream === false) {
				// Judges and Python command agents use plain JSON completions.
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						id: "chatcmpl-mock",
						object: "chat.completion",
						created: Math.floor(Date.now() / 1000),
						model,
						choices: [{ index: 0, message: {
							role: "assistant", content: step.text ?? "",
							...(step.toolCall ? { tool_calls: [{
								id: step.toolCall.id ?? `call_${requestCount}`,
								type: "function",
								function: { name: step.toolCall.name, arguments: JSON.stringify(step.toolCall.arguments) },
							}] } : {}),
						}, finish_reason: step.toolCall ? "tool_calls" : "stop" }],
						usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
					}),
				);
				return;
			}
			res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				});
				res.end(stepToSse(model, step));
			};
			// Latency is scriptable so concurrency tests can overlap a slow task
			// with fast ones without depending on real model timing.
			if (step.delayMs && step.delayMs > 0) setTimeout(respond, step.delayMs);
			else respond();
		});
	});

	return new Promise((resolvePromise) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") throw new Error("no port");
			resolvePromise({
				server,
				url: `http://127.0.0.1:${address.port}/v1`,
				port: address.port,
				requests: () => requestCount,
				close: () => new Promise<void>((done) => server.close(() => done())),
			});
		});
	});
}
