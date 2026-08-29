import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	TargetAdoptionError,
	TargetAdoptionIntentSchema,
	TargetAdoptionReceiptSchema,
	adoptTargetCandidate,
	describeTargetAdoption,
	loadTargetAdoptionReceipt,
} from "../src/application/target-adoption.js";
import { candidateRecordPath } from "../src/application/candidate-review.js";
import { CandidateRecordSchema } from "../src/domain/candidate.js";
import { hashValue } from "../src/provenance.js";
import { readJsonArtifact, writeJsonArtifact } from "../src/storage/artifacts.js";

const roots: string[] = [];
const at = "2026-08-28T09:00:00.000Z";
const later = "2026-08-28T09:01:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;

function git(repositoryDir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repositoryDir, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "AHDE Test",
			GIT_AUTHOR_EMAIL: "test@ahde.local",
			GIT_COMMITTER_NAME: "AHDE Test",
			GIT_COMMITTER_EMAIL: "test@ahde.local",
		},
	}).trim();
}

function comparison(surface: "development" | "sealed" = "development") {
	return {
		schemaVersion: 3 as const,
		algorithmId: "exact-comparison-gate-v3" as const,
		policyId: surface === "sealed" ? "sealed-guardrail-v3" as const : "development-ci-v3" as const,
		surface,
		comparisonHash: hash,
		evidenceHash: hash,
		gateHash: hash,
		summary: {
			taskCount: 15,
			baselinePassRate: 0,
			candidatePassRate: 1,
			delta: 1,
			confidence95: { low: 1, high: 1 },
			improved: 15,
			regressed: 0,
			unchanged: 0,
		},
		design: { tasks: 15, repetitions: 2, excludedTasks: 0 },
		verdict: surface === "sealed" ? "pass" as const : "improved" as const,
		flags: { regressedTasks: 0, improvedTasks: 15, collapsedTasks: 0 },
		reasons: ["fixture verdict"],
	};
}

function promotedRecord(
	baselineSha: string,
	candidateSha: string,
	tag = "v1.0.0",
) {
	const artifact = (path: string) => ({ path, sha256: hash });
	return CandidateRecordSchema.parse({
		schemaVersion: 1,
		candidateId: "candidate-1",
		projectId: "project-1",
		targetId: "target-1",
		specId: "spec-1",
		proposalId: "builder-1",
		diagnosisId: null,
		origin: {
			kind: "applied-builder",
			builderRunId: "builder-1",
			builderRun: artifact("/evidence/builder.json"),
			builderInput: artifact("/evidence/input.json"),
			proposal: artifact("/evidence/proposal.json"),
			applyReceipt: artifact("/evidence/apply.json"),
			application: {
				actor: { kind: "human", id: "reviewer" },
				reason: "Apply the reviewed harness proposal.",
				appliedAt: at,
				baseTargetSha: baselineSha,
				candidateSha,
				proposalSha256: hash,
			},
			source: null,
			approvedSpec: {
				specId: "spec-1",
				projectId: "project-1",
				specContentHash: hash,
				snapshotHash: hash,
				artifact: artifact("/evidence/spec.json"),
			},
		},
		mode: "candidate",
		baseline: { ref: "main", sha: baselineSha },
		createdAt: at,
		events: [
			{
				type: "proposed",
				eventId: "candidate-1:proposed",
				at,
				actor: { kind: "builder", id: "builder" },
			},
			{
				type: "built",
				eventId: "candidate-1:built",
				at,
				actor: { kind: "human", id: "reviewer" },
				candidate: { ref: "candidate", sha: candidateSha },
			},
			{
				type: "validated",
				eventId: "candidate-1:validated",
				at,
				actor: { kind: "system", id: "candidate-runner" },
				lineage: {
					baseline: { ref: "main", sha: baselineSha },
					candidate: { ref: "candidate", sha: candidateSha },
					relation: "descendant",
				},
				scope: {
					policyId: "candidate-harness-resources-v2",
					baselineSha,
					candidateSha,
					passed: true,
					changedFiles: ["AGENTS.md"],
					violations: [],
				},
			},
			{
				type: "evaluated",
				eventId: "candidate-1:evaluated",
				at,
				actor: { kind: "system", id: "candidate-runner" },
				evaluation: {
					experimentId: "experiment-1",
					designHash: hash,
					mode: "candidate",
					development: {
						baseline: { evalRunId: "development-baseline", harness: { ref: "main", sha: baselineSha } },
						candidate: { evalRunId: "development-candidate", harness: { ref: "candidate", sha: candidateSha } },
						comparison: comparison(),
						corpus: null,
					},
					sealedHoldout: {
						baseline: { evalRunId: "sealed-baseline", harness: { ref: "main", sha: baselineSha } },
						candidate: { evalRunId: "sealed-candidate", harness: { ref: "candidate", sha: candidateSha } },
						comparison: comparison("sealed"),
						corpus: { id: "sealed-corpus", hash },
					},
					infrastructureErrors: 0,
				},
			},
			{
				type: "reviewed",
				eventId: "candidate-1:reviewed",
				at,
				actor: { kind: "human", id: "reviewer" },
				review: {
					experimentId: "experiment-1",
					recommendation: "promote",
					reason: "No sealed regressions.",
				},
			},
			{
				type: "promoted",
				eventId: "candidate-1:promoted",
				at,
				actor: { kind: "human", id: "reviewer" },
				decision: {
					experimentId: "experiment-1",
					candidate: { ref: "candidate", sha: candidateSha },
					tag,
					reason: "Promote the sealed-evaluated candidate.",
				},
			},
		],
	});
}

interface Fixture {
	repositoryDir: string;
	runsRoot: string;
	stateRoot: string;
	baselineSha: string;
	candidateSha: string;
	tag: string;
}

function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "ahde-target-adoption-"));
	roots.push(root);
	const repositoryDir = join(root, "target");
	const runsRoot = join(root, "runs");
	const stateRoot = join(root, "state");
	mkdirSync(repositoryDir);
	mkdirSync(runsRoot);
	git(repositoryDir, "init", "-q", "-b", "main");
	writeFileSync(join(repositoryDir, "AGENTS.md"), "# Baseline\n", "utf8");
	git(repositoryDir, "add", "AGENTS.md");
	git(repositoryDir, "commit", "-qm", "baseline");
	const baselineSha = git(repositoryDir, "rev-parse", "HEAD");
	git(repositoryDir, "checkout", "-qb", "candidate");
	writeFileSync(join(repositoryDir, "AGENTS.md"), "# Candidate\n", "utf8");
	git(repositoryDir, "add", "AGENTS.md");
	git(repositoryDir, "commit", "-qm", "candidate");
	const candidateSha = git(repositoryDir, "rev-parse", "HEAD");
	const tag = "v1.0.0";
	git(repositoryDir, "tag", "-a", tag, "-m", "promoted candidate", candidateSha);
	git(repositoryDir, "checkout", "-q", "main");
	writeJsonArtifact(
		candidateRecordPath(runsRoot, "candidate-1"),
		CandidateRecordSchema,
		promotedRecord(baselineSha, candidateSha, tag),
	);
	return { repositoryDir, runsRoot, stateRoot, baselineSha, candidateSha, tag };
}

function options(value: Fixture) {
	return {
		repositoryDir: value.repositoryDir,
		runsRoot: value.runsRoot,
		candidateId: "candidate-1",
	};
}

function applyOptions(value: Fixture, expectedSubjectHash: string, reason = "Adopt after human review.") {
	return {
		...options(value),
		stateRoot: value.stateRoot,
		expectedSubjectHash,
		actor: { kind: "human" as const, id: "operator" },
		reason,
	};
}

function expectCode(action: () => unknown, code: TargetAdoptionError["code"]): void {
	try {
		action();
		throw new Error("expected TargetAdoptionError");
	} catch (error) {
		expect(error).toBeInstanceOf(TargetAdoptionError);
		expect((error as TargetAdoptionError).code).toBe(code);
	}
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TargetAdoption", () => {
	it("describes one exact promoted Candidate, branch, tag object, and content-addressed subject", () => {
		const value = fixture();
		const subject = describeTargetAdoption(options(value));

		expect(subject).toMatchObject({
			algorithmId: "promoted-candidate-fast-forward-v1",
			candidate: {
				candidateId: "candidate-1",
				targetId: "target-1",
				baseline: { ref: "main", sha: value.baselineSha },
				revision: { ref: "candidate", sha: value.candidateSha },
				changedFiles: ["AGENTS.md"],
			},
			branch: { name: "main", ref: "refs/heads/main" },
			promotion: { tag: value.tag, tagRef: `refs/tags/${value.tag}` },
		});
		expect(subject.promotion.tagObjectSha).toBe(git(value.repositoryDir, "rev-parse", `refs/tags/${value.tag}`));
		const { subjectHash: _subjectHash, ...identity } = subject;
		expect(subject.subjectHash).toBe(hashValue(identity));
	});

	it("fails closed for dirty, detached, stale, non-promoted, and retagged Targets", () => {
		{
			const value = fixture();
			writeFileSync(join(value.repositoryDir, "untracked.txt"), "dirty\n", "utf8");
			expectCode(() => describeTargetAdoption(options(value)), "TARGET_ADOPTION_DIRTY");
		}
		{
			const value = fixture();
			git(value.repositoryDir, "checkout", "--detach", "-q", value.baselineSha);
			expectCode(() => describeTargetAdoption(options(value)), "TARGET_ADOPTION_STALE");
		}
		{
			const value = fixture();
			git(value.repositoryDir, "merge", "--ff-only", "-q", value.candidateSha);
			expectCode(() => describeTargetAdoption(options(value)), "TARGET_ADOPTION_STALE");
		}
		{
			const value = fixture();
			const record = promotedRecord(value.baselineSha, value.candidateSha, value.tag);
			writeJsonArtifact(
				candidateRecordPath(value.runsRoot, "candidate-1"),
				CandidateRecordSchema,
				CandidateRecordSchema.parse({ ...record, events: record.events.slice(0, -1) }),
			);
			expectCode(() => describeTargetAdoption(options(value)), "TARGET_ADOPTION_INVALID_CANDIDATE");
		}
		{
			const value = fixture();
			git(value.repositoryDir, "tag", "-f", value.tag, value.baselineSha);
			expectCode(() => describeTargetAdoption(options(value)), "TARGET_ADOPTION_INVALID_TAG");
		}
	});

	it("rejects a symlinked repository root and a non-descendant disguised by refs/replace", () => {
		{
			const value = fixture();
			const link = join(value.repositoryDir, "..", "target-link");
			symlinkSync(value.repositoryDir, link, "dir");
			expectCode(
				() => describeTargetAdoption({ ...options(value), repositoryDir: link }),
				"TARGET_ADOPTION_INVALID_REPOSITORY",
			);
		}

		const value = fixture();
		const orphanSha = git(value.repositoryDir, "commit-tree", `${value.baselineSha}^{tree}`, "-m", "orphan candidate");
		git(value.repositoryDir, "replace", orphanSha, value.candidateSha);
		git(value.repositoryDir, "tag", "-f", "-a", value.tag, "-m", "replacement attack", orphanSha);
		writeJsonArtifact(
			candidateRecordPath(value.runsRoot, "candidate-1"),
			CandidateRecordSchema,
			promotedRecord(value.baselineSha, orphanSha, value.tag),
		);

		expect(spawnSync("git", ["-C", value.repositoryDir, "merge-base", "--is-ancestor", value.baselineSha, orphanSha]).status).toBe(0);
		expect(spawnSync("git", ["--no-replace-objects", "-C", value.repositoryDir, "merge-base", "--is-ancestor", value.baselineSha, orphanSha]).status).toBe(1);
		expectCode(() => describeTargetAdoption(options(value)), "TARGET_ADOPTION_NON_FAST_FORWARD");
	});

	it("fast-forwards the current branch without switching it and publishes private immutable evidence", () => {
		const value = fixture();
		const subject = describeTargetAdoption(options(value));
		const timestamps = [at, later];
		const result = adoptTargetCandidate(applyOptions(value, subject.subjectHash), {
			now: () => timestamps.shift() ?? later,
		});

		expect(result.disposition).toBe("adopted");
		expect(git(value.repositoryDir, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
		expect(git(value.repositoryDir, "rev-parse", "HEAD")).toBe(value.candidateSha);
		expect(git(value.repositoryDir, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
		expect(statSync(result.receiptPath).mode & 0o777).toBe(0o600);
		const intentPath = join(value.stateRoot, "target-adoptions", "candidate-1", "intent.json");
		expect(statSync(intentPath).mode & 0o777).toBe(0o600);
		expect(readJsonArtifact(intentPath, TargetAdoptionIntentSchema)).toEqual(result.intent);
		expect(loadTargetAdoptionReceipt(value.stateRoot, "candidate-1")).toEqual(result.receipt);

		const replay = adoptTargetCandidate(applyOptions(value, subject.subjectHash));
		expect(replay.disposition).toBe("already-adopted");
		expect(replay.receipt).toEqual(result.receipt);
	});

	it("recovers a clean exact fast-forward after receipt publication failed, but only for the matching intent", () => {
		const value = fixture();
		const subject = describeTargetAdoption(options(value));
		const request = applyOptions(value, subject.subjectHash);
		expect(() => adoptTargetCandidate(request, {
			now: () => at,
			writeReceipt: () => {
				throw new Error("simulated process failure before receipt publication");
			},
		})).toThrow(/simulated process failure/);

		expect(git(value.repositoryDir, "rev-parse", "HEAD")).toBe(value.candidateSha);
		const intentPath = join(value.stateRoot, "target-adoptions", "candidate-1", "intent.json");
		const receiptPath = join(value.stateRoot, "target-adoptions", "candidate-1", "receipt.json");
		expect(readJsonArtifact(intentPath, TargetAdoptionIntentSchema).subject.subjectHash).toBe(subject.subjectHash);
		expect(() => readFileSync(receiptPath)).toThrow();

		expectCode(
			() => adoptTargetCandidate(applyOptions(value, subject.subjectHash, "Different human reason.")),
			"TARGET_ADOPTION_INTENT_MISMATCH",
		);
		const recovered = adoptTargetCandidate(request, {
			now: () => later,
			fastForward: () => {
				throw new Error("recovery must not fast-forward twice");
			},
		});
		expect(recovered.disposition).toBe("recovered");
		expect(recovered.receipt.adoptedHead).toBe(value.candidateSha);
		expect(readJsonArtifact(receiptPath, TargetAdoptionReceiptSchema)).toEqual(recovered.receipt);
	});

	it("never recognizes an already-fast-forwarded checkout without its exact durable intent", () => {
		const value = fixture();
		const subject = describeTargetAdoption(options(value));
		git(value.repositoryDir, "merge", "--ff-only", "-q", value.candidateSha);

		expectCode(
			() => adoptTargetCandidate(applyOptions(value, subject.subjectHash)),
			"TARGET_ADOPTION_AMBIGUOUS_RECOVERY",
		);
	});

	it("fails closed when a pending intent is followed by an unrelated clean HEAD", () => {
		const value = fixture();
		const subject = describeTargetAdoption(options(value));
		const request = applyOptions(value, subject.subjectHash);
		expect(() => adoptTargetCandidate(request, {
			now: () => at,
			writeReceipt: () => {
				throw new Error("stop after fast-forward");
			},
		})).toThrow(/stop after fast-forward/);
		writeFileSync(join(value.repositoryDir, "unrelated.txt"), "unrelated\n", "utf8");
		git(value.repositoryDir, "add", "unrelated.txt");
		git(value.repositoryDir, "commit", "-qm", "unrelated post-adoption change");

		expectCode(() => adoptTargetCandidate(request), "TARGET_ADOPTION_AMBIGUOUS_RECOVERY");
	});
});
