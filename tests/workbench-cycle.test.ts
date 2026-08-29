import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Check } from "typebox/value";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadCandidateRecord } from "../src/application/candidate-review.js";
import { loadTargetAdoptionReceipt } from "../src/application/target-adoption.js";
import { WorkbenchDecisionToolSchema } from "../src/builder/workbench-transport.js";
import { hashValue } from "../src/provenance.js";
import { loadCycleContinuationReceipt } from "../src/workbench/cycle-continuation.js";
import { deriveWorkbenchView, loadWorkbenchInventory } from "../src/workbench/inventory.js";
import {
	WorkbenchDecisionDeclinedError,
	WorkbenchDecisionInputSchema,
	createAhdeWorkbench,
	type AhdeWorkbenchDependencies,
	type WorkbenchCandidateImpactProjection,
	type WorkbenchConfirmation,
	type WorkbenchReviewDetail,
	type WorkbenchView,
} from "../src/workbench/index.js";
import {
	ACTOR_ID,
	CANDIDATE_AGENTS_MD,
	NOW,
	PROJECT_ID,
	cleanupPaths,
	gate,
	git,
	targetPaths,
	terminalCandidateFixture,
	type CycleFixture,
} from "./helpers/cycle-fixtures.js";

const SHA256 = /^sha256:[0-9a-f]{64}$/;

type CandidateReview = Extract<WorkbenchReviewDetail, { kind: "candidate" }>;

function candidateReview(view: WorkbenchView): CandidateReview {
	const detail = view.detail;
	if (detail?.aspect !== "review" || detail.content.kind !== "candidate") {
		throw new Error(`expected a candidate review detail, got ${JSON.stringify(detail)}`);
	}
	return detail.content;
}

function confirmationOf(human: ReturnType<typeof gate>): WorkbenchConfirmation {
	const confirmation = human.confirm.mock.calls[0]?.[0];
	if (!confirmation) throw new Error("the human gate was never consulted");
	return confirmation;
}

function subjectOf(confirmation: WorkbenchConfirmation): Record<string, unknown> {
	return confirmation.subject as Record<string, unknown>;
}

function expectImpactProjection(impact: WorkbenchCandidateImpactProjection | null): void {
	expect(impact).not.toBeNull();
	if (!impact) return;
	if (impact.available) expect(impact.impact).toBeTypeOf("object");
	else expect(impact.reason).toBeTypeOf("string");
}

function candidateSelection(view: WorkbenchView, candidateId: string) {
	return view.selections.find((item) => item.kind === "candidate" && item.id === candidateId);
}

function head(fixture: CycleFixture): string {
	return git(fixture.projectDir, "rev-parse", "HEAD");
}

function adoptionReceiptPath(fixture: CycleFixture): string {
	return join(fixture.stateRoot, "target-adoptions", fixture.candidateId, "receipt.json");
}

function continuationReceiptPath(fixture: CycleFixture): string {
	return join(
		fixture.stateRoot,
		"projects",
		fixture.projectId,
		"workbench",
		"cycle-continuations",
		fixture.candidateId,
		"receipt.json",
	);
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("Workbench improvement-cycle closure", () => {
	describe("promoted candidate", () => {
		// One promoted fixture is driven through the whole adoption/continuation
		// lifecycle in order: read-only checks and refusals first, then the
		// fast-forward, the continuation, replay refusal, and finally tampering.
		let fixture: CycleFixture;

		beforeAll(async () => {
			fixture = await terminalCandidateFixture("promoted");
		});

		afterAll(() => {
			cleanupPaths(fixture);
		});

		it("puts the focused promoted candidate at candidate-adoption and refuses every other decision", async () => {
			const view = await fixture.workbench.view();
			expect(view).toMatchObject({
				stage: "candidate-adoption",
				actions: ["adopt-candidate"],
				blockers: [],
				focus: { candidate: fixture.candidateId },
				target: { status: "ready", id: fixture.projectId, gitSha: fixture.baselineSha },
			});
			expect(candidateSelection(view, fixture.candidateId)).toMatchObject({ status: "promoted", selected: true });

			const review = candidateReview(await fixture.workbench.view({ aspect: "review" }));
			expect(review).toMatchObject({
				kind: "candidate",
				candidateId: fixture.candidateId,
				status: "promoted",
				projectId: fixture.projectId,
				proposalId: fixture.proposalRunId,
				baseline: { sha: fixture.baselineSha },
				candidate: { sha: fixture.candidateSha },
				sealedHoldout: { executed: true, gatePassed: true },
				review: { recommendation: "promote" },
				promotion: { tag: fixture.tag, at: NOW },
				rejection: null,
				adoption: null,
				continuation: null,
			});
			expectImpactProjection(review.impact);

			const human = gate();
			await expect(fixture.workbench.decide({ kind: "continue-cycle", reason: "Too early to close" }, human))
				.rejects.toThrow(/continue-cycle is not legal during candidate-adoption/);
			await expect(fixture.workbench.decide({ kind: "run-current", repetitions: 1, reason: "Too early to run" }, human))
				.rejects.toThrow(/not legal during candidate-adoption/);
			await expect(fixture.workbench.decide({ kind: "reject-candidate", reason: "Already promoted" }, human))
				.rejects.toThrow(/reject-candidate is not legal during candidate-adoption/);
			expect(human.confirm).not.toHaveBeenCalled();
			expect(head(fixture)).toBe(fixture.baselineSha);
		});

		it("refuses adoption on a dirty worktree before consulting the human gate and writes nothing", async () => {
			const stray = join(fixture.projectDir, "operator-scratch.txt");
			writeFileSync(stray, "not yet committed\n", "utf8");
			try {
				const human = gate();
				await expect(fixture.workbench.decide({ kind: "adopt-candidate", reason: "Adopt over a dirty tree" }, human))
					.rejects.toThrow(/clean worktree/);
				expect(human.confirm).not.toHaveBeenCalled();
				expect(existsSync(join(fixture.stateRoot, "target-adoptions"))).toBe(false);
				expect(head(fixture)).toBe(fixture.baselineSha);
			} finally {
				rmSync(stray);
			}
			expect(git(fixture.projectDir, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
		});

		it("leaves HEAD and evidence untouched when the human declines adoption", async () => {
			const declined = gate(false);
			await expect(fixture.workbench.decide({ kind: "adopt-candidate", reason: "Not this one" }, declined))
				.rejects.toBeInstanceOf(WorkbenchDecisionDeclinedError);
			expect(declined.confirm).toHaveBeenCalledOnce();
			expect(head(fixture)).toBe(fixture.baselineSha);
			expect(existsSync(adoptionReceiptPath(fixture))).toBe(false);
			expect(existsSync(join(fixture.stateRoot, "target-adoptions", fixture.candidateId, "intent.json"))).toBe(false);
			expect((await fixture.workbench.view()).stage).toBe("candidate-adoption");
		});

		it("fast-forwards the current branch through the exact confirmed subject and records a private receipt", async () => {
			const reason = "Make the promoted candidate the active Target";
			const human = gate();
			const adopted = await fixture.workbench.decide({ kind: "adopt-candidate", reason }, human);

			expect(human.confirm).toHaveBeenCalledOnce();
			const confirmation = confirmationOf(human);
			const exactRecord = loadCandidateRecord(fixture.runsRoot, fixture.candidateId);
			expect(confirmation).toMatchObject({
				kind: "adopt-candidate",
				title: expect.stringMatching(/adopt/i),
				reason,
				subjectHash: expect.stringMatching(SHA256),
				subject: {
					operation: "adopt-candidate",
					candidateHash: hashValue(exactRecord),
					candidate: { candidateId: fixture.candidateId, status: "promoted" },
					adoption: {
						algorithmId: "promoted-candidate-fast-forward-v1",
						branch: { name: fixture.branch, ref: `refs/heads/${fixture.branch}` },
						candidate: {
							candidateId: fixture.candidateId,
							targetId: fixture.projectId,
							candidateRecordHash: hashValue(exactRecord),
							baseline: { sha: fixture.baselineSha },
							revision: { sha: fixture.candidateSha },
							changedFiles: ["AGENTS.md"],
						},
						promotion: { tag: fixture.tag, tagRef: `refs/tags/${fixture.tag}`, actorId: ACTOR_ID },
						subjectHash: expect.stringMatching(SHA256),
					},
				},
			});
			expect(confirmation.subjectHash).toBe(hashValue(confirmation.subject));

			expect(adopted.result).toEqual({
				candidate: expect.objectContaining({ candidateId: fixture.candidateId, status: "promoted" }),
				disposition: "adopted",
				branch: fixture.branch,
				fromSha: fixture.baselineSha,
				toSha: fixture.candidateSha,
				tag: fixture.tag,
				receiptId: expect.stringMatching(/^target-adoption-receipt-[0-9a-f]{64}$/),
			});
			expect(adopted.message).toContain(fixture.tag);

			expect(head(fixture)).toBe(fixture.candidateSha);
			expect(git(fixture.projectDir, "symbolic-ref", "HEAD")).toBe(`refs/heads/${fixture.branch}`);
			expect(git(fixture.projectDir, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
			expect(readFileSync(join(fixture.projectDir, "AGENTS.md"), "utf8")).toBe(CANDIDATE_AGENTS_MD);

			const receiptPath = adoptionReceiptPath(fixture);
			expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
			expect(statSync(join(fixture.stateRoot, "target-adoptions", fixture.candidateId, "intent.json")).mode & 0o777).toBe(0o600);
			expect(loadTargetAdoptionReceipt(fixture.stateRoot, fixture.candidateId)).toMatchObject({
				receiptId: adopted.result.receiptId,
				previousHead: fixture.baselineSha,
				adoptedHead: fixture.candidateSha,
				branchRef: `refs/heads/${fixture.branch}`,
				adoptedAt: NOW,
				intent: {
					actor: { kind: "human", id: ACTOR_ID },
					reason,
					subject: { subjectHash: subjectOf(confirmation).adoption && (subjectOf(confirmation).adoption as { subjectHash: string }).subjectHash },
				},
			});

			expect(adopted.view).toMatchObject({
				stage: "complete",
				actions: ["continue-cycle"],
				blockers: [],
				focus: { candidate: fixture.candidateId },
				target: { gitSha: fixture.candidateSha },
			});
			expect(candidateSelection(adopted.view, fixture.candidateId)).toMatchObject({ status: "promoted · adopted" });
			const review = candidateReview(await fixture.workbench.view({ aspect: "review" }));
			expect(review).toMatchObject({
				kind: "candidate",
				status: "promoted",
				adoption: { receiptId: adopted.result.receiptId, adoptedAt: NOW, branch: fixture.branch },
				continuation: null,
			});
			expectImpactProjection(review.impact);

			const again = gate();
			await expect(fixture.workbench.decide({ kind: "adopt-candidate", reason: "Adopt twice" }, again))
				.rejects.toThrow(/adopt-candidate is not legal during complete/);
			expect(again.confirm).not.toHaveBeenCalled();
			expect(head(fixture)).toBe(fixture.candidateSha);
		});

		it("closes the cycle after adoption, releases the candidate focus, and derives the next stage from artifacts", async () => {
			const reason = "Start the next measured cycle from the adopted Target";
			const human = gate();
			const continued = await fixture.workbench.decide({ kind: "continue-cycle", reason }, human);

			expect(human.confirm).toHaveBeenCalledOnce();
			const confirmation = confirmationOf(human);
			expect(confirmation).toMatchObject({
				kind: "continue-cycle",
				reason,
				subjectHash: expect.stringMatching(SHA256),
				subject: {
					operation: "continue-cycle",
					candidateHash: hashValue(loadCandidateRecord(fixture.runsRoot, fixture.candidateId)),
					candidate: { candidateId: fixture.candidateId, status: "promoted" },
					continuation: {
						algorithmId: "terminal-candidate-cycle-continuation-v1",
						projectId: fixture.projectId,
						targetId: fixture.projectId,
						candidate: {
							candidateId: fixture.candidateId,
							status: "promoted",
							baselineSha: fixture.baselineSha,
							builtSha: fixture.candidateSha,
						},
						activeTargetSha: fixture.candidateSha,
						branchRef: `refs/heads/${fixture.branch}`,
						adoptionReceiptHash: expect.stringMatching(SHA256),
					},
				},
			});
			expect(confirmation.subjectHash).toBe(hashValue(confirmation.subject));

			expect(continued.result).toMatchObject({
				candidate: { candidateId: fixture.candidateId, status: "promoted" },
				disposition: "recorded",
				activeTargetSha: fixture.candidateSha,
				receiptId: expect.stringMatching(/^cycle-continuation-receipt-[0-9a-f]{64}$/),
			});
			// The adoption moved HEAD, so the baseline development EvalRun is no
			// longer compatible with the active Target revision: the next cycle
			// starts by measuring again rather than authoring from stale evidence.
			expect(continued.result.nextStage).toBe("ready-to-evaluate");
			expect(continued.view.stage).toBe(continued.result.nextStage);
			expect(continued.view.actions).toEqual(["run"]);
			expect(continued.view.counts.developmentEvals).toBe(1);
			expect(continued.view.focus.candidate).toBeUndefined();
			expect(continued.view.target.gitSha).toBe(fixture.candidateSha);
			expect(continued.message).toContain("ready-to-evaluate");
			expect(candidateSelection(continued.view, fixture.candidateId)).toMatchObject({
				status: "promoted · cycle closed",
				selected: false,
			});

			const receiptPath = continuationReceiptPath(fixture);
			expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
			const continuation = subjectOf(confirmation).continuation as { subjectHash: string };
			expect(loadCycleContinuationReceipt(fixture.stateRoot, fixture.projectId, fixture.candidateId)).toMatchObject({
				receiptId: continued.result.receiptId,
				continuedAt: NOW,
				actor: { kind: "human", id: ACTOR_ID },
				reason,
				subject: { subjectHash: continuation.subjectHash, activeTargetSha: fixture.candidateSha },
			});
			// Continuation never mutates Git.
			expect(head(fixture)).toBe(fixture.candidateSha);
			expect(git(fixture.projectDir, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");

			// A fresh Workbench derives the same stage from artifacts alone.
			const restarted = await createAhdeWorkbench({
				projectDir: fixture.projectDir,
				stateRoot: fixture.stateRoot,
				runsRoot: fixture.runsRoot,
				projectId: fixture.projectId,
			}).view();
			expect(restarted.stage).toBe("ready-to-evaluate");
			expect(restarted.focus.candidate).toBeUndefined();
			expect(restarted.blockers).toEqual([]);
		});

		it("rejects replaying continue-cycle for a closed candidate, even after refocusing it", async () => {
			const human = gate();
			await expect(fixture.workbench.decide({
				kind: "continue-cycle",
				candidateId: fixture.candidateId,
				reason: "Replay the closed cycle",
			}, human)).rejects.toThrow(/continue-cycle is not legal during ready-to-evaluate/);

			await fixture.workbench.submit({ kind: "select", entity: "candidate", id: fixture.candidateId });
			const refocused = await fixture.workbench.view();
			expect(refocused.focus.candidate).toBe(fixture.candidateId);
			expect(refocused.stage).toBe("ready-to-evaluate");
			await expect(fixture.workbench.decide({ kind: "continue-cycle", reason: "Replay after refocus" }, human))
				.rejects.toThrow(/continue-cycle is not legal during ready-to-evaluate/);
			await expect(fixture.workbench.decide({ kind: "adopt-candidate", reason: "Adopt after refocus" }, human))
				.rejects.toThrow(/adopt-candidate is not legal during ready-to-evaluate/);
			expect(human.confirm).not.toHaveBeenCalled();
			expect(loadCycleContinuationReceipt(fixture.stateRoot, fixture.projectId, fixture.candidateId)?.continuedAt).toBe(NOW);
		});

		it("blocks the Workbench when the adoption receipt no longer binds the candidate", async () => {
			const receiptPath = adoptionReceiptPath(fixture);
			const tampered = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
			tampered.adoptedAt = "2027-01-01T00:00:00.000Z";
			writeFileSync(receiptPath, `${JSON.stringify(tampered)}\n`, "utf8");
			chmodSync(receiptPath, 0o600);

			const blocked = await createAhdeWorkbench({
				projectDir: fixture.projectDir,
				stateRoot: fixture.stateRoot,
				runsRoot: fixture.runsRoot,
				projectId: fixture.projectId,
			});
			const view = await blocked.view();
			expect(view.stage).toBe("selection-required");
			expect(view.actions).toEqual([]);
			expect(view.blockers).toEqual(expect.arrayContaining([
				expect.stringContaining(fixture.candidateId),
			]));
			expect(view.blockers.join("\n")).toMatch(/Target adoption receipt/);

			const human = gate();
			await expect(blocked.decide({ kind: "continue-cycle", reason: "Blocked" }, human))
				.rejects.toThrow(/not legal during selection-required/);
			expect(human.confirm).not.toHaveBeenCalled();
		});
	});

	describe("rejected candidate", () => {
		let fixture: CycleFixture;
		const candidateImpact = vi.fn<AhdeWorkbenchDependencies["candidateImpact"]>(() => ({
			available: false,
			reason: "impact projection stubbed by the cycle fixture",
		}));

		beforeAll(async () => {
			fixture = await terminalCandidateFixture("rejected", { candidateImpact });
		});

		afterAll(() => {
			cleanupPaths(fixture);
		});

		it("reaches complete directly, refuses adoption, and continues at the baseline", async () => {
			const view = await fixture.workbench.view();
			expect(view).toMatchObject({
				stage: "complete",
				actions: ["continue-cycle"],
				blockers: [],
				headline: expect.stringContaining("rejected"),
				focus: { candidate: fixture.candidateId },
				target: { gitSha: fixture.baselineSha },
			});

			const review = candidateReview(await fixture.workbench.view({ aspect: "review" }));
			expect(review).toMatchObject({
				kind: "candidate",
				candidateId: fixture.candidateId,
				status: "rejected",
				review: { recommendation: "reject" },
				promotion: null,
				rejection: { reason: expect.any(String), at: NOW },
				adoption: null,
				continuation: null,
				impact: { available: false, reason: "impact projection stubbed by the cycle fixture" },
			});
			expect(candidateImpact).toHaveBeenCalledWith({
				runsRoot: fixture.runsRoot,
				stateRoot: fixture.stateRoot,
				projectId: fixture.projectId,
				candidate: expect.objectContaining({ candidateId: fixture.candidateId }),
			});

			const human = gate();
			await expect(fixture.workbench.decide({ kind: "adopt-candidate", reason: "Adopt a rejected candidate" }, human))
				.rejects.toThrow(/adopt-candidate is not legal during complete/);
			expect(human.confirm).not.toHaveBeenCalled();

			const reason = "Keep the baseline and author the next proposal";
			const continued = await fixture.workbench.decide({ kind: "continue-cycle", reason }, human);
			expect(human.confirm).toHaveBeenCalledOnce();
			const confirmation = confirmationOf(human);
			expect(confirmation).toMatchObject({
				kind: "continue-cycle",
				subject: {
					operation: "continue-cycle",
					candidate: { candidateId: fixture.candidateId, status: "rejected" },
					continuation: {
						candidate: { status: "rejected", baselineSha: fixture.baselineSha, builtSha: fixture.candidateSha },
						activeTargetSha: fixture.baselineSha,
						branchRef: `refs/heads/${fixture.branch}`,
						adoptionReceiptHash: null,
					},
				},
			});

			expect(continued.result).toMatchObject({
				candidate: { candidateId: fixture.candidateId, status: "rejected" },
				disposition: "recorded",
				activeTargetSha: fixture.baselineSha,
				receiptId: expect.stringMatching(/^cycle-continuation-receipt-[0-9a-f]{64}$/),
			});
			// HEAD never moved, so the baseline development EvalRun stays compatible
			// and the next cycle resumes at authoring instead of re-measuring.
			expect(continued.result.nextStage).toBe("improvement-authoring");
			expect(continued.view.stage).toBe(continued.result.nextStage);
			expect(continued.view.focus.candidate).toBeUndefined();
			expect(candidateSelection(continued.view, fixture.candidateId)).toMatchObject({
				status: "rejected · cycle closed",
				selected: false,
			});
			expect(head(fixture)).toBe(fixture.baselineSha);
			expect(git(fixture.projectDir, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
			expect(existsSync(join(fixture.stateRoot, "target-adoptions"))).toBe(false);
			expect(statSync(continuationReceiptPath(fixture)).mode & 0o777).toBe(0o600);
			expect(loadCycleContinuationReceipt(fixture.stateRoot, fixture.projectId, fixture.candidateId)).toMatchObject({
				receiptId: continued.result.receiptId,
				subject: { activeTargetSha: fixture.baselineSha, adoptionReceiptHash: null },
			});

			const replay = gate();
			await expect(fixture.workbench.decide({
				kind: "continue-cycle",
				candidateId: fixture.candidateId,
				reason: "Replay the closed cycle",
			}, replay)).rejects.toThrow(/continue-cycle is not legal during improvement-authoring/);
			expect(replay.confirm).not.toHaveBeenCalled();
		});
	});

	it("reports the Target model identity with host-side credential presence and never the secret", async () => {
		const paths = targetPaths();
		try {
			const inventory = loadWorkbenchInventory({ ...paths, projectId: PROJECT_ID });
			expect(deriveWorkbenchView(inventory, {}).target.model).toEqual({
				provider: "qwen-internal",
				id: "qwen3.5-27b",
				apiKeyEnv: "TEST_MODEL_KEY",
				credentialPresent: false,
			});
			expect(deriveWorkbenchView(inventory, { TEST_MODEL_KEY: "   " }).target.model?.credentialPresent).toBe(false);
			expect(deriveWorkbenchView(inventory, { OTHER_KEY: "sk-fixture-secret" }).target.model?.credentialPresent).toBe(false);
			const present = deriveWorkbenchView(inventory, { TEST_MODEL_KEY: "sk-fixture-secret" });
			expect(present.target.model?.credentialPresent).toBe(true);
			expect(JSON.stringify(present)).not.toContain("sk-fixture-secret");

			vi.stubEnv("TEST_MODEL_KEY", "");
			expect((await createAhdeWorkbench({ ...paths, projectId: PROJECT_ID }).view()).target.model)
				.toMatchObject({ apiKeyEnv: "TEST_MODEL_KEY", credentialPresent: false });
			vi.stubEnv("TEST_MODEL_KEY", "sk-fixture-secret");
			const live = await createAhdeWorkbench({ ...paths, projectId: PROJECT_ID }).view();
			expect(live.target.model).toEqual({
				provider: "qwen-internal",
				id: "qwen3.5-27b",
				apiKeyEnv: "TEST_MODEL_KEY",
				credentialPresent: true,
			});
			expect(JSON.stringify(live)).not.toContain("sk-fixture-secret");
		} finally {
			cleanupPaths(paths);
		}
	});

	it("accepts adopt-candidate and continue-cycle in both the Zod and TypeBox decision contracts", () => {
		const valid = [
			{ kind: "adopt-candidate", reason: "Adopt the promoted candidate" },
			{ kind: "adopt-candidate", candidateId: "candidate-cycle-1", reason: "Adopt one exact candidate" },
			{ kind: "continue-cycle", reason: "Start the next cycle" },
			{ kind: "continue-cycle", candidateId: "candidate-cycle-1", reason: "Close one exact candidate" },
		];
		for (const input of valid) {
			expect(WorkbenchDecisionInputSchema.parse(input)).toEqual(input);
			expect(Check(WorkbenchDecisionToolSchema.parameters, input)).toBe(true);
		}

		const invalid = [
			{ kind: "adopt-candidate", reason: "   " },
			{ kind: "adopt-candidate", reason: "Adopt", force: true },
			{ kind: "continue-cycle" },
			{ kind: "continue-cycle", candidateId: "../escape", reason: "Traverse" },
			{ kind: "continue-cycle", reason: "x".repeat(4_001) },
		];
		for (const input of invalid) {
			expect(WorkbenchDecisionInputSchema.safeParse(input).success).toBe(false);
			expect(Check(WorkbenchDecisionToolSchema.parameters, input)).toBe(false);
		}
	});
});
