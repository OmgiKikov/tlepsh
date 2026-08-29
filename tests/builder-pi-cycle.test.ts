import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONSEQUENTIAL_BUILDER_TOOL_NAMES } from "../src/builder/extension.js";
import { createCorpus } from "../src/corpus.js";
import {
	createHostContext,
	hostCatalogModel,
	invokeTool,
	productionTools,
} from "./helpers/builder-tools.js";

const PROVIDER = "cycle-provider";
const MODEL_ID = "cycle-model";
const CREDENTIAL_ENV = "CYCLE_PROVIDER_API_KEY";
const CATALOG_BASE_URL = "http://127.0.0.1:9901/v1";
const TEMPLATE_DIR = resolve("templates", "basic-agent");

const roots: string[] = [];

function root(prefix: string): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	roots.push(path);
	return path;
}

function tools(projectDir: string, projectId = "cycle-agent"): readonly ToolDefinition[] {
	return productionTools({
		projectDir,
		stateRoot: join(projectDir, ".ahde"),
		runsRoot: join(projectDir, "runs"),
		projectId,
		templateDir: TEMPLATE_DIR,
		dependencies: { actorId: () => "local:cycle-operator" },
	});
}

function catalog(provider: string, modelId: string) {
	return provider === PROVIDER && modelId === MODEL_ID
		? hostCatalogModel(PROVIDER, MODEL_ID, CATALOG_BASE_URL)
		: undefined;
}

function decide(
	projectTools: readonly ToolDefinition[],
	params: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<Record<string, any>> {
	return invokeTool(projectTools, "ahde_workbench_decide", params, ctx);
}

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env[CREDENTIAL_ENV];
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Builder Pi canonical cycle through the production Workbench tools", () => {
	it("initializes the exact current directory only after the host approves the shown subject", async () => {
		const projectDir = root("ahde-cycle-scaffold-");
		const declining = createHostContext({ confirm: false });
		await expect(decide(tools(projectDir), {
			kind: "scaffold-target",
			reason: "Start the Target",
		}, declining.ctx)).rejects.toThrow(/declined/i);
		expect(declining.confirmations[0]?.title).toBe("Create exact Target harness");
		expect(declining.confirmations[0]?.body).toContain(projectDir);
		expect(readdirSync(projectDir)).toEqual([]);

		const host = createHostContext();
		const scaffolded = await decide(tools(projectDir), {
			kind: "scaffold-target",
			reason: "Start the Target",
		}, host.ctx);
		expect(scaffolded.result).toMatchObject({ targetId: "my-agent" });
		expect(readFileSync(join(projectDir, "manifest.yaml"), "utf8")).toContain("id: my-agent");
		expect(existsSync(join(projectDir, ".git"))).toBe(true);

		const occupied = root("ahde-cycle-occupied-");
		writeFileSync(join(occupied, "notes.txt"), "keep me\n");
		await expect(decide(tools(occupied), {
			kind: "scaffold-target",
			reason: "Do not overwrite",
		}, createHostContext().ctx)).rejects.toThrow(/empty/);
		expect(readFileSync(join(occupied, "notes.txt"), "utf8")).toBe("keep me\n");
	});

	it("commits one exact non-secret model bootstrap resolved from the trusted host catalog", async () => {
		const projectDir = root("ahde-cycle-configure-");
		process.env[CREDENTIAL_ENV] = "fixture";
		const host = createHostContext({ catalog, credentialEnv: CREDENTIAL_ENV });
		const projectTools = tools(projectDir);
		await decide(projectTools, { kind: "scaffold-target", reason: "Start the Target" }, host.ctx);

		const configured = await decide(projectTools, {
			kind: "configure-target",
			targetId: "demo-agent",
			model: { provider: PROVIDER, modelId: MODEL_ID, thinkingLevel: "off", timeoutMs: 120_000 },
			reason: "Use this exact local model",
		}, host.ctx);
		expect(configured.result).toMatchObject({ targetId: "demo-agent", credentialEnv: CREDENTIAL_ENV });
		expect(configured.result.targetGitSha).toMatch(/^[0-9a-f]{40}$/);
		expect(configured.view.target).toMatchObject({ status: "ready", id: "demo-agent" });
		expect(readFileSync(join(projectDir, "manifest.yaml"), "utf8")).toContain("id: demo-agent");
		// The credential value is host-owned; only its variable name is ever recorded.
		expect(JSON.stringify(configured)).not.toContain("fixture");

		const otherDir = root("ahde-cycle-missing-model-");
		const otherTools = tools(otherDir);
		await decide(otherTools, { kind: "scaffold-target", reason: "Start the Target" }, host.ctx);
		await expect(decide(otherTools, {
			kind: "configure-target",
			targetId: "demo-agent",
			model: { provider: PROVIDER, modelId: "absent-model" },
			reason: "Reject an unavailable model",
		}, host.ctx)).rejects.toThrow(/not available in the trusted host catalog/);
	});

	it("fails every consequential decision closed when the host has no local TUI", async () => {
		const projectDir = root("ahde-cycle-fail-closed-");
		expect(CONSEQUENTIAL_BUILDER_TOOL_NAMES).toEqual(["ahde_workbench_decide"]);
		for (const mode of ["print", "rpc"] as const) {
			const host = createHostContext({ hasUI: mode === "rpc", mode });
			await expect(decide(tools(projectDir), {
				kind: "scaffold-target",
				reason: "Start the Target",
			}, host.ctx)).rejects.toThrow(/RPC, print, and JSON execution fail closed/);
			expect(host.confirmations).toEqual([]);
			expect(readdirSync(projectDir)).toEqual([]);
		}
	});

	it("refuses a decision that is not legal at the current stage", async () => {
		const projectDir = root("ahde-cycle-illegal-");
		const host = createHostContext();
		await expect(decide(tools(projectDir), {
			kind: "approve-spec",
			reason: "Approve before the Target exists",
		}, host.ctx)).rejects.toThrow(/approve-spec is not legal during target-setup/);
		expect(host.confirmations).toEqual([]);
	});

	it("counts every sealed corpus in the view without ever naming one", async () => {
		const projectDir = root("ahde-cycle-sealed-");
		const stateRoot = join(projectDir, ".ahde");
		const host = createHostContext();
		const projectTools = tools(projectDir, "sealed-agent");
		for (let index = 0; index < 3; index += 1) {
			createCorpus({
				stateRoot,
				projectId: "sealed-agent",
				name: `evaluator-only-${index}`,
				visibility: "sealed",
				tasks: [{
					id: `sealed-task-${index}`,
					input: `private case ${index}`,
					graders: [{ type: "output_contains", text: "private" }],
				}],
			});
		}
		const view = await invokeTool(projectTools, "ahde_workbench_view", {}, host.ctx);
		expect(view.counts.sealedCorpora).toBe(3);
		// The model-facing projection omits selections unless the view asks for them.
		expect(view.selections).toBeUndefined();
		const modelVisible = JSON.stringify(view);
		for (const secret of ["evaluator-only-", "private case", "sealed-task-", "corpus-"]) {
			expect(modelVisible).not.toContain(secret);
		}
	});
});
