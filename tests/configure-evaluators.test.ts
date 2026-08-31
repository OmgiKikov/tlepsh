import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	configureEvaluators,
	describeEvaluatorConfiguration,
	EvaluatorConfigurationReceiptSchema,
	evaluatorReadiness,
	sameModelAsTarget,
} from "../src/application/configure-evaluators.js";
import { resolveTargetModelSelection } from "../src/application/target-model-selection.js";
import { configureTargetBootstrap, describeTargetBootstrap } from "../src/application/target-bootstrap.js";
import { loadTarget, scaffoldTarget, type TargetManifest } from "../src/manifest.js";
import { readJsonArtifact } from "../src/storage/artifacts.js";
import { AhdeWorkbench } from "../src/workbench/workbench.js";
import type { WorkbenchConfirmation, WorkbenchHumanGate } from "../src/workbench/types.js";

const NOW = "2026-08-31T09:00:00.000Z";
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

/** One exact host-catalog model, in the shape `modelRegistry.find` returns. */
function hostModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		provider: "fixture-provider",
		id: "fixture-judge",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:43199/v1",
		reasoning: false,
		input: ["text"],
		contextWindow: 32_768,
		maxTokens: 4_096,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		compat: {},
		...overrides,
	};
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
	projectDir: string;
	baseSha: string;
	baseManifest: string;
}

/** A configured Target: the scaffold, bootstrapped, with a real model and no evaluators. */
function fixture(): Fixture {
	const parent = mkdtempSync(join(tmpdir(), "ahde-configure-evaluators-"));
	cleanupPaths.push(parent);
	const targetDir = join(parent, "target");
	scaffoldTarget(resolve("templates/basic-agent"), targetDir);
	const stateRoot = join(targetDir, ".ahde");
	const runsRoot = join(targetDir, "runs");
	const bootstrap = {
		targetDir,
		stateRoot,
		runsRoot,
		targetId: "support-agent",
		model: fullModel(),
	};
	const subject = describeTargetBootstrap(bootstrap);
	configureTargetBootstrap({
		...bootstrap,
		expectedSubjectHash: subject.subjectHash,
		actor: { kind: "human", id: "operator-1" },
		reason: "fixture",
	}, { now: () => NOW });
	return {
		targetDir,
		stateRoot,
		runsRoot,
		projectDir: parent,
		baseSha: git(targetDir, "rev-parse", "HEAD"),
		baseManifest: readFileSync(join(targetDir, "manifest.yaml"), "utf8"),
	};
}

/** Exactly the resolution `configure-target` performs, for an evaluator role. */
function resolved(apiKeyEnv: string, overrides: Record<string, unknown> = {}): TargetManifest["model"] {
	const model = hostModel(overrides);
	return resolveTargetModelSelection(
		{ provider: model.provider, modelId: model.id },
		model as never,
		{ apiKeyEnv },
	);
}

describe("resolving evaluator models through the host catalog", () => {
	it("materializes endpoint, limits and pricing from the catalog, and names the credential", () => {
		const judge = resolved("TEST_JUDGE_KEY");
		expect(judge).toMatchObject({
			provider: "fixture-provider",
			id: "fixture-judge",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:43199/v1",
			apiKeyEnv: "TEST_JUDGE_KEY",
		});
		expect(judge.spec.contextWindow).toBe(32_768);
		expect(judge.spec.maxTokens).toBe(4_096);
		expect(judge.spec.cost).toMatchObject({ input: 1, output: 2 });
		// The variable NAME is the only credential-shaped thing in the block.
		expect(JSON.stringify(judge)).not.toContain("sk-");
	});

	it("shows the exact non-secret manifest diff and changes only the evaluator blocks", () => {
		const value = fixture();
		const subject = describeEvaluatorConfiguration({
			targetDir: value.targetDir,
			stateRoot: value.stateRoot,
			judge: resolved("TEST_JUDGE_KEY"),
			simulatedUser: resolved("TEST_USER_KEY", { id: "fixture-user" }),
		});
		expect(subject.previous.judge).toBeNull();
		expect(subject.previous.simulatedUser).toBeNull();
		expect(subject.next.judge).toMatchObject({ id: "fixture-judge", apiKeyEnv: "TEST_JUDGE_KEY" });
		expect(subject.next.simulatedUser).toMatchObject({ id: "fixture-user", apiKeyEnv: "TEST_USER_KEY" });
		expect(subject.unifiedDiff).toContain("diff --git a/manifest.yaml b/manifest.yaml");
		expect(subject.unifiedDiff).toContain("+    apiKeyEnv: TEST_JUDGE_KEY");
		// The diff names variables and never holds a value.
		expect(subject.unifiedDiff).not.toMatch(/apiKey:|token:|secret:/i);
		// Describing writes nothing.
		expect(readFileSync(join(value.targetDir, "manifest.yaml"), "utf8")).toBe(value.baseManifest);
		expect(git(value.targetDir, "rev-parse", "HEAD")).toBe(value.baseSha);
	});

	it("refuses a judge that is the Target's own model", () => {
		const value = fixture();
		const target = loadTarget(value.targetDir).manifest.model;
		expect(sameModelAsTarget(target, { provider: target.provider, id: target.id })).toBe(true);
		expect(() => describeEvaluatorConfiguration({
			targetDir: value.targetDir,
			stateRoot: value.stateRoot,
			judge: resolved("TEST_JUDGE_KEY", { provider: target.provider, id: target.id }),
		})).toThrow(/is the Target's own model/);
		// The same model is fine for the user side: the simulated user never
		// grades anything, it only talks.
		expect(() => describeEvaluatorConfiguration({
			targetDir: value.targetDir,
			stateRoot: value.stateRoot,
			simulatedUser: resolved("TEST_USER_KEY", { provider: target.provider, id: target.id }),
		})).not.toThrow();
	});

	it("refuses a credential VALUE, an empty change, and a dirty repository", () => {
		const value = fixture();
		expect(() => describeEvaluatorConfiguration({
			targetDir: value.targetDir,
			stateRoot: value.stateRoot,
			judge: { ...resolved("TEST_JUDGE_KEY"), apiKey: "sk-not-a-name" },
		})).toThrow(/credential value field/);
		expect(() => describeEvaluatorConfiguration({
			targetDir: value.targetDir,
			stateRoot: value.stateRoot,
		})).toThrow(/needs a judge, a simulated user, or both/);
		writeFileSync(join(value.targetDir, "AGENTS.md"), "dirty\n");
		expect(() => describeEvaluatorConfiguration({
			targetDir: value.targetDir,
			stateRoot: value.stateRoot,
			judge: resolved("TEST_JUDGE_KEY"),
		})).toThrow(/requires a clean repository/);
	});
});

describe("committing the evaluator configuration", () => {
	it("commits exactly manifest.yaml, publishes a private receipt, and loads back", () => {
		const value = fixture();
		const options = {
			targetDir: value.targetDir,
			stateRoot: value.stateRoot,
			judge: resolved("TEST_JUDGE_KEY"),
			simulatedUser: resolved("TEST_USER_KEY", { id: "fixture-user" }),
		};
		const subject = describeEvaluatorConfiguration(options);
		const result = configureEvaluators({
			...options,
			expectedSubjectHash: subject.subjectHash,
			actor: { kind: "human", id: "operator-1" },
			reason: "set up the judge and the user model",
		}, { now: () => NOW });

		expect(result.manifest.evalSuite.judge).toMatchObject({ id: "fixture-judge", apiKeyEnv: "TEST_JUDGE_KEY" });
		expect(result.manifest.evalSuite.simulatedUser).toMatchObject({ id: "fixture-user" });
		expect(git(value.targetDir, "rev-parse", "HEAD^")).toBe(value.baseSha);
		expect(git(value.targetDir, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe("manifest.yaml");
		expect(git(value.targetDir, "status", "--porcelain=v1")).toBe("");
		// The committed manifest is the one the human approved, and it loads.
		expect(loadTarget(value.targetDir).manifest.evalSuite.judge?.apiKeyEnv).toBe("TEST_JUDGE_KEY");

		expect(statSync(result.receiptPath).mode & 0o777).toBe(0o600);
		const receipt = readJsonArtifact(result.receiptPath, EvaluatorConfigurationReceiptSchema);
		expect(receipt.id).toBe(result.receipt.id);
		expect(receipt.configuredTargetSha).toBe(git(value.targetDir, "rev-parse", "HEAD"));
		expect(receipt.subject.subjectHash).toBe(subject.subjectHash);
		expect(JSON.stringify(receipt)).not.toContain("sk-");
	});

	it("refuses a stale confirmation and leaves the repository exactly as it was", () => {
		const value = fixture();
		expect(() => configureEvaluators({
			targetDir: value.targetDir,
			stateRoot: value.stateRoot,
			judge: resolved("TEST_JUDGE_KEY"),
			expectedSubjectHash: `sha256:${"0".repeat(64)}`,
			actor: { kind: "human", id: "operator-1" },
			reason: "stale",
		}, { now: () => NOW })).toThrow(/confirmation is stale/);
		expect(git(value.targetDir, "rev-parse", "HEAD")).toBe(value.baseSha);
		expect(readFileSync(join(value.targetDir, "manifest.yaml"), "utf8")).toBe(value.baseManifest);
		expect(existsSync(join(value.stateRoot, "evaluators"))).toBe(false);
	});

	it("narrowly rolls back its own commit when receipt publication fails", () => {
		const value = fixture();
		const options = {
			targetDir: value.targetDir,
			stateRoot: value.stateRoot,
			judge: resolved("TEST_JUDGE_KEY"),
		};
		const subject = describeEvaluatorConfiguration(options);
		expect(() => configureEvaluators({
			...options,
			expectedSubjectHash: subject.subjectHash,
			actor: { kind: "human", id: "operator-1" },
			reason: "receipt failure",
		}, {
			now: () => NOW,
			writeReceipt: () => { throw new Error("receipt store unavailable"); },
		})).toThrow(/receipt store unavailable/);

		expect(git(value.targetDir, "rev-parse", "HEAD")).toBe(value.baseSha);
		expect(git(value.targetDir, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
		expect(readFileSync(join(value.targetDir, "manifest.yaml"), "utf8")).toBe(value.baseManifest);
		expect(existsSync(join(value.stateRoot, ".configure-evaluators.lock"))).toBe(false);
	});

	it("replaces one block later without touching the other, and keeps the calibration policy", () => {
		const value = fixture();
		const first = {
			targetDir: value.targetDir,
			stateRoot: value.stateRoot,
			judge: resolved("TEST_JUDGE_KEY"),
			simulatedUser: resolved("TEST_USER_KEY", { id: "fixture-user" }),
		};
		configureEvaluators({
			...first,
			expectedSubjectHash: describeEvaluatorConfiguration(first).subjectHash,
			actor: { kind: "human", id: "operator-1" },
			reason: "first",
		}, { now: () => NOW });

		// The operator adds a promotion bar by hand; swapping the judge model must
		// not quietly lift it.
		const manifestPath = join(value.targetDir, "manifest.yaml");
		writeFileSync(
			manifestPath,
			readFileSync(manifestPath, "utf8").replace(
				"    apiKeyEnv: TEST_JUDGE_KEY\n",
				"    apiKeyEnv: TEST_JUDGE_KEY\n    requireCalibration:\n      minAgreement: 0.8\n      minLabels: 20\n",
			),
		);
		git(value.targetDir, "add", "manifest.yaml");
		git(value.targetDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "policy");

		const second = {
			targetDir: value.targetDir,
			stateRoot: value.stateRoot,
			judge: resolved("TEST_JUDGE_KEY", { id: "fixture-judge-v2" }),
		};
		const result = configureEvaluators({
			...second,
			expectedSubjectHash: describeEvaluatorConfiguration(second).subjectHash,
			actor: { kind: "human", id: "operator-1" },
			reason: "swap the judge",
		}, { now: () => NOW });
		expect(result.manifest.evalSuite.judge).toMatchObject({
			id: "fixture-judge-v2",
			requireCalibration: { minAgreement: 0.8, minLabels: 20 },
		});
		// The user model the first decision wrote is untouched.
		expect(result.manifest.evalSuite.simulatedUser).toMatchObject({ id: "fixture-user" });
	});
});

describe("the configure-evaluators decision", () => {
	function workbench(value: Fixture): AhdeWorkbench {
		return new AhdeWorkbench({
			projectDir: value.targetDir,
			stateRoot: value.stateRoot,
			runsRoot: value.runsRoot,
			dependencies: { now: () => NOW },
		});
	}

	function gate(seen: WorkbenchConfirmation[]): WorkbenchHumanGate {
		return {
			confirm: async (confirmation) => {
				seen.push(confirmation);
				return { approved: true, actorId: "operator-1" };
			},
			selectSealed: async () => ({ approved: false }),
		};
	}

	it("asks the human with the exact diff, then commits what they approved", async () => {
		const value = fixture();
		const seen: WorkbenchConfirmation[] = [];
		// The host resolves; the Builder only ever names a provider and a model id.
		const resolveEvaluatorModel = vi.fn((role: "judge" | "simulatedUser") =>
			resolved(role === "judge" ? "TEST_JUDGE_KEY" : "TEST_USER_KEY", role === "judge" ? {} : { id: "fixture-user" }));

		const result = await workbench(value).decide(
			{
				kind: "configure-evaluators",
				judge: { provider: "fixture-provider", modelId: "fixture-judge" },
				simulatedUser: { provider: "fixture-provider", modelId: "fixture-user" },
				reason: "the basket needs a judge grader",
			},
			gate(seen),
			{ resolveEvaluatorModel },
		);

		expect(seen).toHaveLength(1);
		expect(seen[0]?.policy).toBe("consequential");
		const subject = seen[0]?.subject as { unifiedDiff: string };
		expect(subject.unifiedDiff).toContain("+    apiKeyEnv: TEST_JUDGE_KEY");
		expect(result.result.configured).toEqual([
			{ role: "judge", model: "fixture-provider/fixture-judge", credentialEnv: "TEST_JUDGE_KEY" },
			{ role: "simulatedUser", model: "fixture-provider/fixture-user", credentialEnv: "TEST_USER_KEY" },
		]);
		expect(result.result.targetGitSha).toBe(git(value.targetDir, "rev-parse", "HEAD"));
		// The credential NAME is never chosen by the model: the decision input
		// carries a provider and a model id and nothing else.
		expect(JSON.stringify({ judge: { provider: "fixture-provider", modelId: "fixture-judge" } }))
			.not.toContain("TEST_JUDGE_KEY");
		// The view now knows the suite has both evaluators.
		expect(result.view.target.evaluators).toMatchObject({
			judge: { provider: "fixture-provider", id: "fixture-judge", apiKeyEnv: "TEST_JUDGE_KEY" },
			simulatedUser: { provider: "fixture-provider", id: "fixture-user" },
		});
	});

	it("refuses without the trusted host catalog, and refuses a judge equal to the Target model", async () => {
		const value = fixture();
		const seen: WorkbenchConfirmation[] = [];
		await expect(workbench(value).decide(
			{ kind: "configure-evaluators", judge: { provider: "fixture-provider", modelId: "fixture-judge" }, reason: "no host" },
			gate(seen),
		)).rejects.toThrow(/trusted host model catalog/);

		const target = loadTarget(value.targetDir).manifest.model;
		await expect(workbench(value).decide(
			{ kind: "configure-evaluators", judge: { provider: target.provider, modelId: target.id }, reason: "twin" },
			gate(seen),
			{ resolveEvaluatorModel: () => resolved("TEST_JUDGE_KEY", { provider: target.provider, id: target.id }) },
		)).rejects.toThrow(/is the Target's own model/);
		// Neither refusal asked a human, and neither touched the repository.
		expect(seen).toHaveLength(0);
		expect(git(value.targetDir, "rev-parse", "HEAD")).toBe(value.baseSha);
	});
});

describe("ahde validate evaluator readiness", () => {
	it("names each evaluator, its key, and whether this machine has it", () => {
		const value = fixture();
		const before = evaluatorReadiness(loadTarget(value.targetDir).manifest, {});
		expect(before.map((entry) => entry.line)).toEqual([
			"judge: not configured",
			"simulatedUser: not configured",
		]);

		const options = {
			targetDir: value.targetDir,
			stateRoot: value.stateRoot,
			judge: resolved("TEST_JUDGE_KEY"),
		};
		configureEvaluators({
			...options,
			expectedSubjectHash: describeEvaluatorConfiguration(options).subjectHash,
			actor: { kind: "human", id: "operator-1" },
			reason: "judge",
		}, { now: () => NOW });

		const manifest = loadTarget(value.targetDir).manifest;
		expect(evaluatorReadiness(manifest, { TEST_JUDGE_KEY: "value" })[0]?.line)
			.toBe("judge: configured · fixture-provider/fixture-judge · key TEST_JUDGE_KEY set");
		expect(evaluatorReadiness(manifest, {})[0]?.line)
			.toBe("judge: configured · fixture-provider/fixture-judge · key TEST_JUDGE_KEY MISSING");
		expect(evaluatorReadiness(manifest, {})[0]?.credentialPresent).toBe(false);
	});
});
