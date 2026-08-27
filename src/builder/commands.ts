import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AhdeWorkbench } from "../workbench/workbench.js";
import type {
	WorkbenchDecisionResult,
	WorkbenchView,
} from "../workbench/types.js";
import { createWorkbenchHumanGate } from "./workbench-gate.js";

type CommandWorkbench = Pick<AhdeWorkbench, "view" | "decide">;

export const AHDE_BUILDER_COMMAND_NAMES = [
	"status",
	"run",
	"traces",
	"review",
	"apply",
	"discard",
	"target",
] as const;

function requireTui(ctx: ExtensionCommandContext, command: string): void {
	if (!ctx.hasUI || ctx.mode !== "tui") {
		throw new Error(`/${command} requires the local Builder Pi TUI`);
	}
}

function abortIfRequested(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("command aborted");
}

async function prepare(ctx: ExtensionCommandContext, command: string): Promise<AbortSignal | undefined> {
	requireTui(ctx, command);
	const signal = ctx.signal;
	await ctx.waitForIdle();
	abortIfRequested(signal);
	return signal;
}

function noArguments(command: string, args: string): void {
	if (args.trim()) throw new Error(`/${command} does not accept arguments`);
}

function commandGate(ctx: ExtensionCommandContext, actorId: () => string) {
	return createWorkbenchHumanGate(
		ctx,
		actorId,
		(operation) => requireTui(ctx, operation),
		"candidate verification",
	);
}

function formatView(view: WorkbenchView): string {
	const lines = [
		`AHDE · ${view.stage}`,
		view.headline,
		`Target: ${view.target.id ?? view.target.status}${view.target.gitSha ? ` @ ${view.target.gitSha.slice(0, 12)}` : ""}`,
		`Artifacts: ${view.counts.approvedSpecs} approved specs · ${view.counts.developmentCorpora} dev corpora · ${view.counts.developmentEvals} evals · ${view.counts.openProposals} open proposals · ${view.counts.candidates} candidates`,
	];
	if (view.actions.length > 0) lines.push(`Next: ${view.actions.join(" · ")}`);
	if (view.blockers.length > 0) lines.push(`Blocked: ${view.blockers.join(" ")}`);
	if (view.warnings.length > 0) lines.push(`Warnings: ${view.warnings.join(" ")}`);
	if (view.detail) lines.push("", JSON.stringify(view.detail.content, null, 2));
	return lines.join("\n");
}

function formatDecision(result: WorkbenchDecisionResult): string {
	return [
		result.message,
		JSON.stringify(result.result, null, 2),
		"",
		formatView(result.view),
	].join("\n");
}

function parseRun(args: string): { repetitions: number; reason: string } {
	const trimmed = args.trim();
	if (!trimmed) return { repetitions: 1, reason: "Requested interactively via /run" };
	const tokens = trimmed.split(/\s+/);
	if (!/^\d+$/.test(tokens[0] ?? "")) {
		return { repetitions: 1, reason: trimmed };
	}
	const repetitions = Number(tokens.shift());
	if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
		throw new Error("/run repetitions must be an integer between 1 and 10");
	}
	return { repetitions, reason: tokens.join(" ") || "Requested interactively via /run" };
}

function parseApply(args: string): { branch: string; reason: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const branch = tokens.shift();
	if (!branch) throw new Error("usage: /apply <branch> [reason]");
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch)) {
		throw new Error("/apply branch must be one bounded Git branch name");
	}
	return { branch, reason: tokens.join(" ") || "Requested interactively via /apply" };
}

export function registerAhdeBuilderCommands(
	pi: ExtensionAPI,
	options: { workbench: CommandWorkbench; actorId: () => string },
): void {
	const viewCommand = (
		name: "status" | "traces" | "review" | "target",
		aspect: "summary" | "traces" | "review" | "target",
		description: string,
	): void => {
		pi.registerCommand(name, {
			description,
			async handler(args, ctx) {
				noArguments(name, args);
				await prepare(ctx, name);
				const view = await options.workbench.view({ aspect });
				ctx.ui.notify(formatView(view), view.blockers.length > 0 ? "warning" : "info");
			},
		});
	};

	viewCommand("status", "summary", "Show the current AHDE workflow stage and next legal actions");
	pi.registerCommand("run", {
		description: "Run the current development eval or verify the applied candidate: /run [repetitions] [reason]",
		async handler(args, ctx) {
			const signal = await prepare(ctx, "run");
			const parsed = parseRun(args);
			const result = await options.workbench.decide(
				{ kind: "run-current", repetitions: parsed.repetitions, reason: parsed.reason },
				commandGate(ctx, options.actorId),
				{ signal },
			);
			ctx.ui.notify(formatDecision(result), result.view.blockers.length > 0 ? "warning" : "info");
		},
	});
	viewCommand("traces", "traces", "Show the selected development diagnosis and read-only trace link");
	viewCommand("review", "review", "Show the exact artifact awaiting human review");
	pi.registerCommand("apply", {
		description: "Apply the selected exact proposal: /apply <branch> [reason]",
		async handler(args, ctx) {
			const signal = await prepare(ctx, "apply");
			const parsed = parseApply(args);
			const result = await options.workbench.decide(
				{ kind: "apply-proposal", branch: parsed.branch, reason: parsed.reason },
				commandGate(ctx, options.actorId),
				{ signal },
			);
			ctx.ui.notify(formatDecision(result), result.view.blockers.length > 0 ? "warning" : "info");
		},
	});
	pi.registerCommand("discard", {
		description: "Discard the selected proposal or abandon an interrupted candidate: /discard [reason]",
		async handler(args, ctx) {
			const signal = await prepare(ctx, "discard");
			const reason = args.trim() || "Requested interactively via /discard";
			const review = await options.workbench.view({ aspect: "review" });
			const detail = review.detail?.content;
			const interruptedCandidateId = detail?.kind === "interrupted-candidate" && typeof detail.candidateId === "string"
				? detail.candidateId
				: undefined;
			const result = await options.workbench.decide(
				interruptedCandidateId
					? { kind: "abandon-candidate", candidateId: interruptedCandidateId, reason }
					: { kind: "discard-proposal", reason },
				commandGate(ctx, options.actorId),
				{ signal },
			);
			ctx.ui.notify(formatDecision(result), result.view.blockers.length > 0 ? "warning" : "info");
		},
	});
	viewCommand("target", "target", "Show the exact Target harness and standalone interactive launch command");
}
