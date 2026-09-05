import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBuilderCorpusDraft } from "../src/application/builder-corpus-draft.js";
import { loadProductionFailure } from "../src/application/failure-intake.js";
import { loadTarget } from "../src/manifest.js";
import { createAhdeWorkbench, WorkbenchDecisionDeclinedError } from "../src/workbench/index.js";
import { WorkbenchSubmitInputSchema, type WorkbenchHumanGate } from "../src/workbench/types.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";
import { startMockModel } from "../src/mock-model.js";

const roots: string[] = [];
const NOW = "2026-09-04T15:00:00.000Z";

function fixture(baseUrl?: string): { projectDir: string; stateRoot: string; runsRoot: string } {
	const files = baseFixtureFiles({ ".gitignore": ".ahde/\nruns/\nimports/\n" });
	if (baseUrl) {
		const manifest = files.find(file => file.path === "manifest.yaml")!;
		manifest.content = manifest.content.replace("http://127.0.0.1:9901/v1", baseUrl);
	}
	const projectDir = makeTargetFixture(files);
	roots.push(projectDir);
	mkdirSync(join(projectDir, "imports"));
	return { projectDir, stateRoot: join(projectDir, ".ahde"), runsRoot: join(projectDir, "runs") };
}

function human(approved = true): WorkbenchHumanGate & { confirm: ReturnType<typeof vi.fn> } {
	return {
		confirm: vi.fn(async () => ({
			approved,
			...(approved ? { actorId: "local:test-human" } : {}),
		})),
		selectSealed: vi.fn(async () => ({ approved: false })),
	};
}

const spec = {
	schemaVersion: 1 as const,
	title: "Production support agent",
	purpose: "Resolve customer account questions.",
	users: ["Customers"],
	jobs: ["Resolve an account issue"],
	inputs: ["A customer question"],
	allowedActions: ["Read account state"],
	successCriteria: ["Give a correct supported answer"],
	constraints: ["Never expose credentials"],
	openQuestions: [],
};

async function approvedWorkbench(paths: ReturnType<typeof fixture>, projectId = "test-target") {
	const workbench = createAhdeWorkbench({
		...paths,
		projectId,
		dependencies: { now: () => NOW },
	});
	await workbench.submit({ kind: "spec-draft", spec });
	await workbench.decide(
		{ kind: "approve-spec", reason: "The reviewed Spec matches the Target" },
		human(),
	);
	return workbench;
}

function writeFailure(projectDir: string, name: string): string {
	const sourcePath = `imports/${name}.json`;
	writeFileSync(join(projectDir, sourcePath), JSON.stringify({
		messages: [
			{ role: "user", content: "Why is account 42 blocked?" },
			{
				role: "assistant",
				content: "Your api_key='sk-do-not-store' proves the account is open.",
			},
		],
	}));
	return sourcePath;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) cleanup(root);
});

describe("Workbench production-failure loop", () => {
	it("publishes and really runs an imported regression through /test, surviving a restart", async () => {
		const mock = await startMockModel([{ steps: [{ text: "The account is blocked." }] }]);
		vi.stubEnv("TEST_MODEL_KEY", "local-fixture");
		try {
			const paths = fixture(mock.url);
			const projectId = "customer-support-workspace";
			const workbench = await approvedWorkbench(paths, projectId);
			const imported = await workbench.submit({
				kind: "production-failure",
				sourcePath: writeFailure(paths.projectDir, "replay"),
				sourceKind: "synthetic",
				classification: { kind: "wrong-answer", summary: "The answer invented the account state." },
				case: { graders: [{ type: "output_contains", text: "blocked" }] },
				revisionSummary: "Replay the observed account question",
			});
			const restarted = createAhdeWorkbench({ ...paths, projectId });
			const gate = human();
			const tested = await restarted.decide({ kind: "start-testing", repetitions: 1, reason: "Run the reviewed regression" }, gate);
			expect(gate.confirm).toHaveBeenCalledTimes(1);
			expect(tested.kind).toBe("start-testing");
			if (tested.kind !== "start-testing") throw new Error("unexpected decision");
			expect(tested.result.evaluation?.evaluation.summary).toMatchObject({ total: 1, pass: 1, fail: 0, error: 0 });
			expect(mock.requests()).toBeGreaterThan(0);
			const draft = loadBuilderCorpusDraft(paths.stateRoot, projectId, String(imported.artifact?.draftId));
			expect(draft.taskProvenance?.[0]).toMatchObject({ kind: "production-failure", source: { failureId: imported.artifact?.failureId, importedAgainst: { id: "test-target" } } });
			const failureId = String(imported.artifact?.failureId);
			expect(loadProductionFailure(paths.stateRoot, projectId, failureId)).toMatchObject({ projectId, importedAgainst: { id: "test-target" } });
			expect(() => loadProductionFailure(paths.stateRoot, "test-target", failureId)).toThrow(/no production failures/);
		} finally {
			vi.unstubAllEnvs();
			await mock.close();
		}
	});

	it("turns one host-bound failure into the first editable draft, leaving /test as the one consequential review", async () => {
		const paths = fixture();
		const workbench = await approvedWorkbench(paths);
		const sourcePath = writeFailure(paths.projectDir, "incident");
		const target = loadTarget(paths.projectDir);

		const turn = await workbench.submit({
			kind: "production-failure",
			sourcePath,
			sourceKind: "real",
			targetClaim: { id: "prod-alias", gitSha: "release-42" },
			classification: {
				kind: "unsupported-claim",
				summary: "The answer asserted account state without trusted evidence.",
			},
			case: {
				expected: "Explain that the account is blocked and cite the observed state.",
				graders: [{ type: "output_contains", text: "blocked" }],
			},
			draftName: "Production regressions",
			coverageNotes: ["Observed customer failure, replayed after redaction."],
			revisionSummary: "Add the observed blocked-account regression",
		});

		expect(turn.kind).toBe("production-failure");
		expect(turn.view.stage).toBe("corpus-review");
		expect(turn.message).toContain("/test");
		expect(turn.artifact).toMatchObject({
			failureId: expect.stringMatching(/^failure-[0-9a-f]{64}$/),
			failureSource: sourcePath,
			importedAgainst: { id: "test-target", gitSha: target.gitSha },
			classification: { kind: "unsupported-claim" },
			parentDraftId: null,
			taskCount: 1,
		});
		const draftId = String(turn.artifact?.draftId);
		const draft = loadBuilderCorpusDraft(paths.stateRoot, "test-target", draftId);
		expect(draft.schemaVersion).toBe(3);
		expect(draft.tasks).toEqual([
			expect.objectContaining({
				input: "Why is account 42 blocked?",
				messages: [{ role: "user", content: "Why is account 42 blocked?" }],
				metadata: {
					production_failure_id: turn.artifact?.failureId,
					production_failure_class: "unsupported-claim",
					production_failure_summary: "The answer asserted account state without trusted evidence.",
				},
				graders: [expect.objectContaining({ type: "output_contains", text: "blocked" })],
			}),
		]);
		expect(draft.taskProvenance).toEqual([
			expect.objectContaining({
				kind: "production-failure",
				taskId: draft.tasks[0]?.id,
				source: expect.objectContaining({
					failureId: turn.artifact?.failureId,
					importedAgainst: { id: "test-target", gitSha: target.gitSha },
					targetClaim: { id: "prod-alias", gitSha: "release-42" },
				}),
			}),
		]);
		const failurePath = join(
			paths.stateRoot,
			"projects",
			"test-target",
			"production-failures",
			`${String(turn.artifact?.failureId)}.json`,
		);
		expect(existsSync(failurePath)).toBe(true);
		expect(readFileSync(failurePath, "utf8")).not.toContain("sk-do-not-store");

		const declined = human(false);
		await expect(workbench.decide(
			{ kind: "start-testing", repetitions: 1, reason: "Review and run the imported regression" },
			declined,
		)).rejects.toBeInstanceOf(WorkbenchDecisionDeclinedError);
		expect(declined.confirm).toHaveBeenCalledTimes(1);
		expect((await workbench.view()).counts.developmentCorpora).toBe(0);
	});

	it("adds the next failure as an immutable child of the selected draft", async () => {
		const paths = fixture();
		const workbench = await approvedWorkbench(paths);
		const first = await workbench.submit({
			kind: "corpus-draft",
			name: "Existing basket",
			tasks: [{ input: "Existing case", graders: [{ type: "output_contains", text: "ok" }] }],
			coverageNotes: [],
			revisionSummary: "Initial basket",
		});
		const sourcePath = writeFailure(paths.projectDir, "second-incident");

		const revised = await workbench.submit({
			kind: "production-failure",
			sourcePath,
			sourceKind: "synthetic",
			classification: { kind: "wrong-answer", summary: "The final account state was wrong." },
			case: { graders: [{ type: "output_contains", text: "blocked" }] },
			revisionSummary: "Keep the second incident as a regression",
		});

		expect(revised.artifact).toMatchObject({
			parentDraftId: first.artifact?.id,
			taskCount: 2,
		});
		const draft = loadBuilderCorpusDraft(
			paths.stateRoot,
			"test-target",
			String(revised.artifact?.draftId),
		);
		expect(draft.tasks.map((task) => task.input)).toEqual([
			"Existing case",
			"Why is account 42 blocked?",
		]);
		expect(draft.taskProvenance).toHaveLength(1);
	});

	it("keeps classification and measurement input strict", () => {
		const valid = {
			kind: "production-failure" as const,
			sourcePath: "imports/incident.json",
			sourceKind: "real" as const,
			classification: { kind: "wrong-answer" as const, summary: "Wrong account state." },
			case: { graders: [{ type: "output_contains" as const, text: "blocked" }] },
			revisionSummary: "Add one production regression",
		};
		expect(WorkbenchSubmitInputSchema.parse(valid)).toMatchObject(valid);
		expect(() => WorkbenchSubmitInputSchema.parse({
			...valid,
			classification: { ...valid.classification, inventedConfidence: 0.99 },
		})).toThrow();
		expect(() => WorkbenchSubmitInputSchema.parse({
			...valid,
			case: { ...valid.case, input: "rewrite the imported customer turn" },
		})).toThrow();
		expect(() => WorkbenchSubmitInputSchema.parse({ ...valid, case: { graders: [] } })).toThrow();
		expect(() => WorkbenchSubmitInputSchema.parse({
			...valid,
			sourcePath: "imports/incident.csv",
		})).toThrow();
	});
});
