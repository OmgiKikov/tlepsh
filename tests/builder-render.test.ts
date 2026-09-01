import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type {
	CandidateImpact,
	CandidateNewFailureMode,
	CandidateTaskRegression,
	TargetedModeImpact,
} from "../src/application/candidate-impact.js";
import type { TargetAuthoringContext } from "../src/application/target-authoring-context.js";
import { renderCalibration } from "../src/builder/render/calibration.js";
import { renderConfirmation } from "../src/builder/render/confirmation.js";
import { decisionHeadline, renderDecision } from "../src/builder/render/decision.js";
import { diffStats, renderUnifiedDiff } from "../src/builder/render/diff.js";
import {
	bar,
	bullets,
	bytes,
	clean,
	joinNonEmpty,
	labeled,
	numbered,
	oneLine,
	percent,
	pluralize,
	points,
	shortHash,
	shortSha,
	when,
	wrap,
} from "../src/builder/render/format.js";
import { handoffLines } from "../src/builder/render/handoff.js";
import { setLanguage } from "../src/i18n.js";
import { renderImpact } from "../src/builder/render/impact.js";
import { renderToolPermissions, toolPermissionsFromDiff } from "../src/builder/render/tool-permissions.js";
import { fixtureLines, renderWorkshopCloseReview } from "../src/builder/render/workshop-close.js";
import { lastFixtureRunPerTool } from "../src/application/tool-workshop.js";
import { plainPaint, type Paint } from "../src/builder/render/paint.js";
import { STAGE_LABELS, nextStep, stageLabel } from "../src/builder/render/stage.js";
import { workbenchGateClass } from "../src/workbench/transition-policy.js";
import {
	renderHeader,
	renderReview,
	renderStatus,
	renderTarget,
	renderTraces,
	renderView,
	viewTitle,
} from "../src/builder/render/view.js";
import {
	AHDE_MODEL_NOTE_TYPE,
	AHDE_TRANSCRIPT_ENTRY_TYPE,
	applyPaint,
	createTranscriptPresenter,
	markerPaint,
	registerAhdeTranscriptRenderer,
	renderTranscriptEntry,
	stripMarkers,
	type TranscriptEntry,
	type TranscriptHost,
} from "../src/builder/transcript.js";
import type { AgentSpec } from "../src/spec.js";
import {
	WorkbenchStageSchema,
	type WorkbenchCalibrationProjection,
	type WorkbenchCandidateSummary,
	type WorkbenchConfirmation,
	type WorkbenchDecisionInput,
	type WorkbenchDecisionResult,
	type WorkbenchFailureModeProjection,
	type WorkbenchGateProjection,
	type WorkbenchImprovementBriefProjection,
	type WorkbenchReviewDetail,
	type WorkbenchStage,
	type WorkbenchTargetDetail,
	type WorkbenchTracesDetail,
	type WorkbenchView,
} from "../src/workbench/types.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const HASH = `sha256:${"c".repeat(64)}`;
const SEALED_HASH = `sha256:${"d".repeat(64)}`;
const AT = "2026-08-28T10:00:00.000Z";
const LATER = "2026-08-28T10:01:00.000Z";
const EVEN_LATER = "2026-08-28T10:02:00.000Z";
const FAILURE_MODE_ID = `failure-mode-${"1".repeat(24)}`;
const BRIEF_ID = `brief-${"0".repeat(24)}`;

const OSC = "]52;c;CANARY";
const CSI = "[31m";
const HOSTILE = `safe${OSC}text${CSI}\rmore\tend`;

function tag(name: string): (text: string) => string {
	return (text) => `<${name}>${text}</${name}>`;
}

/** Recording paint: every style becomes a visible, nestable tag. */
const tagPaint: Paint = {
	accent: tag("accent"),
	heading: tag("heading"),
	bold: tag("bold"),
	dim: tag("dim"),
	muted: tag("muted"),
	success: tag("success"),
	warning: tag("warning"),
	error: tag("error"),
	added: tag("added"),
	removed: tag("removed"),
	link: tag("link"),
};

function expectClean(text: string): void {
	expect(text).not.toContain("");
	expect(text).not.toContain("CANARY");
	expect(text).not.toContain("]52");
	expect(text).not.toContain("\r");
	expect(text).not.toContain("\t");
	expect(text).not.toContain("");
}

function makeView(overrides: Partial<WorkbenchView> = {}): WorkbenchView {
	return {
		schemaVersion: 1,
		project: { id: "proj", directory: "/tmp/proj" },
		stage: "ready-to-evaluate",
		headline: "Ready to run the development evaluation",
		target: {
			status: "ready",
			id: "support-bot",
			gitSha: SHA_A,
			model: { provider: "openai", id: "gpt-5", apiKeyEnv: "OPENAI_API_KEY", credentialPresent: true },
		},
		focus: {},
		selections: [],
		actions: [],
		blockers: [],
		warnings: [],
		calibration: null,
		counts: {
			specDrafts: 0,
			approvedSpecs: 1,
			corpusDrafts: 0,
			developmentCorpora: 1,
			sealedCorpora: 0,
			developmentEvals: 2,
			openProposals: 1,
			candidates: 3,
			calibrations: 0,
		},
		...overrides,
	};
}

function makeCandidate(overrides: Partial<WorkbenchCandidateSummary> = {}): WorkbenchCandidateSummary {
	return {
		candidateId: "candidate-1",
		status: "evaluated",
		projectId: "proj",
		targetId: "support-bot",
		specId: "spec-1",
		proposalId: "run-1",
		baseline: { ref: "main", sha: SHA_A },
		candidate: { ref: "ahde/candidate-1", sha: SHA_B },
		development: {
			baselineEvalRunId: "eval-base",
			candidateEvalRunId: "eval-cand",
			comparison: {
				taskCount: 10,
				baselinePassRate: 0.6,
				candidatePassRate: 0.8,
				delta: 0.2,
				confidence95: { low: 0.05, high: 0.35 },
				improved: 3,
				regressed: 1,
				unchanged: 6,
			},
			gate: null,
		},
		sealedHoldout: { executed: true, gatePassed: true, gate: null },
		review: null,
		promotion: null,
		rejection: null,
		...overrides,
	};
}

function makeMode(overrides: Partial<WorkbenchFailureModeProjection> = {}): WorkbenchFailureModeProjection {
	return {
		ordinal: 1,
		failureModeId: FAILURE_MODE_ID,
		category: "tool-selection",
		scope: "systemic",
		severity: "major",
		evidenceStrength: "high",
		decision: "propose-harness-change",
		selectableForProposal: true,
		title: "Agent skips the lookup tool",
		summary: "The agent answers from memory instead of calling lookup.",
		hypothesis: "The instructions never mention the lookup tool.",
		suggestions: ["Mention the lookup tool in the instructions"],
		impact: {
			affectedTasks: 4,
			totalTasks: 10,
			taskCoverageBps: 4000,
			failedOccurrences: 8,
			passedOccurrences: 2,
			reproductionBps: 8000,
		},
		taskIds: ["task-1"],
		evidence: [],
		omittedEvidenceCount: 0,
		...overrides,
	};
}

function makeBrief(overrides: Partial<WorkbenchImprovementBriefProjection> = {}): WorkbenchImprovementBriefProjection {
	const modes = overrides.modes ?? [makeMode()];
	return {
		schemaVersion: 1,
		algorithmId: "exact-eval-signals-v1",
		briefId: BRIEF_ID,
		evalRunId: "eval-1",
		diagnosisId: "diag-1",
		status: "actionable",
		proposalEligible: true,
		headline: "One systemic failure mode blocks 4 of 10 cases",
		summary: {
			tasks: 10,
			failedTasks: 4,
			infrastructureErrors: 0,
			failureModeCount: modes.length,
			systemicFailureModeCount: 1,
			taskLocalFailureModeCount: 0,
			omittedFailureModeCount: 0,
		},
		modes,
		conversationProjection: {
			shownModes: modes.length,
			addressableModes: 1,
			omittedModes: 0,
			fullEvidence: "ahde://evidence/eval-1",
		},
		...overrides,
	};
}

function makeTraces(
	brief: Partial<WorkbenchImprovementBriefProjection> = {},
	overrides: Partial<WorkbenchTracesDetail> = {},
): WorkbenchTracesDetail {
	return {
		evaluation: {
			evalRunId: "eval-1",
			summary: { total: 10, pass: 6, fail: 4, error: 0, allPassRate: 0.6 },
			repetitions: 1,
			finishedAt: "2026-09-01T09:00:07.000Z",
			targetGitSha: "4d533f07030f0a4b1c2d3e4f5a6b7c8d9e0f1a2b",
			corpus: { name: "Ombudsman basket", taskCount: 10 },
		},
		diagnosis: {
			diagnosisId: "diag-1",
			evalRunId: "eval-1",
			status: "actionable",
			summary: { tasks: 10, healthyTasks: 6, failedTasks: 4, infrastructureErrors: 0, issueCount: 1 },
			issues: [],
			omittedIssues: 0,
		},
		improvementBrief: makeBrief(brief),
		evidence: { available: true, url: "http://127.0.0.1:4310/evidence/eval-1" },
		...overrides,
	};
}

function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
	return {
		schemaVersion: 1,
		title: "Support triage agent",
		purpose: "Answer tier-one support questions from the knowledge base.",
		users: ["Support engineers"],
		jobs: ["Classify tickets", "Draft replies"],
		inputs: ["Ticket text"],
		allowedActions: ["search_kb"],
		successCriteria: ["Correct category"],
		constraints: [],
		openQuestions: ["Which languages are required?"],
		...overrides,
	};
}

type CorpusDraftReview = Extract<WorkbenchReviewDetail, { kind: "corpus-draft" }>;
type ProposalReview = Extract<WorkbenchReviewDetail, { kind: "proposal" }>;
type AppliedProposalReview = Extract<WorkbenchReviewDetail, { kind: "applied-proposal" }>;
type CandidateReview = Extract<WorkbenchReviewDetail, { kind: "candidate" }>;

function taskId(index: number): string {
	return `task-${"0".repeat(63)}${index}`;
}

function makeCorpusDraft(overrides: Partial<CorpusDraftReview> = {}): CorpusDraftReview {
	return {
		kind: "corpus-draft",
		id: "corpus-draft-1",
		draftHash: HASH,
		approvedSpec: { projectId: "proj", specId: "spec-1", specContentHash: HASH, snapshotHash: HASH },
		name: "Tier-one basket",
		coverageNotes: ["Covers refunds and shipping"],
		importSource: null,
		tasks: [
			{
				id: taskId(1),
				input: "Customer asks for a refund",
				graders: [
					{ type: "tool_called", tool: "lookup", argsContains: "refund" },
					{ type: "output_contains", text: "refund policy", caseSensitive: false },
					{ type: "output_matches", pattern: "^Refund" },
					{ type: "judge", rubric: "Polite and accurate" },
				],
			},
			{ id: taskId(2), input: "Customer asks for shipping status", graders: [{ type: "tool_called", tool: "track" }] },
			{ id: taskId(3), input: "Customer asks to cancel", graders: [{ type: "judge", rubric: "Confirms cancellation" }] },
		],
		taskProvenance: [],
		...overrides,
	};
}

const DIFF = [
	"diff --git a/AGENTS.md b/AGENTS.md",
	"index 1111111..2222222 100644",
	"--- a/AGENTS.md",
	"+++ b/AGENTS.md",
	"@@ -1,2 +1,3 @@",
	" Existing line",
	"-Old guidance",
	"+New guidance",
	"+Use the lookup tool first",
	"",
].join("\n");

function makeProposal(overrides: Partial<ProposalReview> = {}): ProposalReview {
	return {
		kind: "proposal",
		runId: "run-1",
		proposalHash: HASH,
		baseTargetSha: SHA_A,
		summary: "Tell the agent to call lookup before answering.",
		paths: ["AGENTS.md"],
		risks: ["May slow down simple replies"],
		validationPlan: ["Re-run the development basket"],
		prediction: null,
		authoringContext: null,
		evidenceBasis: {
			algorithmId: "exact-eval-signals-v1",
			evalRunId: "eval-1",
			diagnosisId: "diag-1",
			briefId: BRIEF_ID,
			briefSha256: HASH,
			failureModes: [{ failureModeId: FAILURE_MODE_ID, modeSha256: HASH }],
			runRefs: ["eval:eval-1/run:run-a"],
		},
		exactDiff: DIFF,
		...overrides,
	};
}

function makeApplied(): AppliedProposalReview {
	return {
		...makeProposal(),
		kind: "applied-proposal",
		application: { branch: "ahde/fix-lookup", baseTargetSha: SHA_A, candidateSha: SHA_B, appliedAt: AT },
	};
}

function makeCandidateReview(
	candidate: Partial<WorkbenchCandidateSummary> = {},
	extra: Partial<Pick<CandidateReview, "adoption" | "continuation" | "impact">> = {},
): CandidateReview {
	return { kind: "candidate", ...makeCandidate(candidate), adoption: null, continuation: null, impact: null, ...extra };
}

function counts(failed: number, total: number): TargetedModeImpact["baseline"] {
	return {
		failedOccurrences: failed,
		totalOccurrences: total,
		failureRateBps: total === 0 ? 0 : Math.floor((failed * 10_000) / total),
	};
}

function evidenceHandle(side: "baseline" | "candidate", taskId = "task-c"): CandidateNewFailureMode["evidence"][number] {
	return {
		handle: `eval:eval-${side}/run:run-${side}`,
		runId: `run-${side}`,
		runSha256: HASH,
		taskId,
		side,
		outcome: "fail",
		traceAvailable: true,
	};
}

function targetedMode(outcome: TargetedModeImpact["outcome"], overrides: Partial<TargetedModeImpact> = {}): TargetedModeImpact {
	return {
		failureModeId: FAILURE_MODE_ID,
		modeSha256: HASH,
		signature: { kind: "grader-check", checkCode: "required-tool", discriminatorHash: HASH },
		category: "tool-selection",
		outcome,
		baseline: counts(4, 4),
		candidate: counts(0, 4),
		sourceAffectedTasks: 2,
		candidateAffectedTasks: 0,
		sourceTaskIds: ["task-a", "task-b"],
		candidateAffectedTaskIds: [],
		evidence: [],
		...overrides,
	};
}

function nonTargetedMode(category: CandidateNewFailureMode["category"], overrides: Partial<CandidateNewFailureMode> = {}): CandidateNewFailureMode {
	return {
		failureModeId: `failure-mode-${"2".repeat(24)}`,
		signature: { kind: "grader-check", checkCode: "output-contains", discriminatorHash: HASH },
		category,
		baseline: counts(0, 4),
		candidate: counts(3, 4),
		affectedTasks: 2,
		affectedTaskIds: ["task-c", "task-d"],
		evidence: [evidenceHandle("baseline"), evidenceHandle("candidate")],
		...overrides,
	};
}

function regression(index: number): CandidateTaskRegression {
	return { taskId: `task-regressed-${index}`, baselinePassRate: 1, candidatePassRate: 0, delta: -1, evidence: [] };
}

function makeImpact(overrides: Partial<CandidateImpact> = {}): CandidateImpact {
	return {
		schemaVersion: 1,
		algorithmId: "exact-candidate-impact-v1",
		candidateId: "candidate-1",
		targetId: "support-bot",
		candidateHash: HASH,
		verdict: "improved",
		inconclusiveReasons: [],
		development: {
			pair: {
				baseline: { evalRunId: "eval-base", harnessSha: SHA_A, evalRunHash: HASH },
				candidate: { evalRunId: "eval-cand", harnessSha: SHA_B, evalRunHash: HASH },
			},
			comparison: {
				algorithmId: null,
				policyId: "development-gate",
				comparisonHash: HASH,
				evidenceHash: null,
				gateHash: HASH,
				verified: true,
				verdict: null,
			},
			summary: {
				taskCount: 10,
				baselinePassRate: 0.6,
				candidatePassRate: 0.8,
				delta: 0.2,
				confidence95: { low: 0.05, high: 0.35 },
				improved: 3,
				regressed: 1,
				unchanged: 6,
			},
			resources: { costRatio: 1.4, latencyRatio: 0.9, tokenRatio: 1.125 },
		},
		proposalBasis: {
			algorithmId: "exact-eval-signals-v1",
			evalRunId: "eval-1",
			diagnosisId: "diag-1",
			briefId: BRIEF_ID,
			briefSha256: HASH,
			basisSha256: HASH,
			targetedFailureModes: [targetedMode("resolved")],
		},
		newFailureModes: [],
		omittedNewFailureModeCount: 0,
		worsenedFailureModes: [],
		omittedWorsenedFailureModeCount: 0,
		taskRegressions: [],
		omittedTaskRegressionCount: 0,
		sealedHoldout: { executed: true, gatePassed: true, verdict: "pass" },
		focus: { kind: "summary" },
		subjectHash: HASH,
		...overrides,
	};
}

const targetContext: TargetAuthoringContext = {
	schemaVersion: 1,
	algorithmId: "git-manifest-context-v1",
	contextHash: HASH,
	claim: { algorithmId: "git-manifest-context-v1", targetId: "support-bot", targetGitSha: SHA_A, contextHash: HASH },
	target: {
		id: "support-bot",
		gitSha: SHA_A,
		model: { provider: "openai", id: "gpt-5", thinkingLevel: "medium" },
		execution: { tools: ["lookup", "reply"], environmentAllowlist: ["HOME"], network: "deny", sandbox: "required" },
	},
	resources: [
		{ kind: "instructions", name: null, path: "AGENTS.md", mode: "100644", bytes: 2048, sha256: HASH },
		{ kind: "tool-descriptor", name: "lookup", path: "tools/lookup.tool.yaml", mode: "100644", bytes: 512, sha256: HASH },
		{ kind: "tool-executable", name: "lookup", path: "tools/lookup", mode: "100755", bytes: 1536, sha256: HASH },
	],
	data: [],
	launch: "ahde target",
};

function makeConfirmation(
	kind: WorkbenchDecisionInput["kind"],
	subject: unknown,
	reason = "Reviewed the exact subject",
): WorkbenchConfirmation {
	return {
		kind,
		title: `Confirm ${kind}`,
		reason,
		subject,
		subjectHash: HASH,
		policy: workbenchGateClass(kind),
		question: `Confirm ${kind}?`,
	};
}

function decision<K extends WorkbenchDecisionResult["kind"]>(
	kind: K,
	result: Extract<WorkbenchDecisionResult, { kind: K }>["result"],
	stage: WorkbenchStage,
	message = `${kind} recorded`,
): WorkbenchDecisionResult {
	return { kind, message, result, view: makeView({ stage }) } as unknown as WorkbenchDecisionResult;
}

function makeCalibration(overrides: Partial<WorkbenchCalibrationProjection> = {}): WorkbenchCalibrationProjection {
	return {
		candidateId: "calibration-1",
		targetSha: SHA_A,
		taskCount: 30,
		repetitions: 3,
		aaPassRate: 0.7,
		delta: 0,
		confidence95: { low: -0.06, high: 0.06 },
		flipRate: 0.1,
		recommendedRepetitions: 3,
		verdict: "inconclusive",
		at: AT,
		...overrides,
	};
}

const fakeTheme: Pick<Theme, "fg" | "bold"> = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
	bold: (text) => `<b>${text}</b>`,
};

// ---------------------------------------------------------------------------
// 1. Stages, status, header
// ---------------------------------------------------------------------------

describe("stage labels and next steps", () => {
	it("labels every workbench stage exactly once", () => {
		const stages = [...WorkbenchStageSchema.options].sort();
		expect(Object.keys(STAGE_LABELS).sort()).toEqual(stages);
		for (const stage of WorkbenchStageSchema.options) {
			expect(STAGE_LABELS[stage].length).toBeGreaterThan(0);
			expect(stageLabel(stage)).toBe(STAGE_LABELS[stage]);
		}
		expect(stageLabel("ready-to-evaluate")).toBe("Ready to run");
		expect(stageLabel("corpus-design")).toBe("Eval design");
	});

	it("gives one actionable hint per stage", () => {
		const expected: Record<WorkbenchStage, string> = {
			"target-setup": "Describe the agent you want to build",
			"spec-design": "Describe the agent you want",
			"spec-review": "Say “ok” to approve it, or what to change",
			"corpus-design": "Describe what the agent still needs built, or say “tests” to write the cases",
			"corpus-review": "Say “tests” to publish them and run",
			"ready-to-evaluate": "Describe what the agent still needs built, or say “tests” to run them",
			"improvement-authoring": "Say “fix the first problem”",
			"proposal-review": "Say “apply” after reading the diff, or “discard”",
			"candidate-verification": "Say “check” to verify the change",
			"candidate-review": "Say “ship it” — or “reject”",
			"release-decision": "Say “ship it 0.2.0” — or “reject”",
			"candidate-adoption": "Say “ship it” to make it the active agent",
			complete: "Say “next” to start the next cycle",
			"selection-required": "Pick one of the two open proposals",
		};
		for (const stage of WorkbenchStageSchema.options) {
			const view = makeView({ stage, headline: "Pick one of the two open proposals" });
			expect(nextStep(view), stage).toBe(expected[stage]);
		}
	});

	it("uses the headline when a selection is required", () => {
		expect(nextStep(makeView({ stage: "selection-required", headline: "Choose a candidate" }))).toBe("Choose a candidate");
	});

	it("points an interrupted candidate at reading it, then discarding it", () => {
		const view = makeView({
			stage: "candidate-verification",
			detail: { aspect: "review", content: { kind: "interrupted-candidate", ...makeCandidate({ status: "built" }) } },
		});
		expect(nextStep(view)).toBe("Read the interrupted attempt, then say “discard” to abandon it before retrying");
		const healthy = makeView({
			stage: "candidate-verification",
			detail: { aspect: "review", content: makeCandidateReview() },
		});
		expect(nextStep(healthy)).toBe("Say “check” to verify the change");
	});

	it("asks for a model when target setup is blocked on a placeholder", () => {
		const blocked = makeView({ stage: "target-setup", blockers: ["Target still uses the PLACEHOLDER model"] });
		expect(nextStep(blocked)).toBe("Tell the Builder which model the agent should use");
		const other = makeView({ stage: "target-setup", blockers: ["Manifest is missing"] });
		expect(nextStep(other)).toBe("Describe the agent you want to build");
	});
});

describe("renderStatus", () => {
	it("prints identity, target, evidence, and next step", () => {
		const lines = renderStatus(makeView(), plainPaint);
		expect(lines).toEqual([
			"AHDE · Ready to run",
			"Target support-bot @ aaaaaaaaaa · openai/gpt-5 ✓",
			"Evidence 2 eval runs · 1 open proposal · 3 candidates",
			"Noise not calibrated · say “calibrate” or /calibrate",
			"Next Describe what the agent still needs built, or say “tests” to run them",
		]);
		expect(lines.join("\n")).not.toContain("{");
	});

	it("shows sealed holdouts, blockers, warnings, and selections", () => {
		const lines = renderStatus(makeView({
			counts: { ...makeView().counts, sealedCorpora: 1 },
			blockers: ["Corpus not published", "Spec not approved"],
			warnings: ["Credential missing", "Worktree dirty"],
			selections: [
				{ kind: "candidate", id: "candidate-1", label: "candidate-1 · evaluated", selected: true },
				{ kind: "proposal", id: "run-2", label: "run-2", selected: false },
			],
		}), plainPaint);
		const text = lines.join("\n");
		expect(text).toContain("· 1 sealed holdout");
		expect(text).toContain("Blocked Corpus not published Spec not approved");
		expect(text).toContain("Warnings\n  • Credential missing\n  • Worktree dirty");
		expect(text).toContain("Selected candidate candidate-1 · evaluated");
		expect(text).not.toContain("run-2");
	});

	it("surfaces the future ship blocker before a candidate is applied", () => {
		const lines = renderStatus(makeView({
			shippingReadiness: { sealedHoldout: "missing", minimumTasks: 15 },
		}), plainPaint);
		expect(lines).toContain("Ship gate no sealed holdout · /holdout imports your JSONL exam (minimum 15) · or lets the judge write one");

		const ready = renderStatus(makeView({
			shippingReadiness: { sealedHoldout: "ready", minimumTasks: 15 },
		}), plainPaint);
		expect(ready.join("\n")).not.toContain("Ship gate");

		const unavailableView = makeView({
			shippingReadiness: { sealedHoldout: "unavailable", minimumTasks: 15 },
		});
		const unavailable = renderStatus(unavailableView, plainPaint);
		// A broken exam is repaired, not replaced by one the judge guesses at.
		expect(unavailable).toContain("Ship gate sealed holdout is unavailable or failed integrity checks · /holdout imports an operator-owned JSONL exam (minimum 15)");
		const header = renderHeader(
			{ view: unavailableView, builderModel: { label: "openai/gpt-5", credentialPresent: true } },
			plainPaint,
		).join("\n");
		expect(header).toContain("Ship gate sealed holdout is unavailable or failed integrity checks");
		expect(header).not.toMatch(/corpus-[0-9a-f]{64}|sha256:|corpus\.jsonl|PRIVATE/);
	});

	it("describes missing, bootstrap-required, and credential-less targets", () => {
		const missing = renderStatus(makeView({ target: { status: "missing", id: null, gitSha: null, model: null } }), tagPaint);
		expect(missing[1]).toBe("<dim>Target</dim> <muted>not created yet</muted>");
		const bootstrap = renderStatus(makeView({ target: { status: "bootstrap-required", id: "support-bot", gitSha: SHA_A, model: null } }), plainPaint);
		expect(bootstrap[1]).toBe("Target support-bot @ aaaaaaaaaa · model not chosen");
		const noCredential = renderStatus(makeView({
			target: { status: "ready", id: "support-bot", gitSha: SHA_A, model: { provider: "openai", id: "gpt-5", apiKeyEnv: "OPENAI_API_KEY", credentialPresent: false } },
		}), tagPaint);
		expect(noCredential[1]).toContain("openai/gpt-5 <warning>(OPENAI_API_KEY missing)</warning>");
	});
});

describe("calibration line", () => {
	it("shows the measured noise on the current revision", () => {
		const lines = renderStatus(makeView({ calibration: makeCalibration() }), plainPaint);
		expect(lines[3]).toBe("Noise A/A inconclusive · ±6.0pp · flip 10% · 3 reps recommended");
		expect(lines[3]!.length).toBeLessThanOrEqual(110);
		const header = renderHeader(
			{ view: makeView({ calibration: makeCalibration() }), builderModel: { label: "x", credentialPresent: true } },
			plainPaint,
		);
		expect(header).toContain("Noise A/A inconclusive · ±6.0pp · flip 10% · 3 reps recommended");
	});

	it("warns when the harness disagrees with itself and keeps the paint", () => {
		const lines = renderStatus(makeView({
			calibration: makeCalibration({ verdict: "regressed", confidence95: { low: -0.2, high: -0.04 }, flipRate: 0.42, recommendedRepetitions: 5 }),
		}), tagPaint);
		expect(lines[3]).toBe("<dim>Noise</dim> A/A <warning>regressed</warning> <dim>·</dim> ±8.0pp <dim>·</dim> flip 42% <dim>·</dim> 5 reps recommended");
	});

	it("offers calibration only where the operator can act on it", () => {
		for (const stage of ["ready-to-evaluate", "improvement-authoring"] as const) {
			expect(renderStatus(makeView({ stage }), plainPaint)).toContain("Noise not calibrated · say “calibrate” or /calibrate");
		}
		for (const stage of ["target-setup", "spec-review", "candidate-review", "complete"] as const) {
			expect(renderStatus(makeView({ stage }), plainPaint).join("\n")).not.toContain("Noise");
		}
	});
});

describe("renderCalibration", () => {
	it("renders the A/A design, spread, and recommendation without JSON", () => {
		const lines = renderCalibration(makeCalibration(), plainPaint);
		expect(lines).toEqual([
			"Noise calibration A/A inconclusive · revision aaaaaaaaaa",
			"Design 30 cases × 3 repetitions · same revision on both arms · baseline 70%",
			"Spread ±6.0pp (95% CI -6 pts … +6 pts) · flip 10%",
			"Recommended 3 repetitions per run to keep noise under 10 points",
			"A/A is measurement, never evidence: nothing is promoted by calibrating.",
		]);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(110);
		expect(lines.join("\n")).not.toContain("{");
	});

	it("flags a self-inconsistent harness instead of reassuring the operator", () => {
		const lines = renderCalibration(makeCalibration({ verdict: "improved", recommendedRepetitions: 5 }), plainPaint);
		expect(lines[0]).toBe("Noise calibration A/A improved · revision aaaaaaaaaa");
		expect(lines[lines.length - 1]).toContain("disagrees with itself");
	});
});

describe("renderHeader", () => {
	it("renders the connected builder with stage, next step, and evidence", () => {
		const lines = renderHeader({ view: makeView(), builderModel: { label: "anthropic/claude-opus", credentialPresent: true } }, plainPaint);
		expect(lines[0]).toBe("");
		expect(lines[1]).toBe("AHDE Builder · build, evaluate, and improve another agent through evidence");
		expect(lines[2]).toBe("Target support-bot @ aaaaaaaaaa · openai/gpt-5 ✓");
		expect(lines[3]).toBe("Stage Ready to run · Next Describe what the agent still needs built, or say “tests” to run them");
		expect(lines[4]).toBe("Evidence 2 eval runs · 1 open proposal · 3 candidates · Builder model anthropic/claude-opus ✓");
		expect(lines[5]).toBe("Noise not calibrated · say “calibrate” or /calibrate");
		expect(lines[6]).toBe("Describe what you want in plain language");
		expect(lines[lines.length - 1]).toBe("");
		expect(lines.join("\n")).not.toContain("{");
	});

	it("warns when the Builder is not connected or the Target credential is missing", () => {
		const noLabel = renderHeader({ view: null, builderModel: { label: null, credentialPresent: false } }, tagPaint);
		expect(noLabel.join("\n")).toContain("<dim>Builder model</dim> <warning>not connected — connect a model to continue</warning>");
		const labelled = renderHeader({ view: null, builderModel: { label: "anthropic/claude-opus", credentialPresent: false } }, tagPaint);
		expect(labelled.join("\n")).toContain("anthropic/claude-opus <warning>· not connected</warning>");
		const view = makeView({
			target: { status: "ready", id: "support-bot", gitSha: SHA_A, model: { provider: "openai", id: "gpt-5", apiKeyEnv: "OPENAI_API_KEY", credentialPresent: false } },
		});
		expect(renderHeader({ view, builderModel: { label: "x", credentialPresent: true } }, plainPaint).join("\n")).toContain("(OPENAI_API_KEY missing)");
	});

	it("shows the error branch with recovery guidance and no project lines", () => {
		const lines = renderHeader({
			view: makeView(),
			builderModel: { label: null, credentialPresent: false },
			error: "state.json is corrupt",
		}, plainPaint);
		expect(lines).toEqual([
			"",
			"AHDE Builder · build, evaluate, and improve another agent through evidence",
			"Project state unavailable state.json is corrupt",
			"Builder model not connected — connect a model to continue",
			"",
		]);
	});

	it("names a declared tool key nobody exported, with the one thing to do", () => {
		const view = makeView({
			target: {
				status: "ready",
				id: "support-bot",
				gitSha: SHA_A,
				model: { provider: "openai", id: "gpt-5", apiKeyEnv: "OPENAI_API_KEY", credentialPresent: true },
				toolCredentials: [
					{ tool: "weather", environment: "WEATHER_API_KEY", present: false },
					{ tool: "crm", environment: "CRM_TOKEN", present: true },
				],
			},
		});
		expect(renderHeader({ view, builderModel: { label: "x", credentialPresent: true } }, plainPaint).join("\n"))
			.toContain("Tool key weather needs WEATHER_API_KEY — export it in the shell that runs ahde");
		// Nothing is said about a key that is already there.
		const satisfied = makeView({
			target: {
				status: "ready",
				id: "support-bot",
				gitSha: SHA_A,
				model: { provider: "openai", id: "gpt-5", apiKeyEnv: "OPENAI_API_KEY", credentialPresent: true },
				toolCredentials: [{ tool: "crm", environment: "CRM_TOKEN", present: true }],
			},
		});
		expect(renderHeader({ view: satisfied, builderModel: { label: "x", credentialPresent: true } }, plainPaint).join("\n"))
			.not.toContain("Tool key");
	});

	it("shows blockers except during target setup", () => {
		const blocked = renderHeader({ view: makeView({ blockers: ["Spec not approved"] }), builderModel: { label: "x", credentialPresent: true } }, plainPaint);
		expect(blocked.join("\n")).toContain("Blocked Spec not approved");
		const setup = renderHeader({ view: makeView({ stage: "target-setup", blockers: ["placeholder model"] }), builderModel: { label: "x", credentialPresent: true } }, plainPaint);
		expect(setup.join("\n")).not.toContain("Blocked");
		expect(setup.join("\n")).toContain("Next Tell the Builder which model the agent should use");
	});
});

// ---------------------------------------------------------------------------
// 2. renderReview
// ---------------------------------------------------------------------------

describe("renderReview", () => {
	it("renders a spec draft with lists, open questions, and the snapshot hash", () => {
		const lines = renderReview({ kind: "spec-draft", id: "spec-draft-1", snapshotHash: HASH, spec: makeSpec() }, plainPaint);
		const text = lines.join("\n");
		expect(lines[0]).toBe("Spec draft spec-draft-1");
		expect(lines[1]).toBe(`${"Title".padEnd(15)} Support triage agent`);
		expect(text).toContain("Purpose\n  Answer tier-one support questions from the knowledge base.");
		expect(text).toContain("Users\n  • Support engineers");
		expect(text).toContain("Jobs\n  • Classify tickets\n  • Draft replies");
		expect(text).toContain("Allowed actions\n  • search_kb");
		expect(text).toContain(`${"Constraints".padEnd(15)} —`);
		expect(text).toContain("Open questions\n  • Which languages are required?");
		expect(lines[lines.length - 1]).toBe("Snapshot cccccccccccc…");
		expect(text).not.toContain("{");
	});

	it("omits the open questions block when there are none", () => {
		const text = renderReview({ kind: "spec-draft", id: "spec-draft-1", snapshotHash: HASH, spec: makeSpec({ openQuestions: [] }) }, tagPaint).join("\n");
		expect(text).not.toContain("Open questions");
		expect(text).toContain("<heading>Spec draft</heading>");
	});

	it("renders a corpus draft with numbered cases and all four grader labels", () => {
		const lines = renderReview(makeCorpusDraft(), plainPaint);
		const text = lines.join("\n");
		expect(lines[0]).toBe("Eval basket draft Tier-one basket · 3 cases · corpus-draft-1");
		expect(text).toContain("   1. Customer asks for a refund");
		expect(text).toContain("      graders: tool lookup ∋ “refund” · contains “refund policy” · matches /^Refund/ · judge “Polite and accurate”");
		expect(text).toContain("   2. Customer asks for shipping status\n      graders: tool track");
		expect(text).toContain("   3. Customer asks to cancel");
		expect(text).toContain("Coverage notes\n  • Covers refunds and shipping");
		expect(text).not.toContain("Imported from");
		expect(text).not.toContain("Provenance");
		expect(lines[lines.length - 1]).toBe("Draft cccccccccccc… · Spec spec-1");
	});

	it("folds cases beyond maxTasks and shows the import source and provenance", () => {
		const draft = makeCorpusDraft({
			importSource: { path: "imports/tier-one.jsonl", sha256: HASH, bytes: 1024, taskCount: 3 },
			taskProvenance: [{
				kind: "development-failure",
				taskId: taskId(1),
				source: {
					corpusId: `corpus-${"e".repeat(64)}`,
					corpusHash: HASH,
					evalRunId: "eval-1",
					evalRunHash: HASH,
					runId: "run-a",
					runHash: HASH,
					tracePath: "session.jsonl",
					traceSha256: HASH,
					sourceTaskId: "task-1",
					sourceTaskHash: HASH,
				},
			}],
		});
		const text = renderReview(draft, plainPaint, { maxTasks: 1 }).join("\n");
		expect(text).toContain("Imported from imports/tier-one.jsonl");
		expect(text).toContain("   1. Customer asks for a refund");
		expect(text).not.toContain("   2. Customer asks for shipping status");
		expect(text).toContain("  … +2 more cases");
		expect(text).toContain("Provenance 1 case bound to verified development failures");
	});

	it("renders a proposal with summary, paths, +/- stats, risks, and a colored diff", () => {
		const lines = renderReview(makeProposal(), tagPaint);
		const text = lines.join("\n");
		expect(lines[0]).toBe("<heading>Proposal</heading> <dim>run-1</dim>");
		expect(lines[1]).toBe("  Tell the agent to call lookup before answering.");
		expect(lines[2]).toBe("<dim>Changes</dim> <bold>AGENTS.md</bold> <dim>(<added>+2</added> <removed>-1</removed>)</dim>");
		expect(lines[3]).toBe("<dim>Base</dim> aaaaaaaaaa <dim>· proposal</dim> <dim>cccccccccccc…</dim>");
		expect(text).toContain("<dim>Evidence</dim> eval eval-1 <dim>·</dim> 1 targeted failure mode <dim>· 1 run reference</dim>");
		expect(text).toContain("<warning>Risks</warning>\n  <dim>•</dim> May slow down simple replies");
		expect(text).toContain("<dim>Validation plan</dim>\n  <dim>•</dim> Re-run the development basket");
		expect(text).toContain("<dim>Diff</dim>\n<dim>diff --git a/AGENTS.md b/AGENTS.md</dim>\n<dim>index 1111111..2222222 100644</dim>\n<bold>--- a/AGENTS.md</bold>\n<bold>+++ b/AGENTS.md</bold>\n<accent>@@ -1,2 +1,3 @@</accent>\n Existing line\n<removed>-Old guidance</removed>\n<added>+New guidance</added>\n<added>+Use the lookup tool first</added>");
		expect(text).not.toContain("Applied");
		expect(lines[lines.length - 1]).toBe("<added>+Use the lookup tool first</added>");
	});

	it("marks truncated diffs and spec-only proposals", () => {
		const lines = renderReview(makeProposal({ evidenceBasis: null, risks: [], validationPlan: [] }), plainPaint, { maxDiffLines: 3 });
		const text = lines.join("\n");
		expect(text).toContain("Evidence none linked (spec-only proposal)");
		expect(text).not.toContain("Risks");
		expect(text).not.toContain("Validation plan");
		expect(lines[lines.length - 1]).toBe("… 6 more diff lines; open the full proposal artifact for the exact remainder");
		expect(text).not.toContain("+New guidance");
	});

	it("never truncates the human's exact proposal review by default", () => {
		const exactDiff = [DIFF.trimEnd(), ...Array.from({ length: 450 }, (_, index) => `+line-${index}`)].join("\n");
		const text = renderReview(makeProposal({ exactDiff }), plainPaint).join("\n");
		expect(text).toContain("+line-449");
		expect(text).not.toContain("more diff lines");
	});

	it("renders an applied proposal with its branch line", () => {
		const lines = renderReview(makeApplied(), plainPaint);
		expect(lines[0]).toBe("Applied proposal run-1");
		expect(lines).toContain("Applied branch ahde/fix-lookup · aaaaaaaaaa → bbbbbbbbbb 2026-08-28 10:00:00Z");
		expect(lines.indexOf("Diff")).toBeGreaterThan(lines.indexOf("Applied branch ahde/fix-lookup · aaaaaaaaaa → bbbbbbbbbb 2026-08-28 10:00:00Z"));
	});

	it("renders a candidate comparison with delta, sealed gate, and review lines", () => {
		const lines = renderReview(makeCandidateReview({
			review: { experimentId: "exp-1", recommendation: "promote", reason: "Clear improvement on the basket" },
		}), tagPaint);
		expect(lines[0]).toBe("<heading>Candidate</heading> <dim>candidate-1</dim> <dim>·</dim> <accent>evaluated</accent>");
		expect(lines[1]).toBe("<dim>Revision</dim> main@aaaaaaaaaa → ahde/candidate-1@bbbbbbbbbb");
		expect(lines[2]).toBe("<dim>Development</dim> baseline 60% → candidate 80% <success>(+20 pts)</success> <dim>on 10 tasks</dim>");
		expect(lines[3]).toBe("  <success>↑ 3 improved</success> <dim>·</dim> <warning>↓ 1 lower</warning> <dim>·</dim> <muted>= 6 unchanged</muted> <dim>· 95% CI +5 pts … +35 pts</dim>");
		expect(lines[4]).toBe("<dim>Sealed holdout</dim> <success>gate passed</success>");
		expect(lines[5]).toBe("<dim>Review</dim> <success>promote</success> <dim>—</dim> Clear improvement on the basket");
		expect(lines).toHaveLength(6);
	});

	it("renders the score verdict with its cost and latency fragment inside the 110-column budget", () => {
		const gate = (surface: "development" | "sealed"): WorkbenchGateProjection => ({
			verdict: surface === "sealed" ? "pass" : "improved",
			surface,
			delta: 0.2,
			baselineScore: 0.62,
			candidateScore: 0.85,
			scoreDelta: 0.23,
			confidence95: { low: 0.05, high: 0.35 },
			tasks: 30,
			repetitions: 3,
			excludedTasks: 0,
			flags: { regressedTasks: 1, improvedTasks: 3, collapsedTasks: 0 },
			resources: { costRatio: 1.4, latencyRatio: 0.9, tokenRatio: 1.125 },
			reasons: ["95% CI +5.0pp … +35.0pp lies entirely above zero on 30 tasks × 3 repetitions"],
		});
		const candidate = makeCandidateReview({
			development: {
				baselineEvalRunId: "eval-base",
				candidateEvalRunId: "eval-cand",
				comparison: makeCandidate().development!.comparison,
				gate: gate("development"),
			},
			sealedHoldout: { executed: true, gatePassed: true, gate: gate("sealed") },
		});
		const lines = renderReview(candidate, plainPaint);
		expect(lines[2]).toBe("Development baseline 60% → candidate 80% (+20 pts) on 10 tasks · score 62% → 85%");
		expect(lines[4]).toBe("  Verdict improved · +23 pts (95% CI +5 pts … +35 pts) · 30 × 3 · cost ×1.4 · latency ×0.9");
		expect(lines[5]).toBe("Sealed holdout pass · +23 pts (95% CI +5 pts … +35 pts) · 30 × 3 · cost ×1.4 · latency ×0.9");
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(110);
		// Nothing about a sealed task ever reaches the screen.
		expect(lines.join("\n")).not.toContain("task-");
		// An unmeasured pair simply drops the fragment.
		const unmeasured = renderReview(makeCandidateReview({
			sealedHoldout: {
				executed: true,
				gatePassed: true,
				gate: { ...gate("sealed"), resources: { costRatio: null, latencyRatio: null, tokenRatio: null } },
			},
		}), plainPaint);
		expect(unmeasured[4]).toBe("Sealed holdout pass · +23 pts (95% CI +5 pts … +35 pts) · 30 × 3");
	});

	it("renders promotion, adoption, and continuation lines, or the /adopt hint", () => {
		const promoted = makeCandidateReview({
			status: "promoted",
			promotion: { tag: "v1.2.0", reason: "Solid gains", at: AT },
			review: { experimentId: "exp-1", recommendation: "promote", reason: "ok" },
		});
		const pending = renderReview(promoted, plainPaint);
		expect(pending).toContain("Promoted v1.2.0 2026-08-28 10:00:00Z — Solid gains");
		expect(pending).toContain("Adopted not yet — /adopt fast-forwards the current branch");
		const adopted = renderReview(makeCandidateReview(promoted, {
			adoption: { receiptId: "adopt-1", adoptedAt: LATER, branch: "main" },
			continuation: { receiptId: "cont-1", continuedAt: EVEN_LATER },
		}), plainPaint);
		expect(adopted).toContain("Adopted branch main 2026-08-28 10:01:00Z");
		expect(adopted).toContain("Cycle closed 2026-08-28 10:02:00Z");
		expect(adopted.join("\n")).not.toContain("not yet");
	});

	it("renders rejection, failed or absent sealed gates, and unbuilt candidates", () => {
		const rejected = renderReview(makeCandidateReview({
			status: "rejected",
			rejection: { reason: "Regressed refunds", at: AT },
			sealedHoldout: { executed: true, gatePassed: false, gate: null },
			review: { experimentId: "exp-1", recommendation: "reject", reason: "no" },
		}), tagPaint).join("\n");
		expect(rejected).toContain("<error>rejected</error>");
		expect(rejected).toContain("<dim>Sealed holdout</dim> <error>legacy evidence — not promotable</error>");
		expect(rejected).toContain("<dim>Review</dim> <error>reject</error>");
		expect(rejected).toContain("<dim>Rejected</dim> <dim>2026-08-28 10:00:00Z</dim> <dim>—</dim> Regressed refunds");
		expect(rejected).not.toContain("Adopted");
		const unbuilt = renderReview(makeCandidateReview({
			status: "proposed",
			candidate: null,
			development: null,
			sealedHoldout: { executed: false, gatePassed: false, gate: null },
		}), plainPaint).join("\n");
		expect(unbuilt).toContain("main@aaaaaaaaaa → not built");
		expect(unbuilt).toContain("Development not evaluated yet");
		expect(unbuilt).toContain("Sealed holdout not executed");
		const unreconstructable = renderReview(makeCandidateReview({
			development: { baselineEvalRunId: "a", candidateEvalRunId: "b", comparison: null, gate: null },
		}), plainPaint).join("\n");
		expect(unreconstructable).toContain("Development comparison not reconstructable");
	});

	it("says how far the judge behind this evidence has been checked, and only then", () => {
		// No judge grader in the evidence: no line about an instrument it never used.
		expect(renderReview(makeCandidateReview(), plainPaint).join("\n")).not.toContain("Judge");

		const uncalibrated = renderReview(makeCandidateReview({ judgeAgreement: null }), plainPaint).join("\n");
		expect(uncalibrated).toContain("Judge not calibrated · ahde label");

		const calibrated = renderReview(
			makeCandidateReview({ judgeAgreement: { agreement: 0.84, kappa: 0.62, labels: 50 } }),
			plainPaint,
		).join("\n");
		expect(calibrated).toContain("Judge agreement 84% · κ 0.62 · n=50");

		const noKappa = renderReview(
			makeCandidateReview({ judgeAgreement: { agreement: 1, kappa: null, labels: 4 } }),
			plainPaint,
		).join("\n");
		expect(noKappa).toContain("Judge agreement 100% · κ n/a · n=4");
	});

	it("includes the impact projection inside a candidate review", () => {
		const text = renderReview(makeCandidateReview({}, { impact: { available: true, impact: makeImpact() } }), plainPaint).join("\n");
		expect(text).toContain("Impact improved");
		expect(text).toContain("✓ resolved · tool-selection");
	});

	it("warns about an interrupted candidate", () => {
		const lines = renderReview({
			kind: "interrupted-candidate",
			...makeCandidate({ status: "built", development: null, sealedHoldout: { executed: false, gatePassed: false, gate: null } }),
		}, tagPaint);
		expect(lines[0]).toBe("<heading>Interrupted candidate</heading> <dim>candidate-1</dim> <dim>·</dim> <accent>built</accent>");
		expect(lines[lines.length - 1]).toBe("<warning>Verification stopped before evidence was complete. /discard abandons this attempt so the applied proposal can be retried.</warning>");
	});

	it("renders a workflow placeholder with the stage label and headline", () => {
		expect(renderReview({ kind: "workflow", stage: "spec-design", headline: "Describe the agent to draft a Spec." }, plainPaint))
			.toEqual(["Spec design", "  Describe the agent to draft a Spec."]);
	});
});

// ---------------------------------------------------------------------------
// 3. renderTraces
// ---------------------------------------------------------------------------

describe("renderTraces", () => {
	it("summarises the evaluation with a pass bar and lists the diagnosis", () => {
		const lines = renderTraces(makeTraces(), plainPaint);
		expect(lines[0]).toBe("Evaluation 6/10 passed ██████████░░░░░░ 60% · 4 failed · 0 errors · 1 repetition · eval-1");
		// Which run the operator is reading: id, when, the revision it measured, the basket.
		expect(lines[1]).toBe("Showing eval-1 · 2026-09-01 09:00:07Z · revision 4d533f0703 · Ombudsman basket · 10 cases");
		expect(lines[2]).toBe("Diagnosis actionable · One systemic failure mode blocks 4 of 10 cases");
		expect(lines[3]).toBe("Failure modes 1 systemic · 0 task-local");
		expect(lines[4]).toBe("  1. Agent skips the lookup tool — 4 tasks (40% · reproduces 80%)");
		expect(lines[5]).toBe("     systemic · major · evidence high · → propose fix");
		expect(lines[6]).toBe("     Hypothesis: The instructions never mention the lookup tool.");
		expect(lines[7]).toBe("     suggest: Mention the lookup tool in the instructions");
		expect(lines[8]).toBe("Evidence http://127.0.0.1:4310/evidence/eval-1");
		expect(lines[9]).toBe("Next say “fix the first problem” (or name a mode) to prepare an exact proposal");
		expect(lines).toHaveLength(10);
	});

	it("tones the summary by errors and failures", () => {
		const errors = renderTraces(makeTraces({}, {
			evaluation: { evalRunId: "eval-2", summary: { total: 10, pass: 7, fail: 2, error: 1, allPassRate: 0.7 }, repetitions: 2, finishedAt: "2026-09-01T09:00:07.000Z", targetGitSha: "4d533f07030f0a4b1c2d3e4f5a6b7c8d9e0f1a2b", corpus: null },
		}), tagPaint);
		expect(errors[0]).toContain("<warning><bold>7/10 passed</bold></warning>");
		expect(errors[0]).toContain("<error>2 failed</error>");
		expect(errors[0]).toContain("<warning>1 errors</warning>");
		expect(errors[0]).toContain("<dim>· 2 repetitions · eval-2</dim>");
		const perfect = renderTraces(makeTraces({}, {
			evaluation: { evalRunId: "eval-3", summary: { total: 4, pass: 4, fail: 0, error: 0, allPassRate: 1 }, repetitions: 1, finishedAt: "2026-09-01T09:00:07.000Z", targetGitSha: "4d533f07030f0a4b1c2d3e4f5a6b7c8d9e0f1a2b", corpus: null },
		}), tagPaint);
		expect(perfect[1]).toContain("its basket is no longer published");
		expect(perfect[0]).toContain("<success><bold>4/4 passed</bold></success>");
		expect(perfect[0]).toContain("<muted>0 failed</muted>");
		expect(perfect[0]).toContain("<muted>0 errors</muted>");
	});

	it("renders every decision with selectable and non-selectable proposals", () => {
		const modes = [
			makeMode({ ordinal: 1, decision: "propose-harness-change", selectableForProposal: true }),
			makeMode({ ordinal: 2, decision: "propose-harness-change", selectableForProposal: false, title: "Second", scope: "task-local", severity: "minor", evidenceStrength: "low" }),
			makeMode({ ordinal: 3, decision: "stabilize-and-rerun", title: "Flaky", suggestions: [] }),
			makeMode({ ordinal: 4, decision: "repair-evidence-path", title: "Broken trace" }),
		];
		const text = renderTraces(makeTraces({ modes, conversationProjection: { shownModes: 4, addressableModes: 1, omittedModes: 2, fullEvidence: "x" } }), tagPaint).join("\n");
		expect(text).toContain("<warning>systemic</warning> <dim>·</dim> major <dim>·</dim> evidence high <dim>·</dim> <success>→ propose fix</success>");
		expect(text).toContain("<muted>task-local</muted> <dim>·</dim> minor <dim>·</dim> evidence low <dim>·</dim> <muted>→ not selectable</muted>");
		expect(text).toContain("<warning>→ rerun to stabilize</warning>");
		expect(text).toContain("<error>→ repair evidence path</error>");
		expect(text).toContain("<bold>3.</bold> <bold>Flaky</bold>");
		expect(text).toContain("  <dim>… +2 more modes in the Evidence Explorer</dim>");
		const suggestLines = text.split("\n").filter((line) => line.includes("suggest:"));
		expect(suggestLines).toHaveLength(3);
	});

	it("explains inconclusive and healthy runs without modes", () => {
		const inconclusive = renderTraces(makeTraces({
			status: "inconclusive",
			proposalEligible: false,
			modes: [],
			summary: { tasks: 10, failedTasks: 0, infrastructureErrors: 3, failureModeCount: 0, systemicFailureModeCount: 0, taskLocalFailureModeCount: 0, omittedFailureModeCount: 0 },
		}, { evidence: { available: false } }), plainPaint);
		expect(inconclusive).toContain("Diagnosis inconclusive · One systemic failure mode blocks 4 of 10 cases");
		expect(inconclusive).toContain("  3 infrastructure errors made this run inconclusive; repair the evidence path and rerun.");
		expect(inconclusive).toContain("Evidence explorer link unavailable");
		expect(inconclusive[inconclusive.length - 1]).toBe("Next repair the inconclusive evidence path, then /run again");
		const healthy = renderTraces(makeTraces({
			status: "healthy",
			proposalEligible: false,
			modes: [],
			summary: { tasks: 10, failedTasks: 0, infrastructureErrors: 0, failureModeCount: 0, systemicFailureModeCount: 0, taskLocalFailureModeCount: 0, omittedFailureModeCount: 0 },
		}), tagPaint);
		expect(healthy).toContain("<success>  No failure modes: every development case passed.</success>");
		expect(healthy[healthy.length - 1]).toBe("<dim>Next</dim> add harder cases, or /run again to measure stability");
		expect(healthy.join("\n")).toContain("<dim>Diagnosis</dim> <success>healthy</success>");
		expect(healthy.join("\n")).toContain("<link>http://127.0.0.1:4310/evidence/eval-1</link>");
	});
});

// ---------------------------------------------------------------------------
// 4. renderTarget
// ---------------------------------------------------------------------------

describe("renderTarget", () => {
	it("explains a missing target with the launch command", () => {
		const missing: WorkbenchTargetDetail = { launch: "ahde init ." };
		expect(renderTarget(missing, plainPaint)).toEqual([
			"Target not created yet",
			"Next describe the agent; the Builder scaffolds it (or run ahde init .)",
		]);
	});

	it("renders identity, execution policy, and resources with an executable marker", () => {
		const lines = renderTarget(targetContext, plainPaint);
		expect(lines[0]).toBe("Target support-bot @ aaaaaaaaaa");
		expect(lines[1]).toBe("Model openai/gpt-5 · thinking medium");
		expect(lines[2]).toBe("Execution tools lookup, reply · network deny · sandbox required · env HOME");
		expect(lines[3]).toBe("Resources");
		expect(lines[4]).toBe(`  ${"AGENTS.md".padEnd(40)} ${"instructions".padEnd(16)} 2.0 KB`);
		expect(lines[5]).toBe(`  ${"tools/lookup.tool.yaml".padEnd(40)} ${"tool descriptor".padEnd(16)} 512 B`);
		expect(lines[6]).toBe(`  ${"tools/lookup".padEnd(40)} ${"tool executable".padEnd(16)} 1.5 KB · executable`);
		expect(lines[7]).toBe("Launch ahde target · talk to the built agent in its own isolated Pi");
		expect(lines).toHaveLength(8);
	});

	it("renders empty tool and env lists as none", () => {
		const text = renderTarget({
			...targetContext,
			target: { ...targetContext.target, execution: { tools: [], environmentAllowlist: [], network: "allow", sandbox: "off" } },
		}, plainPaint).join("\n");
		expect(text).toContain("Execution tools none · network allow · sandbox off · env none");
	});

	it("prints a requested resource verbatim and indented", () => {
		const lines = renderTarget({
			...targetContext,
			resource: { kind: "instructions", name: null, path: "AGENTS.md", mode: "100644", bytes: 2048, sha256: HASH, content: "# Support bot\nAlways call lookup first." },
		}, tagPaint);
		const text = lines.join("\n");
		expect(text).toContain("\n\n<heading>AGENTS.md</heading> <dim>instructions · 2.0 KB · cccccccccccc…</dim>\n  # Support bot\n  Always call lookup first.\n");
		expect(lines[lines.length - 1]).toBe("<dim>Launch</dim> <bold>ahde target</bold> <dim>· talk to the built agent in its own isolated Pi</dim>");
	});
});

// ---------------------------------------------------------------------------
// 5. renderImpact
// ---------------------------------------------------------------------------

describe("renderImpact", () => {
	it("renders nothing for a null projection and the reason when unavailable", () => {
		expect(renderImpact(null, plainPaint)).toEqual([]);
		expect(renderImpact({ available: false, reason: "no comparison recorded" }, tagPaint))
			.toEqual(["<dim>Impact</dim> <muted>unavailable — no comparison recorded</muted>"]);
	});

	it("renders every targeted outcome with its glyph and tone", () => {
		const impact = makeImpact({
			verdict: "mixed",
			proposalBasis: {
				...makeImpact().proposalBasis!,
				targetedFailureModes: [
					targetedMode("resolved"),
					targetedMode("improved", { category: "output-contract", candidate: counts(1, 4), candidateAffectedTasks: 1 }),
					targetedMode("persisted", { category: "answer-quality", candidate: counts(4, 4), candidateAffectedTasks: 2 }),
					targetedMode("worsened", { category: "flaky-behavior", baseline: counts(2, 4), candidate: counts(4, 4), candidateAffectedTasks: 2 }),
					targetedMode("not-reproduced", { category: "infrastructure", baseline: counts(0, 4), candidate: counts(0, 4), candidateAffectedTasks: 0 }),
				],
			},
		});
		const lines = renderImpact({ available: true, impact }, tagPaint);
		expect(lines[0]).toBe("<dim>Impact</dim> <warning>mixed</warning> <dim>· cost ×1.4 · latency ×0.9 · tokens ×1.1</dim>");
		expect(lines[1]).toBe("  <dim>Targeted 5 failure modes:</dim>");
		expect(lines[2]).toBe("    <success>✓</success> <success>resolved</success> · tool-selection · baseline 4/4 failed → candidate 0/4 failed · 0/2 tasks still affected");
		expect(lines[3]).toBe("    <success>↑</success> <success>improved</success> · output-contract · baseline 4/4 failed → candidate 1/4 failed · 1/2 tasks still affected");
		expect(lines[4]).toBe("    <warning>=</warning> <warning>persisted</warning> · answer-quality · baseline 4/4 failed → candidate 4/4 failed · 2/2 tasks still affected");
		expect(lines[5]).toBe("    <error>↓</error> <error>worsened</error> · flaky-behavior · baseline 2/4 failed → candidate 4/4 failed · 2/2 tasks still affected");
		expect(lines[6]).toBe("    <warning>?</warning> <warning>not-reproduced</warning> · infrastructure · baseline 0/4 failed → candidate 0/4 failed · 0/2 tasks still affected");
		expect(lines).toHaveLength(7);
	});

	it("tones every verdict", () => {
		const verdicts: [CandidateImpact["verdict"], string][] = [
			["improved", "<success>improved</success>"],
			["mixed", "<warning>mixed</warning>"],
			["no-change", "<muted>no change</muted>"],
			["regressed", "<error>regressed</error>"],
		];
		for (const [verdict, expected] of verdicts) {
			expect(renderImpact({ available: true, impact: makeImpact({ verdict }) }, tagPaint)[0])
				.toBe(`<dim>Impact</dim> ${expected}${" <dim>· cost ×1.4 · latency ×0.9 · tokens ×1.1</dim>"}`);
		}
	});

	it("explains a candidate without a diagnosis basis", () => {
		const lines = renderImpact({ available: true, impact: makeImpact({ verdict: "no-change", proposalBasis: null }) }, plainPaint);
		expect(lines).toEqual([
			"Impact no change · cost ×1.4 · latency ×0.9 · tokens ×1.1",
			"  No targeted failure modes: this candidate was not authored from a diagnosis.",
		]);
	});

	it("names what the tool cases answer, and what the gate answers instead", () => {
		const lines = renderImpact(
			{ available: true, impact: makeImpact({ verdict: "improved", proposalBasis: null }) },
			plainPaint,
			{ tools: ["weather", "crm"] },
		);
		expect(lines[1]).toBe("  Tool contract for weather, crm, through the development cases:");
		expect(lines[2]).toBe(
			"    calls the tool · right arguments · says so when it fails · no credential in the answer. " +
			"“Answers better” is the gate above.",
		);
		// A candidate that changed no tool says nothing about tool contracts.
		expect(renderImpact({ available: true, impact: makeImpact({ proposalBasis: null }) }, plainPaint))
			.not.toContain("Tool contract");
	});

	it("lists new and worsened failure modes with omitted counts", () => {
		const lines = renderImpact({
			available: true,
			impact: makeImpact({
				verdict: "regressed",
				newFailureModes: [nonTargetedMode("output-contract")],
				omittedNewFailureModeCount: 2,
				worsenedFailureModes: [nonTargetedMode("answer-quality", { baseline: counts(1, 4), candidate: counts(3, 4) })],
			}),
		}, plainPaint);
		const text = lines.join("\n");
		expect(text).toContain("  New 1 failure mode:\n    ✗ output-contract · 2 tasks · candidate 3/4 failed\n    … +2 more");
		expect(text).toContain("  Worsened 1 failure mode:\n    ↓ answer-quality · baseline 1/4 failed → candidate 3/4 failed");
	});

	it("folds task regressions after eight rows including omitted ones", () => {
		const regressions = Array.from({ length: 10 }, (_, index) => regression(index + 1));
		const lines = renderImpact({
			available: true,
			impact: makeImpact({ verdict: "regressed", taskRegressions: regressions, omittedTaskRegressionCount: 3 }),
		}, plainPaint);
		const text = lines.join("\n");
		expect(text).toContain("  Task 10 regressions:");
		expect(text).toContain("    ↓ task-regressed-1 · 100% → 0%");
		expect(text).toContain("    ↓ task-regressed-8 · 100% → 0%");
		expect(text).not.toContain("task-regressed-9");
		expect(lines[lines.length - 1]).toBe("    … +5 more");
		const few = renderImpact({
			available: true,
			impact: makeImpact({ verdict: "regressed", taskRegressions: [regression(1)] }),
		}, plainPaint).join("\n");
		expect(few).toContain("  Task 1 regression:");
		expect(few).not.toContain("more");
	});

	it("lists inconclusive reasons", () => {
		const lines = renderImpact({
			available: true,
			impact: makeImpact({ verdict: "inconclusive", inconclusiveReasons: ["baseline run has no trace", "candidate basket differs"] }),
		}, tagPaint);
		expect(lines[0]).toBe("<dim>Impact</dim> <warning>inconclusive</warning> <dim>· cost ×1.4 · latency ×0.9 · tokens ×1.1</dim>");
		expect(lines.join("\n")).toContain("  <warning>Inconclusive because:</warning>\n    • baseline run has no trace\n    • candidate basket differs");
	});
});

// ---------------------------------------------------------------------------
// 6. renderDecision and decisionHeadline
// ---------------------------------------------------------------------------

describe("renderDecision", () => {
	const nextLine = (stage: WorkbenchStage): string => `Next ${nextStep(makeView({ stage }))} (${stageLabel(stage)})`;

	it("renders scaffold, configure, approve, and publish decisions", () => {
		expect(renderDecision(decision("scaffold-target", { targetId: "support-bot", targetGitSha: SHA_A, receiptId: "receipt-1" }, "target-setup"), plainPaint)).toEqual([
			"Target harness created support-bot @ aaaaaaaaaa",
			"Receipt receipt-1",
			nextLine("target-setup"),
		]);
		const configured = renderDecision(decision("configure-target", { targetId: "support-bot", targetGitSha: SHA_B, receiptId: "receipt-2", credentialEnv: "OPENAI_API_KEY" }, "spec-design"), plainPaint);
		expect(configured).toEqual([
			"Target configured support-bot @ bbbbbbbbbb",
			"Model openai/gpt-5 · credential env OPENAI_API_KEY present",
			nextLine("spec-design"),
		]);
		const missingModel: WorkbenchDecisionResult = {
			kind: "configure-target",
			message: "configured",
			result: { targetId: "support-bot", targetGitSha: SHA_B, receiptId: "receipt-2", credentialEnv: "OPENAI_API_KEY" },
			view: makeView({ stage: "spec-design", target: { status: "ready", id: "support-bot", gitSha: SHA_B, model: null } }),
		};
		expect(renderDecision(missingModel, tagPaint)[1]).toBe("<dim>Model</dim> — <dim>· credential env</dim> <bold>OPENAI_API_KEY</bold> <warning>missing — export OPENAI_API_KEY before running</warning>");
		expect(renderDecision(decision("approve-spec", { approvedSpecId: "spec-1", receiptId: "receipt-3" }, "corpus-design"), plainPaint)).toEqual([
			"Spec approved spec-1",
			nextLine("corpus-design"),
		]);
		expect(renderDecision(decision("publish-corpus", { corpusId: "corpus-1", corpusHash: HASH, taskCount: 3, publicationReceiptId: "receipt-4", lineageHash: HASH }, "ready-to-evaluate"), plainPaint)).toEqual([
			"Development basket published 3 cases · corpus-1 · cccccccccccc…",
			nextLine("ready-to-evaluate"),
		]);
	});

	it("renders eval runs with the live trace link", () => {
		const traces = makeTraces();
		const lines = renderDecision(decision("run-eval", traces, "improvement-authoring"), tagPaint, { liveTraceUrl: "http://127.0.0.1:4310/live/abc" });
		const text = lines.join("\n");
		expect(lines[0]).toContain("<heading>Evaluation</heading>");
		expect(text).toContain("<dim>Live trace</dim> <link>http://127.0.0.1:4310/live/abc</link> <dim>· retained for 15 minutes</dim>");
		expect(lines[lines.length - 1]).toBe(`<dim>Next</dim> ${nextStep(makeView({ stage: "improvement-authoring" }))} <dim>(Diagnosis)</dim>`);
		const noLive = renderDecision(decision("run-eval", traces, "improvement-authoring"), plainPaint).join("\n");
		expect(noLive).not.toContain("Live trace");
	});

	it("renders both run-current resolutions", () => {
		const asEval = renderDecision(decision("run-current", { resolvedAs: "run-eval", ...makeTraces() }, "improvement-authoring"), plainPaint, { liveTraceUrl: "http://127.0.0.1:4310/live/abc" });
		expect(asEval[0]).toContain("Evaluation 6/10 passed");
		expect(asEval).toContain("Live trace http://127.0.0.1:4310/live/abc · retained for 15 minutes");
		expect(asEval[asEval.length - 1]).toBe(nextLine("improvement-authoring"));
		const asVerify = renderDecision(decision("run-current", { resolvedAs: "verify-candidate", outcome: "verified" as const, screen: null, candidate: makeCandidate(), development: { verdict: "improved", delta: 0.2, confidence95: { low: 0.05, high: 0.35 } }, sealedHoldout: { executed: true, gatePassed: true, verdict: "pass" } }, "candidate-review"), plainPaint);
		expect(asVerify[0]).toBe("Candidate verified candidate-1 · evaluated");
		expect(asVerify[asVerify.length - 1]).toBe(nextLine("candidate-review"));
		expect(asVerify.join("\n")).not.toContain("Live trace");
	});

	it("renders verification, apply, discard, and abandon decisions", () => {
		const verified = renderDecision(decision("verify-candidate", { outcome: "verified" as const, screen: null, candidate: makeCandidate(), development: { verdict: "improved", delta: 0.2, confidence95: { low: 0.05, high: 0.35 } }, sealedHoldout: { executed: true, gatePassed: true, verdict: "pass" } }, "candidate-review"), plainPaint);
		expect(verified[0]).toBe("Candidate verified candidate-1 · evaluated");
		expect(verified).toContain("Sealed holdout gate passed");
		expect(verified[verified.length - 1]).toBe(nextLine("candidate-review"));
		expect(renderDecision(decision("apply-proposal", { runId: "run-1", branch: "ahde/fix-lookup", candidateSha: SHA_B, proposalHash: HASH }, "candidate-verification"), plainPaint)).toEqual([
			"Proposal applied branch ahde/fix-lookup · candidate bbbbbbbbbb · proposal cccccccccccc…",
			"Your checkout was not switched; the candidate lives on its own branch until you adopt it.",
			nextLine("candidate-verification"),
		]);
		expect(renderDecision(decision("discard-proposal", { runId: "run-1", receiptHash: HASH }, "improvement-authoring"), plainPaint)).toEqual([
			"Proposal discarded run-1",
			nextLine("improvement-authoring"),
		]);
		expect(renderDecision(decision("abandon-candidate", { candidateId: "candidate-1", interruptedStatus: "built", receiptHash: HASH }, "candidate-verification"), plainPaint)).toEqual([
			"Interrupted candidate abandoned candidate-1 · stopped at built",
			"The applied proposal can be verified again whenever you ask to check it.",
			nextLine("candidate-verification"),
		]);
	});

	it("renders review, promote, reject, adopt, and continue decisions", () => {
		const reviewed = renderDecision(decision("review-candidate", makeCandidate({ status: "reviewed", review: { experimentId: "exp-1", recommendation: "promote", reason: "good" } }), "release-decision"), plainPaint);
		expect(reviewed[0]).toBe("Review recorded candidate-1 · reviewed");
		expect(reviewed).toContain("Review promote — good");
		expect(reviewed[reviewed.length - 1]).toBe(nextLine("release-decision"));
		expect(renderDecision(decision("promote-candidate", { candidate: makeCandidate({ status: "promoted" }), tag: "v1.2.0", candidateSha: SHA_B, guards: { draftId: null, cases: 0, taskIds: [], warning: null } }, "candidate-adoption"), tagPaint)).toEqual([
			"<heading>Candidate promoted</heading> <success>v1.2.0</success> <dim>· bbbbbbbbbb</dim>",
			"<muted>The tag records the exact reviewed revision. The active agent is unchanged until you ask to adopt it.</muted>",
			`<dim>Next</dim> ${nextStep(makeView({ stage: "candidate-adoption" }))} <dim>(Adopt candidate)</dim>`,
		]);
		const rejected = renderDecision(decision("reject-candidate", makeCandidate({ status: "rejected", rejection: { reason: "worse", at: AT } }), "complete"), plainPaint);
		expect(rejected[0]).toBe("Candidate rejected candidate-1 · rejected");
		expect(rejected[rejected.length - 1]).toBe(nextLine("complete"));
		const adopted = renderDecision(decision("adopt-candidate", {
			candidate: makeCandidate({ status: "promoted" }),
			disposition: "adopted",
			branch: "main",
			fromSha: SHA_A,
			toSha: SHA_B,
			tag: "v1.2.0",
			receiptId: "adopt-1",
		}, "complete"), plainPaint);
		expect(adopted).toEqual([
			"Candidate adopted branch main aaaaaaaaaa → bbbbbbbbbb · v1.2.0",
			"The promoted harness is now the active Target for `ahde target` and the next cycle.",
			nextLine("complete"),
		]);
		const recovered = renderDecision(decision("adopt-candidate", {
			candidate: makeCandidate({ status: "promoted" }),
			disposition: "recovered",
			branch: "main",
			fromSha: SHA_A,
			toSha: SHA_B,
			tag: "v1.2.0",
			receiptId: "adopt-1",
		}, "complete"), plainPaint);
		expect(recovered[0]).toBe("Candidate adopted branch main aaaaaaaaaa → bbbbbbbbbb · v1.2.0 · recovered");
		expect(renderDecision(decision("continue-cycle", {
			candidate: makeCandidate({ status: "promoted" }),
			disposition: "recorded",
			activeTargetSha: SHA_B,
			receiptId: "cont-1",
			nextStage: "improvement-authoring",
		}, "improvement-authoring"), plainPaint)).toEqual([
			"Cycle closed active Target bbbbbbbbbb · promoted candidate candidate-1",
			nextLine("improvement-authoring"),
		]);
	});

	it("never prints JSON for any decision kind", () => {
		const all: WorkbenchDecisionResult[] = [
			decision("scaffold-target", { targetId: "t", targetGitSha: SHA_A, receiptId: "r" }, "target-setup"),
			decision("configure-target", { targetId: "t", targetGitSha: SHA_A, receiptId: "r", credentialEnv: "K" }, "spec-design"),
			decision("approve-spec", { approvedSpecId: "s", receiptId: "r" }, "corpus-design"),
			decision("publish-corpus", { corpusId: "c", corpusHash: HASH, taskCount: 1, publicationReceiptId: "r", lineageHash: HASH }, "ready-to-evaluate"),
			decision("run-eval", makeTraces(), "improvement-authoring"),
			decision("run-current", { resolvedAs: "run-eval", ...makeTraces() }, "improvement-authoring"),
			decision("run-current", { resolvedAs: "verify-candidate", outcome: "verified" as const, screen: null, candidate: makeCandidate(), development: { verdict: "improved", delta: 0.2, confidence95: { low: 0.05, high: 0.35 } }, sealedHoldout: { executed: false, gatePassed: false, verdict: null } }, "candidate-review"),
			decision("apply-proposal", { runId: "r", branch: "b", candidateSha: SHA_B, proposalHash: HASH }, "candidate-verification"),
			decision("discard-proposal", { runId: "r", receiptHash: HASH }, "improvement-authoring"),
			decision("verify-candidate", { outcome: "verified" as const, screen: null, candidate: makeCandidate(), development: { verdict: "improved", delta: 0.2, confidence95: { low: 0.05, high: 0.35 } }, sealedHoldout: { executed: true, gatePassed: false, verdict: "fail" } }, "candidate-review"),
			decision("abandon-candidate", { candidateId: "c", interruptedStatus: "proposed", receiptHash: HASH }, "candidate-verification"),
			decision("review-candidate", makeCandidate(), "release-decision"),
			decision("promote-candidate", { candidate: makeCandidate(), tag: "v1.0.0", candidateSha: SHA_B, guards: { draftId: null, cases: 0, taskIds: [], warning: null } }, "candidate-adoption"),
			decision("reject-candidate", makeCandidate(), "complete"),
			decision("adopt-candidate", { candidate: makeCandidate(), disposition: "already-adopted", branch: "main", fromSha: SHA_A, toSha: SHA_B, tag: "v1.0.0", receiptId: "r" }, "complete"),
			decision("continue-cycle", { candidate: makeCandidate(), disposition: "already-recorded", activeTargetSha: SHA_B, receiptId: "r", nextStage: "improvement-authoring" }, "improvement-authoring"),
		];
		for (const result of all) {
			const text = renderDecision(result, plainPaint).join("\n");
			expect(text.length, result.kind).toBeGreaterThan(0);
			expect(text, result.kind).not.toContain("{");
			expect(text, result.kind).toContain("Next ");
		}
	});
});

describe("renderDecision · calibrate", () => {
	it("renders the calibration panel and the next step", () => {
		const result = decision("calibrate", { candidateId: "calibration-1", calibration: makeCalibration() }, "ready-to-evaluate");
		const lines = renderDecision(result, plainPaint);
		expect(lines[0]).toBe("Noise calibrated calibration-1");
		expect(lines).toContain("Recommended 3 repetitions per run to keep noise under 10 points");
		expect(lines[lines.length - 1]).toBe(`Next ${nextStep(makeView({ stage: "ready-to-evaluate" }))} (${stageLabel("ready-to-evaluate")})`);
		const withTrace = renderDecision(result, plainPaint, { liveTraceUrl: "http://127.0.0.1:4312/live/abc" });
		expect(withTrace.join("\n")).toContain("Live trace http://127.0.0.1:4312/live/abc");
	});

	it("summarises the calibration in one headline", () => {
		expect(decisionHeadline(decision("calibrate", { candidateId: "calibration-1", calibration: makeCalibration() }, "ready-to-evaluate")))
			.toBe("A/A inconclusive · ±6.0pp · flip 10% · 3 reps recommended");
	});
});

describe("decisionHeadline", () => {
	it("summarises runs, verifications, and falls back to the one-line message", () => {
		expect(decisionHeadline(decision("run-eval", makeTraces(), "improvement-authoring"))).toBe("6/10 passed · 1 failure modes");
		expect(decisionHeadline(decision("run-current", { resolvedAs: "run-eval", ...makeTraces() }, "improvement-authoring"))).toBe("6/10 passed · 1 failure modes");
		expect(decisionHeadline(decision("run-current", { resolvedAs: "verify-candidate", outcome: "verified" as const, screen: null, candidate: makeCandidate(), development: { verdict: "improved", delta: 0.2, confidence95: { low: 0.05, high: 0.35 } }, sealedHoldout: { executed: true, gatePassed: true, verdict: "pass" } }, "candidate-review"))).toBe("candidate evaluated");
		expect(decisionHeadline(decision("verify-candidate", { outcome: "verified" as const, screen: null, candidate: makeCandidate(), development: { verdict: "improved", delta: 0.2, confidence95: { low: 0.05, high: 0.35 } }, sealedHoldout: { executed: true, gatePassed: true, verdict: "pass" } }, "candidate-review"))).toBe("candidate evaluated · development improved · sealed pass");
		expect(decisionHeadline(decision("verify-candidate", { outcome: "verified" as const, screen: null, candidate: makeCandidate(), development: { verdict: "improved", delta: 0.2, confidence95: { low: 0.05, high: 0.35 } }, sealedHoldout: { executed: false, gatePassed: false, verdict: null } }, "candidate-review"))).toBe("candidate evaluated · development improved · sealed not run");
		expect(decisionHeadline(decision("approve-spec", { approvedSpecId: "s", receiptId: "r" }, "corpus-design", `Spec approved${OSC}\n  as an exact\tsnapshot`))).toBe("Spec approved as an exact snapshot");
		expect(decisionHeadline(decision("discard-proposal", { runId: "r", receiptHash: HASH }, "improvement-authoring", "x".repeat(200)))).toBe(`${"x".repeat(119)}…`);
	});
});

// ---------------------------------------------------------------------------
// 7. renderConfirmation
// ---------------------------------------------------------------------------

describe("renderConfirmation", () => {
	function tail(lines: string[], reason = "Reviewed the exact subject"): void {
		expect(lines[lines.length - 3]).toBe("");
		expect(lines[lines.length - 2]).toBe(`Reason ${reason}`);
		expect(lines[lines.length - 1]).toBe(`Exact subject ${HASH}`);
	}
	/** Runs are computations, not artifacts: their confirmations end at the reason. */
	function ephemeralTail(lines: string[], reason = "Reviewed the exact subject"): void {
		expect(lines[lines.length - 2]).toBe("");
		expect(lines[lines.length - 1]).toBe(`Reason ${reason}`);
		expect(lines.join("\n")).not.toContain("Exact subject");
	}

	it("lists scaffold template files", () => {
		const lines = renderConfirmation(makeConfirmation("scaffold-target", {
			schemaVersion: 1,
			operation: "initialize-current-directory",
			targetPath: "/tmp/proj",
			targetId: "support-bot",
			templateFiles: [
				{ path: "manifest.yaml", bytes: 120, sha256: HASH },
				{ path: "AGENTS.md", bytes: 340, sha256: HASH },
			],
			templateHash: HASH,
		}), plainPaint);
		expect(lines.slice(0, 4)).toEqual([
			"Directory /tmp/proj",
			"Files 2 files from the trusted starter template, plus a fresh Git repository with one commit",
			"   1. manifest.yaml",
			"   2. AGENTS.md",
		]);
		tail(lines);
	});

	it("shows the model, credential env name, and manifest diff for configure-target", () => {
		const next = {
			targetId: "support-bot",
			model: { provider: "openai", id: "gpt-5", api: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", thinkingLevel: "medium", timeoutMs: 300000 },
			evalSuiteId: "default",
			manifestSha256: HASH,
		};
		const withDiff = renderConfirmation(makeConfirmation("configure-target", {
			schemaVersion: 1,
			baseTargetSha: SHA_A,
			previous: { ...next, targetId: "target" },
			next: { ...next, manifestDiff: "--- a/manifest.yaml\n+++ b/manifest.yaml\n@@ -1 +1 @@\n-id: target\n+id: support-bot\n" },
			subjectHash: HASH,
		}), tagPaint);
		expect(withDiff[0]).toBe("<dim>Target id</dim> <bold>support-bot</bold>");
		expect(withDiff[1]).toBe("<dim>Model</dim> openai/gpt-5 <dim>· thinking medium · timeout 300000 ms</dim>");
		expect(withDiff[2]).toBe("<dim>Credential env</dim> <bold>OPENAI_API_KEY</bold> <dim>(name only; set the value in your shell)</dim>");
		expect(withDiff[3]).toBe("<dim>manifest.yaml diff</dim>");
		expect(withDiff.join("\n")).toContain("<removed>-id: target</removed>\n<added>+id: support-bot</added>");
		expect(withDiff.join("\n")).not.toContain("sk-");
		const flatDiff = renderConfirmation(makeConfirmation("configure-target", { targetId: "support-bot", model: next.model, diff: "+id: support-bot" }), plainPaint);
		expect(flatDiff).toContain("manifest.yaml diff");
		expect(flatDiff).toContain("+id: support-bot");
		const noDiff = renderConfirmation(makeConfirmation("configure-target", { next }), plainPaint);
		expect(noDiff.join("\n")).toContain("manifest.yaml diff is not available");
		tail(noDiff);
	});

	it("summarises the spec for approve-spec", () => {
		const lines = renderConfirmation(makeConfirmation("approve-spec", {
			schemaVersion: 1,
			projectId: "proj",
			draftSpecId: "spec-draft-1",
			draftSnapshotHash: HASH,
			specContentHash: HASH,
			spec: makeSpec(),
		}), plainPaint);
		expect(lines.slice(0, 7)).toEqual([
			"Spec draft spec-draft-1 · cccccccccccc…",
			"Title Support triage agent",
			"  Answer tier-one support questions from the knowledge base.",
			"Users Support engineers",
			"Jobs 2 jobs · success criteria 1 · constraints 0",
			"Open questions: 1",
			"Approval freezes this exact Spec; evaluation cases and proposals will cite it.",
		]);
		tail(lines);
	});

	it("numbers the tasks for publish-corpus", () => {
		const draft = makeCorpusDraft();
		const lines = renderConfirmation(makeConfirmation("publish-corpus", {
			operation: "publish-development-corpus",
			draftId: draft.id,
			draftHash: HASH,
			approvedSpec: draft.approvedSpec,
			publication: { schemaVersion: 1, projectId: "proj", name: "Tier-one basket", visibility: "development", taskCount: 3, contentHash: HASH, subjectHash: HASH },
			tasks: draft.tasks,
		}), plainPaint);
		expect(lines.slice(0, 5)).toEqual([
			"Basket Tier-one basket · 3 cases · cccccccccccc…",
			"   1. Customer asks for a refund",
			"   2. Customer asks for shipping status",
			"   3. Customer asks to cancel",
			"Publishing makes these cases the development evidence for this Spec lineage.",
		]);
		tail(lines);
	});

	it("multiplies tasks by repetitions for run-eval", () => {
		const lines = renderConfirmation(makeConfirmation("run-eval", {
			operation: "run-development-evaluation",
			projectId: "proj",
			approvedSpec: { id: "spec-1", snapshotHash: HASH },
			target: { id: "support-bot", gitSha: SHA_A, toolsetHash: HASH },
			dataset: "evals/dev.jsonl",
			datasetHash: HASH,
			suiteHash: HASH,
			taskCount: 12,
			repetitions: 3,
			developmentCorpus: { id: "corpus-1", hash: HASH, taskCount: 12, lineageHash: HASH },
		}), plainPaint);
		expect(lines.slice(0, 2)).toEqual([
			"Run 12 cases × 3 repetitions = 36 Target executions · each one calls the Target model",
			"Target support-bot @ aaaaaaaaaa · basket corpus-1 (12 cases)",
		]);
		ephemeralTail(lines);
		const single = renderConfirmation(makeConfirmation("run-eval", { taskCount: 1, target: {}, developmentCorpus: {} }), plainPaint);
		expect(single[0]).toBe("Run 1 case × 1 repetition = 1 Target executions · each one calls the Target model");
	});

	it("prices the A/A calibration and says nothing is promoted", () => {
		const lines = renderConfirmation(makeConfirmation("calibrate", {
			operation: "calibrate-noise",
			target: { id: "support-bot", gitSha: SHA_A },
			developmentCorpus: { id: "corpus-1", hash: HASH, taskCount: 12 },
			repetitions: 3,
			executions: 72,
		}), plainPaint);
		expect(lines.slice(0, 4)).toEqual([
			"Calibrate noise run this exact revision twice · nothing is promoted",
			"Cost 12 cases × 3 repetitions = 72 Target executions · each one calls the Target model",
			"Target support-bot @ aaaaaaaaaa · basket corpus-1",
			"A/A measures how much the agent disagrees with itself, so later deltas can be believed.",
		]);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(110);
		ephemeralTail(lines);
	});

	/** The exact subject of an apply, as the confirmation builds it. */
	function applySubject(): Record<string, unknown> {
		return { operation: "apply-proposal", branch: "ahde/fix-lookup", builderRunHash: HASH, ...makeProposal() };
	}

	it("shows the diff and the price of the check the apply also authorizes", () => {
		const lines = renderConfirmation({
			...makeConfirmation("apply-proposal", applySubject()),
			estimate: { executions: 84, sampledRuns: 6, costUsd: 0.42, minutes: 3.2 },
		}, plainPaint);
		// The whole body, verbatim: the diff is on screen before anyone says yes,
		// and the money question for the check that follows is asked right here.
		expect(lines).toEqual([
			"Branch ahde/fix-lookup · base aaaaaaaaaa",
			"  Tell the agent to call lookup before answering.",
			"Changes AGENTS.md (+2 -1)",
			"Prediction no prediction stated",
			"Verification about $0.42 · about 4 minutes — approving this change also approves that measurement",
			"Risks",
			"  • May slow down simple replies",
			"Diff",
			"diff --git a/AGENTS.md b/AGENTS.md",
			"index 1111111..2222222 100644",
			"--- a/AGENTS.md",
			"+++ b/AGENTS.md",
			"@@ -1,2 +1,3 @@",
			" Existing line",
			"-Old guidance",
			"+New guidance",
			"+Use the lookup tool first",
			"Your checkout stays where it is; the proposal is committed on the candidate branch.",
			"",
			"Reason Reviewed the exact subject",
			`Exact subject ${HASH}`,
		]);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(110);
		// Every line is painted by the ordinary helpers; nothing here is raw text.
		const painted = renderConfirmation({
			...makeConfirmation("apply-proposal", applySubject()),
			estimate: { executions: 84, sampledRuns: 6, costUsd: 0.42, minutes: 3.2 },
		}, tagPaint);
		expect(painted[0]).toBe("<dim>Branch</dim> <bold>ahde/fix-lookup</bold> <dim>· base</dim> aaaaaaaaaa");
		expect(painted[2]).toBe("<dim>Changes</dim> AGENTS.md <dim>(<added>+2</added> <removed>-1</removed>)</dim>");
		expect(painted).toContain("<added>+New guidance</added>");
	});

	it("says the check is unknown when nothing comparable has run, and points long diffs at /review", () => {
		const unknown = renderConfirmation(makeConfirmation("apply-proposal", applySubject()), plainPaint);
		expect(unknown[4]).toBe(
			"Verification unknown · nothing comparable has run yet — approving this change also approves that measurement",
		);
		const sampled = renderConfirmation({
			...makeConfirmation("apply-proposal", applySubject()),
			estimate: { executions: 4, sampledRuns: 2, costUsd: 0.004, minutes: 0.5 },
		}, plainPaint);
		expect(sampled[4]).toBe(
			"Verification under $0.01 · under a minute — approving this change also approves that measurement",
		);

		const exactDiff = [DIFF.trimEnd(), ...Array.from({ length: 200 }, (_, index) => `+line-${index}`)].join("\n");
		const long = renderConfirmation(makeConfirmation("apply-proposal", {
			...applySubject(),
			...makeProposal({ exactDiff }),
		}), plainPaint);
		expect(long).toContain("+line-110");
		expect(long).not.toContain("+line-111");
		expect(long).toContain("… 89 more diff lines; /review shows the exact remainder");
	});

	it("describes a discard subject generically", () => {
		const lines = renderConfirmation(makeConfirmation("discard-proposal", {
			subject: { schemaVersion: 1, runId: "run-1", proposalSha256: HASH, baseTargetSha: SHA_A, summary: "Tell the agent to call lookup.", paths: ["AGENTS.md", "tools/lookup"] },
			subjectHash: HASH,
		}), plainPaint);
		expect(lines.slice(0, 9)).toEqual([
			"  schemaVersion 1",
			"  runId run-1",
			`  proposalSha256 ${HASH}`,
			`  baseTargetSha ${SHA_A}`,
			"  summary Tell the agent to call lookup.",
			"  paths (2 items)",
			"    • AGENTS.md",
			"    • tools/lookup",
			"Discarding is durable; the same proposal cannot be applied later.",
		]);
		tail(lines);
	});

	it("shows the holdout task count but never its identity for verify-candidate", () => {
		const lines = renderConfirmation(makeConfirmation("verify-candidate", {
			operation: "verify-applied-candidate",
			builderRunId: "run-1",
			builderRunHash: HASH,
			applyReceiptHash: HASH,
			proposalHash: HASH,
			baseTargetSha: SHA_A,
			candidateSha: SHA_B,
			approvedSpec: { projectId: "proj", specId: "spec-1", specContentHash: HASH, snapshotHash: HASH },
			developmentCorpus: { id: "corpus-1", hash: HASH },
			sealedHoldout: { id: "corpus-SEALED-IDENTITY", hash: SEALED_HASH, taskCount: 7 },
			repetitions: 2,
		}), plainPaint);
		const text = lines.join("\n");
		expect(lines.slice(0, 4)).toEqual([
			"Matched experiment baseline aaaaaaaaaa vs candidate bbbbbbbbbb · 2 repetitions",
			"Development basket corpus-1 (cccccccccccc…)",
			"Sealed holdout 7 cases · identity stays evaluator-only",
			"Both revisions run every case; the Builder never sees sealed content.",
		]);
		expect(text).not.toContain("SEALED-IDENTITY");
		expect(text).not.toContain("dddddddd");
		ephemeralTail(lines);
		const noDevelopment = renderConfirmation(makeConfirmation("verify-candidate", { baseTargetSha: SHA_A, candidateSha: SHA_B, developmentCorpus: null, sealedHoldout: { taskCount: 1 } }), plainPaint);
		expect(noDevelopment[0]).toBe("Matched experiment baseline aaaaaaaaaa vs candidate bbbbbbbbbb · 1 repetition");
		expect(noDevelopment[1]).toBe("Development basket none");
		expect(noDevelopment[2]).toBe("Sealed holdout 1 case · identity stays evaluator-only");
	});

	it("renders candidate decisions with their specific closing lines", () => {
		const candidate = makeCandidate({ status: "reviewed", review: { experimentId: "exp-1", recommendation: "promote", reason: "good" } });
		const abandon = renderConfirmation(makeConfirmation("abandon-candidate", { operation: "abandon-interrupted-candidate", candidateHash: HASH, candidate: makeCandidate({ status: "built", development: null }) }), plainPaint);
		expect(abandon[0]).toBe("Candidate candidate-1 · built");
		expect(abandon).toContain("Abandoning records that this attempt produced no evidence; the applied proposal can be verified again.");
		tail(abandon);
		const review = renderConfirmation(makeConfirmation("review-candidate", {
			operation: "review-candidate",
			candidateHash: HASH,
			candidate: makeCandidate({
				appliedBy: { actorId: "operator", via: "improvement-loop", paths: ["AGENTS.md"] },
			}),
			proposal: makeProposal(),
			recommendation: "promote",
		}), tagPaint);
		expect(review[0]).toBe("<heading>Candidate</heading> <dim>candidate-1</dim> <dim>·</dim> <accent>evaluated</accent>");
		expect(review).toContain("<dim>Recommendation</dim> <bold>promote</bold>");
		expect(review.join("\n")).toContain("Use the lookup tool first");
		expect(review.join("\n")).toContain("Exact proposal");
		const promote = renderConfirmation(makeConfirmation("promote-candidate", { operation: "promote-candidate", candidateHash: HASH, candidate, version: "1.2.0", tag: "v1.2.0" }), tagPaint);
		expect(promote).toContain("<dim>Tag</dim> <success>v1.2.0</success> <dim>· annotated tag on the exact candidate revision</dim>");
		// What the promotion costs is on the confirmation the human approves.
		const priced = renderConfirmation(makeConfirmation("promote-candidate", {
			operation: "promote-candidate",
			candidateHash: HASH,
			candidate: makeCandidate({
				status: "reviewed",
				sealedHoldout: {
					executed: true,
					gatePassed: true,
					gate: {
						verdict: "pass",
						surface: "sealed",
						delta: 0.2,
						baselineScore: 0.62,
						candidateScore: 0.85,
						scoreDelta: 0.23,
						confidence95: { low: 0.05, high: 0.35 },
						tasks: 15,
						repetitions: 3,
						excludedTasks: 0,
						flags: { regressedTasks: 0, improvedTasks: 13, collapsedTasks: 0 },
						resources: { costRatio: 1.4, latencyRatio: 0.9, tokenRatio: 1.125 },
						reasons: ["no regression"],
					},
				},
			}),
			tag: "v1.2.0",
		}), plainPaint);
		expect(priced).toContain("Sealed holdout pass · +23 pts (95% CI +5 pts … +35 pts) · 15 × 3 · cost ×1.4 · latency ×0.9");
		const reject = renderConfirmation(makeConfirmation("reject-candidate", { operation: "reject-candidate", candidateHash: HASH, candidate }), plainPaint);
		expect(reject[0]).toBe("Candidate candidate-1 · reviewed");
		expect(reject).toContain("Review promote — good");
		expect(reject.join("\n")).not.toContain("Tag");
		tail(reject);
	});

	it("renders the fast-forward and changed files for adopt-candidate", () => {
		const lines = renderConfirmation(makeConfirmation("adopt-candidate", {
			operation: "adopt-candidate",
			candidateHash: HASH,
			candidate: makeCandidate({ status: "promoted", promotion: { tag: "v1.2.0", reason: "ship", at: AT } }),
			adoption: {
				schemaVersion: 1,
				algorithmId: "promoted-candidate-fast-forward-v1",
				candidate: {
					candidateId: "candidate-1",
					targetId: "support-bot",
					candidateRecordHash: HASH,
					baseline: { ref: "refs/heads/main", sha: SHA_A },
					revision: { ref: "refs/tags/v1.2.0", sha: SHA_B },
					changedFiles: ["AGENTS.md", "tools/lookup"],
				},
				branch: { name: "main", ref: "refs/heads/main" },
				promotion: { tag: "v1.2.0", tagRef: "refs/tags/v1.2.0", tagObjectSha: SHA_B, promotedAt: AT, actorId: "human", reason: "ship" },
				subjectHash: HASH,
			},
		}), plainPaint);
		const text = lines.join("\n");
		expect(text).toContain("Adopted not yet — /adopt fast-forwards the current branch");
		expect(text).toContain("Fast-forward branch main aaaaaaaaaa → bbbbbbbbbb\nChanged files AGENTS.md, tools/lookup\nOnly a clean worktree at the baseline is fast-forwarded; nothing is rebased or merged.");
		tail(lines);
	});

	it("renders the active Target for continue-cycle", () => {
		const lines = renderConfirmation(makeConfirmation("continue-cycle", {
			operation: "continue-cycle",
			candidateHash: HASH,
			candidate: makeCandidate({ status: "promoted" }),
			continuation: {
				schemaVersion: 1,
				algorithmId: "terminal-candidate-cycle-continuation-v1",
				projectId: "proj",
				targetId: "support-bot",
				candidate: { candidateId: "candidate-1", recordHash: HASH, status: "promoted", baselineSha: SHA_A, builtSha: SHA_B },
				activeTargetSha: SHA_B,
				branchRef: "refs/heads/main",
				adoptionReceiptHash: HASH,
				subjectHash: HASH,
			},
		}), tagPaint);
		const text = lines.join("\n");
		expect(text).toContain("<dim>Active Target</dim> bbbbbbbbbb <dim>·</dim> refs/heads/main\n<muted>Closing the cycle releases this candidate from focus; evidence stays immutable.</muted>");
	});

	it("falls back to a generic description for unexpected candidate and decision shapes", () => {
		const partial = renderConfirmation(makeConfirmation("reject-candidate", { candidate: { candidateId: "candidate-9" } }), plainPaint);
		expect(partial[0]).toBe("  candidateId candidate-9");
		const unknown = renderConfirmation(makeConfirmation("run-current", { repetitions: 2, nested: { deep: { deeper: true } }, list: [1, "two"], skipped: null }), plainPaint);
		expect(unknown.slice(0, 7)).toEqual([
			"  repetitions 2",
			"  nested",
			"    deep {\"deeper\":true}",
			"  list (2 items)",
			"    • 1",
			"    • two",
			"",
		]);
		ephemeralTail(unknown);
	});

	it("always ends with the Reason and Exact subject lines", () => {
		const kinds: WorkbenchDecisionInput["kind"][] = [
			"scaffold-target", "configure-target", "approve-spec", "publish-corpus", "run-eval", "apply-proposal",
			"discard-proposal", "verify-candidate", "abandon-candidate", "review-candidate", "promote-candidate",
			"reject-candidate", "adopt-candidate", "continue-cycle", "run-current",
		];
		const ephemeral = new Set<WorkbenchDecisionInput["kind"]>(["run-eval", "verify-candidate", "run-current"]);
		for (const kind of kinds) {
			const lines = renderConfirmation(makeConfirmation(kind, {}, "Because the reviewer said so"), plainPaint);
			if (ephemeral.has(kind)) {
				ephemeralTail(lines, "Because the reviewer said so");
				continue;
			}
			expect(lines[lines.length - 3], kind).toBe("");
			expect(lines[lines.length - 2], kind).toBe("Reason Because the reviewer said so");
			expect(lines[lines.length - 1], kind).toBe(`Exact subject ${HASH}`);
		}
	});
});

// ---------------------------------------------------------------------------
// 8. Sanitization
// ---------------------------------------------------------------------------

describe("sanitization", () => {
	it("keeps terminal control sequences out of reviews", () => {
		const spec = renderReview({
			kind: "spec-draft",
			id: "spec-draft-1",
			snapshotHash: HASH,
			spec: makeSpec({ title: HOSTILE, purpose: HOSTILE, users: [HOSTILE], jobs: [HOSTILE], openQuestions: [HOSTILE] }),
		}, plainPaint).join("\n");
		expectClean(spec);
		expect(spec).toContain(`${"Title".padEnd(15)} safetext more end`);
		expect(spec).toContain("Purpose\n  safetext\n  more end");
		expect(spec).toContain("Users\n  • safetext more end");
		const proposal = renderReview(makeProposal({
			summary: HOSTILE,
			paths: [HOSTILE],
			risks: [HOSTILE],
			exactDiff: `diff --git a/x b/x\n+${HOSTILE}\n-${OSC}gone\n`,
		}), plainPaint).join("\n");
		expectClean(proposal);
		expect(proposal).toContain("+safetext");
		expect(proposal).toContain("-gone");
		const corpus = renderReview(makeCorpusDraft({
			name: HOSTILE,
			coverageNotes: [HOSTILE],
			tasks: [{ id: taskId(1), input: HOSTILE, graders: [{ type: "judge", rubric: HOSTILE }, { type: "output_contains", text: HOSTILE, caseSensitive: false }] }],
		}), plainPaint).join("\n");
		expectClean(corpus);
		const candidate = renderReview(makeCandidateReview({
			review: { experimentId: "exp", recommendation: "reject", reason: HOSTILE },
			rejection: { reason: HOSTILE, at: `${AT}${CSI}` },
		}), plainPaint).join("\n");
		expectClean(candidate);
	});

	it("keeps terminal control sequences out of traces and targets", () => {
		const traces = renderTraces(makeTraces({
			headline: HOSTILE,
			modes: [makeMode({ title: HOSTILE, hypothesis: HOSTILE, suggestions: [HOSTILE] })],
		}), plainPaint).join("\n");
		expectClean(traces);
		expect(traces).toContain("Diagnosis actionable · safetext more end");
		expect(traces).toContain("  1. safetext more end — 4 tasks");
		expect(traces).toContain("     Hypothesis: safetext\n     more end");
		expect(traces).toContain("     suggest: safetext more end");
		const target = renderTarget({
			...targetContext,
			resources: [{ kind: "skill", name: "x", path: `skills/${OSC}x`, mode: "100644", bytes: 1, sha256: HASH }],
			resource: { kind: "instructions", name: null, path: "AGENTS.md", mode: "100644", bytes: 1, sha256: HASH, content: `line${OSC}\r\nnext${CSI}\tend` },
		}, plainPaint).join("\n");
		expectClean(target);
		expect(target).toContain("  line\n  next    end");
	});

	it("keeps terminal control sequences out of confirmations", () => {
		const lines = renderConfirmation(makeConfirmation("apply-proposal", {
			branch: HOSTILE,
			baseTargetSha: SHA_A,
			summary: HOSTILE,
			paths: [HOSTILE],
			risks: [HOSTILE],
			exactDiff: `+${HOSTILE}\n`,
		}, `Ship it${OSC} now${CSI}\r\n\tplease`), plainPaint);
		const text = lines.join("\n");
		expectClean(text);
		expect(lines[lines.length - 2]).toBe("Reason Ship it now please");
		const generic = renderConfirmation(makeConfirmation("run-current", { note: HOSTILE, list: [HOSTILE], nested: { inner: HOSTILE } }, "ok"), plainPaint).join("\n");
		expectClean(generic);
		const candidate = renderConfirmation(makeConfirmation("promote-candidate", { candidate: makeCandidate({ review: { experimentId: "e", recommendation: "promote", reason: HOSTILE } }), tag: HOSTILE }, "ok"), plainPaint).join("\n");
		expectClean(candidate);
	});

	it("keeps terminal control sequences out of the presenter notify fallback", () => {
		const notifications: { message: string; type: string | undefined }[] = [];
		const ctx = {
			ui: { notify: (message: string, type?: "info" | "warning" | "error") => { notifications.push({ message, type }); } },
		} as unknown as Pick<ExtensionContext, "ui">;
		createTranscriptPresenter({}).show(ctx, { title: "Panel", tone: "error", lines: [HOSTILE, markerPaint.warning(`warn${OSC}`)] });
		expect(notifications).toHaveLength(1);
		const message = notifications[0]?.message ?? "";
		expectClean(message);
		expect(message).toBe("Panel\nsafetext\nmore    end\nwarn");
		expect(notifications[0]?.type).toBe("error");
	});
});

// ---------------------------------------------------------------------------
// 9. Transcript
// ---------------------------------------------------------------------------

describe("transcript markers", () => {
	it("round-trips nested markers through applyPaint", () => {
		const line = `${markerPaint.accent(`Stage ${markerPaint.bold(markerPaint.success("ok"))}`)} plain ${markerPaint.dim("dim")}`;
		expect(applyPaint(line, tagPaint)).toBe("<accent>Stage <bold><success>ok</success></bold></accent> plain <dim>dim</dim>");
		expect(applyPaint(line, plainPaint)).toBe("Stage ok plain dim");
		expect(applyPaint("no markers", tagPaint)).toBe("no markers");
		expect(markerPaint.bold("")).toBe("");
		for (const code of ["heading", "muted", "warning", "error", "added", "removed", "link"] as const) {
			expect(applyPaint(markerPaint[code]("x"), tagPaint)).toBe(`<${code}>x</${code}>`);
		}
	});

	it("keeps marker-painted lines free of control characters", () => {
		const line = markerPaint.accent("x");
		expect(line).toContain("");
		expect(line).toContain("");
		expect(line.startsWith("a")).toBe(true);
		// Artifact text can never carry styling markers: clean() removes them, keeping the text.
		expect(clean(line)).toBe("x");
	});

	it("strips markers without touching the text", () => {
		const line = markerPaint.accent(`Stage ${markerPaint.bold("ok")}`);
		expect(stripMarkers(line)).toBe("Stage ok");
		// A stray marker with no valid code is dropped exactly like applyPaint drops it.
		expect(stripMarkers("q")).toBe("q");
		expect(applyPaint("q", plainPaint)).toBe("q");
		expect(applyPaint("q", tagPaint)).toBe("q");
		expect(stripMarkers("plain")).toBe("plain");
	});

	it("renders a persisted entry as a themed Text component", () => {
		const entry: TranscriptEntry = {
			schemaVersion: 1,
			title: "Spec review",
			tone: "info",
			lines: [markerPaint.bold("Title line"), "plain body"],
		};
		const component = renderTranscriptEntry(entry, fakeTheme);
		expect(component).toBeInstanceOf(Text);
		const rendered = component.render(200).join("\n");
		expect(rendered).toContain("◆ Spec review");
		expect(rendered).toContain("<b><accent>◆ Spec review</accent></b>");
		expect(rendered).toContain("<b>Title line</b>");
		expect(rendered).toContain("plain body");
		const warning = renderTranscriptEntry({ ...entry, tone: "warning" }, fakeTheme).render(200).join("\n");
		expect(warning).toContain("<b><warning>◆ Spec review</warning></b>");
		const error = renderTranscriptEntry({ ...entry, tone: "error" }, fakeTheme).render(200).join("\n");
		expect(error).toContain("<error>◆ Spec review</error>");
		const success = renderTranscriptEntry({ ...entry, tone: "success" }, fakeTheme).render(200).join("\n");
		expect(success).toContain("<success>◆ Spec review</success>");
	});
});

describe("createTranscriptPresenter", () => {
	function notifier(): { ctx: Pick<ExtensionContext, "ui">; notifications: { message: string; type: string | undefined }[] } {
		const notifications: { message: string; type: string | undefined }[] = [];
		const ctx = {
			ui: { notify: (message: string, type?: "info" | "warning" | "error") => { notifications.push({ message, type }); } },
		} as unknown as Pick<ExtensionContext, "ui">;
		return { ctx, notifications };
	}

	it("appends a persisted panel entry when the host supports it", () => {
		const appended: { customType: string; data: unknown }[] = [];
		const host: TranscriptHost = { appendEntry: (customType, data) => { appended.push({ customType, data }); } };
		const { ctx, notifications } = notifier();
		createTranscriptPresenter(host).show(ctx, { title: "Spec review", tone: "warning", lines: [markerPaint.bold("Line one"), `bad${OSC}line`] });
		expect(appended).toHaveLength(1);
		expect(appended[0]?.customType).toBe(AHDE_TRANSCRIPT_ENTRY_TYPE);
		expect(AHDE_TRANSCRIPT_ENTRY_TYPE).toBe("ahde-panel");
		expect(appended[0]?.data).toEqual({ schemaVersion: 1, title: "Spec review", tone: "warning", lines: [markerPaint.bold("Line one"), "badline"] });
		expect(notifications).toHaveLength(0);
	});

	it("defaults the tone to info and bounds entry lines", () => {
		const appended: { customType: string; data: unknown }[] = [];
		const host: TranscriptHost = { appendEntry: (customType, data) => { appended.push({ customType, data }); } };
		const { ctx } = notifier();
		const lines = Array.from({ length: 2_005 }, (_, index) => `line ${index}`);
		lines[0] = "x".repeat(5_000);
		createTranscriptPresenter(host).show(ctx, { title: "Big", lines });
		const entry = appended[0]?.data as TranscriptEntry;
		expect(entry.tone).toBe("info");
		expect(entry.lines).toHaveLength(2_001);
		expect([...entry.lines[0] ?? ""]).toHaveLength(4_000);
		expect(entry.lines[0]?.endsWith("…")).toBe(true);
		expect(entry.lines[1_999]).toBe("line 1999");
		expect(entry.lines[2_000]).toBe("… 5 more lines omitted");
	});

	it("falls back to a notification without appendEntry or when it throws", () => {
		const { ctx, notifications } = notifier();
		createTranscriptPresenter({}).show(ctx, { title: "Panel", tone: "success", lines: [markerPaint.accent("Accent"), "plain"] });
		expect(notifications).toEqual([{ message: "Panel\nAccent\nplain", type: "info" }]);
		const throwing: TranscriptHost = { appendEntry: () => { throw new Error("no transcript"); } };
		createTranscriptPresenter(throwing).show(ctx, { title: "Panel", tone: "warning", lines: ["x"] });
		expect(notifications[1]).toEqual({ message: "Panel\nx", type: "warning" });
		createTranscriptPresenter({}).show(ctx, { title: "Panel", tone: "error", lines: [] });
		expect(notifications[2]).toEqual({ message: "Panel", type: "error" });
		createTranscriptPresenter({}).show(ctx, { title: "Panel", lines: [] });
		expect(notifications[3]).toEqual({ message: "Panel", type: "info" });
	});

	it("sends hidden operator notes without triggering a turn", () => {
		const sent: { message: unknown; options: unknown }[] = [];
		const host: TranscriptHost = { sendMessage: (message, options) => { sent.push({ message, options }); } };
		const presenter = createTranscriptPresenter(host);
		presenter.note(`Operator ran /approve${OSC}${"y".repeat(5_000)}`);
		expect(sent).toHaveLength(1);
		const message = sent[0]?.message as { customType: string; content: string; display: boolean };
		expect(message.customType).toBe(AHDE_MODEL_NOTE_TYPE);
		expect(AHDE_MODEL_NOTE_TYPE).toBe("ahde-operator-note");
		expect(message.display).toBe(false);
		expect(message.content.startsWith("Operator ran /approvey")).toBe(true);
		expect(message.content).toHaveLength(4_000);
		expectClean(message.content);
		expect(sent[0]?.options).toEqual({ triggerTurn: false });
		expect(() => createTranscriptPresenter({}).note("nothing")).not.toThrow();
		const throwing: TranscriptHost = { sendMessage: () => { throw new Error("offline"); } };
		expect(() => createTranscriptPresenter(throwing).note("still fine")).not.toThrow();
	});
});

describe("registerAhdeTranscriptRenderer", () => {
	type Renderer = Parameters<ExtensionAPI["registerEntryRenderer"]>[1];

	function capture(): { pi: Pick<ExtensionAPI, "registerEntryRenderer">; registrations: { customType: string; renderer: Renderer }[] } {
		const registrations: { customType: string; renderer: Renderer }[] = [];
		const pi: Pick<ExtensionAPI, "registerEntryRenderer"> = {
			registerEntryRenderer: (customType, renderer) => {
				registrations.push({ customType, renderer: renderer as unknown as Renderer });
			},
		};
		return { pi, registrations };
	}

	function invoke(renderer: Renderer, data: unknown): ReturnType<Renderer> {
		const entry = { type: "custom", id: "entry-1", parentId: null, timestamp: AT, customType: AHDE_TRANSCRIPT_ENTRY_TYPE, data } as unknown as Parameters<Renderer>[0];
		return renderer(entry, {} as Parameters<Renderer>[1], fakeTheme as unknown as Parameters<Renderer>[2]);
	}

	it("registers the panel renderer once and renders valid entries", () => {
		const { pi, registrations } = capture();
		registerAhdeTranscriptRenderer(pi);
		expect(registrations).toHaveLength(1);
		expect(registrations[0]?.customType).toBe("ahde-panel");
		const renderer = registrations[0]?.renderer;
		if (!renderer) throw new Error("renderer was not registered");
		const component = invoke(renderer, { schemaVersion: 1, title: "Diagnosis", tone: "info", lines: [markerPaint.dim("Next"), "line"] });
		expect(component).toBeInstanceOf(Text);
		expect((component as Text).render(120).join("\n")).toContain("◆ Diagnosis");
	});

	it("returns undefined for malformed entry data", () => {
		const { pi, registrations } = capture();
		registerAhdeTranscriptRenderer(pi);
		const renderer = registrations[0]?.renderer;
		if (!renderer) throw new Error("renderer was not registered");
		const malformed: unknown[] = [
			null,
			undefined,
			"string",
			{},
			{ schemaVersion: 2, title: "x", tone: "info", lines: [] },
			{ schemaVersion: 1, title: 5, tone: "info", lines: [] },
			{ schemaVersion: 1, title: "x", tone: "info", lines: "not an array" },
			{ schemaVersion: 1, title: "x", tone: "info", lines: ["ok", 42] },
			{ schemaVersion: 1, title: "x", lines: [] },
		];
		for (const data of malformed) expect(invoke(renderer, data), JSON.stringify(data)).toBeUndefined();
	});

	it("ignores hosts without entry renderers", () => {
		expect(() => registerAhdeTranscriptRenderer({} as unknown as Pick<ExtensionAPI, "registerEntryRenderer">)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// 10. format helpers
// ---------------------------------------------------------------------------

describe("format helpers", () => {
	it("collapses and truncates one-line text by code point", () => {
		expect(oneLine("  a \n\n b\t c  ")).toBe("a b c");
		expect(oneLine("abcdef", 4)).toBe("abc…");
		expect(oneLine("abc", 3)).toBe("abc");
		expect(oneLine("abc", 0)).toBe("");
		expect(oneLine("😀😀😀😀", 3)).toBe("😀😀…");
		expect(oneLine("日本語テキスト", 4)).toBe("日本語…");
		expect(oneLine(`a${OSC}b`)).toBe("ab");
	});

	it("draws bars, percentages, and point deltas", () => {
		expect(bar(0.5, 10)).toBe("█████░░░░░");
		expect(bar(1)).toBe("█".repeat(20));
		expect(bar(2, 4)).toBe("████");
		expect(bar(-1, 4)).toBe("░░░░");
		expect(bar(Number.NaN, 4)).toBe("░░░░");
		expect(percent(0.256)).toBe("26%");
		expect(percent(1)).toBe("100%");
		expect(percent(Number.NaN)).toBe("—");
		expect(points(0.123)).toBe("+12.3 pts");
		expect(points(-0.05)).toBe("-5 pts");
		expect(points(0)).toBe("0 pts");
		expect(points(Number.POSITIVE_INFINITY)).toBe("—");
	});

	it("shortens shas and hashes", () => {
		expect(shortSha(SHA_A)).toBe("aaaaaaaaaa");
		expect(shortSha(SHA_A, 4)).toBe("aaaa");
		expect(shortSha(null)).toBe("—");
		expect(shortSha("")).toBe("—");
		expect(shortHash(HASH)).toBe("cccccccccccc…");
		expect(shortHash(HASH, 4)).toBe("cccc…");
		expect(shortHash("deadbeef")).toBe("deadbeef");
		expect(shortHash(undefined)).toBe("—");
	});

	it("formats bytes, timestamps, labels, and joins", () => {
		expect(bytes(0)).toBe("0 B");
		expect(bytes(512)).toBe("512 B");
		expect(bytes(1536)).toBe("1.5 KB");
		expect(bytes(2 * 1024 * 1024)).toBe("2.0 MB");
		expect(when(AT)).toBe("2026-08-28 10:00:00Z");
		expect(when(null)).toBe("—");
		expect(labeled("Title", "x", 8)).toBe("Title    x");
		expect(joinNonEmpty(["a", null, "", false, undefined, "b"])).toBe("a · b");
		expect(joinNonEmpty(["a", "b"], ", ")).toBe("a, b");
		expect(pluralize(1, "case")).toBe("1 case");
		expect(pluralize(2, "case")).toBe("2 cases");
		expect(pluralize(0, "entry", "entries")).toBe("0 entries");
		expect(clean("a\tb\r\nc")).toBe("a    b\nc");
	});

	it("wraps prose by visible width and keeps paragraph breaks", () => {
		expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
		expect(wrap("one two three four", 9, "  ")).toEqual(["  one two", "  three", "  four"]);
		expect(wrap("first paragraph\n\nsecond paragraph", 40)).toEqual(["first paragraph", "second paragraph"]);
		expect(wrap("   ")).toEqual([]);
		expect(wrap("supercalifragilistic word", 5)).toEqual(["supercalifragilistic", "word"]);
		expect(wrap("😀😀 😀😀 😀😀", 5)).toEqual(["😀😀 😀😀", "😀😀"]);
	});

	it("folds bullet and numbered lists", () => {
		expect(bullets(["a", "b", "c"], plainPaint, { limit: 2 })).toEqual(["  • a", "  • b", "  … +1 more"]);
		expect(bullets(["a"], tagPaint, { indent: "" })).toEqual(["<dim>•</dim> a"]);
		expect(bullets(["abcdef"], plainPaint, { max: 4 })).toEqual(["  • abc…"]);
		expect(numbered(["a", "b", "c"], plainPaint, { limit: 2, indent: "" })).toEqual([" 1. a", " 2. b", "… +1 more"]);
		expect(numbered(Array.from({ length: 12 }, (_, index) => `item ${index + 1}`), plainPaint)).toHaveLength(12);
		expect(numbered(Array.from({ length: 13 }, (_, index) => `item ${index + 1}`), plainPaint)).toHaveLength(13);
		expect(numbered(Array.from({ length: 13 }, (_, index) => `item ${index + 1}`), plainPaint)[12]).toBe("  … +1 more");
		expect(numbered(["x"], tagPaint)).toEqual(["  <dim> 1.</dim> x"]);
	});

	it("colors unified diffs and counts their stats", () => {
		expect(diffStats(DIFF)).toEqual({ files: 1, added: 2, removed: 1 });
		expect(diffStats("")).toEqual({ files: 0, added: 0, removed: 0 });
		const lines = renderUnifiedDiff(DIFF, tagPaint);
		expect(lines).toEqual([
			"<dim>diff --git a/AGENTS.md b/AGENTS.md</dim>",
			"<dim>index 1111111..2222222 100644</dim>",
			"<bold>--- a/AGENTS.md</bold>",
			"<bold>+++ b/AGENTS.md</bold>",
			"<accent>@@ -1,2 +1,3 @@</accent>",
			" Existing line",
			"<removed>-Old guidance</removed>",
			"<added>+New guidance</added>",
			"<added>+Use the lookup tool first</added>",
		]);
		expect(renderUnifiedDiff(DIFF, tagPaint, { maxLines: 2 })).toEqual([
			"<dim>diff --git a/AGENTS.md b/AGENTS.md</dim>",
			"<dim>index 1111111..2222222 100644</dim>",
			"<warning>… 7 more diff lines; open the full proposal artifact for the exact remainder</warning>",
		]);
		expect(renderUnifiedDiff("", plainPaint)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Bonus: renderView and viewTitle
// ---------------------------------------------------------------------------

describe("renderView and viewTitle", () => {
	it("combines status and detail with a blank separator", () => {
		const plain = renderView(makeView(), plainPaint);
		expect(plain).toEqual(renderStatus(makeView(), plainPaint));
		const withTraces = renderView(makeView({ detail: { aspect: "traces", content: makeTraces() } }), plainPaint);
		expect(withTraces.slice(0, 5)).toEqual(renderStatus(makeView(), plainPaint));
		expect(withTraces[5]).toBe("");
		expect(withTraces[6]).toContain("Evaluation 6/10 passed");
		const withReview = renderView(makeView({ detail: { aspect: "review", content: makeProposal() } }), plainPaint);
		expect(withReview).toContain("Proposal run-1");
		const withTarget = renderView(makeView({ detail: { aspect: "target", content: targetContext } }), plainPaint);
		expect(withTarget).toContain("Target support-bot @ aaaaaaaaaa");
	});

	it("titles every detail kind", () => {
		expect(viewTitle(makeView())).toBe("AHDE · Ready to run");
		expect(viewTitle(makeView({ detail: { aspect: "traces", content: makeTraces() } }))).toBe("AHDE · Diagnosis");
		expect(viewTitle(makeView({ detail: { aspect: "target", content: targetContext } }))).toBe("AHDE · Target");
		const reviews: [WorkbenchReviewDetail, string][] = [
			[{ kind: "spec-draft", id: "s", snapshotHash: HASH, spec: makeSpec() }, "AHDE · Spec review"],
			[makeCorpusDraft(), "AHDE · Eval basket review"],
			[makeProposal(), "AHDE · Proposal review"],
			[makeApplied(), "AHDE · Applied proposal"],
			[makeCandidateReview(), "AHDE · Candidate review"],
			[{ kind: "interrupted-candidate", ...makeCandidate() }, "AHDE · Interrupted candidate"],
			[{ kind: "workflow", stage: "complete", headline: "Done" }, "AHDE · Cycle complete"],
		];
		for (const [content, title] of reviews) {
			expect(viewTitle(makeView({ stage: "complete", detail: { aspect: "review", content } }))).toBe(title);
		}
	});
});

// ---------------------------------------------------------------------------
// The two screens a new tool has to pass through: what it may reach, and
// whether its own tests agree that it works.

const WEATHER_TOOL_DIFF = `diff --git a/tools/weather/tool.yaml b/tools/weather/tool.yaml
new file mode 100644
--- /dev/null
+++ b/tools/weather/tool.yaml
@@ -0,0 +1,14 @@
+schemaVersion: 1
+name: weather
+description: Current conditions for one city.
+parameters:
+  type: object
+  properties: {}
+  required: []
+  additionalProperties: false
+command:
+  argv: [tools/weather/run]
+permissions:
+  environment: [WEATHER_API_KEY]
+  network: allow
+  filesystem: read-only
diff --git a/tools/clock/tool.yaml b/tools/clock/tool.yaml
deleted file mode 100644
--- a/tools/clock/tool.yaml
+++ /dev/null
@@ -1,2 +0,0 @@
-schemaVersion: 1
-name: clock
diff --git a/AGENTS.md b/AGENTS.md
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -1,1 +1,1 @@
-old
+new
`;

describe("tool permissions", () => {
	it("reads what each tool in the diff may reach, and says a removed tool is gone", () => {
		expect(toolPermissionsFromDiff(WEATHER_TOOL_DIFF)).toEqual([
			{
				tool: "weather",
				removed: false,
				network: "allow",
				filesystem: "read-only",
				environment: ["WEATHER_API_KEY"],
				setup: null,
			},
			{ tool: "clock", removed: true, network: "deny", filesystem: "read-only", environment: [], setup: null },
		]);
		// A diff with no tool descriptor asks for no authority and prints nothing.
		expect(toolPermissionsFromDiff("diff --git a/AGENTS.md b/AGENTS.md\n+++ b/AGENTS.md\n+new\n")).toEqual([]);
		expect(renderToolPermissions([], plainPaint)).toEqual([]);
	});

	it("puts the block in the apply dialog, above the diff the operator confirms", () => {
		const lines = renderConfirmation(makeConfirmation("apply-proposal", {
			branch: "ahde/candidate-1",
			baseTargetSha: SHA_A,
			summary: "Add the weather tool",
			paths: ["tools/weather/tool.yaml"],
			risks: [],
			exactDiff: WEATHER_TOOL_DIFF,
		}), plainPaint).join("\n");
		expect(lines).toContain("Permissions");
		expect(lines).toContain("• weather network allow · filesystem read-only · env WEATHER_API_KEY");
		expect(lines).toContain("• clock removed by this change");
		// The machine-readable tokens are untouched; only the labels are language.
		try {
			setLanguage("ru");
			const ru = renderConfirmation(makeConfirmation("apply-proposal", {
				branch: "ahde/candidate-1",
				baseTargetSha: SHA_A,
				summary: "Add the weather tool",
				paths: ["tools/weather/tool.yaml"],
				risks: [],
				exactDiff: WEATHER_TOOL_DIFF,
			}), plainPaint).join("\n");
			expect(ru).toContain("Права");
			expect(ru).toContain("• weather сеть allow · файлы read-only · ключи WEATHER_API_KEY");
			expect(ru).toContain("• clock удаляется этой правкой");
		} finally {
			setLanguage(null);
		}
	});
});

describe("the workshop-close review", () => {
	const history = [
		{ tool: "weather", test: "sunny", passed: true, exitCode: 0, timedOut: false, truncated: false, durationMs: 12, failure: null, snapshotHash: `sha256:${"a".repeat(64)}`, at: "2026-01-01T00:00:00.000Z" },
		{ tool: "weather", test: "sunny", passed: true, exitCode: 0, timedOut: false, truncated: false, durationMs: 11, failure: null, snapshotHash: `sha256:${"b".repeat(64)}`, at: "2026-01-01T00:01:00.000Z" },
		{ tool: "weather", test: "unknown-city", passed: true, exitCode: 3, timedOut: false, truncated: false, durationMs: 9, failure: null, snapshotHash: `sha256:${"b".repeat(64)}`, at: "2026-01-01T00:02:00.000Z" },
	];
	const content = {
		kind: "proposal" as const,
		runId: "builder-run_1",
		proposalHash: HASH,
		baseTargetSha: SHA_A,
		summary: "Add the weather tool",
		paths: ["manifest.yaml", "tools/weather/tool.yaml"],
		risks: [],
		validationPlan: ["Run the basket"],
		prediction: null,
		authoringContext: null,
		evidenceBasis: null,
		exactDiff: WEATHER_TOOL_DIFF,
	};

	it("says what was created, what it may reach, how its fixtures went, and the two outcomes", () => {
		const lines = renderWorkshopCloseReview(content, history, plainPaint);
		const text = lines.join("\n");
		expect(text).toContain("Created / changed");
		expect(text).toContain("• tools/weather/tool.yaml");
		expect(text).toContain("Permissions");
		expect(text).toContain("Tool tests");
		expect(text).toContain("✓ weather 2/2 fixtures");
		// The whole diff, then the only two things that can happen next.
		expect(text).toContain("+name: weather");
		expect(text).toContain("Apply or discard");
		expect(text).toContain("Nothing changes until you apply.");
	});

	it("counts only the newest run, names the failing fixture, and bends into Russian", () => {
		const failed = [
			...history.slice(0, 2),
			{ ...history[2]!, passed: false, failure: "stdout JSON.city is missing" },
		];
		expect(fixtureLines(lastFixtureRunPerTool(failed), plainPaint)).toEqual([
			"  ✗ weather 1/2 — unknown-city: stdout JSON.city is missing",
		]);
		try {
			setLanguage("ru");
			expect(fixtureLines(lastFixtureRunPerTool(history), plainPaint)).toEqual([
				"  ✓ weather 2/2 фикстур",
			]);
			expect(renderWorkshopCloseReview(content, history, plainPaint).join("\n"))
				.toContain("Создано / изменено");
		} finally {
			setLanguage(null);
		}
	});
});

describe("the hand-off to the agent", () => {
	const applied = (verification: unknown): WorkbenchDecisionResult => ({
		kind: "apply-proposal",
		message: "applied",
		result: {
			runId: "builder-run_1",
			branch: "ahde/candidate-1",
			candidateSha: SHA_A,
			proposalHash: HASH,
			...(verification === undefined ? {} : { verification }),
		},
		view: makeView({ stage: "candidate-review" }),
	} as unknown as WorkbenchDecisionResult);

	it("offers the agent after a release and after the first apply that was actually checked", () => {
		expect(handoffLines(decision("ship", { candidate: {}, tag: "v0.2.0" } as never, "complete"), plainPaint))
			.toEqual(["", "Talk to the agent: ahde target (in a new terminal)"]);
		expect(handoffLines(applied({ outcome: "improved" }), plainPaint))
			.toEqual(["", "Talk to the agent: ahde target (in a new terminal)"]);
		try {
			setLanguage("ru");
			expect(handoffLines(applied({ outcome: "improved" }), plainPaint))
				.toEqual(["", "Поговорить с агентом: ahde target (в новом терминале)"]);
		} finally {
			setLanguage(null);
		}
	});

	it("stays quiet while there is nothing to talk to", () => {
		// Apply without an automatic check, and a check that never ran, promise nothing.
		expect(handoffLines(applied(undefined), plainPaint)).toEqual([]);
		expect(handoffLines(applied({ outcome: "blocked", reason: "no sealed holdout" }), plainPaint)).toEqual([]);
		// Neither does any other decision, nor a project without a ready agent.
		expect(handoffLines(decision("discard-proposal", { runId: "r", receiptHash: HASH }, "ready-to-evaluate"), plainPaint))
			.toEqual([]);
		const unready = {
			...applied({ outcome: "improved" }),
			view: makeView({ target: { status: "bootstrap-required", id: null, gitSha: null, model: null } }),
		} as WorkbenchDecisionResult;
		expect(handoffLines(unready, plainPaint)).toEqual([]);
	});
});
