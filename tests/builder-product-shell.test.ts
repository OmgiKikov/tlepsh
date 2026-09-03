import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { ahdeCommandsFirst, installAhdeBuilderProductShell } from "../src/builder/product-shell.js";
import { AHDE_TRANSCRIPT_ENTRY_TYPE } from "../src/builder/transcript.js";
import type { WorkbenchView } from "../src/workbench/types.js";

function view(overrides: Partial<WorkbenchView> = {}): WorkbenchView {
	return {
		schemaVersion: 1,
		project: { id: "demo", directory: "demo" },
		stage: "target-setup",
		headline: "Create the Target harness.",
		target: { status: "missing", id: null, gitSha: null, model: null },
		focus: {},
		selections: [],
		actions: ["scaffold-target"],
		blockers: ["Target harness is missing."],
		warnings: [],
		calibration: null,
		counts: {
			specDrafts: 0,
			approvedSpecs: 0,
			corpusDrafts: 0,
			developmentCorpora: 0,
			sealedCorpora: 0,
			developmentEvals: 0,
			openProposals: 0,
			candidates: 0,
			calibrations: 0,
		},
		...overrides,
	};
}

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

type Handler = (...args: never[]) => unknown;

function install(
	workbenchView: () => Promise<WorkbenchView>,
	decide?: (input: { kind: string }) => Promise<unknown>,
): {
	handlers: Map<string, Handler>;
	registerEntryRenderer: ReturnType<typeof vi.fn>;
	sendUserMessage: ReturnType<typeof vi.fn>;
	controller: ReturnType<typeof installAhdeBuilderProductShell>;
} {
	const handlers = new Map<string, Handler>();
	const registerEntryRenderer = vi.fn();
	const sendUserMessage = vi.fn();
	const workbench = decide ? { view: workbenchView, decide } : { view: workbenchView };
	const controller = installAhdeBuilderProductShell(
		{
			on: (event: string, handler: Handler) => handlers.set(event, handler),
			registerEntryRenderer,
			appendEntry: vi.fn(),
			sendUserMessage,
		} as unknown as ExtensionAPI,
		workbench as never,
		decide ? { actorId: () => "local:test-operator" } : {},
	);
	return { handlers, registerEntryRenderer, sendUserMessage, controller };
}

function host(options: {
	model?: { provider: string; id: string } | undefined;
	credentialPresent?: boolean;
	select?: (title: string, choices: string[]) => Promise<string | undefined>;
} = {}): {
	ctx: ExtensionContext;
	ui: Record<string, ReturnType<typeof vi.fn>>;
	requestRender: ReturnType<typeof vi.fn>;
	renderHeader: (width?: number) => string[];
} {
	const requestRender = vi.fn();
	let factory: ((tui: unknown, theme: Theme) => { render(width: number): string[] }) | undefined;
	const ui = {
		setTitle: vi.fn(),
		setStatus: vi.fn(),
		setWorkingMessage: vi.fn(),
		notify: vi.fn(),
		setEditorText: vi.fn(),
		addAutocompleteProvider: vi.fn(),
		input: vi.fn(async (_label: string, suggested: string) => suggested),
		select: vi.fn(options.select ?? (async () => "Not now")),
		setHeader: vi.fn((input: (tui: unknown, theme: Theme) => { render(width: number): string[] }) => {
			factory = input;
		}),
	};
	const ctx = {
		mode: "tui",
		model: "model" in options ? options.model : { provider: "openai", id: "gpt-test" },
		modelRegistry: {
			hasConfiguredAuth: vi.fn(() => options.credentialPresent ?? true),
			getAvailable: vi.fn(() => [{ provider: "openai", id: "gpt-test" }, { provider: "anthropic", id: "claude-test" }]),
			find: vi.fn(() => undefined),
		},
		ui,
	} as unknown as ExtensionContext;
	return {
		ctx,
		ui,
		requestRender,
		renderHeader: (width = 200) => {
			if (!factory) throw new Error("header was not installed");
			return factory({ requestRender }, theme).render(width);
		},
	};
}

async function start(handlers: Map<string, Handler>, ctx: ExtensionContext, reason = "startup"): Promise<void> {
	await handlers.get("session_start")?.({ type: "session_start", reason } as never, ctx as never);
}

describe("AHDE Builder product shell", () => {
	it("replaces Pi onboarding with AHDE identity, live state, and conversational guidance", async () => {
		const { handlers, registerEntryRenderer } = install(async () => view());
		const h = host({ credentialPresent: true });
		await start(handlers, h.ctx);

		expect(registerEntryRenderer).toHaveBeenCalledWith(AHDE_TRANSCRIPT_ENTRY_TYPE, expect.any(Function));
		expect(h.ui.setTitle).toHaveBeenCalledWith("AHDE Builder");
		// Pi drops extension wrappers on every session start, so the `/` palette
		// ordering is asked for here rather than once at load.
		expect(h.ui.addAutocompleteProvider).toHaveBeenCalledWith(ahdeCommandsFirst);
		expect(h.ui.setWorkingMessage).toHaveBeenCalledWith("AHDE Builder is working…");
		expect(h.ui.setStatus).toHaveBeenCalledWith("ahde", "AHDE · Target setup");
		expect(h.ui.setStatus).toHaveBeenCalledWith("ahde-auth", undefined);
		expect(h.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Tell me what you want to build"), "info");
		expect(h.ui.select).not.toHaveBeenCalled();

		const rendered = h.renderHeader().join("\n");
		expect(rendered).toContain("AHDE Builder");
		// Before there is an agent the header says so and stops: the stage is in
		// the footer (`AHDE · Target setup`, asserted above) and the next action
		// belongs to whatever dialog or hint is on screen.
		expect(rendered).toContain("Target not created yet");
		expect(rendered).not.toContain("Next ");
		expect(rendered).toContain("openai/gpt-test");
		expect(rendered).toContain("Describe what you want");
		expect(rendered).not.toMatch(/Pi coding agent|run bash|!!|schemaVersion|\{/i);
		// Pi aborts the session on an over-wide custom line; the header must fit any viewport.
		for (const line of h.renderHeader(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});

	it("leads a first run without a Builder credential straight to /login", async () => {
		const { handlers } = install(async () => view());
		const h = host({
			credentialPresent: false,
			select: async () => "Log in to a provider (OAuth or API key)",
		});
		await start(handlers, h.ctx);

		expect(h.ui.select).toHaveBeenCalledWith(
			expect.stringContaining("needs a model"),
			expect.arrayContaining([expect.stringContaining("Log in")]),
		);
		expect(h.ui.setEditorText).toHaveBeenCalledWith("/login");
		expect(h.ui.setStatus).toHaveBeenCalledWith("ahde-auth", "Builder model not connected");
		expect(h.renderHeader().join("\n")).toContain("openai/gpt-test · not connected");
	});

	it("keeps the first free-text idea through private model setup", async () => {
		const { handlers, sendUserMessage } = install(async () => view());
		const h = host({
			credentialPresent: false,
			select: async (title: string) => title.includes("what you just wrote")
				? "Log in to a provider (OAuth or API key)"
				: "Not now",
		});
		await start(handlers, h.ctx);
		const transformed = await handlers.get("input")?.({
			type: "input",
			text: "Хочу агента, который разбирает обращения клиентов",
			source: "interactive",
		} as never, h.ctx as never) as { action: string; text: string };
		expect(transformed).toEqual({ action: "transform", text: "/login", images: undefined });

		h.ctx.modelRegistry.hasConfiguredAuth = vi.fn(() => true);
		await handlers.get("model_select")?.({ type: "model_select", source: "set" } as never, h.ctx as never);
		expect(sendUserMessage).toHaveBeenCalledWith("Хочу агента, который разбирает обращения клиентов");
	});

	it("keeps the header live after Workbench state changes", async () => {
		let current = view();
		const { handlers, controller } = install(async () => current);
		const h = host({ credentialPresent: true });
		await start(handlers, h.ctx);
		expect(h.renderHeader().join("\n")).toContain("Target not created yet");

		current = view({
			stage: "spec-review",
			headline: "Review and approve an exact Spec draft.",
			target: {
				status: "ready",
				id: "support-agent",
				gitSha: "a".repeat(40),
				model: { provider: "openai", id: "gpt-target", apiKeyEnv: "OPENAI_API_KEY", credentialPresent: false },
			},
			actions: ["review", "approve-spec"],
			blockers: [],
			counts: { ...view().counts, specDrafts: 1 },
		});
		await handlers.get("agent_end")?.({ type: "agent_end" } as never, h.ctx as never);

		const rendered = h.renderHeader().join("\n");
		expect(rendered).toContain("Spec review");
		expect(rendered).toContain("support-agent");
		expect(rendered).toContain("OPENAI_API_KEY missing");
		// The header names something the operator can say, never a stage name or
		// a slash command they have to look up.
		expect(rendered).toContain("Next Say “ok” to approve it, or what to change");
		expect(rendered).not.toContain("/review");
		expect(h.requestRender).toHaveBeenCalled();
		expect(h.ui.setStatus).toHaveBeenLastCalledWith("ahde-auth", undefined);

		await controller.refresh();
		expect(h.ui.setStatus).toHaveBeenCalledWith("ahde", "AHDE · Spec review");
	});

	it("reports an unreadable project instead of crashing the session", async () => {
		const { handlers } = install(async () => {
			throw new Error("state root is a symlink");
		});
		const h = host({ credentialPresent: true });
		await start(handlers, h.ctx);

		expect(h.ui.setStatus).toHaveBeenCalledWith("ahde", "AHDE · blocked");
		expect(h.ui.notify).toHaveBeenCalledWith(expect.stringContaining("state root is a symlink"), "error");
		expect(h.renderHeader().join("\n")).toContain("Project state unavailable");
	});

	it("asks nothing about the agent until the Builder itself has a model", async () => {
		const decide = vi.fn(async () => ({ view: view() }));
		const { handlers } = install(async () => view(), decide);
		const h = host({ credentialPresent: false, select: async () => "Log in to a provider (OAuth or API key)" });
		await start(handlers, h.ctx);

		expect(h.ui.setEditorText).toHaveBeenCalledWith("/login");
		expect(decide).not.toHaveBeenCalled();
		expect(h.ui.select).toHaveBeenCalledTimes(1);
		expect(h.ui.select!.mock.calls[0]?.[0]).toContain("needs a model");
	});

	it("resumes the first-run setup when a Builder model is finally selected", async () => {
		let current = view();
		const decide = vi.fn(async (input: { kind: string }) => {
			if (input.kind === "scaffold-target") {
				current = view({ target: { status: "bootstrap-required", id: "my-agent", gitSha: "a".repeat(40), model: null } });
				return { kind: input.kind, message: "ok", result: { targetId: "my-agent", targetGitSha: "a".repeat(40), receiptId: "receipt-1" }, view: current };
			}
			current = view({ stage: "spec-design", headline: "Describe the agent." });
			return {
				kind: input.kind,
				message: "ok",
				result: { targetId: "demo", targetGitSha: "b".repeat(40), receiptId: "receipt-2", credentialEnv: "OPENAI_API_KEY" },
				view: current,
			};
		});
		const { handlers } = install(async () => current, decide);
		const h = host({
			credentialPresent: false,
			select: async (title: string) => {
				if (title.includes("needs a model")) return "Not now";
				if (title.includes("has no agent yet")) return "Create the agent here";
				if (title.includes("Which model")) return "openai/gpt-test (same as the Builder)";
				return undefined;
			},
		});
		await start(handlers, h.ctx);
		expect(decide).not.toHaveBeenCalled();

		// The operator ran /login and picked a model: onboarding must pick up here.
		h.ctx.modelRegistry.hasConfiguredAuth = vi.fn(() => true);
		await handlers.get("model_select")?.({ type: "model_select", source: "set" } as never, h.ctx as never);

		expect(decide.mock.calls.map((call) => call[0]?.kind)).toEqual(["scaffold-target", "configure-target"]);
		expect(h.ui.select!.mock.calls.map((call) => call[0])).toEqual([
			expect.stringContaining("needs a model"),
			expect.stringContaining("has no agent yet"),
			expect.stringContaining("Which model should the agent itself use?"),
		]);
		expect(h.ui.notify).toHaveBeenCalledWith(expect.stringContaining("describe what the agent should do"), "info");
	});

	it("does not re-ask on a restored model selection", async () => {
		const decide = vi.fn(async () => ({ view: view() }));
		const { handlers } = install(async () => view(), decide);
		const h = host({ credentialPresent: true, select: async () => "Not now" });
		await start(handlers, h.ctx);
		const asked = h.ui.select!.mock.calls.length;

		await handlers.get("model_select")?.({ type: "model_select", source: "restore" } as never, h.ctx as never);
		expect(h.ui.select!.mock.calls.length).toBe(asked);
	});

	it("explains a non-empty folder in plain words instead of the internal error", async () => {
		const decide = vi.fn(async () => {
			throw new Error("target scaffold requires an otherwise empty current directory; found package.json");
		});
		const { handlers } = install(async () => view(), decide);
		const h = host({
			credentialPresent: true,
			select: async (title: string) => (title.includes("has no agent yet") ? "Create the agent here" : "Not now"),
		});
		await start(handlers, h.ctx);

		const warning = h.ui.notify!.mock.calls.find((call) => call[1] === "warning")?.[0] as string;
		expect(warning).toContain("This folder already holds");
		expect(warning).toContain("package.json");
		expect(warning).toContain("Open an empty folder");
		expect(warning).not.toContain("target scaffold requires");
	});

	it("replaces raw provider failures with one stable recovery message", async () => {
		const { handlers } = install(async () => view());
		const result = await handlers.get("message_end")?.({
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "error",
				errorMessage: "401 Invalid bearer token SECRET_PROVIDER_JSON",
				timestamp: 1,
			},
		} as never, {} as never) as { message: { errorMessage?: string } };

		expect(result.message.errorMessage).toContain("refused the key");
		expect(result.message.errorMessage).not.toContain("SECRET_PROVIDER_JSON");
	});
});

/**
 * Typing “/” used to show `model, thinking, copy, name, session` and a counter
 * reading 45 — Pi's own runtime commands before a single AHDE verb.
 */
describe("the / palette leads with AHDE's own verbs", () => {
	const items = [
		{ value: "model", label: "model" },
		{ value: "thinking", label: "thinking" },
		{ value: "test", label: "test" },
		{ value: "quit", label: "quit" },
		{ value: "traces", label: "traces" },
	];
	const signal = new AbortController().signal;

	function palette(suggestions: unknown) {
		return ahdeCommandsFirst({
			getSuggestions: async () => suggestions,
			applyCompletion: vi.fn(() => ({ lines: [], cursorLine: 0, cursorCol: 0 })),
		} as never);
	}

	it("moves AHDE's commands to the front and keeps Pi's order inside each half", async () => {
		const shown = await palette({ items, prefix: "/" }).getSuggestions([], 0, 0, { signal });
		expect(shown?.items.map((item) => item.value)).toEqual(["test", "traces", "model", "thinking", "quit"]);
	});

	it("leaves arguments, paths, and lists it has no say in exactly as they were", async () => {
		// An argument completion: the prefix is not a command name.
		const argument = { items, prefix: "3 repetitions" };
		expect(await palette(argument).getSuggestions([], 0, 0, { signal })).toBe(argument);
		// A path carries a separator, so it is never a bare command name.
		const path = { items: [{ value: "src/i18n.ts", label: "i18n.ts" }], prefix: "/Users/kikov/" };
		expect(await palette(path).getSuggestions([], 0, 0, { signal })).toBe(path);
		// Nothing of AHDE's in the list, or nothing but AHDE's: untouched either way.
		const piOnly = { items: items.slice(0, 2), prefix: "/" };
		expect(await palette(piOnly).getSuggestions([], 0, 0, { signal })).toBe(piOnly);
		const ahdeOnly = { items: [{ value: "test", label: "test" }], prefix: "/t" };
		expect(await palette(ahdeOnly).getSuggestions([], 0, 0, { signal })).toBe(ahdeOnly);
		expect(await palette(null).getSuggestions([], 0, 0, { signal })).toBeNull();
	});

	it("delegates everything it does not reorder", () => {
		const applyCompletion = vi.fn(() => ({ lines: ["/test "], cursorLine: 0, cursorCol: 6 }));
		const shouldTriggerFileCompletion = vi.fn(() => true);
		const wrapped = ahdeCommandsFirst({
			triggerCharacters: ["/"],
			getSuggestions: async () => null,
			applyCompletion,
			shouldTriggerFileCompletion,
		} as never);
		expect(wrapped.triggerCharacters).toEqual(["/"]);
		expect(wrapped.applyCompletion([], 0, 0, { value: "test", label: "test" }, "/t"))
			.toEqual({ lines: ["/test "], cursorLine: 0, cursorCol: 6 });
		expect(applyCompletion).toHaveBeenCalledOnce();
		expect(wrapped.shouldTriggerFileCompletion?.([], 0, 0)).toBe(true);
		// A provider without the optional hook does not grow one.
		expect(ahdeCommandsFirst({ getSuggestions: async () => null, applyCompletion } as never).shouldTriggerFileCompletion)
			.toBeUndefined();
	});
});
