import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { recordBuilderAuthoredProposal } from "../src/application/builder-authoring.js";
import { applyBuilderProposal } from "../src/application/builder-proposal.js";
import { CANDIDATE_SCOPE_POLICY } from "../src/application/candidate-experiment.js";
import { targetWithDevelopmentCorpus } from "../src/application/corpus-target.js";
import { createCandidate } from "../src/domain/candidate.js";
import { diagnoseEvalRun } from "../src/diagnosis.js";
import { writeEvalRun, type EvalRunRecord } from "../src/eval.js";
import { loadTarget } from "../src/manifest.js";
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
	WorkbenchDecisionDeclinedError,
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
	const evaluation = {
		suiteId: resolved.manifest.evalSuite.id,
		suiteHash: resolved.suiteHash,
		dataset: resolved.manifest.evalSuite.dataset.replace(/\.jsonl$/, "").split("/").pop() ?? "dataset",
		datasetHash: resolved.datasetHash,
	};
	const runId = `run-${evalRunId}`;
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
		target: { id: resolved.manifest.id, gitSha: resolved.gitSha, toolsetHash: resolved.toolsetHash },
		runtime,
		model,
		execution,
		eval: evaluation,
		trace: { path: "session.jsonl", sessionId: null, sha256: hashFile("") },
		metrics: {
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			costUsd: 0,
			latencyMs: 0,
			toolCalls: 0,
			toolErrors: 0,
			recoveryAttempts: 0,
		},
		evalResults: {
			outcome: "fail",
			graders: [{ name: "fixture", type: "output_contains", passed: false, score: 0, reason: "fixture failure" }],
		},
		parent: { evalRunId, candidateOf: null },
	};
	mkdirSync(join(paths.runsRoot, runId), { recursive: true });
	writeFileSync(join(paths.runsRoot, runId, "session.jsonl"), "", "utf8");
	writeJsonArtifact(join(paths.runsRoot, runId, "run.json"), RunRecordSchema, run);
	const evidence = { runtime, model, judge: null, execution, eval: evaluation };
	const record: EvalRunRecord = {
		schemaVersion: 1,
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
		summary: { total: 1, pass: 0, fail: 1, error: 0, allPassRate: 0 },
	};
	writeEvalRun(paths.runsRoot, record);
	return record;
}

describe("AHDE Workbench", () => {
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
		await workbench.submit({ kind: "select", entity: "eval-run", id: evalA.evalRunId });
		expect((await workbench.view()).stage).toBe("improvement-authoring");

		const recordProposal = vi.fn(async () => ({
			record: { runId: "builder-no-change", result: { proposal: { decision: "no-change" } } },
		}));
		const authoritative = createAhdeWorkbench({
			...paths,
			projectId: "test-target",
			dependencies: { now: () => NOW, recordProposal: recordProposal as never },
		});
		const proposal = {
			kind: "structured-proposal" as const,
			summary: "Use exact lineage evidence",
			diagnoses: [],
			intents: [{ type: "instructions.replace" as const, content: "# Exact evidence\n" }],
			risks: [],
			validationPlan: ["Re-run the reviewed corpus"],
		};
		await expect(authoritative.submit(proposal)).rejects.toThrow(/development EvalRun/);
		await expect(authoritative.submit({ ...proposal, sourceEvalRunId: evalA.evalRunId })).rejects.toThrow(/development EvalRun/);
		expect(recordProposal).not.toHaveBeenCalled();

		await expect(authoritative.submit({ ...proposal, sourceEvalRunId: evalB.evalRunId })).resolves.toMatchObject({
			artifact: { decision: "no-change", approvedSpecId: approved.result.approvedSpecId },
		});
		expect(recordProposal).toHaveBeenCalledWith(expect.objectContaining({
			sourceEvalRunId: evalB.evalRunId,
			approvedSpec: expect.objectContaining({ specId: approved.result.approvedSpecId }),
		}));
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
		diagnoseEvalRun(paths.runsRoot, evaluation.evalRunId);
		const authored = await workbench.submit({
			kind: "structured-proposal",
			sourceEvalRunId: evaluation.evalRunId,
			summary: "Keep historical evidence historical",
			diagnoses: [],
			intents: [{ type: "instructions.replace", content: "# Proposed historical change\n" }],
			risks: [],
			validationPlan: ["Re-run exact development evidence"],
		});
		const proposalId = String(authored.artifact?.runId);

		writeFileSync(join(paths.projectDir, "AGENTS.md"), "# A later live Target change\n", "utf8");
		const view = await createAhdeWorkbench({ ...paths, projectId: "test-target" }).view();
		expect(view.stage).toBe("proposal-review");
		expect(view.blockers).toEqual([]);
		expect(view.selections).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "proposal", id: proposalId, status: "open" }),
		]));
	});

	it("will not let /run skip an outstanding Spec review gate", async () => {
		const paths = target();
		const runSuite = vi.fn();
		const workbench = createAhdeWorkbench({
			...paths,
			projectId: "test-target",
			dependencies: { now: () => NOW, runSuite: runSuite as never },
		});
		await workbench.submit({ kind: "spec-draft", spec: spec() });
		const human = gate();
		await expect(workbench.decide({ kind: "run-current", repetitions: 1, reason: "Try to skip" }, human))
			.rejects.toThrow(/not legal during spec-review/);
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
