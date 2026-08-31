import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { hashValue } from "./provenance.js";
import { CONTAINER_IMAGE_REFERENCE, isPinnedContainerImage } from "./target/container-backend.js";
import { loadTargetTools, type ResolvedTargetTool } from "./target/tool-manifest.js";

// ---------- Grader specs (declarative, target-owned) ----------

/**
 * Hard ceiling on a simulated conversation. Twelve turns is already a long
 * support dialogue; beyond it a case is measuring the user model, not the
 * agent, and the bound also caps what one Run can spend.
 */
export const MAX_SIMULATED_USER_TURNS = 12;

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

/** One rubric may carry at most this many isolated yes/no assertions. */
export const MAX_JUDGE_ASSERTIONS = 12;
export const MAX_JUDGE_ASSERTION_CHARS = 500;
/** Jurors per judge grader. Odd sizes decide; an even jury can only tie. */
export const MAX_JUDGE_JURY = 5;

export const JudgeGrader = z.strictObject({
	type: z.literal("judge"),
	name: z.string().optional(),
	/** Free-prose criterion. Optional only because `assertions` can carry it. */
	rubric: z.string().min(1).optional(),
	/**
	 * Isolated yes/no checks, one behaviour each. The judge answers every one
	 * with yes/no/unknown plus its evidence; unknown counts as no, and the
	 * grader passes only when every assertion is yes.
	 *
	 * Optional rather than defaulted for the same reason as `withReference`:
	 * canonical JSON drops an absent field, so every judge grader written
	 * before assertions existed keeps its exact spec hash and suite hash.
	 */
	assertions: z
		.array(z.string().min(1).max(MAX_JUDGE_ASSERTION_CHARS))
		.min(1)
		.max(MAX_JUDGE_ASSERTIONS)
		.optional(),
	/** Independent judge calls whose majority decides. Absent means one juror. */
	jury: z.number().int().min(1).max(MAX_JUDGE_JURY).optional(),
	/**
	 * Show the judge the case's reference answer and grade on the A–E factuality
	 * rubric instead of the rubric alone.
	 *
	 * Optional and literally `true` rather than a defaulted boolean: canonical
	 * JSON drops an absent field, so every judge grader written before reference
	 * answers existed keeps its exact spec hash and suite hash. A `false` default
	 * would silently rewrite both.
	 */
	withReference: z.literal(true).optional(),
}).superRefine((spec, context) => {
	if (spec.rubric === undefined && spec.assertions === undefined) {
		context.addIssue({
			code: "custom",
			path: ["assertions"],
			message: "a judge grader needs a rubric, assertions, or both",
		});
	}
	if (spec.assertions && new Set(spec.assertions).size !== spec.assertions.length) {
		context.addIssue({ code: "custom", path: ["assertions"], message: "assertions must be unique" });
	}
	// The A–E factuality rubric is one protocol with one answer; asking the same
	// call for per-assertion verdicts would be two contracts in one response.
	if (spec.assertions && spec.withReference) {
		context.addIssue({
			code: "custom",
			path: ["withReference"],
			message: "withReference grades on the A–E factuality rubric and cannot be combined with assertions",
		});
	}
});

/** How both sides are normalized before an exact comparison. */
export const ExactNormalizeSchema = z.enum(["trim", "lower", "none"]);
export type ExactNormalize = z.infer<typeof ExactNormalizeSchema>;

export const ExactGrader = z.strictObject({
	type: z.literal("exact"),
	name: z.string().optional(),
	/** `lower` (the default) is trim + lowercase + collapsed whitespace. */
	normalize: ExactNormalizeSchema.default("lower"),
});

export const SimilarityMetricSchema = z.enum(["token-f1", "levenshtein"]);
export type SimilarityMetric = z.infer<typeof SimilarityMetricSchema>;

export const SimilarityGrader = z.strictObject({
	type: z.literal("similarity"),
	name: z.string().optional(),
	metric: SimilarityMetricSchema,
	/** Lowest score that still passes. 1 means "identical after normalization". */
	threshold: z.number().gt(0).lte(1),
});

/**
 * How many turns the agent needed. A conversation that reaches the goal in two
 * replies is a better agent than one that reaches it in nine, and neither the
 * output nor a tool call can say so — only the shape of the transcript can.
 *
 * It counts the agent's OWN turns (assistant replies carrying text), so it is
 * meaningful on a single-message case too, where the answer is exactly one turn.
 */
export const TurnBudgetGrader = z.strictObject({
	type: z.literal("turn_budget"),
	name: z.string().optional(),
	/** Most agent turns that still passes. */
	max: z.number().int().min(1).max(MAX_SIMULATED_USER_TURNS),
});

export const GraderSpec = z.discriminatedUnion("type", [
	ToolCalledGrader,
	OutputContainsGrader,
	OutputMatchesGrader,
	JudgeGrader,
	ExactGrader,
	SimilarityGrader,
	TurnBudgetGrader,
]);
export type GraderSpec = z.infer<typeof GraderSpec>;

/**
 * Graders that decide their verdict by comparing the answer with the case's
 * reference answer. On a case without one they fail loudly rather than pass
 * vacuously, and every path that admits a dataset refuses the pairing outright.
 */
export function graderNeedsExpected(spec: GraderSpec): boolean {
	return spec.type === "exact" || spec.type === "similarity" ||
		(spec.type === "judge" && spec.withReference === true);
}

/** A reference answer that a grader can actually compare against. */
export function hasReferenceAnswer(task: { expected?: string | undefined }): boolean {
	return typeof task.expected === "string" && task.expected.trim().length > 0;
}

// ---------- Task / dataset ----------

/** A reference answer and every dialogue turn stay small enough to read whole. */
export const MAX_TASK_TEXT_BYTES = 8 * 1024;
export const MAX_TASK_MESSAGES = 40;
export const MAX_TASK_METADATA_KEYS = 8;
export const MAX_TASK_METADATA_KEY_CHARS = 64;
export const MAX_TASK_METADATA_VALUE_CHARS = 500;

function boundedTaskText(label: string) {
	return z.string().min(1).superRefine((value, context) => {
		const bytes = Buffer.byteLength(value, "utf8");
		if (bytes > MAX_TASK_TEXT_BYTES) {
			context.addIssue({ code: "custom", message: `${label} is ${bytes} bytes, over the ${MAX_TASK_TEXT_BYTES} byte bound` });
		}
	});
}

export const DialogueMessageSchema = z.strictObject({
	role: z.enum(["user", "assistant"]),
	content: boundedTaskText("message content"),
});
export type DialogueMessage = z.infer<typeof DialogueMessageSchema>;

/** Bounded provenance carried over from an imported source row. */
export const TaskMetadataSchema = z
	.record(z.string().min(1).max(MAX_TASK_METADATA_KEY_CHARS), z.string().max(MAX_TASK_METADATA_VALUE_CHARS))
	.superRefine((metadata, context) => {
		const keys = Object.keys(metadata).length;
		if (keys > MAX_TASK_METADATA_KEYS) {
			context.addIssue({ code: "custom", message: `metadata carries ${keys} keys, over the ${MAX_TASK_METADATA_KEYS} key bound` });
		}
	});
export type TaskMetadata = z.infer<typeof TaskMetadataSchema>;

/**
 * A second model that plays the human across the conversation.
 *
 * `messages` freezes a past dialogue and grades the next reply; this instead
 * lets the dialogue happen, which is the only way to measure an agent that has
 * to ask a clarifying question, recover from a vague answer, or refuse politely
 * over several turns. The user model receives exactly `goal`, `persona`,
 * `stopWhen` and the transcript so far — never the graders, the reference
 * answer, or anything about the Target's harness beyond its replies.
 */
export const SimulatedUserSpecSchema = z.strictObject({
	/** What the person is trying to achieve, in their own terms. */
	goal: boundedTaskText("simulated user goal"),
	/** Who they are and how they write. Absent means a neutral user. */
	persona: boundedTaskText("simulated user persona").optional(),
	/** Agent turns the conversation may take before the host stops it. */
	maxTurns: z.number().int().min(1).max(MAX_SIMULATED_USER_TURNS),
	/** Plain-language condition; the user model reports when it holds. */
	stopWhen: boundedTaskText("simulated user stop condition").optional(),
});
export type SimulatedUserSpec = z.infer<typeof SimulatedUserSpecSchema>;

export const TaskSchema = z.strictObject({
	id: z.string().min(1),
	input: z.string().min(1),
	/** Reference answer for graders that compare against one. */
	expected: boundedTaskText("expected answer").optional(),
	/**
	 * Conversation so far, ending in the user turn `input` repeats. Consumers
	 * that only read `input` therefore keep seeing the question that was asked.
	 */
	messages: z.array(DialogueMessageSchema).min(1).max(MAX_TASK_MESSAGES).optional(),
	/**
	 * Play the conversation instead of replaying one. `input` stays the opening
	 * user message; every later user turn comes from the user model.
	 */
	simulatedUser: SimulatedUserSpecSchema.optional(),
	metadata: TaskMetadataSchema.optional(),
	graders: z.array(GraderSpec).optional(),
});
export type Task = z.infer<typeof TaskSchema>;

/**
 * The dialogue invariant, as a function rather than a schema refinement:
 * `CorpusTaskSchema` and the Builder draft schemas override `graders`, and Zod
 * refuses to overwrite a key on an object schema that carries refinements.
 * Every path that admits a task calls this instead.
 */
export function taskDialogueIssue(task: {
	input: string;
	messages?: readonly DialogueMessage[] | undefined;
	simulatedUser?: SimulatedUserSpec | undefined;
}): string | null {
	// A frozen history and a live user are two different measurements of the
	// same turn. Carrying both would make it ambiguous which one produced the
	// turns in the trace, so a case declares exactly one.
	if (task.messages && task.simulatedUser) {
		return "a case carries messages or simulatedUser, never both";
	}
	if (!task.messages) return null;
	const last = task.messages[task.messages.length - 1];
	if (!last) return "messages must carry at least one turn";
	if (last.role !== "user") return "the last message must be the user turn";
	if (last.content !== task.input) return "the last user message must repeat input";
	return null;
}

export const GradersFile = z.strictObject({
	defaults: z.array(GraderSpec).default([]),
});
export type GradersFile = z.infer<typeof GradersFile>;

export interface ResolvedTask extends Task {
	effectiveGraders: GraderSpec[];
}

/**
 * Fill each case's effective graders and validate the resulting scoring
 * surface. A case's own graders always win; the suite defaults only fill in for
 * a case that declares none.
 *
 * `loadTarget` and `ahde regrade` both come through here, so a re-graded suite
 * is admitted by exactly the rules a freshly run one is.
 */
export function resolveTaskGraders(
	tasks: readonly Task[],
	defaults: readonly GraderSpec[],
	judgeConfigured: boolean,
	simulatedUserConfigured = false,
): ResolvedTask[] {
	const resolved: ResolvedTask[] = tasks.map((task) => {
		const graders: GraderSpec[] = task.graders ?? [...defaults];
		if (graders.length === 0) {
			throw new Error(`task ${task.id}: no graders (no per-task graders and suite defaults are empty)`);
		}
		return { ...task, effectiveGraders: graders };
	});
	for (const task of resolved) {
		for (const grader of task.effectiveGraders) {
			if (grader.type === "output_matches") {
				try {
					new RegExp(grader.pattern);
				} catch (error) {
					throw new Error(`task ${task.id}: invalid output_matches regex (${(error as Error).message})`);
				}
			}
			if (graderNeedsExpected(grader) && !hasReferenceAnswer(task)) {
				throw new Error(
					`task ${task.id}: ${grader.type} grader compares the answer with the case's reference answer, but the case has no "expected"`,
				);
			}
		}
	}
	if (resolved.some((t) => t.effectiveGraders.some((g) => g.type === "judge")) && !judgeConfigured) {
		throw new Error("dataset uses judge graders but evalSuite.judge model is not configured");
	}
	// Fail closed: a simulated-user case with no user model would silently
	// degrade to a one-turn run and produce evidence about a conversation that
	// never happened.
	if (resolved.some((t) => t.simulatedUser) && !simulatedUserConfigured) {
		const first = resolved.find((t) => t.simulatedUser);
		throw new Error(
			`task ${first?.id}: dataset uses simulated-user cases but evalSuite.simulatedUser model is not configured`,
		);
	}
	return resolved;
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

/** `data/<segment>[/<segment>…]`; lowercase, no traversal, no dotfiles. */
const DATA_DECLARATION = /^data\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
export const MAX_DATA_DIRECTORIES = 16;
export const MAX_DATA_FILES = 20_000;
/** Total declared data bytes copied into one workspace snapshot. */
export const DEFAULT_DATA_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The bound is a product decision, not a constant of nature: a retrieval agent
 * with a bigger corpus raises it deliberately through the environment.
 */
export function dataMaxBytes(environment: NodeJS.ProcessEnv = process.env): number {
	const raw = environment.AHDE_DATA_MAX_BYTES;
	if (raw === undefined) return DEFAULT_DATA_MAX_BYTES;
	if (!/^[1-9][0-9]{0,12}$/.test(raw)) {
		throw new Error(`AHDE_DATA_MAX_BYTES must be a positive integer byte count; got ${JSON.stringify(raw)}`);
	}
	return Number(raw);
}

/**
 * Container containment for the Target's built-in `bash`, its declared tools
 * and their `setup` step. Declaring this block *is* the choice of the container
 * backend — there is no second switch that could disagree with it. `runtime`
 * names which container implementation confines the run.
 *
 * A container backend changes the execution fingerprint and therefore starts a
 * new comparability class: evidence produced on the host is never reusable
 * against evidence produced in a container, by design.
 */
export const ContainerBlock = z.strictObject({
	runtime: z.enum(["docker", "gondolin"]).default("docker"),
	/** A content-pinned image. Mutable tags can never identify comparable evidence. */
	image: z
		.string()
		.min(1)
		.max(512)
		.regex(CONTAINER_IMAGE_REFERENCE, "container image must be a plain name@sha256:<digest> reference"),
	memoryMb: z.number().int().min(1).max(65_536).optional(),
	cpus: z.number().min(0.1).max(64).optional(),
	pidsLimit: z.number().int().min(1).max(4_096).optional(),
	readOnlyRootfs: z.boolean().default(true),
});
export type ContainerBlock = z.infer<typeof ContainerBlock>;

export const ExecutionPolicyBlock = z
	.strictObject({
		tools: z.array(z.enum(["read", "bash", "edit", "write"])).min(1).default(["read", "bash"]),
		environmentAllowlist: z
			.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
			.default([]),
		network: z.enum(["deny", "allow"]).default("deny"),
		sandbox: z.enum(["required", "best-effort", "off"]).default("best-effort"),
		container: ContainerBlock.optional(),
	})
	.superRefine((execution, context) => {
		if (!execution.container) return;
		if (execution.sandbox === "off") {
			context.addIssue({
				code: "custom",
				path: ["container"],
				message: "execution.container requires sandbox: required or best-effort; sandbox: off declares no containment",
			});
			return;
		}
		if (!isPinnedContainerImage(execution.container.image)) {
			context.addIssue({
				code: "custom",
				path: ["container", "image"],
				message:
					`execution.container.image must be pinned to a digest (name@sha256:…); mutable tags cannot identify comparable evidence; got ${execution.container.image}`,
			});
		}
	});
export type ExecutionPolicyBlock = z.infer<typeof ExecutionPolicyBlock>;

const RESERVED_MODEL_PARAMS = new Set(["model", "messages", "stream", "tools"]);

const ModelBlockShape = z.strictObject({
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

function reservedModelParams(
	model: { params: Record<string, unknown> },
	context: z.RefinementCtx,
): void {
	for (const key of Object.keys(model.params)) {
		if (RESERVED_MODEL_PARAMS.has(key)) {
			context.addIssue({
				code: "custom",
				path: ["params", key],
				message: `model.params cannot override reserved request field "${key}"`,
			});
		}
	}
}

export const ModelBlock = ModelBlockShape.superRefine(reservedModelParams);

/**
 * The judge is a measuring instrument: eval.ts pins it to temperature 0 after
 * the params spread. Declaring one here would be a promise the request cannot
 * keep, so the manifest refuses it instead of silently ignoring it. The Target
 * model is free to set its own temperature — that is a recorded axis.
 *
 * The simulated user is the same kind of instrument for the same reason: it is
 * part of what a case measures with, so it is pinned and refuses the override.
 */
const RESERVED_JUDGE_PARAMS = new Set(["temperature"]);

function reservedTemperatureParam(field: string) {
	return (model: { params: Record<string, unknown> }, context: z.RefinementCtx): void => {
		for (const key of Object.keys(model.params)) {
			if (RESERVED_JUDGE_PARAMS.has(key)) {
				context.addIssue({
					code: "custom",
					path: ["params", key],
					message: `${field}.params cannot set "${key}": ${
						field === "evalSuite.judge"
							? "the judge is pinned to temperature 0 so grading is deterministic"
							: "the simulated user is pinned to temperature 0 so a measured conversation is reproducible"
					}`,
				});
			}
		}
	};
}

/**
 * Promotion policy for judge-graded evidence: how well this project's judge
 * must agree with its human labels (`ahde label`) before evidence that leans on
 * it may be promoted. Absent by default — measuring agreement is worth doing
 * long before it is worth blocking on.
 */
export const JudgeCalibrationPolicy = z.strictObject({
	/** Lowest human/judge agreement rate that still promotes. */
	minAgreement: z.number().min(0).max(1),
	/** Fewest labels that make that rate mean anything. */
	minLabels: z.number().int().positive().max(100_000),
	/**
	 * Count labels written under the old labelling screen, which showed the
	 * human the first user turn and the last assistant reply — never the rubric,
	 * the assertions, the reference answer, or the conversation the judge
	 * actually read. Those humans graded a different object, so by default they
	 * do not certify this judge. Absent means false: the safe direction, and
	 * canonical JSON drops the key, so every existing manifest hashes unchanged.
	 */
	allowLegacyLabels: z.literal(true).optional(),
});
export type JudgeCalibrationPolicy = z.infer<typeof JudgeCalibrationPolicy>;

export const JudgeModelBlock = ModelBlockShape
	.extend({ requireCalibration: JudgeCalibrationPolicy.optional() })
	.superRefine(reservedModelParams)
	.superRefine(reservedTemperatureParam("evalSuite.judge"));

/**
 * The model that plays the user. Same shape and same credential handling as the
 * judge — one variable name in the manifest, the value read from the host
 * environment at call time and never written to any artifact — because it is
 * the same kind of thing: an evaluation input the operator configures once, and
 * a value no Builder tool ever sees.
 */
export const SimulatedUserModelBlock = ModelBlockShape
	.superRefine(reservedModelParams)
	.superRefine(reservedTemperatureParam("evalSuite.simulatedUser"));

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
	/**
	 * Declared data directories under `data/`. Only these are copied into a
	 * Target workspace snapshot and hashed into its workspace identity;
	 * everything else under `data/` stays private to the operator's checkout.
	 */
	data: z
		.array(z.string().min(1).max(200).regex(DATA_DECLARATION, "data declarations are directories under data/"))
		.max(MAX_DATA_DIRECTORIES)
		.default([])
		.superRefine((declarations, context) => {
			if (new Set(declarations).size !== declarations.length) {
				context.addIssue({ code: "custom", message: "duplicate data directory declaration" });
			}
			for (const outer of declarations) {
				for (const inner of declarations) {
					if (outer !== inner && inner.startsWith(`${outer}/`)) {
						context.addIssue({ code: "custom", message: `data declaration ${inner} is nested inside ${outer}` });
					}
				}
			}
		}),
	evalSuite: z.strictObject({
		id: z.string().min(1),
		dataset: z.string().min(1),
		graders: z.string().min(1),
		/** Judge model for judge graders; required when any task uses one. */
		judge: JudgeModelBlock.optional(),
		/** User model for simulated-user cases; required when any task uses one. */
		simulatedUser: SimulatedUserModelBlock.optional(),
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

/** Bounded shape of one declared data directory. Contents are never loaded. */
export interface ResolvedTargetDataDirectory {
	path: string;
	files: number;
	bytes: number;
	/** Sorted, bounded sample of directory-relative file paths. */
	entries: string[];
	entriesTruncated: boolean;
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
	/** Declared data directories in manifest order, with shape only. */
	data: ResolvedTargetDataDirectory[];
	/** Parsed dataset tasks in file order. */
	tasks: ResolvedTask[];
	/** Suite grader defaults, exactly as the manifest's graders file declares them. */
	graderDefaults: GraderSpec[];
	/**
	 * Which rule produced `suiteHash`. `manifest` means the formula in
	 * `suiteHashOf` over this dataset, these defaults, and the judge; `corpus`
	 * means a published snapshot fixed the identity and no caller may recompute
	 * it — every corpus case carries explicit graders, so suite defaults cannot
	 * change a verdict and must not change the hash.
	 */
	suiteIdentity: "manifest" | "corpus";
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

/**
 * The scored surface of one task. Optional fields are emitted as `undefined`
 * when absent and canonical JSON drops them, so a dataset that uses none of
 * them hashes exactly as it did before those fields existed.
 */
function datasetIdentity(task: Task): Record<string, unknown> {
	return {
		id: task.id,
		input: task.input,
		graders: task.graders ?? null,
		expected: task.expected,
		messages: task.messages,
		simulatedUser: task.simulatedUser,
		metadata: task.metadata,
	};
}

/**
 * Identity of the effective scoring configuration: the exact cases, the suite
 * grader defaults that fill in for cases without their own, and the judge model.
 *
 * `loadTarget` and `ahde regrade` both compute it here, so the suite hash of a
 * re-graded eval is the same kind of fact as the suite hash of a run.
 */
/**
 * The judge as a *measurement* input: the model, its parameters, and the rubric
 * machinery, with the promotion-only calibration policy removed. Canonical JSON
 * drops the undefined key, so setting or lifting `requireCalibration` never
 * moves an identity hash and never invalidates evidence produced by the
 * identical judge. Every suite identity — the manifest formula below and the
 * corpus formula in `application/corpus-target.ts` — hashes through here, so no
 * second formula can drift away from this rule.
 */
export function judgeMeasurementIdentity(
	judge: TargetManifest["evalSuite"]["judge"] | null | undefined,
): Record<string, unknown> | null {
	return judge ? { ...judge, requireCalibration: undefined } : null;
}

/**
 * The user model as a measurement input. It is `undefined` — not `null` — when
 * unconfigured on purpose: canonical JSON drops an absent key, so every suite
 * written before simulated users existed keeps its exact hash, and comparing a
 * baseline to a candidate stays a comparison of the same instrument.
 */
export function simulatedUserMeasurementIdentity(
	simulatedUser: TargetManifest["evalSuite"]["simulatedUser"] | null | undefined,
): Record<string, unknown> | undefined {
	return simulatedUser ? { ...simulatedUser } : undefined;
}

export function suiteHashOf(
	tasks: readonly Task[],
	defaults: readonly GraderSpec[],
	judge: TargetManifest["evalSuite"]["judge"] | null,
	simulatedUser?: TargetManifest["evalSuite"]["simulatedUser"] | null,
): string {
	return hashValue({
		dataset: tasks.map(datasetIdentity),
		defaults,
		judge: judgeMeasurementIdentity(judge),
		simulatedUser: simulatedUserMeasurementIdentity(simulatedUser),
	});
}

const MAX_DATA_ENTRY_SAMPLE = 32;

/**
 * Measure one declared data directory without reading a byte of content.
 * Symlinks, special files, and unsafe names fail closed so what a run copies is
 * exactly what an operator can see in Git.
 */
function measureDataDirectory(
	dir: string,
	declaration: string,
	budget: { files: number; bytes: number; maxBytes: number },
): ResolvedTargetDataDirectory {
	const root = realpathSync(resolve(dir));
	const directory = targetFilePathDirectory(root, declaration);
	const entries: string[] = [];
	let files = 0;
	let bytes = 0;
	const walk = (absolute: string, prefix: string, depth: number): void => {
		if (depth > 16) throw new Error(`data directory ${declaration} nests deeper than 16 levels`);
		for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const child = join(absolute, entry.name);
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			const stat = lstatSync(child);
			if (stat.isSymbolicLink()) throw new Error(`data directory ${declaration} contains a symlink: ${relativePath}`);
			if (stat.isDirectory()) {
				walk(child, relativePath, depth + 1);
				continue;
			}
			if (!stat.isFile()) throw new Error(`data directory ${declaration} contains a non-regular file: ${relativePath}`);
			files += 1;
			budget.files += 1;
			bytes += stat.size;
			budget.bytes += stat.size;
			if (budget.files > MAX_DATA_FILES) throw new Error(`declared data exceeds ${MAX_DATA_FILES} files`);
			if (budget.bytes > budget.maxBytes) {
				throw new Error(`declared data exceeds the ${budget.maxBytes}-byte workspace budget`);
			}
			if (entries.length < MAX_DATA_ENTRY_SAMPLE) entries.push(relativePath);
		}
	};
	walk(directory, "", 1);
	return { path: declaration, files, bytes, entries, entriesTruncated: files > entries.length };
}

function targetFilePathDirectory(root: string, rel: string): string {
	const lexical = resolve(root, rel);
	const lexicalRelative = relative(root, lexical);
	if (!lexicalRelative || lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
		throw new Error(`declared data directory escapes the repository: ${rel}`);
	}
	let cursor = root;
	for (const part of lexicalRelative.split(sep)) {
		cursor = join(cursor, part);
		const stat = lstatSync(cursor);
		if (stat.isSymbolicLink()) throw new Error(`declared data directory traverses a symlink: ${rel}`);
		if (!stat.isDirectory()) throw new Error(`declared data path is not a directory: ${rel}`);
	}
	return cursor;
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
		const dialogueIssue = taskDialogueIssue(result.data);
		if (dialogueIssue) {
			throw new Error(`dataset ${rel} line ${i + 1}: ${dialogueIssue}`);
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
	const dataBudget = { files: 0, bytes: 0, maxBytes: dataMaxBytes() };
	const data = manifest.data.map((declaration) => measureDataDirectory(dir, declaration, dataBudget));

	const resolved = resolveTaskGraders(
		tasks,
		defaults,
		manifest.evalSuite.judge !== undefined,
		manifest.evalSuite.simulatedUser !== undefined,
	);

	const datasetHash = hashValue(tasks.map(datasetIdentity));
	const suiteHash = suiteHashOf(
		tasks,
		defaults,
		manifest.evalSuite.judge ?? null,
		manifest.evalSuite.simulatedUser ?? null,
	);

	return {
		dir: resolve(dir),
		manifest,
		evaluationFiles: [...new Set([manifestDataset, manifest.evalSuite.dataset, manifest.evalSuite.graders])],
		gitSha: gitSha(dir),
		runtime: runtimeInfo(),
		tools: targetTools.tools,
		toolsetHash: targetTools.toolsetHash,
		data,
		tasks: resolved,
		graderDefaults: defaults,
		datasetHash,
		suiteHash,
		suiteIdentity: "manifest",
	};
}

function graderDetail(spec: GraderSpec): string {
	switch (spec.type) {
		case "tool_called":
			return `${spec.tool}${spec.argsContains ? `(${spec.argsContains})` : ""}`;
		case "output_contains":
			return `"${spec.text.slice(0, 24)}"`;
		case "judge":
			return `"${(spec.rubric ?? spec.assertions?.join(" · ") ?? "").slice(0, 24)}"` +
				`${spec.assertions ? `+${spec.assertions.length}assertions` : ""}` +
				`${spec.jury && spec.jury > 1 ? `+jury${spec.jury}` : ""}` +
				`${spec.withReference ? "+reference" : ""}`;
		case "output_matches":
			return `/${spec.pattern.slice(0, 24)}/`;
		case "exact":
			return spec.normalize;
		case "similarity":
			return `${spec.metric}>=${spec.threshold}`;
		case "turn_budget":
			return `<=${spec.max}turns`;
	}
}

/** Display name for a grader spec. */
export function graderName(spec: GraderSpec, task: { id: string }, index: number): string {
	if (spec.name) return spec.name;
	return `${task.id}#${index}:${spec.type}:${graderDetail(spec)}`;
}
