# AHDE — improve your agent, then prove what changed

Bring a Python or Pi agent, describe what it should do, and work with **Builder
Pi** to turn its failures into a reviewed change. AHDE runs the before/after
comparison, keeps an independent sealed exam, and produces a portable release
report with the exact diff, quality, cost and uncertainty.

Work in the terminal conversation (`ahde`): describe the outcome, inspect progress,
change direction, and let the Builder carry the work through the next useful step.
Open the optional localhost Evidence link for detailed recorded conversations and
before/after comparisons. Scripts can drive the same engine through the CLI.
AHDE changes instructions, skills and declared tools;
accepting an exact change and releasing a version remain host-owned decisions.

## Install

Node.js ≥ 22.19 and Git; Python 3 for the Python starter. On Linux, install
`bubblewrap` for sandboxed execution. The package carries its pinned Pi runtime
and is not on the npm registry yet, so install it from this checkout:

```bash
git clone https://github.com/OmgiKikov/tlepsh.git ahde
cd ahde
npm ci --ignore-scripts
npm run build
npm link
```

`npm pack` produces the tarball `npm install --global ./ahde-*.tgz` accepts;
`npm run verify:package` proves that tarball works in an empty consumer.

## Try the complete loop for free

From the checkout, run:

```bash
npm run demo
```

The demo takes a wrong refund answer through a retrieval fix, matched evaluation,
sealed verification and a released version. It shows the terminal case table,
failed conversation, numbered diff, before/after case scores and version card;
report, passport and dataset paths remain available afterwards. Models and
demo-host confirmations are scripted, with no API key or external calls. This
exercises execution and rendering, not unscripted Builder behavior or usability.

`npm run demo:pilot` runs two Python profiles: a RAG agent and a service agent
with accounts and tickets. Each has 15 golden cases plus separate capability
cases. It performs 70 real Python executions with local scripted model replies,
actual retrieval and isolated world state, then exports every available run,
including deliberate failures, for a separate metrics pipeline. No external API
is used. The [Python pilot PRD](docs/prd-python-agent-pilot.md) defines the customer
agent, IFT and metrics integration inputs still needed.

## Start your agent

```bash
ahde init my-agent --template python-support
cd my-agent
ahde            # describe your agent in the terminal conversation
```

Already have an agent folder? Run `ahde --target ./your-agent`. The Builder
guides adoption and model setup. An existing Python program needs the JSONL
protocol or a small adapter; the packaged `function_bridge.py` connects a
sync/async `respond(text)` function without rewriting it. Follow the
[complete Python connection walkthrough](docs/connect-python-agent.md) for the
adapter, your own test basket, and the first run. Use `ahde target` to talk to the built agent;
`/good` and `/bad` record feedback that can become test cases. The minimal Pi
starter remains the default for a bare `ahde init my-agent`.

A new agent is built before it is tested. Describe it, approve the description,
and the Builder writes the instructions, skills and tools in a workshop and
shows you the diff; accepting that first build makes it the working agent
without a candidate or a verification, because there is no agent yet to compare
it with. The tests come next and measure the agent you actually have; every
later change is checked on the development basket, and the sealed exam runs
once, at ship, citing the check's own development runs. An
adopted Python agent, or a template whose instructions you edited yourself,
already exists and starts at the tests.

Tell the Builder what to do in your own words: “build it”, “test it”, “show why
it failed”, “prepare a fix”, “check the change”, “show the version report”.
Commands are optional shortcuts. The host shows the exact description, cases, diff or release
before a consequential decision. Routine measurements proceed under the existing
cost policy; a changed or unusually expensive scope can need a new decision.
The browser is a read-only explanation of recorded work, opened when useful.
The compact Pi commands below are optional expert shortcuts for the terminal.

No test basket yet? Ask: **“Build a small test set from the description and our
knowledge base, including a customer who only gives their account number when
asked. Show me the cases before running them.”** The Builder can read explicitly
declared, committed `data/kb` Markdown/text documents and prepare an editable
development draft. Every case names its cell of the basket (`coverage`: a Spec
job × a difficulty, with the user's behaviour and the world state when they
matter) and its `source`; the host verifies a cited document, import row or
feedback mark and refuses a forged one. Before publishing, the judge can read
the cases as a critic — solvable from their source, unambiguous criteria, no
contradictions, never how the agent scored — and an invalid case is repaired or
excluded with a stated reason. Undocumented business rules remain questions.

New Builder-authored drafts record a host-captured fingerprint of the declared,
committed KB directories. Publication and `/test` compare it again before and
after confirmation, including publication recovery. If KB content or scope has
changed, reread it and create a new reviewed draft; editing or renaming the old
draft preserves its original binding. Evaluator-only commits do not invalidate
an unchanged KB. Older/imported drafts without this binding stay readable and
show **source freshness unknown** when a KB is present. This guards draft
publication, not the semantics of references or already-published benchmarks.

Cases can contain a single `input`, a fixed `messages` history, or a reactive
`simulatedUser`. In reactive cases, `knownFacts` describes what the person knows;
`persona` describes behavior, and `world.state` remains hidden tool/backend state.
The first message is fixed; the user model generates later messages from actual
agent replies. `stopWhen` ends the conversation, but graders and `world.expect`
decide success independently. This is model-generated behavior, not a guarantee
of realistic users or an improvement over scripted testing. The
[Python starter](templates/python-agent/README.md) includes concrete examples.

Opening `ahde` again continues this project's latest conversation and reads fresh
project state before the next turn. `ahde builder-pi` explicitly starts a new
conversation; `ahde resume` opens the history picker. A restart preserves recorded
work without restoring old confirmations or silently restarting model spend.
Before each new turn the Builder also receives bounded, evidence-linked memory
of prior attempts: the proposed change, measurement and operator decision.
Rejected does not mean ineffective, and an inconclusive result does not mean
failure. History is orientation, not permission to reuse stale evidence.

Natural requests and command shortcuts share the same running task, progress,
stop and result. Ask for the passport, exported dataset, judge labeling or a
private exam import in the conversation; private inputs are collected by the
host. Cost and duration can still require confirmation when unknown or above
the configured threshold.

Opening a detected agent folder presents one editable setup review: the command,
the files AHDE may change, and the effect of accepting. After a development run,
the conversation shows the result, up to three problems, and a case table;
full traces remain available on request. Use `/traces next` / `/traces prev`
to page runs, and `/trace 73` to open an absolute row. Candidate comparison pages
use `/review next` / `/review prev`, without triggering an apply or release.
The live grid counts observed public phases; the planned execution budget is
separate because private exams and reused baselines emit no public trace events.
The Builder is instructed to prepare
one actionable change for review without waiting for “fix the first problem”.
This is a prepared diff, not an automatic apply or ship.

A production miss can enter the same loop without rebuilding the case by hand.
Put one JSON/JSONL conversation under `imports/` and tell the Builder to turn it
into a regression. The host binds it to the exact current Target, removes
credential-shaped values, stores only reported tool names rather than arguments
or results, and creates an immutable corpus revision. `/test` is the single
review that publishes that revision and runs it. The record deliberately does
not claim that arbitrary PII has been removed.

`/help` keeps nine common shortcuts visible; the full list is under `/help all`.

```text
/test                   test the agent: publish whatever is pending, run the
                        basket, or check the candidate you just applied
/fix 2                  fix the second problem: refresh the traces, prepare the
                        exact change, show the diff
/ship 0.1.0             ship the checked candidate, and start the next round
/status                 where you are and what to say next
/traces                 diagnosis, failure modes, the evidence link, the runs table
/trace 3                one run in full: why it failed, every verdict, the conversation
/passport               what the shipped version promised and measured
/dataset                every recorded conversation as one file beside the agent
/help all               every command, shortcuts included
```

<details>
<summary>Expert shortcuts, and the decisions AHDE asks for itself — <code>/help all</code></summary>

The same work, one step at a time, plus the inspections:

```text
/run [repetitions]      another name for the test verb above
/plan                   the whole cycle as a checklist: done, current, still ahead
/review                 the exact Spec, eval basket, diff, or candidate — with its actions
/jobs  /stop            the background measurement, and how to cancel it
/target [resource]      the exact committed Target or one declared resource
/log [rows]             how the agent grew: every version, what it scored, what it cost
/doctor                 model, evaluator, run, and future ship readiness
/label [n]              check the judge: grade n answers blind, then see what it said
/holdout [file]         privately import the operator-owned sealed JSONL exam, or have the judge write one
/calibrate [reps]       measure run-to-run noise: the same revision against itself
/regrade [erun]         re-score the recorded answers with the graders you just
                        revised: no agent call, only the judge
```

AHDE asks each of these on screen with the exact subject, so nobody has to
type them. They stay registered because a decision offered has to be
answerable from the keyboard too:

```text
/approve  /publish      approve the Spec · publish the eval basket, one at a time
/apply <branch>         apply the reviewed proposal to a candidate branch
/discard                discard a proposal or abandon an interrupted candidate
/promote <version>      promote the verified candidate without adopting it
/reject                 reject the verified candidate
/adopt                  fast-forward the current branch to the promoted candidate
/next                   close the cycle and continue from the active Target
```

</details>

Builder Pi has no ambient shell and no arbitrary file access: it works through
a narrow typed Workbench API and five temporary tools inside a bound workshop.
It classifies a requested change as instructions (`AGENTS.md`), reusable
knowledge (a skill), or an external action (a declarative tool). Tool creation
is conversational: AHDE privately binds credentials, separately reviews
network/filesystem/process capabilities, generates the descriptor, executable,
input/output schemas, fixtures and contract manifest, then runs both successful
and error-handling fixtures until the exact package is green. Every
consequential step is a host-owned question with the exact subject on screen.
Money is asked once per cycle: the apply question shows the check's estimate
and approves it; a check asks again only above 1.5× that amount or when nothing
was authorized, and ship asks for the exam. Give the Builder a Sonnet/Opus-class model — below that
floor the loop does not close; the Target can be as small as a 9B model. On
OpenRouter, Anthropic models are routed through chat completions by AHDE's own
`models.json` in the Builder home (Pi's catalog would send them to a URL
OpenRouter answers with a 404); the override is derived from the catalog at
each launch and takes effect from the second one.

For “improve it automatically”, Builder Pi searches independent hypotheses
through the existing `improve` action. It keeps the best measured change across
rounds, including when a later trial regresses, and focuses that candidate for
final review. Choose 2–4 candidates to try several hypotheses per round. All
variants are compared against the same original agent; winning diffs are not
silently accumulated. At least four reviewed cases
are required. Before any model call AHDE persists a deterministic split: the
Builder sees only the authoring arm, while cheap screens, matched comparisons
and the Pareto frontier use the unseen validation arm. The exact split seed,
task membership, derived immutable corpora and design hash are durable evidence.
One host confirmation names
the selected Builder model and authoring limits, and authorizes candidate-branch
applies and development tests. Each isolated author has at most 8 model turns,
2,048 output tokens per turn, 32 tool calls and 2 minutes; each proposal changes
at most four files. It has no shell, exam reader, release tools or capability
grants. Changed tools need passing contract fixtures; expanded permissions need
a separate human-reviewed Workshop. The checkout remains unchanged.

The confirmation combines the historical Target estimate with a conservative
Builder authoring ceiling and itemizes both. If either price is unavailable,
the total is shown as unknown instead of presenting the Target subtotal as the
whole operation. The result lists author requests, reported tokens and cost separately;
`runs/improvement-authors/` preserves per-attempt receipts, including failures
and cancellation (unknown cost is not zero). Automatic selection stops at the
target, after two rounds without progress, or before the next complete round
would exceed the approved execution budget. Reservations persist across a
crash, and concurrent calls cannot spend the same loop budget. Ranking uses
verified score improvement, its lower confidence bound, known cost, known
latency, then the earlier trial. No verified improvement means keep the original.
The selected diff is reviewed once at the end; explicit `selection: review`
retains the earlier manual choice mode.
The evaluator-only sealed exam still answers the separate release question, so
validation does not automatically prove the best production agent. Automatic
authoring uses the live Builder Pi model. Integration tests cover this path with scripted local models; this
automatic-author path has also completed a paid synthetic support pilot with
Claude Sonnet 4.6 writing two hypotheses and Qwen 3.5 9B running the agent.
The operator driver approved the Spec, selected the independently measured
candidate and released it through the ordinary Workbench decisions. Neither
the diff nor the Target answers were scripted. The initial live attempt also
exposed incomplete author resource discovery; the author now receives the
declared data inventory and built-in tool contracts, and can rediscover this
bounded inventory without guessing filesystem paths.

To repeat that acceptance from a checkout with `OPENROUTER_API_KEY` configured:

```bash
npm run acceptance:live -- --live
```

The explicit `--live` flag enables paid calls. It runs in a separate synthetic
repository under `.ahde/live-pilots/`, saves results and author receipts, keeps
the Builder under a $2 request ceiling, and stops after 15 minutes. Target
calls are priced separately. It also replays an observed failure after restart
and probes a changed knowledge base without modifying the released instructions.
This is a small acceptance scenario; its scores are not a claim about arbitrary
agents or production traffic. The [full acceptance record](docs/reviews/2026-09-05-live-improvement-acceptance.md)
keeps both successful releases, the initial failed attempt and the remaining
Target errors. `npm run acceptance:pilot` remains offline.

`npm run acceptance:python-live -- --live` measures the shipped Python reference
agent with its original prompt, asks a real Builder model to improve observed
failures, selects by blind validation, and checks the winner against 15 separate
held-out cases. Its local passthrough only caps output and spending; it never
scripts answers. A shared $2 reservation budget covers author and Target calls,
including failed or unreported requests. All attempts are kept under
`.ahde/live-pilots/python-*`; no winner is a valid recorded result, and no release
is performed. The driver stops after 30 minutes. A failed exam can resume with
`--resume <pilot-directory>`: it archives the failed attempt, preserves the shared
budget and original endpoint, and rechecks the already selected exact diff without
calling the author again. `node scripts/audit-python-pilot.mjs <pilot-directory>`
independently checks recorded numeric text and explicit citations after completion.
These synthetic cases do not substitute for customer acceptance.

## Evidence

The [management demonstration guide](docs/management-demo.md) separates the
scripted, reproducible product demo from the recorded live-model experiments.
`npm run acceptance:guided` checks conversation lifecycle, cancellation, exact
consent and the full-loop integration with local fixtures. The full `npm run check`
also verifies conversation and Workshop recovery.


Evaluator v4 requires a final answer and does not treat a command agent's
`tool_note` self-report as proof that a tool executed. Completion is a prerequisite,
not a free point in the average score. Old results remain readable but are not
comparable to v4; runs without host-observed completion must be rerun before
regrading. Eval verification and export hash-check new final-world and judge-verdict sidecars;
legacy unattested sidecars are omitted from dataset exports. Command protocol
**v2** reports incremental usage for each model request; **v1** preserves its
legacy token-snapshot contract. Existing descriptors default to v1, while the
Python starter uses v2. See [protocol versions and usage](docs/command-protocol.md)
before migrating an adapter or comparing historical command measurements.

In earlier development acceptance, five live first-user sessions on real models — a Sonnet-class Builder, a 9B
Target (`openrouter/qwen/qwen3.5-9b`), a GLM judge — took a bank ombudsman
from one sentence to a shipped `v0.1.0`: the Builder wrote the Spec and six
cases, ran them (3/18), read the traces, built a `check_dbo` tool package in a
workshop, applied it, had the judge write a sealed exam, verified the candidate
(`improved · score 49% → 85% (+38.9 pts, 95% CI +25 … +47.2) on 6 cases × 3 ·
pass rate 22% → 61% · exam: pass (+30.3 pts) on 20 cases × 3`), let the operator
grade the judge blind, re-scored both arms under a stricter rubric, and shipped.
About forty minutes and under four dollars per session; the Builder's own
prediction on the last one (+60pp) landed within 1.1pp of the measurement. The
fixes were rediscovered from raw traces, not remembered.

A sixth session took a Target that is not Pi at all: a plain folder with a
Python agent (internet-provider support, two tools, a three-file knowledge
base) and no manifest. The door adopted it with one question; the Builder
wrote fifteen cases, nine of them carrying the client's state that the tools
read and write; forty-five executions ran in eight minutes inside the
sandbox; the Builder measured the noise, rewrote `prompts/system.md` in a
workshop, and the verification read `стало лучше · балл 73% → 85% (+12.4 п.п.,
95% ДИ +4.8 … +20.2) на 14 кейсах × 5 · экзамен: пройден · ухудшения не
доказано, улучшения тоже`; `v0.1.0` shipped, the passport said «обещано +8.9
· получено +10 ✓», and `/dataset` wrote fifty conversations with the world
before and after and the judge's verdicts. Under two dollars for the cycle.

## The version card and passport it wrote

From durable artifacts, never from memory. It is the one page that leaves the
machine — the operator sends it to whoever paid for the agent — so it is
written in the operator's language, not the engine's, and no hash sits above
the fold: identifiers appear cut to twelve characters on the face and whole in
a footer. Immediately after shipping, Builder first shows a compact version
card: blind-validation and sealed conclusions, capability movement,
regressions, resources, the exact reviewed change, and the hashes of the
exported artifacts. A fact the evidence cannot prove is printed as `unknown`.
Both `/ship` and `/passport` also save `exports/version-v<version>.html`: a
portable release report with before/after scores, uncertainty, the separate
sealed conclusion, regressions, cost and latency, and an expandable exact diff.
It opens offline without scripts or external assets and prints to PDF from the
browser. Passport and dataset download links work while the report stays in
its original project layout; the report itself can be sent as one HTML file.
The fuller passport follows it. The reason somebody typed when shipping is
quoted, never translated. Trimmed.

```markdown
# Паспорт версии — ombudsman v0.1.0

- агент: ombudsman · версия: v0.1.0 · дата: 2026-09-02
- ревизия: bf871326a2 → 7ce2841615 · модель: openrouter/qwen/qwen3.5-9b

## Обещано — spec-d05e0d0fed44…

Критерии успеха
- при наличии номера договора вызван check_dbo […ещё 3]

## Измерено

- разработка: **стало лучше** — балл 49% → 85% (+38.9 п.п., 95% ДИ +25 … +47.2)
  на 6 кейсах × 3 · пасс-рейт 22% → 61% · 6 кейсов — маленькая корзина:
  интервал ориентировочный, не решающий
- закрытый экзамен: **пройден** на 20 кейсах × 3 повтора
- на один ответ, кандидат к базе: цена ×1.1 · задержка ×1.3
- судья не откалиброван — человеческих отметок у него нет: /label сверит его
  с твоими глазами

## Откуда взялось

- описание: spec-d05e0d0fed44… · правка: builder-b0b78260…
- политики гейта: development-ci-v4, sealed-guardrail-v4
- применил: local:kikov · причина: “Ставлю системный промпт из мастерской”
```

## Traces

Every run leaves a trace, and the Evidence Explorer turns them into pages:
`ahde evidence` (or the link Builder Pi prints after a run) serves, on loopback
and read-only, a dark workspace per evaluation: issue groups, a runs table
and the selected conversation side by side. There is one row per case × repetition,
failures first, filterable by outcome, failure mode and input text. URL filters,
selected run and browser history retain the investigation. Every matching run
belongs to its issue group, even when only a few representative citations fit
in the summary. The same conversation also has a separate page with
the conversation as a chat transcript, every grader's verdict, the judge's
answer to each assertion, and a plain-language **Why** the host assembles from
recorded fields (what the grader expected, what happened, which failure mode it
belongs to and what that mode's traces show, and whether a candidate flipped
it), and a per-task baseline-vs-candidate comparison. Builder Pi can show the
same failure modes and link directly in conversation. Sealed runs never appear
on any page.

When a run called `kb_search`, the run page and `/trace` also show a **RAG
X-ray** assembled from the verified trace: query, top-k chunk ids, ranks and
scores when the retriever supplied them, expected-chunk hit@k and MRR,
retrieved-vs-cited evidence, token overlap, latency, and the precise diagnosis
(`retrieval missed`, `retrieved but not cited`, or `retrieval supported the
answer`). It never prints chunk text. Semantic faithfulness remains explicitly
`not measured` until a dedicated grader exists.

## What the engine guarantees

1. **The Builder cannot read the sealed exam** — reserved at ingest before the Builder sees the data, or written by the judge model from the Spec; the engine prints counts, design size and verdict, not content.
2. **Nothing ships without evidence and a human** — promotion needs a development verdict that is not `regressed`, a sealed `pass` on ≥15 tasks × ≥2 reps, every regression guard kept (no development case the base passed in every repetition may fail in every repetition), an applied proposal with its receipt, and a person confirming the exact subject on screen.
3. **Every number traces to an immutable artifact** — verdicts come from hash-pinned snapshots under a named gate policy; promotion rehashes the chain.
4. **The agent runs only declared tools, sandboxed** — descriptors and executable bytes are Target identity and must rehash before reuse; missing confinement is not promotable.
5. **The builder edits only a branch** — a proposal touches `AGENTS.md`, the manifest's declared lists, `skills/**`, `tools/**`, `bin/**`, `data/**` and nothing else; main moves only by `promote` + `adopt`.
6. **A case is never dropped for failing** — after a run the basket is read, not pruned: a case the agent passes every time becomes a regression check, a case it fails every time is capability work until the critic finds a fault in the test itself, and only an invalid test is repaired or excluded, with its reason on record. Synthetic and real cases are compared only in the same cell; the simulator's realism is unverified until real dialogues exist.

[docs/INVARIANTS_V1.md](docs/INVARIANTS_V1.md) is the exhaustive 47-invariant
statement behind these six; [docs/ROADMAP.md](docs/ROADMAP.md) is what comes
next.

## Vocabulary

- **Target** — the agent under development: a directory with `manifest.yaml`,
  `AGENTS.md`, skills, tools, evals. At evaluation time, also the fresh Pi
  invocation that runs one case.
- **Harness** — the instructions, skills and declared tools shaping the Target
  without touching its weights. What AHDE improves.
- **Spec** — the reviewed contract: purpose, users, jobs, inputs, allowed
  actions, success criteria, constraints. Approval makes it typed and binding;
  criteria map 1:1 onto graders.
- **Corpus** — versioned cases plus graders, identified by content hash.
  **Development** cases may be shown to the builder; **sealed** may not.
- **Run** — one Target execution of one case, one repetition. **Eval Run** —
  runs under one experiment design: corpus, task ids, repetitions, execution
  and judge fingerprints, mode.
- **Diagnosis** — failure modes derived from an eval run, one per cause: the
  grader family, not the task's own wording. A *systemic* mode needs that
  family on two distinct tasks; what a mode says is counted from the traces it
  cites.
- **Proposal** — the immutable exact file-replacement set compiled from a
  workshop diff, bound to an approved Spec, a baseline snapshot and its
  evidence. Compiling one applies nothing.
- **Candidate** — a committed Harness snapshot from a human-applied Proposal,
  linked to the exact Spec, builder run, proposal and receipt.
- **Promotion** — the human decision tagging the evaluated candidate revision.
  **Adoption** — the human-confirmed fast-forward of the operator's branch onto
  it. Only adoption moves the active Target. `ship` does both.
- **Regression guard** — a development case the base passed in every
  repetition: the suite of what the agent already handles. A candidate that
  fails one in every repetition cannot ship, whatever the average says; the
  cases a capability basket saturates graduate into it on their own.
- **A/A calibration** — the same revision evaluated twice to measure noise.
  Never promotion evidence. **Screen** — the cheap check: previously failing
  cases, once, candidate arm only; refused as evidence.
- **Judge subject / agreement** — what a judge grader was shown and asked, and
  how often a human reached the same verdict on it (Cohen's κ corrects for
  chance). Labels grade the instrument, not the Target.
- **Comparison verdict** — paired per-task deltas of the mean grader score, a
  seeded bootstrap 95% interval, one verdict. `development-ci-v4`: improved iff
  the interval is wholly above zero, regressed iff wholly below, else
  inconclusive. `sealed-guardrail-v4`: underpowered below 15 tasks or 2
  repetitions, fail iff wholly below zero, else pass.
- **Re-score** — the recorded answers graded again under revised graders: no
  agent call, only the judge, never a new baseline; at candidate review both
  arms are re-scored together.
- **Coverage cell** — a Spec job × a difficulty (`direct`, `clarify`, `tool`,
  `policy-trap`, `out-of-scope`, `no-answer`), optionally the user's behaviour
  preset and the world state. The basket is read as this matrix; the next wave
  fills its empty cells and goes harder where every case saturated.
- **Critic** — the judge reading the cases, never the agent: solvable from the
  cited source, world and declared tools; unambiguous criteria; no
  contradictions; checks that match the source. Verdicts `valid`, `repair`
  (with a fix), `invalid` (with reasons), `unreviewed`. Judge spend only.
- **Basket reading** — after a run, each case's standing (`saturated`,
  `failing`, `unstable`), the critic's validity, its origin (real or
  synthetic) and its cell. Nothing is removed; a failing valid case is work on
  the agent.
- **Simulator noise** — the same revision against itself with a second user
  model (`evalSuite.simulatedUserAlternate`) on the other arm; the band is
  about the user model. Never promotion evidence.

## Commands

Eight commands, and nothing the conversation already does:

```text
ahde                         open this agent's Builder conversation (continues the last one)
ahde builder-pi              start a new conversation · ahde continue / ahde resume pick one
ahde target                  talk to the built agent; /good and /bad mark its replies
ahde init <dir> [--template python-support|pi-support|pi-basic]
ahde validate --target <dir> readiness without a model call
ahde run --target <dir>      the development basket once, no Builder needed
ahde evidence [--port N]     the read-only trace explorer
```

Tests, diagnosis, changes, checks, the exam, the release and its passport are
asked for in the conversation and confirmed on screen. Scripts drive the same
engine through the library (`scripts/demo.mjs` is the worked example).

## Templates

```bash
ahde init my-agent --template python-support
```

Built-in names resolve from any working directory, including after a global
tarball installation:

| Name | Starter |
|---|---|
| `python-support` (alias `python`) | Python support agent with tools, a knowledge base and world-state cases. |
| `pi-support` | Pi support agent with a declared account tool. |
| `pi-basic` | Minimal Pi harness; the compatible default when no template is selected. |

Use `--template ./my-template` or an absolute directory for your own template.
The recommended Python starter is an ordinary support agent: a stdlib JSONL process,
two sandboxed tools, a small knowledge base, world-state cases and an editable
`prompts/system.md`. The first `ahde` in that directory asks for the agent,
judge and simulated-user models. `pi-support` remains the smaller
Pi-native example. Both templates ignore `.ahde/`, `runs/` and `imports/`, so
`git add -A` cannot commit the sealed exam.

## Verify the package

```bash
npm run check            # types, test types, the vitest suite
npm run check:quick      # the same, minus the files that spawn Git, sandboxes and servers
npm run acceptance:pilot # release loop, RAG, tool/world, production regression, and report checks
npm run demo             # refund-support RAG: wrong answer → retrieval fix → sealed exam → release report
npm run verify:package   # pack, install into an empty consumer, drive it
```

`check:quick` is the inner loop; `check` is what has to be green before a
commit. `verify:package` needs a real `node_modules` directory: a worktree
whose `node_modules` is a symlink under-bundles the tarball. The heavy test
files are named, with the reason each is heavy, at the top of
`vitest.config.ts`.

CI defines macOS and Linux checks. The Linux lane requires a working bwrap
sandbox.

The free demo uses a scripted local model with the real runner and knowledge
search. It leaves a release report, a RAG X-ray page, a passport, and an exported
dataset at the paths printed on completion. Its canned answers prove wiring
and repeatability; they do not measure the quality of a live model.

## Deliberately out of scope

RL or weight changes · autonomous promotion or deployment · a hosted multi-user
service · Windows. Studio is a local companion to the same Builder, and the CLI
remains the integration boundary for other platforms.
