import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AHDE_BUILDER_TOOL_NAMES,
	CONSEQUENTIAL_BUILDER_TOOL_NAMES,
	createAhdeBuilderCompatibilityTools,
	createAhdeBuilderExtension,
	createAhdeBuilderTools,
} from "../src/builder/extension.js";
import { AHDE_BUILDER_COMMAND_NAMES } from "../src/builder/commands.js";
import {
	WorkbenchDecisionParameters,
	WorkbenchSubmitParameters,
} from "../src/builder/workbench-transport.js";
import {
	WorkbenchDecisionInputSchema,
	WorkbenchSubmitInputSchema,
} from "../src/workbench/types.js";
import { buildProjectStatus } from "../src/builder/project-context.js";
import { createCorpus } from "../src/corpus.js";
import { saveSpecSnapshot, type AgentSpec } from "../src/spec.js";
import type { PersistedBuilderRun } from "../src/application/builder-proposal.js";
import { hashValue } from "../src/provenance.js";

const roots: string[] = [];
const spec: AgentSpec = {
	schemaVersion: 1,
	title: "Support triage",
	purpose: "Classify support requests and prepare a bounded response.",
	users: ["support operator"],
	jobs: ["classify one request"],
	inputs: ["request text"],
	allowedActions: ["read the public policy"],
	successCriteria: ["classification matches the explicit rubric"],
	constraints: ["no network"],
	openQuestions: [],
};

function root(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	roots.push(path);
	return path;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fakeContext(
	hasUI: boolean,
	confirm = vi.fn(async () => false),
	mode: ExtensionContext["mode"] = hasUI ? "tui" : "print",
	select = vi.fn(async () => undefined),
): ExtensionContext {
	return {
		hasUI,
		mode,
		ui: { confirm, select, notify: vi.fn() },
	} as unknown as ExtensionContext;
}

function textDetails(result: Awaited<ReturnType<ToolDefinition["execute"]>>): unknown {
	const first = result.content[0];
	if (!first || first.type !== "text") throw new Error("expected text tool result");
	return JSON.parse(first.text) as unknown;
}

describe("Builder Pi extension registry", () => {
	it("keeps Workbench transport bounds aligned with canonical application schemas", () => {
		const corpusDraft = {
			kind: "corpus-draft",
			name: "routing cases",
			tasks: [{
				input: "Route this support request",
				graders: [{ type: "output_contains", text: "billing" }],
			}],
			coverageNotes: ["Covers the billing route"],
			revisionSummary: "Initial bounded corpus",
		};
		const corpusRevision = {
			kind: "corpus-revision",
			operations: Array.from({ length: 200 }, () => ({ type: "rename", name: "bounded" })),
			revisionSummary: "Maximum bounded operation count",
		};
		const corpusImport = {
			kind: "corpus-import",
			sourcePath: "imports/reviewed-examples.jsonl",
			name: "Imported examples",
			coverageNotes: ["Operator-provided cases"],
			revisionSummary: "Import exact project-local JSONL",
		};
		const corpusEvidenceRevision = {
			kind: "corpus-revision",
			operations: [
				{
					type: "set-graders",
					taskId: `task-${"a".repeat(64)}`,
					graders: [{ type: "output_matches", pattern: "billing" }],
				},
				{
					type: "grader.add",
					taskId: `task-${"b".repeat(64)}`,
					grader: { type: "output_contains", text: "account" },
				},
				{
					type: "grader.update",
					taskId: `task-${"c".repeat(64)}`,
					graderIndex: 0,
					grader: { type: "output_contains", text: "verified account" },
				},
				{
					type: "grader.remove",
					taskId: `task-${"d".repeat(64)}`,
					graderIndex: 0,
				},
				{
					type: "add-case-from-run",
					evalRunId: "erun_verified",
					runId: "run_verified",
					task: { input: "Neighboring failure", graders: [{ type: "output_contains", text: "billing" }] },
				},
			],
			revisionSummary: "Bind a regression and tighten grading",
		};
		const structuredProposal = {
			kind: "structured-proposal",
			summary: "Maximum bounded intent count",
			intents: Array.from({ length: 32 }, () => ({
				type: "instructions.replace",
				content: "Bounded instructions",
			})),
			validationPlan: ["Run the development eval"],
		};
		for (const accepted of [
			corpusDraft,
			{ ...corpusDraft, coverageNotes: ["x".repeat(1_000)] },
			corpusImport,
			corpusRevision,
			corpusEvidenceRevision,
			structuredProposal,
		]) {
			expect(Check(WorkbenchSubmitParameters, accepted)).toBe(true);
			expect(WorkbenchSubmitInputSchema.safeParse(accepted).success).toBe(true);
		}

		for (const invalid of [
			{
				...corpusDraft,
				coverageNotes: ["x".repeat(1_001)],
			},
			{
				...corpusDraft,
				tasks: [{ input: "Route this", graders: [{ type: "opaque_grader" }] }],
			},
			{ ...corpusImport, sourcePath: "../private.jsonl" },
			{ ...corpusImport, sourcePath: "evals/sealed.jsonl" },
			{ ...corpusImport, sourcePath: "imports/.hidden.jsonl" },
			{ ...corpusRevision, operations: [...corpusRevision.operations, { type: "rename", name: "one-too-many" }] },
			{ ...structuredProposal, intents: [...structuredProposal.intents, { type: "instructions.replace", content: "One too many" }] },
		]) {
			expect(Check(WorkbenchSubmitParameters, invalid)).toBe(false);
			expect(WorkbenchSubmitInputSchema.safeParse(invalid).success).toBe(false);
		}

		const blankDecision = { kind: "run-current", repetitions: 1, reason: "   " };
		expect(Check(WorkbenchDecisionParameters, blankDecision)).toBe(false);
		expect(WorkbenchDecisionInputSchema.safeParse(blankDecision).success).toBe(false);
	});

	it("registers only narrow AHDE tools and keeps authority out of dangerous schemas", () => {
		const projectDir = root("ahde-builder-project-");
		const tools = createAhdeBuilderTools({
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			projectId: "demo",
		});
		expect(tools.map((tool) => tool.name)).toEqual(AHDE_BUILDER_TOOL_NAMES);
		expect(tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(["bash", "edit", "write", "read"]));

		for (const name of CONSEQUENTIAL_BUILDER_TOOL_NAMES) {
			const tool = tools.find((candidate) => candidate.name === name);
			expect(tool).toBeDefined();
			const parameterSchema = tool!.parameters as {
				properties?: Record<string, unknown>;
				additionalProperties?: boolean;
				anyOf?: { properties?: Record<string, unknown>; additionalProperties?: boolean }[];
			};
			const alternatives = parameterSchema.anyOf ?? [parameterSchema];
			for (const alternative of alternatives) {
				const properties = alternative.properties ?? {};
				expect(Object.keys(properties)).not.toEqual(expect.arrayContaining([
					"actor",
					"actorId",
					"approved",
					"confirmed",
					"approvalToken",
				]));
				expect(alternative.additionalProperties).toBe(false);
			}
		}
	});

	it("registers the same bounded registry through the real Pi extension factory", async () => {
		const projectDir = root("ahde-builder-project-");
		const registered: ToolDefinition[] = [];
		const commands: string[] = [];
		const handlers = new Map<string, (...args: never[]) => unknown>();
		const extension = createAhdeBuilderExtension({
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			projectId: "demo",
		});
		await extension({
			registerTool: (tool: ToolDefinition) => registered.push(tool),
			registerCommand: (name: string) => commands.push(name),
			on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
		} as never);
		expect(registered.map((tool) => tool.name)).toEqual(AHDE_BUILDER_TOOL_NAMES);
		expect(commands).toEqual(AHDE_BUILDER_COMMAND_NAMES);
		expect(handlers.get("user_bash")?.()).toMatchObject({
			result: { exitCode: 126, output: expect.stringContaining("disables interactive shell") },
		});
		expect(handlers.get("tool_call")?.({ toolName: "bash" } as never)).toMatchObject({ block: true, terminate: true });
		expect(handlers.get("tool_call")?.({ toolName: "ahde_workbench_view" } as never)).toBeUndefined();
		expect(handlers.get("tool_call")?.({ toolName: "ahde_project_status" } as never)).toMatchObject({
			block: true,
			terminate: true,
		});
	});

	it("reads only bounded public Target resources", async () => {
		const projectDir = root("ahde-builder-project-");
		mkdirSync(join(projectDir, "skills", "search"), { recursive: true });
		mkdirSync(join(projectDir, ".ahde"), { recursive: true });
		writeFileSync(join(projectDir, "AGENTS.md"), "public instructions\n");
		writeFileSync(join(projectDir, "skills", "search", "SKILL.md"), "public skill\n");
		writeFileSync(join(projectDir, ".ahde", "secret.txt"), "secret\n");
		symlinkSync(join(projectDir, ".ahde", "secret.txt"), join(projectDir, "skills", "search", "leak.txt"));
		const tools = createAhdeBuilderCompatibilityTools({
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			projectId: "demo",
		});
		const read = tools.find((tool) => tool.name === "ahde_target_read")!;
		const visible = textDetails(await read.execute("call-1", { path: "AGENTS.md" }, undefined, undefined, fakeContext(false)));
		expect(visible).toMatchObject({ path: "AGENTS.md", content: "public instructions\n", truncated: false });
		await expect(read.execute("call-2", { path: ".ahde/secret.txt" }, undefined, undefined, fakeContext(false)))
			.rejects.toThrow(/forbidden path segment|may read only/);
		await expect(read.execute("call-3", { path: "skills/search/leak.txt" }, undefined, undefined, fakeContext(false)))
			.rejects.toThrow(/regular file|symlink/);
	});

	it("saves immutable Spec drafts and fails closed when approval has no host UI", async () => {
		const projectDir = root("ahde-builder-project-");
		const stateRoot = join(projectDir, ".ahde");
		const tools = createAhdeBuilderCompatibilityTools({
			projectDir,
			stateRoot,
			runsRoot: join(projectDir, "runs"),
			projectId: "demo",
		});
		const save = tools.find((tool) => tool.name === "ahde_spec_save_draft")!;
		const saved = textDetails(await save.execute("call-save", {
			title: spec.title,
			purpose: spec.purpose,
			users: spec.users,
			jobs: spec.jobs,
			inputs: spec.inputs,
			allowedActions: spec.allowedActions,
			successCriteria: spec.successCriteria,
			constraints: spec.constraints,
			openQuestions: spec.openQuestions,
		}, undefined, undefined, fakeContext(false))) as { id: string; status: string };
		expect(saved.status).toBe("draft");

		const approve = tools.find((tool) => tool.name === "ahde_spec_approve")!;
		const confirm = vi.fn(async () => true);
		await expect(approve.execute("call-approve", { specId: saved.id, reason: "Spec is ready" }, undefined, undefined, fakeContext(false, confirm)))
			.rejects.toThrow(/local TUI host confirmation/);
		expect(confirm).not.toHaveBeenCalled();
		await expect(approve.execute("call-approve-rpc", { specId: saved.id, reason: "Spec is ready" }, undefined, undefined, fakeContext(true, confirm, "rpc")))
			.rejects.toThrow(/RPC, print, and JSON execution fail closed/);
		expect(confirm).not.toHaveBeenCalled();

		const approvedResult = textDetails(await approve.execute(
			"call-approve-2",
			{ specId: saved.id, reason: "Spec is ready" },
			undefined,
			undefined,
			fakeContext(true, confirm),
		)) as {
			approved: { status: string; id: string };
			receipt: { actor: { id: string }; draft: { draftSnapshotHash: string } };
		};
		expect(approvedResult.approved.status).toBe("approved");
		expect(approvedResult.approved.id).not.toBe(saved.id);
		expect(approvedResult.receipt.actor.id).toMatch(/^local:/);
		expect(approvedResult.receipt.draft.draftSnapshotHash).toMatch(/^sha256:/);
		expect(confirm).toHaveBeenCalledWith(
			"Approve immutable Spec",
			expect.stringContaining(`Spec id: ${saved.id}`),
		);
	});

	it("shows the exact proposal diff and derives the human actor only after confirmation", async () => {
		const projectDir = root("ahde-builder-project-");
		const proposal = {
			runId: "builder-demo",
			result: {
				status: "completed",
				proposal: {
					decision: "propose",
					baseTargetSha: "a".repeat(40),
					summary: "Clarify routing",
					diagnoses: [{ failureIds: ["failure-1"], evidence: ["erun-1"], rootCause: "Ambiguous route" }],
					changes: [{
						path: "AGENTS.md",
						baseSha256: `sha256:${"b".repeat(64)}`,
						unifiedDiff: "--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n-old\n+new\n",
						rationale: "Observed routing failure",
						evidenceRefs: ["erun-1"],
					}],
					risks: ["Could over-route"],
					validationPlan: ["Repeat development eval"],
				},
			},
			artifacts: { proposal: { sha256: `sha256:${"c".repeat(64)}` } },
		} as unknown as PersistedBuilderRun;
		const applyProposal = vi.fn(() => ({ receipt: { runId: "builder-demo" }, receiptPath: "/receipt" }) as never);
		const loadProposal = vi.fn(() => proposal);
		const tools = createAhdeBuilderCompatibilityTools({
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			projectId: "demo",
			dependencies: { loadProposal, applyProposal, actorId: () => "local:test-operator" },
		});
		const apply = tools.find((tool) => tool.name === "ahde_proposal_apply")!;
		await expect(apply.execute(
			"call-apply-closed",
			{ runId: "builder-demo", branch: "candidate/demo", reason: "Test candidate" },
			undefined,
			undefined,
			fakeContext(false),
		)).rejects.toThrow(/local TUI host confirmation/);
		expect(loadProposal).not.toHaveBeenCalled();

		const confirm = vi.fn(async () => true);
		await apply.execute(
			"call-apply",
			{ runId: "builder-demo", branch: "candidate/demo", reason: "Test candidate" },
			undefined,
			undefined,
			fakeContext(true, confirm),
		);
		expect(confirm).toHaveBeenCalledWith(
			"Apply exact Builder proposal",
			expect.stringContaining("Exact diff:\n--- a/AGENTS.md"),
		);
		expect(applyProposal).toHaveBeenCalledWith(expect.objectContaining({
			runId: "builder-demo",
			requestedBranch: "candidate/demo",
			actor: { kind: "human", id: "local:test-operator" },
		}));
	});

	it("hides sealed corpus identity and rejects every sealed eval read path", async () => {
		const projectDir = root("ahde-builder-project-");
		const development = {
			evalRunId: "erun_development",
			target: { id: "demo", gitSha: "a".repeat(40) },
			label: "baseline",
			dataset: "development-corpus-public",
			datasetHash: `sha256:${"d".repeat(64)}`,
			evidenceVisibility: "development",
			repetitions: 1,
			startedAt: "2026-08-26T10:00:00.000Z",
			finishedAt: "2026-08-26T10:01:00.000Z",
			summary: { total: 1, pass: 1, fail: 0, error: 0, allPassRate: 1 },
		};
		const sealed = {
			...development,
			evalRunId: "erun_sealed_secret",
			dataset: "ordinary-private-dataset",
			datasetHash: `sha256:${"e".repeat(64)}`,
			evidenceVisibility: "sealed",
		};
		const diagnoseEval = vi.fn();
		const evidenceLink = vi.fn();
		const loadEval = vi.fn((_runsRoot: string, evalRunId: string) => {
			if (evalRunId === development.evalRunId) return development;
			throw new Error("task-super-secret must remain unopened");
		});
		const tools = createAhdeBuilderCompatibilityTools({
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			projectId: "demo",
			dependencies: {
				listEvalIndexes: (() => [development, sealed]) as never,
				loadEval: loadEval as never,
				readEvalIndex: ((_runsRoot: string, evalRunId: string) =>
					evalRunId === sealed.evalRunId ? sealed : development) as never,
				diagnoseEval,
				evidenceLink,
				listCorpora: (() => [{
					id: "corpus-secret-id",
					name: "secret holdout",
					visibility: "sealed",
					taskCount: 99,
					hash: `sha256:${"f".repeat(64)}`,
					createdAt: "2026-08-26T09:00:00.000Z",
					contentPath: "corpus.jsonl",
					schemaVersion: 1,
				}]) as never,
			},
		});
		const list = tools.find((tool) => tool.name === "ahde_eval_list")!;
		const listed = JSON.stringify(textDetails(await list.execute("list", {}, undefined, undefined, fakeContext(false))));
		expect(listed).toContain("erun_development");
		expect(listed).not.toContain("erun_sealed_secret");
		expect(listed).not.toContain("secret-id");

		for (const name of ["ahde_eval_get", "ahde_eval_diagnose", "ahde_evidence_link"]) {
			const tool = tools.find((candidate) => candidate.name === name)!;
			await expect(tool.execute("sealed", { evalRunId: sealed.evalRunId }, undefined, undefined, fakeContext(false)))
				.rejects.toThrow(/sealed holdout evidence/);
		}
		expect(diagnoseEval).not.toHaveBeenCalled();
		expect(evidenceLink).not.toHaveBeenCalled();
		expect(loadEval).toHaveBeenCalledTimes(1);
		expect(loadEval).toHaveBeenCalledWith(expect.any(String), development.evalRunId);

		const corpora = tools.find((tool) => tool.name === "ahde_corpus_list")!;
		const corpusResult = JSON.stringify(textDetails(await corpora.execute("corpora", {}, undefined, undefined, fakeContext(false))));
		expect(corpusResult).toContain('"count":1');
		expect(corpusResult).not.toContain("corpus-secret-id");
		expect(corpusResult).not.toContain("secret holdout");
		expect(corpusResult).not.toContain(sealed.datasetHash);
	});

	it("does not leak a sealed identity through metadata errors", async () => {
		const projectDir = root("ahde-builder-project-");
		const tools = createAhdeBuilderCompatibilityTools({
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			projectId: "demo",
			dependencies: {
				listCorpora: (() => { throw new Error("corpus-super-secret-id"); }) as never,
			},
		});
		for (const name of ["ahde_corpus_list", "ahde_eval_list"]) {
			const action = toolByName(tools, name);
			let message = "";
			try {
				await action.execute("metadata", {}, undefined, undefined, fakeContext(false));
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).toContain("sealed identities remain hidden");
			expect(message).not.toContain("super-secret-id");
		}
	});

	it("counts every sealed corpus before bounding the public development inventory", () => {
		const projectDir = root("ahde-builder-project-");
		const stateRoot = join(projectDir, ".ahde");
		const runsRoot = join(projectDir, "runs");
		for (let index = 0; index < 35; index += 1) {
			createCorpus({
				stateRoot,
				projectId: "demo",
				name: `sealed-${index}`,
				visibility: "sealed",
				tasks: [{
					id: `sealed-task-${index}`,
					input: `private case ${index}`,
					graders: [{ type: "output_contains", text: "private" }],
				}],
			});
		}
		createCorpus({
			stateRoot,
			projectId: "demo",
			name: "development-visible",
			visibility: "development",
			tasks: [{
				id: "development-task",
				input: "public case",
				graders: [{ type: "output_contains", text: "public" }],
			}],
		});

		const status = buildProjectStatus({ projectDir, stateRoot, runsRoot, projectId: "demo" }) as {
			corpora: { development: unknown[]; sealed: { count: number } };
		};
		expect(status.corpora.sealed.count).toBe(35);
		expect(status.corpora.development).toHaveLength(1);
		expect(JSON.stringify(status)).not.toContain("private case");
		expect(JSON.stringify(status)).not.toContain("sealed-task-");
	});

	it("detects a stale immutable subject after the host approved it", async () => {
		const projectDir = root("ahde-builder-project-");
		const stateRoot = join(projectDir, ".ahde");
		const draft = saveSpecSnapshot({ stateRoot, projectId: "demo", spec, status: "draft" });
		const subject = {
			schemaVersion: 1,
			projectId: "demo",
			draftSpecId: draft.id,
			draftSnapshotHash: hashValue(draft),
			specContentHash: hashValue(draft.spec),
		};
		const describeSpecApproval = vi.fn()
			.mockReturnValueOnce(subject)
			.mockReturnValueOnce({ ...subject, draftSnapshotHash: `sha256:${"f".repeat(64)}` });
		const approveSpecDraft = vi.fn();
		const tools = createAhdeBuilderCompatibilityTools({
			projectDir,
			stateRoot,
			runsRoot: join(projectDir, "runs"),
			projectId: "demo",
			dependencies: {
				loadSpec: (() => draft) as never,
				describeSpecApproval: describeSpecApproval as never,
				approveSpecDraft: approveSpecDraft as never,
			},
		});
		const approve = tools.find((tool) => tool.name === "ahde_spec_approve")!;
		await expect(approve.execute(
			"call-stale",
			{ specId: draft.id, reason: "Approve" },
			undefined,
			undefined,
			fakeContext(true, vi.fn(async () => true)),
		)).rejects.toThrow(/stale/);
		expect(approveSpecDraft).not.toHaveBeenCalled();
	});
});

function toolByName(tools: readonly ToolDefinition[], name: string): ToolDefinition {
	const found = tools.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`missing tool ${name}`);
	return found;
}
