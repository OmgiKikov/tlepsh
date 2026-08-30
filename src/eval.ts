import { chmodSync, mkdirSync, opendirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
	GraderSpec,
	graderName,
	graderNeedsExpected,
	hasReferenceAnswer,
	type ExactNormalize,
	type ResolvedTarget,
	type ResolvedTask,
	type SimilarityMetric,
	type TargetManifest,
} from "./manifest.js";
import {
	HashSchema,
	modelFingerprint,
	axisDifferences,
	canonicalJson,
	hashValue,
	provenanceAxes,
	provenanceKey,
	ProvenanceAxesSchema,
	RunRecordSchema,
	TargetRevisionSchema,
	type GraderResult,
	type GraderCheckCode,
	type JudgeMetrics,
	type RunRecord,
	type ProvenanceAxes,
	type ExecutionFingerprint,
} from "./provenance.js";
import {
	disposeTargetWorkspaceSnapshot,
	materializeTargetWorkspaceSnapshot,
	runTask,
} from "./runner.js";
import {
	emitRunGraded,
	type RunEventIdentity,
	type RunEventListener,
} from "./run-events.js";
import { readJsonArtifact, writeJsonArtifact, writeTextArtifact } from "./storage/artifacts.js";
import { resolveContainedArtifactPath } from "./storage/paths.js";
import { lastAssistantText, openTrace, redactTraceText, traceToolCalls } from "./trace.js";

/** Grader implementations over (task, record, trace). Declarative specs live in the target suite. */

function gradeToolCalled(
	spec: { tool: string; argsContains?: string },
	toolCalls: ReturnType<typeof traceToolCalls>,
): GraderResult {
	const matching = toolCalls.filter(
		(call) =>
			call.name === spec.tool &&
			(!spec.argsContains || JSON.stringify(call.arguments).includes(spec.argsContains)),
	);
	return {
		name: "",
		type: "tool_called",
		passed: matching.length > 0,
		score: matching.length > 0 ? 1 : 0,
		reason: matching.length > 0
			? `called ${spec.tool}${spec.argsContains ? ` (args contain "${spec.argsContains}")` : ""}`
			: `never called ${spec.tool}${spec.argsContains ? ` with args containing "${spec.argsContains}"` : ""}`,
	};
}

function gradeOutputContains(
	spec: { text: string; caseSensitive: boolean },
	output: string | undefined,
): GraderResult {
	const haystack = spec.caseSensitive ? (output ?? "") : (output ?? "").toLowerCase();
	const needle = spec.caseSensitive ? spec.text : spec.text.toLowerCase();
	const passed = haystack.includes(needle);
	return {
		name: "",
		type: "output_contains",
		passed,
		score: passed ? 1 : 0,
		reason: passed ? `output contains "${spec.text}"` : `output does not contain "${spec.text}"`,
	};
}

function gradeOutputMatches(spec: { pattern: string }, output: string | undefined): GraderResult {
	const regex = new RegExp(spec.pattern);
	const passed = output !== undefined && regex.test(output);
	return {
		name: "",
		type: "output_matches",
		passed,
		score: passed ? 1 : 0,
		reason: passed ? `output matches /${spec.pattern}/` : `output does not match /${spec.pattern}/`,
	};
}

// ---------- Reference-answer graders ----------
// `exact` and `similarity` decide locally: no judge model, no network, and the
// same verdict every time. All three reference graders (judge withReference
// included) refuse to grade a case that carries no reference answer — a
// vacuous pass would be evidence of nothing.

const MISSING_EXPECTED_REASON = "case has no expected answer";

function missingExpected(type: GraderSpec["type"]): GraderResult {
	return { name: "", type, passed: false, score: 0, reason: MISSING_EXPECTED_REASON };
}

/** `lower` is trim + lowercase + collapsed whitespace; `trim` only trims. */
export function normalizeAnswer(text: string, mode: ExactNormalize): string {
	if (mode === "none") return text;
	const trimmed = text.trim();
	if (mode === "trim") return trimmed;
	return trimmed.toLowerCase().replace(/\s+/gu, " ");
}

function gradeExact(
	spec: { normalize: ExactNormalize },
	expected: string | undefined,
	output: string,
): GraderResult {
	if (expected === undefined) return missingExpected("exact");
	const passed = normalizeAnswer(output, spec.normalize) === normalizeAnswer(expected, spec.normalize);
	return {
		name: "",
		type: "exact",
		passed,
		score: passed ? 1 : 0,
		reason: passed
			? `output equals the expected answer (normalize: ${spec.normalize})`
			: `output differs from the expected answer (normalize: ${spec.normalize})`,
	};
}

/** Unicode word tokens: runs of letters or digits, case-folded. */
export function answerTokens(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Multiset token F1, the standard span-answer overlap score. */
export function tokenF1(a: string, b: string): number {
	const left = answerTokens(a);
	const right = answerTokens(b);
	if (left.length === 0 && right.length === 0) return 1;
	if (left.length === 0 || right.length === 0) return 0;
	const remaining = new Map<string, number>();
	for (const token of left) remaining.set(token, (remaining.get(token) ?? 0) + 1);
	let overlap = 0;
	for (const token of right) {
		const available = remaining.get(token) ?? 0;
		if (available > 0) {
			remaining.set(token, available - 1);
			overlap += 1;
		}
	}
	if (overlap === 0) return 0;
	const precision = overlap / left.length;
	const recall = overlap / right.length;
	return (2 * precision * recall) / (precision + recall);
}

/** Levenshtein distance over unicode code points, one rolling row of cells. */
function levenshteinDistance(a: readonly string[], b: readonly string[]): number {
	let previous = new Int32Array(b.length + 1);
	let current = new Int32Array(b.length + 1);
	for (let column = 0; column <= b.length; column += 1) previous[column] = column;
	for (let row = 1; row <= a.length; row += 1) {
		current[0] = row;
		for (let column = 1; column <= b.length; column += 1) {
			const substitution = previous[column - 1]! + (a[row - 1] === b[column - 1] ? 0 : 1);
			current[column] = Math.min(previous[column]! + 1, current[column - 1]! + 1, substitution);
		}
		[previous, current] = [current, previous];
	}
	return previous[b.length]!;
}

/**
 * `1 − distance / maxLength`, over unicode code points.
 *
 * The distance is never smaller than the length difference, so a length-only
 * upper bound decides the common "the agent wrote an essay" case without
 * filling an O(n·m) matrix. `bounded` says the score is that upper bound: it is
 * only ever returned when the bound alone already fails the threshold.
 */
export function levenshteinRatio(
	a: string,
	b: string,
	threshold = 0,
): { score: number; bounded: boolean } {
	const left = [...a];
	const right = [...b];
	const maxLength = Math.max(left.length, right.length);
	if (maxLength === 0) return { score: 1, bounded: false };
	const upperBound = 1 - Math.abs(left.length - right.length) / maxLength;
	if (upperBound < threshold) return { score: upperBound, bounded: true };
	return { score: 1 - levenshteinDistance(left, right) / maxLength, bounded: false };
}

function gradeSimilarity(
	spec: { metric: SimilarityMetric; threshold: number },
	expected: string | undefined,
	output: string,
): GraderResult {
	if (expected === undefined) return missingExpected("similarity");
	// Both metrics compare the canonical `lower` normalization, so trailing
	// whitespace and casing never decide a fuzzy match.
	const candidate = normalizeAnswer(output, "lower");
	const reference = normalizeAnswer(expected, "lower");
	const { score, bounded } = spec.metric === "token-f1"
		? { score: tokenF1(candidate, reference), bounded: false }
		: levenshteinRatio(candidate, reference, spec.threshold);
	const passed = score >= spec.threshold;
	const rounded = Math.round(score * 1000) / 1000;
	return {
		name: "",
		type: "similarity",
		passed,
		score,
		reason: `${spec.metric} ${bounded ? "≤" : "="} ${rounded}${bounded ? " (length-difference bound)" : ""}, ` +
			`${passed ? "at or above" : "below"} threshold ${spec.threshold}`,
	};
}

// ---------- Judge grader ----------
// Judge calls leave one sidecar per attempt (exact request + raw response) in
// runs/<run_id>/judge/<graderIndex>.<attempt>.json — written BEFORE parsing, so
// even an unparseable verdict keeps its evidence. The terminal attempt keeps
// the historical runs/<run_id>/judge/<graderIndex>.json name, so every existing
// reader still finds the exchange that decided the grade.
// ponytail: sidecar file, not a judge-as-run through runner.ts; upgrade if
// judge verdicts ever need their own provenance.

const JUDGE_SYSTEM =
	'Ты — грейдер. Оцени ответ агента на обращение по критерию. ' +
	'Ответь строго одной строкой JSON без markdown: {"passed": true|false, "reason": "краткое обоснование"}';

/**
 * Assertion rubrics ask for one isolated yes/no per check, with "unknown" as an
 * explicit third answer: a judge forced to guess between yes and no invents a
 * verdict, and an invented verdict is exactly what a human label later has to
 * correct. Unknown counts as a failure, so guessing buys the answer nothing.
 */
const JUDGE_ASSERTIONS_SYSTEM =
	'Ты — грейдер. Проверь ответ агента по списку независимых утверждений. ' +
	'Отвечай по каждому утверждению отдельно: "yes" — утверждение выполнено, "no" — нарушено, ' +
	'"unknown" — ответа недостаточно, чтобы решить. Не догадывайся: "unknown" честнее выдумки. ' +
	'Ответь строго одной строкой JSON без markdown: ' +
	'{"verdicts": [{"index": 1, "answer": "yes"|"no"|"unknown", "evidence": "цитата или краткое обоснование"}]}';

/**
 * The rubric-only prompt is frozen on purpose. Rewording it would change
 * verdicts for datasets that already have evidence, which is exactly what
 * `AHDE_EVALUATOR_ID` exists to fence off. Reference judging is a new protocol
 * on a new grader spec, so it gets the delimited prompt below instead.
 */
const JUDGE_REFERENCE_SYSTEM =
	'Ты — грейдер. Сравни фактическое содержание ответа агента с эталонным ответом. ' +
	'Игнорируй различия в стиле, грамматике, пунктуации и форматировании. ' +
	'Ответь строго одной строкой JSON без markdown: {"choice": "A"|"B"|"C"|"D"|"E", "reason": "краткое обоснование"}';

/**
 * The A–E factuality rubric, ported from vitest-evals' `FactualityJudge`:
 * only an outright disagreement with the reference is a failure, because a
 * narrower, a broader and a differently worded answer are all still correct.
 */
const REFERENCE_CHOICE_SCORES = { A: 0.4, B: 0.6, C: 1, D: 0, E: 1 } as const;
type ReferenceChoice = keyof typeof REFERENCE_CHOICE_SCORES;
const REFERENCE_FAILING_CHOICE: ReferenceChoice = "D";

function isReferenceChoice(value: unknown): value is ReferenceChoice {
	// hasOwn, not `in`: an inherited key like "toString" is not a rubric choice.
	return typeof value === "string" && Object.hasOwn(REFERENCE_CHOICE_SCORES, value);
}

/** Reference and rubric each get their own delimited block, verbatim. */
function judgeReferencePrompt(rubric: string, input: string, expected: string, output: string): string {
	return [
		"<критерий>", rubric, "</критерий>",
		"",
		"<обращение>", input, "</обращение>",
		"",
		"<эталонный ответ>", expected, "</эталонный ответ>",
		"",
		"<ответ агента>", output, "</ответ агента>",
		"",
		"Выбери ровно один вариант:",
		"A: ответ агента — полностью согласованное подмножество эталона.",
		"B: ответ агента — полностью согласованное надмножество эталона.",
		"C: ответ агента содержит те же фактические сведения, что и эталон.",
		"D: ответ агента противоречит эталону.",
		"E: ответы отличаются только в деталях, не влияющих на фактическую сторону.",
		"",
		'Верни JSON ровно с этими полями: {"choice": "C", "reason": "краткое обоснование выбора"}',
	].join("\n");
}

/** Reference and rubric each get their own delimited block, verbatim. */
function judgeAssertionsPrompt(
	spec: { rubric?: string | undefined; assertions: readonly string[] },
	input: string,
	output: string,
): string {
	return [
		...(spec.rubric ? ["<критерий>", spec.rubric, "</критерий>", ""] : []),
		"<обращение>", input, "</обращение>",
		"",
		"<ответ агента>", output, "</ответ агента>",
		"",
		"<утверждения>",
		...spec.assertions.map((assertion, index) => `${index + 1}. ${assertion}`),
		"</утверждения>",
		"",
		`Оцени каждое утверждение независимо и верни ровно ${spec.assertions.length} verdict(s) в том же порядке:`,
		'{"verdicts": [{"index": 1, "answer": "yes"|"no"|"unknown", "evidence": "краткое обоснование"}]}',
	].join("\n");
}

function judgeJsonObject(text: string): Record<string, unknown> {
	const stripped = text.replace(/```(?:json)?/g, "").trim();
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	const raw = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`judge returned unparseable verdict: ${text.slice(0, 120)}`);
	}
	return parsed as Record<string, unknown>;
}

/** A missing or non-string reason is a judge quirk, not an infrastructure failure. */
function judgeReason(value: unknown): string {
	return typeof value === "string" && value.trim().length > 0 ? value : "judge gave no reason";
}

function parseVerdict(text: string): JudgeVerdict {
	const verdict = judgeJsonObject(text);
	if (typeof verdict.passed !== "boolean") {
		throw new Error(`judge verdict missing boolean passed: ${text.slice(0, 120)}`);
	}
	return {
		passed: verdict.passed,
		score: verdict.passed ? 1 : 0,
		reason: judgeReason(verdict.reason),
	};
}

/** Evidence is prose from a model: bounded and single-line before it is stored. */
const MAX_ASSERTION_EVIDENCE_CHARS = 200;

function assertionEvidence(value: unknown): string {
	const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
	return text.length > 0 ? text.slice(0, MAX_ASSERTION_EVIDENCE_CHARS) : "judge gave no evidence";
}

function assertionAnswer(value: unknown): AssertionAnswer | null {
	return value === "yes" || value === "no" || value === "unknown" ? value : null;
}

/**
 * One entry per declared assertion, in declaration order. An assertion the
 * judge skipped, duplicated, or answered with something else is `unknown`: an
 * unanswered check has not been passed, and saying so beats inventing a verdict.
 */
function parseAssertionVerdicts(text: string, total: number): AssertionVerdict[] {
	const body = judgeJsonObject(text);
	if (!Array.isArray(body.verdicts)) {
		throw new Error(`judge verdict missing a verdicts array: ${text.slice(0, 120)}`);
	}
	const byIndex = new Map<number, AssertionVerdict>();
	for (const entry of body.verdicts) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const index = record.index;
		const answer = assertionAnswer(record.answer);
		if (answer === null || typeof index !== "number" || !Number.isInteger(index)) continue;
		if (index < 1 || index > total || byIndex.has(index)) continue;
		byIndex.set(index, { index, answer, evidence: assertionEvidence(record.evidence) });
	}
	return Array.from({ length: total }, (_unused, offset) =>
		byIndex.get(offset + 1) ??
			{ index: offset + 1, answer: "unknown" as const, evidence: "judge returned no verdict for this assertion" });
}

function parseReferenceVerdict(text: string): JudgeVerdict {
	const verdict = judgeJsonObject(text);
	if (!isReferenceChoice(verdict.choice)) {
		throw new Error(`judge verdict missing an A–E choice: ${text.slice(0, 120)}`);
	}
	const choice = verdict.choice;
	return {
		passed: choice !== REFERENCE_FAILING_CHOICE,
		score: REFERENCE_CHOICE_SCORES[choice],
		// The choice leads the reason so the rubric branch is visible in run.json.
		reason: `${choice}: ${judgeReason(verdict.reason)}`,
		choice,
	};
}

function contentToString(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : ""))
			.join("");
	}
	return "";
}

/** A judge endpoint is a network dependency, not an oracle: give it three tries. */
const JUDGE_MAX_ATTEMPTS = 3;
/** Backoff before attempt 2 and 3. Jittered so concurrent judges do not resonate. */
const JUDGE_RETRY_DELAYS_MS = [1_000, 4_000] as const;

/**
 * Rate limits, gateway hiccups and dropped connections are transport weather.
 * A 4xx that is not 429 is a contract error and a verdict that will not parse
 * is a model error: retrying either only burns tokens and hides the cause.
 */
function retryableJudgeStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

function judgeRetryDelayMs(attempt: number): number {
	const base = JUDGE_RETRY_DELAYS_MS[attempt - 1] ?? JUDGE_RETRY_DELAYS_MS[JUDGE_RETRY_DELAYS_MS.length - 1] ?? 1_000;
	return Math.round(base * (0.75 + Math.random() * 0.5));
}

/** Sleep that yields to host cancellation instead of sitting on it for 4 seconds. */
function judgeBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const abort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("grading aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, judgeRetryDelayMs(attempt));
		if (signal?.aborted) {
			abort();
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });
	});
}

interface JudgeUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

function nonNegativeInteger(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** OpenAI-compatible `usage`. Absent or unusable usage is reported as no usage. */
function parseJudgeUsage(body: unknown): JudgeUsage | null {
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

/** Judge cost from the manifest's declared rates (USD per 1M tokens, Pi's convention). */
function judgeCostUsd(cost: TargetManifest["model"]["spec"]["cost"], usage: JudgeUsage): number {
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

interface JudgeSidecar {
	dir: string;
	graderIndex: number;
	/**
	 * 1-based juror, present only for a jury. A single judge keeps the historical
	 * `<graderIndex>[.<attempt>].json` names, so every existing reader still finds
	 * the exchange that decided the grade.
	 */
	juror?: number;
}

function judgeSidecarStem(sidecar: JudgeSidecar): string {
	return sidecar.juror === undefined
		? `${sidecar.graderIndex}`
		: `${sidecar.graderIndex}.${sidecar.juror}`;
}

/** Evidence first: the exact exchange is on disk before anything is parsed. */
function writeJudgeAttemptEvidence(
	sidecar: JudgeSidecar,
	attempt: number,
	terminal: boolean,
	exchange: unknown,
): void {
	mkdirSync(sidecar.dir, { recursive: true, mode: 0o700 });
	chmodSync(sidecar.dir, 0o700);
	const stem = judgeSidecarStem(sidecar);
	const name = terminal ? `${stem}.json` : `${stem}.${attempt}.json`;
	writeTextArtifact(join(sidecar.dir, name), `${JSON.stringify(exchange, null, "\t")}\n`, { mode: 0o600 });
}

type JudgeAttempt =
	| { kind: "transport"; message: string }
	| { kind: "http"; status: number; ok: boolean; text: string };

type AssertionAnswer = "yes" | "no" | "unknown";

interface AssertionVerdict {
	index: number;
	answer: AssertionAnswer;
	evidence: string;
}

interface JudgeVerdict {
	passed: boolean;
	score: number;
	reason: string;
	/** Present only for the A–E reference rubric. */
	choice?: ReferenceChoice;
	/** Present only for an assertion rubric, one entry per declared assertion. */
	assertions?: AssertionVerdict[];
}

/** One judge protocol: what is asked, and how the answer becomes a verdict. */
interface JudgeProtocol {
	system: string;
	user: string;
	parse: (text: string) => JudgeVerdict;
	/** Jurors whose majority decides. Absent or 1 is one judge call. */
	jury?: number;
}

/**
 * The decided choice, next to the raw exchange rather than inside it: the
 * exchange file stays exactly what went over the wire, written before anything
 * is parsed, and the verdict file says how it was read.
 */
function writeJudgeVerdictEvidence(
	sidecar: JudgeSidecar,
	verdict: JudgeVerdict,
	jury: JudgeVerdict[],
): void {
	writeTextArtifact(
		join(sidecar.dir, `${sidecar.graderIndex}.verdict.json`),
		`${JSON.stringify({
			choice: verdict.choice,
			passed: verdict.passed,
			score: verdict.score,
			...(verdict.assertions ? { assertions: verdict.assertions } : {}),
			...(jury.length > 1
				? {
					jury: jury.map((juror, offset) => ({
						juror: offset + 1,
						passed: juror.passed,
						...(juror.choice ? { choice: juror.choice } : {}),
						...(juror.assertions
							? { answers: juror.assertions.map((assertion) => assertion.answer) }
							: {}),
					})),
				}
				: {}),
		}, null, "\t")}\n`,
		{ mode: 0o600 },
	);
}

async function judgeOnce(
	protocol: JudgeProtocol,
	judge: TargetManifest["model"],
	sidecar: JudgeSidecar,
	signal?: AbortSignal,
): Promise<{ verdict: JudgeVerdict; metrics: JudgeMetrics }> {
	const key = process.env[judge.apiKeyEnv];
	if (judge.baseUrl.includes("openrouter.ai") && !key) {
		throw new Error(`missing ${judge.apiKeyEnv} for judge endpoint ${judge.baseUrl}`);
	}
	const url = `${judge.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const requestBody = {
		model: judge.id,
		messages: [
			{ role: "system", content: protocol.system },
			{ role: "user", content: protocol.user },
		],
		stream: false,
		...judge.params,
		...(judge.thinkingLevel !== "off" ? { reasoning: { effort: judge.thinkingLevel } } : {}),
		// After the spread on purpose: a grader that samples is not a grader.
		// manifest.ts rejects a judge params temperature; this makes overriding
		// it structurally impossible even for evidence written by older code.
		//
		// A jury is the one exception, and it is the same argument from the other
		// side: three identical greedy calls measure nothing, so a jury leaves the
		// endpoint at its own default temperature and lets the disagreement show.
		...(sidecar.juror === undefined ? { temperature: 0 } : {}),
	};
	let calls = 0;
	let tokens = 0;
	let costUsd = 0;

	for (let attempt = 1; ; attempt += 1) {
		if (signal?.aborted) throw signal.reason ?? new Error("grading aborted");
		calls += 1;
		let outcome: JudgeAttempt;
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
				body: JSON.stringify(requestBody),
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(judge.timeoutMs)])
					: AbortSignal.timeout(judge.timeoutMs),
			});
			outcome = { kind: "http", status: response.status, ok: response.ok, text: await response.text() };
		} catch (error) {
			outcome = { kind: "transport", message: error instanceof Error ? error.message : String(error) };
		}
		// Host cancellation is a decision, never weather: it is never retried.
		const retry = signal?.aborted !== true &&
			attempt < JUDGE_MAX_ATTEMPTS &&
			(outcome.kind === "transport" || retryableJudgeStatus(outcome.status));
		writeJudgeAttemptEvidence(sidecar, attempt, !retry, {
			request: { url, body: requestBody },
			response: outcome.kind === "http" ? { status: outcome.status, text: outcome.text } : null,
			...(outcome.kind === "transport" ? { error: outcome.message } : {}),
		});

		if (outcome.kind === "transport") {
			if (!retry) throw new Error(`judge request failed: ${outcome.message}`);
			await judgeBackoff(attempt, signal);
			continue;
		}
		if (!outcome.ok) {
			if (!retry) throw new Error(`judge HTTP ${outcome.status}: ${outcome.text.slice(0, 120)}`);
			await judgeBackoff(attempt, signal);
			continue;
		}

		// Parse failures are never retried: the transport worked and a second
		// identical request at temperature 0 has nothing new to say.
		let body: { choices?: { message?: { content?: unknown } }[] };
		try {
			body = JSON.parse(outcome.text) as { choices?: { message?: { content?: unknown } }[] };
		} catch {
			throw new Error(`judge returned an unparseable response body: ${outcome.text.slice(0, 120)}`);
		}
		const usage = parseJudgeUsage(body);
		if (usage) {
			tokens += usage.totalTokens;
			costUsd += judgeCostUsd(judge.spec.cost, usage);
		}
		const verdict = protocol.parse(contentToString(body.choices?.[0]?.message?.content));
		return { verdict, metrics: { calls, tokens, costUsd } };
	}
}

/** Strict majority. An even jury that splits has decided nothing, so it fails. */
function majority(votes: number, jury: number): boolean {
	return votes * 2 > jury;
}

function assertionOutcome(index: number, jurors: readonly JudgeVerdict[]): {
	verdict: AssertionVerdict;
	yes: number;
} {
	const answers = jurors.map((juror) =>
		juror.assertions?.[index - 1] ?? { index, answer: "unknown" as const, evidence: "juror returned no verdict" });
	const yes = answers.filter((answer) => answer.answer === "yes").length;
	const decided: AssertionAnswer = majority(yes, jurors.length)
		? "yes"
		: answers.find((answer) => answer.answer !== "yes")?.answer ?? "no";
	// Deterministic evidence: the first juror, in juror order, that voted the
	// decided answer. Free-text evidence is display, never identity.
	const spokesman = answers.find((answer) => answer.answer === decided) ?? answers[0];
	return { verdict: { index, answer: decided, evidence: spokesman?.evidence ?? "judge gave no evidence" }, yes };
}

/** Vote counts for one assertion, named so `1/3` cannot be read as anything else. */
function juryNote(yesVotes: number, jury: number): string {
	return jury > 1 ? ` (${yesVotes}/${jury} yes)` : "";
}

/**
 * Fold jurors into one verdict. Every rule here is deterministic given the
 * jurors' answers: per assertion (or, for a prose rubric, per verdict) a strict
 * majority decides, and the reason names the failed assertions by index with
 * the vote counts, so the same disagreement always reads the same way.
 */
function foldJury(jurors: readonly JudgeVerdict[], assertionCount: number | null): JudgeVerdict {
	const jury = jurors.length;
	if (assertionCount === null) {
		const passedVotes = jurors.filter((juror) => juror.passed).length;
		const passed = majority(passedVotes, jury);
		const spokesman = jurors.find((juror) => juror.passed === passed) ?? jurors[0]!;
		const score = jurors.reduce((total, juror) => total + juror.score, 0) / jury;
		return {
			passed,
			score,
			reason: jury > 1
				? `jury ${passedVotes}/${jury} passed · ${spokesman.reason}`
				: spokesman.reason,
			...(spokesman.choice ? { choice: spokesman.choice } : {}),
		};
	}
	const decided = Array.from({ length: assertionCount }, (_unused, offset) =>
		assertionOutcome(offset + 1, jurors));
	const failed = decided.filter((entry) => entry.verdict.answer !== "yes");
	const reason = failed.length === 0
		? `${assertionCount}/${assertionCount} assertions passed${jury > 1 ? ` (jury ${jury})` : ""}`
		: failed
			.map((entry) =>
				`assertion ${entry.verdict.index} ${entry.verdict.answer === "no" ? "failed" : "unknown"}` +
				`${juryNote(entry.yes, jury)}: ${entry.verdict.evidence}`)
			.join("; ");
	return {
		passed: failed.length === 0,
		score: (assertionCount - failed.length) / assertionCount,
		reason,
		assertions: decided.map((entry) => entry.verdict),
	};
}

/**
 * Grade one judge check: one call, or a jury of independent calls whose
 * majority decides. Every juror keeps its own retries and its own sidecar, and
 * the reported metrics are the sum over all of them.
 */
async function gradeJudge(
	protocol: JudgeProtocol,
	judge: TargetManifest["model"],
	sidecar: JudgeSidecar,
	assertionCount: number | null,
	signal?: AbortSignal,
): Promise<{ result: GraderResult; metrics: JudgeMetrics }> {
	const jury = protocol.jury ?? 1;
	const jurors: JudgeVerdict[] = [];
	const metrics: JudgeMetrics = { calls: 0, tokens: 0, costUsd: 0 };
	for (let juror = 1; juror <= jury; juror += 1) {
		const attempt = await judgeOnce(
			protocol,
			judge,
			jury === 1 ? sidecar : { ...sidecar, juror },
			signal,
		);
		jurors.push(attempt.verdict);
		metrics.calls += attempt.metrics.calls;
		metrics.tokens += attempt.metrics.tokens;
		metrics.costUsd += attempt.metrics.costUsd;
	}
	const verdict = foldJury(jurors, assertionCount);
	if (verdict.choice || verdict.assertions || jury > 1) {
		writeJudgeVerdictEvidence(sidecar, verdict, jurors);
	}
	return {
		result: {
			name: "",
			type: "judge",
			passed: verdict.passed,
			score: verdict.score,
			reason: verdict.reason,
			...(verdict.assertions
				? {
					assertions: {
						total: verdict.assertions.length,
						failed: verdict.assertions
							.filter((assertion) => assertion.answer !== "yes")
							.map((assertion) => assertion.index),
					},
				}
				: {}),
		},
		metrics,
	};
}

/** Grade one completed run against its task's effective graders. */
function graderCheckCode(type: GraderSpec["type"]): GraderCheckCode {
	switch (type) {
		case "tool_called": return "required-tool";
		case "output_contains": return "output-contains";
		case "output_matches": return "output-matches";
		case "judge": return "semantic-rubric";
		case "exact": return "reference-exact";
		case "similarity": return "reference-similarity";
	}
}

export interface GradedRun {
	graders: GraderResult[];
	/** Aggregate judge cost for this run; null when no judge grader ran. */
	judge: JudgeMetrics | null;
}

export async function gradeRun(
	task: ResolvedTask,
	record: RunRecord,
	runsRoot: string,
	judge?: TargetManifest["model"],
	signal?: AbortSignal,
): Promise<GradedRun> {
	const runDir = resolveContainedArtifactPath(runsRoot, ArtifactIdSchema.parse(record.runId));
	let output: string | undefined;
	let toolCalls: ReturnType<typeof traceToolCalls> = [];
	if (record.status === "completed" && record.trace.path) {
		const messages = openTrace(runDir, record.trace.path, record.trace.sha256 ?? undefined);
		output = lastAssistantText(messages);
		toolCalls = traceToolCalls(messages);
	}
	const results: GraderResult[] = [];
	const judgeSpend = { calls: 0, tokens: 0, costUsd: 0 };
	let judgeCalled = false;
	for (const [index, spec] of task.effectiveGraders.entries()) {
		if (signal?.aborted) throw signal.reason ?? new Error("grading aborted");
		const normalizedSpec = GraderSpec.parse(spec);
		let result: GraderResult;
		if (record.status !== "completed") {
			result = {
				name: "",
				type: normalizedSpec.type,
				passed: false,
				score: 0,
				reason: `run did not complete (${record.status}${record.error ? `: ${record.error}` : ""})`,
			};
		} else if (normalizedSpec.type === "tool_called") {
			result = gradeToolCalled(normalizedSpec, toolCalls);
		} else if (normalizedSpec.type === "output_contains") {
			result = gradeOutputContains(normalizedSpec, output ?? "");
		} else if (graderNeedsExpected(normalizedSpec) && !hasReferenceAnswer(task)) {
			// Checked before any judge call: a case with no reference answer costs
			// no tokens and never passes on the strength of an empty comparison.
			result = missingExpected(normalizedSpec.type);
		} else if (normalizedSpec.type === "exact") {
			result = gradeExact(normalizedSpec, task.expected, output ?? "");
		} else if (normalizedSpec.type === "similarity") {
			result = gradeSimilarity(normalizedSpec, task.expected, output ?? "");
		} else if (normalizedSpec.type === "judge") {
			if (!judge) throw new Error("judge grader without judge model config");
			const assertions = normalizedSpec.assertions;
			const jury = normalizedSpec.jury ?? 1;
			const judged = await gradeJudge(
				assertions
					? {
						system: JUDGE_ASSERTIONS_SYSTEM,
						user: judgeAssertionsPrompt(
							{ rubric: normalizedSpec.rubric, assertions },
							task.input,
							output ?? "",
						),
						// One juror folded alone is that juror's own verdict; the jury
						// fold in gradeJudge then decides each assertion across jurors.
						parse: (text) => foldJury(
							[{ passed: false, score: 0, reason: "", assertions: parseAssertionVerdicts(text, assertions.length) }],
							assertions.length,
						),
						jury,
					}
					: normalizedSpec.withReference
					? {
						system: JUDGE_REFERENCE_SYSTEM,
						user: judgeReferencePrompt(normalizedSpec.rubric ?? "", task.input, task.expected ?? "", output ?? ""),
						parse: parseReferenceVerdict,
						jury,
					}
					: {
						system: JUDGE_SYSTEM,
						user: `Критерий: ${normalizedSpec.rubric}\n\nОбращение: ${task.input}\n\nОтвет агента: ${output ?? ""}`,
						parse: parseVerdict,
						jury,
					},
				judge,
				{ dir: join(runDir, "judge"), graderIndex: index },
				assertions ? assertions.length : null,
				signal,
			);
			result = judged.result;
			judgeCalled = true;
			judgeSpend.calls += judged.metrics.calls;
			judgeSpend.tokens += judged.metrics.tokens;
			judgeSpend.costUsd += judged.metrics.costUsd;
		} else {
			result = gradeOutputMatches(normalizedSpec, output ?? "");
		}
		results.push({
			...result,
			name: graderName(normalizedSpec, task, index),
			specHash: hashValue(normalizedSpec),
			checkCode: graderCheckCode(normalizedSpec.type),
		});
	}
	return { graders: results, judge: judgeCalled ? judgeSpend : null };
}

// ---------- Eval run aggregation ----------

export const EvalRunSummarySchema = z
	.strictObject({
		total: z.number().int().nonnegative(),
		pass: z.number().int().nonnegative(),
		fail: z.number().int().nonnegative(),
		error: z.number().int().nonnegative(),
		allPassRate: z.number().min(0).max(1),
	})
	.superRefine((summary, context) => {
		if (summary.total !== summary.pass + summary.fail + summary.error) {
			context.addIssue({ code: "custom", path: ["total"], message: "must equal pass + fail + error" });
		}
		const expected = summary.total === 0 ? 0 : summary.pass / summary.total;
		if (Math.abs(summary.allPassRate - expected) > Number.EPSILON) {
			context.addIssue({ code: "custom", path: ["allPassRate"], message: "must equal pass / total" });
		}
	});
export type EvalRunSummary = z.infer<typeof EvalRunSummarySchema>;

const ArtifactIdSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/, "expected one safe artifact path segment");

const EvalRunArtifactSchema = z.strictObject({
	runId: ArtifactIdSchema,
	sha256: HashSchema,
});

export const EvidenceVisibilitySchema = z.enum(["development", "sealed"]);
export type EvidenceVisibility = z.infer<typeof EvidenceVisibilitySchema>;

/**
 * Bumped to 2 in V1.8: `provenance` lost `ahdeCodeHash` and gained
 * `evaluatorId`, so a v1 index describes a different comparability contract.
 * v1 records stay readable only as display-only legacy rows
 * (`listEvalRunIndexesLenient`); they are never comparable or reusable.
 */
export const EVAL_RUN_SCHEMA_VERSION = 2;

export const EvalRunRecordSchema = z.strictObject({
	schemaVersion: z.literal(EVAL_RUN_SCHEMA_VERSION),
	evalRunId: ArtifactIdSchema,
	target: z.strictObject({
		id: z.string().min(1),
		gitSha: TargetRevisionSchema,
		/** Optional only for legacy indexes. New evals always persist it. */
		toolsetHash: HashSchema.optional(),
		/** Exact shared model-visible source snapshot. Legacy indexes may omit it. */
		workspaceHash: HashSchema.optional(),
	}),
	/**
	 * `regrade` marks an eval that re-scored recorded traces instead of calling
	 * the Target model. It is deliberately outside every label a run can be
	 * launched with, so a regrade is never reused as a baseline and never stands
	 * in for a candidate arm.
	 */
	label: z.enum(["baseline", "candidate", "solo", "regrade"]),
	/** For candidate runs: the baseline eval run it was compared against. */
	baselineEvalRunId: ArtifactIdSchema.nullable(),
	/** Set only by `ahde regrade`: the eval run whose recorded traces were re-scored. */
	regradeOf: ArtifactIdSchema.optional(),
	provenance: ProvenanceAxesSchema,
	provenanceKey: HashSchema,
	suiteId: z.string().min(1),
	suiteHash: HashSchema,
	dataset: z.string().min(1),
	datasetHash: HashSchema,
	/** Explicit evidence boundary. Optional only for legacy eval indexes. */
	evidenceVisibility: EvidenceVisibilitySchema.optional(),
	/** Source task ids in their exact evaluation order. Optional for legacy indexes. */
	taskIds: z
		.array(z.string().min(1))
		.refine((values) => new Set(values).size === values.length, "taskIds must be unique")
		.optional(),
	repetitions: z.number().int().positive(),
	runIds: z
		.array(ArtifactIdSchema)
		.refine((values) => new Set(values).size === values.length, "runIds must be unique"),
	/** Canonical hashes for final run.json records. Legacy indexes may omit this, but cannot be promotion evidence. */
	runArtifacts: z.array(EvalRunArtifactSchema).optional(),
	startedAt: z.string().min(1),
	finishedAt: z.string().min(1),
	summary: EvalRunSummarySchema,
}).superRefine((record, context) => {
	if (record.provenanceKey !== hashValue(record.provenance)) {
		context.addIssue({ code: "custom", path: ["provenanceKey"], message: "does not match provenance" });
	}
	if (record.suiteHash !== record.provenance.suiteHash) {
		context.addIssue({ code: "custom", path: ["suiteHash"], message: "does not match provenance.suiteHash" });
	}
	if (record.datasetHash !== record.provenance.datasetHash) {
		context.addIssue({ code: "custom", path: ["datasetHash"], message: "does not match provenance.datasetHash" });
	}
	if (record.evidenceVisibility === "development" && record.dataset.startsWith("sealed-")) {
		context.addIssue({
			code: "custom",
			path: ["evidenceVisibility"],
			message: "development visibility conflicts with a legacy sealed dataset name",
		});
	}
	if (record.label === "candidate" && record.baselineEvalRunId === null) {
		context.addIssue({ code: "custom", path: ["baselineEvalRunId"], message: "candidate eval requires a baseline eval reference" });
	}
	if (record.label !== "candidate" && record.baselineEvalRunId !== null) {
		context.addIssue({ code: "custom", path: ["baselineEvalRunId"], message: `${record.label} eval cannot reference a baseline eval` });
	}
	if (record.label === "regrade" && record.regradeOf === undefined) {
		context.addIssue({ code: "custom", path: ["regradeOf"], message: "a regrade eval must name the eval run it re-scored" });
	}
	if (record.regradeOf === record.evalRunId) {
		context.addIssue({ code: "custom", path: ["regradeOf"], message: "an eval run cannot be a regrade of itself" });
	}
	if (record.runArtifacts) {
		const artifactIds = record.runArtifacts.map((artifact) => artifact.runId);
		if (new Set(artifactIds).size !== artifactIds.length) {
			context.addIssue({ code: "custom", path: ["runArtifacts"], message: "run artifact ids must be unique" });
		}
		if (JSON.stringify(artifactIds) !== JSON.stringify(record.runIds)) {
			context.addIssue({ code: "custom", path: ["runArtifacts"], message: "run artifacts must match runIds in order" });
		}
	}
});
export type EvalRunRecord = z.infer<typeof EvalRunRecordSchema>;

/** Explicit visibility for new evidence, with the legacy sealed dataset convention as a fallback. */
export function isSealedEvalRun(
	record: Pick<EvalRunRecord, "dataset" | "evidenceVisibility"> & { datasetHash?: string },
	legacySealedDatasetHashes: ReadonlySet<string> = new Set(),
): boolean {
	return record.evidenceVisibility === "sealed" ||
		record.dataset.startsWith("sealed-") ||
		(record.evidenceVisibility === undefined && record.datasetHash !== undefined &&
			legacySealedDatasetHashes.has(record.datasetHash));
}

export interface VerifiedEvalRun {
	record: EvalRunRecord;
	runs: RunRecord[];
	hasRunHashes: boolean;
}

export function newEvalRunId(): string {
	return `erun_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface RunSuiteOptions {
	runsRoot: string;
	label: "baseline" | "candidate" | "solo";
	repetitions: number;
	candidateOf?: string | null;
	/** Restrict an ad-hoc diagnostic run to one task id. */
	taskId?: string;
	/** Baseline eval run id this candidate will be compared against. */
	baselineEvalRunId?: string | null;
	/** Evidence disclosure boundary. New suites persist development by default. */
	evidenceVisibility?: EvidenceVisibility;
	/** @internal Exact source hash captured for a baseline-reuse query. */
	expectedWorkspaceHash?: string;
	/** Optional synchronous, observational listener for all task executions. */
	onRunEvent?: RunEventListener;
	/** Host-owned cancellation propagated through Target and judge sessions. */
	signal?: AbortSignal;
	/**
	 * Concurrent executions. Defaults to {@link DEFAULT_EVAL_JOBS}, or 1 against
	 * a loopback endpoint. Evidence is unaffected: every run keeps its own
	 * directory, ordinal and design position regardless of completion order.
	 */
	jobs?: number;
}

/** Hosted providers absorb a small fan-out; this is the value `--jobs` defaults to. */
export const DEFAULT_EVAL_JOBS = 4;

/**
 * A model server on this machine is the bottleneck itself: parallel prompts
 * queue behind one GPU and only add contention and timeouts. Loopback targets
 * therefore default to a single job.
 */
export function isLoopbackModelEndpoint(baseUrl: string): boolean {
	let host: string;
	try {
		host = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return false;
	}
	const bare = host.replace(/^\[|\]$/g, "");
	return bare === "localhost" || bare.endsWith(".localhost") ||
		bare === "::1" || bare === "0.0.0.0" || bare === "::" ||
		/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare) ||
		bare === "::ffff:127.0.0.1";
}

export function defaultEvalJobs(model: { baseUrl: string }): number {
	return isLoopbackModelEndpoint(model.baseUrl) ? 1 : DEFAULT_EVAL_JOBS;
}

/** One planned execution: its exact position in the design is fixed before anything runs. */
interface PlannedRun {
	/** One-based position within tasks × repetitions. */
	ordinal: number;
	task: ResolvedTask;
	repetition: number;
}

interface CompletedRun {
	record: RunRecord;
	outcome: "pass" | "fail" | "error";
}

export interface GradedRunOutcome extends CompletedRun {
	/** Null exactly when grading itself failed and the run became an error. */
	graded: GradedRun | null;
}

/**
 * Grade one recorded execution against a task and write its final run.json
 * exactly once. A grading failure is infrastructure, not a verdict: the run
 * becomes an error with its cause, and the same single write persists it.
 *
 * This is the only place a RunRecord acquires an outcome. `runSuite` calls it
 * for an execution it just performed and `ahde regrade` calls it for a trace it
 * copied, so both paths score evidence through identical code.
 */
export async function gradeRecordedRun(
	task: ResolvedTask,
	record: RunRecord,
	runsRoot: string,
	judge?: TargetManifest["model"],
	signal?: AbortSignal,
): Promise<GradedRunOutcome> {
	let graded: GradedRun | null = null;
	try {
		graded = await gradeRun(task, record, runsRoot, judge, signal);
	} catch (gradeError) {
		record.status = "error";
		record.error = `evaluation infrastructure: ${gradeError instanceof Error ? gradeError.message : String(gradeError)}`;
		record.evalResults = null;
	}
	if (graded) {
		record.evalResults = {
			graders: graded.graders,
			outcome: graded.graders.every((grader) => grader.passed) ? "pass" : "fail",
		};
		if (graded.judge) record.metrics = { ...record.metrics, judge: graded.judge };
	}
	writeJsonArtifact(
		resolveContainedArtifactPath(runsRoot, ArtifactIdSchema.parse(record.runId), "run.json"),
		RunRecordSchema,
		record,
	);
	return { record, outcome: record.evalResults?.outcome ?? "error", graded };
}

/** Grade a just-finished execution and announce its verdict on the event seam. */
async function gradeAndFinalize(
	target: ResolvedTarget,
	task: ResolvedTask,
	record: RunRecord,
	options: RunSuiteOptions,
	eventRun: RunEventIdentity,
): Promise<CompletedRun> {
	const finalized = await gradeRecordedRun(
		task,
		record,
		options.runsRoot,
		target.manifest.evalSuite.judge,
		options.signal,
	);
	emitRunGraded(
		options.onRunEvent,
		eventRun,
		finalized.outcome,
		finalized.graded?.graders ?? [],
		task.effectiveGraders.length,
	);
	return { record: finalized.record, outcome: finalized.outcome };
}

/**
 * Bounded worker pool over a fixed design. Each worker takes the next unclaimed
 * position and lands its result in that position's slot, so the returned array
 * is always in design order regardless of completion order. The first failure
 * stops the pool from claiming more work — a broken evaluation must not keep
 * spending tokens — but never cancels what is already running.
 */
export async function runBoundedPool<TItem, TResult>(
	items: readonly TItem[],
	jobs: number,
	run: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
	if (!Number.isInteger(jobs) || jobs < 1) {
		throw new Error(`jobs must be a positive integer, got ${jobs}`);
	}
	const slots: (TResult | undefined)[] = new Array<TResult | undefined>(items.length);
	const claimed: boolean[] = new Array<boolean>(items.length).fill(false);
	let next = 0;
	let firstFailure: { reason: unknown } | undefined;
	const worker = async (): Promise<void> => {
		for (;;) {
			if (firstFailure) return;
			const index = next;
			next += 1;
			if (index >= items.length) return;
			try {
				slots[index] = await run(items[index]!, index);
				claimed[index] = true;
			} catch (error) {
				firstFailure ??= { reason: error };
				throw error;
			}
		}
	};
	const settled = await Promise.allSettled(
		Array.from({ length: Math.min(jobs, items.length) }, () => worker()),
	);
	if (firstFailure) throw firstFailure.reason;
	const rejected = settled.find((result) => result.status === "rejected");
	if (rejected?.status === "rejected") throw rejected.reason;
	return slots.map((slot, index) => {
		if (!claimed[index]) throw new Error(`bounded pool lost the result for position ${index + 1}`);
		return slot as TResult;
	});
}

/**
 * Run (and grade) a suite: tasks × repetitions on the target harness.
 * Writes per-run run.json and one eval_run.json index.
 */
export async function runSuite(target: ResolvedTarget, options: RunSuiteOptions): Promise<EvalRunRecord> {
	if (options.signal?.aborted) throw options.signal.reason ?? new Error("evaluation aborted");
	if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
		throw new Error(`repetitions must be a positive integer, got ${options.repetitions}`);
	}
	mkdirSync(options.runsRoot, { recursive: true });
	const evalRunId = newEvalRunId();
	const tasks = options.taskId ? target.tasks.filter((t) => t.id === options.taskId) : target.tasks;
	if (tasks.length === 0) throw new Error(`task not found: ${options.taskId}`);

	const jobs = options.jobs ?? defaultEvalJobs(target.manifest.model);
	if (!Number.isInteger(jobs) || jobs < 1) {
		throw new Error(`jobs must be a positive integer, got ${jobs}`);
	}

	const startedAt = new Date().toISOString();
	// The complete design exists before the first model call: every execution
	// owns its ordinal, so persisted order is the design's, never completion's.
	const design: PlannedRun[] = [];
	for (const [taskIndex, task] of tasks.entries()) {
		for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
			design.push({ ordinal: taskIndex * options.repetitions + repetition + 1, task, repetition });
		}
	}
	const executionTotal = design.length;

	const workspaceSnapshot = materializeTargetWorkspaceSnapshot(
		target,
		options.runsRoot,
	);
	if (options.expectedWorkspaceHash && workspaceSnapshot.sha256 !== options.expectedWorkspaceHash) {
		disposeTargetWorkspaceSnapshot(workspaceSnapshot);
		throw new Error("Target workspace changed after the baseline reuse query");
	}

	const execute = async (planned: PlannedRun): Promise<CompletedRun> => {
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("evaluation aborted");
		const record = await runTask(target, planned.task, {
			runsRoot: options.runsRoot,
			label: options.label,
			repetitionIndex: planned.repetition,
			evalRunId,
			candidateOf: options.candidateOf ?? null,
			workspaceSnapshot,
			ordinal: planned.ordinal,
			total: executionTotal,
			onRunEvent: options.onRunEvent,
			signal: options.signal,
		});
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("evaluation aborted");
		const eventRun: RunEventIdentity = {
			evalRunId,
			runId: record.runId,
			taskId: record.taskId,
			repetitionIndex: record.repetitionIndex,
			ordinal: planned.ordinal,
			total: executionTotal,
		};
		if (record.status === "error") {
			emitRunGraded(options.onRunEvent, eventRun, "error", [], planned.task.effectiveGraders.length);
			return { record, outcome: "error" };
		}
		return gradeAndFinalize(target, planned.task, record, options, eventRun);
	};

	let completed: CompletedRun[];
	try {
		completed = await runBoundedPool(design, jobs, (planned) => execute(planned));
	} finally {
		// The snapshot is shared by every in-flight run, so it is disposed only
		// once they have all settled — an abort waits for its own executions.
		disposeTargetWorkspaceSnapshot(workspaceSnapshot);
	}
	if (options.signal?.aborted) throw options.signal.reason ?? new Error("evaluation aborted");

	const runIds = completed.map((slot) => slot.record.runId);
	const pass = completed.filter((slot) => slot.outcome === "pass").length;
	const fail = completed.filter((slot) => slot.outcome === "fail").length;
	const error = completed.filter((slot) => slot.outcome === "error").length;

	// One eval run is one execution policy. Reduced after the pass rather than
	// carried through it, because "first wins" has no meaning in a pool.
	const effectiveExecution: ExecutionFingerprint | undefined = completed[0]?.record.execution;
	if (!effectiveExecution) throw new Error("evaluation produced no execution fingerprint");
	for (const slot of completed) {
		if (canonicalJson(slot.record.execution) !== canonicalJson(effectiveExecution)) {
			throw new Error("execution policy changed within one eval run");
		}
	}
	const total = runIds.length;
	const evidenceInput = {
		runtime: target.runtime,
		model: modelFingerprint(target.manifest.model),
		judge: target.manifest.evalSuite.judge ? modelFingerprint(target.manifest.evalSuite.judge) : null,
		execution: effectiveExecution,
		eval: { suiteHash: target.suiteHash, datasetHash: target.datasetHash },
	};
	const record: EvalRunRecord = {
		schemaVersion: EVAL_RUN_SCHEMA_VERSION,
		evalRunId,
		target: {
			id: target.manifest.id,
			gitSha: target.gitSha,
			toolsetHash: target.toolsetHash,
			workspaceHash: workspaceSnapshot.sha256,
		},
		label: options.label,
		baselineEvalRunId: options.baselineEvalRunId ?? null,
		provenance: provenanceAxes(evidenceInput),
		provenanceKey: provenanceKey(evidenceInput),
		suiteId: target.manifest.evalSuite.id,
		suiteHash: target.suiteHash,
		dataset: target.manifest.evalSuite.dataset.replace(/\.jsonl$/, "").split("/").pop() ?? "dataset",
		datasetHash: target.datasetHash,
		evidenceVisibility: options.evidenceVisibility ?? "development",
		taskIds: tasks.map((task) => task.id),
		repetitions: options.repetitions,
		runIds,
		runArtifacts: runIds.map((runId) => ({
			runId,
			sha256: hashValue(readJsonArtifact(
				resolveContainedArtifactPath(options.runsRoot, runId, "run.json"),
				RunRecordSchema,
			)),
		})),
		startedAt,
		finishedAt: new Date().toISOString(),
		summary: { total, pass, fail, error, allPassRate: total === 0 ? 0 : pass / total },
	};
	writeEvalRun(options.runsRoot, record);
	return record;
}

export function writeEvalRun(runsRoot: string, record: EvalRunRecord): void {
	mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
	const evalDir = resolveContainedArtifactPath(runsRoot, ArtifactIdSchema.parse(record.evalRunId));
	mkdirSync(evalDir, { recursive: true, mode: 0o700 });
	writeJsonArtifact(resolveContainedArtifactPath(runsRoot, record.evalRunId, "eval_run.json"), EvalRunRecordSchema, record, {
		immutable: true,
	});
}

/**
 * One row of `ahde list`: identity, label, target, verdict, and — for derived
 * evidence — the eval run it re-scored, because the timestamp on that row is
 * the grading's, not the traces'.
 */
export function renderEvalRunListLine(record: EvalRunRecord): string {
	return `${record.evalRunId}  ${record.label.padEnd(9)} ${record.target.id.padEnd(16)} ` +
		`${(record.summary.allPassRate * 100).toFixed(0).padStart(3)}% ` +
		`(${record.summary.pass}/${record.summary.total})  ${record.startedAt}` +
		(record.regradeOf ? `  regrade of ${record.regradeOf}` : "");
}

export function loadRun(runsRoot: string, runId: string): RunRecord {
	return readJsonArtifact(
		resolveContainedArtifactPath(runsRoot, ArtifactIdSchema.parse(runId), "run.json"),
		RunRecordSchema,
	);
}

/**
 * Read only the bounded EvalRun index. This deliberately does not open member
 * RunRecords so visibility can be checked before sealed evidence is touched.
 */
export function readEvalRunIndex(runsRoot: string, evalRunId: string): EvalRunRecord {
	const parsedId = ArtifactIdSchema.parse(evalRunId);
	const record = readJsonArtifact(
		resolveContainedArtifactPath(runsRoot, parsedId, "eval_run.json"),
		EvalRunRecordSchema,
	);
	if (record.evalRunId !== parsedId) {
		throw new Error("eval run index identity does not match its artifact path");
	}
	return record;
}

/** Index-only inventory for visibility preflight. Member Runs remain unopened. */
export function listEvalRunIndexes(runsRoot: string): EvalRunRecord[] {
	let entries: string[];
	try {
		entries = readdirSync(runsRoot);
	} catch {
		return [];
	}
	const records: EvalRunRecord[] = [];
	for (const entry of entries) {
		if (!entry.startsWith("erun_")) continue;
		records.push(readEvalRunIndex(runsRoot, entry));
	}
	return records.sort((a, b) =>
		b.startedAt.localeCompare(a.startedAt) || b.evalRunId.localeCompare(a.evalRunId));
}

const MAX_BOUNDED_EVAL_INDEX_RESULTS = 1_000;

export interface PublicEvalRunIndexEntry {
	evalRunId: string;
	targetId: string;
	label: EvalRunRecord["label"];
	startedAt: string;
	allPassRate: number;
	fieldsTruncated: boolean;
	fieldsRedacted: boolean;
}

export interface BoundedPublicEvalRunIndexes {
	entries: PublicEvalRunIndexEntry[];
	/** True only when additional public records were omitted. Sealed records never affect this value. */
	truncated: boolean;
	/** Exact number of omitted public records. Sealed records never contribute to this count. */
	omittedPublicCount: number;
}

function newestEvalIndexFirst(left: PublicEvalRunIndexEntry, right: PublicEvalRunIndexEntry): number {
	return right.startedAt.localeCompare(left.startedAt) || right.evalRunId.localeCompare(left.evalRunId);
}

function publicIndexText(value: string, maxChars: number): {
	text: string;
	truncated: boolean;
	redacted: boolean;
} {
	const redacted = redactTraceText(value);
	if (redacted.length <= maxChars) {
		return { text: redacted, truncated: false, redacted: redacted !== value };
	}
	return {
		text: `${redacted.slice(0, maxChars - 1)}…`,
		truncated: true,
		redacted: redacted !== value,
	};
}

function projectPublicEvalRunIndex(record: EvalRunRecord): PublicEvalRunIndexEntry {
	const targetId = publicIndexText(record.target.id, 160);
	const startedAt = publicIndexText(record.startedAt, 64);
	return {
		evalRunId: record.evalRunId,
		targetId: targetId.text,
		label: record.label,
		startedAt: startedAt.text,
		allPassRate: record.summary.allPassRate,
		fieldsTruncated: targetId.truncated || startedAt.truncated,
		fieldsRedacted: targetId.redacted || startedAt.redacted,
	};
}

/**
 * Index-only top-K inventory for public Evidence Explorer surfaces.
 *
 * The directory is streamed and only `limit` bounded display projections are
 * retained in memory; full indexes are released after each projection. Every
 * index is still schema-checked so the result is an exact newest-first top-K.
 * Sealed indexes affect neither returned entries nor truncation metadata.
 * Member RunRecords remain unopened until the caller has completed visibility
 * preflight.
 */
export function listPublicEvalRunIndexesBounded(
	runsRoot: string,
	limit: number,
): BoundedPublicEvalRunIndexes {
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BOUNDED_EVAL_INDEX_RESULTS) {
		throw new Error(`eval index limit must be an integer between 1 and ${MAX_BOUNDED_EVAL_INDEX_RESULTS}`);
	}
	let directory;
	try {
		directory = opendirSync(runsRoot);
	} catch {
		return { entries: [], truncated: false, omittedPublicCount: 0 };
	}
	const entries: PublicEvalRunIndexEntry[] = [];
	let publicCount = 0;
	try {
		let entry = directory.readSync();
		while (entry !== null) {
			if (entry.name.startsWith("erun_")) {
				const record = readEvalRunIndex(runsRoot, entry.name);
				if (!isSealedEvalRun(record)) {
					publicCount += 1;
					entries.push(projectPublicEvalRunIndex(record));
					entries.sort(newestEvalIndexFirst);
					if (entries.length > limit) entries.pop();
				}
			}
			entry = directory.readSync();
		}
	} finally {
		directory.closeSync();
	}
	const omittedPublicCount = publicCount - entries.length;
	return {
		entries,
		truncated: omittedPublicCount > 0,
		omittedPublicCount,
	};
}

export interface InvalidEvalRunIndex {
	evalRunId: string;
	/** Bounded validation reason; legacy indexes predate the current provenance axes. */
	reason: string;
}

/**
 * Bounded peek at an index that failed validation. A pre-V1.8 record is a fact
 * of history, not a defect, and saying so beats a zod dump. Display only: the
 * value is never used to accept, migrate, or compare the record.
 */
function indexSchemaVersion(runsRoot: string, evalRunId: string): number | null {
	try {
		return readJsonArtifact(
			resolveContainedArtifactPath(runsRoot, ArtifactIdSchema.parse(evalRunId), "eval_run.json"),
			z.object({ schemaVersion: z.number().int() }),
		).schemaVersion;
	} catch {
		return null;
	}
}

/**
 * Best-effort index listing: invalid or legacy siblings never hide healthy
 * indexes and never block a caller. Each invalid index is reported with its
 * reason so humans can see "legacy · not comparable" instead of nothing.
 */
export function listEvalRunIndexesLenient(runsRoot: string): {
	records: EvalRunRecord[];
	invalid: InvalidEvalRunIndex[];
	invalidCount: number;
} {
	let entries: string[];
	try {
		entries = readdirSync(runsRoot);
	} catch {
		return { records: [], invalid: [], invalidCount: 0 };
	}
	const records: EvalRunRecord[] = [];
	const invalid: InvalidEvalRunIndex[] = [];
	for (const entry of entries) {
		if (!entry.startsWith("erun_")) continue;
		try {
			records.push(readEvalRunIndex(runsRoot, entry));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const version = indexSchemaVersion(runsRoot, entry);
			const note = version !== null && version < EVAL_RUN_SCHEMA_VERSION
				? `legacy schemaVersion ${version} (not comparable): `
				: "";
			invalid.push({
				evalRunId: entry,
				reason: `${note}${message.replace(/\s+/g, " ")}`.slice(0, 200),
			});
		}
	}
	records.sort((left, right) =>
		right.startedAt.localeCompare(left.startedAt) || right.evalRunId.localeCompare(left.evalRunId));
	invalid.sort((left, right) => left.evalRunId.localeCompare(right.evalRunId));
	return { records, invalid, invalidCount: invalid.length };
}

function evidenceMismatch(evalRunId: string, message: string): never {
	throw new Error(`eval run ${evalRunId} evidence mismatch: ${message}`);
}

function sameJson(a: unknown, b: unknown): boolean {
	return canonicalJson(a) === canonicalJson(b);
}

/**
 * Reconstruct and validate the final EvalRun membership from its RunRecords.
 * The index is never trusted as an unchecked list of passing run IDs.
 */
export function loadVerifiedEvalRun(runsRoot: string, evalRunId: string): VerifiedEvalRun {
	const record = readEvalRunIndex(runsRoot, evalRunId);
	const expectedHashes = new Map(record.runArtifacts?.map((artifact) => [artifact.runId, artifact.sha256]) ?? []);
	const runs = record.runIds.map((runId) => {
		const run = loadRun(runsRoot, runId);
		if (run.runId !== runId) evidenceMismatch(evalRunId, `run path ${runId} contains record ${run.runId}`);
		const expectedHash = expectedHashes.get(runId);
		if (expectedHash && hashValue(run) !== expectedHash) {
			evidenceMismatch(evalRunId, `run ${runId} hash does not match the final eval index`);
		}
		if (run.parent?.evalRunId !== record.evalRunId) {
			evidenceMismatch(evalRunId, `run ${runId} parent does not reference this eval`);
		}
		if (
			run.target.id !== record.target.id ||
			run.target.gitSha !== record.target.gitSha ||
			run.target.toolsetHash !== record.target.toolsetHash ||
			run.target.workspaceHash !== record.target.workspaceHash
		) {
			evidenceMismatch(evalRunId, `run ${runId} target does not match the eval target`);
		}
		if (run.label !== record.label) evidenceMismatch(evalRunId, `run ${runId} label does not match`);
		// A regrade's members must each point at the exact execution they re-scored,
		// and only a regrade's members may claim one.
		if (record.regradeOf === undefined) {
			if (run.derivedFrom !== undefined) {
				evidenceMismatch(evalRunId, `run ${runId} claims a regrade source but this eval is not a regrade`);
			}
		} else if (run.derivedFrom?.evalRunId !== record.regradeOf) {
			evidenceMismatch(evalRunId, `run ${runId} was not derived from the re-scored eval ${record.regradeOf}`);
		}
		if (run.eval.suiteId !== record.suiteId || run.eval.suiteHash !== record.suiteHash) {
			evidenceMismatch(evalRunId, `run ${runId} suite does not match`);
		}
		if (run.eval.dataset !== record.dataset || run.eval.datasetHash !== record.datasetHash) {
			evidenceMismatch(evalRunId, `run ${runId} dataset does not match`);
		}
		if (run.status === "running" || run.finishedAt === null) {
			evidenceMismatch(evalRunId, `run ${runId} is not final`);
		}
		if (run.status === "completed" && run.evalResults === null) {
			evidenceMismatch(evalRunId, `completed run ${runId} has no grading result`);
		}
		if (run.status === "error" && run.evalResults !== null) {
			evidenceMismatch(evalRunId, `error run ${runId} unexpectedly has grading results`);
		}
		const axes = provenanceAxes({
			runtime: run.runtime,
			model: run.model,
			judge: record.provenance.judge,
			execution: run.execution,
			eval: run.eval,
		});
		const differences = axisDifferences(axes, record.provenance);
		if (differences.length > 0) {
			evidenceMismatch(evalRunId, `run ${runId} differs on ${differences.join(", ")}`);
		}
		if (record.label === "candidate" && run.parent.candidateOf === null) {
			evidenceMismatch(evalRunId, `candidate run ${runId} has no candidateOf revision`);
		}
		if (record.label !== "candidate" && run.parent.candidateOf !== null) {
			evidenceMismatch(evalRunId, `${record.label} run ${runId} has an unexpected candidateOf revision`);
		}
		return run;
	});

	const byTask = new Map<string, Set<number>>();
	for (const run of runs) {
		const repetitions = byTask.get(run.taskId) ?? new Set<number>();
		if (repetitions.has(run.repetitionIndex)) {
			evidenceMismatch(evalRunId, `duplicate task/repetition ${run.taskId}/${run.repetitionIndex}`);
		}
		repetitions.add(run.repetitionIndex);
		byTask.set(run.taskId, repetitions);
	}
	if (record.taskIds) {
		const observedTaskIds = [...byTask.keys()];
		if (!sameJson(record.taskIds, observedTaskIds)) {
			evidenceMismatch(evalRunId, "taskIds do not match the exact source task order");
		}
	}
	const expectedRepetitions = Array.from({ length: record.repetitions }, (_, index) => index);
	for (const [taskId, repetitions] of byTask) {
		if (!sameJson([...repetitions].sort((a, b) => a - b), expectedRepetitions)) {
			evidenceMismatch(evalRunId, `task ${taskId} does not contain exactly ${record.repetitions} repetitions`);
		}
	}
	const summary = {
		total: runs.length,
		pass: runs.filter((run) => run.status === "completed" && run.evalResults?.outcome === "pass").length,
		fail: runs.filter((run) => run.status === "completed" && run.evalResults?.outcome === "fail").length,
		error: runs.filter((run) => run.status === "error").length,
		allPassRate: runs.length === 0
			? 0
			: runs.filter((run) => run.status === "completed" && run.evalResults?.outcome === "pass").length / runs.length,
	};
	if (!sameJson(summary, record.summary)) evidenceMismatch(evalRunId, "summary does not match verified runs");
	return { record, runs, hasRunHashes: record.runArtifacts !== undefined };
}

export function loadEvalRun(runsRoot: string, evalRunId: string): EvalRunRecord {
	return loadVerifiedEvalRun(runsRoot, evalRunId).record;
}

export function listEvalRuns(runsRoot: string): EvalRunRecord[] {
	return listEvalRunIndexes(runsRoot).map((record) => loadEvalRun(runsRoot, record.evalRunId));
}

/**
 * The exact identity a reusable baseline must match. Every field is required:
 * a partial query would let sealed evidence reuse a development index or a
 * one-repetition baseline stand in for a three-repetition design.
 */
export interface ReusableBaselineQuery {
	targetId: string;
	targetGitSha: string;
	/** Exact tool identity. */
	toolsetHash: string;
	/** Exact model-visible workspace identity. */
	workspaceHash: string;
	provenance: ProvenanceAxes;
	evidenceVisibility: EvidenceVisibility;
	label: "baseline" | "candidate" | "solo";
	repetitions: number;
	/**
	 * How old a baseline may be and still stand in for a fresh one. Provider
	 * behaviour drifts behind an unchanged model id, so age is the one axis the
	 * fingerprint cannot see. Defaults to {@link DEFAULT_BASELINE_MAX_AGE_MS};
	 * 0 disables reuse.
	 */
	maxAgeMs?: number;
}

/** Seven days: long enough to amortize a baseline, short enough to notice drift. */
export const DEFAULT_BASELINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Find the newest eval run whose identity matches the query (baseline reuse).
 * The scan reads indexes only and skips legacy, errored, or otherwise
 * unusable siblings; only the chosen match is fully verified, so one bad
 * index on disk can never abort a candidate verification.
 */
export function findReusableBaseline(runsRoot: string, query: ReusableBaselineQuery): EvalRunRecord | null {
	const maxAgeMs = query.maxAgeMs ?? DEFAULT_BASELINE_MAX_AGE_MS;
	const oldestUsableMs = Date.now() - maxAgeMs;
	for (const record of listEvalRunIndexesLenient(runsRoot).records) {
		if (record.label !== query.label) continue;
		// Derived evidence is not a fresh measurement. A regrade copies the source
		// traces and stamps today's timestamps, so reusing one would let a re-grade
		// resurrect a baseline the freshness guard had retired and pair a fresh
		// candidate against months-old Target behaviour.
		if (record.regradeOf !== undefined) continue;
		// An unreadable timestamp cannot prove freshness, so it is not fresh.
		const finishedAtMs = Date.parse(record.finishedAt);
		if (!Number.isFinite(finishedAtMs) || finishedAtMs < oldestUsableMs) continue;
		if (record.target.id !== query.targetId || record.target.gitSha !== query.targetGitSha) continue;
		if (record.target.toolsetHash !== query.toolsetHash) continue;
		if (record.target.workspaceHash !== query.workspaceHash) continue;
		if (record.evidenceVisibility !== query.evidenceVisibility) continue;
		if (record.provenanceKey === "") continue;
		if (record.repetitions !== query.repetitions) continue;
		// Errored evidence is inconclusive and would only stop the experiment later.
		if (record.summary.error > 0) continue;
		if (axisDifferences(record.provenance, query.provenance).length !== 0) continue;
		try {
			return loadVerifiedEvalRun(runsRoot, record.evalRunId).record;
		} catch {
			// A match whose member runs no longer verify is not evidence; keep scanning.
			continue;
		}
	}
	return null;
}
