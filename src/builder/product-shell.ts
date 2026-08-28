import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { AhdeWorkbench } from "../workbench/workbench.js";
import type { WorkbenchView } from "../workbench/types.js";

type ProductWorkbench = Pick<AhdeWorkbench, "view">;

function modelStatus(ctx: ExtensionContext): { label: string; authenticated: boolean } {
	if (!ctx.model) return { label: "no Builder model", authenticated: false };
	return {
		label: `${ctx.model.provider}/${ctx.model.id}`,
		authenticated: ctx.modelRegistry.hasConfiguredAuth(ctx.model),
	};
}

function headerLines(theme: Theme, view: WorkbenchView, ctx: ExtensionContext): string[] {
	const model = modelStatus(ctx);
	const target = view.target.id ?? view.target.status;
	return [
		"",
		theme.fg("accent", theme.bold("AHDE Builder")),
		theme.fg("muted", "Create, evaluate, and improve another agent through evidence."),
		`${theme.fg("dim", "Target")} ${target}  ${theme.fg("dim", "Stage")} ${view.stage}`,
		`${theme.fg("dim", "Builder model")} ${model.label} ${model.authenticated ? theme.fg("success", "authenticated") : theme.fg("warning", "auth required")}`,
		theme.fg("muted", "Describe what you want to build · /help · /doctor · /status"),
		"",
	];
}

function safeStatus(ctx: ExtensionContext, view: WorkbenchView): void {
	const model = modelStatus(ctx);
	ctx.ui.setStatus("ahde", `AHDE · ${view.stage}`);
	ctx.ui.setStatus("ahde-auth", model.authenticated ? undefined : "auth required · /doctor");
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
		} else if (!modelStatus(ctx).authenticated) {
			ctx.ui.notify("Builder model authentication is missing. Run /doctor, then /login or /model.", "warning");
		}
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
