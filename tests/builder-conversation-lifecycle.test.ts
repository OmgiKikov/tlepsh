import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { afterEach, expect, it, vi } from "vitest";
import { createAhdeBuilderExtension } from "../src/builder/extension.js";
import { createBuilderHostActions, builderHostActionTool } from "../src/builder/host-actions.js";
import { createBuilderJobs } from "../src/builder/jobs.js";
import { AhdeWorkbench, createAhdeWorkbench } from "../src/workbench/workbench.js";
import type { WorkbenchDecisionResult } from "../src/workbench/types.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

async function session(withCompletionChannel = true) {
	const projectDir = mkdtempSync(join(tmpdir(), "ahde-conversation-")); roots.push(projectDir);
	const options = { projectDir, stateRoot: join(projectDir, ".ahde"), runsRoot: join(projectDir, "runs"), projectId: "test" };
	const view = await createAhdeWorkbench(options).view();
	const read = vi.spyOn(AhdeWorkbench.prototype, "view").mockResolvedValue(view);
	const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
	const notes = vi.fn();
	const entries = vi.fn();
	const context = {
		hasUI: true, mode: "tui", isIdle: () => false,
		// A tool must never await the end of the very model turn calling it.
		waitForIdle: vi.fn(() => new Promise<void>(() => undefined)),
		ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn(), confirm: vi.fn(async () => true), input: vi.fn(), select: vi.fn() },
	} as unknown as ExtensionCommandContext;
	await createAhdeBuilderExtension(options)({
		on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => {
			const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list);
		},
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => commands.set(name, command),
		registerMessageRenderer: () => undefined,
		appendEntry: entries, ...(withCompletionChannel ? { sendMessage: notes } : {}),
	} as never);
	const fire = async (name: string, event: object = {}) => {
		const results: unknown[] = [];
		for (const handler of handlers.get(name) ?? []) results.push(await handler(event as never, context));
		return results;
	};
	const call = async (name: string, input: object) => {
		const guarded = await fire("tool_call", { toolName: name, input });
		const refusal = guarded.find((result) => result && typeof result === "object" && "block" in result);
		if (refusal) return refusal;
		return tools.get(name)!.execute("call", input as never, undefined, undefined, context);
	};
	return { view, read, fire, call, tools, commands, notes, entries, context };
}

it("keeps the durable result in the foreground when the host has no completion channel", async () => {
	const host = await session(false);
	let finish!: (value: WorkbenchDecisionResult) => void;
	vi.spyOn(AhdeWorkbench.prototype, "decide").mockImplementation(async (_input, gate, execution) => {
		await gate.confirm({ kind: "verify-candidate", title: "Verify", question: "Verify?", reason: "test",
			subject: {}, subjectHash: `sha256:${"a".repeat(64)}`, policy: "routine" }, execution?.signal);
		return await new Promise<WorkbenchDecisionResult>((resolve) => { finish = resolve; });
	});
	let returned = false;
	const pending = host.call("ahde_workbench_decide", { kind: "run-current", repetitions: 3, reason: "Test it" })
		.then((result) => { returned = true; return result; });
	await drain();
	expect(returned).toBe(false);
	expect(host.notes).not.toHaveBeenCalled();
	finish({ kind: "approve-spec", message: "saved", result: { approvedSpecId: "spec", receiptId: "receipt" }, view: host.view });
	expect(await pending).toMatchObject({ details: { kind: "approve-spec", result: { approvedSpecId: "spec", receiptId: "receipt" } } });
	expect(host.context.waitForIdle).not.toHaveBeenCalled();
	expect(host.notes).not.toHaveBeenCalled();
	await host.fire("session_shutdown");
});

it("refreshes ephemeral pre-turn context and shares a natural job with command status, stop and completion hooks", async () => {
	const host = await session();
	const first = await host.fire("before_agent_start", { systemPrompt: "Base prompt", prompt: "Test it" });
	expect(first[0]).toMatchObject({ systemPrompt: expect.stringContaining("Base prompt") });
	expect(first[0]).not.toHaveProperty("message");
	let signal: AbortSignal | undefined;
	vi.spyOn(AhdeWorkbench.prototype, "decide").mockImplementation(async (_input, gate, execution) => {
		signal = execution?.signal;
		await gate.confirm({ kind: "verify-candidate", title: "Verify", question: "Verify?", reason: "test",
			subject: {}, subjectHash: `sha256:${"a".repeat(64)}`, policy: "routine",
		}, signal);
		return await new Promise<WorkbenchDecisionResult>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason)));
	});
	const started = await host.call("ahde_workbench_decide", { kind: "run-current", repetitions: 3, reason: "Test it" });
	expect(started).toMatchObject({ details: { kind: "active-job", status: "running", job: { state: "running" } } });
	await host.commands.get("jobs")!.handler("", host.context);
	expect(JSON.stringify(host.entries.mock.calls)).toContain("candidate verification");
	expect(host.context.waitForIdle).not.toHaveBeenCalled();
	expect(await host.call("ahde_workbench_submit", { kind: "workshop-open" })).toMatchObject({ block: true });
	expect(await host.call("ahde_workshop_write", { path: "AGENTS.md", content: "surprise" })).toMatchObject({ block: true });
	expect(await host.call("ahde_host_action", { kind: "jobs" })).toMatchObject({ details: { kind: "jobs" } });
	await host.call("ahde_host_action", { kind: "stop" });
	await drain();
	expect(signal?.aborted).toBe(true);
	expect(host.notes).not.toHaveBeenCalled();
	// The new direction sees current facts, not a second persisted old snapshot.
	host.read.mockResolvedValue({ ...host.view, warnings: ["fresh state after the operator changed direction"] });
	const second = await host.fire("before_agent_start", { systemPrompt: "Base prompt", prompt: "Now focus on refunds" });
	expect(second[0]).toMatchObject({ systemPrompt: expect.stringContaining("fresh state after the operator changed direction") });
	expect(second[0]).toMatchObject({ systemPrompt: expect.stringContaining("Active operation: null") });
	await host.fire("agent_settled");
	await drain();
	expect(host.notes).toHaveBeenCalledTimes(1);
	expect(JSON.stringify(host.notes.mock.calls)).toContain("Completed changes and artifacts remain saved");
	expect(JSON.stringify(host.notes.mock.calls)).not.toContain("Nothing was decided");
	await host.fire("session_shutdown");
});

it("aborts the shared operation at actual session shutdown and suppresses its late completion turn", async () => {
	const host = await session();
	await host.fire("before_agent_start", { systemPrompt: "Base prompt" });
	let signal: AbortSignal | undefined;
	let finish!: (value: WorkbenchDecisionResult) => void;
	vi.spyOn(AhdeWorkbench.prototype, "decide").mockImplementation(async (_input, gate, execution) => {
		signal = execution?.signal;
		await gate.confirm({ kind: "verify-candidate", title: "Verify", question: "Verify?", reason: "test",
			subject: {}, subjectHash: `sha256:${"a".repeat(64)}`, policy: "routine" }, signal);
		return await new Promise<WorkbenchDecisionResult>((resolve) => { finish = resolve; });
	});
	await host.call("ahde_workbench_decide", { kind: "run-current", repetitions: 3, reason: "Test it" });
	await host.fire("session_shutdown");
	expect(signal?.aborted).toBe(true);
	finish({ kind: "approve-spec", message: "saved", result: { approvedSpecId: "spec", receiptId: "receipt" }, view: host.view });
	await drain();
	await host.fire("agent_settled");
	expect(host.notes).not.toHaveBeenCalled();
});

it("keeps private exam paths inside host dialogs and rejects generic commands and approval fields", async () => {
	const host = await session();
	const imported = vi.fn(() => ({ taskCount: 20 }));
	const jobs = createBuilderJobs({ host: { setStatus: vi.fn(), show: vi.fn(), note: vi.fn(), waitForIdle: async () => undefined } });
	const actions = createBuilderHostActions({
		workbench: createAhdeWorkbench({ projectDir: "/tmp", stateRoot: "/tmp/state", runsRoot: "/tmp/runs", projectId: "test" }),
		jobs, presenter: { show: () => { throw new Error("panel closed"); }, note: vi.fn() }, importSealedHoldout: imported,
		onWorkbenchChanged: () => { throw new Error("refresh failed after durable import"); },
	});
	const tool = builderHostActionTool(actions);
	for (const input of [{ kind: "command", text: "/ship" }, { kind: "import-exam", path: "/private/exam.jsonl" }, { kind: "import-exam", approved: true }]) {
		expect(Check(tool.parameters, input)).toBe(false);
	}
	vi.mocked(host.context.ui.input).mockResolvedValueOnce("/private/customer-canary.jsonl").mockResolvedValueOnce("private-name-canary");
	const result = await tool.execute("private", { kind: "import-exam" }, undefined, undefined, host.context);
	expect(imported).toHaveBeenCalledWith({ sourcePath: "/private/customer-canary.jsonl", name: "private-name-canary" });
	expect(JSON.stringify(result)).not.toMatch(/customer-canary|private-name-canary/);
	expect(host.context.waitForIdle).not.toHaveBeenCalled();
	const controller = new AbortController();
	vi.mocked(host.context.ui.input).mockImplementationOnce(async (_title, _placeholder, options) => {
		expect(options?.signal).toBe(controller.signal);
		controller.abort(new Error("changed direction"));
		return "/private/cancelled-canary.jsonl";
	});
	await expect(tool.execute("private", { kind: "import-exam" }, controller.signal, undefined, host.context)).rejects.toThrow("details were shown only to the operator");
	expect(imported).toHaveBeenCalledTimes(1);
	// Cancellation at the path prompt must not leave a second private question open.
	expect(host.context.ui.input).toHaveBeenCalledTimes(3);
	imported.mockImplementation(() => { throw new Error("failed /private/error-canary.jsonl"); });
	vi.mocked(host.context.ui.input).mockResolvedValueOnce("/private/customer-canary.jsonl").mockResolvedValueOnce("private-name-canary");
	await expect(tool.execute("private", { kind: "import-exam" }, undefined, undefined, host.context)).rejects.toThrow("details were shown only to the operator");
});
