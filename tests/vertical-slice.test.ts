import { execFileSync } from "node:child_process";
import { SEALED_VERIFICATION_REPETITIONS, sealedHoldoutTasks } from "./helpers/sealed-holdout.js";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	applyBuilderProposal,
	loadBuilderApplyReceipt,
	loadBuilderProposalRun,
	runApprovedSpecBuilderProposal,
	runBuilderProposal,
} from "../src/application/builder-proposal.js";
import { runAppliedBuilderCandidate } from "../src/application/builder-candidate.js";
import {
	loadCandidateRecord,
	promoteReviewedCandidate,
	reviewCandidate,
} from "../src/application/candidate-review.js";
import { createBuilderAuthoredProposalAdapter } from "../src/application/builder-authoring.js";
import { compileFailureBundle } from "../src/bundle.js";
import type { BuilderAdapter, CandidateProposal } from "../src/builders/adapters.js";
import { createCorpus } from "../src/corpus.js";
import { diagnoseEvalRun } from "../src/diagnosis.js";
import {
	compileImprovementBrief,
	deriveEvidenceLinkedProposalSelection,
	type EvidenceLinkedProposalDiagnosis,
} from "../src/application/improvement-brief.js";
import { candidateStatus } from "../src/domain/candidate.js";
import { EvalRunRecordSchema, runSuite } from "../src/eval.js";
import { loadTarget } from "../src/manifest.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import { buildEvalReport } from "../src/report.js";
import { saveSpecSnapshot } from "../src/spec.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";
import { hashValue } from "../src/provenance.js";

/**
 * Product acceptance slice with no paid model calls:
 *
 * baseline → diagnosis/bundle → typed Builder proposal → explicit human apply
 * → exact Candidate Experiment → external sealed holdout → human review
 * → tag the exact evaluated commit → inspectable report.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..");
function createMonotonicTestClock(startAt: string): {
	install: () => void;
	now: () => string;
	restore: () => void;
} {
	let currentMs = Date.parse(startAt);
	return {
		install() {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(currentMs);
		},
		now() {
			currentMs += 1;
			vi.setSystemTime(currentMs);
			return new Date(currentMs).toISOString();
		},
		restore() {
			vi.useRealTimers();
		},
	};
}

const CLOCK = createMonotonicTestClock("2026-01-01T00:00:00.000Z");
const OLD_INSTRUCTIONS = "# Demo agent\n\nReturn the word pending.\n";
const DEVELOPMENT = [
	{ id: "dev-1", input: "Answer case one.", graders: [{ type: "output_contains" as const, text: "READY" }] },
	{ id: "dev-2", input: "Answer case two.", graders: [{ type: "output_contains" as const, text: "READY" }] },
];
let root: string;
let targetDir: string;
let runsRoot: string;
let stateRoot: string;
let mock: MockModelHandle;

function git(args: string[]): string {
	return execFileSync("git", ["-C", targetDir, ...args], { encoding: "utf8" }).trim();
}

function sha256(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}


/**
 * The one production proposal adapter: Builder Pi authors the exact proposal and
 * the host records it. Every acceptance step below crosses the same trust seam
 * the product ships, not a bespoke fixture backend.
 */
function proposalAdapter(
	baseSha: string,
	evidence?: { diagnoses: EvidenceLinkedProposalDiagnosis[]; evidenceRefs: string[] },
): BuilderAdapter {
	const diagnoses = evidence?.diagnoses ?? [{
		failureIds: ["dev-1", "dev-2"],
		evidence: ["diagnosis:answer-quality"],
		rootCause: "The harness asks for the wrong final token.",
	}];
	const evidenceRefs = evidence?.evidenceRefs ?? ["diagnosis:answer-quality"];
	const proposal: CandidateProposal = {
		schemaVersion: 1,
		prediction: null,
		decision: "propose",
		baseTargetSha: baseSha,
		summary: "Make the answer contract explicit.",
		diagnoses,
		changes: [{
			path: "AGENTS.md",
			baseSha256: sha256(OLD_INSTRUCTIONS),
			unifiedDiff: [
				"diff --git a/AGENTS.md b/AGENTS.md",
				"--- a/AGENTS.md",
				"+++ b/AGENTS.md",
				"@@ -1,3 +1,3 @@",
				" # Demo agent",
				" ",
				"-Return the word pending.",
				"+Return the exact uppercase word READY.",
			].join("\n"),
			rationale: "Align the harness with the reviewed answer contract.",
			evidenceRefs,
		}],
		risks: ["The contract is intentionally narrow for this fixture."],
		validationPlan: ["Run the matched development and sealed corpora."],
	};
	return createBuilderAuthoredProposalAdapter(proposal, { now: CLOCK.now });
}

beforeAll(async () => {
	CLOCK.install();
	mock = await startMockModel([
		{
			match: ({ system }) => system.includes("Return the exact uppercase word READY."),
			steps: [{ text: "READY" }],
		},
		{ match: () => true, steps: [{ text: "pending" }] },
	]);
	root = mkdtempSync(join(tmpdir(), "ahde-acceptance-"));
	targetDir = join(root, "target");
	runsRoot = join(root, "runs");
	stateRoot = join(root, "state");
	cpSync(join(REPO_ROOT, "templates", "basic-agent"), targetDir, { recursive: true });
	writeFileSync(join(targetDir, "AGENTS.md"), OLD_INSTRUCTIONS);
	writeFileSync(
		join(targetDir, "evals", "development.jsonl"),
		`${DEVELOPMENT.map((task) => JSON.stringify(task)).join("\n")}\n`,
	);
	const manifestPath = join(targetDir, "manifest.yaml");
	writeFileSync(
		manifestPath,
		readFileSync(manifestPath, "utf8")
			.replace("baseUrl: http://127.0.0.1:1234/v1", `baseUrl: ${mock.url}`)
			.replace("apiKeyEnv: AHDE_MODEL_API_KEY", "apiKeyEnv: AHDE_ACCEPTANCE_KEY"),
	);
	git(["init", "-b", "main"]);
	git(["config", "user.name", "AHDE fixture"]);
	git(["config", "user.email", "fixture@ahde.local"]);
	git(["add", "."]);
	git(["commit", "-m", "baseline"]);
	process.env.AHDE_ACCEPTANCE_KEY = "fixture";
});

afterAll(async () => {
	delete process.env.AHDE_ACCEPTANCE_KEY;
	await mock.close();
	rmSync(root, { recursive: true, force: true });
	CLOCK.restore();
});

describe("vertical slice: evidence-backed improvement", () => {
	it("keeps the checkout intact and promotes only the exact reviewed holdout-tested candidate", async () => {
		const spec = saveSpecSnapshot({
			stateRoot,
			projectId: "acceptance-project",
			status: "approved",
			spec: {
				schemaVersion: 1,
				title: "Demo answer agent",
				purpose: "Return a deterministic reviewed answer.",
				users: ["acceptance reviewer"],
				jobs: ["answer the fixture request"],
				inputs: ["one text request"],
				allowedActions: ["return text"],
				successCriteria: ["answer contains READY"],
				constraints: ["no network"],
				openQuestions: [],
			},
		});
		const baseSha = git(["rev-parse", "HEAD"]);
		const baseline = await runSuite(loadTarget(targetDir), {
			runsRoot,
			label: "baseline",
			repetitions: SEALED_VERIFICATION_REPETITIONS,
		});
		expect(baseline.summary).toMatchObject({ pass: 0, fail: 2 * SEALED_VERIFICATION_REPETITIONS, error: 0 });
		const diagnosis = diagnoseEvalRun(runsRoot, baseline.evalRunId);
		expect(diagnosis.summary.failedTasks).toBe(2);
		const brief = compileImprovementBrief(runsRoot, diagnosis);
		const failureMode = brief.modes.find((mode) => mode.decision === "propose-harness-change");
		if (!failureMode) throw new Error("acceptance fixture has no proposal-eligible failure mode");
		const proposalBasis = {
			algorithmId: brief.algorithmId,
			evalRunId: brief.evalRunId,
			diagnosisId: brief.diagnosisId,
			briefId: brief.briefId,
			failureModeIds: [failureMode.failureModeId],
		};
		const selected = deriveEvidenceLinkedProposalSelection(brief, proposalBasis);
		const selectedEvidence = {
			diagnoses: selected.diagnoses,
			evidenceRefs: [...new Set(selected.diagnoses.flatMap((item) => item.evidence))],
		};
		const bundlePath = compileFailureBundle(loadTarget(targetDir), baseline, runsRoot);
		expect(readFileSync(bundlePath, "utf8")).not.toContain(targetDir);

		writeFileSync(join(targetDir, "user-note.txt"), "uncommitted user work\n");
		const checkoutBefore = {
			head: git(["rev-parse", "HEAD"]),
			branch: git(["branch", "--show-current"]),
			status: git(["status", "--porcelain=v1", "-uall"]),
		};
		const baselineIndexPath = join(runsRoot, baseline.evalRunId, "eval_run.json");
		writeJsonArtifact(baselineIndexPath, EvalRunRecordSchema, {
			...baseline,
			runArtifacts: undefined,
		});
		try {
			await expect(runApprovedSpecBuilderProposal({
				adapter: proposalAdapter(baseSha),
				targetDir,
				allowedPaths: ["AGENTS.md", "skills/**", "bin/**", "tools/**"],
				approvedSpec: { stateRoot, projectId: "acceptance-project", specId: spec.id },
				sourceEvalRunId: baseline.evalRunId,
				proposalBasis,
				runsRoot,
				timeoutMs: 5_000,
				runId: "builder-legacy-source",
			})).rejects.toThrow(/must hash-anchor every member run/);
		} finally {
			writeJsonArtifact(baselineIndexPath, EvalRunRecordSchema, baseline);
		}
		const unverified = await runBuilderProposal({
			adapter: proposalAdapter(baseSha),
			baseTargetSha: baseSha,
			allowedPaths: ["AGENTS.md", "skills/**", "bin/**", "tools/**"],
			approvedSpec: { stateRoot, projectId: "acceptance-project", specId: spec.id },
			failureBundle: readFileSync(bundlePath, "utf8"),
			evidence: { evalRunId: baseline.evalRunId, diagnosisId: diagnosis.diagnosisId },
			runsRoot,
			timeoutMs: 5_000,
			runId: "builder-unverified",
		});
		applyBuilderProposal({
			repoDir: targetDir,
			runsRoot,
			runId: unverified.record.runId,
			requestedBranch: "candidate/unverified",
			actor: { kind: "human", id: "fixture-reviewer" },
			reason: "Exercise the non-promotable low-level boundary.",
		}, { now: CLOCK.now });
		await expect(runAppliedBuilderCandidate({
			repositoryDir: targetDir,
			runsRoot,
			builderRunId: unverified.record.runId,
			repetitions: 1,
			projectId: "acceptance-project",
			approvedSpec: { stateRoot, specId: spec.id },
			actorId: "fixture-reviewer",
		})).rejects.toThrow(/requires a canonical Builder run/);

		await expect(runApprovedSpecBuilderProposal({
			adapter: proposalAdapter(baseSha),
			targetDir,
			allowedPaths: ["AGENTS.md", "skills/**", "bin/**", "tools/**"],
			approvedSpec: { stateRoot, projectId: "acceptance-project", specId: spec.id },
			sourceEvalRunId: baseline.evalRunId,
			runsRoot,
			timeoutMs: 5_000,
			runId: "builder-missing-proposal-basis",
		})).rejects.toThrow(/requires an exact improvement-brief and failure-mode selection/);
		await expect(runApprovedSpecBuilderProposal({
			adapter: proposalAdapter(baseSha),
			targetDir,
			allowedPaths: ["AGENTS.md", "skills/**", "bin/**", "tools/**"],
			approvedSpec: { stateRoot, projectId: "acceptance-project", specId: spec.id },
			sourceEvalRunId: baseline.evalRunId,
			proposalBasis,
			runsRoot,
			timeoutMs: 5_000,
			runId: "builder-forged-proposal-evidence",
		})).rejects.toThrow(/proposal diagnoses do not match the host-derived failure-mode evidence/);

		const builder = await runApprovedSpecBuilderProposal({
			adapter: proposalAdapter(baseSha, selectedEvidence),
			targetDir,
			allowedPaths: ["AGENTS.md", "skills/**", "bin/**", "tools/**"],
			approvedSpec: { stateRoot, projectId: "acceptance-project", specId: spec.id },
			sourceEvalRunId: baseline.evalRunId,
			proposalBasis,
			runsRoot,
			timeoutMs: 5_000,
			runId: "builder-acceptance",
		});
		expect(readFileSync(join(targetDir, "AGENTS.md"), "utf8")).toBe(OLD_INSTRUCTIONS);

		const applied = applyBuilderProposal({
			repoDir: targetDir,
			runsRoot,
			runId: builder.record.runId,
			requestedBranch: "candidate/acceptance",
			actor: { kind: "human", id: "fixture-reviewer" },
			reason: "The proposal matches the diagnosed failure and allowed scope.",
		}, { now: CLOCK.now });
		const exactBuilderRunHash = hashValue(loadBuilderProposalRun(runsRoot, builder.record.runId));
		const exactApplyReceiptHash = hashValue(loadBuilderApplyReceipt(runsRoot, builder.record.runId));
		expect(git(["show", `${applied.receipt.candidateSha}:AGENTS.md`])).toContain("uppercase word READY");
		expect({
			head: git(["rev-parse", "HEAD"]),
			branch: git(["branch", "--show-current"]),
			status: git(["status", "--porcelain=v1", "-uall"]),
		}).toEqual(checkoutBefore);
		await expect(runAppliedBuilderCandidate({
			repositoryDir: targetDir,
			runsRoot,
			builderRunId: builder.record.runId,
			repetitions: 1,
			projectId: "acceptance-project",
			approvedSpec: { stateRoot, specId: spec.id },
			actorId: "not-the-applying-human",
		})).rejects.toThrow(/does not match apply-receipt human fixture-reviewer/);
		const modelRequestsBeforeStaleConfirmation = mock.requests();
		await expect(runAppliedBuilderCandidate({
			repositoryDir: targetDir,
			runsRoot,
			builderRunId: builder.record.runId,
			expectedBuilderRunHash: `sha256:${"0".repeat(64)}`,
			expectedApplyReceiptHash: exactApplyReceiptHash,
			repetitions: 1,
			candidateId: "candidate-stale-builder-confirmation",
			projectId: "acceptance-project",
			approvedSpec: { stateRoot, specId: spec.id },
		})).rejects.toThrow(/Builder proposal changed after confirmation/);
		expect(existsSync(join(runsRoot, "candidates", "candidate-stale-builder-confirmation", "candidate.json"))).toBe(false);
		await expect(runAppliedBuilderCandidate({
			repositoryDir: targetDir,
			runsRoot,
			builderRunId: builder.record.runId,
			expectedBuilderRunHash: exactBuilderRunHash,
			expectedApplyReceiptHash: `sha256:${"0".repeat(64)}`,
			repetitions: 1,
			candidateId: "candidate-stale-receipt-confirmation",
			projectId: "acceptance-project",
			approvedSpec: { stateRoot, specId: spec.id },
		})).rejects.toThrow(/Builder apply receipt changed after confirmation/);
		expect(existsSync(join(runsRoot, "candidates", "candidate-stale-receipt-confirmation", "candidate.json"))).toBe(false);
		expect(mock.requests()).toBe(modelRequestsBeforeStaleConfirmation);

		const holdout = createCorpus({
			stateRoot,
			projectId: "acceptance-project",
			name: "Promotion gate",
			visibility: "sealed",
			tasks: sealedHoldoutTasks("PRIVATE HOLDOUT INPUT"),
		});
		const experiment = await runAppliedBuilderCandidate({
			repositoryDir: targetDir,
			runsRoot,
			builderRunId: builder.record.runId,
			expectedBuilderRunHash: exactBuilderRunHash,
			expectedApplyReceiptHash: exactApplyReceiptHash,
			repetitions: SEALED_VERIFICATION_REPETITIONS,
			candidateId: "candidate-acceptance",
			projectId: "acceptance-project",
			approvedSpec: { stateRoot, specId: spec.id },
			actorId: "fixture-reviewer",
			sealedCorpus: { stateRoot, projectId: "acceptance-project", corpusId: holdout.id },
		});
		expect(experiment.baseline.evalRunId).toBe(baseline.evalRunId);
		expect(experiment.baselineReused).toBe(true);
		expect(experiment.candidate.summary).toMatchObject({ pass: 2 * SEALED_VERIFICATION_REPETITIONS, fail: 0, error: 0 });
		expect(experiment.sealedHoldout?.candidate.summary).toMatchObject({ pass: 15 * SEALED_VERIFICATION_REPETITIONS, fail: 0, error: 0 });
		expect(experiment.compare.summary.delta).toBe(1);
		expect(experiment.compare.gate.verdict).toBe("improved");
		expect(experiment.sealedHoldout?.compare.gate.verdict).toBe("pass");
		expect(candidateStatus(experiment.record)).toBe("evaluated");
		expect(experiment.record.specId).toBe(spec.id);
		expect(readFileSync(experiment.candidateRecordPath, "utf8")).not.toContain("PRIVATE HOLDOUT INPUT");

		diagnoseEvalRun(runsRoot, experiment.candidate.evalRunId);
		const reportPath = buildEvalReport(runsRoot, experiment.candidate.evalRunId).path;
		expect(readFileSync(reportPath, "utf8")).toContain("Trace inspector");
		reviewCandidate({
			runsRoot,
			candidateId: experiment.record.candidateId,
			recommendation: "promote",
			reason: "Development improved and sealed holdout has no regression.",
			actorId: "fixture-reviewer",
			now: CLOCK.now,
		});
		const promoted = promoteReviewedCandidate({
			repositoryDir: targetDir,
			runsRoot,
			candidateId: experiment.record.candidateId,
			version: "0.2.0",
			reason: "Human approved the exact evidence-backed revision.",
			actorId: "fixture-reviewer",
			now: CLOCK.now,
		});
		expect(promoted.candidateSha).toBe(applied.receipt.candidateSha);
		expect(git(["rev-list", "-n", "1", "v0.2.0"])).toBe(applied.receipt.candidateSha);
		expect(candidateStatus(loadCandidateRecord(runsRoot, experiment.record.candidateId))).toBe("promoted");
		expect({
			head: git(["rev-parse", "HEAD"]),
			branch: git(["branch", "--show-current"]),
			status: git(["status", "--porcelain=v1", "-uall"]),
		}).toEqual(checkoutBefore);
	}, 120_000);
});
