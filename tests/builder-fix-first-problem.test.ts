import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import {
	AHDE_BUILDER_TOOL_NAMES,
	createAhdeBuilderExtension,
} from "../src/builder/extension.js";
import { AhdeWorkbench } from "../src/workbench/workbench.js";

const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function jsonResult(result: Awaited<ReturnType<ToolDefinition["execute"]>>): Record<string, unknown> {
	const content = result.content[0];
	if (!content || content.type !== "text") throw new Error("expected a text tool result");
	return JSON.parse(content.text) as Record<string, unknown>;
}

async function execute(
	tool: ToolDefinition,
	callId: string,
	parameters: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	expect(Check(tool.parameters, parameters)).toBe(true);
	return jsonResult(await tool.execute(
		callId,
		parameters,
		undefined,
		undefined,
		{} as ExtensionContext,
	));
}

it("resolves 'fix the first problem' through fresh traces and review without applying", async () => {
	const projectDir = mkdtempSync(join(tmpdir(), "ahde-fix-first-problem-"));
	roots.push(projectDir);

	const firstFailureModeId = `failure-mode-${"1".repeat(24)}`;
	const secondFailureModeId = `failure-mode-${"2".repeat(24)}`;
	const source = {
		algorithmId: "exact-eval-signals-v1",
		evalRunId: "erun-current",
		diagnosisId: "diagnosis-current",
		briefId: `brief-${"a".repeat(24)}`,
	} as const;
	const baseView = {
		schemaVersion: 1,
		project: { id: "demo", directory: projectDir },
		target: { status: "ready", id: "demo", gitSha: "a".repeat(40) },
		focus: {},
		selections: [],
		blockers: [],
		warnings: [],
		counts: {
			specDrafts: 0,
			approvedSpecs: 1,
			corpusDrafts: 0,
			developmentCorpora: 1,
			sealedCorpora: 0,
			developmentEvals: 1,
			openProposals: 0,
			candidates: 0,
		},
	} as const;
	const tracesView = {
		...baseView,
		stage: "improvement-authoring",
		headline: "1/3 passed. Two exact failure modes found.",
		actions: ["traces", "submit structured-proposal"],
		detail: {
			aspect: "traces",
			content: {
				improvementBrief: {
					schemaVersion: 1,
					...source,
					status: "actionable",
					proposalEligible: true,
					headline: "1/3 passed. Two exact failure modes found.",
					summary: {
						tasks: 3,
						failedTasks: 2,
						infrastructureErrors: 0,
						failureModeCount: 2,
						systemicFailureModeCount: 1,
						taskLocalFailureModeCount: 1,
						omittedFailureModeCount: 0,
					},
					modes: [
						{
							ordinal: 1,
							failureModeId: firstFailureModeId,
							decision: "propose-harness-change",
							selectableForProposal: true,
							title: "Missing evidence lookup instruction",
						},
						{
							ordinal: 2,
							failureModeId: secondFailureModeId,
							decision: "stabilize-and-rerun",
							selectableForProposal: false,
							title: "Unstable output",
						},
					],
				},
			},
		},
	} as const;
	const reviewView = {
		...baseView,
		stage: "proposal-review",
		headline: "Review the exact evidence-linked proposal.",
		actions: ["review", "apply", "discard"],
		detail: {
			aspect: "review",
			content: {
				kind: "proposal",
				runId: "builder-proposal-1",
				evidenceBasis: { ...source, failureModeIds: [firstFailureModeId] },
			},
		},
	} as const;
	const targetOverview = {
		...baseView,
		stage: "improvement-authoring",
		headline: "Inspect the exact Target before authoring.",
		actions: ["traces", "submit structured-proposal"],
		detail: {
			aspect: "target",
			content: {
				algorithmId: "git-manifest-context-v1",
				contextHash: `sha256:${"3".repeat(64)}`,
				claim: {
					algorithmId: "git-manifest-context-v1",
					targetId: "demo",
					targetGitSha: "a".repeat(40),
					contextHash: `sha256:${"3".repeat(64)}`,
				},
				target: { id: "demo", gitSha: "a".repeat(40) },
				resources: [{
					kind: "instructions",
					name: null,
					path: "AGENTS.md",
					mode: "100644",
					bytes: 24,
					sha256: `sha256:${"4".repeat(64)}`,
				}],
				launch: "ahde target",
			},
		},
	} as const;
	const targetResource = {
		...targetOverview,
		detail: {
			...targetOverview.detail,
			content: {
				...targetOverview.detail.content,
				resource: {
					...targetOverview.detail.content.resources[0],
					content: "# Existing instructions\n",
				},
			},
		},
	} as const;

	const calls: string[] = [];
	const view = vi.spyOn(AhdeWorkbench.prototype, "view").mockImplementation(async (query = {}) => {
		calls.push(`view:${query.aspect ?? "summary"}${query.resourcePath ? `:${query.resourcePath}` : ""}`);
		if (query.aspect === "traces") return tracesView as never;
		if (query.aspect === "target" && query.resourcePath === "AGENTS.md") return targetResource as never;
		if (query.aspect === "target") return targetOverview as never;
		if (query.aspect === "review") return reviewView as never;
		throw new Error(`unexpected view aspect: ${query.aspect ?? "summary"}`);
	});
	const submit = vi.spyOn(AhdeWorkbench.prototype, "submit").mockImplementation(async (input) => {
		calls.push(`submit:${input.kind}`);
		return {
			kind: "structured-proposal",
			message: "Selected failure mode compiled into an exact reviewable proposal.",
			artifact: {
				runId: "builder-proposal-1",
				improvementBriefId: source.briefId,
				failureModeIds: [firstFailureModeId],
			},
			view: reviewView,
		} as never;
	});
	const decide = vi.spyOn(AhdeWorkbench.prototype, "decide").mockImplementation(async () => {
		calls.push("decide");
		throw new Error("fix must not imply a decision");
	});

	const registered: ToolDefinition[] = [];
	const extension = createAhdeBuilderExtension({
		projectDir,
		stateRoot: join(projectDir, ".ahde"),
		runsRoot: join(projectDir, "runs"),
		projectId: "demo",
	});
	await extension({
		registerTool: (tool: ToolDefinition) => registered.push(tool),
		registerCommand: vi.fn(),
		on: vi.fn(),
	} as never);
	expect(registered.map((tool) => tool.name)).toEqual(AHDE_BUILDER_TOOL_NAMES);

	const viewTool = registered.find((tool) => tool.name === "ahde_workbench_view")!;
	const submitTool = registered.find((tool) => tool.name === "ahde_workbench_submit")!;
	const traceResult = await execute(viewTool, "view-traces", { aspect: "traces" });
	const brief = ((traceResult.detail as Record<string, unknown>).content as {
		improvementBrief: {
			algorithmId: string;
			evalRunId: string;
			diagnosisId: string;
			briefId: string;
			modes: { ordinal: number; failureModeId: string }[];
		};
	}).improvementBrief;
	const first = brief.modes.find((mode) => mode.ordinal === 1);
	if (!first) throw new Error("current trace projection has no first failure mode");
	const target = await execute(viewTool, "view-target", { aspect: "target" });
	const targetResources = (((target.detail as Record<string, unknown>).content as {
		resources: { path: string }[];
	}).resources);
	expect(targetResources.map((resource) => resource.path)).toContain("AGENTS.md");
	const instructionsView = await execute(viewTool, "view-target-agents", {
		aspect: "target",
		resourcePath: "AGENTS.md",
	});
	const currentInstructions = (((instructionsView.detail as Record<string, unknown>).content as {
		resource: { content: string };
	}).resource.content);
	const proposalInput = {
		kind: "structured-proposal",
		authoringContext: targetOverview.detail.content.claim,
		source: {
			algorithmId: brief.algorithmId,
			evalRunId: brief.evalRunId,
			diagnosisId: brief.diagnosisId,
			briefId: brief.briefId,
		},
		failureModeIds: [first.failureModeId],
		summary: "Address the first verified failure mode with a focused instruction.",
		intents: [{
			type: "instructions.replace",
			content: `${currentInstructions.trimEnd()}\n\nUse the approved local evidence before answering.\n`,
		}],
		risks: ["The instruction may be too strict for unrelated tasks."],
		validationPlan: ["Re-run the reviewed development corpus."],
	};
	await execute(submitTool, "submit-proposal", proposalInput);
	await execute(viewTool, "view-review", { aspect: "review" });

	expect(submit).toHaveBeenCalledWith(proposalInput, expect.objectContaining({ signal: undefined }));
	expect(calls).toEqual([
		"view:traces",
		"view:target",
		"view:target:AGENTS.md",
		"submit:structured-proposal",
		// The product shell re-reads the summary to refresh the header after authoring.
		"view:summary",
		"view:review",
	]);
	expect(view).toHaveBeenCalledTimes(5);
	expect(decide).not.toHaveBeenCalled();
});
