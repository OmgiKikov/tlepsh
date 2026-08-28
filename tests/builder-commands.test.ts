import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	AHDE_BUILDER_COMMAND_NAMES,
	registerAhdeBuilderCommands,
} from "../src/builder/commands.js";
import { createRunProgressPresenter } from "../src/builder/run-progress.js";
import type { RunEvent, RunEventIdentity } from "../src/run-events.js";
import type {
	WorkbenchConfirmation,
	WorkbenchDecisionInput,
	WorkbenchDecisionResult,
	WorkbenchHumanGate,
	WorkbenchView,
} from "../src/workbench/types.js";

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;
type CommandWorkbench = Parameters<typeof registerAhdeBuilderCommands>[1]["workbench"];

const baseView: WorkbenchView = {
	schemaVersion: 1,
	project: { id: "demo", directory: "/tmp/ahde-demo" },
	stage: "ready-to-evaluate",
	headline: "Development corpus is ready.",
	target: { status: "ready", id: "target-demo", gitSha: "a".repeat(40) },
	focus: {},
	selections: [],
	actions: ["run development eval"],
	blockers: [],
	warnings: [],
	counts: {
		specDrafts: 1,
		approvedSpecs: 1,
		corpusDrafts: 1,
		developmentCorpora: 1,
		sealedCorpora: 1,
		developmentEvals: 0,
		openProposals: 0,
		candidates: 0,
	},
};

function decision(
	kind: WorkbenchDecisionInput["kind"],
	result: Record<string, unknown> = { ok: true },
): WorkbenchDecisionResult {
	return { kind, message: `${kind} completed`, result, view: baseView };
}

function register(
	workbench: CommandWorkbench,
	actorId = vi.fn(() => "local:test-operator"),
): {
	registered: Array<{ name: string; options: CommandOptions }>;
	commands: Map<string, CommandOptions>;
	actorId: ReturnType<typeof vi.fn<() => string>>;
} {
	const registered: Array<{ name: string; options: CommandOptions }> = [];
	registerAhdeBuilderCommands({
		registerCommand(name: string, options: CommandOptions) {
			registered.push({ name, options });
		},
	} as unknown as ExtensionAPI, { workbench, actorId });
	return {
		registered,
		commands: new Map(registered.map(({ name, options }) => [name, options])),
		actorId,
	};
}

function context(options: {
	hasUI?: boolean;
	mode?: "tui" | "rpc" | "json" | "print";
	signal?: AbortSignal;
	waitForIdle?: () => Promise<void>;
	confirm?: (title: string, message: string, options?: { signal?: AbortSignal }) => Promise<boolean>;
	select?: (title: string, choices: string[], options?: { signal?: AbortSignal }) => Promise<string | undefined>;
} = {}): {
	ctx: ExtensionCommandContext;
	waitForIdle: ReturnType<typeof vi.fn<() => Promise<void>>>;
	confirm: ReturnType<typeof vi.fn>;
	select: ReturnType<typeof vi.fn>;
	notify: ReturnType<typeof vi.fn>;
	setStatus: ReturnType<typeof vi.fn>;
	setWidget: ReturnType<typeof vi.fn>;
} {
	const waitForIdle = vi.fn(options.waitForIdle ?? (async () => undefined));
	const confirm = vi.fn(options.confirm ?? (async () => false));
	const select = vi.fn(options.select ?? (async () => undefined));
	const notify = vi.fn();
	const setStatus = vi.fn();
	const setWidget = vi.fn();
	return {
		ctx: {
			hasUI: options.hasUI ?? true,
			mode: options.mode ?? "tui",
			signal: options.signal,
			waitForIdle,
			ui: { confirm, select, notify, setStatus, setWidget },
		} as unknown as ExtensionCommandContext,
		waitForIdle,
		confirm,
		select,
		notify,
		setStatus,
		setWidget,
	};
}

const runIdentity: RunEventIdentity = {
	evalRunId: "eval-development",
	runId: "run-development-1",
	taskId: "task-routing",
	repetitionIndex: 0,
	ordinal: 1,
	total: 1,
};

type RunEventInput<Event> = Event extends RunEvent
	? Omit<Event, "at" | "run">
	: never;

function runEvent(event: RunEventInput<RunEvent>): RunEvent {
	return {
		...event,
		at: "2026-08-28T10:00:00.000Z",
		run: runIdentity,
	} as RunEvent;
}

function workbench(options: {
	view?: (query: Parameters<CommandWorkbench["view"]>[0]) => Promise<WorkbenchView>;
	decide?: CommandWorkbench["decide"];
} = {}): {
	value: CommandWorkbench;
	view: ReturnType<typeof vi.fn>;
	decide: ReturnType<typeof vi.fn>;
} {
	const view = vi.fn(options.view ?? (async () => baseView));
	const decide = vi.fn(options.decide ?? (async (input: WorkbenchDecisionInput) => decision(input.kind)));
	return { value: { view, decide } as unknown as CommandWorkbench, view, decide };
}

function command(
	commands: Map<string, CommandOptions>,
	name: string,
): CommandOptions {
	const found = commands.get(name);
	if (!found) throw new Error(`missing /${name}`);
	return found;
}

describe("Builder Pi slash commands", () => {
	it("registers exactly the seven commands in the stable public order", () => {
		const fixture = workbench();
		const registered = register(fixture.value).registered;

		expect(AHDE_BUILDER_COMMAND_NAMES).toEqual([
			"status",
			"run",
			"traces",
			"review",
			"apply",
			"discard",
			"target",
		]);
		expect(registered.map(({ name }) => name)).toEqual(AHDE_BUILDER_COMMAND_NAMES);
		expect(registered).toHaveLength(7);
		expect(registered.every(({ options }) => options.description && options.handler)).toBe(true);
	});

	it("maps read-only commands to their exact Workbench view aspects", async () => {
		const fixture = workbench();
		const { commands } = register(fixture.value);
		const host = context();

		for (const name of ["status", "traces", "review", "target"] as const) {
			await command(commands, name).handler("", host.ctx);
		}

		expect(fixture.view.mock.calls.map(([query]) => query)).toEqual([
			{ aspect: "summary" },
			{ aspect: "traces" },
			{ aspect: "review" },
			{ aspect: "target" },
		]);
		expect(host.waitForIdle).toHaveBeenCalledTimes(4);
		expect(host.notify).toHaveBeenCalledTimes(4);
		expect(host.notify).toHaveBeenLastCalledWith(
			expect.stringContaining("AHDE · ready-to-evaluate"),
			"info",
		);

		await expect(command(commands, "status").handler("unexpected", host.ctx))
			.rejects.toThrow("/status does not accept arguments");
		expect(fixture.view).toHaveBeenCalledTimes(4);
	});

	it("routes /run to run-current and parses repetitions plus a human-readable reason", async () => {
		const fixture = workbench();
		const { commands } = register(fixture.value);
		const controller = new AbortController();
		const host = context({ signal: controller.signal });

		await command(commands, "run").handler("3 investigate routing", host.ctx);
		await command(commands, "run").handler("", host.ctx);

		expect(fixture.decide).toHaveBeenNthCalledWith(
			1,
			{ kind: "run-current", repetitions: 3, reason: "investigate routing" },
			expect.objectContaining({ confirm: expect.any(Function), selectSealed: expect.any(Function) }),
			{ signal: controller.signal, onRunEvent: expect.any(Function) },
		);
		expect(fixture.decide).toHaveBeenNthCalledWith(
			2,
			{
				kind: "run-current",
				repetitions: 1,
				reason: "Requested interactively via /run",
			},
			expect.any(Object),
			{ signal: controller.signal, onRunEvent: expect.any(Function) },
		);
		expect(host.notify).toHaveBeenCalledWith(
			expect.stringContaining("run-current completed"),
			"info",
		);

		await expect(command(commands, "run").handler("11 too many", host.ctx))
			.rejects.toThrow("/run repetitions must be an integer between 1 and 10");
		expect(fixture.decide).toHaveBeenCalledTimes(2);
	});

	it("shows one provisional live widget without replacing the final decision output", async () => {
		const fixture = workbench({
			decide: async (input, _gate, options) => {
				const emit = options?.onRunEvent;
				expect(emit).toEqual(expect.any(Function));
				emit?.(runEvent({ type: "run_started" }));
				emit?.(runEvent({ type: "assistant_delta", delta: "Inspecting ", truncated: false }));
				emit?.(runEvent({ type: "assistant_delta", delta: "the route.", truncated: false }));
				emit?.(runEvent({
					type: "tool_started",
					toolCallId: "tool-1",
					toolName: "bash",
					arguments: "{\"command\":\"pwd\"}",
					truncated: false,
				}));
				emit?.(runEvent({
					type: "tool_finished",
					toolCallId: "tool-1",
					toolName: "bash",
					isError: false,
					output: "/tmp/ahde-demo",
					truncated: false,
				}));
				return decision(input.kind, { retained: "final decision payload" });
			},
		});
		const { commands } = register(fixture.value);
		const host = context();

		await command(commands, "run").handler("", host.ctx);

		const visibleWidgets = host.setWidget.mock.calls
			.map(([, content]) => content)
			.filter((content): content is string[] => Array.isArray(content));
		const visible = visibleWidgets.at(-1) ?? [];
		expect(visible.join("\n")).toContain("provisional development trace");
		expect(visible.join("\n")).toContain("assistant · Inspecting the route.");
		expect(visible.join("\n")).toContain("tool → bash · {\"command\":\"pwd\"}");
		expect(visible.join("\n")).toContain("tool ✓ bash · /tmp/ahde-demo");
		expect(new Set(host.setStatus.mock.calls.map(([key]) => key))).toEqual(new Set(["ahde-run-progress"]));
		expect(new Set(host.setWidget.mock.calls.map(([key]) => key))).toEqual(new Set(["ahde-run-progress"]));
		expect(host.setStatus).toHaveBeenLastCalledWith("ahde-run-progress", undefined);
		expect(host.setWidget).toHaveBeenLastCalledWith("ahde-run-progress", undefined);
		expect(host.notify).toHaveBeenCalledTimes(1);
		expect(host.notify).toHaveBeenCalledWith(
			expect.stringMatching(/run-current completed[\s\S]*"retained": "final decision payload"/),
			"info",
		);
	});

	it("keeps every live widget frame within 40 physical lines and 32 KiB", () => {
		const setStatus = vi.fn();
		const setWidget = vi.fn();
		const progress = createRunProgressPresenter({ setStatus, setWidget });

		progress.onRunEvent(runEvent({ type: "run_started" }));
		for (let index = 0; index < 80; index += 1) {
			progress.onRunEvent(runEvent({
				type: "assistant_delta",
				delta: `line-${index}\n`,
				truncated: false,
			}));
		}
		for (let index = 0; index < 20; index += 1) {
			progress.onRunEvent(runEvent({
				type: "tool_started",
				toolCallId: `tool-${index}`,
				toolName: "bash",
				arguments: `${index}:${"x".repeat(4_096)}`,
				truncated: false,
			}));
		}

		const frames = setWidget.mock.calls
			.map(([, content]) => content)
			.filter((content): content is string[] => Array.isArray(content));
		expect(frames.length).toBeGreaterThan(1);
		for (const frame of frames) {
			expect(frame.length).toBeLessThanOrEqual(40);
			expect(frame.every((line) => !/[\r\n]/.test(line))).toBe(true);
			expect(Buffer.byteLength(frame.join("\n"), "utf8")).toBeLessThanOrEqual(32 * 1024);
		}
		progress.dispose();
	});

	it("strips terminal control channels from untrusted live text", () => {
		const setStatus = vi.fn();
		const setWidget = vi.fn();
		const progress = createRunProgressPresenter({ setStatus, setWidget });

		progress.onRunEvent(runEvent({
			type: "assistant_delta",
			delta: "before\u001b]52;c;CLIPBOARD_CANARY\u0007after",
			truncated: false,
		}));
		progress.onRunEvent(runEvent({
			type: "tool_started",
			toolCallId: "tool-control",
			toolName: "safe\u001b[31m-name",
			arguments: "left\u001b_APC_CANARY\u001b\\right",
			truncated: false,
		}));

		const rendered = JSON.stringify({
			statuses: setStatus.mock.calls,
			widgets: setWidget.mock.calls,
		});
		expect(rendered).not.toContain("\u001b");
		expect(rendered).not.toContain("CLIPBOARD_CANARY");
		expect(rendered).not.toContain("APC_CANARY");
		expect(rendered).toContain("beforeafter");
		expect(rendered).toContain("safe-name");
		expect(rendered).toContain("leftright");
		progress.dispose();
	});

	it.each([
		{ label: "error", message: "runner failed", abort: false },
		{ label: "abort", message: "run cancelled", abort: true },
	])("cleans live UI after a run $label", async ({ message, abort }) => {
		const controller = new AbortController();
		const fixture = workbench({
			decide: async (_input, _gate, options) => {
				options?.onRunEvent?.(runEvent({ type: "run_started" }));
				const failure = new Error(message);
				if (abort) controller.abort(failure);
				throw failure;
			},
		});
		const { commands } = register(fixture.value);
		const host = context({ signal: controller.signal });

		await expect(command(commands, "run").handler("", host.ctx)).rejects.toThrow(message);
		expect(host.setStatus).toHaveBeenLastCalledWith("ahde-run-progress", undefined);
		expect(host.setWidget).toHaveBeenLastCalledWith("ahde-run-progress", undefined);
		expect(host.notify).not.toHaveBeenCalled();
	});

	it("parses /apply and /discard without requiring artifact ids from the user", async () => {
		const fixture = workbench();
		const { commands } = register(fixture.value);
		const host = context();

		await command(commands, "apply").handler("candidate/routing verify the fix", host.ctx);
		await command(commands, "discard").handler("wrong root cause", host.ctx);
		await command(commands, "discard").handler("   ", host.ctx);

		expect(fixture.decide.mock.calls.map(([input]) => input)).toEqual([
			{
				kind: "apply-proposal",
				branch: "candidate/routing",
				reason: "verify the fix",
			},
			{ kind: "discard-proposal", reason: "wrong root cause" },
			{ kind: "discard-proposal", reason: "Requested interactively via /discard" },
		]);

		await expect(command(commands, "apply").handler("", host.ctx))
			.rejects.toThrow("usage: /apply <branch> [reason]");
		await expect(command(commands, "apply").handler("-invalid", host.ctx))
			.rejects.toThrow("/apply branch must be one bounded Git branch name");
		expect(fixture.decide).toHaveBeenCalledTimes(3);
	});

	it("uses /discard as the explicit recovery gate for an interrupted candidate", async () => {
		const interruptedView: WorkbenchView = {
			...baseView,
			stage: "candidate-verification",
			detail: {
				aspect: "review",
				content: { kind: "interrupted-candidate", candidateId: "candidate-stopped", status: "validated" },
			},
		};
		const fixture = workbench({ view: async () => interruptedView });
		const { commands } = register(fixture.value);
		await command(commands, "discard").handler("retry from exact apply receipt", context().ctx);
		expect(fixture.decide).toHaveBeenCalledWith(
			{
				kind: "abandon-candidate",
				candidateId: "candidate-stopped",
				reason: "retry from exact apply receipt",
			},
			expect.any(Object),
			{ signal: undefined },
		);
	});

	it("waits for the agent to become idle before reading or mutating Workbench state", async () => {
		const events: string[] = [];
		const fixture = workbench({
			view: async () => {
				events.push("view");
				return baseView;
			},
			decide: async (input) => {
				events.push("decide");
				return decision(input.kind);
			},
		});
		const { commands } = register(fixture.value);
		const host = context({
			waitForIdle: async () => {
				events.push("idle");
			},
		});

		await command(commands, "status").handler("", host.ctx);
		await command(commands, "run").handler("", host.ctx);
		expect(events).toEqual(["idle", "view", "idle", "decide"]);

		const aborted = new AbortController();
		const abortedFixture = workbench();
		const abortedCommands = register(abortedFixture.value).commands;
		const abortedHost = context({
			signal: aborted.signal,
			waitForIdle: async () => {
				aborted.abort(new Error("stopped while waiting"));
			},
		});
		await expect(command(abortedCommands, "run").handler("", abortedHost.ctx))
			.rejects.toThrow("stopped while waiting");
		expect(abortedFixture.decide).not.toHaveBeenCalled();
	});

	it("fails closed for every command outside the local TUI", async () => {
		const fixture = workbench();
		const { commands } = register(fixture.value);
		const invocations: Array<[string, string]> = [
			["status", ""],
			["run", ""],
			["traces", ""],
			["review", ""],
			["apply", "candidate/fix"],
			["discard", ""],
			["target", ""],
		];

		for (const settings of [
			{ hasUI: false, mode: "print" as const },
			{ hasUI: true, mode: "rpc" as const },
			{ hasUI: true, mode: "json" as const },
			{ hasUI: false, mode: "tui" as const },
		]) {
			const host = context(settings);
			for (const [name, args] of invocations) {
				await expect(command(commands, name).handler(args, host.ctx))
					.rejects.toThrow(`/${name} requires the local Builder Pi TUI`);
			}
			expect(host.waitForIdle).not.toHaveBeenCalled();
			expect(host.notify).not.toHaveBeenCalled();
			expect(host.confirm).not.toHaveBeenCalled();
			expect(host.select).not.toHaveBeenCalled();
		}

		expect(fixture.view).not.toHaveBeenCalled();
		expect(fixture.decide).not.toHaveBeenCalled();
	});

	it("derives the human actor lazily, caches it, and forwards the command signal to confirmation", async () => {
		const confirmation: WorkbenchConfirmation = {
			kind: "apply-proposal",
			title: "Apply exact proposal",
			reason: "Observed routing failure",
			subject: { runId: "builder-routing", changes: 2 },
			subjectHash: `sha256:${"b".repeat(64)}`,
		};
		const controller = new AbortController();

		const declinedActor = vi.fn(() => "local:must-not-be-read");
		const declinedWorkbench = workbench({
			decide: async (input, gate, options) => {
				const approval = await gate.confirm(confirmation, options?.signal);
				return decision(input.kind, { approval });
			},
		});
		const declinedCommands = register(declinedWorkbench.value, declinedActor).commands;
		const declinedHost = context({
			signal: controller.signal,
			confirm: async () => false,
		});
		await command(declinedCommands, "apply").handler("candidate/routing", declinedHost.ctx);
		expect(declinedActor).not.toHaveBeenCalled();
		expect(declinedHost.confirm).toHaveBeenCalledWith(
			"Apply exact proposal",
			expect.stringMatching(/Reason: Observed routing failure[\s\S]*Exact subject hash: sha256:/),
			{ signal: controller.signal },
		);

		const approvedActor = vi.fn(() => "local:alice");
		const approvedWorkbench = workbench({
			decide: async (input, gate, options) => {
				const first = await gate.confirm(confirmation, options?.signal);
				const second = await gate.confirm(confirmation, options?.signal);
				return decision(input.kind, { first, second });
			},
		});
		const approvedCommands = register(approvedWorkbench.value, approvedActor).commands;
		const approvedHost = context({
			signal: controller.signal,
			confirm: async () => true,
		});
		await command(approvedCommands, "apply").handler("candidate/routing", approvedHost.ctx);
		expect(approvedActor).toHaveBeenCalledTimes(1);
		expect(approvedHost.confirm).toHaveBeenCalledTimes(2);
		expect(approvedWorkbench.decide).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "apply-proposal" }),
			expect.any(Object),
			{ signal: controller.signal },
		);
		expect(approvedHost.notify).toHaveBeenCalledWith(
			expect.stringContaining('"actorId": "local:alice"'),
			"info",
		);
	});

	it("returns only an opaque sealed-choice index and treats selector cancellation as denial", async () => {
		const options = [
			{ label: "Holdout A", taskCount: 5 },
			{ label: "Holdout B", taskCount: 7 },
		] as const;
		const controller = new AbortController();
		const choosingWorkbench = workbench({
			decide: async (input, gate: WorkbenchHumanGate, commandOptions) => {
				const choice = await gate.selectSealed(
					{ title: "Choose sealed holdout", options },
					commandOptions?.signal,
				);
				return decision(input.kind, { choice });
			},
		});
		const choosingActor = vi.fn(() => "local:alice");
		const choosingCommands = register(choosingWorkbench.value, choosingActor).commands;
		const choosingHost = context({
			signal: controller.signal,
			select: async () => "2. Holdout B · 7 tasks",
		});

		await command(choosingCommands, "run").handler("", choosingHost.ctx);
		expect(choosingHost.select).toHaveBeenCalledWith(
			"Choose sealed holdout",
			["1. Holdout A · 5 tasks", "2. Holdout B · 7 tasks"],
			{ signal: controller.signal },
		);
		expect(choosingActor).toHaveBeenCalledTimes(1);
		expect(choosingHost.notify).toHaveBeenCalledWith(
			expect.stringContaining('"selectedIndex": 1'),
			"info",
		);

		const cancelledActor = vi.fn(() => "local:must-not-be-read");
		const cancelledWorkbench = workbench({
			decide: async (input, gate, commandOptions) => {
				const choice = await gate.selectSealed(
					{ title: "Choose sealed holdout", options },
					commandOptions?.signal,
				);
				return decision(input.kind, { choice });
			},
		});
		const cancelledCommands = register(cancelledWorkbench.value, cancelledActor).commands;
		const cancelledHost = context({ select: async () => undefined });
		await command(cancelledCommands, "run").handler("", cancelledHost.ctx);
		expect(cancelledActor).not.toHaveBeenCalled();
		expect(cancelledHost.notify).toHaveBeenCalledWith(
			expect.stringContaining('"approved": false'),
			"info",
		);
	});
});
