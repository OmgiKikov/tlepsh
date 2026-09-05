import { t, type MessageKey } from "../i18n.js";
import { redactTraceText } from "../trace.js";

/**
 * Why a run that never reached grading ended.
 *
 * Its own module because two readers need it and neither may own it: the
 * Improvement Brief groups infrastructure failures by this class, and the run
 * explanation says the sentence. Keeping the table here is what stops the
 * brief and the screen from disagreeing about the same recorded stem.
 */

/** Characters of a raw error stem quoted beside the sentence. */
const MAX_STEM_CHARS = 300;

function quote(value: string, maxChars = MAX_STEM_CHARS): string {
	const redacted = redactTraceText(value).replace(/\s+/gu, " ").trim();
	return redacted.length <= maxChars ? redacted : `${redacted.slice(0, maxChars - 1)}…`;
}

/**
 * The typed cause of a run that never reached grading.
 *
 * Session 7 read a 300-second model timeout off the SHAPE of the trace that
 * survived it — the last thing in the file was a tool call, so every surface
 * announced `called get_account · no reply` while the same screen showed that
 * tool answering in 930 ms. The tool answered; the MODEL never did. A trace
 * ends where the run ended, so its last record says when the run stopped and
 * never says why.
 *
 * `record.error` says why, in stems this host itself writes. So for a run with
 * `status: "error"` every explanation surface reads THIS, and the trace is
 * evidence about what happened before the end, never about the end itself
 * (invariant 9: infrastructure is inconclusive evidence, and inventing a
 * behavioural cause for it is the exact mistake the invariant forbids).
 */
export type RunErrorClass = "timeout" | "exit" | "protocol" | "startup" | "evaluation" | "other";

/**
 * The exact stems this repository writes, newest-specific first. Nothing here
 * is a guess about a message some other layer might produce: an error whose
 * stem is not on this list is `other`, and its raw text is shown verbatim.
 */
const RUN_ERROR_STEMS: readonly { code: RunErrorClass; pattern: RegExp }[] = [
	{ code: "timeout", pattern: /^run timed out after (\d+)\s*ms\b/u },
	{ code: "exit", pattern: /^command Target exited with\b/u },
	{ code: "startup", pattern: /^command Target exited before its first protocol message\b/u },
	{ code: "protocol", pattern: /^command Target protocol violation\b/u },
	{ code: "startup", pattern: /^command Target did not start\b/u },
	{ code: "evaluation", pattern: /^evaluation infrastructure\b/u },
	// A key the endpoint requires and this process never had. The run stopped
	// before the model was asked anything at all, which is what `other` says —
	// and the raw stem beside it names the variable exactly.
	{ code: "other", pattern: /^missing \S+ for OpenRouter\b/u },
];

const RUN_ERROR_SENTENCE: Record<RunErrorClass, MessageKey> = {
	timeout: "run.error.timeout",
	exit: "run.error.exit",
	protocol: "run.error.protocol",
	startup: "run.error.startup",
	evaluation: "run.error.evaluation",
	other: "run.error.other",
};

const RUN_ERROR_CAUSE: Record<RunErrorClass, MessageKey> = {
	timeout: "run.cause.timeout",
	exit: "run.cause.exit",
	protocol: "run.cause.protocol",
	startup: "run.cause.startup",
	evaluation: "run.cause.evaluation",
	other: "run.cause.other",
};

/** The typed class of one recorded error stem; `other` for anything unlisted. */
export function classifyRunError(error: string | null | undefined): RunErrorClass {
	const stem = (error ?? "").trim();
	for (const entry of RUN_ERROR_STEMS) {
		if (entry.pattern.test(stem)) return entry.code;
	}
	return "other";
}

/** The short noun phrase for one class: `таймаут модели`. Never a sentence. */
export function runErrorCause(code: RunErrorClass): string {
	return t(RUN_ERROR_CAUSE[code]);
}

/**
 * The class an infrastructure failure mode carries on its signature `subject`,
 * or null when the mode predates the typed grouping. Validated rather than
 * cast: the subject is a persisted string, and an unknown token is treated as
 * "no class recorded" rather than rendered as a missing message key.
 */
export function infrastructureClassOf(subject: string | null | undefined): RunErrorClass | null {
	return typeof subject === "string" && subject in RUN_ERROR_CAUSE ? (subject as RunErrorClass) : null;
}

export interface RunErrorReading {
	code: RunErrorClass;
	/** The host's sentence about it, in the operator's language. */
	sentence: string;
	/** The recorded stem, quoted; a surface shows it muted after the sentence. */
	detail: string;
}

/**
 * What a run's recorded error says, in the operator's language, with the raw
 * stem kept beside it. `null` for a run that recorded no error, so a caller
 * cannot accidentally narrate a completed run as a failed one.
 */
export function runErrorReading(error: string | null | undefined): RunErrorReading | null {
	const stem = (error ?? "").trim();
	if (!stem) return null;
	const code = classifyRunError(stem);
	const timeout = /^run timed out after (\d+)\s*ms\b/u.exec(stem);
	const seconds = timeout ? Math.max(1, Math.round(Number(timeout[1]) / 1_000)) : 0;
	return {
		code,
		sentence: code === "timeout" ? t("run.error.timeout", { seconds }) : t(RUN_ERROR_SENTENCE[code]),
		detail: quote(stem),
	};
}
