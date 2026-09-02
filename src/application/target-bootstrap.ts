import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument, parse as parseYaml } from "yaml";
import { z } from "zod";
import { loadTarget, ModelBlock, TargetManifest, type TargetManifest as TargetManifestValue } from "../manifest.js";
import { canonicalJson, hashValue } from "../provenance.js";
import { isStandIn, isStandInModel, standInManifestFields } from "../target/placeholders.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";

const BUILTIN_TARGET_ID = "my-agent";
const BUILTIN_EVAL_SUITE_ID = "my-agent-development";
const BUILTIN_MODEL_ID = "replace-with-model-id";
const RECEIPT_FILENAME = "target-bootstrap.json";
const LOCK_FILENAME = ".target-bootstrap.lock";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_DIRECTORIES = 20_000;

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const GitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const TimestampSchema = z.iso.datetime({ offset: true });
const NonBlankSchema = z.string().min(1).refine((value) => value.trim().length > 0, "expected non-blank text");
const TargetIdSchema = z.string().max(100).regex(/^[a-z0-9][a-z0-9-]*$/, "target id must be lowercase kebab-case");
const HumanActorSchema = z.strictObject({ kind: z.literal("human"), id: NonBlankSchema.max(256) });
const ReasonSchema = NonBlankSchema.max(4_000);

const BUILTIN_PLACEHOLDER_MODEL = ModelBlock.parse({
	provider: "openai-compatible",
	id: BUILTIN_MODEL_ID,
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:1234/v1",
	apiKeyEnv: "AHDE_MODEL_API_KEY",
	thinkingLevel: "off",
	timeoutMs: 300000,
});

const ManifestIdentitySchema = z.strictObject({
	targetId: TargetIdSchema,
	model: ModelBlock,
	evalSuiteId: NonBlankSchema.max(200),
	manifestSha256: Sha256Schema,
});

export const TargetBootstrapSubjectSchema = z.strictObject({
	schemaVersion: z.literal(1),
	baseTargetSha: GitShaSchema,
	previous: ManifestIdentitySchema,
	next: ManifestIdentitySchema,
	unifiedDiff: NonBlankSchema.max(MAX_MANIFEST_BYTES * 3),
	subjectHash: Sha256Schema,
}).superRefine((subject, context) => {
	const { subjectHash: _subjectHash, ...identity } = subject;
	if (subject.subjectHash !== hashValue(identity)) {
		context.addIssue({ code: "custom", path: ["subjectHash"], message: "does not match the exact bootstrap subject" });
	}
});
export type TargetBootstrapSubject = z.infer<typeof TargetBootstrapSubjectSchema>;

const ReceiptIdSchema = z.string().regex(/^target-bootstrap-[0-9a-f]{64}$/);

export const TargetBootstrapReceiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	id: ReceiptIdSchema,
	subject: TargetBootstrapSubjectSchema,
	baseTargetSha: GitShaSchema,
	configuredTargetSha: GitShaSchema,
	actor: HumanActorSchema,
	reason: ReasonSchema,
	configuredAt: TimestampSchema,
}).superRefine((receipt, context) => {
	if (receipt.baseTargetSha !== receipt.subject.baseTargetSha) {
		context.addIssue({ code: "custom", path: ["baseTargetSha"], message: "must match the approved subject" });
	}
	const { id: _id, ...identity } = receipt;
	const expected = `target-bootstrap-${hashValue(identity).slice("sha256:".length)}`;
	if (receipt.id !== expected) {
		context.addIssue({ code: "custom", path: ["id"], message: "does not match the exact receipt evidence" });
	}
});
export type TargetBootstrapReceipt = z.infer<typeof TargetBootstrapReceiptSchema>;

export interface DescribeTargetBootstrapOptions {
	targetDir: string;
	stateRoot: string;
	runsRoot: string;
	targetId: string;
	/** A complete non-secret model definition; credentials are referenced only by apiKeyEnv. */
	model: unknown;
}

export interface ConfigureTargetBootstrapOptions extends DescribeTargetBootstrapOptions {
	expectedSubjectHash: string;
	actor: { kind: "human"; id: string };
	reason: string;
}

export interface TargetBootstrapResult {
	subject: TargetBootstrapSubject;
	receipt: TargetBootstrapReceipt;
	receiptPath: string;
	manifest: TargetManifestValue;
}

export interface TargetBootstrapDependencies {
	now: () => string;
	writeReceipt: (path: string, receipt: TargetBootstrapReceipt) => void;
}

const DEFAULT_DEPENDENCIES: TargetBootstrapDependencies = {
	now: () => new Date().toISOString(),
	writeReceipt: (path, receipt) => writeJsonArtifact(path, TargetBootstrapReceiptSchema, receipt, { immutable: true }),
};

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function gitText(repositoryDir: string, args: string[], env?: NodeJS.ProcessEnv): string {
	return execFileSync("git", ["-C", repositoryDir, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 16 * 1024 * 1024,
		env,
	}).trim();
}

function gitStatus(repositoryDir: string, args: string[]): number | null {
	return spawnSync("git", ["-C", repositoryDir, ...args], { stdio: "ignore" }).status;
}

function repositoryRoot(input: string): string {
	const requested = resolve(input);
	const entry = lstatSync(requested);
	if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`targetDir must be a regular non-symlink directory: ${requested}`);
	const canonical = realpathSync(requested);
	const top = realpathSync(gitText(canonical, ["rev-parse", "--show-toplevel"]));
	if (top !== canonical) throw new Error(`targetDir must be the Git worktree root: ${canonical}`);
	return canonical;
}

function assertCleanScaffoldRepository(repositoryDir: string): { baseTargetSha: string; headRef: string } {
	const status = gitText(repositoryDir, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (status !== "") throw new Error("Target bootstrap requires a clean repository");
	const baseTargetSha = GitShaSchema.parse(gitText(repositoryDir, ["rev-parse", "HEAD"]));
	if (gitText(repositoryDir, ["rev-list", "--count", "HEAD"]) !== "1") {
		throw new Error("Target bootstrap is allowed only on the one-commit scaffold revision");
	}
	let headRef: string;
	try {
		headRef = gitText(repositoryDir, ["symbolic-ref", "-q", "HEAD"]);
	} catch (error) {
		throw new Error("Target bootstrap requires the scaffold branch, not a detached HEAD", { cause: error });
	}
	if (!headRef.startsWith("refs/heads/")) throw new Error("Target bootstrap requires a local branch");
	const manifestEntry = gitText(repositoryDir, ["ls-files", "-s", "--", "manifest.yaml"]);
	if (!/^100644 [0-9a-f]{40} 0\tmanifest\.yaml$/.test(manifestEntry)) {
		throw new Error("Scaffold manifest.yaml must be one tracked regular 100644 file");
	}
	return { baseTargetSha, headRef };
}

function stateRootPath(input: string, create: boolean): string {
	const requested = resolve(input);
	if (!existsSync(requested)) {
		if (!create) return requested;
		mkdirSync(requested, { recursive: true, mode: 0o700 });
	}
	const entry = lstatSync(requested);
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new Error(`Target bootstrap stateRoot must be a regular non-symlink directory: ${requested}`);
	}
	if (create) chmodSync(requested, 0o700);
	return realpathSync(requested);
}

function assertStateRootDoesNotDirtyTarget(repositoryDir: string, stateRoot: string): void {
	const state = resolve(stateRoot);
	if (!contained(repositoryDir, state)) return;
	const relativeState = relative(repositoryDir, state) || ".";
	if (gitStatus(repositoryDir, ["check-ignore", "-q", "--", relativeState]) !== 0) {
		throw new Error("An in-repository Target bootstrap stateRoot must be ignored by Git");
	}
}

function receiptPath(stateRoot: string, create: boolean): string {
	return join(stateRootPath(stateRoot, create), RECEIPT_FILENAME);
}

function assertPrivateReceipt(path: string): void {
	const entry = lstatSync(path);
	if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Target bootstrap receipt must be a regular non-symlink file");
	const mode = statSync(path).mode & 0o777;
	if (mode !== 0o600) throw new Error(`Target bootstrap receipt must have mode 0600, got 0${mode.toString(8)}`);
}

function assertNoReceipt(stateRoot: string): void {
	const path = receiptPath(stateRoot, false);
	if (!existsSync(path)) return;
	assertPrivateReceipt(path);
	throw new Error("Target bootstrap receipt already exists; replay refused");
}

/** Content identity of one manifest revision. Shared with the evaluator flow. */
export function sha256(content: string | Buffer): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const REQUIRED_MODEL_KEYS = [
	"provider", "id", "api", "baseUrl", "apiKeyEnv", "thinkingLevel", "timeoutMs", "params", "spec",
] as const;
const REQUIRED_MODEL_SPEC_KEYS = ["reasoning", "contextWindow", "maxTokens", "cost", "compat"] as const;
const REQUIRED_COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const CREDENTIAL_FIELD_KEYS = new Set(["apikey", "secret", "token", "password", "credential", "authorization", "auth"]);

function assertNoCredentialValue(value: unknown, path = "model"): void {
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) assertNoCredentialValue(item, `${path}[${index}]`);
		return;
	}
	if (!isPlainObject(value)) return;
	for (const [key, child] of Object.entries(value)) {
		const normalized = key.toLowerCase().replace(/[-_]/g, "");
		if (!(path === "model" && key === "apiKeyEnv") && CREDENTIAL_FIELD_KEYS.has(normalized)) {
			throw new Error(`${path}.${key} is a credential value field; Target bootstrap accepts only apiKeyEnv`);
		}
		assertNoCredentialValue(child, `${path}.${key}`);
	}
}

function requireOwnKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	const missing = keys.filter((key) => !Object.hasOwn(value, key));
	if (missing.length > 0) throw new Error(`${label} must be complete; missing ${missing.join(", ")}`);
}

function parseFullModel(value: unknown): TargetManifestValue["model"] {
	if (!isPlainObject(value)) throw new Error("model must be a complete object");
	requireOwnKeys(value, REQUIRED_MODEL_KEYS, "model");
	if (!isPlainObject(value.spec)) throw new Error("model.spec must be a complete object");
	requireOwnKeys(value.spec, REQUIRED_MODEL_SPEC_KEYS, "model.spec");
	if (!isPlainObject(value.spec.cost)) throw new Error("model.spec.cost must be a complete object");
	requireOwnKeys(value.spec.cost, REQUIRED_COST_KEYS, "model.spec.cost");
	assertNoCredentialValue(value);
	const model = ModelBlock.parse(value);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(model.apiKeyEnv)) {
		throw new Error("model.apiKeyEnv must be an environment variable name");
	}
	const endpoint = new URL(model.baseUrl);
	if (endpoint.username || endpoint.password) throw new Error("model.baseUrl cannot contain credentials");
	if (model.id === BUILTIN_MODEL_ID) throw new Error("Target bootstrap model id must replace the built-in placeholder");
	// The chosen model comes from the trusted host catalog, so a stand-in here
	// would be a bug upstream rather than an operator's choice; say so instead of
	// committing a manifest that reads as unconfigured the moment it is written.
	if (isStandInModel(model) || isStandIn(model.apiKeyEnv)) {
		throw new Error("Target bootstrap model must replace the template's REPLACE-ME stand-ins");
	}
	return model;
}

function parseManifestText(content: string, label: string): TargetManifestValue {
	if (Buffer.byteLength(content, "utf8") > MAX_MANIFEST_BYTES) throw new Error(`${label} exceeds ${MAX_MANIFEST_BYTES} bytes`);
	let parsed: unknown;
	try {
		parsed = parseYaml(content);
	} catch (error) {
		throw new Error(`${label} is invalid YAML`, { cause: error });
	}
	const result = TargetManifest.safeParse(parsed);
	if (!result.success) throw new Error(`${label}: ${result.error.message}`);
	return result.data;
}

/**
 * Two manifests are "nobody has configured this yet", and bootstrap accepts
 * exactly those two.
 *
 * The first is the built-in scaffold, byte for byte. The second is a template
 * that still writes `REPLACE-ME` where its identity or its model belongs — the
 * support-agent scaffold and anything shaped like it. Admitting the second
 * costs nothing the guarantee cares about: what this check protects is that a
 * one-time bootstrap can never silently reconfigure a REAL model out from under
 * an operator, and a `REPLACE-ME` model is not one. It cannot be called, it was
 * never chosen, and leaving it out is what used to force the operator into
 * manifest.yaml by hand.
 */
function assertBuiltInPlaceholder(manifest: TargetManifestValue): void {
	const builtIn =
		manifest.id === BUILTIN_TARGET_ID &&
		manifest.evalSuite.id === BUILTIN_EVAL_SUITE_ID &&
		canonicalJson(manifest.model) === canonicalJson(BUILTIN_PLACEHOLDER_MODEL);
	if (builtIn || standInManifestFields(manifest).length > 0) return;
	throw new Error("Target bootstrap requires the untouched built-in id/model placeholders");
}

function renderConfiguredManifest(
	baseText: string,
	targetId: string,
	model: TargetManifestValue["model"],
): { text: string; manifest: TargetManifestValue } {
	const document = parseDocument(baseText);
	if (document.errors.length > 0) throw new Error(`manifest.yaml: ${document.errors[0]?.message ?? "invalid YAML"}`);
	document.set("id", targetId);
	document.set("model", model);
	document.setIn(["evalSuite", "id"], `${targetId}-development`);
	const text = document.toString({ lineWidth: 0 });
	const manifest = parseManifestText(text, "configured manifest.yaml");
	return { text, manifest };
}

function wholeFileDiff(path: string, before: string, after: string): string {
	const oldLines = before.replace(/\n$/, "").split("\n");
	const newLines = after.replace(/\n$/, "").split("\n");
	return [
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		`@@ -1,${oldLines.length} +1,${newLines.length} @@`,
		...oldLines.map((line) => `-${line}`),
		...newLines.map((line) => `+${line}`),
	].join("\n");
}

function evidenceJson(path: string): unknown {
	const entry = lstatSync(path);
	if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Target evidence must be a regular file: ${path}`);
	if (entry.size > MAX_EVIDENCE_BYTES) throw new Error(`Target evidence exceeds ${MAX_EVIDENCE_BYTES} bytes: ${path}`);
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		throw new Error(`Target evidence is invalid JSON: ${path}`, { cause: error });
	}
}

function evidenceDirectories(root: string, prefix?: string): string[] {
	if (!existsSync(root)) return [];
	const entry = lstatSync(root);
	if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Target evidence root must be a regular directory: ${root}`);
	const names = readdirSync(root).filter((name) => !prefix || name.startsWith(prefix));
	if (names.length > MAX_EVIDENCE_DIRECTORIES) throw new Error("Target evidence directory count exceeds the bootstrap inspection limit");
	return names.filter((name) => {
		const child = lstatSync(join(root, name));
		if (child.isSymbolicLink()) throw new Error(`Target evidence must not traverse a symlink: ${join(root, name)}`);
		return child.isDirectory();
	});
}

function objectAt(value: unknown, key: string): Record<string, unknown> | null {
	if (!isPlainObject(value)) return null;
	const child = value[key];
	return isPlainObject(child) ? child : null;
}

function assertNoPriorEvidence(runsRootInput: string, targetId: string, baseTargetSha: string): void {
	const runsRoot = resolve(runsRootInput);
	if (!existsSync(runsRoot)) return;
	const rootEntry = lstatSync(runsRoot);
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) throw new Error(`runsRoot must be a regular non-symlink directory: ${runsRoot}`);

	for (const id of evidenceDirectories(runsRoot, "erun_")) {
		const path = join(runsRoot, id, "eval_run.json");
		if (!existsSync(path)) continue;
		const target = objectAt(evidenceJson(path), "target");
		if (target?.id === targetId && target.gitSha === baseTargetSha) {
			throw new Error(`Target bootstrap refused because eval evidence already exists: ${id}`);
		}
	}

	const buildersRoot = join(runsRoot, "builders");
	for (const id of evidenceDirectories(buildersRoot)) {
		const path = join(buildersRoot, id, "apply_receipt.json");
		if (!existsSync(path)) continue;
		const receipt = evidenceJson(path);
		if (
			isPlainObject(receipt) &&
			(receipt.baseTargetSha === baseTargetSha || receipt.candidateSha === baseTargetSha)
		) {
			throw new Error(`Target bootstrap refused because Builder apply evidence already exists: ${id}`);
		}
	}

	const candidatesRoot = join(runsRoot, "candidates");
	for (const id of evidenceDirectories(candidatesRoot)) {
		const path = join(candidatesRoot, id, "candidate.json");
		if (!existsSync(path)) continue;
		const candidate = evidenceJson(path);
		const baseline = objectAt(candidate, "baseline");
		if (isPlainObject(candidate) && candidate.targetId === targetId && baseline?.sha === baseTargetSha) {
			throw new Error(`Target bootstrap refused because Candidate evidence already exists: ${id}`);
		}
	}
}

interface PreparedBootstrap {
	repositoryDir: string;
	baseTargetSha: string;
	headRef: string;
	baseText: string;
	configuredText: string;
	manifest: TargetManifestValue;
	subject: TargetBootstrapSubject;
}

function prepareBootstrap(options: DescribeTargetBootstrapOptions): PreparedBootstrap {
	const repositoryDir = repositoryRoot(options.targetDir);
	assertNoReceipt(options.stateRoot);
	const { baseTargetSha, headRef } = assertCleanScaffoldRepository(repositoryDir);
	const target = loadTarget(repositoryDir);
	if (target.gitSha !== baseTargetSha) throw new Error("Target bootstrap requires the exact clean HEAD target");
	assertBuiltInPlaceholder(target.manifest);
	assertNoPriorEvidence(options.runsRoot, target.manifest.id, baseTargetSha);

	const targetId = TargetIdSchema.parse(options.targetId);
	if (targetId === BUILTIN_TARGET_ID) throw new Error("Target bootstrap must replace the built-in target id");
	const model = parseFullModel(options.model);
	const manifestPath = join(repositoryDir, "manifest.yaml");
	const manifestEntry = lstatSync(manifestPath);
	if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink()) throw new Error("manifest.yaml must be a regular non-symlink file");
	const baseText = readFileSync(manifestPath, "utf8");
	const parsedBase = parseManifestText(baseText, "manifest.yaml");
	if (canonicalJson(parsedBase) !== canonicalJson(target.manifest)) throw new Error("Resolved target manifest differs from manifest.yaml");
	const configured = renderConfiguredManifest(baseText, targetId, model);

	for (const field of ["execution", "instructions", "skills", "tools"] as const) {
		if (canonicalJson(configured.manifest[field]) !== canonicalJson(parsedBase[field])) {
			throw new Error(`Target bootstrap unexpectedly changed manifest.${field}`);
		}
	}
	const previousEval = { ...parsedBase.evalSuite, id: undefined };
	const nextEval = { ...configured.manifest.evalSuite, id: undefined };
	if (canonicalJson(previousEval) !== canonicalJson(nextEval)) {
		throw new Error("Target bootstrap unexpectedly changed evalSuite inputs, graders, or judge");
	}

	const identity = {
		schemaVersion: 1 as const,
		baseTargetSha,
		previous: {
			targetId: parsedBase.id,
			model: parsedBase.model,
			evalSuiteId: parsedBase.evalSuite.id,
			manifestSha256: sha256(baseText),
		},
		next: {
			targetId: configured.manifest.id,
			model: configured.manifest.model,
			evalSuiteId: configured.manifest.evalSuite.id,
			manifestSha256: sha256(configured.text),
		},
		unifiedDiff: wholeFileDiff("manifest.yaml", baseText, configured.text),
	};
	const subject = TargetBootstrapSubjectSchema.parse({ ...identity, subjectHash: hashValue(identity) });
	return {
		repositoryDir,
		baseTargetSha,
		headRef,
		baseText,
		configuredText: configured.text,
		manifest: configured.manifest,
		subject,
	};
}

/** Build the exact immutable subject a trusted host must show and confirm. */
export function describeTargetBootstrap(options: DescribeTargetBootstrapOptions): TargetBootstrapSubject {
	return prepareBootstrap(options).subject;
}

function restoreManifestRevision(
	prepared: PreparedBootstrap,
	configuredTargetSha: string | null,
): void {
	if (configuredTargetSha !== null) {
		execFileSync("git", [
			"-C", prepared.repositoryDir,
			"update-ref", "-m", "AHDE bootstrap receipt rollback",
			prepared.headRef, prepared.baseTargetSha, configuredTargetSha,
		], { stdio: ["ignore", "pipe", "pipe"] });
	}
	writeFileSync(join(prepared.repositoryDir, "manifest.yaml"), prepared.baseText, "utf8");
	execFileSync("git", ["-C", prepared.repositoryDir, "add", "--", "manifest.yaml"], { stdio: ["ignore", "pipe", "pipe"] });
	if (gitText(prepared.repositoryDir, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
		throw new Error("Target bootstrap rollback did not restore the exact clean scaffold");
	}
}

function exactBootstrapCommit(prepared: PreparedBootstrap, revision: string): boolean {
	try {
		if (gitText(prepared.repositoryDir, ["rev-parse", `${revision}^`]) !== prepared.baseTargetSha) return false;
		const paths = gitText(prepared.repositoryDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", revision])
			.split("\0").filter(Boolean);
		if (paths.length !== 1 || paths[0] !== "manifest.yaml") return false;
		return sha256(execFileSync("git", ["-C", prepared.repositoryDir, "show", `${revision}:manifest.yaml`])) ===
			prepared.subject.next.manifestSha256;
	} catch {
		return false;
	}
}

/**
 * Apply one exact, host-confirmed bootstrap configuration and publish its
 * immutable receipt. This service accepts no model credential value.
 */
export function configureTargetBootstrap(
	options: ConfigureTargetBootstrapOptions,
	dependencies: Partial<TargetBootstrapDependencies> = {},
): TargetBootstrapResult {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	const expectedSubjectHash = Sha256Schema.parse(options.expectedSubjectHash);
	const actor = HumanActorSchema.parse(options.actor);
	const reason = ReasonSchema.parse(options.reason);
	const repositoryDir = repositoryRoot(options.targetDir);
	assertStateRootDoesNotDirtyTarget(repositoryDir, options.stateRoot);
	const stateRoot = stateRootPath(options.stateRoot, true);
	const path = join(stateRoot, RECEIPT_FILENAME);
	if (existsSync(path)) {
		assertPrivateReceipt(path);
		throw new Error("Target bootstrap receipt already exists; replay refused");
	}
	const lockPath = join(stateRoot, LOCK_FILENAME);
	let lock: number;
	try {
		lock = openSync(lockPath, "wx", 0o600);
	} catch (error) {
		throw new Error("Target bootstrap is already in progress", { cause: error });
	}

	try {
		const prepared = prepareBootstrap({ ...options, targetDir: repositoryDir, stateRoot });
		if (prepared.subject.subjectHash !== expectedSubjectHash) {
			throw new Error("Target bootstrap subject changed after review; confirmation is stale");
		}
		if (gitText(repositoryDir, ["rev-parse", "HEAD"]) !== prepared.baseTargetSha) {
			throw new Error("Target bootstrap HEAD changed after subject validation");
		}

		const manifestPath = join(repositoryDir, "manifest.yaml");
		const hooksPath = mkdtempSync(join(tmpdir(), "ahde-bootstrap-hooks-"));
		let configuredTargetSha: string | null = null;
		let receiptPublished = false;
		let receiptWriteReturned = false;
		try {
			writeFileSync(manifestPath, prepared.configuredText, "utf8");
			execFileSync("git", ["-C", repositoryDir, "add", "--", "manifest.yaml"], { stdio: ["ignore", "pipe", "pipe"] });
			const staged = gitText(repositoryDir, ["diff", "--cached", "--name-only", "-z", "--"])
				.split("\0").filter(Boolean);
			if (staged.length !== 1 || staged[0] !== "manifest.yaml") {
				throw new Error(`Target bootstrap staged unexpected paths: ${staged.join(", ")}`);
			}
			if (sha256(readFileSync(manifestPath)) !== prepared.subject.next.manifestSha256) {
				throw new Error("Target bootstrap manifest bytes differ from the confirmed subject");
			}

			const configuredAt = TimestampSchema.parse(deps.now());
			const identityEnvironment: NodeJS.ProcessEnv = {
				...process.env,
				GIT_AUTHOR_NAME: "AHDE Bootstrap",
				GIT_AUTHOR_EMAIL: "bootstrap@ahde.local",
				GIT_COMMITTER_NAME: "AHDE Bootstrap",
				GIT_COMMITTER_EMAIL: "bootstrap@ahde.local",
				GIT_AUTHOR_DATE: configuredAt,
				GIT_COMMITTER_DATE: configuredAt,
			};
			execFileSync("git", [
				"-C", repositoryDir,
				"-c", `core.hooksPath=${hooksPath}`,
				"-c", "commit.gpgSign=false",
				"commit", "--no-verify", "--no-gpg-sign", "-m", "Configure AHDE target",
			], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: identityEnvironment });
			configuredTargetSha = GitShaSchema.parse(gitText(repositoryDir, ["rev-parse", "HEAD"]));
			if (gitText(repositoryDir, ["rev-parse", "HEAD^"]) !== prepared.baseTargetSha) {
				throw new Error("Target bootstrap commit parent differs from the confirmed base");
			}
			const committedPaths = gitText(repositoryDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"])
				.split("\0").filter(Boolean);
			if (committedPaths.length !== 1 || committedPaths[0] !== "manifest.yaml") {
				throw new Error("Target bootstrap commit contains paths other than manifest.yaml");
			}
			if (sha256(execFileSync("git", ["-C", repositoryDir, "show", "HEAD:manifest.yaml"])) !== prepared.subject.next.manifestSha256) {
				throw new Error("Target bootstrap commit manifest differs from the confirmed subject");
			}
			if (gitText(repositoryDir, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
				throw new Error("Target bootstrap commit did not leave a clean repository");
			}

			const receiptIdentity = {
				schemaVersion: 1 as const,
				subject: prepared.subject,
				baseTargetSha: prepared.baseTargetSha,
				configuredTargetSha,
				actor,
				reason,
				configuredAt,
			};
			const receipt = TargetBootstrapReceiptSchema.parse({
				...receiptIdentity,
				id: `target-bootstrap-${hashValue(receiptIdentity).slice("sha256:".length)}`,
			});
			deps.writeReceipt(path, receipt);
			receiptWriteReturned = true;
			assertPrivateReceipt(path);
			const persistedReceipt = readJsonArtifact(path, TargetBootstrapReceiptSchema);
			if (canonicalJson(persistedReceipt) !== canonicalJson(receipt)) {
				throw new Error("Published Target bootstrap receipt differs from the committed configuration");
			}
			receiptPublished = true;
			return { subject: prepared.subject, receipt, receiptPath: path, manifest: prepared.manifest };
		} catch (error) {
			if (!receiptPublished) {
				try {
					const current = gitText(repositoryDir, ["rev-parse", "HEAD"]);
					const rollbackRevision = configuredTargetSha ?? (
						current !== prepared.baseTargetSha && exactBootstrapCommit(prepared, current)
							? current
							: null
					);
					if (current !== prepared.baseTargetSha && rollbackRevision === null) {
						throw new Error("Target HEAD changed concurrently; refusing to roll back an unrecognized revision");
					}
					if (receiptWriteReturned && existsSync(path)) unlinkSync(path);
					restoreManifestRevision(
						prepared,
						rollbackRevision,
					);
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "Target bootstrap and narrow rollback both failed");
				}
			}
			throw error;
		} finally {
			rmSync(hooksPath, { recursive: true, force: true });
		}
	} finally {
		closeSync(lock!);
		try {
			unlinkSync(lockPath);
		} catch {}
	}
}

/** Load and verify the one-time private bootstrap receipt. */
export function loadTargetBootstrapReceipt(stateRoot: string): TargetBootstrapReceipt {
	const path = receiptPath(stateRoot, false);
	if (!existsSync(path)) throw new Error("Target bootstrap receipt does not exist");
	assertPrivateReceipt(path);
	return readJsonArtifact(path, TargetBootstrapReceiptSchema);
}
