import { axisDifferences, sha256Hex } from "./provenance.js";
import { loadVerifiedEvalRun, type EvalRunRecord } from "./eval.js";
import type { RunRecord } from "./provenance.js";

export interface CompareResult {
	a: EvalRunRecord;
	b: EvalRunRecord;
	/** Per-task comparison rows (by taskId, averaged over repetitions). */
	rows: CompareRow[];
	status: "comparable" | "inconclusive" | "invalid";
	issues: string[];
	summary: CompareSummary;
	error: string | null;
}

export interface CompareSummary {
	taskCount: number;
	baselinePassRate: number;
	candidatePassRate: number;
	delta: number;
	confidence95: { low: number; high: number };
	improved: number;
	regressed: number;
	unchanged: number;
}

export interface CompareOptions {
	mode?: "candidate" | "aa-calibration" | "exploratory";
}

export interface CompareRow {
	taskId: string;
	aPassRate: number;
	bPassRate: number;
	delta: number;
	aStatus: string;
	bStatus: string;
	aPass: number;
	aTotal: number;
	bPass: number;
	bTotal: number;
}

function perTask(
	run: EvalRunRecord,
	records: readonly RunRecord[],
): { tasks: Map<string, { pass: number; total: number; status: string }>; readErrors: string[] } {
	const byTask = new Map<string, { pass: number; total: number; status: string }>();
	const readErrors: string[] = [];
	for (const record of records) {
		const entry = byTask.get(record.taskId) ?? { pass: 0, total: 0, status: record.status };
		entry.total += 1;
		if (record.evalResults?.outcome === "pass") entry.pass += 1;
		if (record.status === "error") entry.status = "error";
		byTask.set(record.taskId, entry);
	}
	return { tasks: byTask, readErrors };
}

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Deterministic paired bootstrap over tasks; repetitions stay inside each task aggregate. */
function bootstrap95(deltas: number[], seedText: string): { low: number; high: number } {
	if (deltas.length === 0) return { low: 0, high: 0 };
	if (deltas.length === 1) return { low: deltas[0] ?? 0, high: deltas[0] ?? 0 };
	let state = Number.parseInt(sha256Hex(seedText).slice(0, 8), 16) >>> 0;
	const random = (): number => {
		state += 0x6d2b79f5;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
	const samples: number[] = [];
	for (let sample = 0; sample < 5_000; sample += 1) {
		let total = 0;
		for (let index = 0; index < deltas.length; index += 1) {
			total += deltas[Math.floor(random() * deltas.length)] ?? 0;
		}
		samples.push(total / deltas.length);
	}
	samples.sort((a, b) => a - b);
	return {
		low: samples[Math.floor(samples.length * 0.025)] ?? 0,
		high: samples[Math.floor(samples.length * 0.975)] ?? 0,
	};
}

/**
 * Compare two eval runs. Refuses (error field) when provenance axes differ —
 * the guard is one call to axisDifferences, never a scattered field check.
 */
export function compareEvalRuns(
	runsRoot: string,
	aId: string,
	bId: string,
	options: CompareOptions = {},
): CompareResult {
	const aVerified = loadVerifiedEvalRun(runsRoot, aId);
	const bVerified = loadVerifiedEvalRun(runsRoot, bId);
	const a = aVerified.record;
	const b = bVerified.record;
	const mode = options.mode ?? "candidate";
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

	const aLoaded = perTask(a, aVerified.runs);
	const bLoaded = perTask(b, bVerified.runs);
	const aTasks = aLoaded.tasks;
	const bTasks = bLoaded.tasks;
	const taskIds = new Set([...aTasks.keys(), ...bTasks.keys()]);
	const rows: CompareRow[] = [];
	for (const taskId of taskIds) {
		const ae = aTasks.get(taskId);
		const be = bTasks.get(taskId);
		const aRate = ae && ae.total > 0 ? ae.pass / ae.total : 0;
		const bRate = be && be.total > 0 ? be.pass / be.total : 0;
		rows.push({
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
		});
	}
	rows.sort((x, y) => x.taskId.localeCompare(y.taskId));
	const aIds = [...aTasks.keys()].sort();
	const bIds = [...bTasks.keys()].sort();
	if (JSON.stringify(aIds) !== JSON.stringify(bIds)) invalid.push("task sets differ");
	for (const row of rows) {
		if (row.aTotal !== a.repetitions || row.bTotal !== b.repetitions) {
			invalid.push(
				`task ${row.taskId} has incomplete repetitions: ${row.aTotal}/${a.repetitions} vs ${row.bTotal}/${b.repetitions}`,
			);
		}
	}
	const infrastructure = [
		...aLoaded.readErrors.map((issue) => `baseline artifact ${issue}`),
		...bLoaded.readErrors.map((issue) => `candidate artifact ${issue}`),
		...rows.filter((row) => row.aStatus === "error").map((row) => `baseline task ${row.taskId} errored`),
		...rows.filter((row) => row.bStatus === "error").map((row) => `candidate task ${row.taskId} errored`),
	];
	const improved = rows.filter((row) => row.delta > 0).length;
	const regressed = rows.filter((row) => row.delta < 0).length;
	const deltas = rows.map((row) => row.delta);
	const summary: CompareSummary = {
		taskCount: rows.length,
		baselinePassRate: mean(rows.map((row) => row.aPassRate)),
		candidatePassRate: mean(rows.map((row) => row.bPassRate)),
		delta: mean(deltas),
		confidence95: bootstrap95(deltas, `${aId}:${bId}`),
		improved,
		regressed,
		unchanged: rows.length - improved - regressed,
	};
	const issues = [...invalid, ...infrastructure];
	const status = invalid.length > 0 ? "invalid" : infrastructure.length > 0 ? "inconclusive" : "comparable";
	const error = status === "comparable"
		? null
		: `${status === "invalid" ? "not comparable" : "inconclusive"}: ${issues.join("; ")} (baseline=${aId}, candidate=${bId})`;
	return { a, b, rows, status, issues, summary, error };
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
		"");
	lines.push(
		`- paired task delta: ${(result.summary.delta * 100).toFixed(1)}pp ` +
			`(95% bootstrap CI ${(result.summary.confidence95.low * 100).toFixed(1)}…${(result.summary.confidence95.high * 100).toFixed(1)}pp)`,
		"",
	);
	lines.push("| task | baseline | candidate | delta |", "|---|---|---|---|");
	for (const row of rows) {
		const fmt = (rate: number, status: string, pass: number, total: number) =>
			status === "missing" ? "—" : `${(rate * 100).toFixed(0)}% (${pass}/${total})${status === "error" ? " ⚠️" : ""}`;
		lines.push(
			`| ${row.taskId} | ${fmt(row.aPassRate, row.aStatus, row.aPass, row.aTotal)} | ${fmt(row.bPassRate, row.bStatus, row.bPass, row.bTotal)} | ${row.delta >= 0 ? "+" : ""}${(row.delta * 100).toFixed(0)}pp |`,
		);
	}
	const flakyNote = rows.some((r) => (r.aTotal > 1 || r.bTotal > 1) && r.delta !== 0 && ((r.aPass > 0 && r.aPass < r.aTotal) || (r.bPass > 0 && r.bPass < r.bTotal)))
		? " Часть задач проходит не во всех повторениях (flaky) — регрессии по таким задачам могут быть шумом."
		: "";
	lines.push("", `**${result.summary.improved} improved, ${result.summary.regressed} regressed, ${result.summary.unchanged} unchanged.**${flakyNote}`);
	return lines.join("\n");
}
