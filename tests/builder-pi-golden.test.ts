import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { createAhdeBuilderCompatibilityTools as createAhdeBuilderTools } from "../src/builder/extension.js";
import { createCorpus } from "../src/corpus.js";
import { diagnoseEvalRun } from "../src/diagnosis.js";
import {
	compileImprovementBrief,
	deriveEvidenceLinkedProposalSelection,
} from "../src/application/improvement-brief.js";
import { startMockModel } from "../src/mock-model.js";

function action(tools: readonly ToolDefinition[], name: string): ToolDefinition {
	const found = tools.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`missing Builder tool ${name}`);
	return found;
}

function hostContext(): ExtensionContext {
	return {
		hasUI: true,
		mode: "tui",
		ui: {
			confirm: vi.fn(async () => true),
			select: vi.fn(async () => undefined),
			notify: vi.fn(),
		},
	} as unknown as ExtensionContext;
}

async function invoke(
	tools: readonly ToolDefinition[],
	name: string,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const result = await action(tools, name).execute(name, params, undefined, undefined, hostContext());
	const first = result.content[0];
	if (!first || first.type !== "text") throw new Error(`tool ${name} returned no text`);
	return JSON.parse(first.text) as Record<string, unknown>;
}

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

it("drives the complete canonical Builder tool loop without revealing sealed content", async () => {
	const mock = await startMockModel([
		{
			match: ({ system }) => system.includes("Return the exact uppercase word READY."),
			steps: [{ text: "READY" }],
		},
		{ match: () => true, steps: [{ text: "pending" }] },
	]);
	const projectDir = mkdtempSync(join(tmpdir(), "ahde-builder-golden-"));
	const stateRoot = join(projectDir, ".ahde");
	const runsRoot = join(projectDir, "runs");
	process.env.AHDE_GOLDEN_TARGET_KEY = "fixture";
	try {
		const tools = createAhdeBuilderTools({
			projectDir,
			stateRoot,
			runsRoot,
			templateDir: resolve("templates", "basic-agent"),
			dependencies: { actorId: () => "local:golden-operator" },
		});

		await invoke(tools, "ahde_target_scaffold", { reason: "Initialize the golden Target" });
		await invoke(tools, "ahde_target_configure_model", {
			targetId: "golden-agent",
			model: {
				provider: "openai-compatible",
				id: "golden-mock-model",
				api: "openai-completions",
				baseUrl: mock.url,
				apiKeyEnv: "AHDE_GOLDEN_TARGET_KEY",
				thinkingLevel: "off",
				timeoutMs: 30_000,
				params: {},
				spec: {
					reasoning: false,
					contextWindow: 16_384,
					maxTokens: 1_024,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					compat: {},
				},
			},
			reason: "Use the exact local fixture model",
		});

		const draft = await invoke(tools, "ahde_spec_save_draft", {
			title: "Golden answer agent",
			purpose: "Return the reviewed deterministic answer.",
			users: ["acceptance reviewer"],
			jobs: ["answer one request"],
			inputs: ["text request"],
			allowedActions: ["return text"],
			successCriteria: ["answer contains READY"],
			constraints: ["no network"],
			openQuestions: [],
		});
		const draftId = draft.id as string;
		await invoke(tools, "ahde_spec_approve", { specId: draftId, reason: "Exact product contract" });

		const published = await invoke(tools, "ahde_corpus_publish_development", {
			name: "Golden development",
			tasks: [{
				id: "dev-1",
				input: "Answer the golden request.",
				graders: [{ type: "output_contains", text: "READY" }],
			}],
			reason: "Exact development case",
		});
		const developmentCorpusId = (published.corpus as { id: string }).id;
		const baseline = await invoke(tools, "ahde_eval_run_development", {
			developmentCorpusId,
			repetitions: 1,
			reason: "Measure the configured baseline",
		});
		const evaluation = baseline.evaluation as { evalRunId: string; summary: { fail: number; error: number } };
		expect(evaluation.summary).toMatchObject({ fail: 1, error: 0 });
		const brief = compileImprovementBrief(runsRoot, diagnoseEvalRun(runsRoot, evaluation.evalRunId));
		const failureMode = brief.modes.find((mode) => mode.decision === "propose-harness-change");
		if (!failureMode) throw new Error("golden fixture has no proposal-eligible failure mode");
		const proposalBasis = {
			algorithmId: brief.algorithmId,
			evalRunId: brief.evalRunId,
			diagnosisId: brief.diagnosisId,
			briefId: brief.briefId,
			failureModeIds: [failureMode.failureModeId],
		};
		const selected = deriveEvidenceLinkedProposalSelection(brief, proposalBasis);
		const evidenceRefs = [...new Set(selected.diagnoses.flatMap((item) => item.evidence))];

		const before = readFileSync(join(projectDir, "AGENTS.md"), "utf8");
		const after = `${before.trimEnd()}\n\nReturn the exact uppercase word READY.\n`;
		const proposal = await invoke(tools, "ahde_proposal_create", {
			specDraftId: draftId,
			sourceEvalRunId: evaluation.evalRunId,
			proposalBasis,
			decision: "propose",
			summary: "Make the answer contract explicit.",
			diagnoses: selected.diagnoses,
			changes: [{
				path: "AGENTS.md",
				baseSha256: sha256(before),
				unifiedDiff: wholeFileDiff("AGENTS.md", before, after),
				rationale: "Align the harness with the approved observable contract.",
				evidenceRefs,
			}],
			risks: ["The output contract is intentionally narrow."],
			validationPlan: ["Run matched development and sealed evidence."],
		});
		const builderRunId = proposal.runId as string;
		const diff = await invoke(tools, "ahde_proposal_diff", { runId: builderRunId });
		expect(diff.exactDiff).toContain("Return the exact uppercase word READY.");
		await invoke(tools, "ahde_proposal_apply", {
			runId: builderRunId,
			branch: "candidate/golden",
			reason: "The exact diff addresses the diagnosed failure.",
		});

		const sealedInput = "PRIVATE GOLDEN HOLDOUT INPUT";
		const holdout = createCorpus({
			stateRoot,
			projectId: "golden-agent",
			name: "Evaluator-only golden holdout",
			visibility: "sealed",
			tasks: [{
				id: "holdout-1",
				input: sealedInput,
				graders: [{ type: "output_contains", text: "READY" }],
			}],
		});
		const verified = await invoke(tools, "ahde_candidate_verify", {
			builderRunId,
			repetitions: 1,
			reason: "Run the exact promotion gate.",
		});
		const candidate = verified.candidate as { candidateId: string; status: string };
		expect(candidate.status).toBe("evaluated");
		expect(JSON.stringify(verified)).not.toContain(sealedInput);
		expect(JSON.stringify(verified)).not.toContain("holdout-1");
		expect(JSON.stringify(verified)).not.toContain(holdout.id);
		expect(JSON.stringify(verified)).not.toContain(holdout.hash);
		expect(JSON.stringify(verified)).not.toContain(holdout.name);

		await invoke(tools, "ahde_candidate_review", {
			candidateId: candidate.candidateId,
			recommendation: "promote",
			reason: "Development improved and the private gate passed.",
		});
		const promoted = await invoke(tools, "ahde_candidate_promote", {
			candidateId: candidate.candidateId,
			version: "0.1.0",
			reason: "Ship the exact reviewed candidate.",
		});
		expect(promoted.tag).toBe("v0.1.0");
		expect(execFileSync("git", ["-C", projectDir, "rev-list", "-n", "1", "v0.1.0"], { encoding: "utf8" }).trim())
			.toBe(promoted.candidateSha);
	} finally {
		delete process.env.AHDE_GOLDEN_TARGET_KEY;
		await mock.close();
		rmSync(projectDir, { recursive: true, force: true });
	}
}, 120_000);
