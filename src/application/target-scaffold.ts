import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { loadTarget, scaffoldTarget, TargetManifest, type ResolvedTarget } from "../manifest.js";
import { canonicalJson, hashValue } from "../provenance.js";
import { writeJsonArtifact } from "../storage/artifacts.js";
import { discoverAdoptedDeclarations } from "./agent-folder-detect.js";
import { ensureLocalArtifactIgnores, missingLocalArtifactIgnores } from "./store-hygiene.js";

// The adoption declares what the detector already counted for the door's first
// sentence, so the discovery lives beside the detector and is re-exported here
// for every reader that learned the name from this module.
export { discoverAdoptedDeclarations };

const MAX_SCAFFOLD_FILES = 200;
const MAX_SCAFFOLD_BYTES = 2 * 1024 * 1024;
const RECEIPT_FILENAME = "target-scaffold.json";

const NonBlankSchema = z.string().min(1).refine((value) => value.trim().length > 0, "expected non-blank text");
const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const GitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

export const TargetScaffoldFileSchema = z.strictObject({
	path: NonBlankSchema.max(4_096),
	bytes: z.number().int().nonnegative(),
	sha256: Sha256Schema,
});
export type TargetScaffoldFile = z.infer<typeof TargetScaffoldFileSchema>;

/**
 * The exact subject a v1 receipt recorded. Kept verbatim so every scaffold
 * receipt already on disk still validates: a schema bump that made old
 * evidence unreadable would be a worse bug than the one it fixed.
 */
export const TargetScaffoldSubjectV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	operation: z.literal("initialize-current-directory"),
	targetPath: NonBlankSchema.max(4_096),
	targetId: NonBlankSchema.max(100),
	templateFiles: z.array(TargetScaffoldFileSchema).min(1).max(MAX_SCAFFOLD_FILES),
	templateHash: Sha256Schema,
	manifest: TargetManifest,
	generated: z.strictObject({
		gitRepository: z.literal("fresh repository with one scaffold commit"),
		localArtifactIgnores: z.tuple([
			z.literal("/.ahde/"),
			z.literal("/imports/"),
			z.literal("/runs/"),
			z.literal("/.env"),
			z.literal("/.env.*"),
			z.literal("!/.env.example"),
		]),
	}),
});
export type TargetScaffoldSubjectV1 = z.infer<typeof TargetScaffoldSubjectV1Schema>;

/**
 * What this operation found in the folder it is adopting. Present only on an
 * adopt: it is the sentence the dialog showed the operator, kept as evidence
 * of what they were looking at when they said yes.
 */
export const TargetAdoptionFindingSchema = z.strictObject({
	entry: NonBlankSchema.max(4_096),
	language: z.literal("python"),
	toolCount: z.number().int().nonnegative(),
	/**
	 * Whether the folder carried a `data/kb`. Optional because receipts written
	 * before the door counted it say nothing about one; every new receipt does,
	 * because the sentence the operator said yes to now names it.
	 */
	knowledgeBase: z.boolean().optional(),
	filesScanned: z.number().int().nonnegative(),
});
export type TargetAdoptionFinding = z.infer<typeof TargetAdoptionFindingSchema>;

/**
 * Bumped to 2 by the adopt path. `operation` is a two-value enum now, and
 * `generated` describes what actually happened rather than asserting the one
 * thing a fresh scaffold always does — an adopted folder may already be a Git
 * repository and may already ignore half the rules AHDE would add.
 */
export const TargetScaffoldSubjectSchema = z.strictObject({
	schemaVersion: z.literal(2),
	operation: z.enum(["initialize-current-directory", "adopt-current-directory"]),
	targetPath: NonBlankSchema.max(4_096),
	targetId: NonBlankSchema.max(100),
	/**
	 * Every file this operation will create, with its exact bytes. For a
	 * scaffold that is the packaged template; for an adopt it is the small set
	 * of files AHDE generates, and NOTHING the operator already wrote — the
	 * whole promise of adoption is that their sources are not touched.
	 */
	templateFiles: z.array(TargetScaffoldFileSchema).min(1).max(MAX_SCAFFOLD_FILES),
	templateHash: Sha256Schema,
	manifest: TargetManifest,
	/** Only on an adopt: what the read-only detector saw. */
	found: TargetAdoptionFindingSchema.optional(),
	generated: z.strictObject({
		gitRepository: z.enum([
			"fresh repository with one scaffold commit",
			"the existing clean repository, at its current HEAD",
		]),
		localArtifactIgnores: z.array(NonBlankSchema.max(200)).max(7),
	}),
}).superRefine((subject, context) => {
	if ((subject.operation === "adopt-current-directory") !== (subject.found !== undefined)) {
		context.addIssue({
			code: "custom",
			path: ["found"],
			message: "an adopt records what it found; an initialize has nothing to find",
		});
	}
});
export type TargetScaffoldSubject = z.infer<typeof TargetScaffoldSubjectSchema>;

/** Reads either version. New receipts are always written at the current one. */
export const AnyTargetScaffoldSubjectSchema = z.union([
	TargetScaffoldSubjectSchema,
	TargetScaffoldSubjectV1Schema,
]);
export type AnyTargetScaffoldSubject = z.infer<typeof AnyTargetScaffoldSubjectSchema>;

export const TargetScaffoldReceiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	id: z.string().regex(/^target-scaffold-[0-9a-f]{64}$/),
	subject: AnyTargetScaffoldSubjectSchema,
	subjectHash: Sha256Schema,
	targetGitSha: GitShaSchema,
	actor: z.strictObject({ kind: z.literal("human"), id: NonBlankSchema.max(256) }),
	reason: NonBlankSchema.max(4_000),
	scaffoldedAt: z.iso.datetime({ offset: true }),
}).superRefine((receipt, context) => {
	if (receipt.subjectHash !== hashValue(receipt.subject)) {
		context.addIssue({ code: "custom", path: ["subjectHash"], message: "does not bind the exact scaffold subject" });
	}
	const { id: _id, ...identity } = receipt;
	const expected = `target-scaffold-${hashValue(identity).slice("sha256:".length)}`;
	if (receipt.id !== expected) {
		context.addIssue({ code: "custom", path: ["id"], message: "does not bind the exact receipt" });
	}
});
export type TargetScaffoldReceipt = z.infer<typeof TargetScaffoldReceiptSchema>;

export interface DescribeTargetScaffoldOptions {
	projectDir: string;
	templateDir: string;
}

export interface ApplyTargetScaffoldOptions extends DescribeTargetScaffoldOptions {
	stateRoot: string;
	expectedSubjectHash: string;
	actor: { kind: "human"; id: string };
	reason: string;
}

export interface TargetScaffoldResult {
	subject: TargetScaffoldSubject;
	receipt: TargetScaffoldReceipt;
	receiptPath: string;
	target: ResolvedTarget;
}

export interface TargetScaffoldDependencies {
	now: () => string;
	scaffold: typeof scaffoldTarget;
	load: typeof loadTarget;
	writeReceipt: (path: string, receipt: TargetScaffoldReceipt) => void;
}

const DEFAULT_DEPENDENCIES: TargetScaffoldDependencies = {
	now: () => new Date().toISOString(),
	scaffold: scaffoldTarget,
	load: loadTarget,
	writeReceipt: (path, receipt) => writeJsonArtifact(path, TargetScaffoldReceiptSchema, receipt, { immutable: true }),
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function templateInventory(templateDirInput: string): TargetScaffoldFile[] {
	const templateDir = resolve(templateDirInput);
	if (!existsSync(templateDir)) throw new Error(`packaged target template is missing: ${templateDir}`);
	const root = lstatSync(templateDir);
	if (!root.isDirectory() || root.isSymbolicLink()) {
		throw new Error(`packaged target template must be a regular non-symlink directory: ${templateDir}`);
	}
	const files: TargetScaffoldFile[] = [];
	let totalBytes = 0;
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
			const absolute = join(directory, entry.name);
			const path = relative(templateDir, absolute).split(sep).join("/");
			if (entry.isSymbolicLink()) throw new Error(`packaged target template contains a symlink: ${path}`);
			if (entry.isDirectory()) {
				walk(absolute);
				continue;
			}
			if (!entry.isFile()) throw new Error(`packaged target template contains an unsupported entry: ${path}`);
			const bytes = statSync(absolute).size;
			totalBytes += bytes;
			files.push({
				path,
				bytes,
				sha256: `sha256:${createHash("sha256").update(readFileSync(absolute)).digest("hex")}`,
			});
			if (files.length > MAX_SCAFFOLD_FILES || totalBytes > MAX_SCAFFOLD_BYTES) {
				throw new Error("packaged target template exceeds the bounded scaffold limit");
			}
		}
	};
	walk(templateDir);
	if (!files.some((file) => file.path === "manifest.yaml")) throw new Error("packaged target template has no manifest.yaml");
	return files;
}

function assertScaffoldableProject(projectDirInput: string): void {
	const projectDir = resolve(projectDirInput);
	if (!existsSync(projectDir)) throw new Error(`target directory does not exist: ${projectDir}`);
	const root = lstatSync(projectDir);
	if (!root.isDirectory() || root.isSymbolicLink()) {
		throw new Error(`target directory must be a regular non-symlink directory: ${projectDir}`);
	}
	const allowed = new Set([".ahde", "runs"]);
	for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
		if (!allowed.has(entry.name)) {
			throw new Error(`target scaffold requires an otherwise empty current directory; found ${entry.name}`);
		}
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`allowed local scaffold entry must be a regular directory: ${entry.name}`);
		}
	}
}

export function describeTargetScaffold(options: DescribeTargetScaffoldOptions): TargetScaffoldSubject {
	assertScaffoldableProject(options.projectDir);
	const templateFiles = templateInventory(options.templateDir);
	const manifest = TargetManifest.parse(parseYaml(readFileSync(join(resolve(options.templateDir), "manifest.yaml"), "utf8")));
	return TargetScaffoldSubjectSchema.parse({
		schemaVersion: 2,
		operation: "initialize-current-directory",
		targetPath: resolve(options.projectDir),
		targetId: manifest.id,
		templateFiles,
		templateHash: hashValue(templateFiles),
		manifest,
		generated: {
			gitRepository: "fresh repository with one scaffold commit",
			localArtifactIgnores: ["/.ahde/", "/imports/", "/runs/", "/exports/", "/.env", "/.env.*", "!/.env.example"],
		},
	});
}

export function applyTargetScaffold(
	options: ApplyTargetScaffoldOptions,
	dependencies: Partial<TargetScaffoldDependencies> = {},
): TargetScaffoldResult {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	const subject = describeTargetScaffold(options);
	if (hashValue(subject) !== options.expectedSubjectHash) throw new Error("target scaffold subject changed after review");
	const actor = options.actor.id.trim();
	const reason = options.reason.trim();
	if (!actor || actor.length > 256) throw new Error("target scaffold actor identity must be bounded and non-blank");
	if (!reason || reason.length > 4_000) throw new Error("target scaffold reason must be bounded and non-blank");

	const stateRoot = resolve(options.stateRoot);
	if (!existsSync(stateRoot)) mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	const stateEntry = lstatSync(stateRoot);
	if (!stateEntry.isDirectory() || stateEntry.isSymbolicLink()) {
		throw new Error("target scaffold state root must be a regular non-symlink directory");
	}
	const receiptPath = join(stateRoot, RECEIPT_FILENAME);
	if (existsSync(receiptPath)) throw new Error("target scaffold receipt already exists; replay refused");

	const scratch = mkdtempSync(join(stateRoot, "target-scaffold-"));
	const copiedTemplate = join(scratch, "template");
	const stagedTarget = join(scratch, "target");
	const moved: string[] = [];
	let wroteReceipt = false;
	try {
		cpSync(resolve(options.templateDir), copiedTemplate, { recursive: true });
		if (canonicalJson(templateInventory(copiedTemplate)) !== canonicalJson(subject.templateFiles)) {
			throw new Error("packaged target template changed while it was being staged");
		}
		deps.scaffold(copiedTemplate, stagedTarget);
		assertScaffoldableProject(options.projectDir);
		const entries = readdirSync(stagedTarget).sort((left, right) => {
			if (left === ".git") return 1;
			if (right === ".git") return -1;
			return left.localeCompare(right);
		});
		for (const entry of entries) {
			const destination = join(resolve(options.projectDir), entry);
			if (existsSync(destination)) throw new Error(`scaffold destination unexpectedly exists: ${entry}`);
			renameSync(join(stagedTarget, entry), destination);
			moved.push(entry);
		}
		const target = deps.load(options.projectDir);
		if (target.manifest.id !== subject.targetId) {
			throw new Error(`scaffolded target id mismatch: expected ${subject.targetId}, got ${target.manifest.id}`);
		}
		if (!/^[0-9a-f]{40}$/.test(target.gitSha)) throw new Error("fresh scaffold must resolve to one clean Git revision");
		const receiptIdentity = {
			schemaVersion: 1 as const,
			subject,
			subjectHash: hashValue(subject),
			targetGitSha: target.gitSha,
			actor: { kind: "human" as const, id: actor },
			reason,
			scaffoldedAt: deps.now(),
		};
		const receipt = TargetScaffoldReceiptSchema.parse({
			...receiptIdentity,
			id: `target-scaffold-${hashValue(receiptIdentity).slice("sha256:".length)}`,
		});
		deps.writeReceipt(receiptPath, receipt);
		wroteReceipt = true;
		return { subject, receipt, receiptPath, target };
	} catch (error) {
		if (wroteReceipt && existsSync(receiptPath)) unlinkSync(receiptPath);
		const rollbackFailures: string[] = [];
		for (const entry of [...moved].reverse()) {
			try {
				if (!existsSync(stagedTarget)) mkdirSync(stagedTarget);
				const source = join(resolve(options.projectDir), entry);
				const destination = join(stagedTarget, entry);
				if (existsSync(source) && !existsSync(destination)) renameSync(source, destination);
			} catch (rollbackError) {
				rollbackFailures.push(`${entry}: ${errorMessage(rollbackError)}`);
			}
		}
		if (rollbackFailures.length > 0) {
			throw new Error(`target scaffold failed and rollback was incomplete: ${rollbackFailures.join("; ")}`, { cause: error });
		}
		throw error;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Adoption: the sibling path for a folder that already holds an agent.
//
// Deliberately a SIBLING and not a relaxation of `assertScaffoldableProject`.
// That function's rule — "an otherwise empty directory" — is what makes a
// scaffold safe to roll back by moving files out again. Adoption cannot make
// that promise, so it makes a different and narrower one instead: it writes
// only files that do not exist, it never touches a line the operator wrote,
// and it decides every path before it writes the first byte.

/** Exactly the files AHDE generates when it adopts a folder. */
const ADOPTION_REQUIRED_FILES = ["manifest.yaml", "evals/development.jsonl", "evals/graders.yaml"] as const;
/** Written only when the folder has none of its own. */
const ADOPTION_OPTIONAL_FILES = ["AGENTS.md"] as const;

export interface DescribeTargetWrapOptions {
	projectDir: string;
	/** What the detector found. The dialog showed this sentence to the operator. */
	found: TargetAdoptionFinding;
	/** The exact command, as argv. argv[0] is absolute or a bare PATH name. */
	argv: string[];
	/** The editable surface: which files a proposal may rewrite. */
	harnessFiles: string[];
}

export interface ApplyTargetWrapOptions extends DescribeTargetWrapOptions {
	stateRoot: string;
	expectedSubjectHash: string;
	actor: { kind: "human"; id: string };
	reason: string;
}

function yamlList(values: readonly string[]): string {
	return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

/**
 * The manifest an adopted folder gets. Identity and model are the same
 * one-time placeholders every template ships, so the adopted Target lands in
 * exactly the state `configure-target` already knows how to finish.
 */
function adoptedManifestText(options: DescribeTargetWrapOptions): string {
	const declared = discoverAdoptedDeclarations(options.projectDir);
	return `# Этот файл написал AHDE, когда принял папку как агента. Всё остальное
# в папке — ваше и не тронуто.
#
# id и модель ниже — стартовые заглушки: первый диалог спросит, какую модель
# использует агент, и запишет ответ сюда отдельным ревьюируемым коммитом.
id: my-agent
model:
  provider: openai-compatible
  id: replace-with-model-id
  api: openai-completions
  baseUrl: http://127.0.0.1:1234/v1
  apiKeyEnv: AHDE_MODEL_API_KEY
  thinkingLevel: "off"
  timeoutMs: 300000
execution:
  # Ваш агент — обычная программа. AHDE запускает её и говорит по протоколу v1.
  kind: command
  command:
    argv: ${yamlList(options.argv)}
    protocolVersion: 1
    startupTimeoutMs: 30000
  tools: [read]
  environmentAllowlist: []
  network: allow
  sandbox: best-effort
instructions:
  agentsMd: AGENTS.md
# Что цикл улучшения может править. Всё, что не перечислено здесь, — ваш код.
harness:
  files: ${yamlList(options.harnessFiles)}
skills: []
# Инструменты и данные, которые уже лежали в папке: хост брокерует ровно их.
tools: ${yamlList(declared.tools)}
data: ${yamlList(declared.data)}
evalSuite:
  id: my-agent-development
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`;
}

const ADOPTED_AGENTS_MD = `# Агент

Программа запускается AHDE как дочерний процесс; сам код — ваш.

Правила поведения агента живут в файлах, перечисленных в \`manifest.yaml\` как
\`harness.files\`: именно их правит цикл улучшения.
`;

/**
 * The one case an adopted folder starts with.
 *
 * A dataset with no cases is not a dataset — `loadTarget` refuses one — so the
 * adoption has to write something, and what it used to write was two
 * `REPLACE-ME` stand-ins. Those are the marker `standInTargetFiles` looks for,
 * so the adopted Target was born carrying the warning «1 файл ещё с
 * подставными REPLACE-ME из шаблона», and in session 7 it was still on the
 * screen after the agent had been described, eight real cases had been written
 * and published, and a run had finished on them.
 *
 * What goes here instead is a real case with a real check: it says nothing
 * about the operator's agent, and it is honestly either passed or failed.
 * The Builder replaces the file wholesale when it publishes a corpus.
 */
const ADOPTED_DATASET = `${JSON.stringify({
	id: "example-001",
	input: "Ответь одним словом: готов.",
	graders: [{ type: "output_contains", text: "готов" }],
})}\n`;

const ADOPTED_GRADERS = `# Грейдеры для каждого кейса в evals/development.jsonl.
# Кейс может добавить свои в собственном массиве \`graders\`.
defaults: []
`;

function adoptionFiles(options: DescribeTargetWrapOptions): { path: string; content: string }[] {
	const projectDir = resolve(options.projectDir);
	const files = [
		{ path: "manifest.yaml", content: adoptedManifestText(options) },
		{ path: "evals/development.jsonl", content: ADOPTED_DATASET },
		{ path: "evals/graders.yaml", content: ADOPTED_GRADERS },
	];
	for (const optional of ADOPTION_OPTIONAL_FILES) {
		if (!existsSync(join(projectDir, optional))) files.push({ path: optional, content: ADOPTED_AGENTS_MD });
	}
	return files;
}

/**
 * The refusal that keeps adoption honest. Every required path is checked
 * BEFORE anything is written, so a folder that already holds an `evals/`
 * directory of its own is refused whole rather than half-adopted.
 */
function assertAdoptableProject(projectDirInput: string): string {
	const projectDir = resolve(projectDirInput);
	if (!existsSync(projectDir)) throw new Error(`target directory does not exist: ${projectDir}`);
	const root = lstatSync(projectDir);
	if (!root.isDirectory() || root.isSymbolicLink()) {
		throw new Error(`target directory must be a regular non-symlink directory: ${projectDir}`);
	}
	for (const required of ADOPTION_REQUIRED_FILES) {
		if (existsSync(join(projectDir, required))) {
			throw new Error(`target adoption would overwrite an existing ${required}; nothing was written`);
		}
	}
	return projectDir;
}

function inventoryOf(files: readonly { path: string; content: string }[]): TargetScaffoldFile[] {
	return [...files]
		.sort((left, right) => left.path.localeCompare(right.path))
		.map((file) => ({
			path: file.path,
			bytes: Buffer.byteLength(file.content, "utf8"),
			sha256: `sha256:${createHash("sha256").update(file.content, "utf8").digest("hex")}`,
		}));
}

function gitRun(directory: string, args: string[]): string {
	return execFileSync("git", ["-C", directory, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function isGitWorktreeRoot(directory: string): boolean {
	try {
		if (gitRun(directory, ["rev-parse", "--is-inside-work-tree"]) !== "true") return false;
		return realpathSync(gitRun(directory, ["rev-parse", "--show-toplevel"])) === realpathSync(directory);
	} catch {
		return false;
	}
}

/**
 * The exact adoption a trusted host must show and confirm. Pure: it computes
 * the bytes it would write and touches nothing.
 */
export function describeTargetWrap(options: DescribeTargetWrapOptions): TargetScaffoldSubject {
	const projectDir = assertAdoptableProject(options.projectDir);
	const files = adoptionFiles({ ...options, projectDir });
	const templateFiles = inventoryOf(files);
	const manifestText = files.find((file) => file.path === "manifest.yaml")?.content ?? "";
	const manifest = TargetManifest.parse(parseYaml(manifestText));
	const existing = isGitWorktreeRoot(projectDir);
	return TargetScaffoldSubjectSchema.parse({
		schemaVersion: 2,
		operation: "adopt-current-directory",
		targetPath: projectDir,
		targetId: manifest.id,
		templateFiles,
		templateHash: hashValue(templateFiles),
		manifest,
		found: options.found,
		generated: {
			gitRepository: existing
				? "the existing clean repository, at its current HEAD"
				: "fresh repository with one scaffold commit",
			// Exactly the rules this folder is missing. A folder that already
			// ignores `runs/` its own way keeps its own spelling.
			localArtifactIgnores: missingLocalArtifactIgnores(projectDir),
		},
	});
}

/**
 * Adopt the folder. Writes only what `describeTargetWrap` promised, commits
 * it, and publishes the same immutable receipt a scaffold publishes — which is
 * what lets invariant 18 name an adopted revision the way it names a scaffold.
 */
export function applyTargetWrap(
	options: ApplyTargetWrapOptions,
	dependencies: Partial<TargetScaffoldDependencies> = {},
): TargetScaffoldResult {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	// The replay guard runs FIRST. A second adoption of the same folder would
	// otherwise be refused for a name collision — true, but the wrong sentence:
	// the reason is that this folder was already adopted, and the receipt says
	// when and by whom.
	const stateRoot = resolve(options.stateRoot);
	if (!existsSync(stateRoot)) mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	const stateEntry = lstatSync(stateRoot);
	if (!stateEntry.isDirectory() || stateEntry.isSymbolicLink()) {
		throw new Error("target adoption state root must be a regular non-symlink directory");
	}
	const receiptPath = join(stateRoot, RECEIPT_FILENAME);
	if (existsSync(receiptPath)) throw new Error("target scaffold receipt already exists; replay refused");

	const subject = describeTargetWrap(options);
	if (hashValue(subject) !== options.expectedSubjectHash) throw new Error("target adoption subject changed after review");
	const actor = options.actor.id.trim();
	const reason = options.reason.trim();
	if (!actor || actor.length > 256) throw new Error("target adoption actor identity must be bounded and non-blank");
	if (!reason || reason.length > 4_000) throw new Error("target adoption reason must be bounded and non-blank");

	const projectDir = resolve(options.projectDir);
	const existingRepository = isGitWorktreeRoot(projectDir);
	// A dirty repository cannot be adopted: the receipt would name a revision
	// that does not describe what is actually on disk.
	if (existingRepository && gitRun(projectDir, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
		throw new Error("target adoption requires a clean repository; commit or stash first");
	}
	const files = adoptionFiles({ ...options, projectDir });
	const written: string[] = [];
	try {
		for (const file of files) {
			const path = join(projectDir, file.path);
			if (existsSync(path)) throw new Error(`target adoption would overwrite ${file.path}; nothing further was written`);
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, file.content, { encoding: "utf8", flag: "wx" });
			written.push(file.path);
		}
		const addedIgnores = ensureLocalArtifactIgnores(projectDir);
		if (addedIgnores.length > 0) written.push(".gitignore");
		if (canonicalJson(subject.generated.localArtifactIgnores) !== canonicalJson(addedIgnores)) {
			throw new Error("target adoption .gitignore rules changed after review");
		}
		if (!existingRepository) {
			execFileSync("git", ["-C", projectDir, "init", "-q"], { stdio: ["ignore", "pipe", "pipe"] });
			execFileSync("git", ["-C", projectDir, "add", "."], { stdio: ["ignore", "pipe", "pipe"] });
			execFileSync("git", [
				"-C", projectDir,
				"-c", "user.name=ahde", "-c", "user.email=ahde@local",
				"commit", "-qm", "adopt existing agent as an AHDE target",
			], { stdio: ["ignore", "pipe", "pipe"] });
		} else {
			execFileSync("git", ["-C", projectDir, "add", "--", ...written], { stdio: ["ignore", "pipe", "pipe"] });
			execFileSync("git", [
				"-C", projectDir,
				"-c", "user.name=ahde", "-c", "user.email=ahde@local",
				"commit", "-qm", "adopt existing agent as an AHDE target", "--", ...written,
			], { stdio: ["ignore", "pipe", "pipe"] });
		}
		const target = deps.load(projectDir);
		if (target.manifest.id !== subject.targetId) {
			throw new Error(`adopted target id mismatch: expected ${subject.targetId}, got ${target.manifest.id}`);
		}
		if (!/^[0-9a-f]{40}$/.test(target.gitSha)) throw new Error("an adopted target must resolve to one clean Git revision");
		const receiptIdentity = {
			schemaVersion: 1 as const,
			subject,
			subjectHash: hashValue(subject),
			targetGitSha: target.gitSha,
			actor: { kind: "human" as const, id: actor },
			reason,
			scaffoldedAt: deps.now(),
		};
		const receipt = TargetScaffoldReceiptSchema.parse({
			...receiptIdentity,
			id: `target-scaffold-${hashValue(receiptIdentity).slice("sha256:".length)}`,
		});
		deps.writeReceipt(receiptPath, receipt);
		return { subject, receipt, receiptPath, target };
	} catch (error) {
		// Only files this operation created are removed. Nothing the operator
		// wrote is ever a candidate for cleanup, which is why `written` lists
		// exactly what was created and `.gitignore` is appended to, not replaced.
		for (const path of written) {
			if (path === ".gitignore") continue;
			try {
				unlinkSync(join(projectDir, path));
			} catch {}
		}
		throw error;
	}
}
