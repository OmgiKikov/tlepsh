import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
	CandidateProposalSchema,
	validateCandidateProposal,
	type CandidateProposal,
} from "../builders/adapters.js";
import {
	ExecutionPolicyBlock,
	loadTarget,
	TargetManifest,
	type ExecutionPolicyBlock as ExecutionPolicy,
	type TargetManifest as TargetManifestValue,
} from "../manifest.js";
import {
	validateTargetToolDescriptor,
	type TargetToolDescriptor,
} from "../target/tool-manifest.js";
import { canonicalJson } from "../provenance.js";

const GIT_SHA = /^[0-9a-f]{40}$/;
const SKILL_NAME = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const SKILL_DECLARATION = /^skills\/((?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/;
const TOOL_DECLARATION = /^tools\/([a-z][a-z0-9_]{0,63})\.tool\.yaml$/;

const MAX_INTENTS = 32;
const MAX_AUTHORED_FILE_BYTES = 512 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PROPOSAL_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_TEXT_BYTES = 64 * 1024;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_METADATA_ITEMS = 64;

/** The only path scope emitted by structured harness authoring. */
export const HARNESS_AUTHORING_ALLOWED_PATHS = [
	"AGENTS.md",
	"manifest.yaml",
	"skills/**",
	"bin/**",
	"tools/**",
] as const;

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function boundedText(maxBytes: number, label: string, nonBlank = true): z.ZodString {
	let schema = z.string()
		.refine((value) => !value.includes("\0"), `${label} must not contain NUL bytes`)
		.refine((value) => !value.includes("\r"), `${label} must use LF line endings`)
		.refine((value) => utf8Bytes(value) <= maxBytes, `${label} exceeds ${maxBytes} UTF-8 bytes`);
	if (nonBlank) schema = schema.refine((value) => value.trim().length > 0, `${label} must be non-blank`);
	return schema;
}

const SkillNameSchema = z.string().regex(SKILL_NAME, "skill name must be lowercase kebab-case without consecutive hyphens");
const ToolNameSchema = z.string().regex(TOOL_NAME, "tool name must be lowercase snake_case");
const AuthoredTextSchema = boundedText(MAX_AUTHORED_FILE_BYTES, "authored content");
const DescriptionSchema = boundedText(2_000, "description")
	.max(1_024)
	.refine((value) => !value.includes("\n"), "description must be one line");
const CommandArgumentSchema = z.string()
	.min(1)
	.max(4_096)
	.refine((value) => !/[\0\r\n]/.test(value), "command arguments must not contain NUL or line breaks");

export const HarnessToolDescriptorInputSchema = z.strictObject({
	description: boundedText(2_000, "tool description"),
	parameters: z.record(z.string(), z.unknown()),
	/** Arguments after the compiler-owned bin/<name> executable. */
	arguments: z.array(CommandArgumentSchema).max(31).optional(),
	timeoutMs: z.number().int().min(1).max(120_000),
	maxOutputBytes: z.number().int().min(1).max(1024 * 1024),
	output: z.enum(["json", "text"]),
	permissions: z.strictObject({
		environment: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(32),
		network: z.enum(["deny", "allow"]),
		filesystem: z.enum(["read-only", "workspace-write"]),
	}),
});
export type HarnessToolDescriptorInput = z.infer<typeof HarnessToolDescriptorInputSchema>;

const InstructionsReplaceIntentSchema = z.strictObject({
	type: z.literal("instructions.replace"),
	content: AuthoredTextSchema,
});

const ExecutionConfigureIntentSchema = z.strictObject({
	type: z.literal("execution.configure"),
	/** Complete policy replacement; the exact manifest diff remains human-reviewed. */
	execution: ExecutionPolicyBlock,
});

const SkillUpsertIntentSchema = z.strictObject({
	type: z.literal("skill.upsert"),
	name: SkillNameSchema,
	description: DescriptionSchema,
	body: AuthoredTextSchema,
	disableModelInvocation: z.boolean().optional(),
});

const SkillRemoveIntentSchema = z.strictObject({
	type: z.literal("skill.remove"),
	name: SkillNameSchema,
});

const ToolUpsertIntentSchema = z.strictObject({
	type: z.literal("tool.upsert"),
	name: ToolNameSchema,
	descriptor: HarnessToolDescriptorInputSchema,
	/** UTF-8 executable source; the compiler always emits Git mode 100755. */
	executable: AuthoredTextSchema.refine(
		(value) => value.startsWith("#!") && value.indexOf("\n") > 2,
		"tool executable must start with a non-empty shebang line",
	),
});

const ToolRemoveIntentSchema = z.strictObject({
	type: z.literal("tool.remove"),
	name: ToolNameSchema,
});

export const HarnessAuthoringIntentSchema = z.discriminatedUnion("type", [
	InstructionsReplaceIntentSchema,
	ExecutionConfigureIntentSchema,
	SkillUpsertIntentSchema,
	SkillRemoveIntentSchema,
	ToolUpsertIntentSchema,
	ToolRemoveIntentSchema,
]);
export type HarnessAuthoringIntent = z.infer<typeof HarnessAuthoringIntentSchema>;

export const HarnessAuthoringIntentsSchema = z
	.array(HarnessAuthoringIntentSchema)
	.min(1)
	.max(MAX_INTENTS)
	.superRefine((intents, context) => {
		if (utf8Bytes(JSON.stringify(intents)) > MAX_PROPOSAL_BYTES) {
			context.addIssue({
				code: "custom",
				message: `authoring intents exceed ${MAX_PROPOSAL_BYTES} bytes`,
			});
		}
	});

export interface CompileHarnessAuthoringProposalOptions {
	repositoryDir: string;
	intents: readonly HarnessAuthoringIntent[];
	summary: string;
	diagnoses?: CandidateProposal["diagnoses"];
	risks?: CandidateProposal["risks"];
	validationPlan?: CandidateProposal["validationPlan"];
}

const MetadataTextSchema = boundedText(MAX_METADATA_TEXT_BYTES, "proposal metadata");
const AuthoringMetadataSchema = z.strictObject({
	summary: MetadataTextSchema,
	diagnoses: z.array(z.strictObject({
		failureIds: z.array(MetadataTextSchema).min(1).max(MAX_METADATA_ITEMS),
		evidence: z.array(MetadataTextSchema).min(1).max(MAX_METADATA_ITEMS),
		rootCause: MetadataTextSchema,
	})).max(MAX_METADATA_ITEMS),
	risks: z.array(MetadataTextSchema).max(MAX_METADATA_ITEMS),
	validationPlan: z.array(MetadataTextSchema).max(MAX_METADATA_ITEMS),
});

interface GitBlob {
	path: string;
	mode: "100644" | "100755";
	content: Buffer;
}

interface PlannedFile {
	path: string;
	before: GitBlob | null;
	after: string | null;
	afterMode: "100644" | "100755" | null;
	rationale: string;
}

function gitText(repositoryDir: string, args: string[]): string {
	return execFileSync("git", ["-C", repositoryDir, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: GIT_MAX_BUFFER,
	}).trim();
}

function repositoryHead(input: string): { repositoryDir: string; baseTargetSha: string } {
	const requested = resolve(input);
	const entry = lstatSync(requested);
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new Error(`repositoryDir must be a regular non-symlink directory: ${requested}`);
	}
	const repositoryDir = realpathSync(requested);
	const top = realpathSync(gitText(repositoryDir, ["rev-parse", "--show-toplevel"]));
	if (top !== repositoryDir) throw new Error(`repositoryDir must be the Git worktree root: ${repositoryDir}`);
	if (gitText(repositoryDir, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
		throw new Error("structured harness authoring requires a clean repository");
	}
	const baseTargetSha = gitText(repositoryDir, ["rev-parse", "HEAD"]);
	if (!GIT_SHA.test(baseTargetSha)) throw new Error("repository HEAD is not an exact Git commit");
	return { repositoryDir, baseTargetSha };
}

function treeRecord(repositoryDir: string, revision: string, path: string): { mode: string; type: string; path: string } | null {
	const output = execFileSync("git", ["-C", repositoryDir, "ls-tree", "-z", revision, "--", path], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: GIT_MAX_BUFFER,
	});
	for (const record of output.split("\0").filter(Boolean)) {
		const tab = record.indexOf("\t");
		if (tab < 0 || record.slice(tab + 1) !== path) continue;
		const [mode, type] = record.slice(0, tab).split(" ");
		if (!mode || !type) throw new Error(`could not parse Git tree entry for ${path}`);
		return { mode, type, path };
	}
	return null;
}

function assertSafeTreeAncestors(repositoryDir: string, revision: string, path: string): void {
	const parts = path.split("/");
	for (let index = 1; index < parts.length; index += 1) {
		const ancestor = parts.slice(0, index).join("/");
		const entry = treeRecord(repositoryDir, revision, ancestor);
		if (!entry) continue;
		if (entry.mode === "120000") throw new Error(`authored path traverses a symlink: ${ancestor}`);
		if (entry.type !== "tree") throw new Error(`authored path parent is not a directory: ${ancestor}`);
	}
}

function readBlob(repositoryDir: string, revision: string, path: string, maxBytes = MAX_AUTHORED_FILE_BYTES): GitBlob | null {
	assertSafeTreeAncestors(repositoryDir, revision, path);
	const entry = treeRecord(repositoryDir, revision, path);
	if (!entry) return null;
	if (entry.mode === "120000") throw new Error(`authored path is a symlink: ${path}`);
	if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
		throw new Error(`authored path must be a regular Git file: ${path}`);
	}
	const sizeText = gitText(repositoryDir, ["cat-file", "-s", `${revision}:${path}`]);
	const size = Number(sizeText);
	if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
		throw new Error(`${path} exceeds the ${maxBytes}-byte authoring limit`);
	}
	const content = execFileSync("git", ["-C", repositoryDir, "show", `${revision}:${path}`], {
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: Math.max(maxBytes + 1, 1024),
	});
	if (content.length !== size) throw new Error(`could not read the exact Git blob for ${path}`);
	return { path, mode: entry.mode, content };
}

function decodeText(content: Buffer, label: string): string {
	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch (error) {
		throw new Error(`${label} must be valid UTF-8 text`, { cause: error });
	}
	if (decoded.includes("\0")) throw new Error(`${label} must not contain NUL bytes`);
	if (decoded.includes("\r")) throw new Error(`${label} must use LF line endings`);
	return decoded;
}

function sha256(content: string | Buffer): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function splitDiffLines(content: string): { lines: string[]; terminalNewline: boolean } {
	if (content.length === 0) return { lines: [], terminalNewline: true };
	const terminalNewline = content.endsWith("\n");
	const lines = content.split("\n");
	if (terminalNewline) lines.pop();
	return { lines, terminalNewline };
}

function diffRange(count: number): string {
	if (count === 0) return "0,0";
	return count === 1 ? "1" : `1,${count}`;
}

function appendChangedLines(output: string[], prefix: "-" | "+", content: string): number {
	const split = splitDiffLines(content);
	for (const line of split.lines) output.push(`${prefix}${line}`);
	if (!split.terminalNewline && split.lines.length > 0) output.push("\\ No newline at end of file");
	return split.lines.length;
}

function wholeFileDiff(file: PlannedFile): string {
	const beforeText = file.before ? decodeText(file.before.content, file.path) : "";
	const afterText = file.after ?? "";
	const beforeLines = splitDiffLines(beforeText).lines.length;
	const afterLines = splitDiffLines(afterText).lines.length;
	if (beforeLines === 0 && afterLines === 0) {
		throw new Error(`cannot represent an empty-file-only change in CandidateProposal: ${file.path}`);
	}
	const output = [`diff --git a/${file.path} b/${file.path}`];
	if (!file.before) {
		if (!file.afterMode) throw new Error(`new file is missing a mode: ${file.path}`);
		output.push(`new file mode ${file.afterMode}`);
	} else if (file.after === null) {
		output.push(`deleted file mode ${file.before.mode}`);
	} else if (file.afterMode && file.before.mode !== file.afterMode) {
		output.push(`old mode ${file.before.mode}`, `new mode ${file.afterMode}`);
	}
	output.push(file.before ? `--- a/${file.path}` : "--- /dev/null");
	output.push(file.after === null ? "+++ /dev/null" : `+++ b/${file.path}`);
	output.push(`@@ -${diffRange(beforeLines)} +${diffRange(afterLines)} @@`);
	if (file.before) appendChangedLines(output, "-", beforeText);
	if (file.after !== null) appendChangedLines(output, "+", afterText);
	return output.join("\n");
}

function skillText(intent: Extract<HarnessAuthoringIntent, { type: "skill.upsert" }>): string {
	const frontmatter: Record<string, unknown> = { name: intent.name, description: intent.description };
	if (intent.disableModelInvocation === true) frontmatter["disable-model-invocation"] = true;
	return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${intent.body}`;
}

function targetToolDescriptor(
	intent: Extract<HarnessAuthoringIntent, { type: "tool.upsert" }>,
): TargetToolDescriptor {
	return {
		schemaVersion: 1,
		name: intent.name,
		description: intent.descriptor.description,
		parameters: intent.descriptor.parameters,
		command: { argv: [`bin/${intent.name}`, ...(intent.descriptor.arguments ?? [])] },
		timeoutMs: intent.descriptor.timeoutMs,
		maxOutputBytes: intent.descriptor.maxOutputBytes,
		output: intent.descriptor.output,
		permissions: intent.descriptor.permissions,
	};
}

function assertCanonicalDeclarations(manifest: TargetManifestValue): void {
	if (manifest.instructions.agentsMd !== "AGENTS.md") {
		throw new Error("structured instructions authoring requires manifest instructions.agentsMd to be AGENTS.md");
	}
	const skillNames = new Set<string>();
	for (const declaration of manifest.skills) {
		const name = SKILL_DECLARATION.exec(declaration)?.[1];
		if (!name) throw new Error(`structured authoring requires canonical skill declarations: ${declaration}`);
		if (skillNames.has(name)) throw new Error(`duplicate skill declaration: ${declaration}`);
		skillNames.add(name);
	}
	const toolNames = new Set<string>();
	for (const declaration of manifest.tools) {
		const name = TOOL_DECLARATION.exec(declaration)?.[1];
		if (!name) throw new Error(`structured authoring requires canonical tool declarations: ${declaration}`);
		if (toolNames.has(name)) throw new Error(`duplicate tool declaration: ${declaration}`);
		toolNames.add(name);
	}
}

function renderManifest(
	baseText: string,
	baseManifest: TargetManifestValue,
	updates: { skills?: string[]; tools?: string[]; execution?: ExecutionPolicy },
): string {
	const document = parseDocument(baseText);
	if (document.errors.length > 0) {
		throw new Error(`manifest.yaml is not valid YAML: ${document.errors[0]?.message ?? "unknown error"}`);
	}
	if (updates.skills) document.set("skills", updates.skills);
	if (updates.tools) document.set("tools", updates.tools);
	if (updates.execution) document.set("execution", updates.execution);
	const rendered = String(document);
	if (utf8Bytes(rendered) > MAX_MANIFEST_BYTES) throw new Error(`manifest.yaml exceeds ${MAX_MANIFEST_BYTES} bytes`);
	const parsed = TargetManifest.safeParse(parseYaml(rendered));
	if (!parsed.success) throw new Error(`compiled manifest.yaml is invalid: ${parsed.error.message}`);
	for (const field of ["id", "model", "instructions", "evalSuite"] as const) {
		if (canonicalJson(parsed.data[field]) !== canonicalJson(baseManifest[field])) {
			throw new Error(`compiled manifest unexpectedly changed protected field ${field}`);
		}
	}
	if (updates.execution && canonicalJson(parsed.data.execution) !== canonicalJson(updates.execution)) {
		throw new Error("compiled manifest does not contain the exact requested execution policy");
	}
	if (!updates.execution && canonicalJson(parsed.data.execution) !== canonicalJson(baseManifest.execution)) {
		throw new Error("compiled manifest unexpectedly changed protected field execution");
	}
	return rendered;
}

/**
 * Compile Builder-friendly semantic harness edits into the existing immutable
 * CandidateProposal boundary. Paths, hashes, diffs, Git modes, manifest list
 * mutations, and the exact base revision are all derived by this function.
 */
export function compileHarnessAuthoringProposal(
	options: CompileHarnessAuthoringProposalOptions,
): CandidateProposal {
	const metadata = AuthoringMetadataSchema.parse({
		summary: options.summary,
		diagnoses: options.diagnoses ?? [],
		risks: options.risks ?? [],
		validationPlan: options.validationPlan ?? [],
	});
	const intents = HarnessAuthoringIntentsSchema.parse(options.intents);
	const { repositoryDir, baseTargetSha } = repositoryHead(options.repositoryDir);
	const target = loadTarget(repositoryDir);
	if (target.gitSha !== baseTargetSha) throw new Error("resolved Target does not match the clean repository HEAD");
	const manifest = TargetManifest.parse(target.manifest);
	assertCanonicalDeclarations(manifest);

	const manifestBlob = readBlob(repositoryDir, baseTargetSha, "manifest.yaml", MAX_MANIFEST_BYTES);
	if (!manifestBlob || manifestBlob.mode !== "100644") {
		throw new Error("manifest.yaml must be a tracked regular 100644 file");
	}
	const manifestText = decodeText(manifestBlob.content, "manifest.yaml");
	let skills = [...manifest.skills];
	let tools = [...manifest.tools];
	const executionIntent = intents.find((intent): intent is Extract<HarnessAuthoringIntent, { type: "execution.configure" }> =>
		intent.type === "execution.configure"
	);
	const execution = executionIntent?.execution ?? manifest.execution;
	const planned = new Map<string, PlannedFile>();
	const resources = new Set<string>();
	let skillsChanged = false;
	let toolsChanged = false;
	let executionChanged = false;

	const plan = (
		path: string,
		after: string | null,
		afterMode: "100644" | "100755" | null,
		rationale: string,
	): void => {
		if (planned.has(path)) throw new Error(`multiple intents target the same authored file: ${path}`);
		if (after !== null && utf8Bytes(after) > MAX_AUTHORED_FILE_BYTES) {
			throw new Error(`${path} exceeds ${MAX_AUTHORED_FILE_BYTES} UTF-8 bytes`);
		}
		const before = readBlob(repositoryDir, baseTargetSha, path);
		if (after === null && !before) throw new Error(`cannot remove missing authored resource: ${path}`);
		if (before && after !== null && before.mode === afterMode && before.content.equals(Buffer.from(after, "utf8"))) return;
		planned.set(path, { path, before, after, afterMode, rationale });
	};

	for (const intent of intents) {
		const resource = intent.type === "instructions.replace"
			? "instructions"
			: intent.type === "execution.configure"
				? "execution"
				: `${intent.type.split(".")[0]}:${intent.name}`;
		if (resources.has(resource)) throw new Error(`conflicting or duplicate authoring intents for ${resource}`);
		resources.add(resource);

		if (intent.type === "instructions.replace") {
			plan("AGENTS.md", intent.content, "100644", "Replace the Target's primary instructions");
			continue;
		}
		if (intent.type === "execution.configure") {
			executionChanged = canonicalJson(intent.execution) !== canonicalJson(manifest.execution);
			continue;
		}
		if (intent.type === "skill.upsert") {
			const declaration = `skills/${intent.name}`;
			if (!skills.includes(declaration)) {
				skills.push(declaration);
				skillsChanged = true;
			}
			plan(`${declaration}/SKILL.md`, skillText(intent), "100644", `Upsert the ${intent.name} Target skill`);
			continue;
		}
		if (intent.type === "skill.remove") {
			const declaration = `skills/${intent.name}`;
			if (!skills.includes(declaration)) throw new Error(`cannot remove undeclared skill: ${intent.name}`);
			skills = skills.filter((candidate) => candidate !== declaration);
			skillsChanged = true;
			plan(`${declaration}/SKILL.md`, null, null, `Remove the ${intent.name} Target skill`);
			continue;
		}
		if (intent.type === "tool.upsert") {
			const descriptorPath = `tools/${intent.name}.tool.yaml`;
			const executablePath = `bin/${intent.name}`;
			const shared = target.tools.find(
				(tool) => tool.descriptor.name !== intent.name && tool.executablePath === executablePath,
			);
			if (shared) {
				throw new Error(`${executablePath} is also used by declared tool ${shared.descriptor.name}`);
			}
			const descriptor = targetToolDescriptor(intent);
			validateTargetToolDescriptor(descriptor, descriptorPath, execution);
			if (!tools.includes(descriptorPath)) {
				tools.push(descriptorPath);
				toolsChanged = true;
			}
			plan(descriptorPath, stringifyYaml(descriptor), "100644", `Upsert the ${intent.name} Target tool descriptor`);
			plan(executablePath, intent.executable, "100755", `Upsert the ${intent.name} Target tool executable`);
			continue;
		}

		const descriptorPath = `tools/${intent.name}.tool.yaml`;
		if (!tools.includes(descriptorPath)) throw new Error(`cannot remove undeclared tool: ${intent.name}`);
		const resolved = target.tools.find((tool) => tool.descriptor.name === intent.name);
		if (!resolved || resolved.descriptorPath !== descriptorPath) {
			throw new Error(`cannot resolve the declared tool being removed: ${intent.name}`);
		}
		const executablePath = `bin/${intent.name}`;
		if (resolved.executablePath !== executablePath) {
			throw new Error(`structured tool removal requires the canonical executable ${executablePath}`);
		}
		const shared = target.tools.find(
			(tool) => tool.descriptor.name !== intent.name && tool.executablePath === executablePath,
		);
		if (shared) throw new Error(`${executablePath} is also used by declared tool ${shared.descriptor.name}`);
		tools = tools.filter((candidate) => candidate !== descriptorPath);
		toolsChanged = true;
		plan(descriptorPath, null, null, `Remove the ${intent.name} Target tool descriptor`);
		plan(executablePath, null, null, `Remove the ${intent.name} Target tool executable`);
	}

	if (executionChanged) {
		const removed = new Set(intents
			.filter((intent): intent is Extract<HarnessAuthoringIntent, { type: "tool.remove" }> => intent.type === "tool.remove")
			.map((intent) => intent.name));
		const replaced = new Set(intents
			.filter((intent): intent is Extract<HarnessAuthoringIntent, { type: "tool.upsert" }> => intent.type === "tool.upsert")
			.map((intent) => intent.name));
		for (const tool of target.tools) {
			if (removed.has(tool.descriptor.name) || replaced.has(tool.descriptor.name)) continue;
			validateTargetToolDescriptor(tool.descriptor, tool.descriptorPath, execution);
		}
	}

	if (skillsChanged || toolsChanged || executionChanged) {
		const nextManifest = renderManifest(manifestText, manifest, {
			...(skillsChanged ? { skills } : {}),
			...(toolsChanged ? { tools } : {}),
			...(executionChanged ? { execution } : {}),
		});
		plan(
			"manifest.yaml",
			nextManifest,
			"100644",
			executionChanged
				? "Update the Target's reviewed execution policy and declared resources"
				: "Update the Target's declared skill and tool resources",
		);
	}

	const evidenceRefs = [...new Set(metadata.diagnoses.flatMap((diagnosis) => diagnosis.evidence))];
	const changes = [...planned.values()]
		.sort((left, right) => left.path.localeCompare(right.path))
		.map((file) => ({
			path: file.path,
			baseSha256: sha256(file.before?.content ?? Buffer.alloc(0)),
			unifiedDiff: wholeFileDiff(file),
			rationale: file.rationale,
			evidenceRefs,
		}));

	const proposal = CandidateProposalSchema.parse({
		schemaVersion: 1,
		decision: changes.length > 0 ? "propose" : "no-change",
		baseTargetSha,
		summary: metadata.summary,
		diagnoses: metadata.diagnoses,
		changes,
		risks: metadata.risks,
		validationPlan: metadata.validationPlan,
	});
	validateCandidateProposal(proposal, {
		baseTargetSha,
		allowedPaths: [...HARNESS_AUTHORING_ALLOWED_PATHS],
	});
	const serialized = `${JSON.stringify(proposal, null, "\t")}\n`;
	if (utf8Bytes(serialized) > MAX_PROPOSAL_BYTES) throw new Error(`compiled proposal exceeds ${MAX_PROPOSAL_BYTES} bytes`);
	if (proposal.decision === "propose") {
		const patch = `${proposal.changes.map((change) => change.unifiedDiff.trimEnd()).join("\n")}\n`;
		execFileSync("git", ["-C", repositoryDir, "apply", "--check", "--index", "-"], {
			input: patch,
			stdio: ["pipe", "pipe", "pipe"],
			maxBuffer: GIT_MAX_BUFFER,
		});
	}
	return proposal;
}
