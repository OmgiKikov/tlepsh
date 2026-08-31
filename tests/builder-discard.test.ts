import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	describeBuilderProposalDiscard,
	discardBuilderProposal,
	loadBuilderDiscardReceipt,
} from "../src/application/builder-discard.js";
import {
	approveBuilderSpecDraft,
	describeSpecDraftApproval,
	recordBuilderAuthoredProposal,
	saveBuilderSpecDraft,
} from "../src/application/builder-authoring.js";
import { CANDIDATE_SCOPE_POLICY } from "../src/application/candidate-experiment.js";
import { applyBuilderProposal } from "../src/application/builder-proposal.js";
import { hashFile } from "../src/provenance.js";
import { deriveWorkbenchView, loadWorkbenchInventory } from "../src/workbench/inventory.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(repositoryDir: string, args: string[]): string {
	return execFileSync("git", ["-C", repositoryDir, ...args], { encoding: "utf8" }).trim();
}

function fixtureTarget(): { root: string; sha: string } {
	const root = mkdtempSync(join(tmpdir(), "ahde-discard-target-"));
	git(root, ["init", "-b", "main"]);
	git(root, ["config", "user.name", "Fixture"]);
	git(root, ["config", "user.email", "fixture@example.test"]);
	mkdirSync(join(root, "evals"));
	writeFileSync(join(root, "AGENTS.md"), "old\n");
	writeFileSync(join(root, "manifest.yaml"), `id: discard-target
model:
  provider: fixture
  id: fixture-model
  api: openai-completions
  baseUrl: http://127.0.0.1:1/v1
  apiKeyEnv: FIXTURE_KEY
  thinkingLevel: "off"
  timeoutMs: 1000
instructions:
  agentsMd: AGENTS.md
skills: []
tools: []
evalSuite:
  id: discard-development
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`);
	writeFileSync(join(root, "evals", "development.jsonl"), `${JSON.stringify({
		id: "case-1",
		input: "fixture",
		graders: [{ type: "output_contains", text: "fixture" }],
	})}\n`);
	writeFileSync(join(root, "evals", "graders.yaml"), "defaults: []\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "fixture"]);
	return { root, sha: git(root, ["rev-parse", "HEAD"]) };
}

async function proposalFixture() {
	const target = fixtureTarget();
	roots.push(target.root);
	const runsRoot = mkdtempSync(join(tmpdir(), "ahde-discard-runs-"));
	const stateRoot = mkdtempSync(join(tmpdir(), "ahde-discard-state-"));
	roots.push(runsRoot, stateRoot);
	const draft = saveBuilderSpecDraft({
		stateRoot,
		projectId: "discard-project",
		spec: {
			schemaVersion: 1,
			title: "Discard fixture",
			purpose: "Verify durable proposal discard",
			users: ["operator"],
			jobs: ["review proposal"],
			inputs: ["request"],
			allowedActions: ["respond"],
			successCriteria: ["safe lifecycle"],
			constraints: ["human gate"],
			openQuestions: [],
		},
	});
	const approvalSubject = describeSpecDraftApproval(stateRoot, "discard-project", draft.id);
	const spec = approveBuilderSpecDraft({
		stateRoot,
		projectId: "discard-project",
		draftSpecId: draft.id,
		expectedDraftSnapshotHash: approvalSubject.draftSnapshotHash,
		actor: { kind: "human", id: "local:operator" },
		reason: "Approve exact discard fixture",
	}).approved;
	const base = readFileSync(join(target.root, "AGENTS.md"), "utf8");
	const run = await recordBuilderAuthoredProposal({
		proposal: {
			schemaVersion: 1,
			decision: "propose",
			baseTargetSha: target.sha,
			summary: "Tighten the answer contract",
			diagnoses: [],
			changes: [{
				path: "AGENTS.md",
				baseSha256: hashFile(base),
				unifiedDiff: "--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n-old\n+new\n",
				rationale: "reviewed request",
				evidenceRefs: [],
			}],
			risks: ["behavior may change"],
			validationPlan: ["rerun development corpus"],
		},
		approvedSpec: { stateRoot, projectId: "discard-project", specId: spec.id },
		targetDir: target.root,
		allowedPaths: [...CANDIDATE_SCOPE_POLICY.allowed],
		runsRoot,
		timeoutMs: 1_000,
	});
	return {
		runsRoot,
		stateRoot,
		projectId: "discard-project",
		runId: run.record.runId,
		repoDir: target.root,
	};
}

describe("durable Builder proposal discard", () => {
	it("records an immutable exact-subject receipt and rejects replay", async () => {
		const value = await proposalFixture();
		const described = describeBuilderProposalDiscard(value.runsRoot, value.runId);
		const discarded = discardBuilderProposal({
			...value,
			actor: { kind: "human", id: "local:operator" },
			reason: "Not the change I want",
			expectedSubjectHash: described.subjectHash,
		}, { now: () => "2026-08-26T12:00:00.000Z" });
		expect(discarded.receipt.subjectHash).toBe(described.subjectHash);
		expect(loadBuilderDiscardReceipt(value.runsRoot, value.runId)).toEqual(discarded.receipt);
		expect(() => discardBuilderProposal({
			...value,
			actor: { kind: "human", id: "local:operator" },
			reason: "again",
			expectedSubjectHash: described.subjectHash,
		})).toThrow(/already exists/);
	});

	it("rejects a stale host confirmation hash", async () => {
		const value = await proposalFixture();
		expect(() => discardBuilderProposal({
			...value,
			actor: { kind: "human", id: "local:operator" },
			reason: "discard",
			expectedSubjectHash: `sha256:${"f".repeat(64)}`,
		})).toThrow(/stale/);
	});

	it("makes Discard and Apply durably mutually exclusive", async () => {
		const value = await proposalFixture();
		const described = describeBuilderProposalDiscard(value.runsRoot, value.runId);
		discardBuilderProposal({
			runsRoot: value.runsRoot,
			runId: value.runId,
			actor: { kind: "human", id: "local:operator" },
			reason: "Reject this proposal",
			expectedSubjectHash: described.subjectHash,
		});

		expect(() => applyBuilderProposal({
			repoDir: value.repoDir,
			runsRoot: value.runsRoot,
			runId: value.runId,
			requestedBranch: "candidate/discarded-proposal",
			actor: { kind: "human", id: "local:operator" },
			reason: "attempted stale apply",
		})).toThrow(/already discarded/);
	});

	it("surfaces an interrupted discard and resumes only the exact decision after restart", async () => {
		const value = await proposalFixture();
		const described = describeBuilderProposalDiscard(value.runsRoot, value.runId);
		const options = {
			runsRoot: value.runsRoot,
			runId: value.runId,
			actor: { kind: "human" as const, id: "local:operator" },
			reason: "Requested interactively via /discard",
			expectedSubjectHash: described.subjectHash,
		};
		expect(() => discardBuilderProposal(options, {
			now: () => "2026-08-26T12:00:00.000Z",
			writeReceipt: () => { throw new Error("simulated process death before discard receipt"); },
		})).toThrow(/simulated process death/);
		expect(existsSync(join(value.runsRoot, "builders", value.runId, "decision_claim.json"))).toBe(true);
		expect(existsSync(join(value.runsRoot, "builders", value.runId, "discard_receipt.json"))).toBe(false);

		const inventory = loadWorkbenchInventory({
			projectDir: value.repoDir,
			stateRoot: value.stateRoot,
			runsRoot: value.runsRoot,
			projectId: value.projectId,
		});
		expect(inventory.integrityBlockers).toEqual([]);
		expect(inventory.proposals.find((proposal) => proposal.record.runId === value.runId)?.status)
			.toBe("discard-pending");
		expect(deriveWorkbenchView(inventory)).toMatchObject({
			stage: "proposal-review",
			actions: ["review", "discard"],
		});
		expect(() => applyBuilderProposal({
			repoDir: value.repoDir,
			runsRoot: value.runsRoot,
			runId: value.runId,
			requestedBranch: `candidate/${value.runId}`,
			actor: { kind: "human", id: "local:operator" },
			reason: "Requested interactively via /apply",
		})).toThrow(/discard decision claim/);

		const recovered = discardBuilderProposal(options, {
			now: () => "2099-01-01T00:00:00.000Z",
		});
		expect(recovered.receipt.discardedAt).toBe("2026-08-26T12:00:00.000Z");
	});

	it("surfaces an interrupted apply and deterministically replays the command defaults after restart", async () => {
		const value = await proposalFixture();
		const options = {
			repoDir: value.repoDir,
			runsRoot: value.runsRoot,
			runId: value.runId,
			requestedBranch: `candidate/${value.runId}`,
			actor: { kind: "human" as const, id: "local:operator" },
			reason: "Requested interactively via /apply",
		};
		expect(() => applyBuilderProposal(options, {
			now: () => "2026-08-26T12:00:00.000Z",
			writeIntent: () => { throw new Error("simulated process death after apply claim"); },
		})).toThrow(/simulated process death/);

		const inventory = loadWorkbenchInventory({
			projectDir: value.repoDir,
			stateRoot: value.stateRoot,
			runsRoot: value.runsRoot,
			projectId: value.projectId,
		});
		expect(inventory.integrityBlockers).toEqual([]);
		expect(inventory.proposals.find((proposal) => proposal.record.runId === value.runId)?.status)
			.toBe("apply-pending");
		expect(deriveWorkbenchView(inventory)).toMatchObject({
			stage: "proposal-review",
			actions: ["review", "apply"],
		});

		const recovered = applyBuilderProposal(options, {
			now: () => "2099-01-01T00:00:00.000Z",
		});
		expect(recovered.receipt.appliedAt).toBe("2026-08-26T12:00:00.000Z");
		expect(recovered.receipt.branch).toBe(`candidate/${value.runId}`);
	});

	it.each(["apply-paths", "discard-subject"] as const)(
		"treats a tampered pending %s claim as an inventory integrity blocker",
		async (kind) => {
			const value = await proposalFixture();
			const claimPath = join(value.runsRoot, "builders", value.runId, "decision_claim.json");
			if (kind === "apply-paths") {
				expect(() => applyBuilderProposal({
					repoDir: value.repoDir,
					runsRoot: value.runsRoot,
					runId: value.runId,
					requestedBranch: `candidate/${value.runId}`,
					actor: { kind: "human", id: "local:operator" },
					reason: "Requested interactively via /apply",
				}, {
					now: () => "2026-08-26T12:00:00.000Z",
					writeIntent: () => { throw new Error("stop after claim"); },
				})).toThrow(/stop after claim/);
				const claim = JSON.parse(readFileSync(claimPath, "utf8")) as Record<string, unknown>;
				writeFileSync(claimPath, `${JSON.stringify({ ...claim, paths: ["skills/forged.md"] })}\n`);
			} else {
				const described = describeBuilderProposalDiscard(value.runsRoot, value.runId);
				expect(() => discardBuilderProposal({
					runsRoot: value.runsRoot,
					runId: value.runId,
					actor: { kind: "human", id: "local:operator" },
					reason: "Requested interactively via /discard",
					expectedSubjectHash: described.subjectHash,
				}, {
					now: () => "2026-08-26T12:00:00.000Z",
					writeReceipt: () => { throw new Error("stop after claim"); },
				})).toThrow(/stop after claim/);
				const claim = JSON.parse(readFileSync(claimPath, "utf8")) as Record<string, unknown>;
				writeFileSync(claimPath, `${JSON.stringify({ ...claim, subjectHash: `sha256:${"f".repeat(64)}` })}\n`);
			}

			const inventory = loadWorkbenchInventory({
				projectDir: value.repoDir,
				stateRoot: value.stateRoot,
				runsRoot: value.runsRoot,
				projectId: value.projectId,
			});
			expect(inventory.proposals).toEqual([]);
			expect(inventory.integrityBlockers.join("\n")).toMatch(
				kind === "apply-paths" ? /claim paths do not match/ : /claim subject does not match/,
			);
		},
	);
});
