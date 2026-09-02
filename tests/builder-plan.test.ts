import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installAhdeBuilderProductShell } from "../src/builder/product-shell.js";
import { candidateHeadline } from "../src/workbench/resolution.js";
import { setLanguage } from "../src/i18n.js";
import {
	compilePlan,
	planHeadline,
	planProgress,
	renderPlan,
	PLAN_STEP_IDS,
	type PlanFacts,
} from "../src/builder/render/plan.js";
import {
	clockOf,
	elapsed,
	receiptFacts,
	receiptSubject,
	renderReceipt,
} from "../src/builder/render/receipt.js";
import { renderStatusBar } from "../src/builder/render/status-bar.js";
import { markerPaint, stripMarkers } from "../src/builder/transcript.js";
import type { EvalRunSpend } from "../src/builder/spend.js";
import type {
	WorkbenchCandidateSummary,
	WorkbenchDecisionResult,
	WorkbenchStage,
	WorkbenchView,
} from "../src/workbench/types.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function view(overrides: Partial<WorkbenchView> = {}): WorkbenchView {
	return {
		schemaVersion: 1,
		project: { id: "demo", directory: "demo" },
		stage: "ready-to-evaluate",
		headline: "Development corpus is ready.",
		target: {
			status: "ready",
			id: "support-agent",
			gitSha: SHA_A,
			model: { provider: "anthropic", id: "claude-sonnet-4", apiKeyEnv: "ANTHROPIC_API_KEY", credentialPresent: true },
		},
		focus: {},
		selections: [],
		actions: [],
		blockers: [],
		warnings: [],
		shippingReadiness: { sealedHoldout: "ready", minimumTasks: 30 },
		calibration: null,
		counts: {
			specDrafts: 1,
			approvedSpecs: 1,
			corpusDrafts: 1,
			developmentCorpora: 1,
			sealedCorpora: 1,
			developmentEvals: 1,
			openProposals: 0,
			candidates: 0,
			calibrations: 0,
		},
		...overrides,
	};
}

function candidate(overrides: Partial<WorkbenchCandidateSummary> = {}): WorkbenchCandidateSummary {
	const summary: WorkbenchCandidateSummary = {
		headline: "",
		candidateId: "cand-1",
		status: "evaluated",
		projectId: "demo",
		targetId: "support-agent",
		specId: "spec-1",
		proposalId: "builder-proposal-1",
		baseline: { ref: "main", sha: SHA_A },
		candidate: { ref: "candidate/routing", sha: SHA_B },
		development: {
			baselineEvalRunId: "erun-baseline",
			candidateEvalRunId: "erun-candidate",
			comparison: null,
			gate: {
				verdict: "improved",
				surface: "development",
				delta: 0.2,
				baselineScore: 0.6,
				candidateScore: 0.8,
				scoreDelta: 0.2,
				confidence95: { low: 0.05, high: 0.35 },
				tasks: 24,
				repetitions: 3,
				excludedTasks: 0,
				flags: { regressedTasks: 0, improvedTasks: 6, collapsedTasks: 0 },
				resources: { costRatio: null, latencyRatio: null, tokenRatio: null },
				reasons: [],
			},
		},
		sealedHoldout: { executed: true, gatePassed: true, gate: null },
		review: null,
		promotion: null,
		rejection: null,
		...overrides,
	};
	// The host composes the headline from the same evidence; a fixture that
	// hand-wrote one could let a panel and its headline drift apart in a test.
	return { ...summary, headline: summary.headline || candidateHeadline(summary.development, summary.sealedHoldout) };
}

/** The plan of a project standing at candidate verification, mid-cycle. */
function midCycle(): WorkbenchView {
	return view({
		stage: "candidate-verification",
		headline: "Verify the applied candidate.",
		detail: { aspect: "review", content: { kind: "candidate", ...candidate(), adoption: null, continuation: null, impact: null } },
		selections: [
			{ kind: "development-corpus", id: "corpus-1", label: "Support basket · 24 tasks", status: "reviewed", selected: true },
			{ kind: "eval-run", id: "erun-1", label: "18/24 passed", status: "complete", selected: true },
			{ kind: "candidate", id: "cand-1", label: "builder-proposal-1", status: "evaluated", selected: true },
		],
		counts: { ...view().counts, developmentEvals: 3, candidates: 1 },
	});
}

const plain = (lines: readonly string[]): string => lines.map(stripMarkers).join("\n");

afterEach(() => setLanguage(null));

describe("the cycle as a checklist", () => {
	it("names one phase per step, always in the same order", () => {
		const plan = compilePlan(view());
		expect(plan.steps.map((step) => step.id)).toEqual([...PLAN_STEP_IDS]);
		expect(planProgress(plan).total).toBe(8);
	});

	it.each([
		["target-setup", "harness"],
		["spec-design", "spec"],
		["spec-review", "spec"],
		["corpus-design", "tests"],
		["corpus-review", "tests"],
		["ready-to-evaluate", "baseline"],
		["improvement-authoring", "change"],
		["proposal-review", "change"],
		["candidate-verification", "verification"],
		["candidate-review", "release"],
		["release-decision", "release"],
		["candidate-adoption", "release"],
		["complete", "release"],
	] as [WorkbenchStage, string][])("marks %s as standing on the %s step", (stage, step) => {
		const plan = compilePlan(view({ stage }));
		expect(plan.steps.find((item) => item.marker === "current")?.id).toBe(step);
	});

	it("marks the current step blocked when the view carries a blocker", () => {
		const plan = compilePlan(view({ stage: "target-setup", blockers: ["Target harness is missing."] }));
		expect(plan.steps.find((step) => step.id === "harness")?.marker).toBe("blocked");
		expect(plan.blockers).toEqual(["Target harness is missing."]);
		expect(planHeadline(plan)).toContain("!");
	});

	it("reads counts and verdicts out of the view the header already had", () => {
		const plan = compilePlan(midCycle(), {
			harness: { tools: 3, skills: 2 },
			workshop: { files: 4, tries: 2 },
		});
		const byId = new Map(plan.steps.map((step) => [step.id, step]));
		expect(byId.get("spec")?.marker).toBe("done");
		expect(byId.get("harness")?.detail).toBe("configured · 3 tools · 2 skills");
		expect(byId.get("tests")?.detail).toBe("published · 24 cases");
		expect(byId.get("exam")?.detail).toBe("ready for the ship gate");
		expect(byId.get("baseline")?.detail).toBe("18/24 · 75% passed");
		expect(byId.get("change")?.detail).toBe("applied on candidate/routing");
		expect(byId.get("change")?.items).toEqual(["workshop · 4 files changed · 2 tries"]);
		expect(byId.get("verification")?.marker).toBe("current");
		expect(byId.get("verification")?.items).toEqual(["development: improved", "exam: pass"]);
		expect(byId.get("release")?.marker).toBe("ahead");
	});

	it("says what is missing instead of naming the exam", () => {
		const plan = compilePlan(view({ shippingReadiness: { sealedHoldout: "underpowered", minimumTasks: 30 } }));
		const exam = plan.steps.find((step) => step.id === "exam");
		expect(exam?.marker).toBe("ahead");
		expect(exam?.detail).toBe("sealed holdout has fewer than 30 cases");
		expect(plain(renderPlan(plan, markerPaint))).not.toContain("holdout-");
	});

	it("hangs the running measurement under the phase it belongs to", () => {
		const facts: PlanFacts = { job: { label: "candidate verification", progress: "120/372" } };
		const plan = compilePlan(midCycle(), facts);
		expect(plan.steps.find((step) => step.id === "verification")?.items)
			.toContain("running: candidate verification · 120/372");
	});

	it("renders the panel and the header line in English", () => {
		const plan = compilePlan(midCycle(), { harness: { tools: 3, skills: 2 } });
		expect(plain(renderPlan(plan, markerPaint))).toBe([
			"✓ Description · approved",
			"✓ Agent · configured · 3 tools · 2 skills",
			"✓ Tests · published · 24 cases",
			"✓ Exam · ready for the ship gate",
			"✓ Baseline · 18/24 · 75% passed",
			"✓ Change · applied on candidate/routing",
			"▸ Verification · measured",
			"    └ development: improved",
			"    └ exam: pass",
			"◻ Release · not shipped",
		].join("\n"));
		expect(planHeadline(plan)).toBe("Plan 6/8 · ▸ Candidate verification");
	});

	it("renders the same plan in Russian", () => {
		setLanguage("ru");
		const plan = compilePlan(midCycle(), { harness: { tools: 3, skills: 2 } });
		expect(plain(renderPlan(plan, markerPaint))).toBe([
			"✓ Описание · одобрено",
			"✓ Агент · настроен · 3 инструмента · 2 скилла",
			"✓ Тесты · опубликованы · 24 кейса",
			"✓ Экзамен · готов к выкатке",
			"✓ База · 18/24 · 75% проходит",
			"✓ Правка · на ветке candidate/routing",
			"▸ Проверка · измерено",
			"    └ разработка: стало лучше",
			"    └ экзамен: пройден",
			"◻ Выпуск · не выкачено",
		].join("\n"));
		expect(planHeadline(plan)).toBe("План 6/8 · ▸ Проверка кандидата");
	});
});

describe("the receipt", () => {
	const spend = (overrides: Partial<EvalRunSpend> = {}): EvalRunSpend => ({
		evalRunId: "erun-1",
		runs: 24,
		costUsd: 0.19,
		judgeCostUsd: 0.03,
		startedAt: "2026-08-28T14:10:00.000Z",
		finishedAt: "2026-08-28T14:14:12.000Z",
		...overrides,
	});

	const runResult = (): WorkbenchDecisionResult => ({
		kind: "run-eval",
		message: "run complete",
		result: {
			evaluation: { evalRunId: "erun-1", summary: { total: 24, pass: 18, fail: 6, error: 0, allPassRate: 0.75 }, repetitions: 3 },
			diagnosis: { diagnosisId: "d-1", evalRunId: "erun-1", status: "actionable", summary: { tasks: 24, healthyTasks: 18, failedTasks: 6, infrastructureErrors: 0, issueCount: 2 }, issues: [], omittedIssues: 0 },
			improvementBrief: {
				schemaVersion: 1,
				algorithmId: "exact-eval-signals-v1",
				briefId: "brief-1",
				evalRunId: "erun-1",
				diagnosisId: "d-1",
				status: "actionable",
				proposalEligible: true,
				headline: "18/24 passed.",
				summary: { tasks: 24, failedTasks: 6, infrastructureErrors: 0, failureModeCount: 3, systemicFailureModeCount: 1, taskLocalFailureModeCount: 2, omittedFailureModeCount: 0 },
				modes: [],
				conversationProjection: { shownModes: 0, addressableModes: 0, omittedModes: 0, fullEvidence: "" },
			},
			evidence: { available: false },
		},
		view: view(),
	} as unknown as WorkbenchDecisionResult);

	it("names exactly the measurements one decision paid for", () => {
		expect(receiptSubject(runResult())).toEqual({ evalRunIds: ["erun-1"], candidateIds: [] });
		// A decision that only wrote a receipt spent no model time and gets no line.
		expect(receiptSubject({
			kind: "approve-spec",
			message: "approved",
			result: { approvedSpecId: "spec-1", receiptId: "r-1" },
			view: view(),
		} as unknown as WorkbenchDecisionResult)).toBeNull();
	});

	it("sums the arms and keeps the wall clock of the whole measurement", () => {
		const facts = receiptFacts([
			spend({ evalRunId: "erun-baseline", costUsd: 0.1, judgeCostUsd: 0.01, finishedAt: "2026-08-28T14:12:00.000Z" }),
			spend({ evalRunId: "erun-candidate", costUsd: 0.09, judgeCostUsd: 0.02, startedAt: "2026-08-28T14:12:01.000Z" }),
		]);
		expect(facts).toMatchObject({ runs: 48, costUsd: 0.19, judgeCostUsd: 0.03, durationMs: 252_000 });
	});

	it("renders one dim line from measured numbers, judge included only when billed", () => {
		const line = renderReceipt(runResult(), markerPaint, {
			ofEvalRun: () => spend(),
			ofCandidate: () => [],
		});
		expect(stripMarkers(String(line)))
			.toBe(`${clockOf("2026-08-28T14:14:12.000Z")} · 24 Target executions · $0.19 · 4m12s · judge $0.03`);

		const noJudge = renderReceipt(runResult(), markerPaint, {
			ofEvalRun: () => spend({ judgeCostUsd: 0 }),
			ofCandidate: () => [],
		});
		expect(stripMarkers(String(noJudge))).not.toContain("judge");
	});

	it("says nothing at all rather than estimating an unreadable measurement", () => {
		expect(renderReceipt(runResult(), markerPaint, { ofEvalRun: () => null, ofCandidate: () => [] })).toBeNull();
		expect(renderReceipt(runResult(), markerPaint, {
			ofEvalRun: () => {
				throw new Error("unreadable");
			},
			ofCandidate: () => [],
		})).toBeNull();
	});

	it("speaks the operator's language and never rounds a unit into existence", () => {
		expect(elapsed(12_000)).toBe("12s");
		expect(elapsed(252_000)).toBe("4m12s");
		expect(elapsed(3_723_000)).toBe("1h02m");
		setLanguage("ru");
		expect(elapsed(252_000)).toBe("4м12с");
		const line = renderReceipt(runResult(), markerPaint, { ofEvalRun: () => spend(), ofCandidate: () => [] });
		expect(stripMarkers(String(line))).toContain("24 запуска · $0.19 · 4м12с · судья $0.03");
	});
});

describe("the live header", () => {
	it("carries the plan line and the cycle's own footer segments", async () => {
		const handlers = new Map<string, (...args: never[]) => unknown>();
		let header: ((tui: unknown, theme: Theme) => { render(width: number): string[] }) | undefined;
		const setStatus = vi.fn();
		const ui = {
			setTitle: vi.fn(),
			setStatus,
			setWorkingMessage: vi.fn(),
			notify: vi.fn(),
			setEditorText: vi.fn(),
			select: vi.fn(async () => "Not now"),
			setHeader: vi.fn((factory: (tui: unknown, theme: Theme) => { render(width: number): string[] }) => {
				header = factory;
			}),
		};
		const ctx = {
			mode: "tui",
			model: { provider: "anthropic", id: "claude-sonnet-4" },
			modelRegistry: { hasConfiguredAuth: () => true },
			ui,
		} as unknown as ExtensionContext;

		installAhdeBuilderProductShell(
			{
				on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
				registerEntryRenderer: vi.fn(),
				appendEntry: vi.fn(),
			} as unknown as ExtensionAPI,
			{ view: async () => midCycle() } as never,
			{
				now: () => Date.parse("2026-08-28T14:22:00.000Z"),
				spend: {
					ofEvalRun: () => null,
					ofCandidate: () => [],
					cycle: () => ({ costUsd: 1.29, judgeCostUsd: 0.03, evals: 3, firstAt: "2026-08-28T14:10:00.000Z", sinceAt: null }),
					branchOf: (candidateId) => candidateId === "cand-1" ? "candidate/routing" : null,
				},
			},
		);
		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" } as never, ctx as never);

		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
		const lines = header?.({ requestRender: vi.fn() }, theme).render(200).map(stripMarkers) ?? [];
		expect(lines.some((line) => line === "Plan 6/8 · ▸ Candidate verification")).toBe(true);
		expect(setStatus).toHaveBeenCalledWith("ahde", "AHDE · Candidate verification · 12m · $1.32 · candidate/routing");
	});
});

describe("the status bar", () => {
	it("carries the stage, the elapsed cycle, its spend, and the candidate branch", () => {
		expect(renderStatusBar({
			stage: "candidate-verification",
			elapsedMs: 12 * 60_000,
			costUsd: 1.32,
			branch: "candidate/routing",
		})).toBe("AHDE · Candidate verification · 12m · $1.32 · candidate/routing");
	});

	it("shrinks instead of guessing when a number cannot be read", () => {
		expect(renderStatusBar({ stage: "ready-to-evaluate" })).toBe("AHDE · Ready to run");
		setLanguage("ru");
		expect(renderStatusBar({ stage: "candidate-verification", elapsedMs: 720_000, costUsd: 1.32 }))
			.toBe("AHDE · Проверка кандидата · 12м · $1.32");
	});
});
