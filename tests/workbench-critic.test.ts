import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderReview } from "../src/builder/render/view.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { setLanguage } from "../src/i18n.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import { loadCriticReceipt } from "../src/application/case-critic.js";
import { hashValue } from "../src/provenance.js";
import { workbenchNext } from "../src/workbench/next-actions.js";
import type { AgentSpec } from "../src/spec.js";
import { createAhdeWorkbench, type AhdeWorkbench, type WorkbenchHumanGate } from "../src/workbench/index.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

const NOW = "2026-09-08T09:00:00.000Z";
const PROJECT = "test-target";
const roots: string[] = [];
const mocks: MockModelHandle[] = [];

afterEach(async () => {
	setLanguage("en");
	for (const root of roots.splice(0)) cleanup(root);
	for (const mock of mocks.splice(0)) await mock.close();
});

const gate: WorkbenchHumanGate = {
	confirm: async () => ({ approved: true, actorId: "local:test-human" }),
	selectSealed: async () => ({ approved: false }),
};

const spec: AgentSpec = {
	schemaVersion: 1,
	title: "Refund policy assistant",
	purpose: "Answer refund questions from approved local evidence.",
	users: ["Support operators"],
	jobs: ["Answer refund questions", "Escalate a disputed charge"],
	inputs: ["A refund question"],
	allowedActions: ["Read approved local policy"],
	successCriteria: ["The answer names the applicable policy"],
	constraints: ["Never invent a policy"],
	openQuestions: [],
};

/** Two cases, one labelled and cited, one with neither: the matrix has to show both. */
const CASES = [
	{
		input: "How long do I have to ask for a refund?",
		graders: [{ type: "output_contains" as const, text: "14" }],
		coverage: { job: "Answer refund questions", difficulty: "direct" as const },
		source: { kind: "spec" as const },
	},
	{
		input: "Can you refund me in cash?",
		graders: [{ type: "output_excludes" as const, text: "cash" }],
	},
];

function manifest(judgeUrl: string): string {
	const base = baseFixtureFiles().find((file) => file.path === "manifest.yaml")!.content;
	return base.replace(
		"  graders: evals/graders.yaml\n",
		`  graders: evals/graders.yaml
  judge:
    provider: fixture-provider
    id: fixture-judge
    api: openai-completions
    baseUrl: ${judgeUrl}
    apiKeyEnv: TEST_JUDGE_KEY
    thinkingLevel: "off"
    timeoutMs: 30000
`,
	);
}

/** A judge that says whatever the test needs about however many cases it is shown. */
async function mockCritic(reply: string): Promise<MockModelHandle> {
	const mock = await startMockModel([{ match: () => true, steps: [{ text: reply }] }]);
	mocks.push(mock);
	return mock;
}

const BOTH_VALID = JSON.stringify({
	findings: [{ case: 1, verdict: "valid", reasons: [] }, { case: 2, verdict: "valid", reasons: [] }],
});
const ONE_INVALID = JSON.stringify({
	findings: [
		{ case: 1, verdict: "valid", reasons: [] },
		{ case: 2, verdict: "invalid", reasons: ["no declared tool can issue cash, and the case is not labelled out-of-scope"] },
	],
});

async function drafted(reply: string): Promise<{ workbench: AhdeWorkbench; stateRoot: string; draftId: string }> {
	const mock = await mockCritic(reply);
	const projectDir = makeTargetFixture(baseFixtureFiles({
		"manifest.yaml": manifest(mock.url),
		".gitignore": ".ahde/\nruns/\n",
	}));
	roots.push(projectDir);
	const stateRoot = join(projectDir, ".ahde");
	const workbench = createAhdeWorkbench({
		projectDir,
		stateRoot,
		runsRoot: join(projectDir, "runs"),
		projectId: PROJECT,
		dependencies: { now: () => NOW },
	});
	await workbench.submit({ kind: "spec-draft", spec });
	await workbench.decide({ kind: "approve-spec", reason: "the contract is right" }, gate);
	const draft = await workbench.submit({
		kind: "corpus-draft",
		name: "Refund basket",
		tasks: CASES,
		coverageNotes: [],
		revisionSummary: "First cases",
	});
	return { workbench, stateRoot, draftId: String(draft.artifact?.id) };
}

describe("critique-corpus: the judge reads the cases, never the agent", () => {
	it("returns a verdict per case, records a receipt on the draft hash and says what to do next", async () => {
		const { workbench, stateRoot, draftId } = await drafted(ONE_INVALID);

		const result = await workbench.decide({ kind: "critique-corpus", reason: "check the basket" }, gate);

		expect(result.kind).toBe("critique-corpus");
		if (result.kind !== "critique-corpus") throw new Error("wrong kind");
		expect(result.result.counts).toEqual({ valid: 1, repair: 0, invalid: 1, unreviewed: 0 });
		expect(result.result.subject).toEqual({ kind: "corpus-draft", id: draftId });
		expect(result.result.judge).toBe("fixture-provider/fixture-judge");
		expect(result.result.findings.find((finding) => finding.verdict === "invalid")?.reasons[0])
			.toMatch(/no declared tool can issue cash/);
		expect(result.message).toMatch(/1 valid · 0 to repair · 1 invalid/);
		expect(result.message).toMatch(/Repair the cases marked to repair/);
		// The receipt is keyed by the subject's hash, so the same draft is never
		// paid for twice and a later reading can still find the verdicts.
		const draft = await workbench.view({ aspect: "review" });
		const detail = draft.detail?.aspect === "review" && draft.detail.content.kind === "corpus-draft"
			? draft.detail.content
			: null;
		expect(detail?.critic?.counts.invalid).toBe(1);
		expect(loadCriticReceipt(stateRoot, PROJECT, { hash: detail!.draftHash })?.id).toBe(result.result.receiptId);
	});

	it("refuses to publish a basket with invalid findings, and publishes on the operator's force", async () => {
		const { workbench } = await drafted(ONE_INVALID);
		await workbench.decide({ kind: "critique-corpus", reason: "check the basket" }, gate);

		await expect(workbench.decide({ kind: "publish-corpus", reason: "ship the basket" }, gate))
			.rejects.toThrow(/the critic marked 1 case\(s\) invalid; repair them or exclude them with a reason, or publish with force/);
		// The composite has no force at all: a run is a measurement, and it is not
		// taken against cases nobody could make sense of.
		await expect(workbench.decide({ kind: "start-testing", repetitions: 1, reason: "test it" }, gate))
			.rejects.toThrow(/the critic marked 1 case\(s\) invalid/);

		const published = await workbench.decide(
			{ kind: "publish-corpus", force: true, reason: "the second case is deliberately out of scope" },
			gate,
		);
		expect(published.kind).toBe("publish-corpus");
	});

	it("lets a basket the critic accepted through, and carries the reading onto the published corpus", async () => {
		const { workbench, stateRoot } = await drafted(BOTH_VALID);
		const critiqued = await workbench.decide({ kind: "critique-corpus", reason: "check the basket" }, gate);
		if (critiqued.kind !== "critique-corpus") throw new Error("wrong kind");
		expect(critiqued.result.counts.invalid).toBe(0);
		expect(critiqued.message).not.toMatch(/Repair the cases/);

		const published = await workbench.decide({ kind: "publish-corpus", reason: "the cases are right" }, gate);
		if (published.kind !== "publish-corpus") throw new Error("wrong kind");
		// Re-keyed to the corpus, so a basket reading that knows only the corpus
		// hash still finds the verdicts that were paid for once.
		expect(loadCriticReceipt(stateRoot, PROJECT, { hash: published.result.corpusHash })?.counts)
			.toEqual({ valid: 2, repair: 0, invalid: 0, unreviewed: 0 });
	});

	it("prints the matrix, the empty cells and the critic's word in the draft panel", async () => {
		const { workbench } = await drafted(ONE_INVALID);
		const before = await workbench.view({ aspect: "review" });
		const beforeContent = before.detail?.aspect === "review" ? before.detail.content : null;
		if (!beforeContent || beforeContent.kind !== "corpus-draft") throw new Error("no draft under review");
		const unread = renderReview(beforeContent, plainPaint).join("\n");
		expect(unread).toContain("Coverage");
		expect(unread).toContain("Answer refund questions: direct 1 · clarify 0");
		// The job nobody wrote a case for, and the case nobody labelled.
		expect(unread).toContain("Escalate a disputed charge: direct 0");
		expect(unread).toContain("empty:");
		expect(unread).toContain("1 case without a coverage label");
		expect(unread).toContain("origin: 0 real · 1 synthetic · 1 unlabelled");
		expect(unread).toContain("the critic has not read this draft");
		expect(unread).toContain("A case is never removed for failing");

		await workbench.decide({ kind: "critique-corpus", reason: "check the basket" }, gate);
		const after = await workbench.view({ aspect: "review" });
		const afterContent = after.detail?.aspect === "review" ? after.detail.content : null;
		if (!afterContent || afterContent.kind !== "corpus-draft") throw new Error("no draft under review");
		expect(renderReview(afterContent, plainPaint).join("\n")).toContain("1 valid · 0 to repair · 1 invalid");
	});

	it("shows the excluded cases and their reasons next to the ones that stayed", async () => {
		const { workbench, draftId } = await drafted(BOTH_VALID);
		const before = await workbench.view({ aspect: "review" });
		const content = before.detail?.aspect === "review" ? before.detail.content : null;
		if (!content || content.kind !== "corpus-draft") throw new Error("no draft under review");
		await workbench.submit({
			kind: "corpus-revision",
			parentDraftId: draftId,
			operations: [{
				type: "remove",
				taskId: content.tasks[1]!.id,
				reason: "cash refunds are not an allowed action, so the check can never be satisfied",
			}],
			revisionSummary: "Exclude the impossible case",
		});
		const after = await workbench.view({ aspect: "review" });
		const revised = after.detail?.aspect === "review" ? after.detail.content : null;
		if (!revised || revised.kind !== "corpus-draft") throw new Error("no draft under review");
		const panel = renderReview(revised, plainPaint).join("\n");
		expect(panel).toContain("excluded with a reason: 1 case");
		expect(panel).toContain("cash refunds are not an allowed action");
	});

	it("offers the critic only where there are cases to read", async () => {
		const { workbench } = await drafted(BOTH_VALID);
		const view = await workbench.view();
		const offered = (counts: typeof view.counts) =>
			// The live view carries its own precomputed guidance, so the table is
			// asked directly here: this is about the rule, not about the cache.
			workbenchNext({ stage: view.stage, counts }).decide.some((entry) => entry.kind === "critique-corpus");
		expect(offered(view.counts)).toBe(true);
		expect(offered({ ...view.counts, corpusDrafts: 0, developmentCorpora: 0 })).toBe(false);
	});
});
