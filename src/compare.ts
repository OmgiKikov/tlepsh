import { axisDifferences } from "./provenance.js";
import { loadEvalRun, loadRun, type EvalRunRecord } from "./eval.js";
import type { RunRecord } from "./provenance.js";

export interface CompareResult {
	a: EvalRunRecord;
	b: EvalRunRecord;
	/** Per-task comparison rows (by taskId, averaged over repetitions). */
	rows: CompareRow[];
	error: string | null;
}

export interface CompareRow {
	taskId: string;
	aPassRate: number;
	bPassRate: number;
	delta: number;
	aStatus: string;
	bStatus: string;
}

function perTask(run: EvalRunRecord, runsRoot: string): Map<string, { pass: number; total: number; status: string }> {
	const byTask = new Map<string, { pass: number; total: number; status: string }>();
	for (const runId of run.runIds) {
		let record: RunRecord;
		try {
			record = loadRun(runsRoot, runId);
		} catch {
			continue;
		}
		const entry = byTask.get(record.taskId) ?? { pass: 0, total: 0, status: record.status };
		entry.total += 1;
		if (record.evalResults?.outcome === "pass") entry.pass += 1;
		if (record.status === "error") entry.status = "error";
		byTask.set(record.taskId, entry);
	}
	return byTask;
}

/**
 * Compare two eval runs. Refuses (error field) when provenance axes differ —
 * the guard is one call to axisDifferences, never a scattered field check.
 */
export function compareEvalRuns(runsRoot: string, aId: string, bId: string): CompareResult {
	const a = loadEvalRun(runsRoot, aId);
	const b = loadEvalRun(runsRoot, bId);
	const diffs = axisDifferences(a.provenance, b.provenance);
	const error =
		diffs.length > 0
			? `not comparable: differing axes: ${diffs.join(", ")} (baseline=${aId}, candidate=${bId})`
			: null;

	const aTasks = perTask(a, runsRoot);
	const bTasks = perTask(b, runsRoot);
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
		});
	}
	rows.sort((x, y) => x.taskId.localeCompare(y.taskId));
	return { a, b, rows, error };
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
	lines.push("| task | baseline | candidate | delta |", "|---|---|---|---|");
	for (const row of rows) {
		const fmt = (rate: number, status: string) => (status === "missing" ? "—" : `${(rate * 100).toFixed(0)}%${status === "error" ? " ⚠️" : ""}`);
		lines.push(`| ${row.taskId} | ${fmt(row.aPassRate, row.aStatus)} | ${fmt(row.bPassRate, row.bStatus)} | ${row.delta >= 0 ? "+" : ""}${(row.delta * 100).toFixed(0)}pp |`);
	}
	const improved = rows.filter((r) => r.delta > 0).length;
	const regressed = rows.filter((r) => r.delta < 0).length;
	lines.push("", `**${improved} improved, ${regressed} regressed, ${rows.length - improved - regressed} unchanged.**`);
	return lines.join("\n");
}
