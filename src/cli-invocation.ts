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
	"search",
	"review",
	"promote",
	"reject",
	"passport",
	// Wave 3, operator surfaces: what the agent became, and whether the ground
	// under an unchanged revision is still where it was.
	"log",
	"watch",
] as const;

export type CliCommand = typeof CLI_COMMANDS[number];
export type CliAction =
	| "publish"
	| "import"
	| "list"
	| "inspect"
	| "ingest"
	| "synth"
	| "clear"
	| "try";

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
	/**
	 * Positionals beyond `positionals` that may be given and need not be. Used
	 * where a word only writes the default out, so `ahde passport` and
	 * `ahde passport latest` are the same invocation.
	 */
	optionalPositionals?: number;
}

const ROOT_FLAGS = ["target", "project", "port"] as const;

const COMMAND_SPECS = {
	root: { flags: ROOT_FLAGS, positionals: 0 },
	"builder-pi": { flags: ROOT_FLAGS, positionals: 0 },
	continue: { flags: ROOT_FLAGS, positionals: 0 },
	resume: { flags: ROOT_FLAGS, positionals: 0 },
	target: { flags: ["target", "message"], positionals: 0 },
	evidence: { flags: ["port", "project"], positionals: 0 },
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
	// `--target <dir>` says whose runs to read, for an operator standing
	// somewhere else. It never changes what a diagnosis is.
	diagnose: { flags: ["target"], positionals: 1 },
	regrade: {
		flags: ["target", "graders", "label", "jobs", "project"],
		requiredFlags: ["target"],
		positionals: 1,
	},
	report: { flags: ["target", "out", "project"], positionals: 1 },
	label: {
		flags: ["target", "project", "spec", "sample", "seed", "file"],
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
		flags: ["target", "repetitions", "jobs", "project", "corpus"],
		requiredFlags: ["target"],
		positionals: 0,
	},
	// The cheap screen: the failed cases only, once, candidate arm only, for
	// one evaluated Candidate record.
	check: {
		flags: ["target", "candidate", "project", "jobs"],
		requiredFlags: ["target", "candidate"],
		positionals: 0,
	},
	// The autoloop. `--until` is a pass rate, as `90%` or `0.9`.
	// `--candidates N` (2..4) makes each cycle a search instead of one guess.
	// `--resume` and `--abandon` name an unfinished loop this project started.
	improve: {
		flags: [
			"target", "until", "max-cycles", "jobs", "project", "repetitions", "corpus", "candidates",
			"resume", "abandon", "baseline-max-age",
		],
		requiredFlags: ["target", "until", "max-cycles"],
		positionals: 0,
	},
	// Several hypotheses for one failure mode, compared in one Pareto table.
	// `--candidates` here is a comma-separated list of proposal run ids.
	search: {
		flags: ["target", "candidates", "jobs", "project", "repetitions", "corpus", "budget"],
		requiredFlags: ["target", "candidates"],
		positionals: 0,
	},
	review: {
		flags: ["candidate", "recommend", "reason", "actor", "proposal-hash"],
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
	// The agent's growth, version by version. A pure read over durable
	// candidate evidence: no model call, nothing written.
	log: {
		flags: ["target", "project", "limit", "json"],
		booleanFlags: ["json"],
		requiredFlags: ["target"],
		positionals: 0,
	},
	// The basket on a schedule. `--every` takes 30s | 5m | 2h | 1d.
	watch: {
		flags: ["target", "project", "corpus", "every", "once", "jobs", "repetitions", "max-runs"],
		booleanFlags: ["once"],
		requiredFlags: ["target"],
		positionals: 0,
	},
	// The client-facing page: promise beside measurement, for one shipped or
	// verified candidate. The lone positional is the bare word `latest`, which
	// is what the default already is.
	passport: {
		flags: ["target", "project", "candidate", "tag", "out", "json"],
		booleanFlags: ["json"],
		requiredFlags: ["target"],
		positionals: 0,
		optionalPositionals: 1,
	},
} as const satisfies Record<Exclude<CliCommand, "corpus" | "feedback" | "tool">, InvocationSpec>;

const TOOL_ACTION_SPECS = {
	try: {
		flags: ["target", "tool", "input", "branch"],
		requiredFlags: ["target", "tool", "input"],
		positionals: 0,
	},
} as const satisfies Record<"try", InvocationSpec>;

// `--target <dir>` names the Target the corpus belongs to, and its manifest id
// is the project. Naming the project by hand is still allowed and still wins;
// what it is no longer is the only way to say it, which is how a corpus used to
// end up under an id the rest of the flow then refused.
const CORPUS_ACTION_SPECS = {
	publish: {
		flags: ["project", "draft", "name", "visibility"],
		requiredFlags: ["project", "draft", "name", "visibility"],
		positionals: 0,
	},
	import: {
		flags: ["target", "project", "name", "visibility", "file"],
		requiredFlags: ["name", "visibility", "file"],
		positionals: 0,
	},
	list: {
		flags: ["target", "project"],
		positionals: 0,
	},
	inspect: {
		flags: ["target", "project", "file", "sealed", "seed"],
		requiredFlags: ["file"],
		positionals: 0,
	},
	ingest: {
		flags: ["target", "project", "file", "recipe", "name", "sealed", "seed", "stratify-by"],
		requiredFlags: ["file", "recipe", "name"],
		positionals: 0,
	},
	// The one command that WRITES a holdout instead of drawing one. `--project`
	// defaults to the Target id, so it is optional here and nowhere else in
	// `corpus`; `--seed` fixes which development cases are shown as format
	// examples and is not the row draw the other actions mean by that name.
	synth: {
		flags: ["target", "project", "sealed", "name", "seed", "from", "examples", "review"],
		requiredFlags: ["target", "sealed", "name"],
		positionals: 0,
	},
} as const satisfies Record<"publish" | "import" | "list" | "inspect" | "ingest" | "synth", InvocationSpec>;

const FEEDBACK_ACTION_SPECS = {
	list: { flags: ["target"], positionals: 0 },
	clear: { flags: ["target"], positionals: 0 },
} as const satisfies Record<"list" | "clear", InvocationSpec>;

type ActionCommand = "corpus" | "feedback" | "tool";

const ACTION_COMMAND_SPECS: Readonly<Record<ActionCommand, Readonly<Record<string, InvocationSpec>>>> = {
	corpus: CORPUS_ACTION_SPECS,
	feedback: FEEDBACK_ACTION_SPECS,
	tool: TOOL_ACTION_SPECS,
};
const ACTION_COMMANDS = new Set<string>(Object.keys(ACTION_COMMAND_SPECS));
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
	assertIntegerFlag(flags, "budget", context, { minimum: 1 });
	assertPassRateFlag(flags, "until", context);
	// 0 days means "never reuse a baseline"; every run measures its own.
	assertIntegerFlag(flags, "baseline-max-age", context, { minimum: 0, maximum: 3_650 });
	// `ahde log` and `ahde watch`: bounded rows and a bounded schedule.
	assertIntegerFlag(flags, "limit", context, { minimum: 1, maximum: MAX_LOG_ROWS });
	assertIntegerFlag(flags, "max-runs", context, { minimum: 1, maximum: MAX_WATCH_RUNS });
	assertDurationFlag(flags, "every", context);
}

/**
 * Bounds for the two wave-3 operator commands, restated here rather than
 * imported: argv validation stays free of application services (see the module
 * docstring). `src/application/watch.ts` owns the same interval and run
 * bounds; `MAX_LOG_ROWS` is the ceiling `--limit` may ask for, above the
 * default in `src/application/agent-log.ts`.
 */
const MAX_LOG_ROWS = 100;
const MAX_WATCH_RUNS = 1_000;
/**
 * Bounds for `corpus synth`, restated here for the same reason: argv validation
 * imports no application service. `src/application/sealed-synth.ts` owns
 * `MAX_SEALED_SYNTH_CASES` and `MAX_SEALED_SYNTH_EXAMPLES`.
 */
const MAX_SYNTH_CASES = 200;
const MAX_SYNTH_EXAMPLES = 20;
const MIN_WATCH_INTERVAL_MS = 10_000;
const MAX_WATCH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1_000;

const DURATION = /^(0|[1-9][0-9]*)(s|m|h|d)$/;
const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

/** A schedule written the way an operator says it: `30s`, `5m`, `2h`, `1d`. */
export function parseDurationFlag(value: string): number | null {
	const match = DURATION.exec(value.trim());
	if (!match) return null;
	const unit = DURATION_UNIT_MS[match[2] as string];
	if (unit === undefined) return null;
	const milliseconds = Number(match[1]) * unit;
	return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : null;
}

function assertDurationFlag(
	flags: Readonly<Record<string, string>>,
	name: string,
	context: string,
): void {
	const value = flags[name];
	if (value === undefined) return;
	const milliseconds = parseDurationFlag(value);
	if (milliseconds === null) {
		cliError(`--${name} for ${context} must be a duration such as 30s, 5m, 2h or 1d; got ${JSON.stringify(value)}`);
	}
	if (milliseconds < MIN_WATCH_INTERVAL_MS || milliseconds > MAX_WATCH_INTERVAL_MS) {
		cliError(`--${name} for ${context} must be between 10s and 30d`);
	}
}

/**
 * Hypotheses one search compares. Kept here rather than imported so argv
 * validation stays free of application services (see the module docstring).
 */
const MIN_SEARCH_CANDIDATE_IDS = 2;
const MAX_SEARCH_CANDIDATE_IDS = 4;
const PROPOSAL_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** `--candidates <id,id,id>`: two to four distinct proposal run ids. */
export function parseCandidateIdList(value: string): string[] {
	return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function assertProposalRunIdList(value: string, context: string): void {
	const ids = parseCandidateIdList(value);
	if (ids.length < MIN_SEARCH_CANDIDATE_IDS || ids.length > MAX_SEARCH_CANDIDATE_IDS) {
		cliError(
			`--candidates for ${context} must name between ${MIN_SEARCH_CANDIDATE_IDS} and ` +
			`${MAX_SEARCH_CANDIDATE_IDS} proposal run ids, comma-separated; got ${ids.length}`,
		);
	}
	if (new Set(ids).size !== ids.length) {
		cliError(`--candidates for ${context} lists the same proposal twice`);
	}
	for (const id of ids) {
		if (!PROPOSAL_RUN_ID.test(id)) {
			cliError(`--candidates for ${context} contains an invalid proposal run id ${JSON.stringify(id)}`);
		}
	}
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
	const mostPositionals = spec.positionals + (spec.optionalPositionals ?? 0);
	if (parsed.positionals.length < spec.positionals) {
		cliError(`${context} requires ${spec.positionals} positional argument${spec.positionals === 1 ? "" : "s"}; got ${parsed.positionals.length}`);
	}
	if (parsed.positionals.length > mostPositionals) {
		cliError(`${context} accepts ${mostPositionals} positional argument${mostPositionals === 1 ? "" : "s"}; got ${parsed.positionals.length}`);
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
	command: ActionCommand,
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
	// The project has to be sayable, one way or the other. `corpus publish`
	// takes a Builder draft id and no Target, so it still names it outright.
	if (context.startsWith("corpus ") && context !== "corpus publish" &&
		flags.project === undefined && flags.target === undefined) {
		cliError(`${context} requires --project <id> or --target <dir> (the Target id is the default project)`);
	}
	// `corpus synth` reads both flags differently: `--sealed N` is how many cases
	// to WRITE, and `--seed` fixes which development cases are shown as format
	// examples. Neither reproduces a row draw, so neither implies the other.
	if (context === "corpus synth") {
		assertIntegerFlag(flags, "sealed", context, { minimum: 1, maximum: MAX_SYNTH_CASES });
		assertIntegerFlag(flags, "examples", context, { minimum: 0, maximum: MAX_SYNTH_EXAMPLES });
		return;
	}
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
	if (command === "improve") {
		if (flags.corpus !== undefined && flags.project === undefined) {
			cliError("missing required flag --project for improve with --corpus");
		}
		// One flag, two readings, decided by the command: `improve --candidates`
		// counts hypotheses, `search --candidates` names them.
		assertIntegerFlag(flags, "candidates", "improve", { minimum: 1, maximum: MAX_SEARCH_CANDIDATE_IDS });
		assertIntegerFlag(flags, "baseline-max-age", "improve", { minimum: 0 });
		if (flags.resume !== undefined && flags.abandon !== undefined) {
			cliError("improve cannot combine --resume with --abandon; pick one loop and one verb");
		}
		for (const name of ["resume", "abandon"] as const) {
			const value = flags[name];
			if (value !== undefined && !/^loop_[a-z0-9]{6,32}$/.test(value)) {
				cliError(`--${name} for improve must be a loop id such as loop_m1k2j3abcd; got ${JSON.stringify(value)}`);
			}
		}
	}
	if (command === "search") {
		if (flags.corpus !== undefined && flags.project === undefined) {
			cliError("missing required flag --project for search with --corpus");
		}
		assertProposalRunIdList(flags.candidates as string, "search");
	}
	if (command === "watch") {
		if (flags.corpus !== undefined && flags.project === undefined) {
			cliError("missing required flag --project for watch with --corpus");
		}
		// One tick or a schedule; asking for both is asking two questions.
		if (flags.once !== undefined && flags.every !== undefined) {
			cliError("watch takes --once or --every, never both");
		}
		if (flags["max-runs"] !== undefined && flags.every === undefined) {
			cliError("--max-runs for watch bounds a schedule; add --every <30s|5m|2h|1d>");
		}
	}
	// A passport is about exactly one subject: the candidate, or the promotion
	// tag that names one, or the newest promotion when neither is given.
	if (command === "passport" && flags.candidate !== undefined && flags.tag !== undefined) {
		cliError("passport cannot combine --candidate with --tag");
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

	if (ACTION_COMMANDS.has(command)) {
		return parseActionCommand(command as ActionCommand, tokens);
	}
	const spec: InvocationSpec = COMMAND_SPECS[command as Exclude<CliCommand, ActionCommand>];
	const parsed = tokenize(tokens, spec.flags, command, spec.booleanFlags ?? []);
	assertInvocationSpec(parsed, spec, command);
	validateCommandRelationships(command, parsed.flags);
	return freezeInvocation(command, null, parsed);
}
