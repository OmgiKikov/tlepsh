import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { graderName, type ResolvedTarget, type ResolvedTask } from "./manifest.js";
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

/** Grade one completed run against its task's effective graders. */
export function gradeRun(task: ResolvedTask, record: RunRecord, runsRoot: string): GraderResult[] {
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
	return task.effectiveGraders.map((spec, index) => {
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
		} else {
			result = gradeOutputMatches(spec, output ?? "");
		}
		return { ...result, name: graderName(spec, task, index) };
	});
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
			const graders = gradeRun(task, record, options.runsRoot);
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
