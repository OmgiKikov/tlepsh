import { basename, resolve } from "node:path";
import { inspectTargetAuthoringContext, type TargetAuthoringResource } from "../application/target-authoring-context.js";
import { listCorpora } from "../corpus.js";
import {
	isSealedEvalRun,
	listEvalRunIndexesLenient,
	loadEvalRun,
	type EvalRunRecord,
} from "../eval.js";
import { loadTarget } from "../manifest.js";
import { listSpecSnapshots } from "../spec.js";
import { targetBootstrapRequired } from "../target/readiness.js";
import { standInFilesLine } from "../target/placeholders.js";

const MAX_STATUS_ITEMS = 30;
const DEFAULT_COMPAT_READ_BYTES = 32 * 1024;

export interface BuilderProjectContext {
	projectDir: string;
	stateRoot: string;
	runsRoot: string;
	projectId?: string;
}

/** @deprecated Use Workbench `view({ aspect: "target" })` resource metadata. */
export interface PublicTargetFile {
	path: string;
	bytes: number;
}

/** @deprecated Use Workbench `view({ aspect: "target", resourcePath })`. */
export interface PublicTargetRead extends PublicTargetFile {
	sha256: string;
	content: string;
	truncated: boolean;
}

function exactAuthoringContext(projectDir: string, resourcePath?: string) {
	const target = loadTarget(projectDir);
	return inspectTargetAuthoringContext({
		repositoryDir: projectDir,
		expectedTarget: { id: target.manifest.id, gitSha: target.gitSha },
		...(resourcePath ? { resourcePath } : {}),
	});
}

/**
 * @deprecated Compatibility adapter over the exact-Git declared-resource seam.
 * Raw manifest, orphan, dirty, and private filesystem reads now fail closed.
 */
export function readPublicTargetFile(
	projectDir: string,
	path: string,
	maxBytes = DEFAULT_COMPAT_READ_BYTES,
): PublicTargetRead {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_COMPAT_READ_BYTES) {
		throw new Error(`maxBytes must be between 1 and ${DEFAULT_COMPAT_READ_BYTES}`);
	}
	const resource = exactAuthoringContext(projectDir, path).resource;
	if (!resource) throw new Error("declared Target authoring resource was not returned");
	const raw = Buffer.from(resource.content, "utf8");
	const visible = raw.subarray(0, maxBytes);
	return {
		path: resource.path,
		bytes: resource.bytes,
		sha256: resource.sha256,
		content: visible.toString("utf8"),
		truncated: raw.length > visible.length,
	};
}

/** @deprecated Compatibility adapter returning only declared exact-Git resources. */
export function listPublicTargetFiles(projectDir: string): PublicTargetFile[] {
	try {
		return exactAuthoringContext(projectDir).resources.map(({ path, bytes }) => ({ path, bytes }));
	} catch {
		return [];
	}
}

function errorMessage(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 500);
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
	let publicTargetFiles: TargetAuthoringResource[] = [];
	try {
		const resolved = loadTarget(context.projectDir);
		targetId = resolved.manifest.id;
		const bootstrapRequired = targetBootstrapRequired(resolved.manifest);
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
		try {
			publicTargetFiles = inspectTargetAuthoringContext({
				repositoryDir: context.projectDir,
				expectedTarget: { id: resolved.manifest.id, gitSha: resolved.gitSha },
			}).resources;
		} catch (error) {
			warnings.push(`target authoring context: ${errorMessage(error)}`);
		}
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
		const listed = listEvalRunIndexesLenient(context.runsRoot);
		if (listed.invalid.length > 0) {
			warnings.push(`evals: ${listed.invalid.length} legacy eval run index(es) ignored; not comparable with the current evidence schema`);
		}
		evals = listed.records
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
		publicTargetFiles,
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
