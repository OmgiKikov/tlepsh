import { Type, type TUnsafe } from "typebox";
import { z } from "zod";
import { BuilderWorkbenchCorpusRevisionOperationSchema } from "../application/builder-regression-case.js";
import { HarnessAuthoringIntentSchema } from "../application/harness-authoring.js";
import { ToolAuthoringBriefSchema, type ToolAuthoringBrief } from "../application/tool-authoring.js";
import { GraderSpec } from "../manifest.js";
import {
	WorkbenchDecisionInputSchema,
	WorkbenchSubmitInputSchema,
	WorkbenchViewQuerySchema,
	WorkshopBashInputSchema,
	WorkshopReadInputSchema,
	WorkshopTryInputSchema,
	WorkshopWriteInputSchema,
	type WorkbenchDecisionInput,
	type WorkbenchViewQuery,
	type WorkshopBashInput,
	type WorkshopReadInput,
	type WorkshopTryInput,
	type WorkshopWriteInput,
} from "../workbench/types.js";

/**
 * The three model-facing tool schemas are generated from the same zod schemas the
 * Workbench validates with, so a union (graders, corpus operations, harness
 * intents, decision kinds) is written exactly once and can never drift from the
 * validator that rejects the call.
 */

type JsonSchema = {
	type?: string;
	const?: unknown;
	enum?: unknown[];
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	additionalProperties?: boolean | JsonSchema;
	patternProperties?: Record<string, JsonSchema>;
	items?: JsonSchema;
	$ref?: string;
	$defs?: Record<string, JsonSchema>;
};

// zod's three refinements (non-blank text, unique ids, resourcePath scope) have no
// JSON Schema form; the zod parse below is still the authority that rejects them.
const GENERATOR_OPTIONS = { io: "input", unrepresentable: "any" } as const;

/** `anyOf` is the shape every provider and this module's walker understand. */
function asAnyOf(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(asAnyOf);
	if (typeof node !== "object" || node === null) return node;
	const entries = Object.entries(node as Record<string, unknown>)
		.map(([key, value]) => [key === "oneOf" ? "anyOf" : key, asAnyOf(value)] as const);
	return Object.fromEntries(entries);
}

function generate(schema: z.ZodType): JsonSchema {
	const { $schema: _dialect, ...body } = z.toJSONSchema(schema, GENERATOR_OPTIONS) as Record<string, unknown>;
	return asAnyOf(body) as JsonSchema;
}

/**
 * Unions the model sees many times in one schema. Naming them keeps the submit
 * schema readable and cuts it roughly in half; every other shape stays inline
 * so the model never chases a reference it only needs once.
 */
const SHARED_DEFINITIONS: readonly (readonly [string, z.ZodType])[] = [
	["grader", GraderSpec],
	["corpusOperation", BuilderWorkbenchCorpusRevisionOperationSchema],
	["harnessIntent", HarnessAuthoringIntentSchema],
];

const definitionBodies = new Map<string, JsonSchema>();
const definitionKeys = new Map<string, string>();

/** Replace every subtree equal to a shared definition with a reference to it. */
function hoist(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(hoist);
	if (typeof node !== "object" || node === null) return node;
	const serialized = JSON.stringify(node);
	for (const [name, key] of definitionKeys) {
		if (serialized === key) return { $ref: `#/$defs/${name}` };
	}
	return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, value]) => [key, hoist(value)]));
}

for (const [name, schema] of SHARED_DEFINITIONS) {
	const body = generate(schema);
	// Hoisted against the definitions declared before it, never against itself.
	definitionBodies.set(name, hoist(body) as JsonSchema);
	definitionKeys.set(name, JSON.stringify(body));
}

function referencedDefinitions(node: unknown, found: Set<string>): void {
	if (Array.isArray(node)) {
		for (const item of node) referencedDefinitions(item, found);
		return;
	}
	if (typeof node !== "object" || node === null) return;
	const reference = (node as JsonSchema).$ref;
	if (reference) {
		const name = reference.slice(reference.lastIndexOf("/") + 1);
		if (!found.has(name)) {
			found.add(name);
			referencedDefinitions(definitionBodies.get(name), found);
		}
	}
	for (const value of Object.values(node as Record<string, unknown>)) referencedDefinitions(value, found);
}

function toolJsonSchema(schema: z.ZodType): JsonSchema {
	const hoisted = hoist(generate(schema)) as JsonSchema;
	const used = new Set<string>();
	referencedDefinitions(hoisted, used);
	if (used.size === 0) return hoisted;
	return {
		...hoisted,
		$defs: Object.fromEntries([...used].map((name) => [name, definitionBodies.get(name) as JsonSchema])),
	};
}

/** A zod issue path: object keys and array indexes (symbols never occur here). */
type IssuePath = readonly PropertyKey[];

// ---------------------------------------------------------------------------
// Schema navigation: one walker serves normalization, branch selection, and the
// model-readable explanations.

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deref(root: JsonSchema, node: JsonSchema | undefined): JsonSchema | undefined {
	if (!node?.$ref) return node;
	const name = node.$ref.slice(node.$ref.lastIndexOf("/") + 1);
	return root.$defs?.[name];
}

/** Every alternative of a union, with nested unions flattened into one list. */
function branchesOf(root: JsonSchema, node: JsonSchema | undefined): JsonSchema[] {
	const resolved = deref(root, node);
	if (!resolved) return [];
	if (!resolved.anyOf) return [resolved];
	return resolved.anyOf.flatMap((branch) => branchesOf(root, branch));
}

/** The key every branch pins to a literal, e.g. `kind` or `type`. */
function discriminatorOf(branches: readonly JsonSchema[]): string | null {
	const first = branches[0]?.properties ?? {};
	for (const key of Object.keys(first)) {
		if (branches.every((branch) => branch.properties?.[key]?.const !== undefined)) return key;
	}
	return null;
}

/** The branch a value chose, or the union itself when the value chose none. */
function selectBranch(root: JsonSchema, node: JsonSchema | undefined, value: unknown): JsonSchema | undefined {
	const resolved = deref(root, node);
	if (!resolved?.anyOf) return resolved;
	const branches = branchesOf(root, resolved);
	const discriminator = discriminatorOf(branches);
	if (discriminator && isRecord(value)) {
		const chosen = value[discriminator];
		const branch = branches.find((item) => item.properties?.[discriminator]?.const === chosen);
		if (branch) return branch;
		return resolved;
	}
	return branches.find((branch) =>
		(Array.isArray(value) && branch.type === "array") ||
		(isRecord(value) && (branch.type === "object" || branch.patternProperties !== undefined))
	) ?? resolved;
}

/** The schema node addressed by one zod issue path, following the value's own branches. */
function nodeAt(root: JsonSchema, path: IssuePath, value: unknown): JsonSchema | undefined {
	let node: JsonSchema | undefined = selectBranch(root, root, value);
	let current = value;
	for (const step of path) {
		if (!node) return undefined;
		if (typeof step === "number") {
			if (node.type !== "array") return undefined;
			current = Array.isArray(current) ? current[step] : undefined;
			node = selectBranch(root, node.items, current);
			continue;
		}
		if (typeof step !== "string") return undefined;
		const child = deref(root, node.properties?.[step]);
		current = isRecord(current) ? current[step] : undefined;
		node = selectBranch(root, child, current);
	}
	return node;
}

// ---------------------------------------------------------------------------
// Model-side compatibility shim, run by Pi before schema validation.
//
// Several models (notably through OpenRouter) send nested objects and arrays as
// JSON *strings*, and scalars as strings ("1", "false"). Rejecting those with a
// raw union error made one live Builder loop five times on a single Spec draft.
// This shim parses and coerces exactly where the schema expects it; the strict
// zod schema still validates the result, so it grants no authority.

const JSON_LIKE = /^\s*[[{]/;

function expects(root: JsonSchema, node: JsonSchema | undefined): { object: boolean; array: boolean } {
	const resolved = deref(root, node);
	if (!resolved) return { object: false, array: false };
	if (resolved.anyOf) {
		return resolved.anyOf.reduce<{ object: boolean; array: boolean }>(
			(accumulated, branch) => {
				const inner = expects(root, branch);
				return { object: accumulated.object || inner.object, array: accumulated.array || inner.array };
			},
			{ object: false, array: false },
		);
	}
	return {
		object: resolved.type === "object" || resolved.patternProperties !== undefined,
		array: resolved.type === "array",
	};
}

function coerceScalar(node: JsonSchema, value: string): unknown {
	if (node.type === "boolean") {
		if (value === "true") return true;
		if (value === "false") return false;
		return value;
	}
	if (node.type !== "number" && node.type !== "integer") return value;
	const trimmed = value.trim();
	if (!/^-?(?:\d+|\d*\.\d+)(?:[eE][-+]?\d+)?$/.test(trimmed)) return value;
	return Number(trimmed);
}

function normalize(root: JsonSchema, schema: JsonSchema | undefined, input: unknown): unknown {
	const node = deref(root, schema);
	if (!node) return input;
	let value = input;
	if (typeof value === "string") {
		const shape = expects(root, node);
		if ((shape.object || shape.array) && JSON_LIKE.test(value)) {
			try {
				const parsed: unknown = JSON.parse(value);
				if ((shape.object && isRecord(parsed)) || (shape.array && Array.isArray(parsed))) value = parsed;
			} catch {
				return value;
			}
		} else if (!node.anyOf) {
			return coerceScalar(node, value);
		}
	}
	if (node.anyOf) {
		const branch = selectBranch(root, node, value);
		return branch && branch !== node ? normalize(root, branch, value) : value;
	}
	if (node.type === "array" && Array.isArray(value)) {
		return value.map((item) => normalize(root, node.items, item));
	}
	if (node.type === "object" && isRecord(value)) {
		const properties = node.properties ?? {};
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, key in properties ? normalize(root, properties[key], item) : item]),
		);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Model-readable validation: every problem says what *is* allowed, so a model
// can repair its call in one retry. The problems are zod's; the schema only
// supplies the vocabulary (allowed keys, branch shapes).

function pathOf(path: IssuePath): string {
	return path.length === 0 ? "/" : `/${path.join("/")}`;
}

function describeBranch(branch: JsonSchema, discriminator: string): string {
	const required = new Set(branch.required ?? []);
	const fields = Object.keys(branch.properties ?? {})
		.filter((key) => key !== discriminator)
		.map((key) => (required.has(key) ? key : `${key}?`));
	return `${JSON.stringify(branch.properties?.[discriminator]?.const)} {${fields.join(", ")}}`;
}

function similar(candidate: string, options: readonly string[]): string | undefined {
	const lower = candidate.toLowerCase();
	return options.find((option) => {
		const other = option.toLowerCase();
		return other.includes(lower) || lower.includes(other) || other.replace(/id$/, "") === lower.replace(/id$/, "");
	});
}

function unionProblem(
	root: JsonSchema,
	issue: z.core.$ZodIssue,
	value: unknown,
): { path: string; message: string } | null {
	if (issue.code !== "invalid_union") return null;
	// zod names the discriminator for a discriminated union and points at that key;
	// a plain union points at the value, and the schema names the key instead.
	const named = (issue as { discriminator?: string }).discriminator;
	const owner = named ? issue.path.slice(0, -1) : issue.path;
	const branches = branchesOf(root, nodeAt(root, owner, value));
	const discriminator = named ?? discriminatorOf(branches);
	if (!discriminator) return null;
	const shapes = branches.length > 1 && discriminatorOf(branches) === discriminator
		? branches.map((branch) => describeBranch(branch, discriminator)).join(", ")
		: ((issue as { options?: unknown[] }).options ?? []).map((option) => JSON.stringify(option)).join(", ");
	const subject = valueAt(value, owner);
	const chosen = isRecord(subject) ? subject[discriminator] : undefined;
	return {
		path: pathOf(owner),
		message: `${discriminator} ${chosen === undefined ? "is missing" : `${JSON.stringify(chosen)} is not supported`}; use one of: ${shapes}`,
	};
}

function valueAt(value: unknown, path: IssuePath): unknown {
	let current = value;
	for (const step of path) {
		if (Array.isArray(current) && typeof step === "number") current = current[step];
		else if (isRecord(current) && typeof step === "string") current = current[step];
		else return undefined;
	}
	return current;
}

function typeProblem(issue: z.core.$ZodIssue, present: unknown): string {
	const expected = (issue as { expected?: string }).expected ?? "value";
	const article = /^[aeiou]/.test(expected) ? "an" : "a";
	return `must be ${article} ${expected}${typeof present === "string" ? " (received a string)" : ""}`;
}

/**
 * Branch-scoped, model-readable problems derived from the zod issues, ordered
 * outside-in so a model reads the object before its fields.
 */
function explainIssues(root: JsonSchema, error: z.ZodError, value: unknown): string[] {
	const problems: { path: string; message: string }[] = [];
	const missing = new Map<string, string[]>();
	for (const issue of error.issues) {
		const union = unionProblem(root, issue, value);
		if (union) {
			problems.push(union);
			continue;
		}
		const present = valueAt(value, issue.path);
		if (issue.code === "invalid_type" && present === undefined && issue.path.length > 0) {
			const owner = pathOf(issue.path.slice(0, -1));
			missing.set(owner, [...(missing.get(owner) ?? []), JSON.stringify(issue.path[issue.path.length - 1])]);
			continue;
		}
		if (issue.code === "unrecognized_keys") {
			const allowed = Object.keys(nodeAt(root, issue.path, value)?.properties ?? {});
			for (const key of (issue as { keys: string[] }).keys) {
				const unset = allowed.filter((candidate) => !isRecord(present) || present[candidate] === undefined);
				const hint = similar(key, unset);
				const alternatives = hint
					? ` — did you mean ${JSON.stringify(hint)}?`
					: allowed.length > 0 ? ` (allowed: ${allowed.join(", ")})` : "";
				problems.push({ path: pathOf(issue.path), message: `unknown property ${JSON.stringify(key)}${alternatives}` });
			}
			continue;
		}
		problems.push({
			path: pathOf(issue.path),
			message: issue.code === "invalid_type" ? typeProblem(issue, present) : issue.message,
		});
	}
	const ordered = [
		...[...missing].map(([path, keys]) => ({ path, message: `missing required ${keys.join(", ")}` })),
		...problems,
	].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	const seen = new Set<string>();
	return ordered
		.map((problem) => `${problem.path}: ${problem.message}`)
		.filter((line) => (seen.has(line) ? false : (seen.add(line), true)));
}

// ---------------------------------------------------------------------------

export interface WorkbenchToolSchema<TInput> {
	/** JSON Schema handed to Pi and to the provider. */
	readonly parameters: TUnsafe<TInput>;
	/**
	 * Prepare raw tool-call arguments for one Workbench tool. Throws a
	 * branch-specific, model-readable error when the chosen kind is unknown or its
	 * payload is still invalid after normalization.
	 */
	prepare(args: unknown): TInput;
}

function createToolSchema<TInput>(schema: z.ZodType<TInput>, discriminator: string): WorkbenchToolSchema<TInput> {
	const json = toolJsonSchema(schema);
	const branches = branchesOf(json, json);
	// A union picks its branch by a literal; a single-shape tool has no such gate.
	const kinds = branches.length > 1
		? [...new Set(branches.map((branch) => branch.properties?.[discriminator]?.const).filter((value): value is string => typeof value === "string"))]
		: [];
	return {
		parameters: Type.Unsafe<TInput>(json),
		prepare(argsInput: unknown): TInput {
			let args = argsInput;
			if (typeof args === "string" && JSON_LIKE.test(args)) {
				try {
					args = JSON.parse(args);
				} catch {
					// Fall through to the discriminator explanation below.
				}
			}
			const chosen = isRecord(args) ? args[discriminator] : undefined;
			if (kinds.length > 0 && typeof chosen !== "string") {
				throw new Error(`${discriminator} is required; use one of: ${kinds.join(", ")}`);
			}
			if (kinds.length > 0 && !kinds.includes(chosen as string)) {
				throw new Error(`${discriminator} "${String(chosen)}" is not supported; use one of: ${kinds.join(", ")}`);
			}
			const normalized = normalize(json, json, args);
			const parsed = schema.safeParse(normalized);
			if (parsed.success) return parsed.data;
			const label = typeof chosen === "string" ? chosen : discriminator;
			const detail = explainIssues(json, parsed.error, normalized).slice(0, 8).join("; ") || "does not match the schema";
			throw new Error(`${label} is invalid — ${detail}. Nested objects and arrays must be JSON values, not strings.`);
		},
	};
}

export const WorkbenchViewToolSchema = createToolSchema<WorkbenchViewQuery>(WorkbenchViewQuerySchema, "aspect");
export const WorkbenchSubmitToolSchema = createToolSchema<z.output<typeof WorkbenchSubmitInputSchema>>(WorkbenchSubmitInputSchema, "kind");
const TalkToAgentInputSchema = z.strictObject({
	kind: z.literal("talk-to-agent"),
	reason: z.string().trim().min(1).max(4_000),
});
export type WorkbenchDecisionToolInput = WorkbenchDecisionInput | z.output<typeof TalkToAgentInputSchema>;
export const WorkbenchDecisionToolSchema = createToolSchema<WorkbenchDecisionToolInput>(
	z.discriminatedUnion("kind", [...WorkbenchDecisionInputSchema.options, TalkToAgentInputSchema]),
	"kind",
);

/** The five tools that exist only while a workshop is open. */
export const WorkshopReadToolSchema = createToolSchema<WorkshopReadInput>(WorkshopReadInputSchema, "path");
export const WorkshopWriteToolSchema = createToolSchema<WorkshopWriteInput>(WorkshopWriteInputSchema, "path");
export const WorkshopBashToolSchema = createToolSchema<WorkshopBashInput>(WorkshopBashInputSchema, "argv");
export const WorkshopTryToolSchema = createToolSchema<WorkshopTryInput>(WorkshopTryInputSchema, "tool");
export const WorkshopAuthorToolSchema = createToolSchema<ToolAuthoringBrief>(ToolAuthoringBriefSchema, "name");
