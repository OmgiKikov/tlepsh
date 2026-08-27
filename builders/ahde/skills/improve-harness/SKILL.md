---
name: improve-harness
description: Review an evidence-backed typed proposal, inspect its exact diff, and guide a human-gated candidate application.
---

# Improve the Target harness

1. Require an approved Spec and actionable development diagnosis.
2. Prefer changing focused Target context, skills, or declarative tools over
   adding broad orchestration or benchmark-specific phrases.
3. Submit `kind: structured-proposal` through `ahde_workbench_submit`. Express
   only semantic intents: replace instructions, upsert/remove a named skill,
   or upsert/remove a named declarative tool. Never author repository paths,
   file modes, content hashes, or unified diffs; the host compiler derives and
   validates the exact proposal from a clean Target snapshot.
4. Inspect `ahde_workbench_view` with `aspect: review`. Check the evidence
   references, exact changed paths and diff, risks, and validation plan.
5. Explain the expected behavior change and most likely regression. Then let
   the operator choose exactly one durable outcome: `/discard` or
   `/apply <branch>`. Both are host-confirmed and mutually exclusive.
6. Treat Apply as a candidate, not a release. Use `/run` to perform the exact
   candidate experiment and inspect `/traces` and `/review`. Sealed evidence is
   evaluator-only and selected by the human host.
7. Only after exact candidate review, request `promote-candidate` with a
   semantic version or `reject-candidate` through `ahde_workbench_decide`.
   Each decision is independently confirmed by the trusted TUI host.
8. If candidate verification was interrupted, show `/review` and let the
   operator use `/discard` to write an explicit abandonment receipt before a
   retry. Never reinterpret interruption as behavioral evidence.

If evidence is inconclusive, the proposal is stale, or the diff is too large
for exact review, stop and repair the evidence/proposal instead of applying.
