import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compareEvalRuns, type CompareResult } from "./compare.js";
import { findReusableBaseline, loadEvalRun, runSuite, type EvalRunRecord } from "./eval.js";
import { loadTarget, type ResolvedTask } from "./manifest.js";

/**
 * The improvement loop: candidate flow with meta-harness-style gates
 * (validate → smoke → suite), baseline reuse, compare, promote/reject.
 * Promote keeps the human gate: it is a separate command.
 */

function git(targetDir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", targetDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export interface CandidateFlowResult {
	branch: string;
	validateMs: number;
	smoke: EvalRunRecord | null;
	baseline: EvalRunRecord | null;
	candidate: EvalRunRecord;
	compare: CompareResult;
}

export interface CandidateFlowOptions {
	runsRoot: string;
	targetDir: string;
	/** Existing branch with the candidate changes; if omitted, HEAD is used. */
	branch?: string;
	/** Reuse an existing baseline eval run instead of running one (must match provenance). */
	baselineEvalRunId?: string;
	repetitions?: number;
	/** Dataset override (development/holdout split). */
	dataset?: string;
}

/** Prefer a cheap, tool-free task as the infrastructure smoke check. */
export function selectSmokeTaskId(tasks: ResolvedTask[]): string | undefined {
	return (
		tasks.find((task) => task.effectiveGraders.every((grader) => grader.type !== "tool_called" && grader.type !== "judge"))
			?.id ?? tasks[0]?.id
	);
}

/**
 * Evaluate a candidate branch: validate manifest (0 tokens), smoke (1 task),
 * full suite, reuse-or-run baseline, compare. Throws on gate failures.
 */
export async function runCandidateFlow(options: CandidateFlowOptions): Promise<CandidateFlowResult> {
	const targetDir = resolve(options.targetDir);

	// Gate 1: validate (zero tokens) — on the candidate branch content.
	if (options.branch) {
		const branchExists = git(targetDir, "branch", "--list", options.branch);
		if (!branchExists.includes(options.branch)) throw new Error(`branch not found: ${options.branch}`);
		git(targetDir, "checkout", options.branch);
	}
	const validateStart = Date.now();
	const target = loadTarget(targetDir, options.dataset ? { dataset: options.dataset } : undefined); // throws with a precise message on bad manifests
	const validateMs = Date.now() - validateStart;

	// Gate 2: smoke — one task, no token waste on a broken candidate.
	const smokeTaskId = selectSmokeTaskId(target.tasks);
	if (!smokeTaskId) throw new Error("suite has no tasks");
	const smoke = await runSuite(target, {
		runsRoot: options.runsRoot,
		label: "candidate",
		repetitions: 1,
		taskId: smokeTaskId,
	});
	const smokeBroken = smoke.runIds.some((id) => {
		const run = JSON.parse(readFileSync(join(options.runsRoot, id, "run.json"), "utf8")) as { status: string; error: string | null };
		return run.status !== "completed";
	});
	if (smokeBroken) throw new Error(`smoke gate failed on ${smokeTaskId}: candidate crashed (see ${smoke.evalRunId})`);

	// Gate 3: full suite on the candidate.
	const candidate = await runSuite(target, {
		runsRoot: options.runsRoot,
		label: "candidate",
		repetitions: options.repetitions ?? 1,
		candidateOf: null,
	});

	// Baseline: reuse if provenance matches, else run on the baseline ref.
	let baseline: EvalRunRecord | null = null;
	if (options.baselineEvalRunId) {
		baseline = loadEvalRun(options.runsRoot, options.baselineEvalRunId);
	} else {
		baseline = findReusableBaseline(options.runsRoot, candidate.provenance);
	}
	if (!baseline) {
		git(targetDir, "checkout", "-");
		const baselineTarget = loadTarget(targetDir, options.dataset ? { dataset: options.dataset } : undefined);
		baseline = await runSuite(baselineTarget, {
			runsRoot: options.runsRoot,
			label: "baseline",
			repetitions: options.repetitions ?? 1,
		});
		git(targetDir, "checkout", options.branch ?? "-");
	}

	const compare = compareEvalRuns(options.runsRoot, baseline.evalRunId, candidate.evalRunId);
	if (compare.error) throw new Error(compare.error);

	// Link the baseline into the candidate record for promote's audit trail.
	candidate.baselineEvalRunId = baseline.evalRunId;
	const candidatePath = join(options.runsRoot, candidate.evalRunId, "eval_run.json");
	const updated = JSON.stringify(candidate, null, "\t");
	const fs = await import("node:fs");
	fs.writeFileSync(candidatePath, `${updated}\n`);

	return { branch: options.branch ?? git(targetDir, "branch", "--show-current"), validateMs, smoke, baseline, candidate, compare };
}

// ---------- Promote / Reject ----------

export interface EvolutionEntry {
	ts: string;
	targetId: string;
	action: "promote" | "reject";
	version?: string;
	evalRunId: string;
	baselineEvalRunId?: string | null;
	gitSha: string;
	reason?: string;
	summary?: { pass: number; total: number };
}

function evolutionLogPath(): string {
	return process.env.AHDE_EVOLUTION_LOG
		? resolve(process.env.AHDE_EVOLUTION_LOG)
		: resolve(process.cwd(), "docs", "evolution.jsonl");
}

function appendEvolution(entry: EvolutionEntry): void {
	const path = evolutionLogPath();
	mkdirSync(join(path, ".."), { recursive: true });
	appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

export interface PromoteResult {
	tag: string;
	changedFiles: string[];
}

/**
 * Promote a candidate: annotate a git tag on the candidate commit and append
 * to the evolution log. Enforces comparability with its baseline and the
 * harness/eval separation (candidate must not touch evals/**).
 */
export function promote(options: {
	targetDir: string;
	evalRunId: string;
	version: string;
	runsRoot: string;
}): PromoteResult {
	const targetDir = resolve(options.targetDir);
	const evalRun = loadEvalRun(options.runsRoot, options.evalRunId);
	if (evalRun.label !== "candidate") {
		throw new Error(`eval run ${options.evalRunId} is labeled "${evalRun.label}", expected "candidate"`);
	}
	if (!evalRun.baselineEvalRunId) {
		throw new Error(`eval run ${options.evalRunId} has no linked baseline (run it through the candidate flow)`);
	}
	const baseline = loadEvalRun(options.runsRoot, evalRun.baselineEvalRunId);
	const compare = compareEvalRuns(options.runsRoot, baseline.evalRunId, evalRun.evalRunId);
	if (compare.error) throw new Error(compare.error);
	if (!/^[0-9a-f]{40}$/.test(baseline.target.gitSha) || !/^[0-9a-f]{40}$/.test(evalRun.target.gitSha)) {
		throw new Error("promote requires committed, clean baseline and candidate harness versions");
	}

	// Scope gate: the candidate diff must not touch the eval suite.
	const changed = git(targetDir, "diff", "--name-only", `${baseline.target.gitSha}..${evalRun.target.gitSha}`);
	const changedFiles = changed.split("\n").filter(Boolean);
	const evalFiles = changedFiles.filter((f) => f.startsWith("evals/"));
	if (evalFiles.length > 0) {
		throw new Error(`scope violation: candidate modifies eval suite files: ${evalFiles.join(", ")}`);
	}

	if (!/^\d+\.\d+\.\d+$/.test(options.version)) throw new Error(`invalid semver: ${options.version}`);
	const existingTags = git(targetDir, "tag", "--list", `v${options.version}`);
	if (existingTags) throw new Error(`tag v${options.version} already exists`);

	const tag = `v${options.version}`;
	const message = JSON.stringify({
		evalRunId: evalRun.evalRunId,
		baselineEvalRunId: baseline.evalRunId,
		baselineGitSha: baseline.target.gitSha,
		candidateGitSha: evalRun.target.gitSha,
		summary: `${evalRun.summary.pass}/${evalRun.summary.total} (baseline ${baseline.summary.pass}/${baseline.summary.total})`,
	});
	git(targetDir, "tag", "-a", tag, "-m", message, evalRun.target.gitSha);

	appendEvolution({
		ts: new Date().toISOString(),
		targetId: evalRun.target.id,
		action: "promote",
		version: options.version,
		evalRunId: evalRun.evalRunId,
		baselineEvalRunId: baseline.evalRunId,
		gitSha: evalRun.target.gitSha,
		summary: { pass: evalRun.summary.pass, total: evalRun.summary.total },
	});
	return { tag, changedFiles };
}

export function reject(options: { evalRunId: string; runsRoot: string; reason: string; targetId?: string }): void {
	const evalRun = loadEvalRun(options.runsRoot, options.evalRunId);
	appendEvolution({
		ts: new Date().toISOString(),
		targetId: options.targetId ?? evalRun.target.id,
		action: "reject",
		evalRunId: options.evalRunId,
		gitSha: evalRun.target.gitSha,
		reason: options.reason,
	});
}

export function readEvolutionLog(): EvolutionEntry[] {
	const path = evolutionLogPath();
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as EvolutionEntry);
}
