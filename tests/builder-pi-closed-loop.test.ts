import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { createCorpus } from "../src/corpus.js";
import { startMockModel, type MockRequestContext, type MockStep } from "../src/mock-model.js";
import { generateModelsJson } from "../src/runner.js";
import { createHostContext, hostCatalogModel, modelDefinition } from "./helpers/builder-tools.js";
import { SEALED_VERIFICATION_REPETITIONS, sealedHoldoutTasks } from "./helpers/sealed-holdout.js";

const PROJECT_ID = "closed-loop-agent";
const TARGET_PROVIDER = "closed-loop-target";
const TARGET_MODEL_ID = "closed-loop-model";
const TARGET_CREDENTIAL_ENV = "CLOSED_LOOP_TARGET_API_KEY";
const SEALED_INPUT = "PRIVATE CLOSED LOOP HOLDOUT INPUT";
const SEALED_NAME = "Evaluator-only closed-loop holdout";
const READY_INSTRUCTION = "Return the exact uppercase word READY.";

function parseToolResult(context: MockRequestContext, index: number): Record<string, any> {
	const value = context.toolResults[index];
	if (!value) throw new Error(`missing Builder tool result ${index}`);
	return JSON.parse(value) as Record<string, any>;
}

function call(step: number, name: string, args: Record<string, unknown>): MockStep {
	return { toolCall: { id: `closed-loop-${step}`, name, arguments: args } };
}

/**
 * The one leg no other test covers: a real Pi loop that closes the whole
 * improvement cycle through `ahde_workbench_decide` — scaffold to
 * continue-cycle — with an approving host gate and a real sealed verdict.
 */
it("closes the whole improvement cycle through ahde_workbench_decide in a real Pi loop", async () => {
	const targetMock = await startMockModel([
		{
			match: ({ system }) => system.includes(READY_INSTRUCTION),
			steps: [{ text: "READY" }],
		},
		{ match: () => true, steps: [{ text: "pending" }] },
	]);
	const projectDir = mkdtempSync(join(tmpdir(), "ahde-builder-closed-loop-"));
	const stateRoot = join(projectDir, ".ahde");
	const runsRoot = join(projectDir, "runs");
	const assets = resolveBuilderAssets();
	process.env[TARGET_CREDENTIAL_ENV] = "target-fixture";
	let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
	let builderMock: Awaited<ReturnType<typeof startMockModel>> | undefined;
	try {
		// The evaluator publishes the promotion gate out of band; Builder Pi can
		// neither create it nor learn its identity.
		const holdout = createCorpus({
			stateRoot,
			projectId: PROJECT_ID,
			name: SEALED_NAME,
			visibility: "sealed",
			tasks: sealedHoldoutTasks(SEALED_INPUT),
		});

		builderMock = await startMockModel([
			{
				match: ({ firstUser, toolCount }) => firstUser.includes("доведи цикл до конца") && toolCount === AHDE_BUILDER_REGISTERED_TOOL_NAMES.length,
				steps: [],
				resolve: (context) => {
					const step = context.toolResults.length;
					switch (step) {
						case 0:
							return call(step, "ahde_workbench_decide", {
								kind: "scaffold-target",
								reason: "Create the agent in this folder",
							});
						case 1:
							return call(step, "ahde_workbench_decide", {
								kind: "configure-target",
								targetId: PROJECT_ID,
								model: { provider: TARGET_PROVIDER, modelId: TARGET_MODEL_ID, thinkingLevel: "off" },
								reason: "Bind the operator's local model endpoint",
							});
						case 2:
							return call(step, "ahde_workbench_submit", {
								kind: "spec-draft",
								spec: {
									title: "Closed-loop answer agent",
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
						case 3:
							// “Start testing” with the Spec still under review: one
							// dialog approves it, and the composite says what is next.
							return call(step, "ahde_workbench_decide", {
								kind: "run-current",
								repetitions: 1,
								reason: "Start testing this agent",
							});
						case 4:
							return call(step, "ahde_workbench_submit", {
								kind: "corpus-draft",
								name: "Closed-loop development basket",
								tasks: [
									{ input: "Answer the first reviewed request.", graders: [{ type: "output_contains", text: "READY" }] },
									{ input: "Answer the second reviewed request.", graders: [{ type: "output_contains", text: "READY" }] },
								],
								coverageNotes: ["Two cases expose the same missing instruction."],
								revisionSummary: "Initial development basket",
							});
						case 5:
							// The same words again: now the basket exists, so the one
							// dialog publishes it and runs it.
							return call(step, "ahde_workbench_decide", {
								kind: "run-current",
								repetitions: 1,
								reason: "Publish the reviewed basket and measure the baseline",
							});
						case 6:
							return call(step, "ahde_workbench_view", { aspect: "traces" });
						case 7:
							return call(step, "ahde_workbench_view", { aspect: "target" });
						case 8:
							return call(step, "ahde_workbench_view", { aspect: "target", resourcePath: "AGENTS.md" });
						case 9: {
							const brief = parseToolResult(context, 6).detail.content.improvementBrief as {
								algorithmId: string;
								evalRunId: string;
								diagnosisId: string;
								briefId: string;
								modes: { failureModeId: string; decision: string; selectableForProposal: boolean }[];
							};
							const mode = brief.modes.find((candidate) =>
								candidate.decision === "propose-harness-change" && candidate.selectableForProposal
							);
							if (!mode) throw new Error("closed-loop baseline produced no proposal-eligible failure mode");
							const overview = parseToolResult(context, 7);
							const current = parseToolResult(context, 8).detail.content.resource.content as string;
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
									content: `${current.trimEnd()}\n\n${READY_INSTRUCTION}\n`,
								}],
								risks: ["The answer contract is intentionally narrow."],
								validationPlan: ["Re-run the reviewed development basket and the sealed gate."],
							});
						}
						case 10:
							return call(step, "ahde_workbench_decide", {
								kind: "apply-proposal",
								runId: String(parseToolResult(context, 9).artifact.runId),
								branch: "candidate/closed-loop",
								reason: "The exact diff addresses the diagnosed failure",
							});
						case 11:
							// “Check it”: routine, so the candidate is verified against
							// its baseline and the sealed gate without a dialog.
							return call(step, "ahde_workbench_decide", {
								kind: "run-current",
								repetitions: SEALED_VERIFICATION_REPETITIONS,
								reason: "Run the exact development and sealed promotion gates",
							});
						case 12:
							// “Ship it”: review, promote, adopt and continue behind one
							// dialog and four unchanged receipts.
							return call(step, "ahde_workbench_decide", {
								kind: "ship",
								version: "0.1.0",
								reason: "Development improved and the sealed guardrail passed",
							});
						case 13: {
							const shipped = parseToolResult(context, 12);
							return { text: `Цикл закрыт: ${shipped.result.tag} promoted, adopted, next stage ${shipped.view.stage}.` };
						}
						default:
							throw new Error(`unexpected closed-loop Builder step ${step}`);
					}
				},
			},
			{ match: () => true, steps: [{ text: "BUILDER_CLOSED_LOOP_CONTRACT_MISMATCH" }] },
		]);

		const registered: ToolDefinition[] = [];
		const extension = createAhdeBuilderExtension({
			projectDir,
			stateRoot,
			runsRoot,
			projectId: PROJECT_ID,
			templateDir: assets.targetTemplateDir,
			dependencies: { actorId: () => "local:closed-loop-operator" },
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
		const observed: { name: string; kind: string; details: Record<string, any> }[] = [];
		const trustedTools: ToolDefinition[] = registered.map((tool) => ({
			...tool,
			async execute(id, parameters, signal, update) {
				const result = await tool.execute(id, parameters, signal, update, host.ctx);
				const first = result.content[0];
				if (!first || first.type !== "text") throw new Error(`tool ${tool.name} returned no text`);
				observed.push({
					name: tool.name,
					kind: String((parameters as { kind?: unknown }).kind ?? (parameters as { aspect?: unknown }).aspect ?? "summary"),
					details: JSON.parse(first.text) as Record<string, any>,
				});
				return result;
			},
		}));

		const builderModel = modelDefinition(
			"builder-closed-loop",
			"builder-model",
			builderMock.url,
			"AHDE_CLOSED_LOOP_BUILDER_KEY",
		);
		const agentDir = join(stateRoot, "closed-loop-agent-dir");
		const sessionDir = join(stateRoot, "closed-loop-session");
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

		await session.prompt(
			"Собери агента, который детерминированно отвечает READY, и доведи цикл до конца: " +
			"Spec, корзина, прогон, улучшение, проверка, релиз и следующий цикл.",
		);

		expect(session.getLastAssistantText()).toContain("v0.1.0 promoted");

		// Every step of the cycle, and the stage it left the Workbench in. A view
		// result is the view itself; a submit/decide result carries the trailing one.
		const stageOf = (entry: { details: Record<string, any> }): string =>
			String(entry.details.view?.stage ?? entry.details.stage);
		expect(observed.map((entry) => `${entry.kind}:${stageOf(entry)}`)).toEqual([
			"scaffold-target:target-setup",
			"configure-target:spec-design",
			"spec-draft:spec-review",
			// “Run the tests” with the Spec pending: approved, and the composite
			// stops there because a basket can only exist after the approval.
			"run-current:corpus-design",
			"corpus-draft:corpus-review",
			// The same words again: publish and run behind one dialog.
			"run-current:improvement-authoring",
			"traces:improvement-authoring",
			"target:improvement-authoring",
			"target:improvement-authoring",
			"structured-proposal:proposal-review",
			"apply-proposal:candidate-verification",
			"run-current:candidate-review",
			// The adopted revision already has matched evidence, so the next cycle
			// resumes at authoring rather than re-measuring the same baseline.
			"ship:improvement-authoring",
		]);

		// The whole cycle asks six questions: the two one-time setup dialogs, and
		// then the three product gates — start testing (twice in the first cycle,
		// because the Spec approval is what lets the basket exist at all), the
		// exact diff, and shipping. Everything else ran on the operator's ask.
		expect(host.confirmations.map((entry) => entry.title)).toEqual([
			"Create exact Target harness",
			"Configure exact Target identity and model",
			"Start testing — approve the Spec",
			"Start testing — publish the eval basket (2 cases), run 2 Target executions",
			"Apply exact Builder proposal",
			"Ship candidate as v0.1.0",
		]);
		expect(host.confirmations).toHaveLength(6);
		// Seven decisions, six dialogs: the candidate verification is routine.
		expect(observed.filter((entry) => entry.name === "ahde_workbench_decide")).toHaveLength(7);

		const verified = observed.find((entry) => entry.details.result?.resolvedAs === "verify-candidate")!;
		expect(verified.details.result).toMatchObject({
			candidate: {
				status: "evaluated",
				development: { gate: { verdict: "improved" } },
				sealedHoldout: { executed: true, gatePassed: true, gate: { verdict: "pass" } },
			},
			development: { verdict: "improved" },
			sealedHoldout: { executed: true, gatePassed: true, verdict: "pass" },
		});
		const shipped = observed.find((entry) => entry.kind === "ship")!;
		expect(shipped.details.result.steps.map((step: { kind: string }) => step.kind)).toEqual([
			"review-candidate",
			"promote-candidate",
			"adopt-candidate",
			"continue-cycle",
		]);
		expect(shipped.details.result.tag).toBe("v0.1.0");
		const candidateSha = execFileSync("git", ["-C", projectDir, "rev-list", "-n", "1", "v0.1.0"], { encoding: "utf8" }).trim();
		expect(shipped.details.result.adoption.toSha).toBe(candidateSha);
		expect(execFileSync("git", ["-C", projectDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim())
			.toBe(candidateSha);
		expect(existsSync(join(stateRoot, "target-adoptions", String(shipped.details.result.candidate.candidateId), "receipt.json")))
			.toBe(true);

		// The sealed holdout drove a real verdict and still never reached the model.
		const everythingTheModelSaw = JSON.stringify(observed);
		for (const secret of [SEALED_INPUT, SEALED_NAME, holdout.id, holdout.hash, "holdout-1"]) {
			expect(everythingTheModelSaw).not.toContain(secret);
		}
	} finally {
		delete process.env[TARGET_CREDENTIAL_ENV];
		session?.dispose();
		await builderMock?.close();
		await targetMock.close();
		rmSync(projectDir, { recursive: true, force: true });
	}
}, 180_000);
