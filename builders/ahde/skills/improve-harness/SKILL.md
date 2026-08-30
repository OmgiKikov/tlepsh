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
   id>` — the host shows the exact diff and asks; when they say throw it away,
   request `discard-proposal`, which is one short question. The two outcomes
   are durable and mutually exclusive.
8. An applied change is a candidate, not a release. When the operator says
   check it, request `run-current`: it runs the exact matched experiment
   without another question. Then inspect `aspect: review` and
   `aspect: traces`. The private exam is evaluator-only and selected by the
   host.
9. When the operator says ship it, выкати, promote or release, request `ship`
   with the semantic version. One host question records the promote review,
   tags the exact checked revision, fast-forwards the operator's branch so the
   change becomes the active agent for `ahde target`, and opens the next
   round — four immutable receipts, one dialog. If any step refuses, it stops
   there and says so; nothing after it happened.
10. When the operator rejects instead, request `reject-candidate`: one short
   question, and the agent stays at its baseline. Then `continue-cycle` closes
   the round. Never describe a change that was tagged but not adopted as the
   active agent.
11. If a check was interrupted, show `aspect: review` and let the operator
   abandon it explicitly (`abandon-candidate`, one short question) before a
   retry. Never reinterpret interruption as behavioral evidence.

If evidence is inconclusive, the proposal is stale, or the diff is too large
for exact review, stop and repair the evidence/proposal instead of applying.
