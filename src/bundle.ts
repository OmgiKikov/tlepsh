import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadEvalRun, loadRun, type EvalRunRecord } from "./eval.js";
import { loadTarget, type ResolvedTarget } from "./manifest.js";
import { openTrace, renderTraceMarkdown } from "./trace.js";
import { writeTextArtifact } from "./storage/artifacts.js";
import { resolveContainedArtifactPath } from "./storage/paths.js";

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
	if (target.manifest.id !== evalRun.target.id || target.gitSha !== evalRun.target.gitSha) {
		throw new Error(
			`failure bundle requires the exact evaluated target snapshot ` +
				`${evalRun.target.id}@${evalRun.target.gitSha}; got ${target.manifest.id}@${target.gitSha}`,
		);
	}
	if (target.suiteHash !== evalRun.suiteHash || target.datasetHash !== evalRun.datasetHash) {
		throw new Error("failure bundle target suite/dataset no longer matches the eval evidence");
	}
	const lines: string[] = [];
	const runs = evalRun.runIds.map((runId) => loadRun(runsRoot, runId));
	const failedRuns = runs.filter((run) => run.status !== "completed" || run.evalResults?.outcome !== "pass");

	lines.push(`# Failure Bundle — ${target.manifest.id}`, "");
	lines.push(`- eval run: \`${evalRun.evalRunId}\` (${evalRun.label})`);
	lines.push(`- target harness: ${target.gitSha.slice(0, 12)} (repository path withheld)`);
	lines.push(
		`- suite: ${evalRun.suiteId} dataset=${evalRun.dataset} (${evalRun.datasetHash.slice(7, 19)}…, suite ${evalRun.suiteHash.slice(7, 19)}…)`,
	);
	lines.push(
		`- baseline metrics: ${evalRun.summary.pass}/${evalRun.summary.total} all-pass (${evalRun.summary.fail} fail, ${evalRun.summary.error} error)`,
	);
	lines.push(`- failed tasks: ${failedRuns.length}`);
	lines.push("");
	lines.push("## Repetition statistics", "");
	lines.push(
		"Каждая задача прогоняется несколько раз (repetitions). Задача, которая падает не в каждом",
		"повторении, — flaky: поведение модели нестабильно на том же harness. Патч текста её не вылечит;",
		"нужно структурное изменение workflow или признание, что это потолок модели/бенчмарка.",
		"",
	);
	const byTask = new Map<string, { pass: number; total: number }>();
	for (const run of runs) {
		const entry = byTask.get(run.taskId) ?? { pass: 0, total: 0 };
		entry.total += 1;
		if (run.evalResults?.outcome === "pass") entry.pass += 1;
		byTask.set(run.taskId, entry);
	}
	const failedTaskIds = new Set(failedRuns.map((run) => run.taskId));
	if (failedTaskIds.size > 0) {
		lines.push("| task | pass/total reps | verdict |", "|---|---|---|");
		for (const taskId of [...failedTaskIds].sort()) {
			const entry = byTask.get(taskId) ?? { pass: 0, total: 0 };
			const verdict = entry.pass === 0 ? "consistent — fails every repetition" : `flaky — passes ${entry.pass}/${entry.total}`;
			lines.push(`| ${taskId} | ${entry.pass}/${entry.total} | ${verdict} |`);
		}
		lines.push("");
	}
	lines.push(`Всего задач в датасете: ${byTask.size}. Меньше 30 — сравнения baseline/candidate шумные: любой патч рискует получить «регрессию», которая на самом деле флейк.`);
	lines.push("");
	lines.push("## Allowed change scope", "");
	lines.push(
		`Improve the target harness ONLY: \`AGENTS.md\`, \`skills/**\`, \`bin/**\`, \`tools/**\`, ` +
			"and the `manifest.yaml` `skills`/`tools` declaration lists. " +
			"Do NOT touch `evals/**` or any manifest id, model, execution, instructions, or evalSuite setting. " +
			"Return a typed proposal only; do not edit the repository, create branches, or run the target.",
	);
	lines.push("");

	for (const run of failedRuns) {
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
			if (!run.trace.sha256) throw new Error(`completed run ${run.runId} has no trace hash`);
			const traceArtifact = resolveContainedArtifactPath(runsRoot, run.runId, run.trace.path);
			const messages = openTrace(dirname(traceArtifact), basename(traceArtifact), run.trace.sha256);
			lines.push("### Execution trace", "", renderTraceMarkdown(messages), "");
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
	writeTextArtifact(outPath, bundle);
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
