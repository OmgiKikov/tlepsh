import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { listCorpora } from "../corpus.js";
import {
	isSealedEvalRun,
	listEvalRunIndexes,
	loadEvalRun,
	type EvalRunRecord,
} from "../eval.js";
import { loadTarget } from "../manifest.js";
import { listSpecSnapshots } from "../spec.js";

const DEFAULT_READ_BYTES = 32 * 1024;
const MAX_PUBLIC_FILE_BYTES = 1024 * 1024;
const MAX_PUBLIC_FILES = 200;
const MAX_STATUS_ITEMS = 30;

export interface BuilderProjectContext {
	projectDir: string;
	stateRoot: string;
	runsRoot: string;
	projectId?: string;
}

export interface PublicTargetFile {
	path: string;
	bytes: number;
}

export interface PublicTargetRead extends PublicTargetFile {
	sha256: string;
	content: string;
	truncated: boolean;
}

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function contained(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function normalizedPublicPath(input: string): string {
	if (
		input.length === 0 ||
		input !== input.trim() ||
		isAbsolute(input) ||
		input.includes("\\") ||
		input.includes("\0")
	) {
		throw new Error("target path must be a normalized repository-relative path");
	}
	const segments = input.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.startsWith("."))) {
		throw new Error("target path contains a forbidden path segment");
	}
	const exact = input === "AGENTS.md" || input === "manifest.yaml";
	const scoped = segments.length > 1 && ["skills", "tools", "bin"].includes(segments[0] ?? "");
	if (!exact && !scoped) {
		throw new Error("Builder may read only AGENTS.md, manifest.yaml, skills/**, tools/**, or bin/**");
	}
	return input;
}

function publicFilePath(projectDir: string, input: string): string {
	const root = resolve(projectDir);
	if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
		throw new Error(`target root must be a regular directory: ${root}`);
	}
	const path = resolve(root, normalizedPublicPath(input));
	if (!contained(root, path)) throw new Error("target path escaped the target root");
	if (!existsSync(path)) throw new Error(`public target file does not exist: ${input}`);
	const entry = lstatSync(path);
	if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`public target path is not a regular file: ${input}`);
	const canonicalRoot = realpathSync(root);
	const canonicalPath = realpathSync(path);
	if (!contained(canonicalRoot, canonicalPath)) throw new Error("target path escaped through a symlink");
	return canonicalPath;
}

export function readPublicTargetFile(
	projectDir: string,
	path: string,
	maxBytes = DEFAULT_READ_BYTES,
): PublicTargetRead {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_READ_BYTES) {
		throw new Error(`maxBytes must be between 1 and ${DEFAULT_READ_BYTES}`);
	}
	const absolute = publicFilePath(projectDir, path);
	const bytes = statSync(absolute).size;
	if (bytes > MAX_PUBLIC_FILE_BYTES) {
		throw new Error(`public target file exceeds the ${MAX_PUBLIC_FILE_BYTES}-byte inspection limit: ${path}`);
	}
	const raw = readFileSync(absolute);
	const visible = raw.subarray(0, maxBytes);
	return {
		path: normalizedPublicPath(path),
		bytes,
		sha256: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
		content: visible.toString("utf8"),
		truncated: raw.length > visible.length,
	};
}

function walkPublicDirectory(root: string, relativeDir: string, output: PublicTargetFile[]): void {
	if (output.length >= MAX_PUBLIC_FILES) return;
	const absolute = join(root, relativeDir);
	if (!existsSync(absolute)) return;
	const directory = lstatSync(absolute);
	if (!directory.isDirectory() || directory.isSymbolicLink()) return;
	for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (output.length >= MAX_PUBLIC_FILES || entry.name.startsWith(".")) break;
		const path = `${relativeDir}/${entry.name}`;
		if (entry.isDirectory() && !entry.isSymbolicLink()) walkPublicDirectory(root, path, output);
		else if (entry.isFile() && !entry.isSymbolicLink()) output.push({ path, bytes: statSync(join(root, path)).size });
	}
}

export function listPublicTargetFiles(projectDir: string): PublicTargetFile[] {
	const root = resolve(projectDir);
	if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return [];
	const files: PublicTargetFile[] = [];
	for (const path of ["AGENTS.md", "manifest.yaml"]) {
		const absolute = join(root, path);
		if (existsSync(absolute) && lstatSync(absolute).isFile() && !lstatSync(absolute).isSymbolicLink()) {
			files.push({ path, bytes: statSync(absolute).size });
		}
	}
	for (const directory of ["skills", "tools", "bin"]) walkPublicDirectory(root, directory, files);
	return files.slice(0, MAX_PUBLIC_FILES);
}

export function resolveBuilderProjectId(context: BuilderProjectContext): string {
	if (context.projectId) return context.projectId;
	try {
		return loadTarget(context.projectDir).manifest.id;
	} catch {
		return basename(resolve(context.projectDir)).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128) || "target";
	}
}

export function resolveBuilderTargetId(context: BuilderProjectContext): string | null {
	try {
		return loadTarget(context.projectDir).manifest.id;
	} catch {
		return null;
	}
}

export interface EvalSummary {
	evalRunId: string;
	target: EvalRunRecord["target"];
	label: EvalRunRecord["label"];
	dataset: string;
	repetitions: number;
	startedAt: string;
	finishedAt: string;
	summary: EvalRunRecord["summary"];
}

export function summarizeEvalRun(record: EvalRunRecord): EvalSummary {
	return {
		evalRunId: record.evalRunId,
		target: record.target,
		label: record.label,
		dataset: record.dataset,
		repetitions: record.repetitions,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		summary: record.summary,
	};
}

/** A bounded, metadata-only view. Sealed corpus task content is never returned. */
export function buildProjectStatus(context: BuilderProjectContext): Record<string, unknown> {
	const projectId = resolveBuilderProjectId(context);
	const warnings: string[] = [];
	let target: Record<string, unknown>;
	let targetId: string | null = null;
	try {
		const resolved = loadTarget(context.projectDir);
		targetId = resolved.manifest.id;
		const bootstrapRequired = resolved.manifest.id === "my-agent" || resolved.manifest.model.id === "replace-with-model-id";
		target = {
			status: bootstrapRequired ? "bootstrap-required" : "ready",
			id: resolved.manifest.id,
			gitSha: resolved.gitSha,
			model: { provider: resolved.manifest.model.provider, id: resolved.manifest.model.id },
			skills: resolved.manifest.skills,
			execution: resolved.manifest.execution,
			developmentTaskCount: resolved.tasks.length,
			...(bootstrapRequired ? { nextAction: "ahde_target_configure_model" } : {}),
		};
	} catch (error) {
		target = { status: "not-ready", error: errorMessage(error) };
	}

	let specs: ReturnType<typeof listSpecSnapshots> = [];
	try {
		specs = listSpecSnapshots(context.stateRoot, projectId).slice(0, MAX_STATUS_ITEMS);
	} catch (error) {
		warnings.push(`specs: ${errorMessage(error)}`);
	}
	let corpora: ReturnType<typeof listCorpora> = [];
	try {
		corpora = listCorpora({ stateRoot: context.stateRoot, projectId });
	} catch {
		warnings.push("corpora: metadata unavailable; sealed identities remain hidden");
	}
	let evals: EvalSummary[] = [];
	try {
		const sealedCorpora = corpora.filter((corpus) => corpus.visibility === "sealed");
		const sealedHashes = new Set(sealedCorpora.map((corpus) => corpus.hash));
		evals = listEvalRunIndexes(context.runsRoot)
			.filter((record) => targetId === null || record.target.id === targetId)
			.filter((record) => !isSealedEvalRun(record, sealedHashes))
			.map((record) => loadEvalRun(context.runsRoot, record.evalRunId))
			.slice(0, MAX_STATUS_ITEMS)
			.map(summarizeEvalRun);
	} catch {
		warnings.push("evals: evidence metadata unavailable; sealed identities remain hidden");
	}

	return {
		project: { id: projectId, directory: basename(resolve(context.projectDir)) },
		target,
		publicTargetFiles: listPublicTargetFiles(context.projectDir),
		specs: specs.map(({ id, status, createdAt, sourceHash }) => ({ id, status, createdAt, sourceHash })),
		corpora: {
			development: corpora
				.filter((corpus) => corpus.visibility === "development")
				.slice(0, MAX_STATUS_ITEMS)
				.map(({ id, name, visibility, taskCount, hash, createdAt }) => ({
					id,
					name,
					visibility,
					taskCount,
					hash,
					createdAt,
				})),
			sealed: { visibility: "sealed", count: corpora.filter((corpus) => corpus.visibility === "sealed").length },
		},
		evalRuns: evals,
		warnings,
	};
}
