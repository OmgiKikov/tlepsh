import { builderCommandsOfTier, type BuilderCommandTier } from "./builder/commands.js";

/** One command list, wrapped for the terminal. */
function wrapCommandNames(names: readonly string[], width = 72, indent = "  "): string {
	const lines: string[] = [];
	let current = "";
	for (const name of names) {
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

/**
 * The slash commands Builder Pi actually registers, in the two groups `/help`
 * itself draws: the nine an operator uses, then everything `/help all` holds —
 * the expert shortcuts and the decisions AHDE offers on screen by itself.
 */
function builderCommandLines(): string {
	const namesOf = (tier: BuilderCommandTier): string[] =>
		builderCommandsOfTier(tier).map((command) => command.name);
	return [
		// The nine hold one line; the rest wrap at the usual width.
		wrapCommandNames(namesOf("core"), 76),
		"  everything else is an expert shortcut or a decision AHDE asks itself;",
		"  /help all lists them:",
		wrapCommandNames([...namesOf("expert"), ...namesOf("host-decision")]),
	].join("\n");
}

const CORE = `ahde — Agent Harness Development Environment

Build, evaluate, and improve a project-specific Pi agent through one reviewed,
evidence-backed workflow.

Start:
  ahde [--target <dir>] [--project <id>]       continue this project's conversation (new if empty)
  ahde builder-pi [--target <dir>]            start a new Builder conversation
  ahde continue [--target <dir>]               continue the most recent Builder session
  ahde resume [--target <dir>]                 pick an earlier Builder session
  ahde target [--target <dir>]                 talk to the built Target Pi
  ahde init <dir>                              scaffold a Target for scripted setup

Without the Builder:
  ahde validate --target <dir>                 local readiness check; no model call
  ahde run --target <dir> [options]            run the development basket once
  ahde evidence [--port N] [--project <id>]    open the read-only trace explorer

Everything else — tests, diagnosis, changes, checks, the exam, the release and
its passport — is asked for in the Builder conversation.

Inside Builder Pi:
${builderCommandLines()}
  plus the Pi built-ins /login and /model for the Builder's own model

Use \`ahde <command> --help\` for focused help. Wherever a command takes both,
--project defaults to the Target's manifest id; an explicit --project still wins.

Environment:
  AHDE_HOME       user-level Builder credentials and settings (default: ~/.ahde)
  AHDE_LANG       host language, en or ru (default: settings.json, then the shell locale)
  AHDE_RUNS_DIR   run artifacts directory (default: ./runs)
  AHDE_STATE_DIR  private workflow state (default: ./.ahde)`;

const COMMAND_HELP: Readonly<Record<string, string>> = {
	"builder-pi": `Usage: ahde builder-pi [--target <dir>] [--project <id>] [--port N]

Open a new Builder Pi session. Bare \`ahde\` continues this project's most recent
conversation instead, or starts the first one when none exists.
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
	evidence: `Usage: ahde evidence [--port N] [--project <id>]

Serve the read-only Evidence Explorer on loopback. Port 0 chooses a free port.
Sealed holdout content and state-changing operations are never exposed.

Routes:
  /                          every public evaluation index
  /evals/<evalRunId>         the runs table: one row per case x repetition, failures
                             first, with the failure-mode list above it
                             (?outcome=fail|error|pass and ?mode=<failure-mode-id> filter it)
  /runs/<runId>              one run: the conversation, every grader's verdict, and
                             the host's plain-language explanation of why it failed
  /candidates/<candidateId>  baseline versus candidate per task, with the sealed
                             verdict and design size only

With --project the report also shows how far this project's judge has been
checked against a human. Without it the page
says the calibration is not available here rather than calling the judge
unchecked.`,
	init: `Usage: ahde init <dir> [--template <name|target-dir>]

Create a generic Target harness and its first Git commit. Then run \`ahde\` in
that directory to configure identity/model and continue the guided workflow.

Built-in templates work from any directory:
  python-support   Python support agent, tools, knowledge base and world-state cases
  pi-support       Pi support agent with a declared account tool
  pi-basic         minimal Pi harness (the default)
  python           alias for python-support

Example: ahde init my-agent --template python-support
Custom templates still accept relative or absolute directories:
  ahde init my-agent --template ./my-template

The scaffold's .gitignore is topped up with .ahde/, runs/, imports/ and exports/ before
that first commit, and the added lines are named: the engine's store lives
inside the Target and holds the sealed exam.

For the same reason it refuses to scaffold inside a checkout that already
TRACKS anything under .ahde/ or runs/ — a commit cannot be un-made, and a new
Target would inherit that store's problem.`,
	run: `Usage:
  ahde run --target <dir> [--task <id>] [--repetitions N] [--jobs N] [--label baseline|solo] [--dataset <rel>]
  ahde run --target <dir> --project <id> --corpus <development-id> [--task <id>] [--repetitions N]

--jobs sets concurrent executions (default 4; 1 for a loopback model endpoint).

Run development evidence only. AHDE checks Target setup and credential presence
before creating run artifacts, and refuses by path a Target that already TRACKS
anything under .ahde/ or runs/ — that store holds the sealed exam.

Exit 0 = all pass, 1 = behavioral failures, 2 = inconclusive
infrastructure/model errors. Checking a change belongs to the Builder
conversation, where the exact diff is reviewed first.`,
	validate: `Usage: ahde validate --target <dir> [--dataset <rel>]

Validate Target structure, Git/runtime identity, dataset, tools, placeholders,
and credential presence without contacting the model provider. Reports the two
evaluator models beside the Target's own — \`judge: configured ·
<provider>/<id> · key TEST_JUDGE_KEY set\` — because a configured judge with no
key fails at the first graded case and nowhere earlier.

The sandbox line reports the declared containment and what enforces it on THIS
host:

  sandbox: best-effort (host OS sandbox)`,
};

/** Render root or command-specific help without reading project or environment state. */
export function cliHelp(argv: readonly string[]): string {
	const command = argv[0];
	if (!command || command === "--help" || command === "-h" || command === "help") return CORE;
	return COMMAND_HELP[command] ?? CORE;
}
