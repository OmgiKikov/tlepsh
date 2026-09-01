---
name: ahde
description: >
  Build, benchmark, and improve a Pi agent harness through the AHDE
  measurement engine. Use when asked to build an agent for a client order,
  create or grow its benchmark (eval cases, graders, sealed exam), run a
  baseline, fix a diagnosed problem, verify a change, or ship a version.
---

# AHDE engine, driven by a coding agent

You are the brains; the AHDE CLI is the instruments. You decide what to call
and when; the engine creates benchmarks, runs them, guards the sealed exam,
and gates promotion. You edit harness files directly in the repo — but you
never grade your own work and you never promote on your own authority: only
the engine's verdicts count, and only its gate ships.

## The shape of an agent repo

```
<target>/
  spec.md                 what was promised; criteria map 1:1 to graders (`ahde spec approve`)
  manifest.yaml           identity, model, execution policy, evalSuite (edit only via reviewed diff)
  AGENTS.md               the agent's instructions
  skills/  tools/  bin/  data/
  evals/development.jsonl evals/graders.yaml
  imports/                inbox: client exports, feedback.jsonl (git-ignored)
  runs/                   run artifacts (git-ignored)
```

## Hard rules

1. NEVER read, list, copy, or infer sealed holdout content — not the corpus
   file the operator imported, not `runs/**` sealed records. If a command
   prints sealed counts, that is all you may know.
2. Every number you state comes from a run artifact (`ahde report`, `ahde
   list`, `diagnose`, `ahde candidate`'s printed verdicts) — never from memory
   or estimation.
3. A behavioral claim needs a conclusive run: an infrastructure error is
   inconclusive, fix the path and rerun; it is never a failure. Exit 0 is a
   result, exit 1 is a verdict the command measured, exit 2 is inconclusive —
   a usage error, a missing artifact, a refused precondition, a provider that
   would not answer.
4. Harness edits happen on a branch (`candidate/<slug>`), never on the
   operator's checkout branch. `main` moves only by the engine's promotion.
5. Ask the operator before anything that costs real money beyond one basket
   run, and before any promotion. Show the diff before asking to apply.
6. Differences smaller than the calibrated noise band (`ahde calibrate`) are
   noise; do not claim improvement inside it.
7. Context discipline: redirect every run's output to a file
   (`... > run.log 2>&1`), then read only the verdict lines
   (`grep -E "^eval run|verdict|guardrail" run.log`); on failure, the last 50
   lines. Never pour a run log into your context. Raw per-case traces are the
   opposite: when diagnosing, open the actual `runs/<erun>/**` development
   trace files and read them whole — summaries lose the signal.
8. A number is not believed until someone reads transcripts. After every
   verification, read at least two: one case the change improved and one it
   did not, and say in one line what you saw.
9. Inside an authorized budget, never ask whether to continue. Stop only at
   the budget, a verified candidate, or two flat screens in a row — then hand
   back with the log.

## The loop (an order, end to end)

1. **Understand.** Write `spec.md` with these headings: Purpose, Users, Jobs,
   Inputs, Allowed actions, Success criteria, Constraints, Open questions.
   Short; criteria must be checkable, and one bullet per line. Then
   `ahde spec approve --target .` turns it into the typed Spec the ship gate
   needs and records the approval — running that command is the approval, so
   ask the operator first. It prints the spec id `ahde propose --spec` takes;
   re-running it on unchanged text prints the same id and changes nothing. Any
   heading it does not recognize stays yours and is reported as unread.
2. **Scaffold or adopt.** New: `ahde init .` then edit. Existing agent: keep
   its files, add `manifest.yaml` from the template. `ahde validate --target .`
   until `readiness: ready to run`. `ahde init` and `ahde spec approve` top up
   `.gitignore` with `.ahde/`, `runs/` and `imports/` and name what they added:
   the engine's store — including the sealed exam — lives under `.ahde/`, and a
   `git add -A` that swept it in puts the exam into a git object. If that
   already happened, `spec approve` and `propose` refuse by name until
   `git rm -r --cached .ahde runs`. Commit before baselining: `ahde run` will
   happily produce evidence on a dirty tree, but `propose` refuses a dirty
   baseline and the run has to be repeated clean. Use the Target id as
   `--project` everywhere the engine asks for one; a proposal belongs to that
   project and refuses corpora imported under another name. Every command that
   takes `--target` defaults `--project` to the manifest id, so passing
   `--target .` is enough — `corpus inspect|ingest|import|list` included.
3. **Create the benchmark.** Prefer the client's real data dropped in
   `imports/`:
   - `ahde corpus inspect --project <id> --file imports/<file>` — see columns;
   - `ahde corpus ingest --project <id> --file imports/<file> --recipe @recipe.json
      --name "<basket>" --sealed 20 --seed exam-1 [--stratify-by <col>]` —
     development cases + a sealed exam reserved BEFORE you see anything;
   - or hand-write `evals/development.jsonl` cases (30–50, from real
     failures), and let the operator import a private exam:
     `ahde corpus import --project <id> --visibility sealed --name "<exam>"
      --file <path>` (≥15 cases or the ship gate stays underpowered; `--name`
     is required). The same command with `--visibility development` is how a
     scripted run publishes the development corpus.
   Graders: deterministic first (`output_contains`, `output_matches`,
   `tool_called`); `judge` with `assertions:` checklists where prose must be
   judged (needs `configure-evaluators`; the judge may not be the target's
   own model). Feedback marks from `ahde target` land in
   `imports/feedback.jsonl` — turn them into cases the same way.
4. **Baseline.** `ahde run --target . --label baseline --repetitions 3`.
   Then `ahde diagnose <erun>` and read the failure modes; `ahde report
   <erun>` for the human view. `ahde calibrate --target .` once per revision
   when the operator will decide anything from small deltas.
5. **Fix one problem.** On a branch (`git checkout -b work/<slug>`), edit the
   harness files for the top diagnosed mode (instructions / a skill / a
   declarative tool + `bin/` executable + fixture in `data/`), try tools with
   `ahde tool try --target . --tool <name> --input '<json>'`, commit, and go
   back to the operator's branch. Then turn that branch into a proposal and
   apply it, in two steps:
   - `ahde propose --target . --spec <spec-id> --branch work/<slug>
      --eval <erun> --mode <failure-mode-id> --summary "…"` — compiles the diff
     against the committed baseline into the typed proposal, bound to the exact
     evidence. `ahde diagnose` prints the failure-mode id. Only the harness may
     differ (AGENTS.md, manifest.yaml's declared lists, `skills/**`, `bin/**`,
     `tools/**`, `data/**`); anything else is refused by name. Nothing is
     applied yet — this is the diff to show the operator.
   - `ahde apply --target . --builder-run <id>` — the candidate commit on
     `candidate/<builder-run-id>` plus its receipt. Your checkout never moves.
6. **Screen, then verify.** `ahde check --target . --builder-run <id>` re-runs
   only the previously failing cases, once — one run per failed case instead of
   (development + sealed) × repetitions × 2 arms. Flat means nothing improved;
   stop and author something else. Promising earns the verification:
   `ahde candidate --target . --builder-run <id> --project <id>
   --holdout-corpus <sealed-id> --repetitions 3` — a Builder-run candidate
   re-tests the manifest's own development dataset, so there is no
   `--development-corpus` here (passing one is refused by design). It prints
   both the development verdict and the sealed guardrail verdict with its
   design size. Quote those two lines; do not open the record.
7. **Ship.** `ahde review --candidate <id> --recommend promote --reason …`.
   For a candidate you applied with `ahde apply` the review records at once —
   your apply was the read, so show the operator the proposal diff yourself
   before this step. For a candidate `ahde improve`/`search` applied on its
   own, the first call prints the exact diff and refuses; repeat it with the
   printed `--proposal-hash`. Then
   `ahde promote --target . --candidate <id> --to 0.X.0 --reason …`. Promotion
   requires: development verdict not `regressed`, sealed guardrail `pass`, an
   applied proposal with its receipt. Promotion tags the revision but does not
   move the working branch; `ahde adopt --target . --candidate <id>`
   fast-forwards onto it once the operator says so. Ask first — it is the one
   command that moves their checkout.
8. **Hand over.** The client-facing artifact is the version passport: what
   was promised (spec.md) ↔ what was measured (dev score with CI + sealed
   verdict + design size), cost per answer, known limits. `ahde passport
   --target . --out passport-v0.X.0.md` writes it from the durable artifacts
   (never from memory); `ahde log --target .` is the growth line across
   versions, and `ahde watch --target . --every 1d` keeps the shipped agent
   honest afterwards — drift on an unchanged revision is a provider or data
   change, not a win.

## The improvement loop, disciplined

Between steps 4 and 7 you may cycle. Keep the cycle honest the same way every
time:

- **One attempts log per agent, `attempts.tsv`, git-untracked, tab-separated**
  — one row per attempt, crashes included, never deleted:

  ```
  branch	builder_run	screen	dev	sealed	cost_usd	status	description
  work/tool-call	builder-8e1c…	27/38	improved +64pp	pass 18x2	1.92	keep	order_lookup tool + call-first rule
  work/shorter-sys	builder-2f7a…	0/11	-	-	0.11	discard	flat screen; instructions cut alone did nothing
  work/retry-parse	builder-9c1d…	-	-	-	0.00	crash	propose refused: evals/ in diff
  ```

- **Keep or revert, nothing in between.** A losing or flat attempt is
  discarded the same day it is measured (`git branch -D work/<slug>`, row says
  `discard`); never patch forward on top of a loss. A winning attempt becomes
  the next baseline only through promote + adopt.
- **Ties lose.** `inconclusive` on the development gate is a discard, not a
  maybe. The gate's word is final; you do not argue with it, you author a
  different change.
- **Small edits, and a tax on complexity.** At most ~4 changed files per
  proposal. At an equal verdict the smaller diff wins; an attempt that only
  deletes and stays flat on the gate is a win — log it as `keep simplified`.
  Never trade +1pp for +200 lines of harness.
- **Read what already lost before proposing.** `attempts.tsv` first, then the
  raw development traces of the losing attempts (`runs/<erun>/**`, never
  sealed). Re-proposing the same files for the same failure mode after a loss
  is forbidden; say in one line what is different this time.
- **Budget is set once, up front** — N attempts or $X, agreed with the
  operator before the first cycle. Rule 9 applies until it runs out.

## Known engine gaps (v1 of this skill)

Measured end to end on 2026-08-31 (mock) and 2026-09-01 (mock, then a real
9B model — see `docs/SKILL_WALKTHROUGH.md` and `docs/DEMO_REAL_MODEL.md`). The
loop closes on the CLI alone. What is still rough:

- `ahde diagnose` prints one failure mode per failed grader with the same
  title and hypothesis; only the ids differ. Read the task drill-down to tell
  them apart, and pass every id you are actually fixing to `propose --mode`
  (comma-separated).
- `ahde improve` applies proposals that already exist; `ahde propose --eval
  <erun> --mode <id>` makes exactly that kind. Whether a headless loop picks
  them up is not yet proven in a walkthrough — drive the cycle yourself with
  the commands above until it is.
- Judge spend is not recorded under `runs/`; a run's `costUsd` is the Target
  model only. Say "plus judge" whenever you quote a cost.
- `ahde corpus publish` needs a Builder-Pi corpus draft; scripted, use
  `corpus import --visibility development|sealed`.

## Command crib

```
ahde validate --target .                      readiness; no model calls
ahde spec approve --target .                  spec.md → the typed Spec + its receipt
ahde run --target . --repetitions 3           development evidence (exit 1=fails, 2=inconclusive)
ahde list · diagnose <erun> · report <erun> --target .   what happened and why
ahde corpus inspect|ingest|import|list --target .   benchmark creation (sealed at ingest;
                                              --project defaults to the Target id)
  (`corpus publish` needs a Builder-Pi `corpus-draft-…`; scripted, use
   `corpus import --visibility development|sealed --file <jsonl>`)
ahde calibrate --target . [--jobs N]          A/A noise band for this revision
ahde propose --target . --spec <id> --branch <ref> [--eval <erun> --mode <id>]
                                              a branch → the typed proposal (applies nothing)
ahde apply --target . --builder-run <id>      candidate commit + receipt; checkout unmoved
ahde check --target . --builder-run <id>      failed cases, once — the screen, before the bill
ahde candidate --target . …                   matched baseline-vs-candidate + sealed gate
ahde review · promote --to 0.X.0             the human gate (diff + --proposal-hash for automated applies)
ahde adopt --target . --candidate <id>        fast-forward onto the promoted revision
ahde passport --target . [--out <md>]         promised ↔ measured, for the client
ahde log --target .                           versions × score × cost — the growth line
ahde watch --target . --every 1d              drift vs noise on the shipped revision
ahde label <erun> --target . --sample 30      calibrate the judge against a human
ahde judge-agreement <erun> --target .        how far that judge is trusted
ahde feedback list --target .                 👍/👎 marks collected in ahde target
```
