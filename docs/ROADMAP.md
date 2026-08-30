# AHDE Roadmap — after V1.8

V1.8 makes the measurement honest and fast (see `V1_8_EVIDENCE_GATE.md`). This
document records what would make AHDE a "Claude Code for agents": a tool where
you describe a task and the agent's harness measurably gets better at that
task, cycle after cycle. Items are ordered by leverage for that goal.

## Why the Builder never sees the sealed holdout

The Builder optimizes the harness against the cases it can see; that is its
job. If it could see the sealed cases too, "+23pp on sealed" would prove
nothing — an instruction like "when contract №23 is mentioned, call
check_dbo" passes the case without generalizing. The development basket is
the textbook: the Builder sees all of it, with every failed trace. The sealed
holdout is the exam, and an exam only measures anything when nobody studied
it. The friction this creates (someone must write ≥15 sealed cases) is
addressed by item 3 below, not by opening the holdout.

## V1.9 — Feedback → Evals (closing the right half of the loop)

Status 2026-08-30 on branch `evidence-gate`: item 0 (dialogue cases, history
prefix) landed; 0b landed end to end (core + Builder/CLI surfaces); 0c landed
as the application core (`docs/V1_9_TOOL_WORKSHOP.md` specifies the Builder
surface); item 1 landed as marks in `ahde target` + the dataset flow (the
simulated user and `ahde feedback import` remain).

0. **Cases are dialogues.** Chat agents (RAG assistants, research agents)
   live in multi-turn conversations, but a case is one message today. Two
   layers: (a) a case with `messages` — the conversation so far plus the
   last user turn — where graders judge the agent's next reply (cheap,
   deterministic, the way chat models are evaluated; Pi's
   `SessionManager.appendMessage` / `agent.state.messages` seed the history
   before the final prompt); (b) a simulated user — a second model
   with a goal and persona for N turns — with graders over the whole
   transcript (a tool called on any turn, a turn budget, a rubric over the
   dialogue). (a) first, ~1–2 days; (b) ~2–3 days. Feedback import (item 1)
   must produce these dialogue cases, not single messages. Nobody writes
   JSONL by hand: the conversation is the interface, the file is storage.
0b. **Any data → benchmark.** Today only JSONL in AHDE's own shape imports;
   everything else is hand-converted. Instead: drop anything into
   `imports/` (CSV/TSV, JSON of any shape, Markdown/TXT, chat exports, XLSX;
   PDF later). The host shows the Builder a bounded preview (columns, types,
   first rows); the Builder proposes a *mapping recipe* (which column is the
   input, which the reference answer, which metadata; which graders), the
   human adjusts it in words on a few sample rows, and the host applies the
   recipe deterministically to every row and hashes it into the import
   receipt. Reference answers become a first-class case field, enabling the
   missing graders: judge-with-reference, lexical/embedding similarity, exact
   match. The host reserves a random (or stratified) sealed slice BEFORE the
   Builder sees the preview, so a sealed holdout comes for free and honestly.
   Chat exports become dialogue cases (item 0). Document folders are not
   cases: they become the Target's retrieval tool; cases are questions over
   them (own, from logs, or synthesized — host-side for sealed). This one
   mechanism subsumes JSONL import and feedback import. ~3–4 days.
0c. **Tool workshop: the Builder writes and tries real tool code.** Today
   a custom tool is one executable authored blind through a `tool.upsert`
   intent. Instead: the Builder gets `write`/`edit`/`bash` inside a
   temporary worktree of the harness, confined to `tools/**`, `bin/**` and a
   new declared `data/**` scope, plus `try_tool` to run a tool on sample
   inputs in the same sandbox. Multi-file tools, dependencies through a
   declared `setup` step (lockfile hashed into `toolsetHash`), data files
   and index builds become possible; the outcome is still an ordinary
   Proposal — exact diff, human apply, verification, promotion. The user's
   checkout is never touched and nothing applies itself. Pi's `sandbox`,
   `subagent` and `protected-paths` examples are the building blocks.
   This is what "build me a RAG agent" needs end to end. ~3–4 days.
   *Application core landed — see `V1_9_TOOL_WORKSHOP.md`: multi-file tools
   with a declared setup step, `data/**` as a declared scope, the multi-file
   and data intents, `tryTool` and `ahde tool try`. The Builder-facing
   write/edit/bash workbench is the remaining wave.*
1. **Feedback becomes tests.** In `ahde target`, any answer is marked 👍/👎
   with one key; the Builder turns it into a case with a grader in a new
   corpus draft. `ahde feedback import <dialogs.jsonl>` clusters real
   dialogues into cases; the human publishes. Baskets should come from life,
   not from imagination. ~2 days.
2. **Autoloop inside the gates.** "Iterate until 90% or five cycles": the
   Builder runs run → diagnose → propose → apply on a branch → verify by
   itself and stops only at promotion or when the verdict is not `improved`.
   The human approves the outcome, not every step. Requires V1.8 gates and
   the worker pool. ~2 days.
3. **Sealed holdout without pain.** Host-side generation of sealed cases by a
   separate evaluator model call whose output never enters the Builder's
   context; the human edits and seals. Removes the "write 15 cases by hand"
   wall the guardrail creates. ~1 day.
4. **Promoted fixes become guards.** On promotion, the tasks the candidate
   flipped from fail to pass are pinned as regression guards (the existing
   `add-case-from-run` made automatic), so solved problems stay solved. ~1 day.
5. **Labeling in the Evidence Explorer.** 👍/👎 on traces in the browser feeds
   both the feedback basket (1) and judge agreement (6). ~1 day.

## Measurement quality (what makes real tasks measurable)

6. **Judge reliability.** `ahde label`: a human labels 15–20 outputs; AHDE
   reports judge–human agreement next to every judge-based verdict, plus
   rubric templates the Builder uses. Without this a judge score is belief,
   not a number. ~2 days.
7. **Semantic failure modes for judge tasks.** Exact grader signatures can
   never make a rubric failure "systemic". The Builder groups failures by
   meaning, explicitly as hypotheses, used only to choose what to fix — never
   as promotion evidence. ~1–2 days.
8. **Search, not one guess.** For one failure mode the Builder proposes 2–3
   different fixes; the pool verifies all; a table shows the verdicts; the
   human promotes the best. Turns a cycle into a small harness search. ~2 days.
9. **Partial credit in the gate.** Graders already carry a `score` in 0..1;
   the comparison gate can pair mean scores instead of binary pass/fail and
   gain power from the same runs. ~1 day.
10. **Richer declarative graders.** Tool-argument checks (`argsMatches`),
    tool-sequence checks (A before B), turn and latency budgets — fewer judge
    calls, more exact signatures. ~1–2 days.
11. **Cost and latency in the verdict.** "+5pp but 3× the cost and latency"
    must be visible next to the interval; cost is in metrics today but not in
    the decision. ~0.5 day.
12. **A safety basket.** Templates for adversarial cases (prompt injection,
    requests the agent must refuse) as a standard sealed component for
    customer-facing agents. ~1 day.

## Operations and feel

13. **Model comparison mode.** "Which model handles my task for the money" is
    the first question users ask; provenance forbids that comparison by
    design, so it needs an explicit exploratory report with no promotion. ~1 day.
14. **`ahde watch`.** The basket on a schedule against the active Target;
    calibration tells provider drift from noise. The "Monitor" step of the
    factory loop. ~1 day.
15. **Cost and time forecast before confirming.** "120 executions · ~$0.10 ·
    ~3 min" from history and calibration in every run/verify dialog. ~0.5 day.
16. **Agent growth chart.** `ahde log`: versions over time with pass rates,
    resolved failure modes, and a human changelog per promotion — what changed
    in behavior, not only in the diff. ~1 day.
17. **Trace in the terminal.** `/trace task_014`: the failing dialogue inline,
    bounded, no browser. ~0.5 day.
18. **Import an existing agent.** Start from "here is my prompt and tools,
    measure and improve it" instead of an empty directory. ~1 day.

## Order

After V1.8: 1, 2, 3 first (they close the loop from the "Evals are all you
need" picture and remove the new friction); then 6, 7, 8 (they separate a tool
that improves toy baskets from one that improves real tasks); the rest as the
product demands.

## Also worth doing

19. **Cheap check before the expensive one.** Run a proposal on the failed
    cases only (5 × 1) before a full verification; if nothing improves, skip
    the 30×3 + 15×3 spend. The original plan's `smoke` gate, in the right
    place. ~0.5 day.
20. **Coverage map Spec × cases.** Which Spec jobs no case exercises; the
    Builder proposes cases for the gaps. ~1 day.
21. **Promotion as a pull request; evals in CI.** Candidate branch → PR with
    the verdict as a comment; promote = merge. `ahde ci` runs the basket on
    every PR to the harness repository so human edits pass the same gate.
    ~2 days.
22. **Ideal answer as grader.** For a failed case the Builder drafts the
    answer it should have given; the human edits; it becomes the expected
    output or rubric. The fastest route to good judge rubrics. ~1 day.
23. **Bisect on drift.** When `ahde watch` catches a drop, binary-search over
    harness versions and dates: "harness v0.4 broke it" vs "the provider
    changed on Sept 12". ~1 day.

Beyond this the list is speculation: ship V1.8, let people run the loop on
their own tasks, and add what they hit.

## Stand on Pi (checked against vendored pi-mono 0.84.3)

Before writing any of the above from scratch, reuse what the vendored Pi
already ships:

- **`packages/evals` + `vitest-evals`** — `createPiCodingAgentHarness`
  (isolated temp project/agent dirs, model per harness, `noTools`,
  `transformSystemPrompt`, prompt/reload step sequences, native session JSONL
  attached per run, `runs.jsonl` index) and `vitest-evals` judges
  (`FactualityJudge` with an expected answer, `StructuredOutputJudge`,
  `ToolCallJudge`, `createJudge`, fuzzy matchers) plus normalized traces
  (`toolCalls`, `assistantMessages`, GenAI semantic attributes). AHDE keeps
  its own runner for provenance/isolation, but the reference-answer graders
  (roadmap 0b) and tool-call matchers should wrap these judges instead of a
  bespoke judge prompt; comparative `evalHarnessTable` is the model-comparison
  mode (13) almost for free.
- **Session tree** — `SessionManager.appendMessage`, `branch`,
  `createBranchedSession`, `agent.state.messages = …`: dialogue cases (0) are
  "append the history, then `prompt(lastUserTurn)`", no runner surgery.
  `/fork` and `/tree` could give the Builder conversation branching for
  alternative proposals (8).
- **`--mode rpc`, `-p`, `--mode json`, `AgentSession` SDK** — headless
  Builder for CI (21), IDE/web clients, and the closed-loop tests.
- **Gondolin / `examples/extensions/sandbox`** — route the Target's built-in
  `bash`/`read`/`write` into a micro-VM; today only declarative tools are
  sandboxed and the built-in `bash` runs on the host with a workspace cwd.
- **`packages/server` + `session-backends`** — remote/team sessions over
  CBOR; the base for a shared Builder later, not now.
- **`examples/extensions/questionnaire`, `structured-output`
  (`terminate: true`), `subagent`, `permission-gate`, `protected-paths`** —
  the Builder's one-question interviews, a proper final-answer tool for the
  Target instead of the recovery prompt, sub-agents, and gate patterns.
- **`packages/telemetry`** — typed span/event schema for RunEvents if they
  ever leave the process.
