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
	statSync,
	unlinkSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { loadTarget, scaffoldTarget, TargetManifest, type ResolvedTarget } from "../manifest.js";
import { canonicalJson, hashValue } from "../provenance.js";
import { writeJsonArtifact } from "../storage/artifacts.js";

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

export const TargetScaffoldSubjectSchema = z.strictObject({
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
export type TargetScaffoldSubject = z.infer<typeof TargetScaffoldSubjectSchema>;

export const TargetScaffoldReceiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	id: z.string().regex(/^target-scaffold-[0-9a-f]{64}$/),
	subject: TargetScaffoldSubjectSchema,
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
		schemaVersion: 1,
		operation: "initialize-current-directory",
		targetPath: resolve(options.projectDir),
		targetId: manifest.id,
		templateFiles,
		templateHash: hashValue(templateFiles),
		manifest,
		generated: {
			gitRepository: "fresh repository with one scaffold commit",
			localArtifactIgnores: ["/.ahde/", "/imports/", "/runs/", "/.env", "/.env.*", "!/.env.example"],
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
