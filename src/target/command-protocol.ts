import { z } from "zod";

/**
 * The wire between AHDE and a Target that is not Pi.
 *
 * One versioned JSON-lines protocol, UTF-8, one message per line, every
 * message carrying its selected `v: 1` or `v: 2`. Each session selects one and is
 * strict on purpose (invariant 43): a second dialect, or a message a newer
 * agent invented, is a protocol error — never a behavioural failure and never
 * something the host quietly tolerates, because evidence produced by an agent
 * AHDE did not fully understand is not evidence.
 *
 * Nothing here executes. The schemas are the whole contract; the session in
 * `session-command.ts` is what enforces the bounds around them.
 */

/** Latest wire contract for new adapters; existing descriptors default to v1. */
export const COMMAND_PROTOCOL_VERSION = 2;
/** Existing descriptors and callers keep v1 until explicitly migrated. */
export const LEGACY_COMMAND_PROTOCOL_VERSION = 1;
export const CommandProtocolVersionSchema = z.union([z.literal(1), z.literal(2)]);
export type CommandProtocolVersion = z.infer<typeof CommandProtocolVersionSchema>;

/** Largest single protocol line, in bytes, in either direction. */
export const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;

/** Tool calls one turn may make before the host stops believing the agent. */
export const MAX_TOOL_CALLS_PER_TURN = 64;

/** Bounded stderr kept for the one place it may surface: an error message. */
export const MAX_CAPTURED_STDERR_BYTES = 8 * 1024;

/** How long a `cancel` is given to be polite before the process group is killed. */
export const CANCEL_GRACE_MS = 2_000;

const Version = CommandProtocolVersionSchema;
const Identifier = z.string().min(1).max(200);

// ---------------------------------------------------------------------------
// Host → agent

/**
 * The one-time handshake: who the agent is talking to, what it may call, and
 * where its world lives. `model.apiKeyEnv` is a NAME — the value is in the
 * child's environment under exactly that name and never on the wire, which is
 * the same rule invariant 18 applies to the Builder.
 */
export const HelloToolSchema = z.strictObject({
	name: Identifier,
	description: z.string(),
	parameters: z.record(z.string(), z.unknown()),
});
export type HelloTool = z.infer<typeof HelloToolSchema>;

export const HelloMessageSchema = z.strictObject({
	v: Version,
	type: z.literal("hello"),
	tools: z.array(HelloToolSchema),
	model: z.strictObject({
		provider: z.string().min(1),
		id: z.string().min(1),
		baseUrl: z.string().min(1),
		apiKeyEnv: z.string().min(1),
	}),
	/** Absolute path of the run's workspace copy; also the child's cwd. */
	workspace: z.string().min(1),
	/** Absolute path of this case's world state file, or null when it has none. */
	world: z.string().min(1).nullable(),
});
export type HelloMessage = z.infer<typeof HelloMessageSchema>;

export const UserMessageSchema = z.strictObject({
	v: Version,
	type: z.literal("user"),
	turn: z.number().int().positive(),
	text: z.string(),
	/** Set only on the one extra ask an empty final answer earns. */
	recovery: z.literal(true).optional(),
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

export const ToolResultMessageSchema = z.strictObject({
	v: Version,
	type: z.literal("tool_result"),
	id: Identifier,
	name: Identifier,
	text: z.string(),
	isError: z.boolean(),
});
export type ToolResultMessage = z.infer<typeof ToolResultMessageSchema>;

export const CancelMessageSchema = z.strictObject({
	v: Version,
	type: z.literal("cancel"),
});
export type CancelMessage = z.infer<typeof CancelMessageSchema>;

export const HostMessageSchema = z.discriminatedUnion("type", [
	HelloMessageSchema,
	UserMessageSchema,
	ToolResultMessageSchema,
	CancelMessageSchema,
]);
export type HostMessage = z.infer<typeof HostMessageSchema>;

// ---------------------------------------------------------------------------
// Agent → host

/** The turn's answer. Receiving one ends the turn. */
export const AssistantMessageSchema = z.strictObject({
	v: Version,
	type: z.literal("assistant"),
	turn: z.number().int().positive(),
	text: z.string(),
	thinking: z.string().optional(),
});
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

/**
 * A call the HOST runs. The name must be one the `hello` declared; anything
 * else is answered with an error result AND ends the run, because a Target
 * reaching for a capability nobody granted it is infrastructure, not a wrong
 * answer (this mirrors the Pi guard in `runtime.ts`).
 */
export const ToolCallMessageSchema = z.strictObject({
	v: Version,
	type: z.literal("tool_call"),
	id: Identifier,
	name: Identifier,
	arguments: z.record(z.string(), z.unknown()),
});
export type ToolCallMessage = z.infer<typeof ToolCallMessageSchema>;

/**
 * A call the agent already made on its own. The host did NOT run it, never
 * sandboxes it and never counts it against `execution.tools` — it is recorded
 * in the trace as an explicitly agent-reported toolCall/toolResult pair. It
 * cannot satisfy `tool_called`: that check requires host-observed execution.
 */
export const ToolNoteMessageSchema = z.strictObject({
	v: Version,
	type: z.literal("tool_note"),
	name: Identifier,
	arguments: z.record(z.string(), z.unknown()),
	result: z.string(),
});
export type ToolNoteMessage = z.infer<typeof ToolNoteMessageSchema>;

/**
 * v1: tokens replace the session snapshot; costUsd is an incremental charge.
 * v2: tokens and costUsd are increments for ONE model request. Send before the
 * turn's assistant frame; an omitted v2 cost makes the session total unknown.
 */
export const UsageMessageSchema = z.strictObject({
	v: Version,
	type: z.literal("usage"),
	turn: z.number().int().positive(),
	tokens: z.strictObject({
		input: z.number().nonnegative(),
		output: z.number().nonnegative(),
		cacheRead: z.number().nonnegative(),
		cacheWrite: z.number().nonnegative(),
		total: z.number().nonnegative(),
	}),
	costUsd: z.number().nonnegative().optional(),
});
export type UsageMessage = z.infer<typeof UsageMessageSchema>;

export const ErrorMessageSchema = z.strictObject({
	v: Version,
	type: z.literal("error"),
	message: z.string().min(1).max(4_000),
});
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

export const AgentMessageSchema = z.discriminatedUnion("type", [
	AssistantMessageSchema,
	ToolCallMessageSchema,
	ToolNoteMessageSchema,
	UsageMessageSchema,
	ErrorMessageSchema,
]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

/**
 * A violation of the wire itself: unparseable JSON, a version different from the selected session, a
 * type nobody declared, a line over the byte bound. It carries the line number
 * and NEVER the line body — a malformed line is attacker- or model-controlled
 * text, and an error message is one of the few places it could reach a human
 * terminal unredacted.
 */
export class CommandProtocolError extends Error {
	readonly line: number;

	constructor(line: number) {
		super(`command Target protocol violation at line ${line}`);
		this.name = "CommandProtocolError";
		this.line = line;
	}
}

/**
 * Parse one agent line. `line` is the 1-based ordinal of this line in the
 * child's stdout, used only to say where the violation was.
 */
export function parseAgentLine(raw: string, line: number, expectedVersion: CommandProtocolVersion = LEGACY_COMMAND_PROTOCOL_VERSION): AgentMessage {
	if (Buffer.byteLength(raw, "utf8") > MAX_PROTOCOL_LINE_BYTES) throw new CommandProtocolError(line);
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
	} catch {
		throw new CommandProtocolError(line);
	}
	const parsed = AgentMessageSchema.safeParse(value);
	if (!parsed.success || parsed.data.v !== expectedVersion) throw new CommandProtocolError(line);
	return parsed.data;
}

/** Streaming UTF-8 framing: chunk boundaries are not character or line boundaries. */
export class AgentMessageDecoder {
	private readonly decoder = new TextDecoder("utf-8", { fatal: true });
	private buffer = "";
	private lines = 0;

	constructor(private readonly version: CommandProtocolVersion = LEGACY_COMMAND_PROTOCOL_VERSION) {}

	push(chunk: Uint8Array): AgentMessage[] {
		try {
			this.buffer += this.decoder.decode(chunk, { stream: true });
		} catch {
			throw new CommandProtocolError(this.lines + 1);
		}
		const messages: AgentMessage[] = [];
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const raw = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			this.lines += 1;
			if (Buffer.byteLength(raw, "utf8") > MAX_PROTOCOL_LINE_BYTES) throw new CommandProtocolError(this.lines);
			if (raw.trim()) messages.push(parseAgentLine(raw, this.lines, this.version));
			newline = this.buffer.indexOf("\n");
		}
		if (Buffer.byteLength(this.buffer, "utf8") > MAX_PROTOCOL_LINE_BYTES) throw new CommandProtocolError(this.lines + 1);
		return messages;
	}

	finish(): void {
		try {
			this.buffer += this.decoder.decode();
		} catch {
			throw new CommandProtocolError(this.lines + 1);
		}
		if (this.buffer.trim()) throw new CommandProtocolError(this.lines + 1);
	}
}

/** Encode one host message as the exact bytes written to the child's stdin. */
export function encodeHostMessage(message: HostMessage): string {
	const encoded = `${JSON.stringify(HostMessageSchema.parse(message))}\n`;
	if (Buffer.byteLength(encoded, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
		throw new Error(`command Target host message exceeds ${MAX_PROTOCOL_LINE_BYTES} bytes`);
	}
	return encoded;
}
