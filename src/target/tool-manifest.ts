import { accessSync, constants, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { canonicalJson, hashFile, hashValue } from "../provenance.js";
import type { ContainerPolicy } from "./container-backend.js";

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOOL_DESCRIPTOR_PATH = /^tools\/([a-z][a-z0-9_]{0,63})\.tool\.yaml$/;
/** Multi-file tools live in one directory whose descriptor is always tool.yaml. */
const TOOL_DIRECTORY_DESCRIPTOR_PATH = /^tools\/([a-z][a-z0-9_]{0,63})\/tool\.yaml$/;
const TOOL_DIRECTORY_FILE = /^[A-Za-z0-9._-]{1,64}$/;
const RESERVED_TOOL_NAMES = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);
const DANGEROUS_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const MAX_SCHEMA_DEPTH = 6;
const MAX_SCHEMA_PROPERTIES = 64;

/** A multi-file tool is a bounded, reviewable directory, not a package tree. */
export const MAX_TOOL_DIRECTORY_FILES = 256;
export const MAX_TOOL_DIRECTORY_BYTES = 8 * 1024 * 1024;
export const MAX_TOOL_DIRECTORY_DEPTH = 6;

export type TargetToolOutput = "json" | "text";
export type TargetToolFilesystem = "read-only" | "workspace-write";
export type TargetToolLayout = "single-file" | "directory";

export interface TargetToolPermissions {
	environment: string[];
	network: "deny" | "allow";
	filesystem: TargetToolFilesystem;
}

/**
 * A dependency materialization step run once per prepared tool home, never per
 * call. It executes in the same OS sandbox as the tool, writes only inside the
 * tool's own prepared directory, and reaches the network only when it says so.
 */
export interface TargetToolSetup {
	argv: string[];
	timeoutMs: number;
	network: "deny" | "allow";
}

export interface TargetToolDescriptor {
	schemaVersion: 1;
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	command: { argv: string[] };
	timeoutMs: number;
	maxOutputBytes: number;
	output: TargetToolOutput;
	permissions: TargetToolPermissions;
	/** Directory tools only. */
	setup?: TargetToolSetup;
	/** Directory-relative lockfiles whose bytes are pinned into tool identity. */
	lockfiles?: string[];
}

/** One regular file inside a multi-file tool directory. */
export interface TargetToolFile {
	/** Path relative to the tool directory, POSIX separators. */
	path: string;
	executable: boolean;
	bytes: number;
	sha256: string;
}

export interface ResolvedTargetTool {
	descriptorPath: string;
	layout: TargetToolLayout;
	/** `tools/<name>` for directory tools; null for the single-file form. */
	directoryPath: string | null;
	executablePath: string;
	descriptor: TargetToolDescriptor;
	executableHash: string;
	/** Every file in a directory tool, sorted by path. Empty for single-file tools. */
	files: TargetToolFile[];
	digest: string;
}

export interface TargetToolPolicyEnvelope {
	environmentAllowlist: string[];
	network: "deny" | "allow";
	sandbox: "required" | "best-effort" | "off";
	/** Present when the Target declares `execution.container`; selects the container backend. */
	container?: ContainerPolicy;
}

const ToolDirectoryRelativePathSchema = z
	.string()
	.min(1)
	.max(200)
	.refine(
		(value) => value.split("/").every((part) => TOOL_DIRECTORY_FILE.test(part) && part !== "." && part !== ".."),
		"tool directory paths are relative POSIX paths of safe name segments",
	)
	.refine((value) => value.split("/").length <= MAX_TOOL_DIRECTORY_DEPTH, "tool directory path is too deep");

const RawToolSetup = z.strictObject({
	/** argv[0] is a bare PATH command or an absolute executable; never a relative path. */
	argv: z.array(z.string().min(1).max(4_096)).min(1).max(32),
	timeoutMs: z.number().int().min(1).max(600_000),
	network: z.enum(["deny", "allow"]),
});

const RawToolDescriptor = z.strictObject({
	schemaVersion: z.literal(1),
	name: z.string().regex(TOOL_NAME),
	description: z.string().min(1).max(2_000),
	parameters: z.record(z.string(), z.unknown()),
	command: z.strictObject({
		argv: z.array(z.string().min(1).max(4_096)).min(1).max(32),
	}),
	timeoutMs: z.number().int().min(1).max(120_000),
	maxOutputBytes: z.number().int().min(1).max(1024 * 1024),
	output: z.enum(["json", "text"]),
	permissions: z.strictObject({
		environment: z.array(z.string().regex(ENVIRONMENT_NAME)).max(32).default([]),
		network: z.enum(["deny", "allow"]),
		filesystem: z.enum(["read-only", "workspace-write"]),
	}),
	setup: RawToolSetup.optional(),
	lockfiles: z.array(ToolDirectoryRelativePathSchema).max(8).optional(),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	path: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${path}: unsupported JSON Schema keyword "${key}"`);
	}
}

function finiteNumber(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path}: expected a finite number`);
	return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
	const parsed = finiteNumber(value, path);
	if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${path}: expected a non-negative integer`);
	return parsed;
}

function validateEnum(schema: Record<string, unknown>, path: string): void {
	if (schema.enum === undefined) return;
	if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
		throw new Error(`${path}.enum: expected a non-empty array`);
	}
	const seen = new Set<string>();
	for (const [index, item] of schema.enum.entries()) {
		const encoded = canonicalJson(item);
		if (seen.has(encoded)) throw new Error(`${path}.enum[${index}]: duplicate value`);
		seen.add(encoded);
	}
}

function validateParameterSchemaNode(value: unknown, path: string, depth: number): void {
	if (depth > MAX_SCHEMA_DEPTH) throw new Error(`${path}: JSON Schema nesting exceeds ${MAX_SCHEMA_DEPTH}`);
	if (!isPlainObject(value)) throw new Error(`${path}: expected a JSON Schema object`);
	const type = value.type;
	if (!(["array", "boolean", "integer", "number", "object", "string"] as unknown[]).includes(type)) {
		throw new Error(`${path}.type: expected object, array, string, number, integer, or boolean`);
	}
	if (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 1_000)) {
		throw new Error(`${path}.description: expected a string no longer than 1000 characters`);
	}
	validateEnum(value, path);
	if (Array.isArray(value.enum)) {
		for (const [index, item] of value.enum.entries()) {
			if (!valueMatchesType(item, type)) throw new Error(`${path}.enum[${index}]: value does not match ${String(type)}`);
		}
	}

	const common = ["type", "description", "enum", "default"];
	if (type === "object") {
		assertOnlyKeys(value, new Set([...common, "properties", "required", "additionalProperties"]), path);
		if (!isPlainObject(value.properties)) throw new Error(`${path}.properties: expected an object`);
		const entries = Object.entries(value.properties);
		if (entries.length > MAX_SCHEMA_PROPERTIES) {
			throw new Error(`${path}.properties: exceeds ${MAX_SCHEMA_PROPERTIES} properties`);
		}
		for (const [name, child] of entries) {
			if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || DANGEROUS_PROPERTY_NAMES.has(name)) {
				throw new Error(`${path}.properties: unsafe property name "${name}"`);
			}
			validateParameterSchemaNode(child, `${path}.properties.${name}`, depth + 1);
		}
		if (!Array.isArray(value.required) || value.required.some((item) => typeof item !== "string")) {
			throw new Error(`${path}.required: expected an array of property names`);
		}
		const required = value.required as string[];
		if (new Set(required).size !== required.length) throw new Error(`${path}.required: duplicate property name`);
		for (const name of required) {
			if (!Object.hasOwn(value.properties, name)) throw new Error(`${path}.required: unknown property "${name}"`);
		}
		if (value.additionalProperties !== false) {
			throw new Error(`${path}.additionalProperties: must be false`);
		}
	} else if (type === "array") {
		assertOnlyKeys(value, new Set([...common, "items", "minItems", "maxItems"]), path);
		validateParameterSchemaNode(value.items, `${path}.items`, depth + 1);
		const minItems = value.minItems === undefined ? 0 : nonNegativeInteger(value.minItems, `${path}.minItems`);
		const maxItems = value.maxItems === undefined ? 1_000 : nonNegativeInteger(value.maxItems, `${path}.maxItems`);
		if (minItems > maxItems) throw new Error(`${path}: minItems exceeds maxItems`);
	} else if (type === "string") {
		assertOnlyKeys(value, new Set([...common, "minLength", "maxLength"]), path);
		const min = value.minLength === undefined ? 0 : nonNegativeInteger(value.minLength, `${path}.minLength`);
		const max = value.maxLength === undefined ? 1_000_000 : nonNegativeInteger(value.maxLength, `${path}.maxLength`);
		if (min > max) throw new Error(`${path}: minLength exceeds maxLength`);
	} else if (type === "number" || type === "integer") {
		assertOnlyKeys(value, new Set([...common, "minimum", "maximum"]), path);
		const minimum = value.minimum === undefined ? -Infinity : finiteNumber(value.minimum, `${path}.minimum`);
		const maximum = value.maximum === undefined ? Infinity : finiteNumber(value.maximum, `${path}.maximum`);
		if (minimum > maximum) throw new Error(`${path}: minimum exceeds maximum`);
	} else {
		assertOnlyKeys(value, new Set(common), path);
	}
	if (value.default !== undefined) validateParameterValue(value.default, value, `${path}.default`);
}

function valueMatchesType(value: unknown, type: unknown): boolean {
	if (type === "array") return Array.isArray(value);
	if (type === "object") return isPlainObject(value);
	if (type === "integer") return typeof value === "number" && Number.isInteger(value);
	if (type === "number") return typeof value === "number" && Number.isFinite(value);
	return typeof value === type;
}

function validateParameterValue(value: unknown, schema: Record<string, unknown>, path: string): void {
	if (!valueMatchesType(value, schema.type)) throw new Error(`${path}: expected ${String(schema.type)}`);
	if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => canonicalJson(candidate) === canonicalJson(value))) {
		throw new Error(`${path}: value is not in enum`);
	}

	if (schema.type === "object") {
		const object = value as Record<string, unknown>;
		const properties = schema.properties as Record<string, Record<string, unknown>>;
		const required = schema.required as string[];
		for (const name of required) {
			if (!(name in object)) throw new Error(`${path}.${name}: required property is missing`);
		}
		for (const [name, child] of Object.entries(object)) {
			if (!Object.hasOwn(properties, name)) throw new Error(`${path}.${name}: unknown property`);
			const propertySchema = properties[name];
			if (!propertySchema) throw new Error(`${path}.${name}: invalid property schema`);
			validateParameterValue(child, propertySchema, `${path}.${name}`);
		}
	} else if (schema.type === "array") {
		const array = value as unknown[];
		if (schema.minItems !== undefined && array.length < (schema.minItems as number)) throw new Error(`${path}: too few items`);
		if (schema.maxItems !== undefined && array.length > (schema.maxItems as number)) throw new Error(`${path}: too many items`);
		for (const [index, child] of array.entries()) {
			validateParameterValue(child, schema.items as Record<string, unknown>, `${path}[${index}]`);
		}
	} else if (schema.type === "string") {
		const string = value as string;
		if (schema.minLength !== undefined && string.length < (schema.minLength as number)) throw new Error(`${path}: string is too short`);
		if (schema.maxLength !== undefined && string.length > (schema.maxLength as number)) throw new Error(`${path}: string is too long`);
	} else if (schema.type === "number" || schema.type === "integer") {
		const number = value as number;
		if (schema.minimum !== undefined && number < (schema.minimum as number)) throw new Error(`${path}: number is below minimum`);
		if (schema.maximum !== undefined && number > (schema.maximum as number)) throw new Error(`${path}: number is above maximum`);
	}
}

/** Validate the bounded JSON-Schema dialect Target tools use for contracts. */
export function validateTargetToolJsonSchema(
	value: unknown,
	path = "tool JSON Schema",
): Record<string, unknown> {
	validateParameterSchemaNode(value, path, 0);
	return value as Record<string, unknown>;
}

/** Validate one value against the same bounded dialect used for tool inputs. */
export function validateTargetToolJsonValue(
	value: unknown,
	schema: Record<string, unknown>,
	path = "tool JSON value",
): void {
	validateParameterValue(value, validateTargetToolJsonSchema(schema, `${path} schema`), path);
}

export function validateTargetToolArguments(tool: ResolvedTargetTool, value: unknown): Record<string, unknown> {
	validateParameterValue(value, tool.descriptor.parameters, `tool ${tool.descriptor.name} arguments`);
	return value as Record<string, unknown>;
}

function safeRelativeParts(path: string, label: string): string[] {
	if (!path || path.includes("\0") || isAbsolute(path) || path.includes("\\")) {
		throw new Error(`${label} must be a relative POSIX path: ${JSON.stringify(path)}`);
	}
	const parts = path.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) {
		throw new Error(`${label} contains an unsafe path component: ${path}`);
	}
	return parts;
}

/** Resolve a regular target file while rejecting every symlink component. */
export function resolveStrictTargetFile(rootDir: string, path: string, label: string): string {
	const root = realpathSync(resolve(rootDir));
	const parts = safeRelativeParts(path, label);
	let cursor = root;
	for (const [index, part] of parts.entries()) {
		cursor = resolve(cursor, part);
		const stat = lstatSync(cursor);
		if (stat.isSymbolicLink()) throw new Error(`${label} must not traverse a symlink: ${path}`);
		const final = index === parts.length - 1;
		if ((!final && !stat.isDirectory()) || (final && !stat.isFile())) {
			throw new Error(`${label} must resolve to a regular file: ${path}`);
		}
	}
	const canonical = realpathSync(cursor);
	const rel = relative(root, canonical);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(`${label} escapes the target repository: ${path}`);
	}
	return canonical;
}

/** Which of the two on-disk shapes a declared descriptor path names. */
export function classifyTargetToolDescriptorPath(
	descriptorPath: string,
): { layout: TargetToolLayout; name: string; directoryPath: string | null } | null {
	const single = TOOL_DESCRIPTOR_PATH.exec(descriptorPath)?.[1];
	if (single) return { layout: "single-file", name: single, directoryPath: null };
	const directory = TOOL_DIRECTORY_DESCRIPTOR_PATH.exec(descriptorPath)?.[1];
	if (directory) return { layout: "directory", name: directory, directoryPath: `tools/${directory}` };
	return null;
}

/**
 * Validate a parsed target-tool descriptor without consulting the filesystem.
 * Authoring code uses this at the trust boundary before it compiles descriptor
 * content into a proposal; runtime loading adds executable existence/mode
 * checks below.
 */
export function validateTargetToolDescriptor(
	value: unknown,
	descriptorPath: string,
	policy: TargetToolPolicyEnvelope,
): TargetToolDescriptor {
	const identity = classifyTargetToolDescriptorPath(descriptorPath);
	if (!identity) {
		throw new Error(`tool descriptor path must match tools/<name>.tool.yaml or tools/<name>/tool.yaml: ${descriptorPath}`);
	}
	const parsed = RawToolDescriptor.safeParse(value);
	if (!parsed.success) throw new Error(`${descriptorPath}: ${parsed.error.message}`);
	const descriptor = parsed.data as TargetToolDescriptor;
	const expectedBasename = identity.layout === "single-file" ? `${descriptor.name}.tool.yaml` : "tool.yaml";
	if (descriptor.name !== identity.name || basename(descriptorPath) !== expectedBasename) {
		throw new Error(`${descriptorPath}: descriptor name must match its filename`);
	}
	if (RESERVED_TOOL_NAMES.has(descriptor.name)) {
		throw new Error(`${descriptorPath}: tool name "${descriptor.name}" is reserved`);
	}
	validateTargetToolJsonSchema(descriptor.parameters, `${descriptorPath}.parameters`);

	if (new Set(descriptor.permissions.environment).size !== descriptor.permissions.environment.length) {
		throw new Error(`${descriptorPath}: duplicate environment permission`);
	}
	const globalEnvironment = new Set(policy.environmentAllowlist);
	for (const name of descriptor.permissions.environment) {
		if (!globalEnvironment.has(name)) {
			throw new Error(`${descriptorPath}: environment ${name} is not allowed by execution.environmentAllowlist`);
		}
	}
	if (policy.network === "deny" && descriptor.permissions.network === "allow") {
		throw new Error(`${descriptorPath}: network=allow exceeds the target execution policy`);
	}
	if (policy.sandbox === "off") {
		throw new Error(`${descriptorPath}: declarative tools require execution.sandbox=required or best-effort`);
	}

	const executablePath = descriptor.command.argv[0];
	if (identity.layout === "single-file") {
		if (descriptor.setup) throw new Error(`${descriptorPath}: setup requires the tools/<name>/ directory form`);
		if (descriptor.lockfiles) throw new Error(`${descriptorPath}: lockfiles require the tools/<name>/ directory form`);
		if (!executablePath?.startsWith("bin/")) {
			throw new Error(`${descriptorPath}: command argv[0] must be a target-relative bin/ path`);
		}
		return descriptor;
	}

	if (executablePath !== `${identity.directoryPath}/run`) {
		throw new Error(`${descriptorPath}: command argv[0] must be ${identity.directoryPath}/run`);
	}
	if (descriptor.lockfiles && new Set(descriptor.lockfiles).size !== descriptor.lockfiles.length) {
		throw new Error(`${descriptorPath}: duplicate lockfile declaration`);
	}
	for (const lockfile of descriptor.lockfiles ?? []) {
		if (lockfile === "tool.yaml" || lockfile === "run") {
			throw new Error(`${descriptorPath}: ${lockfile} is not a lockfile`);
		}
	}
	if (descriptor.setup) {
		const setupCommand = descriptor.setup.argv[0];
		if (!setupCommand || (setupCommand.includes("/") && !setupCommand.startsWith("/"))) {
			throw new Error(`${descriptorPath}: setup argv[0] must be a bare command name or an absolute path`);
		}
		if (policy.network === "deny" && descriptor.setup.network === "allow") {
			throw new Error(`${descriptorPath}: setup network=allow exceeds the target execution policy`);
		}
	}
	return descriptor;
}

/**
 * Enumerate every regular file in a multi-file tool directory. Symlinks,
 * special files, oversized trees, and unsafe names fail closed so a tool's
 * identity is exactly the bytes and modes a reviewer saw.
 */
function listToolDirectoryFiles(rootDir: string, directoryPath: string, name: string): TargetToolFile[] {
	const root = realpathSync(resolve(rootDir));
	const directoryRoot = resolve(root, ...directoryPath.split("/"));
	const files: TargetToolFile[] = [];
	let totalBytes = 0;
	const walk = (absolute: string, prefix: string, depth: number): void => {
		if (depth > MAX_TOOL_DIRECTORY_DEPTH) throw new Error(`tool ${name}: directory nesting exceeds ${MAX_TOOL_DIRECTORY_DEPTH}`);
		for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (!TOOL_DIRECTORY_FILE.test(entry.name) || entry.name === "." || entry.name === "..") {
				throw new Error(`tool ${name}: unsafe directory entry name ${JSON.stringify(entry.name)}`);
			}
			const child = join(absolute, entry.name);
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			const stat = lstatSync(child);
			if (stat.isSymbolicLink()) throw new Error(`tool ${name}: directory must not contain a symlink: ${relativePath}`);
			if (stat.isDirectory()) {
				walk(child, relativePath, depth + 1);
				continue;
			}
			if (!stat.isFile()) throw new Error(`tool ${name}: directory must contain only regular files: ${relativePath}`);
			if (files.length >= MAX_TOOL_DIRECTORY_FILES) {
				throw new Error(`tool ${name}: directory exceeds ${MAX_TOOL_DIRECTORY_FILES} files`);
			}
			const content = readFileSync(child);
			totalBytes += content.byteLength;
			if (totalBytes > MAX_TOOL_DIRECTORY_BYTES) {
				throw new Error(`tool ${name}: directory exceeds ${MAX_TOOL_DIRECTORY_BYTES} bytes`);
			}
			files.push({
				path: relativePath,
				executable: (stat.mode & 0o111) !== 0,
				bytes: content.byteLength,
				sha256: hashFile(content.toString("base64")),
			});
		}
	};
	walk(directoryRoot, "", 1);
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

function parseToolDescriptor(rootDir: string, descriptorPath: string, policy: TargetToolPolicyEnvelope): ResolvedTargetTool {
	const descriptorFile = resolveStrictTargetFile(rootDir, descriptorPath, "tool descriptor");
	let parsedYaml: unknown;
	try {
		parsedYaml = parseYaml(readFileSync(descriptorFile, "utf8"));
	} catch (error) {
		throw new Error(`${descriptorPath}: invalid YAML (${(error as Error).message})`);
	}
	const descriptor = validateTargetToolDescriptor(parsedYaml, descriptorPath, policy);
	const identity = classifyTargetToolDescriptorPath(descriptorPath);
	if (!identity) throw new Error(`${descriptorPath}: unsupported tool descriptor path`);
	const executablePath = descriptor.command.argv[0];
	if (!executablePath) throw new Error(`${descriptorPath}: command argv must not be empty`);
	// A multi-file tool proves its own shape before anything is resolved, so a
	// missing entry point reads as a contract violation rather than an ENOENT.
	const files = identity.layout === "directory"
		? listToolDirectoryFiles(rootDir, identity.directoryPath as string, descriptor.name)
		: [];
	if (identity.layout === "directory") {
		const run = files.find((file) => file.path === "run");
		if (!run || !run.executable) throw new Error(`${descriptorPath}: tools/${descriptor.name}/run must exist and be executable`);
		if (!files.some((file) => file.path === "tool.yaml")) {
			throw new Error(`${descriptorPath}: the descriptor must live inside the tool directory`);
		}
	}
	const executable = resolveStrictTargetFile(rootDir, executablePath, `tool ${descriptor.name} executable`);
	try {
		accessSync(executable, constants.X_OK);
	} catch {
		throw new Error(`${descriptorPath}: executable is not executable: ${executablePath}`);
	}
	const executableHash = hashFile(readFileSync(executable).toString("base64"));
	if (identity.layout === "single-file") {
		return {
			descriptorPath,
			layout: "single-file",
			directoryPath: null,
			executablePath,
			descriptor,
			executableHash,
			files: [],
			digest: hashValue({ descriptor, executable: { path: executablePath, hash: executableHash } }),
		};
	}

	const directoryPath = identity.directoryPath as string;
	const byPath = new Map(files.map((file) => [file.path, file] as const));
	const lockfiles = (descriptor.lockfiles ?? []).map((path) => {
		const file = byPath.get(path);
		if (!file) throw new Error(`${descriptorPath}: declared lockfile is missing: ${path}`);
		return { path, sha256: file.sha256 };
	});
	return {
		descriptorPath,
		layout: "directory",
		directoryPath,
		executablePath,
		descriptor,
		executableHash,
		files,
		digest: hashValue({
			descriptor,
			directory: directoryPath,
			files: files.map((file) => ({ path: file.path, executable: file.executable, hash: file.sha256 })),
			lockfiles,
		}),
	};
}

export function loadTargetTools(
	rootDir: string,
	descriptorPaths: readonly string[],
	policy: TargetToolPolicyEnvelope,
): { tools: ResolvedTargetTool[]; toolsetHash: string } {
	const seenPaths = new Set<string>();
	const seenNames = new Set<string>();
	const tools = descriptorPaths.map((path) => {
		if (seenPaths.has(path)) throw new Error(`duplicate tool descriptor path: ${path}`);
		seenPaths.add(path);
		const tool = parseToolDescriptor(rootDir, path, policy);
		if (seenNames.has(tool.descriptor.name)) throw new Error(`duplicate target tool name: ${tool.descriptor.name}`);
		seenNames.add(tool.descriptor.name);
		return tool;
	}).sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name));
	return {
		tools,
		toolsetHash: hashValue(tools.map((tool) => ({ name: tool.descriptor.name, digest: tool.digest }))),
	};
}
