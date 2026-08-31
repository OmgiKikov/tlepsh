import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { TargetManifest } from "../manifest.js";
import { canonicalJson, hashValue } from "../provenance.js";
// Type-only: the memory of what was already tried is compiled by the caller, so
// this module stays a reader of Git and nothing else.
import type { CompactExperimentHistory } from "./experiment-history.js";
import {
	classifyTargetToolDescriptorPath,
	MAX_TOOL_DIRECTORY_FILES,
	validateTargetToolDescriptor,
} from "../target/tool-manifest.js";

const GIT_SHA = /^[0-9a-f]{40}$/;
const TARGET_ID = /^[a-z0-9][a-z0-9-]*$/;
const SKILL_DECLARATION = /^skills\/((?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/;
const TOOL_DIRECTORY_FILE = /^tools\/([a-z][a-z0-9_]{0,63})\/((?:[A-Za-z0-9._-]{1,64}\/){0,5}[A-Za-z0-9._-]{1,64})$/;
const DATA_DIRECTORY = /^data\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
const SAFE_REQUEST_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$/;

const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;
export const TARGET_AUTHORING_LIMITS = Object.freeze({
	manifestBytes: 1024 * 1024,
	resourceBytes: 512 * 1024,
	aggregateBytes: 8 * 1024 * 1024,
	projectionBytes: 512 * 1024,
	maxSkills: 64,
	maxTools: 64,
});
const MAX_MANIFEST_BYTES = TARGET_AUTHORING_LIMITS.manifestBytes;
const MAX_RESOURCE_BYTES = TARGET_AUTHORING_LIMITS.resourceBytes;
const MAX_CONTEXT_BYTES = TARGET_AUTHORING_LIMITS.aggregateBytes;
const MAX_CONTEXT_PROJECTION_BYTES = TARGET_AUTHORING_LIMITS.projectionBytes;
const MAX_SKILLS = TARGET_AUTHORING_LIMITS.maxSkills;
const MAX_TOOLS = TARGET_AUTHORING_LIMITS.maxTools;
const MAX_RESOURCES = 1 + MAX_SKILLS + (MAX_TOOLS * MAX_TOOL_DIRECTORY_FILES);
/** How many data file names one bounded listing may name. */
const MAX_DATA_ENTRY_SAMPLE = 32;
/**
 * Canonical-JSON bytes the memory of prior attempts may occupy inside one
 * authoring context. It is carved out of the same model-context limit the
 * overview already lives under, so folding history in can never push the exact
 * Git surface out: attempts are dropped, oldest first, and counted.
 */
export const MAX_AUTHORING_HISTORY_PROJECTION_BYTES = 8 * 1024;

export type TargetAuthoringContextErrorCode =
	| "TARGET_CONTEXT_INVALID"
	| "TARGET_CONTEXT_DIRTY"
	| "TARGET_CONTEXT_STALE"
	| "TARGET_RESOURCE_DENIED"
	| "TARGET_RESOURCE_SYMLINK"
	| "TARGET_RESOURCE_TOO_LARGE"
	| "TARGET_RESOURCE_INVALID_UTF8";

/** A bounded model-safe failure. Host-only subprocess details remain in `cause`. */
export class TargetAuthoringContextError extends Error {
	readonly code: TargetAuthoringContextErrorCode;

	constructor(code: TargetAuthoringContextErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "TargetAuthoringContextError";
		this.code = code;
	}
}

export type TargetAuthoringResourceKind =
	| "instructions"
	| "skill"
	| "tool-descriptor"
	| "tool-executable"
	/** Any other file inside a multi-file `tools/<name>/` directory. */
	| "tool-file";

export interface TargetAuthoringResource {
	kind: TargetAuthoringResourceKind;
	name: string | null;
	path: string;
	mode: "100644" | "100755";
	bytes: number;
	sha256: string;
}

/**
 * Declared data is shape, never content: a Builder learns that `data/docs`
 * holds 412 files and 3.1 MB, and a bounded sample of their names.
 */
export interface TargetAuthoringDataDirectory {
	path: string;
	files: number;
	bytes: number;
	entries: string[];
	entriesTruncated: boolean;
}

export interface TargetAuthoringResourceRead extends TargetAuthoringResource {
	/** Exact complete Git-blob text. Authoring resources are never truncated. */
	content: string;
}

export const TargetAuthoringContextClaimSchema = z.strictObject({
	algorithmId: z.literal("git-manifest-context-v1"),
	targetId: z.string().min(1).max(100).regex(TARGET_ID),
	targetGitSha: z.string().regex(GIT_SHA),
	contextHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type TargetAuthoringContextClaim = z.infer<typeof TargetAuthoringContextClaimSchema>;

export interface TargetAuthoringContextRequest {
	repositoryDir: string;
	/** Fresh host-derived identity. Builder Pi never supplies this authority. */
	expectedTarget: { id: string; gitSha: string };
	/** Absent returns the bounded overview; present returns one declared resource too. */
	resourcePath?: string;
	/**
	 * What this project already tried, compiled by the host from immutable
	 * candidate records. It is attached to the overview and is deliberately NOT
	 * part of `contextHash` or the claim: the exact Git revision a proposal is
	 * authored against cannot depend on how many experiments have since been run,
	 * or every stored claim would expire the moment a candidate finished.
	 */
	history?: CompactExperimentHistory;
}

export interface TargetAuthoringContext {
	schemaVersion: 1;
	algorithmId: "git-manifest-context-v1";
	contextHash: string;
	/** Exact host-minted value a structured proposal must echo back. */
	claim: TargetAuthoringContextClaim;
	target: {
		id: string;
		gitSha: string;
		model: {
			provider: string;
			id: string;
			thinkingLevel: string;
		};
		execution: {
			tools: string[];
			environmentAllowlist: string[];
			network: "deny" | "allow";
			sandbox: "required" | "best-effort" | "off";
		};
	};
	resources: TargetAuthoringResource[];
	/** Declared `data/**` directories, by shape only. */
	data: TargetAuthoringDataDirectory[];
	resource?: TargetAuthoringResourceRead;
	/**
	 * What was already tried on this Target: what each attempt changed, what it
	 * was aiming at, what it scored and why it ended the way it did. Bounded to
	 * whatever fits {@link MAX_AUTHORING_HISTORY_PROJECTION_BYTES} inside the
	 * model-context limit; `priorAttemptsOmitted` says how many did not fit.
	 * Never part of `contextHash`.
	 */
	priorAttempts?: CompactExperimentHistory["attempts"];
	priorAttemptsOmitted?: number;
	launch: "ahde target";
}

interface GitTreeEntry {
	mode: string;
	type: string;
	path: string;
}

interface ExactResource {
	summary: TargetAuthoringResource;
	content: string;
}

/** One declared tool as the closure policy sees it: name, shape, file count. */
export interface TargetAuthoringToolDeclaration {
	name: string;
	layout: "single-file" | "directory";
	/** Files inside `tools/<name>/`, descriptor included. Zero for single-file tools. */
	fileCount: number;
}

export interface TargetAuthoringSurfacePolicyInput {
	manifestBytes: number;
	skillCount: number;
	tools: readonly TargetAuthoringToolDeclaration[];
	data?: readonly TargetAuthoringDataDirectory[];
	target: TargetAuthoringContext["target"];
	resources: readonly TargetAuthoringResource[];
}

function contextError(
	code: TargetAuthoringContextErrorCode,
	message: string,
	cause?: unknown,
): never {
	throw new TargetAuthoringContextError(code, message, cause);
}

function gitRaw(repositoryDir: string, args: string[], maxBuffer = MAX_GIT_OUTPUT_BYTES): Buffer {
	try {
		return execFileSync("git", ["--no-replace-objects", "-C", repositoryDir, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer,
		});
	} catch (error) {
		return contextError("TARGET_CONTEXT_INVALID", "Target Git context could not be verified.", error);
	}
}

function gitText(repositoryDir: string, args: string[]): string {
	return gitRaw(repositoryDir, args).toString("utf8").trim();
}

function repositoryRoot(input: string): string {
	try {
		const requested = resolve(input);
		const entry = lstatSync(requested);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			return contextError("TARGET_CONTEXT_INVALID", "Target must be a regular Git worktree root.");
		}
		const canonical = realpathSync(requested);
		const top = realpathSync(gitText(canonical, ["rev-parse", "--show-toplevel"]));
		if (top !== canonical) {
			return contextError("TARGET_CONTEXT_INVALID", "Target must be the Git worktree root.");
		}
		return canonical;
	} catch (error) {
		if (error instanceof TargetAuthoringContextError) throw error;
		return contextError("TARGET_CONTEXT_INVALID", "Target must be a regular Git worktree root.", error);
	}
}

function assertExpectedTargetId(expected: TargetAuthoringContextRequest["expectedTarget"]): void {
	if (expected.id.length > 100 || !TARGET_ID.test(expected.id)) {
		contextError("TARGET_CONTEXT_STALE", "The selected Target identity is invalid.");
	}
}

function assertCleanRevision(repositoryDir: string, expectedRevision: string): void {
	const status = gitRaw(repositoryDir, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (status.length > 0) {
		contextError("TARGET_CONTEXT_DIRTY", "Target has uncommitted changes; commit or remove them before authoring.");
	}
	if (!GIT_SHA.test(expectedRevision)) {
		contextError("TARGET_CONTEXT_STALE", "The selected Target is not an exact committed revision; refresh the Target view.");
	}
	const head = gitText(repositoryDir, ["rev-parse", "--verify", "HEAD^{commit}"]);
	if (!GIT_SHA.test(head) || head !== expectedRevision) {
		contextError("TARGET_CONTEXT_STALE", "Target changed since the Workbench selected it; refresh the Target view.");
	}
}

function safeRequestedPath(path: string): string {
	if (
		!SAFE_REQUEST_PATH.test(path) ||
		path !== path.trim() ||
		isAbsolute(path) ||
		path.includes("\\") ||
		path.includes("\0") ||
		path.includes(":")
	) {
		return contextError("TARGET_RESOURCE_DENIED", "Only a declared Target authoring resource may be inspected.");
	}
	const segments = path.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
		return contextError("TARGET_RESOURCE_DENIED", "Only a declared Target authoring resource may be inspected.");
	}
	return path;
}

/** Every blob under one declared directory, with Git-reported sizes. */
function treeEntriesRecursive(
	repositoryDir: string,
	revision: string,
	directory: string,
): Array<{ mode: string; type: string; bytes: number; path: string }> {
	const output = gitRaw(repositoryDir, ["ls-tree", "-r", "-l", "-z", revision, "--", `${directory}/`]).toString("utf8");
	const entries: Array<{ mode: string; type: string; bytes: number; path: string }> = [];
	for (const record of output.split("\0").filter(Boolean)) {
		const tab = record.indexOf("\t");
		if (tab < 0) contextError("TARGET_CONTEXT_INVALID", "Target Git tree metadata is invalid.");
		const path = record.slice(tab + 1);
		const fields = record.slice(0, tab).split(/\s+/);
		const mode = fields[0];
		const type = fields[1];
		const size = Number(fields[3]);
		if (!mode || !type || !Number.isSafeInteger(size) || size < 0) {
			contextError("TARGET_CONTEXT_INVALID", "Target Git tree metadata is invalid.");
		}
		entries.push({ mode: mode as string, type: type as string, bytes: size, path });
	}
	return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function treeEntry(repositoryDir: string, revision: string, path: string): GitTreeEntry | null {
	const output = gitRaw(repositoryDir, ["ls-tree", "-z", revision, "--", path]).toString("utf8");
	for (const record of output.split("\0").filter(Boolean)) {
		const tab = record.indexOf("\t");
		if (tab < 0 || record.slice(tab + 1) !== path) continue;
		const fields = record.slice(0, tab).split(" ");
		const mode = fields[0];
		const type = fields[1];
		if (!mode || !type) {
			return contextError("TARGET_CONTEXT_INVALID", "Target Git tree metadata is invalid.");
		}
		return { mode, type, path };
	}
	return null;
}

function assertSafeAncestors(repositoryDir: string, revision: string, path: string): void {
	const parts = path.split("/");
	for (let index = 1; index < parts.length; index += 1) {
		const ancestor = parts.slice(0, index).join("/");
		const entry = treeEntry(repositoryDir, revision, ancestor);
		if (!entry) continue;
		if (entry.mode === "120000") {
			contextError("TARGET_RESOURCE_SYMLINK", "A declared Target resource traverses a Git symlink.");
		}
		if (entry.type !== "tree") {
			contextError("TARGET_CONTEXT_INVALID", "A declared Target resource has a non-directory parent.");
		}
	}
}

function decodeUtf8(content: Buffer): string {
	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch (error) {
		return contextError("TARGET_RESOURCE_INVALID_UTF8", "A declared Target resource is not valid UTF-8 text.", error);
	}
	if (decoded.includes("\0") || decoded.includes("\r")) {
		contextError("TARGET_RESOURCE_INVALID_UTF8", "A declared Target resource must be NUL-free LF-only UTF-8 text.");
	}
	return decoded;
}

function readBlob(
	repositoryDir: string,
	revision: string,
	path: string,
	maxBytes: number,
	allowedModes: readonly ("100644" | "100755")[],
): { mode: "100644" | "100755"; bytes: number; sha256: string; content: string } {
	assertSafeAncestors(repositoryDir, revision, path);
	const entry = treeEntry(repositoryDir, revision, path);
	if (!entry) contextError("TARGET_CONTEXT_INVALID", "A declared Target resource is missing from the exact revision.");
	if (entry.mode === "120000") {
		contextError("TARGET_RESOURCE_SYMLINK", "A declared Target resource is a Git symlink.");
	}
	if (entry.type !== "blob" || !allowedModes.includes(entry.mode as "100644" | "100755")) {
		contextError("TARGET_CONTEXT_INVALID", "A declared Target resource has an unsafe Git type or mode.");
	}
	const size = Number(gitText(repositoryDir, ["cat-file", "-s", `${revision}:${path}`]));
	if (!Number.isSafeInteger(size) || size < 0) {
		contextError("TARGET_CONTEXT_INVALID", "A declared Target resource has invalid Git size metadata.");
	}
	if (size > maxBytes) {
		contextError("TARGET_RESOURCE_TOO_LARGE", "A declared Target resource exceeds the authoring context limit.");
	}
	const raw = gitRaw(repositoryDir, ["cat-file", "blob", `${revision}:${path}`], Math.max(maxBytes + 1, 1024));
	if (raw.length !== size) {
		contextError("TARGET_CONTEXT_INVALID", "A declared Target resource could not be read exactly.");
	}
	return {
		mode: entry.mode as "100644" | "100755",
		bytes: raw.length,
		sha256: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
		content: decodeUtf8(raw),
	};
}

function exactResource(
	input: ReturnType<typeof readBlob>,
	kind: TargetAuthoringResourceKind,
	name: string | null,
	path: string,
): ExactResource {
	return {
		summary: {
			kind,
			name,
			path,
			mode: input.mode,
			bytes: input.bytes,
			sha256: input.sha256,
		},
		content: input.content,
	};
}

/** Canonical resource identity shared by inspection and semantic compilation. */
export function classifyTargetAuthoringResourcePath(path: string): {
	kind: TargetAuthoringResourceKind;
	name: string | null;
	/** Every Git mode this canonical path may legally carry. */
	modes: readonly ("100644" | "100755")[];
} | null {
	if (path === "AGENTS.md") return { kind: "instructions", name: null, modes: ["100644"] };
	const skill = /^skills\/((?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/SKILL\.md$/.exec(path)?.[1];
	if (skill) return { kind: "skill", name: skill, modes: ["100644"] };
	const singleDescriptor = /^tools\/([a-z][a-z0-9_]{0,63})\.tool\.yaml$/.exec(path)?.[1];
	if (singleDescriptor) return { kind: "tool-descriptor", name: singleDescriptor, modes: ["100644"] };
	const directoryFile = TOOL_DIRECTORY_FILE.exec(path);
	if (directoryFile?.[1] && directoryFile[2]) {
		const name = directoryFile[1];
		if (directoryFile[2] === "tool.yaml") return { kind: "tool-descriptor", name, modes: ["100644"] };
		if (directoryFile[2] === "run") return { kind: "tool-executable", name, modes: ["100755"] };
		return { kind: "tool-file", name, modes: ["100644", "100755"] };
	}
	const executable = /^bin\/([a-z][a-z0-9_]{0,63})$/.exec(path)?.[1];
	if (executable) return { kind: "tool-executable", name: executable, modes: ["100755"] };
	return null;
}

function expectedToolResourceCount(tool: TargetAuthoringToolDeclaration): number {
	return tool.layout === "single-file" ? 2 : tool.fileCount;
}

/**
 * One closure policy for both readable Targets and compiler-produced Targets.
 * A proposal may never create a Harness that its own Builder cannot inspect.
 */
export function assertTargetAuthoringSurfaceWithinLimits(
	input: TargetAuthoringSurfacePolicyInput,
): void {
	if (!Number.isSafeInteger(input.manifestBytes) || input.manifestBytes < 0 || input.manifestBytes > MAX_MANIFEST_BYTES) {
		contextError("TARGET_RESOURCE_TOO_LARGE", "Target manifest exceeds the authoring context limit.");
	}
	if (
		!Number.isSafeInteger(input.skillCount) || input.skillCount < 0 || input.skillCount > MAX_SKILLS ||
		input.tools.length > MAX_TOOLS
	) {
		contextError("TARGET_RESOURCE_TOO_LARGE", "Target declares too many authoring resources for one bounded context.");
	}
	const expectedResources = 1 + input.skillCount +
		input.tools.reduce((total, tool) => total + expectedToolResourceCount(tool), 0);
	if (input.resources.length !== expectedResources || input.resources.length > MAX_RESOURCES) {
		contextError("TARGET_CONTEXT_INVALID", "Target authoring resources do not match its canonical declarations.");
	}
	const declaredToolNames = new Set(input.tools.map((tool) => tool.name));
	const seen = new Set<string>();
	for (const resource of input.resources) {
		const identity = classifyTargetAuthoringResourcePath(resource.path);
		if (
			!identity || seen.has(resource.path) || identity.kind !== resource.kind ||
			identity.name !== resource.name || !identity.modes.includes(resource.mode) ||
			(resource.kind === "tool-file" && !declaredToolNames.has(resource.name ?? ""))
		) {
			contextError("TARGET_CONTEXT_INVALID", "Target contains a noncanonical or duplicate authoring resource.");
		}
		seen.add(resource.path);
		if (!Number.isSafeInteger(resource.bytes) || resource.bytes < 0 || resource.bytes > MAX_RESOURCE_BYTES) {
			contextError("TARGET_RESOURCE_TOO_LARGE", "A declared Target resource exceeds the authoring context limit.");
		}
	}
	for (const directory of input.data ?? []) {
		if (!DATA_DIRECTORY.test(directory.path) || !Number.isSafeInteger(directory.bytes) || directory.bytes < 0) {
			contextError("TARGET_CONTEXT_INVALID", "Target declares a noncanonical data directory.");
		}
	}
	const ordered = [...input.resources].sort((left, right) => left.path.localeCompare(right.path));
	const aggregateBytes = input.manifestBytes + ordered.reduce((total, resource) => total + resource.bytes, 0);
	if (aggregateBytes > MAX_CONTEXT_BYTES) {
		contextError("TARGET_RESOURCE_TOO_LARGE", "Target authoring context exceeds the aggregate byte limit.");
	}
	const projection = { target: input.target, resources: ordered, data: input.data ?? [] };
	if (Buffer.byteLength(canonicalJson(projection), "utf8") > MAX_CONTEXT_PROJECTION_BYTES) {
		contextError("TARGET_RESOURCE_TOO_LARGE", "Target authoring overview exceeds the model-context limit.");
	}
}

/**
 * Fit the memory of prior attempts into whatever the bounded overview has left.
 *
 * The exact Git surface always wins: the history budget is the smaller of its
 * own cap and the room remaining under the model-context limit, and attempts
 * are dropped oldest-first until the whole projection fits. Nothing is dropped
 * quietly — `omitted` carries every attempt the Builder is not being shown.
 */
function boundedPriorAttempts(
	history: CompactExperimentHistory | undefined,
	surface: {
		manifestBytes: number;
		target: TargetAuthoringContext["target"];
		resources: readonly TargetAuthoringResource[];
		data: readonly TargetAuthoringDataDirectory[];
	},
): CompactExperimentHistory | null {
	if (!history) return null;
	const overviewBytes = Buffer.byteLength(
		canonicalJson({ target: surface.target, resources: surface.resources, data: surface.data }),
		"utf8",
	);
	const budget = Math.max(
		0,
		Math.min(MAX_AUTHORING_HISTORY_PROJECTION_BYTES, MAX_CONTEXT_PROJECTION_BYTES - overviewBytes),
	);
	let attempts = [...history.attempts];
	while (attempts.length > 0 && Buffer.byteLength(canonicalJson(attempts), "utf8") > budget) {
		attempts = attempts.slice(0, -1);
	}
	return { attempts, omitted: history.omitted + (history.attempts.length - attempts.length) };
}

/**
 * Inspect the exact, manifest-declared Target authoring surface.
 *
 * This is intentionally one deep interface: callers never handle Git paths,
 * tree modes, descriptor traversal, UTF-8 validation, or mutable worktree IO.
 */
export function inspectTargetAuthoringContext(
	request: TargetAuthoringContextRequest,
): TargetAuthoringContext {
	assertExpectedTargetId(request.expectedTarget);
	const requestedPath = request.resourcePath === undefined ? undefined : safeRequestedPath(request.resourcePath);
	const repositoryDir = repositoryRoot(request.repositoryDir);
	assertCleanRevision(repositoryDir, request.expectedTarget.gitSha);

	const manifestBlob = readBlob(
		repositoryDir,
		request.expectedTarget.gitSha,
		"manifest.yaml",
		MAX_MANIFEST_BYTES,
		["100644"],
	);
	let manifestValue: unknown;
	try {
		manifestValue = parseYaml(manifestBlob.content);
	} catch (error) {
		return contextError("TARGET_CONTEXT_INVALID", "Target manifest is not valid YAML.", error);
	}
	const manifestResult = TargetManifest.safeParse(manifestValue);
	if (!manifestResult.success) {
		contextError("TARGET_CONTEXT_INVALID", "Target manifest is not a valid AHDE manifest.");
	}
	const manifest = manifestResult.data;
	if (manifest.id !== request.expectedTarget.id) {
		contextError("TARGET_CONTEXT_STALE", "Target identity changed since the Workbench selected it.");
	}
	if (manifest.instructions.agentsMd !== "AGENTS.md") {
		contextError("TARGET_CONTEXT_INVALID", "Target instructions must use the canonical AGENTS.md declaration.");
	}
	if (manifest.skills.length > MAX_SKILLS || manifest.tools.length > MAX_TOOLS) {
		contextError("TARGET_RESOURCE_TOO_LARGE", "Target declares too many authoring resources for one bounded context.");
	}
	const resources = new Map<string, ExactResource>();
	const add = (resource: ExactResource): void => {
		if (resources.size >= MAX_RESOURCES) {
			contextError("TARGET_RESOURCE_TOO_LARGE", "Target declares too many authoring resources for one bounded context.");
		}
		if (resources.has(resource.summary.path)) {
			contextError("TARGET_CONTEXT_INVALID", "Target contains duplicate or shared authoring resource declarations.");
		}
		resources.set(resource.summary.path, resource);
	};

	add(exactResource(
		readBlob(repositoryDir, request.expectedTarget.gitSha, "AGENTS.md", MAX_RESOURCE_BYTES, ["100644"]),
		"instructions",
		null,
		"AGENTS.md",
	));

	const skillNames = new Set<string>();
	for (const declaration of manifest.skills) {
		const match = SKILL_DECLARATION.exec(declaration);
		if (!match?.[1] || skillNames.has(match[1])) {
			contextError("TARGET_CONTEXT_INVALID", "Target contains an unsafe or duplicate skill declaration.");
		}
		const name = match[1];
		skillNames.add(name);
		const path = `${declaration}/SKILL.md`;
		add(exactResource(
			readBlob(repositoryDir, request.expectedTarget.gitSha, path, MAX_RESOURCE_BYTES, ["100644"]),
			"skill",
			name,
			path,
		));
	}

	const toolNames = new Set<string>();
	const toolDeclarations: TargetAuthoringToolDeclaration[] = [];
	for (const declaration of manifest.tools) {
		const identity = classifyTargetToolDescriptorPath(declaration);
		if (!identity || toolNames.has(identity.name)) {
			contextError("TARGET_CONTEXT_INVALID", "Target contains an unsafe or duplicate tool declaration.");
		}
		const name = identity.name;
		toolNames.add(name);
		const descriptorBlob = readBlob(
			repositoryDir,
			request.expectedTarget.gitSha,
			declaration,
			MAX_RESOURCE_BYTES,
			["100644"],
		);
		let descriptorValue: unknown;
		try {
			descriptorValue = parseYaml(descriptorBlob.content);
		} catch (error) {
			return contextError("TARGET_CONTEXT_INVALID", "A declared Target tool descriptor is not valid YAML.", error);
		}
		let descriptor: ReturnType<typeof validateTargetToolDescriptor>;
		try {
			descriptor = validateTargetToolDescriptor(descriptorValue, declaration, manifest.execution);
		} catch (error) {
			return contextError("TARGET_CONTEXT_INVALID", "A declared Target tool descriptor is invalid.", error);
		}
		const executablePath = descriptor.command.argv[0];
		if (identity.layout === "single-file") {
			if (executablePath !== `bin/${name}`) {
				contextError("TARGET_CONTEXT_INVALID", "Target tool executables must use their canonical bin/<name> declaration.");
			}
			add(exactResource(descriptorBlob, "tool-descriptor", name, declaration));
			add(exactResource(
				readBlob(repositoryDir, request.expectedTarget.gitSha, executablePath, MAX_RESOURCE_BYTES, ["100755"]),
				"tool-executable",
				name,
				executablePath,
			));
			toolDeclarations.push({ name, layout: "single-file", fileCount: 0 });
			continue;
		}

		const directory = identity.directoryPath as string;
		if (executablePath !== `${directory}/run`) {
			contextError("TARGET_CONTEXT_INVALID", "Multi-file Target tools must run their canonical tools/<name>/run entry.");
		}
		const listed = treeEntriesRecursive(repositoryDir, request.expectedTarget.gitSha, directory);
		if (listed.length === 0 || listed.length > MAX_TOOL_DIRECTORY_FILES) {
			contextError("TARGET_RESOURCE_TOO_LARGE", "A declared multi-file Target tool has no files or too many.");
		}
		for (const entry of listed) {
			const child = classifyTargetAuthoringResourcePath(entry.path);
			if (!child || child.name !== name) {
				contextError("TARGET_CONTEXT_INVALID", "A multi-file Target tool contains a noncanonical path.");
			}
			add(exactResource(
				readBlob(
					repositoryDir,
					request.expectedTarget.gitSha,
					entry.path,
					MAX_RESOURCE_BYTES,
					child.modes as ("100644" | "100755")[],
				),
				child.kind,
				name,
				entry.path,
			));
		}
		toolDeclarations.push({ name, layout: "directory", fileCount: listed.length });
	}

	const data: TargetAuthoringDataDirectory[] = manifest.data.map((declaration) => {
		if (!DATA_DIRECTORY.test(declaration)) {
			contextError("TARGET_CONTEXT_INVALID", "Target declares a noncanonical data directory.");
		}
		const listed = treeEntriesRecursive(repositoryDir, request.expectedTarget.gitSha, declaration);
		let bytes = 0;
		for (const entry of listed) {
			if (entry.mode === "120000") {
				contextError("TARGET_RESOURCE_SYMLINK", "A declared Target data directory contains a Git symlink.");
			}
			if (entry.type !== "blob") {
				contextError("TARGET_CONTEXT_INVALID", "A declared Target data directory contains a non-file entry.");
			}
			bytes += entry.bytes;
		}
		const entries = listed.slice(0, MAX_DATA_ENTRY_SAMPLE).map((entry) => entry.path.slice(declaration.length + 1));
		return {
			path: declaration,
			files: listed.length,
			bytes,
			entries,
			entriesTruncated: listed.length > entries.length,
		};
	});

	const ordered = [...resources.values()].sort((left, right) => left.summary.path.localeCompare(right.summary.path));
	if (requestedPath && !resources.has(requestedPath)) {
		contextError("TARGET_RESOURCE_DENIED", "Only a declared Target authoring resource may be inspected.");
	}

	const target = {
		id: manifest.id,
		gitSha: request.expectedTarget.gitSha,
		model: {
			provider: manifest.model.provider,
			id: manifest.model.id,
			thinkingLevel: manifest.model.thinkingLevel,
		},
		execution: {
			tools: [...manifest.execution.tools],
			environmentAllowlist: [...manifest.execution.environmentAllowlist],
			network: manifest.execution.network,
			sandbox: manifest.execution.sandbox,
		},
	};
	const summaries = ordered.map((item) => item.summary);
	assertTargetAuthoringSurfaceWithinLimits({
		manifestBytes: manifestBlob.bytes,
		skillCount: manifest.skills.length,
		tools: toolDeclarations,
		data,
		target,
		resources: summaries,
	});
	const contextHash = hashValue({
		algorithmId: "git-manifest-context-v1",
		target,
		manifestSha256: manifestBlob.sha256,
		resources: summaries,
		// Canonical JSON drops an empty array's key only when it is undefined, so
		// a Target that declares no data still hashes exactly as it did before.
		data: data.length > 0 ? data : undefined,
	});
	const claim = TargetAuthoringContextClaimSchema.parse({
		algorithmId: "git-manifest-context-v1",
		targetId: target.id,
		targetGitSha: target.gitSha,
		contextHash,
	});

	assertCleanRevision(repositoryDir, request.expectedTarget.gitSha);
	const selected = requestedPath ? resources.get(requestedPath) : undefined;
	const history = boundedPriorAttempts(request.history, {
		manifestBytes: manifestBlob.bytes,
		target,
		resources: summaries,
		data,
	});
	return {
		schemaVersion: 1,
		algorithmId: "git-manifest-context-v1",
		contextHash,
		claim,
		target,
		resources: summaries,
		...(history ? { priorAttempts: history.attempts, priorAttemptsOmitted: history.omitted } : {}),
		data,
		...(selected ? { resource: { ...selected.summary, content: selected.content } } : {}),
		launch: "ahde target",
	};
}
