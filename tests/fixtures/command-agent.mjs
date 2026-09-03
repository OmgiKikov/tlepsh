#!/usr/bin/env node
/**
 * A deterministic command Target for the tests: it speaks protocol v1 and
 * nothing else, and every behaviour it can exhibit is selected by
 * `FAKE_AGENT_MODE` rather than by a model. No network, no randomness, no
 * clock — so a test that fails here failed because the host changed.
 */

const mode = process.env.FAKE_AGENT_MODE ?? "plain";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const say = (turn, text) => send({ v: 1, type: "assistant", turn, text });
const usage = (turn) =>
	send({ v: 1, type: "usage", turn, tokens: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, total: 18 }, costUsd: 0.25 });

let hello = null;
let buffer = "";
let seenTurns = 0;
let lastTurn = 1;

if (mode === "exit-before-hello") process.exit(7);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline >= 0) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		if (line.trim()) handle(JSON.parse(line));
	}
});

function handle(message) {
	if (message.type === "hello") {
		hello = message;
		if (mode === "exit-after-hello") process.exit(7);
		return;
	}
	if (message.type === "cancel") process.exit(0);
	if (message.type === "tool_result") return onToolResult(message);
	if (message.type === "user") return onUser(message);
}

function onUser(message) {
	seenTurns += 1;
	const turn = message.turn;
	lastTurn = turn;
	switch (mode) {
		case "plain":
			usage(turn);
			return say(turn, `Тариф «Домашний» стоит 500 рублей. Вопрос: ${message.text.slice(0, 24)}`);
		case "no-usage":
			return say(turn, "Ответ без отчёта о расходе.");
		case "multi":
			usage(turn);
			return say(turn, `Ход ${turn}: ${message.text.slice(0, 20)}`);
		case "world":
			return say(turn, `world=${process.env.AHDE_WORLD ?? "none"} hello=${hello?.world ?? "none"}`);
		case "protocol":
			return say(turn, `protocol=${process.env.AHDE_PROTOCOL ?? "none"} key=${process.env.MOCK_MODEL_KEY ?? "none"}`);
		case "tool":
			return send({ v: 1, type: "tool_call", id: `call-${turn}`, name: "check_dbo", arguments: { id: "42" } });
		case "note":
			send({ v: 1, type: "tool_note", name: "internal_lookup", arguments: { id: "42" }, result: "limits: none" });
			return say(turn, "Ограничений нет, договор 42 действующий.");
		case "undeclared":
			return send({ v: 1, type: "tool_call", id: `call-${turn}`, name: "definitely_not_declared", arguments: {} });
		case "invalid-json":
			return process.stdout.write("this is not json at all\n");
		case "unknown-type":
			return send({ v: 1, type: "sing", turn });
		case "bad-version":
			return send({ v: 2, type: "assistant", turn, text: "from the future" });
		case "agent-error":
			return send({ v: 1, type: "error", message: "внутренняя ошибка агента" });
		case "silent":
			return undefined;
		case "die-after-tool":
			return send({ v: 1, type: "tool_call", id: `call-${turn}`, name: "check_dbo", arguments: { id: "42" } });
		case "empty-then-recover":
			if (message.recovery) return say(turn, "Итог: договор 42 действующий.");
			return say(turn, "");
		case "empty-always":
			return say(turn, "");
		case "overflow":
			return process.stdout.write(`${"o".repeat(2 * 1024 * 1024)}\n`);
		case "too-many-tools":
			return send({ v: 1, type: "tool_call", id: `call-${turn}-${seenTurns}`, name: "check_dbo", arguments: { id: "42" } });
		default:
			return say(turn, `unknown mode ${mode}`);
	}
}

let brokered = 0;

function onToolResult(message) {
	if (mode === "die-after-tool") {
		process.stderr.write("agent gave up\n");
		return process.exit(3);
	}
	if (mode === "too-many-tools") {
		brokered += 1;
		return send({ v: 1, type: "tool_call", id: `call-${brokered}`, name: "check_dbo", arguments: { id: "42" } });
	}
	return say(lastTurn, `Инструмент ответил: ${message.text.slice(0, 60)} (isError=${message.isError})`);
}
