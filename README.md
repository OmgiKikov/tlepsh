# AHDE — build, benchmark, and improve Pi agent harnesses

`ahde` opens **Builder Pi**: you describe the agent in plain language; the
Builder structures the Spec, assembles the benchmark, reserves a sealed exam no
model ever reads, builds and tries the harness in a bound workshop, runs matched
baseline-vs-candidate experiments, decides the verdict under a named gate policy
and asks you three questions — start testing, apply this change, ship. The same
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

The same loop has compact Pi commands: three verbs do the work, and every
older step is still there, one at a time.

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
/passport [version]     what a shipped version promised and measured, saved beside the agent
/log [rows]             how the agent grew: every version, what it scored, what it cost
/doctor                 model, evaluator, run, and future ship readiness
/holdout                privately import the operator-owned sealed JSONL exam
/help                   this reference

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

Builder Pi has no shell and no file access of its own: it works through three
typed tools and a bound workshop, and every consequential step is a host-owned
question with the exact subject on screen. Money is asked once per cycle: the
apply question shows the verification estimate and approves it; verify asks
again only above 1.5× that amount or when nothing was authorized. Give the
Builder a Sonnet/Opus-class model — below that floor the loop does not close;
the Target can be as small as a 9B model.

## Evidence

On a real model — `openrouter/qwen/qwen3.5-9b`, a 9B Target — the engine took a
deliberately weakened ombudsman harness from **25/60 passing (41.7%)** to
**98.3%**: `development verdict: improved +50.0pp (95% CI +35.0pp … +64.2pp) on
30 tasks × 2 repetitions`, `sealed guardrail: pass on 14 tasks × 2
repetitions`, A/A noise band ±9.6pp, promoted `v0.1.0`, $0.19 of Target spend.
The fix was rediscovered from raw traces, not remembered. The full command log
and every caveat are in `docs/DEMO_REAL_MODEL.md`; the same engine runs under
Builder Pi.

## The passport it wrote

From durable artifacts, never from memory. Trimmed.

```markdown
# Version passport — ombudsman v0.1.0

- agent: ombudsman · version: v0.1.0 · date: 2026-08-31
- revision: 4d533f0703 → 5a48ce5ff5 · model: openrouter/qwen/qwen3.5-9b

## Promised — spec-98eb4c441bb1…

Success criteria
- Если в обращении есть номер договора №N, агент вызывает bash с `check_dbo`
  до того, как ответить. […4 more]

## Measured

- development: **improved** — pass rate 41.7% → 98.3% · score 0.48 → 0.98
  (+50.0pp, 95% CI +35.0pp … +64.2pp) on 30 tasks × 2 repetitions
- sealed guardrail: **pass** on 14 tasks × 2 repetitions
- per answer, candidate over baseline: cost ×0.72 · latency ×0.42 · tokens ×0.72
- judge not calibrated — this judge has no human labels; run `ahde label <erun>`

## Provenance

- spec: spec-98eb4c441bb1… · proposal: sha256:80b37395d409…
- gate policies: development-ci-v4, sealed-guardrail-v4
- eval runs: erun_mtht4wvdm7jns0 → erun_mthtdbgxb4s6qm · applied by: local-user
```

## Traces

Every run leaves a trace, and the Evidence Explorer turns them into pages:
`ahde evidence` (or the link Builder Pi prints after a run) serves, on loopback
and read-only, a runs table per evaluation — one row per case × repetition,
failures first, filterable by outcome and failure mode — a page per run with
the conversation as a chat transcript, every grader's verdict, the judge's
answer to each assertion, and a plain-language **Why** the host assembles from
recorded fields (what the grader expected, what happened, which failure mode it
belongs to — labelled as a hypothesis — and whether a candidate flipped it), and
a per-task baseline-vs-candidate comparison. Inside Builder Pi, `/traces` shows
the same failure modes and link. Sealed runs never appear on any page.

## What the engine guarantees

1. **No model can read the sealed exam** — reserved at ingest before anyone sees the data; the CLI prints counts, design size and verdict, not content.
2. **Nothing ships without evidence and a human** — promotion needs a development verdict that is not `regressed`, a sealed `pass` on ≥15 tasks × ≥2 reps, an applied proposal with its receipt, and a person typing `promote`.
3. **Every number traces to an immutable artifact** — verdicts come from hash-pinned snapshots under a named gate policy; promotion rehashes the chain.
4. **The agent runs only declared tools, sandboxed** — descriptors and executable bytes are Target identity and must rehash before reuse; missing confinement is not promotable.
5. **The builder edits only a branch** — a proposal touches `AGENTS.md`, the manifest's declared lists, `skills/**`, `tools/**`, `bin/**`, `data/**` and nothing else; main moves only by `promote` + `adopt`.

[CONTEXT.md](CONTEXT.md) names the mechanism enforcing each;
[docs/INVARIANTS_V1.md](docs/INVARIANTS_V1.md) is the 42-invariant original.

## Commands

All take `--target <dir>` (`corpus`: `--project <id>`).

```text
init <dir> [--template <d>]  scaffold a harness + commit
validate                     readiness; no model calls
corpus inspect|ingest|import|list  the benchmark; sealed at ingest
run --repetitions 3          development evidence
list · report · diagnose <erun>  what happened, and why
regrade <erun>               re-score traces, no model calls
calibrate                    the A/A noise band
label <erun>                 grade the judge blind
judge-agreement <erun>       agreement rate and Cohen's κ
check --candidate <id>       the failed cases, before the bill
candidate --builder-run <id>  matched comparison + sealed gate
improve --until 90%          prepared proposals, in the gates
search --candidates <ids>    2–4 changes, one Pareto table
review · promote --to 0.X.0  the human gate
passport [--out <md>]        promised vs measured
log                          versions × score × cost
watch --every 1d             drift vs noise, once shipped
tool try --tool <n>          one declared tool, sandboxed
feedback list                👍/👎 marks from the Target
serve [--port N]             the engine behind a loopback API
```

`serve` lets a platform drive the loop in its own UI: a consequential decision
opens a pending confirmation bound to the subject hash the engine minted, and
blocks until the platform answers that id with that hash. A transport for the
human gate, never an exemption.

## Templates

```bash
ahde init my-agent --template templates/support-agent
```

A Russian first-line support agent, `REPLACE-ME` where the model, spec, tool
and 30–50 cases go. Its `AGENTS.md` carries the transcript's two load-bearing
sections — call the tool first, name the request type on line one — and its
`.gitignore` lists `.ahde/`, `runs/`, `imports/`, so `git add -A` cannot commit
the exam.

## Verify the package

```bash
npm run check            # types, test types, the vitest suite
npm run demo             # the full loop on a scripted local model, free
npm run verify:package   # pack, install into an empty consumer, drive it
```

## Deliberately out of scope

RL or weight changes · autonomous apply, promotion or deployment · a UI inside
AHDE (`serve` is the seam) · Windows.

## Interfaces

- `ahde` — Builder Pi, the conversation. Three consequential questions, panels
  the model never sees, one login in `~/.ahde`.
- The CLI — the same engine for automation, verified end to end above.
- `ahde serve` — the engine behind a loopback HTTP API with the same human gate,
  for a platform that renders the confirmations in its own UI.
