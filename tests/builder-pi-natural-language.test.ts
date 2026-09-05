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
	createAhdeBuilderExtension,
} from "../src/builder/extension.js";
import { resolveBuilderAssets } from "../src/builder/runtime.js";
import { startMockModel, type MockRequestContext, type MockStep } from "../src/mock-model.js";
import { generateModelsJson } from "../src/runner.js";
import { createHostContext, hostCatalogModel, modelDefinition } from "./helpers/builder-tools.js";

const TARGET_PROVIDER = "natural-target";
const TARGET_MODEL_ID = "natural-target-model";
const TARGET_CREDENTIAL_ENV = "NATURAL_TARGET_API_KEY";

function parseToolResult(context: MockRequestContext, index: number): Record<string, any> {
	const value = context.toolResults[index];
	if (!value) throw new Error(`missing Builder tool result ${index}`);
	return JSON.parse(value) as Record<string, any>;
}

function call(step: number, name: string, args: Record<string, unknown>): MockStep {
	return { toolCall: { id: `natural-${step}`, name, arguments: args } };
}

/**
 * Free-form operator input has to land on the three production tools and on
 * nothing else: every consequential step is one `ahde_workbench_decide` call
 * that the host gate confirmed, and the model never types a slash command.
 */
it("turns free operator input into gated Workbench decisions through a real Builder Pi session", async () => {
	const targetMock = await startMockModel([{ match: () => true, steps: [{ text: "pending" }] }]);
	const projectDir = mkdtempSync(join(tmpdir(), "ahde-builder-natural-language-"));
	const stateRoot = join(projectDir, ".ahde");
	const runsRoot = join(projectDir, "runs");
	const assets = resolveBuilderAssets();
	process.env[TARGET_CREDENTIAL_ENV] = "target-fixture";
	let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
	let builderMock: Awaited<ReturnType<typeof startMockModel>> | undefined;
	try {
		builderMock = await startMockModel([
			{
				match: ({ firstUser, toolCount }) => firstUser.includes("собери агента") && toolCount === 9,
				steps: [],
				resolve: (context) => {
					const step = context.toolResults.length;
					switch (step) {
						case 0:
							return call(step, "ahde_workbench_view", {});
						case 1:
							return call(step, "ahde_workbench_decide", {
								kind: "scaffold-target",
								reason: "The operator asked for a new agent in this folder",
							});
						case 2:
							return call(step, "ahde_workbench_decide", {
								kind: "configure-target",
								targetId: "natural-agent",
								model: { provider: TARGET_PROVIDER, modelId: TARGET_MODEL_ID, thinkingLevel: "off" },
								reason: "Bind the operator's local model endpoint",
							});
						case 3:
							return call(step, "ahde_workbench_submit", {
								kind: "spec-draft",
								spec: {
									title: "Natural-language answer agent",
									purpose: "Return the reviewed deterministic answer.",
									users: ["acceptance reviewer"],
									jobs: ["answer one request"],
									inputs: ["text request"],
									allowedActions: ["return text"],
									successCriteria: ["answer contains READY"],
									constraints: ["no network"],
									openQuestions: [],
								},
							});
						case 4:
							return call(step, "ahde_workbench_decide", {
								kind: "approve-spec",
								draftSpecId: String(parseToolResult(context, 3).artifact.id),
								reason: "The structured Spec matches the operator's request",
							});
						case 5:
							return call(step, "ahde_workbench_submit", {
								kind: "corpus-draft",
								name: "Natural-language development basket",
								tasks: [
									{ input: "Answer the first reviewed request.", graders: [{ type: "output_contains", text: "READY" }] },
									{ input: "Answer the second reviewed request.", graders: [{ type: "output_contains", text: "READY" }] },
								],
								coverageNotes: ["Two cases expose the same missing instruction."],
								revisionSummary: "Initial development basket",
							});
						case 6:
							return call(step, "ahde_workbench_decide", {
								kind: "publish-corpus",
								draftId: String(parseToolResult(context, 5).artifact.id),
								reason: "Publish the reviewed development basket",
							});
						case 7:
							return call(step, "ahde_workbench_decide", {
								kind: "run-eval",
								repetitions: 1,
								reason: "Measure the exact baseline the operator asked for",
							});
						case 8: {
							const evaluated = parseToolResult(context, 7);
							if (evaluated.view.stage !== "improvement-authoring") {
								throw new Error(`baseline did not reach improvement authoring: ${evaluated.view.stage}`);
							}
							return { text: `Готово: агент создан, Spec утверждена, basket опубликован, база измерена — ${evaluated.result.evaluation.summary.fail} провалов.` };
						}
						default:
							throw new Error(`unexpected natural-language Builder step ${step}`);
					}
				},
			},
			{ match: () => true, steps: [{ text: "BUILDER_NATURAL_LANGUAGE_CONTRACT_MISMATCH" }] },
		]);

		const registered: ToolDefinition[] = [];
		const extension = createAhdeBuilderExtension({
			projectDir,
			stateRoot,
			runsRoot,
			projectId: "natural-agent",
			templateDir: assets.targetTemplateDir,
			dependencies: { actorId: () => "local:natural-language-operator" },
		});
		await extension({
			registerTool: (tool: ToolDefinition) => registered.push(tool),
			registerCommand: () => undefined,
			on: () => undefined,
		} as never);
		expect(registered.map((tool) => tool.name)).toEqual([...AHDE_BUILDER_REGISTERED_TOOL_NAMES]);

		const host = createHostContext({
			catalog: (provider, modelId) =>
				provider === TARGET_PROVIDER && modelId === TARGET_MODEL_ID
					? hostCatalogModel(TARGET_PROVIDER, TARGET_MODEL_ID, targetMock.url)
					: undefined,
			credentialEnv: TARGET_CREDENTIAL_ENV,
		});
		const trustedTools: ToolDefinition[] = registered.map((tool) => ({
			...tool,
			async execute(id, parameters, signal, update) {
				return tool.execute(id, parameters, signal, update, host.ctx);
			},
		}));

		const builderModel = modelDefinition(
			"builder-scripted",
			"builder-model",
			builderMock.url,
			"AHDE_NATURAL_BUILDER_KEY",
		);
		const agentDir = join(stateRoot, "natural-builder-agent");
		const sessionDir = join(stateRoot, "natural-builder-session");
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
		const toolCalls: string[] = [];
		session.subscribe((event) => {
			if (event.type === "tool_execution_start") toolCalls.push(event.toolName);
		});

		await session.prompt(
			"Помоги собери агента, который детерминированно отвечает READY: " +
			"структурируй Spec, собери eval-корзину и измерь базовую линию.",
		);

		expect(session.getLastAssistantText()).toContain("база измерена");
		expect(toolCalls).toEqual([
			"ahde_workbench_view",
			"ahde_workbench_decide",
			"ahde_workbench_decide",
			"ahde_workbench_submit",
			"ahde_workbench_decide",
			"ahde_workbench_submit",
			"ahde_workbench_decide",
			"ahde_workbench_decide",
		]);
		// Exactly the five decide calls reached the human gate; submissions did not.
		expect(host.confirmations.map((entry) => entry.title)).toEqual([
			"Create exact Target harness",
			"Configure exact Target identity and model",
			"Approve exact Spec draft",
			"Publish exact development corpus",
			"Run exact development evaluation",
		]);

		const tracePath = sessionManager.getSessionFile();
		if (!tracePath) throw new Error("Builder Pi did not persist its session trace");
		const trace = readFileSync(tracePath, "utf8");
		for (const toolName of ["ahde_workbench_view", "ahde_workbench_submit", "ahde_workbench_decide"]) expect(trace).toContain(toolName);
		for (const deleted of [
			"ahde_project_status",
			"ahde_spec_save_draft",
			"ahde_corpus_publish_development",
			"ahde_eval_run_development",
		]) {
			expect(trace).not.toContain(deleted);
		}
	} finally {
		delete process.env[TARGET_CREDENTIAL_ENV];
		session?.dispose();
		await builderMock?.close();
		await targetMock.close();
		rmSync(projectDir, { recursive: true, force: true });
	}
}, 180_000);
