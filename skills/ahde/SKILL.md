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
  spec.md                 what was promised to the client; criteria map 1:1 to graders
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
   list`, `diagnose`, the candidate record) — never from memory or estimation.
3. A behavioral claim needs a conclusive run: an infrastructure error is
   inconclusive, fix the path and rerun; it is never a failure. Only `ahde run`
   implements the 0/1/2 split — everywhere else an infrastructure error also
   exits 1, so read the message, not the code.
4. Harness edits happen on a branch (`candidate/<slug>`), never on the
   operator's checkout branch. `main` moves only by the engine's promotion.
5. Ask the operator before anything that costs real money beyond one basket
   run, and before any promotion. Show the diff before asking to apply.
6. Differences smaller than the calibrated noise band (`ahde calibrate`) are
   noise; do not claim improvement inside it.

## The loop (an order, end to end)

1. **Understand.** Write `spec.md`: users, jobs, inputs, allowed actions,
   observable success criteria, constraints. Short; criteria must be checkable.
   It is your contract with the operator — no CLI reads it. The *typed* Spec the
   ship gate needs is a separate object Builder Pi writes.
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
5. **Fix one problem.** Branch, edit the harness files for the top diagnosed
   mode (instructions / a skill / a declarative tool + `bin/` executable +
   fixture in `data/`), try tools with
   `ahde tool try --target . --tool <name> --input '<json>'`.
6. **Verify, and screen when you can.** Full matched verification:
   `ahde candidate --target . --builder-run <id> --project <id>
   --development-corpus <id> --holdout-corpus <sealed-id> --repetitions 3`.
   `ahde check --target . --candidate <id>` re-runs only the previously failing
   cases once, but it takes a *candidate* id, which only `ahde candidate`
   creates — so today it cannot screen before the verification it was meant to
   save you. `ahde candidate` prints the development verdict but **not** the
   sealed one: read `events[].evaluation.sealedHoldout.comparison.verdict` from
   `runs/candidates/<id>/candidate.json` and say where you read it.
7. **Ship.** `ahde review --candidate <id> --recommend promote --reason …`
   (it records the review immediately — it prints no diff and enforces no hash,
   so show the operator the proposal diff yourself first), then
   `ahde promote --target . --candidate <id> --to 0.X.0 --reason …`. Promotion
   requires: development verdict not `regressed`, sealed guardrail `pass`, an
   applied proposal with its receipt.
8. **Hand over.** The client-facing artifact is the version passport: what
   was promised (spec.md) ↔ what was measured (dev score with CI + sealed
   verdict + design size), cost per answer, known limits. Build it from the
   candidate record and `ahde list`; never from memory.

## Known engine gaps (v0 of this skill)

Measured end to end on 2026-08-31 — see `docs/SKILL_WALKTHROUGH.md` for the
command log, the exact error text, and the smallest fix for each.

- The CLI cannot yet turn a branch diff into a typed Proposal or apply it:
  `propose` / `apply` / `adopt` exist only inside Builder Pi and the
  `scripts/real-loop.mjs` pattern. Until `ahde propose --branch` lands, use
  that pattern via a helper script (`scripts/skill-propose.mjs`) and say so in
  your report. The same script must write the approved Spec, because no CLI
  does and `ahde candidate --builder-run` refuses without one.
- There is no `ahde log` and no `ahde watch`. The growth line exists as
  `renderExperimentHistory()`; until it is wired up, build the passport from
  `runs/candidates/<id>/candidate.json` (`scripts/skill-shim-log.mjs`).
- `ahde review` records the recommendation on the first call: no diff, no
  `--proposal-hash`. You are the one who has to show the diff.
- `ahde check` needs a candidate id, so it cannot screen before the
  verification it exists to save.
- `ahde improve --until 90% --max-cycles N` automates run→diagnose→apply→
  screen→verify inside the gates, but it only accepts a proposal bound to the
  EvalRun it just made — which means only Builder Pi can feed it.

## Command crib

```
ahde validate --target .                      readiness; no model calls
ahde run --target . --repetitions 3           development evidence (exit 1=fails, 2=inconclusive)
ahde list · diagnose <erun> · report <erun>   what happened and why
ahde corpus inspect|ingest|import|list        benchmark creation (sealed at ingest)
  (`corpus publish` needs a Builder-Pi `corpus-draft-…`; scripted, use
   `corpus import --visibility development|sealed --file <jsonl>`)
ahde calibrate --target .                     A/A noise band for this revision
ahde check --target . --candidate <id>        failed cases, once — needs an existing candidate
ahde candidate --target . …                   matched baseline-vs-candidate + sealed gate
ahde review · promote --to 0.X.0             the human gate (review shows no diff yet)
ahde label <erun> --target . --sample 30      calibrate the judge against a human
ahde judge-agreement <erun> --target .        how far that judge is trusted
ahde feedback list --target .                 👍/👎 marks collected in ahde target
```
