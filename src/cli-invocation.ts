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
	"serve",
	"init",
	"run",
	"validate",
	"list",
	"failures",
	"corpus",
	"feedback",
	"tool",
	"compare",
	"diagnose",
	"regrade",
	"report",
	"label",
	"judge-agreement",
	"candidate",
	"calibrate",
	"check",
	"improve",
	"review",
	"promote",
	"reject",
] as const;

export type CliCommand = typeof CLI_COMMANDS[number];
export type CliAction = "publish" | "import" | "list" | "inspect" | "ingest" | "clear" | "try";

export type CliEarlyExit =
	| { kind: "help" }
	| { kind: "version" };

export interface ParsedCliInvocation {
	kind: "command";
	/** `root` is the default Builder Pi invocation with no command token. */
	command: CliCommand;
	action: CliAction | null;
	flags: Readonly<Record<string, string>>;
	positionals: readonly string[];
}

export type CliInvocation = CliEarlyExit | ParsedCliInvocation;

export class CliInvocationError extends Error {
	readonly name = "CliInvocationError";
}

interface InvocationSpec {
	flags: readonly string[];
	/**
	 * Flags in `flags` that take no value. They are still recorded as strings
	 * (`"true"`) so the parsed shape stays one map of names to values.
	 */
	booleanFlags?: readonly string[];
	requiredFlags?: readonly string[];
	positionals: number;
}

const ROOT_FLAGS = ["target", "project", "port"] as const;

const COMMAND_SPECS = {
	root: { flags: ROOT_FLAGS, positionals: 0 },
	"builder-pi": { flags: ROOT_FLAGS, positionals: 0 },
	continue: { flags: ROOT_FLAGS, positionals: 0 },
	resume: { flags: ROOT_FLAGS, positionals: 0 },
	target: { flags: ["target", "message"], positionals: 0 },
	evidence: { flags: ["port"], positionals: 0 },
	// The Workbench behind a loopback HTTP/JSON API whose human gate is the
	// platform's. `--host` exists to be explicit, not to reach the network.
	serve: {
		flags: ["target", "project", "port", "host", "token-file", "confirmation-timeout", "allow-concurrent"],
		booleanFlags: ["allow-concurrent"],
		positionals: 0,
	},
	init: { flags: ["template"], positionals: 1 },
	run: {
		flags: ["target", "task", "repetitions", "jobs", "label", "dataset", "project", "corpus"],
		requiredFlags: ["target"],
		positionals: 0,
	},
	validate: { flags: ["target", "dataset"], requiredFlags: ["target"], positionals: 0 },
	list: { flags: ["target"], positionals: 0 },
	failures: {
		flags: ["target", "project", "dataset", "out"],
		requiredFlags: ["target"],
		positionals: 1,
	},
	compare: { flags: [], positionals: 2 },
	diagnose: { flags: [], positionals: 1 },
	regrade: {
		flags: ["target", "graders", "label", "jobs", "project"],
		requiredFlags: ["target"],
		positionals: 1,
	},
	report: { flags: ["out", "project"], positionals: 1 },
	label: {
		flags: ["target", "project", "sample", "seed", "file"],
		requiredFlags: ["target"],
		positionals: 1,
	},
	"judge-agreement": { flags: ["target", "project"], requiredFlags: ["target"], positionals: 1 },
	candidate: {
		flags: [
			"target",
			"builder-run",
			"spec",
			"repetitions",
			"jobs",
			"baseline-max-age",
			"dataset",
			"development-corpus",
			"holdout-corpus",
			"project",
			"branch",
			"base",
			"proposal",
			"diagnosis",
			"actor",
		],
		requiredFlags: ["target"],
		positionals: 0,
	},
	calibrate: {
		flags: ["target", "repetitions", "project", "corpus"],
		requiredFlags: ["target"],
		positionals: 0,
	},
	// The cheap screen: the failed cases only, once, candidate arm only.
	check: {
		flags: ["target", "candidate", "project", "jobs"],
		requiredFlags: ["target", "candidate"],
		positionals: 0,
	},
	// The autoloop. `--until` is a pass rate, as `90%` or `0.9`.
	improve: {
		flags: ["target", "until", "max-cycles", "jobs", "project", "repetitions", "corpus"],
		requiredFlags: ["target", "until", "max-cycles"],
		positionals: 0,
	},
	review: {
		flags: ["candidate", "recommend", "reason", "actor"],
		requiredFlags: ["candidate", "recommend", "reason"],
		positionals: 0,
	},
	promote: {
		flags: ["target", "candidate", "to", "reason", "actor"],
		requiredFlags: ["target", "candidate", "to", "reason"],
		positionals: 0,
	},
	reject: {
		flags: ["candidate", "reason", "actor"],
		requiredFlags: ["candidate", "reason"],
		positionals: 0,
	},
} as const satisfies Record<Exclude<CliCommand, "corpus" | "feedback" | "tool">, InvocationSpec>;

const TOOL_ACTION_SPECS = {
	try: {
		flags: ["target", "tool", "input", "branch"],
		requiredFlags: ["target", "tool", "input"],
		positionals: 0,
	},
} as const satisfies Record<"try", InvocationSpec>;

const CORPUS_ACTION_SPECS = {
	publish: {
		flags: ["project", "draft", "name", "visibility"],
		requiredFlags: ["project", "draft", "name", "visibility"],
		positionals: 0,
	},
	import: {
		flags: ["project", "name", "visibility", "file"],
		requiredFlags: ["project", "name", "visibility", "file"],
		positionals: 0,
	},
	list: {
		flags: ["project"],
		requiredFlags: ["project"],
		positionals: 0,
	},
	inspect: {
		flags: ["project", "file", "sealed", "seed"],
		requiredFlags: ["project", "file"],
		positionals: 0,
	},
	ingest: {
		flags: ["project", "file", "recipe", "name", "sealed", "seed", "stratify-by"],
		requiredFlags: ["project", "file", "recipe", "name"],
		positionals: 0,
	},
} as const satisfies Record<"publish" | "import" | "list" | "inspect" | "ingest", InvocationSpec>;

const FEEDBACK_ACTION_SPECS = {
	list: { flags: ["target"], positionals: 0 },
	clear: { flags: ["target"], positionals: 0 },
} as const satisfies Record<"list" | "clear", InvocationSpec>;

const ACTION_COMMAND_SPECS: Readonly<Record<"corpus" | "feedback" | "tool", Readonly<Record<string, InvocationSpec>>>> = {
	corpus: CORPUS_ACTION_SPECS,
	feedback: FEEDBACK_ACTION_SPECS,
	tool: TOOL_ACTION_SPECS,
};
const COMMAND_NAMES = new Set<string>(CLI_COMMANDS.filter((command) => command !== "root"));

function cliError(message: string): never {
	throw new CliInvocationError(message);
}

/** Help is global; version is intentionally a root-only early exit. */
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
	booleanFlags: readonly string[] = [],
): { flags: Record<string, string>; positionals: string[] } {
	const allowed = new Set(allowedFlags);
	const booleans = new Set(booleanFlags);
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
		if (booleans.has(name)) {
			flags[name] = "true";
			continue;
		}
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

function validateSharedFlagValues(flags: Readonly<Record<string, string>>, context: string): void {
	// `regrade` is the one label no model call can produce, so only the command
	// that re-scores recorded traces may ask for it.
	assertEnumFlag(flags, "label", context === "regrade" ? ["baseline", "solo", "regrade"] : ["baseline", "solo"], context);
	assertEnumFlag(flags, "visibility", ["development", "sealed"], context);
	assertEnumFlag(flags, "recommend", ["promote", "reject"], context);
	// `ahde serve` binds loopback only; naming any other host is a usage error,
	// not something the server quietly reinterprets.
	assertEnumFlag(flags, "host", ["127.0.0.1", "localhost"], context);
	assertIntegerFlag(flags, "port", context, { minimum: 0, maximum: 65_535 });
	assertIntegerFlag(flags, "confirmation-timeout", context, { minimum: 1, maximum: 3_600 });
	assertIntegerFlag(flags, "repetitions", context, { minimum: 1 });
	assertIntegerFlag(flags, "sealed", context, { minimum: 1 });
	assertIntegerFlag(flags, "sample", context, { minimum: 1 });
	assertIntegerFlag(flags, "jobs", context, { minimum: 1, maximum: 64 });
	assertIntegerFlag(flags, "max-cycles", context, { minimum: 1, maximum: 10 });
	assertPassRateFlag(flags, "until", context);
	// 0 days means "never reuse a baseline"; every run measures its own.
	assertIntegerFlag(flags, "baseline-max-age", context, { minimum: 0, maximum: 3_650 });
}

/** A pass rate, written the way an operator says it: `90%`, `0.9`, or `90`. */
export function parsePassRateFlag(value: string): number | null {
	const text = value.trim();
	const percent = text.endsWith("%");
	const body = percent ? text.slice(0, -1).trim() : text;
	if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(body)) return null;
	const raw = Number(body);
	if (!Number.isFinite(raw)) return null;
	// `0.9` is a rate; `90` and `90%` are percentages. `1` is 100%, not 1%.
	const rate = percent || raw > 1 ? raw / 100 : raw;
	return rate >= 0 && rate <= 1 ? rate : null;
}

function assertPassRateFlag(
	flags: Readonly<Record<string, string>>,
	name: string,
	context: string,
): void {
	const value = flags[name];
	if (value === undefined) return;
	if (parsePassRateFlag(value) === null) {
		cliError(`--${name} for ${context} must be a pass rate such as 90% or 0.9; got ${JSON.stringify(value)}`);
	}
}

function assertInvocationSpec(
	parsed: { flags: Record<string, string>; positionals: string[] },
	spec: InvocationSpec,
	context: string,
): void {
	const allowed = new Set(spec.flags);
	for (const name of Object.keys(parsed.flags)) {
		if (!allowed.has(name)) cliError(`unknown flag --${name} for ${context}`);
	}
	for (const name of spec.requiredFlags ?? []) {
		if (parsed.flags[name] === undefined) cliError(`missing required flag --${name} for ${context}`);
	}
	if (parsed.positionals.length !== spec.positionals) {
		if (parsed.positionals.length < spec.positionals) {
			cliError(`${context} requires ${spec.positionals} positional argument${spec.positionals === 1 ? "" : "s"}; got ${parsed.positionals.length}`);
		}
		cliError(`${context} accepts ${spec.positionals} positional argument${spec.positionals === 1 ? "" : "s"}; got ${parsed.positionals.length}`);
	}
	validateSharedFlagValues(parsed.flags, context);
}

function freezeInvocation(
	command: CliCommand,
	action: CliAction | null,
	parsed: { flags: Record<string, string>; positionals: string[] },
): ParsedCliInvocation {
	return Object.freeze({
		kind: "command" as const,
		command,
		action,
		flags: Object.freeze({ ...parsed.flags }),
		positionals: Object.freeze([...parsed.positionals]),
	});
}

function unionFlags(specs: Readonly<Record<string, InvocationSpec>>): string[] {
	return [...new Set(Object.values(specs).flatMap((spec) => spec.flags))];
}

function parseActionCommand(
	command: "corpus" | "feedback" | "tool",
	tokens: readonly string[],
): ParsedCliInvocation {
	const specs = ACTION_COMMAND_SPECS[command];
	const actions = Object.keys(specs);
	const parsed = tokenize(tokens, unionFlags(specs), command);
	const actionToken = parsed.positionals.shift();
	if (actionToken === undefined) cliError(`missing action for ${command}; expected ${actions.join(", ")}`);
	const spec = actions.includes(actionToken) ? specs[actionToken] : undefined;
	if (!spec) {
		cliError(`unknown action ${JSON.stringify(actionToken)} for ${command}; expected ${actions.join(", ")}`);
	}
	const context = `${command} ${actionToken}`;
	assertInvocationSpec(parsed, spec, context);
	validateActionRelationships(context, parsed.flags);
	return freezeInvocation(command, actionToken as CliAction, parsed);
}

/** A sealed slice is a draw, not a count: it needs its seed to be reproducible. */
function validateActionRelationships(context: string, flags: Readonly<Record<string, string>>): void {
	const sealed = flags.sealed !== undefined;
	const seed = flags.seed !== undefined;
	if (sealed !== seed) {
		cliError(`${context} requires --sealed and --seed together; a sealed slice is reproduced from its seed`);
	}
	if (flags["stratify-by"] !== undefined && !sealed) {
		cliError(`--stratify-by for ${context} only applies to a sealed slice; add --sealed N --seed S`);
	}
}

function validateCommandRelationships(command: CliCommand, flags: Readonly<Record<string, string>>): void {
	if (command === "run") {
		if (flags.dataset !== undefined && flags.corpus !== undefined) {
			cliError("run cannot combine --dataset with --corpus");
		}
		if (flags.corpus !== undefined && flags.project === undefined) {
			cliError("missing required flag --project for run with --corpus");
		}
	}
	if (command === "calibrate" && flags.corpus !== undefined && flags.project === undefined) {
		cliError("missing required flag --project for calibrate with --corpus");
	}
	if (command === "improve" && flags.corpus !== undefined && flags.project === undefined) {
		cliError("missing required flag --project for improve with --corpus");
	}
	if (command !== "candidate") return;
	if (flags.dataset !== undefined && flags["development-corpus"] !== undefined) {
		cliError("candidate cannot combine --dataset with --development-corpus");
	}
	const refModeFlags = ["base", "branch", "proposal", "diagnosis"] as const;
	if (flags["builder-run"] !== undefined) {
		const conflicting = refModeFlags.find((name) => flags[name] !== undefined);
		if (conflicting) cliError(`candidate --builder-run cannot combine with --${conflicting}`);
		return;
	}
	const missing = refModeFlags.filter((name) => flags[name] === undefined);
	if (missing.length > 0) {
		cliError(`candidate requires --builder-run or all of ${refModeFlags.map((name) => `--${name}`).join(", ")}; missing ${missing.map((name) => `--${name}`).join(", ")}`);
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

	if (command === "corpus" || command === "feedback" || command === "tool") {
		return parseActionCommand(command, tokens);
	}
	const spec: InvocationSpec = COMMAND_SPECS[command];
	const parsed = tokenize(tokens, spec.flags, command, spec.booleanFlags ?? []);
	assertInvocationSpec(parsed, spec, command);
	validateCommandRelationships(command, parsed.flags);
	return freezeInvocation(command, null, parsed);
}
