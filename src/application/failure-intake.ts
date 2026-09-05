import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
	DialogueMessageSchema,
	loadTarget,
	type DialogueMessage,
} from "../manifest.js";
import { canonicalJson, HashSchema, hashValue, TargetRevisionSchema } from "../provenance.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import {
	dialogueTurns,
	parseSessionJsonl,
	redactSensitiveText,
	type TraceMessage,
} from "../trace.js";
import { parseDataset, parseDialogueCell } from "./dataset-parse.js";
import { DatasetSourcePathSchema, readDatasetSource } from "./dataset-source.js";
import { boundTargetFeedbackDialogue } from "./target-feedback.js";

const MAX_FAILURE_ARTIFACT_BYTES = 1024 * 1024;
const MAX_REPORTED_TOOL_EVENTS = 200;
const MAX_TOOL_NAME_CHARS = 200;
const MAX_EXACT_REDACTION_VALUES = 100;
const MAX_EXACT_REDACTION_VALUE_CHARS = 4_096;

const ProjectIdSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "projectId must be one safe path segment");
export const ProductionFailureIdSchema = z
	.string()
	.regex(/^failure-[0-9a-f]{64}$/, "failureId must be a canonical production failure identifier");

/** Host-observed Target identity. The revision must satisfy AHDE's real Target revision contract. */
export const ProductionFailureImportedAgainstSchema = z.strictObject({
	id: z.string().min(1).max(200),
	gitSha: TargetRevisionSchema,
});
export type ProductionFailureImportedAgainst = z.infer<typeof ProductionFailureImportedAgainstSchema>;

/**
 * Source-authored identity claim. It is deliberately only bounded text: parsing
 * it does not turn an external service's label into host-verified provenance.
 */
export const ProductionFailureTargetClaimSchema = z.strictObject({
	id: z.string().min(1).max(200),
	gitSha: z.string().min(1).max(200),
});
export type ProductionFailureTargetClaim = z.infer<typeof ProductionFailureTargetClaimSchema>;

export const ProductionFailureSourceKindSchema = z.enum(["real", "synthetic"]);
export type ProductionFailureSourceKind = z.infer<typeof ProductionFailureSourceKindSchema>;

export const ProductionFailureToolEventSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("call"),
		name: z.string().min(1).max(MAX_TOOL_NAME_CHARS),
		evidence: z.literal("reported"),
	}),
	z.strictObject({
		type: z.literal("result"),
		name: z.string().min(1).max(MAX_TOOL_NAME_CHARS),
		isError: z.boolean(),
		evidence: z.literal("reported"),
	}),
]);
export type ProductionFailureToolEvent = z.infer<typeof ProductionFailureToolEventSchema>;

const ProductionFailureSourceSchema = z.strictObject({
	kind: ProductionFailureSourceKindSchema,
	/** Project-relative inbox path. No absolute source path is persisted. */
	path: DatasetSourcePathSchema,
	sha256: HashSchema,
	bytes: z.number().int().positive(),
	format: z.enum(["pi-session-jsonl", "chat-export"]),
});

const ProductionFailureRedactionSchema = z.strictObject({
	/** Credential-shape scrubber plus exact host-supplied values; this is not a PII-safety claim. */
	algorithm: z.literal("trace-credentials+host-exact-values-v1"),
	hostExactValueCount: z.number().int().min(0).max(MAX_EXACT_REDACTION_VALUES),
	redactedSha256: HashSchema,
});

interface ProductionFailureIdentity {
	schemaVersion: 1;
	kind: "production-failure";
	projectId: string;
	source: z.infer<typeof ProductionFailureSourceSchema>;
	importedAgainst: ProductionFailureImportedAgainst;
	targetClaim: ProductionFailureTargetClaim | null;
	redaction: z.infer<typeof ProductionFailureRedactionSchema>;
	messages: DialogueMessage[];
	toolEvents: ProductionFailureToolEvent[];
	omittedToolEventCount: number;
}

function redactedHashOf(
	messages: readonly DialogueMessage[],
	toolEvents: readonly ProductionFailureToolEvent[],
	omittedToolEventCount: number,
): string {
	return hashValue({ messages, toolEvents, omittedToolEventCount });
}

function failureIdOf(identity: ProductionFailureIdentity): string {
	return `failure-${hashValue(identity).slice("sha256:".length)}`;
}

export const ProductionFailureRecordSchema = z.strictObject({
	schemaVersion: z.literal(1),
	kind: z.literal("production-failure"),
	id: ProductionFailureIdSchema,
	projectId: ProjectIdSchema,
	source: ProductionFailureSourceSchema,
	importedAgainst: ProductionFailureImportedAgainstSchema,
	targetClaim: ProductionFailureTargetClaimSchema.nullable(),
	redaction: ProductionFailureRedactionSchema,
	messages: z.array(DialogueMessageSchema).min(2).max(40),
	toolEvents: z.array(ProductionFailureToolEventSchema).max(MAX_REPORTED_TOOL_EVENTS),
	omittedToolEventCount: z.number().int().nonnegative(),
	importedAt: z.iso.datetime({ offset: true }),
}).superRefine((record, context) => {
	if (!record.messages.some((message) => message.role === "user")) {
		context.addIssue({ code: "custom", path: ["messages"], message: "failure trace needs a user turn" });
	}
	if (record.messages.at(-1)?.role !== "assistant") {
		context.addIssue({
			code: "custom",
			path: ["messages"],
			message: "failure trace must end with the failed assistant reply",
		});
	}
	const expectedRedactedHash = redactedHashOf(
		record.messages,
		record.toolEvents,
		record.omittedToolEventCount,
	);
	if (record.redaction.redactedSha256 !== expectedRedactedHash) {
		context.addIssue({
			code: "custom",
			path: ["redaction", "redactedSha256"],
			message: "redacted hash does not match the stored projection",
		});
	}
	const { id: _id, importedAt: _importedAt, ...identity } = record;
	if (record.id !== failureIdOf(identity)) {
		context.addIssue({ code: "custom", path: ["id"], message: "failure id does not match its content" });
	}
});
export type ProductionFailureRecord = z.infer<typeof ProductionFailureRecordSchema>;

/** Exact, versioned reference stored on a reviewed corpus-draft case. */
export const ProductionFailureProvenanceSourceSchema = z.strictObject({
	schemaVersion: z.literal(1),
	failureId: ProductionFailureIdSchema,
	failureHash: HashSchema,
	source: z.strictObject({
		kind: ProductionFailureSourceKindSchema,
		path: DatasetSourcePathSchema,
		sha256: HashSchema,
	}),
	redactedSha256: HashSchema,
	importedAgainst: ProductionFailureImportedAgainstSchema,
	targetClaim: ProductionFailureTargetClaimSchema.nullable(),
	toolEvidence: z.strictObject({
		authority: z.literal("reported"),
		eventCount: z.number().int().nonnegative(),
		omittedCount: z.number().int().nonnegative(),
	}),
});
export type ProductionFailureProvenanceSource = z.infer<typeof ProductionFailureProvenanceSourceSchema>;

export function productionFailureProvenanceSource(
	failureInput: ProductionFailureRecord,
): ProductionFailureProvenanceSource {
	const failure = ProductionFailureRecordSchema.parse(failureInput);
	return ProductionFailureProvenanceSourceSchema.parse({
		schemaVersion: 1,
		failureId: failure.id,
		failureHash: hashValue(failure),
		source: {
			kind: failure.source.kind,
			path: failure.source.path,
			sha256: failure.source.sha256,
		},
		redactedSha256: failure.redaction.redactedSha256,
		importedAgainst: failure.importedAgainst,
		targetClaim: failure.targetClaim,
		toolEvidence: {
			authority: "reported",
			eventCount: failure.toolEvents.length + failure.omittedToolEventCount,
			omittedCount: failure.omittedToolEventCount,
		},
	});
}

export interface ImportProductionFailureOptions {
	projectDir: string;
	stateRoot: string;
	/** Host-owned workspace identity; the Target id is recorded independently. */
	projectId?: string;
	sourcePath: string;
	sourceKind: ProductionFailureSourceKind;
	/** Untrusted external claim, kept separate from the Target the host resolves below. */
	targetClaim?: unknown;
	/** Values already known to the host, such as customer ids selected by an operator. */
	exactRedactionValues?: readonly string[];
}

export interface FailureIntakeDependencies {
	now: () => string;
	resolveImportedAgainst: (projectDir: string) => ProductionFailureImportedAgainst;
}

const DEFAULT_DEPENDENCIES: FailureIntakeDependencies = {
	now: () => new Date().toISOString(),
	resolveImportedAgainst: (projectDir) => {
		const target = loadTarget(projectDir);
		return { id: target.manifest.id, gitSha: target.gitSha };
	},
};

export interface ImportProductionFailureResult {
	failure: ProductionFailureRecord;
	/** Absolute runtime location; no absolute path is persisted in the record. */
	path: string;
	provenance: ProductionFailureProvenanceSource;
}

function boundedToolName(value: unknown, exactValues: readonly string[]): string {
	const raw = typeof value === "string" ? value : "unknown-tool";
	const redacted = redactSensitiveText(raw, exactValues).trim() || "unknown-tool";
	return redacted.length <= MAX_TOOL_NAME_CHARS
		? redacted
		: `${redacted.slice(0, MAX_TOOL_NAME_CHARS - 1)}…`;
}

function reportedTraceTools(
	messages: readonly TraceMessage[],
	exactValues: readonly string[],
): ProductionFailureToolEvent[] {
	const events: ProductionFailureToolEvent[] = [];
	for (const message of messages) {
		for (const call of message.toolCalls ?? []) {
			events.push({ type: "call", name: boundedToolName(call.name, exactValues), evidence: "reported" });
		}
		if (message.toolResult) {
			events.push({
				type: "result",
				name: boundedToolName(message.toolResult.toolName, exactValues),
				isError: message.toolResult.isError,
				evidence: "reported",
			});
		}
	}
	return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep tool shape and ordering, but never import arguments or result text as evidence. */
function reportedJsonTools(value: unknown, exactValues: readonly string[]): ProductionFailureToolEvent[] {
	const events: ProductionFailureToolEvent[] = [];
	const visit = (candidate: unknown, depth: number): void => {
		if (depth > 12) return;
		if (Array.isArray(candidate)) {
			for (const item of candidate) visit(item, depth + 1);
			return;
		}
		if (!isRecord(candidate)) return;

		if (candidate.type === "toolCall" && typeof candidate.name === "string") {
			events.push({ type: "call", name: boundedToolName(candidate.name, exactValues), evidence: "reported" });
		}
		if (candidate.role === "assistant" && Array.isArray(candidate.tool_calls)) {
			for (const toolCall of candidate.tool_calls) {
				const call = isRecord(toolCall) ? toolCall : null;
				const fn = call && isRecord(call.function) ? call.function : null;
				if (fn && typeof fn.name === "string") {
					events.push({ type: "call", name: boundedToolName(fn.name, exactValues), evidence: "reported" });
				}
			}
		}
		if (candidate.role === "tool" || candidate.role === "toolResult") {
			const name = candidate.name ?? candidate.toolName;
			events.push({
				type: "result",
				name: boundedToolName(name, exactValues),
				isError: candidate.isError === true,
				evidence: "reported",
			});
		}
		for (const [key, child] of Object.entries(candidate)) {
			// `tool_calls` was consumed above. Walking it again cannot discover a
			// result and would duplicate its call.
			if (key !== "tool_calls") visit(child, depth + 1);
		}
	};
	visit(value, 0);
	return events;
}

function parseJsonValues(text: string, extension: string): unknown[] {
	if (extension === ".json") return [JSON.parse(text) as unknown];
	const values: unknown[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (!line.trim()) continue;
		try {
			values.push(JSON.parse(line) as unknown);
		} catch (error) {
			throw new Error(`failure trace has invalid JSON at line ${index + 1}`, { cause: error });
		}
	}
	return values;
}

function boundedDialogue(messages: readonly DialogueMessage[], exactValues: readonly string[]): DialogueMessage[] {
	return boundTargetFeedbackDialogue(messages.map((message) => ({
		role: message.role,
		content: redactSensitiveText(message.content, exactValues),
	})));
}

interface ParsedFailureTrace {
	format: "pi-session-jsonl" | "chat-export";
	messages: DialogueMessage[];
	toolEvents: ProductionFailureToolEvent[];
}

function parseFailureTrace(
	text: string,
	extension: string,
	exactValues: readonly string[],
): ParsedFailureTrace {
	if (extension === ".jsonl" || extension === ".ndjson") {
		try {
			const trace = parseSessionJsonl(text);
			if (trace.length > 0) {
				return {
					format: "pi-session-jsonl",
					messages: boundedDialogue(
						dialogueTurns(trace).map((turn) => ({ role: turn.role, content: turn.text })),
						exactValues,
					),
					toolEvents: reportedTraceTools(trace, exactValues),
				};
			}
		} catch {
			// A JSONL chat export is not a Pi session. The shared dataset parser below
			// is the authoritative fallback for those vendor-neutral shapes.
		}
	}

	const dataset = parseDataset({ text, extension });
	if (dataset.rows.length !== 1) {
		throw new Error(`failure intake accepts exactly one trace; source contains ${dataset.rows.length}`);
	}
	const messagesCell = dataset.rows[0]?.cells.messages;
	if (messagesCell === undefined) {
		throw new Error("failure trace has no recognizable messages column");
	}
	const dialogue = parseDialogueCell(messagesCell);
	if ("reason" in dialogue) throw new Error(`failure trace dialogue is invalid: ${dialogue.reason}`);
	const toolEvents = parseJsonValues(text, extension)
		.flatMap((value) => reportedJsonTools(value, exactValues));
	return {
		format: "chat-export",
		messages: boundedDialogue(dialogue.messages, exactValues),
		toolEvents,
	};
}

function exactValues(input: readonly string[] | undefined): string[] {
	const parsed = z.array(z.string().min(1).max(MAX_EXACT_REDACTION_VALUE_CHARS))
		.max(MAX_EXACT_REDACTION_VALUES)
		.parse(input ?? []);
	return [...new Set(parsed)];
}

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function failuresRoot(stateRoot: string, projectIdInput: string, create: boolean): string | null {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const root = resolve(stateRoot);
	if (!existsSync(root)) {
		if (!create) return null;
		mkdirSync(root, { recursive: true, mode: 0o700 });
	}
	const rootEntry = lstatSync(root);
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
		throw new Error(`failure intake stateRoot must be a regular non-symlink directory: ${root}`);
	}
	const canonicalRoot = realpathSync(root);
	let current = root;
	for (const segment of ["projects", projectId, "production-failures"]) {
		const next = join(current, segment);
		if (!existsSync(next)) {
			if (!create) return null;
			mkdirSync(next, { mode: 0o700 });
		}
		const entry = lstatSync(next);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`failure intake state component must be a regular non-symlink directory: ${next}`);
		}
		if (!contained(canonicalRoot, realpathSync(next))) {
			throw new Error("failure intake state path escaped stateRoot");
		}
		current = next;
	}
	return current;
}

function identityOf(record: ProductionFailureRecord): ProductionFailureIdentity {
	const { id: _id, importedAt: _importedAt, ...identity } = record;
	return identity;
}

export function loadProductionFailure(
	stateRoot: string,
	projectIdInput: string,
	failureIdInput: string,
): ProductionFailureRecord {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const failureId = ProductionFailureIdSchema.parse(failureIdInput);
	const root = failuresRoot(stateRoot, projectId, false);
	if (!root) throw new Error(`project ${projectId} has no production failures`);
	const record = readJsonArtifact(
		join(root, `${failureId}.json`),
		ProductionFailureRecordSchema,
		{ maxBytes: MAX_FAILURE_ARTIFACT_BYTES },
	);
	if (record.projectId !== projectId) throw new Error("production failure belongs to a different project");
	return record;
}

/** Import one external trace into a bounded, redacted, content-addressed private record. */
export function importProductionFailure(
	options: ImportProductionFailureOptions,
	dependencies: Partial<FailureIntakeDependencies> = {},
): ImportProductionFailureResult {
	const source = readDatasetSource({
		projectDir: options.projectDir,
		sourcePath: options.sourcePath,
		protectedRoots: [options.stateRoot],
	});
	if (source.extension !== ".json" && source.extension !== ".jsonl" && source.extension !== ".ndjson") {
		throw new Error("failure intake accepts a .json, .jsonl, or .ndjson trace");
	}
	const importedAgainst = ProductionFailureImportedAgainstSchema.parse(
		(dependencies.resolveImportedAgainst ?? DEFAULT_DEPENDENCIES.resolveImportedAgainst)(options.projectDir),
	);
	const projectId = ProjectIdSchema.parse(options.projectId ?? importedAgainst.id);
	const targetClaim = options.targetClaim === undefined
		? null
		: ProductionFailureTargetClaimSchema.parse(options.targetClaim);
	const hostExactValues = exactValues(options.exactRedactionValues);
	const parsed = parseFailureTrace(source.text, source.extension, hostExactValues);
	const toolEvents = parsed.toolEvents.slice(0, MAX_REPORTED_TOOL_EVENTS);
	const omittedToolEventCount = Math.max(0, parsed.toolEvents.length - toolEvents.length);
	const redactedSha256 = redactedHashOf(parsed.messages, toolEvents, omittedToolEventCount);
	const identity: ProductionFailureIdentity = {
		schemaVersion: 1,
		kind: "production-failure",
		projectId,
		source: {
			kind: ProductionFailureSourceKindSchema.parse(options.sourceKind),
			path: source.path,
			sha256: source.sha256,
			bytes: source.bytes,
			format: parsed.format,
		},
		importedAgainst,
		targetClaim,
		redaction: {
			algorithm: "trace-credentials+host-exact-values-v1",
			hostExactValueCount: hostExactValues.length,
			redactedSha256,
		},
		messages: parsed.messages,
		toolEvents,
		omittedToolEventCount,
	};
	const failure = ProductionFailureRecordSchema.parse({
		...identity,
		id: failureIdOf(identity),
		importedAt: (dependencies.now ?? DEFAULT_DEPENDENCIES.now)(),
	});
	const root = failuresRoot(options.stateRoot, projectId, true);
	if (!root) throw new Error("failed to create production failure state directory");
	const path = join(root, `${failure.id}.json`);
	if (existsSync(path)) {
		const existing = loadProductionFailure(options.stateRoot, projectId, failure.id);
		if (canonicalJson(identityOf(existing)) !== canonicalJson(identity)) {
			throw new Error(`content-address collision for production failure ${failure.id}`);
		}
		return { failure: existing, path, provenance: productionFailureProvenanceSource(existing) };
	}
	try {
		writeJsonArtifact(path, ProductionFailureRecordSchema, failure, { immutable: true });
	} catch (error) {
		if (!existsSync(path)) throw error;
		const existing = loadProductionFailure(options.stateRoot, projectId, failure.id);
		if (canonicalJson(identityOf(existing)) !== canonicalJson(identity)) throw error;
		return { failure: existing, path, provenance: productionFailureProvenanceSource(existing) };
	}
	return { failure, path, provenance: productionFailureProvenanceSource(failure) };
}
