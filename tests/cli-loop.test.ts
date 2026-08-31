import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { proposeBranchChange } from "../src/application/branch-proposal.js";
import { applyBuilderProposal } from "../src/application/builder-proposal.js";
import { runAppliedBuilderCandidate } from "../src/application/builder-candidate.js";
import { renderCandidateVerdictLines } from "../src/application/candidate-verdict.js";
import {
	loadCandidateRecord,
	promoteReviewedCandidate,
	reviewCandidate,
} from "../src/application/candidate-review.js";
import { runCheapCheckForBuilderRun } from "../src/application/cheap-check.js";
import { approveSpecDocument, parseSpecDocument } from "../src/application/spec-document.js";
import {
	adoptTargetCandidate,
	describeTargetAdoption,
} from "../src/application/target-adoption.js";
import { createCorpus } from "../src/corpus.js";
import { candidateStatus } from "../src/domain/candidate.js";
import { diagnoseEvalRun } from "../src/diagnosis.js";
import { compileImprovementBrief } from "../src/application/improvement-brief.js";
import { runSuite } from "../src/eval.js";
import { loadTarget } from "../src/manifest.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import { loadSpecSnapshot } from "../src/spec.js";
import { SEALED_VERIFICATION_REPETITIONS, sealedHoldoutTasks } from "./helpers/sealed-holdout.js";

/**
 * The loop the SKILL prescribes, driven the way the CLI drives it:
 *
 *   spec approve → propose → apply → check --builder-run → candidate
 *   → review → promote → adopt
 *
 * Every step below is exactly the application call one `ahde` command makes;
 * the CLI adds argv parsing and printing and nothing else. What this test is
 * really asserting is that the four seams that used to need a script — the
 * typed approved Spec, a branch compiled into a proposal, its apply receipt,
 * and the screen before the verification — now close without one, and that the
 * operator's checkout never moves until they say `adopt`.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..");

const OLD_INSTRUCTIONS = "# Returns agent\n\nAnswer in English. The returns window is 14 days.\n";
const NEW_INSTRUCTIONS = [
	"# Returns agent",
	"",
	"Answer in Russian. Say: возврат в течение 30 дней с даты доставки.",
	"Marker: AHDE-RETURNS-POLICY-V2",
	"",
].join("\n");

const DEVELOPMENT = [
	{ id: "dev-1", input: "Сколько дней на возврат?", graders: [{ type: "output_contains" as const, text: "30 дней" }] },
	{ id: "dev-2", input: "Как оформить возврат?", graders: [{ type: "output_contains" as const, text: "30 дней" }] },
];

const SPEC_DOCUMENT = [
	"# Агент поддержки по возвратам",
	"",
	"Отвечать покупателям про сроки и порядок возврата, по-русски.",
	"",
	"## Users",
	"- покупатель интернет-магазина",
	"",
	"## Jobs",
	"- ответить на вопрос о возврате",
	"",
	"## Inputs",
	"- сообщение покупателя на русском",
	"",
	"## Allowed actions",
	"- ответить текстом",
	"",
	"## Success criteria",
	"- ответ по-русски",
	"- срок 30 дней с даты доставки",
	"",
	"## Constraints",
	"- без инструментов",
	"",
	"## Notes for the operator",
	"Anything here is for the human and is never read into the Spec.",
	"",
].join("\n");

const PROJECT_ID = "returns-agent";

function createMonotonicTestClock(startAt: string): { install: () => void; now: () => string; restore: () => void } {
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

const CLOCK = createMonotonicTestClock("2026-02-01T00:00:00.000Z");

let root: string;
let targetDir: string;
let runsRoot: string;
let stateRoot: string;
let mock: MockModelHandle;

function git(...args: string[]): string {
	return execFileSync("git", ["-C", targetDir, ...args], { encoding: "utf8" }).trim();
}

function checkout(): { head: string; branch: string; status: string } {
	return {
		head: git("rev-parse", "HEAD"),
		branch: git("branch", "--show-current"),
		status: git("status", "--porcelain=v1", "-uall"),
	};
}

/** Author a harness change the way an operator does: on a branch, then back. */
function commitOnBranch(branch: string, path: string, content: string): void {
	const start = git("branch", "--show-current");
	git("checkout", "-q", "-b", branch);
	writeFileSync(join(targetDir, path), content);
	git("commit", "-q", "-am", `author ${path} on ${branch}`);
	git("checkout", "-q", start);
}

beforeAll(async () => {
	CLOCK.install();
	mock = await startMockModel([
		{
			match: ({ system }) => system.includes("AHDE-RETURNS-POLICY-V2"),
			steps: [{ text: "Возврат оформляется в течение 30 дней с даты доставки." }],
		},
		{ match: () => true, steps: [{ text: "Our returns window is 14 days from purchase." }] },
	]);
	root = mkdtempSync(join(tmpdir(), "ahde-cli-loop-"));
	targetDir = join(root, "target");
	runsRoot = join(root, "runs");
	stateRoot = join(root, "state");
	cpSync(join(REPO_ROOT, "templates", "basic-agent"), targetDir, { recursive: true });
	writeFileSync(join(targetDir, "AGENTS.md"), OLD_INSTRUCTIONS);
	writeFileSync(join(targetDir, "spec.md"), SPEC_DOCUMENT);
	writeFileSync(
		join(targetDir, "evals", "development.jsonl"),
		`${DEVELOPMENT.map((task) => JSON.stringify(task)).join("\n")}\n`,
	);
	const manifestPath = join(targetDir, "manifest.yaml");
	writeFileSync(
		manifestPath,
		readFileSync(manifestPath, "utf8")
			.replace("baseUrl: http://127.0.0.1:1234/v1", `baseUrl: ${mock.url}`)
			.replace("apiKeyEnv: AHDE_MODEL_API_KEY", "apiKeyEnv: AHDE_CLI_LOOP_KEY")
			.replace(/^id: .*$/mu, `id: ${PROJECT_ID}`),
	);
	git("init", "-b", "main");
	git("config", "user.name", "AHDE fixture");
	git("config", "user.email", "fixture@ahde.local");
	git("add", ".");
	git("commit", "-q", "-m", "configure the returns agent");
	process.env.AHDE_CLI_LOOP_KEY = "fixture";
});

afterAll(async () => {
	delete process.env.AHDE_CLI_LOOP_KEY;
	await mock.close();
	rmSync(root, { recursive: true, force: true });
	CLOCK.restore();
});

describe("ahde spec approve", () => {
	it("reads headings and bullets and leaves anything it does not recognize to the human", () => {
		const parsed = parseSpecDocument(SPEC_DOCUMENT);
		expect(parsed.spec.title).toBe("Агент поддержки по возвратам");
		expect(parsed.spec.purpose).toContain("сроки и порядок возврата");
		expect(parsed.spec.successCriteria).toEqual(["ответ по-русски", "срок 30 дней с даты доставки"]);
		expect(parsed.spec.users).toEqual(["покупатель интернет-магазина"]);
		expect(parsed.spec.openQuestions).toEqual([]);
		expect(parsed.ignoredHeadings).toEqual(["Notes for the operator"]);
	});

	it("refuses a document that names nothing the Spec needs", () => {
		expect(() => parseSpecDocument("just some prose\n")).toThrow(/has no title/);
		expect(() => parseSpecDocument("# Title only\n")).toThrow(/has no purpose/);
		expect(() => parseSpecDocument("# T\n\np\n\n## Users\n- x\n", { title: "  " }))
			.toThrow(/has no title/);
	});
});

describe("the improvement loop, closed with CLI-shaped calls only", () => {
	it("approves a Spec, proposes a branch, applies it, screens it, verifies it, ships it, adopts it", async () => {
		// --- ahde spec approve --------------------------------------------------
		const approval = approveSpecDocument({
			stateRoot,
			projectId: PROJECT_ID,
			documentPath: join(targetDir, "spec.md"),
			now: CLOCK.now,
		});
		expect(approval.disposition).toBe("approved");
		expect(approval.specId).toMatch(/^spec-[0-9a-f]{64}$/);
		expect(loadSpecSnapshot(stateRoot, PROJECT_ID, approval.specId).status).toBe("approved");
		// Running it again on unchanged text is a no-op that names the same Spec.
		const replay = approveSpecDocument({
			stateRoot,
			projectId: PROJECT_ID,
			documentPath: join(targetDir, "spec.md"),
			now: CLOCK.now,
		});
		expect(replay).toMatchObject({ specId: approval.specId, disposition: "already-approved" });

		// --- ahde run --label baseline -----------------------------------------
		const baseline = await runSuite(loadTarget(targetDir), {
			runsRoot,
			label: "baseline",
			repetitions: SEALED_VERIFICATION_REPETITIONS,
		});
		expect(baseline.summary).toMatchObject({ pass: 0, error: 0 });

		// --- ahde diagnose ------------------------------------------------------
		const brief = compileImprovementBrief(runsRoot, diagnoseEvalRun(runsRoot, baseline.evalRunId));
		const failureMode = brief.modes.find((mode) => mode.decision === "propose-harness-change");
		if (!failureMode) throw new Error("fixture baseline produced no proposable failure mode");

		// The operator authors the fix on a branch and goes back to their own.
		commitOnBranch("work/returns-policy", "AGENTS.md", NEW_INSTRUCTIONS);
		const checkoutBefore = checkout();
		expect(checkoutBefore.branch).toBe("main");
		expect(readFileSync(join(targetDir, "AGENTS.md"), "utf8")).toBe(OLD_INSTRUCTIONS);

		// --- ahde propose -------------------------------------------------------
		const proposed = await proposeBranchChange({
			targetDir,
			runsRoot,
			stateRoot,
			projectId: PROJECT_ID,
			specId: approval.specId,
			branch: "work/returns-policy",
			summary: "Answer in Russian with the 30-day window measured from delivery.",
			sourceEvalRunId: baseline.evalRunId,
			failureModeIds: [failureMode.failureModeId],
			runId: "builder-returns-1",
			now: CLOCK.now,
		});
		expect(proposed.builderRunId).toBe("builder-returns-1");
		expect(proposed.changedPaths).toEqual(["AGENTS.md"]);
		expect(proposed.baseTargetSha).toBe(checkoutBefore.head);
		expect(proposed.sourceEvalRunId).toBe(baseline.evalRunId);
		// propose alone leaves nothing applied: no branch moved, no checkout moved.
		expect(checkout()).toEqual(checkoutBefore);
		expect(git("branch", "--list", "candidate/builder-returns-1")).toBe("");

		// --- ahde apply ---------------------------------------------------------
		const applied = applyBuilderProposal({
			repoDir: targetDir,
			runsRoot,
			runId: proposed.builderRunId,
			requestedBranch: `candidate/${proposed.builderRunId}`,
			actor: { kind: "human", id: "local-user" },
			reason: "Applied at the terminal by the operator running `ahde apply`.",
		}, { now: CLOCK.now });
		expect(applied.receipt.branch).toBe("candidate/builder-returns-1");
		expect(applied.receipt.baseTargetSha).toBe(checkoutBefore.head);
		expect(applied.receipt.paths).toEqual(["AGENTS.md"]);
		expect(applied.receipt.proposalSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(git("show", `${applied.receipt.candidateSha}:AGENTS.md`)).toContain("AHDE-RETURNS-POLICY-V2");
		expect(checkout()).toEqual(checkoutBefore);

		// --- ahde check --builder-run (the screen, before any candidate exists) --
		const screen = await runCheapCheckForBuilderRun({
			repositoryDir: targetDir,
			runsRoot,
			stateRoot,
			builderRunId: proposed.builderRunId,
			now: CLOCK.now,
		});
		expect(screen.verdict).toBe("promising");
		expect(screen.improved).toBe(DEVELOPMENT.length);
		expect(screen.tasks).toHaveLength(DEVELOPMENT.length);
		expect(checkout()).toEqual(checkoutBefore);

		// --- ahde candidate -----------------------------------------------------
		const holdout = createCorpus({
			stateRoot,
			projectId: PROJECT_ID,
			name: "Возвраты — sealed exam",
			visibility: "sealed",
			tasks: sealedHoldoutTasks("PRIVATE HOLDOUT INPUT", "30 дней"),
		});
		const experiment = await runAppliedBuilderCandidate({
			repositoryDir: targetDir,
			runsRoot,
			builderRunId: proposed.builderRunId,
			repetitions: SEALED_VERIFICATION_REPETITIONS,
			candidateId: "candidate-returns-1",
			projectId: PROJECT_ID,
			approvedSpec: { stateRoot, specId: approval.specId },
			sealedCorpus: { stateRoot, projectId: PROJECT_ID, corpusId: holdout.id },
		});
		expect(experiment.compare.gate.verdict).toBe("improved");
		expect(experiment.sealedHoldout?.compare.gate.verdict).toBe("pass");

		// What `ahde candidate` now prints: both verdicts, read from the record.
		const verdictLines = renderCandidateVerdictLines(experiment.record);
		expect(verdictLines[0]).toMatch(
			/^development verdict: improved \+100\.0pp \(95% CI .*\) on 2 tasks × 2 repetitions$/u,
		);
		expect(verdictLines[1]).toMatch(/^sealed guardrail: pass on 15 tasks × 2 repetitions — no regression: /u);
		// A sealed line may carry a verdict and a design, never its content.
		for (const line of verdictLines) {
			expect(line).not.toContain("PRIVATE HOLDOUT INPUT");
			expect(line).not.toContain(holdout.id);
			expect(line).not.toContain("holdout-1");
		}

		// --- ahde review / ahde promote ----------------------------------------
		reviewCandidate({
			runsRoot,
			candidateId: experiment.record.candidateId,
			recommendation: "promote",
			reason: "Development improved and the sealed guardrail passed.",
			actorId: "local-user",
			now: CLOCK.now,
		});
		const promoted = promoteReviewedCandidate({
			repositoryDir: targetDir,
			runsRoot,
			candidateId: experiment.record.candidateId,
			version: "0.1.0",
			reason: "Ship the reviewed returns-policy candidate.",
			actorId: "local-user",
			now: CLOCK.now,
		});
		expect(promoted.candidateSha).toBe(applied.receipt.candidateSha);
		expect(checkout()).toEqual(checkoutBefore);

		// --- ahde adopt ---------------------------------------------------------
		const subject = describeTargetAdoption({
			repositoryDir: targetDir,
			runsRoot,
			candidateId: experiment.record.candidateId,
		});
		const adoption = adoptTargetCandidate({
			repositoryDir: targetDir,
			runsRoot,
			stateRoot,
			candidateId: experiment.record.candidateId,
			expectedSubjectHash: subject.subjectHash,
			actor: { kind: "human", id: "local-user" },
			reason: "Adopted at the terminal by the operator running `ahde adopt`.",
		}, { now: CLOCK.now });
		expect(adoption.disposition).toBe("adopted");
		expect(adoption.receipt.previousHead).toBe(checkoutBefore.head);
		expect(adoption.receipt.adoptedHead).toBe(applied.receipt.candidateSha);
		expect(adoption.subject.promotion.tag).toBe("v0.1.0");
		// Only now does the operator's own branch move — by fast-forward.
		expect(checkout()).toEqual({
			head: applied.receipt.candidateSha,
			branch: "main",
			status: "",
		});
		expect(readFileSync(join(targetDir, "AGENTS.md"), "utf8")).toBe(NEW_INSTRUCTIONS);
		expect(candidateStatus(loadCandidateRecord(runsRoot, experiment.record.candidateId))).toBe("promoted");
	}, 240_000);

	it("refuses a branch that changes anything outside the harness scope, by name", async () => {
		commitOnBranch(
			"work/out-of-scope",
			join("evals", "development.jsonl"),
			`${DEVELOPMENT.map((task) => JSON.stringify(task)).join("\n")}\n{"id":"dev-3","input":"x","graders":[]}\n`,
		);
		const approval = approveSpecDocument({
			stateRoot,
			projectId: PROJECT_ID,
			documentPath: join(targetDir, "spec.md"),
			now: CLOCK.now,
		});
		await expect(proposeBranchChange({
			targetDir,
			runsRoot,
			stateRoot,
			projectId: PROJECT_ID,
			specId: approval.specId,
			branch: "work/out-of-scope",
			runId: "builder-out-of-scope",
			now: CLOCK.now,
		})).rejects.toThrow(/outside the allowed harness scope: evals\/development\.jsonl/);
	}, 60_000);
});
