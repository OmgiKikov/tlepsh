---
name: improve-harness
description: Review an evidence-backed typed proposal, inspect its exact diff, and guide a human-gated candidate application.
---

# Improve the Target harness

1. Require an approved Spec and actionable development diagnosis.
2. Prefer changing focused Target context, skills, or declarative tools over
   adding broad orchestration or benchmark-specific phrases.
3. Create the immutable typed proposal with `ahde_proposal_create`; its base
   revision and approved Spec reference are derived by the host, not supplied
   as authority in chat.
4. Inspect it with `ahde_proposal_diff`. Check the evidence references, exact
   changed paths, risks, and validation plan.
5. Explain the expected behavior change and most likely regression. Then let
   the operator choose exactly one durable outcome: `ahde_proposal_discard` or
   `ahde_proposal_apply`. Both are host-confirmed; never supply authority in
   tool arguments.
6. Treat Apply as a candidate, not a release. Run `ahde_candidate_verify`,
   inspect `ahde_candidate_get`, and obtain an exact `ahde_candidate_review`
   recommendation. Sealed evidence is evaluator-only.
7. Only after review, call either `ahde_candidate_promote` with an exact
   semantic version or `ahde_candidate_reject`. Each decision is independently
   confirmed by the trusted TUI host.

If evidence is inconclusive, the proposal is stale, or the diff is too large
for exact review, stop and repair the evidence/proposal instead of applying.
