import { t } from "../i18n.js";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AhdeWorkbench } from "../workbench/workbench.js";
import { SEALED_GATE_POLICY } from "../domain/comparison-gate.js";
import { DEFAULT_REPETITIONS } from "../workbench/calibration.js";
import {
	WorkbenchDecisionDeclinedError,
	WorkbenchSelectionRequiredError,
	WorkbenchStaleDecisionError,
} from "../workbench/errors.js";
import type {
	WorkbenchDecisionInput,
	WorkbenchDecisionResult,
	WorkbenchStartTestingResult,
	WorkbenchVerifyCandidateResult,
	WorkbenchView,
} from "../workbench/types.js";
import { compileAgentLog } from "../application/agent-log.js";
import {
	compileVersionPassport,
	renderVersionPassportMarkdown,
} from "../application/version-passport.js";
import { writeTextArtifact } from "../storage/artifacts.js";
import { oneLine, pluralize } from "./render/format.js";
import { renderAgentLog } from "./render/agent-log.js";
import { renderVersionPassport } from "./render/passport.js";
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
import { formatWorkbenchConfirmation } from "./workbench-gate.js";
import { createPolicyAwareGate } from "./workbench-adapter.js";

type CommandWorkbench = Pick<
	AhdeWorkbench,
	"view" | "decide" | "projectDir" | "stateRoot" | "runsRoot" | "projectId"
>;

export const AHDE_BUILDER_COMMAND_NAMES = [
	// The three verbs the operator actually says; everything below is a shortcut
	// or an inspection, and several are aliases of these.
	"test",
	"fix",
	"ship",
	"help",
	"doctor",
	"holdout",
	"status",
	"run",
	"calibrate",
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
	"passport",
	"log",
] as const;

/** The `/help` reference, in the operator's language. */
const builderHelp = (): string => t("help.body");

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

function parseRepetitions(args: string, command: string): { repetitions: number; reason: string } {
	const fallback = `Requested interactively via /${command}`;
	const trimmed = args.trim();
	if (!trimmed) return { repetitions: DEFAULT_REPETITIONS, reason: fallback };
	const tokens = trimmed.split(/\s+/);
	if (!/^\d+$/.test(tokens[0] ?? "")) {
		return { repetitions: DEFAULT_REPETITIONS, reason: trimmed };
	}
	const repetitions = Number(tokens.shift());
	if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
		throw new Error(`/${command} repetitions must be an integer between 1 and 10`);
	}
	return { repetitions, reason: tokens.join(" ") || fallback };
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

/** `/fix [n] [note]`: the ordinal from `/traces`, or the first problem. */
function parseOrdinal(args: string, command: string): { ordinal: number | null; note: string } {
	const trimmed = args.trim();
	if (!trimmed) return { ordinal: null, note: "" };
	const tokens = trimmed.split(/\s+/);
	if (!/^\d+$/.test(tokens[0] ?? "")) return { ordinal: null, note: trimmed };
	const ordinal = Number(tokens.shift());
	if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 100) {
		throw new Error(`/${command} takes the problem number shown by /traces`);
	}
	return { ordinal, note: tokens.join(" ") };
}

function parseApply(args: string): { branch: string | null; reason: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const branch = tokens.shift();
	return {
		branch: branch ? parseBranch(branch) : null,
		reason: tokens.join(" ") || "Requested interactively via /apply",
	};
}

function parsePromote(args: string, command = "promote"): { version: string | null; reason: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const version = tokens.shift();
	return {
		version: version ? parseVersion(version) : null,
		reason: tokens.join(" ") || `Requested interactively via /${command}`,
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

function startTestingTitle(result: WorkbenchStartTestingResult): { title: string; tone: TranscriptTone } {
	if (!result.evaluation) return { title: t("panel.ready-next"), tone: "info" };
	return { title: t("panel.run-complete"), tone: result.evaluation.evaluation.summary.error > 0 ? "warning" : "success" };
}

function verifyTitle(result: WorkbenchVerifyCandidateResult): { title: string; tone: TranscriptTone } {
	return result.outcome === "stopped-by-screen"
		? { title: t("panel.cheap-check-nothing"), tone: "info" }
		: { title: t("panel.candidate-verified"), tone: "success" };
}

function decisionTitle(result: WorkbenchDecisionResult): { title: string; tone: TranscriptTone } {
	switch (result.kind) {
		case "run-eval": return { title: t("panel.run-complete"), tone: result.result.evaluation.summary.error > 0 ? "warning" : "success" };
		case "run-current":
			if (result.result.resolvedAs === "run-eval") {
				return { title: t("panel.run-complete"), tone: result.result.evaluation.summary.error > 0 ? "warning" : "success" };
			}
			if (result.result.resolvedAs === "start-testing") return startTestingTitle(result.result);
			return verifyTitle(result.result);
		case "start-testing": return startTestingTitle(result.result);
		case "ship": return { title: t("panel.shipped"), tone: "success" };
		case "verify-candidate": return verifyTitle(result.result);
		case "improve":
			return {
				title: t("panel.improvement-complete"),
				tone: result.result.candidateId ? "success" : "info",
			};
		case "calibrate":
			return {
				title: t("panel.noise-calibrated"),
				tone: result.result.calibration.verdict === "inconclusive" ? "success" : "warning",
			};
		case "scaffold-target": return { title: t("panel.target-created"), tone: "success" };
		case "configure-target": return { title: t("panel.target-configured"), tone: "success" };
		case "configure-evaluators":
			return {
				title: t("panel.evaluators-configured"),
				// A configured judge whose key is not exported fails at the first
				// graded case, so the line is a warning until the shell has it.
				tone: "success",
			};
		case "approve-spec": return { title: t("panel.spec-approved"), tone: "success" };
		case "publish-corpus": return { title: t("panel.basket-published"), tone: "success" };
		case "import-dataset": return { title: t("panel.dataset-imported"), tone: "success" };
		case "apply-proposal": return { title: t("panel.proposal-applied"), tone: "success" };
		case "discard-proposal": return { title: t("panel.proposal-discarded"), tone: "info" };
		case "abandon-candidate": return { title: t("panel.attempt-abandoned"), tone: "info" };
		case "review-candidate": return { title: t("panel.review-recorded"), tone: "info" };
		case "promote-candidate": return { title: t("panel.candidate-promoted"), tone: "success" };
		case "reject-candidate": return { title: t("panel.candidate-rejected"), tone: "warning" };
		case "adopt-candidate": return { title: t("panel.candidate-adopted"), tone: "success" };
		case "continue-cycle": return { title: t("panel.next-cycle"), tone: "success" };
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
	/** Host-only sealed import. The path and corpus identity never enter Builder Pi. */
	importSealedHoldout?: (input: { sourcePath: string; name: string }) => { taskCount: number };
}

export function registerAhdeBuilderCommands(
	pi: ExtensionAPI,
	options: RegisterBuilderCommandsOptions,
): void {
	const presenter = options.presenter ?? createTranscriptPresenter(pi);
	const workbench = options.workbench;

	const gate = (ctx: ExtensionCommandContext) => createPolicyAwareGate(
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

	const askVersion = async (ctx: ExtensionCommandContext): Promise<string | null> => {
		const value = await ctx.ui.input("Version to tag (semver, e.g. 0.2.0)", "0.1.0");
		if (value === undefined) return null;
		return parseVersion(value.trim());
	};

	/**
	 * Apply is one dialog: the exact diff was rendered by /review (and is
	 * rendered again here when the operator jumps straight to /apply), the
	 * branch defaults to candidate/<proposal>, and the confirmation stays short.
	 */
	const applyProposal = async (
		ctx: ExtensionCommandContext,
		signal: AbortSignal | undefined,
		branch: string | null,
		reason: string,
		runId?: string,
		options: { showReview?: boolean } = {},
	): Promise<void> => {
		const review = await workbench.view({ aspect: "review" });
		const detail = review.detail?.aspect === "review" ? review.detail.content : undefined;
		const proposalRunId = runId ?? (detail?.kind === "proposal" ? detail.runId : undefined);
		if (options.showReview !== false && detail?.kind === "proposal") {
			presenter.show(ctx, { title: viewTitle(review), tone: "info", lines: renderReview(detail, markerPaint) });
		}
		const chosen = branch ?? `candidate/${proposalRunId ?? "next"}`;
		const result = await decide(ctx, "apply", { kind: "apply-proposal", branch: chosen, reason, ...(proposalRunId ? { runId: proposalRunId } : {}) }, signal);
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
					[
						intent.summary,
						"",
						// A terminal decision with nothing to study stays one question.
						confirmation.policy === "one-question" ? confirmation.question : formatWorkbenchConfirmation(confirmation),
					].join("\n"),
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
				if (choice === "Apply to a candidate branch") await applyProposal(ctx, signal, null, "Applied from /review", runId, { showReview: false });
				else if (choice === "Discard") await discardCurrent(ctx, signal, "Discarded from /review");
				return;
			}
			case "candidate-verification": {
				if (detail?.kind === "interrupted-candidate") {
					const choice = await choose("Interrupted candidate", ["Abandon this attempt"]);
					if (choice) await discardCurrent(ctx, signal, "Abandoned from /review");
				} else {
					const choice = await choose("Applied proposal", ["Verify the candidate now (/run)"]);
					if (choice) await runObserved(ctx, "run", { kind: "run-current", repetitions: DEFAULT_REPETITIONS, reason: "Verification from /review" }, signal);
				}
				return;
			}
			case "candidate-review":
			case "release-decision": {
				const choice = await choose("Candidate", ["Ship it…", "Reject"]);
				if (choice === "Ship it…") await shipCurrent(ctx, signal, null, "Shipped from /review");
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

	/**
	 * “Ship it” is one dialog over the release decisions that are left. The exact
	 * receipts are still four separate immutable records underneath.
	 */
	const shipCurrent = async (
		ctx: ExtensionCommandContext,
		signal: AbortSignal | undefined,
		version: string | null,
		reason: string,
	): Promise<void> => {
		const view = await workbench.view();
		const shippable = ["candidate-review", "release-decision", "candidate-adoption", "complete"];
		if (!shippable.includes(view.stage)) {
			throw new Error(`/ship is not available during ${stageLabel(view.stage)}; ${nextStep(view)}`);
		}
		const needsVersion = view.stage === "candidate-review" || view.stage === "release-decision";
		const chosen = version ?? (needsVersion ? await askVersion(ctx) : null);
		if (needsVersion && !chosen) return;
		const result = await decide(ctx, "ship", {
			kind: "ship",
			...(chosen ? { version: chosen } : {}),
			reason,
		}, signal);
		if (result) await showDecision(ctx, "ship", result);
	};

	/**
	 * “Fix problem n” is the model's work, not a decision: the command resolves
	 * the ordinal against a fresh brief and asks the Builder for the proposal.
	 */
	const fixProblem = async (
		ctx: ExtensionCommandContext,
		ordinal: number | null,
		note: string,
	): Promise<void> => {
		const view = await workbench.view({ aspect: "traces" });
		if (view.detail?.aspect !== "traces") {
			presenter.show(ctx, { title: viewTitle(view), tone: "warning", lines: renderStatus(view, markerPaint) });
			ctx.ui.notify(`Nothing to fix yet — ${nextStep(view)}`, "info");
			return;
		}
		presenter.show(ctx, { title: t("panel.title", { detail: t("panel.diagnosis") }), tone: "info", lines: renderTraces(view.detail.content, markerPaint) });
		const modes = view.detail.content.improvementBrief.modes.filter((mode) => mode.selectableForProposal);
		if (modes.length === 0) {
			ctx.ui.notify("No failure mode has enough evidence to change the harness yet. Run again, or add cases.", "info");
			return;
		}
		const mode = ordinal === null ? modes[0]! : modes.find((candidate) => candidate.ordinal === ordinal);
		if (!mode) {
			throw new Error(`there is no problem ${ordinal} to fix; /traces lists ${pluralize(modes.length, "fixable problem")}`);
		}
		const request = `Fix problem ${mode.ordinal} (${mode.failureModeId}): ${oneLine(mode.title, 120)}. ` +
			`Prepare the proposal and show me the review.`;
		if (!options.sendUserMessage) {
			ctx.ui.notify(`Ask the Builder: “fix problem ${mode.ordinal}”.`, "info");
			return;
		}
		options.sendUserMessage(note ? `${request} ${note}` : request);
	};

	pi.registerCommand("test", {
		description: "Test the agent: publish and run whatever is pending, or verify the applied candidate: /test [repetitions] [reason]",
		async handler(args, ctx) {
			const signal = await prepare(ctx, "test");
			const parsed = parseRepetitions(args, "test");
			await runObserved(ctx, "test", { kind: "run-current", repetitions: parsed.repetitions, reason: parsed.reason }, signal);
		},
	});

	pi.registerCommand("fix", {
		description: "Prepare the exact change for problem n from the current diagnosis: /fix [n] [reason]",
		async handler(args, ctx) {
			await prepare(ctx, "fix");
			const parsed = parseOrdinal(args, "fix");
			await fixProblem(ctx, parsed.ordinal, parsed.note);
		},
	});

	pi.registerCommand("ship", {
		description: "Ship the verified candidate — promote, adopt, next cycle: /ship [version] [reason]",
		async handler(args, ctx) {
			const signal = await prepare(ctx, "ship");
			const parsed = parsePromote(args, "ship");
			await shipCurrent(ctx, signal, parsed.version, parsed.reason);
		},
	});

	pi.registerCommand("help", {
		description: "Show the AHDE Builder workflow and shortcuts",
		async handler(args, ctx) {
			noArguments("help", args);
			await prepare(ctx, "help");
			presenter.show(ctx, { title: t("panel.help"), tone: "info", lines: builderHelp().split("\n").slice(2) });
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
				? (credentialPresent
					? ok(t("doctor.builder-ok", { model: `${model.provider}/${model.id}` }))
					: warn(t("doctor.builder-no-credential", { model: `${model.provider}/${model.id}` })))
				: warn(t("doctor.builder-none")));
			if (view.target.status === "missing") lines.push(warn(t("doctor.target-missing")));
			else if (view.target.status === "bootstrap-required") lines.push(warn(t("doctor.target-bootstrap")));
			else {
				lines.push(ok(t("doctor.target-ok", { id: view.target.id ?? "—", sha: view.target.gitSha?.slice(0, 10) ?? "—" })));
				const target = view.target.model;
				if (target) {
					const model = `${target.provider}/${target.id}`;
					lines.push(target.credentialPresent
						? ok(t("doctor.target-model-ok", { model, env: target.apiKeyEnv }))
						: warn(t("doctor.target-model-missing", { model, env: target.apiKeyEnv })));
				}
			}
			const evaluators = view.target.evaluators ?? { judge: null, simulatedUser: null };
			const evaluatorLabels = {
				judge: t("doctor.judge-model"),
				simulatedUser: t("doctor.simulated-user-model"),
			} as const;
			for (const role of ["judge", "simulatedUser"] as const) {
				const evaluator = evaluators[role];
				const label = evaluatorLabels[role];
				const required = view.target.evaluatorRequirements?.[role] ?? evaluator !== null;
				if (!evaluator) {
					lines.push(required
						? warn(t("doctor.evaluator-required", { label }))
						: p.muted(t("doctor.evaluator-optional", { label })));
					continue;
				}
				const model = `${evaluator.provider}/${evaluator.id}`;
				lines.push(evaluator.credentialPresent
					? ok(t("doctor.evaluator-ok", { label, model, env: evaluator.apiKeyEnv }))
					: required
						? warn(t("doctor.evaluator-missing", { label, model, env: evaluator.apiKeyEnv }))
						: p.muted(t("doctor.evaluator-unused", { label, model, env: evaluator.apiKeyEnv })));
			}
			const shipping = view.counts.approvedSpecs > 0 ? view.shippingReadiness : undefined;
			if (shipping?.sealedHoldout === "ready") {
				lines.push(ok(t("doctor.gate-ready")));
			} else if (shipping) {
				lines.push(warn(
					shipping.sealedHoldout === "missing"
						? t("doctor.gate-missing", { minimum: shipping.minimumTasks })
						: shipping.sealedHoldout === "underpowered"
							? t("doctor.gate-underpowered", { minimum: shipping.minimumTasks })
							: t("doctor.gate-unavailable"),
				));
			}
			lines.push(`${p.dim(t("label.stage"))} ${stageLabel(view.stage)} · ${nextStep(view)}`);
			for (const blocker of view.blockers) lines.push(warn(oneLine(blocker, 200)));
			for (const warning of view.warnings.slice(0, 6)) lines.push(p.muted(`· ${oneLine(warning, 200)}`));
			const evaluatorsReady = (["judge", "simulatedUser"] as const).every((role) => {
				const required = view.target.evaluatorRequirements?.[role] ?? evaluators[role] !== null;
				return !required || Boolean(evaluators[role]?.credentialPresent);
			});
			const ready = Boolean(
				model && credentialPresent && view.target.status === "ready" &&
				view.target.model?.credentialPresent && evaluatorsReady && view.blockers.length === 0
			);
			lines.push(ready ? ok(t("doctor.ready")) : warn(t("doctor.action-required")));
			presenter.show(ctx, { title: t("panel.doctor"), tone: ready ? "success" : "warning", lines });
		},
	});

	pi.registerCommand("holdout", {
		description: "Privately import an operator-owned sealed JSONL exam; its content and identity stay hidden from Builder Pi",
		async handler(args, ctx) {
			noArguments("holdout", args);
			await prepare(ctx, "holdout");
			if (!options.importSealedHoldout) throw new Error("sealed holdout import is unavailable in this host");
			const sourcePath = await ctx.ui.input(
				"Path to the private sealed JSONL corpus",
				"./private-holdout.jsonl",
			);
			if (sourcePath === undefined || !sourcePath.trim()) {
				ctx.ui.notify("Cancelled — nothing changed.", "info");
				return;
			}
			const name = await ctx.ui.input("Name for this immutable exam", "Promotion holdout");
			if (name === undefined || !name.trim()) {
				ctx.ui.notify("Cancelled — nothing changed.", "info");
				return;
			}
			const approved = await ctx.ui.confirm(
				"Import sealed holdout",
				`Import ${sourcePath.trim()} as an evaluator-only exam? Builder Pi will see only whether it is large enough to ship.`,
				{ signal: ctx.signal },
			);
			if (!approved) {
				ctx.ui.notify("Cancelled — nothing changed.", "info");
				return;
			}
			const result = options.importSealedHoldout({ sourcePath: sourcePath.trim(), name: name.trim() });
			await options.onWorkbenchChanged?.();
			const minimum = SEALED_GATE_POLICY.minTasks;
			presenter.show(ctx, {
				title: t("panel.holdout-imported"),
				tone: result.taskCount >= minimum ? "success" : "warning",
				lines: result.taskCount >= minimum
					? [`${result.taskCount} evaluator-only cases are ready for the ship gate.`, "Builder Pi never receives their content or identity."]
					: [`${result.taskCount} evaluator-only cases were imported; the ship gate needs at least ${minimum}.`, "Import a sufficiently large, separate holdout before applying a candidate."],
			});
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
			const parsed = parseRepetitions(args, "run");
			await runObserved(ctx, "run", { kind: "run-current", repetitions: parsed.repetitions, reason: parsed.reason }, signal);
		},
	});

	pi.registerCommand("calibrate", {
		description: "Measure run-to-run noise by running this exact revision against itself: /calibrate [repetitions] [reason]",
		async handler(args, ctx) {
			const signal = await prepare(ctx, "calibrate");
			const parsed = parseRepetitions(args, "calibrate");
			await runObserved(ctx, "calibrate", { kind: "calibrate", repetitions: parsed.repetitions, reason: parsed.reason }, signal);
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
			presenter.show(ctx, { title: t("panel.title", { detail: t("panel.diagnosis") }), tone: "info", lines: renderTraces(view.detail.content, markerPaint) });
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
			presenter.show(ctx, { title: t("panel.title", { detail: resourcePath ? oneLine(resourcePath, 60) : t("panel.target") }), tone: "info", lines });
		},
	});

	/**
	 * The version passport: what the shipped agent promised, what it measured,
	 * how far its judge has been checked, and what is still unknown. It is a
	 * read of durable artifacts — nothing here runs, spends, or decides — and it
	 * lands twice: on screen now, and as a file the operator can send to someone
	 * who was not in the room.
	 */
	pi.registerCommand("passport", {
		description: "Show what a shipped version promised and measured, and write it beside the agent: /passport [version]",
		async handler(args, ctx) {
			await prepare(ctx, "passport");
			const version = args.trim();
			if (/\s/.test(version)) throw new Error("/passport accepts at most one version, for example /passport 0.2.0");
			const view = await workbench.view();
			const passport = compileVersionPassport({
				runsRoot: workbench.runsRoot,
				stateRoot: workbench.stateRoot,
				projectId: workbench.projectId,
				...(version ? { version } : {}),
				...(view.target.id ? { targetId: view.target.id } : {}),
				model: view.target.model ? { provider: view.target.model.provider, id: view.target.model.id } : null,
			});
			// The tag is host-minted semver, but the filename is still built from a
			// bounded character set rather than from whatever the tag says.
			const slug = passport.version.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
			const name = `passport-${slug.startsWith("v") ? slug : `v${slug}`}.md`;
			const file = join(workbench.projectDir, name);
			let written: string | null = name;
			try {
				writeTextArtifact(file, renderVersionPassportMarkdown(passport));
			} catch {
				// The page is worth reading even when the file cannot be written.
				written = null;
			}
			presenter.show(ctx, {
				title: t("panel.title", { detail: t("panel.passport") }),
				tone: "info",
				lines: [
					...renderVersionPassport(passport, markerPaint),
					"",
					written
						? `${markerPaint.dim("Written to")} ${oneLine(written, 100)}`
						: markerPaint.warning("This directory is not writable, so nothing was saved beside the agent."),
				],
			});
		},
	});

	/** The growth log: every decided attempt, newest first, and the curve under it. */
	pi.registerCommand("log", {
		description: "Show how the agent grew: every promoted and rejected version: /log [rows]",
		async handler(args, ctx) {
			await prepare(ctx, "log");
			const requested = args.trim();
			if (requested && !/^\d{1,3}$/.test(requested)) throw new Error("/log accepts a row count, for example /log 10");
			const view = await workbench.view();
			const log = compileAgentLog({
				runsRoot: workbench.runsRoot,
				projectId: workbench.projectId,
				...(view.target.id ? { targetId: view.target.id } : {}),
				...(requested ? { limit: Number(requested) } : {}),
			});
			presenter.show(ctx, { title: t("panel.title", { detail: t("panel.growth") }), tone: "info", lines: renderAgentLog(log, markerPaint) });
		},
	});
}

/** Counts used by the header when a decision changed evidence. */
export function describeEvidence(view: WorkbenchView): string {
	return `${pluralize(view.counts.developmentEvals, "eval run")} · ${pluralize(view.counts.openProposals, "open proposal")} · ${pluralize(view.counts.candidates, "candidate")}`;
}
