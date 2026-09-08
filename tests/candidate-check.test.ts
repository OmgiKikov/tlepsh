import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordBuilderAuthoredProposal } from "../src/application/builder-authoring.js";
import { CANDIDATE_SCOPE_POLICY } from "../src/application/candidate-experiment.js";
import { loadCandidateRecord } from "../src/application/candidate-review.js";
import { compileHarnessAuthoringProposal } from "../src/application/harness-authoring.js";
import type { CandidateRecord } from "../src/domain/candidate.js";
import { WorkbenchTypedRefusalError } from "../src/workbench/errors.js";
import {
	approvingGate,
	improveFixture,
	READY_INSTRUCTION,
	recordFixtureProposal,
	type ImproveFixture,
} from "./helpers/improve-fixtures.js";
import { SEALED_VERIFICATION_REPETITIONS } from "./helpers/sealed-holdout.js";

/**
 * The manual cycle pays for the exam once, at ship. A check measures the
 * applied change on the development basket and stops; ship runs the sealed
 * exam on a second candidate that cites the check's own development runs, so
 * the operator releases the numbers they read and never a re-measurement that
 * could disagree with them.
 */

function developmentOf(record: CandidateRecord) {
	const evaluated = record.events.find((event) => event.type === "evaluated");
	if (evaluated?.type !== "evaluated") throw new Error(`candidate ${record.candidateId} was never evaluated`);
	return evaluated.evaluation;
}

describe("a check measures the basket; ship runs the exam", () => {
	let fixture: ImproveFixture;
	let checkId: string;

	beforeAll(async () => {
		fixture = await improveFixture();
	}, 120_000);

	afterAll(async () => {
		await fixture?.close();
	});

	it("checks the applied change on the development basket only and leaves the exam to ship", async () => {
		const proposal = await recordFixtureProposal(fixture, READY_INSTRUCTION);
		const gate = approvingGate();
		await fixture.workbench.decide({
			kind: "apply-proposal",
			runId: proposal.runId,
			branch: "candidate/check",
			reason: "Apply the reviewed fixture proposal",
		}, gate);
		const checked = await fixture.workbench.decide({
			kind: "verify-candidate",
			repetitions: SEALED_VERIFICATION_REPETITIONS,
			reason: "Check the applied change",
		}, gate);
		expect(checked.result.outcome).toBe("verified");
		if (checked.result.outcome !== "verified") return;
		checkId = checked.result.candidate.candidateId;

		// No holdout was selected, none ran, and the message says where it runs.
		expect(gate.selectSealed).not.toHaveBeenCalled();
		expect(checked.result.sealedHoldout).toEqual({ executed: false, gatePassed: false, verdict: null });
		expect(checked.result.development.verdict).toBe("improved");
		expect(checked.message).toContain("Check completed on the development basket: improved");
		expect(checked.message).toContain("ship it");
		expect(developmentOf(loadCandidateRecord(fixture.runsRoot, checkId)).sealedHoldout).toBeUndefined();

		// The change stays where it was checked, projected for the next step:
		// ship or reject, and never another "check" as the only way forward.
		expect(checked.view.stage).toBe("candidate-verification");
		expect(checked.view.checkedChange).toEqual({ candidateId: checkId, verdict: "improved", brokenGuards: 0 });
		const offered = checked.view.guidance?.decide.map((entry) => entry.kind) ?? [];
		expect(offered).toEqual(expect.arrayContaining(["ship", "reject-candidate"]));
	}, 180_000);

	it("ships from the check: the exam runs on a new candidate that cites the check's development runs", async () => {
		const check = developmentOf(loadCandidateRecord(fixture.runsRoot, checkId));
		const before = await fixture.workbench.view();
		const gate = approvingGate();
		const shipped = await fixture.workbench.decide({
			kind: "ship",
			version: "0.1.0",
			reason: "Release the checked change",
		}, gate);
		expect(shipped.result.steps.map((step) => step.kind)).toEqual([
			"verify-candidate",
			"review-candidate",
			"promote-candidate",
			"adopt-candidate",
			"continue-cycle",
		]);
		expect(shipped.result.tag).toBe("v0.1.0");
		expect(gate.selectSealed).toHaveBeenCalledTimes(1);

		// A second record, whose development pair IS the check's: same eval runs,
		// same comparison evidence, and the sealed pair beside it.
		const examId = shipped.result.candidate.candidateId;
		expect(examId).not.toBe(checkId);
		const exam = developmentOf(loadCandidateRecord(fixture.runsRoot, examId));
		expect(exam.development.baseline.evalRunId).toBe(check.development.baseline.evalRunId);
		expect(exam.development.candidate.evalRunId).toBe(check.development.candidate.evalRunId);
		expect(exam.development.comparison).toEqual(check.development.comparison);
		expect(exam.development.regressionGuards).toEqual(check.development.regressionGuards);
		expect(exam.sealedHoldout?.comparison).toMatchObject({ surface: "sealed", verdict: "pass" });

		// Nothing on the development basket was spent again: the eval-run count
		// is what the check left, and the cycle closed onto the shipped agent,
		// whose matched evidence lets the next cycle start at authoring.
		const after = shipped.view;
		expect(after.counts.developmentEvals).toBe(before.counts.developmentEvals);
		expect(after.stage).toBe("improvement-authoring");
		expect(after.checkedChange).toBeUndefined();
	}, 300_000);
});

describe("a checked change that regressed", () => {
	let fixture: ImproveFixture;

	beforeAll(async () => {
		// A basket the baseline already passes: the scripted Target says
		// "pending", and every case wants exactly that.
		fixture = await improveFixture(undefined, { graderTexts: ["pending"] });
	}, 120_000);

	afterAll(async () => {
		await fixture?.close();
	});

	it("is refused at ship before a single sealed case runs, and is rejected where it was checked", async () => {
		// A construction proposal — no failure to fix — that makes the agent say
		// READY, which every case of this basket fails.
		const proposal = compileHarnessAuthoringProposal({
			repositoryDir: fixture.projectDir,
			intents: [{ type: "instructions.replace", content: `# Improve fixture\n\n${READY_INSTRUCTION}\n` }],
			summary: "Change the answer contract.",
			risks: ["Instruction-only behaviour change"],
			validationPlan: ["Re-run the reviewed development basket"],
		});
		const recorded = await recordBuilderAuthoredProposal({
			proposal,
			targetDir: fixture.projectDir,
			allowedPaths: [...CANDIDATE_SCOPE_POLICY.allowed],
			approvedSpec: { stateRoot: fixture.stateRoot, projectId: fixture.projectId, specId: fixture.approvedSpecId },
			runsRoot: fixture.runsRoot,
			timeoutMs: 30_000,
		});
		const gate = approvingGate();
		await fixture.workbench.decide({
			kind: "apply-proposal",
			runId: recorded.record.runId,
			branch: "candidate/regressed",
			reason: "Apply the construction proposal",
		}, gate);
		const checked = await fixture.workbench.decide({
			kind: "verify-candidate",
			repetitions: SEALED_VERIFICATION_REPETITIONS,
			reason: "Check the applied change",
		}, gate);
		expect(checked.result.outcome).toBe("verified");
		if (checked.result.outcome !== "verified") return;
		expect(checked.result.development.verdict).toBe("regressed");
		expect(checked.message).toContain("a regressed change cannot ship");
		expect(checked.view.stage).toBe("candidate-verification");
		expect(checked.view.checkedChange).toMatchObject({ candidateId: checked.result.candidate.candidateId, verdict: "regressed" });

		// Ship refuses before the exam: no holdout is even selected.
		const shipGate = approvingGate();
		let refused: unknown;
		try {
			await fixture.workbench.decide({ kind: "ship", version: "0.1.0", reason: "Try to release it" }, shipGate);
		} catch (error) {
			refused = error;
		}
		expect(refused).toBeInstanceOf(WorkbenchTypedRefusalError);
		expect((refused as WorkbenchTypedRefusalError).reason.code).toBe("refusal.ship-check-regressed");
		expect(shipGate.selectSealed).not.toHaveBeenCalled();
		expect(shipGate.confirm).not.toHaveBeenCalled();

		// Rejecting is legal right here: the review is recorded, the candidate is
		// rejected, and the cycle is over with the agent where it was.
		const rejected = await fixture.workbench.decide({ kind: "reject-candidate", reason: "It regressed" }, approvingGate());
		expect(rejected.result.status).toBe("rejected");
		expect(rejected.view.stage).toBe("complete");
		expect(rejected.view.checkedChange).toBeUndefined();
	}, 240_000);
});
