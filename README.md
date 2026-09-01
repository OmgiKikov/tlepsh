# AHDE — a measurement engine for agent harnesses

A Unix-style CLI (`ahde`) plus a skill (`skills/ahde/SKILL.md`) that an ordinary
coding agent — Claude Code, Pi, Codex — follows to build, benchmark, improve and
ship a Pi agent harness. Brains in the skill, instruments in the engine: it builds
the benchmark, reserves a sealed exam no model ever reads, runs matched
baseline-vs-candidate experiments, decides the verdict under a named gate policy
and refuses to ship without a human. It changes instructions, skills and declared
tools — never weights — and promotes nothing on its own authority.

## Install

Node.js ≥ 22.19 and Git. The package carries its pinned Pi runtime.

```bash
npm install --global ahde
```

From a checkout: `npm ci --ignore-scripts && npm run build` → `dist/cli.js`.

## Use it from your coding agent

Copy `skills/ahde/SKILL.md` into the agent's skills dir (Claude Code:
`~/.claude/skills/ahde/`) or point it at the file, then give it the order:

1. `spec.md`, then `ahde spec approve` — the typed Spec the gate needs.
2. `ahde init .` or adopt an agent, until `validate` says `ready to run`.
3. `ahde corpus ingest … --sealed 20` — the exam is reserved **before** anyone sees it.
4. `ahde run --label baseline`, `ahde diagnose <erun>`, then read raw traces.
5. Fix one failure mode on a branch; `ahde propose` binds it to the evidence, `apply` commits it.
6. `ahde check` — the failing cases, once, before you pay.
7. `ahde candidate` — the matched experiment + the sealed guardrail.
8. `ahde review` · `promote --to 0.1.0` · `adopt` · `passport`.

## A real transcript

One coding agent, the skill, and `openrouter/qwen/qwen3.5-9b` — a 9B model — on a
Russian bank-ombudsman agent whose harness was weakened first, so the fix had to
be rediscovered. Every line copied from a run artifact; full log in
[DEMO_REAL_MODEL.md](docs/DEMO_REAL_MODEL.md).

```console
$ ahde run --target . --label baseline --repetitions 2 --jobs 4
eval run erun_mtht4wvdm7jns0: 25/60 all-pass (35 fail, 0 error)

$ ahde diagnose erun_mtht4wvdm7jns0
diagnosis-7048254cfcb9…: actionable — 40 issue(s), 0 infrastructure error(s)
  major  systemic  Required tool check failed across tasks — 12/30 task(s)
```

It never called `bin/check_dbo` (one task ran `ls -la`, saw `bin`, then answered
*«у меня нет доступа к банковской базе»*), and nothing named the output contract.
One file changed.

```console
$ ahde propose --target . --spec spec-98eb4c… --branch work/call-tool-first \
    --eval erun_mtht4wvdm7jns0 --mode failure-mode-0c69a077…,…
builder run builder-92dc0a22-…  changed AGENTS.md
applied     no — `propose` never touches a branch or a checkout

$ ahde apply --target . --builder-run builder-92dc0a22-…
branch      candidate/builder-92dc0a22-…  hash sha256:80b37395d409…
checkout    unchanged — committed in a private worktree

$ ahde check --target . --builder-run builder-92dc0a22-…
screen promising · 23 previously failing cases × 1 · 22 improved · 0 unchanged · 1 regressed

$ ahde candidate --target . --builder-run builder-92dc0a22-… --project ombudsman \
    --holdout-corpus corpus-4cdbd52f… --repetitions 2 --jobs 4
development verdict: improved +50.0pp (95% CI +35.0pp … +64.2pp) on 30 tasks × 2 repetitions
sealed guardrail: pass on 14 tasks × 2 repetitions — no regression: 95% CI +37.5pp … +73.2pp is not entirely below zero on 14 tasks × 2 repetitions

$ ahde calibrate --target . --repetitions 2
Spread ±9.6pp (95% CI -9.2 pts … +10 pts) · flip 33%

$ ahde promote --target . --candidate candidate-7a4bfa29-… --to 0.1.0 --reason "…"
promoted candidate candidate-7a4bfa29-…: tag v0.1.0 at 5a48ce5ff5

$ ahde passport --target . --out passport-v0.1.0.md
```

41.7% → 98.3%, against a ±9.6pp noise band: the lower bound of +35.0pp is three
and a half bands clear. Spend over 444 artifacts: **$0.19**, Target calls only — judge
spend is recorded nowhere, so unmeasured.

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
spec approve                 spec.md becomes the typed Spec
corpus inspect|ingest|import|list  the benchmark; sealed at ingest
run --repetitions 3          development evidence
list · report · diagnose <erun>  what happened, and why
regrade <erun>               re-score traces, no model calls
calibrate                    the A/A noise band
label <erun>                 grade the judge blind
judge-agreement <erun>       agreement rate and Cohen's κ
propose --spec --branch      branch to proposal; applies nothing
apply --builder-run <id>     candidate commit; checkout unmoved
check --builder-run <id>     the failed cases, before the bill
candidate --builder-run <id>  matched comparison + sealed gate
improve --until 90%          prepared proposals, in the gates
search --candidates <ids>    2–4 changes, one Pareto table
review · promote --to 0.X.0  the human gate
adopt --candidate <id>       fast-forward onto the promotion
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

## Deprecated in this release

Bare `ahde` opened **Builder Pi**: a conversational TUI with slash commands
(`/test`, `/fix`, `/ship`, `/review`, `/promote`, …), stage headers and panels,
where a Builder model drove the engine for you. Deprecated — the interface is the
coding agent you already use. The engine paths underneath remain (Workbench, gate
policy, three consequential decisions, receipts); `serve` is the successor.
