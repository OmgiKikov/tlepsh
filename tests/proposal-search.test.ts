import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compileExperimentHistory } from "../src/application/experiment-history.js";
import {
	MAX_SEARCH_CANDIDATES,
	PROPOSAL_SEARCH_FORBIDDEN_DECISIONS,
	PROPOSAL_SEARCH_SKIP_MESSAGES,
	PROPOSAL_SEARCH_STOP_MESSAGES,
	ProposalSearchError,
	ProposalSearchForbiddenDecisionError,
	assertProposalSearchGate,
	newProposalSearchId,
	plannedProposalSearchExecutions,
	proposalSearchGate,
	renderProposalSearchTable,
	runProposalSearch,
	searchCandidateLine,
	type ProposalSearchDependencies,
	type ProposalSearchResult,
} from "../src/application/proposal-search.js";
import { loadCandidateRecord } from "../src/application/candidate-review.js";
import { screenEvalRunIds } from "../src/application/cheap-check.js";
import { loadEvalRun } from "../src/eval.js";
import { candidateStatus } from "../src/domain/candidate.js";
import { loadBuilderApplyReceipt } from "../src/application/builder-proposal.js";
import { listCorpora } from "../src/corpus.js";
import { SEALED_VERIFICATION_REPETITIONS } from "./helpers/sealed-holdout.js";
import {
	approvingGate,
	improveFixture,
	NO_OP_INSTRUCTION,
	READY_INSTRUCTION,
	recordFixtureProposal,
	type ImproveFixture,
} from "./helpers/improve-fixtures.js";

it("gives standalone searches collision-resistant branch namespaces", () => {
	const first = newProposalSearchId();
	const second = newProposalSearchId();
	expect(first).toMatch(/^[0-9a-f]{24}$/);
	expect(second).not.toBe(first);
});

/**
 * Search, not one guess. These tests are about the three promises the module
 * makes: the table says which hypotheses are dominated, a flat screen never
 * costs a verification and is reported by name, and nothing in a search can
 * promote, adopt, publish, or open the sealed holdout.
 */

function branches(projectDir: string): string[] {
	return execFileSync("git", ["-C", projectDir, "branch", "--format=%(refname:short)"], { encoding: "utf8" })
		.split("\n").map((line) => line.trim()).filter(Boolean).sort();
}

function tags(projectDir: string): string[] {
	return execFileSync("git", ["-C", projectDir, "tag", "-l"], { encoding: "utf8" })
		.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** A screen result shaped like the one `runCheapCheck` returns. */
function screenResult(verdict: "promising" | "flat", improved: number, id: string) {
	return {
		tasks: ["a", "b"],
		improved,
		unchanged: 2 - improved,
		regressed: 0,
		inconclusive: 0,
		verdict,
		runIds: ["r1", "r2"],
		rows: [],
		withinErrorBudget: true,
		screenId: `screen-${id}`,
		screenEvalRunId: `erun_${id}`,
		screenRecordPath: "/dev/null",
		sourceEvalRunId: "erun_source",
		candidateSha: "0".repeat(40),
	};
}

/** A verification result shaped like the one `runAppliedBuilderCandidate` returns. */
function verificationResult(input: {
	candidateId: string;
	verdict: string;
	scoreDelta: number;
	costRatio: number | null;
}) {
	return {
		record: { candidateId: input.candidateId },
		baseline: { summary: { total: 4 } },
		candidate: { summary: { total: 4 } },
		compare: {
			gate: { verdict: input.verdict },
			summary: {
				scoreDelta: input.scoreDelta,
				confidence95: { low: input.scoreDelta - 0.05, high: input.scoreDelta + 0.05 },
				delta: input.scoreDelta,
				candidatePassRate: 0.5 + input.scoreDelta,
			},
			design: { tasks: 2, repetitions: 2 },
			resources: { costRatio: input.costRatio, latencyRatio: 1, tokenRatio: 1 },
		},
	};
}

function searchOptions(fixture: ImproveFixture, proposalRunIds: string[], failureModeId: string, overrides: Record<string, unknown> = {}) {
	return {
		repositoryDir: fixture.projectDir,
		runsRoot: fixture.runsRoot,
		stateRoot: fixture.stateRoot,
		projectId: fixture.projectId,
		approvedSpecId: fixture.approvedSpecId,
		failureModeId,
		proposalRunIds,
		developmentCorpus: {
			stateRoot: fixture.stateRoot,
			projectId: fixture.projectId,
			corpusId: fixture.corpusId,
		},
		developmentTasks: 2,
		repetitions: SEALED_VERIFICATION_REPETITIONS,
		branchPrefix: "candidate/search-",
		...overrides,
	} as Parameters<typeof runProposalSearch>[0];
}

describe("the Pareto table", () => {
	let fixture: ImproveFixture;
	let result: ProposalSearchResult;

	beforeAll(async () => {
		fixture = await improveFixture();
		const first = await recordFixtureProposal(fixture, READY_INSTRUCTION);
		const second = await recordFixtureProposal(fixture, `${READY_INSTRUCTION} Be brief.`);
		const third = await recordFixtureProposal(fixture, `${READY_INSTRUCTION} Be very brief.`);
		const verdicts = new Map([
			// A modest win at baseline cost.
			[1, verificationResult({ candidateId: "cand-1", verdict: "improved", scoreDelta: 0.1, costRatio: 1 })],
			// A bigger win, but twice the money: neither dominates the other.
			[2, verificationResult({ candidateId: "cand-2", verdict: "improved", scoreDelta: 0.2, costRatio: 2 })],
			// Worse on both axes than the first: dominated.
			[3, verificationResult({ candidateId: "cand-3", verdict: "improved", scoreDelta: 0.05, costRatio: 1.5 })],
		]);
		let call = 0;
		result = await runProposalSearch(
			searchOptions(fixture, [first.runId, second.runId, third.runId], first.failureModeId),
			{
				runCheapCheck: (async () =>
					screenResult("promising", 2, `screen${++call}`)) as unknown as ProposalSearchDependencies["runCheapCheck"],
				runAppliedCandidate: (async (options: { builderRunId: string }) => {
					const ordinal = [first.runId, second.runId, third.runId].indexOf(options.builderRunId) + 1;
					return verdicts.get(ordinal);
				}) as unknown as ProposalSearchDependencies["runAppliedCandidate"],
			},
		);
	}, 600_000);

	afterAll(async () => {
		await fixture?.close();
	});

	it("marks a candidate dominated when another is at least as good on score and cost", () => {
		expect(result.rows.map((row) => row.status)).toEqual(["verified", "verified", "verified"]);
		expect(result.rows.map((row) => row.dominated)).toEqual([false, false, true]);
		expect(result.rows[2]?.dominatedBy).toBe(1);
		// Best score first, then cheapest, then candidate order.
		expect(result.frontier).toEqual([2, 1]);
		expect(result.stopReason).toBe("search-complete");
		expect(result.stopMessage).toBe(PROPOSAL_SEARCH_STOP_MESSAGES["search-complete"]);
	});

	it("gives each hypothesis its own branch and reports what the whole search spent", () => {
		expect(result.rows.map((row) => row.branch)).toEqual([
			"candidate/search-1",
			"candidate/search-2",
			"candidate/search-3",
		]);
		expect(result.rows.every((row) => row.changedPaths.includes("AGENTS.md"))).toBe(true);
		expect(result.executions).toBe(result.rows.reduce((sum, row) => sum + row.executions, 0));
		expect(result.plannedExecutions).toBe(plannedProposalSearchExecutions({
			developmentTasks: 2,
			repetitions: SEALED_VERIFICATION_REPETITIONS,
			candidates: 3,
		}));
	});

	it("renders a table a human can pick from, with the domination spelled out", () => {
		const table = renderProposalSearchTable(result);
		const rows = table.split("\n");
		expect(rows[0]).toBe("| # | branch | changed | screen | verdict | score Δ | 95% CI | cost | latency | frontier |");
		expect(rows[2]).toContain("candidate/search-1");
		expect(rows[2]).toContain("+10.0pp");
		expect(rows[2]).toContain("×1.0");
		expect(rows[4]).toContain("dominated by 1");
		expect(table).toContain("Pick one: candidate 2, candidate 1.");
		expect(table).toContain("The sealed guardrail and the promotion run on the one you pick, unchanged.");
		expect(searchCandidateLine(result.rows[0]!)).toContain("verify improved +10.0pp cost ×1.0");
	});

	it("keeps a non-empty frontier when two hypotheses measure identically", async () => {
		const first = await recordFixtureProposal(fixture, `${READY_INSTRUCTION} Twin one.`);
		const second = await recordFixtureProposal(fixture, `${READY_INSTRUCTION} Twin two.`);
		const tie = await runProposalSearch(
			searchOptions(fixture, [first.runId, second.runId], first.failureModeId, { branchPrefix: "candidate/tie-" }),
			{
				runCheapCheck: (async () =>
					screenResult("promising", 1, "tie")) as unknown as ProposalSearchDependencies["runCheapCheck"],
				runAppliedCandidate: (async (options: { builderRunId: string }) =>
					verificationResult({
						candidateId: `tie-${options.builderRunId}`,
						verdict: "improved",
						scoreDelta: 0.3,
						costRatio: 1,
					})) as unknown as ProposalSearchDependencies["runAppliedCandidate"],
			},
		);
		// Worse-or-equal on both is domination, broken by candidate order so the
		// human is never handed an empty frontier.
		expect(tie.rows.map((row) => row.dominated)).toEqual([false, true]);
		expect(tie.rows[1]?.dominatedBy).toBe(1);
		expect(tie.frontier).toEqual([1]);
	});
});

it("never puts a non-improved hypothesis on the release frontier", async () => {
	const fixture = await improveFixture();
	try {
		const first = await recordFixtureProposal(fixture, READY_INSTRUCTION);
		const second = await recordFixtureProposal(fixture, `${READY_INSTRUCTION} Another attempt.`);
		const result = await runProposalSearch(
			searchOptions(fixture, [first.runId, second.runId], first.failureModeId),
			{
				runCheapCheck: (async () => screenResult("promising", 1, "non-improved")) as unknown as ProposalSearchDependencies["runCheapCheck"],
				runAppliedCandidate: (async () =>
					verificationResult({ candidateId: "candidate-flat", verdict: "unchanged", scoreDelta: 0, costRatio: 1 })) as unknown as ProposalSearchDependencies["runAppliedCandidate"],
			},
		);
		expect(result.frontier).toEqual([]);
		const table = renderProposalSearchTable(result);
		expect(table).toContain("not improved");
		expect(table).toContain("nothing here is ready for the sealed gate");
	} finally {
		await fixture.close();
	}
}, 600_000);

describe("what a search refuses to spend", () => {
	it("keeps a flat screen out of the verification and says so by name", async () => {
		const fixture = await improveFixture();
		try {
			const first = await recordFixtureProposal(fixture, NO_OP_INSTRUCTION);
			const second = await recordFixtureProposal(fixture, READY_INSTRUCTION);
			const runAppliedCandidate = vi.fn(async () =>
				verificationResult({ candidateId: "cand-second", verdict: "improved", scoreDelta: 0.4, costRatio: 1 }));
			let call = 0;
			const result = await runProposalSearch(
				searchOptions(fixture, [first.runId, second.runId], first.failureModeId),
				{
					runCheapCheck: (async () => {
						call += 1;
						return call === 1 ? screenResult("flat", 0, "flat") : screenResult("promising", 2, "promising");
					}) as unknown as ProposalSearchDependencies["runCheapCheck"],
					runAppliedCandidate: runAppliedCandidate as unknown as ProposalSearchDependencies["runAppliedCandidate"],
				},
			);

			expect(result.rows[0]).toMatchObject({ status: "screened-out", skipReason: "flat-screen", development: null });
			expect(result.rows[1]).toMatchObject({ status: "verified", skipReason: null });
			// One verification for two hypotheses: the screen paid for itself.
			expect(runAppliedCandidate).toHaveBeenCalledTimes(1);
			// A screened-out candidate has no verdict, so it neither dominates nor
			// is dominated; it is reported instead of being silently dropped.
			expect(result.rows[0]?.dominated).toBe(false);
			expect(result.frontier).toEqual([2]);
			expect(renderProposalSearchTable(result)).toContain(
				`Candidate 1 did not reach a verdict: ${PROPOSAL_SEARCH_SKIP_MESSAGES["flat-screen"]}.`,
			);
		} finally {
			await fixture.close();
		}
	}, 600_000);

	it("stops at its one estimate and names the candidates the budget cut", async () => {
		const fixture = await improveFixture();
		try {
			const first = await recordFixtureProposal(fixture, READY_INSTRUCTION);
			const second = await recordFixtureProposal(fixture, `${READY_INSTRUCTION} Again.`);
			const third = await recordFixtureProposal(fixture, `${READY_INSTRUCTION} Once more.`);
			const runAppliedCandidate = vi.fn(async () =>
				verificationResult({ candidateId: "cand-1", verdict: "improved", scoreDelta: 0.4, costRatio: 1 }));
			const result = await runProposalSearch(
				// One screen (2 cases) plus one verification (2 tasks × 2 reps × 2
				// arms) fits in 12; the second verification does not.
				searchOptions(fixture, [first.runId, second.runId, third.runId], first.failureModeId, { executionBudget: 12 }),
				{
					runCheapCheck: (async () =>
						screenResult("promising", 2, "screen")) as unknown as ProposalSearchDependencies["runCheapCheck"],
					runAppliedCandidate: runAppliedCandidate as unknown as ProposalSearchDependencies["runAppliedCandidate"],
				},
			);

			expect(runAppliedCandidate).toHaveBeenCalledTimes(1);
			// The second learned the budget was gone only after its own screen; the
			// third is not applied or screened at all, because an estimate the
			// operator answered one question about bounds the whole search.
			expect(result.rows[1]).toMatchObject({ status: "skipped", skipReason: "execution-budget" });
			expect(result.rows[2]).toMatchObject({ status: "skipped", skipReason: "execution-budget" });
			expect(result.rows[2]?.branch).toBeNull();
			expect(result.rows[2]?.screen).toBeNull();
			expect(result.rows[2]?.executions).toBe(0);
			expect(result.stopReason).toBe("execution-budget-exhausted");
			const table = renderProposalSearchTable(result);
			for (const ordinal of [2, 3]) {
				expect(table).toContain(
					`Candidate ${ordinal} did not reach a verdict: ${PROPOSAL_SEARCH_SKIP_MESSAGES["execution-budget"]}.`,
				);
			}
		} finally {
			await fixture.close();
		}
	}, 600_000);

	it("refuses a hypothesis aimed at another failure mode, and a search of one", async () => {
		const fixture = await improveFixture();
		try {
			const first = await recordFixtureProposal(fixture, READY_INSTRUCTION);
			const second = await recordFixtureProposal(fixture, `${READY_INSTRUCTION} Again.`);
			await expect(runProposalSearch(searchOptions(fixture, [first.runId], first.failureModeId)))
				.rejects.toThrow(/between 2 and 4 hypotheses/);
			await expect(runProposalSearch(searchOptions(fixture, [first.runId, first.runId], first.failureModeId)))
				.rejects.toThrow(/the same proposal cannot be two hypotheses/);
			await expect(runProposalSearch(searchOptions(fixture, [first.runId, second.runId], `failure-mode-${"f".repeat(24)}`)))
				.rejects.toThrow(ProposalSearchError);
			expect(MAX_SEARCH_CANDIDATES).toBe(4);
		} finally {
			await fixture.close();
		}
	}, 600_000);
});

describe("a search creates no release authority", () => {
	it("throws on every decision that creates one, and never opens the holdout", async () => {
		const inner = approvingGate();
		const guarded = proposalSearchGate(inner);
		for (const kind of PROPOSAL_SEARCH_FORBIDDEN_DECISIONS) {
			await expect(guarded.confirm({
				kind,
				title: "t",
				reason: "r",
				subject: {},
				subjectHash: `sha256:${"0".repeat(64)}`,
				policy: "consequential",
				question: "q?",
			})).rejects.toThrow(ProposalSearchForbiddenDecisionError);
		}
		await expect(guarded.selectSealed({ title: "pick", options: [] }))
			.rejects.toThrow(/sealed holdout selection/);
		expect(inner.confirm).not.toHaveBeenCalled();
		expect(inner.selectSealed).not.toHaveBeenCalled();
		// Applying on a throwaway branch is the work the search was asked to do.
		expect(PROPOSAL_SEARCH_FORBIDDEN_DECISIONS).not.toContain("apply-proposal");
		for (const kind of ["promote-candidate", "adopt-candidate", "publish-corpus", "approve-spec", "ship"] as const) {
			expect(PROPOSAL_SEARCH_FORBIDDEN_DECISIONS).toContain(kind);
		}
	});

	it("refuses to start when it was handed a gate that could still approve one", async () => {
		const fixture = await improveFixture();
		try {
			const first = await recordFixtureProposal(fixture, READY_INSTRUCTION);
			const second = await recordFixtureProposal(fixture, NO_OP_INSTRUCTION);
			const raw = approvingGate();

			await expect(runProposalSearch(
				searchOptions(fixture, [first.runId, second.runId], first.failureModeId, { gate: raw }),
			)).rejects.toThrow(/only be handed a gate wrapped by proposalSearchGate/);
			// Nothing was applied before the refusal.
			expect(branches(fixture.projectDir).filter((name) => name.startsWith("candidate/"))).toEqual([]);
			expect(raw.confirm).not.toHaveBeenCalled();
			// The wrapped one is accepted — and still refuses every release decision.
			expect(() => assertProposalSearchGate(proposalSearchGate(raw))).not.toThrow();
			expect(() => assertProposalSearchGate(undefined)).not.toThrow();
		} finally {
			await fixture.close();
		}
	}, 600_000);

	it("screens and verifies for real, promotes nothing, and runs no sealed corpus", async () => {
		const fixture = await improveFixture();
		try {
			const first = await recordFixtureProposal(fixture, READY_INSTRUCTION);
			const second = await recordFixtureProposal(fixture, NO_OP_INSTRUCTION);
			const result = await runProposalSearch(
				searchOptions(fixture, [first.runId, second.runId], first.failureModeId),
			);

			// The winning hypothesis really was measured; the no-op one really was
			// screened out without spending a verification.
			expect(result.rows[0]).toMatchObject({ status: "verified", branch: "candidate/search-1" });
			expect(result.rows[0]?.development?.verdict).toBe("improved");
			expect(result.rows[1]).toMatchObject({ status: "screened-out", skipReason: "flat-screen" });
			expect(result.frontier).toEqual([1]);

			// Nothing was released: no tag, no review, no promotion, and the only
			// new branches are the search's own throwaways.
			expect(tags(fixture.projectDir)).toEqual([]);
			expect(branches(fixture.projectDir).filter((name) => name.startsWith("candidate/")))
				.toEqual(["candidate/search-1", "candidate/search-2"]);
			const firstReceipt = loadBuilderApplyReceipt(fixture.runsRoot, first.runId);
			const secondReceipt = loadBuilderApplyReceipt(fixture.runsRoot, second.runId);
			expect(firstReceipt).toMatchObject({ schemaVersion: 3, via: "proposal-search" });
			expect(secondReceipt).toMatchObject({ schemaVersion: 3, via: "proposal-search" });
			const record = loadCandidateRecord(fixture.runsRoot, result.rows[0]!.candidateId!);
			expect(candidateStatus(record)).toBe("evaluated");
			expect(record.events.some((event) => event.type === "reviewed" || event.type === "promoted")).toBe(false);
			// No sealed holdout ran: a search never asks whether something may ship.
			const evaluated = record.events.find((event) => event.type === "evaluated");
			expect(evaluated?.type === "evaluated" && evaluated.evaluation.sealedHoldout).toBeUndefined();
			// Exactly the corpora the fixture published; the search published none.
			expect(listCorpora({ stateRoot: fixture.stateRoot, projectId: fixture.projectId })).toHaveLength(2);

			// Its screens are screens: recorded as such, and carrying the one label
			// that is never reused as a baseline and never stands in for a candidate
			// arm. Its verification arms are ordinary `baseline`/`candidate` runs.
			const screens = screenEvalRunIds(fixture.runsRoot);
			expect(result.screenEvalRunIds).toHaveLength(2);
			for (const evalRunId of result.screenEvalRunIds) {
				expect(screens.has(evalRunId)).toBe(true);
				expect(loadEvalRun(fixture.runsRoot, evalRunId).label).toBe("solo");
			}

			// And the search's own answers join the project's memory, with the
			// failure mode each hypothesis was aiming at read back from its
			// attested proposal basis.
			const history = compileExperimentHistory({
				runsRoot: fixture.runsRoot,
				projectId: fixture.projectId,
			});
			expect(history.attempts[0]?.failureModeIds).toEqual([first.failureModeId]);
			expect(history.attempts[0]?.changedPaths).toEqual(["AGENTS.md"]);
			expect(screens.has(history.attempts[0]?.candidateId ?? "")).toBe(false);
		} finally {
			await fixture.close();
		}
	}, 900_000);
});
