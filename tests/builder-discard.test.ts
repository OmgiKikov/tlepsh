import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	describeBuilderProposalDiscard,
	discardBuilderProposal,
	loadBuilderDiscardReceipt,
} from "../src/application/builder-discard.js";
import { recordBuilderAuthoredProposal } from "../src/application/builder-authoring.js";
import { CANDIDATE_SCOPE_POLICY } from "../src/application/candidate-experiment.js";
import { applyBuilderProposal } from "../src/application/builder-proposal.js";
import { hashFile } from "../src/provenance.js";
import { saveSpecSnapshot } from "../src/spec.js";

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
	const spec = saveSpecSnapshot({
		stateRoot,
		projectId: "discard-project",
		status: "approved",
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
	return { runsRoot, runId: run.record.runId, repoDir: target.root };
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
});
