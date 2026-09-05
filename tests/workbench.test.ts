import { workbenchNext, workbenchGuidanceContext } from "../src/workbench/next-actions.js";
import { nextStep } from "../src/builder/render/stage.js";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { createCorpus, loadCorpus } from "../src/corpus.js";
import {
	approveBuilderSpecDraft,
	describeSpecDraftApproval,
	describeDevelopmentCorpusPublication,
	publishBuilderDevelopmentCorpus,
	saveBuilderSpecDraft,
} from "../src/application/builder-authoring.js";
import { loadBuilderCorpusDraft } from "../src/application/builder-corpus-draft.js";
import { compileHarnessAuthoringProposal } from "../src/application/harness-authoring.js";
import { inspectTargetAuthoringContext } from "../src/application/target-authoring-context.js";
import { compileImprovementBrief } from "../src/application/improvement-brief.js";
import { recordBuilderAuthoredProposal } from "../src/application/builder-authoring.js";
import { applyBuilderProposal, loadBuilderProposalRun } from "../src/application/builder-proposal.js";
import { CANDIDATE_SCOPE_POLICY } from "../src/application/candidate-experiment.js";
import { targetWithDevelopmentCorpus } from "../src/application/corpus-target.js";
import { createCandidate, transitionCandidate, type CandidateRecord } from "../src/domain/candidate.js";
import { EXACT_COMPARISON_GATE_ALGORITHM_ID_V4 } from "../src/domain/comparison-gate.js";
import { diagnoseEvalRun } from "../src/diagnosis.js";
import { writeEvalRun, type EvalRunRecord } from "../src/eval.js";
import { loadTarget, type GraderSpec } from "../src/manifest.js";
import { computeTargetSnapshotHashes } from "../src/runner.js";
import {
	RunRecordSchema,
	executionFingerprint,
	hashValue,
	hashFile,
	modelFingerprint,
	provenanceAxes,
	provenanceKey,
	type RunRecord,
} from "../src/provenance.js";
import { saveSpecSnapshot, type AgentSpec } from "../src/spec.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";
import {
	createBuilderWorkbench,
	type BuilderWorkbenchDependencies,
} from "../src/builder/workbench-adapter.js";
import {
	WorkbenchDecisionDeclinedError,
	WorkbenchDecisionInputSchema,
	WorkbenchSelectionRequiredError,
	WorkbenchStaleDecisionError,
	createAhdeWorkbench,
	type WorkbenchHumanGate,
} from "../src/workbench/index.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

const roots: string[] = [];
const NOW = "2026-08-26T18:00:00.000Z";

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) cleanup(root);
});

function target(): { projectDir: string; stateRoot: string; runsRoot: string } {
	const projectDir = makeTargetFixture(baseFixtureFiles({ ".gitignore": ".ahde/\nruns/\n" }));
	roots.push(projectDir);
	return { projectDir, stateRoot: join(projectDir, ".ahde"), runsRoot: join(projectDir, "runs") };
}

function spec(title = "Support policy assistant"): AgentSpec {
	return {
		schemaVersion: 1,
		title,
		purpose: "Answer support policy questions from approved local evidence.",
		users: ["Support operators"],
		jobs: ["Answer one policy question"],
		inputs: ["A policy question"],
		allowedActions: ["Read approved local policy"],
		successCriteria: ["Answer contains the applicable policy"],
		constraints: ["Never invent policy"],
		openQuestions: [],
	};
}

function task(input = "What is the refund window?", text = "30 days") {
	return { input, graders: [{ type: "output_contains" as const, text }] };
}

function artifactRef(path: string): { path: string; sha256: string } {
	return { path, sha256: hashFile(readFileSync(path, "utf8")) };
}

function gate(approved = true): WorkbenchHumanGate & {
	confirm: ReturnType<typeof vi.fn>;
	selectSealed: ReturnType<typeof vi.fn>;
} {
	return {
		confirm: vi.fn(async () => ({ approved, ...(approved ? { actorId: "local:test-human" } : {}) })),
		selectSealed: vi.fn(async () => ({ approved, ...(approved ? { actorId: "local:test-human", selectedIndex: 0 } : {}) })),
	};
}

function writeDevelopmentEval(
	paths: { projectDir: string; stateRoot: string; runsRoot: string },
	corpusId: string,
	evalRunId: string,
	outcome: "pass" | "fail" = "fail",
	toolsetHashOverride?: string,
	workspaceHashOverride?: string,
): EvalRunRecord {
	const resolved = targetWithDevelopmentCorpus(
		loadTarget(paths.projectDir),
		loadCorpus({ stateRoot: paths.stateRoot, projectId: "test-target", corpusId }),
	);
	const runtime = {
		piVersion: "0.84.3",
		piSha: "b".repeat(40),
		ahdeVersion: "0.1.0",
		ahdeCodeHash: `sha256:${"c".repeat(64)}`,
	};
	const model = modelFingerprint({
		provider: "mock",
		id: "model",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1/v1",
		apiKeyEnv: "TEST_KEY",
		thinkingLevel: "off",
		params: {},
		spec: {},
	});
	const execution = executionFingerprint("isolated");
	mkdirSync(paths.runsRoot, { recursive: true });
	const snapshot = computeTargetSnapshotHashes(resolved, paths.runsRoot);
	const workspaceHash = workspaceHashOverride ?? snapshot.workspaceHash;
	const evaluation = {
		suiteId: resolved.manifest.evalSuite.id,
		suiteHash: resolved.suiteHash,
		dataset: resolved.manifest.evalSuite.dataset.replace(/\.jsonl$/, "").split("/").pop() ?? "dataset",
		datasetHash: resolved.datasetHash,
	};
	const runId = `run-${evalRunId}`;
	const traceContent = [
		JSON.stringify({
			type: "message",
			message: { role: "user", content: resolved.tasks[0]!.input, timestamp: 1 },
		}),
		JSON.stringify({
			type: "message",
			message: { role: "assistant", content: "fixture failure", timestamp: 2 },
		}),
	].join("\n") + "\n";
	const run: RunRecord = {
		schemaVersion: 1,
		runId,
		taskId: resolved.tasks[0]!.id,
		repetitionIndex: 0,
		label: "solo",
		status: "completed",
		error: null,
		startedAt: NOW,
		finishedAt: NOW,
		target: {
			id: resolved.manifest.id,
			gitSha: resolved.gitSha,
			toolsetHash: toolsetHashOverride ?? resolved.toolsetHash,
			workspaceHash,
			preparedToolHomeHash: snapshot.preparedToolHomeHash,
		},
		runtime,
		model,
		execution,
		eval: evaluation,
		trace: { path: "session.jsonl", sessionId: null, sha256: hashFile(traceContent) },
		metrics: {
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			costUsd: 0,
			latencyMs: 0,
			toolCalls: 0,
			toolErrors: 0,
			recoveryAttempts: 0,
		},
		evalResults: {
			outcome,
			graders: [{
				name: "fixture",
				type: "output_contains",
				passed: outcome === "pass",
				score: outcome === "pass" ? 1 : 0,
				reason: outcome === "pass" ? "fixture pass" : "fixture failure",
				specHash: hashValue(resolved.tasks[0]!.effectiveGraders[0]!),
				checkCode: "output-contains",
			}],
		},
		parent: { evalRunId, candidateOf: null },
	};
	mkdirSync(join(paths.runsRoot, runId), { recursive: true });
	writeFileSync(join(paths.runsRoot, runId, "session.jsonl"), traceContent, "utf8");
	writeJsonArtifact(join(paths.runsRoot, runId, "run.json"), RunRecordSchema, run);
	const evidence = { runtime, model, judge: null, execution, eval: evaluation };
	const record: EvalRunRecord = {
		schemaVersion: 3,
		purpose: "evidence" as const,
		evalRunId,
		target: run.target,
		label: "solo",
		baselineEvalRunId: null,
		provenance: provenanceAxes(evidence),
		provenanceKey: provenanceKey(evidence),
		suiteId: evaluation.suiteId,
		suiteHash: evaluation.suiteHash,
		dataset: evaluation.dataset,
		datasetHash: evaluation.datasetHash,
		repetitions: 1,
		runIds: [runId],
		runArtifacts: [{ runId, sha256: hashValue(run) }],
		startedAt: NOW,
		finishedAt: NOW,
		summary: {
			total: 1,
			pass: outcome === "pass" ? 1 : 0,
			fail: outcome === "fail" ? 1 : 0,
			error: 0,
			allPassRate: outcome === "pass" ? 1 : 0,
		},
	};
	writeEvalRun(paths.runsRoot, record);
	return record;
}

function proposalSelection(
	paths: { runsRoot: string },
	evalRunId: string,
): {
	source: {
		algorithmId: "exact-eval-signals-v1";
		evalRunId: string;
		diagnosisId: string;
		briefId: string;
	};
	failureModeIds: string[];
} {
	const diagnosis = diagnoseEvalRun(paths.runsRoot, evalRunId);
	const brief = compileImprovementBrief(paths.runsRoot, diagnosis);
	const mode = brief.modes.find((candidate) => candidate.decision === "propose-harness-change");
	if (!mode) throw new Error("fixture has no proposal-eligible failure mode");
	return {
		source: {
			algorithmId: brief.algorithmId,
			evalRunId: brief.evalRunId,
			diagnosisId: brief.diagnosisId,
			briefId: brief.briefId,
		},
		failureModeIds: [mode.failureModeId],
	};
}

function authoringContextClaim(paths: { projectDir: string }) {
	const resolved = loadTarget(paths.projectDir);
	return inspectTargetAuthoringContext({
		repositoryDir: paths.projectDir,
		expectedTarget: { id: resolved.manifest.id, gitSha: resolved.gitSha },
	}).claim;
}

/**
 * One A/A calibration record on disk. `evaluated: false` leaves it at the
 * `validated` checkpoint an interrupted candidate would occupy, which is
 * exactly the shape that must not become workflow.
 */
function writeCalibration(
	paths: { projectDir: string; runsRoot: string },
	candidateId: string,
	options: { evaluated?: boolean; at?: string; sha?: string; taskCount?: number; baselinePassRate?: number } = {},
): CandidateRecord {
	const at = options.at ?? NOW;
	const sha = options.sha ?? loadTarget(paths.projectDir).gitSha;
	const revision = { ref: "refs/heads/master", sha };
	const actor = { kind: "human" as const, id: "local:test-human" };
	const system = { kind: "system" as const, id: "candidate-experiment" };
	const taskCount = options.taskCount ?? 30;
	let record = createCandidate({
		candidateId,
		projectId: "test-target",
		targetId: loadTarget(paths.projectDir).manifest.id,
		specId: null,
		proposalId: "proposal-unspecified",
		diagnosisId: null,
		origin: { kind: "manual", reason: "A/A calibration" },
		mode: "aa-calibration",
		baseline: revision,
		eventId: `${candidateId}:proposed`,
		at,
		actor,
	});
	record = transitionCandidate(record, { type: "built", eventId: `${candidateId}:built`, at, actor, candidate: revision });
	record = transitionCandidate(record, {
		type: "validated",
		eventId: `${candidateId}:validated`,
		at,
		actor: system,
		lineage: { baseline: revision, candidate: revision, relation: "same" },
		scope: {
			policyId: CANDIDATE_SCOPE_POLICY.id,
			baselineSha: sha,
			candidateSha: sha,
			passed: true,
			changedFiles: [],
			violations: [],
		},
	});
	if (options.evaluated !== false) {
		const hash = `sha256:${"c".repeat(64)}`;
		const improved = taskCount >= 3 ? 2 : 0;
		const regressed = taskCount >= 3 ? 1 : 0;
		record = transitionCandidate(record, {
			type: "evaluated",
			eventId: `${candidateId}:evaluated`,
			at,
			actor: system,
			evaluation: {
				experimentId: candidateId,
				designHash: hash,
				mode: "aa-calibration",
				development: {
					baseline: { evalRunId: `${candidateId}-a`, harness: revision },
					candidate: { evalRunId: `${candidateId}-b`, harness: revision },
					comparison: {
						schemaVersion: 4,
						algorithmId: EXACT_COMPARISON_GATE_ALGORITHM_ID_V4,
						policyId: "development-ci-v4",
						surface: "development",
						comparisonHash: hash,
						evidenceHash: hash,
						gateHash: hash,
						summary: {
							taskCount,
							baselinePassRate: options.baselinePassRate ?? 0.9,
							candidatePassRate: options.baselinePassRate ?? 0.9,
							delta: 0,
							baselineScore: options.baselinePassRate ?? 0.9,
							candidateScore: options.baselinePassRate ?? 0.9,
							scoreDelta: 0,
							confidence95: { low: -0.06, high: 0.06 },
							improved,
							regressed,
							unchanged: taskCount - improved - regressed,
						},
						design: { tasks: taskCount, repetitions: 3, excludedTasks: 0 },
						verdict: "inconclusive",
						flags: { regressedTasks: regressed, improvedTasks: improved, collapsedTasks: 0 },
						resources: { baseline: { runs: 30, costUsd: 0.1, meanLatencyMs: 2000, meanTokens: 800 }, candidate: { runs: 30, costUsd: 0.14, meanLatencyMs: 1800, meanTokens: 900 }, costRatio: 1.4, latencyRatio: 0.9, tokenRatio: 1.125 },
						reasons: ["95% CI spans zero"],
					},
				} as never,
				infrastructureErrors: 0,
			},
		});
	}
	const dir = join(paths.runsRoot, "candidates", candidateId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "candidate.json"), `${JSON.stringify(record)}\n`, "utf8");
	return record;
}

describe("AHDE Workbench", () => {
	it("creates and configures one generic Target through the same human-gated decision seam", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "ahde-workbench-empty-"));
		roots.push(projectDir);
		const stateRoot = join(projectDir, ".ahde");
		const workbench = createAhdeWorkbench({
			projectDir,
			stateRoot,
			runsRoot: join(projectDir, "runs"),
			projectId: "research-agent",
			templateDir: resolve("templates/basic-agent"),
			dependencies: { now: () => NOW },
		});

		expect(await workbench.view()).toMatchObject({
			stage: "target-setup",
			actions: ["scaffold-target"],
			target: { status: "missing" },
		});
		const scaffoldGate = gate();
		const scaffolded = await workbench.decide({
			kind: "scaffold-target",
			reason: "Create the reviewed generic starter",
		}, scaffoldGate);
		expect(scaffolded.view).toMatchObject({
			stage: "target-setup",
			actions: ["configure-target"],
			target: { status: "bootstrap-required", id: "my-agent" },
		});
		expect(scaffoldGate.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "scaffold-target",
				subject: expect.objectContaining({
					operation: "initialize-current-directory",
					templateFiles: expect.any(Array),
				}),
			}),
			undefined,
		);

		const configureGate = gate();
		const resolvedTargetModel = {
			provider: "openai",
			id: "gpt-test",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			apiKeyEnv: "OPENAI_API_KEY",
			thinkingLevel: "medium" as const,
			timeoutMs: 300_000,
			params: {},
			spec: {
				reasoning: true,
				contextWindow: 131_072,
				maxTokens: 16_384,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: {},
			},
		};
		const configured = await workbench.decide({
			kind: "configure-target",
			targetId: "research-agent",
			model: {
				provider: "openai",
				modelId: "gpt-test",
				thinkingLevel: "medium",
				timeoutMs: 300_000,
				params: {},
			},
			reason: "Bind the reviewed identity and non-secret model metadata",
		}, configureGate, { resolveTargetModel: () => resolvedTargetModel });
		expect(configured.view).toMatchObject({
			stage: "spec-design",
			target: { status: "ready", id: "research-agent" },
		});
		expect(configured.result).toMatchObject({
			targetId: "research-agent",
			credentialEnv: "OPENAI_API_KEY",
		});
	});

	it("fails closed when the trusted model catalog is unavailable or changes during confirmation", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "ahde-workbench-model-drift-"));
		roots.push(projectDir);
		const stateRoot = join(projectDir, ".ahde");
		const workbench = createAhdeWorkbench({
			projectDir,
			stateRoot,
			runsRoot: join(projectDir, "runs"),
			projectId: "drift-agent",
			templateDir: resolve("templates/basic-agent"),
			dependencies: { now: () => NOW },
		});
		await workbench.decide({ kind: "scaffold-target", reason: "Create a drift fixture" }, gate());
		const selection = {
			kind: "configure-target" as const,
			targetId: "drift-agent",
			model: { provider: "openai", modelId: "gpt-test" },
			reason: "Detect catalog drift",
		};
		await expect(workbench.decide(selection, gate())).rejects.toThrow(/trusted host model catalog/);

		const baseModel = {
			provider: "openai",
			id: "gpt-test",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			apiKeyEnv: "OPENAI_API_KEY",
			thinkingLevel: "medium" as const,
			timeoutMs: 300_000,
			params: {},
			spec: {
				reasoning: true,
				contextWindow: 131_072,
				maxTokens: 16_384,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: {},
			},
		};
		const resolveTargetModel = vi.fn()
			.mockReturnValueOnce(baseModel)
			.mockReturnValueOnce({ ...baseModel, baseUrl: "https://catalog-changed.invalid/v1" });
		await expect(workbench.decide(selection, gate(), { resolveTargetModel }))
			.rejects.toBeInstanceOf(WorkbenchStaleDecisionError);
		expect(resolveTargetModel).toHaveBeenCalledTimes(2);
		expect(execFileSync("git", ["-C", projectDir, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim())
			.toBe("1");
		expect(loadTarget(projectDir).manifest).toMatchObject({
			id: "my-agent",
			model: { id: "replace-with-model-id" },
		});
	});

	it("keeps host execution listeners outside the model-facing decision schema", () => {
		const parsed = WorkbenchDecisionInputSchema.safeParse({
			kind: "run-current",
			repetitions: 1,
			reason: "Exercise the host-only boundary",
			onRunEvent: () => {},
		});
		expect(parsed.success).toBe(false);
	});

	it("uses project-owned admissions: foreign corruption is ignored while local ownership tamper blocks", async () => {
		const paths = target();
		const localWorkbench = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		await localWorkbench.submit({ kind: "spec-draft", spec: spec() });
		const localApproval = await localWorkbench.decide({ kind: "approve-spec", reason: "Local authority" }, gate());
		const proposal = compileHarnessAuthoringProposal({
			repositoryDir: paths.projectDir,
			intents: [{ type: "instructions.replace", content: "# Admission test\n" }],
			summary: "Exercise project-owned proposal authority",
			diagnoses: [],
			risks: [],
			validationPlan: ["Inspect authority"],
		});
		const local = await recordBuilderAuthoredProposal({
			proposal,
			targetDir: paths.projectDir,
			allowedPaths: [...CANDIDATE_SCOPE_POLICY.allowed],
			approvedSpec: {
				stateRoot: paths.stateRoot,
				projectId: "test-target",
				specId: String(localApproval.result.approvedSpecId),
			},
			runsRoot: paths.runsRoot,
			timeoutMs: 30_000,
		});
		const foreignSpec = saveSpecSnapshot({
			stateRoot: paths.stateRoot,
			projectId: "another-project",
			status: "approved",
			spec: spec("Foreign proposal"),
			now: () => NOW,
		});
		const foreign = await recordBuilderAuthoredProposal({
			proposal,
			targetDir: paths.projectDir,
			allowedPaths: [...CANDIDATE_SCOPE_POLICY.allowed],
			approvedSpec: { stateRoot: paths.stateRoot, projectId: "another-project", specId: foreignSpec.id },
			runsRoot: paths.runsRoot,
			timeoutMs: 30_000,
		});
		writeFileSync(foreign.builderRunPath, "corrupt foreign evidence\n", "utf8");
		const foreignEvalRunId = "erun-foreign-private-source";
		mkdirSync(join(paths.runsRoot, foreignEvalRunId), { recursive: true });
		writeFileSync(join(paths.runsRoot, foreignEvalRunId, "eval_run.json"), "foreign source trap\n", "utf8");
		const localRecord = JSON.parse(readFileSync(local.builderRunPath, "utf8")) as {
			request: {
				approvedSpec: { projectId: string };
				baseTargetSha: string;
				source: unknown;
				sourceAttestation: unknown;
				proposalBasis: unknown;
				proposalDiagnoses: unknown;
				failureBundleSha256: string | null;
				failureBundleBytes: number;
			};
		};
		localRecord.request.approvedSpec.projectId = "another-project";
		localRecord.request.source = {
			evalRunId: foreignEvalRunId,
			diagnosisId: "diagnosis-foreign-private-source",
		};
		localRecord.request.sourceAttestation = {
			evalRunId: foreignEvalRunId,
			diagnosisId: "diagnosis-foreign-private-source",
			targetId: "test-target",
			targetGitSha: localRecord.request.baseTargetSha,
			evalRunSha256: `sha256:${"1".repeat(64)}`,
			diagnosisSha256: `sha256:${"2".repeat(64)}`,
			dataset: "foreign-private",
			datasetHash: `sha256:${"3".repeat(64)}`,
			suiteHash: `sha256:${"4".repeat(64)}`,
			developmentCorpus: null,
		};
		localRecord.request.proposalBasis = {
			schemaVersion: 1,
			algorithmId: "exact-eval-signals-v1",
			evalRunId: foreignEvalRunId,
			diagnosisId: "diagnosis-foreign-private-source",
			briefId: `brief-${"5".repeat(24)}`,
			briefSha256: `sha256:${"6".repeat(64)}`,
			failureModes: [{
				failureModeId: `failure-mode-${"7".repeat(24)}`,
				modeSha256: `sha256:${"8".repeat(64)}`,
			}],
		};
		localRecord.request.proposalDiagnoses = [{
			failureIds: [`failure-mode-${"7".repeat(24)}`],
			evidence: ["foreign evidence that must not be opened"],
			rootCause: "forged foreign root cause",
		}];
		localRecord.request.failureBundleSha256 = `sha256:${"9".repeat(64)}`;
		localRecord.request.failureBundleBytes = 1;
		writeFileSync(local.builderRunPath, `${JSON.stringify(localRecord, null, "\t")}\n`, "utf8");

		const view = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
		expect(view.blockers.join("\n")).not.toContain(foreign.record.runId);
		expect(view.warnings.join("\n")).not.toContain(foreign.record.runId);
		expect(view.blockers.join("\n")).toContain(local.record.runId);
		expect(view.blockers.join("\n")).toContain("project-owned admission");
		expect(view.blockers.join("\n")).not.toContain(foreignEvalRunId);
	});

	it("survives restart and drives Spec → editable Corpus Draft → exact publication", async () => {
		const paths = target();
		const first = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		expect((await first.view()).stage).toBe("spec-design");

		const drafted = await first.submit({ kind: "spec-draft", spec: spec(), sourceText: "Build a policy assistant" });
		const draftId = String(drafted.artifact?.id);
		expect(draftId).toMatch(/^spec-/);
		expect(drafted.view.stage).toBe("spec-review");

		const restarted = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		expect((await restarted.view()).focus["spec-draft"]).toBe(draftId);
		const approvalGate = gate();
		const approved = await restarted.decide({ kind: "approve-spec", reason: "The exact Spec matches our intent" }, approvalGate);
		expect(approved.result.approvedSpecId).toMatch(/^spec-/);
		expect(approved.view.stage).toBe("corpus-design");
		expect(approved.view.actions).toEqual(["workshop-open", "submit corpus-draft", "configure-evaluators", "generate-holdout"]);
		expect(approved.view.headline).toContain("construction workshop");
		expect(approvalGate.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "approve-spec",
				subjectHash: expect.stringMatching(/^sha256:/),
				subject: expect.objectContaining({ spec: expect.objectContaining({ title: "Support policy assistant" }) }),
			}),
			undefined,
		);

		const corpusDraft = await restarted.submit({
			kind: "corpus-draft",
			name: "Policy development basket",
			tasks: [task(), task("What if no policy exists?", "unknown")],
			coverageNotes: ["Known answer and missing evidence"],
			revisionSummary: "Initial maintainable basket",
		});
		const corpusDraftId = String(corpusDraft.artifact?.id);
		expect(corpusDraft.view.stage).toBe("corpus-review");
		expect(corpusDraft.view.actions).toContain("configure-evaluators");

		const review = await restarted.view({ aspect: "review" });
		expect(review.detail).toMatchObject({
			aspect: "review",
			content: { kind: "corpus-draft", id: corpusDraftId, tasks: expect.any(Array) },
		});

		const declined = gate(false);
		await expect(restarted.decide({ kind: "publish-corpus", reason: "Not ready" }, declined))
			.rejects.toBeInstanceOf(WorkbenchDecisionDeclinedError);
		expect((await restarted.view()).counts.developmentCorpora).toBe(0);

		const publicationGate = gate();
		const published = await restarted.decide({ kind: "publish-corpus", reason: "Reviewed all exact tasks" }, publicationGate);
		const corpusId = String(published.result.corpusId);
		expect(corpusId).toMatch(/^corpus-/);
		expect(published.result.lineageHash).toMatch(/^sha256:/);
		expect(published.view.stage).toBe("ready-to-evaluate");
		expect(published.view.actions).toEqual(["workshop-open", "run", "configure-evaluators", "generate-holdout"]);
		expect(published.view.headline).toContain("construction workshop");
		expect(existsSync(join(paths.stateRoot, "projects", "test-target", "workbench", "corpus-publications", `${corpusId}.json`))).toBe(true);
		expect(publicationGate.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "publish-corpus",
				subject: expect.objectContaining({ tasks: expect.arrayContaining([expect.objectContaining({ input: "What is the refund window?" })]) }),
			}),
			undefined,
		);

		const afterSecondRestart = createAhdeWorkbench({ ...paths, projectId: "test-target" });
		expect((await afterSecondRestart.view()).focus["development-corpus"]).toBe(corpusId);
	});

	it("reports the workshop a restart left on disk, and offers the id that re-attaches to it", async () => {
		const paths = target();
		const first = createAhdeWorkbench({ ...paths, projectId: "test-target" });
		await first.submit({ kind: "spec-draft", spec: spec() });
		await first.decide({ kind: "approve-spec", reason: "Approve so the harness can be built" }, gate());
		const opened = await first.submit({ kind: "workshop-open" });
		const workshopId = String(opened.artifact?.workshopId);
		first.workshopWrite({ path: "AGENTS.md", content: "# Test Agent\n\nHalf-written by the previous session.\n" });
		expect(opened.view.workshop).toMatchObject({ state: "live", workshopId, basis: "construction", briefId: null });

		// The TUI shuts down: the note and the worktree outlive it, the handle
		// does not. A second process over the same state root is the restart.
		first.suspendWorkshop();
		const notePath = join(paths.stateRoot, "projects", "test-target", "workbench", "workshop.json");
		const note = JSON.parse(readFileSync(notePath, "utf8")) as { worktreePath: string };
		const restarted = createAhdeWorkbench({ ...paths, projectId: "test-target" });
		expect(restarted.workshopOpen).toBe(false);
		const view = await restarted.view();
		expect(view.workshopOpen).toBeUndefined();
		expect(view.workshop).toEqual({
			state: "recorded",
			workshopId,
			basis: "construction",
			briefId: null,
			openedAt: expect.stringMatching(/^\d{4}-/),
		});
		// `next` is what the Builder reads, and it now carries the exact id
		// instead of leaving “no open workshop” to be read as “nothing written”.
		const next = workbenchNext(view);
		expect(next.workshop).toEqual({
			basis: "construction",
			open: false,
			recorded: { workshopId, openedAt: expect.stringMatching(/^\d{4}-/) },
		});
		const reopen = next.submit.find((entry) => entry.kind === "workshop-open");
		expect(reopen?.when).toContain(workshopId);

		const reattached = await restarted.submit({ kind: "workshop-open", workshopId });
		expect(reattached.artifact?.reattached).toBe(true);
		expect(restarted.workshopRead({ path: "AGENTS.md" }).content).toContain("Half-written by the previous session");
		expect(reattached.view.workshop).toMatchObject({ state: "live", workshopId });
		expect(workbenchNext(reattached.view).workshop).toEqual({ basis: "construction", open: true });

		// A note whose worktree is gone re-attaches to nothing, and saying
		// “still open” about it would send the Builder at a door with no room
		// behind it.
		restarted.suspendWorkshop();
		rmSync(note.worktreePath, { recursive: true, force: true });
		const afterLoss = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
		expect(afterLoss.workshop).toEqual({ state: "stale", reason: "worktree-gone", workshopId });
		expect(workbenchNext(afterLoss).workshop).toEqual({ basis: "construction", open: false });
		expect(workbenchNext(afterLoss).submit.find((entry) => entry.kind === "workshop-open")?.when)
			.not.toContain(workshopId);
	}, 120_000);

	it("builds a pinned network container from an approved Spec before the first eval", async () => {
		const paths = target();
		const workbench = createAhdeWorkbench({
			...paths,
			projectId: "test-target",
			dependencies: { now: () => NOW },
		});
		const constructionSpec: AgentSpec = {
			...spec("Public research assistant"),
			allowedActions: ["Retrieve public web evidence"],
			constraints: ["Run network tools only in the reviewed pinned container"],
		};
		await workbench.submit({ kind: "spec-draft", spec: constructionSpec });
		const approved = await workbench.decide({
			kind: "approve-spec",
			reason: "The Spec requires bounded network construction",
		}, gate());
		expect(approved.view.stage).toBe("corpus-design");
		// No measurement had to fail before the Builder was allowed to construct
		// the execution policy the approved Spec calls for.
		expect(existsSync(paths.runsRoot)).toBe(false);

		const authoring = inspectTargetAuthoringContext({
			repositoryDir: paths.projectDir,
			expectedTarget: {
				id: loadTarget(paths.projectDir).manifest.id,
				gitSha: loadTarget(paths.projectDir).gitSha,
			},
		});
		const digest = "d".repeat(64);
		const submitted = await workbench.submit({
			kind: "structured-proposal",
			authoringContext: authoring.claim,
			approvedSpecId: approved.result.approvedSpecId,
			summary: "Construct the Spec-required pinned network runtime",
			intents: [{
				type: "execution.configure",
				execution: {
					network: "allow",
					sandbox: "required",
					container: {
						action: "replace",
						value: {
							runtime: "docker",
							image: `ahde/research@sha256:${digest}`,
							platform: "linux/amd64",
							memoryMb: 1024,
							cpus: 1,
							pidsLimit: 96,
							readOnlyRootfs: true,
						},
					},
				},
			}],
			risks: ["The pinned image must be available on the selected runtime"],
			validationPlan: ["Run the reviewed development basket in the exact container"],
		});
		expect(submitted).toMatchObject({
			artifact: {
				basis: "construction",
				sourceEvalRunId: null,
				improvementBriefId: null,
				failureModeIds: [],
				approvedSpecId: approved.result.approvedSpecId,
			},
			view: { stage: "proposal-review" },
		});
		const runId = String(submitted.artifact?.runId);
		const persisted = loadBuilderProposalRun(paths.runsRoot, runId);
		expect(persisted.request.manifestChangePolicy).toBe("execution-policy");
		expect(persisted.request.source).toBeNull();
		expect(persisted.request.proposalBasis).toBeNull();
		expect(persisted.request.proposalDiagnoses).toBeNull();
		expect(persisted.result.proposal?.diagnoses).toEqual([]);

		const review = await workbench.view({ aspect: "review" });
		expect(review.detail?.content).toMatchObject({
			kind: "proposal",
			runId,
			evidenceBasis: null,
		});
		expect(JSON.stringify(review.detail?.content)).toContain(`ahde/research@sha256:${digest}`);

		const applied = await workbench.decide({
			kind: "apply-proposal",
			runId,
			branch: "candidate/spec-container",
			reason: "Apply the exact reviewed construction diff",
		}, gate());
		expect(applied.view.stage).toBe("candidate-verification");
		const candidateManifest = parseYaml(execFileSync(
			"git",
			["-C", paths.projectDir, "show", "candidate/spec-container:manifest.yaml"],
			{ encoding: "utf8" },
		)) as { execution: Record<string, unknown> };
		expect(candidateManifest.execution).toMatchObject({
			network: "allow",
			sandbox: "required",
			container: {
				runtime: "docker",
				image: `ahde/research@sha256:${digest}`,
				platform: "linux/amd64",
				memoryMb: 1024,
				cpus: 1,
				pidsLimit: 96,
				readOnlyRootfs: true,
			},
		});
	});

	it("forwards an injected improvement compiler into Builder Workbench /traces", async () => {
		const paths = target();
		const setup = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		await setup.submit({ kind: "spec-draft", spec: spec() });
		await setup.decide({ kind: "approve-spec", reason: "Approve exact trace fixture" }, gate());
		await setup.submit({
			kind: "corpus-draft",
			name: "Trace fixture",
			tasks: [task()],
			coverageNotes: [],
			revisionSummary: "Trace fixture",
		});
		const published = await setup.decide({ kind: "publish-corpus", reason: "Publish trace fixture" }, gate());
		const evaluation = writeDevelopmentEval(paths, String(published.result.corpusId), "erun_adapter_compiler");
		const injectedHeadline = "Injected Builder Workbench compiler was used.";
		const injectedCompiler: typeof compileImprovementBrief = vi.fn((runsRoot, diagnosis) => ({
			...compileImprovementBrief(runsRoot, diagnosis),
			headline: injectedHeadline,
		}));
		const workbench = createBuilderWorkbench(
			{ ...paths, projectId: "test-target" },
			{
				diagnoseEval: diagnoseEvalRun,
				compileImprovementBrief: injectedCompiler,
				evidenceLink: () => null,
			} as unknown as BuilderWorkbenchDependencies,
		);

		const traces = await workbench.view({ aspect: "traces" });

		expect(injectedCompiler).toHaveBeenCalledOnce();
		expect(injectedCompiler).toHaveBeenCalledWith(
			paths.runsRoot,
			expect.objectContaining({ evalRunId: evaluation.evalRunId }),
		);
		expect((traces.detail?.content as { improvementBrief: { headline: string } }).improvementBrief.headline)
			.toBe(injectedHeadline);
	});

	it("imports, regrades, publishes, derives a regression from verified failure evidence, and restores it after restart", async () => {
		const paths = target();
		const first = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		await first.submit({ kind: "spec-draft", spec: spec(), sourceText: "Build from reviewed examples" });
		await first.decide({ kind: "approve-spec", reason: "Approve the exact imported-example contract" }, gate());

		mkdirSync(join(paths.projectDir, "imports"));
		writeFileSync(join(paths.projectDir, "imports", "examples.jsonl"), `${[
			{
				id: "operator-refund-example",
				input: "What is the refund window?",
				graders: [{ type: "output_contains", text: "30 days" }],
			},
			{
				id: "operator-absence-example",
				input: "What should happen when no policy exists?",
				graders: [{ type: "output_contains", text: "unknown" }],
			},
		].map((task) => JSON.stringify(task)).join("\n")}\n`, "utf8");
		const imported = await first.submit({
			kind: "corpus-import",
			sourcePath: "imports/examples.jsonl",
			name: "Imported policy basket",
			coverageNotes: ["Operator-provided example"],
			revisionSummary: "Import reviewed project-local JSONL",
		});
		expect(imported.artifact).toMatchObject({
			taskCount: 2,
			importReceipt: {
				id: expect.stringMatching(/^corpus-import-/),
				source: { path: "imports/examples.jsonl", taskCount: 2 },
			},
		});
		const importReceiptId = String((imported.artifact?.importReceipt as { id?: unknown } | undefined)?.id);
		const importedDraftId = String(imported.artifact?.id);
		const importedTask = loadBuilderCorpusDraft(paths.stateRoot, "test-target", importedDraftId).tasks[0]!;

		const graderAdded = await first.submit({
			kind: "corpus-revision",
			parentDraftId: importedDraftId,
			operations: [{
				type: "grader.add",
				taskId: importedTask.id,
				grader: { type: "output_matches", pattern: "30\\s+days" },
			}],
			revisionSummary: "Add a precise imported grader",
		});
		const addedDraft = loadBuilderCorpusDraft(paths.stateRoot, "test-target", String(graderAdded.artifact?.id));
		const addedTask = addedDraft.tasks.find((task) => task.input === importedTask.input)!;
		const graderUpdated = await first.submit({
			kind: "corpus-revision",
			parentDraftId: addedDraft.id,
			operations: [{
				type: "grader.update",
				taskId: addedTask.id,
				graderIndex: 1,
				grader: { type: "output_matches", pattern: "30\\s+calendar\\s+days" },
			}],
			revisionSummary: "Update only the new grader",
		});
		const updatedDraft = loadBuilderCorpusDraft(paths.stateRoot, "test-target", String(graderUpdated.artifact?.id));
		const updatedTask = updatedDraft.tasks.find((task) => task.input === importedTask.input)!;
		const regraded = await first.submit({
			kind: "corpus-revision",
			parentDraftId: updatedDraft.id,
			operations: [{ type: "grader.remove", taskId: updatedTask.id, graderIndex: 0 }],
			revisionSummary: "Remove the obsolete broad grader",
		});
		const regradedDraftId = String(regraded.artifact?.id);
		const regradedDraft = loadBuilderCorpusDraft(paths.stateRoot, "test-target", regradedDraftId);
		const regradedTask = regradedDraft.tasks.find((task) => task.input === importedTask.input)!;
		expect(regradedTask.input).toBe(importedTask.input);
		expect(regradedTask.id).not.toBe(importedTask.id);
		expect(regradedTask.graders).toEqual([{ type: "output_matches", pattern: "30\\s+calendar\\s+days" }]);
		expect(regradedDraft.importSource).toMatchObject({ path: "imports/examples.jsonl", taskCount: 2 });

		const published = await first.decide({ kind: "publish-corpus", reason: "Publish the reviewed imported basket" }, gate());
		const corpusId = String(published.result.corpusId);
		const evalRunId = "erun_v121_closure";
		const onRunEvent = vi.fn();
		const measuring = createAhdeWorkbench({
			...paths,
			projectId: "test-target",
			dependencies: {
				now: () => NOW,
				runSuite: async (_target, options) => {
					expect(options.onRunEvent).toBe(onRunEvent);
					return writeDevelopmentEval(paths, corpusId, evalRunId);
				},
			},
		});
		const measured = await measuring.decide({
			kind: "run-current",
			repetitions: 1,
			reason: "Measure the exact imported basket",
		}, gate(), { onRunEvent });
		expect(measured.result).toMatchObject({ resolvedAs: "run-eval", evaluation: { evalRunId } });
		if (measured.result.resolvedAs !== "run-eval") throw new Error("expected a development run");
		const measuredBrief = measured.result.improvementBrief;
		expect(measured.message).toBe(measuredBrief.headline);
		expect(measuredBrief.summary.taskLocalFailureModeCount).toBeGreaterThan(0);
		const tracesView = await measuring.view({ aspect: "traces" });
		expect((tracesView.detail?.content as {
			improvementBrief: { briefId: string };
		}).improvementBrief.briefId).toBe(measuredBrief.briefId);
		const regressionTask: { input: string; graders: GraderSpec[] } = {
			input: "Does the refund window still apply after an account migration?",
			graders: [{ type: "output_contains", text: "30 days", caseSensitive: false }],
		};
		const revision = (sourceEvalRunId: string, runId: string, derivedTask = regressionTask) => ({
			kind: "corpus-revision" as const,
			parentDraftId: regradedDraftId,
			operations: [{
				type: "add-case-from-run" as const,
				evalRunId: sourceEvalRunId,
				runId,
				task: derivedTask,
			}],
			revisionSummary: "Add a neighboring regression from the verified failure",
		});

		await expect(measuring.submit(revision(
			evalRunId,
			`run-${evalRunId}`,
			{ input: regradedTask.input, graders: regradedTask.graders },
		))).rejects.toThrow(/derived case, not an exact duplicate/);
		const otherDevelopmentTask = loadCorpus({
			stateRoot: paths.stateRoot,
			projectId: "test-target",
			corpusId,
		}).tasks.find((task) => task.input === "What should happen when no policy exists?")!;
		await expect(measuring.submit(revision(
			evalRunId,
			`run-${evalRunId}`,
			{ input: otherDevelopmentTask.input, graders: otherDevelopmentTask.graders },
		))).rejects.toThrow(/exact duplicate of development task/);
		await expect(measuring.submit(revision("erun_foreign", "run_foreign")))
			.rejects.toThrow(/not compatible verified development evidence/);
		const wrongToolsetEvalRunId = "erun_v121_wrong_toolset";
		writeDevelopmentEval(
			paths,
			corpusId,
			wrongToolsetEvalRunId,
			"fail",
			`sha256:${"9".repeat(64)}`,
		);
		await expect(measuring.submit(revision(wrongToolsetEvalRunId, `run-${wrongToolsetEvalRunId}`)))
			.rejects.toThrow(/not compatible verified development evidence/);
		const wrongWorkspaceEvalRunId = "erun_v121_wrong_workspace";
		writeDevelopmentEval(
			paths,
			corpusId,
			wrongWorkspaceEvalRunId,
			"fail",
			undefined,
			`sha256:${"8".repeat(64)}`,
		);
		await expect(measuring.submit(revision(wrongWorkspaceEvalRunId, `run-${wrongWorkspaceEvalRunId}`)))
			.rejects.toThrow(/not compatible verified development evidence/);

		const passingEvalRunId = "erun_v121_passing";
		writeDevelopmentEval(paths, corpusId, passingEvalRunId, "pass");
		await expect(measuring.submit(revision(passingEvalRunId, `run-${passingEvalRunId}`)))
			.rejects.toThrow(/completed behavioral failure/);

		const tracePath = join(paths.runsRoot, `run-${evalRunId}`, "session.jsonl");
		const exactTrace = readFileSync(tracePath, "utf8");
		writeFileSync(tracePath, `${exactTrace} `, "utf8");
		await expect(measuring.submit(revision(evalRunId, `run-${evalRunId}`)))
			.rejects.toThrow(/trace SHA mismatch/);
		writeFileSync(tracePath, exactTrace, "utf8");

		const derived = await measuring.submit(revision(evalRunId, `run-${evalRunId}`));
		expect(derived.view.stage).toBe("corpus-review");

		const restarted = createAhdeWorkbench({ ...paths, projectId: "test-target" });
		const restored = await restarted.view({ aspect: "review" });
		expect(restored).toMatchObject({
			stage: "corpus-review",
			detail: {
				content: {
					kind: "corpus-draft",
					id: derived.artifact?.id,
					importSource: { path: "imports/examples.jsonl", taskCount: 2 },
					tasks: [
						{ input: "What is the refund window?" },
						{ input: "What should happen when no policy exists?" },
						{ input: "Does the refund window still apply after an account migration?" },
					],
					taskProvenance: [{
						kind: "development-failure",
						source: { evalRunId, runId: `run-${evalRunId}`, tracePath: "session.jsonl" },
					}],
				},
			},
		});

		const receiptPath = join(
			paths.stateRoot,
			"projects",
			"test-target",
			"builder-corpus-imports",
			`${importReceiptId}.json`,
		);
		const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
		writeFileSync(receiptPath, `${JSON.stringify({
			...receipt,
			draftHash: `sha256:${"0".repeat(64)}`,
		})}\n`, "utf8");
		const blocked = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
		expect(blocked.stage).toBe("selection-required");
		expect(blocked.blockers.join("\n")).toMatch(/import provenance/);
	});

	it("never guesses between multiple compatible lineages", async () => {
		const paths = target();
		for (const title of ["First", "Second"]) {
			const draft = saveBuilderSpecDraft({ stateRoot: paths.stateRoot, projectId: "test-target", spec: spec(title), now: () => NOW });
			const subject = describeSpecDraftApproval(paths.stateRoot, "test-target", draft.id);
			approveBuilderSpecDraft({
				stateRoot: paths.stateRoot,
				projectId: "test-target",
				draftSpecId: draft.id,
				expectedDraftSnapshotHash: subject.draftSnapshotHash,
				actor: { kind: "human", id: "local:test-human" },
				reason: "Exact fixture approval",
			}, { now: () => NOW });
		}
		const workbench = createAhdeWorkbench({ ...paths, projectId: "test-target" });
		const view = await workbench.view();
		expect(view.stage).toBe("selection-required");
		expect(view.blockers[0]).toMatch(/2 approved Specs/);
		await expect(workbench.submit({
			kind: "corpus-draft",
			name: "Ambiguous",
			tasks: [task()],
			coverageNotes: [],
			revisionSummary: "Should not guess",
		})).rejects.toBeInstanceOf(WorkbenchSelectionRequiredError);

		const selected = view.selections.find((item) => item.kind === "approved-spec");
		if (!selected) throw new Error("fixture has no approved Spec selection");
		await workbench.submit({ kind: "select", entity: "approved-spec", id: selected.id });
		await expect(workbench.submit({
			kind: "corpus-draft",
			name: "Selected",
			tasks: [task()],
			coverageNotes: [],
			revisionSummary: "Uses exact selected lineage",
		})).resolves.toMatchObject({ artifact: { approvedSpecId: selected.id } });
	});

	it("does not reuse a development corpus across approved Spec lineages", async () => {
		const paths = target();
		const workbench = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		await workbench.submit({ kind: "spec-draft", spec: spec("Spec A") });
		const approvedA = await workbench.decide({ kind: "approve-spec", reason: "Approve A" }, gate());
		await workbench.submit({
			kind: "corpus-draft",
			name: "Corpus A",
			tasks: [task()],
			coverageNotes: [],
			revisionSummary: "Bound to A",
		});
		const publishedA = await workbench.decide({ kind: "publish-corpus", reason: "Publish A" }, gate());
		expect(publishedA.view.stage).toBe("ready-to-evaluate");

		await workbench.submit({ kind: "spec-draft", spec: spec("Spec B") });
		const approvedB = await workbench.decide({ kind: "approve-spec", reason: "Approve B" }, gate());
		expect(approvedB.result.approvedSpecId).not.toBe(approvedA.result.approvedSpecId);
		expect(approvedB.view.stage).toBe("corpus-design");

		await workbench.submit({
			kind: "select",
			entity: "development-corpus",
			id: String(publishedA.result.corpusId),
		});
		const view = await workbench.view();
		expect(view.stage).toBe("corpus-design");
		await expect(workbench.decide({ kind: "run-current", repetitions: 1, reason: "Must not reuse A" }, gate()))
			.rejects.toThrow(/not legal during corpus-design/);
	});

	it("reviews and publishes a selected corpus revision after an older corpus already exists", async () => {
		const paths = target();
		const workbench = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		await workbench.submit({ kind: "spec-draft", spec: spec() });
		await workbench.decide({ kind: "approve-spec", reason: "Approve" }, gate());
		const initial = await workbench.submit({
			kind: "corpus-draft",
			name: "Corpus v1",
			tasks: [task()],
			coverageNotes: [],
			revisionSummary: "Initial",
		});
		const first = await workbench.decide({ kind: "publish-corpus", reason: "Publish v1" }, gate());
		const revised = await workbench.submit({
			kind: "corpus-revision",
			parentDraftId: String(initial.artifact?.id),
			operations: [{ type: "rename", name: "Corpus v2" }],
			revisionSummary: "Reviewed rename",
		});
		expect(revised.view.stage).toBe("corpus-review");
		expect((await workbench.view({ aspect: "review" })).detail?.content).toMatchObject({
			kind: "corpus-draft",
			id: revised.artifact?.id,
		});

		const accidental = gate();
		await expect(workbench.decide({
			kind: "publish-corpus",
			draftId: String(initial.artifact?.id),
			reason: "Do not republish v1",
		}, accidental)).rejects.toBeInstanceOf(WorkbenchSelectionRequiredError);
		expect(accidental.confirm).not.toHaveBeenCalled();

		const second = await workbench.decide({ kind: "publish-corpus", reason: "Publish selected v2" }, gate());
		expect(second.result.corpusId).not.toBe(first.result.corpusId);
		expect(second.view.stage).toBe("ready-to-evaluate");
		expect(second.view.counts.developmentCorpora).toBe(2);
	});

	it("binds structured proposals to the selected Spec, reviewed corpus, and conclusive EvalRun", async () => {
		const paths = target();
		const workbench = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		await workbench.submit({ kind: "spec-draft", spec: spec() });
		const approved = await workbench.decide({ kind: "approve-spec", reason: "Approve" }, gate());
		const initial = await workbench.submit({
			kind: "corpus-draft",
			name: "Lineage A",
			tasks: [task()],
			coverageNotes: [],
			revisionSummary: "A",
		});
		const publishedA = await workbench.decide({ kind: "publish-corpus", reason: "Publish A" }, gate());
		const revised = await workbench.submit({
			kind: "corpus-revision",
			parentDraftId: String(initial.artifact?.id),
			operations: [{ type: "rename", name: "Lineage B" }],
			revisionSummary: "B",
		});
		const publishedB = await workbench.decide({
			kind: "publish-corpus",
			draftId: String(revised.artifact?.id),
			reason: "Publish B",
		}, gate());
		const evalA = writeDevelopmentEval(paths, String(publishedA.result.corpusId), "erun_lineage_a");
		const evalB = writeDevelopmentEval(paths, String(publishedB.result.corpusId), "erun_lineage_b");
		const selectionA = proposalSelection(paths, evalA.evalRunId);
		const selectionB = proposalSelection(paths, evalB.evalRunId);
		await workbench.submit({ kind: "select", entity: "eval-run", id: evalA.evalRunId });
		expect((await workbench.view()).stage).toBe("improvement-authoring");

		const recordProposal = vi.fn(async () => ({
			record: {
				runId: "builder-no-change",
				result: { status: "completed", proposal: { decision: "no-change" }, error: null },
			},
		}));
		const inspectAuthoringContext = vi.fn(inspectTargetAuthoringContext);
		const authoritative = createAhdeWorkbench({
			...paths,
			projectId: "test-target",
			dependencies: {
				now: () => NOW,
				recordProposal: recordProposal as never,
				inspectTargetAuthoringContext: inspectAuthoringContext,
			},
		});
		const proposal = {
			kind: "structured-proposal" as const,
			authoringContext: authoringContextClaim(paths),
			...selectionA,
			summary: "Use exact lineage evidence to add generic research capability",
			intents: [
				{
					type: "execution.configure" as const,
					execution: {
						tools: ["read" as const],
						environmentAllowlist: ["RESEARCH_API_KEY"],
						network: "allow" as const,
						sandbox: "best-effort" as const,
					},
				},
				{
					type: "tool.upsert" as const,
					name: "research_web",
					descriptor: {
						description: "Retrieve bounded public web evidence for one research query.",
						parameters: {
							type: "object",
							properties: { query: { type: "string" } },
							required: ["query"],
							additionalProperties: false,
						},
						timeoutMs: 30_000,
						maxOutputBytes: 64 * 1024,
						output: "json" as const,
						permissions: {
							environment: ["RESEARCH_API_KEY"],
							network: "allow" as const,
							filesystem: "read-only" as const,
						},
					},
					executable: "#!/usr/bin/env node\nprocess.stdout.write('[]\\n');\n",
				},
			],
			risks: [],
			validationPlan: ["Re-run the reviewed corpus"],
		};
		await expect(authoritative.submit(proposal)).rejects.toThrow(/development EvalRun/);
		expect(recordProposal).not.toHaveBeenCalled();
		await expect(authoritative.submit({
			...proposal,
			...selectionB,
			authoringContext: { ...proposal.authoringContext, contextHash: `sha256:${"0".repeat(64)}` },
		})).rejects.toThrow(/Target authoring context is stale/);
		expect(recordProposal).not.toHaveBeenCalled();

		await expect(authoritative.submit({ ...proposal, ...selectionB })).resolves.toMatchObject({
			artifact: {
				decision: "no-change",
				approvedSpecId: approved.result.approvedSpecId,
				authoringContextHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
			},
		});
		expect(inspectAuthoringContext).toHaveBeenCalledTimes(2);
		expect(inspectAuthoringContext).toHaveBeenCalledWith({
			repositoryDir: paths.projectDir,
			expectedTarget: { id: "test-target", gitSha: loadTarget(paths.projectDir).gitSha },
		});
		expect(recordProposal).toHaveBeenCalledWith(expect.objectContaining({
			proposal: expect.objectContaining({ baseTargetSha: loadTarget(paths.projectDir).gitSha }),
			authoringContext: authoringContextClaim(paths),
			sourceEvalRunId: evalB.evalRunId,
			proposalBasis: { ...selectionB.source, failureModeIds: selectionB.failureModeIds },
			approvedSpec: expect.objectContaining({ specId: approved.result.approvedSpecId }),
		}));

		recordProposal.mockResolvedValueOnce({
			record: {
				runId: "builder-failed-closed",
				result: {
					status: "failed",
					proposal: null,
					error: { code: "base-mismatch", message: "Target changed before recording", retryable: true },
				},
			},
		} as never);
		await expect(authoritative.submit({ ...proposal, ...selectionB }))
			.rejects.toThrow(/structured proposal recording failed closed \(failed\).*base-mismatch/);
	});

	it("pins compilation to the exact Target revision inspected for authoring", async () => {
		const paths = target();
		const setup = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		await setup.submit({ kind: "spec-draft", spec: spec("Pinned authoring revision") });
		await setup.decide({ kind: "approve-spec", reason: "Approve the pinned revision fixture" }, gate());
		await setup.submit({
			kind: "corpus-draft",
			name: "Pinned authoring corpus",
			tasks: [task()],
			coverageNotes: [],
			revisionSummary: "Pinned revision fixture",
		});
		const published = await setup.decide({
			kind: "publish-corpus",
			reason: "Publish the pinned revision fixture",
		}, gate());
		const evaluation = writeDevelopmentEval(
			paths,
			String(published.result.corpusId),
			"erun_pinned_authoring_revision",
		);
		const selection = proposalSelection(paths, evaluation.evalRunId);
		const viewedContext = authoringContextClaim(paths);
		const recordProposal = vi.fn();
		const inspectThenAdvance = vi.fn((input: Parameters<typeof inspectTargetAuthoringContext>[0]) => {
			const inspected = inspectTargetAuthoringContext(input);
			writeFileSync(join(paths.projectDir, "AGENTS.md"), "# Concurrent clean revision\n", "utf8");
			execFileSync("git", ["-C", paths.projectDir, "add", "AGENTS.md"]);
			execFileSync("git", [
				"-C", paths.projectDir,
				"-c", "user.name=AHDE Test",
				"-c", "user.email=ahde-test@example.invalid",
				"commit", "-m", "concurrent target revision",
			]);
			return inspected;
		});
		const workbench = createAhdeWorkbench({
			...paths,
			projectId: "test-target",
			dependencies: {
				now: () => NOW,
				inspectTargetAuthoringContext: inspectThenAdvance,
				recordProposal: recordProposal as never,
			},
		});

		await expect(workbench.submit({
			kind: "structured-proposal",
			authoringContext: viewedContext,
			...selection,
			summary: "Never silently compile against a newer clean revision",
			intents: [{ type: "instructions.replace", content: "# Intended pinned change\n" }],
			risks: [],
			validationPlan: ["Re-run the exact development corpus"],
		})).rejects.toThrow(/changed since the Target authoring context was inspected/);
		expect(inspectThenAdvance).toHaveBeenCalledOnce();
		expect(recordProposal).not.toHaveBeenCalled();
	});

	it("keeps historical proposal provenance valid when the live Target later changes", async () => {
		const paths = target();
		const workbench = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		await workbench.submit({ kind: "spec-draft", spec: spec() });
		await workbench.decide({ kind: "approve-spec", reason: "Approve historical source" }, gate());
		await workbench.submit({
			kind: "corpus-draft",
			name: "Historical source corpus",
			tasks: [task()],
			coverageNotes: [],
			revisionSummary: "Historical source",
		});
		const published = await workbench.decide({ kind: "publish-corpus", reason: "Publish historical source" }, gate());
		const evaluation = writeDevelopmentEval(paths, String(published.result.corpusId), "erun_historical_source");
		const selection = proposalSelection(paths, evaluation.evalRunId);
		const authored = await workbench.submit({
			kind: "structured-proposal",
			authoringContext: authoringContextClaim(paths),
			...selection,
			summary: "Keep historical evidence historical",
			intents: [{ type: "instructions.replace", content: "# Proposed historical change\n" }],
			risks: [],
			validationPlan: ["Re-run exact development evidence"],
		});
		const proposalId = String(authored.artifact?.runId);
		const persisted = loadBuilderProposalRun(paths.runsRoot, proposalId);
		expect(persisted.request.proposalBasis).toMatchObject({
			evalRunId: evaluation.evalRunId,
			briefId: selection.source.briefId,
			failureModes: [{ failureModeId: selection.failureModeIds[0] }],
		});
		expect(persisted.request.authoringContext).toEqual(authoringContextClaim(paths));
		expect(persisted.result.proposal?.diagnoses).toEqual([expect.objectContaining({
			failureIds: selection.failureModeIds,
			evidence: [`eval:${evaluation.evalRunId}/run:run-${evaluation.evalRunId}`],
			rootCause: expect.stringMatching(/^Host-derived from the cited traces \(what happened, not why\):/),
		})]);

		writeFileSync(join(paths.projectDir, "AGENTS.md"), "# A later live Target change\n", "utf8");
		const view = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
		expect(view.stage).toBe("proposal-review");
		expect(view.blockers).toEqual([]);
		expect(view.selections).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "proposal", id: proposalId, status: "open" }),
		]));
		const reviewed = (await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view({ aspect: "review" })).detail?.content;
		expect(reviewed)
			.toMatchObject({
				evidenceBasis: {
					evalRunId: evaluation.evalRunId,
					briefId: selection.source.briefId,
					failureModes: [{ failureModeId: selection.failureModeIds[0] }],
				},
	});
		// The attestation hashes an id; the panel has to say what it was. The
		// title is read off the brief that id names, never invented.
		const targeted = (reviewed as { targetedModes?: { failureModeId: string; title: string }[] }).targetedModes;
		expect(targeted).toEqual([{ failureModeId: selection.failureModeIds[0], title: expect.any(String) }]);
		expect(targeted![0]!.title.length).toBeGreaterThan(0);
		expect(targeted![0]!.title).not.toContain(selection.failureModeIds[0]);

		const runDir = join(paths.runsRoot, "builders", proposalId);
		const inputPath = join(runDir, "builder_input.txt");
		const runPath = join(runDir, "builder_run.json");
		const forgedModeHash = `sha256:${"0".repeat(64)}`;
		const forgedBasis = {
			...persisted.request.proposalBasis!,
			failureModes: persisted.request.proposalBasis!.failureModes.map((mode, index) =>
				index === 0 ? { ...mode, modeSha256: forgedModeHash } : mode
			),
		};
		const inputValue = JSON.parse(readFileSync(inputPath, "utf8")) as {
			evaluationEvidence: { proposalBasis: unknown };
		};
		inputValue.evaluationEvidence.proposalBasis = forgedBasis;
		const inputContent = `${JSON.stringify(inputValue)}\n`;
		const forgedRecord = {
			...persisted,
			request: {
				...persisted.request,
				proposalBasis: forgedBasis,
				builderInputSha256: hashFile(inputContent),
				builderInputBytes: Buffer.byteLength(inputContent),
			},
			artifacts: {
				...persisted.artifacts,
				input: {
					...persisted.artifacts.input,
					sha256: hashFile(inputContent),
					bytes: Buffer.byteLength(inputContent),
				},
			},
		};
		chmodSync(inputPath, 0o600);
		chmodSync(runPath, 0o600);
		writeFileSync(inputPath, inputContent, "utf8");
		writeFileSync(runPath, `${JSON.stringify(forgedRecord, null, "\t")}\n`, "utf8");
		expect(() => loadBuilderProposalRun(paths.runsRoot, proposalId)).toThrow(/basis no longer matches/);
		const blocked = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
		expect(blocked.blockers.join("\n")).toContain(proposalId);
	});

	it("answers “run it” during Spec review with the start-testing gate instead of a run", async () => {
		const paths = target();
		const runSuite = vi.fn();
		const workbench = createAhdeWorkbench({
			...paths,
			projectId: "test-target",
			dependencies: { now: () => NOW, runSuite: runSuite as never },
		});
		await workbench.submit({ kind: "spec-draft", spec: spec() });

		// Declining the one dialog leaves the Spec unapproved and runs nothing.
		const declined = gate(false);
		await expect(workbench.decide({ kind: "run-current", repetitions: 1, reason: "Not yet" }, declined))
			.rejects.toBeInstanceOf(WorkbenchDecisionDeclinedError);
		expect(declined.confirm).toHaveBeenCalledOnce();
		expect(declined.confirm.mock.calls[0]?.[0].kind).toBe("start-testing");
		expect((await workbench.view()).stage).toBe("spec-review");

		const human = gate();
		const started = await workbench.decide({ kind: "run-current", repetitions: 1, reason: "Start testing" }, human);
		// One question, and no evaluation: the basket cannot exist before the
		// approval it is bound to, so the composite stops there and says so.
		expect(human.confirm).toHaveBeenCalledOnce();
		expect(human.confirm.mock.calls[0]?.[0]).toMatchObject({
			kind: "start-testing",
			policy: "consequential",
			subject: { operation: "start-testing", steps: ["approve-spec"] },
		});
		expect(started.result).toMatchObject({
			resolvedAs: "start-testing",
			steps: [{ kind: "approve-spec" }],
			evaluation: null,
			pending: "the test cases are not drafted yet",
		});
		expect(runSuite).not.toHaveBeenCalled();
		expect(started.view.stage).toBe("corpus-design");
	});

	it("refuses run-eval outright wherever no basket can be running", async () => {
		const paths = target();
		const runSuite = vi.fn();
		const workbench = createAhdeWorkbench({
			...paths,
			projectId: "test-target",
			dependencies: { now: () => NOW, runSuite: runSuite as never },
		});
		await workbench.submit({ kind: "spec-draft", spec: spec() });
		const human = gate();
		await expect(workbench.decide({ kind: "run-eval", repetitions: 1, reason: "Try to skip" }, human))
			.rejects.toThrow(/run-eval is not legal during spec-review/);
		expect(runSuite).not.toHaveBeenCalled();
		expect(human.confirm).not.toHaveBeenCalled();
	});

	it("recovers a corpus publication crash window without republishing content", async () => {
		const paths = target();
		const workbench = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		await workbench.submit({ kind: "spec-draft", spec: spec() });
		await workbench.decide({ kind: "approve-spec", reason: "Approve" }, gate());
		const drafted = await workbench.submit({
			kind: "corpus-draft",
			name: "Recoverable corpus",
			tasks: [task()],
			coverageNotes: [],
			revisionSummary: "Crash recovery fixture",
		});
		const exactDraft = loadBuilderCorpusDraft(paths.stateRoot, "test-target", String(drafted.artifact?.id));
		const subject = describeDevelopmentCorpusPublication({
			projectId: "test-target",
			name: exactDraft.name,
			tasks: exactDraft.tasks,
		});
		const partial = publishBuilderDevelopmentCorpus({
			stateRoot: paths.stateRoot,
			projectId: "test-target",
			name: exactDraft.name,
			tasks: exactDraft.tasks,
			expectedSubjectHash: subject.subjectHash,
			actor: { kind: "human", id: "local:test-human" },
			reason: "Core publication completed before crash",
		}, { now: () => NOW });

		expect((await workbench.view()).stage).toBe("corpus-review");
		expect((await workbench.view()).counts.developmentCorpora).toBe(0);
		const recovered = await workbench.decide({ kind: "publish-corpus", reason: "Recover reviewed lineage" }, gate());
		expect(recovered.result.corpusId).toBe(partial.corpus.id);
		expect(recovered.view.stage).toBe("ready-to-evaluate");
	});

	it("ignores valid legacy development corpora that have no V1.2 Spec-bound lineage", async () => {
		const paths = target();
		const legacy = publishBuilderDevelopmentCorpus({
			stateRoot: paths.stateRoot,
			projectId: "test-target",
			name: "Legacy direct-tool corpus",
			tasks: [{ id: "legacy-task", ...task() }],
			expectedSubjectHash: describeDevelopmentCorpusPublication({
				projectId: "test-target",
				name: "Legacy direct-tool corpus",
				tasks: [{ id: "legacy-task", ...task() }],
			}).subjectHash,
			actor: { kind: "human", id: "local:legacy-human" },
			reason: "Pre-Workbench compatibility fixture",
		}, { now: () => NOW });

		const view = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
		expect(view.stage).toBe("spec-design");
		expect(view.counts.developmentCorpora).toBe(0);
		expect(view.warnings).toEqual(expect.arrayContaining([expect.stringContaining("legacy/unbound evidence")]));
		expect(view.selections.find((item) => item.id === legacy.corpus.id)?.status).toBe("unbound");
	});

	it("ignores orphan approved snapshots that have no human approval receipt", async () => {
		const paths = target();
		const orphan = saveSpecSnapshot({
			stateRoot: paths.stateRoot,
			projectId: "test-target",
			status: "approved",
			spec: spec("Orphan"),
			now: () => NOW,
		});
		const view = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
		expect(view.stage).toBe("spec-design");
		expect(view.counts.approvedSpecs).toBe(0);
		expect(view.warnings).toEqual(expect.arrayContaining([expect.stringContaining(orphan.id)]));
		expect(view.selections.find((item) => item.id === orphan.id)?.status).toBe("unverified");
	});

	it("blocks proposals whose approved Spec reference has no exact approval receipt", async () => {
		const paths = target();
		const orphan = saveSpecSnapshot({
			stateRoot: paths.stateRoot,
			projectId: "test-target",
			status: "approved",
			spec: spec("Unreceipted proposal authority"),
			now: () => NOW,
		});
		const proposal = compileHarnessAuthoringProposal({
			repositoryDir: paths.projectDir,
			intents: [{ type: "instructions.replace", content: "# Unreceipted authority\n" }],
			summary: "Must not enter inventory",
			diagnoses: [],
			risks: [],
			validationPlan: ["Do not apply"],
		});
		const recorded = await recordBuilderAuthoredProposal({
			proposal,
			targetDir: paths.projectDir,
			allowedPaths: [...CANDIDATE_SCOPE_POLICY.allowed],
			approvedSpec: { stateRoot: paths.stateRoot, projectId: "test-target", specId: orphan.id },
			runsRoot: paths.runsRoot,
			timeoutMs: 30_000,
		});

		const view = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
		expect(view.stage).toBe("selection-required");
		expect(view.actions).toEqual([]);
		expect(view.blockers).toEqual(expect.arrayContaining([expect.stringContaining("exact valid human approval receipt")]));
		expect(view.selections.some((item) => item.kind === "proposal" && item.id === recorded.record.runId)).toBe(false);
	});

	it("blocks when an authoritative candidate record is present but corrupt", async () => {
		const paths = target();
		const candidateDir = join(paths.runsRoot, "candidates", "candidate-corrupt");
		mkdirSync(candidateDir, { recursive: true });
		writeFileSync(join(candidateDir, "candidate.json"), "{}\n", "utf8");

		const view = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
		expect(view.stage).toBe("selection-required");
		expect(view.actions).toEqual([]);
		expect(view.blockers).toEqual(expect.arrayContaining([expect.stringContaining("candidate candidate-corrupt")]));
	});

	it("blocks an applied candidate whose provenance does not match the admitted proposal artifacts", async () => {
		const paths = target();
		const workbench = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		await workbench.submit({ kind: "spec-draft", spec: spec() });
		const approved = await workbench.decide({ kind: "approve-spec", reason: "Approve candidate authority" }, gate());
		const proposal = compileHarnessAuthoringProposal({
			repositoryDir: paths.projectDir,
			intents: [{ type: "instructions.replace", content: "# Candidate authority fixture\n" }],
			summary: "Exercise exact candidate provenance",
			diagnoses: [],
			risks: [],
			validationPlan: ["Reject a mismatched provenance artifact"],
		});
		const recorded = await recordBuilderAuthoredProposal({
			proposal,
			targetDir: paths.projectDir,
			allowedPaths: [...CANDIDATE_SCOPE_POLICY.allowed],
			approvedSpec: {
				stateRoot: paths.stateRoot,
				projectId: "test-target",
				specId: String(approved.result.approvedSpecId),
			},
			runsRoot: paths.runsRoot,
			timeoutMs: 30_000,
		});
		const applied = applyBuilderProposal({
			repoDir: paths.projectDir,
			runsRoot: paths.runsRoot,
			runId: recorded.record.runId,
			requestedBranch: "candidate/provenance-mismatch",
			actor: { kind: "human", id: "local:test-human" },
			reason: "Candidate authority fixture",
		});
		const runDir = join(paths.runsRoot, "builders", recorded.record.runId);
		const approvedSpec = recorded.record.request.approvedSpec!;
		const exactTarget = loadTarget(paths.projectDir);
		const candidate = createCandidate({
			candidateId: "candidate-mismatched-provenance",
			projectId: "test-target",
			targetId: exactTarget.manifest.id,
			specId: approvedSpec.specId,
			proposalId: recorded.record.runId,
			diagnosisId: null,
			origin: {
				kind: "applied-builder",
				builderRunId: recorded.record.runId,
				builderRun: { ...artifactRef(join(runDir, "builder_run.json")), sha256: `sha256:${"0".repeat(64)}` },
				builderInput: artifactRef(join(runDir, "builder_input.txt")),
				proposal: artifactRef(join(runDir, "proposal.json")),
				applyReceipt: artifactRef(join(runDir, "apply_receipt.json")),
				application: {
					actor: applied.receipt.actor,
					reason: applied.receipt.reason,
					appliedAt: applied.receipt.appliedAt,
					baseTargetSha: applied.receipt.baseTargetSha,
					candidateSha: applied.receipt.candidateSha,
					proposalSha256: applied.receipt.proposalSha256,
				},
				source: null,
				approvedSpec: {
					...approvedSpec,
					artifact: artifactRef(join(paths.stateRoot, "projects", "test-target", "specs", `${approvedSpec.specId}.json`)),
				},
			},
			mode: "candidate",
			baseline: { ref: "refs/heads/master", sha: applied.receipt.baseTargetSha },
			eventId: "candidate-mismatched-provenance-proposed",
			at: NOW,
			actor: { kind: "human", id: "local:test-human" },
		});
		const candidateDir = join(paths.runsRoot, "candidates", candidate.candidateId);
		mkdirSync(candidateDir, { recursive: true });
		writeFileSync(join(candidateDir, "candidate.json"), `${JSON.stringify(candidate)}\n`, "utf8");

		const view = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
		expect(view.stage).toBe("selection-required");
		expect(view.actions).toEqual([]);
		expect(view.blockers).toEqual(expect.arrayContaining([expect.stringContaining("candidate provenance artifact hash")]));
		expect(view.selections.some((item) => item.id === candidate.candidateId)).toBe(false);
	});

	it("does not expose valid candidates owned by another project", async () => {
		const paths = target();
		const exactTarget = loadTarget(paths.projectDir);
		const foreign = createCandidate({
			candidateId: "candidate-other-project",
			projectId: "another-project",
			targetId: exactTarget.manifest.id,
			specId: null,
			proposalId: "manual-foreign-proposal",
			diagnosisId: null,
			origin: { kind: "manual", reason: "foreign fixture" },
			mode: "candidate",
			baseline: { ref: "refs/heads/master", sha: exactTarget.gitSha },
			eventId: "candidate-other-project-proposed",
			at: NOW,
			actor: { kind: "human", id: "local:test-human" },
		});
		const candidateDir = join(paths.runsRoot, "candidates", foreign.candidateId);
		mkdirSync(candidateDir, { recursive: true });
		writeFileSync(join(candidateDir, "candidate.json"), `${JSON.stringify(foreign)}\n`, "utf8");

		const view = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
		expect(view.stage).toBe("spec-design");
		expect(view.counts.candidates).toBe(0);
		expect(JSON.stringify(view)).not.toContain(foreign.candidateId);
	});

	it("blocks when a receipt-backed development corpus no longer matches its content", async () => {
		const paths = target();
		const workbench = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		await workbench.submit({ kind: "spec-draft", spec: spec() });
		await workbench.decide({ kind: "approve-spec", reason: "Approve" }, gate());
		await workbench.submit({
			kind: "corpus-draft",
			name: "Tamper target",
			tasks: [task()],
			coverageNotes: [],
			revisionSummary: "Before tamper",
		});
		const published = await workbench.decide({ kind: "publish-corpus", reason: "Publish" }, gate());
		const loaded = loadCorpus({
			stateRoot: paths.stateRoot,
			projectId: "test-target",
			corpusId: String(published.result.corpusId),
		});
		const contentPath = join(
			paths.stateRoot,
			"projects",
			"test-target",
			"corpora",
			loaded.metadata.id,
			loaded.metadata.contentPath,
		);
		chmodSync(contentPath, 0o600);
		writeFileSync(contentPath, `${JSON.stringify({ id: "tampered-task", ...task("tampered", "tampered") })}\n`, "utf8");

		const view = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
		expect(view.stage).toBe("selection-required");
		expect(view.actions).toEqual([]);
		expect(view.counts.developmentCorpora).toBe(0);
		expect(view.blockers).toEqual(expect.arrayContaining([expect.stringContaining("reviewed lineage integrity checks")]));
	});

	it("lets a human abandon an interrupted candidate checkpoint and unblocks restart", async () => {
		const paths = target();
		const exactTarget = loadTarget(paths.projectDir);
		const candidate = createCandidate({
			candidateId: "candidate-interrupted",
			projectId: "test-target",
			targetId: exactTarget.manifest.id,
			specId: null,
			proposalId: "manual-proposal",
			diagnosisId: null,
			origin: { kind: "manual", reason: "restart recovery fixture" },
			mode: "candidate",
			baseline: { ref: "refs/heads/master", sha: exactTarget.gitSha },
			eventId: "candidate-interrupted-proposed",
			at: NOW,
			actor: { kind: "human", id: "local:test-human" },
		});
		const candidateDir = join(paths.runsRoot, "candidates", candidate.candidateId);
		mkdirSync(candidateDir, { recursive: true });
		writeFileSync(join(candidateDir, "candidate.json"), `${JSON.stringify(candidate)}\n`, "utf8");

		const workbench = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		const interrupted = await workbench.view({ aspect: "review" });
		expect(interrupted.stage).toBe("candidate-verification");
		const summary = await workbench.view();
		expect(summary.guidance).toEqual(interrupted.guidance);
		expect(workbenchNext(summary).decide.map((item) => item.kind)).not.toContain("run-current");
		expect(workbenchNext(summary).decide.map((item) => item.kind)).not.toContain("verify-candidate");
		expect(summary.guidance?.recovery).toEqual({ kind: "inspect-candidate", candidateId: candidate.candidateId });
		expect(nextStep(summary)).toBe(nextStep(interrupted));
		expect(workbenchGuidanceContext(summary)).toContain(candidate.candidateId);
		await expect(workbench.decide({ kind: "run-current", repetitions: 1, reason: "retry" }, gate()))
			.rejects.toThrow(/review and explicitly abandon or recover/);
		expect(readFileSync(join(candidateDir, "candidate.json"), "utf8")).toBe(`${JSON.stringify(candidate)}\n`);

		expect(interrupted.detail?.content).toMatchObject({
			kind: "interrupted-candidate",
			candidateId: candidate.candidateId,
			status: "proposed",
		});

		const abandoned = await workbench.decide({
			kind: "abandon-candidate",
			candidateId: candidate.candidateId,
			reason: "The attempt stopped before evaluation; retry from reviewed inputs",
		}, gate());
		expect(abandoned.result).toMatchObject({ candidateId: candidate.candidateId, interruptedStatus: "proposed" });
		expect(abandoned.view.stage).toBe("spec-design");
		expect(existsSync(join(
			paths.stateRoot,
			"projects",
			"test-target",
			"workbench",
			"candidate-abandonments",
			`${candidate.candidateId}.json`,
		))).toBe(true);
	});

	it("reviews an applied proposal before any candidate record exists", async () => {
		const paths = target();
		const workbench = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		await workbench.submit({ kind: "spec-draft", spec: spec() });
		const approved = await workbench.decide({ kind: "approve-spec", reason: "Approve exact proposal input" }, gate());
		const proposal = compileHarnessAuthoringProposal({
			repositoryDir: paths.projectDir,
			intents: [{ type: "instructions.replace", content: "# Policy Target\n\nUse approved evidence and say when evidence is missing.\n" }],
			summary: "Make evidence boundaries explicit",
			diagnoses: [],
			risks: ["Instruction-only behavior change"],
			validationPlan: ["Run the reviewed development corpus"],
		});
		const recorded = await recordBuilderAuthoredProposal({
			proposal,
			targetDir: paths.projectDir,
			allowedPaths: [...CANDIDATE_SCOPE_POLICY.allowed],
			approvedSpec: {
				stateRoot: paths.stateRoot,
				projectId: "test-target",
				specId: String(approved.result.approvedSpecId),
			},
			runsRoot: paths.runsRoot,
			timeoutMs: 30_000,
		});
		const applied = applyBuilderProposal({
			repoDir: paths.projectDir,
			runsRoot: paths.runsRoot,
			runId: recorded.record.runId,
			requestedBranch: "candidate/workbench-review",
			actor: { kind: "human", id: "local:test-human" },
			reason: "Review fixture application",
		});

		const review = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view({ aspect: "review" });
		expect(review.stage).toBe("candidate-verification");
		expect(review.detail?.content).toMatchObject({
			kind: "applied-proposal",
			runId: recorded.record.runId,
			application: {
				branch: applied.receipt.branch,
				candidateSha: applied.receipt.candidateSha,
			},
		});
	});

	it("fails a consequential transition when the exact subject changes after confirmation", async () => {
		const paths = target();
		const real = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		const drafted = await real.submit({ kind: "spec-draft", spec: spec() });
		const exactDraftId = String(drafted.artifact?.id);
		const draft = JSON.parse(readFileSync(join(paths.stateRoot, "projects", "test-target", "specs", `${exactDraftId}.json`), "utf8")) as unknown;
		let call = 0;
		const workbench = createAhdeWorkbench({
			...paths,
			projectId: "test-target",
			dependencies: {
				describeSpecApproval: (() => ({
					schemaVersion: 1,
					projectId: "test-target",
					draftSpecId: exactDraftId,
					draftSnapshotHash: call++ === 0 ? hashValue(draft) : `sha256:${"0".repeat(64)}`,
					specContentHash: hashValue(spec()),
				})) as never,
			},
		});
		await expect(workbench.decide({ kind: "approve-spec", reason: "Approve exact snapshot" }, gate()))
			.rejects.toBeInstanceOf(WorkbenchStaleDecisionError);
		expect((await workbench.view()).counts.approvedSpecs).toBe(0);
	});

	it("reports only a sealed count and never leaks evaluator-owned ids in Builder views", async () => {
		const paths = target();
		const sealed = createCorpus({
			stateRoot: paths.stateRoot,
			projectId: "test-target",
			name: "secret holdout name",
			visibility: "sealed",
			tasks: [{ id: "secret-case", ...task("secret prompt", "secret answer") }],
		});
		const view = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
		const serialized = JSON.stringify(view);
		expect(view.counts.sealedCorpora).toBe(1);
		expect(view.shippingReadiness).toEqual({ sealedHoldout: "underpowered", minimumTasks: 15, sealedCases: 1 });
		expect(serialized).not.toContain(sealed.id);
		expect(serialized).not.toContain("secret holdout name");
		expect(serialized).not.toContain("secret prompt");

		const metadataPath = join(paths.stateRoot, "projects", "test-target", "corpora", sealed.id, "metadata.json");
		chmodSync(metadataPath, 0o600);
		writeFileSync(metadataPath, `${JSON.stringify({ secret: "secret holdout name secret prompt" })}\n`, "utf8");
		const blocked = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
		const blockedSerialized = JSON.stringify(blocked);
		expect(blocked.stage).toBe("selection-required");
		expect(blocked.actions).toEqual([]);
		expect(blocked.blockers).toEqual(expect.arrayContaining([expect.stringContaining("sealed identities remain hidden")]));
		expect(blockedSerialized).not.toContain(sealed.id);
		expect(blockedSerialized).not.toContain("secret holdout name");
		expect(blockedSerialized).not.toContain("secret prompt");
	});

	it("marks a metadata-sized holdout unavailable when its private content is missing, corrupt, hash-mismatched, or unsafe", async () => {
		const cases = [
			{
				label: "missing",
				mutate: (path: string) => rmSync(path),
			},
			{
				label: "corrupt",
				mutate: (path: string) => writeFileSync(path, "PRIVATE-CORRUPTION-CANARY\n", "utf8"),
			},
			{
				label: "hash-mismatch",
				mutate: (path: string) => {
					const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
					rows[0] = { ...rows[0], input: "PRIVATE-HASH-MISMATCH-CANARY" };
					writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
				},
			},
			{
				label: "unsafe-mode",
				mutate: (path: string) => chmodSync(path, 0o644),
			},
		] as const;

		for (const scenario of cases) {
			const paths = target();
			const sealed = createCorpus({
				stateRoot: paths.stateRoot,
				projectId: "test-target",
				name: `PRIVATE-${scenario.label}-HOLDOUT`,
				visibility: "sealed",
				tasks: Array.from({ length: 15 }, (_, index) => ({
					id: `${scenario.label}-${index}`,
					...task(`PRIVATE-${scenario.label}-PROMPT-${index}`, "private answer"),
				})),
			});
			const before = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
			expect(before.shippingReadiness, scenario.label).toEqual({ sealedHoldout: "ready", minimumTasks: 15, sealedCases: 15 });

			const contentPath = join(paths.stateRoot, "projects", "test-target", "corpora", sealed.id, sealed.contentPath);
			scenario.mutate(contentPath);
			const view = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
			const serialized = JSON.stringify(view);

			// Nothing verified, so there is no count to state either.
			expect(view.shippingReadiness, scenario.label).toEqual({ sealedHoldout: "unavailable", minimumTasks: 15, sealedCases: null });
			expect(view.counts.sealedCorpora, scenario.label).toBe(1);
			expect(serialized, scenario.label).not.toContain(sealed.id);
			expect(serialized, scenario.label).not.toContain(sealed.hash);
			expect(serialized, scenario.label).not.toContain(`PRIVATE-${scenario.label}`);
			expect(serialized, scenario.label).not.toContain(contentPath);
		}
	});

	it("bases readiness on independently verified holdouts instead of invalid metadata counts", async () => {
		const paths = target();
		const broken = createCorpus({
			stateRoot: paths.stateRoot,
			projectId: "test-target",
			name: "PRIVATE-BROKEN-LARGE-HOLDOUT",
			visibility: "sealed",
			tasks: Array.from({ length: 15 }, (_, index) => ({ id: `broken-${index}`, ...task(`broken-${index}`) })),
		});
		const brokenPath = join(paths.stateRoot, "projects", "test-target", "corpora", broken.id, broken.contentPath);
		rmSync(brokenPath);
		createCorpus({
			stateRoot: paths.stateRoot,
			projectId: "test-target",
			name: "PRIVATE-VALID-SMALL-HOLDOUT",
			visibility: "sealed",
			tasks: [{ id: "small", ...task("small") }],
		});

		const underpowered = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
		// The count is the verified exam's, never the broken one's: 1, not 15.
		expect(underpowered.shippingReadiness).toEqual({ sealedHoldout: "underpowered", minimumTasks: 15, sealedCases: 1 });
		expect(JSON.stringify(underpowered)).not.toContain(broken.id);

		createCorpus({
			stateRoot: paths.stateRoot,
			projectId: "test-target",
			name: "PRIVATE-VALID-READY-HOLDOUT",
			visibility: "sealed",
			tasks: Array.from({ length: 15 }, (_, index) => ({ id: `ready-${index}`, ...task(`ready-${index}`) })),
		});
		const ready = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
		expect(ready.shippingReadiness).toEqual({ sealedHoldout: "ready", minimumTasks: 15, sealedCases: 15 });
		expect(JSON.stringify(ready)).not.toMatch(/PRIVATE-(?:BROKEN|VALID)/);
	});

	it("warns once a sealed holdout has judged too many candidates, without naming it", async () => {
		const paths = target();
		const exactTarget = loadTarget(paths.projectDir);
		const sealed = createCorpus({
			stateRoot: paths.stateRoot,
			projectId: "test-target",
			name: "overused holdout name",
			visibility: "sealed",
			tasks: [{ id: "sealed-case", ...task("sealed prompt", "sealed answer") }],
		});
		const hash = `sha256:${"c".repeat(64)}`;
		const gateEvidence = (surface: "development" | "sealed") => ({
			schemaVersion: 4,
			algorithmId: EXACT_COMPARISON_GATE_ALGORITHM_ID_V4,
			policyId: surface === "sealed" ? "sealed-guardrail-v4" : "development-ci-v4",
			surface,
			comparisonHash: hash,
			evidenceHash: hash,
			gateHash: hash,
			summary: {
				taskCount: 1,
				baselinePassRate: 1,
				candidatePassRate: 1,
				delta: 0,
				baselineScore: 1,
				candidateScore: 1,
				scoreDelta: 0,
				confidence95: { low: 0, high: 0 },
				improved: 0,
				regressed: 0,
				unchanged: 1,
			},
			design: { tasks: 1, repetitions: 2, excludedTasks: 0 },
			verdict: surface === "sealed" ? "pass" : "inconclusive",
			flags: { regressedTasks: 0, improvedTasks: 0, collapsedTasks: 0 },
			resources: { baseline: { runs: 30, costUsd: 0.1, meanLatencyMs: 2000, meanTokens: 800 }, candidate: { runs: 30, costUsd: 0.14, meanLatencyMs: 1800, meanTokens: 900 }, costRatio: 1.4, latencyRatio: 0.9, tokenRatio: 1.125 },
			reasons: ["fixture"],
		});
		const actor = { kind: "human" as const, id: "local:test-human" };
		const system = { kind: "system" as const, id: "candidate-experiment" };
		const baseline = { ref: "refs/heads/master", sha: exactTarget.gitSha };
		for (let index = 0; index < 6; index += 1) {
			const candidateId = `candidate-sealed-${index}`;
			const built = { ref: `refs/heads/candidate-${index}`, sha: `${index}`.repeat(40) };
			let record = createCandidate({
				candidateId,
				projectId: "test-target",
				targetId: exactTarget.manifest.id,
				specId: null,
				proposalId: "proposal-unspecified",
				diagnosisId: null,
				origin: { kind: "manual", reason: "sealed exposure fixture" },
				mode: "candidate",
				baseline,
				eventId: `${candidateId}:proposed`,
				at: NOW,
				actor,
			});
			record = transitionCandidate(record, { type: "built", eventId: `${candidateId}:built`, at: NOW, actor, candidate: built });
			record = transitionCandidate(record, {
				type: "validated",
				eventId: `${candidateId}:validated`,
				at: NOW,
				actor: system,
				lineage: { baseline, candidate: built, relation: "descendant" },
				scope: {
					policyId: CANDIDATE_SCOPE_POLICY.id,
					baselineSha: baseline.sha,
					candidateSha: built.sha,
					passed: true,
					changedFiles: ["AGENTS.md"],
					violations: [],
				},
			});
			record = transitionCandidate(record, {
				type: "evaluated",
				eventId: `${candidateId}:evaluated`,
				at: NOW,
				actor: system,
				evaluation: {
					experimentId: candidateId,
					designHash: hash,
					mode: "candidate",
					development: {
						baseline: { evalRunId: `${candidateId}-dev-a`, harness: baseline },
						candidate: { evalRunId: `${candidateId}-dev-b`, harness: built },
						comparison: gateEvidence("development"),
					},
					sealedHoldout: {
						corpus: { id: sealed.id, hash: sealed.hash },
						baseline: { evalRunId: `${candidateId}-sealed-a`, harness: baseline },
						candidate: { evalRunId: `${candidateId}-sealed-b`, harness: built },
						comparison: gateEvidence("sealed"),
					},
					infrastructureErrors: 0,
				} as never,
			});
			const dir = join(paths.runsRoot, "candidates", candidateId);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "candidate.json"), `${JSON.stringify(record)}\n`, "utf8");
		}

		const view = await createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } }).view();

		expect(view.warnings).toEqual(expect.arrayContaining([
			"A sealed holdout has been used in 6 candidate verifications; consider refreshing it",
		]));
		const serialized = JSON.stringify(view);
		expect(serialized).not.toContain(sealed.id);
		expect(serialized).not.toContain("overused holdout name");
		expect(serialized).not.toContain("sealed prompt");
	});

	it("keeps calibration records out of stage derivation, selections, counts, and the interrupted check", async () => {
		const paths = target();
		const setup = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		await setup.submit({ kind: "spec-draft", spec: spec() });
		await setup.decide({ kind: "approve-spec", reason: "Approve the calibration fixture Spec" }, gate());
		await setup.submit({
			kind: "corpus-draft",
			name: "Calibration fixture",
			tasks: [task()],
			coverageNotes: [],
			revisionSummary: "Calibration fixture",
		});
		await setup.decide({ kind: "publish-corpus", reason: "Publish the calibration fixture basket" }, gate());
		expect((await setup.view()).stage).toBe("ready-to-evaluate");

		// One finished A/A run plus one stopped at `validated`: a candidate in
		// either state would take the stage over.
		writeCalibration(paths, "calibration-older", { at: "2026-08-26T17:00:00.000Z", baselinePassRate: 0.5 });
		writeCalibration(paths, "calibration-newest", { at: "2026-08-26T18:00:00.000Z" });
		writeCalibration(paths, "calibration-interrupted", { evaluated: false, at: "2026-08-26T17:30:00.000Z" });

		const view = await createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } }).view();

		expect(view.stage).toBe("ready-to-evaluate");
		expect(view.blockers).toEqual([]);
		expect(view.selections.some((item) => item.kind === "candidate")).toBe(false);
		expect(view.counts.candidates).toBe(0);
		expect(view.counts.calibrations).toBe(3);
		expect(view.calibration).toMatchObject({
			candidateId: "calibration-newest",
			targetSha: loadTarget(paths.projectDir).gitSha,
			taskCount: 30,
			repetitions: 3,
			aaPassRate: 0.9,
			flipRate: 0.1,
			recommendedRepetitions: 3,
			verdict: "inconclusive",
		});

		// A calibration of another revision describes another harness.
		const stale = target();
		writeCalibration(stale, "calibration-stale", { sha: "d".repeat(40) });
		expect((await createAhdeWorkbench({ ...stale, projectId: "test-target" }).view()).calibration).toBeNull();
	});

	it("runs calibration as A/A on the exact current revision through the human gate", async () => {
		const paths = target();
		const setup = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		await setup.submit({ kind: "spec-draft", spec: spec() });
		await setup.decide({ kind: "approve-spec", reason: "Approve the calibration Spec" }, gate());
		await setup.submit({
			kind: "corpus-draft",
			name: "Calibration basket",
			tasks: [task(), task("How long is the trial?", "14 days")],
			coverageNotes: [],
			revisionSummary: "Calibration basket",
		});
		const published = await setup.decide({ kind: "publish-corpus", reason: "Publish the calibration basket" }, gate());
		const corpusId = String(published.result.corpusId);
		const exactTarget = loadTarget(paths.projectDir);

		const onRunEvent = vi.fn();
		const runCalibration = vi.fn(async (options: { candidateId?: string }) => ({
			record: writeCalibration(paths, options.candidateId ?? "calibration-run", { taskCount: 2 }),
		}));
		const calibrationGate = gate();
		const workbench = createAhdeWorkbench({
			...paths,
			projectId: "test-target",
			dependencies: { now: () => NOW, runCalibration: runCalibration as never },
		});

		const decided = await workbench.decide(
			{ kind: "calibrate", repetitions: 3, reason: "Measure noise before believing a delta" },
			calibrationGate,
			{ onRunEvent },
		);

		expect(calibrationGate.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "calibrate",
				subject: {
					operation: "calibrate-noise",
					target: { id: exactTarget.manifest.id, gitSha: exactTarget.gitSha },
					developmentCorpus: { id: corpusId, hash: expect.any(String), taskCount: 2 },
					repetitions: 3,
					executions: 12,
				},
			}),
			undefined,
		);
		expect(runCalibration).toHaveBeenCalledWith(expect.objectContaining({
			repositoryDir: paths.projectDir,
			runsRoot: paths.runsRoot,
			baselineRef: exactTarget.gitSha,
			candidateRef: exactTarget.gitSha,
			mode: "aa-calibration",
			repetitions: 3,
			projectId: "test-target",
			origin: { kind: "manual", reason: "A/A calibration" },
			developmentCorpus: { stateRoot: paths.stateRoot, projectId: "test-target", corpusId },
			actorId: "local:test-human",
			onRunEvent,
		}));
		expect(decided.result).toMatchObject({
			candidateId: "calibration-run",
			calibration: { verdict: "inconclusive", taskCount: 2, recommendedRepetitions: 5 },
		});
		expect(decided.message).toContain("A/A inconclusive");
		// The A/A record is the receipt: it shows up as calibration, never as a candidate.
		expect(decided.view.stage).toBe("ready-to-evaluate");
		expect(decided.view.counts.candidates).toBe(0);
		expect(decided.view.counts.calibrations).toBe(1);
		expect(decided.view.calibration).toMatchObject({ candidateId: "calibration-run" });

		const declined = createAhdeWorkbench({
			...paths,
			projectId: "test-target",
			dependencies: { now: () => NOW, runCalibration: runCalibration as never },
		});
		await expect(declined.decide({ kind: "calibrate", repetitions: 3, reason: "Not now" }, gate(false)))
			.rejects.toBeInstanceOf(WorkbenchDecisionDeclinedError);
		expect(runCalibration).toHaveBeenCalledTimes(1);

		// Legal only where the operator could act on the answer.
		const early = createAhdeWorkbench({ ...target(), projectId: "test-target", dependencies: { now: () => NOW } });
		await expect(early.decide({ kind: "calibrate", repetitions: 3, reason: "Too early" }, gate()))
			.rejects.toThrow(/calibrate is not legal during spec-design/);
	});

	it("detects a tampered mutable focus checkpoint and refuses to treat it as authority", async () => {
		const paths = target();
		const workbench = createAhdeWorkbench({ ...paths, projectId: "test-target", dependencies: { now: () => NOW } });
		const drafted = await workbench.submit({ kind: "spec-draft", spec: spec() });
		const focusPath = join(paths.stateRoot, "projects", "test-target", "workbench", "focus.json");
		const focus = JSON.parse(readFileSync(focusPath, "utf8")) as { selections: { "spec-draft": { hash: string } } };
		focus.selections["spec-draft"].hash = `sha256:${"0".repeat(64)}`;
		writeFileSync(focusPath, `${JSON.stringify(focus)}\n`, "utf8");
		const view = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
		expect(view.focus["spec-draft"]).toBeUndefined();
		expect(view.warnings).toEqual(expect.arrayContaining([expect.stringContaining("changed; reselect")]))
		expect(drafted.artifact?.id).toBeDefined();
	});
});
