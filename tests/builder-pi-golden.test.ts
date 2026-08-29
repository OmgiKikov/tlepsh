import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createCorpus } from "../src/corpus.js";
import { startMockModel } from "../src/mock-model.js";
import {
	createHostContext,
	hostCatalogModel,
	invokeTool,
	productionTools,
} from "./helpers/builder-tools.js";
import { SEALED_VERIFICATION_REPETITIONS, sealedHoldoutTasks } from "./helpers/sealed-holdout.js";

const PROVIDER = "golden-target";
const MODEL_ID = "golden-model";
const CREDENTIAL_ENV = "GOLDEN_TARGET_API_KEY";
const SEALED_INPUT = "PRIVATE GOLDEN HOLDOUT INPUT";
const SEALED_NAME = "Evaluator-only golden holdout";

it("drives the complete canonical Workbench tool loop without revealing sealed content", async () => {
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
	process.env[CREDENTIAL_ENV] = "fixture";
	/** Everything the model ever saw; the sealed assertions run over all of it. */
	const modelVisible: unknown[] = [];
	try {
		const host = createHostContext({
			catalog: (provider, modelId) =>
				provider === PROVIDER && modelId === MODEL_ID
					? hostCatalogModel(PROVIDER, MODEL_ID, mock.url)
					: undefined,
			credentialEnv: CREDENTIAL_ENV,
		});
		const tools = productionTools({
			projectDir,
			stateRoot,
			runsRoot,
			projectId: "golden-agent",
			templateDir: resolve("templates", "basic-agent"),
			dependencies: { actorId: () => "local:golden-operator" },
		});
		const call = async (name: string, params: Record<string, unknown>): Promise<Record<string, any>> => {
			const result = await invokeTool(tools, name, params, host.ctx);
			modelVisible.push(result);
			return result;
		};

		const scaffolded = await call("ahde_workbench_decide", {
			kind: "scaffold-target",
			reason: "Initialize the golden Target",
		});
		expect(scaffolded.view.stage).toBe("target-setup");
		const configured = await call("ahde_workbench_decide", {
			kind: "configure-target",
			targetId: "golden-agent",
			model: { provider: PROVIDER, modelId: MODEL_ID, thinkingLevel: "off", timeoutMs: 60_000 },
			reason: "Use the exact local fixture model",
		});
		expect(configured.view).toMatchObject({
			stage: "spec-design",
			target: { status: "ready", model: { apiKeyEnv: CREDENTIAL_ENV, credentialPresent: true } },
		});

		const drafted = await call("ahde_workbench_submit", {
			kind: "spec-draft",
			spec: {
				title: "Golden answer agent",
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
		// Authoring alone never advances a gate: the Spec is only up for review.
		expect(drafted.view.stage).toBe("spec-review");
		const approved = await call("ahde_workbench_decide", {
			kind: "approve-spec",
			draftSpecId: String(drafted.artifact.id),
			reason: "Exact product contract",
		});
		expect(approved.view.stage).toBe("corpus-design");

		const corpusDraft = await call("ahde_workbench_submit", {
			kind: "corpus-draft",
			name: "Golden development basket",
			tasks: [
				{ input: "Answer the first golden request.", graders: [{ type: "output_contains", text: "READY" }] },
				{ input: "Answer the second golden request.", graders: [{ type: "output_contains", text: "READY" }] },
			],
			coverageNotes: ["Two cases expose the same missing instruction."],
			revisionSummary: "Initial development basket",
		});
		expect(corpusDraft.view.stage).toBe("corpus-review");
		const published = await call("ahde_workbench_decide", {
			kind: "publish-corpus",
			draftId: String(corpusDraft.artifact.id),
			reason: "Publish the reviewed development basket",
		});
		expect(published.view.stage).toBe("ready-to-evaluate");

		const evaluated = await call("ahde_workbench_decide", {
			kind: "run-eval",
			repetitions: 1,
			reason: "Measure the configured baseline",
		});
		expect(evaluated.result.evaluation.summary).toMatchObject({ pass: 0, fail: 2, error: 0 });
		expect(evaluated.view.stage).toBe("improvement-authoring");

		const traces = await call("ahde_workbench_view", { aspect: "traces" });
		const brief = traces.detail.content.improvementBrief as {
			algorithmId: string;
			evalRunId: string;
			diagnosisId: string;
			briefId: string;
			modes: { failureModeId: string; decision: string; selectableForProposal: boolean }[];
		};
		const mode = brief.modes.find((candidate) =>
			candidate.decision === "propose-harness-change" && candidate.selectableForProposal
		);
		if (!mode) throw new Error("golden fixture has no proposal-eligible failure mode");

		const overview = await call("ahde_workbench_view", { aspect: "target" });
		const instructions = await call("ahde_workbench_view", { aspect: "target", resourcePath: "AGENTS.md" });
		const current = instructions.detail.content.resource.content as string;
		const proposed = await call("ahde_workbench_submit", {
			kind: "structured-proposal",
			authoringContext: overview.detail.content.claim,
			source: {
				algorithmId: brief.algorithmId,
				evalRunId: brief.evalRunId,
				diagnosisId: brief.diagnosisId,
				briefId: brief.briefId,
			},
			failureModeIds: [mode.failureModeId],
			summary: "Make the answer contract explicit.",
			intents: [{
				type: "instructions.replace",
				content: `${current.trimEnd()}\n\nReturn the exact uppercase word READY.\n`,
			}],
			risks: ["The output contract is intentionally narrow."],
			validationPlan: ["Run matched development and sealed evidence."],
		});
		expect(proposed.view.stage).toBe("proposal-review");
		const review = await call("ahde_workbench_view", { aspect: "review" });
		expect(review.detail.content.exactDiff).toContain("Return the exact uppercase word READY.");

		const applied = await call("ahde_workbench_decide", {
			kind: "apply-proposal",
			runId: String(proposed.artifact.runId),
			branch: "candidate/golden",
			reason: "The exact diff addresses the diagnosed failure.",
		});
		expect(applied.view.stage).toBe("candidate-verification");

		// The evaluator owns the holdout; it is created out of band and its
		// identity must never cross back through a tool result.
		const holdout = createCorpus({
			stateRoot,
			projectId: "golden-agent",
			name: SEALED_NAME,
			visibility: "sealed",
			tasks: sealedHoldoutTasks(SEALED_INPUT),
		});
		const verified = await call("ahde_workbench_decide", {
			kind: "verify-candidate",
			repetitions: SEALED_VERIFICATION_REPETITIONS,
			reason: "Run the exact promotion gate.",
		});
		expect(verified.result).toMatchObject({
			candidate: {
				status: "evaluated",
				development: { gate: { verdict: "improved" } },
				sealedHoldout: { executed: true, gatePassed: true, gate: { verdict: "pass" } },
			},
			development: { verdict: "improved" },
			sealedHoldout: { executed: true, gatePassed: true, verdict: "pass" },
		});
		expect(verified.view.stage).toBe("candidate-review");
		const candidateId = String(verified.result.candidate.candidateId);

		const reviewed = await call("ahde_workbench_decide", {
			kind: "review-candidate",
			candidateId,
			recommendation: "promote",
			reason: "Development improved and the private gate passed.",
		});
		expect(reviewed.view.stage).toBe("release-decision");
		const promoted = await call("ahde_workbench_decide", {
			kind: "promote-candidate",
			candidateId,
			version: "0.1.0",
			reason: "Ship the exact reviewed candidate.",
		});
		expect(promoted.result.tag).toBe("v0.1.0");
		expect(execFileSync("git", ["-C", projectDir, "rev-list", "-n", "1", "v0.1.0"], { encoding: "utf8" }).trim())
			.toBe(promoted.result.candidateSha);

		// Every consequential step passed the host gate, and nothing else did.
		expect(host.confirmations.map((entry) => entry.title)).toEqual([
			"Create exact Target harness",
			"Configure exact Target identity and model",
			"Approve exact Spec draft",
			"Publish exact development corpus",
			"Run exact development evaluation",
			"Apply exact Builder proposal",
			"Verify exact applied candidate",
			"Record exact candidate review",
			"Promote exact candidate",
		]);

		const everythingTheModelSaw = JSON.stringify(modelVisible);
		for (const secret of [SEALED_INPUT, SEALED_NAME, holdout.id, holdout.hash, "holdout-1"]) {
			expect(everythingTheModelSaw).not.toContain(secret);
		}
	} finally {
		delete process.env[CREDENTIAL_ENV];
		await mock.close();
		rmSync(projectDir, { recursive: true, force: true });
	}
}, 120_000);
