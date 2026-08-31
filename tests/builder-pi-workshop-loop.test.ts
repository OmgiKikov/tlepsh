import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import {
	listBuilderProposalAdmissions,
	loadBuilderProposalRun,
} from "../src/application/builder-proposal.js";
import { createCorpus } from "../src/corpus.js";
import { loadTarget } from "../src/manifest.js";
import { startMockModel, type MockRequestContext, type MockStep } from "../src/mock-model.js";
import { generateModelsJson } from "../src/runner.js";
import { createHostContext, hostCatalogModel, modelDefinition } from "./helpers/builder-tools.js";
import { SEALED_VERIFICATION_REPETITIONS, sealedHoldoutTasks } from "./helpers/sealed-holdout.js";

const PROJECT_ID = "workshop-loop-agent";
const TARGET_PROVIDER = "workshop-loop-target";
const TARGET_MODEL_ID = "workshop-loop-model";
const TARGET_CREDENTIAL_ENV = "WORKSHOP_LOOP_TARGET_API_KEY";
const SEALED_INPUT = "PRIVATE WORKSHOP HOLDOUT INPUT";
const SEALED_NAME = "Evaluator-only workshop holdout";
const READY_INSTRUCTION = "Return the exact uppercase word READY.";
/** The second half of the contract, added by the improvement workshop. */
const PLUS_INSTRUCTION = "After READY, also return the exact uppercase word PLUS.";

const READY_CHECK_DESCRIPTOR = `schemaVersion: 1
name: ready_check
description: Report whether an answer carries the reviewed READY contract.
parameters:
  type: object
  properties:
    answer:
      type: string
      minLength: 1
      maxLength: 200
  required: [answer]
  additionalProperties: false
command:
  argv: [tools/ready_check/run]
timeoutMs: 10000
maxOutputBytes: 8192
output: json
permissions:
  environment: []
  network: deny
  filesystem: read-only
setup:
  argv: [sh, -c, "cp contract.txt prepared-contract.txt"]
  timeoutMs: 20000
  network: deny
`;

/** The first attempt reads a file the setup step has not produced yet. */
const READY_CHECK_RUN_BROKEN = `#!/bin/sh
IFS= read -r payload || exit 2
contract=$(cat "$AHDE_TOOL_HOME/contract-typo.txt") || exit 3
case "$payload" in
  *"$contract"*) printf '{"ready":true}\\n' ;;
  *) printf '{"ready":false}\\n' ;;
esac
`;

const READY_CHECK_RUN = `#!/bin/sh
IFS= read -r payload || exit 2
contract=$(cat "$AHDE_TOOL_HOME/prepared-contract.txt") || exit 3
case "$payload" in
  *"$contract"*) printf '{"ready":true}\\n' ;;
  *) printf '{"ready":false}\\n' ;;
esac
`;

function parseToolResult(context: MockRequestContext, index: number): Record<string, any> {
	const value = context.toolResults[index];
	if (!value) throw new Error(`missing Builder tool result ${index}`);
	return JSON.parse(value) as Record<string, any>;
}

function call(step: number, name: string, args: Record<string, unknown>): MockStep {
	return { toolCall: { id: `workshop-loop-${step}`, name, arguments: args } };
}

/**
 * The honest end-to-end proof of the workshop: Builder Pi writes a multi-file
 * tool with its own setup step, runs it, sees it fail, fixes it, runs it again,
 * closes the workshop into an ordinary proposal, and the operator applies,
 * verifies and ships that exact diff.
 */
it("writes a tool in the workshop, tries it, closes, applies, verifies and ships", async () => {
	const targetMock = await startMockModel([
		{
			match: ({ system }) => system.includes(READY_INSTRUCTION),
			steps: [{ text: "READY" }],
		},
		{ match: () => true, steps: [{ text: "pending" }] },
	]);
	const projectDir = mkdtempSync(join(tmpdir(), "ahde-builder-workshop-loop-"));
	const stateRoot = join(projectDir, ".ahde");
	const runsRoot = join(projectDir, "runs");
	const assets = resolveBuilderAssets();
	process.env[TARGET_CREDENTIAL_ENV] = "target-fixture";
	let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
	let builderMock: Awaited<ReturnType<typeof startMockModel>> | undefined;
	try {
		createCorpus({
			stateRoot,
			projectId: PROJECT_ID,
			name: SEALED_NAME,
			visibility: "sealed",
			tasks: sealedHoldoutTasks(SEALED_INPUT),
		});

		builderMock = await startMockModel([
			{
				match: ({ firstUser, toolCount }) => firstUser.includes("инструмент для агента") && toolCount === 7,
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
									title: "Workshop answer agent",
									purpose: "Return the reviewed deterministic answer.",
									users: ["acceptance reviewer"],
									jobs: ["answer one request"],
									inputs: ["text request"],
									allowedActions: ["return text", "call a declared tool"],
									successCriteria: ["answer contains READY"],
									constraints: ["no network"],
									openQuestions: [],
								},
							});
						case 3:
							return call(step, "ahde_workbench_decide", {
								kind: "run-current",
								repetitions: 1,
								reason: "Start testing this agent",
							});
						case 4:
							return call(step, "ahde_workbench_submit", {
								kind: "corpus-draft",
								name: "Workshop development basket",
								tasks: [
									{ input: "Answer the first reviewed request.", graders: [{ type: "output_contains", text: "READY" }] },
									{ input: "Answer the second reviewed request.", graders: [{ type: "output_contains", text: "READY" }] },
								],
								coverageNotes: ["Two cases expose the same missing instruction."],
								revisionSummary: "Initial development basket",
							});
						case 5:
							return call(step, "ahde_workbench_decide", {
								kind: "run-current",
								repetitions: 1,
								reason: "Publish the reviewed basket and measure the baseline",
							});
						case 6:
							return call(step, "ahde_workbench_view", { aspect: "traces" });
						// The Builder gets hands only now, and only here.
						case 7:
							return call(step, "ahde_workbench_submit", { kind: "workshop-open" });
						case 8:
							return call(step, "ahde_workshop_read", { path: "AGENTS.md" });
						case 9:
							return call(step, "ahde_workshop_write", {
								path: "tools/ready_check/tool.yaml",
								content: READY_CHECK_DESCRIPTOR,
							});
						case 10:
							return call(step, "ahde_workshop_write", {
								path: "tools/ready_check/run",
								content: READY_CHECK_RUN_BROKEN,
							});
						case 11:
							return call(step, "ahde_workshop_write", {
								path: "tools/ready_check/contract.txt",
								content: "READY\n",
							});
						// Run the code before proposing it. It fails.
						case 12:
							return call(step, "ahde_workshop_try", { tool: "ready_check", input: { answer: "READY" } });
						case 13:
							return call(step, "ahde_workshop_write", {
								path: "tools/ready_check/run",
								oldText: "contract-typo.txt",
								newText: "prepared-contract.txt",
							});
						// Run it again. It works.
						case 14:
							return call(step, "ahde_workshop_try", { tool: "ready_check", input: { answer: "READY" } });
						case 15: {
							const current = String(parseToolResult(context, 8).content);
							return call(step, "ahde_workshop_write", {
								path: "AGENTS.md",
								content: `${current.trimEnd()}\n\n${READY_INSTRUCTION}\n`,
							});
						}
						case 16: {
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
							if (!mode) throw new Error("workshop baseline produced no proposal-eligible failure mode");
							return call(step, "ahde_workbench_submit", {
								kind: "workshop-close",
								source: {
									algorithmId: brief.algorithmId,
									evalRunId: brief.evalRunId,
									diagnosisId: brief.diagnosisId,
									briefId: brief.briefId,
								},
								failureModeIds: [mode.failureModeId],
								summary: "Make the reviewed answer explicit and give the Target a checker it can run.",
								risks: ["The answer contract is intentionally narrow."],
								validationPlan: ["Re-run the reviewed development basket and the sealed gate."],
							});
						}
						case 17:
							return call(step, "ahde_workbench_decide", {
								kind: "apply-proposal",
								runId: String(parseToolResult(context, 16).artifact.runId),
								branch: "candidate/workshop-loop",
								reason: "The exact diff is the code I ran in the workshop",
							});
						case 18:
							return call(step, "ahde_workbench_decide", {
								kind: "run-current",
								repetitions: SEALED_VERIFICATION_REPETITIONS,
								reason: "Run the exact development and sealed promotion gates",
							});
						case 19:
							return call(step, "ahde_workbench_decide", {
								kind: "ship",
								version: "0.1.0",
								reason: "Development improved and the sealed guardrail passed",
							});
						case 20: {
							const shipped = parseToolResult(context, 19);
							return { text: `Инструмент собран и выкачен: ${shipped.result.tag}.` };
						}
						default:
							throw new Error(`unexpected workshop Builder step ${step}`);
					}
				},
			},
			{ match: () => true, steps: [{ text: "BUILDER_WORKSHOP_CONTRACT_MISMATCH" }] },
		]);

		const registered: ToolDefinition[] = [];
		const extension = createAhdeBuilderExtension({
			projectDir,
			stateRoot,
			runsRoot,
			projectId: PROJECT_ID,
			templateDir: assets.targetTemplateDir,
			dependencies: { actorId: () => "local:workshop-operator" },
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
					kind: String(
						(parameters as { kind?: unknown }).kind ??
						(parameters as { aspect?: unknown }).aspect ??
						(parameters as { path?: unknown }).path ??
						(parameters as { tool?: unknown }).tool ??
						"summary",
					),
					details: JSON.parse(first.text) as Record<string, any>,
				});
				return result;
			},
		}));

		const builderModel = modelDefinition(
			"builder-workshop-loop",
			"builder-model",
			builderMock.url,
			"AHDE_WORKSHOP_BUILDER_KEY",
		);
		const agentDir = join(stateRoot, "workshop-agent-dir");
		const sessionDir = join(stateRoot, "workshop-session");
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
			"Собери инструмент для агента прямо в мастерской: напиши его, запусти, почини, " +
			"закрой мастерскую диффом, примени, проверь и выкати.",
		);

		expect(session.getLastAssistantText()).toContain("v0.1.0");

		// The workshop tried the tool twice: the first attempt genuinely failed.
		const tries = observed.filter((entry) => entry.name === "ahde_workshop_try");
		expect(tries).toHaveLength(2);
		expect(tries[0]?.details.exitCode).toBe(3);
		expect(tries[1]?.details.exitCode).toBe(0);
		expect(JSON.parse(String(tries[1]?.details.stdout))).toEqual({ ready: true });
		// The declared setup step ran once, in the same sandbox, in the tool home.
		expect(tries[1]?.details.setup?.ran).toBe(true);
		expect(tries[1]?.details.layout).toBe("directory");
		expect(tries[1]?.details.source.kind).toBe("workshop");

		// The proposal is the diff of exactly what it ran.
		const closed = observed.find((entry) => entry.kind === "workshop-close")!;
		expect(closed.details.artifact.changedPaths).toEqual([
			"modified AGENTS.md",
			"modified manifest.yaml",
			"added tools/ready_check/contract.txt",
			"added tools/ready_check/run",
			"added tools/ready_check/tool.yaml",
		]);
		expect(closed.details.view.stage).toBe("proposal-review");

		// Applied, verified and shipped through the unchanged downstream contract.
		const verified = observed.find((entry) => entry.details.result?.resolvedAs === "verify-candidate")!;
		expect(verified.details.result).toMatchObject({
			candidate: {
				status: "evaluated",
				development: { gate: { verdict: "improved" } },
				sealedHoldout: { executed: true, gatePassed: true, gate: { verdict: "pass" } },
			},
		});
		const shipped = observed.find((entry) => entry.kind === "ship")!;
		expect(shipped.details.result.tag).toBe("v0.1.0");
		const candidateSha = execFileSync("git", ["-C", projectDir, "rev-list", "-n", "1", "v0.1.0"], { encoding: "utf8" }).trim();
		expect(execFileSync("git", ["-C", projectDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(candidateSha);

		// The shipped Target really carries the tool the Builder wrote and ran.
		const shippedTarget = loadTarget(projectDir);
		expect(shippedTarget.tools.map((tool) => tool.descriptor.name).sort()).toEqual(["echo_json", "ready_check"]);
		expect(shippedTarget.tools.find((tool) => tool.descriptor.name === "ready_check")?.layout).toBe("directory");

		// The workshop died with its proposal: no worktree, no scratch, no dirt.
		expect(execFileSync("git", ["-C", projectDir, "worktree", "list"], { encoding: "utf8" }).trim().split("\n"))
			.toHaveLength(1);
		expect(execFileSync("git", ["-C", projectDir, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
		// Six questions: the two setup dialogs, two start-testing, the diff, the ship.
		expect(host.confirmations.map((entry) => entry.title)).toEqual([
			"Create exact Target harness",
			"Configure exact Target identity and model",
			"Start testing — approve the Spec",
			"Start testing — publish the eval basket, run 2 Target executions",
			"Apply exact Builder proposal",
			"Ship candidate as v0.1.0",
		]);
		// Nothing the sealed exam holds ever reached the model.
		const everythingTheModelSaw = JSON.stringify(observed);
		for (const secret of [SEALED_INPUT, SEALED_NAME, "holdout-1"]) {
			expect(everythingTheModelSaw).not.toContain(secret);
		}
		expect(existsSync(join(stateRoot, "target-adoptions"))).toBe(true);
	} finally {
		delete process.env[TARGET_CREDENTIAL_ENV];
		session?.dispose();
		await builderMock?.close();
		await targetMock.close();
		rmSync(projectDir, { recursive: true, force: true });
	}
}, 300_000);

/**
 * The construction path, end to end: the operator never runs a knowingly
 * unbuilt agent to failure before they are allowed to build its tools.
 *
 * Spec → construction workshop (write the tool, run it, watch it fail, fix it,
 * run it again) → close with no evidence behind it → apply → the first run →
 * ship → the baseline run on the shipped agent → diagnose → the improvement
 * workshop → close → apply → verify → ship.
 */
it("builds the first harness from the Spec, ships it, then improves it from its own diagnosis", async () => {
	const targetMock = await startMockModel([
		{ match: ({ system }) => system.includes(PLUS_INSTRUCTION), steps: [{ text: "READY PLUS" }] },
		{ match: ({ system }) => system.includes(READY_INSTRUCTION), steps: [{ text: "READY" }] },
		{ match: () => true, steps: [{ text: "pending" }] },
	]);
	const projectDir = mkdtempSync(join(tmpdir(), "ahde-builder-construction-loop-"));
	const stateRoot = join(projectDir, ".ahde");
	const runsRoot = join(projectDir, "runs");
	const assets = resolveBuilderAssets();
	process.env[TARGET_CREDENTIAL_ENV] = "target-fixture";
	let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
	let builderMock: Awaited<ReturnType<typeof startMockModel>> | undefined;
	try {
		createCorpus({
			stateRoot,
			projectId: PROJECT_ID,
			name: SEALED_NAME,
			visibility: "sealed",
			tasks: sealedHoldoutTasks(SEALED_INPUT),
		});

		builderMock = await startMockModel([
			{
				match: ({ firstUser, toolCount }) => firstUser.includes("агента по спецификации") && toolCount === 7,
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
									title: "Construction answer agent",
									purpose: "Return the reviewed deterministic answer.",
									users: ["acceptance reviewer"],
									jobs: ["answer one request"],
									inputs: ["text request"],
									allowedActions: ["return text", "call a declared tool"],
									successCriteria: ["answer contains READY", "answer contains PLUS"],
									constraints: ["no network"],
									openQuestions: [],
								},
							});
						case 3:
							return call(step, "ahde_workbench_decide", {
								kind: "run-current",
								repetitions: 1,
								reason: "Approve the Spec so the agent can be built against it",
							});
						case 4:
							return call(step, "ahde_workbench_submit", {
								kind: "corpus-draft",
								name: "Construction development basket",
								tasks: [
									{
										input: "Answer the first reviewed request.",
										graders: [
											{ type: "output_contains", text: "READY" },
											{ type: "output_contains", text: "PLUS" },
										],
									},
									{
										input: "Answer the second reviewed request.",
										graders: [
											{ type: "output_contains", text: "READY" },
											{ type: "output_contains", text: "PLUS" },
										],
									},
								],
								coverageNotes: ["Both cases ask for the same two-part contract."],
								revisionSummary: "Initial development basket",
							});
						case 5:
							// Publish, but do not run: the agent has not been built yet, and
							// nobody should have to watch it fail before building it.
							return call(step, "ahde_workbench_decide", {
								kind: "publish-corpus",
								reason: "Freeze the reviewed basket before building the harness",
							});
						// The construction workshop: bound to the Spec, not to a diagnosis.
						case 6:
							return call(step, "ahde_workbench_submit", { kind: "workshop-open" });
						case 7:
							return call(step, "ahde_workshop_read", { path: "AGENTS.md" });
						case 8:
							return call(step, "ahde_workshop_write", {
								path: "tools/ready_check/tool.yaml",
								content: READY_CHECK_DESCRIPTOR,
							});
						case 9:
							return call(step, "ahde_workshop_write", {
								path: "tools/ready_check/run",
								content: READY_CHECK_RUN_BROKEN,
							});
						case 10:
							return call(step, "ahde_workshop_write", {
								path: "tools/ready_check/contract.txt",
								content: "READY\n",
							});
						// Run the code before proposing it. It fails.
						case 11:
							return call(step, "ahde_workshop_try", { tool: "ready_check", input: { answer: "READY" } });
						case 12:
							return call(step, "ahde_workshop_write", {
								path: "tools/ready_check/run",
								oldText: "contract-typo.txt",
								newText: "prepared-contract.txt",
							});
						// Run it again. It works.
						case 13:
							return call(step, "ahde_workshop_try", { tool: "ready_check", input: { answer: "READY" } });
						case 14: {
							const current = String(parseToolResult(context, 7).content);
							return call(step, "ahde_workshop_write", {
								path: "AGENTS.md",
								content: `${current.trimEnd()}\n\n${READY_INSTRUCTION}\n`,
							});
						}
						// No source, no failure modes: there is no evaluation to cite yet.
						case 15:
							return call(step, "ahde_workbench_submit", {
								kind: "workshop-close",
								summary: "Build the first harness the Spec describes: the answer contract and a checker for it.",
								risks: ["Nothing has been measured yet; this is the first build."],
								validationPlan: ["Run the reviewed development basket and the sealed gate."],
							});
						case 16:
							return call(step, "ahde_workbench_decide", {
								kind: "apply-proposal",
								runId: String(parseToolResult(context, 15).artifact.runId),
								branch: "candidate/construction-loop",
								reason: "The exact diff is the code I ran in the workshop",
							});
						case 17:
							return call(step, "ahde_workbench_decide", {
								kind: "run-current",
								repetitions: SEALED_VERIFICATION_REPETITIONS,
								reason: "Measure the built harness against the unbuilt baseline",
							});
						case 18:
							return call(step, "ahde_workbench_decide", {
								kind: "ship",
								version: "0.1.0",
								reason: "The built harness improved on the basket and passed the sealed gate",
							});
						// The shipped agent is now the Target. This is its baseline run.
						case 19:
							return call(step, "ahde_workbench_decide", {
								kind: "run-current",
								repetitions: 1,
								reason: "Measure the shipped agent on the reviewed basket",
							});
						case 20:
							return call(step, "ahde_workbench_view", { aspect: "traces" });
						// And now the ordinary improvement workshop, bound to that diagnosis.
						case 21:
							return call(step, "ahde_workbench_submit", { kind: "workshop-open" });
						case 22:
							return call(step, "ahde_workshop_read", { path: "AGENTS.md" });
						case 23: {
							const current = String(parseToolResult(context, 22).content);
							return call(step, "ahde_workshop_write", {
								path: "AGENTS.md",
								content: `${current.trimEnd()}\n\n${PLUS_INSTRUCTION}\n`,
							});
						}
						case 24: {
							const brief = parseToolResult(context, 20).detail.content.improvementBrief as {
								algorithmId: string;
								evalRunId: string;
								diagnosisId: string;
								briefId: string;
								modes: { failureModeId: string; decision: string; selectableForProposal: boolean }[];
							};
							const mode = brief.modes.find((candidate) =>
								candidate.decision === "propose-harness-change" && candidate.selectableForProposal
							);
							if (!mode) throw new Error("the shipped harness produced no proposal-eligible failure mode");
							return call(step, "ahde_workbench_submit", {
								kind: "workshop-close",
								source: {
									algorithmId: brief.algorithmId,
									evalRunId: brief.evalRunId,
									diagnosisId: brief.diagnosisId,
									briefId: brief.briefId,
								},
								failureModeIds: [mode.failureModeId],
								summary: "Answer the second half of the contract the basket asks for.",
								risks: ["The answer contract is intentionally narrow."],
								validationPlan: ["Re-run the reviewed development basket and the sealed gate."],
							});
						}
						case 25:
							return call(step, "ahde_workbench_decide", {
								kind: "apply-proposal",
								runId: String(parseToolResult(context, 24).artifact.runId),
								branch: "candidate/construction-improve",
								reason: "The exact diff is the code I ran in the workshop",
							});
						case 26:
							return call(step, "ahde_workbench_decide", {
								kind: "run-current",
								repetitions: SEALED_VERIFICATION_REPETITIONS,
								reason: "Run the exact development and sealed promotion gates",
							});
						case 27:
							return call(step, "ahde_workbench_decide", {
								kind: "ship",
								version: "0.2.0",
								reason: "Development improved and the sealed guardrail passed",
							});
						case 28: {
							const shipped = parseToolResult(context, 27);
							return { text: `Агент собран и улучшен: ${shipped.result.tag}.` };
						}
						default:
							throw new Error(`unexpected construction Builder step ${step}`);
					}
				},
			},
			{ match: () => true, steps: [{ text: "BUILDER_CONSTRUCTION_CONTRACT_MISMATCH" }] },
		]);

		const registered: ToolDefinition[] = [];
		const extension = createAhdeBuilderExtension({
			projectDir,
			stateRoot,
			runsRoot,
			projectId: PROJECT_ID,
			templateDir: assets.targetTemplateDir,
			dependencies: { actorId: () => "local:construction-operator" },
		});
		await extension({
			registerTool: (tool: ToolDefinition) => registered.push(tool),
			registerCommand: () => undefined,
			on: () => undefined,
		} as never);

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
					kind: String(
						(parameters as { kind?: unknown }).kind ??
						(parameters as { aspect?: unknown }).aspect ??
						(parameters as { path?: unknown }).path ??
						(parameters as { tool?: unknown }).tool ??
						"summary",
					),
					details: JSON.parse(first.text) as Record<string, any>,
				});
				return result;
			},
		}));

		const builderModel = modelDefinition(
			"builder-construction-loop",
			"builder-model",
			builderMock.url,
			"AHDE_CONSTRUCTION_BUILDER_KEY",
		);
		const agentDir = join(stateRoot, "construction-agent-dir");
		const sessionDir = join(stateRoot, "construction-session");
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
			"Собери агента по спецификации: напиши инструмент в мастерской, запусти, почини, " +
			"закрой мастерскую диффом, примени, выкати, потом измерь и улучши.",
		);

		expect(session.getLastAssistantText()).toContain("v0.2.0");

		// The construction workshop opened on the Spec, before any evaluation.
		const opens = observed.filter((entry) => entry.kind === "workshop-open");
		expect(opens).toHaveLength(2);
		expect(opens[0]?.details.artifact.basis).toBe("construction");
		expect(opens[0]?.details.view.stage).toBe("ready-to-evaluate");
		expect(opens[1]?.details.artifact.basis).toBe("improvement");
		expect(opens[1]?.details.view.stage).toBe("improvement-authoring");

		// It tried the tool twice; the first attempt genuinely failed.
		const tries = observed.filter((entry) => entry.name === "ahde_workshop_try");
		expect(tries).toHaveLength(2);
		expect(tries[0]?.details.exitCode).toBe(3);
		expect(tries[1]?.details.exitCode).toBe(0);
		expect(tries[1]?.details.source.kind).toBe("workshop");

		// The construction proposal cites no evidence, and says so.
		const closes = observed.filter((entry) => entry.kind === "workshop-close");
		expect(closes).toHaveLength(2);
		expect(closes[0]?.details.artifact.basis).toBe("construction");
		expect(closes[0]?.details.artifact.sourceEvalRunId).toBeNull();
		expect(closes[0]?.details.artifact.failureModeIds).toEqual([]);
		expect(closes[0]?.details.artifact.changedPaths).toEqual([
			"modified AGENTS.md",
			"modified manifest.yaml",
			"added tools/ready_check/contract.txt",
			"added tools/ready_check/run",
			"added tools/ready_check/tool.yaml",
		]);
		// …and it still went through the ordinary recording contract.
		const constructionRun = loadBuilderProposalRun(runsRoot, String(closes[0]?.details.artifact.runId));
		expect(constructionRun.request.source).toBeNull();
		const admitted = listBuilderProposalAdmissions(stateRoot, PROJECT_ID)
			.find((entry) => entry.runId === constructionRun.runId);
		expect(admitted?.proposalSha256).toBe(constructionRun.artifacts.proposal?.sha256);

		// The improvement proposal does cite exactly one.
		expect(closes[1]?.details.artifact.basis).toBe("improvement");
		expect(closes[1]?.details.artifact.sourceEvalRunId).not.toBeNull();
		expect(closes[1]?.details.artifact.failureModeIds).toHaveLength(1);

		// Both candidates were verified on both surfaces and shipped.
		const verified = observed.filter((entry) => entry.details.result?.resolvedAs === "verify-candidate");
		expect(verified).toHaveLength(2);
		for (const entry of verified) {
			expect(entry.details.result).toMatchObject({
				candidate: {
					status: "evaluated",
					development: { gate: { verdict: "improved" } },
					sealedHoldout: { executed: true, gatePassed: true, gate: { verdict: "pass" } },
				},
			});
		}
		const shipped = observed.filter((entry) => entry.kind === "ship");
		expect(shipped.map((entry) => entry.details.result.tag)).toEqual(["v0.1.0", "v0.2.0"]);

		// The shipped Target carries the tool written in the construction workshop.
		const shippedTarget = loadTarget(projectDir);
		expect(shippedTarget.tools.map((tool) => tool.descriptor.name).sort()).toEqual(["echo_json", "ready_check"]);
		expect(shippedTarget.tools.find((tool) => tool.descriptor.name === "ready_check")?.layout).toBe("directory");
		expect(readFileSync(join(projectDir, "AGENTS.md"), "utf8")).toContain(PLUS_INSTRUCTION);

		// No workshop outlived its proposal.
		expect(execFileSync("git", ["-C", projectDir, "worktree", "list"], { encoding: "utf8" }).trim().split("\n"))
			.toHaveLength(1);
		expect(execFileSync("git", ["-C", projectDir, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
		// Nothing the sealed exam holds ever reached the model.
		const everythingTheModelSaw = JSON.stringify(observed);
		for (const secret of [SEALED_INPUT, SEALED_NAME, "holdout-1"]) {
			expect(everythingTheModelSaw).not.toContain(secret);
		}
	} finally {
		delete process.env[TARGET_CREDENTIAL_ENV];
		session?.dispose();
		await builderMock?.close();
		await targetMock.close();
		rmSync(projectDir, { recursive: true, force: true });
	}
}, 600_000);
