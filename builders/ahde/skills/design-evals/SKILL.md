---
name: design-evals
description: Design a maintainable development corpus and graders from an approved Spec and observed real tasks.
---

# Design evaluations

Use this workflow when the operator wants a dataset, benchmark, or quality
bar.

1. Confirm `ahde_workbench_view` is at `corpus-design` or `corpus-review` with
   one exact approved Spec selected. Do not build canonical evals against a
   draft or another Spec lineage.
2. Define the unit of evaluation and what remains fixed versus changeable.
3. Prefer real or realistically synthesized task distributions. Start small,
   inspect traces, then cluster observed failure modes before expanding.
4. Give each task explicit portable graders. Track goal metrics, regression
   guardrails, and operational failures separately. `output_matches` patterns
   are JavaScript regular expressions (no inline flags like `(?i)`; use
   `[Цц]`-style classes); `judge` graders run only when the Target manifest
   configures a judge model, so prefer `output_contains`, `output_matches`,
   and `tool_called` unless the operator has set one up.
5. Keep development and sealed holdout corpora distinct. Never request or
   reveal sealed examples.
6. Submit the initial basket with `ahde_workbench_submit` using
   `kind: corpus-draft`. If the operator provides a JSONL file in the private
   project-local `imports/` inbox, use `kind: corpus-import`; AHDE validates it,
   keeps the inbox outside Target/eval workspaces, discards caller-owned task ids,
   derives Spec-bound ids, and records an immutable source hash receipt. Refine
   the result with `kind: corpus-revision` semantic
   add/replace/remove/set-graders/grader.add/grader.update/grader.remove/rename/
   set-notes operations; every revision is immutable.
7. Inspect `ahde_workbench_view` with `aspect: review`, show the exact bounded
   task set, then request `ahde_workbench_decide` with
   `kind: publish-corpus`. The host confirmation publishes an immutable
   development corpus and lineage receipt; there is no Builder surface for
   authoring sealed content.
8. Use repeated runs for nondeterministic behavior and call out insufficient
   sample size or flaky results.
9. To turn an observed failure into coverage, use `add-case-from-run` only with
   an exact failed development EvalRun/Run returned by Workbench. Author a new
   neighboring task rather than duplicating the source case. AHDE verifies the
   run, trace hash, source input, Target/corpus lineage, and persists only
   bounded provenance; passing, inconclusive, foreign, candidate, and sealed
   evidence are rejected.
