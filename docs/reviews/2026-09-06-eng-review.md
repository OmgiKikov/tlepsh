# AHDE engineering review · 2026-09-06

Status: **DONE_WITH_CONCERNS**. Reviewed `e98f97a` plus the current uncommitted Python connection, onboarding, evaluator-v5 and replay changes. Read-only review of production code; the only repository write in this review is this report. The named gstack `plan-eng-review` was read; its architecture, quality, test and performance sections were applied. Routine choices were made under the user's explicit autonomous delegation. No telemetry, remote artifact sync, dependency upgrade or product mutation was performed.

## Scope decision and what already exists

Finish the existing terminal product. Pi already supplies the conversation runtime, model/auth catalog, sessions, streaming and TUI. AHDE owns the workflow, isolated Target execution, immutable approval/evidence receipts, grading and release boundaries. The browser is a projection of the same recorded evidence. A new orchestrator, dashboard framework or persistence service would duplicate working responsibilities.

The existing `src/corpus.ts` reader already distinguishes a missing corpus store (empty list) from malformed metadata (exception). `isSealedEvalRun` already knows explicit visibility, the `sealed-` naming convention and legacy sealed hashes. Reuse these rather than inventing another visibility registry. Keep current v5 evaluator stamps and historical inspection behavior; old measurements must remain readable without becoming current release authority.

The large worktree is mostly existing evaluator-stamp fixtures and separate product fixes, not a reason to rewrite it. This review adds one necessary trust-boundary correction and two acceptance/maintenance tasks. No new classes or services are needed. There is no root `TODOS.md` or root `AGENTS.md`/`CLAUDE.md` in this checkout.

## 1. [P1] Corpus read failure becomes permission to expose legacy evidence

Confidence: **10/10** for the duplicated lookup; **9/10** for the inventory/context siblings, traced in source.

Motivating code:

- `src/cli.ts:548`, `src/builder/label-session.ts:106`, `src/application/export-dataset.ts:1055`: `catch { return new Set(); }` after `listCorpora`.
- `src/eval.ts:1437`: `legacySealedDatasetHashes.has(record.datasetHash)` is the remaining protection for a record lacking explicit visibility and a `sealed-` dataset name.
- `src/workbench/inventory.ts:677`: the corpus exception leaves `corpora = []`; line 819 constructs `sealedHashes` from it, line 830 admits the legacy eval. `deriveWorkbenchView` still publishes those selections even when there is an integrity blocker.
- `src/builder/project-context.ts:173`: the same failure leaves an empty `corpora`, followed by a permissive hash filter at line 185. The warning incorrectly promises that sealed identities stay hidden.

Reproduction used a fresh synthetic corpus, never a customer exam. `createCorpus(...visibility: 'sealed')` plus a legacy record with dataset `development` and the matching hash yields `isSealedEvalRun = true`. Replacing only that temporary corpus's `metadata.json` with `{` makes `listCorpora` reject, but `sealedDatasetHashesFor` returns an empty set and `isSealedEvalRun` becomes **false**. Observed output: `beforeSealed: true`, `listCorporaRejected: true`, `afterHashCount: 0`, `afterSealed: false`. Scratch directory: `/var/folders/qc/vpt0wq8x12z8r8gr53hlww1c0000gn/T/ahde-eng-private-metadata-Ekv1sT`.

Affected consumers are CLI dataset export and judge labeling; native `/label`; dataset host actions; passport dataset export; Workbench inventory and Builder project context. Host actions and passport import the application helper, so fixing only the CLI misses both.

**Decision 1A, recommended:** one metadata-only sealed-hash reader in the existing corpus module, throwing a generic classification-unavailable error on malformed metadata. Missing store remains an empty list. Remove the three permissive copies. Inventory and project context must not admit unclassified legacy evals after metadata failure. Keep error details containing private paths/identities out of Builder-facing results.

Alternative 1B: reject every legacy record everywhere. Smaller apparent patch, but needlessly removes valid historical evidence and does not distinguish a missing store from a broken one. Do not choose it without a broader historical-visibility design.

Acceptance: healthy development remains usable; healthy sealed and malformed-metadata legacy sealed never return content or identifiers through export/label/context; no output file or model call occurs on refusal; missing store still works; formal `sealed` and `sealed-*` protections remain. Parameterized regressions belong in the existing corpus/export/label/Workbench/context suites.

**Additional boundary to verify during implementation:** `src/evidence/model.ts:71` calls `isSealedEvalRun` without legacy hashes. Several report/regrade readers do likewise. Explicit/formal sealed is protected, but an unmarked historical eval cannot be classified from its index alone. The source pattern is confirmed; complete HTTP exploit evidence was not gathered in this bounded review. Do not claim the whole historical boundary closed solely because the three catches disappear.

## 2. [P2] Scripted SDK success does not prove the advertised first terminal session

Confidence: **9/10**; this is an acceptance gap, not a claim that the new onboarding code fails.

`tests/builder-pi-natural-language.test.ts:62` chooses predetermined tool calls via `switch (step)`. The test creates `createAgentSessionFromServices` and a stubbed host UI; it does not launch the public `ahde` terminal or make an unscripted Builder decide how to adopt an unfamiliar Python project. This is a useful protocol integration test, but it cannot establish the product promise in README: existing folder → natural request → measured baseline → authored correction → verification.

The current worktree has focused tests for new function/HTTP bridges, source and native-basket preservation, deferral before login, restart and v5 historical replay. Keep them. Previous acceptance recorded a real Builder/Target experiment driven by a private driver, so it also cannot substitute for the public terminal session.

**Decision 2A, recommended:** finish one black-box public-CLI/TUI acceptance using an independently prepared Python `respond(text)` project and basket. Let a real Builder author the change; pin a small spend cap and keep every attempt. Test cancel/defer, reopen, baseline, explanation, actual prompt diff and verified replay. No private Workbench calls in the driver. Separate deterministic local Target evidence from any claim about customer-model quality.

Acceptance: exact commands/session artifact, source/basket byte preservation, recorded before/after executions, actual authored diff, all attempted spend and a readable final evidence link. Complete `npm run verify:package` on the installed tarball with the new bridge and walkthrough present. A synthetic operator is not a human usability study; report that boundary without deferring executable checks.

## 3. [P3] The prompt-cost diagnostic has its own divergent prompt composer

Confidence: **9/10**, overlaps Ponytail Audit deliberately.

`src/builder/runtime.ts:21` sets `BUILDER_SKILLS: readonly string[] = []`; production uses `resolveBuilderAssets`. `scripts/prompt-size.mjs:16` instead enumerates every `builders/ahde/skills/*/SKILL.md`, then lines 23–45 maintain a second frontmatter/parser/composer. Adding an obsolete skill directory makes the diagnostic count instructions production never sends.

**Decision 3A, recommended:** have this diagnostic read the production-composed prompt and retain the optional historical persona input only through the existing composer. Delete the duplicate scanner/parser. Do not add a tokenization dependency; the output already labels chars/4 as an estimate.

Acceptance: the reported character count equals `resolveBuilderAssets().systemPrompt.length`; an unrelated skill directory cannot change it. This is a small maintenance fix, not a product blocker by itself.

## Test and failure map

```text
Public terminal: Python folder + native basket
  -> host adoption review     [existing tests: source preservation/stale input/symlink]
  -> model setup/defer        [existing tests: builder-product-shell]
  -> Spec + reviewed corpus   [existing scripted SDK integration]
  -> baseline -> diagnosis    [existing runner/eval/diagnosis tests]
  -> real authored diff       [GAP: public TUI acceptance, no private API bypass]
  -> matched verification    [existing comparison and real driver evidence]
  -> replay / final review    [existing page/HTTP tests; inspect actual final build]

Corpus visibility read
  -> store missing            [reader returns [] intentionally; keep this]
  -> valid metadata           [existing sealed hash refusal checks]
  -> malformed metadata       [CONFIRMED GAP: empty-set fallback]
       -> export / label      [must refuse before output or subject read]
       -> inventory/context   [must hide unclassified evals, not only add blocker]
  -> formal sealed            [existing HTTP/label/export refusal tests]

Distribution
  -> npm pack -> clean local/global install [existing verify:package]
       -> packaged Python bridge + docs    [verify current artifact]
```

No coverage percentage is claimed from a source audit. Existing tests were inspected, not rerun by this reviewer. Root supplied the current 2,522-pass suite result; that does not cover the newly reproduced gap.

## Performance and current technical direction

No measured performance regression justifies a cache, database or new concurrency layer. Inventory reads many artifacts synchronously, but moving those reads without measurements risks stale approval/evidence state. Keep the existing bounded run previews and bounded author/execution budgets; profile a slow real project before changing persistence. The demonstrated performance-related defect is the misleading prompt-cost diagnostic above.

The current [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) exposes session runtime replacement, steering/follow-up queues, subscriptions, custom tools and `ModelRuntime` auth/catalog operations. AHDE already uses Pi's runtime and TUI rather than reconstructing them. Reuse is appropriate; upstream also makes clear that session replacement needs renewed subscriptions and auth/network work needs caller-owned deadlines. No unverified upgrade is proposed.

[Anthropic's eval guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) supports isolated trials, deterministic checks where possible, calibrated model graders, balanced cases and transcript inspection. AHDE's world state, per-run evidence, judge labeling, development/validation split and sealed exam serve those needs. Its v5 citation fix is necessary because a similarity match is not an explicit citation. These sources support the direction; they do not certify this code or prove agent improvement.

## Minimal execution plan

1. Fix the sealed metadata failure at the shared read boundary and all confirmed context/inventory siblings; add regressions before claiming closure. Inspect historical public readers as part of that boundary.
2. In parallel, complete the public newcomer terminal acceptance and remove the duplicate prompt-size composer. Preserve prior uncommitted fixes.
3. Rerun relevant regressions, then the complete check and installed-package acceptance. Inspect the final replay in the browser. Publish only after exact-commit macOS/Linux CI is green.

Not in scope: new Studio, generic plugin architecture, replacing Pi, package-registry publication, architecture-driven file shuffling, unmeasured caches, customer deployment or new model research. Customer agent/IFT integration requires actual customer inputs and is not evidence the synthetic pilot can manufacture.

## GSTACK REVIEW REPORT

| Review | Trigger | Status | Findings |
|---|---|---|---|
| Engineering | explicit parallel `plan-eng-review` | issues_open | 1 P1 boundary defect, 1 P2 public-flow acceptance gap, 1 P3 diagnostic duplication |

Scope reduced to confirmed work; architecture/code quality/tests/performance considered; test diagram produced; outside voice supplied by the other requested parallel reviews. No unresolved routine design choice. **VERDICT: implement the P1 and finish acceptance before shipping.**
