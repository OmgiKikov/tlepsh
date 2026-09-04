import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AHDE_BUILDER_REGISTERED_TOOL_NAMES,
	AHDE_BUILDER_TOOL_NAMES,
	CONSEQUENTIAL_BUILDER_TOOL_NAMES,
	createAhdeBuilderExtension,
	createAhdeBuilderTools,
} from "../src/builder/extension.js";
import { AHDE_BUILDER_COMMAND_NAMES } from "../src/builder/commands.js";
import {
	WorkbenchDecisionToolSchema,
	WorkbenchSubmitToolSchema,
	WorkbenchViewToolSchema,
} from "../src/builder/workbench-transport.js";
import {
	WorkbenchDecisionInputSchema,
	WorkbenchSubmitInputSchema,
	WorkbenchViewQuerySchema,
} from "../src/workbench/types.js";
import { AhdeWorkbench } from "../src/workbench/workbench.js";
import { buildProjectStatus } from "../src/builder/project-context.js";
import { createCorpus } from "../src/corpus.js";
import { baseFixtureFiles, makeTargetFixture } from "./fixtures.js";

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
		const datasetRecipe = {
			kind: "dataset-recipe",
			sourcePath: "imports/tickets.csv",
			recipe: {
				schemaVersion: 1,
				input: { template: "{{question}} (tier {{tier}})" },
				expected: { column: "answer" },
				dialogue: { column: "history" },
				metadata: ["tier"],
				filters: [{ column: "tier", matches: "gold|standard" }],
				sample: { limit: 60, seed: "thin-1", stratifyBy: "tier" },
				graders: [{ type: "output_contains", text: "{{expected}}" }],
				idPrefix: "ticket",
			},
			name: "Refund tickets",
			revisionSummary: "Map the exported tickets into cases",
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
			authoringContext: {
				algorithmId: "git-manifest-context-v1",
				targetId: "test-target",
				targetGitSha: "a".repeat(40),
				contextHash: `sha256:${"c".repeat(64)}`,
			},
			source: {
				algorithmId: "exact-eval-signals-v1",
				evalRunId: "erun_verified",
				diagnosisId: "diagnosis-verified",
				briefId: `brief-${"a".repeat(24)}`,
			},
			failureModeIds: [`failure-mode-${"b".repeat(24)}`],
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
			{
				...corpusDraft,
				tasks: [{
					input: "Route this support request",
					expected: "billing",
					messages: [
						{ role: "assistant", content: "How can I help?" },
						{ role: "user", content: "Route this support request" },
					],
					metadata: { tier: "gold" },
					graders: [{ type: "output_contains", text: "billing" }],
				}],
			},
			corpusImport,
			datasetRecipe,
			corpusRevision,
			corpusEvidenceRevision,
			structuredProposal,
		]) {
			expect(Check(WorkbenchSubmitToolSchema.parameters, accepted)).toBe(true);
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
			// A dialogue whose last turn does not repeat `input` would silently
			// change the question every consumer that reads only `input` asks.
			{
				...corpusDraft,
				tasks: [{
					input: "Route this support request",
					messages: [{ role: "user", content: "Something else entirely" }],
					graders: [{ type: "output_contains", text: "billing" }],
				}],
			},
			{ ...datasetRecipe, sourcePath: "../private.csv" },
			{ ...datasetRecipe, sourcePath: "imports/sheet.xlsx" },
			{ ...datasetRecipe, recipe: { ...datasetRecipe.recipe, graders: [] } },
			{ ...datasetRecipe, recipe: { ...datasetRecipe.recipe, input: undefined, dialogue: undefined } },
			{ ...datasetRecipe, recipe: { ...datasetRecipe.recipe, filters: [{ column: "tier" }] } },
			{ ...datasetRecipe, recipe: { ...datasetRecipe.recipe, sample: { limit: 1_001, seed: "thin-1" } } },
			{ ...datasetRecipe, corpusId: "corpus-forged" },
			{ ...corpusRevision, operations: [...corpusRevision.operations, { type: "rename", name: "one-too-many" }] },
			{ ...structuredProposal, intents: [...structuredProposal.intents, { type: "instructions.replace", content: "One too many" }] },
			{ ...structuredProposal, failureModeIds: [...structuredProposal.failureModeIds, structuredProposal.failureModeIds[0]] },
			{ ...structuredProposal, diagnoses: [{ failureIds: ["forged"], evidence: ["forged"], rootCause: "forged" }] },
		]) {
			// The tool schema is generated from this zod schema, so the model-facing
			// gate is the same one; a few bounds (path policy, id uniqueness) live in
			// refinements JSON Schema cannot express and are rejected at prepare().
			expect(WorkbenchSubmitInputSchema.safeParse(invalid).success).toBe(false);
			expect(() => WorkbenchSubmitToolSchema.prepare(invalid)).toThrow();
		}

		const blankDecision = { kind: "run-current", repetitions: 1, reason: "   " };
		expect(Check(WorkbenchDecisionToolSchema.parameters, blankDecision)).toBe(false);
		expect(WorkbenchDecisionInputSchema.safeParse(blankDecision).success).toBe(false);

		const compactModelSelection = {
			kind: "configure-target",
			targetId: "support-agent",
			model: {
				provider: "openai",
				modelId: "gpt-5",
				thinkingLevel: "medium",
			},
			reason: "Use the exact host catalog model",
		};
		expect(Check(WorkbenchDecisionToolSchema.parameters, compactModelSelection)).toBe(true);
		expect(WorkbenchDecisionInputSchema.safeParse(compactModelSelection).success).toBe(true);
		for (const invalidModelSelection of [
			{ ...compactModelSelection, model: { ...compactModelSelection.model, apiKeyEnv: "AWS_SECRET_ACCESS_KEY" } },
			{ ...compactModelSelection, model: { ...compactModelSelection.model, api: "openai-responses" } },
			{ ...compactModelSelection, model: { ...compactModelSelection.model, baseUrl: "https://attacker.invalid" } },
			{ ...compactModelSelection, resolveTargetModel: () => ({}) },
		]) {
			expect(Check(WorkbenchDecisionToolSchema.parameters, invalidModelSelection)).toBe(false);
			expect(WorkbenchDecisionInputSchema.safeParse(invalidModelSelection).success).toBe(false);
			expect(() => WorkbenchDecisionToolSchema.prepare(invalidModelSelection)).toThrow();
		}

		const importDataset = {
			kind: "import-dataset",
			sealed: { count: 40, seed: "exam-1", stratifyBy: "tier" },
			reason: "Import the exported tickets",
		};
		for (const accepted of [importDataset, { ...importDataset, sealed: null }]) {
			expect(Check(WorkbenchDecisionToolSchema.parameters, accepted)).toBe(true);
			expect(WorkbenchDecisionInputSchema.safeParse(accepted).success).toBe(true);
		}
		for (const invalid of [
			{ ...importDataset, sealed: { count: 0, seed: "exam-1" } },
			{ ...importDataset, sealed: { count: 40 } },
			{ ...importDataset, sealedCorpusId: `corpus-${"a".repeat(64)}` },
		]) {
			expect(WorkbenchDecisionInputSchema.safeParse(invalid).success).toBe(false);
			expect(() => WorkbenchDecisionToolSchema.prepare(invalid)).toThrow();
		}

		for (const targetView of [
			{ aspect: "target" },
			{ aspect: "target", resourcePath: "AGENTS.md" },
			{ aspect: "dataset", resourcePath: "imports/tickets.csv" },
		]) {
			expect(Check(WorkbenchViewToolSchema.parameters, targetView)).toBe(true);
			expect(WorkbenchViewQuerySchema.safeParse(targetView).success).toBe(true);
		}
		for (const invalidView of [
			{ aspect: "traces", resourcePath: "AGENTS.md" },
			{ resourcePath: "AGENTS.md" },
			{ aspect: "target", resourcePath: "x".repeat(501) },
			{ aspect: "dataset" },
		]) {
			expect(WorkbenchViewQuerySchema.safeParse(invalidView).success).toBe(false);
			expect(() => WorkbenchViewToolSchema.prepare(invalidView)).toThrow();
		}
	});

	it("registers only narrow AHDE tools and keeps authority out of dangerous schemas", () => {
		const projectDir = root("ahde-builder-project-");
		const tools = createAhdeBuilderTools({
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			projectId: "demo",
		});
		expect(tools.map((tool) => tool.name)).toEqual([...AHDE_BUILDER_REGISTERED_TOOL_NAMES]);
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
		expect(registered.map((tool) => tool.name)).toEqual([...AHDE_BUILDER_REGISTERED_TOOL_NAMES]);
		// The public list is the `/help` order; where each handler sits in the
		// file is nobody's business. Membership is what may never drift.
		expect([...commands].sort()).toEqual([...AHDE_BUILDER_COMMAND_NAMES].sort());
		expect(handlers.get("user_bash")?.()).toMatchObject({
			result: { exitCode: 126, output: expect.stringContaining("no shell here") },
		});
		expect(handlers.get("tool_call")?.({ toolName: "bash" } as never)).toMatchObject({ block: true, terminate: true });
		expect(handlers.get("tool_call")?.({ toolName: "ahde_workbench_view" } as never)).toBeUndefined();
		// The deleted compatibility surface is not merely unregistered: it is blocked.
		for (const removed of ["ahde_project_status", "ahde_target_read", "ahde_proposal_apply", "ahde_candidate_promote"]) {
			expect(handlers.get("tool_call")?.({ toolName: removed } as never)).toMatchObject({
				block: true,
				terminate: true,
			});
		}
		const suspend = vi.spyOn(AhdeWorkbench.prototype, "suspendWorkshop");
		expect(handlers.get("session_shutdown")?.()).toBeUndefined();
		expect(suspend).toHaveBeenCalledOnce();
	});

	it("turns plain-language agent handoff into a host-owned Runtime Pi transition", async () => {
		const projectDir = makeTargetFixture(baseFixtureFiles());
		roots.push(projectDir);
		const requested = vi.fn();
		const shutdown = vi.fn();
		const previous = process.env.TEST_MODEL_KEY;
		process.env.TEST_MODEL_KEY = "test-only";
		try {
			const tools = createAhdeBuilderTools({
				projectDir,
				stateRoot: root("ahde-builder-handoff-state-"),
				runsRoot: root("ahde-builder-handoff-runs-"),
				projectId: "demo",
				onTalkToTarget: requested,
			});
			const decide = tools.find((tool) => tool.name === "ahde_workbench_decide")!;
			const input = WorkbenchDecisionToolSchema.prepare({
				kind: "talk-to-agent",
				reason: "The operator wants to try the built agent",
			});
			const result = await decide.execute!(
				"handoff-1",
				input as never,
				undefined,
				() => undefined,
				{
					hasUI: true,
					mode: "tui",
					shutdown,
					ui: { notify: vi.fn() },
				} as never,
			);
			expect(requested).toHaveBeenCalledOnce();
			expect(JSON.stringify(result)).toContain("opening the active agent");
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(shutdown).toHaveBeenCalledOnce();
		} finally {
			if (previous === undefined) delete process.env.TEST_MODEL_KEY;
			else process.env.TEST_MODEL_KEY = previous;
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
});
