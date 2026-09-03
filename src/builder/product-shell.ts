import { t } from "../i18n.js";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type AutocompleteProvider, type TUI } from "@earendil-works/pi-tui";
import type { AhdeWorkbench } from "../workbench/workbench.js";
import type { WorkbenchStage, WorkbenchView } from "../workbench/types.js";
import { loadJudgeCalibration } from "../application/judge-labels.js";
import { themePaint } from "./render/paint.js";
import { AHDE_BUILDER_COMMAND_NAMES } from "./commands.js";
import { compilePlan } from "./render/plan.js";
import { nextStep, stageLabel } from "./render/stage.js";
import { renderStatusBar } from "./render/status-bar.js";
import { renderHeader, type HeaderState } from "./render/view.js";
import type { BuilderSpendReader } from "./spend.js";
import { confirmDeclaredToolCredentials, runFirstRunOnboarding } from "./onboarding.js";
import {
	createTranscriptPresenter,
	registerAhdeTranscriptRenderer,
	type TranscriptPresenter,
} from "./transcript.js";

/** The AHDE verbs, by the exact value the `/` palette completes to. */
const AHDE_PALETTE_NAMES: ReadonlySet<string> = new Set(AHDE_BUILDER_COMMAND_NAMES);

/**
 * AHDE's own commands lead the `/` menu.
 *
 * Pi builds one ordered list — its built-ins, then prompt templates, then
 * extension commands, then skills — so an operator typing “/” met `model,
 * thinking, copy, name, session` and a counter reading 45 before a single AHDE
 * verb. `preferredExtensionCommands` does not help: it only decides which side
 * wins a NAME collision, never the order.
 *
 * So this moves AHDE's half to the front of whatever the built-in provider
 * already returned. It is a stable partition: nothing is hidden, nothing is
 * re-scored, and inside each half the ranking Pi computed — fuzzy, once the
 * operator types — stands exactly as it was. Only the command-name context is
 * touched; arguments, `@` attachments and paths pass straight through.
 */
export function ahdeCommandsFirst(current: AutocompleteProvider): AutocompleteProvider {
	return {
		...(current.triggerCharacters ? { triggerCharacters: current.triggerCharacters } : {}),
		async getSuggestions(lines, cursorLine, cursorCol, suggestOptions) {
			const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, suggestOptions);
			// `/`, `/tr` — a bare command name being typed, never a path or an argument.
			if (!suggestions || !/^\/[^\s/]*$/.test(suggestions.prefix)) return suggestions;
			const ahde = suggestions.items.filter((item) => AHDE_PALETTE_NAMES.has(item.value));
			if (ahde.length === 0 || ahde.length === suggestions.items.length) return suggestions;
			return {
				...suggestions,
				items: [...ahde, ...suggestions.items.filter((item) => !AHDE_PALETTE_NAMES.has(item.value))],
			};
		},
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
			current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
		...(current.shouldTriggerFileCompletion
			? {
				shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
					current.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol),
			}
			: {}),
	};
}

type ProductWorkbench =
	& Pick<AhdeWorkbench, "view">
	& Partial<Pick<AhdeWorkbench, "decide" | "stateRoot" | "projectId" | "runsRoot" | "projectDir">>;

export interface ProductShellController {
	/** Re-read Workbench state and redraw the header/status; never throws. */
	refresh(): Promise<void>;
}

export interface ProductShellOptions {
	/** Enables the host-driven first-run setup (create agent here, choose its model). */
	actorId?: () => string;
	presenter?: TranscriptPresenter;
	/**
	 * What this cycle has already cost, read back from the records it wrote.
	 * Omitted in hosts and tests that have no runs root; the footer then simply
	 * carries fewer segments.
	 */
	spend?: BuilderSpendReader;
	/** Wall clock, injected so a test can pin the elapsed segment. */
	now?: () => number;
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
		return t("model.auth-rejected");
	}
	if (/\b429\b|rate.?limit|too many requests/i.test(source)) {
		return t("model.rate-limited");
	}
	if (/fetch failed|ECONNREFUSED|ENOTFOUND|network|socket|connection/i.test(source)) {
		return t("model.unreachable");
	}
	return t("model.failed");
}

const LOGIN_CHOICE = (): string => t("onboarding.login-choice");
const MODEL_CHOICE = (): string => t("onboarding.model-choice");
const LATER_CHOICE = (): string => t("onboarding.later-choice");

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
		plan: null,
	};

	/**
	 * How far the judge behind this project's evidence has been checked. Read
	 * from the labels on disk, so `/label` moves the header the moment it writes
	 * one. A project whose baskets have no judge grader keeps no line at all:
	 * an instrument nobody used graded nothing.
	 */
	const judgeState = (view: WorkbenchView): HeaderState["judge"] => {
		const stateRoot = workbench.stateRoot;
		const projectId = workbench.projectId;
		if (!stateRoot || !projectId) return undefined;
		// A basket that declares a judge grader, or a Target that has configured
		// one: either way an instrument is in play and its trust is a fact the
		// operator is entitled to see.
		const evaluators = view.target.evaluators;
		const judged = view.target.evaluatorRequirements?.judge === true || Boolean(evaluators?.judge);
		if (!judged) return undefined;
		// …but only once a judged basket has actually run. A template that
		// declares a judge has judged nothing yet, so "judge not calibrated" on a
		// newcomer's first screen is machinery noise about an instrument that has
		// not been used.
		if (view.counts.developmentEvals === 0) return undefined;
		try {
			const pooled = loadJudgeCalibration(stateRoot, projectId).pooled;
			return pooled.n === 0
				? null
				: { agreement: pooled.agreement, kappa: pooled.kappa, labels: pooled.n };
		} catch {
			// The header is a read; an unreadable label file is simply no line.
			return undefined;
		}
	};
	let tui: TUI | null = null;
	let host: ExtensionContext | null = null;
	/** First ordinary message survives the host-owned login/model picker. */
	let pendingFirstMessage: string | null = null;
	/** Declared tool keys already asked about; one question per name per session. */
	const askedToolKeys = new Set<string>();
	const now = options.now ?? (() => Date.now());
	const sessionStartedAt = now();

	/** Candidate stages are the only ones where a branch is worth a footer segment. */
	const BRANCH_STAGES = new Set<WorkbenchStage>([
		"candidate-verification",
		"candidate-review",
		"release-decision",
		"candidate-adoption",
	]);

	/**
	 * Elapsed, spend, and the candidate branch — each read behind its own
	 * try/catch, because a status segment must never be able to break a redraw.
	 */
	const statusFacts = (view: WorkbenchView): Parameters<typeof renderStatusBar>[0] => {
		const facts: Parameters<typeof renderStatusBar>[0] = { stage: view.stage };
		const spend = options.spend;
		if (!spend) return facts;
		try {
			const cycle = spend.cycle({
				targetId: view.target.id,
				candidateIds: view.selections.filter((item) => item.kind === "candidate").map((item) => item.id),
			});
			const startedAt = cycle?.firstAt ? Date.parse(cycle.firstAt) : Number.NaN;
			facts.elapsedMs = Number.isFinite(startedAt)
				? Math.max(0, now() - startedAt)
				: Math.max(0, now() - sessionStartedAt);
			if (cycle) facts.costUsd = cycle.costUsd + cycle.judgeCostUsd;
		} catch {
			// A cycle that cannot be summed simply contributes no segment.
		}
		if (!BRANCH_STAGES.has(view.stage)) return facts;
		try {
			const candidateId = view.focus.candidate ??
				view.selections.find((selection) => selection.kind === "candidate")?.id;
			if (candidateId) facts.branch = spend.branchOf(candidateId);
		} catch {
			// Same rule: no branch is better than a wrong one.
		}
		return facts;
	};

	const applyStatus = (): void => {
		if (!host) return;
		const view = state.view;
		try {
			host.ui.setStatus(
				"ahde",
				view ? renderStatusBar(statusFacts(view)) : state.error ? "AHDE · blocked" : "AHDE",
			);
			host.ui.setStatus("ahde-auth", state.builderModel.credentialPresent ? undefined : t("header.model-not-connected"));
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
			// The plan is a pure projection of the view we just read: no second
			// read, no artifact, nothing the model is told.
			state.plan = compilePlan(state.view);
			state.judge = judgeState(state.view);
		} catch (error) {
			state.view = null;
			state.plan = null;
			state.judge = undefined;
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
				ctx.ui.notify(t("onboarding.connect-first"), "warning");
				return;
			}
			const choice = await ctx.ui.select(
				t("onboarding.builder-needs-model"),
				[LOGIN_CHOICE(), MODEL_CHOICE(), LATER_CHOICE()],
			);
			if (choice === LOGIN_CHOICE()) {
				ctx.ui.setEditorText("/login");
				ctx.ui.notify(t("onboarding.login-hint"), "info");
			} else if (choice === MODEL_CHOICE()) {
				ctx.ui.setEditorText("/model");
				ctx.ui.notify(t("onboarding.model-hint"), "info");
			} else {
				ctx.ui.notify(t("onboarding.connect-anytime"), "info");
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
					// The one thing onboarding needs the filesystem for: whether this
					// folder already holds an agent worth adopting.
					...(workbench.projectDir ? { projectDir: workbench.projectDir } : {}),
				}, view);
				await refresh();
			}
			if (current && current.stage !== "target-setup") {
				ctx.ui.notify(t("onboarding.describe-now"), "info");
				return;
			}
			ctx.ui.notify(
				(current ?? view).target.status === "missing"
					? t("onboarding.no-agent-yet")
					: t("onboarding.agent-no-model"),
				"info",
			);
		} else {
			// A tool that declares a key nobody exported is the host's question, not
			// the model's, and it is asked once per name per session.
			const missing = (view.target.toolCredentials ?? [])
				.filter((entry) => !entry.present && !askedToolKeys.has(entry.environment));
			for (const entry of missing) askedToolKeys.add(entry.environment);
			if (missing.length > 0) await confirmDeclaredToolCredentials(ctx, missing);
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
		// Pi rebuilds the palette on every session start and drops extension
		// wrappers with it, so the ordering is asked for here, not once at load.
		try {
			ctx.ui.addAutocompleteProvider(ahdeCommandsFirst);
		} catch {
			// A host with no autocomplete surface simply has no palette to order.
		}
		ctx.ui.setTitle(t("header.title"));
		ctx.ui.setWorkingMessage(t("onboarding.working"));
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
			ctx.ui.notify(t("onboarding.state-unreadable", { error: state.error }), "error");
			return;
		}
		if (event.reason === "startup" || event.reason === "new" || event.reason === "resume") {
			await runOnboarding(ctx, state.view);
		}
	});

	// Free text remains the only required interface even before Builder Pi has a
	// model. Preserve the user's actual idea, route connection through the host's
	// private built-in picker, then replay the idea after model selection.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive" || event.text.trim().startsWith("/")) return undefined;
		state.builderModel = builderModelStatus(ctx);
		if (state.builderModel.credentialPresent) return undefined;
		if (typeof ctx.ui.select !== "function") {
			ctx.ui.notify(t("onboarding.connect-in-tui"), "warning");
			return { action: "handled" as const };
		}
		pendingFirstMessage = event.text;
		const choice = await ctx.ui.select(
			t("onboarding.connect-then-continue"),
			[LOGIN_CHOICE(), MODEL_CHOICE(), LATER_CHOICE()],
		);
		if (choice === LOGIN_CHOICE()) return { action: "transform" as const, text: "/login", images: event.images };
		if (choice === MODEL_CHOICE()) return { action: "transform" as const, text: "/model", images: event.images };
		pendingFirstMessage = null;
		ctx.ui.setEditorText(event.text);
		return { action: "handled" as const };
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
		if (state.view?.stage === "target-setup") await runOnboarding(ctx, state.view);
		if (pendingFirstMessage && typeof pi.sendUserMessage === "function") {
			const message = pendingFirstMessage;
			pendingFirstMessage = null;
			pi.sendUserMessage(message);
		}
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
