import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
	CANDIDATE_PROPOSAL_SCHEMA_VERSION,
	CandidateProposalSchema,
	validateCandidateProposal,
	type CandidateProposal,
	type ProposalPredictionInput,
} from "../builders/adapters.js";
import {
	ExecutionPolicyBlock,
	loadTarget,
	TargetManifest,
	type ResolvedTarget,
	type TargetManifest as TargetManifestValue,
} from "../manifest.js";
import { redactTraceText } from "../trace.js";
import {
	openDetachedWorktree,
	withDetachedWorktree,
	type DetachedWorktreeHandle,
} from "../git/experiment-worktree.js";
import {
	disposeTargetWorkspaceSnapshot,
	materializeTargetWorkspaceSnapshot,
} from "../runner.js";
import {
	AUTHORING_RESOURCE_LIMITS,
	buildAuthoringEnvironment,
	sandboxInvocation,
	TargetToolBroker,
	detectTargetToolSandbox,
	type AppliedResourceLimits,
	type SandboxResourceLimits,
	type TargetToolConfinement,
	type TargetToolSandboxBackend,
} from "../target/tool-broker.js";
import { prepareToolHome, type ToolSetupOutcome } from "../target/tool-setup.js";
import { loadTargetTools, type TargetToolLayout } from "../target/tool-manifest.js";
import { resolveExecutionBackend } from "../target/container-backend.js";
import {
	compileHarnessAuthoringProposal,
	renderManifest,
	wholeFileDiff,
	HARNESS_AUTHORING_ALLOWED_PATHS,
	type HarnessAuthoringIntent,
	type HarnessExecutionPolicyPatch,
} from "./harness-authoring.js";
import {
	assertToolContract,
	parseToolFixtureFile,
	type ToolContractFixture,
} from "./tool-authoring.js";
import { assertManifestChangePolicy, assertResourceOnlyManifestChange } from "./builder-proposal.js";
import { ProposalBasisSelectionSchema } from "./improvement-brief.js";
import {
	assertTargetAuthoringSurfaceWithinLimits,
	classifyTargetAuthoringResourcePath,
	explainTargetAuthoringResourcePath,
	TARGET_AUTHORING_LIMITS,
	type TargetAuthoringContextClaim,
	type TargetAuthoringResource,
} from "./target-authoring-context.js";

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** One try is a look at behavior, not a transcript: both streams stay small. */
export const MAX_TRY_TOOL_OUTPUT_BYTES = 8 * 1024;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** Where the tool code being tried comes from. Never the operator's worktree. */
export type ToolWorkshopSource =
	| { kind: "head" }
	| { kind: "branch"; ref: string }
	| { kind: "draft"; intents: readonly HarnessAuthoringIntent[]; summary?: string };

export interface TryToolOptions {
	repositoryDir: string;
	/** Declared tool name, as the Target would call it. */
	tool: string;
	/** JSON arguments; validated against the tool's declared parameter schema. */
	input: unknown;
	source?: ToolWorkshopSource;
	signal?: AbortSignal;
}

export interface TryToolResult {
	schemaVersion: 1;
	tool: string;
	layout: TargetToolLayout;
	source: {
		/** `workshop` is the Builder's own open worktree, dirty and unrecorded. */
		kind: ToolWorkshopSource["kind"] | "workshop";
		ref: string | null;
		/** Paths a draft proposal would change, for the reviewer's orientation. */
		changedPaths: string[];
		/**
		 * The exact content identity of the Harness surface this ran against.
		 * A workshop try re-checks it afterwards: the result always describes the
		 * code that produced it. Null outside a workshop.
		 */
		snapshotHash?: string | null;
	};
	target: {
		id: string;
		gitSha: string;
		toolsetHash: string;
		toolDigest: string;
	};
	sandbox: TargetToolSandboxBackend;
	/** Null when the tool declares no setup step. */
	setup: ToolSetupOutcome | null;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	durationMs: number;
	/** True when the tool exceeded its declared output bound or this projection's. */
	truncated: boolean;
	/** Set when the process was killed by its declared timeout. */
	timedOut: boolean;
}

export class ToolWorkshopError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ToolWorkshopError";
	}
}

const MAX_TRY_TOOL_INPUT_BYTES = 1024 * 1024;

/** An operator's `--input`: inline JSON, or `@path` to a bounded JSON file. */
export function readTryToolInput(value: string): unknown {
	const fromFile = value.startsWith("@");
	const source = fromFile ? readFileSync(resolve(value.slice(1)), "utf8") : value;
	if (Buffer.byteLength(source, "utf8") > MAX_TRY_TOOL_INPUT_BYTES) {
		throw new ToolWorkshopError(`tool input exceeds ${MAX_TRY_TOOL_INPUT_BYTES} bytes`);
	}
	try {
		return JSON.parse(source) as unknown;
	} catch (error) {
		throw new ToolWorkshopError(
			`tool input must be JSON${fromFile ? ` (read from ${value.slice(1)})` : ""}`,
			{ cause: error },
		);
	}
}

/** Redact first, then bound: a secret must never survive by being at byte 8193. */
function boundedOutput(value: string): { text: string; truncated: boolean } {
	const redacted = redactTraceText(value);
	const raw = Buffer.from(redacted, "utf8");
	if (raw.byteLength <= MAX_TRY_TOOL_OUTPUT_BYTES) return { text: redacted, truncated: false };
	return { text: raw.subarray(0, MAX_TRY_TOOL_OUTPUT_BYTES).toString("utf8"), truncated: true };
}

function applyDraft(worktreePath: string, patch: string): void {
	try {
		execFileSync("git", ["-C", worktreePath, "apply", "--whitespace=nowarn", "-"], {
			input: patch,
			stdio: ["pipe", "pipe", "pipe"],
			maxBuffer: GIT_MAX_BUFFER,
		});
	} catch (error) {
		throw new ToolWorkshopError("the proposal draft does not apply to the selected revision", { cause: error });
	}
}

/**
 * Run one declared tool on one JSON input inside a private scratch copy of the
 * Harness, exactly as a Target would: same descriptor, same declared backend, same
 * declared setup step, same workspace projection (no evals, no imports, no
 * secrets, only declared data).
 *
 * This is a look, not a measurement. Nothing is written to the runs root, no
 * eval evidence exists afterwards, and the operator's checkout is never read
 * for execution — only a detached worktree of an exact revision is.
 */
export async function tryTool(options: TryToolOptions): Promise<TryToolResult> {
	if (!TOOL_NAME.test(options.tool)) throw new ToolWorkshopError(`invalid tool name: ${JSON.stringify(options.tool)}`);
	const source: ToolWorkshopSource = options.source ?? { kind: "head" };
	const ref = source.kind === "branch" ? source.ref : "HEAD";

	let draftPatch: string | null = null;
	let changedPaths: string[] = [];
	if (source.kind === "draft") {
		const proposal = compileHarnessAuthoringProposal({
			repositoryDir: options.repositoryDir,
			intents: source.intents,
			summary: source.summary ?? `Try the ${options.tool} tool`,
		});
		changedPaths = proposal.changes.map((change) => change.path);
		if (proposal.decision === "propose") {
			draftPatch = `${proposal.changes.map((change) => change.unifiedDiff.trimEnd()).join("\n")}\n`;
		}
	}

	return withDetachedWorktree({ repositoryDir: options.repositoryDir, ref }, async (worktree) => {
		if (draftPatch) applyDraft(worktree.path, draftPatch);
		return runDeclaredToolInDirectory({
			directory: worktree.path,
			tool: options.tool,
			input: options.input,
			source: { kind: source.kind, ref: source.kind === "branch" ? source.ref : null, changedPaths },
			...(options.signal ? { signal: options.signal } : {}),
		});
	});
}

/**
 * Execute one resolved Target tool over a directory that is already the whole
 * filesystem surface it may see. The ordinary try path hands this an eval-style
 * snapshot; a Builder workshop hands it the much smaller authorable projection.
 */
async function runDeclaredToolOnSurface(options: {
	target: ResolvedTarget;
	directory: string;
	toolHomeRoot: string;
	scratchRoot: string;
	tool: string;
	input: unknown;
	source: TryToolResult["source"];
	signal?: AbortSignal;
	resourceLimits?: SandboxResourceLimits;
}): Promise<TryToolResult> {
	const resolved = loadTargetTools(options.directory, options.target.manifest.tools, options.target.manifest.execution);
	const tool = resolved.tools.find((candidate) => candidate.descriptor.name === options.tool);
	if (!tool) {
		const declared = resolved.tools.map((candidate) => candidate.descriptor.name).join(", ") || "none";
		throw new ToolWorkshopError(`Target declares no tool named ${options.tool}; declared: ${declared}`);
	}
	const scratchDir = join(options.scratchRoot, "sandbox");
	// Resolve the Target's declared backend once and hand that exact choice to
	// both setup and the tool call. A container Target must never be previewed on
	// host dependencies and then measured in a different OCI environment.
	const sandboxChoice = resolveExecutionBackend({
		policy: options.target.manifest.execution,
		osBackend: () => detectTargetToolSandbox(options.directory, scratchDir),
	});
	const sandboxBackend = sandboxChoice.backend;
	const prepared = tool.layout === "directory"
		? prepareToolHome({
			workspaceDir: options.directory,
			scratchDir,
			tools: resolved.tools,
			toolHomeRoot: options.toolHomeRoot,
			policy: options.target.manifest.execution,
			sandboxBackend,
			...(sandboxChoice.containerRuntime ? { containerRuntime: sandboxChoice.containerRuntime } : {}),
			...(options.resourceLimits ? { resourceLimits: options.resourceLimits } : {}),
		})
		: null;
	const broker = new TargetToolBroker({
		workspaceDir: options.directory,
		scratchDir,
		policy: options.target.manifest.execution,
		sandboxBackend,
		...(sandboxChoice.containerRuntime ? { containerRuntime: sandboxChoice.containerRuntime } : {}),
		...(prepared ? { toolHomeRoot: prepared.root } : {}),
		...(options.resourceLimits ? { resourceLimits: options.resourceLimits } : {}),
	});
	const raw = await broker.runRaw(tool, options.input, options.signal);
	const stdout = boundedOutput(raw.stdout);
	const stderr = boundedOutput(raw.stderr);
	const setup = prepared?.setups.find((outcome) => outcome.tool === tool.descriptor.name) ?? null;
	return {
		schemaVersion: 1,
		tool: tool.descriptor.name,
		layout: tool.layout,
		source: options.source,
		target: {
			id: options.target.manifest.id,
			gitSha: options.target.gitSha,
			toolsetHash: resolved.toolsetHash,
			toolDigest: tool.digest,
		},
		sandbox: broker.sandboxBackend,
		setup: setup && setup.ran
			? {
				...setup,
				stdout: boundedOutput(setup.stdout).text,
				stderr: boundedOutput(setup.stderr).text,
			}
			: null,
		stdout: stdout.text,
		stderr: stderr.text,
		exitCode: raw.exitCode,
		durationMs: raw.durationMs,
		truncated: raw.truncated || stdout.truncated || stderr.truncated,
		timedOut: raw.stopped === "timeout",
	} satisfies TryToolResult;
}

// ---------------------------------------------------------------------------
// Contract fixtures.
//
// A tool package carries its own tests: `tools/<name>/fixtures/<fixture>.json`,
// each one an input and what to expect back. They live inside the tool
// directory, so they join its digest like every other file, and they are the
// same tests in the Workshop, on the CLI, and in the close panel.

/** One fixture, run for real, judged deterministically. */
export interface ToolFixtureOutcome {
	name: string;
	passed: boolean;
	exitCode: number | null;
	durationMs: number;
	/** Empty when it passed; bounded and already redacted when it did not. */
	failures: string[];
}

export interface ToolFixtureRunResult {
	tool: string;
	total: number;
	passed: number;
	allPassed: boolean;
	fixtures: ToolFixtureOutcome[];
}

const MAX_TOOL_FIXTURES = 32;

/** `✓ 3/3 fixtures`, or the first failure — one line, in either language. */
export function describeFixtureRun(run: ToolFixtureRunResult): string {
	if (run.total === 0) return `— ${run.tool}: no fixtures`;
	if (run.allPassed) return `✓ ${run.passed}/${run.total} fixtures`;
	const failed = run.fixtures.find((fixture) => !fixture.passed);
	return `✗ ${run.passed}/${run.total} — ${failed?.name ?? "?"}: ${failed?.failures.join("; ") ?? "failed"}`;
}

/**
 * The newest fixture run of each tool, recovered from the workshop's own try
 * history. This is what the close panel states — `✓ 3/3 fixtures` — and it is
 * deliberately workshop-local, restart-surviving scratch rather than evidence:
 * a run only counts for the exact snapshot it ran against, so repairing a tool
 * and closing without re-running shows the repair as untested.
 */
export function lastFixtureRunPerTool(
	history: readonly { tool: string; test: string | null; passed: boolean; failure: string | null; exitCode: number | null; durationMs: number; snapshotHash: string }[],
): ToolFixtureRunResult[] {
	const byTool = new Map<string, typeof history[number][]>();
	for (const entry of history) {
		if (entry.test === null) continue;
		byTool.set(entry.tool, [...(byTool.get(entry.tool) ?? []), entry]);
	}
	const runs: ToolFixtureRunResult[] = [];
	for (const [tool, entries] of byTool) {
		const newest = entries[entries.length - 1];
		if (!newest) continue;
		// One run is the named tries against one snapshot; a retry of the same
		// fixture replaces the earlier attempt rather than counting twice.
		const latest = new Map<string, typeof history[number]>();
		for (const entry of entries) {
			if (entry.snapshotHash === newest.snapshotHash) latest.set(entry.test as string, entry);
		}
		runs.push(summarizeFixtures(tool, [...latest.values()].map((entry) => ({
			name: entry.test as string,
			passed: entry.passed,
			exitCode: entry.exitCode,
			durationMs: entry.durationMs,
			failures: entry.failure === null ? [] : [entry.failure],
		}))));
	}
	return runs.sort((left, right) => left.tool.localeCompare(right.tool));
}

/**
 * Every fixture of one tool, in filename order. A tool with no `fixtures/`
 * directory has no contract tests, which is a fact about it rather than an
 * error: the refusal belongs to whoever asked to run them.
 */
export function readToolFixtures(rootDir: string, tool: string): ToolContractFixture[] {
	if (!TOOL_NAME.test(tool)) throw new ToolWorkshopError(`invalid tool name: ${JSON.stringify(tool)}`);
	const directory = resolve(rootDir, "tools", tool, "fixtures");
	if (!existsSync(directory)) return [];
	const names = readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => entry.name.slice(0, -".json".length))
		.sort((left, right) => left.localeCompare(right));
	if (names.length > MAX_TOOL_FIXTURES) {
		throw new ToolWorkshopError(`tools/${tool}/fixtures holds more than ${MAX_TOOL_FIXTURES} fixtures`);
	}
	return names.map((name) => {
		try {
			return parseToolFixtureFile(name, readFileSync(join(directory, `${name}.json`), "utf8"));
		} catch (error) {
			throw new ToolWorkshopError(
				`tools/${tool}/fixtures/${name}.json is not a valid contract fixture: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	});
}

/**
 * The declared output schema of a JSON tool, when the package carries one. A
 * fixture then also proves the tool keeps its own contract, not just that it
 * printed something the fixture recognised.
 */
function toolOutputSchema(rootDir: string, target: ResolvedTarget, tool: string): Record<string, unknown> | undefined {
	const descriptor = target.tools.find((entry) => entry.descriptor.name === tool)?.descriptor;
	if (descriptor?.output !== "json") return undefined;
	const path = resolve(rootDir, "tools", tool, "output.schema.json");
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
	} catch {
		// A malformed schema is a package problem the fixtures will not hide; it
		// simply stops being an extra assertion.
		return undefined;
	}
}

function fixtureOutcome(
	fixture: ToolContractFixture,
	result: TryToolResult,
	schema: Record<string, unknown> | undefined,
): ToolFixtureOutcome {
	const assertion = assertToolContract(fixture, result, schema);
	return {
		name: fixture.name,
		passed: assertion.passed,
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		failures: assertion.failures.map((failure) => redactTraceText(failure).slice(0, 240)),
	};
}

function summarizeFixtures(tool: string, fixtures: readonly ToolFixtureOutcome[]): ToolFixtureRunResult {
	const passed = fixtures.filter((fixture) => fixture.passed).length;
	return {
		tool,
		total: fixtures.length,
		passed,
		allPassed: fixtures.length > 0 && passed === fixtures.length,
		fixtures: [...fixtures],
	};
}

/**
 * Run every declared fixture of one tool against one exact revision, outside
 * any workshop. This is what `ahde tool try --fixtures` is: the same package
 * tests the Builder runs, available to whoever owns the checkout.
 */
export async function runToolFixtures(options: {
	repositoryDir: string;
	tool: string;
	source?: ToolWorkshopSource;
	signal?: AbortSignal;
}): Promise<ToolFixtureRunResult> {
	if (!TOOL_NAME.test(options.tool)) throw new ToolWorkshopError(`invalid tool name: ${JSON.stringify(options.tool)}`);
	const source: ToolWorkshopSource = options.source ?? { kind: "head" };
	const ref = source.kind === "branch" ? source.ref : "HEAD";
	return withDetachedWorktree({ repositoryDir: options.repositoryDir, ref }, async (worktree) => {
		const fixtures = readToolFixtures(worktree.path, options.tool);
		if (fixtures.length === 0) {
			throw new ToolWorkshopError(
				`tools/${options.tool} declares no contract fixtures; add tools/${options.tool}/fixtures/<name>.json`,
			);
		}
		const schema = toolOutputSchema(worktree.path, loadTarget(worktree.path), options.tool);
		const outcomes: ToolFixtureOutcome[] = [];
		for (const fixture of fixtures) {
			const result = await runDeclaredToolInDirectory({
				directory: worktree.path,
				tool: options.tool,
				input: fixture.input,
				source: { kind: source.kind, ref: source.kind === "branch" ? source.ref : null, changedPaths: [] },
				...(options.signal ? { signal: options.signal } : {}),
			});
			outcomes.push(fixtureOutcome(fixture, result, schema));
		}
		return summarizeFixtures(options.tool, outcomes);
	});
}

/**
 * The ordinary try path starts from a detached exact revision, then subtracts
 * eval inputs, state, secrets and undeclared data through the same snapshot the
 * Target runner uses. Nothing here reads or writes the operator's checkout.
 */
async function runDeclaredToolInDirectory(options: {
	directory: string;
	tool: string;
	input: unknown;
	source: TryToolResult["source"];
	signal?: AbortSignal;
}): Promise<TryToolResult> {
	const target = loadTarget(options.directory);
	const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), "ahde-tool-try-")));
	const runsRoot = join(scratchRoot, "runs");
	mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
	const snapshot = materializeTargetWorkspaceSnapshot(target, runsRoot);
	try {
		return await runDeclaredToolOnSurface({
			target,
			directory: snapshot.dir,
			toolHomeRoot: snapshot.toolHomeDir,
			scratchRoot,
			tool: options.tool,
			input: options.input,
			source: options.source,
			...(options.signal ? { signal: options.signal } : {}),
		});
	} finally {
		disposeTargetWorkspaceSnapshot(snapshot);
		rmSync(scratchRoot, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// The Builder workshop.
//
// One detached worktree of one exact clean Target commit, writable only inside
// the declared Harness scope, alive for exactly one proposal attempt. It is the
// only writable surface Builder Pi ever receives, and closing it compiles the
// proposal from what is actually on disk rather than from stated intent.

/** The only paths a workshop may read, create, change, or remove. */
export const BUILDER_WORKSHOP_SCOPE = ["AGENTS.md", "skills/**", "tools/**", "bin/**", "data/**"] as const;
const WORKSHOP_SCOPE_PREFIXES = ["skills/", "tools/", "bin/", "data/"] as const;
const WORKSHOP_SCOPE_DIRECTORIES = ["skills", "tools", "bin", "data"] as const;
const WORKSHOP_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** `manifest.yaml` is host-owned: the workshop derives its declarations. */
const WORKSHOP_MANIFEST = "manifest.yaml";
/** The whole surface workshop-authored code may see. Host policy stays outside. */
export const BUILDER_WORKSHOP_MOUNTED_PATHS = [...BUILDER_WORKSHOP_SCOPE] as const;

export const MAX_WORKSHOP_FILE_BYTES = TARGET_AUTHORING_LIMITS.resourceBytes;
export const MAX_WORKSHOP_CHANGES = 256;
const MAX_WORKSHOP_WRITES = 512;
const MAX_WORKSHOP_COMMANDS = 256;
const MAX_WORKSHOP_LISTING = 200;
const MAX_WORKSHOP_ARGV = 64;
const MAX_WORKSHOP_ARGUMENT_BYTES = 4096;
const DEFAULT_WORKSHOP_TIMEOUT_MS = 120_000;
const MAX_WORKSHOP_TIMEOUT_MS = 600_000;
const MAX_WORKSHOP_OUTPUT_BYTES = 256 * 1024;
export const MAX_WORKSHOP_GRANT_AUDIT_EVENTS = 256;
const WORKSHOP_COMMAND = /^[A-Za-z0-9._-]+$/;
const WORKSHOP_SCRATCH_PREFIX = "ahde-workshop-";
const WORKSHOP_CONTRACT_FIXTURE = /^fixtures\/([a-z0-9][a-z0-9_-]{0,63})\.json$/;
const WorkshopContractManifestSchema = z.strictObject({
	schemaVersion: z.literal(1),
	tool: z.string().regex(TOOL_NAME),
	fixtures: z.array(z.string().regex(WORKSHOP_CONTRACT_FIXTURE)).min(1).max(32)
		.refine((paths) => new Set(paths).size === paths.length, "contract fixture paths must be unique"),
});

/** A refusal that always names the exact offending path. */
export class BuilderWorkshopScopeError extends ToolWorkshopError {
	readonly paths: readonly string[];
	constructor(paths: readonly string[], reason: string) {
		super(`workshop scope refuses ${paths.join(", ")}: ${reason}`);
		this.name = "BuilderWorkshopScopeError";
		this.paths = [...paths];
	}
}

/** Closing a workshop that changed nothing is a refusal, not an empty proposal. */
export class BuilderWorkshopEmptyError extends ToolWorkshopError {
	constructor() {
		super("the workshop produced no change; write something or discard it");
		this.name = "BuilderWorkshopEmptyError";
	}
}

/**
 * A try that wants more than the authoring profile grants. It is never a flag
 * the model may set: the host asks the operator one question and records the
 * answer on the workshop, so the close and apply dialogs can show it.
 */
export class BuilderWorkshopGrantRequiredError extends ToolWorkshopError {
	readonly tool: string;
	readonly wants: readonly string[];
	constructor(tool: string, wants: readonly string[]) {
		super(
			`the ${tool} tool wants ${wants.join(" and ")} to run here; ` +
			"the operator has to allow that once before it may be tried",
		);
		this.name = "BuilderWorkshopGrantRequiredError";
		this.tool = tool;
		this.wants = [...wants];
	}
}

/**
 * A persisted workshop descriptor is selection state, not authority. In
 * particular its cleanup path may never choose an arbitrary directory: accept
 * only a real, direct child of the OS temp directory minted with our prefix.
 */
function workshopScratchRoot(input: string): string {
	let root: string;
	try {
		root = realpathSync(resolve(input));
	} catch (error) {
		throw new ToolWorkshopError("the recorded workshop scratch directory is gone; open a new one", { cause: error });
	}
	const temporary = realpathSync(resolve(tmpdir()));
	const child = relative(temporary, root);
	if (
		!child ||
		isAbsolute(child) ||
		child === ".." ||
		child.startsWith(`..${sep}`) ||
		child.includes(sep) ||
		!basename(root).startsWith(WORKSHOP_SCRATCH_PREFIX) ||
		!statSync(root).isDirectory()
	) {
		throw new ToolWorkshopError(`refusing an unsafe workshop scratch directory: ${root}`);
	}
	return root;
}

function assertWorkshopScope(requested: string): void {
	if (
		typeof requested !== "string" ||
		!WORKSHOP_PATH.test(requested) ||
		requested !== requested.trim() ||
		requested.includes("\\") ||
		requested.includes("\0") ||
		requested.includes(":") ||
		isAbsolute(requested) ||
		requested.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		throw new BuilderWorkshopScopeError([requested], "a workshop path is a safe relative POSIX path with no traversal");
	}
	const inScope = requested === "AGENTS.md" ||
		WORKSHOP_SCOPE_PREFIXES.some((prefix) => requested.startsWith(prefix) && requested.length > prefix.length);
	if (!inScope) {
		throw new BuilderWorkshopScopeError(
			[requested],
			`only ${BUILDER_WORKSHOP_SCOPE.join(", ")} exist in a workshop`,
		);
	}
}

/**
 * Resolve one requested path against the workshop root on the real filesystem.
 * Every existing ancestor must be a regular directory; the leaf must be a
 * regular file or directory; a symlink anywhere fails closed by its own path.
 */
function resolveWorkshopPath(root: string, requested: string): string {
	assertWorkshopScope(requested);
	const segments = requested.split("/");
	let cursor = root;
	for (const [index, segment] of segments.entries()) {
		cursor = join(cursor, segment);
		let info;
		try {
			info = lstatSync(cursor);
		} catch {
			// Nothing exists from here down; the remaining segments cannot escape.
			return join(root, requested);
		}
		if (info.isSymbolicLink()) {
			throw new BuilderWorkshopScopeError([requested], `the path traverses a symlink at ${relative(root, cursor)}`);
		}
		if (index < segments.length - 1 && !info.isDirectory()) {
			throw new BuilderWorkshopScopeError([requested], `${relative(root, cursor)} is not a directory`);
		}
		if (!info.isDirectory() && !info.isFile()) {
			throw new BuilderWorkshopScopeError([requested], "the path is not a regular file or directory");
		}
	}
	const absolute = join(root, requested);
	const canonical = realpathSync(absolute);
	const inside = relative(root, canonical);
	if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
		throw new BuilderWorkshopScopeError([requested], "the path escapes the workshop worktree");
	}
	return absolute;
}

function workshopSha256(content: Buffer | string): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** One file of the authorable projection, exactly as it is on disk. */
interface WorkshopFileState {
	path: string;
	mode: "100644" | "100755";
	content: Buffer;
}

/**
 * Every regular file under one root of the projection, read once. Symlinks are
 * collected rather than followed: the caller decides whether to refuse by name
 * (a command produced one) or to skip (a listing walked past one).
 */
function collectWorkshopFiles(
	base: string,
	relativePath: string,
	into: Map<string, WorkshopFileState>,
	symlinks: string[],
	depth = 0,
): void {
	if (depth > 24) throw new ToolWorkshopError(`${relativePath} nests deeper than a workshop allows`);
	const absolute = join(base, relativePath);
	let info;
	try {
		info = lstatSync(absolute);
	} catch {
		return;
	}
	if (info.isSymbolicLink()) {
		symlinks.push(relativePath);
		return;
	}
	if (info.isDirectory()) {
		for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			collectWorkshopFiles(base, `${relativePath}/${entry.name}`, into, symlinks, depth + 1);
		}
		return;
	}
	if (!info.isFile()) {
		symlinks.push(relativePath);
		return;
	}
	into.set(relativePath, {
		path: relativePath,
		mode: (info.mode & 0o111) === 0 ? "100644" : "100755",
		content: readFileSync(absolute),
	});
}

/** Content identity of one whole authorable projection, path and mode included. */
function workshopSnapshotHash(entries: ReadonlyMap<string, WorkshopFileState>): string {
	const digest = createHash("sha256");
	for (const path of [...entries.keys()].sort((left, right) => left.localeCompare(right))) {
		const file = entries.get(path) as WorkshopFileState;
		digest.update(`${path}\0${file.mode}\0${createHash("sha256").update(file.content).digest("hex")}\n`);
	}
	return `sha256:${digest.digest("hex")}`;
}

/** An honest sentence when the host could not enforce part of the cap set. */
function resourceLimitNote(limits: AppliedResourceLimits | null): string | null {
	if (!limits) return "this host applied no resource caps; only the wall-clock timeout and the output bound hold";
	if (limits.unenforced.length === 0) return null;
	return `this host could not enforce ulimit ${limits.unenforced.map((flag) => `-${flag}`).join(", ")}; ` +
		"those caps are not applied here, and only the wall-clock timeout and the output bound hold in their place";
}

function workshopText(content: Buffer, path: string): string {
	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch (error) {
		throw new ToolWorkshopError(`${path} must be valid UTF-8 text`, { cause: error });
	}
	if (decoded.includes("\0")) throw new ToolWorkshopError(`${path} must not contain NUL bytes`);
	if (decoded.includes("\r")) throw new ToolWorkshopError(`${path} must use LF line endings`);
	return decoded;
}

function gitWorkshop(repositoryDir: string, args: string[], input?: string): string {
	return gitWorkshopRaw(repositoryDir, args, input).trim();
}

/**
 * Untrimmed, because `git status --porcelain -z` opens its first record with a
 * meaningful space: trimming it shifts every path by one character.
 */
function gitWorkshopRaw(repositoryDir: string, args: string[], input?: string): string {
	try {
		return execFileSync("git", ["--no-replace-objects", "-C", repositoryDir, ...args], {
			encoding: "utf8",
			maxBuffer: GIT_MAX_BUFFER,
			...(input === undefined
				? { stdio: ["ignore", "pipe", "pipe"] as const }
				: { input, stdio: ["pipe", "pipe", "pipe"] as const }),
		});
	} catch (error) {
		const stderr = typeof error === "object" && error !== null && "stderr" in error
			? String((error as { stderr?: unknown }).stderr).trim()
			: "";
		throw new ToolWorkshopError(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, { cause: error });
	}
}

interface WorkshopBaseBlob {
	mode: "100644" | "100755";
	content: Buffer;
}

/** One tracked file of the exact base commit, or null when it did not exist. */
function baseBlobAt(repositoryDir: string, sha: string, path: string): WorkshopBaseBlob | null {
	const record = execFileSync(
		"git",
		["--no-replace-objects", "-C", repositoryDir, "ls-tree", "-z", sha, "--", path],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: GIT_MAX_BUFFER },
	).split("\0").filter(Boolean).find((entry) => entry.slice(entry.indexOf("\t") + 1) === path);
	if (!record) return null;
	const [mode, type] = record.slice(0, record.indexOf("\t")).split(" ");
	if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
		throw new BuilderWorkshopScopeError([path], "the base revision holds a non-regular file there");
	}
	const content = execFileSync(
		"git",
		["--no-replace-objects", "-C", repositoryDir, "show", `${sha}:${path}`],
		{ stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_WORKSHOP_FILE_BYTES + 1024 },
	);
	return { mode, content };
}

export interface WorkshopEntry {
	path: string;
	kind: "file" | "directory";
	mode: "100644" | "100755" | null;
	bytes: number | null;
}

export interface WorkshopReadResult {
	path: string;
	kind: "file" | "directory";
	mode: "100644" | "100755" | null;
	bytes: number | null;
	sha256: string | null;
	/** Exact complete file text; null for a directory listing. */
	content: string | null;
	entries: WorkshopEntry[] | null;
	entriesTruncated: boolean;
}

export interface WorkshopWriteRequest {
	path: string;
	/** Whole-file form. */
	content?: string;
	/** Exact-replacement form: `oldText` must occur exactly once. */
	oldText?: string;
	newText?: string;
	/** Removal form. */
	remove?: boolean;
	mode?: "100644" | "100755";
}

export interface WorkshopWriteResult {
	path: string;
	action: "created" | "updated" | "removed" | "unchanged";
	mode: "100644" | "100755" | null;
	bytes: number | null;
	sha256: string | null;
}

export interface WorkshopBashRequest {
	argv: readonly string[];
	/** A workshop-scoped directory; the worktree root by default. */
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface WorkshopBashResult {
	argv: string[];
	cwd: string;
	sandbox: TargetToolSandboxBackend;
	network: "deny" | "allow";
	/** Exactly the variable names the command received; never a Target allowlist. */
	environment: string[];
	/** Everything the command could see, relative to the Harness root. */
	mounted: readonly string[];
	/** The caps the backend enforced, and the ones it could not. */
	limits: AppliedResourceLimits | null;
	/** Set when the backend enforced no cap at all, so the result says so. */
	note: string | null;
	exitCode: number | null;
	durationMs: number;
	stdout: string;
	stderr: string;
	truncated: boolean;
	timedOut: boolean;
}

export interface WorkshopChange {
	path: string;
	status: "added" | "modified" | "removed";
	bytes: number | null;
}

/** What one workshop tool wants beyond the authoring profile, before it runs. */
export interface WorkshopToolGrantRequirement {
	tool: string;
	/** Exact resolved descriptor + executable/support-file identity. */
	toolDigest: string;
	/** The declared tool or its setup step asks to reach the network. */
	network: boolean;
	setupNetwork: boolean;
	runtimeNetwork: boolean;
	/** Environment variables the declared tool asks for — credentials, in practice. */
	environment: readonly string[];
	/** Human words for the one question the host asks. */
	wants: readonly string[];
}

/** The operator's recorded answer to that one question. */
export interface WorkshopGrant {
	tool: string;
	toolDigest: string;
	wants: readonly string[];
	/** Exact authored bytes this one-process exception reviewed. */
	snapshotHash: string;
	/** A grant is consumed before its exact try starts, even when execution fails. */
	used: boolean;
	grantedAt: string;
	actorId: string;
}

/** One credential-redacted observation from the live write → try → repair loop. */
export interface WorkshopTrySummary {
	tool: string;
	test: string | null;
	passed: boolean;
	exitCode: number | null;
	timedOut: boolean;
	truncated: boolean;
	durationMs: number;
	/** A bounded, already-redacted explanation; never raw process output. */
	failure: string | null;
	snapshotHash: string;
	at: string;
}

/** Human-readable authority requested by one declared process tool. */
export interface WorkshopToolCapabilitySummary {
	tool: string;
	network: "deny" | "allow";
	filesystem: "read-only" | "workspace-write";
	process: "sandboxed-subprocess";
	/** Environment names are policy references, never their values. */
	environment: string[];
}

/**
 * Durable disclosure that one exact live grant was consumed. This is audit
 * history only: replaying it can explain risk, but can never authorize a tool.
 */
export const WorkshopGrantAuditEventSchema = z.strictObject({
	schemaVersion: z.literal(1),
	eventId: z.string().regex(/^workshop-grant_[0-9a-f]{24}$/),
	workshopId: z.string().regex(/^workshop_[0-9a-f]{16}$/),
	tool: z.string().regex(TOOL_NAME),
	toolDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
	wants: z.array(z.string().min(1).max(200)).min(1).max(8),
	snapshotHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
	used: z.literal(true),
	grantedAt: z.iso.datetime({ offset: true }),
	consumedAt: z.iso.datetime({ offset: true }),
	actorId: z.string().min(1).max(256),
});
export type WorkshopGrantAuditEvent = z.infer<typeof WorkshopGrantAuditEventSchema>;

export interface WorkshopStatus {
	workshopId: string;
	target: { id: string; gitSha: string };
	/** What the workshop is bound to: an approved Spec, or a diagnosis. */
	basis: BuilderWorkshopBasis;
	openedAt: string;
	writes: number;
	commands: number;
	tries: number;
	changes: WorkshopChange[];
	scope: readonly string[];
	/** Exact content identity of everything in scope, right now. */
	snapshotHash: string;
	grants: readonly (WorkshopGrant | WorkshopGrantAuditEvent)[];
	/** Survives Builder restarts; values and full outputs are never retained. */
	tryHistory: readonly WorkshopTrySummary[];
	/** Current changed tools only, so close/review does not claim unrelated authority. */
	toolCapabilities: readonly WorkshopToolCapabilitySummary[];
}

/**
 * A workshop is bound either to an approved Spec (build the thing) or to a
 * diagnosis of a conclusive evaluation (improve the thing). Both compile the
 * same proposal; only the evidence the proposal carries differs.
 */
export type BuilderWorkshopBasis = "construction" | "improvement";

export const BuilderWorkshopSourceSchema = ProposalBasisSelectionSchema.omit({ failureModeIds: true });
export type BuilderWorkshopSource = z.infer<typeof BuilderWorkshopSourceSchema>;

/** Immutable authority captured when a workshop opens. */
export type BuilderWorkshopBinding =
	| { basis: "construction"; approvedSpecId: string; source: null }
	| { basis: "improvement"; approvedSpecId: string; source: BuilderWorkshopSource };

export interface OpenBuilderWorkshopOptions {
	repositoryDir: string;
	/** Host-derived Target identity; a workshop never trusts a model for it. */
	expectedTarget: { id: string; gitSha: string };
	/** The exact claim minted from the same clean revision this copies. */
	authoringContext: TargetAuthoringContextClaim;
	/** Exact Spec/evidence authority; selection state may never rewrite it. */
	binding: BuilderWorkshopBinding;
	/** Reopening a closed proposal: its exact whole-file diffs seed the worktree. */
	seed?: { proposalRunId: string; patch: string } | undefined;
	workshopId?: string;
	now?: () => string;
	grantHistory?: readonly WorkshopGrantAuditEvent[];
	onGrantConsumed?: (event: WorkshopGrantAuditEvent) => void;
}

/**
 * Everything needed to find one open workshop again after the Builder process
 * died. It is selection state — like focus — not a receipt: it grants nothing,
 * and re-attaching fails closed when the worktree moved or its bytes changed.
 */
export interface BuilderWorkshopDescriptor {
	schemaVersion: 1;
	workshopId: string;
	targetId: string;
	baseTargetSha: string;
	basis: BuilderWorkshopBasis;
	approvedSpecId: string;
	source: BuilderWorkshopSource | null;
	fromProposalRunId: string | null;
	worktreePath: string;
	scratchRoot: string;
	openedAt: string;
	snapshotHash: string;
	/** Host-authored execution widening needed by typed tool packages. */
	toolAuthoringPolicy?: {
		network: "deny" | "allow";
		environmentAllowlist: string[];
	};
	tryHistory?: WorkshopTrySummary[];
}

export interface CompiledWorkshopProposal {
	proposal: CandidateProposal;
	changes: WorkshopChange[];
	/** The exact revision the diff is against; identical to `proposal.baseTargetSha`. */
	baseTargetSha: string;
	manifestChangePolicy: "resources-only" | "execution-policy";
}

function assertWorkshopBinding(input: BuilderWorkshopBinding): BuilderWorkshopBinding {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(input.approvedSpecId)) {
		throw new ToolWorkshopError("a workshop requires one exact approved Spec id");
	}
	if (input.basis === "construction") {
		if (input.source !== null) {
			throw new ToolWorkshopError("a construction workshop cannot carry improvement evidence");
		}
		return { basis: input.basis, approvedSpecId: input.approvedSpecId, source: null };
	}
	if (input.basis === "improvement") {
		if (input.source === null) {
			throw new ToolWorkshopError("an improvement workshop requires one exact evidence source");
		}
		return {
			basis: input.basis,
			approvedSpecId: input.approvedSpecId,
			source: BuilderWorkshopSourceSchema.parse(input.source),
		};
	}
	throw new ToolWorkshopError("invalid workshop basis");
}

function sameWorkshopBinding(left: BuilderWorkshopBinding, right: BuilderWorkshopBinding): boolean {
	if (left.basis !== right.basis || left.approvedSpecId !== right.approvedSpecId) return false;
	if (left.source === null || right.source === null) return left.source === right.source;
	return left.source.algorithmId === right.source.algorithmId &&
		left.source.evalRunId === right.source.evalRunId &&
		left.source.diagnosisId === right.source.diagnosisId &&
		left.source.briefId === right.source.briefId;
}

/**
 * One open workshop. Everything it can do is bounded, path-scoped, and dies
 * with `dispose()`: no evidence, no artifacts, and nothing in the operator's
 * checkout — its worktree is not even reachable from `git worktree list`
 * afterwards.
 */
export class BuilderWorkshop {
	readonly workshopId: string;
	readonly repositoryDir: string;
	readonly baseTargetSha: string;
	readonly targetId: string;
	readonly path: string;
	readonly openedAt: string;
	readonly claim: TargetAuthoringContextClaim;
	readonly basis: BuilderWorkshopBasis;
	readonly approvedSpecId: string;
	readonly source: BuilderWorkshopSource | null;
	readonly fromProposalRunId: string | null;
	private readonly worktree: DetachedWorktreeHandle;
	private readonly scratchRoot: string;
	private readonly baseManifestText: string;
	private readonly baseManifest: TargetManifestValue;
	private readonly written = new Set<string>();
	/** Written and then deliberately taken back; the diff owes nothing for these. */
	private readonly removed = new Set<string>();
	private readonly grants: WorkshopGrant[] = [];
	private readonly grantHistory: WorkshopGrantAuditEvent[];
	private readonly tryHistory: WorkshopTrySummary[];
	private readonly onGrantConsumed: ((event: WorkshopGrantAuditEvent) => void) | undefined;
	/** Cumulative, host-owned widening from the exact baseline execution policy. */
	private toolAuthoringPolicy: { network: "deny" | "allow"; environmentAllowlist: string[] } | null;
	private writes = 0;
	private commands = 0;
	private tries = 0;
	private disposed = false;

	constructor(options: {
		workshopId: string;
		repositoryDir: string;
		worktree: DetachedWorktreeHandle;
		scratchRoot: string;
		targetId: string;
		claim: TargetAuthoringContextClaim;
		binding: BuilderWorkshopBinding;
		fromProposalRunId?: string | null;
		openedAt: string;
		baseManifestText: string;
		baseManifest: TargetManifestValue;
		toolAuthoringPolicy?: { network: "deny" | "allow"; environmentAllowlist: string[] } | null;
		tryHistory?: readonly WorkshopTrySummary[];
		grantHistory?: readonly WorkshopGrantAuditEvent[];
		onGrantConsumed?: (event: WorkshopGrantAuditEvent) => void;
	}) {
		this.workshopId = options.workshopId;
		this.repositoryDir = options.repositoryDir;
		this.worktree = options.worktree;
		this.scratchRoot = workshopScratchRoot(options.scratchRoot);
		this.baseTargetSha = options.worktree.sha;
		this.targetId = options.targetId;
		this.path = realpathSync(options.worktree.path);
		this.openedAt = options.openedAt;
		this.claim = options.claim;
		const binding = assertWorkshopBinding(options.binding);
		this.basis = binding.basis;
		this.approvedSpecId = binding.approvedSpecId;
		this.source = binding.source;
		this.fromProposalRunId = options.fromProposalRunId ?? null;
		this.baseManifestText = options.baseManifestText;
		this.baseManifest = options.baseManifest;
		this.toolAuthoringPolicy = options.toolAuthoringPolicy
			? {
				network: options.toolAuthoringPolicy.network,
				environmentAllowlist: [...options.toolAuthoringPolicy.environmentAllowlist],
			}
			: null;
		this.tryHistory = (options.tryHistory ?? []).slice(-32).map((entry) => ({ ...entry }));
		this.grantHistory = (options.grantHistory ?? []).map((event) => WorkshopGrantAuditEventSchema.parse(event));
		if (this.grantHistory.some((event) => event.workshopId !== this.workshopId)) {
			throw new ToolWorkshopError("workshop grant history belongs to a different workshop");
		}
		if (new Set(this.grantHistory.map((event) => event.eventId)).size !== this.grantHistory.length) {
			throw new ToolWorkshopError("workshop grant history contains duplicate events");
		}
		if (this.grantHistory.length > MAX_WORKSHOP_GRANT_AUDIT_EVENTS) {
			throw new ToolWorkshopError(
				`workshop grant history exceeds ${MAX_WORKSHOP_GRANT_AUDIT_EVENTS} events`,
			);
		}
		this.onGrantConsumed = options.onGrantConsumed;
	}

	get open(): boolean {
		return !this.disposed;
	}

	private assertOpen(): void {
		if (this.disposed) throw new ToolWorkshopError(`workshop ${this.workshopId} is closed`);
	}

	// -- reading -------------------------------------------------------------

	read(requested: string): WorkshopReadResult {
		this.assertOpen();
		const absolute = resolveWorkshopPath(this.path, requested);
		if (!existsSync(absolute)) throw new ToolWorkshopError(`the workshop has no ${requested}`);
		const info = lstatSync(absolute);
		if (info.isDirectory()) {
			const entries: WorkshopEntry[] = [];
			let truncated = false;
			for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
				if (entries.length >= MAX_WORKSHOP_LISTING) {
					truncated = true;
					break;
				}
				const child = join(absolute, entry.name);
				const childInfo = lstatSync(child);
				if (childInfo.isSymbolicLink()) {
					throw new BuilderWorkshopScopeError([`${requested}/${entry.name}`], "the workshop contains a symlink");
				}
				entries.push({
					path: `${requested}/${entry.name}`,
					kind: childInfo.isDirectory() ? "directory" : "file",
					mode: childInfo.isDirectory() ? null : (childInfo.mode & 0o111) === 0 ? "100644" : "100755",
					bytes: childInfo.isDirectory() ? null : childInfo.size,
				});
			}
			return {
				path: requested,
				kind: "directory",
				mode: null,
				bytes: null,
				sha256: null,
				content: null,
				entries,
				entriesTruncated: truncated,
			};
		}
		if (info.size > MAX_WORKSHOP_FILE_BYTES) {
			throw new ToolWorkshopError(`${requested} exceeds the ${MAX_WORKSHOP_FILE_BYTES}-byte workshop limit`);
		}
		const raw = readFileSync(absolute);
		return {
			path: requested,
			kind: "file",
			mode: (info.mode & 0o111) === 0 ? "100644" : "100755",
			bytes: raw.byteLength,
			sha256: workshopSha256(raw),
			content: workshopText(raw, requested),
			entries: null,
			entriesTruncated: false,
		};
	}

	// -- writing -------------------------------------------------------------

	write(request: WorkshopWriteRequest): WorkshopWriteResult {
		this.assertOpen();
		if (this.writes >= MAX_WORKSHOP_WRITES) {
			throw new ToolWorkshopError(`a workshop performs at most ${MAX_WORKSHOP_WRITES} writes`);
		}
		const forms = [
			request.content !== undefined,
			request.oldText !== undefined || request.newText !== undefined,
			request.remove === true,
		].filter(Boolean).length;
		if (forms !== 1) {
			throw new ToolWorkshopError("a workshop write is exactly one of content, oldText+newText, or remove");
		}
		const absolute = resolveWorkshopPath(this.path, request.path);
		const existed = existsSync(absolute);
		if (existed && lstatSync(absolute).isDirectory()) {
			throw new BuilderWorkshopScopeError([request.path], "a workshop write targets a file, not a directory");
		}

		if (request.remove === true) {
			if (!existed) throw new ToolWorkshopError(`cannot remove ${request.path}: the workshop has no such file`);
			rmSync(absolute);
			this.writes += 1;
			this.written.add(request.path);
			this.removed.add(request.path);
			this.syncDeclarations();
			return { path: request.path, action: "removed", mode: null, bytes: null, sha256: null };
		}

		let next: string;
		if (request.content !== undefined) {
			next = request.content;
		} else {
			if (!existed) throw new ToolWorkshopError(`cannot replace text in ${request.path}: the workshop has no such file`);
			if (request.oldText === undefined || request.newText === undefined) {
				throw new ToolWorkshopError("an exact replacement needs both oldText and newText");
			}
			if (request.oldText.length === 0) throw new ToolWorkshopError("oldText must not be empty");
			const current = workshopText(readFileSync(absolute), request.path);
			const first = current.indexOf(request.oldText);
			if (first < 0) throw new ToolWorkshopError(`oldText does not occur in ${request.path}`);
			if (current.indexOf(request.oldText, first + 1) >= 0) {
				throw new ToolWorkshopError(`oldText occurs more than once in ${request.path}; make it unique`);
			}
			next = `${current.slice(0, first)}${request.newText}${current.slice(first + request.oldText.length)}`;
		}
		if (next.includes("\0")) throw new ToolWorkshopError(`${request.path} must not contain NUL bytes`);
		if (next.includes("\r")) throw new ToolWorkshopError(`${request.path} must use LF line endings`);
		const bytes = Buffer.byteLength(next, "utf8");
		if (bytes > MAX_WORKSHOP_FILE_BYTES) {
			throw new ToolWorkshopError(`${request.path} exceeds the ${MAX_WORKSHOP_FILE_BYTES}-byte workshop limit`);
		}
		if (bytes === 0) throw new ToolWorkshopError(`${request.path} must not be empty; remove it instead`);
		const mode = request.mode ?? this.defaultMode(request.path, absolute, existed);
		const before = existed ? readFileSync(absolute) : null;
		const beforeMode = existed ? ((lstatSync(absolute).mode & 0o111) === 0 ? "100644" : "100755") : null;
		mkdirSync(dirname(absolute), { recursive: true, mode: 0o755 });
		writeFileSync(absolute, next, { encoding: "utf8" });
		chmodSync(absolute, mode === "100755" ? 0o755 : 0o644);
		this.writes += 1;
		this.written.add(request.path);
		this.removed.delete(request.path);
		this.syncDeclarations();
		const unchanged = before !== null && beforeMode === mode && before.equals(Buffer.from(next, "utf8"));
		return {
			path: request.path,
			action: unchanged ? "unchanged" : existed ? "updated" : "created",
			mode,
			bytes,
			sha256: workshopSha256(next),
		};
	}

	/** `bin/<tool>` and `tools/<tool>/run` are executables; everything else is not. */
	private defaultMode(requested: string, absolute: string, existed: boolean): "100644" | "100755" {
		if (existed) return (lstatSync(absolute).mode & 0o111) === 0 ? "100644" : "100755";
		return classifyTargetAuthoringResourcePath(requested)?.kind === "tool-executable" ? "100755" : "100644";
	}

	/**
	 * Apply only the execution widening compiled by the typed Tool Authoring
	 * module. Builder Pi cannot call this primitive directly and cannot change
	 * sandbox mode, ambient tools, containers, or any model configuration.
	 */
	configureToolAuthoringPolicy(policyValue: {
		network: "deny" | "allow";
		environmentAllowlist: readonly string[];
	}): void {
		this.assertOpen();
		const policy = ExecutionPolicyBlock.parse({
			...this.baseManifest.execution,
			network: policyValue.network,
			environmentAllowlist: [...policyValue.environmentAllowlist],
		});
		if (this.baseManifest.execution.network === "allow" && policy.network !== "allow") {
			throw new ToolWorkshopError("typed tool authoring cannot narrow an existing network policy");
		}
		const baseEnvironment = new Set(this.baseManifest.execution.environmentAllowlist);
		for (const name of baseEnvironment) {
			if (!policy.environmentAllowlist.includes(name)) {
				throw new ToolWorkshopError(`typed tool authoring cannot remove existing environment permission ${name}`);
			}
		}
		this.toolAuthoringPolicy = {
			network: policy.network,
			environmentAllowlist: [...policy.environmentAllowlist],
		};
		this.syncDeclarations();
	}

	/**
	 * Replace one complete generated package. Validation happens before the old
	 * directory is removed; a full-package authoring call never leaves stale
	 * fixtures or support files from an earlier attempt in the reviewed diff.
	 */
	replaceToolPackage(
		tool: string,
		files: readonly { path: string; content: string; mode: "100644" | "100755" }[],
	): void {
		this.assertOpen();
		if (!TOOL_NAME.test(tool)) throw new ToolWorkshopError(`invalid tool name: ${JSON.stringify(tool)}`);
		if (files.length === 0) throw new ToolWorkshopError("a generated tool package cannot be empty");
		if (this.writes + files.length + 1 > MAX_WORKSHOP_WRITES) {
			throw new ToolWorkshopError(`a workshop performs at most ${MAX_WORKSHOP_WRITES} writes`);
		}
		const paths = new Set<string>();
		for (const file of files) {
			const requested = `tools/${tool}/${file.path}`;
			assertWorkshopScope(requested);
			if (!requested.startsWith(`tools/${tool}/`) || paths.has(requested)) {
				throw new ToolWorkshopError(`duplicate or escaping generated tool path ${requested}`);
			}
			paths.add(requested);
			if (!file.content || file.content.includes("\0") || file.content.includes("\r")) {
				throw new ToolWorkshopError(`${requested} must be non-empty UTF-8 text with LF line endings`);
			}
			if (Buffer.byteLength(file.content, "utf8") > MAX_WORKSHOP_FILE_BYTES) {
				throw new ToolWorkshopError(`${requested} exceeds the ${MAX_WORKSHOP_FILE_BYTES}-byte workshop limit`);
			}
		}
		const directory = `tools/${tool}`;
		const absolute = resolveWorkshopPath(this.path, directory);
		const old = new Map<string, WorkshopFileState>();
		const symlinks: string[] = [];
		collectWorkshopFiles(this.path, directory, old, symlinks);
		if (symlinks.length > 0) throw new BuilderWorkshopScopeError(symlinks, "a generated tool package contains a symlink");
		// Everything the previous package held is deliberately gone; only what
		// this call writes back is promised to the diff.
		for (const path of old.keys()) {
			this.written.add(path);
			this.removed.add(path);
		}
		rmSync(absolute, { recursive: true, force: true });
		mkdirSync(absolute, { recursive: true, mode: 0o755 });
		for (const file of files) {
			const requested = `tools/${tool}/${file.path}`;
			const destination = resolveWorkshopPath(this.path, requested);
			mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
			writeFileSync(destination, file.content, "utf8");
			chmodSync(destination, file.mode === "100755" ? 0o755 : 0o644);
			this.written.add(requested);
			this.removed.delete(requested);
		}
		this.writes += files.length + 1;
		this.syncDeclarations();
	}

	// -- running -------------------------------------------------------------

	/**
	 * One argv, no shell interpolation, under the **authoring profile**: the
	 * fixed minimal environment (no Target allowlist, no credential of any kind),
	 * the network denied whatever `execution.network` says, `ulimit` caps, a
	 * bounded timeout and bounded output — and, as its filesystem, a private
	 * materialised copy of the authorable projection alone.
	 *
	 * The mount is the point. `evals/**`, `imports/**`, `runs/`, `.git`, `.env`
	 * and `.ahde` are not forbidden by a path check the command could try to
	 * outwit: they are absent. Git runs host-side, against the real worktree,
	 * never inside this.
	 *
	 * The sandbox itself is not optional here. `execution.sandbox` describes the
	 * Target's own shell and can never widen what Builder Pi may reach, so a host
	 * without a usable backend refuses the command instead of running it bare.
	 */
	async bash(request: WorkshopBashRequest): Promise<WorkshopBashResult> {
		this.assertOpen();
		if (this.commands >= MAX_WORKSHOP_COMMANDS) {
			throw new ToolWorkshopError(`a workshop runs at most ${MAX_WORKSHOP_COMMANDS} commands`);
		}
		const argv = [...request.argv];
		if (argv.length === 0 || argv.length > MAX_WORKSHOP_ARGV) {
			throw new ToolWorkshopError(`a workshop command has 1..${MAX_WORKSHOP_ARGV} argv entries`);
		}
		for (const value of argv) {
			if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_WORKSHOP_ARGUMENT_BYTES) {
				throw new ToolWorkshopError(`every workshop argv entry is 1..${MAX_WORKSHOP_ARGUMENT_BYTES} bytes of text`);
			}
			if (/[\0\r\n]/.test(value)) throw new ToolWorkshopError("workshop argv entries carry no NUL or line breaks");
		}
		const command = argv[0] as string;
		if (!isAbsolute(command) && !WORKSHOP_COMMAND.test(command)) {
			throw new ToolWorkshopError("argv[0] must be a bare PATH command or an absolute executable path");
		}
		const timeoutMs = request.timeoutMs ?? DEFAULT_WORKSHOP_TIMEOUT_MS;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WORKSHOP_TIMEOUT_MS) {
			throw new ToolWorkshopError(`a workshop command runs for at most ${MAX_WORKSHOP_TIMEOUT_MS}ms`);
		}
		const requestedCwd = request.cwd;
		if (requestedCwd !== undefined) {
			const inWorktree = resolveWorkshopPath(this.path, requestedCwd);
			if (!existsSync(inWorktree) || !statSync(inWorktree).isDirectory()) {
				throw new ToolWorkshopError(`the workshop has no directory ${String(requestedCwd)}`);
			}
		}
		mkdirSync(join(this.scratchRoot, "bash"), { recursive: true, mode: 0o700 });
		const scratchDir = realpathSync(join(this.scratchRoot, "bash"));
		// The command's whole world: the authorable projection, and nothing else.
		const surface = this.materializeAuthoringSurface();
		const cwd = requestedCwd === undefined ? surface : join(surface, requestedCwd);
		if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
			throw new ToolWorkshopError(`the workshop has no directory ${String(requestedCwd)}`);
		}
		const sandboxBackend = detectTargetToolSandbox(surface, scratchDir);
		const { environment, names } = buildAuthoringEnvironment({ label: "workshop", scratchDir });
		// Never `execution.network`: that policy governs reviewed Target code, and
		// pre-review authored code does not inherit it.
		const confinement: TargetToolConfinement = {
			network: "deny",
			readRoots: [],
			writeRoots: this.surfaceWriteRoots(surface),
		};
		const invocation = sandboxInvocation({
			backend: sandboxBackend,
			workspaceDir: surface,
			scratchDir,
			environment,
			confinement,
			cwd,
			argv,
			limits: AUTHORING_RESOURCE_LIMITS,
		});
		this.commands += 1;
		const started = Date.now();
		const child = spawn(invocation.executable, invocation.args, {
			cwd,
			detached: process.platform !== "win32",
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let bytes = 0;
		let stopped: "overflow" | "timeout" | "aborted" | null = null;
		const kill = (): void => {
			try {
				if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
				else if (child.pid) process.kill(child.pid, "SIGKILL");
			} catch {
				// The process already exited.
			}
		};
		const collect = (into: Buffer[]) => (chunk: Buffer): void => {
			bytes += chunk.byteLength;
			if (bytes > MAX_WORKSHOP_OUTPUT_BYTES) {
				stopped ??= "overflow";
				kill();
				return;
			}
			into.push(Buffer.from(chunk));
		};
		child.stdout.on("data", collect(stdout));
		child.stderr.on("data", collect(stderr));
		const abort = (): void => {
			stopped ??= "aborted";
			kill();
		};
		request.signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => {
			stopped ??= "timeout";
			kill();
		}, timeoutMs);
		try {
			let exitCode: number | null;
			try {
				exitCode = await new Promise<number | null>((settle, reject) => {
					child.once("error", reject);
					child.once("close", settle);
				});
			} finally {
				if (stopped) invocation.terminate?.();
			}
			if (stopped === "aborted") throw new ToolWorkshopError("the workshop command was aborted");
			const outText = boundedOutput(Buffer.concat(stdout).toString("utf8"));
			const errText = boundedOutput(Buffer.concat(stderr).toString("utf8"));
			// Whatever the command wrote lands back in the worktree, scope-checked
			// path by path; a symlink or an irregular file refuses the whole sync.
			this.absorbAuthoringSurface(surface);
			// A command that touched the Harness may have changed what is declared.
			this.syncDeclarations();
			return {
				argv,
				cwd: requestedCwd ?? ".",
				sandbox: sandboxBackend,
				network: confinement.network,
				environment: names,
				mounted: BUILDER_WORKSHOP_MOUNTED_PATHS,
				limits: invocation.limits,
				note: resourceLimitNote(invocation.limits),
				exitCode,
				durationMs: Date.now() - started,
				stdout: outText.text,
				stderr: errText.text,
				truncated: stopped === "overflow" || outText.truncated || errText.truncated,
				timedOut: stopped === "timeout",
			};
		} finally {
			clearTimeout(timer);
			request.signal?.removeEventListener("abort", abort);
			invocation.dispose?.();
			rmSync(surface, { recursive: true, force: true });
		}
	}

	// -- the mounted authoring surface ---------------------------------------

	/**
	 * A private copy of exactly the authorable projection — `AGENTS.md`, the four
	 * scope directories, and the host-rendered `manifest.yaml` — and nothing
	 * else. This is what the model's own code gets as its filesystem.
	 */
	private materializeAuthoringSurface(): string {
		const surface = join(this.scratchRoot, "surface");
		rmSync(surface, { recursive: true, force: true });
		mkdirSync(surface, { recursive: true, mode: 0o700 });
		const files = this.walkAuthoringScope();
		if (files.symlinks.length > 0) {
			throw new BuilderWorkshopScopeError(files.symlinks, "the workshop contains a symlink");
		}
		for (const file of files.entries.values()) {
			// manifest.yaml contains host-owned model/evaluator configuration and
			// credential variable names. It participates in the host-side snapshot
			// and compiled diff, but authored code gets only authorable resources.
			if (file.path === WORKSHOP_MANIFEST) continue;
			const destination = join(surface, file.path);
			mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
			writeFileSync(destination, file.content);
			chmodSync(destination, file.mode === "100755" ? 0o755 : 0o644);
		}
		// The scope directories exist even when empty, so a command can write into
		// them without first guessing that it has to create them.
		for (const name of WORKSHOP_SCOPE_DIRECTORIES) {
			mkdirSync(join(surface, name), { recursive: true, mode: 0o755 });
		}
		// The OS sandbox profiles name real paths; a `/var` → `/private/var`
		// symlink between them would deny every read the command makes.
		return realpathSync(surface);
	}

	/** Every directory of the mounted surface the sandbox may write into. */
	private surfaceWriteRoots(surface: string): string[] {
		const roots = WORKSHOP_SCOPE_DIRECTORIES.map((name) => join(surface, name));
		const instructions = join(surface, "AGENTS.md");
		if (existsSync(instructions) && lstatSync(instructions).isFile()) roots.push(instructions);
		return roots;
	}

	/**
	 * Fold what the command produced back into the real worktree. Everything is
	 * validated first and written second: one symlink, one oversize file, one
	 * path outside the scope, or two paths that differ only in letter case
	 * refuses the whole sync by name rather than leaving the worktree
	 * half-updated. Removals happen before writes, and the result is read back
	 * and compared: a file the command produced is in the worktree afterwards,
	 * with those exact bytes, or the command result is refused.
	 */
	private absorbAuthoringSurface(surface: string): void {
		const produced = new Map<string, WorkshopFileState>();
		const symlinks: string[] = [];
		const offending: string[] = [];
		for (const root of [...WORKSHOP_SCOPE_DIRECTORIES, "AGENTS.md"]) {
			collectWorkshopFiles(surface, root, produced, symlinks);
		}
		if (symlinks.length > 0) {
			throw new BuilderWorkshopScopeError(symlinks, "a workshop command may not create a symlink");
		}
		for (const [path, file] of produced) {
			if (!inWorkshopScope(path)) offending.push(path);
			else if (file.content.byteLength > MAX_WORKSHOP_FILE_BYTES) offending.push(path);
		}
		if (offending.length > 0) {
			throw new BuilderWorkshopScopeError(
				offending,
				`a workshop command writes only inside ${BUILDER_WORKSHOP_SCOPE.join(", ")}, at most ${MAX_WORKSHOP_FILE_BYTES} bytes per file`,
			);
		}
		// Two produced paths that differ only in case are one file on a
		// case-insensitive filesystem, and absorbing both would keep whichever
		// happened to be written last. Refuse the command result by name.
		const folded = new Map<string, string>();
		const collisions = new Set<string>();
		for (const path of produced.keys()) {
			const first = folded.get(path.toLowerCase());
			if (first === undefined) folded.set(path.toLowerCase(), path);
			else {
				collisions.add(first);
				collisions.add(path);
			}
		}
		if (collisions.size > 0) {
			throw new BuilderWorkshopScopeError(
				[...collisions].sort((left, right) => left.localeCompare(right)),
				"these paths differ only in letter case and cannot both exist in one Harness",
			);
		}
		const before = this.walkAuthoringScope();
		// Removals first. `mv SKILL.md skill.md` produces one path and drops the
		// other, and on a case-insensitive filesystem they are the same file: with
		// the write first, the removal of the old spelling deleted the rename.
		for (const path of before.entries.keys()) {
			if (path === WORKSHOP_MANIFEST || produced.has(path)) continue;
			rmSync(join(this.path, path), { force: true });
		}
		for (const [path, file] of produced) {
			const destination = join(this.path, path);
			mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
			writeFileSync(destination, file.content);
			chmodSync(destination, file.mode === "100755" ? 0o755 : 0o644);
		}
		// The absorb is only believable if the worktree now says exactly what the
		// command produced, path by path. Anything else — a fold the check above
		// did not model, a removal that took a produced file with it — stops here
		// by name rather than silently shrinking the proposal.
		const after = this.walkAuthoringScope();
		for (const [path, file] of produced) {
			const landed = after.entries.get(path);
			if (landed && landed.mode === file.mode && landed.content.equals(file.content)) continue;
			throw new ToolWorkshopError(
				`${path} did not survive the workshop command: the worktree ` +
				`${landed ? "holds different bytes for it" : "has no such file"} afterwards`,
			);
		}
	}

	/** Every in-scope file of the worktree right now, plus the host-owned manifest. */
	private walkAuthoringScope(): { entries: Map<string, WorkshopFileState>; symlinks: string[] } {
		const entries = new Map<string, WorkshopFileState>();
		const symlinks: string[] = [];
		for (const root of [...WORKSHOP_SCOPE_DIRECTORIES, "AGENTS.md", WORKSHOP_MANIFEST]) {
			collectWorkshopFiles(this.path, root, entries, symlinks);
		}
		return { entries, symlinks };
	}

	/**
	 * The exact content identity of everything in scope. Two workshops with the
	 * same hash hold byte-identical Harness surfaces; a restart that re-attaches
	 * to a different hash is refused rather than trusted.
	 */
	snapshotHash(): string {
		const { entries } = this.walkAuthoringScope();
		return workshopSnapshotHash(entries);
	}

	// -- what a try may reach -------------------------------------------------

	/**
	 * What one declared tool of this workshop asks for beyond the authoring
	 * profile. Null when the tool runs entirely inside it, which is the case a
	 * Builder should be writing.
	 */
	describeToolGrant(toolName: string): WorkshopToolGrantRequirement | null {
		this.assertOpen();
		if (!TOOL_NAME.test(toolName)) throw new ToolWorkshopError(`invalid tool name: ${JSON.stringify(toolName)}`);
		this.syncDeclarations();
		const resolved = loadTarget(this.path).tools.find((tool) => tool.descriptor.name === toolName);
		if (!resolved) return null;
		const runtimeNetwork = resolved.descriptor.permissions.network === "allow";
		const setupNetwork = resolved.descriptor.setup?.network === "allow";
		const network = runtimeNetwork || setupNetwork;
		const environment = [...resolved.descriptor.permissions.environment];
		if (!network && environment.length === 0) return null;
		const wants: string[] = [];
		if (setupNetwork) wants.push("network access during setup");
		if (runtimeNetwork) wants.push("network access during tool execution");
		if (environment.length > 0) wants.push(`the ${environment.join(", ")} environment ${environment.length === 1 ? "variable" : "variables"}`);
		return {
			tool: toolName,
			toolDigest: resolved.digest,
			network,
			setupNetwork,
			runtimeNetwork,
			environment,
			wants,
		};
	}

	/** Record the operator's one-question answer. Only a host ever calls this. */
	grantToolAccess(grant: {
		tool: string;
		wants: readonly string[];
		snapshotHash: string;
		actorId: string;
		now: () => string;
	}): WorkshopGrant {
		this.assertOpen();
		const currentRequirement = this.describeToolGrant(grant.tool);
		if (!currentRequirement) {
			throw new ToolWorkshopError(`the requested ${grant.tool} access no longer matches the tool declaration; ask again`);
		}
		const expected = canonicalList([...currentRequirement.wants].sort((left, right) => left.localeCompare(right)));
		const offered = canonicalList([...grant.wants].sort((left, right) => left.localeCompare(right)));
		if (expected !== offered) {
			throw new ToolWorkshopError(`the requested ${grant.tool} access no longer matches the tool declaration; ask again`);
		}
		const current = this.snapshotHash();
		if (current !== grant.snapshotHash) {
			throw new ToolWorkshopError(
				`the workshop changed while ${grant.tool} access was being reviewed (${grant.snapshotHash} → ${current}); ask again`,
			);
		}
		const recorded: WorkshopGrant = {
			tool: grant.tool,
			toolDigest: currentRequirement.toolDigest,
			wants: [...grant.wants],
			snapshotHash: grant.snapshotHash,
			used: false,
			grantedAt: grant.now(),
			actorId: grant.actorId,
		};
		this.grants.push(recorded);
		return recorded;
	}

	toolAccessGranted(requirement: WorkshopToolGrantRequirement, snapshotHash = this.snapshotHash()): boolean {
		this.assertOpen();
		const expected = canonicalList([...requirement.wants].sort((left, right) => left.localeCompare(right)));
		return this.grants.some((grant) =>
			grant.tool === requirement.tool &&
			grant.toolDigest === requirement.toolDigest &&
			grant.snapshotHash === snapshotHash &&
			!grant.used &&
			canonicalList([...grant.wants].sort((left, right) => left.localeCompare(right))) === expected
		);
	}

	private consumeToolAccess(
		requirement: WorkshopToolGrantRequirement,
		snapshotHash: string,
		now: () => string,
	): boolean {
		const expected = canonicalList([...requirement.wants].sort((left, right) => left.localeCompare(right)));
		const index = this.grants.findIndex((candidate) =>
			candidate.tool === requirement.tool &&
			candidate.toolDigest === requirement.toolDigest &&
			candidate.snapshotHash === snapshotHash &&
			!candidate.used &&
			canonicalList([...candidate.wants].sort((left, right) => left.localeCompare(right))) === expected
		);
		if (index < 0) return false;
		const [grant] = this.grants.splice(index, 1);
		if (!grant) return false;
		grant.used = true;
		if (this.grantHistory.length >= MAX_WORKSHOP_GRANT_AUDIT_EVENTS) {
			throw new ToolWorkshopError(
				`workshop ${this.workshopId} reached its ${MAX_WORKSHOP_GRANT_AUDIT_EVENTS}-event grant audit limit`,
			);
		}
		const event = WorkshopGrantAuditEventSchema.parse({
			schemaVersion: 1,
			eventId: `workshop-grant_${randomBytes(12).toString("hex")}`,
			workshopId: this.workshopId,
			tool: grant.tool,
			toolDigest: grant.toolDigest,
			wants: [...grant.wants],
			snapshotHash: grant.snapshotHash,
			used: true,
			grantedAt: grant.grantedAt,
			consumedAt: now(),
			actorId: grant.actorId,
		});
		// Persist before execution. A storage failure consumes the live grant and
		// aborts the try, so neither a crash nor retry can turn audit into authority.
		this.onGrantConsumed?.(event);
		this.grantHistory.push(event);
		return true;
	}

	/**
	 * Run one declared tool of THIS workshop's Harness, exactly as a Target
	 * would — but only inside the authoring profile. A tool whose descriptor or
	 * setup step asks for the network or for a credential is refused until the
	 * operator has allowed it once, and the try reports the exact snapshot it
	 * ran against.
	 */
	async tryTool(options: {
		tool: string;
		input: unknown;
		test?: string;
		signal?: AbortSignal;
		now?: () => string;
	}): Promise<TryToolResult> {
		this.assertOpen();
		if (!TOOL_NAME.test(options.tool)) {
			throw new ToolWorkshopError(`invalid tool name: ${JSON.stringify(options.tool)}`);
		}
		this.syncDeclarations();
		const requirement = this.describeToolGrant(options.tool);
		// Fix what is being tried before anything runs, so the result describes the
		// exact bytes that produced it rather than whatever is on disk afterwards.
		const before = this.walkAuthoringScope();
		const snapshotHash = workshopSnapshotHash(before.entries);
		if (requirement && !this.consumeToolAccess(
			requirement,
			snapshotHash,
			options.now ?? (() => new Date().toISOString()),
		)) {
			throw new BuilderWorkshopGrantRequiredError(requirement.tool, requirement.wants);
		}
		const changedPaths = this.changesFrom(before.entries).map((change) => change.path);
		const target = loadTarget(this.path);
		// `try` gets the same filesystem promise as `bash`: only the authorable
		// projection exists. Loading the Target above is host-side validation; the
		// authored process below never receives the full detached worktree whose
		// tracked files may include product source, notes, evals, or state.
		const surface = this.materializeAuthoringSurface();
		const tryScratch = realpathSync(mkdtempSync(join(this.scratchRoot, "try-")));
		const toolHomeRoot = join(tryScratch, "tool-home");
		mkdirSync(toolHomeRoot, { recursive: true, mode: 0o700 });
		this.tries += 1;
		let result: TryToolResult;
		try {
			result = await runDeclaredToolOnSurface({
				target,
				directory: surface,
				toolHomeRoot: realpathSync(toolHomeRoot),
				scratchRoot: tryScratch,
				tool: options.tool,
				input: options.input,
				source: { kind: "workshop", ref: null, changedPaths, snapshotHash },
				resourceLimits: AUTHORING_RESOURCE_LIMITS,
				...(options.signal ? { signal: options.signal } : {}),
			});
		} finally {
			rmSync(surface, { recursive: true, force: true });
			rmSync(tryScratch, { recursive: true, force: true });
		}
		const after = workshopSnapshotHash(this.walkAuthoringScope().entries);
		if (after !== snapshotHash) {
			throw new ToolWorkshopError(
				"the workshop changed while the tool was running; the result would not describe the code that ran",
			);
		}
		const failure = result.timedOut
			? "timed out"
			: result.truncated
				? "output was truncated"
				: result.exitCode === 0
					? null
					: (result.stderr.trim().split("\n")[0] || `exit ${result.exitCode ?? "killed"}`).slice(0, 240);
		this.tryHistory.push({
			tool: result.tool,
			test: options.test ?? null,
			passed: failure === null,
			exitCode: result.exitCode,
			timedOut: result.timedOut,
			truncated: result.truncated,
			durationMs: result.durationMs,
			failure,
			snapshotHash,
			at: (options.now ?? (() => new Date().toISOString()))(),
		});
		if (this.tryHistory.length > 32) this.tryHistory.splice(0, this.tryHistory.length - 32);
		return result;
	}

	/** The declared contract fixtures of one tool of this workshop's own copy. */
	fixturesFor(tool: string): ToolContractFixture[] {
		this.assertOpen();
		this.syncDeclarations();
		return readToolFixtures(this.path, tool);
	}

	/**
	 * Run every fixture of one tool against the exact bytes now in the workshop.
	 * Each fixture is a real invocation through the same broker a Target uses, so
	 * a green run means the package works, not that it parses.
	 */
	async tryFixtures(options: {
		tool: string;
		signal?: AbortSignal;
		now?: () => string;
		/** Called before each invocation, so a caller can re-grant declared authority. */
		beforeEach?: (fixture: ToolContractFixture) => void;
	}): Promise<ToolFixtureRunResult> {
		this.assertOpen();
		const fixtures = this.fixturesFor(options.tool);
		if (fixtures.length === 0) {
			throw new ToolWorkshopError(
				`tools/${options.tool} declares no contract fixtures; write tools/${options.tool}/fixtures/<name>.json first`,
			);
		}
		const schema = toolOutputSchema(this.path, loadTarget(this.path), options.tool);
		const outcomes: ToolFixtureOutcome[] = [];
		for (const fixture of fixtures) {
			options.beforeEach?.(fixture);
			const result = await this.tryTool({
				tool: options.tool,
				input: fixture.input,
				test: fixture.name,
				...(options.now ? { now: options.now } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			});
			const outcome = fixtureOutcome(fixture, result, schema);
			this.recordContractAssertion(outcome.name, outcome.passed, outcome.failures);
			outcomes.push(outcome);
		}
		return summarizeFixtures(options.tool, outcomes);
	}

	/** Attach the host's deterministic fixture assertion to the most recent try. */
	recordContractAssertion(test: string, passed: boolean, failures: readonly string[]): void {
		this.assertOpen();
		const recent = this.tryHistory.at(-1);
		if (!recent) throw new ToolWorkshopError("there is no tool try to attach a contract assertion to");
		recent.test = test;
		// A non-zero process result is a failed ad-hoc try, but may be the exact
		// expected result of an error-handling contract fixture. The host assertion
		// is authoritative once it has checked exit code and bounded output.
		recent.passed = passed;
		recent.failure = passed
			? null
			: failures.join("; ").slice(0, 240) || "contract assertion failed";
	}

	/** Record a host/runtime refusal that happened before a TryToolResult existed. */
	recordFailedTry(tool: string, test: string | null, error: unknown, now: () => string): void {
		this.assertOpen();
		const message = redactTraceText(error instanceof Error ? error.message : String(error)).slice(0, 240);
		this.tryHistory.push({
			tool,
			test,
			passed: false,
			exitCode: null,
			timedOut: false,
			truncated: false,
			durationMs: 0,
			failure: message || "tool try failed before execution",
			snapshotHash: this.snapshotHash(),
			at: now(),
		});
		if (this.tryHistory.length > 32) this.tryHistory.splice(0, this.tryHistory.length - 32);
	}

	// -- declarations --------------------------------------------------------

	/**
	 * `manifest.yaml` is host-owned. The Builder writes files; the host keeps the
	 * declared `skills`, `tools`, and `data` lists exactly equal to what those
	 * files are, so the workshop's Harness always loads and no hand-edited
	 * manifest can survive into a proposal.
	 */
	private syncDeclarations(): void {
		const skills = this.declaredSkills();
		const tools = this.declaredTools();
		const data = this.declaredData();
		const changedSkills = canonicalList(skills) !== canonicalList(this.baseManifest.skills);
		const changedTools = canonicalList(tools) !== canonicalList(this.baseManifest.tools);
		const changedData = canonicalList(data) !== canonicalList(this.baseManifest.data);
		const execution = this.toolAuthoringPolicy
			? ExecutionPolicyBlock.parse({
				...this.baseManifest.execution,
				network: this.toolAuthoringPolicy.network,
				environmentAllowlist: this.toolAuthoringPolicy.environmentAllowlist,
			})
			: null;
		const executionPatch: HarnessExecutionPolicyPatch | null = execution
			? {
				...(execution.network === this.baseManifest.execution.network ? {} : { network: execution.network }),
				...(canonicalList(execution.environmentAllowlist) === canonicalList(this.baseManifest.execution.environmentAllowlist)
					? {}
					: { environmentAllowlist: execution.environmentAllowlist }),
			}
			: null;
		const rendered = changedSkills || changedTools || changedData || executionPatch
			? renderManifest(this.baseManifestText, this.baseManifest, {
				...(changedSkills ? { skills } : {}),
				...(changedTools ? { tools } : {}),
				...(changedData ? { data } : {}),
				...(execution && executionPatch && Object.keys(executionPatch).length > 0
					? { execution: { policy: execution, patch: executionPatch } }
					: {}),
			})
			: this.baseManifestText;
		const path = join(this.path, WORKSHOP_MANIFEST);
		const current = existsSync(path) && lstatSync(path).isFile() ? readFileSync(path, "utf8") : null;
		if (current === rendered) return;
		writeFileSync(path, rendered, { encoding: "utf8" });
		chmodSync(path, 0o644);
	}

	/** Base order first, so an unrelated declaration never moves in the diff. */
	private mergeDeclarations(base: readonly string[], present: readonly string[]): string[] {
		const alive = new Set(present);
		const kept = base.filter((declaration) => alive.has(declaration));
		const added = present
			.filter((declaration) => !base.includes(declaration))
			.sort((left, right) => left.localeCompare(right));
		return [...kept, ...added];
	}

	private directoryNames(relativePath: string): string[] {
		const absolute = join(this.path, relativePath);
		if (!existsSync(absolute) || !lstatSync(absolute).isDirectory()) return [];
		return readdirSync(absolute, { withFileTypes: true })
			.filter((entry) => !entry.isSymbolicLink())
			.map((entry) => entry.name)
			.sort((left, right) => left.localeCompare(right));
	}

	private declaredSkills(): string[] {
		const present: string[] = [];
		for (const name of this.directoryNames("skills")) {
			const skill = join(this.path, "skills", name, "SKILL.md");
			if (existsSync(skill) && lstatSync(skill).isFile()) present.push(`skills/${name}`);
		}
		if (present.length > TARGET_AUTHORING_LIMITS.maxSkills) {
			throw new ToolWorkshopError(`a Harness declares at most ${TARGET_AUTHORING_LIMITS.maxSkills} skills`);
		}
		return this.mergeDeclarations(this.baseManifest.skills, present);
	}

	private declaredTools(): string[] {
		const present: string[] = [];
		for (const name of this.directoryNames("tools")) {
			const absolute = join(this.path, "tools", name);
			const info = lstatSync(absolute);
			if (info.isDirectory()) {
				const descriptor = join(absolute, "tool.yaml");
				if (existsSync(descriptor) && lstatSync(descriptor).isFile()) present.push(`tools/${name}/tool.yaml`);
				continue;
			}
			if (info.isFile() && name.endsWith(".tool.yaml")) present.push(`tools/${name}`);
		}
		if (present.length > TARGET_AUTHORING_LIMITS.maxTools) {
			throw new ToolWorkshopError(`a Harness declares at most ${TARGET_AUTHORING_LIMITS.maxTools} tools`);
		}
		return this.mergeDeclarations(this.baseManifest.tools, present);
	}

	private declaredData(): string[] {
		const present: string[] = [];
		for (const name of this.directoryNames("data")) {
			const absolute = join(this.path, "data", name);
			if (!lstatSync(absolute).isDirectory()) continue;
			if (this.holdsFile(absolute, 0)) present.push(`data/${name}`);
		}
		return this.mergeDeclarations(this.baseManifest.data, present);
	}

	private holdsFile(absolute: string, depth: number): boolean {
		if (depth > 16) return false;
		for (const entry of readdirSync(absolute, { withFileTypes: true })) {
			const child = join(absolute, entry.name);
			if (lstatSync(child).isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (this.holdsFile(child, depth + 1)) return true;
				continue;
			}
			if (entry.isFile()) return true;
		}
		return false;
	}

	// -- the diff ------------------------------------------------------------

	/** Everything this workshop changed against its baseline commit. */
	changes(): WorkshopChange[] {
		this.assertOpen();
		return this.changesFrom(this.walkAuthoringScope().entries);
	}

	/**
	 * The diff of one exact snapshot against the baseline commit. It never reads
	 * the disk again, so what a close compiles is what a close was handed.
	 */
	private changesFrom(entries: ReadonlyMap<string, WorkshopFileState>): WorkshopChange[] {
		const paths = new Set<string>([...entries.keys(), ...this.baseScopePaths()]);
		const changes: WorkshopChange[] = [];
		for (const path of [...paths].sort((left, right) => left.localeCompare(right))) {
			const present = entries.get(path);
			const base = baseBlobAt(this.repositoryDir, this.baseTargetSha, path);
			if (!present && !base) continue;
			if (present && base && base.mode === present.mode && base.content.equals(present.content)) continue;
			changes.push({
				path,
				status: !present ? "removed" : base ? "modified" : "added",
				bytes: present ? present.content.byteLength : null,
			});
		}
		return changes;
	}

	/** Every path the baseline commit holds inside the workshop's own scope. */
	private baseScopePaths(): string[] {
		const raw = gitWorkshopRaw(
			this.repositoryDir,
			["ls-tree", "-r", "-z", "--name-only", this.baseTargetSha],
		);
		return raw.split("\0")
			.filter(Boolean)
			.filter((path) => path === WORKSHOP_MANIFEST || inWorkshopScope(path));
	}

	/**
	 * Paths inside the scope that Git ignores. A file the model created, ran, and
	 * that would then vanish silently from the reviewed diff is exactly the case
	 * to stop on, so `changes()` cannot see them and `compile()` refuses on them.
	 */
	ignoredInScope(): string[] {
		this.assertOpen();
		const ignored: string[] = [];
		// `git status --ignored` collapses a wholly-ignored directory into one
		// entry, which would name `tools/x/node_modules/` instead of the file the
		// Builder actually created. `ls-files` enumerates them one by one.
		const listed = gitWorkshopRaw(this.path, [
			"ls-files",
			"-z",
			"--others",
			"--ignored",
			"--exclude-standard",
		]);
		for (const path of listed.split("\0").filter(Boolean)) {
			if (inWorkshopScope(path)) ignored.push(path);
		}
		const status = gitWorkshopRaw(this.path, [
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
			"--no-renames",
			"--ignored=matching",
		]);
		for (const record of status.split("\0").filter((entry) => entry.length > 3)) {
			if (record.slice(0, 2) !== "!!") continue;
			const path = record.slice(3);
			// A collapsed directory still names something real; report its files.
			if (path.endsWith("/")) {
				const inside = new Map<string, WorkshopFileState>();
				collectWorkshopFiles(this.path, path.slice(0, -1), inside, []);
				for (const child of inside.keys()) {
					if (inWorkshopScope(child)) ignored.push(child);
				}
				continue;
			}
			if (inWorkshopScope(path)) ignored.push(path);
		}
		return [...new Set(ignored)].sort((left, right) => left.localeCompare(right));
	}

	/** Capabilities of tools whose package bytes differ from the base revision. */
	toolCapabilities(): WorkshopToolCapabilitySummary[] {
		this.assertOpen();
		this.syncDeclarations();
		const changed = new Set(this.changes().map((entry) => entry.path));
		let tools: ResolvedTarget["tools"];
		try {
			tools = loadTarget(this.path).tools;
		} catch {
			// A half-written manual package is legal while the Builder is repairing
			// it. Close and try still fail loudly; status remains inspectable.
			return [];
		}
		return tools
			.filter((tool) => {
				const prefix = tool.directoryPath ? `${tool.directoryPath}/` : null;
				return changed.has(tool.descriptorPath) || changed.has(tool.executablePath) ||
					(prefix !== null && [...changed].some((path) => path.startsWith(prefix)));
			})
			.map((tool) => ({
				tool: tool.descriptor.name,
				network: tool.descriptor.permissions.network,
				filesystem: tool.descriptor.permissions.filesystem,
				process: "sandboxed-subprocess" as const,
				environment: [...tool.descriptor.permissions.environment],
			}));
	}

	/**
	 * A typed package carries an executable contract manifest. Closing is allowed
	 * only after every listed fixture passed against the exact bytes being
	 * proposed. Manual tools without that manifest keep the legacy one-green-try
	 * workflow; packages created by Tool Authoring cannot silently skip tests.
	 */
	private assertToolContractsPassed(
		snapshot: ReadonlyMap<string, WorkshopFileState>,
		changes: readonly WorkshopChange[],
		resulting: ResolvedTarget,
	): void {
		const snapshotHash = workshopSnapshotHash(snapshot);
		const changed = new Set(changes.map((change) => change.path));
		for (const tool of resulting.tools) {
			if (!tool.directoryPath) continue;
			const prefix = `${tool.directoryPath}/`;
			if (![...changed].some((path) => path.startsWith(prefix))) continue;
			const manifestPath = `${tool.directoryPath}/contract-tests.json`;
			const entry = snapshot.get(manifestPath);
			if (!entry) continue;
			let manifest: z.infer<typeof WorkshopContractManifestSchema>;
			try {
				manifest = WorkshopContractManifestSchema.parse(JSON.parse(workshopText(entry.content, manifestPath)));
			} catch (error) {
				throw new ToolWorkshopError(`${manifestPath} is not a valid AHDE contract-test manifest`, { cause: error });
			}
			if (manifest.tool !== tool.descriptor.name) {
				throw new ToolWorkshopError(`${manifestPath} names ${manifest.tool}, not ${tool.descriptor.name}`);
			}
			const expected = manifest.fixtures.map((path) => {
				const fixturePath = `${tool.directoryPath}/${path}`;
				if (!snapshot.has(fixturePath)) {
					throw new ToolWorkshopError(`${manifestPath} refers to missing ${fixturePath}`);
				}
				return WORKSHOP_CONTRACT_FIXTURE.exec(path)![1]!;
			});
			const passed = new Set(this.tryHistory
				.filter((item) => item.tool === tool.descriptor.name && item.snapshotHash === snapshotHash && item.passed)
				.map((item) => item.test)
				.filter((name): name is string => name !== null));
			const missing = expected.filter((name) => !passed.has(name));
			if (missing.length > 0) {
				throw new ToolWorkshopError(
					`${tool.descriptor.name} is not ready to close: contract tests not green on the exact proposal snapshot: ${missing.join(", ")}`,
				);
			}
		}
	}

	status(): WorkshopStatus {
		const grants = [
			...this.grantHistory.map((event) => ({ ...event, wants: [...event.wants] })),
			...this.grants.map((grant) => ({ ...grant, wants: [...grant.wants] })),
		];
		return {
			workshopId: this.workshopId,
			target: { id: this.targetId, gitSha: this.baseTargetSha },
			basis: this.basis,
			openedAt: this.openedAt,
			writes: this.writes,
			commands: this.commands,
			tries: this.tries,
			changes: this.disposed ? [] : this.changes(),
			scope: BUILDER_WORKSHOP_SCOPE,
			snapshotHash: this.disposed ? "" : this.snapshotHash(),
			grants,
			tryHistory: this.tryHistory.map((entry) => ({ ...entry })),
			toolCapabilities: this.disposed ? [] : this.toolCapabilities(),
		};
	}

	/** Everything a restart needs to find this exact workshop again. */
	describe(): BuilderWorkshopDescriptor {
		this.assertOpen();
		return {
			schemaVersion: 1,
			workshopId: this.workshopId,
			targetId: this.targetId,
			baseTargetSha: this.baseTargetSha,
			basis: this.basis,
			approvedSpecId: this.approvedSpecId,
			source: this.source === null ? null : { ...this.source },
			fromProposalRunId: this.fromProposalRunId,
			worktreePath: this.path,
			scratchRoot: this.scratchRoot,
			openedAt: this.openedAt,
			snapshotHash: this.snapshotHash(),
			...(this.toolAuthoringPolicy
				? {
					toolAuthoringPolicy: {
						network: this.toolAuthoringPolicy.network,
						environmentAllowlist: [...this.toolAuthoringPolicy.environmentAllowlist],
					},
				}
				: {}),
			tryHistory: this.tryHistory.map((entry) => ({ ...entry })),
		};
	}

	/**
	 * Compile the exact proposal from what is on disk. This is the whole point of
	 * the workshop: the reviewed diff is the diff of code the Builder actually
	 * ran, not a restatement of what it meant to write.
	 */
	compile(metadata: {
		summary: string;
		diagnoses?: CandidateProposal["diagnoses"];
		risks?: CandidateProposal["risks"];
		validationPlan?: CandidateProposal["validationPlan"];
		/** The falsifiable promise the next verification is read against. */
		prediction?: ProposalPredictionInput | null;
	}): CompiledWorkshopProposal {
		this.assertOpen();
		this.assertBaselineUnmoved();
		this.syncDeclarations();
		// One read of the whole surface, before anything is derived from it. Every
		// path, mode, byte and diff below comes from this exact snapshot, so there
		// is no window in which a late write changes what the human reviews.
		const snapshot = this.walkAuthoringScope();
		if (snapshot.symlinks.length > 0) {
			throw new BuilderWorkshopScopeError(snapshot.symlinks, "the workshop contains a symlink");
		}
		const changes = this.changesFrom(snapshot.entries);
		// The snapshot only ever holds the scope, so anything Git sees moving
		// outside it got there some other way. It still stops the close by name.
		const offending = [
			...changes.map((change) => change.path),
			...this.dirtyOutsideScope(),
		].filter((path) => path !== WORKSHOP_MANIFEST && !inWorkshopScope(path));
		if (offending.length > 0) {
			throw new BuilderWorkshopScopeError(
				offending,
				`a proposal may change only ${BUILDER_WORKSHOP_SCOPE.join(", ")} and the manifest's declared resource lists`,
			);
		}
		// Nothing inside the scope may vanish from the diff behind a .gitignore —
		// whether the model wrote it with a tool or a command produced it.
		const ignored = this.ignoredInScope();
		if (ignored.length > 0) {
			throw new BuilderWorkshopScopeError(
				ignored,
				"Git ignores these paths, so they can never reach a reviewed proposal",
			);
		}
		// And nothing the Builder wrote leaves the proposal quietly: a file it
		// created that is gone now, with no removal in the diff, is a promise the
		// summary still makes and the candidate does not keep.
		const swallowed = this.swallowedWrites(snapshot.entries);
		if (swallowed.length > 0) {
			throw new BuilderWorkshopScopeError(
				swallowed,
				"the workshop wrote these paths and the diff does not carry them; " +
				"write them again, or remove them explicitly so the removal is reviewable",
			);
		}
		if (changes.length === 0) throw new BuilderWorkshopEmptyError();
		if (changes.length > MAX_WORKSHOP_CHANGES) {
			throw new ToolWorkshopError(`a reviewable proposal carries at most ${MAX_WORKSHOP_CHANGES} changed files`);
		}

		// The resulting Harness must load and must stay readable by its Builder.
		const resulting = loadTarget(this.path);
		this.assertResultingHarnessReadable(resulting);
		this.assertToolContractsPassed(snapshot.entries, changes, resulting);
		if (changes.some((change) => change.path === WORKSHOP_MANIFEST)) {
			if (this.toolAuthoringPolicy) {
				assertManifestChangePolicy(this.baseManifest, TargetManifest.parse(resulting.manifest), "execution-policy");
			} else {
				assertResourceOnlyManifestChange(this.baseManifest, TargetManifest.parse(resulting.manifest));
			}
		}

		const evidenceRefs = [...new Set((metadata.diagnoses ?? []).flatMap((diagnosis) => diagnosis.evidence))];
		const compiled = changes.map((change) => {
			const base = baseBlobAt(this.repositoryDir, this.baseTargetSha, change.path);
			const file = snapshot.entries.get(change.path) ?? null;
			if (file && file.content.byteLength > MAX_WORKSHOP_FILE_BYTES) {
				throw new ToolWorkshopError(`${change.path} exceeds the ${MAX_WORKSHOP_FILE_BYTES}-byte proposal limit`);
			}
			const after = file === null ? null : workshopText(file.content, change.path);
			const afterMode = file === null ? null : file.mode;
			return {
				path: change.path,
				baseSha256: workshopSha256(base?.content ?? Buffer.alloc(0)),
				unifiedDiff: wholeFileDiff({ path: change.path, before: base, after, afterMode }),
				rationale: `${change.status === "added" ? "Add" : change.status === "removed" ? "Remove" : "Change"} ${change.path} in the Builder workshop`,
				evidenceRefs,
			};
		});

		const grants = this.status().grants;
		const proposal = CandidateProposalSchema.parse({
			schemaVersion: CANDIDATE_PROPOSAL_SCHEMA_VERSION,
			decision: "propose",
			prediction: metadata.prediction ?? null,
			baseTargetSha: this.baseTargetSha,
			summary: metadata.summary,
			diagnoses: metadata.diagnoses ?? [],
			changes: compiled,
			// A host-granted exception is part of the change's risk, so it travels
			// with the artifact into every screen that renders the proposal.
			risks: [
				...(metadata.risks ?? []),
				...grants.map(grantRisk),
				...(grants.length > 0 && !grants.some((grant) =>
					grant.used && grant.snapshotHash === workshopSnapshotHash(snapshot.entries))
					? ["The exact proposal snapshot was not tried after its latest authored change with a reviewed capability exception."]
					: []),
			],
			validationPlan: metadata.validationPlan ?? [],
		});
		validateCandidateProposal(proposal, {
			baseTargetSha: this.baseTargetSha,
			allowedPaths: [...HARNESS_AUTHORING_ALLOWED_PATHS],
		});
		const patch = `${proposal.changes.map((change) => change.unifiedDiff.trimEnd()).join("\n")}\n`;
		gitWorkshop(this.repositoryDir, ["apply", "--check", "--index", "-"], patch);
		return {
			proposal,
			changes,
			baseTargetSha: this.baseTargetSha,
			manifestChangePolicy: this.toolAuthoringPolicy ? "execution-policy" : "resources-only",
		};
	}

	/** Anything Git sees changed in the worktree that the Harness scope does not cover. */
	private dirtyOutsideScope(): string[] {
		const raw = gitWorkshopRaw(this.path, [
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
			"--no-renames",
		]);
		const paths = new Set<string>();
		for (const record of raw.split("\0").filter((entry) => entry.length > 3)) {
			const path = record.slice(3);
			if (path !== WORKSHOP_MANIFEST && !inWorkshopScope(path)) paths.add(path);
		}
		return [...paths].sort((left, right) => left.localeCompare(right));
	}

	/**
	 * Paths the Builder wrote that the reviewed diff will not carry. A
	 * `.gitignore` can swallow one; so can a command that deleted it without
	 * leaving a visible change, which is how a whole authored skill once left a
	 * proposal whose summary still promised it. A file leaves only through an
	 * explicit removal or through this refusal, by name.
	 */
	private swallowedWrites(entries: ReadonlyMap<string, WorkshopFileState>): string[] {
		const visible = new Set(this.changesFrom(entries).map((change) => change.path));
		return [...this.written]
			.filter((path) => {
				if (visible.has(path)) return false;
				const present = entries.get(path);
				if (!present) return !this.removed.has(path);
				const base = baseBlobAt(this.repositoryDir, this.baseTargetSha, path);
				return !base || !base.content.equals(present.content);
			})
			.sort((left, right) => left.localeCompare(right));
	}

	/** The workshop only ever compiles against the exact revision it copied. */
	private assertBaselineUnmoved(): void {
		if (gitWorkshop(this.repositoryDir, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
			throw new ToolWorkshopError(
				"the Target checkout has uncommitted changes; a workshop compiles only against a clean revision",
			);
		}
		const head = gitWorkshop(this.repositoryDir, ["rev-parse", "--verify", "HEAD^{commit}"]);
		if (head !== this.baseTargetSha) {
			throw new ToolWorkshopError("the Target moved while the workshop was open; discard it and open a new one");
		}
	}

	/** Invariant 30's closure check, over the Harness this proposal would create. */
	private assertResultingHarnessReadable(resulting: ResolvedTarget): void {
		const resources: TargetAuthoringResource[] = [];
		const add = (path: string): void => {
			const identity = classifyTargetAuthoringResourcePath(path);
			if (!identity) {
				throw new ToolWorkshopError(
					`the resulting Harness declares a noncanonical resource: ${path} — ` +
					explainTargetAuthoringResourcePath(path),
				);
			}
			const info = lstatSync(join(this.path, path));
			resources.push({
				kind: identity.kind,
				name: identity.name,
				path,
				mode: (info.mode & 0o111) === 0 ? "100644" : "100755",
				bytes: info.size,
				sha256: workshopSha256(readFileSync(join(this.path, path))),
			});
		};
		add("AGENTS.md");
		for (const skill of resulting.manifest.skills) add(`${skill}/SKILL.md`);
		for (const tool of resulting.tools) {
			if (tool.layout === "single-file") {
				add(tool.descriptorPath);
				add(tool.executablePath);
				continue;
			}
			for (const file of tool.files) add(`${tool.directoryPath as string}/${file.path}`);
		}
		assertTargetAuthoringSurfaceWithinLimits({
			manifestBytes: statSync(join(this.path, WORKSHOP_MANIFEST)).size,
			skillCount: resulting.manifest.skills.length,
			tools: resulting.tools.map((tool) => ({
				name: tool.descriptor.name,
				layout: tool.layout,
				fileCount: tool.layout === "directory" ? tool.files.length : 0,
			})),
			data: resulting.data,
			target: {
				id: resulting.manifest.id,
				gitSha: this.baseTargetSha,
				model: {
					provider: resulting.manifest.model.provider,
					id: resulting.manifest.model.id,
					thinkingLevel: resulting.manifest.model.thinkingLevel,
				},
				execution: {
					tools: [...resulting.manifest.execution.tools],
					environmentAllowlist: [...resulting.manifest.execution.environmentAllowlist],
					network: resulting.manifest.execution.network,
					sandbox: resulting.manifest.execution.sandbox,
				},
			},
			resources,
		});
	}

	/**
	 * End one Builder process without abandoning its work. The exact descriptor
	 * and detached worktree survive; live grants and runtime scratch do not.
	 */
	suspend(): void {
		this.assertOpen();
		this.grants.splice(0, this.grants.length);
		for (const entry of readdirSync(this.scratchRoot)) {
			rmSync(join(this.scratchRoot, entry), { recursive: true, force: true });
		}
		this.disposed = true;
	}

	/** Explicit abandonment: no worktree, no scratch, no trace in the checkout. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const errors: unknown[] = [];
		try {
			this.worktree.close();
		} catch (error) {
			// Another recovered Builder process may already have abandoned this
			// exact crash-surviving worktree. Missing is the desired end state; only a
			// still-present path turns its cleanup error into our error.
			if (existsSync(this.path)) errors.push(error);
		}
		try {
			rmSync(this.scratchRoot, { recursive: true, force: true });
		} catch (error) {
			errors.push(error);
		}
		if (errors.length > 0) throw new AggregateError(errors, `failed to dispose workshop ${this.workshopId}`);
	}
}

function canonicalList(value: readonly string[]): string {
	return JSON.stringify([...value]);
}

/** The sentence a granted exception adds to the diff the operator applies. */
function grantRisk(grant: WorkshopGrant | WorkshopGrantAuditEvent): string {
	return `The operator allowed ${grant.tool} ${grant.wants.join(" and ")} for one exact try ` +
		`of ${grant.toolDigest} at ${grant.snapshotHash} (${grant.actorId}, ${grant.grantedAt}); ` +
		`the exception was ${grant.used ? "consumed" : "not consumed"}.`;
}

function inWorkshopScope(path: string): boolean {
	try {
		assertWorkshopScope(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Open one workshop over the exact clean Target commit the host selected. The
 * operator's checkout is never switched, never written, and never read for
 * execution; the workshop lives in a detached worktree that dies with it.
 */
export function openBuilderWorkshop(options: OpenBuilderWorkshopOptions): BuilderWorkshop {
	const repositoryDir = realpathSync(resolve(options.repositoryDir));
	const binding = assertWorkshopBinding(options.binding);
	if (!/^[0-9a-f]{40}$/.test(options.expectedTarget.gitSha)) {
		throw new ToolWorkshopError("a workshop opens only on an exact 40-character Git commit");
	}
	if (
		options.authoringContext.targetGitSha !== options.expectedTarget.gitSha ||
		options.authoringContext.targetId !== options.expectedTarget.id
	) {
		throw new ToolWorkshopError("the authoring context claim does not describe the selected Target revision");
	}
	const worktree = openDetachedWorktree({ repositoryDir, ref: options.expectedTarget.gitSha });
	let scratchRoot = "";
	try {
		if (worktree.sha !== options.expectedTarget.gitSha) {
			throw new ToolWorkshopError("the workshop worktree did not resolve to the selected Target revision");
		}
		// Reopening a closed proposal: its exact reviewed diff is the starting
		// point, applied host-side before the model ever sees the worktree.
		if (options.seed) applyDraft(worktree.path, options.seed.patch);
		const manifestText = workshopText(readFileSync(join(worktree.path, WORKSHOP_MANIFEST)), WORKSHOP_MANIFEST);
		const manifest = TargetManifest.parse(parseYaml(manifestText));
		if (manifest.id !== options.expectedTarget.id) {
			throw new ToolWorkshopError("the workshop revision declares a different Target identity");
		}
		scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), WORKSHOP_SCRATCH_PREFIX)));
		return new BuilderWorkshop({
			workshopId: options.workshopId ?? `workshop_${randomBytes(8).toString("hex")}`,
			repositoryDir,
			worktree,
			scratchRoot,
			targetId: manifest.id,
			claim: options.authoringContext,
			binding,
			fromProposalRunId: options.seed?.proposalRunId ?? null,
			openedAt: (options.now ?? (() => new Date().toISOString()))(),
			baseManifestText: manifestText,
			baseManifest: manifest,
			toolAuthoringPolicy: null,
			tryHistory: [],
			grantHistory: options.grantHistory,
			onGrantConsumed: options.onGrantConsumed,
		});
	} catch (error) {
		if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
		worktree.close();
		throw error;
	}
}

/**
 * Re-attach to a workshop a dead Builder process left behind. Nothing here is
 * trusted: the worktree must still be this repository's, still detached at the
 * exact baseline commit, and still hold byte-identical bytes. A mismatch is a
 * refusal, so a workshop can never come back subtly different from the one the
 * previous session was working in.
 */
export function reattachBuilderWorkshop(options: {
	repositoryDir: string;
	expectedTarget: { id: string; gitSha: string };
	authoringContext: TargetAuthoringContextClaim;
	descriptor: BuilderWorkshopDescriptor;
	expectedBinding: BuilderWorkshopBinding;
	grantHistory?: readonly WorkshopGrantAuditEvent[];
	onGrantConsumed?: (event: WorkshopGrantAuditEvent) => void;
}): BuilderWorkshop {
	const repositoryDir = realpathSync(resolve(options.repositoryDir));
	const descriptor = options.descriptor;
	const descriptorBinding = assertWorkshopBinding({
		basis: descriptor.basis,
		approvedSpecId: descriptor.approvedSpecId,
		source: descriptor.source,
	} as BuilderWorkshopBinding);
	const expectedBinding = assertWorkshopBinding(options.expectedBinding);
	if (!sameWorkshopBinding(descriptorBinding, expectedBinding)) {
		throw new ToolWorkshopError(
			"the recorded workshop Spec or evidence basis is stale; explicitly abandon it or restore its exact lineage",
		);
	}
	if (!existsSync(descriptor.worktreePath)) {
		throw new ToolWorkshopError("the recorded workshop worktree is gone; open a new one");
	}
	const worktree = reattachDetachedWorktree(repositoryDir, descriptor.worktreePath, descriptor.baseTargetSha);
	try {
		const scratchRoot = workshopScratchRoot(descriptor.scratchRoot);
		if (descriptor.baseTargetSha !== options.expectedTarget.gitSha || descriptor.targetId !== options.expectedTarget.id) {
			throw new ToolWorkshopError("the recorded workshop belongs to a different Target revision; discard it and open a new one");
		}
		if (
			options.authoringContext.targetGitSha !== options.expectedTarget.gitSha ||
			options.authoringContext.targetId !== options.expectedTarget.id
		) {
			throw new ToolWorkshopError("the authoring context claim does not describe the selected Target revision");
		}
		const manifestText = workshopText(readFileSync(join(worktree.path, WORKSHOP_MANIFEST)), WORKSHOP_MANIFEST);
		const manifest = TargetManifest.parse(parseYaml(manifestText));
		if (manifest.id !== options.expectedTarget.id) {
			throw new ToolWorkshopError("the recorded workshop declares a different Target identity");
		}
		const baseManifestText = workshopText(
			execFileSync("git", ["--no-replace-objects", "-C", repositoryDir, "show", `${descriptor.baseTargetSha}:${WORKSHOP_MANIFEST}`], {
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: GIT_MAX_BUFFER,
			}),
			WORKSHOP_MANIFEST,
		);
		const workshop = new BuilderWorkshop({
			workshopId: descriptor.workshopId,
			repositoryDir,
			worktree,
			scratchRoot,
			targetId: manifest.id,
			claim: options.authoringContext,
			binding: expectedBinding,
			fromProposalRunId: descriptor.fromProposalRunId,
			openedAt: descriptor.openedAt,
			baseManifestText,
			baseManifest: TargetManifest.parse(parseYaml(baseManifestText)),
			toolAuthoringPolicy: descriptor.toolAuthoringPolicy ?? null,
			tryHistory: descriptor.tryHistory ?? [],
			grantHistory: options.grantHistory,
			onGrantConsumed: options.onGrantConsumed,
		});
		const current = workshop.snapshotHash();
		if (current !== descriptor.snapshotHash) {
			throw new ToolWorkshopError(
				`the recorded workshop changed on disk (${descriptor.snapshotHash} → ${current}); discard it and open a new one`,
			);
		}
		return workshop;
	} catch (error) {
		// Re-attachment grants no cleanup authority. The exact worktree/note stay
		// available for an explicit close, discard, or abandon after the refusal.
		throw error;
	}
}

/**
 * The same handle `openDetachedWorktree` hands out, for a worktree this process
 * did not create. It re-validates every fact it needs and keeps the identical
 * cleanup, including the temporary-root safety check, so a re-attached workshop
 * still disposes without a trace.
 */
function reattachDetachedWorktree(repositoryDir: string, pathInput: string, sha: string): DetachedWorktreeHandle {
	const path = realpathSync(resolve(pathInput));
	const temporaryRoot = dirname(path);
	if (basename(path) !== "detached" || !basename(temporaryRoot).startsWith("ahde-experiment-")) {
		throw new ToolWorkshopError(`refusing to re-attach an unexpected workshop worktree: ${path}`);
	}
	const commonDir = realpathSync(gitWorkshop(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
	if (commonDir !== realpathSync(join(repositoryDir, ".git"))) {
		throw new ToolWorkshopError("the recorded workshop worktree does not belong to this repository");
	}
	if (gitWorkshop(path, ["rev-parse", "--verify", "HEAD^{commit}"]) !== sha) {
		throw new ToolWorkshopError("the recorded workshop worktree is no longer at its baseline commit");
	}
	let closed = false;
	return {
		ref: sha,
		sha,
		path,
		get open() {
			return !closed;
		},
		close() {
			if (closed) return;
			closed = true;
			const errors: unknown[] = [];
			try {
				execFileSync("git", ["-C", repositoryDir, "worktree", "remove", "--force", path], { stdio: "ignore" });
			} catch (error) {
				errors.push(error);
			}
			try {
				execFileSync("git", ["-C", repositoryDir, "worktree", "prune"], { stdio: "ignore" });
			} catch (error) {
				errors.push(error);
			}
			try {
				rmSync(temporaryRoot, { recursive: true, force: true });
			} catch (error) {
				errors.push(error);
			}
			if (errors.length > 0 && existsSync(path)) {
				throw new AggregateError(errors, "failed to clean the re-attached workshop worktree");
			}
		},
	};
}
