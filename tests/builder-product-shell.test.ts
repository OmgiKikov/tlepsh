import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { installAhdeBuilderProductShell } from "../src/builder/product-shell.js";
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
		expect(h.ui.setWorkingMessage).toHaveBeenCalledWith("AHDE Builder is working…");
		expect(h.ui.setStatus).toHaveBeenCalledWith("ahde", "AHDE · Target setup");
		expect(h.ui.setStatus).toHaveBeenCalledWith("ahde-auth", undefined);
		expect(h.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Tell me what you want to build"), "info");
		expect(h.ui.select).not.toHaveBeenCalled();

		const rendered = h.renderHeader().join("\n");
		expect(rendered).toContain("AHDE Builder");
		expect(rendered).toContain("Target setup");
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
		expect(h.renderHeader().join("\n")).toContain("Target setup");

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
		expect(warning).toContain("This folder is not empty");
		expect(warning).toContain("package.json");
		expect(warning).toContain("ahde init");
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

		expect(result.message.errorMessage).toContain("authentication was rejected");
		expect(result.message.errorMessage).not.toContain("SECRET_PROVIDER_JSON");
	});
});
