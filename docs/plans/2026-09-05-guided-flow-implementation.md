# AHDE: guided conversation and trustworthy evidence

Date: 2026-09-05. Owner: root integration; implementation tracked by the active Codex goal.

## Product decision

The terminal conversation is the product. A user describes an agent or an improvement, and AHDE carries the work through the existing Workbench: understand → create/connect → prepare cases → run → inspect failures → prepare change → verify → accept version → continue. The optional localhost Evidence explorer explains recorded answers, tool actions, checks and comparisons. No browser Studio or second workflow engine.

The host asks when an exact consequential decision needs human authority, or when a run has unknown or above-threshold cost/duration. Routine execution continues without teaching slash commands. A stopped task preserves completed artifacts; interrupted execution is never evidence of agent quality. Unknown measurements remain unknown. A relative sealed verdict is not an absolute readiness claim.

## Consolidated review decisions

The three independent reviews converged on the same execution split: slash commands use BuilderJobs; natural-language Workbench decisions bypass its busy, cancellation, background and completion lifecycle. Their additional findings are complementary:

1. **Engineering review:** reuse WorkbenchNext, composites, receipts and persisted Workshop state; add one execution coordinator and a small typed host-action interface. Inject fresh host state before each model turn. Test the actual extension hooks, not only a scripted tool list.
2. **Architecture review:** use one resolution policy for run-current and suggested next actions. Pin composite consent to the exact branch, baseline and artifacts that were shown; revalidate after the dialog. Keep domain decisions behind Workbench.view/submit/decide.
3. **Thermo-nuclear quality review:** delete the rejected Studio implementation and duplicated execution paths. Remove timeout-based fake background authorization, abort jobs on shutdown, release the busy state before completion wakes the model, and report partial progress honestly.

Detailed review artifacts:

- [Engineering](2026-09-05-guided-flow-eng-review.md)
- [Architecture](2026-09-05-guided-flow-architecture-review.md)
- [Code quality](2026-09-05-guided-flow-quality-review.md)

## Implementation lanes

### A. Shared conversational execution — product_ux_audit

Own Builder jobs, command integration, tool integration, extension lifecycle and their tests. Give natural-language decisions and shortcuts one owned execution lifecycle. Preserve typed domain results for completed work; return an explicit active job receipt for background work. Route stop/status through the same instance. Do not release a pending authorization merely because two seconds elapsed. Shutdown aborts running work and prevents late notifications. Completion can wake a turn only after clearing busy state. Concurrent consequential mutations are refused while execution is active; reading remains available.

Add only the missing host-owned actions that complete the main conversational loop: active jobs/stop, passport, recorded dataset export, judge labeling, and private exam import via host dialogs. Reuse existing view/history/target reads and native host capabilities; no arbitrary command dispatcher, shell capability or credential exposure. Preserve interruption semantics and the exact contents of accepted changes.

### B. Canonical guidance and consent — architecture_audit

Own Workbench guidance, run-current resolution, composite consent and tests. Next actions, visible next step and executor must agree for partial/interrupted candidates and recorded workshops. Publish compact current context to the Builder through a helper that lane A installs in the native before_agent_start hook. Consent to Ship must bind the displayed target branch and baseline, candidate, proposal and requested version; changing the branch during the dialog fails before adoption. Do not create a second durable stage machine or replace existing immutable artifacts.

### C. Trust and delivery — delivery_audit

Complete and verify existing changes to unknown cost/tokens, watch infrastructure outcomes, regression case preservation, proposal search and historical comparison compatibility. Finish built-in template names and installed-package verification. Preserve the explicit required-Docker CI lane; do not silently count skips as coverage. Existing fully reported numeric evidence must still load and verify. Historical comparisons that substituted zero for missing usage remain readable but require a rerun before promotion. Watch infrastructure failures cannot be reported as healthy agent behavior.

### D. Evidence and integration — root

Remove only the inspected rejected Studio WIP, after saving a local backup. Complete the Evidence page models and responsive comparison view: bounded actual before/after conversations, regressions first, actions/state checks, links to full verified traces, redaction and sealed exclusion. Reuse canonical explanation text and localization, not a second verdict computation. Keep errors visible and distinguish missing data from zero. Correct README/roadmap to the implemented product. Prepare a reproducible management demo and an honest readiness report with verified scope and remaining limits.

## Acceptance

- Source and test type checks pass; the full applicable test suite passes.
- Conversational and command execution share stop, busy, progress and completion behavior; no completion note before a human answers a pending gate.
- Cancellation after approval/publication preserves those facts and does not say that nothing happened. Shutdown produces no orphan completion turn.
- Resume reconstructs the current Workbench/Workshop state; next actions do not offer impossible execution for an interrupted candidate.
- Switching branches during Ship approval fails without adopting or continuing on an unapproved branch; ordinary one-dialog Ship still completes.
- Regression cases preserve world and simulated-user context; unavailable costs and tokens stay null through comparison/search/report; watch reports infrastructure trouble honestly.
- Evidence compares real recorded repetitions, puts regressions first, escapes untrusted content, and never projects sealed identifiers or trace contents. Desktop and narrow viewport layouts are visually inspected.
- Installed package smoke, deterministic full-loop demo, and existing vertical-slice/Builder integration checks pass. Paid or scripted model evidence is labeled accurately.

## Scope and sequencing

First remove rejected Studio edits so Builder lanes have a stable base. Then run lanes A–D in parallel with explicit file ownership. Run focused checks per lane, review the integrated diff, run full checks once the code converges, then build/package/demo and inspect the actual Evidence pages. Fix observed failures and repeat only affected checks before final integration verification.

No merge to master, push, deployment, external sharing or user-owned data deletion is part of this goal. Cloud hosting, additional watch/serve control surfaces, model-axis experiments and a new benchmark research program are separate product increments. Existing large files are not mechanically split merely to satisfy a line count: this change must delete duplicated rules and execution paths, and new modules must remain bounded.

## Execution record

Status: implemented and verified locally on 2026-09-05. All acceptance work in this goal is complete; external pilot and Linux/Docker runner validation remain explicitly outside this local result.

### Implemented

- **Conversation lifecycle:** `builder/execution.ts` coordinates both shortcuts and natural-language decisions; `decision-presentation.ts` renders their shared result. `jobs.ts` owns busy, stop, shutdown and completion. The extension refreshes guidance before each turn and exposes six bounded host actions. Private exam dialogs remain host-owned. Hosts without a completion message channel receive the full result in the original call; the native terminal retains background execution.
- **Guidance and authority:** `workbench/run-resolution.ts` supplies one execution policy to the view and decision path. `composite-consent.ts` binds an approval to the exact artifacts and target branch; stale choices fail before mutation. Bare `ahde` continues this project's validated history by its exact path; explicit new/picker entry points remain available.
- **Trust:** unknown Target usage is no longer converted to zero; missing or truncated receipt members make totals unknown. Monitoring separates infrastructure failures from agent drift. Regression guards keep world and simulated-user context. Historical, fully reported numeric evidence remains compatible; old false-zero comparisons require new evidence before promotion.
- **Evidence:** bounded actual before/after dialogues, deterministic repetition selection, regressions first, separate executed/reported tools, canonical explanations, explicit incomparable/excluded cases, private-exam exclusion and redaction. One localization dictionary supplies both Russian and English. Manual browser inspection covered 1280px and 390px widths in the dark theme, comparison → full trace navigation, and no horizontal overflow at either width.
- **Delivery:** built-in template names resolve from an installed package outside the checkout. Package verification rejects stale Studio files. Linux CI requires bubblewrap and real Docker instead of silently skipping container coverage. The rejected Studio WIP was backed up locally and removed; README and roadmap describe the terminal product.
- **Management handoff:** [reproducible demo guide](../management-demo.md), with a clear distinction between deterministic machinery tests, earlier live-model evidence and the remaining operator pilot.

### Validation record

The first integration pass exposed old eight-tool fixture contracts, synchronous completion expectations and one extra prompt line. Fixtures were updated without weakening gate or sequencing assertions. A dedicated test also verifies that a host without a completion channel receives its durable result in the original call. The native background lifecycle remains separately covered.

- **Final `npm run check`: PASS.** Both TypeScript checks; 143/143 test files, **2,298 passed / 3 skipped**, 212.82 seconds. The three skips require Docker. Full log: `.ahde/guided-flow-check-final.log`.
- **`npm run verify:package`: PASS.** Fresh local/global installs; four template aliases from a consumer directory; init, truthful readiness validation, Builder startup, sandboxed Target tools, container argv/matrix, loopback Evidence, authenticated serve API and canonical promotion. The package contains the new bounded host action and excludes removed Studio files. Full log: `.ahde/guided-flow-package.log`.
- **`npm run demo`: PASS.** Baseline 0/2 passing; a reviewed retrieval fix; matched development and 15-task × 2 sealed evaluation; `v0.2.0` promotion, exact adoption and persisted next cycle. RAG retrieval/citation checks passed; passport, four-dialogue dataset and HTML report were saved. Full log: `.ahde/guided-flow-demo.log`. This used a scripted local model and made no paid API calls.
- **Management artifact:** `.ahde/management-demo/exports/version-v0.2.0.html` is a copy with an explicit scripted-model banner; adjacent passport and dataset retain their original bytes. The untouched evidence is at `/var/folders/qc/vpt0wq8x12z8r8gr53hlww1c0000gn/T/ahde-demo-LaMpbs`. The copied light-theme report was visually checked at 1280px and 390px, including the expanded exact diff and absence of horizontal overflow. The optional dark-theme Evidence comparison and run pages were checked separately.
- **Final hygiene:** `git diff --check` passed. Temporary preview servers and browser tabs created for QA were closed. No source changes were made after the final full check; subsequent changes were documentation and annotated demo copies.

### Limits of this delivery

This is an internally reviewable product increment, not evidence of universal agent quality. No new paid model or unfamiliar-operator pilot was run as part of this implementation. Jobs belong to their process; history and persisted Workbench/Workshop artifacts recover, but a killed process does not resurrect in-flight computation. The existing judge/simulated-user receipt format may still encode undeclared pricing as numeric zero; pricing completeness for these evaluators is not established without declared rates. Local macOS results do not establish Linux/Docker CI success. No merge, push or external publication was performed.
