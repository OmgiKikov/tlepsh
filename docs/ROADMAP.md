# AHDE roadmap

What is ahead, and why in this order. What is already true is in the README;
what may never change is in `INVARIANTS_V1.md`. This file is not a changelog:
when an item lands it leaves this page.

## Where we stand (2026-09-02)

Builder Pi is the front door and the only human interface. Four live
first-user sessions on a real model (Sonnet-class Builder, a 9B Target, a
GLM judge) closed the loop from a one-sentence description to a shipped
`v0.1.0` — spec, six operator-written cases, a workshop-built tool package,
a judge-written sealed exam, matched verification with a confidence interval,
a blind judge check, a re-score at candidate review, and a passport — in
about forty minutes and under four dollars. Eleven defects those sessions
found are fixed and confirmed live; the persona is one file; the CLI is the
machine surface and nothing more.

## Next, in order

1. **A stranger's session.** Every session so far was driven by the people
   who built the engine, on the same ombudsman. The next one is an operator
   who has never seen AHDE, on their own agent, timed from install to
   passport. Fix every place the host still exposes its own vocabulary or
   sends the operator anywhere but the conversation.
2. **Persona from 520 lines to about 300.** The merge kept every sentence a
   test pins and every rule a live session needed. The next pass cuts what
   the last four transcripts never exercised, one section at a time, each
   cut measured against a live session — never against tests alone.
3. **Numbers the Builder cannot paraphrase.** Twice the Builder restated a
   panel delta as a different number. The decision result should carry the
   one sentence the host wants quoted, so the model has nothing to compute.
4. **The exam that came back short.** A judge asked for 20 cases may return
   19; the operator now hears which were dropped and why. The same honesty
   belongs on the ship gate: an exam under the policy minimum must say how
   many more cases would make it decisive.
5. **Model comparison mode.** The same harness, the same basket, two Target
   models, one Pareto table of score, cost and latency — the question every
   buyer of a smaller model asks, answered with the gate already in place.
6. **Three splits.** Development, validation, sealed: the validation split
   is what the autoloop may optimise against, so the development basket
   stops being both the training signal and the report card.
7. **Cases from live traffic.** Today feedback reaches AHDE only through
   `ahde target` (`/good`, `/bad`) or a file in `imports/`. A local
   OpenAI-compatible endpoint that serves the built agent, records every
   interaction with a receipt, and accepts a score against that receipt
   would turn production traffic into cases without anyone retyping a
   conversation — the one thing Reef (Human-Agent-Society/reef, a
   serving-side continual-learning proxy) does that AHDE does not. The
   gate stays exactly where it is: recorded traffic becomes a draft basket,
   never evidence.
8. **Transfer and continued reporting.** A passport per version already
   exists; the next report is across versions and across Targets — what a
   harness change did on one model and whether it held on another.

## Frozen

- `improvement-loop.ts` (the autoloop, `ahde improve` / `search`) is frozen:
  no new behaviour, bug fixes only. If nobody runs it by 2026-10-01 it is
  removed together with its two CLI verbs.
- The external CLI workflow (`spec approve` / `propose` / `apply` / `adopt`)
  and the skill file for external coding agents were built, A/B-tested and
  retired: an Opus-class builder closes the loop with or without them and a
  Haiku-class builder fails with or without them. They are not coming back.

## Non-goals

- Training, fine-tuning or any change to weights. AHDE is harness
  engineering.
- Autonomous apply, promotion or deployment. The three questions stay
  human-owned; `ahde serve` is a transport for the same gate, never an
  exemption from it.
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
