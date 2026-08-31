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

---

# ADDENDUM — 2026-09-01: the same loop, CLI only

The four seams above that needed `scripts/skill-propose.mjs` are now commands.
This section is the same order re-walked with nothing but `node dist/cli.js`,
on a fresh scratch Target (`skill-run2/returns-agent`), the same scripted mock
model, the same deterministic graders. Output is verbatim; exit codes are real.
Per-run progress lines from `AHDE run n/N` are trimmed.

New in this run: `ahde spec approve`, `ahde propose`, `ahde apply`,
`ahde adopt`, `ahde check --builder-run`, the sealed verdict on
`ahde candidate`, the failure-mode id on `ahde diagnose`, and exit 2 for
infrastructure failures.

## (a) Command log

### Setup — unchanged from the first walkthrough

`ahde init returns-agent`, `spec.md` written by hand, `manifest.yaml` pointed at
the scripted mock, six development cases with three deterministic graders
(`30 дней`, `/дат[а-яё]* доставки/`, `личном кабинете`), committed as
`f0ae64c`. `ahde validate --target .` → `readiness: ready to run` [exit 0].
Corpora imported exactly as before:

```
$ ahde corpus import --project returns-agent --visibility sealed --name "…" --file ../private/sealed-exam.jsonl
corpus-8eea490e0b55…  sealed  18 tasks  sha256:c04eb79607b0…
[exit 0]
$ ahde corpus import --project returns-agent --visibility development --name "…" --file evals/development.jsonl
corpus-e75f8bbf1b60…  development  6 tasks  sha256:0aab38b36eb8…
[exit 0]
```

### Step 1 — the typed Spec (was GAP 10, was shim)

```
$ ahde spec approve --target .
warning: section "Notes for the operator" names no Spec field and was not read
spec-bc824da34f2e153ce25c579e8bbcdc2d0fd289f0ea2f0d9a4e76891750340144  approved
title         Агент поддержки по возвратам
contract      3 success criterion(s) · 2 constraint(s) · 0 open question(s)
receipt       spec-approval-bd291edbd5dde269a792ecf1100882fa2bb818531a8e233a0580721803a7a928

next: ahde propose --target … --spec spec-bc824da3… --branch <branch>
[exit 0]

$ ahde spec approve --target .          # idempotent, as promised
spec-bc824da34f2e153ce25c579e8bbcdc2d0fd289f0ea2f0d9a4e76891750340144  already approved
[exit 0]
```

The prose headings map to the typed fields; `## Notes for the operator` is left
to the human and *said* to be left, rather than silently dropped.

### Steps 2–4 — baseline and diagnosis

```
$ ahde run --target . --project returns-agent --corpus corpus-e75f8bbf1b60… \
    --label baseline --repetitions 2 --jobs 1
eval run erun_mthq8fsl1qh0hq: 0/12 all-pass (12 fail, 0 error)
[exit 1]

$ ahde diagnose erun_mthq8fsl1qh0hq
diagnosis diagnosis-f632eb90db2e2bcdcada: actionable — 6 issue(s), 0 infrastructure error(s)
0/12 passed. Found 3 diagnosed failure mode(s); 3 repeat across tasks.
proposal gate: eligible for exact human review
  major    systemic   Output contract check failed across tasks — 6/6 task(s), high evidence, propose-harness-change
    failure-mode-504eb75b19bb74374efedbdc
    hypothesis: The same deterministic grader predicate was unsatisfied in the cited runs. …
  major    systemic   Output contract check failed across tasks — 6/6 task(s), high evidence, propose-harness-change
    failure-mode-5d167ca4d1f139ca73d66f80
  major    systemic   Output contract check failed across tasks — 6/6 task(s), high evidence, propose-harness-change
    failure-mode-ae01f203e27d3966bcf2e8d1
Task-level drill-down:
  major    dev-1 · output-contract: … Evidence: output does not contain "30 дней"; output does not match /дат[а-яё]* доставки/
[exit 0]
```

GAP 6 is only half-fixed: the three modes still render with the same title and
hypothesis, but each now prints its id — which is what `propose --mode` takes,
so the mode is at least *addressable* from the CLI. One mode per failed grader
(three graders, three modes).

### Step 5 — propose and apply (was the shim; GAP 8's other half)

The fix is authored the ordinary way — a branch, a commit, back to `master`:

```
$ git checkout -b work/returns-policy && …edit AGENTS.md… && git commit -am …
$ git checkout master                                 # 5c4c86d on the branch
```

```
$ ahde propose --target . --project returns-agent --spec spec-bc824da3… \
    --branch work/returns-policy --eval erun_mthq8fsl1qh0hq \
    --mode failure-mode-504eb75b…,failure-mode-5d167ca4…,failure-mode-ae01f203… \
    --summary "Русский ответ: 30 дней с даты доставки, заявка в личном кабинете → «Возвраты»." \
    --run-id builder-returns-1
builder run   builder-returns-1
base          f0ae64c0f96ac09433e27d28d90aaa6da5b232a7
branch        work/returns-policy (5c4c86d739dfe2d391e577d0f575dbd7813e562b)
changed       AGENTS.md
evidence      erun_mthq8fsl1qh0hq
proposal      …/runs/builders/builder-returns-1/proposal.json
applied       no — `ahde propose` never touches a branch or a checkout
[exit 0]
```

`propose` alone left nothing applied: `git branch --list candidate/*` was empty
and the checkout was still `master` at `f0ae64c`.

```
$ ahde apply --target . --builder-run builder-returns-1 --branch candidate/returns-policy
branch        candidate/returns-policy
candidate     b960b2b496e9ff13bd049ed483cdc81ba1640045
base          f0ae64c0f96ac09433e27d28d90aaa6da5b232a7
proposal hash sha256:dddda4e91f3ad94ba3f680d428286757945aef0efeb114177e654fac87da92aa
paths         AGENTS.md
receipt       …/runs/builders/builder-returns-1/apply_receipt.json
checkout      unchanged — the candidate was committed in a private worktree
[exit 0]

$ git branch --show-current && git rev-parse --short HEAD
master
f0ae64c
```

Out of scope is refused by name, with nothing applied:

```
$ ahde propose … --branch work/out-of-scope --run-id builder-out-of-scope
error: branch work/out-of-scope did not produce a proposal (failed): branch change is
       outside the allowed harness scope: evals/development.jsonl
       (allowed: AGENTS.md, manifest.yaml, skills/**, bin/**, tools/**, data/**)
       · builder run builder-out-of-scope
[exit 2]
```

### Step 6 — screen first, then verify (was GAP 2, was impossible)

```
$ ahde check --target . --builder-run builder-returns-1 --jobs 1
screen promising · 6 previously failing cases × 1 · 6 improved · 0 unchanged · 0 regressed
  dev-1  pass  improved
  … dev-2 … dev-6 …
screen eval run: erun_mthq9cwiz8zzko (a screen — never a baseline, never evidence)
next: ahde candidate --target … --builder-run builder-returns-1 to verify it for real
[exit 0]
```

Six runs, before any CandidateRecord existed. The verification then ran in the
prescribed order — and printed the sealed verdict (was **GAP 1**):

```
$ ahde candidate --target . --builder-run builder-returns-1 --project returns-agent \
    --development-corpus corpus-e75f8bbf1b60… --holdout-corpus corpus-8eea490e0b55… \
    --repetitions 2 --jobs 1
# Compare: baseline erun_mthq8fsl1qh0hq vs candidate erun_mthq9lmkvmg9wa
- target: returns-agent (f0ae64c0 → b960b2b4)
- all-pass rate: 0% (0/12) → 100% (12/12)
- development verdict: improved — +100.0pp (95% CI +100.0pp … +100.0pp) on 6 × 2 · latency ×0.9
candidate record: candidate-5423049a-9aa8-4d03-8f60-7c34fdaa6c45
development verdict: improved +100.0pp (95% CI +100.0pp … +100.0pp) on 6 tasks × 2 repetitions
sealed guardrail: pass on 18 tasks × 2 repetitions — no regression: 95% CI +100.0pp … +100.0pp
                  is not entirely below zero on 18 tasks × 2 repetitions
sealed holdout: erun_mthq9mnm9hhiyl → erun_mthq9osy156fh8
[exit 0]
```

The sealed line carries a verdict, a design size and the gate's own reason —
sentences the gate already writes without task identifiers. No task, no input,
no corpus id.

### Step 7 — ship, then adopt (adopt was shim-only)

```
$ ahde review --candidate candidate-5423049a-… --recommend promote \
    --reason "Development improved +100pp; sealed guardrail passed on 18 × 2."
reviewed candidate candidate-5423049a-9aa8-4d03-8f60-7c34fdaa6c45: promote
[exit 0]

$ ahde promote --target . --candidate candidate-5423049a-… --to 0.1.0 \
    --reason "Ship the reviewed returns-policy candidate."
promoted candidate candidate-5423049a-…: tag v0.1.0 at b960b2b496e9ff13bd049ed483cdc81ba1640045
[exit 0]

$ ahde adopt --target . --candidate candidate-5423049a-…
adopted master: f0ae64c0f96ac09433e27d28d90aaa6da5b232a7 → b960b2b496e9ff13bd049ed483cdc81ba1640045 (v0.1.0)
changed       AGENTS.md
receipt       target-adoption-receipt-f0e137f8d16f881ae5133a8cf1b5de1c6422ed510e733e91247f2ed5ef5dbf12
              …/.ahde/target-adoptions/candidate-…/receipt.json
[exit 0]

$ git branch --show-current && git rev-parse --short HEAD
master
b960b2b
```

The operator's branch moved exactly once, at `adopt`, by fast-forward, onto the
exact evaluated commit the tag points at.

### Exit codes (was GAP 5)

```
$ ahde check --target . --candidate builder-returns-1
error: artifact "…/runs/candidates/builder-returns-1/candidate.json": read failed: ENOENT …
[exit 2]

$ ahde diagnose erun_mthq9osy156fh8            # the sealed holdout eval
error: improvement brief is unavailable for this evaluation
[exit 2]

$ ahde adopt --target . --candidate candidate-5423049a-…   # already adopted
error: Target HEAD must equal the Candidate baseline before adoption.
next: If the branch already points at the promoted revision this candidate is adopted
      and there is nothing to do; otherwise put the branch back on the candidate's
      baseline first.
[exit 2]
```

Exit 1 now means only a verdict a command measured — `run` with failures,
`check` flat, `tool try` non-zero, `improve`/`search` with nothing on the
frontier. Everything thrown is exit 2.

### Still missing

```
$ ahde log --target .
usage error: unknown command "log"
[exit 2]
```

## (b) VERDICT

**Yes — the loop closes on the CLI alone, from a client order to an adopted,
sealed-gated `v0.1.0`.** All eight steps of `skills/ahde/SKILL.md` complete with
`node dist/cli.js` and nothing else, in the prescribed order, including the two
that ran backwards or not at all before: the cheap screen now runs *before* the
verification it exists to save, and the sealed guardrail verdict is printed
rather than read out of a JSON file by hand. `scripts/skill-propose.mjs` is
superseded and marked as such.

Of the eleven gaps in the first walkthrough, six are closed here — 1 (partly:
the sealed verdict prints, `ahde log` does not), 2, 5, 8, 10, and the propose/
apply/adopt family the skill declared. What remains, and what each still needs:

| gap | still needs |
|---|---|
| `ahde log` / `ahde watch` | the `codex/integrate-polish` merge; `scripts/skill-shim-log.mjs` stays until then for the growth line — step 8's passport is no longer among what it is needed for, see **Passport** below |
| `ahde review` diff + `--proposal-hash` | the same merge; today the agent must render the diff itself |
| `ahde diagnose` renders N identical modes | grader identity on the mode line; the id is printed now, so a mode is at least addressable |
| `ahde corpus publish` is Builder-Pi-only | a `corpus draft` command; `corpus import` is the scripted equivalent and the crib says so |
| `ahde improve` cannot be fed non-interactively | letting `improve` accept a pre-authored proposal, or shell out to a proposer |
| `ahde init`'s half-Russian `next:` line | cosmetic |

One shim remains (`skill-shim-log.mjs`, 75 lines), for one step, and it is
already scheduled. Counting prescribed commands rather than steps: of the 19 the
first walkthrough exercised plus the 4 new ones, 21 of 23 now do exactly what
the skill says — `log` and `watch` are the two that still do not exist.

## Passport — step 8, without the shim

`ahde passport` landed after the walk above and closes the hand-over step. The
run below is over the same `skill-run2` artifacts, with nothing rebuilt, nothing
re-measured, and no model called:

```
ahde passport --target <dir> [--project <id>]
              [--candidate <id> | --tag v0.1.0 | latest] [--json] [--out <path>]
```

```
$ ahde passport --target .
# Version passport — returns-agent v0.1.0

- agent: returns-agent
- version: v0.1.0
- date: 2026-08-31
- revision: f0ae64c0f9 → b960b2b496
- model: openai-compatible/scripted-mock

## Promised — spec-bc824da34f2e…

*Агент поддержки по возвратам*

Success criteria
- ответ по-русски
- срок возврата — 30 дней с даты доставки
- заявка оформляется в личном кабинете, раздел «Возвраты»

Constraints
- без инструментов
- без сети

## Measured

- development: **improved** — pass rate 0% → 100% · mean score 0.00 → 1.00 (+100.0pp, 95% CI +100.0pp … +100.0pp) on 6 tasks × 2 repetitions
- sealed guardrail: **pass** on 18 tasks × 2 repetitions
- per answer, candidate over baseline: latency ×0.87 · tokens ×1.00

## Judge

judge not calibrated — no judge grader graded this evidence

## Known limits

- none recorded — every targeted failure mode the proposal named was resolved
- calibrated noise band: not measured (`ahde calibrate --target <dir>`)
- data: development “Возвраты — development” (corpus-e75f8bbf1b60…, 6 cases); sealed exam (18 cases)

## Provenance

- spec: spec-bc824da34f2e…
- proposal: sha256:dddda4e91f3a…
- gate policies: development-ci-v4, sealed-guardrail-v4
- eval runs: development erun_mthq8fsl1qh0hq → erun_mthq9lmkvmg9wa; sealed erun_mthq9mnm9hhiyl → erun_mthq9osy156fh8
- applied by: local-user — Applied at the terminal by the operator running `ahde apply`.
- candidate record: candidate-5423049a-9aa8-4d03-8f60-7c34fdaa6c45
[exit 0]
```

Every line is read back from an artifact this walkthrough already wrote. The
promise is the approved Spec of step 1, verbatim; the measurement is the same
gate evidence step 6 printed; the ratios, the policy ids, the eval runs and the
apply receipt's own sentence come out of the Candidate record; the corpus name
and its case count come from the metadata `corpus import` published. Nothing is
recomputed and nothing is remembered.

Two lines say they have nothing rather than guessing, which is the point: this
Target's graders are deterministic, so no judge was calibrated, and no `ahde
calibrate` was ever run here, so there is no measured noise band to put beside a
+100pp result. On a real Target both lines carry numbers — the judge line prints
`judge agreement N% · κ … · n=…` together with the majority-class baseline of
the human labels, because agreement over labels that are 90% pass is worth
exactly what a coin that always says pass is worth.

The sealed exam contributes its verdict and `18 tasks × 2 repetitions` and
nothing else. Its corpus id, its name and its cases never enter the projection
the page is rendered from, so they are absent from `--json` too — not merely
hidden by the renderer. The corpus store is read for the development corpus's
name and case count and for nothing sealed.

`--candidate <id>` issues a passport for a candidate that was verified but never
promoted; its `version:` line then reads `not promoted — verified only` in place
of a tag, and the date is the instant it was measured rather than shipped. A
missing subject or a missing artifact exits 2 with a `next:` line:

```
$ ahde passport --target . --tag v9.9.9
error: no promoted candidate of project returns-agent carries the tag v9.9.9
next: Run `ahde passport --target <dir>` for the newest promotion, or name a tag
      `ahde promote` printed.
[exit 2]
```
