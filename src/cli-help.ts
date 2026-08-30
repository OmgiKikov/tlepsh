import { AHDE_BUILDER_COMMAND_NAMES } from "./builder/commands.js";

/** One command list: the slash commands Builder Pi actually registers, wrapped for the terminal. */
function builderCommandLines(width = 72, indent = "  "): string {
	const lines: string[] = [];
	let current = "";
	for (const name of AHDE_BUILDER_COMMAND_NAMES) {
		const next = current ? `${current}  /${name}` : `/${name}`;
		if (next.length + indent.length > width && current) {
			lines.push(indent + current);
			current = `/${name}`;
			continue;
		}
		current = next;
	}
	if (current) lines.push(indent + current);
	return lines.join("\n");
}

const CORE = `ahde — Agent Harness Development Environment

Build, evaluate, and improve a project-specific Pi agent through one reviewed,
evidence-backed workflow.

Start:
  ahde [--target <dir>] [--project <id>]       open Builder Pi (Target defaults to cwd)
  ahde continue [--target <dir>]               continue the most recent Builder session
  ahde resume [--target <dir>]                 pick an earlier Builder session
  ahde target [--target <dir>]                 talk to the built Target Pi
  ahde init <dir>                              scaffold a Target for scripted setup

Inspect and run:
  ahde validate --target <dir>                 local readiness check; no model call
  ahde run --target <dir> [options]            run development evidence
  ahde calibrate --target <dir>                measure run-to-run noise (A/A)
  ahde evidence [--port N]                     open the read-only trace explorer
  ahde list [--target <id>]                    list eval runs
  ahde feedback list [--target <dir>]          👍/👎 marks collected in ahde target

Inside Builder Pi:
${builderCommandLines()}
  plus the Pi built-ins /login and /model for the Builder's own model

Use \`ahde <command> --help\` for focused help. Advanced automation commands:
  corpus  failures  compare  diagnose  report  candidate  calibrate  review  promote  reject

Environment:
  AHDE_HOME       user-level Builder credentials and settings (default: ~/.ahde)
  AHDE_RUNS_DIR   run artifacts directory (default: ./runs)
  AHDE_STATE_DIR  private workflow state (default: ./.ahde)`;

const COMMAND_HELP: Readonly<Record<string, string>> = {
	"builder-pi": `Usage: ahde builder-pi [--target <dir>] [--project <id>] [--port N]

Open a new Builder Pi session. This is the explicit form of bare \`ahde\`.
The Builder has exactly three AHDE tools and no generic shell or file access.`,
	continue: `Usage: ahde continue [--target <dir>] [--project <id>] [--port N]

Reopen the most recent Builder conversation for this Target. Workflow state is
durable either way; this only restores the conversation.`,
	resume: `Usage: ahde resume [--target <dir>] [--project <id>] [--port N]

Open AHDE's private Builder session selector for this Target.`,
	target: `Usage: ahde target [--target <dir>] [--message <text>]

Talk to the built Target Pi in a disposable isolated runtime. Target defaults
to the current directory. Requires a configured Target, credential, and TTY.

Mark the reply you just read with /good, /bad [note], alt+g, or alt+x. Each
mark appends one dialogue to imports/feedback.jsonl through the host process;
the Target child never writes outside its own throwaway workspace.`,
	"feedback list": `Usage: ahde feedback list [--target <dir>]

Count the 👍/👎 marks in imports/feedback.jsonl and show the most recent five
by their first user turn. Full transcripts stay in the file.

That file is an ordinary dataset inbox entry. It previews as JSONL with a
messages column beside verdict, note, at, and target.*, and a recipe with
{ "dialogue": { "column": "messages" } } compiles each mark into a dialogue
case — keep verdict and note as metadata columns so a rubric or reference
answer written later can use what was wrong.`,
	"feedback clear": `Usage: ahde feedback clear [--target <dir>]

Move imports/feedback.jsonl aside to imports/feedback.<timestamp>.jsonl.
Nothing is deleted, and the archive is still importable.`,
	evidence: `Usage: ahde evidence [--port N]

Serve the read-only Evidence Explorer on loopback. Port 0 chooses a free port.
Sealed holdout content and state-changing operations are never exposed.`,
	init: `Usage: ahde init <dir> [--template <target-dir>]

Create a generic Target harness and its first Git commit. Then run \`ahde\` in
that directory to configure identity/model and continue the guided workflow.`,
	run: `Usage:
  ahde run --target <dir> [--task <id>] [--repetitions N] [--jobs N] [--label baseline|solo] [--dataset <rel>]
  ahde run --target <dir> --project <id> --corpus <development-id> [--task <id>] [--repetitions N]

--jobs sets concurrent executions (default 4; 1 for a loopback model endpoint).

Run development evidence only. AHDE checks Target setup and credential presence
before creating run artifacts. Exit 0 = all pass, 1 = behavioral failures,
2 = inconclusive infrastructure/model errors. Candidate verification belongs
to the reviewed Builder flow or \`ahde candidate\`.`,
	validate: `Usage: ahde validate --target <dir> [--dataset <rel>]

Validate Target structure, Git/runtime identity, dataset, tools, placeholders,
and credential presence without contacting the model provider.`,
	list: `Usage: ahde list [--target <id>]

List valid local eval-run indexes. Invalid artifacts are skipped with a warning.`,
	failures: `Usage: ahde failures <evalRunId> --target <dir> [--project <id>] [--dataset <rel>] [--out <path>]

Compile a bounded failure bundle from one exact development EvalRun.`,
	compare: `Usage: ahde compare <evalRunA> <evalRunB>

Compare two runs only when every execution/grading axis except Harness revision matches.`,
	diagnose: `Usage: ahde diagnose <evalRunId>

Derive deterministic failure modes and proposal eligibility from a development EvalRun.`,
	report: `Usage: ahde report <evalRunId> [--out <path>]

Build a static, bounded HTML evidence report for one development EvalRun.`,
	candidate: `Usage:
  ahde candidate --target <dir> --builder-run <id> [--development-corpus <id>] [--holdout-corpus <id>] [--project <id>] [--repetitions N]
  ahde candidate --target <dir> --branch <ref> --base <ref> --proposal <id> --diagnosis <id> [options]

--jobs sets concurrent executions (default 4; 1 for a loopback model endpoint).
--baseline-max-age <days> bounds baseline reuse (default 7; 0 always re-runs).

Run an exact matched baseline/candidate experiment. Prefer Builder Pi: its host
gate selects sealed evidence without exposing the holdout identity to the model.`,
	calibrate: `Usage: ahde calibrate --target <dir> [--repetitions N] [--project <id>] [--corpus <development-id>]

Run the current revision against itself (A/A) to measure run-to-run noise:
how large a difference has to be before it means anything. The calibration
record is ordinary candidate evidence in A/A mode and is never promotable.`,
	review: `Usage: ahde review --candidate <id> --recommend promote|reject --reason <text> [--actor <id>]

Record a human review over the exact evaluated Candidate evidence.`,
	promote: `Usage: ahde promote --target <dir> --candidate <id> --to <semver> --reason <text> [--actor <id>]

Tag the exact reviewed Candidate revision. This does not switch the active checkout.`,
	reject: `Usage: ahde reject --candidate <id> --reason <text> [--actor <id>]

Record an immutable rejection for the exact reviewed Candidate.`,
	"corpus publish": `Usage: ahde corpus publish --project <id> --draft <id> --name <name> --visibility development|sealed

Publish a reviewed Builder corpus draft. Prefer the Builder Workbench for
receipt-backed lineage.`,
	"corpus import": `Usage: ahde corpus import --project <id> --name <name> --visibility development|sealed --file <jsonl>

Import bounded JSONL. Prefer Builder Pi's project-local imports/ inbox for an editable, Spec-bound draft.`,
	"corpus list": `Usage: ahde corpus list --project <id>

List corpus metadata. Sealed content is never printed.`,
	"corpus inspect": `Usage: ahde corpus inspect --project <id> --file imports/<file> [--sealed N --seed S]

Preview one file in the project-local imports/ inbox: format, columns with
inferred types and three sample values each, row count, and how many rows the
sealed slice reserves. csv, tsv, json, jsonl, markdown tables, plain text, and
chat exports. Rows held out for the sealed exam are excluded before anything is
computed, and a sealed row is never printed.`,
	"corpus ingest": `Usage: ahde corpus ingest --project <id> --file imports/<file> --recipe <json|@path> \\
                   --name <name> [--sealed N --seed S [--stratify-by <column>]]

Compile a dataset into eval cases through a mapping recipe. The sealed slice is
drawn first from (file sha256, seed, count, column) and published as a sealed
corpus; the rest become one development corpus. Prints the receipt, both corpus
ids, and the skipped-row counts — never a sealed row. A file that already has a
sealed slice keeps it; repeat the same --sealed/--seed to ingest it again.
Prefer Builder Pi: it shows sample cases and asks the operator to confirm.`,
};

/** Render root or command-specific help without reading project or environment state. */
export function cliHelp(argv: readonly string[]): string {
	const command = argv[0];
	if (!command || command === "--help" || command === "-h" || command === "help") return CORE;
	const nested = command === "corpus" || command === "feedback"
		? argv.find((token, index) => index > 0 && !token.startsWith("-"))
		: undefined;
	return COMMAND_HELP[nested ? `${command} ${nested}` : command] ?? CORE;
}
