import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { createAhdeBuilderCompatibilityTools as createAhdeBuilderTools } from "../src/builder/extension.js";
import { resolveBuilderAssets } from "../src/builder/runtime.js";
import { createCorpus } from "../src/corpus.js";
import { diagnoseEvalRun } from "../src/diagnosis.js";
import {
	compileImprovementBrief,
	deriveEvidenceLinkedProposalSelection,
} from "../src/application/improvement-brief.js";
import type { TargetManifest } from "../src/manifest.js";
import { startMockModel, type MockRequestContext, type MockStep } from "../src/mock-model.js";
import { generateModelsJson } from "../src/runner.js";

function sha256(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function wholeFileDiff(path: string, before: string, after: string): string {
	const oldLines = before.replace(/\n$/, "").split("\n");
	const newLines = after.replace(/\n$/, "").split("\n");
	return [
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		`@@ -1,${oldLines.length} +1,${newLines.length} @@`,
		...oldLines.map((line) => `-${line}`),
		...newLines.map((line) => `+${line}`),
	].join("\n");
}

function parseToolResult(context: MockRequestContext, index: number): Record<string, any> {
	const value = context.toolResults[index];
	if (!value) throw new Error(`missing Builder tool result ${index}`);
	return JSON.parse(value) as Record<string, any>;
}

function call(step: number, name: string, args: Record<string, unknown>): MockStep {
	return { toolCall: { id: `builder-call-${step}`, name, arguments: args } };
}

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

it("turns free input into a complete promoted candidate through a real Builder Pi tool-call session", async () => {
	const targetMock = await startMockModel([
		{
			match: ({ system }) => system.includes("Return the exact uppercase word READY."),
			steps: [{ text: "READY" }],
		},
		{ match: () => true, steps: [{ text: "pending" }] },
	]);
	const projectDir = mkdtempSync(join(tmpdir(), "ahde-builder-natural-language-"));
	const stateRoot = join(projectDir, ".ahde");
	const runsRoot = join(projectDir, "runs");
	const assets = resolveBuilderAssets();
	const before = readFileSync(join(assets.targetTemplateDir, "AGENTS.md"), "utf8");
	const after = `${before.trimEnd()}\n\nReturn the exact uppercase word READY.\n`;
	const targetModel = modelDefinition(
		"target-scripted",
		"target-model",
		targetMock.url,
		"AHDE_NATURAL_TARGET_KEY",
	);

	createCorpus({
		stateRoot,
		projectId: "natural-agent",
		name: "Evaluator-only natural-language holdout",
		visibility: "sealed",
		tasks: [{
			id: "sealed-natural-1",
			input: "PRIVATE NATURAL LANGUAGE HOLDOUT",
			graders: [{ type: "output_contains", text: "READY" }],
		}],
	});

	const builderMock = await startMockModel([{
		match: ({ firstUser }) => firstUser.includes("собери агента"),
		steps: [],
		resolve: (context) => {
			const step = context.toolResults.length;
			switch (step) {
				case 0:
					return call(step, "ahde_target_scaffold", { reason: "Initialize the requested agent" });
				case 1:
					return call(step, "ahde_target_configure_model", {
						targetId: "natural-agent",
						model: targetModel,
						reason: "Use the operator-provided local model endpoint",
					});
				case 2:
					return call(step, "ahde_spec_save_draft", {
						title: "Natural-language golden agent",
						purpose: "Return the reviewed deterministic answer.",
						users: ["acceptance reviewer"],
						jobs: ["answer one request"],
						inputs: ["text request"],
						allowedActions: ["return text"],
						successCriteria: ["answer contains READY"],
						constraints: ["no network"],
						openQuestions: [],
					});
				case 3:
					return call(step, "ahde_spec_approve", {
						specId: parseToolResult(context, 2).id,
						reason: "The structured Spec matches the user's request",
					});
				case 4:
					return call(step, "ahde_corpus_publish_development", {
						name: "Natural-language development",
						tasks: [{
							id: "dev-natural-1",
							input: "Answer the reviewed request.",
							graders: [{ type: "output_contains", text: "READY" }],
						}],
						reason: "Measure the approved observable contract",
					});
				case 5:
					return call(step, "ahde_eval_run_development", {
						developmentCorpusId: parseToolResult(context, 4).corpus.id,
						repetitions: 1,
						reason: "Measure the exact baseline",
					});
				case 6: {
					const evalRunId = parseToolResult(context, 5).evaluation.evalRunId;
					const brief = compileImprovementBrief(runsRoot, diagnoseEvalRun(runsRoot, evalRunId));
					const failureMode = brief.modes.find((mode) => mode.decision === "propose-harness-change");
					if (!failureMode) throw new Error("natural-language fixture has no proposal-eligible failure mode");
					const proposalBasis = {
						algorithmId: brief.algorithmId,
						evalRunId: brief.evalRunId,
						diagnosisId: brief.diagnosisId,
						briefId: brief.briefId,
						failureModeIds: [failureMode.failureModeId],
					};
					const selected = deriveEvidenceLinkedProposalSelection(brief, proposalBasis);
					const evidenceRefs = [...new Set(selected.diagnoses.flatMap((item) => item.evidence))];
					return call(step, "ahde_proposal_create", {
						specDraftId: parseToolResult(context, 2).id,
						sourceEvalRunId: evalRunId,
						proposalBasis,
						decision: "propose",
						summary: "Make the approved answer contract explicit.",
						diagnoses: selected.diagnoses,
						changes: [{
							path: "AGENTS.md",
							baseSha256: sha256(before),
							unifiedDiff: wholeFileDiff("AGENTS.md", before, after),
							rationale: "Align the harness with the approved observable contract.",
							evidenceRefs,
						}],
						risks: ["The output contract is intentionally narrow."],
						validationPlan: ["Run matched development and evaluator-only evidence."],
					});
				}
				case 7:
					return call(step, "ahde_proposal_diff", { runId: parseToolResult(context, 6).runId });
				case 8:
					return call(step, "ahde_proposal_apply", {
						runId: parseToolResult(context, 6).runId,
						branch: "candidate/natural-language",
						reason: "The reviewed exact diff addresses the measured failure",
					});
				case 9:
					return call(step, "ahde_candidate_verify", {
						builderRunId: parseToolResult(context, 6).runId,
						repetitions: 1,
						reason: "Run the exact development and sealed promotion gates",
					});
				case 10:
					return call(step, "ahde_candidate_review", {
						candidateId: parseToolResult(context, 9).candidate.candidateId,
						recommendation: "promote",
						reason: "Development improved and evaluator-only evidence passed",
					});
				case 11:
					return call(step, "ahde_candidate_promote", {
						candidateId: parseToolResult(context, 9).candidate.candidateId,
						version: "0.1.0",
						reason: "Ship the exact reviewed candidate",
					});
				case 12:
					return { text: "Готово: Spec утверждена, failure mode исправлен, sealed gate пройден, v0.1.0 promoted." };
				default:
					throw new Error(`unexpected Builder step ${step}`);
			}
		},
	}]);

	process.env.AHDE_NATURAL_TARGET_KEY = "target-fixture";
	let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
	try {
		const confirmations: string[] = [];
		const hostContext = {
			hasUI: true,
			mode: "tui",
			ui: {
				confirm: async (title: string) => {
					confirmations.push(title);
					return true;
				},
				select: async () => undefined,
				notify: () => undefined,
			},
		} as any;
		const modelTools = createAhdeBuilderTools({
			projectDir,
			stateRoot,
			runsRoot,
			projectId: "natural-agent",
			templateDir: assets.targetTemplateDir,
			dependencies: { actorId: () => "local:natural-language-operator" },
		});
		const toolCalls: string[] = [];
		const trustedTools: ToolDefinition[] = modelTools.map((tool) => ({
			...tool,
			async execute(id, params, signal, update) {
				return tool.execute(id, params, signal, update, hostContext);
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
		session.subscribe((event) => {
			if (event.type === "tool_execution_start") toolCalls.push(event.toolName);
		});

		await session.prompt(
			"Хочу собрать агента, который детерминированно отвечает READY. " +
			"Помоги структурировать Spec, собрать eval и довести улучшение до проверанного релиза.",
		);

		expect(session.getLastAssistantText()).toContain("v0.1.0 promoted");
		expect(toolCalls).toEqual([
			"ahde_target_scaffold",
			"ahde_target_configure_model",
			"ahde_spec_save_draft",
			"ahde_spec_approve",
			"ahde_corpus_publish_development",
			"ahde_eval_run_development",
			"ahde_proposal_create",
			"ahde_proposal_diff",
			"ahde_proposal_apply",
			"ahde_candidate_verify",
			"ahde_candidate_review",
			"ahde_candidate_promote",
		]);
		expect(confirmations).toHaveLength(9);
		const tracePath = sessionManager.getSessionFile();
		if (!tracePath) throw new Error("Builder Pi did not persist its session trace");
		const trace = readFileSync(tracePath, "utf8");
		for (const toolName of toolCalls) expect(trace).toContain(toolName);
		const promotedSha = execFileSync(
			"git",
			["-C", projectDir, "rev-list", "-n", "1", "v0.1.0"],
			{ encoding: "utf8" },
		).trim();
		expect(promotedSha).toMatch(/^[0-9a-f]{40}$/);
	} finally {
		delete process.env.AHDE_NATURAL_TARGET_KEY;
		session?.dispose();
		await builderMock.close();
		await targetMock.close();
		rmSync(projectDir, { recursive: true, force: true });
	}
}, 180_000);
