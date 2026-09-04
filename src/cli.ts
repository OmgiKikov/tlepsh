import { dirname, join, resolve } from "node:path";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { describeEnvVar, loadDotEnv, type EnvReport } from "./env.js";
import { loadTarget, scaffoldTarget } from "./manifest.js";
import {
	listEvalRunIndexesLenient,
	loadRun,
	readEvalRunIndex,
	renderEvalRunListLine,
	renderRunTurns,
	runSuite,
} from "./eval.js";
import { judgeAgreement } from "./domain/judge-agreement.js";
import { kappaValue, money, percent } from "./measurement.js";
import { evaluatorReadiness } from "./application/configure-evaluators.js";
import {
	importJudgeLabels,
	judgeEvidenceCalibration,
	judgeLabelFilePath,
	readProjectJudgeLabels,
	runJudgeLabelSession,
	type JudgeLabelSubject,
} from "./application/judge-labels.js";
import { renderCompareMarkdown } from "./compare.js";
import {
	isRegradeLabel,
	readGraderDefaults,
	regradeEvalRun,
	renderRegradeSummary,
} from "./regrade.js";
import {
	corpusTaskLookup,
	DatasetExportError,
	datasetExportOptionsFromFlags,
	exportDataset,
	renderDatasetExportSummary,
} from "./application/export-dataset.js";
import { runCandidateExperiment } from "./application/candidate-experiment.js";
import {
	renderCheapCheckLine,
	runCheapCheckForCandidate,
} from "./application/cheap-check.js";
import { renderCandidateVerdictLines } from "./application/candidate-verdict.js";
import {
	assertScaffoldableTargetLocation,
	assertUntrackedEngineStore,
	renderLocalArtifactIgnoreLine,
} from "./application/store-hygiene.js";
import {
	compileVersionPassport,
	renderVersionPassportMarkdown,
} from "./application/version-passport.js";
import {
	abandonImprovementLoop,
	improvementLoopGate,
	listUnfinishedImprovementLoops,
	MAX_IMPROVEMENT_CYCLES,
	plannedImprovementExecutions,
	recordedBuilderProposalAuthor,
	renderImprovementLoopTable,
	runImprovementLoop,
	UnfinishedImprovementLoopError,
} from "./application/improvement-loop.js";
import {
	MAX_SEARCH_CANDIDATES,
	proposalSearchGate,
	renderProposalSearchTable,
	runProposalSearch,
} from "./application/proposal-search.js";
import { unattendedGate } from "./application/restricted-gate.js";

import { runAppliedBuilderCandidate } from "./application/builder-candidate.js";
import { diagnoseEvalRun } from "./diagnosis.js";
import { compileImprovementBrief } from "./application/improvement-brief.js";
import { redactTraceText } from "./trace.js";
import { buildEvalReport } from "./report.js";
import {
	decideCandidateRejection,
	loadCandidateRecord,
	promoteReviewedCandidate,
	reviewCandidate,
} from "./application/candidate-review.js";
import { createCorpus, importCorpus, listCorpora, loadCorpus, type CorpusVisibility } from "./corpus.js";
import { runTargetFeedbackCommand } from "./application/target-feedback.js";
import {
	datasetHoldoutInForce,
	ingestDataset,
	inspectDatasetFile,
	type DatasetHoldoutSpec,
} from "./application/dataset-ingest.js";
import {
	recordSealedSynthReviewImport,
	renderSealedSynthOutput,
	SealedSynthRefusal,
	synthesizeSealedCorpus,
} from "./application/sealed-synth.js";
import { loadBuilderProposalRun } from "./application/builder-proposal.js";
import { describeFixtureRun, readTryToolInput, runToolFixtures, tryTool } from "./application/tool-workshop.js";
import {
	resolveScoredCasesForEval,
	targetWithDevelopmentCorpus,
} from "./application/corpus-target.js";
import { listSpecSnapshots, loadApprovedSpec, loadSpecSnapshot, type ApprovedSpecReference } from "./spec.js";
import {
	createEvidenceExplorer,
	type EvidenceExplorer,
	type EvidenceExplorerAddress,
} from "./evidence/server.js";
import { launchBuilderPi, resolveBuilderAssets, type BuilderSessionMode } from "./builder/runtime.js";
import { createAhdeServeApi } from "./serve/server.js";
import { renderCalibration } from "./builder/render/calibration.js";
import { renderDataset } from "./builder/render/view.js";
import { plainPaint } from "./builder/render/paint.js";
import { DEFAULT_REPETITIONS, calibrationProjection } from "./workbench/calibration.js";
import { candidateProposalReview } from "./workbench/resolution.js";
import { resolveCommitRef } from "./git/experiment-worktree.js";
import { SEALED_GATE_POLICY } from "./domain/comparison-gate.js";
import { describeSandboxReadiness } from "./target/container-backend.js";
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
	parseCandidateIdList,
	parseCliInvocation,
	parseDurationFlag,
	parsePassRateFlag,
} from "./cli-invocation.js";
import { cliHelp } from "./cli-help.js";
// Wave 3 operator surfaces: the agent's growth, and the ground under it.
import { compileAgentLog } from "./application/agent-log.js";
import { runWatch } from "./application/watch.js";
import { renderAgentLog } from "./builder/render/agent-log.js";
import { renderWatchTick, renderWatchTickDetail } from "./builder/render/watch.js";

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

/**
 * Where one eval run is read from when the operator is standing somewhere else.
 * `AHDE_RUNS_DIR` still wins, as it does everywhere; without it a named Target
 * carries its own `runs/`, the same place Builder Pi and `ahde serve` look.
 * Without either it is the current directory, exactly as it always was.
 */
function runsRootForTarget(targetDir: string | undefined): string {
	if (process.env.AHDE_RUNS_DIR) return resolve(process.env.AHDE_RUNS_DIR);
	return targetDir ? resolve(targetDir, "runs") : resolve(process.cwd(), "runs");
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
		console.log(cliHelp(process.argv.slice(2)));
		process.exit(2);
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
	// With a project the explorer can read that project's human judge labels and
	// report the same calibration `ahde report` does; without one it says the
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

/** A flag that takes no value; `arg()` would read the next token instead. */
function flagPresent(name: string): boolean {
	return process.argv.slice(2).includes(`--${name}`);
}

/**
 * The Workbench behind a loopback HTTP/JSON API. The platform's backend drives
 * the same operations and renders the same confirmations; the gate is injected,
 * never removed, and the token is printed exactly once, here, to stderr.
 */
async function serveWorkbench(): Promise<void> {
	const projectDir = resolve(arg("target") ?? process.cwd());
	const serveStateRoot = process.env.AHDE_STATE_DIR
		? resolve(process.env.AHDE_STATE_DIR)
		: join(projectDir, ".ahde");
	const serveRunsRoot = process.env.AHDE_RUNS_DIR
		? resolve(process.env.AHDE_RUNS_DIR)
		: join(projectDir, "runs");
	const timeout = arg("confirmation-timeout");
	const api = createAhdeServeApi({
		projectDir,
		stateRoot: serveStateRoot,
		runsRoot: serveRunsRoot,
		templateDir: resolveBuilderAssets(packageRoot).targetTemplateDir,
		...(arg("project") ? { projectId: arg("project")! } : {}),
		...(arg("host") ? { host: arg("host")! } : {}),
		...(arg("token-file") ? { tokenFile: arg("token-file")! } : {}),
		...(timeout ? { confirmationTimeoutSeconds: Number(timeout) } : {}),
		...(flagPresent("allow-concurrent") ? { allowConcurrent: true } : {}),
	});
	const address = await api.listen(Number(arg("port") ?? "0"));
	// The token is a credential: stderr once, never a log line, never a response.
	process.stderr.write(`AHDE serve token: ${api.token}\n`);
	console.log(`AHDE serve: ${address.url} · project ${api.projectId} · operator ${api.actorId}`);
	console.log("loopback only · bearer token required · consequential decisions wait for POST /v1/confirmations/<id>");
	console.log("press Ctrl-C to stop; a pending confirmation is refused on shutdown");
	await new Promise<void>((resolveStop) => {
		const stop = (): void => {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
			void api.close().finally(resolveStop);
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

/**
 * Labels live under a project, and a report is asked for by eval run alone.
 * The eval run's own Target id is the same default every other command uses.
 */
/**
 * The recorded dataset. A pure read over durable development evidence: no
 * model call, no Target execution, and the only thing written is the JSONL.
 *
 * Missing or unexportable artifacts exit 2 rather than 1: a dataset that was
 * silently short but looked like success is exactly the failure whoever
 * receives it cannot detect.
 */
function exportRecordedDataset(flags: Readonly<Record<string, string>>): void {
	const targetDir = resolve(flags.target ?? process.cwd());
	const projectId = flags.project ?? loadTarget(targetDir).manifest.id;
	let result;
	try {
		// The parser's own flag map, not process.argv: `arg()` reads the token
		// after a flag, which is nothing at all for a value-less `--all`.
		result = exportDataset(datasetExportOptionsFromFlags(flags, {
			runsRoot: runsRootForTarget(flags.target),
			outRoot: targetDir,
			sealedDatasetHashes: sealedCorpusHashes(projectId),
			tasks: corpusTaskLookup({ stateRoot: stateRoot(), projectId }),
		}));
	} catch (error) {
		if (!(error instanceof DatasetExportError)) throw error;
		console.error(`error: ${error.message}`);
		process.exitCode = 2;
		return;
	}
	for (const line of renderDatasetExportSummary(result)) console.log(line);
}

function reportProjectId(evalRunId: string): string {
	const explicit = arg("project");
	if (explicit) return explicit;
	// `--target <dir>` names it the way `ahde passport` does, from the manifest;
	// without one the eval run's own recorded Target id is the same default it
	// always was.
	const targetDir = arg("target");
	if (targetDir) return loadTarget(resolve(targetDir)).manifest.id;
	return readEvalRunIndex(runsRoot(), evalRunId).target.id;
}

/**
 * Bind new calibration labels to one immutable approved Spec when possible.
 * Multiple approved Specs are never guessed between: an ambiguous receipt is
 * worse than no receipt because a promotion might mistake it for authority.
 */
function labelApprovedSpec(projectId: string): ApprovedSpecReference | undefined {
	const explicit = arg("spec");
	if (explicit) {
		return loadApprovedSpec({ stateRoot: stateRoot(), projectId, specId: explicit }).reference;
	}
	const approved = listSpecSnapshots(stateRoot(), projectId)
		.filter((snapshot) => snapshot.status === "approved");
	if (approved.length === 0) return undefined;
	if (approved.length > 1) {
		throw new Error(
			`project ${projectId} has ${approved.length} approved Specs; pass --spec <id> so labels get one exact lineage receipt`,
		);
	}
	return loadApprovedSpec({ stateRoot: stateRoot(), projectId, specId: approved[0]!.id }).reference;
}

/** Sealed corpus content hashes, so a legacy sealed eval run is refused too. */
function sealedCorpusHashes(projectId: string): Set<string> {
	try {
		return new Set(
			listCorpora({ stateRoot: stateRoot(), projectId })
				.filter((corpus) => corpus.visibility === "sealed")
				.map((corpus) => corpus.hash),
		);
	} catch {
		return new Set();
	}
}

/**
 * Exactly what the judge was shown, in the judge's own order: what the person
 * wanted, what the agent said (or the whole conversation), the reference answer
 * when the judge was given one, and the question it was asked. A human grading
 * anything less is not calibrating this judge.
 */
function labelSubjectBlock(subject: JudgeLabelSubject, ordinal: number, total: number): string {
	const lines = [
		"",
		`── ${ordinal}/${total} · ${subject.taskId} · ${subject.graderName}`,
		...(subject.subject === "legacy"
			? ["(legacy screen: the suite that graded this evidence is not in scope, so the judge's own", " rubric and reference cannot be shown — these labels are excluded from requireCalibration)", ""]
			: []),
		subject.kind === "dialogue" ? "goal:" : "task:",
		subject.input || "(no recorded task input)",
		"",
		subject.kind === "dialogue" ? "conversation:" : "answer:",
		subject.answer || "(no final answer)",
		"",
	];
	if (subject.reference !== null) lines.push("reference answer:", subject.reference, "");
	if (subject.rubric !== null) lines.push("rubric:", subject.rubric, "");
	if (subject.assertions) {
		lines.push("assertions — answer each yes / no / unknown:");
		lines.push(...subject.assertions.map((assertion, index) => `  ${index + 1}. ${assertion}`), "");
	}
	return lines.join("\n");
}

/** One tick per assertion; the overall verdict follows from the ticks. */
async function askAssertionChecklist(
	io: { question: (prompt: string) => Promise<string> },
	assertions: readonly string[],
): Promise<("yes" | "no" | "unknown")[]> {
	const answers: ("yes" | "no" | "unknown")[] = [];
	for (const [index, assertion] of assertions.entries()) {
		let raw = "";
		while (!["yes", "no", "unknown", "y", "n", "u"].includes(raw)) {
			raw = (await io.question(`  ${index + 1}. ${assertion}\n     yes / no / unknown: `)).trim().toLowerCase();
		}
		answers.push(raw.startsWith("y") ? "yes" : raw.startsWith("n") ? "no" : "unknown");
	}
	return answers;
}

/**
 * Blind human labelling, then the judge's verdict. The order is the whole
 * point: a human shown the judge's answer first is grading the judge's
 * confidence, not the Target's answer.
 */
async function labelJudge(): Promise<void> {
	const evalRunId = positional(0);
	if (!evalRunId) {
		console.error("usage: ahde label <evalRunId> --target <dir> [--project <id>] [--spec <approvedSpecId>] [--sample N] [--seed <text>] [--file <labels.jsonl>]\n");
		console.log(USAGE);
		process.exit(2);
	}
	const targetDir = resolve(requireArg("target"));
	const target = loadTarget(targetDir);
	const projectId = arg("project") ?? target.manifest.id;
	const approvedSpec = labelApprovedSpec(projectId);
	const file = arg("file");
	const context = {
		runsRoot: runsRoot(),
		stateRoot: stateRoot(),
		projectId,
		evalRunId,
		...(approvedSpec ? { approvedSpec } : {}),
		sealedDatasetHashes: sealedCorpusHashes(projectId),
		// The suite is what makes the screen show the judge's own subject: the
		// rubric it was asked, the assertions it answered, the reference answer it
		// compared against. It is used only when its hashes match the evidence.
		suite: {
			datasetHash: target.datasetHash,
			suiteHash: target.suiteHash,
			tasks: target.tasks,
		},
	};
	if (file) {
		const rows = importJudgeLabels({ ...context, filePath: resolve(file) });
		console.log(`imported ${rows.length} label(s) into ${judgeLabelFilePath(stateRoot(), projectId, evalRunId)}`);
		printJudgeAgreement(projectId, evalRunId);
		return;
	}
	if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
		throw new Error("ahde label needs an interactive terminal (TTY), or --file <labels.jsonl> to import answers");
	}
	const io = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const session = await runJudgeLabelSession({
			...context,
			...(arg("sample") ? { sample: Number(arg("sample")) } : {}),
			...(arg("seed") ? { seed: arg("seed")! } : {}),
			prompt: {
				ask: async (subject, ordinal, total) => {
					process.stdout.write(labelSubjectBlock(subject, ordinal, total));
					if (subject.assertions) {
						// The checklist IS the verdict: a rubric of independent checks
						// passes only when every one of them holds, so asking for a
						// pooled pass/fail as well would invite them to disagree.
						const skip = (await io.question("label this check? (enter to grade, s to skip): ")).trim().toLowerCase();
						if (skip.startsWith("s")) return { answer: "skip" as const };
						const assertions = await askAssertionChecklist(io, subject.assertions);
						const note = (await io.question("note (optional): ")).trim();
						return {
							answer: assertions.every((entry) => entry === "yes") ? "pass" as const : "fail" as const,
							assertions,
							...(note ? { note } : {}),
						};
					}
					let answer = "";
					while (!["pass", "fail", "skip", "p", "f", "s"].includes(answer)) {
						answer = (await io.question("your verdict — pass / fail / skip: ")).trim().toLowerCase();
					}
					const decided = answer.startsWith("p") ? "pass" : answer.startsWith("f") ? "fail" : "skip";
					if (decided === "skip") return { answer: decided };
					const note = (await io.question("note (optional): ")).trim();
					return { answer: decided, ...(note ? { note } : {}) };
				},
				reveal: (subject, answer) => {
					const agreement = answer === "skip"
						? "skipped"
						: answer === subject.judge ? "agrees with you" : "DISAGREES with you";
					process.stdout.write(`judge said ${subject.judge} · ${agreement}\n  ${subject.judgeReason}\n`);
				},
			},
		});
		console.log(`\n${session.labelled} label(s) written, ${session.skipped} skipped`);
	} finally {
		io.close();
	}
	printJudgeAgreement(projectId, evalRunId);
}

function printJudgeAgreement(projectId: string, evalRunId?: string): void {
	const report = evalRunId
		? (() => {
			const exact = judgeEvidenceCalibration({
				runsRoot: runsRoot(),
				stateRoot: stateRoot(),
				projectId,
				evalRunIds: [evalRunId],
			});
			return {
				byGrader: [...exact.byGraderSpecHash.entries()]
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([graderSpecHash, stats]) => ({ graderSpecHash, ...stats })),
				pooled: exact.stats,
			};
		})()
		: (() => {
			const raw = judgeAgreement(readProjectJudgeLabels(stateRoot(), projectId));
			return { byGrader: raw.byGrader, pooled: raw.pooled };
		})();
	if (!report.pooled || (
		report.pooled.n === 0 &&
		report.pooled.duplicateLabels === 0 &&
		report.pooled.conflictedSubjects === 0
	)) {
		console.log("judge not calibrated — no independent labels yet for this eval lineage");
		return;
	}
	console.log("grader spec           agreement   κ    subjects  checks  repeats  conflicts  false-pass  false-fail");
	for (const grader of [...report.byGrader, { graderSpecHash: "pooled", ...report.pooled }]) {
		console.log(
			`${grader.graderSpecHash.replace("sha256:", "").slice(0, 20).padEnd(20)}  ` +
				`${percent(grader.agreement).padStart(8)}  ` +
				`${kappaValue(grader.kappa).padStart(6)}  ` +
				`${String(grader.n).padStart(8)}  ${String(grader.nChecks).padStart(6)}  ` +
				`${String(grader.duplicateLabels).padStart(7)}  ${String(grader.conflictedSubjects).padStart(9)}  ` +
				`${String(grader.falsePass).padStart(10)}  ${String(grader.falseFail).padStart(10)}`,
		);
	}
}

/**
 * The basket on a schedule. Every tick is ordinary development evidence on the
 * ACTIVE revision, and the pair it forms with the previous tick is an A/A
 * experiment — so `inconclusive` is the healthy answer and anything else on an
 * unchanged revision is drift. Nothing durable changes beyond the eval run the
 * tick produced.
 */
async function watchTarget(): Promise<void> {
	const targetDir = resolve(requireArg("target"));
	const corpusId = arg("corpus");
	const baseTarget = loadTarget(targetDir);
	const projectId = arg("project") ?? baseTarget.manifest.id;
	const target = corpusId
		? targetWithDevelopmentCorpus(baseTarget, loadCorpus({ stateRoot: stateRoot(), projectId, corpusId }))
		: baseTarget;
	assertTargetReadyToRun(target);
	const every = arg("every");
	const everyMs = every ? parseDurationFlag(every) : null;
	const maxRuns = arg("max-runs");
	const controller = new AbortController();
	const stop = (): void => {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		process.stderr.write("\nAHDE watch: stopping after the current tick\n");
		controller.abort();
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		const result = await runWatch({
			target,
			runsRoot: runsRoot(),
			projectId,
			repetitions: Number(arg("repetitions") ?? String(DEFAULT_REPETITIONS)),
			...(everyMs !== null ? { everyMs } : {}),
			...(maxRuns ? { maxRuns: Number(maxRuns) } : {}),
			...(arg("jobs") ? { jobs: Number(arg("jobs")) } : {}),
			signal: controller.signal,
			onRunEvent: cliRunProgress(),
			onTick: (tick) => {
				console.log(renderWatchTick(tick, plainPaint));
				for (const line of renderWatchTickDetail(tick, plainPaint)) console.log(line);
			},
		});
		process.exitCode = result.exitCode;
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
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
				process.exit(2);
			}
			const template = arg("template");
			const templateDir = template
				? resolve(template.startsWith("/") || template.startsWith(".") ? template : join(process.cwd(), template))
				: join(packageRoot, "templates", "basic-agent");
			// A new Target inside a checkout that already committed an engine
			// store inherits its problem: the sealed exam is already a Git object
			// there, and a scaffold would quietly add a second store beside it.
			assertScaffoldableTargetLocation(resolve(dir));
			let ignoreLine: string | null = null;
			scaffoldTarget(templateDir, resolve(dir), (added) => {
				ignoreLine = renderLocalArtifactIgnoreLine(added);
			});
			console.log(`scaffolded target → ${resolve(dir)} (template: ${template ?? "built-in basic-agent"})`);
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
		case "serve": {
			await serveWorkbench();
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
			// the manifest hopes for. A container backend starts its own
			// comparability class: baselines recorded on the host are not reusable
			// against it, by design.
			const sandboxReadiness = describeSandboxReadiness(target.manifest.execution);
			console.log(`  ${sandboxReadiness.line}`);
			const gitDisplay = target.gitSha.includes("-dirty-")
				? `${target.gitSha.slice(0, 8)} (dirty ${target.gitSha.split("-dirty-")[1]})`
				: target.gitSha.slice(0, 8);
			console.log(`  git: ${gitDisplay} | pi: ${target.runtime.piVersion}@${target.runtime.piSha.slice(0, 8)}`);
			console.log(`  ahde: ${target.runtime.ahdeVersion}@${target.runtime.ahdeCodeHash.slice(7, 19)}…`);
			if (sandboxReadiness.failClosed) {
				console.log("  readiness: ACTION REQUIRED — the declared containment cannot be honoured on this host");
				process.exitCode = 2;
			} else if (readiness.bootstrapRequired) {
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
		case "list": {
			const targetId = arg("target");
			const listed = listEvalRunIndexesLenient(runsRoot());
			const runs = listed.records.filter((r) => !targetId || r.target.id === targetId);
			if (runs.length === 0 && listed.invalid.length === 0) {
				console.log("no eval runs");
				break;
			}
			for (const run of runs) {
				console.log(renderEvalRunListLine(run));
			}
			for (const entry of listed.invalid) {
				console.log(`${entry.evalRunId}  legacy · not comparable with the current evidence schema`);
			}
			if (listed.invalid.length > 0) {
				console.error(`note: ${listed.invalid.length} legacy eval run index(es) predate the current provenance axes and are never reused as baselines`);
			}
			break;
		}
		case "corpus": {
			const action = positional(0);
			// The Target's manifest id is the project every other command already
			// defaults to; a corpus imported under any other name is refused later
			// by `ahde candidate`, which is exactly the trap this closes.
			const corpusTargetDir = arg("target") ? resolve(arg("target")!) : null;
			const projectId = arg("project") ??
				(corpusTargetDir ? loadTarget(corpusTargetDir).manifest.id : requireArg("project"));
			// `--file imports/<name>` is read from the Target when one is named,
			// and from the current directory otherwise, as it always was.
			const corpusProjectDir = corpusTargetDir ?? process.cwd();
			if (action === "synth") {
				// The action that WRITES a holdout instead of drawing one, so the
				// Target is required rather than one of two ways to say the project:
				// the manifest is where the judge lives.
				const targetDir = corpusTargetDir ?? resolve(requireArg("target"));
				let result;
				try {
					result = await synthesizeSealedCorpus({
						targetDir,
						stateRoot: stateRoot(),
						projectId,
						name: requireArg("name"),
						count: Number(requireArg("sealed")),
						...(arg("from-kb") ? { source: "kb" as const } : {}),
						...(arg("seed") ? { seed: arg("seed")! } : {}),
						...(arg("from") ? { specPath: resolve(arg("from")!) } : {}),
						...(arg("examples") ? { examples: Number(arg("examples")!) } : {}),
						...(arg("review") ? { reviewPath: resolve(arg("review")!) } : {}),
					});
				} catch (error) {
					if (!(error instanceof SealedSynthRefusal)) throw error;
					console.error(`refused: ${error.message}`);
					console.error(`next: ${error.next}`);
					process.exit(2);
				}
				const rendered = renderSealedSynthOutput(result);
				for (const line of rendered.stdout) console.log(line);
				for (const line of rendered.warnings) console.error(line);
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
				if (visibility === "sealed") {
					// The documented way to seal a `--review` draft is this command.
					// Record that a human read it, so the passport can say so later.
					const reviewed = recordSealedSynthReviewImport({
						stateRoot: stateRoot(),
						projectId,
						sourcePath: resolve(requireArg("file")),
						corpus: metadata,
					});
					if (reviewed) console.error("note: sealed from a generated draft; recorded as reviewed by the operator");
				}
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
					projectDir: corpusProjectDir,
					sourcePath,
					holdout: datasetHoldout(projectId, sourcePath),
				});
				console.log(renderDataset({ sourcePath, preview }, plainPaint).join("\n"));
				break;
			}
			if (action === "ingest") {
				const sourcePath = requireArg("file");
				const result = ingestDataset({
					projectDir: corpusProjectDir,
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
			throw new Error("usage: ahde corpus publish|import|list|inspect|ingest|synth [--target <dir>] [--project <id>] ...");
		}
		case "feedback": {
			const lines = runTargetFeedbackCommand({
				projectDir: resolveInteractiveTargetDirectory(arg("target")),
				action: positional(0),
			});
			for (const line of lines) console.log(line);
			break;
		}
		case "tool": {
			if (positional(0) !== "try") {
				throw new Error("usage: ahde tool try --target <dir> --tool <name> (--input <json|@path> | --fixtures)");
			}
			const branch = arg("branch");
			if (arg("fixtures") !== undefined) {
				const run = await runToolFixtures({
					repositoryDir: resolve(requireArg("target")),
					tool: requireArg("tool"),
					...(branch ? { source: { kind: "branch" as const, ref: branch } } : {}),
				});
				console.log(`tool ${run.tool} · ${describeFixtureRun(run)}`);
				for (const fixture of run.fixtures) {
					console.log(
						`  ${fixture.passed ? "✓" : "✗"} ${fixture.name} · exit ${fixture.exitCode ?? "killed"} · ${fixture.durationMs}ms` +
							`${fixture.failures.length > 0 ? ` — ${fixture.failures.join("; ")}` : ""}`,
					);
				}
				if (!run.allPassed) process.exitCode = 1;
				break;
			}
			const result = await tryTool({
				repositoryDir: resolve(requireArg("target")),
				tool: requireArg("tool"),
				input: readTryToolInput(requireArg("input")),
				...(branch ? { source: { kind: "branch" as const, ref: branch } } : {}),
			});
			console.log(
				`tool ${result.tool} (${result.layout}) · ${result.target.id}@${result.target.gitSha.slice(0, 8)} · ` +
					`sandbox ${result.sandbox} · exit ${result.exitCode ?? "killed"} · ${result.durationMs}ms` +
					`${result.timedOut ? " · TIMED OUT" : ""}${result.truncated ? " · output truncated" : ""}`,
			);
			if (result.setup) {
				console.log(`setup: exit ${result.setup.exitCode ?? "killed"} · ${result.setup.durationMs}ms · network ${result.setup.network}`);
			}
			if (result.stdout) console.log(`--- stdout ---\n${result.stdout}`);
			if (result.stderr) console.log(`--- stderr ---\n${result.stderr}`);
			if (result.exitCode !== 0) process.exitCode = 1;
			break;
		}
		case "diagnose": {
			const evalRunId = positional(0);
			if (!evalRunId) {
				console.error("usage: ahde diagnose <evalRunId> [--target <dir>]\n");
				console.log(cliHelp(["diagnose"]));
				process.exit(2);
			}
			const diagnoseRunsRoot = runsRootForTarget(arg("target"));
			const diagnosis = diagnoseEvalRun(diagnoseRunsRoot, evalRunId);
			const brief = compileImprovementBrief(diagnoseRunsRoot, diagnosis);
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
				// The id is what a proposal is bound to; without it printed here,
				// a diagnosis read at the terminal cannot be matched to the
				// proposal Builder Pi prepared for it.
				console.log(`    ${mode.failureModeId}`);
				console.log(`    facts: ${mode.facts}`);
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
			console.log(`evidence: ${resolve(diagnoseRunsRoot, evalRunId, "diagnosis.json")}`);
			console.log(`explorer: run \`ahde evidence\` and open /evals/${evalRunId} for the runs table, per-run traces, and the host's plain-language explanation of each failure`);
			if (diagnosis.status === "inconclusive") process.exitCode = 2;
			break;
		}
		case "regrade": {
			const evalRunId = positional(0);
			if (!evalRunId) {
				console.error(
					"usage: ahde regrade <evalRunId> --target <dir> [--graders <path>] [--label <label>] [--jobs N] [--project <id>]\n",
				);
				console.log(USAGE);
				process.exit(2);
			}
			const requestedLabel = arg("label");
			if (requestedLabel !== undefined && !isRegradeLabel(requestedLabel)) {
				throw new Error(`--label must be baseline, solo, or regrade, got ${requestedLabel}`);
			}
			const gradersPath = arg("graders");
			const target = loadTarget(resolve(requireArg("target")));
			const sourceIndex = readEvalRunIndex(runsRoot(), evalRunId);
			// The cases the recorded traces answered, wherever they live: the
			// manifest dataset, or the published corpus that produced them.
			const scoredTarget = resolveScoredCasesForEval({
				target,
				evalRun: sourceIndex,
				stateRoot: stateRoot(),
				projectId: arg("project") ?? target.manifest.id,
			}).target;
			const result = await regradeEvalRun({
				runsRoot: runsRoot(),
				evalRunId,
				target: scoredTarget,
				...(gradersPath ? { graderDefaults: readGraderDefaults(gradersPath) } : {}),
				...(requestedLabel ? { label: requestedLabel } : {}),
				...(arg("jobs") ? { jobs: Number(arg("jobs")) } : {}),
			});
			for (const line of renderRegradeSummary(result)) console.log(line);
			if (result.record.summary.error > 0) process.exitCode = 2;
			break;
		}
		case "report": {
			const evalRunId = positional(0);
			if (!evalRunId) {
				console.error("usage: ahde report <evalRunId> [--target <dir>] [--out <path>] [--project <id>]\n");
				console.log(USAGE);
				process.exit(2);
			}
			const report = buildEvalReport(
				runsRootForTarget(arg("target")),
				evalRunId,
				arg("out") ? resolve(arg("out") as string) : undefined,
				{ stateRoot: stateRoot(), projectId: reportProjectId(evalRunId) },
			);
			console.log(report.path);
			console.log(`explorer: run \`ahde evidence\` and open /evals/${evalRunId} for the same runs table with live per-run trace pages`);
			for (const grader of report.judgeCalibration) {
				console.log(`${grader.line}  ${grader.graderNames.join(", ")}`);
			}
			break;
		}
		case "export": {
			exportRecordedDataset(invocation.flags);
			break;
		}
		case "label": {
			await labelJudge();
			break;
		}
		case "passport": {
			const subject = positional(0);
			if (subject !== undefined && subject !== "latest") {
				throw new Error(`ahde passport takes no subject but the word \`latest\`; got ${JSON.stringify(subject)}`);
			}
			const targetDir = resolve(requireArg("target"));
			const passport = compileVersionPassport({
				targetDir,
				runsRoot: runsRoot(),
				stateRoot: stateRoot(),
				...(arg("project") ? { projectId: arg("project")! } : {}),
				...(arg("candidate") ? { candidateId: arg("candidate")! } : {}),
				...(arg("tag") ? { tag: arg("tag")! } : {}),
			});
			// `--json` is the exact projection the page is rendered from, hashes
			// whole; the page itself is what the client is handed.
			const rendered = flagPresent("json")
				? `${JSON.stringify(passport, null, "\t")}\n`
				: renderVersionPassportMarkdown(passport);
			const out = arg("out");
			if (out) {
				const path = resolve(out);
				// --out is the page, always: the file is the thing handed over,
				// and --json only changes what this terminal prints.
				writeFileSync(path, renderVersionPassportMarkdown(passport), "utf8");
				console.error(`passport written to ${path}`);
			}
			process.stdout.write(rendered);
			break;
		}
		case "candidate": {
				const holdoutCorpusId = arg("holdout-corpus");
				const developmentCorpusId = arg("development-corpus");
				const targetDir = resolve(requireArg("target"));
				// A verification that a promotion will later rest on: the engine
				// store must not already be inside a Git object before it starts.
				assertUntrackedEngineStore(targetDir);
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
				// The two verdicts the ship gate turns on, read back from the record
				// this run just wrote. The sealed line is verdict and design only.
				for (const line of renderCandidateVerdictLines(result.record)) console.log(line);
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
		case "check": {
			const targetDir = resolve(requireArg("target"));
			const candidateId = requireArg("candidate");
			const screen = await runCheapCheckForCandidate({
				repositoryDir: targetDir,
				runsRoot: runsRoot(),
				stateRoot: stateRoot(),
				candidateId,
				// The screen reads its project off the evidence; `--project`
				// (defaulting to the Target id) only asserts which one that is.
				expectedProjectId: arg("project") ?? loadTarget(targetDir).manifest.id,
				onRunEvent: cliRunProgress(),
				...(arg("jobs") ? { jobs: Number(arg("jobs")) } : {}),
			});
			console.log(renderCheapCheckLine(screen));
			for (const row of screen.rows) {
				console.log(`  ${row.taskId}  ${row.screenOutcome.padEnd(5)} ${row.classification}`);
			}
			console.log(`screen eval run: ${screen.screenEvalRunId} (a screen — never a baseline, never evidence)`);
			console.log(`screen record: ${screen.screenRecordPath}`);
			// A screen is never evidence, so it never ends a change: it either
			// sends the operator back to Builder Pi to author another one, or on
			// to the human gate that reads the verification.
			if (screen.verdict === "flat") {
				console.log(
					`next: nothing improved. Open \`ahde\` in the Target and author another change.`,
				);
				process.exitCode = 1;
			} else {
				console.log(
					`next: ahde review --candidate ${candidateId} --recommend promote|reject --reason <text>`,
				);
			}
			break;
		}
		case "improve": {
			const targetDir = resolve(requireArg("target"));
			const until = parsePassRateFlag(requireArg("until"));
			if (until === null) throw new Error("--until must be a pass rate such as 90% or 0.9");
			const maxCycles = Number(requireArg("max-cycles"));
			const baseTarget = loadTarget(targetDir);
			const projectId = arg("project") ?? baseTarget.manifest.id;
			const corpusId = arg("corpus");
			const repetitions = arg("repetitions") ? Number(arg("repetitions")) : DEFAULT_REPETITIONS;
			const candidates = arg("candidates") ? Number(arg("candidates")) : 1;
			if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > MAX_IMPROVEMENT_CYCLES) {
				throw new Error(`--max-cycles must be between 1 and ${MAX_IMPROVEMENT_CYCLES}, got ${maxCycles}`);
			}
			if (!Number.isInteger(repetitions) || repetitions < 1) {
				throw new Error(`--repetitions must be a positive integer, got ${repetitions}`);
			}
			if (!Number.isInteger(candidates) || candidates < 1 || candidates > MAX_SEARCH_CANDIDATES) {
				throw new Error(`--candidates must be between 1 and ${MAX_SEARCH_CANDIDATES}, got ${candidates}`);
			}
			const resumeLoopId = arg("resume");
			const abandonLoopId = arg("abandon");
			if (resumeLoopId && abandonLoopId) {
				throw new Error("improve cannot resume and abandon a loop in the same invocation");
			}
			const approvedSpecId = soleApprovedSpecId(projectId);
			// An unfinished loop is reported, not raced onto the same branch names.
			// `--abandon` drops the claim (never the branches); `--resume` continues.
			if (abandonLoopId) {
				const dropped = abandonImprovementLoop(runsRoot(), projectId, abandonLoopId);
				console.log(
					`abandoned improvement loop ${dropped.loopId} (${dropped.lastCycle} cycle slot(s) claimed). ` +
					`Its branches are untouched: ${dropped.branches.join(", ") || "none"}.`,
				);
			}
			const unfinished = listUnfinishedImprovementLoops(runsRoot(), projectId);
			const resumed = resumeLoopId
				? unfinished.running.find((loop) => loop.loopId === resumeLoopId) ?? null
				: null;
			if (resumeLoopId && !resumed) {
				throw new Error(`no unfinished improvement loop ${resumeLoopId} in project ${projectId}`);
			}
			const blocking = unfinished.running.filter((loop) => loop.loopId !== resumed?.loopId);
			if (blocking.length > 0 || unfinished.unreadable.length > 0) {
				throw new UnfinishedImprovementLoopError(blocking, unfinished.unreadable);
			}
			const effectiveTarget = corpusId
				? targetWithDevelopmentCorpus(baseTarget, loadCorpus({ stateRoot: stateRoot(), projectId, corpusId }))
				: baseTarget;
			const plannedExecutions = plannedImprovementExecutions({
				developmentTasks: effectiveTarget.tasks.length,
				repetitions,
				maxCycles: maxCycles - (resumed?.lastCycle ?? 0),
				candidates,
			});
			process.stderr.write(
				`AHDE improve authorization · up to ${plannedExecutions} Target executions · ` +
				"proposals may be applied to throwaway branches without individual diff review; " +
				"the exact diff must be hash-confirmed at review\n",
			);
			const result = await runImprovementLoop({
				repositoryDir: targetDir,
				runsRoot: runsRoot(),
				stateRoot: stateRoot(),
				projectId,
				approvedSpecId,
				...(corpusId ? { developmentCorpus: { stateRoot: stateRoot(), projectId, corpusId } } : {}),
				until,
				maxCycles,
				repetitions,
				candidates,
				...(resumed ? { loopId: resumed.loopId } : {}),
				...(arg("baseline-max-age") ? { baselineMaxAgeMs: Number(arg("baseline-max-age")) } : {}),
				...(arg("jobs") ? { jobs: Number(arg("jobs")) } : {}),
				author: recordedBuilderProposalAuthor({ stateRoot: stateRoot(), runsRoot: runsRoot(), projectId }),
				// Invariant 6, on this front door too: nobody is at this terminal
				// past the authorization above, so every release decision throws
				// before it is asked and every other question fails closed.
				gate: improvementLoopGate(unattendedGate()),
				onCycle: (line) => process.stderr.write(`${line}\n`),
				onRunEvent: cliRunProgress(),
			});
			console.log(renderImprovementLoopTable(result));
			console.log(`\nloop ${result.loopId}`);
			if (result.candidateId) {
				console.log(
					`\nnext: ahde review --candidate ${result.candidateId} --recommend promote|reject --reason <text>`,
				);
			}
			// A search hands back several candidates and picks none: pointing at
			// one of them would be the loop making the human's decision.
			const searched = [...result.cycles].reverse().find((cycle) => cycle.search)?.search ?? null;
			if (searched && searched.frontier.length > 0) {
				const winners = searched.frontier
					.map((ordinal) => searched.rows.find((row) => row.ordinal === ordinal)?.candidateId)
					.filter((id): id is string => typeof id === "string");
				console.log(
					`\nnext: pick one — ahde review --candidate <${winners.join(" | ")}> ` +
					"--recommend promote|reject --reason <text>",
				);
			}
			// A loop that stopped without a verified candidate has nothing to ship;
			// that is a finding, not a crash.
			if (!result.candidateId && !(searched && searched.frontier.length > 0)) process.exitCode = 1;
			break;
		}
		case "search": {
			const targetDir = resolve(requireArg("target"));
			const proposalRunIds = parseCandidateIdList(requireArg("candidates"));
			const projectId = arg("project") ?? loadTarget(targetDir).manifest.id;
			const corpusId = arg("corpus");
			const repetitions = arg("repetitions") ? Number(arg("repetitions")) : DEFAULT_REPETITIONS;
			const approvedSpecId = soleApprovedSpecId(projectId);
			// Every hypothesis has to be about the same failure mode; the first
			// proposal's attested basis names it and the search refuses the rest.
			const failureModeId = soleSearchFailureModeId(proposalRunIds);
			const result = await runProposalSearch({
				repositoryDir: targetDir,
				runsRoot: runsRoot(),
				stateRoot: stateRoot(),
				projectId,
				approvedSpecId,
				failureModeId,
				proposalRunIds,
				...(corpusId ? { developmentCorpus: { stateRoot: stateRoot(), projectId, corpusId } } : {}),
				...(corpusId
					? { developmentTasks: loadCorpus({ stateRoot: stateRoot(), projectId, corpusId }).tasks.length }
					: {}),
				repetitions,
				...(arg("budget") ? { executionBudget: Number(arg("budget")) } : {}),
				...(arg("jobs") ? { jobs: Number(arg("jobs")) } : {}),
				// The same restricted gate the Workbench hands a search: promotion,
				// adoption and the sealed guardrail stay with the human.
				gate: proposalSearchGate(unattendedGate()),
				onCandidate: (line) => process.stderr.write(`${line}\n`),
				onRunEvent: cliRunProgress(),
			});
			console.log(renderProposalSearchTable(result));
			// The search compares and stops. Promotion, adoption and the sealed
			// guardrail are the human's, on the one candidate they pick.
			if (result.frontier.length === 0) process.exitCode = 1;
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
				...(arg("jobs") ? { jobs: Number(arg("jobs")) } : {}),
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
			const candidateId = requireArg("candidate");
			const candidate = loadCandidateRecord(runsRoot(), candidateId);
			let expectedProposalHash: string | undefined;
			if (
				recommendation === "promote" &&
				candidate.origin.kind === "applied-builder" &&
				candidate.origin.application.via !== undefined
			) {
				const proposal = candidateProposalReview(runsRoot(), candidate);
				if (!proposal) throw new Error(`candidate ${candidateId} has no reconstructable proposal to review`);
				console.log(`exact automated proposal ${proposal.proposalHash}:`);
				console.log(proposal.exactDiff);
				expectedProposalHash = arg("proposal-hash");
				if (!expectedProposalHash) {
					throw new Error(
						`candidate ${candidateId} was applied by ${candidate.origin.application.via} without individual diff review; ` +
						`read the exact diff above, then rerun with --proposal-hash ${proposal.proposalHash}`,
					);
				}
			}
			const record = reviewCandidate({
				runsRoot: runsRoot(),
				candidateId,
				...(expectedProposalHash ? { expectedProposalHash } : {}),
				recommendation,
				reason: requireArg("reason"),
				actorId: arg("actor"),
			});
			console.log(`reviewed candidate ${record.candidateId}: ${recommendation}`);
			// The two verdicts the recommendation rests on, printed where the
			// decision is made: a sealed `pass` says which finding it was.
			for (const line of renderCandidateVerdictLines(record)) console.log(line);
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
				stateRoot: stateRoot(),
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
		case "log": {
			const targetDir = resolve(requireArg("target"));
			const targetId = loadTarget(targetDir).manifest.id;
			const projectId = arg("project") ?? targetId;
			const limit = arg("limit");
			// A pure read over durable candidate evidence: no model call, and not
			// one byte written.
			const log = compileAgentLog({
				runsRoot: runsRoot(),
				targetId,
				projectId,
				...(limit ? { limit: Number(limit) } : {}),
			});
			if (flagPresent("json")) {
				console.log(JSON.stringify(log, null, 2));
				break;
			}
			for (const line of renderAgentLog(log, plainPaint)) console.log(line);
			break;
		}
		case "watch": {
			await watchTarget();
			break;
		}
		default:
			console.log(USAGE);
			process.exit(2);
	}
}

/**
 * The one approved Spec this project's loop runs under. `ahde improve` is a
 * script, so it refuses to guess between several.
 */
function soleApprovedSpecId(projectId: string): string {
	const specs = listSpecSnapshots(stateRoot(), projectId)
		.filter((snapshot) => snapshot.status === "approved");
	if (specs.length === 1) return specs[0]!.id;
	if (specs.length === 0) throw new Error(`project ${projectId} has no approved Spec; approve one in \`ahde\` first`);
	throw new Error(
		`project ${projectId} has ${specs.length} approved Specs; run the loop from \`ahde\` where one is selected`,
	);
}

/**
 * The one failure mode a search is about, read from the attested proposal basis
 * of every hypothesis. Two hypotheses aiming at different modes are not a
 * search — they are two searches — and comparing them in one table would put
 * two unrelated questions in the same row.
 */
function soleSearchFailureModeId(proposalRunIds: readonly string[]): string {
	const shared = proposalRunIds.map((runId) => {
		const record = loadBuilderProposalRun(runsRoot(), runId);
		const basis = record.request.proposalBasis;
		if (!basis) throw new Error(`proposal ${runId} carries no attested failure-mode basis; it cannot enter a search`);
		return new Set(basis.failureModes.map((mode) => mode.failureModeId));
	});
	const common = [...(shared[0] ?? new Set<string>())]
		.filter((id) => shared.every((ids) => ids.has(id)))
		.sort();
	if (common.length === 0) {
		throw new Error("the supplied proposals share no failure mode; a search compares hypotheses for exactly one");
	}
	if (common.length > 1) {
		throw new Error(
			`the supplied proposals share ${common.length} failure modes (${common.join(", ")}); ` +
			"a search compares hypotheses for exactly one",
		);
	}
	return common[0]!;
}

function cliFailure(error: unknown): { message: string; next?: string } {
	const message = redactTraceText(error instanceof Error ? error.message : String(error)).slice(0, 4_000);
	// A refusal that already knows what the operator should do next says so
	// itself, rather than being recognized here by the shape of its sentence.
	const carried = (error as { next?: unknown } | null)?.next;
	if (typeof carried === "string" && carried.trim().length > 0) {
		return { message, next: redactTraceText(carried).slice(0, 1_000) };
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
