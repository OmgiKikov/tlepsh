import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cliHelp } from "../src/cli-help.js";
import {
	AHDE_BUILDER_COMMAND_NAMES,
	AHDE_BUILDER_COMMANDS,
	builderCommandsOfTier,
	renderBuilderHelp,
	type BuilderCommandTier,
} from "../src/builder/commands.js";
import { setLanguage } from "../src/i18n.js";

/** Every `/name` mentioned inside one fenced block or help section. */
function slashNames(text: string): string[] {
	return [...new Set([...text.matchAll(/\/([a-z][a-z-]*)/g)].map((match) => match[1] as string))];
}

describe("one Builder command list", () => {
	it("lists exactly the registered commands under Inside Builder Pi", () => {
		const section = cliHelp(["--help"]).split("Inside Builder Pi:")[1]?.split("\n\n")[0] ?? "";
		expect(slashNames(section)).toEqual([...AHDE_BUILDER_COMMAND_NAMES, "login", "model"]);
	});

	// The reference is rendered from the same table now, so the invariant has to
	// hold in every language: a translation that quietly drops a command is a bug.
	it("keeps the in-Builder /help all reference equal to the registered commands", () => {
		try {
			for (const lang of ["en", "ru"] as const) {
				setLanguage(lang);
				const reference = renderBuilderHelp(true).join("\n");
				expect(reference).not.toBe("");
				for (const name of AHDE_BUILDER_COMMAND_NAMES) expect(reference).toContain(`/${name}`);
				expect(reference).toContain("/login");
				expect(reference).toContain("/model");
				// And the default screen is the nine, never the twenty behind them.
				const core = renderBuilderHelp().join("\n");
				for (const command of AHDE_BUILDER_COMMANDS) {
					if (command.tier === "core") expect(core).toContain(`/${command.name}`);
					else expect(core).not.toContain(`/${command.name}`);
				}
			}
		} finally {
			setLanguage(null);
		}
	});

	it("keeps the README slash block equal to the registered commands", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
		const after = readme.split("The compact Pi commands below are optional expert shortcuts")[1] ?? "";
		const block = after.split("```")[1] ?? "";
		expect(block).not.toBe("");
		// The block a reader meets is the product: the same nine `/help` prints.
		const named = (tier: BuilderCommandTier): string[] =>
			builderCommandsOfTier(tier).map((command) => command.name).sort();
		expect(slashNames(block).sort()).toEqual(named("core"));
		// The rest is still documented, one fold down, and together they are
		// still every command AHDE registers.
		const folded = after.split("</summary>")[1]?.split("</details>")[0] ?? "";
		expect(folded).not.toBe("");
		expect(slashNames(folded).sort()).toEqual([...named("expert"), ...named("host-decision")].sort());
		expect([...slashNames(block), ...slashNames(folded)].sort())
			.toEqual([...AHDE_BUILDER_COMMAND_NAMES].sort());
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

	it("forbids narrating the machinery and pins the quote to the host's headline", () => {
		// Session 6 printed `вызову ahde_workbench_view`, `next говорит что
		// run-current …` and the English bullets of this very file at the
		// operator. Rule #1 is the block every message is written against, so
		// both rules live there rather than four screens down.
		const ruleOne = persona.split("## Rule #1")[1]?.split("\n## ")[0] ?? "";
		expect(ruleOne).toContain("Never retell the machinery to the operator");
		expect(ruleOne).toContain("«вызову ahde_workbench_view»");
		expect(ruleOne).toContain("`headline`");
		expect(ruleOne).toContain("quote it word for word");
		// The whole persona still fits the budget the host reads it under.
		expect(persona.trimEnd().split("\n").length).toBeLessThanOrEqual(300);
	});

	it("keeps slash commands out of the model-facing tool instructions", () => {
		const listed = slashNames(persona.split("## Tools")[1]?.split("\n## ")[0] ?? "");
		expect(listed).toEqual([]);
		expect(persona).toContain("Free text is the only required interface");
	});

	it("interviews for a tool one question at a time and keeps the key name host-side", () => {
		const section = persona.split("## Building a tool")[1]?.split("\n## ")[0] ?? "";
		expect(section).not.toBe("");
		expect(section).toContain("one question at a time");
		expect(section).toContain("only the questions whose answer changes the tool");
		for (const question of ["**purpose**", "**input and output**", "**data source**", "**errors**", "**permissions**", "**credential**"]) {
			expect(section).toContain(question);
		}
		// The name is the host's question and the value is nobody's.
		expect(section).toContain("Never the value, and never the variable name: the NAME is the\n  host's own question");
		expect(section).toContain("`fixtures/*.json`");
		expect(section).toContain("one deterministic error fixture");
		expect(persona).toContain("belongs in a\n  tool");
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
		for (const jargon of ["Spec", "corpus", "Proposal", "verify-candidate", "sealed holdout"]) {
			expect(means).toContain(jargon);
		}
	});

	it("offers noise once itself, and leaves the judge check to the host", () => {
		const loop = persona.split("## Typical loop")[1] ?? "";
		// Noise is still the persona's own single offer.
		expect(loop).toContain("offer that measurement once for this revision");
		expect(loop).toContain("it ships nothing");
		// The judge check is not: the host decides when it stands and says so in
		// `next`, so the persona carries no remembered rule about when to ask.
		expect(loop).toContain("The judge\n   check is the host's offer, not yours");
		expect(loop).toContain("appears in `next` as `label`");
		expect(loop).not.toContain("exactly once per revision");
	});

	it("offers the judge's exam once, with both modes in the sentence, and never authors one", () => {
		const loop = persona.split("## Typical loop")[1] ?? "";
		// The exact sentence, because the offer is one sentence or it is a lecture.
		expect(loop).toContain(
			"«Экзамена нет. Могу попросить судью\n   сгенерировать 20 закрытых кейсов из описания (я их не увижу), или сделать\n   черновик тебе на правку — что выбираешь?»",
		);
		expect(loop).toContain("Never author sealed cases\n   yourself");
		expect(loop).toContain("never offer this instead of real cases they already have");
		// The rule the offer lives under still refuses everything it refused.
		const rules = persona.split("## Rules that keep evidence honest")[1]?.split("\n## ")[0] ?? "";
		expect(rules).toContain("`generate-holdout`");
		expect(rules).toContain("you still never author, read, edit, or guess a sealed case");
		expect(rules).toContain("A model that writes the holdout has\n  read the holdout");
		expect(rules).toContain("never a case, and never\n  ask for one");
		expect(loop).toContain("recommend\n   the draft for a first exam");
		// The word the operator hears for it is on the left of the table.
		expect(vocabulary().map((row) => row.say).join("\n")).toContain("экзамен от судьи");
	});

	it("states the loop discipline it authors under", () => {
		const rules = persona.split("## Rules that keep evidence honest")[1]?.split("\n## ")[0] ?? "";
		expect(rules).toContain("about four changed files is the\n  ceiling");
		expect(rules).toContain("At an equal verdict the smaller diff wins");
		expect(rules).toContain("only deletes and\n  comes back flat is worth keeping");
		expect(rules).toContain("leaves the effect unresolved");
		expect(rules).toContain("Do not blindly repeat a prior attempt");
		expect(rules).toContain("**Loop discipline.**");
		// The rule this one restates has to still be there to restate.
		expect(persona).toContain("already tried");
	});

	it("names host-owned consequential actions without promising a fixed question count", () => {
		const working = persona.split("## How to work with the operator")[1]?.split("\n## ")[0] ?? "";
		expect(working).toContain("The host asks the consequential questions; their count follows the work");
		expect(working).not.toContain("exactly three questions");
		expect(working).toMatch(/\*\*start testing\*\*/);
		expect(working).toMatch(/\*\*apply this change\*\*/);
		expect(working).toMatch(/\*\*ship it\*\*/);
		expect(working).toContain("Do the work.");
		// A report request is answered, not forwarded to a terminal.
		expect(working).toContain("покажи как вырос");
		expect(working).toContain("After Ship the host shows the Passport automatically");
		expect(working).toMatch(/Never answer with a terminal or slash\s+command/);
		expect(working).toContain("Never answer “use /test” or “type /apply”");
		// The stage machine is not the operator's vocabulary.
		expect(working).toMatch(/Never\s+narrate stages/);
	});
});

describe("CLI help", () => {
	it("keeps root help to the eight product commands and sends the rest to the conversation", () => {
		const help = cliHelp(["--help"]);
		expect(help).toContain("continue this project's conversation");
		expect(help).toContain("start a new Builder conversation");
		expect(help).toContain("ahde resume");
		expect(help).toContain("ahde target [--target <dir>]");
		expect(help).toContain("ahde init <dir>");
		expect(help).toContain("ahde validate --target <dir>                 local readiness check; no model call");
		expect(help).toContain("ahde run --target <dir> [options]            run the development basket once");
		expect(help).toContain("ahde evidence [--port N] [--project <id>]    open the read-only trace explorer");
		expect(help).toContain("is asked for in the Builder conversation");
		expect(help).toContain("Inside Builder Pi");
		expect(help).toContain("--project defaults to the Target's manifest id");
		expect(help).toContain("AHDE_HOME       user-level Builder credentials and settings (default: ~/.ahde)");
		// Nothing that left the CLI is advertised, and asking for its help lands on the tour.
		for (const retired of [
			"candidate", "check", "calibrate", "improve", "search", "review", "promote", "reject",
			"passport", "log", "export", "label", "regrade", "report", "diagnose", "corpus", "feedback", "tool", "list", "serve", "watch",
		]) {
			expect(help).not.toMatch(new RegExp(`^  ahde ${retired}\\b`, "m"));
			expect(cliHelp([retired, "--help"])).toBe(help);
		}
	});

	it("renders focused help for the commands that stay", () => {
		expect(cliHelp(["run", "--help"])).toContain("Exit 0 = all pass");
		expect(cliHelp(["init", "--help"])).toContain("first Git commit");
		expect(cliHelp(["init", "--help"])).toContain("ahde init my-agent --template python-support");
		expect(cliHelp(["init", "--help"])).toContain("pi-basic         minimal Pi harness (the default)");
		// The engine store holds the sealed exam, so every command that writes
		// into one says it refuses a Target that already committed it.
		for (const command of ["init", "run"]) {
			expect(cliHelp([command, "--help"])).toMatch(/TRACKS\s+anything under \.ahde\/ or runs\//u);
		}
		expect(cliHelp(["target", "--help"])).toContain("Requires a configured Target");
		expect(cliHelp(["target", "--help"])).toContain("imports/feedback.jsonl");
		expect(cliHelp(["target", "--help"])).toContain("/bad [note]");
		expect(cliHelp(["validate", "--help"])).toContain("without contacting the model provider");
		expect(cliHelp(["run", "--help"])).toContain("Checking a change belongs to the Builder");
		for (const command of ["builder-pi", "continue", "resume", "evidence"]) {
			expect(cliHelp([command, "--help"])).toContain(`Usage: ahde ${command}`);
		}
	});
});
