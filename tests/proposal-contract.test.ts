import { describe, expect, it } from "vitest";
import {
	CandidateProposalSchema,
	validateCandidateProposal,
	type BuilderRequest,
	type CandidateProposal,
} from "../src/builder/proposal-contract.js";

const BASE_SHA = "1".repeat(40);
const OTHER_SHA = "2".repeat(40);
const BASE_HASH = `sha256:${"a".repeat(64)}`;

function proposal(path = "AGENTS.md", baseTargetSha = BASE_SHA): CandidateProposal {
	return CandidateProposalSchema.parse({
		schemaVersion: 1,
		decision: "propose",
		baseTargetSha,
		summary: "Tighten the project instructions",
		diagnoses: [{ failureIds: ["failure-1"], evidence: ["trace:event-3"], rootCause: "Instruction is ambiguous" }],
		changes: [{
			path,
			baseSha256: BASE_HASH,
			unifiedDiff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`,
			rationale: "Make the constraint explicit",
			evidenceRefs: ["trace:event-3"],
		}],
		risks: ["May over-constrain the agent"],
		validationPlan: ["Run the failing cases"],
	});
}

function request(overrides: Partial<BuilderRequest> = {}): BuilderRequest {
	return {
		runId: "builder-test",
		bundle: "  exact diagnostic bundle\n",
		baseTargetSha: BASE_SHA,
		allowedPaths: ["AGENTS.md", "manifest.yaml", "skills/**", "bin/**", "tools/**"],
		timeoutMs: 1_000,
		...overrides,
	};
}

describe("proposal trust boundary", () => {
	it("rejects a mismatched target SHA and paths outside the allowed scope", () => {
		expect(() => validateCandidateProposal(proposal("AGENTS.md", OTHER_SHA), request())).toThrow(/baseTargetSha/);
		expect(() => validateCandidateProposal(proposal("src/index.ts"), request())).toThrow(/outside the allowed scope/);
	});

	it("rejects duplicate paths, malformed hashes, empty diffs, and eval files", () => {
		const base = proposal();
		expect(() => CandidateProposalSchema.parse({ ...base, changes: [base.changes[0], base.changes[0]] })).toThrow(/unique/);
		expect(() => CandidateProposalSchema.parse({
			...base,
			changes: [{ ...base.changes[0], baseSha256: "not-a-hash" }],
		})).toThrow(/sha256/);
		expect(() => CandidateProposalSchema.parse({
			...base,
			changes: [{ ...base.changes[0], unifiedDiff: "" }],
		})).toThrow(/nonempty|too_small|expected/i);
		expect(() => proposal("evals/hidden.yaml")).toThrow(/cannot modify/);
		expect(validateCandidateProposal(proposal("manifest.yaml"), request()).changes[0]?.path).toBe("manifest.yaml");
	});

	it("rejects diff headers for another or multiple files", () => {
		const base = proposal();
		expect(() => validateCandidateProposal({
			...base,
			changes: [{ ...base.changes[0], unifiedDiff: "--- a/tools/x\n+++ b/tools/x\n@@ -1 +1 @@\n-a\n+b" }],
		}, request())).toThrow(/headers do not match/);
		expect(() => validateCandidateProposal({
			...base,
			changes: [{
				...base.changes[0],
				unifiedDiff: `${base.changes[0]!.unifiedDiff}\n--- a/evals/hidden.yaml\n+++ b/evals/hidden.yaml\n@@ -1 +1 @@\n-a\n+b`,
			}],
		}, request())).toThrow(/headers do not match/);
	});
});
