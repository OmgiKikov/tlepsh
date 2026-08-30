import { dirname, join, resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describeEnvVar, loadDotEnv, type EnvReport } from "./env.js";
import { loadTarget, scaffoldTarget } from "./manifest.js";
import { listEvalRunIndexesLenient, loadEvalRun, runSuite } from "./eval.js";
import { compareEvalRuns, renderCompareMarkdown } from "./compare.js";
import { compileFailureBundle } from "./bundle.js";
import { runCandidateExperiment } from "./application/candidate-experiment.js";
import { runAppliedBuilderCandidate } from "./application/builder-candidate.js";
import { diagnoseEvalRun } from "./diagnosis.js";
import { compileImprovementBrief } from "./application/improvement-brief.js";
import { redactTraceText } from "./trace.js";
import { buildEvalReport } from "./report.js";
import {
	decideCandidateRejection,
	promoteReviewedCandidate,
	reviewCandidate,
} from "./application/candidate-review.js";
import { createCorpus, importCorpus, listCorpora, loadCorpus, type CorpusVisibility } from "./corpus.js";
import { loadBuilderCorpusDraft } from "./application/builder-corpus-draft.js";
import {
	datasetHoldoutInForce,
	ingestDataset,
	inspectDatasetFile,
	type DatasetHoldoutSpec,
} from "./application/dataset-ingest.js";
import { loadBuilderProposalRun } from "./application/builder-proposal.js";
import {
	resolveDevelopmentTargetForEval,
	targetWithDevelopmentCorpus,
} from "./application/corpus-target.js";
import { listSpecSnapshots, loadSpecSnapshot } from "./spec.js";
import {
	createEvidenceExplorer,
	type EvidenceExplorer,
	type EvidenceExplorerAddress,
} from "./evidence/server.js";
import { launchBuilderPi, type BuilderSessionMode } from "./builder/runtime.js";
import { renderCalibration } from "./builder/render/calibration.js";
import { renderDataset } from "./builder/render/view.js";
import { plainPaint } from "./builder/render/paint.js";
import { DEFAULT_REPETITIONS, calibrationProjection } from "./workbench/calibration.js";
import { resolveCommitRef } from "./git/experiment-worktree.js";
import { SEALED_GATE_POLICY } from "./domain/comparison-gate.js";
import { runInteractiveTarget } from "./target/interactive.js";
import { resolveInteractiveTargetDirectory } from "./target/command.js";
import {
	assertTargetReadyToRun,
	inspectTargetReadiness,
} from "./target/readiness.js";
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
const MAX_RECIPE_FILE_BYTES = 512 * 1024;

/** `--recipe` is either the JSON itself or `@<path>` to a small JSON file. */
function readRecipeFlag(value: string): unknown {
	let text = value;
	if (value.startsWith("@")) {
		const path = resolve(value.slice(1));
		const entry = statSync(path);
		if (!entry.isFile()) throw new Error(`--recipe @${value.slice(1)} is not a regular file`);
		if (entry.size > MAX_RECIPE_FILE_BYTES) {
			throw new Error(`--recipe file exceeds ${MAX_RECIPE_FILE_BYTES} bytes`);
		}
		text = readFileSync(path, "utf8");
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error("--recipe must be a JSON object or @<path> to a JSON file", { cause: error });
	}
}

/**
 * The sealed slice for one inbox file. A file that already has one keeps it:
 * drawing a second slice would put previously sealed rows into development.
 */
function datasetHoldout(projectId: string, sourcePath: string): DatasetHoldoutSpec | null {
	const inForce = datasetHoldoutInForce(stateRoot(), projectId, sourcePath);
	const count = arg("sealed");
	const seed = arg("seed");
	const requested = count && seed
		? {
			count: Number(count),
			seed,
			...(arg("stratify-by") ? { stratifyBy: arg("stratify-by")! } : {}),
		} satisfies DatasetHoldoutSpec
		: null;
	if (inForce && requested && JSON.stringify(inForce) !== JSON.stringify(requested)) {
		throw new Error(
			`${sourcePath} already holds out ${inForce.count} row(s) with seed ${JSON.stringify(inForce.seed)}; ` +
				"repeat that exact sealed slice or use another file",
		);
	}
	return inForce ?? requested;
}

/** Skipped rows are reported as counts by reason; a row's contents never are. */
function skippedByReason(skipped: readonly { reason: string }[]): [string, number][] {
	const counts = new Map<string, number>();
	for (const row of skipped) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
	return [...counts.entries()].sort((left, right) => right[1] - left[1]);
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
		console.log(USAGE);
		process.exit(1);
	}
	return value;
}

/**
 * Primary product entry point: a real Builder Pi instance. The web process is
 * created lazily and remains a read-only projection of already-diagnosed runs.
 */
async function builderPi(sessionMode: BuilderSessionMode = "new"): Promise<void> {
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
	const explorer = createEvidenceExplorer({ runsRoot: runsRoot() });
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
		console.error(`usage error: ${error.message}\n`);
		console.error(USAGE);
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
			await builderPi();
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
				console.error("usage: ahde init <dir> [--template <target-dir>]\n");
				console.log(USAGE);
				process.exit(1);
			}
			const template = arg("template");
			const templateDir = template
				? resolve(template.startsWith("/") || template.startsWith(".") ? template : join(process.cwd(), template))
				: join(packageRoot, "templates", "basic-agent");
			scaffoldTarget(templateDir, resolve(dir));
			console.log(`scaffolded target → ${resolve(dir)} (template: ${template ?? "built-in basic-agent"})`);
			console.log("next: открой Builder Pi — он покажет exact one-time Target/model diff перед commit:");
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
			const baseTarget = loadTarget(resolve(requireArg("target")), dataset ? { dataset } : undefined);
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
				throw new Error("candidate runs require an exact matched baseline; use `ahde candidate` instead");
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
			console.log(
				`eval run ${record.evalRunId}: ${record.summary.pass}/${record.summary.total} all-pass ` +
					`(${record.summary.fail} fail, ${record.summary.error} error)`,
			);
			for (const runId of record.runIds) console.log(`  run ${runId}`);
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
			console.log(`  tasks: ${target.tasks.length} (${target.datasetHash.slice(7, 19)}…)`);
			console.log(`  suite: ${target.manifest.evalSuite.id} (${target.suiteHash.slice(7, 19)}…)`);
			console.log(`  skills: ${target.manifest.skills.join(", ") || "(none)"}`);
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
				console.log("  readiness: ready to run (credential present; provider access unverified)");
			}
			break;
		}
		case "list": {
			const targetId = arg("target");
			const listed = listEvalRunIndexesLenient(runsRoot());
			const runs = listed.records.filter((r) => !targetId || r.target.id === targetId);
			if (runs.length === 0 && listed.invalid.length === 0) {
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
			for (const entry of listed.invalid) {
				console.log(`${entry.evalRunId}  legacy · not comparable with the current evidence schema`);
			}
			if (listed.invalid.length > 0) {
				console.error(`note: ${listed.invalid.length} legacy eval run index(es) predate the current provenance axes and are never reused as baselines`);
			}
			break;
		}
		case "failures": {
			const evalRunId = positional(0);
			if (!evalRunId) {
				console.error(
					"usage: ahde failures <evalRunId> --target <dir> [--project <id>] [--dataset <rel>] [--out <path>]\n",
				);
				console.log(USAGE);
				process.exit(1);
			}
			const dataset = arg("dataset");
			const target = loadTarget(
				resolve(requireArg("target")),
				dataset ? { dataset } : undefined,
			);
			const evalRun = loadEvalRun(runsRoot(), evalRunId);
			const sourceTarget = resolveDevelopmentTargetForEval({
				target,
				evalRun,
				stateRoot: stateRoot(),
				projectId: arg("project") ?? target.manifest.id,
			}).target;
			const out = compileFailureBundle(sourceTarget, evalRun, runsRoot(), { outPath: arg("out") });
			console.log(out);
			break;
		}
		case "corpus": {
			const action = positional(0);
			const projectId = requireArg("project");
			if (action === "publish") {
				const visibility = requireArg("visibility");
				if (visibility !== "development" && visibility !== "sealed") {
					throw new Error(`--visibility must be development or sealed, got ${visibility}`);
				}
				const draft = loadBuilderCorpusDraft(stateRoot(), projectId, requireArg("draft"));
				const metadata = createCorpus({
					stateRoot: stateRoot(),
					projectId,
					name: requireArg("name"),
					visibility: visibility as CorpusVisibility,
					tasks: draft.tasks,
				});
				console.log(
					`${metadata.id}  ${metadata.visibility}  ${metadata.taskCount} tasks  ${metadata.hash}`,
				);
				console.log(`published from reviewed draft ${draft.id}`);
				break;
			}
			if (action === "import") {
				const visibility = requireArg("visibility");
				if (visibility !== "development" && visibility !== "sealed") {
					throw new Error(`--visibility must be development or sealed, got ${visibility}`);
				}
				const metadata = importCorpus({
					stateRoot: stateRoot(),
					projectId,
					name: requireArg("name"),
					visibility: visibility as CorpusVisibility,
					sourcePath: resolve(requireArg("file")),
				});
				console.log(
					`${metadata.id}  ${metadata.visibility}  ${metadata.taskCount} tasks  ${metadata.hash}`,
				);
				if (visibility === "sealed" && metadata.taskCount < SEALED_GATE_POLICY.minTasks) {
					console.error(
						`warning: a sealed holdout of ${metadata.taskCount} case(s) can never produce a sealed verdict; ` +
							`the guardrail needs at least ${SEALED_GATE_POLICY.minTasks} cases and ` +
							`${SEALED_GATE_POLICY.minRepetitions} repetitions, and stays underpowered below that`,
					);
				}
				break;
			}
			if (action === "inspect") {
				const sourcePath = requireArg("file");
				const preview = inspectDatasetFile({
					projectDir: process.cwd(),
					sourcePath,
					holdout: datasetHoldout(projectId, sourcePath),
				});
				console.log(renderDataset({ sourcePath, preview }, plainPaint).join("\n"));
				break;
			}
			if (action === "ingest") {
				const sourcePath = requireArg("file");
				const result = ingestDataset({
					projectDir: process.cwd(),
					stateRoot: stateRoot(),
					projectId,
					sourcePath,
					recipe: readRecipeFlag(requireArg("recipe")),
					holdout: datasetHoldout(projectId, sourcePath),
					developmentName: requireArg("name"),
				});
				// The development cases are published here so a scripted ingest ends
				// with something runnable; the reviewed Builder flow drafts instead.
				const development = createCorpus({
					stateRoot: stateRoot(),
					projectId,
					name: result.developmentName,
					visibility: "development",
					tasks: result.tasks,
				});
				const receipt = result.receipt;
				console.log(`source        ${receipt.sourcePath}  ${receipt.format}  ${receipt.sourceSha256}`);
				console.log(`recipe        ${receipt.recipeSha256}`);
				console.log(`rows          ${receipt.rowsSeen} seen  ${result.skipped.length} skipped`);
				console.log(`development   ${development.id}  ${development.taskCount} tasks  ${development.hash}`);
				console.log(
					receipt.sealed
						? `sealed        ${receipt.sealed.corpusId}  ${receipt.sealed.count} tasks  seed ${receipt.sealed.seed}`
						: "sealed        none reserved",
				);
				console.log(`receipt       ${result.receiptPath}`);
				for (const [reason, count] of skippedByReason(result.skipped)) {
					console.error(`warning: ${count} row(s) skipped: ${reason}`);
				}
				if (receipt.sealed && receipt.sealed.count < SEALED_GATE_POLICY.minTasks) {
					console.error(
						`warning: a sealed holdout of ${receipt.sealed.count} case(s) can never produce a sealed verdict; ` +
							`the guardrail needs at least ${SEALED_GATE_POLICY.minTasks} cases`,
					);
				}
				break;
			}
			if (action === "list") {
				const corpora = listCorpora({ stateRoot: stateRoot(), projectId });
				if (corpora.length === 0) console.log("no corpora");
				for (const corpus of corpora) {
					console.log(
						`${corpus.id}  ${corpus.visibility.padEnd(11)} ${String(corpus.taskCount).padStart(4)} tasks  ${corpus.name}`,
					);
				}
				break;
			}
			throw new Error("usage: ahde corpus publish|import|list|inspect|ingest --project <id> ...");
		}
		case "compare": {
			const a = positional(0);
			const b = positional(1);
			if (!a || !b) {
				console.error("usage: ahde compare <evalRunA> <evalRunB>\n");
				console.log(USAGE);
				process.exit(1);
			}
			const result = compareEvalRuns(runsRoot(), a, b, { mode: "exploratory" });
			console.log(renderCompareMarkdown(result));
			if (result.error) process.exit(2);
			break;
		}
		case "diagnose": {
			const evalRunId = positional(0);
			if (!evalRunId) {
				console.error("usage: ahde diagnose <evalRunId>\n");
				console.log(USAGE);
				process.exit(1);
			}
			const diagnosis = diagnoseEvalRun(runsRoot(), evalRunId);
			const brief = compileImprovementBrief(runsRoot(), diagnosis);
			console.log(
				`diagnosis ${diagnosis.diagnosisId}: ${diagnosis.status} — ` +
					`${diagnosis.summary.issueCount} issue(s), ${diagnosis.summary.infrastructureErrors} infrastructure error(s)`,
			);
			console.log(brief.headline);
			console.log(
				brief.proposalEligible
					? "proposal gate: eligible for exact human review"
					: "proposal gate: blocked; mode suggestions are diagnostic guidance only",
			);
			for (const mode of brief.modes) {
				const decision = !brief.proposalEligible && mode.decision === "propose-harness-change"
					? `${mode.decision} (blocked by global gate)`
					: mode.decision;
				console.log(
					`  ${mode.severity.padEnd(8)} ${mode.scope.padEnd(10)} ${mode.title} — ` +
						`${mode.impact.affectedTasks}/${mode.impact.totalTasks} task(s), ${mode.evidenceStrength} evidence, ${decision}`,
				);
				console.log(`    hypothesis: ${mode.hypothesis}`);
			}
			if (brief.modes.length > 0 && diagnosis.issues.length > 0) console.log("Task-level drill-down:");
			for (const issue of diagnosis.issues.slice(0, 30)) {
				console.log(
					`  ${issue.severity.padEnd(8)} ${redactTraceText(issue.taskId).slice(0, 500)} · ` +
					`${issue.category}: ${redactTraceText(issue.rootCause).slice(0, 1_000)}`,
				);
			}
			if (diagnosis.issues.length > 30) {
				console.log(`  ... ${diagnosis.issues.length - 30} task-level issue(s) omitted; open the evidence report for bounded drill-down.`);
			}
			console.log(`evidence: ${resolve(runsRoot(), evalRunId, "diagnosis.json")}`);
			if (diagnosis.status === "inconclusive") process.exitCode = 2;
			break;
		}
		case "report": {
			const evalRunId = positional(0);
			if (!evalRunId) {
				console.error("usage: ahde report <evalRunId> [--out <path>]\n");
				console.log(USAGE);
				process.exit(1);
			}
			const outputPath = buildEvalReport(
				runsRoot(),
				evalRunId,
				arg("out") ? resolve(arg("out") as string) : undefined,
			);
			console.log(outputPath);
			break;
		}
		case "candidate": {
				const holdoutCorpusId = arg("holdout-corpus");
				const developmentCorpusId = arg("development-corpus");
				const targetDir = resolve(requireArg("target"));
				const projectId = arg("project") ?? loadTarget(targetDir).manifest.id;
				const builderRunId = arg("builder-run");
				const requestedSpecId = arg("spec");
				const builderRun = builderRunId ? loadBuilderProposalRun(runsRoot(), builderRunId) : undefined;
				if (builderRun && !builderRun.request.approvedSpec) {
					throw new Error(`builder run ${builderRunId} is legacy evidence without an approved Spec`);
				}
				if (builderRun?.request.approvedSpec?.projectId !== undefined &&
					builderRun.request.approvedSpec.projectId !== projectId) {
					throw new Error(`builder run ${builderRunId} belongs to project ${builderRun.request.approvedSpec.projectId}`);
				}
				const specId = requestedSpecId ?? builderRun?.request.approvedSpec?.specId ??
					listSpecSnapshots(stateRoot(), projectId).find((snapshot) => snapshot.status === "approved")?.id;
				const requestedSpec = specId ? loadSpecSnapshot(stateRoot(), projectId, specId) : undefined;
				if (requestedSpec && requestedSpec.status !== "approved") {
					throw new Error(`candidate specification ${requestedSpec.id} is not approved`);
				}
				if (builderRun && !specId) throw new Error("applied Builder candidates require an approved Spec");
				const repetitions = arg("repetitions") ? Number(arg("repetitions")) : DEFAULT_REPETITIONS;
				const jobs = arg("jobs") ? Number(arg("jobs")) : undefined;
				const baselineMaxAgeDays = arg("baseline-max-age") ? Number(arg("baseline-max-age")) : undefined;
				const baselineMaxAgeMs = baselineMaxAgeDays === undefined
					? undefined
					: baselineMaxAgeDays * 24 * 60 * 60 * 1_000;
				const sealedCorpus = holdoutCorpusId
					? { stateRoot: stateRoot(), projectId, corpusId: holdoutCorpusId }
					: undefined;
				const developmentCorpus = developmentCorpusId
					? { stateRoot: stateRoot(), projectId, corpusId: developmentCorpusId }
					: undefined;
				let result: Awaited<ReturnType<typeof runCandidateExperiment>>;
				if (builderRunId) {
					result = await runAppliedBuilderCandidate({
						repositoryDir: targetDir,
						runsRoot: runsRoot(),
						builderRunId,
						projectId,
						approvedSpec: specId ? { stateRoot: stateRoot(), specId } : undefined,
						repetitions,
						dataset: arg("dataset"),
						developmentCorpus,
						actorId: arg("actor"),
						sealedCorpus,
						...(jobs === undefined ? {} : { jobs }),
						...(baselineMaxAgeMs === undefined ? {} : { baselineMaxAgeMs }),
					});
				} else {
					result = await runCandidateExperiment({
						runsRoot: runsRoot(),
						repositoryDir: targetDir,
						baselineRef: requireArg("base"),
						candidateRef: requireArg("branch"),
						mode: "candidate",
						repetitions,
						dataset: arg("dataset"),
						developmentCorpus,
						projectId,
						specId,
						proposalId: requireArg("proposal"),
						diagnosisId: requireArg("diagnosis"),
						actorId: arg("actor"),
						sealedCorpus,
						...(jobs === undefined ? {} : { jobs }),
						...(baselineMaxAgeMs === undefined ? {} : { baselineMaxAgeMs }),
					});
				}
				console.log(renderCompareMarkdown(result.compare));
				console.log(`\ncandidate eval run: ${result.candidate.evalRunId} (baseline: ${result.baseline.evalRunId})`);
				console.log(`design: ${result.designHash}`);
				console.log(`candidate record: ${result.record.candidateId}`);
				if (result.developmentCorpus) {
					console.log(
						`development corpus: ${result.developmentCorpus.id} (${result.developmentCorpus.hash})`,
					);
				}
				if (result.sealedHoldout) {
					console.log(
						`sealed holdout: ${result.sealedHoldout.baseline.evalRunId} → ` +
							`${result.sealedHoldout.candidate.evalRunId}`,
				);
			} else {
				console.log("sealed holdout: not run (promotion will remain locked)");
			}
				console.log(
					`\nnext: ahde review --candidate ${result.record.candidateId} ` +
					`--recommend promote|reject --reason <text>`,
			);
			break;
		}
		case "calibrate": {
			const targetDir = resolve(requireArg("target"));
			const corpusId = arg("corpus");
			const projectId = arg("project") ?? loadTarget(targetDir).manifest.id;
			const repetitions = arg("repetitions") ? Number(arg("repetitions")) : DEFAULT_REPETITIONS;
			const developmentCorpus = corpusId
				? { stateRoot: stateRoot(), projectId, corpusId }
				: undefined;
			const baseTarget = loadTarget(targetDir);
			assertTargetReadyToRun(
				developmentCorpus
					? targetWithDevelopmentCorpus(baseTarget, loadCorpus(developmentCorpus))
					: baseTarget,
			);
			// One revision, both arms: the A/A CandidateRecord is the receipt.
			const head = resolveCommitRef(targetDir, "HEAD");
			const result = await runCandidateExperiment({
				repositoryDir: targetDir,
				runsRoot: runsRoot(),
				baselineRef: head,
				candidateRef: head,
				mode: "aa-calibration",
				repetitions,
				projectId,
				origin: { kind: "manual", reason: "A/A calibration" },
				...(developmentCorpus ? { developmentCorpus } : {}),
				onRunEvent: cliRunProgress(),
			});
			const calibration = calibrationProjection(result.record);
			if (!calibration) throw new Error("calibration produced no development verdict; nothing was measured");
			for (const line of renderCalibration(calibration, plainPaint)) console.log(line);
			console.log(`calibration record: ${result.record.candidateId}`);
			break;
		}
		case "review": {
			const recommendation = requireArg("recommend");
			if (recommendation !== "promote" && recommendation !== "reject") {
				throw new Error(`--recommend must be promote or reject, got ${recommendation}`);
			}
			const record = reviewCandidate({
				runsRoot: runsRoot(),
				candidateId: requireArg("candidate"),
				recommendation,
				reason: requireArg("reason"),
				actorId: arg("actor"),
			});
			console.log(`reviewed candidate ${record.candidateId}: ${recommendation}`);
			break;
		}
		case "promote": {
			const result = promoteReviewedCandidate({
				repositoryDir: resolve(requireArg("target")),
				candidateId: requireArg("candidate"),
				version: requireArg("to"),
				reason: requireArg("reason"),
				actorId: arg("actor"),
				runsRoot: runsRoot(),
			});
			console.log(`promoted candidate ${result.record.candidateId}: tag ${result.tag} at ${result.candidateSha}`);
			break;
		}
		case "reject": {
			const record = decideCandidateRejection({
				candidateId: requireArg("candidate"),
				runsRoot: runsRoot(),
				reason: requireArg("reason"),
				actorId: arg("actor"),
			});
			console.log(`rejected candidate ${record.candidateId} (recorded in candidate evidence)`);
			break;
		}
		default:
			console.log(USAGE);
			process.exit(1);
	}
}

function cliFailure(error: unknown): { message: string; next?: string } {
	const message = redactTraceText(error instanceof Error ? error.message : String(error)).slice(0, 4_000);
	if (/requires an interactive terminal|requires TTY stdin and stdout/i.test(message)) {
		return {
			message: "This command needs an interactive terminal (TTY).",
			next: "Run it directly in a terminal. For automation, use the non-interactive `ahde run`, `ahde validate`, or library API.",
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

main().catch((error: unknown) => {
	const failure = cliFailure(error);
	console.error(`error: ${failure.message}`);
	if (failure.next) console.error(`next: ${failure.next}`);
	process.exitCode = 1;
});
