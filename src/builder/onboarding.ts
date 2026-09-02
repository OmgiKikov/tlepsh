import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	resolveTargetModelSelection,
	TargetModelSelectionSchema,
	type TargetModelSelection,
} from "../application/target-model-selection.js";
import { t } from "../i18n.js";
import type { TargetManifest } from "../manifest.js";
import type { ToolCredentialSlot } from "../application/tool-authoring.js";
import type { AhdeWorkbench } from "../workbench/workbench.js";
import type { WorkbenchHumanGate, WorkbenchView } from "../workbench/types.js";
import { WorkbenchDecisionDeclinedError } from "../workbench/errors.js";
import { renderDecision } from "./render/decision.js";
import { oneLine } from "./render/format.js";
import { markerPaint, type TranscriptPresenter } from "./transcript.js";

/**
 * First-run onboarding: the two answers a new user must give before the
 * conversation can start (create the agent here? which model?) are asked as
 * plain selectors by the host. The answers are the confirmations; the
 * Workbench still records the same bootstrap receipts and commits.
 */

const KNOWN_CREDENTIAL_ENVIRONMENT: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	google: "GEMINI_API_KEY",
	openai: "OPENAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
};

const MAX_MODEL_CHOICES = 9;
/** The catalog is a correction aid, not a directory: enough to choose, small enough to read. */
const MAX_CATALOG_ENTRIES = 40;

export function credentialPlaceholder(provider: string): string {
	return KNOWN_CREDENTIAL_ENVIRONMENT[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/** One host catalog entry: identity plus whether this machine can authenticate it. Never a credential value. */
export interface HostModelCatalogEntry {
	provider: string;
	modelId: string;
	credentialPresent: boolean;
}

export interface HostModelCatalog {
	models: HostModelCatalogEntry[];
	/** Entries beyond the bounded listing; the omitted ones are always uncredentialed. */
	omittedModels: number;
}

type HostModel = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];

function credentialPresent(ctx: Pick<ExtensionContext, "modelRegistry">, model: HostModel): boolean {
	try {
		return ctx.modelRegistry.hasConfiguredAuth(model);
	} catch {
		return false;
	}
}

/**
 * The trusted host catalog `configure-target` resolves against, in the order a
 * chooser wants it: models this machine can actually authenticate first. Builder
 * Pi has no other way to learn which ids exist, so it otherwise guesses.
 */
export function hostModelCatalog(ctx: Pick<ExtensionContext, "modelRegistry">): HostModelCatalog {
	let available: HostModel[] = [];
	try {
		available = ctx.modelRegistry.getAvailable();
	} catch {
		available = [];
	}
	const entries: HostModelCatalogEntry[] = [];
	const seen = new Set<string>();
	for (const model of available) {
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push({ provider: model.provider, modelId: model.id, credentialPresent: credentialPresent(ctx, model) });
	}
	// Stable sort keeps the host's own ordering inside each group.
	entries.sort((left, right) => Number(right.credentialPresent) - Number(left.credentialPresent));
	return {
		models: entries.slice(0, MAX_CATALOG_ENTRIES),
		omittedModels: Math.max(0, entries.length - MAX_CATALOG_ENTRIES),
	};
}

/** One line the model can copy a `{ provider, modelId }` out of. */
export function describeHostModelCatalog(catalog: HostModelCatalog): string {
	if (catalog.models.length === 0) return "the host catalog is empty; the operator must use the private model connection picker first";
	const listed = catalog.models
		.map((entry) => `${entry.provider}/${entry.modelId}${entry.credentialPresent ? "" : " (no credential)"}`)
		.join(", ");
	return catalog.omittedModels > 0 ? `${listed}, and ${catalog.omittedModels} more` : listed;
}

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,199}$/;

/** Ask only for the variable name; the credential value never enters Builder Pi. */
export async function selectTargetCredentialEnvironment(
	ctx: Pick<ExtensionContext, "ui">,
	selection: TargetModelSelection,
	/** What the key is for, in the operator's words. */
	subject = t("onboarding.subject-agent"),
): Promise<string> {
	const suggested = credentialPlaceholder(selection.provider);
	if (process.env[suggested]?.trim()) return suggested;
	const selected = await ctx.ui.input(
		t("onboarding.credential-env", { provider: selection.provider, subject }),
		suggested,
	);
	if (selected === undefined) throw new Error("Target model configuration was cancelled by the operator");
	const value = selected.trim() || suggested;
	if (!ENVIRONMENT_NAME.test(value)) {
		throw new Error("Target credential must be one environment-variable name; never paste the credential value");
	}
	return value;
}

/**
 * The evaluator half of the same question, asked once per role. The name comes
 * from the host UI and nowhere else: a model that could choose the variable
 * could point the judge at a key the operator never meant to spend.
 */
export async function selectEvaluatorCredentialEnvironment(
	ctx: Pick<ExtensionContext, "ui">,
	role: "judge" | "simulatedUser",
	selection: TargetModelSelection,
): Promise<string> {
	return await selectTargetCredentialEnvironment(
		ctx,
		selection,
		role === "judge" ? t("onboarding.subject-judge") : t("onboarding.subject-user"),
	);
}

/**
 * Resolve logical tool credential slots in host UI. Builder Pi supplies only
 * purpose (`api_token`); the concrete environment name never appears in chat.
 */
export async function selectToolCredentialEnvironments(
	ctx: Pick<ExtensionContext, "ui">,
	tool: string,
	slots: readonly ToolCredentialSlot[],
): Promise<Record<string, string>> {
	const bindings: Record<string, string> = {};
	for (const slot of slots) {
		const suggested = `AHDE_${tool}_${slot.id}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
		const selected = await ctx.ui.input(
			t("onboarding.tool-credential-env", { purpose: slot.purpose, tool }),
			suggested,
		);
		if (selected === undefined) throw new Error(`Tool credential setup for ${slot.id} was cancelled by the operator`);
		const name = selected.trim() || suggested;
		if (!ENVIRONMENT_NAME.test(name)) {
			throw new Error("Tool credential binding must be one environment-variable name; never paste the credential value");
		}
		bindings[slot.id] = name;
	}
	return bindings;
}

/**
 * A tool already in the harness declares a key that nobody exported.
 *
 * The host asks about it, not the model, and it asks the same question
 * onboarding asks for a model key: which environment variable holds this — and
 * never what it holds. Nothing is recorded: the answer is either the name the
 * descriptor already declares, in which case the operator is told to export it,
 * or a different name, in which case the descriptor is what has to change and
 * saying so is the whole answer.
 */
export async function confirmDeclaredToolCredentials(
	ctx: Pick<ExtensionContext, "ui">,
	missing: readonly { tool: string; environment: string }[],
): Promise<void> {
	if (typeof ctx.ui.input !== "function") return;
	const asked = new Set<string>();
	for (const entry of missing) {
		if (asked.has(entry.environment)) continue;
		asked.add(entry.environment);
		const answered = await ctx.ui.input(
			t("onboarding.tool-credential-env", { purpose: t("onboarding.subject-tool-key"), tool: entry.tool }),
			entry.environment,
		);
		if (answered === undefined) return;
		const name = answered.trim() || entry.environment;
		if (!ENVIRONMENT_NAME.test(name)) {
			ctx.ui.notify(t("onboarding.tool-credential-name-only"), "warning");
			continue;
		}
		ctx.ui.notify(
			name === entry.environment
				? t("onboarding.tool-credential-export", { environment: name })
				: t("onboarding.tool-credential-rename", { tool: entry.tool, declared: entry.environment, chosen: name }),
			"info",
		);
	}
}

/** Resolve one bounded evaluator selection against the trusted host catalog. */
export function evaluatorModelResolver(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	credentialEnvironment: Record<"judge" | "simulatedUser", string | undefined>,
): (role: "judge" | "simulatedUser", selection: TargetModelSelection) => TargetManifest["model"] {
	return (role, selection) => {
		const apiKeyEnv = credentialEnvironment[role];
		if (!apiKeyEnv) throw new Error(`the host did not name a credential variable for the ${role}`);
		return targetModelResolver(ctx, apiKeyEnv)(selection);
	};
}

/** Resolve one bounded selection against the trusted host catalog. */
export function targetModelResolver(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	apiKeyEnv: string,
): (selection: TargetModelSelection) => TargetManifest["model"] {
	return (selection) => {
		const resolved = ctx.modelRegistry.find(selection.provider, selection.modelId);
		if (!resolved) {
			throw new Error(
				`Target model ${selection.provider}/${selection.modelId} is not available in the trusted host catalog. ` +
				`Choose one of: ${describeHostModelCatalog(hostModelCatalog(ctx))}.`,
			);
		}
		return resolveTargetModelSelection(selection, resolved, { apiKeyEnv });
	};
}

/** Directory name → Target id; falls back to a neutral id when the name cannot be an id. */
export function targetIdFromDirectory(directory: string): string {
	const slug = directory
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 100);
	if (!slug || slug === "my-agent" || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) return "agent";
	return slug;
}

export interface OnboardingHost {
	workbench: Pick<AhdeWorkbench, "view" | "decide">;
	actorId: () => string;
	presenter: TranscriptPresenter;
}

/** The selector already asked the human; the gate must not ask a second time. */
function answeredGate(actorId: () => string): WorkbenchHumanGate {
	return {
		confirm: async () => ({ approved: true, actorId: actorId() }),
		selectSealed: async () => ({ approved: false }),
	};
}

type ModelChoice = { label: string; selection: TargetModelSelection };

function modelChoices(ctx: Pick<ExtensionContext, "model" | "modelRegistry">): ModelChoice[] {
	const choices: ModelChoice[] = [];
	const seen = new Set<string>();
	const push = (provider: string, id: string, suffix: string): void => {
		const key = `${provider}/${id}`;
		if (seen.has(key)) return;
		seen.add(key);
		choices.push({ label: `${key}${suffix}`, selection: { provider, modelId: id } });
	};
	if (ctx.model) push(ctx.model.provider, ctx.model.id, t("onboarding.same-as-builder"));
	for (const model of hostModelCatalog(ctx).models) {
		if (choices.length >= MAX_MODEL_CHOICES) break;
		if (!model.credentialPresent) continue;
		push(model.provider, model.modelId, "");
	}
	return choices;
}

/**
 * Setup failures are host-internal sentences; the operator gets the one fact
 * that matters and a way forward instead of the raw message.
 */
export function calmSetupFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const found = /otherwise empty current directory; found (.+)$/.exec(message);
	if (found) {
		return t("onboarding.folder-not-empty", { found: oneLine(found[1] ?? "…", 40) });
	}
	if (/directory does not exist|must be a regular non-symlink directory/i.test(message)) {
		return t("onboarding.folder-unusable");
	}
	if (/not available in the trusted host catalog/i.test(message)) {
		return oneLine(message, 300);
	}
	if (/environment-variable name/i.test(message)) {
		return t("onboarding.credential-name-only");
	}
	if (/cancelled by the operator/i.test(message)) {
		return t("onboarding.setup-stopped");
	}
	return t("onboarding.setup-failed", { reason: oneLine(message, 200) });
}

const CREATE_HERE = (): string => t("onboarding.create-here");
const LATER = (): string => t("onboarding.later-choice");
const OTHER_MODEL = (): string => t("onboarding.other-model");

async function createTarget(ctx: ExtensionContext, host: OnboardingHost, view: WorkbenchView): Promise<WorkbenchView | null> {
	const choice = await ctx.ui.select(
		t("onboarding.no-agent-here", { directory: oneLine(view.project.directory, 60) }),
		[CREATE_HERE(), LATER()],
	);
	if (choice !== CREATE_HERE()) return null;
	const result = await host.workbench.decide(
		{ kind: "scaffold-target", reason: "First run: create the agent in the current directory" },
		answeredGate(host.actorId),
	);
	host.presenter.show(ctx, { title: t("panel.agent-created"), tone: "success", lines: renderDecision(result, markerPaint) });
	return result.view;
}

async function chooseModel(ctx: ExtensionContext, host: OnboardingHost, view: WorkbenchView): Promise<WorkbenchView | null> {
	const choices = modelChoices(ctx);
	if (choices.length === 0) return null;
	const selected = await ctx.ui.select(
		t("onboarding.which-model"),
		[...choices.map((choice) => choice.label), OTHER_MODEL()],
	);
	const choice = choices.find((item) => item.label === selected);
	if (!choice) return null;
	const selection = TargetModelSelectionSchema.parse(choice.selection);
	const apiKeyEnv = await selectTargetCredentialEnvironment(ctx, selection);
	const result = await host.workbench.decide(
		{
			kind: "configure-target",
			targetId: targetIdFromDirectory(view.project.directory),
			model: selection,
			reason: "First run: model chosen by the operator",
		},
		answeredGate(host.actorId),
		{ resolveTargetModel: targetModelResolver(ctx, apiKeyEnv) },
	);
	host.presenter.show(ctx, { title: t("panel.agent-configured"), tone: "success", lines: renderDecision(result, markerPaint) });
	return result.view;
}

/**
 * Walk a brand-new project to the point where describing the agent is the
 * only thing left. Returns the latest view, or null when the operator deferred.
 * Any cancellation leaves durable state untouched.
 */
export async function runFirstRunOnboarding(
	ctx: ExtensionContext,
	host: OnboardingHost,
	initialView: WorkbenchView,
): Promise<WorkbenchView | null> {
	if (typeof ctx.ui.select !== "function") return null;
	let view: WorkbenchView | null = initialView;
	try {
		if (view.stage === "target-setup" && view.target.status === "missing") {
			view = await createTarget(ctx, host, view);
			if (!view) return null;
		}
		if (view.stage === "target-setup" && view.target.status === "bootstrap-required") {
			view = await chooseModel(ctx, host, view);
			if (!view) return null;
		}
		return view;
	} catch (error) {
		if (error instanceof WorkbenchDecisionDeclinedError) return null;
		ctx.ui.notify(`${calmSetupFailure(error)} ${t("onboarding.setup-fallback")}`, "warning");
		return null;
	}
}
