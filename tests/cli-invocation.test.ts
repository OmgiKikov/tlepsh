import { describe, expect, it } from "vitest";
import {
	CliInvocationError,
	detectEarlyCliExit,
	parseCliInvocation,
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
		{ name: "feedback list", argv: ["feedback", "list"], command: "feedback", action: "list" },
		{ name: "feedback list for a chosen Target", argv: ["feedback", "list", "--target", "./agent"], command: "feedback", action: "list" },
		{ name: "feedback clear", argv: ["feedback", "--target", "./agent", "clear"], command: "feedback", action: "clear" },
		{ name: "compare", argv: ["compare", "erun-a", "erun-b"], command: "compare", action: null },
		{ name: "diagnose", argv: ["diagnose", "erun-a"], command: "diagnose", action: null },
		{ name: "report", argv: ["report", "erun-a", "--out", "report.html"], command: "report", action: null },
		{ name: "candidate builder run", argv: ["candidate", "--target", "./agent", "--builder-run", "builder-1", "--development-corpus", "corpus-dev"], command: "candidate", action: null },
		{ name: "candidate refs", argv: ["candidate", "--target", "./agent", "--base", "main", "--branch", "candidate/x", "--proposal", "proposal-1", "--diagnosis", "diagnosis-1"], command: "candidate", action: null },
		{ name: "calibrate", argv: ["calibrate", "--target", "./agent"], command: "calibrate", action: null },
		{ name: "calibrate corpus", argv: ["calibrate", "--target", "./agent", "--repetitions", "3", "--project", "demo", "--corpus", "corpus-dev"], command: "calibrate", action: null },
		{ name: "review", argv: ["review", "--candidate", "candidate-1", "--recommend", "promote", "--reason", "passed"], command: "review", action: null },
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
		[["--target", "./agent", "stray"], /root accepts 0 positional arguments; got 1/],
		[["corpus", "list", "extra", "--project", "demo"], /corpus list accepts 0 positional arguments; got 1/],
		[["feedback", "clear", "extra"], /feedback clear accepts 0 positional arguments; got 1/],
	] as const)("rejects missing or excess positionals in %j", (argv, message) => {
		expect(() => parseCliInvocation(argv)).toThrow(message);
	});

	it.each([
		[["run"], /missing required flag --target for run/],
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
	] as const)("rejects contradictory command modes in %j", (argv, message) => {
		expect(() => parseCliInvocation(argv)).toThrow(message);
	});

	it.each([
		[["run", "--target", "./agent", "--label", "candidate"], /--label .* baseline, solo/],
		[["corpus", "import", "--project", "demo", "--name", "x", "--visibility", "public", "--file", "x.jsonl"], /--visibility .* development, sealed/],
		[["review", "--candidate", "candidate-1", "--recommend", "maybe", "--reason", "x"], /--recommend .* promote, reject/],
		[["evidence", "--port", "65536"], /--port .* between 0 and 65535/],
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
