import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BuilderRunRecordSchema,
	CandidateProposalSchema,
	ClaudeCliBuilderAdapter,
	CodexCliBuilderAdapter,
	MAX_RAW_EVENT_BYTES,
	PiBuilderAdapter,
	validateCandidateProposal,
	type BuilderRequest,
	type BuilderSpawn,
	type BuilderSpawnInvocation,
	type BuilderSpawnResult,
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

function noChange(): CandidateProposal {
	return CandidateProposalSchema.parse({
		schemaVersion: 1,
		decision: "no-change",
		baseTargetSha: BASE_SHA,
		summary: "Evidence is insufficient",
		diagnoses: [],
		changes: [],
		risks: [],
		validationPlan: ["Collect another trace"],
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

function spawned(overrides: Partial<BuilderSpawnResult> = {}): BuilderSpawnResult {
	return {
		exitCode: 0,
		signal: null,
		stdout: "",
		stderr: "",
		timedOut: false,
		cancelled: false,
		outputLimitExceeded: false,
		spawnError: null,
		...overrides,
	};
}

function scriptedSpawn(
	handler: (invocation: BuilderSpawnInvocation, index: number) => BuilderSpawnResult | Promise<BuilderSpawnResult>,
): { spawn: BuilderSpawn; invocations: BuilderSpawnInvocation[] } {
	const invocations: BuilderSpawnInvocation[] = [];
	return {
		invocations,
		spawn: async (invocation) => {
			invocations.push(invocation);
			return handler(invocation, invocations.length - 1);
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Codex CLI builder", () => {
	it("OS-confines Codex reads so a shell-capable backend cannot inspect sealed sibling evidence", async () => {
		if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return;
		const root = mkdtempSync(join(tmpdir(), "ahde-codex-adversarial-"));
		const secretPath = join(root, "sealed-corpus.jsonl");
		const executable = join(root, "fake-codex");
		writeFileSync(secretPath, "SEALED_VALUE_MUST_NOT_LEAK\n", { mode: 0o600 });
		const final = JSON.stringify(proposal());
		writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "fake-codex 1.0.0"
  exit 0
fi
secret=${JSON.stringify(secretPath)}
if leak=$(/bin/cat "$secret" 2>/dev/null); then :; else leak="READ_DENIED"; fi
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then shift; out="$1"; fi
  shift
done
/usr/bin/printf '%s\n' '${final}' > "$out"
/usr/bin/printf '{"type":"adversarial_read","value":"%s","output":"%s"}\n' "$leak" "$out"
`, { mode: 0o700 });
		chmodSync(executable, 0o700);
		try {
			const adapter = new CodexCliBuilderAdapter({
				executable,
				hostEnv: { PATH: "/usr/bin:/bin", OPENAI_API_KEY: "fixture" },
				now: () => NOW,
			});
			const result = await adapter.run(request({ timeoutMs: 5_000 }));
			expect(result.status, JSON.stringify(result)).toBe("completed");
			expect(result.rawEvents.join("\n")).toContain("READ_DENIED");
			expect(result.rawEvents.join("\n")).not.toContain("SEALED_VALUE_MUST_NOT_LEAK");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the exact isolated process contract and trusts only the final schema file", async () => {
		const trace = '{"type":"future_event","opaque":{"keep":true}}\nnot-json\n';
		const process = scriptedSpawn((invocation, index) => {
			expect(readdirSync(invocation.cwd)).toEqual([]);
			if (index === 0) return spawned({ stdout: "codex-cli 9.4.1\n" });
			const schemaIndex = invocation.args.indexOf("--output-schema") + 1;
			const finalIndex = invocation.args.indexOf("--output-last-message") + 1;
			expect(JSON.parse(readFileSync(invocation.args[schemaIndex]!, "utf8"))).toMatchObject({ type: "object" });
			expect(dirname(invocation.args[schemaIndex]!)).not.toBe(invocation.cwd);
			writeFileSync(invocation.args[finalIndex]!, JSON.stringify(proposal()), "utf8");
			return spawned({ stdout: trace });
		});
		const adapter = new CodexCliBuilderAdapter({
			executable: "fake-codex",
			spawn: process.spawn,
			hostEnv: {
				PATH: "/test/bin",
				HOME: "/test/home",
				TMPDIR: "/test/tmp",
				OPENAI_API_KEY: "openai-secret",
				ANTHROPIC_API_KEY: "must-not-leak",
				UNRELATED_SECRET: "must-not-leak",
			},
			now: () => NOW,
		});

		const result = await adapter.run(request());

		expect(result.status).toBe("completed");
		expect(result.proposal).toEqual(proposal());
		expect(result.backendVersion).toBe("codex-cli 9.4.1");
		expect(result.rawEvents).toEqual([
			'{"type":"future_event","opaque":{"keep":true}}',
			"not-json",
		]);
		expect(result.usage).toBeNull();
		expect(result.costUsd).toBeNull();
		expect(result.sessionId).toBeNull();
		expect(process.invocations).toHaveLength(2);
		expect(process.invocations[0]?.executable).toBe("/usr/bin/sandbox-exec");
		expect(process.invocations[0]?.args.at(-2)).toBe("fake-codex");
		expect(process.invocations[0]?.args.at(-1)).toBe("--version");
		expect(process.invocations[1]?.args.slice(-13)).toEqual([
			"fake-codex",
			"exec",
			"--ephemeral",
			"--json",
			"--sandbox",
			"read-only",
			"--ignore-user-config",
			"--ignore-rules",
			"--output-schema",
			process.invocations[1]?.args[process.invocations[1]!.args.indexOf("--output-schema") + 1],
			"--output-last-message",
			process.invocations[1]?.args[process.invocations[1]!.args.indexOf("--output-last-message") + 1],
			"-",
		]);
		expect(process.invocations[1]?.stdin).toBe("  exact diagnostic bundle\n");
		expect(process.invocations[1]?.env.PATH).toBe("/test/bin");
		expect(process.invocations[1]?.env.OPENAI_API_KEY).toBe("openai-secret");
		expect(process.invocations[1]?.env.HOME).not.toBe("/test/home");
		expect(process.invocations[1]?.env.TMPDIR).not.toBe("/test/tmp");
		expect(process.invocations[1]?.env.CODEX_HOME).toBe(process.invocations[1]?.env.HOME);
		expect(process.invocations[1]?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
		expect(process.invocations[1]?.env).not.toHaveProperty("UNRELATED_SECRET");
		for (const invocation of process.invocations) expect(existsSync(invocation.cwd)).toBe(false);
		expect(() => BuilderRunRecordSchema.parse(result)).not.toThrow();
	});

	it("does not publish streamed, malformed, or missing final output", async () => {
		const streamedProposal = JSON.stringify({ type: "proposal", proposal: proposal() });
		for (const finalContent of [undefined, "not-json"] as const) {
			const process = scriptedSpawn((invocation, index) => {
				if (index === 0) return spawned({ stdout: "codex 1.0.0" });
				if (finalContent !== undefined) {
					const finalPath = invocation.args[invocation.args.indexOf("--output-last-message") + 1]!;
					writeFileSync(finalPath, finalContent, "utf8");
				}
				return spawned({ stdout: `${streamedProposal}\n` });
			});
			const result = await new CodexCliBuilderAdapter({ spawn: process.spawn, now: () => NOW }).run(request());

			expect(result.status).toBe("failed");
			expect(result.proposal).toBeNull();
			expect(result.error?.code).toBe("invalid-structured-output");
		}
	});

	it("fails closed on nonzero exit even if a valid final file exists", async () => {
		const process = scriptedSpawn((invocation, index) => {
			if (index === 0) return spawned({ stdout: "codex 1.0.0" });
			const finalPath = invocation.args[invocation.args.indexOf("--output-last-message") + 1]!;
			writeFileSync(finalPath, JSON.stringify(proposal()), "utf8");
			return spawned({ exitCode: 7, stderr: "backend failed" });
		});

		const result = await new CodexCliBuilderAdapter({ spawn: process.spawn, now: () => NOW }).run(request());

		expect(result).toMatchObject({ status: "failed", proposal: null, error: { code: "nonzero-exit" } });
	});

	it.each([
		["timeout", { timedOut: true }],
		["cancelled", { cancelled: true }],
	] as const)("returns the explicit %s status", async (status, flags) => {
		const process = scriptedSpawn((_invocation, index) =>
			index === 0 ? spawned({ stdout: "codex 1.0.0" }) : spawned(flags),
		);
		const result = await new CodexCliBuilderAdapter({ spawn: process.spawn, now: () => NOW }).run(request());

		expect(result.status).toBe(status);
		expect(result.proposal).toBeNull();
		expect(result.error?.code).toBe(status);
	});

	it("bounds raw JSONL and fails rather than truncating a publishable run", async () => {
		const process = scriptedSpawn((invocation, index) => {
			if (index === 0) return spawned({ stdout: "codex 1.0.0" });
			const finalPath = invocation.args[invocation.args.indexOf("--output-last-message") + 1]!;
			writeFileSync(finalPath, JSON.stringify(proposal()), "utf8");
			return spawned({ stdout: "x".repeat(MAX_RAW_EVENT_BYTES + 1) });
		});
		const result = await new CodexCliBuilderAdapter({ spawn: process.spawn, now: () => NOW }).run(request());

		expect(result).toMatchObject({ status: "failed", proposal: null, error: { code: "output-limit" } });
	});

	it("probes an exact version once and reports a missing binary", async () => {
		const available = scriptedSpawn(() => spawned({ stdout: "codex-cli 2.3.4\n" }));
		const adapter = new CodexCliBuilderAdapter({ spawn: available.spawn });
		expect(await adapter.probe()).toMatchObject({
			available: true,
			version: "codex-cli 2.3.4",
			capabilities: { structuredOutput: true, cost: false, isolation: "read-confined-cli" },
		});
		expect(await adapter.probe()).toMatchObject({ available: true, version: "codex-cli 2.3.4" });
		expect(available.invocations).toHaveLength(1);

		const missing = scriptedSpawn(() => spawned({ exitCode: null, spawnError: "spawn codex ENOENT" }));
		expect(await new CodexCliBuilderAdapter({ spawn: missing.spawn }).probe()).toMatchObject({
			available: false,
			version: null,
			error: { code: "binary-missing", retryable: false },
		});
	});
});

describe("Claude CLI builder", () => {
	it("uses the exact bare, tool-free argv and authoritative result event", async () => {
		const unknown = JSON.stringify({ type: "future_event", payload: { untouched: true } });
		const final = JSON.stringify({ type: "result", structured_output: noChange() });
		const process = scriptedSpawn((invocation, index) => {
			expect(readdirSync(invocation.cwd)).toEqual([]);
			return index === 0 ? spawned({ stdout: "claude 4.2.0" }) : spawned({ stdout: `${unknown}\n${final}\n` });
		});
		const adapter = new ClaudeCliBuilderAdapter({
			executable: "fake-claude",
			spawn: process.spawn,
			hostEnv: {
				PATH: "/test/bin",
				HOME: "/test/home",
				TMPDIR: "/test/tmp",
				ANTHROPIC_API_KEY: "anthropic-secret",
				OPENAI_API_KEY: "must-not-leak",
			},
			now: () => NOW,
		});

		const result = await adapter.run(request());

		expect(result).toMatchObject({
			status: "completed",
			proposal: noChange(),
			usage: null,
			costUsd: null,
			sessionId: null,
			model: null,
			rawEvents: [unknown, final],
		});
		expect(process.invocations[1]?.args).toEqual([
			"--bare",
			"-p",
			"--no-session-persistence",
			"--tools",
			"",
			"--disallowedTools",
			"*",
			"--permission-mode",
			"dontAsk",
			"--output-format",
			"stream-json",
			"--verbose",
			"--json-schema",
			process.invocations[1]?.args[13],
		]);
		expect(process.invocations[1]?.env.PATH).toBe("/test/bin");
		expect(process.invocations[1]?.env.ANTHROPIC_API_KEY).toBe("anthropic-secret");
		expect(process.invocations[1]?.env.HOME).not.toBe("/test/home");
		expect(process.invocations[1]?.env.TMPDIR).not.toBe("/test/tmp");
		expect(process.invocations[1]?.env).not.toHaveProperty("OPENAI_API_KEY");
		expect(existsSync(process.invocations[1]!.cwd)).toBe(false);
	});
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
