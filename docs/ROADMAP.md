# AHDE roadmap

Updated 2026-09-05. Implemented behavior lives in the README and the invariant
contract; this page keeps the next product work separate from acceptance evidence.

## What works now

- Python command agents and Pi agents share the run, trace, evaluation and release
  workflow. Existing Python folders can be adopted with a reviewed setup.
- Cases can carry a simulated user and mutable world state. Declared knowledge
  bases support retrieval, source-based graders and a trace-level RAG X-ray.
- Builder Pi can author several bounded hypotheses. A persisted split separates
  authoring cases from blind validation; the selected change then faces a separate
  sealed exam before release.
- Production conversations can be imported as regressions, published into an
  immutable corpus and tested after restart. `/good` and `/bad` capture feedback
  from the built agent.
- Releases produce an exact version passport, an offline HTML report and an
  exportable development dataset. They retain uncertainty, regressions and unknown
  costs rather than hiding them.
- The terminal conversation is the primary interface. The optional localhost
  Evidence explorer shows verified conversations, executed actions, before/after
  answers and uncertainty. `serve` is the existing HTTP integration boundary.
- Natural requests and shortcuts share progress, cancellation and completion.
  Each model turn receives fresh guidance; reopening `ahde` resumes the project's
  validated conversation without restoring old approvals or restarting spend.
- Named starters (`python-support`, `pi-support`, `pi-basic`) resolve from any
  directory. Clean package acceptance checks the installed command, and CI now
  defines macOS and Linux lanes with required Linux sandbox/container checks.

Two paid synthetic improvement cycles completed through the production Workbench.
The [acceptance record](reviews/2026-09-05-live-improvement-acceptance.md) preserves
both the successful releases and the failed authoring attempt. Its validation
samples are small; a sealed non-regression pass is not a claim of production
correctness. The newly added Linux CI lane still needs its own green runner result.

## Next: make the first useful result easy

1. **Measure the stranger's first session.** Give an operator who has never seen
   AHDE an unfamiliar Python agent. Measure time to the first useful failure,
   reviewed candidate and shareable report, plus interventions and actual spend.
   Use that session to refine guidance, recovery and the conversation.
2. **Make connection and recovery clear.** Explain which model is the Builder,
   Target, judge or simulated user; show a usable next step for provider errors,
   interruptions and expired confirmations. Exercise restart during each stage
   with actual providers and runtimes.
3. **Finish the integration guide.** Publish one small working `serve` client:
   view, submit, decision, confirmation, event subscription and reconnection.
   Define retry behavior and how a client discovers the result of an operation
   when its original HTTP response was lost.

## Then: prove it on real work

4. **A bounded operating matrix.** Keep macOS, Linux/bwrap and actual Docker
   acceptance green. Test timeout, cancellation, unavailable providers and recovery,
   then document the supported combinations with evidence from those runs.
5. **An exam worth trusting.** Show coverage of the approved Spec and gaps in the
   cases; make human judge calibration easy. Add checks for trivial, duplicated
   or unsolvable generated cases before claiming broader reliability.
6. **Traffic into regression cases.** Extend the existing import path with a local
   endpoint or adapter that records a conversation receipt and lets the operator
   attach feedback to that exact interaction. Collection remains separate from
   evaluation evidence and requires deliberate publication into the test basket.
7. **Choose model and harness together.** Compare the same harness on two Target
   models using the same cases, and explain the quality, cost and latency tradeoff.
   Track whether a useful change transfers to another model or Target.

## Standing on Pi

AHDE consumes the checked-in Pi 0.84.3 tarballs. The pinned upstream checkout is
registered in `.gitmodules`; a small, explicit host-policy patch supplies the
Builder command and startup boundaries AHDE needs. The source retrieval, patch and
build steps are in [the vendor guide](../vendor/patches/README.md).

A Pi upgrade must update the source pin and any patch, rebuild the tarballs, then
pass the full checks and installed-package acceptance. Normal installation uses
those tarballs and does not rebuild Pi. The command backend keeps the Target
interface independent of the Builder's runtime.

## Non-goals

Training or changing weights; autonomous promotion or deployment; a hosted
multi-user control plane; Windows; a browser Builder/Studio. External `serve`
clients use the same evidence and host-owned release authority as the terminal
Builder. The local Evidence explorer remains read-only.
