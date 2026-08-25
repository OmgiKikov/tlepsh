import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { hashValue } from "./provenance.js";

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

export const ModelSpec = z.strictObject({
	reasoning: z.boolean().default(false),
	contextWindow: z.number().int().positive().default(131072),
	maxTokens: z.number().int().positive().default(8192),
	cost: z
		.strictObject({
			input: z.number().default(0),
			output: z.number().default(0),
			cacheRead: z.number().default(0),
			cacheWrite: z.number().default(0),
		})
		.default({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
	compat: z.record(z.string(), z.unknown()).default({}),
});
export type ModelSpec = z.infer<typeof ModelSpec>;

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
});

export const TargetManifest = z.strictObject({
	id: z
		.string()
		.regex(/^[a-z0-9][a-z0-9-]*$/, "target id: lowercase kebab-case"),
	model: ModelBlock,
	instructions: z.strictObject({
		agentsMd: z.string().min(1),
	}),
	skills: z.array(z.string().min(1)).default([]),
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
	/** git HEAD sha of the target repo. */
	gitSha: string;
	runtime: RuntimeInfo;
	/** Parsed dataset tasks in file order. */
	tasks: ResolvedTask[];
	/** Hash of the raw parsed dataset (task ids, inputs, per-task graders). */
	datasetHash: string;
	/** Hash of the effective scoring config: dataset + suite grader defaults. */
	suiteHash: string;
}

const HARNESS_ROOT = resolve(fileURLToPath(import.meta.url), "../..");

/** Scaffold a new target from a working template (copy + fresh git init). */
export function scaffoldTarget(templateDir: string, destDir: string): string {
	if (existsSync(destDir)) throw new Error(`target dir already exists: ${destDir}`);
	const source = resolve(templateDir);
	readFileSync(join(source, "manifest.yaml")); // template must be a target
	cpSync(source, resolve(destDir), {
		recursive: true,
		filter: (p) => !relative(source, p).split(sep).includes(".git"),
	});
	execFileSync("git", ["-C", destDir, "init", "-q"]);
	execFileSync("git", ["-C", destDir, "add", "."]);
	execFileSync("git", ["-C", destDir, "-c", "user.name=ahde", "-c", "user.email=ahde@local", "commit", "-qm", "scaffold from template"]);
	return resolve(destDir);
}

export function runtimeInfo(): RuntimeInfo {
	const piPkg = JSON.parse(
		readFileSync(join(HARNESS_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"),
	) as { version: string };
	const ahdePkg = JSON.parse(readFileSync(join(HARNESS_ROOT, "package.json"), "utf8")) as { version: string };
	const piSha = execFileSync("git", ["-C", join(HARNESS_ROOT, "vendor", "pi-mono"), "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
	const sourceDir = join(HARNESS_ROOT, "src");
	const sources = readdirSync(sourceDir)
		.filter((name) => name.endsWith(".ts"))
		.sort()
		.map((name) => ({ name, content: readFileSync(join(sourceDir, name), "utf8") }));
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

function readRelative(dir: string, rel: string): string {
	return readFileSync(resolve(dir, rel), "utf8");
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

	const resolved: ResolvedTask[] = tasks.map((task) => {
		const graders = task.graders ?? defaults;
		if (graders.length === 0) {
			throw new Error(`task ${task.id}: no graders (no per-task graders and suite defaults are empty)`);
		}
		return { ...task, effectiveGraders: graders };
	});

	if (resolved.some((t) => t.effectiveGraders.some((g) => g.type === "judge")) && !manifest.evalSuite.judge) {
		throw new Error("dataset uses judge graders but evalSuite.judge model is not configured");
	}

	const datasetHash = hashValue(tasks.map(({ id, input, graders }) => ({ id, input, graders: graders ?? null })));
	const suiteHash = hashValue({
		dataset: tasks.map(({ id, input, graders }) => ({ id, input, graders: graders ?? null })),
		defaults,
	});

	return {
		dir: resolve(dir),
		manifest,
		gitSha: gitSha(dir),
		runtime: runtimeInfo(),
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
