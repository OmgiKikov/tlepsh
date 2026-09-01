import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cliHelp } from "../src/cli-help.js";
import { SEALED_GATE_POLICY } from "../src/domain/comparison-gate.js";
import { AHDE_BUILDER_COMMAND_NAMES } from "../src/builder/commands.js";

/** Every `/name` mentioned inside one fenced block or help section. */
function slashNames(text: string): string[] {
	return [...new Set([...text.matchAll(/\/([a-z][a-z-]*)/g)].map((match) => match[1] as string))];
}

describe("one Builder command list", () => {
	it("lists exactly the registered commands under Inside Builder Pi", () => {
		const section = cliHelp(["--help"]).split("Inside Builder Pi:")[1]?.split("\n\n")[0] ?? "";
		expect(slashNames(section)).toEqual([...AHDE_BUILDER_COMMAND_NAMES, "login", "model"]);
	});

	it("keeps the in-Builder /help reference equal to the registered commands", () => {
		const source = readFileSync(new URL("../src/builder/commands.ts", import.meta.url), "utf8");
		const reference = source.split("Commands:")[1]?.split("Every consequential step")[0] ?? "";
		expect(reference).not.toBe("");
		for (const name of AHDE_BUILDER_COMMAND_NAMES) expect(reference).toContain(`/${name}`);
		expect(reference).toContain("/login");
		expect(reference).toContain("/model");
	});

	it("keeps the README slash block equal to the registered commands", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
		const block = readme.split("The same loop has compact Pi commands:")[1]?.split("```")[1] ?? "";
		expect(block).not.toBe("");
		expect(slashNames(block).sort()).toEqual([...AHDE_BUILDER_COMMAND_NAMES].sort());
	});
});

describe("one Builder persona", () => {
	const persona = readFileSync(new URL("../builders/ahde/AGENTS.md", import.meta.url), "utf8");

	/** The `| say this | it means |` rows of the vocabulary table. */
	function vocabulary(): { say: string; means: string }[] {
		const table = persona.split("## Vocabulary")[1]?.split("\n## ")[0] ?? "";
		return table
			.split("\n")
			.filter((line) => line.startsWith("|") && !line.startsWith("|---") && !line.includes("Say this"))
			.map((line) => line.split("|").map((cell) => cell.trim()))
			.map((cells) => ({ say: cells[1] ?? "", means: cells[2] ?? "" }));
	}

	it("names the operator's shortcuts and no command AHDE does not register", () => {
		const listed = slashNames(persona.split("## Tools")[1]?.split("\n## ")[0] ?? "");
		expect([...listed].sort()).toEqual([...AHDE_BUILDER_COMMAND_NAMES].sort());
		// The three verbs are named first, exactly as /help orders them.
		expect(listed.slice(0, 3)).toEqual(["test", "fix", "ship"]);
	});

	it("speaks the operator's words and keeps the jargon in the “it means” column", () => {
		const rows = vocabulary();
		expect(rows.length).toBeGreaterThan(8);
		const say = rows.map((row) => row.say).join("\n");
		for (const word of ["tests", "тесты", "a change", "правка", "check it", "проверка", "ship it", "выкати"]) {
			expect(say).toContain(word);
		}
		// Nothing on the left may be machinery the operator never asked about.
		for (const jargon of ["corpus", "Spec", "Proposal", "candidate", "promote", "adopt", "holdout", "stage", "receipt"]) {
			expect(say).not.toContain(jargon);
		}
		const means = rows.map((row) => row.means).join("\n");
		for (const jargon of ["Spec", "corpus", "Proposal", "candidate verification", "sealed holdout"]) {
			expect(means).toContain(jargon);
		}
	});

	it("names the three question kinds without promising a false fixed count", () => {
		const working = persona.split("## How to work with the operator")[1]?.split("\n## ")[0] ?? "";
		expect(working).toContain("There are three kinds");
		expect(working).toContain("their count follows the work instead of being a marketing promise");
		expect(working).not.toContain("exactly three questions");
		expect(working).toMatch(/\*\*start testing\*\*/);
		expect(working).toMatch(/\*\*apply this change\*\*/);
		expect(working).toMatch(/\*\*ship it\*\*/);
		expect(working).toContain("Do the work.");
		expect(working).toContain("Never answer “use /test” or “type /apply”");
		// The stage machine is not the operator's vocabulary.
		expect(working).toContain("Never\n  narrate stages");
	});
});

describe("CLI help", () => {
	it("keeps root help focused on the product journey", () => {
		const help = cliHelp(["--help"]);
		expect(help).toContain("open Builder Pi");
		expect(help).toContain("ahde resume");
		expect(help).toContain("Inside Builder Pi");
		expect(help).toContain("Advanced automation commands");
		expect(help).toContain("compare  diagnose  regrade  report");
		expect(help).toContain("ahde calibrate --target <dir>                measure run-to-run noise (A/A)");
		// The screen's own form: `--builder-run` runs it where the skill puts it,
		// before the verification it exists to save.
		expect(help).toContain("ahde check --target <dir> --builder-run <id>  cheap screen: the failed cases, once");
		expect(help).toContain("(or --candidate <id> for an evaluated one)");
		expect(help).toContain("--project defaults to the Target's manifest id");
		expect(help).toContain("ahde improve --target <dir> --until 90% --max-cycles 5");
		expect(help).toContain("candidate  calibrate  check  improve  search  review  promote  reject");
		expect(help).toContain("ahde search --target <dir> --candidates <id,id,id>");
		expect(help).toContain("ahde serve --target <dir> [--port N]         drive the Workbench over a local");
		expect(help).toContain("AHDE_HOME       user-level Builder credentials and settings (default: ~/.ahde)");
	});

	it("routes a two-word command's help however the operator ordered it", () => {
		// The action can sit after a flag and its value; reading the first bare
		// token would find `demo` and silently fall back to the root page.
		for (const argv of [
			["corpus", "list", "--help"],
			["corpus", "--project", "demo", "list", "--help"],
			["corpus", "--target", "./agent", "list"],
		]) {
			expect(cliHelp(argv)).toContain("Usage: ahde corpus list");
		}
		expect(cliHelp(["spec", "--target", "./agent", "approve", "--help"]))
			.toContain("Usage: ahde spec approve");
		expect(cliHelp(["tool", "--target", "./agent", "try", "--help"]))
			.toContain("Usage: ahde tool try");
		// An unknown action still gets the product tour, not a wrong page.
		expect(cliHelp(["corpus", "--project", "demo", "delete"])).toContain("Agent Harness Development Environment");
	});

	it("states the sealed floor where a sealed corpus is created", () => {
		for (const command of [["corpus", "import"], ["corpus", "ingest"]]) {
			expect(cliHelp(command)).toContain(String(SEALED_GATE_POLICY.minTasks));
		}
		expect(cliHelp(["corpus", "import"])).toContain(`${SEALED_GATE_POLICY.minRepetitions} repetitions`);
		expect(cliHelp(["corpus", "import"])).toContain("promotion stays locked");
	});

	it("renders focused help for top-level commands", () => {
		expect(cliHelp(["run", "--help"])).toContain("Exit 0 = all pass");
		expect(cliHelp(["init", "--help"])).toContain("first Git commit");
		expect(cliHelp(["target", "--help"])).toContain("Requires a configured Target");
		expect(cliHelp(["calibrate", "--help"])).toContain("measure run-to-run noise");
		expect(cliHelp(["calibrate", "--help"])).toContain("never promotable");
		const check = cliHelp(["check", "--help"]);
		expect(check).toContain("ahde check --target <dir> --candidate <id>");
		expect(check).toContain("ahde check --target <dir> --builder-run <id>");
		expect(check).toContain("before the verification it exists to\nsave");
		expect(check).toContain("ONLY\nthe cases its source eval recorded as failing");
		expect(check).toContain("It is a screen, never evidence.");
		expect(check).toContain("promotion that cites one is refused");
		expect(check).toContain("Exit 0 = promising, 1 = flat, 2 = the\nscreen could not run at all.");
		const improve = cliHelp(["improve", "--help"]);
		expect(improve).toContain("Usage: ahde improve --target <dir> --until <pass-rate> --max-cycles <n>");
		expect(improve).toContain("cheap check -> full development verification");
		expect(improve).toContain("`90%` or `0.9`");
		expect(improve).toContain("the sealed guardrail and the promotion are\nalways yours");
		expect(improve).toContain("--candidates N (1..4, default 1) makes each cycle a search instead of one guess");
		expect(improve).toContain("already ended rejected or not `improved`");
		// No pretending about who writes the changes, and no pretending the
		// operator will see each diff before it lands.
		expect(improve).toContain("WHAT THE LOOP AUTHORS: nothing.");
		expect(improve).toContain("A headless\nproposal author is NOT shipped yet");
		expect(improve).toContain("WITHOUT showing you each diff");
		expect(improve).toContain("`via: improvement-loop`");
		expect(improve).toContain("WHICH PROPOSAL MATCHES");
		expect(improve).toContain("Not\nthe id of an eval run");
		expect(improve).not.toContain("--compound");
		expect(improve).toContain("stops and hands back");
		expect(improve).toContain("--resume <loopId> or drop the claim with --abandon <loopId>");
		expect(improve).toContain("--baseline-max-age <ms> bounds evidence reuse");
		const search = cliHelp(["search", "--help"]);
		expect(search).toContain("Usage: ahde search --target <dir> --candidates <id,id,id>");
		expect(search).toContain("Search, not one guess.");
		expect(search).toContain("BOTH score delta and cost ratio and is strictly better on one of them");
		expect(search).toContain("never reaches verification and is listed with that reason");
		expect(search).toContain("Sealed verification is not part of a search.");
		expect(search).toContain("never promotes, adopts, publishes, approves, or opens the holdout");
		expect(improve).toContain("It never promotes, adopts, publishes a corpus or approves a Spec.");
		const review = cliHelp(["review", "--help"]);
		expect(review).toContain("call prints its exact diff and refuses to record the review");
		expect(review).toContain("--proposal-hash");
		const serve = cliHelp(["serve", "--help"]);
		expect(serve).toContain("Usage: ahde serve --target <dir>");
		expect(serve).toContain("transport for the\nsame human gate, never an exemption from it");
		expect(serve).toContain("POST /v1/confirmations/<id>");
		expect(serve).toContain("A wrong hash, an unknown id, a second answer, an expiry, and\nshutdown are each refusals.");
		expect(serve).toContain("a body\nthat carries actor, actorId, approved, or confirmed is refused");
		expect(serve).toContain("Binds 127.0.0.1 only.");
		expect(serve).toContain("printed once to\nstderr");
		expect(serve).toContain("--allow-concurrent");
		const regrade = cliHelp(["regrade", "--help"]);
		expect(regrade).toContain("Usage: ahde regrade <evalRunId> --target <dir>");
		expect(regrade).toContain("without calling the\nTarget model again");
		expect(regrade).toContain("the graders it carried when its trace was recorded");
		expect(regrade).toContain("Sealed\nevidence stays sealed and prints counts only");
	});

	it("documents the loop the CLI can now finish on its own", () => {
		const help = cliHelp(["--help"]);
		expect(help).toContain("Change and ship, without leaving the terminal:");
		expect(help).toContain("spec approve  propose  apply  adopt");

		const spec = cliHelp(["spec", "approve", "--help"]);
		expect(spec).toContain("Usage: ahde spec approve --target <dir>");
		expect(spec).toContain("Running this command IS the approval");
		expect(spec).toContain("Approving the same content twice is a no-op");

		const propose = cliHelp(["propose", "--help"]);
		expect(propose).toContain("ahde propose --target <dir> --spec <id> --branch <ref>");
		expect(propose).toContain("The branch is read, never\nmerged");
		expect(propose).toContain("a change anywhere else is refused by name");
		expect(propose).toContain("Sealed holdout evidence\ncan never steer a proposal");

		const apply = cliHelp(["apply", "--help"]);
		expect(apply).toContain("Usage: ahde apply --target <dir> --builder-run <id>");
		expect(apply).toContain("the operator's checkout never\nmoves");
		expect(apply).toContain("candidate/<builder-run-id> and must not already exist");

		const adopt = cliHelp(["adopt", "--help"]);
		expect(adopt).toContain("Usage: ahde adopt --target <dir> --candidate <id>");
		expect(adopt).toContain("Running the command is the human confirmation.");
		expect(adopt).toContain("a candidate that was never promoted");
	});

	it("renders focused help for nested automation actions", () => {
		expect(cliHelp(["corpus", "import", "--help"])).toContain("imports/ inbox");
		expect(cliHelp(["corpus", "publish", "--help"])).toContain("Builder corpus draft");
		expect(cliHelp(["corpus", "inspect", "--help"])).toContain("--file imports/<file>");
		expect(cliHelp(["corpus", "inspect", "--help"])).toContain("a sealed row is never printed");
		expect(cliHelp(["corpus", "ingest", "--help"])).toContain("--recipe <json|@path>");
		expect(cliHelp(["corpus", "ingest", "--help"])).toContain("never a sealed row");
	});

	it("documents where a marked reply goes and how it becomes cases", () => {
		expect(cliHelp(["--help"])).toContain("ahde feedback list");
		expect(cliHelp(["target", "--help"])).toContain("imports/feedback.jsonl");
		expect(cliHelp(["target", "--help"])).toContain("/bad [note]");
		const list = cliHelp(["feedback", "list", "--help"]);
		expect(list).toContain("imports/feedback.jsonl");
		expect(list).toContain('"dialogue": { "column": "messages" }');
		expect(list).toContain("Full transcripts stay in the file");
		expect(cliHelp(["feedback", "clear", "--help"])).toContain("imports/feedback.<timestamp>.jsonl");
	});

	it("offers the growth log and the drift watch beside the loop commands", () => {
		const help = cliHelp(["--help"]);
		expect(help).toContain("ahde log --target <dir> [--project <id>]     the agent's growth, version by version");
		expect(help).toContain("ahde watch --target <dir> [--every 1d]       the basket on a schedule; drift vs noise");
		expect(help).toContain("log  watch");

		const log = cliHelp(["log", "--help"]);
		expect(log).toContain("Usage: ahde log --target <dir> [--project <id>] [--limit N] [--json]");
		expect(log).toContain("One row per promotion, newest first");
		expect(log).toContain("Rejections appear as dimmed rows");
		expect(log).toContain("never evidence for one — per-task flips never decide a verdict");
		expect(log).toContain("A sealed row carries a verdict and a size and nothing else");
		expect(log).toContain("A pure read. No model call, nothing written");

		const watch = cliHelp(["watch", "--help"]);
		expect(watch).toContain("Usage: ahde watch --target <dir>");
		expect(watch).toContain("the pair is an A/A\nexperiment and the honest verdict is `inconclusive`");
		expect(watch).toContain("harness revision did not change");
		expect(watch).toContain("watch does not invent a root cause from scores alone");
		expect(watch).toContain("On an unchanged revision a gain is not a win.");
		expect(watch).toContain("`noise not calibrated`");
		expect(watch).toContain("nothing is promoted, adopted, or written as a receipt");
		expect(watch).toContain("watch stores nothing new");
		expect(watch).toContain("Exit 0 = healthy,\n3 = drift, 2 = no comparable baseline yet.");
	});

	it("no longer advertises the deleted one-shot adapter commands", () => {
		const help = cliHelp(["--help"]);
		expect(help).not.toContain("  builder  ");
		expect(cliHelp(["corpus", "draft", "--help"])).toBe(help);
	});
});
