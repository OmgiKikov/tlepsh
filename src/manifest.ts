import { CommandProtocolVersionSchema } from "./target/command-protocol.js";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DEFAULT_PI_HARNESS_FILES, withinDeclaredHarness } from "./domain/harness-surface.js";
import { plural } from "./i18n.js";
import { canonicalJson, hashValue } from "./provenance.js";
import { isStandInModel } from "./target/placeholders.js";
import { loadTargetTools, type ResolvedTargetTool } from "./target/tool-manifest.js";
import {
	ENGINE_STORE_EXCLUDE,
	ensureLocalArtifactIgnores,
	operatorDirtyPaths,
} from "./application/store-hygiene.js";

// ---------- Grader specs (declarative, target-owned) ----------

/**
 * Hard ceiling on a simulated conversation, bounding runtime and evaluator
 * spend. This is an operational limit, not a claim about realistic dialogue.
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

/**
 * The must-not check: the answer passes when it does NOT contain the text.
 * This is how a trap is scored — the plausible wrong rule, the invented
 * refund window, the number the source never states — beside the
 * `output_contains` that names the right one.
 */
export const OutputExcludesGrader = z.strictObject({
	type: z.literal("output_excludes"),
	name: z.string().optional(),
	text: z.string().min(1),
	caseSensitive: z.boolean().default(false),
});

/**
 * The answer must not contain anything shaped like a credential.
 *
 * A grader cannot be given the secret to look for — the value never reaches
 * AHDE, by design — so this one asks the question the trace redactor already
 * answers: does the final answer contain a string that looks like a key, a
 * token, or a bearer header? It takes no configuration for the same reason: a
 * pattern written by hand would be a second, weaker copy of the redactor.
 */
export const NoSecretGrader = z.strictObject({
	type: z.literal("no_secret"),
	name: z.string().optional(),
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

/** Dotted path: `order.items.0.status`. No wildcards — an expectation names one place. */
const WORLD_PATH = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

/** One place in a world state, named the same way by an expectation and a grader. */
export const WorldPathSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(WORLD_PATH, "world expectation path is a dotted path with no wildcards");

/** The three operations `domain/world.ts` decides. Nothing else may be asked. */
export const WorldOpSchema = z.enum(["equals", "exists", "contains"]);
export type WorldOp = z.infer<typeof WorldOpSchema>;

/**
 * `exists` only asks whether the path is there, so carrying a value would be a
 * promise nothing reads; `equals` and `contains` compare against one, so
 * omitting it would be a check with nothing on the other side.
 */
function worldValueIssue(op: WorldOp, hasValue: boolean): string | null {
	if (op === "exists" && hasValue) {
		return "an exists expectation asks only whether the path is there; it takes no value";
	}
	if (op !== "exists" && !hasValue) {
		return `a ${op} expectation compares against a value and must carry one`;
	}
	return null;
}

/**
 * What the world had to look like once the conversation ended.
 *
 * This is the scored form of `world.expect`: `resolveTaskGraders` appends one
 * of these per expectation, so a world expectation and a hand-written grader
 * travel the same scoring path, carry the same check code, and cluster into the
 * same failure family.
 */
export const WorldStateGrader = z.strictObject({
	type: z.literal("world_state"),
	name: z.string().optional(),
	path: WorldPathSchema,
	op: WorldOpSchema,
	value: z.unknown().optional(),
}).superRefine((spec, context) => {
	const issue = worldValueIssue(spec.op, spec.value !== undefined);
	if (issue) context.addIssue({ code: "custom", path: ["value"], message: issue });
});

/**
 * Does the final answer explicitly cite this exact run-local KB chunk id?
 * The chunk must exist in the saved workspace. This checks citation only:
 * it does not prove retrieval, factual accuracy, or claim-level grounding.
 */
export const CitesSourceGrader = z.strictObject({
	type: z.literal("cites_source"),
	name: z.string().optional(),
	/** `<path>#<ordinal>`, exactly as `kb_search` returns it. */
	chunk: z.string().min(1).max(300),
	/** @deprecated Accepted to preserve historical specs/hashes; ignored by evaluator v5. */
	minOverlap: z.number().gt(0).lte(1).default(0.35).describe("Deprecated compatibility field, ignored by evaluator v5; explicit citation is required."),
});

/**
 * A check computed from the transcript, the answer or the world — every grader
 * but the judge. It is what a case must carry to be scored on more than an
 * opinion: a sealed exam nobody reads and a simulated conversation both refuse
 * a judge-only case.
 */
export function isDeterministicGrader(grader: { type: string }): boolean {
	return grader.type !== "judge";
}

export const GraderSpec = z.discriminatedUnion("type", [
	ToolCalledGrader,
	OutputContainsGrader,
	OutputMatchesGrader,
	OutputExcludesGrader,
	NoSecretGrader,
	JudgeGrader,
	ExactGrader,
	SimilarityGrader,
	TurnBudgetGrader,
	WorldStateGrader,
	CitesSourceGrader,
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
 * `messages` fixes a dialogue history and grades the next reply; this instead
 * generates later user turns in response to the agent. The user model receives
 * `goal`, `persona`, `knownFacts`, `stopWhen`, turn bounds and the visible
 * transcript, never graders, reference answers or hidden tool/world state.
 * Model-generated behaviour is not evidence of representative human behaviour.
 */
/**
 * How hard a case is, by what the agent has to do to pass it. `clarify` is the
 * case whose request is ambiguous on purpose: the point is the question the
 * agent asks back. `policy-trap` offers a plausible wrong rule; `out-of-scope`
 * must be declined or redirected; `no-answer` has no answer in the source and
 * the agent must say so instead of inventing one.
 */
export const CaseDifficultySchema = z.enum(["direct", "clarify", "tool", "policy-trap", "out-of-scope", "no-answer"]);
export type CaseDifficulty = z.infer<typeof CaseDifficultySchema>;

/**
 * Host-owned presets for how the simulated person behaves. Each expands into
 * prompt rules the host writes; the model never invents a behaviour of its own.
 */
export const SimulatedUserBehaviorSchema = z.enum([
	"clear", "vague", "impatient", "wrong-facts", "changes-goal", "multi-issue", "terse", "non-native",
]);
export type SimulatedUserBehavior = z.infer<typeof SimulatedUserBehaviorSchema>;

/** Which cell of the basket a case fills: the Spec's job, the difficulty, and optionally the user's behaviour and the world's state. */
export const CaseCoverageSchema = z.strictObject({
	job: z.string().trim().min(1).max(200).describe("One job from the approved Spec, verbatim."),
	difficulty: CaseDifficultySchema,
	behavior: SimulatedUserBehaviorSchema.optional().describe("The user's behaviour this case exercises; the simulator preset when the case is simulated."),
	state: z.string().trim().min(1).max(64).optional().describe("A short label of the world state the case starts in, e.g. “account blocked”."),
});
export type CaseCoverage = z.infer<typeof CaseCoverageSchema>;

const SourceHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected a sha256 digest");
const SourceRelativePathSchema = z.string().min(1).max(500)
	.refine((value) => !value.startsWith("/") && !value.split("/").includes("..") && !value.split("/").includes("."), "source path is relative and never traverses");

/**
 * Where a case came from. The model-facing kinds (`kb`, `spec`, `import`,
 * `feedback`) are verified by the host before a draft is saved; `production`
 * and `generated` are minted by the host. Origin follows: real = import,
 * feedback, production; synthetic = kb, spec, generated.
 */
export const CaseSourceSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("kb"),
		path: SourceRelativePathSchema.describe("A declared data/kb document, as the Target view lists it."),
		sha256: SourceHashSchema.describe("The document's sha256 as the Target view reported it."),
	}),
	z.strictObject({ kind: z.literal("spec") }),
	z.strictObject({
		kind: z.literal("import"),
		path: SourceRelativePathSchema.describe("The imports/ file the case was compiled or read from."),
		sha256: SourceHashSchema,
		row: z.number().int().min(0).describe("Zero-based row in that file."),
	}),
	z.strictObject({
		kind: z.literal("feedback"),
		at: z.iso.datetime({ offset: true }).describe("The `at` timestamp of the mark in imports/feedback.jsonl."),
	}),
	z.strictObject({ kind: z.literal("production"), traceId: z.string().min(1).max(200) }),
	z.strictObject({ kind: z.literal("generated"), generator: z.literal("judge"), receiptId: z.string().min(1).max(200).optional() }),
]);
export type CaseSource = z.infer<typeof CaseSourceSchema>;

export const SimulatedUserDisclosureSchema = z.enum(["upfront", "on-request"]);
export type SimulatedUserDisclosure = z.infer<typeof SimulatedUserDisclosureSchema>;

export const SimulatedUserSpecSchema = z.strictObject({
	/** What the person is trying to achieve, in their own terms. */
	goal: boundedTaskText("simulated user goal").describe("What the user wants, not the reference answer or grading instructions."),
	/** Who they are and how they write. Absent means a neutral user. */
	persona: boundedTaskText("simulated user persona").optional().describe("Role and communication style. Prefer knownFacts for factual details."),
	/** Optional, not defaulted: historical specs and their hashes stay unchanged. */
	knownFacts: boundedTaskText("simulated user known facts")
		.refine((value) => value.trim().length > 0, "knownFacts must be non-blank")
		.optional()
		.describe("Facts the user knows at the start (at most 8 KiB UTF-8): e.g. their account ID, symptoms, actions already tried. Never copy hidden world.state, world.expect, expected or graders here. Omit unknown facts; missing facts are not permission to invent them."),
	/** Agent turns the conversation may take before the host stops it. */
	maxTurns: z.number().int().min(1).max(MAX_SIMULATED_USER_TURNS),
	/** User-observable condition, self-reported by the model; not a grader. */
	stopWhen: boundedTaskText("simulated user stop condition").optional()
		.describe("A stopping condition observable from the conversation, not hidden backend success. The model reports it; graders/world.expect independently decide pass or fail."),
	/** A host-owned behaviour preset; absent means a neutral, cooperative user. */
	behavior: SimulatedUserBehaviorSchema.optional()
		.describe("How the person behaves: clear, vague, impatient, wrong-facts (believes something false about their own situation), changes-goal, multi-issue, terse, non-native. The host writes the rules; the case only names the preset."),
	/** How known facts reach the agent: only when asked (default), or all at once. */
	disclosure: SimulatedUserDisclosureSchema.optional()
		.describe("on-request (default): the person states a known fact only when the agent asks for it. upfront: everything relevant in the first turn."),
}).describe("Reactive user: input is the fixed opening; this model writes later turns. Use messages instead for a scripted history and one next reply, never both. The simulator cannot inspect tools or world state, verify backend success, or establish real-user quality. Review generated transcripts as well as scores.");
export type SimulatedUserSpec = z.infer<typeof SimulatedUserSpecSchema>;

/**
 * A case's world is read, not executed: it is data the Target's tools answer
 * from, so it stays small enough for a human to read in a review and for a
 * canonical hash to stay cheap.
 */
export const MAX_WORLD_BYTES = 16 * 1024;
export const MAX_WORLD_DEPTH = 5;

/** The names that turn a plain object literal into prototype pollution. */
const DANGEROUS_WORLD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * One assertion about the world after the agent has acted. `equals` and
 * `contains` compare against `value`; `exists` only asks whether the path is
 * there, so carrying a value would be a promise nothing reads.
 */
export const WorldExpectationSchema = z.strictObject({
	path: WorldPathSchema,
	op: WorldOpSchema,
	value: z.unknown().optional(),
});
export type WorldExpectation = z.infer<typeof WorldExpectationSchema>;

/**
 * The bounded structural check the byte bound cannot make: how deep the state
 * nests, and whether any key at any depth is one of the three names that turn
 * an assignment into prototype pollution. Mirrors the rule
 * `target/tool-manifest.ts` applies to declared tool parameter schemas.
 */
function worldStateIssue(value: unknown, depth: number, path: string): string | null {
	if (value === null || typeof value !== "object") return null;
	if (depth > MAX_WORLD_DEPTH) return `${path} nests deeper than ${MAX_WORLD_DEPTH} levels`;
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			const issue = worldStateIssue(item, depth + 1, `${path}[${index}]`);
			if (issue) return issue;
		}
		return null;
	}
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (DANGEROUS_WORLD_KEYS.has(key)) return `${path}.${key} is a reserved property name`;
		const issue = worldStateIssue(child, depth + 1, `${path}.${key}`);
		if (issue) return issue;
	}
	return null;
}

/**
 * Zod strips a literal `__proto__` key out of a record and out of an object
 * before any refinement can see it, so a refinement over the *parsed* world
 * would report a state that is not the one the author wrote. This looks at the
 * raw value instead, so a world that declares the name is refused rather than
 * quietly edited. Deeper keys survive parsing — `state`'s values are
 * `z.unknown()` — and `worldStateIssue` catches them there.
 */
function rawWorldProtoKey(value: unknown): string | null {
	const plainObject = (candidate: unknown): candidate is Record<string, unknown> =>
		candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
	if (!plainObject(value)) return null;
	if (Object.hasOwn(value, "__proto__")) return "world";
	const state = value.state;
	return plainObject(state) && Object.hasOwn(state, "__proto__") ? "state" : null;
}

const WorldObjectSchema = z
	.strictObject({
		state: z.record(z.string().min(1).max(64), z.unknown()),
		expect: z.array(WorldExpectationSchema).max(8).optional(),
	})
	.superRefine((world, context) => {
		const bytes = Buffer.byteLength(canonicalJson(world.state), "utf8");
		if (bytes > MAX_WORLD_BYTES) {
			context.addIssue({
				code: "custom",
				path: ["state"],
				message: `world state is ${bytes} bytes, over the ${MAX_WORLD_BYTES} byte bound`,
			});
		}
		const structure = worldStateIssue(world.state, 1, "state");
		if (structure) context.addIssue({ code: "custom", path: ["state"], message: structure });
		for (const [index, expectation] of (world.expect ?? []).entries()) {
			const issue = worldValueIssue(expectation.op, expectation.value !== undefined);
			if (issue) context.addIssue({ code: "custom", path: ["expect", index, "value"], message: issue });
		}
	});

/**
 * The state a case starts from and what must be true of it afterwards.
 *
 * Optional on `TaskSchema` and never defaulted: canonical JSON drops an absent
 * key, so every dataset written before worlds existed keeps the exact
 * `datasetHash` it already has.
 */
export const WorldSchema = z
	.unknown()
	.superRefine((value, context) => {
		const where = rawWorldProtoKey(value);
		if (where) {
			context.addIssue({ code: "custom", path: [where], message: `${where}.__proto__ is a reserved property name` });
		}
	})
	.pipe(WorldObjectSchema);
export type World = z.infer<typeof WorldSchema>;

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
	/**
	 * The state this case happens in, and what must be true of it afterwards.
	 * Absent means the case is a pure question with no world behind it.
	 */
	world: WorldSchema.optional(),
	metadata: TaskMetadataSchema.optional(),
	/** Which cell of the basket this case fills. Optional: hand-written and older cases carry none. */
	coverage: CaseCoverageSchema.optional(),
	/** Where the case came from; verified by the host for the model-facing kinds. */
	source: CaseSourceSchema.optional(),
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
 * `world.expect` is sugar for graders, not a second scoring path.
 *
 * Every path that resolves a case's effective graders appends these, so an
 * expectation an author wrote beside the state and a `world_state` grader an
 * author wrote beside the other checks are the same object by the time
 * anything scores, explains, clusters or renders it.
 */
export function worldExpectationGraders(task: Pick<Task, "world">): GraderSpec[] {
	return (task.world?.expect ?? []).map((expectation) => ({
		type: "world_state" as const,
		path: expectation.path,
		op: expectation.op,
		...(expectation.value !== undefined ? { value: expectation.value } : {}),
	}));
}

/**
 * Fill each case's effective graders and validate the resulting scoring
 * surface. A case's own graders always win; the suite defaults only fill in for
 * a case that declares none.
 *
 * `loadTarget` and `/regrade` both come through here, so a re-graded suite
 * is admitted by exactly the rules a freshly run one is.
 */
export function resolveTaskGraders(
	tasks: readonly Task[],
	defaults: readonly GraderSpec[],
	judgeConfigured: boolean,
	simulatedUserConfigured = false,
	options: {
		/**
		 * Whether a missing evaluator is a readiness fact rather than a broken
		 * file. `loadTarget` says yes: a template ships a judge grader and two
		 * dialogue cases with both evaluator blocks still on the built-in
		 * placeholder, and refusing to LOAD that Target leaves the operator with a
		 * YAML error instead of the question the Workbench exists to ask. Nothing
		 * runs on it either way — `missingEvaluatorCases` refuses before the first
		 * execution, publication refuses, and `runTask` refuses again.
		 */
		evaluatorsChosenLater?: boolean;
	} = {},
): ResolvedTask[] {
	const resolved: ResolvedTask[] = tasks.map((task) => {
		// The case's own graders, or the suite defaults, plus one grader per world
		// expectation. A case whose only statement about the agent is what the
		// world had to look like afterwards is a scored case, not an empty one.
		const graders: GraderSpec[] = [...(task.graders ?? defaults), ...worldExpectationGraders(task)];
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
	if (options.evaluatorsChosenLater === true) return resolved;
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

/** Which cases name an evaluator this suite has not configured, by role. */
export interface MissingEvaluatorCases {
	/** Case ids graded by a judge grader when `evalSuite.judge` is absent. */
	judge: string[];
	/** Case ids that are conversations when `evalSuite.simulatedUser` is absent. */
	simulatedUser: string[];
}

/** Whether either list has anything in it. */
export function anyEvaluatorMissing(missing: MissingEvaluatorCases): boolean {
	return missing.judge.length > 0 || missing.simulatedUser.length > 0;
}

/**
 * The cases a run would not be able to measure, named before it starts.
 *
 * Loading a Target with a missing evaluator is allowed (the operator is about
 * to be asked for one); running it is not. This is the question the run path
 * asks, and it asks it over the WHOLE design rather than per execution, so an
 * eight-case basket refuses as one sentence instead of paying for six runs and
 * erroring on the last two.
 */
export function missingEvaluatorCases(
	tasks: readonly {
		id: string;
		simulatedUser?: unknown;
		graders?: readonly GraderSpec[] | undefined;
		effectiveGraders?: readonly GraderSpec[];
	}[],
	evalSuite: { judge?: unknown; simulatedUser?: unknown },
): MissingEvaluatorCases {
	const missing: MissingEvaluatorCases = { judge: [], simulatedUser: [] };
	for (const task of tasks) {
		const graders = task.effectiveGraders ?? task.graders ?? [];
		if (!evalSuite.judge && graders.some((grader) => grader.type === "judge")) missing.judge.push(task.id);
		if (!evalSuite.simulatedUser && task.simulatedUser !== undefined) missing.simulatedUser.push(task.id);
	}
	return missing;
}

/** How many case ids one refusal sentence names before it stops listing them. */
const NAMED_MISSING_EVALUATOR_CASES = 8;

function namedCases(ids: readonly string[]): string {
	const shown = ids.slice(0, NAMED_MISSING_EVALUATOR_CASES).join(", ");
	return ids.length > NAMED_MISSING_EVALUATOR_CASES
		? `${shown}, +${ids.length - NAMED_MISSING_EVALUATOR_CASES} more`
		: shown;
}

/**
 * A run refused because the instrument it would measure with does not exist.
 *
 * Typed, and it carries the case ids: the host renders `reason.code` in the
 * operator's language and the English `message` is what the Builder reads and
 * what scripts match on — the same pairing every other typed refusal uses.
 */
export class EvaluatorsNotConfiguredError extends Error {
	readonly missing: MissingEvaluatorCases;
	readonly reason: { code: string; params: Record<string, string | number> };

	constructor(missing: MissingEvaluatorCases) {
		const parts: string[] = [];
		if (missing.judge.length > 0) {
			parts.push(
				`${missing.judge.length} case(s) are graded by a judge and evalSuite.judge is not configured (${namedCases(missing.judge)})`,
			);
		}
		if (missing.simulatedUser.length > 0) {
			parts.push(
				`${missing.simulatedUser.length} case(s) are conversations and evalSuite.simulatedUser is not configured (${
					namedCases(missing.simulatedUser)
				})`,
			);
		}
		super(`this basket cannot be measured yet: ${parts.join("; ")}`);
		this.name = "EvaluatorsNotConfiguredError";
		this.missing = { judge: [...missing.judge], simulatedUser: [...missing.simulatedUser] };
		this.reason = {
			code: missing.judge.length > 0 && missing.simulatedUser.length > 0
				? "blocker.evaluators-missing"
				: missing.judge.length > 0
					? "blocker.judge-missing"
					: "blocker.user-model-missing",
			// The count bends with the noun, so the Russian form reads "2 диалога"
			// and the English one "1 dialogue" — the sentence has to work for both.
			params: { dialogues: plural(missing.simulatedUser.length, "dialogue") },
		};
	}
}

/**
 * Refuse a run whose suite names an evaluator the Target has not configured.
 * A no-op when everything the cases need exists.
 */
export function assertEvaluatorsConfigured(
	tasks: readonly { id: string; simulatedUser?: unknown; effectiveGraders?: readonly GraderSpec[] }[],
	evalSuite: { judge?: unknown; simulatedUser?: unknown },
): void {
	const missing = missingEvaluatorCases(tasks, evalSuite);
	if (anyEvaluatorMissing(missing)) throw new EvaluatorsNotConfiguredError(missing);
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
 * A Target that is not Pi: an executable AHDE starts and speaks a versioned
 * line protocol to. `argv` is the exact command, never a shell string, so no
 * quoting rule can turn a manifest into a second parser.
 */
export const CommandBackendBlock = z.strictObject({
	argv: z.array(z.string().min(1).max(4_096)).min(1).max(32),
	/** Exact wire/usage contract; absent preserves the legacy v1 adapter. */
	protocolVersion: CommandProtocolVersionSchema.default(1),
	startupTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
});
export type CommandBackendBlock = z.infer<typeof CommandBackendBlock>;

export const ExecutionPolicyBlock = z
	.strictObject({
		tools: z.array(z.enum(["read", "bash", "edit", "write"])).min(1).default(["read", "bash"]),
		environmentAllowlist: z
			.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
			.default([]),
		network: z.enum(["deny", "allow"]).default("deny"),
		sandbox: z.enum(["required", "best-effort", "off"]).default("best-effort"),
		/**
		 * Which backend runs the Target. Optional and never defaulted: a default
		 * would put the key into the canonical JSON of every existing manifest and
		 * move every `provenanceKey` in every runs store. Absent means `pi`; read
		 * it through `executionKindOf` rather than testing the field.
		 */
		kind: z.enum(["pi", "command"]).optional(),
		command: CommandBackendBlock.optional(),
	})
	.superRefine((execution, context) => {
		if (execution.kind === "command" && !execution.command) {
			context.addIssue({
				code: "custom",
				path: ["command"],
				message: "execution.kind: command requires an execution.command block naming the executable",
			});
		}
		if (execution.command && execution.kind !== "command") {
			context.addIssue({
				code: "custom",
				path: ["kind"],
				message: "execution.command is only read under execution.kind: command",
			});
		}
		if (execution.kind === "command" && execution.sandbox === "off") {
			context.addIssue({
				code: "custom",
				path: ["sandbox"],
				message: "execution.kind: command requires sandbox: required or best-effort; a command Target declares no containment",
			});
		}
	});
export type ExecutionPolicyBlock = z.infer<typeof ExecutionPolicyBlock>;

/**
 * Which backend a manifest asks for. The one place that reads the absence of
 * `kind` as `pi`, so no caller has to remember that an old manifest predates
 * the field.
 */
export function executionKindOf(execution: Pick<ExecutionPolicyBlock, "kind">): "pi" | "command" {
	return execution.kind ?? "pi";
}

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
							: "the simulated user is pinned to temperature 0 to reduce sampling variation, not guarantee reproducibility"
					}`,
				});
			}
		}
	};
}

/**
 * Promotion policy for judge-graded evidence: how well this project's judge
 * must agree with its human labels (`/label`) before evidence that leans on
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

/** One declared harness path or glob: relative, no traversal, no absolute root. */
const HarnessGlob = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9_][A-Za-z0-9_./*-]*$/, "harness files are relative paths or globs under the target root")
	.refine((value) => !value.split("/").includes(".."), "harness files cannot traverse out of the target root");

/**
 * What a Pi Target's harness is when the manifest does not say. Exactly the
 * surface `ahde` has always been willing to rewrite. Defined beside the matcher
 * that reads it, and re-exported here because this is where every caller looks.
 */
export { DEFAULT_PI_HARNESS_FILES };

const TargetManifestShape = z.strictObject({
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
	 * The declared editable surface: the files a proposal may rewrite and the
	 * files a harness hash is taken over. Invariants 5 and 17 will read it
	 * instead of naming the Pi layout, which is what lets a Target whose harness
	 * is a prompt file or a config tree be improved by the same loop.
	 *
	 * Optional and never defaulted, for the reason `kind` is: a default would
	 * write the key into the canonical JSON of every existing manifest. Absent
	 * means `DEFAULT_PI_HARNESS_FILES`; read it through `harnessFilesOf`.
	 */
	harness: z.strictObject({ files: z.array(HarnessGlob).min(1).max(64) }).optional(),
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
		/**
		 * A second user model, for measuring simulator noise: `calibrate` with
		 * `simulator: "alternate"` runs the same revision against itself with this
		 * model on the second arm. Never used for evidence.
		 */
		simulatedUserAlternate: SimulatedUserModelBlock.optional(),
	}),
}).superRefine((manifest, context) => {
	// The editable surface may never reach the evidence: a proposal that could
	// rewrite the dataset, the graders or the manifest itself would be grading
	// its own homework (invariant 6). The Pi default names none of these.
	if (!manifest.harness) return;
	const protectedPaths: [string, string][] = [
		["evalSuite.dataset", manifest.evalSuite.dataset],
		["evalSuite.graders", manifest.evalSuite.graders],
		["manifest.yaml", "manifest.yaml"],
	];
	for (const [label, path] of protectedPaths) {
		if (withinDeclaredHarness(path, manifest.harness.files)) {
			context.addIssue({
				code: "custom",
				path: ["harness", "files"],
				message: `harness.files reaches ${label} (${path}); the editable surface may not include the dataset, the graders or the manifest`,
			});
		}
	}
});

type TargetManifestValue = z.infer<typeof TargetManifestShape>;

/**
 * A template's `judge:` block is a shape to fill in, not a judge: its provider,
 * id and endpoint are `REPLACE-ME`. Resolving it here — the one place a
 * manifest becomes a value — is what keeps every reader honest. The view, the
 * `judgeConfigured` check below, the sealed-synth preflight and `/doctor` all
 * ask the same question of the same field, so a stand-in reads as "no judge
 * configured" everywhere instead of as a judge that fails at the first call
 * against `https://REPLACE-ME`. Configuring one goes through
 * `configure-evaluators`, which writes a real block.
 */
function placeholderJudgeIsNoJudge(manifest: TargetManifestValue): TargetManifestValue {
	const judge = manifest.evalSuite.judge;
	if (!judge || !isStandInModel(judge)) return manifest;
	const { judge: _placeholder, ...evalSuite } = manifest.evalSuite;
	return { ...manifest, evalSuite };
}

/**
 * And the same for the model that plays the person talking to the agent.
 *
 * `templates/python-agent` ships both blocks on the built-in starter model —
 * the very block the bootstrap dialog replaces on `model:` — so without this a
 * freshly configured template would run its two dialogue cases against
 * `http://127.0.0.1:1234/v1` and report an infrastructure error where the
 * honest answer is "nobody has chosen a simulated user yet".
 */
function placeholderUserIsNoUser(manifest: TargetManifestValue): TargetManifestValue {
	const user = manifest.evalSuite.simulatedUser;
	if (!user || !isStandInModel(user)) return manifest;
	const { simulatedUser: _placeholder, ...evalSuite } = manifest.evalSuite;
	return { ...manifest, evalSuite };
}

// `overwrite`, not `transform`: this normalization has to survive encoding as
// well as parsing — receipts write manifests back out through the same schema.
export const TargetManifest = TargetManifestShape.overwrite((manifest) =>
	placeholderUserIsNoUser(placeholderJudgeIsNoJudge(manifest))
);
export type TargetManifest = TargetManifestValue;

/**
 * The Target's editable surface: what the manifest declares, or the Pi default
 * for every manifest written before the field existed.
 */
export function harnessFilesOf(manifest: Pick<TargetManifest, "harness">): readonly string[] {
	return manifest.harness?.files ?? DEFAULT_PI_HARNESS_FILES;
}

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

/**
 * Scaffold a new target from a working template (copy + fresh git init).
 *
 * `onGitignore` reports the ignore lines this scaffold had to add, so `ahde
 * init` can name them; the rules are applied either way, before the first
 * commit, because the engine store must never be inside one.
 */
export function scaffoldTarget(
	templateDir: string,
	destDir: string,
	onGitignore?: (added: readonly string[]) => void,
): string {
	if (existsSync(destDir)) throw new Error(`target dir already exists: ${destDir}`);
	const source = resolve(templateDir);
	readFileSync(join(source, "manifest.yaml")); // template must be a target
	cpSync(source, resolve(destDir), {
		recursive: true,
		filter: (p) => !relative(source, p).split(sep).includes(".git"),
	});
	// Not `onGitignore?.(ensureLocalArtifactIgnores(...))`: an optional call
	// does not evaluate its argument, so the rules would go unwritten.
	const addedIgnores = ensureLocalArtifactIgnores(resolve(destDir));
	onGitignore?.(addedIgnores);
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

/**
 * The revision a Target records. The engine's own store lives inside the
 * Target, so it is excluded from both halves — the question and the hash —
 * whatever `.gitignore` says: `.ahde/` never belongs to the Target's identity.
 */
function gitSha(dir: string): string {
	const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const status = execFileSync("git", ["-C", dir, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
		encoding: "utf8",
	});
	if (operatorDirtyPaths(status).length === 0) return head;

	const diff = execFileSync("git", ["-C", dir, "diff", "--binary", "HEAD"], { encoding: "utf8" });
	const untracked = execFileSync(
		"git",
		["-C", dir, "ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...ENGINE_STORE_EXCLUDE],
		{ encoding: "utf8" },
	)
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
		// This function enumerates; it does not spread. Without this line two
		// cases that differ only in the world they happen in would hash to one
		// `datasetHash` and a run against one would count as evidence for the
		// other. Canonical JSON drops it when absent, so every dataset without a
		// world keeps the hash it already has.
		world: task.world,
		metadata: task.metadata,
	};
}

/**
 * Identity of the effective scoring configuration: the exact cases, the suite
 * grader defaults that fill in for cases without their own, and the judge model.
 *
 * `loadTarget` and `/regrade` both compute it here, so the suite hash of a
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

export function loadDataset(dir: string, rel: string): Task[] {
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

	// Loadable, never runnable: a Target whose cases name an evaluator it has
	// not configured is exactly the Target the operator is about to be asked
	// about, and a load error there would replace that question with a YAML
	// complaint. The refusal lives on the run path instead.
	const resolved = resolveTaskGraders(
		tasks,
		defaults,
		manifest.evalSuite.judge !== undefined,
		manifest.evalSuite.simulatedUser !== undefined,
		{ evaluatorsChosenLater: true },
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
		case "output_excludes":
			return `not "${spec.text.slice(0, 24)}"`;
		case "no_secret":
			return "redaction";
		case "exact":
			return spec.normalize;
		case "similarity":
			return `${spec.metric}>=${spec.threshold}`;
		case "turn_budget":
			return `<=${spec.max}turns`;
		case "world_state":
			return spec.op === "exists"
				? `${spec.path}?`
				: `${spec.path}${spec.op === "contains" ? "∋" : "="}${canonicalJson(spec.value).slice(0, 24)}`;
		case "cites_source":
			return spec.chunk;
	}
}

/** Display name for a grader spec. */
export function graderName(spec: GraderSpec, task: { id: string }, index: number): string {
	if (spec.name) return spec.name;
	return `${task.id}#${index}:${spec.type}:${graderDetail(spec)}`;
}
