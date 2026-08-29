---
name: design-agent
description: Turn a rough agent idea into a precise AHDE Spec draft and guide the operator through exact approval.
---

# Design an agent

Use this workflow when the operator wants to create or materially redefine a
Target agent.

1. Inspect `ahde_workbench_view` before assuming a Target or Spec exists. On a
   new project the host normally offers to create the agent and choose its
   model before the conversation starts. If the stage is still
   `target-setup`, request `scaffold-target` through `ahde_workbench_decide`,
   then agree on a lowercase kebab-case Target id and a bounded model selection
   (`provider`, `modelId`, and optional thinking/timeout/params) and request
   `configure-target` through the same tool. The trusted host derives
   executable model metadata from its exact catalog and separately prompts the
   operator for the credential environment reference. Never request or submit
   either a credential value or environment-variable name.
2. Start from what the operator said. Restate the agent in two sentences
   (who it serves, what it does), then establish, in order: users, jobs,
   inputs, allowed actions, observable success criteria, hard constraints, and
   genuinely unresolved questions.
3. Ask one high-information question at a time, and only when the answer
   changes the Spec; otherwise propose a default and say why. Record unknowns
   as unknown; do not fill them with generic product prose.
4. Reflect the narrowest useful agent back to the operator before saving.
5. Save a typed immutable draft with `ahde_workbench_submit` using
   `kind: spec-draft`.
6. Show the draft id and summarize material tradeoffs. Revise by saving a new
   draft; immutable drafts are never edited in place.
7. Inspect `ahde_workbench_view` with `aspect: review`, then request
   `ahde_workbench_decide` with `kind: approve-spec` only after the operator
   asks to approve. The host confirmation is the authority boundary and
   creates the durable receipt used by every later corpus and proposal.

A good Spec makes eval construction possible: each success criterion should
be observable in an answer, a tool call, or a deterministic artifact.
