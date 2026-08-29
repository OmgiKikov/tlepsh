import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CandidateProposalSchema,
	PiBuilderAdapter,
	validateCandidateProposal,
	type BuilderRequest,
	type CandidateProposal,
	type PiBuilderExecutionRequest,
} from "../src/builders/adapters.js";

const BASE_SHA = "1".repeat(40);
const OTHER_SHA = "2".repeat(40);
const BASE_HASH = `sha256:${"a".repeat(64)}`;
const NOW = "2026-08-26T12:00:00.000Z";

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

afterEach(() => {
	vi.useRealTimers();
});

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

describe("Pi builder seam", () => {
	it("is tool-free, declares injected capabilities, and shares proposal validation", async () => {
		const received: PiBuilderExecutionRequest[] = [];
		const adapter = new PiBuilderAdapter({
			executor: {
				version: "pi-executor 0.84.3",
				capabilities: { eventStream: true, usage: false, cost: false, sessionId: false },
				execute: async (value) => {
					received.push(value);
					return { final: proposal(), events: [{ type: "unknown-pi-event", future: true }] };
				},
			},
			now: () => NOW,
		});

		expect(await adapter.probe()).toMatchObject({
			available: true,
			version: "pi-executor 0.84.3",
			capabilities: {
				eventStream: true,
				structuredOutput: true,
				usage: false,
				cost: false,
				sessionId: false,
				cancellation: true,
				isolation: "tool-free-executor",
			},
		});
		const result = await adapter.run(request());

		expect(received[0]).toMatchObject({ input: "  exact diagnostic bundle\n", tools: [], timeoutMs: 1_000 });
		expect(received[0]?.outputSchema).toMatchObject({ type: "object" });
		expect(result).toMatchObject({
			status: "completed",
			usage: null,
			costUsd: null,
			sessionId: null,
			rawEvents: ['{"type":"unknown-pi-event","future":true}'],
		});
	});

	it("refuses an executor proposal that leaves the requested scope", async () => {
		const result = await new PiBuilderAdapter({
			executor: { version: "pi 1.0.0", execute: async () => ({ final: proposal("src/index.ts") }) },
			now: () => NOW,
		}).run(request());

		expect(result).toMatchObject({
			status: "failed",
			proposal: null,
			error: { code: "invalid-structured-output" },
		});
		expect(result.error?.message).toMatch(/outside the allowed scope/);
	});

	it("does not invoke the executor for a pre-cancelled request", async () => {
		const execute = vi.fn(async () => ({ final: proposal() }));
		const controller = new AbortController();
		controller.abort();
		const result = await new PiBuilderAdapter({
			executor: { version: "pi 1.0.0", execute },
			now: () => NOW,
		}).run(request({ signal: controller.signal }));

		expect(result).toMatchObject({ status: "cancelled", proposal: null, error: { code: "cancelled" } });
		expect(execute).not.toHaveBeenCalled();
	});

	it("times out an executor that honors cancellation without publishing", async () => {
		vi.useFakeTimers();
		const adapter = new PiBuilderAdapter({
			executor: {
				version: "pi 1.0.0",
				execute: async ({ signal }) => new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("terminated")), { once: true });
				}),
			},
			now: () => NOW,
		});
		const pending = adapter.run(request({ timeoutMs: 10 }));
		await vi.advanceTimersByTimeAsync(11);

		await expect(pending).resolves.toMatchObject({
			status: "timeout",
			proposal: null,
			error: { code: "timeout", retryable: true },
		});
	});

	it("forces and confirms termination before returning for an abort-ignoring executor", async () => {
		vi.useFakeTimers();
		let rejectExecution: (error: Error) => void = () => undefined;
		const terminate = vi.fn(async () => rejectExecution(new Error("force-terminated")));
		const adapter = new PiBuilderAdapter({
			executor: {
				version: "pi 1.0.0",
				execute: async () => new Promise((_resolve, reject) => {
					rejectExecution = reject;
				}),
				terminate,
			},
			now: () => NOW,
		});
		const pending = adapter.run(request({ timeoutMs: 10 }));
		await vi.advanceTimersByTimeAsync(11);

		await expect(pending).resolves.toMatchObject({
			status: "timeout",
			proposal: null,
			error: { code: "timeout", retryable: true },
		});
		expect(terminate).toHaveBeenCalledExactlyOnceWith("timeout");
	});
});
