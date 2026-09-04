import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Context, ToolCall } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createPiImprovementAuthor,
	IMPROVEMENT_AUTHOR_LIMITS,
	ImprovementAuthorReceiptSchema,
} from "../src/application/improvement-author.js";
import {
	compileImprovementBrief,
	deriveEvidenceLinkedProposalSelection,
} from "../src/application/improvement-brief.js";
import type { ImprovementProposalRequest } from "../src/application/improvement-loop.js";
import { loadCandidateRecord } from "../src/application/candidate-review.js";
import { diagnoseEvalRun } from "../src/diagnosis.js";
import { loadEvalRun } from "../src/eval.js";
import { createAhdeWorkbench } from "../src/workbench/index.js";
import { createAhdeBuilderExtension } from "../src/builder/extension.js";
import { renderDecision } from "../src/builder/render/decision.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { createHostContext, hostCatalogModel } from "./helpers/builder-tools.js";
import {
	approvingGate,
	BASELINE_INSTRUCTION,
	git,
	improveFixture,
	NO_OP_INSTRUCTION,
	READY_INSTRUCTION,
	SEALED_INPUT,
	type ImproveFixture,
} from "./helpers/improve-fixtures.js";

const model = hostCatalogModel("fixture-author", "fixture-model", "http://127.0.0.1:1/v1");
function call(name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id: `call-${name}`, name, arguments: args };
}
function reply(...content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 30,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 40,
			cost: {
				input: 0.002,
				output: 0.001,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0.003,
			},
		},
		stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}
function steps(instruction = READY_INSTRUCTION, summary = "Clarify the answer contract"): AssistantMessage[] {
	return [
		reply(call("workshop_read", { path: "AGENTS.md" })),
		reply(
			call("workshop_write", {
				path: "AGENTS.md",
				content: `# Improve fixture\n\n${instruction}\n`,
			}),
		),
		reply(
			call("finish_proposal", {
				decision: "propose",
				summary,
				validationPlan: ["Measure the reviewed development corpus"],
			}),
		),
	];
}
function scripted(messages: AssistantMessage[]) {
	return vi.fn(async (_context: Context) => messages.shift() ?? reply({ type: "text", text: "Finished" }));
}

describe("bounded Pi improvement author", () => {
	let fixture: ImproveFixture;
	let request: ImprovementProposalRequest;
	beforeAll(async () => {
		fixture = await improveFixture();
		const diagnosis = diagnoseEvalRun(fixture.runsRoot, fixture.evalRunId);
		const brief = compileImprovementBrief(fixture.runsRoot, diagnosis);
		const mode = brief.modes.find((item) => item.decision === "propose-harness-change")!;
		const evaluation = loadEvalRun(fixture.runsRoot, fixture.evalRunId);
		request = {
			cycle: 1,
			variant: 1,
			variants: 2,
			repositoryDir: fixture.projectDir,
			runsRoot: fixture.runsRoot,
			stateRoot: fixture.stateRoot,
			projectId: fixture.projectId,
			approvedSpecId: fixture.approvedSpecId,
			baseTargetSha: fixture.baselineSha,
			evalRunId: fixture.evalRunId,
			diagnosisId: diagnosis.diagnosisId,
			brief,
			failureMode: mode,
			failureBundlePath: "not-a-readable-model-tool",
			surface: {
				targetId: fixture.projectId,
				targetGitSha: fixture.baselineSha,
				dataset: evaluation.dataset,
				datasetHash: evaluation.datasetHash,
				suiteHash: evaluation.suiteHash,
			},
			selection: deriveEvidenceLinkedProposalSelection(brief, {
				algorithmId: brief.algorithmId,
				evalRunId: brief.evalRunId,
				diagnosisId: brief.diagnosisId,
				briefId: brief.briefId,
				failureModeIds: [mode.failureModeId],
			}),
		};
	});
	afterAll(async () => {
		await fixture?.close();
	});
	const receipt = (receiptId: string) =>
		ImprovementAuthorReceiptSchema.parse(
			JSON.parse(readFileSync(join(fixture.runsRoot, "improvement-authors", `${receiptId}.json`), "utf8")),
		);

	it("runs the real Pi tool loop and compiles a scoped proposal without editing the checkout", async () => {
		const complete = scripted(steps());
		const prepared = createPiImprovementAuthor({ model, complete });
		const result = await prepared.author(request);
		expect(result.kind).toBe("propose");
		if (result.kind !== "propose") throw new Error(JSON.stringify(result));
		expect(result.proposal.changes.map((item) => item.path)).toEqual(["AGENTS.md"]);
		expect(result.proposal.changes[0]!.unifiedDiff).toContain(READY_INSTRUCTION);
		expect(result.authoring).toMatchObject({ requests: 3, tokens: 120 });
		expect(result.authoring!.costUsd).toBeCloseTo(0.009);
		expect(receipt(result.authoring!.receiptId)).toMatchObject({
			status: "proposed",
			requests: 3,
			proposalHash: expect.stringMatching(/^sha256:/),
		});
		expect(
			statSync(join(fixture.runsRoot, "improvement-authors", `${result.authoring!.receiptId}.json`)).mode & 0o777,
		).toBe(0o600);
		expect(readFileSync(join(fixture.projectDir, "AGENTS.md"), "utf8")).toContain(BASELINE_INSTRUCTION);
		expect(git(fixture.projectDir, "status", "--porcelain")).toBe("");
		const contexts = JSON.stringify(complete.mock.calls);
		expect(contexts).not.toContain(SEALED_INPUT);
		expect(contexts).not.toContain(fixture.sealedCorpusId);
		expect(contexts).not.toContain("AHDE_IMPROVE_FIXTURE_KEY");
		expect(complete.mock.calls[0]![0].tools!.map((tool) => tool.name)).toEqual([
			"workshop_read",
			"workshop_write",
			"workshop_test",
			"finish_proposal",
		]);
		expect(prepared.disclosure).toContain("shown separately inside the total confirmation");
	});

	it("exposes a conservative priced ceiling for one authored variant", () => {
		const priced = {
			...model,
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
		};
		const budget = createPiImprovementAuthor({ model: priced, complete: scripted([]) }).budget!;
		expect(budget).toMatchObject({
			maxRequestsPerVariant: 8,
			maxInputTokensPerRequest: 102_400,
			maxOutputTokensPerRequest: 2_048,
			maxMinutesPerVariant: 2,
		});
		expect(budget.maxCostUsdPerVariant).toBeCloseTo(1.261568, 12);
	});

	it("refuses private/undeclared reads, unread writes and fake release tools", async () => {
		const complete = scripted([
			reply(
				call("workshop_read", { path: ".env" }),
				call("workshop_read", { path: "../AGENTS.md" }),
				call("workshop_read", { path: "evals" }),
				call("workshop_write", {
					path: "AGENTS.md",
					content: "unread overwrite",
				}),
				call("ship", {}),
			),
			reply({ type: "text", text: "No safe change" }),
		]);
		const result = await createPiImprovementAuthor({ model, complete }).author(request);
		expect(result.kind).toBe("no-change");
		const errors = complete.mock.calls[1]![0].messages.filter((item) => item.role === "toolResult");
		expect(errors).toHaveLength(5);
		expect(errors.every((item) => item.role === "toolResult" && item.isError)).toBe(true);
		expect(readFileSync(join(fixture.projectDir, "AGENTS.md"), "utf8")).toContain(BASELINE_INSTRUCTION);
	});

	it("does not execute a write appended after finish in the same model response", async () => {
		const messages = steps();
		messages[2]!.content.push(call("workshop_write", { path: "AGENTS.md", content: "late overwrite" }));
		const result = await createPiImprovementAuthor({
			model,
			complete: scripted(messages),
		}).author(request);
		expect(result.kind).toBe("propose");
		if (result.kind === "propose") expect(result.proposal.changes[0]!.unifiedDiff).not.toContain("late overwrite");
	});

	it("rejects duplicate variants even when the summary changes", async () => {
		const complete = scripted([...steps(), ...steps(READY_INSTRUCTION, "A completely different label")]);
		const prepared = createPiImprovementAuthor({ model, complete });
		expect((await prepared.author(request)).kind).toBe("propose");
		expect((await prepared.author({ ...request, variant: 2 })).kind).toBe("no-change");
		expect(JSON.stringify(complete.mock.calls.at(-1))).toContain("repeats an earlier variant");
		expect(JSON.stringify(complete.mock.calls[3])).toContain("Clarify the answer contract");
	});

	it("caps model turns and never interprets ordinary text as a proposal", async () => {
		const complete = vi.fn(async () => reply(call("workshop_read", { path: "AGENTS.md" })));
		const result = await createPiImprovementAuthor({ model, complete }).author(request);
		expect(complete).toHaveBeenCalledTimes(IMPROVEMENT_AUTHOR_LIMITS.turns);
		expect(result.kind).toBe("no-change");
		expect(result.authoring?.requests).toBe(IMPROVEMENT_AUTHOR_LIMITS.turns);
	});

	it("refuses an oversized evidence context before sending a paid request", async () => {
		const complete = scripted(steps());
		const result = await createPiImprovementAuthor({ model, complete }).author({
			...request,
			failureMode: { ...request.failureMode, summary: "x".repeat(IMPROVEMENT_AUTHOR_LIMITS.contextBytes) },
		});
		expect(result.kind).toBe("no-change");
		expect(complete).not.toHaveBeenCalled();
	});

	it("refuses expanded tool filesystem permissions before testing or compiling", async () => {
		const complete = scripted([
			reply(call("workshop_read", { path: "tools/echo_json.tool.yaml" })),
			reply(
				call("workshop_write", {
					path: "tools/echo_json.tool.yaml",
					oldText: "filesystem: read-only",
					newText: "filesystem: workspace-write",
				}),
			),
			reply(call("workshop_test", { tool: "echo_json" })),
			steps()[2]!,
			reply({ type: "text", text: "Human review needed" }),
		]);
		const result = await createPiImprovementAuthor({ model, complete }).author(request);
		expect(result.kind).toBe("no-change");
		expect(JSON.stringify(complete.mock.calls.at(-1))).toContain("expands capabilities");
	});

	it("refuses changed tools with no passing fixtures", async () => {
		const complete = scripted([
			reply(call("workshop_read", { path: "tools/echo_json.tool.yaml" })),
			reply(
				call("workshop_write", {
					path: "tools/echo_json.tool.yaml",
					oldText: "Return the provided message",
					newText: "Echo the provided message",
				}),
			),
			steps()[2]!,
			reply({ type: "text", text: "Fixtures needed" }),
		]);
		const result = await createPiImprovementAuthor({ model, complete }).author(request);
		expect(result.kind).toBe("no-change");
		expect(JSON.stringify(complete.mock.calls.at(-1))).toContain("passing contract fixtures");
	});

	it("accounts for failed provider responses without recording raw provider error bodies", async () => {
		const failed = reply();
		failed.stopReason = "error";
		failed.errorMessage = "private-provider-response-secret";
		const result = await createPiImprovementAuthor({
			model,
			complete: scripted([failed]),
		}).author(request);
		expect(result.authoring).toMatchObject({ requests: 1, costUsd: null });
		expect(receipt(result.authoring!.receiptId).status).toBe("failed");
		expect(JSON.stringify(result)).not.toContain("private-provider-response-secret");
	});

	it("cancels a provider that ignores AbortSignal and leaves a durable unknown-cost receipt", async () => {
		const controller = new AbortController();
		let release!: (message: AssistantMessage) => void;
		const complete = vi.fn(async () => {
			queueMicrotask(() => controller.abort(new Error("operator cancelled")));
			return new Promise<AssistantMessage>((resolve) => {
				release = resolve;
			});
		});
		const previous = new Set(readdirSync(join(fixture.runsRoot, "improvement-authors")));
		await expect(
			createPiImprovementAuthor({ model, complete }).author({
				...request,
				signal: controller.signal,
			}),
		).rejects.toThrow("operator cancelled");
		const name = readdirSync(join(fixture.runsRoot, "improvement-authors")).find((item) => !previous.has(item))!;
		const path = join(fixture.runsRoot, "improvement-authors", name);
		const bytes = readFileSync(path, "utf8");
		expect(JSON.parse(bytes)).toMatchObject({
			status: "cancelled",
			requests: 1,
			costUsd: null,
		});
		release(reply({ type: "text", text: "late bill" }));
		await new Promise((resolve) => setImmediate(resolve));
		expect(readFileSync(path, "utf8")).toBe(bytes);
	});

	it("does not invoke the prepared author until the host approves", async () => {
		const complete = scripted(steps());
		const prepared = createPiImprovementAuthor({ model, complete });
		const workbench = createAhdeWorkbench({
			...fixture,
			dependencies: { prepareImprovementAuthor: () => prepared },
		});
		const gate = approvingGate();
		gate.confirm.mockResolvedValue({ approved: false, actorId: "local:test" });
		await expect(
			workbench.decide(
				{
					kind: "improve",
					until: 1,
					maxCycles: 1,
					repetitions: 3,
					reason: "Try variants",
				},
				gate,
			),
		).rejects.toThrow();
		expect(complete).not.toHaveBeenCalled();
		const confirmation = gate.confirm.mock.calls[0]![0];
		expect(confirmation.question).toContain(prepared.disclosure);
		expect(confirmation.question).toContain("at most 8 model requests across 1 variant");
		expect(confirmation.subject).toMatchObject({
			authoringBudget: {
				maxVariants: 1,
				maxRequests: 8,
				maxOutputTokens: 16_384,
				maxCostUsd: 0,
				maxMinutes: 2,
			},
		});
	});

	it("the production extension freezes the selected Pi model before its host dialog", async () => {
		const tools: ToolDefinition[] = [];
		const handlers = new Map<string, (...args: never[]) => unknown>();
		await createAhdeBuilderExtension(fixture)({
			registerTool: (tool: ToolDefinition) => tools.push(tool),
			registerCommand: () => undefined,
			on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
		} as never);
		const host = createHostContext();
		const complete = vi.fn(async () => reply({ type: "text", text: "No safe hypothesis" }));
		host.ctx.model = model;
		host.ctx.modelRegistry = { complete } as never;
		host.ctx.ui.confirm = async () => {
			host.ctx.model = { ...model, id: "a-later-model" };
			await handlers.get("model_select")?.({ type: "model_select" } as never, host.ctx as never);
			return true;
		};
		await handlers.get("tool_call")?.({ toolName: "ahde_workbench_decide" } as never, host.ctx as never);
		const decision = tools.find((tool) => tool.name === "ahde_workbench_decide")!;
		await decision.execute(
			"improve",
			{ kind: "improve", until: 1, maxCycles: 1, repetitions: 3, reason: "Try a hypothesis" } as never,
			undefined,
			undefined,
			host.ctx,
		);
		expect(complete).toHaveBeenCalledOnce();
		expect((complete.mock.calls[0] as unknown[])[0]).toBe(model);
	});

	it("authors two hypotheses, compares them through the real Workbench, and never runs sealed or ships", async () => {
		const searchFixture = await improveFixture({}, { developmentCases: 4 });
		try {
			const complete = scripted([...steps(NO_OP_INSTRUCTION, "Polite clarification"), ...steps()]);
			const prepared = createPiImprovementAuthor({ model, complete });
			const workbench = createAhdeWorkbench({
				...searchFixture,
				dependencies: { prepareImprovementAuthor: () => prepared },
			});
			const gate = approvingGate();
			const result = await workbench.decide(
			{
				kind: "improve",
				until: 1,
				maxCycles: 1,
				candidates: 2,
				repetitions: 3,
				reason: "Compare two hypotheses",
			},
			gate,
			);
			expect(gate.confirm).toHaveBeenCalledOnce();
			expect(gate.selectSealed).not.toHaveBeenCalled();
			expect(complete).toHaveBeenCalledTimes(6);
			expect(result.result.cycles[0]!.authoring).toHaveLength(2);
			expect(result.result.search?.rows).toHaveLength(2);
			expect(result.result.table).toContain("Builder author: 2 attempts, 6 requests");
			const terminal = renderDecision(result, plainPaint).join("\n");
			expect(terminal).toContain("Builder author: 2 attempts, 6 requests");
			expect(terminal).toContain("AHDE search candidate 1");
			expect(terminal).toContain("AHDE search candidate 2");
			expect(result.result.table).not.toContain("does not write them");
			expect(result.result.search!.frontier.length).toBeGreaterThan(0);
			for (const row of result.result.search!.rows) {
				if (!row.candidateId) continue;
				const record = loadCandidateRecord(searchFixture.runsRoot, row.candidateId);
				expect(record.events.some((event) => event.type === "promoted" || event.type === "reviewed")).toBe(false);
				const evaluated = record.events.find((event) => event.type === "evaluated");
				expect(evaluated?.type === "evaluated" && evaluated.evaluation.sealedHoldout).toBeUndefined();
			}
			expect(JSON.stringify(complete.mock.calls)).not.toContain(SEALED_INPUT);
			expect(git(searchFixture.projectDir, "rev-parse", "HEAD")).toBe(searchFixture.baselineSha);
			expect(git(searchFixture.projectDir, "status", "--porcelain")).toBe("");
		} finally {
			await searchFixture.close();
		}
	});
});
