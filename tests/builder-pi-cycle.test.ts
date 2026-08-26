import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAhdeBuilderTools } from "../src/builder/extension.js";

const roots: string[] = [];

function root(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	roots.push(path);
	return path;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function context(confirm = vi.fn(async () => true), hasUI = true): ExtensionContext {
	return {
		hasUI,
		mode: hasUI ? "tui" : "print",
		ui: {
			confirm,
			select: vi.fn(async () => undefined),
			notify: vi.fn(),
		},
	} as unknown as ExtensionContext;
}

function tool(tools: readonly ToolDefinition[], name: string): ToolDefinition {
	const found = tools.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`missing tool ${name}`);
	return found;
}

function details(result: Awaited<ReturnType<ToolDefinition["execute"]>>): unknown {
	const first = result.content[0];
	if (!first || first.type !== "text") throw new Error("expected text result");
	return JSON.parse(first.text) as unknown;
}

describe("Builder Pi canonical cycle", () => {
	it("initializes the exact current directory, then commits one exact non-secret model bootstrap", async () => {
		const projectDir = root("ahde-scaffold-");
		const confirm = vi.fn(async () => true);
		const tools = createAhdeBuilderTools({
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			templateDir: join(process.cwd(), "templates", "basic-agent"),
		});
		const scaffold = tool(tools, "ahde_target_scaffold");
		const result = details(await scaffold.execute(
			"scaffold",
			{ reason: "Start the Target" },
			undefined,
			undefined,
			context(confirm),
		)) as { initialized: boolean; targetId: string; targetPath: string };
		expect(result).toMatchObject({ initialized: true, targetId: "my-agent", targetPath: projectDir });
		expect(readFileSync(join(projectDir, "manifest.yaml"), "utf8")).toContain("id: my-agent");
		expect(existsSync(join(projectDir, ".git"))).toBe(true);
		expect(confirm).toHaveBeenCalledWith(
			"Initialize exact Target scaffold",
			expect.stringContaining(`Exact path: ${projectDir}`),
		);

		const configure = tool(tools, "ahde_target_configure_model");
		const configured = details(await configure.execute("configure", {
			targetId: "demo-agent",
			model: {
				provider: "openai-compatible",
				id: "qwen3.5-27b",
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:9901/v1",
				apiKeyEnv: "TARGET_MODEL_API_KEY",
				thinkingLevel: "off",
				timeoutMs: 120_000,
				params: {},
				spec: {
					reasoning: false,
					contextWindow: 131_072,
					maxTokens: 8_192,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					compat: {},
				},
			},
			reason: "Use this exact local model",
		}, undefined, undefined, context())) as {
			target: { id: string; gitSha: string; model: { apiKeyEnv: string } };
			receipt: { subject: { subjectHash: string } };
		};
		expect(configured.target).toMatchObject({
			id: "demo-agent",
			model: { apiKeyEnv: "TARGET_MODEL_API_KEY" },
		});
		expect(configured.target.gitSha).toMatch(/^[0-9a-f]{40}$/);
		expect(configured.receipt.subject.subjectHash).toMatch(/^sha256:/);
		expect(readFileSync(join(projectDir, "manifest.yaml"), "utf8")).toContain("id: demo-agent");

		const occupied = root("ahde-scaffold-occupied-");
		writeFileSync(join(occupied, "notes.txt"), "keep me\n");
		const occupiedTool = tool(createAhdeBuilderTools({
			projectDir: occupied,
			stateRoot: join(occupied, ".ahde"),
			runsRoot: join(occupied, "runs"),
			templateDir: join(process.cwd(), "templates", "basic-agent"),
		}), "ahde_target_scaffold");
		await expect(occupiedTool.execute(
			"occupied",
			{ reason: "Do not overwrite" },
			undefined,
			undefined,
			context(),
		)).rejects.toThrow(/otherwise empty/);
		expect(readFileSync(join(occupied, "notes.txt"), "utf8")).toBe("keep me\n");
	});

	it("publishes only exact TUI-confirmed development corpora", async () => {
		const projectDir = root("ahde-corpus-publish-");
		const tools = createAhdeBuilderTools({
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			projectId: "demo",
		});
		const publish = tool(tools, "ahde_corpus_publish_development");
		const input = {
			name: "routing development",
			tasks: [{ id: "route-1", input: "Route this request", graders: [{ type: "output_contains", text: "billing" }] }],
			reason: "Use this exact maintainable task",
		};
		await expect(publish.execute("closed", input, undefined, undefined, context(undefined, false)))
			.rejects.toThrow(/local TUI host confirmation/);
		const result = details(await publish.execute("publish", input, undefined, undefined, context())) as {
			corpus: { id: string; visibility: string };
			receipt: { actor: { id: string }; subject: { subjectHash: string } };
		};
		expect(result.corpus.visibility).toBe("development");
		expect(result.corpus.id).toMatch(/^corpus-/);
		expect(result.receipt.actor.id).toMatch(/^local:/);
		expect(result.receipt.subject.subjectHash).toMatch(/^sha256:/);
	});

	it("runs a confirmed development evaluation and returns its bounded diagnosis", async () => {
		const projectDir = root("ahde-eval-run-");
		const sha = "a".repeat(40);
		const target = {
			dir: projectDir,
			manifest: { id: "demo", evalSuite: { dataset: "evals/development.jsonl" } },
			gitSha: sha,
			toolsetHash: `sha256:${"b".repeat(64)}`,
			tasks: [{ id: "task-1" }],
			datasetHash: `sha256:${"c".repeat(64)}`,
			suiteHash: `sha256:${"d".repeat(64)}`,
		};
		const evalRun = {
			evalRunId: "erun_development",
			target: { id: "demo", gitSha: sha, toolsetHash: target.toolsetHash },
			label: "solo",
			suiteId: "demo-development",
			suiteHash: target.suiteHash,
			dataset: "development",
			datasetHash: target.datasetHash,
			repetitions: 2,
			startedAt: "2026-08-26T10:00:00.000Z",
			finishedAt: "2026-08-26T10:01:00.000Z",
			summary: { total: 2, pass: 1, fail: 1, error: 0, allPassRate: 0.5 },
			provenance: {},
			provenanceKey: `sha256:${"e".repeat(64)}`,
			baselineEvalRunId: null,
			runIds: ["run-1", "run-2"],
		};
		const diagnosis = {
			diagnosisId: "diagnosis-1",
			evalRunId: evalRun.evalRunId,
			targetId: "demo",
			targetRevision: sha,
			status: "actionable",
			inputHash: `sha256:${"f".repeat(64)}`,
			summary: { issueCount: 1 },
			issues: [],
		};
		const runSuite = vi.fn(async () => evalRun);
		const tools = createAhdeBuilderTools({
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			projectId: "demo",
			dependencies: {
				loadTarget: (() => target) as never,
				listCorpora: (() => []) as never,
				runSuite: runSuite as never,
				diagnoseEval: (() => diagnosis) as never,
			},
		});
		const run = tool(tools, "ahde_eval_run_development");
		const result = details(await run.execute(
			"run",
			{ repetitions: 2, reason: "Measure current behavior" },
			undefined,
			undefined,
			context(),
		)) as { evaluation: { evalRunId: string }; diagnosis: { diagnosisId: string } };
		expect(result).toMatchObject({
			evaluation: { evalRunId: "erun_development" },
			diagnosis: { diagnosisId: "diagnosis-1" },
		});
		expect(runSuite).toHaveBeenCalledWith(target, expect.objectContaining({ label: "solo", repetitions: 2 }));
	});

	it("derives proposal authority and base revision from durable host evidence", async () => {
		const projectDir = root("ahde-proposal-create-");
		const sha = "a".repeat(40);
		const approvedSpecId = `spec-${"b".repeat(64)}`;
		const recordProposal = vi.fn(async (input) => ({
			record: {
				runId: "builder-1",
				result: { status: "completed", proposal: input.proposal },
				artifacts: { proposal: { sha256: `sha256:${"c".repeat(64)}` } },
				request: { baseTargetSha: sha, source: null, approvedSpec: { specId: approvedSpecId } },
			},
		}));
		const tools = createAhdeBuilderTools({
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			projectId: "demo",
			dependencies: {
				loadTarget: (() => ({ gitSha: sha })) as never,
				loadSpecApprovalReceipt: (() => ({ approvedSpec: { specId: approvedSpecId } })) as never,
				recordProposal: recordProposal as never,
			},
		});
		const create = tool(tools, "ahde_proposal_create");
		const result = details(await create.execute("create", {
			specDraftId: `spec-${"d".repeat(64)}`,
			decision: "propose",
			summary: "Clarify routing policy",
			diagnoses: [{ failureIds: ["failure-1"], evidence: ["erun-1"], rootCause: "Routing ambiguity" }],
			changes: [{
				path: "AGENTS.md",
				baseSha256: `sha256:${"e".repeat(64)}`,
				unifiedDiff: "--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n-old\n+new\n",
				rationale: "Resolve observed ambiguity",
				evidenceRefs: ["erun-1"],
			}],
			risks: ["Could over-route billing"],
			validationPlan: ["Repeat the development corpus"],
		}, undefined, undefined, context())) as { runId: string; approvedSpecId: string; baseTargetSha: string };
		expect(result).toMatchObject({ runId: "builder-1", approvedSpecId, baseTargetSha: sha });
		expect(recordProposal).toHaveBeenCalledWith(expect.objectContaining({
			approvedSpec: { stateRoot: join(projectDir, ".ahde"), projectId: "demo", specId: approvedSpecId },
			proposal: expect.objectContaining({ baseTargetSha: sha }),
		}));
	});

	it("durably discards only the exact proposal confirmed by the TUI host", async () => {
		const projectDir = root("ahde-proposal-discard-");
		const described = {
			subject: {
				schemaVersion: 1,
				runId: "builder-1",
				proposalSha256: `sha256:${"a".repeat(64)}`,
				baseTargetSha: "b".repeat(40),
				summary: "Clarify routing",
				paths: ["AGENTS.md"],
			},
			subjectHash: `sha256:${"c".repeat(64)}`,
		};
		const describeProposalDiscard = vi.fn(() => described);
		const discardProposal = vi.fn(() => ({
			receipt: { runId: "builder-1", subjectHash: described.subjectHash },
			receiptPath: "/private/discard_receipt.json",
		}));
		const tools = createAhdeBuilderTools({
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			projectId: "demo",
			dependencies: {
				describeProposalDiscard: describeProposalDiscard as never,
				discardProposal: discardProposal as never,
				actorId: () => "local:operator",
			},
		});
		const discard = tool(tools, "ahde_proposal_discard");
		await expect(discard.execute(
			"closed",
			{ runId: "builder-1", reason: "Wrong direction" },
			undefined,
			undefined,
			context(undefined, false),
		)).rejects.toThrow(/local TUI host confirmation/);
		expect(describeProposalDiscard).not.toHaveBeenCalled();
		const output = JSON.stringify(details(await discard.execute(
			"discard",
			{ runId: "builder-1", reason: "Wrong direction" },
			undefined,
			undefined,
			context(),
		)));
		expect(output).toContain("builder-1");
		expect(output).not.toContain("discard_receipt.json");
		expect(describeProposalDiscard).toHaveBeenCalledTimes(2);
		expect(discardProposal).toHaveBeenCalledWith(expect.objectContaining({
			runId: "builder-1",
			expectedSubjectHash: described.subjectHash,
			actor: { kind: "human", id: "local:operator" },
		}));
	});

	it("keeps sealed identity model-invisible during canonical candidate verification", async () => {
		const projectDir = root("ahde-candidate-verify-");
		const sealedId = `corpus-${"1".repeat(64)}`;
		const sealedHash = `sha256:${"2".repeat(64)}`;
		const candidateRecord = {
			candidateId: "candidate-1",
			projectId: "demo",
			targetId: "demo",
			specId: `spec-${"3".repeat(64)}`,
			proposalId: "builder-1",
			diagnosisId: null,
			baseline: { ref: "main", sha: "a".repeat(40) },
			events: [
				{ type: "built", candidate: { ref: "candidate/demo", sha: "b".repeat(40) } },
				{ type: "validated", scope: { changedFiles: ["AGENTS.md"] } },
				{
					type: "evaluated",
					evaluation: {
						development: {
							baseline: { evalRunId: "erun_dev_base" },
							candidate: { evalRunId: "erun_dev_candidate" },
							comparison: { summary: { delta: 0.1 } },
						},
						sealedHoldout: {
							corpus: { id: sealedId, hash: sealedHash },
							baseline: { evalRunId: "erun_secret_base" },
							candidate: { evalRunId: "erun_secret_candidate" },
						},
					},
				},
			],
		};
		const builderRun = {
			runId: "builder-1",
			request: {
				approvedSpec: { projectId: "demo", specId: candidateRecord.specId },
				sourceAttestation: null,
			},
			artifacts: { proposal: { sha256: `sha256:${"4".repeat(64)}` } },
		};
		const applyReceipt = {
			runId: "builder-1",
			baseTargetSha: "a".repeat(40),
			candidateSha: "b".repeat(40),
		};
		const corpora = [{
			schemaVersion: 1,
			id: sealedId,
			projectId: "demo",
			name: "secret holdout",
			visibility: "sealed",
			taskCount: 7,
			hash: sealedHash,
			createdAt: "2026-08-26T10:00:00.000Z",
			contentPath: "corpus.jsonl",
		}];
		const runAppliedCandidate = vi.fn(async () => ({
			record: candidateRecord,
			sealedHoldout: { corpusId: sealedId, corpusHash: sealedHash },
		}));
		const tools = createAhdeBuilderTools({
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			projectId: "demo",
			dependencies: {
				listCorpora: (() => corpora) as never,
				loadCorpus: (() => ({ metadata: corpora[0], tasks: [{ id: "secret-task" }] })) as never,
				loadProposal: (() => builderRun) as never,
				loadApplyReceipt: (() => applyReceipt) as never,
				runAppliedCandidate: runAppliedCandidate as never,
				actorId: () => "local:test",
			},
		});
		const result = JSON.stringify(details(await tool(tools, "ahde_candidate_verify").execute(
			"verify",
			{ builderRunId: "builder-1", repetitions: 2, reason: "Promotion gate" },
			undefined,
			undefined,
			context(),
		)));
		expect(result).toContain("candidate-1");
		expect(result).toContain('"gatePassed":true');
		expect(result).not.toContain(sealedId);
		expect(result).not.toContain(sealedHash);
		expect(result).not.toContain("erun_secret");
		expect(runAppliedCandidate).toHaveBeenCalledWith(expect.objectContaining({
			sealedCorpus: { stateRoot: join(projectDir, ".ahde"), projectId: "demo", corpusId: sealedId },
			actorId: "local:test",
		}));
	});

	it("derives candidate review, promotion, and rejection authority only from the TUI host", async () => {
		const projectDir = root("ahde-candidate-decisions-");
		const record = {
			candidateId: "candidate-1",
			projectId: "demo",
			targetId: "demo",
			specId: "spec-1",
			proposalId: "builder-1",
			diagnosisId: null,
			baseline: { ref: "main", sha: "a".repeat(40) },
			events: [{
				type: "evaluated",
				evaluation: {
					development: {
						baseline: { evalRunId: "erun-a" },
						candidate: { evalRunId: "erun-b" },
						comparison: { summary: { delta: 0 } },
					},
					sealedHoldout: {},
				},
			}],
		};
		const reviewCandidate = vi.fn(() => record);
		const promoteCandidate = vi.fn(() => ({ record, tag: "v1.2.3", candidateSha: "b".repeat(40) }));
		const rejectCandidate = vi.fn(() => record);
		const tools = createAhdeBuilderTools({
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			projectId: "demo",
			dependencies: {
				loadCandidate: (() => record) as never,
				reviewCandidate: reviewCandidate as never,
				promoteCandidate: promoteCandidate as never,
				rejectCandidate: rejectCandidate as never,
				actorId: () => "local:reviewer",
			},
		});
		await tool(tools, "ahde_candidate_review").execute(
			"review",
			{ candidateId: "candidate-1", recommendation: "promote", reason: "Evidence is sufficient" },
			undefined,
			undefined,
			context(),
		);
		await tool(tools, "ahde_candidate_promote").execute(
			"promote",
			{ candidateId: "candidate-1", version: "1.2.3", reason: "Ship exact candidate" },
			undefined,
			undefined,
			context(),
		);
		await tool(tools, "ahde_candidate_reject").execute(
			"reject",
			{ candidateId: "candidate-1", reason: "Reject exact candidate" },
			undefined,
			undefined,
			context(),
		);
		expect(reviewCandidate).toHaveBeenCalledWith(expect.objectContaining({ actorId: "local:reviewer" }));
		expect(promoteCandidate).toHaveBeenCalledWith(expect.objectContaining({ actorId: "local:reviewer", version: "1.2.3" }));
		expect(rejectCandidate).toHaveBeenCalledWith(expect.objectContaining({ actorId: "local:reviewer" }));
	});
});
