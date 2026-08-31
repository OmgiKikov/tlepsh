/**
 * Configuring the two models AHDE measures WITH, without editing YAML.
 *
 * `configure-target` chooses the model under test. This chooses the judge that
 * grades it and the model that plays the user talking to it — the other half of
 * every measurement, and until now the half that only existed if the operator
 * hand-wrote `evalSuite.judge` into `manifest.yaml`.
 *
 * The shape is deliberately the same as the Target bootstrap: the Builder sends
 * a bounded, non-secret selection; the trusted host resolves it against its own
 * model catalog; the credential is named, never valued, and the name comes from
 * the host UI rather than from anything a model wrote; the exact manifest diff
 * is shown; and one reviewed commit lands with an immutable receipt beside it.
 *
 * The one rule this flow has that the Target bootstrap does not: a judge may
 * not be the Target model. A model grading its own twin agrees with itself, and
 * an agreement number produced that way is not calibration — it is an echo.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
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
import {
	JudgeModelBlock,
	SimulatedUserModelBlock,
	TargetManifest,
	type TargetManifest as TargetManifestValue,
} from "../manifest.js";
import { canonicalJson, hashValue } from "../provenance.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import { sha256 } from "./target-bootstrap.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const RECEIPT_DIRECTORY = "evaluators";
const CONFIGURATION_LOCK = ".configure-evaluators.lock";

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const GitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const TimestampSchema = z.iso.datetime({ offset: true });
const NonBlankSchema = z.string().min(1).refine((value) => value.trim().length > 0, "expected non-blank text");
const HumanActorSchema = z.strictObject({ kind: z.literal("human"), id: NonBlankSchema.max(256) });
const ReasonSchema = NonBlankSchema.max(4_000);

/** Both evaluator blocks as the manifest holds them; null means unconfigured. */
const EvaluatorBlocksSchema = z.strictObject({
	judge: JudgeModelBlock.nullable(),
	simulatedUser: SimulatedUserModelBlock.nullable(),
});
export type EvaluatorBlocks = z.infer<typeof EvaluatorBlocksSchema>;

export const EvaluatorConfigurationSubjectSchema = z.strictObject({
	schemaVersion: z.literal(1),
	targetId: NonBlankSchema.max(100),
	baseTargetSha: GitShaSchema,
	/** The Target model, so the dialog can show what the judge must not be. */
	targetModel: z.strictObject({ provider: NonBlankSchema, id: NonBlankSchema }),
	previous: EvaluatorBlocksSchema.extend({ manifestSha256: Sha256Schema }),
	next: EvaluatorBlocksSchema.extend({ manifestSha256: Sha256Schema }),
	unifiedDiff: NonBlankSchema.max(MAX_MANIFEST_BYTES * 3),
	subjectHash: Sha256Schema,
}).superRefine((subject, context) => {
	const { subjectHash: _subjectHash, ...identity } = subject;
	if (subject.subjectHash !== hashValue(identity)) {
		context.addIssue({ code: "custom", path: ["subjectHash"], message: "does not match the exact evaluator subject" });
	}
});
export type EvaluatorConfigurationSubject = z.infer<typeof EvaluatorConfigurationSubjectSchema>;

const ReceiptIdSchema = z.string().regex(/^configure-evaluators-[0-9a-f]{64}$/);

export const EvaluatorConfigurationReceiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	id: ReceiptIdSchema,
	subject: EvaluatorConfigurationSubjectSchema,
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
	const expected = `configure-evaluators-${hashValue(identity).slice("sha256:".length)}`;
	if (receipt.id !== expected) {
		context.addIssue({ code: "custom", path: ["id"], message: "does not match the exact receipt evidence" });
	}
});
export type EvaluatorConfigurationReceipt = z.infer<typeof EvaluatorConfigurationReceiptSchema>;

export interface DescribeEvaluatorConfigurationOptions {
	targetDir: string;
	stateRoot: string;
	/**
	 * Complete non-secret model definitions the trusted host resolved. Absent
	 * means "leave this block exactly as it is"; at least one must be present.
	 */
	judge?: unknown;
	simulatedUser?: unknown;
}

export interface ConfigureEvaluatorsOptions extends DescribeEvaluatorConfigurationOptions {
	expectedSubjectHash: string;
	actor: { kind: "human"; id: string };
	reason: string;
}

export interface EvaluatorConfigurationResult {
	subject: EvaluatorConfigurationSubject;
	receipt: EvaluatorConfigurationReceipt;
	receiptPath: string;
	manifest: TargetManifestValue;
}

export interface EvaluatorConfigurationDependencies {
	now: () => string;
	writeReceipt: (path: string, receipt: EvaluatorConfigurationReceipt) => void;
}

const DEFAULT_DEPENDENCIES: EvaluatorConfigurationDependencies = {
	now: () => new Date().toISOString(),
	writeReceipt: (path, receipt) =>
		writeJsonArtifact(path, EvaluatorConfigurationReceiptSchema, receipt, { immutable: true }),
};

/**
 * The same whole-file rendering the Target bootstrap dialog shows, so an
 * operator reads one diff shape across both setup steps. Kept here rather than
 * shared because `harness-authoring` already owns that exported name for the
 * richer proposal diff, and one confusable pair of names is enough.
 */
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

function repositoryRoot(input: string): string {
	const requested = resolve(input);
	const entry = lstatSync(requested);
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new Error(`targetDir must be a regular non-symlink directory: ${requested}`);
	}
	const canonical = realpathSync(requested);
	const top = realpathSync(gitText(canonical, ["rev-parse", "--show-toplevel"]));
	if (top !== canonical) throw new Error(`targetDir must be the Git worktree root: ${canonical}`);
	return canonical;
}

function assertCleanRepository(repositoryDir: string): string {
	if (gitText(repositoryDir, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
		throw new Error("Evaluator configuration requires a clean repository");
	}
	const manifestEntry = gitText(repositoryDir, ["ls-files", "-s", "--", "manifest.yaml"]);
	if (!/^100644 [0-9a-f]{40} 0\tmanifest\.yaml$/.test(manifestEntry)) {
		throw new Error("manifest.yaml must be one tracked regular 100644 file");
	}
	return GitShaSchema.parse(gitText(repositoryDir, ["rev-parse", "HEAD"]));
}

function stateRootPath(input: string, create: boolean): string {
	const requested = resolve(input);
	if (!existsSync(requested)) {
		if (!create) return requested;
		mkdirSync(requested, { recursive: true, mode: 0o700 });
	}
	const entry = lstatSync(requested);
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new Error(`Evaluator configuration stateRoot must be a regular non-symlink directory: ${requested}`);
	}
	if (create) chmodSync(requested, 0o700);
	return realpathSync(requested);
}

function assertStateRootDoesNotDirtyTarget(repositoryDir: string, stateRoot: string): void {
	const state = resolve(stateRoot);
	if (!contained(repositoryDir, state)) return;
	const relativeState = relative(repositoryDir, state) || ".";
	if (spawnSync("git", ["-C", repositoryDir, "check-ignore", "-q", "--", relativeState], { stdio: "ignore" }).status !== 0) {
		throw new Error("An in-repository evaluator stateRoot must be ignored by Git");
	}
}

function parseManifestText(content: string, label: string): TargetManifestValue {
	if (Buffer.byteLength(content, "utf8") > MAX_MANIFEST_BYTES) {
		throw new Error(`${label} exceeds ${MAX_MANIFEST_BYTES} bytes`);
	}
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

const CREDENTIAL_FIELD_KEYS = new Set(["apikey", "secret", "token", "password", "credential", "authorization", "auth"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The one credential rule, restated where an evaluator block is admitted: the
 * manifest may name an environment variable and may hold nothing else that
 * looks like a secret. A value pasted here would be committed to Git.
 */
function assertNoCredentialValue(value: unknown, path: string): void {
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) assertNoCredentialValue(item, `${path}[${index}]`);
		return;
	}
	if (!isPlainObject(value)) return;
	for (const [key, child] of Object.entries(value)) {
		const normalized = key.toLowerCase().replace(/[-_]/g, "");
		const isTopLevelKeyEnv = !path.includes(".") && key === "apiKeyEnv";
		if (!isTopLevelKeyEnv && CREDENTIAL_FIELD_KEYS.has(normalized)) {
			throw new Error(`${path}.${key} is a credential value field; evaluator setup accepts only apiKeyEnv`);
		}
		assertNoCredentialValue(child, `${path}.${key}`);
	}
}

const REQUIRED_MODEL_KEYS = [
	"provider", "id", "api", "baseUrl", "apiKeyEnv", "thinkingLevel", "timeoutMs", "params", "spec",
] as const;

function parseEvaluatorModel(
	value: unknown,
	label: "judge" | "simulatedUser",
): z.infer<typeof JudgeModelBlock> | z.infer<typeof SimulatedUserModelBlock> {
	if (!isPlainObject(value)) throw new Error(`${label} must be a complete model object`);
	const missing = REQUIRED_MODEL_KEYS.filter((key) => !Object.hasOwn(value, key));
	if (missing.length > 0) throw new Error(`${label} must be complete; missing ${missing.join(", ")}`);
	assertNoCredentialValue(value, label);
	const model = label === "judge" ? JudgeModelBlock.parse(value) : SimulatedUserModelBlock.parse(value);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(model.apiKeyEnv)) {
		throw new Error(`${label}.apiKeyEnv must be an environment variable name`);
	}
	const endpoint = new URL(model.baseUrl);
	if (endpoint.username || endpoint.password) throw new Error(`${label}.baseUrl cannot contain credentials`);
	return model;
}

/**
 * A judge grading a copy of the model under test is not a second opinion. The
 * comparison is provider+id: same weights, same failure modes, same blind
 * spots, whatever the endpoint or the thinking level says.
 */
export function sameModelAsTarget(
	target: { provider: string; id: string },
	evaluator: { provider: string; id: string },
): boolean {
	return target.provider === evaluator.provider && target.id === evaluator.id;
}

function evaluatorBlocks(manifest: TargetManifestValue): EvaluatorBlocks {
	return {
		judge: manifest.evalSuite.judge ?? null,
		simulatedUser: manifest.evalSuite.simulatedUser ?? null,
	};
}

interface PreparedConfiguration {
	repositoryDir: string;
	baseTargetSha: string;
	baseText: string;
	configuredText: string;
	manifest: TargetManifestValue;
	subject: EvaluatorConfigurationSubject;
}

function prepare(options: DescribeEvaluatorConfigurationOptions): PreparedConfiguration {
	if (options.judge === undefined && options.simulatedUser === undefined) {
		throw new Error("Evaluator configuration needs a judge, a simulated user, or both");
	}
	const repositoryDir = repositoryRoot(options.targetDir);
	const baseTargetSha = assertCleanRepository(repositoryDir);
	const manifestPath = join(repositoryDir, "manifest.yaml");
	const manifestEntry = lstatSync(manifestPath);
	if (!manifestEntry.isFile() || manifestEntry.isSymbolicLink()) {
		throw new Error("manifest.yaml must be a regular non-symlink file");
	}
	const baseText = readFileSync(manifestPath, "utf8");
	const parsedBase = parseManifestText(baseText, "manifest.yaml");

	const judge = options.judge === undefined
		? null
		: JudgeModelBlock.parse({
			...parseEvaluatorModel(options.judge, "judge"),
			// Promotion policy belongs to the operator, not to this decision:
			// swapping the judge model must not quietly lift a calibration bar.
			...(parsedBase.evalSuite.judge?.requireCalibration
				? { requireCalibration: parsedBase.evalSuite.judge.requireCalibration }
				: {}),
		});
	const simulatedUser = options.simulatedUser === undefined
		? null
		: SimulatedUserModelBlock.parse(parseEvaluatorModel(options.simulatedUser, "simulatedUser"));

	if (judge && sameModelAsTarget(parsedBase.model, judge)) {
		throw new Error(
			`Evaluator configuration refused: the judge ${judge.provider}/${judge.id} is the Target's own model. ` +
				"A judge grading its own twin agrees with itself; choose a different model.",
		);
	}

	const document = parseDocument(baseText);
	if (document.errors.length > 0) throw new Error(`manifest.yaml: ${document.errors[0]?.message ?? "invalid YAML"}`);
	if (judge) document.setIn(["evalSuite", "judge"], judge);
	if (simulatedUser) document.setIn(["evalSuite", "simulatedUser"], simulatedUser);
	const configuredText = document.toString({ lineWidth: 0 });
	const manifest = parseManifestText(configuredText, "configured manifest.yaml");

	// Nothing but the two evaluator blocks may move. The Target's own model,
	// its instructions, its tools and its dataset are other decisions entirely.
	for (const field of ["id", "model", "execution", "instructions", "skills", "tools", "data"] as const) {
		if (canonicalJson(manifest[field]) !== canonicalJson(parsedBase[field])) {
			throw new Error(`Evaluator configuration unexpectedly changed manifest.${field}`);
		}
	}
	const suiteBefore = { ...parsedBase.evalSuite, judge: undefined, simulatedUser: undefined };
	const suiteAfter = { ...manifest.evalSuite, judge: undefined, simulatedUser: undefined };
	if (canonicalJson(suiteBefore) !== canonicalJson(suiteAfter)) {
		throw new Error("Evaluator configuration unexpectedly changed the eval suite's inputs");
	}
	if (canonicalJson(evaluatorBlocks(manifest)) === canonicalJson(evaluatorBlocks(parsedBase))) {
		throw new Error("Evaluator configuration would change nothing");
	}

	const identity = {
		schemaVersion: 1 as const,
		targetId: parsedBase.id,
		baseTargetSha,
		targetModel: { provider: parsedBase.model.provider, id: parsedBase.model.id },
		previous: { ...evaluatorBlocks(parsedBase), manifestSha256: sha256(baseText) },
		next: { ...evaluatorBlocks(manifest), manifestSha256: sha256(configuredText) },
		unifiedDiff: wholeFileDiff("manifest.yaml", baseText, configuredText),
	};
	const subject = EvaluatorConfigurationSubjectSchema.parse({ ...identity, subjectHash: hashValue(identity) });
	return { repositoryDir, baseTargetSha, baseText, configuredText, manifest, subject };
}

/** Build the exact immutable subject a trusted host must show and confirm. */
export function describeEvaluatorConfiguration(
	options: DescribeEvaluatorConfigurationOptions,
): EvaluatorConfigurationSubject {
	return prepare(options).subject;
}

function receiptPath(stateRoot: string, receiptId: string): string {
	return join(stateRoot, RECEIPT_DIRECTORY, `${ReceiptIdSchema.parse(receiptId)}.json`);
}

function assertPrivateReceipt(path: string): void {
	const entry = lstatSync(path);
	if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Evaluator receipt must be a regular non-symlink file");
	const mode = statSync(path).mode & 0o777;
	if (mode !== 0o600) throw new Error(`Evaluator receipt must have mode 0600, got 0${mode.toString(8)}`);
}

/**
 * Roll back only the commit this invocation just made. If HEAD advanced for
 * any other reason, touching the checkout would destroy somebody else's work,
 * so rollback fails closed instead.
 */
function restoreManifest(prepared: PreparedConfiguration, configuredTargetSha: string | null): void {
	const expectedHead = configuredTargetSha ?? prepared.baseTargetSha;
	const currentHead = gitText(prepared.repositoryDir, ["rev-parse", "HEAD"]);
	if (currentHead !== expectedHead) {
		throw new Error(
			`Evaluator rollback refused because HEAD advanced from ${expectedHead} to ${currentHead}`,
		);
	}
	if (configuredTargetSha !== null) {
		execFileSync("git", [
			"-C", prepared.repositoryDir,
			"update-ref", "-m", "AHDE evaluator receipt rollback",
			"HEAD", prepared.baseTargetSha, configuredTargetSha,
		], { stdio: ["ignore", "pipe", "pipe"] });
	}
	writeFileSync(join(prepared.repositoryDir, "manifest.yaml"), prepared.baseText, "utf8");
	execFileSync("git", ["-C", prepared.repositoryDir, "add", "--", "manifest.yaml"], { stdio: ["ignore", "pipe", "pipe"] });
	if (gitText(prepared.repositoryDir, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
		throw new Error("Evaluator rollback did not restore the exact clean repository");
	}
}

/**
 * Apply one exact, host-confirmed evaluator configuration and publish its
 * immutable receipt. This service accepts no model credential value.
 */
export function configureEvaluators(
	options: ConfigureEvaluatorsOptions,
	dependencies: Partial<EvaluatorConfigurationDependencies> = {},
): EvaluatorConfigurationResult {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	const expectedSubjectHash = Sha256Schema.parse(options.expectedSubjectHash);
	const actor = HumanActorSchema.parse(options.actor);
	const reason = ReasonSchema.parse(options.reason);
	const repositoryDir = repositoryRoot(options.targetDir);
	assertStateRootDoesNotDirtyTarget(repositoryDir, options.stateRoot);
	const stateRoot = stateRootPath(options.stateRoot, true);
	const lockPath = join(stateRoot, CONFIGURATION_LOCK);
	let lock: number;
	try {
		lock = openSync(lockPath, "wx", 0o600);
	} catch (error) {
		throw new Error("Evaluator configuration is already in progress", { cause: error });
	}
	try {
		const prepared = prepare({ ...options, targetDir: repositoryDir, stateRoot });
		if (prepared.subject.subjectHash !== expectedSubjectHash) {
			throw new Error("Evaluator configuration subject changed after review; confirmation is stale");
		}
		if (gitText(repositoryDir, ["rev-parse", "HEAD"]) !== prepared.baseTargetSha) {
			throw new Error("Evaluator configuration HEAD changed after subject validation");
		}

		const manifestPath = join(repositoryDir, "manifest.yaml");
		const hooksPath = mkdtempSync(join(tmpdir(), "ahde-evaluators-hooks-"));
		let configuredTargetSha: string | null = null;
		let receiptPublished = false;
		let path: string | null = null;
		try {
			writeFileSync(manifestPath, prepared.configuredText, "utf8");
			execFileSync("git", ["-C", repositoryDir, "add", "--", "manifest.yaml"], { stdio: ["ignore", "pipe", "pipe"] });
			const staged = gitText(repositoryDir, ["diff", "--cached", "--name-only", "-z", "--"]).split("\0").filter(Boolean);
			if (staged.length !== 1 || staged[0] !== "manifest.yaml") {
				throw new Error(`Evaluator configuration staged unexpected paths: ${staged.join(", ")}`);
			}
			if (sha256(readFileSync(manifestPath)) !== prepared.subject.next.manifestSha256) {
				throw new Error("Evaluator manifest bytes differ from the confirmed subject");
			}

			const configuredAt = TimestampSchema.parse(deps.now());
			execFileSync("git", [
				"-C", repositoryDir,
				"-c", `core.hooksPath=${hooksPath}`,
				"-c", "commit.gpgSign=false",
				"commit", "--no-verify", "--no-gpg-sign", "-m", "Configure AHDE evaluator models",
			], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "AHDE Bootstrap",
					GIT_AUTHOR_EMAIL: "bootstrap@ahde.local",
					GIT_COMMITTER_NAME: "AHDE Bootstrap",
					GIT_COMMITTER_EMAIL: "bootstrap@ahde.local",
					GIT_AUTHOR_DATE: configuredAt,
					GIT_COMMITTER_DATE: configuredAt,
				},
			});
			configuredTargetSha = GitShaSchema.parse(gitText(repositoryDir, ["rev-parse", "HEAD"]));
			if (gitText(repositoryDir, ["rev-parse", "HEAD^"]) !== prepared.baseTargetSha) {
				throw new Error("Evaluator configuration commit parent differs from the confirmed base");
			}
			const committed = gitText(repositoryDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"])
				.split("\0").filter(Boolean);
			if (committed.length !== 1 || committed[0] !== "manifest.yaml") {
				throw new Error("Evaluator configuration commit contains paths other than manifest.yaml");
			}
			if (gitText(repositoryDir, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
				throw new Error("Evaluator configuration commit did not leave a clean repository");
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
			const receipt = EvaluatorConfigurationReceiptSchema.parse({
				...receiptIdentity,
				id: `configure-evaluators-${hashValue(receiptIdentity).slice("sha256:".length)}`,
			});
			// Created only once there is a receipt to put in it, so a refused or a
			// stale confirmation leaves no trace of itself anywhere.
			mkdirSync(join(stateRoot, RECEIPT_DIRECTORY), { recursive: true, mode: 0o700 });
			path = receiptPath(stateRoot, receipt.id);
			deps.writeReceipt(path, receipt);
			assertPrivateReceipt(path);
			const persisted = readJsonArtifact(path, EvaluatorConfigurationReceiptSchema);
			if (canonicalJson(persisted) !== canonicalJson(receipt)) {
				throw new Error("Published evaluator receipt differs from the committed configuration");
			}
			receiptPublished = true;
			return { subject: prepared.subject, receipt, receiptPath: path, manifest: prepared.manifest };
		} catch (error) {
			if (!receiptPublished) {
				try {
					if (path && existsSync(path)) unlinkSync(path);
					restoreManifest(prepared, configuredTargetSha);
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "Evaluator configuration and rollback both failed");
				}
			}
			throw error;
		} finally {
			rmSync(hooksPath, { recursive: true, force: true });
		}
	} finally {
		closeSync(lock);
		try {
			unlinkSync(lockPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// The lock fd is closed; an absent lock is already the desired state.
		}
	}
}

/** One line per evaluator: what it is, and whether this machine can call it. */
export interface EvaluatorReadinessLine {
	role: "judge" | "simulatedUser";
	configured: boolean;
	model: string | null;
	apiKeyEnv: string | null;
	credentialPresent: boolean;
	line: string;
}

/**
 * What `ahde validate` prints beside the Target model. A judge that is
 * configured but whose key is missing fails exactly like the Target's does:
 * silently at the first graded case, hours later, unless someone says so here.
 */
export function evaluatorReadiness(
	manifest: TargetManifestValue,
	environment: Record<string, string | undefined> = process.env,
): EvaluatorReadinessLine[] {
	const describe = (
		role: "judge" | "simulatedUser",
		model: { provider: string; id: string; apiKeyEnv: string } | undefined,
	): EvaluatorReadinessLine => {
		if (!model) {
			return {
				role,
				configured: false,
				model: null,
				apiKeyEnv: null,
				credentialPresent: false,
				line: `${role}: not configured`,
			};
		}
		const credentialPresent = Boolean(environment[model.apiKeyEnv]?.trim());
		return {
			role,
			configured: true,
			model: `${model.provider}/${model.id}`,
			apiKeyEnv: model.apiKeyEnv,
			credentialPresent,
			line: `${role}: configured · ${model.provider}/${model.id} · key ${model.apiKeyEnv} ${
				credentialPresent ? "set" : "MISSING"
			}`,
		};
	};
	return [
		describe("judge", manifest.evalSuite.judge),
		describe("simulatedUser", manifest.evalSuite.simulatedUser),
	];
}
