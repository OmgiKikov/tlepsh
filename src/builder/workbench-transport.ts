import { Type } from "typebox";

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
		pattern: Type.String(),
	}, { additionalProperties: false }),
	Type.Object({
		type: Type.Literal("judge"),
		name: Type.Optional(Type.String()),
		rubric: Type.String({ minLength: 1 }),
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

export const WorkbenchViewParameters = Type.Object({
	aspect: Type.Optional(Type.Union([
		Type.Literal("summary"),
		Type.Literal("traces"),
		Type.Literal("review"),
		Type.Literal("target"),
	])),
}, { additionalProperties: false });

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

export const WorkbenchDecisionParameters = Type.Union([
	Type.Object({ kind: Type.Literal("scaffold-target"), reason: DecisionReason }, { additionalProperties: false }),
	Type.Object({
		kind: Type.Literal("configure-target"),
		targetId: Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9][a-z0-9-]*$" }),
		model: Type.Unknown(),
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
]);
