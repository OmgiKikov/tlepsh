---
name: improve-harness
description: Review an evidence-backed typed proposal, inspect its exact diff, and guide a human-gated candidate application.
---

# Improve the Target harness

1. Require an approved Spec and actionable development diagnosis. Immediately
   before authoring, refresh `ahde_workbench_view` with `aspect: traces`. For a
   request such as “fix the first problem”, resolve the ordinal only against
   the returned ordered `improvementBrief.modes`; bind it to the exact
   `{ algorithmId, evalRunId, diagnosisId, briefId }` source tuple and
   `failureModeId` from that same response. Refresh and verify an explicit id
   too; never combine an id with a tuple remembered from another run.
2. Continue only when every selected mode has
   `decision: propose-harness-change` and `selectableForProposal: true`. Do not
   submit a proposal for `stabilize-and-rerun`, `repair-evidence-path`, healthy,
   inconclusive, ineligible, omitted, or unresolved modes. Explain the
   evidence-supported rerun or repair action instead.
3. Prefer changing focused Target context, skills, or declarative tools over
   adding broad orchestration or benchmark-specific phrases.
4. Submit `kind: structured-proposal` through `ahde_workbench_submit` with the
   exact `source` tuple and explicit `failureModeIds` selected above. Express
   only semantic intents: replace instructions, upsert/remove a named skill,
   or upsert/remove a named declarative tool. Never author diagnoses, evidence
   references, repository paths, file modes, content hashes, or unified diffs;
   the host re-derives and validates canonical evidence from the verified brief
   and compiles the exact proposal from a clean Target snapshot.
5. Inspect `ahde_workbench_view` with `aspect: review`. Check the evidence
   references, exact changed paths and diff, risks, and validation plan.
6. Interpret “fix”, “исправь”, or similar natural language as “prepare the
   immutable proposal and show review”, never as approval to apply. Explain the
   expected behavior change and most likely regression, then let the operator
   choose exactly one durable outcome: `/discard` or `/apply <branch>`. Both
   are host-confirmed and mutually exclusive.
7. Treat Apply as a candidate, not a release. Use `/run` to perform the exact
   candidate experiment and inspect `/traces` and `/review`. Sealed evidence is
   evaluator-only and selected by the human host.
8. Only after exact candidate review, request `promote-candidate` with a
   semantic version or `reject-candidate` through `ahde_workbench_decide`.
   Each decision is independently confirmed by the trusted TUI host.
9. If candidate verification was interrupted, show `/review` and let the
   operator use `/discard` to write an explicit abandonment receipt before a
   retry. Never reinterpret interruption as behavioral evidence.

If evidence is inconclusive, the proposal is stale, or the diff is too large
for exact review, stop and repair the evidence/proposal instead of applying.
