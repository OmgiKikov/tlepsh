import { interval, percent } from "./measurement.js";
import { axisDifferences, hasKnownCommandUsageSemantics } from "./provenance.js";
import { loadVerifiedEvalRun, type EvalRunRecord, type VerifiedEvalRun } from "./eval.js";
import type { RunRecord, TokenMetrics } from "./provenance.js";
import type { ExperimentMode } from "./domain/candidate.js";
import { oneLine } from "./builder/render/format.js";
import {
	compareUtf8,
	comparisonPowered,
	formatPoints,
	formatResourceFragment,
	gatePolicyFor,
	judgeComparison,
	resourceTotals,
	type CompareRow,
	type CompareSummary,
	type ComparisonDesign,
	type ComparisonFlags,
	type ComparisonResources,
	type ExcludedTask,
	type GateDecision,
	type GateSurface,
} from "./domain/comparison-gate.js";

export type { CompareRow, CompareSummary, ExcludedTask } from "./domain/comparison-gate.js";

/** One-line renderings live in a 110-column budget shared with the TUI header. */
const GATE_LINE_WIDTH = 110;

export interface CompareResult {
	a: EvalRunRecord;
	b: EvalRunRecord;
	/** Per-task comparison rows (by taskId, averaged over repetitions). */
	rows: CompareRow[];
	status: "comparable" | "inconclusive" | "invalid";
	issues: string[];
	/**
	 * Tasks left out of the paired statistics, named with the reason and the
	 * arm that lost them. One errored repetition costs its task, never the
	 * whole verification: the comparison stays `comparable` while the excluded
	 * share is inside the gate's infrastructure budget and the remaining design
	 * still meets the surface's policy.
	 */
	excluded: ExcludedTask[];
	summary: CompareSummary;
	design: ComparisonDesign;
	flags: ComparisonFlags;
	/** Cost/latency/token ratios of the pair. Rendered beside the verdict, never gating. */
	resources: ComparisonResources;
	/** The one gate decision for the requested surface. */
	gate: GateDecision;
	error: string | null;
}

export interface CompareOptions {
	/** `exploratory` skips candidate linkage rules; never promotion-grade. */
	mode: ExperimentMode | "exploratory";
	/** Which gate policy judges the rows. Defaults to development. */
	surface?: GateSurface;
	/** Bootstrap resamples; tests may lower it. */
	resamples?: number;
}

/**
 * Partial credit for one run: the mean of its grader scores, clamped to [0,1].
 * A run with no graders — an error, or evidence written before graders carried
 * a score — keeps the binary handling so pass rate and score coincide.
 *
 * This is the quantity the gate policy pairs per task, so it is exported: every
 * surface that ranks or selects a run by "how well it scored" — the comparison
 * here, the training export's `--min-score` bar — must mean the same number.
 */
export function runGraderScore(record: {
	evalResults?: {
		graders: readonly { passed: boolean; score: number; checkCode?: string | null }[];
		outcome: string;
	} | null;
}): number {
	const results = record.evalResults?.graders ?? [];
	// Completion is a prerequisite, not a free point that dilutes the rubric.
	if (results.some((grader) => grader.checkCode === "final-answer" && !grader.passed)) return 0;
	const graders = results.filter((grader) => grader.checkCode !== "final-answer");
	if (graders.length === 0) return record.evalResults?.outcome === "pass" ? 1 : 0;
	const average = graders.reduce((sum, grader) => sum + grader.score, 0) / graders.length;
	return Math.min(1, Math.max(0, average));
}

interface TaskAggregate {
	pass: number;
	score: number;
	total: number;
	errors: number;
	status: string;
}

/**
 * The three fields a per-task aggregate reads. Narrower than a whole
 * RunRecord so a reader — and a test — can hand over what it actually has.
 */
export type TaskRun = Pick<RunRecord, "taskId" | "status" | "evalResults">;

function perTask(records: readonly TaskRun[]): Map<string, TaskAggregate> {
	const byTask = new Map<string, TaskAggregate>();
	for (const record of records) {
		const entry = byTask.get(record.taskId) ?? { pass: 0, score: 0, total: 0, errors: 0, status: record.status };
		entry.total += 1;
		// An errored repetition never counts as a pass. The run stopped before
		// grading; whatever outcome the record carries is the harness's, not the
		// agent's, and counting it would put a task the engine lost into the
		// column that says the agent got it right every time.
		if (record.status === "error") entry.errors += 1;
		else if (record.evalResults?.outcome === "pass") entry.pass += 1;
		entry.score += runGraderScore(record);
		if (record.status === "error") entry.status = "error";
		byTask.set(record.taskId, entry);
	}
	return byTask;
}

/**
 * How many of an eval run's cases the agent got right in EVERY repetition, and
 * how many cases were measured at all.
 *
 * Read at display time off the same aggregate the comparison pairs — no
 * EvalRun field, nothing durable. `3/3` is a different fact from `60% passed`:
 * a basket where every case passes two of three repetitions and a basket where
 * two thirds of the cases pass all three print the same pass rate and mean
 * very different things, and only this number separates them. An errored
 * repetition is never a pass, so a case the engine lost is never `3/3`.
 *
 * With one repetition the answer is arithmetically the pass count and says
 * nothing about repetition at all; the renderer says so rather than claiming
 * it did.
 */
export interface StableTasks {
	/** Cases that passed in every repetition. */
	stable: number;
	/** Cases with at least one recorded repetition. */
	measured: number;
	/** Passes over repetitions, per case, in task-id order. */
	perTask: { taskId: string; pass: number; total: number }[];
}

export function stableTasks(records: readonly TaskRun[]): StableTasks {
	const byTask = perTask(records);
	const ids = [...byTask.keys()].sort(compareUtf8);
	const rows = ids.map((taskId) => {
		const entry = byTask.get(taskId)!;
		return { taskId, pass: entry.pass, total: entry.total };
	});
	return {
		stable: rows.filter((row) => row.total > 0 && row.pass === row.total).length,
		measured: rows.length,
		perTask: rows,
	};
}

/**
 * What the Target reported spending, or null when it reported nothing.
 *
 * A command Target may send no `usage` at all, and the answer to "what did it
 * cost" is then "it did not say" — not "nothing". Every reader goes through
 * these two so no projection can turn an absence into a zero on the way to a
 * human, and so a renderer has something to draw a dash for.
 */
export function runTokens(record: Pick<RunRecord, "metrics">): TokenMetrics | null {
	return record.metrics.tokens ?? null;
}

export function runCost(record: Pick<RunRecord, "metrics">): number | null {
	return record.metrics.costUsd ?? null;
}

/** Total spend is unknown if the Target did not report its own contribution. */
export function runTotalCost(record: Pick<RunRecord, "metrics">): number | null {
	const target = runCost(record);
	if (target === null) return null;
	return target + (record.metrics.judge?.costUsd ?? 0) + (record.metrics.simulatedUser?.costUsd ?? 0);
}

/**
 * Cost, latency and token aggregate of one arm. Cost is what the arm actually
 * spent — the Target's tokens, the judge calls that graded them, and the user
 * model that held up the other end of a simulated conversation — so a
 * judge-graded comparison on a free local Target still reports its real money,
 * and the ratio beside the verdict matches what the cost guard estimates.
 */
function armResources(records: readonly RunRecord[]) {
	return resourceTotals(records.map((record) => ({
		costUsd: runTotalCost(record),
		latencyMs: record.metrics.latencyMs,
		tokens: runTokens(record)?.total ?? null,
	})));
}

/** Canonical task pairing shared by harness comparisons and explicit model experiments. */
export function pairedComparisonRows(aRuns: readonly TaskRun[], bRuns: readonly TaskRun[]): CompareRow[] {
	const aTasks = perTask(aRuns);
	const bTasks = perTask(bRuns);
	const taskIds = [...new Set([...aTasks.keys(), ...bTasks.keys()])].sort(compareUtf8);
	const rows: CompareRow[] = taskIds.map((taskId) => {
		const ae = aTasks.get(taskId);
		const be = bTasks.get(taskId);
		const aRate = ae && ae.total > 0 ? ae.pass / ae.total : 0;
		const bRate = be && be.total > 0 ? be.pass / be.total : 0;
		const aScore = ae && ae.total > 0 ? ae.score / ae.total : 0;
		const bScore = be && be.total > 0 ? be.score / be.total : 0;
		return {
			taskId,
			aPassRate: aRate,
			bPassRate: bRate,
			delta: bRate - aRate,
			aScore,
			bScore,
			scoreDelta: bScore - aScore,
			aStatus: ae?.status ?? "missing",
			bStatus: be?.status ?? "missing",
			aPass: ae?.pass ?? 0,
			aTotal: ae?.total ?? 0,
			bPass: be?.pass ?? 0,
			bTotal: be?.total ?? 0,
		};
	});
	return rows;
}

/**
 * Compare two already-verified eval runs. Refuses (error field) when
 * provenance axes differ — the guard is one call to axisDifferences, never a
 * scattered field check. Statistics and the verdict come from the gate module.
 */
export function compareVerifiedEvalRuns(
	aVerified: VerifiedEvalRun,
	bVerified: VerifiedEvalRun,
	options: CompareOptions,
): CompareResult {
	const a = aVerified.record;
	const b = bVerified.record;
	const mode = options.mode;
	const invalid: string[] = [];
	for (const [role, record] of [["baseline", a], ["candidate", b]] as const) {
		if (!hasKnownCommandUsageSemantics(record.provenance.execution)) {
			invalid.push(`${role} eval ${record.evalRunId} has unversioned command usage semantics; rerun it`);
		}
	}
	// A screen is a one-repetition, candidate-only re-run of what already failed.
	// Reading it beside a baseline would dress a screen up as a measurement, so
	// every comparison but the explicitly exploratory one refuses it — from the
	// record's own `purpose`, with no sidecar in the path.
	if (mode !== "exploratory") {
		for (const [role, record] of [["baseline", a], ["candidate", b]] as const) {
			if (record.purpose !== "evidence") {
				invalid.push(record.purpose === "screen"
					? `${role} eval ${record.evalRunId} is a cheap-check screen, which is never evidence`
					: record.purpose === "model-experiment"
					? `${role} eval ${record.evalRunId} is a model experiment, never promotion evidence`
					: `${role} eval ${record.evalRunId} predates first-class run purpose and is ambiguous one-arm evidence; rerun it`);
			}
		}
	}
	const diffs = axisDifferences(a.provenance, b.provenance);
	if (diffs.length > 0) invalid.push(`differing axes: ${diffs.join(", ")}`);
	if (a.target.id !== b.target.id) invalid.push(`different targets: ${a.target.id} vs ${b.target.id}`);
	if (a.repetitions !== b.repetitions) invalid.push(`different repetitions: ${a.repetitions} vs ${b.repetitions}`);
	if (mode === "candidate" && (a.label !== "baseline" || b.label !== "candidate")) {
		invalid.push(`candidate comparison requires baseline → candidate labels, got ${a.label} → ${b.label}`);
	}
	if (mode === "candidate" && a.target.gitSha === b.target.gitSha) {
		invalid.push(`baseline and candidate resolve to the same revision ${a.target.gitSha}`);
	}
	if ((mode === "candidate" || mode === "aa-calibration") && (!aVerified.hasRunHashes || !bVerified.hasRunHashes)) {
		invalid.push("promotion-grade comparison requires final run artifact hashes");
	}
	if ((mode === "candidate" || mode === "aa-calibration") && b.baselineEvalRunId !== a.evalRunId) {
		invalid.push(`candidate eval ${b.evalRunId} is not linked to baseline eval ${a.evalRunId}`);
	}
	if (
		(mode === "candidate" || mode === "aa-calibration") &&
		bVerified.runs.some((run) => run.parent?.candidateOf !== a.target.gitSha)
	) {
		invalid.push("candidate RunRecords do not point to the exact baseline target revision");
	}
	if (mode === "aa-calibration" && a.target.gitSha !== b.target.gitSha) {
		invalid.push("A/A calibration requires the same target revision");
	}

	const rows = pairedComparisonRows(aVerified.runs, bVerified.runs);
	const aIds = [...new Set(aVerified.runs.map((run) => run.taskId))].sort(compareUtf8);
	const bIds = [...new Set(bVerified.runs.map((run) => run.taskId))].sort(compareUtf8);
	if (JSON.stringify(aIds) !== JSON.stringify(bIds)) invalid.push("task sets differ");
	const surface = options.surface ?? "development";
	const statistics = judgeComparison(rows, {
		surface,
		repetitions: a.repetitions,
		seed: `${a.evalRunId}:${b.evalRunId}`,
		resources: { baseline: armResources(aVerified.runs), candidate: armResources(bVerified.runs) },
		...(options.resamples !== undefined ? { resamples: options.resamples } : {}),
	});
	// One lost repetition costs its task, not the run. The gate has always
	// declared a 10% infrastructure budget and excluded the tasks that spend
	// it; this used to declare every one of them fatal before the budget was
	// ever consulted, and two live verifications of 150 executions each were
	// thrown away over an error rate of 2.7% with the difference already
	// visible in the rows. The excluded tasks are named on the result, the
	// remaining ones are paired, and the surface is `comparable` for exactly as
	// long as its own policy says the design still carries a verdict.
	const armName = { baseline: "baseline", candidate: "candidate", both: "baseline and candidate" } as const;
	const excluded = statistics.excluded.map((task) => {
		const row = rows.find((candidate) => candidate.taskId === task.taskId);
		return task.reason === "infrastructure"
			? `${armName[task.arm]} task ${task.taskId} errored`
			: `task ${task.taskId} has incomplete repetitions: ${row?.aTotal ?? 0}/${a.repetitions} vs ${row?.bTotal ?? 0}/${b.repetitions}`;
	});
	const issues = [...invalid, ...excluded];
	const status = invalid.length > 0
		? "invalid"
		: comparisonPowered(gatePolicyFor(surface), statistics.design) ? "comparable" : "inconclusive";
	// An inconclusive surface always says why: the excluded tasks when there
	// are any, and otherwise the gate's own sentence about the design.
	const reasons = issues.length > 0 ? issues : statistics.gate.reasons;
	const error = status === "comparable"
		? null
		: `${status === "invalid" ? "not comparable" : "inconclusive"}: ${reasons.join("; ")} (baseline=${a.evalRunId}, candidate=${b.evalRunId})`;
	return { a, b, rows, status, issues, ...statistics, error };
}

/** Load, verify, and compare two eval runs by id. CLI, report, and experiment entry point. */
export function compareEvalRuns(
	runsRoot: string,
	aId: string,
	bId: string,
	options: CompareOptions,
): CompareResult {
	return compareVerifiedEvalRuns(loadVerifiedEvalRun(runsRoot, aId), loadVerifiedEvalRun(runsRoot, bId), options);
}

export function renderGateLine(
	result: Pick<CompareResult, "gate" | "summary" | "design"> & Partial<Pick<CompareResult, "resources">>,
): string {
	const { gate, summary, design } = result;
	const fragment = formatResourceFragment(result.resources);
	// The score delta is what the interval brackets and the gate decided on;
	// the pass rate sits on its own line so this one keeps its 110-column budget.
	return oneLine(
		`${gate.surface} verdict: ${gate.verdict} — ${formatPoints(summary.scoreDelta)} ` +
			`(${interval(summary.confidence95.low, summary.confidence95.high, { form: "machine" })}) ` +
			// The exclusions come before the resource ratios: the line is cut to
			// 110 columns, and how many cases the number was measured on belongs
			// to the number, while cost and latency never gated anything.
			`on ${design.tasks} × ${design.repetitions}` +
			(design.excludedTasks > 0 ? ` · ${design.excludedTasks} excluded` : "") +
			(fragment ? ` · ${fragment}` : ""),
		GATE_LINE_WIDTH,
	);
}

export function renderCompareMarkdown(result: CompareResult): string {
	const { a, b, rows } = result;
	const lines: string[] = [];
	lines.push(`# Compare: ${a.label} ${a.evalRunId} vs ${b.label} ${b.evalRunId}`, "");
	if (result.error) {
		lines.push(`## ⛔ Not comparable`, "", result.error, "");
		lines.push(`| axis | ${a.evalRunId} | ${b.evalRunId} |`, "|---|---|---|");
		const keys = new Set([...Object.keys(a.provenance), ...Object.keys(b.provenance)]);
		for (const key of keys) {
			const av = JSON.stringify(a.provenance[key as keyof typeof a.provenance]);
			const bv = JSON.stringify(b.provenance[key as keyof typeof b.provenance]);
			if (av !== bv) lines.push(`| ${key} | ${av} | ${bv} |`);
		}
		lines.push("");
		return lines.join("\n");
	}
	lines.push(`- target: ${a.target.id} (${a.target.gitSha.slice(0, 8)} → ${b.target.gitSha.slice(0, 8)})`);
	lines.push(`- suite: ${a.suiteId} (${a.datasetHash.slice(0, 16)}…)`);
	lines.push(
		`- all-pass rate: ${percent(a.summary.allPassRate)} (${a.summary.pass}/${a.summary.total}) → ${percent(b.summary.allPassRate)} (${b.summary.pass}/${b.summary.total})`,
	);
	lines.push(
		`- mean score: ${percent(result.summary.baselineScore, { digits: 1 })} → ${percent(result.summary.candidateScore, { digits: 1 })} ` +
			`(${formatPoints(result.summary.scoreDelta)}) · pass rate ${formatPoints(result.summary.delta)}`,
	);
	const resourceFragment = formatResourceFragment(result.resources, { tokens: true });
	if (resourceFragment) {
		const cost = (usd: number | null): string => usd === null ? "unknown" : `$${usd.toFixed(4)}`;
		lines.push(
			`- resources: ${resourceFragment} ` +
				`(baseline ${cost(result.resources.baseline.costUsd)} · ${result.resources.baseline.meanLatencyMs.toFixed(0)}ms/run, ` +
				`candidate ${cost(result.resources.candidate.costUsd)} · ${result.resources.candidate.meanLatencyMs.toFixed(0)}ms/run) — never gating`,
		);
	}
	lines.push(`- ${renderGateLine(result)}`);
	for (const reason of result.gate.reasons) lines.push(`  - ${reason}`);
	lines.push("");
	lines.push("| task | baseline | candidate | score | delta |", "|---|---|---|---|---|");
	for (const row of rows) {
		const fmt = (rate: number, status: string, pass: number, total: number) =>
			status === "missing" ? "—" : `${percent(rate)} (${pass}/${total})${status === "error" ? " ⚠️" : ""}`;
		lines.push(
			`| ${row.taskId} | ${fmt(row.aPassRate, row.aStatus, row.aPass, row.aTotal)} | ${fmt(row.bPassRate, row.bStatus, row.bPass, row.bTotal)} ` +
				`| ${percent(row.aScore)} → ${percent(row.bScore)} | ${formatPoints(row.scoreDelta)} |`,
		);
	}
	const flags = result.flags;
	lines.push(
		"",
		`**${result.summary.improved} improved, ${result.summary.regressed} regressed, ${result.summary.unchanged} unchanged.**` +
			(flags.collapsedTasks > 0 ? ` ${flags.collapsedTasks} task(s) collapsed from always-pass to never-pass.` : "") +
			" Per-task flips are flags for review; the verdict above comes only from the paired interval.",
	);
	return lines.join("\n");
}
