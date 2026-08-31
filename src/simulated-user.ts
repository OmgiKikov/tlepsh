import { join } from "node:path";
import type { SimulatedUserSpec, TargetManifest } from "./manifest.js";
import type { SimulatedUserMetrics } from "./provenance.js";
import { callEvaluatorModel, EvaluatorModelError } from "./evaluator-model.js";
import { renderDialogueTranscript, type TranscriptTurn } from "./trace.js";

/**
 * The second model in a Run: it plays the person the agent is talking to.
 *
 * What it can see: the case's `goal`, its optional `persona`, its optional
 * `stopWhen`, and the bounded, credential-redacted transcript of what the agent
 * actually said. That is the whole input.
 *
 * What it can NEVER see: the graders, the reference answer, the rubric, the
 * suite, the Target's instructions, skills, tools or workspace — anything that
 * would let it write the turn that makes a grader pass instead of the turn a
 * person would write. A user model that knows the answer is not a user.
 *
 * Its failures are infrastructure (invariant 9): a 500 from the user endpoint
 * says nothing about the agent, so it must never be recorded as a behavioural
 * failure.
 */

const SIMULATED_USER_SYSTEM =
	'Ты играешь роль пользователя, который обращается к службе поддержки. ' +
	'Ты НЕ ассистент и НЕ помогаешь собеседнику: у тебя есть своя цель, и ты её добиваешься. ' +
	'Пиши так, как пишут живые люди — коротко, по одной реплике за раз, без списков и заголовков. ' +
	'Никогда не раскрывай, что ты модель, и не рассуждай о правильности ответа. ' +
	'Ответь строго одной строкой JSON без markdown: ' +
	'{"done": true|false, "stopWhen": true|false, "message": "следующая реплика пользователя"}. ' +
	'done — ставь true, когда твоя цель достигнута или дальше разговаривать бессмысленно. ' +
	'stopWhen — ставь true только если выполнено названное условие завершения. ' +
	'Когда done или stopWhen равны true, message может быть пустым.';

/** Two structured flags the host defines; the model never invents its own. */
export interface SimulatedUserReply {
	done: boolean;
	stopWhen: boolean;
	message: string;
}

/** Why a simulated conversation ended. Recorded in `metrics.conversationStop`. */
export type SimulatedUserStop = "max-turns" | "sentinel" | "stop-when";

/** The next user turn is a person's sentence, not a document. */
export const MAX_SIMULATED_USER_MESSAGE_CHARS = 2_000;

export function simulatedUserPrompt(
	spec: SimulatedUserSpec,
	turns: readonly TranscriptTurn[],
	nextTurn: number,
	maxTurns: number,
): string {
	return [
		"<твоя цель>", spec.goal, "</твоя цель>",
		"",
		...(spec.persona ? ["<кто ты>", spec.persona, "</кто ты>", ""] : []),
		...(spec.stopWhen
			? [
				"<условие завершения>",
				spec.stopWhen,
				"</условие завершения>",
				'Как только это условие выполнено, верни "stopWhen": true.',
				"",
			]
			: []),
		"<диалог>",
		renderDialogueTranscript(turns),
		"</диалог>",
		"",
		`Это реплика ${nextTurn} из ${maxTurns}. Напиши следующую реплику пользователя.`,
	].join("\n");
}

function jsonObject(text: string, label: string): Record<string, unknown> {
	const stripped = text.replace(/```(?:json)?/g, "").trim();
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	const raw = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${label} returned an unparseable turn: ${text.slice(0, 120)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${label} returned an unparseable turn: ${text.slice(0, 120)}`);
	}
	return parsed as Record<string, unknown>;
}

/**
 * A missing flag is `false` — a user who did not say they were finished is not
 * finished — but a missing message when the user is still talking has nothing
 * to send, and inventing one would be inventing evidence.
 */
export function parseSimulatedUserReply(text: string): SimulatedUserReply {
	const body = jsonObject(text, "simulated user");
	const done = body.done === true;
	const stopWhen = body.stopWhen === true;
	const raw = typeof body.message === "string" ? body.message.trim() : "";
	const message = raw.length <= MAX_SIMULATED_USER_MESSAGE_CHARS
		? raw
		: `${raw.slice(0, MAX_SIMULATED_USER_MESSAGE_CHARS - 1)}…`;
	if (!done && !stopWhen && message.length === 0) {
		throw new Error(`simulated user returned no message and did not stop: ${text.slice(0, 120)}`);
	}
	return { done, stopWhen, message };
}

export interface NextSimulatedUserTurnOptions {
	spec: SimulatedUserSpec;
	model: TargetManifest["model"];
	/** Everything said so far, in order, exactly as the agent said it. */
	turns: readonly TranscriptTurn[];
	/** 1-based index of the agent turn this message will elicit. */
	nextTurn: number;
	/** Run directory; the exchange lands in `<runDir>/user/<nextTurn>.json`. */
	runDir: string;
	signal?: AbortSignal;
}

/**
 * Ask the user model for one more turn. Retries and backoff are the judge's,
 * because they are the same weather; the sidecar mirrors the judge's naming so
 * one reader finds both kinds of evaluator exchange.
 */
export async function nextSimulatedUserTurn(
	options: NextSimulatedUserTurnOptions,
): Promise<{ reply: SimulatedUserReply; metrics: SimulatedUserMetrics }> {
	const called = await callEvaluatorModel({
		label: "simulated user",
		model: options.model,
		system: SIMULATED_USER_SYSTEM,
		user: simulatedUserPrompt(options.spec, options.turns, options.nextTurn, options.spec.maxTurns),
		sidecar: { dir: join(options.runDir, "user"), stem: String(options.nextTurn) },
		// A user model that samples writes a different conversation every run,
		// which is noise the paired comparison then has to pay for.
		pinTemperature: true,
		abortMessage: "run aborted",
		...(options.signal ? { signal: options.signal } : {}),
	});
	try {
		return { reply: parseSimulatedUserReply(called.text), metrics: called.metrics };
	} catch (error) {
		// The call happened and was billed; only the answer was unusable.
		throw new EvaluatorModelError(error instanceof Error ? error.message : String(error), called.metrics);
	}
}

/**
 * Which stop condition ended the conversation, given one reply. `stopWhen` wins
 * over the plain sentinel because a declared condition is the more precise fact
 * about why this case ended, and a model that satisfies it usually sets both.
 */
export function simulatedUserStop(
	spec: SimulatedUserSpec,
	reply: SimulatedUserReply,
): SimulatedUserStop | null {
	if (spec.stopWhen && reply.stopWhen) return "stop-when";
	if (reply.done) return "sentinel";
	return null;
}
