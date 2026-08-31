# AHDE — build, evaluate, and improve Pi agent harnesses

AHDE turns a rough agent idea into a reviewed, testable harness without
training model weights:

```text
intent -> Spec -> Target harness + eval corpus -> runs + diagnosis
       -> proposal -> candidate experiment -> human promote or reject
```

Bare `ahde` opens a real, long-lived **Builder Pi**. You describe the agent in
ordinary language; Builder Pi structures the Spec, helps assemble evaluation
cases, runs and diagnoses the agent, and proposes bounded changes to its
instructions, skills, and tools.

The agent being built is a different **Target Pi**. It runs in fresh sessions
with only the Target resources and capabilities declared by its harness.

```text
$ ahde
   |
   v
Builder Pi (conversation + packaged Builder skills)
   |
   | trusted, typed AHDE tools
   v
AHDE core (immutable artifacts, provenance, evals, human gates)
   |
   | fresh session + isolated workspace per task
   v
Target Pi (the harness under test)
```

There is no RL, fine-tuning, or autonomous self-promotion. AHDE improves
versioned context and capabilities, not model weights.

## Start locally

AHDE requires Node.js 22.19 or newer.

```bash
npm ci --ignore-scripts
npm run build
mkdir my-agent
cd my-agent
../dist/cli.js                 # describe the agent; guided setup happens here
```

When AHDE is installed globally or linked, the last command is simply:

```bash
ahde
```

A typical Builder conversation looks like — three questions in a whole cycle:

```text
> Хочу собрать агента для ...
Builder: Давай уточним пользователей, задачи и ограничения…
Builder: Вот описание агента. Начинаем тесты?

> Да, запусти тесты
AHDE asks once: approve this Spec, publish 24 cases, run 72 executions
                (~$0.40, about 4 min)?  [y/n]
Builder UI: AHDE run 7/24 · tool search ✓
Builder: 18/24 passed. Нашёл 3 системных failure mode.

> Исправь первую проблему
Builder: Подготовил правку для AGENTS.md и skills/search.
AHDE asks once: apply this exact diff to candidate/…?  [y/n]
Builder UI: проверяю кандидата против базовой версии… (без вопросов)
Builder: Development improved, sealed gate passed.

> Выкати
AHDE asks once: ship as v0.2.0 — promote, fast-forward main, next cycle?  [y/n]
```

Everything between those three questions just happens: runs, checks,
calibration, and the diagnosis. A run that history says would be unusually
expensive (over `AHDE_ROUTINE_COST_USD`, default 2, or `AHDE_ROUTINE_MINUTES`,
default 10) asks one extra yes/no first, and so do the two irreversible
throw-aways (discard a proposal, reject a candidate).

The same loop has compact Pi commands: three verbs do the work, and every
older command is still there, one step at a time.

```text
/test [repetitions]     test the agent: approve and publish whatever is pending,
                        run the basket, or verify the applied candidate
/fix [n]                fix problem n: refresh the traces, prepare the exact
                        change, show the diff
/ship <version>         ship the verified candidate: promote, adopt, next cycle

/status                 where you are and what to say next
/review                 the exact Spec, eval basket, diff, or candidate — with its actions
/traces                 diagnosis, failure modes, and the evidence link
/target [resource]      the exact committed Target or one declared resource
/doctor  /help          readiness and recovery · this reference

/run [repetitions]      alias of /test
/calibrate [reps]       measure run-to-run noise: the same revision against itself
/approve  /publish      approve the Spec · publish the eval basket, one at a time
/apply <branch>         apply the reviewed proposal to a candidate branch
/discard                discard a proposal or abandon an interrupted candidate
/promote <version>      promote the verified candidate without adopting it
/reject                 reject the verified candidate
/adopt                  fast-forward the current branch to the promoted candidate
/next                   close the cycle and continue from the active Target
```

Every command renders a human block in the transcript (persisted, never sent
to the model) and offers the decisions that are legal right now. `ahde
continue` reopens the most recent conversation; `ahde resume` opens the
session picker; workflow state is durable either way. The embedded Pi host
cannot import, export, share, trust, or execute shell commands; those
built-ins are removed before autocomplete and dispatch. Builder credentials
live once in `~/.ahde` (`AHDE_HOME`), so one login serves every project.

A first run in an empty directory asks two things — create the agent here?
which model should it use? — and then the header shows where you are:

```text
AHDE Builder · build, evaluate, and improve another agent through evidence
Target competitor-research @ 3f2a9c1b · openai/gpt-5 ✓
Stage Spec design · Next Describe the agent; the Builder drafts a Spec
Evidence 0 eval runs · 0 open proposals · 0 candidates · Builder model openai/gpt-5 ✓
```

Builder Pi has no generic shell, edit, or write tool. It can act only through
the packaged AHDE tools, which expose bounded views and call the deterministic
application core.

While `/run` or a natural-language Workbench decision is executing, Builder Pi
shows one bounded provisional widget with run position, assistant messages,
and tool spans. The stream is credential-redacted, development-only, and
host-UI-only: it never becomes Builder model context or promotion evidence.
The widget always clears on completion, cancellation, or failure. Direct
`ahde run` callers receive compact run counters on stderr while the existing
final stdout remains stable.

The model-facing control surface is intentionally only three deep operations:

- `ahde_workbench_view` reads the restart-safe stage and bounded evidence;
- `ahde_workbench_submit` authors drafts, revisions, semantic Harness intents,
  or an explicit selection without granting authority;
- `ahde_workbench_decide` requests one stage-legal transition through the
  trusted human gate.

The same `ahde_workbench_view` now provides context-aware Harness authoring
without becoming a filesystem tool. `aspect: target` returns a deterministic
index of the exact committed `AGENTS.md`, declared skills, and declared tool
descriptor/executable pairs. Supplying one returned `resourcePath` returns its
complete UTF-8 Git blob and hash. The host owns Target id and revision; raw
`manifest.yaml`, eval files, `.env`, `.git`, `.ahde`, runs, symlinks, ambient
files, dirty worktrees, and stale revisions fail closed. Builder reads every
existing resource it will replace before submitting semantic intents.

The Workbench derives state from validated immutable artifacts and receipts.
Actionable Proposals additionally require a project-owned admission receipt
binding the exact approved Spec, Builder record, and Proposal hash before any
referenced evidence is opened. Its small atomic `focus.json` only resolves an
explicit selection; it cannot manufacture an approval, corpus lineage,
proposal decision, or candidate outcome.

## What gets built

Guided setup (or the scriptable `ahde init`) creates one generic Target Pi
harness and its initial Git revision:

```text
manifest.yaml
AGENTS.md
skills/<skill>/SKILL.md
tools/<tool>.tool.yaml
bin/<tool>
evals/development.jsonl
evals/graders.yaml
.gitignore
```

The built-in template includes `echo_json`, a complete declarative Target tool.
A tool descriptor defines:

- a name, description, and strict JSON Schema for parameters;
- a static argv array with no shell interpolation;
- JSON input on stdin and bounded JSON or text output on stdout;
- timeout and maximum output size;
- explicit environment, network, and filesystem permissions.

Descriptors and executable bytes are hashed into `toolsetHash`. At execution,
AHDE reloads and verifies that identity, scrubs the environment, applies the
declared policy, records tool spans, and fails closed when a required sandbox
cannot be established. Arbitrary Target JavaScript or TypeScript is never
imported into the AHDE process.

The scaffold intentionally starts with a placeholder model. On the first
Builder session, describe the exact Target model you want. Builder Pi shows the
complete non-secret `manifest.yaml` diff and the host makes a one-time bootstrap
commit after confirmation. The credential value is never accepted by a Builder
tool: set only the API key named by the confirmed `model.apiKeyEnv` through the
trusted host environment. You can then validate without making a model call:

```bash
ahde validate --target .
```

To talk to the built agent itself, launch a separate disposable Runtime Pi:

```bash
ahde target
ahde target --message "Start with this task"
# Or select a different Target explicitly:
ahde target --target ../another-agent
```

Without `--target`, AHDE uses the current directory. This is not Builder Pi in
another mode. AHDE starts it in a dedicated child
process with a hash-checked workspace snapshot, manifest-declared skills and
tools, an in-memory session, and a private credential store. Its Node loader
starts without inherited environment; selected credential, runtime allowlist,
and fixed display/locale values arrive only over post-startup IPC. Interactive
shell escapes and ambient session/import switching are disabled. Nothing from
this conversation becomes canonical eval evidence.

### Feedback becomes tests

Any reply in `ahde target` can be marked with `/good`, `/bad [note]`, or the
`alt+g` / `alt+x` shortcuts (Pi's own defaults already own `ctrl+g` and
`ctrl+b`). A mark appends one JSON row to `imports/feedback.jsonl`:

```json
{"messages":[{"role":"user","content":"…"},{"role":"assistant","content":"…"}],
 "verdict":"bad","note":"did not call check_dbo","at":"2026-08-30T07:00:00.000Z",
 "target":{"id":"my-agent","gitSha":"…"}}
```

The dialogue runs up to and including the marked reply, credential-redacted and
bounded exactly like a dialogue case (≤ 40 turns, ≤ 8 KiB each). The Target
child never opens that file: it sends the verdict, the note, and the turns to
the host process over the same IPC channel that delivered its launch payload,
and the host stamps the timestamp and Target identity. A host that is gone
fails the mark closed rather than writing from the child.

```bash
ahde feedback list     # counts, plus the last five by their first user turn
ahde feedback clear    # moves the file to imports/feedback.<timestamp>.jsonl
```

`imports/feedback.jsonl` is an ordinary entry in the git-ignored `imports/`
inbox, so the dataset preview/recipe flow picks it up like any other dropped
file: it previews as bounded JSONL with `messages`, `verdict`, `note`, `at`,
and `target.*` columns, and a recipe with `{ "dialogue": { "column":
"messages" } }` compiles each mark into a dialogue case. The compiler pops the
marked assistant reply, so the case re-asks the question that produced it and
graders judge the next answer; keep `verdict` and `note` as metadata columns so
a rubric or reference answer written later can use what the operator said was
wrong. The inbox never enters a Target or evaluation workspace.

## The canonical loop

Builder Pi uses four packaged workflow skills:

- `design-agent` turns rough intent into a typed Spec draft;
- `design-evals` builds a reviewable development basket;
- `run-diagnose` evaluates Target Pi and groups failure modes;
- `improve-harness` prepares and verifies a bounded candidate change.

The durable loop is:

```text
Spec draft --human approve--> approved Spec
Spec-bound corpus revisions --human publish--> development Corpus + lineage
Target runs --> deterministic Diagnosis --> read-only evidence link
semantic Harness intents --> compiled exact Proposal --human apply--> candidate commit
matched development + sealed evaluation --> human review
review --human decision--> promoted immutable revision or rejection
promoted revision --human adopt--> active Target branch fast-forwarded
terminal candidate --human continue--> next cycle from the active Target
```

Promotion only tags the exact reviewed revision. `/adopt` (or the
`adopt-candidate` decision) fast-forwards the operator's current branch from
the candidate baseline to that revision, so the promoted harness becomes what
`ahde target` runs and what the next cycle measures. `/next` records that the
reviewed loop is closed and lets the Workbench derive the next stage from the
active Target — usually another run after an adoption, or another proposal
after a rejection. Both steps write receipts that bind the exact candidate
record; a receipt that stops matching blocks the Workbench.

Approve, publish, apply, review, promote, and reject are host-owned decisions.
Their tool schemas do not accept model-supplied `actor`, `approved`, or
`confirmed` fields. In interactive TUI mode AHDE reloads the subject, displays
the exact hash or diff, asks the operator, revalidates it, and writes a durable
receipt. Consequential calls fail closed outside an interactive TUI.

The conversation reaches those decisions through two composites, so the whole
cycle asks three questions: `start-testing` (approve the Spec draft, publish the
reviewed basket, run), `apply-proposal` (the exact diff), and `ship` (review,
promote, adopt, continue). A composite is orchestration, not new authority: it
calls the same services in the same order, writes the same receipts, and stops
at the first step that declines or fails. Discarding a proposal, rejecting a
candidate, and abandoning an interrupted attempt are one short question each.
Measurement — running the basket, verifying a candidate, calibrating noise —
is routine: it runs without a dialog, may run headless, and asks once only when
history estimates more than `AHDE_ROUTINE_COST_USD` (default 2) or
`AHDE_ROUTINE_MINUTES` (default 10), or when nothing comparable has run yet.

Corpus revisions are immutable and content-addressed. Publishing records both
the canonical Corpus receipt and an exact Workbench lineage binding approved
Spec, reviewed draft, and development dataset hash. A compatible EvalRun must
additionally match the current Target revision and suite hash. Structured
Harness authoring accepts semantic instruction/execution-policy/skill/tool
intents; only the host compiler chooses repository paths, file modes, hashes,
and unified diffs. There are no product presets for agent types. A request such
as “build a deep research agent” follows the ordinary Spec → eval → diagnosis
→ Proposal path; when evidence shows that network research is required, AHDE
proposes the exact policy, environment-variable names, descriptor, and
executable for human review and candidate verification.

After a failed development evaluation, Builder selects only stable
`failureModeId` handles from the current deterministic Improvement Brief. The
model cannot submit diagnoses, evidence references, or root-cause claims. AHDE
recompiles the exact EvalRun/Diagnosis/Brief tuple, derives bounded run
references and explicitly labels the mode explanation as a hypothesis, then
persists full Brief and mode hashes with the Proposal. Restart, review, and
Apply revalidate that basis. Thus “исправь первую проблему” means “refresh the
traces, resolve ordinal 1, and prepare an exact diff for review”; it never
silently means Apply.

Builder Pi can also import a bounded JSONL file from the project-local
`imports/` inbox into a new editable draft. The inbox is git-ignored and never
copied into Target Pi or evaluation workspaces. AHDE rejects all paths outside
that inbox, symlinks, traversal, private state/run paths,
unstable reads, oversized files, and malformed tasks; caller-owned task ids are
discarded and an immutable source path/hash receipt is recorded and revalidated
after restart. Graders can be edited independently with `grader.add`,
`grader.update`, and `grader.remove` (or replaced as a bounded set with
`set-graders`). After a development failure, Builder
can use `add-case-from-run` to author a genuinely new neighboring regression
case. AHDE accepts only exact hash-indexed failed development evidence from the
current Spec/Target/corpus lineage and persists bounded ids and hashes, never
the trace answer. Passing, infrastructure, foreign, candidate, duplicate, and
sealed sources fail closed.

## Evidence Explorer

After an evaluation, Builder Pi can return a localhost link to the exact
diagnosis and traces. You can also start the explorer explicitly:

```bash
ahde diagnose <eval-run-id>
ahde evidence
```

`/run`, `/traces`, the CLI, and this report all consume the same deterministic
Improvement Brief. New evidence is grouped only by an exact grader-check
fingerprint; a mode becomes systemic after it appears on at least two distinct
tasks. The report keeps counter-evidence, labels explanations as hypotheses,
and reserves a representative trace for each top mode. Infrastructure errors
leave the brief inconclusive and ineligible to steer a proposal.

The server binds to `127.0.0.1` and accepts only `GET` and `HEAD`. It renders
already-created canonical evidence; HTTP requests cannot run an eval, create a
diagnosis, apply a proposal, or make a decision. During a run started inside
the long-lived Builder, the same host also serves a random capability URL with
a bounded, redacted, memory-only SSE view. That URL is shown only in host UI,
is never listed, expires after 15 minutes, and disappears on restart.
The Builder repeats the capability URL after completion or failure so the
retained view remains reachable after its live widget is cleared.

Live `RunEvent` observations deliberately stay in process. AHDE does not write
a second event journal, tail mutable run directories through HTTP, or expose
sealed holdout progress. Browser text is inserted with `textContent`; Host,
Origin, CSP, same-origin resource policy, memory, frame, viewer, and TTL bounds
are enforced. The live page labels EvalRun ids as provisional rather than
linking to evidence before diagnosis exists. After completion, `/traces` links
to the existing hash-verified report built from canonical `session.jsonl` and
`run.json`.

Sealed holdout cases, graders, expected outputs, identifiers, and traces are
never shown to Builder Pi or the Evidence Explorer. The evaluator gives Target
Pi one sealed case at a time, and only bounded gate results cross that boundary.

## Driving the Workbench from your own backend

`ahde serve` puts the same Workbench behind a local HTTP/JSON API so a platform
can run the loop and render the confirmations in its own UI:

```bash
ahde serve --target . --port 4700 --token-file ./serve.token
```

```
GET  /v1/health                  is it up, what stage, how many pending confirmations
GET  /v1/view                    the same projection the Builder's view tool returns
POST /v1/submit                  the same non-consequential authoring the submit tool does
POST /v1/decide                  200 with the decision, or 202 awaiting-confirmation
GET  /v1/confirmations           what the operator has to answer right now
POST /v1/confirmations/<id>      { approved, subjectHash } — the answer, and the result
GET  /v1/events                  SSE: workbench-changed, run-progress, confirmation-*
```

The gate is injected, not removed. A consequential decision opens a pending
confirmation bound to the exact host-minted `subjectHash` and blocks; it
proceeds only when that exact id is answered with that exact hash. A wrong
hash, an unknown id, a second answer, an expiry (default 10 minutes) and a
shutdown are refusals — never approvals. Routine measurement runs without a
question under the same cost guard, and an expensive run escalates to a pending
confirmation like any other.

Authority stays host-side: the actor is the API's own authenticated identity
and a body carrying `actor`, `actorId`, `approved`, or `confirmed` is refused
rather than sanitized. The server binds `127.0.0.1`, mints one bearer token at
startup and prints it once to stderr, checks `Host` and `Origin`, sets no CORS
headers, allows only the declared method per route, bounds every body, and
holds one session per project unless `--allow-concurrent` says otherwise.
Choosing a Target model still needs the trusted host catalog, so bootstrap
remains a local-TUI step.

## Judge graders, and checking the judge

A `judge` grader can ask for prose or for a checklist. Prefer the checklist: a
rubric split into isolated yes/no assertions is answered one behaviour at a
time, and every failure names the check that failed instead of arguing with a
paragraph.

```yaml
graders:
  - type: judge
    assertions:
      - "the answer states the refund window in days"
      - "the answer names where the customer files the claim"
      - "the answer promises nothing the bank does not offer"
    jury: 3          # optional: 3 independent judges, majority decides
    rubric: "…"      # optional: shared context for all assertions
```

The judge answers `yes`, `no`, or `unknown` per assertion with its evidence.
Unknown counts as no — an unanswered check has not been passed — the score is
`yes / total`, and the grader passes only when every assertion is yes. The
recorded reason names the failures by index: `assertion 2 failed: канал не
назван; assertion 3 unknown: ответ слишком короткий`. Failure modes are still
fingerprinted on the grader spec, never on the judge's wording.

`jury: n` runs n independent judge calls and takes a strict majority per
assertion; a tie has decided nothing and therefore fails, and the reason keeps
the vote counts (`2/3`). Each juror keeps its own retries and its own sidecar
(`judge/<grader>.<juror>[.<attempt>].json`), and the run's judge metrics sum all
of them. A single judge stays pinned to temperature 0; a jury deliberately does
not, because three identical greedy calls measure nothing.

A judge nobody has checked is an opinion with a token cost. `ahde label` shows
you **exactly what the judge was shown** — the request, or the goal and the
whole bounded conversation on a simulated-user case; the final answer; the
rubric it was asked; the reference answer when the grader used one; and the
assertion list as a checklist — takes your blind verdict, and only then reveals
what the judge said:

```bash
ahde label <eval-run-id> --target . --sample 30 --seed calibration-1
ahde label <eval-run-id> --target . --file ./labels.jsonl   # non-interactive
ahde judge-agreement <eval-run-id> --target .
```

One function, `judgeSubjectFor(run, grader)`, derives that object, and the judge
prompt builders call it too — so the two cannot drift into grading different
things. On an assertion rubric the screen asks yes / no / unknown per assertion
and the label records both sides, so agreement is measured check by check: a
judge that is wrong about one of twelve reads as 92%, not as a failed label.

Labels land in `<state-root>/projects/<id>/labels/<eval-run-id>.jsonl` as
`{ runId, taskId, graderIndex, graderSpecHash, subject?, subjectHash?,
assertions?, judgeAssertions?, human, judge, note?, at }`. They are notes about
an instrument, not evidence about a Target: no receipt, no provenance axis, and
sealed evidence is never labelled. `ahde report`, the HTML report, the candidate
review block, and the promote confirmation then all show one line — `judge
agreement 84% · κ 0.62 · n=50`, or `judge not calibrated`.

Labels written before the screen showed the judge's own subject stay valid and
stay in the report, but they graded a different object, so they do not count
toward `requireCalibration` unless the Target writes
`allowLegacyLabels: true`.

A Target that wants that line to be more than information can say so:

```yaml
evalSuite:
  judge:
    # …model fields…
    requireCalibration: { minAgreement: 0.8, minLabels: 30 }
```

With it set, promoting evidence graded by an unchecked judge is refused with
the exact numbers. Unset by default — measuring the instrument is worth doing
long before it is worth blocking on — and evidence that no judge graded is
never affected. Add `allowLegacyLabels: true` to count labels collected under
the older screen as well.

### Setting up the evaluator models without YAML

The judge and the simulated user are chosen the same way the Target's own model
is: the Builder asks for `configure-evaluators` with a provider and a model id
from the host catalog, the host resolves the endpoint, limits and pricing, asks
**you** which environment variable holds the key, shows the exact `manifest.yaml`
diff, and commits on your confirmation. A credential value never enters the
conversation, and the variable name is never chosen by a model. A judge equal to
the Target's own model is refused: a model grading its own twin agrees with
itself, and that is an echo, not calibration.

`ahde validate` then reports both beside the Target model:

```
  key TARGET_MODEL_API_KEY: set
  judge: configured · anthropic/claude-sonnet-4 · key TEST_JUDGE_KEY set
  simulatedUser: not configured
```

## Scriptable commands remain available

The conversational Builder is the primary UX. Explicit commands remain a
compatibility and automation surface over the same application services:

`--jobs` bounds concurrent executions inside one evaluation (default 4, or 1
against a loopback model endpoint); `--baseline-max-age <days>` bounds how old a
reused baseline may be (default 7).

```bash
# inspect and evaluate
ahde validate --target .
ahde run --target . --label baseline --repetitions 3 --jobs 4
ahde list
ahde diagnose <eval-run-id>
ahde compare <baseline-eval-id> <candidate-eval-id>
ahde report <eval-run-id>

# re-score recorded traces with graders — no new model calls
ahde regrade <eval-run-id> --target . --graders ./strict-graders.yaml

# check the judge against your own eyes
ahde label <eval-run-id> --target . --sample 30 --seed calibration-1
ahde judge-agreement <eval-run-id> --target .

# 👍/👎 marks collected while talking to the Target
ahde feedback list --target .
ahde feedback clear --target .

# manage versioned evaluation data
ahde corpus publish --project my-agent --draft <builder-corpus-draft-id> \
  --name "reviewed development basket" --visibility development
ahde corpus import --project my-agent --name "promotion holdout" \
  --visibility sealed --file ./private-holdout.jsonl

# turn any data file in imports/ into eval cases
ahde corpus inspect --project my-agent --file imports/support-tickets.csv
ahde corpus ingest --project my-agent --file imports/support-tickets.csv \
  --recipe @recipe.json --name "support basket" \
  --sealed 40 --seed exam-1 --stratify-by tier

# the cheap check before the expensive one: the failed cases, once, one arm
ahde check --target . --candidate <candidate-id>

# improvement cycles inside the gates; promotion is never the loop's
ahde improve --target . --until 90% --max-cycles 5 --jobs 4

# search, not one guess: 2-4 changes for one problem, one Pareto table
ahde search --target . --candidates <builder-run-a>,<builder-run-b> --jobs 4
ahde improve --target . --until 90% --max-cycles 5 --candidates 3

# exact candidate experiment and terminal human decision
ahde candidate --target . --builder-run <builder-run-id> \
  --project my-agent --development-corpus <development-corpus-id> \
  --holdout-corpus <sealed-corpus-id> --repetitions 3 \
  --jobs 4 --baseline-max-age 7
ahde review --candidate <candidate-id> --recommend promote \
  --reason "Development improved and sealed gate passed"
ahde promote --target . --candidate <candidate-id> --to 0.2.0 \
  --reason "Ship the exact reviewed revision"
```

`ahde regrade` re-scores the recorded traces of an existing eval run and never
calls the Target model again: each case keeps the graders it carried when its
trace was recorded — the dataset must hash-match the source eval — while the
suite defaults that fill in for cases declaring none come from `--graders` or
from the Target's current `evals/graders.yaml`, and the judge model comes from
the current manifest. The result is an ordinary eval run whose `suiteHash` is
recomputed from the graders actually used, so regrading a baseline and a
candidate with the same graders makes them comparable to each other while a
regrade whose graders changed is refused against its own source; sealed evidence
stays sealed and prints counts only.

`ahde check` runs a candidate on only the cases its source eval recorded as
failing, once, candidate arm only, instead of the full
`(development + sealed cases) x repetitions x 2 arms`. It is a screen and never
evidence: its EvalRun atomically carries `purpose: "screen"`; that purpose (not
the one-arm `solo` label) excludes it from baseline reuse, comparison, promotion,
regression cases, and Workbench evidence. Every screen is also recorded under
`runs/screens/` as a fail-closed backstop. `verify-candidate` stops on a flat verdict
unless the operator forces the measurement anyway.

`ahde improve` runs the same cycle over and over — run, diagnose, apply the next
unapplied Builder proposal on `candidate/auto-<loopId>-<n>`, cheap check, verify
what looks promising. In Builder Pi, one consequential confirmation shows the
whole planned execution bound before any proposal is applied; invoking the
low-level CLI command is the corresponding bounded authorization. It stops and
hands back when the target pass rate is reached, the cycle
budget is spent, a development verdict is not `improved`, the cheap check is flat
twice in a row, infrastructure errors go over the budget, or a verified candidate
is ready. It never touches the sealed guardrail and never promotes, adopts,
publishes a corpus or approves a Spec. A promotion additionally drafts the cases
it flipped fail→pass as regression guards; the operator publishes that draft like
any other. The loop also refuses to re-propose a change whose changed files and
targeted failure mode match an attempt that already ended rejected or not
`improved`, and stops with that reason once every proposable mode is used up: the
Builder reads the same memory before it authors, through
`ahde_workbench_view` with `aspect: "history"` and the `priorAttempts` the
committed-Target view carries.

An automated improve/search apply is recorded as such; it does not claim the
operator read that proposal. Before a promote recommendation, Candidate review
shows the exact diff. The public `ahde review` command prints it and refuses the
first time, then requires the printed `--proposal-hash`; Builder Pi binds the
same hash into review and ship. Rejection stays possible even if that artifact
is damaged.
The loop stops at the first verified candidate. It does not expose a compound
mode until one final matched and sealed comparison can honestly cover the whole
stack.

`ahde search` spends the same money on several hypotheses instead of one. Give it
2–4 unapplied proposals that all target the same failure mode; it applies each on
its own `candidate/search-<searchId>-<n>` branch, screens each with the cheap check, pays for
the full matched development verification only where the screen found something,
and prints a Pareto table — verdict, score delta with its 95% interval, cost and
latency ratios, the screen's numbers, and which candidates are dominated. A
candidate is dominated when another verified candidate is at least as good on
both score delta and cost ratio and strictly better on one of them (exact ties
break by candidate order). Only `improved` development verdicts enter the
release frontier, so it is honestly empty when every hypothesis is flat. A flat screen and an
exhausted `--budget` are named in the table, never applied silently. Sealed
verification is not part of a search: you pick one candidate and that one goes
through the unchanged sealed gate and promotion. `ahde improve --candidates N`
runs the same search inside a cycle.

Corpus drafts and proposals are authored in Builder Pi; the commands above only
publish, evaluate, and decide over the artifacts it produced. The typed proposal
contract in `src/builders/adapters.ts` stays the single trust boundary every
proposal crosses, whoever authored it.

## Evidence and promotion invariants

Each run records the exact Target Git revision, model and Pi runtime,
instructions, skills, toolset, dataset and suite hashes, effective environment,
sandbox result, traces, metrics, and graders. Infrastructure errors are
inconclusive, never silently converted into behavioral failures.

Candidate Experiment:

1. resolves immutable baseline and candidate SHAs;
2. rejects lineage and file-scope violations before model calls;
3. creates detached worktrees without switching the user's checkout;
4. runs matched task/repetition designs;
5. verifies execution and grading fingerprints;
6. judges paired task deltas under one comparison gate: a seeded bootstrap
   95% interval decides `improved · inconclusive · regressed` on the
   development surface and `pass · fail · underpowered` on the sealed
   guardrail (at least 15 tasks × 2 repetitions); per-task drops are flags
   for the reviewer, never a verdict;
7. persists one canonical `CandidateRecord` with the verdicts.

Only `AGENTS.md`, `skills/**`, `tools/**`, `bin/**`, `data/**`, and the
`skills`/`tools`/`data` declaration lists in `manifest.yaml` may change in a
Builder proposal. Target
id, model, execution policy, instructions, eval suite, and `evals/**` remain
fixed. Promotion requires an applied proposal with a durable receipt,
comparable development evidence whose verdict is not `regressed`,
evaluator-owned sealed evidence with a guardrail `pass`, honest workspace
confinement, an explicit human promote review, and the exact candidate
revision. A failed or underpowered sealed gate is kept as evaluated evidence
and refused at promotion; a manual experiment or unconfined run cannot be
promoted. Legacy eval-run indexes that predate the current provenance axes
are listed as `legacy · not comparable` and never reused as baselines.

## Storage and trust boundaries

```text
<target>/
  manifest.yaml, AGENTS.md, skills/**, tools/**, bin/**, data/**, evals/**
  imports/**            git-ignored inbox; feedback.jsonl lands here

<state-root>/projects/<project-id>/
  specs/**, builder-corpus-drafts/**, builder-corpus-imports/**, corpora/**
  labels/<eval-run-id>.jsonl   human judge labels; notes, never a receipt
  approval receipts
  workbench/{focus.json,corpus-publications/**,candidate-abandonments/**}

<state-root>/builder-pi/
  sessions/**

~/.ahde/builder-pi/config/**
  auth.json, models.json, settings.json   (user-level; AHDE_HOME overrides ~/.ahde)

<runs-root>/
  <run-id>/{run.json,session.jsonl,judge/**}
  <eval-run-id>/{eval_run.json,diagnosis.json,report.html,...}
  builders/<builder-run-id>/**
  candidates/<candidate-id>/candidate.json
```

Builder and Target are separate Pi invocations with different system prompts,
skills, tools, session/config roots, workspaces, and credentials. Builder may
inspect only bounded public harness files through AHDE tools. Target never sees
Builder state or evaluator-owned sealed storage. AHDE resolves exactly the
confirmed Target credential in the host and injects only that value into an
in-memory provider store; Target Pi cannot resolve arbitrary ambient secrets.
Every task in one EvalRun is copied from the same hash-checked source snapshot,
and that exact workspace hash is persisted in both `eval_run.json` and every
member `run.json`. A dirty or concurrently changing checkout therefore cannot
silently masquerade as the committed Git SHA or be reused as another baseline.

Durable artifacts are strict, schema-versioned, size-bounded, atomically
written, and validated again on read. Immutable evidence uses exclusive
publication. Sealed means workflow-hidden and evaluator-owned; it is not a
claim of encryption against the local machine owner.

## Verify the shipped product

```bash
npm run check
npm run demo
npm run verify:package
```

`npm run demo` exercises the production-shaped improvement loop — baseline,
proposal, apply, matched candidate experiment, promotion, adoption of the
promoted revision, and the next cycle — with a local scripted OpenAI-compatible
model, so it uses no paid tokens.

`npm run verify:package` tests the artifact an npm user actually receives. It
packs AHDE under size/file budgets, installs the tarball into an empty consumer,
scaffolds and validates a Target, starts the isolated Builder host, executes the
template's declarative `echo_json` tool through the OS sandbox, and exercises
both canonical reports and a capability-scoped live SSE feed over a real
loopback HTTP socket. The separate
natural-language acceptance tests drive a real Builder Pi through the complete
Spec/eval/candidate lifecycle and, separately, through the production
three-tool `traces → exact Target context → Proposal review` path without an
implicit Apply. The package gate also rejects stale Studio, companion,
retired Workbench-TUI, and deleted one-shot-adapter files.

## Architecture

| Module | Owns |
|---|---|
| `src/builder/runtime.ts` | isolated long-lived Builder Pi host |
| `src/builder/extension.ts` | the three Workbench tools, their production dependencies, and Pi registration |
| `src/builder/commands.ts` | slash commands (`/test`, `/fix`, `/ship` first), review actions, one-dialog promote/reject |
| `src/workbench/transition-policy.ts` | legal stages, the consequential/one-question/routine gate policy, and the run cost guard |
| `src/builder/product-shell.ts`, `src/builder/onboarding.ts` | live header, first-run setup, readiness status |
| `src/builder/render/**`, `src/builder/transcript.ts` | human renderers for every Workbench view, decision, and confirmation; persisted transcript blocks |
| `src/application/target-adoption.ts`, `src/workbench/cycle-continuation.ts` | promoted-candidate fast-forward and cycle closure receipts |
| `src/application/target-authoring-context.ts` | exact-Git declared Harness context and read policy |
| `src/application/**` | deterministic Spec/Corpus/Proposal/Candidate use cases |
| `src/workbench/**` | restart-safe orchestration, state derivation, and legal transitions |
| `src/target/runtime.ts` | the single Target Pi construction seam |
| `src/target/interactive.ts` | dedicated disposable interactive Runtime Pi process |
| `src/target/tool-manifest.ts` | declarative tool validation and identity |
| `src/target/tool-broker.ts` | confined subprocess execution |
| `src/run-events.ts`, `src/builder/run-progress.ts` | bounded development-only live observation and TUI projection |
| `src/runner.ts`, `src/eval.ts`, `src/trace.ts` | isolated execution and evidence |
| `src/diagnosis.ts`, `src/application/improvement-brief.ts` | task evidence and exact-signature failure modes |
| `src/report.ts`, `src/evidence/server.ts` | bounded read-only evidence projection |
| `src/application/candidate-experiment.ts` | exact matched candidate evaluation |
| `src/application/candidate-review.ts` | review, rejection, and promotion authority |
| `src/builders/adapters.ts` | the typed proposal contract and its validation trust boundary |

See [CONTEXT.md](CONTEXT.md) for domain language and invariants,
[docs/V1_7_PRODUCT_SURFACE.md](docs/V1_7_PRODUCT_SURFACE.md) for the product
surface (header, renderers, transcript blocks, adoption, next cycle),
[docs/V1_2_BUILDER_WORKBENCH.md](docs/V1_2_BUILDER_WORKBENCH.md) for the
implemented Builder Workbench, and
[docs/V1_3_RUN_EVENTS.md](docs/V1_3_RUN_EVENTS.md) for the live observation
contract,
[docs/V1_4_SYSTEMIC_DIAGNOSIS.md](docs/V1_4_SYSTEMIC_DIAGNOSIS.md) for the
evidence-backed failure-mode contract,
[docs/V1_5_EVIDENCE_LINKED_PROPOSALS.md](docs/V1_5_EVIDENCE_LINKED_PROPOSALS.md)
for exact failure-to-proposal provenance,
[docs/V1_6_CONTEXT_AWARE_AUTHORING.md](docs/V1_6_CONTEXT_AWARE_AUTHORING.md) for
the declared exact-Git authoring context, and
[docs/V1_1_WORKBENCH_PLAN.md](docs/V1_1_WORKBENCH_PLAN.md) for the historical
two-Pi plan it supersedes.

## Deliberately out of scope

- RL, fine-tuning, reward models, or model-weight changes.
- Autonomous apply, promotion, merge, deployment, or self-modification.
- A mutable browser control plane, hosted tracing, teams, auth, or billing.
- Arbitrary Target code imported into the AHDE process.
- Multi-runtime execution, distributed runners, Kubernetes, or OTLP plumbing.
- Windows support in the initial local-first release.
