import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { TokenMetrics } from "../provenance.js";

/**
 * The one thing the runner needs a Target to be: something that takes a turn.
 *
 * Every backend AHDE can drive — in-process Pi today, a child process speaking
 * the command protocol next — implements exactly this. The runner's loop, the
 * simulated user, the metrics block and the error path are written against the
 * interface and never against a backend, so a new backend cannot quietly
 * change what a Run means.
 */

/**
 * What one agent turn produced. `recovered` is true when the backend had to
 * ask a second time for a final answer: the runner counts it into
 * `metrics.recoveryAttempts`, which is how an empty first reply stays visible
 * as evidence rather than being smoothed away.
 */
export interface TurnResult {
	text: string;
	recovered: boolean;
}

/**
 * The exact recovery prompt an empty final answer earns. It lives beside the
 * interface because every backend sends it — Pi as a second `prompt()`, a
 * command Target as one more `user` line marked `recovery` — and `eval.ts`
 * filters exactly this text out of a rendered transcript.
 */
export const FINAL_ANSWER_RECOVERY_PROMPT =
	"Сформируй итоговый ответ пользователю сейчас, используя уже полученные результаты инструментов. " +
	"Не вызывай инструменты. Выполни требования target harness к финальному ответу.";

/**
 * What the backend can honestly say it spent.
 *
 * `tokens` and `costUsd` are nullable because a command Target may not report
 * usage at all. An unreported spend is ABSENT, never zero — a zero would make
 * a run that measured nothing look like a run that cost nothing.
 */
export interface TargetSessionStats {
	sessionId: string | null;
	tokens: TokenMetrics | null;
	costUsd: number | null;
	toolCalls: number;
}

export interface TargetSession {
	/** Which backend produced this session. Recorded on the run's fingerprint. */
	readonly kind: "pi" | "command";
	/** Send one user message; resolve with the agent's final text for that turn. */
	takeTurn(prompt: string): Promise<TurnResult>;
	/**
	 * Observe the session. Pi emits its full event stream; a command session
	 * emits the subset it can actually witness — the tool calls it brokered.
	 */
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	stats(): TargetSessionStats;
	/** Leave `runs/<id>/session.jsonl` in place, mode 0600. */
	finalizeTrace(runDir: string): void;
	abort(): void;
	close(): Promise<void>;
}
