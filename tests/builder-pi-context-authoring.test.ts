import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import {
	AHDE_BUILDER_REGISTERED_TOOL_NAMES,
	AHDE_BUILDER_TOOL_NAMES,
	createAhdeBuilderExtension,
} from "../src/builder/extension.js";
import { resolveBuilderAssets } from "../src/builder/runtime.js";
import type { TargetManifest } from "../src/manifest.js";
import { startMockModel, type MockRequestContext, type MockStep } from "../src/mock-model.js";
import { generateModelsJson } from "../src/runner.js";
import { createAhdeWorkbench } from "../src/workbench/workbench.js";
import type { WorkbenchHumanGate } from "../src/workbench/types.js";

function modelDefinition(
	provider: string,
	id: string,
	baseUrl: string,
	apiKeyEnv: string,
): TargetManifest["model"] {
	return {
		provider,
		id,
		api: "openai-completions",
		baseUrl,
		apiKeyEnv,
		thinkingLevel: "off",
		timeoutMs: 60_000,
		params: {},
		spec: {
			reasoning: false,
			contextWindow: 131_072,
			maxTokens: 4_096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: {},
		},
	};
}

function approvedGate(): WorkbenchHumanGate {
	return {
		confirm: async () => ({ approved: true, actorId: "local:context-authoring-setup" }),
		selectSealed: async () => ({ approved: false }),
	};
}

function parseToolResult(context: MockRequestContext, index: number): Record<string, any> {
	const value = context.toolResults[index];
	if (!value) throw new Error(`missing Builder tool result ${index}`);
	return JSON.parse(value) as Record<string, any>;
}

function call(step: number, name: string, args: Record<string, unknown>): MockStep {
	return { toolCall: { id: `context-authoring-${step}`, name, arguments: args } };
}

it("uses the real typed Builder Pi to inspect exact Target context and stop at proposal review", async () => {
	const targetMock = await startMockModel([{
		match: () => true,
		steps: [{ text: "pending" }],
	}]);
	const projectDir = mkdtempSync(join(tmpdir(), "ahde-builder-context-authoring-"));
	const stateRoot = join(projectDir, ".ahde");
	const runsRoot = join(projectDir, "runs");
	const assets = resolveBuilderAssets();
	const targetModel = modelDefinition(
		"target-context-scripted",
		"target-context-model",
		targetMock.url,
		"AHDE_CONTEXT_TARGET_KEY",
	);
	let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
	let builderMock: Awaited<ReturnType<typeof startMockModel>> | undefined;
	process.env.AHDE_CONTEXT_TARGET_KEY = "target-fixture";
	try {
		const setup = createAhdeWorkbench({
			projectDir,
			stateRoot,
			runsRoot,
			projectId: "context-agent",
			templateDir: assets.targetTemplateDir,
		});
		await setup.decide({ kind: "scaffold-target", reason: "Create the real context-authoring fixture" }, approvedGate());
		await setup.decide({
			kind: "configure-target",
			targetId: "context-agent",
			model: {
				provider: targetModel.provider,
				modelId: targetModel.id,
				thinkingLevel: targetModel.thinkingLevel,
				timeoutMs: targetModel.timeoutMs,
				params: targetModel.params,
			},
			reason: "Bind the local deterministic Target model",
		}, approvedGate(), { resolveTargetModel: () => targetModel });
		const drafted = await setup.submit({
			kind: "spec-draft",
			spec: {
				schemaVersion: 1,
				title: "Context-aware deterministic agent",
				purpose: "Return the reviewed deterministic answer.",
				users: ["acceptance reviewer"],
				jobs: ["answer one deterministic request"],
				inputs: ["text request"],
				allowedActions: ["return text"],
				successCriteria: ["answer contains READY"],
				constraints: ["no external network"],
				openQuestions: [],
			},
		});
		await setup.decide({
			kind: "approve-spec",
			draftSpecId: String(drafted.artifact?.id),
			reason: "Approve the exact deterministic contract",
		}, approvedGate());
		const corpusDraft = await setup.submit({
			kind: "corpus-draft",
			name: "Context-authoring development basket",
			tasks: [
				{ input: "Return the first reviewed answer.", graders: [{ type: "output_contains", text: "READY" }] },
				{ input: "Return the second reviewed answer.", graders: [{ type: "output_contains", text: "READY" }] },
			],
			coverageNotes: ["Two distinct cases expose the same missing instruction."],
			revisionSummary: "Initial systemic failure fixture",
		});
		await setup.decide({
			kind: "publish-corpus",
			draftId: String(corpusDraft.artifact?.id),
			reason: "Publish the reviewed development basket",
		}, approvedGate());
		const evaluated = await setup.decide({
			kind: "run-current",
			repetitions: 1,
			reason: "Produce one real conclusive baseline",
		}, approvedGate());
		expect(evaluated.result).toMatchObject({ resolvedAs: "run-eval" });
		expect(evaluated.view.stage).toBe("improvement-authoring");

		builderMock = await startMockModel([
			{
				match: ({ firstUser, system, toolCount }) =>
					firstUser.includes("Исправь первую проблему") &&
					// The same rule the persona used to open with “Before authoring,
					// inspect the fresh Target overview”, in the words it kept.
					system.includes("read every resource a change replaces first") &&
					system.includes("resourcePath") &&
					toolCount === 8,
				steps: [],
				resolve: (context) => {
					const step = context.toolResults.length;
					switch (step) {
						case 0:
							return call(step, "ahde_workbench_view", { aspect: "traces" });
						case 1:
							return call(step, "ahde_workbench_view", { aspect: "target" });
						case 2: {
							const overview = parseToolResult(context, 1);
							const resources = overview.detail.content.resources as { path: string }[];
							const instructions = resources.find((resource) => resource.path === "AGENTS.md");
							if (!instructions) throw new Error("safe Target overview omitted AGENTS.md");
							return call(step, "ahde_workbench_view", {
								aspect: "target",
								resourcePath: instructions.path,
							});
						}
						case 3: {
							const traces = parseToolResult(context, 0);
							const overview = parseToolResult(context, 1);
							const brief = traces.detail.content.improvementBrief as {
								algorithmId: "exact-eval-signals-v1";
								evalRunId: string;
								diagnosisId: string;
								briefId: string;
								modes: { failureModeId: string; decision: string; selectableForProposal: boolean }[];
							};
							const mode = brief.modes.find((candidate) =>
								candidate.decision === "propose-harness-change" && candidate.selectableForProposal
							);
							if (!mode) throw new Error("real baseline produced no proposal-eligible failure mode");
							const target = parseToolResult(context, 2);
							const current = target.detail.content.resource.content as string;
							return call(step, "ahde_workbench_submit", {
								kind: "structured-proposal",
								authoringContext: overview.detail.content.claim,
								source: {
									algorithmId: brief.algorithmId,
									evalRunId: brief.evalRunId,
									diagnosisId: brief.diagnosisId,
									briefId: brief.briefId,
								},
								failureModeIds: [mode.failureModeId],
								summary: "Make the reviewed deterministic answer explicit.",
								intents: [{
									type: "instructions.replace",
									content: `${current.trimEnd()}\n\nReturn the exact uppercase word READY.\n`,
								}],
								risks: ["The answer contract is intentionally narrow."],
								validationPlan: ["Re-run the reviewed development basket."],
							});
						}
						case 4: {
							const submitted = parseToolResult(context, 3);
							const authored = submitted.artifact as { runId?: unknown; improvementBriefId?: unknown; failureModeIds?: unknown };
							if (typeof authored.runId !== "string" || typeof authored.improvementBriefId !== "string") {
								throw new Error("proposal submission omitted the ids the next call needs");
							}
							if (!Array.isArray(authored.failureModeIds) || authored.failureModeIds.length !== 1) {
								throw new Error("proposal submission omitted the failure modes it was authored from");
							}
							// The model-facing projection hands back ids, never digests.
							if (JSON.stringify(submitted).includes("sha256:")) {
								throw new Error("proposal submission leaked a digest into the model's result");
							}
							return call(step, "ahde_workbench_view", { aspect: "review" });
						}
						case 5: {
							const review = parseToolResult(context, 4);
							if (!String(review.detail.content.exactDiff).includes("Return the exact uppercase word READY.")) {
								throw new Error("review omitted the exact compiled instruction diff");
							}
							return { text: "Proposal готов: exact Target прочитан, diff открыт для review; apply не выполнялся." };
						}
						default:
							throw new Error(`unexpected context-aware Builder step ${step}`);
					}
				},
			},
			{
				match: () => true,
				steps: [{ text: "BUILDER_CONTEXT_PROMPT_CONTRACT_MISMATCH" }],
			},
		]);

		const registered: ToolDefinition[] = [];
		const extension = createAhdeBuilderExtension({
			projectDir,
			stateRoot,
			runsRoot,
			projectId: "context-agent",
			templateDir: assets.targetTemplateDir,
			dependencies: { actorId: () => "local:context-authoring-operator" },
		});
		await extension({
			registerTool: (tool: ToolDefinition) => registered.push(tool),
			registerCommand: () => undefined,
			on: () => undefined,
		} as never);
		expect(registered.map((tool) => tool.name)).toEqual([...AHDE_BUILDER_REGISTERED_TOOL_NAMES]);

		const observedCalls: { name: string; parameters: Record<string, unknown> }[] = [];
		const hostContext = {
			hasUI: true,
			mode: "tui",
			ui: {
				confirm: async () => {
					throw new Error("proposal authoring must stop before any host decision");
				},
				select: async () => undefined,
				notify: () => undefined,
			},
		} as any;
		const trustedTools: ToolDefinition[] = registered.map((tool) => ({
			...tool,
			async execute(id, parameters, signal, update) {
				observedCalls.push({ name: tool.name, parameters: parameters as Record<string, unknown> });
				return tool.execute(id, parameters, signal, update, hostContext);
			},
		}));

		const builderModel = modelDefinition(
			"builder-context-scripted",
			"builder-context-model",
			builderMock.url,
			"AHDE_CONTEXT_BUILDER_KEY",
		);
		const agentDir = join(stateRoot, "context-builder-agent");
		const sessionDir = join(stateRoot, "context-builder-session");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		const modelsPath = join(agentDir, "models.json");
		writeFileSync(modelsPath, `${JSON.stringify(generateModelsJson(builderModel), null, 2)}\n`);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(builderModel.provider, async () => ({ type: "api_key", key: "builder-fixture" }));
		const modelRuntime = await ModelRuntime.create({ modelsPath, credentials, allowModelNetwork: false });
		const selected = modelRuntime.getModel(builderModel.provider, builderModel.id);
		if (!selected) throw new Error("scripted Builder model was not registered");
		const services = await createAgentSessionServices({
			cwd: projectDir,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			resourceLoaderOptions: {
				noContextFiles: true,
				noExtensions: true,
				noPromptTemplates: true,
				noThemes: true,
				systemPrompt: assets.systemPrompt,
				additionalSkillPaths: assets.skillPaths,
			},
		});
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		session = (await createAgentSessionFromServices({
			services,
			sessionManager,
			model: selected,
			thinkingLevel: "off",
			noTools: "builtin",
			customTools: trustedTools,
		})).session;

		await session.prompt("Исправь первую проблему из последнего прогона и покажи proposal, но ничего не применяй.");

		expect(session.getLastAssistantText()).toContain("apply не выполнялся");
		expect(observedCalls).toEqual([
			{ name: "ahde_workbench_view", parameters: { aspect: "traces" } },
			{ name: "ahde_workbench_view", parameters: { aspect: "target" } },
			{ name: "ahde_workbench_view", parameters: { aspect: "target", resourcePath: "AGENTS.md" } },
			{ name: "ahde_workbench_submit", parameters: expect.objectContaining({ kind: "structured-proposal" }) },
			{ name: "ahde_workbench_view", parameters: { aspect: "review" } },
		]);
		const finalView = await createAhdeWorkbench({
			projectDir,
			stateRoot,
			runsRoot,
			projectId: "context-agent",
		}).view({ aspect: "review" });
		expect(finalView).toMatchObject({
			stage: "proposal-review",
			counts: { openProposals: 1, candidates: 0 },
			detail: {
				aspect: "review",
				content: {
					kind: "proposal",
					paths: ["AGENTS.md"],
					authoringContext: expect.objectContaining({
						targetId: "context-agent",
						contextHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
					}),
					exactDiff: expect.stringContaining("Return the exact uppercase word READY."),
				},
			},
		});
		const tracePath = sessionManager.getSessionFile();
		if (!tracePath) throw new Error("Builder Pi did not persist its context-authoring trace");
		const trace = readFileSync(tracePath, "utf8");
		for (const toolName of AHDE_BUILDER_TOOL_NAMES.slice(0, 2)) expect(trace).toContain(toolName);
		expect(trace).not.toContain("ahde_target_read");
		expect(trace).not.toContain("ahde_proposal_apply");
	} finally {
		delete process.env.AHDE_CONTEXT_TARGET_KEY;
		session?.dispose();
		await builderMock?.close();
		await targetMock.close();
		rmSync(projectDir, { recursive: true, force: true });
	}
}, 180_000);
