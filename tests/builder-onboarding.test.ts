import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { plural, t } from "../src/i18n.js";
import type { WorkbenchView } from "../src/workbench/types.js";
import {
	calmSetupFailure,
	confirmDeclaredToolCredentials,
	defaultJudgeSelection,
	describeHostModelCatalog,
	selectToolCredentialEnvironments,
	evaluatorsNotConfigured,
	evaluatorsStillUnchosen,
	hostDefaultJudge,
	hostModelCatalog,
	resolveTypedModel,
	targetIdFromDirectory,
	runFirstRunOnboarding,
	targetModelResolver,
} from "../src/builder/onboarding.js";

const onboardingRoots: string[] = [];

afterEach(() => {
	for (const path of onboardingRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function registry(options: {
	available?: { provider: string; id: string }[];
	credentialed?: (model: { provider: string; id: string }) => boolean;
	find?: (provider: string, modelId: string) => unknown;
} = {}): Pick<ExtensionContext, "modelRegistry"> {
	return {
		modelRegistry: {
			getAvailable: vi.fn(() => options.available ?? []),
			hasConfiguredAuth: vi.fn(options.credentialed ?? (() => true)),
			find: vi.fn(options.find ?? (() => undefined)),
		},
	} as unknown as Pick<ExtensionContext, "modelRegistry">;
}

describe("host model catalog", () => {
	it("lists credentialed models first and never a credential value", () => {
		const catalog = hostModelCatalog(registry({
			available: [
				{ provider: "openai", id: "gpt-5" },
				{ provider: "anthropic", id: "claude-opus" },
				{ provider: "openai", id: "gpt-5" },
			],
			credentialed: (model) => model.provider === "anthropic",
		}));
		expect(catalog.models).toEqual([
			{ provider: "anthropic", modelId: "claude-opus", credentialPresent: true },
			{ provider: "openai", modelId: "gpt-5", credentialPresent: false },
		]);
		expect(catalog.omittedModels).toBe(0);
		expect(JSON.stringify(catalog)).not.toMatch(/sk-|key|token/i);
	});

	it("stays bounded and says how many it left out", () => {
		const available = Array.from({ length: 55 }, (_, index) => ({ provider: "openrouter", id: `model-${index}` }));
		const catalog = hostModelCatalog(registry({ available, credentialed: () => false }));
		expect(catalog.models).toHaveLength(40);
		expect(catalog.omittedModels).toBe(15);
		expect(describeHostModelCatalog(catalog)).toContain("and 15 more");
	});

	it("survives a host registry that throws", () => {
		const broken = {
			modelRegistry: {
				getAvailable: () => {
					throw new Error("registry unavailable");
				},
				hasConfiguredAuth: () => true,
			},
		} as unknown as Pick<ExtensionContext, "modelRegistry">;
		expect(hostModelCatalog(broken)).toEqual({ models: [], omittedModels: 0 });
		expect(describeHostModelCatalog(hostModelCatalog(broken))).toContain("private model connection picker");
		expect(describeHostModelCatalog(hostModelCatalog(broken))).not.toContain("/login");
	});

	it("names real ids when configure-target guesses one that does not exist", () => {
		const resolve = targetModelResolver(
			registry({
				available: [{ provider: "openai", id: "gpt-5" }, { provider: "anthropic", id: "claude-opus" }],
				credentialed: (model) => model.provider === "openai",
			}),
			"OPENAI_API_KEY",
		);
		expect(() => resolve({ provider: "openai", modelId: "gpt-9-turbo" })).toThrow(
			/openai\/gpt-9-turbo is not available in the trusted host catalog\. Choose one of: openai\/gpt-5, anthropic\/claude-opus \(no credential\)\./,
		);
	});
});

/**
 * The judge the host would pick for a basket that needs one. The predicate is
 * the one `configure-evaluators` enforces after the fact — a model grading a
 * copy of itself is not a second opinion — applied before the question.
 */
describe("the default judge", () => {
	const catalog = (models: { provider: string; id: string; credentialed?: boolean }[]) =>
		hostModelCatalog(registry({
			available: models,
			credentialed: (model) => models.find((entry) =>
				entry.provider === model.provider && entry.id === model.id)?.credentialed !== false,
		}));

	it("takes the first credentialed model that is not the agent's own", () => {
		expect(defaultJudgeSelection(
			catalog([
				{ provider: "qwen-internal", id: "qwen3.5-27b" },
				{ provider: "openrouter", id: "glm-5.3" },
			]),
			{ provider: "qwen-internal", id: "qwen3.5-27b" },
		)).toMatchObject({ provider: "openrouter", modelId: "glm-5.3" });
	});

	it("takes another model from the same provider: the comparison is provider+id", () => {
		expect(defaultJudgeSelection(
			catalog([{ provider: "anthropic", id: "claude-opus" }, { provider: "anthropic", id: "claude-haiku" }]),
			{ provider: "anthropic", id: "claude-opus" },
		)).toMatchObject({ provider: "anthropic", modelId: "claude-haiku" });
	});

	/**
	 * Session 7 got `openrouter/aion-labs/aion-2.0` for the judge AND for the
	 * client — the first row of an alphabetical list, chosen by nobody, paid
	 * for twice out of the same run. The catalog is ordered by whether this
	 * machine can authenticate a model, never by whether it can judge.
	 */
	it("prefers a judge-class id over the first row of the alphabet", () => {
		const alphabetical = catalog([
			{ provider: "openrouter", id: "aion-labs/aion-2.0" },
			{ provider: "openrouter", id: "amazon/nova-lite-v1" },
			{ provider: "openrouter", id: "deepseek/deepseek-v4" },
			{ provider: "openrouter", id: "qwen/qwen3.5-9b" },
		]);
		expect(defaultJudgeSelection(alphabetical, { provider: "openrouter", id: "qwen/qwen3.5-9b" }))
			.toMatchObject({ provider: "openrouter", modelId: "deepseek/deepseek-v4" });
	});

	it("holds one preference order: glm, claude, gpt, deepseek, a large qwen", () => {
		const all = [
			{ provider: "openrouter", id: "aion-labs/aion-2.0" },
			{ provider: "openrouter", id: "qwen/qwen3.5-235b" },
			{ provider: "openrouter", id: "deepseek/deepseek-v4" },
			{ provider: "openai", id: "gpt-5" },
			{ provider: "anthropic", id: "claude-opus" },
			{ provider: "openrouter", id: "z-ai/glm-5.3" },
		];
		const target = { provider: "openrouter", id: "moonshotai/kimi-k2.6" };
		const preferred = ["z-ai/glm-5.3", "claude-opus", "gpt-5", "deepseek/deepseek-v4", "qwen/qwen3.5-235b"];
		for (const [index, expected] of preferred.entries()) {
			// Drop the winners one at a time; the next preference takes over, and
			// the alphabet's first row never does while any of them is present.
			const remaining = all.filter((model) => !preferred.slice(0, index).includes(model.id));
			expect(defaultJudgeSelection(catalog(remaining), target)?.modelId).toBe(expected);
		}
		// With none of them left, the first independent entry is still a judge.
		expect(defaultJudgeSelection(catalog([all[0]!]), target)?.modelId).toBe("aion-labs/aion-2.0");
	});

	it("keeps the independence rule above the preference", () => {
		// The Target's own model is judge-class; the judge must still not be it.
		expect(defaultJudgeSelection(
			catalog([{ provider: "anthropic", id: "claude-opus" }, { provider: "openrouter", id: "aion-labs/aion-2.0" }]),
			{ provider: "anthropic", id: "claude-opus" },
		)).toMatchObject({ modelId: "aion-labs/aion-2.0" });
	});

	it("offers nothing when every other model is uncredentialed, or there is no other model", () => {
		expect(defaultJudgeSelection(
			catalog([
				{ provider: "qwen-internal", id: "qwen3.5-27b" },
				{ provider: "openrouter", id: "glm-5.3", credentialed: false },
			]),
			{ provider: "qwen-internal", id: "qwen3.5-27b" },
		)).toBeNull();
		expect(defaultJudgeSelection(
			catalog([{ provider: "qwen-internal", id: "qwen3.5-27b" }]),
			{ provider: "qwen-internal", id: "qwen3.5-27b" },
		)).toBeNull();
	});

	it("pre-fills nothing unless the operator has already exported the key's variable", () => {
		const ctx = registry({
			available: [{ provider: "qwen-internal", id: "qwen3.5-27b" }, { provider: "openrouter", id: "glm-5.3" }],
			find: (provider, modelId) => ({
				provider,
				id: modelId,
				name: modelId,
				api: "openai-completions",
				baseUrl: "https://openrouter.invalid/api/v1",
				reasoning: false,
				thinkingLevelMap: { off: null },
				input: ["text"],
				cost: { input: 0.2, output: 0.8, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 32_000,
			}),
		});
		const target = { provider: "qwen-internal", id: "qwen3.5-27b" };
		// A name the operator has not exported is a question, and a question
		// belongs in the dialog `configure-evaluators` already asks.
		expect(hostDefaultJudge(ctx, target, {})).toBeNull();
		const chosen = hostDefaultJudge(ctx, target, { OPENROUTER_API_KEY: "sk-live" });
		expect(chosen?.model).toMatchObject({
			provider: "openrouter",
			id: "glm-5.3",
			apiKeyEnv: "OPENROUTER_API_KEY",
		});
	});
});

/**
 * Pi's `ui.select` has neither a filter nor a scroll, so the nine rows it
 * shows are the whole reachable catalog. In session 7 `qwen/qwen3.5-9b` was
 * not among them and the operator had to leave the dialog and dictate the name
 * to the Builder — a turn, and a second question about the id.
 */
describe("a model id the operator types", () => {
	const catalogRegistry = (known: { provider: string; id: string }[], builder?: { provider: string; id: string }) => ({
		...registry({
			available: known,
			find: (provider, modelId) =>
				known.find((entry) => entry.provider === provider && entry.id === modelId),
		}),
		...(builder ? { model: builder } : {}),
	} as unknown as Pick<ExtensionContext, "model" | "modelRegistry">);

	it("reads a fully qualified id as a provider and an id", () => {
		const ctx = catalogRegistry([{ provider: "openrouter", id: "qwen/qwen3.5-9b" }]);
		expect(resolveTypedModel(ctx, "openrouter/qwen/qwen3.5-9b"))
			.toEqual({ provider: "openrouter", modelId: "qwen/qwen3.5-9b" });
	});

	it("reads a bare id under a provider this machine already has", () => {
		const ctx = catalogRegistry(
			[{ provider: "openrouter", id: "qwen/qwen3.5-9b" }],
			{ provider: "openrouter", id: "moonshotai/kimi-k2.6" },
		);
		// `qwen/` is not a provider here; the whole string is one id.
		expect(resolveTypedModel(ctx, "qwen/qwen3.5-9b"))
			.toEqual({ provider: "openrouter", modelId: "qwen/qwen3.5-9b" });
		expect(resolveTypedModel(ctx, "  openrouter/qwen/qwen3.5-9b  "))
			.toEqual({ provider: "openrouter", modelId: "qwen/qwen3.5-9b" });
	});

	it("resolves nothing the catalog does not hold, and never guesses", () => {
		const ctx = catalogRegistry([{ provider: "openrouter", id: "qwen/qwen3.5-9b" }]);
		expect(resolveTypedModel(ctx, "openrouter/qwen/qwen4")).toBeNull();
		expect(resolveTypedModel(ctx, "")).toBeNull();
		expect(resolveTypedModel(ctx, "   /  ")).toBeNull();
	});
});

describe("first-run setup failures", () => {
	it("turns the non-empty directory guard into one calm sentence", () => {
		const calm = calmSetupFailure(new Error("target scaffold requires an otherwise empty current directory; found package.json"));
		expect(calm).toContain("This folder already holds");
		expect(calm).toContain("package.json");
		expect(calm).not.toContain("target scaffold requires");
	});

	it("keeps a cancelled setup calm and keeps unknown failures bounded", () => {
		expect(calmSetupFailure(new Error("Target model configuration was cancelled by the operator"))).toContain("Setup stopped");
		const unknown = calmSetupFailure(new Error("x".repeat(500)));
		expect(unknown.startsWith("Setup did not finish: ")).toBe(true);
		expect(unknown.length).toBeLessThan(240);
	});
});

describe("target id from directory", () => {
	it("keeps a usable slug and falls back to a neutral id", () => {
		expect(targetIdFromDirectory("Competitor Research")).toBe("competitor-research");
		expect(targetIdFromDirectory("my-agent")).toBe("agent");
		expect(targetIdFromDirectory("...")).toBe("agent");
	});
});

describe("a declared tool key nobody exported", () => {
	function uiContext(answers: (string | undefined)[]) {
		const notes: { message: string; tone: string }[] = [];
		const asked: { prompt: string; preset: string }[] = [];
		const queue = [...answers];
		return {
			notes,
			asked,
			ctx: {
				ui: {
					input: vi.fn((prompt: string, preset: string) => {
						asked.push({ prompt, preset });
						return Promise.resolve(queue.shift());
					}),
					notify: vi.fn((message: string, tone: string) => {
						notes.push({ message, tone });
					}),
				},
			} as unknown as Pick<ExtensionContext, "ui">,
		};
	}

	it("asks the host's own question about the variable and tells the operator to export it", async () => {
		const host = uiContext(["WEATHER_API_KEY"]);
		await confirmDeclaredToolCredentials(host.ctx, [
			{ tool: "weather", environment: "WEATHER_API_KEY" },
			{ tool: "weather", environment: "WEATHER_API_KEY" },
		]);
		// One question per variable, prefilled with the declared name.
		expect(host.asked).toEqual([
			{ prompt: "Environment variable holding the credential for weather", preset: "WEATHER_API_KEY" },
		]);
		expect(host.notes).toEqual([{
			message: "Nothing is stored here. Export WEATHER_API_KEY in the shell that runs ahde, then try the tool again.",
			tone: "info",
		}]);
	});

	/**
	 * The broker sets `AHDE_WORLD` and `AHDE_TOOL_HOME` on the tool process
	 * itself. Session 7 asked the operator to export one of them anyway.
	 */
	it("never asks about a name the host sets itself", async () => {
		const host = uiContext([]);
		await confirmDeclaredToolCredentials(host.ctx, [
			{ tool: "get_account", environment: "AHDE_WORLD" },
			{ tool: "create_ticket", environment: "AHDE_TOOL_HOME" },
		]);
		expect(host.asked).toEqual([]);
		expect(host.notes).toEqual([]);
	});

	it("refuses to bind a new tool's credential slot to a host-owned name", async () => {
		const host = uiContext(["AHDE_WORLD"]);
		await expect(selectToolCredentialEnvironments(host.ctx, "weather", [{ id: "token", purpose: "api_token", required: true }]))
			.rejects.toThrow(/set by the host on every tool process/);
	});

	it("says a different variable is a change to the tool, and refuses a pasted value", async () => {
		const renamed = uiContext(["MY_OWN_KEY"]);
		await confirmDeclaredToolCredentials(renamed.ctx, [{ tool: "weather", environment: "WEATHER_API_KEY" }]);
		expect(renamed.notes[0]?.message).toBe(
			"weather declares WEATHER_API_KEY, not MY_OWN_KEY. Changing which variable it reads is a change to the tool, " +
			"so ask for it in plain words and I will prepare the diff.",
		);

		const pasted = uiContext(["sk-live-000111222333"]);
		await confirmDeclaredToolCredentials(pasted.ctx, [{ tool: "weather", environment: "WEATHER_API_KEY" }]);
		expect(pasted.notes).toEqual([{
			message: "That is not an environment-variable name. Name the variable, never paste the credential itself.",
			tone: "warning",
		}]);
		// Whatever was typed is never echoed back or kept.
		expect(JSON.stringify(pasted.notes)).not.toContain("sk-live");
	});
});

/**
 * The first screen for a folder that already holds an agent. Nothing here
 * touches Git or the Workbench: what is under test is the DIALOG — the
 * questions asked, the defaults offered, and the exact decision it submits.
 */
describe("adopting the agent already in the folder", () => {
	function agentDir(files: Record<string, string> = { "agent.py": "import openai\n@tool\ndef a(): ...\n" }): string {
		const dir = mkdtempSync(join(tmpdir(), "ahde-onboard-"));
		onboardingRoots.push(dir);
		for (const [path, content] of Object.entries(files)) {
			const absolute = join(dir, path);
			mkdirSync(join(absolute, ".."), { recursive: true });
			writeFileSync(absolute, content, "utf8");
		}
		return dir;
	}

	function harness(answers: string[]) {
		const asked: string[] = [];
		const decided: unknown[] = [];
		const ctx = {
			ui: {
				select: vi.fn(async (question: string) => {
					asked.push(question);
					return answers.shift();
				}),
				input: vi.fn(async (question: string, initial?: string) => {
					asked.push(question);
					return answers.shift() ?? initial;
				}),
				notify: vi.fn(),
			},
		} as unknown as ExtensionContext;
		const view = {
			stage: "target-setup",
			target: { status: "missing" },
			project: { directory: "agent" },
			next: { say: "", why: "" },
		} as unknown as WorkbenchView;
		const host = {
			workbench: {
				view: async () => view,
				decide: vi.fn(async (input: unknown) => {
					decided.push(input);
					return {
						kind: "wrap-target",
						message: "",
						result: { targetId: "my-agent", targetGitSha: "a".repeat(40), receiptId: "r", entry: "agent.py" },
						view: { ...view, stage: "target-setup", target: { status: "bootstrap-required" } },
					};
				}),
			},
			actorId: () => "operator",
			presenter: { show: vi.fn() },
		} as unknown as Parameters<typeof runFirstRunOnboarding>[1];
		return { ctx, host, asked, decided, view };
	}

	it("asks three questions and submits exactly what the operator answered", async () => {
		const dir = agentDir({ "agent.py": "import openai\n@tool\ndef a(): ...\n", "prompts/system.md": "x\n" });
		const { ctx, host, asked, decided } = harness([
			t("onboarding.wrap.accept"),
			t("onboarding.wrap.accept"),
			"prompts/**",
		]);
		await runFirstRunOnboarding(ctx, { ...host, projectDir: dir }, (await host.workbench.view()) as WorkbenchView);
		expect(asked[0]).toBe(t("onboarding.wrap.seen", { entry: "agent.py", tools: plural(1, "tool") }));
		expect(asked[1]).toBe(t("onboarding.wrap.command", { command: "python3 agent.py" }));
		expect(asked[2]).toBe(t("onboarding.wrap.files"));
		expect(decided).toEqual([{
			kind: "wrap-target",
			argv: ["python3", "agent.py"],
			harnessFiles: ["prompts/**"],
			reason: t("onboarding.wrap.reason"),
		}]);
	});

	/**
	 * The first sentence a new operator reads. Session 7's said «0
	 * инструментов» over two valid descriptors and said nothing about the
	 * knowledge base half the agent's answers came out of.
	 */
	it("counts the descriptors and names the knowledge base in the first sentence", async () => {
		const dir = agentDir({
			"agent.py": "import openai\n",
			"tools/get_account.tool.yaml": "name: get_account\n",
			"tools/create_ticket.tool.yaml": "name: create_ticket\n",
			"data/kb/tariffs.md": "# Тарифы\n",
		});
		const { ctx, host, asked } = harness([t("onboarding.later-choice")]);
		await runFirstRunOnboarding(ctx, { ...host, projectDir: dir }, (await host.workbench.view()) as WorkbenchView);
		expect(asked[0]).toBe(t("onboarding.wrap.seen-kb", { entry: "agent.py", tools: plural(2, "tool") }));
	});

	it("takes the operator's own command and file list when they type one", async () => {
		const dir = agentDir();
		const { ctx, host, decided } = harness([
			t("onboarding.wrap.accept"),
			t("onboarding.wrap.command-edit"),
			"node server.js --agent",
			t("onboarding.wrap.files-edit"),
			"config/*.md, AGENTS.md",
		]);
		await runFirstRunOnboarding(ctx, { ...host, projectDir: dir }, (await host.workbench.view()) as WorkbenchView);
		expect(decided).toEqual([{
			kind: "wrap-target",
			argv: ["node", "server.js", "--agent"],
			harnessFiles: ["config/*.md", "AGENTS.md"],
			reason: t("onboarding.wrap.reason"),
		}]);
	});

	it("falls through to the ordinary create dialog when the operator wants a new agent", async () => {
		const dir = agentDir();
		const { ctx, host, decided } = harness([t("onboarding.wrap.create-new"), t("onboarding.later-choice")]);
		await runFirstRunOnboarding(ctx, { ...host, projectDir: dir }, (await host.workbench.view()) as WorkbenchView);
		expect(decided).toEqual([]);
	});

	it("writes nothing when the operator defers, and never asks at all in an ordinary empty folder", async () => {
		const dir = agentDir();
		const deferred = harness([t("onboarding.later-choice")]);
		await runFirstRunOnboarding(
			deferred.ctx,
			{ ...deferred.host, projectDir: dir },
			(await deferred.host.workbench.view()) as WorkbenchView,
		);
		expect(deferred.decided).toEqual([]);
		expect(deferred.asked).toHaveLength(1);

		const empty = mkdtempSync(join(tmpdir(), "ahde-onboard-empty-"));
		onboardingRoots.push(empty);
		const plain = harness([t("onboarding.later-choice")]);
		await runFirstRunOnboarding(
			plain.ctx,
			{ ...plain.host, projectDir: empty },
			(await plain.host.workbench.view()) as WorkbenchView,
		);
		expect(plain.asked[0]).toBe(t("onboarding.no-agent-here", { directory: "agent" }));
	});
});

/**
 * After the one question the first run asks — which model should the agent use
 * — the template's judge and simulated-user blocks are still the built-in
 * placeholder. Saying who chooses them, and when, is one line; asking here
 * would be two more dialogs about cases nobody has written yet.
 */
describe("the evaluators the first run does not ask about", () => {
	function view(overrides: Partial<WorkbenchView["target"]> = {}): WorkbenchView {
		return {
			stage: "spec-design",
			target: {
				status: "ready",
				id: "my-agent",
				gitSha: "a".repeat(40),
				model: { provider: "openrouter", id: "glm-5.3", apiKeyEnv: "OPENROUTER_API_KEY", credentialPresent: true },
				evaluators: { judge: null, simulatedUser: null },
				evaluatorRequirements: { judge: true, simulatedUser: true },
				...overrides,
			},
		} as unknown as WorkbenchView;
	}

	it("reads the template's own cases, not a guess", () => {
		// The python-agent template: one judged case, two conversations, neither
		// evaluator configured.
		expect(evaluatorsStillUnchosen(view())).toBe(true);
		// Only the conversations.
		expect(evaluatorsStillUnchosen(view({ evaluatorRequirements: { judge: false, simulatedUser: true } }))).toBe(true);
		// A template whose cases need neither is never told about a question it
		// will not be asked.
		expect(evaluatorsStillUnchosen(view({ evaluatorRequirements: { judge: false, simulatedUser: false } }))).toBe(false);
		// And a Target that already carries both says nothing either.
		expect(evaluatorsStillUnchosen(view({
			evaluators: {
				judge: { provider: "openrouter", id: "glm-5.3", apiKeyEnv: "OPENROUTER_API_KEY", credentialPresent: true },
				simulatedUser: { provider: "openrouter", id: "glm-5.3", apiKeyEnv: "OPENROUTER_API_KEY", credentialPresent: true },
			},
		}))).toBe(false);
		// A view written before evaluator setup existed carries neither field.
		expect(evaluatorsStillUnchosen({ target: {} } as unknown as WorkbenchView)).toBe(false);
	});

	/**
	 * An adopted folder's dataset is the one-line placeholder the adoption
	 * wrote, so nothing declares that it needs a judge until the Builder writes
	 * the cases that do — and session 7 therefore never saw the line at all.
	 */
	it("reads only what is configured when the requirement cannot be known yet", () => {
		expect(evaluatorsNotConfigured(view({ evaluatorRequirements: { judge: false, simulatedUser: false } }))).toBe(true);
		expect(evaluatorsNotConfigured(view({
			evaluators: {
				judge: { provider: "openrouter", id: "glm-5.3", apiKeyEnv: "OPENROUTER_API_KEY", credentialPresent: true },
				simulatedUser: { provider: "openrouter", id: "glm-5.3", apiKeyEnv: "OPENROUTER_API_KEY", credentialPresent: true },
			},
		}))).toBe(false);
		expect(evaluatorsNotConfigured({ target: {} } as unknown as WorkbenchView)).toBe(false);
	});

	it("says the line once, after the model is chosen, and adds no dialog", async () => {
		process.env.OPENROUTER_API_KEY = "sk-test";
		const notes: { message: string; tone: string }[] = [];
		const asked: string[] = [];
		const ctx = {
			model: { provider: "openrouter", id: "glm-5.3" },
			modelRegistry: {
				getAvailable: () => [{ provider: "openrouter", id: "glm-5.3" }],
				hasConfiguredAuth: () => true,
				find: () => ({ provider: "openrouter", id: "glm-5.3", baseUrl: "https://openrouter.invalid/api/v1" }),
			},
			ui: {
				select: vi.fn(async (question: string, choices: string[]) => {
					asked.push(question);
					return choices[0];
				}),
				input: vi.fn(async (_question: string, preset?: string) => preset),
				notify: vi.fn((message: string, tone: string) => {
					notes.push({ message, tone });
				}),
			},
		} as unknown as ExtensionContext;
		const configured = view();
		const host = {
			workbench: {
				view: async () => configured,
				decide: vi.fn(async () => ({
					kind: "configure-target",
					message: "",
					result: {
						targetId: "my-agent",
						targetGitSha: "a".repeat(40),
						receiptId: "configure-target-1",
						credentialEnv: "OPENROUTER_API_KEY",
					},
					view: configured,
				})),
			},
			actorId: () => "operator",
			presenter: { show: vi.fn() },
			projectDir: mkdtempSync(join(tmpdir(), "ahde-evaluators-later-")),
		} as unknown as Parameters<typeof runFirstRunOnboarding>[1];
		onboardingRoots.push(String((host as { projectDir?: string }).projectDir));

		const before = {
			stage: "target-setup",
			target: { status: "bootstrap-required" },
			project: { directory: "agent" },
		} as unknown as WorkbenchView;
		const result = await runFirstRunOnboarding(ctx, host, before);

		expect(result).toBe(configured);
		// One question — which model — and then one statement, not a third dialog.
		expect(asked).toEqual([t("onboarding.which-model")]);
		expect(notes).toEqual([{ message: t("onboarding.evaluators-later"), tone: "info" }]);
		delete process.env.OPENROUTER_API_KEY;
	});
});

/**
 * The two things that must be true right after the door closes: the operator
 * can reach a model the nine-row selector never shows, and the sentence that
 * promises the judge question is actually said.
 */
describe("the questions after the door closes", () => {
	function machine(options: { answers: (string | undefined)[]; adopted: boolean; dir: string }) {
		const asked: { question: string; choices?: string[] }[] = [];
		const notes: { message: string; tone: string }[] = [];
		const decided: { kind: string; [key: string]: unknown }[] = [];
		const queue = [...options.answers];
		const known = [{ provider: "openrouter", id: "moonshotai/kimi-k2.6" }, { provider: "openrouter", id: "qwen/qwen3.5-9b" }];
		const ctx = {
			model: { provider: "openrouter", id: "moonshotai/kimi-k2.6" },
			modelRegistry: {
				getAvailable: () => known,
				hasConfiguredAuth: () => true,
				find: (provider: string, modelId: string) => {
					const found = known.find((entry) => entry.provider === provider && entry.id === modelId);
					return found ? { ...found, baseUrl: "https://openrouter.invalid/api/v1" } : undefined;
				},
			},
			ui: {
				select: vi.fn(async (question: string, choices: string[]) => {
					asked.push({ question, choices });
					return queue.shift();
				}),
				input: vi.fn(async (question: string) => {
					asked.push({ question });
					return queue.shift();
				}),
				notify: vi.fn((message: string, tone: string) => {
					notes.push({ message, tone });
				}),
			},
		} as unknown as ExtensionContext;
		const bootstrap = {
			stage: "target-setup",
			target: { status: "bootstrap-required" },
			project: { directory: "agent" },
			blockers: [],
			warnings: [],
			headline: "",
		} as unknown as WorkbenchView;
		// What an adopted Target's view says: no judge, no simulated user, and no
		// case declaring that it needs either — the dataset is still the
		// placeholder the adoption wrote.
		const settled = {
			stage: "spec-design",
			target: {
				status: "ready",
				id: "isp-support",
				gitSha: "a".repeat(40),
				model: { provider: "openrouter", id: "qwen/qwen3.5-9b", apiKeyEnv: "OPENROUTER_API_KEY", credentialPresent: true },
				evaluators: { judge: null, simulatedUser: null },
				evaluatorRequirements: { judge: false, simulatedUser: false },
			},
			project: { directory: "agent" },
			blockers: [],
			warnings: [],
			headline: "",
		} as unknown as WorkbenchView;
		const host = {
			workbench: {
				view: async () => bootstrap,
				decide: vi.fn(async (input: { kind: string }) => {
					decided.push(input as { kind: string });
					return {
						kind: input.kind,
						message: "",
						result: {
							targetId: "isp-support",
							targetGitSha: "a".repeat(40),
							receiptId: "r",
							entry: "agent.py",
							credentialEnv: "OPENROUTER_API_KEY",
						},
						view: input.kind === "wrap-target" ? bootstrap : settled,
					};
				}),
			},
			actorId: () => "operator",
			presenter: { show: vi.fn() },
			projectDir: options.dir,
		} as unknown as Parameters<typeof runFirstRunOnboarding>[1];
		const start = options.adopted
			? ({
				stage: "target-setup",
				target: { status: "missing" },
				project: { directory: "agent" },
				blockers: [],
				warnings: [],
				headline: "",
			} as unknown as WorkbenchView)
			: bootstrap;
		return { ctx, host, asked, notes, decided, start, settled };
	}

	function agentDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "ahde-after-door-"));
		onboardingRoots.push(dir);
		writeFileSync(join(dir, "agent.py"), "import openai\n", "utf8");
		return dir;
	}

	it("takes a model id the selector never showed and configures the agent with it", async () => {
		process.env.OPENROUTER_API_KEY = "sk-test";
		const machinery = machine({
			adopted: false,
			dir: agentDir(),
			answers: [t("onboarding.other-model"), "openrouter/qwen/qwen3.5-9b"],
		});
		await runFirstRunOnboarding(machinery.ctx, machinery.host, machinery.start);
		expect(machinery.asked.map((entry) => entry.question)).toEqual([
			t("onboarding.which-model"),
			t("onboarding.model-id-ask"),
		]);
		expect(machinery.decided).toEqual([expect.objectContaining({
			kind: "configure-target",
			model: { provider: "openrouter", modelId: "qwen/qwen3.5-9b" },
		})]);
		delete process.env.OPENROUTER_API_KEY;
	});

	it("says so, and writes nothing, when the typed id is not in the catalog", async () => {
		process.env.OPENROUTER_API_KEY = "sk-test";
		const machinery = machine({
			adopted: false,
			dir: agentDir(),
			answers: [t("onboarding.other-model"), "openrouter/qwen/qwen4"],
		});
		expect(await runFirstRunOnboarding(machinery.ctx, machinery.host, machinery.start)).toBeNull();
		expect(machinery.decided).toEqual([]);
		expect(machinery.notes).toEqual([{
			message: t("onboarding.model-unknown", { model: "openrouter/qwen/qwen4" }),
			tone: "warning",
		}]);
		delete process.env.OPENROUTER_API_KEY;
	});

	it("promises the judge question after an adoption, where no case declares one yet", async () => {
		process.env.OPENROUTER_API_KEY = "sk-test";
		const dir = agentDir();
		const machinery = machine({
			adopted: true,
			dir,
			answers: [
				t("onboarding.wrap.accept"),
				t("onboarding.wrap.accept"),
				"AGENTS.md",
				t("onboarding.other-model"),
				"openrouter/qwen/qwen3.5-9b",
			],
		});
		const result = await runFirstRunOnboarding(machinery.ctx, machinery.host, machinery.start);
		expect(result).toBe(machinery.settled);
		expect(machinery.decided.map((entry) => entry.kind)).toEqual(["wrap-target", "configure-target"]);
		// The line session 7 never printed.
		expect(machinery.notes).toEqual([{ message: t("onboarding.evaluators-later"), tone: "info" }]);
		delete process.env.OPENROUTER_API_KEY;
	});
});
