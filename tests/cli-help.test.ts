import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cliHelp } from "../src/cli-help.js";
import { SEALED_GATE_POLICY } from "../src/domain/comparison-gate.js";
import { AHDE_BUILDER_COMMAND_NAMES } from "../src/builder/commands.js";
import { setLanguage, t } from "../src/i18n.js";

/** Every `/name` mentioned inside one fenced block or help section. */
function slashNames(text: string): string[] {
	return [...new Set([...text.matchAll(/\/([a-z][a-z-]*)/g)].map((match) => match[1] as string))];
}

describe("one Builder command list", () => {
	it("lists exactly the registered commands under Inside Builder Pi", () => {
		const section = cliHelp(["--help"]).split("Inside Builder Pi:")[1]?.split("\n\n")[0] ?? "";
		expect(slashNames(section)).toEqual([...AHDE_BUILDER_COMMAND_NAMES, "login", "model"]);
	});

	// The reference is a localized string now, so the invariant has to hold in
	// every language: a translation that quietly drops a command is a bug.
	it("keeps the in-Builder /help reference equal to the registered commands", () => {
		try {
			for (const lang of ["en", "ru"] as const) {
				setLanguage(lang);
				const reference = t("help.body");
				expect(reference).not.toBe("");
				for (const name of AHDE_BUILDER_COMMAND_NAMES) expect(reference).toContain(`/${name}`);
				expect(reference).toContain("/login");
				expect(reference).toContain("/model");
			}
		} finally {
			setLanguage(null);
		}
	});

	it("keeps the README slash block equal to the registered commands", () => {
		const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
		const block = readme.split("The compact Pi commands below are optional expert shortcuts")[1]?.split("```")[1] ?? "";
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
		// The same rule the two authoring skills restate.
		const design = readFileSync(new URL("../builders/ahde/skills/design-agent/SKILL.md", import.meta.url), "utf8");
		const improve = readFileSync(new URL("../builders/ahde/skills/improve-harness/SKILL.md", import.meta.url), "utf8");
		for (const skill of [design, improve]) {
			expect(skill).toContain("belongs in a\n   tool");
		}
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
		for (const jargon of ["Spec", "corpus", "Proposal", "candidate verification", "sealed holdout"]) {
			expect(means).toContain(jargon);
		}
	});

	it("offers the judge check exactly once, the way noise calibration is offered", () => {
		const loop = persona.split("## Typical loop")[1] ?? "";
		expect(loop).toContain("оцени 20 ответов вслепую — 10 минут — и я буду знать, насколько верить судье");
		expect(loop).toContain("ahde label");
		expect(loop).toContain("never bring it up again");
		// The same one-offer shape as the noise measurement it mirrors.
		expect(loop).toContain("offer that measurement once for this revision");
		const evals = readFileSync(
			new URL("../builders/ahde/skills/design-evals/SKILL.md", import.meta.url),
			"utf8",
		);
		expect(evals).toContain("оцени 20 ответов вслепую");
		expect(evals).toContain("exactly once per revision");
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
		const evals = readFileSync(
			new URL("../builders/ahde/skills/design-evals/SKILL.md", import.meta.url),
			"utf8",
		);
		expect(evals).toContain("kind: generate-holdout");
		expect(evals).toContain("A model that writes the holdout has read the\n   holdout");
		expect(evals).toContain("recommend that one for a first exam");
		expect(evals).toContain("never a case, and never ask for\n   one");
		// The word the operator hears for it is on the left of the table.
		expect(vocabulary().map((row) => row.say).join("\n")).toContain("экзамен от судьи");
	});

	it("states the loop discipline it authors under", () => {
		const rules = persona.split("## Rules that keep evidence honest")[1]?.split("\n## ")[0] ?? "";
		expect(rules).toContain("about four changed files is the\n  ceiling");
		expect(rules).toContain("At an equal verdict the smaller diff wins");
		expect(rules).toContain("only deletes and\n  comes back flat is worth keeping");
		expect(rules).toContain("A tie is a discard");
		expect(rules).toContain("Never re-propose the same files for the same failure mode after a loss");
		const improve = readFileSync(
			new URL("../builders/ahde/skills/improve-harness/SKILL.md", import.meta.url),
			"utf8",
		);
		expect(improve).toContain("Loop discipline");
		expect(improve).toContain("about four changed files");
		expect(improve).toContain("A tie is a discard");
		// The rule this one restates has to still be there to restate.
		expect(improve).toContain("already tried");
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
		// A report request is answered, not forwarded to a terminal.
		expect(working).toContain("покажи как вырос");
		expect(working).toContain("After Ship the host shows the Passport automatically");
		expect(working).toContain("Never answer with a terminal or slash\n  command");
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
		// The screen has one subject and one form: an evaluated Candidate record.
		expect(help).toContain("ahde check --target <dir> --candidate <id>   cheap screen: the failed cases, once");
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
		// The engine store holds the sealed exam, so every command that writes
		// into one says it refuses a Target that already committed it.
		for (const command of ["init", "run", "candidate"]) {
			expect(cliHelp([command, "--help"])).toMatch(/TRACKS\s+anything under \.ahde\/ or runs\//u);
		}
		expect(cliHelp(["target", "--help"])).toContain("Requires a configured Target");
		expect(cliHelp(["calibrate", "--help"])).toContain("measure run-to-run noise");
		expect(cliHelp(["calibrate", "--help"])).toContain("never promotable");
		const check = cliHelp(["check", "--help"]);
		expect(check).toContain("Usage: ahde check --target <dir> --candidate <id>");
		expect(check).not.toContain("--builder-run");
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

	it("sends authoring and adoption to Builder Pi, and advertises no retired command", () => {
		const help = cliHelp(["--help"]);
		expect(help).toContain("Verify and ship (authoring and adoption live in Builder Pi):");
		expect(help).toContain("log  watch  passport");
		// The external CLI workflow is retired: the root page must not name it,
		// and asking for its help must land on the product tour instead.
		for (const retired of ["ahde spec approve", "ahde propose", "ahde apply", "ahde adopt"]) {
			expect(help).not.toContain(retired);
		}
		for (const argv of [["spec", "approve"], ["propose"], ["apply"], ["adopt"]]) {
			expect(cliHelp([...argv, "--help"])).toBe(help);
		}
	});

	it("renders focused help for nested automation actions", () => {
		expect(cliHelp(["corpus", "import", "--help"])).toContain("imports/ inbox");
		expect(cliHelp(["corpus", "publish", "--help"])).toContain("Builder corpus draft");
		expect(cliHelp(["corpus", "inspect", "--help"])).toContain("--file imports/<file>");
		expect(cliHelp(["corpus", "inspect", "--help"])).toContain("a sealed row is never printed");
		expect(cliHelp(["corpus", "ingest", "--help"])).toContain("--recipe <json|@path>");
		expect(cliHelp(["corpus", "ingest", "--help"])).toContain("never a sealed row");
		const synth = cliHelp(["corpus", "synth", "--help"]);
		expect(synth).toContain("Usage: ahde corpus synth --target <dir>");
		// Why the judge and not the Builder, said where an operator will read it.
		expect(synth).toContain("configured JUDGE model");
		expect(synth).toContain("never the Builder");
		expect(synth).toContain("refused, exit 2");
		expect(synth).toContain("never a case, a fragment of one");
		expect(synth).toContain("--review <path> is the human path");
		expect(synth).toContain("refused inside the Target tree");
		expect(synth).toContain("No case content, ever.");
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
