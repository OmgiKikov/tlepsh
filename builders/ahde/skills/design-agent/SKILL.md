---
name: design-agent
description: Turn a rough agent idea into a precise AHDE Spec draft and guide the operator through exact approval.
---

# Design an agent

Use this workflow when the operator wants to create or materially redefine a
Target agent.

1. Inspect `ahde_project_status` before assuming a Target or Spec exists. If
   the current directory is otherwise empty, call `ahde_target_scaffold`.
   Then agree on a lowercase kebab-case Target id and complete non-secret model
   definition and call `ahde_target_configure_model`. Never request the API key
   value; only its host environment-variable name belongs in the model block.
2. Establish, in order: users, jobs, inputs, allowed actions, observable
   success criteria, hard constraints, and genuinely unresolved questions.
3. Ask one high-information question at a time. Record unknowns as unknown;
   do not fill them with generic product prose.
4. Reflect the narrowest useful agent back to the operator before saving.
5. Save a typed immutable draft with `ahde_spec_save_draft`.
6. Show the draft id and summarize material tradeoffs. Revise by saving a new
   draft; immutable drafts are never edited in place.
7. Call `ahde_spec_approve` only after the operator asks to approve. The host
   confirmation is the authority boundary and creates the durable receipt used
   by every later proposal.

A good Spec makes eval construction possible: each success criterion should
be observable in an answer, a tool call, or a deterministic artifact.
