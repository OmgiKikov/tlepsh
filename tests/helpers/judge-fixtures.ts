import { RunRecordSchema, type RunRecord } from "../../src/provenance.js";

function hash(character: string): string {
	return `sha256:${character.repeat(64)}`;
}

/** One completed run, valid against the canonical schema, for grader tests. */
export function baseRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
	return RunRecordSchema.parse({
		schemaVersion: 1,
		runId: "run-a",
		taskId: "task-a",
		repetitionIndex: 0,
		label: "baseline",
		status: "completed",
		error: null,
		startedAt: "2026-08-28T10:00:00.000Z",
		finishedAt: "2026-08-28T10:00:01.000Z",
		target: { id: "test-target", gitSha: "a".repeat(40) },
		runtime: { piVersion: "0.84.3", piSha: "b".repeat(40), ahdeVersion: "0.1.0", ahdeCodeHash: hash("c") },
		model: {
			provider: "test",
			id: "test-model",
			api: "openai-completions",
			baseUrl: "https://example.invalid/v1",
			apiKeyEnv: "TEST_KEY",
			thinkingLevel: "off",
			params: {},
			spec: {},
		},
		execution: {
			workspace: "isolated-copy-v1",
			tools: ["read"],
			environment: [],
			sandbox: "none",
			network: "deny",
			filesystem: "workspace-confined-v1",
			resources: {
				contextFiles: "disabled",
				extensions: "disabled",
				promptTemplates: "disabled",
				skills: "manifest-only",
			},
		},
		eval: { suiteId: "test-suite", suiteHash: hash("d"), dataset: "development", datasetHash: hash("e") },
		trace: { path: "session.jsonl", sessionId: null, sha256: null },
		metrics: {
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			costUsd: 0,
			latencyMs: 1,
			toolCalls: 0,
			toolErrors: 0,
			recoveryAttempts: 0,
		},
		evalResults: {
			graders: [{ name: "legacy", type: "output_contains", passed: true, score: 1, reason: "ok" }],
			outcome: "pass",
		},
		parent: { evalRunId: "erun-test", candidateOf: null },
		...overrides,
	});
}
