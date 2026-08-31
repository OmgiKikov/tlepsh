# Walking `skills/ahde/SKILL.md` literally, with only the CLI

A coding agent took one fake client order and followed `skills/ahde/SKILL.md`
step by step, using `node dist/cli.js` wherever the skill says CLI, and writing
down every place the CLI could not do what the skill promised.

- **Order:** «агент поддержки интернет-магазина по возвратам: отвечает
  по-русски, называет срок возврата 30 дней с даты доставки, говорит оформить
  заявку в личном кабинете → «Возвраты»».
- **Model:** the scripted loopback from `dist/mock-model.js`
  (`scripts/skill-mock-model.mjs`), so the walkthrough spends no tokens. Baseline
  instructions route to a wrong English answer; the improved instructions carry a
  marker that routes to the correct Russian one.
- **Graders:** deterministic only — `output_contains` / `output_matches`. No
  judge, no simulated user.
- **Target:** a scratch `ahde init` harness outside the repo.

Result: the loop closes and ships `v0.1.0` with a `pass` sealed guardrail — but
it does not close on the CLI alone, and three of the skill's own instructions
are wrong about the tool they describe.

---

## (a) Command log

Output excerpts are verbatim, trimmed to the load-bearing lines. Exit codes are
the real ones.

### Step 1 — scaffold, spec, manifest, readiness

```
$ ahde init returns-agent
scaffolded target → …/skill-run/returns-agent (template: built-in basic-agent)
next: открой Builder Pi — он покажет exact one-time Target/model diff перед commit:
      cd …/skill-run/returns-agent && ahde
[exit 0]
```

Scaffolded `AGENTS.md manifest.yaml evals/ tools/ bin/ .gitignore` on branch
`master`. No `spec.md`, no `imports/`.

`spec.md` written by hand (users / jobs / inputs / allowed actions / 3 success
criteria mapped 1:1 to graders / constraints). `manifest.yaml` edited:
`id: returns-agent`, `model.id: scripted-mock`,
`baseUrl: http://127.0.0.1:60029/v1`, `apiKeyEnv: AHDE_SKILL_KEY`.

```
$ ahde validate --target .
target returns-agent: structurally valid
  model: openai-compatible/scripted-mock (thinking: off)
  key AHDE_SKILL_KEY: …ture (len 7) from shell
  tasks: 6 (30db02346e65…)
  readiness: ready to run (credential present; provider access unverified)
[exit 0]
```

### Step 2 — benchmark creation

Sealed exam: 18 cases generated write-only into a private JSONL outside the
Target and never read back.

```
$ ahde corpus import --project returns-agent --visibility sealed \
    --name "Возвраты — sealed exam" --file …/private/sealed-exam.jsonl
corpus-dc1cfaa070f8…  sealed  18 tasks  sha256:3af085679cb0…
[exit 0]
```

Then the development corpus, exactly as the skill's crib says
(`ahde corpus … publish`):

```
$ ahde corpus publish --project returns-agent --visibility development --name "Возвраты — development"
usage error: missing required flag --draft for corpus publish
<60 lines of GLOBAL help, not corpus help>
[exit 2]

$ ahde corpus publish … --draft evals/development.jsonl
error: [ { "code": "invalid_format", "pattern": "/^corpus-draft-[0-9a-f]{64}$/",
           "message": "draftId must be a canonical corpus draft identifier" } ]
[exit 1]
```

`--draft` resolves through `loadBuilderCorpusDraft()`; only Builder Pi writes a
`corpus-draft-<64hex>`. **Recorded as GAP 3.** Fell back to the scripted
equivalent, which works:

```
$ ahde corpus import --project returns-agent --visibility development \
    --name "Возвраты — development" --file evals/development.jsonl
corpus-993d487e3e64…  development  6 tasks  sha256:30db02346e65…
[exit 0]

$ ahde corpus list --project returns-agent
corpus-993d487e3e64…  development     6 tasks  Возвраты — development
corpus-dc1cfaa070f8…  sealed         18 tasks  Возвраты — sealed exam
[exit 0]
```

### Step 3 — baseline, diagnosis, report

```
$ ahde run --target . --project returns-agent --corpus corpus-993d487e3e64… \
    --label baseline --repetitions 2 --jobs 1
AHDE run 12/12 · fail (0 pass, 12 fail, 0 error)
eval run erun_mthp1cmub6opjz: 0/12 all-pass (12 fail, 0 error)
[exit 1]
```

That run was made on a **dirty** tree (`targetRevision:
a6cc8508…-dirty-128b08d28668`). The skill never says to commit before
baselining, and the propose/apply path needs a committed base
(**GAP 8**). Committed the setup and re-ran:

```
$ git commit -m "configure returns agent: spec, mock model, 6 development cases"
a512c21

$ ahde run … --label baseline --repetitions 2 --jobs 1
eval run erun_mthp2i2urfncxv: 0/12 all-pass (12 fail, 0 error)
[exit 1]

$ ahde diagnose erun_mthp2i2urfncxv
diagnosis diagnosis-c47ae220e24c75fedb1c: actionable — 6 issue(s), 0 infrastructure error(s)
0/12 passed. Found 5 diagnosed failure mode(s); 5 repeat across tasks.
proposal gate: eligible for exact human review
  major systemic Output contract check failed across tasks — 6/6 task(s), high evidence, propose-harness-change
  major systemic Output contract check failed across tasks — 6/6 task(s), high evidence, propose-harness-change
  … ×5, byte-identical, nothing says which grader each one is …
  major dev-1 · output-contract: … Evidence: output does not contain "30 дней"; output does not match /дат[а-яё]* доставки/
[exit 0]

$ ahde report erun_mthp2i2urfncxv
…/runs/erun_…/report.html
[exit 0]
```

The five "failure modes" render identically (**GAP 6**).

### Step 4 — the fix, on a branch

New `AGENTS.md` authored (Russian answer contract: 30 дней с даты доставки;
заявка в личном кабинете → «Возвраты»). Not committed to `master` — the
propose/apply shim puts it on `candidate/returns-policy`.

### Step 5 — the propose/apply gap (the shim)

```
$ node scripts/skill-propose.mjs --target …/returns-agent --project returns-agent \
    --eval erun_mthp2i2urfncxv --file AGENTS.md=…/new-AGENTS.md \
    --branch candidate/returns-policy --summary "…" --reason "…" --run-id builder-returns-1
spec         spec-171e39840a9bc1ba… (approved)
diagnosis    diagnosis-c47ae220e24c75fedb1c · brief brief-7cdc5b6b35407cd6aedd9245
proposal     …/runs/builders/builder-returns-1/proposal.json
builder-run  builder-returns-1
candidate    5c43e049edbffb2533c8b7500359924996e771f9 on candidate/returns-policy
checkout     master (unchanged)
```

Application services the shim needed — **this list is the spec for a future
`ahde propose` / `ahde apply`**:

| service | module | CLI today |
|---|---|---|
| `saveSpecSnapshot` (status `approved`) | `dist/spec.js` | **none** |
| `diagnoseEvalRun` | `dist/diagnosis.js` | `ahde diagnose` |
| `compileImprovementBrief` | `dist/application/improvement-brief.js` | **none** |
| `deriveEvidenceLinkedProposalSelection` | `dist/application/improvement-brief.js` | **none** |
| `wholeFileDiff` | `dist/application/harness-authoring.js` | **none** |
| `BuilderRunRecordSchema` | `dist/builders/adapters.js` | **none** |
| `runApprovedSpecBuilderProposal` | `dist/application/builder-proposal.js` | **none** |
| `applyBuilderProposal` | `dist/application/builder-proposal.js` | **none** |

Everything the engine actually guards — path allowlist, base-SHA binding,
evidence linkage, apply receipt, branch validation, keeping the checkout put —
already lives in those services. `ahde propose --branch` / `ahde apply` is a CLI
case over them, not new machinery.

### Step 6 — screen, then verify

The skill's order is `check` first, `candidate` second. `check` takes a
*candidate id*, and step 5 only ever hands you a *builder-run id*:

```
$ ahde check --target . --candidate builder-returns-1
error: artifact "…/runs/candidates/builder-returns-1/candidate.json": read failed:
       ENOENT: no such file or directory, lstat '…/runs/candidates/builder-returns-1/candidate.json'
[exit 1]
```

**GAP 2.** `runs/candidates/<id>/candidate.json` is written only by
`ahde candidate`. The cheap screen is unreachable before the expensive
verification. Ran the expensive one first:

```
$ ahde candidate --target . --builder-run builder-returns-1 --project returns-agent \
    --development-corpus corpus-993d487e3e64… --holdout-corpus corpus-dc1cfaa070f8… \
    --repetitions 2 --jobs 1
# Compare: baseline erun_mthp2i2urfncxv vs candidate erun_mthp4piahbvwqs
- target: returns-agent (a512c217 → 5c43e049)
- all-pass rate: 0% (0/12) → 100% (12/12)
- development verdict: improved — +100.0pp (95% CI +100.0pp … +100.0pp) on 6 × 2 · latency ×0.8
candidate record: candidate-43d81f69-5579-46a0-a1f0-161b0345e928
sealed holdout: erun_mthp4qh97thza6 → erun_mthp4sngn9sp9w
next: ahde review --candidate candidate-43d81f69-… --recommend promote|reject --reason <text>
[exit 0]
```

Note what is **not** there: the sealed guardrail verdict. Two eval-run ids, no
`pass`/`fail`. **GAP 1.** The verdict exists in the record
(`events[].evaluation.sealedHoldout.comparison.verdict = "pass"`, reason
`no regression: 95% CI +100.0pp … +100.0pp is not entirely below zero on 18
tasks × 2 repetitions`) but no CLI prints it, so the skill's own hard rule 2
("every number you state comes from a run artifact — `ahde report`, `ahde list`,
`diagnose`, `log`") cannot be satisfied for the number the ship gate turns on.

The screen ran afterwards, where it is no longer a screen:

```
$ ahde check --target . --candidate candidate-43d81f69-5579-46a0-a1f0-161b0345e928
screen promising · 6 previously failing cases × 1 · 6 improved · 0 unchanged · 0 regressed
screen eval run: erun_mthp52vjof7kyj (a screen — never a baseline, never evidence)
[exit 0]
```

### Step 7 — ship

The skill: *"it prints the exact diff and requires the printed `--proposal-hash`
on the second call"*.

```
$ ahde review --candidate candidate-43d81f69-… --recommend promote \
    --reason "Development improved +100pp; sealed holdout gate ran."
reviewed candidate candidate-43d81f69-5579-46a0-a1f0-161b0345e928: promote
[exit 0]

$ ahde review … --proposal-hash sha256:deadbeef
usage error: unknown flag --proposal-hash for review
[exit 2]
```

No diff. No hash. Accepted on the first call. `--proposal-hash` appears nowhere
in `src/cli.ts` or `src/cli-invocation.ts`. **GAP 4 — the skill describes a human
gate the CLI does not implement.**

```
$ ahde promote --target . --candidate candidate-43d81f69-… --to 0.1.0 \
    --reason "Ship the reviewed returns-policy candidate."
promoted candidate candidate-43d81f69-…: tag v0.1.0 at 5c43e049edbffb2533c8b7500359924996e771f9
[exit 0]
```

Hard rule 4 holds: checkout stayed on `master`, the tag points at the candidate
SHA, `candidate/returns-policy` is the only branch that moved.

Then the deliverable:

```
$ ahde log --target .
usage error: unknown command "log"
[exit 2]

$ ahde log --target . --json
usage error: unknown command "log"
[exit 2]

$ ahde watch --target . --every 1d
usage error: unknown command "watch"
[exit 2]
```

**GAP 1 / GAP 7.** Neither command exists in `CLI_COMMANDS`. The only surviving
history surface is:

```
$ ahde list
erun_mthp52vjof7kyj  solo      returns-agent  100% (6/6)
erun_mthp4sngn9sp9w  candidate returns-agent  100% (36/36)   ← sealed holdout, unlabelled
erun_mthp4qh97thza6  baseline  returns-agent    0% (0/36)    ← sealed holdout, unlabelled
erun_mthp4piahbvwqs  candidate returns-agent  100% (12/12)
erun_mthp2i2urfncxv  baseline  returns-agent    0% (0/12)
[exit 0]
```

Second shim, for the missing `ahde log`:

```
$ node scripts/skill-shim-log.mjs --target …/returns-agent
version  score       CI                 sealed  cost/run  candidate
v0.1.0   100.0%      100…100pp          pass    $0.0000   candidate-43d81f69-5579-

evaluated · — · inconclusive 0.0pp · “A/A calibration”
promoted · AGENTS.md · improved +100.0pp · sealed pass · for failure-mode-504eb75b…,
  failure-mode-5d167ca4…, … · “Ship the reviewed returns-policy candidate.”
```

The growth line the skill calls "the deliverable" is already rendered by
`renderExperimentHistory()` in `dist/application/experiment-history.js`. It is
one `case "log":` away from existing.

### Sealed-holdout probe (hard rule 1)

`ahde list` prints sealed eval-run ids without marking them sealed, so an agent
can address them by accident. The guardrail does hold underneath:

```
$ ahde diagnose erun_mthp4sngn9sp9w     → error: improvement brief is unavailable for this evaluation   [exit 1]
$ ahde report   erun_mthp4sngn9sp9w     → error: sealed holdout evidence is unavailable                 [exit 1]
$ ahde failures erun_mthp4sngn9sp9w --target . →
    error: development evidence belongs to returns-agent@5c43e049…, not returns-agent@a512c217…         [exit 1]
```

Content never leaked. But every refusal exits **1**, the same code
`ahde run`/`ahde check` use for a *behavioral* verdict. **GAP 5.**

### Other prescribed commands

```
$ ahde calibrate --target . --project returns-agent --corpus corpus-993d487e3e64… --repetitions 2
Noise calibration A/A inconclusive · revision a512c21746
Design 6 cases × 2 repetitions · same revision on both arms · baseline 0%
Spread ±0.0pp (95% CI 0 pts … 0 pts) · flip 0%
[exit 0]

$ ahde tool try --target . --tool echo_json --input '{"value":"возврат"}'
error: tool echo_json arguments.message: required property is missing
[exit 1]

$ ahde improve --target . --until 90% --max-cycles 1 --repetitions 1
AHDE improve cycle 1/1 · run 0/6 0% · mode failure-mode-504eb75b… · no unapplied Builder
  proposal is bound to this evidence. Author one in `ahde` (say “fix it”) before asking
  the loop to screen and verify it.
Stopped: the proposal author produced no change.
[exit 1]
```

---

## (b) GAPS, ranked

### 1. `ahde log` does not exist — and neither does any way to read the sealed verdict

The skill names `ahde log --target .` as *"the growth line is the deliverable"*
(step 7) and `ahde log --json` as the source of the client hand-over passport
(step 8), and lists it in hard rule 2 as an approved evidence surface.

```
$ ahde log --target .
usage error: unknown command "log"
[exit 2]
```

It is not in `CLI_COMMANDS` (`src/cli-invocation.ts:9-35`). Compounding it,
`ahde candidate` prints `sealed holdout: erun_… → erun_…` and never the sealed
gate verdict — so the one number the promotion gate turns on has no CLI surface
at all. The hand-over artifact the skill's step 8 defines cannot be built from
CLI output.

**Smallest fix:** add `case "log":` to `src/cli.ts` over the already-written
`compileExperimentHistory` / `renderExperimentHistory`
(`src/application/experiment-history.ts:239,261`), joined with the promotion tags,
plus `--json`; and add one line to the `candidate` renderer printing
`sealedHoldout.comparison.verdict` and its first reason. See
`scripts/skill-shim-log.mjs` — ~70 lines, no new domain logic.

### 2. `ahde check` cannot run where the skill puts it

The skill's step 6 is *"Screen, then verify"* — the cheap screen first, so a flat
result saves the expensive run. But `check --candidate <id>` reads
`runs/candidates/<id>/candidate.json`, written only by `ahde candidate`.

```
$ ahde check --target . --candidate builder-returns-1
error: artifact "…/runs/candidates/builder-returns-1/candidate.json": read failed:
       ENOENT: no such file or directory
[exit 1]
```

Its whole economic argument ("A verification costs (development + sealed cases) ×
repetitions × 2 arms; this costs one run per failed case") is void: you must pay
the verification to earn the right to screen.

**Smallest fix:** accept `--builder-run <id>` on `check` as well.
`cheapCheckPlanForCandidate` only needs `candidateSha`, `baseTargetSha`,
`sourceEvalRunId`, `developmentCorpus` — all four are already in the builder run
record plus its apply receipt.

### 3. `ahde corpus publish` is Builder-Pi-only

```
$ ahde corpus publish --project returns-agent --visibility development --name "…"
usage error: missing required flag --draft for corpus publish
[exit 2]
$ ahde corpus publish … --draft evals/development.jsonl
error: [ { "pattern": "/^corpus-draft-[0-9a-f]{64}$/",
           "message": "draftId must be a canonical corpus draft identifier" } ]
[exit 1]
```

The crib line `ahde corpus inspect|ingest|import|publish   benchmark creation`
reads as four scriptable siblings; `publish` is not one. There is no CLI that
creates a `corpus-draft-*`.

**Smallest fix:** say so in the crib and point at
`corpus import --visibility development`, which does exactly the scripted job.
(Done in this commit.) Longer term: `corpus draft --file <jsonl>` emitting a
draft id.

### 4. `ahde review` has no diff and no `--proposal-hash` — the skill invented the gate

The skill, step 7: *"(it prints the exact diff and requires the printed
`--proposal-hash` on the second call)"*. Reality:

```
$ ahde review --candidate … --recommend promote --reason "…"
reviewed candidate candidate-43d81f69-…: promote
[exit 0]
$ ahde review … --proposal-hash sha256:deadbeef
usage error: unknown flag --proposal-hash for review
[exit 2]
```

`src/cli.ts:1245-1259` is a straight pass-through to `reviewCandidate()`. Nothing
is shown, nothing is confirmed. This is the load-bearing human gate of the whole
design, and on the CLI it is a rubber stamp — an agent that follows hard rule 5
("Show the diff before asking to apply") has to render the diff itself.

**Smallest fix:** on a first `review` call with no `--proposal-hash`, print the
proposal's `changes[].unifiedDiff` and the computed hash, exit non-zero; require
the hash on the second call. The proposal JSON is already at
`runs/builders/<id>/proposal.json` and already hashed for the apply receipt.

### 5. Infrastructure errors exit 1, not 2 — hard rule 3 is unusable

Hard rule 3: *"infrastructure errors (exit 2) are inconclusive, fix the path and
rerun; they are never failures."* Every observed infrastructure error exits 1:

```
$ ahde check --target . --candidate builder-returns-1   → ENOENT                             [exit 1]
$ ahde diagnose erun_mthp4sngn9sp9w                     → improvement brief is unavailable   [exit 1]
$ ahde report   erun_mthp4sngn9sp9w                     → sealed holdout evidence unavailable[exit 1]
```

Exit 2 is reserved for *usage* errors. So `ahde check` returning 1 means either
"screen flat" (its documented behavioral verdict) or "your artifact is missing" —
a scripted agent cannot tell, and hard rule 3 tells it to trust a signal that
does not exist. `ahde run` does implement the documented 0/1/2 split; nothing
else does.

**Smallest fix:** route thrown non-`CliInvocationError` errors to exit 2 and keep
1 for behavioral verdicts only; or document per-command that 1 is overloaded.

### 6. `ahde diagnose` prints N identical failure modes

```
0/12 passed. Found 5 diagnosed failure mode(s); 5 repeat across tasks.
  major systemic Output contract check failed across tasks — 6/6 task(s), high evidence, propose-harness-change
  … ×5, byte-identical …
```

Five modes, one per failed grader, rendered with the same title, the same
hypothesis, and no grader identity — the agent is told to "read the failure modes
and fix the top one" and cannot distinguish them. The header also says "6
issue(s)" then "5 failure mode(s)" with no explanation of the two counts. The
task drill-down prints only the first two failed predicates per task, so two of
the five failing graders never appear anywhere in the output.

**Smallest fix:** append the grader name/spec to each mode line, and list all
failed predicates in the drill-down.

### 7. `ahde watch` does not exist

Crib: `ahde watch --target . --every 1d   drift vs noise on a schedule`.

```
$ ahde watch --target . --every 1d
usage error: unknown command "watch"
[exit 2]
```

**Smallest fix:** remove it from the crib until it lands. (Done in this commit.)

### 8. Nothing tells you to commit before the baseline

The skill's step 2→4 goes `ahde init` → edit → `validate` → `run`. `ahde run`
happily produces evidence on a dirty tree
(`targetRevision: a6cc8508…-dirty-128b08d28668`), but every downstream artifact —
proposal `baseTargetSha`, apply receipt, candidate comparison — is
commit-addressed. The baseline has to be thrown away and re-run.

**Smallest fix:** one sentence in step 2 ("commit the configured Target before
baselining — evidence on a dirty tree cannot seed a proposal"), or a
`readiness: ready to run (uncommitted changes — evidence will not be
proposal-eligible)` line in `ahde validate`.

### 9. `ahde improve` is unreachable from the CLI

```
AHDE improve cycle 1/1 · … no unapplied Builder proposal is bound to this evidence.
  Author one in `ahde` (say “fix it”) before asking the loop to screen and verify it.
Stopped: the proposal author produced no change.
[exit 1]
```

`src/application/improvement-loop.ts:927` requires
`record.request.source.evalRunId === request.evalRunId` — a proposal bound to the
EvalRun `improve` itself just created. Since `improve` makes a fresh EvalRun per
cycle, nothing can be pre-authored for it, and the only in-loop author is
interactive Builder Pi. The skill is honest that authoring needs proposals; it
does not say the loop is closed to every non-interactive caller.

**Smallest fix:** the same `ahde propose` from GAP 1's family, plus letting
`improve` shell out to a configured proposer.

### 10. `spec.md` is documented but nothing reads it

`spec.md` is in the skill's repo diagram, is step 1, and is the client-facing half
of step 8's passport. `grep -rn "spec.md" src/ docs/ README.md` → no matches. The
object the engine actually gates on is a typed Spec snapshot written by
`saveSpecSnapshot()`, which `ahde candidate --builder-run` refuses without
(`applied Builder candidates require an approved Spec`, `src/cli.ts:1032`), and
which no CLI command can create. An agent that follows step 1 faithfully still
has to shim the real one.

**Smallest fix:** `ahde spec approve --target . --from spec.md` that parses the
markdown headings into `SpecSnapshot` fields, or at minimum a note in the skill
that the typed Spec is separate and Builder-authored.

### 11. Cosmetic, but it is the first thing an agent sees

```
$ ahde init returns-agent
next: открой Builder Pi — он покажет exact one-time Target/model diff перед commit:
```

`src/cli.ts:621` — half-Russian output hardcoded in an otherwise English CLI. Also
`ahde init` scaffolds branch `master` while hard rule 4 says *"`main` moves only by
the engine's promotion"*, and `<command> --help` for `corpus` and any unknown
command dumps 60 lines of global help instead of the focused usage the root help
advertises (`Use \`ahde <command> --help\` for focused help`).

---

## (c) VERDICT

**No — not on the CLI alone, and one shim is not quite enough either.** A coding
agent can get from a client order to a promoted, sealed-gated `v0.1.0` in about
twenty CLI calls, and the parts that matter most are genuinely solid: `init`,
`validate`, `corpus import`, `run`, `diagnose`, `report`, `calibrate`,
`candidate`, `promote` all behaved exactly as documented; the sealed holdout
refused `diagnose`, `report`, and `failures` without leaking a byte; the
comparison gate produced a real paired interval; the checkout never moved off
`master`; and the promotion tag is bound to the exact evaluated SHA. But four of
the skill's eight loop steps could not complete through the CLI — **50 %** —
and needed direct `dist/` application-service calls: step 1's typed approved Spec,
step 5's propose/apply bridge (the gap the skill honestly declares), and steps 7
and 8's `ahde log` deliverable (a gap the skill does not declare — it presents
`ahde log` as an existing command, twice). A fifth step, step 6, ran only in the
reverse of the prescribed order. Counting individual prescribed commands rather
than steps: of the 19 this walkthrough exercised, 2 do not exist (`log`,
`watch`), 3 more could not produce their documented result (`corpus publish`,
`check` in the prescribed position, `improve`), and 2 behaved differently from
their description (`review`'s missing gate, `diagnose`'s undifferentiated
modes) — leaving **12 of 19 (63 %)** that did exactly what the skill says. The
two shims here come to 160 and 75 lines and
contain no domain logic whatsoever — every guard, hash, receipt, and renderer
they call is already written and already tested inside `dist/`. That is the real
finding: this is not a missing engine, it is a missing CLI surface over an engine
that is already there. `ahde propose --branch`, `ahde apply`, `ahde log`, a
`--builder-run` on `check`, and a diff+hash on `review` would close every gap
above except the cosmetic ones, and would make the skill true as written.
