/**
 * Host-side sealed synthetic generation: an exam nobody in the loop has read.
 *
 * A sealed holdout only measures something if no agent in the improvement loop
 * ever saw it. Importing one is the honest path when real cases exist; when
 * they do not, somebody has to write it — and the one model that may is the
 * JUDGE, because it is already outside the Target's trust domain and its output
 * already never re-enters a Builder context. The Builder must not: a model that
 * writes the exam and then authors the harness has read its own holdout, and
 * every number after that is an echo (the same argument `configure-evaluators`
 * makes for refusing a judge equal to the Target model, one step earlier).
 *
 * So this module is deliberately NOT a Builder tool. It is a host command that
 * calls the configured judge endpoint directly, parses the answer, derives its
 * own case ids, and writes the result straight into an immutable sealed corpus
 * — or into one operator-owned file for a human to edit and seal. Case text
 * never reaches a return value, a log line, an error message, or a receipt.
 */

import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	rmdirSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
	createCorpus,
	CorpusTaskSchema,
	type CorpusMetadata,
	type CorpusTask,
} from "../corpus.js";
import { SEALED_GATE_POLICY } from "../domain/comparison-gate.js";
import { kbIndexHash as kbIndexHashOf, type KbChunk } from "../domain/kb.js";
import { knowledgeBaseDeclared, readKnowledgeBase, KB_DATA_DECLARATION } from "../target/kb-tool.js";
import { callEvaluatorModel, evaluatorCostUsd } from "../evaluator-model.js";
import { loadTarget, taskDialogueIssue, type GraderSpec, type ResolvedTarget } from "../manifest.js";
import {
	canonicalJson,
	HashSchema,
	hashValue,
	ModelFingerprintSchema,
	modelFingerprint,
	sha256Hex,
} from "../provenance.js";
import { AgentSpecSchema, listSpecSnapshots, type AgentSpec } from "../spec.js";
import { readJsonArtifact, writeJsonArtifact, writeTextArtifact } from "../storage/artifacts.js";
import { sameModelAsTarget } from "./configure-evaluators.js";

/** A generated exam stays something a human could still read in one sitting. */
export const MAX_SEALED_SYNTH_CASES = 200;
/** Format examples. More than a handful teaches imitation, not format. */
export const MAX_SEALED_SYNTH_EXAMPLES = 20;
export const DEFAULT_SEALED_SYNTH_EXAMPLES = 5;
const MAX_SPEC_BYTES = 64 * 1024;
const MAX_GENERATOR_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_GRADER_SHAPES = 16;
const RECEIPT_DIRECTORY = "sealed-synth";
const EXCHANGE_DIRECTORY = "exchanges";

const ProjectIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const CorpusIdSchema = z.string().regex(/^corpus-[0-9a-f]{64}$/);
const ReceiptShaSchema = z.string().regex(/^[0-9a-f]{64}$/);
const TaskIdSchema = z.string().min(1).max(200);

/**
 * A refusal is a decision, not a crash: the operator is told what is missing
 * and what to run next, and the process exits 2 rather than 1.
 */
export class SealedSynthRefusal extends Error {
	readonly name = "SealedSynthRefusal";
	readonly next: string;

	constructor(message: string, next: string) {
		super(message);
		this.next = next;
	}
}

// ---------- receipt ----------

/**
 * What one generation is allowed to remember. Every field here is either a
 * hash, a count, an id, or a model coordinate; nothing reconstructs a case, and
 * `developmentExampleIds` names only cases the Builder may already read.
 */
const SealedSynthReceiptFields = {
	projectId: ProjectIdSchema,
	targetId: z.string().min(1).max(100),
	corpusName: z.string().trim().min(1).max(200),
	/** The exact generator endpoint, by the same rule every evaluator call uses. */
	generator: ModelFingerprintSchema,
	generatorHash: HashSchema,
	/** sha256 of { system, user }: the exact question the generator was asked. */
	promptSha256: HashSchema,
	/** sha256 of the Spec text the prompt carried. */
	specSha256: HashSchema,
	specSource: z.enum(["from-file", "target-spec-md", "approved-spec"]),
	/** The approved snapshot id when the Spec came from one; null otherwise. */
	specId: z.string().regex(/^spec-[0-9a-f]{64}$/).nullable(),
	/** Development case ids shown as format examples. Development, so nameable. */
	developmentExampleIds: z.array(TaskIdSchema).max(MAX_SEALED_SYNTH_EXAMPLES),
	requested: z.number().int().positive().max(MAX_SEALED_SYNTH_CASES),
	seed: z.string().min(1).max(200).nullable(),
	accepted: z.number().int().nonnegative(),
	droppedMalformed: z.number().int().nonnegative(),
	droppedDuplicate: z.number().int().nonnegative(),
	outcome: z.discriminatedUnion("kind", [
		z.strictObject({
			kind: z.literal("sealed"),
			corpusId: CorpusIdSchema,
			corpusHash: HashSchema,
			taskCount: z.number().int().positive(),
		}),
		z.strictObject({
			kind: z.literal("review"),
			/** The operator's own path. A pointer to a file, never its contents. */
			reviewPath: z.string().min(1).max(1_024),
			caseCount: z.number().int().positive(),
		}),
		/**
		 * A draft that came back. Written when a sealed import names a review file
		 * this project generated, so the exam's origin — generated, then read and
		 * edited by a human — survives into the passport. Still a pointer and a
		 * count: the import read the file, this record never does.
		 */
		z.strictObject({
			kind: z.literal("review-imported"),
			reviewPath: z.string().min(1).max(1_024),
			corpusId: CorpusIdSchema,
			corpusHash: HashSchema,
			taskCount: z.number().int().positive(),
		}),
	]),
	at: z.iso.datetime({ offset: true }),
} as const;

/**
 * The receipt as it was written before a knowledge base could be the subject.
 * Kept verbatim, and never rewritten: a receipt's filename is the hash of its
 * own content, so upgrading one in place would break the address it is stored
 * under. Old receipts are read as what they are and answer `spec` when asked
 * where their questions came from.
 */
export const SealedSynthReceiptV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	...SealedSynthReceiptFields,
});

/**
 * Version 2 adds the two facts a knowledge-base exam has and a Spec exam does
 * not: which source the questions were written from, and the identity of the
 * chunk index they were written from. `kbIndexHash` is null on the `spec`
 * source — an absent knowledge base is a fact, not a hash of nothing.
 */
export const SealedSynthReceiptV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	...SealedSynthReceiptFields,
	source: z.enum(["spec", "kb"]),
	kbIndexHash: HashSchema.nullable(),
});

export const SealedSynthReceiptSchema = z.discriminatedUnion("schemaVersion", [
	SealedSynthReceiptV1Schema,
	SealedSynthReceiptV2Schema,
]);
export type SealedSynthReceipt = z.infer<typeof SealedSynthReceiptSchema>;

/** Where one receipt's questions came from, in either schema version. */
export function sealedSynthSource(receipt: SealedSynthReceipt): "spec" | "kb" {
	return receipt.schemaVersion === 2 ? receipt.source : "spec";
}

/**
 * How a sealed exam came to exist, as far as a receipt can say. `null` is the
 * ordinary case: an exam the operator brought, whose provenance is theirs.
 */
export type SealedExamOrigin =
	| "judge-generated"
	| "judge-generated-reviewed"
	| "judge-generated-kb"
	| "judge-generated-kb-reviewed";

/**
 * What the questions are written from. `spec` is the original path and stays
 * the default, so every existing receipt, test and dialog is unchanged. `kb`
 * writes each question from one passage of the Target's declared knowledge
 * base, which is the only honest exam for an agent that answers from documents.
 */
export type SealedSynthSource = "spec" | "kb";

export interface SealedSynthOptions {
	targetDir: string;
	stateRoot: string;
	/** Defaults to the Target id at the CLI boundary; required here. */
	projectId: string;
	name: string;
	/** N: how many new cases the generator is asked for. */
	count: number;
	source?: SealedSynthSource | undefined;
	seed?: string | undefined;
	/** `--from`: an explicit Spec file. */
	specPath?: string | undefined;
	/** K: development cases shown as format examples. */
	examples?: number | undefined;
	/** `--review`: write the cases out for a human instead of sealing them. */
	reviewPath?: string | undefined;
	now?: () => string;
	signal?: AbortSignal | undefined;
}

/**
 * Everything that can be said about a generation *before* it happens: which
 * model will write it, from which Spec, how many format examples it will see,
 * what the question hashes to, and what it should cost. Every field is a
 * coordinate, a count, or a hash — a plan is a subject a human can approve, so
 * it is exactly the part of a sealed exam that is safe to show.
 */
export interface SealedSynthPlan {
	/** Where the questions come from: the Spec, or the knowledge base. */
	source: SealedSynthSource;
	/**
	 * Identity of the chunk index the questions will be written from, or null on
	 * the Spec source. Present in the approved subject, so a knowledge base that
	 * changed between the dialog and the call is a stale decision.
	 */
	kbIndexHash: string | null;
	/** Passages the generator will be shown, one per call. Empty on `spec`. */
	kbChunkIds: string[];
	/** `<provider>/<id>` of the judge that will write the exam. */
	generatorModel: string;
	generatorHash: string;
	promptSha256: string;
	/** UTF-8 size of `{ system, user }`, the basis of the input-token estimate. */
	promptBytes: number;
	specSource: SealedSynthReceipt["specSource"];
	specId: string | null;
	specSha256: string;
	/** How many development cases the generator will actually be shown. */
	examples: number;
	developmentExampleIds: string[];
	requested: number;
	seed: string | null;
	/** Where the draft would land, on the review path; null when sealing. */
	reviewPath: string | null;
	/** From the judge's declared rates. An estimate, and named as one. */
	estimatedCostUsd: number;
}

export interface SealedSynthResult {
	receipt: SealedSynthReceipt;
	receiptPath: string;
	/** Where the questions came from. */
	source: SealedSynthSource;
	/** Present on the sealing path. Metadata only — content is never loaded. */
	corpus: CorpusMetadata | null;
	/** Present on the review path. The operator's own path, echoed back. */
	reviewPath: string | null;
	/** `<provider>/<id>` of the judge that wrote the exam. */
	generatorModel: string;
	promptSha256: string;
	requested: number;
	accepted: number;
	droppedMalformed: number;
	droppedDuplicate: number;
}

// ---------- state layout ----------

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function receiptsRoot(stateRoot: string, projectIdInput: string, create: boolean): string | null {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const root = resolve(stateRoot);
	if (!existsSync(root)) {
		if (!create) return null;
		mkdirSync(root, { recursive: true, mode: 0o700 });
	}
	const rootEntry = lstatSync(root);
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
		throw new Error(`sealed synthesis stateRoot must be a regular non-symlink directory: ${root}`);
	}
	const canonicalRoot = realpathSync(root);
	let current = root;
	for (const segment of ["projects", projectId, RECEIPT_DIRECTORY]) {
		const next = join(current, segment);
		if (!existsSync(next)) {
			if (!create) return null;
			mkdirSync(next, { mode: 0o700 });
		}
		const entry = lstatSync(next);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`sealed synthesis state component must be a regular non-symlink directory: ${next}`);
		}
		if (!contained(canonicalRoot, realpathSync(next))) {
			throw new Error("sealed synthesis state path escaped stateRoot");
		}
		current = next;
	}
	return current;
}

function receiptSha(receipt: SealedSynthReceipt): string {
	const { at: _at, ...identity } = receipt;
	return hashValue(identity).slice("sha256:".length);
}

// ---------- the Spec the exam is written from ----------

function readSpecFile(path: string, label: string): string {
	const resolved = resolve(path);
	let entry;
	try {
		entry = lstatSync(resolved);
	} catch {
		throw new SealedSynthRefusal(
			`${label} cannot be read: ${resolved}`,
			"point --from at a regular readable file holding the reviewed Spec text",
		);
	}
	if (!entry.isFile() || entry.isSymbolicLink()) {
		throw new SealedSynthRefusal(
			`${label} must be a regular, non-symlink file: ${resolved}`,
			"point --from at a regular file, not a symlink or a directory",
		);
	}
	if (entry.size > MAX_SPEC_BYTES) {
		throw new SealedSynthRefusal(
			`${label} is ${entry.size} bytes, over the ${MAX_SPEC_BYTES} byte bound`,
			"trim the Spec to the reviewed contract; a generator prompt is not a document store",
		);
	}
	const text = readFileSync(resolved, "utf8");
	if (text.trim().length === 0) {
		throw new SealedSynthRefusal(`${label} is empty: ${resolved}`, "write the Spec before asking for an exam about it");
	}
	return text;
}

/** The approved snapshot rendered the way a human wrote it down. */
function renderApprovedSpec(spec: AgentSpec): string {
	const section = (title: string, items: readonly string[]): string[] =>
		items.length === 0 ? [] : [`## ${title}`, ...items.map((item) => `- ${item}`), ""];
	return [
		`# ${spec.title}`,
		"",
		spec.purpose,
		"",
		...section("Users", spec.users),
		...section("Jobs", spec.jobs),
		...section("Inputs", spec.inputs),
		...section("Allowed actions", spec.allowedActions),
		...section("Success criteria", spec.successCriteria),
		...section("Constraints", spec.constraints),
	].join("\n");
}

interface ResolvedSpec {
	text: string;
	source: SealedSynthReceipt["specSource"];
	specId: string | null;
}

function resolveSpec(options: SealedSynthOptions, target: ResolvedTarget): ResolvedSpec {
	if (options.specPath !== undefined) {
		return { text: readSpecFile(options.specPath, "the --from Spec file"), source: "from-file", specId: null };
	}
	const inTarget = join(target.dir, "spec.md");
	if (existsSync(inTarget)) {
		return { text: readSpecFile(inTarget, "the Target's spec.md"), source: "target-spec-md", specId: null };
	}
	const approved = listSpecSnapshots(options.stateRoot, options.projectId)
		.filter((snapshot) => snapshot.status === "approved");
	const newest = approved[0];
	if (newest) {
		return {
			text: renderApprovedSpec(AgentSpecSchema.parse(newest.spec)),
			source: "approved-spec",
			specId: newest.id,
		};
	}
	throw new SealedSynthRefusal(
		`no Spec to write an exam from: ${join(target.dir, "spec.md")} does not exist and project ` +
			`${options.projectId} has no approved Spec`,
		"pass --from <spec.md>, add spec.md to the Target, or approve a Spec in `ahde` first",
	);
}

// ---------- deterministic example draw ----------

function exampleKey(datasetHash: string, seed: string, taskId: string): string {
	return createHash("sha256").update(`${datasetHash} sealed-synth ${seed} ${taskId}`).digest("hex");
}

/**
 * K development cases, drawn from (dataset hash, seed, case id) so the same
 * seed over the same development suite always shows the generator the same
 * examples — and a different seed asks a different question of the same Spec.
 */
function drawExamples(target: ResolvedTarget, count: number, seed: string): CorpusTask[] {
	const ordered = [...target.tasks].sort((left, right) => {
		const a = exampleKey(target.datasetHash, seed, left.id);
		const b = exampleKey(target.datasetHash, seed, right.id);
		return a === b ? left.id.localeCompare(right.id) : a < b ? -1 : 1;
	});
	const chosen = new Set(ordered.slice(0, count).map((task) => task.id));
	// Presented in dataset order: the draw decides which, never in what order.
	return target.tasks
		.filter((task) => chosen.has(task.id))
		.map((task) => CorpusTaskSchema.parse({
			id: task.id,
			input: task.input,
			...(task.expected !== undefined ? { expected: task.expected } : {}),
			...(task.messages ? { messages: task.messages } : {}),
			...(task.simulatedUser ? { simulatedUser: task.simulatedUser } : {}),
			// A worlded case is only a format example if the generator can see the
			// world it happens in; dropping it here would teach the exam a shape
			// the development suite does not have.
			...(task.world ? { world: task.world } : {}),
			// The case's OWN graders: `effectiveGraders` also carries the one
			// `world_state` grader each expectation is desugared into, and an
			// example that stated the same expectation twice would teach the
			// generator to write it twice.
			graders: task.graders ?? task.effectiveGraders,
		}));
}

/**
 * Distinct grader shapes across the whole development suite, canonicalized.
 *
 * `world_state` is left out on purpose: the generator writes an input, an
 * optional reference answer and graders, and has no way to write the world a
 * world check would read. Offering the shape would be offering a check that
 * can only ever report "case declares no world".
 */
function graderShapes(target: ResolvedTarget): string[] {
	const shapes = new Map<string, GraderSpec>();
	for (const task of target.tasks) {
		for (const grader of task.effectiveGraders) {
			if (grader.type === "world_state") continue;
			const key = canonicalJson(grader);
			if (!shapes.has(key)) shapes.set(key, grader);
		}
	}
	return [...shapes.keys()].sort().slice(0, MAX_GRADER_SHAPES);
}

// ---------- the prompt ----------

const GENERATOR_SYSTEM = [
	"You write held-out evaluation cases for an AI agent.",
	"",
	"The cases you write become a SEALED exam: no one improving the agent will",
	"ever read them, so they must stand on their own. You are given the agent's",
	"specification, a few existing cases as a FORMAT example only, and the grader",
	"shapes the suite uses.",
	"",
	"Rules:",
	"- Answer with one JSON object and nothing else: {\"cases\": [ ... ]}.",
	"- No prose, no explanation, no markdown fence, no commentary.",
	"- Each case is an object with \"input\" (the request a real user would send),",
	"  an optional \"expected\" (a reference answer, only when a grader compares",
	"  against one), and \"graders\": a non-empty array using ONLY the grader",
	"  shapes shown. Do not invent grader types.",
	"- Never emit an \"id\": the host assigns ids.",
	"- Every case must be NEW. Do not restate, paraphrase, translate, or lightly",
	"  edit an example. An example is a format sample, never a subject.",
	"- Spread the cases across the specification's jobs, inputs, and constraints,",
	"  including the awkward ones: ambiguity, missing information, out-of-scope",
	"  requests, and edge cases a careless agent would get wrong.",
	"- Write inputs in the same language and register as the examples.",
].join("\n");

function generatorUserPrompt(input: {
	specText: string;
	examples: readonly CorpusTask[];
	graderShapes: readonly string[];
	count: number;
}): string {
	const lines = [
		"# Specification",
		"",
		input.specText.trim(),
		"",
		"# Grader shapes used by this suite",
		"",
		...input.graderShapes.map((shape) => shape),
		"",
		"# Format examples (shape only — never a subject)",
		"",
	];
	for (const example of input.examples) {
		const { id: _id, ...shape } = example;
		lines.push(canonicalJson(shape));
	}
	if (input.examples.length === 0) lines.push("(none — follow the case shape described above)");
	lines.push(
		"",
		"# Task",
		"",
		`Write exactly ${input.count} new cases for this specification.`,
		"Return only {\"cases\": [ ... ]}.",
	);
	return lines.join("\n");
}

// ---------- the knowledge-base prompt ----------

/**
 * The knowledge-base generator sees ONE passage and nothing else.
 *
 * Showing it the whole corpus would let it write a question no single passage
 * answers, and the case's whole claim — this answer stands on THIS source — is
 * only checkable when exactly one passage is the source. The Spec is not shown
 * here at all: the questions come from the documents, and the Spec's job on
 * this path is to say which project revision the exam belongs to, which the
 * receipt records without the generator ever reading it.
 */
const KB_GENERATOR_SYSTEM = [
	"You write held-out evaluation questions from a company's own documentation.",
	"",
	"You are shown ONE passage. Write one question a real user would ask, whose",
	"complete answer is contained in that passage, and the answer itself.",
	"",
	"Rules:",
	"- Answer with one JSON object and nothing else: {\"question\": \"...\", \"answer\": \"...\"}.",
	"- No prose, no explanation, no markdown fence, no commentary.",
	"- The question must be answerable from the passage ALONE. Do not ask about",
	"  anything the passage does not state.",
	"- The question is what a user asks, not what a document says: no \"according to",
	"  the passage\", no reference to a document, a section, or an id.",
	"- The answer is short, factual, and uses the passage's own numbers, names and",
	"  terms exactly as written.",
	"- Write both in the language of the passage.",
].join("\n");

function kbGeneratorUserPrompt(chunk: KbChunk): string {
	return [
		`# Passage ${chunk.id}`,
		"",
		chunk.text.trim(),
		"",
		"# Task",
		"",
		"Write one question and its answer from this passage.",
		"Return only {\"question\": \"...\", \"answer\": \"...\"}.",
	].join("\n");
}

function chunkKey(datasetHash: string, seed: string, chunkId: string): string {
	return createHash("sha256").update(`${datasetHash} sealed-synth kb ${seed} ${chunkId}`).digest("hex");
}

/**
 * N passages, drawn from (dataset hash, seed, chunk id) by the same rule the
 * format-example draw uses: the same seed over the same knowledge base always
 * asks about the same passages, and a different seed asks about others. The
 * count is capped by the number of passages — a corpus of nine chunks cannot
 * produce twenty independent questions, and pretending otherwise would produce
 * twenty questions about nine passages.
 */
function drawChunks(chunks: readonly KbChunk[], datasetHash: string, count: number, seed: string): KbChunk[] {
	const ordered = [...chunks].sort((left, right) => {
		const a = chunkKey(datasetHash, seed, left.id);
		const b = chunkKey(datasetHash, seed, right.id);
		return a === b ? left.id.localeCompare(right.id) : a < b ? -1 : 1;
	});
	const chosen = new Set(ordered.slice(0, Math.min(count, chunks.length)).map((chunk) => chunk.id));
	// Presented in document order: the draw decides which, never in what order.
	return chunks.filter((chunk) => chosen.has(chunk.id));
}

/** The one question-and-answer a knowledge-base call is allowed to return. */
function parseGeneratedPair(text: string): { question: string; answer: string } | null {
	if (Buffer.byteLength(text, "utf8") > MAX_GENERATOR_RESPONSE_BYTES) return null;
	const stripped = text.replace(/```(?:json)?/g, "").trim();
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripped.slice(start, end + 1));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const { question, answer } = parsed as { question?: unknown; answer?: unknown };
	if (typeof question !== "string" || question.trim().length === 0) return null;
	if (typeof answer !== "string" || answer.trim().length === 0) return null;
	return { question, answer };
}

/**
 * The graders a knowledge-base case carries.
 *
 * Two deterministic checks, and no judge. `cites_source` asks the only question
 * that distinguishes retrieval from recall — did the answer stand on the
 * passage it was written from — and token F1 against the reference answer asks
 * whether it said the right thing. A judge grader here would ask the model that
 * wrote both the question and the reference answer to then mark the paper: the
 * second opinion is not independent, and it would put a per-case model call on
 * every sealed run for a verdict two free checks already decide.
 */
function kbCaseGraders(chunkId: string): GraderSpec[] {
	return [
		{ type: "cites_source", chunk: chunkId, minOverlap: 0.35 },
		{ type: "similarity", metric: "token-f1", threshold: 0.5 },
	];
}

// ---------- parsing the answer ----------

/**
 * Normalized form used for novelty. Case, width, and whitespace are typography;
 * two cases that differ only there are the same question asked twice.
 */
export function normalizedCaseInput(input: string): string {
	return input.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function derivedCaseId(specSha256: string, normalized: string): string {
	return `synth-${sha256Hex(`${specSha256} ${normalized}`).slice(0, 24)}`;
}

/**
 * Read the generator's answer without ever quoting it. Every failure message
 * here describes a shape, not a body: an exam that leaks through a stack trace
 * is not sealed.
 */
function parseGeneratedCases(text: string): unknown[] {
	if (Buffer.byteLength(text, "utf8") > MAX_GENERATOR_RESPONSE_BYTES) {
		throw new Error(`the generator returned more than ${MAX_GENERATOR_RESPONSE_BYTES} bytes`);
	}
	const stripped = text.replace(/```(?:json)?/g, "").trim();
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	const raw = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("the generator did not return a JSON object; nothing was sealed");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("the generator did not return a JSON object; nothing was sealed");
	}
	const cases = (parsed as { cases?: unknown }).cases;
	if (!Array.isArray(cases)) {
		throw new Error("the generator's JSON object carries no `cases` array; nothing was sealed");
	}
	return cases;
}

interface AdmittedCases {
	tasks: CorpusTask[];
	droppedMalformed: number;
	droppedDuplicate: number;
}

/**
 * Validate, deduplicate, and re-id. Ids are derived from the Spec hash and the
 * normalized input — never taken from the generator — for the same reason a
 * corpus import derives them: an id a model chose is an id a model controls.
 */
function admitCases(
	values: readonly unknown[],
	specSha256: string,
	seenNormalized: ReadonlySet<string>,
	limit: number,
): AdmittedCases {
	const tasks: CorpusTask[] = [];
	const seen = new Set(seenNormalized);
	let droppedMalformed = 0;
	let droppedDuplicate = 0;

	for (const value of values) {
		if (tasks.length >= limit) break;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			droppedMalformed += 1;
			continue;
		}
		const { id: _id, ...rest } = value as Record<string, unknown>;
		const input = (rest as { input?: unknown }).input;
		if (typeof input !== "string" || input.trim().length === 0) {
			droppedMalformed += 1;
			continue;
		}
		const normalized = normalizedCaseInput(input);
		if (seen.has(normalized)) {
			droppedDuplicate += 1;
			continue;
		}
		const candidate = CorpusTaskSchema.safeParse({ ...rest, id: derivedCaseId(specSha256, normalized) });
		if (!candidate.success || taskDialogueIssue(candidate.data) !== null) {
			droppedMalformed += 1;
			continue;
		}
		seen.add(normalized);
		tasks.push(candidate.data);
	}
	return { tasks, droppedMalformed, droppedDuplicate };
}

// ---------- the review file ----------

function assertReviewPathOutsideTarget(reviewPath: string, targetDir: string, stateRoot: string): string {
	const resolved = resolve(reviewPath);
	if (existsSync(resolved)) {
		throw new SealedSynthRefusal(
			`the review file already exists: ${resolved}`,
			"choose a path that does not exist yet, or move the existing file aside first",
		);
	}
	const parent = dirname(resolved);
	if (!existsSync(parent)) {
		throw new SealedSynthRefusal(
			`the review file's directory does not exist: ${parent}`,
			"create the directory first, or choose a path inside one that exists",
		);
	}
	const realParent = realpathSync(parent);
	const realTarget = realpathSync(targetDir);
	// The private state root is the one place inside a Target that is not part of
	// it: the sealed corpora themselves already live there, 0700, undeclared, and
	// out of every workspace snapshot. A draft beside them is no more exposed
	// than the exams it is going to become. Everywhere else inside the Target is
	// refused, because a Harness snapshot copies the Target.
	const realState = existsSync(stateRoot) ? realpathSync(stateRoot) : resolve(stateRoot);
	if (contained(realTarget, realParent) && !contained(realState, realParent)) {
		throw new SealedSynthRefusal(
			`the review file would land inside the Target tree: ${resolved}`,
			`choose a path outside ${realTarget} — a Harness snapshot would carry a sealed exam into every run`,
		);
	}
	return resolved;
}

/**
 * Where a draft exam lands when nobody named a path: the project's own private
 * state, beside the receipts, 0600 like everything else there. `discriminator`
 * is whatever the caller wants the file named after — it is hashed, so it never
 * appears in a filename, and the same discriminator always names the same file
 * so a dialog can price a path and then write to it.
 */
export function sealedSynthReviewPath(stateRoot: string, projectId: string, discriminator: string): string {
	const root = receiptsRoot(stateRoot, projectId, true);
	if (!root) throw new Error("failed to create the sealed synthesis state directory");
	return join(root, `review-${sha256Hex(`sealed-synth review ${discriminator}`).slice(0, 32)}.jsonl`);
}

function writeReviewFile(path: string, tasks: readonly CorpusTask[]): void {
	writeTextArtifact(path, `${tasks.map((task) => canonicalJson(task)).join("\n")}\n`, {
		mode: 0o600,
		immutable: true,
	});
	// The mode argument is masked by umask; a sealed draft is 0600 exactly.
	chmodSync(path, 0o600);
}

// ---------- the command ----------

/**
 * Generate a sealed exam with the Target's configured judge, and either seal it
 * immediately or hand it to a human to edit and seal. Returns hashes, ids, and
 * counts; the caller cannot print a case even by mistake.
 */
type JudgeModel = NonNullable<ResolvedTarget["manifest"]["evalSuite"]["judge"]>;

interface SealedSynthPreflight {
	target: ResolvedTarget;
	judge: JudgeModel;
	projectId: string;
	source: SealedSynthSource;
	count: number;
	drawn: CorpusTask[];
	/** One prompt per drawn passage, in draw order. Empty on the Spec source. */
	kbCalls: { chunk: KbChunk; user: string }[];
	kbIndexHash: string | null;
	spec: ResolvedSpec;
	specSha256: string;
	seed: string | null;
	system: string;
	/**
	 * The exact question, whole. On the knowledge-base source that is every
	 * per-passage prompt joined, because that is what will actually be sent —
	 * split across one call each — so the hash covers the whole request and the
	 * byte count prices it.
	 */
	user: string;
	promptSha256: string;
	promptBytes: number;
	reviewPath: string | null;
}

/**
 * Everything decided before a token is spent: the bounds, the two refusals, the
 * Spec, the example draw, and the exact question. Shared by `planSealedSynthesis`
 * and `synthesizeSealedCorpus` so a dialog prices exactly the run that follows
 * it, and so a refusal costs nothing whichever surface asked.
 */
function preflight(options: SealedSynthOptions): SealedSynthPreflight {
	const projectId = ProjectIdSchema.parse(options.projectId);
	const count = Math.trunc(options.count);
	if (!Number.isSafeInteger(count) || count < 1 || count > MAX_SEALED_SYNTH_CASES) {
		throw new Error(`--sealed must be between 1 and ${MAX_SEALED_SYNTH_CASES}`);
	}
	const examples = Math.trunc(options.examples ?? DEFAULT_SEALED_SYNTH_EXAMPLES);
	if (!Number.isSafeInteger(examples) || examples < 0 || examples > MAX_SEALED_SYNTH_EXAMPLES) {
		throw new Error(`--examples must be between 0 and ${MAX_SEALED_SYNTH_EXAMPLES}`);
	}
	const target = loadTarget(resolve(options.targetDir));
	const judge = target.manifest.evalSuite.judge;
	if (!judge) {
		throw new SealedSynthRefusal(
			"this Target has no judge configured, and the judge is the generator: " +
				"a sealed exam written by the Builder is an exam its author has read",
			"run `ahde` and configure the judge through the reviewed evaluator setup, then try again",
		);
	}
	if (sameModelAsTarget(target.manifest.model, judge)) {
		throw new SealedSynthRefusal(
			`the judge ${judge.provider}/${judge.id} is the Target's own model; ` +
				"a model writing its own exam is grading itself twice",
			"configure a different judge through `ahde`; evaluator setup refuses this pairing for the same reason",
		);
	}

	const reviewPath = options.reviewPath === undefined
		? null
		: assertReviewPathOutsideTarget(options.reviewPath, target.dir, options.stateRoot);

	const spec = resolveSpec(options, target);
	const specSha256 = hashValue(spec.text);
	const seed = options.seed ?? null;
	const source: SealedSynthSource = options.source ?? "spec";

	// Refused before a token is spent, and before the human is asked anything: a
	// Target with no declared knowledge base has no passages to write questions
	// from, and an exam about nothing is worse than no exam.
	let kbCalls: { chunk: KbChunk; user: string }[] = [];
	let kbIndexHash: string | null = null;
	if (source === "kb") {
		if (!knowledgeBaseDeclared(target.manifest.data)) {
			throw new SealedSynthRefusal(
				"this Target declares no knowledge base, so there are no documents to write questions from",
				`put the documents in ${join(target.dir, KB_DATA_DECLARATION)} and declare that directory in ` +
					"the manifest's data list, then try again",
			);
		}
		let chunks: KbChunk[];
		try {
			chunks = readKnowledgeBase(target.dir);
		} catch (error) {
			throw new SealedSynthRefusal(
				`the declared knowledge base cannot be indexed: ${error instanceof Error ? error.message : String(error)}`,
				"fix the documents under data/kb, then try again",
			);
		}
		if (chunks.length === 0) {
			throw new SealedSynthRefusal(
				`the declared knowledge base holds no readable .md or .txt document: ${join(target.dir, KB_DATA_DECLARATION)}`,
				"add the documents the agent answers from, then try again",
			);
		}
		kbIndexHash = kbIndexHashOf(chunks);
		kbCalls = drawChunks(chunks, target.datasetHash, count, seed ?? "")
			.map((chunk) => ({ chunk, user: kbGeneratorUserPrompt(chunk) }));
	}

	const drawn = source === "kb" ? [] : drawExamples(target, examples, seed ?? "");
	const system = source === "kb" ? KB_GENERATOR_SYSTEM : GENERATOR_SYSTEM;
	const user = source === "kb"
		? kbCalls.map((call) => call.user).join("\n\n")
		: generatorUserPrompt({
			specText: spec.text,
			examples: drawn,
			graderShapes: graderShapes(target),
			count,
		});
	return {
		target,
		judge,
		projectId,
		source,
		// A corpus of nine passages cannot answer twenty independent questions, so
		// the request is capped at the draw and the dialog prices what will
		// actually be written rather than what was asked for.
		count: source === "kb" ? kbCalls.length : count,
		drawn,
		kbCalls,
		kbIndexHash,
		spec,
		specSha256,
		seed,
		system,
		user,
		promptSha256: hashValue({ system, user }),
		// One system prompt per call on the knowledge-base path, so the estimate
		// counts it once per passage rather than once per generation.
		promptBytes: Buffer.byteLength(system, "utf8") * Math.max(kbCalls.length, 1) +
			Buffer.byteLength(user, "utf8"),
		reviewPath,
	};
}

/**
 * A tokenizer would be exact and is not worth a dependency here: four bytes to
 * the token is the usual English-and-Russian average, and the number is shown
 * with a `~`. Output is the part that actually scales — one case is a request,
 * an optional reference answer, and its graders.
 */
const ESTIMATE_BYTES_PER_TOKEN = 4;
const ESTIMATE_OUTPUT_TOKENS_PER_CASE = 200;

/** What one generation should cost, from the judge's own declared rates. */
export function estimateSealedSynthCostUsd(judge: JudgeModel, promptBytes: number, cases: number): number {
	const promptTokens = Math.ceil(promptBytes / ESTIMATE_BYTES_PER_TOKEN);
	const completionTokens = cases * ESTIMATE_OUTPUT_TOKENS_PER_CASE;
	return evaluatorCostUsd(judge.spec.cost, {
		promptTokens,
		completionTokens,
		totalTokens: promptTokens + completionTokens,
	});
}

/**
 * What a generation would be, without doing it: the generator, the Spec it
 * reads, how many format examples it sees, the question's hash, and the price.
 * The two refusals happen here, so a misconfigured Target is told before a
 * human is asked anything.
 */
export function planSealedSynthesis(options: SealedSynthOptions): SealedSynthPlan {
	const ready = preflight(options);
	return {
		source: ready.source,
		kbIndexHash: ready.kbIndexHash,
		kbChunkIds: ready.kbCalls.map((call) => call.chunk.id),
		generatorModel: `${ready.judge.provider}/${ready.judge.id}`,
		generatorHash: hashValue(modelFingerprint(ready.judge)),
		promptSha256: ready.promptSha256,
		promptBytes: ready.promptBytes,
		specSource: ready.spec.source,
		specId: ready.spec.specId,
		specSha256: ready.specSha256,
		examples: ready.drawn.length,
		developmentExampleIds: ready.drawn.map((task) => task.id),
		requested: ready.count,
		seed: ready.seed,
		reviewPath: ready.reviewPath,
		estimatedCostUsd: estimateSealedSynthCostUsd(ready.judge, ready.promptBytes, ready.count),
	};
}

export async function synthesizeSealedCorpus(options: SealedSynthOptions): Promise<SealedSynthResult> {
	const {
		target,
		judge,
		projectId,
		source,
		count,
		drawn,
		kbCalls,
		kbIndexHash,
		spec,
		specSha256,
		seed,
		system,
		user,
		promptSha256,
		reviewPath,
	} = preflight(options);

	// The exact exchange lands on disk before anything is parsed, exactly as
	// every other evaluator call does — but under a private directory this
	// command removes as soon as the cases have a home. A generated exam is
	// holdout content the moment it is admitted, and a second copy of it beside
	// the receipt is one more thing that could be projected by mistake. A run
	// that produced nothing leaves its exchange behind, because then there is no
	// holdout to protect and a failure with no evidence is unfixable.
	const receiptsDir = receiptsRoot(options.stateRoot, projectId, true);
	if (!receiptsDir) throw new Error("failed to create the sealed synthesis state directory");
	const exchangeDir = join(receiptsDir, EXCHANGE_DIRECTORY, promptSha256.slice("sha256:".length, "sha256:".length + 16));

	// One call per passage on the knowledge-base path, in draw order. Each answer
	// becomes exactly one candidate case, with the passage it was written from
	// nailed to it by a grader — so a malformed answer costs one question, not
	// the whole exam.
	const generated: unknown[] = [];
	let unparsedPairs = 0;
	if (source === "kb") {
		for (const [index, call] of kbCalls.entries()) {
			const answered = await callEvaluatorModel({
				label: "sealed synthesis",
				model: judge,
				system,
				user: call.user,
				sidecar: { dir: exchangeDir, stem: `generation-${index}` },
				pinTemperature: true,
				abortMessage: "sealed synthesis aborted",
				...(options.signal ? { signal: options.signal } : {}),
			});
			const pair = parseGeneratedPair(answered.text);
			if (!pair) {
				unparsedPairs += 1;
				continue;
			}
			generated.push({
				input: pair.question,
				expected: pair.answer,
				metadata: { kbChunk: call.chunk.id },
				graders: kbCaseGraders(call.chunk.id),
			});
		}
	} else {
		const called = await callEvaluatorModel({
			label: "sealed synthesis",
			model: judge,
			system,
			user,
			sidecar: { dir: exchangeDir, stem: "generation" },
			pinTemperature: true,
			abortMessage: "sealed synthesis aborted",
			...(options.signal ? { signal: options.signal } : {}),
		});
		generated.push(...parseGeneratedCases(called.text));
	}

	const seenNormalized = new Set(target.tasks.map((task) => normalizedCaseInput(task.input)));
	const admittedCases_ = admitCases(generated, specSha256, seenNormalized, count);
	// A passage whose answer did not parse is a case that never existed, counted
	// with the ones validation threw out so the shortfall arithmetic stays true.
	const admitted = {
		...admittedCases_,
		droppedMalformed: admittedCases_.droppedMalformed + unparsedPairs,
	};
	if (admitted.tasks.length === 0) {
		throw new Error(
			`the generator produced no admissible new case (${admitted.droppedMalformed} malformed, ` +
				`${admitted.droppedDuplicate} already in the development suite); nothing was sealed`,
		);
	}

	const now = options.now ?? (() => new Date().toISOString());
	let corpus: CorpusMetadata | null = null;
	let outcome: SealedSynthReceipt["outcome"];
	if (reviewPath) {
		writeReviewFile(reviewPath, admitted.tasks);
		outcome = { kind: "review", reviewPath, caseCount: admitted.tasks.length };
	} else {
		corpus = createCorpus({
			stateRoot: options.stateRoot,
			projectId,
			name: options.name,
			visibility: "sealed",
			tasks: admitted.tasks,
		});
		outcome = { kind: "sealed", corpusId: corpus.id, corpusHash: corpus.hash, taskCount: corpus.taskCount };
	}
	// The cases have a home; the raw exchange is now only a duplicate of them.
	rmSync(exchangeDir, { recursive: true, force: true });
	try {
		rmdirSync(join(receiptsDir, EXCHANGE_DIRECTORY));
	} catch {
		// A concurrent generation still holds its own exchange, or there never was
		// a directory. Either way the receipts directory holds only receipts.
	}

	const receipt = SealedSynthReceiptSchema.parse({
		schemaVersion: 2,
		source,
		kbIndexHash,
		projectId,
		targetId: target.manifest.id,
		corpusName: options.name,
		generator: modelFingerprint(judge),
		generatorHash: hashValue(modelFingerprint(judge)),
		promptSha256,
		specSha256,
		specSource: spec.source,
		specId: spec.specId,
		developmentExampleIds: drawn.map((task) => task.id),
		requested: count,
		seed,
		accepted: admitted.tasks.length,
		droppedMalformed: admitted.droppedMalformed,
		droppedDuplicate: admitted.droppedDuplicate,
		outcome,
		at: now(),
	});
	const receiptPath = join(receiptsDir, `${receiptSha(receipt)}.json`);
	if (!existsSync(receiptPath)) {
		writeJsonArtifact(receiptPath, SealedSynthReceiptSchema, receipt, { immutable: true });
	}

	return {
		receipt,
		receiptPath,
		source,
		corpus,
		reviewPath,
		generatorModel: `${judge.provider}/${judge.id}`,
		promptSha256,
		requested: count,
		accepted: admitted.tasks.length,
		droppedMalformed: admitted.droppedMalformed,
		droppedDuplicate: admitted.droppedDuplicate,
	};
}

/** Every sealed synthesis this project has recorded, newest first. */
export function listSealedSynthReceipts(stateRoot: string, projectIdInput: string): SealedSynthReceipt[] {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const root = receiptsRoot(stateRoot, projectId, false);
	if (!root) return [];
	const receipts: SealedSynthReceipt[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) continue;
		const receipt = readJsonArtifact(join(root, entry.name), SealedSynthReceiptSchema);
		if (receiptSha(receipt) !== ReceiptShaSchema.parse(entry.name.slice(0, 64))) {
			throw new Error(`the sealed synthesis receipt ${entry.name} does not match its content address`);
		}
		receipts.push(receipt);
	}
	return receipts.sort((left, right) => right.at.localeCompare(left.at));
}

/**
 * Close the loop on the review path. When a sealed import names a file this
 * project generated as a draft, record that the exam now sealed is the one a
 * human read and edited — the difference between "the judge wrote it and nobody
 * looked" and "the judge wrote it and the operator vouched for it", which is
 * the whole point of offering the draft. Returns `null` for any other file: an
 * exam the operator brought is theirs, and this module has nothing to say
 * about where it came from.
 */
export function recordSealedSynthReviewImport(options: {
	stateRoot: string;
	projectId: string;
	sourcePath: string;
	corpus: Pick<CorpusMetadata, "id" | "hash" | "taskCount">;
	now?: () => string;
}): SealedSynthReceipt | null {
	const resolved = resolve(options.sourcePath);
	const drafted = listSealedSynthReceipts(options.stateRoot, options.projectId)
		.find((receipt) => receipt.outcome.kind === "review" && receipt.outcome.reviewPath === resolved);
	if (!drafted) return null;
	const now = options.now ?? (() => new Date().toISOString());
	const receipt = SealedSynthReceiptSchema.parse({
		...drafted,
		outcome: {
			kind: "review-imported",
			reviewPath: resolved,
			corpusId: options.corpus.id,
			corpusHash: options.corpus.hash,
			taskCount: options.corpus.taskCount,
		},
		at: now(),
	});
	const root = receiptsRoot(options.stateRoot, options.projectId, true);
	if (!root) throw new Error("failed to create the sealed synthesis state directory");
	const path = join(root, `${receiptSha(receipt)}.json`);
	if (!existsSync(path)) writeJsonArtifact(path, SealedSynthReceiptSchema, receipt, { immutable: true });
	return receipt;
}

/**
 * How this sealed corpus came to exist, for a surface that already knows its
 * id. The answer is a provenance word and nothing else — no case, no count of
 * anything but what the caller already had, no path.
 */
export function sealedExamOrigin(
	stateRoot: string,
	projectId: string,
	corpusId: string | null,
): SealedExamOrigin | null {
	if (!corpusId) return null;
	let receipts: SealedSynthReceipt[];
	try {
		receipts = listSealedSynthReceipts(stateRoot, projectId);
	} catch {
		// Unreadable provenance narrows the line; it never fails the page.
		return null;
	}
	// A reviewed exam was also generated, so the more specific answer wins.
	for (const receipt of receipts) {
		if (receipt.outcome.kind === "review-imported" && receipt.outcome.corpusId === corpusId) {
			return sealedSynthSource(receipt) === "kb" ? "judge-generated-kb-reviewed" : "judge-generated-reviewed";
		}
	}
	for (const receipt of receipts) {
		if (receipt.outcome.kind === "sealed" && receipt.outcome.corpusId === corpusId) {
			return sealedSynthSource(receipt) === "kb" ? "judge-generated-kb" : "judge-generated";
		}
	}
	return null;
}

// ---------- rendering ----------

export interface SealedSynthOutput {
	/** Exactly what the command prints. Never a case, never a fragment of one. */
	stdout: string[];
	/** Counts and guardrails, on stderr, in the shape `ahde corpus ingest` uses. */
	warnings: string[];
}

/**
 * The command's whole visible surface, as a pure function of the result, so a
 * test can assert what an operator sees without spawning a process — and so
 * there is exactly one place where a case could ever be printed, and it is not
 * this one.
 */
export function renderSealedSynthOutput(result: SealedSynthResult): SealedSynthOutput {
	const stdout = result.corpus
		? [
			`corpus        ${result.corpus.id}`,
			`cases         ${result.corpus.taskCount}`,
			`source        ${result.source}`,
			`generator     ${result.generatorModel}`,
			`prompt        ${result.promptSha256}`,
		]
		: [
			`review        ${result.reviewPath ?? ""}`,
			`cases         ${result.accepted}`,
			`source        ${result.source}`,
			`generator     ${result.generatorModel}`,
			`prompt        ${result.promptSha256}`,
			"",
			"next: read and edit that file, then seal it:",
			`  ahde corpus import --project ${result.receipt.projectId} --visibility sealed ` +
				`--name ${JSON.stringify(result.receipt.corpusName)} --file ${result.reviewPath ?? ""}`,
		];

	const warnings: string[] = [`receipt ${result.receiptPath}`];
	if (result.droppedMalformed > 0) {
		warnings.push(`warning: ${result.droppedMalformed} generated case(s) did not match the case schema and were dropped`);
	}
	if (result.droppedDuplicate > 0) {
		warnings.push(
			`warning: ${result.droppedDuplicate} generated case(s) repeated a development input and were dropped`,
		);
	}
	if (result.accepted < result.requested) {
		warnings.push(`warning: asked for ${result.requested} case(s), kept ${result.accepted}`);
	}
	if (result.accepted < SEALED_GATE_POLICY.minTasks) {
		warnings.push(
			`warning: a sealed holdout of ${result.accepted} case(s) can never produce a sealed verdict; ` +
				`the guardrail needs at least ${SEALED_GATE_POLICY.minTasks} cases and ` +
				`${SEALED_GATE_POLICY.minRepetitions} repetitions, and stays underpowered below that`,
		);
	}
	return { stdout, warnings };
}
