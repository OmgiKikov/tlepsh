# Architecture review — AHDE

Date: 2026-09-04  
Scope: recent hot spots, current uncommitted work, README product flow, `docs/INVARIANTS_V1.md`, `docs/ROADMAP.md`  
Method: deep-module review using **module**, **interface**, **implementation**, **depth**, **seam**, **adapter**, **leverage**, **locality**, and the deletion test.

There is no `CONTEXT.md` and no `docs/adr/` directory. Domain names below therefore follow the README vocabulary: Target, Harness, Spec, Corpus, Run, Eval Run, Diagnosis, Proposal, Candidate, Promotion, Adoption, and Evidence.

## What is already strong

- AHDE has unusually explicit product invariants. The 44 numbered rules constrain the implementation and make security and evidence decisions reviewable.
- `Workbench` already presents a small external interface to Builder, CLI, and `serve`: `view`, `submit`, and `decide`. That is the right product seam.
- `workbench/next-actions.ts` derives the Builder's legal moves from enforced transition policy instead of asking the prompt to remember a workflow. This gives the policy high leverage.
- The new `run-evidence.ts` is the right direction: it verifies world and judge artifacts against hashes pinned in `run.json`, and legacy unattested sidecars remain absent.
- The command Target is an actual adapter at a real seam: Pi and command backends both exercise the same Run and Eval Run machinery. This is depth, not speculative indirection.
- Recent work is driven by observed sessions. Comments that name a specific session and failure preserve valuable locality around why a rule exists.

## Candidate 1 — Deepen the Run evidence module

**Recommendation: Strong**  
**Dependency category: local-substitutable**

**Files**

- `src/run-evidence.ts:10-32`
- `src/eval.ts:2065-2081`
- `src/application/export-dataset.ts:853-875`
- `src/application/run-explanation.ts:94-190`
- `src/application/run-explanation.ts:333-360`
- `src/evidence/model.ts:340-390`
- `src/regrade.ts:282-294`

**Problem**

The Run evidence module now verifies pinned world and judge artifacts, and `loadVerifiedEvalRun` invokes it. But the Evidence Explorer projection still opens judge sidecars and the final world directly. Its comment says it derives from verified evidence while `readJudgeVerdict` validates shape and agreement only, and `runReceipt` counts keys in an unverified world file. Export and regrade use the stronger path. The same Eval Run can therefore fail closed in export while still showing altered sidecar facts in a human-facing receipt or verdict panel.

**Product consequence**

AHDE's main promise is that every number traces to immutable evidence. A screen that can disagree with export or regrade undermines the product more than a missing feature does; users cannot know which representation to trust.

**Deepening**

Make the Run evidence module the only place that opens a Run's trace, world, and judge artifacts and decides legacy behaviour, containment, size limits, schema validity, and hash validity. Projection modules receive verified values and only format them. The filesystem stays an internal seam with the real disk adapter and test fixture adapter.

**Deletion test**

Deleting `run-evidence.ts` would spread hash comparison, safe path resolution, legacy handling, and size limits back into export, regrade, evaluation loading, and the Evidence Explorer. The module concentrates real complexity and should become deeper. The direct readers in `run-explanation.ts` fail the deletion test: removing them removes duplicate policy rather than moving useful behaviour.

**Minimum useful change**

Route `readJudgeVerdict` and `runReceipt` through the verified Run artifacts already loaded by the canonical path. Remove their direct filesystem reads. Do not redesign every projection or move formatting yet.

**Test surface**

One behavioural matrix at the Run evidence interface:

- a changed world artifact is refused by load, export, regrade, and Explorer;
- a changed judge sidecar is refused by all four;
- legacy evidence exposes neither world nor judge sidecars;
- a valid current Run produces the same rendered verdict and receipt as today.

## Candidate 2 — Deepen workflow guidance into one policy projection

**Recommendation: Strong**  
**Dependency category: in-process**

**Files**

- `src/workbench/transition-policy.ts:120-251`
- `src/workbench/next-actions.ts:61-183`
- `src/builder/render/stage.ts:39-59`
- `src/builder/render/view.ts:293-316`
- `src/builder/workbench-adapter.ts:320-332`
- `builders/ahde/AGENTS.md:20-27`
- `builders/ahde/AGENTS.md:43-58`

**Problem**

AHDE computes two answers to “what happens next.” `workbenchNext` derives legal Builder decisions and submissions from transition policy, while `nextStep` separately maps stages and special blockers to localized operator text. The special cases for interrupted Candidates, missing models, missing Targets, Diagnosis health, and selection live across render modules. Recent commits repeatedly repaired first-screen and next-step wording, which is evidence that the seam still leaks.

**Product consequence**

The Builder can receive a legal move that does not match the operator's visible next step. That creates the exact product failure AHDE is designed to avoid: a user asks naturally, the Builder narrates machinery or takes a path the screen did not promise, and the session stalls.

**Deepening**

Create one workflow-guidance module behind the Workbench view seam. It owns the enforced legal moves, whether each move asks the human, the one operator-facing next sentence, and the exceptional blocker precedence. Builder projection and every renderer consume the same result. Localization remains an internal implementation detail.

**Deletion test**

Deleting both current guidance modules would force every renderer, command refusal, prompt projection, and status bar to reproduce stage knowledge. That complexity is real and deserves one deep module. Keeping two parallel stage interpretations merely moves each future exception into two places.

**Minimum useful change**

Add the operator-facing next sentence to the existing host-owned guidance projection and make `nextStep` a formatting consumer. Preserve all current words and transition tables; only remove the second decision path.

**Test surface**

Use one table-driven test across every Workbench stage plus the three exceptional states: selection required, interrupted Candidate, and missing model. Assert that the Builder's unblock move and the rendered next sentence describe the same action. Existing render tests then cover presentation only.

## Candidate 3 — Deepen the improvement experiment module

**Recommendation: Worth exploring**  
**Dependency category: local-substitutable**

**Files**

- `src/application/improvement-loop.ts:98-200`
- `src/application/improvement-loop.ts:302-599`
- `src/application/improvement-loop.ts:819-1250`
- `src/application/improvement-loop.ts:1412-1555`
- `src/application/improvement-author.ts:23-130`
- `src/workbench/decisions/improve.ts:10-141`
- `tests/autoloop.test.ts`

**Problem**

The automatic improvement loop is becoming a central product module, but its interface exposes ledger schemas, path rules, stop and skip taxonomies, gate construction, author selection, formatting, cost projection, resume/abandon operations, and orchestration as separate facts. The Workbench decision needs to assemble the author, disclosure, gate, estimate, loop options, rendering, and result projection itself. That is a shallow interface relative to the behaviour callers want: run or resume one bounded improvement experiment and get a reviewable best Candidate.

**Product consequence**

Every new loop feature can drift across CLI, Builder, and recovery: author spend can be present in receipts but absent from approval text, a resumed loop can estimate a different budget than it executes, or one host can expose a different stopping explanation. This is the roadmap's highest-value workflow, so these inconsistencies would be visible immediately.

**Deepening**

Make the improvement experiment own its durable ledger, author lifecycle, gate restriction, estimate, stopping rules, and result projection. The Workbench supplies operator intent and host dependencies at the seam, then receives one reviewable experiment result. Keep Proposal, Candidate, and Eval Run as the existing domain modules inside the implementation.

**Deletion test**

Deleting the loop orchestration would spread branch claims, resume safety, execution budgets, stopping rules, and Candidate selection into Workbench and CLI. The module earns its existence. Most of its exported constants and assembly types do not: deleting those would shrink caller knowledge without moving product complexity.

**Minimum useful change**

Move approval-subject preparation and final result projection beside the loop, then reduce `decisions/improve.ts` to Workbench stage resolution, human confirmation, and invocation. Leave the 1,100-line behavioural test suite intact and avoid changing branch or artifact formats.

**Test surface**

Exercise the improvement experiment through its external seam for start, resume, abandon, author failure, budget exhaustion, and winning Candidate. Retain focused tests only for immutable artifact compatibility and gate refusal. Internal line rendering and helper constants should not be independent test surfaces.

## Candidate 4 — Finish the Workbench decision extraction

**Recommendation: Worth exploring**  
**Dependency category: in-process**

**Files**

- `src/workbench/workbench.ts:300-307`
- `src/workbench/workbench.ts:833-3397`
- `src/workbench/workbench.ts:3260-3395`
- `src/workbench/decisions/shared.ts:1-17`
- `src/workbench/decisions/*.ts`

**Problem**

Decision families were moved out of the 3,405-line Workbench, but each handler's `DecisionHost` is still the entire `AhdeWorkbench` class, and several handlers import helpers back from `workbench.ts`. `workbench.ts` imports those handlers in return. The files are physically separate while the seam remains circular, so a decision can reach any Workbench method or dependency and TypeScript cannot state the smaller knowledge it actually needs.

**Product consequence**

Adding a new product gate or composite decision can accidentally couple setup, evaluation, release, or workshop behaviour. Reviewers must understand the whole Workbench before trusting a change to one operator action, slowing the exact iteration AHDE is meant to support.

**Deepening**

Keep `view`, `submit`, and `decide` as the external Workbench interface. Behind it, give decision families a host-owned decision runtime containing only shared gate, receipt, inventory-refresh, and dependency operations. Move formatting and identity helpers out of the Workbench class. The family modules stay internal implementation, not new public seams.

**Deletion test**

Deleting the family modules would move about 1,600 lines back into `workbench.ts`, so they already concentrate behaviour. Deleting their imports of the full class would remove accidental knowledge rather than relocate necessary complexity. That is the valuable simplification.

**Minimum useful change**

Replace `DecisionHost = AhdeWorkbench` with the narrow host-owned runtime required by existing handlers, and move the few imported helper functions into focused in-process modules. Do not split the Workbench further until this circular seam is gone.

**Test surface**

Run existing decision-family and transition-policy tests through `decide`. Type checking should prove handlers cannot reach undeclared Workbench internals. A new test is justified only for a behaviour previously exercised through a direct handler call.

## Top recommendation

Start with **Candidate 1: Deepen the Run evidence module**. It is small, aligned with the current uncommitted evidence-attestation work, and protects AHDE's core product claim. It removes duplicate policy rather than adding structure, has a crisp deletion test, and can be verified through tamper tests that already matter to export and command Target evidence.

Then do Candidate 2 before expanding the product surface. It turns “one natural-language front door” from prompt guidance into a host-owned property. Candidate 3 becomes timely when the current automatic-author work is green. Candidate 4 should follow opportunistically as decision families change, not as a standalone rewrite.

## Defer

- Do not split `eval.ts` merely because it is 2,262 lines. Grading, suite execution, and verified loading have different concerns, but the current interface has high leverage and the evidence invariants make a mechanical split risky. First deepen Run evidence; the remaining seam will become clearer.
- Do not break up `i18n.ts` by locale or screen. It is a frequent edit hot spot because the product is being translated and polished, not because callers learn a wide interface. A dictionary is already a deep in-process module.
- Do not add ports for the Workbench, filesystem, or render modules without two justified adapters. Existing function injection in tests is sufficient until a real second adapter appears.
- Do not introduce a new domain framework. The README vocabulary and invariants already form a strong domain model. A future `CONTEXT.md` could make those names cheaper for automated reviews, but it should summarize existing language rather than create a competing ontology.
