import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { graderName, type ResolvedTarget, type ResolvedTask, type TargetManifest } from "./manifest.js";
import {
	provenanceAxes,
	provenanceKey,
	type GraderResult,
	type RunRecord,
	type ProvenanceAxes,
} from "./provenance.js";
import { runTask } from "./runner.js";
import { lastAssistantText, openTrace, traceToolCalls } from "./trace.js";

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

// ---------- Judge grader ----------
// Judge calls leave a sidecar trace (exact request + raw response) in
// runs/<run_id>/judge/<graderIndex>.json — written BEFORE parsing, so even an
// unparseable verdict keeps its evidence. ponytail: sidecar file, not a
// judge-as-run through runner.ts; upgrade if judge verdicts ever need their
// own provenance/cost accounting.

const JUDGE_SYSTEM =
	'Ты — грейдер. Оцени ответ агента на обращение по критерию. ' +
	'Ответь строго одной строкой JSON без markdown: {"passed": true|false, "reason": "краткое обоснование"}';

function parseVerdict(text: string): { passed: boolean; reason: string } {
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
	const verdict = parsed as { passed?: unknown; reason?: unknown };
	if (typeof verdict.passed !== "boolean" || typeof verdict.reason !== "string") {
		throw new Error(`judge verdict missing passed/reason: ${text.slice(0, 120)}`);
	}
	return { passed: verdict.passed, reason: verdict.reason };
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

async function gradeJudge(
	spec: { rubric: string },
	judge: TargetManifest["model"],
	task: { input: string },
	output: string,
	tracePath: string,
): Promise<GraderResult> {
	const key = process.env[judge.apiKeyEnv];
	if (judge.baseUrl.includes("openrouter.ai") && !key) {
		throw new Error(`missing ${judge.apiKeyEnv} for judge endpoint ${judge.baseUrl}`);
	}
	const url = `${judge.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const requestBody = {
		model: judge.id,
		messages: [
			{ role: "system", content: JUDGE_SYSTEM },
			{ role: "user", content: `Критерий: ${spec.rubric}\n\nОбращение: ${task.input}\n\nОтвет агента: ${output}` },
		],
		temperature: 0,
		stream: false,
		...(judge.thinkingLevel !== "off" ? { reasoning: { effort: judge.thinkingLevel } } : {}),
	};
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
		body: JSON.stringify(requestBody),
		signal: AbortSignal.timeout(judge.timeoutMs),
	});
	const rawText = await response.text();
	// Evidence first: the exact exchange is on disk even if parsing/HTTP fails.
	mkdirSync(join(tracePath, ".."), { recursive: true });
	writeFileSync(tracePath, `${JSON.stringify({ request: { url, body: requestBody }, response: { status: response.status, text: rawText } }, null, "\t")}\n`);
	if (!response.ok) {
		throw new Error(`judge HTTP ${response.status}: ${rawText.slice(0, 120)}`);
	}
	const body = JSON.parse(rawText) as { choices?: { message?: { content?: unknown } }[] };
	const text = contentToString(body.choices?.[0]?.message?.content);
	const verdict = parseVerdict(text);
	return { name: "", type: "judge", passed: verdict.passed, score: verdict.passed ? 1 : 0, reason: verdict.reason };
}

/** Grade one completed run against its task's effective graders. */
export async function gradeRun(
	task: ResolvedTask,
	record: RunRecord,
	runsRoot: string,
	judge?: TargetManifest["model"],
): Promise<GraderResult[]> {
	const runDir = join(runsRoot, record.runId);
	let output: string | undefined;
	let toolCalls: ReturnType<typeof traceToolCalls> = [];
	if (record.status === "completed" && record.trace.path) {
		try {
			const messages = openTrace(runDir, record.trace.path);
			output = lastAssistantText(messages);
			toolCalls = traceToolCalls(messages);
		} catch {
			// missing/corrupt trace → all graders fail with parse error reason
		}
	}
	const results: GraderResult[] = [];
	for (const [index, spec] of task.effectiveGraders.entries()) {
		let result: GraderResult;
		if (record.status !== "completed") {
			result = {
				name: "",
				type: spec.type,
				passed: false,
				score: 0,
				reason: `run did not complete (${record.status}${record.error ? `: ${record.error}` : ""})`,
			};
		} else if (spec.type === "tool_called") {
			result = gradeToolCalled(spec, toolCalls);
		} else if (spec.type === "output_contains") {
			result = gradeOutputContains(spec, output ?? "");
		} else if (spec.type === "judge") {
			if (!judge) throw new Error("judge grader without judge model config");
			result = await gradeJudge(spec, judge, task, output ?? "", join(runDir, "judge", `${index}.json`));
		} else {
			result = gradeOutputMatches(spec, output ?? "");
		}
		results.push({ ...result, name: graderName(spec, task, index) });
	}
	return results;
}

// ---------- Eval run aggregation ----------

export interface EvalRunSummary {
	total: number;
	pass: number;
	fail: number;
	error: number;
	allPassRate: number;
}

export interface EvalRunRecord {
	schemaVersion: 1;
	evalRunId: string;
	target: { id: string; gitSha: string };
	label: "baseline" | "candidate" | "solo";
	/** For candidate runs: the baseline eval run it was compared against. */
	baselineEvalRunId: string | null;
	provenance: ProvenanceAxes;
	provenanceKey: string;
	suiteId: string;
	suiteHash: string;
	dataset: string;
	datasetHash: string;
	repetitions: number;
	runIds: string[];
	startedAt: string;
	finishedAt: string;
	summary: EvalRunSummary;
}

export function newEvalRunId(): string {
	return `erun_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export interface RunSuiteOptions {
	runsRoot: string;
	label: "baseline" | "candidate" | "solo";
	repetitions: number;
	candidateOf?: string | null;
	/** Restrict to a single task id (smoke runs). */
	taskId?: string;
	/** Baseline eval run id this candidate will be compared against. */
	baselineEvalRunId?: string | null;
}

/**
 * Run (and grade) a suite: tasks × repetitions on the target harness.
 * Writes per-run run.json and one eval_run.json index.
 */
export async function runSuite(target: ResolvedTarget, options: RunSuiteOptions): Promise<EvalRunRecord> {
	mkdirSync(options.runsRoot, { recursive: true });
	const evalRunId = newEvalRunId();
	const tasks = options.taskId ? target.tasks.filter((t) => t.id === options.taskId) : target.tasks;
	if (tasks.length === 0) throw new Error(`task not found: ${options.taskId}`);

	const startedAt = new Date().toISOString();
	const runIds: string[] = [];
	let pass = 0;
	let fail = 0;
	let error = 0;

	for (const task of tasks) {
		for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
			const record = await runTask(target, task, {
				runsRoot: options.runsRoot,
				label: options.label,
				repetitionIndex: repetition,
				evalRunId,
				candidateOf: options.candidateOf ?? null,
			});
			runIds.push(record.runId);
			if (record.status === "error") {
				error += 1;
				continue;
			}
			const graders = await gradeRun(task, record, options.runsRoot, target.manifest.evalSuite.judge);
			const outcome = graders.every((g) => g.passed) ? "pass" : "fail";
			record.evalResults = { graders, outcome };
			// finalize run.json with eval results (second and final write)
			writeFileSync(
				join(options.runsRoot, record.runId, "run.json"),
				`${JSON.stringify(record, null, "\t")}\n`,
			);
			if (outcome === "pass") pass += 1;
			else fail += 1;
		}
	}

	const total = runIds.length;
	const modelAxes = {
		provider: target.manifest.model.provider,
		id: target.manifest.model.id,
		thinkingLevel: target.manifest.model.thinkingLevel,
		params: target.manifest.model.params,
	};
	const record: EvalRunRecord = {
		schemaVersion: 1,
		evalRunId,
		target: { id: target.manifest.id, gitSha: target.gitSha },
		label: options.label,
		baselineEvalRunId: options.baselineEvalRunId ?? null,
		provenance: provenanceAxes({
			runtime: target.runtime,
			model: modelAxes,
			eval: { suiteHash: target.suiteHash, datasetHash: target.datasetHash },
		}),
		provenanceKey: provenanceKey({
			runtime: target.runtime,
			model: modelAxes,
			eval: { suiteHash: target.suiteHash, datasetHash: target.datasetHash },
		}),
		suiteId: target.manifest.evalSuite.id,
		suiteHash: target.suiteHash,
		dataset: target.manifest.evalSuite.dataset.replace(/\.jsonl$/, "").split("/").pop() ?? "dataset",
		datasetHash: target.datasetHash,
		repetitions: options.repetitions,
		runIds,
		startedAt,
		finishedAt: new Date().toISOString(),
		summary: { total, pass, fail, error, allPassRate: total === 0 ? 0 : pass / total },
	};
	writeEvalRun(options.runsRoot, record);
	return record;
}

export function writeEvalRun(runsRoot: string, record: EvalRunRecord): void {
	mkdirSync(join(runsRoot, record.evalRunId), { recursive: true });
	writeFileSync(join(runsRoot, record.evalRunId, "eval_run.json"), `${JSON.stringify(record, null, "\t")}\n`);
}

export function loadEvalRun(runsRoot: string, evalRunId: string): EvalRunRecord {
	const path = join(runsRoot, evalRunId, "eval_run.json");
	return JSON.parse(readFileSync(path, "utf8")) as EvalRunRecord;
}

export function loadRun(runsRoot: string, runId: string): RunRecord {
	return JSON.parse(readFileSync(join(runsRoot, runId, "run.json"), "utf8")) as RunRecord;
}

export function listEvalRuns(runsRoot: string): EvalRunRecord[] {
	let entries: string[];
	try {
		entries = readdirSync(runsRoot);
	} catch {
		return [];
	}
	const records: EvalRunRecord[] = [];
	for (const entry of entries) {
		if (!entry.startsWith("erun_")) continue;
		try {
			records.push(loadEvalRun(runsRoot, entry));
		} catch {
			// skip corrupt
		}
	}
	return records.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/** Find the latest eval run whose provenance matches the given axes (baseline reuse). */
export function findReusableBaseline(runsRoot: string, axes: ProvenanceAxes, label = "baseline"): EvalRunRecord | null {
	for (const record of listEvalRuns(runsRoot)) {
		if (record.label !== label) continue;
		if (record.provenanceKey === "") continue;
		if (JSON.stringify(record.provenance) === JSON.stringify(axes)) return record;
	}
	return null;
}
