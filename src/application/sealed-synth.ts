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
	existsSync,
	lstatSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	rmdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
	createCorpus,
	CorpusTaskSchema,
	type CorpusMetadata,
	type CorpusTask,
} from "../corpus.js";
import { SEALED_GATE_POLICY } from "../domain/comparison-gate.js";
import { CASE_DIFFICULTIES, coverageDensity } from "../domain/case-coverage.js";
import {
	finerGeometry,
	KB_GEOMETRY,
	kbIndexHash as kbIndexHashOf,
	kbPassages,
	type KbChunk,
	type KbGeometry,
	type KbPassage,
} from "../domain/kb.js";
import { knowledgeBaseDeclared, readKnowledgeBase, KB_DATA_DECLARATION } from "../target/kb-tool.js";
import { callEvaluatorModel, evaluatorCostUsd } from "../evaluator-model.js";
import {
	CaseCoverageSchema,
	CaseDifficultySchema,
	GraderSpec,
	loadTarget,
	taskDialogueIssue,
	type CaseCoverage,
	type CaseDifficulty,
	type ResolvedTarget,
	isDeterministicGrader,
} from "../manifest.js";
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
import { plural, t } from "../i18n.js";
import {
	CRITIC_SYSTEM,
	critiqueCases,
	specTextOf,
	type CriticCase,
	type CriticFinding,
	CRITIC_BATCH_SIZE,
} from "./case-critic.js";
import { sameModelAsTarget } from "./configure-evaluators.js";
import { contained, projectStateDir } from "../storage/paths.js";

/** A generated exam stays something a human could still read in one sitting. */
export const MAX_SEALED_SYNTH_CASES = 200;
/** Format examples. More than a handful teaches imitation, not format. */
export const MAX_SEALED_SYNTH_EXAMPLES = 20;
/**
 * None, by default.
 *
 * A held-out exam exists to ask something the development suite did not, and
 * every example shown is a case a Builder wrote pulling the generator back
 * towards it. The option stays — a suite with an unusual case shape can still
 * show a handful — but the default is an exam nothing in the loop shaped.
 */
const DEFAULT_SEALED_SYNTH_EXAMPLES = 0;
/**
 * How many questions one passage may be asked for.
 *
 * A passage states a few facts; the fourth question about it is the first one
 * rephrased. Three is the point where the exam is still about the documents
 * rather than about the generator's patience.
 */
const MAX_KB_QUESTIONS_PER_PASSAGE = 3;
const MAX_SPEC_BYTES = 64 * 1024;
const MAX_GENERATOR_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_GRADER_SHAPES = 16;
const RECEIPT_DIRECTORY = "sealed-synth";
const EXCHANGE_DIRECTORY = "exchanges";
/**
 * Jobs the exam is spread over. A Spec with more jobs than this is a Spec whose
 * cells nobody could fill in one exam anyway, and the prompt stays readable.
 */
const MAX_COVERAGE_JOBS = 24;
/**
 * Cases per critic call. Fixed here rather than inherited so the plan's
 * arithmetic — one call per eight accepted cases — is the arithmetic the run
 * actually pays for.
 */
/** One question of every third passage asks about something it does not state. */
const KB_NO_ANSWER_EVERY = 3;


/**
 * Why a generated case did not reach the sealed exam, as a closed vocabulary.
 *
 * The critic answers in prose, and its prose may quote the case it is talking
 * about. A receipt that carried it would be a second copy of the exam in the
 * one file every screen is allowed to read, so what survives is a category:
 * derived from the verdict and a keyword rule, and never the text itself.
 */
export const SEALED_SYNTH_DROP_CATEGORIES = [
	"unanswerable",
	"ambiguous-criteria",
	"contradiction",
	"wrong-check",
	"duplicate",
	"out-of-actions",
	"judge-only",
	"unreviewed",
	"other",
] as const;
const DropCategorySchema = z.enum(SEALED_SYNTH_DROP_CATEGORIES);
export type SealedSynthDropCategory = z.infer<typeof DropCategorySchema>;
export type SealedSynthDropCounts = Record<SealedSynthDropCategory, number>;

function emptyDropCounts(): SealedSynthDropCounts {
	return Object.fromEntries(SEALED_SYNTH_DROP_CATEGORIES.map((category) => [category, 0])) as SealedSynthDropCounts;
}

/**
 * The category behind one finding, by the first rule that matches.
 *
 * Order is the whole design: a reason that names both a duplicate and a wrong
 * check is reported as a duplicate, because that is the fact that decides what
 * to do about it. Both languages the dictionary speaks are matched — the judge
 * answers in the language of the Spec it read.
 */
const DROP_CATEGORY_RULES: readonly { category: SealedSynthDropCategory; pattern: RegExp }[] = [
	{ category: "duplicate", pattern: /duplicat|near-duplicate|same question|already asked|reworded|дублик|повтор/u },
	{ category: "contradiction", pattern: /contradict|conflict|inconsistent|disagree|противореч|не согласуется/u },
	{ category: "out-of-actions", pattern: /out of scope|outside .{0,40}allowed|not allowed|allowed actions|no declared tool|tool does not exist|вне (области|допустимых)|не разрешено/u },
	{ category: "ambiguous-criteria", pattern: /ambigu|two reasonable|more than one correct|unclear criteri|underspecified criteri|неоднознач|неясн/u },
	{ category: "unanswerable", pattern: /cannot be (solved|answered)|not answerable|unanswerable|no answer|does not (state|hold|contain|say)|source does not|passage does not|не содержит|нет ответа|не сказано/u },
	{ category: "wrong-check", pattern: /grader|check|output_contains|output_excludes|output_matches|tool_called|world_state|expected|reference answer|грейдер|проверк|эталон/u },
];

function dropCategory(finding: CriticFinding): SealedSynthDropCategory {
	if (finding.verdict === "unreviewed") return "unreviewed";
	const reasons = finding.reasons.join(" ").toLowerCase();
	for (const rule of DROP_CATEGORY_RULES) {
		if (rule.pattern.test(reasons)) return rule.category;
	}
	return "other";
}

/** `wrong-check 2, unanswerable 1` — the only thing a warning may say about why. */
function dropReasonList(counts: SealedSynthDropCounts): string {
	return SEALED_SYNTH_DROP_CATEGORIES
		.filter((category) => counts[category] > 0)
		.map((category) => `${category} ${counts[category]}`)
		.join(", ");
}

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
const SealedSynthReceiptV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	...SealedSynthReceiptFields,
});

/**
 * Version 2 adds the two facts a knowledge-base exam has and a Spec exam does
 * not: which source the questions were written from, and the identity of the
 * chunk index they were written from. `kbIndexHash` is null on the `spec`
 * source — an absent knowledge base is a fact, not a hash of nothing.
 */
const SealedSynthReceiptV2Schema = z.strictObject({
	schemaVersion: z.literal(2),
	...SealedSynthReceiptFields,
	source: z.enum(["spec", "kb"]),
	kbIndexHash: HashSchema.nullable(),
});

/**
 * Version 3 adds the one fact a small knowledge base makes necessary: the
 * chunk length the generator actually read the base at. The runtime index is
 * always cut at {@link KB_GEOMETRY} — invariant 17 folds that geometry into
 * the prepared-home hash — but a base too small to fill an exam is re-cut
 * finer *for the generator only*, and without this number `kbIndexHash` would
 * describe an index the questions were not written from.
 */
const SealedSynthReceiptV3Schema = z.strictObject({
	schemaVersion: z.literal(3),
	...SealedSynthReceiptFields,
	source: z.enum(["spec", "kb"]),
	kbIndexHash: HashSchema.nullable(),
	/** Characters per generator passage; null on the Spec source. */
	kbChunkChars: z.number().int().positive().nullable(),
});

/** One cell of the basket, and how many cases it holds. A count, never a case. */
const CoverageCellSchema = z.strictObject({
	job: z.string().min(1).max(200),
	difficulty: CaseDifficultySchema,
	cases: z.number().int().positive(),
});
export type SealedSynthCoverageCell = z.infer<typeof CoverageCellSchema>;

/**
 * What the exam was asked to cover and what it covers.
 *
 * `plan` is the cell-by-cell request the prompt carried; `achieved` is
 * {@link coverageDensity} over the cases that survived, as counts. Job names
 * come from the Spec — a document the Builder has already read — and every
 * label the generator wrote was checked against that list before it was kept,
 * so nothing here is text a model chose.
 */
const SealedSynthCoverageSchema = z.strictObject({
	jobs: z.array(z.string().min(1).max(200)).max(MAX_COVERAGE_JOBS),
	plan: z.array(CoverageCellSchema).max(MAX_SEALED_SYNTH_CASES),
	achieved: z.array(CoverageCellSchema).max(MAX_SEALED_SYNTH_CASES),
	/** Accepted cases carrying no cell label at all. */
	unlabelled: z.number().int().nonnegative(),
	/** Labels the host refused — an unknown job or difficulty. The case stayed. */
	droppedLabel: z.number().int().nonnegative(),
});
export type SealedSynthCoverage = z.infer<typeof SealedSynthCoverageSchema>;

/** What the critic read, what it cost, and — in categories — what it cost the exam. */
const SealedSynthCriticSchema = z.strictObject({
	reviewed: z.number().int().nonnegative(),
	dropped: z.number().int().nonnegative(),
	byCategory: z.record(DropCategorySchema, z.number().int().nonnegative()),
	spend: z.strictObject({
		calls: z.number().int().nonnegative(),
		tokens: z.number().int().nonnegative(),
		costUsd: z.number().nonnegative(),
	}),
});
export type SealedSynthCritic = z.infer<typeof SealedSynthCriticSchema>;

/**
 * Version 4 adds the two facts that make a generated exam readable as a basket
 * rather than a pile: which cells it was asked to fill and which it fills, and
 * what the critic did to it before it was sealed. `critic` is optional because
 * a review draft nobody sealed may carry no verdicts, and because a critic that
 * could not be asked is a fact of its own, recorded as `unreviewed` findings
 * rather than as a missing block.
 */
const SealedSynthReceiptV4Schema = z.strictObject({
	schemaVersion: z.literal(4),
	...SealedSynthReceiptFields,
	source: z.enum(["spec", "kb"]),
	kbIndexHash: HashSchema.nullable(),
	kbChunkChars: z.number().int().positive().nullable(),
	coverage: SealedSynthCoverageSchema,
	critic: SealedSynthCriticSchema.optional(),
});

const SealedSynthReceiptSchema = z.discriminatedUnion("schemaVersion", [
	SealedSynthReceiptV1Schema,
	SealedSynthReceiptV2Schema,
	SealedSynthReceiptV3Schema,
	SealedSynthReceiptV4Schema,
]);
export type SealedSynthReceipt = z.infer<typeof SealedSynthReceiptSchema>;

/** Where one receipt's questions came from, in any schema version. */
export function sealedSynthSource(receipt: SealedSynthReceipt): "spec" | "kb" {
	return receipt.schemaVersion === 1 ? "spec" : receipt.source;
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
	/**
	 * Characters per generator passage, or null on the Spec source. The runtime
	 * index never moves; this is how finely the exam generator reads it, and it
	 * belongs in the approved subject because it decides what the questions are
	 * written from.
	 */
	kbChunkChars: number | null;
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
	/**
	 * The cells the generator will be asked to fill, in prompt order. Empty on
	 * the knowledge-base source, where the passages decide what is asked.
	 *
	 * Optional only so a host that stubs this plan need not restate it; every
	 * real plan carries it.
	 */
	coverageCells: SealedSynthCoverageCell[];
	/** The Spec's jobs the cells were built from, verbatim. */
	coverageJobs: string[];
	/** Judge calls the critic adds: one per {@link CRITIC_BATCH_SIZE} cases. */
	criticCalls: number;
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
	/**
	 * The private directory holding the raw generator exchange, when it could not
	 * be removed after the cases were sealed. A path, never a case — and a fact
	 * the operator has to be told, because it is a second copy of the exam.
	 */
	exchangeRetained: string | null;
	/** `<provider>/<id>` of the judge that wrote the exam. */
	generatorModel: string;
	promptSha256: string;
	requested: number;
	accepted: number;
	droppedMalformed: number;
	droppedDuplicate: number;
	/** Which cells were asked for and which the exam fills. Counts only. */
	coverage: SealedSynthCoverage;
	/** What the critic read and what it removed, in categories. Null when it was never asked. */
	critic: SealedSynthCritic | null;
	/**
	 * Where the critic's verdicts landed beside a draft, when it flagged
	 * anything. A path: the file names cases by id and says nothing else.
	 */
	criticAnnotationsPath: string | null;
}

// ---------- state layout ----------

function receiptsRoot(stateRoot: string, projectIdInput: string, create: boolean): string | null {
	return projectStateDir(stateRoot, projectIdInput, RECEIPT_DIRECTORY, { create, label: "sealed synthesis" });
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
	/** The Spec's jobs, verbatim: the rows of the coverage matrix. */
	jobs: string[];
	/**
	 * The approved snapshot behind the text, when there is one. The critic reads
	 * a Spec written its own way, and only this path can give it one.
	 */
	approved: AgentSpec | null;
}

/**
 * The jobs a hand-written Spec lists.
 *
 * `renderApprovedSpec` writes `## Jobs` with one dash-item per job, and a Spec a
 * human wrote by hand follows the same shape — it is the shape the Builder asks
 * for. Anything else answers no jobs, and an exam with no jobs is simply asked
 * for no cell labels rather than asked for invented ones.
 */
function jobsFromMarkdown(text: string): string[] {
	const heading = /^#{1,6}\s+(.+?)\s*$/u;
	const jobsHeading = /^(jobs|задачи)$/iu;
	const item = /^\s*[-*]\s+(.*\S)\s*$/u;
	const jobs: string[] = [];
	let inside = false;
	for (const line of text.split(/\r?\n/u)) {
		const title = heading.exec(line);
		if (title?.[1] !== undefined) {
			inside = jobsHeading.test(title[1].trim());
			continue;
		}
		if (!inside) continue;
		const listed = item.exec(line);
		if (listed?.[1] !== undefined) jobs.push(listed[1].trim());
	}
	return jobs;
}

/** Jobs a case could actually be labelled with: unique, in Spec order, and a valid label. */
function usableJobs(jobs: readonly string[]): string[] {
	const seen = new Set<string>();
	const usable: string[] = [];
	for (const job of jobs) {
		const label = job.trim();
		// A job too long to be a `coverage.job` could never come back as a label,
		// so offering it as a cell would only ever produce refused labels.
		if (!CaseCoverageSchema.shape.job.safeParse(label).success || seen.has(label)) continue;
		seen.add(label);
		usable.push(label);
		if (usable.length >= MAX_COVERAGE_JOBS) break;
	}
	return usable;
}

function resolveSpec(options: SealedSynthOptions, target: ResolvedTarget): ResolvedSpec {
	if (options.specPath !== undefined) {
		const text = readSpecFile(options.specPath, "the --from Spec file");
		return { text, source: "from-file", specId: null, jobs: usableJobs(jobsFromMarkdown(text)), approved: null };
	}
	const inTarget = join(target.dir, "spec.md");
	if (existsSync(inTarget)) {
		const text = readSpecFile(inTarget, "the Target's spec.md");
		return { text, source: "target-spec-md", specId: null, jobs: usableJobs(jobsFromMarkdown(text)), approved: null };
	}
	const approved = listSpecSnapshots(options.stateRoot, options.projectId)
		.filter((snapshot) => snapshot.status === "approved");
	const newest = approved[0];
	if (newest) {
		const spec = AgentSpecSchema.parse(newest.spec);
		return {
			text: renderApprovedSpec(spec),
			source: "approved-spec",
			specId: newest.id,
			jobs: usableJobs(spec.jobs),
			approved: spec,
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
	const listed = [...shapes.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(0, MAX_GRADER_SHAPES);
	// The two shapes a trap is written with, whenever the development suite does
	// not already show them. "Only the shapes shown" is a hard rule in the
	// prompt, so a generator asked for a policy-trap with no `output_excludes`
	// on the list has been asked for two contradictory things.
	const shownTypes = new Set(listed.map(([, grader]) => grader.type));
	const trapShapes = (["output_contains", "output_excludes"] as const)
		.filter((type) => !shownTypes.has(type))
		.map((type) => canonicalJson(GraderSpec.parse({ type, text: "…" })));
	return [...listed.map(([shape]) => shape), ...trapShapes];
}

// ---------- the coverage matrix ----------

function greatestCommonDivisor(left: number, right: number): number {
	return right === 0 ? left : greatestCommonDivisor(right, left % right);
}

/**
 * The cells of the matrix, in the order the exam should fill them.
 *
 * Cell k is job `k mod jobs` and difficulty `k mod 6` — the diagonal, which
 * is what makes the first few cases already touch every job and every
 * difficulty rather than six variations of the first job. The diagonal alone
 * repeats after `lcm(jobs, 6)` steps and would never reach the other cells when
 * the two numbers share a factor, so each further lap shifts the difficulty by
 * one. Over the whole run that visits every cell exactly once: within a lap the
 * pairs are those whose indices agree modulo `gcd`, and the shift walks the
 * `gcd` classes.
 */
function coverageCells(jobs: readonly string[]): { job: string; difficulty: CaseDifficulty }[] {
	if (jobs.length === 0) return [];
	const laps = greatestCommonDivisor(jobs.length, CASE_DIFFICULTIES.length);
	const lap = (jobs.length * CASE_DIFFICULTIES.length) / laps;
	return Array.from({ length: jobs.length * CASE_DIFFICULTIES.length }, (_unused, index) => ({
		job: jobs[index % jobs.length]!,
		difficulty: CASE_DIFFICULTIES[(index + Math.floor(index / lap)) % CASE_DIFFICULTIES.length]!,
	}));
}

/**
 * How the N cases are asked to spread over the matrix: every cell once before
 * any cell twice, so "every job and every difficulty at least once when N
 * allows, the rest evenly" is arithmetic rather than a hope about the model.
 */
export function sealedSynthCoveragePlan(jobs: readonly string[], count: number): SealedSynthCoverageCell[] {
	const cells = coverageCells(jobs);
	if (cells.length === 0) return [];
	const planned: SealedSynthCoverageCell[] = cells.map((cell) => ({ ...cell, cases: 0 }));
	for (let index = 0; index < count; index += 1) planned[index % planned.length]!.cases += 1;
	return planned.filter((cell) => cell.cases > 0);
}

/** The density as cells with counts, in job order then difficulty order. */
function achievedCells(tasks: readonly CorpusTask[], jobs: readonly string[]): SealedSynthCoverageCell[] {
	const density = coverageDensity(tasks, jobs);
	const cells: SealedSynthCoverageCell[] = [];
	for (const row of density.jobs) {
		for (const difficulty of CASE_DIFFICULTIES) {
			const cases = row.byDifficulty[difficulty];
			if (cases > 0) cells.push({ job: row.job, difficulty, cases });
		}
	}
	return cells;
}

// ---------- the prompt ----------

const GENERATOR_SYSTEM = [
	"You write held-out evaluation cases for an AI agent.",
	"",
	"The cases you write become a SEALED exam: no one improving the agent will",
	"ever read them, so they must stand on their own. You are given the agent's",
	"specification, the cells of the coverage matrix to fill, a few existing cases",
	"as a FORMAT example only, and the grader shapes the suite uses.",
	"",
	"Decide the outcome and the checks BEFORE you write the request. For each case",
	"settle first what a correct answer must contain, what it must not contain, and",
	"what the agent has to do; then write the request those checks belong to. A",
	"request written first and checked afterwards measures whatever the answer",
	"happened to say.",
	"",
	"Rules:",
	"- Answer with one JSON object and nothing else: {\"cases\": [ ... ]}.",
	"- No prose, no explanation, no markdown fence, no commentary.",
	"- Each case is an object whose keys come in this order:",
	"  {\"coverage\": {\"job\": \"<one job, verbatim>\", \"difficulty\": \"<one difficulty>\"},",
	"   \"checks\": {\"graders\": [...], \"expected\": \"<reference answer>\", \"world\": {...}},",
	"   \"input\": \"<the request a real user would send>\"}",
	"  Write \"expected\" only when a grader compares against a reference answer, and",
	"  \"world\" only when the format examples show a case that happens in a state.",
	"- \"graders\" is a non-empty array using ONLY the grader shapes shown, and at",
	"  least one of them must be a deterministic check: output_contains,",
	"  output_excludes, output_matches, tool_called, exact or turn_budget. A case",
	"  only a model can mark is not a measurement, and it is dropped.",
	"- Never emit an \"id\": the host assigns ids.",
	"- Every case must be NEW. Do not restate, paraphrase, translate, or lightly",
	"  edit an example. An example is a format sample, never a subject.",
	"- Label every case with the cell it fills and fill the cells you are asked for:",
	"  the job exactly as it is listed, the difficulty one of direct, clarify, tool,",
	"  policy-trap, out-of-scope, no-answer.",
	"",
	"The six difficulties:",
	"- direct: the specification answers it and the agent applies it.",
	"- clarify: the request is ambiguous ON PURPOSE. The right behaviour is a",
	"  clarifying question, and the checks describe that question rather than an",
	"  answer the agent could not yet know.",
	"- tool: the agent has to take an allowed action to get there.",
	"- policy-trap: the request asserts a plausible WRONG rule the specification",
	"  contradicts (\"as always, you refund within 60 days\"). The checks name the",
	"  right value with output_contains AND exclude the wrong one with",
	"  output_excludes.",
	"- out-of-scope: the request is outside what the agent may do. It must decline",
	"  or redirect, and the checks exclude the invented fulfilment.",
	"- no-answer: the specification does not hold the answer. The agent must say so,",
	"  and output_excludes names the value it must not invent.",
	"",
	"- Write inputs in the same language and register as the examples.",
].join("\n");

/** The cells, spelled out for the generator: the rows, the columns, the counts. */
function coveragePromptLines(jobs: readonly string[], cells: readonly SealedSynthCoverageCell[]): string[] {
	if (jobs.length === 0 || cells.length === 0) {
		// A Spec with no jobs has no rows, and a label against a job nobody
		// declared would be refused on arrival. Asking for none is the honest ask.
		return [
			"# Coverage",
			"",
			"This specification lists no jobs, so write no \"coverage\" label.",
			"Still spread the cases over the six difficulties, traps included.",
			"",
		];
	}
	return [
		"# Coverage cells to fill",
		"",
		"Jobs (use one of these, verbatim, as \"coverage\".\"job\"):",
		...jobs.map((job) => `- ${job}`),
		"",
		"Write this many cases in each cell:",
		...cells.map((cell) => `- ${cell.job} × ${cell.difficulty}: ${cell.cases}`),
		"",
	];
}

function generatorUserPrompt(input: {
	specText: string;
	examples: readonly CorpusTask[];
	graderShapes: readonly string[];
	jobs: readonly string[];
	cells: readonly SealedSynthCoverageCell[];
	count: number;
}): string {
	const lines = [
		"# Specification",
		"",
		input.specText.trim(),
		"",
		...coveragePromptLines(input.jobs, input.cells),
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
		"Checks first, then the request. Return only {\"cases\": [ ... ]}.",
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
	"You are shown ONE passage and told how many questions to write from it.",
	"Each question is one a real user would ask, whose complete answer is",
	"contained in that passage, and you write the answer too.",
	"",
	"Rules:",
	"- Answer with one JSON object and nothing else:",
	"  {\"questions\": [{\"question\": \"...\", \"answer\": \"...\"}]}.",
	"- No prose, no explanation, no markdown fence, no commentary.",
	"- Write exactly as many questions as you are asked for, and make them",
	"  DIFFERENT from one another: a different fact of the passage each time,",
	"  never the same fact reworded. If the passage does not hold that many",
	"  separate facts, write fewer rather than repeating one.",
	"- Every question must be answerable from the passage ALONE. Do not ask about",
	"  anything the passage does not state.",
	"- The question is what a user asks, not what a document says: no \"according to",
	"  the passage\", no reference to a document, a section, or an id.",
	"- The answer is short, factual, and uses the passage's own numbers, names and",
	"  terms exactly as written.",
	"- Write both in the language of the passage.",
	"",
	"Some passages are also asked for one NO-ANSWER question. That one is a",
	"question a user would plausibly ask about this subject and the passage does",
	"NOT answer — a neighbouring fact it never states. You give it as",
	"  \"noAnswer\": {\"question\": \"...\", \"invented\": \"...\"}",
	"where \"invented\" is the single most likely value someone would make up for",
	"it (a price, a deadline, a name), written the way it would appear in an",
	"answer. The agent is supposed to say the documents do not cover it; the",
	"invented value is what it must never state. Do not put the no-answer question",
	"in \"questions\".",
].join("\n");

function kbGeneratorUserPrompt(passage: KbPassage, questions: number, noAnswer: boolean): string {
	return [
		`# Passage ${passage.id}`,
		"",
		passage.text.trim(),
		"",
		"# Task",
		"",
		`Write ${questions} different question(s) and their answers from this passage.`,
		...(noAnswer
			? [
				"Then add one no-answer question about something this passage does not",
				"state, with the value a careless answer would invent for it.",
				"Return only {\"questions\": [{\"question\": \"...\", \"answer\": \"...\"}], " +
					"\"noAnswer\": {\"question\": \"...\", \"invented\": \"...\"}}.",
			]
			: ["Return only {\"questions\": [{\"question\": \"...\", \"answer\": \"...\"}]}."]),
	].join("\n");
}

function chunkKey(datasetHash: string, seed: string, chunkId: string): string {
	return createHash("sha256").update(`${datasetHash} sealed-synth kb ${seed} ${chunkId}`).digest("hex");
}

/** One passage and how many questions this exam asks of it. */
interface KbQuestionShare {
	passage: KbPassage;
	questions: number;
}

/**
 * Which passages the exam is written from, and how many questions each carries.
 *
 * Passages are drawn from (dataset hash, seed, passage id) by the same rule the
 * format-example draw uses, so the same seed over the same knowledge base
 * always asks about the same passages. The questions are then spread over the
 * drawn passages as evenly as they divide, and the remainder goes to the
 * passages the seed ranked first — so `count` is reproducible from
 * `(datasetHash, seed)` down to which passage carries the extra question.
 *
 * Nothing here can exceed {@link MAX_KB_QUESTIONS_PER_PASSAGE}: the caller has
 * already capped `count` at the number of passages times that bound.
 */
function drawKbQuestions(
	passages: readonly KbPassage[],
	datasetHash: string,
	count: number,
	seed: string,
): KbQuestionShare[] {
	const ranked = [...passages].sort((left, right) => {
		const a = chunkKey(datasetHash, seed, left.id);
		const b = chunkKey(datasetHash, seed, right.id);
		return a === b ? left.id.localeCompare(right.id) : a < b ? -1 : 1;
	});
	const drawn = ranked.slice(0, Math.min(count, ranked.length));
	if (drawn.length === 0) return [];
	const base = Math.floor(count / drawn.length);
	const extra = count % drawn.length;
	const shares = new Map(drawn.map((passage, rank) => [passage.id, base + (rank < extra ? 1 : 0)]));
	// Presented in document order: the draw decides which, never in what order.
	return passages
		.filter((passage) => shares.has(passage.id))
		.map((passage) => ({ passage, questions: shares.get(passage.id) ?? 0 }));
}

/** One question-and-answer, or null when the shape is not one. */
function readPair(value: unknown): { question: string; answer: string } | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const { question, answer } = value as { question?: unknown; answer?: unknown };
	if (typeof question !== "string" || question.trim().length === 0) return null;
	if (typeof answer !== "string" || answer.trim().length === 0) return null;
	return { question, answer };
}

/** The no-answer question and the value it must not be answered with. */
function readNoAnswer(value: unknown): { question: string; invented: string } | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const { question, invented } = value as { question?: unknown; invented?: unknown };
	if (typeof question !== "string" || question.trim().length === 0) return null;
	if (typeof invented !== "string" || invented.trim().length === 0) return null;
	return { question, invented };
}

interface KbReply {
	pairs: { question: string; answer: string }[];
	noAnswer: { question: string; invented: string } | null;
}

/**
 * The questions one knowledge-base call is allowed to return, at most `limit`,
 * plus the no-answer question when one was asked for.
 *
 * Both shapes are read: `{ "questions": [ ... ] }` is what the prompt asks for,
 * and a bare `{ "question", "answer" }` is one question written the older way —
 * a generator that answers a request for one question with one question has
 * done what was asked, and refusing its shape would throw a paid case away.
 */
function parseKbReply(text: string, limit: number): KbReply {
	const empty: KbReply = { pairs: [], noAnswer: null };
	if (Buffer.byteLength(text, "utf8") > MAX_GENERATOR_RESPONSE_BYTES) return empty;
	const stripped = text.replace(/```(?:json)?/g, "").trim();
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	if (start < 0 || end <= start) return empty;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripped.slice(start, end + 1));
	} catch {
		return empty;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return empty;
	const listed = (parsed as { questions?: unknown }).questions;
	const values = Array.isArray(listed) ? listed : [parsed];
	const pairs: { question: string; answer: string }[] = [];
	for (const value of values) {
		if (pairs.length >= limit) break;
		const pair = readPair(value);
		if (pair) pairs.push(pair);
	}
	return { pairs, noAnswer: readNoAnswer((parsed as { noAnswer?: unknown }).noAnswer) };
}

/**
 * The graders a knowledge-base case carries.
 *
 * Two deterministic checks, and no judge. `cites_source` requires an explicit citation of
 * the source chunk; it does not distinguish retrieval from recall. Token F1
 * against the reference measures lexical agreement, not semantic correctness. A judge grader here would ask the model that
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

/**
 * The graders a no-answer case carries: the one thing the answer must not say.
 *
 * There is no `cites_source` and no reference answer, because the passage holds
 * neither — the whole case is that it does not. What can be checked without a
 * model is that the invented value never appears, and that is what a hallucinating
 * agent produces.
 */
function kbNoAnswerGraders(invented: string): GraderSpec[] {
	return [{ type: "output_excludes", text: invented, caseSensitive: false }];
}

/**
 * How finely the generator reads the base, and the passages that come out.
 *
 * The runtime geometry is the honest default: a passage the agent can actually
 * be handed by `kb_search` is a passage a question can fairly be asked about.
 * It is halved only when the base cannot otherwise fill the exam — session 8
 * had three documents, three chunks and three questions where the guardrail
 * needed fifteen, and generated the exam from the description instead. Halving
 * stops at {@link MIN_KB_CHUNK_CHARS}, and stops early when a finer cut yields
 * no more passages: a base of three one-line documents is at its floor whatever
 * the number says.
 */
function kbExamPassages(
	chunks: readonly KbChunk[],
	needed: number,
): { passages: KbPassage[]; geometry: KbGeometry } {
	let geometry = KB_GEOMETRY;
	let passages = kbPassages(chunks, geometry);
	while (passages.length * MAX_KB_QUESTIONS_PER_PASSAGE < needed) {
		const finer = finerGeometry(geometry);
		if (!finer) break;
		const cut = kbPassages(chunks, finer);
		if (cut.length <= passages.length) break;
		geometry = finer;
		passages = cut;
	}
	return { passages, geometry };
}

/**
 * The most questions this Target's knowledge base can ever produce, or null
 * when it declares none and the question does not apply.
 *
 * The Builder reads this so it never offers what the documents cannot give:
 * live session 8 answered a three-question exam by offering to "load twelve
 * more from the knowledge base", because nothing had ever told it the ceiling.
 * An unreadable base answers null rather than a number — a screen narrows, it
 * does not fail, on provenance it cannot read.
 */
export function maxKbExamQuestions(target: ResolvedTarget): number | null {
	if (!knowledgeBaseDeclared(target.manifest.data)) return null;
	let chunks: KbChunk[];
	try {
		chunks = readKnowledgeBase(target.dir);
	} catch {
		return null;
	}
	if (chunks.length === 0) return 0;
	// The finest cut this engine ever uses, and therefore the most questions it
	// will ever write: a generation never chunks finer than the guardrail's own
	// minimum asks for, however many cases were ordered.
	const cut = kbExamPassages(chunks, SEALED_GATE_POLICY.minTasks);
	return cut.passages.length * MAX_KB_QUESTIONS_PER_PASSAGE;
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

/**
 * One case the generator wrote, with the passage it was written from when there
 * is one. The passage travels with the case so the critic can be shown the
 * source it is supposed to check the case against.
 */
interface GeneratedCandidate {
	value: unknown;
	cited: { label: string; text: string } | null;
}

/** An admitted case and the source it cites, still paired. */
interface AdmittedCase {
	task: CorpusTask;
	cited: { label: string; text: string } | null;
}

interface AdmittedCases {
	cases: AdmittedCase[];
	droppedMalformed: number;
	droppedDuplicate: number;
	/** Cases with nothing but a judge grader behind them. */
	droppedJudgeOnly: number;
	/** Labels the host refused; the case itself was kept. */
	droppedLabel: number;
}

/**
 * The checks-first shape, flattened.
 *
 * The prompt asks for `{ coverage, checks: { graders, world, expected }, input }`
 * so the model settles the outcome before it writes the request. The task shape
 * on disk is flat, and the older flat reply is still a correct answer to an
 * older prompt, so both are read and neither is privileged.
 */
function flattenChecks(value: Record<string, unknown>): Record<string, unknown> {
	const { checks, ...rest } = value;
	if (typeof checks !== "object" || checks === null || Array.isArray(checks)) return rest;
	const { graders, world, expected } = checks as Record<string, unknown>;
	return {
		...rest,
		...(graders !== undefined ? { graders } : {}),
		...(world !== undefined ? { world } : {}),
		...(expected !== undefined ? { expected } : {}),
	};
}

/** Whether anything but a model's opinion decides this case. */
function hasDeterministicCheck(task: CorpusTask): boolean {
	if (task.graders.some(isDeterministicGrader)) return true;
	return (task.world?.expect?.length ?? 0) > 0;
}

/**
 * The cell label, when the generator wrote one the Spec can confirm.
 *
 * An unknown job or an unknown difficulty costs the label, never the case: the
 * case is a case whatever it is filed under, and a label nobody declared would
 * put a row in the matrix that the Spec does not have.
 */
function admittedCoverage(value: unknown, jobs: ReadonlySet<string>): CaseCoverage | null {
	if (value === undefined) return null;
	const parsed = CaseCoverageSchema.safeParse(value);
	if (!parsed.success || !jobs.has(parsed.data.job)) return null;
	return parsed.data;
}

/**
 * Validate, deduplicate, and re-id. Ids are derived from the Spec hash and the
 * normalized input — never taken from the generator — for the same reason a
 * corpus import derives them: an id a model chose is an id a model controls.
 * `source` is stamped here for the same reason: provenance a model could write
 * is provenance a model could forge.
 */
function admitCases(
	candidates: readonly GeneratedCandidate[],
	specSha256: string,
	seenNormalized: ReadonlySet<string>,
	limit: number,
	jobs: readonly string[],
): AdmittedCases {
	const cases: AdmittedCase[] = [];
	const seen = new Set(seenNormalized);
	const knownJobs = new Set(jobs);
	let droppedMalformed = 0;
	let droppedDuplicate = 0;
	let droppedJudgeOnly = 0;
	let droppedLabel = 0;

	for (const candidate of candidates) {
		if (cases.length >= limit) break;
		const value = candidate.value;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			droppedMalformed += 1;
			continue;
		}
		const { id: _id, source: _source, coverage, ...rest } = flattenChecks(value as Record<string, unknown>);
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
		const label = admittedCoverage(coverage, knownJobs);
		const parsed = CorpusTaskSchema.safeParse({
			...rest,
			...(label ? { coverage: label } : {}),
			source: { kind: "generated", generator: "judge" },
			id: derivedCaseId(specSha256, normalized),
		});
		if (!parsed.success || taskDialogueIssue(parsed.data) !== null) {
			droppedMalformed += 1;
			continue;
		}
		if (!hasDeterministicCheck(parsed.data)) {
			droppedJudgeOnly += 1;
			continue;
		}
		seen.add(normalized);
		// Counted only for a case that was kept: a label refused on a case that
		// was then dropped for another reason is not a coverage fact.
		if (coverage !== undefined && !label) droppedLabel += 1;
		cases.push({ task: parsed.data, cited: candidate.cited });
	}
	return { cases, droppedMalformed, droppedDuplicate, droppedJudgeOnly, droppedLabel };
}

/**
 * One case as the critic reads it: the case, and the source it stands on.
 *
 * On the Spec source there is no per-case source — the whole Spec is already in
 * the critic's own prompt, and naming it twice would only invite the critic to
 * check the case against a copy of what it has. On the knowledge-base source the
 * passage is the source, and checking the case against it is the entire job.
 */
function criticCaseOf(admitted: AdmittedCase): CriticCase {
	const { task } = admitted;
	return {
		task: {
			id: task.id,
			input: task.input,
			...(task.expected !== undefined ? { expected: task.expected } : {}),
			...(task.messages ? { messages: task.messages } : {}),
			...(task.simulatedUser ? { simulatedUser: task.simulatedUser } : {}),
			...(task.world !== undefined ? { world: task.world } : {}),
			...(task.coverage ? { coverage: task.coverage } : {}),
			...(task.source ? { source: task.source } : {}),
			graders: task.graders,
		},
		sourceLabel: admitted.cited?.label ?? "the specification above",
		sourceText: admitted.cited?.text ?? null,
	};
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
	// The critic's verdicts land beside the draft, and that write is immutable
	// too. Refused here, before a token is spent, rather than after the draft is
	// on disk and the receipt that names it is not.
	const annotations = sealedSynthCriticAnnotationPath(resolved);
	if (existsSync(annotations)) {
		throw new SealedSynthRefusal(
			`the critic verdicts for that review file already exist: ${annotations}`,
			"choose a path that does not exist yet, or move that file aside first",
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
	// `writeTextArtifact` creates the file with this mode and publishes that
	// exact inode by link or rename, so the draft is 0600 on disk — a umask can
	// only clear bits, and 0600 has none an ordinary one clears. The chmod that
	// used to follow this call restored nothing it had not already got.
	writeTextArtifact(path, `${tasks.map((task) => canonicalJson(task)).join("\n")}\n`, {
		mode: 0o600,
		immutable: true,
	});
}

/** Where the critic's verdicts land beside a draft the human is going to read. */
export function sealedSynthCriticAnnotationPath(reviewPath: string): string {
	return `${reviewPath}.critic.jsonl`;
}

/**
 * The critic's verdicts, beside the draft rather than inside it.
 *
 * Inside would break the file: a draft is a JSONL of corpus tasks and the
 * import reads every line as one. Beside it, one line per flagged case, and
 * nothing but the case id, the verdict and the category — the critic's own
 * prose is left unwritten here for the same reason the receipt never carries
 * it, since a reason may quote the case it is about and this file is the one a
 * human opens next to the exam. The human reads the case and decides.
 */
function writeCriticAnnotations(reviewPath: string, findings: readonly CriticFinding[]): string | null {
	const flagged = findings.filter((finding) => finding.verdict !== "valid");
	if (flagged.length === 0) return null;
	const path = sealedSynthCriticAnnotationPath(reviewPath);
	const lines = flagged.map((finding) =>
		canonicalJson({ taskId: finding.taskId, verdict: finding.verdict, category: dropCategory(finding) })
	);
	writeTextArtifact(path, `${lines.join("\n")}\n`, { mode: 0o600, immutable: true });
	return path;
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
	kbCalls: { passage: KbPassage; questions: number; noAnswer: boolean; user: string }[];
	/** The Spec's jobs: the rows of the matrix, and the only labels a case may carry. */
	jobs: string[];
	/** The cells the generator is asked to fill. Empty on the knowledge-base source. */
	cells: SealedSynthCoverageCell[];
	kbIndexHash: string | null;
	/** Characters per generator passage; null on the Spec source. */
	kbChunkChars: number | null;
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
	let kbCalls: { passage: KbPassage; questions: number; noAnswer: boolean; user: string }[] = [];
	let kbIndexHash: string | null = null;
	let kbChunkChars: number | null = null;
	let kbQuestions = count;
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
		// What the exam has to reach: what was asked for, but never more than the
		// sealed guardrail's own minimum. An operator who deliberately orders a
		// five-question exam gets one; nobody gets a base cut finer than the
		// questions actually need.
		const needed = Math.min(count, SEALED_GATE_POLICY.minTasks);
		const exam = kbExamPassages(chunks, needed);
		const ceiling = exam.passages.length * MAX_KB_QUESTIONS_PER_PASSAGE;
		if (ceiling < needed) {
			// Refused here, with the number, before the human is asked anything and
			// before a token is spent — and with the one alternative that exists,
			// because "the base is too small" is only half an answer.
			throw new SealedSynthRefusal(
				t("sealed-synth.kb-too-small", {
					chunks: plural(exam.passages.length, "passage"),
					max: plural(ceiling, "question"),
					min: plural(needed, "case"),
					count: plural(count, "case"),
				}),
				t("sealed-synth.kb-too-small-next"),
			);
		}
		kbChunkChars = exam.geometry.chars;
		kbQuestions = Math.min(count, ceiling);
		kbCalls = drawKbQuestions(exam.passages, target.datasetHash, kbQuestions, seed ?? "")
			.map((share, index) => {
				// Every third passage spends one of its questions on something the
				// passage does not state. It replaces a factual question rather than
				// adding to the count — the operator ordered N cases and gets N — and a
				// passage carrying a single question keeps it factual, because an exam
				// of nothing but traps measures nothing.
				const noAnswer = (index + 1) % KB_NO_ANSWER_EVERY === 0 && share.questions >= 2;
				const questions = noAnswer ? share.questions - 1 : share.questions;
				return {
					passage: share.passage,
					questions,
					noAnswer,
					user: kbGeneratorUserPrompt(share.passage, questions, noAnswer),
				};
			});
	}

	const drawn = source === "kb" ? [] : drawExamples(target, examples, seed ?? "");
	// The matrix belongs to the Spec source: on the knowledge base the passages
	// decide what is asked, and the host labels only the trap it wrote itself.
	const cells = source === "kb" ? [] : sealedSynthCoveragePlan(spec.jobs, count);
	const system = source === "kb" ? KB_GENERATOR_SYSTEM : GENERATOR_SYSTEM;
	const user = source === "kb"
		? kbCalls.map((call) => call.user).join("\n\n")
		: generatorUserPrompt({
			specText: spec.text,
			examples: drawn,
			graderShapes: graderShapes(target),
			jobs: spec.jobs,
			cells,
			count,
		});
	return {
		target,
		judge,
		projectId,
		source,
		jobs: spec.jobs,
		cells,
		// A base of six passages cannot answer twenty independent questions, so
		// the request is capped at three per passage and the dialog prices what
		// will actually be written rather than what was asked for.
		count: source === "kb" ? kbQuestions : count,
		drawn,
		kbCalls,
		kbIndexHash,
		kbChunkChars,
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

/** One verdict is a line and a couple of reasons, not a case. */
const ESTIMATE_CRITIC_OUTPUT_TOKENS_PER_CASE = 60;

/** What one generation should cost, from the judge's own declared rates. */
function estimateSealedSynthCostUsd(judge: JudgeModel, promptBytes: number, cases: number): number {
	const promptTokens = Math.ceil(promptBytes / ESTIMATE_BYTES_PER_TOKEN);
	const completionTokens = cases * ESTIMATE_OUTPUT_TOKENS_PER_CASE;
	return evaluatorCostUsd(judge.spec.cost, {
		promptTokens,
		completionTokens,
		totalTokens: promptTokens + completionTokens,
	});
}

/** Judge calls the critic adds: one per batch, over the cases that survive parsing. */
function criticCallCount(cases: number): number {
	return Math.ceil(cases / CRITIC_BATCH_SIZE);
}

/**
 * What the critic adds to the bill.
 *
 * Every batch re-sends its own instructions and the Spec, and then the cases it
 * is reading — which are the cases the generation was priced to write, so they
 * are counted at the same size. The knowledge-base path also shows each case its
 * passage, which this does not count: an estimate that guessed at passage
 * lengths would be no more honest, and the number is shown with a `~`.
 */
function estimateCriticCostUsd(judge: JudgeModel, specBytes: number, cases: number): number {
	const calls = criticCallCount(cases);
	if (calls === 0) return 0;
	const promptBytes = calls * (Buffer.byteLength(CRITIC_SYSTEM, "utf8") + specBytes) +
		cases * ESTIMATE_OUTPUT_TOKENS_PER_CASE * ESTIMATE_BYTES_PER_TOKEN;
	const promptTokens = Math.ceil(promptBytes / ESTIMATE_BYTES_PER_TOKEN);
	const completionTokens = cases * ESTIMATE_CRITIC_OUTPUT_TOKENS_PER_CASE;
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
		kbChunkChars: ready.kbChunkChars,
		kbChunkIds: ready.kbCalls.map((call) => call.passage.id),
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
		// The critic is part of the price, not an extra nobody was told about: it
		// reads every case that survives generation, one call per batch.
		estimatedCostUsd: estimateSealedSynthCostUsd(ready.judge, ready.promptBytes, ready.count) +
			estimateCriticCostUsd(ready.judge, Buffer.byteLength(ready.spec.text, "utf8"), ready.count),
		coverageCells: ready.cells,
		coverageJobs: ready.jobs,
		criticCalls: criticCallCount(ready.count),
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
		jobs,
		cells,
		kbIndexHash,
		kbChunkChars,
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

	// One call per drawn passage on the knowledge-base path, in draw order, each
	// asked for that passage's share of the questions. Every answer becomes a
	// candidate case with the RUNTIME chunk it was written from nailed to it by
	// a grader — the only id `kb_search` can hand the agent, and therefore the
	// only id `cites_source` can check. A passage that answers with fewer
	// questions than it was asked for costs those questions, not the exam.
	const generated: GeneratedCandidate[] = [];
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
			const reply = parseKbReply(answered.text, call.questions);
			const cited = { label: `passage ${call.passage.id}`, text: call.passage.text };
			const asked = call.questions + (call.noAnswer ? 1 : 0);
			const noAnswer = call.noAnswer ? reply.noAnswer : null;
			unparsedPairs += asked - reply.pairs.length - (noAnswer ? 1 : 0);
			const passageMetadata = {
				kbChunk: call.passage.source,
				// The finer passage the question was actually written from, when it is
				// not the whole chunk. An id, and evidence: it says which part of the
				// source the question stands on.
				...(call.passage.id === call.passage.source ? {} : { kbPassage: call.passage.id }),
			};
			for (const pair of reply.pairs) {
				generated.push({
					value: {
						input: pair.question,
						expected: pair.answer,
						metadata: passageMetadata,
						graders: kbCaseGraders(call.passage.source),
					},
					cited,
				});
			}
			if (noAnswer) {
				generated.push({
					value: {
						input: noAnswer.question,
						metadata: passageMetadata,
						// The trap is only a cell of the matrix when the Spec has rows; a
						// job the Spec does not list would be refused on arrival anyway.
						...(jobs[0] ? { coverage: { job: jobs[0], difficulty: "no-answer" } } : {}),
						graders: kbNoAnswerGraders(noAnswer.invented),
					},
					cited,
				});
			}
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
		generated.push(...parseGeneratedCases(called.text).map((value) => ({ value, cited: null })));
	}

	const seenNormalized = new Set(target.tasks.map((task) => normalizedCaseInput(task.input)));
	const admittedCases_ = admitCases(generated, specSha256, seenNormalized, count, jobs);
	// A passage whose answer did not parse is a case that never existed, counted
	// with the ones validation threw out so the shortfall arithmetic stays true.
	const admitted = {
		...admittedCases_,
		droppedMalformed: admittedCases_.droppedMalformed + unparsedPairs,
	};
	if (admitted.cases.length === 0) {
		throw new Error(
			`the generator produced no admissible new case (${admitted.droppedMalformed} malformed, ` +
				`${admitted.droppedDuplicate} already in the development suite, ` +
				`${admitted.droppedJudgeOnly} with no deterministic check); nothing was sealed`,
		);
	}

	// The critic reads the cases before anybody seals them. It is asked with the
	// same judge — the model is already outside the Target's trust domain — and
	// its exchange lands in the same private directory as the generation, so the
	// one cleanup at the end takes both copies with it.
	const critique = await critiqueCases({
		judge,
		specText: spec.approved ? specTextOf(spec.approved) : spec.text,
		tools: target.tools.map((tool) => tool.descriptor.name),
		cases: admitted.cases.map((admittedCase) => criticCaseOf(admittedCase)),
		sidecarDir: exchangeDir,
		batchSize: CRITIC_BATCH_SIZE,
		...(options.signal ? { signal: options.signal } : {}),
	});
	// A sealed exam is never patched by a model nobody reads: a case the critic
	// would repair is a case whose fix nobody could check, so on the sealing path
	// `repair` is dropped beside `invalid`. On the review path nothing is dropped
	// — the human is the reader, and they get the verdicts beside the cases.
	const dropVerdicts: ReadonlySet<CriticFinding["verdict"]> = reviewPath
		? new Set()
		: new Set<CriticFinding["verdict"]>(["invalid", "repair"]);
	const byTaskId = new Map(critique.findings.map((finding) => [finding.taskId, finding]));
	const byCategory = emptyDropCounts();
	// The host's own validity drop, counted in the same vocabulary: a case with
	// nothing but a judge grader failed the same question the critic asks.
	byCategory["judge-only"] = admitted.droppedJudgeOnly;
	const kept: CorpusTask[] = [];
	for (const admittedCase of admitted.cases) {
		const finding = byTaskId.get(admittedCase.task.id);
		if (finding && dropVerdicts.has(finding.verdict)) {
			byCategory[dropCategory(finding)] += 1;
			continue;
		}
		kept.push(admittedCase.task);
	}
	const criticDropped = admitted.droppedJudgeOnly + (admitted.cases.length - kept.length);
	const critic: SealedSynthCritic = {
		reviewed: admitted.cases.length,
		dropped: criticDropped,
		byCategory,
		spend: {
			calls: critique.spend.calls,
			tokens: critique.spend.tokens,
			costUsd: critique.spend.costUsd,
		},
	};
	if (kept.length === 0) {
		throw new Error(
			`the critic rejected every generated case (${dropReasonList(byCategory)}); nothing was sealed`,
		);
	}

	const now = options.now ?? (() => new Date().toISOString());
	let corpus: CorpusMetadata | null = null;
	let criticAnnotationsPath: string | null = null;
	let outcome: SealedSynthReceipt["outcome"];
	if (reviewPath) {
		writeReviewFile(reviewPath, kept);
		criticAnnotationsPath = writeCriticAnnotations(reviewPath, critique.findings);
		outcome = { kind: "review", reviewPath, caseCount: kept.length };
	} else {
		corpus = createCorpus({
			stateRoot: options.stateRoot,
			projectId,
			name: options.name,
			visibility: "sealed",
			tasks: kept,
		});
		outcome = { kind: "sealed", corpusId: corpus.id, corpusHash: corpus.hash, taskCount: corpus.taskCount };
	}

	const coverage: SealedSynthCoverage = {
		jobs,
		plan: cells,
		achieved: achievedCells(kept, jobs),
		unlabelled: kept.filter((task) => task.coverage === undefined).length,
		droppedLabel: admitted.droppedLabel,
	};

	// Three durable effects, in the order that survives a crash between any two
	// of them. The corpus first, because the receipt names it. The receipt next,
	// because a sealed exam whose receipt was never written is an exam the
	// passport renders as operator-supplied — the one claim it must never make
	// about a judge-written one. Deleting the raw exchange comes last: until the
	// receipt exists, that exchange is the only surviving proof of where the
	// questions came from.
	const receipt = SealedSynthReceiptSchema.parse({
		schemaVersion: 4,
		source,
		kbIndexHash,
		kbChunkChars,
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
		accepted: kept.length,
		droppedMalformed: admitted.droppedMalformed,
		droppedDuplicate: admitted.droppedDuplicate,
		coverage,
		critic,
		outcome,
		at: now(),
	});
	const receiptPath = join(receiptsDir, `${receiptSha(receipt)}.json`);
	if (!existsSync(receiptPath)) {
		writeJsonArtifact(receiptPath, SealedSynthReceiptSchema, receipt, { immutable: true });
	}

	// The cases have a home and their origin is written down; the raw exchange is
	// now only a second copy of holdout content. A cleanup that cannot happen is
	// reported rather than thrown: the exam exists either way, and the operator
	// is the one who has to know a copy of it is still on disk.
	let exchangeRetained: string | null = null;
	try {
		rmSync(exchangeDir, { recursive: true, force: true });
	} catch {
		exchangeRetained = exchangeDir;
	}
	try {
		rmdirSync(join(receiptsDir, EXCHANGE_DIRECTORY));
	} catch {
		// A concurrent generation still holds its own exchange, or there never was
		// a directory. Either way the receipts directory holds only receipts.
	}

	return {
		receipt,
		receiptPath,
		source,
		corpus,
		reviewPath,
		exchangeRetained,
		generatorModel: `${judge.provider}/${judge.id}`,
		promptSha256,
		requested: count,
		accepted: kept.length,
		droppedMalformed: admitted.droppedMalformed,
		droppedDuplicate: admitted.droppedDuplicate,
		coverage,
		critic,
		criticAnnotationsPath,
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

/**
 * What the judge was asked for and what survived, for a sealed corpus this
 * project generated.
 *
 * Session 6 ordered 20 cases and the exam ran on 19; no screen said why. The
 * receipt has recorded it all along — `requested`, `accepted`, and the two
 * reasons a case is dropped — so the difference is read, never inferred. An
 * exam the operator brought has no receipt here and the answer is null.
 */
export function sealedExamGeneration(
	stateRoot: string,
	projectId: string,
	corpusId: string | null,
): { requested: number; accepted: number; droppedDuplicate: number; droppedMalformed: number } | null {
	if (!corpusId) return null;
	let receipts: SealedSynthReceipt[];
	try {
		receipts = listSealedSynthReceipts(stateRoot, projectId);
	} catch {
		// Unreadable provenance narrows the line; it never fails the screen.
		return null;
	}
	for (const receipt of receipts) {
		const sealedHere = (receipt.outcome.kind === "sealed" || receipt.outcome.kind === "review-imported") &&
			receipt.outcome.corpusId === corpusId;
		if (!sealedHere) continue;
		return {
			requested: receipt.requested,
			accepted: receipt.accepted,
			droppedDuplicate: receipt.droppedDuplicate,
			droppedMalformed: receipt.droppedMalformed,
		};
	}
	return null;
}

// ---------- rendering ----------

export interface SealedSynthOutput {
	/** Exactly what the command prints. Never a case, never a fragment of one. */
	stdout: string[];
	/** Counts and guardrails, on stderr. */
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
			`next: read and edit that file, then seal it in the Builder conversation: /holdout ${result.reviewPath ?? ""}`,
		];

	const warnings: string[] = [`receipt ${result.receiptPath}`];
	if (result.criticAnnotationsPath) {
		// A pointer, so the human editing the draft knows a second file is waiting
		// with the critic's verdict on each case it flagged.
		warnings.push(`critic verdicts ${result.criticAnnotationsPath}`);
	}
	if (result.exchangeRetained) {
		warnings.push(
			`warning: the raw generator exchange could not be removed and still holds a copy of the exam: ` +
				`${result.exchangeRetained}`,
		);
	}
	if (result.droppedMalformed > 0) {
		warnings.push(`warning: ${result.droppedMalformed} generated case(s) did not match the case schema and were dropped`);
	}
	if (result.droppedDuplicate > 0) {
		warnings.push(
			`warning: ${result.droppedDuplicate} generated case(s) repeated a development input and were dropped`,
		);
	}
	if (result.critic && result.critic.dropped > 0) {
		// Categories, never the critic's own words: its reasons may quote the case
		// they are about, and this line is read by everyone.
		warnings.push(t("critic.exam-dropped", {
			dropped: result.critic.dropped,
			reasons: dropReasonList(result.critic.byCategory),
		}));
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
