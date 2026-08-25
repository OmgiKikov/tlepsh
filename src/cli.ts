import { resolve } from "node:path";
import { loadTarget } from "./manifest.js";
import { listEvalRuns, runSuite } from "./eval.js";
import { compareEvalRuns, renderCompareMarkdown } from "./compare.js";
import { compileBundleForEvalRun } from "./bundle.js";
import { runBuilder } from "./builder.js";
import { promote, reject, runCandidateFlow } from "./loop.js";

function runsRoot(): string {
	return process.env.AHDE_RUNS_DIR ? resolve(process.env.AHDE_RUNS_DIR) : resolve(process.cwd(), "runs");
}

const USAGE = `ahde — Agent Harness Development Environment

Usage:
  ahde run --target <dir> [--task <id>] [--repetitions N] [--label baseline|candidate|solo]
  ahde validate --target <dir>
  ahde list [--target <id>]
  ahde failures <evalRunId> --target <dir> [--out <path>]
  ahde compare <evalRunA> <evalRunB>
  ahde builder --target <dir> --bundle <path> [--branch <name>] [--builder <dir>]
  ahde candidate --target <dir> [--branch <name>] [--baseline <evalRunId>] [--repetitions N]
  ahde promote --target <dir> --eval-run <id> --to <semver>
  ahde reject --eval-run <id> --reason <text>

Environment:
  AHDE_RUNS_DIR        run artifacts directory (default: ./runs)
  AHDE_EVOLUTION_LOG   promote/reject ledger (default: ./docs/evolution.jsonl)`;

function arg(name: string): string | undefined {
	const argv = process.argv.slice(2);
	const index = argv.indexOf(`--${name}`);
	if (index === -1 || index + 1 >= argv.length) return undefined;
	return argv[index + 1];
}

function positional(index: number): string | undefined {
	const argv = process.argv.slice(2);
	const isValue = new Set<number>();
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i]?.startsWith("--")) isValue.add(i + 1);
	}
	return argv.filter((_, i) => i > 0 && !isValue.has(i) && !argv[i]?.startsWith("--"))[index];
}

function requireArg(name: string): string {
	const value = arg(name);
	if (!value) {
		console.error(`missing --${name}\n`);
		console.log(USAGE);
		process.exit(1);
	}
	return value;
}

async function main(): Promise<void> {
	const command = process.argv[2];
	switch (command) {
		case "run": {
			const target = loadTarget(resolve(requireArg("target")));
			const taskId = arg("task");
			const repetitions = Number(arg("repetitions") ?? "1");
			const label = (arg("label") ?? "solo") as "baseline" | "candidate" | "solo";
			const record = await runSuite(target, { runsRoot: runsRoot(), label, repetitions, taskId });
			console.log(
				`eval run ${record.evalRunId}: ${record.summary.pass}/${record.summary.total} all-pass ` +
					`(${record.summary.fail} fail, ${record.summary.error} error)`,
			);
			for (const runId of record.runIds) console.log(`  run ${runId}`);
			break;
		}
		case "validate": {
			const target = loadTarget(resolve(requireArg("target")));
			console.log(`target ${target.manifest.id} OK`);
			console.log(`  model: ${target.manifest.model.provider}/${target.manifest.model.id}`);
			console.log(`  tasks: ${target.tasks.length} (${target.datasetHash.slice(7, 19)}…)`);
			console.log(`  suite: ${target.manifest.evalSuite.id} (${target.suiteHash.slice(7, 19)}…)`);
			console.log(`  skills: ${target.manifest.skills.join(", ") || "(none)"}`);
			console.log(`  git: ${target.gitSha.slice(0, 8)} | pi: ${target.runtime.piVersion}@${target.runtime.piSha.slice(0, 8)}`);
			break;
		}
		case "list": {
			const targetId = arg("target");
			const runs = listEvalRuns(runsRoot()).filter((r) => !targetId || r.target.id === targetId);
			if (runs.length === 0) {
				console.log("no eval runs");
				break;
			}
			for (const run of runs) {
				console.log(
					`${run.evalRunId}  ${run.label.padEnd(9)} ${run.target.id.padEnd(16)} ` +
						`${(run.summary.allPassRate * 100).toFixed(0).padStart(3)}% ` +
						`(${run.summary.pass}/${run.summary.total})  ${run.startedAt}`,
				);
			}
			break;
		}
		case "failures": {
			const evalRunId = positional(0);
			if (!evalRunId) {
				console.error("usage: ahde failures <evalRunId> --target <dir> [--out <path>]\n");
				console.log(USAGE);
				process.exit(1);
			}
			const out = compileBundleForEvalRun(resolve(requireArg("target")), evalRunId, runsRoot(), {
				outPath: arg("out"),
			});
			console.log(out);
			break;
		}
		case "compare": {
			const a = positional(0);
			const b = positional(1);
			if (!a || !b) {
				console.error("usage: ahde compare <evalRunA> <evalRunB>\n");
				console.log(USAGE);
				process.exit(1);
			}
			const result = compareEvalRuns(runsRoot(), a, b);
			console.log(renderCompareMarkdown(result));
			if (result.error) process.exit(2);
			break;
		}
		case "builder": {
			const target = loadTarget(resolve(requireArg("target")));
			const bundlePath = resolve(requireArg("bundle"));
			const builderDir = resolve(arg("builder") ?? "builders/default");
			const result = await runBuilder(builderDir, target, bundlePath, {
				runsRoot: runsRoot(),
				branch: arg("branch"),
			});
			console.log(`builder run ${result.builderRunId} → branch ${result.branch} (${result.commitSha.slice(0, 8)})`);
			for (const file of result.changedFiles) console.log(`  ${file}`);
			break;
		}
		case "candidate": {
			const result = await runCandidateFlow({
				runsRoot: runsRoot(),
				targetDir: resolve(requireArg("target")),
				branch: arg("branch"),
				baselineEvalRunId: arg("baseline"),
				repetitions: arg("repetitions") ? Number(arg("repetitions")) : undefined,
			});
			console.log(renderCompareMarkdown(result.compare));
			console.log(`\ncandidate eval run: ${result.candidate.evalRunId} (baseline: ${result.baseline?.evalRunId})`);
			console.log(`smoke: ${result.smoke?.evalRunId} | validate: ${result.validateMs}ms`);
			console.log(`\nnext: ahde promote --target <dir> --eval-run ${result.candidate.evalRunId} --to <semver>`);
			break;
		}
		case "promote": {
			const result = promote({
				targetDir: resolve(requireArg("target")),
				evalRunId: requireArg("eval-run"),
				version: requireArg("to"),
				runsRoot: runsRoot(),
			});
			console.log(`promoted: tag ${result.tag} (${result.changedFiles.length} files changed)`);
			break;
		}
		case "reject": {
			reject({
				evalRunId: requireArg("eval-run"),
				runsRoot: runsRoot(),
				reason: requireArg("reason"),
			});
			console.log("rejected (recorded in evolution log)");
			break;
		}
		default:
			console.log(USAGE);
			process.exit(1);
	}
}

main().catch((error: unknown) => {
	console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
