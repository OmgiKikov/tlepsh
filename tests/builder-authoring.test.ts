import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	approveBuilderSpecDraft,
	createBuilderAuthoredProposalAdapter,
	describeDevelopmentCorpusPublication,
	describeSpecDraftApproval,
	loadDevelopmentCorpusPublicationReceipt,
	loadSpecApprovalReceipt,
	publishBuilderDevelopmentCorpus,
	recordBuilderAuthoredProposal,
	saveBuilderSpecDraft,
} from "../src/application/builder-authoring.js";
import { CandidateProposalSchema, type CandidateProposal } from "../src/builders/adapters.js";
import { loadCorpus } from "../src/corpus.js";
import { hashValue } from "../src/provenance.js";
import type { AgentSpec } from "../src/spec.js";

const NOW = "2026-08-26T16:00:00.000Z";
const roots: string[] = [];

function root(prefix: string): string {
	const value = mkdtempSync(join(tmpdir(), prefix));
	roots.push(value);
	return value;
}

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function spec(): AgentSpec {
	return {
		schemaVersion: 1,
		title: "Policy assistant",
		purpose: "Answer policy questions from approved local evidence.",
		users: ["Support operators"],
		jobs: ["Answer a policy question"],
		inputs: ["A policy question"],
		allowedActions: ["Read approved local policy"],
		successCriteria: ["The answer cites the applicable policy"],
		constraints: ["Never invent policy"],
		openQuestions: [],
	};
}

function corpusTasks() {
	return [
		{
			id: "known-refund",
			input: "What is the refund window?",
			graders: [{ type: "output_contains" as const, text: "policy" }],
		},
		{
			id: "unknown-policy",
			input: "What if no policy exists?",
			graders: [{ type: "output_matches" as const, pattern: "unknown|not found" }],
		},
	];
}

function git(repositoryDir: string, args: string[]): string {
	return execFileSync("git", ["-C", repositoryDir, ...args], { encoding: "utf8" }).trim();
}

function sha256(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function targetRepository(): { targetDir: string; baseSha: string } {
	const targetDir = root("ahde-builder-authoring-target-");
	git(targetDir, ["init", "-b", "main"]);
	git(targetDir, ["config", "user.name", "Fixture"]);
	git(targetDir, ["config", "user.email", "fixture@example.test"]);
	mkdirSync(join(targetDir, "evals"));
	writeFileSync(join(targetDir, "AGENTS.md"), "old\n");
	writeFileSync(join(targetDir, "manifest.yaml"), `id: authoring-target
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
evalSuite:
  id: authoring-development
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`);
	writeFileSync(join(targetDir, "evals", "development.jsonl"), `${JSON.stringify({
		id: "case-1",
		input: "fixture",
		graders: [{ type: "output_contains", text: "fixture" }],
	})}\n`);
	writeFileSync(join(targetDir, "evals", "graders.yaml"), "defaults: []\n");
	git(targetDir, ["add", "."]);
	git(targetDir, ["commit", "-m", "fixture target"]);
	return { targetDir, baseSha: git(targetDir, ["rev-parse", "HEAD"]) };
}

function proposal(baseTargetSha: string): CandidateProposal {
	return CandidateProposalSchema.parse({
		schemaVersion: 1,
		decision: "propose",
		baseTargetSha,
		summary: "Make the instruction explicit.",
		diagnoses: [{
			failureIds: ["case-1"],
			evidence: ["builder-session:review"],
			rootCause: "The instruction is ambiguous.",
		}],
		changes: [{
			path: "AGENTS.md",
			baseSha256: sha256("old\n"),
			unifiedDiff: [
				"diff --git a/AGENTS.md b/AGENTS.md",
				"--- a/AGENTS.md",
				"+++ b/AGENTS.md",
				"@@ -1 +1 @@",
				"-old",
				"+new",
			].join("\n"),
			rationale: "Remove ambiguity.",
			evidenceRefs: ["builder-session:review"],
		}],
		risks: ["The instruction is intentionally narrow."],
		validationPlan: ["Run the development corpus."],
	});
}

describe("Builder authoring services", () => {
	it("approves only the exact reviewed Spec draft and persists a private immutable receipt", () => {
		const stateRoot = root("ahde-builder-authoring-state-");
		const draft = saveBuilderSpecDraft({
			stateRoot,
			projectId: "policy",
			spec: spec(),
			sourceText: "Build a policy assistant",
			now: () => NOW,
		});
		const subject = describeSpecDraftApproval(stateRoot, "policy", draft.id);
		const result = approveBuilderSpecDraft({
			stateRoot,
			projectId: "policy",
			draftSpecId: draft.id,
			expectedDraftSnapshotHash: subject.draftSnapshotHash,
			actor: { kind: "human", id: "local-reviewer" },
			reason: "Reviewed the exact structured contract.",
		}, { now: () => NOW });

		expect(result.approved.status).toBe("approved");
		expect(result.approved.spec).toEqual(draft.spec);
		expect(result.receipt.draft).toEqual(subject);
		expect(result.receipt.approvedSpec.specContentHash).toBe(hashValue(draft.spec));
		expect(loadSpecApprovalReceipt(stateRoot, "policy", draft.id)).toEqual(result.receipt);
		expect(statSync(result.receiptPath).mode & 0o777).toBe(0o600);
		expect(() => approveBuilderSpecDraft({
			stateRoot,
			projectId: "policy",
			draftSpecId: draft.id,
			expectedDraftSnapshotHash: subject.draftSnapshotHash,
			actor: { kind: "human", id: "local-reviewer" },
			reason: "Replay",
		})).toThrow(/replay refused/);
	});

	it("rejects stale hashes, wrong projects, and symlinked receipt state before approval", () => {
		const stateRoot = root("ahde-builder-authoring-state-");
		const draft = saveBuilderSpecDraft({ stateRoot, projectId: "policy", spec: spec(), now: () => NOW });
		expect(() => approveBuilderSpecDraft({
			stateRoot,
			projectId: "policy",
			draftSpecId: draft.id,
			expectedDraftSnapshotHash: `sha256:${"0".repeat(64)}`,
			actor: { kind: "human", id: "reviewer" },
			reason: "stale",
		})).toThrow(/approval is stale/);
		expect(() => approveBuilderSpecDraft({
			stateRoot,
			projectId: "other-project",
			draftSpecId: draft.id,
			expectedDraftSnapshotHash: hashValue(draft),
			actor: { kind: "human", id: "reviewer" },
			reason: "wrong project",
		})).toThrow(/no saved specifications/);

		const outside = root("ahde-builder-authoring-outside-");
		symlinkSync(outside, join(stateRoot, "projects", "policy", "builder-authoring"), "dir");
		expect(() => approveBuilderSpecDraft({
			stateRoot,
			projectId: "policy",
			draftSpecId: draft.id,
			expectedDraftSnapshotHash: hashValue(draft),
			actor: { kind: "human", id: "reviewer" },
			reason: "unsafe state",
		})).toThrow(/non-symlink directory/);
	});

	it("publishes only an exact bounded development corpus and binds it to an immutable receipt", () => {
		const stateRoot = root("ahde-builder-authoring-state-");
		const tasks = corpusTasks();
		const subject = describeDevelopmentCorpusPublication({ projectId: "policy", name: "Policy development", tasks });
		const result = publishBuilderDevelopmentCorpus({
			stateRoot,
			projectId: "policy",
			name: "Policy development",
			tasks,
			expectedSubjectHash: subject.subjectHash,
			actor: { kind: "human", id: "corpus-reviewer" },
			reason: "Reviewed every development case and grader.",
		}, { now: () => NOW });

		expect(result.corpus).toMatchObject({
			visibility: "development",
			hash: subject.contentHash,
			taskCount: 2,
		});
		expect(result.receipt.subject).toEqual(subject);
		expect(loadCorpus({ stateRoot, projectId: "policy", corpusId: result.corpus.id }).tasks).toMatchObject(tasks);
		expect(loadDevelopmentCorpusPublicationReceipt(stateRoot, "policy", result.corpus.id)).toEqual(result.receipt);
		expect(statSync(result.receiptPath).mode & 0o777).toBe(0o600);
		expect(() => publishBuilderDevelopmentCorpus({
			stateRoot,
			projectId: "policy",
			name: "Policy development",
			tasks,
			expectedSubjectHash: subject.subjectHash,
			actor: { kind: "human", id: "corpus-reviewer" },
			reason: "Replay",
		})).toThrow(/replay refused/);
	});

	it("rejects corpus approval when content or project changes and bounds Builder-authored tasks", () => {
		const stateRoot = root("ahde-builder-authoring-state-");
		const tasks = corpusTasks();
		const subject = describeDevelopmentCorpusPublication({ projectId: "policy", name: "Policy development", tasks });
		expect(() => publishBuilderDevelopmentCorpus({
			stateRoot,
			projectId: "policy",
			name: "Policy development",
			tasks: [{ ...tasks[0]!, input: "Changed after review" }, tasks[1]!],
			expectedSubjectHash: subject.subjectHash,
			actor: { kind: "human", id: "reviewer" },
			reason: "stale",
		})).toThrow(/approval is stale/);
		expect(() => publishBuilderDevelopmentCorpus({
			stateRoot,
			projectId: "another-project",
			name: "Policy development",
			tasks,
			expectedSubjectHash: subject.subjectHash,
			actor: { kind: "human", id: "reviewer" },
			reason: "wrong project",
		})).toThrow(/approval is stale/);
		expect(() => describeDevelopmentCorpusPublication({
			projectId: "policy",
			name: "Too large",
			tasks: Array.from({ length: 101 }, (_, index) => ({
				id: `case-${index}`,
				input: "bounded",
				graders: [{ type: "output_contains", text: "bounded" }],
			})),
		})).toThrow(/Too big|less than or equal to 100/);
	});

	it("records the already-authored proposal as a canonical Builder run without invoking another model", async () => {
		const stateRoot = root("ahde-builder-authoring-state-");
		const runsRoot = root("ahde-builder-authoring-runs-");
		const draft = saveBuilderSpecDraft({ stateRoot, projectId: "policy", spec: spec(), now: () => NOW });
		const approval = approveBuilderSpecDraft({
			stateRoot,
			projectId: "policy",
			draftSpecId: draft.id,
			expectedDraftSnapshotHash: hashValue(draft),
			actor: { kind: "human", id: "reviewer" },
			reason: "Approve exact Spec",
		}, { now: () => NOW });
		const { targetDir, baseSha } = targetRepository();
		const authored = proposal(baseSha);
		const result = await recordBuilderAuthoredProposal({
			proposal: authored,
			targetDir,
			allowedPaths: ["AGENTS.md", "skills/**", "bin/**", "tools/**"],
			approvedSpec: { stateRoot, projectId: "policy", specId: approval.approved.id },
			runsRoot,
			timeoutMs: 2_000,
			runId: "builder-authored-1",
		}, { now: () => NOW });

		expect(result.record).toMatchObject({
			runId: "builder-authored-1",
			request: {
				provenanceMode: "canonical",
				approvedSpec: approval.receipt.approvedSpec,
				source: null,
				sourceAttestation: null,
			},
			result: {
				backend: "ahde-builder-pi",
				backendVersion: "ahde-builder-pi-authoring/1",
				proposal: authored,
			},
		});
		expect(JSON.parse(readFileSync(result.eventsPath, "utf8"))).toMatchObject({
			type: "builder_authored_proposal",
			proposalSha256: hashValue(authored),
		});
		await expect(recordBuilderAuthoredProposal({
			proposal: authored,
			targetDir,
			allowedPaths: ["AGENTS.md"],
			approvedSpec: { stateRoot, projectId: "policy", specId: approval.approved.id },
			runsRoot,
			timeoutMs: 2_000,
			runId: "builder-authored-1",
		}, { now: () => NOW })).rejects.toThrow(/already exists/);
	});

	it("validates the authored proposal against the exact adapter request", async () => {
		const value = proposal("a".repeat(40));
		const adapter = createBuilderAuthoredProposalAdapter(value, { now: () => NOW });
		await expect(adapter.run({
			runId: "inline",
			bundle: "typed canonical input",
			baseTargetSha: "b".repeat(40),
			allowedPaths: ["AGENTS.md"],
			timeoutMs: 1_000,
		})).rejects.toThrow(/does not match requested/);
	});
});
