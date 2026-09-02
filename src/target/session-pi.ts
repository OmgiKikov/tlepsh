import { chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { createTargetAgentSession, type CreateTargetAgentSessionOptions } from "./runtime.js";
import {
	FINAL_ANSWER_RECOVERY_PROMPT,
	type TargetSession,
	type TargetSessionStats,
	type TurnResult,
} from "./session.js";

/**
 * The in-process Pi backend behind the `TargetSession` interface. Every line
 * of `takeTurn` is the closure the runner used to own, moved without a change
 * in behaviour: the same per-turn watchdog, the same one recovery attempt, the
 * same stop-reason and empty-text refusals.
 */

export interface CreatePiTargetSessionOptions extends CreateTargetAgentSessionOptions {
	/** Bounds ONE reply, not a whole conversation. From `model.timeoutMs`. */
	timeoutMs: number;
	/** Host-owned cancellation for the entire parent decision. */
	signal?: AbortSignal;
	/**
	 * Called the moment a recovery attempt is decided, before it is sent. The
	 * runner counts recoveries here rather than from the returned `TurnResult`
	 * so an attempt that then fails is still recorded on the error path.
	 */
	onRecoveryAttempt?: () => void;
}

class PiTargetSession implements TargetSession {
	readonly kind = "pi" as const;

	constructor(
		private readonly session: AgentSession,
		private readonly sessionManager: SessionManager,
		private readonly options: CreatePiTargetSessionOptions,
	) {}

	/**
	 * One agent turn: send a user message and return what the agent said back.
	 * Each turn gets its own watchdog — `model.timeoutMs` bounds a reply, not a
	 * whole conversation — and its own recovery attempt, because an empty reply
	 * mid-dialogue is exactly as useless to the simulated user as a final one is
	 * to a grader.
	 */
	async takeTurn(prompt: string): Promise<TurnResult> {
		const active = this.session;
		if (!active) throw new Error("agent session is unavailable");
		const { signal, timeoutMs } = this.options;
		let recovered = false;
		// Watchdog: prompt() has no deadline of its own.
		let timedOut = false;
		const watchdog = setTimeout(() => {
			timedOut = true;
			void active.abort();
		}, timeoutMs);

		let finalAssistant;
		try {
			await active.prompt(prompt);
			if (signal?.aborted) throw signal.reason ?? new Error("run aborted");
			if (timedOut) throw new Error(`run timed out after ${timeoutMs}ms`);

			finalAssistant = [...active.messages].reverse().find((message) => message.role === "assistant");
			const hasToolResults = active.messages.some((message) => message.role === "toolResult");
			if (finalAssistant?.stopReason === "stop" && !active.getLastAssistantText()?.trim() && hasToolResults) {
				recovered = true;
				this.options.onRecoveryAttempt?.();
				const activeTools = active.agent.state.tools;
				active.agent.state.tools = [];
				try {
					await active.prompt(FINAL_ANSWER_RECOVERY_PROMPT);
				} finally {
					active.agent.state.tools = activeTools;
				}
				if (signal?.aborted) throw signal.reason ?? new Error("run aborted");
				if (timedOut) throw new Error(`run timed out after ${timeoutMs}ms`);
				finalAssistant = [...active.messages].reverse().find((message) => message.role === "assistant");
			}
		} finally {
			clearTimeout(watchdog);
		}

		if (!finalAssistant) throw new Error("agent run completed without an assistant message");
		if (finalAssistant.stopReason !== "stop") {
			throw new Error(
				finalAssistant.errorMessage ?? `agent run ended with unexpected stop reason: ${finalAssistant.stopReason}`,
			);
		}
		// The answer must be text in the final assistant message. Reusing text
		// from an earlier pre-tool turn would turn an incomplete run into false
		// evidence.
		const turnText = finalAssistant.content
			.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map((content) => content.text)
			.join("");
		if (!turnText) throw new Error("agent run produced no assistant text");
		return { text: turnText, recovered };
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		return this.session.subscribe(listener);
	}

	stats(): TargetSessionStats {
		const stats = this.session.getSessionStats();
		return {
			sessionId: stats.sessionId,
			tokens: {
				input: stats.tokens.input,
				output: stats.tokens.output,
				cacheRead: stats.tokens.cacheRead,
				cacheWrite: stats.tokens.cacheWrite,
				total: stats.tokens.total,
			},
			costUsd: stats.cost,
			toolCalls: stats.toolCalls,
		};
	}

	/** Pin the session file to its canonical name inside the run dir. */
	finalizeTrace(runDir: string): void {
		const sessionFile = this.sessionManager.getSessionFile();
		if (sessionFile) {
			renameSync(sessionFile, join(runDir, "session.jsonl"));
			chmodSync(join(runDir, "session.jsonl"), 0o600);
		}
	}

	abort(): void {
		void this.session.abort();
	}

	async close(): Promise<void> {
		this.session.dispose();
	}
}

export async function createPiTargetSession(
	options: CreatePiTargetSessionOptions,
): Promise<TargetSession> {
	const created = await createTargetAgentSession(options);
	return new PiTargetSession(created.session, created.sessionManager, options);
}
