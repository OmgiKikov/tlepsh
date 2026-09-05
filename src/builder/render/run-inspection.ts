import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { t } from "../../i18n.js";
import type { WorkbenchRunInspection } from "../../workbench/run-inspection.js";
import type { Paint } from "./paint.js";
import { renderRunReadingLines } from "./run-reading.js";

export const MAX_RUN_INSPECTION_LINES = 160;

/** A focused reading of the same bounded observable facts the model received. */
export function renderRunInspection(run: WorkbenchRunInspection, paint: Paint): string[] {
	const lines = [
		`${paint.heading(t("trace.run"))} ${run.taskId}#${run.repetitionIndex} · ${run.outcome} · ${paint.dim(run.runId)}`,
		paint.dim(t("trace.inspection-limits")),
		...(run.reading ? renderRunReadingLines(run.reading, paint) : []),
		paint.heading(t("trace.verdict")),
	];
	const body = (text: string): string[] => wrapTextWithAnsi(text, 96).map((line) => `  ${line}`);
	if (run.checks.length === 0) lines.push(paint.dim(t("trace.noGraders")));
	for (const check of run.checks) {
		lines.push(`${check.passed ? paint.success("✓") : paint.error("✗")} ${check.name} (${check.type})`, ...body(check.reason));
	}
	lines.push("", paint.heading(t("trace.conversation")));
	if (run.transcript === null) lines.push(paint.warning(t("trace.inspection-unavailable")));
	for (const entry of run.transcript?.entries ?? []) {
		if (entry.kind === "tool") {
			const status = entry.evidence === "reported" ? t("trace.tool-reported")
				: entry.result === null ? t("trace.no-result") : entry.isError ? t("trace.errored") : t("trace.tool-ok");
			lines.push(paint.bold(`→ ${entry.name} · ${status}`), ...body(entry.args));
			if (entry.result !== null) lines.push(...body(entry.result));
		} else {
			lines.push(paint.bold(t(entry.kind === "user" ? "trace.user" : entry.final ? "trace.finalAnswer" : "trace.agent")), ...body(entry.text));
		}
	}
	if (run.transcript?.truncated || run.limitations.omittedChecks || run.limitations.checkTextClipped) {
		lines.push(paint.warning(t("trace.inspection-clipped", { entries: run.transcript?.omittedCount ?? 0, checks: run.limitations.omittedChecks })));
	}
	if (lines.length > MAX_RUN_INSPECTION_LINES) {
		const kept = lines.slice(0, MAX_RUN_INSPECTION_LINES - 1);
		kept.push(paint.warning(t("trace.omitted", { n: lines.length - kept.length, run: run.runId })));
		return kept;
	}
	return lines;
}
