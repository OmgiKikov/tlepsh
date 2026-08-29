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

Inside Builder Pi:
  /help  /doctor  /status  /run  /calibrate  /traces  /review  /apply  /discard  /target

Use \`ahde <command> --help\` for focused help. Advanced automation commands:
  corpus  failures  compare  diagnose  report  builder  candidate  calibrate  review  promote  reject

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
to the current directory. Requires a configured Target, credential, and TTY.`,
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
	"corpus draft": `Usage: ahde corpus draft --target <dir> --project <id> --spec <approved-id> --tasks N [--guidance <text>] [--builder <dir>]

Generate a reviewable Spec-bound corpus draft. It is not runnable until published.`,
	"corpus publish": `Usage: ahde corpus publish --project <id> --draft <id> --name <name> --visibility development|sealed

Publish a reviewed draft. Prefer the Builder Workbench for receipt-backed lineage.`,
	"corpus import": `Usage: ahde corpus import --project <id> --name <name> --visibility development|sealed --file <jsonl>

Import bounded JSONL. Prefer Builder Pi's project-local imports/ inbox for an editable, Spec-bound draft.`,
	"corpus list": `Usage: ahde corpus list --project <id>

List corpus metadata. Sealed content is never printed.`,
	"builder capabilities": `Usage: ahde builder capabilities --target <dir> [--builder <dir>]

Probe optional scriptable proposal backends (Pi, Codex, Claude).`,
	"builder propose": `Usage: ahde builder propose --target <dir> --project <id> --spec <approved-id> --backend pi|codex|claude [options]

Create proposal evidence from an approved Spec. Prefer Builder Pi's structured authoring path.`,
	"builder apply": `Usage: ahde builder apply --target <dir> --run <id> --branch <name> --reason <text> [--actor <id>]

Apply one exact proposal to a candidate branch; the current checkout is unchanged.`,
};

/** Render root or command-specific help without reading project or environment state. */
export function cliHelp(argv: readonly string[]): string {
	const command = argv[0];
	if (!command || command === "--help" || command === "-h" || command === "help") return CORE;
	const nested = command === "corpus" || command === "builder"
		? argv.find((token, index) => index > 0 && !token.startsWith("-"))
		: undefined;
	return COMMAND_HELP[nested ? `${command} ${nested}` : command] ?? CORE;
}
