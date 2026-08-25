import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

export const GraderSpec = z.discriminatedUnion("type", [
	ToolCalledGrader,
	OutputContainsGrader,
	OutputMatchesGrader,
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

export const TargetManifest = z.strictObject({
	id: z
		.string()
		.regex(/^[a-z0-9][a-z0-9-]*$/, "target id: lowercase kebab-case"),
	model: z.strictObject({
		provider: z.string().min(1),
		id: z.string().min(1),
		api: z.string().min(1),
		baseUrl: z.string().url(),
		apiKeyEnv: z.string().min(1),
		thinkingLevel: ThinkingLevel,
		timeoutMs: z.number().int().positive(),
		params: z.record(z.string(), z.unknown()).default({}),
	}),
	instructions: z.strictObject({
		agentsMd: z.string().min(1),
	}),
	skills: z.array(z.string().min(1)).default([]),
	evalSuite: z.strictObject({
		id: z.string().min(1),
		dataset: z.string().min(1),
		graders: z.string().min(1),
	}),
});
export type TargetManifest = z.infer<typeof TargetManifest>;

// ---------- Resolved target ----------

export interface PiRuntimeInfo {
	piVersion: string;
	piSha: string;
}

export interface ResolvedTarget {
	/** Absolute path to the target repo root. */
	dir: string;
	manifest: TargetManifest;
	/** git HEAD sha of the target repo. */
	gitSha: string;
	runtime: PiRuntimeInfo;
	/** Parsed dataset tasks in file order. */
	tasks: ResolvedTask[];
	/** Hash of the raw parsed dataset (task ids, inputs, per-task graders). */
	datasetHash: string;
	/** Hash of the effective scoring config: dataset + suite grader defaults. */
	suiteHash: string;
}

const HARNESS_ROOT = resolve(fileURLToPath(import.meta.url), "../..");

export function piRuntimeInfo(): PiRuntimeInfo {
	const pkg = JSON.parse(
		readFileSync(join(HARNESS_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"),
	) as { version: string };
	const sha = execFileSync("git", ["-C", join(HARNESS_ROOT, "vendor", "pi-mono"), "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
	return { piVersion: pkg.version, piSha: sha };
}

function gitSha(dir: string): string {
	return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
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
 */
export function loadTarget(dir: string): ResolvedTarget {
	const manifestResult = TargetManifest.safeParse(parseYaml(readRelative(dir, "manifest.yaml")));
	if (!manifestResult.success) {
		throw new Error(`manifest.yaml: ${manifestResult.error.message}`);
	}
	const manifest = manifestResult.data;

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

	const datasetHash = hashValue(tasks.map(({ id, input, graders }) => ({ id, input, graders: graders ?? null })));
	const suiteHash = hashValue({
		dataset: tasks.map(({ id, input, graders }) => ({ id, input, graders: graders ?? null })),
		defaults,
	});

	return {
		dir: resolve(dir),
		manifest,
		gitSha: gitSha(dir),
		runtime: piRuntimeInfo(),
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
				: `/${spec.pattern.slice(0, 24)}/`;
	return `${task.id}#${index}:${spec.type}:${detail}`;
}
