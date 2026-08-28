import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { installAhdeBuilderProductShell } from "../src/builder/product-shell.js";
import type { WorkbenchView } from "../src/workbench/types.js";

const view: WorkbenchView = {
	schemaVersion: 1,
	project: { id: "demo", directory: "demo" },
	stage: "target-setup",
	headline: "Create the Target harness.",
	target: { status: "missing", id: null, gitSha: null },
	focus: {},
	selections: [],
	actions: ["scaffold-target"],
	blockers: ["Target harness is missing."],
	warnings: [],
	counts: {
		specDrafts: 0,
		approvedSpecs: 0,
		corpusDrafts: 0,
		developmentCorpora: 0,
		sealedCorpora: 0,
		developmentEvals: 0,
		openProposals: 0,
		candidates: 0,
	},
};

describe("AHDE Builder product shell", () => {
	it("replaces Pi onboarding with AHDE identity, readiness, and conversational setup guidance", async () => {
		const handlers = new Map<string, (...args: never[]) => unknown>();
		installAhdeBuilderProductShell({
			on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
		} as unknown as ExtensionAPI, { view: vi.fn(async () => view) } as never);

		const setTitle = vi.fn();
		const setStatus = vi.fn();
		const setHeader = vi.fn();
		const setWorkingMessage = vi.fn();
		const notify = vi.fn();
		const context = {
			mode: "tui",
			model: { provider: "openai", id: "gpt-test" },
			modelRegistry: { hasConfiguredAuth: vi.fn(() => false) },
			ui: { setTitle, setStatus, setHeader, setWorkingMessage, notify },
		} as unknown as ExtensionContext;
		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" } as never, context as never);

		expect(setTitle).toHaveBeenCalledWith("AHDE Builder");
		expect(setWorkingMessage).toHaveBeenCalledWith("AHDE Builder is working…");
		expect(setStatus).toHaveBeenCalledWith("ahde", "AHDE · target-setup");
		expect(setStatus).toHaveBeenCalledWith("ahde-auth", "auth required · /doctor");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Tell me what agent you want"), "info");

		const factory = setHeader.mock.calls[0]?.[0] as ((tui: unknown, theme: Theme) => { render(): string[] });
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
		const rendered = factory({}, theme).render().join("\n");
		expect(rendered).toContain("AHDE Builder");
		expect(rendered).toContain("Describe what you want to build");
		expect(rendered).not.toMatch(/Pi coding agent|run bash|!!/i);
	});
});
