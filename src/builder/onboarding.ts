import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	resolveTargetModelSelection,
	TargetModelSelectionSchema,
	type TargetModelSelection,
} from "../application/target-model-selection.js";
import type { TargetManifest } from "../manifest.js";
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
	if (catalog.models.length === 0) return "the host catalog is empty; the operator must run /login first";
	const listed = catalog.models
		.map((entry) => `${entry.provider}/${entry.modelId}${entry.credentialPresent ? "" : " (no credential)"}`)
		.join(", ");
	return catalog.omittedModels > 0 ? `${listed}, and ${catalog.omittedModels} more` : listed;
}

/** Ask only for the variable name; the credential value never enters Builder Pi. */
export async function selectTargetCredentialEnvironment(
	ctx: Pick<ExtensionContext, "ui">,
	selection: TargetModelSelection,
): Promise<string> {
	const suggested = credentialPlaceholder(selection.provider);
	if (process.env[suggested]?.trim()) return suggested;
	const selected = await ctx.ui.input(
		`Environment variable holding the ${selection.provider} key for the agent`,
		suggested,
	);
	if (selected === undefined) throw new Error("Target model configuration was cancelled by the operator");
	const value = selected.trim() || suggested;
	if (!/^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(value)) {
		throw new Error("Target credential must be one environment-variable name; never paste the credential value");
	}
	return value;
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
	if (ctx.model) push(ctx.model.provider, ctx.model.id, " (same as the Builder)");
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
		return `This folder is not empty (it already has ${oneLine(found[1] ?? "files", 40)}), so I cannot create the agent inside it. Open an empty folder and run \`ahde\` there, or scaffold one with \`ahde init <dir>\`.`;
	}
	if (/directory does not exist|must be a regular non-symlink directory/i.test(message)) {
		return "This folder cannot hold an agent (it is missing or is not a regular directory). Run `ahde` from a normal, empty project folder.";
	}
	if (/not available in the trusted host catalog/i.test(message)) {
		return oneLine(message, 300);
	}
	if (/cancelled by the operator/i.test(message)) {
		return "Setup stopped. Tell me when you want to pick the agent's model.";
	}
	return `Setup did not finish: ${oneLine(message, 200)}`;
}

const CREATE_HERE = "Create the agent here";
const LATER = "Not now";
const OTHER_MODEL = "Another model — I will tell the Builder";

async function createTarget(ctx: ExtensionContext, host: OnboardingHost, view: WorkbenchView): Promise<WorkbenchView | null> {
	const choice = await ctx.ui.select(
		`This folder (${oneLine(view.project.directory, 60)}) has no agent yet`,
		[CREATE_HERE, LATER],
	);
	if (choice !== CREATE_HERE) return null;
	const result = await host.workbench.decide(
		{ kind: "scaffold-target", reason: "First run: create the agent in the current directory" },
		answeredGate(host.actorId),
	);
	host.presenter.show(ctx, { title: "Agent created", tone: "success", lines: renderDecision(result, markerPaint) });
	return result.view;
}

async function chooseModel(ctx: ExtensionContext, host: OnboardingHost, view: WorkbenchView): Promise<WorkbenchView | null> {
	const choices = modelChoices(ctx);
	if (choices.length === 0) return null;
	const selected = await ctx.ui.select(
		"Which model should the agent itself use?",
		[...choices.map((choice) => choice.label), OTHER_MODEL],
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
	host.presenter.show(ctx, { title: "Agent configured", tone: "success", lines: renderDecision(result, markerPaint) });
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
		ctx.ui.notify(`${calmSetupFailure(error)} You can also just tell me what you want to build.`, "warning");
		return null;
	}
}
