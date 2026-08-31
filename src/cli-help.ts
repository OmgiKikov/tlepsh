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
  ahde check --target <dir> --candidate <id>   cheap screen: the failed cases, once
  ahde improve --target <dir> --until 90% --max-cycles 5
                                               run improvement cycles inside the gates
  ahde calibrate --target <dir>                measure run-to-run noise (A/A)
  ahde evidence [--port N] [--project <id>]    open the read-only trace explorer
  ahde list [--target <id>]                    list eval runs
  ahde feedback list [--target <dir>]          👍/👎 marks collected in ahde target
  ahde tool try --target <dir> --tool <name> --input <json|@path>
                                               run one declared tool in its sandbox
  ahde label <evalRunId> --target <dir>        check the judge against your own eyes
  ahde judge-agreement <evalRunId> --target <dir>
                                               how far that judge is calibrated

Inside Builder Pi:
${builderCommandLines()}
  plus the Pi built-ins /login and /model for the Builder's own model

Use \`ahde <command> --help\` for focused help. Advanced automation commands:
  corpus  failures  compare  diagnose  regrade  report  label  judge-agreement
  candidate  calibrate  check  improve  review  promote  reject

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
	evidence: `Usage: ahde evidence [--port N] [--project <id>]

Serve the read-only Evidence Explorer on loopback. Port 0 chooses a free port.
Sealed holdout content and state-changing operations are never exposed.

With --project the report also shows how far this project's judge has been
checked against a human, exactly as \`ahde report\` does. Without it the page
says the calibration is not available here rather than calling the judge
unchecked.`,
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
	regrade: `Usage: ahde regrade <evalRunId> --target <dir> [--graders <path>] [--label baseline|solo|regrade]
                   [--jobs N] [--project <id>]

Re-score the recorded traces of one eval run with graders, without calling the
Target model again: each session.jsonl is hash-verified, copied into a new run,
and graded through the same code path a live evaluation uses.

Each case keeps the graders it carried when its trace was recorded — the dataset
must hash-match the source eval — while the suite defaults that fill in for cases
declaring none come from --graders, or from the Target's current
evals/graders.yaml. The judge model comes from the current manifest, so a regrade
still re-decides judge graders when only the judge changed.

The result is an ordinary EvalRun with a new suiteHash computed from the graders
actually used, so two runs regraded with the same graders compare to each other
while a regrade whose graders changed is refused against its own source. Sealed
evidence stays sealed and prints counts only.`,
	report: `Usage: ahde report <evalRunId> [--out <path>] [--project <id>]

Build a static, bounded HTML evidence report for one development EvalRun.
Judge graders carry one line each: \`judge agreement 84% · κ 0.62 · n=50\` from
this project's labels, or \`judge not calibrated\` when nobody has checked yet.`,
	label: `Usage:
  ahde label <evalRunId> --target <dir> [--project <id>] [--sample N] [--seed <text>]
  ahde label <evalRunId> --target <dir> --file <labels.jsonl>

Grade the judge. For a deterministic seeded sample of judge-graded development
runs it shows the task and the Target's final answer — bounded and
credential-redacted — asks you for pass / fail / skip and an optional note, and
only then reveals what the judge said. Answers append to
<state-root>/projects/<id>/labels/<evalRunId>.jsonl.

Without a TTY, --file imports the same rows from JSONL: one object per line with
runId, taskId, graderIndex, graderSpecHash, human, and optional note. Every row
is checked against the recorded evidence before it is stored.

Sealed holdout evidence is never labelled: reading it is exactly what a holdout
forbids.`,
	"judge-agreement": `Usage: ahde judge-agreement <evalRunId> --target <dir> [--project <id>]

Compare this project's human labels with the judge that graded them: agreement
rate, Cohen's κ, and how often the judge waves a failure through or invents one.
Per judge grader spec, plus the pooled total. κ is n/a when the labels are all
one verdict — chance alone explains such a table and there is nothing to correct.`,
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
	check: `Usage: ahde check --target <dir> --candidate <id> [--project <id>] [--jobs N]

The cheap check before the expensive one. Runs the candidate revision on ONLY
the cases its source eval recorded as failing, once, candidate arm only, and
compares with those cases' recorded outcomes.

A verification costs (development + sealed cases) x repetitions x 2 arms; this
costs one run per failed case. \`promising\` means at least one previously
failing case now passes; \`flat\` means none does.

It is a screen, never evidence. Its eval run carries the \`solo\` label, which is
never reused as a baseline and never stands in for a candidate arm, it is
recorded in runs/screens/, it enters no comparison gate, and a promotion that
cites one is refused. Exit 0 = promising, 1 = flat.`,
	improve: `Usage: ahde improve --target <dir> --until <pass-rate> --max-cycles <n> \\
                    [--jobs N] [--project <id>] [--repetitions N] [--corpus <development-id>]

Run improvement cycles inside the gates. One cycle is: run -> diagnose -> take
the top proposable failure mode -> apply the next unapplied Builder proposal
bound to that evidence on \`candidate/auto-<n>\` -> cheap check -> full
development verification when the screen is promising.

--until takes a pass rate written either way: \`90%\` or \`0.9\`.

The loop stops and hands back when the target pass rate is reached, the cycle
budget is spent, a development verdict is not \`improved\`, the cheap check is
flat twice in a row, infrastructure errors go over the budget, or a verified
candidate is ready — because the sealed guardrail and the promotion are always
yours. It never promotes, adopts, publishes a corpus or approves a Spec.

Authoring stays with Builder Pi: author the proposals in \`ahde\` first, then let
the loop screen and verify them. Exit 0 = a verified candidate is waiting.`,
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
Prefer Builder Pi: it shows sample cases and asks the operator to confirm.

A chat export can become cases the agent has to hold a conversation with rather
than a frozen history it answers once: add
{ "simulatedUser": { "goalColumn": "title", "personaColumn": "segment" } } beside
an "input" mapping (on a chat export, { "column": "first_user" }). Every turn
after the opening message is then written by the configured
evalSuite.simulatedUser model. Optional "maxTurns" (1..12, default 6) and
"stopWhen" bound the conversation. A recipe maps "dialogue" or "simulatedUser",
never both.`,
	"tool try": `Usage: ahde tool try --target <dir> --tool <name> --input <json|@path> [--branch <ref>]

Run one declared Target tool on one JSON input inside a private scratch copy of
the Harness: same descriptor, same OS sandbox, same declared setup step, same
workspace projection a Target sees. --input takes inline JSON or @path to a JSON
file; --branch tries an exact other revision instead of HEAD.

Your checkout is never touched, no eval evidence is written, and output is
bounded and redacted. Exit 0 = the tool exited 0, 1 = the tool failed.`,
};

/** Render root or command-specific help without reading project or environment state. */
export function cliHelp(argv: readonly string[]): string {
	const command = argv[0];
	if (!command || command === "--help" || command === "-h" || command === "help") return CORE;
	const nested = command === "corpus" || command === "feedback" || command === "tool"
		? argv.find((token, index) => index > 0 && !token.startsWith("-"))
		: undefined;
	return COMMAND_HELP[nested ? `${command} ${nested}` : command] ?? CORE;
}
