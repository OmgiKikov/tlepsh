import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { AhdeWorkbench } from "../workbench/workbench.js";
import type { WorkbenchView } from "../workbench/types.js";

type ProductWorkbench = Pick<AhdeWorkbench, "view">;

function modelStatus(ctx: ExtensionContext): { label: string; credentialPresent: boolean } {
	if (!ctx.model) return { label: "no Builder model", credentialPresent: false };
	return {
		label: `${ctx.model.provider}/${ctx.model.id}`,
		credentialPresent: ctx.modelRegistry.hasConfiguredAuth(ctx.model),
	};
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

function headerLines(theme: Theme, view: WorkbenchView, ctx: ExtensionContext): string[] {
	const model = modelStatus(ctx);
	const target = view.target.id ?? view.target.status;
	return [
		"",
		theme.fg("accent", theme.bold("AHDE Builder")),
		theme.fg("muted", "Create, evaluate, and improve another agent through evidence."),
		`${theme.fg("dim", "Target")} ${target}  ${theme.fg("dim", "Stage")} ${view.stage}`,
		`${theme.fg("dim", "Builder model")} ${model.label} ${model.credentialPresent ? theme.fg("success", "credential present") : theme.fg("warning", "credential required")}`,
		theme.fg("muted", "Describe what you want to build · /help · /doctor · /status"),
		"",
	];
}

function safeStatus(ctx: ExtensionContext, view: WorkbenchView): void {
	const model = modelStatus(ctx);
	ctx.ui.setStatus("ahde", `AHDE · ${view.stage}`);
	ctx.ui.setStatus("ahde-auth", model.credentialPresent ? undefined : "credential required · /doctor");
}

/** Install the AHDE-owned visual/product identity over the embedded Pi host. */
export function installAhdeBuilderProductShell(
	pi: ExtensionAPI,
	workbench: ProductWorkbench,
): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setTitle("AHDE Builder");
		ctx.ui.setWorkingMessage("AHDE Builder is working…");
		let view: WorkbenchView;
		try {
			view = await workbench.view();
		} catch (error) {
			ctx.ui.setStatus("ahde", "AHDE · blocked");
			ctx.ui.notify(
				`AHDE could not read project state: ${error instanceof Error ? error.message : String(error)}\nRun /doctor for recovery guidance.`,
				"error",
			);
			return;
		}
		safeStatus(ctx, view);
		ctx.ui.setHeader((_tui, theme) => ({
			render: () => headerLines(theme, view, ctx),
			invalidate() {},
		}));
		if (view.stage === "target-setup") {
			ctx.ui.notify(
				"Tell me what agent you want to create. AHDE will turn that intent into exact, reviewable setup steps.",
				"info",
			);
		} else if (!modelStatus(ctx).credentialPresent) {
			ctx.ui.notify("Builder model authentication is missing. Run /doctor, then /login or /model.", "warning");
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

	pi.on("model_select", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		try {
			safeStatus(ctx, await workbench.view());
		} catch {
			ctx.ui.setStatus("ahde", "AHDE · blocked");
		}
	});
}
