#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import {
	readFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { describeEnvVar, loadDotEnv, type EnvReport } from "./env.js";
import { loadTarget, scaffoldTarget } from "./manifest.js";
import {
	loadRun,
	renderRunTurns,
	runSuite,
} from "./eval.js";
import {
	money,
} from "./measurement.js";
import { evaluatorReadiness } from "./application/configure-evaluators.js";
import {
	assertScaffoldableTargetLocation,
	assertUntrackedEngineStore,
	renderLocalArtifactIgnoreLine,
} from "./application/store-hygiene.js";

import { diagnoseEvalRun } from "./diagnosis.js";
import { redactTraceText } from "./trace.js";
import {
	loadCorpus,
} from "./corpus.js";
import {
	targetWithDevelopmentCorpus,
} from "./application/corpus-target.js";
import {
	createEvidenceExplorer,
	type EvidenceExplorer,
	type EvidenceExplorerAddress,
} from "./evidence/server.js";
import {
	launchBuilderPi,
	type BuilderSessionMode,
} from "./builder/runtime.js";
import {
	DEFAULT_REPETITIONS,
} from "./workbench/calibration.js";
import { runInteractiveTarget } from "./target/interactive.js";
import { resolveInteractiveTargetDirectory } from "./target/command.js";
import {
	assertTargetReadyToRun,
	inspectTargetReadiness,
	toolCredentialReadiness,
} from "./target/readiness.js";
import { standInFilesLine } from "./target/placeholders.js";
import type { RunEventListener } from "./run-events.js";
import {
	CliInvocationError,
	parseCliInvocation,
} from "./cli-invocation.js";
import { cliHelp } from "./cli-help.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let loadedEnvironment: EnvReport | undefined;

function environmentReport(): EnvReport {
	if (loadedEnvironment) return loadedEnvironment;
	loadedEnvironment = loadDotEnv();
	for (const conflict of loadedEnvironment.conflicts) {
		console.error(
			`warning: ${conflict.name} — shell env ${conflict.shellFingerprint} overrides ${conflict.file} ${conflict.fileFingerprint}; ` +
				`runs will use the shell value (unset it to use ${conflict.file})`,
		);
	}
	return loadedEnvironment;
}

function runsRoot(): string {
	return process.env.AHDE_RUNS_DIR ? resolve(process.env.AHDE_RUNS_DIR) : resolve(process.cwd(), "runs");
}

function stateRoot(): string {
	return process.env.AHDE_STATE_DIR ? resolve(process.env.AHDE_STATE_DIR) : resolve(process.cwd(), ".ahde");
}

function cliRunProgress(): RunEventListener {
	let pass = 0;
	let fail = 0;
	let error = 0;
	return (event) => {
		if (event.type === "run_started") {
			process.stderr.write(`AHDE run ${event.run.ordinal}/${event.run.total} · running\n`);
			return;
		}
		if (event.type !== "run_graded") return;
		if (event.outcome === "pass") pass += 1;
		else if (event.outcome === "fail") fail += 1;
		else error += 1;
		process.stderr.write(
			`AHDE run ${event.run.ordinal}/${event.run.total} · ${event.outcome} ` +
				`(${pass} pass, ${fail} fail, ${error} error)\n`,
		);
	};
}

const USAGE = cliHelp([]);

/**
 * How many turns one case actually took, for the run list. Only simulated-user
 * runs record a turn count, so every other line reads exactly as it always has.
 * A run whose record cannot be read still gets its id printed: the turn count is
 * a nicety and must never be the reason a completed run goes unreported.
 */
function describeRunTurns(runsRootDir: string, runId: string): string {
	try {
		return renderRunTurns(loadRun(runsRootDir, runId).metrics);
	} catch {
		return "";
	}
}

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
		console.log(cliHelp(process.argv.slice(2)));
		process.exit(2);
	}
	return value;
}

/**
 * Primary product entry point: a real Builder Pi instance. The web process is
 * created lazily and remains a read-only projection of already-diagnosed runs.
 */
async function builderPi(sessionMode?: BuilderSessionMode): Promise<void> {
	if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
		throw new Error("AHDE Builder requires an interactive terminal (TTY).");
	}
	const projectDir = resolve(arg("target") ?? process.cwd());
	const builderStateRoot = process.env.AHDE_STATE_DIR
		? resolve(process.env.AHDE_STATE_DIR)
		: join(projectDir, ".ahde");
	const builderRunsRoot = process.env.AHDE_RUNS_DIR
		? resolve(process.env.AHDE_RUNS_DIR)
		: join(projectDir, "runs");
	const evidence = {
		explorer: null as EvidenceExplorer | null,
		address: null as EvidenceExplorerAddress | null,
	};
	let evidenceHostPromise: Promise<{
		explorer: EvidenceExplorer;
		address: EvidenceExplorerAddress;
	}> | null = null;
	const ensureEvidenceHost = async (): Promise<{
		explorer: EvidenceExplorer;
		address: EvidenceExplorerAddress;
	}> => {
		if (evidence.explorer && evidence.address) {
			return { explorer: evidence.explorer, address: evidence.address };
		}
		if (!evidenceHostPromise) {
			const explorer = evidence.explorer ?? createEvidenceExplorer({ runsRoot: builderRunsRoot });
			evidence.explorer = explorer;
			evidenceHostPromise = explorer.listen(Number(arg("port") ?? "0"))
				.then((address) => {
					evidence.address = address;
					return { explorer, address };
				})
				.catch(async (error: unknown) => {
					if (evidence.explorer === explorer) {
						evidence.explorer = null;
						evidence.address = null;
					}
					try {
						await explorer.close();
					} catch {
						// A failed observational host must not mask the original bind error.
					}
					throw error;
				});
		}
		const pending = evidenceHostPromise;
		try {
			return await pending;
		} finally {
			if (evidenceHostPromise === pending) evidenceHostPromise = null;
		}
	};

	try {
		await launchBuilderPi({
			projectDir,
			stateRoot: builderStateRoot,
			runsRoot: builderRunsRoot,
			projectId: arg("project"),
			sessionMode,
			dependencies: {
				beginLiveTrace: async () => {
					const host = await ensureEvidenceHost();
					const liveTrace = host.explorer.startLiveTrace();
					return {
						url: host.address.urlForLiveTrace(liveTrace.id),
						onRunEvent: liveTrace.onRunEvent,
						finish: liveTrace.finish,
					};
				},
				evidenceLink: async (record) => {
					// The HTTP adapter never mutates canonical state. Diagnosis is
					// created here, in the trusted application path, before linking.
					diagnoseEvalRun(builderRunsRoot, record.evalRunId);
					try {
						const host = await ensureEvidenceHost();
						return {
							url: host.address.urlForEval(record.evalRunId),
							label: "Open verified development traces",
						};
					} catch {
						return null;
					}
				},
			},
		});
	} finally {
		try {
			await evidence.explorer?.close();
		} catch {
			// Evidence HTTP is observational and cannot mask Builder shutdown.
		}
	}
}

async function evidence(): Promise<void> {
	// With a project the explorer can read that project's human judge labels and
	// report the same calibration the HTML report does; without one it says the
	// calibration is not available here rather than claiming the judge is
	// unchecked.
	const projectId = arg("project");
	const explorer = createEvidenceExplorer({
		runsRoot: runsRoot(),
		...(projectId ? { labels: { stateRoot: stateRoot(), projectId } } : {}),
	});
	const address = await explorer.listen(Number(arg("port") ?? "0"));
	console.log(`AHDE Evidence: ${address.url}`);
	console.log("read-only development traces · sealed holdout evidence is hidden");
	console.log("press Ctrl-C to stop");
	await new Promise<void>((resolveStop) => {
		const stop = () => {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
			void explorer.close().finally(resolveStop);
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
}

async function targetPi(): Promise<void> {
	const targetDir = resolveInteractiveTargetDirectory(arg("target"));
	const target = loadTarget(targetDir);
	assertTargetReadyToRun(target);
	await runInteractiveTarget(target, {
		...(arg("message") ? { initialMessage: arg("message") } : {}),
	});
}

async function main(): Promise<void> {
	let invocation: ReturnType<typeof parseCliInvocation>;
	try {
		invocation = parseCliInvocation(process.argv.slice(2));
	} catch (error) {
		if (!(error instanceof CliInvocationError)) throw error;
		// The page for the command they typed, not the whole product tour: a
		// usage error is about one invocation.
		console.error(`usage error: ${error.message}\n`);
		console.error(cliHelp(process.argv.slice(2)));
		process.exitCode = 2;
		return;
	}
	if (invocation.kind === "help") {
		console.log(cliHelp(process.argv.slice(2)));
		return;
	}
	if (invocation.kind === "version") {
		const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
		if (typeof metadata.version !== "string") throw new Error("package metadata is missing a version");
		console.log(`ahde ${metadata.version}`);
		return;
	}
	environmentReport();
	const command = invocation.command === "root" ? undefined : invocation.command;
	if (command === undefined) {
		await builderPi();
		return;
	}
	switch (command) {
		case "builder-pi": {
			await builderPi("new");
			break;
		}
		case "continue": {
			await builderPi("continue");
			break;
		}
		case "resume": {
			await builderPi("resume");
			break;
		}
		case "target": {
			await targetPi();
			break;
		}
		case "init": {
			const dir = positional(0);
			if (!dir) {
				console.error("usage: ahde init <dir> [--template <name|target-dir>]\n");
				console.log(USAGE);
				process.exit(2);
			}
			const template = arg("template");
			const { resolveTargetTemplate } = await import("./application/target-template.js");
			const templateDir = resolveTargetTemplate(template, packageRoot);
			// A new Target inside a checkout that already committed an engine
			// store inherits its problem: the sealed exam is already a Git object
			// there, and a scaffold would quietly add a second store beside it.
			assertScaffoldableTargetLocation(resolve(dir));
			let ignoreLine: string | null = null;
			scaffoldTarget(templateDir, resolve(dir), (added) => {
				ignoreLine = renderLocalArtifactIgnoreLine(added);
			});
			console.log(`scaffolded target → ${resolve(dir)} (template: ${template ?? "pi-basic"})`);
			// The engine store lives inside the Target and holds the sealed exam:
			// say which rules were written rather than leaving it to be discovered.
			if (ignoreLine) console.log(ignoreLine);
			console.log("next: open Builder Pi; it shows the exact one-time Target/model diff before committing it:");
			console.log(`      cd ${resolve(dir)} && ahde`);
			break;
		}
		case "evidence": {
			await evidence();
			break;
		}
		case "run": {
			const dataset = arg("dataset");
			const corpusId = arg("corpus");
			if (dataset && corpusId) {
				throw new Error("run cannot combine --dataset with --corpus");
			}
			const targetDir = resolve(requireArg("target"));
			// The store this run is about to write into holds the sealed exam.
			// A Target that already committed it is refused before any model
			// call, alongside the readiness check the operator already knows.
			assertUntrackedEngineStore(targetDir);
			const baseTarget = loadTarget(targetDir, dataset ? { dataset } : undefined);
			const target = corpusId
				? targetWithDevelopmentCorpus(
					baseTarget,
					loadCorpus({ stateRoot: stateRoot(), projectId: requireArg("project"), corpusId }),
				)
				: baseTarget;
			assertTargetReadyToRun(target);
			const taskId = arg("task");
			const repetitions = Number(arg("repetitions") ?? String(DEFAULT_REPETITIONS));
			const requestedLabel = arg("label") ?? "solo";
			if (requestedLabel === "candidate") {
				throw new Error("candidate runs require an exact matched baseline; check the change from the Builder conversation instead");
			}
			if (requestedLabel !== "baseline" && requestedLabel !== "solo") {
				throw new Error(`--label must be baseline or solo, got ${requestedLabel}`);
			}
			const label = requestedLabel;
			const record = await runSuite(target, {
				runsRoot: runsRoot(),
				label,
				repetitions,
				taskId,
				onRunEvent: cliRunProgress(),
				...(arg("jobs") ? { jobs: Number(arg("jobs")) } : {}),
			});
			// The judge is the instrument, not the thing measured, so its spend is
			// said beside the result rather than folded into the Target's cost.
			const judgeSpend = record.judgeCostUsd ?? 0;
			console.log(
				`eval run ${record.evalRunId}: ${record.summary.pass}/${record.summary.total} all-pass ` +
					`(${record.summary.fail} fail, ${record.summary.error} error)` +
					`${judgeSpend > 0 ? ` · judge ${money(judgeSpend)}` : ""}`,
			);
			for (const runId of record.runIds) {
				// How long the conversation ran is the first thing an operator wants
				// from a simulated-user case, and the only thing a pass/fail hides.
				// Silent on every other case, whose answer is one turn by definition.
				const turns = describeRunTurns(runsRoot(), runId);
				console.log(`  run ${runId}${turns}`);
			}
			if (record.summary.error > 0) process.exitCode = 2;
			else if (record.summary.fail > 0) process.exitCode = 1;
			break;
		}
		case "validate": {
			const dataset = arg("dataset");
			const target = loadTarget(resolve(requireArg("target")), dataset ? { dataset } : undefined);
			const readiness = inspectTargetReadiness(target);
			console.log(`target ${target.manifest.id}: structurally valid`);
			console.log(`  model: ${target.manifest.model.provider}/${target.manifest.model.id} (thinking: ${target.manifest.model.thinkingLevel})`);
			console.log(`  key ${target.manifest.model.apiKeyEnv}: ${describeEnvVar(target.manifest.model.apiKeyEnv, environmentReport())}`);
			// The other two models a measurement uses. A judge configured without
			// its key fails at the first graded case and nowhere earlier, so it is
			// said here, beside the Target's own model.
			const evaluators = evaluatorReadiness(target.manifest);
			for (const evaluator of evaluators) console.log(`  ${evaluator.line}`);
			// Every key a declared tool says it needs, said here rather than
			// discovered inside a sandbox at the first call.
			const toolKeys = toolCredentialReadiness(target);
			for (const key of toolKeys) console.log(`  ${key.line}`);
			// Structurally valid and still unwritten are different things: a harness
			// straight out of a template passes every check above while its
			// instructions, its cases and its tool still say REPLACE-ME. Named once,
			// never fatal — describing the agent is how they get replaced.
			const standIns = standInFilesLine(target.dir);
			if (standIns) console.log(`  ${standIns}`);
			console.log(`  tasks: ${target.tasks.length} (${target.datasetHash.slice(7, 19)}…)`);
			console.log(`  suite: ${target.manifest.evalSuite.id} (${target.suiteHash.slice(7, 19)}…)`);
			console.log(`  skills: ${target.manifest.skills.join(", ") || "(none)"}`);
			// What would actually confine a run on THIS host right now, not what
			// the manifest hopes for.
			console.log(`  sandbox: ${target.manifest.execution.sandbox} (host OS sandbox)`);
			const gitDisplay = target.gitSha.includes("-dirty-")
				? `${target.gitSha.slice(0, 8)} (dirty ${target.gitSha.split("-dirty-")[1]})`
				: target.gitSha.slice(0, 8);
			console.log(`  git: ${gitDisplay} | pi: ${target.runtime.piVersion}@${target.runtime.piSha.slice(0, 8)}`);
			console.log(`  ahde: ${target.runtime.ahdeVersion}@${target.runtime.ahdeCodeHash.slice(7, 19)}…`);
			if (readiness.bootstrapRequired) {
				console.log("  readiness: ACTION REQUIRED — Target identity/model still contain starter placeholders");
				process.exitCode = 2;
			} else if (readiness.credential.status === "missing") {
				console.log(`  readiness: ACTION REQUIRED — configure ${target.manifest.model.apiKeyEnv} outside chat`);
				process.exitCode = 2;
			} else {
				// A missing evaluator key is not a structural error — the suite may
				// never call one — but it is exactly the surprise this line exists
				// to prevent, so it is stated rather than hidden behind "ready".
				const uncredentialed = evaluators.filter((entry) => entry.configured && !entry.credentialPresent);
				const uncredentialedTools = toolKeys.filter((entry) => !entry.present);
				if (uncredentialed.length > 0) {
					console.log(
						`  readiness: ACTION REQUIRED — configure ${
							uncredentialed.map((entry) => entry.apiKeyEnv).join(", ")
						} outside chat before any judged or simulated case runs`,
					);
					process.exitCode = 2;
				} else if (uncredentialedTools.length > 0) {
					console.log(
						`  readiness: ACTION REQUIRED — export ${
							[...new Set(uncredentialedTools.map((entry) => entry.environmentName))].join(", ")
						} in the shell that runs ahde before ${
							[...new Set(uncredentialedTools.map((entry) => entry.tool))].join(", ")
						} can run`,
					);
					process.exitCode = 2;
				} else {
					console.log("  readiness: ready to run (credential present; provider access unverified)");
				}
			}
			break;
		}
	}
}

function cliFailure(error: unknown): { message: string; next?: string } {
	const message = redactTraceText(error instanceof Error ? error.message : String(error)).slice(0, 4_000);
	// A refusal that already knows what the operator should do next says so
	// itself, rather than being recognized here by the shape of its sentence.
	const carried = (error as { next?: unknown } | null)?.next;
	if (typeof carried === "string" && carried.trim().length > 0) {
		return { message, next: redactTraceText(carried).slice(0, 1_000) };
	}
	const filesystemError = error as NodeJS.ErrnoException | null;
	if (filesystemError?.code === "ENOENT" && /(?:^|[/\\])manifest\.yaml$/.test(filesystemError.path ?? "")) {
		return {
			message: "This folder has not been connected to AHDE yet (manifest.yaml is missing).",
			next: "Open `ahde --target <dir>` to review the existing agent, or use `ahde init <new-dir> --template python-support` to create one. Your source files have not been changed.",
		};
	}
	if (/requires an interactive terminal|requires TTY stdin and stdout/i.test(message)) {
		return {
			message: "This command needs an interactive terminal (TTY).",
			next: "Run it directly in a terminal. For automation, use the non-interactive `ahde run`, `ahde validate`, or library API.",
		};
	}
	if (/Target HEAD must equal the Candidate baseline/i.test(message)) {
		return {
			message,
			next: "If the branch already points at the promoted revision this candidate is adopted and there is nothing to do; otherwise put the branch back on the candidate's baseline first.",
		};
	}
	if (/replace-with-model-id|starter placeholder|built-in.*placeholder/i.test(message)) {
		return { message: "Target setup is incomplete.", next: "Open `ahde` and finish the guided Target identity/model setup." };
	}
	if (/\b401\b|unauthori[sz]ed|authentication|invalid api key/i.test(message)) {
		return { message: "The model provider rejected the configured credential.", next: "Run `ahde`, then `/doctor`; authenticate the Builder with `/login` or configure the named Target env variable outside chat." };
	}
	if (/fetch failed|ECONNREFUSED|ENOTFOUND|network|socket/i.test(message)) {
		return { message, next: "Check the configured model baseUrl and network reachability, then run `ahde validate --target <dir>`." };
	}
	if (/missing [A-Z][A-Z0-9_]+/.test(message)) {
		return { message, next: "Configure the named environment variable outside chat; AHDE never accepts secret values in conversation." };
	}
	return { message };
}

/**
 * Exit 1 is a behavioral verdict — a command ran, measured, and the answer was
 * no. Every command that has one sets it inline. Anything that throws never got
 * that far: a missing artifact, an unreadable record, a refused precondition, a
 * provider that would not answer. Those are inconclusive, and inconclusive is
 * exit 2, the same split `ahde run` documents.
 */
main().catch((error: unknown) => {
	const failure = cliFailure(error);
	console.error(`error: ${failure.message}`);
	if (failure.next) console.error(`next: ${failure.next}`);
	process.exitCode = 2;
});
