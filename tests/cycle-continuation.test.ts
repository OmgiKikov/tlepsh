import { execFileSync } from "node:child_process";
import {
	chmodSync,
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
	adoptTargetCandidate,
	describeTargetAdoption,
} from "../src/application/target-adoption.js";
import { candidateRecordPath } from "../src/application/candidate-review.js";
import { CandidateRecordSchema } from "../src/domain/candidate.js";
import { hashValue } from "../src/provenance.js";
import { readJsonArtifact, writeJsonArtifact } from "../src/storage/artifacts.js";
import {
	CycleContinuationError,
	CycleContinuationReceiptSchema,
	describeCycleContinuation,
	loadCycleContinuationReceipt,
	recordCycleContinuation,
} from "../src/workbench/cycle-continuation.js";

const roots: string[] = [];
const at = "2026-08-28T10:00:00.000Z";
const later = "2026-08-28T10:01:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;

function git(repositoryDir: string, ...args: string[]): string {
	return execFileSync("git", ["--no-replace-objects", "-C", repositoryDir, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			GIT_NO_REPLACE_OBJECTS: "1",
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

function terminalRecord(
	status: "promoted" | "rejected",
	baselineSha: string,
	candidateSha: string,
	tag = "v1.0.0",
) {
	const artifact = (path: string) => ({ path, sha256: hash });
	const recommendation = status === "promoted" ? "promote" as const : "reject" as const;
	const decision = status === "promoted"
		? {
			type: "promoted" as const,
			eventId: "candidate-1:promoted",
			at,
			actor: { kind: "human" as const, id: "reviewer" },
			decision: {
				experimentId: "experiment-1",
				candidate: { ref: "candidate", sha: candidateSha },
				tag,
				reason: "Promote the sealed-evaluated candidate.",
			},
		}
		: {
			type: "rejected" as const,
			eventId: "candidate-1:rejected",
			at,
			actor: { kind: "human" as const, id: "reviewer" },
			decision: {
				experimentId: "experiment-1",
				reason: "Keep the active Target at its baseline.",
			},
		};
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
					recommendation,
					reason: status === "promoted" ? "No sealed regressions." : "Sealed evidence did not justify release.",
				},
			},
			decision,
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
	status: "promoted" | "rejected";
}

function fixture(status: "promoted" | "rejected"): Fixture {
	const root = mkdtempSync(join(tmpdir(), "ahde-cycle-continuation-"));
	roots.push(root);
	const repositoryDir = join(root, "target");
	const runsRoot = join(root, "runs");
	const stateRoot = join(root, "state");
	mkdirSync(repositoryDir, { mode: 0o700 });
	mkdirSync(runsRoot, { mode: 0o700 });
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
		terminalRecord(status, baselineSha, candidateSha, tag),
	);
	return { repositoryDir, runsRoot, stateRoot, baselineSha, candidateSha, tag, status };
}

function options(value: Fixture) {
	return {
		repositoryDir: value.repositoryDir,
		runsRoot: value.runsRoot,
		stateRoot: value.stateRoot,
		projectId: "project-1",
		targetId: "target-1",
		candidateId: "candidate-1",
	};
}

function adopt(value: Fixture): void {
	const subject = describeTargetAdoption(options(value));
	adoptTargetCandidate({
		...options(value),
		expectedSubjectHash: subject.subjectHash,
		actor: { kind: "human", id: "operator" },
		reason: "Adopt the exact promoted Candidate.",
	}, { now: () => at });
}

function recordOptions(value: Fixture, expectedSubjectHash: string, reason = "Start the next measured improvement cycle.") {
	return {
		...options(value),
		expectedSubjectHash,
		actor: { kind: "human" as const, id: "operator" },
		reason,
	};
}

function expectCode(action: () => unknown, code: CycleContinuationError["code"]): void {
	try {
		action();
		throw new Error("expected CycleContinuationError");
	} catch (error) {
		expect(error).toBeInstanceOf(CycleContinuationError);
		expect((error as CycleContinuationError).code).toBe(code);
	}
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CycleContinuation", () => {
	it("describes an exact rejected Candidate while leaving the active Target at its baseline", () => {
		const value = fixture("rejected");
		const subject = describeCycleContinuation(options(value));

		expect(subject).toMatchObject({
			algorithmId: "terminal-candidate-cycle-continuation-v1",
			projectId: "project-1",
			targetId: "target-1",
			candidate: {
				candidateId: "candidate-1",
				status: "rejected",
				baselineSha: value.baselineSha,
				builtSha: value.candidateSha,
			},
			activeTargetSha: value.baselineSha,
			branchRef: "refs/heads/main",
			adoptionReceiptHash: null,
		});
		const { subjectHash: _subjectHash, ...identity } = subject;
		expect(subject.subjectHash).toBe(hashValue(identity));
	});

	it("requires and binds the exact TargetAdoption receipt for a promoted Candidate", () => {
		const value = fixture("promoted");
		git(value.repositoryDir, "merge", "--ff-only", "-q", value.candidateSha);
		expectCode(() => describeCycleContinuation(options(value)), "CYCLE_CONTINUATION_INVALID_ADOPTION");

		const adopted = fixture("promoted");
		adopt(adopted);
		const subject = describeCycleContinuation(options(adopted));
		expect(subject.candidate.status).toBe("promoted");
		expect(subject.activeTargetSha).toBe(adopted.candidateSha);
		expect(subject.branchRef).toBe("refs/heads/main");
		expect(subject.adoptionReceiptHash).toMatch(/^sha256:[0-9a-f]{64}$/);

		chmodSync(join(adopted.stateRoot, "target-adoptions", "candidate-1", "receipt.json"), 0o644);
		expectCode(() => describeCycleContinuation(options(adopted)), "CYCLE_CONTINUATION_ARTIFACT_INVALID");
	});

	it("records a content-addressed private receipt and makes exact replay idempotent", () => {
		const value = fixture("rejected");
		const subject = describeCycleContinuation(options(value));
		const result = recordCycleContinuation(recordOptions(value, subject.subjectHash), { now: () => later });

		expect(result.disposition).toBe("recorded");
		expect(result.receipt.subject).toEqual(subject);
		expect(result.receipt.actor).toEqual({ kind: "human", id: "operator" });
		expect(result.receipt.continuedAt).toBe(later);
		expect(statSync(result.receiptPath).mode & 0o777).toBe(0o600);
		const { receiptId: _receiptId, ...identity } = result.receipt;
		expect(result.receipt.receiptId).toBe(
			`cycle-continuation-receipt-${hashValue(identity).slice("sha256:".length)}`,
		);
		expect(loadCycleContinuationReceipt(value.stateRoot, "project-1", "candidate-1")).toEqual(result.receipt);

		const replay = recordCycleContinuation(recordOptions(value, subject.subjectHash), {
			now: () => "2027-01-01T00:00:00.000Z",
		});
		expect(replay.disposition).toBe("already-recorded");
		expect(replay.receipt).toEqual(result.receipt);
		expectCode(
			() => recordCycleContinuation(recordOptions(value, subject.subjectHash, "A different reason.")),
			"CYCLE_CONTINUATION_CONFLICT",
		);
	});

	it("revalidates the full CandidateRecord after confirmation and refuses stale evidence", () => {
		const value = fixture("rejected");
		const subject = describeCycleContinuation(options(value));
		const path = candidateRecordPath(value.runsRoot, "candidate-1");
		const record = readJsonArtifact(path, CandidateRecordSchema);
		const events = [...record.events];
		const rejected = events.at(-1);
		if (!rejected || rejected.type !== "rejected") throw new Error("expected rejected fixture");
		events[events.length - 1] = {
			...rejected,
			decision: { ...rejected.decision, reason: "Updated terminal human reason." },
		};
		writeJsonArtifact(path, CandidateRecordSchema, CandidateRecordSchema.parse({ ...record, events }));

		expectCode(
			() => recordCycleContinuation(recordOptions(value, subject.subjectHash)),
			"CYCLE_CONTINUATION_STALE",
		);
	});

	it("fails closed for dirty, detached, and wrong active Target revisions", () => {
		{
			const value = fixture("rejected");
			writeFileSync(join(value.repositoryDir, "untracked.txt"), "dirty\n", "utf8");
			expectCode(() => describeCycleContinuation(options(value)), "CYCLE_CONTINUATION_DIRTY");
		}
		{
			const value = fixture("rejected");
			git(value.repositoryDir, "checkout", "--detach", "-q", value.baselineSha);
			expectCode(() => describeCycleContinuation(options(value)), "CYCLE_CONTINUATION_STALE");
		}
		{
			const value = fixture("rejected");
			git(value.repositoryDir, "merge", "--ff-only", "-q", value.candidateSha);
			expectCode(() => describeCycleContinuation(options(value)), "CYCLE_CONTINUATION_STALE");
		}
	});

	it("rejects adoption evidence that no longer binds the promoted CandidateRecord", () => {
		const value = fixture("promoted");
		adopt(value);
		const path = candidateRecordPath(value.runsRoot, "candidate-1");
		const record = readJsonArtifact(path, CandidateRecordSchema);
		const events = [...record.events];
		const promoted = events.at(-1);
		if (!promoted || promoted.type !== "promoted") throw new Error("expected promoted fixture");
		events[events.length - 1] = {
			...promoted,
			decision: { ...promoted.decision, reason: "Changed after Target adoption." },
		};
		writeJsonArtifact(path, CandidateRecordSchema, CandidateRecordSchema.parse({ ...record, events }));

		expectCode(() => describeCycleContinuation(options(value)), "CYCLE_CONTINUATION_INVALID_ADOPTION");
	});

	it("fails closed on repository/state symlinks, traversal, and non-private evidence", () => {
		{
			const value = fixture("rejected");
			const link = join(value.repositoryDir, "..", "target-link");
			symlinkSync(value.repositoryDir, link, "dir");
			expectCode(
				() => describeCycleContinuation({ ...options(value), repositoryDir: link }),
				"CYCLE_CONTINUATION_INVALID_REPOSITORY",
			);
		}
		{
			const value = fixture("rejected");
			const actualState = join(value.repositoryDir, "..", "actual-state");
			mkdirSync(actualState, { mode: 0o700 });
			symlinkSync(actualState, value.stateRoot, "dir");
			expectCode(() => describeCycleContinuation(options(value)), "CYCLE_CONTINUATION_ARTIFACT_INVALID");
		}
		{
			const value = fixture("rejected");
			expect(() => describeCycleContinuation({ ...options(value), candidateId: "../candidate" })).toThrow();
		}
		{
			const value = fixture("rejected");
			const subject = describeCycleContinuation(options(value));
			const result = recordCycleContinuation(recordOptions(value, subject.subjectHash), { now: () => later });
			chmodSync(result.receiptPath, 0o644);
			expectCode(
				() => loadCycleContinuationReceipt(value.stateRoot, "project-1", "candidate-1"),
				"CYCLE_CONTINUATION_ARTIFACT_INVALID",
			);
		}
	});

	it("rejects tampered receipt bytes instead of recognizing a completed cycle", () => {
		const value = fixture("rejected");
		const subject = describeCycleContinuation(options(value));
		const result = recordCycleContinuation(recordOptions(value, subject.subjectHash), { now: () => later });
		const parsed = JSON.parse(readFileSync(result.receiptPath, "utf8")) as Record<string, unknown>;
		parsed.reason = "tampered";
		writeFileSync(result.receiptPath, `${JSON.stringify(parsed)}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(result.receiptPath, 0o600);

		expectCode(
			() => loadCycleContinuationReceipt(value.stateRoot, "project-1", "candidate-1"),
			"CYCLE_CONTINUATION_ARTIFACT_INVALID",
		);
		expect(() => readJsonArtifact(result.receiptPath, CycleContinuationReceiptSchema)).toThrow();
	});
});
