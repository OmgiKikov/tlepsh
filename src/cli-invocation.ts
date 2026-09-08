/**
 * Pure argv validation for the AHDE CLI.
 *
 * The input is `process.argv.slice(2)`. This module deliberately imports no
 * filesystem, environment, or application services so help/version and
 * malformed invocations can be handled before dotenv or Target state is read.
 */

export const CLI_COMMANDS = [
	"root",
	"builder-pi",
	"continue",
	"resume",
	"target",
	"evidence",
	"init",
	"run",
	"validate",
] as const;

export type CliCommand = typeof CLI_COMMANDS[number];

export type CliEarlyExit =
	| { kind: "help" }
	| { kind: "version" };

export interface ParsedCliInvocation {
	kind: "command";
	/** `root` is the default Builder Pi invocation with no command token. */
	command: CliCommand;
	flags: Readonly<Record<string, string>>;
	positionals: readonly string[];
}

export type CliInvocation = CliEarlyExit | ParsedCliInvocation;

export class CliInvocationError extends Error {
	readonly name = "CliInvocationError";
}

interface InvocationSpec {
	flags: readonly string[];
	requiredFlags?: readonly string[];
	positionals: number;
}

const ROOT_FLAGS = ["target", "project", "port"] as const;

const COMMAND_SPECS: Readonly<Record<CliCommand, InvocationSpec>> = {
	root: { flags: ROOT_FLAGS, positionals: 0 },
	"builder-pi": { flags: ROOT_FLAGS, positionals: 0 },
	continue: { flags: ROOT_FLAGS, positionals: 0 },
	resume: { flags: ROOT_FLAGS, positionals: 0 },
	target: { flags: ["target", "message"], positionals: 0 },
	evidence: { flags: ["port", "project"], positionals: 0 },
	init: { flags: ["template"], positionals: 1 },
	run: {
		flags: ["target", "task", "repetitions", "jobs", "label", "dataset", "project", "corpus"],
		requiredFlags: ["target"],
		positionals: 0,
	},
	validate: { flags: ["target", "dataset"], requiredFlags: ["target"], positionals: 0 },
};

const COMMAND_NAMES = new Set<string>(CLI_COMMANDS.filter((command) => command !== "root"));

function cliError(message: string): never {
	throw new CliInvocationError(message);
}

/** Help and version are answered before any command is validated. */
export function detectEarlyCliExit(argv: readonly string[]): CliEarlyExit | null {
	if (argv.length === 1 && argv[0] === "help") return { kind: "help" };
	if (argv.some((token) => token === "--help" || token === "-h")) return { kind: "help" };
	if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) return { kind: "version" };
	return null;
}

function tokenize(
	tokens: readonly string[],
	allowedFlags: readonly string[],
	context: string,
): { flags: Record<string, string>; positionals: string[] } {
	const allowed = new Set(allowedFlags);
	const flags: Record<string, string> = {};
	const positionals: string[] = [];

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (!token.startsWith("-")) {
			if (token.length === 0) cliError(`${context} contains an empty positional argument`);
			positionals.push(token);
			continue;
		}
		if (!token.startsWith("--") || token.length === 2) cliError(`unknown flag ${token} for ${context}`);
		const name = token.slice(2);
		if (!allowed.has(name)) cliError(`unknown flag --${name} for ${context}`);
		if (Object.hasOwn(flags, name)) cliError(`duplicate flag --${name} for ${context}`);
		const value = tokens[index + 1];
		if (value === undefined || value.length === 0 || value.startsWith("-")) {
			cliError(`missing value for --${name} in ${context}`);
		}
		flags[name] = value;
		index += 1;
	}

	return { flags, positionals };
}

function assertEnumFlag(
	flags: Readonly<Record<string, string>>,
	name: string,
	values: readonly string[],
	context: string,
): void {
	const value = flags[name];
	if (value !== undefined && !values.includes(value)) {
		cliError(`--${name} for ${context} must be one of ${values.join(", ")}; got ${JSON.stringify(value)}`);
	}
}

function assertIntegerFlag(
	flags: Readonly<Record<string, string>>,
	name: string,
	context: string,
	options: { minimum: number; maximum?: number },
): void {
	const value = flags[name];
	if (value === undefined) return;
	if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
		cliError(`--${name} for ${context} must be an integer`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < options.minimum ||
		(options.maximum !== undefined && parsed > options.maximum)) {
		const range = options.maximum === undefined
			? `at least ${options.minimum}`
			: `between ${options.minimum} and ${options.maximum}`;
		cliError(`--${name} for ${context} must be ${range}`);
	}
}

function validateFlagValues(flags: Readonly<Record<string, string>>, context: string): void {
	assertEnumFlag(flags, "label", ["baseline", "solo"], context);
	assertIntegerFlag(flags, "port", context, { minimum: 0, maximum: 65_535 });
	assertIntegerFlag(flags, "repetitions", context, { minimum: 1 });
	assertIntegerFlag(flags, "jobs", context, { minimum: 1, maximum: 64 });
}

function assertInvocationSpec(
	parsed: { flags: Record<string, string>; positionals: string[] },
	spec: InvocationSpec,
	context: string,
): void {
	for (const name of spec.requiredFlags ?? []) {
		if (parsed.flags[name] === undefined) cliError(`missing required flag --${name} for ${context}`);
	}
	if (parsed.positionals.length < spec.positionals) {
		cliError(`${context} requires ${spec.positionals} positional argument${spec.positionals === 1 ? "" : "s"}; got ${parsed.positionals.length}`);
	}
	if (parsed.positionals.length > spec.positionals) {
		cliError(`${context} accepts ${spec.positionals} positional argument${spec.positionals === 1 ? "" : "s"}; got ${parsed.positionals.length}`);
	}
	validateFlagValues(parsed.flags, context);
}

function validateCommandRelationships(command: CliCommand, flags: Readonly<Record<string, string>>): void {
	if (command !== "run") return;
	if (flags.dataset !== undefined && flags.corpus !== undefined) {
		cliError("run cannot combine --dataset with --corpus");
	}
	if (flags.corpus !== undefined && flags.project === undefined) {
		cliError("missing required flag --project for run with --corpus");
	}
}

/** Validate and parse argv without reading or mutating any external state. */
export function parseCliInvocation(argv: readonly string[]): CliInvocation {
	const early = detectEarlyCliExit(argv);
	if (early) return early;

	let command: CliCommand;
	let tokens: readonly string[];
	const first = argv[0];
	if (first === undefined || first.startsWith("-")) {
		command = "root";
		tokens = argv;
	} else {
		if (!COMMAND_NAMES.has(first)) cliError(`unknown command ${JSON.stringify(first)}`);
		command = first as Exclude<CliCommand, "root">;
		tokens = argv.slice(1);
	}

	const spec = COMMAND_SPECS[command];
	const parsed = tokenize(tokens, spec.flags, command);
	assertInvocationSpec(parsed, spec, command);
	validateCommandRelationships(command, parsed.flags);
	return Object.freeze({
		kind: "command" as const,
		command,
		flags: Object.freeze({ ...parsed.flags }),
		positionals: Object.freeze([...parsed.positionals]),
	});
}
