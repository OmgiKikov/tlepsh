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
  ahde search --target <dir> --candidates <id,id,id>
                                               compare 2-4 changes for one problem
  ahde calibrate --target <dir>                measure run-to-run noise (A/A)
  ahde log --target <dir> [--project <id>]     the agent's growth, version by version
  ahde watch --target <dir> [--every 1d]       the basket on a schedule; drift vs noise
  ahde evidence [--port N] [--project <id>]    open the read-only trace explorer
  ahde serve --target <dir> [--port N]         drive the Workbench over a local
                                               HTTP/JSON API; your UI is the gate
  ahde list [--target <id>]                    list eval runs
  ahde feedback list [--target <dir>]          👍/👎 marks collected in ahde target
  ahde tool try --target <dir> --tool <name> --input <json|@path>
                                               run one declared tool in its sandbox
  ahde label <evalRunId> --target <dir> [--spec <id>]  check the judge against your own eyes
  ahde judge-agreement <evalRunId> --target <dir>
                                               how far that judge is calibrated

Change and ship, without leaving the terminal:
  ahde spec approve --target <dir> [--file spec.md]
                                               approve the typed Spec the gate needs
  ahde propose --target <dir> --spec <id> --branch <ref>
                                               compile a branch into a typed proposal
  ahde apply --target <dir> --builder-run <id> commit it on its own candidate branch
  ahde candidate --target <dir> --builder-run <id>
                                               the matched experiment and sealed gate
  ahde review · ahde promote --to 0.X.0        your gate, on the exact evidence
  ahde adopt --target <dir> --candidate <id>   fast-forward onto the promoted revision

Inside Builder Pi:
${builderCommandLines()}
  plus the Pi built-ins /login and /model for the Builder's own model

Use \`ahde <command> --help\` for focused help. Advanced automation commands:
  corpus  failures  compare  diagnose  regrade  report  label  judge-agreement
  candidate  calibrate  check  improve  search  review  promote  reject
  log  watch  spec approve  propose  apply  adopt

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
	serve: `Usage: ahde serve --target <dir> [--project <id>] [--port N] [--host 127.0.0.1]
                  [--token-file <path>] [--confirmation-timeout <seconds>] [--allow-concurrent]

Serve the Workbench over a local HTTP/JSON API so a platform backend can drive
the same loop and show its own confirmation UI. The API is a transport for the
same human gate, never an exemption from it.

A consequential decision does not run. It opens a pending confirmation and the
operation blocks: POST /v1/decide answers 202 with { status:
"awaiting-confirmation", confirmationId, kind, title, question, subject,
subjectHash, policy }, and the decision proceeds only when
POST /v1/confirmations/<id> arrives with { approved: true, subjectHash } quoting
that exact hash. A wrong hash, an unknown id, a second answer, an expiry, and
shutdown are each refusals. Routine measurement runs without a question under
the same cost guard; an expensive run escalates to a pending confirmation like
any other. Actor identity and sealed-holdout selection stay host-owned: a body
that carries actor, actorId, approved, or confirmed is refused.

Routes (GET unless marked): /v1/health, /v1/view, POST /v1/submit,
POST /v1/decide, /v1/confirmations, POST /v1/confirmations/<id>, /v1/events
(SSE: workbench-changed, run-progress, confirmation-opened/closed). Every other
response is exactly the shape the Builder tools return.

Binds 127.0.0.1 only. A bearer token is minted at startup and printed once to
stderr — pass --token-file to also write it 0600 for a supervisor to read. No
CORS, Host and Origin are checked, bodies are bounded, and one server holds a
project at a time unless --allow-concurrent says otherwise.
--confirmation-timeout defaults to 600 seconds (5..3600); an expired
confirmation is a refusal.

Target bootstrap (scaffold/configure) still belongs to the local TUI: choosing
a model and a credential needs the trusted host catalog, not an HTTP body.`,
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
and credential presence without contacting the model provider. Reports the two
evaluator models beside the Target's own — \`judge: configured ·
<provider>/<id> · key TEST_JUDGE_KEY set\` — because a configured judge with no
key fails at the first graded case and nowhere earlier.

The sandbox line reports what would actually confine a run on THIS host:

  sandbox: best-effort (host OS sandbox)
  sandbox: container (docker 27.1, server linux/arm64, target linux/arm64, image pinned)
  sandbox: container requested, container backend unavailable (…); falling back …
  sandbox: FAIL CLOSED — <the exact reason the declared containment is refused>

A container backend changes the execution fingerprint and therefore starts a
new comparability class: baselines recorded on the host are not reusable
against container evidence, by design.`,
	list: `Usage: ahde list [--target <id>]

List valid local eval-run indexes. Invalid artifacts are skipped with a warning.`,
	failures: `Usage: ahde failures <evalRunId> --target <dir> [--project <id>] [--dataset <rel>] [--out <path>]

Compile a bounded failure bundle from one exact development EvalRun.`,
	compare: `Usage: ahde compare <evalRunA> <evalRunB>

Compare two runs only when every execution/grading axis except Harness revision matches.`,
	diagnose: `Usage: ahde diagnose <evalRunId>

Derive deterministic failure modes and proposal eligibility from a development EvalRun.`,
	regrade: `Usage: ahde regrade <evalRunId> --target <dir> [--graders <path>] [--label solo|regrade]
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
  ahde label <evalRunId> --target <dir> [--project <id>] [--spec <approvedSpecId>] [--sample N] [--seed <text>]
  ahde label <evalRunId> --target <dir> [--spec <approvedSpecId>] --file <labels.jsonl>

Grade the judge on the same object the judge graded. For a deterministic seeded
sample of judge-graded development runs it shows exactly what the judge was
shown — the request, or the goal and the whole conversation on a simulated-user
case — plus the answer, the rubric it was asked, the reference answer when the
grader used one, and the assertion list as a checklist. It takes your blind
pass / fail / skip (or one yes / no / unknown per assertion) and an optional
note, and only then reveals what the judge said. Answers append to
<state-root>/projects/<id>/labels/<evalRunId>.jsonl.

Each new row is stamped with the exact source EvalRun lineage. When the project
has one approved Spec it is bound automatically; with several, --spec is
required. Only labels bound to the candidate's approved Spec and development
eval lineage can satisfy a promotion calibration policy.

Without a TTY, --file imports the same rows from JSONL: one object per line with
runId, taskId, graderIndex, graderSpecHash, human, optional assertions
(yes/no/unknown per assertion), and optional note. Every row is checked against
the recorded evidence before it is stored.

Labels written before lineage receipts stay readable, but cannot satisfy a
promotion calibration policy. allowLegacyLabels only opts into the older
screen shape; it does not opt out of exact Spec/eval provenance.

Sealed holdout evidence is never labelled: reading it is exactly what a holdout
forbids.`,
	"judge-agreement": `Usage: ahde judge-agreement <evalRunId> --target <dir> [--project <id>]

Compare this project's human labels with the judge that graded them: agreement
rate, Cohen's κ, and how often the judge waves a failure through or invents one.
Per judge grader spec, plus the pooled total. Subjects and assertion-level checks
are separate; repeated labels do not enlarge the sample, and conflicting labels
are reported and excluded. κ is n/a when the labels are all one verdict — chance
alone explains such a table and there is nothing to correct.`,
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
	check: `Usage:
  ahde check --target <dir> --candidate <id> [--project <id>] [--jobs N]
  ahde check --target <dir> --builder-run <id> [--project <id>] [--jobs N]

The cheap check before the expensive one. Runs the candidate revision on ONLY
the cases its source eval recorded as failing, once, candidate arm only, and
compares with those cases' recorded outcomes.

--builder-run screens an applied Builder proposal directly, so the screen can
run where it belongs: after \`ahde apply\`, before the verification it exists to
save. --candidate screens an already-evaluated Candidate record. Exactly one of
the two.

A verification costs (development + sealed cases) x repetitions x 2 arms; this
costs one run per failed case. \`promising\` means at least one previously
failing case now passes; \`flat\` means none does.

It is a screen, never evidence. Its EvalRun atomically carries \`purpose: screen\`;
the runs/screens/ marker is a fail-closed second check. It is never reused,
enters no promotion-grade comparison, cannot become a regression source, and a
promotion that cites one is refused. Exit 0 = promising, 1 = flat.`,
	improve: `Usage: ahde improve --target <dir> --until <pass-rate> --max-cycles <n> \\
		            [--candidates N] [--jobs N] [--project <id>]
                    [--repetitions N] [--corpus <development-id>]
                    [--baseline-max-age <ms>] [--resume <loopId> | --abandon <loopId>]

Run improvement cycles inside the gates. One cycle is: reuse or run -> diagnose
-> take the top proposable failure mode -> apply a matching Builder proposal on
\`candidate/auto-<loopId>-<n>\` -> cheap check -> full development verification
when the screen is promising.

WHAT THE LOOP AUTHORS: nothing. It applies proposals the Builder has already
prepared in \`ahde\` (say "fix it"), screens them and verifies them. A headless
proposal author is NOT shipped yet — it is the next milestone. Without a
prepared proposal the loop measures, diagnoses, and stops saying so.

WHICH PROPOSAL MATCHES: the one whose attested basis still describes this
cycle's development SURFACE — same dataset label and hash, same suite hash, same
Target revision and approved Spec — and whose failure modes include the one this cycle chose. Not
the id of an eval run: every invocation mints a new one, so a proposal you
prepared in the conversation just before running this command matches, and one
prepared after a stop still matches the next run while the surface holds. A
proposal that no longer matches is refused with what moved.

WHAT IT APPLIES WITHOUT ASKING AGAIN: every proposal it picks, on throwaway
\`candidate/auto-<loopId>-<n>\` branches, WITHOUT showing you each diff. Your
branch and working tree are never touched. Changed paths are listed in the cycle
table; the exact diff is shown in review and bound by hash to the ship dialog. Each apply
receipt records \`via: improvement-loop\` so nothing later mistakes it for a
diff a human read.

The low-level CLI prints the maximum Target-execution spend before work starts;
its --max-cycles/--candidates/--repetitions flags are that authorization. Builder
Pi shows the same bound, plus any history-based cost/time estimate, in one full
confirmation.

--until takes a pass rate written either way: \`90%\` or \`0.9\`.

--candidates N (1..4, default 1) makes each cycle a search instead of one guess:
it takes N unapplied proposals for the top failure mode, screens and verifies
each on its own \`candidate/search-<loopId>-<cycle>-<n>\` branch, and prints the Pareto
table. The loop then stops, because which hypothesis wins is yours to say.

--baseline-max-age <ms> bounds evidence reuse: a cycle first looks for a fresh,
comparable, conclusive development eval run on the current revision and reuses
it instead of paying again. The cycle table marks those rows \`(reused)\`. 0
disables reuse.

Every invocation gets a loop id, and the branches carry it. A second \`improve\`
on a project with an unfinished loop reports it and refuses; continue it with
--resume <loopId> or drop the claim with --abandon <loopId>. Either way the
branches the earlier loop made are left exactly where they are.

The loop refuses to re-propose a change whose changed files and targeted failure
mode match an attempt that already ended rejected or not \`improved\`; when every
proposable mode is exhausted that way it stops and says so.

The loop stops and hands back when the target pass rate is reached, the cycle
budget is spent, a development verdict is not \`improved\`, the cheap check is
flat twice in a row, infrastructure errors go over the budget, every proposable
failure mode has already been tried and lost, a search needs a decision, or a
verified candidate is ready — because the sealed guardrail and the promotion are
always yours. It never promotes, adopts, publishes a corpus or approves a Spec.

Exit 0 = a verified candidate is waiting.`,
	search: `Usage: ahde search --target <dir> --candidates <id,id,id> [--project <id>] \\
                   [--jobs N] [--repetitions N] [--corpus <development-id>] [--budget N]

Search, not one guess. Takes 2-4 unapplied Builder proposals that all target the
same failure mode, applies each on its own \`candidate/search-<searchId>-<n>\` branch,
screens each with the cheap check, and pays for the full matched development
verification only where the screen found something. It prints a Pareto table:
per candidate the verdict, score delta with its 95% interval, cost and latency
ratios, the screen's numbers, and which candidates are dominated.

A candidate is dominated when another verified candidate is at least as good on
BOTH score delta and cost ratio and is strictly better on one of them (ties are
broken by candidate order). Only an \`improved\` development verdict enters the
release frontier; if none improves, the frontier is honestly empty. A candidate whose
screen was flat never reaches verification and is listed with that reason;
--budget N caps the whole search and skipped candidates say so — nothing is
capped silently.

Sealed verification is not part of a search. You pick one candidate from the
table and that one goes through the unchanged sealed gate and promotion. The
search never promotes, adopts, publishes, approves, or opens the holdout.

Exit 0 = at least one candidate is on the frontier.`,
	"spec approve": `Usage: ahde spec approve --target <dir> [--project <id>] [--file spec.md] [--title <text>]
                         [--actor <id>]

Turn the spec.md you wrote for the operator into the typed immutable Spec the
ship gate needs. Running this command IS the approval: the receipt is written
on the spot, under the same local actor id promotion uses.

Headings name the fields — Purpose, Users, Jobs, Inputs, Allowed actions,
Success criteria, Constraints, Open questions — and the bullets under each
heading are its items. The first \`# <title>\` is the title unless --title says
otherwise; text before the first section is the purpose when no Purpose
section exists. Any other heading is left to the human and reported as unread.

--file defaults to <target>/spec.md and is resolved from the current directory
when given. Approving the same content twice is a no-op: the draft is
content-addressed, so the second call finds the receipt and prints the
specification id it already approved.`,
	propose: `Usage:
  ahde propose --target <dir> --spec <id> --branch <ref> [--project <id>] [--summary <text>]
  ahde propose --target <dir> --spec <id> --branch <ref> --eval <evalRunId> --mode <failureModeId>

Compile the difference between the Target's committed baseline and a branch
into the typed Builder proposal the engine gates on. The branch is read, never
merged: nothing is applied, no branch moves, and your checkout stays where it
is.

Only the harness may differ — AGENTS.md, manifest.yaml, skills/**, bin/**,
tools/**, data/** — and a change anywhere else is refused by name. manifest.yaml
may only change its declared resource lists; evals/** can never be proposed.

--eval with --mode binds the proposal to diagnosed evidence: the exact EvalRun
and the failure mode ids \`ahde diagnose\` printed. Without them it is a
construction proposal that the approved Spec alone justifies, which \`ahde
candidate\` will verify but which carries no diagnosis. Sealed holdout evidence
can never steer a proposal and is refused here.

Prints the builder-run id, the base revision, and the changed paths.`,
	apply: `Usage: ahde apply --target <dir> --builder-run <id> [--branch candidate/<name>]
                  [--reason <text>] [--actor <id>]

Apply one reviewed proposal: a candidate commit on its own new branch, plus the
durable apply receipt that binds proposal hash, base and candidate revisions.
The commit is made in a private worktree, so the operator's checkout never
moves and no existing branch is touched. --branch defaults to
candidate/<builder-run-id> and must not already exist.

The proposal's base SHA, every file hash, and the path allowlist are re-checked
against the repository before anything is written; a stale or out-of-scope
proposal is refused with nothing applied.

Prints the branch, the candidate SHA and the proposal hash.`,
	adopt: `Usage: ahde adopt --target <dir> --candidate <id> [--reason <text>] [--actor <id>]

Make the promoted revision the active Target: one fast-forward of the current
branch onto the exact evaluated candidate, with a durable adoption receipt.
Running the command is the human confirmation.

It refuses, by name, anything that is not exactly that: an uncommitted change
in the checkout, a candidate that was never promoted, a promotion tag that does
not point at the evaluated commit, a HEAD that is not the candidate's baseline,
or a fast-forward that is not one. Re-running a completed adoption reports it
as already adopted rather than repeating it.`,
	review: `Usage: ahde review --candidate <id> --recommend promote|reject --reason <text> [--actor <id>]
                   [--proposal-hash <sha256>]

Record a human review over the exact evaluated Candidate evidence. For a promote
recommendation on a candidate improve/search applied automatically, the first
call prints its exact diff and refuses to record the review. Read it, then repeat
with the printed --proposal-hash; a missing or stale hash is never accepted.
Reject remains possible even when a proposal artifact is damaged.`,
	promote: `Usage: ahde promote --target <dir> --candidate <id> --to <semver> --reason <text> [--actor <id>]

Tag the exact reviewed Candidate revision. This does not switch the active checkout.`,
	reject: `Usage: ahde reject --candidate <id> --reason <text> [--actor <id>]

Record an immutable rejection for the exact reviewed Candidate.`,
	log: `Usage: ahde log --target <dir> [--project <id>] [--limit N] [--json]

The agent's growth, version by version. One row per promotion, newest first:
the tag, the date, baseline -> candidate revision, the development score with
its 95% interval, the sealed verdict and how big that exam was, the cost ratio,
the failure modes the promotion resolved, your own reason, and \`applied by the
improvement loop\` when the apply receipt says so.

Rejections appear as dimmed rows between the promotions, because a growth curve
drawn only from the wins is a sales deck. Under the rows: a bounded sparkline of
development score per version and what the whole log cost.

A resolved failure mode is one the source diagnosis named whose every attached
task flipped fail->pass between the two development arms. That is a description of a
promotion, never evidence for one — per-task flips never decide a verdict.

A sealed row carries a verdict and a size and nothing else: never a task id,
never an input, never the corpus it came from.

A pure read. No model call, nothing written, no state changed. --json prints
the same projection.`,
	watch: `Usage: ahde watch --target <dir> [--project <id>] [--corpus <development-id>]
                  [--every <30s|5m|2h|1d>] [--once] [--jobs N] [--repetitions N]
                  [--max-runs N]

Run the basket against the ACTIVE Target revision on a schedule and tell drift
apart from noise. Each tick is ordinary development evidence (label \`solo\`,
never a candidate arm) compared with the previous tick of the same revision.

Nothing about the Target moved between two ticks, so the pair is an A/A
experiment and the honest verdict is \`inconclusive\`:

  inconclusive  healthy
  regressed     DRIFT — the 95% interval is entirely below zero while the
                harness revision did not change
  improved      DRIFT as well. On an unchanged revision a gain is not a win.

When this revision has an A/A calibration the line shows its flip rate, so you
can see whether today's difference is inside known noise; without one it says
\`noise not calibrated\` and points at \`ahde calibrate\`.

One line per tick:
  watch 2026-08-31T10:00 · 88.9% vs 90.0% · inconclusive · flip 10% (calibrated) · $0.12
The first score is this tick, the second the tick it was compared with.

A drift says behaviour changed below the harness boundary. It can come from a
provider/model rollout, stochastic variance, runtime, tool, or external-data
change; watch does not invent a root cause from scores alone.

A drift changes no durable state beyond the ordinary eval run the tick produced:
nothing is promoted, adopted, or written as a receipt. The previous tick is
found by scanning eval-run indexes — watch stores nothing new.

--once (the default without --every) runs one tick and exits. --every loops on
a monotonic schedule until SIGINT; --max-runs bounds it. Exit 0 = healthy,
3 = drift, 2 = no comparable baseline yet.`,
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
	const nested = command === "corpus" || command === "feedback" || command === "tool" || command === "spec"
		? argv.find((token, index) => index > 0 && !token.startsWith("-"))
		: undefined;
	return COMMAND_HELP[nested ? `${command} ${nested}` : command] ?? CORE;
}
