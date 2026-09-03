import { describe, expect, it } from "vitest";
import { projectForModel } from "../src/builder/workbench-adapter.js";
import type { WorkbenchSelectionSummary, WorkbenchView } from "../src/workbench/types.js";
import { runResultLine } from "../src/application/measurement-line.js";
import { setLanguage } from "../src/i18n.js";

/** A loaded but ordinary project: 30 development evals, 5 candidates, 5 proposals. */
function loadedView(): WorkbenchView {
	const selections: WorkbenchSelectionSummary[] = [
		...Array.from({ length: 30 }, (_, index) => ({
			kind: "eval-run" as const,
			id: `evalrun-2026-08-2${index % 10}-${"a".repeat(12)}${index}`,
			label: `${20 + (index % 10)}/40 passed`,
			status: "complete",
			selected: index === 29,
		})),
		...Array.from({ length: 5 }, (_, index) => ({
			kind: "candidate" as const,
			id: `candidate-${"b".repeat(20)}${index}`,
			label: `proposal-${"c".repeat(20)}${index}`,
			status: "evaluated",
			selected: false,
		})),
		...Array.from({ length: 5 }, (_, index) => ({
			kind: "proposal" as const,
			id: `builder-run-${"d".repeat(20)}${index}`,
			label: "Tighten the routing instructions and add a lookup skill",
			status: "open",
			selected: index === 0,
		})),
	];
	return {
		schemaVersion: 1,
		project: { id: "demo", directory: "competitor-research" },
		stage: "proposal-review",
		headline: "Review the exact proposal diff.",
		target: {
			status: "ready",
			id: "competitor-research",
			gitSha: "a".repeat(40),
			model: { provider: "openai", id: "gpt-test", apiKeyEnv: "OPENAI_API_KEY", credentialPresent: true },
			evaluators: {
				judge: { provider: "anthropic", id: "judge-test", apiKeyEnv: "JUDGE_API_KEY", credentialPresent: false },
				simulatedUser: null,
			},
		},
		focus: { proposal: `builder-run-${"d".repeat(20)}0` },
		selections,
		actions: ["review", "apply-proposal", "discard-proposal"],
		blockers: [],
		warnings: Array.from({ length: 6 }, (_, index) => `focus eval-run legacy-${index} no longer resolves`),
		calibration: null,
		detail: {
			aspect: "review",
			content: {
				kind: "proposal",
				prediction: null,
				runId: `builder-run-${"d".repeat(20)}0`,
				proposalHash: `sha256:${"e".repeat(64)}`,
				baseTargetSha: "f".repeat(40),
				summary: "Tighten routing instructions",
				paths: ["AGENTS.md", "skills/search/SKILL.md"],
				risks: ["May over-trigger the lookup skill"],
				validationPlan: ["Re-run the development basket"],
				authoringContext: {
					algorithmId: "git-manifest-context-v1",
					targetId: "competitor-research",
					targetGitSha: "a".repeat(40),
					contextHash: `sha256:${"1".repeat(64)}`,
				} as never,
				evidenceBasis: {
					algorithmId: "exact-eval-signals-v1",
					evalRunId: "evalrun-1",
					diagnosisId: "diagnosis-1",
					briefId: `brief-${"2".repeat(24)}`,
					briefSha256: `sha256:${"3".repeat(64)}`,
					failureModes: [{ failureModeId: `failure-mode-${"4".repeat(24)}`, modeSha256: `sha256:${"5".repeat(64)}` }],
					runRefs: ["run-1", "run-2"],
				},
				exactDiff: "--- a/AGENTS.md\n+++ b/AGENTS.md\n@@\n-old\n+new\n",
			},
		},
		counts: {
			specDrafts: 2,
			approvedSpecs: 1,
			corpusDrafts: 3,
			developmentCorpora: 1,
			sealedCorpora: 1,
			developmentEvals: 30,
			openProposals: 5,
			candidates: 5,
			calibrations: 1,
		},
	};
}

const size = (value: unknown): number => JSON.stringify(value, null, 2).length;

describe("model-facing projection", () => {
	it("drops the selection list, the warning tail, and every digest field", () => {
		const view = loadedView();
		const projected = projectForModel(view) as Record<string, unknown> & {
			warnings: string[];
			detail: { content: Record<string, unknown> };
		};

		expect(projected.selections).toBe('40 selectable artifacts; call again with include: ["selections"]');
		expect(projected.warnings).toHaveLength(3);
		expect(projected.omittedWarnings).toBe(3);
		expect(projected.stage).toBe("proposal-review");
		// The host's loose `actions` hints are replaced by the derived `next`
		// block: one list of what to do here, not two.
		expect(projected.actions).toBeUndefined();
		expect(projected.next).toEqual({
			unblock: "review the diff, then say “apply” or “discard”",
			decide: [
				{ kind: "apply-proposal", asks: true, when: expect.stringContaining("apply") },
				{ kind: "talk-to-agent", asks: false, when: expect.any(String) },
				{ kind: "discard-proposal", asks: true, when: expect.any(String) },
			],
			submit: [
				{ kind: "spec-draft", when: expect.any(String) },
				{ kind: "corpus-draft", when: expect.any(String) },
				{ kind: "corpus-revision", when: expect.any(String) },
				{ kind: "corpus-import", when: expect.any(String) },
				{ kind: "dataset-recipe", when: expect.any(String) },
			],
		});
		expect(projected.counts).toEqual(view.counts);
		expect((projected.target as { model: Record<string, unknown> }).model.apiKeyEnv).toBeUndefined();
		expect(JSON.stringify(projected)).not.toMatch(/OPENAI_API_KEY|JUDGE_API_KEY|apiKeyEnv/);
		// The transcript renderer receives the unprojected details and keeps the
		// environment-variable names it needs to guide the human.
		expect(view.target.model?.apiKeyEnv).toBe("OPENAI_API_KEY");
		expect(view.target.evaluators?.judge?.apiKeyEnv).toBe("JUDGE_API_KEY");

		const content = projected.detail.content;
		expect(content.proposalHash).toBeUndefined();
		expect(content.runId).toBe(view.selections[35]?.id);
		// The persona has to echo these back to author its next call.
		expect(content.authoringContext).toEqual({
			algorithmId: "git-manifest-context-v1",
			targetId: "competitor-research",
			targetGitSha: "a".repeat(40),
			contextHash: `sha256:${"1".repeat(64)}`,
		});
		const basis = content.evidenceBasis as Record<string, unknown>;
		expect(basis.briefId).toBe(`brief-${"2".repeat(24)}`);
		expect(basis.briefSha256).toBeUndefined();
		expect(basis.failureModes).toEqual([{ failureModeId: `failure-mode-${"4".repeat(24)}` }]);
		expect(JSON.stringify(projected)).not.toContain('"proposalHash"');
	});

	it("derives the legal moves from the transition policy, never from a second table", () => {
		const view = loadedView();
		const improving: WorkbenchView = {
			...view,
			stage: "improvement-authoring",
			workshopOpen: true,
			shippingReadiness: { sealedHoldout: "missing", minimumTasks: 15, sealedCases: null },
		};
		const next = (projectForModel(improving) as { next: {
			unblock: string;
			decide: { kind: string; asks: boolean }[];
			submit: { kind: string }[];
			workshop: { basis: string; open: boolean };
		} }).next;
		expect(next.unblock).toBe("look at the failures, then say “fix it”");
		// `run-current` resolves to `run-eval` here, which is routine: no question.
		expect(next.decide.find((entry) => entry.kind === "run-current")).toEqual({
			kind: "run-current",
			asks: false,
			when: expect.any(String),
		});
		expect(next.decide.map((entry) => entry.kind)).toEqual([
			"run-current", "talk-to-agent", "regrade", "generate-holdout",
			"configure-evaluators", "calibrate", "improve", "run-eval",
		]);
		// A workshop is open, so closing or discarding it is legal and reopening is not.
		expect(next.submit.map((entry) => entry.kind)).toEqual([
			"spec-draft", "corpus-draft", "corpus-revision", "corpus-import",
			"dataset-recipe", "structured-proposal", "workshop-close", "workshop-discard",
		]);
		expect(next.workshop).toEqual({ basis: "improvement", open: true });
		console.log(`next block bytes: ${JSON.stringify(next).length}`);
	});

	it("returns the selection list only when the view asked for it", () => {
		const view = loadedView();
		const projected = projectForModel(view, { include: ["selections"] }) as { selections: unknown[] };
		expect(projected.selections).toHaveLength(40);
	});

	it("shrinks the serialized result the model reads", () => {
		const view = loadedView();
		const before = size(view);
		const after = size(projectForModel(view));
		const withSelections = size(projectForModel(view, { include: ["selections"] }));
		console.log(`view result bytes: before=${before} after=${after} withSelections=${withSelections}`);
		expect(after).toBeLessThan(before / 2);
	});

	it("never rewrites a decision result's ids", () => {
		const decision = {
			kind: "publish-corpus",
			message: "Development corpus published",
			result: {
				corpusId: "corpus-1",
				corpusHash: `sha256:${"a".repeat(64)}`,
				taskCount: 12,
				publicationReceiptId: "receipt-1",
				lineageHash: `sha256:${"b".repeat(64)}`,
			},
		};
		expect(projectForModel(decision)).toEqual({
			kind: "publish-corpus",
			message: "Development corpus published",
			result: { corpusId: "corpus-1", taskCount: 12, publicationReceiptId: "receipt-1" },
		});
	});

	it("removes host credential references from decision results without mutating human details", () => {
		const decision = {
			kind: "configure-evaluators",
			result: {
				configured: [
					{ role: "judge", model: "anthropic/judge-test", credentialEnv: "JUDGE_API_KEY" },
				],
			},
		};
		const projected = projectForModel(decision) as { result: { configured: Record<string, unknown>[] } };
		expect(projected.result.configured[0]).toEqual({ role: "judge", model: "anthropic/judge-test" });
		expect(decision.result.configured[0]?.credentialEnv).toBe("JUDGE_API_KEY");
	});

	it("hands the model the phrase for the exam, not a verdict it has to interpret", () => {
		const projected = projectForModel({
			kind: "verify-candidate",
			result: {
				candidate: {
					sealedHoldout: {
						executed: true,
						gatePassed: true,
						gate: {
							verdict: "pass",
							tasks: 15,
							repetitions: 2,
							confidence95: { low: -0.11, high: 0.15 },
							outcome: "no-regression",
							outcomeLine: "pass · no regression proven, not an improvement either",
						},
					},
				},
			},
		}) as { result: { candidate: { sealedHoldout: { gate: Record<string, unknown> } } } };
		// The one sentence the model may quote about the exam, beside the token
		// it must not paraphrase.
		expect(projected.result.candidate.sealedHoldout.gate).toMatchObject({
			verdict: "pass",
			outcome: "no-regression",
			outcomeLine: "pass · no regression proven, not an improvement either",
		});
	});

	/**
	 * The candidate's verdict has been quotable since the panel and the Builder
	 * were made to say the same digits. A run's was not: the host drew
	 * `прошли 0/24 · 3 типа сбоя` and the Builder wrote `0/24 passed. Три
	 * системные проблемы:` — the same numbers, its own words, in the wrong
	 * language. The projection now carries the host's sentence for it to quote.
	 */
	it("hands the model the host's own sentence about a run", () => {
		setLanguage("ru");
		try {
			const headline = runResultLine({ pass: 0, total: 24, failureModes: 3 });
			expect(headline).toBe("прошли 0/24 · 3 типа сбоя");
			const projected = projectForModel({
				kind: "run-eval",
				result: { headline, evaluation: { summary: { pass: 0, total: 24 } } },
			}) as { result: { headline: string } };
			expect(projected.result.headline).toBe(headline);
			// And the composite that runs it hoists the same string, so the field
			// is in the same place whichever door the run came through.
			const composite = projectForModel({
				kind: "start-testing",
				result: { headline, evaluation: { headline } },
			}) as { result: { headline: string; evaluation: { headline: string } } };
			expect(composite.result.headline).toBe(headline);
			expect(composite.result.evaluation.headline).toBe(headline);
		} finally {
			setLanguage(null);
		}
	});

	it("removes credential references even inside otherwise-verbatim claims", () => {
		const projected = projectForModel({
			claim: {
				targetId: "agent",
				contextHash: `sha256:${"a".repeat(64)}`,
				apiKeyEnv: "TARGET_KEY",
				nested: { credentialEnv: "JUDGE_KEY", stable: true },
			},
		}) as { claim: Record<string, unknown> };
		expect(projected.claim).toEqual({
			targetId: "agent",
			contextHash: `sha256:${"a".repeat(64)}`,
			nested: { stable: true },
		});
	});
});
