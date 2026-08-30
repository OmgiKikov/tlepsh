import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadTarget } from "../manifest.js";
import { redactTraceText } from "../trace.js";
import { withDetachedWorktree } from "../git/experiment-worktree.js";
import {
	disposeTargetWorkspaceSnapshot,
	materializeTargetWorkspaceSnapshot,
} from "../runner.js";
import {
	TargetToolBroker,
	detectTargetToolSandbox,
	type TargetToolSandboxBackend,
} from "../target/tool-broker.js";
import { prepareToolHome, type ToolSetupOutcome } from "../target/tool-setup.js";
import { loadTargetTools, type TargetToolLayout } from "../target/tool-manifest.js";
import {
	compileHarnessAuthoringProposal,
	type HarnessAuthoringIntent,
} from "./harness-authoring.js";

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
		kind: ToolWorkshopSource["kind"];
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
		const target = loadTarget(worktree.path);
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
				source: { kind: source.kind, ref: source.kind === "branch" ? source.ref : null, changedPaths },
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
	});
}
