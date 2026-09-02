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
   and `tool_called` unless one is set up. `target.evaluators.judge` in the
   Workbench view says whether it is; when it is `null` and the basket really
   needs a judge, request `ahde_workbench_decide` with
   `kind: configure-evaluators` and a provider plus a model id from the host
   catalog. One question, and the operator names the key variable.
5. When a judge grader is right for a case, write `assertions` — concrete
   yes/no checks, one behaviour each ("the answer states the refund window in
   days") — rather than a paragraph of prose. The judge answers each one
   separately and may answer `unknown` when the answer does not say; unknown
   counts as a failure, so it costs nothing to let it be honest. Keep `rubric`
   for shared context, and offer a `jury: 3` on a sealed set or wherever a
   single verdict would decide a promotion: three independent judges, majority
   decides, a tie fails. After the first run of a judge-graded basket, when the
   judge still reads as not calibrated, offer the blind check once:
   “оцени 20 ответов вслепую — 10 минут — и я буду знать, насколько верить судье”.
   Name `/label`, which the operator runs right here in this conversation: it shows
   them exactly what the judge was shown (the request or the goal, the answer or
   the whole conversation, the rubric, the reference answer) and asks the same
   question, assertion by assertion, before revealing the judge's verdict. A
   rubric nobody has checked against a human is a guess with a token cost — but
   offer it exactly once per revision, the same way noise calibration is
   offered, and never mention it again once they have answered or agreement
   exists.
5b. When agreement comes back low, or the operator says the judge is too strict
   or too lenient, or disputes one verdict: fix the rubric, do not re-run the
   agent. Revise the graders in the draft (`grader.update`, `set-graders`) so
   the assertions say what the operator actually meant, then request
   `kind: regrade` — it scores the answers that are already recorded against
   the new rubric, so the agent is not called again and only the judge is paid.
   Show what started passing, what stopped, and which grader decided, then ask
   whether to publish the revised graders. A re-score is never a new baseline:
   to compare a candidate on the new rubric, the baseline is re-scored with the
   same grader set.
6. Keep development and sealed holdout corpora distinct. Never request or
   reveal sealed examples.
6b. When the operator has no real cases to hold out and needs a sealed exam
   anyway, do not write one. A model that writes the holdout has read the
   holdout, and every later verdict on it is an echo of your own guess. Request
   `ahde_workbench_decide` with `kind: generate-holdout, cases, mode` instead:
   the host has the Target's configured judge write it — the same model that
   grades an answer, already outside your context — from the approved Spec and a
   seeded draw of published development cases shown for their shape. It needs
   `evalSuite.judge` configured (`kind: configure-evaluators` first if it is
   not) and an approved Spec; it refuses a judge equal to the Target's own
   model, for the reason evaluator setup refuses it. Offer both modes in one
   sentence and let the operator pick: `mode: "seal"` writes the exam straight
   into a sealed corpus, `mode: "review"` writes a draft to a private file they
   read, edit and import with `/holdout` — recommend that one for a first exam,
   because a generated case that is subtly wrong is worse than no case and the
   only cure is somebody reading it. Ask for at least 15 cases, below which the
   sealed guardrail can only say `underpowered`. You will see the case count,
   the generator model and the prompt hash — never a case, and never ask for
   one.
7. Submit the initial basket with `ahde_workbench_submit` using
   `kind: corpus-draft`. If the operator provides a JSONL file in the private
   project-local `imports/` inbox, use `kind: corpus-import`; AHDE validates it,
   keeps the inbox outside Target/eval workspaces, discards caller-owned task ids,
   derives Spec-bound ids, and records an immutable source hash receipt. Refine
   the result with `kind: corpus-revision` semantic
   add/replace/remove/set-graders/grader.add/grader.update/grader.remove/rename/
   set-notes operations; every revision is immutable.
8. For any other data the operator drops in `imports/` — a CSV or TSV export, a
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
8b. A case can carry a frozen dialogue or a live one, never both. `messages` is
    the conversation as it happened: the host seeds every turn but the last and
    grades the reply that follows — right when the operator already has the
    transcript and knows what the next answer should have been. `simulatedUser`
    is the opposite: `{ goal, persona?, maxTurns, stopWhen? }` on the case, the
    case `input` as the opening message, and a second model writing every later
    user turn from the goal and the conversation so far. Use it whenever the
    quality being measured only appears over several turns — asking a clarifying
    question instead of guessing, recovering from a vague answer, refusing
    politely and still helping. It needs `evalSuite.simulatedUser` configured in
    the Target manifest, exactly like a judge, and it is set up the same way —
    `kind: configure-evaluators` with `simulatedUser`; a suite with such cases
    and no user model refuses to load. Keep `maxTurns` small (3–6): the budget is part
    of what you are measuring, and a `turn_budget: { max: N }` grader says so
    outright. A `judge` grader on such a case reads the whole conversation
    rather than the last reply, so write rubrics about the conversation ("does
    not ask the same thing twice"). The user model never sees your graders, the
    reference answer, or anything about the harness — so never encode the answer
    in the goal; write what the person wants, not what the agent should say.
9. Inspect `ahde_workbench_view` with `aspect: review`; the host renders the
   exact bounded task set, so add one line on what this basket does and does
   not cover, then request `ahde_workbench_decide` with
   `kind: publish-corpus`. The host confirmation publishes an immutable
   development corpus and lineage receipt; there is no Builder surface for
   authoring sealed content.
10. Use repeated runs for nondeterministic behavior and call out insufficient
    sample size or flaky results.
11. To turn an observed failure into coverage, use `add-case-from-run` only with
    an exact failed development EvalRun/Run returned by Workbench. Author a new
    neighboring task rather than duplicating the source case. AHDE verifies the
    run, trace hash, source input, Target/corpus lineage, and persists only
    bounded provenance; passing, inconclusive, foreign, candidate, and sealed
    evidence are rejected.
