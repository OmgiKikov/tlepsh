import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	resolveTargetModelSelection,
	TargetModelSelectionSchema,
	type TargetModelSelection,
} from "../application/target-model-selection.js";
import { sameModelAsTarget } from "../application/configure-evaluators.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { plural, t } from "../i18n.js";
import { detectAgentFolder, type DetectedAgentFolder } from "../application/agent-folder-detect.js";
import type { TargetManifest } from "../manifest.js";
import type { ToolCredentialSlot } from "../application/tool-authoring.js";
import { HOST_OWNED_TOOL_ENVIRONMENT } from "../target/tool-manifest.js";
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
export function hostModelCatalog(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	options: { limit?: number } = {},
): HostModelCatalog {
	const limit = options.limit ?? MAX_CATALOG_ENTRIES;
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
		models: entries.slice(0, limit),
		omittedModels: Math.max(0, entries.length - limit),
	};
}

/**
 * Ids that read as judge-class, best first.
 *
 * A judge is an instrument: it reads a rubric, weighs prose against it, and
 * says why. The catalog is sorted by whether this machine can authenticate a
 * model, not by whether it can do that, so "the first credentialed entry" meant
 * "the first model in the alphabet" — in session 7, `aion-labs/aion-2.0` for
 * both the judge and the client, chosen by nobody, both paid for out of the
 * same run.
 *
 * The list is a preference, never a requirement: nothing here is refused, and a
 * catalog holding none of these still gets the first independent model rather
 * than no judge at all. Matched as a substring of the id, so
 * `anthropic/claude-opus` and `openrouter/anthropic/claude-opus` are the same
 * answer.
 */
const JUDGE_CLASS_IDS = ["glm", "claude", "gpt", "deepseek", "qwen3.5-72b", "qwen3.5-235b"] as const;

/**
 * The judge this machine would pick for a basket that needs one: the first
 * judge-class catalog entry it can authenticate whose model is not the
 * Target's own, and otherwise the first independent entry of any kind.
 *
 * The independence predicate is exactly the one `configure-evaluators`
 * enforces after the fact — a judge grading a copy of the model under test is
 * not a second opinion — applied before the question instead of after it, so
 * the operator reads one dialog with an answer already in it rather than two.
 */
export function defaultJudgeSelection(
	catalog: HostModelCatalog,
	target: { provider: string; id: string },
): TargetModelSelection | null {
	const independent = catalog.models.filter((model) =>
		model.credentialPresent &&
		!sameModelAsTarget(target, { provider: model.provider, id: model.modelId }));
	const entry = JUDGE_CLASS_IDS
		.map((marker) => independent.find((model) => model.modelId.toLowerCase().includes(marker)))
		.find((match) => match !== undefined) ?? independent[0];
	return entry
		? TargetModelSelectionSchema.parse({ provider: entry.provider, modelId: entry.modelId })
		: null;
}

/**
 * That selection, resolved: the endpoint and pricing from the trusted host
 * catalog, under a credential variable NAME the host chose and the operator
 * has already exported. Null when this machine cannot offer an independent
 * judge — the Workbench then says so and blocks, rather than guessing one.
 *
 * The exported-key condition is what keeps this silent: a name the operator
 * has not exported is a question, and a question belongs in the one dialog
 * `configure-evaluators` already asks, never ahead of it.
 */
export function hostDefaultJudge(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	target: { provider: string; id: string },
	env: NodeJS.ProcessEnv = process.env,
): { selection: TargetModelSelection; model: TargetManifest["model"] } | null {
	// The whole catalog, not the forty-entry correction aid: the judge-class
	// ids live past the alphabet's first page (session 8 picked claude-3-haiku
	// because glm sat beyond the cut).
	const selection = defaultJudgeSelection(hostModelCatalog(ctx, { limit: Number.POSITIVE_INFINITY }), target);
	if (!selection) return null;
	const apiKeyEnv = credentialPlaceholder(selection.provider);
	if (!env[apiKeyEnv]?.trim()) return null;
	const resolved = ctx.modelRegistry.find(selection.provider, selection.modelId);
	if (!resolved) return null;
	return { selection, model: resolveTargetModelSelection(selection, resolved, { apiKeyEnv }) };
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
 *
 * A host-owned name is refused rather than bound: the broker sets
 * `AHDE_TOOL_HOME` and `AHDE_WORLD` on the tool process itself, so binding a
 * slot to one would promise the operator a variable they neither own nor can
 * change, and would make a key that is always present look like a key they
 * forgot to export.
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
		if (HOST_OWNED_TOOL_ENVIRONMENT.has(name)) {
			throw new Error(`${name} is set by the host on every tool process; it cannot hold a tool credential`);
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
 *
 * A host-owned name is skipped outright. `toolCredentialReadiness` already
 * drops those, so nothing should reach here; the filter stays because being
 * sent to a terminal to export `AHDE_WORLD` is the exact failure this pair of
 * functions caused in session 7, and it must not come back through a second
 * caller.
 */
export async function confirmDeclaredToolCredentials(
	ctx: Pick<ExtensionContext, "ui">,
	missing: readonly { tool: string; environment: string }[],
): Promise<void> {
	if (typeof ctx.ui.input !== "function") return;
	const asked = new Set<string>();
	for (const entry of missing) {
		if (HOST_OWNED_TOOL_ENVIRONMENT.has(entry.environment)) continue;
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
	/**
	 * The project directory, so the first screen can ask whether to adopt the
	 * agent already in it. Omitted by hosts that have no filesystem view; the
	 * dialog then offers only "create a new one", exactly as it always did.
	 */
	projectDir?: string;
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
const ADOPT = (): string => t("onboarding.wrap.accept");
const CREATE_NEW = (): string => t("onboarding.wrap.create-new");
const OTHER_COMMAND = (): string => t("onboarding.wrap.command-edit");
const OTHER_FILES = (): string => t("onboarding.wrap.files-edit");

/**
 * The command that will start the agent, in the operator's words.
 *
 * The default is a guess from the entry point; the operator either takes it or
 * types the real one. `argv[0]` stays absolute-or-bare because the manifest is
 * not a shell: a relative argv[0] means something different per cwd, and the
 * spawn refuses it later anyway.
 */
function defaultCommand(entry: string): string[] {
	return ["python3", entry];
}

/**
 * The editable surface, guessed the way an operator would guess it: the prompts
 * directory if there is one, otherwise the markdown beside the entry point.
 * Wrong is fine here — it is a default in an editable field, and the manifest
 * it writes is one line to change.
 */
function defaultHarnessFiles(projectDir: string, entry: string): string[] {
	if (existsSync(join(projectDir, "prompts"))) return ["prompts/**"];
	const directory = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/")) : "";
	// A declared harness path is relative and rooted: a bare `*.md` is not a
	// legal one, so a root-level agent falls back to the instructions file the
	// manifest already names.
	return [directory ? `${directory}/*.md` : "AGENTS.md"];
}

/** Split an operator-typed command into argv. Quotes are not a manifest feature. */
function parseCommand(text: string): string[] {
	return text.trim().split(/\s+/).filter(Boolean);
}

function parseFiles(text: string): string[] {
	return text.split(",").map((part) => part.trim()).filter(Boolean);
}

/**
 * The three questions an adoption is worth: is this your agent, how is it
 * started, and what may I edit. Everything else — the manifest, the eval
 * skeleton, the Git commit — the host decides, shows in the dialog, and writes.
 */
type WrapOutcome = WorkbenchView | "deferred" | "create-new";

async function wrapTarget(
	ctx: ExtensionContext,
	host: OnboardingHost,
	projectDir: string,
	found: DetectedAgentFolder,
): Promise<WrapOutcome> {
	// The first sentence a new operator reads. It counts what the adoption will
	// declare — the descriptors on disk — and names the knowledge base, because
	// half of what such an agent knows lives in `data/kb` and a sentence that
	// leaves it out understates the agent to the person who wrote it.
	const choice = await ctx.ui.select(
		t(found.knowledgeBase ? "onboarding.wrap.seen-kb" : "onboarding.wrap.seen", {
			entry: found.entry,
			tools: plural(found.toolCount, "tool"),
		}),
		[ADOPT(), CREATE_NEW(), LATER()],
	);
	if (choice === LATER() || choice === undefined) return "deferred";
	if (choice !== ADOPT()) return "create-new";

	const suggestedCommand = defaultCommand(found.entry);
	const commandChoice = await ctx.ui.select(
		t("onboarding.wrap.command", { command: suggestedCommand.join(" ") }),
		[t("onboarding.wrap.accept"), OTHER_COMMAND(), LATER()],
	);
	if (commandChoice === LATER() || commandChoice === undefined) return "deferred";
	let argv = suggestedCommand;
	if (commandChoice === OTHER_COMMAND()) {
		const typed = await ctx.ui.input(t("onboarding.wrap.command-ask"), suggestedCommand.join(" "));
		if (typed === undefined) return "deferred";
		argv = parseCommand(typed);
		if (argv.length === 0) argv = suggestedCommand;
	}

	const suggestedFiles = defaultHarnessFiles(projectDir, found.entry);
	const filesChoice = await ctx.ui.select(
		t("onboarding.wrap.files"),
		[suggestedFiles.join(", "), OTHER_FILES(), LATER()],
	);
	if (filesChoice === LATER() || filesChoice === undefined) return "deferred";
	let harnessFiles = suggestedFiles;
	if (filesChoice === OTHER_FILES()) {
		const typed = await ctx.ui.input(t("onboarding.wrap.files-ask"), suggestedFiles.join(", "));
		if (typed === undefined) return "deferred";
		harnessFiles = parseFiles(typed);
		if (harnessFiles.length === 0) harnessFiles = suggestedFiles;
	}

	const result = await host.workbench.decide(
		{ kind: "wrap-target", argv, harnessFiles, reason: t("onboarding.wrap.reason") },
		answeredGate(host.actorId),
	);
	host.presenter.show(ctx, { title: t("panel.agent-wrapped"), tone: "success", lines: renderDecision(result, markerPaint) });
	return result.view;
}

/** How the Target came to exist, so the lines after it can say the right thing. */
type CreatedTarget = { view: WorkbenchView; adopted: boolean };

async function createTarget(ctx: ExtensionContext, host: OnboardingHost, view: WorkbenchView): Promise<CreatedTarget | null> {
	// A folder that already holds an agent gets the better offer first. The
	// operator can still say "create a new one", which falls through to exactly
	// the dialog that existed before adoption did.
	const found = host.projectDir ? detectAgentFolder(host.projectDir) : null;
	if (found && host.projectDir) {
		const wrapped = await wrapTarget(ctx, host, host.projectDir, found);
		if (wrapped === "deferred") return null;
		if (wrapped !== "create-new") return { view: wrapped, adopted: true };
	}
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
	return { view: result.view, adopted: false };
}

/**
 * A model id the operator typed, resolved against the trusted host catalog.
 *
 * The selector shows nine rows of a catalog that holds hundreds, alphabetically,
 * with no filter and no scroll — Pi's `ui.select` has neither — so in session 7
 * `qwen/qwen3.5-9b` was unreachable and the operator had to leave the dialog and
 * dictate the name to the Builder, which cost a turn and a second question about
 * the id. Typing it is now an answer the host itself resolves.
 *
 * Two readings of one string, in order: `openrouter/qwen/qwen3.5-9b` is a
 * provider and an id, and `qwen/qwen3.5-9b` is one id under a provider this
 * machine already has. Null means the catalog does not hold it; the host says so
 * and nothing is written.
 */
export function resolveTypedModel(
	ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
	typed: string,
): TargetModelSelection | null {
	const text = typed.trim().replace(/^\/+|\/+$/g, "").trim();
	if (!text) return null;
	const candidates: { provider: string; modelId: string }[] = [];
	const slash = text.indexOf("/");
	if (slash > 0) candidates.push({ provider: text.slice(0, slash), modelId: text.slice(slash + 1) });
	const providers = [ctx.model?.provider, ...hostModelCatalog(ctx).models.map((entry) => entry.provider)];
	for (const provider of providers) {
		if (provider) candidates.push({ provider, modelId: text });
	}
	for (const candidate of candidates) {
		if (!candidate.provider || !candidate.modelId) continue;
		let resolved;
		try {
			resolved = ctx.modelRegistry.find(candidate.provider, candidate.modelId);
		} catch {
			resolved = undefined;
		}
		if (resolved) {
			const parsed = TargetModelSelectionSchema.safeParse(candidate);
			if (parsed.success) return parsed.data;
		}
	}
	return null;
}

async function chooseModel(ctx: ExtensionContext, host: OnboardingHost, view: WorkbenchView): Promise<WorkbenchView | null> {
	const choices = modelChoices(ctx);
	if (choices.length === 0) return null;
	const selected = await ctx.ui.select(
		t("onboarding.which-model"),
		[...choices.map((choice) => choice.label), OTHER_MODEL()],
	);
	const choice = choices.find((item) => item.label === selected);
	let selection: TargetModelSelection | null = choice ? TargetModelSelectionSchema.parse(choice.selection) : null;
	if (!choice && selected === OTHER_MODEL()) {
		const typed = await ctx.ui.input(t("onboarding.model-id-ask"));
		if (typed === undefined) return null;
		selection = resolveTypedModel(ctx, typed);
		if (!selection) {
			ctx.ui.notify(t("onboarding.model-unknown", { model: oneLine(typed.trim(), 80) }), "warning");
			return null;
		}
	}
	if (!selection) return null;
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
 * Whether the Target's own cases already call an evaluator this Target has not
 * got. True for `templates/python-agent` straight after the model is chosen —
 * one case is judged by prose and two are conversations — and false for a
 * template whose cases need neither, which must not be told about a question it
 * will never be asked.
 */
export function evaluatorsStillUnchosen(view: WorkbenchView): boolean {
	const required = view.target.evaluatorRequirements;
	const configured = view.target.evaluators;
	if (!required || !configured) return false;
	return (["judge", "simulatedUser"] as const).some((role) => required[role] && configured[role] === null);
}

/**
 * The same question for a folder that was just adopted.
 *
 * An adopted agent's dataset is the one-line placeholder the adoption wrote,
 * so `evaluatorRequirements` reads false for both roles and
 * {@link evaluatorsStillUnchosen} says nothing — which is why session 7 never
 * saw «Судью и собеседника выберем в вопросе перед первым прогоном» at all.
 * The requirement is not knowable yet: the cases that will need a judge are
 * the ones the Builder is about to write. What IS knowable is that neither
 * role is configured, and that is the whole content of the line.
 */
export function evaluatorsNotConfigured(view: WorkbenchView): boolean {
	const configured = view.target.evaluators;
	if (!configured) return false;
	return (["judge", "simulatedUser"] as const).some((role) => configured[role] === null);
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
	let adopted = false;
	try {
		if (view.stage === "target-setup" && view.target.status === "missing") {
			const created = await createTarget(ctx, host, view);
			if (!created) return null;
			view = created.view;
			adopted = created.adopted;
		}
		if (view.stage === "target-setup" && view.target.status === "bootstrap-required") {
			view = await chooseModel(ctx, host, view);
			if (!view) return null;
			// A template ships its judge and simulated-user blocks on the same
			// built-in placeholder the model block carries, and the operator has
			// just replaced one of the three. Saying who picks the other two — and
			// when — is one line; asking for them here would be two more dialogs
			// before the agent has been described, and the answer would be a guess
			// about cases nobody has written yet.
			//
			// An adopted folder gets the line on the weaker condition, because the
			// stronger one cannot be true yet: its dataset is the placeholder the
			// adoption wrote, so nothing declares that it needs a judge until the
			// Builder writes the cases that do.
			const say = adopted ? evaluatorsNotConfigured(view) : evaluatorsStillUnchosen(view);
			if (say) ctx.ui.notify(t("onboarding.evaluators-later"), "info");
		}
		return view;
	} catch (error) {
		if (error instanceof WorkbenchDecisionDeclinedError) return null;
		ctx.ui.notify(`${calmSetupFailure(error)} ${t("onboarding.setup-fallback")}`, "warning");
		return null;
	}
}
