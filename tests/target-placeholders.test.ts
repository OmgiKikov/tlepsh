import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { plural, setLanguage, t } from "../src/i18n.js";
import {
	assertEvaluatorsConfigured,
	executionKindOf,
	harnessFilesOf,
	loadTarget,
	missingEvaluatorCases,
	scaffoldTarget,
	TargetManifest,
} from "../src/manifest.js";
import {
	isStandIn,
	isStandInModel,
	MAX_STAND_IN_FILES,
	standInFilesLine,
	standInManifestFields,
	standInTargetFiles,
} from "../src/target/placeholders.js";
import { inspectTargetReadiness, STARTER_MODEL_ID, targetBootstrapRequired } from "../src/target/readiness.js";
import { deriveWorkbenchView, loadWorkbenchInventory } from "../src/workbench/inventory.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

const SUPPORT_TEMPLATE = resolve("templates/support-agent");
const PYTHON_TEMPLATE = resolve("templates/python-agent");
/** Exactly the files the shipped RU template still leaves for the Builder. */
const SUPPORT_TEMPLATE_STAND_INS = [
	"AGENTS.md",
	"spec.md",
	"bin/check_account",
	"evals/development.jsonl",
	"tools/check_account.tool.yaml",
];

const roots: string[] = [];
const fixtures: string[] = [];

function harness(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "ahde-stand-ins-"));
	roots.push(dir);
	for (const [relativePath, content] of Object.entries(files)) {
		const path = join(dir, relativePath);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content, "utf8");
	}
	return dir;
}

afterEach(() => {
	setLanguage(null);
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
	for (const path of fixtures.splice(0)) cleanup(path);
});

const REAL_MODEL: TargetManifest["model"] = {
	provider: "openai-compatible",
	id: "qwen3.5-27b",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:9901/v1",
	apiKeyEnv: "TARGET_MODEL_API_KEY",
	thinkingLevel: "off",
	timeoutMs: 300_000,
	params: {},
	spec: {
		reasoning: false,
		contextWindow: 131_072,
		maxTokens: 8_192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {},
	},
};

/** The three parts of a model block that decide whether it can be called. */
const REAL_ENDPOINT = { provider: REAL_MODEL.provider, id: REAL_MODEL.id, baseUrl: REAL_MODEL.baseUrl };

/** The judge block the RU template used to ship: a shape, not a judge. */
const STAND_IN_JUDGE = {
	provider: "REPLACE-ME-provider",
	id: "REPLACE-ME-judge-model-id",
	api: "openai-completions",
	baseUrl: "https://REPLACE-ME/api/v1",
	apiKeyEnv: "REPLACE_ME_API_KEY",
	thinkingLevel: "high",
	timeoutMs: 600_000,
} as const;

const REAL_JUDGE = { ...STAND_IN_JUDGE, provider: "anthropic", id: "claude-judge", baseUrl: "https://api.anthropic.com/v1", apiKeyEnv: "JUDGE_API_KEY" } as const;

/** Exactly the `simulatedUser:` block every shipped template writes. */
const PLACEHOLDER_USER = {
	provider: "openai-compatible",
	id: "replace-with-model-id",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:1234/v1",
	apiKeyEnv: "AHDE_USER_API_KEY",
	thinkingLevel: "off",
	timeoutMs: 300_000,
} as const;

const REAL_USER = { ...PLACEHOLDER_USER, provider: "openrouter", id: "glm-5.3", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" } as const;

function manifestInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "support-agent",
		model: { ...REAL_MODEL },
		instructions: { agentsMd: "AGENTS.md" },
		skills: [],
		evalSuite: {
			id: "support-agent-development",
			dataset: "evals/development.jsonl",
			graders: "evals/graders.yaml",
		},
		...overrides,
	};
}

/** A manifest whose identity and model are still the template's stand-ins. */
const STAND_IN_MANIFEST_YAML = `id: replace-me-agent
model:
  provider: REPLACE-ME-provider
  id: REPLACE-ME-model-id
  api: openai-completions
  baseUrl: https://REPLACE-ME/api/v1
  apiKeyEnv: REPLACE_ME_API_KEY
  thinkingLevel: "off"
  timeoutMs: 300000
instructions:
  agentsMd: AGENTS.md
skills: [skills/check-dbo]
evalSuite:
  id: test-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`;

describe("recognising a template stand-in", () => {
	it("matches the marker in either spelling and in any case", () => {
		for (const text of ["REPLACE-ME", "replace-me", "Replace_Me", "REPLACE_ME_API_KEY", "see <REPLACE-ME: the tool> here"]) {
			expect(isStandIn(text), text).toBe(true);
		}
		for (const text of ["", "replace", "me", "replace me", "replacement", "AHDE_MODEL_API_KEY"]) {
			expect(isStandIn(text), text).toBe(false);
		}
	});

	it("reads a model block as a stand-in from any of its three addressable parts", () => {
		expect(isStandInModel(REAL_MODEL)).toBe(false);
		expect(isStandInModel({ ...REAL_ENDPOINT, provider: "REPLACE-ME-provider" })).toBe(true);
		expect(isStandInModel({ ...REAL_ENDPOINT, id: "REPLACE-ME-model-id" })).toBe(true);
		expect(isStandInModel({ ...REAL_ENDPOINT, baseUrl: "https://REPLACE-ME/api/v1" })).toBe(true);
		// The credential's env-var NAME is not what makes a model uncallable, so it
		// is not part of this question; `standInManifestFields` still reports it.
		const standInKeyName: TargetManifest["model"] = { ...REAL_MODEL, apiKeyEnv: "REPLACE_ME_API_KEY" };
		expect(isStandInModel(standInKeyName)).toBe(false);
	});

	/**
	 * The built-in starter id is a stand-in that never says REPLACE-ME. Every
	 * shipped template writes it on the Target's model AND, where it declares
	 * them, on the judge and the simulated user — so a reader that only knows the
	 * regex sees two configured evaluators pointed at a dead local port.
	 */
	it("reads the built-in starter model id as a stand-in too", () => {
		expect(STARTER_MODEL_ID).toBe("replace-with-model-id");
		expect(isStandInModel({ ...REAL_ENDPOINT, id: STARTER_MODEL_ID })).toBe(true);
		// Exactly the block every template ships on `judge:` and `simulatedUser:`.
		expect(isStandInModel({
			provider: "openai-compatible",
			id: STARTER_MODEL_ID,
			baseUrl: "http://127.0.0.1:1234/v1",
		})).toBe(true);
		// And nothing near it: a real id that merely mentions the word is a model.
		expect(isStandInModel({ ...REAL_ENDPOINT, id: "replace-with-model-id-v2" })).toBe(false);
	});

	it("names the manifest fields exactly as the manifest names them, identity first", () => {
		expect(standInManifestFields({ id: "support-agent", model: REAL_MODEL })).toEqual([]);
		expect(standInManifestFields({
			id: "replace-me-agent",
			model: {
				provider: "REPLACE-ME-provider",
				id: "REPLACE-ME-model-id",
				baseUrl: "https://REPLACE-ME/api/v1",
				apiKeyEnv: "REPLACE_ME_API_KEY",
			},
		})).toEqual(["id", "model.provider", "model.id", "model.baseUrl", "model.apiKeyEnv"]);
		expect(standInManifestFields({ id: "support-agent", model: { ...REAL_MODEL, apiKeyEnv: "REPLACE_ME_API_KEY" } }))
			.toEqual(["model.apiKeyEnv"]);
	});
});

describe("scanning a harness for stand-ins", () => {
	it("reports the shipped RU template's five files, root files first and directories in order", () => {
		expect(standInTargetFiles(SUPPORT_TEMPLATE)).toEqual(SUPPORT_TEMPLATE_STAND_INS);
	});

	it("reads only the files a Builder rewrites, and says nothing about a written harness", () => {
		const dir = harness({
			"AGENTS.md": "# Agent\nAnswer briefly.\n",
			"spec.md": "# Spec\nClassify the request.\n",
			"README.md": "Still says REPLACE-ME, and is nobody's instructions.\n",
			"manifest.yaml": "id: REPLACE-ME\n",
			"evals/development.jsonl": '{"id":"task_001","input":"x"}\n',
			"evals/graders.yaml": "defaults: []\n",
			"evals/notes.md": "REPLACE-ME — evidence, not a case file\n",
			"runs/erun-1/eval_run.json": '{"note":"REPLACE-ME"}\n',
		});
		// The manifest has its own typed blocker; README and evidence are not the
		// agent's instructions. None of them belong on this line.
		expect(standInTargetFiles(dir)).toEqual([]);

		writeFileSync(join(dir, "spec.md"), "# Spec\n<REPLACE-ME: what the agent is for>\n", "utf8");
		writeFileSync(join(dir, "evals", "graders.yaml"), "defaults: []\n# REPLACE-ME with a real default\n", "utf8");
		mkdirSync(join(dir, "skills", "triage"), { recursive: true });
		writeFileSync(join(dir, "skills", "triage", "SKILL.md"), "REPLACE-ME\n", "utf8");
		mkdirSync(join(dir, "bin"), { recursive: true });
		writeFileSync(join(dir, "bin", "check_account"), "#!/usr/bin/env bash\necho REPLACE-ME\n", "utf8");
		expect(standInTargetFiles(dir)).toEqual([
			"spec.md",
			"bin/check_account",
			"evals/graders.yaml",
			"skills/triage/SKILL.md",
		]);
	});

	it("stays bounded: skips a huge file, skips symlinks, stops descending, and names at most twenty", () => {
		const dir = harness({
			"AGENTS.md": "# Agent\nREPLACE-ME\n",
			"tools/huge.yaml": `REPLACE-ME\n${"x".repeat(1024 * 1024)}`,
			"skills/a/b/c/d/near.md": "REPLACE-ME\n",
			"skills/a/b/c/d/e/far.md": "REPLACE-ME\n",
		});
		// A symlink is someone else's file: this scan never follows one out of the
		// harness, and never reports one.
		symlinkSync(join(dir, "AGENTS.md"), join(dir, "spec.md"));
		symlinkSync(join(dir, "AGENTS.md"), join(dir, "tools", "linked.yaml"));

		expect(standInTargetFiles(dir)).toEqual(["AGENTS.md", "skills/a/b/c/d/near.md"]);

		const many = harness({ "AGENTS.md": "REPLACE-ME\n" });
		mkdirSync(join(many, "tools"), { recursive: true });
		for (let index = 0; index < 30; index += 1) {
			writeFileSync(join(many, "tools", `t${String(index).padStart(2, "0")}.yaml`), "REPLACE-ME\n", "utf8");
		}
		const found = standInTargetFiles(many);
		expect(found).toHaveLength(MAX_STAND_IN_FILES);
		expect(found[0]).toBe("AGENTS.md");
		expect(found[1]).toBe("tools/t00.yaml");
		expect(found.at(-1)).toBe(`tools/t${MAX_STAND_IN_FILES - 2}.yaml`);
	});

	it("says nothing at all about a directory that is not a harness", () => {
		expect(standInTargetFiles(join(tmpdir(), "ahde-no-such-target-dir"))).toEqual([]);
		expect(standInFilesLine(join(tmpdir(), "ahde-no-such-target-dir"))).toBeNull();
	});
});

describe("the one readiness sentence", () => {
	it("bends the file count in English and names every file it found", () => {
		setLanguage("en");
		expect(standInFilesLine(SUPPORT_TEMPLATE)).toBe(t("readiness.stand-ins", {
			files: plural(5, "file"),
			names: SUPPORT_TEMPLATE_STAND_INS.join(", "),
		}));
		expect(standInFilesLine(SUPPORT_TEMPLATE)).toBe(
			"The template's REPLACE-ME stand-ins are still in 5 files: " +
				`${SUPPORT_TEMPLATE_STAND_INS.join(", ")} — describe the agent and the Builder replaces them`,
		);
		// One file has to read as a sentence too, not "1 file still carry".
		expect(standInFilesLine(harness({ "AGENTS.md": "REPLACE-ME\n" }))).toBe(
			"The template's REPLACE-ME stand-ins are still in 1 file: AGENTS.md — describe the agent and the Builder replaces them",
		);
	});

	it("bends the file count the way Russian does, for one, two and five", () => {
		setLanguage("ru");
		const one = harness({ "AGENTS.md": "REPLACE-ME\n" });
		const two = harness({ "AGENTS.md": "REPLACE-ME\n", "spec.md": "REPLACE-ME\n" });
		const five = SUPPORT_TEMPLATE;

		expect(standInFilesLine(one)).toBe("1 файл ещё с подставными REPLACE-ME из шаблона: AGENTS.md — опиши агента, и Билдер их заменит");
		expect(standInFilesLine(two)?.startsWith("2 файла ещё с подставными")).toBe(true);
		expect(standInFilesLine(five)?.startsWith("5 файлов ещё с подставными")).toBe(true);
		expect(standInFilesLine(five)).toContain(SUPPORT_TEMPLATE_STAND_INS.join(", "));
	});
});

describe("a stand-in judge is no judge", () => {
	it("drops a REPLACE-ME judge at parse time and keeps a real one", () => {
		const withStandIn = TargetManifest.parse(manifestInput({
			evalSuite: {
				id: "support-agent-development",
				dataset: "evals/development.jsonl",
				graders: "evals/graders.yaml",
				judge: { ...STAND_IN_JUDGE },
			},
		}));
		expect(withStandIn.evalSuite.judge).toBeUndefined();
		expect("judge" in withStandIn.evalSuite).toBe(false);

		const withJudge = TargetManifest.parse(manifestInput({
			evalSuite: {
				id: "support-agent-development",
				dataset: "evals/development.jsonl",
				graders: "evals/graders.yaml",
				judge: { ...REAL_JUDGE },
			},
		}));
		expect(withJudge.evalSuite.judge).toMatchObject({ provider: "anthropic", id: "claude-judge" });
	});

	it("refuses a judge grader against a stand-in judge exactly as against no judge at all", () => {
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": `id: test-target
model:
  provider: qwen-internal
  id: qwen3.5-27b
  api: openai-completions
  baseUrl: http://127.0.0.1:9901/v1
  apiKeyEnv: TEST_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 300000
instructions:
  agentsMd: AGENTS.md
skills: [skills/check-dbo]
evalSuite:
  id: test-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
  judge:
    provider: REPLACE-ME-provider
    id: REPLACE-ME-judge-model-id
    api: openai-completions
    baseUrl: https://REPLACE-ME/api/v1
    apiKeyEnv: REPLACE_ME_API_KEY
    thinkingLevel: "high"
    timeoutMs: 600000
`,
			"evals/development.jsonl": `${JSON.stringify({
				id: "task_001",
				input: "x",
				graders: [{ type: "judge", rubric: "ответ по существу" }],
			})}\n`,
		}));
		fixtures.push(dir);
		const target = loadTarget(dir);
		expect(target.manifest.evalSuite.judge).toBeUndefined();
		// Loadable, never runnable, and the refusal names the case rather than a
		// manifest field the operator never typed.
		expect(() => assertEvaluatorsConfigured(target.tasks, target.manifest.evalSuite))
			.toThrow(/graded by a judge and evalSuite\.judge is not configured \(task_001\)/);
	});

	it("still encodes, because receipts write manifests back out through this schema", () => {
		// `overwrite`, not `transform`: a unidirectional transform makes every
		// artifact codec that embeds a manifest throw on write.
		const manifest = TargetManifest.parse(manifestInput({
			evalSuite: {
				id: "support-agent-development",
				dataset: "evals/development.jsonl",
				graders: "evals/graders.yaml",
				judge: { ...STAND_IN_JUDGE },
			},
		}));
		const encoded = z.safeEncode(TargetManifest, manifest);
		expect(encoded.success).toBe(true);
		expect((encoded.data as typeof manifest).evalSuite.judge).toBeUndefined();
	});
});

describe("a template harness is not a configured agent", () => {
	it("reads a fresh scaffold of the shipped template as the untouched built-in placeholder", () => {
		// Scaffolded rather than read in place: this is what `ahde init --template`
		// hands the operator, and it does not depend on AHDE's own checkout being
		// a Git repository.
		const parent = mkdtempSync(join(tmpdir(), "ahde-template-scaffold-"));
		roots.push(parent);
		const scaffolded = scaffoldTarget(SUPPORT_TEMPLATE, join(parent, "agent"));
		const target = loadTarget(scaffolded);
		expect(standInTargetFiles(scaffolded)).toEqual(SUPPORT_TEMPLATE_STAND_INS);
		expect(target.manifest.id).toBe("my-agent");
		expect(target.manifest.evalSuite.id).toBe("my-agent-development");
		expect(target.manifest.model).toMatchObject({
			provider: "openai-compatible",
			id: "replace-with-model-id",
			baseUrl: "http://127.0.0.1:1234/v1",
			apiKeyEnv: "AHDE_MODEL_API_KEY",
		});
		expect(target.manifest.evalSuite.judge).toBeUndefined();
		expect(targetBootstrapRequired(target.manifest)).toBe(true);
	});

	it("reads the shipped python-agent template as a command Target with a declared harness", () => {
		const parent = mkdtempSync(join(tmpdir(), "ahde-python-scaffold-"));
		roots.push(parent);
		const scaffolded = scaffoldTarget(PYTHON_TEMPLATE, join(parent, "agent"));
		const target = loadTarget(scaffolded);
		expect(executionKindOf(target.manifest.execution)).toBe("command");
		expect(target.manifest.execution.command?.argv).toEqual(["python3", "agent.py"]);
		// The editable surface is the prompt, not the program: a proposal may
		// rewrite what the agent is told, never how it runs.
		expect(harnessFilesOf(target.manifest)).toEqual(["prompts/**"]);
		expect(target.tools.map((tool) => tool.descriptor.name)).toEqual(["create_ticket", "get_account"]);
		expect(target.tasks).toHaveLength(8);
		expect(target.tasks.filter((task) => task.world)).toHaveLength(4);
		expect(target.tasks.filter((task) => task.simulatedUser)).toHaveLength(2);
		expect(target.data.map((directory) => directory.path)).toEqual(["data/kb"]);
		// It ships with placeholders like every template, so the first-run dialog
		// still asks which models this agent, its judge and its user model use.
		expect(target.manifest.id).toBe("my-agent");
		expect(targetBootstrapRequired(target.manifest)).toBe(true);
		// Both evaluator blocks are the built-in placeholder the bootstrap dialog
		// replaces on `model:`, so both read as unconfigured rather than as models
		// pointed at http://127.0.0.1:1234/v1.
		expect(target.manifest.evalSuite.judge).toBeUndefined();
		expect(target.manifest.evalSuite.simulatedUser).toBeUndefined();
	});

	/**
	 * The whole point of the split: this template's cases need both evaluators
	 * and it must still LOAD, or the operator's first run of `ahde` in the folder
	 * dies on a manifest error instead of asking which models to use.
	 */
	it("loads the python-agent template and refuses to run it, naming the cases", () => {
		const parent = mkdtempSync(join(tmpdir(), "ahde-python-evaluators-"));
		roots.push(parent);
		const target = loadTarget(scaffoldTarget(PYTHON_TEMPLATE, join(parent, "agent")));
		expect(missingEvaluatorCases(target.tasks, target.manifest.evalSuite)).toEqual({
			judge: ["technician-price"],
			simulatedUser: ["vague-complaint", "angry-about-money"],
		});
		expect(() => assertEvaluatorsConfigured(target.tasks, target.manifest.evalSuite)).toThrow(
			/1 case\(s\) are graded by a judge .*\(technician-price\); 2 case\(s\) are conversations .*\(vague-complaint, angry-about-money\)/,
		);
	});

	/**
	 * The other half of the rule: a real block is a real evaluator. A shipped
	 * template is starting material, but a manifest the operator's reviewed
	 * commit wrote must survive the same schema untouched.
	 */
	it("leaves a configured judge and simulated user exactly as written", () => {
		const manifest = TargetManifest.parse(manifestInput({
			evalSuite: {
				id: "support-agent-development",
				dataset: "evals/development.jsonl",
				graders: "evals/graders.yaml",
				judge: { ...REAL_JUDGE },
				simulatedUser: { ...REAL_USER },
			},
		}));
		expect(manifest.evalSuite.judge).toMatchObject({ provider: "anthropic", id: "claude-judge" });
		expect(manifest.evalSuite.simulatedUser).toMatchObject({ provider: "openrouter", id: "glm-5.3" });
	});

	it("drops a simulated user on the built-in placeholder and survives re-encoding", () => {
		const manifest = TargetManifest.parse(manifestInput({
			evalSuite: {
				id: "support-agent-development",
				dataset: "evals/development.jsonl",
				graders: "evals/graders.yaml",
				simulatedUser: { ...PLACEHOLDER_USER },
			},
		}));
		expect(manifest.evalSuite.simulatedUser).toBeUndefined();
		const encoded = z.safeEncode(TargetManifest, manifest);
		expect(encoded.success).toBe(true);
		expect((encoded.data as typeof manifest).evalSuite.simulatedUser).toBeUndefined();
	});

	it("asks for bootstrap for both shapes, and for neither once they are replaced", () => {
		const builtIn = { id: "my-agent", model: { ...REAL_MODEL, id: "replace-with-model-id" } };
		const standIn = { id: "replace-me-agent", model: { ...REAL_MODEL, id: "REPLACE-ME-model-id" } };
		const configured = { id: "support-agent", model: { ...REAL_MODEL } };

		expect(targetBootstrapRequired(builtIn)).toBe(true);
		expect(targetBootstrapRequired(standIn)).toBe(true);
		expect(targetBootstrapRequired(configured)).toBe(false);
		// Only the key's NAME is a stand-in: still nobody's choice, still bootstrap.
		expect(targetBootstrapRequired({ id: "support-agent", model: { ...REAL_MODEL, apiKeyEnv: "REPLACE_ME_API_KEY" } })).toBe(true);
	});

	it("makes `ahde validate` exit 2 on a stand-in manifest, the way it does for the starter", () => {
		setLanguage("en");
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": STAND_IN_MANIFEST_YAML,
			"AGENTS.md": "# Agent\n<REPLACE-ME: what this agent does>\n",
		}));
		fixtures.push(dir);
		const target = loadTarget(dir);
		const readiness = inspectTargetReadiness(target, { REPLACE_ME_API_KEY: "configured" });

		// `validate` sets exit code 2 on exactly this flag, credential or no.
		expect(readiness.credential.status).toBe("present-unverified");
		expect(readiness.bootstrapRequired).toBe(true);
		expect(readiness.ready).toBe(false);
		expect(readiness.issues).toContain("Target identity and model still contain starter placeholders.");
		// And the line printed beside it names the files, without ever blocking.
		expect(standInFilesLine(target.dir)).toBe(
			"The template's REPLACE-ME stand-ins are still in 1 file: AGENTS.md — describe the agent and the Builder replaces them",
		);
	});
});

describe("the stage a stand-in harness is at", () => {
	function viewOver(projectDir: string) {
		return deriveWorkbenchView(loadWorkbenchInventory({
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			projectId: "demo",
		}));
	}

	it("names the stand-in fields in a typed blocker and carries the file line as a warning", () => {
		setLanguage("en");
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": STAND_IN_MANIFEST_YAML,
			"AGENTS.md": "# Agent\n<REPLACE-ME: what this agent does>\n",
		}));
		fixtures.push(dir);
		const view = viewOver(dir);

		expect(view.stage).toBe("target-setup");
		expect(view.actions).toEqual(["configure-target"]);
		expect(view.target.status).toBe("bootstrap-required");
		expect(view.blockerReasons).toEqual([{
			code: "blocker.target-stand-ins",
			params: { fields: "id, model.provider, model.id, model.baseUrl, model.apiKeyEnv" },
		}]);
		expect(view.blockers).toEqual([
			"Target still contains the template's REPLACE-ME stand-ins in id, model.provider, model.id, model.baseUrl, model.apiKeyEnv.",
		]);
		// Never a blocker: the files get rewritten by describing the agent.
		expect(view.warnings).toContain(standInFilesLine(dir));
	});

	it("keeps the exact built-in scaffold on its own blocker", () => {
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": `id: my-agent
model:
  provider: openai-compatible
  id: replace-with-model-id
  api: openai-completions
  baseUrl: http://127.0.0.1:1234/v1
  apiKeyEnv: AHDE_MODEL_API_KEY
  thinkingLevel: "off"
  timeoutMs: 300000
instructions:
  agentsMd: AGENTS.md
skills: [skills/check-dbo]
evalSuite:
  id: my-agent-development
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`,
		}));
		fixtures.push(dir);
		const view = viewOver(dir);

		expect(view.target.status).toBe("bootstrap-required");
		expect(view.blockerReasons).toEqual([{ code: "blocker.target-placeholder" }]);
		expect(view.blockers).toEqual(["Target still contains its one-time identity/model placeholders."]);
	});
});
