import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { ExecutionPolicyBlock, type ExecutionPolicyBlock as ExecutionPolicy } from "../manifest.js";
import { canonicalJson, hashValue } from "../provenance.js";
import {
	validateTargetToolDescriptor,
	validateTargetToolJsonSchema,
	validateTargetToolJsonValue,
	type TargetToolDescriptor,
	type TargetToolFilesystem,
} from "../target/tool-manifest.js";
import type { HarnessExecutionPolicyPatch } from "./harness-authoring.js";

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const SLOT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,199}$/;
const FILE_PATH = /^(?:[A-Za-z0-9._-]{1,64}\/){0,4}[A-Za-z0-9._-]{1,64}$/;
const FIXTURE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_IMPLEMENTATION_BYTES = 512 * 1024;
const MAX_TOOL_PACKAGE_FILES = 128;

const JsonObjectSchema = z.record(z.string(), z.unknown());

const ToolCredentialSlotSchema = z.strictObject({
	id: z.string().regex(SLOT_NAME, "credential id must be lowercase snake_case"),
	purpose: z.string().min(1).max(1_000),
	required: z.boolean().default(true),
});
export type ToolCredentialSlot = z.infer<typeof ToolCredentialSlotSchema>;

const ToolContractExpectationSchema = z.strictObject({
	exitCode: z.number().int().min(0).max(255).default(0),
	stdoutContains: z.string().min(1).max(8_192).optional(),
	stderrContains: z.string().min(1).max(8_192).optional(),
	jsonEquals: z.unknown().optional(),
});

const ToolContractFixtureSchema = z.strictObject({
	name: z.string().regex(FIXTURE_NAME, "fixture name must be lowercase kebab/snake case"),
	/** The contract dimension this real invocation proves. */
	covers: z.enum(["happy-path", "error-handling"]),
	input: z.unknown(),
	expect: ToolContractExpectationSchema,
}).superRefine((fixture, context) => {
	if (fixture.covers === "happy-path" && fixture.expect.exitCode !== 0) {
		context.addIssue({ code: "custom", path: ["expect", "exitCode"], message: "a happy-path fixture must exit 0" });
	}
	if (fixture.covers === "error-handling" && fixture.expect.exitCode === 0) {
		context.addIssue({ code: "custom", path: ["expect", "exitCode"], message: "an error-handling fixture must exit non-zero" });
	}
});
export type ToolContractFixture = z.infer<typeof ToolContractFixtureSchema>;

const ToolSupportFileSchema = z.strictObject({
	path: z.string().regex(FILE_PATH, "support file path must be a safe relative path"),
	content: z.string().min(1).max(MAX_IMPLEMENTATION_BYTES),
	mode: z.enum(["100644", "100755"]).default("100644"),
});

/**
 * Everything Builder Pi learns conversationally before it writes code. Secret
 * values and host environment names have no field in this schema: the model can
 * name only a logical credential slot such as `api_token`.
 */
export const ToolAuthoringBriefSchema = z.strictObject({
	name: z.string().regex(TOOL_NAME, "tool name must be lowercase snake_case"),
	purpose: z.string().min(1).max(2_000),
	dataSource: z.string().min(1).max(2_000),
	parameters: JsonObjectSchema,
	output: z.strictObject({
		format: z.enum(["json", "text"]),
		description: z.string().min(1).max(2_000),
		/** Required for JSON output; omitted for text output. */
		schema: JsonObjectSchema.optional(),
	}),
	errors: z.array(z.strictObject({
		condition: z.string().min(1).max(1_000),
		behavior: z.string().min(1).max(1_000),
	})).min(1).max(32),
	permissions: z.strictObject({
		network: z.enum(["deny", "allow"]),
		filesystem: z.enum(["read-only", "workspace-write"]),
		/** Every Target tool is a subprocess; this literal makes that fact reviewable. */
		process: z.literal("sandboxed-subprocess"),
	}),
	credentials: z.array(ToolCredentialSlotSchema).max(16).default([]),
	/**
	 * Complete executable, including a shebang. Use `{{credential.<id>}}` where
	 * code needs the host-selected environment name for a logical credential.
	 */
	implementation: z.string()
		.min(4)
		.max(MAX_IMPLEMENTATION_BYTES)
		.refine((value) => value.startsWith("#!") && value.includes("\n"), "implementation needs a shebang"),
	supportFiles: z.array(ToolSupportFileSchema).max(MAX_TOOL_PACKAGE_FILES - 6).default([]),
	setup: z.strictObject({
		argv: z.array(z.string().min(1).max(4_096)).min(1).max(32),
		timeoutMs: z.number().int().min(1).max(600_000),
		network: z.enum(["deny", "allow"]),
		lockfiles: z.array(z.string().regex(FILE_PATH)).max(8).default([]),
	}).optional(),
	fixtures: z.array(ToolContractFixtureSchema).min(2).max(32),
	timeoutMs: z.number().int().min(1).max(120_000).default(30_000),
	maxOutputBytes: z.number().int().min(1).max(1024 * 1024).default(64 * 1024),
}).superRefine((brief, context) => {
	if (brief.output.format === "json" && brief.output.schema === undefined) {
		context.addIssue({ code: "custom", path: ["output", "schema"], message: "JSON output needs a schema" });
	}
	if (brief.output.format === "text" && brief.output.schema !== undefined) {
		context.addIssue({ code: "custom", path: ["output", "schema"], message: "text output does not carry a JSON schema" });
	}
	const slots = brief.credentials.map((slot) => slot.id);
	if (new Set(slots).size !== slots.length) {
		context.addIssue({ code: "custom", path: ["credentials"], message: "credential ids must be unique" });
	}
	for (const slot of brief.credentials) {
		if (!brief.implementation.includes(`{{credential.${slot.id}}}`)) {
			context.addIssue({
				code: "custom",
				path: ["implementation"],
				message: `implementation must use {{credential.${slot.id}}}; the host substitutes the environment name`,
			});
		}
	}
	const reserved = new Set(["run", "tool.yaml", "input.schema.json", "output.schema.json", "contract-tests.json", "README.md"]);
	const support = brief.supportFiles.map((file) => file.path);
	if (new Set(support).size !== support.length) {
		context.addIssue({ code: "custom", path: ["supportFiles"], message: "support file paths must be unique" });
	}
	for (const path of support) {
		if (reserved.has(path) || path.startsWith("fixtures/")) {
			context.addIssue({ code: "custom", path: ["supportFiles"], message: `${path} is generated by AHDE` });
		}
	}
	for (const lockfile of brief.setup?.lockfiles ?? []) {
		if (!support.includes(lockfile)) {
			context.addIssue({ code: "custom", path: ["setup", "lockfiles"], message: `${lockfile} is not a support file` });
		}
	}
	for (const coverage of ["happy-path", "error-handling"] as const) {
		if (!brief.fixtures.some((fixture) => fixture.covers === coverage)) {
			context.addIssue({
				code: "custom",
				path: ["fixtures"],
				message: `fixtures need at least one ${coverage} case`,
			});
		}
	}
});
export type ToolAuthoringBrief = z.infer<typeof ToolAuthoringBriefSchema>;

export interface ToolPackageFile {
	/** Relative to `tools/<name>/`. */
	path: string;
	content: string;
	mode: "100644" | "100755";
}

export interface ToolPackageCapabilitySummary {
	network: "deny" | "allow";
	filesystem: TargetToolFilesystem;
	process: "sandboxed-subprocess";
	credentialSlots: { id: string; purpose: string; required: boolean }[];
}

export interface CompiledToolPackage {
	brief: ToolAuthoringBrief;
	descriptor: TargetToolDescriptor;
	files: ToolPackageFile[];
	fixtures: ToolContractFixture[];
	executionPolicy: ExecutionPolicy;
	executionPatch: HarnessExecutionPolicyPatch;
	capabilities: ToolPackageCapabilitySummary;
	packageHash: string;
}

function markdownList(values: readonly string[]): string {
	return values.map((value) => `- ${value}`).join("\n");
}

function credentialEnvironment(
	brief: ToolAuthoringBrief,
	bindings: Readonly<Record<string, string>>,
): string[] {
	const expected = brief.credentials.map((slot) => slot.id).sort();
	const actual = Object.keys(bindings).sort();
	if (canonicalJson(expected) !== canonicalJson(actual)) {
		throw new Error(`host credential bindings must match logical slots exactly (${expected.join(", ") || "none"})`);
	}
	const names = expected.map((id) => {
		const name = bindings[id];
		if (!name || !ENVIRONMENT_NAME.test(name)) {
			throw new Error(`the host binding for ${id} must be one environment-variable name`);
		}
		return name;
	});
	if (new Set(names).size !== names.length) throw new Error("two credential slots cannot silently share one host variable");
	return names;
}

function substituteCredentialNames(
	implementation: string,
	bindings: Readonly<Record<string, string>>,
): string {
	let compiled = implementation;
	for (const [id, environment] of Object.entries(bindings)) {
		compiled = compiled.split(`{{credential.${id}}}`).join(environment);
	}
	const unknown = /\{\{credential\.([^}]+)\}\}/.exec(compiled)?.[1];
	if (unknown) throw new Error(`implementation refers to unknown credential slot ${unknown}`);
	return compiled;
}

function outputSchema(brief: ToolAuthoringBrief): Record<string, unknown> {
	return brief.output.format === "json"
		? brief.output.schema as Record<string, unknown>
		: { type: "string", description: brief.output.description };
}

function readme(brief: ToolAuthoringBrief): string {
	return [
		`# ${brief.name}`,
		"",
		brief.purpose,
		"",
		"## Data source",
		"",
		brief.dataSource,
		"",
		"## Output",
		"",
		`${brief.output.format}: ${brief.output.description}`,
		"",
		"## Errors",
		"",
		markdownList(brief.errors.map((entry) => `${entry.condition} — ${entry.behavior}`)),
		"",
		"## Capabilities",
		"",
		markdownList([
			`network: ${brief.permissions.network}`,
			`filesystem: ${brief.permissions.filesystem}`,
			"process: sandboxed subprocess",
			`credentials: ${brief.credentials.length === 0 ? "none" : brief.credentials.map((slot) => slot.id).join(", ")}`,
		]),
		"",
	].join("\n");
}

/**
 * Compile one conversational brief into the complete, canonical package the
 * Workshop writes. This function has no filesystem or UI authority, making the
 * package format independently testable by CLI, TUI, and a future web host.
 */
export function compileToolPackage(input: {
	brief: ToolAuthoringBrief;
	credentialBindings: Readonly<Record<string, string>>;
	currentExecution: ExecutionPolicy;
}): CompiledToolPackage {
	const brief = ToolAuthoringBriefSchema.parse(input.brief);
	const currentExecution = ExecutionPolicyBlock.parse(input.currentExecution);
	const environment = credentialEnvironment(brief, input.credentialBindings);
	const implementation = substituteCredentialNames(brief.implementation, input.credentialBindings);
	const needsNetwork = brief.permissions.network === "allow" || brief.setup?.network === "allow";
	const executionPolicy = ExecutionPolicyBlock.parse({
		...currentExecution,
		environmentAllowlist: [...new Set([...currentExecution.environmentAllowlist, ...environment])].sort(),
		network: needsNetwork ? "allow" : currentExecution.network,
	});
	const executionPatch: HarnessExecutionPolicyPatch = {
		...(canonicalJson(executionPolicy.environmentAllowlist) === canonicalJson(currentExecution.environmentAllowlist)
			? {}
			: { environmentAllowlist: executionPolicy.environmentAllowlist }),
		...(executionPolicy.network === currentExecution.network ? {} : { network: executionPolicy.network }),
	};
	const descriptor: TargetToolDescriptor = {
		schemaVersion: 1,
		name: brief.name,
		description: brief.purpose,
		parameters: brief.parameters,
		command: { argv: [`tools/${brief.name}/run`] },
		timeoutMs: brief.timeoutMs,
		maxOutputBytes: brief.maxOutputBytes,
		output: brief.output.format,
		permissions: {
			environment,
			network: brief.permissions.network,
			filesystem: brief.permissions.filesystem,
		},
		...(brief.setup
			? {
				setup: { argv: brief.setup.argv, timeoutMs: brief.setup.timeoutMs, network: brief.setup.network },
				...(brief.setup.lockfiles.length > 0 ? { lockfiles: brief.setup.lockfiles } : {}),
			}
			: {}),
	};
	validateTargetToolDescriptor(descriptor, `tools/${brief.name}/tool.yaml`, executionPolicy);
	validateTargetToolJsonSchema(outputSchema(brief), `tools/${brief.name}/output.schema.json`);

	const files: ToolPackageFile[] = [
		{ path: "run", content: implementation, mode: "100755" },
		{ path: "input.schema.json", content: `${JSON.stringify(brief.parameters, null, 2)}\n`, mode: "100644" },
		{ path: "output.schema.json", content: `${JSON.stringify(outputSchema(brief), null, 2)}\n`, mode: "100644" },
		{
			path: "contract-tests.json",
			content: `${JSON.stringify({
				schemaVersion: 1,
				tool: brief.name,
				fixtures: brief.fixtures.map((fixture) => `fixtures/${fixture.name}.json`),
			}, null, 2)}\n`,
			mode: "100644",
		},
		{ path: "README.md", content: readme(brief), mode: "100644" },
		...brief.fixtures.map((fixture): ToolPackageFile => ({
			path: `fixtures/${fixture.name}.json`,
			content: `${JSON.stringify(fixture, null, 2)}\n`,
			mode: "100644",
		})),
		...brief.supportFiles,
		// Descriptor last: the workshop never observes a declared half-package.
		{ path: "tool.yaml", content: stringifyYaml(descriptor), mode: "100644" },
	];
	if (files.length > MAX_TOOL_PACKAGE_FILES) throw new Error(`tool package exceeds ${MAX_TOOL_PACKAGE_FILES} files`);
	const packageHash = hashValue(files.map((file) => ({ path: file.path, mode: file.mode, content: file.content })));
	return {
		brief,
		descriptor,
		files,
		fixtures: brief.fixtures,
		executionPolicy,
		executionPatch,
		capabilities: {
			network: brief.permissions.network,
			filesystem: brief.permissions.filesystem,
			process: brief.permissions.process,
			credentialSlots: brief.credentials.map((slot) => ({ ...slot })),
		},
		packageHash,
	};
}

export interface ToolContractObservation {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	truncated: boolean;
}

export interface ToolContractAssertion {
	passed: boolean;
	failures: string[];
}

/** Exact, deterministic assertion over one real Target-tool invocation. */
export function assertToolContract(
	fixture: ToolContractFixture,
	result: ToolContractObservation,
	outputJsonSchema?: Record<string, unknown>,
): ToolContractAssertion {
	const failures: string[] = [];
	if (result.timedOut) failures.push("timed out");
	if (result.truncated) failures.push("output was truncated");
	if (result.exitCode !== fixture.expect.exitCode) {
		failures.push(`expected exit ${fixture.expect.exitCode}, got ${result.exitCode ?? "killed"}`);
	}
	if (fixture.expect.stdoutContains !== undefined && !result.stdout.includes(fixture.expect.stdoutContains)) {
		failures.push(`stdout does not contain ${JSON.stringify(fixture.expect.stdoutContains)}`);
	}
	if (fixture.expect.stderrContains !== undefined && !result.stderr.includes(fixture.expect.stderrContains)) {
		failures.push(`stderr does not contain ${JSON.stringify(fixture.expect.stderrContains)}`);
	}
	if (fixture.expect.jsonEquals !== undefined || (fixture.expect.exitCode === 0 && outputJsonSchema !== undefined)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(result.stdout);
		} catch {
			failures.push("stdout is not valid JSON");
		}
		if (failures.length === 0 && outputJsonSchema !== undefined) {
			try {
				validateTargetToolJsonValue(parsed, outputJsonSchema, "stdout JSON");
			} catch (error) {
				failures.push(error instanceof Error ? error.message : String(error));
			}
		}
		if (
			failures.length === 0 &&
			fixture.expect.jsonEquals !== undefined &&
			canonicalJson(parsed) !== canonicalJson(fixture.expect.jsonEquals)
		) {
			failures.push("stdout JSON does not equal the expected value");
		}
	}
	return { passed: failures.length === 0, failures };
}
