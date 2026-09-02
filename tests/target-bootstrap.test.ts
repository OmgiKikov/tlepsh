import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	configureTargetBootstrap,
	describeTargetBootstrap,
	loadTargetBootstrapReceipt,
	type ConfigureTargetBootstrapOptions,
} from "../src/application/target-bootstrap.js";
import { loadTarget, scaffoldTarget, type TargetManifest } from "../src/manifest.js";
import { canonicalJson } from "../src/provenance.js";

const NOW = "2026-08-26T16:00:00.000Z";
const cleanupPaths: string[] = [];

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function fullModel(overrides: Record<string, unknown> = {}): TargetManifest["model"] {
	return {
		provider: "openai-compatible",
		id: "qwen3.5-27b",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9901/v1",
		apiKeyEnv: "TARGET_MODEL_API_KEY",
		thinkingLevel: "off",
		timeoutMs: 120_000,
		params: {},
		spec: {
			reasoning: false,
			contextWindow: 131_072,
			maxTokens: 8_192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: {},
		},
		...overrides,
	} as TargetManifest["model"];
}

interface Fixture {
	targetDir: string;
	stateRoot: string;
	runsRoot: string;
	baseSha: string;
	baseManifest: string;
}

function fixture(): Fixture {
	const parent = mkdtempSync(join(tmpdir(), "ahde-target-bootstrap-"));
	cleanupPaths.push(parent);
	const targetDir = join(parent, "target");
	scaffoldTarget(resolve("templates/basic-agent"), targetDir);
	return {
		targetDir,
		stateRoot: join(targetDir, ".ahde"),
		runsRoot: join(targetDir, "runs"),
		baseSha: git(targetDir, "rev-parse", "HEAD"),
		baseManifest: readFileSync(join(targetDir, "manifest.yaml"), "utf8"),
	};
}

function options(value: Fixture, overrides: Partial<ConfigureTargetBootstrapOptions> = {}): ConfigureTargetBootstrapOptions {
	return {
		targetDir: value.targetDir,
		stateRoot: value.stateRoot,
		runsRoot: value.runsRoot,
		targetId: "support-agent",
		model: fullModel(),
		expectedSubjectHash: `sha256:${"0".repeat(64)}`,
		actor: { kind: "human", id: "operator-1" },
		reason: "Reviewed the exact initial Target configuration",
		...overrides,
	};
}

/** Rewrite the scaffold's manifest and keep the one-commit clean scaffold shape. */
function amendManifest(value: Fixture, content: string): void {
	writeFileSync(join(value.targetDir, "manifest.yaml"), content);
	git(value.targetDir, "add", "manifest.yaml");
	git(value.targetDir, "-c", "user.name=Manual", "-c", "user.email=manual@example.test", "commit", "--amend", "--no-edit", "--no-gpg-sign");
}

function configured(value: Fixture, overrides: Partial<ConfigureTargetBootstrapOptions> = {}) {
	const request = options(value, overrides);
	const subject = describeTargetBootstrap(request);
	return configureTargetBootstrap(
		{ ...request, expectedSubjectHash: subject.subjectHash },
		{ now: () => NOW },
	);
}

describe("Target bootstrap application service", () => {
	it("describes and commits exactly one host-confirmed initial configuration with a private receipt", () => {
		const value = fixture();
		const before = loadTarget(value.targetDir).manifest;
		const request = options(value);
		const subject = describeTargetBootstrap(request);

		expect(subject).toMatchObject({
			baseTargetSha: value.baseSha,
			previous: {
				targetId: "my-agent",
				evalSuiteId: "my-agent-development",
			},
			next: {
				targetId: "support-agent",
				evalSuiteId: "support-agent-development",
				model: { id: "qwen3.5-27b", apiKeyEnv: "TARGET_MODEL_API_KEY" },
			},
		});
		expect(subject.previous.manifestSha256).not.toBe(subject.next.manifestSha256);
		expect(subject.unifiedDiff).toContain("diff --git a/manifest.yaml b/manifest.yaml");
		expect(subject.unifiedDiff).toContain("+id: support-agent");

		const result = configureTargetBootstrap(
			{ ...request, expectedSubjectHash: subject.subjectHash },
			{ now: () => NOW },
		);
		const after = loadTarget(value.targetDir).manifest;

		expect(after.id).toBe("support-agent");
		expect(after.model).toEqual(fullModel());
		expect(after.evalSuite.id).toBe("support-agent-development");
		for (const field of ["execution", "instructions", "skills", "tools"] as const) {
			expect(canonicalJson(after[field])).toBe(canonicalJson(before[field]));
		}
		expect(canonicalJson({ ...after.evalSuite, id: undefined })).toBe(
			canonicalJson({ ...before.evalSuite, id: undefined }),
		);

		expect(result.receipt).toMatchObject({
			subject,
			baseTargetSha: value.baseSha,
			actor: { kind: "human", id: "operator-1" },
			reason: request.reason,
			configuredAt: NOW,
		});
		expect(loadTargetBootstrapReceipt(value.stateRoot)).toEqual(result.receipt);
		expect(statSync(result.receiptPath).mode & 0o777).toBe(0o600);
		expect(git(value.targetDir, "rev-parse", `${result.receipt.configuredTargetSha}^`)).toBe(value.baseSha);
		expect(git(value.targetDir, "diff-tree", "--no-commit-id", "--name-only", "-r", result.receipt.configuredTargetSha)).toBe("manifest.yaml");
		expect(git(value.targetDir, "show", "-s", "--format=%an <%ae>", result.receipt.configuredTargetSha)).toBe(
			"AHDE Bootstrap <bootstrap@ahde.local>",
		);
		expect(git(value.targetDir, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
		expect(readFileSync(result.receiptPath, "utf8")).not.toContain("sk-");
	});

	it("refuses replay after the immutable receipt exists", () => {
		const value = fixture();
		const result = configured(value);

		expect(() => configureTargetBootstrap({
			...options(value),
			expectedSubjectHash: result.subject.subjectHash,
		}, { now: () => NOW })).toThrow(/receipt already exists|replay refused/);
		expect(() => describeTargetBootstrap(options(value))).toThrow(/receipt already exists|replay refused/);
	});

	it("refuses a stale subject without changing the scaffold", () => {
		const value = fixture();
		const reviewed = describeTargetBootstrap(options(value));
		const changedRequest = options(value, { targetId: "different-agent" });

		expect(() => configureTargetBootstrap({
			...changedRequest,
			expectedSubjectHash: reviewed.subjectHash,
		}, { now: () => NOW })).toThrow(/confirmation is stale/);
		expect(git(value.targetDir, "rev-parse", "HEAD")).toBe(value.baseSha);
		expect(readFileSync(join(value.targetDir, "manifest.yaml"), "utf8")).toBe(value.baseManifest);
		expect(git(value.targetDir, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
	});

	it("refuses a clean one-commit target whose placeholders were already edited manually", () => {
		const value = fixture();
		const manuallyEdited = value.baseManifest
			.replace("id: my-agent", "id: manual-agent")
			.replace("id: replace-with-model-id", "id: manual-model")
			.replace("id: my-agent-development", "id: manual-agent-development");
		amendManifest(value, manuallyEdited);

		expect(() => describeTargetBootstrap(options(value))).toThrow(/built-in id\/model placeholders/);
	});

	it("accepts a template that still writes REPLACE-ME where its identity and model belong", () => {
		// The RU support-agent shape: not the built-in block byte for byte, and
		// just as much "nobody has chosen a model yet". Refusing it is what used to
		// send the operator into manifest.yaml by hand.
		const value = fixture();
		amendManifest(value, value.baseManifest
			.replace("id: my-agent\n", "id: replace-me-agent\n")
			.replace("id: my-agent-development", "id: replace-me-agent-development")
			.replace("provider: openai-compatible", "provider: REPLACE-ME-provider")
			.replace("id: replace-with-model-id", "id: REPLACE-ME-model-id")
			.replace("baseUrl: http://127.0.0.1:1234/v1", "baseUrl: https://REPLACE-ME/api/v1")
			.replace("apiKeyEnv: AHDE_MODEL_API_KEY", "apiKeyEnv: REPLACE_ME_API_KEY"));

		const subject = describeTargetBootstrap(options(value));
		expect(subject.previous).toMatchObject({
			targetId: "replace-me-agent",
			evalSuiteId: "replace-me-agent-development",
		});

		configureTargetBootstrap(
			{ ...options(value), expectedSubjectHash: subject.subjectHash },
			{ now: () => NOW },
		);
		const after = loadTarget(value.targetDir).manifest;
		expect(after.id).toBe("support-agent");
		expect(after.model).toEqual(fullModel());
		expect(after.evalSuite.id).toBe("support-agent-development");
		expect(git(value.targetDir, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
	});

	it("refuses a stand-in as the model it is about to write", () => {
		// The chosen model comes from the host catalog: a REPLACE-ME here would be
		// a bug upstream, and committing it writes a manifest that is unconfigured
		// the moment it lands.
		const value = fixture();
		for (const override of [
			{ provider: "REPLACE-ME-provider" },
			{ id: "REPLACE-ME-model-id" },
			{ baseUrl: "https://REPLACE-ME/api/v1" },
			{ apiKeyEnv: "REPLACE_ME_API_KEY" },
		]) {
			expect(() => describeTargetBootstrap(options(value, { model: fullModel(override) })), JSON.stringify(override))
				.toThrow(/REPLACE-ME stand-ins/);
		}
		expect(git(value.targetDir, "rev-parse", "HEAD")).toBe(value.baseSha);
	});

	it("refuses dirty repositories before producing an approval subject", () => {
		const value = fixture();
		writeFileSync(join(value.targetDir, "notes.txt"), "uncommitted user work\n");

		expect(() => describeTargetBootstrap(options(value))).toThrow(/clean repository/);
		expect(git(value.targetDir, "status", "--porcelain=v1", "--untracked-files=all")).toContain("notes.txt");
	});

	it.each([
		["eval", (value: Fixture) => {
			const dir = join(value.runsRoot, "erun_existing");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "eval_run.json"), JSON.stringify({ target: { id: "my-agent", gitSha: value.baseSha } }));
		}],
		["Builder apply", (value: Fixture) => {
			const dir = join(value.runsRoot, "builders", "builder-existing");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "apply_receipt.json"), JSON.stringify({
				baseTargetSha: value.baseSha,
				candidateSha: "1".repeat(40),
			}));
		}],
		["Candidate", (value: Fixture) => {
			const dir = join(value.runsRoot, "candidates", "candidate-existing");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "candidate.json"), JSON.stringify({
				targetId: "my-agent",
				baseline: { sha: value.baseSha },
			}));
		}],
	] as const)("refuses once %s evidence exists for the scaffold", (_label, publishEvidence) => {
		const value = fixture();
		publishEvidence(value);

		expect(() => describeTargetBootstrap(options(value))).toThrow(/evidence already exists/);
	});

	it("rolls the single manifest commit back when receipt publication fails", () => {
		const value = fixture();
		const request = options(value);
		const subject = describeTargetBootstrap(request);

		expect(() => configureTargetBootstrap({
			...request,
			expectedSubjectHash: subject.subjectHash,
		}, {
			now: () => NOW,
			writeReceipt: () => {
				throw new Error("simulated receipt failure");
			},
		})).toThrow(/simulated receipt failure/);

		expect(git(value.targetDir, "rev-parse", "HEAD")).toBe(value.baseSha);
		expect(readFileSync(join(value.targetDir, "manifest.yaml"), "utf8")).toBe(value.baseManifest);
		expect(git(value.targetDir, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
		expect(() => loadTargetBootstrapReceipt(value.stateRoot)).toThrow(/does not exist/);
	});

	it("requires a complete model and rejects embedded credential values", () => {
		const value = fixture();
		const incomplete = { ...fullModel() } as Record<string, unknown>;
		delete incomplete.spec;
		expect(() => describeTargetBootstrap(options(value, { model: incomplete }))).toThrow(/model must be complete/);

		expect(() => describeTargetBootstrap(options(value, {
			model: fullModel({ params: { api_key: "sk-secret" } }),
		}))).toThrow(/credential value field/);
		expect(() => describeTargetBootstrap(options(value, {
			model: fullModel({ baseUrl: "https://user:password@example.test/v1" }),
		}))).toThrow(/cannot contain credentials/);
	});

	it("refuses a pre-existing receipt path before configuration", () => {
		const value = fixture();
		mkdirSync(value.stateRoot, { recursive: true, mode: 0o700 });
		const path = join(value.stateRoot, "target-bootstrap.json");
		writeFileSync(path, "{}\n", { mode: 0o600 });
		chmodSync(path, 0o600);

		expect(() => describeTargetBootstrap(options(value))).toThrow(/receipt already exists|replay refused/);
	});
});
