import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cliHelp } from "../src/cli-help.js";
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

	it("promises exactly three questions and never hands work back as a command", () => {
		const working = persona.split("## How to work with the operator")[1]?.split("\n## ")[0] ?? "";
		expect(working).toContain("exactly three questions");
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
		expect(help).toContain("ahde check --target <dir> --candidate <id>   cheap screen: the failed cases, once");
		expect(help).toContain("ahde improve --target <dir> --until 90% --max-cycles 5");
		expect(help).toContain("candidate  calibrate  check  improve  search  review  promote  reject");
		expect(help).toContain("ahde search --target <dir> --candidates <id,id,id>");
		expect(help).toContain("ahde serve --target <dir> [--port N]         drive the Workbench over a local");
		expect(help).toContain("AHDE_HOME       user-level Builder credentials and settings (default: ~/.ahde)");
	});

	it("renders focused help for top-level commands", () => {
		expect(cliHelp(["run", "--help"])).toContain("Exit 0 = all pass");
		expect(cliHelp(["init", "--help"])).toContain("first Git commit");
		expect(cliHelp(["target", "--help"])).toContain("Requires a configured Target");
		expect(cliHelp(["calibrate", "--help"])).toContain("measure run-to-run noise");
		expect(cliHelp(["calibrate", "--help"])).toContain("never promotable");
		const check = cliHelp(["check", "--help"]);
		expect(check).toContain("Usage: ahde check --target <dir> --candidate <id>");
		expect(check).toContain("ONLY\nthe cases its source eval recorded as failing");
		expect(check).toContain("It is a screen, never evidence.");
		expect(check).toContain("a promotion that\ncites one is refused");
		expect(check).toContain("Exit 0 = promising, 1 = flat.");
		const improve = cliHelp(["improve", "--help"]);
		expect(improve).toContain("Usage: ahde improve --target <dir> --until <pass-rate> --max-cycles <n>");
		expect(improve).toContain("cheap check -> full\ndevelopment verification");
		expect(improve).toContain("`90%` or `0.9`");
		expect(improve).toContain("the sealed guardrail and the promotion are\nalways yours");
		expect(improve).toContain("--candidates N (1..4, default 1) makes each cycle a search instead of one guess");
		expect(improve).toContain("already ended rejected or not `improved`");
		const search = cliHelp(["search", "--help"]);
		expect(search).toContain("Usage: ahde search --target <dir> --candidates <id,id,id>");
		expect(search).toContain("Search, not one guess.");
		expect(search).toContain("BOTH score delta and cost ratio and is strictly better on one of them");
		expect(search).toContain("never reaches verification and is listed with that reason");
		expect(search).toContain("Sealed verification is not part of a search.");
		expect(search).toContain("never promotes, adopts, publishes, approves, or opens the holdout");
		expect(improve).toContain("It never promotes, adopts, publishes a corpus or approves a Spec.");
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
