import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBuilderCorpusDraft } from "../src/application/builder-corpus-draft.js";
import {
	loadCandidateRecord,
	promoteReviewedCandidate,
} from "../src/application/candidate-review.js";
import {
	CheapCheckScreenRecordSchema,
	screenRecordPath,
} from "../src/application/cheap-check.js";
import {
	buildPromotionRegressionGuards,
	detectPromotionFlips,
	developmentArmsOf,
	guardCaseFor,
	PROMOTION_GUARD_KIND,
	PROMOTION_GUARD_METADATA_KIND,
	PROMOTION_GUARD_METADATA_SOURCE_TASK,
	PROMOTION_GUARD_METADATA_TAG,
} from "../src/application/regression-guards.js";
import { listCorpora, loadCorpus } from "../src/corpus.js";
import { loadTarget } from "../src/manifest.js";
import { loadApprovedSpec } from "../src/spec.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";
import { loadWorkbenchCorpusPublication } from "../src/workbench/corpus-publication.js";
import { loadWorkbenchInventory } from "../src/workbench/inventory.js";
import { compatibleDevelopmentEvals } from "../src/workbench/resolution.js";
import { createAhdeWorkbench } from "../src/workbench/index.js";
import { SEALED_VERIFICATION_REPETITIONS } from "./helpers/sealed-holdout.js";
import {
	approvingGate,
	improveFixture,
	READY_INSTRUCTION,
	recordFixtureProposal,
	type ImproveFixture,
} from "./helpers/improve-fixtures.js";

const PROMOTION_TAG = "v0.2.0";

/** Drive one fixture all the way to an evaluated, reviewed candidate. */
async function reviewedCandidate(fixture: ImproveFixture): Promise<string> {
	const proposal = await recordFixtureProposal(fixture, READY_INSTRUCTION);
	await fixture.workbench.decide({
		kind: "apply-proposal",
		runId: proposal.runId,
		branch: "candidate/guards",
		reason: "Apply the reviewed fixture proposal",
	}, approvingGate());
	const verified = await fixture.workbench.decide({
		kind: "verify-candidate",
		repetitions: SEALED_VERIFICATION_REPETITIONS,
		reason: "Verify the applied candidate",
	}, approvingGate());
	if (verified.result.outcome !== "verified") throw new Error("the fixture candidate was stopped by its screen");
	const reviewed = await fixture.workbench.decide({
		kind: "review-candidate",
		recommendation: "promote",
		reason: "The development gain is real and the sealed guardrail passed.",
	}, approvingGate());
	return reviewed.result.candidateId;
}

function guardInputs(fixture: ImproveFixture, candidateId: string) {
	const inventory = loadWorkbenchInventory({
		projectDir: fixture.projectDir,
		stateRoot: fixture.stateRoot,
		runsRoot: fixture.runsRoot,
		projectId: fixture.projectId,
	});
	const approved = loadApprovedSpec({
		stateRoot: fixture.stateRoot,
		projectId: fixture.projectId,
		specId: fixture.approvedSpecId,
	});
	return {
		runsRoot: fixture.runsRoot,
		stateRoot: fixture.stateRoot,
		candidate: loadCandidateRecord(fixture.runsRoot, candidateId),
		approvedSpec: approved.reference,
		target: loadTarget(fixture.projectDir),
		developmentCorpus: loadCorpus({
			stateRoot: fixture.stateRoot,
			projectId: fixture.projectId,
			corpusId: fixture.corpusId,
		}),
		parentDraftId: loadWorkbenchCorpusPublication(fixture.stateRoot, fixture.projectId, fixture.corpusId).draftId,
		compatibleEvalRuns: compatibleDevelopmentEvals(inventory, fixture.approvedSpecId, fixture.corpusId),
		promotionTag: PROMOTION_TAG,
	};
}

describe("promoted fixes become regression guards", () => {
	let fixture: ImproveFixture;
	let candidateId: string;

	beforeAll(async () => {
		fixture = await improveFixture();
		candidateId = await reviewedCandidate(fixture);
	}, 600_000);

	afterAll(async () => {
		await fixture?.close();
	});

	it("finds the tasks that flipped fail→pass between the real recorded arms", () => {
		const record = loadCandidateRecord(fixture.runsRoot, candidateId);
		const arms = developmentArmsOf(record);
		expect(arms.baselineEvalRunId).not.toBe(arms.candidateEvalRunId);
		expect(arms.corpus?.id).toBe(fixture.corpusId);

		const flips = detectPromotionFlips(fixture.runsRoot, record);
		// Both reviewed cases failed on the baseline arm and pass on the candidate.
		expect(flips).toHaveLength(2);
		for (const flip of flips) {
			expect(flip.evalRunId).toBe(arms.baselineEvalRunId);
			expect(flip.baselineFailures).toBeGreaterThan(0);
			expect(flip.candidatePasses).toBeGreaterThan(0);
			expect(flip.runId).toMatch(/\S/);
		}
		// Deterministic: the same arms give the same flips in the same order.
		expect(detectPromotionFlips(fixture.runsRoot, record)).toEqual(flips);
	});

	it("derives a draft through the exact-evidence rules and publishes nothing", () => {
		const before = listCorpora({ stateRoot: fixture.stateRoot, projectId: fixture.projectId });
		const inputs = guardInputs(fixture, candidateId);
		const guards = buildPromotionRegressionGuards(inputs);
		if (!guards) throw new Error("the promotion flipped cases but produced no guard draft");

		expect(guards.cases).toBe(2);
		expect(guards.parentDraftId).toBe(inputs.parentDraftId);
		const draft = loadBuilderCorpusDraft(fixture.stateRoot, fixture.projectId, guards.draftId);
		expect(draft.parentDraftId).toBe(inputs.parentDraftId);
		// The reviewed basket plus the two pinned cases.
		expect(draft.tasks).toHaveLength(inputs.developmentCorpus.tasks.length + 2);
		expect(draft.revisionSummary).toContain(PROMOTION_TAG);

		// Every guard case cites hash-indexed failed development evidence and
		// carries no trace answer.
		expect(draft.taskProvenance).toHaveLength(2);
		for (const provenance of draft.taskProvenance ?? []) {
			expect(provenance.kind).toBe("development-failure");
			expect(provenance.source.evalRunId).toBe(developmentArmsOf(inputs.candidate).baselineEvalRunId);
			expect(provenance.source.traceSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(provenance.source.runHash).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(JSON.stringify(provenance)).not.toContain("pending");
		}

		const pinned = draft.tasks.filter((task) => task.metadata?.[PROMOTION_GUARD_METADATA_KIND] === PROMOTION_GUARD_KIND);
		expect(pinned).toHaveLength(2);
		for (const task of pinned) {
			expect(task.metadata?.[PROMOTION_GUARD_METADATA_TAG]).toBe(PROMOTION_TAG);
			expect(task.metadata?.[PROMOTION_GUARD_METADATA_SOURCE_TASK]).toMatch(/\S/);
		}

		// A draft is a draft: publishing it is an explicit human decision.
		expect(listCorpora({ stateRoot: fixture.stateRoot, projectId: fixture.projectId })).toEqual(before);
	});

	it("refuses to pin a case the promotion did not actually fix", () => {
		const inputs = guardInputs(fixture, candidateId);
		const source = inputs.developmentCorpus.tasks[0]!;
		// The derived case must differ from the canonical one, or the exact-evidence
		// rules reject it as a duplicate rather than accept a silent copy.
		const derived = guardCaseFor(source, PROMOTION_TAG);
		expect(derived.input).toBe(source.input);
		expect(derived.metadata?.[PROMOTION_GUARD_METADATA_KIND]).toBe(PROMOTION_GUARD_KIND);
		expect(JSON.stringify({ ...source, id: undefined })).not.toBe(JSON.stringify({ ...derived, id: undefined }));
	});

	it("refuses a promotion whose evidence is a cheap-check screen", () => {
		const record = loadCandidateRecord(fixture.runsRoot, candidateId);
		const arms = developmentArmsOf(record);
		const screenId = `screen-${arms.candidateEvalRunId}`;
		const path = screenRecordPath(fixture.runsRoot, screenId);
		writeJsonArtifact(path, CheapCheckScreenRecordSchema, CheapCheckScreenRecordSchema.parse({
			schemaVersion: 1,
			kind: "cheap-check-screen",
			screenId,
			evalRunId: arms.candidateEvalRunId,
			sourceEvalRunId: fixture.evalRunId,
			targetId: fixture.projectId,
			baseTargetSha: fixture.baselineSha,
			candidateSha: fixture.baselineSha,
			surface: { dataset: "d", datasetHash: `sha256:${"0".repeat(64)}`, suiteHash: `sha256:${"0".repeat(64)}` },
			taskIds: [],
			runIds: [],
			rows: [],
			summary: { tasks: 0, improved: 0, unchanged: 0, regressed: 0, inconclusive: 0 },
			verdict: "flat",
			withinErrorBudget: true,
			createdAt: "2026-08-31T00:00:00.000Z",
		}));
		try {
			expect(() => promoteReviewedCandidate({
				repositoryDir: fixture.projectDir,
				runsRoot: fixture.runsRoot,
				stateRoot: fixture.stateRoot,
				candidateId,
				version: "9.9.9",
				reason: "A screen must never reach a promotion.",
			})).toThrow(/cheap-check screen, which is never promotion evidence/);
		} finally {
			rmSync(path, { force: true });
		}
	});

	it("promotes and warns when the guard build fails, instead of blocking the release", async () => {
		const guarded = createAhdeWorkbench({
			projectDir: fixture.projectDir,
			stateRoot: fixture.stateRoot,
			runsRoot: fixture.runsRoot,
			projectId: fixture.projectId,
			dependencies: {
				buildPromotionGuards: () => {
					throw new Error("guard drafting exploded");
				},
			},
		});
		const before = listCorpora({ stateRoot: fixture.stateRoot, projectId: fixture.projectId });
		const promoted = await guarded.decide({
			kind: "promote-candidate",
			candidateId,
			version: "0.3.0",
			reason: "Ship the verified candidate even though guard drafting failed.",
		}, approvingGate());

		// The release is written; the bookkeeping that runs after it is a warning.
		expect(promoted.result.tag).toBe("v0.3.0");
		expect(promoted.result.candidate.status).toBe("promoted");
		expect(loadCandidateRecord(fixture.runsRoot, candidateId).events.some((event) => event.type === "promoted")).toBe(true);
		expect(promoted.result.guards).toMatchObject({ draftId: null, cases: 0, taskIds: [] });
		expect(promoted.result.guards.warning).toContain("guard drafting exploded");
		expect(promoted.message).toContain("guard drafting exploded");
		expect(listCorpora({ stateRoot: fixture.stateRoot, projectId: fixture.projectId })).toEqual(before);
	}, 120_000);
});

describe("regression guards on a promotion that flipped nothing", () => {
	it("returns null rather than inventing a guard", async () => {
		const fixture = await improveFixture();
		try {
			const candidateId = await reviewedCandidate(fixture);
			const inputs = guardInputs(fixture, candidateId);
			// A candidate whose arms are the same eval has no flip to pin.
			const arms = developmentArmsOf(inputs.candidate);
			const sameArms = JSON.parse(JSON.stringify(inputs.candidate));
			for (const event of sameArms.events) {
				if (event.type === "evaluated") event.evaluation.development.candidate.evalRunId = arms.baselineEvalRunId;
			}
			expect(buildPromotionRegressionGuards({ ...inputs, candidate: sameArms })).toBeNull();
		} finally {
			await fixture.close();
		}
	}, 600_000);
});
