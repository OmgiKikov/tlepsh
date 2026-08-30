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
		expect(help).toContain("AHDE_HOME       user-level Builder credentials and settings (default: ~/.ahde)");
	});

	it("renders focused help for top-level commands", () => {
		expect(cliHelp(["run", "--help"])).toContain("Exit 0 = all pass");
		expect(cliHelp(["init", "--help"])).toContain("first Git commit");
		expect(cliHelp(["target", "--help"])).toContain("Requires a configured Target");
		expect(cliHelp(["calibrate", "--help"])).toContain("measure run-to-run noise");
		expect(cliHelp(["calibrate", "--help"])).toContain("never promotable");
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

	it("no longer advertises the deleted one-shot adapter commands", () => {
		const help = cliHelp(["--help"]);
		expect(help).not.toContain("  builder  ");
		expect(cliHelp(["corpus", "draft", "--help"])).toBe(help);
	});
});
