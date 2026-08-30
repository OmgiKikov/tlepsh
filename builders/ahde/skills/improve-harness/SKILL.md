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
3. Call `ahde_workbench_view` with `aspect: target` for the fresh exact-Git
   authoring index. Then read every existing resource the proposal will fully
   replace by calling the same view with one returned `resourcePath`:
   `AGENTS.md` for instructions, an existing `SKILL.md` for a skill, and both
   descriptor and executable for an existing tool. The overview is sufficient
   context for an execution-policy replacement. Never use remembered content,
   undeclared paths, or a resource from another revision. New skills/tools do
   not yet have a resource to read. Retain the exact overview `claim` unchanged.
4. Prefer changing focused Target context, skills, or declarative tools over
   adding broad orchestration or benchmark-specific phrases.
5. Submit `kind: structured-proposal` through `ahde_workbench_submit` with the
   exact `authoringContext: claim`, `source` tuple, and explicit
   `failureModeIds` selected above. Express
   only semantic intents: replace instructions, upsert/remove a named skill,
   or upsert/remove a named declarative tool. Never author diagnoses, evidence
   references, repository paths, file modes, content hashes, or unified diffs;
   the host re-derives and validates canonical evidence from the verified brief
   and compiles the exact proposal from a clean Target snapshot.
6. Inspect `ahde_workbench_view` with `aspect: review`. The host renders the
   evidence references, exact changed paths and diff, risks, and validation
   plan beside your message; read them there and never retype them into chat.
7. Interpret “fix”, “исправь”, or similar natural language as “prepare the
   immutable proposal and show review”, never as approval to apply. Explain the
   expected behavior change and most likely regression. When the operator then
   says apply, request `apply-proposal` with branch `candidate/<proposal run
   id>`; when they say discard, request `discard-proposal`. Both are
   host-confirmed and mutually exclusive (`/apply`, `/discard` are shortcuts).
8. Treat Apply as a candidate, not a release. When asked to verify, request
   `run-current` to perform the exact candidate experiment, then inspect
   `aspect: review` and `aspect: traces`. Sealed evidence is evaluator-only
   and selected by the human host.
9. Only after exact candidate review, request `promote-candidate` with a
   semantic version or `reject-candidate` through `ahde_workbench_decide`.
   Each decision is independently confirmed by the trusted TUI host.
10. Promotion only tags the reviewed revision. At `candidate-adoption`, offer
   `adopt-candidate`: the host fast-forwards the operator's current branch to
   the promoted candidate so it becomes the active Target for `ahde target`
   and the next cycle. Never describe a promoted-but-unadopted candidate as
   the active Target.
11. At `complete` (promoted and adopted, or rejected), offer `continue-cycle`.
   It records the closed loop and releases the candidate from focus; the
   Workbench then derives the next stage from the active Target revision
   (usually `ready-to-evaluate` after adoption, or `improvement-authoring`
   after a rejection). Then continue the ordinary loop from step 1.
12. If candidate verification was interrupted, show `/review` and let the
   operator use `/discard` to write an explicit abandonment receipt before a
   retry. Never reinterpret interruption as behavioral evidence.

If evidence is inconclusive, the proposal is stale, or the diff is too large
for exact review, stop and repair the evidence/proposal instead of applying.
