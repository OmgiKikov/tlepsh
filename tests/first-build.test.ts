import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { ADOPTED_AGENTS_MD } from "../src/application/target-scaffold.js";
import { instructionFiles, isTargetBuilt } from "../src/application/first-build.js";
import { loadBuilderApplyReceipt } from "../src/application/builder-proposal.js";
import { nextStep } from "../src/builder/render/stage.js";
import { welcomeIntents } from "../src/builder/render/welcome.js";
import { setLanguage } from "../src/i18n.js";
import { TargetManifest } from "../src/manifest.js";
import { workbenchNext } from "../src/workbench/next-actions.js";
import { createAhdeWorkbench, type WorkbenchHumanGate } from "../src/workbench/index.js";

const roots: string[] = [];
const NOW = "2026-09-06T12:00:00.000Z";

afterEach(() => {
	vi.restoreAllMocks();
	setLanguage("en");
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function gate(): WorkbenchHumanGate & { confirm: ReturnType<typeof vi.fn> } {
	return {
		confirm: vi.fn(async () => ({ approved: true, actorId: "local:test-human" })),
		selectSealed: vi.fn(async () => ({ approved: false })),
	};
}

function manifestOf(dir: string): TargetManifest {
	return TargetManifest.parse(parseYaml(readFileSync(join(dir, "manifest.yaml"), "utf8")));
}

describe("whether the agent has been written yet", () => {
	it("reads a packaged template as unbuilt, and one edited instruction file as built", () => {
		for (const template of ["basic-agent", "support-agent", "python-agent"]) {
			const dir = mkdtempSync(join(tmpdir(), `ahde-first-build-${template}-`));
			roots.push(dir);
			cpSync(resolve("templates", template), dir, { recursive: true });
			const target = { dir, manifest: manifestOf(dir) };
			expect(isTargetBuilt(target), template).toBe(false);
			// The declared surface is what counts: a command Target's prompts, a Pi Target's AGENTS.md.
			const surface = instructionFiles(target);
			expect(surface[0]).toBe("AGENTS.md");
			const written = template === "python-agent" ? "prompts/system.md" : "AGENTS.md";
			expect(surface).toContain(written);
			writeFileSync(join(dir, written), "# Волна\n\nОтвечай по базе знаний, иначе переводи на оператора.\n");
			expect(isTargetBuilt(target), `${template} after writing ${written}`).toBe(true);
		}
	});

	it("reads an adopted folder as built: its prompts are the operator's", () => {
		const dir = mkdtempSync(join(tmpdir(), "ahde-first-build-adopted-"));
		roots.push(dir);
		cpSync(resolve("templates", "python-agent"), dir, { recursive: true });
		// What adoption writes when the folder has no AGENTS.md of its own.
		writeFileSync(join(dir, "AGENTS.md"), ADOPTED_AGENTS_MD);
		expect(isTargetBuilt({ dir, manifest: manifestOf(dir) })).toBe(true);
	});
});

describe("the first build of a scaffolded agent", () => {
	const SPEC = {
		schemaVersion: 1 as const,
		title: "Volna support bot",
		purpose: "Answer an internet provider's clients from the knowledge base.",
		users: ["clients in chat"],
		jobs: ["answer one question"],
		inputs: ["one message"],
		allowedActions: ["answer in Russian"],
		successCriteria: ["answer names a concrete number"],
		constraints: ["never promise what the base does not say"],
		openQuestions: [] as string[],
	};
	const TARGET_MODEL = {
		provider: "openai",
		id: "gpt-test",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		apiKeyEnv: "OPENAI_API_KEY",
		thinkingLevel: "medium" as const,
		timeoutMs: 300_000,
		params: {},
		spec: { reasoning: true, contextWindow: 131_072, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: {} },
	};

	/** A brand-new agent: scaffolded, configured, described and approved — and still the template. */
	async function approvedSpec() {
		const projectDir = mkdtempSync(join(tmpdir(), "ahde-first-build-"));
		roots.push(projectDir);
		const workbench = createAhdeWorkbench({
			projectDir,
			stateRoot: join(projectDir, ".ahde"),
			runsRoot: join(projectDir, "runs"),
			projectId: "volna",
			templateDir: resolve("templates/basic-agent"),
			dependencies: { now: () => NOW },
		});
		await workbench.decide({ kind: "scaffold-target", reason: "Create the agent here" }, gate());
		await workbench.decide({
			kind: "configure-target",
			targetId: "volna",
			model: { provider: "openai", modelId: "gpt-test", thinkingLevel: "medium", timeoutMs: 300_000, params: {} },
			reason: "Bind the model",
		}, gate(), { resolveTargetModel: () => TARGET_MODEL });
		await workbench.submit({ kind: "spec-draft", spec: SPEC });
		await workbench.decide({ kind: "approve-spec", reason: "The description is right" }, gate());
		return { projectDir, workbench };
	}

	async function buildInWorkshop(workbench: Awaited<ReturnType<typeof approvedSpec>>["workbench"], text: string): Promise<string> {
		const opened = await workbench.submit({ kind: "workshop-open" });
		expect(opened.artifact?.basis).toBe("construction");
		workbench.workshopWrite({ path: "AGENTS.md", content: text });
		const closed = await workbench.submit({
			kind: "workshop-close",
			summary: "Write the agent the description asks for",
			validationPlan: ["Write the tests next and run them"],
		});
		expect(closed.view.stage).toBe("proposal-review");
		return String(closed.artifact?.runId);
	}

	it("says build first, lands the accepted build as the working agent, and only then asks for tests", async () => {
		const { projectDir, workbench } = await approvedSpec();
		const base = git(projectDir, "rev-parse", "HEAD");

		// The moment after approval: the artifacts say "eval design", the
		// operator is told to build, and the Builder's `next` says the same.
		const before = await workbench.view();
		expect(before.stage).toBe("corpus-design");
		expect(before.target.built).toBe(false);
		expect(workbenchNext(before).unblock).toMatch(/still the template.*construction workshop.*then write the tests/);
		expect(workbenchNext(before).operatorNext).toEqual({ code: "next.build-required" });
		expect(nextStep(before)).toBe("Say “build the agent” — the Builder writes it from the description and shows the diff");
		expect(welcomeIntents(before)).toContain("Build the agent from the description");
		setLanguage("ru");
		expect(nextStep(before)).toBe("Скажи «собери агента» — напишу его по описанию и покажу дифф");
		setLanguage("en");

		const runId = await buildInWorkshop(workbench, "# Волна\n\nОтвечай клиентам провайдера по базе знаний. Не обещай лишнего.\n");
		const human = gate();
		const applied = await workbench.decide({
			kind: "apply-proposal",
			runId,
			branch: "candidate/first-build",
			verify: { repetitions: 3 },
			reason: "This is the agent I described",
		}, human);

		// One question, titled as what it is, with no price on it: nothing runs.
		expect(human.confirm).toHaveBeenCalledTimes(1);
		const asked = human.confirm.mock.calls[0]?.[0] as { title: string; estimate?: unknown; subject: { operation: string } };
		expect(asked.title).toBe("Build the agent");
		expect(asked.estimate).toBeUndefined();
		expect(asked.subject.operation).toBe("first-build");

		// The build is the working agent: the operator's own branch moved onto it.
		expect(applied.kind).toBe("apply-proposal");
		if (applied.kind !== "apply-proposal") throw new Error("unreachable");
		const head = git(projectDir, "rev-parse", "HEAD");
		expect(head).toBe(applied.result.candidateSha);
		expect(head).not.toBe(base);
		expect(git(projectDir, "rev-parse", "--abbrev-ref", "HEAD")).not.toBe("candidate/first-build");
		expect(applied.result.firstBuild).toEqual({ branch: git(projectDir, "rev-parse", "--abbrev-ref", "HEAD"), targetGitSha: head });
		expect(applied.result.verification).toBeUndefined();
		expect(applied.message).toMatch(/^The agent is built: .* Write the tests next\.$/);
		expect(readFileSync(join(projectDir, "AGENTS.md"), "utf8")).toContain("Волна");
		expect(loadBuilderApplyReceipt(join(projectDir, "runs"), runId).via).toBe("first-build");
		expect(existsSync(join(projectDir, "runs", "candidates"))).toBe(false);

		// Now the tests are the next thing, on an agent that exists.
		const after = applied.view;
		expect(after.stage).toBe("corpus-design");
		expect(after.target.built).toBe(true);
		expect(after.target.gitSha).toBe(head);
		expect(workbenchNext(after).unblock).toBe("ask the Builder for test cases");
		expect(workbenchNext(after).operatorNext).toEqual({ code: "next.corpus-design" });
		expect(welcomeIntents(after)).not.toContain("Build the agent from the description");
		// Verifying the first build is refused by name: there is no candidate.
		expect(after.blockers).toEqual([]);
	}, 120_000);

	it("finishes a build whose fast-forward was interrupted, with the same decision", async () => {
		const { projectDir, workbench } = await approvedSpec();
		const base = git(projectDir, "rev-parse", "HEAD");
		const runId = await buildInWorkshop(workbench, "# Волна\n\nПервая сборка.\n");
		const applied = await workbench.decide({
			kind: "apply-proposal", runId, branch: "candidate/first-build", reason: "Build it",
		}, gate());
		if (applied.kind !== "apply-proposal") throw new Error("unreachable");
		const built = applied.result.candidateSha;

		// A crash between the apply receipt and the fast-forward: the receipt
		// says first-build, the operator's branch is still at the template.
		git(projectDir, "reset", "--hard", "-q", base);
		const view = await workbench.view();
		expect(view.stage).toBe("proposal-review");
		expect(view.selections.find((entry) => entry.kind === "proposal" && entry.id === runId)?.status).toBe("apply-pending");

		const resumed = await workbench.decide({
			kind: "apply-proposal", runId, branch: "candidate/first-build", reason: "Build it",
		}, gate());
		if (resumed.kind !== "apply-proposal") throw new Error("unreachable");
		expect(git(projectDir, "rev-parse", "HEAD")).toBe(built);
		expect(resumed.result.firstBuild?.targetGitSha).toBe(built);
		expect(resumed.view.stage).toBe("corpus-design");
		expect(resumed.view.target.built).toBe(true);
	}, 120_000);

	it("takes the candidate path for every change after the first build", async () => {
		const { projectDir, workbench } = await approvedSpec();
		const first = await buildInWorkshop(workbench, "# Волна\n\nПервая сборка.\n");
		await workbench.decide({ kind: "apply-proposal", runId: first, branch: "candidate/first-build", reason: "Build it" }, gate());
		const head = git(projectDir, "rev-parse", "HEAD");

		// The agent exists now; a second construction diff is a change to it.
		const second = await buildInWorkshop(workbench, "# Волна\n\nВторая версия: называй конкретные числа.\n");
		const human = gate();
		const applied = await workbench.decide({
			kind: "apply-proposal", runId: second, branch: "candidate/second", reason: "A change to the built agent",
		}, human);
		if (applied.kind !== "apply-proposal") throw new Error("unreachable");
		expect((human.confirm.mock.calls[0]?.[0] as { title: string }).title).toBe("Apply exact Builder proposal");
		expect(applied.result.firstBuild).toBeUndefined();
		expect(git(projectDir, "rev-parse", "HEAD")).toBe(head);
		expect(git(projectDir, "rev-parse", "candidate/second")).toBe(applied.result.candidateSha);
		expect(applied.view.stage).toBe("candidate-verification");
		expect(loadBuilderApplyReceipt(join(projectDir, "runs"), second).via).toBeUndefined();
	}, 120_000);
});
