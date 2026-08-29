import { axisDifferences } from "./provenance.js";
import { loadVerifiedEvalRun, type EvalRunRecord, type VerifiedEvalRun } from "./eval.js";
import type { RunRecord } from "./provenance.js";
import type { ExperimentMode } from "./domain/candidate.js";
import {
	compareUtf8,
	formatPoints,
	judgeComparison,
	type CompareRow,
	type CompareSummary,
	type ComparisonDesign,
	type ComparisonFlags,
	type GateDecision,
	type GateSurface,
} from "./domain/comparison-gate.js";

export type { CompareRow, CompareSummary } from "./domain/comparison-gate.js";

export interface CompareResult {
	a: EvalRunRecord;
	b: EvalRunRecord;
	/** Per-task comparison rows (by taskId, averaged over repetitions). */
	rows: CompareRow[];
	status: "comparable" | "inconclusive" | "invalid";
	issues: string[];
	summary: CompareSummary;
	design: ComparisonDesign;
	flags: ComparisonFlags;
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

function perTask(records: readonly RunRecord[]): Map<string, { pass: number; total: number; status: string }> {
	const byTask = new Map<string, { pass: number; total: number; status: string }>();
	for (const record of records) {
		const entry = byTask.get(record.taskId) ?? { pass: 0, total: 0, status: record.status };
		entry.total += 1;
		if (record.evalResults?.outcome === "pass") entry.pass += 1;
		if (record.status === "error") entry.status = "error";
		byTask.set(record.taskId, entry);
	}
	return byTask;
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

	const aTasks = perTask(aVerified.runs);
	const bTasks = perTask(bVerified.runs);
	const taskIds = [...new Set([...aTasks.keys(), ...bTasks.keys()])].sort(compareUtf8);
	const rows: CompareRow[] = taskIds.map((taskId) => {
		const ae = aTasks.get(taskId);
		const be = bTasks.get(taskId);
		const aRate = ae && ae.total > 0 ? ae.pass / ae.total : 0;
		const bRate = be && be.total > 0 ? be.pass / be.total : 0;
		return {
			taskId,
			aPassRate: aRate,
			bPassRate: bRate,
			delta: bRate - aRate,
			aStatus: ae?.status ?? "missing",
			bStatus: be?.status ?? "missing",
			aPass: ae?.pass ?? 0,
			aTotal: ae?.total ?? 0,
			bPass: be?.pass ?? 0,
			bTotal: be?.total ?? 0,
		};
	});
	const aIds = [...aTasks.keys()].sort(compareUtf8);
	const bIds = [...bTasks.keys()].sort(compareUtf8);
	if (JSON.stringify(aIds) !== JSON.stringify(bIds)) invalid.push("task sets differ");
	for (const row of rows) {
		if (row.aTotal !== a.repetitions || row.bTotal !== b.repetitions) {
			invalid.push(
				`task ${row.taskId} has incomplete repetitions: ${row.aTotal}/${a.repetitions} vs ${row.bTotal}/${b.repetitions}`,
			);
		}
	}
	const infrastructure = [
		...rows.filter((row) => row.aStatus === "error").map((row) => `baseline task ${row.taskId} errored`),
		...rows.filter((row) => row.bStatus === "error").map((row) => `candidate task ${row.taskId} errored`),
	];
	const statistics = judgeComparison(rows, {
		surface: options.surface ?? "development",
		repetitions: a.repetitions,
		seed: `${a.evalRunId}:${b.evalRunId}`,
		...(options.resamples !== undefined ? { resamples: options.resamples } : {}),
	});
	const issues = [...invalid, ...infrastructure];
	const status = invalid.length > 0 ? "invalid" : infrastructure.length > 0 ? "inconclusive" : "comparable";
	const error = status === "comparable"
		? null
		: `${status === "invalid" ? "not comparable" : "inconclusive"}: ${issues.join("; ")} (baseline=${a.evalRunId}, candidate=${b.evalRunId})`;
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

export function renderGateLine(result: Pick<CompareResult, "gate" | "summary" | "design">): string {
	const { gate, summary, design } = result;
	return `${gate.surface} verdict: ${gate.verdict} — ${formatPoints(summary.delta)} ` +
		`(95% CI ${formatPoints(summary.confidence95.low)} … ${formatPoints(summary.confidence95.high)}) ` +
		`on ${design.tasks} tasks × ${design.repetitions} repetitions` +
		(design.excludedTasks > 0 ? `, ${design.excludedTasks} excluded` : "");
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
		`- all-pass rate: ${(a.summary.allPassRate * 100).toFixed(0)}% (${a.summary.pass}/${a.summary.total}) → ${(b.summary.allPassRate * 100).toFixed(0)}% (${b.summary.pass}/${b.summary.total})`,
	);
	lines.push(`- ${renderGateLine(result)}`);
	for (const reason of result.gate.reasons) lines.push(`  - ${reason}`);
	lines.push("");
	lines.push("| task | baseline | candidate | delta |", "|---|---|---|---|");
	for (const row of rows) {
		const fmt = (rate: number, status: string, pass: number, total: number) =>
			status === "missing" ? "—" : `${(rate * 100).toFixed(0)}% (${pass}/${total})${status === "error" ? " ⚠️" : ""}`;
		lines.push(
			`| ${row.taskId} | ${fmt(row.aPassRate, row.aStatus, row.aPass, row.aTotal)} | ${fmt(row.bPassRate, row.bStatus, row.bPass, row.bTotal)} | ${row.delta >= 0 ? "+" : ""}${(row.delta * 100).toFixed(0)}pp |`,
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
