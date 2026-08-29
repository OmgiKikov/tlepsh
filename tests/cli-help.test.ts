import { describe, expect, it } from "vitest";
import { cliHelp } from "../src/cli-help.js";

describe("CLI help", () => {
	it("keeps root help focused on the product journey", () => {
		const help = cliHelp(["--help"]);
		expect(help).toContain("open Builder Pi");
		expect(help).toContain("ahde resume");
		expect(help).toContain("Inside Builder Pi");
		expect(help).toContain("Advanced automation commands");
		expect(help).toContain("AHDE_HOME       user-level Builder credentials and settings (default: ~/.ahde)");
	});

	it("renders focused help for top-level commands", () => {
		expect(cliHelp(["run", "--help"])).toContain("Exit 0 = all pass");
		expect(cliHelp(["init", "--help"])).toContain("first Git commit");
		expect(cliHelp(["target", "--help"])).toContain("Requires a configured Target");
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
