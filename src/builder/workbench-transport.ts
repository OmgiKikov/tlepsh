import { Type, type TSchema } from "typebox";
import { Convert, Errors } from "typebox/value";

const NonBlank = (maxLength: number) => Type.String({
	minLength: 1,
	maxLength,
	pattern: "\\S",
});

const WorkbenchArtifactId = Type.String({
	minLength: 1,
	maxLength: 200,
	pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
});

const WorkbenchTaskId = Type.String({
	pattern: "^task-[0-9a-f]{64}$",
});

const AgentSpecParameters = Type.Object({
	title: NonBlank(160),
	purpose: NonBlank(4_000),
	users: Type.Array(NonBlank(500), { maxItems: 50 }),
	jobs: Type.Array(NonBlank(500), { maxItems: 50 }),
	inputs: Type.Array(NonBlank(500), { maxItems: 50 }),
	allowedActions: Type.Array(NonBlank(500), { maxItems: 50 }),
	successCriteria: Type.Array(NonBlank(500), { maxItems: 50 }),
	constraints: Type.Array(NonBlank(500), { maxItems: 50 }),
	openQuestions: Type.Array(NonBlank(500), { maxItems: 50 }),
}, { additionalProperties: false });

// These variants mirror manifest.GraderSpec; task input never accepts an
// untyped object that only fails later in the corpus-draft application layer.
const WorkbenchGraderParameters = Type.Union([
	Type.Object({
		type: Type.Literal("tool_called"),
		name: Type.Optional(Type.String()),
		tool: Type.String(),
		argsContains: Type.Optional(Type.String()),
	}, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("output_contains"),
		name: Type.Optional(Type.String()),
		text: Type.String(),
		caseSensitive: Type.Optional(Type.Boolean()),
	}, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("output_matches"),
		name: Type.Optional(Type.String()),
		pattern: Type.String({
			description: "JavaScript RegExp source tested against the final answer. No inline flags such as (?i) or (?s); use character classes like [Цц] or [Aa] for case-insensitivity.",
		}),
	}, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("judge"),
		name: Type.Optional(Type.String()),
		rubric: Type.String({
			minLength: 1,
			description: "Rubric for a model judge. Only usable when the Target manifest configures evalSuite.judge; otherwise prefer output_contains, output_matches, or tool_called.",
		}),
	}, { additionalProperties: false }),
]);

const WorkbenchCorpusTaskParameters = Type.Object({
	input: NonBlank(32_000),
	graders: Type.Array(WorkbenchGraderParameters, { minItems: 1, maxItems: 16 }),
}, { additionalProperties: false });

const WorkbenchCorpusOperationParameters = Type.Union([
	Type.Object({ type: Type.Literal("add"), task: WorkbenchCorpusTaskParameters }, { additionalProperties: false }),
	Type.Object({ type: Type.Literal("replace"), taskId: WorkbenchTaskId, task: WorkbenchCorpusTaskParameters }, { additionalProperties: false }),
	Type.Object({ type: Type.Literal("remove"), taskId: WorkbenchTaskId }, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("set-graders"),
		taskId: WorkbenchTaskId,
		graders: Type.Array(WorkbenchGraderParameters, { minItems: 1, maxItems: 16 }),
	}, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("grader.add"),
		taskId: WorkbenchTaskId,
		grader: WorkbenchGraderParameters,
	}, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("grader.update"),
		taskId: WorkbenchTaskId,
		graderIndex: Type.Integer({ minimum: 0, maximum: 15 }),
		grader: WorkbenchGraderParameters,
	}, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("grader.remove"),
		taskId: WorkbenchTaskId,
		graderIndex: Type.Integer({ minimum: 0, maximum: 15 }),
	}, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("add-case-from-run"),
		evalRunId: WorkbenchArtifactId,
		runId: WorkbenchArtifactId,
		task: WorkbenchCorpusTaskParameters,
	}, { additionalProperties: false }),
	Type.Object({ type: Type.Literal("rename"), name: NonBlank(200) }, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("set-notes"),
		coverageNotes: Type.Array(NonBlank(1_000), { maxItems: 100 }),
	}, { additionalProperties: false }),
]);

const HarnessPermissionsParameters = Type.Object({
	environment: Type.Array(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }), { maxItems: 32 }),
	network: Type.Union([Type.Literal("deny"), Type.Literal("allow")]),
	filesystem: Type.Union([Type.Literal("read-only"), Type.Literal("workspace-write")]),
}, { additionalProperties: false });

const AuthoredText = Type.String({
	minLength: 1,
	maxLength: 512 * 1024,
	pattern: "^(?=[\\s\\S]*\\S)[^\\u0000\\r]+$",
});
const CommandArgument = Type.String({
	minLength: 1,
	maxLength: 4_096,
	pattern: "^[^\\u0000\\r\\n]+$",
});

const HarnessIntentParameters = Type.Union([
	Type.Object({
		type: Type.Literal("instructions.replace"),
		content: AuthoredText,
	}, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("execution.configure"),
		execution: Type.Object({
			tools: Type.Array(Type.Union([
				Type.Literal("read"),
				Type.Literal("bash"),
				Type.Literal("edit"),
				Type.Literal("write"),
			]), { minItems: 1, maxItems: 4, uniqueItems: true }),
			environmentAllowlist: Type.Array(
				Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
				{ maxItems: 32, uniqueItems: true },
			),
			network: Type.Union([Type.Literal("deny"), Type.Literal("allow")]),
			sandbox: Type.Union([Type.Literal("required"), Type.Literal("best-effort"), Type.Literal("off")]),
		}, { additionalProperties: false }),
	}, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("skill.upsert"),
		name: Type.String({ pattern: "^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" }),
		description: Type.String({ minLength: 1, maxLength: 1_024, pattern: "^(?=.*\\S)[^\\u0000\\r\\n]+$" }),
		body: AuthoredText,
		disableModelInvocation: Type.Optional(Type.Boolean()),
	}, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("skill.remove"),
		name: Type.String({ pattern: "^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" }),
	}, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("tool.upsert"),
		name: Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" }),
		descriptor: Type.Object({
			description: Type.String({ minLength: 1, maxLength: 2_000, pattern: "^(?=[\\s\\S]*\\S)[^\\u0000\\r]+$" }),
			parameters: Type.Record(Type.String(), Type.Unknown()),
			arguments: Type.Optional(Type.Array(CommandArgument, { maxItems: 31 })),
			timeoutMs: Type.Integer({ minimum: 1, maximum: 120_000 }),
			maxOutputBytes: Type.Integer({ minimum: 1, maximum: 1024 * 1024 }),
			output: Type.Union([Type.Literal("json"), Type.Literal("text")]),
			permissions: HarnessPermissionsParameters,
		}, { additionalProperties: false }),
		executable: Type.String({
			minLength: 1,
			maxLength: 512 * 1024,
			pattern: "^#![^\\u0000\\r\\n]+\\n[^\\u0000\\r]*$",
		}),
	}, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("tool.remove"),
		name: Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" }),
	}, { additionalProperties: false }),
]);

const FailureModeIdParameters = Type.String({
	pattern: "^failure-mode-[0-9a-f]{24}$",
});

const ImprovementBriefSourceParameters = Type.Object({
	algorithmId: Type.Literal("exact-eval-signals-v1"),
	evalRunId: WorkbenchArtifactId,
	diagnosisId: WorkbenchArtifactId,
	briefId: Type.String({ pattern: "^brief-[0-9a-f]{24}$" }),
}, { additionalProperties: false });

const TargetAuthoringContextClaimParameters = Type.Object({
	algorithmId: Type.Literal("git-manifest-context-v1"),
	targetId: Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9][a-z0-9-]*$" }),
	targetGitSha: Type.String({ pattern: "^[0-9a-f]{40}$" }),
	contextHash: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
}, { additionalProperties: false });

export const WorkbenchViewParameters = Type.Union([
	Type.Object({
		aspect: Type.Optional(Type.Union([
			Type.Literal("summary"),
			Type.Literal("traces"),
			Type.Literal("review"),
		])),
	}, { additionalProperties: false }),
	Type.Object({
		aspect: Type.Literal("target"),
		resourcePath: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
	}, { additionalProperties: false }),
]);

export const WorkbenchSubmitParameters = Type.Union([
	Type.Object({
		kind: Type.Literal("select"),
		entity: Type.Union([
			Type.Literal("spec-draft"),
			Type.Literal("approved-spec"),
			Type.Literal("corpus-draft"),
			Type.Literal("development-corpus"),
			Type.Literal("eval-run"),
			Type.Literal("proposal"),
			Type.Literal("candidate"),
		]),
		id: WorkbenchArtifactId,
	}, { additionalProperties: false }),
	Type.Object({
		kind: Type.Literal("spec-draft"),
		spec: AgentSpecParameters,
		sourceText: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
	}, { additionalProperties: false }),
	Type.Object({
		kind: Type.Literal("corpus-draft"),
		approvedSpecId: Type.Optional(WorkbenchArtifactId),
		name: NonBlank(200),
		tasks: Type.Array(WorkbenchCorpusTaskParameters, { minItems: 1, maxItems: 100 }),
		coverageNotes: Type.Optional(Type.Array(NonBlank(1_000), { maxItems: 100 })),
		revisionSummary: NonBlank(4_000),
	}, { additionalProperties: false }),
	Type.Object({
		kind: Type.Literal("corpus-import"),
		approvedSpecId: Type.Optional(WorkbenchArtifactId),
		sourcePath: Type.String({
			minLength: 1,
			maxLength: 4_096,
			pattern: "^imports\\/(?!\\.)(?!\\s)(?!.*\\s$)(?!.*[\\\\\\u0000\\r\\n])(?!.*//)(?!.*\\/\\.)[^/][^\\u0000\\r\\n]*\\.jsonl$",
		}),
		name: NonBlank(200),
		coverageNotes: Type.Optional(Type.Array(NonBlank(1_000), { maxItems: 100 })),
		revisionSummary: NonBlank(4_000),
	}, { additionalProperties: false }),
	Type.Object({
		kind: Type.Literal("corpus-revision"),
		approvedSpecId: Type.Optional(WorkbenchArtifactId),
		parentDraftId: Type.Optional(WorkbenchArtifactId),
		operations: Type.Array(WorkbenchCorpusOperationParameters, { minItems: 1, maxItems: 200 }),
		revisionSummary: NonBlank(4_000),
	}, { additionalProperties: false }),
	Type.Object({
		kind: Type.Literal("structured-proposal"),
		authoringContext: TargetAuthoringContextClaimParameters,
		approvedSpecId: Type.Optional(WorkbenchArtifactId),
		source: ImprovementBriefSourceParameters,
		failureModeIds: Type.Array(FailureModeIdParameters, {
			minItems: 1,
			maxItems: 8,
			uniqueItems: true,
		}),
		summary: NonBlank(4_000),
		intents: Type.Array(HarnessIntentParameters, { minItems: 1, maxItems: 32 }),
		risks: Type.Optional(Type.Array(NonBlank(4_000), { maxItems: 100 })),
		validationPlan: Type.Array(NonBlank(4_000), { minItems: 1, maxItems: 100 }),
	}, { additionalProperties: false }),
]);

const DecisionReason = NonBlank(4_000);

const TargetModelSelectionParameters = Type.Object({
	provider: Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
	modelId: Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
	thinkingLevel: Type.Optional(Type.Union([
		Type.Literal("off"),
		Type.Literal("minimal"),
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
		Type.Literal("xhigh"),
		Type.Literal("max"),
	])),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 3_600_000 })),
	params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });

export const WorkbenchDecisionParameters = Type.Union([
	Type.Object({ kind: Type.Literal("scaffold-target"), reason: DecisionReason }, { additionalProperties: false }),
	Type.Object({
		kind: Type.Literal("configure-target"),
		targetId: Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9][a-z0-9-]*$" }),
		model: TargetModelSelectionParameters,
		reason: DecisionReason,
	}, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("run-current"), repetitions: Type.Integer({ minimum: 1, maximum: 10 }), reason: DecisionReason }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("approve-spec"), draftSpecId: Type.Optional(WorkbenchArtifactId), reason: DecisionReason }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("publish-corpus"), draftId: Type.Optional(WorkbenchArtifactId), name: Type.Optional(NonBlank(200)), reason: DecisionReason }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("run-eval"), developmentCorpusId: Type.Optional(WorkbenchArtifactId), repetitions: Type.Integer({ minimum: 1, maximum: 10 }), reason: DecisionReason }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("apply-proposal"), runId: Type.Optional(WorkbenchArtifactId), branch: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$" }), reason: DecisionReason }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("discard-proposal"), runId: Type.Optional(WorkbenchArtifactId), reason: DecisionReason }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("verify-candidate"), builderRunId: Type.Optional(WorkbenchArtifactId), repetitions: Type.Integer({ minimum: 1, maximum: 10 }), reason: DecisionReason }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("abandon-candidate"), candidateId: Type.Optional(WorkbenchArtifactId), reason: DecisionReason }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("review-candidate"), candidateId: Type.Optional(WorkbenchArtifactId), recommendation: Type.Union([Type.Literal("promote"), Type.Literal("reject")]), reason: DecisionReason }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("promote-candidate"), candidateId: Type.Optional(WorkbenchArtifactId), version: Type.String({ pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$", maxLength: 50 }), reason: DecisionReason }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("reject-candidate"), candidateId: Type.Optional(WorkbenchArtifactId), reason: DecisionReason }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("adopt-candidate"), candidateId: Type.Optional(WorkbenchArtifactId), reason: DecisionReason }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("continue-cycle"), candidateId: Type.Optional(WorkbenchArtifactId), reason: DecisionReason }, { additionalProperties: false }),
]);

/**
 * Model-side compatibility shim, run by Pi before schema validation.
 *
 * Several models (notably through OpenRouter) send nested objects and arrays
 * as JSON *strings*. Rejecting those with the raw union error dump made one
 * live Builder loop five times on a single Spec draft. This shim parses such
 * strings wherever the schema expects an object or array, then validates the
 * discriminated branch the model chose and reports only that branch's errors.
 * It grants no authority: the strict schema still validates the result.
 */
const JSON_LIKE = /^\s*[[{]/;

type LooseSchema = {
	type?: string;
	anyOf?: LooseSchema[];
	properties?: Record<string, LooseSchema>;
	items?: LooseSchema;
	patternProperties?: Record<string, LooseSchema>;
	const?: unknown;
};

function expects(schema: LooseSchema | undefined): { object: boolean; array: boolean } {
	if (!schema) return { object: false, array: false };
	if (Array.isArray(schema.anyOf)) {
		return schema.anyOf.reduce<{ object: boolean; array: boolean }>(
			(acc, item) => {
				const inner = expects(item);
				return { object: acc.object || inner.object, array: acc.array || inner.array };
			},
			{ object: false, array: false },
		);
	}
	return {
		object: schema.type === "object" || schema.patternProperties !== undefined,
		array: schema.type === "array",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(schema: LooseSchema | undefined, input: unknown): unknown {
	if (!schema) return input;
	let value = input;
	const shape = expects(schema);
	if (typeof value === "string" && (shape.object || shape.array) && JSON_LIKE.test(value)) {
		try {
			const parsed: unknown = JSON.parse(value);
			if ((shape.object && isRecord(parsed)) || (shape.array && Array.isArray(parsed))) value = parsed;
		} catch {
			return value;
		}
	}
	if (Array.isArray(schema.anyOf)) {
		const branch = schema.anyOf.find((item) => {
			const inner = expects(item);
			return (Array.isArray(value) && inner.array) || (isRecord(value) && inner.object);
		});
		return branch ? normalize(branch, value) : value;
	}
	if (schema.type === "array" && Array.isArray(value)) {
		return value.map((item) => normalize(schema.items, item));
	}
	if (schema.type === "object" && isRecord(value)) {
		const properties = schema.properties ?? {};
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			out[key] = key in properties ? normalize(properties[key], item) : item;
		}
		return out;
	}
	return value;
}

/**
 * Prepare raw tool-call arguments for one Workbench tool. Throws a
 * branch-specific, model-readable error when the chosen `kind` is unknown or
 * its payload is still invalid after normalization.
 */
export function prepareWorkbenchArguments(
	schema: TSchema,
	argsInput: unknown,
	discriminator = "kind",
): unknown {
	let args = argsInput;
	if (typeof args === "string" && JSON_LIKE.test(args)) {
		try {
			args = JSON.parse(args);
		} catch {
			return argsInput;
		}
	}
	if (!isRecord(args)) return argsInput;
	const loose = schema as unknown as LooseSchema;
	const branches = Array.isArray(loose.anyOf) ? loose.anyOf : [loose];
	const constOf = (branch: LooseSchema): unknown => branch.properties?.[discriminator]?.const;
	const literalsOf = (branch: LooseSchema): string[] => {
		const property = branch.properties?.[discriminator];
		if (!property) return [];
		if (typeof property.const === "string") return [property.const];
		return (property.anyOf ?? []).map((item) => item.const).filter((value): value is string => typeof value === "string");
	};
	const kinds = [...new Set(branches.flatMap(literalsOf))];
	const chosen = args[discriminator];
	// Exact literal first, then a branch whose (optional) discriminator lists the value,
	// then a branch that leaves the discriminator open when none was given.
	const branch = typeof chosen === "string"
		? branches.find((item) => constOf(item) === chosen) ?? branches.find((item) => literalsOf(item).includes(chosen))
		: branches.find((item) => constOf(item) === undefined);
	if (!branch) {
		throw new Error(
			typeof chosen === "string"
				? `${discriminator} "${chosen}" is not supported; use one of: ${kinds.join(", ")}`
				: `${discriminator} is required; use one of: ${kinds.join(", ")}`,
		);
	}
	// Scalars arrive as strings too ("1", "true"); Convert coerces them only
	// where the schema expects a number or boolean, never the other way round.
	const normalized = Convert(branch as unknown as TSchema, normalize(branch, args));
	if (![...Errors(branch as unknown as TSchema, normalized)].length) return normalized;
	const label = typeof chosen === "string" ? chosen : discriminator;
	const problems = explainWorkbenchArguments(branch as unknown as TSchema, normalized);
	const detail = (problems.length > 0 ? problems : ["does not match the schema"]).slice(0, 8).join("; ");
	throw new Error(`${label} is invalid — ${detail}. Nested objects and arrays must be JSON values, not strings.`);
}

// ---------------------------------------------------------------------------
// Model-readable validation: walk the branch schema and explain each problem
// with what *is* allowed, so a model can repair its call in one retry.

interface Problem {
	path: string;
	message: string;
}

function schemaKeys(schema: LooseSchema): string[] {
	return Object.keys(schema.properties ?? {});
}

function requiredKeys(schema: LooseSchema & { required?: string[] }): string[] {
	return Array.isArray(schema.required) ? schema.required : [];
}

/** A key every branch declares with a literal value, e.g. `type` or `kind`. */
function discriminatorOf(branches: LooseSchema[]): string | null {
	const first = branches[0]?.properties ?? {};
	for (const key of Object.keys(first)) {
		if (branches.every((branch) => branch.properties?.[key]?.const !== undefined)) return key;
	}
	return null;
}

function describeBranch(branch: LooseSchema & { required?: string[] }, discriminator: string): string {
	const required = new Set(requiredKeys(branch));
	const fields = schemaKeys(branch)
		.filter((key) => key !== discriminator)
		.map((key) => (required.has(key) ? key : `${key}?`));
	return `${JSON.stringify(branch.properties?.[discriminator]?.const)} {${fields.join(", ")}}`;
}

function similar(candidate: string, options: string[]): string | undefined {
	const lower = candidate.toLowerCase();
	return options.find((option) => {
		const other = option.toLowerCase();
		return other.includes(lower) || lower.includes(other) || other.replace(/id$/, "") === lower.replace(/id$/, "");
	});
}

function explain(schema: LooseSchema & { required?: string[]; additionalProperties?: boolean }, value: unknown, path: string, problems: Problem[]): void {
	if (Array.isArray(schema.anyOf)) {
		const branches = schema.anyOf as (LooseSchema & { required?: string[] })[];
		const discriminator = branches.every((branch) => branch.type === "object") ? discriminatorOf(branches) : null;
		if (discriminator && isRecord(value)) {
			const chosen = value[discriminator];
			const branch = branches.find((item) => item.properties?.[discriminator]?.const === chosen);
			if (branch) {
				explain(branch, value, path, problems);
			} else {
				const noun = discriminator === "type" ? "type" : discriminator;
				problems.push({
					path,
					message: `${noun} ${chosen === undefined ? "is missing" : `${JSON.stringify(chosen)} is not supported`}; use one of: ${branches.map((item) => describeBranch(item, discriminator)).join(", ")}`,
				});
			}
			return;
		}
		// Unions of literals or scalars: TypeBox's own message is precise enough.
		for (const error of Errors(schema as unknown as TSchema, value)) {
			problems.push({ path: `${path}${error.instancePath}`, message: error.message });
			break;
		}
		return;
	}
	if (schema.type === "object") {
		if (!isRecord(value)) {
			problems.push({ path, message: `must be an object${typeof value === "string" ? " (received a string)" : ""}` });
			return;
		}
		const allowed = schemaKeys(schema);
		const missing = requiredKeys(schema).filter((key) => value[key] === undefined);
		if (missing.length > 0) problems.push({ path, message: `missing required ${missing.map((key) => JSON.stringify(key)).join(", ")}` });
		if (schema.additionalProperties === false && allowed.length > 0) {
			const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
			for (const key of unknown) {
				const hint = similar(key, allowed.filter((candidate) => value[candidate] === undefined));
				problems.push({ path, message: `unknown property ${JSON.stringify(key)}${hint ? ` — did you mean ${JSON.stringify(hint)}?` : ` (allowed: ${allowed.join(", ")})`}` });
			}
		}
		for (const [key, property] of Object.entries(schema.properties ?? {})) {
			if (value[key] === undefined) continue;
			explain(property as LooseSchema, value[key], `${path}/${key}`, problems);
		}
		return;
	}
	if (schema.type === "array") {
		if (!Array.isArray(value)) {
			problems.push({ path, message: `must be an array${typeof value === "string" ? " (received a string)" : ""}` });
			return;
		}
		const errors = [...Errors(schema as unknown as TSchema, value)].filter((error) => error.instancePath === "");
		for (const error of errors) problems.push({ path, message: error.message });
		value.forEach((item, index) => explain(schema.items as LooseSchema, item, `${path}/${index}`, problems));
		return;
	}
	for (const error of Errors(schema as unknown as TSchema, value)) {
		problems.push({ path: `${path}${error.instancePath}`, message: error.message });
		break;
	}
}

/** Branch-scoped, model-readable problems; empty when the value is valid. */
export function explainWorkbenchArguments(branch: TSchema, value: unknown): string[] {
	const problems: Problem[] = [];
	explain(branch as unknown as LooseSchema, value, "", problems);
	const seen = new Set<string>();
	return problems
		.map((problem) => `${problem.path || "/"}: ${problem.message}`)
		.filter((line) => (seen.has(line) ? false : (seen.add(line), true)));
}
