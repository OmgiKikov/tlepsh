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

describe("CLI help", () => {
	it("keeps root help focused on the product journey", () => {
		const help = cliHelp(["--help"]);
		expect(help).toContain("open Builder Pi");
		expect(help).toContain("ahde resume");
		expect(help).toContain("Inside Builder Pi");
		expect(help).toContain("Advanced automation commands");
		expect(help).toContain("ahde calibrate --target <dir>                measure run-to-run noise (A/A)");
		expect(help).toContain("AHDE_HOME       user-level Builder credentials and settings (default: ~/.ahde)");
	});

	it("renders focused help for top-level commands", () => {
		expect(cliHelp(["run", "--help"])).toContain("Exit 0 = all pass");
		expect(cliHelp(["init", "--help"])).toContain("first Git commit");
		expect(cliHelp(["target", "--help"])).toContain("Requires a configured Target");
		expect(cliHelp(["calibrate", "--help"])).toContain("measure run-to-run noise");
		expect(cliHelp(["calibrate", "--help"])).toContain("never promotable");
	});

	it("renders focused help for nested automation actions", () => {
		expect(cliHelp(["corpus", "import", "--help"])).toContain("imports/ inbox");
		expect(cliHelp(["corpus", "publish", "--help"])).toContain("Builder corpus draft");
	});

	it("no longer advertises the deleted one-shot adapter commands", () => {
		const help = cliHelp(["--help"]);
		expect(help).not.toContain("  builder  ");
		expect(cliHelp(["corpus", "draft", "--help"])).toBe(help);
	});
});
