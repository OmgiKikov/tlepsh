import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { TargetManifest } from "../manifest.js";
import { canonicalJson, hashValue } from "../provenance.js";
import { validateTargetToolDescriptor } from "../target/tool-manifest.js";

const GIT_SHA = /^[0-9a-f]{40}$/;
const TARGET_ID = /^[a-z0-9][a-z0-9-]*$/;
const SKILL_DECLARATION = /^skills\/((?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/;
const TOOL_DECLARATION = /^tools\/([a-z][a-z0-9_]{0,63})\.tool\.yaml$/;
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
const MAX_RESOURCES = 1 + MAX_SKILLS + (MAX_TOOLS * 2);

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
	| "tool-executable";

export interface TargetAuthoringResource {
	kind: TargetAuthoringResourceKind;
	name: string | null;
	path: string;
	mode: "100644" | "100755";
	bytes: number;
	sha256: string;
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
	resource?: TargetAuthoringResourceRead;
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

export interface TargetAuthoringSurfacePolicyInput {
	manifestBytes: number;
	skillCount: number;
	toolCount: number;
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
	mode: "100644" | "100755";
} | null {
	if (path === "AGENTS.md") return { kind: "instructions", name: null, mode: "100644" };
	const skill = /^skills\/((?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/SKILL\.md$/.exec(path)?.[1];
	if (skill) return { kind: "skill", name: skill, mode: "100644" };
	const descriptor = TOOL_DECLARATION.exec(path)?.[1];
	if (descriptor) return { kind: "tool-descriptor", name: descriptor, mode: "100644" };
	const executable = /^bin\/([a-z][a-z0-9_]{0,63})$/.exec(path)?.[1];
	if (executable) return { kind: "tool-executable", name: executable, mode: "100755" };
	return null;
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
		!Number.isSafeInteger(input.toolCount) || input.toolCount < 0 || input.toolCount > MAX_TOOLS
	) {
		contextError("TARGET_RESOURCE_TOO_LARGE", "Target declares too many authoring resources for one bounded context.");
	}
	const expectedResources = 1 + input.skillCount + (input.toolCount * 2);
	if (input.resources.length !== expectedResources || input.resources.length > MAX_RESOURCES) {
		contextError("TARGET_CONTEXT_INVALID", "Target authoring resources do not match its canonical declarations.");
	}
	const seen = new Set<string>();
	for (const resource of input.resources) {
		const identity = classifyTargetAuthoringResourcePath(resource.path);
		if (
			!identity || seen.has(resource.path) || identity.kind !== resource.kind ||
			identity.name !== resource.name || identity.mode !== resource.mode
		) {
			contextError("TARGET_CONTEXT_INVALID", "Target contains a noncanonical or duplicate authoring resource.");
		}
		seen.add(resource.path);
		if (!Number.isSafeInteger(resource.bytes) || resource.bytes < 0 || resource.bytes > MAX_RESOURCE_BYTES) {
			contextError("TARGET_RESOURCE_TOO_LARGE", "A declared Target resource exceeds the authoring context limit.");
		}
	}
	const ordered = [...input.resources].sort((left, right) => left.path.localeCompare(right.path));
	const aggregateBytes = input.manifestBytes + ordered.reduce((total, resource) => total + resource.bytes, 0);
	if (aggregateBytes > MAX_CONTEXT_BYTES) {
		contextError("TARGET_RESOURCE_TOO_LARGE", "Target authoring context exceeds the aggregate byte limit.");
	}
	if (Buffer.byteLength(canonicalJson({ target: input.target, resources: ordered }), "utf8") > MAX_CONTEXT_PROJECTION_BYTES) {
		contextError("TARGET_RESOURCE_TOO_LARGE", "Target authoring overview exceeds the model-context limit.");
	}
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
	for (const declaration of manifest.tools) {
		const match = TOOL_DECLARATION.exec(declaration);
		if (!match?.[1] || toolNames.has(match[1])) {
			contextError("TARGET_CONTEXT_INVALID", "Target contains an unsafe or duplicate tool declaration.");
		}
		const name = match[1];
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
	}

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
		toolCount: manifest.tools.length,
		target,
		resources: summaries,
	});
	const contextHash = hashValue({
		algorithmId: "git-manifest-context-v1",
		target,
		manifestSha256: manifestBlob.sha256,
		resources: summaries,
	});
	const claim = TargetAuthoringContextClaimSchema.parse({
		algorithmId: "git-manifest-context-v1",
		targetId: target.id,
		targetGitSha: target.gitSha,
		contextHash,
	});

	assertCleanRevision(repositoryDir, request.expectedTarget.gitSha);
	const selected = requestedPath ? resources.get(requestedPath) : undefined;
	return {
		schemaVersion: 1,
		algorithmId: "git-manifest-context-v1",
		contextHash,
		claim,
		target,
		resources: summaries,
		...(selected ? { resource: { ...selected.summary, content: selected.content } } : {}),
		launch: "ahde target",
	};
}
