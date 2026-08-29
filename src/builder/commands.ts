import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AhdeWorkbench } from "../workbench/workbench.js";
import {
	WorkbenchDecisionDeclinedError,
	WorkbenchSelectionRequiredError,
	WorkbenchStaleDecisionError,
} from "../workbench/errors.js";
import type {
	WorkbenchDecisionInput,
	WorkbenchDecisionResult,
	WorkbenchView,
} from "../workbench/types.js";
import { oneLine, pluralize } from "./render/format.js";
import { decisionHeadline, renderDecision } from "./render/decision.js";
import { nextStep, stageLabel } from "./render/stage.js";
import { renderReview, renderStatus, renderTarget, renderTraces, viewTitle } from "./render/view.js";
import {
	beginBuilderRunObservation,
	type BeginBuilderLiveTrace,
	type BuilderLiveTraceOutcome,
} from "./run-observation.js";
import {
	createTranscriptPresenter,
	markerPaint,
	type TranscriptPresenter,
	type TranscriptTone,
} from "./transcript.js";
import { createWorkbenchHumanGate, formatWorkbenchConfirmation } from "./workbench-gate.js";

type CommandWorkbench = Pick<AhdeWorkbench, "view" | "decide">;

export const AHDE_BUILDER_COMMAND_NAMES = [
	"help",
	"doctor",
	"status",
	"run",
	"traces",
	"review",
	"approve",
	"publish",
	"apply",
	"discard",
	"promote",
	"reject",
	"adopt",
	"next",
	"target",
] as const;

const BUILDER_HELP = `AHDE Builder

Talk normally: describe the agent you want, answer one useful question at a time,
and AHDE turns the conversation into a reviewed Spec, evaluation cases, runs,
diagnosis, and exact harness changes. Slash commands are shortcuts, not a
requirement.

Workflow:  idea → Spec → eval basket → run → diagnosis → proposal → diff review
           → apply → candidate verification → promote/reject → adopt → next cycle

Commands:
  /status               where you are and the next step
  /review               the exact artifact awaiting your review, with actions
  /traces               diagnosis, failure modes, and the evidence link
  /run [N] [reason]     run the development basket or verify the applied candidate
  /approve [reason]     approve the reviewed Spec draft
  /publish [name]       publish the reviewed eval basket
  /apply <branch>       apply the reviewed proposal to a candidate branch
  /discard [reason]     discard a proposal or abandon an interrupted candidate
  /promote <version>    promote the verified candidate (records the review first)
  /reject [reason]      reject the verified candidate
  /adopt [reason]       fast-forward the current branch to the promoted candidate
  /next [reason]        close this cycle and continue with the active Target
  /target [resource]    the exact committed Target, or one declared resource
  /doctor               model auth, Target readiness, and recovery steps
  /help                 this reference

Every consequential step shows the exact subject and asks you to confirm.`;

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

function reasonOrDefault(args: string, command: string): string {
	return args.trim() || `Requested interactively via /${command}`;
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

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;

function parseBranch(value: string): string {
	if (!BRANCH_PATTERN.test(value)) throw new Error("branch must be one bounded Git branch name");
	return value;
}

function parseVersion(value: string): string {
	if (!VERSION_PATTERN.test(value)) throw new Error("version must be semver like 0.2.0");
	return value;
}

function parseApply(args: string): { branch: string | null; reason: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const branch = tokens.shift();
	return {
		branch: branch ? parseBranch(branch) : null,
		reason: tokens.join(" ") || "Requested interactively via /apply",
	};
}

function parsePromote(args: string): { version: string | null; reason: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const version = tokens.shift();
	return {
		version: version ? parseVersion(version) : null,
		reason: tokens.join(" ") || "Requested interactively via /promote",
	};
}

/** Turn Workbench failures into one calm sentence; unknown errors keep their message. */
export function humanizeCommandError(error: unknown): { message: string; tone: TranscriptTone } {
	if (error instanceof WorkbenchDecisionDeclinedError) {
		return { message: "Cancelled — nothing changed.", tone: "info" };
	}
	if (error instanceof WorkbenchStaleDecisionError) {
		return { message: "The subject changed while you were reviewing it. Run the command again to review the current state.", tone: "warning" };
	}
	if (error instanceof WorkbenchSelectionRequiredError) {
		const choices = error.choices.length > 0 ? ` Choices: ${error.choices.slice(0, 8).join(", ")}.` : "";
		return { message: `${error.message}. Ask the Builder to select one (for example “use the first one”).${choices}`, tone: "warning" };
	}
	const message = error instanceof Error ? error.message : String(error);
	return { message: oneLine(message, 600), tone: "error" };
}

function decisionTitle(result: WorkbenchDecisionResult): { title: string; tone: TranscriptTone } {
	switch (result.kind) {
		case "run-eval": return { title: "Run complete", tone: result.result.evaluation.summary.error > 0 ? "warning" : "success" };
		case "run-current":
			return result.result.resolvedAs === "run-eval"
				? { title: "Run complete", tone: result.result.evaluation.summary.error > 0 ? "warning" : "success" }
				: { title: "Candidate verified", tone: "success" };
		case "verify-candidate": return { title: "Candidate verified", tone: "success" };
		case "scaffold-target": return { title: "Target created", tone: "success" };
		case "configure-target": return { title: "Target configured", tone: "success" };
		case "approve-spec": return { title: "Spec approved", tone: "success" };
		case "publish-corpus": return { title: "Eval basket published", tone: "success" };
		case "apply-proposal": return { title: "Proposal applied", tone: "success" };
		case "discard-proposal": return { title: "Proposal discarded", tone: "info" };
		case "abandon-candidate": return { title: "Candidate attempt abandoned", tone: "info" };
		case "review-candidate": return { title: "Review recorded", tone: "info" };
		case "promote-candidate": return { title: "Candidate promoted", tone: "success" };
		case "reject-candidate": return { title: "Candidate rejected", tone: "warning" };
		case "adopt-candidate": return { title: "Candidate adopted", tone: "success" };
		case "continue-cycle": return { title: "Next cycle started", tone: "success" };
	}
}

export interface RegisterBuilderCommandsOptions {
	workbench: CommandWorkbench;
	actorId: () => string;
	beginLiveTrace?: BeginBuilderLiveTrace;
	/** Shared transcript presenter; created locally when omitted. */
	presenter?: TranscriptPresenter;
	/** Invoked after any command that may change Workbench state (header refresh). */
	onWorkbenchChanged?: () => void | Promise<void>;
	/** Optional bridge to the conversation for “fix problem N” shortcuts. */
	sendUserMessage?: (text: string) => void;
}

export function registerAhdeBuilderCommands(
	pi: ExtensionAPI,
	options: RegisterBuilderCommandsOptions,
): void {
	const presenter = options.presenter ?? createTranscriptPresenter(pi);
	const workbench = options.workbench;

	const gate = (ctx: ExtensionCommandContext) => createWorkbenchHumanGate(
		ctx,
		options.actorId,
		(operation) => requireTui(ctx, operation),
		"candidate verification",
	);

	const changed = async (): Promise<void> => {
		try {
			await options.onWorkbenchChanged?.();
		} catch {
			// Header refresh is cosmetic; the decision already happened.
		}
	};

	const showDecision = async (
		ctx: ExtensionCommandContext,
		command: string,
		result: WorkbenchDecisionResult,
		liveTraceUrl?: string | null,
	): Promise<void> => {
		// Presentation is downstream of the durable decision: a rendering fault
		// degrades to the Workbench message instead of masking a completed step.
		let title = `/${command} completed`;
		let tone: TranscriptTone = "success";
		let lines: string[];
		let headline: string;
		try {
			({ title, tone } = decisionTitle(result));
			lines = renderDecision(result, markerPaint, { liveTraceUrl });
			headline = decisionHeadline(result);
		} catch {
			lines = [oneLine(result.message, 600), ...(liveTraceUrl ? [`Live trace retained for 15 minutes: ${liveTraceUrl}`] : [])];
			headline = oneLine(result.message, 200);
		}
		presenter.show(ctx, { title, tone, lines });
		presenter.note(
			`Operator ran /${command}: ${headline}. ` +
			`Workbench stage is now ${result.view.stage} (${stageLabel(result.view.stage)}): ${result.view.headline} ` +
			"Call ahde_workbench_view before relying on any earlier state.",
		);
		await changed();
	};

	/** Run one decision with human-friendly failure handling. */
	const decide = async (
		ctx: ExtensionCommandContext,
		command: string,
		input: WorkbenchDecisionInput,
		signal: AbortSignal | undefined,
		extra: Parameters<CommandWorkbench["decide"]>[2] = {},
	): Promise<WorkbenchDecisionResult | null> => {
		try {
			const result = await workbench.decide(input, gate(ctx), { signal, ...extra });
			return result;
		} catch (error) {
			if (signal?.aborted) throw error;
			const human = humanizeCommandError(error);
			if (human.tone === "error") throw new Error(human.message, { cause: error });
			ctx.ui.notify(human.message, human.tone === "info" ? "info" : "warning");
			return null;
		}
	};

	const runObserved = async (
		ctx: ExtensionCommandContext,
		command: string,
		input: WorkbenchDecisionInput,
		signal: AbortSignal | undefined,
	): Promise<void> => {
		const observation = await beginBuilderRunObservation(ctx.ui, options.beginLiveTrace);
		let outcome: BuilderLiveTraceOutcome = "error";
		let result: WorkbenchDecisionResult | null;
		try {
			result = await decide(ctx, command, input, signal, { onRunEvent: observation.onRunEvent });
			outcome = result ? "completed" : "aborted";
		} catch (error) {
			if (signal?.aborted) outcome = "aborted";
			observation.finish(outcome);
			if (observation.liveTraceUrl) {
				try {
					ctx.ui.notify(`Live trace retained for 15 minutes: ${observation.liveTraceUrl}`, "info");
				} catch {
					// Preserve the original run error when host notification fails.
				}
			}
			throw error;
		}
		observation.finish(outcome);
		if (result) await showDecision(ctx, command, result, observation.liveTraceUrl);
	};

	const askBranch = async (ctx: ExtensionCommandContext, suggested: string): Promise<string | null> => {
		const value = await ctx.ui.input("Candidate branch name", suggested);
		if (value === undefined) return null;
		return parseBranch(value.trim() || suggested);
	};

	const askVersion = async (ctx: ExtensionCommandContext): Promise<string | null> => {
		const value = await ctx.ui.input("Version to tag (semver, e.g. 0.2.0)", "0.1.0");
		if (value === undefined) return null;
		return parseVersion(value.trim());
	};

	const applyProposal = async (
		ctx: ExtensionCommandContext,
		signal: AbortSignal | undefined,
		branch: string | null,
		reason: string,
		runId?: string,
	): Promise<void> => {
		const chosen = branch ?? await askBranch(ctx, runId ? `candidate/${runId}` : "candidate/next");
		if (!chosen) return;
		const result = await decide(ctx, "apply", { kind: "apply-proposal", branch: chosen, reason, ...(runId ? { runId } : {}) }, signal);
		if (result) await showDecision(ctx, "apply", result);
	};

	const discardCurrent = async (ctx: ExtensionCommandContext, signal: AbortSignal | undefined, reason: string): Promise<void> => {
		const review = await workbench.view({ aspect: "review" });
		const detail = review.detail?.aspect === "review" ? review.detail.content : undefined;
		const input: WorkbenchDecisionInput = detail?.kind === "interrupted-candidate"
			? { kind: "abandon-candidate", candidateId: detail.candidateId, reason }
			: { kind: "discard-proposal", reason };
		const result = await decide(ctx, "discard", input, signal);
		if (result) await showDecision(ctx, "discard", result);
	};

	/**
	 * One human intent, one dialog, two receipts. The review and the release
	 * decision stay separate immutable records, but the operator confirms the
	 * whole intent once: the follow-up gate is pre-approved only for the same
	 * candidate id inside this single command invocation.
	 */
	const intentGate = (
		ctx: ExtensionCommandContext,
		intent: { title: string; summary: string; followUp: WorkbenchDecisionInput["kind"] },
	): ReturnType<typeof gate> => {
		const base = gate(ctx);
		let approvedCandidateId: string | null = null;
		const candidateIdOf = (subject: unknown): string | null => {
			const candidate = (subject as { candidate?: { candidateId?: unknown } } | null)?.candidate;
			return typeof candidate?.candidateId === "string" ? candidate.candidateId : null;
		};
		return {
			async confirm(confirmation, signal) {
				const candidateId = candidateIdOf(confirmation.subject);
				if (confirmation.kind === intent.followUp && approvedCandidateId && candidateId === approvedCandidateId) {
					return { approved: true, actorId: options.actorId() };
				}
				const approved = await ctx.ui.confirm(
					intent.title,
					[intent.summary, "", formatWorkbenchConfirmation(confirmation)].join("\n"),
					{ signal },
				);
				if (!approved) return { approved: false };
				approvedCandidateId = candidateId;
				return { approved: true, actorId: options.actorId() };
			},
			selectSealed: (request, signal) => base.selectSealed(request, signal),
		};
	};

	const decideWithGate = async (
		ctx: ExtensionCommandContext,
		input: WorkbenchDecisionInput,
		humanGate: ReturnType<typeof gate>,
		signal: AbortSignal | undefined,
	): Promise<WorkbenchDecisionResult | null> => {
		try {
			return await workbench.decide(input, humanGate, { signal });
		} catch (error) {
			if (signal?.aborted) throw error;
			const human = humanizeCommandError(error);
			if (human.tone === "error") throw new Error(human.message, { cause: error });
			ctx.ui.notify(human.message, human.tone === "info" ? "info" : "warning");
			return null;
		}
	};

	const promoteCurrent = async (
		ctx: ExtensionCommandContext,
		signal: AbortSignal | undefined,
		version: string | null,
		reason: string,
	): Promise<void> => {
		let view = await workbench.view();
		if (view.stage !== "candidate-review" && view.stage !== "release-decision") {
			throw new Error(`/promote is not available during ${stageLabel(view.stage)}; ${nextStep(view)}`);
		}
		const chosen = version ?? await askVersion(ctx);
		if (!chosen) return;
		const humanGate = intentGate(ctx, {
			title: `Promote candidate as v${chosen}`,
			summary: view.stage === "candidate-review"
				? `This records your review (recommend promote) and tags the exact verified revision as v${chosen}. Both receipts are written; you confirm once.`
				: `This tags the exact reviewed revision as v${chosen}.`,
			followUp: "promote-candidate",
		});
		if (view.stage === "candidate-review") {
			const reviewed = await decideWithGate(ctx, { kind: "review-candidate", recommendation: "promote", reason }, humanGate, signal);
			if (!reviewed) return;
			view = reviewed.view;
		}
		const result = await decideWithGate(ctx, { kind: "promote-candidate", version: chosen, reason }, humanGate, signal);
		if (result) await showDecision(ctx, "promote", result);
	};

	const rejectCurrent = async (ctx: ExtensionCommandContext, signal: AbortSignal | undefined, reason: string): Promise<void> => {
		let view = await workbench.view();
		if (view.stage !== "candidate-review" && view.stage !== "release-decision") {
			throw new Error(`/reject is not available during ${stageLabel(view.stage)}; ${nextStep(view)}`);
		}
		const humanGate = intentGate(ctx, {
			title: "Reject candidate",
			summary: view.stage === "candidate-review"
				? "This records your review (recommend reject) and rejects the candidate durably. The Target stays at its baseline. Both receipts are written; you confirm once."
				: "This rejects the reviewed candidate durably. The Target stays at its baseline.",
			followUp: "reject-candidate",
		});
		if (view.stage === "candidate-review") {
			const reviewed = await decideWithGate(ctx, { kind: "review-candidate", recommendation: "reject", reason }, humanGate, signal);
			if (!reviewed) return;
			view = reviewed.view;
		}
		const result = await decideWithGate(ctx, { kind: "reject-candidate", reason }, humanGate, signal);
		if (result) await showDecision(ctx, "reject", result);
	};

	const simpleDecision = async (
		ctx: ExtensionCommandContext,
		command: string,
		input: WorkbenchDecisionInput,
		signal: AbortSignal | undefined,
	): Promise<void> => {
		const result = await decide(ctx, command, input, signal);
		if (result) await showDecision(ctx, command, result);
	};

	/** Offer the stage's decisions right after the operator reviewed the exact subject. */
	const offerReviewActions = async (ctx: ExtensionCommandContext, view: WorkbenchView, signal: AbortSignal | undefined): Promise<void> => {
		if (typeof ctx.ui.select !== "function") return;
		const detail = view.detail?.aspect === "review" ? view.detail.content : undefined;
		const choose = async (title: string, choices: string[]): Promise<string | undefined> => {
			const selected = await ctx.ui.select(title, [...choices, "Just looking"], { signal });
			return selected === "Just looking" ? undefined : selected;
		};
		switch (view.stage) {
			case "spec-review": {
				const choice = await choose("Spec draft", ["Approve this Spec", "Ask for changes"]);
				if (choice === "Approve this Spec") await simpleDecision(ctx, "approve", { kind: "approve-spec", reason: "Approved from /review" }, signal);
				else if (choice === "Ask for changes") ctx.ui.notify("Tell the Builder what to change; it will save a new draft for review.", "info");
				return;
			}
			case "corpus-review": {
				const choice = await choose("Eval basket draft", ["Publish this basket", "Ask for changes"]);
				if (choice === "Publish this basket") await simpleDecision(ctx, "publish", { kind: "publish-corpus", reason: "Published from /review" }, signal);
				else if (choice === "Ask for changes") ctx.ui.notify("Tell the Builder which cases to add, replace, or regrade.", "info");
				return;
			}
			case "proposal-review": {
				const choice = await choose("Proposal", ["Apply to a candidate branch", "Discard"]);
				const runId = detail?.kind === "proposal" ? detail.runId : undefined;
				if (choice === "Apply to a candidate branch") await applyProposal(ctx, signal, null, "Applied from /review", runId);
				else if (choice === "Discard") await discardCurrent(ctx, signal, "Discarded from /review");
				return;
			}
			case "candidate-verification": {
				if (detail?.kind === "interrupted-candidate") {
					const choice = await choose("Interrupted candidate", ["Abandon this attempt"]);
					if (choice) await discardCurrent(ctx, signal, "Abandoned from /review");
				} else {
					const choice = await choose("Applied proposal", ["Verify the candidate now (/run)"]);
					if (choice) await runObserved(ctx, "run", { kind: "run-current", repetitions: 1, reason: "Verification from /review" }, signal);
				}
				return;
			}
			case "candidate-review":
			case "release-decision": {
				const choice = await choose("Candidate", ["Promote…", "Reject"]);
				if (choice === "Promote…") await promoteCurrent(ctx, signal, null, "Promoted from /review");
				else if (choice === "Reject") await rejectCurrent(ctx, signal, "Rejected from /review");
				return;
			}
			case "candidate-adoption": {
				const choice = await choose("Promoted candidate", ["Adopt as the active Target"]);
				if (choice) await simpleDecision(ctx, "adopt", { kind: "adopt-candidate", reason: "Adopted from /review" }, signal);
				return;
			}
			case "complete": {
				const choice = await choose("Cycle complete", ["Start the next cycle"]);
				if (choice) await simpleDecision(ctx, "next", { kind: "continue-cycle", reason: "Continued from /review" }, signal);
				return;
			}
			default:
				return;
		}
	};

	pi.registerCommand("help", {
		description: "Show the AHDE Builder workflow and shortcuts",
		async handler(args, ctx) {
			noArguments("help", args);
			await prepare(ctx, "help");
			presenter.show(ctx, { title: "AHDE Builder help", tone: "info", lines: BUILDER_HELP.split("\n").slice(2) });
		},
	});

	pi.registerCommand("doctor", {
		description: "Check Builder authentication, Target readiness, and recovery steps",
		async handler(args, ctx) {
			noArguments("doctor", args);
			await prepare(ctx, "doctor");
			const view = await workbench.view();
			const model = ctx.model;
			const credentialPresent = model ? ctx.modelRegistry.hasConfiguredAuth(model) : false;
			const p = markerPaint;
			const ok = (text: string) => p.success(`✓ ${text}`);
			const warn = (text: string) => p.warning(`! ${text}`);
			const lines: string[] = [];
			lines.push(model
				? (credentialPresent ? ok(`Builder model ${model.provider}/${model.id} · credential present (provider access is verified on first request)`) : warn(`Builder model ${model.provider}/${model.id} has no credential — /login, or /model to pick a configured model`))
				: warn("No Builder model selected — /login to connect a provider, then /model"));
			if (view.target.status === "missing") lines.push(warn("No Target yet — describe the agent and the Builder will create it"));
			else if (view.target.status === "bootstrap-required") lines.push(warn("Target exists but its model is not chosen — tell the Builder which model to use"));
			else {
				lines.push(ok(`Target ${view.target.id} @ ${view.target.gitSha?.slice(0, 10) ?? "—"}`));
				const target = view.target.model;
				if (target) {
					lines.push(target.credentialPresent
						? ok(`Target model ${target.provider}/${target.id} · ${target.apiKeyEnv} is set`)
						: warn(`Target model ${target.provider}/${target.id} · export ${target.apiKeyEnv} in the shell that runs ahde before /run`));
				}
			}
			lines.push(`${p.dim("Stage")} ${stageLabel(view.stage)} · ${nextStep(view)}`);
			for (const blocker of view.blockers) lines.push(warn(oneLine(blocker, 200)));
			for (const warning of view.warnings.slice(0, 6)) lines.push(p.muted(`· ${oneLine(warning, 200)}`));
			const ready = Boolean(model && credentialPresent && view.target.status === "ready" && view.target.model?.credentialPresent && view.blockers.length === 0);
			lines.push(ready ? ok("Ready: everything needed for /run is in place") : warn("Action required before the next run"));
			presenter.show(ctx, { title: "AHDE Doctor", tone: ready ? "success" : "warning", lines });
		},
	});

	pi.registerCommand("status", {
		description: "Show where you are in the AHDE workflow and the next step",
		async handler(args, ctx) {
			noArguments("status", args);
			await prepare(ctx, "status");
			const view = await workbench.view({ aspect: "summary" });
			presenter.show(ctx, { title: viewTitle(view), tone: view.blockers.length > 0 ? "warning" : "info", lines: renderStatus(view, markerPaint) });
		},
	});

	pi.registerCommand("run", {
		description: "Run the development basket or verify the applied candidate: /run [repetitions] [reason]",
		async handler(args, ctx) {
			const signal = await prepare(ctx, "run");
			const parsed = parseRun(args);
			await runObserved(ctx, "run", { kind: "run-current", repetitions: parsed.repetitions, reason: parsed.reason }, signal);
		},
	});

	pi.registerCommand("traces", {
		description: "Show the diagnosis, failure modes, and the read-only evidence link",
		async handler(args, ctx) {
			noArguments("traces", args);
			const signal = await prepare(ctx, "traces");
			const view = await workbench.view({ aspect: "traces" });
			if (view.detail?.aspect !== "traces") {
				presenter.show(ctx, { title: viewTitle(view), tone: "warning", lines: renderStatus(view, markerPaint) });
				return;
			}
			presenter.show(ctx, { title: "AHDE · Diagnosis", tone: "info", lines: renderTraces(view.detail.content, markerPaint) });
			const modes = view.detail.content.improvementBrief.modes.filter((mode) => mode.selectableForProposal);
			if (modes.length > 0 && options.sendUserMessage && typeof ctx.ui.select === "function") {
				const choices = modes.slice(0, 5).map((mode) => `Fix ${mode.ordinal}: ${oneLine(mode.title, 60)}`);
				const selected = await ctx.ui.select("Prepare a proposal?", [...choices, "Not now"], { signal });
				const index = choices.indexOf(selected ?? "");
				if (index >= 0) {
					const mode = modes[index]!;
					options.sendUserMessage(`Fix problem ${mode.ordinal} (${mode.failureModeId}): ${oneLine(mode.title, 120)}. Prepare the proposal and show me the review.`);
				}
			}
		},
	});

	pi.registerCommand("review", {
		description: "Show the exact artifact awaiting your review and offer its decisions",
		async handler(args, ctx) {
			noArguments("review", args);
			const signal = await prepare(ctx, "review");
			const view = await workbench.view({ aspect: "review" });
			const lines = view.detail?.aspect === "review"
				? renderReview(view.detail.content, markerPaint)
				: renderStatus(view, markerPaint);
			presenter.show(ctx, { title: viewTitle(view), tone: view.blockers.length > 0 ? "warning" : "info", lines });
			await offerReviewActions(ctx, view, signal);
		},
	});

	pi.registerCommand("approve", {
		description: "Approve the reviewed Spec draft: /approve [reason]",
		async handler(args, ctx) {
			const signal = await prepare(ctx, "approve");
			await simpleDecision(ctx, "approve", { kind: "approve-spec", reason: reasonOrDefault(args, "approve") }, signal);
		},
	});

	pi.registerCommand("publish", {
		description: "Publish the reviewed eval basket as development evidence: /publish [name]",
		async handler(args, ctx) {
			const signal = await prepare(ctx, "publish");
			const name = args.trim();
			await simpleDecision(ctx, "publish", { kind: "publish-corpus", ...(name ? { name } : {}), reason: "Requested interactively via /publish" }, signal);
		},
	});

	pi.registerCommand("apply", {
		description: "Apply the reviewed proposal to a candidate branch: /apply [branch] [reason]",
		async handler(args, ctx) {
			const signal = await prepare(ctx, "apply");
			const parsed = parseApply(args);
			await applyProposal(ctx, signal, parsed.branch, parsed.reason);
		},
	});

	pi.registerCommand("discard", {
		description: "Discard the reviewed proposal or abandon an interrupted candidate: /discard [reason]",
		async handler(args, ctx) {
			const signal = await prepare(ctx, "discard");
			await discardCurrent(ctx, signal, reasonOrDefault(args, "discard"));
		},
	});

	pi.registerCommand("promote", {
		description: "Promote the verified candidate: /promote <version> [reason]",
		async handler(args, ctx) {
			const signal = await prepare(ctx, "promote");
			const parsed = parsePromote(args);
			await promoteCurrent(ctx, signal, parsed.version, parsed.reason);
		},
	});

	pi.registerCommand("reject", {
		description: "Reject the verified candidate: /reject [reason]",
		async handler(args, ctx) {
			const signal = await prepare(ctx, "reject");
			await rejectCurrent(ctx, signal, reasonOrDefault(args, "reject"));
		},
	});

	pi.registerCommand("adopt", {
		description: "Fast-forward the current branch to the promoted candidate: /adopt [reason]",
		async handler(args, ctx) {
			const signal = await prepare(ctx, "adopt");
			await simpleDecision(ctx, "adopt", { kind: "adopt-candidate", reason: reasonOrDefault(args, "adopt") }, signal);
		},
	});

	pi.registerCommand("next", {
		description: "Close this improvement cycle and continue with the active Target: /next [reason]",
		async handler(args, ctx) {
			const signal = await prepare(ctx, "next");
			await simpleDecision(ctx, "next", { kind: "continue-cycle", reason: reasonOrDefault(args, "next") }, signal);
		},
	});

	pi.registerCommand("target", {
		description: "Show the exact committed Target, or one declared resource: /target [resource-path]",
		async handler(args, ctx) {
			await prepare(ctx, "target");
			const resourcePath = args.trim();
			if (/\s/.test(resourcePath)) {
				throw new Error("/target accepts at most one declared repository-relative resource path");
			}
			const view = await workbench.view({ aspect: "target", ...(resourcePath ? { resourcePath } : {}) });
			const lines = view.detail?.aspect === "target"
				? renderTarget(view.detail.content, markerPaint)
				: renderStatus(view, markerPaint);
			presenter.show(ctx, { title: resourcePath ? `AHDE · ${oneLine(resourcePath, 60)}` : "AHDE · Target", tone: "info", lines });
		},
	});
}

/** Counts used by the header when a decision changed evidence. */
export function describeEvidence(view: WorkbenchView): string {
	return `${pluralize(view.counts.developmentEvals, "eval run")} · ${pluralize(view.counts.openProposals, "open proposal")} · ${pluralize(view.counts.candidates, "candidate")}`;
}
