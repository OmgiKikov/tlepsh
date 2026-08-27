import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
	BuilderRunRecordSchema,
	type BuilderAdapter,
	type BuilderCapabilities,
	type BuilderRequest,
	type CandidateProposal,
} from "../src/builders/adapters.js";
import {
	HARNESS_AUTHORING_ALLOWED_PATHS,
	HarnessAuthoringIntentSchema,
	compileHarnessAuthoringProposal,
} from "../src/application/harness-authoring.js";
import { applyBuilderProposal, runBuilderProposal } from "../src/application/builder-proposal.js";

const NOW = "2026-08-26T14:00:00.000Z";
const roots: string[] = [];
const CAPABILITIES: BuilderCapabilities = {
	eventStream: true,
	structuredOutput: true,
	usage: false,
	cost: false,
	sessionId: false,
	cancellation: true,
	isolation: "tool-free-executor",
};

function temporaryRoot(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	roots.push(path);
	return path;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(repositoryDir: string, args: string[]): string {
	return execFileSync("git", ["-C", repositoryDir, ...args], { encoding: "utf8" }).trim();
}

function manifest(resources = false): string {
	return `id: authored-target
model:
  provider: fixture
  id: fixture-model
  api: openai-completions
  baseUrl: http://127.0.0.1:1/v1
  apiKeyEnv: FIXTURE_KEY
  thinkingLevel: "off"
  timeoutMs: 1000
execution:
  tools: [read]
  environmentAllowlist: []
  network: deny
  sandbox: best-effort
instructions:
  agentsMd: AGENTS.md
skills: ${resources ? "[skills/existing-skill]" : "[]"}
tools: ${resources ? "[tools/existing_tool.tool.yaml]" : "[]"}
evalSuite:
  id: authored-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`;
}

const EXISTING_DESCRIPTOR = `schemaVersion: 1
name: existing_tool
description: Existing tool.
parameters:
  type: object
  properties: {}
  required: []
  additionalProperties: false
command:
  argv: [bin/existing_tool]
timeoutMs: 1000
maxOutputBytes: 4096
output: json
permissions:
  environment: []
  network: deny
  filesystem: read-only
`;

function initTarget(resources = false): { repositoryDir: string; baseSha: string } {
	const repositoryDir = temporaryRoot("ahde-harness-authoring-");
	git(repositoryDir, ["init", "-b", "main"]);
	git(repositoryDir, ["config", "user.name", "Fixture"]);
	git(repositoryDir, ["config", "user.email", "fixture@example.test"]);
	mkdirSync(join(repositoryDir, "evals"), { recursive: true });
	writeFileSync(join(repositoryDir, "AGENTS.md"), "# Old instructions\n");
	writeFileSync(join(repositoryDir, "manifest.yaml"), manifest(resources));
	writeFileSync(join(repositoryDir, "evals", "development.jsonl"), `${JSON.stringify({
		id: "fixture",
		input: "Say ready",
		graders: [{ type: "output_contains", text: "ready" }],
	})}\n`);
	writeFileSync(join(repositoryDir, "evals", "graders.yaml"), "defaults: []\n");
	if (resources) {
		mkdirSync(join(repositoryDir, "skills", "existing-skill"), { recursive: true });
		mkdirSync(join(repositoryDir, "tools"), { recursive: true });
		mkdirSync(join(repositoryDir, "bin"), { recursive: true });
		writeFileSync(
			join(repositoryDir, "skills", "existing-skill", "SKILL.md"),
			"---\nname: existing-skill\ndescription: Existing skill.\n---\n\n# Existing\n",
		);
		writeFileSync(join(repositoryDir, "tools", "existing_tool.tool.yaml"), EXISTING_DESCRIPTOR);
		writeFileSync(join(repositoryDir, "bin", "existing_tool"), "#!/bin/sh\nprintf '{}\\n'\n");
		chmodSync(join(repositoryDir, "bin", "existing_tool"), 0o755);
	}
	git(repositoryDir, ["add", "."]);
	git(repositoryDir, ["commit", "-m", "target fixture"]);
	return { repositoryDir, baseSha: git(repositoryDir, ["rev-parse", "HEAD"]) };
}

function descriptor() {
	return {
		description: "Look up a message.",
		parameters: {
			type: "object",
			properties: { message: { type: "string", minLength: 1, maxLength: 100 } },
			required: ["message"],
			additionalProperties: false,
		},
		arguments: ["--json"],
		timeoutMs: 2_000,
		maxOutputBytes: 8_192,
		output: "json" as const,
		permissions: {
			environment: [],
			network: "deny" as const,
			filesystem: "read-only" as const,
		},
	};
}

function completedRecord(request: BuilderRequest, proposal: CandidateProposal) {
	return BuilderRunRecordSchema.parse({
		schemaVersion: 1,
		runId: request.runId,
		backend: "structured-authoring-test",
		backendVersion: "1.0.0",
		capabilities: CAPABILITIES,
		baseTargetSha: request.baseTargetSha,
		startedAt: NOW,
		finishedAt: NOW,
		status: "completed",
		proposal,
		model: null,
		sessionId: null,
		usage: null,
		costUsd: null,
		traceLevel: "final-only",
		rawEvents: [],
		error: null,
	});
}

function proposalAdapter(proposal: CandidateProposal): BuilderAdapter {
	return {
		backend: "structured-authoring-test",
		capabilities: CAPABILITIES,
		probe: async () => ({
			backend: "structured-authoring-test",
			available: true,
			version: "1.0.0",
			capabilities: CAPABILITIES,
			error: null,
		}),
		run: async (request) => completedRecord(request, proposal),
	};
}

describe("structured harness authoring", () => {
	it("derives paths, hashes, manifest mutations, descriptors, and executable modes", () => {
		const { repositoryDir, baseSha } = initTarget();
		const proposal = compileHarnessAuthoringProposal({
			repositoryDir,
			summary: "Add focused harness resources",
			diagnoses: [{ failureIds: ["failure-1"], evidence: ["trace:1"], rootCause: "Missing workflow" }],
			risks: ["The workflow may be too narrow"],
			validationPlan: ["Run development tasks"],
			intents: [
				{ type: "instructions.replace", content: "# New instructions" },
				{
					type: "skill.upsert",
					name: "triage-case",
					description: "Triage a support case.",
					body: "# Triage\n\nInspect the evidence first.\n",
				},
				{
					type: "tool.upsert",
					name: "lookup_case",
					descriptor: descriptor(),
					executable: "#!/bin/sh\nprintf '{\"ok\":true}\\n'\n",
				},
			],
		});

		expect(proposal.baseTargetSha).toBe(baseSha);
		expect(proposal.decision).toBe("propose");
		expect(proposal.changes.map((change) => change.path)).toEqual([
			"AGENTS.md",
			"bin/lookup_case",
			"manifest.yaml",
			"skills/triage-case/SKILL.md",
			"tools/lookup_case.tool.yaml",
		]);
		expect(proposal.changes.find((change) => change.path === "bin/lookup_case")?.unifiedDiff)
			.toContain("new file mode 100755");
		expect(proposal.changes.find((change) => change.path === "tools/lookup_case.tool.yaml")?.unifiedDiff)
			.toContain("+  argv:\n+    - bin/lookup_case\n+    - --json");
		expect(proposal.changes.every((change) => change.evidenceRefs[0] === "trace:1")).toBe(true);
	});

	it("compiles removals from names and deletes both halves of a canonical tool", () => {
		const { repositoryDir } = initTarget(true);
		const proposal = compileHarnessAuthoringProposal({
			repositoryDir,
			summary: "Remove unused resources",
			intents: [
				{ type: "skill.remove", name: "existing-skill" },
				{ type: "tool.remove", name: "existing_tool" },
			],
		});

		expect(proposal.changes.map((change) => change.path)).toEqual([
			"bin/existing_tool",
			"manifest.yaml",
			"skills/existing-skill/SKILL.md",
			"tools/existing_tool.tool.yaml",
		]);
		for (const path of ["bin/existing_tool", "skills/existing-skill/SKILL.md", "tools/existing_tool.tool.yaml"]) {
			expect(proposal.changes.find((change) => change.path === path)?.unifiedDiff).toContain("+++ /dev/null");
		}
	});

	it("returns no-change for an exact idempotent instructions replacement", () => {
		const { repositoryDir } = initTarget();
		const proposal = compileHarnessAuthoringProposal({
			repositoryDir,
			summary: "Keep the existing instructions",
			intents: [{ type: "instructions.replace", content: "# Old instructions\n" }],
		});
		expect(proposal).toMatchObject({ decision: "no-change", changes: [] });
	});

	it("rejects structural path injection, ambiguous intents, dirty bases, and policy escalation", () => {
		expect(HarnessAuthoringIntentSchema.safeParse({
			type: "skill.remove",
			name: "safe-name",
			path: "package.json",
		}).success).toBe(false);
		expect(HarnessAuthoringIntentSchema.safeParse({ type: "skill.remove", name: "../escape" }).success).toBe(false);

		const duplicate = initTarget();
		expect(() => compileHarnessAuthoringProposal({
			repositoryDir: duplicate.repositoryDir,
			summary: "Conflicting edits",
			intents: [
				{ type: "instructions.replace", content: "first" },
				{ type: "instructions.replace", content: "second" },
			],
		})).toThrow(/conflicting or duplicate/);

		const escalation = initTarget();
		expect(() => compileHarnessAuthoringProposal({
			repositoryDir: escalation.repositoryDir,
			summary: "Escalate a tool",
			intents: [{
				type: "tool.upsert",
				name: "lookup_case",
				descriptor: {
					...descriptor(),
					permissions: { environment: ["SECRET"], network: "allow", filesystem: "read-only" },
				},
				executable: "#!/bin/sh\nprintf '{}\\n'\n",
			}],
		})).toThrow(/environment SECRET is not allowed|network=allow exceeds/);

		const dirty = initTarget();
		writeFileSync(join(dirty.repositoryDir, "package.json"), "{}\n");
		expect(() => compileHarnessAuthoringProposal({
			repositoryDir: dirty.repositoryDir,
			summary: "Do not absorb unrelated files",
			intents: [{ type: "instructions.replace", content: "new" }],
		})).toThrow(/clean repository/);
	});

	it("survives persistence and application through the existing proposal machinery", async () => {
		const { repositoryDir, baseSha } = initTarget();
		const runsRoot = temporaryRoot("ahde-harness-authoring-runs-");
		const proposal = compileHarnessAuthoringProposal({
			repositoryDir,
			summary: "Install a structured workflow",
			intents: [
				{ type: "instructions.replace", content: "# Precise instructions" },
				{
					type: "skill.upsert",
					name: "triage-case",
					description: "Triage a support case.",
					body: "# Triage\n\nInspect the evidence first.\n",
					disableModelInvocation: true,
				},
				{
					type: "tool.upsert",
					name: "lookup_case",
					descriptor: { ...descriptor(), arguments: [] },
					executable: "#!/bin/sh\nIFS= read -r payload || exit 2\nprintf '%s\\n' \"$payload\"\n",
				},
			],
		});
		const runId = "structured-authoring-apply";
		await runBuilderProposal({
			adapter: proposalAdapter(proposal),
			baseTargetSha: baseSha,
			allowedPaths: [...HARNESS_AUTHORING_ALLOWED_PATHS],
			failureBundle: "Evidence-backed structured authoring fixture",
			runsRoot,
			timeoutMs: 2_000,
			runId,
		}, { now: () => NOW });

		const applied = applyBuilderProposal({
			repoDir: repositoryDir,
			runsRoot,
			runId,
			requestedBranch: "candidate/structured-authoring",
			actor: { kind: "human", id: "operator" },
			reason: "Apply the reviewed structured proposal",
		}, { now: () => NOW });

		expect(applied.receipt.baseTargetSha).toBe(baseSha);
		expect(git(repositoryDir, ["show", "candidate/structured-authoring:AGENTS.md"])).toBe("# Precise instructions");
		expect(git(repositoryDir, ["ls-tree", "candidate/structured-authoring", "--", "bin/lookup_case"]))
			.toMatch(/^100755 blob [0-9a-f]{40}\tbin\/lookup_case$/);
		const appliedManifest = parseYaml(git(repositoryDir, ["show", "candidate/structured-authoring:manifest.yaml"])) as {
			skills: string[];
			tools: string[];
		};
		expect(appliedManifest.skills).toEqual(["skills/triage-case"]);
		expect(appliedManifest.tools).toEqual(["tools/lookup_case.tool.yaml"]);
		expect(git(repositoryDir, ["show", "candidate/structured-authoring:skills/triage-case/SKILL.md"]))
			.toContain("disable-model-invocation: true");
		expect(readFileSync(join(runsRoot, "builders", runId, "proposal.json"), "utf8"))
			.toContain("tools/lookup_case.tool.yaml");
	});
});
