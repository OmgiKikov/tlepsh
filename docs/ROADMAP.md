# AHDE roadmap

What is ahead, and why in this order. What is already true is in the README;
what may never change is in `INVARIANTS_V1.md`. This file is not a changelog:
when an item lands it leaves this page.

## Where we stand (2026-09-04, night)

Builder Pi is the front door and the only human interface. Stage 1 of the
plan below landed in one day and was accepted live on 2026-09-03/04: a plain
folder holding a Python agent (internet-provider support: a tariff, a
balance, a block, a technician ticket) was adopted with one question, the
Builder wrote fifteen cases nine of which carry the client's state, the
agent ran forty-five executions in eight minutes inside the sandbox, the
Builder measured the noise itself, rewrote `prompts/system.md` in a
workshop, and the verification read «стало лучше · балл 73 % → 85 % (+12,4
п.п., 95 % ДИ +4,8 … +20,2) на 14 кейсах × 5 · экзамен: пройден · ухудшения
не доказано, улучшения тоже»; `v0.1.0` was shipped, the passport said
«обещано +8,9 · получено +10 ✓», and `/dataset` wrote fifty conversations
with the world before and after and the judge's verdicts. Three defects were
fixed in the code during the session (the sandbox denied the route socket
address selection needs, the environment fingerprint depended on the case,
an empty answer was an infrastructure error) and one outside it: the
OpenRouter catalog now routes Anthropic models through a path the pinned Pi
cannot reach, so the Builder ran on `openai/gpt-5.4`. The session reports
live beside the earlier five.

The work sync of the same day set the real order: agents written in Python,
a dialogue emulator over a test basket with client state and tool mocks, a
knowledge base to emulate for RAG agents, and an improvement loop that runs
without a per-iteration approval and asks once at the end. An outside review
of the next plan (2026-09-03) put it bluntly: polishing the screens first
would leave the doubt about the engine in place. So the engine foundation
goes first, and every product screen after it sits on those seams. The
reviewed plan is in four stages; the items below follow it.

## Stage 1 — the foundation

1. **A Target that is a Python program.** Today the Target is a Pi
   invocation. The customer's agents are Python sources. The manifest gains
   `execution.kind: command`: the agent runs as a child process under a
   versioned JSON-lines protocol on stdin/stdout (a user turn in; the reply,
   tool calls the host brokers, and usage out), inside the same sandbox,
   over the same hash-checked snapshot, and its transcript is written as
   the same session JSONL the one parser already reads. A folder that
   already holds an agent and no manifest is adopted with one question. The
   harness becomes the manifest's declared list of editable files, and
   invariants 5 and 17 read that list instead of naming `AGENTS.md`,
   `skills/**`, `tools/**`. A reference Python agent ships in `examples/`
   and is the acceptance Target from here on; the ombudsman retires.
2. **The case as a world.** A case carries `world`: the client's state
   (accounts, blocks, history) written to a per-run file outside the
   snapshot that the tools read and write, and a `world_state` grader that
   checks what the world looks like when the conversation ends, not only
   what the agent said. The world is part of the dataset's identity. The
   panel shows a case as four lines: who, what they have, what they want,
   what must happen. This and item 1 are the emulator.
3. **The exam from the knowledge base.** Most of the customer's agents
   answer from documents. A declared `data/kb` turns on a host-provided
   lexical `kb_search` tool (no embedding model, no network), and
   `generate-holdout` writes questions from its chunks with a reference
   answer and a citation; a `cites_source` grader checks that the answer
   stands on the source. Until then a generated exam for a RAG agent is
   questions about nothing.
4. **The recorded dataset.** `ahde export` writes every development
   conversation as one JSONL line: messages with tool calls, the world
   before and after, grader results, judge verdicts, the simulated user's
   turns. Sealed evidence never leaves.
5. **A judge that can say "I don't know".** Every judge protocol gets an
   abstain answer, counted as a failure and shown as a count; the host
   offers ten calibration labels once, after the first run; the agreement
   line stands on the run panel and the ship dialog, or the words "judge not
   calibrated" do. The judge is chosen inside the one question that starts
   testing.

## Stage 2 — the flow

6. **Cases at one glance, and where each came from.** A typed `origin` on
   every case, set by the host; one table before the run; edits in words;
   admission in one line — `accepted 14 of 20: 3 duplicates, 2 restate the
   answer · not covered: refunds`; problems in human words; repetitions
   shown as `3/3`, never as the word "stable". Then the stranger's session:
   an operator who has never seen AHDE, on the Python agent, timed from
   `ahde` to passport.

## Stage 3 — the loop

7. **The autoloop as a product.** `improve` leaves the freezer. Three
   splits: the development basket the Builder reads, a validation split the
   loop optimises against, and the sealed exam that runs once, at the end,
   on the best attempt. The screen is one table — attempt, what changed,
   validation before and after, kept or reverted, why — a stop line, and one
   question: the best attempt, its numbers, ship it?

## Stage 4 — the constructor

8. **The agent as a panel.** Model, judge, skills, tools, tests, last run,
   version — one projection the host composes from what it already parsed,
   never from git tags or the first line after a heading; a skill or a tool
   added in one phrase.

## Later

9. **Case admission and the exam's own passport.** A generated case is
   admitted only if a reference model can solve it under the Spec with the
   tools, a naive baseline does not pass it trivially, two independent
   graders agree on the reference, and it is novel by embedding distance
   rather than by normalized string; the passport says which of the Spec's
   jobs the exam covers and which it does not.
10. **Model comparison mode.** The same harness, the same basket, two Target
    models, one Pareto table of score, cost and latency.
11. **Cases from live traffic.** A local OpenAI-compatible endpoint that
    serves the built agent, records every interaction with a receipt, and
    accepts a score against that receipt, so production traffic becomes a
    draft basket without anyone retyping a conversation. Never evidence.
12. **Transfer and continued reporting.** A report across versions and
    across Targets: what a harness change did on one model and whether it
    held on another.

Not planned: an external scorer. The word in the sync notes that looked like
one was a transcription error; a grader that runs a customer's own scoring
command is a day's work on the export line of item 4 if it is ever asked for.

## Thawed

- `improvement-loop.ts` (`ahde improve` / `search`) was frozen on 2026-09-01
  pending a user. The work sync of 2026-09-02 asked for exactly this loop.
  It is item 7; until then bug fixes only.

## Retired

- The external CLI workflow (`spec approve` / `propose` / `apply` / `adopt`)
  and the skill file for external coding agents were built, A/B-tested and
  retired: an Opus-class builder closes the loop with or without them and a
  Haiku-class builder fails with or without them. They are not coming back.

## Non-goals

- Training, fine-tuning or any change to weights. AHDE is harness
  engineering.
- Autonomous apply, promotion or deployment. The three questions stay
  human-owned; the autoloop of item 6 asks once, at the end, and `ahde
  serve` is a transport for the same gate, never an exemption from it.
- A user interface inside AHDE beyond Builder Pi. A platform renders the
  confirmations in its own UI over `serve`.
- Windows.

## Standing on Pi

AHDE vendors a pinned Pi (`vendor/tarballs`, 0.84.x) and drives it through
its extension API only: no patched runtime, no private hooks. Builder Pi
runs with `--no-builtin-tools --no-extensions --no-skills --no-context-files`
and one system prompt; Target Pi runs in a dedicated child over a
hash-checked workspace snapshot with credentials arriving over IPC after
startup. A Pi upgrade is a tarball swap plus `npm run verify:package`.
Item 2 opens the Target seam to a command backend; Builder Pi stays Pi, and
a Pi Target stays the reference implementation of that seam.
