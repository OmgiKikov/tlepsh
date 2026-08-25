import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEvalRun, loadRun, type EvalRunRecord } from "./eval.js";
import { loadTarget, type ResolvedTarget } from "./manifest.js";
import { openTrace, renderTraceMarkdown } from "./trace.js";

/**
 * Failure bundle compiler: the single interface between the platform and the
 * Builder. Turns failed runs into a self-contained markdown task.
 */

export interface BundleOptions {
	/** Where to write the bundle. Default: runs/<evalRunId>/bundle.md */
	outPath?: string;
}

export function compileFailureBundle(
	target: ResolvedTarget,
	evalRun: EvalRunRecord,
	runsRoot: string,
	options: BundleOptions = {},
): string {
	const lines: string[] = [];
	const failedRunIds = evalRun.runIds.filter((runId) => {
		try {
			const run = loadRun(runsRoot, runId);
			return run.status !== "completed" || run.evalResults?.outcome !== "pass";
		} catch {
			return true;
		}
	});

	lines.push(`# Failure Bundle — ${target.manifest.id}`, "");
	lines.push(`- eval run: \`${evalRun.evalRunId}\` (${evalRun.label})`);
	lines.push(`- target harness: ${target.gitSha.slice(0, 12)} (repo: ${target.dir})`);
	lines.push(
		`- suite: ${evalRun.suiteId} dataset=${evalRun.dataset} (${evalRun.datasetHash.slice(7, 19)}…, suite ${evalRun.suiteHash.slice(7, 19)}…)`,
	);
	lines.push(
		`- baseline metrics: ${evalRun.summary.pass}/${evalRun.summary.total} all-pass (${evalRun.summary.fail} fail, ${evalRun.summary.error} error)`,
	);
	lines.push(`- failed tasks: ${failedRunIds.length}`);
	lines.push("");
	lines.push("## Allowed change scope", "");
	lines.push(
		`Improve the target harness ONLY: \`AGENTS.md\`, \`skills/**\`, \`bin/**\`. ` +
			"Do NOT touch \`evals/**\` (grading must stay fixed) or \`manifest.yaml\` model settings. " +
			"Commit your changes on a git branch.",
	);
	lines.push("");

	for (const runId of failedRunIds) {
		let run;
		try {
			run = loadRun(runsRoot, runId);
		} catch {
			continue;
		}
		const task = target.tasks.find((t) => t.id === run.taskId);
		lines.push(`---`, "", `## Failed task: ${run.taskId}${task ? ` (repetition ${run.repetitionIndex})` : ""}`, "");
		if (task) {
			lines.push("### Task input", "", "```", task.input, "```", "");
		}
		if (run.status !== "completed") {
			lines.push(`### ⚠️ Run error`, "", `\`${run.error ?? run.status}\``, "");
		}
		if (run.evalResults) {
			lines.push("### Grader results", "");
			for (const grader of run.evalResults.graders) {
				const mark = grader.passed ? "✅" : "❌";
				lines.push(`- ${mark} **${grader.name}** — ${grader.reason}`);
			}
			lines.push("");
		}
		if (run.status === "completed" && run.trace.path) {
			try {
				const messages = openTrace(join(runsRoot, run.runId), run.trace.path);
				lines.push("### Execution trace", "", renderTraceMarkdown(messages), "");
			} catch {
				lines.push("_(trace unavailable)_", "");
			}
		}
	}

	lines.push("---", "", "## Appendix: current harness files", "");
	lines.push("### AGENTS.md", "", "```markdown", readFileSync(join(target.dir, target.manifest.instructions.agentsMd), "utf8"), "```", "");
	for (const skill of target.manifest.skills) {
		const skillMd = readFileSync(join(target.dir, skill, "SKILL.md"), "utf8");
		lines.push(`### ${skill}/SKILL.md`, "", "```markdown", skillMd, "```", "");
	}

	const bundle = lines.join("\n");
	const outPath = options.outPath ?? join(runsRoot, evalRun.evalRunId, "bundle.md");
	writeFileSync(outPath, bundle);
	return outPath;
}

export function compileBundleForEvalRun(targetDir: string, evalRunId: string, runsRoot: string, options: BundleOptions = {}): string {
	const evalRun = loadEvalRun(runsRoot, evalRunId);
	if (evalRun.target.id.startsWith("builder:")) throw new Error("cannot compile a failure bundle for a builder run");
	const target = loadTarget(targetDir);
	if (target.manifest.id !== evalRun.target.id) {
		throw new Error(`eval run ${evalRunId} belongs to target ${evalRun.target.id}, not ${target.manifest.id}`);
	}
	return compileFailureBundle(target, evalRun, runsRoot, options);
}
