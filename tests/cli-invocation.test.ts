import { describe, expect, it } from "vitest";
import {
	CLI_COMMANDS,
	CliInvocationError,
	detectEarlyCliExit,
	parseCliInvocation,
	type CliCommand,
	type ParsedCliInvocation,
} from "../src/cli-invocation.js";

function commandInvocation(argv: readonly string[]): ParsedCliInvocation {
	const result = parseCliInvocation(argv);
	expect(result.kind).toBe("command");
	return result as ParsedCliInvocation;
}

describe("side-effect-free CLI invocation parsing", () => {
	it("registers exactly the product's eight commands beside the root", () => {
		expect([...CLI_COMMANDS]).toEqual(["root", "builder-pi", "continue", "resume", "target", "evidence", "init", "run", "validate"]);
	});

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
		{ name: "root", argv: [], command: "root" },
		{ name: "root flags", argv: ["--target", "./agent", "--project", "demo", "--port", "0"], command: "root" },
		{ name: "Builder Pi", argv: ["builder-pi", "--target", "./agent", "--project", "demo", "--port", "4312"], command: "builder-pi" },
		{ name: "continue", argv: ["continue", "--target", "./agent"], command: "continue" },
		{ name: "resume", argv: ["resume", "--target", "./agent", "--project", "demo"], command: "resume" },
		{ name: "Target", argv: ["target", "--target", "./agent", "--message", "research this"], command: "target" },
		{ name: "evidence", argv: ["evidence", "--port", "4312"], command: "evidence" },
		{ name: "init", argv: ["init", "./agent", "--template", "./template"], command: "init" },
		{ name: "run", argv: ["run", "--target", "./agent", "--task", "current-sources", "--repetitions", "2", "--label", "baseline"], command: "run" },
		{ name: "run with a job bound", argv: ["run", "--target", "./agent", "--jobs", "4"], command: "run" },
		{ name: "run corpus", argv: ["run", "--target", "./agent", "--project", "demo", "--corpus", "corpus-dev"], command: "run" },
		{ name: "validate", argv: ["validate", "--target", "./agent", "--dataset", "evals/dev.jsonl"], command: "validate" },
	] satisfies Array<{ name: string; argv: string[]; command: CliCommand }>)("recognizes $name", ({ argv, command }) => {
		expect(commandInvocation(argv).command).toBe(command);
	});

	it("returns immutable normalized flags and positionals without mutating argv", () => {
		const argv = Object.freeze(["init", "./agent", "--template", "python-support"]);
		const before = [...argv];
		const parsed = commandInvocation(argv);
		expect(parsed).toEqual({
			kind: "command",
			command: "init",
			flags: { template: "python-support" },
			positionals: ["./agent"],
		});
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.flags)).toBe(true);
		expect(Object.isFrozen(parsed.positionals)).toBe(true);
		expect([...argv]).toEqual(before);
	});

	it.each([
		// The commands that used to live here belong to the Builder conversation now.
		[["wat"], /unknown command "wat"/],
		[["candidate", "--target", "./agent"], /unknown command "candidate"/],
		[["improve", "--target", "./agent", "--until", "90%"], /unknown command "improve"/],
		[["corpus", "list", "--project", "demo"], /unknown command "corpus"/],
		[["serve"], /unknown command "serve"/],
		[["apply", "--target", "./agent", "--builder-run", "builder-1"], /unknown command "apply"/],
		[["run", "--target", "./agent", "--wat", "value"], /unknown flag --wat for run/],
		[["builder-pi", "-x", "value"], /unknown flag -x for builder-pi/],
		[["run", "--target=./agent"], /unknown flag --target=\.\/agent for run/],
		[["run", "--target", "a", "--target", "b"], /duplicate flag --target for run/],
		[["run", "--target"], /missing value for --target in run/],
		[["run", "--target", "--task", "one"], /missing value for --target in run/],
		[["target", "--message", ""], /missing value for --message in target/],
		[["init"], /init requires 1 positional argument; got 0/],
		[["init", "a", "b"], /init accepts 1 positional argument; got 2/],
		[["--target", "./agent", "stray"], /root accepts 0 positional arguments; got 1/],
		[["run"], /missing required flag --target for run/],
		[["validate"], /missing required flag --target for validate/],
		[["run", "--target", "./agent", "--dataset", "dev.jsonl", "--corpus", "corpus-dev", "--project", "demo"], /cannot combine --dataset with --corpus/],
		[["run", "--target", "./agent", "--corpus", "corpus-dev"], /missing required flag --project for run with --corpus/],
		[["run", "--target", "./agent", "--label", "candidate"], /--label for run must be one of baseline, solo/],
		[["run", "--target", "./agent", "--repetitions", "0"], /--repetitions for run must be at least 1/],
		[["run", "--target", "./agent", "--repetitions", "two"], /--repetitions for run must be an integer/],
		[["run", "--target", "./agent", "--jobs", "65"], /--jobs for run must be between 1 and 64/],
		[["evidence", "--port", "70000"], /--port for evidence must be between 0 and 65535/],
	] as const)("rejects %j", (argv, expected) => {
		expect(() => parseCliInvocation(argv)).toThrow(expected);
		expect(() => parseCliInvocation(argv)).toThrow(CliInvocationError);
	});

	it("uses a dedicated error type for callers that want usage exit code 1", () => {
		try {
			parseCliInvocation(["wat"]);
			throw new Error("expected a CliInvocationError");
		} catch (error) {
			expect(error).toBeInstanceOf(CliInvocationError);
			expect((error as Error).name).toBe("CliInvocationError");
		}
	});
});
