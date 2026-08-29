import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { hashValue } from "./provenance.js";
import { loadTargetTools, type ResolvedTargetTool } from "./target/tool-manifest.js";

// ---------- Grader specs (declarative, target-owned) ----------

export const ToolCalledGrader = z.strictObject({
	type: z.literal("tool_called"),
	name: z.string().optional(),
	tool: z.string(),
	argsContains: z.string().optional(),
});

export const OutputContainsGrader = z.strictObject({
	type: z.literal("output_contains"),
	name: z.string().optional(),
	text: z.string(),
	caseSensitive: z.boolean().default(false),
});

export const OutputMatchesGrader = z.strictObject({
	type: z.literal("output_matches"),
	name: z.string().optional(),
	pattern: z.string(),
});

export const JudgeGrader = z.strictObject({
	type: z.literal("judge"),
	name: z.string().optional(),
	rubric: z.string().min(1),
});

export const GraderSpec = z.discriminatedUnion("type", [
	ToolCalledGrader,
	OutputContainsGrader,
	OutputMatchesGrader,
	JudgeGrader,
]);
export type GraderSpec = z.infer<typeof GraderSpec>;

// ---------- Task / dataset ----------

export const TaskSchema = z.strictObject({
	id: z.string().min(1),
	input: z.string().min(1),
	graders: z.array(GraderSpec).optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const GradersFile = z.strictObject({
	defaults: z.array(GraderSpec).default([]),
});
export type GradersFile = z.infer<typeof GradersFile>;

export interface ResolvedTask extends Task {
	effectiveGraders: GraderSpec[];
}

// ---------- Target manifest ----------

export const ThinkingLevel = z.enum([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

const ModelThinkingLevelMap = z.strictObject({
	off: z.string().min(1).max(100).nullable().optional(),
	minimal: z.string().min(1).max(100).nullable().optional(),
	low: z.string().min(1).max(100).nullable().optional(),
	medium: z.string().min(1).max(100).nullable().optional(),
	high: z.string().min(1).max(100).nullable().optional(),
	xhigh: z.string().min(1).max(100).nullable().optional(),
	max: z.string().min(1).max(100).nullable().optional(),
});

const ModelCostTier = z.strictObject({
	inputTokensAbove: z.number().int().nonnegative(),
	input: z.number().nonnegative(),
	output: z.number().nonnegative(),
	cacheRead: z.number().nonnegative(),
	cacheWrite: z.number().nonnegative(),
});

export const ModelSpec = z.strictObject({
	reasoning: z.boolean().default(false),
	input: z.array(z.enum(["text", "image"])).min(1).max(2)
		.refine((items) => new Set(items).size === items.length, "model input modalities must be unique")
		.optional(),
	thinkingLevelMap: ModelThinkingLevelMap.optional(),
	contextWindow: z.number().int().positive().default(131072),
	maxTokens: z.number().int().positive().default(8192),
	cost: z
		.strictObject({
			input: z.number().default(0),
			output: z.number().default(0),
			cacheRead: z.number().default(0),
			cacheWrite: z.number().default(0),
			tiers: z.array(ModelCostTier).max(32).optional(),
		})
		.default({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
	compat: z.record(z.string(), z.unknown()).default({}),
});
export type ModelSpec = z.infer<typeof ModelSpec>;

export const ExecutionPolicyBlock = z.strictObject({
	tools: z.array(z.enum(["read", "bash", "edit", "write"])).min(1).default(["read", "bash"]),
	environmentAllowlist: z
		.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
		.default([]),
	network: z.enum(["deny", "allow"]).default("deny"),
	sandbox: z.enum(["required", "best-effort", "off"]).default("best-effort"),
});
export type ExecutionPolicyBlock = z.infer<typeof ExecutionPolicyBlock>;

const RESERVED_MODEL_PARAMS = new Set(["model", "messages", "stream", "tools"]);

export const ModelBlock = z.strictObject({
	provider: z.string().min(1),
	id: z.string().min(1),
	api: z.string().min(1),
	baseUrl: z.string().url(),
	apiKeyEnv: z.string().min(1),
	thinkingLevel: ThinkingLevel,
	timeoutMs: z.number().int().positive(),
	params: z.record(z.string(), z.unknown()).default({}),
	/** Full model definition passthrough for the generated models.json. */
	spec: ModelSpec.default(ModelSpec.parse({})),
}).superRefine((model, context) => {
	for (const key of Object.keys(model.params)) {
		if (RESERVED_MODEL_PARAMS.has(key)) {
			context.addIssue({
				code: "custom",
				path: ["params", key],
				message: `model.params cannot override reserved request field "${key}"`,
			});
		}
	}
});

export const TargetManifest = z.strictObject({
	id: z
		.string()
		.regex(/^[a-z0-9][a-z0-9-]*$/, "target id: lowercase kebab-case"),
	model: ModelBlock,
	execution: ExecutionPolicyBlock.default(ExecutionPolicyBlock.parse({})),
	instructions: z.strictObject({
		agentsMd: z.string().min(1),
	}),
	skills: z.array(z.string().min(1)).default([]),
	/** Explicit target-owned subprocess descriptors. Ambient discovery is disabled. */
	tools: z.array(z.string().min(1)).default([]),
	evalSuite: z.strictObject({
		id: z.string().min(1),
		dataset: z.string().min(1),
		graders: z.string().min(1),
		/** Judge model for judge graders; required when any task uses one. */
		judge: ModelBlock.optional(),
	}),
});
export type TargetManifest = z.infer<typeof TargetManifest>;

// ---------- Resolved target ----------

export interface RuntimeInfo {
	piVersion: string;
	piSha: string;
	ahdeVersion: string;
	ahdeCodeHash: string;
}

export interface ResolvedTarget {
	/** Absolute path to the target repo root. */
	dir: string;
	manifest: TargetManifest;
	/**
	 * Evaluation inputs that must never be copied into an agent workspace.
	 * Includes both the manifest dataset and any explicit dataset override.
	 */
	evaluationFiles: string[];
	/** git HEAD sha of the target repo. */
	gitSha: string;
	runtime: RuntimeInfo;
	/** Validated declarative tools, sorted by tool name. */
	tools: ResolvedTargetTool[];
	/** Content hash of normalized descriptors and executable bytes. */
	toolsetHash: string;
	/** Parsed dataset tasks in file order. */
	tasks: ResolvedTask[];
	/** Hash of the raw parsed dataset (task ids, inputs, per-task graders). */
	datasetHash: string;
	/** Hash of the effective scoring config: dataset + suite grader defaults. */
	suiteHash: string;
}

const HARNESS_ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const LOCAL_ARTIFACT_GITIGNORE =
	"# AHDE local state, Builder imports, run evidence, and secrets\n/.ahde/\n/imports/\n/runs/\n/.env\n/.env.*\n!/.env.example\n";

function sourceFiles(root: string, directory = root): { name: string; content: string }[] {
	const files: { name: string; content: string }[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const absolute = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...sourceFiles(root, absolute));
		} else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
			files.push({ name: relative(root, absolute), content: readFileSync(absolute, "utf8") });
		}
	}
	return files.sort((a, b) => a.name.localeCompare(b.name));
}

function packageJsonFor(packageName: string): Record<string, unknown> {
	let cursor = HARNESS_ROOT;
	for (;;) {
		const candidate = join(cursor, "node_modules", ...packageName.split("/"), "package.json");
		if (existsSync(candidate)) {
			const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
			if (parsed.name === packageName) return parsed;
		}
		const parent = dirname(cursor);
		if (parent === cursor) throw new Error(`cannot locate package.json for ${packageName}`);
		cursor = parent;
	}
}

function addLocalArtifactIgnores(targetDir: string): void {
	const path = join(targetDir, ".gitignore");
	let existing = "";
	if (existsSync(path)) {
		if (!lstatSync(path).isFile()) throw new Error("template .gitignore must be a regular file");
		existing = readFileSync(path, "utf8");
		if (existing.endsWith(LOCAL_ARTIFACT_GITIGNORE)) return;
	}
	const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
	writeFileSync(path, `${existing}${separator}${LOCAL_ARTIFACT_GITIGNORE}`);
}

/** Scaffold a new target from a working template (copy + fresh git init). */
export function scaffoldTarget(templateDir: string, destDir: string): string {
	if (existsSync(destDir)) throw new Error(`target dir already exists: ${destDir}`);
	const source = resolve(templateDir);
	readFileSync(join(source, "manifest.yaml")); // template must be a target
	cpSync(source, resolve(destDir), {
		recursive: true,
		filter: (p) => !relative(source, p).split(sep).includes(".git"),
	});
	addLocalArtifactIgnores(resolve(destDir));
	execFileSync("git", ["-C", destDir, "init", "-q"]);
	execFileSync("git", ["-C", destDir, "add", "."]);
	execFileSync("git", ["-C", destDir, "-c", "user.name=ahde", "-c", "user.email=ahde@local", "commit", "-qm", "scaffold from template"]);
	return resolve(destDir);
}

/**
 * Hashing every AHDE source file costs ~1.3 MB of IO, and `loadTarget` runs on
 * every inventory read and every task. AHDE's own source cannot change inside a
 * running process, so the answer is computed once and shared.
 */
let memoizedRuntimeInfo: RuntimeInfo | undefined;

export function runtimeInfo(): RuntimeInfo {
	if (memoizedRuntimeInfo) return memoizedRuntimeInfo;
	memoizedRuntimeInfo = computeRuntimeInfo();
	return memoizedRuntimeInfo;
}

function computeRuntimeInfo(): RuntimeInfo {
	const piPkg = packageJsonFor("@earendil-works/pi-coding-agent") as { version: string; gitHead?: string };
	const ahdePkg = JSON.parse(readFileSync(join(HARNESS_ROOT, "package.json"), "utf8")) as {
		version: string;
		ahde?: { piSha?: string };
	};
	const piSha = ahdePkg.ahde?.piSha ?? piPkg.gitHead;
	if (!piSha || !/^[0-9a-f]{40}$/.test(piSha)) {
		throw new Error("package metadata is missing ahde.piSha; the runtime cannot prove its Pi revision");
	}
	const sourceDir = existsSync(join(HARNESS_ROOT, "src")) ? join(HARNESS_ROOT, "src") : join(HARNESS_ROOT, "dist");
	const sources = sourceFiles(sourceDir);
	return {
		piVersion: piPkg.version,
		piSha,
		ahdeVersion: ahdePkg.version,
		ahdeCodeHash: hashValue(sources),
	};
}

function gitSha(dir: string): string {
	const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const status = execFileSync("git", ["-C", dir, "status", "--porcelain=v1", "--untracked-files=all"], {
		encoding: "utf8",
	});
	if (!status.trim()) return head;

	const diff = execFileSync("git", ["-C", dir, "diff", "--binary", "HEAD"], { encoding: "utf8" });
	const untracked = execFileSync("git", ["-C", dir, "ls-files", "--others", "--exclude-standard", "-z"], {
		encoding: "utf8",
	})
		.split("\0")
		.filter(Boolean)
		.sort()
		.map((path) => ({ path, content: readFileSync(resolve(dir, path)).toString("base64") }));
	const dirtyHash = hashValue({ diff, untracked }).slice("sha256:".length, "sha256:".length + 12);
	return `${head}-dirty-${dirtyHash}`;
}

function targetFilePath(dir: string, rel: string): string {
	if (isAbsolute(rel) || rel.includes("\0")) throw new Error(`target path must be relative: ${rel}`);
	const root = realpathSync(resolve(dir));
	const lexicalPath = resolve(root, rel);
	const lexicalRelative = relative(root, lexicalPath);
	if (!lexicalRelative || lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
		throw new Error(`target path escapes repository: ${rel}`);
	}
	const realPath = realpathSync(lexicalPath);
	const realRelative = relative(root, realPath);
	if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
		throw new Error(`target path escapes repository through a symlink: ${rel}`);
	}
	return realPath;
}

function readRelative(dir: string, rel: string): string {
	return readFileSync(targetFilePath(dir, rel), "utf8");
}

function loadDataset(dir: string, rel: string): Task[] {
	const content = readRelative(dir, rel);
	const tasks: Task[] = [];
	for (const [i, line] of content.split("\n").entries()) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			throw new Error(`dataset ${rel} line ${i + 1}: invalid JSON (${(error as Error).message})`);
		}
		const result = TaskSchema.safeParse(parsed);
		if (!result.success) {
			throw new Error(`dataset ${rel} line ${i + 1}: ${result.error.message}`);
		}
		tasks.push(result.data);
	}
	if (tasks.length === 0) throw new Error(`dataset ${rel}: no tasks`);
	const ids = new Set(tasks.map((t) => t.id));
	if (ids.size !== tasks.length) throw new Error(`dataset ${rel}: duplicate task ids`);
	for (const task of tasks) {
		for (const grader of task.graders ?? []) {
			if (grader.type !== "output_matches") continue;
			try {
				new RegExp(grader.pattern);
			} catch (error) {
				throw new Error(`dataset ${rel} task ${task.id}: invalid output_matches regex (${(error as Error).message})`);
			}
		}
	}
	return tasks;
}

/**
 * Load and fully resolve a target: manifest validation, dataset + grader
 * parsing, provenance hashes. Throws with a precise message on any violation.
 * `override.dataset` swaps the dataset file (development/holdout split) —
 * hashes and run records reflect the override.
 */
export function loadTarget(dir: string, override?: { dataset?: string }): ResolvedTarget {
	const manifestResult = TargetManifest.safeParse(parseYaml(readRelative(dir, "manifest.yaml")));
	if (!manifestResult.success) {
		throw new Error(`manifest.yaml: ${manifestResult.error.message}`);
	}
	const manifest = manifestResult.data;
	const manifestDataset = manifest.evalSuite.dataset;
	if (override?.dataset) manifest.evalSuite.dataset = override.dataset;

	for (const rel of [manifest.instructions.agentsMd, ...manifest.skills.map((s) => `${s}/SKILL.md`), manifest.evalSuite.dataset, manifest.evalSuite.graders]) {
		// existence checked by reads below; keep list explicit for error clarity
		void rel;
	}
	readRelative(dir, manifest.instructions.agentsMd);
	for (const skill of manifest.skills) readRelative(dir, `${skill}/SKILL.md`);

	const tasks = loadDataset(dir, manifest.evalSuite.dataset);
	const gradersResult = GradersFile.safeParse(parseYaml(readRelative(dir, manifest.evalSuite.graders)));
	if (!gradersResult.success) {
		throw new Error(`${manifest.evalSuite.graders}: ${gradersResult.error.message}`);
	}
	const defaults = gradersResult.data.defaults;
	const targetTools = loadTargetTools(dir, manifest.tools, manifest.execution);

	const resolved: ResolvedTask[] = tasks.map((task) => {
		const graders = task.graders ?? defaults;
		if (graders.length === 0) {
			throw new Error(`task ${task.id}: no graders (no per-task graders and suite defaults are empty)`);
		}
		return { ...task, effectiveGraders: graders };
	});
	for (const task of resolved) {
		for (const grader of task.effectiveGraders) {
			if (grader.type !== "output_matches") continue;
			try {
				new RegExp(grader.pattern);
			} catch (error) {
				throw new Error(`task ${task.id}: invalid output_matches regex (${(error as Error).message})`);
			}
		}
	}

	if (resolved.some((t) => t.effectiveGraders.some((g) => g.type === "judge")) && !manifest.evalSuite.judge) {
		throw new Error("dataset uses judge graders but evalSuite.judge model is not configured");
	}

	const datasetHash = hashValue(tasks.map(({ id, input, graders }) => ({ id, input, graders: graders ?? null })));
	const suiteHash = hashValue({
		dataset: tasks.map(({ id, input, graders }) => ({ id, input, graders: graders ?? null })),
		defaults,
		judge: manifest.evalSuite.judge ?? null,
	});

	return {
		dir: resolve(dir),
		manifest,
		evaluationFiles: [...new Set([manifestDataset, manifest.evalSuite.dataset, manifest.evalSuite.graders])],
		gitSha: gitSha(dir),
		runtime: runtimeInfo(),
		tools: targetTools.tools,
		toolsetHash: targetTools.toolsetHash,
		tasks: resolved,
		datasetHash,
		suiteHash,
	};
}

/** Display name for a grader spec. */
export function graderName(spec: GraderSpec, task: { id: string }, index: number): string {
	if (spec.name) return spec.name;
	const detail =
		spec.type === "tool_called"
			? `${spec.tool}${spec.argsContains ? `(${spec.argsContains})` : ""}`
			: spec.type === "output_contains"
				? `"${spec.text.slice(0, 24)}"`
				: spec.type === "judge"
					? `"${spec.rubric.slice(0, 24)}"`
					: `/${spec.pattern.slice(0, 24)}/`;
	return `${task.id}#${index}:${spec.type}:${detail}`;
}
