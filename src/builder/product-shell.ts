import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { AhdeWorkbench } from "../workbench/workbench.js";
import type { WorkbenchStage, WorkbenchView } from "../workbench/types.js";
import { themePaint } from "./render/paint.js";
import { nextStep, stageLabel } from "./render/stage.js";
import { renderHeader, type HeaderState } from "./render/view.js";
import { runFirstRunOnboarding } from "./onboarding.js";
import {
	createTranscriptPresenter,
	registerAhdeTranscriptRenderer,
	type TranscriptPresenter,
} from "./transcript.js";

type ProductWorkbench = Pick<AhdeWorkbench, "view"> & Partial<Pick<AhdeWorkbench, "decide">>;

export interface ProductShellController {
	/** Re-read Workbench state and redraw the header/status; never throws. */
	refresh(): Promise<void>;
}

export interface ProductShellOptions {
	/** Enables the host-driven first-run setup (create agent here, choose its model). */
	actorId?: () => string;
	presenter?: TranscriptPresenter;
}

/**
 * What the operator can say next, in their words. The header names an action,
 * never the stage it derives from: “Next say “tests”” beats “Next corpus
 * review”. Blockers still win, so a blocked project keeps its recovery line.
 */
function builderModelStatus(ctx: Pick<ExtensionContext, "model" | "modelRegistry">): HeaderState["builderModel"] {
	// Pi substitutes an "unknown/unknown" placeholder when no provider is configured.
	if (!ctx.model || ctx.model.provider === "unknown") return { label: null, credentialPresent: false };
	let credentialPresent = false;
	try {
		credentialPresent = ctx.modelRegistry.hasConfiguredAuth(ctx.model);
	} catch {
		credentialPresent = false;
	}
	return { label: `${ctx.model.provider}/${ctx.model.id}`, credentialPresent };
}

function safeProviderFailure(message: string | undefined): string {
	const source = message ?? "";
	if (/\b40[13]\b|unauthori[sz]ed|invalid (?:bearer|api key|token)|authentication/i.test(source)) {
		return "Builder model authentication was rejected. Run /login or choose another configured model with /model, then retry.";
	}
	if (/\b429\b|rate.?limit|too many requests/i.test(source)) {
		return "Builder model is rate-limited. Wait and retry, or choose another model with /model.";
	}
	if (/fetch failed|ECONNREFUSED|ENOTFOUND|network|socket|connection/i.test(source)) {
		return "Builder model is unreachable. Check network access or choose another model with /model, then retry.";
	}
	return "Builder model request failed. Run /doctor, then retry or choose another model with /model.";
}

const LOGIN_CHOICE = "Log in to a provider (OAuth or API key)";
const MODEL_CHOICE = "Pick a model that already has a credential";
const LATER_CHOICE = "Not now";

/** Install the AHDE-owned visual/product identity over the embedded Pi host. */
export function installAhdeBuilderProductShell(
	pi: ExtensionAPI,
	workbench: ProductWorkbench,
	options: ProductShellOptions = {},
): ProductShellController {
	registerAhdeTranscriptRenderer(pi);
	const presenter = options.presenter ?? createTranscriptPresenter(pi);

	const state: HeaderState = {
		view: null,
		builderModel: { label: null, credentialPresent: false },
		error: null,
	};
	let tui: TUI | null = null;
	let host: ExtensionContext | null = null;

	const applyStatus = (): void => {
		if (!host) return;
		const view = state.view;
		try {
			host.ui.setStatus("ahde", view ? `AHDE · ${stageLabel(view.stage)}` : state.error ? "AHDE · blocked" : "AHDE");
			host.ui.setStatus("ahde-auth", state.builderModel.credentialPresent ? undefined : "Builder model not connected · /login");
		} catch {
			// Status is cosmetic.
		}
	};

	// Refreshes coalesce: a burst of tool calls yields one re-read after the
	// in-flight one, so a slow inventory can never queue up behind itself.
	let inFlight: Promise<void> | null = null;
	let pending = false;
	const readState = async (): Promise<void> => {
		if (host) state.builderModel = builderModelStatus(host);
		try {
			state.view = await workbench.view();
			state.error = null;
		} catch (error) {
			state.view = null;
			state.error = error instanceof Error ? error.message : String(error);
		}
		applyStatus();
		try {
			tui?.requestRender();
		} catch {
			// Rendering is best-effort.
		}
	};
	const refresh = async (): Promise<void> => {
		if (inFlight) {
			pending = true;
			return inFlight;
		}
		inFlight = (async () => {
			try {
				do {
					pending = false;
					await readState();
				} while (pending);
			} finally {
				inFlight = null;
			}
		})();
		return inFlight;
	};

	const onboard = async (ctx: ExtensionContext, view: WorkbenchView | null): Promise<void> => {
		if (!state.builderModel.credentialPresent) {
			if (typeof ctx.ui.select !== "function") {
				ctx.ui.notify("Connect the Builder to a model first: /login, or /model to pick one with a credential.", "warning");
				return;
			}
			const choice = await ctx.ui.select(
				"AHDE Builder needs a model to talk to you",
				[LOGIN_CHOICE, MODEL_CHOICE, LATER_CHOICE],
			);
			if (choice === LOGIN_CHOICE) {
				ctx.ui.setEditorText("/login");
				ctx.ui.notify("Press Enter to open the provider login. One login serves every AHDE project.", "info");
			} else if (choice === MODEL_CHOICE) {
				ctx.ui.setEditorText("/model");
				ctx.ui.notify("Press Enter to open the model picker.", "info");
			} else {
				ctx.ui.notify("You can connect any time with /login or /model.", "info");
			}
			return;
		}
		if (!view) return;
		if (view.stage === "target-setup") {
			let current: WorkbenchView | null = view;
			if (workbench.decide && options.actorId) {
				current = await runFirstRunOnboarding(ctx, {
					workbench: { view: (query) => workbench.view(query), decide: workbench.decide.bind(workbench) },
					actorId: options.actorId,
					presenter,
				}, view);
				await refresh();
			}
			if (current && current.stage !== "target-setup") {
				ctx.ui.notify("Now describe what the agent should do, for whom, and what “done” looks like. One question at a time from here.", "info");
				return;
			}
			ctx.ui.notify(
				(current ?? view).target.status === "missing"
					? "No agent yet. Tell me what you want to build and I will set it up here."
					: "The agent exists but has no model yet. Tell me which model it should use.",
				"info",
			);
		} else {
			ctx.ui.notify(nextStep(view), "info");
		}
	};

	// Onboarding owns the host selectors while it runs; two overlapping runs would
	// stack dialogs over the same two questions.
	let onboarding = false;
	const runOnboarding = async (ctx: ExtensionContext, view: WorkbenchView | null): Promise<void> => {
		if (onboarding) return;
		onboarding = true;
		try {
			await onboard(ctx, view);
		} catch {
			// Onboarding prompts are optional; the header already shows the state.
		} finally {
			onboarding = false;
		}
	};

	pi.on("session_start", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		host = ctx;
		ctx.ui.setTitle("AHDE Builder");
		ctx.ui.setWorkingMessage("AHDE Builder is working…");
		ctx.ui.setHeader((hostTui, theme) => {
			tui = hostTui;
			const paint = themePaint(theme);
			return {
				// Pi aborts the whole session on an over-wide custom line; every header
				// line is measured with ANSI awareness and cut to the viewport.
				render: (width: number) => renderHeader(state, paint)
					.map((line) => truncateToWidth(line, Math.max(1, width))),
				invalidate() {},
			};
		});
		await refresh();
		if (state.error) {
			ctx.ui.notify(`AHDE could not read project state: ${state.error}\nRun /doctor for recovery guidance.`, "error");
			return;
		}
		if (event.reason === "startup" || event.reason === "new" || event.reason === "resume") {
			await runOnboarding(ctx, state.view);
		}
	});

	// Pi retains provider errors in its transcript. Replace raw provider JSON and
	// bearer-token diagnostics with one stable AHDE recovery message before the
	// finalized message is rendered or reused as context.
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant" || event.message.stopReason !== "error") return;
		return {
			message: {
				...event.message,
				content: [],
				errorMessage: safeProviderFailure(event.message.errorMessage),
			},
		};
	});

	// Choosing a Builder model is the second half of the cold start: the first run
	// stopped at "/login or /model" without ever asking the two setup questions.
	// Picking a credentialed model resumes onboarding exactly where it stopped.
	pi.on("model_select", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		host = ctx;
		await refresh();
		// "restore" is the session replaying its own model; session_start owns that path.
		if (event.source === "restore") return;
		if (state.error || !state.builderModel.credentialPresent) return;
		if (state.view?.stage !== "target-setup") return;
		await runOnboarding(ctx, state.view);
	});

	// Workbench state changes through tools during a turn; redraw when the model settles.
	pi.on("tool_execution_end", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		host = ctx;
		await refresh();
	});
	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		host = ctx;
		await refresh();
	});

	return { refresh };
}
