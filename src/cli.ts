import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { readFileSync, renameSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { describeEnvVar, loadDotEnv } from "./env.js";
import { loadTarget, scaffoldTarget } from "./manifest.js";
import { listEvalRuns, runSuite } from "./eval.js";
import { compareEvalRuns, renderCompareMarkdown } from "./compare.js";
import { compileBundleForEvalRun } from "./bundle.js";
import { BuilderManifest, runBuilder } from "./builder.js";
import { createInteractiveSession } from "./runner.js";
import { promote, reject, runCandidateFlow } from "./loop.js";

const envReport = loadDotEnv();
for (const conflict of envReport.conflicts) {
	console.error(
		`warning: ${conflict.name} — shell env ${conflict.shellFingerprint} overrides ${conflict.file} ${conflict.fileFingerprint}; ` +
			`runs will use the shell value (unset it to use ${conflict.file})`,
	);
}

function runsRoot(): string {
	return process.env.AHDE_RUNS_DIR ? resolve(process.env.AHDE_RUNS_DIR) : resolve(process.cwd(), "runs");
}

const USAGE = `ahde — Agent Harness Development Environment

Usage:
  ahde                                        # chat: интерактивный companion
  ahde chat [--companion <dir>]
  ahde init <dir> [--template <target-dir>]
  ahde run --target <dir> [--task <id>] [--repetitions N] [--label baseline|candidate|solo] [--dataset <rel>]
  ahde validate --target <dir> [--dataset <rel>]
  ahde list [--target <id>]
  ahde failures <evalRunId> --target <dir> [--out <path>]
  ahde compare <evalRunA> <evalRunB>
  ahde builder --target <dir> --bundle <path> [--branch <name>] [--builder <dir>]
  ahde candidate --target <dir> [--branch <name>] [--baseline <evalRunId>] [--repetitions N] [--dataset <rel>]
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

/** Interactive companion: talk to the platform; the agent drives the CLI. */
async function chat(companionDir: string | undefined): Promise<void> {
	const dir = resolve(companionDir ?? "builders/companion");
	const manifestResult = BuilderManifest.safeParse(parseYaml(readFileSync(join(dir, "manifest.yaml"), "utf8")));
	if (!manifestResult.success) {
		throw new Error(`companion manifest.yaml: ${manifestResult.error.message}`);
	}
	const manifest = manifestResult.data;
	if (!manifest.model) throw new Error("companion manifest requires an explicit model block");
	const agentsMdContent = readFileSync(resolve(dir, manifest.instructions.agentsMd), "utf8");

	const { session, sessionManager, runDir } = await createInteractiveSession({
		runsRoot: runsRoot(),
		model: manifest.model,
		agentsMdContent,
		cwd: process.cwd(),
	});
	console.log(`ahde chat — трейс диалога: ${runDir} (выход: ctrl-D или "exit")`);

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let closed = false;
	let pending: ((value: string | null) => void) | null = null;
	rl.on("close", () => {
		closed = true;
		pending?.(null);
	});
	const ask = (): Promise<string | null> =>
		new Promise((res) => {
			if (closed) return res(null);
			pending = res;
			rl.question("> ", (line) => {
				pending = null;
				res(line);
			});
		});

	try {
		for (;;) {
			const line = await ask();
			if (line === null || /^(exit|quit|выход)$/i.test(line.trim())) break;
			if (!line.trim()) continue;
			try {
				await session.prompt(line);
				// Reasoning models sometimes end a turn with empty text (known
				// from target runs) — one bounded nudge, then whatever we have.
				if (!session.getLastAssistantText()?.trim()) {
					await session.prompt("Ответь пользователю текстом.");
				}
				const text = session.getLastAssistantText();
				console.log(text?.trim() || "(нет ответа)");
			} catch (error) {
				console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	} finally {
		rl.close();
		try {
			const sessionFile = sessionManager.getSessionFile();
			if (sessionFile) renameSync(sessionFile, join(runDir, "session.jsonl"));
		} catch {
			// best effort
		}
		try {
			session.dispose();
		} catch {
			// best effort
		}
	}
}

async function main(): Promise<void> {
	const command = process.argv[2];
	switch (command) {
		case undefined:
		case "chat": {
			await chat(arg("companion"));
			break;
		}
		case "init": {
			const dir = positional(0);
			if (!dir) {
				console.error("usage: ahde init <dir> [--template <target-dir>]\n");
				console.log(USAGE);
				process.exit(1);
			}
			const template = arg("template") ?? "targets/ombudsman";
			const templateDir = resolve(template.startsWith("/") || template.startsWith(".") ? template : join(process.cwd(), template));
			scaffoldTarget(templateDir, resolve(dir));
			console.log(`scaffolded target → ${resolve(dir)} (template: ${template})`);
			console.log(`next: отредактируй manifest.yaml (id, model, apiKeyEnv) и evals/*.jsonl, затем`);
			console.log(`      ahde validate --target ${dir}`);
			break;
		}
		case "run": {
			const dataset = arg("dataset");
			const target = loadTarget(resolve(requireArg("target")), dataset ? { dataset } : undefined);
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
			const dataset = arg("dataset");
			const target = loadTarget(resolve(requireArg("target")), dataset ? { dataset } : undefined);
			console.log(`target ${target.manifest.id} OK`);
			console.log(`  model: ${target.manifest.model.provider}/${target.manifest.model.id} (thinking: ${target.manifest.model.thinkingLevel})`);
			console.log(`  key ${target.manifest.model.apiKeyEnv}: ${describeEnvVar(target.manifest.model.apiKeyEnv, envReport)}`);
			console.log(`  tasks: ${target.tasks.length} (${target.datasetHash.slice(7, 19)}…)`);
			console.log(`  suite: ${target.manifest.evalSuite.id} (${target.suiteHash.slice(7, 19)}…)`);
			console.log(`  skills: ${target.manifest.skills.join(", ") || "(none)"}`);
			const gitDisplay = target.gitSha.includes("-dirty-")
				? `${target.gitSha.slice(0, 8)} (dirty ${target.gitSha.split("-dirty-")[1]})`
				: target.gitSha.slice(0, 8);
			console.log(`  git: ${gitDisplay} | pi: ${target.runtime.piVersion}@${target.runtime.piSha.slice(0, 8)}`);
			console.log(`  ahde: ${target.runtime.ahdeVersion}@${target.runtime.ahdeCodeHash.slice(7, 19)}…`);
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
				dataset: arg("dataset"),
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
