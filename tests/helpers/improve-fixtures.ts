import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { vi, type Mock } from "vitest";
import { recordBuilderAuthoredProposal } from "../../src/application/builder-authoring.js";
import { CANDIDATE_SCOPE_POLICY } from "../../src/application/candidate-experiment.js";
import { compileHarnessAuthoringProposal } from "../../src/application/harness-authoring.js";
import {
	compileImprovementBrief,
	deriveEvidenceLinkedProposalSelection,
} from "../../src/application/improvement-brief.js";
import { createCorpus } from "../../src/corpus.js";
import { diagnoseEvalRun } from "../../src/diagnosis.js";
import { startMockModel, type MockModelHandle } from "../../src/mock-model.js";
import {
	createAhdeWorkbench,
	type AhdeWorkbench,
	type AhdeWorkbenchDependencies,
	type WorkbenchHumanGate,
} from "../../src/workbench/index.js";
import { SEALED_VERIFICATION_REPETITIONS, sealedHoldoutTasks } from "./sealed-holdout.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

export const IMPROVE_PROJECT_ID = "improve-fixture";
export const IMPROVE_ACTOR_ID = "local:improve-human";
export const IMPROVE_CREDENTIAL_ENV = "AHDE_IMPROVE_FIXTURE_KEY";
/** The instruction that makes the scripted Target answer correctly. */
export const READY_INSTRUCTION = "Return the exact uppercase word READY.";
/** An instruction that is a real diff and changes nothing the graders see. */
export const NO_OP_INSTRUCTION = "Answer politely and say pending.";
export const BASELINE_INSTRUCTION = "Return the word pending.";
export const SEALED_INPUT = "PRIVATE IMPROVE FIXTURE HOLDOUT";

/** Two development cases that fail on the baseline and pass once READY is asked for. */
export const DEVELOPMENT_CASES = [
	{ input: "Answer the first reviewed request.", graders: [{ type: "output_contains" as const, text: "READY" }] },
	{ input: "Answer the second reviewed request.", graders: [{ type: "output_contains" as const, text: "READY" }] },
];

export interface RecordingGate extends WorkbenchHumanGate {
	confirm: Mock<WorkbenchHumanGate["confirm"]>;
	selectSealed: Mock<WorkbenchHumanGate["selectSealed"]>;
}

export function approvingGate(): RecordingGate {
	return {
		confirm: vi.fn<WorkbenchHumanGate["confirm"]>(async () => ({ approved: true, actorId: IMPROVE_ACTOR_ID })),
		selectSealed: vi.fn<WorkbenchHumanGate["selectSealed"]>(async () => ({
			approved: true,
			actorId: IMPROVE_ACTOR_ID,
			selectedIndex: 0,
		})),
	};
}

export function git(dir: string, ...args: string[]): string {
	return execFileSync("git", [
		"-C", dir,
		"-c", "user.name=AHDE Improve Fixture",
		"-c", "user.email=improve@ahde.local",
		...args,
	], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
}

export interface ImproveFixture {
	projectDir: string;
	stateRoot: string;
	runsRoot: string;
	projectId: string;
	workbench: AhdeWorkbench;
	mock: MockModelHandle;
	baselineSha: string;
	branch: string;
	approvedSpecId: string;
	corpusId: string;
	sealedCorpusId: string;
	/** The development EvalRun the Workbench's `run-eval` produced. */
	evalRunId: string;
	close: () => Promise<void>;
}

/**
 * A scripted Target whose behaviour depends only on its instructions, so a
 * harness diff is the only thing that can move a score.
 */
export async function startImproveMockModel(): Promise<MockModelHandle> {
	return startMockModel([
		{ match: ({ system }) => system.includes(READY_INSTRUCTION), steps: [{ text: "READY" }] },
		{ match: () => true, steps: [{ text: "pending" }] },
	]);
}

/**
 * A real Target repository, a real Workbench, an approved Spec, a published
 * development basket, one real development EvalRun, and an evaluator-owned
 * sealed holdout — everything a verification or an improvement cycle needs,
 * and nothing fabricated except the clock.
 */
export async function improveFixture(
	dependencies: Partial<AhdeWorkbenchDependencies> = {},
	options: { repetitions?: number } = {},
): Promise<ImproveFixture> {
	const mock = await startImproveMockModel();
	const root = mkdtempSync(join(tmpdir(), "ahde-improve-"));
	const projectDir = realpathSync(root);
	const stateRoot = join(projectDir, ".ahde");
	const runsRoot = join(projectDir, "runs");
	cpSync(join(REPO_ROOT, "templates", "basic-agent"), projectDir, { recursive: true });
	writeFileSync(join(projectDir, "AGENTS.md"), `# Improve fixture\n\n${BASELINE_INSTRUCTION}\n`);
	writeFileSync(join(projectDir, ".gitignore"), ".ahde/\nruns/\nimports/\n");
	const manifestPath = join(projectDir, "manifest.yaml");
	writeFileSync(
		manifestPath,
		readFileSync(manifestPath, "utf8")
			.replace("id: my-agent", `id: ${IMPROVE_PROJECT_ID}`)
			.replace("id: replace-with-model-id", "id: improve-fixture-model")
			.replace("baseUrl: http://127.0.0.1:1234/v1", `baseUrl: ${mock.url}`)
			.replace("apiKeyEnv: AHDE_MODEL_API_KEY", `apiKeyEnv: ${IMPROVE_CREDENTIAL_ENV}`),
	);
	process.env[IMPROVE_CREDENTIAL_ENV] = "improve-fixture";
	git(projectDir, "init", "-q", "-b", "main");
	git(projectDir, "add", ".");
	git(projectDir, "commit", "-qm", "improve fixture baseline");
	const branch = git(projectDir, "symbolic-ref", "--short", "HEAD");
	const baselineSha = git(projectDir, "rev-parse", "HEAD");

	const workbench = createAhdeWorkbench({
		projectDir,
		stateRoot,
		runsRoot,
		projectId: IMPROVE_PROJECT_ID,
		dependencies,
	});
	const gate = approvingGate();
	await workbench.submit({
		kind: "spec-draft",
		spec: {
			schemaVersion: 1,
			title: "Improve fixture agent",
			purpose: "Return the reviewed deterministic answer.",
			users: ["fixture reviewer"],
			jobs: ["answer one reviewed request"],
			inputs: ["one text request"],
			allowedActions: ["return text"],
			successCriteria: ["answer contains READY"],
			constraints: ["no network"],
			openQuestions: [],
		},
	});
	const approved = await workbench.decide({ kind: "approve-spec", reason: "Approve the fixture Spec" }, gate);
	await workbench.submit({
		kind: "corpus-draft",
		name: "Improve fixture development basket",
		tasks: DEVELOPMENT_CASES,
		coverageNotes: ["Both cases expose the same missing instruction."],
		revisionSummary: "Initial development basket",
	});
	const published = await workbench.decide({ kind: "publish-corpus", reason: "Publish the fixture basket" }, gate);
	const evaluated = await workbench.decide({
		kind: "run-eval",
		repetitions: options.repetitions ?? SEALED_VERIFICATION_REPETITIONS,
		reason: "Measure the fixture baseline",
	}, gate);
	const sealed = createCorpus({
		stateRoot,
		projectId: IMPROVE_PROJECT_ID,
		name: "Evaluator-only improve holdout",
		visibility: "sealed",
		tasks: sealedHoldoutTasks(SEALED_INPUT),
	});

	return {
		projectDir,
		stateRoot,
		runsRoot,
		projectId: IMPROVE_PROJECT_ID,
		workbench,
		mock,
		baselineSha,
		branch,
		approvedSpecId: approved.result.approvedSpecId,
		corpusId: published.result.corpusId,
		sealedCorpusId: sealed.id,
		evalRunId: evaluated.result.evaluation.evalRunId,
		async close() {
			await mock.close();
			delete process.env[IMPROVE_CREDENTIAL_ENV];
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/**
 * Author one proposal through the canonical chain — diagnosis, brief, the
 * host-derived failure-mode selection — so the recorded run carries the exact
 * source eval a cheap check and an autoloop cycle read.
 */
export async function recordFixtureProposal(
	fixture: Pick<ImproveFixture, "projectDir" | "stateRoot" | "runsRoot" | "approvedSpecId" | "evalRunId">,
	instruction: string,
): Promise<{ runId: string; failureModeId: string }> {
	const diagnosis = diagnoseEvalRun(fixture.runsRoot, fixture.evalRunId);
	const brief = compileImprovementBrief(fixture.runsRoot, diagnosis);
	const mode = brief.modes.find((candidate) => candidate.decision === "propose-harness-change");
	if (!mode) throw new Error("improve fixture produced no proposal-eligible failure mode");
	const proposalBasis = {
		algorithmId: brief.algorithmId,
		evalRunId: brief.evalRunId,
		diagnosisId: brief.diagnosisId,
		briefId: brief.briefId,
		failureModeIds: [mode.failureModeId],
	};
	const selected = deriveEvidenceLinkedProposalSelection(brief, proposalBasis);
	const proposal = compileHarnessAuthoringProposal({
		repositoryDir: fixture.projectDir,
		intents: [{ type: "instructions.replace", content: `# Improve fixture\n\n${instruction}\n` }],
		summary: "Make the answer contract explicit.",
		diagnoses: selected.diagnoses,
		risks: ["Instruction-only behaviour change"],
		validationPlan: ["Re-run the reviewed development basket"],
	});
	const recorded = await recordBuilderAuthoredProposal({
		proposal,
		targetDir: fixture.projectDir,
		allowedPaths: [...CANDIDATE_SCOPE_POLICY.allowed],
		approvedSpec: { stateRoot: fixture.stateRoot, projectId: IMPROVE_PROJECT_ID, specId: fixture.approvedSpecId },
		runsRoot: fixture.runsRoot,
		timeoutMs: 30_000,
		sourceEvalRunId: fixture.evalRunId,
		proposalBasis,
	});
	if (recorded.record.result.proposal?.decision !== "propose") {
		throw new Error("improve fixture proposal carries no change");
	}
	return { runId: recorded.record.runId, failureModeId: mode.failureModeId };
}
