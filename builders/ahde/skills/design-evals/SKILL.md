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
   The most real distribution the operator already has is
   `imports/feedback.jsonl`: each 👍/👎 they pressed in `ahde target` stored
   the conversation up to the marked reply, its verdict, and any note. When
   they mention feedback, marked replies, or an answer that was wrong, start
   there through the dataset flow instead of imagining cases; a `bad` mark
   usually becomes a judge rubric or an `expected` answer written afterwards,
   and the note says what was wrong.
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
7. For any other data the operator drops in `imports/` — a CSV or TSV export, a
   JSON or JSONL dump, a markdown table, a text file, a chat export — the flow
   is: file in `imports/` → preview → propose a recipe → the host shows sample
   cases → the human confirms → sealed slice is reserved by the host, never seen
   by you. Concretely: `ahde_workbench_view` with
   `aspect: dataset, resourcePath: "imports/<file>"` returns the format, the
   columns with inferred types and three sample values each, and the row count;
   you never read the file yourself. Write a mapping recipe from that preview
   alone and submit it as `kind: dataset-recipe` (`input` from a column or a
   `{{column}}` template, optional `expected`, `dialogue`, `metadata`, `filters`,
   and `sample: { limit, seed }` when the file is larger than a reviewable
   basket). The host re-validates every column and placeholder against the real
   file and answers with the first compiled cases. Show those cases, not the
   JSON. Then request `ahde_workbench_decide` with
   `kind: import-dataset, sealed: { count, seed, stratifyBy? }`; propose a
   sealed slice of roughly a fifth of the rows, and say plainly that those cases
   become the exam nobody develops against. The host draws the sealed slice
   first, publishes it out of your reach, and hands you back only a draft plus a
   count of how many cases were held out. A file that already has a sealed slice
   keeps it: later previews and imports of the same file replay that exact draw.
8. Inspect `ahde_workbench_view` with `aspect: review`; the host renders the
   exact bounded task set, so add one line on what this basket does and does
   not cover, then request `ahde_workbench_decide` with
   `kind: publish-corpus`. The host confirmation publishes an immutable
   development corpus and lineage receipt; there is no Builder surface for
   authoring sealed content.
9. Use repeated runs for nondeterministic behavior and call out insufficient
   sample size or flaky results.
10. To turn an observed failure into coverage, use `add-case-from-run` only with
    an exact failed development EvalRun/Run returned by Workbench. Author a new
    neighboring task rather than duplicating the source case. AHDE verifies the
    run, trace hash, source input, Target/corpus lineage, and persists only
    bounded provenance; passing, inconclusive, foreign, candidate, and sealed
    evidence are rejected.
