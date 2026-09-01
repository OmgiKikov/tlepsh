import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TargetManifest } from "./manifest.js";
import { writeTextArtifact } from "./storage/artifacts.js";

/**
 * The one way AHDE calls a model that is part of the measurement rather than
 * the thing being measured: the judge that grades an answer, and the simulated
 * user that plays the human. Both are OpenAI-compatible chat completions, both
 * keep a sidecar of the exact exchange before anything is parsed, both retry
 * transport weather and nothing else, and both are billed against the manifest's
 * declared rates. One implementation so the two cannot drift apart.
 *
 * The Target's own model does NOT come through here: it runs inside a real Pi
 * session with tools, tracing and a workspace.
 */

/** An evaluator endpoint is a network dependency, not an oracle: three tries. */
export const EVALUATOR_MAX_ATTEMPTS = 3;
/** Backoff before attempt 2 and 3. Jittered so concurrent calls do not resonate. */
export const EVALUATOR_RETRY_DELAYS_MS = [1_000, 4_000] as const;

/**
 * Rate limits, gateway hiccups and dropped connections are transport weather.
 * A 4xx that is not 429 is a contract error and a response that will not parse
 * is a model error: retrying either only burns tokens and hides the cause.
 */
export function retryableEvaluatorStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

export function evaluatorRetryDelayMs(attempt: number): number {
	const base = EVALUATOR_RETRY_DELAYS_MS[attempt - 1] ??
		EVALUATOR_RETRY_DELAYS_MS[EVALUATOR_RETRY_DELAYS_MS.length - 1] ?? 1_000;
	return Math.round(base * (0.75 + Math.random() * 0.5));
}

/** Sleep that yields to host cancellation instead of sitting on it for 4 seconds. */
export function evaluatorBackoff(
	attempt: number,
	abortMessage: string,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const abort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error(abortMessage));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, evaluatorRetryDelayMs(attempt));
		if (signal?.aborted) {
			abort();
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });
	});
}

export interface EvaluatorUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

function nonNegativeInteger(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** OpenAI-compatible `usage`. Absent or unusable usage is reported as no usage. */
export function parseEvaluatorUsage(body: unknown): EvaluatorUsage | null {
	if (typeof body !== "object" || body === null) return null;
	const usage = (body as { usage?: unknown }).usage;
	if (typeof usage !== "object" || usage === null) return null;
	const fields = usage as Record<string, unknown>;
	const promptTokens = nonNegativeInteger(fields.prompt_tokens);
	const completionTokens = nonNegativeInteger(fields.completion_tokens);
	const reportedTotal = nonNegativeInteger(fields.total_tokens);
	const totalTokens = reportedTotal > 0 ? reportedTotal : promptTokens + completionTokens;
	if (totalTokens === 0) return null;
	return { promptTokens, completionTokens, totalTokens };
}

/** Cost from the manifest's declared rates (USD per 1M tokens, Pi's convention). */
export function evaluatorCostUsd(
	cost: TargetManifest["model"]["spec"]["cost"],
	usage: EvaluatorUsage,
): number {
	let rates: { input: number; output: number } = cost;
	let matchedThreshold = -1;
	for (const tier of cost.tiers ?? []) {
		if (usage.promptTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}
	return (rates.input * usage.promptTokens + rates.output * usage.completionTokens) / 1_000_000;
}

/**
 * Judge spend for a terminal line: two decimals, because that is how money is
 * read — except where two decimals would round a real bill down to `$0.00` and
 * say "free" about something that was not. Callers print this only when the
 * amount is above zero.
 */
export function formatEvaluatorSpend(costUsd: number): string {
	if (costUsd > 0 && costUsd < 0.005) return "<$0.01";
	return `$${costUsd.toFixed(2)}`;
}

export function evaluatorContentToString(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				typeof part === "object" && part !== null && "text" in part
					? String((part as { text: unknown }).text)
					: "")
			.join("");
	}
	return "";
}

/** Evidence first: the exact exchange is on disk before anything is parsed. */
export function writeEvaluatorAttemptEvidence(
	dir: string,
	stem: string,
	attempt: number,
	terminal: boolean,
	exchange: unknown,
): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const name = terminal ? `${stem}.json` : `${stem}.${attempt}.json`;
	writeTextArtifact(join(dir, name), `${JSON.stringify(exchange, null, "\t")}\n`, { mode: 0o600 });
}

export interface EvaluatorModelMetrics {
	/** HTTP attempts, retries included — the number the provider bills against. */
	calls: number;
	tokens: number;
	costUsd: number;
}

/**
 * A failed evaluator call still spent what it spent. The metrics travel with the
 * error so a caller can bill three exhausted retries honestly instead of
 * recording a run that failed at the endpoint as a run that cost nothing.
 */
export class EvaluatorModelError extends Error {
	readonly metrics: EvaluatorModelMetrics;

	constructor(message: string, metrics: EvaluatorModelMetrics) {
		super(message);
		this.name = "EvaluatorModelError";
		this.metrics = metrics;
	}
}

type EvaluatorAttempt =
	| { kind: "transport"; message: string }
	| { kind: "http"; status: number; ok: boolean; text: string };

export interface CallEvaluatorModelOptions {
	/** Names the instrument in every error message: "judge", "simulated user". */
	label: string;
	model: TargetManifest["model"];
	system: string;
	user: string;
	/** Where the exact exchange lands, and under what name. */
	sidecar: { dir: string; stem: string };
	/**
	 * Pin temperature 0 after the params spread. False only where sampling is
	 * the point (a jury of judges measures nothing if every juror is greedy).
	 */
	pinTemperature: boolean;
	/** What a host cancellation is called in this caller's vocabulary. */
	abortMessage: string;
	signal?: AbortSignal;
}

/**
 * One evaluator call, with retries, a sidecar per attempt, and usage accounting.
 * Returns the raw completion text: parsing is the caller's contract, and a
 * parse failure is deliberately never retried — the transport worked and a
 * second identical request at temperature 0 has nothing new to say.
 */
export async function callEvaluatorModel(
	options: CallEvaluatorModelOptions,
): Promise<{ text: string; metrics: EvaluatorModelMetrics }> {
	const { label, model, sidecar, signal } = options;
	const key = process.env[model.apiKeyEnv];
	if (model.baseUrl.includes("openrouter.ai") && !key) {
		throw new Error(`missing ${model.apiKeyEnv} for ${label} endpoint ${model.baseUrl}`);
	}
	const url = `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const requestBody = {
		model: model.id,
		messages: [
			{ role: "system", content: options.system },
			{ role: "user", content: options.user },
		],
		stream: false,
		...model.params,
		...(model.thinkingLevel !== "off" ? { reasoning: { effort: model.thinkingLevel } } : {}),
		// After the spread on purpose: manifest.ts rejects a params temperature on
		// both evaluator blocks, and this makes overriding it structurally
		// impossible even for evidence written by older code.
		...(options.pinTemperature ? { temperature: 0 } : {}),
	};
	let calls = 0;
	let tokens = 0;
	let costUsd = 0;

	for (let attempt = 1; ; attempt += 1) {
		if (signal?.aborted) throw signal.reason ?? new Error(options.abortMessage);
		calls += 1;
		let outcome: EvaluatorAttempt;
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
				body: JSON.stringify(requestBody),
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(model.timeoutMs)])
					: AbortSignal.timeout(model.timeoutMs),
			});
			outcome = { kind: "http", status: response.status, ok: response.ok, text: await response.text() };
		} catch (error) {
			outcome = { kind: "transport", message: error instanceof Error ? error.message : String(error) };
		}
		// Host cancellation is a decision, never weather: it is never retried.
		const retry = signal?.aborted !== true &&
			attempt < EVALUATOR_MAX_ATTEMPTS &&
			(outcome.kind === "transport" || retryableEvaluatorStatus(outcome.status));
		writeEvaluatorAttemptEvidence(sidecar.dir, sidecar.stem, attempt, !retry, {
			request: { url, body: requestBody },
			response: outcome.kind === "http" ? { status: outcome.status, text: outcome.text } : null,
			...(outcome.kind === "transport" ? { error: outcome.message } : {}),
		});

		if (outcome.kind === "transport") {
			if (!retry) {
				throw new EvaluatorModelError(`${label} request failed: ${outcome.message}`, { calls, tokens, costUsd });
			}
			await evaluatorBackoff(attempt, options.abortMessage, signal);
			continue;
		}
		if (!outcome.ok) {
			if (!retry) {
				throw new EvaluatorModelError(
					`${label} HTTP ${outcome.status}: ${outcome.text.slice(0, 120)}`,
					{ calls, tokens, costUsd },
				);
			}
			await evaluatorBackoff(attempt, options.abortMessage, signal);
			continue;
		}

		let body: { choices?: { message?: { content?: unknown } }[] };
		try {
			body = JSON.parse(outcome.text) as { choices?: { message?: { content?: unknown } }[] };
		} catch {
			throw new EvaluatorModelError(
				`${label} returned an unparseable response body: ${outcome.text.slice(0, 120)}`,
				{ calls, tokens, costUsd },
			);
		}
		const usage = parseEvaluatorUsage(body);
		if (usage) {
			tokens += usage.totalTokens;
			costUsd += evaluatorCostUsd(model.spec.cost, usage);
		}
		return {
			text: evaluatorContentToString(body.choices?.[0]?.message?.content),
			metrics: { calls, tokens, costUsd },
		};
	}
}
