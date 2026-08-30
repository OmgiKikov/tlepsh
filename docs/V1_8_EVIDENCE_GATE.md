# AHDE V1.8 — Evidence that does not lie

Synthesized from three independent reviews of the draft plan (gstack
`plan-eng-review`, `improve-codebase-architecture`, `thermo-nuclear-code-quality-review`)
run on 2026-08-29 against master 761b811. See "Review provenance" at the end.

## Why

The product promise is "improve an agent harness through evidence, behind human
gates". The audit of 2026-08-29 found the evidence gate statistically broken:

- The promotion gate rejects a candidate on ANY per-task drop in mean pass rate
  or any negative aggregate delta (`candidate-experiment.ts:431-441`, repeated in
  `candidate-review.ts:527-530` and `candidate-impact.ts:1002-1004`).
- Same-SHA A/A pairs in `runs/` (target ombudsman, qwen/qwen3.5-9b) flip 4/5 tasks
  at 5×2 and 3/30 tasks at 30×2. All four real rejections in `docs/evolution.jsonl`
  sit at that noise level. Monte-Carlo with the repo's own `bootstrap95`: the
  current rule rejects 97–100% of true-null candidates at n=30, k=3.
- The bootstrap CI is computed (`compare.ts:65-89`) and consumed by nothing; A/A
  mode exists in the domain but is unreachable; the comparison engine and the
  gate rule are duplicated.
- One errored or legacy `eval_run.json` aborts every candidate verification
  (`findReusableBaseline` → strict `listEvalRunIndexes`), which is the state of
  this repository's `runs/` today.
- A candidate verification is sequential: 60 runs ≈ 10 min; a full verification
  20–40 min. Judge calls have no retry; one 429 turns a completed run into an
  infrastructure error and aborts the experiment.

## The rule — `exact-comparison-gate-v4`

Everything below describes v3, the shape the milestone shipped. v4 keeps every
line of it and changes exactly one input: the paired quantity. See
"v4: partial credit" after the rule block.


One pure module, `src/domain/comparison-gate.ts`, is the only place a
pass/fail decision is made. Inputs are the paired per-task rows already produced
by `compare.ts` (per task: baseline pass/total, candidate pass/total, statuses).

```
excluded  = tasks with an error status in either arm (counted; ids only for development)
d_i       = candidateRate_i − baselineRate_i over included tasks
point     = mean(d)
[lo, hi]  = bootstrap95(d, seed = "<baselineEvalRunId>:<candidateEvalRunId>")   (existing, moved here)
n         = included tasks, k = repetitions

development verdict:  improved   iff lo > 0
                      regressed  iff hi < 0
                      inconclusive otherwise (or n < 1)
sealed verdict:       underpowered iff n < 15 or k < 2
                      fail         iff hi < 0
                      pass         otherwise
flags (rendered, never gating):
                      regressedTasks = #(d_i < 0), improvedTasks = #(d_i > 0),
                      collapsedTasks = #(baselineRate_i = 1 ∧ candidateRate_i = 0 ∧ k ≥ 3)
promotable            iff sealed = pass ∧ development ≠ regressed
A/A (mode aa-calibration): same computation, recorded, never promotable (existing domain rule)
```

Why this shape: success and guardrail are separate metrics (standard A/B
practice). Under a Bernoulli null at n=30, k=3 the guardrail fires in ~4% of
trials; power at n=30, k=3: −20pp caught 82%, −30pp 100%, +20pp declared
improved 80%. The real A/A pair dd68f00 30×2 (93% → 98%) is `inconclusive`
and passes the sealed guardrail; 5c99d43 → dd68f00 on 30 tasks is `improved`.
No epsilon enters the rule; calibration sizes repetitions and shows noise.

Infrastructure errors keep invariant 9 semantics — they are never behavioral
failures — but they no longer abort an experiment one at a time: up to 10% of
an evaluation's runs (`INFRASTRUCTURE_ERROR_BUDGET`) may error; the affected
tasks are excluded from the statistics and reported in `design.excludedTasks`,
and the count is recorded on the evaluated candidate. Above the budget the
surface is `inconclusive`/`underpowered` and the experiment stops at
`validated`. The first live run showed why: one judge reply without a
`reason` field out of 90 runs used to stop a whole A/A calibration.

Durable form: `ComparisonGateEvidence` v3 = `{ schemaVersion: 3, algorithmId:
"exact-comparison-gate-v3", policyId, surface, comparisonHash, evidenceHash,
gateHash, summary (taskCount, rates, delta, confidence95, improved/regressed/
unchanged), design { tasks, repetitions, excludedTasks }, verdict, flags }`.
v1/v2 stay parseable and are never promotion-grade (existing pattern).
Promotion requires the current version on both surfaces with
`sealed.verdict = pass` and
`development.verdict ≠ regressed`; `candidate-review` recomputes it and compares
JSON (existing pattern) and has no separate rule. A sealed `fail` or
`underpowered` no longer throws: the record reaches `evaluated`, the verdict is
rendered, and promotion refuses. Workbench `verify-candidate` refuses to START
when the selected sealed corpus has fewer than 15 tasks (message with the count)
so no tokens are spent on an underpowered verification.

### v4: partial credit

Binary grading throws away statistical power. A similarity grader knows the
answer moved from 0.30 to 0.85; a judge-with-reference knows the answer went
from *contradicts* to *nearly right*. Collapsing all of that to pass/fail
before the statistics see it discards most of the signal and forces more
repetitions to recover a decision. Anthropic's guidance on error bars for
evals makes the same point: where a grader can produce a continuous score,
use it — the paired variance drops and the same interval is reached with far
fewer runs. It also removes a class of false regressions: an answer that slips
from 0.61 to 0.59 against a 0.60 threshold reads as a total failure to a pass
rate and as noise to a score.

`exact-comparison-gate-v4` changes exactly one input and nothing else:

```
score_run  = mean(grader.score) over the run's graders, clamped to [0,1];
             a run with no graders (or an error) keeps the binary handling:
             1 when its outcome is `pass`, else 0
score_i    = mean over the task's repetitions of score_run
d_i        = candidateScore_i − baselineScore_i        (was candidateRate − baselineRate)
[lo, hi]   = the same seeded paired bootstrap over d, same seed text, same resamples
verdicts   = unchanged (development improved/regressed/inconclusive, sealed
             pass/fail/underpowered, same minimums, same error budget)
flags      = regressedTasks #(d_i < 0), improvedTasks #(d_i > 0),
             collapsedTasks #(baselineScore_i = 1 ∧ candidateScore_i = 0 ∧ k ≥ 3)
resources  = per arm: total costUsd, mean latencyMs per run, mean tokens per run;
             costRatio / latencyRatio / tokenRatio = candidate ÷ baseline,
             null when the baseline denominator is 0. Rendered beside every
             verdict, recorded in the evidence, and never gating.
```

With binary graders `score == pass rate`, so every v3 verdict is reproduced:
the Bernoulli simulation cells, the dd68f00 A/A pair (inconclusive + sealed
pass) and the 5c99d43 → dd68f00 pair (improved) all keep their verdicts, and a
test judges the same rows twice — once with the score forced to the pass rate —
to prove the two agree. Pass rates stay computed and rendered next to the
scores (`baselinePassRate`, `candidatePassRate`, `delta`), so a human always
sees both numbers.

Durable form: `ComparisonGateEvidence` v4 = v3 plus `summary.baselineScore /
candidateScore / scoreDelta` and a strict `resources` block, with
`schemaVersion: 4`, `algorithmId: "exact-comparison-gate-v4"` and policies
`development-ci-v4` / `sealed-guardrail-v4`. v1/v2/v3 stay parseable and render
their verdicts; only v4 is promotion-grade. The `promoted` event refinement
requires v4 on both surfaces, `candidate-review` recomputes v4 and compares
JSON, and a candidate carrying v3 evidence is refused with "re-verify the
candidate to record exact-comparison-gate-v4 evidence".

## Status (2026-08-29, branch `evidence-gate`)

| Stage | Landed | Notes |
|---|---|---|
| S1 unblock reuse / lenient indexes | d5533f4 | legacy indexes listed as `legacy · not comparable`, never reused |
| S2 comparison gate v3 | d5533f4 | one module, v3 evidence, sealed fail recorded at evaluated, simulation + real fixtures |
| S3 calibration, 3 repetitions, holdout disjointness | caef193 | `ahde calibrate`, decision `calibrate`, header noise line |
| S4 worker pool, judge retries, evaluatorId, max-age | 7963574 | `--jobs` (default 4, 1 on loopback), `--baseline-max-age`, EvalRun schemaVersion 2 |
| S7 legacy deletion + closed-loop Pi test | a02ae42 | src −2,884 LOC; extension.ts 1749 → 235; 17-step closed-loop test on the three tools |
| Any data → benchmark (core) | cd4675e | parsers, mapping recipe, `expected`/`messages`/`metadata` case fields, host-held sealed slice |
| Infrastructure error budget | 66c22f4 | ≤10% errored runs excluded, not fatal |
| S6 product feel | a6ac915 | onboarding resumes after `/login`, model catalog for `configure-target`, model-facing results −76%, tool schemas from zod (−34%), inventory read behind the seam, persona without panel narration |
| Failure modes on noisy agents | 21b2f09 | a mode is proposable when it reproduces in ≥25% of runs; passes no longer veto (the live run had 29 modes and 0 proposable under the old rule) |
| S5 first real promotion | live, 2026-08-30 | see "Closed loop on a real Target" |
| Any data → benchmark (Builder + CLI) | 988d400 | `aspect: dataset`, `dataset-recipe`, `import-dataset`, `ahde corpus inspect\|ingest`; sealed slice drawn by the host before the preview |
| Reference graders + dialogue cases | 89310b6 | `exact`, `similarity` (token-F1 / levenshtein), `judge withReference` (A–E factuality design ported from vitest-evals); `messages` seeded via `SessionManager.appendMessage` |
| Feedback becomes rows | 8a0e87f | `/good` `/bad` in `ahde target` over IPC → `imports/feedback.jsonl`; `ahde feedback list\|clear` |
| Partial credit + resource flags | `exact-comparison-gate-v4` | the gate pairs mean grader scores; cost/latency/token ratios recorded and rendered, never gating |
| Tool workshop core | 5e36337 | multi-file tools with a declared `setup`, `data/**` scope, `tool.upsert` files + `data.upsert`, `tryTool` / `ahde tool try`; Builder-facing surface in `docs/V1_9_TOOL_WORKSHOP.md` |

## Stages

Order: unblock the loop on real evidence → honest gate → calibration and
defaults → speed and provenance → first real promotion → product feel → legacy
deletion (own commit series, developed in parallel, merged last).

### S1 — Unblock the loop
- `eval.ts`: `listEvalRunIndexesLenient` returns `{ records, invalid: [{ evalRunId, reason }] }`;
  `findReusableBaseline` scans indexes only, skips invalid records and
  `summary.error > 0`, verifies only its single match with `loadVerifiedEvalRun`;
  delete `isExactReusableBaseline` (`candidate-experiment.ts:222-233`) and make
  `ReusableBaselineQuery` fields required.
- `workbench/inventory.ts:640-650`, `builder/project-context.ts:169-180`,
  `cli.ts list`: use the lenient listing; legacy indexes become a warning
  ("N legacy eval runs ignored") and are listed as `legacy · not comparable`,
  never a blocker. No migration command; legacy provenance is never defaulted.
- Tests: lenient listing reports each invalid index with its reason; reuse skips
  errored and legacy indexes and verifies only its match; legacy indexes warn
  but never block the Workbench.

### S2 — Honest gate
- New `src/domain/comparison-gate.ts` (rule above; `bootstrap95`, `perTask`, `mean`
  move here). `compare.ts` keeps provenance/linkage checks and delegates the
  statistics; `compareEvalRuns(runsRoot, aId, bId, { mode })` survives for CLI and
  report. Delete `compareExactEvalSnapshots` and the duplicate `bootstrap95`
  (`application/exact-eval-snapshot.ts:115-245`); `candidate-impact` consumes
  `compare.ts` against already-verified snapshots.
- `domain/candidate.ts`: `ComparisonGateEvidenceV3Schema`; the `promoted` event
  refinement requires v3 with sealed `pass` and development `≠ regressed`.
- `candidate-experiment.ts`: delete `holdoutRegression`; `comparisonGateEvidence`
  carries the verdict; the record always reaches `evaluated` after a comparable
  pair. `candidate-review.ts:487-530`: recompute v3 and compare JSON; delete the
  ad-hoc re-check. `candidate-impact.ts:734-752, 1002-1004`: verdict from the
  persisted gate evidence; per-task drops become flags.
- Screens: `render/view.ts` candidate block, `render/impact.ts`,
  `render/confirmation.ts` (promote), `render/decision.ts` (verify-candidate),
  `renderCompareMarkdown` show `verdict · point (CI lo…hi) · n tasks × k` per
  surface plus flags. `workbench.ts:1175`: `gatePassed = sealed verdict === "pass"`,
  and the result carries both verdicts. Sealed rendering never includes task ids.
- Tests: `comparison-gate.test.ts` — Bernoulli-null simulation (p ∈ {.5,.8,.95},
  k ∈ {1,2,3}, n=30, 400 trials, B=2000 via option) proves sealed false-fail < 10%;
  −30pp fails ≥ 95%; +20pp at k=3 improved ≥ 70%; dd68f00 30×2 fixture → inconclusive
  + sealed pass; 5c99d43→dd68f00 fixture → improved; underpowered below 15 tasks
  or 2 reps; collapsed flag needs k ≥ 3. `candidate-experiment.test.ts`: a sealed
  fail reaches `evaluated`. `candidate-review.test.ts`: refuses fail/underpowered
  sealed and regressed development; accepts inconclusive development.
  `scripts/demo.mjs` and `scripts/verify-package.mjs` publish 15 scripted sealed
  tasks. The real fixtures are built once from `runs/` into `tests/fixtures/`.

### S3 — Calibration, defaults, holdout policy
- `ahde calibrate --target . [--repetitions k] [--holdout-corpus id]` =
  `runCandidateExperiment({ mode: "aa-calibration", baselineRef: HEAD,
  candidateRef: HEAD, origin: { kind: "manual", reason: "A/A calibration" } })`.
  The A/A `CandidateRecord` IS the calibration receipt; no new artifact type.
- Workbench decision `calibrate` (types + transport + `transition-policy` legal at
  `ready-to-evaluate` + `/calibrate` shortcut). `inventory.ts` partitions
  `candidates` from `calibrations` by `record.mode`; calibrations never enter
  `activeCandidates`, stage derivation, or the interrupted check.
- Projection `calibrationFor(...)` (pure): `{ targetSha, provenanceKey, taskCount,
  repetitions, aaPassRate, point, ci, flipRate, recommendedRepetitions, verdict }`
  with `recommendedRepetitions = smallest k ∈ 1..5 with 1.96·√(2p(1−p)/(k·n)) ≤ 0.10`.
  Rendered by `render/calibration.ts`, as the decision result, and as one header
  line: `Noise A/A inconclusive · flip 10% · 3 reps recommended` /
  `Noise not calibrated`.
- Defaults: repetitions 3 for `ahde candidate`, `/run`, `verify-candidate`,
  `run-current`; transport cap stays 10.
- Holdout: `assertHoldoutDisjoint(dev, sealed)` preflight in the experiment
  (normalized input = trim/lowercase/collapse whitespace; per-task grader
  `specHash`; errors report counts only). `ahde corpus import --visibility sealed`
  warns below 15 tasks. Exposure = count of candidate records referencing the
  sealed corpus id; Workbench warns above 5. Nothing persisted.
- Judge `temperature: 0` after the params spread (`eval.ts:144-146`); `temperature`
  reserved for the judge block.
- Persona: `builders/ahde/AGENTS.md` vocabulary gains calibrate/noise; skills
  stop asking the model to restate what the host panel renders.

### S4 — Speed and provenance
- `runSuite` worker pool (`--jobs`, default 4; 1 when `baseUrl` is loopback) over a
  pre-built design array; results land in `slots[ordinal-1]`; `runIds`,
  `runArtifacts`, counters built from slots after `Promise.allSettled`; snapshot
  disposal and abort rejection only after settle; `effectiveExecution` is a
  post-pass reduction. `run-progress.ts` shows `graded g/total · running r`.
- Judge: 3 attempts, 1s/4s backoff with jitter on 429/5xx/timeout/fetch failure,
  one sidecar per attempt (`judge/<index>.<attempt>.json`), `metrics.judge
  { calls, tokens, costUsd }` from the response usage when present. No cache
  (eval runs are immutable; nothing regrades).
- Provenance: `evaluatorId` constant (`"ahde-evaluator-v1"`, bumped by hand when
  runner/eval/trace/judge semantics change) replaces `ahdeCodeHash` in
  `ProvenanceAxesSchema`; the hash stays in `runtime` metadata. `runtimeInfo()`
  memoized per process. `EvalRunRecord.schemaVersion` → 2 with a display-only v1
  reader. Baseline reuse max-age 7 days on `finishedAt` (`--baseline-max-age`).
- Tests: concurrent suite persists ids in design order and verifies; abort waits
  for in-flight runs before disposal; judge retries a 429 then grades with every
  attempt on disk; exhausted retries stay an infrastructure error; `evaluatorId`
  is an axis and `ahdeCodeHash` is not; an old baseline is not reused;
  `runner.integration` event-order test rewritten for the pool.

### S5 — First real promotion (ombudsman)
Baseline `5c99d43` (30-task development set); sealed corpus of 15 new cases
imported with `ahde corpus import --visibility sealed`; `ahde calibrate` at 30×3;
the dd68f00 change re-authored through the Builder path (approved Spec →
published development corpus → baseline run → diagnosis → authored proposal with
`instructions.replace` + `skill.upsert` → apply → applied-Builder candidate) so the
candidate has promotable origin; verification 30×3 + 15×3; promote; adopt.
Results (verdicts, point, CI, design, calibration, ids, SHAs) recorded in this
document under "Closed loop on a real Target". A manual `ahde candidate
--base 5c99d43 --branch dd68f00` run is the fallback and is recorded as
experimental evidence only.

### S6 — Product feel
- Onboarding resumes on `model_select` while the stage is `target-setup`.
- `configure-target` errors and `aspect: summary` carry the host model catalog.
- Tool results: one `projectForModel` in `textResult` strips `selections`,
  `warnings` beyond three, and hash fields unless the view asks for them.
- Tool schemas generated from the zod sources (`z.toJSONSchema`) so the grader
  union is defined once; TypeBox duplicates and casts deleted; argument coercion
  and "did you mean" kept on zod errors.
- Inventory read injected as a dependency; the post-write inventory feeds the
  trailing view. `cli-help.ts` derived from `COMMANDS`; README/`/help` one list.

### S7 — Legacy deletion
Split `builders/adapters.ts` at the proposal contract (keep schemas,
`validateCandidateProposal`, `PiBuilderAdapter`; delete Codex/Claude CLI adapters
and spawn/sandbox plumbing); delete `builders/pi-executor.ts`,
`application/corpus-draft.ts`, `builder.ts`, the 24 compat tools in
`builder/extension.ts` and their CLI commands (`builder`, `corpus draft`),
`createBuilderWorkbench` pass-through; move `mock-model.ts` to
`tests/helpers/` and make `verify-package` assert its absence; retarget golden,
natural-language and cycle tests to the three production tools; add the
closed-loop test that drives `ahde_workbench_decide` through a real Pi loop with
a scripted model (Spec → corpus → run → proposal → apply → verify → promote →
adopt → next). Public re-exports in `src/index.ts` shrink accordingly (0.1.0).
`docs/evolution.jsonl`, `builders/default/`, empty `dist N` directories removed.

## Closed loop on a real Target (2026-08-30)

Target `ombudsman` (qwen/qwen3.5-9b via OpenRouter, judge z-ai/glm-5.3), a
clone at `5c99d43` (30 development cases), a 15-case sealed holdout imported by
the host, 3 repetitions, 4 jobs, run by `scripts/real-loop.mjs` (holdout: `docs/examples/ombudsman-holdout.jsonl`) through
the production application chain (approved Spec → baseline → A/A calibration →
diagnosis → Builder-origin proposal replaying the dd68f00 harness change →
apply → matched verification → review → promote → adopt → continue).

| Step | Result |
|---|---|
| Baseline 30×3 | 36/90 = 40.0%, 0 errors |
| A/A calibration (same SHA, twice) | 40.0% → 46.7%, CI −4.4 … +17.8 pp, 21/30 tasks flipped → `inconclusive`; second pair 40.0% → 42.2%, CI −8.9 … +13.3 pp → `inconclusive` |
| Diagnosis | 29 failure modes, 6 systemic; 7 proposable after the reproduction floor (0 under the old "any pass vetoes" rule) |
| Development verification 30×3 | 40.0% → 95.6%, **+55.6 pp, CI +45.6 … +65.6**, 28 improved / 0 regressed / 2 unchanged → `improved` |
| Sealed verification 15×3 | 38.1% → 90.5%, **+52.4 pp, CI +38.1 … +66.7**, 13 improved / 0 regressed / 1 unchanged, 1 task excluded within the error budget → `pass` |
| Promotion | `v0.2.0` → `59b50bb2a652`, adopted (branch fast-forwarded), cycle recorded |
| Cost | 765 Target runs across all attempts, $0.42 of Target tokens; 4 runs (0.5%) hit infrastructure errors |

Compare with the same harness change in August measured by the old gate: four
"regressions" on 5 tasks × 2 repetitions and no promotion, ever. The A/A pairs
above are the noise those rejections were made of.

The live run also found four defects that scripted tests could not:

1. A judge reply `{"passed": false}` without a `reason` was an infrastructure
   error and, being one run out of ninety, stopped the whole A/A experiment.
   Fix: the verdict parser accepts a missing reason.
2. Any infrastructure error aborted an experiment. Fix: the error budget —
   up to 10% of runs may error; their tasks are excluded from the statistics
   and counted on the record; above the budget the surface is inconclusive.
3. With repetitions, almost every real failure mode has some passes, and the
   old rule vetoed a proposal on any pass: 29 modes, 0 proposable. Fix: a mode
   is proposable when it reproduces in at least 25% of its runs.
4. One excluded sealed task made a 15-task holdout "underpowered" (14 < 15) and
   refused a +52 pp promotion. Fix: the minimum applies to the designed
   holdout; the error budget already bounds exclusions.

## Non-goals (deferred with reason)
Judge result cache (no regrade path); an `ungraded` grader state (five schemas
for a rare event); template `temperature: 0` (reasoning models reject it; params
are already an axis); rubric-based failure-mode clustering (invariant 29);
`ahde migrate-runs` (legacy indexes are non-comparable by construction);
inventory caching by mtimes (unmeasured); persisted exposure counters or
calibration receipt files (derived instead); RL, web control plane, Windows.

## Invariant amendments (CONTEXT.md)
- Promotion policy: "no per-task or aggregate sealed regression" becomes "sealed
  guardrail verdict `pass` (95% paired-bootstrap CI over per-task mean grader
  scores not entirely below zero on ≥15 tasks × ≥2 repetitions) and development
  verdict ≠ `regressed`, on `exact-comparison-gate-v4` evidence".
- New terms: Comparison Verdict, Gate Policy, Calibration (A/A record), Judge.
- Comparability axis `ahdeCodeHash` is replaced by the hand-bumped `evaluatorId`.

## Review provenance
- `plan-eng-review`: the ε non-inferiority rule fails its own acceptance test
  (63–94% false rejections at n=30); guardrail/success split; sealed gate records a
  verdict instead of throwing; the real promotion must start from 5c99d43 and use
  Builder origin; legacy indexes block reuse today; `evaluatorId` instead of
  demoting `ahdeCodeHash`; design-order persistence for concurrency; judge cache
  and `ungraded` dropped; k/k→0/k is a flag, not a gate.
- `improve-codebase-architecture`: Comparison Verdict as one deep module with
  pairing and judging separated; A/A calibration gets a home; judge behind a
  transport port (deferred to retries only in V1.8); legacy split at the
  proposal contract; inventory read behind the seam; one model-facing projection.
- `thermo-nuclear-code-quality-review`: consolidation before addition; no new
  receipt type or decision without a screen; one gate owner with a real
  `outcome`; zod as the single schema source; memoized `runtimeInfo()`; net
  deletion (~3.6k src LOC) as the acceptance bar for the milestone.
