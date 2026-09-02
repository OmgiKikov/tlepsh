# AHDE — build, benchmark, and improve Pi agent harnesses

`ahde` opens **Builder Pi**: you describe the agent in plain language; the
Builder structures the Spec, assembles the benchmark, reserves a sealed exam no
model ever reads, builds and tries the harness in a bound workshop, runs matched
baseline-vs-candidate experiments, decides the verdict under a named gate policy
and keeps consequential choices in explicit host-owned review. The same
engine is a Unix-style CLI for scripts, CI and platforms (`ahde serve`). It
changes instructions, skills and declared tools — never weights — and promotes
nothing on its own authority.

## Install

Node.js ≥ 22.19 and Git. The package carries its pinned Pi runtime.

```bash
npm install --global ahde
```

From a checkout: `npm ci --ignore-scripts && npm run build` → `dist/cli.js`.

## Use it

```bash
mkdir my-agent && cd my-agent
ahde            # Builder Pi: describe the agent; guided setup happens here
ahde target     # talk to the built agent; /good and /bad become test cases
```

Free text is the complete product interface: ask the Builder to test, fix,
apply, open the built agent, or ship, and it performs the matching operation.
The compact Pi commands below are optional expert shortcuts, not vocabulary a
user has to learn.

```text
/test [repetitions]     test the agent: approve and publish whatever is pending,
                        run the basket, or verify the applied candidate
/fix [n]                fix problem n: refresh the traces, prepare the exact
                        change, show the diff
/ship <version>         ship the verified candidate: promote, adopt, next cycle

/status                 where you are and what to say next
/plan                   the whole cycle as a checklist: done, current, still ahead
/jobs  /stop            the background measurement, and how to cancel it
/review                 the exact Spec, eval basket, diff, or candidate — with its actions
/traces [rows]          diagnosis, failure modes, the evidence link, and the runs table
/trace <n|next|prev>    one run: why it failed, every verdict, and the conversation
/target [resource]      the exact committed Target or one declared resource
/passport [version]     what a shipped version promised and measured, saved beside the agent
/log [rows]             how the agent grew: every version, what it scored, what it cost
/label [n]              check the judge: grade n answers blind, then see what it said
/doctor                 model, evaluator, run, and future ship readiness
/holdout [file]         privately import the operator-owned sealed JSONL exam, or have the judge write one
/help                   this reference

/run [repetitions]      alias of /test
/calibrate [reps]       measure run-to-run noise: the same revision against itself
/regrade [erun]         re-score the recorded answers with the graders you just
                        revised: no agent call, only the judge
/approve  /publish      approve the Spec · publish the eval basket, one at a time
/apply <branch>         apply the reviewed proposal to a candidate branch
/discard                discard a proposal or abandon an interrupted candidate
/promote <version>      promote the verified candidate without adopting it
/reject                 reject the verified candidate
/adopt                  fast-forward the current branch to the promoted candidate
/next                   close the cycle and continue from the active Target
```

Builder Pi has no ambient shell and no arbitrary file access: it works through
a narrow typed Workbench API and five temporary tools inside a bound workshop.
It classifies a requested change as instructions (`AGENTS.md`), reusable
knowledge (a skill), or an external action (a declarative tool). Tool creation
is conversational: AHDE privately binds credentials, separately reviews
network/filesystem/process capabilities, generates the descriptor, executable,
input/output schemas, fixtures and contract manifest, then runs both successful
and error-handling fixtures until the exact package is green. Every
consequential step is a host-owned question with the exact subject on screen.
Money is asked once per cycle: the apply question shows the verification
estimate and approves it; verify asks again only above 1.5× that amount or when
nothing was authorized. Give the Builder a Sonnet/Opus-class model — below that
floor the loop does not close; the Target can be as small as a 9B model.

## Evidence

Four live first-user sessions on real models — a Sonnet-class Builder, a 9B
Target (`openrouter/qwen/qwen3.5-9b`), a GLM judge — took a bank ombudsman
from one sentence to a shipped `v0.1.0`: the Builder wrote the Spec and six
cases, ran them (3/18), read the traces, built a `check_dbo` tool package in a
workshop, applied it, had the judge write a sealed exam, verified the candidate
(`improved · score 49% → 85% (+38.9 pts, 95% CI +25 … +47.2) on 6 cases × 3 ·
pass rate 22% → 61% · exam: pass (+30.3 pts) on 20 cases × 3`), let the
operator grade the judge blind, re-scored
both arms under a stricter rubric, and shipped. About forty minutes and under
four dollars per session; the Builder's own prediction on the last one (+60pp)
landed within 1.1pp of the measurement. The fixes were rediscovered from raw
traces, not remembered.

## The passport it wrote

From durable artifacts, never from memory. Trimmed.

```markdown
# Version passport — ombudsman v0.1.0

- agent: ombudsman · version: v0.1.0 · date: 2026-09-02
- revision: bf871326a2 → 7ce2841615 · model: openrouter/qwen/qwen3.5-9b

## Promised — spec-d05e0d0fed44…

Success criteria
- при наличии номера договора вызван check_dbo […3 more]

## Measured

- development: **improved** — score 49% → 85% (+38.9 pts, 95% CI +25 … +47.2)
  on 6 cases × 3 · pass rate 22% → 61% · 6 cases is a small basket: read the
  interval as indicative, not decisive
- sealed guardrail: **pass** on 20 tasks × 3 repetitions
- per answer, candidate over baseline: cost ×1.1 · latency ×1.3
- judge agreement 60% · κ 0.00 · n=5 — /label checks it against your own eyes

## Provenance

- spec: spec-d05e0d0fed44… · proposal: builder-b0b78260…
- gate policies: development-ci-v4, sealed-guardrail-v4
- reviewed by: local:kikov · shipped by: local:kikov
```

## Traces

Every run leaves a trace, and the Evidence Explorer turns them into pages:
`ahde evidence` (or the link Builder Pi prints after a run) serves, on loopback
and read-only, a runs table per evaluation — one row per case × repetition,
failures first, filterable by outcome and failure mode — a page per run with
the conversation as a chat transcript, every grader's verdict, the judge's
answer to each assertion, and a plain-language **Why** the host assembles from
recorded fields (what the grader expected, what happened, which failure mode it
belongs to and what that mode's traces show, and whether a candidate flipped
it), and a per-task baseline-vs-candidate comparison. Builder Pi can show the
same failure modes and link directly in conversation. Sealed runs never appear
on any page.

## What the engine guarantees

1. **No model can read the sealed exam** — reserved at ingest before anyone sees the data, or written by the judge model from the Spec; the engine prints counts, design size and verdict, not content.
2. **Nothing ships without evidence and a human** — promotion needs a development verdict that is not `regressed`, a sealed `pass` on ≥15 tasks × ≥2 reps, an applied proposal with its receipt, and a person confirming the exact subject on screen.
3. **Every number traces to an immutable artifact** — verdicts come from hash-pinned snapshots under a named gate policy; promotion rehashes the chain.
4. **The agent runs only declared tools, sandboxed** — descriptors and executable bytes are Target identity and must rehash before reuse; missing confinement is not promotable.
5. **The builder edits only a branch** — a proposal touches `AGENTS.md`, the manifest's declared lists, `skills/**`, `tools/**`, `bin/**`, `data/**` and nothing else; main moves only by `promote` + `adopt`.

[docs/INVARIANTS_V1.md](docs/INVARIANTS_V1.md) is the exhaustive 42-invariant
statement behind these five; [docs/ROADMAP.md](docs/ROADMAP.md) is what comes
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

## Commands

The CLI is the machine surface: CI, scripts, a platform behind `serve`. All
take `--target <dir>` (`corpus`: `--project <id>`).

```text
init <dir> [--template <d>]  scaffold a harness + commit
validate                     readiness; no model calls
corpus inspect|ingest|import|synth|list  the benchmark; sealed at ingest
run --repetitions 3          development evidence
diagnose · report <erun>     what happened, and why
regrade <erun>               re-score traces, no model calls
calibrate                    the A/A noise band
label <erun>                 grade the judge blind (--file for CI)
check --candidate <id>       the failed cases, before the bill
candidate --builder-run <id>  matched comparison + sealed gate
review · promote --to 0.X.0  the human gate
passport [--out <md>]        promised vs measured
log                          versions × score × cost
watch --every 1d             drift vs noise, once shipped
tool try --tool <n>          one declared tool, sandboxed
tool try --tool <n> --fixtures  its own contract, per fixture
serve [--port N]             the engine behind a loopback API
```

`ahde <command> --help` has the rest (`list`, `feedback`, `improve`, `search`,
`reject`). `serve` lets a platform drive the loop in its own UI: a
consequential decision opens a pending confirmation bound to the subject hash
the engine minted, and blocks until the platform answers that id with that
hash. A transport for the human gate, never an exemption.

## Templates

```bash
ahde init my-agent --template templates/support-agent
```

A Russian first-line support agent, `REPLACE-ME` where the model, spec, tool
and 30–50 cases go. Its `AGENTS.md` carries the two load-bearing sections —
call the tool first, name the request type on line one — and its `.gitignore`
lists `.ahde/`, `runs/`, `imports/`, so `git add -A` cannot commit the exam.

## Verify the package

```bash
npm run check            # types, test types, the vitest suite
npm run check:quick      # the same, minus the files that spawn Git, sandboxes and servers
npm run demo             # the full loop on a scripted local model, free
npm run verify:package   # pack, install into an empty consumer, drive it
```

`check:quick` is the inner loop; `check` is what has to be green before a
commit. `verify:package` needs a real `node_modules` directory: a worktree
whose `node_modules` is a symlink under-bundles the tarball. The heavy test
files are named, with the reason each is heavy, at the top of
`vitest.config.ts`.

## Deliberately out of scope

RL or weight changes · autonomous apply, promotion or deployment · a UI inside
AHDE (`serve` is the seam) · Windows.
