# Excellent synthetic cases and a measured user simulator

Decided 2026-09-08 with Jonty. Eight points, one rule above them all:

> A case is never dropped for failing. A correct case the agent fails in every
> repetition is a capability case: it stays, its cause is analysed, the agent is
> fixed. A case that is impossible, ambiguous, built on invented conditions or
> carrying a wrong check is repaired or excluded, and the exclusion names its
> reason. A case the agent passes every time stays as a regression check and the
> next wave is generated harder. A zero pass rate is a reason to review the
> case's quality, never a reason to remove it. Selection must not improve the
> metrics by deleting hard tasks.

## The eight points, as code

1. **Provenance per case.** `TaskSchema.source` — `kb` (declared `data/kb` document, path + sha256 of the blob at the bound revision), `spec`, `import` (file + sha256 + row), `feedback` (a mark from `ahde target`), `production` (host-derived, failure intake), `generated` (host-derived, the sealed generator). The host verifies every model-facing reference (`kb`, `import`, `feedback`) before a draft is saved; a forged or stale reference refuses the draft. Origin follows from the source: real = import | feedback | production; synthetic = kb | spec | generated.
2. **Coverage matrix.** `TaskSchema.coverage` — `job` (one of the approved Spec's jobs), `difficulty` (`direct`, `clarify`, `tool`, `policy-trap`, `out-of-scope`, `no-answer`), optional `behavior` (the simulator preset) and `state` (a short world-state label). `coverageDensity(tasks, jobs)` in `src/domain/case-coverage.ts` reports counts per cell and the empty cells. The draft review panel shows the matrix; `next` names the empty cells; the sealed generator is asked per cell.
3. **Checks first.** The persona writes the checks and the reference before the request text. The sealed generator emits `checks` before `input`, and every generated case must carry a deterministic grader or a `world.expect`; a judge grader is allowed only beside one. `output_excludes` is the must-not grader for traps.
4. **Traps.** Difficulties `policy-trap` (a plausible wrong rule; the check names the right value and excludes the wrong one), `out-of-scope` (the agent must decline or redirect) and `no-answer` (the source holds no answer; the agent must say so and never invent one — `output_excludes` on the invented value).
5. **Critic.** `src/application/case-critic.ts`: the judge model reviews cases for validity only — answerable from the cited source, the world state and the declared tools; success criteria that are unambiguous and conditions that do not contradict each other (world against known facts against the reference); checks consistent with the source; no near-duplicates; realistic register; simulator facts that do not leak backend state. An ambiguous *request* is not a defect: with `difficulty: clarify` it is the point of the case, and the critic checks only that the case says what a good clarification looks like. Verdicts `valid`, `repair` (with a concrete fix), `invalid` (with reasons), `unreviewed` (the call failed). The critic never sees agent performance. Decision `critique-corpus` runs it on the current draft (or the published development corpus) and records a receipt keyed by the subject hash; `publish-corpus` and `start-testing` refuse a draft with `invalid` findings unless `force` is set; `generate-holdout` filters generated cases on validity before sealing and records the reasons in the receipt (counts, never content).
6. **Reading the basket after a run.** `src/application/basket-reading.ts`: per case `saturated` (passed every repetition), `failing` (failed every repetition), `unstable` (mixed); validity from the critic receipt; origin from the source; the wave (cases new since the previous published corpus of the lineage) and whether it produced a new failure. Nothing is removed. Failing valid cases are named as capability work; failing cases the critic doubts are named for review (the doubt is about the test's own criteria and conditions, never about the request being hard or ambiguous); saturated cases are named as regression checks; the next wave targets empty cells and unresolved failure modes.
7. **Simulator.** `SimulatedUserSpec.behavior` (`clear`, `vague`, `impatient`, `wrong-facts`, `changes-goal`, `multi-issue`, `terse`, `non-native`) expands into host-owned prompt rules; `disclosure` (`upfront` | `on-request`, default on request: known facts are said only when asked). `evalSuite.simulatedUserAlternate` is a second user model; `calibrate` with `simulator: "alternate"` runs the same revision against itself with the alternate user on the second arm and reports the band as simulator noise; that pair is never shipping evidence.
8. **Synthetic against real.** Realism and difficulty are two different questions. Synthetic cases may deliberately hold more hard scenarios, so a pass-rate gap between synthetic and real cases says nothing by itself, and nothing is regenerated to make percentages agree. The basket reading compares only comparable cells — the same job, difficulty and state — and reports the gap there as information. The simulator's realism is measured on behaviour, against real transcripts of the same intents: how facts are disclosed (only when asked, or all at once), whether the user answers the agent's clarifying questions, whether they object, whether they keep their goal, how many turns they take. Until real dialogues exist for an intent, every realism reading is labelled unverified.

## Ownership

Wave 0 (schemas, shared types, dictionary, critic core, grader) is landed first so
every later piece compiles against one contract:

- `src/manifest.ts`: `CaseCoverage`, `CaseSource`, `SimulatedUserBehavior`, `disclosure`, `simulatedUserAlternate`, `output_excludes`.
- `src/domain/case-coverage.ts`: enums, `caseOrigin`, `coverageDensity`.
- `src/application/case-critic.ts`: prompt, call, parse, receipt.
- `src/workbench/types.ts`: decision inputs (`critique-corpus`, `publish-corpus.force`, `calibrate.simulator`), projections (`WorkbenchCoverageProjection`, `WorkbenchCriticProjection`, `WorkbenchBasketReading`), result map entries.
- `src/i18n.ts`: every new key, EN and RU.

Then in parallel, each on its own files:

- **A — draft, sources, critic decision, publication gate, guidance, draft panel**: `builder-corpus-draft.ts` (coverage + source on tasks, `remove` needs a reason, job membership), `corpus-source.ts` (`verifyCaseSource`), `decisions/corpus.ts` (`decideCritiqueCorpus`, publish/start-testing refusal on invalid findings), `workbench.ts` (submit hook, start-testing step), `next-actions.ts`, `transition-policy.ts`, `render/view.ts`, tests.
- **B — the sealed generator**: `sealed-synth.ts` (coverage cells in the Spec prompt, checks-first shape, traps, deterministic-check requirement, critic pass with reasons in the receipt), tests.
- **C — the simulator**: `simulated-user.ts` (behavior and disclosure rules), `corpus-target.ts` (`targetWithSimulatedUser`), `candidate-experiment.ts` (`simulatorNoise`), `compare.ts` (`allowAxes` for the A/A pair), `calibration.ts` (label), `decisions/evaluation.ts` (calibrate input), tests.
- **D — the basket reading**: `basket-reading.ts`, `decisions/evaluation.ts` (run result), `render/decision.ts` (run panel), tests.

Persona, README, invariants and the traces view wiring close the work.
