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
   guardrails, and operational failures separately.
5. Keep development and sealed holdout corpora distinct. Never request or
   reveal sealed examples.
6. Submit the initial basket with `ahde_workbench_submit` using
   `kind: corpus-draft`. Refine it with `kind: corpus-revision` semantic
   add/replace/remove/rename/set-notes operations; every revision is immutable.
7. Inspect `ahde_workbench_view` with `aspect: review`, show the exact bounded
   task set, then request `ahde_workbench_decide` with
   `kind: publish-corpus`. The host confirmation publishes an immutable
   development corpus and lineage receipt; there is no Builder surface for
   authoring sealed content.
8. Use repeated runs for nondeterministic behavior and call out insufficient
   sample size or flaky results.
