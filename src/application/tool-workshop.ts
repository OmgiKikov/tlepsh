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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	CandidateProposalSchema,
	validateCandidateProposal,
	type CandidateProposal,
} from "../builders/adapters.js";
import { loadTarget, TargetManifest, type ResolvedTarget, type TargetManifest as TargetManifestValue } from "../manifest.js";
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
	buildToolEnvironment,
	sandboxInvocation,
	TargetToolBroker,
	detectTargetToolSandbox,
	type TargetToolConfinement,
	type TargetToolSandboxBackend,
} from "../target/tool-broker.js";
import { prepareToolHome, type ToolSetupOutcome } from "../target/tool-setup.js";
import { loadTargetTools, type TargetToolLayout } from "../target/tool-manifest.js";
import {
	compileHarnessAuthoringProposal,
	renderManifest,
	wholeFileDiff,
	HARNESS_AUTHORING_ALLOWED_PATHS,
	type HarnessAuthoringIntent,
} from "./harness-authoring.js";
import { assertResourceOnlyManifestChange } from "./builder-proposal.js";
import {
	assertTargetAuthoringSurfaceWithinLimits,
	classifyTargetAuthoringResourcePath,
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
 * Harness, exactly as a Target would: same descriptor, same OS sandbox, same
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
 * The body of one try, over an already-materialized Harness directory: a
 * detached worktree of an exact revision, or a Builder workshop's own copy.
 * Nothing here reads or writes the operator's checkout.
 */
async function runDeclaredToolInDirectory(options: {
	directory: string;
	tool: string;
	input: unknown;
	source: TryToolResult["source"];
	signal?: AbortSignal;
}): Promise<TryToolResult> {
	const target = loadTarget(options.directory);
	const scratchRoot = mkdtempSync(join(tmpdir(), "ahde-tool-try-"));
	const runsRoot = join(scratchRoot, "runs");
	mkdirSync(runsRoot, { recursive: true, mode: 0o700 });
	const snapshot = materializeTargetWorkspaceSnapshot(target, runsRoot);
	try {
		const resolved = loadTargetTools(snapshot.dir, target.manifest.tools, target.manifest.execution);
		const tool = resolved.tools.find((candidate) => candidate.descriptor.name === options.tool);
		if (!tool) {
			const declared = resolved.tools.map((candidate) => candidate.descriptor.name).join(", ") || "none";
			throw new ToolWorkshopError(`Target declares no tool named ${options.tool}; declared: ${declared}`);
		}
		const scratchDir = join(scratchRoot, "sandbox");
		const sandboxBackend = detectTargetToolSandbox(snapshot.dir, scratchDir);
		const prepared = tool.layout === "directory"
			? prepareToolHome({
				workspaceDir: snapshot.dir,
				scratchDir,
				tools: resolved.tools,
				toolHomeRoot: snapshot.toolHomeDir,
				policy: target.manifest.execution,
				sandboxBackend,
			})
			: null;
		const broker = new TargetToolBroker({
			workspaceDir: snapshot.dir,
			scratchDir,
			policy: target.manifest.execution,
			sandboxBackend,
			...(prepared ? { toolHomeRoot: prepared.root } : {}),
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
				id: target.manifest.id,
				gitSha: target.gitSha,
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
const WORKSHOP_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** `manifest.yaml` is host-owned: the workshop derives its declarations. */
const WORKSHOP_MANIFEST = "manifest.yaml";

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
const WORKSHOP_COMMAND = /^[A-Za-z0-9._-]+$/;

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

export interface WorkshopStatus {
	workshopId: string;
	target: { id: string; gitSha: string };
	openedAt: string;
	writes: number;
	commands: number;
	tries: number;
	changes: WorkshopChange[];
	scope: readonly string[];
}

export interface OpenBuilderWorkshopOptions {
	repositoryDir: string;
	/** Host-derived Target identity; a workshop never trusts a model for it. */
	expectedTarget: { id: string; gitSha: string };
	/** The exact claim minted from the same clean revision this copies. */
	authoringContext: TargetAuthoringContextClaim;
	now?: () => string;
}

export interface CompiledWorkshopProposal {
	proposal: CandidateProposal;
	changes: WorkshopChange[];
	/** The exact revision the diff is against; identical to `proposal.baseTargetSha`. */
	baseTargetSha: string;
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
	private readonly worktree: DetachedWorktreeHandle;
	private readonly scratchRoot: string;
	private readonly baseManifestText: string;
	private readonly baseManifest: TargetManifestValue;
	private readonly written = new Set<string>();
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
		openedAt: string;
		baseManifestText: string;
		baseManifest: TargetManifestValue;
	}) {
		this.workshopId = options.workshopId;
		this.repositoryDir = options.repositoryDir;
		this.worktree = options.worktree;
		this.scratchRoot = options.scratchRoot;
		this.baseTargetSha = options.worktree.sha;
		this.targetId = options.targetId;
		this.path = realpathSync(options.worktree.path);
		this.openedAt = options.openedAt;
		this.claim = options.claim;
		this.baseManifestText = options.baseManifestText;
		this.baseManifest = options.baseManifest;
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

	// -- running -------------------------------------------------------------

	/**
	 * One argv, no shell interpolation, inside the same OS sandbox a declared
	 * Target tool runs in: the worktree is readable, only the Harness scope and a
	 * private scratch are writable, and the network follows the Target's declared
	 * policy.
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
		const cwd = request.cwd === undefined ? this.path : resolveWorkshopPath(this.path, request.cwd);
		if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
			throw new ToolWorkshopError(`the workshop has no directory ${String(request.cwd)}`);
		}
		const scratchDir = join(this.scratchRoot, "bash");
		mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
		const sandboxBackend = detectTargetToolSandbox(this.path, scratchDir);
		const { environment } = buildToolEnvironment({
			label: "workshop",
			scratchDir,
			environmentAllowlist: this.baseManifest.execution.environmentAllowlist,
		});
		const confinement: TargetToolConfinement = {
			network: this.baseManifest.execution.network,
			readRoots: [],
			writeRoots: this.writableRoots(),
		};
		const invocation = sandboxInvocation({
			backend: sandboxBackend,
			workspaceDir: this.path,
			scratchDir,
			environment,
			confinement,
			cwd,
			argv,
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
			const exitCode = await new Promise<number | null>((settle, reject) => {
				child.once("error", reject);
				child.once("close", settle);
			});
			if (stopped === "aborted") throw new ToolWorkshopError("the workshop command was aborted");
			const outText = boundedOutput(Buffer.concat(stdout).toString("utf8"));
			const errText = boundedOutput(Buffer.concat(stderr).toString("utf8"));
			// A command that touched the Harness may have changed what is declared.
			this.syncDeclarations();
			return {
				argv,
				cwd: relative(this.path, cwd) || ".",
				sandbox: sandboxBackend,
				network: confinement.network,
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
		}
	}

	/** Every part of the Harness scope the sandbox may write into. */
	private writableRoots(): string[] {
		const roots: string[] = [];
		for (const prefix of WORKSHOP_SCOPE_PREFIXES) {
			const directory = join(this.path, prefix.slice(0, -1));
			mkdirSync(directory, { recursive: true, mode: 0o755 });
			roots.push(directory);
		}
		const instructions = join(this.path, "AGENTS.md");
		if (existsSync(instructions) && lstatSync(instructions).isFile()) roots.push(instructions);
		return roots;
	}

	/** Run one declared tool of THIS workshop's Harness, exactly as a Target would. */
	async tryTool(options: { tool: string; input: unknown; signal?: AbortSignal }): Promise<TryToolResult> {
		this.assertOpen();
		if (!TOOL_NAME.test(options.tool)) {
			throw new ToolWorkshopError(`invalid tool name: ${JSON.stringify(options.tool)}`);
		}
		this.syncDeclarations();
		this.tries += 1;
		return runDeclaredToolInDirectory({
			directory: this.path,
			tool: options.tool,
			input: options.input,
			source: { kind: "workshop", ref: null, changedPaths: this.changes().map((change) => change.path) },
			...(options.signal ? { signal: options.signal } : {}),
		});
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
		const rendered = changedSkills || changedTools || changedData
			? renderManifest(this.baseManifestText, this.baseManifest, {
				...(changedSkills ? { skills } : {}),
				...(changedTools ? { tools } : {}),
				...(changedData ? { data } : {}),
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
		const raw = gitWorkshopRaw(this.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
		const paths = new Set<string>();
		for (const record of raw.split("\0").filter((entry) => entry.length > 3)) paths.add(record.slice(3));
		const changes: WorkshopChange[] = [];
		for (const path of [...paths].sort((left, right) => left.localeCompare(right))) {
			const absolute = join(this.path, path);
			const present = existsSync(absolute) && lstatSync(absolute).isFile();
			const base = baseBlobAt(this.repositoryDir, this.baseTargetSha, path);
			if (!present && !base) continue;
			changes.push({
				path,
				status: !present ? "removed" : base ? "modified" : "added",
				bytes: present ? statSync(absolute).size : null,
			});
		}
		return changes;
	}

	status(): WorkshopStatus {
		return {
			workshopId: this.workshopId,
			target: { id: this.targetId, gitSha: this.baseTargetSha },
			openedAt: this.openedAt,
			writes: this.writes,
			commands: this.commands,
			tries: this.tries,
			changes: this.disposed ? [] : this.changes(),
			scope: BUILDER_WORKSHOP_SCOPE,
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
	}): CompiledWorkshopProposal {
		this.assertOpen();
		this.assertBaselineUnmoved();
		this.syncDeclarations();
		const changes = this.changes();
		const offending = changes
			.map((change) => change.path)
			.filter((path) => path !== WORKSHOP_MANIFEST && !inWorkshopScope(path));
		if (offending.length > 0) {
			throw new BuilderWorkshopScopeError(
				offending,
				`a proposal may change only ${BUILDER_WORKSHOP_SCOPE.join(", ")} and the manifest's declared resource lists`,
			);
		}
		if (changes.length === 0) throw new BuilderWorkshopEmptyError();
		if (changes.length > MAX_WORKSHOP_CHANGES) {
			throw new ToolWorkshopError(`a reviewable proposal carries at most ${MAX_WORKSHOP_CHANGES} changed files`);
		}
		// Nothing the Builder wrote may vanish from the diff behind a .gitignore.
		const visible = new Set(changes.map((change) => change.path));
		const swallowed = [...this.written].filter((path) => {
			if (visible.has(path)) return false;
			const absolute = join(this.path, path);
			const present = existsSync(absolute) && lstatSync(absolute).isFile();
			const base = baseBlobAt(this.repositoryDir, this.baseTargetSha, path);
			if (!present) return base !== null;
			return !base || !base.content.equals(readFileSync(absolute));
		});
		if (swallowed.length > 0) {
			throw new BuilderWorkshopScopeError(swallowed, "Git ignores these paths, so they can never reach a reviewed proposal");
		}

		// The resulting Harness must load and must stay readable by its Builder.
		const resulting = loadTarget(this.path);
		this.assertResultingHarnessReadable(resulting);
		if (changes.some((change) => change.path === WORKSHOP_MANIFEST)) {
			assertResourceOnlyManifestChange(this.baseManifest, TargetManifest.parse(resulting.manifest));
		}

		const evidenceRefs = [...new Set((metadata.diagnoses ?? []).flatMap((diagnosis) => diagnosis.evidence))];
		const compiled = changes.map((change) => {
			const absolute = join(this.path, change.path);
			const base = baseBlobAt(this.repositoryDir, this.baseTargetSha, change.path);
			const raw = change.status === "removed" ? null : readFileSync(absolute);
			if (raw && raw.byteLength > MAX_WORKSHOP_FILE_BYTES) {
				throw new ToolWorkshopError(`${change.path} exceeds the ${MAX_WORKSHOP_FILE_BYTES}-byte proposal limit`);
			}
			const after = raw === null ? null : workshopText(raw, change.path);
			const afterMode = raw === null
				? null
				: (lstatSync(absolute).mode & 0o111) === 0 ? "100644" as const : "100755" as const;
			return {
				path: change.path,
				baseSha256: workshopSha256(base?.content ?? Buffer.alloc(0)),
				unifiedDiff: wholeFileDiff({ path: change.path, before: base, after, afterMode }),
				rationale: `${change.status === "added" ? "Add" : change.status === "removed" ? "Remove" : "Change"} ${change.path} in the Builder workshop`,
				evidenceRefs,
			};
		});

		const proposal = CandidateProposalSchema.parse({
			schemaVersion: 1,
			decision: "propose",
			baseTargetSha: this.baseTargetSha,
			summary: metadata.summary,
			diagnoses: metadata.diagnoses ?? [],
			changes: compiled,
			risks: metadata.risks ?? [],
			validationPlan: metadata.validationPlan ?? [],
		});
		validateCandidateProposal(proposal, {
			baseTargetSha: this.baseTargetSha,
			allowedPaths: [...HARNESS_AUTHORING_ALLOWED_PATHS],
		});
		const patch = `${proposal.changes.map((change) => change.unifiedDiff.trimEnd()).join("\n")}\n`;
		gitWorkshop(this.repositoryDir, ["apply", "--check", "--index", "-"], patch);
		return { proposal, changes, baseTargetSha: this.baseTargetSha };
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
			if (!identity) throw new ToolWorkshopError(`the resulting Harness declares a noncanonical resource: ${path}`);
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

	/** The workshop dies here: no worktree, no scratch, no trace in the checkout. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const errors: unknown[] = [];
		try {
			this.worktree.close();
		} catch (error) {
			errors.push(error);
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
		const manifestText = workshopText(readFileSync(join(worktree.path, WORKSHOP_MANIFEST)), WORKSHOP_MANIFEST);
		const manifest = TargetManifest.parse(parseYaml(manifestText));
		if (manifest.id !== options.expectedTarget.id) {
			throw new ToolWorkshopError("the workshop revision declares a different Target identity");
		}
		scratchRoot = mkdtempSync(join(tmpdir(), "ahde-workshop-"));
		return new BuilderWorkshop({
			workshopId: `workshop_${randomBytes(8).toString("hex")}`,
			repositoryDir,
			worktree,
			scratchRoot,
			targetId: manifest.id,
			claim: options.authoringContext,
			openedAt: (options.now ?? (() => new Date().toISOString()))(),
			baseManifestText: manifestText,
			baseManifest: manifest,
		});
	} catch (error) {
		if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
		worktree.close();
		throw error;
	}
}
