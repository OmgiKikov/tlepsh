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
   until `readiness: ready to run`. Commit before baselining: `ahde run` will
   happily produce evidence on a dirty tree, but a dirty revision cannot seed a
   proposal and the baseline has to be re-run.
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
   --development-corpus <id> --holdout-corpus <sealed-id> --repetitions 3`,
   which prints both the development verdict and the sealed guardrail verdict
   with its design size. Quote those two lines; do not open the record.
7. **Ship.** `ahde review --candidate <id> --recommend promote --reason …`
   (it records the review immediately — it prints no diff and enforces no hash,
   so show the operator the proposal diff yourself first), then
   `ahde promote --target . --candidate <id> --to 0.X.0 --reason …`. Promotion
   requires: development verdict not `regressed`, sealed guardrail `pass`, an
   applied proposal with its receipt. Promotion tags the revision but does not
   move the working branch; `ahde adopt --target . --candidate <id>`
   fast-forwards onto it once the operator says so. Ask first — it is the one
   command that moves their checkout.
8. **Hand over.** The client-facing artifact is the version passport: what
   was promised (spec.md) ↔ what was measured (dev score with CI + sealed
   verdict + design size), cost per answer, known limits. Build it from the two
   verdict lines `ahde candidate` printed, `ahde list`, and — until `ahde log`
   lands — `node scripts/skill-shim-log.mjs --target .`; never from memory.

## Known engine gaps (v1 of this skill)

Measured end to end on 2026-08-31 and re-measured on 2026-09-01 — see
`docs/SKILL_WALKTHROUGH.md` for both command logs. The loop above now closes on
the CLI alone; what is left is the hand-over surface and two rough edges.

- There is no `ahde log` and no `ahde watch`. They land with the
  `codex/integrate-polish` merge, together with the `--proposal-hash` gate on
  `ahde review`. Until then the growth line exists only as
  `renderExperimentHistory()`, so build step 8's passport with
  `node scripts/skill-shim-log.mjs --target .` (the one shim still needed) and
  say so in your report.
- `ahde review` records the recommendation on the first call: no diff, no
  `--proposal-hash`. You are the one who has to show the diff.
- `ahde diagnose` prints one failure mode per failed grader with the same
  title and hypothesis; only the ids differ. Read the task drill-down to tell
  them apart, and pass every id you are actually fixing to `propose --mode`
  (comma-separated).
- `ahde improve --until 90% --max-cycles N` automates run→diagnose→apply→
  screen→verify inside the gates, but it only accepts a proposal bound to the
  EvalRun it just made — which means only Builder Pi can feed it. Drive the
  loop yourself with the commands above instead.

## Command crib

```
ahde validate --target .                      readiness; no model calls
ahde spec approve --target .                  spec.md → the typed Spec + its receipt
ahde run --target . --repetitions 3           development evidence (exit 1=fails, 2=inconclusive)
ahde list · diagnose <erun> · report <erun>   what happened and why
ahde corpus inspect|ingest|import|list        benchmark creation (sealed at ingest)
  (`corpus publish` needs a Builder-Pi `corpus-draft-…`; scripted, use
   `corpus import --visibility development|sealed --file <jsonl>`)
ahde calibrate --target .                     A/A noise band for this revision
ahde propose --target . --spec <id> --branch <ref> [--eval <erun> --mode <id>]
                                              a branch → the typed proposal (applies nothing)
ahde apply --target . --builder-run <id>      candidate commit + receipt; checkout unmoved
ahde check --target . --builder-run <id>      failed cases, once — the screen, before the bill
ahde candidate --target . …                   matched baseline-vs-candidate + sealed gate
ahde review · promote --to 0.X.0             the human gate (review shows no diff yet)
ahde adopt --target . --candidate <id>        fast-forward onto the promoted revision
ahde label <erun> --target . --sample 30      calibrate the judge against a human
ahde judge-agreement <erun> --target .        how far that judge is trusted
ahde feedback list --target .                 👍/👎 marks collected in ahde target
```
