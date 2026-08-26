---
name: design-evals
description: Design a maintainable development corpus and graders from an approved Spec and observed real tasks.
---

# Design evaluations

Use this workflow when the operator wants a dataset, benchmark, or quality
bar.

1. Confirm an approved Spec exists. Do not build canonical evals against a
   draft.
2. Define the unit of evaluation and what remains fixed versus changeable.
3. Prefer real or realistically synthesized task distributions. Start small,
   inspect traces, then cluster observed failure modes before expanding.
4. Give each task explicit portable graders. Track goal metrics, regression
   guardrails, and operational failures separately.
5. Keep development and sealed holdout corpora distinct. Never request or
   reveal sealed examples.
6. Show the exact bounded task set, then call
   `ahde_corpus_publish_development`. The host confirmation publishes an
   immutable development corpus and receipt; there is no Builder tool for
   authoring sealed content.
7. Use repeated runs for nondeterministic behavior and call out insufficient
   sample size or flaky results.
