import { describe, expect, it } from "vitest";
import {
	CliInvocationError,
	detectEarlyCliExit,
	parseCliInvocation,
	parseDurationFlag,
	type CliAction,
	type CliCommand,
	type ParsedCliInvocation,
} from "../src/cli-invocation.js";

function commandInvocation(argv: readonly string[]): ParsedCliInvocation {
	const result = parseCliInvocation(argv);
	expect(result.kind).toBe("command");
	return result as ParsedCliInvocation;
}

describe("side-effect-free CLI invocation parsing", () => {
	it.each([
		[["--help"], { kind: "help" }],
		[["-h"], { kind: "help" }],
		[["help"], { kind: "help" }],
		[["run", "--help"], { kind: "help" }],
		[["--version"], { kind: "version" }],
		[["-v"], { kind: "version" }],
	] as const)("detects %j before command validation", (argv, expected) => {
		expect(detectEarlyCliExit(argv)).toEqual(expected);
		expect(parseCliInvocation(argv)).toEqual(expected);
	});

	it("keeps version root-only", () => {
		expect(detectEarlyCliExit(["builder-pi", "--version"])).toBeNull();
		expect(() => parseCliInvocation(["builder-pi", "--version"]))
			.toThrow(/unknown flag --version for builder-pi/);
	});

	it.each([
		{ name: "root", argv: [], command: "root", action: null },
		{ name: "root flags", argv: ["--target", "./agent", "--project", "demo", "--port", "0"], command: "root", action: null },
		{ name: "Builder Pi", argv: ["builder-pi", "--target", "./agent", "--project", "demo", "--port", "4312"], command: "builder-pi", action: null },
		{ name: "resume", argv: ["resume", "--target", "./agent", "--project", "demo"], command: "resume", action: null },
		{ name: "Target", argv: ["target", "--target", "./agent", "--message", "research this"], command: "target", action: null },
		{ name: "evidence", argv: ["evidence", "--port", "4312"], command: "evidence", action: null },
		{ name: "serve", argv: ["serve", "--target", "./agent"], command: "serve", action: null },
		{
			name: "serve with every knob the platform gets",
			argv: [
				"serve",
				"--target", "./agent",
				"--project", "demo",
				"--port", "4700",
				"--host", "127.0.0.1",
				"--token-file", "./serve.token",
				"--confirmation-timeout", "120",
				"--allow-concurrent",
			],
			command: "serve",
			action: null,
		},
		{ name: "init", argv: ["init", "./agent", "--template", "./template"], command: "init", action: null },
		{ name: "run", argv: ["run", "--target", "./agent", "--task", "current-sources", "--repetitions", "2", "--label", "baseline"], command: "run", action: null },
		{ name: "run with a job bound", argv: ["run", "--target", "./agent", "--jobs", "4"], command: "run", action: null },
		{
			name: "candidate with concurrency and baseline age bounds",
			argv: ["candidate", "--target", "./agent", "--builder-run", "b1", "--jobs", "2", "--baseline-max-age", "0"],
			command: "candidate",
			action: null,
		},
		{ name: "run corpus", argv: ["run", "--target", "./agent", "--project", "demo", "--corpus", "corpus-dev"], command: "run", action: null },
		{ name: "validate", argv: ["validate", "--target", "./agent", "--dataset", "evals/dev.jsonl"], command: "validate", action: null },
		{ name: "list", argv: ["list", "--target", "agent-id"], command: "list", action: null },
		{ name: "failures", argv: ["failures", "erun-1", "--target", "./agent", "--out", "failure.json"], command: "failures", action: null },
		{ name: "corpus publish", argv: ["corpus", "publish", "--project", "demo", "--draft", "draft-1", "--name", "dev", "--visibility", "development"], command: "corpus", action: "publish" },
		{ name: "corpus import", argv: ["corpus", "import", "--project", "demo", "--name", "holdout", "--visibility", "sealed", "--file", "tasks.jsonl"], command: "corpus", action: "import" },
		{ name: "corpus list", argv: ["corpus", "--project", "demo", "list"], command: "corpus", action: "list" },
		{ name: "corpus inspect", argv: ["corpus", "inspect", "--project", "demo", "--file", "imports/tickets.csv"], command: "corpus", action: "inspect" },
		{ name: "corpus inspect with the exam in force", argv: ["corpus", "inspect", "--project", "demo", "--file", "imports/tickets.csv", "--sealed", "40", "--seed", "exam-1"], command: "corpus", action: "inspect" },
		{ name: "corpus ingest", argv: ["corpus", "ingest", "--project", "demo", "--file", "imports/tickets.csv", "--recipe", "@recipe.json", "--name", "tickets"], command: "corpus", action: "ingest" },
		{ name: "corpus ingest with a stratified exam", argv: ["corpus", "ingest", "--project", "demo", "--file", "imports/tickets.csv", "--recipe", "{}", "--name", "tickets", "--sealed", "40", "--seed", "exam-1", "--stratify-by", "tier"], command: "corpus", action: "ingest" },
		// --target names the project the way every other command does: from the manifest.
		{ name: "corpus list by target", argv: ["corpus", "list", "--target", "./agent"], command: "corpus", action: "list" },
		{ name: "corpus import by target", argv: ["corpus", "import", "--target", "./agent", "--name", "holdout", "--visibility", "sealed", "--file", "tasks.jsonl"], command: "corpus", action: "import" },
		{ name: "corpus inspect by target", argv: ["corpus", "inspect", "--target", "./agent", "--file", "imports/tickets.csv"], command: "corpus", action: "inspect" },
		{ name: "corpus ingest by target", argv: ["corpus", "ingest", "--target", "./agent", "--file", "imports/tickets.csv", "--recipe", "{}", "--name", "tickets"], command: "corpus", action: "ingest" },
		{ name: "feedback list", argv: ["feedback", "list"], command: "feedback", action: "list" },
		{ name: "feedback list for a chosen Target", argv: ["feedback", "list", "--target", "./agent"], command: "feedback", action: "list" },
		{ name: "feedback clear", argv: ["feedback", "--target", "./agent", "clear"], command: "feedback", action: "clear" },
		{ name: "compare", argv: ["compare", "erun-a", "erun-b"], command: "compare", action: null },
		{ name: "diagnose", argv: ["diagnose", "erun-a"], command: "diagnose", action: null },
		{ name: "regrade", argv: ["regrade", "erun-a", "--target", "./agent"], command: "regrade", action: null },
		{
			name: "regrade with new graders and a job bound",
			argv: ["regrade", "erun-a", "--target", "./agent", "--graders", "./strict.yaml", "--label", "regrade", "--jobs", "4", "--project", "demo"],
			command: "regrade",
			action: null,
		},
		{ name: "report", argv: ["report", "erun-a", "--out", "report.html"], command: "report", action: null },
		{ name: "candidate builder run", argv: ["candidate", "--target", "./agent", "--builder-run", "builder-1", "--development-corpus", "corpus-dev"], command: "candidate", action: null },
		{ name: "candidate refs", argv: ["candidate", "--target", "./agent", "--base", "main", "--branch", "candidate/x", "--proposal", "proposal-1", "--diagnosis", "diagnosis-1"], command: "candidate", action: null },
		{ name: "check", argv: ["check", "--target", "./agent", "--candidate", "candidate-1"], command: "check", action: null },
		{ name: "check jobs", argv: ["check", "--target", "./agent", "--candidate", "candidate-1", "--project", "demo", "--jobs", "4"], command: "check", action: null },
		{ name: "check from an applied builder run", argv: ["check", "--target", "./agent", "--builder-run", "builder-1"], command: "check", action: null },
		{ name: "spec approve", argv: ["spec", "approve", "--target", "./agent"], command: "spec", action: "approve" },
		{
			name: "spec approve with every knob",
			argv: ["spec", "approve", "--target", "./agent", "--project", "demo", "--file", "spec.md", "--title", "Returns agent", "--actor", "kikov"],
			command: "spec",
			action: "approve",
		},
		{
			name: "propose from a branch",
			argv: ["propose", "--target", "./agent", "--spec", "spec-1", "--branch", "work/fix"],
			command: "propose",
			action: null,
		},
		{
			name: "propose bound to diagnosed evidence",
			argv: [
				"propose", "--target", "./agent", "--spec", "spec-1", "--branch", "work/fix",
				"--project", "demo", "--summary", "Answer contract",
				"--eval", "erun-1", "--mode", "failure-mode-0123456789abcdef01234567",
				"--run-id", "builder-returns-1",
			],
			command: "propose",
			action: null,
		},
		{ name: "apply", argv: ["apply", "--target", "./agent", "--builder-run", "builder-1"], command: "apply", action: null },
		{
			name: "apply onto a named branch",
			argv: ["apply", "--target", "./agent", "--builder-run", "builder-1", "--branch", "candidate/x", "--reason", "Reviewed the diff.", "--actor", "kikov"],
			command: "apply",
			action: null,
		},
		{ name: "adopt", argv: ["adopt", "--target", "./agent", "--candidate", "candidate-1"], command: "adopt", action: null },
		{ name: "improve percent", argv: ["improve", "--target", "./agent", "--until", "90%", "--max-cycles", "5"], command: "improve", action: null },
		{ name: "improve rate", argv: ["improve", "--target", "./agent", "--until", "0.9", "--max-cycles", "3", "--jobs", "2", "--project", "demo", "--repetitions", "2"], command: "improve", action: null },
		{ name: "improve with several hypotheses", argv: ["improve", "--target", "./agent", "--until", "90%", "--max-cycles", "2", "--candidates", "3"], command: "improve", action: null },
		{ name: "improve resuming a loop", argv: ["improve", "--target", "./agent", "--until", "90%", "--max-cycles", "3", "--resume", "loop_m1k2j3ab"], command: "improve", action: null },
		{ name: "improve abandoning a loop", argv: ["improve", "--target", "./agent", "--until", "90%", "--max-cycles", "3", "--abandon", "loop_m1k2j3ab", "--baseline-max-age", "0"], command: "improve", action: null },
		{ name: "search", argv: ["search", "--target", "./agent", "--candidates", "builder-1,builder-2"], command: "search", action: null },
		{ name: "search four", argv: ["search", "--target", "./agent", "--candidates", "builder-1,builder-2,builder-3,builder-4", "--project", "demo", "--jobs", "4", "--budget", "200"], command: "search", action: null },
		{ name: "calibrate", argv: ["calibrate", "--target", "./agent"], command: "calibrate", action: null },
		{ name: "calibrate corpus", argv: ["calibrate", "--target", "./agent", "--repetitions", "3", "--project", "demo", "--corpus", "corpus-dev"], command: "calibrate", action: null },
		// Flag drift the walkthrough hit: both of these were usage errors.
		{ name: "calibrate jobs", argv: ["calibrate", "--target", "./agent", "--jobs", "4"], command: "calibrate", action: null },
		{ name: "report target", argv: ["report", "erun-1", "--target", "./agent"], command: "report", action: null },
		// `--target` says whose runs/ to read, for an operator standing elsewhere.
		{ name: "diagnose target", argv: ["diagnose", "erun-1", "--target", "./agent"], command: "diagnose", action: null },
		{ name: "review", argv: ["review", "--candidate", "candidate-1", "--recommend", "promote", "--reason", "passed"], command: "review", action: null },
		{ name: "review exact automated proposal", argv: ["review", "--candidate", "candidate-1", "--recommend", "promote", "--reason", "passed", "--proposal-hash", `sha256:${"a".repeat(64)}`], command: "review", action: null },
		{ name: "promote", argv: ["promote", "--target", "./agent", "--candidate", "candidate-1", "--to", "1.2.3", "--reason", "approved"], command: "promote", action: null },
		{ name: "reject", argv: ["reject", "--candidate", "candidate-1", "--reason", "regressed"], command: "reject", action: null },
	] satisfies Array<{
		name: string;
		argv: string[];
		command: CliCommand;
		action: CliAction | null;
	}>)("recognizes $name", ({ argv, command, action }) => {
		const result = commandInvocation(argv);
		expect(result.command).toBe(command);
		expect(result.action).toBe(action);
	});

	it("returns immutable normalized flags and positionals without mutating argv", () => {
		const argv = Object.freeze(["failures", "erun-1", "--out", "bundle.json", "--target", "./agent"]);
		const before = [...argv];
		const result = commandInvocation(argv);

		expect(argv).toEqual(before);
		expect(result).toEqual({
			kind: "command",
			command: "failures",
			action: null,
			flags: { out: "bundle.json", target: "./agent" },
			positionals: ["erun-1"],
		});
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.flags)).toBe(true);
		expect(Object.isFrozen(result.positionals)).toBe(true);
	});

	it.each([
		[["wat"], /unknown command "wat"/],
		[["builder", "propose", "--target", "./agent"], /unknown command "builder"/],
		[["corpus", "delete", "--project", "demo"], /unknown action "delete" for corpus/],
		[["feedback"], /missing action for feedback; expected list, clear/],
		[["feedback", "purge"], /unknown action "purge" for feedback; expected list, clear/],
		[["feedback", "list", "--project", "demo"], /unknown flag --project for feedback/],
		[["run", "--target", "./agent", "--wat", "value"], /unknown flag --wat for run/],
		[["corpus", "list", "--project", "demo", "--file", "tasks.jsonl"], /unknown flag --file for corpus list/],
		[["builder-pi", "-x", "value"], /unknown flag -x for builder-pi/],
		[["run", "--target=./agent"], /unknown flag --target=\.\/agent for run/],
	] as const)("rejects unknown syntax in %j", (argv, message) => {
		expect(() => parseCliInvocation(argv)).toThrow(message);
	});

	it.each([
		[["run", "--target", "a", "--target", "b"], /duplicate flag --target for run/],
		[["run", "--target"], /missing value for --target in run/],
		[["run", "--target", "--task", "one"], /missing value for --target in run/],
		[["target", "--message", ""], /missing value for --message in target/],
	] as const)("rejects duplicate or valueless flags in %j", (argv, message) => {
		expect(() => parseCliInvocation(argv)).toThrow(message);
	});

	it.each([
		[["init"], /init requires 1 positional argument; got 0/],
		[["init", "a", "b"], /init accepts 1 positional argument; got 2/],
		[["compare", "only-one"], /compare requires 2 positional arguments; got 1/],
		[["compare", "a", "b", "c"], /compare accepts 2 positional arguments; got 3/],
		[["diagnose", "erun", "extra"], /diagnose accepts 1 positional argument; got 2/],
		[["regrade", "--target", "./agent"], /regrade requires 1 positional argument; got 0/],
		[["regrade", "erun-a", "erun-b", "--target", "./agent"], /regrade accepts 1 positional argument; got 2/],
		[["--target", "./agent", "stray"], /root accepts 0 positional arguments; got 1/],
		[["corpus", "list", "extra", "--project", "demo"], /corpus list accepts 0 positional arguments; got 1/],
		// One of the two has to be sayable; `corpus publish` has no Target at all.
		[["corpus", "list"], /corpus list requires --project <id> or --target <dir>/],
		[["corpus", "import", "--name", "x", "--visibility", "sealed", "--file", "x.jsonl"], /corpus import requires --project <id> or --target <dir>/],
		[["corpus", "publish", "--target", "./agent", "--draft", "d", "--name", "n", "--visibility", "development"], /unknown flag --target for corpus publish/],
		[["feedback", "clear", "extra"], /feedback clear accepts 0 positional arguments; got 1/],
	] as const)("rejects missing or excess positionals in %j", (argv, message) => {
		expect(() => parseCliInvocation(argv)).toThrow(message);
	});

	it.each([
		[["run"], /missing required flag --target for run/],
		[["regrade", "erun-a"], /missing required flag --target for regrade/],
		[["check", "--candidate", "candidate-1"], /missing required flag --target for check/],
		[["spec", "approve"], /missing required flag --target for spec approve/],
		[["propose", "--target", "./agent", "--branch", "work/fix"], /missing required flag --spec for propose/],
		[["propose", "--target", "./agent", "--spec", "spec-1"], /missing required flag --branch for propose/],
		[["apply", "--target", "./agent"], /missing required flag --builder-run for apply/],
		[["adopt", "--target", "./agent"], /missing required flag --candidate for adopt/],
		[["improve", "--target", "./agent", "--max-cycles", "3"], /missing required flag --until for improve/],
		[["improve", "--target", "./agent", "--until", "90%"], /missing required flag --max-cycles for improve/],
		[["improve", "--target", "./agent", "--until", "120%", "--max-cycles", "3"], /--until for improve must be a pass rate/],
		[["improve", "--target", "./agent", "--until", "soon", "--max-cycles", "3"], /--until for improve must be a pass rate/],
		[["improve", "--target", "./agent", "--until", "90%", "--max-cycles", "99"], /--max-cycles for improve must be between 1 and 10/],
		[["improve", "--target", "./agent", "--until", "90%", "--max-cycles", "3", "--corpus", "corpus-dev"], /missing required flag --project for improve with --corpus/],
		[["check", "--target", "./agent", "--candidate", "candidate-1", "--until", "90%"], /unknown flag --until for check/],
		[["improve", "--target", "./agent", "--until", "90%", "--max-cycles", "3", "--candidates", "5"], /--candidates for improve must be between 1 and 4/],
		[["improve", "--target", "./agent", "--until", "90%", "--max-cycles", "3", "--resume", "not-a-loop"], /--resume for improve must be a loop id/],
		[["improve", "--target", "./agent", "--until", "90%", "--max-cycles", "3", "--abandon", "nope"], /--abandon for improve must be a loop id/],
		[["improve", "--target", "./agent", "--until", "90%", "--max-cycles", "3", "--resume", "loop_aaaaaa", "--abandon", "loop_bbbbbb"], /cannot combine --resume with --abandon/],
		[["improve", "--target", "./agent", "--until", "90%", "--max-cycles", "3", "--baseline-max-age", "soon"], /--baseline-max-age for improve must be an integer/],
		[["improve", "--target", "./agent", "--until", "90%", "--max-cycles", "3", "--compound"], /unknown flag --compound for improve/],
		[["search", "--target", "./agent"], /missing required flag --candidates for search/],
		[["search", "--candidates", "builder-1,builder-2"], /missing required flag --target for search/],
		[["search", "--target", "./agent", "--candidates", "builder-1"], /--candidates for search must name between 2 and 4 proposal run ids/],
		[["search", "--target", "./agent", "--candidates", "b1,b2,b3,b4,b5"], /--candidates for search must name between 2 and 4 proposal run ids/],
		[["search", "--target", "./agent", "--candidates", "builder-1,builder-1"], /--candidates for search lists the same proposal twice/],
		[["search", "--target", "./agent", "--candidates", "builder-1,../etc"], /--candidates for search contains an invalid proposal run id/],
		[["search", "--target", "./agent", "--candidates", "b1,b2", "--corpus", "corpus-dev"], /missing required flag --project for search with --corpus/],
		[["calibrate"], /missing required flag --target for calibrate/],
		[["corpus", "publish", "--project", "demo"], /missing required flag --draft for corpus publish/],
		[["corpus", "inspect", "--project", "demo"], /missing required flag --file for corpus inspect/],
		[["corpus", "ingest", "--project", "demo", "--file", "imports/x.csv", "--name", "x"], /missing required flag --recipe for corpus ingest/],
		[["review", "--candidate", "candidate-1", "--recommend", "reject"], /missing required flag --reason for review/],
		[["promote", "--target", "./agent", "--candidate", "candidate-1", "--to", "1.0.0"], /missing required flag --reason for promote/],
	] as const)("rejects missing required flags in %j", (argv, message) => {
		expect(() => parseCliInvocation(argv)).toThrow(message);
	});

	it.each([
		[["run", "--target", "./agent", "--dataset", "dev.jsonl", "--corpus", "corpus-dev", "--project", "demo"], /cannot combine --dataset with --corpus/],
		[["run", "--target", "./agent", "--corpus", "corpus-dev"], /missing required flag --project for run with --corpus/],
		[["calibrate", "--target", "./agent", "--corpus", "corpus-dev"], /missing required flag --project for calibrate with --corpus/],
		[["candidate", "--target", "./agent", "--builder-run", "builder-1", "--dataset", "dev.jsonl", "--development-corpus", "corpus-dev"], /cannot combine --dataset with --development-corpus/],
		[["candidate", "--target", "./agent", "--builder-run", "builder-1", "--branch", "candidate/x"], /--builder-run cannot combine with --branch/],
		[["candidate", "--target", "./agent", "--base", "main"], /requires --builder-run or all of --base, --branch, --proposal, --diagnosis/],
		[["corpus", "inspect", "--project", "demo", "--file", "imports/x.csv", "--sealed", "10"], /corpus inspect requires --sealed and --seed together/],
		[["corpus", "ingest", "--project", "demo", "--file", "imports/x.csv", "--recipe", "{}", "--name", "x", "--seed", "exam-1"], /corpus ingest requires --sealed and --seed together/],
		[["corpus", "ingest", "--project", "demo", "--file", "imports/x.csv", "--recipe", "{}", "--name", "x", "--stratify-by", "tier"], /--stratify-by for corpus ingest only applies to a sealed slice/],
		[["check", "--target", "./agent"], /check requires --candidate or --builder-run/],
		[["check", "--target", "./agent", "--candidate", "candidate-1", "--builder-run", "builder-1"], /check cannot combine --candidate with --builder-run/],
		[["propose", "--target", "./agent", "--spec", "spec-1", "--branch", "work/fix", "--eval", "erun-1"], /propose requires --eval and --mode together; missing --mode/],
		[["propose", "--target", "./agent", "--spec", "spec-1", "--branch", "work/fix", "--mode", "failure-mode-0123456789abcdef01234567"], /propose requires --eval and --mode together; missing --eval/],
		[
			["propose", "--target", "./agent", "--spec", "spec-1", "--branch", "work/fix", "--eval", "erun-1", "--mode", "the-first-one"],
			/--mode for propose contains an invalid failure mode id "the-first-one"/,
		],
		[
			[
				"propose", "--target", "./agent", "--spec", "spec-1", "--branch", "work/fix", "--eval", "erun-1",
				"--mode", "failure-mode-0123456789abcdef01234567,failure-mode-0123456789abcdef01234567",
			],
			/--mode for propose lists the same failure mode twice/,
		],
	] as const)("rejects contradictory command modes in %j", (argv, message) => {
		expect(() => parseCliInvocation(argv)).toThrow(message);
	});

	it.each([
		[["run", "--target", "./agent", "--label", "candidate"], /--label .* baseline, solo/],
		// Only the command that re-scores recorded traces may ask for `regrade`.
		[["run", "--target", "./agent", "--label", "regrade"], /--label .* baseline, solo/],
		[["regrade", "erun-a", "--target", "./agent", "--label", "candidate"], /--label .* baseline, solo, regrade/],
		[["corpus", "import", "--project", "demo", "--name", "x", "--visibility", "public", "--file", "x.jsonl"], /--visibility .* development, sealed/],
		[["review", "--candidate", "candidate-1", "--recommend", "maybe", "--reason", "x"], /--recommend .* promote, reject/],
		[["evidence", "--port", "65536"], /--port .* between 0 and 65535/],
		// `ahde serve` binds loopback; naming another host is a usage error.
		[["serve", "--target", "./agent", "--host", "0.0.0.0"], /--host .* 127\.0\.0\.1, localhost/],
		[["serve", "--target", "./agent", "--confirmation-timeout", "0"], /--confirmation-timeout .* between 1 and 3600/],
		[["serve", "--target", "./agent", "--confirmation-timeout", "86400"], /--confirmation-timeout .* between 1 and 3600/],
		[["serve", "--target", "./agent", "--allow-concurrent", "yes"], /serve accepts 0 positional arguments; got 1/],
		[["run", "--target", "./agent", "--repetitions", "0"], /--repetitions .* at least 1/],
		[["corpus", "inspect", "--project", "demo", "--file", "imports/x.csv", "--sealed", "0", "--seed", "s"], /--sealed .* at least 1/],
		[["calibrate", "--target", "./agent", "--repetitions", "0"], /--repetitions .* at least 1/],
		[["calibrate", "--target", "./agent", "--holdout-corpus", "sealed-1"], /unknown flag --holdout-corpus for calibrate/],
		[["run", "--target", "./agent", "--jobs", "0"], /--jobs .* between 1 and 64/],
		[["run", "--target", "./agent", "--jobs", "65"], /--jobs .* between 1 and 64/],
		[
			["candidate", "--target", "./agent", "--builder-run", "b1", "--baseline-max-age", "2.5"],
			/--baseline-max-age .* must be an integer/,
		],
	] as const)("rejects invalid bounded flag values in %j", (argv, message) => {
		expect(() => parseCliInvocation(argv)).toThrow(message);
	});

	it("uses a dedicated error type for callers that want usage exit code 1", () => {
		try {
			parseCliInvocation(["unknown"]);
			expect.fail("expected invalid invocation");
		} catch (error) {
			expect(error).toBeInstanceOf(CliInvocationError);
		}
	});
});

/**
 * The two wave-3 operator commands. `log` is a pure read; `watch` is one tick
 * or a schedule, never both, and its interval is written the way an operator
 * says it.
 */
describe("ahde log and ahde watch", () => {
	it.each([
		{
			name: "log with every knob",
			argv: ["log", "--target", "./agent", "--project", "demo", "--limit", "5", "--json"],
			flags: { target: "./agent", project: "demo", limit: "5", json: "true" },
		},
		{
			name: "watch as a single tick",
			argv: ["watch", "--target", "./agent", "--once", "--repetitions", "2", "--jobs", "2"],
			flags: { target: "./agent", once: "true", repetitions: "2", jobs: "2" },
		},
		{
			name: "watch on a schedule",
			argv: ["watch", "--target", "./agent", "--project", "demo", "--corpus", "corpus-dev", "--every", "1d", "--max-runs", "7"],
			flags: { target: "./agent", project: "demo", corpus: "corpus-dev", every: "1d", "max-runs": "7" },
		},
	] as const)("parses $name", ({ argv, flags }) => {
		const parsed = commandInvocation(argv);
		expect(parsed.flags).toEqual(flags);
		expect(parsed.positionals).toEqual([]);
	});

	it.each([
		["30s", 30_000],
		["5m", 300_000],
		["2h", 7_200_000],
		["1d", 86_400_000],
		["nightly", null],
		["5", null],
		["1w", null],
		["0s", null],
	] as const)("reads --every %s the way an operator writes it", (value, expected) => {
		expect(parseDurationFlag(value)).toBe(expected);
	});

	it.each([
		[["log"], /missing required flag --target for log/],
		[["log", "--target", "./agent", "--limit", "0"], /--limit for log must be between 1 and 100/],
		[["watch"], /missing required flag --target for watch/],
		[["watch", "--target", "./agent", "--once", "--every", "5m"], /watch takes --once or --every, never both/],
		[["watch", "--target", "./agent", "--max-runs", "3"], /--max-runs for watch bounds a schedule/],
		[["watch", "--target", "./agent", "--every", "nightly"], /--every for watch must be a duration such as 30s, 5m, 2h or 1d/],
		[["watch", "--target", "./agent", "--every", "1s"], /--every for watch must be between 10s and 30d/],
		[["watch", "--target", "./agent", "--every", "60d"], /--every for watch must be between 10s and 30d/],
		[["watch", "--target", "./agent", "--corpus", "corpus-dev"], /missing required flag --project for watch with --corpus/],
		// A watch never runs a candidate arm, so there is no candidate to name.
		[["watch", "--target", "./agent", "--candidate", "cand-1"], /unknown flag --candidate for watch/],
		[["log", "--target", "./agent", "erun-1"], /log accepts 0 positional arguments; got 1/],
	] as const)("rejects %j", (argv, message) => {
		expect(() => parseCliInvocation(argv)).toThrow(message);
	});
});
