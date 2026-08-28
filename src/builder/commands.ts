import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AhdeWorkbench } from "../workbench/workbench.js";
import type {
	WorkbenchDecisionResult,
	WorkbenchView,
} from "../workbench/types.js";
import {
	beginBuilderRunObservation,
	type BeginBuilderLiveTrace,
	type BuilderLiveTraceOutcome,
} from "./run-observation.js";
import { createWorkbenchHumanGate } from "./workbench-gate.js";

type CommandWorkbench = Pick<AhdeWorkbench, "view" | "decide">;

export const AHDE_BUILDER_COMMAND_NAMES = [
	"help",
	"doctor",
	"status",
	"run",
	"traces",
	"review",
	"apply",
	"discard",
	"target",
] as const;

const BUILDER_HELP = `AHDE Builder

Talk normally: describe the agent you want, answer one useful question at a time,
and AHDE will turn the conversation into reviewable Specs, evals, and harness changes.

Commands:
  /help                 this AHDE workflow and command reference
  /status               current stage and next legal action
  /doctor               model auth, Target readiness, and recovery guidance
  /run [N] [reason]     run development evidence or candidate verification
  /traces               bounded diagnosis and local evidence link
  /review               exact artifact or diff awaiting review
  /apply <branch> [...] apply the selected proposal after confirmation
  /discard [reason]     discard a proposal or abandon an interrupted candidate
  /target [resource]    exact Target overview or one declared harness resource

Consequential steps always show an exact subject and require host confirmation.`;

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

function formatDoctor(ctx: ExtensionCommandContext, view: WorkbenchView): { message: string; ready: boolean } {
	const model = ctx.model;
	const authenticated = model ? ctx.modelRegistry.hasConfiguredAuth(model) : false;
	const targetReady = view.target.status === "ready";
	const lines = [
		"AHDE Doctor",
		`Builder model: ${model ? `${model.provider}/${model.id}` : "not selected"}`,
		`Builder authentication: ${authenticated ? "ready" : "missing"}`,
		`Target: ${view.target.id ?? view.target.status} (${view.target.status})`,
		`Workflow: ${view.stage} — ${view.headline}`,
	];
	if (!model) lines.push("Recovery: choose a Builder model with /model.");
	else if (!authenticated) lines.push("Recovery: authenticate with /login, or choose an authenticated model with /model.");
	if (!targetReady) {
		lines.push("Recovery: describe the agent you want; AHDE will guide the exact Target setup through the Workbench.");
	}
	if (view.blockers.length > 0) lines.push(`Current blocker: ${view.blockers.join(" ")}`);
	const ready = Boolean(model && authenticated && targetReady && view.blockers.length === 0);
	lines.push(`Verdict: ${ready ? "ready to build" : "action required"}`);
	return { message: lines.join("\n"), ready };
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
	options: {
		workbench: CommandWorkbench;
		actorId: () => string;
		beginLiveTrace?: BeginBuilderLiveTrace;
	},
): void {
	pi.registerCommand("help", {
		description: "Show the AHDE Builder workflow and human shortcuts",
		async handler(args, ctx) {
			noArguments("help", args);
			await prepare(ctx, "help");
			ctx.ui.notify(BUILDER_HELP, "info");
		},
	});
	pi.registerCommand("doctor", {
		description: "Check Builder authentication, Target readiness, and recovery steps",
		async handler(args, ctx) {
			noArguments("doctor", args);
			await prepare(ctx, "doctor");
			const diagnosis = formatDoctor(ctx, await options.workbench.view());
			ctx.ui.notify(diagnosis.message, diagnosis.ready ? "info" : "warning");
		},
	});
	const viewCommand = (
		name: "status" | "traces" | "review",
		aspect: "summary" | "traces" | "review",
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
			const observation = await beginBuilderRunObservation(ctx.ui, options.beginLiveTrace);
			let outcome: BuilderLiveTraceOutcome = "error";
			let result: WorkbenchDecisionResult;
			try {
				result = await (async () => {
					try {
						const decided = await options.workbench.decide(
							{ kind: "run-current", repetitions: parsed.repetitions, reason: parsed.reason },
							commandGate(ctx, options.actorId),
							{ signal, onRunEvent: observation.onRunEvent },
						);
						outcome = "completed";
						return decided;
					} catch (error) {
						if (signal?.aborted) outcome = "aborted";
						throw error;
					} finally {
						observation.finish(outcome);
					}
				})();
			} catch (error) {
				if (observation.liveTraceUrl) {
					try {
						ctx.ui.notify(
							`Live trace retained for 15 minutes: ${observation.liveTraceUrl}`,
							"info",
						);
					} catch {
						// Preserve the original run error when host notification fails.
					}
				}
				throw error;
			}
			const finalMessage = observation.liveTraceUrl
				? `${formatDecision(result)}\n\nLive trace retained for 15 minutes: ${observation.liveTraceUrl}`
				: formatDecision(result);
			ctx.ui.notify(finalMessage, result.view.blockers.length > 0 ? "warning" : "info");
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
	pi.registerCommand("target", {
		description: "Show exact committed Target authoring context: /target [declared-resource-path]",
		async handler(args, ctx) {
			await prepare(ctx, "target");
			const resourcePath = args.trim();
			if (/\s/.test(resourcePath)) {
				throw new Error("/target accepts at most one declared repository-relative resource path");
			}
			const view = await options.workbench.view({
				aspect: "target",
				...(resourcePath ? { resourcePath } : {}),
			});
			ctx.ui.notify(formatView(view), view.blockers.length > 0 ? "warning" : "info");
		},
	});
}
