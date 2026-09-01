import { userInfo } from "node:os";
import type { ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { oneLine } from "./render/format.js";
import { themePaint } from "./render/paint.js";
import { createPolicyAwareGate, projectForModel } from "./workbench-adapter.js";
import {
	WorkshopAuthorToolSchema,
	WorkshopBashToolSchema,
	WorkshopReadToolSchema,
	WorkshopTryToolSchema,
	WorkshopWriteToolSchema,
} from "./workbench-transport.js";
import type { AhdeWorkbench } from "../workbench/workbench.js";
import { BUILDER_WORKSHOP_SCOPE } from "../application/tool-workshop.js";
import { selectToolCredentialEnvironments } from "./onboarding.js";

type RegisteredWorkshopTool = ToolDefinition<TSchema, unknown>;

/**
 * The Builder's hands. They exist only while a workshop is open, they point
 * only at that workshop's private worktree, and every one of them refuses a
 * path outside the declared Harness scope by naming it.
 */
export const AHDE_WORKSHOP_TOOL_NAMES = [
	"ahde_workshop_read",
	"ahde_workshop_write",
	"ahde_workshop_bash",
	"ahde_workshop_author_tool",
	"ahde_workshop_try",
] as const;

const SCOPE = BUILDER_WORKSHOP_SCOPE.join(", ");

function card(lines: readonly string[]): Component {
	return new Text(lines.join("\n"), 0, 0);
}

function abortIfRequested(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("operation aborted");
}

/**
 * The human renderers keep the whole result; the model gets the same object
 * without the digests it must never quote back — the same rule the three
 * Workbench tools follow.
 */
function textResult(details: unknown): { content: { type: "text"; text: string }[]; details: unknown } {
	return { content: [{ type: "text", text: JSON.stringify(projectForModel(details), null, 2) }], details };
}

function head(text: string | null, lines: number): string[] {
	if (!text) return [];
	const split = text.split("\n");
	const shown = split.slice(0, lines).map((line) => oneLine(line, 160));
	if (split.length > lines) shown.push(`… +${split.length - lines} more lines`);
	return shown;
}

/**
 * A workshop is one mutable surface. Two tool calls from the same assistant
 * message must never interleave over it: a `write` racing a `close` would
 * compile a diff nobody wrote, and a `bash` racing a `try` would report on
 * bytes it did not run. Pi's per-tool flag is the whole fix.
 */
const SEQUENTIAL = "sequential" as const;

export interface WorkshopToolOptions {
	/** Host-owned identity for the one-question grant; never model-supplied. */
	actorId?: () => string;
}

export function createWorkshopTools(
	workbench: AhdeWorkbench,
	options: WorkshopToolOptions = {},
): readonly RegisteredWorkshopTool[] {
	const actorId = options.actorId ?? (() => `local:${userInfo().username || "operator"}`);
	/** The host's own gate, so a try that wants more can ask exactly one question. */
	const gateFor = (ctx: ExtensionContext) =>
		createPolicyAwareGate(ctx, actorId, (operation) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				throw new Error(`${operation} requires a local TUI host confirmation; RPC, print, and JSON execution fail closed`);
			}
		});
	return [
		defineTool({
			name: "ahde_workshop_read",
			executionMode: SEQUENTIAL,
			label: "Read in the workshop",
			description: [
				"Read one file, or list one directory, inside the open workshop.",
				`Arguments: { path: string } — relative to the Harness root, inside ${SCOPE}.`,
				"A file returns its exact complete text, mode, byte count and hash; a directory returns its bounded entry list.",
				"Anything else — manifest.yaml, evals/**, imports/**, .git, .env, .ahde, a symlink, a `..` traversal — is refused by name.",
				"Read what you are about to change before you change it.",
			].join(" "),
			parameters: WorkshopReadToolSchema.parameters,
			prepareArguments: (args) => WorkshopReadToolSchema.prepare(args),
			execute(_id, params, signal) {
				abortIfRequested(signal);
				return Promise.resolve(textResult(workbench.workshopRead(params)));
			},
			renderCall: (args: { path?: string }, theme: Theme) => {
				const paint = themePaint(theme);
				return card([`${paint.accent("workshop")} ${paint.dim("read")} ${oneLine(args.path ?? "", 80)}`]);
			},
			renderResult: (result, renderOptions, theme) => {
				const paint = themePaint(theme);
				const details = result.details as {
					path?: string;
					kind?: string;
					bytes?: number | null;
					content?: string | null;
					entries?: { path: string }[] | null;
				} | undefined;
				if (!details) return card([paint.muted("workshop read")]);
				const headline = details.kind === "directory"
					? `${paint.bold(details.path ?? "")} ${paint.dim(`· ${details.entries?.length ?? 0} entries`)}`
					: `${paint.bold(details.path ?? "")} ${paint.dim(`· ${details.bytes ?? 0} bytes`)}`;
				if (!renderOptions.expanded) return card([headline]);
				return card([
					headline,
					...(details.entries ?? []).map((entry) => `  ${paint.dim(entry.path)}`),
					...head(details.content ?? null, 40).map((line) => `  ${line}`),
				]);
			},
		}),
		defineTool({
			name: "ahde_workshop_write",
			executionMode: SEQUENTIAL,
			label: "Write in the workshop",
			description: [
				"Write one file inside the open workshop. This is the only writable surface you ever get.",
				"Exactly one form per call:",
				"• { path, content, mode? } — the whole file;",
				"• { path, oldText, newText } — one exact replacement; oldText must occur exactly once;",
				"• { path, remove: true } — delete the file.",
				`path is relative to the Harness root and must be inside ${SCOPE}; every other path is refused by name.`,
				"manifest.yaml is host-owned: declare a skill, tool, or data directory by writing its files and the host keeps the declarations exact.",
				"Nothing here touches the operator's checkout, and nothing is applied until they approve the diff.",
			].join(" "),
			parameters: WorkshopWriteToolSchema.parameters,
			prepareArguments: (args) => WorkshopWriteToolSchema.prepare(args),
			execute(_id, params, signal) {
				abortIfRequested(signal);
				return Promise.resolve(textResult(workbench.workshopWrite(params)));
			},
			renderCall: (args: { path?: string; remove?: boolean; oldText?: string }, theme: Theme) => {
				const paint = themePaint(theme);
				const verb = args.remove ? "remove" : args.oldText !== undefined ? "replace in" : "write";
				return card([`${paint.accent("workshop")} ${paint.dim(verb)} ${oneLine(args.path ?? "", 80)}`]);
			},
			renderResult: (result, _renderOptions, theme) => {
				const paint = themePaint(theme);
				const details = result.details as { path?: string; action?: string; bytes?: number | null } | undefined;
				if (!details) return card([paint.muted("workshop write")]);
				return card([
					`${paint.success("✓")} ${details.action ?? "wrote"} ${paint.bold(details.path ?? "")}` +
						`${details.bytes === null || details.bytes === undefined ? "" : paint.dim(` · ${details.bytes} bytes`)}`,
				]);
			},
		}),
		defineTool({
			name: "ahde_workshop_bash",
			executionMode: SEQUENTIAL,
			label: "Run a command in the workshop",
			description: [
				"Run one command inside the open workshop, in an OS sandbox with the authoring profile.",
				"Arguments: { argv: string[], cwd?: string, timeoutMs?: number }.",
				"argv is executed directly — there is no shell and no interpolation; argv[0] is a bare PATH command or an absolute path.",
				`Your command sees exactly ${SCOPE} plus the host-rendered manifest.yaml, materialised into a private directory:`,
				"evals/**, imports/**, runs/, .git, .env and .ahde are not there at all, and neither is any Target credential.",
				"There is no network, whatever the Target's execution policy says, and CPU, file size, open files and process count are capped.",
				"Output is bounded and redacted; a non-zero exit comes back as data so you can read the failure and fix it.",
				"Git is not available here — the diff is computed host-side when you close the workshop.",
			].join(" "),
			parameters: WorkshopBashToolSchema.parameters,
			prepareArguments: (args) => WorkshopBashToolSchema.prepare(args),
			async execute(_id, params, signal) {
				abortIfRequested(signal);
				return textResult(await workbench.workshopBash(params, signal ? { signal } : {}));
			},
			renderCall: (args: { argv?: string[] }, theme: Theme) => {
				const paint = themePaint(theme);
				return card([`${paint.accent("workshop")} ${paint.dim("run")} ${oneLine((args.argv ?? []).join(" "), 100)}`]);
			},
			renderResult: (result, renderOptions, theme) => {
				const paint = themePaint(theme);
				const details = result.details as {
					argv?: string[];
					exitCode?: number | null;
					durationMs?: number;
					sandbox?: string;
					stdout?: string;
					stderr?: string;
				} | undefined;
				if (!details) return card([paint.muted("workshop command")]);
				const ok = details.exitCode === 0;
				const headline = `${ok ? paint.success("✓") : paint.error("✗")} exit ${details.exitCode ?? "killed"} ` +
					paint.dim(`· ${details.durationMs ?? 0}ms · sandbox ${details.sandbox ?? "none"}`);
				if (!renderOptions.expanded) return card([headline]);
				return card([
					headline,
					...head(details.stdout ?? null, 20).map((line) => `  ${line}`),
					...head(details.stderr ?? null, 20).map((line) => `  ${paint.muted(line)}`),
				]);
			},
		}),
		defineTool({
			name: "ahde_workshop_author_tool",
			executionMode: SEQUENTIAL,
			label: "Build and test a Target tool",
			description: [
				"Compile one conversational Tool Brief into a complete, canonical Target-tool package and run its contract fixtures.",
				"Use this after interviewing the operator one question at a time about: purpose, input/output, data source, errors, permissions, and credentials.",
				"Arguments: { name, purpose, dataSource, parameters: <JSON Schema>, output: { format: \"json\"|\"text\", description, schema? }, errors: [{ condition, behavior }], permissions: { network: \"deny\"|\"allow\", filesystem: \"read-only\"|\"workspace-write\", process: \"sandboxed-subprocess\" }, credentials: [{ id, purpose, required? }], implementation, supportFiles?, setup?, fixtures: [{ name, covers: \"happy-path\"|\"error-handling\", input, expect: { exitCode?, stdoutContains?, stderrContains?, jsonEquals? } }], timeoutMs?, maxOutputBytes? }.",
				"implementation is the complete shebang executable. It may refer only to logical credentials with {{credential.<id>}}; the host privately asks the operator which environment variable supplies each one and substitutes the name. Never ask for or put a secret value in this call.",
				"The host separately confirms network, filesystem and sandboxed-process capabilities before anything runs.",
				"AHDE requires both a successful fixture and a deterministic error fixture, generates tool.yaml, run, input.schema.json, output.schema.json, README.md, fixtures/*.json and contract-tests.json, removes stale files from the previous package, then tries every fixture through the real Target tool broker.",
				"A failing test is a repair instruction: change the implementation or contract and call this tool again. Do not close the workshop until allPassed is true.",
			].join(" "),
			parameters: WorkshopAuthorToolSchema.parameters,
			prepareArguments: (args) => WorkshopAuthorToolSchema.prepare(args),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				if (!ctx.hasUI || ctx.mode !== "tui") {
					throw new Error("Tool authoring needs the local host UI for credentials and capabilities; RPC, print, and JSON execution fail closed");
				}
				const credentialBindings = await selectToolCredentialEnvironments(ctx, params.name, params.credentials);
				return textResult(await workbench.workshopAuthorTool(params, {
					credentialBindings,
					gate: gateFor(ctx),
					...(signal ? { signal } : {}),
				}));
			},
			renderCall: (args: { name?: string }, theme: Theme) => {
				const paint = themePaint(theme);
				return card([`${paint.accent("workshop")} ${paint.dim("build tool")} ${paint.bold(args.name ?? "")}`]);
			},
			renderResult: (result, renderOptions, theme) => {
				const paint = themePaint(theme);
				const details = result.details as {
					tool?: string;
					files?: string[];
					allPassed?: boolean;
					tests?: { name: string; passed: boolean; durationMs: number; failure: string | null }[];
					capabilities?: { network?: string; filesystem?: string; process?: string; credentials?: number };
				} | undefined;
				if (!details) return card([paint.muted("tool package")]);
				const tests = details.tests ?? [];
				const headline = `${details.allPassed ? paint.success("✓") : paint.error("✗")} ${paint.bold(details.tool ?? "tool")} ` +
					`${tests.filter((test) => test.passed).length}/${tests.length} contract tests passed`;
				if (!renderOptions.expanded) return card([headline]);
				return card([
					headline,
					`  ${paint.dim("Capabilities")} network ${details.capabilities?.network ?? "—"} · filesystem ${details.capabilities?.filesystem ?? "—"} · process sandboxed · ${details.capabilities?.credentials ?? 0} credential binding(s)`,
					`  ${paint.dim("Package")} ${(details.files ?? []).length} generated file(s)`,
					...tests.map((test) => `  ${test.passed ? paint.success("✓") : paint.error("✗")} ${test.name} ${paint.dim(`${test.durationMs}ms`)}${test.failure ? ` — ${oneLine(test.failure, 120)}` : ""}`),
					...(details.allPassed ? [] : [paint.warning("Repair the failing case and try the package again before review.")]),
				]);
			},
		}),
		defineTool({
			name: "ahde_workshop_try",
			executionMode: SEQUENTIAL,
			label: "Try tool",
			description: [
				"Run one declared Target tool of the workshop's own Harness on one JSON input — including the tool you just wrote.",
				"Arguments: { tool: string, input: <the tool's own JSON arguments> }.",
				"It prepares the tool home, runs the declared setup step once, and executes the tool exactly as a Target would.",
				"A tool whose descriptor or declared setup asks for the network or for an environment variable is refused here until the operator allows it once;",
				"the host asks them, the answer is recorded on the workshop, and it travels into the diff they later apply. You cannot set that flag yourself.",
				"This is a look, not a measurement: it writes no evidence, can never become promotion evidence, and never touches the operator's Target.",
				"Write, try, read the error, fix, try again — then close the workshop into a proposal.",
			].join(" "),
			parameters: WorkshopTryToolSchema.parameters,
			prepareArguments: (args) => WorkshopTryToolSchema.prepare(args),
			async execute(_id, params, signal, _update, ctx) {
				abortIfRequested(signal);
				return textResult(await workbench.workshopTry(params, {
					gate: gateFor(ctx),
					...(signal ? { signal } : {}),
				}));
			},
			renderCall: (args: { tool?: string }, theme: Theme) => {
				const paint = themePaint(theme);
				return card([`${paint.accent("workshop")} ${paint.dim("try")} ${paint.bold(args.tool ?? "")}`]);
			},
			renderResult: (result, renderOptions, theme) => {
				const paint = themePaint(theme);
				const details = result.details as {
					tool?: string;
					exitCode?: number | null;
					durationMs?: number;
					sandbox?: string;
					setup?: { exitCode?: number | null } | null;
					stdout?: string;
					stderr?: string;
				} | undefined;
				if (!details) return card([paint.muted("workshop try")]);
				const ok = details.exitCode === 0;
				const headline = `${ok ? paint.success("✓") : paint.error("✗")} ${paint.bold(details.tool ?? "")} ` +
					paint.dim(
						`exit ${details.exitCode ?? "killed"} · ${details.durationMs ?? 0}ms · sandbox ${details.sandbox ?? "none"}` +
							`${details.setup ? ` · setup exit ${details.setup.exitCode ?? "killed"}` : ""}`,
					);
				if (!renderOptions.expanded) return card([headline]);
				return card([
					headline,
					...head(details.stdout ?? null, 20).map((line) => `  ${line}`),
					...head(details.stderr ?? null, 20).map((line) => `  ${paint.muted(line)}`),
				]);
			},
		}),
	];
}
