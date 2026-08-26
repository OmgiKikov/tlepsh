import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CorpusDraftPromptSchema,
	generateCorpusDraftFromApprovedSpec,
	listCorpusDrafts,
	loadCorpusDraft,
} from "../src/application/corpus-draft.js";
import type { PiBuilderExecutor, PiBuilderExecutionRequest } from "../src/builders/adapters.js";
import { listCorpora } from "../src/corpus.js";
import { saveSpecSnapshot, type AgentSpec } from "../src/spec.js";

const NOW = "2026-08-26T14:00:00.000Z";
const roots: string[] = [];

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "ahde-corpus-draft-"));
	roots.push(path);
	return path;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function spec(): AgentSpec {
	return {
		schemaVersion: 1,
		title: "Policy assistant",
		purpose: "Answer policy questions from approved evidence.",
		users: ["Support operators"],
		jobs: ["Answer policy questions"],
		inputs: ["A policy question"],
		allowedActions: ["Read local policy documents"],
		successCriteria: ["Answer contains the applicable policy", "Unknown policy is reported honestly"],
		constraints: ["Never invent a policy"],
		openQuestions: [],
	};
}

function approved(stateRoot: string) {
	return saveSpecSnapshot({
		stateRoot,
		projectId: "policy",
		status: "approved",
		spec: spec(),
		sourceText: "A policy Q&A assistant",
		now: () => NOW,
	});
}

function modelOutput() {
	return {
		schemaVersion: 1 as const,
		name: "Policy development draft",
		tasks: [
			{ input: "What is the refund window?", graders: [{ type: "output_contains" as const, text: "policy" }] },
			{ input: "What if the policy is absent?", graders: [{ type: "output_matches" as const, pattern: "(?i)unknown|not found" }] },
		],
		coverageNotes: ["Covers a known policy and an unknown-policy boundary"],
	};
}

function executor(final: unknown, requests: PiBuilderExecutionRequest[] = []): PiBuilderExecutor {
	return {
		version: "pi-test 1.2.3+abcdef",
		capabilities: { eventStream: true, usage: true, cost: true, sessionId: true },
		execute: vi.fn(async (request) => {
			requests.push(request);
			return {
				final,
				events: [{ type: "assistant_final", ok: true }],
				model: "test/model-1",
				sessionId: "session-exact",
				usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
				costUsd: 0.012,
			};
		}),
	};
}

describe("generateCorpusDraftFromApprovedSpec", () => {
	it("generates deterministic typed tasks with exact provenance but never publishes a corpus", async () => {
		const stateRoot = root();
		const snapshot = approved(stateRoot);
		const requests: PiBuilderExecutionRequest[] = [];
		const generator = executor(modelOutput(), requests);
		const options = {
			approvedSpec: { stateRoot, projectId: "policy", specId: snapshot.id },
			executor: generator,
			taskCount: 2,
			guidance: "Include one adversarial boundary case.",
			timeoutMs: 2_000,
		};
		const first = await generateCorpusDraftFromApprovedSpec(options, { now: () => NOW });
		const second = await generateCorpusDraftFromApprovedSpec(options, { now: () => "2026-08-26T15:00:00.000Z" });

		expect(first.draft.id).toMatch(/^corpus-draft-[0-9a-f]{64}$/);
		expect(second.draft.id).toBe(first.draft.id);
		expect(second.draft.createdAt).toBe(NOW);
		expect(first.draft.tasks.map((task) => task.id)).toEqual(
			first.draft.tasks.map((task) => expect.stringMatching(/^task-[0-9a-f]{64}$/)),
		);
		expect(new Set(first.draft.tasks.map((task) => task.id)).size).toBe(2);
		expect(first.draft.approvedSpec).toMatchObject({ projectId: "policy", specId: snapshot.id });
		expect(first.draft.generation).toMatchObject({
			executorVersion: "pi-test 1.2.3+abcdef",
			model: "test/model-1",
			sessionId: "session-exact",
			promptHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
			modelOutputHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
			eventsHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
		});
		expect(loadCorpusDraft(stateRoot, "policy", first.draft.id)).toEqual(first.draft);
		expect(listCorpusDrafts(stateRoot, "policy")).toEqual([first.draft]);
		expect(listCorpora({ stateRoot, projectId: "policy" })).toEqual([]);
		expect(existsSync(join(stateRoot, "projects", "policy", "corpora"))).toBe(false);

		const prompt = CorpusDraftPromptSchema.parse(JSON.parse(requests[0]!.input));
		expect(prompt.approvedSpec.spec).toEqual(snapshot.spec);
		expect(prompt.approvedSpec.reference).toEqual(first.draft.approvedSpec);
		expect(prompt.request).toEqual({
			taskCount: 2,
			guidance: "Include one adversarial boundary case.",
			publication: "draft-only-human-review-required",
		});
		expect(requests[0]!.tools).toEqual([]);
	});

	it("rejects draft and tampered Spec snapshots before invoking the agent or creating draft state", async () => {
		const stateRoot = root();
		const draft = saveSpecSnapshot({
			stateRoot,
			projectId: "policy",
			status: "draft",
			spec: spec(),
			now: () => NOW,
		});
		const generator = executor(modelOutput());
		await expect(generateCorpusDraftFromApprovedSpec({
			approvedSpec: { stateRoot, projectId: "policy", specId: draft.id },
			executor: generator,
			taskCount: 2,
			timeoutMs: 1_000,
		})).rejects.toThrow(/approved snapshot is required/);

		const snapshot = approved(stateRoot);
		writeFileSync(
			join(stateRoot, "projects", "policy", "specs", `${snapshot.id}.json`),
			`${JSON.stringify({ ...snapshot, spec: { ...snapshot.spec, purpose: "tampered" } })}\n`,
			"utf8",
		);
		await expect(generateCorpusDraftFromApprovedSpec({
			approvedSpec: { stateRoot, projectId: "policy", specId: snapshot.id },
			executor: generator,
			taskCount: 2,
			timeoutMs: 1_000,
		})).rejects.toThrow(/spec id does not match snapshot content/);
		expect(generator.execute).not.toHaveBeenCalled();
		expect(existsSync(join(stateRoot, "projects", "policy", "corpus-drafts"))).toBe(false);
	});

	it("rejects malformed model output and count mismatches without publishing any draft or corpus", async () => {
		const stateRoot = root();
		const snapshot = approved(stateRoot);
		const base = {
			approvedSpec: { stateRoot, projectId: "policy", specId: snapshot.id },
			taskCount: 2,
			timeoutMs: 1_000,
		};
		await expect(generateCorpusDraftFromApprovedSpec({
			...base,
			executor: executor({ ...modelOutput(), unexpected: true }),
		})).rejects.toThrow(/Unrecognized key/);
		await expect(generateCorpusDraftFromApprovedSpec({
			...base,
			executor: executor({ ...modelOutput(), tasks: modelOutput().tasks.slice(0, 1) }),
		})).rejects.toThrow(/requested 2 tasks.*returned 1/);
		expect(listCorpusDrafts(stateRoot, "policy")).toEqual([]);
		expect(listCorpora({ stateRoot, projectId: "policy" })).toEqual([]);
	});

	it("enforces request, task-content, event, and aggregate bounds before publication", async () => {
		const stateRoot = root();
		const snapshot = approved(stateRoot);
		const base = { approvedSpec: { stateRoot, projectId: "policy", specId: snapshot.id }, timeoutMs: 1_000 };
		const unused = executor(modelOutput());
		await expect(generateCorpusDraftFromApprovedSpec({ ...base, executor: unused, taskCount: 101 })).rejects.toThrow(/Too big.*<=100/);
		expect(unused.execute).not.toHaveBeenCalled();

		await expect(generateCorpusDraftFromApprovedSpec({
			...base,
			taskCount: 2,
			executor: executor({
				...modelOutput(),
				tasks: [
					{ input: "x".repeat(32_001), graders: [{ type: "output_contains", text: "x" }] },
					modelOutput().tasks[1],
				],
			}),
		})).rejects.toThrow(/Too big|less than or equal to 32000/);

		const excessiveEvents: PiBuilderExecutor = {
			version: "pi-test 1.2.3+abcdef",
			execute: async () => ({ final: modelOutput(), events: ["e".repeat(1024 * 1024 + 1)] }),
		};
		await expect(generateCorpusDraftFromApprovedSpec({
			...base,
			taskCount: 2,
			executor: excessiveEvents,
		})).rejects.toThrow(/events exceed 1048576 bytes/);

		const manyLargeTasks = Array.from({ length: 100 }, (_, index) => ({
			input: `${index}-${"x".repeat(25_000)}`,
			graders: [{ type: "output_contains" as const, text: String(index) }],
		}));
		await expect(generateCorpusDraftFromApprovedSpec({
			...base,
			taskCount: 100,
			executor: executor({ ...modelOutput(), tasks: manyLargeTasks }),
		})).rejects.toThrow(/model output exceeds 2097152 bytes/);
		expect(listCorpusDrafts(stateRoot, "policy")).toEqual([]);
		expect(listCorpora({ stateRoot, projectId: "policy" })).toEqual([]);
	});
});
